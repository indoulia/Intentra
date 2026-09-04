import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validators } from '@agentos/contracts';
import type { AdapterAvailability, RankedCandidate, SkillEntry } from '@agentos/contracts';
import { EnumeratedRegistries, coverage, rankSkills, type SkillRequest } from '../src/index.js';

/**
 * Skill ranking.
 *
 * The registries rank; the kernel selects. So every test here is about the *list*: what is on
 * it, in what order, and — for anything the kernel must not pick — whether the list says so
 * out loud instead of quietly dropping it.
 *
 * Two rules carry most of the weight. A skill that can spawn an agent is never selectable,
 * and a skill whose spawning behaviour could not be determined counts as spawning. An
 * unreachable connector is recorded `UNAVAILABLE` and never omitted, because "this host has
 * no access" and "it is configured and would not connect" lead to different decisions.
 */

const AT = '2026-09-04T10:00:00.000Z';

function availability(
  state: AdapterAvailability['state'] = 'AVAILABLE',
  detail = 'enumerated',
): AdapterAvailability {
  return { adapter: 'host', state, detail, checked_at: AT };
}

function skill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    id: 'skill.generic',
    source: 'global',
    description: 'a general tool',
    declared_inputs: [],
    declared_outputs: [],
    availability: availability(),
    mutating: false,
    spawns_agents: false,
    spawns_agents_determined: true,
    external_destination: false,
    reversal: null,
    domains: ['repository_analysis', 'git', 'database', 'api', 'ui', 'testing'],
    operations: ['read', 'analyse'],
    targets: ['filesystem', 'vcs'],
    observed_success_rate: null,
    cost_hint: 'medium',
    ...overrides,
  };
}

const READ_TASK: SkillRequest = {
  domains: ['repository_analysis'],
  operations: ['read'],
  targets: ['filesystem'],
  stageMutating: false,
};

function idsOf(candidates: readonly RankedCandidate[]): readonly string[] {
  return candidates.map((candidate) => candidate.id);
}

function find(candidates: readonly RankedCandidate[], id: string): RankedCandidate {
  const found = candidates.find((candidate) => candidate.id === id);
  assert.ok(found !== undefined, `${id} should appear in the candidate list`);
  return found;
}

describe('the shape of a candidate list', () => {
  test('every candidate carries the fields the RankedCandidate contract requires', () => {
    /*
     * `contracts` exposes no standalone `rankedCandidate` validator — the shape is a `$defs`
     * entry with no wrapper — so the required fields are asserted directly rather than by
     * inventing one here. Reported as a gap rather than papered over.
     */
    const ranked = rankSkills([skill(), skill({ id: 'other', spawns_agents: true })], READ_TASK);
    for (const candidate of ranked) {
      assert.equal(typeof candidate.id, 'string');
      assert.equal(typeof candidate.score, 'number');
      assert.ok(
        candidate.reasons.length >= 1,
        'reasons is minItems 1 in the schema, and a score with no explanation is a number '
        + 'someone will eventually tune by feel',
      );
      assert.ok(candidate.excluded_because === null || typeof candidate.excluded_because === 'string');
    }
  });

  test('nothing is dropped: every enumerated skill appears exactly once', () => {
    const entries = [
      skill({ id: 'a' }),
      skill({ id: 'b', spawns_agents: true }),
      skill({ id: 'c', availability: availability('UNAVAILABLE', 'server refused') }),
      skill({ id: 'd', mutating: true }),
    ];
    const ranked = rankSkills(entries, READ_TASK);
    assert.deepEqual([...idsOf(ranked)].sort(), ['a', 'b', 'c', 'd']);
  });

  test('the order is total and reproducible', () => {
    const entries = [skill({ id: 'b' }), skill({ id: 'a' }), skill({ id: 'c' })];
    const first = idsOf(rankSkills(entries, READ_TASK));
    const second = idsOf(rankSkills([...entries].reverse(), READ_TASK));
    assert.deepEqual(
      first, second,
      'a ranking that depended on enumeration order would make a recorded selection '
      + 'unreproducible',
    );
  });
});

describe('spawns_agents is a hard exclusion', () => {
  test('a skill that declares it can spawn is excluded and says why', () => {
    const ranked = rankSkills([skill({ id: 'spawner', spawns_agents: true })], READ_TASK);
    const candidate = find(ranked, 'spawner');
    assert.match(candidate.excluded_because ?? '', /no agent may invoke another agent/);
  });

  test('undetermined spawning behaviour counts as spawning', () => {
    const ranked = rankSkills(
      [skill({ id: 'unknown-spawner', spawns_agents: false, spawns_agents_determined: false })],
      READ_TASK,
    );
    const candidate = find(ranked, 'unknown-spawner');
    assert.match(
      candidate.excluded_because ?? '', /could not be determined/,
      'uncertainty takes the safer branch, and on some substrates a subagent tool is the '
      + 'default way to work',
    );
  });

  test('an excluded candidate never heads the list, however well it scored', () => {
    const ranked = rankSkills([
      skill({
        id: 'perfect-but-spawns',
        spawns_agents: true,
        domains: ['repository_analysis'],
        operations: ['read'],
        targets: ['filesystem'],
        cost_hint: 'low',
        observed_success_rate: 1,
      }),
      skill({ id: 'ordinary' }),
    ], READ_TASK);
    assert.equal(idsOf(ranked)[0], 'ordinary');
    assert.equal(ranked[ranked.length - 1]?.id, 'perfect-but-spawns');
  });
});

describe('the other exclusions', () => {
  test('a mutating skill is excluded from a read-only task', () => {
    const ranked = rankSkills([skill({ id: 'writer', mutating: true })], READ_TASK);
    assert.match(
      find(ranked, 'writer').excluded_because ?? '',
      /it mutates and this task does not/,
    );
  });

  test('the same skill is admissible for a mutating stage', () => {
    const ranked = rankSkills(
      [skill({ id: 'writer', mutating: true, operations: ['read', 'mutate'] })],
      { ...READ_TASK, stageMutating: true },
    );
    assert.equal(find(ranked, 'writer').excluded_because, null);
  });

  test('an unreachable connector is recorded, not omitted', () => {
    const ranked = rankSkills(
      [skill({ id: 'tracker', availability: availability('UNAVAILABLE', 'server refused') })],
      READ_TASK,
    );
    const candidate = find(ranked, 'tracker');
    assert.match(candidate.excluded_because ?? '', /UNAVAILABLE: server refused/);
    assert.match(
      candidate.excluded_because ?? '', /lead to different decisions/,
      'the reason has to distinguish an unreachable connector from an absent one',
    );
  });

  test('a not-configured connector reads differently from an unreachable one', () => {
    const ranked = rankSkills([
      skill({ id: 'absent', availability: availability('NOT_CONFIGURED', 'no credentials') }),
      skill({ id: 'broken', availability: availability('UNAVAILABLE', 'server refused') }),
    ], READ_TASK);
    assert.notEqual(
      find(ranked, 'absent').excluded_because,
      find(ranked, 'broken').excluded_because,
    );
  });

  test('a skill that performs none of the required operations is excluded', () => {
    const ranked = rankSkills(
      [skill({ id: 'wrong-job', operations: ['generate'] })],
      READ_TASK,
    );
    assert.match(find(ranked, 'wrong-job').excluded_because ?? '', /none of the required operations/);
  });

  test('a skill that acts on none of the required targets is excluded', () => {
    const ranked = rankSkills(
      [skill({ id: 'wrong-target', targets: ['network'] })],
      READ_TASK,
    );
    assert.match(find(ranked, 'wrong-target').excluded_because ?? '', /none of the required targets/);
  });
});

describe('the five ranking criteria, in the order the document states them', () => {
  test('capability match outranks everything below it', () => {
    const ranked = rankSkills([
      skill({
        id: 'fits',
        domains: ['repository_analysis'],
        operations: ['read'],
        targets: ['filesystem'],
        cost_hint: 'high',
        observed_success_rate: 0,
      }),
      skill({
        id: 'cheap-but-wrong-domain',
        domains: ['ui'],
        operations: ['read'],
        targets: ['filesystem'],
        cost_hint: 'low',
        observed_success_rate: 1,
      }),
    ], READ_TASK);
    assert.equal(idsOf(ranked)[0], 'fits');
  });

  test('a purpose-built skill beats a general tool at equal capability', () => {
    const ranked = rankSkills([
      skill({
        id: 'purpose-built',
        domains: ['repository_analysis'],
        operations: ['read'],
        targets: ['filesystem'],
      }),
      skill({ id: 'swiss-army' }),
    ], READ_TASK);
    assert.equal(
      idsOf(ranked)[0], 'purpose-built',
      'a tool that claims every domain claims none of them in particular',
    );
  });

  test('a repository-provided skill outranks an equivalent global one', () => {
    const ranked = rankSkills([
      skill({ id: 'global-one', source: 'global', domains: ['repository_analysis'], operations: ['read'], targets: ['filesystem'] }),
      skill({ id: 'repo-one', source: 'repository', domains: ['repository_analysis'], operations: ['read'], targets: ['filesystem'] }),
    ], READ_TASK);
    assert.equal(idsOf(ranked)[0], 'repo-one');
  });

  test('cheaper wins at equal capability and specificity', () => {
    const base = { domains: ['repository_analysis'], operations: ['read'], targets: ['filesystem'] } as const;
    const ranked = rankSkills([
      skill({ id: 'expensive', ...base, cost_hint: 'high' }),
      skill({ id: 'cheap', ...base, cost_hint: 'low' }),
    ], READ_TASK);
    assert.equal(idsOf(ranked)[0], 'cheap');
  });

  test('unknown cost scores as the expensive case, not the cheap one', () => {
    const base = { domains: ['repository_analysis'], operations: ['read'], targets: ['filesystem'] } as const;
    const ranked = rankSkills([
      skill({ id: 'unknown-cost', ...base, cost_hint: 'unknown' }),
      skill({ id: 'medium-cost', ...base, cost_hint: 'medium' }),
    ], READ_TASK);
    assert.equal(
      idsOf(ranked)[0], 'medium-cost',
      'selection degrades sensibly rather than assuming the best case',
    );
  });

  test('a better observed success rate wins at equal cost', () => {
    const base = {
      domains: ['repository_analysis'], operations: ['read'], targets: ['filesystem'],
      cost_hint: 'low',
    } as const;
    const ranked = rankSkills([
      skill({ id: 'flaky', ...base, observed_success_rate: 0.2 }),
      skill({ id: 'reliable', ...base, observed_success_rate: 0.95 }),
    ], READ_TASK);
    assert.equal(idsOf(ranked)[0], 'reliable');
  });

  test('a read-only option outranks a mutating one for a mutating task', () => {
    const base = {
      domains: ['repository_analysis'], operations: ['read'], targets: ['filesystem'],
      cost_hint: 'low',
    } as const;
    const ranked = rankSkills([
      skill({ id: 'writer', ...base, mutating: true }),
      skill({ id: 'reader', ...base, mutating: false }),
    ], { ...READ_TASK, stageMutating: true });
    assert.equal(
      idsOf(ranked)[0], 'reader',
      'least privilege, least mutation: a read-only option always outranks a mutating one',
    );
  });
});

describe("the proposing agent's preference", () => {
  test('reorders among things that fit', () => {
    const base = { domains: ['repository_analysis'], operations: ['read'], targets: ['filesystem'] } as const;
    const ranked = rankSkills([
      skill({ id: 'first-by-score', ...base, cost_hint: 'low' }),
      skill({ id: 'preferred', ...base, cost_hint: 'medium' }),
    ], { ...READ_TASK, preferred: ['preferred'] });
    assert.equal(idsOf(ranked)[0], 'preferred');
    assert.match(find(ranked, 'preferred').reasons.join(' '), /reorders and does not admit/);
  });

  test('never promotes something that is excluded', () => {
    const ranked = rankSkills([
      skill({ id: 'preferred-spawner', spawns_agents: true }),
      skill({ id: 'plain' }),
    ], { ...READ_TASK, preferred: ['preferred-spawner'] });
    assert.equal(
      idsOf(ranked)[0], 'plain',
      'a preference is an input to ranking, not a bypass of it',
    );
  });
});

describe('the registries port', () => {
  test('enumerated entries are returned unfiltered, unreachable ones included', async () => {
    const registries = new EnumeratedRegistries(
      [
        skill({ id: 'ok' }),
        skill({ id: 'unreachable', availability: availability('UNAVAILABLE', 'refused') }),
      ],
      [],
      AT,
    );
    const entries = await registries.skills();
    assert.deepEqual(entries.map((entry) => entry.id).sort(), ['ok', 'unreachable']);
    validators.skillRegistry.parse(registries.skillRegistry(), 'the skill registry');
  });

  test('ranking through the port is the same ranking', () => {
    const entries = [skill({ id: 'a' }), skill({ id: 'b', spawns_agents: true })];
    const registries = new EnumeratedRegistries(entries, [], AT);
    assert.deepEqual(
      registries.rankSkills(READ_TASK),
      rankSkills(entries, READ_TASK),
    );
  });
});

describe('coverage, the primitive the capability match is built from', () => {
  test('an empty want is fully covered', () => {
    assert.equal(coverage([], ['anything']), 1);
  });

  test('partial coverage is proportional', () => {
    assert.equal(coverage(['a', 'b'], ['a']), 0.5);
  });

  test('nothing offered covers nothing wanted', () => {
    assert.equal(coverage(['a'], []), 0);
  });
});
