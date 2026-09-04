import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validators } from '@agentos/contracts';
import type {
  AdapterAvailability,
  ModelEntry,
  ModelRequirement,
  RankedCandidate,
} from '@agentos/contracts';
import { EnumeratedRegistries, rankModels, shortfalls } from '../src/index.js';

/**
 * Model ranking.
 *
 * One rule: **the cheapest model that meets the requirements, then escalate on evidence.**
 * The registry's half is to put the cheapest adequate model first and to say, for every model
 * it did not, exactly which requirement it fell short of.
 *
 * The second half of the file is about `unknown`. Where a property is not knowable, selection
 * must degrade sensibly rather than assume the best case — an unknown reasoning depth does not
 * satisfy a deep-reasoning requirement, and an unknown precision class does not satisfy a
 * high-precision one. Assuming otherwise is proceeding on an inadequate model and reporting
 * the result as normal, which is the specific dishonesty the evidence model exists to prevent.
 */

const AT = '2026-09-04T10:00:00.000Z';

function availability(
  state: AdapterAvailability['state'] = 'AVAILABLE',
  detail = 'reachable',
): AdapterAvailability {
  return { adapter: 'host', state, detail, checked_at: AT };
}

function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: 'model.mid',
    availability: availability(),
    context_window: 200_000,
    reasoning: 'deep',
    coding: 'strong',
    vision: 'strong',
    tool_use: 'strong',
    usd_per_mtok_input: 3,
    usd_per_mtok_output: 15,
    latency_class: 'medium',
    precision_class: 'high',
    ...overrides,
  };
}

const MODEST: ModelRequirement = {
  context: 'medium',
  reasoning: 'mid',
  coding: false,
  vision: false,
  tool_use: 'basic',
  precision: 'standard',
};

const DEMANDING: ModelRequirement = {
  context: 'medium',
  reasoning: 'deep',
  coding: true,
  vision: false,
  tool_use: 'strong',
  precision: 'high',
};

function idsOf(candidates: readonly RankedCandidate[]): readonly string[] {
  return candidates.map((candidate) => candidate.id);
}

function find(candidates: readonly RankedCandidate[], id: string): RankedCandidate {
  const found = candidates.find((candidate) => candidate.id === id);
  assert.ok(found !== undefined, `${id} should appear in the candidate list`);
  return found;
}

describe('the cheapest adequate model comes first', () => {
  test('among models that all meet the requirement, price decides', () => {
    const ranked = rankModels([
      model({ id: 'pricey', usd_per_mtok_input: 15, usd_per_mtok_output: 75 }),
      model({ id: 'cheap', usd_per_mtok_input: 1, usd_per_mtok_output: 5 }),
    ], MODEST);
    assert.equal(idsOf(ranked)[0], 'cheap');
    assert.match(find(ranked, 'pricey').reasons.join(' '), /x the cheapest priced model/);
  });

  test('an inadequate model never outranks an adequate one, however cheap', () => {
    const ranked = rankModels([
      model({
        id: 'cheap-and-shallow',
        reasoning: 'shallow',
        usd_per_mtok_input: 0.1,
        usd_per_mtok_output: 0.4,
      }),
      model({ id: 'adequate', usd_per_mtok_input: 30, usd_per_mtok_output: 150 }),
    ], DEMANDING);
    assert.equal(idsOf(ranked)[0], 'adequate');
    assert.equal(find(ranked, 'cheap-and-shallow').excluded_because !== null, true);
  });

  test('a model with no published price ranks below every priced adequate one', () => {
    const ranked = rankModels([
      model({ id: 'unpriced', usd_per_mtok_input: null, usd_per_mtok_output: null }),
      model({ id: 'priced', usd_per_mtok_input: 50, usd_per_mtok_output: 200 }),
    ], MODEST);
    assert.equal(idsOf(ranked)[0], 'priced');
    assert.match(find(ranked, 'unpriced').reasons.join(' '), /price is unknown/);
  });

  test('the order is reproducible whatever order the host enumerated in', () => {
    const entries = [model({ id: 'b' }), model({ id: 'a' }), model({ id: 'c' })];
    assert.deepEqual(
      idsOf(rankModels(entries, MODEST)),
      idsOf(rankModels([...entries].reverse(), MODEST)),
    );
  });
});

describe('unknown never satisfies a requirement', () => {
  const cases: ReadonlyArray<readonly [string, Partial<ModelEntry>, ModelRequirement, RegExp]> = [
    ['unknown reasoning', { reasoning: 'unknown' }, DEMANDING, /reasoning is unknown/],
    ['unknown coding', { coding: 'unknown' }, DEMANDING, /coding is unknown/],
    ['unknown tool use', { tool_use: 'unknown' }, DEMANDING, /tool use is unknown/],
    [
      'unknown precision',
      { precision_class: 'unknown' },
      DEMANDING,
      /precision class is unknown/,
    ],
    [
      'unknown context window',
      { context_window: null },
      DEMANDING,
      /context window is unknown/,
    ],
  ];

  for (const [name, overrides, requirement, expected] of cases) {
    test(`${name} is a shortfall, not a benefit of the doubt`, () => {
      const entry = model({ id: 'hazy', ...overrides });
      const missing = shortfalls(entry, requirement);
      assert.equal(missing.length >= 1, true);
      assert.match(missing.join('; '), expected);

      const ranked = rankModels([entry], requirement);
      assert.equal(find(ranked, 'hazy').excluded_because !== null, true);
    });
  }

  test('unknown vision fails a vision requirement', () => {
    const entry = model({ id: 'blind', vision: 'unknown' });
    assert.match(
      shortfalls(entry, { ...DEMANDING, vision: true }).join('; '),
      /vision is unknown/,
    );
  });

  test('an unknown property that the requirement does not ask about is not a shortfall', () => {
    const entry = model({ id: 'partly-known', vision: 'unknown', coding: 'unknown' });
    assert.deepEqual(
      shortfalls(entry, MODEST), [],
      'degrading sensibly means refusing what was asked for and not refusing everything',
    );
  });
});

describe('availability is a shortfall like any other', () => {
  test('an unreachable model is excluded and stays on the list', () => {
    const ranked = rankModels([
      model({ id: 'down', availability: availability('UNAVAILABLE', 'the endpoint timed out') }),
      model({ id: 'up' }),
    ], MODEST);
    assert.deepEqual([...idsOf(ranked)].sort(), ['down', 'up']);
    assert.match(find(ranked, 'down').excluded_because ?? '', /UNAVAILABLE: the endpoint timed out/);
  });

  test('with nothing reachable, every candidate is excluded and the list still explains', () => {
    const ranked = rankModels([
      model({ id: 'a', availability: availability('UNAVAILABLE', 'no route') }),
      model({ id: 'b', availability: availability('NOT_CONFIGURED', 'no credentials') }),
    ], MODEST);
    assert.equal(ranked.every((candidate) => candidate.excluded_because !== null), true);
    assert.equal(
      ranked.every((candidate) => candidate.reasons.length >= 1), true,
      'no model available is an ordinary, expected condition; the kernel blocks and the list '
      + 'is what tells a human why',
    );
  });
});

describe('the context floor', () => {
  test('a context window below what the requirement needs is a shortfall', () => {
    const entry = model({ id: 'small', context_window: 8_000 });
    assert.match(shortfalls(entry, MODEST).join('; '), /context window is 8000/);
  });

  test('the floor is a ranking parameter the caller may set', () => {
    const entry = model({ id: 'small', context_window: 8_000 });
    const ranked = rankModels([entry], MODEST, {
      contextFloor: { small: 1_000, medium: 4_000, large: 16_000 },
    });
    assert.equal(
      find(ranked, 'small').excluded_because, null,
      'what counts as a large context is a property of the model market and moves, so it is '
      + 'a parameter rather than a constant compiled into the kernel',
    );
  });
});

describe('the registries port', () => {
  test('models are returned unfiltered and the registry is a contract value', async () => {
    const registries = new EnumeratedRegistries(
      [],
      [model({ id: 'a' }), model({ id: 'b', availability: availability('UNAVAILABLE', 'x') })],
      AT,
    );
    const entries = await registries.models();
    assert.equal(entries.length, 2);
    validators.modelRegistry.parse(registries.modelRegistry(), 'the model registry');
    for (const entry of entries) validators.modelEntry.parse(entry, entry.id);
  });

  test('ranking through the port is the same ranking', () => {
    const entries = [model({ id: 'a' }), model({ id: 'b', reasoning: 'shallow' })];
    const registries = new EnumeratedRegistries([], entries, AT);
    assert.deepEqual(registries.rankModels(DEMANDING), rankModels(entries, DEMANDING));
  });
});

describe('reasons are always present', () => {
  test('every candidate says whether it fits and what it costs', () => {
    const ranked = rankModels([model({ id: 'a' }), model({ id: 'b', reasoning: 'shallow' })], DEMANDING);
    for (const candidate of ranked) {
      assert.ok(candidate.reasons.length >= 2);
      assert.match(candidate.reasons.join(' '), /meets every declared requirement|falls short/);
      assert.match(candidate.reasons.join(' '), /latency class/);
    }
  });
});
