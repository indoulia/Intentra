import type {
  AgentRole,
  Event,
  EventKind,
  Stage,
} from '@agentos/contracts';
import type { Clock } from '@agentos/contracts';
import type { RunStore } from '@agentos/state';

/**
 * The kernel's writer onto the event log.
 *
 * The log is authoritative and the projections derive from it, so every fact a run has must
 * pass through here. Two rules are enforced by construction rather than by discipline:
 *
 * - **`seq` is allocated by the journal, monotonically, per log.** A caller cannot choose a
 *   sequence number, so "any prefix of the log" is always a well-defined thing to replay.
 * - **Write before act.** `dispatchIntent` returns only after the intent is on disk and
 *   flushed, which is what makes a crash mid-agent detectable rather than invisible.
 *
 * There are two logs and they are different things. The work-item log records what happened
 * to the durable piece of work — runs started, outcomes, links, reclassifications. The run
 * log records one attempt at it. A run failing does not fail the work item, and keeping the
 * two logs separate is what makes that true of the record as well as of the model.
 */

export interface JournalTarget {
  readonly workItemId: string;
  readonly runId: string | null;
}

/** What every event carries besides its own payload. */
export interface EventContext {
  readonly stage?: Stage | null;
  readonly dispatchId?: string | null;
  readonly agent?: AgentRole | null;
}

type PayloadFor<K extends EventKind> = Extract<Event, { event: K }>['data'];

export class Journal {
  #runSeq: number;
  #workItemSeq: number;

  private constructor(
    private readonly store: RunStore,
    private readonly clock: Clock,
    readonly target: JournalTarget,
    runSeq: number,
    workItemSeq: number,
  ) {
    this.#runSeq = runSeq;
    this.#workItemSeq = workItemSeq;
  }

  /**
   * Opens a journal, taking the next sequence number from the log itself.
   *
   * Reading the log to find where to continue is the only correct source: a counter held in
   * memory is a counter a restart loses, and a counter held in a projection is a counter
   * that disagrees with the log the moment a write is interrupted.
   */
  static open(
    store: RunStore,
    clock: Clock,
    target: JournalTarget,
  ): Journal {
    const workItemSeq = store.workItemLog(target.workItemId).exists()
      ? store.readWorkItemLog(target.workItemId).lastSeq
      : 0;
    const runSeq = target.runId !== null && store.runExists(target.workItemId, target.runId)
      ? store.readRunLog(target.workItemId, target.runId).lastSeq
      : 0;
    return new Journal(store, clock, target, runSeq, workItemSeq);
  }

  get lastRunSeq(): number {
    return this.#runSeq;
  }

  get lastWorkItemSeq(): number {
    return this.#workItemSeq;
  }

  /** Appends a run event. Fails if the journal has no run. */
  run<K extends EventKind>(
    kind: K,
    data: PayloadFor<K>,
    context: EventContext = {},
  ): Event {
    const runId = this.target.runId;
    if (runId === null) {
      throw new Error(`cannot record run event ${kind}: this journal has no run`);
    }
    this.#runSeq += 1;
    const event = {
      seq: this.#runSeq,
      at: this.clock.now().toISOString(),
      work_item_id: this.target.workItemId,
      run_id: runId,
      stage: context.stage ?? null,
      dispatch_id: context.dispatchId ?? null,
      agent: context.agent ?? null,
      event: kind,
      data,
    } as Event;
    this.store.appendRunEvent(event);
    return event;
  }

  /** Appends a work-item event. `run_id` is carried where one exists, and may be null. */
  workItem<K extends EventKind>(
    kind: K,
    data: PayloadFor<K>,
    context: EventContext = {},
  ): Event {
    this.#workItemSeq += 1;
    const event = {
      seq: this.#workItemSeq,
      at: this.clock.now().toISOString(),
      work_item_id: this.target.workItemId,
      run_id: this.target.runId,
      stage: context.stage ?? null,
      dispatch_id: context.dispatchId ?? null,
      agent: context.agent ?? null,
      event: kind,
      data,
    } as Event;
    this.store.appendWorkItemEvent(event);
    return event;
  }

  /**
   * Records a fact at both levels.
   *
   * Used only where a fact genuinely belongs to both: a run starting is a run's first event
   * and a work item's history, and a reader of either log would be misled by its absence.
   */
  both<K extends EventKind>(
    kind: K,
    data: PayloadFor<K>,
    context: EventContext = {},
  ): { readonly runEvent: Event | null; readonly workItemEvent: Event } {
    const workItemEvent = this.workItem(kind, data, context);
    const runEvent = this.target.runId === null ? null : this.run(kind, data, context);
    return { runEvent, workItemEvent };
  }

  /** Rebases onto a run, for a journal opened before the run existed. */
  withRun(runId: string): Journal {
    return Journal.open(this.store, this.clock, {
      workItemId: this.target.workItemId,
      runId,
    });
  }
}
