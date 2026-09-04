import { digest } from '@agentos/contracts';
import type { BudgetPolicy, CallRecord, PathRefusal } from '@agentos/contracts';

/**
 * The call log: every adapter call, reads included.
 *
 * This is what makes `coverage` checkable rather than believable. An envelope claiming it
 * examined a subsystem is reconciled against these records, so "found nothing here" and
 * "never looked here" stop being the same sentence.
 *
 * **Aggregation is permitted; omission is not.** Reads are recorded at the granularity
 * `policies/data/budgets.json` declares — identical calls within a window collapse into one
 * record whose `aggregated_count` rises — and nothing is ever dropped. A record that reached
 * the aggregation ceiling starts a new record rather than silently stopping counting, because
 * a counter that saturates is a form of omission.
 */

export interface CallDraft {
  readonly adapter: string;
  readonly op: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly dispatchId: string | null;
  readonly pathsTouched: readonly string[];
  readonly capabilitiesTouched: readonly string[];
  readonly outcome: CallRecord['outcome'];
  readonly refusal: CallRecord['refusal'];
  readonly startedAt: Date;
  readonly durationMs: number;
}

export type CallLogGranularity = BudgetPolicy['read_call_log_granularity'];

export class CallLog {
  #records: CallRecord[] = [];
  #sequence = 0;
  readonly #granularity: CallLogGranularity;

  constructor(granularity: CallLogGranularity) {
    this.#granularity = granularity;
  }

  /**
   * Records one call and returns the record that now represents it.
   *
   * Where the call is identical to the most recent one — same dispatch, adapter, operation,
   * arguments and outcome — and falls inside the aggregation window, the existing record's
   * count rises and that record is returned. The caller hands whatever comes back to the
   * journal, so an aggregated read appears in the log with a count instead of appearing
   * twenty times or not at all.
   */
  record(draft: CallDraft): CallRecord {
    const argsDigest = digest(draft.args);
    const previous = this.#records[this.#records.length - 1];

    if (
      previous !== undefined
      && previous.dispatch_id === draft.dispatchId
      && previous.adapter === draft.adapter
      && previous.op === draft.op
      && previous.args_digest === argsDigest
      && previous.outcome === draft.outcome
      && previous.refusal === draft.refusal
      && previous.aggregated_count < this.#granularity.max_aggregated
      && draft.startedAt.getTime() - Date.parse(previous.started_at)
        <= this.#granularity.aggregate_identical_within_ms
    ) {
      const merged: CallRecord = {
        ...previous,
        aggregated_count: previous.aggregated_count + 1,
        duration_ms: previous.duration_ms + draft.durationMs,
      };
      this.#records[this.#records.length - 1] = merged;
      return merged;
    }

    this.#sequence += 1;
    const record: CallRecord = {
      call_id: `call_${String(this.#sequence).padStart(5, '0')}`,
      dispatch_id: draft.dispatchId,
      adapter: draft.adapter,
      op: draft.op,
      args_digest: argsDigest,
      paths_touched: [...draft.pathsTouched],
      capabilities_touched: [...draft.capabilitiesTouched],
      outcome: draft.outcome,
      refusal: draft.refusal,
      aggregated_count: 1,
      started_at: draft.startedAt.toISOString(),
      duration_ms: draft.durationMs,
    };
    this.#records.push(record);
    return record;
  }

  all(): readonly CallRecord[] {
    return this.#records;
  }

  forDispatch(dispatchId: string | null): readonly CallRecord[] {
    return this.#records.filter((record) => record.dispatch_id === dispatchId);
  }

  /** Total calls represented, counting aggregation. What "how much did it look at" means. */
  count(): number {
    return this.#records.reduce((total, record) => total + record.aggregated_count, 0);
  }
}

/**
 * Path refusals, kept separately and kept whatever else happens.
 *
 * "A security violation aborts the dispatch immediately and is reported regardless of the
 * run's outcome — an agent that attempted it is worth knowing about even if it failed"
 * (REPOSITORY_ADAPTER 2.1). A refusal that only survived inside a successful run's report
 * would be missing from exactly the runs where it mattered most.
 */
export class RefusalLog {
  #refusals: PathRefusal[] = [];

  add(refusal: PathRefusal): PathRefusal {
    this.#refusals.push(refusal);
    return refusal;
  }

  all(): readonly PathRefusal[] {
    return this.#refusals;
  }

  securityViolations(): readonly PathRefusal[] {
    return this.#refusals.filter((refusal) => refusal.aborted_dispatch);
  }
}
