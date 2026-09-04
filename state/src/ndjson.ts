import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * The append-only log.
 *
 * Every recovery property in the design is "replay the log", so the log's own rules are the
 * foundation everything else rests on:
 *
 * - **The event log is authoritative.** `run.json` and `work-item.json` are projections and
 *   can be rebuilt from their logs. If they disagree, the log wins.
 * - **Every event is one newline-terminated line, appended and flushed.** Flushed matters:
 *   an event in a buffer is an event a power loss destroys, and the whole point of writing
 *   the dispatch intent before invoking the agent is that the write survives the crash.
 * - **A trailing partial line is discarded on recovery, and the discard is itself logged.**
 *   A partial line is never parsed, and never silently dropped.
 */

export interface AppendResult {
  /** The sequence number written. */
  readonly seq: number;
  readonly bytes: number;
}

export interface ReadResult<T> {
  readonly records: readonly T[];
  /**
   * A trailing partial line, if the file did not end with a newline. Present means a write
   * was interrupted; the caller logs the discard rather than parsing it.
   */
  readonly discardedPartialLine: string | null;
  /** Lines that parsed as JSON but were rejected by the caller's parser, with the reason. */
  readonly rejected: readonly { readonly line: number; readonly reason: string }[];
  /** The highest `seq` seen, or 0 for an empty log. */
  readonly lastSeq: number;
}

export class LogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogError';
  }
}

/**
 * One NDJSON log file.
 *
 * A file handle is opened, written, fsynced and closed per append rather than held open.
 * That is slower and it is what makes "appended and flushed" true of every event
 * individually, including the last one before a kill.
 */
export class NdjsonLog {
  constructor(readonly path: string) {}

  ensure(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      const fd = openSync(this.path, 'a');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }

  exists(): boolean {
    return existsSync(this.path);
  }

/**
   * Does the file end with a newline?
   *
   * A `false` answer means the last write was torn — a power loss mid-write — and appending
   * would concatenate the new record onto the partial one, producing a single corrupt line in
   * the *middle* of the log where recovery only ever looks at the end. So an append refuses,
   * loudly, and recovery repairs the tail first.
   */
  endsWithNewline(): boolean {
    if (!existsSync(this.path)) return true;
    const size = statSync(this.path).size;
    if (size === 0) return true;
    const fd = openSync(this.path, 'r');
    try {
      const tail = Buffer.alloc(1);
      readSync(fd, tail, 0, 1, size - 1);
      return tail[0] === 0x0a;
    } finally {
      closeSync(fd);
    }
  }

  #refuseTornTail(): void {
    if (this.endsWithNewline()) return;
    throw new LogError(
      `${this.path} ends with a partial line, so appending would corrupt a line in the middle `
      + 'of the log where recovery does not look. Recover the run first: the discard is '
      + 'logged and the tail is repaired, and only then is the log appendable again',
    );
  }

  /** Appends one record as a single newline-terminated line, flushed before returning. */
  append(record: unknown): AppendResult {
    const line = JSON.stringify(record);
    if (line.includes('\n')) {
      /* JSON.stringify escapes newlines inside strings, so this is unreachable for a plain
       * record. It is checked because "one event per line" is load-bearing for recovery: a
       * record carrying a raw newline would split into two lines, one of which would parse. */
      throw new LogError('a log record must not contain a raw newline');
    }
    this.#refuseTornTail();
    this.ensure();
    const fd = openSync(this.path, 'a');
    try {
      const bytes = writeSync(fd, `${line}\n`);
      fsyncSync(fd);
      const seq = (record as { seq?: unknown }).seq;
      return { seq: typeof seq === 'number' ? seq : 0, bytes };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Appends several records as one flushed write.
   *
   * Used only where the records are one indivisible fact — a projection rebuild, a batch of
   * adapter call records aggregated at policy granularity. Anything a crash must be able to
   * land between goes through `append`.
   */
  appendAll(records: readonly unknown[]): AppendResult {
    if (records.length === 0) return { seq: 0, bytes: 0 };
    const lines = records.map((record) => {
      const line = JSON.stringify(record);
      if (line.includes('\n')) throw new LogError('a log record must not contain a raw newline');
      return line;
    });
    this.#refuseTornTail();
    this.ensure();
    const fd = openSync(this.path, 'a');
    try {
      const bytes = writeSync(fd, `${lines.join('\n')}\n`);
      fsyncSync(fd);
      const last = records[records.length - 1] as { seq?: unknown };
      return { seq: typeof last.seq === 'number' ? last.seq : 0, bytes };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Reads every complete line.
   *
   * `parse` returns the record or throws; a throw records a rejection rather than aborting,
   * because one unparseable line in the middle of a log must not make the rest of the run
   * unrecoverable — but it is reported, because silently skipping it would be worse.
   */
  read<T>(parse: (value: unknown, line: number) => T): ReadResult<T> {
    if (!existsSync(this.path)) {
      return { records: [], discardedPartialLine: null, rejected: [], lastSeq: 0 };
    }
    const text = readFileSync(this.path, 'utf8');
    if (text.length === 0) {
      return { records: [], discardedPartialLine: null, rejected: [], lastSeq: 0 };
    }

    const endsWithNewline = text.endsWith('\n');
    const rawLines = text.split('\n');
    /* `split` on a newline-terminated file leaves a trailing empty element; on a file whose
     * last write was interrupted it leaves the partial line. That difference is the whole
     * torn-write detection. */
    const trailing = rawLines.pop() ?? '';
    const discardedPartialLine = endsWithNewline || trailing.length === 0 ? null : trailing;

    const records: T[] = [];
    const rejected: { line: number; reason: string }[] = [];
    let lastSeq = 0;
    for (const [index, line] of rawLines.entries()) {
      if (line.length === 0) continue;
      try {
        const value: unknown = JSON.parse(line);
        const record = parse(value, index + 1);
        records.push(record);
        const seq = (value as { seq?: unknown }).seq;
        if (typeof seq === 'number' && seq > lastSeq) lastSeq = seq;
      } catch (error) {
        rejected.push({
          line: index + 1,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { records, discardedPartialLine, rejected, lastSeq };
  }

  /**
   * Rewrites the log without its trailing partial line.
   *
   * Called by recovery after the discard has been logged. Truncation is done by rewriting
   * the complete prefix to a temporary file and renaming, so an interruption during the
   * repair cannot leave a log shorter than the events it had already recorded.
   */
  truncatePartialLine(): number {
    const text = readFileSync(this.path, 'utf8');
    const lastNewline = text.lastIndexOf('\n');
    const keep = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
    const discarded = text.length - keep.length;
    if (discarded === 0) return 0;
    const temporary = `${this.path}.repair`;
    const fd = openSync(temporary, 'w');
    try {
      writeSync(fd, keep);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    /* `renameSync` over an existing path is atomic on one filesystem, which is what makes
     * the repair itself crash-safe. */
    renameSync(temporary, this.path);
    return discarded;
  }

  /** Appends a raw line without a trailing newline. Used only to simulate a torn write. */
  appendRawForTest(text: string): void {
    this.ensure();
    appendFileSync(this.path, text, 'utf8');
  }
}
