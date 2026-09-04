import type {
  Assertion,
  BudgetPolicy,
  CapabilityRecord,
  Clock,
  ContextPackage,
  CurrentReality,
  DiscoveryPort,
  MutationEvent,
  PredicateDefinition,
  PredicateValue,
  RealityElement,
  Scope,
  WorkItem,
} from '@agentos/contracts';
import type { PolicySet } from '@agentos/policies';
import { globToRegExp } from './reconciliation.js';

/**
 * Predicate evaluation.
 *
 * A transition table whose branch conditions are prose is a table an agent decides. Every
 * conditional edge names a predicate the kernel evaluates itself, over the Context Package,
 * the capability registry, Current Reality and the dispatch's mutation events. The agent's
 * opinion is recorded as a claim and is never the decision.
 *
 * Two rules govern every evaluator here:
 *
 * - **A predicate over an `UNKNOWN` assertion is `INDETERMINATE`, never `FALSE`.** Missing
 *   knowledge is not a negative answer, and treating it as one is how a stage gets skipped
 *   because discovery failed to look.
 * - **Reality is re-probed, not snapshotted.** A `STALE` element is re-probed before the
 *   predicate is evaluated, and a stale element never decides a transition. Git and PR state
 *   expire in minutes, and evaluating `reality.pr_has_unresolved_comments` against a package
 *   assembled two stages ago would mean a review comment arriving mid-implementation is
 *   invisible for the rest of the run.
 */

export interface PredicateInputs {
  readonly context: ContextPackage;
  readonly workItem: WorkItem | null;
  readonly capabilities: readonly CapabilityRecord[];
  /** Mutation events for the current dispatch, for the applicability predicates. */
  readonly mutations: readonly MutationEvent[];
  /** The agent's claim about this predicate, recorded and ignored. */
  readonly claim?: string | null;
  /**
   * The stage being asked about, where the predicate is about a stage rather than about the
   * world. Only `reality.stage_completed_previously` reads it, and it reads it because
   * "did we analyse this" is a question about a particular stage.
   */
  readonly stage?: string | null;
}

export interface PredicateEvaluation {
  readonly predicate: string;
  readonly value: PredicateValue;
  readonly claim: string | null;
  readonly inputs: readonly string[];
  readonly reprobed: boolean;
  readonly reason: string;
}

/** The truthiness of an assertion, in three values rather than two. */
export function assertionTruth(assertion: Assertion | undefined): PredicateValue {
  if (assertion === undefined) return 'INDETERMINATE';
  if (assertion.confidence === 'UNKNOWN') return 'INDETERMINATE';
  const value = assertion.value;
  if (value === null || value === undefined) return 'INDETERMINATE';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (Array.isArray(value)) return value.length > 0 ? 'TRUE' : 'FALSE';
  if (typeof value === 'object') return 'TRUE';
  if (typeof value === 'string') return value.length > 0 ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return value !== 0 ? 'TRUE' : 'FALSE';
  return 'INDETERMINATE';
}

/**
 * An unknown reality field, printed for a reason string.
 *
 * A reality element's fields are `unknown` because their shape is the adapter's business.
 * Interpolating one directly would put `[object Object]` into the reason a human reads when
 * asking why a run went where it went.
 */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return 'absent';
  return JSON.stringify(value);
}

export function negate(value: PredicateValue): PredicateValue {
  /* INDETERMINATE negates to itself: not knowing whether something holds is not knowing
   * whether it fails either. */
  if (value === 'TRUE') return 'FALSE';
  if (value === 'FALSE') return 'TRUE';
  return 'INDETERMINATE';
}

/** Reads a field out of a reality assertion's value. */
function field(assertion: Assertion | undefined, name: string): unknown {
  if (assertion === undefined) return undefined;
  if (assertion.confidence === 'UNKNOWN') return undefined;
  const value = assertion.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[name];
}

/** Freshness: is this element current enough to decide a transition on? */
export function isStale(
  assertion: Assertion | undefined,
  freshnessClass: PredicateDefinition['freshness_class'],
  budgets: BudgetPolicy,
  now: Date,
): boolean {
  if (assertion === undefined) return true;
  if (assertion.freshness === 'STALE') return true;
  if (assertion.freshness === 'UNKNOWN') return true;
  const windowMs = budgets.freshness_windows_ms[freshnessClass];
  const observed = Date.parse(assertion.observed_at);
  if (!Number.isFinite(observed)) return true;
  return now.getTime() - observed > windowMs;
}

/** Which reality element each reality predicate reads, for the re-probe. */
const REALITY_ELEMENT: Readonly<Record<string, RealityElement>> = {
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
  'regression.suspected': 'outcome_evidence',
};

const TERMINAL_LIFECYCLES = new Set(['ACHIEVED', 'ABANDONED', 'SUPERSEDED']);

/**
 * The predicate evaluator.
 *
 * Constructed with the policy set and the ports it needs, then asked for a value. It holds
 * no state between evaluations except a cache of elements it re-probed during one, so that
 * evaluating three predicates over `reviews` in one decision does not probe three times.
 */
export class PredicateEvaluator {
  #reprobed = new Map<RealityElement, Assertion>();

  constructor(
    private readonly policies: PolicySet,
    private readonly clock: Clock,
    private readonly discovery: DiscoveryPort | null,
  ) {}

  /** Clears the per-decision re-probe cache. Called once per transition decision. */
  freshen(): void {
    this.#reprobed.clear();
  }

  definition(name: string): PredicateDefinition {
    const definition = this.policies.predicates.get(name);
    if (definition === undefined) {
      throw new Error(
        `no predicate named ${name}; policy load should have refused any reference to it`,
      );
    }
    return definition;
  }

  /**
   * Evaluates a named predicate, re-probing any stale reality element first.
   *
   * `NOT x` is accepted, so an edge condition can be passed straight in.
   */
  async evaluate(
    name: string,
    inputs: PredicateInputs,
  ): Promise<PredicateEvaluation> {
    if (name === 'always') {
      return {
        predicate: name,
        value: 'TRUE',
        claim: inputs.claim ?? null,
        inputs: [],
        reprobed: false,
        reason: 'unconditional',
      };
    }
    if (name.startsWith('NOT ')) {
      const inner = await this.evaluate(name.slice(4), inputs);
      return {
        ...inner,
        predicate: name,
        value: negate(inner.value),
        reason: `negation of ${inner.predicate}: ${inner.reason}`,
      };
    }

    const definition = this.definition(name);
    let reprobed = false;
    let reality = inputs.context.current_reality;

    if (definition.family === 'reality') {
      const element = REALITY_ELEMENT[name];
      if (element !== undefined) {
        const current = reality[element];
        if (isStale(current, definition.freshness_class, this.policies.budgets, this.clock.now())) {
          const fresh = await this.#reprobe(element, inputs);
          if (fresh !== null) {
            reality = { ...reality, [element]: fresh };
            reprobed = true;
          }
        }
      }
    }

    const value = this.#evaluate(definition, { ...inputs, reality });
    return {
      predicate: name,
      value: value.value,
      claim: inputs.claim ?? null,
      inputs: definition.reads,
      reprobed,
      reason: value.reason,
    };
  }

  async #reprobe(
    element: RealityElement,
    inputs: PredicateInputs,
  ): Promise<Assertion | null> {
    const cached = this.#reprobed.get(element);
    if (cached !== undefined) return cached;
    if (this.discovery === null) return null;
    const scope: Scope = inputs.workItem?.scope ?? {
      paths: [], capabilities: [], repositories: [],
    };
    const fresh = await this.discovery.reprobeReality(element, inputs.workItem, scope);
    this.#reprobed.set(element, fresh);
    return fresh;
  }

  #evaluate(
    definition: PredicateDefinition,
    inputs: PredicateInputs & { readonly reality: CurrentReality },
  ): { readonly value: PredicateValue; readonly reason: string } {
    const { reality, context, workItem, capabilities, mutations } = inputs;

    switch (definition.evaluator) {
      /* ------------------------------------------------- applicability ---- */

      case 'auditApplicable': {
        const intersecting = workItem === null
          ? capabilities.length > 0
          : capabilities.some((c) => scopesIntersect(c.scope_paths, workItem.scope.paths));
        if (intersecting) {
          return { value: 'TRUE', reason: 'a capability record intersects the work item scope' };
        }
        const commits = context.git_state['commit_count'];
        const hasHistory = assertionTruth(commits);
        if (hasHistory === 'TRUE') {
          return { value: 'TRUE', reason: 'the repository has commit history' };
        }
        if (hasHistory === 'INDETERMINATE') {
          return {
            value: 'INDETERMINATE',
            reason: 'no capability record intersects the scope and commit history is UNKNOWN',
          };
        }
        return {
          value: 'FALSE',
          reason: 'no capability record intersects the scope and the repository has no commits',
        };
      }

      case 'architectureRequired': {
        /*
         * A contract boundary is touched when a planned or actual change reaches a declared
         * one. "Planned" is the work item scope; "actual" is the dispatch's mutation events.
         * Both are checked, because the predicate has to be answerable before implementation
         * and after it.
         */
        const boundaries = contractBoundaries(context);
        const paths = [
          ...(workItem?.scope.paths ?? []),
          ...mutations.map((m) => m.target),
        ];
        const touched = paths.some((path) => boundaries.some((b) => pathMatches(path, b)));
        if (touched) {
          return { value: 'TRUE', reason: 'the scope or a mutation reaches a declared contract boundary' };
        }
        const ownership = context.domain_model['canonical_ownership'];
        if (assertionTruth(ownership) === 'INDETERMINATE' && boundaries.length === 0) {
          return {
            value: 'INDETERMINATE',
            reason: 'no contract boundary was discovered and canonical ownership is UNKNOWN, so '
              + 'whether one is touched cannot be established',
          };
        }
        return { value: 'FALSE', reason: 'nothing in scope reaches a declared contract boundary' };
      }

      case 'uxRequired': {
        const surfaces = surfacePaths(context);
        if (surfaces.length === 0) {
          const uiMap = context.ui_map['surfaces'];
          if (assertionTruth(uiMap) === 'INDETERMINATE') {
            return {
              value: 'INDETERMINATE',
              reason: 'the ui_map is UNKNOWN, so whether a surface is touched cannot be established',
            };
          }
          return { value: 'FALSE', reason: 'context.ui_map is empty' };
        }
        const paths = [
          ...(workItem?.scope.paths ?? []),
          ...mutations.map((m) => m.target),
        ];
        const touched = paths.some((path) => surfaces.some((s) => pathMatches(path, s)));
        return touched
          ? { value: 'TRUE', reason: 'a path in scope or a mutation is under a ui_map surface' }
          : { value: 'FALSE', reason: 'no path in scope is under a ui_map surface' };
      }

      case 'productionApplicable': {
        const environments = context.runtime_state['environments'];
        const truth = assertionTruth(environments);
        if (truth === 'INDETERMINATE') {
          return {
            value: 'INDETERMINATE',
            reason: 'the environment topology is UNKNOWN. No topology discovered means every '
              + 'reachable runtime is production, and that is a classification the adapter '
              + 'makes rather than a predicate value',
          };
        }
        if (truth === 'FALSE') {
          return { value: 'FALSE', reason: 'no environments were discovered' };
        }
        const value = environments?.value;
        const list = Array.isArray(value) ? value : [];
        const hasProduction = list.some(
          (entry) => typeof entry === 'object' && entry !== null
            && (entry as { classification?: unknown }).classification === 'PRODUCTION',
        );
        return hasProduction
          ? { value: 'TRUE', reason: 'a discovered environment is classified production' }
          : { value: 'FALSE', reason: 'no discovered environment is classified production' };
      }

      /* ------------------------------------------------------- reality ---- */

      case 'realityAssertionTruthy': {
        const element = REALITY_ELEMENT[definition.name];
        const assertion = element === undefined ? undefined : reality[element];
        const value = assertionTruth(assertion);
        return {
          value,
          reason: value === 'INDETERMINATE'
            ? `current_reality.${String(element)} is UNKNOWN, and a predicate over an UNKNOWN `
              + 'assertion is INDETERMINATE, never FALSE'
            : `current_reality.${String(element)} is ${value}`,
        };
      }

      case 'prOpen': {
        const pr = reality.pr;
        if (assertionTruth(pr) === 'INDETERMINATE') {
          return {
            value: 'INDETERMINATE',
            reason: 'the PR element is UNKNOWN. An unreachable git host makes it UNAVAILABLE, '
              + 'which is emphatically not "there is no PR"',
          };
        }
        const state = field(pr, 'state');
        if (state === undefined) return { value: 'FALSE', reason: 'no pull request for this scope' };
        return state === 'OPEN'
          ? { value: 'TRUE', reason: 'the pull request is open' }
          : { value: 'FALSE', reason: `the pull request state is ${describe(state)}` };
      }

      case 'prMerged': {
        const pr = reality.pr;
        const merge = reality.merge_state;
        if (assertionTruth(pr) === 'INDETERMINATE' && assertionTruth(merge) === 'INDETERMINATE') {
          return { value: 'INDETERMINATE', reason: 'both the PR and the merge state are UNKNOWN' };
        }
        const merged = field(pr, 'state') === 'MERGED' || field(merge, 'state') === 'MERGED';
        return merged
          ? { value: 'TRUE', reason: 'the change is merged' }
          : { value: 'FALSE', reason: 'the change is not merged' };
      }

      case 'prApproved': {
        const reviews = reality.reviews;
        if (assertionTruth(reviews) === 'INDETERMINATE') {
          return { value: 'INDETERMINATE', reason: 'the review state is UNKNOWN' };
        }
        const approved = field(reviews, 'approved');
        const unresolved = field(reviews, 'unresolved_threads');
        const count = typeof unresolved === 'number' ? unresolved : 0;
        if (approved === true && count === 0) {
          return { value: 'TRUE', reason: 'approved for the current head with no unresolved threads' };
        }
        return {
          value: 'FALSE',
          reason: approved === true
            ? `approved with ${count} unresolved thread(s)`
            : 'not approved for the current head',
        };
      }

      case 'prReviewed': {
        /*
         * "Has a review happened", not "was it favourable". PR_REVIEW's mutation is obtaining
         * the review, and a review that requested changes has occurred — which is why this is
         * PR_REVIEW's `satisfied_by` and `prApproved` is not. A review count is used where the
         * adapter supplies one; otherwise an approval or an unresolved thread is proof that
         * somebody reviewed, and neither being present means nobody has.
         */
        const reviews = reality.reviews;
        if (assertionTruth(reviews) === 'INDETERMINATE') {
          return {
            value: 'INDETERMINATE',
            reason: 'the review state is UNKNOWN, which is not "no review has happened"',
          };
        }
        const count = field(reviews, 'review_count');
        if (typeof count === 'number') {
          return count > 0
            ? { value: 'TRUE', reason: `${count} review(s) delivered on the pull request` }
            : { value: 'FALSE', reason: 'no review has been delivered on the pull request' };
        }
        const approved = field(reviews, 'approved');
        const unresolved = field(reviews, 'unresolved_threads');
        const threads = typeof unresolved === 'number' ? unresolved : 0;
        return approved === true || threads > 0
          ? {
            value: 'TRUE',
            reason: approved === true
              ? 'the pull request carries an approval, so a review happened'
              : `${threads} review thread(s) exist, so a review happened`,
          }
          : { value: 'FALSE', reason: 'no approval and no review threads: nobody has reviewed' };
      }

      case 'prHasUnresolvedComments': {
        const reviews = reality.reviews;
        if (assertionTruth(reviews) === 'INDETERMINATE') {
          return { value: 'INDETERMINATE', reason: 'the review state is UNKNOWN' };
        }
        const unresolved = field(reviews, 'unresolved_threads');
        if (typeof unresolved !== 'number') {
          return { value: 'INDETERMINATE', reason: 'the unresolved thread count is not stated' };
        }
        return unresolved > 0
          ? { value: 'TRUE', reason: `${unresolved} unresolved review thread(s) on the current head` }
          : { value: 'FALSE', reason: 'no unresolved review threads on the current head' };
      }

      case 'ciGreen': {
        const ci = reality.ci;
        if (assertionTruth(ci) === 'INDETERMINATE') {
          return { value: 'INDETERMINATE', reason: 'the CI result is UNKNOWN' };
        }
        const result = field(ci, 'result');
        const head = field(ci, 'head_sha');
        const prHead = field(reality.pr, 'head_sha');
        if (result !== 'GREEN') {
          return { value: 'FALSE', reason: `CI result is ${String(result)}` };
        }
        if (head !== undefined && prHead !== undefined && head !== prHead) {
          return {
            value: 'FALSE',
            reason: `CI passed for ${describe(head)} and the current head is ${describe(prHead)}`,
          };
        }
        return { value: 'TRUE', reason: 'CI passed for the current head' };
      }

      case 'stageCompletedPreviously': {
        /*
         * A prior Workflow Run against this Work Item completed this stage. Keyed on
         * AgentOS's own ledger, because that is the only honest observation available: code
         * existing does not mean an analysis happened, and marking an audit already done
         * because a fix exists is precisely the inference the design refuses.
         */
        const stage = inputs.stage;
        if (stage === null || stage === undefined) {
          return {
            value: 'INDETERMINATE',
            reason:
              'the predicate is about a stage and no stage was supplied, so it cannot be '
              + 'evaluated. Failing closed keeps the stage in the run',
          };
        }
        const history = reality.agentos_history;
        if (assertionTruth(history) === 'INDETERMINATE') {
          return {
            value: 'INDETERMINATE',
            reason: "AgentOS's own history for this work item is UNKNOWN",
          };
        }
        const runs = Array.isArray(history.value) ? history.value : [];
        const completed = runs.some((run) => {
          if (run === null || typeof run !== 'object') return false;
          const stages = (run as { stages_completed?: unknown }).stages_completed;
          return Array.isArray(stages) && stages.includes(stage);
        });
        return completed
          ? {
            value: 'TRUE',
            reason:
              `a prior run against this work item completed ${stage}. The ledger is `
              + 'authoritative about what AgentOS did',
          }
          : {
            value: 'FALSE',
            reason: `no prior run against this work item completed ${stage}`,
          };
      }

      case 'childrenExist': {
        const children = reality.children;
        if (assertionTruth(children) === 'INDETERMINATE') {
          return { value: 'INDETERMINATE', reason: 'the child set is UNKNOWN' };
        }
        const list = Array.isArray(children.value) ? children.value : [];
        return list.length > 0
          ? { value: 'TRUE', reason: `${list.length} child work item(s) exist` }
          : { value: 'FALSE', reason: 'no child work items exist' };
      }

      case 'childrenAllTerminal': {
        const children = reality.children;
        if (assertionTruth(children) === 'INDETERMINATE') {
          return { value: 'INDETERMINATE', reason: 'the child set is UNKNOWN' };
        }
        const list = Array.isArray(children.value) ? children.value : [];
        if (list.length === 0) {
          return {
            value: 'FALSE',
            reason: 'no children exist, so "every child is terminal" is not yet true of anything',
          };
        }
        const states = list.map((child) =>
          typeof child === 'object' && child !== null
            ? String((child as { lifecycle?: unknown }).lifecycle)
            : 'UNKNOWN');
        if (states.some((s) => s === 'UNKNOWN' || s === 'undefined')) {
          return { value: 'INDETERMINATE', reason: 'a child lifecycle is UNKNOWN' };
        }
        const allTerminal = states.every((s) => TERMINAL_LIFECYCLES.has(s));
        return allTerminal
          ? { value: 'TRUE', reason: 'every child is ACHIEVED, ABANDONED or SUPERSEDED' }
          : {
            value: 'FALSE',
            reason: `${states.filter((s) => !TERMINAL_LIFECYCLES.has(s)).length} child(ren) are `
              + 'not terminal',
          };
      }

      case 'deployed': {
        const deployment = reality.deployment;
        if (assertionTruth(deployment) === 'INDETERMINATE') {
          return { value: 'INDETERMINATE', reason: 'the deployment state is UNKNOWN' };
        }
        const environments = field(deployment, 'environments');
        const list = Array.isArray(environments) ? environments : [];
        return list.length > 0
          ? { value: 'TRUE', reason: `present in ${list.length} environment(s)` }
          : { value: 'FALSE', reason: 'not present in any environment' };
      }

      case 'regressionSuspected': {
        /*
         * `reality.outcome_already_satisfied is FALSE AND the work item scope intersects a
         * capability record whose status is WORKING or PROVEN`. It reads as: something that
         * demonstrably used to work does not now. Both terms are lookups, so this is
         * arithmetic — and it is the one floor rule keyed on reality rather than on type,
         * because a rule keyed on a resolved field can only be as good as the resolution.
         */
        const outcome = assertionTruth(reality.outcome_evidence);
        if (outcome === 'INDETERMINATE') {
          return {
            value: 'INDETERMINATE',
            reason: 'whether the outcome already holds is UNKNOWN, so whether this is a '
              + 'regression cannot be established',
          };
        }
        if (outcome === 'TRUE') {
          return { value: 'FALSE', reason: 'the outcome already holds, so nothing has regressed' };
        }
        const paths = workItem?.scope.paths ?? [];
        const working = capabilities.filter(
          (c) => (c.status === 'WORKING' || c.status === 'PROVEN')
            && scopesIntersect(c.scope_paths, paths),
        );
        return working.length > 0
          ? {
            value: 'TRUE',
            reason: `the scope intersects ${working.map((c) => c.id).join(', ')}, which `
              + 'demonstrably worked and does not now',
          }
          : {
            value: 'FALSE',
            reason: 'no WORKING or PROVEN capability record intersects the scope',
          };
      }

      default:
        /* Policy load checks that every predicate names an evaluator; reaching here means
         * one names an evaluator that does not exist, and failing closed is the only safe
         * answer for a value a transition depends on. */
        return {
          value: 'INDETERMINATE',
          reason: `no evaluator named ${definition.evaluator} is implemented, so the value is `
            + 'INDETERMINATE and the safer branch applies',
        };
    }
  }
}

function contractBoundaries(context: ContextPackage): readonly string[] {
  const out: string[] = [];
  for (const [section, keys] of [
    [context.api_map, ['paths', 'endpoints']],
    [context.source_map, ['paths', 'sources']],
    [context.data_map, ['schema_paths', 'migration_paths']],
  ] as const) {
    for (const key of keys) {
      const assertion = section[key];
      if (assertion === undefined || assertion.confidence === 'UNKNOWN') continue;
      const value = assertion.value;
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === 'string') out.push(entry);
          else if (typeof entry === 'object' && entry !== null) {
            const path = (entry as { path?: unknown }).path;
            if (typeof path === 'string') out.push(path);
          }
        }
      }
    }
  }
  return out;
}

function surfacePaths(context: ContextPackage): readonly string[] {
  const assertion = context.ui_map['surfaces'];
  if (assertion === undefined || assertion.confidence === 'UNKNOWN') return [];
  const value = assertion.value;
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
    else if (typeof entry === 'object' && entry !== null) {
      const path = (entry as { path?: unknown }).path;
      if (typeof path === 'string') out.push(path);
    }
  }
  return out;
}

/** Does a concrete path fall under a glob or a directory prefix? */
export function pathMatches(path: string, pattern: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalizedPath === normalizedPattern) return true;
  if (globToRegExp(normalizedPattern).test(normalizedPath)) return true;
  /* A bare directory covers everything under it, which is how a scope of `src/pricing`
   * behaves without every author remembering to write `src/pricing/**`. */
  return normalizedPath.startsWith(`${normalizedPattern.replace(/\/+$/, '')}/`);
}

/** Do two path sets overlap? Either direction counts: a scope may be broader or narrower. */
export function scopesIntersect(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.some((x) => b.some((y) => pathMatches(x, y) || pathMatches(y, x)));
}
