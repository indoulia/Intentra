import {
  runId as makeRunId,
  sequentialId,
  validators,
  type AdapterCallContext,
  type AdapterRegistry,
  type AgentCatalog,
  type AgentRole,
  type AgentSpecView,
  type AgentSubstrate,
  type Assertion,
  type BlockerKind,
  type CallRecord,
  type CapabilityRecord,
  type CheckOutcome,
  type Classification,
  type Clock,
  type ContextPackage,
  type ContextSectionName,
  type DiscoveryPort,
  type DodProfileId,
  type Event,
  type FrozenGraph,
  type HandoffEnvelope,
  type HostIdentity,
  type HumanChannel,
  type InputPackage,
  type IntakeRecord,
  type IntakeSource,
  type Locator,
  type MutationEvent,
  type ProposedWorkItem,
  type CapabilityRegistry,
  type ResolutionAlternative,
  type RealityElement,
  type Registries,
  type RunOutcome,
  type Scope,
  type SkillOffer,
  type Stage,
  type StageCursorEntry,
  type StageDescriptor,
  type TemplateStage,
  type ToolGrant,
  type Violation,
  type WorkItem,
  type WorkflowProposal,
} from '@agentos/contracts';
import type { PolicySet } from '@agentos/policies';
import type { RunStore } from '@agentos/state';
import { Journal } from './journal.js';
import { admitWorkItem, type IdentityResolution } from './admission.js';
import { computeUnderstood, type UnderstoodVerdict } from './understood.js';
import { admissibleTemplatesFor, admitWorkflow, deriveRiskClass } from './workflow-admission.js';
import { computeEntryStage, stagesRemaining, stageFromCursor } from './entry-stage.js';
import { PredicateEvaluator, type PredicateEvaluation, type PredicateInputs } from './predicates.js';
import { decideAction, type KernelAction, type TransitionContext } from './state-machine.js';
import { receiveEnvelope, withVerification } from './receipt.js';
import { verifyEvidence, type VerificationReport } from './evidence-verification.js';
import { computeDod, effectiveProfile } from './dod.js';
import { compareSourceDrift, recordIntake } from './intake.js';
import { project, recover, runRecord, type Projection } from './recovery.js';
import {
  ZERO_BUDGET,
  addCost,
  checkDispatchBudget,
  discoveryLoopAllowed,
  dispatchBudget,
  incrementLoop,
  reresolutionAllowed,
} from './budgets.js';
import { climbLadder, type LadderResult } from './ladder.js';
import { classifyGates, previouslyDenied, recordRequest } from './authorization.js';
import {
  childWorkItem,
  coordinateChildren,
  externalChildren,
  decomposeEnvelope,
  triageEnvelope,
  withChildLink,
} from './orchestration.js';
import { readReconciliation } from './work-item-reconciliation.js';
import { classifyDispatch, selectModel, selectSkills } from './selection.js';
import { rankModels, rankSkills } from '@agentos/registries';
import { narrate, liveView, workItemView } from './narrative.js';

/**
 * The kernel.
 *
 * Deterministic code. No model, no prompt, no judgment. The Orchestrator Agent proposes; the
 * kernel disposes, and logs any override. The property this buys is the one that makes the
 * system trustworthy: **a run's safety and durability do not depend on a model behaving
 * well.** A confused, adversarial or hallucinating agent can degrade a run's quality; it
 * cannot corrupt state, skip a gate, or escape the state machine.
 *
 * Every model-facing edge arrives through a port. The kernel never learns what an agent is
 * internally, which model it used, or how it reasoned — and every kernel function here runs
 * with no model in the loop, which is why a run with zero available models makes no progress
 * and suffers no corruption.
 */

export interface KernelPorts {
  readonly store: RunStore;
  readonly policies: PolicySet;
  readonly clock: Clock;
  readonly adapters: AdapterRegistry;
  readonly discovery: DiscoveryPort;
  readonly registries: Registries;
  readonly agents: AgentCatalog;
  readonly substrate: AgentSubstrate;
  readonly host: HostIdentity;
  readonly human: HumanChannel;
  /** Deterministic sampling, seeded per run so a verification pass is reproducible. */
  readonly random: () => number;
  readonly repositoryPath: string;
  /** Access classes this run actually has, established from adapter availability. */
  readonly access: ReadonlySet<'repository' | 'git' | 'project_management' | 'runtime' | 'production'>;
}

export interface StartInput {
  readonly source: IntakeSource;
  readonly sourceLocator: Locator;
  readonly raw: string;
  /** How the external identity resolves, through the adapter. Supplied by the caller. */
  readonly resolveIdentity: (claimed: string | null) => Promise<IdentityResolution>;
  /** Re-reads the intake source for the drift check at COMPLETION. */
  readonly rereadIntake: (
    locator: Locator,
  ) => Promise<{ readonly outcome: 'OK'; readonly raw: string } | { readonly outcome: 'UNAVAILABLE'; readonly detail: string }>;
}

export interface RunResult {
  readonly outcome: RunOutcome | 'REFUSED';
  readonly workItemId: string | null;
  readonly runId: string | null;
  readonly detail: string;
  readonly narrative: string;
  readonly checks: readonly CheckOutcome[];
  /**
   * Why a `BLOCKED` run stopped, where the kernel knows (decision I-31).
   *
   * `REFUSED` and `BLOCKED` are different answers to a caller: the first says the request was
   * inadmissible, the second says the request was fine and the world was not. Collapsing the
   * second into the first tells a script its ticket key was wrong when the ticket system is
   * merely down, so the blocker kind travels with the outcome rather than being flattened
   * into prose. `null` on every non-blocked outcome, and on a block whose kind the kernel
   * has no name for.
   */
  readonly blockerKind: BlockerKind | null;
}

/**
 * The prologue logger.
 *
 * A named alias rather than an inline signature, because the same generic shape is both
 * produced in `work()` and consumed by the prologue dispatches, and two structurally
 * identical inline generics are not assignable to one another.
 */
/** Drops the `| undefined` an index signature carries, so a counter reads as 0 rather than absent. */
function normalizeCounters(
  counters: { readonly [key: string]: number | undefined },
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(counters)) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** Every `current_reality` element, for matching a recovery description onto a re-probe. */
const REALITY_ELEMENT_NAMES: readonly RealityElement[] = [
  'implementation_present', 'tests_present', 'pr', 'ci', 'reviews', 'merge_state',
  'deployment', 'outcome_evidence', 'children', 'agentos_history',
];

/** Which reality element a predicate reads, for the targeted probe that would settle it. */
const PREDICATE_ELEMENT: Readonly<Record<string, RealityElement>> = {
  'reality.implementation_present': 'implementation_present',
  'reality.tests_present': 'tests_present',
  'reality.pr_open': 'pr',
  'reality.pr_merged': 'pr',
  'reality.pr_approved': 'reviews',
  'reality.pr_reviewed': 'reviews',
  'reality.pr_has_unresolved_comments': 'reviews',
  'reality.ci_green': 'ci',
  'reality.stage_completed_previously': 'agentos_history',
  'reality.children_exist': 'children',
  'reality.children_all_terminal': 'children',
  'reality.outcome_already_satisfied': 'outcome_evidence',
  'reality.deployed': 'deployment',
};

function realityElementForPredicate(predicate: string): RealityElement | null {
  return PREDICATE_ELEMENT[predicate.replace(/^NOT /, '')] ?? null;
}

/**
 * The reality element an `UNKNOWN`'s subject names, or `null`.
 *
 * `null` is not a failure. A gap naming something outside the reality set is still recorded as
 * attempted; what the kernel does not do is claim to have settled something it could not
 * even address.
 */
function realityElementFor(subject: string): RealityElement | null {
  const text = subject.toLowerCase();
  return REALITY_ELEMENT_NAMES.find((element) => text.includes(element)) ?? null;
}

/** What AgentOS decided the work was, and why, in one line for the log and the narrative. */
function intentNote(
  intent: Assertion,
  workItem: WorkItem,
  confidence: number,
  alternatives: readonly ResolutionAlternative[],
): string {
  const value = intent.confidence === 'UNKNOWN' ? 'UNKNOWN' : String(intent.value);
  const reasoning = intent.confidence === 'INFERENCE' ? ` ${intent.reasoning}` : '';
  const rejected = alternatives.length === 0
    ? ''
    : ` Alternatives considered: ${alternatives.map(
      (a) => `${a.type} (${a.reading}) rejected because ${a.why_rejected}`,
    ).join('; ')}.`;
  return `AgentOS decided this work is ${value} (${intent.confidence}, from ${intent.probe}), `
    + `admitted as type ${workItem.type}`
    + (workItem.claimed_type === null ? '' : ` after downgrading a claimed ${workItem.claimed_type}`)
    + `, with the outcome "${workItem.desired_outcome}". The resolver's own confidence was `
    + `${confidence}, which is recorded and is never the reason anything is believed.`
    + `${reasoning}${rejected} The WorkItem contract carries no intent field, so this event is `
    + 'the durable record the run narrative states it from.';
}

type PrologueLogger = <K extends Event['event']>(
  kind: K,
  data: Extract<Event, { event: K }>['data'],
  stage: Stage,
) => void;

/**
 * What a graph run produced, plus the one thing that cannot be settled inside it.
 *
 * A run that ended `RERESOLVED` has to hand the re-resolution *outward*, because step 3 starts
 * a new run against the same Work Item and the lease that makes "one active run per Work Item"
 * true is still held by this one. The caller releases it and then performs steps 2 and 3.
 */
interface GraphOutcome {
  readonly result: RunResult;
  readonly workItem: WorkItem;
  readonly reresolve?: { readonly reason: string; readonly evidence: readonly string[] };
}

/**
 * What `COMPLETION` produced: the run's end, or a route back into the graph.
 *
 * `INCOMPLETE` routes back to the stage that owes the missing verdicts. That is a transition
 * the run takes, not a line in the log about a transition it would have taken.
 */
type CompletionOutcome =
  | ({ readonly kind: 'END' } & GraphOutcome)
  | { readonly kind: 'ROUTE_BACK'; readonly to: TemplateStage };

interface DispatchOutcome {
  readonly envelope: HandoffEnvelope | null;
  readonly action: KernelAction | null;
  readonly failed: boolean;
  readonly detail: string;
}

/**
 * What the prologue's `context` dispatch produced.
 *
 * Two cases and no third, because the third — an envelope the kernel did not accept, carried
 * forward anyway — is the one that would let a failed dispatch advance the run. `ACCEPTED`
 * carries an envelope that passed all eight receipt steps; `BLOCKED` ends the run where it
 * stands, with the reason and, where the kernel has a name for it, the blocker kind.
 */
type ContextDispatchOutcome =
  | { readonly outcome: 'ACCEPTED'; readonly envelope: HandoffEnvelope }
  | {
    readonly outcome: 'BLOCKED';
    readonly blockerKind: BlockerKind | null;
    readonly detail: string;
  };

export class Kernel {
  constructor(private readonly ports: KernelPorts) {}

  /* ================================================================= the run ==== */

  /**
   * The prologue, then the selected graph.
   *
   * `INTAKE_RECEIVED -> RESOLUTION -> CONTEXT_DISCOVERY -> UNDERSTOOD -> WORKFLOW_SELECTED`
   * runs first, in every run, and no template can alter it. This is the structural answer to
   * "an Orchestrator that skips analysis": the analysis happens before any Orchestrator
   * proposal exists.
   */
  async work(input: StartInput): Promise<RunResult> {
    const { store, policies, clock } = this.ports;
    const checks: CheckOutcome[] = [];

    /* ------------------------------------------------ INTAKE_RECEIVED ---- */

    const intakeId = sequentialId('in', this.nextIntakeNumber(), 4);
    const { record, attempts, principalAsserted, trustReason } = recordIntake(
      {
        intakeId,
        source: input.source,
        sourceLocator: input.sourceLocator,
        raw: input.raw,
        host: this.ports.host,
        receivedAt: clock.now().toISOString(),
      },
      policies.intake,
    );
    store.putIntake(record);

    /*
     * The prologue log. Written before a Work Item exists so that a crash during resolution
     * does not lose it, and replayed into the run log once the run exists.
     */
    const prologue: Event[] = [];
    let prologueSeq = 0;
    const logPrologue: PrologueLogger = (kind, data, stage) => {
      prologueSeq += 1;
      const event = {
        seq: prologueSeq,
        at: clock.now().toISOString(),
        work_item_id: intakeId,
        run_id: null,
        stage,
        dispatch_id: null,
        agent: null,
        event: kind,
        data,
      } as Event;
      prologue.push(event);
      store.appendIntakeEvent(intakeId, event);
    };

    logPrologue('intake_recorded', record, 'INTAKE_RECEIVED');

    if (!principalAsserted) {
      /*
       * A host that cannot assert a principal produces **absence**, and the intake classifies
       * EXTERNAL. `IntakeRecord.principal` is a required object whose `id` is a non-empty
       * string, so the absence cannot be expressed on the record and is recorded here instead
       * of being flattened into an identity nobody authenticated. A contract gap, reported
       * rather than papered over.
       */
      logPrologue(
        'note',
        {
          topic: 'principal absent',
          detail:
            `${this.ports.host.host} asserted no principal, so the intake carries the absence `
            + `marker rather than an identity, and classifies ${record.trust_class}. `
            + trustReason,
        },
        'INTAKE_RECEIVED',
      );
    }

    for (const attempt of attempts) {
      logPrologue(
        'intake_instruction_attempt',
        {
          intake_id: intakeId,
          trust_class: record.trust_class,
          attempted: [attempt.attempt],
          excerpt: attempt.excerpt,
          effect: 'NONE',
        },
        'INTAKE_RECEIVED',
      );
    }

    /* --------------------------------------------------- RESOLUTION ---- */

    const orientation = await this.ports.discovery.orient({
      runId: intakeId,
      intake: record,
      repositoryPath: this.ports.repositoryPath,
    });
    logPrologue(
      'discovery',
      {
        kind: 'TIER_RUN',
        tier: 1,
        probes: orientation.meta.probe_coverage.map((p) => p.probe),
        reason:
          'tier-1 orientation runs before resolution. Tiered discovery cannot know what is '
          + 'goal-relevant until a Work Item with a scope exists, which is why RESOLUTION '
          + 'precedes CONTEXT_DISCOVERY',
        requested_sections: [],
      },
      'RESOLUTION',
    );

    const resolution = await this.dispatchResolution(record, orientation, logPrologue);
    if (resolution.proposal === null) {
      return this.refuse(
        intakeId,
        prologue,
        `resolution produced no admissible proposal: ${resolution.detail}`,
        checks,
      );
    }

    const identity = await input.resolveIdentity(
      resolution.proposal.external_identity.confidence === 'UNKNOWN'
        ? null
        : String(resolution.proposal.external_identity.value),
    );

    /*
     * "Every FACT carries evidence; the evidence replays." The resolution envelope's evidence
     * is replayed through the originating adapters before anything the proposal asserts is
     * believed — the same disbelief step every other envelope gets, applied to the envelope
     * that decides what the work *is*.
     */
    const verification = await this.verifyResolution(
      resolution.envelope, resolution.proposal, record, prologue,
    );
    if (verification !== null && resolution.envelope !== null) {
      logPrologue('evidence_verification', {
        envelope_id: resolution.envelope.envelope_id,
        results: verification.outcomes.map((o) => ({
          evidence_id: o.evidence_id,
          status: o.status,
          selected_because: o.selected_because,
          detail: o.detail,
        })),
        mismatch_count: verification.mismatchCount,
      }, 'RESOLUTION');
    }

    const registry = this.capabilityRegistry();
    logPrologue('note', {
      topic: 'capability registry',
      detail: registry.detail,
    }, 'RESOLUTION');

    const admissionInput = {
      intake: record,
      proposal: resolution.proposal,
      policies,
      context: orientation,
      capabilities: registry.records,
      capabilityRegistryAvailable: registry.available,
      evidence: resolution.envelope?.evidence ?? [],
      verification,
      identity,
      existing: this.loadWorkItems(),
      access: this.ports.access,
      now: clock.now().toISOString(),
    };

    const admission = admitWorkItem(admissionInput);
    checks.push(...admission.checks);

    if (admission.outcome === 'BLOCKED') {
      logPrologue(
        'work_item_rejected',
        { checks: admission.checks, attempt: 1, next: 'BLOCKED' },
        'RESOLUTION',
      );
      /*
       * A block, not a refusal. Admission computed the blocker kind and the kind is the
       * difference between "resume when the source returns" and "your key is wrong": routing
       * both through `refuse` kept the reason text, dropped the kind, and told a caller its
       * request was inadmissible when the request was fine.
       */
      return this.block(prologue, admission.blockerKind, admission.reason, checks);
    }
    if (admission.outcome === 'REJECTED') {
      logPrologue(
        'work_item_rejected',
        { checks: admission.checks, attempt: 1, next: 'REDISPATCH' },
        'RESOLUTION',
      );
      /*
       * A rejected proposal is re-dispatched once with the failure named, and is never
       * repaired by the kernel: repairing a resolution would require judgment.
       */
      const second = await this.dispatchResolution(
        record,
        orientation,
        logPrologue,
        admission.violations,
      );
      if (second.proposal === null) {
        return this.refuse(
          intakeId,
          prologue,
          `resolution was refused twice: ${admission.violations.map((v) => v.message).join('; ')}`,
          checks,
        );
      }
      const secondVerification = await this.verifyResolution(
        second.envelope, second.proposal, record, prologue,
      );
      const retry = admitWorkItem({
        ...admissionInput,
        proposal: second.proposal,
        evidence: second.envelope?.evidence ?? [],
        verification: secondVerification,
        existing: this.loadWorkItems(),
        now: clock.now().toISOString(),
      });
      checks.push(...retry.checks);
      if (retry.outcome !== 'ADMITTED') {
        return this.refuse(
          intakeId,
          prologue,
          'resolution was refused twice; the uncertainty ladder applies and, with no channel '
          + 'to ask on, the run blocks with AMBIGUOUS_GOAL. Silence is never consent',
          checks,
        );
      }
      return this.continueWithWorkItem({
        workItem: retry.workItem,
        intake: record,
        orientation,
        prologue,
        input,
        checks,
        typeDowngraded: retry.typeDowngraded,
        intent: retry.intent,
        resolutionConfidence: retry.resolutionConfidence,
        alternatives: second.proposal.alternatives,
      });
    }

    return this.continueWithWorkItem({
      workItem: admission.workItem,
      intake: record,
      orientation,
      prologue,
      input,
      checks,
      typeDowngraded: admission.typeDowngraded,
      intent: admission.intent,
      resolutionConfidence: admission.resolutionConfidence,
      alternatives: resolution.proposal.alternatives,
    });
  }

  /* ------------------------------------------------- the resolution envelope ==== */

  /**
   * Replays the resolution envelope's evidence through the originating adapters.
   *
   * The same `verifyEvidence` every other envelope goes through, and deliberately the same:
   * duplicating the selection policy, the two-strikes rule and the comparators for this one
   * envelope would be two implementations of the check the whole design rests on.
   *
   * **The replay runs under the proposed scope** (decision I-30). No admitted scope exists
   * yet — the proposal is what admission is deciding about — so the only bound available is
   * the one the proposal is asking for, and `Scope` is defined as the thing that "becomes
   * `mandate.in_scope`". Admission check 5 bounds that scope before anything rests on it: an
   * unbounded scope is refused, so this cannot become a route to unlimited reach. The
   * conservative reading follows: a proposal gets evidence confirmed only for paths inside
   * the scope it claims, and evidence reaching outside is withdrawn as unconfirmed. The
   * empty mandate this used to pass meant "no path at all is in scope" to the path adapter,
   * so every replay was refused and every typed work item downgraded to UNKNOWN whatever the
   * repository contained.
   */
  private async verifyResolution(
    envelope: HandoffEnvelope | null,
    proposal: ProposedWorkItem,
    intake: IntakeRecord,
    prologue: readonly Event[],
  ): Promise<VerificationReport | null> {
    if (envelope === null) return null;
    const calls = prologue
      .filter((e): e is Extract<Event, { event: 'adapter_call' }> => e.event === 'adapter_call')
      .map((e) => e.data);
    return verifyEvidence({
      envelope,
      policy: this.ports.policies.evidence,
      adapters: this.ports.adapters,
      callContext: {
        workItemId: intake.intake_id,
        runId: intake.intake_id,
        dispatchId: 'd_res',
        mandate: { in_scope: proposal.scope.paths, out_of_scope: [] },
        grantsHeld: [],
        stageMutating: false,
      },
      clock: this.ports.clock,
      calls,
      sampler: this.ports.random,
    });
  }

  /**
   * The capability records this admission can judge a type against.
   *
   * The capability registry is written by the Auditor into a run's `capabilities/`, so a work
   * item being resolved for the first time has none — and `ContextPackage.capabilities` is a
   * *reference* into a registry rather than the records, so tier-1 orientation cannot supply
   * them either. Where none is found, `available` is false and the type check records
   * `INDETERMINATE`: an empty registry and an unreadable one are the same array and opposite
   * facts, and passing every `FEATURE` because nobody looked is exactly the silent pass the
   * check exists to prevent.
   */
  private capabilityRegistry(): {
    readonly records: readonly CapabilityRecord[];
    readonly available: boolean;
    readonly detail: string;
  } {
    const { store } = this.ports;
    let newest: { readonly records: readonly CapabilityRecord[]; readonly at: string } | null = null;

    for (const workItemId of store.listWorkItems()) {
      for (const runId of store.listRuns(workItemId)) {
        const version = store.latestVersion(workItemId, runId, 'capabilities');
        if (version === null) continue;
        const raw = store.getVersioned(workItemId, runId, 'capabilities', version);
        const parsed = validators.capabilityRegistry.check(raw);
        if (!parsed.valid) continue;
        const registry = raw as CapabilityRegistry;
        if (newest === null || registry.assembled_at > newest.at) {
          newest = { records: registry.records, at: registry.assembled_at };
        }
      }
    }

    if (newest === null) {
      return {
        records: [],
        available: false,
        detail:
          'no capability registry has been assembled for this repository, so the type check '
          + 'cannot answer whether a capability record intersects the scope. That is '
          + 'INDETERMINATE, not "no capabilities": an unreadable registry and an empty one are '
          + 'the same array and opposite facts',
      };
    }

    return {
      records: newest.records,
      available: true,
      detail:
        `${newest.records.length} capability record(s), from the registry assembled at `
        + newest.at,
    };
  }

  /* ---------------------------------------------------------- the work item ==== */

  private async continueWithWorkItem(args: {
    readonly workItem: WorkItem;
    readonly intake: IntakeRecord;
    readonly orientation: ContextPackage;
    readonly prologue: readonly Event[];
    readonly input: StartInput;
    readonly checks: CheckOutcome[];
    readonly typeDowngraded: boolean;
    /** What resolution decided the work *is*. No `WorkItem` field carries it. */
    readonly intent: Assertion;
    readonly resolutionConfidence: number;
    readonly alternatives: readonly ResolutionAlternative[];
  }): Promise<RunResult> {
    const {
      workItem, intake, orientation, prologue, input, checks, typeDowngraded,
    } = args;
    const { store, policies, clock } = this.ports;

    const existing = store.getWorkItem(workItem.work_item_id);
    const durable: WorkItem = existing === null
      ? workItem
      : {
        ...existing,
        /* The work item is durable and outlives every attempt, so an existing one keeps its
         * identity, history and lifecycle; only what this resolution learned is refreshed. */
        type: workItem.type,
        claimed_type: workItem.claimed_type,
        title: workItem.title,
        desired_outcome: workItem.desired_outcome,
        scope: workItem.scope,
        candidate_dod_profiles: workItem.candidate_dod_profiles,
        duplicate_candidates: workItem.duplicate_candidates,
      };

    const runId = makeRunId(clock.now(), this.ports.random);
    const holder = `pid:${process.pid}`;

    /* ------------------------------------------------------- the lease ---- */

    const lease = store.acquireLease(
      durable.work_item_id,
      runId,
      holder,
      clock.now(),
      policies.budgets.lease_timeout_ms,
    );

    if (lease.outcome === 'REFUSED') {
      const journal = Journal.open(store, clock, {
        workItemId: durable.work_item_id, runId: null,
      });
      store.putWorkItemProjection(durable);
      journal.workItem('lease', {
        action: 'REFUSED',
        run_id: runId,
        active_run_id: lease.activeRunId,
        abandoned_run_id: null,
        holder,
      });
      return {
        outcome: 'REFUSED',
        workItemId: durable.work_item_id,
        runId: null,
        detail:
          `run ${lease.activeRunId} is already active against this work item, held by `
          + `${lease.holder} since ${lease.heldSince}. One active run per Work Item, which is `
          + 'what makes "someone ran it twice" a refusal instead of two PRs',
        narrative: '',
        checks,
        blockerKind: null,
      };
    }

    store.createRun(durable.work_item_id, runId);
    const journal = Journal.open(store, clock, { workItemId: durable.work_item_id, runId });

    /* Replay the prologue into the run log, so the run's story starts at INTAKE_RECEIVED. */
    for (const event of prologue) {
      journal.run(
        event.event as never,
        event.data as never,
        { stage: event.stage, dispatchId: event.dispatch_id, agent: event.agent },
      );
    }

    journal.both('run_started', {
      run_id: runId,
      holder,
      reason: existing === null ? 'NEW' : 'RESUME',
    }, { stage: 'INTAKE_RECEIVED' });

    if (lease.outcome === 'RECLAIMED') {
      journal.both('lease', {
        action: 'RECLAIMED',
        run_id: runId,
        active_run_id: null,
        abandoned_run_id: lease.abandonedRunId,
        holder,
      }, { stage: 'INTAKE_RECEIVED' });
    }

    journal.workItem('work_item_admitted', {
      work_item: durable,
      checks,
      type_downgraded: typeDowngraded,
    }, { stage: 'RESOLUTION' });
    journal.run('work_item_admitted', {
      work_item: durable,
      checks,
      type_downgraded: typeDowngraded,
    }, { stage: 'RESOLUTION' });

    /*
     * What AgentOS decided the work *is*, written to the **work-item** log.
     *
     * The narrative's v0.3 obligation is to state what AgentOS decided the work was and why —
     * "a run that did the wrong thing correctly is the new failure mode this layer
     * introduces, and it is invisible unless resolution is narrated alongside execution". The
     * `WorkItem` contract carries no `intent` field, so the durable record of it is this
     * event; the work-item log is the right home because intent outlives the run, exactly as
     * the work item does.
     */
    journal.workItem('note', {
      topic: 'intent',
      detail: intentNote(args.intent, durable, args.resolutionConfidence, args.alternatives),
    }, { stage: 'RESOLUTION' });
    journal.run('note', {
      topic: 'intent',
      detail: intentNote(args.intent, durable, args.resolutionConfidence, args.alternatives),
    }, { stage: 'RESOLUTION' });

    if (durable.duplicate_candidates.length > 0) {
      journal.run('duplicate_candidates', {
        candidates: durable.duplicate_candidates,
        basis: 'identical scope and normalized title',
        action: 'SURFACED',
      }, { stage: 'RESOLUTION' });
    }

    let workItemState: WorkItem = {
      ...durable,
      lifecycle: 'RESOLVED',
      lease: { run_id: runId, acquired_at: clock.now().toISOString(), holder },
      runs: [...durable.runs.filter((r) => r !== runId), runId],
    };
    store.putWorkItemProjection(workItemState);

    let outcome: GraphOutcome;
    try {
      outcome = await this.runGraph({
        workItem: workItemState,
        intake,
        orientation,
        journal,
        runId,
        input,
        checks,
        resolutionConfidence: args.resolutionConfidence,
        alternatives: args.alternatives,
      });
      workItemState = outcome.workItem;
    } finally {
      store.releaseLease(workItemState.work_item_id, runId);
      journal.workItem('lease', {
        action: 'RELEASED',
        run_id: runId,
        active_run_id: null,
        abandoned_run_id: null,
        holder,
      });
    }

    if (outcome.reresolve === undefined) return outcome.result;

    /*
     * Steps 2 and 3, now that the lease is released. The run has ended honestly; a new one
     * starts against the same Work Item, and only the graph is new.
     */
    return this.performReresolution({
      workItem: workItemState,
      intake,
      orientation,
      input,
      checks,
      priorRunId: runId,
      reason: outcome.reresolve.reason,
      evidence: outcome.reresolve.evidence,
    });
  }

  /* ------------------------------------------------------------- the graph ==== */

  private async runGraph(args: {
    readonly workItem: WorkItem;
    readonly intake: IntakeRecord;
    readonly orientation: ContextPackage;
    readonly journal: Journal;
    readonly runId: string;
    readonly input: StartInput;
    readonly checks: CheckOutcome[];
    readonly resolutionConfidence: number;
    readonly alternatives: readonly ResolutionAlternative[];
  }): Promise<GraphOutcome> {
    const { workItem, intake, orientation, journal, runId, input, checks } = args;
    const { store, policies, clock } = this.ports;
    const evaluator = new PredicateEvaluator(policies, clock, this.ports.discovery);
    /**
     * Discovery loops spent by this run and this work item.
     *
     * One counter for the ladder's rung 2, the resume sweep's targeted probe and the
     * re-resolution either can lead to — because they are one loop, and counting them
     * separately would make three unbounded loops out of one bounded one.
     */
    const discoverySpent = {
      run: 0,
      workItem: workItem.consumed_budget.loops['discovery'] ?? 0,
    };

    /* --------------------------------------------- CONTEXT_DISCOVERY ---- */

    const deepened = await this.ports.discovery.deepen({
      runId,
      workItem,
      repositoryPath: this.ports.repositoryPath,
      previous: orientation,
    });
    const contextVersion = 1;
    const contextPath = store.putVersioned(
      workItem.work_item_id, runId, 'context', contextVersion, deepened,
    );
    journal.run('context_package_versioned', {
      version: contextVersion,
      tier: 2,
      path: contextPath,
      supersedes: null,
    }, { stage: 'CONTEXT_DISCOVERY' });
    journal.run('discovery', {
      kind: 'TIER_RUN',
      tier: 2,
      probes: deepened.meta.probe_coverage.map((p) => p.probe),
      reason: 'tier-2 depth is bought against the admitted scope, plus the current_reality set',
      requested_sections: [],
    }, { stage: 'CONTEXT_DISCOVERY' });

    /*
     * The `context` mandate, dispatched — the second half of `CONTEXT_DISCOVERY`.
     *
     * `discovery.deepen()` above is the *probe* half: it is what writes `current_reality`, and
     * it stays the only thing that does. This is the *judgment* half, and the reason it has to
     * exist is narrow and load-bearing: `DEFINITION_OF_DONE` criterion 1 is owned by
     * `context-discovery/context` and by nothing else, and a criterion verdict reaches
     * `computeDod` only inside an accepted envelope. With no dispatch there was no envelope, so
     * criterion 1 came out `NOT_VALIDATED` in every run of every template and no profile making
     * it critical could ever complete (decision I-33). The workaround was in policy; this is the
     * cause.
     *
     * It is not a privileged dispatch. Budgets are checked before it, the model is ranked and
     * selected and journalled, the tool surface is verified against the granted set, the
     * envelope goes through all eight receipt steps and its evidence is replayed. What it may
     * *not* do is write reality: nothing the envelope says is merged into `deepened`, so a
     * context agent claiming a reality element changes nothing about what the probes observed.
     */
    const contextDispatch = await this.dispatchContext({
      workItem,
      context: deepened,
      journal,
      runId,
      budget: { run: ZERO_BUDGET, workItem: workItem.consumed_budget },
      runStartedAt: clock.now().toISOString(),
    });

    if (contextDispatch.outcome === 'BLOCKED') {
      /*
       * A failed, malformed or blocked context envelope stops the run here. The alternative —
       * proceeding on the probe package alone and letting criterion 1 come out `NOT_VALIDATED`
       * — would advance the state machine on the strength of a dispatch nothing believed, and
       * the whole point of the disbelief machinery is that an envelope that did not pass it
       * moves nothing.
       */
      journal.run('transition', {
        from: 'CONTEXT_DISCOVERY',
        to: 'BLOCKED',
        trigger: contextDispatch.blockerKind ?? 'contract violation',
        edge_kind: 'escalate',
        proposed_by: 'context-discovery',
        proposed_stage: null,
        overridden: false,
        evidence: [],
      }, { stage: 'CONTEXT_DISCOVERY' });
      return this.end(
        journal, workItem, runId, 'BLOCKED', contextDispatch.detail, 'BLOCKED', checks,
        contextDispatch.blockerKind,
      );
    }

    /*
     * Said out loud, in the run's own log, because it is the property that makes the dispatch
     * safe to have added: the Context Package the rest of the run reads is version 1, exactly
     * as the probes wrote it. The envelope's `current_reality` output is the agent's account of
     * what it read, never a source for what is true.
     */
    journal.run('note', {
      topic: 'context package authority',
      detail:
        `the context mandate answered in envelope ${contextDispatch.envelope.envelope_id} and `
        + 'nothing it says was merged into current_reality. Only a probe writes reality: the '
        + 'agent\'s job here is the judgment sections and the criterion 1 verdict, and an agent '
        + 'that could also supply the observations it is judging would be judging its own work',
    }, { stage: 'CONTEXT_DISCOVERY' });

    const priorEnvelopes: readonly HandoffEnvelope[] = [contextDispatch.envelope];

    const registry = this.capabilityRegistry();
    const capabilities: readonly CapabilityRecord[] = registry.records;
    const predicateInputs: PredicateInputs = {
      context: deepened,
      workItem,
      capabilities,
      mutations: [],
      claim: null,
    };

    /* ------------------------------------ the work-item reconciliation ---- */

    /*
     * Where this piece of work actually stands, read from what discovery wrote.
     *
     * `current_reality` is written only by probes, so the matrix is computed there and read
     * here — and read carefully: an absent or unrecognised value is `INDETERMINATE` rather
     * than a negative, because a discovery run that could not reach the project-management
     * system has established nothing about whether anybody intends this work.
     *
     * Recorded before `UNDERSTOOD` because `CLAIMED_DONE_UNPROVEN` is a finding the run
     * proceeds to establish or refute rather than a reason to stop, and it is the finding most
     * easily lost by treating a ticket's status field as an observation about the system.
     */
    const reconciliation = readReconciliation(deepened.current_reality);
    journal.run('note', {
      topic: 'work item reconciliation',
      detail: `${reconciliation.state}: ${reconciliation.detail}`,
    }, { stage: 'CONTEXT_DISCOVERY' });
    checks.push({
      check: 'work_item_reconciliation',
      result: !reconciliation.available || reconciliation.state === 'INDETERMINATE'
        ? 'INDETERMINATE'
        : reconciliation.state === 'ALIGNED' ? 'PASS' : 'FAIL',
      detail: `${reconciliation.state}: ${reconciliation.detail}`,
    });

    /* --------------------------------------------------- UNDERSTOOD ---- */

    evaluator.freshen();
    let understood = await computeUnderstood({
      workItem,
      policies,
      context: deepened,
      evaluator,
      predicateInputs,
      access: this.ports.access,
      resolutionConfidence: args.resolutionConfidence,
      ladderApplied: false,
    });
    journal.run('understood_computed', {
      verdict: understood.verdict,
      conditions: understood.conditions,
      undetermined_predicates: understood.undeterminedPredicates,
    }, { stage: 'UNDERSTOOD' });
    checks.push(...understood.conditions);

    /* ------------------------------------------- the uncertainty ladder ---- */

    /*
     * **The sufficiency verdict gates progression.** An `INSUFFICIENT` verdict enters the
     * ladder; it does not get logged and stepped over. Which rung answers decides whether the
     * run proceeds, and rung 5 ends it `BLOCKED` with `AMBIGUOUS_GOAL` — silence is never
     * consent.
     */
    let safePrefix: readonly TemplateStage[] | null = null;
    let ladder: LadderResult | null = null;

    if (understood.verdict === 'INSUFFICIENT' || args.alternatives.length > 0) {
      ladder = await this.climb({
        workItem,
        understood,
        journal,
        evaluator,
        predicateInputs,
        alternatives: args.alternatives,
        resolutionConfidence: args.resolutionConfidence,
        discoverySpent,
        context: deepened,
      });

      if (ladder.rung === 'BLOCK') {
        journal.run('transition', {
          from: 'UNDERSTOOD',
          to: 'BLOCKED',
          trigger: ladder.blockerKind,
          edge_kind: 'escalate',
          proposed_by: null,
          proposed_stage: null,
          overridden: false,
          evidence: [],
        }, { stage: 'UNDERSTOOD' });
        return this.end(
          journal, workItem, runId, 'BLOCKED', ladder.detail, 'BLOCKED', checks,
          ladder.blockerKind,
        );
      }

      if (ladder.rung === 'SAFE_PREFIX') safePrefix = ladder.prefix;

      evaluator.freshen();
      understood = await computeUnderstood({
        workItem,
        policies,
        context: deepened,
        evaluator,
        predicateInputs,
        access: this.ports.access,
        resolutionConfidence: args.resolutionConfidence,
        ladderApplied: true,
        recordedHandlings: new Set(ladder.handled),
      });
      journal.run('understood_computed', {
        verdict: understood.verdict,
        conditions: understood.conditions,
        undetermined_predicates: understood.undeterminedPredicates,
      }, { stage: 'UNDERSTOOD' });
      checks.push(...understood.conditions);
    }

    let lifecycle = workItem.lifecycle;
    if (understood.verdict === 'SUFFICIENT' || ladder !== null) {
      journal.both('work_item_lifecycle', {
        from: lifecycle,
        to: 'UNDERSTOOD',
        reason: understood.verdict === 'SUFFICIENT'
          ? 'the workflow decision is determinate'
          : 'the workflow decision is not determinate on the evidence, and the uncertainty '
            + `ladder settled how to proceed at rung ${ladder?.rung ?? 'PROCEED'}: `
            + (ladder?.detail ?? ''),
        evidence: [],
        decided_by: 'kernel',
      }, { stage: 'UNDERSTOOD' });
      lifecycle = 'UNDERSTOOD';
    }

    /* ---------------------------------------------- WORKFLOW_SELECTED ---- */

    const profileChoice = effectiveProfile(
      'audit',
      understood.checkableProfiles.length > 0
        ? understood.checkableProfiles
        : workItem.candidate_dod_profiles,
    );

    evaluator.freshen();
    const outcomeSatisfied = await evaluator.evaluate(
      'reality.outcome_already_satisfied',
      predicateInputs,
    );
    journal.run('predicate_evaluated', {
      predicate: outcomeSatisfied.predicate,
      evaluated: outcomeSatisfied.value,
      claim: null,
      inputs: outcomeSatisfied.inputs,
      reprobed: outcomeSatisfied.reprobed,
      reason: outcomeSatisfied.reason,
    }, { stage: 'UNDERSTOOD' });

    const orchestratorProposal = await this.dispatchOrchestrator(
      workItem, deepened, journal, runId,
    );

    const admitted = await admitWorkflow({
      workItem,
      policies,
      proposal: orchestratorProposal,
      evaluator,
      predicateInputs,
      profile: profileChoice.profile,
      outcomeAlreadySatisfied: outcomeSatisfied.value === 'TRUE',
    });
    checks.push(...admitted.checks);

    journal.run('workflow_admitted', {
      graph: admitted.graph,
      admissible_templates: admitted.admissibleTemplates,
      checks: admitted.checks,
    }, { stage: 'WORKFLOW_SELECTED' });

    if (admitted.override !== null) {
      journal.run('workflow_override', {
        proposed_template: admitted.override.proposedTemplate,
        selected_template: admitted.override.selectedTemplate,
        reason: admitted.override.reason,
        failed_checks: admitted.override.failedChecks,
      }, { stage: 'WORKFLOW_SELECTED' });
    }
    for (const evaluation of admitted.evaluations) {
      journal.run('predicate_evaluated', {
        predicate: evaluation.predicate,
        evaluated: evaluation.value,
        claim: evaluation.claim,
        inputs: evaluation.inputs,
        reprobed: evaluation.reprobed,
        reason: evaluation.reason,
      }, { stage: 'WORKFLOW_SELECTED' });
    }

    /* -------------------------------------------------- the entry stage ---- */

    evaluator.freshen();
    const entry = await computeEntryStage({
      graph: admitted.graph,
      policies,
      evaluator,
      predicateInputs,
      /*
       * The DISCOVER arm of the resume rule, wired.
       *
       * A mutating stage whose `satisfied_by` is `INDETERMINATE` is the case where more
       * verification and less irreversible mutation point in opposite directions, and the
       * kernel does not choose: it probes. Without this the arm was dead and every
       * indeterminate mutating stage went straight to `AMBIGUOUS_STATE` — safe, and wrong,
       * because it blocked runs a single re-read would have resumed.
       */
      discover: async (stage, predicate) => this.targetedDiscovery({
        stage, predicate, journal, evaluator, predicateInputs, discoverySpent,
      }),
    });

    journal.run('entry_stage_computed', {
      entry_stage: entry.outcome === 'BLOCKED' ? null : entry.entryStage,
      walk: entry.walk.map((step) => ({
        stage: step.stage,
        satisfied_by: step.satisfied_by,
        evaluated: step.evaluated,
        mutating: step.mutating,
        decision: step.decision,
        evidence: step.evidence,
      })),
    }, { stage: 'WORKFLOW_SELECTED' });

    if (entry.outcome === 'BLOCKED') {
      journal.run('transition', {
        from: 'WORKFLOW_SELECTED',
        to: 'BLOCKED',
        trigger: 'AMBIGUOUS_STATE',
        edge_kind: 'escalate',
        proposed_by: null,
        proposed_stage: null,
        overridden: false,
        evidence: [],
      }, { stage: 'WORKFLOW_SELECTED' });
      return this.end(
        journal, workItem, runId, 'BLOCKED', entry.reason, lifecycle, checks,
      );
    }

    for (const step of entry.walk) {
      if (step.decision !== 'COMPLETED_PRIOR') continue;
      journal.run('stage_marked_completed_prior', {
        marked_stage: step.stage,
        predicate: step.satisfied_by ?? '',
        evidence: step.evidence,
        note: 'criteria remain NOT_VALIDATED',
      }, { stage: 'WORKFLOW_SELECTED' });
    }

    journal.run('transition', {
      from: 'WORKFLOW_SELECTED',
      to: entry.entryStage,
      trigger: 'entry stage computed from Current Reality',
      edge_kind: 'advance',
      proposed_by: null,
      proposed_stage: null,
      overridden: false,
      evidence: [],
    }, { stage: 'WORKFLOW_SELECTED' });

    /* ----------------------------------------------------- the run loop ---- */

    return this.loop({
      workItem: { ...workItem, lifecycle },
      intake,
      context: deepened,
      graph: admitted.graph,
      currentStage: entry.entryStage,
      completedPrior: entry.completedPrior,
      profile: profileChoice.profile,
      journal,
      runId,
      evaluator,
      predicateInputs,
      input,
      checks,
      priorEnvelopes,
      /* Only armed where the run actually starts inside the prefix: a resumed run entering
       * past it would re-resolve on its first transition, which is a lap nobody asked for. */
      safePrefix: safePrefix !== null && safePrefix.includes(entry.entryStage)
        ? safePrefix
        : null,
      resolutionConfidence: args.resolutionConfidence,
      alternatives: args.alternatives,
      discoverySpent,
    });
  }

  /* ------------------------------------------------- the uncertainty ladder ==== */

  /**
   * Climbs the ladder, with its two side-effecting rungs bound to real ports.
   *
   * Rung 2 dispatches through `DiscoveryPort.reprobeReality` and is counted against
   * `budgets.loops.discovery` — the counter nothing previously incremented, which made the
   * bound on "the kernel discovers rather than choosing" a bound on nothing. Rung 4 asks
   * through `HumanChannel.ask`, once, carrying both readings and what AgentOS would do under
   * each.
   */
  private async climb(args: {
    readonly workItem: WorkItem;
    readonly understood: UnderstoodVerdict;
    readonly journal: Journal;
    readonly evaluator: PredicateEvaluator;
    readonly predicateInputs: PredicateInputs;
    readonly alternatives: readonly ResolutionAlternative[];
    readonly resolutionConfidence: number;
    readonly discoverySpent: { run: number; workItem: number };
    readonly context: ContextPackage;
  }): Promise<LadderResult> {
    const { policies } = this.ports;
    const { journal, workItem } = args;

    /*
     * Rung 3 intersects the templates admissible for the admitted type **and for every
     * alternative reading's type**, because the ambiguity the ladder exists for is about which
     * reading is right. Intersecting the admitted type's set alone would answer a question
     * nobody asked.
     */
    const candidateTypes = new Set<WorkItem['type']>([
      workItem.type,
      ...args.alternatives.map((a) => a.type),
    ]);
    const byId = new Map<string, ReturnType<typeof admissibleTemplatesFor>[number]>();
    for (const type of candidateTypes) {
      for (const template of admissibleTemplatesFor(type, policies)) {
        byId.set(template.template_id, template);
      }
    }

    /* The gaps rung 2 can act on: those blocking something, that name a recovery. */
    const gaps = args.context.gaps.filter(
      (gap) => gap.blocks.length > 0 && gap.recoverable_by.trim().length > 0,
    );

    const result = await climbLadder({
      workItem,
      policies,
      understood: args.understood,
      gaps,
      resolutionConfidence: args.resolutionConfidence,
      alternatives: args.alternatives,
      admissibleTemplates: [...byId.values()],
      discoveryLoops: args.discoverySpent,
      ports: {
        discover: async (probe) => {
          const allowed = discoveryLoopAllowed(args.discoverySpent, policies.budgets);
          if (!allowed.allowed) {
            journal.run('budget', {
              kind: 'EXCEEDED',
              counter: 'loops.discovery',
              scope: allowed.scope ?? 'run',
              value: allowed.value,
              cap: allowed.cap,
              tried: [allowed.reason],
            }, { stage: 'UNDERSTOOD' });
            return { ran: false, settled: false, detail: allowed.reason };
          }
          args.discoverySpent.run += 1;
          args.discoverySpent.workItem += 1;
          journal.run('budget', {
            kind: 'CONSUMED',
            counter: 'loops.discovery',
            scope: 'run',
            value: args.discoverySpent.run,
            cap: policies.budgets.loops.discovery.per_run,
            tried: [],
          }, { stage: 'UNDERSTOOD' });
          journal.run('discovery', {
            kind: 'ON_DEMAND_REQUESTED',
            tier: 3,
            probes: [probe.subject],
            reason:
              `the UNKNOWN ${probe.gapId} blocks ${probe.blocks.join(', ')} and names what `
              + `would settle it: ${probe.recoverableBy}`,
            requested_sections: [],
          }, { stage: 'UNDERSTOOD' });

          const element = realityElementFor(probe.subject);
          if (element === null) {
            return {
              ran: true,
              settled: false,
              detail:
                `the recovery names no current_reality element the kernel can re-probe, so the `
                + 'attempt is recorded and nothing is claimed to have been settled',
            };
          }
          const fresh = await this.ports.discovery.reprobeReality(
            element, workItem, workItem.scope,
          );
          return {
            ran: true,
            settled: fresh.confidence !== 'UNKNOWN',
            detail: fresh.confidence === 'UNKNOWN'
              ? `${element} came back UNKNOWN again, which settles nothing and is not a `
                + 'negative answer either'
              : `${element} came back ${fresh.confidence} from ${fresh.probe}`,
          };
        },
        ask: async (question, readings) => {
          journal.run('question', {
            phase: 'ASKED',
            question,
            readings: readings.map((r) => ({
              reading: r.reading,
              evidence: [...r.evidence],
              would_do: r.would_do,
            })),
            answer: null,
            answered_by: null,
          }, { stage: 'UNDERSTOOD' });
          const answer = await this.ports.human.ask(
            question,
            readings.map((r) => ({ reading: r.reading, would_do: r.would_do })),
          );
          journal.run('question', {
            phase: answer === null ? 'TIMED_OUT' : 'ANSWERED',
            question,
            readings: readings.map((r) => ({
              reading: r.reading,
              evidence: [...r.evidence],
              would_do: r.would_do,
            })),
            answer,
            answered_by: answer === null ? null : 'human',
          }, { stage: 'UNDERSTOOD' });
          return answer;
        },
        record: (step) => {
          journal.run('note', {
            topic: `uncertainty ladder rung ${step.rung}`,
            detail: `${step.outcome}: ${step.detail}`,
          }, { stage: 'UNDERSTOOD' });
        },
      },
    });

    journal.run('note', {
      topic: 'uncertainty ladder',
      detail:
        `settled at rung ${result.rung} after ${result.probesDispatched} probe(s). `
        + result.detail,
    }, { stage: 'UNDERSTOOD' });

    return result;
  }

  /**
   * The targeted probe the resume sweep dispatches for an `INDETERMINATE` mutating stage.
   *
   * Counted against the same discovery loop budget as the ladder's rung 2, because they are
   * the same loop: an on-demand probe requested mid-run.
   */
  private async targetedDiscovery(args: {
    readonly stage: TemplateStage;
    readonly predicate: string;
    readonly journal: Journal;
    readonly evaluator: PredicateEvaluator;
    readonly predicateInputs: PredicateInputs;
    readonly discoverySpent: { run: number; workItem: number };
  }): Promise<PredicateEvaluation> {
    const { policies } = this.ports;
    const { journal } = args;

    const allowed = discoveryLoopAllowed(args.discoverySpent, policies.budgets);
    if (!allowed.allowed) {
      journal.run('budget', {
        kind: 'EXCEEDED',
        counter: 'loops.discovery',
        scope: allowed.scope ?? 'run',
        value: allowed.value,
        cap: allowed.cap,
        tried: [allowed.reason],
      }, { stage: 'WORKFLOW_SELECTED' });
      return {
        predicate: args.predicate,
        value: 'INDETERMINATE',
        claim: null,
        inputs: [],
        reprobed: false,
        reason:
          `${allowed.reason}, so no targeted probe was dispatched for ${args.stage} and it `
          + 'stays INDETERMINATE. A budget that could be spent again to avoid a block is not a '
          + 'budget',
      };
    }

    args.discoverySpent.run += 1;
    args.discoverySpent.workItem += 1;
    journal.run('budget', {
      kind: 'CONSUMED',
      counter: 'loops.discovery',
      scope: 'run',
      value: args.discoverySpent.run,
      cap: policies.budgets.loops.discovery.per_run,
      tried: [],
    }, { stage: 'WORKFLOW_SELECTED' });
    journal.run('discovery', {
      kind: 'TARGETED_PROBE',
      tier: 3,
      probes: [args.predicate],
      reason:
        `${args.stage} mutates and its satisfied_by predicate ${args.predicate} is `
        + 'INDETERMINATE. More verification and less irreversible mutation point in opposite '
        + 'directions, so the kernel probes rather than choosing',
      requested_sections: [],
    }, { stage: 'WORKFLOW_SELECTED' });

    const element = realityElementForPredicate(args.predicate);
    if (element !== null) {
      const fresh = await this.ports.discovery.reprobeReality(
        element,
        args.predicateInputs.workItem,
        args.predicateInputs.workItem?.scope ?? { paths: [], capabilities: [], repositories: [] },
      );
      const reality = { ...args.predicateInputs.context.current_reality, [element]: fresh };
      args.evaluator.freshen();
      return args.evaluator.evaluate(args.predicate, {
        ...args.predicateInputs,
        context: { ...args.predicateInputs.context, current_reality: reality },
        stage: args.stage,
      });
    }

    args.evaluator.freshen();
    return args.evaluator.evaluate(args.predicate, {
      ...args.predicateInputs,
      stage: args.stage,
    });
  }

  /* --------------------------------------------------------- the loop ==== */

  private async loop(state: {
    workItem: WorkItem;
    readonly intake: IntakeRecord;
    readonly context: ContextPackage;
    readonly graph: FrozenGraph;
    currentStage: Stage;
    readonly completedPrior: readonly TemplateStage[];
    readonly profile: DodProfileId;
    readonly journal: Journal;
    readonly runId: string;
    readonly evaluator: PredicateEvaluator;
    readonly predicateInputs: PredicateInputs;
    readonly input: StartInput;
    readonly checks: CheckOutcome[];
    /**
     * Envelopes the prologue accepted before the graph was frozen.
     *
     * The `context` mandate's envelope is one: it runs at `CONTEXT_DISCOVERY`, before a
     * template exists, and it carries the criterion 1 verdict. `COMPLETION` collects verdicts
     * from the envelopes this run accepted, so an envelope the graph did not produce still has
     * to be among them or the verdict it supplied is silently lost — which is exactly the
     * defect I-33 recorded. Its cost counts against the run's budget for the same reason.
     */
    readonly priorEnvelopes: readonly HandoffEnvelope[];
    /**
     * Rung 3's admitted prefix, where the ladder took it.
     *
     * The run executes the prefix and **re-resolves at its exit** — the ambiguity did not
     * matter for the prefix, and it does for whatever comes next. Where the prefix covers the
     * whole graph there is no exit to re-resolve at, which is the read-only case.
     */
    readonly safePrefix: readonly TemplateStage[] | null;
    readonly resolutionConfidence: number;
    readonly alternatives: readonly ResolutionAlternative[];
    /** Shared with the prologue's ladder and the resume sweep: it is one loop. */
    readonly discoverySpent: { run: number; workItem: number };
  }): Promise<GraphOutcome> {
    const { policies, clock } = this.ports;
    const { journal, graph, runId } = state;

    const envelopes: HandoffEnvelope[] = [...state.priorEnvelopes];
    const loopCounters: Record<string, number> = {};
    let budget = state.priorEnvelopes.reduce(
      (consumed, envelope) => ({
        run: addCost(consumed.run, envelope.cost),
        workItem: addCost(consumed.workItem, envelope.cost),
      }),
      { run: ZERO_BUDGET, workItem: state.workItem.consumed_budget },
    );
    let dispatchNumber = 0;
    let attemptInStage = 0;
    let escalatedThisStage = false;
    /** `AUTONOMOUS_INTAKE_EXECUTION` fires once per Work Item, at first entry to a mutation. */
    let intakeGateFired = false;
    /** Stages `COMPLETION` has already routed back to once in this run. */
    const routedBack = new Set<TemplateStage>();
    const runStartedAt = clock.now().toISOString();

    /* A bound on iterations that is not a policy threshold: it is the dispatch cap, read from
     * policy, plus the stages, so a graph that ping-pongs still terminates. */
    const maxIterations = policies.budgets.dispatches.per_run + graph.stages.length + 4;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const stage = state.currentStage;

      if (stage === 'COMPLETE' || stage === 'CANCELLED') {
        return this.end(
          journal, state.workItem, runId, 'COMPLETE',
          'the run reached a terminal state', state.workItem.lifecycle, state.checks,
        );
      }
      if (stage === 'BLOCKED') {
        return this.end(
          journal, state.workItem, runId, 'BLOCKED',
          'the run is blocked and resumes in place', state.workItem.lifecycle, state.checks,
        );
      }

      if (stage === 'COMPLETION') {
        const completion = await this.complete(state, envelopes, budget, routedBack);
        if (completion.kind === 'END') return completion;
        /*
         * The route-back is bounded by the dispatch cap the loop already checks each
         * iteration, and by one lap per owing stage: a second lap over a stage that supplied
         * nothing the first time is a quiet retry, and exceeding a bound is never one.
         */
        routedBack.add(completion.to);
        state.currentStage = completion.to;
        attemptInStage = 0;
        escalatedThisStage = false;
        continue;
      }

      const descriptor = policies.stages.get(stage as TemplateStage);
      if (descriptor === undefined) {
        return this.end(
          journal, state.workItem, runId, 'FAILED',
          `stage ${stage} has no descriptor, so the kernel cannot dispatch it`,
          state.workItem.lifecycle, state.checks,
        );
      }

      const budgetVerdict = checkDispatchBudget(
        { run: budget.run, workItem: budget.workItem, runStartedAt },
        policies.budgets,
        clock.now(),
      );
      if (!budgetVerdict.within) {
        journal.run('budget', {
          kind: 'EXCEEDED',
          counter: budgetVerdict.counter,
          scope: budgetVerdict.scope,
          value: budgetVerdict.value,
          cap: budgetVerdict.cap,
          tried: budgetVerdict.report,
        }, { stage });
        journal.run('gate_fired', {
          gate: 'COST_CEILING_EXCEEDED',
          target: `${state.workItem.work_item_id} :: ${runId}`,
          trigger: 'kernel_accounting',
          classifier_id: 'budget_exhausted',
          classification: null,
          request_id: null,
        }, { stage });
        return this.end(
          journal, state.workItem, runId, 'BLOCKED',
          `${budgetVerdict.counter} exhausted per ${budgetVerdict.scope}: `
          + budgetVerdict.report.join('; '),
          state.workItem.lifecycle, state.checks,
        );
      }

      dispatchNumber += 1;
      attemptInStage += 1;

      const outcome = await this.dispatchStage({
        stage: stage as TemplateStage,
        descriptor,
        state,
        dispatchNumber,
        attemptInStage,
        escalatedThisStage,
        envelopes,
        loopCounters,
        budget,
      });

      if (outcome.envelope !== null) {
        envelopes.push(outcome.envelope);
        budget = {
          run: addCost(budget.run, outcome.envelope.cost),
          workItem: addCost(budget.workItem, outcome.envelope.cost),
        };
      }

      /*
       * Gates, classified and recorded, gating nothing.
       *
       * Nothing in this build mutates, so no gate has anything to stop — and a gate that is
       * inert is not a gate that is absent. Building mutation first and adding authorization
       * afterwards is how the gate ends up bypassable, so the classifiers run, the firings are
       * recorded, and a prior denial is surfaced, from now.
       */
      const gateOutcome = await this.classifyAndRecordGates({
        stage: stage as TemplateStage,
        descriptor,
        state,
        envelope: outcome.envelope,
        dispatchNumber,
        intakeGateFired,
      });
      if (gateOutcome.intakeGateFired) intakeGateFired = true;

      /* The structural stages: what the kernel does when a run's *shape* changes. */
      let action = outcome.action;
      if (outcome.envelope !== null) {
        const structural = await this.structural({
          stage: stage as TemplateStage,
          envelope: outcome.envelope,
          state,
        });
        if (structural !== null) action = structural;
      }

      if (action === null) {
        return this.end(
          journal, state.workItem, runId, 'FAILED', outcome.detail,
          state.workItem.lifecycle, state.checks,
        );
      }

      switch (action.kind) {
        case 'TRANSITION': {
          journal.run('transition', {
            from: stage,
            to: action.to,
            trigger: action.trigger,
            edge_kind: action.edge.kind,
            proposed_by: outcome.envelope?.agent ?? null,
            proposed_stage: action.proposedStage,
            overridden: action.overridden,
            evidence: [],
          }, { stage });
          for (const evaluation of action.evaluations) {
            journal.run('predicate_evaluated', {
              predicate: evaluation.predicate,
              evaluated: evaluation.value,
              claim: evaluation.claim,
              inputs: evaluation.inputs,
              reprobed: evaluation.reprobed,
              reason: evaluation.reason,
            }, { stage });
          }
          /*
           * A `PARTIAL` whose unfilled outputs the exit condition did not require proceeds —
           * **recording the gap as an unknown**. Without this the log of a `PARTIAL` that
           * advanced is indistinguishable from the log of a `COMPLETE`, which is precisely how
           * `PARTIAL` becomes a soft `COMPLETE`.
           */
          if (action.unfilledOutputs !== undefined && action.unfilledOutputs.length > 0) {
            journal.run('note', {
              topic: 'partial gap',
              detail:
                `${outcome.envelope?.agent ?? 'the agent'} returned PARTIAL and left `
                + `${action.unfilledOutputs.join(', ')} unfilled. The exit condition of ${stage} `
                + `does not require them (it requires `
                + `${descriptor.required_outputs.join(', ') || 'nothing'}), so the run proceeds `
                + 'and the gap is recorded as an unknown rather than disappearing into a '
                + 'transition that reads like a COMPLETE',
            }, { stage });
          }

          if (action.edge.kind === 'loop') {
            const counter = action.edge.counter;
            if (counter !== null && counter !== undefined) {
              loopCounters[counter] = (loopCounters[counter] ?? 0) + 1;
              budget = {
                run: incrementLoop(budget.run, counter),
                workItem: incrementLoop(budget.workItem, counter),
              };
              journal.run('budget', {
                kind: 'CONSUMED',
                counter: `loops.${counter}`,
                scope: 'run',
                value: loopCounters[counter] ?? 0,
                cap: policies.budgets.loops[counter as keyof typeof policies.budgets.loops].per_run,
                tried: [],
              }, { stage });
            }
          }

          /*
           * Rung 3's exit. The run took the shared prefix because the ambiguity did not matter
           * for it; leaving the prefix is exactly where it starts to. Far more is known now, so
           * the honest move is the one section 4.5 already defines: end this run and re-resolve.
           */
          if (
            state.safePrefix !== null
            && state.safePrefix.includes(stage as TemplateStage)
            && action.to !== 'COMPLETE'
            && action.to !== 'CANCELLED'
            && !state.safePrefix.includes(action.to as TemplateStage)
          ) {
            state.currentStage = action.to;
            return this.reresolve({
              state,
              stage,
              reason:
                `the run executed the common safe prefix `
                + `${state.safePrefix.join(' -> ')} admitted under ambiguity, and ${action.to} `
                + 'is outside it. Far more is known at the prefix exit than was known at '
                + 'resolution, so the work is re-resolved rather than continued on the reading '
                + 'that was not determinate when the graph was frozen',
              evidence: [],
              budget,
              envelopes,
            });
          }

          state.currentStage = action.to;
          attemptInStage = 0;
          escalatedThisStage = false;
          break;
        }

        case 'REDISPATCH':
          if (action.escalateModel) escalatedThisStage = true;
          journal.run('note', {
            topic: 're-dispatch',
            detail: action.reason
              + (action.namedGaps.length > 0 ? ` Gaps named: ${action.namedGaps.join(', ')}` : ''),
          }, { stage });
          break;

        case 'BLOCK':
          journal.run('transition', {
            from: stage,
            to: 'BLOCKED',
            trigger: action.blockerKind,
            edge_kind: 'escalate',
            proposed_by: outcome.envelope?.agent ?? null,
            proposed_stage: null,
            overridden: false,
            evidence: [],
          }, { stage });
          return this.end(
            journal, state.workItem, runId, 'BLOCKED',
            `${action.blockerKind}: ${action.reason}`,
            'BLOCKED', state.checks, action.blockerKind,
          );

        case 'RERESOLVE':
          return this.reresolve({
            state,
            stage,
            reason: action.reason,
            evidence: action.evidence,
            budget,
            envelopes,
          });

        case 'CONTRACT_VIOLATION':
          journal.run('envelope_rejected', {
            envelope_id: outcome.envelope?.envelope_id ?? null,
            step: 'cross_field',
            violations: action.violations,
          }, { stage });
          journal.run('transition', {
            from: stage,
            to: 'BLOCKED',
            trigger: 'contract violation',
            edge_kind: 'escalate',
            proposed_by: outcome.envelope?.agent ?? null,
            proposed_stage: null,
            overridden: false,
            evidence: [],
          }, { stage });
          return this.end(
            journal, state.workItem, runId, 'BLOCKED',
            action.violations.map((v) => `${v.code}: ${v.message}`).join('; '),
            'BLOCKED', state.checks,
          );

        default:
          break;
      }
    }

    return this.end(
      journal, state.workItem, runId, 'BLOCKED',
      `the run made ${maxIterations} iterations without reaching a terminal state. Exceeding a `
      + 'bound is BLOCKED, never a quiet retry',
      state.workItem.lifecycle, state.checks,
    );
  }

  /* ------------------------------------------------------ structural stages ==== */

  /**
   * `REVIEW_TRIAGE`, `DECOMPOSITION` and `CHILD_COORDINATION` — the three places a run's shape
   * changes because an agent read something.
   *
   * Returns an action that **overrides** the state machine's where the kernel's own decision
   * differs — a decomposition exceeding its bound is `BLOCKED` whatever the envelope's status
   * said — and `null` where the ordinary transition stands.
   */
  private async structural(args: {
    readonly stage: TemplateStage;
    readonly envelope: HandoffEnvelope;
    readonly state: {
      workItem: WorkItem;
      readonly context: ContextPackage;
      readonly journal: Journal;
      readonly runId: string;
      readonly evaluator: PredicateEvaluator;
      readonly predicateInputs: PredicateInputs;
    };
  }): Promise<KernelAction | null> {
    const { policies, clock, store } = this.ports;
    const { state, envelope } = args;
    const journal = state.journal;

    /* ------------------------------------------------------ REVIEW_TRIAGE ---- */

    if (args.stage === 'REVIEW_TRIAGE') {
      const triage = triageEnvelope(envelope, state.workItem);
      if (triage.decisions.length === 0) return null;

      for (const decision of triage.decisions) {
        journal.run('note', {
          topic: `triage ${decision.threadId}`,
          detail:
            `routed ${decision.route} by scope containment; the agent proposed `
            + `${decision.proposedRoute}, which is recorded and ignored`
            + (decision.overridden ? ' (the kernel disagreed)' : '')
            + `. ${decision.reason}`,
        }, { stage: args.stage });
      }

      for (const decision of triage.children) {
        const child = childWorkItem({
          parent: state.workItem,
          title: decision.reading,
          type: 'TASK',
          scope: decision.remediationScope,
          desiredOutcome: decision.reading,
          externalIdentity: null,
          dependsOn: [],
          /* DISCOVERED_BY, not CHILD_OF: triage found it while doing something else, and the
           * parent does not wait for it unless a dependency is declared. */
          link: 'DISCOVERED_BY',
          now: clock.now().toISOString(),
          policies,
        });
        const existing = store.getWorkItem(child.work_item_id);
        if (existing === null) store.putWorkItemProjection(child);
        state.workItem = withChildLink(state.workItem, child.work_item_id);
        store.putWorkItemProjection(state.workItem);
        journal.both('child_work_item', {
          action: existing === null ? 'CREATED' : 'LINKED',
          child_id: child.work_item_id,
          external_identity: null,
          depends_on: [],
          reason: decision.reason,
        }, { stage: args.stage });
      }

      for (const decision of triage.scopeExpansions) {
        /*
         * `SCOPE_EXPANSION` is an existing gate: the human either widens the mandate or
         * accepts the split. It fires here, is recorded here, and gates nothing in a build
         * where nothing mutates.
         */
        journal.run('gate_fired', {
          gate: 'SCOPE_EXPANSION',
          target: decision.remediationScope.paths.join(', ') || decision.threadId,
          trigger: 'kernel_policy',
          classifier_id: 'triage_outside_scope_inseparable',
          classification: null,
          request_id: null,
        }, { stage: args.stage });
      }

      return null;
    }

    /* ------------------------------------------------------ DECOMPOSITION ---- */

    if (args.stage === 'DECOMPOSITION') {
      if ((envelope.proposals.decomposition ?? []).length === 0) return null;

      /*
       * Discovery before creation. The children the project-management adapter already knows
       * about are read **before any are proposed**, and an admitted child whose external
       * identity already exists is linked rather than recreated — which is what stops a
       * resumed Epic from duplicating its own backlog.
       */
      const existingExternal = externalChildren(state.context.current_reality.children);
      journal.run('discovery', {
        kind: 'TARGETED_PROBE',
        tier: 3,
        probes: ['pm.children'],
        reason:
          `${existingExternal.length} existing external child(ren) read before any `
          + 'decomposition is admitted. An admitted child whose external identity already '
          + 'exists is linked, never recreated',
        requested_sections: [],
      }, { stage: args.stage });

      const outcome = decomposeEnvelope({
        parent: state.workItem,
        envelope,
        policies,
        existingExternalChildren: existingExternal,
        now: clock.now().toISOString(),
      });

      if (outcome.result.outcome === 'BLOCKED') {
        for (const retained of outcome.retained) {
          journal.both('child_work_item', {
            action: 'REFUSED',
            child_id: null,
            external_identity: retained.external_identity,
            depends_on: [...retained.depends_on],
            reason:
              `retained as evidence for a human: ${retained.title} (${retained.type}). `
              + outcome.result.reason,
          }, { stage: args.stage });
        }
        return {
          kind: 'BLOCK',
          blockerKind: 'AUTHORIZATION_REQUIRED',
          reason: outcome.result.reason,
          preBlockStage: args.stage,
          report: [
            outcome.result.reason,
            'exceeding a bound is not a silent truncation and not a refusal: the proposed '
            + 'decomposition is attached, for a human to confirm or narrow',
            ...outcome.retained.map((r) => `${r.type} ${r.title} over ${r.scope.paths.join(', ')}`),
          ],
        };
      }

      for (const [action, children] of [
        ['CREATED', outcome.created], ['LINKED', outcome.linked],
      ] as const) {
        for (const child of children) {
          const already = store.getWorkItem(child.work_item_id);
          if (already === null) store.putWorkItemProjection(child);
          state.workItem = withChildLink(state.workItem, child.work_item_id);
          store.putWorkItemProjection(state.workItem);
          journal.both('child_work_item', {
            action: already === null ? action : 'LINKED',
            child_id: child.work_item_id,
            external_identity: child.external_identity,
            depends_on: [...child.dependencies],
            reason:
              `${child.type} at decomposition depth ${child.decomposition_depth}, linked `
              + `CHILD_OF ${state.workItem.work_item_id}. ${outcome.result.reason}`,
          }, { stage: args.stage });
        }
      }

      return null;
    }

    /* ------------------------------------------------- CHILD_COORDINATION ---- */

    if (args.stage === 'CHILD_COORDINATION') {
      state.evaluator.freshen();
      const satisfied = await state.evaluator.evaluate(
        'reality.outcome_already_satisfied', state.predicateInputs,
      );
      journal.run('predicate_evaluated', {
        predicate: satisfied.predicate,
        evaluated: satisfied.value,
        claim: null,
        inputs: satisfied.inputs,
        reprobed: satisfied.reprobed,
        reason: satisfied.reason,
      }, { stage: args.stage });

      const children = this.childrenOf(state.workItem, state.context.current_reality.children);
      const outcome = coordinateChildren({
        parent: state.workItem,
        envelope,
        children,
        outcomeAlreadySatisfied: satisfied.value,
      });

      journal.run('note', {
        topic: 'child coordination',
        detail:
          `${outcome.detail}. Startable: ${outcome.startable.join(', ') || 'none'}. Waiting: `
          + (outcome.waiting
            .map((w) => `${w.workItemId} on ${w.on.join(', ')}`).join('; ') || 'none'),
      }, { stage: args.stage });

      if (outcome.cancellation !== null) {
        journal.both('note', {
          topic: 'child cancellation',
          detail: outcome.cancellation.outcome === 'ADMITTED'
            ? `admitted to ${outcome.cancellation.to}: ${outcome.cancellation.reason}`
            : `escalated to a human: ${outcome.cancellation.reason}`,
        }, { stage: args.stage });
        if (outcome.cancellation.outcome === 'ESCALATED') {
          journal.run('gate_fired', {
            gate: 'SCOPE_EXPANSION',
            target: envelope.proposals.cancellation?.work_item_id ?? state.workItem.work_item_id,
            trigger: 'kernel_policy',
            classifier_id: 'cancellation_without_adapter_evidence',
            classification: null,
            request_id: null,
          }, { stage: args.stage });
        }
      }

      if (outcome.epicBlocks) {
        return {
          kind: 'BLOCK',
          blockerKind: 'AUTHORIZATION_REQUIRED',
          reason:
            'no child can progress. A blocked child leaves its siblings running; the Epic '
            + 'blocks only when nothing can move, which is this',
          preBlockStage: args.stage,
          report: [
            outcome.detail,
            ...outcome.waiting.map((w) => `${w.workItemId} waits on ${w.on.join(', ')}`),
          ],
        };
      }

      return null;
    }

    return null;
  }

  /** The children of a work item, from its links and from the reality set. */
  private childrenOf(
    parent: WorkItem,
    children: Assertion,
  ): readonly {
      readonly workItemId: string;
      readonly dependsOn: readonly string[];
      readonly lifecycle: WorkItem['lifecycle'];
    }[] {
    const { store } = this.ports;
    const ids = new Set<string>(
      parent.links.filter((l) => l.kind === 'PARENT_OF').map((l) => l.target),
    );
    for (const entry of externalChildren(children)) {
      ids.add(entry);
    }
    const out: {
      workItemId: string;
      dependsOn: readonly string[];
      lifecycle: WorkItem['lifecycle'];
    }[] = [];
    for (const id of ids) {
      const record = store.getWorkItem(id);
      if (record === null) continue;
      out.push({
        workItemId: id,
        dependsOn: record.dependencies,
        lifecycle: record.lifecycle,
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ gates ==== */

  /**
   * Classifies and records every gate that fires, and gates nothing.
   *
   * The MVP mutates nothing, so no gate has anything to stop — and "inert" is not "absent".
   * A gate that fires only when an agent volunteers that it is crossing one is not a gate, so
   * the classifiers run from what the adapter observed on every dispatch, and a gate this
   * work item has already been denied is surfaced rather than quietly re-requested.
   */
  private async classifyAndRecordGates(args: {
    readonly stage: TemplateStage;
    readonly descriptor: StageDescriptor;
    readonly state: {
      workItem: WorkItem;
      readonly intake: IntakeRecord;
      readonly graph: FrozenGraph;
      readonly journal: Journal;
      readonly runId: string;
    };
    readonly envelope: HandoffEnvelope | null;
    readonly dispatchNumber: number;
    readonly intakeGateFired: boolean;
  }): Promise<{ readonly intakeGateFired: boolean }> {
    const { policies, clock, store } = this.ports;
    const { state } = args;
    const journal = state.journal;

    const dispatchId = sequentialId('d', args.dispatchNumber);
    const mutations = this.mutationsFor(
      journal, state.runId, state.workItem.work_item_id, dispatchId,
    );
    const calls = this.callsFor(
      journal, state.runId, state.workItem.work_item_id, dispatchId,
    );

    const paths = [...new Set(mutations.map((m) => m.target))];
    const outOfScope = calls
      .filter((c) => c.refusal === 'scope_violation')
      .flatMap((c) => c.paths_touched);

    /*
     * Fail-closed classifications, from the adapter rather than from the agent. Asking for
     * them even when nothing mutated is deliberate: a classifier that cannot evaluate fires
     * the gate, and "we never asked" is not the same answer as "we asked and it said no".
     */
    const classifications: Classification[] = [];
    if (args.descriptor.mutating) {
      for (const kind of ['branch_protection', 'environment'] as const) {
        classifications.push(await this.ports.adapters.classify(kind, this.ports.repositoryPath));
      }
    }

    const firings = classifyGates(policies, {
      descriptor: null,
      paths,
      content: null,
      classifications,
      outOfScopePaths: outOfScope,
      trustClass: state.workItem.origin_trust_class,
      stage: args.stage,
      stageMutating: args.descriptor.mutating,
      intakeGateAlreadyFired: args.intakeGateFired,
      intakeSource: state.intake.source_locator.adapter,
      selfDeclared: args.envelope?.proposals.authorization_request === undefined
        ? []
        : [args.envelope.proposals.authorization_request.gate],
    });

    let intakeFired = args.intakeGateFired;
    for (const firing of firings) {
      if (firing.gate === 'AUTONOMOUS_INTAKE_EXECUTION') intakeFired = true;

      const denial = previouslyDenied(
        state.workItem.denied_gates, firing.gate, firing.target,
      );

      const draft = args.envelope?.proposals.authorization_request;
      const request = draft === undefined || draft.gate !== firing.gate
        ? null
        : recordRequest({
          requestId: `${state.runId}_${firing.gate}_${args.dispatchNumber}`,
          workItemId: state.workItem.work_item_id,
          runId: state.runId,
          stage: args.stage,
          requestedBy: args.descriptor.default_agent,
          requestedAt: clock.now().toISOString(),
          draft,
          firing,
        });

      journal.run('gate_fired', {
        gate: firing.gate,
        target: firing.target,
        trigger: firing.trigger,
        classifier_id: firing.classifierId,
        classification: firing.classification,
        request_id: request?.request_id ?? null,
      }, { stage: args.stage, dispatchId, agent: args.descriptor.default_agent });

      if (request !== null) {
        store.putNamed(
          state.workItem.work_item_id, state.runId, 'authorizations',
          request.request_id, request,
        );
        journal.run('authorization_requested', request, {
          stage: args.stage, dispatchId, agent: args.descriptor.default_agent,
        });
      }

      if (denial !== null) {
        journal.run('note', {
          topic: `gate ${firing.gate} previously denied`,
          detail:
            `${denial.denied_by} denied ${firing.gate} on ${denial.target} at `
            + `${denial.denied_at}: ${denial.reason}. Denials are recorded at the work item `
            + 'level precisely so that starting a fresh Workflow Run is not a way to ask '
            + 'again; a denial is cleared by new information or by a human revisiting it, '
            + 'never by a retry',
        }, { stage: args.stage, dispatchId });
      }

      journal.run('note', {
        topic: `gate ${firing.gate} is inert`,
        detail:
          `${firing.reason}. Nothing in this build mutates, so the gate is classified and `
          + 'recorded and stops nothing. The contract exists, the adapter checks it, and the '
          + 'first mutating operation registered lands in a system that already cannot perform '
          + 'an unlogged or ungated one',
      }, { stage: args.stage, dispatchId });
    }

    return { intakeGateFired: intakeFired };
  }

  /* ---------------------------------------------------------- re-resolution ==== */

  /**
   * Step 1 of section 4.5: end the Workflow Run with outcome `RERESOLVED`.
   *
   * Steps 2 and 3 — re-running `RESOLUTION` with the new evidence and starting a **new** run
   * against the **same** Work Item — happen in `performReresolution`, after this run's lease
   * is released. They cannot happen here: the lease is one active run per Work Item, and a
   * new run started while the old one still held it would be refused by the mechanism that
   * exists to refuse exactly that.
   */
  private reresolve(args: {
    readonly state: {
      workItem: WorkItem;
      readonly journal: Journal;
      readonly runId: string;
      readonly checks: CheckOutcome[];
      currentStage: Stage;
    };
    readonly stage: Stage;
    readonly reason: string;
    readonly evidence: readonly string[];
    readonly budget: { readonly workItem: WorkItem['consumed_budget'] };
    readonly envelopes: readonly HandoffEnvelope[];
  }): { readonly result: RunResult; readonly workItem: WorkItem; readonly reresolve?: { readonly reason: string; readonly evidence: readonly string[] } } {
    const { policies, store } = this.ports;
    const { state } = args;
    const { journal, runId } = state;

    const allowance = reresolutionAllowed(
      state.workItem.reresolution_count, policies.budgets,
    );
    journal.both('reresolved', {
      reason: args.reason,
      evidence: [...args.evidence],
      count: state.workItem.reresolution_count + 1,
      cap: allowance.cap,
      /* This run does not know it, and will not: the new run is allocated after the lease is
       * released. The work-item log carries the second half once it exists. */
      new_run_id: null,
    }, { stage: args.stage });

    if (!allowance.allowed) {
      return this.end(
        journal, state.workItem, runId, 'BLOCKED', allowance.reason,
        'BLOCKED', state.checks,
      );
    }

    state.workItem = {
      ...state.workItem,
      reresolution_count: state.workItem.reresolution_count + 1,
      consumed_budget: args.budget.workItem,
    };
    store.putWorkItemProjection(state.workItem);

    const ended = this.end(
      journal, state.workItem, runId, 'RERESOLVED',
      `${args.reason}. The run ends honestly and a new one starts against the same Work Item: `
      + 'identity, history and every prior envelope survive, and only the graph is new',
      state.workItem.lifecycle, state.checks,
    );

    return { ...ended, reresolve: { reason: args.reason, evidence: args.evidence } };
  }

  /**
   * Steps 2 and 3 of section 4.5.
   *
   * Re-runs `RESOLUTION` with the new evidence supplied alongside the original intake and
   * admits the result **through the ordinary checks** — the corrected type earns no exemption
   * from its evidence minimum, which is the whole reason this is a re-resolution rather than a
   * relabelling. Then starts a new Workflow Run against the same Work Item.
   *
   * Identity, history and every prior envelope survive because nothing here touches them: the
   * work item record is loaded from the store, the previous run's directory is untouched, and
   * only the graph is new.
   */
  private async performReresolution(args: {
    readonly workItem: WorkItem;
    readonly intake: IntakeRecord;
    readonly orientation: ContextPackage;
    readonly input: StartInput;
    readonly checks: CheckOutcome[];
    readonly priorRunId: string | null;
    readonly reason: string;
    readonly evidence: readonly string[];
  }): Promise<RunResult> {
    const { clock, policies, store } = this.ports;
    const journal = Journal.open(store, clock, {
      workItemId: args.workItem.work_item_id, runId: null,
    });
    const events: Event[] = [];
    let seq = 0;
    const log: PrologueLogger = (kind, data, stage) => {
      seq += 1;
      events.push({
        seq,
        at: clock.now().toISOString(),
        work_item_id: args.workItem.work_item_id,
        run_id: null,
        stage,
        dispatch_id: null,
        agent: null,
        event: kind,
        data,
      } as Event);
    };

    const violations: Violation[] = [{
      code: 'SCHEMA_INVALID',
      rule: 'WORKFLOW_STATE_MACHINE section 4.5',
      message:
        `the previous run ended RERESOLVED: ${args.reason}. Re-resolve with this evidence `
        + `alongside the original intake: ${args.evidence.join(', ') || '(none cited)'}`,
      path: null,
      handled_as: 'REFUSED',
      subject: args.workItem.work_item_id,
    }];

    const resolution = await this.dispatchResolution(
      args.intake, args.orientation, log, violations,
    );
    for (const event of events) journal.workItem(event.event as never, event.data as never, {
      stage: event.stage,
    });

    if (resolution.proposal === null) {
      journal.workItem('note', {
        topic: 're-resolution',
        detail:
          're-resolution produced no admissible proposal, so no new run starts. A second guess '
          + 'is not better than a human',
      });
      return {
        outcome: 'BLOCKED',
        workItemId: args.workItem.work_item_id,
        runId: args.priorRunId,
        detail: `re-resolution produced no proposal: ${resolution.detail}`,
        narrative: '',
        checks: args.checks,
        blockerKind: null,
      };
    }

    const identity = await args.input.resolveIdentity(
      resolution.proposal.external_identity.confidence === 'UNKNOWN'
        ? null
        : String(resolution.proposal.external_identity.value),
    );
    const verification = await this.verifyResolution(
      resolution.envelope, resolution.proposal, args.intake, events,
    );
    const registry = this.capabilityRegistry();

    const admission = admitWorkItem({
      intake: args.intake,
      proposal: resolution.proposal,
      policies,
      context: args.orientation,
      capabilities: registry.records,
      capabilityRegistryAvailable: registry.available,
      evidence: resolution.envelope?.evidence ?? [],
      verification,
      identity,
      existing: this.loadWorkItems(),
      access: this.ports.access,
      now: clock.now().toISOString(),
    });

    if (admission.outcome !== 'ADMITTED') {
      journal.workItem('work_item_rejected', {
        checks: admission.checks,
        attempt: 1,
        next: 'BLOCKED',
      }, { stage: 'RESOLUTION' });
      return {
        outcome: 'BLOCKED',
        workItemId: args.workItem.work_item_id,
        runId: args.priorRunId,
        detail:
          'the re-resolved proposal was not admitted. The corrected type earns no exemption '
          + 'from its evidence minimum, which is what makes this a re-resolution rather than a '
          + 'relabelling',
        narrative: '',
        checks: [...args.checks, ...admission.checks],
        blockerKind: admission.outcome === 'BLOCKED' ? admission.blockerKind : null,
      };
    }

    const result = await this.continueWithWorkItem({
      workItem: admission.workItem,
      intake: args.intake,
      orientation: args.orientation,
      prologue: events,
      input: args.input,
      checks: args.checks,
      typeDowngraded: admission.typeDowngraded,
      intent: admission.intent,
      resolutionConfidence: admission.resolutionConfidence,
      alternatives: resolution.proposal.alternatives,
    });

    /* The other half of step 1's record: which run the work item re-resolved into. */
    journal.workItem('reresolved', {
      reason: args.reason,
      evidence: [...args.evidence],
      count: args.workItem.reresolution_count,
      cap: policies.budgets.reresolution,
      new_run_id: result.runId,
    }, { stage: 'RESOLUTION' });

    return result;
  }

  /* ------------------------------------------------------------ COMPLETION ==== */

  private async complete(
    state: {
      workItem: WorkItem;
      readonly intake: IntakeRecord;
      readonly graph: FrozenGraph;
      readonly completedPrior: readonly TemplateStage[];
      readonly profile: DodProfileId;
      readonly journal: Journal;
      readonly runId: string;
      readonly input: StartInput;
      readonly checks: CheckOutcome[];
      currentStage: Stage;
    },
    envelopes: readonly HandoffEnvelope[],
    budget: { readonly run: WorkItem['consumed_budget']; readonly workItem: WorkItem['consumed_budget'] },
    /** Stages this run has already been routed back to once. */
    alreadyRoutedBack: ReadonlySet<TemplateStage>,
  ): Promise<CompletionOutcome> {
    const { policies, clock, store } = this.ports;
    const { journal, runId } = state;

    /* Source drift: re-execute the intake locator and compare the content hash. */
    const reread = await state.input.rereadIntake(state.intake.source_locator);
    const drift = compareSourceDrift(state.intake.content_hash, reread);
    journal.run('source_drift', drift, { stage: 'COMPLETION' });

    const dod = computeDod({
      workItemId: state.workItem.work_item_id,
      runId,
      profileId: state.profile,
      policies,
      envelopes,
      completedPriorStages: state.completedPrior,
      graphStages: state.graph.stages,
      sourceDrift: drift,
      computedAt: clock.now().toISOString(),
    });

    store.putNamed(
      state.workItem.work_item_id, runId, 'decisions', 'completion', dod.report,
    );
    journal.run('dod_computed', dod.report, { stage: 'COMPLETION' });

    const verdict = dod.report.verdict;
    /*
     * `INDETERMINATE` is not a finished run. "Completion cannot be judged because evidence
     * was unobtainable" and "the work is done" are different facts about the world
     * (DEFINITION_OF_DONE section 5), and ending the run COMPLETE would report the first as
     * the second. It blocks, stating exactly what could not be checked.
     */
    const outcome: RunOutcome = verdict === 'COMPLETE' || verdict === 'COMPLETE_WITH_GAPS'
      ? 'COMPLETE'
      : 'BLOCKED';
    const lifecycle = outcome === 'COMPLETE' ? 'ACHIEVED' : state.workItem.lifecycle;

    const routeBackTo = dod.report.route_back_to;
    if (verdict === 'INCOMPLETE' && routeBackTo !== null) {
      /*
       * The cursor has no authority over completion. A skipped stage supplied no verdicts, so
       * its criteria are NOT_VALIDATED, so COMPLETION computes INCOMPLETE and routes back to
       * the stage that owes them — and **the route-back is executed**, not merely journalled.
       * This is the mechanism that makes resumption safe: it is what stops a COMPLETED_PRIOR
       * stage from producing a false COMPLETE, and a route-back the run does not take is a
       * safety property nothing enforces.
       */
      journal.run('transition', {
        from: 'COMPLETION',
        to: routeBackTo,
        trigger: `INCOMPLETE: criteria ${dod.report.unmet_critical.join(', ')} are not met`,
        edge_kind: 'loop',
        proposed_by: null,
        proposed_stage: null,
        overridden: false,
        evidence: [],
      }, { stage: 'COMPLETION' });

      if (state.graph.stages.includes(routeBackTo) && !alreadyRoutedBack.has(routeBackTo)) {
        journal.run('note', {
          topic: 'route back',
          detail:
            `${routeBackTo} owes criteria ${dod.report.unmet_critical.join(', ')} and supplied `
            + 'no verdict for them. The run routes back into the graph there rather than '
            + 'ending: resumption is an optimization over work and has no authority over '
            + 'completion, so a wrong resume costs a lap and cannot manufacture a COMPLETE',
        }, { stage: 'COMPLETION' });
        return { kind: 'ROUTE_BACK', to: routeBackTo };
      }

      journal.run('note', {
        topic: 'route back',
        detail: state.graph.stages.includes(routeBackTo)
          ? `${routeBackTo} was already routed back to once in this run and still owes `
            + `criteria ${dod.report.unmet_critical.join(', ')}. A second lap would be a quiet `
            + 'retry, so the run ends and a human sees what the stage could not establish'
          : `${routeBackTo} owes criteria ${dod.report.unmet_critical.join(', ')} and is not in `
            + 'this run\'s frozen graph, so there is nowhere in it to route back to',
      }, { stage: 'COMPLETION' });
    }

    const workItem: WorkItem = {
      ...state.workItem,
      lifecycle,
      consumed_budget: budget.workItem,
    };
    store.putWorkItemProjection(workItem);

    if (lifecycle !== state.workItem.lifecycle) {
      journal.both('work_item_lifecycle', {
        from: state.workItem.lifecycle,
        to: lifecycle,
        reason: `the Definition of Done computed ${verdict}`,
        evidence: [],
        decided_by: 'kernel',
      }, { stage: 'COMPLETION' });
    }

    return { kind: 'END', ...this.end(
      journal,
      workItem,
      runId,
      outcome,
      verdict === 'COMPLETE_WITH_GAPS'
        ? `${verdict}: ${dod.rationale.join(' ')} This verdict requires human acknowledgement: `
          + 'the gaps are deferred with recorded reasons, and deferring is a decision somebody '
          + 'has to have made'
        : `${verdict}: ${dod.rationale.join(' ')}`,
      lifecycle,
      state.checks,
    ) };
  }

  /* --------------------------------------------------------- dispatching ==== */

  private async dispatchStage(args: {
    readonly stage: TemplateStage;
    readonly descriptor: StageDescriptor;
    readonly state: {
      workItem: WorkItem;
      readonly context: ContextPackage;
      readonly graph: FrozenGraph;
      readonly journal: Journal;
      readonly runId: string;
      readonly evaluator: PredicateEvaluator;
      readonly predicateInputs: PredicateInputs;
      readonly profile: DodProfileId;
      currentStage: Stage;
    };
    readonly dispatchNumber: number;
    readonly attemptInStage: number;
    readonly escalatedThisStage: boolean;
    readonly envelopes: readonly HandoffEnvelope[];
    readonly loopCounters: Readonly<Record<string, number>>;
    readonly budget: { readonly run: WorkItem['consumed_budget']; readonly workItem: WorkItem['consumed_budget'] };
  }): Promise<DispatchOutcome> {
    const { policies, clock, store } = this.ports;
    const { state, stage, descriptor } = args;
    const { journal, runId } = state;

    const role: AgentRole = descriptor.default_agent;
    const spec = this.ports.agents.spec(role, stage.toLowerCase());
    const effectiveSpec: AgentSpecView = spec ?? this.fallbackSpec(role, descriptor);

    const dispatchId = sequentialId('d', args.dispatchNumber);
    const mandateScope: Scope = state.graph.stage_mandates[stage] ?? state.workItem.scope;

    const model = await this.chooseModel(
      effectiveSpec, journal, stage, args.escalatedThisStage,
      args.envelopes[args.envelopes.length - 1]?.model ?? null,
    );
    if (model === null) {
      /*
       * No model available. The dispatch returns FAILED, the kernel retries per policy, then
       * blocks with EXTERNAL_DEPENDENCY. No state advances, nothing merges, and the run
       * resumes at the same point when a model returns.
       */
      journal.run('dispatch_result', {
        outcome: 'FAILED',
        envelope_id: null,
        failure_reason: 'NO_MODEL',
        detail:
          'no reachable model meets the declared requirement. Proceeding on an inadequate '
          + 'model and reporting the result as normal is a form of dishonesty the evidence '
          + 'model is built to prevent',
        cost: { input_tokens: 0, output_tokens: 0 },
      }, { stage, dispatchId, agent: role });
      const action = await this.decide(
        null, args, 'NO_MODEL',
      );
      return { envelope: null, action, failed: true, detail: 'no model available' };
    }

    const tools = await this.grantTools(effectiveSpec, descriptor);
    const skills = await this.grantSkills(effectiveSpec, descriptor, journal, stage);

    const inputPackage: InputPackage = {
      work_item_id: state.workItem.work_item_id,
      run_id: runId,
      dispatch_id: dispatchId,
      agent: role,
      mandate_name: effectiveSpec.mandate_name,
      stage,
      work_item_ref: '../work-item.json',
      intake_ref: null,
      workflow: {
        template_id: state.graph.template_id,
        version: state.graph.template_version,
        stages_remaining: stagesRemaining(
          this.cursorNow(state.workItem.work_item_id, runId), state.graph,
        ),
      },
      context_package_ref: `context/v1.json`,
      context_sections: this.materialize(state.context, effectiveSpec.required_inputs),
      capability_registry_ref: null,
      prior_envelopes: args.envelopes.map((e) => e.envelope_id),
      mandate: {
        objective: effectiveSpec.objective,
        in_scope: mandateScope.paths,
        out_of_scope: [],
        capabilities: mandateScope.capabilities,
        advisory_notes: '',
      },
      required_inputs: effectiveSpec.required_inputs,
      required_outputs: effectiveSpec.required_outputs,
      dod_profile_ref: `policies/dod/${state.profile}.json`,
      dod_criteria_owed: descriptor.dod_criteria,
      constraints: state.workItem.constraints,
      authorization_scope: { autonomous: [], gated: descriptor.gates_possible, grants_held: [] },
      tools_granted: tools,
      skills_available: skills,
      model,
      budget: dispatchBudget(policies.budgets),
    };

    /* Write before act. The intent is on disk and flushed before the agent is invoked, so a
     * crash mid-agent is detectable rather than invisible. */
    journal.run('dispatch_intent', {
      input_package: inputPackage,
      attempt: args.attemptInStage,
    }, { stage, dispatchId, agent: role });

    const result = await this.ports.substrate.dispatch(inputPackage, {
      invoke: async (toolName, toolArgs) => {
        const grant = tools.find((t) => t.tool_name === toolName);
        if (grant === undefined) {
          return {
            outcome: 'REFUSED',
            refusal: 'unknown_tool',
            message:
              `${toolName} is not in this dispatch's granted tool set. The effective tool `
              + 'surface is an allowlist, and a tool outside it is absent rather than forbidden',
            abortDispatch: true,
          };
        }
        const callResult = await this.ports.adapters.call(
          grant.adapter, grant.op, toolArgs, this.callContext(state, dispatchId, mandateScope),
        );
        journal.run('adapter_call', callResult.call, { stage, dispatchId, agent: role });
        if (callResult.outcome === 'OK') {
          for (const mutation of callResult.mutations) {
            journal.run('mutation', mutation, { stage, dispatchId, agent: role });
          }
          return { outcome: 'OK', value: callResult.value };
        }
        if (callResult.outcome === 'REFUSED') {
          const isSecurity = callResult.refusal === 'security_violation';
          journal.run(isSecurity ? 'security_violation' : 'scope_violation', {
            adapter: grant.adapter,
            op: grant.op,
            requested: typeof toolArgs['path'] === 'string' ? toolArgs['path'] : grant.op,
            resolved: null,
            rule: isSecurity ? 'deny_list' : 'mandate_in_scope',
            deny_list_entry: null,
            aborted_dispatch: isSecurity,
            detail: callResult.message,
          }, { stage, dispatchId, agent: role });
          return {
            outcome: 'REFUSED',
            refusal: callResult.refusal,
            message: callResult.message,
            abortDispatch: isSecurity,
          };
        }
        return { outcome: 'ERROR', message: callResult.message };
      },
    });

    journal.run('tool_surface_conformance', {
      substrate: this.ports.substrate.name,
      verdict: result.toolSurface?.verdict ?? 'UNVERIFIABLE',
      expected: result.toolSurface?.expected ?? tools.map((t) => t.tool_name),
      effective: result.toolSurface?.effective ?? [],
      unexpected: result.toolSurface?.unexpected ?? [],
      missing: result.toolSurface?.missing ?? [],
      detail: result.toolSurface?.detail
        ?? 'the substrate reported no tool surface, so conformance is unverifiable and the '
          + 'dispatch fails closed',
    }, { stage, dispatchId, agent: role });

    if (result.outcome === 'FAILED') {
      journal.run('dispatch_result', {
        outcome: 'FAILED',
        envelope_id: null,
        failure_reason: result.failure,
        detail: result.detail,
        cost: { input_tokens: result.cost.input_tokens, output_tokens: result.cost.output_tokens, usd: result.cost.usd },
      }, { stage, dispatchId, agent: role });
      const action = await this.decide(null, args, result.failure);
      return { envelope: null, action, failed: true, detail: result.detail };
    }

    if (result.toolSurface.verdict !== 'CONFORMS') {
      /*
       * D-2's binding condition. An SDK upgrade that adds a tool must break this check rather
       * than pass quietly, so a non-conforming surface fails the dispatch before anything it
       * returned is trusted.
       */
      journal.run('dispatch_result', {
        outcome: 'ABORTED',
        envelope_id: null,
        failure_reason: 'TOOL_SURFACE_VIOLATION',
        detail: result.toolSurface.detail,
        cost: { input_tokens: result.cost.input_tokens, output_tokens: result.cost.output_tokens, usd: result.cost.usd },
      }, { stage, dispatchId, agent: role });
      return {
        envelope: null,
        action: {
          kind: 'BLOCK',
          blockerKind: 'MISSING_CAPABILITY',
          reason:
            'the effective tool surface does not equal the adapter operations the kernel '
            + `exposed: ${result.toolSurface.detail}`,
          preBlockStage: stage,
          report: [
            `expected: ${result.toolSurface.expected.join(', ')}`,
            `effective: ${result.toolSurface.effective.join(', ')}`,
            'the tool surface is an allowlist, never a denylist, and subtraction fails open',
          ],
        },
        failed: true,
        detail: result.toolSurface.detail,
      };
    }

    /* ---------------------------------------------- envelope receipt ---- */

    const mutations = this.mutationsFor(journal, runId, state.workItem.work_item_id, dispatchId);
    const calls = this.callsFor(journal, runId, state.workItem.work_item_id, dispatchId);

    const receipt = await receiveEnvelope({
      raw: result.envelope,
      expectation: {
        dispatchId,
        stage,
        agent: role,
        requiredOutputs: effectiveSpec.required_outputs,
        dodCriteriaOwed: descriptor.dod_criteria,
        graphStages: state.graph.stages,
      },
      agents: policies.agents,
      evidencePolicy: policies.evidence,
      adapters: this.ports.adapters,
      callContext: this.callContext(state, dispatchId, mandateScope),
      clock,
      mutations,
      calls,
      knownObligations: this.obligations(state.graph),
      existingAssertions: new Map(),
      incomingAssertions: new Map(),
      sampler: this.ports.random,
    });

    if (receipt.outcome === 'REJECTED') {
      journal.run('envelope_rejected', {
        envelope_id: null,
        step: receipt.step,
        violations: receipt.violations,
      }, { stage, dispatchId, agent: role });
      journal.run('dispatch_result', {
        outcome: receipt.handleAs === 'FAILED' ? 'FAILED' : 'ABORTED',
        envelope_id: null,
        failure_reason: receipt.handleAs === 'FAILED' ? 'MALFORMED_ENVELOPE' : null,
        detail: receipt.violations.map((v) => v.message).join('; '),
        cost: { input_tokens: result.cost.input_tokens, output_tokens: result.cost.output_tokens, usd: result.cost.usd },
      }, { stage, dispatchId, agent: role });

      if (receipt.handleAs === 'FAILED') {
        const action = await this.decide(null, args, 'MALFORMED_ENVELOPE');
        return { envelope: null, action, failed: true, detail: 'the envelope was malformed' };
      }
      return {
        envelope: null,
        action: {
          kind: 'CONTRACT_VIOLATION',
          violations: receipt.violations,
          preBlockStage: stage,
        },
        failed: false,
        detail: 'a contract violation, handled as BLOCKED',
      };
    }

    const persisted = withVerification(
      receipt.envelope, receipt.verification, clock.now().toISOString(),
    );
    store.putEnvelope(state.workItem.work_item_id, runId, persisted);

    journal.run('envelope_received', {
      envelope_id: persisted.envelope_id,
      status: persisted.status,
      steps: receipt.steps,
    }, { stage, dispatchId, agent: role });
    journal.run('evidence_verification', {
      envelope_id: persisted.envelope_id,
      results: receipt.verification.outcomes.map((o) => ({
        evidence_id: o.evidence_id,
        status: o.status,
        selected_because: o.selected_because,
        detail: o.detail,
      })),
      mismatch_count: receipt.verification.mismatchCount,
    }, { stage, dispatchId, agent: role });

    for (const outcome of receipt.verification.outcomes) {
      if (outcome.status !== 'MISMATCH' && outcome.status !== 'UNREPLAYABLE') continue;
      journal.run('evidence_integrity', {
        envelope_id: persisted.envelope_id,
        evidence_id: outcome.evidence_id,
        model,
        status: outcome.status,
        downgraded_assertions: receipt.verification.downgrades.map((d) => d.evidence_id),
        demoted_findings: receipt.verification.demotedFindings,
        envelope_rejected: false,
      }, { stage, dispatchId, agent: role });
    }

    for (const { conflict, resolution } of receipt.conflicts) {
      journal.run('conflict', {
        conflict_id: conflict.conflictId,
        subject: conflict.subject,
        position_a: conflict.positionA,
        position_b: conflict.positionB,
        phase: resolution.phase,
        winner: resolution.phase === 'RESOLVED_BY_RULE' ? resolution.winner : 'NONE',
        rule: resolution.phase === 'RESOLVED_BY_RULE' ? resolution.rule : null,
        detail: resolution.detail,
      }, { stage, dispatchId, agent: role });
    }

    journal.run('dispatch_result', {
      outcome: 'ENVELOPE',
      envelope_id: persisted.envelope_id,
      failure_reason: null,
      detail: '',
      cost: {
        input_tokens: result.cost.input_tokens,
        output_tokens: result.cost.output_tokens,
        usd: result.cost.usd,
      },
    }, { stage, dispatchId, agent: role });

    const action = await this.decide(persisted, args, null);
    return { envelope: persisted, action, failed: false, detail: '' };
  }

  /** Maps an envelope, or a failure, onto exactly one kernel action. */
  private async decide(
    envelope: HandoffEnvelope | null,
    args: {
      readonly stage: TemplateStage;
      readonly descriptor: StageDescriptor;
      readonly state: {
        readonly graph: FrozenGraph;
        readonly evaluator: PredicateEvaluator;
        readonly predicateInputs: PredicateInputs;
        readonly workItem: WorkItem;
      };
      readonly attemptInStage: number;
      readonly escalatedThisStage: boolean;
      readonly loopCounters: Readonly<Record<string, number>>;
      readonly budget: { readonly workItem: WorkItem['consumed_budget'] };
    },
    failure: string | null,
  ): Promise<KernelAction> {
    const { policies } = this.ports;
    args.state.evaluator.freshen();

    const context: TransitionContext = {
      graph: args.state.graph,
      currentStage: args.stage,
      descriptor: args.descriptor,
      budgets: policies.budgets,
      loopCounters: args.loopCounters,
      workItemLoopCounters: normalizeCounters(args.budget.workItem.loops),
      dispatchAttempt: args.attemptInStage,
      modelAlreadyEscalated: args.escalatedThisStage,
      requiredForExit: args.descriptor.required_outputs,
      evaluate: async (when) => args.state.evaluator.evaluate(when, args.state.predicateInputs),
    };

    if (envelope === null) {
      /* A failure is a FAILED envelope as far as the mapping is concerned: retry per policy,
       * escalating the model once, then BLOCK. The stage does not advance. */
      const synthetic: HandoffEnvelope = {
        envelope_version: '1.2',
        work_item_id: args.state.workItem.work_item_id,
        run_id: 'synthetic',
        envelope_id: 'synthetic',
        dispatch_id: 'synthetic',
        agent: args.descriptor.default_agent,
        agent_version: '0',
        model: 'none',
        skills_used: [],
        stage_in: args.stage,
        started_at: this.ports.clock.now().toISOString(),
        completed_at: this.ports.clock.now().toISOString(),
        cost: { input_tokens: 0, output_tokens: 0 },
        status: 'FAILED',
        summary: failure ?? 'the dispatch failed',
        findings: [],
        evidence: [],
        assumptions: [],
        unknowns: [],
        artifacts_changed: [],
        recommendations: [],
        blockers: [],
        coverage: { scope_examined: ['(none)'], scope_not_examined: [], confidence: 'UNKNOWN' },
        outputs: {},
        dod_verdicts: [],
        proposals: {},
        next_action: null,
      };
      return decideAction(synthetic, context);
    }

    return decideAction(envelope, context);
  }

  /* --------------------------------------------------------- the prologue ==== */

  private async dispatchResolution(
    intake: IntakeRecord,
    orientation: ContextPackage,
    log: PrologueLogger,
    priorViolations: readonly Violation[] = [],
  ): Promise<{
      readonly proposal: ProposedWorkItem | null;
      /** The envelope the proposal arrived in, whose `evidence[]` is the pool it cites into. */
      readonly envelope: HandoffEnvelope | null;
      readonly detail: string;
    }> {
    const spec = this.ports.agents.spec('context-discovery', 'resolution');
    if (spec === undefined) {
      return {
        proposal: null,
        envelope: null,
        detail: 'no Context Discovery resolution mandate is registered',
      };
    }

    const model = await this.chooseModelWithoutJournal(spec);
    if (model === null) {
      log(
        'dispatch_result',
        {
          outcome: 'FAILED',
          envelope_id: null,
          failure_reason: 'NO_MODEL',
          detail: 'no reachable model meets the resolution dispatch\'s precision requirement',
          cost: { input_tokens: 0, output_tokens: 0 },
        },
        'RESOLUTION',
      );
      return { proposal: null, envelope: null, detail: 'no model available for resolution' };
    }

    const dispatchId = 'd_res';
    const inputPackage: InputPackage = {
      work_item_id: intake.intake_id,
      run_id: intake.intake_id,
      dispatch_id: dispatchId,
      agent: 'context-discovery',
      mandate_name: 'resolution',
      stage: 'RESOLUTION',
      work_item_ref: null,
      intake_ref: `intake/${intake.intake_id}/intake.json`,
      workflow: null,
      context_package_ref: null,
      context_sections: this.materialize(orientation, spec.required_inputs),
      capability_registry_ref: null,
      prior_envelopes: [],
      mandate: {
        objective: spec.objective,
        in_scope: [],
        out_of_scope: [],
        capabilities: [],
        advisory_notes: priorViolations.length === 0
          ? ''
          : `the previous proposal was refused: ${priorViolations.map((v) => v.message).join('; ')}`,
      },
      required_inputs: spec.required_inputs,
      required_outputs: spec.required_outputs,
      dod_profile_ref: null,
      dod_criteria_owed: spec.dod_criteria_owned,
      constraints: [],
      authorization_scope: { autonomous: [], gated: [], grants_held: [] },
      tools_granted: await this.grantToolsForSpec(spec),
      skills_available: [],
      model,
      budget: dispatchBudget(this.ports.policies.budgets),
    };

    log('dispatch_intent', { input_package: inputPackage, attempt: 1 }, 'RESOLUTION');

    const result = await this.ports.substrate.dispatch(inputPackage, {
      invoke: async (toolName, toolArgs) => {
        const grant = inputPackage.tools_granted.find((t) => t.tool_name === toolName);
        if (grant === undefined) {
          return {
            outcome: 'REFUSED',
            refusal: 'unknown_tool',
            message: `${toolName} is not granted to this dispatch`,
            abortDispatch: true,
          };
        }
        const call = await this.ports.adapters.call(grant.adapter, grant.op, toolArgs, {
          workItemId: intake.intake_id,
          runId: intake.intake_id,
          dispatchId,
          mandate: { in_scope: [], out_of_scope: [] },
          grantsHeld: [],
          stageMutating: false,
        });
        log('adapter_call', call.call, 'RESOLUTION');
        if (call.outcome === 'OK') return { outcome: 'OK', value: call.value };
        if (call.outcome === 'REFUSED') {
          return {
            outcome: 'REFUSED',
            refusal: call.refusal,
            message: call.message,
            abortDispatch: call.refusal === 'security_violation',
          };
        }
        return { outcome: 'ERROR', message: call.message };
      },
    });

    if (result.outcome === 'FAILED') {
      log(
        'dispatch_result',
        {
          outcome: 'FAILED',
          envelope_id: null,
          failure_reason: result.failure,
          detail: result.detail,
          cost: {
            input_tokens: result.cost.input_tokens,
            output_tokens: result.cost.output_tokens,
            usd: result.cost.usd,
          },
        },
        'RESOLUTION',
      );
      return { proposal: null, envelope: null, detail: result.detail };
    }

    const envelope = result.envelope as HandoffEnvelope | null;
    const proposal = envelope?.proposals.work_item ?? null;
    log(
      'dispatch_result',
      {
        outcome: 'ENVELOPE',
        envelope_id: envelope?.envelope_id ?? null,
        failure_reason: null,
        detail: proposal === null ? 'the envelope carried no work_item proposal' : '',
        cost: {
          input_tokens: result.cost.input_tokens,
          output_tokens: result.cost.output_tokens,
          usd: result.cost.usd,
        },
      },
      'RESOLUTION',
    );

    return {
      proposal,
      envelope,
      detail: proposal === null ? 'the resolution envelope carried no work_item proposal' : '',
    };
  }

  /**
   * The `context` mandate at `CONTEXT_DISCOVERY`, after admission.
   *
   * `IMPLEMENTATION_PLAN` WP-5 asks for Context Discovery with **both** mandates: `resolution`
   * on tier-1 orientation, `context` after admission. Only the first was ever dispatched, and
   * the consequence was not cosmetic — `context-discovery/context` is the sole owner of
   * Definition-of-Done criterion 1, a verdict reaches `computeDod` only inside an accepted
   * envelope, so criterion 1 was `NOT_VALIDATED` in every run of every template and five of the
   * seven profiles could never complete. Decision I-33 made it non-critical everywhere and said
   * the cause was elsewhere. This is the cause.
   *
   * Three things about it are deliberate.
   *
   * **It writes no reality.** `discovery.deepen()` produced the observations and remains the
   * only writer of `current_reality`; the envelope's `current_reality` output is the agent's
   * account of what it examined, and the kernel merges none of it. An agent that supplied both
   * the observations and the judgment of them would be judging its own work, which is the one
   * separation the evidence model rests on.
   *
   * **It is not exempt from anything.** The budget is checked before it, the model is ranked
   * and selected and the selection journalled, the granted tool set is the read-only surface
   * the role's permitted adapters expose, the substrate's effective tool surface must equal it,
   * and the envelope goes through all eight receipt steps with its evidence replayed through
   * the originating adapters. A `d_ctx` dispatch appears in the log exactly as `d_0001` does.
   *
   * **It gets one attempt.** The graph's retry protocol lives in the run loop, which owns an
   * attempt counter and a stage cursor; the prologue has neither, and a second private retry
   * loop here would be a second implementation of a rule that already exists. A failure blocks,
   * with the reason named, and the run resumes at the same point.
   */
  private async dispatchContext(args: {
    readonly workItem: WorkItem;
    readonly context: ContextPackage;
    readonly journal: Journal;
    readonly runId: string;
    readonly budget: {
      readonly run: WorkItem['consumed_budget'];
      readonly workItem: WorkItem['consumed_budget'];
    };
    readonly runStartedAt: string;
  }): Promise<ContextDispatchOutcome> {
    const { policies, clock, store } = this.ports;
    const { journal, runId, workItem } = args;
    const stage: Stage = 'CONTEXT_DISCOVERY';
    const role: AgentRole = 'context-discovery';
    const dispatchId = 'd_ctx';

    const blocked = (
      blockerKind: BlockerKind | null,
      detail: string,
    ): ContextDispatchOutcome => ({ outcome: 'BLOCKED', blockerKind, detail });

    const spec = this.ports.agents.spec(role, 'context');
    if (spec === undefined) {
      /*
       * Fail closed. The mandate that owns criterion 1 is not registered, so nothing in this
       * run could ever supply it — and a run that proceeds to compute a Definition of Done it
       * knows in advance has no owner for one of its criteria is a run manufacturing a
       * `NOT_VALIDATED` it could have named as a configuration fault instead.
       */
      journal.run('dispatch_result', {
        outcome: 'FAILED',
        envelope_id: null,
        failure_reason: 'NO_MODEL',
        detail:
          'no Context Discovery context mandate is registered, so the only owner of criterion '
          + '1 cannot be dispatched',
        cost: { input_tokens: 0, output_tokens: 0 },
      }, { stage, dispatchId, agent: role });
      return blocked(
        'MISSING_CAPABILITY',
        'MISSING_CAPABILITY: no Context Discovery context mandate is registered. It is the only '
        + 'owner of Definition-of-Done criterion 1, so no envelope in this run could supply it',
      );
    }

    const verdict = checkDispatchBudget(
      { run: args.budget.run, workItem: args.budget.workItem, runStartedAt: args.runStartedAt },
      policies.budgets,
      clock.now(),
    );
    if (!verdict.within) {
      journal.run('budget', {
        kind: 'EXCEEDED',
        counter: verdict.counter,
        scope: verdict.scope,
        value: verdict.value,
        cap: verdict.cap,
        tried: verdict.report,
      }, { stage, dispatchId, agent: role });
      return blocked(
        'BUDGET_EXHAUSTED',
        `BUDGET_EXHAUSTED: ${verdict.counter} exhausted per ${verdict.scope} before the context `
        + `mandate could be dispatched: ${verdict.report.join('; ')}`,
      );
    }

    const model = await this.chooseModel(spec, journal, stage, false, null);
    if (model === null) {
      /*
       * Invariant 16's second case, at the stage before the graph exists. A run *does* exist
       * here — the lease is held and the log is open — so this blocks with the external
       * dependency named rather than refusing the way the pre-admission prologue does.
       */
      journal.run('dispatch_result', {
        outcome: 'FAILED',
        envelope_id: null,
        failure_reason: 'NO_MODEL',
        detail:
          'no reachable model meets the context mandate declared requirement. Proceeding '
          + 'without it would leave criterion 1 unowned and report the gap as a judgment',
        cost: { input_tokens: 0, output_tokens: 0 },
      }, { stage, dispatchId, agent: role });
      return blocked(
        'EXTERNAL_DEPENDENCY',
        'EXTERNAL_DEPENDENCY: no reachable model meets the context mandate requirement. No '
        + 'state advances, no envelope merges, and the run resumes at the same point when a '
        + 'model returns',
      );
    }

    const mandateScope: Scope = workItem.scope;
    const tools = await this.grantToolsForSpec(spec);
    const callContext: AdapterCallContext = {
      workItemId: workItem.work_item_id,
      runId,
      dispatchId,
      mandate: { in_scope: mandateScope.paths, out_of_scope: [] },
      grantsHeld: [],
      stageMutating: false,
    };

    const inputPackage: InputPackage = {
      work_item_id: workItem.work_item_id,
      run_id: runId,
      dispatch_id: dispatchId,
      agent: role,
      mandate_name: spec.mandate_name,
      stage,
      work_item_ref: '../work-item.json',
      intake_ref: null,
      workflow: null,
      context_package_ref: 'context/v1.json',
      context_sections: this.materialize(args.context, spec.required_inputs),
      capability_registry_ref: null,
      prior_envelopes: [],
      mandate: {
        objective: spec.objective,
        in_scope: mandateScope.paths,
        out_of_scope: [],
        capabilities: mandateScope.capabilities,
        advisory_notes:
          'current_reality is written by the probes and is supplied to you as an observation. '
          + 'Report what you examined and judge what it means; do not restate it as your own '
          + 'finding, and never fill a gap the probes left.',
      },
      required_inputs: spec.required_inputs,
      required_outputs: spec.required_outputs,
      dod_profile_ref: null,
      dod_criteria_owed: spec.dod_criteria_owned,
      constraints: workItem.constraints,
      authorization_scope: { autonomous: [], gated: [], grants_held: [] },
      tools_granted: tools,
      skills_available: [],
      model,
      budget: dispatchBudget(policies.budgets),
    };

    /* Write before act, as everywhere else: the intent is on disk before the agent is invoked. */
    journal.run('dispatch_intent', {
      input_package: inputPackage,
      attempt: 1,
    }, { stage, dispatchId, agent: role });

    const result = await this.ports.substrate.dispatch(inputPackage, {
      invoke: async (toolName, toolArgs) => {
        const grant = tools.find((t) => t.tool_name === toolName);
        if (grant === undefined) {
          return {
            outcome: 'REFUSED',
            refusal: 'unknown_tool',
            message:
              `${toolName} is not in this dispatch's granted tool set. The effective tool `
              + 'surface is an allowlist, and a tool outside it is absent rather than forbidden',
            abortDispatch: true,
          };
        }
        const call = await this.ports.adapters.call(grant.adapter, grant.op, toolArgs, callContext);
        journal.run('adapter_call', call.call, { stage, dispatchId, agent: role });
        if (call.outcome === 'OK') {
          for (const mutation of call.mutations) {
            journal.run('mutation', mutation, { stage, dispatchId, agent: role });
          }
          return { outcome: 'OK', value: call.value };
        }
        if (call.outcome === 'REFUSED') {
          const isSecurity = call.refusal === 'security_violation';
          journal.run(isSecurity ? 'security_violation' : 'scope_violation', {
            adapter: grant.adapter,
            op: grant.op,
            requested: typeof toolArgs['path'] === 'string' ? toolArgs['path'] : grant.op,
            resolved: null,
            rule: isSecurity ? 'deny_list' : 'mandate_in_scope',
            deny_list_entry: null,
            aborted_dispatch: isSecurity,
            detail: call.message,
          }, { stage, dispatchId, agent: role });
          return {
            outcome: 'REFUSED',
            refusal: call.refusal,
            message: call.message,
            abortDispatch: isSecurity,
          };
        }
        return { outcome: 'ERROR', message: call.message };
      },
    });

    journal.run('tool_surface_conformance', {
      substrate: this.ports.substrate.name,
      verdict: result.toolSurface?.verdict ?? 'UNVERIFIABLE',
      expected: result.toolSurface?.expected ?? tools.map((t) => t.tool_name),
      effective: result.toolSurface?.effective ?? [],
      unexpected: result.toolSurface?.unexpected ?? [],
      missing: result.toolSurface?.missing ?? [],
      detail: result.toolSurface?.detail
        ?? 'the substrate reported no tool surface, so conformance is unverifiable and the '
          + 'dispatch fails closed',
    }, { stage, dispatchId, agent: role });

    if (result.outcome === 'FAILED') {
      journal.run('dispatch_result', {
        outcome: 'FAILED',
        envelope_id: null,
        failure_reason: result.failure,
        detail: result.detail,
        cost: {
          input_tokens: result.cost.input_tokens,
          output_tokens: result.cost.output_tokens,
          usd: result.cost.usd,
        },
      }, { stage, dispatchId, agent: role });
      return blocked(
        'EXTERNAL_DEPENDENCY',
        `EXTERNAL_DEPENDENCY: the context mandate dispatch failed (${result.failure}): `
        + `${result.detail}. A FAILED envelope never satisfies an exit condition, so the `
        + 'prologue does not advance and the run resumes at the same point',
      );
    }

    if (result.toolSurface.verdict !== 'CONFORMS') {
      journal.run('dispatch_result', {
        outcome: 'ABORTED',
        envelope_id: null,
        failure_reason: 'TOOL_SURFACE_VIOLATION',
        detail: result.toolSurface.detail,
        cost: {
          input_tokens: result.cost.input_tokens,
          output_tokens: result.cost.output_tokens,
          usd: result.cost.usd,
        },
      }, { stage, dispatchId, agent: role });
      return blocked(
        'MISSING_CAPABILITY',
        'MISSING_CAPABILITY: the effective tool surface does not equal the adapter operations '
        + `the kernel exposed to the context mandate: ${result.toolSurface.detail}. The tool `
        + 'surface is an allowlist, never a denylist, and subtraction fails open',
      );
    }

    /* ---------------------------------------------- envelope receipt ---- */

    const receipt = await receiveEnvelope({
      raw: result.envelope,
      expectation: {
        dispatchId,
        stage,
        agent: role,
        requiredOutputs: spec.required_outputs,
        dodCriteriaOwed: spec.dod_criteria_owned,
        /* No graph is frozen yet. The empty stage set is the honest input to the
         * BLOCKED_BY_ARCHITECTURE legality rule: there is no ARCHITECTURE stage to route to. */
        graphStages: [],
      },
      agents: policies.agents,
      evidencePolicy: policies.evidence,
      adapters: this.ports.adapters,
      callContext,
      clock,
      mutations: this.mutationsFor(journal, runId, workItem.work_item_id, dispatchId),
      calls: this.callsFor(journal, runId, workItem.work_item_id, dispatchId),
      knownObligations: new Set(),
      existingAssertions: new Map(),
      incomingAssertions: new Map(),
      sampler: this.ports.random,
    });

    if (receipt.outcome === 'REJECTED') {
      journal.run('envelope_rejected', {
        envelope_id: null,
        step: receipt.step,
        violations: receipt.violations,
      }, { stage, dispatchId, agent: role });
      journal.run('dispatch_result', {
        outcome: receipt.handleAs === 'FAILED' ? 'FAILED' : 'ABORTED',
        envelope_id: null,
        failure_reason: receipt.handleAs === 'FAILED' ? 'MALFORMED_ENVELOPE' : null,
        detail: receipt.violations.map((v) => v.message).join('; '),
        cost: {
          input_tokens: result.cost.input_tokens,
          output_tokens: result.cost.output_tokens,
          usd: result.cost.usd,
        },
      }, { stage, dispatchId, agent: role });

      return receipt.handleAs === 'FAILED'
        ? blocked(
          'EXTERNAL_DEPENDENCY',
          'EXTERNAL_DEPENDENCY: the context mandate returned a malformed envelope. A malformed '
          + 'envelope is a FAILED dispatch, never a parse-and-repair: the kernel does not guess '
          + `what an agent meant. ${receipt.violations.map((v) => v.message).join('; ')}`,
        )
        : blocked(
          null,
          receipt.violations.map((v) => `${v.code}: ${v.message}`).join('; '),
        );
    }

    const persisted = withVerification(
      receipt.envelope, receipt.verification, clock.now().toISOString(),
    );
    store.putEnvelope(workItem.work_item_id, runId, persisted);

    journal.run('envelope_received', {
      envelope_id: persisted.envelope_id,
      status: persisted.status,
      steps: receipt.steps,
    }, { stage, dispatchId, agent: role });
    journal.run('evidence_verification', {
      envelope_id: persisted.envelope_id,
      results: receipt.verification.outcomes.map((o) => ({
        evidence_id: o.evidence_id,
        status: o.status,
        selected_because: o.selected_because,
        detail: o.detail,
      })),
      mismatch_count: receipt.verification.mismatchCount,
    }, { stage, dispatchId, agent: role });

    for (const outcome of receipt.verification.outcomes) {
      if (outcome.status !== 'MISMATCH' && outcome.status !== 'UNREPLAYABLE') continue;
      journal.run('evidence_integrity', {
        envelope_id: persisted.envelope_id,
        evidence_id: outcome.evidence_id,
        model,
        status: outcome.status,
        downgraded_assertions: receipt.verification.downgrades.map((d) => d.evidence_id),
        demoted_findings: receipt.verification.demotedFindings,
        envelope_rejected: false,
      }, { stage, dispatchId, agent: role });
    }

    for (const { conflict, resolution } of receipt.conflicts) {
      journal.run('conflict', {
        conflict_id: conflict.conflictId,
        subject: conflict.subject,
        position_a: conflict.positionA,
        position_b: conflict.positionB,
        phase: resolution.phase,
        winner: resolution.phase === 'RESOLVED_BY_RULE' ? resolution.winner : 'NONE',
        rule: resolution.phase === 'RESOLVED_BY_RULE' ? resolution.rule : null,
        detail: resolution.detail,
      }, { stage, dispatchId, agent: role });
    }

    journal.run('dispatch_result', {
      outcome: 'ENVELOPE',
      envelope_id: persisted.envelope_id,
      failure_reason: null,
      detail: '',
      cost: {
        input_tokens: result.cost.input_tokens,
        output_tokens: result.cost.output_tokens,
        usd: result.cost.usd,
      },
    }, { stage, dispatchId, agent: role });

    /*
     * A `BLOCKED` or `FAILED` envelope is an honest answer and is still not one the prologue
     * may proceed on: the mandate that owns criterion 1 reported that it could not complete,
     * and treating that as a context package would be reading a stated failure as a result.
     */
    if (persisted.status === 'BLOCKED' || persisted.status === 'FAILED') {
      const first = persisted.blockers[0];
      const kind: BlockerKind = first?.kind ?? 'EXTERNAL_DEPENDENCY';
      return blocked(
        kind,
        `${kind}: the context mandate returned ${persisted.status} — `
        + `${first?.description ?? persisted.summary}. Criterion 1 has no other owner, so the `
        + 'run stops here rather than proceeding on a package its own author reported it could '
        + 'not build',
      );
    }

    return { outcome: 'ACCEPTED', envelope: persisted };
  }

  private async dispatchOrchestrator(
    workItem: WorkItem,
    context: ContextPackage,
    journal: Journal,
    runId: string,
  ): Promise<WorkflowProposal | null> {
    const spec = this.ports.agents.spec('orchestrator', 'workflow');
    if (spec === undefined) return null;

    const model = await this.chooseModelWithoutJournal(spec);
    if (model === null) {
      journal.run('dispatch_result', {
        outcome: 'FAILED',
        envelope_id: null,
        failure_reason: 'NO_MODEL',
        detail: 'no model for the workflow selection dispatch; the fallback template applies',
        cost: { input_tokens: 0, output_tokens: 0 },
      }, { stage: 'WORKFLOW_SELECTED', agent: 'orchestrator' });
      return null;
    }

    const dispatchId = 'd_wf';
    const inputPackage: InputPackage = {
      work_item_id: workItem.work_item_id,
      run_id: runId,
      dispatch_id: dispatchId,
      agent: 'orchestrator',
      mandate_name: 'workflow',
      stage: 'WORKFLOW_SELECTED',
      work_item_ref: '../work-item.json',
      intake_ref: null,
      workflow: null,
      context_package_ref: 'context/v1.json',
      context_sections: this.materialize(context, spec.required_inputs),
      capability_registry_ref: null,
      prior_envelopes: [],
      mandate: {
        objective: spec.objective,
        in_scope: workItem.scope.paths,
        out_of_scope: [],
        capabilities: workItem.scope.capabilities,
        advisory_notes: '',
      },
      required_inputs: spec.required_inputs,
      required_outputs: spec.required_outputs,
      dod_profile_ref: null,
      dod_criteria_owed: [],
      constraints: workItem.constraints,
      authorization_scope: { autonomous: [], gated: [], grants_held: [] },
      /* The Orchestrator Agent holds no adapters. The component that judges evidence must
       * not also manufacture it, so its granted tool set is empty. */
      tools_granted: [],
      skills_available: [],
      model,
      budget: dispatchBudget(this.ports.policies.budgets),
    };

    journal.run('dispatch_intent', {
      input_package: inputPackage, attempt: 1,
    }, { stage: 'WORKFLOW_SELECTED', dispatchId, agent: 'orchestrator' });

    const result = await this.ports.substrate.dispatch(inputPackage, {
      invoke: () => Promise.resolve({
        outcome: 'REFUSED' as const,
        refusal: 'unknown_tool',
        message:
          'the Orchestrator Agent holds no adapters. The component that judges evidence must '
          + 'not also manufacture it',
        abortDispatch: true,
      }),
    });

    if (result.outcome === 'FAILED') {
      journal.run('dispatch_result', {
        outcome: 'FAILED',
        envelope_id: null,
        failure_reason: result.failure,
        detail: result.detail,
        cost: {
          input_tokens: result.cost.input_tokens,
          output_tokens: result.cost.output_tokens,
          usd: result.cost.usd,
        },
      }, { stage: 'WORKFLOW_SELECTED', dispatchId, agent: 'orchestrator' });
      return null;
    }

    const envelope = result.envelope as HandoffEnvelope | null;
    journal.run('dispatch_result', {
      outcome: 'ENVELOPE',
      envelope_id: envelope?.envelope_id ?? null,
      failure_reason: null,
      detail: '',
      cost: {
        input_tokens: result.cost.input_tokens,
        output_tokens: result.cost.output_tokens,
        usd: result.cost.usd,
      },
    }, { stage: 'WORKFLOW_SELECTED', dispatchId, agent: 'orchestrator' });

    return envelope?.proposals.workflow ?? null;
  }

  /* ---------------------------------------------------------------- support ==== */

  private materialize(
    context: ContextPackage,
    sections: readonly ContextSectionName[],
  ): Readonly<Record<string, unknown>> {
    /*
     * `required_inputs` bounds what is materialized. An agent declares which sections it
     * needs and the kernel builds only those, which is what keeps input size independent of
     * run length: the package grows, the dispatch does not.
     */
    const out: Record<string, unknown> = {};
    const record = context as unknown as Record<string, unknown>;
    for (const section of sections) {
      if (section in record) out[section] = record[section];
    }
    return out;
  }

  private async chooseModel(
    spec: AgentSpecView,
    journal: Journal,
    stage: Stage,
    escalate: boolean,
    previousModel: string | null,
  ): Promise<string | null> {
    const entries = await this.ports.registries.models();
    /*
     * **The registries rank; the kernel selects.** The ordered candidate list with its scores
     * and reasons comes from `@agentos/registries`, which is where the criteria live as
     * data-driven scoring; the kernel applies its policy filters to that list, picks, and
     * records the choice. Building the list here with `score: 0` made selection "the first
     * candidate that passes the filters" and left every ranking criterion — capability match,
     * specificity, cost, reliability, safety — with no effect at all.
     */
    const ranked = rankModels(entries, spec.model_requirement);
    const selection = selectModel({
      ranked,
      entries,
      requirement: spec.model_requirement,
      preference: null,
      escalate,
      previousModel,
      escalationTrigger: escalate ? 'the previous dispatch failed' : null,
    });
    journal.run('selection', {
      kind: 'MODEL',
      selected: selection.selected,
      candidates: selection.candidates,
      why: selection.why,
      escalated_from: selection.escalatedFrom,
      escalation_trigger: selection.escalationTrigger,
    }, { stage, agent: spec.role });
    return selection.selected;
  }

  private async chooseModelWithoutJournal(spec: AgentSpecView): Promise<string | null> {
    const entries = await this.ports.registries.models();
    const ranked = rankModels(entries, spec.model_requirement);
    return selectModel({
      ranked,
      entries,
      requirement: spec.model_requirement,
      preference: null,
      escalate: false,
      previousModel: null,
      escalationTrigger: null,
    }).selected;
  }

  private async grantSkills(
    spec: AgentSpecView,
    descriptor: StageDescriptor,
    journal: Journal,
    stage: Stage,
  ): Promise<readonly SkillOffer[]> {
    const entries = await this.ports.registries.skills();
    /*
     * The ranking is the registry's and the classification is the kernel's: an agent that
     * could widen its own operation set to `mutate` would be choosing its own risk class,
     * which is the one dimension the document takes away from it explicitly.
     */
    const ranked = rankSkills(entries, classifyDispatch(spec, descriptor));
    const selection = selectSkills({
      ranked,
      entries,
      stageMutating: descriptor.mutating,
      agent: spec.role,
      preference: [],
    });
    for (const violation of selection.violations) {
      journal.run('contract_violation', violation, { stage, agent: spec.role });
    }
    journal.run('selection', {
      kind: 'SKILL',
      selected: selection.offers.map((o) => o.id).join(', ') || null,
      candidates: [...selection.excluded],
      why:
        `${selection.offers.length} selectable, ${selection.excluded.length} excluded. A skill `
        + 'that can spawn an agent is never selectable, and undetermined spawning behaviour '
        + 'counts as spawning',
      escalated_from: null,
      escalation_trigger: null,
    }, { stage, agent: spec.role });
    return selection.offers;
  }

  private async grantTools(
    spec: AgentSpecView,
    descriptor: StageDescriptor,
  ): Promise<readonly ToolGrant[]> {
    const grants = await this.grantToolsForSpec(spec);
    /* A non-mutating stage is granted no mutating operation, whatever the role permits. */
    if (descriptor.mutating) return grants;
    return grants.filter((grant) => {
      const operation = this.ports.adapters.descriptor(grant.adapter, grant.op);
      return operation !== undefined && !operation.mutating;
    });
  }

  private async grantToolsForSpec(spec: AgentSpecView): Promise<readonly ToolGrant[]> {
    const permitted = new Set(spec.permitted_adapters);
    return Promise.resolve(
      this.ports.adapters
        .descriptors()
        .filter((operation) => permitted.has(operation.adapter.split('.')[0] ?? operation.adapter))
        .filter((operation) => !operation.mutating || !spec.read_only)
        .map((operation) => ({
          adapter: operation.adapter,
          op: operation.op,
          tool_name: `${operation.adapter.replace(/\./g, '_')}__${operation.op}`,
          description: operation.description,
          args_schema: operation.args_schema,
        })),
    );
  }

  private callContext(
    state: { readonly workItem: WorkItem },
    dispatchId: string,
    scope: Scope,
  ): AdapterCallContext {
    return {
      workItemId: state.workItem.work_item_id,
      runId: state.workItem.lease?.run_id ?? 'unknown',
      dispatchId,
      mandate: { in_scope: scope.paths, out_of_scope: [] },
      grantsHeld: [],
      stageMutating: false,
    };
  }

  /**
   * The stage cursor as the log says it stands right now.
   *
   * Rebuilt by `project()` — the same function recovery and `run.json` use — rather than by a
   * second cursor carried in the loop. Two notions of "which stages are done" would drift the
   * moment one of them learned something the other did not, and the one that would drift is
   * the in-memory one: the log is what survives a crash. So the input package's
   * `stages_remaining` is derived from the same projection a recovering kernel would rebuild,
   * and an agent's read-only view of the workflow agrees with the run record by construction.
   *
   * It was `stagesRemaining([], graph)` — a hard-coded empty cursor, which filters nothing, so
   * every dispatch was told every stage was still outstanding: stages this run had already
   * completed, stages the resume sweep had marked COMPLETED_PRIOR, all of them.
   */
  private cursorNow(workItemId: string, runId: string): readonly StageCursorEntry[] {
    return project(this.ports.store.readRunLog(workItemId, runId).records).cursor;
  }

  private mutationsFor(
    _journal: Journal,
    runId: string,
    workItemId: string,
    dispatchId: string,
  ): readonly MutationEvent[] {
    const log = this.ports.store.readRunLog(workItemId, runId);
    return log.records
      .filter((e): e is Extract<Event, { event: 'mutation' }> => e.event === 'mutation')
      .filter((e) => e.data.dispatch_id === dispatchId)
      .map((e) => e.data);
  }

  private callsFor(
    _journal: Journal,
    runId: string,
    workItemId: string,
    dispatchId: string,
  ): readonly CallRecord[] {
    const log = this.ports.store.readRunLog(workItemId, runId);
    return log.records
      .filter((e): e is Extract<Event, { event: 'adapter_call' }> => e.event === 'adapter_call')
      .filter((e) => e.data.dispatch_id === dispatchId)
      .map((e) => e.data);
  }

  /** The downstream obligations an `unknowns[].blocks` entry may name. */
  private obligations(graph: FrozenGraph): ReadonlySet<string> {
    const out = new Set<string>();
    for (const stage of graph.stages) {
      out.add(stage.toLowerCase());
      const descriptor = this.ports.policies.stages.get(stage);
      for (const output of descriptor?.required_outputs ?? []) out.add(output);
      for (const criterion of descriptor?.dod_criteria ?? []) out.add(`criterion.${criterion}`);
    }
    out.add('validation.production');
    return out;
  }

  private fallbackSpec(
    role: AgentRole,
    descriptor: StageDescriptor,
  ): AgentSpecView {
    return {
      role,
      mandate_name: descriptor.stage.toLowerCase(),
      version: '0',
      objective: descriptor.exit_condition,
      required_inputs: ['repository', 'current_reality'],
      required_outputs: descriptor.required_outputs,
      permitted_adapters: ['repo', 'git'],
      read_only: !descriptor.mutating,
      dod_criteria_owned: descriptor.dod_criteria,
      model_requirement: {
        context: 'medium',
        reasoning: 'mid',
        coding: false,
        vision: false,
        tool_use: 'strong',
        precision: 'standard',
      },
    };
  }

  private nextIntakeNumber(): number {
    return this.ports.store.listWorkItems().length + 1;
  }

  private loadWorkItems(): readonly WorkItem[] {
    const out: WorkItem[] = [];
    for (const id of this.ports.store.listWorkItems()) {
      const item = this.ports.store.getWorkItem(id);
      if (item !== null) out.push(item);
    }
    return out;
  }

  private refuse(
    intakeId: string,
    prologue: readonly Event[],
    detail: string,
    checks: readonly CheckOutcome[],
  ): RunResult {
    return {
      outcome: 'REFUSED',
      workItemId: null,
      runId: null,
      detail,
      narrative: narrate(prologue, null).text,
      checks,
      blockerKind: null,
    };
  }

  /**
   * The prologue's other ending: the request was admissible and the world was not.
   *
   * Distinct from `refuse` because the two are different answers (decision I-31). A refusal
   * says the request cannot be admitted and a fresh attempt at the same request will fail the
   * same way; a block says nothing is wrong with the request and the run resumes when the
   * dependency returns. No Work Item was admitted and no run was started, so there is no run
   * log to end — but the outcome and its blocker kind still travel to the caller, which is
   * what keeps "the ticket system is down" from reaching a script as "your request was
   * inadmissible".
   */
  private block(
    prologue: readonly Event[],
    blockerKind: BlockerKind,
    detail: string,
    checks: readonly CheckOutcome[],
  ): RunResult {
    return {
      outcome: 'BLOCKED',
      workItemId: null,
      runId: null,
      detail,
      narrative: narrate(prologue, null).text,
      checks,
      blockerKind,
    };
  }

  private end(
    journal: Journal,
    workItem: WorkItem,
    runId: string,
    outcome: RunOutcome,
    detail: string,
    lifecycle: WorkItem['lifecycle'],
    checks: readonly CheckOutcome[],
    blockerKind: BlockerKind | null = null,
  ): { readonly result: RunResult; readonly workItem: WorkItem } {
    journal.both('run_ended', { outcome, detail }, { stage: 'COMPLETION' });

    const updated: WorkItem = { ...workItem, lifecycle, lease: null };
    this.ports.store.putWorkItemProjection(updated);

    const log = this.ports.store.readRunLog(workItem.work_item_id, runId);
    const projection = project(log.records);
    if (projection.graph !== null) {
      this.ports.store.putRunProjection(
        runRecord(workItem.work_item_id, runId, projection, this.ports.clock),
      );
    }

    return {
      result: {
        outcome,
        workItemId: workItem.work_item_id,
        runId,
        detail,
        narrative: narrate(log.records, updated).text,
        checks,
        blockerKind: outcome === 'BLOCKED' ? blockerKind : null,
      },
      workItem: updated,
    };
  }

  /* ---------------------------------------------------------- observability ==== */

  /** `agentos status` — the live view, a projection over the log. */
  status(workItemId: string, runId?: string): readonly string[] {
    const { store } = this.ports;
    const workItem = store.getWorkItem(workItemId);
    const runs = store.listRuns(workItemId);
    const target = runId ?? runs[runs.length - 1];
    if (target === undefined) {
      return workItem === null
        ? [`no work item ${workItemId}`]
        : workItemView(workItem, store.readWorkItemLog(workItemId).records);
    }
    const log = store.readRunLog(workItemId, target);
    return [
      ...(workItem === null ? [] : workItemView(workItem, store.readWorkItemLog(workItemId).records)),
      '',
      ...liveView(project(log.records), log.records, workItem),
    ];
  }

  /** `agentos narrate` — the run narrative, generated from the event log. */
  narrate(workItemId: string, runId?: string): string {
    const { store } = this.ports;
    const workItem = store.getWorkItem(workItemId);
    const runs = store.listRuns(workItemId);
    const target = runId ?? runs[runs.length - 1];
    if (target === undefined) return `no run recorded against ${workItemId}`;
    return narrate(store.readRunLog(workItemId, target).records, workItem).text;
  }

  /**
   * Recovers a run from its log.
   *
   * Replay, rebuild the cursor, identify any dispatch interrupted mid-flight, and apply the
   * retry protocol. The frozen graph is replayed, never recomputed: re-selecting a workflow
   * on recovery would make recovery depend on a model.
   */
  recoverRun(workItemId: string, runId: string): {
    readonly projection: Projection;
    readonly detail: readonly string[];
  } {
    const journal = Journal.open(this.ports.store, this.ports.clock, { workItemId, runId });
    const detail: string[] = [];

    const outcome = recover(this.ports.store, workItemId, runId, (bytes, text) => {
      /*
       * Written to the **work item** log, not the run log.
       *
       * The discard has to be recorded before the repair, so that a crash during the repair
       * leaves a record that a repair was in progress. It cannot be recorded in the log being
       * repaired: that log ends in a partial line, and appending to it would join the new
       * record onto the torn one and produce a corrupt line in the middle of the file, where
       * recovery never looks. The work item outlives the run, which makes its log the right
       * place for "this run's log needed repairing".
       */
      journal.workItem('recovery', {
        phase: 'PARTIAL_LINE_DISCARDED',
        replayed_events: 0,
        discarded_bytes: bytes,
        interrupted_dispatch: null,
        detail:
          `a trailing partial line of ${bytes} byte(s) was discarded from run ${runId}: `
          + `${text.slice(0, 60)}. A partial line is never parsed, and never silently dropped`,
      }, { stage: null });
      detail.push(`discarded a partial line of ${bytes} byte(s)`);
    });

    journal.run('recovery', {
      phase: 'STARTED',
      replayed_events: outcome.replayedEvents,
      discarded_bytes: outcome.discardedBytes,
      interrupted_dispatch: outcome.interruptedDispatch,
      detail:
        'recovery replays the log rather than resuming from memory, and never re-derives the '
        + 'entry stage: the frozen graph and the cursor already say where the run was',
    }, { stage: outcome.projection.currentStage });

    if (outcome.retry !== null && outcome.interruptedDispatch !== null) {
      journal.run('recovery', {
        phase: 'INTERRUPTED_DISPATCH_FOUND',
        replayed_events: outcome.replayedEvents,
        discarded_bytes: 0,
        interrupted_dispatch: outcome.interruptedDispatch,
        detail: outcome.retry.reason,
      }, { stage: outcome.projection.currentStage });
      detail.push(outcome.retry.reason);
    }

    journal.run('recovery', {
      phase: 'COMPLETED',
      replayed_events: outcome.replayedEvents,
      discarded_bytes: outcome.discardedBytes,
      interrupted_dispatch: outcome.interruptedDispatch,
      detail: `the cursor is rebuilt at ${outcome.projection.currentStage}`,
    }, { stage: outcome.projection.currentStage });

    detail.push(
      `replayed ${outcome.replayedEvents} event(s); the cursor is at `
      + outcome.projection.currentStage,
    );

    return { projection: outcome.projection, detail };
  }

  /** The risk class a template would produce, for the CLI's dry explanation. */
  riskClassOf(stages: readonly TemplateStage[]): string {
    return deriveRiskClass(stages, this.ports.policies).riskClass;
  }

  /** Where the cursor says a recovered run is. */
  stageOf(graph: FrozenGraph, cursor: Parameters<typeof stageFromCursor>[0]): Stage {
    return stageFromCursor(cursor, graph);
  }

  /** An assertion the kernel itself makes, for the reality set it derives. */
  static kernelAssertion(value: unknown, at: string): Assertion {
    return {
      value,
      confidence: 'FACT',
      evidence: [],
      observed_at: at,
      probe: 'kernel',
      freshness: 'CURRENT',
    };
  }
}
