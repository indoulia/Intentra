import type { Event } from '@intentra/contracts';
import type { RunStore } from '@intentra/state';
import { addSpend, NO_SPEND, spendOf, toMicros, type DispatchSpend } from './budgets.js';

/**
 * A work item's dispatch spend, recovered from the durable logs (WP-8 Prompt 4).
 *
 * Read fresh before every dispatch, so a reservation an earlier run left open — a crash, a
 * kill, a result with no cost — is counted before anything else is allowed to start.
 *
 * Each dispatch is counted from exactly one log. A run log carries its own dispatches under a
 * non-null frame `dispatch_id`, plus a replay of the prologue that admitted it under a null one;
 * the replay is skipped there and the prologue is counted from where it was first written —
 * the intake log a run log's `intake_recorded` names, or, for a re-resolution, the work item's
 * own log. A prologue that never reached a run is therefore counted too.
 *
 * A line a log could not parse might be a cost record, so each one is counted as unreservable
 * and the gate refuses rather than guess.
 */
export function workItemSpend(store: RunStore, workItemId: string): DispatchSpend {
  let spend = NO_SPEND;
  const intakes = new Set<string>();

  const add = (events: readonly Event[], rejected: number): void => {
    spend = addSpend(spend, spendOf(events));
    if (rejected > 0) spend = { ...spend, unreservable: spend.unreservable + rejected };
  };

  for (const runId of store.listRuns(workItemId)) {
    const log = store.readRunLog(workItemId, runId);
    add(log.records.filter((e) => e.dispatch_id !== null), log.rejected.length);
    for (const event of log.records) {
      if (event.event === 'intake_recorded') intakes.add(event.data.intake_id);
    }
  }
  for (const intakeId of intakes) {
    const log = store.readIntakeLog(intakeId);
    add(log.records, log.rejected.length);
  }
  const own = store.readWorkItemLog(workItemId);
  add(own.records.filter((e) => e.dispatch_id === null), own.rejected.length);

  /* The projection is a floor, never a substitute: a log can be lost, a known cost cannot shrink. */
  const persisted = store.getWorkItem(workItemId)?.consumed_budget;
  if (persisted !== undefined) {
    spend = {
      ...spend,
      knownMicros: Math.max(spend.knownMicros, toMicros(persisted.usd) ?? Number.MAX_SAFE_INTEGER),
      attempts: Math.max(spend.attempts, persisted.dispatches),
    };
  }
  return spend;
}
