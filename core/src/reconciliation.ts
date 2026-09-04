import type {
  ArtifactChange,
  CallRecord,
  Coverage,
  HandoffEnvelope,
  MutationEvent,
  Violation,
} from '@agentos/contracts';

/**
 * Step 3 of envelope receipt: reconciling what an agent says it did and looked at against
 * what the adapters recorded.
 *
 * This is the disbelief step that reaches claims which previously looked inherently
 * subjective. `artifacts_changed` is checked against the mutation events adapters emitted at
 * call time, and `coverage` against the adapter call log — and both are checked in both
 * directions, because under-reporting and over-reporting are different failures and both
 * matter:
 *
 * - **Under-report** — a mutation happened the agent did not declare. An agent that touches
 *   things it does not report cannot be trusted about anything else it reports.
 * - **Over-report** — the agent claims a mutation no adapter performed. Usually a
 *   hallucinated edit, and worth catching precisely because the code looks fine and the
 *   change is absent.
 */

const HANDOFF = 'AGENT_HANDOFF_CONTRACT, artifacts_changed';
const CALL_LOG = 'WORKFLOW_STATE_MACHINE section 7.1';

export interface ReconciliationInput {
  readonly envelope: HandoffEnvelope;
  /** Mutation events recorded for *this dispatch*, in order. */
  readonly mutations: readonly MutationEvent[];
  /** Adapter calls recorded for this dispatch, reads included. */
  readonly calls: readonly CallRecord[];
}

export interface ReconciliationResult {
  readonly violations: readonly Violation[];
  /** Mutations no `artifacts_changed` entry accounts for. */
  readonly underReported: readonly MutationEvent[];
  /** Declared changes no mutation event supports. */
  readonly overReported: readonly ArtifactChange[];
  /** Claimed scope no adapter call touched, where the call log could have answered. */
  readonly unsupportedScope: readonly string[];
  /**
   * Claimed scope the call log **cannot** answer — a capability id, with no call in this
   * dispatch carrying any `capabilities_touched` to reconcile it against. Not a violation and
   * not a pass: recorded so the gap is visible rather than either failing every envelope or
   * silently accepting every capability-shaped coverage claim.
   */
  readonly unreconciledScope: readonly string[];
}

/**
 * Normalizes a mutation target and an artifact target onto comparable keys.
 *
 * A path may arrive with either separator and with or without a leading `./`, and a git
 * target may be a ref or a worktree path. The comparison is on a normalized string rather
 * than on a resolved filesystem path because the reconciliation must work for targets that
 * are no longer present — a deleted file is exactly the case where resolution fails.
 */
function normalizeTarget(target: string): string {
  return target
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** The mutation kinds an `artifacts_changed` entry of each kind can account for. */
const KIND_ALIASES: Readonly<Record<ArtifactChange['kind'], readonly string[]>> = {
  file: ['write_file', 'delete_file', 'create_file', 'move_file', 'apply_patch'],
  commit: ['commit', 'amend_commit'],
  branch: ['create_branch', 'delete_branch', 'push_branch', 'reset_hard'],
  migration: ['run_migration', 'apply_migration'],
  ticket: ['transition_issue', 'update_issue', 'comment_issue'],
  runtime: ['write_query', 'invoke_write', 'deploy'],
  pr: ['create_pr', 'update_pr', 'merge_pr', 'close_pr'],
  comment: ['comment_pr', 'resolve_thread'],
};

function accounts(change: ArtifactChange, mutation: MutationEvent): boolean {
  if (normalizeTarget(change.target) !== normalizeTarget(mutation.target)) return false;
  const aliases = KIND_ALIASES[change.kind];
  /*
   * The operation names are adapter-defined, so an unrecognized one still matches on target.
   * Failing to match a real mutation because its operation name was not in a list here would
   * turn a naming gap into a false under-report accusation, which is the wrong direction to
   * be wrong in for a check whose consequence is rejecting an envelope.
   */
  return aliases.includes(mutation.op) || !Object.values(KIND_ALIASES).flat().includes(mutation.op);
}

/**
 * Does an adapter call support a claim to have examined this scope entry?
 *
 * A scope entry is a path glob or a capability id. A call supports it when the call touched a
 * path the entry covers, or named the capability. This is a containment test rather than an
 * equality test because an agent legitimately claims to have examined `src/pricing/**` after
 * reading files under it.
 */
function callSupports(entry: string, call: CallRecord): boolean {
  const normalized = normalizeTarget(entry);
  if (call.capabilities_touched.some((c) => normalizeTarget(c) === normalized)) return true;
  const matcher = globToRegExp(normalized);
  return call.paths_touched.some((path) => matcher.test(normalizeTarget(path)));
}

/** Does this scope entry read as a capability id rather than as a path? */
function looksLikeCapability(entry: string): boolean {
  return /^cap[.:]/i.test(entry.trim());
}

/**
 * Can the call log answer a claim about this entry at all?
 *
 * `capabilities_touched` is required on every `CallRecord` and is populated by mapping the
 * paths a call touched onto capability ids — which needs a capability registry, and the
 * registry is a later work package. Until then every call carries an empty
 * `capabilities_touched`, and a coverage claim naming a capability has nothing to reconcile
 * against.
 *
 * Both ways of collapsing that are wrong. Rejecting every such envelope would turn a missing
 * work package into a contract violation by every agent; accepting every such claim would make
 * `coverage` — the field distinguishing "found nothing there" from "never looked there" —
 * exactly the unchecked self-report the whole design removes. So it degrades honestly: a
 * capability claim is reconciled on paths where the registry populated the field, and reported
 * as **unreconciled** where it did not. Unreconciled is neither supported nor overstated, and
 * the envelope is not rejected for it.
 */
function reconcilable(entry: string, calls: readonly CallRecord[]): boolean {
  if (!looksLikeCapability(entry)) return true;
  return calls.some((call) => call.capabilities_touched.length > 0);
}

/** A deliberately small glob: `**` crosses separators, `*` does not, `?` is one character. */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        /* A double star followed by a separator also matches zero directories, so a
         * pattern of src, double-star, /x matches src/x. */
        if (glob[i + 2] === '/') {
          pattern += '(?:.*/)?';
          i += 2;
        } else {
          pattern += '.*';
          i += 1;
        }
      } else {
        pattern += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const { envelope, mutations, calls } = input;
  const violations: Violation[] = [];

  /* ------------------------------------------------- artifacts_changed, both ways ---- */

  const claimed = envelope.artifacts_changed;
  const accountedMutations = new Set<MutationEvent>();
  const supportedClaims = new Set<ArtifactChange>();

  for (const change of claimed) {
    for (const mutation of mutations) {
      if (accounts(change, mutation)) {
        accountedMutations.add(mutation);
        supportedClaims.add(change);
      }
    }
  }

  const underReported = mutations.filter((m) => !accountedMutations.has(m));
  const overReported = claimed.filter((c) => !supportedClaims.has(c));

  for (const mutation of underReported) {
    violations.push({
      code: 'ARTIFACTS_UNDER_REPORTED',
      rule: HANDOFF,
      message:
        `${mutation.adapter}.${mutation.op} mutated ${mutation.target} and artifacts_changed `
        + 'does not declare it. An agent that touches things it does not report cannot be '
        + 'trusted about anything else it reports',
      path: '/artifacts_changed',
      handled_as: 'BLOCKED',
      subject: mutation.target,
    });
  }

  for (const change of overReported) {
    violations.push({
      code: 'ARTIFACTS_OVER_REPORTED',
      rule: HANDOFF,
      message:
        `artifacts_changed declares a ${change.change} of ${change.target}, and no adapter `
        + 'performed it. Usually a hallucinated edit, and worth catching precisely because '
        + 'the code looks fine and the change is absent',
      path: '/artifacts_changed',
      handled_as: 'BLOCKED',
      subject: change.target,
    });
  }

  /* --------------------------------------------------------- coverage, one way ---- */

  /*
   * Coverage is checked in one direction only, and deliberately. Claimed-but-untouched is a
   * violation: it is the difference between "found nothing there" and "never looked there".
   * Touched-but-unclaimed is not — an agent that read more than its coverage statement claims
   * has understated its own thoroughness, which costs nothing and is not a lie.
   */
  const unreconciledScope = envelope.coverage.scope_examined.filter(
    (entry) => !calls.some((call) => callSupports(entry, call)) && !reconcilable(entry, calls),
  );
  const unsupportedScope = envelope.coverage.scope_examined.filter(
    (entry) => !calls.some((call) => callSupports(entry, call)) && reconcilable(entry, calls),
  );

  for (const entry of unsupportedScope) {
    violations.push({
      code: 'COVERAGE_OVERSTATED',
      rule: CALL_LOG,
      message:
        `coverage claims ${entry} was examined and no adapter call touched it. Coverage is the `
        + 'field distinguishing "found nothing there" from "never looked there", and leaving '
        + 'it an unchecked self-report would leave the most consequential claim in the '
        + 'envelope as the one nobody verified',
      path: '/coverage/scope_examined',
      handled_as: 'BLOCKED',
      subject: entry,
    });
  }

  return { violations, underReported, overReported, unsupportedScope, unreconciledScope };
}

/**
 * The blast radius of a dispatch, computed from the mutation events and never from
 * `artifacts_changed`.
 */
export function blastRadius(mutations: readonly MutationEvent[]): readonly string[] {
  return [...new Set(mutations.map((m) => m.target))].sort();
}

/** Whether any mutation in a dispatch declared itself non-reversible. */
export function hasNonReversibleMutation(mutations: readonly MutationEvent[]): boolean {
  return mutations.some((m) => m.reversal === null);
}

/** Coverage as the kernel would state it from the call log alone. */
export function observedCoverage(calls: readonly CallRecord[]): Coverage {
  const paths = [...new Set(calls.flatMap((c) => c.paths_touched))].sort();
  return {
    scope_examined: paths,
    scope_not_examined: [],
    confidence: 'FACT',
    notes: 'derived from the adapter call log rather than from any agent statement',
  };
}
