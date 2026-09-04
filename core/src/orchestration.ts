import {
  workItemIdFromContent,
  workItemIdFromExternalIdentity,
  type Assertion,
  type CancellationProposal,
  type DecompositionProposal,
  type DodProfileId,
  type HandoffEnvelope,
  type PredicateValue,
  type Scope,
  type TriageProposal,
  type WorkItem,
  type WorkItemLifecycle,
  type WorkItemLink,
  type WorkItemLinkKind,
  type WorkItemType,
} from '@agentos/contracts';
import type { PolicySet } from '@agentos/policies';
import {
  admitCancellation,
  admitDecomposition,
  routeTriage,
  startableChildren,
  type AdmittedChild,
  type CancellationResult,
  type DecompositionResult,
  type TriageRoute,
} from './proposals.js';

/**
 * What the kernel does with the structural stages — the three places a run's *shape* changes
 * because an agent read something.
 *
 * `proposals.ts` holds the rules. This holds the wiring: it turns an envelope's proposals into
 * kernel decisions, child Work Item records and the events that record them. The split is
 * deliberate — the rules are pure and exhaustively testable, and the wiring is where the
 * kernel's own state lives.
 *
 * The property every function here preserves: **the agent proposes and the kernel disposes.**
 * A triage proposal's `proposed_route` is recorded and ignored; routing is scope containment,
 * which is a set computation over a typed field fixed at admission. A decomposition is bounded
 * by the kernel's breadth and depth caps and refused on a cycle. A cancellation is admitted
 * only on adapter evidence that the outcome already holds.
 */

/* -------------------------------------------------------------------- triage ---- */

export interface TriageDecision {
  readonly threadId: string;
  /** What the agent read the comment as asking for. Judgment, and legitimately the agent's. */
  readonly reading: string;
  readonly route: TriageRoute['route'];
  /** What the agent proposed. Recorded, and never the decision. */
  readonly proposedRoute: TriageProposal['proposed_route'];
  /** True where the kernel's containment computation disagreed with the proposal. */
  readonly overridden: boolean;
  readonly reason: string;
  readonly remediationScope: Scope;
}

export interface TriageOutcome {
  readonly decisions: readonly TriageDecision[];
  /** Children the kernel must create, linked `DISCOVERED_BY`. */
  readonly children: readonly TriageDecision[];
  /** Threads whose remediation is outside scope and inseparable: `SCOPE_EXPANSION` fires. */
  readonly scopeExpansions: readonly TriageDecision[];
  /** Threads that stay in the loop, which is the default and the common case. */
  readonly inScope: readonly TriageDecision[];
}

/**
 * Routes every triage proposal in an envelope by scope containment.
 *
 * `REVIEW_TRIAGE` is agent judgment — deciding what a comment asks for requires reading it —
 * and the *consequence* of that judgment is bounded mechanically, because creating a child
 * Work Item is a state mutation and only the kernel performs one.
 */
export function triageEnvelope(
  envelope: HandoffEnvelope,
  parent: WorkItem,
): TriageOutcome {
  const decisions: TriageDecision[] = [];

  for (const proposal of envelope.proposals.triage ?? []) {
    const routed = routeTriage(proposal, parent.scope);
    decisions.push({
      threadId: proposal.thread_id,
      reading: proposal.reading,
      route: routed.route,
      proposedRoute: proposal.proposed_route,
      overridden: proposal.proposed_route !== routed.route,
      reason: routed.reason,
      remediationScope: proposal.remediation_scope,
    });
  }

  return {
    decisions,
    children: decisions.filter((d) => d.route === 'CHILD_WORK_ITEM'),
    scopeExpansions: decisions.filter((d) => d.route === 'SCOPE_EXPANSION'),
    inScope: decisions.filter((d) => d.route === 'COMMENT_RESOLUTION'),
  };
}

/**
 * External child identities the project-management adapter reported.
 *
 * Read from `current_reality.children`, and read **before** any decomposition is admitted: an
 * admitted child whose external identity already exists is linked, never recreated, and a
 * kernel that proposed first and looked afterwards would duplicate a resumed Epic's backlog
 * before it noticed.
 */
export function externalChildren(children: Assertion): readonly string[] {
  if (children.confidence === 'UNKNOWN') return [];
  const value = children.value;
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      out.push(entry);
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as { external_identity?: unknown; work_item_id?: unknown };
    if (typeof record.external_identity === 'string') out.push(record.external_identity);
    else if (typeof record.work_item_id === 'string') out.push(record.work_item_id);
  }
  return out;
}

/* ------------------------------------------------------- child work items ---- */

export interface ChildInput {
  readonly parent: WorkItem;
  readonly title: string;
  readonly type: WorkItemType;
  readonly scope: Scope;
  readonly desiredOutcome: string;
  readonly externalIdentity: string | null;
  readonly dependsOn: readonly string[];
  /** `CHILD_OF` for a decomposition child, `DISCOVERED_BY` for one triage found. */
  readonly link: WorkItemLinkKind;
  readonly now: string;
  readonly policies: PolicySet;
}

/**
 * Builds a child Work Item.
 *
 * **The kernel creates children, and only the kernel.** Two things are set here and nowhere
 * else: `decomposition_depth` is the parent's plus one — which is what makes the depth bound
 * mean anything, and what nothing in the codebase previously set above zero — and the link
 * back to the parent, so a child that arrives without one is not expressible.
 *
 * The child inherits the parent's originating trust class and source intake. It has to: the
 * `AUTONOMOUS_INTAKE_EXECUTION` gate keys on where the *work* came from, and a child whose
 * trust class reset to `OPERATOR` because the kernel created it would be a laundering route
 * for exactly the case the gate exists for.
 */
export function childWorkItem(input: ChildInput): WorkItem {
  const workItemId = input.externalIdentity !== null
    ? workItemIdFromExternalIdentity(input.externalIdentity)
    : workItemIdFromContent(input.scope, input.title);

  const entry = input.policies.workItems.types.find((t) => t.type === input.type);
  const profiles: readonly DodProfileId[] = entry?.candidate_dod_profiles ?? [];

  const links: WorkItemLink[] = [{ kind: input.link, target: input.parent.work_item_id }];

  return {
    work_item_id: workItemId,
    created_at: input.now,
    source_intake: input.parent.source_intake,
    origin_trust_class: input.parent.origin_trust_class,
    type: input.type,
    claimed_type: null,
    title: input.title,
    external_identity: input.externalIdentity,
    desired_outcome: input.desiredOutcome,
    scope: input.scope,
    constraints: input.parent.constraints,
    dependencies: [...input.dependsOn],
    lifecycle: 'RESOLVED',
    candidate_dod_profiles: profiles,
    links,
    duplicate_candidates: [],
    lease: null,
    runs: [],
    reresolution_count: 0,
    decomposition_depth: input.parent.decomposition_depth + 1,
    denied_gates: [],
    consumed_budget: { usd: 0, input_tokens: 0, output_tokens: 0, dispatches: 0, loops: {} },
  };
}

/** The parent's side of a link, so the relationship is navigable from either end. */
export function withChildLink(parent: WorkItem, childId: string): WorkItem {
  if (parent.links.some((l) => l.kind === 'PARENT_OF' && l.target === childId)) return parent;
  return { ...parent, links: [...parent.links, { kind: 'PARENT_OF', target: childId }] };
}

/* ------------------------------------------------------------ decomposition ---- */

export interface DecompositionOutcome {
  readonly result: DecompositionResult;
  /** Child records to persist. Empty where the decomposition was refused. */
  readonly created: readonly WorkItem[];
  /** Children linked rather than created, because their external identity already exists. */
  readonly linked: readonly WorkItem[];
  /**
   * Retained for a human where a bound was exceeded. The proposal is evidence, not rubbish:
   * exceeding a bound is `BLOCKED` with the proposed decomposition attached, for a human to
   * confirm or narrow.
   */
  readonly retained: readonly DecompositionProposal[];
}

export interface DecompositionInputs {
  readonly parent: WorkItem;
  readonly envelope: HandoffEnvelope;
  readonly policies: PolicySet;
  /**
   * External children read from the project-management adapter **before any are proposed**.
   * Discovery before creation: an admitted child whose external identity already exists is
   * linked, never recreated, which is what stops a resumed Epic duplicating its own backlog.
   */
  readonly existingExternalChildren: readonly string[];
  readonly now: string;
}

export function decomposeEnvelope(input: DecompositionInputs): DecompositionOutcome {
  const proposals = input.envelope.proposals.decomposition ?? [];
  const result = admitDecomposition({
    parent: input.parent,
    proposals,
    budgets: input.policies.budgets,
    existingExternalChildren: input.existingExternalChildren,
  });

  if (result.outcome === 'BLOCKED') {
    return { result, created: [], linked: [], retained: result.retained };
  }

  const records = result.children.map((child: AdmittedChild) => ({
    child,
    record: childWorkItem({
      parent: input.parent,
      title: child.title,
      type: child.type,
      scope: child.scope,
      desiredOutcome: child.desiredOutcome,
      externalIdentity: child.externalIdentity,
      dependsOn: child.dependsOn,
      link: 'CHILD_OF',
      now: input.now,
      policies: input.policies,
    }),
  }));

  return {
    result,
    created: records.filter((r) => !r.child.linked).map((r) => r.record),
    linked: records.filter((r) => r.child.linked).map((r) => r.record),
    retained: [],
  };
}

/* ------------------------------------------------------- child coordination ---- */

export interface CoordinationOutcome {
  readonly startable: readonly string[];
  readonly waiting: readonly { readonly workItemId: string; readonly on: readonly string[] }[];
  /**
   * True only where **no** child can progress. A blocked child leaves its siblings running;
   * the Epic blocks only when nothing can move, which is a different and much rarer
   * condition.
   */
  readonly epicBlocks: boolean;
  readonly cancellation: CancellationResult | null;
  readonly detail: string;
}

export interface CoordinationInputs {
  readonly parent: WorkItem;
  readonly envelope: HandoffEnvelope;
  readonly children: readonly {
    readonly workItemId: string;
    readonly dependsOn: readonly string[];
    readonly lifecycle: WorkItemLifecycle;
  }[];
  /** `reality.outcome_already_satisfied`, evaluated by the kernel from adapter evidence. */
  readonly outcomeAlreadySatisfied: PredicateValue;
}

/**
 * Coordinates a `CHILD_COORDINATION` lap.
 *
 * Three rules, all of them the kernel's:
 *
 * - Children whose declared dependencies are terminal may start; the rest wait.
 * - **A blocked child does not block its siblings.** The Epic blocks only when no child can
 *   progress.
 * - **A cancellation is a decision.** The Orchestrator may propose `SUPERSEDED` or
 *   `ABANDONED`, and it is admitted only if `reality.outcome_already_satisfied` evaluates
 *   `TRUE` from adapter evidence — otherwise it escalates to a human, because "this turned out
 *   to be unnecessary" is exactly the claim that must not be self-certified.
 */
export function coordinateChildren(input: CoordinationInputs): CoordinationOutcome {
  const startable = startableChildren(input.children);

  const proposal: CancellationProposal | undefined = input.envelope.proposals.cancellation;
  const cancellation = proposal === undefined
    ? null
    : admitCancellation(proposal.to, input.outcomeAlreadySatisfied);

  return {
    startable: startable.startable,
    waiting: startable.waiting,
    epicBlocks: startable.noneCanProgress,
    cancellation,
    detail: startable.noneCanProgress
      ? 'no child can progress, so the Epic blocks. That is a different and much rarer '
        + 'condition than a child being blocked, which leaves its siblings running'
      : `${startable.startable.length} child(ren) startable, ${startable.waiting.length} `
        + 'waiting on a declared dependency',
  };
}
