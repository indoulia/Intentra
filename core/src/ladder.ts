import {
  READ_ONLY_STAGES,
  type PredicateValue,
  type ResolutionAlternative,
  type TemplateStage,
  type UnknownRecord,
  type WorkItem,
  type WorkItemType,
  type WorkflowTemplate,
} from '@agentos/contracts';
import type { PolicySet } from '@agentos/policies';
import type { UnderstoodVerdict } from './understood.js';

/**
 * The uncertainty ladder — kernel-driven, ordered by cost, each rung attempted before the
 * next (INTENT_AND_WORK_ITEM_RESOLUTION section 7).
 *
 * ```
 * 1 Proceed              type admissible on its evidence, reality determinate
 * 2 Discover             something nameable would settle it: dispatch that probe
 * 3 Common safe prefix   the candidates share a non-mutating prefix: run it, re-resolve after
 * 4 Ask                  one question, both readings, and what AgentOS would do under each
 * 5 Block                no answer inside the window: BLOCKED with AMBIGUOUS_GOAL
 * ```
 *
 * Three properties are the point of it, and each is enforced here rather than described:
 *
 * - **Rung 2 cannot spin.** Every probe is counted against `budgets.loops.discovery`, per run
 *   *and* per work item, and the rung ends when the budget does.
 * - **Rung 4 is a discrimination, never a briefing.** The question is built from
 *   `alternatives[].reading` and `.would_do`, so a human is asked to choose between readings
 *   AgentOS has already evidenced — not to supply context AgentOS could discover, which would
 *   violate principle 1. A proposal carrying no alternatives cannot produce a question, and
 *   the ladder falls to rung 5 rather than inventing one.
 * - **Silence is never consent.** No answer inside `budgets.question_window_ms` is `BLOCKED`
 *   with `AMBIGUOUS_GOAL`, and the run resumes in place when an answer arrives.
 *
 * And the escalation override, which sits above every rung: where the ambiguity is between
 * "this is routine" and "this is an incident", the readings differ in *urgency* and not only
 * in workflow, so the safer reading is the one that reaches a human sooner. The ladder does
 * not manufacture the `INCIDENT` type — a type still has to earn its evidence minimum — it
 * skips the rungs that would proceed without asking.
 */

export type Rung = 'PROCEED' | 'DISCOVER' | 'SAFE_PREFIX' | 'ASK' | 'BLOCK';

/** One reading a human is asked to discriminate between. */
export interface LadderReading {
  readonly reading: string;
  readonly evidence: readonly string[];
  readonly would_do: string;
}

/** A probe rung 2 dispatches, named by the `UNKNOWN` that would be recovered by it. */
export interface LadderProbe {
  readonly gapId: string;
  readonly subject: string;
  /** The `recoverable_by` of the `UNKNOWN`. What would settle it, in its own words. */
  readonly recoverableBy: string;
  readonly blocks: readonly string[];
}

export interface LadderDiscovery {
  /** True where the probe ran. False where it was unavailable, which is not a failure. */
  readonly ran: boolean;
  /** True where the gap is settled now. */
  readonly settled: boolean;
  readonly detail: string;
}

export interface LadderStep {
  readonly rung: Rung;
  readonly outcome: 'ATTEMPTED' | 'SUCCEEDED' | 'UNAVAILABLE' | 'EXHAUSTED' | 'SKIPPED';
  readonly detail: string;
}

export interface LadderPorts {
  /** Rung 2. Dispatches the recovery an `UNKNOWN` names. */
  readonly discover: (probe: LadderProbe) => Promise<LadderDiscovery>;
  /** Rung 4. Returns the answer, or `null` where nobody answered inside the window. */
  readonly ask: (question: string, readings: readonly LadderReading[]) => Promise<string | null>;
  /** Every rung attempted is recorded, including the ones that changed nothing. */
  readonly record: (step: LadderStep) => void;
}

export interface LadderInput {
  readonly workItem: WorkItem;
  readonly policies: PolicySet;
  /** The verdict that sent the run here. `SUFFICIENT` means rung 1 and no ladder at all. */
  readonly understood: UnderstoodVerdict;
  /** Gaps blocking a mandatory obligation, from the Context Package. */
  readonly gaps: readonly UnknownRecord[];
  readonly resolutionConfidence: number;
  readonly alternatives: readonly ResolutionAlternative[];
  /**
   * The candidate templates rung 3 intersects.
   *
   * Not the admitted type's admissible set: the ambiguity the ladder exists for is about
   * *which reading is right*, so the candidates are the templates admissible for the admitted
   * type **and for every surviving alternative's type**. That is what scenario I intersects —
   * `defect.standard`, `investigation.readonly` and `change_request.land` — and intersecting
   * one type's set alone would answer a question nobody asked.
   */
  readonly admissibleTemplates: readonly WorkflowTemplate[];
  /** Discovery loops already consumed, per run and per work item. */
  readonly discoveryLoops: { readonly run: number; readonly workItem: number };
  readonly ports: LadderPorts;
}

export type LadderResult =
  | {
    /** Rung 1. Nothing was undetermined, so no rung ran. */
    readonly rung: 'PROCEED';
    readonly steps: readonly LadderStep[];
    readonly handled: readonly string[];
    readonly probesDispatched: number;
    readonly detail: string;
  }
  | {
    /** Rung 2 settled it, or recorded a handling for every blocking gap. */
    readonly rung: 'DISCOVER';
    readonly steps: readonly LadderStep[];
    /** Gap ids the ladder recorded a handling for, for `UNDERSTOOD` condition 4. */
    readonly handled: readonly string[];
    readonly probesDispatched: number;
    readonly detail: string;
  }
  | {
    /**
     * Rung 3. The run executes this prefix and re-resolves at its exit — which is how AgentOS
     * acts under uncertainty without guessing: it does the part that is the same whichever
     * answer is right.
     */
    readonly rung: 'SAFE_PREFIX';
    readonly steps: readonly LadderStep[];
    readonly handled: readonly string[];
    readonly probesDispatched: number;
    readonly prefix: readonly TemplateStage[];
    readonly detail: string;
  }
  | {
    /** Rung 4. A human discriminated. */
    readonly rung: 'ASK';
    readonly steps: readonly LadderStep[];
    readonly handled: readonly string[];
    readonly probesDispatched: number;
    readonly question: string;
    readonly readings: readonly LadderReading[];
    readonly answer: string;
    readonly detail: string;
  }
  | {
    /** Rung 5. Silence is never consent. */
    readonly rung: 'BLOCK';
    readonly steps: readonly LadderStep[];
    readonly handled: readonly string[];
    readonly probesDispatched: number;
    readonly blockerKind: 'AMBIGUOUS_GOAL';
    readonly question: string | null;
    readonly readings: readonly LadderReading[];
    readonly detail: string;
  };

/* --------------------------------------------------------- the escalation override ---- */

/**
 * Is the ambiguity between "this is routine" and "this is an incident"?
 *
 * Those readings differ in urgency and not only in workflow, so the safer one is the one that
 * reaches a human sooner. It applies at any rung, and it does not upgrade the type: `INCIDENT`
 * still requires a runtime or production observation, and nobody declares an incident by
 * writing the word — or, here, by listing it as an alternative.
 */
export function escalationOverride(
  admittedType: WorkItemType,
  alternatives: readonly ResolutionAlternative[],
): { readonly escalate: boolean; readonly reason: string } {
  const types = new Set<WorkItemType>([admittedType, ...alternatives.map((a) => a.type)]);
  if (!types.has('INCIDENT')) {
    return { escalate: false, reason: 'no candidate reading is an INCIDENT' };
  }
  if (types.size === 1) {
    return {
      escalate: false,
      reason: 'every candidate reading is an INCIDENT, so there is no routine/incident ambiguity',
    };
  }
  return {
    escalate: true,
    reason:
      'the candidate readings span routine and incident. Those differ in urgency and not only '
      + 'in workflow, so the safer reading is the one that reaches a human sooner: the rungs '
      + 'that would proceed without asking are skipped',
  };
}

/* ------------------------------------------------------------ rung 3, mechanically ---- */

/**
 * The longest common prefix of the candidate templates' stage sequences, truncated at the
 * first stage that is not declared non-mutating.
 *
 * The declared stage order *is* the run order from the entry node
 * ([decision I-17](../../docs/IMPLEMENTATION_DECISIONS.md)), so intersecting the declared
 * sequences is intersecting the sequences from the entry.
 *
 * **On the documented example.** Section 7 says the prefix "in practice" is
 * `CONTEXT_DISCOVERY → AUDIT`. `CONTEXT_DISCOVERY` is a *prologue* stage — kernel-owned, in
 * every run, and excluded from `templateStage` by construction — so no intersection of
 * template stage sequences can ever produce it. The mechanism the same paragraph states is
 * over template stages, and that is what this implements: for the scenario-I candidates
 * (`defect.standard`, `investigation.readonly`, `change_request.land`) it yields the prefix
 * the scenario actually runs. See decision I-21.
 */
export function commonSafePrefix(
  templates: readonly WorkflowTemplate[],
  policies: PolicySet,
): {
    readonly prefix: readonly TemplateStage[];
    readonly common: readonly TemplateStage[];
    readonly reason: string;
  } {
  if (templates.length === 0) {
    return { prefix: [], common: [], reason: 'no candidate templates to intersect' };
  }

  const first = templates[0];
  if (first === undefined) {
    return { prefix: [], common: [], reason: 'no candidate templates to intersect' };
  }

  const common: TemplateStage[] = [];
  for (let i = 0; i < first.stages.length; i += 1) {
    const stage = first.stages[i];
    if (stage === undefined) break;
    if (!templates.every((template) => template.stages[i] === stage)) break;
    common.push(stage);
  }

  const prefix: TemplateStage[] = [];
  for (const stage of common) {
    const descriptor = policies.stages.get(stage);
    /*
     * Non-mutating is read from the stage descriptor, and an undeclared stage counts as
     * mutating: the prefix is admitted only if every stage in it is *declared* non-mutating,
     * so "we could not tell" ends the prefix rather than extending it.
     */
    const nonMutating = descriptor !== undefined && !descriptor.mutating
      && READ_ONLY_STAGES.includes(stage);
    if (!nonMutating) break;
    prefix.push(stage);
  }

  return {
    prefix,
    common,
    reason: prefix.length === 0
      ? common.length === 0
        ? `the ${templates.length} candidate templates share no prefix from the entry node`
        : `the candidates share ${common.join(' -> ')}, and ${String(common[0])} is not `
          + 'declared non-mutating, so no part of the shared prefix can be admitted under '
          + 'ambiguity'
      : `${prefix.join(' -> ')} is shared by all ${templates.length} candidates and every `
        + 'stage in it is declared non-mutating, so the ambiguity does not yet matter: '
        + 'AgentOS does the part that is the same whichever answer is right',
  };
}

/* ------------------------------------------------------------ rung 4, mechanically ---- */

/**
 * Builds the one question rung 4 asks.
 *
 * The admitted reading is one of the candidates — a question offering only the rejected ones
 * would be a question with no right answer — and every reading carries its evidence and what
 * AgentOS would do under it. `why_rejected` alone cannot be turned into that question, which
 * is why `alternatives[]` carries `reading` and `would_do`.
 */
export function discriminatingQuestion(
  workItem: WorkItem,
  alternatives: readonly ResolutionAlternative[],
  policies: PolicySet,
  undetermined: readonly string[],
): { readonly question: string; readonly readings: readonly LadderReading[] } | null {
  if (alternatives.length === 0) return null;

  const readings: LadderReading[] = [
    {
      reading: `${workItem.type}: ${workItem.desired_outcome}`,
      evidence: workItem.candidate_dod_profiles.map((p) => `profile:${p}`),
      would_do: wouldDo(workItem.type, policies),
    },
    ...alternatives.map((alternative) => ({
      reading: `${alternative.type}: ${alternative.reading}`,
      evidence: [],
      would_do: alternative.would_do !== undefined && alternative.would_do.trim().length > 0
        ? alternative.would_do
        : wouldDo(alternative.type, policies),
    })),
  ];

  const question = [
    `AgentOS resolved "${workItem.title}" as ${workItem.type} and cannot discriminate between `
    + `${readings.length} readings on the evidence it has.`,
    undetermined.length === 0
      ? ''
      : ` Undetermined: ${undetermined.join(', ')}.`,
    ' Which reading is right? Under each, AgentOS would do what is stated beside it. This is a '
    + 'discrimination between readings AgentOS has already evidenced, not a request for '
    + 'context AgentOS could discover.',
  ].join('');

  return { question, readings };
}

/** The template a reading would select, which is what AgentOS would do under it. */
function wouldDo(type: WorkItemType, policies: PolicySet): string {
  const admissible = policies.admissibleTemplates(type);
  const template = admissible[0];
  if (template === undefined) {
    return `no template is admissible for ${type} in this installation`;
  }
  return `run ${template.template_id}: ${template.stages.join(' -> ')}`;
}

/* ------------------------------------------------------------------- the ladder ---- */

export async function climbLadder(input: LadderInput): Promise<LadderResult> {
  const steps: LadderStep[] = [];
  const handled: string[] = [];
  let probes = 0;

  const record = (step: LadderStep): void => {
    steps.push(step);
    input.ports.record(step);
  };

  /* ---------------------------------------------------------- rung 1 ---- */

  const override = escalationOverride(input.workItem.type, input.alternatives);

  if (input.understood.verdict === 'SUFFICIENT' && !override.escalate) {
    record({
      rung: 'PROCEED',
      outcome: 'SUCCEEDED',
      detail:
        'the type is admissible on its evidence, the external identity is resolved and reality '
        + 'is determinate. The overwhelmingly common case, and it involves no human',
    });
    return {
      rung: 'PROCEED',
      steps,
      handled,
      probesDispatched: 0,
      detail: 'the workflow decision is determinate, so no rung was needed',
    };
  }

  if (override.escalate) {
    record({ rung: 'PROCEED', outcome: 'SKIPPED', detail: override.reason });
    record({ rung: 'DISCOVER', outcome: 'SKIPPED', detail: override.reason });
    record({ rung: 'SAFE_PREFIX', outcome: 'SKIPPED', detail: override.reason });
    return ask(input, steps, handled, probes, record);
  }

  /* ---------------------------------------------------------- rung 2 ---- */

  const cap = input.policies.budgets.loops.discovery;
  let settled = 0;
  for (const gap of input.gaps) {
    const runSpent = input.discoveryLoops.run + probes + 1;
    const workItemSpent = input.discoveryLoops.workItem + probes + 1;
    if (runSpent > cap.per_run || workItemSpent > cap.per_work_item) {
      record({
        rung: 'DISCOVER',
        outcome: 'EXHAUSTED',
        detail:
          `the discovery loop budget is spent (${runSpent} of ${cap.per_run} per run, `
          + `${workItemSpent} of ${cap.per_work_item} per work item), so rung 2 stops rather `
          + 'than spinning. Exceeding a cap is never a quiet retry',
      });
      break;
    }
    probes += 1;
    const outcome = await input.ports.discover({
      gapId: gap.id,
      subject: gap.subject,
      recoverableBy: gap.recoverable_by,
      blocks: gap.blocks,
    });
    /*
     * A dispatched probe is a recorded handling whatever it found. "We looked, with this
     * probe, and this is what came back" is exactly the handling condition 4 asks for; what it
     * is not is a resolution, and a probe that settled nothing leaves the gap unresolved and
     * the ladder climbing.
     */
    if (outcome.ran) handled.push(gap.id);
    if (outcome.settled) settled += 1;
    record({
      rung: 'DISCOVER',
      outcome: outcome.settled ? 'SUCCEEDED' : outcome.ran ? 'ATTEMPTED' : 'UNAVAILABLE',
      detail: `${gap.id} (${gap.subject}): ${gap.recoverable_by}. ${outcome.detail}`,
    });
  }

  if (probes === 0) {
    record({
      rung: 'DISCOVER',
      outcome: 'SKIPPED',
      detail:
        input.gaps.length === 0
          ? 'no UNKNOWN blocking a mandatory obligation names a recovery, so there is nothing '
            + 'for rung 2 to dispatch'
          : 'the discovery loop budget was already spent before this rung',
    });
  }

  /*
   * Confidence below the threshold is not something a probe can fix — it is the agent's own
   * number about its own work — so the ladder continues past rung 2 for that alone. Where the
   * only failure was an undetermined predicate and a probe settled every gap, rung 2 is the
   * answer.
   */
  const confidenceShort =
    input.resolutionConfidence < input.policies.workItems.resolution_confidence_threshold;
  /*
   * Rung 2 is the answer only where the probes actually **settled** every blocking gap. A
   * probe that ran and came back with the same UNKNOWN is a recorded handling and not a
   * resolution, so the ladder keeps climbing — treating "we looked" as "we know" is the
   * failure the whole absence vocabulary exists to prevent.
   */
  const everyGapSettled = input.gaps.length > 0 && settled === input.gaps.length;

  if (everyGapSettled && !confidenceShort) {
    return {
      rung: 'DISCOVER',
      steps,
      handled,
      probesDispatched: probes,
      detail:
        `${probes} probe(s) dispatched against what the UNKNOWNs named would settle them, and `
        + `${settled} of ${input.gaps.length} blocking gap(s) came back determinate`,
    };
  }

  /* ---------------------------------------------------------- rung 3 ---- */

  const safe = commonSafePrefix(input.admissibleTemplates, input.policies);
  if (safe.prefix.length > 0) {
    record({ rung: 'SAFE_PREFIX', outcome: 'SUCCEEDED', detail: safe.reason });
    return {
      rung: 'SAFE_PREFIX',
      steps,
      handled,
      probesDispatched: probes,
      prefix: safe.prefix,
      detail: safe.reason,
    };
  }
  record({ rung: 'SAFE_PREFIX', outcome: 'SKIPPED', detail: safe.reason });

  /* ------------------------------------------------------- rungs 4 and 5 ---- */

  return ask(input, steps, handled, probes, record);
}

async function ask(
  input: LadderInput,
  steps: LadderStep[],
  handled: string[],
  probes: number,
  record: (step: LadderStep) => void,
): Promise<LadderResult> {
  const built = discriminatingQuestion(
    input.workItem,
    input.alternatives,
    input.policies,
    input.understood.undeterminedPredicates,
  );

  if (built === null) {
    record({
      rung: 'ASK',
      outcome: 'SKIPPED',
      detail:
        'the proposal carries no alternative readings, so there is no discrimination to ask '
        + 'for. The kernel does not invent one: a question with a single reading is a request '
        + 'for a briefing, and asking a human to supply context AgentOS could discover '
        + 'violates principle 1',
    });
    return {
      rung: 'BLOCK',
      steps,
      handled,
      probesDispatched: probes,
      blockerKind: 'AMBIGUOUS_GOAL',
      question: null,
      readings: [],
      detail:
        'understanding is insufficient and no rung could settle it. BLOCKED with '
        + 'AMBIGUOUS_GOAL, and the run resumes in place when the ambiguity is resolved',
    };
  }

  record({ rung: 'ASK', outcome: 'ATTEMPTED', detail: built.question });
  const answer = await input.ports.ask(built.question, built.readings);

  if (answer !== null && answer.trim().length > 0) {
    record({ rung: 'ASK', outcome: 'SUCCEEDED', detail: `answered: ${answer}` });
    return {
      rung: 'ASK',
      steps,
      handled,
      probesDispatched: probes,
      question: built.question,
      readings: built.readings,
      answer,
      detail: 'a human discriminated between the readings, and the answer is recorded',
    };
  }

  record({
    rung: 'BLOCK',
    outcome: 'SUCCEEDED',
    detail:
      `no answer inside the ${input.policies.budgets.question_window_ms} ms window. Silence is `
      + 'never consent',
  });
  return {
    rung: 'BLOCK',
    steps,
    handled,
    probesDispatched: probes,
    blockerKind: 'AMBIGUOUS_GOAL',
    question: built.question,
    readings: built.readings,
    detail:
      `no answer inside the ${input.policies.budgets.question_window_ms} ms window, so the run `
      + 'is BLOCKED with AMBIGUOUS_GOAL. Silence is never consent, and the run resumes in '
      + 'place when an answer arrives',
  };
}

/** Whether a predicate value leaves the workflow decision undetermined. */
export function undetermined(value: PredicateValue): boolean {
  return value === 'INDETERMINATE';
}
