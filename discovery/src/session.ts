import type {
  AdapterAvailability,
  AdapterCallContext,
  AdapterOperationDescriptor,
  AdapterRegistry,
  Assertion,
  CallRecord,
  Classification,
  Clock,
  Evidence,
  EvidenceKind,
  EvidencePredicate,
  Locator,
} from '@agentos/contracts';
import type { FreshnessClass, FreshnessWindows } from './assertions.js';
import { fact, inference, makeEvidence, unknown } from './assertions.js';

/**
 * The one door between a probe and the world.
 *
 * `discovery/` may not open a file, run a process or reach the network — that is
 * [KERNEL_BOUNDARY.md](../../docs/KERNEL_BOUNDARY.md) dependency rule 5, enforced by the
 * conformance check and by dependency-cruiser — so every probe observes through the
 * `AdapterRegistry` port, and every probe observes through *this*, so that four obligations
 * are discharged once instead of in each probe:
 *
 * 1. **Evidence is minted at the point of observation**, carrying the re-executable locator
 *    the kernel replays. A probe cannot forget to record how it knows something.
 * 2. **Access is classified rather than collapsed.** An adapter that is not configured, an
 *    adapter that is configured and unreachable, an operation the adapter does not offer, a
 *    refusal and an error are five different outcomes with five different recoveries. The one
 *    thing none of them is, is evidence that the thing does not exist.
 * 3. **Refusals are surfaced, never swallowed.** A `scope_violation` or a `security_violation`
 *    is AgentOS's own enforcement acting; recording it as "we found nothing there" would hide
 *    the most interesting event of the run. A security violation additionally aborts the
 *    session, and every probe that had not yet run is recorded as skipped for that reason.
 * 4. **Coverage is computed from the calls actually made**, not declared by the probe. The
 *    difference between "found nothing here" and "never looked here" is the difference the
 *    Context Package exists to keep, and a self-reported coverage number does not keep it.
 */

/** What an attempted observation actually produced. */
export type Observation =
  | {
    readonly outcome: 'OBSERVED';
    readonly value: unknown;
    readonly evidence: Evidence;
    readonly observedAt: string;
  }
  | {
    readonly outcome: 'NO_ACCESS';
    /**
     * `NOT_CONFIGURED` — nothing is attached, and nothing failed.
     * `UNAVAILABLE` — something is attached and could not be reached.
     * `DENIED` — reachable and refusing us.
     * `NO_OPERATION` — the adapter is there and does not offer this observation.
     */
    readonly state: AdapterAvailability['state'] | 'NO_OPERATION';
    readonly adapter: string;
    readonly op: string;
    readonly detail: string;
    readonly observedAt: string;
  }
  | {
    readonly outcome: 'REFUSED';
    readonly refusal: 'scope_violation' | 'security_violation' | 'grant_missing' | 'ambiguous_state';
    readonly adapter: string;
    readonly op: string;
    readonly message: string;
    readonly observedAt: string;
  }
  | {
    readonly outcome: 'ERROR';
    readonly adapter: string;
    readonly op: string;
    readonly message: string;
    readonly observedAt: string;
  };

/** A refusal, kept in its own list so that it can never be read as an absence. */
export interface ProbeRefusal {
  readonly adapter: string;
  readonly op: string;
  readonly refusal: 'scope_violation' | 'security_violation' | 'grant_missing' | 'ambiguous_state';
  readonly message: string;
  readonly call_id: string;
  readonly probe: string;
  readonly at: string;
}

export interface ObserveRequest {
  readonly probe: string;
  readonly adapter: string;
  readonly op: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly kind: EvidenceKind;
  /** Human-readable pointer. Never the basis of a check. */
  readonly ref: string;
  /** Mandatory for `log` and `metric` evidence. */
  readonly predicate?: EvidencePredicate;
  /**
   * A predicate derived from the observation itself.
   *
   * `log` and `metric` evidence is verified by re-evaluating the predicate the observation
   * satisfied rather than by comparing a volatile raw value — a log line that has since
   * rotated would otherwise mismatch for the wrong reason. That predicate is a statement
   * about what was seen, so it can only be written once the value is in hand, which is why it
   * arrives as a function rather than as a constant.
   */
  readonly predicateFrom?: (value: unknown) => EvidencePredicate | undefined;
}

export interface SessionOptions {
  readonly registry: AdapterRegistry;
  readonly context: AdapterCallContext;
  readonly clock: Clock;
  readonly windows: FreshnessWindows;
}

export class ProbeSession {
  readonly #registry: AdapterRegistry;
  readonly #context: AdapterCallContext;
  readonly #clock: Clock;
  readonly #windows: FreshnessWindows;
  readonly #calls: CallRecord[] = [];
  readonly #refusals: ProbeRefusal[] = [];
  #availability: Map<string, AdapterAvailability> | null = null;
  #abortedBy: ProbeRefusal | null = null;

  constructor(options: SessionOptions) {
    this.#registry = options.registry;
    this.#context = options.context;
    this.#clock = options.clock;
    this.#windows = options.windows;
  }

  get windows(): FreshnessWindows {
    return this.#windows;
  }

  now(): Date {
    return this.#clock.now();
  }

  nowIso(): string {
    return this.#clock.now().toISOString();
  }

  /** Every call this session made, reads included. Coverage is computed from it. */
  get calls(): readonly CallRecord[] {
    return this.#calls;
  }

  get refusals(): readonly ProbeRefusal[] {
    return this.#refusals;
  }

  /**
   * The security violation that ended the session, if one did.
   *
   * A security violation aborts immediately and is reported regardless of the run's outcome:
   * an attempt to reach outside the worktree is worth knowing about even when it failed, and
   * continuing to probe after one would be AgentOS quietly retrying a boundary it just hit.
   */
  get abortedBy(): ProbeRefusal | null {
    return this.#abortedBy;
  }

  /** The adapter availability table, read once per session. */
  availability(): readonly AdapterAvailability[] {
    return [...this.#availabilityMap().values()];
  }

  /**
   * What the registry says about one adapter.
   *
   * An adapter the registry does not mention at all is `NOT_CONFIGURED` rather than
   * `UNAVAILABLE`: nothing was attached, so nothing failed, and the recovery is attaching one
   * rather than fixing one.
   */
  adapterState(adapter: string): AdapterAvailability {
    const known = this.#availabilityMap().get(adapter);
    if (known !== undefined) return known;
    return {
      adapter,
      state: 'NOT_CONFIGURED',
      detail: `the adapter registry lists no ${adapter} adapter on this host, so nothing was `
        + 'attached and nothing failed',
      checked_at: this.nowIso(),
    };
  }

  /** Is the adapter attached and answering? Probes use this to decide whether to try at all. */
  reachable(adapter: string): boolean {
    return this.adapterState(adapter).state === 'AVAILABLE';
  }

  /**
   * Attempts one observation and classifies whatever came back.
   *
   * Nothing here ever returns a value the adapter did not produce. That is the whole
   * discipline of the layer: the caller receives either an observation with its evidence, or
   * a precise statement of why there is none.
   */
  async observe(request: ObserveRequest): Promise<Observation> {
    const observedAt = this.nowIso();

    if (this.#abortedBy !== null) {
      return {
        outcome: 'NO_ACCESS',
        state: 'DENIED',
        adapter: request.adapter,
        op: request.op,
        detail: `the probe session was aborted by a security violation on `
          + `${this.#abortedBy.adapter}.${this.#abortedBy.op}, so nothing after it was `
          + 'attempted',
        observedAt,
      };
    }

    const availability = this.adapterState(request.adapter);
    if (availability.state !== 'AVAILABLE') {
      return {
        outcome: 'NO_ACCESS',
        state: availability.state,
        adapter: request.adapter,
        op: request.op,
        detail: availability.detail === ''
          ? `the ${request.adapter} adapter reports ${availability.state}`
          : availability.detail,
        observedAt,
      };
    }

    const descriptor = this.#registry.descriptor(request.adapter, request.op);
    if (descriptor === undefined) {
      return {
        outcome: 'NO_ACCESS',
        state: 'NO_OPERATION',
        adapter: request.adapter,
        op: request.op,
        detail: `the ${request.adapter} adapter is available and offers no ${request.op} `
          + 'operation, so this observation has no way to be made on this host',
        observedAt,
      };
    }

    const result = await this.#registry.call(
      request.adapter,
      request.op,
      request.args,
      this.#context,
    );
    this.#calls.push(result.call);

    if (result.outcome === 'REFUSED') {
      const refusal: ProbeRefusal = {
        adapter: request.adapter,
        op: request.op,
        refusal: result.refusal,
        message: result.message,
        call_id: result.call.call_id,
        probe: request.probe,
        at: observedAt,
      };
      this.#refusals.push(refusal);
      if (result.refusal === 'security_violation') this.#abortedBy = refusal;
      return {
        outcome: 'REFUSED',
        refusal: result.refusal,
        adapter: request.adapter,
        op: request.op,
        message: result.message,
        observedAt,
      };
    }

    if (result.outcome === 'ERROR') {
      return {
        outcome: 'ERROR',
        adapter: request.adapter,
        op: request.op,
        message: result.message,
        observedAt,
      };
    }

    const locator: Locator = {
      adapter: request.adapter,
      /*
       * `op: null` marks a genuinely unrepeatable observation and caps the assertion it
       * supports at INFERENCE. An operation the adapter declares as not observation-safe is
       * exactly that: the kernel will not replay it, so evidence naming it cannot be checked,
       * so nothing resting on it may call itself a fact.
       */
      op: descriptor.observation_safe ? request.op : null,
      args: request.args,
    };

    const predicate = request.predicateFrom === undefined
      ? request.predicate
      : (request.predicateFrom(result.value) ?? request.predicate);

    return {
      outcome: 'OBSERVED',
      value: result.value,
      evidence: makeEvidence({
        kind: request.kind,
        locator,
        ref: request.ref,
        value: result.value,
        observedAt,
        reproducible: descriptor.observation_safe,
        ...(predicate === undefined ? {} : { predicate }),
      }),
      observedAt,
    };
  }

  /**
   * The adapter's fail-closed classification of a branch or an environment.
   *
   * Two facts gate everything dangerous — is this branch protected, is this environment
   * production — and both are discovered, and discovery can fail. The rule is that `UNKNOWN`
   * is treated as the dangerous case, and the adapter is where that rule lives
   * ([REPOSITORY_ADAPTER.md](../../docs/REPOSITORY_ADAPTER.md) section 2.2). Discovery asks
   * rather than deciding, and carries `failed_closed` through, so a run that was conservative
   * because it was blind stays distinguishable from one that was conservative because the
   * target really was production.
   */
  async classify(
    kind: Classification['kind'],
    subject: string,
  ): Promise<Classification | null> {
    if (this.#abortedBy !== null) return null;
    try {
      return await this.#registry.classify(kind, subject);
    } catch {
      /* A classifier that throws has not established anything, and the caller must see that
       * rather than a value. Returning null makes the caller state the gap. */
      return null;
    }
  }

  /** The declared operation surface, which is what "may this run do X autonomously" reads. */
  descriptors(): readonly AdapterOperationDescriptor[] {
    return this.#registry.descriptors();
  }

  /** An assertion for a value this session observed directly. */
  observedFact(
    probe: string,
    value: unknown,
    evidence: readonly Evidence[],
    freshnessClass: FreshnessClass,
    observedAt: string,
  ): Assertion {
    return fact({
      value,
      probe,
      observedAt,
      freshnessClass,
      windows: this.#windows,
      now: this.now(),
      evidence,
    });
  }

  /** An assertion derived from things this session observed. */
  derived(
    probe: string,
    value: unknown,
    derivedFrom: readonly string[],
    reasoning: string,
    freshnessClass: FreshnessClass,
    observedAt: string,
    evidence: readonly Evidence[] = [],
  ): Assertion {
    return inference({
      value,
      probe,
      observedAt,
      freshnessClass,
      windows: this.#windows,
      now: this.now(),
      derivedFrom,
      reasoning,
      evidence,
    });
  }

  /**
   * The honest answer when an observation could not be made.
   *
   * Every branch here produces `UNAVAILABLE` — a fact about access, never a fact about the
   * system — and the branches differ in `attempted` and `recoverable_by`, which is where the
   * distinction a reader acts on actually lives. `NOT_CONFIGURED` and `UNAVAILABLE` are also
   * carried structurally in `meta.adapter_availability`, so the difference between "this host
   * has no project-management access" and "the project-management server failed to connect"
   * survives into the package as data and not only as prose.
   *
   * Nothing here reaches for `NOT_APPLICABLE`. Saying the question is meaningless would let a
   * downstream agent dismiss it, and "we could not look" is not "there is nothing to see".
   */
  noAccess(probe: string, subject: string, observation: Observation): Assertion {
    const observedAt = observation.observedAt;
    if (observation.outcome === 'OBSERVED') {
      throw new Error(
        `noAccess called for ${subject}, which was observed. An observation that succeeded `
        + 'must not be recorded as an absence',
      );
    }

    if (observation.outcome === 'REFUSED') {
      return unknown({
        probe,
        observedAt,
        reason: 'UNAVAILABLE',
        attempted: `${observation.adapter}.${observation.op} was refused as a `
          + `${observation.refusal}: ${observation.message}. The refusal is AgentOS's own `
          + 'enforcement acting and is recorded as a refusal, not as an absence in the system '
          + 'under study',
        recoverableBy: observation.refusal === 'security_violation'
          ? 'investigate why discovery attempted a path on the absolute deny-list; the '
            + 'attempt is reported regardless of the outcome of the run'
          : 'widen the work item scope through resolution, or grant the missing access, and '
            + 're-probe',
      });
    }

    if (observation.outcome === 'ERROR') {
      return unknown({
        probe,
        observedAt,
        reason: 'UNAVAILABLE',
        attempted: `${observation.adapter}.${observation.op} was called and failed: `
          + observation.message,
        recoverableBy: `resolve the ${observation.adapter} adapter failure and re-probe `
          + subject,
      });
    }

    switch (observation.state) {
      case 'NOT_CONFIGURED':
        return unknown({
          probe,
          observedAt,
          reason: 'UNAVAILABLE',
          attempted: `no ${observation.adapter} adapter is configured on this host, so `
            + `${observation.adapter}.${observation.op} was never attempted. Nothing failed; `
            + 'there is nothing attached to ask',
          recoverableBy: `configure a ${observation.adapter} adapter and re-run discovery. `
            + 'Until then this is a gap in access and not an observation about the system',
        });
      case 'UNAVAILABLE':
        return unknown({
          probe,
          observedAt,
          reason: 'UNAVAILABLE',
          attempted: `the ${observation.adapter} adapter is configured and reported `
            + `UNAVAILABLE, so ${observation.adapter}.${observation.op} could not be `
            + `attempted: ${observation.detail}`,
          recoverableBy: `restore connectivity to the configured ${observation.adapter} `
            + 'source and re-probe. A configured source that cannot be reached is not an '
            + 'absent one',
        });
      case 'DENIED':
        return unknown({
          probe,
          observedAt,
          reason: 'UNAVAILABLE',
          attempted: `the ${observation.adapter} adapter is reachable and denied the request: `
            + observation.detail,
          recoverableBy: `grant AgentOS read access to the ${observation.adapter} source and `
            + 're-probe',
        });
      case 'NO_OPERATION':
        return unknown({
          probe,
          observedAt,
          reason: 'UNAVAILABLE',
          attempted: `the ${observation.adapter} adapter is available and offers no `
            + `${observation.op} operation: ${observation.detail}`,
          recoverableBy: `implement ${observation.adapter}.${observation.op} in the adapter, `
            + `or supply ${subject} from a source that can be observed`,
        });
      case 'AVAILABLE':
        /* The adapter said AVAILABLE and the call still produced no observation. Reporting it
         * as an absence in the system would be the exact failure this layer exists to
         * prevent, so it is an access gap with the contradiction stated. */
        return unknown({
          probe,
          observedAt,
          reason: 'UNAVAILABLE',
          attempted: `the ${observation.adapter} adapter reported AVAILABLE and `
            + `${observation.op} yielded no observation: ${observation.detail}`,
          recoverableBy: `re-probe ${subject}; if it recurs, the adapter's availability report `
            + 'and its behaviour disagree and the adapter is the thing to fix',
        });
      default:
        return unknown({
          probe,
          observedAt,
          reason: 'UNAVAILABLE',
          attempted: `${observation.adapter}.${observation.op} produced an unclassified `
            + `access state: ${observation.detail}`,
          recoverableBy: `re-probe ${subject}`,
        });
    }
  }

  /**
   * A value whose source could not be reached, stated without a specific failed call.
   *
   * Used where the absence is established from what other probes already found rather than
   * from a call of its own — a reconciliation axis whose whole section came back `UNKNOWN`,
   * for instance. It is still `UNAVAILABLE`, because it is still a fact about access.
   */
  unreachable(
    probe: string,
    attempted: string,
    recoverableBy: string,
    observedAt: string = this.nowIso(),
  ): Assertion {
    return unknown({
      probe,
      observedAt,
      reason: 'UNAVAILABLE',
      attempted,
      recoverableBy,
    });
  }

  /** A value the probe looked for, could look for, and did not find enough of to conclude. */
  insufficient(
    probe: string,
    attempted: string,
    recoverableBy: string,
    observedAt: string = this.nowIso(),
  ): Assertion {
    return unknown({
      probe,
      observedAt,
      reason: 'INSUFFICIENT_EVIDENCE',
      attempted,
      recoverableBy,
    });
  }

  /** A value nothing has attempted yet. Tier 1 uses it for everything tier 2 owns. */
  notComputed(
    probe: string,
    attempted: string,
    recoverableBy: string,
    observedAt: string = this.nowIso(),
  ): Assertion {
    return unknown({
      probe,
      observedAt,
      reason: 'NOT_COMPUTED',
      attempted,
      recoverableBy,
    });
  }

  /**
   * The question is a category error for this subject.
   *
   * Used sparingly and never for access. "There is no continuous integration in this
   * repository" makes "did CI pass for this head" meaningless; "we could not reach the CI
   * provider" does not, and collapsing the second into the first would let a run skip
   * validation because it failed to look.
   */
  notApplicable(
    probe: string,
    attempted: string,
    recoverableBy: string,
    observedAt: string = this.nowIso(),
  ): Assertion {
    return unknown({
      probe,
      observedAt,
      reason: 'NOT_APPLICABLE',
      attempted,
      recoverableBy,
    });
  }

  /** Sources disagree and no rule selects a winner. Silently picking one is a correctness bug. */
  conflicting(
    probe: string,
    attempted: string,
    recoverableBy: string,
    observedAt: string = this.nowIso(),
  ): Assertion {
    return unknown({
      probe,
      observedAt,
      reason: 'CONFLICTING',
      attempted,
      recoverableBy,
    });
  }

  #availabilityMap(): Map<string, AdapterAvailability> {
    if (this.#availability === null) {
      this.#availability = new Map(
        this.#registry.availability().map((entry) => [entry.adapter, entry]),
      );
    }
    return this.#availability;
  }
}
