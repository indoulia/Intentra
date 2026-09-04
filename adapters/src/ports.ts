import type {
  AdapterAvailability,
  AuthorizationGrant,
  Gate,
  IdempotencyRecord,
  MutationEvent,
} from '@agentos/contracts';

/**
 * The edges the adapter framework does not own, declared as ports and injected.
 *
 * Three of them exist because of the dependency rule rather than in spite of it. The grant
 * check lives in `core/` (KERNEL_BOUNDARY 7: "gates defined in `policies/`, request/grant
 * lifecycle in `core/`, enforcement at execution in `adapters/`"), the idempotency ledger is
 * durable run state and only the kernel writes `state/`, and mutation events are journal
 * entries the kernel appends. All three must nevertheless *execute inside the adapter, at
 * call time* — that is the whole point of putting enforcement here — so each arrives as a
 * function the composition root supplies and the adapter calls.
 *
 * Every one of them **fails closed by default**. A framework built with no grant checker
 * refuses every gated operation; one with no mutation sink refuses every mutation; one with
 * no work-item ledger treats every key hit as unverifiable. A missing collaborator is not
 * permission.
 */

/* ------------------------------------------------------------------ grant checking ----- */

export interface GrantCheckRequest {
  readonly gate: Gate;
  readonly target: string;
  readonly runId: string;
  readonly workItemId: string;
  /** Grant **ids**, which is all `AdapterCallContext` carries. The port resolves them. */
  readonly grantsHeld: readonly string[];
  readonly now: Date;
}

export type GrantVerdict =
  | { readonly ok: true; readonly grant: AuthorizationGrant }
  | {
    readonly ok: false;
    /** `GRANT_MISSING`, `GRANT_EXPIRED`, `GRANT_MISMATCHED` — the kernel's own codes. */
    readonly code: string;
    readonly message: string;
  };

/**
 * Resolves the held grant ids and checks one against a gate at the moment of execution.
 *
 * Supplied by `core/`, which owns `checkGrant`. The adapter never reimplements it and never
 * imports it; it calls this, and it calls it *after* the requester has stopped being able to
 * influence the answer.
 */
export interface GrantChecker {
  check(request: GrantCheckRequest): GrantVerdict;
}

/** The default: nothing is authorized. Used whenever no checker is supplied. */
export const DENY_ALL_GRANTS: GrantChecker = {
  check(request: GrantCheckRequest): GrantVerdict {
    return {
      ok: false,
      code: 'GRANT_MISSING',
      message:
        `no grant checker is wired into this adapter framework, so no grant for ${request.gate} `
        + `on ${request.target} can be established. An adapter with no way to check a grant `
        + 'refuses the operation rather than assuming one',
    };
  },
};

/* ------------------------------------------------------------------- mutation events --- */

export type MutationEmitVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Where a mutation event goes. The kernel appends it to the run log.
 *
 * `canEmit` is asked **before** the mutation is performed, because "an adapter that cannot
 * emit a mutation event must refuse the mutation" is only true if the refusal happens while
 * refusing is still possible. `emit` is then called before the call returns, so the reversal
 * record exists the moment the mutation does and survives a crash the envelope does not.
 */
export interface MutationSink {
  canEmit(): MutationEmitVerdict;
  emit(event: MutationEvent): void;
}

/** The default: no mutation can be recorded, so no mutation may be performed. */
export const REFUSING_MUTATION_SINK: MutationSink = {
  canEmit(): MutationEmitVerdict {
    return {
      ok: false,
      reason:
        'no mutation sink is wired into this adapter framework, so a mutation could not be '
        + 'logged. A mutation that cannot be recorded is refused: the reversal record has to '
        + 'exist the moment the mutation does',
    };
  },
  emit(): void {
    throw new Error(
      'no mutation sink is wired into this adapter framework; canEmit() refuses first and '
      + 'this is unreachable through the framework',
    );
  },
};

/* -------------------------------------------------------------- the idempotency ledger -- */

/**
 * The work-item-scoped completed-key ledger.
 *
 * Durable run state, so `state/` owns it and the kernel writes it (`RunStore`'s
 * `putIdempotencyRecord` / `getIdempotencyRecord` / `deleteIdempotencyRecord`). The adapter
 * reads and invalidates through this port, which is what lets the verified-hit rule execute
 * at call time without `adapters -> state` existing as a dependency.
 */
export interface IdempotencyLedger {
  get(workItemId: string, key: string): IdempotencyRecord | null;
  put(workItemId: string, record: IdempotencyRecord): void;
  delete(workItemId: string, key: string): void;
}

/**
 * The default: a ledger that records nothing and answers nothing.
 *
 * A framework wired this way never reports a key hit, so it never *skips* work on the
 * strength of a record it cannot verify. It will re-execute rather than deduplicate, which is
 * the conservative direction for a read-only build where no mutating operation is registered.
 */
export const EMPTY_IDEMPOTENCY_LEDGER: IdempotencyLedger = {
  get(): IdempotencyRecord | null {
    return null;
  },
  put(): void {
    /* Nothing is retained: a ledger that cannot persist must not pretend it did. */
  },
  delete(): void {
    /* Nothing to invalidate. */
  },
};

/* ------------------------------------------------------------------- the run ledger ---- */

/** One prior AgentOS run against a work item, as its own ledger recorded it. */
export interface RunLedgerEntry {
  readonly run_id: string;
  readonly work_item_id: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly outcome: string | null;
  /**
   * The stages this run actually completed.
   *
   * The only honest observation that an analysis happened (amendment A-15). Code existing
   * does not mean an audit was run; AgentOS's own ledger is what says it was, and
   * `reality.stage_completed_previously` reads nothing else.
   */
  readonly stages_completed: readonly string[];
}

/** A child work item AgentOS itself recorded, with the lifecycle state it is in. */
export interface ChildWorkItemEntry {
  readonly work_item_id: string;
  readonly parent_work_item_id: string;
  readonly type: string;
  readonly lifecycle: string;
  readonly title: string;
}

/**
 * Read-only access to AgentOS's own run ledger.
 *
 * The ledger lives under `state/`, which only the kernel writes and which neither `adapters/`
 * nor `discovery/` may reach — both are named in the dependency-cruiser rule that forbids it.
 * So it arrives here as an injected reader that `core/` backs with the run store, and the
 * observation reaches discovery the way every other observation does: through an adapter
 * operation, with a locator the kernel can replay.
 *
 * There is deliberately no default that answers. A framework with no reader reports
 * `UNAVAILABLE`, never an empty list — an empty list would read as "no prior run" and would
 * silently make a resumed run re-do the analysis it already did.
 */
export interface RunLedgerReader {
  runs(workItemId: string): readonly RunLedgerEntry[];
  children(workItemId: string): readonly ChildWorkItemEntry[];
}

/* ---------------------------------------------------------------------- availability ---- */

/** One adapter family's reachability probe. Distinguishing the four states is the job. */
export interface AvailabilityProbe {
  readonly adapter: string;
  probe(): Promise<Omit<AdapterAvailability, 'checked_at'>>;
}

/* --------------------------------------------------------------- capability attribution - */

/**
 * Maps the paths a call touched to capability ids, for `CallRecord.capabilities_touched`.
 *
 * The capability registry is WP-7, so nothing in this build can perform that mapping and the
 * default returns nothing. `[]` is the honest answer — coverage then reconciles on
 * `paths_touched` alone — and it is a great deal better than inventing an id that no registry
 * will ever contain.
 */
export interface CapabilityAttribution {
  forPaths(paths: readonly string[]): readonly string[];
}

export const NO_CAPABILITY_ATTRIBUTION: CapabilityAttribution = {
  forPaths(): readonly string[] {
    return [];
  },
};

/* --------------------------------------------------------------------- process access --- */

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** False when the command could not be started at all, which is not the same as failing. */
  readonly started: boolean;
}

/**
 * Running a command, as a port.
 *
 * Adapters are the one place a process may be spawned, and routing it through a port is what
 * lets the git adapter be tested against a scripted host rather than against whatever git
 * happens to be installed on the machine running the suite.
 */
export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly timeoutMs: number },
  ): Promise<ProcessResult>;
}

/* ------------------------------------------------------------------------- connectors --- */

/**
 * A reachable external system, or an honest account of why it is not.
 *
 * "Configured but unreachable" and "not configured" lead to different decisions — the second
 * is worth reporting to a human and the first is not — so the two are different values here
 * and stay different all the way into the Context Package.
 */
export interface Connector {
  readonly id: string;
  /** `null` when the host has no configuration for it at all. */
  readonly configured: boolean;
  fetch(resource: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}
