import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fixtures as fx,
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
  type CallRecord,
  type Classification,
  type Clock,
  type ContextPackage,
  type CriterionVerdict,
  type CurrentReality,
  type DiscoveryPort,
  type Evidence,
  type HandoffEnvelope,
  type HostIdentity,
  type HumanChannel,
  type InputPackage,
  type Locator,
  type ModelEntry,
  type MutationEvent,
  type ProbeOutcome,
  type ProposedWorkItem,
  type RealityElement,
  type Registries,
  type ReplayResult,
  type Scope,
  type SkillEntry,
  type Stage,
  type SubstrateResult,
  type ToolGrant,
  type ToolInvoker,
  type ToolSurfaceReport,
  type WorkItem,
  type WorkflowProposal,
} from '@agentos/contracts';
import { loadPolicies, type PolicySet } from '@agentos/policies';
import { RunStore } from '@agentos/state';
import type { KernelPorts } from '../src/kernel.js';

/**
 * Test doubles for WP-3: the kernel as an envelope replayer.
 *
 * "Everything the kernel owns, running against recorded fixture envelopes with no model and
 * no repository. This is the recommended first increment and the checkpoint that matters
 * most: if this layer is right, a confused or adversarial agent can degrade a run's quality
 * and cannot corrupt its state."
 *
 * These are deliberately **not** mocks of the boundary being tested. The adapter double
 * really refuses a path outside its scope; the substrate double really returns whatever
 * envelope the fixture recorded, including a malformed one; the replay really compares an
 * excerpt. A double that answered "yes" to whatever the kernel asked would make every
 * disbelief test pass for the wrong reason.
 */

export class FixedClock implements Clock {
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

  set(iso: string): void {
    this.#now = new Date(iso);
  }
}

/**
 * The real policy set with `admissible_risk_classes` widened to all four.
 *
 * v0.3 ships read-only: `policies/data/execution.json` admits `READ_ONLY` only, so every work
 * item type resolves to `investigation.readonly` however it was classified. That is the
 * milestone-1 safety property and there are tests asserting it. It also makes the *mechanics*
 * of template selection unexercisable, because there is never more than one candidate — so
 * these tests run those against a copy of the real policy data with that one line changed,
 * which is what enabling milestone 2 will be.
 */
export function policiesAllowingMutation(): PolicySet {
  const work = mkdtempSync(join(tmpdir(), 'agentos-policies-'));
  cpSync(policyDataRoot(), work, { recursive: true });
  const file = join(work, 'execution.json');
  const execution = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  execution['mutation_enabled'] = true;
  execution['admissible_risk_classes'] = [
    'READ_ONLY', 'LOCAL_MUTATION', 'EXTERNAL_MUTATION', 'IRREVERSIBLE',
  ];
  writeFileSync(file, `${JSON.stringify(execution, null, 2)}\n`, 'utf8');
  return loadPolicies(work);
}

/** Where `policies/data` is, found by walking up from this file. */
function policyDataRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    try {
      readFileSync(join(dir, 'policies', 'data', 'stages.json'));
      return join(dir, 'policies', 'data');
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error('could not locate policies/data');
}

/** A deterministic sampler, so a verification pass is reproducible. */
export function seededRandom(seed = 1): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/* ----------------------------------------------------------------- adapters ---- */

export interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

export interface FixtureAdapterOptions {
  /** Files the repository adapter can read. */
  readonly files?: readonly FixtureFile[];
  /** Paths the deny-list refuses, producing a security violation. */
  readonly denied?: readonly string[];
  /** Replay results keyed by `adapter.op`, for the evidence verifier. */
  readonly replays?: ReadonlyMap<string, ReplayResult>;
  /** Fail-closed classifications the adapter established. */
  readonly classifications?: readonly Classification[];
  /** Operations to register beyond the read-only defaults. */
  readonly extraOperations?: readonly AdapterOperationDescriptor[];
  /** Refuse every replay, as an adapter would for an operation that is not observation_safe. */
  readonly refuseReplay?: boolean;
}

/**
 * A read-only adapter registry.
 *
 * **No mutating operation is registered**, which is the MVP's posture: the mutation and
 * reversal frameworks exist and refuse any mutation they cannot log, and the refusal is
 * never reached because nothing mutates.
 */
export class FixtureAdapters implements AdapterRegistry {
  readonly calls: CallRecord[] = [];
  #callNumber = 0;

  constructor(private readonly options: FixtureAdapterOptions = {}) {}

  descriptors(): readonly AdapterOperationDescriptor[] {
    return [
      fx.operationDescriptor({
        adapter: 'repo',
        op: 'read_file',
        description: 'read a file inside the worktree',
      }),
      fx.operationDescriptor({
        adapter: 'repo',
        op: 'list_paths',
        description: 'list paths under a prefix',
        args_schema: {
          type: 'object',
          properties: { prefix: { type: 'string' } },
          required: ['prefix'],
          additionalProperties: false,
        },
      }),
      fx.operationDescriptor({
        adapter: 'git',
        op: 'read_pr',
        description: 'read a pull request and its review threads',
        args_schema: {
          type: 'object',
          properties: { number: { type: 'integer' } },
          required: ['number'],
          additionalProperties: false,
        },
      }),
      ...(this.options.extraOperations ?? []),
    ];
  }

  descriptor(adapter: string, op: string): AdapterOperationDescriptor | undefined {
    return this.descriptors().find((d) => d.adapter === adapter && d.op === op);
  }

  availability(): readonly AdapterAvailability[] {
    return [
      { adapter: 'repo', state: 'AVAILABLE', detail: '', checked_at: fx.T1 },
      { adapter: 'git', state: 'AVAILABLE', detail: '', checked_at: fx.T1 },
      {
        adapter: 'pm',
        state: 'NOT_CONFIGURED',
        detail: 'no project-management adapter is configured for this fixture',
        checked_at: fx.T1,
      },
    ];
  }

  async call(
    adapter: string,
    op: string,
    args: Readonly<Record<string, unknown>>,
    context: AdapterCallContext,
  ): Promise<AdapterCallOutcome> {
    this.#callNumber += 1;
    const path = typeof args['path'] === 'string' ? args['path'] : null;
    const call: CallRecord = {
      call_id: `c_${String(this.#callNumber).padStart(3, '0')}`,
      dispatch_id: context.dispatchId,
      adapter,
      op,
      args_digest: JSON.stringify(args),
      paths_touched: path === null ? [] : [path],
      capabilities_touched: [],
      outcome: 'OK',
      refusal: null,
      aggregated_count: 1,
      started_at: fx.T1,
      duration_ms: 1,
    };

    /* The deny-list, checked even for paths that pass the worktree and mandate checks. */
    if (path !== null && (this.options.denied ?? []).some((d) => path.startsWith(d))) {
      const refused: CallRecord = { ...call, outcome: 'REFUSED', refusal: 'security_violation' };
      this.calls.push(refused);
      return {
        outcome: 'REFUSED',
        refusal: 'security_violation',
        message:
          `${path} matches the absolute deny-list. A security violation aborts the dispatch `
          + "immediately and is reported regardless of the run's outcome",
        call: refused,
      };
    }

    /* The mandate, enforced here and not left to the receiving agent's discretion. */
    if (
      path !== null && context.mandate.in_scope.length > 0
      && !context.mandate.in_scope.some((entry) => path.startsWith(entry.replace(/\*+$/, '')))
    ) {
      const refused: CallRecord = { ...call, outcome: 'REFUSED', refusal: 'scope_violation' };
      this.calls.push(refused);
      return {
        outcome: 'REFUSED',
        refusal: 'scope_violation',
        message: `${path} falls outside the dispatch's mandate`,
        call: refused,
      };
    }

    const file = (this.options.files ?? []).find((f) => f.path === path);
    this.calls.push(call);
    return {
      outcome: 'OK',
      value: file?.content ?? null,
      call,
      mutations: [] as readonly MutationEvent[],
    };
  }

  /**
   * A replay, under the same mandate a call runs under.
   *
   * This double used to ignore its call context entirely, which is why no unit test noticed
   * that the kernel replayed the resolution envelope's evidence under a mandate admitting no
   * path at all. A double that ignores the constraint it is standing in for cannot fail the
   * way the real adapter fails, so it certifies the wrong thing. The rule is the real
   * `adapters/src/paths.ts` rule: `out_of_scope` beats `in_scope`, and an absent scope is not
   * an unlimited one — an empty `in_scope` admits nothing.
   */
  async replay(locator: Locator, context: AdapterCallContext): Promise<ReplayResult> {
    if (this.options.refuseReplay === true) {
      return {
        outcome: 'REFUSED',
        reason:
          `${locator.adapter}.${String(locator.op)} is not observation_safe, so the kernel `
          + 'will not replay it. Verification cannot itself mutate',
      };
    }

    const replayed = typeof locator.args['path'] === 'string' ? locator.args['path'] : null;
    if (replayed !== null) {
      const covers = (patterns: readonly string[]): boolean =>
        patterns.some((entry) => replayed.startsWith(entry.replace(/\*+$/, '')));
      if (covers(context.mandate.out_of_scope)) {
        return {
          outcome: 'REFUSED',
          reason: `${replayed} matches the mandate's out_of_scope patterns`,
        };
      }
      if (!covers(context.mandate.in_scope)) {
        return {
          outcome: 'REFUSED',
          reason: context.mandate.in_scope.length === 0
            ? `the mandate admits no paths at all, so ${replayed} is out of scope. An absent `
              + 'scope is not an unlimited one'
            : `${replayed} is not covered by the mandate's in_scope patterns `
              + `(${context.mandate.in_scope.join(', ')})`,
        };
      }
    }

    const key = `${locator.adapter}.${String(locator.op)}`;
    const recorded = this.options.replays?.get(key);
    if (recorded !== undefined) return recorded;

    const file = (this.options.files ?? []).find((f) => f.path === replayed);
    if (file === undefined) {
      return {
        outcome: 'UNREPLAYABLE',
        reason: `nothing at ${key} with ${JSON.stringify(locator.args)}`,
      };
    }
    return { outcome: 'OK', value: file.content, excerpt: file.content };
  }

  async classify(kind: Classification['kind'], subject: string): Promise<Classification> {
    const found = (this.options.classifications ?? []).find(
      (c) => c.kind === kind && c.subject === subject,
    );
    if (found !== undefined) return found;
    /* Fail closed: unknown branch protection means protected, unknown environment means
     * production, and the confidence records that it was a blind answer. */
    return {
      subject,
      kind,
      value: kind === 'branch_protection' ? 'PROTECTED' : 'PRODUCTION',
      confidence: 'UNKNOWN',
      failed_closed: true,
      probe_detail: 'no classification probe is configured in this fixture',
    };
  }
}

/* ---------------------------------------------------------------- discovery ---- */

export interface FixtureDiscoveryOptions {
  readonly reality?: Partial<CurrentReality>;
  /** Reality returned on a re-probe, where it differs from the snapshot. */
  readonly reprobed?: Partial<Record<RealityElement, Assertion>>;
  readonly sections?: Partial<Record<string, Record<string, Assertion>>>;
  readonly gaps?: ContextPackage['gaps'];
}

export class FixtureDiscovery implements DiscoveryPort {
  readonly reprobeCalls: RealityElement[] = [];
  #version = 0;

  constructor(private readonly options: FixtureDiscoveryOptions = {}) {}

  async orient(): Promise<ContextPackage> {
    return this.#package(1);
  }

  async deepen(): Promise<ContextPackage> {
    return this.#package(2);
  }

  async probe(request: { readonly probe: string }): Promise<ProbeOutcome> {
    return {
      probe: request.probe,
      assertions: {},
      evidence: [],
      available: true,
      detail: 'fixture probe',
    };
  }

  async reprobeReality(
    element: RealityElement,
    _workItem: WorkItem | null,
    _scope: Scope,
  ): Promise<Assertion> {
    this.reprobeCalls.push(element);
    const fresh = this.options.reprobed?.[element];
    if (fresh !== undefined) return fresh;
    const snapshot = this.#reality()[element];
    return snapshot;
  }

  #reality(): CurrentReality {
    return { ...fx.currentReality(), ...this.options.reality };
  }

  #package(tier: 1 | 2): ContextPackage {
    this.#version += 1;
    const empty = {};
    const sections = this.options.sections ?? {};
    return {
      meta: {
        run_id: 'run_20260904T100000Z_000001',
        work_item_id: null,
        package_version: this.#version,
        assembled_at: fx.T1,
        tier,
        probe_coverage: [{
          probe: 'repo.structure',
          section: 'repository',
          state: 'RAN',
          reason: null,
          scope_examined: ['**'],
          scope_not_examined: [],
          observed_at: fx.T1,
        }],
        adapter_availability: [],
      },
      work_item: null,
      current_reality: this.#reality(),
      repository: sections['repository'] ?? empty,
      product: sections['product'] ?? empty,
      capabilities: null,
      architecture: sections['architecture'] ?? empty,
      domain_model: sections['domain_model'] ?? empty,
      source_map: sections['source_map'] ?? empty,
      data_map: sections['data_map'] ?? empty,
      api_map: sections['api_map'] ?? empty,
      ui_map: sections['ui_map'] ?? empty,
      tests: sections['tests'] ?? empty,
      git_state: sections['git_state'] ?? { commit_count: fx.factAssertion(12) },
      runtime_state: sections['runtime_state'] ?? empty,
      production_state: sections['production_state'] ?? empty,
      intent: sections['intent'] ?? empty,
      reconciliation: [],
      agent_capabilities: sections['agent_capabilities'] ?? empty,
      model_capabilities: sections['model_capabilities'] ?? empty,
      constraints: sections['constraints'] ?? empty,
      authorization: sections['authorization'] ?? empty,
      gaps: this.options.gaps ?? [],
    };
  }
}

/* ---------------------------------------------------------------- registries ---- */

export class FixtureRegistries implements Registries {
  constructor(
    private readonly skillEntries: readonly SkillEntry[] = [],
    private readonly modelEntries: readonly ModelEntry[] = [defaultModel()],
  ) {}

  async skills(): Promise<readonly SkillEntry[]> {
    return this.skillEntries;
  }

  async models(): Promise<readonly ModelEntry[]> {
    return this.modelEntries;
  }
}

export function defaultModel(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: 'claude-opus-5',
    availability: { adapter: 'host.models', state: 'AVAILABLE', detail: '', checked_at: fx.T1 },
    context_window: 200_000,
    reasoning: 'deep',
    coding: 'strong',
    vision: 'strong',
    tool_use: 'strong',
    usd_per_mtok_input: 15,
    usd_per_mtok_output: 75,
    latency_class: 'medium',
    precision_class: 'high',
    ...overrides,
  };
}

export function spawningSkill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    id: 'orchestrate-subagents',
    source: 'plugin',
    description: 'runs a fleet of subagents',
    declared_inputs: [],
    declared_outputs: [],
    availability: { adapter: 'host.skills', state: 'AVAILABLE', detail: '', checked_at: fx.T1 },
    mutating: false,
    spawns_agents: true,
    spawns_agents_determined: true,
    external_destination: false,
    reversal: null,
    domains: ['repository_analysis'],
    operations: ['analyse'],
    targets: ['filesystem'],
    observed_success_rate: null,
    cost_hint: 'unknown',
    ...overrides,
  };
}

/* -------------------------------------------------------------------- agents ---- */

export class FixtureAgents implements AgentCatalog {
  constructor(private readonly specs: readonly AgentSpecView[] = defaultSpecs()) {}

  spec(role: AgentRole, mandate: string): AgentSpecView | undefined {
    return this.specs.find((s) => s.role === role && s.mandate_name === mandate)
      ?? this.specs.find((s) => s.role === role);
  }

  all(): readonly AgentSpecView[] {
    return this.specs;
  }
}

export function defaultSpecs(): readonly AgentSpecView[] {
  return [
    {
      role: 'context-discovery',
      mandate_name: 'resolution',
      version: '1.0',
      objective:
        'given an IntakeRecord, produce a proposed Work Item: intent, type, external '
        + 'identity, desired outcome, scope, constraints, dependencies, parent, alternatives',
      required_inputs: ['repository', 'git_state'],
      required_outputs: ['proposed_work_item'],
      permitted_adapters: ['repo', 'git', 'pm', 'runtime', 'host'],
      read_only: true,
      dod_criteria_owned: [1],
      model_requirement: {
        context: 'medium',
        reasoning: 'deep',
        coding: false,
        vision: false,
        tool_use: 'strong',
        precision: 'high',
      },
    },
    {
      role: 'context-discovery',
      mandate_name: 'context',
      version: '1.0',
      objective: 'build the Context Package and the current_reality set for this work item',
      required_inputs: ['repository', 'current_reality'],
      required_outputs: ['context_package', 'current_reality', 'gaps'],
      permitted_adapters: ['repo', 'git', 'pm', 'runtime', 'host'],
      read_only: true,
      dod_criteria_owned: [1],
      model_requirement: {
        context: 'large',
        reasoning: 'mid',
        coding: false,
        vision: false,
        tool_use: 'strong',
        precision: 'standard',
      },
    },
    {
      role: 'orchestrator',
      /* The name the real catalogue uses. Two spellings of it is decision K-1. */
      mandate_name: 'orchestration',
      version: '1.0',
      objective: 'propose a workflow template and its parameterization',
      required_inputs: ['current_reality', 'repository'],
      required_outputs: ['rationale'],
      permitted_adapters: [],
      read_only: true,
      dod_criteria_owned: [],
      model_requirement: {
        context: 'medium',
        reasoning: 'mid',
        coding: false,
        vision: false,
        tool_use: 'none',
        precision: 'standard',
      },
    },
    {
      role: 'auditor',
      mandate_name: 'audit',
      version: '1.0',
      objective:
        'build the capability graph over the work item scope and identify breaks, orphans '
        + 'and unsupported completeness claims',
      required_inputs: ['repository', 'current_reality'],
      required_outputs: ['capability_graph', 'findings_report', 'orphan_inventory'],
      permitted_adapters: ['repo', 'git'],
      read_only: true,
      dod_criteria_owned: [3, 4],
      model_requirement: {
        context: 'large',
        reasoning: 'deep',
        coding: false,
        vision: false,
        tool_use: 'strong',
        precision: 'high',
      },
    },
    {
      role: 'auditor',
      mandate_name: 'root_cause',
      version: '1.0',
      objective: 'explain why the observed behaviour occurs, with evidence',
      required_inputs: ['repository', 'current_reality'],
      required_outputs: ['root_cause', 'evidence_chain'],
      permitted_adapters: ['repo', 'git'],
      read_only: true,
      dod_criteria_owned: [],
      model_requirement: {
        context: 'large',
        reasoning: 'deep',
        coding: false,
        vision: false,
        tool_use: 'strong',
        precision: 'high',
      },
    },
    {
      role: 'orchestrator',
      mandate_name: 'completion',
      version: '1.0',
      objective: 'write the completion report and the run narrative',
      required_inputs: ['current_reality'],
      required_outputs: ['completion_report', 'run_narrative'],
      permitted_adapters: [],
      read_only: true,
      dod_criteria_owned: [],
      model_requirement: {
        context: 'medium',
        reasoning: 'mid',
        coding: false,
        vision: false,
        tool_use: 'none',
        precision: 'standard',
      },
    },
  ];
}

/**
 * A granted tool set for the tests whose subject is a reconciliation rule rather than a grant.
 *
 * `reconcile` is told what the kernel exposed to the dispatch, because that is what separates
 * the two readings of an empty call log: a dispatch that held tools, called none of them and
 * still claims coverage is over-claiming, and that is the case step 3 exists for; a dispatch
 * the kernel granted nothing could not have touched anything, so its claim is unanswerable
 * rather than false. Every reconciliation below is about the first case, so the fact that
 * tools were held is stated once, here.
 */
export const HELD_TOOLS: readonly ToolGrant[] = Object.freeze([{
  adapter: 'repo',
  op: 'read_file',
  tool_name: 'repo__read_file',
  description: 'read a file inside the worktree',
  args_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
}]);

/* ----------------------------------------------------------------- substrate ---- */

/** The failure reasons a substrate can report, extracted from the port's own union. */
export type SubstrateFailure = Extract<SubstrateResult, { outcome: 'FAILED' }>['failure'];

/**
 * Which dispatch a scripted response is for, where the position alone cannot say it.
 *
 * A script is positional, and that is right for envelopes: an envelope declares the stage it
 * answers, so a recording and the run it drives agree by construction. A `FAILED` or
 * `NON_CONFORMING` response declares nothing, so a test that wants the *context* dispatch to
 * fail has no way to say so — the substrate would answer that dispatch from its own default and
 * hand the failure to the next one. `stage` says it.
 */
export type ScriptedFor = { readonly stage?: Stage };

export type ScriptedResponse =
  | ({ readonly kind: 'ENVELOPE'; readonly envelope: unknown } & ScriptedFor)
  | ({ readonly kind: 'FAILED'; readonly failure: SubstrateFailure; readonly detail: string } & ScriptedFor)
  | ({ readonly kind: 'NON_CONFORMING'; readonly unexpected: readonly string[] } & ScriptedFor)
  | ({
    /** Calls a tool before answering, so the call log and mutation events are real. */
    readonly kind: 'CALLS_THEN_ENVELOPE';
    readonly calls: readonly { readonly tool: string; readonly args: Record<string, unknown> }[];
    readonly envelope: (results: readonly unknown[]) => unknown;
  } & ScriptedFor);

/**
 * A substrate that returns recorded envelopes.
 *
 * This is what `agentos replay <fixture-dir>` drives the kernel with: no model, and every
 * envelope exactly as recorded — including the malformed, the over-claiming and the
 * fabricated, because those are the cases the disbelief machinery exists for.
 */
export class ScriptedSubstrate implements AgentSubstrate {
  readonly name = 'scripted-fixture';
  readonly dispatched: InputPackage[] = [];
  #index = 0;

  constructor(private readonly script: readonly ScriptedResponse[]) {}

  async conformance(grants: readonly ToolGrant[]): Promise<ToolSurfaceReport> {
    const expected = grants.map((g) => g.tool_name);
    return {
      substrate: this.name,
      verdict: 'CONFORMS',
      expected,
      effective: expected,
      unexpected: [],
      missing: [],
      detail: 'the fixture substrate exposes exactly the granted tool set',
    };
  }

  async dispatch(input: InputPackage, invoker: ToolInvoker): Promise<SubstrateResult> {
    this.dispatched.push(input);

    const expected = input.tools_granted.map((g) => g.tool_name);
    const conforming: ToolSurfaceReport = {
      substrate: this.name,
      verdict: 'CONFORMS',
      expected,
      effective: expected,
      unexpected: [],
      missing: [],
      detail: 'the fixture substrate exposes exactly the granted tool set',
    };
    const cost = { input_tokens: 1000, output_tokens: 100, usd: 0.05 };

    /*
     * The prologue's `context` dispatch, where the script does not answer it.
     *
     * `CONTEXT_DISCOVERY` dispatches `context-discovery/context` in every run, and a recording
     * made before that dispatch existed has no response for it. The double answers such a
     * dispatch itself — **without consuming a scripted response**, so a recording's positions
     * still line up with the dispatches it was recorded against — and it answers honestly: a
     * `PARTIAL` naming the recording it does not have, and `NOT_VALIDATED` for every criterion
     * the dispatch owed, because nothing judged them. A double that answered `MET` here would
     * be manufacturing the very verdict the dispatch exists to obtain.
     *
     * A script that *does* carry a CONTEXT_DISCOVERY envelope at this position keeps it: that
     * is how a test says what the context mandate returned.
     */
    if (input.stage === 'CONTEXT_DISCOVERY' && !answersContext(this.script[this.#index])) {
      const examined = await readInScope(input, invoker);
      return {
        outcome: 'ENVELOPE',
        envelope: stamp(unrecordedContextEnvelope(input, examined), input),
        toolSurface: conforming,
        cost,
        model: input.model,
      };
    }

    /*
     * The Orchestrator's workflow dispatch, where the script does not answer it.
     *
     * Same rule and the same reason as the context mandate above: `WORKFLOW_SELECTED`
     * dispatches `orchestrator/orchestration` in every run that reaches it (decision K-1 is
     * why that sentence is new), and a recording made before it fired has no response for it.
     * The double answers it **without consuming a scripted response** so positions still line
     * up, and answers honestly — `PARTIAL`, no `workflow` proposal, the gap enumerated. The
     * kernel then falls back to the most conservative admissible template, which is precisely
     * what a run whose Orchestrator said nothing should do. A double that proposed a template
     * here would be manufacturing the judgment the dispatch exists to obtain, and would hide
     * the fallback path from every scenario that does not script one.
     */
    if (input.stage === 'WORKFLOW_SELECTED' && !answersWorkflow(this.script[this.#index])) {
      return {
        outcome: 'ENVELOPE',
        envelope: stamp(unrecordedWorkflowEnvelope(), input),
        toolSurface: conforming,
        cost,
        model: input.model,
      };
    }

    const response = this.script[this.#index];
    this.#index += 1;

    if (response === undefined) {
      return {
        outcome: 'FAILED',
        failure: 'SUBSTRATE_ERROR',
        detail: `the script has no response for dispatch ${this.#index}`,
        toolSurface: conforming,
        cost,
        model: input.model,
      };
    }

    switch (response.kind) {
      case 'ENVELOPE':
        return {
          outcome: 'ENVELOPE',
          envelope: stamp(response.envelope, input),
          toolSurface: conforming,
          cost,
          model: input.model,
        };

      case 'FAILED':
        return {
          outcome: 'FAILED',
          failure: response.failure,
          detail: response.detail,
          toolSurface: conforming,
          cost,
          model: input.model,
        };

      case 'NON_CONFORMING':
        return {
          outcome: 'ENVELOPE',
          envelope: stamp(fx.envelope(), input),
          toolSurface: {
            substrate: this.name,
            verdict: 'UNEXPECTED_TOOLS',
            expected,
            effective: [...expected, ...response.unexpected],
            unexpected: [...response.unexpected],
            missing: [],
            detail:
              `the effective tool set is wider than the adapter set: `
              + `${response.unexpected.join(', ')}. Subtraction fails open, so an SDK upgrade `
              + 'that adds a tool must break this check rather than pass quietly',
          },
          cost,
          model: input.model,
        };

      case 'CALLS_THEN_ENVELOPE': {
        const results: unknown[] = [];
        for (const call of response.calls) {
          const result = await invoker.invoke(call.tool, call.args);
          results.push(result);
          if (result.outcome === 'REFUSED' && result.abortDispatch) {
            return {
              outcome: 'FAILED',
              failure: 'SECURITY_VIOLATION',
              detail: result.message,
              toolSurface: conforming,
              cost,
              model: input.model,
            };
          }
        }
        return {
          outcome: 'ENVELOPE',
          envelope: stamp(response.envelope(results), input),
          toolSurface: conforming,
          cost,
          model: input.model,
        };
      }

      default:
        return {
          outcome: 'FAILED',
          failure: 'SUBSTRATE_ERROR',
          detail: 'unreachable',
          toolSurface: conforming,
          cost,
          model: input.model,
        };
    }
  }
}

/**
 * Stamps the run's identifiers onto a recorded envelope.
 *
 * A fixture cannot know the ids the kernel will allocate, so `work_item_id`, `run_id` and
 * `dispatch_id` are filled in from the input package — which is exactly where a real agent
 * reads them from. Everything a test is actually asserting on — the status, the evidence, the
 * coverage, the proposals — is left exactly as recorded.
 *
 * A fixture that wants to answer the *wrong* dispatch, to exercise the cross-field rule, opts
 * out with the `KEEP` sentinel and keeps whatever it declared. That case is deliberate and it
 * has to look deliberate, because an envelope that silently answers a stale dispatch is one
 * of the failures the reconciliations exist to catch.
 */
/** Whether a scripted response declares itself the answer to the context mandate. */
function answersContext(response: ScriptedResponse | undefined): boolean {
  return answersStage(response, 'CONTEXT_DISCOVERY');
}

function answersWorkflow(response: ScriptedResponse | undefined): boolean {
  return answersStage(response, 'WORKFLOW_SELECTED');
}

/**
 * Whether the next scripted response was recorded for this stage.
 *
 * An explicit `stage` settles it — that is what the field is for, and it is the only way a
 * `FAILED` or `NON_CONFORMING` response can say which dispatch it belongs to, since neither
 * carries an envelope to read a `stage_in` off. Otherwise the envelope's own `stage_in` says.
 */
function answersStage(response: ScriptedResponse | undefined, stage: Stage): boolean {
  if (response === undefined) return false;
  if (response.stage !== undefined) return response.stage === stage;
  const raw = response.kind === 'ENVELOPE'
    ? response.envelope
    : response.kind === 'CALLS_THEN_ENVELOPE' ? response.envelope([]) : null;
  if (raw === null || typeof raw !== 'object') return false;
  return (raw as Record<string, unknown>)['stage_in'] === stage;
}

/**
 * Reads every concrete path this dispatch's mandate admits, through the granted tool.
 *
 * The double claims coverage of exactly what came back `OK` and of nothing else, because
 * `COVERAGE_OVERSTATED` is a rejection rather than a warning and a fixture that satisfied it
 * by naming paths it never touched would defeat the check it is standing in front of. Glob
 * entries are skipped: an agent that "examined `src/**`" examined the files under it, and a
 * read of the literal string is not that.
 */
async function readInScope(
  input: InputPackage,
  invoker: ToolInvoker,
): Promise<readonly string[]> {
  const tool = input.tools_granted.find((g) => g.adapter === 'repo' && g.op === 'read_file');
  if (tool === undefined) return [];
  const examined: string[] = [];
  for (const path of input.mandate.in_scope) {
    if (/[*?]/.test(path)) continue;
    const result = await invoker.invoke(tool.tool_name, { path });
    if (result.outcome === 'OK') examined.push(path);
  }
  return examined;
}

/**
 * What the double says when it was never given a recording for the context dispatch.
 *
 * Built from the input package rather than from a constant, so it owes exactly what this
 * dispatch asked for — the same `dod_criteria_owed` the kernel put in the package — and it
 * claims coverage only of the paths it actually read. `PARTIAL` with the gap enumerated is the
 * honest status: the reads happened, and the judgment nobody recorded is named rather than
 * invented.
 *
 * Where the mandate admits no concrete path there is nothing to read and nothing to claim, so
 * the envelope is `BLOCKED` and the run stops — which is what a real context agent that could
 * not reach its own scope would return, and what the kernel is entitled to act on.
 */
function unrecordedContextEnvelope(
  input: InputPackage,
  examined: readonly string[],
): HandoffEnvelope {
  if (examined.length === 0) {
    return fx.envelope({
      envelope_id: 'env_context_unrecorded',
      agent: 'context-discovery',
      stage_in: 'CONTEXT_DISCOVERY',
      status: 'BLOCKED',
      summary:
        'no recording answered the context mandate and the mandate admits no concrete path to '
        + 'read, so nothing was examined and there is no coverage to claim',
      coverage: fx.coverage({ scope_examined: ['(nothing examined)'], confidence: 'UNKNOWN' }),
      outputs: {},
      blockers: [fx.blocker({
        id: 'B-context',
        kind: 'MISSING_ACCESS',
        description:
          'the scripted substrate holds no recording for this dispatch and read nothing, so it '
          + 'has no basis for a Context Package',
        needs: 'additional_discovery',
        evidence: [],
      })],
      dod_verdicts: [],
      next_action: null,
    });
  }
  return fx.envelope({
    envelope_id: 'env_context_unrecorded',
    agent: 'context-discovery',
    stage_in: 'CONTEXT_DISCOVERY',
    status: 'PARTIAL',
    summary:
      'the scripted substrate holds no recording for the context mandate of this dispatch, so '
      + 'the Context Package stands as the probes wrote it and nothing here judges it',
    coverage: fx.coverage({ scope_examined: [...examined], confidence: 'FACT' }),
    outputs: {},
    unknowns: [fx.unknownRecord({
      id: 'U-context',
      subject: 'the context mandate outputs for this dispatch',
      reason: 'UNAVAILABLE',
      attempted: 'the scripted substrate, which holds no recording for this dispatch',
      recoverable_by: 'record a CONTEXT_DISCOVERY envelope at this position in the script',
      blocks: [],
    })],
    dod_verdicts: input.dod_criteria_owed.map((criterion) => fx.criterionVerdict({
      criterion,
      verdict: 'NOT_VALIDATED',
      reason:
        'no recording answered the context mandate, so nothing judged this criterion. A double '
        + 'that answered MET would be manufacturing the verdict the dispatch exists to obtain',
      evidence: [],
    })),
    next_action: null,
  });
}

/**
 * What the double says when it was never given a recording for the workflow dispatch.
 *
 * It proposes nothing, and the point of it is that proposing nothing is a real answer: the
 * kernel selects the most conservative admissible template, records that no proposal was made,
 * and continues. `PARTIAL` with the gap enumerated is the honest status — the dispatch
 * happened and the judgment nobody recorded is named rather than invented. The Orchestrator
 * holds no adapters, so there is no coverage to claim and none is claimed.
 */
function unrecordedWorkflowEnvelope(): HandoffEnvelope {
  return fx.envelope({
    envelope_id: 'env_workflow_unrecorded',
    agent: 'orchestrator',
    stage_in: 'WORKFLOW_SELECTED',
    status: 'PARTIAL',
    summary:
      'the scripted substrate holds no recording for the workflow mandate of this dispatch, so '
      + 'no template is proposed and the kernel\'s own fallback applies',
    coverage: fx.coverage({ scope_examined: ['(no adapters)'], confidence: 'INFERENCE' }),
    outputs: {},
    unknowns: [fx.unknownRecord({
      id: 'U-workflow',
      subject: 'which admissible template fits this work item',
      reason: 'UNAVAILABLE',
      attempted: 'the scripted substrate, which holds no recording for this dispatch',
      recoverable_by: 'record a WORKFLOW_SELECTED envelope at this position in the script',
      blocks: [],
    })],
    dod_verdicts: [],
    next_action: null,
  });
}

/**
 * A context envelope a test scripts deliberately.
 *
 * `evidence` is the pool its criterion-1 verdict cites into, and `scopeExamined` has to name
 * paths some adapter call actually touched — `COVERAGE_OVERSTATED` is a rejection, not a
 * warning. The default is the no-adapter form, which claims nothing.
 */
export function contextEnvelope(input: {
  readonly outputs?: Readonly<Record<string, unknown>>;
  readonly evidence?: readonly Evidence[];
  readonly scopeExamined?: readonly string[];
  readonly verdict?: Partial<CriterionVerdict>;
  readonly overrides?: Partial<HandoffEnvelope>;
} = {}): HandoffEnvelope {
  const evidence = input.evidence ?? [];
  return fx.envelope({
    envelope_id: 'env_context',
    agent: 'context-discovery',
    stage_in: 'CONTEXT_DISCOVERY',
    summary:
      'the Context Package the probes built was read, reconciled and judged sufficient for the '
      + 'admitted scope',
    outputs: input.outputs ?? {},
    coverage: fx.coverage({
      scope_examined: [...(input.scopeExamined ?? ['(no adapters)'])],
      confidence: input.scopeExamined === undefined ? 'INFERENCE' : 'FACT',
    }),
    evidence: [...evidence],
    dod_verdicts: [fx.criterionVerdict({
      criterion: 1,
      verdict: 'MET',
      reason: null,
      evidence: evidence.map((entry) => entry.id),
      ...input.verdict,
    })],
    next_action: null,
    ...input.overrides,
  });
}

function stamp(raw: unknown, input: InputPackage): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const { KEEP: keep, ...envelope } = raw as Record<string, unknown> & { KEEP?: unknown };
  return {
    ...envelope,
    work_item_id: keep === true ? envelope['work_item_id'] : input.work_item_id,
    run_id: keep === true ? envelope['run_id'] : input.run_id,
    dispatch_id: keep === true ? envelope['dispatch_id'] : input.dispatch_id,
    agent: envelope['agent'] ?? input.agent,
    stage_in: envelope['stage_in'] ?? input.stage,
    model: envelope['model'] ?? input.model,
  };
}

/* ---------------------------------------------------------------------- host ---- */

export const OPERATOR_HOST: HostIdentity = {
  host: 'host.cli',
  principal: { id: 'operator@example.com', asserted_by: 'host.cli' },
  trustClass: 'OPERATOR',
};

export const UNAUTHENTICATED_HOST: HostIdentity = {
  host: 'host.webhook',
  principal: null,
  trustClass: 'EXTERNAL',
};

/**
 * A human who answers.
 *
 * The counterpart to `SilentHuman`, and needed for exactly one thing: the ladder's rung 4 is
 * only distinguishable from rung 5 by whether an answer arrives, and a suite with no answering
 * channel can only ever assert that AgentOS blocks.
 */
export class AnsweringHuman implements HumanChannel {
  readonly questions: { question: string; readings: readonly { reading: string; would_do: string }[] }[] = [];

  constructor(private readonly answer = 'the first reading') {}

  async ask(
    question: string,
    readings: readonly { readonly reading: string; readonly would_do: string }[],
  ): Promise<string | null> {
    this.questions.push({ question, readings: [...readings] });
    return this.answer;
  }

  async requestAuthorization(): Promise<'PENDING' | 'GRANTED' | 'DENIED'> {
    return 'PENDING';
  }
}

export class SilentHuman implements HumanChannel {
  async ask(): Promise<string | null> {
    /* No answer inside the policy window. Silence is never consent. */
    return null;
  }

  async requestAuthorization(): Promise<'PENDING' | 'GRANTED' | 'DENIED'> {
    return 'PENDING';
  }
}

/* -------------------------------------------------------------- the harness ---- */

export interface Harness {
  readonly ports: KernelPorts;
  readonly store: RunStore;
  readonly policies: PolicySet;
  readonly clock: FixedClock;
  readonly adapters: FixtureAdapters;
  readonly discovery: FixtureDiscovery;
  readonly substrate: ScriptedSubstrate;
  readonly root: string;
  destroy(): void;
}

export interface HarnessOptions {
  readonly script?: readonly ScriptedResponse[];
  readonly adapters?: FixtureAdapterOptions;
  readonly discovery?: FixtureDiscoveryOptions;
  readonly skills?: readonly SkillEntry[];
  readonly models?: readonly ModelEntry[];
  readonly host?: HostIdentity;
  readonly access?: ReadonlySet<'repository' | 'git' | 'project_management' | 'runtime' | 'production'>;
  readonly specs?: readonly AgentSpecView[];
  /**
   * A policy set other than the installed one, for the tests that need a mutating template to
   * be admissible. `policiesAllowingMutation()` builds it from the real data.
   */
  readonly policies?: PolicySet;
  /** Where a human answers. `SilentHuman` by default: silence is never consent. */
  readonly human?: HumanChannel;
}

export function harness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'agentos-kernel-'));
  const store = new RunStore(root);
  const policies = options.policies ?? loadPolicies();
  const clock = new FixedClock();
  const adapters = new FixtureAdapters(options.adapters);
  const discovery = new FixtureDiscovery(options.discovery);
  const substrate = new ScriptedSubstrate(options.script ?? []);

  const ports: KernelPorts = {
    store,
    policies,
    clock,
    adapters,
    discovery,
    registries: new FixtureRegistries(options.skills ?? [], options.models ?? [defaultModel()]),
    agents: new FixtureAgents(options.specs ?? defaultSpecs()),
    substrate,
    host: options.host ?? OPERATOR_HOST,
    human: options.human ?? new SilentHuman(),
    random: seededRandom(),
    repositoryPath: root,
    access: options.access ?? new Set(['repository', 'git']),
  };

  return {
    ports,
    store,
    policies,
    clock,
    adapters,
    discovery,
    substrate,
    root,
    destroy: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/* ----------------------------------------------------- envelope fixtures ---- */

/**
 * The subject file's content, and the excerpt every fixture's evidence carries.
 *
 * They are one constant deliberately. Evidence is replayed through the adapter and compared
 * against what comes back, so a fixture whose excerpt is a substring of the file it names is a
 * fixture whose evidence does not verify — and a suite built on evidence that fails
 * verification would be asserting on whatever the downgrade path happened to do rather than on
 * the behaviour under test.
 */
export const README_CONTENT = 'AgentOs is an operating system for agents.';

/** The resolution envelope: a proposed Work Item the kernel then disbelieves. */
export function resolutionEnvelope(
  proposal: Partial<ProposedWorkItem> = {},
): HandoffEnvelope {
  const base: ProposedWorkItem = {
    source_intake: 'in_0001',
    intent: fx.inferenceAssertion('MODIFY_ARTIFACT'),
    type: fx.inferenceAssertion('TASK'),
    external_identity: fx.unknownAssertion({ reason: 'NOT_APPLICABLE' }),
    title: fx.factAssertion('Fix typo in README', {
      evidence: [fx.evidence({ id: 'E-01', locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } }, ref: 'README.md', excerpt: README_CONTENT })],
    }),
    desired_outcome: fx.inferenceAssertion('the misspelling in README.md is corrected'),
    scope: {
      paths: ['README.md'],
      capabilities: [],
      repositories: ['subject'],
      confidence: 'FACT',
    },
    constraints: [],
    dependencies: [],
    parent: fx.unknownAssertion({ reason: 'NOT_APPLICABLE' }),
    resolution_confidence: 0.9,
    alternatives: [],
    ...proposal,
  };
  return fx.envelope({
    envelope_id: 'env_resolution',
    agent: 'context-discovery',
    stage_in: 'RESOLUTION',
    outputs: { proposed_work_item: 'inline' },
    coverage: fx.coverage({ scope_examined: ['README.md'] }),
    proposals: { work_item: base },
    evidence: [
      fx.evidence({
        id: 'E-01',
        locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
        ref: 'README.md',
        excerpt: README_CONTENT,
      }),
    ],
  });
}

/**
 * The Orchestrator's workflow proposal.
 *
 * `outputs` names `rationale` because that is what the `orchestration` mandate declares it
 * owes, and the dispatch now puts the envelope through the same receipt as every other one:
 * an output the dispatch did not ask for is refused, and the proposal inside a refused
 * envelope never reaches admission.
 */
export function workflowEnvelope(
  proposal: Partial<WorkflowProposal> = {},
  overrides: Partial<HandoffEnvelope> = {},
): HandoffEnvelope {
  return fx.envelope({
    envelope_id: 'env_workflow',
    agent: 'orchestrator',
    stage_in: 'WORKFLOW_SELECTED',
    outputs: { rationale: 'inline' },
    coverage: fx.coverage({ scope_examined: ['(no adapters)'], confidence: 'INFERENCE' }),
    proposals: {
      workflow: {
        template_id: 'investigation.readonly',
        include_optional: [],
        exclude_optional: [],
        rationale: 'the deliverable is findings and nothing mutates',
        ...proposal,
      },
    },
    ...overrides,
  });
}

/** An audit envelope with a verifiable finding. */
export function auditEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return fx.envelope({
    envelope_id: 'env_audit',
    agent: 'auditor',
    stage_in: 'AUDIT',
    outputs: {
      capability_graph: 'capabilities/v1.json',
      findings_report: 'artifacts/findings.md',
      orphan_inventory: 'artifacts/orphans.md',
    },
    coverage: fx.coverage({ scope_examined: ['README.md'] }),
    dod_verdicts: [
      fx.criterionVerdict({ criterion: 3, evidence: ['E-01'] }),
      fx.criterionVerdict({ criterion: 4, evidence: ['E-01'] }),
    ],
    evidence: [
      fx.evidence({
        id: 'E-01',
        locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
        ref: 'README.md',
        excerpt: README_CONTENT,
      }),
    ],
    next_action: {
      proposed_stage: 'ROOT_CAUSE',
      proposed_agent: 'auditor',
      rationale: 'the audit found something worth explaining',
    },
    ...overrides,
  });
}

/** A root-cause envelope. */
export function rootCauseEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return fx.envelope({
    envelope_id: 'env_root_cause',
    agent: 'auditor',
    stage_in: 'ROOT_CAUSE',
    outputs: { root_cause: 'the file was written with the wrong capitalization', evidence_chain: 'E-01' },
    coverage: fx.coverage({ scope_examined: ['README.md'] }),
    evidence: [
      fx.evidence({
        id: 'E-01',
        locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
        ref: 'README.md',
        excerpt: README_CONTENT,
      }),
    ],
    next_action: {
      proposed_stage: 'COMPLETION',
      proposed_agent: 'orchestrator',
      rationale: 'the cause is established and the deliverable is findings',
    },
    ...overrides,
  });
}

/** The completion envelope. */
export function completionEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return fx.envelope({
    envelope_id: 'env_completion',
    agent: 'orchestrator',
    stage_in: 'COMPLETION',
    outputs: { completion_report: 'decisions/completion.json', run_narrative: 'inline' },
    coverage: fx.coverage({ scope_examined: ['(no adapters)'], confidence: 'INFERENCE' }),
    next_action: null,
    ...overrides,
  });
}
