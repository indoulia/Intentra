import type {
  AdapterCallContext,
  AdapterRegistry,
  Assertion,
  CapabilityRecord,
  Clock,
  ContextPackage,
  DeepenRequest,
  DiscoveryPort,
  OrientRequest,
  ProbeOutcome,
  ProbeRequest,
  RealityElement,
  Scope,
  WorkItem,
} from '@agentos/contracts';
import type { FreshnessWindows, Promotion } from './assertions.js';
import { inlineEvidence } from './assertions.js';
import { assemble, ASSERTION_SECTIONS, REALITY_ELEMENTS } from './package.js';
import type { AssertionSectionName } from './package.js';
import type { SectionAssertions, SectionProbe } from './probe.js';
import { makeLedger } from './probe.js';
import { CAPABILITY_TIER_1 } from './probes/capabilities.js';
import { GIT_TIER_1, GIT_TIER_2 } from './probes/git.js';
import { PM_TIER_1, PM_TIER_2 } from './probes/pm.js';
import { REALITY_PROBES, realityProbeFor } from './probes/reality.js';
import { REPOSITORY_TIER_1, REPOSITORY_TIER_2 } from './probes/repository.js';
import { RUNTIME_TIER_2 } from './probes/runtime.js';
import type { CapabilitySource, SourceConflict } from './reconciliation.js';
import { ProbeSession, type ProbeRefusal } from './session.js';

/**
 * `DiscoveryPort`, implemented.
 *
 * The three tiers of [CONTEXT_MODEL.md](../../docs/CONTEXT_MODEL.md) section 6, and the
 * one operation that is not a tier at all.
 *
 * - **`orient`** — tier 1, before resolution. Identity, structure, stack, git state,
 *   project-management access, agent and model capabilities. Enough to resolve the work item,
 *   and no more, because discovery does not know what is relevant until a Work Item with a
 *   scope exists. That is why `RESOLUTION` precedes `CONTEXT_DISCOVERY`.
 * - **`deepen`** — tier 2, against the admitted scope, plus the `current_reality` set.
 * - **`probe`** — tier 3, one named probe on demand, merged into a **new version** of the
 *   package rather than into the one an agent is already holding.
 * - **`reprobeReality`** — not a tier. One element, re-read against the world, moments before
 *   the kernel evaluates a predicate over it. It returns an assertion rather than a package
 *   precisely because it is not a new thing for agents to read: it is the kernel refusing to
 *   decide a transition on a snapshot. Git and pull-request state expire in minutes, and a
 *   review comment arriving mid-implementation must not be invisible for the rest of the run.
 */

/** The order tier-1 probes run in. Identity first: every other locator is relative to it. */
export const TIER_1_PROBES: readonly SectionProbe[] = [
  ...REPOSITORY_TIER_1,
  ...GIT_TIER_1,
  ...PM_TIER_1,
  ...CAPABILITY_TIER_1,
];

/**
 * The order tier-2 probes run in.
 *
 * Repository before runtime, because `runtime.environments` reconciles what the repository
 * declares against what is running, and `runtime.production` compares a deployed revision
 * against the repository head. A probe that reads another's result reads it through the
 * ledger, which returns `undefined` for anything still `UNKNOWN` — so a wrong order degrades
 * to a stated gap rather than to a wrong answer.
 */
export const TIER_2_PROBES: readonly SectionProbe[] = [
  ...REPOSITORY_TIER_2,
  ...GIT_TIER_2,
  ...PM_TIER_2,
  ...RUNTIME_TIER_2,
];

export const ALL_SECTION_PROBES: readonly SectionProbe[] = [...TIER_1_PROBES, ...TIER_2_PROBES];

export interface DiscoveryOptions {
  readonly adapters: AdapterRegistry;
  readonly clock: Clock;
  /**
   * Per-class freshness windows, from `budgets.freshness_windows_ms`.
   *
   * Injected rather than loaded: `discovery/` depends on `contracts` and `adapters` and not on
   * `policies`, and a window hard-coded here would be a policy threshold compiled into a
   * component. The composition root has the policy set and passes this in.
   */
  readonly freshnessWindows: FreshnessWindows;
  /** Capability records the run already holds, where the registry has been built. */
  readonly capabilities?: CapabilitySource;
  /** The reference the package's `capabilities` section carries. */
  readonly capabilityRegistryRef?: string | null;
}

/** One recorded re-probe, so that a re-read is auditable rather than invisible. */
export interface ReprobeRecord {
  readonly element: RealityElement;
  readonly at: string;
  readonly confidence: string;
  readonly freshness: string;
  readonly detail: string;
}

const EMPTY_SCOPE: Scope = { paths: [], capabilities: [], repositories: [] };

/** One section's assertions out of a package, narrowed once so no caller has to cast. */
function assertionSection(
  context: ContextPackage,
  section: AssertionSectionName,
): SectionAssertions {
  return context[section];
}

export class DiscoveryService implements DiscoveryPort {
  readonly #adapters: AdapterRegistry;
  readonly #clock: Clock;
  readonly #windows: FreshnessWindows;
  readonly #capabilities: CapabilitySource | null;
  readonly #registryRef: string | null;

  readonly #versions: ContextPackage[] = [];
  readonly #promotions: Promotion[] = [];
  readonly #refusedPromotions: string[] = [];
  readonly #refusals: ProbeRefusal[] = [];
  readonly #conflicts: SourceConflict[] = [];
  readonly #reprobes: ReprobeRecord[] = [];

  #runId = 'run_unstarted';
  #repositoryPath = '.';
  #workItem: WorkItem | null = null;

  constructor(options: DiscoveryOptions) {
    this.#adapters = options.adapters;
    this.#clock = options.clock;
    this.#windows = options.freshnessWindows;
    this.#capabilities = options.capabilities ?? null;
    this.#registryRef = options.capabilityRegistryRef ?? null;
  }

  /**
   * Tier 1. Orientation, and nothing that needs a scope.
   *
   * The `current_reality` set is deliberately not computed here, and it is not left absent
   * either: every element is recorded as `NOT_COMPUTED` with the reason, because "nothing has
   * run yet" and "we looked and could not tell" lead to different decisions and must not read
   * the same.
   */
  async orient(request: OrientRequest): Promise<ContextPackage> {
    this.#runId = request.runId;
    this.#repositoryPath = request.repositoryPath;
    this.#workItem = null;

    const session = this.#session(request.runId, request.intake.intake_id, EMPTY_SCOPE);
    const result = await assemble({
      session,
      runId: request.runId,
      tier: 1,
      packageVersion: this.#nextVersion(),
      workItem: null,
      intake: request.intake,
      repositoryPath: request.repositoryPath,
      scope: EMPTY_SCOPE,
      previous: null,
      sectionProbes: TIER_1_PROBES,
      realityProbes: [],
      skipped: TIER_2_PROBES.map((probe) => ({
        probe,
        reason:
          'tier 1 is orientation only: enough to resolve the work item, and no more. Depth is '
          + 'bought at tier 2, against the scope the admitted work item names',
      })),
      realitySkipped: REALITY_PROBES.map((probe) => ({
        probe,
        reason:
          'current_reality is computed against an admitted work item, and tier 1 runs before '
          + 'resolution. Nothing failed; the work has not run',
      })),
      capabilityRecords: await this.#capabilityRecords(),
      capabilityRegistryRef: this.#registryRef,
    });

    return this.#record(session, result.context, result);
  }

  /**
   * Tier 2. Depth against the admitted scope, plus `current_reality`.
   *
   * Builds on the previous version rather than replacing it: an assertion tier 1 established
   * survives unless a tier-2 probe brings new evidence, and a strengthening with no new
   * evidence is refused and recorded as refused.
   */
  async deepen(request: DeepenRequest): Promise<ContextPackage> {
    this.#runId = request.runId;
    this.#repositoryPath = request.repositoryPath;
    this.#workItem = request.workItem;

    const previous = request.previous ?? this.latest();
    const session = this.#session(
      request.runId,
      request.workItem.work_item_id,
      request.workItem.scope,
    );
    const result = await assemble({
      session,
      runId: request.runId,
      tier: 2,
      packageVersion: this.#nextVersion(),
      workItem: request.workItem,
      intake: null,
      repositoryPath: request.repositoryPath,
      scope: request.workItem.scope,
      previous,
      sectionProbes: TIER_2_PROBES,
      realityProbes: REALITY_PROBES,
      skipped: [],
      realitySkipped: [],
      capabilityRecords: await this.#capabilityRecords(),
      capabilityRegistryRef: this.#registryRef,
    });

    return this.#record(session, result.context, result);
  }

  /**
   * Tier 3. One named probe, on demand, producing a new version of the package.
   *
   * A probe name the set does not contain is reported as unavailable rather than thrown. The
   * caller asked for an observation and there is none; saying so is the same answer discovery
   * gives for a source it cannot reach, and it keeps an agent's over-optimistic request from
   * failing a run.
   */
  async probe(request: ProbeRequest): Promise<ProbeOutcome> {
    const section = ALL_SECTION_PROBES.find((probe) => probe.name === request.probe);
    const reality = REALITY_PROBES.find((probe) => probe.name === request.probe);
    if (section === undefined && reality === undefined) {
      return {
        probe: request.probe,
        assertions: {},
        evidence: [],
        available: false,
        detail:
          `no probe named ${request.probe} exists. The probe set is fixed, so a name outside it `
          + 'establishes nothing, and reporting it unavailable is the honest answer to a '
          + 'request for an observation that cannot be made',
      };
    }

    const scope = request.scope;
    const session = this.#session(
      request.runId,
      this.#workItem?.work_item_id ?? request.runId,
      scope,
    );
    const previous = this.latest();
    const result = await assemble({
      session,
      runId: request.runId,
      tier: 3,
      packageVersion: this.#nextVersion(),
      workItem: this.#workItem,
      intake: null,
      repositoryPath: this.#repositoryPath,
      scope,
      previous,
      sectionProbes: section === undefined ? [] : [section],
      realityProbes: reality === undefined ? [] : [reality],
      skipped: [],
      realitySkipped: [],
      capabilityRecords: await this.#capabilityRecords(),
      capabilityRegistryRef: this.#registryRef,
    });
    this.#record(session, result.context, result);

    const produced: Record<string, Assertion> = {};
    if (section !== undefined) {
      const written = assertionSection(result.context, section.section as AssertionSectionName);
      const before = previous === null
        ? {}
        : assertionSection(previous, section.section as AssertionSectionName);
      for (const [key, assertion] of Object.entries(written)) {
        if (assertion === undefined) continue;
        if (before[key] === assertion) continue;
        produced[key] = assertion;
      }
    }
    if (reality !== undefined) {
      produced[reality.element] = result.context.current_reality[reality.element];
    }

    const evidence = Object.values(produced).flatMap((assertion) => inlineEvidence(assertion));
    return {
      probe: request.probe,
      assertions: produced,
      evidence,
      available: session.abortedBy === null && Object.keys(produced).length > 0,
      detail: `${request.probe} ran on demand because: ${request.reason}. `
        + `Sections requested: ${request.sections.join(', ') || 'none named'}. The result is `
        + `package version ${result.context.meta.package_version}, not a mutation of the one `
        + 'already handed out',
    };
  }

  /**
   * Re-reads one reality element against the world.
   *
   * This is what makes reality re-probed rather than snapshotted. The kernel calls it when an
   * element has fallen outside its freshness window, immediately before evaluating a predicate
   * over it, and the value it returns is the one the transition is decided on. A stale element
   * is never the one decided on, which is the property the whole review-and-resume loop rests
   * on.
   */
  async reprobeReality(
    element: RealityElement,
    workItem: WorkItem | null,
    scope: Scope,
  ): Promise<Assertion> {
    const probe = realityProbeFor(element);
    const session = this.#session(
      this.#runId,
      workItem?.work_item_id ?? this.#workItem?.work_item_id ?? this.#runId,
      scope,
    );
    const latest = this.latest();
    const sections: Record<string, SectionAssertions> = {};
    const reality: Record<string, Assertion> = {};
    if (latest !== null) {
      for (const name of ASSERTION_SECTIONS) {
        sections[name] = latest[name];
      }
      /* `reconciliation` lives alongside the ten elements and is a state rather than an
       * assertion, so it is left out of the ledger the probe reads. */
      for (const element of REALITY_ELEMENTS) reality[element] = latest.current_reality[element];
    }

    const result = await probe.run(session, {
      tier: 3,
      runId: this.#runId,
      workItem: workItem ?? this.#workItem,
      intake: null,
      repositoryPath: this.#repositoryPath,
      scope,
      ledger: makeLedger(sections, reality),
    });

    for (const refusal of session.refusals) this.#refusals.push(refusal);
    this.#reprobes.push({
      element,
      at: session.nowIso(),
      confidence: result.assertion.confidence,
      freshness: result.assertion.freshness,
      detail: result.detail,
    });
    return result.assertion;
  }

  /* ------------------------------------------------------------- accessors ---- */

  /** Every version produced, oldest first. The package is versioned, not appended. */
  versions(): readonly ContextPackage[] {
    return this.#versions;
  }

  latest(): ContextPackage | null {
    return this.#versions[this.#versions.length - 1] ?? null;
  }

  /** Confidence strengthenings that were allowed, each with the new evidence that earned it. */
  promotions(): readonly Promotion[] {
    return this.#promotions;
  }

  /** Strengthenings refused for want of new evidence. Rule 2, made visible rather than silent. */
  refusedPromotions(): readonly string[] {
    return this.#refusedPromotions;
  }

  /** Every adapter refusal discovery met, with its kind. Never folded into an absence. */
  refusals(): readonly ProbeRefusal[] {
    return this.#refusals;
  }

  /** Source disagreements surfaced during assembly. */
  conflicts(): readonly SourceConflict[] {
    return this.#conflicts;
  }

  /** Every element re-read at predicate time, so a re-probe is auditable. */
  reprobes(): readonly ReprobeRecord[] {
    return this.#reprobes;
  }

  /** The elements a reality probe exists for, for the completeness check. */
  static coveredRealityElements(): readonly RealityElement[] {
    return REALITY_ELEMENTS.filter(
      (element) => REALITY_PROBES.some((probe) => probe.element === element),
    );
  }

  /* --------------------------------------------------------------- private ---- */

  #session(runId: string, workItemId: string, scope: Scope): ProbeSession {
    return new ProbeSession({
      registry: this.#adapters,
      context: this.#callContext(runId, workItemId, scope),
      clock: this.#clock,
      windows: this.#windows,
    });
  }

  /**
   * The call context every probe observes through.
   *
   * `stageMutating` is false and stays false: discovery mutates nothing, in any tier, under
   * any grant. The mandate is the admitted scope where there is one and empty where there is
   * not — orientation runs before a scope exists and is deliberately repository-wide and
   * shallow, and the absolute deny-list still holds either way, because that is the backstop
   * that does not depend on a scope having been computed correctly.
   */
  #callContext(runId: string, workItemId: string, scope: Scope): AdapterCallContext {
    return {
      workItemId,
      runId,
      dispatchId: null,
      mandate: { in_scope: [...scope.paths], out_of_scope: [] },
      grantsHeld: [],
      stageMutating: false,
    };
  }

  #nextVersion(): number {
    return this.#versions.length + 1;
  }

  #record(
    session: ProbeSession,
    context: ContextPackage,
    result: { readonly promotions: readonly Promotion[]; readonly refusedPromotions: readonly string[]; readonly conflicts: readonly SourceConflict[] },
  ): ContextPackage {
    this.#versions.push(context);
    for (const promotion of result.promotions) this.#promotions.push(promotion);
    for (const refused of result.refusedPromotions) this.#refusedPromotions.push(refused);
    for (const conflict of result.conflicts) this.#conflicts.push(conflict);
    for (const refusal of session.refusals) this.#refusals.push(refusal);
    return context;
  }

  async #capabilityRecords(): Promise<readonly CapabilityRecord[]> {
    if (this.#capabilities === null) return [];
    return this.#capabilities.records();
  }
}
