import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { validators, type Event, type HandoffEnvelope, type IntakeRecord, type RunRecord, type WorkItem, type IdempotencyRecord } from '@agentos/contracts';
import { NdjsonLog, type ReadResult } from './ndjson.js';
import { StateLayout, RUN_SUBDIRECTORIES, assertSafeId, type RunSubdirectory } from './layout.js';

/**
 * The durable run store, and the only writer to `state/`.
 *
 * Agents produce envelopes; the kernel persists them. An agent that can write run state can
 * rewrite history, which is why this package is reachable only from `core/` — the manifests
 * say so and `.dependency-cruiser.cjs` enforces it.
 *
 * Nothing here interprets an event. The store appends, reads and projects; what an event
 * *means* is the kernel's, and keeping that split is what makes "recovery is a pure function
 * of the log" a property of one small module rather than a hope about a large one.
 */

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

export interface LeaseInfo {
  readonly run_id: string;
  readonly acquired_at: string;
  readonly holder: string;
}

export type LeaseOutcome =
  | { readonly outcome: 'ACQUIRED'; readonly lease: LeaseInfo }
  | {
    /** Refused with the active run named, which is what makes "someone ran it twice" a refusal. */
    readonly outcome: 'REFUSED';
    readonly activeRunId: string;
    readonly heldSince: string;
    readonly holder: string;
  }
  | {
    readonly outcome: 'RECLAIMED';
    readonly lease: LeaseInfo;
    readonly abandonedRunId: string;
    readonly abandonedSince: string;
  };

/** Writes JSON atomically: write a temporary file, flush it, rename over the target. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const fd = openSync(temporary, 'wx');
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export class RunStore {
  readonly layout: StateLayout;

  constructor(root: string) {
    this.layout = new StateLayout(root);
  }

  /* ------------------------------------------------------------------- intake ---- */

  /**
   * The `IntakeRecord`, recorded verbatim before anything interprets it.
   *
   * It is stored outside any work item because it precedes one, and because a resolution
   * that fails admission must leave the intake behind: "a rejected proposal is re-dispatched
   * once with the failure named" needs the original text, and the original text is the one
   * thing no agent is permitted to have summarized.
   */
  putIntake(intake: IntakeRecord): void {
    assertSafeId('intake id', intake.intake_id);
    writeJsonAtomic(this.layout.intakeJson(intake.intake_id), intake);
  }

  /** The prologue log for an intake, written before a Work Item exists. */
  intakeLog(intakeId: string): NdjsonLog {
    assertSafeId('intake id', intakeId);
    return new NdjsonLog(this.layout.intakeLog(intakeId));
  }

  appendIntakeEvent(intakeId: string, event: Event): void {
    validators.event.parse(event, `intake event ${event.event}`);
    this.intakeLog(intakeId).append(event);
  }

  readIntakeLog(intakeId: string): ReadResult<Event> {
    return this.intakeLog(intakeId).read((value, line) =>
      validators.event.parse(value, `intake log line ${line}`));
  }

  getIntake(intakeId: string): IntakeRecord | null {
    assertSafeId('intake id', intakeId);
    const path = this.layout.intakeJson(intakeId);
    if (!existsSync(path)) return null;
    return validators.intakeRecord.parse(readJson(path), `intake ${intakeId}`);
  }

  /* --------------------------------------------------------------- work items ---- */

  workItemExists(workItemId: string): boolean {
    assertSafeId('work item id', workItemId);
    return existsSync(this.layout.workItemJson(workItemId));
  }

  listWorkItems(): readonly string[] {
    const dir = this.layout.workItemsDir;
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((entry) => existsSync(join(dir, entry, 'work-item.json')))
      .sort();
  }

  getWorkItem(workItemId: string): WorkItem | null {
    assertSafeId('work item id', workItemId);
    const path = this.layout.workItemJson(workItemId);
    if (!existsSync(path)) return null;
    return validators.workItem.parse(readJson(path), `work item ${workItemId}`);
  }

  /**
   * Writes the work item projection.
   *
   * A projection, not a source of truth: it is rebuildable from `events.ndjson`, and if the
   * two disagree the log wins. It exists so that "where does this piece of work stand" is
   * answerable without replaying anything.
   */
  putWorkItemProjection(workItem: WorkItem): void {
    assertSafeId('work item id', workItem.work_item_id);
    validators.workItem.parse(workItem, `work item ${workItem.work_item_id}`);
    writeJsonAtomic(this.layout.workItemJson(workItem.work_item_id), workItem);
  }

  workItemLog(workItemId: string): NdjsonLog {
    assertSafeId('work item id', workItemId);
    return new NdjsonLog(this.layout.workItemLog(workItemId));
  }

  appendWorkItemEvent(event: Event): void {
    validators.event.parse(event, `work item event ${event.event}`);
    this.workItemLog(event.work_item_id).append(event);
  }

  readWorkItemLog(workItemId: string): ReadResult<Event> {
    return this.workItemLog(workItemId).read((value, line) =>
      validators.event.parse(value, `work item log line ${line}`));
  }

  /* -------------------------------------------------------------------- lease ---- */

  /**
   * Acquires the single-active-run lease.
   *
   * Atomic by exclusive create. The case the lease exists for is two processes starting at
   * the same moment, which is exactly when a check-then-act loses — so there is no check.
   *
   * A lease whose holder is gone is reclaimable only after `lease_timeout`, and the
   * reclamation is logged with the abandoned run id. Without the timeout a crashed run holds
   * its work item forever; without the atomicity the lease does not do the one job it has.
   */
  acquireLease(
    workItemId: string,
    runId: string,
    holder: string,
    now: Date,
    timeoutMs: number,
  ): LeaseOutcome {
    assertSafeId('work item id', workItemId);
    assertSafeId('run id', runId);
    const path = this.layout.leaseFile(workItemId);
    mkdirSync(dirname(path), { recursive: true });
    const lease: LeaseInfo = { run_id: runId, acquired_at: now.toISOString(), holder };

    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, `${JSON.stringify(lease, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return { outcome: 'ACQUIRED', lease };
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }

    const existing = readJson(path) as LeaseInfo;
    const ageMs = now.getTime() - new Date(existing.acquired_at).getTime();
    if (ageMs < timeoutMs) {
      return {
        outcome: 'REFUSED',
        activeRunId: existing.run_id,
        heldSince: existing.acquired_at,
        holder: existing.holder,
      };
    }

    /*
     * Reclamation is a create-and-rename rather than a write in place, so two reclaimers
     * cannot interleave a partial write. Rename is atomic, so the last one wins — and the
     * winner is established by reading the file back, not by assuming the rename was ours.
     */
    const temporary = `${path}.claim-${process.pid}-${Date.now().toString(36)}`;
    const fd = openSync(temporary, 'wx');
    try {
      writeSync(fd, `${JSON.stringify(lease, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);

    const confirmed = readJson(path) as LeaseInfo;
    if (confirmed.run_id !== runId) {
      return {
        outcome: 'REFUSED',
        activeRunId: confirmed.run_id,
        heldSince: confirmed.acquired_at,
        holder: confirmed.holder,
      };
    }
    return {
      outcome: 'RECLAIMED',
      lease,
      abandonedRunId: existing.run_id,
      abandonedSince: existing.acquired_at,
    };
  }

  readLease(workItemId: string): LeaseInfo | null {
    const path = this.layout.leaseFile(workItemId);
    if (!existsSync(path)) return null;
    return readJson(path) as LeaseInfo;
  }

  /** Releases the lease, refusing if it is held by a different run. */
  releaseLease(workItemId: string, runId: string): boolean {
    const path = this.layout.leaseFile(workItemId);
    if (!existsSync(path)) return false;
    const existing = readJson(path) as LeaseInfo;
    if (existing.run_id !== runId) return false;
    unlinkSync(path);
    return true;
  }

  /* ---------------------------------------------------------------------- runs ---- */

  createRun(workItemId: string, runId: string): void {
    assertSafeId('work item id', workItemId);
    assertSafeId('run id', runId);
    const dir = this.layout.runDir(workItemId, runId);
    if (existsSync(dir)) {
      throw new StoreError(`run directory already exists: ${dir}`);
    }
    mkdirSync(dir, { recursive: true });
    for (const name of RUN_SUBDIRECTORIES) {
      mkdirSync(this.layout.runSubdir(workItemId, runId, name), { recursive: true });
    }
    this.runLog(workItemId, runId).ensure();
  }

  runExists(workItemId: string, runId: string): boolean {
    return existsSync(this.layout.runDir(workItemId, runId));
  }

  listRuns(workItemId: string): readonly string[] {
    const dir = this.layout.runsDir(workItemId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).sort();
  }

  runLog(workItemId: string, runId: string): NdjsonLog {
    assertSafeId('work item id', workItemId);
    assertSafeId('run id', runId);
    return new NdjsonLog(this.layout.runLog(workItemId, runId));
  }

  /**
   * Appends a run event.
   *
   * Validated before it is written. An unvalidatable event in the log would be an
   * unrecoverable run, and the log is the only thing recovery has.
   */
  appendRunEvent(event: Event): void {
    if (event.run_id === null) {
      throw new StoreError(`run event ${event.event} has no run_id`);
    }
    validators.event.parse(event, `run event ${event.event}`);
    this.runLog(event.work_item_id, event.run_id).append(event);
  }

  readRunLog(workItemId: string, runId: string): ReadResult<Event> {
    return this.runLog(workItemId, runId).read((value, line) =>
      validators.event.parse(value, `run log line ${line}`));
  }

  getRun(workItemId: string, runId: string): RunRecord | null {
    const path = this.layout.runJson(workItemId, runId);
    if (!existsSync(path)) return null;
    return validators.run.parse(readJson(path), `run ${runId}`);
  }

  putRunProjection(run: RunRecord): void {
    validators.run.parse(run, `run ${run.run_id}`);
    writeJsonAtomic(this.layout.runJson(run.work_item_id, run.run_id), run);
  }

  /* ------------------------------------------------------------------ envelopes ---- */

  /**
   * Persists an envelope immutably, including the verification results the kernel added.
   *
   * Immutable in the sense that matters: a second write under the same id is refused. An
   * envelope that could be rewritten would make the audit trail a claim about the present
   * rather than a record of the past.
   */
  putEnvelope(workItemId: string, runId: string, envelope: HandoffEnvelope): string {
    validators.handoffEnvelope.parse(envelope, `envelope ${envelope.envelope_id}`);
    assertSafeId('envelope id', envelope.envelope_id);
    const path = join(
      this.layout.runSubdir(workItemId, runId, 'envelopes'),
      `${envelope.envelope_id}.json`,
    );
    if (existsSync(path)) {
      throw new StoreError(`envelope ${envelope.envelope_id} is already persisted; envelopes are immutable`);
    }
    writeJsonAtomic(path, envelope);
    return path;
  }

  getEnvelope(workItemId: string, runId: string, envelopeId: string): HandoffEnvelope | null {
    assertSafeId('envelope id', envelopeId);
    const path = join(
      this.layout.runSubdir(workItemId, runId, 'envelopes'),
      `${envelopeId}.json`,
    );
    if (!existsSync(path)) return null;
    return validators.handoffEnvelope.parse(readJson(path), `envelope ${envelopeId}`);
  }

  listEnvelopes(workItemId: string, runId: string): readonly string[] {
    const dir = this.layout.runSubdir(workItemId, runId, 'envelopes');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  }

  /* ---------------------------------------------------- versioned run artifacts ---- */

  /**
   * Writes a versioned document under one of the run's subdirectories.
   *
   * The Context Package is versioned rather than appended: on-demand discovery produces a
   * new version, agents read one version, and superseded detail is retrievable from the
   * store rather than resident in every dispatch.
   */
  putVersioned(
    workItemId: string,
    runId: string,
    subdirectory: RunSubdirectory,
    version: number,
    value: unknown,
  ): string {
    if (!Number.isInteger(version) || version < 1) {
      throw new StoreError(`version must be a positive integer, got ${version}`);
    }
    const path = join(
      this.layout.runSubdir(workItemId, runId, subdirectory),
      `v${version}.json`,
    );
    if (existsSync(path)) {
      throw new StoreError(`${subdirectory}/v${version}.json already exists; versions are immutable`);
    }
    writeJsonAtomic(path, value);
    return `${subdirectory}/v${version}.json`;
  }

  getVersioned(
    workItemId: string,
    runId: string,
    subdirectory: RunSubdirectory,
    version: number,
  ): unknown {
    const path = join(
      this.layout.runSubdir(workItemId, runId, subdirectory),
      `v${version}.json`,
    );
    if (!existsSync(path)) return null;
    return readJson(path);
  }

  latestVersion(
    workItemId: string,
    runId: string,
    subdirectory: RunSubdirectory,
  ): number | null {
    const dir = this.layout.runSubdir(workItemId, runId, subdirectory);
    if (!existsSync(dir)) return null;
    const versions = readdirSync(dir)
      .map((f) => /^v(\d+)\.json$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => b - a);
    return versions[0] ?? null;
  }

  /** Writes a named document — an authorization request, a decision, an artifact. */
  putNamed(
    workItemId: string,
    runId: string,
    subdirectory: RunSubdirectory,
    name: string,
    value: unknown,
  ): string {
    assertSafeId('document name', name);
    const path = join(this.layout.runSubdir(workItemId, runId, subdirectory), `${name}.json`);
    writeJsonAtomic(path, value);
    return `${subdirectory}/${name}.json`;
  }

  getNamed(
    workItemId: string,
    runId: string,
    subdirectory: RunSubdirectory,
    name: string,
  ): unknown {
    assertSafeId('document name', name);
    const path = join(this.layout.runSubdir(workItemId, runId, subdirectory), `${name}.json`);
    if (!existsSync(path)) return null;
    return readJson(path);
  }

  listNamed(workItemId: string, runId: string, subdirectory: RunSubdirectory): readonly string[] {
    const dir = this.layout.runSubdir(workItemId, runId, subdirectory);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  }

  /* -------------------------------------------------- work-item idempotency ---- */

  /**
   * The work-item-scoped idempotency ledger.
   *
   * Kept beside the work item rather than inside a run, because across runs is where
   * duplicate external side effects actually come from. **A record here is authoritative
   * about the past and not about the present**: the adapter re-reads the external resource
   * before returning one, which is the difference between idempotency and a cache.
   */
  putIdempotencyRecord(workItemId: string, record: IdempotencyRecord): void {
    assertSafeId('work item id', workItemId);
    assertSafeId('idempotency key', record.key);
    writeJsonAtomic(this.layout.idempotencyRecord(workItemId, record.key), record);
  }

  getIdempotencyRecord(workItemId: string, key: string): IdempotencyRecord | null {
    assertSafeId('work item id', workItemId);
    assertSafeId('idempotency key', key);
    const path = this.layout.idempotencyRecord(workItemId, key);
    if (!existsSync(path)) return null;
    return readJson(path) as IdempotencyRecord;
  }

  /**
   * Removes an idempotency record whose external resource is confirmed absent.
   *
   * "Resource confirmed absent -> invalidate the record, log `idempotency_divergence`, and
   * perform the operation." The invalidation is a deletion because a record that says
   * something exists when it does not is worse than no record.
   */
  deleteIdempotencyRecord(workItemId: string, key: string): boolean {
    const path = this.layout.idempotencyRecord(workItemId, key);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }

  /* ------------------------------------------------------------------- utility ---- */

  /** Removes a work item and everything under it. Used by tests and by nothing else. */
  destroyWorkItem(workItemId: string): void {
    assertSafeId('work item id', workItemId);
    rmSync(this.layout.workItemDir(workItemId), { recursive: true, force: true });
  }
}
