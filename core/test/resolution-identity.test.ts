import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtures as fx,
  type AgentSubstrate,
  type Event,
  type HandoffEnvelope,
  type InputPackage,
  type SubstrateResult,
  type ToolGrant,
  type ToolInvoker,
} from '@intentra/contracts';
import { Kernel, type StartInput } from '../src/kernel.js';
import { spendOf } from '../src/budgets.js';
import {
  auditEnvelope,
  completionEnvelope,
  harness,
  README_CONTENT,
  resolutionEnvelope,
  rootCauseEnvelope,
  workflowEnvelope,
  type ScriptedResponse,
  type ScriptedSubstrate,
} from './doubles.js';

/**
 * Prompt 7A, defect 4: every resolution session is its own dispatch.
 *
 * `d_res` stays the first attempt's id; each later attempt — a malformed answer's retry or a
 * rejected proposal's re-dispatch — is `d_res_<attempt>`, with the attempt counting on across
 * both. A proposal's evidence is replayed against its own session's calls and nobody else's.
 */

const cleanup: (() => void)[] = [];
after(() => { for (const fn of cleanup) fn(); });

function rig(script: readonly ScriptedResponse[]) {
  const h = harness({ adapters: { files: [{ path: 'README.md', content: README_CONTENT }] }, script });
  cleanup.push(() => { h.destroy(); });
  return h;
}

function withCall(envelope: HandoffEnvelope): ScriptedResponse {
  return {
    kind: 'CALLS_THEN_ENVELOPE',
    calls: [{ tool: 'repo__read_file', args: { path: 'README.md' } }],
    envelope: () => envelope,
  };
}

function start(): StartInput {
  return {
    source: 'NATURAL_LANGUAGE',
    sourceLocator: { adapter: 'host.cli', op: 'read_invocation', args: { argv_index: 1 } },
    raw: 'Fix typo in README.',
    resolveIdentity: async () => ({ outcome: 'NOT_NAMED' }),
    rereadIntake: async () => ({ outcome: 'OK', raw: 'Fix typo in README.' }),
  };
}

const MALFORMED: ScriptedResponse = { kind: 'FAILED', failure: 'MALFORMED_ENVELOPE', detail: 'not JSON' };

/** A proposal admission refuses: a scope with no bound. */
const UNBOUNDED_PROPOSAL = resolutionEnvelope({
  scope: { paths: ['**'], capabilities: [], repositories: ['subject'], confidence: 'FACT' },
});
const UNBOUNDED: ScriptedResponse = { kind: 'ENVELOPE', envelope: UNBOUNDED_PROPOSAL };

const ADMISSIBLE: ScriptedResponse = { kind: 'ENVELOPE', envelope: resolutionEnvelope() };

const AFTER_ADMISSION: readonly ScriptedResponse[] = [
  { kind: 'ENVELOPE', envelope: workflowEnvelope() },
  withCall(auditEnvelope()),
  withCall(rootCauseEnvelope()),
];

/** Overrides each dispatch's cost, and can kill a chosen one mid-flight. */
class Costed implements AgentSubstrate {
  readonly name = 'costed';

  constructor(
    private readonly inner: ScriptedSubstrate,
    private readonly usd: (input: InputPackage) => number | null | undefined,
    private readonly kill: (input: InputPackage) => boolean = () => false,
  ) {}

  conformance(grants: readonly ToolGrant[]) {
    return this.inner.conformance(grants);
  }

  async dispatch(input: InputPackage, invoker: ToolInvoker): Promise<SubstrateResult> {
    if (this.kill(input)) throw new Error('killed mid-flight');
    const result = await this.inner.dispatch(input, invoker);
    const usd = this.usd(input);
    return usd === undefined ? result : { ...result, cost: { ...result.cost, usd } };
  }
}

function prologue(h: ReturnType<typeof rig>): readonly Event[] {
  return h.store.readIntakeLog('in_0001').records;
}

function resolutionIntents(log: readonly Event[]) {
  return log
    .filter((e): e is Extract<Event, { event: 'dispatch_intent' }> => e.event === 'dispatch_intent')
    .filter((e) => e.stage === 'RESOLUTION')
    .map((e) => ({ id: e.data.input_package.dispatch_id, attempt: e.data.attempt }));
}

describe('each resolution session has its own dispatch id', () => {
  test('a rejected proposal is re-dispatched as d_res_2, attempt 2, and admitted', async () => {
    const h = rig([UNBOUNDED, ADMISSIBLE, ...AFTER_ADMISSION]);
    const result = await new Kernel(h.ports).work(start());
    assert.notEqual(result.workItemId, null, 'the second proposal was admitted');
    assert.deepEqual(resolutionIntents(prologue(h)), [
      { id: 'd_res', attempt: 1 },
      { id: 'd_res_2', attempt: 2 },
    ]);
  });

  test('a malformed answer is retried as d_res_2', async () => {
    const h = rig([MALFORMED, ADMISSIBLE, ...AFTER_ADMISSION]);
    const result = await new Kernel(h.ports).work(start());
    assert.notEqual(result.workItemId, null);
    assert.deepEqual(resolutionIntents(prologue(h)), [
      { id: 'd_res', attempt: 1 },
      { id: 'd_res_2', attempt: 2 },
    ]);
  });

  test('the attempt counts on across a rejected proposal, and the re-dispatch keeps its own retries', async () => {
    const h = rig([UNBOUNDED, MALFORMED, MALFORMED, ADMISSIBLE, ...AFTER_ADMISSION]);
    const result = await new Kernel(h.ports).work(start());
    assert.notEqual(result.workItemId, null, 'two malformed retries are still within the re-dispatch\'s allowance');
    assert.deepEqual(resolutionIntents(prologue(h)), [
      { id: 'd_res', attempt: 1 },
      { id: 'd_res_2', attempt: 2 },
      { id: 'd_res_3', attempt: 3 },
      { id: 'd_res_4', attempt: 4 },
    ]);
    const calls = h.substrate.dispatched.filter((p) => p.stage === 'RESOLUTION').map((p) => p.dispatch_id);
    assert.deepEqual(calls, ['d_res', 'd_res_2', 'd_res_3', 'd_res_4'], 'the agent is told its own id');
  });
});

describe('a proposal is verified against its own session\'s calls only', () => {
  test('a screenshot citing a call made in an earlier session is not confirmed by it', async () => {
    const screenshot = fx.evidence({
      id: 'S-01',
      kind: 'screenshot',
      locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
      ref: 'readme.png',
      excerpt: 'the README, as the agent says it looked',
    });
    const second = resolutionEnvelope();
    const h = rig([
      withCall(UNBOUNDED_PROPOSAL),
      {
        kind: 'ENVELOPE',
        envelope: {
          ...second,
          evidence: [...second.evidence, screenshot],
          findings: [fx.finding({ id: 'F-01', severity: 'HIGH', evidence: ['S-01'] })],
        },
      },
      ...AFTER_ADMISSION,
    ]);
    const result = await new Kernel(h.ports).work(start());

    const calls = prologue(h).filter((e) => e.event === 'adapter_call');
    assert.ok(calls.length > 0 && calls.every((e) => e.event === 'adapter_call' && e.data.dispatch_id === 'd_res'),
      'the only call was the first session\'s');
    const schema = result.checks.filter((c) => c.check === 'schema_and_confidence');
    assert.equal(schema.length, 2, 'both proposals reached admission');
    assert.match(schema[1]?.detail ?? '', /1 withdrawn as unconfirmed/);
  });
});

/**
 * Prompt 8, item 3: the resolution envelope goes through the same `verifyEvidence` as every
 * other envelope, so its MISMATCH and UNREPLAYABLE items are `evidence_integrity` events
 * "logged against the producing agent and model", each under the session that produced it.
 */
describe('a resolution envelope\'s evidence decisions are journalled against its own session', () => {
  /** A quotation of README.md that the file does not contain, behind a HIGH finding so it is always replayed. */
  function withFabricated(...ids: readonly string[]): HandoffEnvelope {
    const base = resolutionEnvelope();
    return {
      ...base,
      evidence: [
        ...base.evidence,
        ...ids.map((id) => fx.evidence({
          id,
          locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
          ref: 'README.md',
          excerpt: 'Intentra restores the namespace after every restart.',
        })),
      ],
      findings: [fx.finding({ id: 'F-01', severity: 'HIGH', evidence: [...ids] })],
    };
  }

  function integrity(log: readonly Event[]) {
    return log.filter((e): e is Extract<Event, { event: 'evidence_integrity' }> => e.event === 'evidence_integrity');
  }

  function modelOf(log: readonly Event[], dispatchId: string): string | undefined {
    return log
      .filter((e): e is Extract<Event, { event: 'dispatch_intent' }> => e.event === 'dispatch_intent')
      .find((e) => e.data.input_package.dispatch_id === dispatchId)?.data.input_package.model;
  }

  test('an accepted envelope with nothing fabricated has no integrity record, and its verification names its session', async () => {
    const h = rig([ADMISSIBLE, ...AFTER_ADMISSION]);
    const result = await new Kernel(h.ports).work(start());
    assert.notEqual(result.workItemId, null);
    assert.deepEqual(integrity(prologue(h)), []);
    const verification = prologue(h).find((e) => e.event === 'evidence_verification');
    assert.equal(verification?.dispatch_id, 'd_res');
    assert.equal(verification?.agent, 'context-discovery');
  });

  test('a downgraded envelope is admitted, and its one mismatch is recorded against d_res and its model', async () => {
    const h = rig([{ kind: 'ENVELOPE', envelope: withFabricated('E-02') }, ...AFTER_ADMISSION]);
    const result = await new Kernel(h.ports).work(start());
    assert.notEqual(result.workItemId, null, 'one mismatch is below the rejection threshold');

    const log = prologue(h);
    const records = integrity(log);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.dispatch_id, 'd_res');
    assert.equal(records[0]?.agent, 'context-discovery');
    assert.equal(records[0]?.stage, 'RESOLUTION');
    assert.deepEqual(records[0]?.data, {
      envelope_id: 'env_resolution',
      evidence_id: 'E-02',
      model: modelOf(log, 'd_res'),
      status: 'MISMATCH',
      downgraded_assertions: ['E-02'],
      demoted_findings: ['F-01'],
      envelope_rejected: false,
    });
    const demoted = log.filter((e) => e.event === 'contract_violation' && e.data.subject === 'F-01');
    assert.equal(demoted.length, 1, 'the FACT finding that lost its evidence is a contract violation');
    assert.equal(demoted[0]?.dispatch_id, 'd_res');
  });

  test('a rejected envelope\'s mismatches are recorded against d_res, and the re-dispatch\'s against d_res_2', async () => {
    const h = rig([
      { kind: 'ENVELOPE', envelope: withFabricated('E-02', 'E-03') },
      { kind: 'ENVELOPE', envelope: withFabricated('E-04') },
      ...AFTER_ADMISSION,
    ]);
    const result = await new Kernel(h.ports).work(start());
    assert.notEqual(result.workItemId, null, 'the re-dispatched proposal was admitted');

    const log = prologue(h);
    const bySession = integrity(log).map((e) => ({
      dispatch: e.dispatch_id, evidence: e.data.evidence_id, rejected: e.data.envelope_rejected, model: e.data.model,
    }));
    assert.deepEqual(bySession, [
      { dispatch: 'd_res', evidence: 'E-02', rejected: true, model: modelOf(log, 'd_res') },
      { dispatch: 'd_res', evidence: 'E-03', rejected: true, model: modelOf(log, 'd_res') },
      { dispatch: 'd_res_2', evidence: 'E-04', rejected: false, model: modelOf(log, 'd_res_2') },
    ]);
    const violations = log.filter((e) => e.event === 'contract_violation' && e.stage === 'RESOLUTION');
    assert.deepEqual(violations.map((e) => e.dispatch_id), ['d_res_2'],
      'a rejected envelope\'s violations are not merged; only the admitted one\'s are recorded');
  });

  test('a re-resolution\'s mismatch is recorded in the work item log against its own session', async () => {
    const misclassified = fx.envelope({
      envelope_id: 'env_misclassified',
      agent: 'auditor',
      stage_in: 'ROOT_CAUSE',
      status: 'BLOCKED',
      outputs: {},
      coverage: fx.coverage({ scope_examined: ['README.md'] }),
      blockers: [fx.blocker({
        kind: 'WORK_ITEM_MISCLASSIFIED',
        description: 'the feature this supposed defect is about was never built',
        needs: 're_resolution',
        evidence: [],
      })],
      next_action: null,
    });
    const h = rig([
      ADMISSIBLE,
      { kind: 'ENVELOPE', envelope: workflowEnvelope() },
      withCall(auditEnvelope()),
      withCall(misclassified),
      { kind: 'ENVELOPE', envelope: withFabricated('E-02') },
      { kind: 'ENVELOPE', envelope: workflowEnvelope() },
      withCall(auditEnvelope()),
      withCall(rootCauseEnvelope()),
      withCall(completionEnvelope()),
    ]);
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null);
    assert.equal(h.store.listRuns(result.workItemId).length, 2, 'the re-resolved proposal was admitted');
    assert.deepEqual(integrity(prologue(h)), [], 'the first resolution fabricated nothing');

    const log = h.store.readWorkItemLog(result.workItemId).records;
    const records = integrity(log);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.dispatch_id, 'd_res');
    assert.equal(records[0]?.agent, 'context-discovery');
    assert.equal(records[0]?.data.evidence_id, 'E-02');
    assert.equal(records[0]?.data.envelope_rejected, false);
    assert.equal(records[0]?.data.model, modelOf(log, 'd_res'));
  });
});

describe('spend stays paired, attempt by attempt', () => {
  test('every attempt\'s known cost counts once', async () => {
    const h = rig([UNBOUNDED, MALFORMED, ADMISSIBLE, ...AFTER_ADMISSION]);
    const costs: Record<string, number> = { d_res: 0.25, d_res_2: 0.5, d_res_3: 1 };
    const costed = new Costed(h.ports.substrate as ScriptedSubstrate, (input) => costs[input.dispatch_id]);
    await new Kernel({ ...h.ports, substrate: costed }).work(start());
    const spend = spendOf(prologue(h));
    assert.equal(spend.knownMicros, 1_750_000);
    assert.equal(spend.reservedMicros, 0);
    assert.equal(spend.attempts, 3);
  });

  test('a crash in a later attempt holds only that attempt\'s reservation', async () => {
    const h = rig([UNBOUNDED, ADMISSIBLE, ...AFTER_ADMISSION]);
    let resolutions = 0;
    const killing = new Costed(h.ports.substrate as ScriptedSubstrate, () => undefined, (input) => {
      if (input.stage !== 'RESOLUTION') return false;
      resolutions += 1;
      return resolutions === 2;
    });
    await assert.rejects(new Kernel({ ...h.ports, substrate: killing }).work(start()), /killed mid-flight/);

    const spend = spendOf(prologue(h));
    assert.equal(spend.knownMicros, 50_000, 'the first attempt\'s completed cost is kept');
    assert.equal(spend.reservedMicros, h.policies.budgets.cost.dispatch_usd * 1_000_000);
    assert.equal(spend.unknown.length, 1);
    assert.match(spend.unknown[0] ?? '', /^d_res_2 attempt 2 at RESOLUTION \(seq \d+\): no result was recorded$/);
  });
});
