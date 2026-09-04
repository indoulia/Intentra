import type {
  Assertion,
  ContextSectionName,
  IntakeRecord,
  RealityElement,
  Scope,
  WorkItem,
} from '@agentos/contracts';
import type { FreshnessClass } from './assertions.js';
import type { ProbeSession } from './session.js';

/**
 * What a probe is.
 *
 * "A probe answers one narrow question, declares its own availability, and degrades to
 * `UNKNOWN`. Probes are independent and safely parallel; none of them mutate anything"
 * ([CONTEXT_MODEL.md](../../docs/CONTEXT_MODEL.md) section 3).
 *
 * Two kinds, because the package has two shapes of destination. A **section probe** writes
 * named assertions into one of the twenty-three sections. A **reality probe** writes exactly
 * one of the ten `current_reality` elements, which is what makes `reprobeReality` a lookup
 * rather than a re-run of everything: the kernel re-reads one stale element before evaluating
 * a predicate over it, and it must be able to do that cheaply enough to do it every time.
 */

/**
 * A section's assertions.
 *
 * The value type admits `undefined` because the contract's `ContextSection` does: a section is
 * an open map whose keys the probes choose, and a lookup of a key nobody wrote is `undefined`
 * rather than an error. Every reader here narrows before using one, which is the point — an
 * absent key and an `UNKNOWN` assertion are different, and neither is a value.
 */
export type SectionAssertions = Readonly<Record<string, Assertion | undefined>>;

/** What a probe may read from the probes that ran before it in the same tier. */
export interface ProbeLedger {
  section(name: ContextSectionName): SectionAssertions;
  /** An established assertion, or `undefined` where the key was never written. */
  assertion(section: ContextSectionName, key: string): Assertion | undefined;
  /**
   * The value of an established assertion, or `undefined` where it is `UNKNOWN`.
   *
   * Returning `undefined` for an `UNKNOWN` is deliberate: a probe reading another probe's
   * result must not be able to treat "not established" as a value, because that is how an
   * `UNKNOWN` becomes a `FACT` two steps downstream with nobody having decided to promote it.
   */
  value(section: ContextSectionName, key: string): unknown;
  reality(element: RealityElement): Assertion | undefined;
  realityValue(element: RealityElement): unknown;
}

export interface ProbeInput {
  readonly tier: 1 | 2 | 3;
  readonly runId: string;
  /** Present from tier 2 onward. Tier 1 runs before resolution, so there is no work item. */
  readonly workItem: WorkItem | null;
  /**
   * The intake, available at tier 1 for its *locator* and never for its wording. Nothing in
   * `current_reality` may be derived from it, and no probe here reads `intake.raw`.
   */
  readonly intake: IntakeRecord | null;
  readonly repositoryPath: string;
  readonly scope: Scope;
  readonly ledger: ProbeLedger;
}

export interface SectionProbeResult {
  readonly assertions: SectionAssertions;
  /** False where the probe could not run at all. Availability is itself recorded. */
  readonly available: boolean;
  readonly detail: string;
  /**
   * What this probe set out to examine. `scope_not_examined` is this minus what the adapter
   * calls actually touched, so an over-claim is arithmetic rather than an honour system.
   */
  readonly intendedScope: readonly string[];
}

export interface SectionProbe {
  readonly name: string;
  readonly section: ContextSectionName;
  /** 1 is orientation, 2 is work-item-relevant depth. Tier 3 runs any probe on demand. */
  readonly tier: 1 | 2;
  readonly freshnessClass: FreshnessClass;
  run(session: ProbeSession, input: ProbeInput): Promise<SectionProbeResult>;
}

export interface RealityProbeResult {
  readonly assertion: Assertion;
  readonly available: boolean;
  readonly detail: string;
  readonly intendedScope: readonly string[];
}

export interface RealityProbe {
  readonly name: string;
  readonly element: RealityElement;
  readonly freshnessClass: FreshnessClass;
  run(session: ProbeSession, input: ProbeInput): Promise<RealityProbeResult>;
}

/** A ledger over plain objects, which is all the runner needs to build. */
export function makeLedger(
  sections: Readonly<Record<string, SectionAssertions>>,
  reality: Readonly<Record<string, Assertion>>,
): ProbeLedger {
  return {
    section: (name) => sections[name] ?? {},
    assertion: (name, key) => sections[name]?.[key],
    value: (name, key) => {
      const assertion = sections[name]?.[key];
      if (assertion === undefined || assertion.confidence === 'UNKNOWN') return undefined;
      return assertion.value;
    },
    reality: (element) => reality[element],
    realityValue: (element) => {
      const assertion = reality[element];
      if (assertion === undefined || assertion.confidence === 'UNKNOWN') return undefined;
      return assertion.value;
    },
  };
}

/** A defensive read of an adapter's untyped return value. */
export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

export function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Records of a list operation, each defensively narrowed to an object. */
export function records(value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const list = asArray(value);
  if (list === null) return [];
  const out: Array<Readonly<Record<string, unknown>>> = [];
  for (const entry of list) {
    const record = asRecord(entry);
    if (record !== null) out.push(record);
  }
  return out;
}

/** Strings from a list operation that may return either strings or `{ path }` objects. */
export function paths(value: unknown): readonly string[] {
  const list = asArray(value);
  if (list === null) return [];
  const out: string[] = [];
  for (const entry of list) {
    const direct = asString(entry);
    if (direct !== null) {
      out.push(direct);
      continue;
    }
    const record = asRecord(entry);
    const path = record === null ? null : asString(record['path']);
    if (path !== null) out.push(path);
  }
  return out;
}
