import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx, type CallRecord, type MutationEvent, type ReplayResult } from '@agentos/contracts';
import { loadPolicies } from '@agentos/policies';
import { reconcile, blastRadius, hasNonReversibleMutation, globToRegExp } from '../src/reconciliation.js';
import { verifyEvidence, selectForVerification, normalizeExcerpt, evaluatePredicate } from '../src/evidence-verification.js';
import { FixtureAdapters, seededRandom, FixedClock } from './doubles.js';

/**
 * The disbelief machinery: steps 3 and 4 of envelope receipt.
 *
 * These are the checks that reach claims which previously looked inherently subjective —
 * what an agent changed, what it looked at, and whether its evidence is real. The tests
 * deliberately do not mock the boundary being tested: the reconciliation runs against real
 * mutation events and call records, and the verification runs a real replay through an
 * adapter that really compares an excerpt.
 */

const policies = loadPolicies();

function call(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    call_id: 'c_001',
    dispatch_id: 'd_001',
    adapter: 'repo',
    op: 'read_file',
    args_digest: '{}',
    paths_touched: ['src/pricing/rate.ts'],
    capabilities_touched: [],
    outcome: 'OK',
    refusal: null,
    aggregated_count: 1,
    started_at: fx.T1,
    duration_ms: 1,
    ...overrides,
  };
}

/* ================================================================ step 3 ==== */

describe('artifacts_changed is reconciled, in both directions', () => {
  test('a match proceeds', () => {
    const result = reconcile({
      envelope: fx.envelope({
        artifacts_changed: [{
          kind: 'file', target: 'src/a.ts', change: 'modified', sha: null, branch: null,
        }],
      }),
      mutations: [fx.mutationEvent({ op: 'write_file', target: 'src/a.ts' })],
      calls: [call({ paths_touched: ['src/**'] })],
    });
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.underReported, []);
    assert.deepEqual(result.overReported, []);
  });

  test('under-reporting is a contract violation: a mutation the agent did not declare', () => {
    const result = reconcile({
      envelope: fx.envelope({ artifacts_changed: [] }),
      mutations: [fx.mutationEvent({ op: 'write_file', target: 'src/a.ts' })],
      calls: [call({ paths_touched: ['src/**'] })],
    });
    assert.equal(result.violations[0]?.code, 'ARTIFACTS_UNDER_REPORTED');
    assert.match(
      result.violations[0]?.message ?? '',
      /cannot be trusted about anything else it reports/,
    );
    assert.equal(result.underReported.length, 1);
  });

  test('over-reporting is a contract violation: a hallucinated edit', () => {
    const result = reconcile({
      envelope: fx.envelope({
        artifacts_changed: [{
          kind: 'file', target: 'src/never-touched.ts', change: 'modified', sha: null, branch: null,
        }],
      }),
      mutations: [],
      calls: [call({ paths_touched: ['src/**'] })],
    });
    assert.equal(result.violations[0]?.code, 'ARTIFACTS_OVER_REPORTED');
    assert.match(
      result.violations[0]?.message ?? '',
      /the code looks fine and the change is absent/,
    );
  });

  test('a path is compared normalized, so a separator or a ./ prefix is not a mismatch', () => {
    const result = reconcile({
      envelope: fx.envelope({
        artifacts_changed: [{
          kind: 'file', target: './src\\a.ts', change: 'modified', sha: null, branch: null,
        }],
      }),
      mutations: [fx.mutationEvent({ op: 'write_file', target: 'src/a.ts' })],
      calls: [call({ paths_touched: ['src/**'] })],
    });
    assert.deepEqual(result.violations, []);
  });

  test('the blast radius comes from the mutation events, never from artifacts_changed', () => {
    const mutations: readonly MutationEvent[] = [
      fx.mutationEvent({ target: 'src/a.ts' }),
      fx.mutationEvent({ target: 'src/b.ts' }),
    ];
    assert.deepEqual(blastRadius(mutations), ['src/a.ts', 'src/b.ts']);
  });

  test('a non-reversible mutation is detectable from the events alone', () => {
    assert.equal(hasNonReversibleMutation([fx.mutationEvent()]), false);
    assert.equal(
      hasNonReversibleMutation([fx.mutationEvent({ reversal: null })]),
      true,
      'the reversal record exists the moment the mutation does, so this is knowable without '
      + 'an envelope',
    );
  });
});

describe('coverage is reconciled against the adapter call log', () => {
  test('claimed scope no call touched is a contract violation', () => {
    const result = reconcile({
      envelope: fx.envelope({
        coverage: fx.coverage({ scope_examined: ['src/audit/**'] }),
      }),
      mutations: [],
      calls: [call({ paths_touched: ['src/pricing/rate.ts'] })],
    });
    assert.equal(result.violations[0]?.code, 'COVERAGE_OVERSTATED');
    assert.match(
      result.violations[0]?.message ?? '',
      /the field distinguishing "found nothing there" from/,
    );
  });

  test('a glob covers the paths beneath it, so a real claim is supported', () => {
    const result = reconcile({
      envelope: fx.envelope({
        coverage: fx.coverage({ scope_examined: ['src/pricing/**'] }),
      }),
      mutations: [],
      calls: [call({ paths_touched: ['src/pricing/rate.ts'] })],
    });
    assert.deepEqual(result.violations, []);
  });

  test('a capability claim is supported by a call that named the capability', () => {
    const result = reconcile({
      envelope: fx.envelope({
        coverage: fx.coverage({ scope_examined: ['cap.pricing'] }),
      }),
      mutations: [],
      calls: [call({ paths_touched: [], capabilities_touched: ['cap.pricing'] })],
    });
    assert.deepEqual(result.violations, []);
  });

  test('touched-but-unclaimed is not a violation: understating thoroughness is not a lie', () => {
    const result = reconcile({
      envelope: fx.envelope({
        coverage: fx.coverage({ scope_examined: ['src/pricing/rate.ts'] }),
      }),
      mutations: [],
      calls: [
        call({ paths_touched: ['src/pricing/rate.ts'] }),
        call({ call_id: 'c_002', paths_touched: ['src/pricing/tax.ts'] }),
      ],
    });
    assert.deepEqual(result.violations, []);
  });

  test('the glob is deliberately small and behaves predictably', () => {
    assert.ok(globToRegExp('src/**').test('src/a/b.ts'));
    assert.ok(globToRegExp('src/**/x.ts').test('src/x.ts'), 'double star matches zero directories');
    assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));
    assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'), 'a single star does not cross a separator');
    assert.ok(globToRegExp('a?c').test('abc'));
    assert.ok(!globToRegExp('src/a.ts').test('src/aXts'), 'a dot is literal');
  });
});

/* ================================================================ step 4 ==== */

const CONTEXT = {
  workItemId: 'wi_c_subject',
  runId: 'run_20260904T100000Z_000001',
  dispatchId: 'd_001',
  mandate: { in_scope: ['src/**'], out_of_scope: [] },
  grantsHeld: [],
  stageMutating: false,
};

describe('evidence selection: what is always verified, and what is sampled', () => {
  test('every item supporting a CRITICAL or HIGH finding is always verified', () => {
    const envelope = fx.envelope({
      findings: [
        fx.finding({ id: 'F-1', severity: 'CRITICAL', evidence: ['E-1'] }),
        fx.finding({ id: 'F-2', severity: 'LOW', evidence: ['E-2'] }),
      ],
      evidence: [fx.evidence({ id: 'E-1' }), fx.evidence({ id: 'E-2' })],
    });
    const selected = selectForVerification(envelope, policies.evidence, () => false, () => 0);
    const byId = new Map(selected.map((s) => [s.evidence.id, s.reason]));
    assert.equal(byId.get('E-1'), 'ALWAYS_CRITICAL_FINDING');
  });

  test('every item cited in an authorization request is always verified', () => {
    const envelope = fx.envelope({
      agent: 'production',
      stage_in: 'AUTHORIZATION',
      evidence: [fx.evidence({ id: 'E-1' })],
      proposals: {
        authorization_request: {
          gate: 'MERGE_PROTECTED',
          target: 'subject :: main',
          what: 'merge',
          why: 'validated',
          blast_radius: 'one service',
          reversibility: { how: 'revert', verified: true, cost: 'one deploy' },
          evidence: ['E-1'],
          unknowns: [],
          alternatives: ['do nothing'],
          recommendation: 'merge',
        },
      },
    });
    const selected = selectForVerification(envelope, policies.evidence, () => false, () => 0);
    assert.equal(
      selected.find((s) => s.evidence.id === 'E-1')?.reason,
      'ALWAYS_AUTHORIZATION',
    );
  });

  test('every item supporting a MET criterion is always verified', () => {
    const envelope = fx.envelope({
      dod_verdicts: [fx.criterionVerdict({ criterion: 3, evidence: ['E-1'] })],
      evidence: [fx.evidence({ id: 'E-1' })],
    });
    const selected = selectForVerification(envelope, policies.evidence, () => false, () => 0);
    assert.equal(selected.find((s) => s.evidence.id === 'E-1')?.reason, 'ALWAYS_DOD_MET');
  });

  test('an item whose FACT contradicts existing state is always verified', () => {
    const envelope = fx.envelope({ evidence: [fx.evidence({ id: 'E-1' })] });
    const selected = selectForVerification(envelope, policies.evidence, () => true, () => 0);
    assert.equal(selected.find((s) => s.evidence.id === 'E-1')?.reason, 'ALWAYS_CONTRADICTS');
  });

  test('at least one item per envelope is verified even when nothing is critical', () => {
    const envelope = fx.envelope({
      evidence: [fx.evidence({ id: 'E-1' }), fx.evidence({ id: 'E-2' })],
    });
    const selected = selectForVerification(
      envelope, policies.evidence, () => false, seededRandom(),
    );
    const sampled = selected.filter((s) => s.reason === 'SAMPLED');
    assert.ok(
      sampled.length >= policies.evidence.sample_minimum_per_envelope,
      'an envelope of uncritical evidence that is never checked at all is an envelope nobody '
      + 'checked',
    );
  });

  test('declared-unreproducible evidence is UNVERIFIABLE rather than replayed', () => {
    const envelope = fx.envelope({
      evidence: [fx.evidence({
        id: 'E-1',
        reproducible: false,
        locator: { adapter: 'runtime.logs', op: null, args: {} },
      })],
    });
    const selected = selectForVerification(envelope, policies.evidence, () => false, () => 0);
    assert.equal(
      selected.find((s) => s.evidence.id === 'E-1')?.reason,
      'DECLARED_UNREPRODUCIBLE',
    );
  });

  test('selection is deterministic given the sampler, so an integrity event is arguable', () => {
    const envelope = fx.envelope({
      evidence: Array.from({ length: 10 }, (_, i) => fx.evidence({ id: `E-${i}` })),
    });
    const first = selectForVerification(envelope, policies.evidence, () => false, seededRandom(7));
    const second = selectForVerification(envelope, policies.evidence, () => false, seededRandom(7));
    assert.deepEqual(
      first.map((s) => `${s.evidence.id}:${s.reason}`),
      second.map((s) => `${s.evidence.id}:${s.reason}`),
    );
  });
});

describe('evidence comparison is mechanical, per kind', () => {
  test('normalization is whitespace and ordering only', () => {
    assert.equal(normalizeExcerpt('  a  b \n c '), normalizeExcerpt('c\na b'));
    assert.notEqual(normalizeExcerpt('a'), normalizeExcerpt('b'));
    assert.notEqual(
      normalizeExcerpt('count: 0'),
      normalizeExcerpt('count: 1'),
      'nothing that could make two different observations compare equal',
    );
  });

  test('a predicate is re-evaluated rather than a volatile value compared', () => {
    assert.equal(
      evaluatePredicate({ subject: 'count', operator: 'eq', operand: 0 }, { count: 0 }),
      true,
    );
    assert.equal(
      evaluatePredicate({ subject: 'error_rate', operator: 'lt', operand: 0.01 }, { error_rate: 0.004 }),
      true,
      'error_rate < 0.01 is checkable a minute later; the exact value is not',
    );
    assert.equal(
      evaluatePredicate({ subject: 'error_rate', operator: 'lt', operand: 0.01 }, { error_rate: 0.5 }),
      false,
    );
    assert.equal(
      evaluatePredicate({ subject: 'body', operator: 'matches', operand: '^ok' }, { body: 'okay' }),
      true,
    );
  });
});

describe('evidence verification and its consequences', () => {
  const evidence = fx.evidence({
    id: 'E-1',
    locator: { adapter: 'repo', op: 'read_file', args: { path: 'src/a.ts' } },
    excerpt: 'export const a = 1;',
  });

  test('a replay that matches is VERIFIED', async () => {
    const adapters = new FixtureAdapters({
      files: [{ path: 'src/a.ts', content: 'export const a = 1;' }],
    });
    const report = await verifyEvidence({
      envelope: fx.envelope({
        findings: [fx.finding({ severity: 'CRITICAL', evidence: ['E-1'] })],
        evidence: [evidence],
      }),
      policy: policies.evidence,
      adapters,
      callContext: CONTEXT,
      clock: new FixedClock(),
      calls: [],
    });
    assert.equal(report.outcomes[0]?.status, 'VERIFIED');
    assert.equal(report.mismatchCount, 0);
    assert.equal(report.rejectEnvelope, false);
  });

  test('a replay that differs is MISMATCH, and the assertion is downgraded', async () => {
    const adapters = new FixtureAdapters({
      files: [{ path: 'src/a.ts', content: 'export const a = 2;' }],
    });
    const report = await verifyEvidence({
      envelope: fx.envelope({
        findings: [fx.finding({ severity: 'CRITICAL', evidence: ['E-1'] })],
        evidence: [evidence],
      }),
      policy: policies.evidence,
      adapters,
      callContext: CONTEXT,
      clock: new FixedClock(),
      calls: [],
    });
    assert.equal(report.outcomes[0]?.status, 'MISMATCH');
    assert.equal(report.mismatchCount, 1);
    assert.deepEqual(
      report.downgrades.map((d) => `${d.evidence_id}:${d.reason}`),
      ['E-1:CONFLICTING'],
      'MISMATCH downgrades to UNKNOWN with reason CONFLICTING',
    );
  });

  test('a finding that loses its last evidence demotes to a hypothesis', async () => {
    const adapters = new FixtureAdapters({
      files: [{ path: 'src/a.ts', content: 'something else entirely' }],
    });
    const report = await verifyEvidence({
      envelope: fx.envelope({
        findings: [fx.finding({ id: 'F-1', severity: 'CRITICAL', evidence: ['E-1'] })],
        evidence: [evidence],
      }),
      policy: policies.evidence,
      adapters,
      callContext: CONTEXT,
      clock: new FixedClock(),
      calls: [],
    });
    assert.deepEqual(
      report.demotedFindings,
      ['F-1'],
      'findings that lose their last verified evidence do not survive as findings',
    );
  });

  test('two mismatches in one envelope reject the whole envelope', async () => {
    const adapters = new FixtureAdapters({ files: [] });
    const report = await verifyEvidence({
      envelope: fx.envelope({
        findings: [
          fx.finding({ id: 'F-1', severity: 'CRITICAL', evidence: ['E-1'] }),
          fx.finding({ id: 'F-2', severity: 'HIGH', evidence: ['E-2'] }),
        ],
        evidence: [
          fx.evidence({ id: 'E-1', locator: { adapter: 'repo', op: 'read_file', args: { path: 'gone-1.ts' } } }),
          fx.evidence({ id: 'E-2', locator: { adapter: 'repo', op: 'read_file', args: { path: 'gone-2.ts' } } }),
        ],
      }),
      policy: policies.evidence,
      adapters,
      callContext: CONTEXT,
      clock: new FixedClock(),
      calls: [],
    });
    assert.equal(report.mismatchCount, 2);
    assert.equal(report.rejectEnvelope, true);
    assert.match(
      report.violations.find((v) => v.code === 'EVIDENCE_MISMATCH_THRESHOLD')?.message ?? '',
      /One fabrication is a defect; two is an untrustworthy witness/,
    );
  });

  test('a single mismatch on authorization evidence rejects the envelope on its own', async () => {
    const adapters = new FixtureAdapters({ files: [] });
    const report = await verifyEvidence({
      envelope: fx.envelope({
        agent: 'production',
        stage_in: 'AUTHORIZATION',
        evidence: [fx.evidence({
          id: 'E-1',
          locator: { adapter: 'repo', op: 'read_file', args: { path: 'gone.ts' } },
        })],
        proposals: {
          authorization_request: {
            gate: 'MERGE_PROTECTED',
            target: 'subject :: main',
            what: 'merge',
            why: 'validated',
            blast_radius: 'one service',
            reversibility: { how: 'revert', verified: true, cost: 'one deploy' },
            evidence: ['E-1'],
            unknowns: [],
            alternatives: ['do nothing'],
            recommendation: 'merge',
          },
        },
      }),
      policy: policies.evidence,
      adapters,
      callContext: CONTEXT,
      clock: new FixedClock(),
      calls: [],
    });
    assert.equal(report.mismatchCount, 1);
    assert.equal(
      report.rejectEnvelope,
      true,
      'a request that oversells its confidence to get a yes has broken the only mechanism '
      + 'protecting production',
    );
  });

  test('an adapter that refuses to replay reports the operation is not observation_safe', async () => {
    const adapters = new FixtureAdapters({ refuseReplay: true });
    const report = await verifyEvidence({
      envelope: fx.envelope({
        findings: [fx.finding({ severity: 'CRITICAL', evidence: ['E-1'] })],
        evidence: [evidence],
      }),
      policy: policies.evidence,
      adapters,
      callContext: CONTEXT,
      clock: new FixedClock(),
      calls: [],
    });
    assert.equal(report.outcomes[0]?.status, 'UNREPLAYABLE');
    assert.equal(
      report.violations.find((v) => v.code === 'OBSERVATION_NOT_SAFE_FOR_REPLAY')?.code,
      'OBSERVATION_NOT_SAFE_FOR_REPLAY',
    );
    assert.match(
      report.violations[0]?.message ?? '',
      /cannot be used to make the kernel perform a mutation/,
    );
  });

  test('a screenshot is not content-verifiable, and its provenance is', async () => {
    const adapters = new FixtureAdapters();
    const screenshot = fx.evidence({
      id: 'E-1',
      kind: 'screenshot',
      locator: { adapter: 'runtime.browser', op: 'screenshot', args: { url: '/empty' } },
    });

    const withCall = await verifyEvidence({
      envelope: fx.envelope({
        findings: [fx.finding({ severity: 'CRITICAL', evidence: ['E-1'] })],
        evidence: [screenshot],
      }),
      policy: policies.evidence,
      adapters,
      callContext: CONTEXT,
      clock: new FixedClock(),
      calls: [call({ adapter: 'runtime.browser', op: 'screenshot' })],
    });
    assert.equal(withCall.outcomes[0]?.status, 'VERIFIED');
    assert.match(withCall.outcomes[0]?.detail ?? '', /confirmed in the call log/);

    const withoutCall = await verifyEvidence({
      envelope: fx.envelope({
        findings: [fx.finding({ severity: 'CRITICAL', evidence: ['E-1'] })],
        evidence: [screenshot],
      }),
      policy: policies.evidence,
      adapters,
      callContext: CONTEXT,
      clock: new FixedClock(),
      calls: [],
    });
    assert.equal(
      withoutCall.outcomes[0]?.status,
      'MISMATCH',
      'a screenshot no adapter call produced is a screenshot from nowhere',
    );
  });

  test('a log predicate is re-evaluated against the replayed value', async () => {
    const replays = new Map<string, ReplayResult>([
      ['runtime.logs.read_lines', { outcome: 'OK', value: { count: 0 }, excerpt: 'irrelevant' }],
    ]);
    const adapters = new FixtureAdapters({ replays });
    const report = await verifyEvidence({
      envelope: fx.envelope({
        findings: [fx.finding({ severity: 'CRITICAL', evidence: ['E-1'] })],
        evidence: [fx.evidence({
          id: 'E-1',
          kind: 'log',
          locator: { adapter: 'runtime.logs', op: 'read_lines', args: { since: '1h' } },
          excerpt: 'no errors in the last hour',
          predicate: { subject: 'count', operator: 'eq', operand: 0 },
        })],
      }),
      policy: policies.evidence,
      adapters,
      callContext: CONTEXT,
      clock: new FixedClock(),
      calls: [],
    });
    assert.equal(
      report.outcomes[0]?.status,
      'VERIFIED',
      'the excerpt differs and the predicate holds, which is the whole point of the comparator',
    );
  });

  test('a FACT finding with no verified evidence is reported', async () => {
    const adapters = new FixtureAdapters({
      files: [{ path: 'src/a.ts', content: 'export const a = 1;' }],
    });
    const report = await verifyEvidence({
      envelope: fx.envelope({
        findings: [fx.finding({
          id: 'F-1', severity: 'LOW', confidence: 'FACT', evidence: ['E-1'],
        })],
        evidence: [fx.evidence({
          id: 'E-1',
          reproducible: false,
          locator: { adapter: 'repo', op: null, args: {} },
        })],
      }),
      policy: policies.evidence,
      adapters,
      callContext: CONTEXT,
      clock: new FixedClock(),
      calls: [],
    });
    assert.ok(
      report.violations.some((v) => v.code === 'FACT_FINDING_WITHOUT_VERIFIED_EVIDENCE'),
      'an unverified item cannot carry a FACT, because nothing checked it',
    );
  });
});
