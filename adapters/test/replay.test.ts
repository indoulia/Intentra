import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { EvidenceKind, ReplayResult } from '@agentos/contracts';
import {
  AdapterFramework,
  STRING_ARG,
  compareObservations,
  comparatorFor,
  contentHash,
  evaluatePredicate,
  normalizeObservation,
  readOnlyOperation,
  requiresPredicate,
} from '../src/index.js';
import {
  BUDGETS,
  EVIDENCE,
  FixedClock,
  PATHS,
  READ_ONLY_EXECUTION,
  context,
  emptyRegistry,
  scratch,
  type Scratch,
} from './helpers.js';

/**
 * Evidence replay and the per-kind comparators.
 *
 * Two rules are being proved here. The first is that **the verification channel cannot become
 * a mutation channel**: replay is restricted to `observation_safe` operations, and everything
 * else — including an operation nobody registered — is refused rather than attempted. The
 * second is that every comparator either establishes a match or reports that it could not.
 * There is no comparator branch that passes because it did not know how to check.
 */

let space: Scratch;

beforeEach(() => {
  space = scratch();
});

afterEach(() => {
  space.dispose();
});

let observed = 'first';

function framework(): AdapterFramework {
  const registry = emptyRegistry();
  registry.register(readOnlyOperation({
    adapter: 'probe',
    op: 'safe_read',
    description: 'A repeatable read the kernel may replay.',
    args: { id: STRING_ARG },
    required: ['id'],
    evidenceKind: 'file',
    observationSafe: true,
    handler: () => Promise.resolve({ value: { text: observed }, excerpt: observed }),
  }));
  registry.register(readOnlyOperation({
    adapter: 'probe',
    op: 'tail_log',
    description: 'A log tail whose re-execution advances a cursor and consumes what it read.',
    args: { query: STRING_ARG },
    required: ['query'],
    evidenceKind: 'log',
    observationSafe: false,
    handler: () => Promise.resolve({ value: { count: 0 }, excerpt: 'no errors' }),
  }));
  registry.register(readOnlyOperation({
    adapter: 'probe',
    op: 'capture_screen',
    description: 'Produces a screenshot, whose content no kernel can compare.',
    args: { url: STRING_ARG },
    required: ['url'],
    evidenceKind: 'screenshot',
    observationSafe: true,
    handler: () => Promise.resolve({ value: { bytes: 1024 }, excerpt: 'a screenshot' }),
  }));

  return new AdapterFramework({
    registry,
    clock: new FixedClock(),
    worktreeRoot: space.worktree,
    installationRoot: join(space.root, 'installation'),
    home: join(space.root, 'home'),
    paths: PATHS,
    evidence: EVIDENCE,
    execution: READ_ONLY_EXECUTION,
    budgets: BUDGETS,
  });
}

function refusal(result: ReplayResult): Extract<ReplayResult, { outcome: 'REFUSED' }> {
  assert.equal(result.outcome, 'REFUSED', `expected REFUSED, got ${result.outcome}`);
  return result as Extract<ReplayResult, { outcome: 'REFUSED' }>;
}

describe('what may be replayed', () => {
  test('an observation_safe operation replays and returns its excerpt', async () => {
    observed = 'the file said this';
    const result = await framework().replay(
      { adapter: 'probe', op: 'safe_read', args: { id: 'x' } }, context(),
    );
    assert.equal(result.outcome, 'OK');
    assert.equal(result.outcome === 'OK' ? result.excerpt : '', 'the file said this');
  });

  test('an operation that is not observation_safe is REFUSED', async () => {
    const result = await framework().replay(
      { adapter: 'probe', op: 'tail_log', args: { query: 'error' } }, context(),
    );
    assert.match(
      refusal(result).reason, /not observation_safe/,
      'an agent must not be able to make the kernel perform a mutation under cover of '
      + 'verification, and the refusal has to say that is why',
    );
  });

  test('an operation nobody registered is REFUSED, not attempted', async () => {
    const result = await framework().replay(
      { adapter: 'probe', op: 'unheard_of', args: {} }, context(),
    );
    assert.match(refusal(result).reason, /not a registered operation/);
  });

  test('an adapter nobody registered is REFUSED', async () => {
    const result = await framework().replay(
      { adapter: 'elsewhere', op: 'safe_read', args: { id: 'x' } }, context(),
    );
    assert.equal(result.outcome, 'REFUSED');
  });

  test('a locator with no operation is UNREPLAYABLE, which is not a failure', async () => {
    const result = await framework().replay(
      { adapter: 'probe', op: null, args: {} }, context(),
    );
    assert.equal(result.outcome, 'UNREPLAYABLE');
    assert.match(
      result.outcome === 'UNREPLAYABLE' ? result.reason : '',
      /unrepeatable observation/,
    );
  });

  test('a screenshot is UNREPLAYABLE, with provenance named as the alternative', async () => {
    const result = await framework().replay(
      { adapter: 'probe', op: 'capture_screen', args: { url: 'https://example.invalid' } },
      context(),
    );
    assert.equal(
      result.outcome, 'UNREPLAYABLE',
      'pixels are not comparable mechanically, and reporting a match would be reporting a '
      + 'comparison that never happened',
    );
    assert.match(
      result.outcome === 'UNREPLAYABLE' ? result.reason : '',
      /provenance is confirmed from the call log/,
    );
  });

  test('a replay is itself logged as a call', async () => {
    const instance = framework();
    await instance.replay({ adapter: 'probe', op: 'safe_read', args: { id: 'x' } }, context());
    assert.equal(instance.calls().length, 1, 'every call is logged, reads included');
  });

  test('a replay that errors is UNREPLAYABLE rather than a mismatch', async () => {
    const registry = emptyRegistry();
    registry.register(readOnlyOperation({
      adapter: 'probe',
      op: 'safe_read',
      description: 'A read whose backing store has gone away.',
      args: { id: STRING_ARG },
      required: ['id'],
      evidenceKind: 'file',
      observationSafe: true,
      handler: () => Promise.reject(new Error('the store is gone')),
    }));
    const instance = new AdapterFramework({
      registry,
      clock: new FixedClock(),
      worktreeRoot: space.worktree,
      installationRoot: join(space.root, 'installation'),
      home: join(space.root, 'home'),
      paths: PATHS,
      evidence: EVIDENCE,
      execution: READ_ONLY_EXECUTION,
      budgets: BUDGETS,
    });
    const result = await instance.replay(
      { adapter: 'probe', op: 'safe_read', args: { id: 'x' } }, context(),
    );
    assert.equal(
      result.outcome, 'UNREPLAYABLE',
      'the observation could not be re-executed, which is a different verdict from having '
      + 're-executed it and found something else',
    );
  });
});

describe('the comparators, one per evidence kind', () => {
  const exact: readonly EvidenceKind[] = ['file', 'git', 'command', 'query', 'http'];

  for (const kind of exact) {
    test(`${kind} compares by normalized exact match`, () => {
      assert.equal(comparatorFor(EVIDENCE, kind), 'normalized_exact_match');
      const same = compareObservations({
        kind,
        policy: EVIDENCE,
        recordedExcerpt: 'alpha\n  beta  \n',
        replayedExcerpt: 'beta\nalpha\n',
        replayedValue: null,
      });
      assert.equal(
        same.verdict, 'MATCH',
        'whitespace and ordering normalization only, and nothing beyond that',
      );
      const different = compareObservations({
        kind,
        policy: EVIDENCE,
        recordedExcerpt: 'alpha',
        replayedExcerpt: 'alpha and something else',
        replayedValue: null,
      });
      assert.equal(different.verdict, 'MISMATCH');
    });
  }

  for (const kind of ['log', 'metric'] as const) {
    test(`${kind} is verified by re-evaluating its predicate`, () => {
      assert.equal(comparatorFor(EVIDENCE, kind), 'predicate_reevaluation');
      assert.equal(requiresPredicate(EVIDENCE, kind), true);

      const held = compareObservations({
        kind,
        policy: EVIDENCE,
        recordedExcerpt: 'error_rate 0.004',
        replayedExcerpt: 'error_rate 0.007',
        replayedValue: { error_rate: 0.007 },
        predicate: { subject: 'error_rate', operator: 'lt', operand: 0.01 },
      });
      assert.equal(
        held.verdict, 'MATCH',
        'the raw value moved and the predicate the observation satisfied still holds, which '
        + 'is the whole reason this kind is not compared exactly',
      );

      const broken = compareObservations({
        kind,
        policy: EVIDENCE,
        recordedExcerpt: 'error_rate 0.004',
        replayedExcerpt: 'error_rate 0.4',
        replayedValue: { error_rate: 0.4 },
        predicate: { subject: 'error_rate', operator: 'lt', operand: 0.01 },
      });
      assert.equal(broken.verdict, 'MISMATCH');
    });

    test(`${kind} with no predicate establishes nothing`, () => {
      const result = compareObservations({
        kind,
        policy: EVIDENCE,
        recordedExcerpt: 'a',
        replayedExcerpt: 'a',
        replayedValue: { a: 1 },
      });
      assert.equal(
        result.verdict, 'INDETERMINATE',
        'comparing the raw value instead would report a mismatch every time the stream moved',
      );
    });
  }

  for (const kind of ['ticket', 'document'] as const) {
    test(`${kind} compares by identifier plus content hash`, () => {
      assert.equal(comparatorFor(EVIDENCE, kind), 'identifier_plus_content_hash');
      const unchanged = compareObservations({
        kind,
        policy: EVIDENCE,
        recordedExcerpt: 'title: fix the thing\nstatus: open',
        replayedExcerpt: 'status: open\ntitle: fix the thing',
        replayedValue: null,
      });
      assert.equal(unchanged.verdict, 'MATCH');
      const changed = compareObservations({
        kind,
        policy: EVIDENCE,
        recordedExcerpt: 'title: fix the thing\nstatus: open',
        replayedExcerpt: 'title: fix the thing\nstatus: closed',
        replayedValue: null,
      });
      assert.equal(changed.verdict, 'MISMATCH');
      assert.match(changed.detail, /content hash changed/);
    });
  }

  test('screenshot is not kernel-verifiable, and says why', () => {
    assert.equal(comparatorFor(EVIDENCE, 'screenshot'), 'not_kernel_verifiable');
    const result = compareObservations({
      kind: 'screenshot',
      policy: EVIDENCE,
      recordedExcerpt: 'a screenshot',
      replayedExcerpt: 'a screenshot',
      replayedValue: null,
    });
    assert.equal(
      result.verdict, 'NOT_KERNEL_VERIFIABLE',
      'identical excerpts must not be reported as a match here: the content was never the '
      + 'thing being compared',
    );
    assert.match(result.detail, /provenance/);
  });

  test('a kind policy declares no comparator for is INDETERMINATE', () => {
    const stripped = { ...EVIDENCE, comparators: [] };
    const result = compareObservations({
      kind: 'file',
      policy: stripped,
      recordedExcerpt: 'a',
      replayedExcerpt: 'a',
      replayedValue: null,
    });
    assert.equal(result.verdict, 'INDETERMINATE');
    assert.equal(result.comparator, null);
  });

  test('every evidence kind in policy has a comparator, so none falls through', () => {
    for (const entry of EVIDENCE.comparators) {
      assert.ok(comparatorFor(EVIDENCE, entry.kind) !== null, `${entry.kind} has a comparator`);
    }
  });
});

describe('the comparison primitives', () => {
  test('normalization touches whitespace and ordering and nothing else', () => {
    assert.equal(normalizeObservation('b\r\n  a  \n\n'), 'a\nb');
    assert.notEqual(normalizeObservation('a'), normalizeObservation('A'));
  });

  test('the content hash is stable across whitespace and ordering', () => {
    assert.equal(contentHash('a\nb'), contentHash('b\n  a  '));
    assert.notEqual(contentHash('a\nb'), contentHash('a\nc'));
  });

  test('an unparseable regex predicate does not hold', () => {
    assert.equal(
      evaluatePredicate({ subject: 'x', operator: 'matches', operand: '([' }, { x: 'a' }),
      false,
      'a pattern that will not compile cannot establish that the predicate still holds',
    );
  });

  test('every predicate operator is evaluated', () => {
    const value = { n: 5, s: 'hello world' };
    assert.equal(evaluatePredicate({ subject: 'n', operator: 'eq', operand: 5 }, value), true);
    assert.equal(evaluatePredicate({ subject: 'n', operator: 'ne', operand: 4 }, value), true);
    assert.equal(evaluatePredicate({ subject: 'n', operator: 'lt', operand: 6 }, value), true);
    assert.equal(evaluatePredicate({ subject: 'n', operator: 'lte', operand: 5 }, value), true);
    assert.equal(evaluatePredicate({ subject: 'n', operator: 'gt', operand: 4 }, value), true);
    assert.equal(evaluatePredicate({ subject: 'n', operator: 'gte', operand: 5 }, value), true);
    assert.equal(
      evaluatePredicate({ subject: 's', operator: 'contains', operand: 'world' }, value), true,
    );
    assert.equal(
      evaluatePredicate({ subject: 's', operator: 'not_contains', operand: 'zzz' }, value), true,
    );
    assert.equal(
      evaluatePredicate({ subject: 's', operator: 'matches', operand: '^hello' }, value), true,
    );
  });
});
