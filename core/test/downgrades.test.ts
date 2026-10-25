import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx, type Event, type Evidence, type HandoffEnvelope } from '@intentra/contracts';
import { Kernel, type StartInput } from '../src/kernel.js';
import { narrate } from '../src/narrative.js';
import {
  auditEnvelope,
  completionEnvelope,
  harness,
  README_CONTENT,
  resolutionEnvelope,
  rootCauseEnvelope,
  workflowEnvelope,
  type ScriptedResponse,
} from './doubles.js';

/**
 * Prompt 7A, defect 3: what receipt downgraded or rejected is journalled with the events the
 * contract already has, while the agent's envelope is persisted as it arrived, with only the
 * verification results the kernel added.
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

const GENUINE = fx.evidence({
  id: 'E-01',
  locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
  ref: 'README.md',
  excerpt: README_CONTENT,
});

/** Declared unreproducible: never replayed, so it can carry no FACT. */
const UNREPRODUCIBLE = fx.evidence({
  id: 'E-02',
  locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
  ref: 'README.md',
  excerpt: 'what the agent remembers of the file',
  reproducible: false,
});

function fabricated(id: string): Evidence {
  return fx.evidence({
    id,
    locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
    ref: 'README.md',
    excerpt: 'Intentra is a payroll system.',
  });
}

function script(audits: readonly HandoffEnvelope[]): readonly ScriptedResponse[] {
  return [
    { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
    { kind: 'ENVELOPE', envelope: workflowEnvelope() },
    ...audits.map(withCall),
    withCall(rootCauseEnvelope()),
    withCall(completionEnvelope()),
  ];
}

async function run(audits: readonly HandoffEnvelope[]) {
  const h = rig(script(audits));
  const kernel = new Kernel(h.ports);
  const result = await kernel.work(start());
  assert.ok(result.workItemId !== null && result.runId !== null);
  const log = h.store.readRunLog(result.workItemId, result.runId).records;
  return { h, kernel, result, log, workItemId: result.workItemId, runId: result.runId };
}

function at<K extends Event['event']>(log: readonly Event[], kind: K, stage: string) {
  return log.filter((e): e is Extract<Event, { event: K }> => e.event === kind && e.stage === stage);
}

describe('a downgrade at receipt is journalled as a contract_violation', () => {
  const finding = fx.finding({ id: 'F-01', severity: 'LOW', confidence: 'FACT', evidence: ['E-02'] });
  const audit = auditEnvelope({ evidence: [GENUINE, UNREPRODUCIBLE], findings: [finding] });

  test('a FACT finding no VERIFIED item supports is recorded against its dispatch', async () => {
    const { log } = await run([audit]);
    const [received] = at(log, 'envelope_received', 'AUDIT');
    const violations = at(log, 'contract_violation', 'AUDIT');
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.dispatch_id, received?.dispatch_id, 'against the dispatch that produced it');
    assert.equal(violations[0]?.agent, 'auditor');
    assert.equal(violations[0]?.data.code, 'FACT_FINDING_WITHOUT_VERIFIED_EVIDENCE');
    assert.equal(violations[0]?.data.handled_as, 'DOWNGRADED');
    assert.equal(violations[0]?.data.subject, 'F-01');
  });

  test('the envelope is persisted as the agent sent it, with the kernel\'s verification results', async () => {
    const { h, workItemId, runId } = await run([audit]);
    const persisted = h.store.getEnvelope(workItemId, runId, 'env_audit');
    assert.ok(persisted !== null);
    assert.deepEqual(persisted.findings, [finding], 'the historical findings are not rewritten');
    assert.equal(persisted.evidence.find((e) => e.id === 'E-01')?.verification?.status, 'VERIFIED');
    assert.equal(persisted.evidence.find((e) => e.id === 'E-02')?.verification?.status, 'UNVERIFIABLE');
    const { verification: _e1, ...asSentE1 } = persisted.evidence[0] ?? GENUINE;
    assert.deepEqual(asSentE1, GENUINE, 'evidence is the agent\'s, plus the kernel-owned block');
  });

  test('the context mandate\'s downgrade is journalled the same way', async () => {
    const context = fx.envelope({
      envelope_id: 'env_context',
      agent: 'context-discovery',
      stage_in: 'CONTEXT_DISCOVERY',
      status: 'PARTIAL',
      coverage: fx.coverage({ scope_examined: ['README.md'], confidence: 'FACT' }),
      evidence: [GENUINE, UNREPRODUCIBLE],
      findings: [finding],
      unknowns: [fx.unknownRecord({ id: 'U-context', blocks: [] })],
      dod_verdicts: [fx.criterionVerdict({ criterion: 1, evidence: ['E-01'] })],
    });
    const h = rig([
      { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
      withCall(context),
      { kind: 'ENVELOPE', envelope: workflowEnvelope() },
      withCall(audit),
      withCall(rootCauseEnvelope()),
    ]);
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = h.store.readRunLog(result.workItemId, result.runId).records;
    const [violation] = at(log, 'contract_violation', 'CONTEXT_DISCOVERY');
    assert.equal(violation?.data.code, 'FACT_FINDING_WITHOUT_VERIFIED_EVIDENCE');
    assert.equal(violation?.data.subject, 'F-01');
    assert.deepEqual(h.store.getEnvelope(result.workItemId, result.runId, 'env_context')?.findings, [finding]);
  });

  test('the narrative reports the downgrade', async () => {
    const { kernel, workItemId } = await run([audit]);
    assert.match(kernel.narrate(workItemId), /contract violation FACT_FINDING_WITHOUT_VERIFIED_EVIDENCE: finding F-01/);
  });
});

describe('a demoted finding stays in the persisted envelope and leaves the integrity record', () => {
  test('evidence_integrity names it, and the envelope still carries it as sent', async () => {
    const demoted = fx.finding({ id: 'F-02', severity: 'HIGH', confidence: 'INFERENCE', evidence: ['F-E'] });
    const { h, log, workItemId, runId } = await run([
      auditEnvelope({ evidence: [GENUINE, fabricated('F-E')], findings: [demoted] }),
    ]);
    const [integrity] = at(log, 'evidence_integrity', 'AUDIT');
    assert.deepEqual(integrity?.data.demoted_findings, ['F-02']);
    assert.equal(integrity?.data.envelope_rejected, false);
    assert.deepEqual(h.store.getEnvelope(workItemId, runId, 'env_audit')?.findings, [demoted]);
  });
});

describe('an envelope rejected at the mismatch threshold leaves its integrity record', () => {
  test('every mismatch is journalled with envelope_rejected, and nothing of it is persisted', async () => {
    const twice = auditEnvelope({
      evidence: [fabricated('F-1'), fabricated('F-2')],
      dod_verdicts: [
        fx.criterionVerdict({ criterion: 3, evidence: ['F-1'] }),
        fx.criterionVerdict({ criterion: 4, evidence: ['F-2'] }),
      ],
    });
    const { h, log, workItemId, runId } = await run([twice, auditEnvelope()]);

    const [rejected] = at(log, 'envelope_rejected', 'AUDIT');
    assert.equal(rejected?.data.step, 'evidence_verification');
    const integrity = at(log, 'evidence_integrity', 'AUDIT').filter((e) => e.dispatch_id === rejected?.dispatch_id);
    assert.deepEqual(integrity.map((e) => e.data.evidence_id), ['F-1', 'F-2']);
    for (const event of integrity) {
      assert.equal(event.data.envelope_rejected, true);
      assert.equal(event.data.status, 'MISMATCH');
      assert.equal(event.data.envelope_id, 'env_audit');
      assert.equal(event.data.model, at(log, 'dispatch_intent', 'AUDIT')[0]?.data.input_package.model);
    }
    const [failed] = log.filter((e) => e.event === 'dispatch_result' && e.dispatch_id === rejected?.dispatch_id);
    assert.ok(failed?.event === 'dispatch_result' && failed.data.failure_reason === 'MALFORMED_ENVELOPE');

    const kept = h.store.getEnvelope(workItemId, runId, 'env_audit');
    assert.equal(kept?.evidence[0]?.id, 'E-01', 'only the retry\'s envelope was persisted');
    assert.match(
      narrate(log, null).text,
      /evidence F-1 came back MISMATCH.*The whole envelope was rejected/,
    );
  });
});
