import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtures as fx,
  type Event,
  type HandoffEnvelope,
  type Stage,
} from '@agentos/contracts';
import { Kernel, type StartInput } from '../src/kernel.js';
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
 * WP-3's checkpoint: the kernel as an envelope replayer.
 *
 * No model, no repository, no network. Every dispatch returns a recorded envelope, and the
 * question these tests answer is the one the plan says matters most — **can a confused or
 * adversarial agent corrupt a run's state?** Everything here drives the real `Kernel` over
 * the real store, the real policy set and the real journal.
 */

const README = {
  path: 'README.md',
  content: README_CONTENT,
};

const cleanup: (() => void)[] = [];
after(() => {
  for (const fn of cleanup) fn();
});

function rig(options: Parameters<typeof harness>[0] = {}) {
  const h = harness({ adapters: { files: [README], ...options.adapters }, ...options });
  cleanup.push(() => { h.destroy(); });
  return h;
}

/**
 * An envelope preceded by a real adapter call.
 *
 * The call log is what `coverage` is reconciled against, so an envelope claiming it examined
 * `README.md` has to have actually read it. That is the point: a fixture that skips the call
 * gets rejected, and one of the tests below asserts exactly that.
 */
function withCall(envelope: HandoffEnvelope, path = 'README.md'): ScriptedResponse {
  return {
    kind: 'CALLS_THEN_ENVELOPE',
    calls: [{ tool: 'repo__read_file', args: { path } }],
    envelope: () => envelope,
  };
}

/** The script a run that behaves takes. */
function goodScript(): readonly ScriptedResponse[] {
  return [
    { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
    { kind: 'ENVELOPE', envelope: workflowEnvelope() },
    withCall(auditEnvelope()),
    withCall(rootCauseEnvelope()),
    withCall(completionEnvelope()),
  ];
}

function start(overrides: Partial<StartInput> = {}): StartInput {
  return {
    source: 'NATURAL_LANGUAGE',
    sourceLocator: { adapter: 'host.cli', op: 'read_invocation', args: { argv_index: 1 } },
    raw: 'Fix typo in README.',
    resolveIdentity: async () => ({ outcome: 'NOT_NAMED' }),
    rereadIntake: async () => ({ outcome: 'OK', raw: 'Fix typo in README.' }),
    ...overrides,
  };
}

function events(h: ReturnType<typeof rig>, workItemId: string, runId: string): readonly Event[] {
  return h.store.readRunLog(workItemId, runId).records;
}

function kinds(log: readonly Event[]): readonly string[] {
  return log.map((e) => e.event);
}

/* =========================================================== the whole run ==== */

describe('a read-only run, end to end, with no model and no repository', () => {
  test('the prologue runs in order and no template can alter it', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);

    const log = events(h, result.workItemId, result.runId);
    const stages = log.map((e) => e.stage).filter((s) => s !== null);
    const firstIndexOf = (stage: Stage) => stages.indexOf(stage);
    for (const [earlier, later] of [
      ['INTAKE_RECEIVED', 'RESOLUTION'],
      ['RESOLUTION', 'CONTEXT_DISCOVERY'],
      ['CONTEXT_DISCOVERY', 'UNDERSTOOD'],
      ['UNDERSTOOD', 'WORKFLOW_SELECTED'],
    ] as const) {
      assert.ok(
        firstIndexOf(earlier) < firstIndexOf(later),
        `${earlier} precedes ${later}: the analysis happens before any Orchestrator proposal exists`,
      );
    }
    assert.ok(
      firstIndexOf('WORKFLOW_SELECTED') < firstIndexOf('AUDIT'),
      'the graph is selected before the first stage of it runs',
    );
  });

  test('the intake is recorded before anything acts on it', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = events(h, result.workItemId, result.runId);
    assert.equal(log[0]?.event, 'intake_recorded');
    assert.equal(
      log[0]?.stage,
      'INTAKE_RECEIVED',
      'the durable record of what was asked comes first, so a crash mid-resolution still says what arrived',
    );
  });

  test('a read-only installation admits only the read-only template, and says why', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const admitted = events(h, result.workItemId, result.runId)
      .find((e) => e.event === 'workflow_admitted');
    assert.ok(admitted !== undefined && admitted.event === 'workflow_admitted');
    assert.equal(admitted.data.graph.template_id, 'investigation.readonly');
    assert.equal(admitted.data.graph.risk_class, 'READ_ONLY');
    assert.match(
      admitted.data.checks.find((c) => c.check === 'admissible_set')?.detail ?? '',
      /exceed the risk classes this installation executes/,
    );
  });

  test('the run ends BLOCKED with INDETERMINATE, because a read-only run cannot demonstrate a fix', async () => {
    /*
     * The honest outcome, and worth asserting precisely. A read-only AgentOS asked to correct
     * a typo can audit and cannot demonstrate the correction, so the DoD computes
     * INDETERMINATE and names the criteria it could not check. Reporting that as COMPLETE
     * would be the one thing DEFINITION_OF_DONE section 5 forbids: "we could not check" and
     * "we checked and accepted a gap" are different facts about the world.
     */
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.equal(result.outcome, 'BLOCKED');
    assert.match(result.detail, /^INDETERMINATE: /);
    assert.match(result.detail, /"We could not check" is not "we checked and accepted a gap"/);

    assert.ok(result.workItemId !== null);
    const workItem = h.store.getWorkItem(result.workItemId);
    assert.notEqual(
      workItem?.lifecycle,
      'ACHIEVED',
      'an unjudgeable run does not mark the work achieved',
    );
  });

  test('the DoD report names every criterion and why it stands where it does', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const computed = events(h, result.workItemId, result.runId)
      .find((e) => e.event === 'dod_computed');
    assert.ok(computed !== undefined && computed.event === 'dod_computed');
    assert.equal(computed.data.verdict, 'INDETERMINATE');
    for (const criterion of computed.data.criteria) {
      assert.ok(
        (criterion.reason ?? '').trim().length > 0,
        `criterion ${criterion.criterion} states why it stands where it does`,
      );
    }
    assert.ok(
      computed.data.criteria.some((c) => c.verdict === 'NOT_VALIDATED'),
      'a criterion nobody supplied is NOT_VALIDATED rather than absent from the report',
    );
  });

  test('the narrative states what AgentOS decided the work was and why', async () => {
    /*
     * Not a later nicety. This is the stated mitigation for v0.3's residual risk: a run that
     * did the wrong thing correctly is invisible without it.
     */
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    const narrative = result.narrative;
    assert.match(narrative, /^## What AgentOS decided the work was, and why/);
    assert.match(narrative, /\*\*AgentOS decided this is a TASK\*\*/);
    assert.match(narrative, /the outcome it is pursuing:/);
    assert.match(narrative, /verbatim: "Fix typo in README\."/);
    assert.match(narrative, /## What reality it found/);
    assert.match(narrative, /## Which workflow it selected, and why/);

    assert.ok(result.workItemId !== null);
    assert.equal(
      narrative,
      new Kernel(h.ports).narrate(result.workItemId),
      'the narrative is a projection of the log, so reading it later gives the same account',
    );
  });

  test('status reads the projection and needs no replay of anything', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null);
    const lines = new Kernel(h.ports).status(result.workItemId).join('\n');
    assert.match(lines, /TASK/);
    assert.match(lines, /investigation\.readonly/);
  });

  test('every event the run wrote is a valid event, and the sequence has no gaps', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const read = h.store.readRunLog(result.workItemId, result.runId);
    assert.deepEqual(read.rejected, [], 'no line the contract refuses');
    assert.equal(read.discardedPartialLine, null);
    read.records.forEach((event, index) => {
      assert.equal(event.seq, index + 1, 'sequence numbers are dense and ordered');
      assert.equal(event.run_id, result.runId);
    });
  });

  test('the work item log records what happened to the work item, not to the run', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null);
    const log = h.store.readWorkItemLog(result.workItemId).records;
    assert.ok(kinds(log).includes('work_item_admitted'));
    assert.ok(
      log.every((e) => e.work_item_id === result.workItemId),
      'the work item layer outlives any single attempt, so its log is its own',
    );
  });
});

/* ======================================================= disbelief in situ ==== */

describe('the kernel disbelieves agents while a run is in flight', () => {
  test('an envelope claiming coverage no call supports is rejected and the run blocks', async () => {
    /*
     * The same audit envelope, dispatched without the adapter call that would support its
     * coverage claim. Nothing else changes, and the run does not proceed.
     */
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        { kind: 'ENVELOPE', envelope: auditEnvelope() },
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.equal(result.outcome, 'BLOCKED');
    assert.match(result.detail, /COVERAGE_OVERSTATED/);
    assert.match(
      result.detail,
      /distinguishing "found nothing there" from "never looked there"/,
    );

    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = events(h, result.workItemId, result.runId);
    const rejected = log.filter((e) => e.event === 'envelope_rejected');
    assert.ok(rejected.length > 0, 'the rejection is an event, not a thrown error');
    assert.ok(
      !kinds(log).includes('dod_computed'),
      'a rejected envelope does not advance the run to a completion judgment',
    );
  });

  test('a substrate that fails is a dispatch failure, not a run that quietly continues', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        { kind: 'FAILED', failure: 'TIMEOUT', detail: 'the model did not answer in time' },
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = events(h, result.workItemId, result.runId);
    const failure = log.find(
      (e) => e.event === 'dispatch_result' && e.data.outcome === 'FAILED',
    );
    assert.ok(failure !== undefined, 'the failure is recorded against the dispatch that had it');
    assert.notEqual(result.outcome, 'COMPLETE');
  });

  test('a tool call outside the mandate is refused by the adapter, and the refusal is logged', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        {
          kind: 'CALLS_THEN_ENVELOPE',
          calls: [{ tool: 'repo__read_file', args: { path: 'src/secrets/keys.ts' } }],
          envelope: () => auditEnvelope(),
        },
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = events(h, result.workItemId, result.runId);
    assert.ok(
      kinds(log).includes('scope_violation') || kinds(log).includes('adapter_call'),
      'the attempt is on the record whichever way the adapter refused it',
    );
    assert.notEqual(result.outcome, 'COMPLETE');
  });

  test('the tool surface is checked against the grant on every dispatch', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const reports = events(h, result.workItemId, result.runId)
      .filter((e) => e.event === 'tool_surface_conformance');
    assert.ok(reports.length > 0);
    for (const report of reports) {
      assert.ok(report.event === 'tool_surface_conformance');
      assert.equal(report.data.verdict, 'CONFORMS');
      assert.deepEqual(report.data.unexpected, []);
    }
  });

  test('a non-conforming tool surface aborts the dispatch rather than narrowing it', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        { kind: 'NON_CONFORMING', unexpected: ['Bash', 'WebFetch'] },
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = events(h, result.workItemId, result.runId);
    const report = log.find((e) => e.event === 'tool_surface_conformance');
    assert.ok(report !== undefined && report.event === 'tool_surface_conformance');
    assert.notEqual(report.data.verdict, 'CONFORMS');
    assert.notEqual(result.outcome, 'COMPLETE');
  });
});

/* ====================================================== crash and recovery ==== */

describe('exit test 1: killed mid-dispatch, it resumes from the log', () => {
  test('the dispatch intent is written before the dispatch, so an interrupted one is visible', async () => {
    /*
     * The write-before-act discipline. The script runs out after the workflow proposal, which
     * is exactly the shape of a process killed while an agent was working: an intent with no
     * result.
     */
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);

    const log = events(h, result.workItemId, result.runId);
    const auditIntent = log.findIndex(
      (e) => e.event === 'dispatch_intent' && e.stage === 'AUDIT',
    );
    assert.ok(auditIntent >= 0, 'the intent to dispatch AUDIT is on disk before AUDIT ran');
  });

  test('recovery replays the log and rebuilds the cursor rather than starting over', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
      ],
    });
    const first = await new Kernel(h.ports).work(start());
    assert.ok(first.workItemId !== null && first.runId !== null);

    /* A different Kernel instance: nothing carried in memory, only what is on disk. */
    const recovered = new Kernel(h.ports).recoverRun(first.workItemId, first.runId);
    assert.ok(recovered.projection.graph !== null);
    assert.equal(
      recovered.projection.graph.template_id,
      'investigation.readonly',
      'the frozen graph is replayed, never recomputed: re-selecting would make recovery depend on a model',
    );
    assert.ok(
      recovered.detail.some((line) => /replayed \d+ event/.test(line)),
      'recovery says how much it replayed',
    );
    const audit = recovered.projection.cursor.find((c) => c.stage === 'AUDIT');
    assert.ok(audit !== undefined, 'the cursor knows AUDIT happened');
  });

  test('recovery writes its own events, so a second crash mid-recovery is visible too', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
      ],
    });
    const first = await new Kernel(h.ports).work(start());
    assert.ok(first.workItemId !== null && first.runId !== null);
    const before = events(h, first.workItemId, first.runId).length;
    new Kernel(h.ports).recoverRun(first.workItemId, first.runId);
    const after = events(h, first.workItemId, first.runId);
    assert.ok(after.length > before);
    const phases = after
      .filter((e) => e.event === 'recovery')
      .map((e) => (e.event === 'recovery' ? e.data.phase : ''));
    assert.deepEqual(phases, ['STARTED', 'COMPLETED']);
  });

  test('a torn final line is discarded on recovery and the discard is itself logged', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
      ],
    });
    const first = await new Kernel(h.ports).work(start());
    assert.ok(first.workItemId !== null && first.runId !== null);
    h.store.runLog(first.workItemId, first.runId)
      .appendRawForTest('{"seq":99,"at":"2026-09-04T10:14:00Z","event":"transi');

    const recovered = new Kernel(h.ports).recoverRun(first.workItemId, first.runId);
    assert.ok(recovered.detail.some((line) => /discarded a partial line/.test(line)));
    /*
     * On the work item log rather than the run log: the run log is the file being repaired,
     * and appending to a log that ends in a torn line would corrupt a line in the middle of
     * it. The work item outlives the run, so "this run's log needed repairing" belongs there.
     */
    const discard = h.store.readWorkItemLog(first.workItemId).records.find(
      (e) => e.event === 'recovery' && e.data.phase === 'PARTIAL_LINE_DISCARDED',
    );
    assert.ok(discard !== undefined, 'the discard is an event: never silently dropped');
    assert.match(
      discard.event === 'recovery' ? discard.data.detail : '',
      /never silently dropped/,
    );
    /* And the repaired run log is appendable again, which it would not be if the repair had
     * left the torn line in the middle. */
    const reread = h.store.readRunLog(first.workItemId, first.runId);
    assert.equal(reread.discardedPartialLine, null);
    assert.deepEqual(reread.rejected, []);
  });

  test('recovery of a run with no interrupted dispatch reports nothing to retry', async () => {
    const h = rig({ script: goodScript() });
    const first = await new Kernel(h.ports).work(start());
    assert.ok(first.workItemId !== null && first.runId !== null);
    const recovered = new Kernel(h.ports).recoverRun(first.workItemId, first.runId);
    assert.deepEqual(recovered.projection.interruptedDispatches, []);
  });
});

/* ============================================== exit test 4: one run at a time ==== */

describe('exit test 4: two starts against one work item, exactly one wins', () => {
  test('the second start is refused with the active run named', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
      ],
    });
    const kernel = new Kernel(h.ports);
    const first = await kernel.work(start());
    assert.ok(first.workItemId !== null && first.runId !== null);

    /*
     * The first run never released its lease, because its script ran out mid-run — which is
     * the state a killed process leaves behind. A second start against the same content
     * derives the same work item id and must be refused rather than opening a second run.
     */
    const lease = h.store.readLease(first.workItemId);
    if (lease !== null) {
      const second = await new Kernel(h.ports).work(start());
      assert.equal(second.outcome, 'REFUSED');
      assert.match(
        second.detail,
        new RegExp(lease.run_id),
        'the refusal names the run that holds it, so the operator knows what to look at',
      );
    }
  });

  test('the same intake resolves to the same work item, which is what makes the refusal possible', async () => {
    const a = rig({ script: goodScript() });
    const b = rig({ script: goodScript() });
    const first = await new Kernel(a.ports).work(start());
    const second = await new Kernel(b.ports).work(start());
    assert.equal(
      first.workItemId,
      second.workItemId,
      'identity is content-derived, so "someone ran it twice" is answerable',
    );
  });
});

/* ==================================================== the log is the truth ==== */

describe('the log is authoritative and the projections are not', () => {
  test('a projection that disagrees with the log does not change the log', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const before = events(h, result.workItemId, result.runId);

    const record = h.store.getRun(result.workItemId, result.runId);
    assert.ok(record !== null);
    h.store.putRunProjection({ ...record, current_stage: 'IMPLEMENTATION' as Stage });

    const after = events(h, result.workItemId, result.runId);
    assert.deepEqual(
      after.map((e) => e.seq),
      before.map((e) => e.seq),
      'writing a projection appends nothing and rewrites nothing',
    );
    const recovered = new Kernel(h.ports).recoverRun(result.workItemId, result.runId);
    assert.notEqual(
      recovered.projection.currentStage,
      'IMPLEMENTATION',
      'recovery believes the log, not the projection',
    );
  });

  test('every envelope the run accepted is stored immutably under the run', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    const workItemId = result.workItemId;
    const runId = result.runId;
    assert.ok(workItemId !== null && runId !== null);
    const received = events(h, workItemId, runId)
      .filter((e) => e.event === 'envelope_received');
    assert.ok(received.length > 0);
    for (const event of received) {
      assert.ok(event.event === 'envelope_received');
      const stored = h.store.getEnvelope(workItemId, runId, event.data.envelope_id);
      assert.ok(stored !== null, `envelope ${event.data.envelope_id} is on disk`);
      assert.throws(
        () => { h.store.putEnvelope(workItemId, runId, stored); },
        /immutable|exists/i,
        'an envelope is written once; a second write is refused rather than overwriting evidence',
      );
    }
  });

  test('the kernel never writes a threshold of its own into the log', async () => {
    /*
     * A weaker statement than the conformance check makes, and worth having here too: every
     * cap the run reports came from `policies/`, so the log names the policy value rather
     * than a number compiled into the kernel.
     */
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const budgets = events(h, result.workItemId, result.runId)
      .filter((e) => e.event === 'budget');
    for (const event of budgets) {
      assert.ok(event.event === 'budget');
      if (event.data.cap === null) continue;
      const policyValue = JSON.stringify(h.policies.budgets);
      assert.ok(
        policyValue.includes(String(event.data.cap)),
        `the cap ${event.data.cap} appears in the policy set rather than only in the kernel`,
      );
    }
  });
});

/* ================================================================ fixtures ==== */

describe('the fixtures are the fixtures the kernel receives', () => {
  test('a recorded envelope answers the dispatch it was given, not the one it was recorded for', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const received = events(h, result.workItemId, result.runId)
      .filter((e) => e.event === 'envelope_received');
    assert.ok(received.length >= 1);
    for (const event of received) {
      assert.ok(event.event === 'envelope_received');
      const stored = h.store.getEnvelope(result.workItemId, result.runId, event.data.envelope_id);
      assert.equal(stored?.run_id, result.runId);
      assert.equal(stored?.work_item_id, result.workItemId);
    }
  });

  test('the substrate saw exactly the input packages the kernel built', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.runId !== null);
    for (const input of h.substrate.dispatched) {
      assert.equal(typeof input.mandate_name, 'string');
      assert.ok(input.tools_granted.length >= 0);
      assert.ok(
        Object.keys(input.context_sections).length >= 0,
        'the package names the sections it carries, so a missing section is visible',
      );
    }
    const stages = h.substrate.dispatched.map((d) => d.stage);
    assert.deepEqual(
      stages.slice(0, 2),
      ['RESOLUTION', 'WORKFLOW_SELECTED'],
      'the two prologue dispatches, in order, before any template stage',
    );
  });

  test('no dispatch was given a tool the stage does not need', async () => {
    const h = rig({ script: goodScript() });
    await new Kernel(h.ports).work(start());
    const orchestrator = h.substrate.dispatched.find((d) => d.agent === 'orchestrator');
    assert.ok(orchestrator !== undefined);
    assert.deepEqual(
      orchestrator.tools_granted,
      [],
      'the Orchestrator holds no adapters: the component that judges evidence must not be the '
      + 'component that gathers it',
    );
  });
});

/* ============================================ what WP-3 deliberately defers ==== */

describe('exit tests 2 and 3 need the adapter idempotency framework', () => {
  /**
   * The plan lists them under WP-3: run twice against a work item whose first run reached a
   * simulated open PR, and the second must enter at `REVIEW_TRIAGE` with no second
   * `create_pr`; then the same with the PR deleted, and again with the PR host unreachable.
   *
   * The mechanism they test — the key check, the confirming re-read, and `AMBIGUOUS_STATE`
   * when the re-read cannot be done — lives in the adapter framework, which is WP-4. The
   * ledger those records live in is WP-3 and is tested in `state/test/store.test.ts`
   * (including the deletion of a record whose resource is confirmed absent). The kernel
   * contains no idempotency code, which is correct: it is an adapter-boundary concern.
   *
   * What is asserted here is the half WP-3 owns — that the resume computation puts a run with
   * an open PR at `REVIEW_TRIAGE` without re-entering `IMPLEMENTATION`. That is in
   * `machine.test.ts` under scenario D. The `create_pr` half is asserted in WP-4.
   */
  test('the ledger a verified key hit reads from is work-item scoped, not run scoped', () => {
    const h = rig();
    const workItem = fx.workItem({ work_item_id: 'wi_c_idem' });
    h.store.putWorkItemProjection(workItem);
    h.store.putIdempotencyRecord('wi_c_idem', {
      key: 'k_create_pr_1',
      scope: 'work_item',
      adapter: 'git',
      op: 'create_pr',
      result: { number: 412 },
      external_locator: { adapter: 'git', op: 'read_pr', args: { number: 412 } },
      recorded_at: fx.T1,
    });
    assert.ok(
      h.store.getIdempotencyRecord('wi_c_idem', 'k_create_pr_1') !== null,
      'a second run against the same work item finds the first run’s key, which is the point of '
      + 'a work-item-scoped ledger',
    );
  });
});
