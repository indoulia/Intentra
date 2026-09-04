import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx } from '@agentos/contracts';
import type { ContextPackage } from '@agentos/contracts';
import { DiscoveryService, REALITY_ELEMENTS, realityProbeFor } from '../src/index.js';
import { assertValidPackage, reasonOf, serviceOver } from './helpers.js';
import {
  HEAD_SHA,
  TICKET,
  healthyWorld,
  misleadingIntake,
  misleadingWorkItem,
  withAvailability,
  withResponses,
} from './worlds.js';

/**
 * `current_reality`, which is the section every resume decision is computed from.
 *
 * The rule under test throughout: **it is established from adapters or it is `UNKNOWN`**. Not
 * from the request's wording, not from a ticket's status field, not from an agent's account of
 * a previous run. Several tests here deliberately give discovery a work item and an intake that
 * insist the work is finished, merged and deployed, against a world that says otherwise, and
 * check that the world wins every time.
 */

const WORK_ITEM = misleadingWorkItem();

async function deepenOver(world = healthyWorld()): Promise<ContextPackage> {
  const { service } = serviceOver(world);
  await service.orient({
    runId: 'run_reality',
    intake: misleadingIntake(),
    repositoryPath: '/work/repo',
  });
  return service.deepen({
    runId: 'run_reality',
    workItem: WORK_ITEM,
    repositoryPath: '/work/repo',
    previous: null,
  });
}

describe('the reality set is written only by probes', () => {
  test('all ten elements exist and the package is valid', async () => {
    const context = await deepenOver();
    assertValidPackage(context);
    assert.equal(context.meta.tier, 2);
    for (const element of REALITY_ELEMENTS) {
      assert.ok(context.current_reality[element] !== undefined, `${element} is missing`);
    }
  });

  test('the pull request is read from git, with its state and head', async () => {
    const context = await deepenOver();
    const pr = context.current_reality.pr;
    assert.equal(pr.confidence, 'FACT');
    const value = pr.value as Record<string, unknown>;
    assert.equal(value['state'], 'OPEN');
    assert.equal(value['head_sha'], HEAD_SHA);
    assert.equal(value['number'], 41);
  });

  test('reviews carry the count, the approval against the current head, and open threads', async () => {
    const context = await deepenOver();
    const reviews = context.current_reality.reviews.value as Record<string, unknown>;
    assert.equal(reviews['review_count'], 1);
    assert.equal(reviews['approved'], false);
    assert.equal(reviews['unresolved_threads'], 1);
  });

  test('an approval of an earlier revision is not an approval of the current head', async () => {
    const context = await deepenOver(withResponses(healthyWorld(), {
      'git.list_reviews': {
        reviews: [{ reviewer: 'r@example.com', state: 'APPROVED', commit_sha: 'stale-sha' }],
        threads: [],
      },
    }));
    const reviews = context.current_reality.reviews.value as Record<string, unknown>;
    assert.equal(reviews['review_count'], 1, 'the review happened');
    assert.equal(reviews['approved'], false, 'and it does not approve this head');
  });

  test('CI is green only when every completed run succeeded, keyed to the head', async () => {
    const green = await deepenOver();
    const ci = green.current_reality.ci.value as Record<string, unknown>;
    assert.equal(ci['result'], 'GREEN');
    assert.equal(ci['head_sha'], HEAD_SHA);

    const red = await deepenOver(withResponses(healthyWorld(), {
      'git.ci_status': {
        runs: [
          { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
        ],
      },
    }));
    assert.equal((red.current_reality.ci.value as Record<string, unknown>)['result'], 'RED');
  });

  test('implementation_present is a boolean fact, so a predicate over it reads TRUE or FALSE', async () => {
    const context = await deepenOver();
    assert.equal(context.current_reality.implementation_present.confidence, 'FACT');
    assert.equal(context.current_reality.implementation_present.value, true);
  });

  test('tests that exist with no observed execution are INSUFFICIENT_EVIDENCE, never true', async () => {
    const context = await deepenOver(withResponses(healthyWorld(), {
      'git.ci_status': { runs: [{ name: 'build', status: 'QUEUED', conclusion: null }] },
    }));
    assert.equal(reasonOf(context.current_reality.tests_present), 'INSUFFICIENT_EVIDENCE');
    assert.equal(context.current_reality.tests_present.value, null);
  });

  test('no tests covering the scope is an observed false, not an unknown', async () => {
    const context = await deepenOver(withResponses(healthyWorld(), {
      'repo.list_paths': () => [],
    }));
    assert.equal(context.current_reality.tests_present.confidence, 'FACT');
    assert.equal(context.current_reality.tests_present.value, false);
  });

  test("agentos_history is read from AgentOS's ledger and carries the completed stages", async () => {
    const context = await deepenOver();
    const runs = context.current_reality.agentos_history.value as ReadonlyArray<Record<string, unknown>>;
    assert.equal(context.current_reality.agentos_history.confidence, 'FACT');
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0]?.['stages_completed'], ['AUDIT', 'PLAN', 'IMPLEMENTATION']);
  });

  test('a child known only to the project-management system has an UNKNOWN lifecycle', async () => {
    const context = await deepenOver(withResponses(healthyWorld(), {
      'pm.list_children': [{ key: 'DEF-457', status: 'Done' }],
    }));
    const children = context.current_reality.children.value as ReadonlyArray<Record<string, unknown>>;
    assert.equal(children.length, 1);
    assert.equal(children[0]?.['id'], 'DEF-457');
    assert.equal(
      children[0]?.['lifecycle'],
      'UNKNOWN',
      "a ticket's own status is not an AgentOS lifecycle",
    );
  });
});

describe('an unreachable source is never an absent one', () => {
  test('an unreachable git host makes pr UNAVAILABLE, not "there is no PR"', async () => {
    const context = await deepenOver(withAvailability(healthyWorld(), { git: 'UNAVAILABLE' }));
    const pr = context.current_reality.pr;
    assert.equal(pr.confidence, 'UNKNOWN');
    assert.equal(reasonOf(pr), 'UNAVAILABLE');
    assert.equal(pr.value, null);
  });

  test('a git host that answers and shows no pull request is an observed absence', async () => {
    const context = await deepenOver(withResponses(healthyWorld(), { 'git.list_prs': [] }));
    const pr = context.current_reality.pr;
    assert.equal(pr.confidence, 'FACT');
    const value = pr.value as Record<string, unknown>;
    assert.equal(value['exists'], false);
    assert.equal(
      'state' in value,
      false,
      'no state field, so reality.pr_open reads FALSE rather than inventing a state value',
    );
  });

  test('with no pull request, merge_state is NOT_PROPOSED and reviews are an observed zero', async () => {
    const context = await deepenOver(withResponses(healthyWorld(), { 'git.list_prs': [] }));
    assert.equal(
      (context.current_reality.merge_state.value as Record<string, unknown>)['state'],
      'NOT_PROPOSED',
    );
    const reviews = context.current_reality.reviews.value as Record<string, unknown>;
    assert.equal(reviews['review_count'], 0);
    assert.equal(context.current_reality.reviews.confidence, 'FACT');
  });

  test('a repository with no pipelines makes ci NOT_APPLICABLE, distinct from unreachable CI', async () => {
    /*
     * No CI provider answers *and* the repository declares no pipelines: asking whether CI
     * passed for this head is a category error, and the degradation is "validation is local
     * only". That is a different state from a CI provider that could not be reached, and the
     * two must not read the same.
     */
    const world = healthyWorld();
    const withoutCiOp = { ...world, missingOps: ['git.ci_status'] };
    const noPipelines = await deepenOver(withResponses(withoutCiOp, {
      'repo.list_paths': (args: Readonly<Record<string, unknown>>) => {
        const globs = (args['globs'] ?? []) as string[];
        return globs.some((g) => g.includes('workflows')) ? [] : ['test/pricing/rate.test.ts'];
      },
    }));
    assert.equal(reasonOf(noPipelines.current_reality.ci), 'NOT_APPLICABLE');

    const unreachable = await deepenOver(withAvailability(healthyWorld(), { git: 'UNAVAILABLE' }));
    assert.equal(reasonOf(unreachable.current_reality.ci), 'UNAVAILABLE');
  });

  test('no runtime makes deployment and outcome UNAVAILABLE, never false', async () => {
    const context = await deepenOver(withAvailability(healthyWorld(), { runtime: 'NOT_CONFIGURED' }));
    assert.equal(reasonOf(context.current_reality.deployment), 'UNAVAILABLE');
    assert.equal(reasonOf(context.current_reality.outcome_evidence), 'UNAVAILABLE');
    assert.equal(context.current_reality.outcome_evidence.value, null);
  });
});

describe('nothing in current_reality comes from the request or the ticket', () => {
  test('a misleading intake and a ticket marked Done change nothing', async () => {
    const honestWorld = healthyWorld();
    const honest = await deepenOver(honestWorld);

    /* Same world, except the ticket now claims the work is finished — and the request insists
     * on it too. Every element must be identical, because neither source is authoritative
     * about the repository, the pipeline, the reviews or the runtime. */
    const misleading = await deepenOver(withResponses(honestWorld, {
      'pm.read_issue': { key: TICKET, status: 'Done', title: 'Rate rounding is wrong' },
      'pm.search_issues': [{ key: TICKET, type: 'STORY', status: 'Done', title: 'Rate rounding is wrong' }],
    }));

    for (const element of REALITY_ELEMENTS) {
      assert.deepEqual(
        misleading.current_reality[element].value,
        honest.current_reality[element].value,
        `${element} moved when only the ticket status and the request wording changed`,
      );
      assert.equal(
        misleading.current_reality[element].confidence,
        honest.current_reality[element].confidence,
      );
    }
  });

  test('the ticket claim is recorded as a claim about the ticket, in intent', async () => {
    const context = await deepenOver(withResponses(healthyWorld(), {
      'pm.read_issue': { key: TICKET, status: 'Done', title: 'Rate rounding is wrong' },
    }));
    assert.equal(context.intent['ticket_status']?.value, 'Done');
    assert.equal(context.intent['ticket_status']?.confidence, 'FACT');
    assert.equal(context.intent['claims_completion']?.value, true);
    assert.equal(
      context.intent['claims_completion']?.confidence,
      'INFERENCE',
      'what a ticket implies about the system is at most an inference',
    );
  });

  test('a work item whose own title claims completion does not make the work complete', async () => {
    const context = await deepenOver();
    assert.equal(WORK_ITEM.title.includes('Already fixed'), true);
    assert.equal(context.current_reality.merge_state.value !== null, true);
    assert.equal(
      (context.current_reality.merge_state.value as Record<string, unknown>)['state'],
      'OPEN',
    );
  });
});

describe('reality is re-probed, not snapshotted', () => {
  test('reprobeReality re-reads the element and the stale value is not the one returned', async () => {
    const world = healthyWorld();
    const { service, clock } = serviceOver(world);
    await service.orient({
      runId: 'run_stale',
      intake: fx.intakeRecord(),
      repositoryPath: '/work/repo',
    });
    const first = await service.deepen({
      runId: 'run_stale',
      workItem: WORK_ITEM,
      repositoryPath: '/work/repo',
      previous: null,
    });
    assert.equal(first.current_reality.pr.freshness, 'CURRENT');
    assert.equal((first.current_reality.pr.value as Record<string, unknown>)['state'], 'OPEN');

    /* Ten minutes later the git window has expired, and in the meantime the pull request was
     * merged. A snapshot would still say OPEN. */
    clock.advance(600_000);
    const merged = withResponses(world, {
      'git.list_prs': [{
        number: 41,
        state: 'MERGED',
        head_branch: `feature/${TICKET}-rate-rounding`,
        head_sha: HEAD_SHA,
      }],
      'git.read_pr': { number: 41, state: 'MERGED', head_sha: HEAD_SHA },
    });
    const { service: after, clock: afterClock } = serviceOver(merged);
    await after.orient({ runId: 'run_stale', intake: fx.intakeRecord(), repositoryPath: '/work/repo' });
    await after.deepen({
      runId: 'run_stale', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: null,
    });
    afterClock.advance(600_000);
    const fresh = await after.reprobeReality('pr', WORK_ITEM, WORK_ITEM.scope);

    assert.equal(fresh.confidence, 'FACT');
    assert.equal((fresh.value as Record<string, unknown>)['state'], 'MERGED');
    assert.equal(fresh.freshness, 'CURRENT', 'the re-read is current as of the re-read');
    assert.notDeepEqual(fresh.value, first.current_reality.pr.value);
  });

  test('a stale element is stale, and a re-read of an unreachable source stays UNKNOWN', async () => {
    const { service, clock } = serviceOver(withAvailability(healthyWorld(), { git: 'UNAVAILABLE' }));
    await service.orient({ runId: 'r', intake: fx.intakeRecord(), repositoryPath: '/work/repo' });
    await service.deepen({
      runId: 'r', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: null,
    });
    clock.advance(600_000);
    const fresh = await service.reprobeReality('pr', WORK_ITEM, WORK_ITEM.scope);
    assert.equal(fresh.confidence, 'UNKNOWN');
    assert.equal(reasonOf(fresh), 'UNAVAILABLE');
    assert.equal(fresh.freshness, 'UNKNOWN');
  });

  test('every re-probe is recorded, so a re-read is auditable', async () => {
    const { service } = serviceOver(healthyWorld());
    await service.orient({ runId: 'r', intake: fx.intakeRecord(), repositoryPath: '/work/repo' });
    await service.deepen({
      runId: 'r', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: null,
    });
    await service.reprobeReality('reviews', WORK_ITEM, WORK_ITEM.scope);
    await service.reprobeReality('ci', WORK_ITEM, WORK_ITEM.scope);

    assert.deepEqual(service.reprobes().map((r) => r.element), ['reviews', 'ci']);
    assert.equal(service.reprobes()[0]?.confidence, 'FACT');
  });

  test('every reality element has a probe: none is left for the kernel to guess', () => {
    /*
     * An element the kernel can name and no probe writes would be a hole the predicate reads
     * as INDETERMINATE — the right value for the wrong reason, and untraceable. The lookup
     * throws rather than returning a placeholder, so this is the check that a new element
     * cannot be added without a probe.
     */
    for (const element of REALITY_ELEMENTS) {
      const probe = realityProbeFor(element);
      assert.equal(probe.element, element);
      assert.ok(probe.name.length > 0);
    }
    assert.deepEqual([...DiscoveryService.coveredRealityElements()].sort(), [...REALITY_ELEMENTS].sort());
  });
});
