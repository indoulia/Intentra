import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtures as fx,
  type Event,
  type FrozenGraph,
  type MutationEvent,
} from '@agentos/contracts';
import { loadPolicies } from '@agentos/policies';
import {
  applyReversals,
  decideRetry,
  interruptedBlastRadius,
  project,
  recover,
  runRecord,
} from '../src/recovery.js';
import { stageFromCursor, stagesRemaining } from '../src/entry-stage.js';
import { Journal } from '../src/journal.js';
import { FixedClock, FixtureAdapters, harness } from './doubles.js';

const policies = loadPolicies();
const NL = String.fromCharCode(10);

function graph(): FrozenGraph {
  const template = policies.templates.get('defect.standard');
  assert.ok(template !== undefined);
  return {
    template_id: template.template_id,
    template_version: template.version,
    entry: template.entry,
    stages: [...template.stages],
    edges: [...template.edges],
    excluded_stages: [],
    stage_mandates: {},
    risk_class: 'IRREVERSIBLE',
    dod_profile_default: 'fix',
  };
}

/** A log written through the real journal, so the events are the events the kernel writes. */
function writeLog(
  build: (journal: Journal) => void,
): { readonly harness: ReturnType<typeof harness>; readonly workItemId: string; readonly runId: string } {
  const h = harness();
  const workItemId = 'wi_c_recovery';
  const runId = 'run_20260904T100000Z_000001';
  h.store.putWorkItemProjection(fx.workItem({ work_item_id: workItemId }));
  h.store.createRun(workItemId, runId);
  const journal = Journal.open(h.store, h.clock, { workItemId, runId });
  build(journal);
  return { harness: h, workItemId, runId };
}

const cleanup: (() => void)[] = [];
after(() => {
  for (const fn of cleanup) fn();
});

function fixture(build: (journal: Journal) => void) {
  const made = writeLog(build);
  cleanup.push(() => { made.harness.destroy(); });
  return made;
}

/**
 * A mutation with a reversal, as a repository adapter emits one.
 *
 * `dispatch_id` lives on the mutation event itself rather than only on the log frame, which
 * is what lets recovery group mutations by the dispatch that performed them without trusting
 * anything an agent said.
 */
function reversible(overrides: Partial<MutationEvent> = {}): MutationEvent {
  return fx.mutationEvent({
    adapter: 'repo',
    op: 'write_file',
    target: 'src/session/store.ts',
    dispatch_id: 'd_0001',
    reversal: { op: 'restore_file', args: { path: 'src/session/store.ts', blob: 'abc123' } },
    ...overrides,
  });
}

/** A mutation declared non-reversible: an external write that cannot be taken back. */
function nonReversible(overrides: Partial<MutationEvent> = {}): MutationEvent {
  return fx.mutationEvent({
    adapter: 'pm',
    op: 'post_comment',
    target: 'jira:DEF-456#c1',
    dispatch_id: 'd_0001',
    reversal: null,
    ...overrides,
  });
}

/* ============================================================= projections ==== */

describe('the projection is a pure function of the log', () => {
  test('an empty log projects the pre-run state rather than throwing', () => {
    const projection = project([]);
    assert.equal(projection.graph, null);
    assert.equal(projection.currentStage, 'INTAKE_RECEIVED');
    assert.equal(projection.lastSeq, 0);
    assert.deepEqual(projection.interruptedDispatches, []);
  });

  test('the same prefix projects identically however many times it is replayed', () => {
    const made = fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('workflow_admitted', {
        graph: graph(), admissible_templates: ['defect.standard'], checks: [],
      });
      journal.run('entry_stage_computed', { entry_stage: 'AUDIT', walk: [] });
    });
    const events = made.harness.store.readRunLog(made.workItemId, made.runId).records;
    for (let cut = 0; cut <= events.length; cut += 1) {
      const prefix = events.slice(0, cut);
      const first = JSON.stringify(project(prefix));
      const second = JSON.stringify(project(prefix));
      assert.equal(first, second, `prefix of ${cut} event(s) projects identically`);
    }
  });

  test('the cursor is rebuilt from transitions, not carried in memory', () => {
    const made = fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('workflow_admitted', {
        graph: graph(), admissible_templates: ['defect.standard'], checks: [],
      });
      journal.run('entry_stage_computed', { entry_stage: 'AUDIT', walk: [] });
      journal.run('transition', {
        from: 'AUDIT', to: 'ROOT_CAUSE', trigger: 'envelope.COMPLETE', edge_kind: 'advance',
        proposed_by: null, proposed_stage: null, overridden: false, evidence: [],
      });
    });
    const projection = project(made.harness.store.readRunLog(made.workItemId, made.runId).records);
    assert.equal(projection.currentStage, 'ROOT_CAUSE');
    assert.equal(
      projection.cursor.find((c) => c.stage === 'AUDIT')?.state,
      'COMPLETED',
    );
    assert.equal(
      projection.cursor.find((c) => c.stage === 'ROOT_CAUSE')?.state,
      'ACTIVE',
    );
  });

  test('a COMPLETED_PRIOR stage is projected as skipped with its reality evidence', () => {
    const made = fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('workflow_admitted', {
        graph: graph(), admissible_templates: ['defect.standard'], checks: [],
      });
      journal.run('stage_marked_completed_prior', {
        marked_stage: 'IMPLEMENTATION',
        predicate: 'reality.implementation_present',
        evidence: ['E-git-1'],
        note: 'criteria remain NOT_VALIDATED',
      });
    });
    const projection = project(made.harness.store.readRunLog(made.workItemId, made.runId).records);
    assert.deepEqual([...projection.completedPriorStages], ['IMPLEMENTATION']);
    const entry = projection.cursor.find((c) => c.stage === 'IMPLEMENTATION');
    assert.equal(entry?.state, 'COMPLETED_PRIOR');
    assert.deepEqual([...(entry?.reality_evidence ?? [])], ['E-git-1']);
  });

  test('a dispatch with an intent and no result is projected as interrupted', () => {
    const made = fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('workflow_admitted', {
        graph: graph(), admissible_templates: ['defect.standard'], checks: [],
      });
      journal.run('dispatch_intent', {
        input_package: fx.inputPackage(), attempt: 1,
      }, { stage: 'IMPLEMENTATION', dispatchId: 'd_0001', agent: 'implementer' });
    });
    const projection = project(made.harness.store.readRunLog(made.workItemId, made.runId).records);
    assert.deepEqual([...projection.interruptedDispatches], ['d_0001']);
  });

  test('a dispatch with a result is not interrupted', () => {
    const made = fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('dispatch_intent', {
        input_package: fx.inputPackage(), attempt: 1,
      }, { stage: 'AUDIT', dispatchId: 'd_0001', agent: 'auditor' });
      journal.run('dispatch_result', {
        outcome: 'ENVELOPE', envelope_id: 'env_1', failure_reason: null, detail: 'the audit completed',
        cost: { input_tokens: 100, output_tokens: 50, usd: 0 },
      }, { stage: 'AUDIT', dispatchId: 'd_0001', agent: 'auditor' });
    });
    const projection = project(made.harness.store.readRunLog(made.workItemId, made.runId).records);
    assert.deepEqual(projection.interruptedDispatches, []);
  });

  test('mutations are grouped by the dispatch that performed them', () => {
    const made = fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('mutation', reversible(), { stage: 'IMPLEMENTATION', dispatchId: 'd_0001' });
      journal.run('mutation', reversible({ target: 'src/session/index.ts' }), {
        stage: 'IMPLEMENTATION', dispatchId: 'd_0001',
      });
      journal.run('mutation', reversible({ target: 'other.ts', dispatch_id: 'd_0002' }), {
        stage: 'IMPLEMENTATION', dispatchId: 'd_0002',
      });
    });
    const projection = project(made.harness.store.readRunLog(made.workItemId, made.runId).records);
    assert.equal(projection.mutationsByDispatch.get('d_0001')?.length, 2);
    assert.equal(projection.mutationsByDispatch.get('d_0002')?.length, 1);
    assert.deepEqual(
      [...interruptedBlastRadius(projection, 'd_0001')].sort(),
      ['src/session/index.ts', 'src/session/store.ts'],
    );
  });

  test('run.json is a projection, and a run with no graph has not started', () => {
    const made = fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
    });
    const projection = project(made.harness.store.readRunLog(made.workItemId, made.runId).records);
    assert.throws(
      () => runRecord(made.workItemId, made.runId, projection, new FixedClock()),
      /has not started/,
    );
  });

  test('run.json carries the frozen graph, so status needs no replay', () => {
    const made = fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('workflow_admitted', {
        graph: graph(), admissible_templates: ['defect.standard'], checks: [],
      });
      journal.run('entry_stage_computed', { entry_stage: 'AUDIT', walk: [] });
    });
    const projection = project(made.harness.store.readRunLog(made.workItemId, made.runId).records);
    const record = runRecord(made.workItemId, made.runId, projection, new FixedClock());
    assert.equal(record.run_id, made.runId);
    assert.equal(record.work_item_id, made.workItemId);
    assert.equal(record.graph.template_id, 'defect.standard');
    assert.equal(record.current_stage, 'AUDIT');
  });
});

/* ============================================ the stage that did not finish ==== */

/**
 * A stage the run *left* is completed. A stage the run *stopped at* is not.
 *
 * `BLOCKED` is semi-terminal and resumable, and the design's rule is that the pre-block stage
 * is recorded so the run resumes in place. Marking the `from` stage `COMPLETED` on the
 * escalation said the opposite: a stage that blocked — including one that never dispatched at
 * all, because no model was reachable — read as done, and every reader of the cursor then
 * pointed past it. `CANCELLED` has the same shape for the same reason.
 *
 * These tests exist because the whole suite passed both with and without that rule, which
 * means nothing was pinning it.
 */
describe('a stage the run blocked at is not a stage the run completed', () => {
  /** A log that reaches `stage` normally and then escalates out of it. */
  function stoppedAt(to: 'BLOCKED' | 'CANCELLED') {
    return fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('workflow_admitted', {
        graph: graph(), admissible_templates: ['defect.standard'], checks: [],
      });
      journal.run('entry_stage_computed', { entry_stage: 'AUDIT', walk: [] });
      journal.run('transition', {
        from: 'AUDIT', to: 'ROOT_CAUSE', trigger: 'envelope.COMPLETE', edge_kind: 'advance',
        proposed_by: null, proposed_stage: null, overridden: false, evidence: [],
      });
      /*
       * ROOT_CAUSE never dispatched: no model was reachable, so there is no envelope and no
       * dispatch result. This is the case the rule is really about — the stage did not merely
       * fail to finish, it never ran.
       */
      journal.run('dispatch_result', {
        outcome: 'FAILED',
        envelope_id: null,
        failure_reason: 'NO_MODEL',
        detail: 'no reachable model meets the declared requirement',
        cost: { input_tokens: 0, output_tokens: 0 },
      }, { stage: 'ROOT_CAUSE', dispatchId: 'd_0002', agent: 'auditor' });
      journal.run('transition', {
        from: 'ROOT_CAUSE', to, trigger: 'EXTERNAL_DEPENDENCY', edge_kind: 'escalate',
        proposed_by: null, proposed_stage: null, overridden: false, evidence: [],
      });
    });
  }

  function projectionOf(made: ReturnType<typeof stoppedAt>) {
    return project(made.harness.store.readRunLog(made.workItemId, made.runId).records);
  }

  test('a run that blocks at a stage does not project that stage as COMPLETED', () => {
    const projection = projectionOf(stoppedAt('BLOCKED'));
    assert.equal(
      projection.cursor.find((c) => c.stage === 'ROOT_CAUSE')?.state,
      'ACTIVE',
      'the stage the run stopped at is where the run still is, not somewhere it has been',
    );
    assert.notEqual(
      projection.cursor.find((c) => c.stage === 'ROOT_CAUSE')?.state,
      'COMPLETED',
      'a stage that never dispatched has not completed, and the projection every recovery '
      + 'decision is rebuilt from must not say it did',
    );
    assert.equal(
      projection.cursor.find((c) => c.stage === 'AUDIT')?.state,
      'COMPLETED',
      'the stage the run genuinely left is still completed: the rule applies to the '
      + 'escalation, not to every transition',
    );
    assert.equal(projection.currentStage, 'BLOCKED');
    assert.equal(projection.preBlockStage, 'ROOT_CAUSE');
  });

  test('stageFromCursor after a block returns the stage that blocked, not the one after it', () => {
    const made = stoppedAt('BLOCKED');
    const projection = projectionOf(made);
    assert.equal(
      stageFromCursor(projection.cursor, graph()),
      'ROOT_CAUSE',
      'the run resumes in place. Reading the blocked stage as done leaves nothing ACTIVE and '
      + 'nothing PENDING, and the cursor then answers with a stage the run never reached',
    );
    assert.notEqual(
      stageFromCursor(projection.cursor, graph()),
      'COMPLETION',
      'which is what it answered while a blocked stage read as completed: the run would have '
      + 'resumed at COMPLETION, judging work that never happened',
    );
  });

  test('stagesRemaining after a block still contains the stage that blocked', () => {
    const projection = projectionOf(stoppedAt('BLOCKED'));
    const remaining = stagesRemaining(projection.cursor, graph());
    assert.ok(
      remaining.includes('ROOT_CAUSE'),
      'the stage still owes its outputs, so it is still outstanding',
    );
    assert.ok(
      !remaining.includes('AUDIT'),
      'and the stage the run really did leave is not',
    );
  });

  test('a blocked run resumes in place rather than a stage past the block', () => {
    /*
     * The whole point, stated as the recovery path states it: replay the log, rebuild the
     * cursor, and ask the cursor where the run was. Nothing re-derives the entry stage.
     */
    const made = stoppedAt('BLOCKED');
    const outcome = recover(
      made.harness.store, made.workItemId, made.runId, () => { /* no torn line */ },
    );
    const resumeAt = stageFromCursor(outcome.projection.cursor, graph());
    assert.equal(resumeAt, 'ROOT_CAUSE');
    assert.equal(
      resumeAt, outcome.projection.preBlockStage,
      'the cursor and the recorded pre-block stage agree, which is what makes "resume in '
      + 'place" one fact rather than two that can disagree',
    );
    assert.ok(stagesRemaining(outcome.projection.cursor, graph()).includes('ROOT_CAUSE'));
  });

  test('a cancelled run leaves the stage it stopped at unfinished too', () => {
    const projection = projectionOf(stoppedAt('CANCELLED'));
    assert.equal(
      projection.cursor.find((c) => c.stage === 'ROOT_CAUSE')?.state,
      'ACTIVE',
      'the run stopped at that stage, it did not finish it',
    );
    assert.equal(projection.currentStage, 'CANCELLED');
    assert.equal(
      stageFromCursor(projection.cursor, graph()), 'ROOT_CAUSE',
      'a cancelled run that is looked at afterwards says where it stopped',
    );
    assert.ok(stagesRemaining(projection.cursor, graph()).includes('ROOT_CAUSE'));
    assert.equal(
      projection.preBlockStage, null,
      'CANCELLED is not BLOCKED: there is no pre-block stage to resume from, which is why the '
      + 'cursor has to carry the truth on its own',
    );
  });

  test('COMPLETION -> COMPLETE still completes COMPLETION, so the rule does not over-apply', () => {
    /*
     * The guard on the other side. Only a stage genuinely left behind is `COMPLETED`, and
     * `COMPLETION -> COMPLETE` is exactly that: the stage really did finish. A rule that
     * marked every `from` stage `ACTIVE` would be as wrong in the other direction.
     */
    const made = fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('workflow_admitted', {
        graph: graph(), admissible_templates: ['defect.standard'], checks: [],
      });
      journal.run('transition', {
        from: 'COMPLETION', to: 'COMPLETE', trigger: 'envelope.COMPLETE', edge_kind: 'terminal',
        proposed_by: null, proposed_stage: null, overridden: false, evidence: [],
      });
    });
    const projection = projectionOf(made);
    assert.equal(
      projection.cursor.find((c) => c.stage === 'COMPLETION')?.state,
      'COMPLETED',
    );
    assert.equal(projection.currentStage, 'COMPLETE');
    assert.ok(
      !stagesRemaining(projection.cursor, graph()).includes('COMPLETION'),
      'a completed COMPLETION is not still outstanding',
    );
  });
});

/* ============================================================ retry policy ==== */

describe('what recovery does about an interrupted dispatch', () => {
  test('no mutation means a clean retry', () => {
    const decision = decideRetry([]);
    assert.equal(decision.decision, 'RETRY_CLEAN');
    assert.match(decision.reason, /nothing to reverse/);
  });

  test('reversible mutations are undone in reverse order, then re-dispatched', () => {
    const first = reversible({ target: 'a.ts' });
    const second = reversible({ target: 'b.ts' });
    const decision = decideRetry([first, second]);
    assert.equal(decision.decision, 'ROLLBACK_AND_RETRY');
    if (decision.decision !== 'ROLLBACK_AND_RETRY') throw new Error('unreachable');
    assert.deepEqual(
      decision.reversals.map((r) => r.mutation.target),
      ['b.ts', 'a.ts'],
      'the last mutation is undone first, because a later one may depend on an earlier one',
    );
    assert.match(decision.reason, /new dispatch_id/);
    assert.match(
      decision.reason,
      /Work-item keys are not refreshed/,
      'a retry gets fresh dispatch keys and the same work-item keys: that is the whole point',
    );
  });

  test('a non-reversible mutation is never automatically retried', () => {
    const decision = decideRetry([reversible(), nonReversible()]);
    assert.equal(decision.decision, 'BLOCK_NON_REVERSIBLE');
    if (decision.decision !== 'BLOCK_NON_REVERSIBLE') throw new Error('unreachable');
    assert.deepEqual([...decision.performed], ['pm.post_comment on jira:DEF-456#c1']);
    assert.match(
      decision.reason,
      /stating precisely what already happened/,
      'the block says what happened rather than that something did',
    );
  });

  test('one non-reversible mutation among many blocks the whole dispatch', () => {
    const decision = decideRetry([
      reversible({ target: 'a.ts' }),
      nonReversible(),
      reversible({ target: 'b.ts' }),
    ]);
    assert.equal(
      decision.decision,
      'BLOCK_NON_REVERSIBLE',
      'partially reversing and retrying would repeat the irreversible half',
    );
  });

  test('reversals go through the adapters, and a failure is reported rather than assumed', async () => {
    const adapters = new FixtureAdapters({
      extraOperations: [
        fx.operationDescriptor({
          adapter: 'repo', op: 'restore_file', description: 'restore a file from a blob',
        }),
      ],
    });
    const applied = await applyReversals(
      adapters,
      {
        workItemId: 'wi_c_recovery',
        runId: 'run_1',
        dispatchId: 'd_0001',
        mandate: { in_scope: ['src/session/**'], out_of_scope: [] },
        grantsHeld: [],
        stageMutating: true,
      },
      [{ mutation: reversible(), op: 'restore_file' }],
    );
    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.reversal_op, 'restore_file');
    assert.ok(applied[0]?.outcome === 'REVERSED' || applied[0]?.outcome === 'FAILED');
  });

  test('a mutation with no reversal cannot be reversed, and says so', async () => {
    const applied = await applyReversals(
      new FixtureAdapters(),
      {
        workItemId: 'wi_c_recovery',
        runId: 'run_1',
        dispatchId: 'd_0001',
        mandate: { in_scope: ['**'], out_of_scope: [] },
        grantsHeld: [],
        stageMutating: true,
      },
      [{ mutation: nonReversible(), op: '' }],
    );
    assert.equal(applied[0]?.outcome, 'FAILED');
    assert.equal(applied[0]?.reversal_op, '');
  });
});

/* =============================================================== the replay ==== */

describe('replaying a log off disk', () => {
  test('a complete log replays to the state it recorded', () => {
    const made = fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('workflow_admitted', {
        graph: graph(), admissible_templates: ['defect.standard'], checks: [],
      });
      journal.run('entry_stage_computed', { entry_stage: 'AUDIT', walk: [] });
      journal.run('dispatch_intent', {
        input_package: fx.inputPackage(), attempt: 1,
      }, { stage: 'AUDIT', dispatchId: 'd_0001', agent: 'auditor' });
    });
    let discarded = 0;
    const outcome = recover(
      made.harness.store, made.workItemId, made.runId,
      (bytes) => { discarded += bytes; },
    );
    assert.equal(discarded, 0);
    assert.equal(outcome.discardedBytes, 0);
    assert.equal(outcome.replayedEvents, 4);
    assert.equal(outcome.interruptedDispatch, 'd_0001');
    assert.equal(outcome.retry?.decision, 'RETRY_CLEAN');
  });

  test('a torn final line is discarded, the discard is reported, and the log is repaired', () => {
    const made = fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('workflow_admitted', {
        graph: graph(), admissible_templates: ['defect.standard'], checks: [],
      });
    });
    const log = made.harness.store.runLog(made.workItemId, made.runId);
    log.appendRawForTest('{"seq":3,"at":"2026-09-04T10:14:00Z","event":"transi');

    const discards: { bytes: number; text: string }[] = [];
    const outcome = recover(
      made.harness.store, made.workItemId, made.runId,
      (bytes, text) => { discards.push({ bytes, text }); },
    );
    assert.equal(discards.length, 1, 'the discard is itself reported, never silent');
    assert.ok((discards[0]?.bytes ?? 0) > 0);
    assert.match(discards[0]?.text ?? '', /transi/);
    assert.equal(outcome.replayedEvents, 2, 'the torn line is not replayed as an event');

    /* And the repair is durable: a second recovery finds nothing left to discard. */
    const second = recover(
      made.harness.store, made.workItemId, made.runId, () => { throw new Error('discarded twice'); },
    );
    assert.equal(second.discardedBytes, 0);
    assert.equal(second.replayedEvents, 2);
  });

  test('an interrupted dispatch that mutated non-reversibly blocks on recovery', () => {
    const made = fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('workflow_admitted', {
        graph: graph(), admissible_templates: ['defect.standard'], checks: [],
      });
      journal.run('dispatch_intent', {
        input_package: fx.inputPackage(), attempt: 1,
      }, { stage: 'IMPLEMENTATION', dispatchId: 'd_0001', agent: 'implementer' });
      journal.run('mutation', nonReversible(), {
        stage: 'IMPLEMENTATION', dispatchId: 'd_0001',
      });
    });
    const outcome = recover(made.harness.store, made.workItemId, made.runId, () => undefined);
    assert.equal(outcome.interruptedDispatch, 'd_0001');
    assert.equal(outcome.retry?.decision, 'BLOCK_NON_REVERSIBLE');
  });

  test('the mutation event exists before the envelope does, which is what makes this recoverable', () => {
    /*
     * The dispatch crashed after mutating and before returning anything. There is no envelope
     * and there never will be, and the log still knows exactly what happened — because
     * adapters emit the mutation event at call time rather than the agent reporting it after.
     */
    const made = fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('workflow_admitted', {
        graph: graph(), admissible_templates: ['defect.standard'], checks: [],
      });
      journal.run('dispatch_intent', {
        input_package: fx.inputPackage(), attempt: 1,
      }, { stage: 'IMPLEMENTATION', dispatchId: 'd_0001', agent: 'implementer' });
      journal.run('mutation', reversible(), { stage: 'IMPLEMENTATION', dispatchId: 'd_0001' });
    });
    const outcome = recover(made.harness.store, made.workItemId, made.runId, () => undefined);
    assert.deepEqual(outcome.projection.envelopeIds, []);
    assert.equal(outcome.retry?.decision, 'ROLLBACK_AND_RETRY');
    if (outcome.retry?.decision !== 'ROLLBACK_AND_RETRY') throw new Error('unreachable');
    assert.deepEqual(
      outcome.retry.reversals.map((r) => r.mutation.target),
      ['src/session/store.ts'],
    );
  });

  test('recovery of a log with no events at all is not a crash', () => {
    const made = fixture(() => undefined);
    const outcome = recover(made.harness.store, made.workItemId, made.runId, () => undefined);
    assert.equal(outcome.replayedEvents, 0);
    assert.equal(outcome.interruptedDispatch, null);
    assert.equal(outcome.retry, null);
  });

  test('a log line that is valid JSON but not a valid event is rejected, not projected', () => {
    const made = fixture((journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
    });
    const log = made.harness.store.runLog(made.workItemId, made.runId);
    log.appendRawForTest(`{"seq":2,"event":"not_an_event_kind","at":"2026-09-04T10:14:00Z"}${NL}`);
    const outcome = recover(made.harness.store, made.workItemId, made.runId, () => undefined);
    assert.ok(
      outcome.rejectedLines.length > 0,
      'a line the contract does not admit is reported rather than replayed',
    );
    assert.equal(outcome.replayedEvents, 1);
  });
});

/* =========================================== the property the plan asks for ==== */

describe('recovery is a pure function of the log', () => {
  /**
   * Exit test 5. Replay any prefix of any fixture log twice and get identical projections.
   * `state/test/store.test.ts` asserts the same property over the store; this asserts it over
   * a log the kernel's own journal wrote, with every event kind the kernel emits.
   */
  const LOGS: readonly (readonly [string, (journal: Journal) => void])[] = [
    ['a run that never got past admission', (journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
    }],
    ['a run mid-audit', (journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('workflow_admitted', {
        graph: graph(), admissible_templates: ['defect.standard'], checks: [],
      });
      journal.run('entry_stage_computed', { entry_stage: 'AUDIT', walk: [] });
      journal.run('dispatch_intent', {
        input_package: fx.inputPackage(), attempt: 1,
      }, { stage: 'AUDIT', dispatchId: 'd_0001', agent: 'auditor' });
    }],
    ['a run that mutated, transitioned and blocked', (journal) => {
      journal.run('run_started', {
        run_id: 'run_20260904T100000Z_000001', holder: 'operator@example.com', reason: 'NEW',
      });
      journal.run('workflow_admitted', {
        graph: graph(), admissible_templates: ['defect.standard'], checks: [],
      });
      journal.run('entry_stage_computed', { entry_stage: 'AUDIT', walk: [] });
      journal.run('stage_marked_completed_prior', {
        marked_stage: 'ROOT_CAUSE',
        predicate: 'reality.stage_completed_previously',
        evidence: ['E-ledger-1'],
        note: 'criteria remain NOT_VALIDATED',
      });
      journal.run('mutation', reversible({ dispatch_id: 'd_0002' }), {
        stage: 'IMPLEMENTATION', dispatchId: 'd_0002',
      });
      journal.run('transition', {
        from: 'AUDIT', to: 'ROOT_CAUSE', trigger: 'envelope.COMPLETE', edge_kind: 'advance',
        proposed_by: null, proposed_stage: null, overridden: false, evidence: [],
      });
      journal.run('run_ended', { outcome: 'BLOCKED', detail: 'a fixture ending' });
    }],
  ];

  for (const [name, build] of LOGS) {
    test(`${name}: every prefix replays identically`, () => {
      const made = fixture(build);
      const events: readonly Event[] = made.harness.store
        .readRunLog(made.workItemId, made.runId).records;
      for (let cut = 0; cut <= events.length; cut += 1) {
        const prefix = events.slice(0, cut);
        assert.equal(
          JSON.stringify(project(prefix), replacer),
          JSON.stringify(project([...prefix]), replacer),
          `prefix of ${cut}`,
        );
      }
    });

    test(`${name}: replaying the whole log twice yields one projection`, () => {
      const made = fixture(build);
      const events = made.harness.store.readRunLog(made.workItemId, made.runId).records;
      assert.equal(
        JSON.stringify(project(events), replacer),
        JSON.stringify(project(events), replacer),
      );
    });
  }
});

/** Maps are not JSON-serializable, so they are flattened for the comparison. */
function replacer(_key: string, value: unknown): unknown {
  return value instanceof Map ? Object.fromEntries(value) : value;
}
