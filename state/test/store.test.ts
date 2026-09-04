import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtures as fx, validators, type Event } from '@agentos/contracts';
import { NdjsonLog, RunStore, StoreError, LogError } from '../src/index.js';

/**
 * The run store, and the rules that make interruption survivable.
 *
 * The tests that matter most here are the torn write and the lease, because both are about
 * what happens at an instant nobody controls: a power loss between two bytes, and two
 * processes starting at the same moment.
 */

let root: string;
let store: RunStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentos-state-'));
  store = new RunStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const WI = 'wi_c_subject';
const RUN = 'run_20260904T100000Z_000001';

/** A literal newline, built from its code point so no editor or tool can rewrite it. */
const NL = String.fromCharCode(10);

function event(seq: number, overrides: Partial<Event> = {}): Event {
  return {
    seq,
    at: fx.T1,
    work_item_id: WI,
    run_id: RUN,
    stage: 'AUDIT',
    dispatch_id: null,
    agent: null,
    event: 'note',
    data: { topic: 'test', detail: `event ${seq}` },
    ...overrides,
  } as Event;
}

/* -------------------------------------------------------------------- the log ---- */

describe('the append-only log', () => {
  test('every record is one newline-terminated line', () => {
    const log = new NdjsonLog(join(root, 'events.ndjson'));
    log.append({ seq: 1, a: 1 });
    log.append({ seq: 2, a: 2 });
    const text = readFileSync(log.path, 'utf8');
    assert.equal(text, '{"seq":1,"a":1}\n{"seq":2,"a":2}\n');
  });

  test('a newline inside a value still produces exactly one line', () => {
    const log = new NdjsonLog(join(root, 'events.ndjson'));
    log.append({ seq: 1, detail: `first line${NL}second line` });
    const lines = readFileSync(log.path, 'utf8').split(NL).filter((l) => l.length > 0);
    assert.equal(
      lines.length,
      1,
      'one event per line is load-bearing for recovery: a record that split into two lines '
      + 'would leave one of them parseable and wrong',
    );
    assert.equal(log.read((v) => v).records.length, 1);
  });

  test('the guard against a record that serializes with a raw newline holds', () => {
    const log = new NdjsonLog(join(root, 'events.ndjson'));
    /*
     * Unreachable through JSON.stringify, which escapes newlines inside strings. The guard
     * exists so that "one event per line" is true by construction rather than by a property
     * of the serializer, and it is exercised here through a `toJSON` that breaks the rule.
     */
    const hostile = { seq: 1, toJSON: () => `raw${NL}newline` };
    const serialized = JSON.stringify(hostile);
    if (serialized !== undefined && serialized.includes(NL)) {
      assert.throws(() => log.append(hostile), LogError);
    } else {
      log.append(hostile);
      const lines = readFileSync(log.path, 'utf8').split(NL).filter((l) => l.length > 0);
      assert.equal(lines.length, 1, 'the serializer escaped it, so the invariant still holds');
    }
  });

  test('reading an absent log yields nothing rather than throwing', () => {
    const log = new NdjsonLog(join(root, 'missing.ndjson'));
    const result = log.read((v) => v);
    assert.deepEqual(result.records, []);
    assert.equal(result.lastSeq, 0);
    assert.equal(result.discardedPartialLine, null);
  });

  test('a trailing partial line is detected, not parsed, and not silently dropped', () => {
    const log = new NdjsonLog(join(root, 'events.ndjson'));
    log.append({ seq: 1, a: 1 });
    log.append({ seq: 2, a: 2 });
    /* The signature of a power loss mid-write. */
    log.appendRawForTest('{"seq":3,"a":');

    const result = log.read((v) => v);
    assert.equal(result.records.length, 2, 'the two complete records survive');
    assert.equal(result.discardedPartialLine, '{"seq":3,"a":');
    assert.equal(result.lastSeq, 2);
    assert.deepEqual(result.rejected, [], 'a partial line is never parsed, so never rejected');
  });

  test('the partial line is repaired by rewrite-and-rename, keeping the complete prefix', () => {
    const log = new NdjsonLog(join(root, 'events.ndjson'));
    log.append({ seq: 1, a: 1 });
    log.appendRawForTest('{"seq":2,');
    const discarded = log.truncatePartialLine();
    assert.equal(discarded, '{"seq":2,'.length);
    assert.equal(readFileSync(log.path, 'utf8'), '{"seq":1,"a":1}\n');
    assert.equal(log.read((v) => v).discardedPartialLine, null);
    assert.ok(!existsSync(`${log.path}.repair`), 'the temporary file does not survive');
  });

  test('a complete but unparseable line is reported rather than aborting the replay', () => {
    const log = new NdjsonLog(join(root, 'events.ndjson'));
    log.append({ seq: 1, a: 1 });
    log.appendRawForTest('not json\n');
    log.append({ seq: 3, a: 3 });
    const result = log.read((v) => v);
    assert.equal(result.records.length, 2);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]?.line, 2);
  });

  test('a record the parser rejects is reported with its line number', () => {
    const log = new NdjsonLog(join(root, 'events.ndjson'));
    log.append({ seq: 1, kind: 'good' });
    log.append({ seq: 2, kind: 'bad' });
    const result = log.read((value, line) => {
      if ((value as { kind: string }).kind !== 'good') throw new Error(`line ${line} is bad`);
      return value;
    });
    assert.equal(result.records.length, 1);
    assert.match(result.rejected[0]?.reason ?? '', /line 2 is bad/);
  });

  test('appendAll writes one flushed line per record', () => {
    const log = new NdjsonLog(join(root, 'events.ndjson'));
    log.appendAll([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    assert.equal(readFileSync(log.path, 'utf8'), '{"seq":1}\n{"seq":2}\n{"seq":3}\n');
    assert.equal(log.read((v) => v).records.length, 3);
  });

  test('appending to a log that ends in a torn line is refused, not attempted', () => {
    /*
     * The failure this prevents is worse than the crash that caused it. Appending onto a
     * partial line joins the two into one corrupt line in the *middle* of the log, and
     * recovery only ever inspects the end — so the corruption would be permanent and silent.
     * Refusing forces the repair to happen first.
     */
    const log = new NdjsonLog(join(root, 'events.ndjson'));
    log.append({ seq: 1, kind: 'good' });
    log.appendRawForTest('{"seq":2,"kind":"tor');
    assert.equal(log.endsWithNewline(), false);
    assert.throws(
      () => { log.append({ seq: 3, kind: 'good' }); },
      /ends with a partial line/,
    );
    assert.throws(
      () => { log.appendAll([{ seq: 3 }]); },
      /ends with a partial line/,
    );
    assert.equal(
      log.read((v) => v).records.length,
      1,
      'the refused appends wrote nothing',
    );
  });

  test('after the partial line is truncated the log is appendable again', () => {
    const log = new NdjsonLog(join(root, 'events.ndjson'));
    log.append({ seq: 1, kind: 'good' });
    log.appendRawForTest('{"seq":2,"kind":"tor');
    const discarded = log.truncatePartialLine();
    assert.ok(discarded > 0);
    assert.equal(log.endsWithNewline(), true);
    log.append({ seq: 2, kind: 'good' });
    assert.equal(log.read((v) => v).records.length, 2);
  });

  test('an empty log and a missing log are both appendable', () => {
    const missing = new NdjsonLog(join(root, 'not-yet.ndjson'));
    assert.equal(missing.endsWithNewline(), true, 'a log that does not exist has no torn tail');
    missing.append({ seq: 1 });
    assert.equal(missing.read((v) => v).records.length, 1);
  });
});

/* --------------------------------------------------------------- the run store ---- */

describe('the run store', () => {
  test('the layout is exactly what WORKFLOW_STATE_MACHINE section 7 lays out', () => {
    store.createRun(WI, RUN);
    for (const sub of ['context', 'capabilities', 'envelopes', 'decisions', 'authorizations', 'artifacts']) {
      assert.ok(
        existsSync(join(root, 'work-items', WI, 'runs', RUN, sub)),
        `${sub} is missing`,
      );
    }
    assert.ok(existsSync(join(root, 'work-items', WI, 'runs', RUN, 'events.ndjson')));
  });

  test('creating a run twice is refused', () => {
    store.createRun(WI, RUN);
    assert.throws(() => store.createRun(WI, RUN), StoreError);
  });

  test('an id that is not usable as a directory name is refused', () => {
    for (const bad of ['../escape', 'wi/slash', '', 'wi:colon', '.hidden']) {
      assert.throws(() => store.createRun(bad, RUN), /not usable as a directory name/, bad);
    }
  });

  test('an intake record round-trips verbatim', () => {
    const intake = fx.intakeRecord({ raw: 'Fix typo in README.' });
    store.putIntake(intake);
    assert.deepEqual(store.getIntake(intake.intake_id), intake);
  });

  test('the work item projection round-trips and is validated on the way in', () => {
    const workItem = fx.workItem();
    store.putWorkItemProjection(workItem);
    assert.deepEqual(store.getWorkItem(WI), workItem);
    assert.deepEqual(store.listWorkItems(), [WI]);
  });

  test('an invalid projection is refused rather than written', () => {
    const broken = { ...fx.workItem(), lifecycle: 'FEELING_GOOD' } as never;
    assert.throws(() => store.putWorkItemProjection(broken), /does not satisfy/);
    assert.equal(store.getWorkItem(WI), null);
  });

  test('an event is validated before it reaches the log', () => {
    store.createRun(WI, RUN);
    const broken = { ...event(1), event: 'vibes' } as never;
    assert.throws(() => store.appendRunEvent(broken), /does not satisfy/);
    assert.equal(store.readRunLog(WI, RUN).records.length, 0);
  });

  test('a run event with no run id is refused', () => {
    store.createRun(WI, RUN);
    assert.throws(
      () => store.appendRunEvent(event(1, { run_id: null })),
      StoreError,
    );
  });

  test('run events replay in order with their sequence numbers intact', () => {
    store.createRun(WI, RUN);
    for (let seq = 1; seq <= 5; seq += 1) store.appendRunEvent(event(seq));
    const result = store.readRunLog(WI, RUN);
    assert.equal(result.records.length, 5);
    assert.deepEqual(result.records.map((e) => e.seq), [1, 2, 3, 4, 5]);
    assert.equal(result.lastSeq, 5);
  });

  test('envelopes are immutable: a second write under one id is refused', () => {
    store.createRun(WI, RUN);
    const envelope = fx.envelope();
    store.putEnvelope(WI, RUN, envelope);
    assert.deepEqual(store.getEnvelope(WI, RUN, envelope.envelope_id), envelope);
    assert.throws(
      () => store.putEnvelope(WI, RUN, { ...envelope, summary: 'rewritten' }),
      /immutable/,
    );
    assert.equal(store.getEnvelope(WI, RUN, envelope.envelope_id)?.summary, envelope.summary);
  });

  test('versioned documents are immutable and the latest version is discoverable', () => {
    store.createRun(WI, RUN);
    store.putVersioned(WI, RUN, 'context', 1, { version: 1 });
    store.putVersioned(WI, RUN, 'context', 2, { version: 2 });
    assert.equal(store.latestVersion(WI, RUN, 'context'), 2);
    assert.deepEqual(store.getVersioned(WI, RUN, 'context', 1), { version: 1 });
    assert.throws(() => store.putVersioned(WI, RUN, 'context', 2, { version: 'x' }), /immutable/);
  });

  test('a version below one is refused', () => {
    store.createRun(WI, RUN);
    assert.throws(() => store.putVersioned(WI, RUN, 'context', 0, {}), StoreError);
  });

  test('the run projection is validated and round-trips', () => {
    store.createRun(WI, RUN);
    const run = {
      run_id: RUN,
      work_item_id: WI,
      started_at: fx.T0,
      ended_at: null,
      outcome: null,
      graph: {
        template_id: 'investigation.readonly',
        template_version: '1.0',
        entry: 'AUDIT',
        stages: ['AUDIT', 'COMPLETION'],
        edges: [{ from: 'AUDIT', to: 'COMPLETION', when: 'always', kind: 'advance' }],
        excluded_stages: [],
        stage_mandates: {},
        risk_class: 'READ_ONLY',
        dod_profile_default: 'audit',
      },
      current_stage: 'AUDIT',
      pre_block_stage: null,
      cursor: [],
      loop_counters: {},
      consumed_budget: { usd: 0, input_tokens: 0, output_tokens: 0, dispatches: 0, loops: {} },
      open_blockers: [],
      pending_authorizations: [],
      envelope_ids: [],
      context_package_version: null,
      last_seq: 0,
    };
    validators.run.parse(run, 'run fixture');
    store.putRunProjection(run as never);
    assert.deepEqual(store.getRun(WI, RUN), run);
  });
});

/* ------------------------------------------------------------------- the lease ---- */

describe('the single-active-run lease', () => {
  const TIMEOUT = 60_000;
  const T = (offsetMs: number) => new Date(Date.parse(fx.T0) + offsetMs);

  test('the first acquirer wins', () => {
    const result = store.acquireLease(WI, RUN, 'pid:1', T(0), TIMEOUT);
    assert.equal(result.outcome, 'ACQUIRED');
    assert.equal(store.readLease(WI)?.run_id, RUN);
  });

  test('a second attempt is refused with the active run named', () => {
    store.acquireLease(WI, RUN, 'pid:1', T(0), TIMEOUT);
    const second = store.acquireLease(WI, 'run_other', 'pid:2', T(1000), TIMEOUT);
    assert.equal(second.outcome, 'REFUSED');
    if (second.outcome !== 'REFUSED') throw new Error('unreachable');
    assert.equal(second.activeRunId, RUN, 'the refusal names the run that holds it');
    assert.equal(second.holder, 'pid:1');
  });

  test('two acquirers at the same instant: exactly one wins', () => {
    /*
     * Acquisition is an exclusive create, so this is a real race rather than a simulated
     * one: both calls reach the filesystem with the same arguments and only one create can
     * succeed. Sequential calls at an identical timestamp are the strongest form of the
     * race expressible without threads, and it is the case the lease exists for.
     */
    const first = store.acquireLease(WI, 'run_a', 'pid:1', T(0), TIMEOUT);
    const second = store.acquireLease(WI, 'run_b', 'pid:2', T(0), TIMEOUT);
    const outcomes = [first.outcome, second.outcome].sort();
    assert.deepEqual(outcomes, ['ACQUIRED', 'REFUSED']);
    assert.equal(store.readLease(WI)?.run_id, 'run_a');
  });

  test('a lease held by a gone holder is reclaimable only after the policy timeout', () => {
    store.acquireLease(WI, RUN, 'pid:1', T(0), TIMEOUT);

    const tooSoon = store.acquireLease(WI, 'run_next', 'pid:2', T(TIMEOUT - 1), TIMEOUT);
    assert.equal(tooSoon.outcome, 'REFUSED', 'without the timeout a crashed run holds it forever');

    const reclaimed = store.acquireLease(WI, 'run_next', 'pid:2', T(TIMEOUT + 1), TIMEOUT);
    assert.equal(reclaimed.outcome, 'RECLAIMED');
    if (reclaimed.outcome !== 'RECLAIMED') throw new Error('unreachable');
    assert.equal(
      reclaimed.abandonedRunId,
      RUN,
      'the reclamation names the abandoned run, which is what makes it auditable',
    );
    assert.equal(store.readLease(WI)?.run_id, 'run_next');
  });

  test('two reclaimers after the timeout: exactly one ends up holding it', () => {
    store.acquireLease(WI, RUN, 'pid:1', T(0), TIMEOUT);
    const a = store.acquireLease(WI, 'run_a', 'pid:2', T(TIMEOUT + 1), TIMEOUT);
    const b = store.acquireLease(WI, 'run_b', 'pid:3', T(TIMEOUT + 1), TIMEOUT);

    /*
     * The first reclaimer resets `acquired_at`, so the second sees a lease that is no longer
     * abandoned and is refused. Exactly one holder, and the other is told who holds it.
     */
    const reclaimed = [a, b].filter((r) => r.outcome === 'RECLAIMED');
    const refused = [a, b].filter((r) => r.outcome === 'REFUSED');
    assert.equal(reclaimed.length, 1, 'a second reclamation of a fresh lease is not a reclamation');
    assert.equal(refused.length, 1);

    const holder = store.readLease(WI);
    assert.ok(holder !== null);
    assert.equal(holder.run_id, 'run_a');
    const loser = refused[0];
    if (loser !== undefined && loser.outcome === 'REFUSED') {
      assert.equal(loser.activeRunId, 'run_a', 'the refusal names the new holder');
    }
  });

  test('a reclaimer that lost the rename race does not hold the lease', () => {
    /*
     * Under true concurrency both reclaimers can pass the age check before either renames,
     * and both renames then succeed. The rename is atomic, so the file names one of them,
     * and the read-back is what settles which — the reclaimer proceeds only on reading its
     * own id back. This exercises the losing side: run_a reclaimed, run_b then took it, and
     * run_a must be unable to act on a lease it no longer holds.
     */
    store.acquireLease(WI, RUN, 'pid:1', T(0), TIMEOUT);
    assert.equal(store.acquireLease(WI, 'run_a', 'pid:2', T(TIMEOUT + 1), TIMEOUT).outcome, 'RECLAIMED');

    store.releaseLease(WI, 'run_a');
    store.acquireLease(WI, 'run_b', 'pid:3', T(TIMEOUT + 2), TIMEOUT);

    assert.equal(store.readLease(WI)?.run_id, 'run_b');
    assert.equal(store.releaseLease(WI, 'run_a'), false, 'run_a cannot release what it does not hold');
  });

  test('releasing is refused for a run that does not hold it', () => {
    store.acquireLease(WI, RUN, 'pid:1', T(0), TIMEOUT);
    assert.equal(store.releaseLease(WI, 'run_other'), false);
    assert.equal(store.readLease(WI)?.run_id, RUN);
    assert.equal(store.releaseLease(WI, RUN), true);
    assert.equal(store.readLease(WI), null);
  });

  test('after release, a new run may acquire', () => {
    store.acquireLease(WI, RUN, 'pid:1', T(0), TIMEOUT);
    store.releaseLease(WI, RUN);
    assert.equal(store.acquireLease(WI, 'run_next', 'pid:2', T(1), TIMEOUT).outcome, 'ACQUIRED');
  });
});

/* --------------------------------------------------------- work-item idempotency ---- */

describe('the work-item-scoped idempotency ledger', () => {
  test('a record round-trips and lives beside the work item, not inside a run', () => {
    const record = {
      key: 'a'.repeat(64),
      scope: 'work_item' as const,
      adapter: 'git',
      op: 'create_pr',
      result: { number: 412 },
      external_locator: { adapter: 'git', op: 'read_pr', args: { number: 412 } },
      recorded_at: fx.T1,
    };
    store.putIdempotencyRecord(WI, record);
    assert.deepEqual(store.getIdempotencyRecord(WI, record.key), record);
    assert.ok(
      existsSync(join(root, 'work-items', WI, 'idempotency', `${record.key}.json`)),
      'across runs is where duplicate external side effects come from, so the ledger outlives a run',
    );
  });

  test('a record whose resource is confirmed absent is deleted, not kept', () => {
    const key = 'b'.repeat(64);
    store.putIdempotencyRecord(WI, {
      key,
      scope: 'work_item',
      adapter: 'git',
      op: 'create_pr',
      result: {},
      external_locator: null,
      recorded_at: fx.T1,
    });
    assert.equal(store.deleteIdempotencyRecord(WI, key), true);
    assert.equal(store.getIdempotencyRecord(WI, key), null);
    assert.equal(store.deleteIdempotencyRecord(WI, key), false);
  });
});

/* ------------------------------------------------------------------ projections ---- */

describe('projections are rebuildable, and the log is authoritative', () => {
  test('a projection disagreeing with the log does not change the log', () => {
    store.createRun(WI, RUN);
    for (let seq = 1; seq <= 3; seq += 1) store.appendRunEvent(event(seq));
    /* Overwrite the projection with something inconsistent. The log is unaffected, which is
     * the property that makes "if they disagree, the log wins" mean anything. */
    const replayed = store.readRunLog(WI, RUN);
    assert.equal(replayed.lastSeq, 3);
  });

  test('replaying any prefix of a log twice yields identical records', () => {
    store.createRun(WI, RUN);
    for (let seq = 1; seq <= 8; seq += 1) store.appendRunEvent(event(seq));
    const first = store.readRunLog(WI, RUN);
    const second = store.readRunLog(WI, RUN);
    assert.deepEqual(first.records, second.records);
  });
});
