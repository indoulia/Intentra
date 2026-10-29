import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { EOL, platform } from 'node:os';
import { sep } from 'node:path';
import {
  fixtures as fx,
  type AdapterRegistry,
  type DodCriterionId,
  type DodVerdict,
  type Evidence,
  type EvidenceKind,
  type HandoffEnvelope,
  type ReplayResult,
} from '@intentra/contracts';
import { loadPolicies } from '@intentra/policies';
import { verifyEvidence } from '../src/evidence-verification.js';
import { withVerification } from '../src/receipt.js';
import { computeDod } from '../src/dod.js';
import { buildKernel } from '../src/composition/build.js';
import { Kernel } from '../src/kernel.js';
import {
  README_CONTENT,
  FixtureAdapters,
  FixedClock,
  ScriptedSubstrate,
  auditEnvelope,
  harness,
  policiesWithReadOnlyValidation,
  resolutionEnvelope,
  rootCauseEnvelope,
  workflowEnvelope,
  type FixtureAdapterOptions,
  type ScriptedResponse,
} from './doubles.js';
import { scratchWorld, type ScratchWorld } from './e2e/world.js';

/**
 * Prompt 12: behavioural criteria (9, 12) need test execution output (DEFINITION_OF_DONE
 * section 4), and only an operation its adapter registered as executing tests produces it.
 * `command` is the kind host inventory is registered as too, so the kind alone cannot say so.
 */

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
const FAILING = '# tests 12\n# pass 9\n# fail 3';
const PLATFORM = 'linux / lf';
/** A controlled test double registered as executing tests. No production operation is. */
const RUNNER = { adapter: 'double', op: 'run_tests', args: { suite: 'unit' } };
const HOST_INVENTORY = ['identity', 'platform', 'list_skills', 'list_models', 'list_tools', 'list_plugins', 'list_mcp_servers', 'read_intake'];

/** Host inventory as the real adapters register it, the double, and a runner-named op registered as plain command output. */
function adapters(replays: ReadonlyArray<readonly [string, ReplayResult]> = []) {
  return new FixtureAdapters(registrations(replays));
}

function registrations(
  replays: ReadonlyArray<readonly [string, ReplayResult]> = [],
  testExecution: ReadonlySet<string> = new Set(['double.run_tests']),
): FixtureAdapterOptions {
  return {
    replays: new Map<string, ReplayResult>([
      ['double.run_tests', { outcome: 'OK', value: PASSING, excerpt: PASSING }],
      ['host.run_tests', { outcome: 'OK', value: PASSING, excerpt: PASSING }],
      ...HOST_INVENTORY.map((op): [string, ReplayResult] => [`host.${op}`, { outcome: 'OK', value: PLATFORM, excerpt: PLATFORM }]),
      ...replays,
    ]),
    kinds: new Map<string, EvidenceKind>([
      ['double.run_tests', 'command'],
      ['host.run_tests', 'command'],
      ...HOST_INVENTORY.map((op): [string, EvidenceKind] => [`host.${op}`, 'command']),
    ]),
    testExecution,
  };
}

function testRun(id: string, overrides: Partial<Evidence> = {}): Evidence {
  return fx.evidence({ id, kind: 'command', locator: RUNNER, ref: 'unit suite', excerpt: PASSING, ...overrides });
}

function inventory(id: string, op = 'platform', overrides: Partial<Evidence> = {}): Evidence {
  return fx.evidence({ id, kind: 'command', locator: { adapter: 'host', op, args: {} }, ref: `host.${op}`, excerpt: PLATFORM, ...overrides });
}

function validation(
  evidence: readonly Evidence[],
  verdicts: Readonly<Record<number, readonly string[]>>,
  verdict: DodVerdict = 'MET',
  reason: string | null = null,
): HandoffEnvelope {
  return fx.envelope({
    envelope_id: 'env_validation',
    agent: 'validator',
    stage_in: 'VALIDATION',
    evidence: [...evidence],
    dod_verdicts: Object.entries(verdicts).map(([criterion, cites]) =>
      fx.criterionVerdict({ criterion: Number(criterion) as DodCriterionId, evidence: [...cites], verdict, reason })),
  });
}

async function receive(envelope: HandoffEnvelope, registry: AdapterRegistry = adapters()) {
  const report = await verifyEvidence({
    envelope,
    policy: policies.evidence,
    adapters: registry,
    callContext: CONTEXT,
    clock: new FixedClock(),
    calls: [],
  });
  return { report, persisted: withVerification(envelope, report, fx.T2) };
}

function statusOf(report: Awaited<ReturnType<typeof receive>>['report'], id: string) {
  return report.outcomes.find((o) => o.evidence_id === id)?.status;
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

const VERIFIED = { status: 'VERIFIED' as const, at: fx.T2, by: 'kernel' as const, matches: true, detail: 'replayed and matched' };

describe('the fix profile accepts command for 9 and 12, so the kind alone cannot keep host inventory out', () => {
  test('both criteria are behavioural, accept only command, and 12 is critical', () => {
    const profile = policies.profile('fix');
    for (const criterion of [9, 12] as const) {
      assert.deepEqual(profile.evidence_requirements[String(criterion)]?.kinds, ['command']);
      assert.equal(policies.dod.criteria.find((c) => c.criterion === criterion)?.evidence_class, 'behavioural');
    }
    assert.ok(profile.critical_criteria.includes(12));
  });
});

describe('host inventory output does not carry criterion 9 or 12 (Prompt 12)', () => {
  for (const criterion of [9, 12]) {
    for (const op of HOST_INVENTORY) {
      test(`host.${op}, VERIFIED as the command output it is, leaves criterion ${criterion} NOT_VALIDATED`, async () => {
        const { report, persisted } = await receive(validation([inventory('H-01', op)], { [criterion]: ['H-01'] }));
        assert.equal(statusOf(report, 'H-01'), 'VERIFIED', 'the quotation is genuine: provenance is not what fails');
        const verdict = verdictOf(persisted, criterion);
        assert.equal(verdict.verdict, 'NOT_VALIDATED');
        assert.match(verdict.reason ?? '', new RegExp(`H-01 is output of host\\.${op}, which is not registered as executing tests`));
      });
    }
  }
});

describe('an agent cannot make output test execution output by saying so', () => {
  test('a reason, ref, excerpt and locator arguments that say tests ran grant nothing', async () => {
    const claimed = inventory('H-02', 'platform', {
      ref: 'unit test suite run',
      excerpt: PASSING,
      locator: { adapter: 'host', op: 'platform', args: { executes_tests: true } },
    });
    const { report, persisted } = await receive(
      validation([claimed], { 12: ['H-02'] }, 'MET', 'the unit suite ran and all 12 tests passed'),
      adapters([['host.platform', { outcome: 'OK', value: PASSING, excerpt: PASSING }]]),
    );
    assert.equal(statusOf(report, 'H-02'), 'VERIFIED');
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_VALIDATED');
  });

  test('an operation named like a test runner, registered as plain command output, is not one', async () => {
    const named = testRun('H-03', { locator: { adapter: 'host', op: 'run_tests', args: { suite: 'unit', executes_tests: true } } });
    const { report, persisted } = await receive(validation([named], { 9: ['H-03'], 12: ['H-03'] }));
    assert.equal(statusOf(report, 'H-03'), 'VERIFIED');
    assert.equal(verdictOf(persisted, 9).verdict, 'NOT_VALIDATED');
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_VALIDATED');
  });
});

describe('where nothing registered says an operation runs tests, the criterion fails closed', () => {
  test('a VERIFIED result recorded on an operation no adapter registers does not carry 12', () => {
    const persisted = validation([testRun('U-01', { locator: { adapter: 'ci', op: 'run_suite', args: {} }, verification: VERIFIED })], { 12: ['U-01'] });
    const verdict = verdictOf(persisted, 12);
    assert.equal(verdict.verdict, 'NOT_VALIDATED');
    assert.match(verdict.reason ?? '', /ci\.run_suite, which is not registered as executing tests/);
  });

  test('a VERIFIED result on a locator with no operation does not carry 12', () => {
    const persisted = validation([testRun('U-02', { locator: { adapter: 'double', op: null, args: {} }, verification: VERIFIED })], { 12: ['U-02'] });
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_VALIDATED');
  });

  test('with no registry to ask, even the double does not carry 12', async () => {
    const { persisted } = await receive(validation([testRun('U-03')], { 12: ['U-03'] }));
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
    });
    assert.equal(result.report.criteria.find((c) => c.criterion === 12)?.verdict, 'NOT_VALIDATED');
  });
});

describe('the controlled double registered as executing tests, under every existing rule', () => {
  test('its output, replayed VERIFIED, carries criteria 9 and 12', async () => {
    const { report, persisted } = await receive(validation([testRun('T-01')], { 9: ['T-01'], 12: ['T-01'] }));
    assert.equal(statusOf(report, 'T-01'), 'VERIFIED');
    assert.equal(verdictOf(persisted, 9).verdict, 'MET');
    assert.equal(verdictOf(persisted, 12).verdict, 'MET');
  });

  test('labelled file, it is MISMATCH on its kind and carries nothing', async () => {
    const { report, persisted } = await receive(validation([testRun('T-02', { kind: 'file' })], { 12: ['T-02'] }));
    assert.equal(statusOf(report, 'T-02'), 'MISMATCH');
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_VALIDATED');
  });

  test('declared unreproducible, it is never replayed and carries nothing', async () => {
    const { persisted } = await receive(validation([testRun('T-03', { reproducible: false })], { 12: ['T-03'] }));
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_VALIDATED');
  });

  test('a run the adapter refuses to replay is UNREPLAYABLE and carries nothing', async () => {
    const { report, persisted } = await receive(
      validation([testRun('T-04')], { 12: ['T-04'] }),
      adapters([['double.run_tests', { outcome: 'REFUSED', reason: 'double.run_tests is not observation_safe' }]]),
    );
    assert.equal(statusOf(report, 'T-04'), 'UNREPLAYABLE');
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_VALIDATED');
  });
});

describe('a registration that runs tests does not establish that they passed', () => {
  test('a run whose replay reports failures does not match a quotation claiming they passed', async () => {
    const { report, persisted } = await receive(
      validation([testRun('T-05')], { 12: ['T-05'] }),
      adapters([['double.run_tests', { outcome: 'OK', value: FAILING, excerpt: FAILING }]]),
    );
    assert.equal(statusOf(report, 'T-05'), 'MISMATCH');
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_VALIDATED');
  });

  test('the Validator\'s NOT_MET on a genuine run stays NOT_MET', async () => {
    const { persisted } = await receive(validation([testRun('T-06', { excerpt: FAILING })], { 12: ['T-06'] }, 'NOT_MET', '3 tests fail'),
      adapters([['double.run_tests', { outcome: 'OK', value: FAILING, excerpt: FAILING }]]));
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_MET');
  });

  test('cited with no verification result, it carries nothing', () => {
    assert.equal(verdictOf(validation([testRun('T-07')], { 12: ['T-07'] }), 12).verdict, 'NOT_VALIDATED');
  });
});

describe('invalid test evidence is not rescued by host inventory cited beside it', () => {
  test('an unreproducible run beside VERIFIED host.platform output leaves 12 NOT_VALIDATED', async () => {
    const { report, persisted } = await receive(
      validation([testRun('M-01', { reproducible: false }), inventory('M-02')], { 12: ['M-01', 'M-02'] }),
    );
    assert.equal(statusOf(report, 'M-02'), 'VERIFIED');
    assert.equal(verdictOf(persisted, 12).verdict, 'NOT_VALIDATED');
  });

  test('a mismatched run beside VERIFIED host.platform output leaves 9 NOT_VALIDATED', async () => {
    const { persisted } = await receive(
      validation([testRun('M-03'), inventory('M-04')], { 9: ['M-03', 'M-04'] }),
      adapters([['double.run_tests', { outcome: 'OK', value: FAILING, excerpt: FAILING }]]),
    );
    assert.equal(verdictOf(persisted, 9).verdict, 'NOT_VALIDATED');
  });

  test('a genuine run beside host.platform output still carries 12: inventory neither qualifies nor disqualifies', async () => {
    const { persisted } = await receive(validation([testRun('M-05'), inventory('M-06')], { 12: ['M-05', 'M-06'] }));
    assert.equal(verdictOf(persisted, 12).verdict, 'MET');
  });
});

describe('criteria that are not behavioural keep their prior rules', () => {
  test('host.platform output still carries criteria 5 and 17, which accept command', async () => {
    const { persisted } = await receive(validation([inventory('N-01')], { 5: ['N-01'], 17: ['N-01'] }));
    assert.equal(verdictOf(persisted, 5).verdict, 'MET');
    assert.equal(verdictOf(persisted, 17).verdict, 'MET');
  });

  test('a file quotation still carries criterion 2', async () => {
    const file = fx.evidence({ id: 'N-02', locator: { adapter: 'repo', op: 'read_file', args: { path: 'src/a.ts' } } });
    const registry = new FixtureAdapters({ files: [{ path: 'src/a.ts', content: 'export const a = 1;' }] });
    const { persisted } = await receive(validation([file], { 2: ['N-02'] }), registry);
    assert.equal(verdictOf(persisted, 2, registry).verdict, 'MET');
  });
});

describe('the model-free probe: the real composed adapters, host.platform, the fix profile', () => {
  const worlds: ScratchWorld[] = [];
  after(() => { for (const world of worlds) world.destroy(); });

  test('genuine host.platform output replays VERIFIED and no longer makes criterion 9 or 12 MET', async () => {
    const world = scratchWorld([{ path: 'README.md', content: '# probe\n' }]);
    worlds.push(world);
    const built = await buildKernel({
      stateRoot: world.stateRoot,
      repositoryPath: world.repositoryPath,
      env: {},
      substrate: new ScriptedSubstrate([]),
    });
    const registry = built.ports.adapters;
    assert.equal(registry.evidenceKind('host', 'platform'), 'command');
    assert.equal(registry.executesTests('host', 'platform'), false);

    const honest = inventory('P-01', 'platform', { excerpt: `${platform()} ${sep} ${EOL === '\r\n' ? 'crlf' : 'lf'}` });
    const { report, persisted } = await receive(validation([honest], { 9: ['P-01'], 12: ['P-01'] }), registry);
    assert.equal(statusOf(report, 'P-01'), 'VERIFIED');
    assert.equal(verdictOf(persisted, 9, registry).verdict, 'NOT_VALIDATED');
    assert.equal(verdictOf(persisted, 12, registry).verdict, 'NOT_VALIDATED');
  });
});

describe('the kernel judges 9 and 12 with its adapter registry\'s test-execution registration (Prompt 13)', () => {
  const kernelPolicies = policiesWithReadOnlyValidation();
  const destroy: (() => void)[] = [];
  after(() => { for (const fn of destroy) fn(); });

  const readme = fx.evidence({
    id: 'E-01',
    locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
    ref: 'README.md',
    excerpt: README_CONTENT,
  });

  function withCall(envelope: HandoffEnvelope): ScriptedResponse {
    return { kind: 'CALLS_THEN_ENVELOPE', calls: [{ tool: 'repo__read_file', args: { path: 'README.md' } }], envelope: () => envelope };
  }

  /**
   * A read-only STORY run whose Validator cites `cited` for 9 and 12, and what COMPLETION first computed.
   * With repository and git access a STORY binds to internal-capability, which includes both; the
   * route-back that follows (criterion 5 is critical and unsupplied) is not followed.
   */
  async function completed(cited: Evidence, registered: FixtureAdapterOptions) {
    const h = harness({
      policies: kernelPolicies,
      adapters: { files: [{ path: 'README.md', content: README_CONTENT }], ...registered },
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope({ type: fx.factAssertion('STORY', { evidence: [readme], probe: 'resolution' }) }) },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope({ next_action: { proposed_stage: 'VALIDATION', proposed_agent: 'validator', rationale: 'the cause is established' } })),
        withCall(fx.envelope({
          envelope_id: 'env_validation',
          agent: 'validator',
          stage_in: 'VALIDATION',
          outputs: { layer_verdicts: 'inline', not_validated_statement: 'inline', capability_trace: 'inline' },
          coverage: fx.coverage({ scope_examined: ['README.md'] }),
          evidence: [cited],
          dod_verdicts: [9, 12].map((criterion) => fx.criterionVerdict({ criterion: criterion as DodCriterionId, evidence: [cited.id] })),
          next_action: { proposed_stage: 'COMPLETION', proposed_agent: 'orchestrator', rationale: 'validated' },
        })),
      ],
    });
    destroy.push(() => { h.destroy(); });
    const result = await new Kernel(h.ports).work({
      source: 'NATURAL_LANGUAGE',
      sourceLocator: { adapter: 'host.cli', op: 'read_invocation', args: { argv_index: 1 } },
      raw: 'Fix typo in README.',
      resolveIdentity: async () => ({ outcome: 'NOT_NAMED' }),
      rereadIntake: async () => ({ outcome: 'OK', raw: 'Fix typo in README.' }),
    });
    assert.ok(result.workItemId !== null && result.runId !== null);
    const computed = h.store.readRunLog(result.workItemId, result.runId).records.find((e) => e.event === 'dod_computed');
    assert.ok(computed !== undefined && computed.event === 'dod_computed', 'the run reached COMPLETION');
    assert.equal(computed.data.profile_id, 'internal-capability');
    const criterion = (id: number) => {
      const found = computed.data.criteria.find((c) => c.criterion === id);
      assert.ok(found !== undefined);
      assert.equal(found.supplied_by_envelope, 'env_validation', 'the Validator\'s verdict reached COMPLETION');
      return found;
    };
    return [criterion(9), criterion(12)] as const;
  }

  test('host inventory, VERIFIED, leaves 9 and 12 NOT_VALIDATED', async () => {
    for (const found of await completed(inventory('K-01'), registrations())) {
      assert.equal(found.verdict, 'NOT_VALIDATED');
      assert.match(found.reason ?? '', /K-01 is output of host\.platform, which is not registered as executing tests/);
    }
  });

  test('an operation no adapter registers cannot carry 9 or 12', async () => {
    const unknown = testRun('K-02', { locator: { adapter: 'ci', op: 'run_suite', args: {} } });
    for (const found of await completed(unknown, registrations())) assert.equal(found.verdict, 'NOT_VALIDATED');
  });

  test('a runner-named operation registered only as command output cannot carry 9 or 12', async () => {
    const named = testRun('K-03', { locator: { adapter: 'host', op: 'run_tests', args: { suite: 'unit' } } });
    for (const found of await completed(named, registrations())) {
      assert.equal(found.verdict, 'NOT_VALIDATED');
      assert.match(found.reason ?? '', /K-03 is output of host\.run_tests, which is not registered as executing tests/);
    }
  });

  test('the double registered as executing tests carries 9 and 12', async () => {
    for (const found of await completed(testRun('K-04'), registrations())) assert.equal(found.verdict, 'MET');
  });

  test('the same double, with the registry not attesting test execution, fails closed', async () => {
    for (const found of await completed(testRun('K-05'), registrations([], new Set()))) {
      assert.equal(found.verdict, 'NOT_VALIDATED');
      assert.match(found.reason ?? '', /K-05 is output of double\.run_tests, which is not registered as executing tests/);
    }
  });
});
