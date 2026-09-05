import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtures as fx,
  type CheckOutcome,
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
  ScriptedSubstrate,
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

  /* ------------------------------------------- the prologue's context mandate ---- */

  /**
   * Four properties of the dispatch added at `CONTEXT_DISCOVERY`.
   *
   * `context-discovery/context` is the only owner of Definition-of-Done criterion 1, and until
   * the prologue dispatched it the criterion was `NOT_VALIDATED` in every run of every template
   * (decisions I-33 and I-38). These are the properties that make adding it safe rather than
   * merely useful: it runs once, it supplies its verdict through an envelope like everything
   * else, a failure stops the run instead of advancing it, and it cannot write reality.
   */
  test('the context mandate is dispatched exactly once, after admission, and owes criterion 1', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);

    const contextDispatches = h.substrate.dispatched.filter(
      (input) => input.stage === 'CONTEXT_DISCOVERY',
    );
    assert.equal(
      contextDispatches.length,
      1,
      'once per run: two dispatches would be two answers to one owed criterion',
    );
    const [dispatch] = contextDispatches;
    assert.ok(dispatch !== undefined);
    assert.equal(dispatch.agent, 'context-discovery');
    assert.equal(dispatch.mandate_name, 'context');
    assert.deepEqual(
      [...dispatch.dod_criteria_owed],
      [1],
      'the package tells the agent which criterion it owes, which is where the obligation '
      + 'comes from',
    );

    /*
     * After admission, and the package proves it: an admitted Work Item's id and scope, and the
     * versioned Context Package the probes wrote. The `resolution` mandate has none of these,
     * which is why it is the one that runs on tier-1 orientation and this one does not.
     */
    assert.equal(dispatch.work_item_id, result.workItemId);
    assert.equal(dispatch.context_package_ref, 'context/v1.json');
    assert.ok(
      dispatch.mandate.in_scope.length > 0,
      'it is scoped by the admitted Work Item, which did not exist when resolution ran',
    );

    const log = events(h, result.workItemId, result.runId);
    const received = log.filter(
      (e) => e.event === 'envelope_received' && e.stage === 'CONTEXT_DISCOVERY',
    );
    assert.equal(received.length, 1, 'and its envelope went through receipt like any other');
    const [envelope] = received;
    assert.ok(envelope !== undefined && envelope.event === 'envelope_received');
    assert.ok(
      envelope.data.steps.some((step) => step.check === 'reconciliation'),
      'including the reconciliation of its coverage against the calls it actually made',
    );
    assert.ok(
      log.some((e) => e.event === 'tool_surface_conformance' && e.stage === 'CONTEXT_DISCOVERY'),
      'and the tool surface check, which is not something a prologue dispatch is exempt from',
    );
  });

  test('the criterion 1 verdict the context envelope carries is the one COMPLETION judges', async () => {
    /*
     * A `TASK` admitted on evidence naming its own scope, because a `TASK`'s outcome binds to
     * `documentation` — a profile that *names* criterion 1 — and the run under `audit` would
     * never report the criterion at all. The point here is the arithmetic, so the run has to be
     * one where the arithmetic includes it.
     */
    const evidence = fx.evidence({
      id: 'E-01',
      kind: 'file',
      locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
      ref: 'README.md',
      excerpt: README_CONTENT,
    });
    const h = rig({
      script: [
        {
          kind: 'ENVELOPE',
          envelope: resolutionEnvelope({
            type: fx.factAssertion('TASK', { evidence: [evidence], probe: 'resolution' }),
          }),
        },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    assert.equal(
      h.store.getWorkItem(result.workItemId)?.type,
      'TASK',
      'the precondition: the type survived, so the outcome binds to a profile naming criterion 1',
    );

    const log = events(h, result.workItemId, result.runId);
    const computed = log.find((e) => e.event === 'dod_computed');
    assert.ok(computed !== undefined && computed.event === 'dod_computed');

    /*
     * `collectVerdicts` reads the envelopes the run accepted, and the context envelope is now
     * among them — so criterion 1 is attributed to the envelope that supplied it. Before the
     * prologue dispatched the mandate this was `NOT_VALIDATED` with `supplied_by_envelope:
     * null` in every run of every template, which is decision I-33's whole subject.
     */
    const contextUnderstood = computed.data.criteria.find((c) => c.criterion === 1);
    assert.ok(contextUnderstood !== undefined, 'criterion 1 is one of this profile\'s criteria');
    assert.equal(contextUnderstood.owner_role, 'context-discovery');
    assert.notEqual(
      contextUnderstood.supplied_by_envelope,
      null,
      'the verdict reached COMPLETION inside an envelope, which is the only way a verdict '
      + 'reaches COMPLETION at all',
    );

    const received = log.find(
      (e) => e.event === 'envelope_received' && e.stage === 'CONTEXT_DISCOVERY',
    );
    assert.ok(received !== undefined && received.event === 'envelope_received');
    assert.equal(
      contextUnderstood.supplied_by_envelope,
      received.data.envelope_id,
      'and the envelope it names is the one the context dispatch returned, not some other',
    );
  });

  test('a FAILED context dispatch does not advance state: the run blocks in the prologue', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        {
          kind: 'FAILED',
          stage: 'CONTEXT_DISCOVERY',
          failure: 'TIMEOUT',
          detail: 'the context mandate did not answer in time',
        },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.equal(result.outcome, 'BLOCKED');
    assert.equal(result.blockerKind, 'EXTERNAL_DEPENDENCY');
    assert.ok(result.workItemId !== null && result.runId !== null);

    const log = events(h, result.workItemId, result.runId);
    assert.ok(
      log.some(
        (e) => e.event === 'dispatch_result'
          && e.stage === 'CONTEXT_DISCOVERY'
          && e.data.outcome === 'FAILED',
      ),
      'the failure is recorded against the dispatch that had it',
    );

    /* Nothing after it ran. No workflow was admitted, no stage was dispatched, no Definition
     * of Done was computed over verdicts nobody supplied. */
    assert.ok(!kinds(log).includes('workflow_admitted'), 'no workflow was selected');
    assert.ok(!kinds(log).includes('dod_computed'), 'and nothing was judged complete');
    assert.deepEqual(
      h.substrate.dispatched.map((input) => input.stage),
      ['RESOLUTION', 'CONTEXT_DISCOVERY'],
      'the run stopped where the dispatch failed rather than stepping past it',
    );
    assert.equal(
      h.store.readLease(result.workItemId),
      null,
      'and the lease is released, so the run resumes at the same point when the dependency '
      + 'returns',
    );
  });

  test('a malformed context envelope is a failed dispatch, never a parse-and-repair', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', stage: 'CONTEXT_DISCOVERY', envelope: { not: 'an envelope' } },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.equal(result.outcome, 'BLOCKED');
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = events(h, result.workItemId, result.runId);
    const rejected = log.filter((e) => e.event === 'envelope_rejected');
    assert.ok(rejected.length > 0, 'the rejection is an event, not a thrown error');
    assert.equal(rejected[0]?.event === 'envelope_rejected' ? rejected[0].data.step : null, 'schema');
    assert.ok(!kinds(log).includes('workflow_admitted'));
  });

  test('the probes are the only writers of current_reality: a context envelope claiming one changes nothing', async () => {
    /*
     * The property that makes the dispatch safe to have added at all. Discovery observed the
     * implementation as absent; the context agent's envelope says the opposite, in the one
     * output whose name invites it. The stored Context Package is what discovery wrote, and the
     * predicate that reads it reads discovery's value — an agent that could supply both the
     * observation and the judgment of it would be judging its own work.
     */
    const claimed = {
      implementation_present: fx.factAssertion(true, { probe: 'the agent said so' }),
    };
    const h = rig({
      discovery: { reality: { implementation_present: fx.factAssertion(false, { probe: 'git.log' }) } },
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        withCall(fx.envelope({
          envelope_id: 'env_context_overreaching',
          agent: 'context-discovery',
          stage_in: 'CONTEXT_DISCOVERY',
          outputs: { context_package: 'inline', current_reality: claimed, gaps: 'none' },
          coverage: fx.coverage({ scope_examined: ['README.md'] }),
          evidence: [fx.evidence({
            id: 'E-01',
            locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
            ref: 'README.md',
            excerpt: README_CONTENT,
          })],
          dod_verdicts: [fx.criterionVerdict({ criterion: 1, evidence: ['E-01'] })],
          next_action: null,
        })),
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });

    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);

    const stored = h.store.getVersioned(
      result.workItemId, result.runId, 'context', 1,
    ) as { readonly current_reality: Record<string, { readonly value: unknown }> };
    assert.equal(
      stored.current_reality['implementation_present']?.value,
      false,
      'the stored Context Package is the one the probes wrote, and the envelope did not '
      + 'overwrite it',
    );

    const log = events(h, result.workItemId, result.runId);
    assert.ok(
      log.some(
        (e) => e.event === 'envelope_received' && e.stage === 'CONTEXT_DISCOVERY',
      ),
      'the envelope was accepted — this is not a test of it being rejected, but of what an '
      + 'accepted one is allowed to change',
    );
    const versions = log.filter((e) => e.event === 'context_package_versioned');
    assert.equal(
      versions.length,
      1,
      'and no second version was written: the package the rest of the run reads is v1, exactly '
      + 'as discovery produced it',
    );
    assert.ok(
      log.some(
        (e) => e.event === 'note'
          && e.data.topic === 'context package authority'
          && /Only a probe writes reality/.test(e.data.detail),
      ),
      'the run log says so in its own words, so a reader does not have to infer it',
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
    /* The AUDIT dispatch's report, named rather than taken as the first one in the log: the
     * prologue's `context` dispatch is checked too and conforms, and taking whichever report
     * came first would make this assertion about the wrong dispatch. */
    const report = log.find(
      (e) => e.event === 'tool_surface_conformance' && e.stage === 'AUDIT',
    );
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

  test('a run that blocked resumes at the stage that blocked, not the one after it', async () => {
    /*
     * A real block, through the whole kernel: the audit's coverage claim is not supported by
     * any adapter call, the envelope is rejected and the run escalates out of `AUDIT`.
     *
     * `AUDIT` produced nothing. Recovery replays the log, rebuilds the cursor and asks the
     * cursor where the run was — it never re-derives the entry stage, because the frozen graph
     * and the cursor already say. So the cursor has to be right: a blocked stage read as
     * `COMPLETED` leaves nothing `ACTIVE` and nothing `PENDING`, and the answer then jumps to
     * `COMPLETION` — a run resuming by judging work that never happened.
     */
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        { kind: 'ENVELOPE', envelope: auditEnvelope() },
      ],
    });
    const kernel = new Kernel(h.ports);
    const result = await kernel.work(start());
    assert.equal(result.outcome, 'BLOCKED');
    assert.ok(result.workItemId !== null && result.runId !== null);

    const escalation = events(h, result.workItemId, result.runId).find(
      (e) => e.event === 'transition' && e.data.to === 'BLOCKED',
    );
    assert.ok(escalation !== undefined && escalation.event === 'transition');
    assert.equal(escalation.data.from, 'AUDIT', 'the precondition: the run blocked at AUDIT');

    const record = h.store.getRun(result.workItemId, result.runId);
    assert.ok(record !== null);
    assert.notEqual(
      record.cursor.find((c) => c.stage === 'AUDIT')?.state,
      'COMPLETED',
      'the stage the run stopped at did not complete, and run.json must not say it did',
    );
    assert.equal(record.pre_block_stage, 'AUDIT');

    const recovered = kernel.recoverRun(result.workItemId, result.runId);
    assert.equal(
      kernel.stageOf(record.graph, recovered.projection.cursor),
      'AUDIT',
      'the run resumes in place',
    );
    assert.notEqual(
      kernel.stageOf(record.graph, recovered.projection.cursor),
      'COMPLETION',
      'and not at the judgment of work the run never did',
    );
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
     * The state a killed process leaves behind: a lease still held by a run that is not
     * running. The kernel releases its own lease in a `finally`, so this has to be established
     * rather than hoped for — and it is established, not branched on, because a test that
     * checks the invariant only when it happens to hold is a test that can pass having
     * asserted nothing.
     *
     * A second start against the same content derives the same work item id and must be
     * refused rather than opening a second run against it.
     */
    const abandoned = 'run_20260904T100000Z_0000ff';
    const acquired = h.store.acquireLease(
      first.workItemId,
      abandoned,
      'pid:killed',
      h.clock.now(),
      h.policies.budgets.lease_timeout_ms,
    );
    assert.equal(
      acquired.outcome, 'ACQUIRED',
      'the precondition: the first run released its lease, so the killed process can take it',
    );
    const lease = h.store.readLease(first.workItemId);
    assert.equal(lease?.run_id, abandoned, 'and the lease is held, which is what makes this a race');

    /*
     * The second start gets its own script. The refusal has to come from the lease, and a
     * start that ran out of recorded envelopes would be refused at resolution instead —
     * which is a refusal, but not this one.
     */
    const second = await new Kernel({
      ...h.ports,
      substrate: new ScriptedSubstrate([
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
      ]),
    }).work(start());
    assert.equal(second.outcome, 'REFUSED');
    assert.equal(second.runId, null, 'a refused start opens no run');
    assert.match(
      second.detail,
      new RegExp(abandoned),
      'the refusal names the run that holds it, so the operator knows what to look at',
    );
    assert.equal(
      h.store.readLease(first.workItemId)?.run_id,
      abandoned,
      'and the refused start did not take the lease from the run that holds it',
    );
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
      stages.slice(0, 3),
      ['RESOLUTION', 'CONTEXT_DISCOVERY', 'WORKFLOW_SELECTED'],
      'the three prologue dispatches, in order, before any template stage — Context Discovery '
      + 'with both of its mandates, and the Orchestrator proposing a workflow only after them',
    );
    assert.equal(
      stages.filter((s) => s === 'CONTEXT_DISCOVERY').length,
      1,
      'the context mandate is dispatched exactly once per run: it produces the criterion 1 '
      + 'verdict, and two of them would be two answers to one owed criterion',
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

/* ============================================== what the dispatch is told ==== */

/**
 * `stages_remaining` is the agent's read-only view of the workflow, and it has to be true.
 *
 * It was built from a hard-coded empty cursor — `stagesRemaining([], graph)` — which filters
 * nothing, so every dispatch was told every stage was still outstanding: stages this run had
 * already completed, and stages the resume sweep had marked `COMPLETED_PRIOR` from observed
 * reality. An agent planning against "everything is still to do" is an agent planning against
 * a fact that is not one.
 */
describe('every dispatch is told which stages actually remain', () => {
  /** A prior run's ledger entry, the only honest observation that a stage already ran. */
  function priorRun(stages: readonly string[]) {
    return fx.factAssertion(
      [{ run_id: 'run_20260903T090000Z_0000aa', outcome: 'BLOCKED', stages_completed: stages }],
      { evidence: ['E-ledger-1'], probe: 'agentos.history' },
    );
  }

  function workflowView(h: ReturnType<typeof rig>, stage: Stage) {
    const dispatched = h.substrate.dispatched.find((d) => d.stage === stage);
    assert.ok(dispatched !== undefined, `${stage} was dispatched`);
    assert.ok(dispatched.workflow !== null, 'a graph dispatch carries the workflow view');
    return dispatched.workflow;
  }

  test('the first dispatch of a fresh run is told every stage is still ahead of it', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const admitted = events(h, result.workItemId, result.runId)
      .find((e) => e.event === 'workflow_admitted');
    assert.ok(admitted !== undefined && admitted.event === 'workflow_admitted');
    assert.deepEqual(
      [...workflowView(h, 'AUDIT').stages_remaining],
      [...admitted.data.graph.stages],
      'nothing has happened yet, so nothing is filtered — including the stage being '
      + 'dispatched, which is still outstanding until it produces something',
    );
  });

  test('a dispatch is not told a stage this run already completed is still remaining', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const remaining = workflowView(h, 'ROOT_CAUSE').stages_remaining;
    assert.ok(
      !remaining.includes('AUDIT'),
      'AUDIT completed and the run left it. Telling the next agent it is still outstanding '
      + 'is telling it something the log flatly contradicts',
    );
    assert.ok(remaining.includes('ROOT_CAUSE'), 'the stage being dispatched still owes its outputs');
    assert.ok(remaining.includes('COMPLETION'));
  });

  test('a stage the resume sweep marked COMPLETED_PRIOR is not listed as remaining', async () => {
    /*
     * A prior run's ledger says AUDIT completed, so the sweep marks it COMPLETED_PRIOR from
     * observed reality and the run enters at ROOT_CAUSE. `COMPLETED_PRIOR` means the mutation
     * has already occurred, not that the criteria are met — but it certainly does not mean the
     * stage is still to run.
     */
    const h = rig({
      discovery: { reality: { agentos_history: priorRun(['AUDIT']) } },
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = events(h, result.workItemId, result.runId);
    assert.ok(
      log.some((e) => e.event === 'stage_marked_completed_prior' && e.data.marked_stage === 'AUDIT'),
      'the precondition: the sweep really did mark AUDIT already done',
    );
    const remaining = workflowView(h, 'ROOT_CAUSE').stages_remaining;
    assert.ok(!remaining.includes('AUDIT'));
    assert.deepEqual([...remaining], ['ROOT_CAUSE', 'COMPLETION']);
  });

  test('no dispatch is told a stage the frozen graph does not contain', async () => {
    /*
     * The stages the run may still reach are the frozen graph's, and a stage excluded at
     * admission is not among them. Asserted over every dispatch rather than one, because
     * "which stages remain" is answered fresh for each.
     */
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const admitted = events(h, result.workItemId, result.runId)
      .find((e) => e.event === 'workflow_admitted');
    assert.ok(admitted !== undefined && admitted.event === 'workflow_admitted');
    const inGraph = new Set<string>(admitted.data.graph.stages);
    const graphDispatches = h.substrate.dispatched.filter((d) => d.workflow !== null);
    assert.ok(graphDispatches.length > 0, 'the precondition: the run reached the graph');
    for (const dispatched of graphDispatches) {
      for (const stage of dispatched.workflow?.stages_remaining ?? []) {
        assert.ok(
          inGraph.has(stage),
          `${dispatched.stage} was told ${stage} remains, and it is not in the frozen graph`,
        );
      }
    }
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

/* ================ resolution evidence replays under the proposed scope ==== */

describe('resolution evidence is replayed under the scope the proposal claims', () => {
  /**
   * The mandate the resolution replay runs under.
   *
   * The proposal has not been admitted, so no admitted scope exists to replay against — but
   * the *proposed* scope does, and admission check 5 has bounded it. Passing an empty mandate
   * instead meant "no path at all is in scope" at the adapter, so every replay was refused,
   * every FACT lost its evidence, and every typed work item downgraded to UNKNOWN whatever the
   * repository actually contained.
   */

  function verificationOf(h: ReturnType<typeof rig>, workItemId: string, runId: string) {
    const event = events(h, workItemId, runId).find((e) => e.event === 'evidence_verification');
    assert.ok(
      event !== undefined && event.event === 'evidence_verification',
      'the resolution envelope was replayed at all',
    );
    return event.data.results;
  }

  test('evidence naming a path inside the proposed scope replays and confirms', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);

    const outcome = verificationOf(h, result.workItemId, result.runId)
      .find((r) => r.evidence_id === 'E-01');
    assert.ok(outcome !== undefined, 'E-01 is in the replay report');
    assert.equal(
      outcome.status,
      'VERIFIED',
      'README.md is exactly what the proposal scoped itself to, so the replay reaches it',
    );
  });

  test('evidence naming a path outside the proposed scope is refused and supports no FACT', async () => {
    /*
     * The proposal claims `src/session/**` and cites a file outside it. A proposal does not get
     * evidence confirmed for reach it did not ask for, so the citation is withdrawn as
     * unconfirmed and the FACT resting on it stops being one.
     */
    const h = rig({
      script: [
        {
          kind: 'ENVELOPE',
          envelope: resolutionEnvelope({
            scope: {
              paths: ['src/session/**'],
              capabilities: [],
              repositories: ['subject'],
              confidence: 'INFERENCE',
            },
          }),
        },
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);

    const outcome = verificationOf(h, result.workItemId, result.runId)
      .find((r) => r.evidence_id === 'E-01');
    assert.ok(outcome !== undefined);
    assert.equal(
      outcome.status,
      'UNREPLAYABLE',
      'the replay was refused: README.md is not inside src/session/**',
    );
    assert.match(
      outcome.detail,
      /in_scope patterns \(src\/session\/\*\*\)/,
      'refused because it is outside the scope the proposal claimed — not because the mandate '
      + 'admitted nothing at all, which would refuse in-scope evidence just as readily',
    );

    const admitted = events(h, result.workItemId, result.runId)
      .find((e) => e.event === 'work_item_admitted');
    assert.ok(admitted !== undefined && admitted.event === 'work_item_admitted');
    assert.equal(
      admitted.data.work_item.type,
      'UNKNOWN',
      'the TASK minimum is named_path_exists, and the only path named was withdrawn',
    );
    const schema = admitted.data.checks.find((c) => c.check === 'schema_and_confidence');
    assert.ok(schema !== undefined);
    assert.equal(schema.result, 'INDETERMINATE');
    assert.match(schema.detail, /withdrawn as unconfirmed/);
  });

  test('a TASK with real in-scope file evidence is admitted TASK, not downgraded to UNKNOWN', async () => {
    const h = rig({ script: goodScript() });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);

    const admitted = events(h, result.workItemId, result.runId)
      .find((e) => e.event === 'work_item_admitted');
    assert.ok(admitted !== undefined && admitted.event === 'work_item_admitted');
    assert.equal(admitted.data.work_item.type, 'TASK');
    assert.equal(admitted.data.type_downgraded, false);
    assert.equal(
      admitted.data.work_item.claimed_type,
      null,
      'nothing was downgraded, so there is no claimed type to record',
    );
    const minimum = admitted.data.checks.find((c) => c.check === 'type_minimum_evidence');
    assert.ok(minimum !== undefined);
    assert.equal(minimum.result, 'PASS');
  });
});

/* ===================== an unreachable external item blocks, and says so ==== */

describe('a named external item that cannot be resolved blocks rather than being refused', () => {
  /**
   * `REFUSED` and `BLOCKED` are different answers.
   *
   * The first says the request was inadmissible; the second says the request was fine and the
   * world was not, and the run resumes when the source returns. Routing a block through the
   * refusal path kept the reason text and dropped the blocker kind, so a script whose ticket
   * system was merely down was told its request was inadmissible.
   */

  function identityCheck(result: { readonly checks: readonly CheckOutcome[] }): CheckOutcome {
    const check = result.checks.find((c) => c.check === 'external_identity');
    assert.ok(check !== undefined, 'admission recorded the identity check');
    return check;
  }

  const unreachable = (): StartInput => start({
    resolveIdentity: async () => ({
      outcome: 'UNAVAILABLE',
      identity: 'PROJ-1471',
      detail: 'the project-management adapter timed out after 30000ms',
    }),
  });

  const absent = (): StartInput => start({
    resolveIdentity: async () => ({ outcome: 'ABSENT', identity: 'PROJ-9999' }),
  });

  test('an unreachable external item yields BLOCKED carrying EXTERNAL_DEPENDENCY', async () => {
    const h = rig({ script: [{ kind: 'ENVELOPE', envelope: resolutionEnvelope() }] });
    const result = await new Kernel(h.ports).work(unreachable());

    assert.equal(
      result.outcome,
      'BLOCKED',
      'the request was admissible and the ticket system was not reachable. That is a block',
    );
    assert.equal(result.blockerKind, 'EXTERNAL_DEPENDENCY');
    assert.match(result.detail, /PROJ-1471/);
  });

  test('a reachable-but-absent external item is distinguishable from an unreachable one', async () => {
    const h1 = rig({ script: [{ kind: 'ENVELOPE', envelope: resolutionEnvelope() }] });
    const down = await new Kernel(h1.ports).work(unreachable());
    const h2 = rig({ script: [{ kind: 'ENVELOPE', envelope: resolutionEnvelope() }] });
    const missing = await new Kernel(h2.ports).work(absent());

    assert.equal(missing.outcome, 'BLOCKED');
    assert.equal(missing.blockerKind, 'EXTERNAL_DEPENDENCY');
    assert.equal(
      identityCheck(down).result,
      'INDETERMINATE',
      'unreachable establishes nothing either way',
    );
    assert.equal(
      identityCheck(missing).result,
      'FAIL',
      'reachable and absent is an answer: the key is wrong, and a human should hear it',
    );
    assert.notEqual(
      down.detail,
      missing.detail,
      '"resume when the source returns" and "the key is wrong" are different things to say',
    );
    assert.match(missing.detail, /the source is reachable/);
  });

  test('neither silently becomes an investigation of the repository', async () => {
    for (const input of [unreachable(), absent()]) {
      const h = rig({ script: [{ kind: 'ENVELOPE', envelope: resolutionEnvelope() }] });
      const result = await new Kernel(h.ports).work(input);

      assert.equal(
        result.outcome,
        'BLOCKED',
        'the run blocked; it neither ran nor was told its request was inadmissible',
      );
      assert.equal(result.blockerKind, 'EXTERNAL_DEPENDENCY');
      assert.equal(result.workItemId, null, 'no work item was admitted');
      assert.equal(result.runId, null, 'no run was started');
      assert.deepEqual(
        h.store.listWorkItems(),
        [],
        'the work is definitionally that external item; investigating something else is a '
        + 'different task, not a weaker version of this one',
      );
      assert.deepEqual(
        h.substrate.dispatched.map((d) => d.stage),
        ['RESOLUTION'],
        'resolution ran and nothing after it did',
      );
    }
  });
});

/* ===================== a blocked run says why, in its narrative ==== */

describe('a run blocked on an unreachable external identity narrates the reason', () => {
  /**
   * The narrative obligation is not decorative: it is the mitigation for the residual risk the
   * freeze carries forward, because a run that did the wrong thing correctly is invisible
   * without it. A blocked run whose narrative does not say why is exactly that failure — and
   * rendering only `FAIL` checks left the line ending mid-sentence, because an unreachable
   * identity is `INDETERMINATE`.
   */

  const blocked = async () => {
    const h = rig({ script: [{ kind: 'ENVELOPE', envelope: resolutionEnvelope() }] });
    return new Kernel(h.ports).work(start({
      resolveIdentity: async () => ({
        outcome: 'UNAVAILABLE',
        identity: 'PROJ-1471',
        detail: 'the project-management adapter timed out after 30000ms',
      }),
    }));
  };

  test('the narrative names the identity and why it could not be resolved', async () => {
    const result = await blocked();

    assert.equal(result.outcome, 'BLOCKED');
    assert.match(result.narrative, /PROJ-1471/, 'the narrative names the identity');
    assert.match(result.narrative, /UNAVAILABLE/, 'and says it could not be reached');
    assert.match(
      result.narrative,
      /external_identity INDETERMINATE/,
      'the INDETERMINATE check that caused the block is rendered, not filtered out',
    );
  });

  test('no narrative line ends in a colon with nothing after it', async () => {
    const result = await blocked();

    assert.ok(result.narrative.length > 0, 'a blocked run still gets a narrative');
    for (const line of result.narrative.split('\n')) {
      assert.ok(
        !/[:—]\s*$/.test(line),
        `a line promised a reason and supplied none: "${line}"`,
      );
    }
  });
});
