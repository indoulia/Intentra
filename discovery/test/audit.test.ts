import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx } from '@agentos/contracts';
import { auditFacts, excerptOf, inlineEvidence, MASK, redact } from '../src/index.js';
import { FakeAdapters, callContext, TestClock, WINDOWS } from './fake-registry.js';
import { DiscoveryService } from '../src/index.js';
import { reasonOf } from './helpers.js';
import { healthyWorld, misleadingWorkItem, withResponses } from './worlds.js';

/**
 * The assertion-level audit, which is WP-6's own exit test.
 *
 * "Sample from every section, and every `FACT` must replay through its locator." A package that
 * passes every other test in this directory and fails this one is a package that states things
 * the world does not, which is the single output discovery exists to prevent.
 */

const WORK_ITEM = misleadingWorkItem();

async function packageOver(world = healthyWorld()): Promise<{
  readonly context: Awaited<ReturnType<DiscoveryService['deepen']>>;
  readonly adapters: FakeAdapters;
}> {
  const adapters = new FakeAdapters(world);
  const service = new DiscoveryService({
    adapters, clock: new TestClock(), freshnessWindows: WINDOWS,
  });
  await service.orient({
    runId: 'run_audit', intake: fx.intakeRecord(), repositoryPath: '/work/repo',
  });
  const context = await service.deepen({
    runId: 'run_audit', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: null,
  });
  return { context, adapters };
}

describe('every FACT replays through its locator', () => {
  test('a full package audits clean, and samples from every populated section', async () => {
    const { context, adapters } = await packageOver();
    const report = await auditFacts(context, adapters, callContext());

    assert.equal(report.mismatches, 0, JSON.stringify(
      report.entries.filter((e) => e.verdict === 'MISMATCH'), null, 2,
    ));
    assert.equal(report.unreplayable, 0, JSON.stringify(
      report.entries.filter((e) => e.verdict !== 'MATCH'), null, 2,
    ));
    assert.equal(report.clean, true);
    assert.ok(report.checked > 20, `expected a broad sample, checked ${report.checked}`);

    for (const section of ['repository', 'git_state', 'runtime_state', 'intent', 'current_reality']) {
      assert.ok(
        report.sectionsSampled.includes(section),
        `${section} was never sampled, so the audit says nothing about it`,
      );
    }
  });

  test('every fact in the package carries at least one re-executable locator', async () => {
    const { context } = await packageOver();
    const everything = [
      ...Object.entries(context.repository),
      ...Object.entries(context.git_state),
      ...Object.entries(context.current_reality).filter(([key]) => key !== 'reconciliation'),
    ];
    for (const [key, assertion] of everything) {
      if (assertion === undefined || typeof assertion === 'string') continue;
      if (assertion.confidence !== 'FACT') continue;
      const evidence = inlineEvidence(assertion);
      assert.ok(evidence.length > 0, `${key} is a FACT with no evidence`);
      for (const item of evidence) {
        assert.notEqual(item.locator.op, null, `${key} cites an unrepeatable locator as a fact`);
        assert.equal(item.reproducible, true);
        assert.ok(item.ref.length > 0);
        assert.ok(item.observed_at.length > 0);
      }
    }
  });

  test('a world that drifted under the package is a MISMATCH, not a pass', async () => {
    const { context } = await packageOver();
    const drifted = new FakeAdapters({
      ...healthyWorld(),
      drift: { 'git.list_branches': [{ name: 'main', default: true }] },
    });
    const report = await auditFacts(context, drifted, callContext());

    assert.ok(report.mismatches > 0, 'the branch list changed and the audit reported a match');
    assert.equal(report.clean, false);
    const mismatch = report.entries.find((e) => e.verdict === 'MISMATCH');
    assert.match(mismatch?.detail ?? '', /re-executed to something else/);
  });

  test('a replay the registry refuses is REFUSED, and is not counted as a match', async () => {
    const { context } = await packageOver();
    const refusing = new FakeAdapters({
      ...healthyWorld(),
      replayRefuses: ['repo.identify'],
    });
    const report = await auditFacts(context, refusing, callContext());
    assert.ok(report.refused > 0);
    assert.equal(
      report.entries.some((e) => e.verdict === 'REFUSED' && e.subject.startsWith('repository.')),
      true,
    );
  });
});

describe('an operation that cannot be replayed cannot support a fact', () => {
  test('an observation-unsafe operation yields INFERENCE, with the reason stated', async () => {
    const { context } = await packageOver({
      ...healthyWorld(),
      observationUnsafe: ['repo.identify'],
    });
    const identity = context.repository['identity'];
    assert.equal(
      identity?.confidence,
      'INFERENCE',
      'a fact whose locator cannot be re-executed is an inference wearing a better hat',
    );
    assert.match(
      identity?.confidence === 'INFERENCE' ? identity.reasoning : '',
      /cannot be re-executed/,
    );
    const evidence = inlineEvidence(identity);
    assert.equal(evidence[0]?.locator.op, null);
    assert.equal(evidence[0]?.reproducible, false);
  });
});

describe('log evidence is re-evaluated by predicate, not compared raw', () => {
  test('the error-pattern observation carries a predicate the audit re-evaluates', async () => {
    const { context, adapters } = await packageOver(withResponses(healthyWorld(), {
      'runtime.query': { stores: [], errors: [{ pattern: 'timeout', count: 3 }], throughput: 7 },
    }));
    const patterns = context.runtime_state['error_patterns'];
    assert.equal(patterns?.confidence, 'FACT');
    const evidence = inlineEvidence(patterns);
    assert.equal(evidence[0]?.kind, 'log');
    assert.equal(evidence[0]?.predicate?.subject, 'errors.length');
    assert.equal(evidence[0]?.predicate?.operator, 'gte');
    assert.equal(evidence[0]?.predicate?.operand, 1);

    const report = await auditFacts(context, adapters, callContext());
    const entry = report.entries.find((e) => e.subject === 'runtime_state.error_patterns');
    assert.equal(entry?.verdict, 'MATCH');
    assert.match(entry?.detail ?? '', /predicate/);
  });
});

describe('secrets never reach the package', () => {
  test('a credential in an observation is masked in the excerpt', () => {
    const excerpt = excerptOf({
      DATABASE_PASSWORD: 'hunter2-super-secret',
      host: 'db.internal',
      api_key: 'sk-live-0123456789',
    });
    assert.equal(excerpt.includes('hunter2-super-secret'), false);
    assert.equal(excerpt.includes('sk-live-0123456789'), false);
    assert.ok(excerpt.includes(MASK));
    assert.ok(excerpt.includes('db.internal'), 'the non-secret context survives');
  });

  test('credentials in a URL and in a bearer header are masked', () => {
    assert.ok(redact('postgres://user:p4ssw0rd@db:5432/app').includes(`${MASK}@`));
    assert.equal(redact('Authorization: Bearer abcdef0123456789').includes('abcdef0123456789'), false);
  });

  test('configuration values are located and deliberately not read into the package', async () => {
    const { context } = await packageOver();
    assert.equal(reasonOf(context.repository['configuration_values']), 'NOT_COMPUTED');
    assert.match(
      context.repository['configuration_values']?.confidence === 'UNKNOWN'
        ? (context.repository['configuration_values'].attempted ?? '')
        : '',
      /Secrets are never captured/,
    );
  });
});
