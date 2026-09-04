import type { RankedCandidate } from '@agentos/contracts';

/**
 * The shared machinery of ranking.
 *
 * **The registries rank; the kernel selects.** That split is the reason this package exists
 * and the reason it is small: ranking is deterministic, testable and model-free, so it can be
 * data-driven scoring here instead of branches in the kernel. What comes out is an *ordered
 * candidate list with scores and reasons* — never a choice, never a filter that quietly
 * removes something. A candidate that cannot be used still appears, carrying
 * `excluded_because`, because a list that omits what it rejected is a list nobody can audit.
 *
 * Two properties every ranking here holds:
 *
 * - **Total order.** Ties break on the identifier, so two runs over the same input produce
 *   the same list in the same order. A ranking that depended on enumeration order would make
 *   a recorded selection unreproducible.
 * - **Reasons, always.** `reasons` is non-empty by contract, and it is non-empty here because
 *   a score with no explanation is a number someone will eventually tune by feel.
 */

export interface Scored {
  readonly id: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly excludedBecause: string | null;
}

/**
 * Orders scored entries and projects them into the contract shape.
 *
 * Excluded candidates sort after every usable one, whatever they scored: their score
 * describes how well they would have fitted, not whether they may be used, and letting a
 * high-scoring excluded candidate head the list would put the thing the kernel must not pick
 * where the thing it should pick belongs.
 */
export function order(scored: readonly Scored[]): readonly RankedCandidate[] {
  return [...scored]
    .sort((a, b) => {
      const aExcluded = a.excludedBecause === null ? 0 : 1;
      const bExcluded = b.excludedBecause === null ? 0 : 1;
      if (aExcluded !== bExcluded) return aExcluded - bExcluded;
      if (a.score !== b.score) return b.score - a.score;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((entry) => ({
      id: entry.id,
      score: round(entry.score),
      reasons: entry.reasons.length > 0
        ? [...entry.reasons]
        : ['no distinguishing property was observed, so this candidate scored the floor'],
      excluded_because: entry.excludedBecause,
    }));
}

/** Scores are compared and recorded, so they are rounded to something a human can read. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** How much of `wanted` the candidate covers, in [0, 1]. An empty want is fully covered. */
export function coverage(
  wanted: readonly string[],
  offered: readonly string[],
): number {
  if (wanted.length === 0) return 1;
  const have = new Set(offered);
  const met = wanted.filter((entry) => have.has(entry)).length;
  return met / wanted.length;
}
