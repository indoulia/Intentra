import type { BudgetPolicy, ConsumedBudget, Cost } from '@agentos/contracts';

/**
 * Budget and loop accounting.
 *
 * Enforcement is mechanical; exceeding a cap is `BLOCKED`, never a quiet retry. And the
 * block report is what a human needs to see: **what was tried, what failed each time, and
 * what a human would need to decide.**
 *
 * Everything is counted twice, per Workflow Run and per Work Item. The second is what makes
 * it a budget: three runs of two laps each is six laps, and a budget that resets on every
 * attempt is not a budget.
 */

export type BudgetCounter =
  | { readonly kind: 'loop'; readonly name: string }
  | { readonly kind: 'cost' }
  | { readonly kind: 'dispatches' }
  | { readonly kind: 'wall_clock' };

export interface BudgetState {
  readonly run: ConsumedBudget;
  readonly workItem: ConsumedBudget;
  readonly runStartedAt: string;
}

export const ZERO_BUDGET: ConsumedBudget = {
  usd: 0,
  input_tokens: 0,
  output_tokens: 0,
  dispatches: 0,
  loops: {},
};

export function addCost(consumed: ConsumedBudget, cost: Cost): ConsumedBudget {
  return {
    ...consumed,
    usd: consumed.usd + (cost.usd ?? 0),
    input_tokens: consumed.input_tokens + cost.input_tokens,
    output_tokens: consumed.output_tokens + cost.output_tokens,
    dispatches: consumed.dispatches + 1,
  };
}

export function incrementLoop(consumed: ConsumedBudget, name: string): ConsumedBudget {
  return {
    ...consumed,
    loops: { ...consumed.loops, [name]: (consumed.loops[name] ?? 0) + 1 },
  };
}

export type BudgetVerdict =
  | { readonly within: true }
  | {
    readonly within: false;
    readonly counter: string;
    readonly scope: 'run' | 'work_item';
    readonly value: number;
    readonly cap: number;
    /** What was tried, for the block report. A cap with no story is not actionable. */
    readonly report: readonly string[];
  };

/** Would one more dispatch exceed a cap? Checked before dispatching, not after. */
export function checkDispatchBudget(
  state: BudgetState,
  budgets: BudgetPolicy,
  now: Date,
): BudgetVerdict {
  const runDispatches = state.run.dispatches + 1;
  if (runDispatches > budgets.dispatches.per_run) {
    return {
      within: false,
      counter: 'dispatches',
      scope: 'run',
      value: runDispatches,
      cap: budgets.dispatches.per_run,
      report: [
        `this run has dispatched ${state.run.dispatches} time(s) against a cap of `
        + `${budgets.dispatches.per_run}`,
        'a run that keeps dispatching without converging is a run a human should look at',
      ],
    };
  }
  const workItemDispatches = state.workItem.dispatches + 1;
  if (workItemDispatches > budgets.dispatches.per_work_item) {
    return {
      within: false,
      counter: 'dispatches',
      scope: 'work_item',
      value: workItemDispatches,
      cap: budgets.dispatches.per_work_item,
      report: [
        `this work item has dispatched ${state.workItem.dispatches} time(s) across all runs, `
        + `against a cap of ${budgets.dispatches.per_work_item}`,
        'the per-work-item cap is what stops a budget resetting on every attempt',
      ],
    };
  }

  if (state.run.usd >= budgets.cost.run_usd) {
    return {
      within: false,
      counter: 'cost.run_usd',
      scope: 'run',
      value: state.run.usd,
      cap: budgets.cost.run_usd,
      report: [
        `this run has spent ${state.run.usd.toFixed(2)} against a ceiling of `
        + budgets.cost.run_usd.toFixed(2),
        'continuing past a cost ceiling is a decision, which is why it is a gate',
      ],
    };
  }
  if (state.workItem.usd >= budgets.cost.work_item_usd) {
    return {
      within: false,
      counter: 'cost.work_item_usd',
      scope: 'work_item',
      value: state.workItem.usd,
      cap: budgets.cost.work_item_usd,
      report: [
        `this work item has spent ${state.workItem.usd.toFixed(2)} across all runs against a `
        + `ceiling of ${budgets.cost.work_item_usd.toFixed(2)}`,
      ],
    };
  }

  const elapsed = now.getTime() - Date.parse(state.runStartedAt);
  if (Number.isFinite(elapsed) && elapsed > budgets.wall_clock_ms.run) {
    return {
      within: false,
      counter: 'wall_clock_ms.run',
      scope: 'run',
      value: elapsed,
      cap: budgets.wall_clock_ms.run,
      report: [
        `this run has been going for ${Math.round(elapsed / 60000)} minutes against a limit of `
        + `${Math.round(budgets.wall_clock_ms.run / 60000)}`,
      ],
    };
  }

  return { within: true };
}

/** The dispatch-level budget an input package carries. */
export function dispatchBudget(budgets: BudgetPolicy): {
  readonly max_usd: number;
  readonly max_turns: number;
  readonly max_wall_clock_ms: number;
} {
  return {
    max_usd: budgets.cost.dispatch_usd,
    max_turns: budgets.max_turns_per_dispatch,
    max_wall_clock_ms: budgets.wall_clock_ms.dispatch,
  };
}

/** Whether the re-resolution cap allows another attempt (default 1). */
export function reresolutionAllowed(
  alreadyUsed: number,
  budgets: BudgetPolicy,
): { readonly allowed: boolean; readonly cap: number; readonly reason: string } {
  const cap = budgets.reresolution;
  if (alreadyUsed < cap) {
    return {
      allowed: true,
      cap,
      reason: `re-resolution ${alreadyUsed + 1} of ${cap}`,
    };
  }
  return {
    allowed: false,
    cap,
    reason:
      `re-resolution is capped at ${cap}. A second re-resolution means the work is not `
      + 'understood, and BLOCKED with a human is better than a third guess',
  };
}

/**
 * Whether one more discovery loop is affordable, per run and per work item.
 *
 * The discovery loop is the one an on-demand probe spends: the uncertainty ladder's rung 2,
 * the targeted probe the resume sweep dispatches for an `INDETERMINATE` mutating stage, and
 * the re-resolution those can lead to. It is bounded precisely so that "the kernel discovers
 * rather than choosing" cannot become "the kernel discovers forever" — and a counter nothing
 * increments is a bound nothing enforces.
 */
export function discoveryLoopAllowed(
  consumed: { readonly run: number; readonly workItem: number },
  budgets: BudgetPolicy,
): {
    readonly allowed: boolean;
    readonly scope: 'run' | 'work_item' | null;
    readonly value: number;
    readonly cap: number;
    readonly reason: string;
  } {
  const cap = budgets.loops.discovery;
  const run = consumed.run + 1;
  if (run > cap.per_run) {
    return {
      allowed: false,
      scope: 'run',
      value: run,
      cap: cap.per_run,
      reason:
        `the discovery loop is spent for this run (${run} of ${cap.per_run}). Exceeding a cap `
        + 'is BLOCKED or a stop, never a quiet retry',
    };
  }
  const workItem = consumed.workItem + 1;
  if (workItem > cap.per_work_item) {
    return {
      allowed: false,
      scope: 'work_item',
      value: workItem,
      cap: cap.per_work_item,
      reason:
        `the discovery loop is spent for this work item (${workItem} of `
        + `${cap.per_work_item}) across all its runs. A budget that resets on every attempt is `
        + 'not a budget',
    };
  }
  return {
    allowed: true,
    scope: null,
    value: run,
    cap: cap.per_run,
    reason: `discovery loop ${run} of ${cap.per_run} this run, ${workItem} of `
      + `${cap.per_work_item} this work item`,
  };
}

/** Whether a proposed decomposition is within the breadth and depth bounds. */
export function decompositionWithinBounds(
  childCount: number,
  depth: number,
  budgets: BudgetPolicy,
): {
    readonly within: boolean;
    readonly reason: string;
    readonly bound: 'children' | 'depth' | null;
  } {
  if (childCount > budgets.decomposition.max_children) {
    return {
      within: false,
      bound: 'children',
      reason:
        `${childCount} children against a bound of ${budgets.decomposition.max_children}. `
        + 'Exceeding it is not a silent truncation and not a refusal: it is BLOCKED with the '
        + 'proposed decomposition attached, for a human to confirm or narrow. Each child '
        + 'carries its own run and its own budget, so an unbounded decomposition is an '
        + 'unbounded cost commitment',
    };
  }
  if (depth > budgets.decomposition.max_depth) {
    return {
      within: false,
      bound: 'depth',
      reason:
        `nesting depth ${depth} against a bound of ${budgets.decomposition.max_depth}`,
    };
  }
  return {
    within: true,
    bound: null,
    reason:
      `${childCount} children at depth ${depth}, within ${budgets.decomposition.max_children} `
      + `and ${budgets.decomposition.max_depth}`,
  };
}

/** A human-readable summary of consumption, for the live view. */
export function summarize(state: BudgetState, budgets: BudgetPolicy): readonly string[] {
  const lines = [
    `cost: ${state.run.usd.toFixed(2)} of ${budgets.cost.run_usd.toFixed(2)} this run, `
    + `${state.workItem.usd.toFixed(2)} of ${budgets.cost.work_item_usd.toFixed(2)} this work item`,
    `dispatches: ${state.run.dispatches} of ${budgets.dispatches.per_run} this run, `
    + `${state.workItem.dispatches} of ${budgets.dispatches.per_work_item} this work item`,
    `tokens: ${state.run.input_tokens} in, ${state.run.output_tokens} out`,
  ];
  for (const [name, cap] of Object.entries(budgets.loops)) {
    const run = state.run.loops[name] ?? 0;
    const workItem = state.workItem.loops[name] ?? 0;
    if (run === 0 && workItem === 0) continue;
    lines.push(
      `${name} loop: ${run} of ${cap.per_run} this run, ${workItem} of ${cap.per_work_item} `
      + 'this work item',
    );
  }
  return lines;
}
