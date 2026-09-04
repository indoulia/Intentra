import { fixtures as fx } from '@agentos/contracts';
import type {
  AdapterAvailability,
  AdapterCallContext,
  AdapterCallOutcome,
  AdapterOperationDescriptor,
  AdapterRegistry,
  CallRecord,
  Classification,
  Clock,
  Locator,
  MutationEvent,
  ReplayResult,
} from '@agentos/contracts';
import { OPS } from '../src/ops.js';

/**
 * A deterministic world, and the adapter registry that answers about it.
 *
 * Every test in this package drives discovery through this and nothing else: no filesystem, no
 * network, no clock that moves on its own. That is not only for speed. The property under test
 * is what discovery does with what an adapter said, and a double that answered "yes" to
 * whatever it was asked would make every honesty test pass for the wrong reason — so this one
 * really refuses a refused call, really fails a failed one, really omits an operation it does
 * not have, and really replays a locator against the same world the probe read.
 */

export class TestClock implements Clock {
  #now: Date;

  constructor(iso = fx.T1) {
    this.#now = new Date(iso);
  }

  now(): Date {
    return new Date(this.#now);
  }

  advance(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }
}

export const WINDOWS = {
  git: 300_000,
  runtime: 300_000,
  repository: 14_400_000,
  intent: 86_400_000,
  agentos: 86_400_000,
} as const;

export type Responder = (args: Readonly<Record<string, unknown>>) => unknown;

export interface FakeWorld {
  /** Adapter states. An adapter not named here is `AVAILABLE`. */
  readonly availability?: Readonly<Record<string, AdapterAvailability['state']>>;
  /** `adapter.op` to a value or a function of the arguments. */
  readonly responses?: Readonly<Record<string, unknown>>;
  /** `adapter.op` entries the registry does not declare at all. */
  readonly missingOps?: readonly string[];
  /** `adapter.op` to an error message the call fails with. */
  readonly errors?: Readonly<Record<string, string>>;
  /** `adapter.op` to a refusal kind the adapter answers with. */
  readonly refusals?: Readonly<
    Record<string, 'scope_violation' | 'security_violation' | 'grant_missing' | 'ambiguous_state'>
  >;
  /** `adapter.op` entries whose descriptor declares `observation_safe: false`. */
  readonly observationUnsafe?: readonly string[];
  /** `adapter.op` to a different value on replay, for the mismatch case. */
  readonly drift?: Readonly<Record<string, unknown>>;
  /** `adapter.op` entries the replay channel refuses. */
  readonly replayRefuses?: readonly string[];
  readonly classifications?: Readonly<Record<string, Classification>>;
  /** Paths the deny-list refuses on, producing a security violation. */
  readonly denied?: readonly string[];
}

/** Every operation the probe set knows how to ask for, so the default world is complete. */
export function allOperations(): readonly string[] {
  const out: string[] = [];
  for (const [adapter, ops] of Object.entries(OPS)) {
    for (const op of Object.values(ops)) out.push(`${adapter}.${op}`);
  }
  return out;
}

export class FakeAdapters implements AdapterRegistry {
  readonly calls: CallRecord[] = [];
  #callNumber = 0;

  constructor(private readonly world: FakeWorld = {}) {}

  descriptors(): readonly AdapterOperationDescriptor[] {
    const missing = new Set(this.world.missingOps ?? []);
    const unsafe = new Set(this.world.observationUnsafe ?? []);
    return allOperations()
      .filter((key) => !missing.has(key))
      .map((key) => {
        const [adapter = '', op = ''] = key.split('.');
        return fx.operationDescriptor({
          adapter,
          op,
          description: `${adapter} ${op}`,
          mutating: false,
          observation_safe: !unsafe.has(key),
        });
      });
  }

  descriptor(adapter: string, op: string): AdapterOperationDescriptor | undefined {
    return this.descriptors().find((d) => d.adapter === adapter && d.op === op);
  }

  availability(): readonly AdapterAvailability[] {
    const declared = this.world.availability ?? {};
    const adapters = ['repo', 'git', 'pm', 'runtime', 'host'];
    return adapters.map((adapter) => {
      const state = declared[adapter] ?? 'AVAILABLE';
      return {
        adapter,
        state,
        detail: detailFor(adapter, state),
        checked_at: fx.T1,
      };
    });
  }

  call(
    adapter: string,
    op: string,
    args: Readonly<Record<string, unknown>>,
    context: AdapterCallContext,
  ): Promise<AdapterCallOutcome> {
    this.#callNumber += 1;
    const key = `${adapter}.${op}`;
    const call: CallRecord = {
      call_id: `c_${String(this.#callNumber).padStart(3, '0')}`,
      dispatch_id: context.dispatchId,
      adapter,
      op,
      args_digest: JSON.stringify(args),
      paths_touched: pathsTouched(args),
      capabilities_touched: [],
      outcome: 'OK',
      refusal: null,
      aggregated_count: 1,
      started_at: fx.T1,
      duration_ms: 1,
    };

    const path = typeof args['path'] === 'string' ? args['path'] : null;
    if (path !== null && (this.world.denied ?? []).some((d) => path.startsWith(d))) {
      const refused: CallRecord = { ...call, outcome: 'REFUSED', refusal: 'security_violation' };
      this.calls.push(refused);
      return Promise.resolve({
        outcome: 'REFUSED',
        refusal: 'security_violation',
        message: `${path} matches the absolute deny-list`,
        call: refused,
      });
    }

    const refusal = this.world.refusals?.[key];
    if (refusal !== undefined) {
      const refused: CallRecord = { ...call, outcome: 'REFUSED', refusal };
      this.calls.push(refused);
      return Promise.resolve({
        outcome: 'REFUSED',
        refusal,
        message: `${key} was refused as a ${refusal}`,
        call: refused,
      });
    }

    const error = this.world.errors?.[key];
    if (error !== undefined) {
      const failed: CallRecord = { ...call, outcome: 'ERROR' };
      this.calls.push(failed);
      return Promise.resolve({ outcome: 'ERROR', message: error, call: failed });
    }

    if (!(key in (this.world.responses ?? {}))) {
      const failed: CallRecord = { ...call, outcome: 'ERROR' };
      this.calls.push(failed);
      return Promise.resolve({
        outcome: 'ERROR',
        message: `the world records no result for ${key}`,
        call: failed,
      });
    }

    this.calls.push(call);
    return Promise.resolve({
      outcome: 'OK',
      value: resolve(this.world.responses?.[key], args),
      call,
      mutations: [] as readonly MutationEvent[],
    });
  }

  replay(locator: Locator, _context: AdapterCallContext): Promise<ReplayResult> {
    const key = `${locator.adapter}.${String(locator.op)}`;
    if ((this.world.replayRefuses ?? []).includes(key)) {
      return Promise.resolve({
        outcome: 'REFUSED',
        reason: `${key} is not observation_safe, so the kernel will not replay it`,
      });
    }
    if (locator.op === null || this.descriptor(locator.adapter, locator.op) === undefined) {
      return Promise.resolve({
        outcome: 'UNREPLAYABLE',
        reason: `${key} names no replayable operation`,
      });
    }
    if (key in (this.world.drift ?? {})) {
      const value = resolve(this.world.drift?.[key], locator.args);
      return Promise.resolve({ outcome: 'OK', value, excerpt: JSON.stringify(value) });
    }
    if (!(key in (this.world.responses ?? {}))) {
      return Promise.resolve({ outcome: 'UNREPLAYABLE', reason: `nothing recorded at ${key}` });
    }
    const value = resolve(this.world.responses?.[key], locator.args);
    return Promise.resolve({ outcome: 'OK', value, excerpt: JSON.stringify(value) });
  }

  classify(kind: Classification['kind'], subject: string): Promise<Classification> {
    const declared = this.world.classifications?.[subject];
    if (declared !== undefined) return Promise.resolve(declared);
    /* Fail-closed: an environment nobody could classify is production, and the record says the
     * classification failed closed rather than that the target really was production. */
    return Promise.resolve({
      subject,
      kind,
      value: kind === 'environment' ? 'PRODUCTION' : 'UNKNOWN',
      confidence: 'UNKNOWN',
      failed_closed: true,
      probe_detail: `no classifier answered for ${subject}`,
    });
  }
}

function resolve(value: unknown, args: Readonly<Record<string, unknown>>): unknown {
  return typeof value === 'function' ? (value as Responder)(args) : value;
}

function detailFor(adapter: string, state: AdapterAvailability['state']): string {
  switch (state) {
    case 'NOT_CONFIGURED':
      return `no ${adapter} adapter is attached to this host`;
    case 'UNAVAILABLE':
      return `the configured ${adapter} server failed to connect`;
    case 'DENIED':
      return `the ${adapter} source denied the request`;
    default:
      return '';
  }
}

function pathsTouched(args: Readonly<Record<string, unknown>>): readonly string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === 'string') out.push(entry);
    }
  };
  push(args['path']);
  push(args['under']);
  if (out.length === 0) push(args['globs']);
  return out;
}

export function callContext(overrides: Partial<AdapterCallContext> = {}): AdapterCallContext {
  return {
    workItemId: 'wi_c_subject',
    runId: 'run_test',
    dispatchId: null,
    mandate: { in_scope: [], out_of_scope: [] },
    grantsHeld: [],
    stageMutating: false,
    ...overrides,
  };
}
