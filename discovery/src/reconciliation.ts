import type {
  Assertion,
  CapabilityRecord,
  ContextSectionName,
  ReconciliationMatrix,
  ReconciliationState,
  WorkItem,
} from '@agentos/contracts';
import { INTENT_KEYS } from './intent-keys.js';
import type { SectionAssertions } from './probe.js';
import { asArray, asBoolean, asString, records } from './probe.js';
import type { ProbeSession } from './session.js';

/**
 * The three-way reconciliation, at both levels the design uses it.
 *
 * One enum, one rule, two subjects. At **capability** level it answers "does this capability
 * work"; at **work-item** level it answers "where does this piece of work stand"
 * ([CONTEXT_MODEL.md](../../docs/CONTEXT_MODEL.md) sections 5 and 5.5). The states are the
 * same eight because the question has the same shape, and the one that matters most is the
 * one an optimistic reading destroys:
 *
 * > `INDETERMINATE` is not a failure of the run. It is an honest state, and downstream agents
 * > must handle it rather than assume the optimistic reading.
 *
 * The authority rule is what makes the contradictions resolvable rather than arbitrary: **each
 * source is authoritative about its own subject and nothing else.** Git owns repository
 * content and pull request existence. The project-management system owns the ticket's own
 * status and is at most an inference about the system. AgentOS's event log owns what AgentOS
 * did and says nothing about whether it still holds.
 *
 * Where two sources disagree, the rule selects a winner *for the value* and the disagreement
 * is still recorded. "AgentOS believes it opened a pull request that does not exist" is worth
 * knowing regardless of which action follows, and a reconciliation that quietly took git's
 * answer and moved on would have thrown away the only sign that something is wrong.
 */

/** A disagreement between sources, carried with every candidate and its provenance. */
export interface SourceConflict {
  readonly subject: string;
  readonly candidates: ReadonlyArray<{
    readonly source: string;
    readonly claim: string;
    /** What this source is authoritative about, which is what decides who wins. */
    readonly authority: string;
  }>;
  /** `AUTHORITY_RULE` means a documented rule selected the value; the conflict is still a finding. */
  readonly resolution: 'AUTHORITY_RULE' | 'UNRESOLVED';
  readonly winner: string | null;
  readonly detail: string;
}

export interface WorkItemReconciliation {
  readonly state: ReconciliationState;
  readonly rationale: string;
  readonly conflicts: readonly SourceConflict[];
  /** What each axis was found to say, for the narrative and for the tests. */
  readonly axes: {
    readonly intent: AxisReading;
    readonly code: AxisReading;
    readonly runtime: AxisReading;
  };
}

export type AxisReading = 'PRESENT' | 'ABSENT' | 'UNKNOWN';

/** Three-valued truth over an assertion: `UNKNOWN` is never `ABSENT`. */
function reading(assertion: Assertion | undefined): AxisReading {
  if (assertion === undefined || assertion.confidence === 'UNKNOWN') return 'UNKNOWN';
  const value = assertion.value;
  if (value === null || value === undefined) return 'UNKNOWN';
  if (typeof value === 'boolean') return value ? 'PRESENT' : 'ABSENT';
  if (Array.isArray(value)) return value.length > 0 ? 'PRESENT' : 'ABSENT';
  if (typeof value === 'object') return 'PRESENT';
  if (typeof value === 'string') return value.length > 0 ? 'PRESENT' : 'ABSENT';
  if (typeof value === 'number') return value !== 0 ? 'PRESENT' : 'ABSENT';
  return 'UNKNOWN';
}

function field(assertion: Assertion | undefined, name: string): unknown {
  if (assertion === undefined || assertion.confidence === 'UNKNOWN') return undefined;
  const value = assertion.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[name];
}

/**
 * The strict readers for the `current_reality` elements.
 *
 * Generic truthiness is wrong for every one of them, and wrong in the dangerous direction. Each
 * element's value is a small typed record whose vocabulary the kernel's predicates already
 * define (`core/src/predicates.ts`), and reading it any other way invents disagreement between
 * two components looking at the same field. One rule governs all of them:
 *
 * - an `UNKNOWN` assertion, an absent field, or a value outside the element's vocabulary reads
 *   `UNKNOWN` — never a negative, because "we could not look" and "we looked and it is not
 *   there" are different answers and only the second may move a verdict;
 * - only an explicit, in-vocabulary observation produces `PRESENT` or `ABSENT`.
 */

/** The `state` field of a pull-request-shaped element, upper-cased, or null. */
function stateOf(assertion: Assertion | undefined): string | null {
  const state = field(assertion, 'state');
  return typeof state === 'string' ? state.toUpperCase() : null;
}

/**
 * Is a change proposed?
 *
 * Read exactly as `core/src/predicates.ts` reads it. An element with no `state`, a null state,
 * or one of the vocabulary's own words for "nothing is proposed" is an **observed absence**:
 * the git host answered and there is no pull request. Taking the presence of the key as the
 * presence of a pull request would turn "nobody has proposed a change" into code progress that
 * does not exist, and report a work item at `INTENT_ONLY` as `CODE_NO_RUNTIME`.
 */
function pullRequestExists(pr: Assertion | undefined): AxisReading {
  if (pr === undefined || pr.confidence === 'UNKNOWN') return 'UNKNOWN';
  const value = pr.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'UNKNOWN';
  const state = (value as Record<string, unknown>)['state'];
  if (state === undefined || state === null) return 'ABSENT';
  if (typeof state !== 'string') return 'UNKNOWN';
  const upper = state.toUpperCase();
  return upper === 'NONE' || upper === 'NOT_PROPOSED' ? 'ABSENT' : 'PRESENT';
}

/**
 * Has the change landed?
 *
 * Three-valued, because "neither the pull request nor the merge state could be read" is not
 * "it is not merged". `CLAIMED_DONE_UNPROVEN` rests on an *observed* absence of a merge and
 * never on a failure to look — otherwise an unreachable git host would manufacture the finding.
 */
function mergedReading(
  pr: Assertion | undefined,
  merge: Assertion | undefined,
): AxisReading {
  const prKnown = pr !== undefined && pr.confidence !== 'UNKNOWN';
  const mergeKnown = merge !== undefined && merge.confidence !== 'UNKNOWN';
  if (!prKnown && !mergeKnown) return 'UNKNOWN';
  return stateOf(pr) === 'MERGED' || stateOf(merge) === 'MERGED' ? 'PRESENT' : 'ABSENT';
}

/**
 * Is the change present in any environment?
 *
 * A `deployment` element carrying no `environments` list has established nothing; one carrying
 * an empty list has established something — the environments were asked and the change is in
 * none of them. The same trap as the pull-request one: an absent field read as a negative.
 */
function deployedReading(deployment: Assertion | undefined): AxisReading {
  if (deployment === undefined || deployment.confidence === 'UNKNOWN') return 'UNKNOWN';
  const environments = asArray(field(deployment, 'environments'));
  if (environments === null) return 'UNKNOWN';
  return environments.length > 0 ? 'PRESENT' : 'ABSENT';
}

/**
 * A boolean-valued element: `implementation_present`, `tests_present`, `outcome_evidence`, and
 * the ticket's completion claim.
 *
 * Anything that is not a boolean is outside the vocabulary and reads `UNKNOWN` rather than
 * being coerced into whichever answer JavaScript truthiness happens to hand back.
 */
function booleanReading(assertion: Assertion | undefined): AxisReading {
  if (assertion === undefined || assertion.confidence === 'UNKNOWN') return 'UNKNOWN';
  if (typeof assertion.value !== 'boolean') return 'UNKNOWN';
  return assertion.value ? 'PRESENT' : 'ABSENT';
}

/**
 * Does anything intend this work?
 *
 * The ticket first, because a work item with an external identity has one. Where there is none
 * the ticket probe records `NOT_COMPUTED` — nothing failed, there is simply no ticket to read —
 * and the surrounding backlog search is what can still answer. Only where neither could be read
 * is the axis `UNKNOWN`, which with no project-management access at all is exactly the stated
 * degradation: an `INDETERMINATE` intent axis.
 */
function intentReading(intent: SectionAssertions): AxisReading {
  const ticket = intent[INTENT_KEYS.ticket];
  if (ticket !== undefined && ticket.confidence !== 'UNKNOWN') return reading(ticket);

  const issues = intent[INTENT_KEYS.issues];
  if (issues === undefined || issues.confidence === 'UNKNOWN') return 'UNKNOWN';
  const nothingToRead = ticket === undefined || ticket.reason === 'NOT_COMPUTED';
  if (nothingToRead) return reading(issues);
  return reading(issues) === 'PRESENT' ? 'PRESENT' : 'UNKNOWN';
}

export interface WorkItemReconciliationInput {
  readonly reality: Readonly<Record<string, Assertion>>;
  readonly intent: SectionAssertions;
  readonly workItem: WorkItem | null;
}

/**
 * Where this piece of work stands, from the three axes and nothing else.
 *
 * Note what is not consulted: the intake, the work item's own lifecycle field, and any
 * agent's account of a previous run. The intent axis reads the *ticket's* claim, which is
 * authoritative about the ticket, and the whole reason it is kept on its own axis is so that
 * "Jira says Done" can produce `CLAIMED_DONE_UNPROVEN` rather than `ALIGNED`.
 */
export function reconcileWorkItem(
  input: WorkItemReconciliationInput,
): WorkItemReconciliation {
  const { reality, intent } = input;
  const conflicts: SourceConflict[] = [];

  /* ------------------------------------------------------------ the axes ---- */

  const claimsCompletion = booleanReading(intent[INTENT_KEYS.claimsCompletion]);
  const intentAxis = intentReading(intent);

  const implementation = booleanReading(reality['implementation_present']);
  const prExists = pullRequestExists(reality['pr']);
  const merged = mergedReading(reality['pr'], reality['merge_state']);
  const codeAxis: AxisReading = implementation === 'PRESENT' || prExists === 'PRESENT'
    ? 'PRESENT'
    : (implementation === 'UNKNOWN' && prExists === 'UNKNOWN' ? 'UNKNOWN' : 'ABSENT');

  const deployed = deployedReading(reality['deployment']);
  const outcome = booleanReading(reality['outcome_evidence']);
  const runtimeAxis: AxisReading = outcome === 'PRESENT' || deployed === 'PRESENT'
    ? 'PRESENT'
    : (outcome === 'UNKNOWN' && deployed === 'UNKNOWN' ? 'UNKNOWN' : 'ABSENT');

  /* ------------------------------------------------------- the conflicts ---- */

  /*
   * AgentOS's ledger against git, on git's own subject. The ledger is authoritative about
   * what AgentOS did — it records that a pull request was opened, not that one exists now —
   * so git wins the value and the discrepancy is still a finding.
   */
  const history = reality['agentos_history'];
  const ledgerOpenedPr = history !== undefined && history.confidence !== 'UNKNOWN'
    && records(history.value).some((run) => {
      const stages = asArray(run['stages_completed']) ?? [];
      return stages.some((stage) => asString(stage) === 'PR_PREPARATION');
    });
  if (ledgerOpenedPr && prExists === 'ABSENT') {
    conflicts.push({
      subject: 'current_reality.pr',
      candidates: [
        {
          source: 'agentos-ledger',
          claim: 'a prior run completed PR_PREPARATION against this work item',
          authority: "what AgentOS did, and nothing about whether it still holds",
        },
        {
          source: 'git',
          claim: 'no pull request for this work item exists',
          authority: 'whether a change is proposed',
        },
      ],
      resolution: 'AUTHORITY_RULE',
      winner: 'git',
      detail:
        'AgentOS believes it opened a pull request that does not exist. Git owns pull request '
        + 'existence so its answer is the value, and the discrepancy is recorded as a finding '
        + 'because it is worth knowing regardless of which action follows',
    });
  }

  /*
   * The ticket against the repository, on the repository's subject. A ticket claiming the work
   * is finished while nothing is merged is the archetypal CLAIMED_DONE_UNPROVEN, and it is a
   * conflict as well as a state: somebody moved a ticket for a reason.
   */
  if (claimsCompletion === 'PRESENT' && merged === 'ABSENT' && codeAxis !== 'UNKNOWN') {
    conflicts.push({
      subject: 'work item completion',
      candidates: [
        {
          source: 'project-management',
          claim: `the ticket's own status claims the work is complete`,
          authority: "the ticket's own status, and at most an inference about the system",
        },
        {
          source: 'git',
          claim: 'no merged change implements this work',
          authority: 'what the repository contains',
        },
      ],
      resolution: 'AUTHORITY_RULE',
      winner: 'git',
      detail:
        'the ticket claims completion and no merged change supports it. The ticket is '
        + 'authoritative about the ticket, so the claim stands as a claim and the work is not '
        + 'treated as done',
    });
  }

  /* --------------------------------------------------------- the verdict ---- */

  if (conflicts.length > 0 && claimsCompletion === 'PRESENT' && merged === 'ABSENT'
    && codeAxis !== 'UNKNOWN' && !ledgerOpenedPr) {
    return {
      state: 'CLAIMED_DONE_UNPROVEN',
      rationale:
        'intent says the work is complete and no merged change proves it. The ticket is a fact '
        + 'about the ticket and at most an inference about the system',
      conflicts,
      axes: { intent: intentAxis, code: codeAxis, runtime: runtimeAxis },
    };
  }

  if (conflicts.length > 0) {
    return {
      state: 'CONFLICTING',
      rationale: conflicts.map((c) => c.detail).join('; '),
      conflicts,
      axes: { intent: intentAxis, code: codeAxis, runtime: runtimeAxis },
    };
  }

  const unknownAxes = [
    intentAxis === 'UNKNOWN' ? 'intent' : null,
    codeAxis === 'UNKNOWN' ? 'code' : null,
    runtimeAxis === 'UNKNOWN' ? 'runtime' : null,
  ].filter((axis): axis is string => axis !== null);

  if (unknownAxes.length > 0) {
    return {
      state: 'INDETERMINATE',
      rationale:
        `the ${unknownAxes.join(' and ')} axis could not be read, so this cannot be reconciled `
        + 'yet. An unreachable source is INDETERMINATE and is emphatically not an empty one',
      conflicts,
      axes: { intent: intentAxis, code: codeAxis, runtime: runtimeAxis },
    };
  }

  /* An observed absence of a merge, never an unread one: `merged === 'UNKNOWN'` has already
   * made the code axis unknown above, and the run is INDETERMINATE rather than accused. */
  if (claimsCompletion === 'PRESENT' && merged === 'ABSENT') {
    return {
      state: 'CLAIMED_DONE_UNPROVEN',
      rationale: 'intent says the work is complete and no merged change proves it',
      conflicts,
      axes: { intent: intentAxis, code: codeAxis, runtime: runtimeAxis },
    };
  }

  if (codeAxis === 'PRESENT' && runtimeAxis === 'PRESENT'
    && (intentAxis === 'PRESENT' || claimsCompletion === 'PRESENT')) {
    return {
      state: 'ALIGNED',
      rationale: 'intent, code and runtime agree that this work exists and holds',
      conflicts,
      axes: { intent: intentAxis, code: codeAxis, runtime: runtimeAxis },
    };
  }

  if (codeAxis === 'ABSENT' && runtimeAxis === 'ABSENT' && intentAxis === 'PRESENT') {
    return {
      state: 'INTENT_ONLY',
      rationale: 'a ticket exists and nothing has been built or observed for it',
      conflicts,
      axes: { intent: intentAxis, code: codeAxis, runtime: runtimeAxis },
    };
  }

  if (codeAxis === 'ABSENT' && runtimeAxis === 'PRESENT') {
    return {
      state: 'RUNTIME_NO_CODE',
      rationale:
        'the outcome is observable in a running system and nothing in this repository '
        + 'implements it. That is a finding about where the behaviour actually lives',
      conflicts,
      axes: { intent: intentAxis, code: codeAxis, runtime: runtimeAxis },
    };
  }

  if (codeAxis === 'PRESENT' && runtimeAxis === 'ABSENT') {
    return {
      state: 'CODE_NO_RUNTIME',
      rationale:
        'a change exists in the repository and nothing has been observed to run or produce '
        + 'evidence for it',
      conflicts,
      axes: { intent: intentAxis, code: codeAxis, runtime: runtimeAxis },
    };
  }

  if (codeAxis === 'PRESENT' && intentAxis === 'ABSENT') {
    return {
      state: 'CODE_ONLY',
      rationale: 'a change exists with no stated intent behind it',
      conflicts,
      axes: { intent: intentAxis, code: codeAxis, runtime: runtimeAxis },
    };
  }

  return {
    state: 'INDETERMINATE',
    rationale:
      `intent is ${intentAxis}, code is ${codeAxis} and runtime is ${runtimeAxis}, and no rule `
      + 'in the matrix selects a state for that combination. Naming it INDETERMINATE is the '
      + 'honest answer; choosing the optimistic one is not',
    conflicts,
    axes: { intent: intentAxis, code: codeAxis, runtime: runtimeAxis },
  };
}

/* ================================================= capability level ==== */

/**
 * Capability records the run already holds.
 *
 * Optional, and injected rather than imported: the registry lives in `registries/`, which
 * `discovery/` does not depend on. With none supplied, the matrix is built over the
 * capability ids the admitted work item names in its scope — the one capability identity set
 * the run actually has — and a matrix over nothing is recorded as a gap rather than
 * fabricated from a taxonomy.
 */
export interface CapabilitySource {
  records(): Promise<readonly CapabilityRecord[]>;
}

export interface CapabilityMatrixInput {
  readonly sections: Readonly<Record<ContextSectionName, SectionAssertions>>;
  readonly workItem: WorkItem | null;
  readonly capabilities: readonly CapabilityRecord[];
  readonly session: ProbeSession;
}

/** Does any observed value under this section key mention the capability? */
function mentions(section: SectionAssertions, keys: readonly string[], needle: string): boolean {
  const token = needle.toLowerCase();
  for (const key of keys) {
    const assertion = section[key];
    if (assertion === undefined || assertion.confidence === 'UNKNOWN') continue;
    if (JSON.stringify(assertion.value ?? null).toLowerCase().includes(token)) return true;
  }
  return false;
}

function anyKnown(section: SectionAssertions, keys: readonly string[]): boolean {
  return keys.some((key) => {
    const assertion = section[key];
    return assertion !== undefined && assertion.confidence !== 'UNKNOWN';
  });
}

/** Where a capability's *name* may appear in the intent section. Distinct from INTENT_KEYS,
 * which is where this work item's own ticket claim lives. */
const CAPABILITY_INTENT_KEYS = ['claimed_capabilities', 'issues', 'epics'] as const;
const CODE_KEYS = ['endpoints', 'paths', 'surfaces', 'sources', 'schema_paths', 'entity_paths'] as const;
const RUNTIME_KEYS = ['services', 'stores', 'service_health'] as const;

/**
 * The matrix, one row per capability, each row carrying what each source said.
 *
 * A row is only as strong as its weakest axis, and an axis nobody could read makes the row
 * `INDETERMINATE`. That is the point: a capability whose runtime nobody could reach is not a
 * capability that fails, and it is certainly not one that works.
 */
export function buildCapabilityMatrix(input: CapabilityMatrixInput): ReconciliationMatrix {
  const { sections, workItem, capabilities, session } = input;
  const observedAt = session.nowIso();

  const ids = new Set<string>();
  for (const record of capabilities) ids.add(record.id);
  for (const id of workItem?.scope.capabilities ?? []) ids.add(id);

  const intentSection = sections['intent'];
  const codeSections: SectionAssertions = {
    ...sections['api_map'],
    ...sections['ui_map'],
    ...sections['source_map'],
    ...sections['data_map'],
    ...sections['domain_model'],
  };
  const runtimeSection = sections['runtime_state'];

  const intentReadable = anyKnown(intentSection, CAPABILITY_INTENT_KEYS);
  const codeReadable = anyKnown(codeSections, CODE_KEYS);
  const runtimeReadable = anyKnown(runtimeSection, RUNTIME_KEYS);

  const rows: Array<{
    capability: string;
    intent: Assertion;
    code: Assertion;
    runtime: Assertion;
    state: ReconciliationState;
    rationale: string;
  }> = [];

  for (const id of [...ids].sort()) {
    const record = capabilities.find((c) => c.id === id);
    const seen = new Set(record?.sources_seen ?? []);

    const intentSeen = seen.has('INTENT') || mentions(intentSection, CAPABILITY_INTENT_KEYS, id);
    const codeSeen = seen.has('CODE') || mentions(codeSections, CODE_KEYS, id)
      || (record !== undefined && record.scope_paths.length > 0);
    const runtimeSeen = seen.has('RUNTIME') || mentions(runtimeSection, RUNTIME_KEYS, id);

    const intent: Assertion = intentReadable || seen.has('INTENT')
      ? session.derived(
        'reconcile.capability',
        intentSeen,
        ['intent.claimed_capabilities'],
        `whether the observed intent names ${id}. Intent naming a capability is a claim about `
        + 'what somebody wanted, never a confirmation that it exists',
        'intent',
        observedAt,
      )
      : session.unreachable(
        'reconcile.capability',
        `whether intent names ${id} could not be established: no project-management source was `
        + 'readable this run',
        'restore project-management access and re-probe',
        observedAt,
      );

    const code: Assertion = codeReadable || seen.has('CODE')
      ? session.derived(
        'reconcile.capability',
        codeSeen,
        ['api_map.endpoints', 'ui_map.surfaces', 'data_map.schema_paths'],
        `whether the repository contains code attributable to ${id}. Code existing is a `
        + 'structural reading and is upgraded to a fact only by tracing a real record through '
        + 'it at runtime',
        'repository',
        observedAt,
      )
      : session.unreachable(
        'reconcile.capability',
        `whether the repository implements ${id} could not be established: no code map was `
        + 'readable this run',
        'restore repository access and re-probe',
        observedAt,
      );

    const runtime: Assertion = runtimeReadable || seen.has('RUNTIME')
      ? session.derived(
        'reconcile.capability',
        runtimeSeen,
        ['runtime_state.services', 'runtime_state.stores'],
        `whether a running system shows ${id} operating. This is the axis that turns a `
        + 'structural inference into a fact, and the one most often missing',
        'runtime',
        observedAt,
      )
      : session.unreachable(
        'reconcile.capability',
        `whether ${id} runs could not be established: no runtime source was readable this run. `
        + 'Every capability caps at PARTIAL and none reaches PROVEN',
        'grant runtime access and re-probe',
        observedAt,
      );

    const axes = {
      intent: reading(intent),
      code: reading(code),
      runtime: reading(runtime),
    };
    const { state, rationale } = capabilityState(axes, record);
    rows.push({ capability: id, intent, code, runtime, state, rationale });
  }

  return rows;
}

function capabilityState(
  axes: { readonly intent: AxisReading; readonly code: AxisReading; readonly runtime: AxisReading },
  record: CapabilityRecord | undefined,
): { readonly state: ReconciliationState; readonly rationale: string } {
  const claimed = record?.status === 'CLAIMED';
  if (claimed && axes.runtime !== 'PRESENT' && axes.runtime !== 'UNKNOWN') {
    return {
      state: 'CLAIMED_DONE_UNPROVEN',
      rationale: 'the registry records this capability as asserted complete and no runtime '
        + 'evidence supports it',
    };
  }
  if (axes.intent === 'UNKNOWN' || axes.code === 'UNKNOWN' || axes.runtime === 'UNKNOWN') {
    const missing = [
      axes.intent === 'UNKNOWN' ? 'intent' : null,
      axes.code === 'UNKNOWN' ? 'code' : null,
      axes.runtime === 'UNKNOWN' ? 'runtime' : null,
    ].filter((axis): axis is string => axis !== null);
    return {
      state: 'INDETERMINATE',
      rationale: `the ${missing.join(' and ')} axis is unavailable, so this capability cannot `
        + 'be reconciled yet. That is an honest state and not a failure of the run',
    };
  }
  if (axes.intent === 'PRESENT' && axes.code === 'PRESENT' && axes.runtime === 'PRESENT') {
    return { state: 'ALIGNED', rationale: 'intent, code and runtime all account for it' };
  }
  if (axes.intent === 'PRESENT' && axes.code === 'ABSENT' && axes.runtime === 'ABSENT') {
    return { state: 'INTENT_ONLY', rationale: 'planned, and not built' };
  }
  if (axes.intent === 'ABSENT' && axes.code === 'PRESENT' && axes.runtime === 'ABSENT') {
    return {
      state: 'CODE_ONLY',
      rationale: 'built, with no stated intent and no observation of it running',
    };
  }
  if (axes.code === 'PRESENT' && axes.runtime === 'ABSENT') {
    return {
      state: 'CODE_NO_RUNTIME',
      rationale: 'it exists in code and has never been observed to run or produce data',
    };
  }
  if (axes.code === 'ABSENT' && axes.runtime === 'PRESENT') {
    return {
      state: 'RUNTIME_NO_CODE',
      rationale: 'it happens in the running system and is not in this repository',
    };
  }
  if (axes.intent === 'ABSENT' && axes.code === 'ABSENT' && axes.runtime === 'ABSENT') {
    return {
      state: 'INDETERMINATE',
      rationale: 'no source accounts for this capability at all, which says more about the '
        + 'identifier than about the system',
    };
  }
  return {
    state: 'ALIGNED',
    rationale: 'intent and runtime agree and the code axis follows them',
  };
}

/** Whether the merge state says the change landed, for callers that need only that. */
export function isMerged(reality: Readonly<Record<string, Assertion>>): boolean {
  return field(reality['pr'], 'state') === 'MERGED'
    || field(reality['merge_state'], 'state') === 'MERGED';
}

/** Exported for the assembler's conflict section. */
export function conflictSummary(conflicts: readonly SourceConflict[]): string {
  if (conflicts.length === 0) return 'no source disagreement was observed';
  return conflicts.map((c) => `${c.subject}: ${c.detail}`).join(' | ');
}

/** Whether an assertion carries a usable boolean, for the axis helpers above. */
export function booleanValue(assertion: Assertion | undefined): boolean | null {
  if (assertion === undefined || assertion.confidence === 'UNKNOWN') return null;
  return asBoolean(assertion.value);
}
