import {
  runId as makeRunId,
  sequentialId,
  type AdapterCallContext,
  type AdapterRegistry,
  type AgentCatalog,
  type AgentRole,
  type AgentSpecView,
  type AgentSubstrate,
  type Assertion,
  type CallRecord,
  type CapabilityRecord,
  type CheckOutcome,
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
  type Registries,
  type RunOutcome,
  type Scope,
  type SkillOffer,
  type Stage,
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
import { computeUnderstood } from './understood.js';
import { admitWorkflow, deriveRiskClass } from './workflow-admission.js';
import { computeEntryStage, stagesRemaining, stageFromCursor } from './entry-stage.js';
import { PredicateEvaluator, type PredicateInputs } from './predicates.js';
import { decideAction, type KernelAction, type TransitionContext } from './state-machine.js';
import { receiveEnvelope, withVerification } from './receipt.js';
import { computeDod, effectiveProfile } from './dod.js';
import { compareSourceDrift, recordIntake } from './intake.js';
import { project, recover, runRecord, type Projection } from './recovery.js';
import { ZERO_BUDGET, addCost, checkDispatchBudget, dispatchBudget, incrementLoop, reresolutionAllowed } from './budgets.js';
import { selectModel, selectSkills } from './selection.js';
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

type PrologueLogger = <K extends Event['event']>(
  kind: K,
  data: Extract<Event, { event: K }>['data'],
  stage: Stage,
) => void;

interface DispatchOutcome {
  readonly envelope: HandoffEnvelope | null;
  readonly action: KernelAction | null;
  readonly failed: boolean;
  readonly detail: string;
}

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
    const { record, attempts } = recordIntake(
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

    const admission = admitWorkItem({
      intake: record,
      proposal: resolution.proposal,
      policies,
      context: orientation,
      capabilities: [],
      identity,
      existing: this.loadWorkItems(),
      access: this.ports.access,
      now: clock.now().toISOString(),
    });
    checks.push(...admission.checks);

    if (admission.outcome === 'BLOCKED') {
      logPrologue(
        'work_item_rejected',
        { checks: admission.checks, attempt: 1, next: 'BLOCKED' },
        'RESOLUTION',
      );
      return this.refuse(intakeId, prologue, admission.reason, checks);
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
      const retry = admitWorkItem({
        intake: record,
        proposal: second.proposal,
        policies,
        context: orientation,
        capabilities: [],
        identity,
        existing: this.loadWorkItems(),
        access: this.ports.access,
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
      return this.continueWithWorkItem(retry.workItem, record, orientation, prologue, input, checks, retry.typeDowngraded);
    }

    return this.continueWithWorkItem(
      admission.workItem,
      record,
      orientation,
      prologue,
      input,
      checks,
      admission.typeDowngraded,
    );
  }

  /* ---------------------------------------------------------- the work item ==== */

  private async continueWithWorkItem(
    workItem: WorkItem,
    intake: IntakeRecord,
    orientation: ContextPackage,
    prologue: readonly Event[],
    input: StartInput,
    checks: CheckOutcome[],
    typeDowngraded: boolean,
  ): Promise<RunResult> {
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

    try {
      const outcome = await this.runGraph(
        workItemState,
        intake,
        orientation,
        journal,
        runId,
        input,
        checks,
      );
      workItemState = outcome.workItem;
      return outcome.result;
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
  }

  /* ------------------------------------------------------------- the graph ==== */

  private async runGraph(
    workItem: WorkItem,
    intake: IntakeRecord,
    orientation: ContextPackage,
    journal: Journal,
    runId: string,
    input: StartInput,
    checks: CheckOutcome[],
  ): Promise<{ readonly result: RunResult; readonly workItem: WorkItem }> {
    const { store, policies, clock } = this.ports;
    const evaluator = new PredicateEvaluator(policies, clock, this.ports.discovery);

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

    const capabilities: CapabilityRecord[] = [];
    const predicateInputs: PredicateInputs = {
      context: deepened,
      workItem,
      capabilities,
      mutations: [],
      claim: null,
    };

    /* --------------------------------------------------- UNDERSTOOD ---- */

    evaluator.freshen();
    const understood = await computeUnderstood({
      workItem,
      policies,
      context: deepened,
      evaluator,
      predicateInputs,
      access: this.ports.access,
      resolutionConfidence: 1,
      ladderApplied: false,
    });
    journal.run('understood_computed', {
      verdict: understood.verdict,
      conditions: understood.conditions,
      undetermined_predicates: understood.undeterminedPredicates,
    }, { stage: 'UNDERSTOOD' });
    checks.push(...understood.conditions);

    let lifecycle = workItem.lifecycle;
    if (understood.verdict === 'SUFFICIENT') {
      journal.both('work_item_lifecycle', {
        from: lifecycle,
        to: 'UNDERSTOOD',
        reason: 'the workflow decision is determinate',
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
  }): Promise<{ readonly result: RunResult; readonly workItem: WorkItem }> {
    const { policies, clock, store } = this.ports;
    const { journal, graph, runId } = state;

    const envelopes: HandoffEnvelope[] = [];
    const loopCounters: Record<string, number> = {};
    let budget = { run: ZERO_BUDGET, workItem: state.workItem.consumed_budget };
    let dispatchNumber = 0;
    let attemptInStage = 0;
    let escalatedThisStage = false;
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
        return this.complete(state, envelopes, budget);
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

      const action = outcome.action;
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
            'BLOCKED', state.checks,
          );

        case 'RERESOLVE': {
          const allowance = reresolutionAllowed(
            state.workItem.reresolution_count, policies.budgets,
          );
          journal.both('reresolved', {
            reason: action.reason,
            evidence: action.evidence,
            count: state.workItem.reresolution_count + 1,
            cap: allowance.cap,
            new_run_id: null,
          }, { stage });
          if (!allowance.allowed) {
            return this.end(
              journal, state.workItem, runId, 'BLOCKED', allowance.reason,
              'BLOCKED', state.checks,
            );
          }
          state.workItem = {
            ...state.workItem,
            reresolution_count: state.workItem.reresolution_count + 1,
          };
          store.putWorkItemProjection(state.workItem);
          return this.end(
            journal, state.workItem, runId, 'RERESOLVED',
            `${action.reason}. The run ends honestly and a new one starts against the same `
            + 'Work Item: identity, history and every prior envelope survive, and only the '
            + 'graph is new',
            state.workItem.lifecycle, state.checks,
          );
        }

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
  ): Promise<{ readonly result: RunResult; readonly workItem: WorkItem }> {
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

    if (verdict === 'INCOMPLETE' && dod.report.route_back_to !== null) {
      /*
       * The cursor has no authority over completion. A skipped stage supplied no verdicts, so
       * its criteria are NOT_VALIDATED, so COMPLETION computes INCOMPLETE and routes back to
       * the stage that owes them. A wrong resume costs a lap; it cannot manufacture a
       * COMPLETE.
       */
      journal.run('transition', {
        from: 'COMPLETION',
        to: dod.report.route_back_to,
        trigger: `INCOMPLETE: criteria ${dod.report.unmet_critical.join(', ')} are not met`,
        edge_kind: 'loop',
        proposed_by: null,
        proposed_stage: null,
        overridden: false,
        evidence: [],
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

    return this.end(
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
    );
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
        stages_remaining: stagesRemaining([], state.graph),
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
  ): Promise<{ readonly proposal: ProposedWorkItem | null; readonly detail: string }> {
    const spec = this.ports.agents.spec('context-discovery', 'resolution');
    if (spec === undefined) {
      return { proposal: null, detail: 'no Context Discovery resolution mandate is registered' };
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
      return { proposal: null, detail: 'no model available for resolution' };
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
      return { proposal: null, detail: result.detail };
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
      detail: proposal === null ? 'the resolution envelope carried no work_item proposal' : '',
    };
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
    const ranked = entries.map((entry) => ({
      id: entry.id,
      score: 0,
      reasons: [`reasoning ${entry.reasoning}, precision ${entry.precision_class}`],
      excluded_because: null,
    }));
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
    const ranked = entries.map((entry) => ({
      id: entry.id,
      score: 0,
      reasons: [`reasoning ${entry.reasoning}`],
      excluded_because: null,
    }));
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
    const ranked = entries.map((entry) => ({
      id: entry.id,
      score: 0,
      reasons: [entry.description],
      excluded_because: null,
    }));
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
