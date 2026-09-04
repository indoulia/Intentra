import {
  assertNever,
  type BlockerKind,
  type EnvelopeStatus,
  type FrozenGraph,
  type HandoffEnvelope,
  type PredicateValue,
  type Stage,
  type StageDescriptor,
  type TemplateStage,
  type Violation,
  type WorkflowEdge,
} from '@agentos/contracts';
import type { BudgetPolicy } from '@agentos/contracts';
import { outgoing } from '@agentos/policies';
import type { PredicateEvaluation } from './predicates.js';

/**
 * The state machine.
 *
 * The kernel owns transitions. An agent proposes `next_action`; the kernel decides — and an
 * agent that claims a transition it is not entitled to make is a contract violation, logged
 * as such.
 *
 * Two things make that more than an assertion. Every value of `HandoffEnvelope.status` maps
 * to **exactly one** kernel action, as an exhaustive discriminated switch the compiler
 * checks; the design states that rule and this is where it becomes a compile-time guarantee
 * rather than a test. And every conditional edge names a predicate the kernel evaluates
 * itself, so an agent cannot skip a stage by asserting the stage does not apply.
 */

export type KernelAction =
  | {
    /** Take an edge. `overridden` is true where the agent proposed something else. */
    readonly kind: 'TRANSITION';
    readonly edge: WorkflowEdge;
    readonly to: Stage;
    readonly trigger: string;
    readonly overridden: boolean;
    readonly proposedStage: Stage | null;
    readonly evaluations: readonly PredicateEvaluation[];
    /**
     * Outputs a `PARTIAL` envelope left unfilled that the exit condition did not require.
     *
     * "Not required → proceed, **recording the gap as an `unknown`**"
     * ([WORKFLOW_STATE_MACHINE.md](../../docs/WORKFLOW_STATE_MACHINE.md) 4.2). Proceeding
     * without recording it is how a `PARTIAL` becomes a soft `COMPLETE`: the run advances,
     * nothing says what was left undone, and the report reads as though the stage filled
     * everything it was asked for.
     */
    readonly unfilledOutputs?: readonly string[];
  }
  | {
    /** Stay in the stage and dispatch again, with the gap named. */
    readonly kind: 'REDISPATCH';
    readonly reason: string;
    readonly namedGaps: readonly string[];
    readonly escalateModel: boolean;
  }
  | {
    readonly kind: 'BLOCK';
    readonly blockerKind: BlockerKind;
    readonly reason: string;
    readonly preBlockStage: Stage;
    readonly report: readonly string[];
  }
  | {
    /** The work turned out to be something else. Ends the run RERESOLVED. */
    readonly kind: 'RERESOLVE';
    readonly reason: string;
    readonly evidence: readonly string[];
  }
  | {
    readonly kind: 'CONTRACT_VIOLATION';
    readonly violations: readonly Violation[];
    /** Handled as BLOCKED: the kernel never guesses what an agent meant. */
    readonly preBlockStage: Stage;
  };

export interface TransitionContext {
  readonly graph: FrozenGraph;
  readonly currentStage: Stage;
  readonly descriptor: StageDescriptor | null;
  readonly budgets: BudgetPolicy;
  readonly loopCounters: Readonly<Record<string, number>>;
  readonly workItemLoopCounters: Readonly<Record<string, number>>;
  readonly dispatchAttempt: number;
  readonly modelAlreadyEscalated: boolean;
  /** Evaluates an edge condition. Supplied by the kernel; never by the agent. */
  readonly evaluate: (when: string) => Promise<PredicateEvaluation>;
  /** Outputs the current stage's exit condition requires. */
  readonly requiredForExit: readonly string[];
}

/** Edges out of a stage whose condition is an envelope status rather than a predicate. */
function statusEdges(graph: FrozenGraph, from: Stage, status: EnvelopeStatus): readonly WorkflowEdge[] {
  return outgoing({ entry: graph.entry, stages: graph.stages, edges: graph.edges }, from)
    .filter((edge) => edge.when === `envelope.${status}`);
}

function conditionEdges(graph: FrozenGraph, from: Stage): readonly WorkflowEdge[] {
  return outgoing({ entry: graph.entry, stages: graph.stages, edges: graph.edges }, from)
    .filter((edge) => !edge.when.startsWith('envelope.'));
}

function capFor(
  edge: WorkflowEdge,
  budgets: BudgetPolicy,
): { readonly perRun: number; readonly perWorkItem: number } | null {
  const counter = edge.counter;
  if (counter === null || counter === undefined) return null;
  const cap = (budgets.loops as Record<string, { per_run: number; per_work_item: number } | undefined>)[counter];
  if (cap === undefined) return null;
  return { perRun: cap.per_run, perWorkItem: cap.per_work_item };
}

/**
 * Would taking this loop edge exceed its cap, per run or per work item?
 *
 * Both are checked. Three runs of two laps each is six laps, and a budget that resets on
 * every attempt is not a budget.
 */
export function loopExhausted(
  edge: WorkflowEdge,
  context: TransitionContext,
): { readonly exhausted: boolean; readonly scope: 'run' | 'work_item' | null; readonly value: number; readonly cap: number | null } {
  const cap = capFor(edge, context.budgets);
  const counter = edge.counter;
  if (cap === null || counter === null || counter === undefined) {
    return { exhausted: false, scope: null, value: 0, cap: null };
  }
  const runValue = (context.loopCounters[counter] ?? 0) + 1;
  if (runValue > cap.perRun) {
    return { exhausted: true, scope: 'run', value: runValue, cap: cap.perRun };
  }
  const workItemValue = (context.workItemLoopCounters[counter] ?? 0) + 1;
  if (workItemValue > cap.perWorkItem) {
    return { exhausted: true, scope: 'work_item', value: workItemValue, cap: cap.perWorkItem };
  }
  return { exhausted: false, scope: null, value: runValue, cap: cap.perRun };
}

/**
 * Maps an envelope status to exactly one kernel action.
 *
 * The switch is exhaustive over `EnvelopeStatus` and `assertNever` closes it, so adding a
 * status without deciding its action is a compile error rather than a silently unhandled
 * case.
 */
export async function decideAction(
  envelope: HandoffEnvelope,
  context: TransitionContext,
): Promise<KernelAction> {
  const { currentStage } = context;

  switch (envelope.status) {
    case 'COMPLETE':
      return advance(envelope, context);

    case 'PARTIAL': {
      /*
       * PARTIAL is never a soft COMPLETE. The kernel checks whether the unfilled outputs are
       * required by the current stage's exit condition: not required means proceed and record
       * the gap as an unknown; required means re-dispatch once with the gap named, then BLOCK
       * if it recurs.
       */
      const filled = new Set(
        Object.entries(envelope.outputs)
          .filter(([, value]) => value !== null && value !== undefined)
          .map(([name]) => name),
      );
      const missingRequired = context.requiredForExit.filter((name) => !filled.has(name));
      if (missingRequired.length === 0) {
        /*
         * Not required by the exit condition, so the run proceeds — and the gap is recorded.
         * Everything the envelope declared as an output and did not fill is carried onto the
         * transition, so the log says what a PARTIAL left undone rather than reading like a
         * COMPLETE that happened to be labelled otherwise.
         */
        const unfilled = Object.entries(envelope.outputs)
          .filter(([, value]) => value === null || value === undefined)
          .map(([name]) => name);
        const advanced = await advance(envelope, context);
        if (advanced.kind !== 'TRANSITION') return advanced;
        return { ...advanced, unfilledOutputs: unfilled };
      }
      if (context.dispatchAttempt <= 1) {
        return {
          kind: 'REDISPATCH',
          reason:
            `PARTIAL with ${missingRequired.length} output(s) the exit condition requires. `
            + 'Re-dispatched once with the gap named',
          namedGaps: missingRequired,
          escalateModel: false,
        };
      }
      return {
        kind: 'BLOCK',
        blockerKind: 'MISSING_CAPABILITY',
        reason:
          `PARTIAL twice with ${missingRequired.join(', ')} still unfilled, and the exit `
          + 'condition requires them',
        preBlockStage: currentStage,
        report: [
          `stage ${currentStage} requires ${context.requiredForExit.join(', ')}`,
          `still unfilled after ${context.dispatchAttempt} attempts: ${missingRequired.join(', ')}`,
          'a human decides whether the mandate, the access or the model is what is missing',
        ],
      };
    }

    case 'BLOCKED': {
      const blocker = envelope.blockers[0];
      /* The cross-field rules already refuse BLOCKED with no blockers, so this is a guard. */
      if (blocker === undefined) {
        return {
          kind: 'BLOCK',
          blockerKind: 'UNRESOLVED_CONFLICT',
          reason: 'BLOCKED with no blocker survived the cross-field rules',
          preBlockStage: currentStage,
          report: [],
        };
      }
      /*
       * `WORK_ITEM_MISCLASSIFIED` is a blocker rather than a proposal because the run
       * genuinely cannot continue: its graph is for different work. It ends the run
       * RERESOLVED and a new one starts against the same Work Item.
       */
      if (blocker.kind === 'WORK_ITEM_MISCLASSIFIED') {
        return {
          kind: 'RERESOLVE',
          reason: blocker.description,
          evidence: blocker.evidence,
        };
      }
      return {
        kind: 'BLOCK',
        blockerKind: blocker.kind,
        reason: blocker.description,
        preBlockStage: currentStage,
        report: [
          blocker.description,
          ...blocker.conflicting_requirements ?? [],
          ...(blocker.options ?? []).map((option) => `option: ${option}`),
          `needs: ${blocker.needs}`,
        ],
      };
    }

    case 'BLOCKED_BY_ARCHITECTURE': {
      /*
       * IMPLEMENTATION to ARCHITECTURE, counted against the architecture loop cap. Where the
       * graph contains no ARCHITECTURE stage it is BLOCKED with ARCHITECTURE_CONTRADICTION,
       * which is the honest outcome for a template that assumed no design work was needed.
       */
      if (!context.graph.stages.includes('ARCHITECTURE')) {
        return {
          kind: 'BLOCK',
          blockerKind: 'ARCHITECTURE_CONTRADICTION',
          reason:
            'the Implementer met an architectural contradiction and this template has no '
            + 'ARCHITECTURE stage to route to',
          preBlockStage: currentStage,
          report: [
            envelope.blockers[0]?.description ?? 'an architectural contradiction',
            `template ${context.graph.template_id} contains no ARCHITECTURE stage`,
            'a human decides whether to widen the template or to change the design',
          ],
        };
      }
      const edge = context.graph.edges.find(
        (e) => e.from === 'IMPLEMENTATION' && e.to === 'ARCHITECTURE' && e.kind === 'loop',
      );
      if (edge === undefined) {
        return {
          kind: 'BLOCK',
          blockerKind: 'ARCHITECTURE_CONTRADICTION',
          reason:
            'the graph contains ARCHITECTURE and no loop edge from IMPLEMENTATION to it, so '
            + 'the architecture loop is not expressible in this template',
          preBlockStage: currentStage,
          report: [`template ${context.graph.template_id} has no IMPLEMENTATION -> ARCHITECTURE loop`],
        };
      }
      const exhaustion = loopExhausted(edge, context);
      if (exhaustion.exhausted) {
        return {
          kind: 'BLOCK',
          blockerKind: 'BUDGET_EXHAUSTED',
          reason:
            `the architecture loop cap is exhausted (${exhaustion.value} of `
            + `${String(exhaustion.cap)} per ${exhaustion.scope ?? 'run'}). A third `
            + 'contradiction means the problem is not understood, and pushing through is '
            + 'worse than stopping',
          preBlockStage: currentStage,
          report: [
            envelope.blockers[0]?.description ?? 'an architectural contradiction',
            `architecture loop: ${exhaustion.value} of ${String(exhaustion.cap)} per ${exhaustion.scope ?? 'run'}`,
            'a human decides whether the design or the requirement is wrong',
          ],
        };
      }
      return {
        kind: 'TRANSITION',
        edge,
        to: 'ARCHITECTURE',
        trigger: 'envelope.BLOCKED_BY_ARCHITECTURE',
        overridden: envelope.next_action !== null
          && envelope.next_action.proposed_stage !== 'ARCHITECTURE',
        proposedStage: envelope.next_action?.proposed_stage ?? null,
        evaluations: [],
      };
    }

    case 'FAILED': {
      /*
       * An agent-level failure — tooling, model, timeout — and not a finding about the work.
       * Retry per policy, escalating the model once. On repeated failure: BLOCKED. The stage
       * does not advance, and a FAILED envelope never satisfies an exit condition.
       */
      if (context.dispatchAttempt <= context.budgets.dispatch_retries) {
        return {
          kind: 'REDISPATCH',
          reason:
            `the dispatch failed (attempt ${context.dispatchAttempt} of `
            + `${context.budgets.dispatch_retries + 1}). A FAILED envelope never satisfies an `
            + 'exit condition, so the stage does not advance',
          namedGaps: [],
          escalateModel: !context.modelAlreadyEscalated
            && context.budgets.model_escalations_per_dispatch > 0,
        };
      }
      return {
        kind: 'BLOCK',
        blockerKind: 'EXTERNAL_DEPENDENCY',
        reason:
          `the dispatch failed ${context.dispatchAttempt} times. No state advances, no `
          + 'envelope merges, and the run resumes at the same point when the dependency returns',
        preBlockStage: currentStage,
        report: [
          envelope.summary,
          `attempts: ${context.dispatchAttempt}`,
          context.modelAlreadyEscalated
            ? 'the model was escalated once and the failure recurred'
            : 'no model escalation was available',
        ],
      };
    }

    case 'REJECTED': {
      /*
       * From the Validator or Product/UX it takes the REJECTED edge from the current stage,
       * which is REWORK in every template that has one. From any other agent it is a contract
       * violation, which the cross-field rules have already caught.
       */
      const edges = statusEdges(context.graph, currentStage, 'REJECTED');
      const edge = edges[0];
      if (edge === undefined) {
        return {
          kind: 'BLOCK',
          blockerKind: 'UNRESOLVED_CONFLICT',
          reason:
            `${envelope.agent} rejected the work in ${currentStage} and this template has no `
            + 'REJECTED edge from it. Where there is nothing to rework, a rejection is a '
            + 'decision for a human rather than a lap',
          preBlockStage: currentStage,
          report: [
            envelope.summary,
            ...envelope.findings.map((f) => `${f.severity}: ${f.title}`),
          ],
        };
      }
      const exhaustion = loopExhausted(edge, context);
      if (exhaustion.exhausted) {
        return {
          kind: 'BLOCK',
          blockerKind: 'BUDGET_EXHAUSTED',
          reason:
            `the ${String(edge.counter)} loop cap is exhausted (${exhaustion.value} of `
            + `${String(exhaustion.cap)} per ${exhaustion.scope ?? 'run'})`,
          preBlockStage: currentStage,
          report: [
            `${String(edge.counter)} loop: ${exhaustion.value} of ${String(exhaustion.cap)} per ${exhaustion.scope ?? 'run'}`,
            ...envelope.findings.map((f) => `${f.severity}: ${f.title}`),
            'what was tried each time, and what a human must decide, is in the run narrative',
          ],
        };
      }
      return {
        kind: 'TRANSITION',
        edge,
        to: edge.to,
        trigger: 'envelope.REJECTED',
        overridden: envelope.next_action !== null
          && envelope.next_action.proposed_stage !== edge.to,
        proposedStage: envelope.next_action?.proposed_stage ?? null,
        evaluations: [],
      };
    }

    default:
      return assertNever(envelope.status, 'envelope status to kernel action');
  }
}

/**
 * Chooses the edge to take on a `COMPLETE` envelope.
 *
 * The agent's `next_action` is a proposal. The kernel evaluates each candidate edge's
 * predicate itself and takes the one that holds; where that is not what the agent proposed,
 * the transition is still taken and the override is logged **with both the claim and the
 * evaluated value**, so a systematically over-claiming agent becomes visible in the run
 * narrative.
 */
async function advance(
  envelope: HandoffEnvelope,
  context: TransitionContext,
): Promise<KernelAction> {
  const { currentStage, graph } = context;
  const candidates = conditionEdges(graph, currentStage);
  const evaluations: PredicateEvaluation[] = [];

  if (candidates.length === 0) {
    return {
      kind: 'BLOCK',
      blockerKind: 'UNRESOLVED_CONFLICT',
      reason:
        `stage ${currentStage} has no outgoing edge whose condition is a predicate, so a `
        + 'COMPLETE envelope has nowhere legal to go',
      preBlockStage: currentStage,
      report: [`template ${graph.template_id} has no advance or branch edge from ${currentStage}`],
    };
  }

  /* Unconditional edges first: `always` needs no evaluation and cannot be wrong. */
  const unconditional = candidates.find((edge) => edge.when === 'always');
  const conditional = candidates.filter((edge) => edge.when !== 'always');

  const holding: WorkflowEdge[] = [];
  const indeterminate: WorkflowEdge[] = [];
  for (const edge of conditional) {
    const evaluation = await context.evaluate(edge.when);
    evaluations.push(evaluation);
    if (evaluation.value === 'TRUE') holding.push(edge);
    else if (evaluation.value === 'INDETERMINATE') indeterminate.push(edge);
  }

  const chosen = holding[0] ?? unconditional ?? null;

  if (chosen === null) {
    /*
     * Nothing holds. Where an INDETERMINATE edge exists the safer-branch rule applies and
     * is resolved by the caller, which knows whether the target stage mutates; where nothing
     * is even indeterminate, the stage's exit condition is simply not met yet and the run
     * stays where it is.
     */
    if (indeterminate.length > 0) {
      return {
        kind: 'BLOCK',
        blockerKind: 'AMBIGUOUS_STATE',
        reason:
          `no edge out of ${currentStage} evaluates TRUE and `
          + `${indeterminate.length} evaluate INDETERMINATE. AgentOS does not choose a branch `
          + 'on the strength of an INDETERMINATE',
        preBlockStage: currentStage,
        report: [
          ...evaluations.map((e) => `${e.predicate} = ${e.value}: ${e.reason}`),
          'additional discovery, or a human, is what settles which branch applies',
        ],
      };
    }
    return {
      kind: 'REDISPATCH',
      reason:
        `no edge out of ${currentStage} holds yet, so the stage's exit condition is not met. `
        + 'A stage is a phase rather than a single dispatch',
      namedGaps: [],
      escalateModel: false,
    };
  }

  const exhaustion = loopExhausted(chosen, context);
  if (exhaustion.exhausted) {
    return {
      kind: 'BLOCK',
      blockerKind: 'BUDGET_EXHAUSTED',
      reason:
        `the ${String(chosen.counter)} loop cap is exhausted (${exhaustion.value} of `
        + `${String(exhaustion.cap)} per ${exhaustion.scope ?? 'run'})`,
      preBlockStage: currentStage,
      report: [
        `${String(chosen.counter)} loop: ${exhaustion.value} of ${String(exhaustion.cap)}`,
        'exceeding a cap is BLOCKED, never a quiet retry',
      ],
    };
  }

  const proposed = envelope.next_action?.proposed_stage ?? null;
  return {
    kind: 'TRANSITION',
    edge: chosen,
    to: chosen.to,
    trigger: chosen.when,
    overridden: proposed !== null && proposed !== chosen.to,
    proposedStage: proposed,
    evaluations,
  };
}

/**
 * Is a stage-to-stage transition legal over the frozen graph?
 *
 * Used to refuse a `next_action` naming a stage no edge reaches, which is the direct form of
 * "an agent does not drive the run".
 */
export function isLegalTransition(graph: FrozenGraph, from: Stage, to: Stage): boolean {
  /* Any stage may transition to BLOCKED or CANCELLED: one blocking mechanism, no state
   * explosion, and no template declares those edges. */
  if (to === 'BLOCKED' || to === 'CANCELLED') return true;
  return graph.edges.some((edge) => edge.from === from && edge.to === to);
}

/**
 * The safer-branch rule, refined.
 *
 * `INDETERMINATE` takes the branch that does more **verification** and the branch that does
 * less **irreversible mutation**. Where those point the same way, proceed. Where they point
 * in opposite directions, the kernel does not choose: it performs additional discovery, and
 * if that cannot settle it, it blocks.
 *
 * The v0.2 formulation — "take the branch that does more work" — is the special case where
 * no irreversible mutation is in play, which is every applicability predicate it was written
 * for. Taken literally at this layer it is unsafe: "we are not sure whether this was already
 * done", resolved toward more work, means doing it again, and doing it again can mean a
 * second PR, a second migration, a second notification.
 */
export type SaferBranch =
  | { readonly decision: 'TAKE'; readonly reason: string }
  | { readonly decision: 'DISCOVER'; readonly reason: string }
  | { readonly decision: 'BLOCK_AMBIGUOUS_STATE'; readonly reason: string };

export function saferBranch(
  value: PredicateValue,
  targetIsMutating: boolean,
  discoveryAvailable: boolean,
): SaferBranch {
  if (value === 'TRUE') return { decision: 'TAKE', reason: 'the predicate holds' };
  if (value === 'FALSE') {
    return { decision: 'TAKE', reason: 'the predicate does not hold, so the other arm applies' };
  }
  if (!targetIsMutating) {
    return {
      decision: 'TAKE',
      reason:
        'INDETERMINATE and the stage is non-mutating, so more verification and no more '
        + 'mutation point the same way. The cost of an unnecessary review is tokens; the cost '
        + 'of a skipped one is a defect reaching production behind a green run',
    };
  }
  if (discoveryAvailable) {
    return {
      decision: 'DISCOVER',
      reason:
        'INDETERMINATE and the stage mutates, so more verification and less irreversible '
        + 'mutation point in opposite directions. The kernel discovers rather than choosing',
    };
  }
  return {
    decision: 'BLOCK_AMBIGUOUS_STATE',
    reason:
      'INDETERMINATE after discovery, and the stage mutates. AgentOS never re-executes a '
      + 'non-reversible operation on the strength of an INDETERMINATE',
  };
}

/** Stages a `COMPLETE` envelope in this stage may legally propose, for a message. */
export function legalTargets(graph: FrozenGraph, from: Stage): readonly TemplateStage[] {
  return graph.edges
    .filter((edge) => edge.from === from)
    .map((edge) => edge.to)
    .filter((to): to is TemplateStage => to !== 'COMPLETE' && to !== 'BLOCKED' && to !== 'CANCELLED');
}
