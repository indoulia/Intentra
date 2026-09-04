import type {
  FrozenGraph,
  Stage,
  StageCursorEntry,
  TemplateStage,
} from '@agentos/contracts';
import type { PolicySet } from '@agentos/policies';
import { incoming } from '@agentos/policies';
import type { PredicateEvaluator, PredicateEvaluation, PredicateInputs } from './predicates.js';
import { saferBranch } from './state-machine.js';

/**
 * Entry-stage computation — where a run starts.
 *
 * **The kernel computes it.** No agent proposes it and the intake never implies it. This is
 * the decision most vulnerable to an agent's optimistic reading of a prompt, and it is
 * removed from the agent entirely: resumption is arithmetic over adapter observations.
 *
 * Sweep the frozen graph in run order from the entry and classify every stage against
 * Current Reality by its `satisfied_by` predicate:
 *
 * ```
 * satisfied_by TRUE            -> COMPLETED_PRIOR, with the reality evidence recorded
 * satisfied_by FALSE           -> not done
 * satisfied_by absent          -> not done, and not observable as done either
 * satisfied_by INDETERMINATE
 *     and stage is non-mutating -> not done (more verification, no mutation)
 *     and stage is mutating     -> dispatch targeted discovery; if still INDETERMINATE,
 *                                  BLOCKED with AMBIGUOUS_STATE
 * ```
 *
 * **The entry stage is the first stage that is not done, at or after the last stage that
 * is.** Not simply the first stage that is not done: a stage earlier than a completed
 * mutation is `PASSED_UNVERIFIED` rather than re-entered, because re-entering it would walk
 * backwards over work that demonstrably already happened. This is what makes the frozen
 * documents' own scenarios come out right — a resumed Story whose `ARCHITECTURE` never ran
 * still enters at `PR_REVIEW`, and a resumed Defect with a reviewed PR enters at
 * `REVIEW_TRIAGE` (amendment A-17).
 *
 * A `PASSED_UNVERIFIED` stage is not forgiven. It supplied no per-criterion verdicts, so its
 * criteria are `NOT_VALIDATED`, so `COMPLETION` computes `INCOMPLETE` and routes back to the
 * stage that owns them. Skipping past it defers the judgment; it cannot skip it.
 *
 * One state is refused outright: a **mutating** stage whose `satisfied_by` is observably
 * `FALSE` while a *later* stage is `COMPLETED_PRIOR`. "There is no implementation, and the
 * pull request is merged" is not a resumable state, it is a contradiction between two
 * observations, and it goes to a human as `AMBIGUOUS_STATE` rather than being resolved by
 * preferring whichever observation is more convenient.
 *
 * And the property that makes it safe to be aggressive about not redoing work:
 * **`COMPLETED_PRIOR` means the mutation this stage performs has already occurred. It does
 * not mean the stage's DoD criteria are met.** A wrong resume costs a wasted lap; it cannot
 * manufacture a `COMPLETE`.
 */

export interface WalkStep {
  readonly stage: TemplateStage;
  readonly satisfied_by: string | null;
  readonly evaluated: PredicateEvaluation['value'];
  readonly mutating: boolean;
  readonly decision:
    | 'COMPLETED_PRIOR'
    | 'ENTER'
    | 'PASSED_UNVERIFIED'
    | 'NOT_REACHED'
    | 'BLOCK_AMBIGUOUS_STATE';
  readonly evidence: readonly string[];
  readonly reason: string;
}

export type EntryStageResult =
  | {
    readonly outcome: 'ENTRY';
    readonly entryStage: TemplateStage;
    readonly walk: readonly WalkStep[];
    readonly cursor: readonly StageCursorEntry[];
    readonly completedPrior: readonly TemplateStage[];
  }
  | {
    readonly outcome: 'BLOCKED';
    readonly blockerKind: 'AMBIGUOUS_STATE';
    readonly stage: TemplateStage;
    readonly reason: string;
    readonly walk: readonly WalkStep[];
  };

/**
 * The order the resume sweep walks, which is the order the template declares its stages in.
 *
 * The declared order *is* the run order: `withoutStages` moves the entry to the first
 * surviving declared stage, and `checkWellFormed` requires the entry to be the first
 * declared stage and every forward edge to run forwards through the declaration unless it
 * closes a cycle. So the order is a topological order of the graph's forward progress, and
 * it is one a reviewer can read off the template rather than one an algorithm invents.
 *
 * Deriving it with Kahn's algorithm instead was tried and is wrong here: the repair stages
 * (`REWORK`, `REVIEW_TRIAGE`, `COMMENT_RESOLUTION`) are reachable only through loop edges,
 * so excluding loops to break the cycles leaves them with no incoming edge at all and hoists
 * them to the front of the order — which put `REWORK` second in `defect.standard` and made
 * every resumed defect enter there.
 */
export function resumeOrder(graph: FrozenGraph): readonly TemplateStage[] {
  return graph.stages;
}

export interface EntryStageInput {
  readonly graph: FrozenGraph;
  readonly policies: PolicySet;
  readonly evaluator: PredicateEvaluator;
  readonly predicateInputs: PredicateInputs;
  /**
   * Targeted discovery for a mutating stage whose `satisfied_by` is `INDETERMINATE`. Returns
   * the re-evaluated value. Absent means no discovery is available, which sends an
   * indeterminate mutating stage straight to `AMBIGUOUS_STATE`.
   */
  readonly discover?: (
    stage: TemplateStage,
    predicate: string,
  ) => Promise<PredicateEvaluation>;
}

/** One stage's classification during the sweep, before the entry stage is chosen. */
interface Classification {
  readonly stage: TemplateStage;
  readonly satisfied_by: string | null;
  readonly evaluated: PredicateEvaluation['value'];
  readonly mutating: boolean;
  /**
   * `AMBIGUOUS` is a mutating stage whose `satisfied_by` stayed `INDETERMINATE` after
   * targeted discovery. It is carried through the sweep rather than blocking on the spot,
   * because whether it matters depends on where the entry lands: an unreadable PR host makes
   * `PR_PREPARATION` ambiguous, and that must not stop a run whose entry is `AUDIT` — the run
   * will reach that stage through the ordinary transitions and probe again then.
   */
  readonly status: 'DONE' | 'NOT_DONE' | 'AMBIGUOUS';
  readonly evidence: readonly string[];
  readonly reason: string;
}

const PRIOR_MEANS =
  'COMPLETED_PRIOR means the mutation this stage performs has already occurred, not that its '
  + 'criteria are met: it supplies no verdicts, so they are NOT_VALIDATED and COMPLETION will '
  + 'route back';

const PASSED_MEANS =
  'a later stage is observably already done, so entering this one would walk backwards over a '
  + 'mutation that has happened. It supplied no verdicts either, so its criteria are '
  + 'NOT_VALIDATED and COMPLETION routes back to it';

export async function computeEntryStage(
  input: EntryStageInput,
): Promise<EntryStageResult> {
  const { graph, policies, evaluator, predicateInputs } = input;
  const order = resumeOrder(graph);
  const classified: Classification[] = [];

  for (const stage of order) {
    const descriptor = policies.stages.get(stage);
    const satisfiedBy = descriptor?.satisfied_by ?? null;
    const mutating = descriptor?.mutating ?? true;

    if (satisfiedBy === null) {
      /*
       * A stage with no `satisfied_by` can never be satisfied by prior reality — there is no
       * observation that means "this already happened". `AUDIT` used to be such a stage, and
       * that is exactly why amendment A-15 was needed: without a predicate the sweep can
       * only ever say "not done", never "already done".
       */
      classified.push({
        stage,
        satisfied_by: null,
        evaluated: 'FALSE',
        mutating,
        status: 'NOT_DONE',
        evidence: [],
        reason:
          'the stage declares no reality predicate meaning "already done", so no observation '
          + 'could mark it COMPLETED_PRIOR',
      });
      continue;
    }

    /*
     * The stage is supplied because `reality.stage_completed_previously` asks about a
     * particular stage rather than about the world.
     */
    const evaluation = await evaluator.evaluate(satisfiedBy, {
      ...predicateInputs,
      stage,
    });

    if (evaluation.value === 'TRUE') {
      classified.push({
        stage,
        satisfied_by: satisfiedBy,
        evaluated: 'TRUE',
        mutating,
        status: 'DONE',
        evidence: realityEvidence(predicateInputs, satisfiedBy),
        reason: `${evaluation.reason}. ${PRIOR_MEANS}`,
      });
      continue;
    }

    if (evaluation.value === 'FALSE') {
      classified.push({
        stage,
        satisfied_by: satisfiedBy,
        evaluated: 'FALSE',
        mutating,
        status: 'NOT_DONE',
        evidence: [],
        reason: evaluation.reason,
      });
      continue;
    }

    /* INDETERMINATE. The refined safer-branch rule decides. */
    const branch = saferBranch(evaluation.value, mutating, input.discover !== undefined);

    if (branch.decision === 'TAKE') {
      classified.push({
        stage,
        satisfied_by: satisfiedBy,
        evaluated: 'INDETERMINATE',
        mutating,
        status: 'NOT_DONE',
        evidence: [],
        reason: `${evaluation.reason}. ${branch.reason}`,
      });
      continue;
    }

    if (branch.decision === 'DISCOVER' && input.discover !== undefined) {
      const rediscovered = await input.discover(stage, satisfiedBy);
      if (rediscovered.value === 'TRUE' || rediscovered.value === 'FALSE') {
        const settled = rediscovered.value === 'TRUE';
        classified.push({
          stage,
          satisfied_by: satisfiedBy,
          evaluated: rediscovered.value,
          mutating,
          status: settled ? 'DONE' : 'NOT_DONE',
          evidence: settled ? realityEvidence(predicateInputs, satisfiedBy) : [],
          reason: `targeted discovery settled it: ${rediscovered.reason}`
            + (settled ? `. ${PRIOR_MEANS}` : ''),
        });
        continue;
      }
      classified.push({
        stage,
        satisfied_by: satisfiedBy,
        evaluated: 'INDETERMINATE',
        mutating,
        status: 'AMBIGUOUS',
        evidence: [],
        reason: `still INDETERMINATE after targeted discovery: ${rediscovered.reason}`,
      });
      continue;
    }

    classified.push({
      stage,
      satisfied_by: satisfiedBy,
      evaluated: 'INDETERMINATE',
      mutating,
      status: 'AMBIGUOUS',
      evidence: [],
      reason: `${evaluation.reason}. ${branch.reason}`,
    });
  }

  /* The last stage observably already done. -1 when nothing is. */
  let lastPrior = -1;
  for (let i = 0; i < classified.length; i += 1) {
    if (classified[i]?.status === 'DONE') lastPrior = i;
  }

  /*
   * The refused state: a mutating stage whose mutation observably has *not* happened, sitting
   * before one that observably has. Two adapter observations contradict each other, and no
   * resume decision follows from a contradiction.
   */
  for (let i = 0; i < lastPrior; i += 1) {
    const step = classified[i];
    if (step === undefined || step.status === 'DONE') continue;
    if (!step.mutating || step.satisfied_by === null || step.evaluated !== 'FALSE') continue;
    const later = classified[lastPrior]?.stage ?? graph.entry;
    return blocked(
      classified.slice(0, i),
      step.stage,
      step.satisfied_by,
      step.mutating,
      `${step.reason}, while ${later} is observably already done`,
      `${step.stage} mutates and its mutation observably has not happened, yet the later `
      + `stage ${later} observably has. That is a contradiction between two observations `
      + 'rather than a resumable state, and AgentOS does not resolve it by preferring '
      + 'whichever observation is more convenient',
    );
  }

  /*
   * The entry is the first stage still to run at or after the last one already done. The
   * fallback to the final stage is unreachable for any well-formed graph, because
   * `COMPLETION` declares no `satisfied_by` and so is never `COMPLETED_PRIOR`.
   */
  const found = classified.findIndex((c, i) => i > lastPrior && c.status === 'NOT_DONE');
  const entryIndex = found === -1 ? classified.length - 1 : found;
  const entryStage = classified[entryIndex]?.stage ?? graph.entry;

  /*
   * An ambiguous mutating stage the sweep would have to *skip over* to reach the entry is the
   * case that blocks. Skipping it would mean never performing a mutation that may not have
   * happened; entering it would mean maybe performing one that has. Neither follows from an
   * INDETERMINATE, so a human decides. An ambiguous stage downstream of the entry blocks
   * nothing: the run reaches it through the ordinary transitions and probes again there.
   */
  for (let i = lastPrior + 1; i < entryIndex; i += 1) {
    const step = classified[i];
    if (step?.status !== 'AMBIGUOUS') continue;
    return blocked(
      classified.slice(0, i),
      step.stage,
      step.satisfied_by,
      step.mutating,
      `${step.reason}. Re-executing a non-reversible operation on the strength of an `
      + 'INDETERMINATE is precisely how a system opens the same PR twice',
      `whether ${step.stage} has already happened is INDETERMINATE, the stage mutates, and `
      + `the run would have to pass over it to start at ${entryStage}. AgentOS never `
      + 're-executes a non-reversible operation on the strength of an INDETERMINATE, and it '
      + 'does not silently drop one either',
    );
  }

  const walk: WalkStep[] = [];
  const cursor: StageCursorEntry[] = [];
  const completedPrior: TemplateStage[] = [];

  for (let i = 0; i < classified.length; i += 1) {
    const step = classified[i];
    if (step === undefined) continue;
    if (step.status === 'DONE') {
      walk.push({ ...step, decision: 'COMPLETED_PRIOR' });
      cursor.push(entry(step.stage, 'COMPLETED_PRIOR', step.evidence));
      completedPrior.push(step.stage);
    } else if (i === entryIndex) {
      walk.push({ ...step, decision: 'ENTER' });
      cursor.push(entry(step.stage, 'ACTIVE', []));
    } else if (i < entryIndex) {
      walk.push({
        ...step,
        decision: 'PASSED_UNVERIFIED',
        reason: `${step.reason}, but ${PASSED_MEANS}`,
      });
      cursor.push(entry(step.stage, 'PENDING', []));
    } else {
      /* After the entry: not skipped, not done, simply not reached. */
      walk.push({ ...step, decision: 'NOT_REACHED' });
      cursor.push(entry(step.stage, 'PENDING', []));
    }
  }

  return { outcome: 'ENTRY', entryStage, walk, cursor, completedPrior };
}

/** A `BLOCKED` result whose walk ends at the stage that could not be classified. */
function blocked(
  preceding: readonly Classification[],
  stage: TemplateStage,
  satisfiedBy: string | null,
  mutating: boolean,
  stepReason: string,
  reason: string,
): EntryStageResult {
  const walk: WalkStep[] = preceding.map((step) => ({
    ...step,
    decision: step.status === 'DONE' ? 'COMPLETED_PRIOR' as const : 'PASSED_UNVERIFIED' as const,
  }));
  walk.push({
    stage,
    satisfied_by: satisfiedBy,
    evaluated: 'INDETERMINATE',
    mutating,
    decision: 'BLOCK_AMBIGUOUS_STATE',
    evidence: [],
    reason: stepReason,
  });
  return { outcome: 'BLOCKED', blockerKind: 'AMBIGUOUS_STATE', stage, reason, walk };
}

function entry(
  stage: TemplateStage,
  state: StageCursorEntry['state'],
  evidence: readonly string[],
): StageCursorEntry {
  return {
    stage,
    state,
    reality_evidence: [...evidence],
    entered_at: null,
    left_at: null,
  };
}

/**
 * The reality evidence a `COMPLETED_PRIOR` marking rests on.
 *
 * Recorded because a stage skipped as already done must say *what said so*. "git and the PR
 * host said so" is only auditable if the assertion is named, and a skip with no evidence
 * would be indistinguishable from a skip nobody justified.
 */
function realityEvidence(
  inputs: PredicateInputs,
  predicate: string,
): readonly string[] {
  const reality = inputs.context.current_reality as unknown as Record<string, unknown>;
  const out: string[] = [];
  for (const [element, assertion] of Object.entries(reality)) {
    if (assertion === null || typeof assertion !== 'object') continue;
    const typed = assertion as { confidence?: unknown; evidence?: unknown };
    if (typed.confidence !== 'FACT') continue;
    if (!Array.isArray(typed.evidence)) continue;
    for (const reference of typed.evidence) {
      if (typeof reference === 'string') out.push(reference);
      else if (
        reference !== null && typeof reference === 'object'
        && typeof (reference as { id?: unknown }).id === 'string'
      ) {
        out.push((reference as { id: string }).id);
      }
    }
    if (predicate.includes(element)) break;
  }
  return [...new Set(out)];
}

/**
 * Crash recovery never re-derives the entry stage.
 *
 * The resume computation above is for *new runs against existing work*; crash recovery is
 * for *the same run continuing*. They are different mechanisms and must not be confused,
 * because the frozen graph and the cursor already say where the run was — and recomputing
 * would make recovery depend on reality having stayed still.
 */
export function stageFromCursor(
  cursor: readonly StageCursorEntry[],
  graph: FrozenGraph,
): Stage {
  const active = cursor.find((c) => c.state === 'ACTIVE');
  if (active !== undefined) return active.stage;
  const pending = cursor.find((c) => c.state === 'PENDING');
  if (pending !== undefined) return pending.stage;
  /* Nothing active and nothing pending: every stage is done or skipped, so the run is at
   * COMPLETION if it has one and at its last stage otherwise. */
  return graph.stages.includes('COMPLETION')
    ? 'COMPLETION'
    : (graph.stages[graph.stages.length - 1] ?? graph.entry);
}

/** The stages a run has yet to reach, for the input package's read-only `workflow` view. */
export function stagesRemaining(
  cursor: readonly StageCursorEntry[],
  graph: FrozenGraph,
): readonly TemplateStage[] {
  const order = resumeOrder(graph);
  const done = new Set(
    cursor.filter((c) => c.state === 'COMPLETED' || c.state === 'COMPLETED_PRIOR' || c.state === 'EXCLUDED')
      .map((c) => c.stage),
  );
  return order.filter((stage) => !done.has(stage));
}

/** Which stages have no incoming forward edge, for diagnosing a template. */
export function roots(graph: FrozenGraph): readonly TemplateStage[] {
  return graph.stages.filter(
    (stage) => incoming({ entry: graph.entry, stages: graph.stages, edges: graph.edges }, stage)
      .filter((e) => e.kind === 'advance' || e.kind === 'branch').length === 0,
  );
}
