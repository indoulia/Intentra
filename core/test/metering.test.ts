import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx, type Event, type Stage } from '@intentra/contracts';
import { spendOf, toMicros } from '../src/budgets.js';
import { project, recover } from '../src/recovery.js';
import { Journal } from '../src/journal.js';
import { harness } from './doubles.js';

/**
 * Dispatch spend as the log records it (WP-8 Prompt 4).
 *
 * Known spend and reserved spend are different facts. A dispatch whose cost was reported holds
 * that cost; a dispatch with an intent and no result, or a result whose `usd` is `null`, holds
 * its whole `max_usd`, because an unknown cost is never zero. Nothing here releases a
 * reservation on a timeout, an abort, a kill or a rollback.
 */

const INTAKE = 'in_0001';
const MAX = 5_000_000;

let seq = 0;
function ev(
  event: Event['event'],
  data: unknown,
  frame: { readonly stage?: Stage; readonly dispatchId?: string | null; readonly runId?: string | null } = {},
): Event {
  seq += 1;
  return {
    seq,
    at: fx.T1,
    work_item_id: INTAKE,
    run_id: frame.runId ?? null,
    stage: frame.stage ?? 'RESOLUTION',
    dispatch_id: frame.dispatchId ?? null,
    agent: null,
    event,
    data,
  } as Event;
}

/** The prologue writes every dispatch event with a null frame `dispatch_id`. */
function resolutionIntent(attempt: number): Event {
  return ev('dispatch_intent', {
    input_package: fx.inputPackage({ dispatch_id: 'd_res', stage: 'RESOLUTION', agent: 'context-discovery' }),
    attempt,
  });
}

function result(usd: number | null | 'absent', frame: { readonly dispatchId?: string | null } = {}): Event {
  const cost = usd === 'absent'
    ? { input_tokens: 0, output_tokens: 0 }
    : { input_tokens: 10, output_tokens: 5, usd };
  return ev('dispatch_result', {
    outcome: 'FAILED', envelope_id: null, failure_reason: 'SUBSTRATE_ERROR', detail: '', cost,
  }, frame);
}

function runIntent(dispatchId: string): Event {
  return ev('dispatch_intent', {
    input_package: fx.inputPackage({ dispatch_id: dispatchId }), attempt: 1,
  }, { stage: 'AUDIT', dispatchId, runId: 'run_x' });
}

describe('money is integer micro-dollars', () => {
  test('a reported figure converts exactly, and an impossible one is no figure', () => {
    assert.equal(toMicros(1.209929), 1_209_929);
    assert.equal(toMicros(0.1 + 0.2), 300_000);
    assert.equal(toMicros(0), 0);
    assert.equal(toMicros(-0.01), null);
    assert.equal(toMicros(Number.NaN), null);
    assert.equal(toMicros(1e300), null);
  });
});

describe('an unknown cost holds its reservation', () => {
  test('a smoke-3-shaped prologue, intent and no result, reserves max_usd and is interrupted', () => {
    const events = [ev('note', { topic: 't', detail: 'd' }), resolutionIntent(1)];
    const spend = spendOf(events);
    assert.equal(spend.knownMicros, 0);
    assert.equal(spend.reservedMicros, MAX);
    assert.equal(spend.attempts, 1);
    assert.equal(spend.unknown.length, 1);
    assert.deepEqual([...project(events).interruptedDispatches], ['d_res']);
  });

  test('a result with a null usd keeps the reservation, and known spend stays known', () => {
    const events = [runIntent('d_0001'), result(null, { dispatchId: 'd_0001' })];
    const projection = project(events);
    assert.equal(projection.spend.reservedMicros, MAX);
    assert.equal(projection.spend.knownMicros, 0);
    assert.equal(projection.consumedBudget.usd, 0, 'the known-spend projection is unchanged');
    assert.deepEqual(projection.interruptedDispatches, []);
  });

  test('a confirmed zero releases the reservation', () => {
    const spend = spendOf([runIntent('d_0001'), result(0, { dispatchId: 'd_0001' })]);
    assert.equal(spend.reservedMicros, 0);
    assert.equal(spend.knownMicros, 0);
  });

  test('a known cost replaces the reservation', () => {
    const spend = spendOf([runIntent('d_0001'), result(1.209929, { dispatchId: 'd_0001' })]);
    assert.equal(spend.reservedMicros, 0);
    assert.equal(spend.knownMicros, 1_209_929);
  });

  test('a rollback ends the interruption but never the reservation', () => {
    const events = [
      runIntent('d_0001'),
      ev('dispatch_rollback', { rolled_back_dispatch: 'd_0001', reversed: [] }, { runId: 'run_x' }),
    ];
    const projection = project(events);
    assert.deepEqual(projection.interruptedDispatches, []);
    assert.equal(projection.spend.reservedMicros, MAX);
  });
});

describe('prologue intents and results pair in log order', () => {
  test('a known first attempt and an interrupted second are each counted once', () => {
    const spend = spendOf([
      resolutionIntent(1), result(1.209929),
      resolutionIntent(2),
    ]);
    assert.equal(spend.knownMicros, 1_209_929);
    assert.equal(spend.reservedMicros, MAX);
    assert.equal(spend.attempts, 2);
  });

  test('a record written without a session, which carries no usd, closes no intent', () => {
    const spend = spendOf([resolutionIntent(1), result('absent')]);
    assert.equal(spend.reservedMicros, MAX);
  });

  test('a cost record with no intent to pair with is unreservable, never free', () => {
    const spend = spendOf([result(null)]);
    assert.equal(spend.unreservable, 1);
    assert.equal(spend.reservedMicros, 0);
  });

  test('replaying the same events twice gives the same spend', () => {
    const events = [resolutionIntent(1), result(0.5), runIntent('d_0001')];
    assert.deepEqual(spendOf(events), spendOf(events));
    assert.deepEqual(spendOf([...events, ...[]]).knownMicros, 500_000);
  });
});

describe('a crashed run recovers its reservations from the durable log', () => {
  const cleanup: (() => void)[] = [];
  after(() => { for (const fn of cleanup) fn(); });

  test('an intent with no result, followed by a torn line, recovers as reserved', () => {
    const h = harness();
    cleanup.push(() => { h.destroy(); });
    const workItemId = 'wi_c_metering';
    const runId = 'run_20260904T100000Z_000001';
    h.store.putWorkItemProjection(fx.workItem({ work_item_id: workItemId }));
    h.store.createRun(workItemId, runId);
    const journal = Journal.open(h.store, h.clock, { workItemId, runId });
    journal.run('dispatch_intent', { input_package: fx.inputPackage(), attempt: 1 },
      { stage: 'AUDIT', dispatchId: 'd_0001', agent: 'auditor' });
    journal.run('dispatch_result', {
      outcome: 'ENVELOPE', envelope_id: 'env_1', failure_reason: null, detail: '',
      cost: { input_tokens: 1, output_tokens: 1, usd: 0.25 },
    }, { stage: 'AUDIT', dispatchId: 'd_0001', agent: 'auditor' });
    journal.run('dispatch_intent', { input_package: fx.inputPackage({ dispatch_id: 'd_0002' }), attempt: 1 },
      { stage: 'AUDIT', dispatchId: 'd_0002', agent: 'auditor' });
    h.store.runLog(workItemId, runId).appendRawForTest('{"seq":99,"at":"2026-09');

    const outcome = recover(h.store, workItemId, runId, () => undefined);
    assert.equal(outcome.projection.spend.knownMicros, 250_000);
    assert.equal(outcome.projection.spend.reservedMicros, MAX);
    assert.equal(outcome.interruptedDispatch, 'd_0002');
  });
});
