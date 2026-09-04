import {
  SchemaRegistry,
  dispatchIdempotencyKey,
  workItemIdempotencyKey,
} from '@agentos/contracts';
import type {
  AdapterAvailability,
  AdapterCallContext,
  AdapterCallOutcome,
  AdapterOperationDescriptor,
  AdapterRegistry,
  BudgetPolicy,
  CallRecord,
  Classification,
  Clock,
  EvidencePolicy,
  ExecutionPolicy,
  IdempotencyLogEvent,
  IdempotencyRecord,
  JsonSchemaObject,
  Locator,
  MutationEvent,
  PathPolicy,
  PathRefusal,
  ReplayResult,
} from '@agentos/contracts';
import { CallLog, RefusalLog } from './call-log.js';
import {
  classify as classifyObservation,
  unprobed,
  type ClassificationKind,
  type ClassificationProbe,
} from './classification.js';
import type { ConfinedPath, DescriptorRegistry, OperationInvocation } from './descriptors.js';
import { comparatorFor } from './evidence.js';
import { isAbsent, messageOf } from './errors.js';
import { PathConfinement, type MandateScope, type PathVerdict } from './paths.js';
import {
  DENY_ALL_GRANTS,
  EMPTY_IDEMPOTENCY_LEDGER,
  NO_CAPABILITY_ATTRIBUTION,
  REFUSING_MUTATION_SINK,
  type AvailabilityProbe,
  type CapabilityAttribution,
  type GrantChecker,
  type IdempotencyLedger,
  type MutationSink,
} from './ports.js';
import { redactDeep, redactMessage, type RedactionHit } from './redaction.js';

/**
 * The adapter framework: the only path between agents and the world, built as an enforcement
 * layer rather than a convenience layer.
 *
 * Every check the kernel performs on an agent's claims is performed *through* here, which is
 * what makes this the system's single point of trust and the reason it is one place. The
 * order of the checks in `call()` is the substance of the file, and it is the order
 * REPOSITORY_ADAPTER and KERNEL_BOUNDARY state:
 *
 * 1. **Does the operation exist?** An unregistered operation is not refused, it is absent.
 * 2. **Are the arguments what the descriptor declared?** The `args_schema` is the granted
 *    tool surface; an argument outside it was never granted.
 * 3. **Path confinement.** Worktree root, then mandate, then the absolute deny-list — the
 *    third even for paths that passed the first two.
 * 4. **Is a mutation permitted here at all?** A mutating operation in a non-mutating stage is
 *    refused before anything else about it is considered.
 * 5. **Grants.** Checked here, at execution time, never by whatever asked for the operation.
 * 6. **Can the mutation be logged?** Asked before the mutation, because an adapter that
 *    cannot emit a mutation event must refuse the mutation and a refusal after the fact is
 *    not a refusal.
 * 7. **Idempotency, verified rather than trusted.** A work-item-scoped key hit re-reads the
 *    external resource: present returns the record, absent invalidates it and proceeds,
 *    unreachable is `ambiguous_state` and does nothing.
 * 8. **Execute**, then emit the mutation event before returning, then log the call.
 *
 * Every one of those steps logs, including the ones that refuse, because the call log is what
 * makes `coverage` checkable and a refusal nobody recorded is a refusal nobody can act on.
 */

export interface FrameworkOptions {
  readonly registry: DescriptorRegistry;
  readonly clock: Clock;
  readonly worktreeRoot: string;
  readonly installationRoot: string;
  readonly home: string;
  readonly paths: PathPolicy;
  readonly evidence: EvidencePolicy;
  readonly execution: ExecutionPolicy;
  readonly budgets: BudgetPolicy;
  readonly grants?: GrantChecker;
  readonly mutations?: MutationSink;
  readonly idempotency?: IdempotencyLedger;
  readonly capabilities?: CapabilityAttribution;
  readonly availabilityProbes?: readonly AvailabilityProbe[];
  readonly classificationProbes?: readonly ClassificationProbe[];
}

type Performed =
  | {
    readonly kind: 'OK';
    readonly value: unknown;
    readonly excerpt: string;
    readonly call: CallRecord;
    readonly mutations: readonly MutationEvent[];
  }
  | {
    readonly kind: 'REFUSED';
    readonly refusal: 'scope_violation' | 'security_violation' | 'grant_missing' | 'ambiguous_state';
    readonly message: string;
    readonly call: CallRecord;
  }
  | { readonly kind: 'ERROR'; readonly message: string; readonly call: CallRecord };

type Reread = 'PRESENT' | 'ABSENT' | 'UNREACHABLE';

export class AdapterFramework implements AdapterRegistry {
  readonly #registry: DescriptorRegistry;
  readonly #clock: Clock;
  readonly #confinement: PathConfinement;
  readonly #evidence: EvidencePolicy;
  readonly #execution: ExecutionPolicy;
  readonly #grants: GrantChecker;
  readonly #mutations: MutationSink;
  readonly #ledger: IdempotencyLedger;
  readonly #capabilities: CapabilityAttribution;
  readonly #availabilityProbes: readonly AvailabilityProbe[];
  readonly #classificationProbes: readonly ClassificationProbe[];
  readonly #calls: CallLog;
  readonly #refusals = new RefusalLog();
  readonly #idempotencyEvents: IdempotencyLogEvent['data'][] = [];
  readonly #redactions: RedactionHit[] = [];
  readonly #dispatchKeys = new Map<string, IdempotencyRecord>();
  #availability: readonly AdapterAvailability[];
  #argsSchemas: SchemaRegistry | null = null;
  #argsSchemaSize = -1;

  constructor(options: FrameworkOptions) {
    this.#registry = options.registry;
    this.#clock = options.clock;
    this.#confinement = new PathConfinement({
      worktreeRoot: options.worktreeRoot,
      installationRoot: options.installationRoot,
      home: options.home,
      paths: options.paths,
    });
    this.#evidence = options.evidence;
    this.#execution = options.execution;
    this.#grants = options.grants ?? DENY_ALL_GRANTS;
    this.#mutations = options.mutations ?? REFUSING_MUTATION_SINK;
    this.#ledger = options.idempotency ?? EMPTY_IDEMPOTENCY_LEDGER;
    this.#capabilities = options.capabilities ?? NO_CAPABILITY_ATTRIBUTION;
    this.#availabilityProbes = options.availabilityProbes ?? [];
    this.#classificationProbes = options.classificationProbes ?? [];
    this.#calls = new CallLog(options.budgets.read_call_log_granularity);

    /*
     * Before any probe has run, every adapter is UNAVAILABLE and says why. Not
     * NOT_CONFIGURED, which would claim knowledge about the host that nothing has looked for
     * yet, and not AVAILABLE, which would claim reach nobody has demonstrated.
     */
    this.#availability = this.#registry.families().map((adapter) => ({
      adapter,
      state: 'UNAVAILABLE' as const,
      detail:
        'availability has not been probed yet. Until it has, reach is unproven rather than '
        + 'absent',
      checked_at: this.#clock.now().toISOString(),
    }));
  }

  /* ------------------------------------------------------------------- the port ------ */

  descriptors(): readonly AdapterOperationDescriptor[] {
    return this.#registry.descriptors();
  }

  descriptor(adapter: string, op: string): AdapterOperationDescriptor | undefined {
    return this.#registry.get(adapter, op)?.descriptor;
  }

  availability(): readonly AdapterAvailability[] {
    return this.#availability;
  }

  async call(
    adapter: string,
    op: string,
    args: Readonly<Record<string, unknown>>,
    context: AdapterCallContext,
  ): Promise<AdapterCallOutcome> {
    const performed = await this.#perform(adapter, op, args, context);
    switch (performed.kind) {
      case 'OK':
        return {
          outcome: 'OK',
          value: performed.value,
          call: performed.call,
          mutations: performed.mutations,
        };
      case 'REFUSED':
        return {
          outcome: 'REFUSED',
          refusal: performed.refusal,
          message: performed.message,
          call: performed.call,
        };
      default:
        return { outcome: 'ERROR', message: performed.message, call: performed.call };
    }
  }

  /**
   * Evidence replay, restricted to `observation_safe` operations.
   *
   * The restriction is the point. An agent must not be able to use the evidence channel to
   * make the kernel perform a mutation on its behalf, so anything the descriptor does not
   * declare replayable is `REFUSED` — including an operation that is not registered at all,
   * because an operation nobody described is an operation nobody established the safety of.
   */
  async replay(locator: Locator, context: AdapterCallContext): Promise<ReplayResult> {
    if (locator.op === null) {
      return {
        outcome: 'UNREPLAYABLE',
        reason:
          'the locator declares no operation, which marks a genuinely unrepeatable '
          + 'observation. It caps the assertion it supports at INFERENCE rather than failing',
      };
    }

    const registration = this.#registry.get(locator.adapter, locator.op);
    if (registration === undefined) {
      return {
        outcome: 'REFUSED',
        reason:
          `${locator.adapter}.${locator.op} is not a registered operation, so nothing has `
          + 'established that replaying it is safe. An unknown operation is refused rather '
          + 'than attempted',
      };
    }

    if (!registration.descriptor.observation_safe) {
      return {
        outcome: 'REFUSED',
        reason:
          `${locator.adapter}.${locator.op} is not observation_safe, so the kernel may not `
          + 'replay it. Verification cannot itself mutate: an operation whose re-execution '
          + 'could alter authoritative state, consume what it measured, or reach outside its '
          + 'declared incidental artifacts is not a verification channel',
      };
    }

    if (comparatorFor(this.#evidence, registration.evidenceKind) === 'not_kernel_verifiable') {
      return {
        outcome: 'UNREPLAYABLE',
        reason:
          `${locator.adapter}.${locator.op} produces ${registration.evidenceKind} evidence, `
          + 'whose content is not kernel-verifiable. Its provenance is confirmed from the call '
          + 'log instead: the call that produced it is checked to have happened, against that '
          + 'locator, at that time',
      };
    }

    const performed = await this.#perform(locator.adapter, locator.op, locator.args, context);
    switch (performed.kind) {
      case 'OK':
        return { outcome: 'OK', value: performed.value, excerpt: performed.excerpt };
      case 'REFUSED':
        return { outcome: 'REFUSED', reason: performed.message };
      default:
        return { outcome: 'UNREPLAYABLE', reason: performed.message };
    }
  }

  async classify(kind: ClassificationKind, subject: string): Promise<Classification> {
    const probe = this.#classificationProbes.find((candidate) => candidate.kind === kind);
    if (probe === undefined) return unprobed(kind, subject);
    try {
      return classifyObservation(kind, subject, await probe.probe(subject));
    } catch (error) {
      /*
       * A probe that threw established nothing, and a thrown probe is the ordinary shape of
       * "the host would not answer". Fail closed, and record why.
       */
      return classifyObservation(kind, subject, {
        established: false,
        detail: `the ${kind} probe failed: ${redactMessage(messageOf(error), `classify.${kind}`)}`,
      });
    }
  }

  /* ------------------------------------------------------------------ observation ---- */

  /** Every call this framework made, reads included. */
  calls(): readonly CallRecord[] {
    return this.#calls.all();
  }

  /**
   * Every path refusal, kept whatever the run's outcome was.
   *
   * A security violation is reported regardless of how the run ended, because an agent that
   * attempted it is worth knowing about even if it failed.
   */
  refusals(): readonly PathRefusal[] {
    return this.#refusals.all();
  }

  idempotencyEvents(): readonly IdempotencyLogEvent['data'][] {
    return this.#idempotencyEvents;
  }

  /** What was redacted and where. The names and locations, never the values. */
  redactions(): readonly RedactionHit[] {
    return this.#redactions;
  }

  /** Runs every availability probe and replaces the cached snapshot. */
  async refreshAvailability(): Promise<readonly AdapterAvailability[]> {
    const checkedAt = this.#clock.now().toISOString();
    const byAdapter = new Map<string, AdapterAvailability>();

    for (const probe of this.#availabilityProbes) {
      try {
        const result = await probe.probe();
        byAdapter.set(probe.adapter, { ...result, checked_at: checkedAt });
      } catch (error) {
        /*
         * A probe that threw is a probe that could not reach what it was probing. That is
         * UNAVAILABLE — configured, and not answering — and never NOT_CONFIGURED, which
         * would be a claim about the host's setup that a failed reach cannot support.
         */
        byAdapter.set(probe.adapter, {
          adapter: probe.adapter,
          state: 'UNAVAILABLE',
          detail:
            'the availability probe failed: '
            + redactMessage(messageOf(error), `availability.${probe.adapter}`),
          checked_at: checkedAt,
        });
      }
    }

    this.#availability = this.#registry.families().map((adapter) => byAdapter.get(adapter) ?? {
      adapter,
      state: 'UNAVAILABLE',
      detail:
        'no availability probe is registered for this adapter, so its reach is unproven. '
        + 'Unproven is not the same as absent, and neither is the same as not configured',
      checked_at: checkedAt,
    });
    return this.#availability;
  }

  /* -------------------------------------------------------------------- the engine --- */

  async #perform(
    adapter: string,
    op: string,
    args: Readonly<Record<string, unknown>>,
    context: AdapterCallContext,
  ): Promise<Performed> {
    const startedAt = this.#clock.now();
    const startedMs = Date.now();
    const where = `${adapter}.${op}`;

    const registration = this.#registry.get(adapter, op);
    if (registration === undefined) {
      return this.#error(
        adapter, op, args, context, startedAt, startedMs, [], [],
        `${where} is not a registered adapter operation. Every operation carries a descriptor, `
        + 'and an operation with no descriptor does not exist rather than being permitted',
      );
    }
    const descriptor = registration.descriptor;

    const argsProblem = this.#validateArgs(descriptor, args);
    if (argsProblem !== null) {
      return this.#error(
        adapter, op, args, context, startedAt, startedMs, [], [],
        `${where} was called with arguments its descriptor does not admit: ${argsProblem}`,
      );
    }

    /* ------------------------------------------------------- 3. path confinement ---- */

    const mandate: MandateScope = context.mandate;
    const confined = new Map<string, ConfinedPath>();
    const touched: string[] = [];
    for (const name of pathArgumentNames(descriptor)) {
      const raw = args[name];
      if (raw === undefined || raw === null) continue;
      const candidates = Array.isArray(raw) ? raw : [raw];
      for (const candidate of candidates) {
        const verdict = this.#confinement.confine(adapter, op, candidate, mandate);
        if (verdict.outcome === 'REFUSED') {
          return this.#refuse(
            adapter, op, args, context, startedAt, startedMs, touched,
            verdict.refusal, verdict.record.detail, verdict.record,
          );
        }
        touched.push(verdict.relative);
        if (!Array.isArray(raw)) confined.set(name, verdict);
      }
    }

    /* ------------------------------------------------ 4-6. mutation preconditions --- */

    if (descriptor.mutating) {
      const refusal = this.#checkMutationPreconditions(descriptor, args, context, confined);
      if (refusal !== null) {
        return this.#refuse(
          adapter, op, args, context, startedAt, startedMs, touched,
          refusal.refusal, refusal.message, null,
        );
      }
    }

    /* ------------------------------------------------------- 7. idempotency -------- */

    let dispatchKey: string | null = null;
    let workItemKey: string | null = null;
    if (descriptor.mutating && descriptor.idempotent_by_key) {
      const dispatchId = context.dispatchId ?? '';
      dispatchKey = dispatchIdempotencyKey(context.runId, dispatchId, adapter, op, args);
      const dispatchHit = this.#dispatchKeys.get(dispatchKey);
      if (dispatchHit !== undefined) {
        this.#idempotency({
          key: dispatchKey,
          scope: 'dispatch',
          adapter,
          op,
          verdict: 'DEDUPLICATED',
          reread: 'NOT_ATTEMPTED',
          detail:
            'a dispatch-scoped key hit within one dispatch. A retried dispatch does not '
            + 'duplicate the effects of the attempt it is retrying',
        });
        return this.#ok(
          adapter, op, args, context, startedAt, startedMs, touched, [],
          dispatchHit.result, excerptOf(dispatchHit.result), 'DEDUPLICATED',
        );
      }

      if (usesWorkItemScope(descriptor)) {
        workItemKey = workItemIdempotencyKey(
          context.workItemId, adapter, op, args, descriptor.identity_args,
        );
        const record = this.#ledger.get(context.workItemId, workItemKey);
        if (record !== null) {
          const reread = await this.#reread(record, context);
          if (reread === 'PRESENT') {
            this.#idempotency({
              key: workItemKey,
              scope: 'work_item',
              adapter,
              op,
              verdict: 'DEDUPLICATED',
              reread,
              detail:
                'the external resource the record names is still there, so the recorded '
                + 'result stands and no work is performed',
            });
            return this.#ok(
              adapter, op, args, context, startedAt, startedMs, touched, [],
              record.result, excerptOf(record.result), 'DEDUPLICATED',
            );
          }
          if (reread === 'ABSENT') {
            this.#ledger.delete(context.workItemId, workItemKey);
            this.#idempotency({
              key: workItemKey,
              scope: 'work_item',
              adapter,
              op,
              verdict: 'IDEMPOTENCY_DIVERGENCE',
              reread,
              detail:
                'the external resource the record names is gone, so the record is stale. It '
                + 'is invalidated and the operation proceeds. A key hit that returned the '
                + 'recorded result here would be a cache, not idempotency',
            });
          } else {
            this.#idempotency({
              key: workItemKey,
              scope: 'work_item',
              adapter,
              op,
              verdict: 'AMBIGUOUS_STATE',
              reread,
              detail:
                'the external resource could not be re-read, so whether the recorded effect '
                + 'still exists is unknown. Returning the record would risk reporting work '
                + 'that is gone; re-executing would risk doing it twice. Neither is done',
            });
            return this.#refuse(
              adapter, op, args, context, startedAt, startedMs, touched,
              'ambiguous_state',
              `a work-item-scoped idempotency record exists for ${where} and the external `
              + 'resource it names could not be re-read. Unreachable is neither present nor '
              + 'absent, so nothing is returned and nothing is executed',
              null,
            );
          }
        }
      }
    }

    /* --------------------------------------------------------- 8. execute ---------- */

    const invocation: OperationInvocation = {
      args,
      context,
      now: startedAt,
      paths: confined,
      confine: (requested: unknown) => this.#confinement.confine(adapter, op, requested, mandate),
      redact: (value: unknown) => this.#redact(value, where),
    };

    let before: { readonly target: string; readonly before: Readonly<Record<string, unknown>> } | null = null;
    if (registration.captureBefore !== undefined) {
      try {
        before = await registration.captureBefore(invocation);
      } catch (error) {
        return this.#refuse(
          adapter, op, args, context, startedAt, startedMs, touched,
          'security_violation',
          `${where} could not read the state it is about to change, so its mutation event `
          + 'would carry no `before` and the change would be unloggable and unreversible: '
          + redactMessage(messageOf(error), where),
          null,
        );
      }
    }

    let result;
    try {
      result = await registration.handler(invocation);
    } catch (error) {
      if (isConfinementAbort(error)) {
        return this.#refuse(
          adapter, op, args, context, startedAt, startedMs, touched,
          error.verdict.refusal, error.verdict.record.detail, error.verdict.record,
        );
      }
      return this.#error(
        adapter, op, args, context, startedAt, startedMs, touched, [],
        `${where} failed: ${redactMessage(messageOf(error), where)}`,
      );
    }

    const allTouched = [...touched, ...(result.pathsTouched ?? [])];

    /* ------------------------------------------- emit the mutation before returning -- */

    const mutations: MutationEvent[] = [];
    if (descriptor.mutating) {
      const draft = result.mutation;
      if (draft === undefined || before === null || context.dispatchId === null) {
        return this.#refuse(
          adapter, op, args, context, startedAt, startedMs, allTouched,
          'security_violation',
          `${where} performed a mutation and produced no mutation event for it. A mutation `
          + 'that cannot be recorded must be refused, and one that was performed and cannot '
          + 'be recorded is reported as a security floor violation rather than as a success',
          null,
        );
      }
      const event: MutationEvent = {
        work_item_id: context.workItemId,
        run_id: context.runId,
        dispatch_id: context.dispatchId,
        adapter,
        op,
        target: draft.target,
        before: draft.before,
        after: draft.after,
        reversal: descriptor.reversal === null || draft.reversalArgs === null
          ? null
          : { op: descriptor.reversal.op, args: draft.reversalArgs },
        at: this.#clock.now().toISOString(),
      };
      try {
        this.#mutations.emit(event);
      } catch (error) {
        return this.#refuse(
          adapter, op, args, context, startedAt, startedMs, allTouched,
          'security_violation',
          `${where} performed a mutation and the mutation event could not be emitted: `
          + `${redactMessage(messageOf(error), where)}. The reversal record has to exist the `
          + 'moment the mutation does, and it does not',
          null,
        );
      }
      mutations.push(event);
    }

    /* ------------------------------------------------------- record the keys ------- */

    if (dispatchKey !== null) {
      this.#dispatchKeys.set(dispatchKey, {
        key: dispatchKey,
        scope: 'dispatch',
        adapter,
        op,
        result: result.value,
        external_locator: result.externalLocator ?? null,
        recorded_at: startedAt.toISOString(),
      });
      this.#idempotency({
        key: dispatchKey,
        scope: 'dispatch',
        adapter,
        op,
        verdict: 'RECORDED',
        reread: null,
        detail: 'the completed key is recorded so a retry of this dispatch performs no work',
      });
    }
    if (workItemKey !== null) {
      const record: IdempotencyRecord = {
        key: workItemKey,
        scope: 'work_item',
        adapter,
        op,
        result: result.value,
        external_locator: result.externalLocator ?? null,
        recorded_at: startedAt.toISOString(),
      };
      this.#ledger.put(context.workItemId, record);
      this.#idempotency({
        key: workItemKey,
        scope: 'work_item',
        adapter,
        op,
        verdict: 'RECORDED',
        reread: null,
        detail:
          'the completed key is recorded against the work item so a later run resolves to '
          + 'this effect rather than producing a second one',
      });
    }

    return this.#ok(
      adapter, op, args, context, startedAt, startedMs, allTouched, mutations,
      this.#redact(result.value, where),
      redactMessage(result.excerpt ?? excerptOf(result.value), where),
      'OK',
    );
  }

  /* ---------------------------------------------------------------- sub-decisions --- */

  /**
   * Steps 4 to 6, in one place because they share one refusal shape.
   *
   * They are ordered by how little they need to know: whether the stage may mutate at all,
   * then whether a human authorized this particular change, then whether the change could be
   * recorded if it happened.
   */
  #checkMutationPreconditions(
    descriptor: AdapterOperationDescriptor,
    args: Readonly<Record<string, unknown>>,
    context: AdapterCallContext,
    confined: ReadonlyMap<string, ConfinedPath>,
  ): { readonly refusal: 'security_violation' | 'grant_missing'; readonly message: string } | null {
    const where = `${descriptor.adapter}.${descriptor.op}`;

    if (!this.#execution.mutation_enabled) {
      return {
        refusal: 'security_violation',
        message:
          `${where} is a mutating operation and policies/execution.json declares `
          + 'mutation_enabled: false. The refusal is policy, evaluated here, and not a '
          + 'property of which operations happen to be registered',
      };
    }

    if (!context.stageMutating) {
      return {
        refusal: 'security_violation',
        message:
          `${where} mutates and this dispatch's stage does not. The stage descriptor declares `
          + 'whether the stage mutates, and a non-mutating stage may not reach a mutating '
          + 'operation — checked here, at execution, not remembered by the agent',
      };
    }

    const target = mutationTarget(descriptor, args, confined);
    for (const gate of descriptor.gates) {
      const verdict = this.#grants.check({
        gate,
        target,
        runId: context.runId,
        workItemId: context.workItemId,
        grantsHeld: context.grantsHeld,
        now: this.#clock.now(),
      });
      if (!verdict.ok) {
        return {
          refusal: 'grant_missing',
          message:
            `${where} requires a ${gate} grant on ${target} and none was established `
            + `(${verdict.code}): ${verdict.message}. A grant is checked by the adapter at `
            + 'execution time, never by the agent that requested it',
        };
      }
    }

    const emittable = this.#mutations.canEmit();
    if (!emittable.ok) {
      return {
        refusal: 'security_violation',
        message:
          `${where} mutates and its mutation event cannot be emitted: ${emittable.reason}. An `
          + 'adapter that cannot emit a mutation event refuses the mutation',
      };
    }

    if (context.dispatchId === null) {
      return {
        refusal: 'security_violation',
        message:
          `${where} mutates outside any dispatch. A mutation event names the dispatch that `
          + 'performed it, and one that cannot be attributed cannot be reversed on recovery',
      };
    }

    return null;
  }

  /**
   * Re-reads the external resource a work-item-scoped record names.
   *
   * The three answers are not interchangeable and the whole design of the check rests on
   * that: **present** means the effect is still there, **absent** means the record is stale,
   * and **unreachable** means nothing was established. A record with no `external_locator` is
   * unreachable by construction — there is no way to verify it, so it is not trusted.
   */
  async #reread(record: IdempotencyRecord, context: AdapterCallContext): Promise<Reread> {
    const locator = record.external_locator;
    if (locator === null || locator.op === null) {
      return 'UNREACHABLE';
    }
    const registration = this.#registry.get(locator.adapter, locator.op);
    if (registration === undefined || !registration.descriptor.observation_safe) {
      /* A re-read that could itself mutate is not a re-read. Nothing is established. */
      return 'UNREACHABLE';
    }
    try {
      const invocation: OperationInvocation = {
        args: locator.args,
        context,
        now: this.#clock.now(),
        paths: new Map(),
        confine: (requested: unknown) => this.#confinement.confine(
          locator.adapter, String(locator.op), requested, context.mandate,
        ),
        redact: (value: unknown) => this.#redact(value, `${locator.adapter}.${String(locator.op)}`),
      };
      await registration.handler(invocation);
      return 'PRESENT';
    } catch (error) {
      /*
       * Only an explicit absence counts as absence. Every other failure — a timeout, a 500, a
       * refused connection, an unclassified throw — is unreachable, which performs no work.
       * Reading silence as absence is how a system opens the same pull request twice.
       */
      return isAbsent(error) ? 'ABSENT' : 'UNREACHABLE';
    }
  }

  /** Validates arguments against the descriptor's own `args_schema`. */
  #validateArgs(
    descriptor: AdapterOperationDescriptor,
    args: Readonly<Record<string, unknown>>,
  ): string | null {
    const schemas = this.#schemas();
    const id = argsSchemaId(descriptor);
    if (!schemas.has(id)) return null;
    const result = schemas.validate(id, args);
    if (result.valid) return null;
    return result.errors
      .map((error) => `${error.instancePath || '(root)'} ${error.message}`)
      .join('; ');
  }

  #schemas(): SchemaRegistry {
    if (this.#argsSchemas !== null && this.#argsSchemaSize === this.#registry.size()) {
      return this.#argsSchemas;
    }
    const registry = new SchemaRegistry();
    for (const descriptor of this.#registry.descriptors()) {
      const schema = { ...(descriptor.args_schema as JsonSchemaObject), $id: argsSchemaId(descriptor) };
      registry.add(schema);
    }
    registry.seal();
    this.#argsSchemas = registry;
    this.#argsSchemaSize = this.#registry.size();
    return registry;
  }

  #redact(value: unknown, where: string): unknown {
    const result = redactDeep(value, where);
    this.#redactions.push(...result.hits);
    return result.value;
  }

  #idempotency(event: IdempotencyLogEvent['data']): void {
    this.#idempotencyEvents.push(event);
  }

  /* ------------------------------------------------------------------- outcomes ----- */

  #ok(
    adapter: string,
    op: string,
    args: Readonly<Record<string, unknown>>,
    context: AdapterCallContext,
    startedAt: Date,
    startedMs: number,
    touched: readonly string[],
    mutations: readonly MutationEvent[],
    value: unknown,
    excerpt: string,
    outcome: 'OK' | 'DEDUPLICATED',
  ): Performed {
    const call = this.#calls.record({
      adapter,
      op,
      args,
      dispatchId: context.dispatchId,
      pathsTouched: unique(touched),
      capabilitiesTouched: this.#capabilities.forPaths(unique(touched)),
      outcome,
      refusal: null,
      startedAt,
      durationMs: Date.now() - startedMs,
    });
    return { kind: 'OK', value, excerpt, call, mutations };
  }

  #refuse(
    adapter: string,
    op: string,
    args: Readonly<Record<string, unknown>>,
    context: AdapterCallContext,
    startedAt: Date,
    startedMs: number,
    touched: readonly string[],
    refusal: 'scope_violation' | 'security_violation' | 'grant_missing' | 'ambiguous_state',
    message: string,
    pathRefusal: PathRefusal | null,
  ): Performed {
    if (pathRefusal !== null) this.#refusals.add(pathRefusal);
    const call = this.#calls.record({
      adapter,
      op,
      args,
      dispatchId: context.dispatchId,
      pathsTouched: unique(touched),
      capabilitiesTouched: this.#capabilities.forPaths(unique(touched)),
      outcome: 'REFUSED',
      refusal,
      startedAt,
      durationMs: Date.now() - startedMs,
    });
    return { kind: 'REFUSED', refusal, message: redactMessage(message, `${adapter}.${op}`), call };
  }

  #error(
    adapter: string,
    op: string,
    args: Readonly<Record<string, unknown>>,
    context: AdapterCallContext,
    startedAt: Date,
    startedMs: number,
    touched: readonly string[],
    _mutations: readonly MutationEvent[],
    message: string,
  ): Performed {
    const call = this.#calls.record({
      adapter,
      op,
      args,
      dispatchId: context.dispatchId,
      pathsTouched: unique(touched),
      capabilitiesTouched: this.#capabilities.forPaths(unique(touched)),
      outcome: 'ERROR',
      refusal: null,
      startedAt,
      durationMs: Date.now() - startedMs,
    });
    return { kind: 'ERROR', message: redactMessage(message, `${adapter}.${op}`), call };
  }
}

/* ---------------------------------------------------------------------- helpers ------ */

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function argsSchemaId(descriptor: AdapterOperationDescriptor): string {
  return `urn:agentos:adapter-args:${descriptor.adapter}.${descriptor.op}`;
}

/**
 * Which arguments are paths, read from the descriptor's own schema.
 *
 * `format: "path"` is the marker. Declaring it in the schema rather than in a list beside it
 * means an operation cannot acquire a path argument without the confinement layer noticing,
 * which is the failure mode this is guarding: a new argument that happens to be a filename
 * and happens to be unchecked.
 */
function pathArgumentNames(descriptor: AdapterOperationDescriptor): readonly string[] {
  const schema = descriptor.args_schema as Record<string, unknown>;
  const properties = schema['properties'];
  if (properties === null || typeof properties !== 'object') return [];
  const out: string[] = [];
  for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue;
    const property = raw as Record<string, unknown>;
    if (property['format'] === 'path') {
      out.push(name);
      continue;
    }
    const items = property['items'];
    if (items !== null && typeof items === 'object'
      && (items as Record<string, unknown>)['format'] === 'path') {
      out.push(name);
    }
  }
  return out;
}

/** Work-item scope applies to a keyed operation that reaches outside or cannot be undone. */
function usesWorkItemScope(descriptor: AdapterOperationDescriptor): boolean {
  return descriptor.idempotent_by_key
    && (descriptor.external_destination || descriptor.reversal === null);
}

/**
 * What a grant is checked against.
 *
 * A grant names one gate, one target, one run. The target has to be derived the same way
 * every time or a grant would match by accident, so the order is fixed and narrow: the first
 * confined path, then the arguments a gate is naturally about, then the operation itself.
 */
function mutationTarget(
  descriptor: AdapterOperationDescriptor,
  args: Readonly<Record<string, unknown>>,
  confined: ReadonlyMap<string, ConfinedPath>,
): string {
  const first = [...confined.values()][0];
  if (first !== undefined) return first.relative;
  for (const name of ['target', 'branch', 'environment', 'base', 'ref', 'id']) {
    const value = args[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return `${descriptor.adapter}.${descriptor.op}`;
}

/** A compact, readable rendering of a value, for the evidence excerpt. */
function excerptOf(value: unknown): string {
  if (typeof value === 'string') return value;
  /* The three inputs `JSON.stringify` answers with `undefined` rather than with text. Named
   * here so the encoding below is total and the excerpt is never the string "undefined"
   * arriving from somewhere unexplained. */
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    /*
     * A cycle, or a `toJSON` that throws. The excerpt says so rather than rendering
     * `[object Object]`, which would look like a value and carry none.
     */
    return '[unrenderable value: it could not be encoded as JSON]';
  }
}

/**
 * A handler that confined a derived path and was refused throws this, so the refusal reaches
 * the framework as a refusal rather than as a generic error.
 */
export class ConfinementAbort extends Error {
  constructor(readonly verdict: Extract<PathVerdict, { outcome: 'REFUSED' }>) {
    super(verdict.record.detail);
    this.name = 'ConfinementAbort';
  }
}

function isConfinementAbort(error: unknown): error is ConfinementAbort {
  return error instanceof ConfinementAbort;
}
