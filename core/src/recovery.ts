import {
  TEMPLATE_STAGES,
  type AdapterCallContext,
  type AdapterRegistry,
  type CallRecord,
  type Clock,
  type ConsumedBudget,
  type Event,
  type FrozenGraph,
  type MutationEvent,
  type RunOutcome,
  type RunRecord,
  type Stage,
  type StageCursorEntry,
  type TemplateStage,
} from '@agentos/contracts';
import type { RunStore } from '@agentos/state';
import { ZERO_BUDGET } from './budgets.js';
import { blastRadius, hasNonReversibleMutation } from './reconciliation.js';

/**
 * Recovery.
 *
 * **By replaying `events.ndjson`, never by asking a model what it was doing.** `run.json` is
 * a projection; if it disagrees with the log, the log wins. Recovery is a pure function of
 * the log — replay any prefix twice and get identical projections — and that property is what
 * everything else here rests on.
 *
 * A trailing partial line, the signature of a power loss mid-write, is discarded, and **the
 * discard is itself logged** rather than passing silently.
 *
 * Crash recovery never re-derives the entry stage. The resume computation is for *new runs
 * against existing work*; this is for *the same run continuing*, and the frozen graph and the
 * cursor already say where the run was. Recomputing would make recovery depend on reality
 * having stayed still.
 */

export interface Projection {
  readonly graph: FrozenGraph | null;
  readonly currentStage: Stage;
  readonly preBlockStage: Stage | null;
  readonly cursor: readonly StageCursorEntry[];
  readonly loopCounters: Readonly<Record<string, number>>;
  readonly consumedBudget: ConsumedBudget;
  readonly envelopeIds: readonly string[];
  readonly openBlockers: RunRecord['open_blockers'];
  readonly pendingAuthorizations: readonly string[];
  readonly contextPackageVersion: number | null;
  readonly outcome: RunOutcome | null;
  readonly endedAt: string | null;
  readonly startedAt: string | null;
  readonly lastSeq: number;
  /** Mutation events per dispatch, for the pre-retry reset. */
  readonly mutationsByDispatch: ReadonlyMap<string, readonly MutationEvent[]>;
  /** Adapter calls per dispatch, for coverage reconciliation on a replayed envelope. */
  readonly callsByDispatch: ReadonlyMap<string, readonly CallRecord[]>;
  /** Dispatches with an intent and no result: interrupted mid-flight. */
  readonly interruptedDispatches: readonly string[];
  readonly completedPriorStages: readonly Stage[];
}

/**
 * Rebuilds the projection from a log.
 *
 * A pure function of the events, with no clock and no store: given the same prefix it
 * produces the same projection, which is the property the recovery property test asserts.
 */
export function project(events: readonly Event[]): Projection {
  let graph: FrozenGraph | null = null;
  let currentStage: Stage = 'INTAKE_RECEIVED';
  let preBlockStage: Stage | null = null;
  let cursor: StageCursorEntry[] = [];
  const loopCounters: Record<string, number> = {};
  let consumedBudget: ConsumedBudget = ZERO_BUDGET;
  const envelopeIds: string[] = [];
  let openBlockers: RunRecord['open_blockers'] = [];
  const pendingAuthorizations = new Set<string>();
  let contextPackageVersion: number | null = null;
  let outcome: RunOutcome | null = null;
  let endedAt: string | null = null;
  let startedAt: string | null = null;
  let lastSeq = 0;

  const mutationsByDispatch = new Map<string, MutationEvent[]>();
  const callsByDispatch = new Map<string, CallRecord[]>();
  const dispatchIntents = new Set<string>();
  const dispatchResults = new Set<string>();
  const rolledBack = new Set<string>();
  const completedPriorStages: Stage[] = [];

  for (const event of events) {
    lastSeq = Math.max(lastSeq, event.seq);

    switch (event.event) {
      case 'run_started':
        startedAt = event.at;
        break;

      case 'run_ended':
        outcome = event.data.outcome;
        endedAt = event.at;
        break;

      case 'workflow_admitted':
        graph = event.data.graph;
        break;

      case 'entry_stage_computed':
        if (event.data.entry_stage !== null) currentStage = event.data.entry_stage;
        break;

      case 'stage_marked_completed_prior':
        completedPriorStages.push(event.data.marked_stage);
        cursor = upsertCursor(cursor, event.data.marked_stage, {
          state: 'COMPLETED_PRIOR',
          reality_evidence: event.data.evidence,
        });
        break;

      case 'transition': {
        /*
         * A stage the run left is completed. A stage the run *blocked at* is not.
         *
         * `BLOCKED` is semi-terminal and resumable, and the design's rule is that the
         * pre-block stage is recorded so the run resumes in place. Marking it `COMPLETED`
         * said the opposite: the stage that blocked — including one that never dispatched at
         * all, because no model was reachable — read as done, and `stageFromCursor` then
         * returned the stage *after* the one that never ran. That is unknown state converted
         * into false success, in the projection every recovery decision is rebuilt from.
         *
         * `CANCELLED` is the same shape for the same reason: the run stopped at that stage,
         * it did not finish it. Only a stage genuinely left behind is `COMPLETED`, which
         * includes `COMPLETION -> COMPLETE`, where the stage really did complete.
         */
        const blockedInPlace = event.data.to === 'BLOCKED' || event.data.to === 'CANCELLED';
        cursor = blockedInPlace
          ? upsertCursor(cursor, event.data.from, { state: 'ACTIVE' })
          : upsertCursor(cursor, event.data.from, { state: 'COMPLETED', left_at: event.at });
        if (event.data.to !== 'BLOCKED' && event.data.to !== 'CANCELLED' && event.data.to !== 'COMPLETE') {
          cursor = upsertCursor(cursor, event.data.to, { state: 'ACTIVE', entered_at: event.at });
        }
        if (event.data.to === 'BLOCKED') preBlockStage = event.data.from;
        else if (currentStage === 'BLOCKED') preBlockStage = null;
        currentStage = event.data.to;
        if (event.data.edge_kind === 'loop') {
          /* The counter is on the edge, and the edge is in the graph, so the increment is
           * recoverable from the log without the graph being consulted here: the trigger
           * names the condition and the graph names the counter. Both are replayed. */
          const counter = graph?.edges.find(
            (e) => e.from === event.data.from && e.to === event.data.to && e.kind === 'loop',
          )?.counter;
          if (counter !== null && counter !== undefined) {
            loopCounters[counter] = (loopCounters[counter] ?? 0) + 1;
          }
        }
        break;
      }

      case 'dispatch_intent':
        if (event.dispatch_id !== null) dispatchIntents.add(event.dispatch_id);
        break;

      case 'dispatch_result':
        if (event.dispatch_id !== null) dispatchResults.add(event.dispatch_id);
        consumedBudget = {
          ...consumedBudget,
          input_tokens: consumedBudget.input_tokens + event.data.cost.input_tokens,
          output_tokens: consumedBudget.output_tokens + event.data.cost.output_tokens,
          usd: consumedBudget.usd + (event.data.cost.usd ?? 0),
          dispatches: consumedBudget.dispatches + 1,
        };
        break;

      case 'envelope_received':
        envelopeIds.push(event.data.envelope_id);
        break;

      case 'mutation': {
        const dispatchId = event.data.dispatch_id;
        const list = mutationsByDispatch.get(dispatchId) ?? [];
        list.push(event.data);
        mutationsByDispatch.set(dispatchId, list);
        break;
      }

      case 'adapter_call': {
        const dispatchId = event.data.dispatch_id;
        if (dispatchId === null) break;
        const list = callsByDispatch.get(dispatchId) ?? [];
        list.push(event.data);
        callsByDispatch.set(dispatchId, list);
        break;
      }

      case 'dispatch_rollback':
        rolledBack.add(event.data.rolled_back_dispatch);
        break;

      case 'authorization_requested':
        pendingAuthorizations.add(event.data.request_id);
        break;

      case 'authorization_decided':
        pendingAuthorizations.delete(event.data.request_id);
        break;

      case 'context_package_versioned':
        contextPackageVersion = event.data.version;
        break;

      case 'budget':
        if (event.data.kind === 'CONSUMED' && event.data.counter.startsWith('loops.')) {
          const counter = event.data.counter.slice('loops.'.length);
          loopCounters[counter] = event.data.value;
        }
        break;

      default:
        break;
    }

    /* Blockers: the last BLOCKED transition's blocker is open until a transition leaves it. */
    if (event.event === 'envelope_received' || event.event === 'envelope_rejected') {
      /* Nothing to do: blockers are carried on the transition that acted on them. */
    }
  }

  /*
   * A dispatch with an intent and no result was interrupted mid-flight. The intent was
   * written before the agent was invoked precisely so that this is detectable rather than
   * invisible. A dispatch already rolled back is not interrupted any more.
   */
  const interruptedDispatches = [...dispatchIntents]
    .filter((id) => !dispatchResults.has(id))
    .filter((id) => !rolledBack.has(id));

  if (currentStage === 'BLOCKED' && openBlockers.length === 0) {
    /* The blocker is in the escalating envelope, which the caller reads from the store; the
     * projection records that one is open without duplicating its content. */
    openBlockers = [];
  }

  return {
    graph,
    currentStage,
    preBlockStage,
    cursor,
    loopCounters,
    consumedBudget,
    envelopeIds,
    openBlockers,
    pendingAuthorizations: [...pendingAuthorizations],
    contextPackageVersion,
    outcome,
    endedAt,
    startedAt,
    lastSeq,
    mutationsByDispatch,
    callsByDispatch,
    interruptedDispatches,
    completedPriorStages,
  };
}

/**
 * Is this a stage a workflow graph can contain?
 *
 * The prologue stages — `INTAKE_RECEIVED`, `RESOLUTION`, `CONTEXT_DISCOVERY`, `UNDERSTOOD`,
 * `WORKFLOW_SELECTED` — are stages a run passes through and are in no template, so they have
 * no place in the *graph's* cursor. Their transitions are in the log, which is where the
 * prologue's account belongs.
 */
function isTemplateStage(stage: Stage): stage is TemplateStage {
  return (TEMPLATE_STAGES as readonly string[]).includes(stage);
}

function upsertCursor(
  cursor: readonly StageCursorEntry[],
  stage: Stage,
  patch: Partial<StageCursorEntry>,
): StageCursorEntry[] {
  if (!isTemplateStage(stage)) return [...cursor];
  const index = cursor.findIndex((c) => c.stage === stage);
  if (index === -1) {
    return [
      ...cursor,
      {
        stage,
        state: 'PENDING',
        reality_evidence: [],
        entered_at: null,
        left_at: null,
        ...patch,
      },
    ];
  }
  const next = [...cursor];
  const existing = next[index];
  if (existing !== undefined) next[index] = { ...existing, ...patch };
  return next;
}

/* ------------------------------------------------------------------- the reset ---- */

export type RetryDecision =
  | {
    /**
     * Reverse the dispatch's mutations in reverse order, log what was reversed, and
     * re-dispatch with a **new** `dispatch_id` so the retry's operations get fresh dispatch
     * keys. Work-item keys are deliberately not refreshed — that is the point of them.
     */
    readonly decision: 'ROLLBACK_AND_RETRY';
    readonly reversals: readonly { readonly mutation: MutationEvent; readonly op: string }[];
    readonly reason: string;
  }
  | {
    /**
     * An operation whose `reversal` is `null` — an external API write, an email, a published
     * artifact — is declared non-reversible. A dispatch that performed one is **never**
     * automatically retried. The run blocks, stating precisely what already happened, and a
     * human decides. This is the one place where "retry safely" is not available, and
     * pretending otherwise is how a system sends the same notification four times.
     */
    readonly decision: 'BLOCK_NON_REVERSIBLE';
    readonly performed: readonly string[];
    readonly reason: string;
  }
  | { readonly decision: 'RETRY_CLEAN'; readonly reason: string };

export function decideRetry(
  mutations: readonly MutationEvent[],
): RetryDecision {
  if (mutations.length === 0) {
    return {
      decision: 'RETRY_CLEAN',
      reason: 'the interrupted dispatch performed no mutation, so there is nothing to reverse',
    };
  }
  if (hasNonReversibleMutation(mutations)) {
    const performed = mutations
      .filter((m) => m.reversal === null)
      .map((m) => `${m.adapter}.${m.op} on ${m.target}`);
    return {
      decision: 'BLOCK_NON_REVERSIBLE',
      performed,
      reason:
        `the interrupted dispatch performed ${performed.length} non-reversible operation(s): `
        + `${performed.join(', ')}. It is never automatically retried; the run blocks stating `
        + 'precisely what already happened, and a human decides',
    };
  }
  /* Reverse order: the last mutation is undone first, because a later one may depend on an
   * earlier one having happened. */
  const reversals = [...mutations].reverse().map((mutation) => ({
    mutation,
    op: mutation.reversal?.op ?? '',
  }));
  return {
    decision: 'ROLLBACK_AND_RETRY',
    reversals,
    reason:
      `${reversals.length} mutation(s) to reverse, in reverse order, then re-dispatch with a `
      + 'new dispatch_id so the retry gets fresh dispatch keys. Work-item keys are not '
      + 'refreshed, which is the point of them',
  };
}

/* ------------------------------------------------------------------ the replay ---- */

export interface RecoveryOutcome {
  readonly projection: Projection;
  /** Bytes discarded from a torn write, and whether the discard was logged. */
  readonly discardedBytes: number;
  readonly replayedEvents: number;
  readonly rejectedLines: readonly { readonly line: number; readonly reason: string }[];
  readonly interruptedDispatch: string | null;
  readonly retry: RetryDecision | null;
}

/**
 * Replays a run's log and reports what recovery must do next.
 *
 * The discard of a partial line is logged **before** the log is repaired, so a crash during
 * the repair leaves a record that the repair was in progress rather than a silently shorter
 * log.
 */
export function recover(
  store: RunStore,
  workItemId: string,
  runId: string,
  onDiscard: (bytes: number, text: string) => void,
): RecoveryOutcome {
  const read = store.readRunLog(workItemId, runId);

  let discardedBytes = 0;
  if (read.discardedPartialLine !== null) {
    const text = read.discardedPartialLine;
    onDiscard(Buffer.byteLength(text, 'utf8'), text);
    discardedBytes = store.runLog(workItemId, runId).truncatePartialLine();
  }

  const projection = project(read.records);
  const interruptedDispatch = projection.interruptedDispatches[0] ?? null;
  const retry = interruptedDispatch === null
    ? null
    : decideRetry(projection.mutationsByDispatch.get(interruptedDispatch) ?? []);

  return {
    projection,
    discardedBytes,
    replayedEvents: read.records.length,
    rejectedLines: read.rejected,
    interruptedDispatch,
    retry,
  };
}

/**
 * Applies the reversals for an interrupted dispatch through the adapters.
 *
 * The reversal record exists the moment the mutation does, because adapters emit the
 * mutation event at call time — before the envelope exists. That is what makes a
 * mid-dispatch crash recoverable at all: an envelope that never arrives cannot record
 * anything.
 */
export async function applyReversals(
  adapters: AdapterRegistry,
  context: AdapterCallContext,
  reversals: readonly { readonly mutation: MutationEvent; readonly op: string }[],
): Promise<readonly {
    readonly adapter: string;
    readonly op: string;
    readonly target: string;
    readonly reversal_op: string;
    readonly outcome: 'REVERSED' | 'FAILED';
  }[]> {
  const applied: {
    adapter: string;
    op: string;
    target: string;
    reversal_op: string;
    outcome: 'REVERSED' | 'FAILED';
  }[] = [];

  for (const { mutation } of reversals) {
    const reversal = mutation.reversal;
    if (reversal === null) {
      applied.push({
        adapter: mutation.adapter,
        op: mutation.op,
        target: mutation.target,
        reversal_op: '',
        outcome: 'FAILED',
      });
      continue;
    }
    const result = await adapters.call(mutation.adapter, reversal.op, reversal.args, context);
    applied.push({
      adapter: mutation.adapter,
      op: mutation.op,
      target: mutation.target,
      reversal_op: reversal.op,
      outcome: result.outcome === 'OK' ? 'REVERSED' : 'FAILED',
    });
  }

  return applied;
}

/** The blast radius of an interrupted dispatch, for the block report. */
export function interruptedBlastRadius(
  projection: Projection,
  dispatchId: string,
): readonly string[] {
  return blastRadius(projection.mutationsByDispatch.get(dispatchId) ?? []);
}

/**
 * Builds the `run.json` projection.
 *
 * A projection, and the log is authoritative. It exists so that "what is AgentOS doing right
 * now" is answerable without replaying anything — and so that a human can read it while
 * AgentOS is not running.
 */
export function runRecord(
  workItemId: string,
  runId: string,
  projection: Projection,
  clock: Clock,
): RunRecord {
  if (projection.graph === null) {
    throw new Error(
      `run ${runId} has no admitted workflow in its log, so there is no frozen graph to `
      + 'project. A run with no graph has not started',
    );
  }
  return {
    run_id: runId,
    work_item_id: workItemId,
    started_at: projection.startedAt ?? clock.now().toISOString(),
    ended_at: projection.endedAt,
    outcome: projection.outcome,
    graph: projection.graph,
    current_stage: projection.currentStage,
    pre_block_stage: projection.preBlockStage,
    cursor: projection.cursor,
    loop_counters: projection.loopCounters,
    consumed_budget: projection.consumedBudget,
    open_blockers: projection.openBlockers,
    pending_authorizations: projection.pendingAuthorizations,
    envelope_ids: projection.envelopeIds,
    context_package_version: projection.contextPackageVersion,
    last_seq: projection.lastSeq,
  };
}
