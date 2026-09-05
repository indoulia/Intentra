import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtures as fx,
  type HandoffEnvelope,
  type InputPackage,
  type ModelEntry,
  type Registries,
  type SkillEntry,
  type ToolInvoker,
} from '@agentos/contracts';
import { RunStore } from '@agentos/state';
import { coordinateChildren } from '../../src/orchestration.js';
import { buildKernel } from '../../src/composition/index.js';
import { project } from '../../src/recovery.js';
import { README_CONTENT } from '../doubles.js';
import { scratchWorld, type ScratchWorld } from './world.js';
import {
  DECLARED_MODEL,
  assertNothingAdvanced,
  assertReadOnlyAndDurable,
  cli,
  completionVerdict,
  eventsOf,
  investigationScript,
  work,
} from './rig.js';
import { context, fileEvidence, investigationGraph, resolution } from './envelopes.js';

/**
 * Scenarios 17-20: things going wrong.
 *
 * The headers of the other two scenario files state what became of defects **D1** to **D5**,
 * and of the sixth — the prologue dispatching only one of Context Discovery's two mandates —
 * that the other five sat on top of. Nothing new is needed here; scenario 19 is the one place
 * where the *absence* of a defect was already the finding, because the no-model path is the
 * external dependency this build has always reported honestly all the way out to the CLI's
 * exit code.
 *
 * Two fixtures here are worth reading before the assertions, because the prologue growing a
 * dispatch is exactly the kind of change that quietly invalidates a recording:
 * `withdrawingRegistry` counts the prologue's *three* model selections rather than one, and
 * `killedMidDispatch` kills on the stage rather than on a dispatch number.
 */

const README = { path: 'README.md', content: README_CONTENT };

const worlds: ScratchWorld[] = [];
after(() => {
  for (const world of worlds) world.destroy();
});

function newWorld(): ScratchWorld {
  const world = scratchWorld([README]);
  worlds.push(world);
  return world;
}

/** The standard read-only investigation, over the scratch repository's one file. */
function investigation(title: string, outcome: string) {
  const evidence = fileEvidence('E-01', 'README.md', README_CONTENT);
  return investigationScript(
    investigationGraph({
      resolution: resolution({
        type: 'INVESTIGATION',
        intent: 'INVESTIGATE',
        title,
        desiredOutcome: outcome,
        scopePaths: ['README.md'],
        evidence: [evidence],
        cites: [],
      }),
      evidence: [evidence],
      paths: ['README.md'],
      cause: 'the documentation says one thing and the code says nothing at all',
    }),
    ['README.md'],
  );
}

/* ========================================================== 17. child failure ==== */

describe('scenario 17 — child failure (at the seam: CHILD_COORDINATION is unreachable in this build)', () => {
  /*
   * `epic.coordinate` is inadmissible under `mutation_enabled: false`, so `CHILD_COORDINATION`
   * is never entered end to end and this whole scenario is asserted against the kernel function
   * the stage calls. The rule under test is the one that decides whether one child's failure
   * stops the rest: a blocked child leaves its siblings running, and the Epic blocks only when
   * nothing at all can move.
   */
  const parent = () => fx.workItem({ work_item_id: 'wi_EPIC-9', type: 'EPIC', title: 'Sync' });

  test('at the seam: a blocked child does not block its siblings', () => {
    const outcome = coordinateChildren({
      parent: parent(),
      envelope: fx.envelope({ agent: 'orchestrator', stage_in: 'CHILD_COORDINATION' }),
      children: [
        { workItemId: 'wi_STORY-201', dependsOn: [], lifecycle: 'ACHIEVED' },
        { workItemId: 'wi_STORY-203', dependsOn: [], lifecycle: 'BLOCKED' },
        { workItemId: 'wi_STORY-202', dependsOn: [], lifecycle: 'EXECUTING' },
      ],
      outcomeAlreadySatisfied: 'FALSE',
    });

    assert.equal(
      outcome.epicBlocks,
      false,
      'one child blocked is not the Epic blocked; the Epic blocks only when nothing can move',
    );
    assert.ok(
      outcome.startable.length > 0,
      'the siblings that can progress are named, and they progress',
    );
  });

  test('at the seam: a child waiting on a dependency that is not terminal is not started', () => {
    const outcome = coordinateChildren({
      parent: parent(),
      envelope: fx.envelope({ agent: 'orchestrator', stage_in: 'CHILD_COORDINATION' }),
      children: [
        { workItemId: 'wi_STORY-203', dependsOn: [], lifecycle: 'BLOCKED' },
        { workItemId: 'wi_TASK-204', dependsOn: ['wi_STORY-203'], lifecycle: 'RESOLVED' },
      ],
      outcomeAlreadySatisfied: 'FALSE',
    });

    assert.ok(
      !outcome.startable.includes('wi_TASK-204'),
      'its dependency is not terminal, so the kernel does not start it',
    );
    const waiting = outcome.waiting.find((entry) => entry.workItemId === 'wi_TASK-204');
    assert.ok(waiting !== undefined, 'and it says what it is waiting on');
    assert.deepEqual(waiting.on, ['wi_STORY-203']);
  });

  test('at the seam: when no child can progress, the Epic blocks — and says that is the rarer condition', () => {
    const outcome = coordinateChildren({
      parent: parent(),
      envelope: fx.envelope({ agent: 'orchestrator', stage_in: 'CHILD_COORDINATION' }),
      children: [
        { workItemId: 'wi_STORY-203', dependsOn: [], lifecycle: 'BLOCKED' },
        { workItemId: 'wi_TASK-204', dependsOn: ['wi_STORY-203'], lifecycle: 'RESOLVED' },
        { workItemId: 'wi_TASK-205', dependsOn: ['wi_TASK-204'], lifecycle: 'RESOLVED' },
      ],
      outcomeAlreadySatisfied: 'FALSE',
    });

    assert.equal(outcome.epicBlocks, true);
    assert.match(
      outcome.detail,
      /a different and much rarer condition than a child being blocked, which leaves its siblings running/,
    );
  });
});

/* =========================================================== 18. cancellation ==== */

describe('scenario 18 — cancellation (at the seam: CHILD_COORDINATION is unreachable in this build)', () => {
  const cancelling = () => fx.envelope({
    agent: 'orchestrator',
    stage_in: 'CHILD_COORDINATION',
    proposals: {
      cancellation: {
        work_item_id: 'wi_STORY-202',
        to: 'SUPERSEDED',
        evidence: ['E-01'],
        rationale: 'the reconciliation this child existed for is now done elsewhere',
      },
    },
  });

  test('at the seam: a cancellation is admitted only where reality shows the outcome already holds', () => {
    const outcome = coordinateChildren({
      parent: fx.workItem({ work_item_id: 'wi_EPIC-9', type: 'EPIC' }),
      envelope: cancelling(),
      children: [{ workItemId: 'wi_STORY-202', dependsOn: [], lifecycle: 'EXECUTING' }],
      outcomeAlreadySatisfied: 'TRUE',
    });

    assert.ok(outcome.cancellation !== null);
    assert.equal(outcome.cancellation.outcome, 'ADMITTED');
    assert.equal(
      outcome.cancellation.outcome === 'ADMITTED' ? outcome.cancellation.to : null,
      'SUPERSEDED',
    );
    assert.match(
      outcome.cancellation.reason,
      /evaluates TRUE from adapter evidence, so the outcome this work item existed for observably already holds/,
    );
  });

  test('at the seam: "this turned out to be unnecessary" is never self-certified — an unproven cancellation escalates', () => {
    for (const observed of ['FALSE', 'INDETERMINATE'] as const) {
      const outcome = coordinateChildren({
        parent: fx.workItem({ work_item_id: 'wi_EPIC-9', type: 'EPIC' }),
        envelope: cancelling(),
        children: [{ workItemId: 'wi_STORY-202', dependsOn: [], lifecycle: 'EXECUTING' }],
        outcomeAlreadySatisfied: observed,
      });
      assert.ok(outcome.cancellation !== null);
      assert.equal(
        outcome.cancellation.outcome,
        'ESCALATED',
        `an outcome the runtime reports as ${observed} does not cancel a work item`,
      );
      assert.match(
        outcome.cancellation.reason,
        /exactly the claim that should not be self-certified/,
      );
    }
  });

  test('at the seam: an envelope proposing no cancellation produces none, rather than a default', () => {
    const outcome = coordinateChildren({
      parent: fx.workItem({ work_item_id: 'wi_EPIC-9', type: 'EPIC' }),
      envelope: fx.envelope({ agent: 'orchestrator', stage_in: 'CHILD_COORDINATION' }),
      children: [{ workItemId: 'wi_STORY-202', dependsOn: [], lifecycle: 'EXECUTING' }],
      outcomeAlreadySatisfied: 'TRUE',
    });
    assert.equal(
      outcome.cancellation,
      null,
      'the outcome holding is not itself a proposal to cancel anything',
    );
  });
});

/* ========================================================= 19. missing model ==== */

describe('scenario 19 — missing model', () => {
  test('end to end, through the real CLI: with no model at all the prologue refuses, and nothing was started to block', async () => {
    /*
     * This is the one scenario driven through `agentos work` itself, with no substitution
     * whatever — not even the substrate, because with no model selectable the substrate is
     * never reached. Every kernel function still runs: intake is recorded, tier-1 orientation
     * runs, the resolution dispatch is attempted and reports `NO_MODEL`.
     *
     * The distinction the CLI keeps, and the reason this is not a plain refusal: there is no
     * run to attach a blocker to, so the *kernel* refuses, and `reportRun` re-labels it
     * `BLOCKED` with `EXTERNAL_DEPENDENCY` because the condition is an external dependency and
     * not a judgment about the request.
     */
    const world = newWorld();
    /* `AGENTOS_MODELS` is not set in this process, so the host declares no model. */
    assert.equal(process.env['AGENTOS_MODELS'], undefined);

    const before = world.fingerprint();
    const result = await cli(world, ['work', '--repo', world.repositoryPath, 'Fix typo in README.']);
    const after = world.fingerprint();

    assert.equal(result.code, 10, 'exit 10 is blocked, and 11 would have been refused');
    assert.match(result.out, /^outcome {5}BLOCKED$/m);
    assert.match(result.out, /^blocker {5}EXTERNAL_DEPENDENCY$/m);
    assert.match(result.out, /no model available/);
    assert.match(
      result.out,
      /No work item was admitted and no run was started, so no state advanced; the same invocation resumes from here when a model returns/,
    );
    assert.match(result.out, /models {6}0 available of 0 enumerated/);

    /* The narrative is printed even here, which is what makes a refusal arguable. */
    assert.match(result.out, /## What AgentOS decided the work was, and why/);

    assert.equal(after.tree, before.tree, 'nothing was written to the repository');
    assert.equal(after.head, before.head);
    assert.equal(after.status, before.status);

    const listing = await cli(world, ['status']);
    assert.match(listing.out, /no work items under/, 'no state advanced');
  });

  test('end to end: a model withdrawn after admission blocks the run with EXTERNAL_DEPENDENCY, in place', async () => {
    /*
     * The other half, and it is a different fact about the world. The model is there when
     * resolution is dispatched and gone by the time the graph's first stage is, so a Work Item
     * *is* admitted and a run *is* started — and the run has something to attach a blocker to.
     */
    const world = newWorld();
    const outcome = await work({
      world,
      raw: 'Audit the restart path.',
      script: investigation('Restart path', 'the restart path is understood'),
      registries: withdrawingRegistry(),
    });

    const { narrative, status } = await assertReadOnlyAndDurable(world, outcome);

    assert.equal(outcome.result.outcome, 'BLOCKED');
    const failures = eventsOf(outcome.log, 'dispatch_result')
      .filter((event) => event.data.failure_reason === 'NO_MODEL');
    assert.ok(failures.length > 0, 'the dispatch reported NO_MODEL rather than inventing a model');
    assert.match(
      failures[0]?.data.detail ?? '',
      /Proceeding on an inadequate model and reporting the result as normal is a form of dishonesty/,
    );

    /* Blocked with the external dependency, at the stage it was trying to run. */
    assert.match(status.out, /blocked; the pre-block stage is AUDIT/);
    assert.match(narrative.out, /EXTERNAL_DEPENDENCY/);
    assert.notEqual(completionVerdict(outcome.log), 'COMPLETE');

    /* And nothing advanced past the stage that could not run. */
    const cursor = project(outcome.log).cursor;
    assert.ok(
      !cursor.some((entry) => entry.stage === 'ROOT_CAUSE' && entry.state === 'COMPLETED'),
      'no stage after the one that could not be dispatched was entered, let alone completed',
    );
  });

  test('end to end: with no model, every kernel function still runs and none of them corrupts anything', async () => {
    const world = newWorld();
    const outcome = await work({
      world,
      raw: 'Fix typo in README.',
      script: investigation('Fix typo in README', 'the misspelling is corrected'),
      models: [],
    });

    await assertNothingAdvanced(world, outcome);
    assert.equal(outcome.result.outcome, 'REFUSED');
    assert.match(outcome.result.detail, /no model available/);
    assert.equal(
      outcome.substrate.dispatched.length,
      0,
      'the substrate was never reached: selection failed before a dispatch was built',
    );

    /* The intake was still recorded, and the orientation still ran. Nothing was skipped. */
    assert.ok(
      outcome.built.framework.calls().length > 0,
      'discovery still observed what it could, so the refusal is informed rather than blind',
    );
  });
});

/* ============================================ 20. resume after interruption ==== */

describe('scenario 20 — resume after interruption', () => {
  const request = 'Audit how this repository handles restarts.';

  function script() {
    return investigation('Restart handling', 'how restarts are handled is established');
  }

  test('end to end: a dispatch killed mid-flight leaves an intent and no result, and recovery rebuilds the cursor from the log', async () => {
    /*
     * The kill. The substrate throws where a process would have died — after the kernel wrote
     * `dispatch_intent` and before any envelope came back — so the run log ends exactly where a
     * crashed run's log ends. Nothing is in memory afterwards: the assertions below read the
     * log from disk through a *second* `buildKernel`, which is the point.
     */
    const world = newWorld();
    const killed = await killedMidDispatch(world, request);

    const { workItemId, runId } = killed;
    const first = killed.built.store.readRunLog(workItemId, runId).records;

    const intents = eventsOf(first, 'dispatch_intent');
    const results = eventsOf(first, 'dispatch_result');
    assert.ok(intents.length > results.length, 'a dispatch was recorded and never answered');
    assert.equal(
      project(first).currentStage,
      'AUDIT',
      'the cursor rebuilt from the log sits at the stage that was running, not past it',
    );

    /* A fresh process. Nothing carried over but the state root. */
    const restarted = await buildKernel({
      stateRoot: world.stateRoot,
      repositoryPath: world.repositoryPath,
      env: { AGENTOS_MODELS: JSON.stringify([DECLARED_MODEL]) },
    });
    const recovered = restarted.kernel.recoverRun(workItemId, runId);

    assert.equal(
      recovered.projection.currentStage,
      'AUDIT',
      'the interrupted stage is re-entered in place, not stepped past',
    );
    assert.ok(
      recovered.detail.some((line) => /replayed \d+ event\(s\); the cursor is at AUDIT/.test(line)),
      `recovery replays the log rather than resuming from memory: ${recovered.detail.join(' | ')}`,
    );

    const after = restarted.store.readRunLog(workItemId, runId).records;
    const recovery = eventsOf(after, 'recovery');
    assert.ok(
      recovery.some((event) => event.data.phase === 'STARTED'),
      'the recovery itself is journalled, so a second crash during it is visible too',
    );
    assert.ok(
      recovery.some((event) => event.data.interrupted_dispatch !== null),
      'and the interrupted dispatch is named rather than inferred later',
    );
    assert.ok(
      recovery.some(
        (event) => /recovery replays the log rather than resuming from memory, and never re-derives the entry stage/
          .test(event.data.detail),
      ),
    );
  });

  test('end to end: a second run over the same work item resumes from AgentOS’s own ledger rather than starting over', async () => {
    /*
     * The other half of resumption, and the one a human would call "restarting it". The first
     * run completes `AUDIT` and `ROOT_CAUSE` and reaches `COMPLETION`; the second run against
     * the same request resolves to the same work item and computes its entry stage by reading
     * `reality.stage_completed_previously`, which is answered by `host.read_run_history` over
     * AgentOS's own ledger and by nothing else. Code existing does not mean an audit was run —
     * which is why the second run consults the ledger rather than the worktree, and why the
     * assertions below are about the ledger read and not about the outcome.
     */
    const world = newWorld();
    const first = await work({ world, raw: request, script: script() });
    await assertReadOnlyAndDurable(world, first);
    assert.equal(first.result.outcome, 'COMPLETE');

    const second = await work({ world, raw: request, script: script() });
    await assertReadOnlyAndDurable(world, second);

    assert.equal(
      second.result.workItemId,
      first.result.workItemId,
      'the same request is the same work item, so the second run is a resumption',
    );
    assert.notEqual(second.result.runId, first.result.runId);

    const started = eventsOf(second.log, 'run_started');
    assert.equal(
      started[0]?.data.reason,
      'RESUME',
      'the run says it is resuming, and says so in the log rather than in a variable',
    );

    const entry = eventsOf(second.log, 'entry_stage_computed');
    assert.ok(entry.length > 0, 'the entry stage is computed, and recorded');
    const walk = JSON.stringify(entry[0]?.data ?? {});
    assert.match(
      walk,
      /reality\.stage_completed_previously/,
      'the walk consults AgentOS’s own run ledger, which is the only honest observation '
      + 'that an analysis happened',
    );

    const history = second.built.framework.calls()
      .filter((call) => call.adapter === 'host' && call.op === 'read_run_history');
    assert.ok(
      history.length > 0,
      'and it reads that ledger through the adapter, with a locator the kernel could replay',
    );
    assert.ok(
      history.every((call) => call.outcome === 'OK'),
      'the ledger answered: a resumed run that could not read its own history would re-analyse',
    );
  });

  test('end to end: a dispatch that throws still releases its lease, so the log — not the lease — is what a restart reads', async () => {
    /*
     * Worth being exact about what this shows and what it does not. `Kernel.work` releases the
     * lease in a `finally`, so an exception propagating out of a dispatch — which is what the
     * kill above is, in one process — leaves the work item unlocked. That is correct: a run
     * that ended, however badly, is not still running.
     *
     * It also means the lease is not what carries resumption. The log is. The restarted run
     * below re-enters the stage the crashed run never finished, and it does so from the
     * ledger, having re-read everything.
     */
    const world = newWorld();
    const killed = await killedMidDispatch(world, request);

    assert.equal(
      killed.built.store.readLease(killed.workItemId),
      null,
      'the lease was released when the dispatch threw: a dead run does not hold a work item',
    );
    const workItemLog = killed.built.store.readWorkItemLog(killed.workItemId).records;
    assert.ok(
      eventsOf(workItemLog, 'lease').some((event) => event.data.action === 'RELEASED'),
      'and the release is journalled on the work item log, which outlives the run',
    );

    const restarted = await work({ world, raw: request, script: script() });
    assert.equal(restarted.result.workItemId, killed.workItemId);
    assert.notEqual(restarted.result.runId, killed.runId);
    assert.equal(
      eventsOf(restarted.log, 'run_started')[0]?.data.reason,
      'RESUME',
      'the restart is a resumption of the work item, recorded as one',
    );

    const entered = eventsOf(restarted.log, 'dispatch_intent').map((event) => event.stage);
    assert.ok(
      entered.includes('AUDIT'),
      `the stage the crash interrupted is re-entered rather than stepped past: ${entered.join(', ')}`,
    );

    assert.equal(
      world.fingerprint().tree,
      killed.before.tree,
      'and neither the crash nor the restart touched the repository',
    );
  });

  test('at the seam: one active run per Work Item — a second lease over a live one is refused, not queued', () => {
    /*
     * The rule the lease exists for, exercised against the real store rather than inferred. It
     * is what makes "someone ran it twice" a refusal instead of two pull requests.
     */
    const world = newWorld();
    const store = new RunStore(world.stateRoot);
    const now = new Date('2026-01-01T00:00:00.000Z');

    const first = store.acquireLease('wi_lease', 'run_a', 'pid:1', now, 60_000);
    assert.equal(first.outcome, 'ACQUIRED');

    const second = store.acquireLease('wi_lease', 'run_b', 'pid:2', now, 60_000);
    assert.equal(second.outcome, 'REFUSED');
    assert.equal(second.outcome === 'REFUSED' ? second.activeRunId : null, 'run_a');

    /* And a lease older than its timeout is reclaimable, so a genuinely dead holder does not
     * strand the work item forever. */
    const later = new Date(now.getTime() + 61_000);
    const third = store.acquireLease('wi_lease', 'run_c', 'pid:3', later, 60_000);
    assert.equal(third.outcome, 'RECLAIMED');
    assert.equal(third.outcome === 'RECLAIMED' ? third.abandonedRunId : null, 'run_a');
  });
});

/* --------------------------------------------------------------- helpers ---- */

/**
 * A run whose first graph dispatch dies the way a killed process dies.
 *
 * The substrate throws after `dispatch_intent` is journalled and before any envelope exists,
 * which is the shape of an interrupted dispatch: an intent with no result. `kernel.work`
 * propagates the throw, so nothing writes an ending — exactly as a `SIGKILL` would not.
 */
async function killedMidDispatch(world: ScratchWorld, request: string): Promise<{
  readonly built: Awaited<ReturnType<typeof buildKernel>>;
  readonly workItemId: string;
  readonly runId: string;
  readonly before: ReturnType<ScratchWorld['fingerprint']>;
}> {
  const before = world.fingerprint();
  const evidence = fileEvidence('E-01', 'README.md', README_CONTENT);
  const substrate = {
    name: 'killed-mid-dispatch',
    conformance: () => Promise.resolve({
      substrate: 'killed-mid-dispatch',
      verdict: 'CONFORMS' as const,
      expected: [],
      effective: [],
      unexpected: [],
      missing: [],
      detail: 'nothing was granted before the process died',
    }),
    dispatched: 0,
    /*
     * The prologue answers; the graph dies.
     *
     * Keyed on the stage rather than on a dispatch number, because the number is exactly what
     * changed when `CONTEXT_DISCOVERY` started dispatching its own mandate — and a fixture that
     * expresses "the crash is inside the graph" as "the second dispatch" is a fixture that
     * silently starts testing something else the moment the prologue grows a dispatch.
     */
    async dispatch(input: InputPackage, invoker: ToolInvoker): Promise<never> {
      this.dispatched += 1;
      const surface = (detail: string) => ({
        substrate: 'killed-mid-dispatch',
        verdict: 'CONFORMS' as const,
        expected: input.tools_granted.map((grant) => grant.tool_name),
        effective: input.tools_granted.map((grant) => grant.tool_name),
        unexpected: [],
        missing: [],
        detail,
      });
      const cost = { input_tokens: 100, output_tokens: 10, usd: 0.01 };
      /* An agent reads the ids it is answering out of the package it was given, and so does
       * this: an envelope that does not name its own dispatch is refused, and rightly. */
      const answering = (envelope: HandoffEnvelope): HandoffEnvelope => ({
        ...envelope,
        work_item_id: input.work_item_id,
        run_id: input.run_id,
        dispatch_id: input.dispatch_id,
        model: input.model,
      });

      if (input.stage === 'RESOLUTION') {
        return {
          outcome: 'ENVELOPE',
          envelope: answering(resolution({
            type: 'INVESTIGATION',
            intent: 'INVESTIGATE',
            title: 'Restart handling',
            desiredOutcome: 'how restarts are handled is established',
            scopePaths: ['README.md'],
            evidence: [evidence],
            cites: [],
          })),
          toolSurface: surface('the resolution dispatch completed before the process died'),
          cost,
          model: 'model.scripted',
        } as never;
      }

      if (input.stage === 'CONTEXT_DISCOVERY') {
        /* Read what it is about to claim it examined: coverage is reconciled here too. */
        await invoker.invoke('repo__read_file', { path: 'README.md' });
        return {
          outcome: 'ENVELOPE',
          envelope: answering(context({ evidence: [evidence], scopeExamined: ['README.md'] })),
          toolSurface: surface('the context dispatch completed before the process died'),
          cost,
          model: 'model.scripted',
        } as never;
      }

      /* Here is the kill: mid-dispatch, inside the graph, with the intent already on disk. */
      return Promise.reject(new Error('the process was killed mid-dispatch'));
    },
  };

  const built = await buildKernel({
    stateRoot: world.stateRoot,
    repositoryPath: world.repositoryPath,
    intake: { source: 'NATURAL_LANGUAGE', raw: request, received_at: new Date().toISOString() },
    env: { AGENTOS_MODELS: JSON.stringify([DECLARED_MODEL]) },
    substrate: substrate as never,
  });

  let workItemId = '';
  let runId = '';
  try {
    await built.kernel.work({
      source: 'NATURAL_LANGUAGE',
      sourceLocator: { adapter: 'host', op: 'read_intake', args: {} },
      raw: request,
      resolveIdentity: () => Promise.resolve({ outcome: 'NOT_NAMED' }),
      rereadIntake: () => Promise.resolve({ outcome: 'OK', raw: request }),
    });
    assert.fail('the substrate threw, so the run should not have returned');
  } catch (error) {
    assert.match(
      error instanceof Error ? error.message : String(error),
      /killed mid-dispatch/,
      'the kill propagated rather than being swallowed into a tidy outcome',
    );
  }

  /* The run is found the way a restarted process finds it: by reading the store. */
  const items = built.store.listWorkItems();
  assert.equal(items.length, 1, 'the work item was written before the dispatch that died');
  workItemId = items[0] ?? '';
  const runs = built.store.listRuns(workItemId);
  assert.equal(runs.length, 1);
  runId = runs[0] ?? '';

  return { built, workItemId, runId, before };
}

/**
 * A registry whose model is there for the prologue and gone before the graph's first stage.
 *
 * Nothing else in the build can express a model withdrawn mid-run: the host inventory is
 * enumerated once at build time. This is the smallest substitution that makes the difference
 * between "no model at all" and "the model went away after admission" observable, and both are
 * real conditions with different consequences.
 *
 * The count is the whole mechanism here, so it is named rather than left as a magic number.
 * The prologue selects a model twice in this build: `context-discovery/resolution` at
 * `RESOLUTION` and `context-discovery/context` at `CONTEXT_DISCOVERY`. `WORKFLOW_SELECTED`
 * makes no third selection, because the kernel looks up the Orchestrator's mandate as
 * `orchestrator/workflow` and `agents/src/roles/specs.ts` names it `orchestration`, so the
 * lookup misses and the dispatch returns before it reaches the registry — the fallback template
 * applies and the run proceeds. That is a real mismatch and it is not this scenario's subject;
 * it is recorded here because the count above depends on it. The third selection is the graph's
 * first stage, and that is the one that finds nothing.
 */
const PROLOGUE_MODEL_SELECTIONS = 2;

function withdrawingRegistry(): Registries {
  const declared: ModelEntry = {
    ...(DECLARED_MODEL as ModelEntry),
    availability: {
      adapter: 'host.models',
      state: 'AVAILABLE',
      detail: 'declared for the resolution dispatch, and withdrawn immediately afterwards',
      checked_at: fx.T1,
    },
  };
  let asked = 0;
  return {
    skills: (): Promise<readonly SkillEntry[]> => Promise.resolve([]),
    models: (): Promise<readonly ModelEntry[]> => {
      asked += 1;
      return Promise.resolve(asked <= PROLOGUE_MODEL_SELECTIONS ? [declared] : []);
    },
  };
}
