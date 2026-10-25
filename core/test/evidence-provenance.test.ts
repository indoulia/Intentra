import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  digest,
  fixtures as fx,
  type AdapterRegistry,
  type CallRecord,
  type DodCriterionId,
  type Evidence,
  type EvidenceKind,
  type HandoffEnvelope,
  type ReplayResult,
} from '@intentra/contracts';
import { loadPolicies } from '@intentra/policies';
import { verifyEvidence } from '../src/evidence-verification.js';
import { withVerification } from '../src/receipt.js';
import { computeDod } from '../src/dod.js';
import { loadFixture } from '../src/replay/fixture.js';
import { RecordedAdapterRegistry } from '../src/replay/ports.js';
import { FixtureAdapters, FixedClock } from './doubles.js';

/** Prompt 10: a kind is the registered kind of the operation the locator names; provenance only, not that the claim is true. */

const policies = loadPolicies();

const CONTEXT = {
  workItemId: 'wi_c_subject',
  runId: 'run_20260904T100000Z_000001',
  dispatchId: 'd_001',
  mandate: { in_scope: ['src/**'], out_of_scope: [] },
  grantsHeld: [],
  stageMutating: false,
};

const PASSING = '# tests 12\n# pass 12\n# fail 0';
const RESULTS_FILE = 'src/test-results.txt';
const TEST_RUN = { adapter: 'host', op: 'run_tests', args: { suite: 'unit' } };
const SCREENSHOT = { adapter: 'runtime.browser', op: 'screenshot', args: { url: '/empty' } };

/** A registry whose test-run and screenshot operations are registered as the real ones would be; host.run_tests is a test-only double (Prompt 12). */
function adapters(replays: ReadonlyArray<readonly [string, ReplayResult]> = [], kinds: ReadonlyArray<readonly [string, EvidenceKind]> = []) {
  return new FixtureAdapters({
    files: [{ path: RESULTS_FILE, content: PASSING }, { path: 'src/a.ts', content: 'export const a = 1;' }],
    replays: new Map<string, ReplayResult>([
      ['host.run_tests', { outcome: 'OK', value: PASSING, excerpt: PASSING }],
      ...replays,
    ]),
    kinds: new Map<string, EvidenceKind>([
      ['host.run_tests', 'command'],
      ['host.platform', 'command'],
      ['runtime.browser.screenshot', 'screenshot'],
      ...kinds,
    ]),
    testExecution: new Set(['host.run_tests']),
  });
}

/** Test output, quoted from the operation that ran the tests. */
function testRun(id: string, overrides: Partial<Evidence> = {}): Evidence {
  return fx.evidence({ id, kind: 'command', locator: TEST_RUN, ref: 'unit suite', excerpt: PASSING, ...overrides });
}

/** The same test output, quoted from a file and labelled as command output. */
function relabelledFile(id: string): Evidence {
  return fx.evidence({
    id,
    kind: 'command',
    locator: { adapter: 'repo', op: 'read_file', args: { path: RESULTS_FILE } },
    ref: RESULTS_FILE,
    excerpt: PASSING,
  });
}

function call(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    call_id: 'c_001',
    dispatch_id: CONTEXT.dispatchId,
    adapter: 'repo',
    op: 'read_file',
    args_digest: '{}',
    paths_touched: [],
    capabilities_touched: [],
    outcome: 'OK',
    refusal: null,
    aggregated_count: 1,
    started_at: fx.T1,
    duration_ms: 1,
    ...overrides,
  };
}

/** The Validator's envelope claiming each criterion MET on the evidence ids given for it. */
function validation(evidence: readonly Evidence[], verdicts: Readonly<Record<number, readonly string[]>>): HandoffEnvelope {
  return fx.envelope({
    envelope_id: 'env_validation',
    agent: 'validator',
    stage_in: 'VALIDATION',
    evidence: [...evidence],
    dod_verdicts: Object.entries(verdicts).map(([criterion, cites]) =>
      fx.criterionVerdict({ criterion: Number(criterion) as DodCriterionId, evidence: [...cites] })),
  });
}

/** Receipt step 4 as the kernel runs it, and the envelope as it is then persisted. */
async function receive(envelope: HandoffEnvelope, registry: AdapterRegistry = adapters(), calls: readonly CallRecord[] = []) {
  const report = await verifyEvidence({
    envelope,
    policy: policies.evidence,
    adapters: registry,
    callContext: CONTEXT,
    clock: new FixedClock(),
    calls,
  });
  return { report, persisted: withVerification(envelope, report, fx.T2) };
}

function outcomeOf(report: Awaited<ReturnType<typeof receive>>['report'], id: string) {
  const found = report.outcomes.find((o) => o.evidence_id === id);
  assert.ok(found !== undefined, `${id} was verified`);
  return found;
}

function verdictOf(persisted: HandoffEnvelope, criterion: number, registry: AdapterRegistry = adapters()) {
  const result = computeDod({
    workItemId: CONTEXT.workItemId,
    runId: CONTEXT.runId,
    profileId: 'fix',
    policies,
    envelopes: [persisted],
    completedPriorStages: [],
    graphStages: ['IMPLEMENTATION', 'VALIDATION', 'COMPLETION'],
    sourceDrift: null,
    computedAt: fx.T2,
    executesTests: (adapter, op) => registry.executesTests(adapter, op),
  });
  const found = result.report.criteria.find((c) => c.criterion === criterion);
  assert.ok(found !== undefined);
  return found;
}

describe('a file relabelled as command output does not carry a command-only criterion', () => {
  test('the quotation replays, but repo.read_file produces file evidence, so it is MISMATCH', async () => {
    const { report } = await receive(validation([relabelledFile('C-01')], { 12: ['C-01'] }));
    const outcome = outcomeOf(report, 'C-01');
    assert.equal(outcome.status, 'MISMATCH');
    assert.match(outcome.detail, /declared command, and repo\.read_file produces file evidence/);
    assert.deepEqual(report.downgrades, [{ evidence_id: 'C-01', to: 'UNKNOWN', reason: 'CONFLICTING' }]);
  });

  test('criterion 12, which accepts only command, is NOT_VALIDATED, and the agent\'s claim is kept as made', async () => {
    const { persisted } = await receive(validation([relabelledFile('C-01')], { 12: ['C-01'] }));
    const criterion = verdictOf(persisted, 12);
    assert.equal(criterion.verdict, 'NOT_VALIDATED');
    assert.match(criterion.reason ?? '', /C-01 came back MISMATCH/);
    const item = persisted.evidence.find((e) => e.id === 'C-01');
    assert.equal(item?.kind, 'command', 'the declared kind is recorded, not rewritten');
    assert.equal(item?.excerpt, PASSING);
  });
});

describe('command output from a successful command operation stays eligible', () => {
  test('VERIFIED, and it carries criterion 12', async () => {
    const { report, persisted } = await receive(validation([testRun('C-02')], { 12: ['C-02'] }));
    assert.equal(outcomeOf(report, 'C-02').status, 'VERIFIED');
    assert.equal(verdictOf(persisted, 12).verdict, 'MET');
  });
});

describe('a refused, blocked or failed command establishes nothing about the tests', () => {
  test('a run the adapter refuses to replay is UNREPLAYABLE, whatever the call log shows', async () => {
    const { report, persisted } = await receive(
      validation([testRun('C-03')], { 12: ['C-03'] }),
      adapters([['host.run_tests', { outcome: 'REFUSED', reason: 'host.run_tests is not observation_safe' }]]),
      [call({ adapter: 'host', op: 'run_tests', args_digest: digest(TEST_RUN.args), outcome: 'REFUSED', refusal: 'grant_missing' })],
    );
    assert.equal(outcomeOf(report, 'C-03').status, 'UNREPLAYABLE');
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_VALIDATED');
  });

  test('a run that errors on replay is UNREPLAYABLE', async () => {
    const { report, persisted } = await receive(
      validation([testRun('C-03')], { 12: ['C-03'] }),
      adapters([['host.run_tests', { outcome: 'UNREPLAYABLE', reason: 'the test runner exited before reporting' }]]),
    );
    assert.equal(outcomeOf(report, 'C-03').status, 'UNREPLAYABLE');
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_VALIDATED');
  });

  test('a run whose output reports failures does not match a quotation claiming they passed', async () => {
    const failing = '# tests 12\n# pass 9\n# fail 3';
    const { report, persisted } = await receive(
      validation([testRun('C-03')], { 12: ['C-03'] }),
      adapters([['host.run_tests', { outcome: 'OK', value: failing, excerpt: failing }]]),
    );
    assert.equal(outcomeOf(report, 'C-03').status, 'MISMATCH');
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_VALIDATED');
  });
});

describe('the right text from the wrong operation does not establish the declared kind', () => {
  test('test output an unrelated operation returns verbatim is not command evidence', async () => {
    const quoted = fx.evidence({
      id: 'C-04',
      kind: 'command',
      locator: { adapter: 'git', op: 'read_pr', args: { number: 7 } },
      ref: '#7',
      excerpt: PASSING,
    });
    const { report, persisted } = await receive(
      validation([quoted], { 12: ['C-04'] }),
      adapters([['git.read_pr', { outcome: 'OK', value: PASSING, excerpt: PASSING }]]),
    );
    const outcome = outcomeOf(report, 'C-04');
    assert.equal(outcome.status, 'MISMATCH');
    assert.match(outcome.detail, /git\.read_pr produces http evidence/);
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_VALIDATED');
  });

  test('a command operation that printed something else does not match the quotation', async () => {
    const quoted = testRun('C-05', { locator: { adapter: 'host', op: 'platform', args: {} } });
    const { report } = await receive(
      validation([quoted], { 12: ['C-05'] }),
      adapters([['host.platform', { outcome: 'OK', value: 'linux / lf', excerpt: 'linux / lf' }]]),
    );
    assert.equal(outcomeOf(report, 'C-05').status, 'MISMATCH');
  });
});

describe('evidence does not borrow provenance from another call', () => {
  test('a screenshot citing a successful file read with its arguments is not confirmed by that read', async () => {
    const borrowed = fx.evidence({
      id: 'S-01',
      kind: 'screenshot',
      locator: { adapter: 'repo', op: 'read_file', args: { path: 'src/a.ts' } },
      ref: 'a.png',
      excerpt: 'the settings page shows the restored namespace',
    });
    const { report } = await receive(
      fx.envelope({ evidence: [borrowed], findings: [fx.finding({ severity: 'HIGH', evidence: ['S-01'] })] }),
      adapters(),
      [call({ args_digest: digest({ path: 'src/a.ts' }) })],
    );
    const outcome = outcomeOf(report, 'S-01');
    assert.equal(outcome.status, 'MISMATCH');
    assert.match(outcome.detail, /declared screenshot, and repo\.read_file produces file evidence/);
  });

  test('a screenshot of the right operation made with other arguments is still not confirmed', async () => {
    const { report } = await receive(
      fx.envelope({
        evidence: [fx.evidence({ id: 'S-02', kind: 'screenshot', locator: SCREENSHOT, excerpt: 'the empty state' })],
        findings: [fx.finding({ severity: 'HIGH', evidence: ['S-02'] })],
      }),
      adapters(),
      [call({ adapter: SCREENSHOT.adapter, op: SCREENSHOT.op, args_digest: digest({ url: '/settings' }) })],
    );
    assert.equal(outcomeOf(report, 'S-02').status, 'MISMATCH');
  });

  test('a quotation of one file cited against another does not match it', async () => {
    const { report } = await receive(
      fx.envelope({
        evidence: [fx.evidence({ id: 'E-01', locator: { adapter: 'repo', op: 'read_file', args: { path: 'src/a.ts' } }, excerpt: PASSING })],
        findings: [fx.finding({ severity: 'HIGH', evidence: ['E-01'] })],
      }),
    );
    assert.equal(outcomeOf(report, 'E-01').status, 'MISMATCH');
  });
});

describe('a screenshot does not become file or command evidence by its label', () => {
  for (const kind of ['file', 'command'] as const) {
    test(`a screenshot operation's output labelled ${kind} is MISMATCH, even where a replay would answer`, async () => {
      const relabelled = fx.evidence({ id: 'S-03', kind, locator: SCREENSHOT, ref: 'empty.png', excerpt: 'the empty state' });
      const { report } = await receive(
        fx.envelope({ evidence: [relabelled], findings: [fx.finding({ severity: 'HIGH', evidence: ['S-03'] })] }),
        adapters([['runtime.browser.screenshot', { outcome: 'OK', value: null, excerpt: 'the empty state' }]]),
        [call({ adapter: SCREENSHOT.adapter, op: SCREENSHOT.op, args_digest: digest(SCREENSHOT.args) })],
      );
      const outcome = outcomeOf(report, 'S-03');
      assert.equal(outcome.status, 'MISMATCH');
      assert.match(outcome.detail, new RegExp(`declared ${kind}, and runtime\\.browser\\.screenshot produces screenshot evidence`));
    });
  }
});

describe('evidence of the kind its operation produces still satisfies the existing rules', () => {
  test('a file quotation labelled file carries criterion 3', async () => {
    const genuine = fx.evidence({ id: 'E-02', locator: { adapter: 'repo', op: 'read_file', args: { path: 'src/a.ts' } } });
    const { report, persisted } = await receive(validation([genuine], { 3: ['E-02'] }));
    assert.equal(outcomeOf(report, 'E-02').status, 'VERIFIED');
    assert.equal(verdictOf(persisted, 3).verdict, 'MET');
  });

  test('a screenshot from a screenshot operation is confirmed by its call, and still cannot carry MET alone', async () => {
    const genuine = fx.evidence({ id: 'S-04', kind: 'screenshot', locator: SCREENSHOT, ref: 'empty.png', excerpt: 'the empty state' });
    const { report, persisted } = await receive(
      validation([genuine], { 8: ['S-04'] }),
      adapters(),
      [call({ adapter: SCREENSHOT.adapter, op: SCREENSHOT.op, args_digest: digest(SCREENSHOT.args) })],
    );
    assert.equal(outcomeOf(report, 'S-04').status, 'VERIFIED');
    assert.equal(verdictOf(persisted, 8).verdict, 'NOT_VALIDATED');
  });

  test('beside genuine command output, the screenshot does not stop criterion 8 being MET', async () => {
    const genuine = fx.evidence({ id: 'S-04', kind: 'screenshot', locator: SCREENSHOT, ref: 'empty.png', excerpt: 'the empty state' });
    const { persisted } = await receive(
      validation([genuine, testRun('C-02')], { 8: ['S-04', 'C-02'] }),
      adapters(),
      [call({ adapter: SCREENSHOT.adapter, op: SCREENSHOT.op, args_digest: digest(SCREENSHOT.args) })],
    );
    assert.equal(verdictOf(persisted, 8).verdict, 'MET');
  });
});

describe('mixed evidence: a relabelled item counts for nothing, and a valid one counts only on its own', () => {
  test('cited beside genuine command output, the relabelled item still leaves criterion 12 NOT_VALIDATED', async () => {
    const { persisted } = await receive(validation([testRun('C-02'), relabelledFile('C-01')], { 12: ['C-02', 'C-01'] }));
    const criterion = verdictOf(persisted, 12);
    assert.equal(criterion.verdict, 'NOT_VALIDATED', 'a cited MISMATCH disqualifies the MET (Prompt 7A D1)');
    assert.match(criterion.reason ?? '', /C-01 came back MISMATCH/);
  });

  test('a criterion citing only the genuine item is MET while one citing the relabelled item is not', async () => {
    const { report, persisted } = await receive(validation([testRun('C-02'), relabelledFile('C-01')], { 12: ['C-02'], 9: ['C-01'] }));
    assert.equal(verdictOf(persisted, 12).verdict, 'MET');
    assert.equal(verdictOf(persisted, 9).verdict, 'NOT_VALIDATED');
    assert.equal(report.rejectEnvelope, false, 'one relabel is a defect, not an untrustworthy witness');
  });

  test('two relabelled items are two mismatches, and the envelope is rejected', async () => {
    const { report } = await receive(validation([relabelledFile('C-01'), relabelledFile('C-06')], { 12: ['C-01', 'C-06'] }));
    assert.equal(report.mismatchCount, 2);
    assert.equal(report.rejectEnvelope, true);
    assert.ok(report.violations.some((v) => v.code === 'EVIDENCE_MISMATCH_THRESHOLD'));
  });
});

describe('where the registry cannot say what an operation produces, nothing is verified on the label', () => {
  test('a matching replay of an operation with no registered kind is UNREPLAYABLE, not VERIFIED', async () => {
    const unknown = testRun('C-07', { locator: { adapter: 'ci', op: 'run_suite', args: { suite: 'unit' } } });
    const envelope = validation([unknown], { 12: ['C-07'] });
    const { report, persisted } = await receive(
      envelope,
      adapters([['ci.run_suite', { outcome: 'OK', value: PASSING, excerpt: PASSING }]]),
    );
    const outcome = outcomeOf(report, 'C-07');
    assert.equal(outcome.status, 'UNREPLAYABLE');
    assert.match(outcome.detail, /ci\.run_suite has no registered evidence kind/);
    assert.deepEqual(report.downgrades, [{ evidence_id: 'C-07', to: 'UNKNOWN', reason: 'UNAVAILABLE' }]);
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_VALIDATED');
    assert.deepEqual(envelope.evidence[0], unknown, 'the envelope as received is not altered');
    assert.equal(persisted.evidence[0]?.kind, 'command');
  });

  test('an operation with no registered kind whose replay is refused keeps the existing refusal', async () => {
    const unknown = testRun('C-08', { locator: { adapter: 'ci', op: 'run_suite', args: { suite: 'unit' } } });
    const { report } = await receive(
      validation([unknown], { 12: ['C-08'] }),
      adapters([['ci.run_suite', { outcome: 'REFUSED', reason: 'ci.run_suite is not a registered operation' }]]),
    );
    assert.equal(outcomeOf(report, 'C-08').status, 'UNREPLAYABLE');
    assert.ok(report.violations.some((v) => v.code === 'OBSERVATION_NOT_SAFE_FOR_REPLAY'));
  });

  test('a screenshot citing an operation with no registered kind is not confirmed by a call to it', async () => {
    const locator = { adapter: 'runtime.browser', op: 'capture', args: { url: '/empty' } };
    const { report } = await receive(
      fx.envelope({
        evidence: [fx.evidence({ id: 'S-05', kind: 'screenshot', locator, excerpt: 'the empty state' })],
        findings: [fx.finding({ severity: 'HIGH', evidence: ['S-05'] })],
      }),
      adapters(),
      [call({ adapter: locator.adapter, op: locator.op, args_digest: digest(locator.args) })],
    );
    assert.notEqual(outcomeOf(report, 'S-05').status, 'VERIFIED');
  });
});

describe('a replay recording takes each operation\'s kind from its live registration (Prompt 11)', () => {
  const TYPO_README = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'typo-readme');
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const recorded = (directory = TYPO_README) => new RecordedAdapterRegistry(loadFixture(directory), new FixedClock());
  const readme = (id: string, kind: EvidenceKind): Evidence => fx.evidence({
    id, kind, locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } }, ref: 'README.md', excerpt: 'Intentra',
  });

  test('the committed recording states no kind, and its file quotation is VERIFIED as file', async () => {
    assert.equal(recorded().evidenceKind('repo', 'read_file'), 'file');
    const { report } = await receive(validation([readme('R-01', 'file')], { 3: ['R-01'] }), recorded());
    assert.equal(outcomeOf(report, 'R-01').status, 'VERIFIED');
  });

  test('the same quotation labelled command is MISMATCH and does not carry criterion 12', async () => {
    const { report, persisted } = await receive(validation([readme('R-02', 'command')], { 12: ['R-02'] }), recorded());
    const outcome = outcomeOf(report, 'R-02');
    assert.equal(outcome.status, 'MISMATCH');
    assert.match(outcome.detail, /declared command, and repo\.read_file produces file evidence/);
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_VALIDATED');
  });

  test('an operation no adapter registers is never VERIFIED, whatever kind the recording states for it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'intentra-kind-'));
    roots.push(root);
    cpSync(TYPO_README, root, { recursive: true });
    const path = join(root, 'adapters.json');
    const adapters = JSON.parse(readFileSync(path, 'utf8')) as { operations: Array<{ descriptor: Record<string, unknown> }> };
    adapters.operations.push({
      descriptor: {
        ...adapters.operations[0]?.descriptor,
        adapter: 'host',
        op: 'run_tests',
        args_schema: { type: 'object', properties: { suite: { type: 'string' } }, required: ['suite'], additionalProperties: false },
      },
      evidence_kind: 'command',
      results: { '*': PASSING },
      excerpts: { '*': PASSING },
      replay: { outcome: 'OK', value: PASSING, excerpt: PASSING },
    } as { descriptor: Record<string, unknown> });
    writeFileSync(path, JSON.stringify(adapters), 'utf8');

    const registry = recorded(root);
    assert.equal(registry.evidenceKind('host', 'run_tests'), undefined, 'a recording is not where a kind comes from');
    const { report, persisted } = await receive(validation([testRun('R-03')], { 12: ['R-03'] }), registry);
    const outcome = outcomeOf(report, 'R-03');
    assert.equal(outcome.status, 'UNREPLAYABLE');
    assert.match(outcome.detail, /host\.run_tests has no registered evidence kind/);
    assert.equal(registry.executesTests('host', 'run_tests'), false, 'nor where test execution comes from (Prompt 12)');
    assert.equal(verdictOf(persisted, 12, registry).verdict, 'NOT_VALIDATED');
  });
});
