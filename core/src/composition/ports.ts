import type {
  AuthorizationGrant,
  Clock,
  HumanChannel,
  IdempotencyRecord,
  MutationEvent,
} from '@agentos/contracts';
import type {
  ChildWorkItemEntry,
  GrantCheckRequest,
  GrantChecker,
  GrantVerdict,
  IdempotencyLedger,
  MutationEmitVerdict,
  MutationSink,
  RunLedgerEntry,
  RunLedgerReader,
} from '@agentos/adapters';
import type { RunStore } from '@agentos/state';
import { grantEnforcer } from '../authorization.js';
import { Journal } from '../journal.js';
import { project } from '../recovery.js';

/**
 * The kernel's half of the adapter framework, wired to durable state.
 *
 * Four collaborators execute *inside* the adapter at call time and belong to `core/`: the
 * grant check, the mutation journal, the idempotency ledger and the run-ledger reader. Each
 * arrives at the framework as an injected port, which is what keeps "enforcement at execution
 * in `adapters/`" true without `adapters -> core` or `adapters -> state` ever existing. This
 * file is the only place they are built, and every one of them is backed by the run store
 * rather than by a default that answers nothing.
 *
 * The defaults they replace are not neutral. `EMPTY_IDEMPOTENCY_LEDGER` records nothing;
 * `REFUSING_MUTATION_SINK` refuses every mutation; and there is deliberately no default
 * run-ledger reader at all, because an empty history reads as "no prior run" and would make
 * every resumed run re-enter at `AUDIT` and redo the analysis it had already done. Wiring
 * these is the difference between a framework that is complete and one that is inert.
 */

/* ------------------------------------------------------------------ grant checking ----- */

/**
 * Reads the grants a run holds from its own log.
 *
 * `authorization_decided` is where a grant becomes durable, so the log is the source and the
 * projection is not: a grant that exists only in memory is a grant a restart loses, and a
 * grant read from a projection is a grant that disagrees with the log the moment a write is
 * interrupted. A grant that was later expired, revoked or denied is dropped, and one carrying
 * its own `revoked_at` is dropped whatever the event stream says — the record revokes itself.
 */
export function grantsRecordedFor(
  store: RunStore,
  workItemId: string,
  runId: string,
): readonly AuthorizationGrant[] {
  if (!store.runExists(workItemId, runId)) return [];
  const byRequest = new Map<string, AuthorizationGrant>();
  for (const event of store.readRunLog(workItemId, runId).records) {
    if (event.event !== 'authorization_decided') continue;
    const { decision, grant, request_id: requestId } = event.data;
    if (decision === 'GRANTED' && grant !== null && grant.revoked_at === null) {
      byRequest.set(requestId, grant);
      continue;
    }
    byRequest.delete(requestId);
  }
  return [...byRequest.values()];
}

/**
 * The grant checker the adapter framework holds, closed over this store.
 *
 * `core/src/authorization.ts` owns the rule and states its request and verdict shapes
 * structurally so that neither package imports the other; this is where the two halves meet.
 * Only grants the dispatch actually carries are considered — the enforcer filters by the ids
 * in `AdapterCallContext.grantsHeld` — because a grant is non-transferable and "some dispatch
 * in this run holds one" is precisely the transfer the rule forbids.
 */
export function storeGrantChecker(store: RunStore): GrantChecker {
  const enforce = grantEnforcer({
    grantsFor: (workItemId, runId) => grantsRecordedFor(store, workItemId, runId),
  });
  return {
    check(request: GrantCheckRequest): GrantVerdict {
      return enforce(request);
    },
  };
}

/* ------------------------------------------------------------------ mutation events ---- */

/**
 * The mutation journal, as a sink the adapter calls before it returns.
 *
 * `canEmit` is asked before the mutation happens and `emit` before the call returns, so the
 * reversal record exists the moment the mutation does. Neither is best-effort: `emit` throws
 * where the run log cannot take the event, and the framework turns that throw into a
 * `security_violation` refusal — an adapter that performed a mutation it could not record has
 * already broken the guarantee, and saying so loudly is the only remaining honest move.
 *
 * Nothing in this build exercises it. No mutating operation is registered, so `canEmit` is
 * never asked; wiring it anyway is what makes the first mutating operation land in a system
 * that already cannot perform an unlogged mutation.
 */
export class RunLogMutationSink implements MutationSink {
  constructor(
    private readonly store: RunStore,
    private readonly clock: Clock,
  ) {}

  canEmit(): MutationEmitVerdict {
    try {
      /* The cheapest read that proves the state root is there and readable. A sink that
       * cannot reach its own store cannot record anything, and must say so while refusing
       * is still possible. */
      this.store.listWorkItems();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason:
          'the run store could not be read, so a mutation event could not be appended to the '
          + `run log: ${messageOf(error)}`,
      };
    }
  }

  emit(event: MutationEvent): void {
    if (!this.store.runExists(event.work_item_id, event.run_id)) {
      throw new Error(
        `there is no run ${event.run_id} under ${event.work_item_id} to append a mutation `
        + 'event to. A mutation whose reversal record has nowhere to live is a mutation '
        + 'nobody can undo',
      );
    }
    Journal
      .open(this.store, this.clock, { workItemId: event.work_item_id, runId: event.run_id })
      .run('mutation', event, { dispatchId: event.dispatch_id });
  }
}

/* -------------------------------------------------------------- the idempotency ledger -- */

/**
 * The work-item-scoped completed-key ledger, over the store that owns it.
 *
 * It sits beside the work item rather than inside a run because across runs is where
 * duplicate external side effects come from. The adapter reads and invalidates through this
 * port, which is what lets the verified-hit rule execute at call time without
 * `adapters -> state` existing.
 */
export class StoreIdempotencyLedger implements IdempotencyLedger {
  constructor(private readonly store: RunStore) {}

  get(workItemId: string, key: string): IdempotencyRecord | null {
    return this.store.getIdempotencyRecord(workItemId, key);
  }

  put(workItemId: string, record: IdempotencyRecord): void {
    this.store.putIdempotencyRecord(workItemId, record);
  }

  delete(workItemId: string, key: string): void {
    this.store.deleteIdempotencyRecord(workItemId, key);
  }
}

/* -------------------------------------------------------------------- the run ledger ---- */

/**
 * AgentOS's own history, read from its own logs.
 *
 * This is the port that decides whether a resumed run knows what it already did. It is the
 * only source of `host.read_run_history`, which is the only input to
 * `reality.stage_completed_previously` (amendment A-15) — the predicate that answers "did we
 * analyse this", which code existing cannot answer and an agent's recollection must not.
 *
 * The log is authoritative rather than `run.json`, because the projection is only written
 * when a run ends: a run that crashed mid-flight has a log and no projection, and reading the
 * projection would report that run as though it had never happened.
 *
 * **Nothing here is caught.** A log that cannot be read throws, the host operation turns the
 * throw into `UNAVAILABLE`, and the difference between "we could not look" and "there were
 * none" survives. Swallowing the error into a short list would be exactly the silent
 * re-analysis this port exists to prevent.
 */
export class StoreRunLedgerReader implements RunLedgerReader {
  constructor(private readonly store: RunStore) {}

  runs(workItemId: string): readonly RunLedgerEntry[] {
    if (!this.store.workItemExists(workItemId)) return [];
    const entries: RunLedgerEntry[] = [];
    for (const runId of this.store.listRuns(workItemId)) {
      const log = this.store.readRunLog(workItemId, runId);
      const projection = project(log.records);
      entries.push({
        run_id: runId,
        work_item_id: workItemId,
        /* A run directory always precedes its first event, so a run interrupted between the
         * two has a log with nothing in it. It is reported with the time it can be shown to
         * have started and no stages, which is what it did. */
        started_at: projection.startedAt ?? log.records[0]?.at ?? '',
        ended_at: projection.endedAt,
        outcome: projection.outcome,
        stages_completed: stagesCompleted(projection.cursor),
      });
    }
    return entries;
  }

  children(workItemId: string): readonly ChildWorkItemEntry[] {
    const children: ChildWorkItemEntry[] = [];
    for (const id of this.store.listWorkItems()) {
      if (id === workItemId) continue;
      const child = this.store.getWorkItem(id);
      if (child === null) continue;
      const isChild = child.links.some(
        (link) => link.kind === 'CHILD_OF' && link.target === workItemId,
      );
      if (!isChild) continue;
      children.push({
        work_item_id: child.work_item_id,
        parent_work_item_id: workItemId,
        type: child.type,
        lifecycle: child.lifecycle,
        title: child.title,
      });
    }
    return children;
  }
}

/**
 * The stages a run actually completed.
 *
 * `COMPLETED` only. `COMPLETED_PRIOR` means an *earlier* run did the work and this one
 * accepted that, and counting it here would let one run's claim about another become evidence
 * about itself — a resumption laundering its own gap into a fact.
 */
function stagesCompleted(
  cursor: readonly { readonly stage: string; readonly state: string }[],
): readonly string[] {
  return cursor.filter((entry) => entry.state === 'COMPLETED').map((entry) => entry.stage);
}

/* ------------------------------------------------------------------ the human channel -- */

/**
 * How a question reaches the operator.
 *
 * Returns the answer, or `null` where none arrived. `null` is not a failure: the uncertainty
 * ladder's rung 4 is only distinguishable from rung 5 by whether an answer came back, and
 * silence is never consent.
 */
export type OperatorPrompt = (
  question: string,
  readings: readonly { readonly reading: string; readonly would_do: string }[],
) => Promise<string | null>;

/**
 * The CLI's human channel.
 *
 * `ask` reaches the operator, because the uncertainty ladder's fourth rung is a real rung and
 * a run that could never ask would climb straight from probing to blocking. Authorization is
 * a different matter: it answers `PENDING` and nothing else, because this build mutates
 * nothing, no gate can stop anything, and a channel that returned `GRANTED` would be handing
 * out permission for actions that do not exist. `PENDING` is what an unanswered request looks
 * like, and it is the answer that keeps the lifecycle honest until there is something to
 * authorize.
 */
export class CliHumanChannel implements HumanChannel {
  constructor(private readonly prompt: OperatorPrompt) {}

  ask(
    question: string,
    readings: readonly { readonly reading: string; readonly would_do: string }[],
  ): Promise<string | null> {
    return this.prompt(question, readings);
  }

  requestAuthorization(): Promise<'PENDING' | 'GRANTED' | 'DENIED'> {
    return Promise.resolve('PENDING');
  }
}

/** An operator who is not there. Every question goes unanswered, and none is invented. */
export const UNATTENDED_OPERATOR: OperatorPrompt = () => Promise.resolve(null);

/* ---------------------------------------------------------------------- helpers -------- */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
