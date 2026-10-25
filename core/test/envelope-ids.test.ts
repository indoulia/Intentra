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
import { workItemSpend } from '../src/metering.js';
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
 * Prompt 7A, defect 2: an agent-chosen `envelope_id` the store cannot hold.
 *
 * The schema's id pattern admits `:` `@` `/` `#` and 256 characters; the store admits neither,
 * and refuses a second write under one id. Before this was checked on receipt, `putEnvelope`
 * threw out of `work()` with the dispatch's intent unanswered and no `run_ended`.
 */

const cleanup: (() => void)[] = [];
after(() => { for (const fn of cleanup) fn(); });

function rig(options: Parameters<typeof harness>[0] = {}) {
  const h = harness({ adapters: { files: [{ path: 'README.md', content: README_CONTENT }] }, ...options });
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

/** The usual run with ROOT_CAUSE answered first by `bad`, then by a valid envelope. */
function rootCauseRetried(bad: HandoffEnvelope): readonly ScriptedResponse[] {
  return [
    { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
    { kind: 'ENVELOPE', envelope: workflowEnvelope() },
    withCall(auditEnvelope()),
    withCall(bad),
    withCall(rootCauseEnvelope()),
    withCall(completionEnvelope()),
  ];
}

/** Overrides the scripted cost per dispatch, and can kill a chosen dispatch mid-flight. */
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

function runLog(h: ReturnType<typeof rig>, workItemId: string | null, runId: string | null): readonly Event[] {
  assert.ok(workItemId !== null && runId !== null, 'a run was started');
  return h.store.readRunLog(workItemId, runId).records;
}

function at<K extends Event['event']>(log: readonly Event[], kind: K, dispatchId?: string) {
  return log.filter((e): e is Extract<Event, { event: K }> => e.event === kind
    && (dispatchId === undefined || e.dispatch_id === dispatchId));
}

/** The dispatch that answered `stage` first, by its intent. */
function firstDispatchAt(log: readonly Event[], stage: string): string {
  const intent = at(log, 'dispatch_intent').find((e) => e.stage === stage);
  assert.ok(intent?.dispatch_id !== undefined && intent.dispatch_id !== null, `${stage} was dispatched`);
  return intent.dispatch_id;
}

describe('a stage envelope whose id the store cannot hold is a malformed envelope, retried', () => {
  const cases: readonly { readonly name: string; readonly id: string; readonly says: RegExp }[] = [
    { name: 'reused within the run', id: 'env_audit', says: /already used in this run/ },
    { name: 'reused with different case', id: 'ENV_AUDIT', says: /already used in this run/ },
    { name: 'an unsupported character', id: 'env:1', says: /store-safe/ },
    { name: 'one character over the store maximum', id: `e${'x'.repeat(128)}`, says: /store-safe/ },
  ];

  for (const { name, id, says } of cases) {
    test(`${name}: rejected before persistence, then a fresh dispatch answers`, async () => {
      const h = rig({ script: rootCauseRetried(rootCauseEnvelope({ envelope_id: id })) });
      const result = await new Kernel(h.ports).work(start());
      const log = runLog(h, result.workItemId, result.runId);

      const rejectedAt = firstDispatchAt(log, 'ROOT_CAUSE');
      const [rejected] = at(log, 'envelope_rejected', rejectedAt);
      assert.equal(rejected?.data.step, 'schema');
      assert.equal(rejected?.data.violations[0]?.code, 'SCHEMA_INVALID');
      assert.match(rejected?.data.violations[0]?.message ?? '', says);

      const [answer] = at(log, 'dispatch_result', rejectedAt);
      assert.equal(answer?.data.outcome, 'FAILED');
      assert.equal(answer?.data.failure_reason, 'MALFORMED_ENVELOPE');
      assert.deepEqual(answer?.data.cost, { input_tokens: 1000, output_tokens: 100, usd: 0.05 });

      const retries = at(log, 'dispatch_intent').filter((e) => e.stage === 'ROOT_CAUSE');
      assert.equal(retries.length, 2, 'retried once');
      assert.notEqual(retries[1]?.dispatch_id, rejectedAt, 'the retry is a new dispatch');
      assert.equal(retries[1]?.data.attempt, 2);
      assert.equal(at(log, 'dispatch_result', retries[1]?.dispatch_id ?? '')[0]?.data.envelope_id, 'env_root_cause');

      assert.equal(at(log, 'run_ended').length, 1, 'the run ended with its record');
      assert.ok(result.workItemId !== null && result.runId !== null);
      const original = h.store.getEnvelope(result.workItemId, result.runId, 'env_audit');
      assert.equal(original?.stage_in, 'AUDIT', 'the accepted envelope under the reused id is untouched');
      assert.equal(original?.evidence[0]?.verification?.status, 'VERIFIED');
    });
  }

  test('an id of exactly the store maximum is accepted', async () => {
    const id = `e${'x'.repeat(127)}`;
    const h = rig({ script: rootCauseRetried(rootCauseEnvelope({ envelope_id: id })) });
    const result = await new Kernel(h.ports).work(start());
    const log = runLog(h, result.workItemId, result.runId);
    assert.equal(at(log, 'envelope_rejected').length, 0);
    assert.ok(at(log, 'envelope_received').some((e) => e.data.envelope_id === id));
  });

  test('every attempt reusing an id ends the run BLOCKED with its record, never a throw', async () => {
    const reused = rootCauseEnvelope({ envelope_id: 'env_audit' });
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(reused),
        withCall(reused),
        withCall(reused),
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.equal(result.outcome, 'BLOCKED');
    const log = runLog(h, result.workItemId, result.runId);
    const intents = at(log, 'dispatch_intent').filter((e) => e.stage === 'ROOT_CAUSE');
    assert.equal(intents.length, 3);
    assert.equal(new Set(intents.map((e) => e.dispatch_id)).size, 3, 'every retry has its own id');
    for (const intent of intents) {
      assert.equal(at(log, 'dispatch_result', intent.dispatch_id ?? '').length, 1, 'every intent is answered');
    }
    assert.equal(at(log, 'run_ended').length, 1);
  });
});

describe('a rejected envelope\'s cost is recorded as the substrate reported it', () => {
  test('a known cost counts toward the budget', async () => {
    const h = rig({ script: rootCauseRetried(rootCauseEnvelope({ envelope_id: 'env:1' })) });
    const costed = new Costed(h.ports.substrate as ScriptedSubstrate, () => 0.25);
    const result = await new Kernel({ ...h.ports, substrate: costed }).work(start());
    const log = runLog(h, result.workItemId, result.runId);
    const rejectedAt = firstDispatchAt(log, 'ROOT_CAUSE');
    assert.equal(at(log, 'dispatch_result', rejectedAt)[0]?.data.cost.usd, 0.25);
    const spend = spendOf(log.filter((e) => e.dispatch_id !== null));
    assert.equal(spend.reservedMicros, 0, 'nothing is held: every cost is known');
    assert.equal(spend.knownMicros, 250_000 * at(log.filter((e) => e.dispatch_id !== null), 'dispatch_result').length);
  });

  test('an unknown cost keeps the dispatch\'s whole reservation', async () => {
    const h = rig({ script: rootCauseRetried(rootCauseEnvelope({ envelope_id: 'env:1' })) });
    const first: { id: string | null } = { id: null };
    const costed = new Costed(h.ports.substrate as ScriptedSubstrate, (input) => {
      if (input.stage !== 'ROOT_CAUSE' || first.id !== null) return undefined;
      first.id = input.dispatch_id;
      return null;
    });
    const result = await new Kernel({ ...h.ports, substrate: costed }).work(start());
    const log = runLog(h, result.workItemId, result.runId);
    const rejectedAt = first.id;
    assert.ok(rejectedAt !== null);
    assert.equal(at(log, 'dispatch_result', rejectedAt)[0]?.data.cost.usd, null);
    const spend = spendOf(log.filter((e) => e.dispatch_id !== null));
    assert.equal(spend.reservedMicros, h.policies.budgets.cost.dispatch_usd * 1_000_000);
    assert.equal(spend.unknown.length, 1);
    assert.match(spend.unknown[0] ?? '', new RegExp(`^${rejectedAt} attempt 1 at ROOT_CAUSE`));
  });

  test('a dispatch killed after a rejection holds only its own reservation', async () => {
    const h = rig({ script: rootCauseRetried(rootCauseEnvelope({ envelope_id: 'env_audit' })) });
    let rootCauses = 0;
    const killing = new Costed(h.ports.substrate as ScriptedSubstrate, () => undefined, (input) => {
      if (input.stage !== 'ROOT_CAUSE') return false;
      rootCauses += 1;
      return rootCauses === 2;
    });
    await assert.rejects(new Kernel({ ...h.ports, substrate: killing }).work(start()), /killed mid-flight/);

    const [workItemId] = h.store.listWorkItems();
    assert.ok(workItemId !== undefined);
    const [runId] = h.store.listRuns(workItemId);
    assert.ok(runId !== undefined);
    const log = runLog(h, workItemId, runId);
    const intents = at(log, 'dispatch_intent').filter((e) => e.stage === 'ROOT_CAUSE');
    assert.equal(intents.length, 2);
    assert.equal(at(log, 'dispatch_result', intents[0]?.dispatch_id ?? '')[0]?.data.failure_reason, 'MALFORMED_ENVELOPE');

    const spend = workItemSpend(h.store, workItemId);
    assert.equal(spend.reservedMicros, h.policies.budgets.cost.dispatch_usd * 1_000_000);
    assert.equal(spend.unknown.length, 1);
    assert.match(spend.unknown[0] ?? '', new RegExp(`^${intents[1]?.dispatch_id ?? '-'} attempt 2 at ROOT_CAUSE \\(seq \\d+\\): no result`));
    assert.equal(spend.knownMicros, 50_000 * (spend.attempts - 1), 'every answered attempt, the rejected one included, is known');
  });
});

describe('the prologue\'s two save sites refuse an unusable id the same way', () => {
  function contextAnswer(envelopeId: string): ScriptedResponse {
    return withCall(fx.envelope({
      envelope_id: envelopeId,
      agent: 'context-discovery',
      stage_in: 'CONTEXT_DISCOVERY',
      status: 'PARTIAL',
      coverage: fx.coverage({ scope_examined: ['README.md'], confidence: 'FACT' }),
      unknowns: [fx.unknownRecord({ id: 'U-context', blocks: [] })],
      dod_verdicts: [fx.criterionVerdict({
        criterion: 1, verdict: 'NOT_VALIDATED', reason: 'not judged in this test', evidence: [],
      })],
    }));
  }

  test('the context mandate: an unsafe id blocks the run with its record', async () => {
    const h = rig({
      script: [{ kind: 'ENVELOPE', envelope: resolutionEnvelope() }, contextAnswer('env/context')],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.equal(result.outcome, 'BLOCKED');
    assert.equal(result.blockerKind, 'EXTERNAL_DEPENDENCY');
    const log = runLog(h, result.workItemId, result.runId);
    const [rejected] = at(log, 'envelope_rejected').filter((e) => e.stage === 'CONTEXT_DISCOVERY');
    assert.match(rejected?.data.violations[0]?.message ?? '', /store-safe/);
    const [answer] = at(log, 'dispatch_result').filter((e) => e.stage === 'CONTEXT_DISCOVERY');
    assert.equal(answer?.data.failure_reason, 'MALFORMED_ENVELOPE');
    assert.equal(answer?.data.cost.usd, 0.05);
    assert.equal(at(log, 'run_ended').length, 1);
    assert.ok(result.workItemId !== null && result.runId !== null);
    assert.deepEqual(h.store.listEnvelopes(result.workItemId, result.runId), []);
  });

  test('the workflow dispatch: an id the context envelope holds is refused and the fallback applies', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        contextAnswer('env_context'),
        { kind: 'ENVELOPE', envelope: workflowEnvelope({}, { envelope_id: 'env_context' }) },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    const log = runLog(h, result.workItemId, result.runId);
    const [rejected] = at(log, 'envelope_rejected').filter((e) => e.stage === 'WORKFLOW_SELECTED');
    assert.match(rejected?.data.violations[0]?.message ?? '', /already used in this run/);
    const [answer] = at(log, 'dispatch_result').filter((e) => e.stage === 'WORKFLOW_SELECTED');
    assert.equal(answer?.data.failure_reason, 'MALFORMED_ENVELOPE');
    assert.ok(at(log, 'dispatch_intent').some((e) => e.stage === 'AUDIT'), 'the run continued on the fallback');
    assert.equal(at(log, 'run_ended').length, 1);
    assert.ok(result.workItemId !== null && result.runId !== null);
    assert.equal(h.store.getEnvelope(result.workItemId, result.runId, 'env_context')?.agent, 'context-discovery');
  });
});
