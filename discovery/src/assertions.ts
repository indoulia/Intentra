import type {
  AbsenceReason,
  Assertion,
  ConfidenceClass,
  Evidence,
  EvidenceKind,
  EvidencePredicate,
  Freshness,
  Locator,
} from '@agentos/contracts';
import { digest } from '@agentos/contracts';
import { excerptOf } from './redact.js';

/**
 * The two rules of [CONTEXT_MODEL.md](../../docs/CONTEXT_MODEL.md) section 1, in code.
 *
 * **Rule 1 — every assertion carries a confidence class**, and the obligations of each class
 * are structural: a `FACT` owes evidence, an `INFERENCE` owes what it was derived from, an
 * `UNKNOWN` owes a reason from the one absence vocabulary and what would recover it. The
 * builders below are the only way this package makes an assertion, so there is no path that
 * produces a bare value and no path that invents a reason string.
 *
 * **Rule 2 — `UNKNOWN` never silently becomes `FACT`.** Promotion goes through `promote`,
 * which refuses a promotion carrying no new evidence and returns a record of the ones it
 * allowed, so the event the kernel logs has something to log.
 *
 * Freshness is the second, orthogonal axis. A value can be `FACT` and `STALE` at once, and
 * collapsing the two loses exactly the information that makes stale data safe to use.
 */

/** The freshness classes of `budgets.freshness_windows_ms`, which is where the windows live. */
export type FreshnessClass = 'git' | 'runtime' | 'repository' | 'intent' | 'agentos';

export type FreshnessWindows = Readonly<Record<FreshnessClass, number>>;

/**
 * Is an observation still current enough to be used without disclosure?
 *
 * An unparseable timestamp is `UNKNOWN` rather than `CURRENT`: a value whose age cannot be
 * established has not been shown to be fresh, and the kernel treats `UNKNOWN` freshness as
 * stale, which is the safe direction.
 */
export function freshnessOf(
  observedAt: string,
  freshnessClass: FreshnessClass,
  windows: FreshnessWindows,
  now: Date,
): Freshness {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) return 'UNKNOWN';
  const age = now.getTime() - observed;
  if (age < 0) return 'UNKNOWN';
  return age <= windows[freshnessClass] ? 'CURRENT' : 'STALE';
}

/** Deterministic evidence identity, so the same observation twice is the same evidence id. */
export function evidenceId(locator: Locator, observedAt: string): string {
  return `ev_${digest({ locator, observedAt }).slice(0, 16)}`;
}

export interface EvidenceInput {
  readonly kind: EvidenceKind;
  readonly locator: Locator;
  readonly ref: string;
  readonly value: unknown;
  readonly observedAt: string;
  /**
   * False for a genuinely unrepeatable observation, which caps the assertion it supports at
   * `INFERENCE`. Fail-closed: an operation whose observation safety could not be established
   * is not reproducible.
   */
  readonly reproducible: boolean;
  /** Mandatory for `log` and `metric`: the kernel re-evaluates a predicate, not a raw value. */
  readonly predicate?: EvidencePredicate;
}

export function makeEvidence(input: EvidenceInput): Evidence {
  const base = {
    id: evidenceId(input.locator, input.observedAt),
    kind: input.kind,
    locator: input.locator,
    ref: input.ref,
    excerpt: excerptOf(input.value),
    observed_at: input.observedAt,
    reproducible: input.reproducible,
  };
  return input.predicate === undefined ? base : { ...base, predicate: input.predicate };
}

export interface AssertionInput {
  readonly value: unknown;
  readonly probe: string;
  readonly observedAt: string;
  readonly freshnessClass: FreshnessClass;
  readonly windows: FreshnessWindows;
  readonly now: Date;
}

/**
 * A directly observed value with citable, re-executable evidence.
 *
 * Evidence is required rather than optional, and unreproducible evidence downgrades the
 * result to `INFERENCE`. A `FACT` with no evidence is an `INFERENCE` that has not admitted
 * it, and a `FACT` whose locator cannot be re-executed is the same claim wearing a better
 * hat. Only an observation with a replayable locator is a `FACT`
 * ([CAPABILITY_MODEL.md](../../docs/CAPABILITY_MODEL.md) section 5).
 */
export function fact(
  input: AssertionInput & { readonly evidence: readonly Evidence[] },
): Assertion {
  const freshness = freshnessOf(input.observedAt, input.freshnessClass, input.windows, input.now);
  if (input.evidence.length === 0 || input.evidence.every((e) => !e.reproducible)) {
    return {
      value: input.value,
      confidence: 'INFERENCE',
      derived_from: input.evidence.length === 0
        ? ['no-citable-artifact']
        : input.evidence.map((e) => e.id),
      reasoning: input.evidence.length === 0
        ? 'observed with no citable artifact, so it is stated as the inference it is rather '
          + 'than as a fact that has not admitted it'
        : 'the observation cannot be re-executed, which caps the assertion it supports at '
          + 'INFERENCE',
      evidence: input.evidence,
      observed_at: input.observedAt,
      probe: input.probe,
      freshness,
    };
  }
  return {
    value: input.value,
    confidence: 'FACT',
    evidence: input.evidence,
    observed_at: input.observedAt,
    probe: input.probe,
    freshness,
  };
}

/**
 * A value reasoned from facts. It must name the facts it derives from and say why in one
 * sentence, because an inference that cannot name its inputs is a guess with better manners.
 *
 * Structural derivations live here: an edge established by reading code is an `INFERENCE`,
 * and only tracing a real record through a runtime upgrades it.
 */
export function inference(
  input: AssertionInput & {
    readonly derivedFrom: readonly string[];
    readonly reasoning: string;
    readonly evidence?: readonly Evidence[];
  },
): Assertion {
  return {
    value: input.value,
    confidence: 'INFERENCE',
    derived_from: input.derivedFrom.length > 0 ? input.derivedFrom : ['no-cited-input'],
    reasoning: input.reasoning,
    evidence: input.evidence ?? [],
    observed_at: input.observedAt,
    probe: input.probe,
    freshness: freshnessOf(input.observedAt, input.freshnessClass, input.windows, input.now),
  };
}

export interface UnknownInput {
  readonly probe: string;
  readonly observedAt: string;
  readonly reason: AbsenceReason;
  /** What would resolve it. An unknown without this is decorative. */
  readonly recoverableBy: string;
  /** What was tried. This is what separates "we could not look" from "we never looked". */
  readonly attempted: string;
}

/**
 * Not determined, with the reason drawn from the one absence vocabulary.
 *
 * Freshness is `UNKNOWN` and not `CURRENT`: a value that was never established has no
 * observation whose age could be current, and marking it fresh would let a predicate decide
 * on it without a re-probe.
 */
export function unknown(input: UnknownInput): Assertion {
  return {
    value: null,
    confidence: 'UNKNOWN',
    reason: input.reason,
    recoverable_by: input.recoverableBy,
    attempted: input.attempted,
    observed_at: input.observedAt,
    probe: input.probe,
    freshness: 'UNKNOWN',
  };
}

export function isUnknown(assertion: Assertion): boolean {
  return assertion.confidence === 'UNKNOWN';
}

/** Evidence carried inline by an assertion. Ids in the list are references, not evidence. */
export function inlineEvidence(assertion: Assertion): readonly Evidence[] {
  const refs = 'evidence' in assertion ? (assertion.evidence ?? []) : [];
  return refs.filter((ref): ref is Evidence => typeof ref !== 'string');
}

/** One allowed promotion, so the kernel has something to record as an event. */
export interface Promotion {
  readonly subject: string;
  readonly from: ConfidenceClass;
  readonly to: ConfidenceClass;
  readonly evidence: readonly string[];
  readonly at: string;
  readonly reason: string;
}

export interface PromotionOutcome {
  readonly assertion: Assertion;
  readonly promotion: Promotion | null;
  /** Set when a promotion was attempted and refused, so a refusal is visible rather than silent. */
  readonly refused: string | null;
}

const RANK: Readonly<Record<ConfidenceClass, number>> = { UNKNOWN: 0, INFERENCE: 1, FACT: 2 };

/**
 * Merges a re-observation over an existing assertion under rule 2.
 *
 * A strengthening of confidence is allowed only when the new assertion brings evidence the
 * old one did not have. Where it does not, the previous assertion stands and the refusal is
 * reported — an `UNKNOWN` that becomes a `FACT` because a probe ran again and shrugged is
 * exactly the silent promotion the rule forbids.
 */
export function promote(
  subject: string,
  previous: Assertion | undefined,
  next: Assertion,
): PromotionOutcome {
  if (previous === undefined) return { assertion: next, promotion: null, refused: null };

  const before = previous.confidence;
  const after = next.confidence;
  if (RANK[after] <= RANK[before]) return { assertion: next, promotion: null, refused: null };

  const newEvidence = inlineEvidence(next);
  const oldIds = new Set(inlineEvidence(previous).map((e) => e.id));
  const added = newEvidence.filter((e) => !oldIds.has(e.id));
  if (added.length === 0) {
    return {
      assertion: previous,
      promotion: null,
      refused: `${subject} would have gone from ${before} to ${after} with no evidence the `
        + 'previous assertion did not already have. Promotion requires new evidence, so the '
        + 'previous assertion stands',
    };
  }

  return {
    assertion: next,
    promotion: {
      subject,
      from: before,
      to: after,
      evidence: added.map((e) => e.id),
      at: next.observed_at,
      reason: `re-observed with ${added.length} piece(s) of evidence the previous assertion lacked`,
    },
    refused: null,
  };
}
