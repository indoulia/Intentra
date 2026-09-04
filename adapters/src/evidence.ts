import { sha256 } from '@agentos/contracts';
import type { EvidenceKind, EvidencePolicy, EvidencePredicate } from '@agentos/contracts';

/**
 * The per-kind comparators, as `policies/data/evidence.json` declares them.
 *
 * Comparison is mechanical. The adapter does not judge whether two observations "mean the
 * same thing" — that needs a model, and the layer the whole system's trust rests on has to be
 * checkable without one. Four families, and the fourth is the honest one:
 *
 * - **`normalized_exact_match`** — `file`, `git`, `command`, `query`, `http`. Whitespace and
 *   ordering normalization only. Nothing that could make two different files compare equal.
 * - **`predicate_reevaluation`** — `log`, `metric`. The kernel re-evaluates the predicate the
 *   observation satisfied rather than comparing a volatile raw value, because a log line that
 *   has since rotated would otherwise mismatch for a reason that is not a defect.
 * - **`identifier_plus_content_hash`** — `ticket`, `document`. A changed hash is a mismatch
 *   and the version difference is recorded.
 * - **`not_kernel_verifiable`** — `screenshot`. Pixels are not comparable mechanically. The
 *   content cannot be checked; the *provenance* can, from the call log, and saying so is
 *   better than a comparison that would always pass.
 *
 * A kind with no comparator in policy is `INDETERMINATE`, which callers treat as a failure to
 * verify rather than as a pass. Unknown is unsafe here as everywhere.
 */

export type ComparatorName =
  | 'normalized_exact_match'
  | 'predicate_reevaluation'
  | 'identifier_plus_content_hash'
  | 'not_kernel_verifiable';

export type ComparisonVerdict =
  | 'MATCH'
  | 'MISMATCH'
  | 'NOT_KERNEL_VERIFIABLE'
  | 'INDETERMINATE';

export interface Comparison {
  readonly verdict: ComparisonVerdict;
  readonly comparator: ComparatorName | null;
  readonly detail: string;
}

/** Whitespace and line-ending normalization, plus line ordering. Nothing beyond that. */
export function normalizeObservation(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .sort()
    .join('\n');
}

export function contentHash(text: string): string {
  return sha256(normalizeObservation(text));
}

export function comparatorFor(
  policy: EvidencePolicy,
  kind: EvidenceKind,
): ComparatorName | null {
  const entry = policy.comparators.find((candidate) => candidate.kind === kind);
  return entry?.comparator ?? null;
}

export function requiresPredicate(policy: EvidencePolicy, kind: EvidenceKind): boolean {
  const entry = policy.comparators.find((candidate) => candidate.kind === kind);
  /* A kind policy says nothing about is treated as needing a predicate, which is the branch
   * that cannot pass without one. Unknown takes the safer side. */
  return entry?.requires_predicate ?? true;
}

/** Reads a dotted path out of a replayed value, for a predicate's `subject`. */
function extract(value: unknown, subject: string): unknown {
  if (value === null || typeof value !== 'object') return value;
  let node: unknown = value;
  for (const token of subject.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[token];
  }
  return node;
}

function numeric(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

/** Re-evaluates the predicate an observation satisfied, over a freshly observed value. */
export function evaluatePredicate(predicate: EvidencePredicate, value: unknown): boolean {
  const subject = extract(value, predicate.subject);
  const operand = predicate.operand;
  switch (predicate.operator) {
    case 'eq': return looseEqual(subject, operand);
    case 'ne': return !looseEqual(subject, operand);
    case 'lt': return numeric(subject) < numeric(operand);
    case 'lte': return numeric(subject) <= numeric(operand);
    case 'gt': return numeric(subject) > numeric(operand);
    case 'gte': return numeric(subject) >= numeric(operand);
    case 'contains': return String(subject).includes(String(operand));
    case 'not_contains': return !String(subject).includes(String(operand));
    case 'matches': {
      try {
        return new RegExp(String(operand)).test(String(subject));
      } catch {
        /* An unparseable pattern cannot establish that the predicate still holds. */
        return false;
      }
    }
    default:
      return false;
  }
}

export interface ComparisonInput {
  readonly kind: EvidenceKind;
  readonly policy: EvidencePolicy;
  /** What was recorded when the observation was made. */
  readonly recordedExcerpt: string;
  /** What re-executing the locator produced now. */
  readonly replayedExcerpt: string;
  readonly replayedValue: unknown;
  readonly predicate?: EvidencePredicate | undefined;
}

/**
 * Applies the comparator policy declares for this kind.
 *
 * Every branch that cannot establish a match returns something other than `MATCH`. There is
 * no branch that passes because it did not know how to check.
 */
export function compareObservations(input: ComparisonInput): Comparison {
  const comparator = comparatorFor(input.policy, input.kind);

  if (comparator === null) {
    return {
      verdict: 'INDETERMINATE',
      comparator: null,
      detail:
        `policies/evidence.json declares no comparator for kind ${input.kind}, so nothing `
        + 'here can establish whether the observation still holds',
    };
  }

  switch (comparator) {
    case 'not_kernel_verifiable':
      return {
        verdict: 'NOT_KERNEL_VERIFIABLE',
        comparator,
        detail:
          'pixels are not comparable mechanically. The content cannot be checked; the '
          + 'provenance can, by confirming from the call log that the adapter call which '
          + 'produced it happened, against that locator, at that time',
      };

    case 'predicate_reevaluation': {
      if (input.predicate === undefined) {
        return {
          verdict: 'INDETERMINATE',
          comparator,
          detail:
            `kind ${input.kind} is verified by re-evaluating the predicate the observation `
            + 'satisfied, and no predicate was carried. Comparing the raw value instead would '
            + 'report a mismatch every time the underlying stream moved',
        };
      }
      const held = evaluatePredicate(input.predicate, input.replayedValue);
      return {
        verdict: held ? 'MATCH' : 'MISMATCH',
        comparator,
        detail: `${input.predicate.subject} ${input.predicate.operator} `
          + `${JSON.stringify(input.predicate.operand)} re-evaluated to ${held}`,
      };
    }

    case 'identifier_plus_content_hash': {
      const before = contentHash(input.recordedExcerpt);
      const after = contentHash(input.replayedExcerpt);
      return {
        verdict: before === after ? 'MATCH' : 'MISMATCH',
        comparator,
        detail: before === after
          ? `content hash unchanged (${before.slice(0, 12)})`
          : `content hash changed from ${before.slice(0, 12)} to ${after.slice(0, 12)}; the `
            + 'version difference is what a mismatch here records',
      };
    }

    case 'normalized_exact_match': {
      const matched = normalizeObservation(input.recordedExcerpt)
        === normalizeObservation(input.replayedExcerpt);
      return {
        verdict: matched ? 'MATCH' : 'MISMATCH',
        comparator,
        detail: matched
          ? 'the re-executed observation is identical after whitespace and ordering '
            + 'normalization'
          : 'the re-executed observation differs by more than whitespace and ordering',
      };
    }

    default:
      return {
        verdict: 'INDETERMINATE',
        comparator: null,
        detail: `unrecognized comparator ${String(comparator)}; nothing was established`,
      };
  }
}
