import type { ModelEntry, ModelRequirement, RankedCandidate } from '@agentos/contracts';
import { order, type Scored } from './ranking.js';

/**
 * Model ranking.
 *
 * One rule governs everything here: **choose the cheapest model that meets the requirements,
 * then escalate on evidence** — and the registry's half of that is to put the cheapest
 * adequate model first and to say, for every model it did not, exactly which requirement it
 * fell short of.
 *
 * The second rule is what makes the first honest. Where a property is not knowable it is
 * `unknown` or `null`, and **selection degrades sensibly rather than assuming the best
 * case**: an unknown reasoning depth does not satisfy a deep-reasoning requirement, an
 * unknown precision class does not satisfy a high-precision one, and an unknown context
 * window does not satisfy a large-context one. Assuming otherwise would be proceeding on an
 * inadequate model and reporting the result as normal, which is the specific dishonesty the
 * evidence model is built to prevent.
 *
 * The ranking never selects. It orders and explains; the kernel picks, applies policy, and
 * records the choice with its cost and outcome, which is how selection heuristics eventually
 * get replaced by measurements.
 */

export interface ModelRankingOptions {
  /**
   * The context window each declared size needs, in tokens.
   *
   * A ranking parameter rather than a kernel threshold: it lives here because the registry is
   * where model properties are compared, and it is overridable because what counts as a large
   * context is a property of the model market and moves.
   */
  readonly contextFloor?: {
    readonly small: number;
    readonly medium: number;
    readonly large: number;
  };
}

const DEFAULT_CONTEXT_FLOOR = { small: 32_000, medium: 128_000, large: 400_000 } as const;

const REASONING_RANK: Readonly<Record<ModelEntry['reasoning'], number>> = {
  shallow: 1, mid: 2, deep: 3, unknown: 0,
};
const CAPABILITY_RANK: Readonly<Record<ModelEntry['coding'], number>> = {
  none: 0, basic: 1, strong: 2, unknown: 0,
};
const REQUIRED_REASONING: Readonly<Record<ModelRequirement['reasoning'], number>> = {
  shallow: 1, mid: 2, deep: 3,
};
const REQUIRED_TOOL_USE: Readonly<Record<ModelRequirement['tool_use'], number>> = {
  none: 0, basic: 1, strong: 2,
};
const LATENCY_SCORE: Readonly<Record<ModelEntry['latency_class'], number>> = {
  fast: 1, medium: 0.6, slow: 0.2, unknown: 0.2,
};

const ADEQUACY_WEIGHT = 100;
const COST_WEIGHT = 30;
const LATENCY_WEIGHT = 5;
const HEADROOM_WEIGHT = 4;

/** Everything the requirement asks for that this model does not demonstrably provide. */
export function shortfalls(
  entry: ModelEntry,
  requirement: ModelRequirement,
  contextFloor: ModelRankingOptions['contextFloor'] = DEFAULT_CONTEXT_FLOOR,
): readonly string[] {
  const floor = contextFloor;
  const out: string[] = [];

  if (entry.availability.state !== 'AVAILABLE') {
    out.push(`availability is ${entry.availability.state}: ${entry.availability.detail}`);
  }
  if (REASONING_RANK[entry.reasoning] < REQUIRED_REASONING[requirement.reasoning]) {
    out.push(
      `reasoning is ${entry.reasoning} and ${requirement.reasoning} is required`
      + (entry.reasoning === 'unknown'
        ? '. An unknown capability never satisfies a requirement for one'
        : ''),
    );
  }
  if (requirement.coding && CAPABILITY_RANK[entry.coding] < 2) {
    out.push(`coding is ${entry.coding} and strong coding is required`);
  }
  if (requirement.vision && CAPABILITY_RANK[entry.vision] < 1) {
    out.push(`vision is ${entry.vision} and vision is required`);
  }
  if (CAPABILITY_RANK[entry.tool_use] < REQUIRED_TOOL_USE[requirement.tool_use]) {
    out.push(`tool use is ${entry.tool_use} and ${requirement.tool_use} is required`);
  }
  if (requirement.precision === 'high' && entry.precision_class !== 'high') {
    out.push(
      `precision class is ${entry.precision_class} and high precision is required. This is `
      + 'the dispatch class where a wrong answer is inherited by everything downstream',
    );
  }
  const needed = floor[requirement.context];
  if (entry.context_window === null) {
    out.push(
      `the context window is unknown and a ${requirement.context} context is required. `
      + 'Unknown is not assumed to be enough',
    );
  } else if (entry.context_window < needed) {
    out.push(
      `the context window is ${String(entry.context_window)} and a ${requirement.context} `
      + `context needs at least ${String(needed)}`,
    );
  }
  return out;
}

export function rankModels(
  entries: readonly ModelEntry[],
  requirement: ModelRequirement,
  options: ModelRankingOptions = {},
): readonly RankedCandidate[] {
  const floor = options.contextFloor ?? DEFAULT_CONTEXT_FLOOR;

  /* The cost scale is relative to the cheapest priced model on offer, so a fleet of
   * expensive models still ranks internally instead of collapsing to one score. */
  const priced = entries
    .map((entry) => totalPrice(entry))
    .filter((price): price is number => price !== null);
  const cheapest = priced.length > 0 ? Math.min(...priced) : null;

  const scored: Scored[] = entries.map((entry) => {
    const missing = shortfalls(entry, requirement, floor);
    const reasons: string[] = [];

    reasons.push(
      missing.length === 0
        ? 'meets every declared requirement'
        : `falls short: ${missing.join('; ')}`,
    );

    const price = totalPrice(entry);
    if (price === null) {
      reasons.push(
        'price is unknown, which ranks below every priced model rather than above them',
      );
    } else if (cheapest !== null && cheapest > 0) {
      reasons.push(`costs ${(price / cheapest).toFixed(2)}x the cheapest priced model on offer`);
    } else {
      reasons.push('no price to compare against');
    }

    reasons.push(`latency class ${entry.latency_class}`);

    /*
     * Cheapest first among the adequate. A model's cost score is the inverse of its price
     * relative to the cheapest, so the cheapest adequate model heads the list and a model
     * with no published price ranks last among the adequate rather than first.
     */
    const costScore = price === null || cheapest === null || cheapest <= 0
      ? 0
      : cheapest / Math.max(price, Number.EPSILON);

    /*
     * A little credit for headroom, so that among models of equal price the one with room to
     * spare wins. Deliberately small: escalation is evidence-based, not pre-emptive.
     */
    const headroom = entry.context_window === null
      ? 0
      : Math.min(1, entry.context_window / Math.max(1, floor[requirement.context]) / 4);

    const score = (missing.length === 0 ? ADEQUACY_WEIGHT : 0)
      + costScore * COST_WEIGHT
      + LATENCY_SCORE[entry.latency_class] * LATENCY_WEIGHT
      + headroom * HEADROOM_WEIGHT;

    return {
      id: entry.id,
      score,
      reasons,
      excludedBecause: missing.length === 0 ? null : missing.join('; '),
    };
  });

  return order(scored);
}

function totalPrice(entry: ModelEntry): number | null {
  if (entry.usd_per_mtok_input === null || entry.usd_per_mtok_output === null) return null;
  /*
   * Input and output weighted equally. A weighting derived from measured token ratios would
   * be better and is exactly the kind of thing the recorded selections are meant to produce;
   * inventing one now would be a threshold tuned by feel.
   */
  return entry.usd_per_mtok_input + entry.usd_per_mtok_output;
}
