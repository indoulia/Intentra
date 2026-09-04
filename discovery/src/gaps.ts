import type { Assertion, ContextSectionName, UnknownRecord } from '@agentos/contracts';
import type { SectionAssertions } from './probe.js';
import type { ProbeRefusal } from './session.js';

/**
 * `gaps` as a first-class section.
 *
 * "What AgentOS does not know is as operationally important as what it does, and it drives
 * whether an agent may proceed" ([CONTEXT_MODEL.md](../../docs/CONTEXT_MODEL.md) section 4).
 * So every `UNKNOWN` in the package appears here with its reason, what was attempted, what
 * would resolve it, and — the field that makes it actionable rather than decorative — the
 * downstream obligations it blocks.
 *
 * The `blocks` list is not free text invented per gap. It is read off the frozen documents:
 * each `current_reality` element is named by specific reality predicates
 * ([WORKFLOW_STATE_MACHINE.md](../../docs/WORKFLOW_STATE_MACHINE.md) section 4.3), and each
 * degraded access has a stated consequence
 * ([REPOSITORY_ADAPTER.md](../../docs/REPOSITORY_ADAPTER.md) section 4). A gap that blocks
 * nothing is a contract violation, so a gap that cannot name a real obligation names the one
 * obligation that is always true: an agent declaring that section among its required inputs
 * receives an unknown where it expected a value.
 */

/**
 * The predicates each reality element is read by.
 *
 * From WORKFLOW_STATE_MACHINE section 4.3 and `policies/data/predicates.json`. Discovery
 * cannot depend on `policies/`, so the mapping is restated here against the frozen document
 * rather than imported — and the assembler asserts that every element has an entry, so a new
 * element cannot be added without landing in this table.
 */
const PREDICATES_READING: Readonly<Record<string, readonly string[]>> = {
  implementation_present: ['reality.implementation_present'],
  tests_present: ['reality.tests_present'],
  pr: ['reality.pr_open', 'reality.pr_merged', 'reality.ci_green'],
  ci: ['reality.ci_green'],
  reviews: ['reality.pr_approved', 'reality.pr_reviewed', 'reality.pr_has_unresolved_comments'],
  merge_state: ['reality.pr_merged'],
  deployment: ['reality.deployed'],
  outcome_evidence: ['reality.outcome_already_satisfied', 'regression.suspected'],
  children: ['reality.children_exist', 'reality.children_all_terminal'],
  agentos_history: ['reality.stage_completed_previously'],
};

/** The stated consequence of a degraded section, from REPOSITORY_ADAPTER section 4. */
const SECTION_CONSEQUENCE: Partial<Readonly<Record<ContextSectionName, readonly string[]>>> = {
  intent: [
    'the reconciliation matrix has an INDETERMINATE intent axis',
    'audit.applicable and the capability merge lose the intent source',
  ],
  runtime_state: [
    'production.applicable evaluates INDETERMINATE',
    'capability validation caps at integration level: every capability is at most PARTIAL and '
    + 'never PROVEN',
  ],
  production_state: [
    'production validation is NOT_VALIDATED, so completion is at best COMPLETE_WITH_GAPS and '
    + 'the gap is named',
  ],
  git_state: [
    'audit.applicable evaluates INDETERMINATE, which keeps the audit in the run',
  ],
  ui_map: ['ux.required evaluates INDETERMINATE, which keeps the UX review in the run'],
  api_map: ['architecture.required evaluates INDETERMINATE, which keeps the Architect in the run'],
  source_map: ['architecture.required evaluates INDETERMINATE'],
  data_map: ['architecture.required evaluates INDETERMINATE'],
  domain_model: ['architecture.required evaluates INDETERMINATE'],
  tests: ['every Definition of Done criterion resting on test evidence is NOT_VALIDATED'],
  repository: [
    'the Implementer cannot match conventions it could not read, and a change that is correct '
    + 'but foreign is a defect',
  ],
  agent_capabilities: ['skill selection runs against an incomplete capability surface'],
  model_capabilities: ['model selection runs against an incomplete model list'],
  architecture: ['architecture.required evaluates INDETERMINATE'],
  constraints: ['gate classification runs without the repository\'s declared constraints'],
  product: ['the Product and UX review runs without the stated purpose to judge against'],
  authorization: ['the authorization posture of this run cannot be stated'],
  capabilities: ['the capability registry has no reference for this run'],
  reconciliation: ['the three-way reconciliation cannot be computed'],
};

const REALITY_CONSEQUENCE =
  'a mutating stage whose satisfied_by stays INDETERMINATE after targeted discovery blocks '
  + 'with AMBIGUOUS_STATE and executes nothing, because AgentOS never re-executes a '
  + 'non-reversible operation on the strength of an INDETERMINATE';

function blocksForReality(element: string): readonly string[] {
  const predicates = PREDICATES_READING[element] ?? [];
  const blocked = predicates.map(
    (predicate) => `${predicate} evaluates INDETERMINATE rather than FALSE`,
  );
  return [...blocked, REALITY_CONSEQUENCE];
}

function blocksForSection(section: ContextSectionName, key: string): readonly string[] {
  const stated = SECTION_CONSEQUENCE[section];
  if (stated !== undefined && stated.length > 0) return stated;
  return [
    `any agent declaring ${section} among its required inputs receives an UNKNOWN for `
    + `${key} where it expected a value, and must request discovery or declare a blocker `
    + 'rather than proceed on it',
  ];
}

/** A gap id that is stable for a subject, so the same gap twice is the same record. */
function gapId(subject: string): string {
  return `unk_${subject.replace(/[^A-Za-z0-9_.:@/#-]+/g, '_')}`;
}

function recordFor(subject: string, assertion: Assertion, blocks: readonly string[]): UnknownRecord | null {
  if (assertion.confidence !== 'UNKNOWN') return null;
  return {
    id: gapId(subject),
    subject,
    reason: assertion.reason,
    attempted: assertion.attempted ?? 'nothing was recorded about what was attempted',
    recoverable_by: assertion.recoverable_by,
    blocks: [...blocks],
  };
}

export interface GapInput {
  readonly sections: Readonly<Record<string, SectionAssertions>>;
  readonly reality: Readonly<Record<string, Assertion>>;
  readonly refusals: readonly ProbeRefusal[];
}

/**
 * Every unknown in the package, with what it costs.
 *
 * Ordered by subject so that two runs over the same repository produce comparable lists, and
 * deduplicated by subject because one unknown recorded twice reads as two problems.
 */
export function collectGaps(input: GapInput): readonly UnknownRecord[] {
  const gaps = new Map<string, UnknownRecord>();

  for (const [element, assertion] of Object.entries(input.reality)) {
    const subject = `current_reality.${element}`;
    const record = recordFor(subject, assertion, blocksForReality(element));
    if (record !== null) gaps.set(subject, record);
  }

  for (const [section, assertions] of Object.entries(input.sections)) {
    for (const [key, assertion] of Object.entries(assertions)) {
      if (assertion === undefined) continue;
      const subject = `${section}.${key}`;
      const record = recordFor(
        subject, assertion, blocksForSection(section as ContextSectionName, key),
      );
      if (record !== null) gaps.set(subject, record);
    }
  }

  /*
   * A refusal is not a gap, and it also leaves one. The assertion it produced is already
   * above with the refusal named in `attempted`; this record exists so that the refusal itself
   * is enumerable, with its kind, rather than only readable inside a sentence.
   */
  for (const refusal of input.refusals) {
    const subject = `refusal.${refusal.adapter}.${refusal.op}`;
    gaps.set(subject, {
      id: gapId(subject),
      subject,
      reason: 'UNAVAILABLE',
      attempted: `${refusal.probe} called ${refusal.adapter}.${refusal.op} and the adapter `
        + `refused it as a ${refusal.refusal}: ${refusal.message}`,
      recoverable_by: refusal.refusal === 'security_violation'
        ? 'investigate the attempt. A security violation aborts the session and is reported '
          + 'regardless of the outcome of the run; it is not resolved by retrying'
        : 'widen the work item scope through resolution, or grant the missing access, and '
          + 're-probe',
      blocks: [
        `everything ${refusal.probe} would have established`,
        'the refusal is AgentOS\'s own enforcement acting, so it is recorded as a refusal and '
        + 'never as an absence in the system under study',
      ],
    });
  }

  return [...gaps.values()].sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
}

/** The reality elements the gap table knows how to account for. */
export const GAP_TABLE_ELEMENTS: readonly string[] = Object.keys(PREDICATES_READING);
