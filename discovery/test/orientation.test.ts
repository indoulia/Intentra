import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx } from '@agentos/contracts';
import { REALITY_ELEMENTS } from '../src/index.js';
import { assertValidPackage, operationsCalled, reasonOf, serviceOver } from './helpers.js';
import { healthyWorld } from './worlds.js';

/**
 * Tier 1: orientation, and the boundary around it.
 *
 * "Enough to resolve the work item, and no more." The tests that matter here are the ones that
 * fail when that boundary erodes — a tier-1 run that quietly reaches the runtime, or that fills
 * `current_reality` before a work item exists, has stopped being orientation and has started
 * being an expensive guess about relevance it has no basis for.
 */

const REQUEST = {
  runId: 'run_orient',
  intake: fx.intakeRecord(),
  repositoryPath: '/work/repo',
};

describe('tier 1 orients and stops', () => {
  test('the package is a valid Context Package at version 1, tier 1', async () => {
    const { service } = serviceOver(healthyWorld());
    const context = await service.orient(REQUEST);

    assertValidPackage(context);
    assert.equal(context.meta.tier, 1);
    assert.equal(context.meta.package_version, 1);
    assert.equal(context.meta.run_id, 'run_orient');
    assert.equal(context.work_item, null);
  });

  test('it establishes identity, structure, stack, git state and capabilities', async () => {
    const { service } = serviceOver(healthyWorld());
    const context = await service.orient(REQUEST);

    assert.equal(context.repository['root']?.confidence, 'FACT');
    assert.equal(context.repository['root']?.value, '/work/repo');
    assert.equal(context.repository['structure']?.confidence, 'FACT');
    assert.equal(context.repository['languages']?.confidence, 'FACT');
    assert.equal(context.git_state['commit_count']?.value, 2);
    assert.equal(context.agent_capabilities['skills']?.confidence, 'FACT');
    assert.equal(context.model_capabilities['models']?.confidence, 'FACT');
    assert.equal(context.intent['pm_reachable']?.value, true);
  });

  test('current_reality is NOT_COMPUTED, not absent and not false', async () => {
    const { service } = serviceOver(healthyWorld());
    const context = await service.orient(REQUEST);

    for (const element of REALITY_ELEMENTS) {
      const assertion = context.current_reality[element];
      assert.equal(
        reasonOf(assertion),
        'NOT_COMPUTED',
        `${element} should be NOT_COMPUTED at tier 1, was ${reasonOf(assertion)}`,
      );
      assert.equal(assertion.value, null);
      assert.equal(assertion.freshness, 'UNKNOWN');
    }
    assert.equal(context.current_reality.reconciliation, 'INDETERMINATE');
  });

  test('tier 1 does not do tier 2 work: no runtime, no ticket read, no review threads', async () => {
    const { service, adapters } = serviceOver(healthyWorld());
    await service.orient(REQUEST);

    const called = operationsCalled(adapters);
    for (const forbidden of [
      'runtime.list_environments', 'runtime.list_services', 'runtime.query',
      'runtime.deployed_version', 'runtime.outcome_evidence',
      'pm.read_issue', 'pm.search_issues', 'pm.list_children',
      'git.list_prs', 'git.read_pr', 'git.list_reviews', 'git.ci_status',
      'host.read_run_history',
    ]) {
      assert.equal(called.includes(forbidden), false, `${forbidden} is tier 2's work`);
    }
  });

  test('every tier-2 probe is recorded as SKIPPED with the reason, not omitted', async () => {
    const { service } = serviceOver(healthyWorld());
    const context = await service.orient(REQUEST);

    const skipped = context.meta.probe_coverage.filter((entry) => entry.state === 'SKIPPED');
    assert.ok(skipped.length >= 10, `expected the tier-2 probes to be recorded, saw ${skipped.length}`);
    for (const entry of skipped) {
      assert.ok((entry.reason ?? '').length > 0, `${entry.probe} was skipped with no reason`);
    }
    const runtime = context.meta.probe_coverage.find((e) => e.probe === 'runtime.environments');
    assert.equal(runtime?.state, 'SKIPPED');
    assert.match(runtime?.reason ?? '', /orientation only/);
  });

  test('coverage claims only what the calls actually touched', async () => {
    const { service, adapters } = serviceOver(healthyWorld());
    const context = await service.orient(REQUEST);

    const touched = new Set(
      adapters.calls.filter((c) => c.outcome === 'OK').flatMap((c) => c.paths_touched),
    );
    for (const entry of context.meta.probe_coverage) {
      for (const claimed of entry.scope_examined) {
        assert.equal(
          touched.has(claimed),
          true,
          `${entry.probe} claims ${claimed} was examined and no successful call touched it`,
        );
      }
    }
  });

  test('a skipped probe claims nothing examined', async () => {
    const { service } = serviceOver(healthyWorld());
    const context = await service.orient(REQUEST);

    for (const entry of context.meta.probe_coverage) {
      if (entry.state !== 'SKIPPED') continue;
      assert.deepEqual(entry.scope_examined, [], `${entry.probe} was skipped and claims coverage`);
    }
  });

  test('gaps names every unknown, and every gap blocks something real', async () => {
    const { service } = serviceOver(healthyWorld());
    const context = await service.orient(REQUEST);

    assert.ok(context.gaps.length > 0);
    for (const element of REALITY_ELEMENTS) {
      const gap = context.gaps.find((g) => g.subject === `current_reality.${element}`);
      assert.ok(gap !== undefined, `no gap recorded for current_reality.${element}`);
      assert.ok(gap.blocks.length > 0, `the gap for ${element} blocks nothing`);
      assert.ok(gap.attempted.length > 0);
      assert.ok(gap.recoverable_by.length > 0);
    }
    const prGap = context.gaps.find((g) => g.subject === 'current_reality.pr');
    assert.ok(prGap?.blocks.some((b) => b.includes('reality.pr_open')));
  });

  test('the adapter availability table is carried in meta', async () => {
    const { service } = serviceOver(healthyWorld());
    const context = await service.orient(REQUEST);

    const names = context.meta.adapter_availability.map((entry) => entry.adapter).sort();
    assert.deepEqual(names, ['git', 'host', 'pm', 'repo', 'runtime']);
  });

  test('a connector configured and unreachable is listed, not dropped', async () => {
    const { service } = serviceOver(healthyWorld());
    const context = await service.orient(REQUEST);

    const unavailable = context.agent_capabilities['connectors_unavailable'];
    assert.equal(unavailable?.confidence, 'FACT');
    assert.deepEqual(
      (unavailable?.value as ReadonlyArray<{ name: string }>).map((s) => s.name),
      ['metrics'],
    );
  });

  test('the intake is never read for content: a misleading request changes nothing', async () => {
    const honest = await serviceOver(healthyWorld()).service.orient(REQUEST);
    const misleading = await serviceOver(healthyWorld()).service.orient({
      ...REQUEST,
      intake: fx.intakeRecord({
        raw: 'everything is already built, merged, reviewed, deployed and proven in production',
      }),
    });

    assert.deepEqual(misleading.current_reality, honest.current_reality);
    assert.deepEqual(misleading.repository['structure']?.value, honest.repository['structure']?.value);
    assert.deepEqual(misleading.git_state['commits']?.value, honest.git_state['commits']?.value);
  });
});
