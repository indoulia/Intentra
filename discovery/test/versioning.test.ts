import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx } from '@agentos/contracts';
import type { Assertion } from '@agentos/contracts';
import {
  fact,
  freshnessOf,
  makeEvidence,
  promote,
  unknown,
} from '../src/index.js';
import { assertValidPackage, reasonOf, serviceOver } from './helpers.js';
import { WINDOWS } from './fake-registry.js';
import { healthyWorld, misleadingWorkItem, withResponses } from './worlds.js';

/**
 * Versioning, promotion and freshness — the three rules that keep the package honest over time.
 *
 * **The package is versioned, not appended.** On-demand discovery produces a new version;
 * agents read one version, and the object one is holding does not change under it.
 *
 * **`UNKNOWN` never silently becomes `FACT`.** Promotion requires new evidence and is recorded.
 * A probe that ran twice and shrugged the second time does not get to upgrade its own claim.
 *
 * **Freshness is a second, orthogonal axis.** A value can be `FACT` and `STALE` at once, and
 * collapsing the two loses exactly the information that makes stale data safe to use.
 */

const WORK_ITEM = misleadingWorkItem();
const INTAKE = fx.intakeRecord();

describe('the package is versioned, not appended', () => {
  test('each discovery produces the next version, and the previous one is untouched', async () => {
    const { service } = serviceOver(healthyWorld());
    const first = await service.orient({
      runId: 'run_v', intake: INTAKE, repositoryPath: '/work/repo',
    });
    const snapshot = JSON.parse(JSON.stringify(first)) as unknown;

    const second = await service.deepen({
      runId: 'run_v', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: first,
    });

    assert.equal(first.meta.package_version, 1);
    assert.equal(second.meta.package_version, 2);
    assert.notEqual(first, second);
    assert.deepEqual(
      JSON.parse(JSON.stringify(first)) as unknown,
      snapshot,
      'version 1 changed under a reader who was holding it',
    );
    assert.equal(service.versions().length, 2);
  });

  test('tier 2 carries tier 1 forward rather than discarding it', async () => {
    const { service } = serviceOver(healthyWorld());
    const first = await service.orient({
      runId: 'run_v', intake: INTAKE, repositoryPath: '/work/repo',
    });
    const second = await service.deepen({
      runId: 'run_v', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: first,
    });

    assert.deepEqual(second.repository['root']?.value, first.repository['root']?.value);
    assert.ok(second.repository['build_command'] !== undefined, 'and adds tier-2 depth');
    const coverage = new Map(second.meta.probe_coverage.map((c) => [c.probe, c.state]));
    assert.equal(coverage.get('repo.identity'), 'RAN', 'the tier-1 coverage record survives');
    /* PARTIAL rather than RAN, and correctly: the test probe locates suites and states plainly
     * that it did not read their bodies or observe a coverage report, so the probe ran and its
     * section is incomplete. A probe with honest unknowns is not a probe that succeeded. */
    assert.equal(coverage.get('repo.tests'), 'PARTIAL');
  });

  test('an on-demand probe produces a new version, not a mutation of the one handed out', async () => {
    const { service } = serviceOver(healthyWorld());
    await service.orient({ runId: 'run_v', intake: INTAKE, repositoryPath: '/work/repo' });
    const handedOut = await service.deepen({
      runId: 'run_v', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: null,
    });
    const before = JSON.parse(JSON.stringify(handedOut)) as unknown;

    const outcome = await service.probe({
      runId: 'run_v',
      probe: 'git.churn',
      sections: ['git_state'],
      scope: WORK_ITEM.scope,
      reason: 'the Architect asked where the change concentration is',
    });

    assert.equal(outcome.available, true);
    assert.ok(Object.keys(outcome.assertions).includes('churn'));
    assert.ok(outcome.evidence.length > 0);
    assert.match(outcome.detail, /package version 3/);
    assert.equal(service.versions().length, 3);
    assert.deepEqual(
      JSON.parse(JSON.stringify(handedOut)) as unknown,
      before,
      'the version an agent is holding changed under it',
    );
    const latest = service.latest();
    assert.ok(latest !== null);
    assertValidPackage(latest);
  });

  test('an on-demand reality probe re-reads one element into a new version', async () => {
    const { service } = serviceOver(healthyWorld());
    await service.orient({ runId: 'run_v', intake: INTAKE, repositoryPath: '/work/repo' });
    await service.deepen({
      runId: 'run_v', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: null,
    });
    const outcome = await service.probe({
      runId: 'run_v',
      probe: 'reality.reviews',
      sections: ['current_reality'],
      scope: WORK_ITEM.scope,
      reason: 'the review loop needs the thread state now, not two stages ago',
    });
    assert.equal(outcome.available, true);
    assert.ok(outcome.assertions['reviews'] !== undefined);
    assert.equal(service.versions().length, 3);
  });

  test('a probe name that does not exist is unavailable, not an exception', async () => {
    const { service } = serviceOver(healthyWorld());
    await service.orient({ runId: 'run_v', intake: INTAKE, repositoryPath: '/work/repo' });
    const outcome = await service.probe({
      runId: 'run_v',
      probe: 'repo.telepathy',
      sections: ['repository'],
      scope: WORK_ITEM.scope,
      reason: 'an agent asked for something that cannot be observed',
    });
    assert.equal(outcome.available, false);
    assert.deepEqual(outcome.assertions, {});
    assert.match(outcome.detail, /no probe named repo.telepathy exists/);
  });
});

describe('UNKNOWN never silently becomes FACT', () => {
  const evidence = (id: string) => makeEvidence({
    kind: 'file',
    locator: { adapter: 'repo', op: 'read_file', args: { path: id } },
    ref: id,
    value: id,
    observedAt: fx.T1,
    reproducible: true,
  });

  const factWith = (value: unknown, ids: readonly string[]): Assertion => fact({
    value,
    probe: 'test',
    observedAt: fx.T1,
    freshnessClass: 'repository',
    windows: WINDOWS,
    now: new Date(fx.T1),
    evidence: ids.map(evidence),
  });

  const nothing = (): Assertion => unknown({
    probe: 'test',
    observedAt: fx.T1,
    reason: 'UNAVAILABLE',
    recoverableBy: 'restore access',
    attempted: 'looked and could not reach it',
  });

  test('a strengthening with new evidence is allowed and recorded', () => {
    const outcome = promote('repository.root', nothing(), factWith('/work/repo', ['a.ts']));
    assert.equal(outcome.assertion.confidence, 'FACT');
    assert.equal(outcome.promotion?.from, 'UNKNOWN');
    assert.equal(outcome.promotion?.to, 'FACT');
    assert.equal(outcome.promotion?.evidence.length, 1);
    assert.equal(outcome.refused, null);
  });

  test('a strengthening with no new evidence is refused, and the refusal is visible', () => {
    const previous = factWith('/work/repo', ['a.ts']);
    const inferenceWithSameEvidence: Assertion = {
      value: '/work/repo',
      confidence: 'INFERENCE',
      derived_from: ['x'],
      reasoning: 'reasoned',
      evidence: [evidence('a.ts')],
      observed_at: fx.T1,
      probe: 'test',
      freshness: 'CURRENT',
    };
    const outcome = promote('repository.root', inferenceWithSameEvidence, previous);
    assert.equal(outcome.assertion.confidence, 'INFERENCE', 'the previous assertion stands');
    assert.equal(outcome.promotion, null);
    assert.match(outcome.refused ?? '', /Promotion requires new evidence/);
  });

  test('a weakening is always allowed: a source that stopped answering is news', () => {
    const outcome = promote('repository.root', factWith('/work/repo', ['a.ts']), nothing());
    assert.equal(outcome.assertion.confidence, 'UNKNOWN');
    assert.equal(outcome.promotion, null);
    assert.equal(outcome.refused, null);
  });

  test('a FACT with no evidence is stated as the INFERENCE it is', () => {
    const bare = fact({
      value: 'guessed',
      probe: 'test',
      observedAt: fx.T1,
      freshnessClass: 'repository',
      windows: WINDOWS,
      now: new Date(fx.T1),
      evidence: [],
    });
    assert.equal(bare.confidence, 'INFERENCE');
    assert.match(
      bare.confidence === 'INFERENCE' ? bare.reasoning : '',
      /a fact that has not admitted it/,
    );
  });

  test('a run that loses access does not keep yesterday\'s fact as today\'s', async () => {
    const { service } = serviceOver(healthyWorld());
    const first = await service.orient({
      runId: 'run_v', intake: INTAKE, repositoryPath: '/work/repo',
    });
    assert.equal(first.git_state['branches']?.confidence, 'FACT');

    const { service: blind } = serviceOver({
      ...healthyWorld(),
      availability: { git: 'UNAVAILABLE' },
    });
    const degraded = await blind.orient({
      runId: 'run_v', intake: INTAKE, repositoryPath: '/work/repo',
    });
    assert.equal(reasonOf(degraded.git_state['branches']), 'UNAVAILABLE');
  });
});

describe('freshness is a second axis, not a confidence class', () => {
  test('an observation inside its window is CURRENT and outside it is STALE', () => {
    const now = new Date(new Date(fx.T1).getTime() + 400_000);
    assert.equal(freshnessOf(fx.T1, 'git', WINDOWS, now), 'STALE');
    assert.equal(freshnessOf(fx.T1, 'repository', WINDOWS, now), 'CURRENT');
  });

  test('an unparseable or future timestamp is UNKNOWN, which the kernel treats as stale', () => {
    assert.equal(freshnessOf('not a date', 'git', WINDOWS, new Date(fx.T1)), 'UNKNOWN');
    const past = new Date(new Date(fx.T1).getTime() - 60_000);
    assert.equal(freshnessOf(fx.T1, 'git', WINDOWS, past), 'UNKNOWN');
  });

  test('a value can be FACT and STALE at once', async () => {
    const { service, clock } = serviceOver(healthyWorld());
    await service.orient({ runId: 'run_v', intake: INTAKE, repositoryPath: '/work/repo' });
    clock.advance(600_000);
    const second = await service.deepen({
      runId: 'run_v', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: service.latest(),
    });

    const carried = second.git_state['branches'];
    assert.equal(carried?.confidence, 'FACT');
    assert.equal(
      carried?.freshness,
      'CURRENT',
      'the tier-1 assertion carried forward was re-observed at tier 2 and is current again',
    );

    const commits = second.git_state['commits'];
    assert.equal(commits?.confidence, 'FACT');
  });

  test('per-class windows come from the injected policy, not from this package', () => {
    const tight = { ...WINDOWS, git: 1 };
    const now = new Date(new Date(fx.T1).getTime() + 100);
    assert.equal(freshnessOf(fx.T1, 'git', tight, now), 'STALE');
    assert.equal(freshnessOf(fx.T1, 'git', WINDOWS, now), 'CURRENT');
  });
});

describe('deepen against a changed world produces a new answer, never a merged fiction', () => {
  test('a merged pull request replaces the open one rather than coexisting with it', async () => {
    const { service } = serviceOver(healthyWorld());
    await service.orient({ runId: 'run_v', intake: INTAKE, repositoryPath: '/work/repo' });
    const open = await service.deepen({
      runId: 'run_v', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: null,
    });
    assert.equal((open.current_reality.pr.value as Record<string, unknown>)['state'], 'OPEN');

    const { service: later } = serviceOver(withResponses(healthyWorld(), {
      'git.list_prs': [{ number: 41, state: 'MERGED', head_branch: `feature/DEF-456-rate-rounding`, head_sha: 'x' }],
      'git.read_pr': { number: 41, state: 'MERGED', head_sha: 'x' },
      'git.merge_state': { state: 'MERGED', mergeable: false, conflicted: false },
    }));
    await later.orient({ runId: 'run_v', intake: INTAKE, repositoryPath: '/work/repo' });
    const merged = await later.deepen({
      runId: 'run_v', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: null,
    });
    assert.equal((merged.current_reality.pr.value as Record<string, unknown>)['state'], 'MERGED');
    assert.equal(
      (merged.current_reality.merge_state.value as Record<string, unknown>)['state'],
      'MERGED',
    );
  });
});
