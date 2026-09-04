import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx } from '@agentos/contracts';
import type { ContextPackage } from '@agentos/contracts';
import { REALITY_ELEMENTS } from '../src/index.js';
import {
  assertValidPackage,
  attemptedOf,
  reasonOf,
  recoverableOf,
  serviceOver,
} from './helpers.js';
import { healthyWorld, misleadingWorkItem, withAvailability } from './worlds.js';

/**
 * Degradation: what the package says when it cannot see.
 *
 * "The pattern throughout: reduced access reduces the strength of claims AgentOS is allowed to
 * make. It never reduces honesty about them" ([REPOSITORY_ADAPTER.md](../../docs/REPOSITORY_ADAPTER.md)
 * section 4). Two failures are being guarded against, and they are opposites. One is a package
 * that quietly reports a shorter list and looks complete. The other is a package so full of
 * unknowns that it is unusable. Both are tested here.
 */

const WORK_ITEM = misleadingWorkItem();

async function run(world = healthyWorld()): Promise<{
  readonly context: ContextPackage;
  readonly service: ReturnType<typeof serviceOver>['service'];
}> {
  const { service } = serviceOver(world);
  await service.orient({
    runId: 'run_degrade', intake: fx.intakeRecord(), repositoryPath: '/work/repo',
  });
  const context = await service.deepen({
    runId: 'run_degrade', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: null,
  });
  return { context, service };
}

describe('an absent source and a broken source are different outcomes', () => {
  test('NOT_CONFIGURED and UNAVAILABLE are both recorded, and are not the same record', async () => {
    const absent = await run(withAvailability(healthyWorld(), { pm: 'NOT_CONFIGURED' }));
    const broken = await run(withAvailability(healthyWorld(), { pm: 'UNAVAILABLE' }));

    const absentState = absent.context.meta.adapter_availability.find((a) => a.adapter === 'pm');
    const brokenState = broken.context.meta.adapter_availability.find((a) => a.adapter === 'pm');
    assert.equal(absentState?.state, 'NOT_CONFIGURED');
    assert.equal(brokenState?.state, 'UNAVAILABLE');

    /* Both are UNAVAILABLE as a semantic — a fact about access, never about the ticket — and
     * they differ in what was attempted and in what would fix it. */
    const absentTicket = absent.context.intent['work_item_ticket'];
    const brokenTicket = broken.context.intent['work_item_ticket'];
    assert.equal(reasonOf(absentTicket), 'UNAVAILABLE');
    assert.equal(reasonOf(brokenTicket), 'UNAVAILABLE');
    assert.match(attemptedOf(absentTicket), /no pm adapter is configured/);
    assert.match(attemptedOf(brokenTicket), /configured and reported UNAVAILABLE/);
    assert.match(recoverableOf(absentTicket), /configure a pm adapter/);
    assert.match(recoverableOf(brokenTicket), /restore connectivity/);
    assert.notEqual(attemptedOf(absentTicket), attemptedOf(brokenTicket));
  });

  test('a DENIED source is neither absent nor merely unreachable', async () => {
    const { context } = await run(withAvailability(healthyWorld(), { runtime: 'DENIED' }));
    assert.equal(
      context.meta.adapter_availability.find((a) => a.adapter === 'runtime')?.state,
      'DENIED',
    );
    assert.match(attemptedOf(context.runtime_state['environments']), /reachable and denied/);
    assert.match(recoverableOf(context.runtime_state['environments']), /grant AgentOS read access/);
  });

  test('an operation the adapter does not offer is not an absent source', async () => {
    const { context } = await run({
      ...healthyWorld(),
      missingOps: ['host.read_run_history'],
    });
    assert.equal(reasonOf(context.current_reality.agentos_history), 'UNAVAILABLE');
    assert.match(attemptedOf(context.current_reality.agentos_history), /offers no read_run_history/);
    assert.match(
      recoverableOf(context.current_reality.agentos_history),
      /implement host\.read_run_history/,
    );
  });
});

describe('no project management, no runtime, no CI: still usable, and honest about it', () => {
  const blind = () => ({
    ...withAvailability(healthyWorld(), { pm: 'NOT_CONFIGURED', runtime: 'NOT_CONFIGURED' }),
    missingOps: ['git.ci_status'],
  });

  test('the package is still a valid one, with the repository and git facts intact', async () => {
    const { context } = await run(blind());
    assertValidPackage(context);
    assert.equal(context.repository['root']?.confidence, 'FACT');
    assert.equal(context.git_state['commit_count']?.confidence, 'FACT');
    assert.equal(context.current_reality.pr.confidence, 'FACT');
    assert.equal(context.current_reality.implementation_present.value, true);
  });

  test('every missing source is named in gaps, with what it blocks', async () => {
    const { context } = await run(blind());

    const subjects = context.gaps.map((g) => g.subject);
    assert.ok(subjects.includes('intent.work_item_ticket'));
    assert.ok(subjects.includes('runtime_state.environments'));
    assert.ok(subjects.includes('current_reality.deployment'));
    assert.ok(subjects.includes('current_reality.outcome_evidence'));

    const runtimeGap = context.gaps.find((g) => g.subject === 'runtime_state.environments');
    assert.ok(runtimeGap?.blocks.some((b) => b.includes('production.applicable')));
    assert.ok(runtimeGap?.blocks.some((b) => b.includes('never PROVEN')));

    const intentGap = context.gaps.find((g) => g.subject === 'intent.work_item_ticket');
    assert.ok(intentGap?.blocks.some((b) => b.includes('INDETERMINATE intent axis')));
  });

  test('the claims that remain are weaker: reconciliation is INDETERMINATE, not ALIGNED', async () => {
    const { context } = await run(blind());
    assert.equal(context.current_reality.reconciliation, 'INDETERMINATE');
    for (const row of context.reconciliation) {
      assert.equal(row.state, 'INDETERMINATE', `${row.capability} claims more than it can see`);
      assert.match(row.rationale, /unavailable|cannot be reconciled/);
    }
  });

  test('coverage distinguishes the probes that ran from the ones that could not', async () => {
    const { context } = await run(blind());
    const byProbe = new Map(context.meta.probe_coverage.map((c) => [c.probe, c]));
    assert.equal(byProbe.get('repo.structure')?.state, 'RAN');
    assert.equal(byProbe.get('runtime.environments')?.state, 'UNAVAILABLE');
    assert.equal(byProbe.get('pm.work_item')?.state, 'UNAVAILABLE');
    assert.equal(byProbe.get('runtime.environments')?.scope_examined.length, 0);
  });

  test('it is still usable: most of the reality set is established', async () => {
    const { context } = await run(blind());
    const known = REALITY_ELEMENTS.filter(
      (element) => context.current_reality[element].confidence !== 'UNKNOWN',
    );
    assert.ok(
      known.length >= 6,
      `a blind run should still establish most of reality, established ${known.length}`,
    );
    assert.ok(known.includes('pr'));
    assert.ok(known.includes('reviews'));
    assert.ok(known.includes('merge_state'));
  });
});

describe('a refusal is surfaced, never swallowed into a gap', () => {
  test('a scope violation is recorded with its kind, in authorization and in the gap', async () => {
    const { context, service } = await run({
      ...healthyWorld(),
      refusals: { 'pm.read_issue': 'scope_violation' },
    });

    const refusals = service.refusals();
    assert.equal(refusals.length >= 1, true);
    assert.equal(refusals[0]?.refusal, 'scope_violation');

    const recorded = context.authorization['probe_refusals'];
    assert.equal(recorded?.confidence, 'INFERENCE');
    const listed = recorded?.value as ReadonlyArray<Record<string, unknown>>;
    assert.equal(listed.some((entry) => entry['refusal'] === 'scope_violation'), true);
    assert.equal(listed.some((entry) => entry['op'] === 'read_issue'), true);

    /* And the assertion it prevented says so in those words, rather than reading as an
     * absence in the system under study. */
    assert.match(attemptedOf(context.intent['work_item_ticket']), /refused as a scope_violation/);
    const gap = context.gaps.find((g) => g.subject === 'refusal.pm.read_issue');
    assert.ok(gap !== undefined, 'the refusal is enumerable as a refusal');
    assert.match(gap.attempted, /scope_violation/);
  });

  test('a security violation aborts the session and everything after it is skipped, not empty', async () => {
    const { service } = serviceOver({
      ...healthyWorld(),
      refusals: { 'git.list_branches': 'security_violation' },
    });
    const context = await service.orient({
      runId: 'run_sec', intake: fx.intakeRecord(), repositoryPath: '/work/repo',
    });

    assertValidPackage(context);
    const aborted = context.authorization['session_aborted_by'];
    assert.ok(aborted !== undefined, 'the abort is recorded');
    assert.match(
      (aborted.confidence === 'INFERENCE' ? aborted.reasoning : ''),
      /security violation aborted the probe session/,
    );

    const byProbe = new Map(context.meta.probe_coverage.map((c) => [c.probe, c]));
    assert.equal(byProbe.get('repo.structure')?.state, 'RAN', 'what ran before the abort stands');
    assert.equal(byProbe.get('git.commits')?.state, 'SKIPPED');
    assert.match(byProbe.get('git.commits')?.reason ?? '', /aborted by a security violation/);
    assert.equal(byProbe.get('host.model_capabilities')?.state, 'SKIPPED');

    /* Nothing after the abort is presented as an established emptiness. */
    assert.equal(context.model_capabilities['models'], undefined);
    assert.equal(reasonOf(context.git_state['branches']), 'UNAVAILABLE');
  });
});

describe('an adapter error mid-tier leaves a partial package that says so', () => {
  test('the failing probe is UNAVAILABLE and the rest of the package still stands', async () => {
    const { context } = await run({
      ...healthyWorld(),
      errors: { 'git.list_reviews': 'the review API returned 502' },
    });

    assertValidPackage(context);
    assert.equal(reasonOf(context.current_reality.reviews), 'UNAVAILABLE');
    assert.match(attemptedOf(context.current_reality.reviews), /502/);
    assert.equal(context.current_reality.pr.confidence, 'FACT', 'the rest of git still stands');

    const coverage = context.meta.probe_coverage.find((c) => c.probe === 'reality.reviews');
    assert.equal(coverage?.state, 'UNAVAILABLE');
    assert.ok(context.gaps.some((g) => g.subject === 'current_reality.reviews'));
  });

  test('a probe that made no successful call claims nothing examined and says what it missed', async () => {
    const { context } = await run({
      ...healthyWorld(),
      errors: { 'repo.list_paths': 'the worktree disappeared' },
    });

    const coverage = context.meta.probe_coverage.find((c) => c.probe === 'repo.tests');
    assert.equal(coverage?.state, 'UNAVAILABLE');
    assert.deepEqual(coverage?.scope_examined, []);
    assert.deepEqual(
      [...(coverage?.scope_not_examined ?? [])].sort(),
      ['src/pricing', 'test/pricing'],
      'the scope it did not reach is named rather than left implicit',
    );
  });

  test('a partial package never looks complete: the unknowns outnumber nothing silently', async () => {
    const { context } = await run({
      ...healthyWorld(),
      errors: {
        'repo.list_paths': 'the worktree disappeared',
        'git.list_prs': 'the git host timed out',
      },
    });
    assert.ok(context.gaps.length >= 5);
    for (const gap of context.gaps) {
      assert.ok(gap.attempted.length > 0, `${gap.subject} does not say what was attempted`);
      assert.ok(gap.blocks.length > 0, `${gap.subject} blocks nothing, which is decorative`);
    }
  });
});
