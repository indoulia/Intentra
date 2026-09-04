import {
  normalizeTitle,
  workItemIdFromContent,
  workItemIdFromExternalIdentity,
  type Assertion,
  type CapabilityRecord,
  type ContextPackage,
  type DodProfileId,
  type Evidence,
  type EvidenceKind,
  type IntakeRecord,
  type ProposedWorkItem,
  type Scope,
  type Violation,
  type WorkItem,
  type WorkItemPolicy,
  type WorkItemType,
} from '@agentos/contracts';
import type { CheckOutcome } from '@agentos/contracts';
import type { PolicySet } from '@agentos/policies';
import { pathMatches, scopesIntersect } from './predicates.js';
import type { VerificationReport } from './evidence-verification.js';

/**
 * Work Item admission — the six checks of INTENT_AND_WORK_ITEM_RESOLUTION 3.4.
 *
 * A proposed Work Item is a claim. What the work *is* is a claim like any other, and this is
 * where the kernel disbelieves it: the external identity is resolved through the adapter
 * itself rather than accepted, the claimed type is checked against the evidence minimums, an
 * unbounded scope is refused, and the desired outcome must bind to a profile that is
 * checkable with the access this run has.
 *
 * **A rejected proposal is never repaired by the kernel.** Repairing a resolution would
 * require judgment, which is the thing the kernel does not have. It is re-dispatched once
 * with the failure named, and then the uncertainty ladder applies.
 */

/*
 * The check outcome shape is a contract rather than a local type: it is what the
 * `work_item_admitted`, `understood_computed` and `workflow_admitted` events carry, so a
 * second definition here would be a second definition of a logged shape.
 */
export type { CheckOutcome } from '@agentos/contracts';

/** How the external identity resolved, through the adapter and not from the claim. */
export type IdentityResolution =
  | { readonly outcome: 'NOT_NAMED' }
  | { readonly outcome: 'RESOLVED'; readonly identity: string; readonly evidence: Evidence }
  | {
    /** Reachable, and the item does not exist. The key is wrong, and a human should hear it. */
    readonly outcome: 'ABSENT';
    readonly identity: string;
  }
  | {
    /** Unreachable. Block, and resume when it returns. */
    readonly outcome: 'UNAVAILABLE';
    readonly identity: string;
    readonly detail: string;
  };

export interface AdmissionInput {
  readonly intake: IntakeRecord;
  readonly proposal: ProposedWorkItem;
  readonly policies: PolicySet;
  readonly context: ContextPackage;
  readonly capabilities: readonly CapabilityRecord[];
  /**
   * True where the capability registry was actually available to supply `capabilities`.
   *
   * The distinction is load-bearing. `no_capability_record_intersecting_scope` is satisfied
   * by an empty registry, so a `FEATURE` asserted against a registry nobody could read would
   * pass its minimum for the reason that nothing was looked at — and `DEFECT`, which needs a
   * record to exist, would downgrade for the same reason. An unavailable registry is
   * `INDETERMINATE`, never "no capabilities".
   */
  readonly capabilityRegistryAvailable?: boolean;
  readonly identity: IdentityResolution;
  /**
   * The proposing envelope's evidence pool.
   *
   * An envelope-form proposal cites evidence **ids** into this pool (decision I-5), so a
   * proposal whose pool never reached admission is a proposal with no evidence at all — which
   * would fail every type minimum the worked examples state. Both forms are the same
   * evidence and both resolve here.
   */
  readonly evidence?: readonly Evidence[];
  /**
   * What replaying that pool through the originating adapter found.
   *
   * Section 3.4 check 1 ends "the evidence replays". Evidence that came back `MISMATCH` or
   * `UNREPLAYABLE` supports nothing, so it is withdrawn from the pool the type minimums are
   * judged against, and the two-strikes rule refuses the whole proposal.
   */
  readonly verification?: VerificationReport | null;
  /** Work items already in the store, for the similarity check. */
  readonly existing: readonly WorkItem[];
  /** Access classes this run actually has, for the outcome-bindability check. */
  readonly access: ReadonlySet<'repository' | 'git' | 'project_management' | 'runtime' | 'production'>;
  readonly now: string;
}

export type AdmissionResult =
  | {
    readonly outcome: 'ADMITTED';
    readonly workItem: WorkItem;
    readonly checks: readonly CheckOutcome[];
    /** True where a claimed type lacked its minimum evidence and became UNKNOWN. */
    readonly typeDowngraded: boolean;
    readonly duplicateCandidates: readonly string[];
    /**
     * What resolution decided the work *is*, carried out of admission because the `WorkItem`
     * contract has no field for it.
     *
     * The narrative's v0.3 obligation is to state what AgentOS decided the work was and why
     * ([WORKFLOW_STATE_MACHINE.md](../../docs/WORKFLOW_STATE_MACHINE.md) section 8), and an
     * intent nothing durable records is an obligation nothing can discharge. It is written to
     * the work-item event log instead. **This is a contract gap**, reported rather than fixed
     * by widening `contracts/`.
     */
    readonly intent: Assertion;
    /** The agent's own number, for the uncertainty ladder's threshold. */
    readonly resolutionConfidence: number;
  }
  | {
    readonly outcome: 'REJECTED';
    readonly checks: readonly CheckOutcome[];
    readonly violations: readonly Violation[];
  }
  | {
    /**
     * The intake named an external item that cannot be resolved. It **blocks** rather than
     * degrading to investigating the repository instead: the work is definitionally that
     * external item, and investigating something else is not a weaker version of it, it is a
     * different task.
     */
    readonly outcome: 'BLOCKED';
    readonly blockerKind: 'EXTERNAL_DEPENDENCY';
    readonly reason: string;
    readonly checks: readonly CheckOutcome[];
  };

function violation(
  code: Violation['code'],
  message: string,
  path: string | null,
): Violation {
  return {
    code,
    rule: 'INTENT_AND_WORK_ITEM_RESOLUTION section 3.4',
    message,
    path,
    handled_as: 'REFUSED',
    subject: null,
  };
}

/** The value of an assertion, or null where it is UNKNOWN. */
function value(assertion: Assertion): unknown {
  return assertion.confidence === 'UNKNOWN' ? null : assertion.value;
}

function stringValue(assertion: Assertion): string | null {
  const raw = value(assertion);
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Check 5: scope is typed and bounded.
 *
 * `scope.paths` must resolve inside the target repositories and a scope of `**` is refused.
 * Scope becomes the `mandate.in_scope` adapters enforce, so an over-wide scope is an
 * over-wide grant of reach — which is why this is a refusal rather than a warning.
 */
export function checkScope(scope: Scope): CheckOutcome {
  if (scope.paths.length === 0 && scope.capabilities.length === 0) {
    return {
      check: 'scope_bounded',
      result: 'FAIL',
      detail:
        'the scope names no paths and no capabilities. Scope becomes the mandate the adapters '
        + 'enforce, and an empty one is not a small grant, it is an unenforceable one',
    };
  }
  const unbounded = scope.paths.filter(
    (path) => path === '**' || path === '*' || path === '/**' || path === './**' || path === '.',
  );
  if (unbounded.length > 0) {
    return {
      check: 'scope_bounded',
      result: 'FAIL',
      detail:
        `the scope includes ${unbounded.join(', ')}, which is the whole repository. An `
        + 'over-wide scope is an over-wide grant of reach',
    };
  }
  const escaping = scope.paths.filter(
    (path) => path.startsWith('/') || path.startsWith('..') || /^[A-Za-z]:/.test(path),
  );
  if (escaping.length > 0) {
    return {
      check: 'scope_bounded',
      result: 'FAIL',
      detail:
        `the scope includes ${escaping.join(', ')}, which does not resolve inside a target `
        + 'repository',
    };
  }
  return {
    check: 'scope_bounded',
    result: 'PASS',
    detail: `${scope.paths.length} path(s) and ${scope.capabilities.length} capability(ies)`,
  };
}

/**
 * Check 4: the claimed type is admissible for the evidence.
 *
 * `policies/work-items.json` states, per type, the minimum evidence class required to assert
 * it. `INCIDENT` requires a runtime or production observation, not a phrasing — nobody
 * declares an incident by writing the word. **A type asserted without its minimum evidence
 * is admitted as `UNKNOWN`, and the claimed type is recorded**, which routes to the read-only
 * investigation template: the safe thing to do when you do not know what you are looking at.
 */
export function checkTypeEvidence(
  claimedType: WorkItemType,
  evidence: readonly Evidence[],
  scope: Scope,
  capabilities: readonly CapabilityRecord[],
  identity: IdentityResolution,
  context: ContextPackage,
  policy: WorkItemPolicy,
  /**
   * Whether the capability registry was actually readable.
   *
   * `false` makes both capability requirements `INDETERMINATE` rather than answering them
   * from an empty list — an empty registry and an unreadable one are the same array and
   * opposite facts, and the second must not silently admit every `FEATURE` while downgrading
   * every `DEFECT`.
   */
  capabilityRegistryAvailable = true,
): { readonly outcome: CheckOutcome; readonly admittedType: WorkItemType } {
  const entry = policy.types.find((t) => t.type === claimedType);
  if (entry === undefined) {
    return {
      outcome: {
        check: 'type_minimum_evidence',
        result: 'FAIL',
        detail: `no evidence minimum is defined for type ${claimedType}`,
      },
      admittedType: 'UNKNOWN',
    };
  }
  if (entry.satisfied_by === 'NONE') {
    return {
      outcome: {
        check: 'type_minimum_evidence',
        result: 'PASS',
        detail: `${claimedType} requires no evidence to be admissible`,
      },
      admittedType: claimedType,
    };
  }

  const kinds = new Set<EvidenceKind>(evidence.map((e) => e.kind));
  const satisfied: string[] = [];
  const unsatisfied: string[] = [];
  /** Requirements nothing could answer, kept apart from the ones answered "no". */
  const indeterminate: string[] = [];

  for (const requirement of entry.minimum_evidence) {
    const kindOk = requirement.kinds.length === 0
      || requirement.kinds.some((kind) => kinds.has(kind));
    /** `null` where the requirement could not be evaluated at all. */
    let structuralOk: boolean | null;
    switch (requirement.requirement) {
      case 'external_item_of_this_type':
        structuralOk = identity.outcome === 'RESOLVED';
        break;
      case 'child_items_exist': {
        const children = context.current_reality.children;
        structuralOk = children.confidence === 'UNKNOWN'
          ? null
          : Array.isArray(children.value) && children.value.length > 0;
        break;
      }
      case 'runtime_or_production_observation':
        structuralOk = evidence.some(
          (e) => (e.kind === 'log' || e.kind === 'metric' || e.kind === 'query' || e.kind === 'http')
            && e.locator.adapter.startsWith('runtime'),
        );
        break;
      case 'capability_record_intersecting_scope':
        structuralOk = capabilityRegistryAvailable
          ? capabilities.some((c) => scopesIntersect(c.scope_paths, scope.paths))
            || scope.capabilities.some((id) => capabilities.some((c) => c.id === id))
          : null;
        break;
      case 'no_capability_record_intersecting_scope':
        structuralOk = capabilityRegistryAvailable
          ? !capabilities.some((c) => scopesIntersect(c.scope_paths, scope.paths))
          : null;
        break;
      case 'named_path_exists':
        /*
         * The evidence has to establish *the named path*. Any file evidence anywhere used to
         * satisfy this, which made "the work names something that exists" mean "the agent
         * read some file" — a requirement the proposal could satisfy without its scope being
         * bounded by anything at all.
         */
        structuralOk = evidence.some((e) => {
          if (e.kind !== 'file') return false;
          const path = pathArg(e.locator.args);
          if (path.length === 0) return false;
          return scope.paths.some((p) => pathMatches(path, p) || pathMatches(p, path));
        });
        break;
      case 'existing_change_proposal': {
        const pr = context.current_reality.pr;
        structuralOk = pr.confidence === 'UNKNOWN' ? null : pr.value !== null;
        break;
      }
      case 'reproduction_or_incorrect_behaviour_report':
        structuralOk = evidence.length > 0;
        break;
      case 'none':
        structuralOk = true;
        break;
      default:
        structuralOk = false;
    }
    if (structuralOk === null) indeterminate.push(requirement.requirement);
    else if (kindOk && structuralOk) satisfied.push(requirement.requirement);
    else unsatisfied.push(requirement.requirement);
  }

  const met = entry.satisfied_by === 'ALL'
    ? unsatisfied.length === 0 && indeterminate.length === 0
    : satisfied.length > 0;

  if (met) {
    return {
      outcome: {
        check: 'type_minimum_evidence',
        result: 'PASS',
        detail: `${claimedType} satisfied ${entry.satisfied_by} of its minimums: ${satisfied.join(', ')}`,
      },
      admittedType: claimedType,
    };
  }

  if (indeterminate.length > 0) {
    /*
     * Nothing could answer the requirement, so the type is not admissible *and the reason is
     * not that the evidence was absent*. Recording it as PASS would admit a FEATURE because
     * nobody could read the registry; recording it as FAIL would say the evidence was looked
     * for and missing. It is INDETERMINATE, the type downgrades, and the reason is stated.
     */
    return {
      outcome: {
        check: 'type_minimum_evidence',
        result: 'INDETERMINATE',
        detail:
          `${claimedType} could not be judged: ${indeterminate.join(', ')} could not be `
          + 'evaluated'
          + (capabilityRegistryAvailable
            ? ''
            : ', because the capability registry was not available to this admission. An '
              + 'unreadable registry is not an empty one')
          + '. Admitted as UNKNOWN, which routes to the read-only investigation template, and '
          + 'the claimed type is recorded',
      },
      admittedType: 'UNKNOWN',
    };
  }

  return {
    outcome: {
      check: 'type_minimum_evidence',
      result: 'FAIL',
      detail:
        `${claimedType} was asserted without ${unsatisfied.join(', ')}. Admitted as UNKNOWN, `
        + 'which routes to the read-only investigation template — the safe thing to do when '
        + 'you do not know what you are looking at. The claimed type is recorded',
    },
    admittedType: 'UNKNOWN',
  };
}

/**
 * Check 6: the desired outcome binds to a checkable profile.
 *
 * It must map to at least one DoD profile whose criteria are checkable with the access this
 * run has. An outcome nothing can ever demonstrate is not an outcome; it is a wish, and it
 * is rejected with that stated.
 */
export function checkOutcomeBindable(
  admittedType: WorkItemType,
  outcome: string,
  policies: PolicySet,
  access: AdmissionInput['access'],
): { readonly outcome: CheckOutcome; readonly profiles: readonly DodProfileId[] } {
  if (outcome.trim().length === 0) {
    return {
      outcome: {
        check: 'outcome_bindable',
        result: 'FAIL',
        detail: 'the desired outcome is empty',
      },
      profiles: [],
    };
  }

  const entry = policies.workItems.types.find((t) => t.type === admittedType);
  const candidates = entry?.candidate_dod_profiles ?? [];
  const checkable: DodProfileId[] = [];
  const unreachable: string[] = [];

  for (const id of candidates) {
    const profile = policies.profile(id);
    const missing = profile.applies_when.requires_access.filter((a) => !access.has(a));
    if (missing.length === 0) checkable.push(id);
    else unreachable.push(`${id} needs ${missing.join(', ')}`);
  }

  if (checkable.length === 0) {
    return {
      outcome: {
        check: 'outcome_bindable',
        result: 'FAIL',
        detail:
          `the outcome binds only to profiles this run cannot check (${unreachable.join('; ')}). `
          + 'An outcome the admission step cannot bind to a checkable profile is a wish rather '
          + 'than an outcome',
      },
      profiles: [],
    };
  }

  /*
   * A bindable outcome has to name something observable. This is the weakest check in the
   * set and it is deliberately weak: whether an outcome is *well* stated is judgment, and
   * the kernel checks only that it is not empty and that some profile could check it. The
   * mitigation for a plausible-but-wrong outcome is the narrative obligation, not a rule.
   */
  return {
    outcome: {
      check: 'outcome_bindable',
      result: 'PASS',
      detail: `binds to ${checkable.join(', ')} with this run's access`,
    },
    profiles: checkable,
  };
}

/**
 * The `path` argument of an operation locator, as a string.
 *
 * Locator arguments are `unknown` because an adapter operation's arguments are the adapter's
 * business. Interpolating one would print `[object Object]` for a structured argument, which
 * would then be compared against a path pattern and silently never match.
 */
function pathArg(args: Readonly<Record<string, unknown>>): string {
  const value = args['path'];
  return typeof value === 'string' ? value : '';
}

/** Work item lifecycles that are over. An item in one of these is not a duplicate candidate. */
const TERMINAL_LIFECYCLES: ReadonlySet<string> = new Set([
  'ACHIEVED', 'ABANDONED', 'SUPERSEDED',
]);

/**
 * Identity, and the duplicate check.
 *
 * With an external identity the id derives from it and is stable across runs, machines and
 * months. Without one it is content-derived, and the kernel runs **a similarity check against
 * open work items in the same scope** (INTENT_AND_WORK_ITEM_RESOLUTION 4.1).
 *
 * Note what the two mechanisms do differently. The content-derived id is a hash of the scope
 * and the normalized title, so an intake reworded past normalization *is the same work item*
 * and no candidate arises — deduplication, not similarity. The similarity check is for the
 * other case: a different title over an intersecting scope, which is how "fix the session
 * timeout" and "sessions expire too early" arrive as two items over one piece of code.
 *
 * **A candidate match is surfaced, never auto-merged**: merging two work items is a judgment,
 * and a wrong merge destroys history. The check will over-offer candidates rather than miss
 * them, which is the correct direction for something a human confirms.
 */
export function deriveIdentity(
  identity: IdentityResolution,
  title: string,
  scope: Scope,
  existing: readonly WorkItem[],
): {
  readonly workItemId: string;
  readonly duplicateCandidates: readonly string[];
  readonly check: CheckOutcome;
} {
  if (identity.outcome === 'RESOLVED') {
    const workItemId = workItemIdFromExternalIdentity(identity.identity);
    const existingSame = existing.find((w) => w.work_item_id === workItemId);
    return {
      workItemId,
      duplicateCandidates: [],
      check: {
        check: 'identity',
        result: 'PASS',
        detail: existingSame === undefined
          ? `derived from the external identity ${identity.identity}`
          : `derived from the external identity ${identity.identity}, which deduplicates `
            + `against the existing work item (lifecycle ${existingSame.lifecycle})`,
      },
    };
  }

  const workItemId = workItemIdFromContent(scope, title);
  const same = existing.find((w) => w.work_item_id === workItemId);
  const candidates = existing
    .filter((w) => w.external_identity === null)
    .filter((w) => w.work_item_id !== workItemId)
    .filter((w) => !TERMINAL_LIFECYCLES.has(w.lifecycle))
    .filter((w) => scopesIntersect(w.scope.paths, scope.paths)
      || w.scope.capabilities.some((c) => scope.capabilities.includes(c)))
    .map((w) => w.work_item_id);

  return {
    workItemId,
    duplicateCandidates: candidates,
    check: {
      check: 'identity',
      result: 'PASS',
      detail: [
        `content-derived from the normalized title "${normalizeTitle(title)}" and the scope`,
        same === undefined
          ? null
          : `, which is the same id as the existing work item (lifecycle ${same.lifecycle}): an `
            + 'intake reworded past normalization is the same work item, not a new one',
        candidates.length === 0
          ? null
          : `. ${candidates.length} open work item(s) in an intersecting scope surfaced as `
            + 'candidate duplicates, never auto-merged: merging two work items is a judgment '
            + 'and a wrong merge destroys history',
      ].filter((part) => part !== null).join(''),
    },
  };
}

/** Admits a proposed Work Item, or refuses it, or blocks. */
export function admitWorkItem(input: AdmissionInput): AdmissionResult {
  const checks: CheckOutcome[] = [];
  const violations: Violation[] = [];
  const { proposal, policies, intake } = input;

  /* ------------------------------------ 1. schema and confidence discipline ---- */

  /*
   * Every field is an assertion; every `FACT` carries evidence; the evidence replays.
   *
   * The pool is the proposing envelope's `evidence[]`, and an envelope-form proposal cites
   * ids into it (decision I-5). Both forms are the same evidence, so both are resolved here —
   * and a `FACT` citing an id the pool does not contain is a dangling reference and a
   * violation, not a `FACT` with slightly less support than it claimed.
   */
  const pool = new Map<string, Evidence>();
  for (const item of input.evidence ?? []) pool.set(item.id, item);

  const withdrawn = new Set<string>();
  for (const outcome of input.verification?.outcomes ?? []) {
    if (outcome.status === 'MISMATCH' || outcome.status === 'UNREPLAYABLE') {
      withdrawn.add(outcome.evidence_id);
    }
  }

  const fields: readonly (readonly [string, Assertion])[] = [
    ['/intent', proposal.intent],
    ['/type', proposal.type],
    ['/external_identity', proposal.external_identity],
    ['/title', proposal.title],
    ['/desired_outcome', proposal.desired_outcome],
    ['/parent', proposal.parent],
  ];

  const cited = new Map<string, Evidence>();
  const dangling: string[] = [];
  const unsupportedFacts: string[] = [];

  for (const [path, assertion] of fields) {
    const references = assertion.confidence === 'UNKNOWN' ? [] : assertion.evidence ?? [];
    if (assertion.confidence === 'FACT' && references.length === 0) {
      unsupportedFacts.push(path);
    }
    for (const reference of references) {
      if (typeof reference !== 'string') {
        pool.set(reference.id, reference);
        cited.set(reference.id, reference);
        continue;
      }
      const resolved = pool.get(reference);
      if (resolved === undefined) {
        if (assertion.confidence === 'FACT') dangling.push(`${path} cites ${reference}`);
        continue;
      }
      cited.set(resolved.id, resolved);
    }
  }

  /*
   * Evidence the replay could not confirm supports nothing. It is withdrawn from the pool the
   * type minimums are judged against rather than being counted and annotated, because a type
   * admitted on evidence that did not replay is a type admitted on nothing.
   */
  const admissibleEvidence = [...pool.values()].filter((e) => !withdrawn.has(e.id));

  for (const path of unsupportedFacts) {
    violations.push(violation(
      'ASSERTION_WITHOUT_CONFIDENCE',
      `${path} is asserted FACT and cites no evidence. A FACT with no evidence is an `
      + 'INFERENCE that has not admitted it',
      path,
    ));
  }
  for (const reference of dangling) {
    violations.push(violation(
      'DANGLING_EVIDENCE_REFERENCE',
      `${reference}, and no evidence with that id is in the proposal or its envelope's `
      + 'evidence pool. A FACT resting on an id nothing supplies is a FACT nothing supports',
      reference.split(' ')[0] ?? null,
    ));
  }
  if (input.verification?.rejectEnvelope === true) {
    /*
     * The two-strikes rule. One fabrication is a defect; two is an untrustworthy witness, and
     * a resolution is exactly the thing that must not be built on one.
     */
    violations.push(violation(
      'EVIDENCE_MISMATCH_THRESHOLD',
      `${input.verification.mismatchCount} evidence item(s) in the resolution envelope failed `
      + 'to replay through their originating adapters. The proposal is refused rather than '
      + 'admitted on evidence that does not exist',
      '/evidence',
    ));
  }

  checks.push({
    check: 'schema_and_confidence',
    result: violations.length > 0
      ? 'FAIL'
      : withdrawn.size > 0 ? 'INDETERMINATE' : 'PASS',
    detail:
      `${fields.length} field(s), each an assertion with a confidence class; `
      + `${cited.size} evidence reference(s) resolved against a pool of ${pool.size}; `
      + `${dangling.length} dangling; `
      + (input.verification === null || input.verification === undefined
        ? 'the evidence was not replayed for this admission'
        : `${input.verification.outcomes.filter((o) => o.status === 'VERIFIED').length} `
          + `replayed and matched, ${withdrawn.size} withdrawn as unconfirmed`),
  });

  /* --------------------------------------- 2. external identity is verified ---- */

  switch (input.identity.outcome) {
    case 'NOT_NAMED':
      checks.push({
        check: 'external_identity',
        result: 'NOT_APPLICABLE',
        detail:
          'the intake named no external item, so an unresolved identity is NOT_APPLICABLE and '
          + 'resolution proceeds on content',
      });
      break;
    case 'RESOLVED':
      checks.push({
        check: 'external_identity',
        result: 'PASS',
        detail: `${input.identity.identity} was fetched through the adapter, not accepted from the claim`,
      });
      break;
    case 'UNAVAILABLE':
      checks.push({
        check: 'external_identity',
        result: 'INDETERMINATE',
        detail: `${input.identity.identity} is UNAVAILABLE: ${input.identity.detail}`,
      });
      return {
        outcome: 'BLOCKED',
        blockerKind: 'EXTERNAL_DEPENDENCY',
        reason:
          `the intake named ${input.identity.identity} and the source is unreachable. The work `
          + 'is definitionally that external item, so this blocks and resumes when the source '
          + 'returns, rather than degrading into investigating the repository instead',
        checks,
      };
    case 'ABSENT':
      checks.push({
        check: 'external_identity',
        result: 'FAIL',
        detail: `${input.identity.identity} does not exist at a reachable source`,
      });
      return {
        outcome: 'BLOCKED',
        blockerKind: 'EXTERNAL_DEPENDENCY',
        reason:
          `the intake named ${input.identity.identity}, the source is reachable, and no such `
          + 'item exists. The key is wrong, and a human should hear that rather than watch '
          + 'AgentOS work on a guess',
        checks,
      };
    default:
      break;
  }

  /* ------------------------------------------------------------ 5. scope ---- */

  const scope: Scope = {
    paths: proposal.scope.paths,
    capabilities: proposal.scope.capabilities,
    repositories: proposal.scope.repositories,
  };
  const scopeCheck = checkScope(scope);
  checks.push(scopeCheck);
  if (scopeCheck.result === 'FAIL') {
    violations.push(violation('UNBOUNDED_SCOPE', scopeCheck.detail, '/scope'));
  }

  /* ------------------------------------------------------- 4. type evidence ---- */

  const claimedTypeRaw = stringValue(proposal.type);
  const claimedType = (claimedTypeRaw ?? 'UNKNOWN') as WorkItemType;
  const typeResult = checkTypeEvidence(
    claimedType,
    admissibleEvidence,
    scope,
    input.capabilities,
    input.identity,
    input.context,
    policies.workItems,
    input.capabilityRegistryAvailable ?? true,
  );
  checks.push(typeResult.outcome);
  const admittedType = typeResult.admittedType;
  const typeDowngraded = admittedType !== claimedType;

  /* --------------------------------------------------------- 6. outcome ---- */

  const outcomeText = stringValue(proposal.desired_outcome) ?? '';
  const outcomeResult = checkOutcomeBindable(admittedType, outcomeText, policies, input.access);
  checks.push(outcomeResult.outcome);
  if (outcomeResult.outcome.result === 'FAIL') {
    violations.push(violation(
      'OUTCOME_NOT_BINDABLE',
      outcomeResult.outcome.detail,
      '/desired_outcome',
    ));
  }

  /* ---------------------------------------------- 3. identity and duplicates ---- */

  const title = stringValue(proposal.title) ?? outcomeText.slice(0, 120);
  if (title.trim().length === 0) {
    checks.push({
      check: 'identity',
      result: 'FAIL',
      detail: 'the proposal carries neither a title nor a desired outcome to derive one from',
    });
    violations.push(violation('SCHEMA_INVALID', 'no title and no desired outcome', '/title'));
  }

  if (violations.length > 0) {
    return { outcome: 'REJECTED', checks, violations };
  }

  const identity = deriveIdentity(input.identity, title, scope, input.existing);
  checks.push(identity.check);

  /* -------------------------------------------- 5b. resolution confidence ---- */

  const threshold = policies.workItems.resolution_confidence_threshold;
  checks.push({
    check: 'resolution_confidence',
    result: proposal.resolution_confidence >= threshold ? 'PASS' : 'INDETERMINATE',
    detail:
      `the agent's own number is ${proposal.resolution_confidence} against a threshold of `
      + `${threshold}. Recorded, never the reason anything is believed; below the threshold `
      + 'the uncertainty ladder applies',
  });

  /*
   * The proposal's declared dependencies and parent, carried onto the record.
   *
   * Dropping them silently made a proposed `parent` unrepresentable — an Epic's child would
   * have arrived with no `CHILD_OF` link, so nothing downstream could tell it was one — and
   * made declared ordering between siblings vanish at the moment it became durable.
   */
  const dependencies = [...new Set(proposal.dependencies)];
  const parentValue = stringValue(proposal.parent);
  const links: WorkItem['links'] = parentValue === null
    ? []
    : [{ kind: 'CHILD_OF', target: workItemIdFromExternalIdentity(parentValue) }];

  const workItem: WorkItem = {
    work_item_id: identity.workItemId,
    created_at: input.now,
    source_intake: intake.intake_id,
    origin_trust_class: intake.trust_class,
    type: admittedType,
    claimed_type: typeDowngraded ? claimedType : null,
    title,
    external_identity: input.identity.outcome === 'RESOLVED' ? input.identity.identity : null,
    desired_outcome: outcomeText,
    scope,
    constraints: proposal.constraints,
    dependencies,
    lifecycle: 'RESOLVED',
    candidate_dod_profiles: outcomeResult.profiles,
    links,
    duplicate_candidates: identity.duplicateCandidates,
    lease: null,
    runs: [],
    reresolution_count: 0,
    decomposition_depth: 0,
    denied_gates: [],
    consumed_budget: { usd: 0, input_tokens: 0, output_tokens: 0, dispatches: 0, loops: {} },
  };

  return {
    outcome: 'ADMITTED',
    workItem,
    checks,
    typeDowngraded,
    duplicateCandidates: identity.duplicateCandidates,
    intent: proposal.intent,
    resolutionConfidence: proposal.resolution_confidence,
  };
}
