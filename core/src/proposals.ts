import type {
  BudgetPolicy,
  DecompositionProposal,
  PredicateValue,
  Scope,
  TriageProposal,
  Violation,
  WorkItem,
  WorkItemLifecycle,
  WorkItemType,
} from '@agentos/contracts';
import { workItemIdFromContent, workItemIdFromExternalIdentity } from '@agentos/contracts';
import { decompositionWithinBounds } from './budgets.js';
import { pathMatches } from './predicates.js';
import { scopeContained } from './workflow-admission.js';

/**
 * What the kernel does with the structural proposals an agent may make.
 *
 * Every one of these is a judgment an agent is right to make and a *consequence* the kernel
 * bounds mechanically. Triage is agent judgment — deciding what a comment asks for requires
 * reading it — but creating a child Work Item is a state mutation and only the kernel
 * performs one. Decomposition is the Architect's mandate, and the breadth and depth bounds
 * are the kernel's. Cancellation is a proposal, and admitting it needs adapter evidence.
 */

/* ------------------------------------------------------------------- triage ---- */

export type TriageRoute =
  | {
    /** Inside the parent's admitted scope. Always. */
    readonly route: 'COMMENT_RESOLUTION';
    readonly threadId: string;
    readonly reason: string;
  }
  | {
    /** Outside scope, separable. A child Work Item, linked DISCOVERED_BY. */
    readonly route: 'CHILD_WORK_ITEM';
    readonly threadId: string;
    readonly reason: string;
    readonly scope: Scope;
  }
  | {
    /** Outside scope, inseparable. The change cannot land without it. */
    readonly route: 'SCOPE_EXPANSION';
    readonly threadId: string;
    readonly reason: string;
    readonly scope: Scope;
  };

/**
 * Routes a triage proposal by scope containment.
 *
 * **Routed by the kernel, not by `proposed_route`.** Scope is a typed field fixed at
 * admission, so containment is a set computation and not an opinion — and the three outcomes
 * are the only three.
 *
 * **Undeterminable containment counts as inside scope.** The refined safer-branch rule
 * applied: creating work items multiplies external side effects, so the uncertain branch is
 * the one that creates none. A comment that turns out to need its own item surfaces again at
 * the next triage, with more evidence.
 */
export function routeTriage(
  proposal: TriageProposal,
  parentScope: Scope,
): TriageRoute {
  const remediation = proposal.remediation_scope;
  const inside = scopeContained(remediation, parentScope);

  if (inside) {
    return {
      route: 'COMMENT_RESOLUTION',
      threadId: proposal.thread_id,
      reason:
        'the remediation falls inside the work item\'s admitted scope. "Add a test covering '
        + 'restart recovery" is inside the scope of the defect whose fix is restart recovery, '
        + 'and no new Defect or Story is created for it',
    };
  }

  const undeterminable = remediation.paths.length === 0
    && remediation.capabilities.length === 0;
  if (undeterminable) {
    return {
      route: 'COMMENT_RESOLUTION',
      threadId: proposal.thread_id,
      reason:
        'the remediation names no paths and no capabilities, so containment is '
        + 'undeterminable — and undeterminable counts as inside. Creating work items '
        + 'multiplies external side effects, so the uncertain branch is the one that creates '
        + 'none; a comment that turns out to need its own item surfaces again at the next '
        + 'triage with more evidence',
    };
  }

  /*
   * Outside the scope. Separability is the agent's reading, and it is the one part of this
   * the kernel cannot compute — so `INDETERMINATE` takes the branch that creates nothing new
   * and asks a human instead, which is what SCOPE_EXPANSION is.
   */
  if (proposal.separable === 'TRUE') {
    return {
      route: 'CHILD_WORK_ITEM',
      threadId: proposal.thread_id,
      reason:
        'the remediation falls outside the admitted scope and is separable, so it becomes a '
        + 'child Work Item linked DISCOVERED_BY. It is a real finding, it is genuinely '
        + 'different work, and folding it into this PR would silently widen a change a '
        + 'reviewer already approved in scope. The parent does not wait for it',
      scope: remediation,
    };
  }

  return {
    route: 'SCOPE_EXPANSION',
    threadId: proposal.thread_id,
    reason: proposal.separable === 'FALSE'
      ? 'the remediation falls outside the admitted scope and cannot be split off — the same '
        + 'function, no way to fix one without the other. The human either widens the mandate '
        + 'or accepts the split'
      : 'the remediation falls outside the admitted scope and whether it is separable is '
        + 'INDETERMINATE. The uncertain branch is the one that creates no new work item, so '
        + 'this asks rather than guessing',
    scope: remediation,
  };
}

/* ------------------------------------------------------------ decomposition ---- */

export interface AdmittedChild {
  readonly workItemId: string;
  readonly title: string;
  readonly type: WorkItemType;
  readonly scope: Scope;
  readonly desiredOutcome: string;
  readonly externalIdentity: string | null;
  readonly dependsOn: readonly string[];
  /** True where the external identity already exists and this is a link rather than a create. */
  readonly linked: boolean;
}

export type DecompositionResult =
  | {
    readonly outcome: 'ADMITTED';
    readonly children: readonly AdmittedChild[];
    readonly reason: string;
  }
  | {
    /**
     * Exceeding a bound is not a silent truncation and not a refusal — it is `BLOCKED` with
     * the proposal retained as evidence, for a human to confirm or narrow.
     */
    readonly outcome: 'BLOCKED';
    readonly reason: string;
    readonly retained: readonly DecompositionProposal[];
    readonly violation: Violation;
  };

export interface DecompositionInput {
  readonly parent: WorkItem;
  readonly proposals: readonly DecompositionProposal[];
  readonly budgets: BudgetPolicy;
  /**
   * External children read from the project-management adapter **before any are proposed**.
   * An admitted child whose external identity already exists is linked, never recreated —
   * which is what stops a resumed Epic from duplicating its own backlog.
   */
  readonly existingExternalChildren: readonly string[];
}

export function admitDecomposition(input: DecompositionInput): DecompositionResult {
  const { parent, proposals, budgets } = input;
  const depth = parent.decomposition_depth + 1;
  const bounds = decompositionWithinBounds(proposals.length, depth, budgets);

  if (!bounds.within) {
    return {
      outcome: 'BLOCKED',
      reason: bounds.reason,
      retained: proposals,
      violation: {
        code: 'DECOMPOSITION_BOUND_EXCEEDED',
        rule: 'INTENT_AND_WORK_ITEM_RESOLUTION section 10',
        message: bounds.reason,
        path: '/proposals/decomposition',
        handled_as: 'BLOCKED',
        subject: parent.work_item_id,
      },
    };
  }

  /* Scope containment: a child's scope must fall inside the parent's admitted scope. */
  const escaping = proposals.filter((child) => !scopeContained(child.scope, parent.scope));
  if (escaping.length > 0) {
    const reason =
      `${escaping.map((c) => c.title).join(', ')} propose a scope outside the parent's `
      + 'admitted scope. A child is a work unit that earned its own identity, not a way to '
      + 'widen the mandate';
    return {
      outcome: 'BLOCKED',
      reason,
      retained: proposals,
      violation: {
        code: 'SCOPE_EXCEEDS_WORK_ITEM',
        rule: 'INTENT_AND_WORK_ITEM_RESOLUTION section 10',
        message: reason,
        path: '/proposals/decomposition',
        handled_as: 'BLOCKED',
        subject: parent.work_item_id,
      },
    };
  }

  const children: AdmittedChild[] = proposals.map((proposal) => {
    const linked = proposal.external_identity !== null
      && input.existingExternalChildren.includes(proposal.external_identity);
    const workItemId = proposal.external_identity !== null
      ? workItemIdFromExternalIdentity(proposal.external_identity)
      : workItemIdFromContent(proposal.scope, proposal.title);
    return {
      workItemId,
      title: proposal.title,
      type: proposal.type,
      scope: proposal.scope,
      desiredOutcome: proposal.desired_outcome,
      externalIdentity: proposal.external_identity,
      dependsOn: proposal.depends_on,
      linked,
    };
  });

  /* Dependency cycles are refused. The kernel enforces ordering from the declared edges. */
  const cycle = findCycle(children);
  if (cycle !== null) {
    const reason = `the declared dependencies form a cycle: ${cycle.join(' -> ')}`;
    return {
      outcome: 'BLOCKED',
      reason,
      retained: proposals,
      violation: {
        code: 'DECOMPOSITION_CYCLE',
        rule: 'INTENT_AND_WORK_ITEM_RESOLUTION section 10',
        message: reason,
        path: '/proposals/decomposition',
        handled_as: 'BLOCKED',
        subject: parent.work_item_id,
      },
    };
  }

  const linkedCount = children.filter((c) => c.linked).length;
  return {
    outcome: 'ADMITTED',
    children,
    reason:
      `${children.length} child(ren) at depth ${depth}`
      + (linkedCount > 0
        ? `, ${linkedCount} of which already exist externally and are linked rather than `
          + 'recreated — which is what stops a resumed Epic from duplicating its own backlog'
        : ''),
  };
}

/** Topological check over the declared dependency edges, by title or external identity. */
function findCycle(children: readonly AdmittedChild[]): readonly string[] | null {
  const byName = new Map<string, AdmittedChild>();
  for (const child of children) {
    byName.set(child.title, child);
    if (child.externalIdentity !== null) byName.set(child.externalIdentity, child);
    byName.set(child.workItemId, child);
  }

  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (child: AdmittedChild): readonly string[] | null => {
    const current = state.get(child.workItemId);
    if (current === 'done') return null;
    if (current === 'visiting') return [...path, child.title];
    state.set(child.workItemId, 'visiting');
    path.push(child.title);
    for (const dependency of child.dependsOn) {
      const target = byName.get(dependency);
      if (target === undefined) continue;
      const found = visit(target);
      if (found !== null) return found;
    }
    path.pop();
    state.set(child.workItemId, 'done');
    return null;
  };

  for (const child of children) {
    const found = visit(child);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Which children may start.
 *
 * A child whose dependency is not terminal does not start. **A blocked child does not block
 * its siblings** — the Epic blocks only when no child can progress, which is a different
 * condition and a much rarer one.
 */
export function startableChildren(
  children: readonly { readonly workItemId: string; readonly dependsOn: readonly string[]; readonly lifecycle: WorkItemLifecycle }[],
): {
    readonly startable: readonly string[];
    readonly waiting: readonly { readonly workItemId: string; readonly on: readonly string[] }[];
    readonly noneCanProgress: boolean;
  } {
  const terminal = new Set(['ACHIEVED', 'ABANDONED', 'SUPERSEDED']);
  const byId = new Map(children.map((c) => [c.workItemId, c]));
  const startable: string[] = [];
  const waiting: { workItemId: string; on: readonly string[] }[] = [];

  for (const child of children) {
    if (terminal.has(child.lifecycle)) continue;
    if (child.lifecycle === 'BLOCKED') continue;
    const unmet = child.dependsOn.filter((id) => {
      const dependency = byId.get(id);
      return dependency !== undefined && !terminal.has(dependency.lifecycle);
    });
    if (unmet.length === 0) startable.push(child.workItemId);
    else waiting.push({ workItemId: child.workItemId, on: unmet });
  }

  const anyNonTerminal = children.some((c) => !terminal.has(c.lifecycle));
  return {
    startable,
    waiting,
    noneCanProgress: anyNonTerminal && startable.length === 0,
  };
}

/* ------------------------------------------------------------- cancellation ---- */

export type CancellationResult =
  | { readonly outcome: 'ADMITTED'; readonly to: 'SUPERSEDED' | 'ABANDONED'; readonly reason: string }
  | { readonly outcome: 'ESCALATED'; readonly reason: string };

/**
 * Admits a cancellation proposal.
 *
 * **Child cancellation is a decision.** The Orchestrator may propose `SUPERSEDED` or
 * `ABANDONED`, and the kernel admits it only if `reality.outcome_already_satisfied` evaluates
 * `TRUE` from adapter evidence. Otherwise it escalates to a human, because "this turned out
 * to be unnecessary" is exactly the claim that should not be self-certified.
 */
export function admitCancellation(
  to: 'SUPERSEDED' | 'ABANDONED',
  outcomeAlreadySatisfied: PredicateValue,
): CancellationResult {
  if (outcomeAlreadySatisfied === 'TRUE') {
    return {
      outcome: 'ADMITTED',
      to,
      reason:
        'reality.outcome_already_satisfied evaluates TRUE from adapter evidence, so the '
        + 'outcome this work item existed for observably already holds',
    };
  }
  return {
    outcome: 'ESCALATED',
    reason:
      `reality.outcome_already_satisfied evaluates ${outcomeAlreadySatisfied}, so the `
      + 'cancellation escalates to a human. "This turned out to be unnecessary" is exactly '
      + 'the claim that should not be self-certified',
  };
}

/* ------------------------------------------------------- scope containment ---- */

/** Does a path fall inside a work item's admitted scope? The adapters' rule, exposed. */
export function pathInScope(path: string, scope: Scope): boolean {
  return scope.paths.some((entry) => pathMatches(path, entry));
}
