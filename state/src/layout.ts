import { join, resolve } from 'node:path';

/**
 * The durable layout, exactly as WORKFLOW_STATE_MACHINE section 7 lays it out.
 *
 * ```
 * state/work-items/<work-item-id>/
 *   work-item.json      identity, type, outcome, scope, links, lifecycle, run lease
 *   lease.json          the atomically-created lease; separate so acquisition is a create
 *   events.ndjson       work-item-level log
 *   runs/<run-id>/
 *     run.json          identity, frozen graph, current stage, cursor, budgets consumed
 *     events.ndjson     append-only run log; the source of truth for this attempt
 *     context/          Context Package snapshots, including current_reality
 *     capabilities/     capability registry
 *     envelopes/        one file per agent handoff, immutable
 *     decisions/        arbitration, architecture and admission decisions
 *     authorizations/   requests and grants
 *     artifacts/        diffs, reports, screenshots, traces
 * ```
 *
 * Runs are addressable and inspectable without AgentOS running, which is the reason the
 * store is files (freeze D-3): every recovery property is "replay the log", and a log a
 * human can read with `cat` during an incident is worth more than one that needs a client.
 *
 * The lease lives in its own file rather than inside `work-item.json` because acquiring it
 * must be an *atomic create* — an exclusive create, or a create-and-rename, never a
 * read-then-write. A lease held inside a projection could only be taken by rewriting the
 * projection, which is a read-then-write, which loses exactly the race the lease exists for.
 */
export class StateLayout {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  get workItemsDir(): string {
    return join(this.root, 'work-items');
  }

  workItemDir(workItemId: string): string {
    return join(this.workItemsDir, workItemId);
  }

  workItemJson(workItemId: string): string {
    return join(this.workItemDir(workItemId), 'work-item.json');
  }

  workItemLog(workItemId: string): string {
    return join(this.workItemDir(workItemId), 'events.ndjson');
  }

  leaseFile(workItemId: string): string {
    return join(this.workItemDir(workItemId), 'lease.json');
  }

  runsDir(workItemId: string): string {
    return join(this.workItemDir(workItemId), 'runs');
  }

  runDir(workItemId: string, runId: string): string {
    return join(this.runsDir(workItemId), runId);
  }

  runJson(workItemId: string, runId: string): string {
    return join(this.runDir(workItemId, runId), 'run.json');
  }

  runLog(workItemId: string, runId: string): string {
    return join(this.runDir(workItemId, runId), 'events.ndjson');
  }

  runSubdir(workItemId: string, runId: string, name: RunSubdirectory): string {
    return join(this.runDir(workItemId, runId), name);
  }

  /** The intake records, which precede any work item and outlive the resolution that failed. */
  get intakeDir(): string {
    return join(this.root, 'intake');
  }

  intakeJson(intakeId: string): string {
    return join(this.intakeDir, intakeId, 'intake.json');
  }

  /**
   * The prologue log, written before a Work Item exists.
   *
   * `INTAKE_RECEIVED -> RESOLUTION -> CONTEXT_DISCOVERY -> UNDERSTOOD -> WORKFLOW_SELECTED`
   * runs in every run, and the first two of those happen before there is a work item to log
   * under. Buffering them in memory would mean a crash during resolution lost them, so they
   * are written here as they happen and replayed into the run log once the run exists — the
   * run's log is then whole from `INTAKE_RECEIVED`, and a resolution that never admitted
   * still leaves a record of why (decision I-16).
   */
  intakeLog(intakeId: string): string {
    return join(this.intakeDir, intakeId, 'events.ndjson');
  }

  /**
   * The work-item-scoped idempotency ledger. It sits beside the work item rather than inside
   * a run because its whole purpose is to survive across runs: "a run fails after opening a
   * PR, a new run starts against the same Work Item, and a second PR appears" is the failure
   * it exists to prevent.
   */
  idempotencyDir(workItemId: string): string {
    return join(this.workItemDir(workItemId), 'idempotency');
  }

  idempotencyRecord(workItemId: string, key: string): string {
    return join(this.idempotencyDir(workItemId), `${key}.json`);
  }
}

export type RunSubdirectory =
  | 'context'
  | 'capabilities'
  | 'envelopes'
  | 'decisions'
  | 'authorizations'
  | 'artifacts';

export const RUN_SUBDIRECTORIES: readonly RunSubdirectory[] = [
  'context',
  'capabilities',
  'envelopes',
  'decisions',
  'authorizations',
  'artifacts',
];

/**
 * Work item and run ids reach the filesystem as directory names, so they are checked before
 * being joined. An id is derived by the kernel from an external identity or from content,
 * never supplied by an agent — but a path built from an unchecked identifier is the kind of
 * thing that is safe until the day something else supplies one.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function assertSafeId(kind: string, id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `${kind} "${id}" is not usable as a directory name; ids are derived by the kernel and `
      + 'must match ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$',
    );
  }
}
