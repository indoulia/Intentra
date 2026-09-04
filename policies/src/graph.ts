import type { TemplateStage, Stage, WorkflowEdge } from '@agentos/contracts';

/**
 * Graph arithmetic over a workflow template or a frozen run graph.
 *
 * All of it is deterministic and model-free, which is the point: "validating an arbitrary
 * model-authored graph would require the kernel to decide whether a novel stage sequence is
 * safe, which is judgment — the one thing it must not do. Validating a selection from a known
 * set is arithmetic." This module is that arithmetic, and it is shared between the policy
 * loader (which checks templates at load) and the kernel (which checks a parameterized
 * instance at run start) so the two cannot disagree about what well-formed means.
 */

export interface GraphView {
  readonly entry: TemplateStage;
  readonly stages: readonly TemplateStage[];
  readonly edges: readonly WorkflowEdge[];
}

/** Edge kinds that represent forward progress. Loops are excluded from dominance. */
const FORWARD: ReadonlySet<WorkflowEdge['kind']> = new Set(['advance', 'branch', 'terminal']);

export function outgoing(graph: GraphView, from: Stage): readonly WorkflowEdge[] {
  return graph.edges.filter((e) => e.from === from);
}

export function incoming(graph: GraphView, to: Stage): readonly WorkflowEdge[] {
  return graph.edges.filter((e) => e.to === to);
}

/** Every stage reachable from the entry over all edges, loops included. */
export function reachable(graph: GraphView): ReadonlySet<Stage> {
  return reachableFrom(graph, graph.entry, null);
}

/**
 * Every stage reachable from `start`, over the given edge kinds or over all of them.
 *
 * Two questions are asked of it. "Which stages does the run reach going forwards" decides
 * whether a stage belongs to the declared order's forward progress; "can this stage be
 * reached again from the one it points back to" decides whether a backwards edge closes a
 * legitimate cycle or is a declaration-order defect.
 */
export function reachableFrom(
  graph: GraphView,
  start: Stage,
  kinds: ReadonlySet<WorkflowEdge['kind']> | null,
): ReadonlySet<Stage> {
  const seen = new Set<Stage>([start]);
  const queue: Stage[] = [start];
  while (queue.length > 0) {
    const current = queue.shift() as Stage;
    for (const edge of graph.edges) {
      if (edge.from !== current) continue;
      if (kinds !== null && !kinds.has(edge.kind)) continue;
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return seen;
}

/**
 * Does `stage` dominate `target`: does every forward path from the entry to `target` pass
 * through `stage`?
 *
 * This is what the floor's "before" means. Expressing it as dominance rather than as a
 * position in a list is what makes it hold in a branching graph: `AUTHORIZATION before MERGE`
 * has to be true on every route to `MERGE`, not merely on the one someone had in mind.
 *
 * Loop edges are excluded, because a loop returns to a stage already visited and a path that
 * goes round a loop cannot reach `target` without first having reached it the forward way.
 */
export function dominates(graph: GraphView, stage: Stage, target: Stage): boolean {
  if (stage === target) return true;
  /* Search forward from the entry, refusing to traverse `stage`. If `target` is still
   * reachable, some path avoids `stage` and the dominance does not hold. */
  if (graph.entry === stage) return true;
  const seen = new Set<Stage>([graph.entry]);
  const queue: Stage[] = [graph.entry];
  while (queue.length > 0) {
    const current = queue.shift() as Stage;
    for (const edge of graph.edges) {
      if (edge.from !== current) continue;
      if (!FORWARD.has(edge.kind)) continue;
      if (edge.to === stage) continue;
      if (edge.to === target) return false;
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return true;
}

/**
 * Does `stage` post-dominate `from`: does every forward path from `from` to a terminal state
 * pass through `stage`?
 *
 * This is what the floor's "after" means. `IMPLEMENTATION requires VALIDATION after it` has
 * to hold on every route out of implementation, or the one route that skips it is the route a
 * run will eventually take.
 */
export function postDominates(graph: GraphView, stage: Stage, from: Stage): boolean {
  if (stage === from) return true;
  const seen = new Set<Stage>([from]);
  const queue: Stage[] = [from];
  while (queue.length > 0) {
    const current = queue.shift() as Stage;
    const forward = graph.edges.filter((e) => e.from === current && FORWARD.has(e.kind));
    if (current !== from && forward.length === 0) {
      /* A forward-terminal node other than the origin, reached without passing `stage`. */
      return false;
    }
    for (const edge of forward) {
      if (edge.to === stage) continue;
      if (edge.to === 'COMPLETE') return false;
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return true;
}

export interface WellFormedness {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * The six-part well-formedness check of WORKFLOW_STATE_MACHINE 3.4, part 6, applied to any
 * graph: a template at policy load, or a parameterized instance at run start.
 */
export function checkWellFormed(graph: GraphView): WellFormedness {
  const problems: string[] = [];
  const included = new Set<TemplateStage>(graph.stages);

  if (!included.has(graph.entry)) {
    problems.push(`the entry stage ${graph.entry} is not among the included stages`);
  }

  for (const edge of graph.edges) {
    if (!included.has(edge.from)) {
      problems.push(`edge ${edge.from} -> ${edge.to} starts at an excluded stage`);
    }
    /* An edge may end at a control state, which is never an included stage. */
    const endsAtControl = edge.to === 'COMPLETE' || edge.to === 'BLOCKED' || edge.to === 'CANCELLED';
    if (!endsAtControl && !included.has(edge.to as TemplateStage)) {
      problems.push(`edge ${edge.from} -> ${edge.to} ends at an excluded stage`);
    }
  }

  const seen = reachable(graph);
  for (const stage of graph.stages) {
    if (!seen.has(stage)) problems.push(`stage ${stage} is unreachable from the entry`);
  }

  if (!included.has('COMPLETION')) {
    problems.push('COMPLETION is not included; a run could reach a terminal state without the DoD arithmetic having run');
  } else if (!seen.has('COMPLETION')) {
    problems.push('COMPLETION is unreachable from the entry');
  }

  const toComplete = graph.edges.filter((e) => e.to === 'COMPLETE');
  if (toComplete.length === 0) {
    problems.push('no edge reaches COMPLETE');
  }
  for (const edge of toComplete) {
    if (edge.from !== 'COMPLETION') {
      problems.push(
        `${edge.from} -> COMPLETE: COMPLETION must be the sole predecessor of COMPLETE`,
      );
    }
  }

  /*
   * Branch edges are mutually exclusive alternatives and exactly one predicate must hold, so
   * the only form that can be checked mechanically is a complementary pair: `X` and `NOT X`.
   * A node with three branch edges over unrelated predicates could have none hold, or two,
   * and neither case has a defined outcome.
   */
  const branchesByNode = new Map<Stage, WorkflowEdge[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'branch') continue;
    const list = branchesByNode.get(edge.from) ?? [];
    list.push(edge);
    branchesByNode.set(edge.from, list);
  }
  for (const [node, edges] of branchesByNode) {
    if (edges.length !== 2) {
      problems.push(
        `${node} has ${edges.length} branch edges; a branch is a complementary pair, so that `
        + 'either leaves a case with no outcome or two cases with the same one',
      );
      continue;
    }
    const whens = edges.map((e) => e.when).sort();
    const positive = whens.find((w) => !w.startsWith('NOT '));
    const negative = whens.find((w) => w.startsWith('NOT '));
    if (positive === undefined || negative === undefined
      || negative !== `NOT ${positive}`) {
      problems.push(
        `${node} branches on [${whens.join(', ')}]; the pair must be X and NOT X so that `
        + 'exactly one holds',
      );
    }
  }

  /*
   * The declared stage order is the run order.
   *
   * The kernel's resume sweep walks `stages` in declaration order, so that order carries
   * meaning and has to be checked rather than assumed. Two things make it trustworthy: the
   * entry is the first stage declared, and no forward edge runs backwards through the
   * declaration unless it closes a cycle — `change_request.land` legitimately loops
   * `STRUCTURAL_REAUDIT -> PR_REVIEW` back to its own entry, and a template that merely
   * listed its stages out of order would not.
   */
  const index = new Map<TemplateStage, number>(graph.stages.map((s, i) => [s, i]));
  if (graph.stages.length > 0 && graph.stages[0] !== graph.entry) {
    problems.push(
      `the entry stage ${graph.entry} is not the first declared stage (${String(graph.stages[0])}); `
      + 'the declared order is the order the resume sweep walks, so it must start where the run does',
    );
  }
  const forwardReachable = reachableFrom(graph, graph.entry, new Set(['advance', 'branch']));
  for (const edge of graph.edges) {
    if (edge.kind !== 'advance' && edge.kind !== 'branch') continue;
    const from = index.get(edge.from);
    const to = index.get(edge.to as TemplateStage);
    if (from === undefined || to === undefined) continue;
    if (!forwardReachable.has(edge.from) || !forwardReachable.has(edge.to)) continue;
    if (from < to) continue;
    if (reachableFrom(graph, edge.to, null).has(edge.from)) continue;
    problems.push(
      `edge ${edge.from} -> ${edge.to} runs backwards through the declared stage order and `
      + 'does not close a cycle; the declared order is the order the resume sweep walks, so a '
      + 'forward edge that goes backwards in it would have the sweep classify stages out of order',
    );
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Removes stages and every edge incident to them.
 *
 * This is what excluding an optional stage does, and it is why templates carry a bypass
 * branch around each one: removing the stage removes `A -> X` and `X -> B`, and the graph is
 * still well-formed only because `A -> B` was declared. A template without the bypass fails
 * the load-time exclusion check rather than failing mid-run.
 */
export function withoutStages(
  graph: GraphView,
  excluded: ReadonlySet<TemplateStage>,
): GraphView {
  const stages = graph.stages.filter((s) => !excluded.has(s));
  const surviving = graph.edges.filter(
    (e) => !excluded.has(e.from) && !excluded.has(e.to as TemplateStage),
  );

  /*
   * A branch pair whose positive arm led to the excluded stage is now a single edge, and its
   * condition is no longer a choice: the stage was excluded because its predicate evaluated
   * FALSE, so the `NOT P` arm is the only arm and it always fires. Rewriting it as an
   * `advance` keeps the graph honest — a lone `branch` edge would claim a decision the run
   * no longer makes, and would fail the branch-pair check for a reason that is not a defect.
   */
  const branchCount = new Map<Stage, number>();
  for (const edge of surviving) {
    if (edge.kind !== 'branch') continue;
    branchCount.set(edge.from, (branchCount.get(edge.from) ?? 0) + 1);
  }
  const edges = surviving.map((edge) => {
    if (edge.kind !== 'branch') return edge;
    if (branchCount.get(edge.from) !== 1) return edge;
    return { ...edge, kind: 'advance' as const, when: 'always' };
  });
  /* The entry moves to the first surviving stage in the template's declared order, which is
   * what the kernel's entry computation would then walk from. */
  const entry = excluded.has(graph.entry) ? stages[0] : graph.entry;
  if (entry === undefined) {
    return { entry: graph.entry, stages: [], edges: [] };
  }
  return { entry, stages, edges };
}

/** Every subset of a set of exclusion groups, as sets of stages. */
export function exclusionSubsets(
  groups: ReadonlyArray<readonly TemplateStage[]>,
): ReadonlyArray<ReadonlySet<TemplateStage>> {
  const out: Array<ReadonlySet<TemplateStage>> = [];
  const total = 1 << groups.length;
  for (let mask = 0; mask < total; mask += 1) {
    const set = new Set<TemplateStage>();
    for (let i = 0; i < groups.length; i += 1) {
      if ((mask & (1 << i)) !== 0) for (const stage of groups[i] ?? []) set.add(stage);
    }
    out.push(set);
  }
  return out;
}

/** The predicate name an edge condition names, or null for `always` and envelope statuses. */
export function predicateOf(when: string): string | null {
  if (when === 'always') return null;
  if (when.startsWith('envelope.')) return null;
  return when.startsWith('NOT ') ? when.slice(4) : when;
}
