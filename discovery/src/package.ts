import type {
  Assertion,
  CallRecord,
  CapabilityRecord,
  ContextPackage,
  ContextSectionName,
  CurrentReality,
  IntakeRecord,
  ProbeCoverage,
  RealityElement,
  Scope,
  WorkItem,
} from '@agentos/contracts';
import type { Promotion } from './assertions.js';
import { promote } from './assertions.js';
import { collectGaps } from './gaps.js';
import { makeLedger, type ProbeInput, type RealityProbe, type SectionAssertions, type SectionProbe } from './probe.js';
import { buildCapabilityMatrix, conflictSummary, reconcileWorkItem, type SourceConflict } from './reconciliation.js';
import type { ProbeSession } from './session.js';

/**
 * Running the probes and assembling what they produced into a Context Package.
 *
 * Three properties of the assembly matter more than the mechanics.
 *
 * **The package is versioned, not appended.** A second discovery produces a new version; the
 * previous one is not mutated, and nothing an agent already read changes under it. Every
 * section here is rebuilt into fresh objects over the previous version's values, so the object
 * a caller is holding is still the version it was handed.
 *
 * **Coverage is computed from the call log.** A probe states what it set out to examine; what
 * it actually reached comes from the adapter calls it made. An agent must be able to
 * distinguish "the Auditor found no orphan readers here" from "discovery never looked here",
 * and a self-reported coverage figure does not let it.
 *
 * **A tier does not silently do another tier's work.** Tier 1 is orientation — enough to
 * resolve the work item, and no more — and the probes it does not run are recorded as skipped
 * with the reason, rather than being absent from the record.
 */

/** The twenty-three sections, so an empty package is a complete empty package. */
export const SECTION_NAMES: readonly ContextSectionName[] = [
  'meta', 'work_item', 'current_reality', 'repository', 'product', 'capabilities',
  'architecture', 'domain_model', 'source_map', 'data_map', 'api_map', 'ui_map',
  'tests', 'git_state', 'runtime_state', 'production_state', 'intent',
  'reconciliation', 'agent_capabilities', 'model_capabilities', 'constraints',
  'authorization', 'gaps',
];

/**
 * The sections probes write assertions into.
 *
 * Narrower than `ContextSectionName` on purpose: `meta`, `work_item`, `capabilities`,
 * `current_reality`, `reconciliation` and `gaps` have their own shapes, and a name that
 * indexes into one of them would be a type error waiting to become a cast.
 */
export type AssertionSectionName =
  | 'repository' | 'product' | 'architecture' | 'domain_model' | 'source_map' | 'data_map'
  | 'api_map' | 'ui_map' | 'tests' | 'git_state' | 'runtime_state' | 'production_state'
  | 'intent' | 'agent_capabilities' | 'model_capabilities' | 'constraints' | 'authorization';

export const ASSERTION_SECTIONS: readonly AssertionSectionName[] = [
  'repository', 'product', 'architecture', 'domain_model', 'source_map', 'data_map',
  'api_map', 'ui_map', 'tests', 'git_state', 'runtime_state', 'production_state',
  'intent', 'agent_capabilities', 'model_capabilities', 'constraints', 'authorization',
];

export const REALITY_ELEMENTS: readonly RealityElement[] = [
  'implementation_present', 'tests_present', 'pr', 'ci', 'reviews', 'merge_state',
  'deployment', 'outcome_evidence', 'children', 'agentos_history',
];

export interface AssembleInput {
  readonly session: ProbeSession;
  readonly runId: string;
  readonly tier: 1 | 2 | 3;
  readonly packageVersion: number;
  readonly workItem: WorkItem | null;
  readonly intake: IntakeRecord | null;
  readonly repositoryPath: string;
  readonly scope: Scope;
  readonly previous: ContextPackage | null;
  /** Section probes to run in this tier, in order. */
  readonly sectionProbes: readonly SectionProbe[];
  /** Reality probes to run. Empty at tier 1: orientation runs before the work item exists. */
  readonly realityProbes: readonly RealityProbe[];
  /** Probes deliberately not run in this tier, recorded as skipped with the reason. */
  readonly skipped: ReadonlyArray<{ readonly probe: SectionProbe; readonly reason: string }>;
  /** Reality elements deliberately not probed in this tier, with the reason. */
  readonly realitySkipped: ReadonlyArray<{ readonly probe: RealityProbe; readonly reason: string }>;
  readonly capabilityRecords: readonly CapabilityRecord[];
  /** The capability registry reference for this run, if the composition root has one. */
  readonly capabilityRegistryRef: string | null;
}

export interface AssembleResult {
  readonly context: ContextPackage;
  /** Confidence strengthenings that were allowed, so the kernel can record the event. */
  readonly promotions: readonly Promotion[];
  /** Strengthenings that were refused for want of new evidence. Rule 2, made visible. */
  readonly refusedPromotions: readonly string[];
  readonly conflicts: readonly SourceConflict[];
}

function coverageOf(
  probe: { readonly name: string; readonly section: ContextSectionName },
  state: ProbeCoverage['state'],
  reason: string | null,
  intendedScope: readonly string[],
  calls: readonly CallRecord[],
  observedAt: string,
): ProbeCoverage {
  const successful = calls.filter((call) => call.outcome === 'OK');
  const touched = [...new Set(successful.flatMap((call) => call.paths_touched))];
  /*
   * The probe's declared scope counts as examined only where it actually made a call that
   * came back. Where it made none, everything it intended is `scope_not_examined` — which is
   * the state a reader must be able to see, because it is the difference between an empty
   * finding and an unlooked-at subtree.
   */
  const examined = successful.length > 0
    ? [...new Set([...intendedScope, ...touched])]
    : touched;
  const notExamined = successful.length > 0
    ? []
    : [...intendedScope];
  return {
    probe: probe.name,
    section: probe.section,
    state,
    reason,
    scope_examined: examined.sort(),
    scope_not_examined: notExamined.sort(),
    observed_at: observedAt,
  };
}

function stateFor(available: boolean, assertions: SectionAssertions): ProbeCoverage['state'] {
  if (!available) return 'UNAVAILABLE';
  const values = Object.values(assertions);
  if (values.length === 0) return 'PARTIAL';
  return values.some((assertion) => assertion?.confidence === 'UNKNOWN') ? 'PARTIAL' : 'RAN';
}

/**
 * Runs the probes and builds the package.
 *
 * Sequential rather than parallel, and deliberately: probes are independent and safely
 * parallel by design, and the two things this assembly needs — a call log attributable to one
 * probe, and later probes reading what earlier ones established — are both properties of
 * order. A parallel runner would have to reconstruct both, and the reconstruction is where an
 * over-claimed coverage figure would come from.
 */
export async function assemble(input: AssembleInput): Promise<AssembleResult> {
  const { session } = input;
  const sections: Record<string, SectionAssertions> = {};
  const reality: Record<string, Assertion> = {};
  /*
   * Keyed by probe name and seeded from the previous version, so a later tier carries forward
   * what an earlier one recorded rather than presenting a package whose coverage table forgets
   * that orientation happened. A probe that runs again replaces its own entry.
   */
  const coverage = new Map<string, ProbeCoverage>();
  const promotions: Promotion[] = [];
  const refusedPromotions: string[] = [];

  /* Tier 2 builds on tier 1 rather than discarding it, and does so into new objects. */
  if (input.previous !== null) {
    for (const entry of input.previous.meta.probe_coverage) coverage.set(entry.probe, entry);
    for (const section of ASSERTION_SECTIONS) {
      sections[section] = { ...input.previous[section] };
    }
    for (const element of REALITY_ELEMENTS) {
      const existing = input.previous.current_reality[element];
      reality[element] = existing;
    }
  }

  const probeInput = (): ProbeInput => ({
    tier: input.tier,
    runId: input.runId,
    workItem: input.workItem,
    intake: input.intake,
    repositoryPath: input.repositoryPath,
    scope: input.scope,
    ledger: makeLedger(sections, reality),
  });

  for (const probe of input.sectionProbes) {
    const before = session.calls.length;
    if (session.abortedBy !== null) {
      coverage.set(probe.name, coverageOf(
        probe,
        'SKIPPED',
        `the probe session was aborted by a security violation on `
        + `${session.abortedBy.adapter}.${session.abortedBy.op}, so this probe never ran and `
        + 'this section is not examined rather than empty',
        [],
        [],
        session.nowIso(),
      ));
      continue;
    }

    const result = await probe.run(session, probeInput());
    const calls = session.calls.slice(before);
    const merged: Record<string, Assertion | undefined> = { ...(sections[probe.section] ?? {}) };
    for (const [key, assertion] of Object.entries(result.assertions)) {
      if (assertion === undefined) continue;
      const outcome = promote(`${probe.section}.${key}`, merged[key], assertion);
      merged[key] = outcome.assertion;
      if (outcome.promotion !== null) promotions.push(outcome.promotion);
      if (outcome.refused !== null) refusedPromotions.push(outcome.refused);
    }
    sections[probe.section] = merged;
    coverage.set(probe.name, coverageOf(
      probe,
      stateFor(result.available, result.assertions),
      result.detail,
      result.intendedScope,
      calls,
      session.nowIso(),
    ));
  }

  for (const { probe, reason } of input.skipped) {
    if (!coverage.has(probe.name)) {
      coverage.set(probe.name, coverageOf(probe, 'SKIPPED', reason, [], [], session.nowIso()));
    }
  }

  /* ------------------------------------------------------- current_reality ---- */

  for (const probe of input.realityProbes) {
    const before = session.calls.length;
    if (session.abortedBy !== null) {
      reality[probe.element] = session.unreachable(
        probe.name,
        `the probe session was aborted by a security violation on `
        + `${session.abortedBy.adapter}.${session.abortedBy.op} before this element was read`,
        'investigate the security violation, then re-probe this element',
      );
      coverage.set(probe.name, coverageOf(
        { name: probe.name, section: 'current_reality' },
        'SKIPPED',
        'aborted by a security violation',
        [],
        [],
        session.nowIso(),
      ));
      continue;
    }
    const result = await probe.run(session, probeInput());
    const calls = session.calls.slice(before);
    const outcome = promote(`current_reality.${probe.element}`, reality[probe.element], result.assertion);
    reality[probe.element] = outcome.assertion;
    if (outcome.promotion !== null) promotions.push(outcome.promotion);
    if (outcome.refused !== null) refusedPromotions.push(outcome.refused);
    coverage.set(probe.name, coverageOf(
      { name: probe.name, section: 'current_reality' },
      stateFor(result.available, { [probe.element]: result.assertion }),
      result.detail,
      result.intendedScope,
      calls,
      session.nowIso(),
    ));
  }

  for (const { probe, reason } of input.realitySkipped) {
    if (reality[probe.element] === undefined) {
      reality[probe.element] = session.notComputed(probe.name, reason, `run tier 2 discovery against the admitted work item, which is what computes current_reality`);
    }
    if (!coverage.has(probe.name)) {
      coverage.set(probe.name, coverageOf(
        { name: probe.name, section: 'current_reality' },
        'SKIPPED',
        reason,
        [],
        [],
        session.nowIso(),
      ));
    }
  }

  /*
   * Every element must exist. An element with no probe would leave the kernel evaluating a
   * predicate against a hole, and a hole reads as `undefined`, which the kernel treats as
   * INDETERMINATE — the right value for the wrong reason, and untraceable. Anything still
   * missing here is recorded explicitly as never attempted.
   */
  for (const element of REALITY_ELEMENTS) {
    if (reality[element] === undefined) {
      reality[element] = session.notComputed(
        'discovery.assemble',
        `no probe wrote current_reality.${element} in this tier`,
        'run the reality probe for this element, or implement one if the probe set has none',
      );
    }
  }

  /* --------------------------------------------------------- reconciliation ---- */

  const workItemReconciliation = reconcileWorkItem({
    reality,
    intent: sections['intent'] ?? {},
    workItem: input.workItem,
  });

  const sectionMap = Object.fromEntries(
    ASSERTION_SECTIONS.map((name) => [name, sections[name] ?? {}]),
  ) as Record<ContextSectionName, SectionAssertions>;

  const matrix = buildCapabilityMatrix({
    sections: sectionMap,
    workItem: input.workItem,
    capabilities: input.capabilityRecords,
    session,
  });

  /* ----------------------------------------------------- refusals and conflicts ---- */

  const observedAt = session.nowIso();
  const authorization: Record<string, Assertion | undefined> = { ...(sections['authorization'] ?? {}) };
  authorization['probe_refusals'] = session.derived(
    'discovery.assemble',
    session.refusals.map((refusal) => ({
      adapter: refusal.adapter,
      op: refusal.op,
      refusal: refusal.refusal,
      message: refusal.message,
      probe: refusal.probe,
      call_id: refusal.call_id,
    })),
    session.refusals.length > 0 ? session.refusals.map((r) => r.call_id) : ['adapter.call-log'],
    'refusals recorded during discovery, with their kind. A refusal is AgentOS\'s own '
    + 'enforcement acting; it is listed here so that it is enumerable as a refusal rather than '
    + 'readable only as an absence somewhere else in the package',
    'agentos',
    observedAt,
  );
  if (session.abortedBy !== null) {
    authorization['session_aborted_by'] = session.derived(
      'discovery.assemble',
      session.abortedBy,
      [session.abortedBy.call_id],
      'a security violation aborted the probe session. Everything after it is recorded as '
      + 'skipped rather than as empty, and the attempt is reported regardless of the outcome '
      + 'of the run',
      'agentos',
      observedAt,
    );
  }
  sections['authorization'] = authorization;

  const intent: Record<string, Assertion | undefined> = { ...(sections['intent'] ?? {}) };
  intent['source_conflicts'] = session.derived(
    'discovery.assemble',
    workItemReconciliation.conflicts,
    ['current_reality', 'intent'],
    `source disagreement across the three axes: ${conflictSummary(workItemReconciliation.conflicts)}. `
    + 'Each candidate is carried with its provenance, because silently picking one is a '
    + 'correctness bug',
    'intent',
    observedAt,
  );
  sections['intent'] = intent;

  /* ------------------------------------------------------------- the package ---- */

  const gaps = collectGaps({ sections, reality, refusals: session.refusals });

  const context: ContextPackage = {
    meta: {
      run_id: input.runId,
      work_item_id: input.workItem?.work_item_id ?? null,
      package_version: input.packageVersion,
      assembled_at: observedAt,
      tier: input.tier,
      probe_coverage: [...coverage.values()],
      adapter_availability: session.availability(),
    },
    work_item: input.workItem?.work_item_id ?? null,
    current_reality: {
      ...(reality as unknown as Omit<CurrentReality, 'reconciliation'>),
      reconciliation: workItemReconciliation.state,
    },
    repository: sections['repository'] ?? {},
    product: sections['product'] ?? {},
    capabilities: input.capabilityRegistryRef,
    architecture: sections['architecture'] ?? {},
    domain_model: sections['domain_model'] ?? {},
    source_map: sections['source_map'] ?? {},
    data_map: sections['data_map'] ?? {},
    api_map: sections['api_map'] ?? {},
    ui_map: sections['ui_map'] ?? {},
    tests: sections['tests'] ?? {},
    git_state: sections['git_state'] ?? {},
    runtime_state: sections['runtime_state'] ?? {},
    production_state: sections['production_state'] ?? {},
    intent: sections['intent'] ?? {},
    reconciliation: matrix,
    agent_capabilities: sections['agent_capabilities'] ?? {},
    model_capabilities: sections['model_capabilities'] ?? {},
    constraints: sections['constraints'] ?? {},
    authorization: sections['authorization'] ?? {},
    gaps,
  };

  return {
    context,
    promotions,
    refusedPromotions,
    conflicts: workItemReconciliation.conflicts,
  };
}
