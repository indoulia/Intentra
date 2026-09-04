import {
  type AdapterAvailability,
  type AdapterCallContext,
  type AdapterCallOutcome,
  type AdapterOperationDescriptor,
  type AdapterRegistry,
  type AgentCatalog,
  type AgentRole,
  type AgentSpecView,
  type AgentSubstrate,
  type Assertion,
  type Classification,
  type Clock,
  type ContextPackage,
  type DeepenRequest,
  type DiscoveryPort,
  type HostIdentity,
  type HumanChannel,
  type InputPackage,
  type Locator,
  type ModelEntry,
  type OrientRequest,
  type ProbeOutcome,
  type ProbeRequest,
  type RealityElement,
  type Registries,
  type ReplayResult,
  type Scope,
  type SkillEntry,
  type SubstrateResult,
  type ToolInvoker,
  type ToolGrant,
  type ToolSurfaceReport,
  type WorkItem,
} from '@agentos/contracts';
import { argsKey, recordedCall, type ReplayFixture } from './fixture.js';

/**
 * The ports a replay runs over.
 *
 * Every one of them answers from what was recorded and reaches nothing. That is the whole
 * point of `agentos replay`: the kernel's behaviour is a function of the envelopes it was
 * given, and a replay proves it by removing every other input. A recorded port that cannot
 * answer says so — it does not invent an answer, because an invented answer would make the
 * replay agree with the kernel for the wrong reason.
 */

/** A clock that does not move, so a replay of the same fixture produces the same run. */
export class FrozenClock implements Clock {
  constructor(private readonly iso: string) {}

  now(): Date {
    return new Date(this.iso);
  }
}

/**
 * A substrate that returns the recorded envelopes in order.
 *
 * Each dispatch first re-issues the calls the recording says that dispatch made, through the
 * kernel's own tool invoker and against the recorded adapter results. That is what makes the
 * reconciliations mean something on a replay: `coverage` and `artifacts_changed` are checked
 * against a real call log rather than against an empty one, and a replay that made no calls
 * would report every recorded envelope as having overstated its coverage — an artefact of the
 * replay masquerading as a finding about the run.
 *
 * A call the recording does not cover comes back as an error from the recorded adapters, and
 * a security refusal aborts the dispatch exactly as it would in a live run.
 */
export class RecordedSubstrate implements AgentSubstrate {
  readonly name = 'recorded';
  #index = 0;

  constructor(private readonly fixture: ReplayFixture) {}

  /** Which envelope files have been dispatched, in order, for the replay report. */
  readonly dispatchedFiles: string[] = [];

  conformance(grants: readonly ToolGrant[]): Promise<ToolSurfaceReport> {
    return Promise.resolve(this.#surface(grants.map((g) => g.tool_name)));
  }

  async dispatch(input: InputPackage, invoker: ToolInvoker): Promise<SubstrateResult> {
    const recorded = this.fixture.envelopes[this.#index];
    this.#index += 1;
    const surface = this.#surface(input.tools_granted.map((g) => g.tool_name));
    const cost = { input_tokens: 0, output_tokens: 0, usd: 0 };

    if (recorded === undefined) {
      return {
        outcome: 'FAILED',
        failure: 'SUBSTRATE_ERROR',
        detail:
          `the fixture records ${this.fixture.envelopes.length} envelope(s) and the run asked `
          + `for a ${this.#index}th. A replay that runs past its recording has nothing honest `
          + 'to return',
        toolSurface: surface,
        cost,
        model: input.model,
      };
    }

    this.dispatchedFiles.push(recorded.file);

    for (const call of recorded.calls) {
      const result = await invoker.invoke(call.tool, call.args);
      if (result.outcome === 'REFUSED' && result.abortDispatch) {
        return {
          outcome: 'FAILED',
          failure: 'SECURITY_VIOLATION',
          detail: result.message,
          toolSurface: surface,
          cost,
          model: input.model,
        };
      }
    }

    return {
      outcome: 'ENVELOPE',
      envelope: rebind(recorded.envelope, input),
      toolSurface: surface,
      cost,
      model: input.model,
    };
  }

  #surface(expected: readonly string[]): ToolSurfaceReport {
    return {
      substrate: this.name,
      verdict: 'CONFORMS',
      expected: [...expected],
      effective: [...expected],
      unexpected: [],
      missing: [],
      detail:
        'a replay reaches the world through the same invoker a live dispatch does, so its '
        + 'effective surface is the granted surface. This says nothing about the substrate the '
        + 'run was recorded from',
    };
  }
}

/**
 * Rebinds a recorded envelope's transport identifiers to the dispatch it is answering.
 *
 * A recording carries the ids of the run it was recorded from, and a replay allocates new
 * ones, so `run_id`, `work_item_id` and `dispatch_id` would never match and every recorded
 * envelope would be refused for `DISPATCH_ID_MISMATCH` — a fact about the replay, not about
 * the envelope.
 *
 * This is a transport concern and it is confined to the transport. The rule those fields
 * exist for is that **an agent** must answer the dispatch it was given, and here the recorded
 * substrate is what stands in for the agent: it is answering this dispatch, and saying so is
 * accurate. Nothing else is touched — status, evidence, coverage, `artifacts_changed`,
 * verdicts and proposals reach the kernel exactly as recorded, which is what the replay is
 * for.
 */
function rebind(envelope: unknown, input: InputPackage): unknown {
  if (envelope === null || typeof envelope !== 'object') return envelope;
  return {
    ...(envelope as Record<string, unknown>),
    run_id: input.run_id,
    work_item_id: input.work_item_id,
    dispatch_id: input.dispatch_id,
  };
}

/** Adapters that answer from recorded results and refuse anything not recorded. */
export class RecordedAdapterRegistry implements AdapterRegistry {
  #callNumber = 0;

  constructor(
    private readonly fixture: ReplayFixture,
    private readonly clock: Clock,
  ) {}

  descriptors(): readonly AdapterOperationDescriptor[] {
    return this.fixture.adapters.operations.map((op) => op.descriptor);
  }

  descriptor(adapter: string, op: string): AdapterOperationDescriptor | undefined {
    return this.descriptors().find((d) => d.adapter === adapter && d.op === op);
  }

  availability(): readonly AdapterAvailability[] {
    return this.fixture.adapters.availability ?? [];
  }

  call(
    adapter: string,
    op: string,
    args: Readonly<Record<string, unknown>>,
    context: AdapterCallContext,
  ): Promise<AdapterCallOutcome> {
    this.#callNumber += 1;
    const at = this.clock.now().toISOString();
    const recorded = this.fixture.adapters.operations.find(
      (entry) => entry.descriptor.adapter === adapter && entry.descriptor.op === op,
    );
    const key = argsKey(args);
    const value = recorded?.results?.[key] ?? recorded?.results?.['*'];

    if (recorded === undefined || value === undefined) {
      const call = recordedCall(
        this.#callNumber, adapter, op, args, context, 'ERROR', at,
      );
      return Promise.resolve({
        outcome: 'ERROR',
        message:
          `the fixture records no result for ${adapter}.${op} with these arguments. A replay `
          + 'answers from the recording or not at all',
        call,
      });
    }

    return Promise.resolve({
      outcome: 'OK',
      value,
      call: recordedCall(this.#callNumber, adapter, op, args, context, 'OK', at),
      /* A replay performs no mutation, so it emits no mutation events. */
      mutations: [],
    });
  }

  replay(locator: Locator, _context: AdapterCallContext): Promise<ReplayResult> {
    const recorded = this.fixture.adapters.operations.find(
      (entry) => entry.descriptor.adapter === locator.adapter
        && entry.descriptor.op === locator.op,
    );
    if (recorded?.replay !== undefined) return Promise.resolve(recorded.replay);
    return Promise.resolve({
      outcome: 'UNREPLAYABLE',
      reason:
        `the fixture records no replay for ${locator.adapter}.${locator.op}. Evidence whose `
        + 'replay was not recorded is UNVERIFIABLE, which is a different verdict from verified',
    });
  }

  classify(kind: Classification['kind'], subject: string): Promise<Classification> {
    const recorded = (this.fixture.adapters.classifications ?? []).find(
      (entry) => entry.kind === kind && entry.subject === subject,
    );
    if (recorded !== undefined) return Promise.resolve(recorded);
    /*
     * Fail closed. An unrecorded classification is not "not production": it is unknown, and
     * the conservative value with the confidence stated is what makes a run that was careful
     * because it was blind distinguishable from one that was careful because it had to be.
     */
    /*
     * The conservative value is the **dangerous** one, per kind. `unknown` is not a
     * conservative value for branch protection or for an environment: it matches no policy
     * expectation, so a classifier comparing it against `PROTECTED` or `PRODUCTION` would
     * silently fire nothing — a replay in which every gate quietly fails to fire, which is
     * the opposite of failing closed. REPOSITORY_ADAPTER section 2.3: branch protection
     * UNKNOWN or UNAVAILABLE means the branch is protected, and an unknown environment means
     * production.
     */
    const conservative: Readonly<Record<Classification['kind'], string>> = {
      branch_protection: 'PROTECTED',
      environment: 'PRODUCTION',
      observation_safety: 'unsafe',
      spawns_agents: 'true',
    };

    return Promise.resolve({
      subject,
      kind,
      value: conservative[kind],
      confidence: 'UNKNOWN',
      failed_closed: true,
      probe_detail:
        `the fixture records no ${kind} classification for ${subject}, and a replay probes `
        + `nothing. The dangerous value (${conservative[kind]}) is taken and the UNKNOWN `
        + 'confidence says why, so a run that was conservative because it was blind stays '
        + 'distinguishable from one that was conservative because the target really was that',
    });
  }
}

/** Discovery that returns the recorded Context Package and probes nothing. */
export class RecordedDiscovery implements DiscoveryPort {
  #version = 0;

  constructor(
    private readonly fixture: ReplayFixture,
    private readonly clock: Clock,
  ) {}

  orient(_request: OrientRequest): Promise<ContextPackage> {
    return Promise.resolve(this.#package(1));
  }

  deepen(_request: DeepenRequest): Promise<ContextPackage> {
    return Promise.resolve(this.#package(2));
  }

  probe(request: ProbeRequest): Promise<ProbeOutcome> {
    return Promise.resolve({
      probe: request.probe,
      assertions: {},
      evidence: [],
      available: false,
      detail:
        'a replay runs no probes. The recorded Context Package is the only reality it has, '
        + 'and reporting the probe unavailable is the honest answer',
    });
  }

  reprobeReality(
    element: RealityElement,
    _workItem: WorkItem | null,
    _scope: Scope,
  ): Promise<Assertion> {
    const reality = this.fixture.context?.current_reality;
    const existing = reality?.[element];
    if (existing !== undefined) return Promise.resolve(existing);
    return Promise.resolve({
      value: null,
      confidence: 'UNKNOWN',
      evidence: [],
      observed_at: this.clock.now().toISOString(),
      probe: 'replay.no-reprobe',
      freshness: 'UNKNOWN',
      reason: 'UNAVAILABLE',
      recoverable_by:
        `re-record the fixture with current_reality.${element} observed, or run `
        + 'against a live discovery port',
    });
  }

  #package(tier: 1 | 2): ContextPackage {
    this.#version += 1;
    const recorded = this.fixture.context;
    if (recorded === null) {
      throw new Error(
        `${this.fixture.directory} records no context.json, so there is no reality to run `
        + 'against. A replay with no Context Package would have the kernel decide against '
        + 'nothing, which is worse than refusing',
      );
    }
    return { ...recorded, meta: { ...recorded.meta, tier, package_version: this.#version } };
  }
}

/** The skills and models the recording offered the selection layer. */
export class RecordedRegistries implements Registries {
  constructor(private readonly fixture: ReplayFixture) {}

  skills(): Promise<readonly SkillEntry[]> {
    return Promise.resolve(this.fixture.skills);
  }

  models(): Promise<readonly ModelEntry[]> {
    return Promise.resolve(this.fixture.models);
  }
}

/** The agent specifications the recording used. */
export class RecordedAgents implements AgentCatalog {
  constructor(private readonly fixture: ReplayFixture) {}

  spec(role: AgentRole, mandate: string): AgentSpecView | undefined {
    return this.fixture.agents.find((s) => s.role === role && s.mandate_name === mandate);
  }

  all(): readonly AgentSpecView[] {
    return this.fixture.agents;
  }
}

/**
 * A human channel that answers nothing.
 *
 * A replay has no operator to ask, and inventing an answer would be inventing the one input
 * the design says a model may never supply. Every question goes unanswered and every
 * authorization stays `PENDING`, which is what a run blocked on a human looks like.
 */
export class NoHuman implements HumanChannel {
  ask(): Promise<string | null> {
    return Promise.resolve(null);
  }

  requestAuthorization(): Promise<'PENDING' | 'GRANTED' | 'DENIED'> {
    return Promise.resolve('PENDING');
  }
}

/** The host a replay runs as: the operator who invoked the CLI, over recorded input. */
export function replayHost(): HostIdentity {
  return {
    host: 'host.replay',
    principal: null,
    trustClass: 'EXTERNAL',
  };
}

/**
 * A deterministic sampler.
 *
 * Evidence selection samples, and a replay that sampled differently each time would make an
 * integrity event unarguable. Seeded from the fixture directory so two different fixtures do
 * not sample identically for no reason.
 */
export function seededSampler(seed: string): () => number {
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619) >>> 0;
  }
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
