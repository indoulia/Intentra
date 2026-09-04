import type {
  AdapterAvailability,
  AdapterOperationDescriptor,
  AgentRole,
  Assertion,
  CallRecord,
  Classification,
  ContextPackage,
  ContextSectionName,
  Evidence,
  HandoffEnvelope,
  InputPackage,
  IntakeRecord,
  Locator,
  ModelEntry,
  MutationEvent,
  RealityElement,
  Scope,
  SkillEntry,
  ToolGrant,
  TrustClass,
  WorkItem,
} from './generated/types.js';

/**
 * The interfaces across which the kernel meets everything it does not contain.
 *
 * They live in `contracts/` because both sides need them and `contracts/` depends on
 * nothing. A port names only contract shapes; none of them exposes a kernel internal, and
 * that is what keeps `agents -> core` unnecessary rather than merely discouraged.
 */

/** Time as an injected capability, so a replay is reproducible. */
export interface Clock {
  now(): Date;
}

export interface RandomSource {
  next(): number;
}

/* ------------------------------------------------------------------ agent execution ---- */

export type SubstrateFailure =
  | 'NO_MODEL'
  | 'TIMEOUT'
  | 'TOOL_SURFACE_VIOLATION'
  | 'MALFORMED_ENVELOPE'
  | 'SUBSTRATE_ERROR'
  | 'BUDGET_EXCEEDED'
  | 'SECURITY_VIOLATION';

/** What the substrate observed about its own tool surface, for D-2's conformance check. */
export interface ToolSurfaceReport {
  readonly substrate: string;
  readonly verdict: 'CONFORMS' | 'UNEXPECTED_TOOLS' | 'MISSING_TOOLS' | 'UNVERIFIABLE';
  readonly expected: readonly string[];
  readonly effective: readonly string[];
  readonly unexpected: readonly string[];
  readonly missing: readonly string[];
  readonly detail: string;
}

export type SubstrateResult =
  | {
    readonly outcome: 'ENVELOPE';
    /** Unvalidated. The kernel validates; the substrate only parses transport. */
    readonly envelope: unknown;
    readonly toolSurface: ToolSurfaceReport;
    readonly cost: { readonly input_tokens: number; readonly output_tokens: number; readonly usd: number | null };
    readonly model: string;
  }
  | {
    readonly outcome: 'FAILED';
    readonly failure: SubstrateFailure;
    readonly detail: string;
    readonly toolSurface: ToolSurfaceReport | null;
    readonly cost: { readonly input_tokens: number; readonly output_tokens: number; readonly usd: number | null };
    readonly model: string | null;
  };

/**
 * One dispatch, one fresh session. No transcript crosses this boundary in either
 * direction, which is what the handoff contract already requires and what keeps the
 * substrate swappable in one file (freeze D-2's reversal clause).
 */
export interface AgentSubstrate {
  readonly name: string;
  /** Asserted before any dispatch. A non-conforming surface fails the run loudly. */
  conformance(grants: readonly ToolGrant[]): Promise<ToolSurfaceReport>;
  dispatch(input: InputPackage, invoker: ToolInvoker): Promise<SubstrateResult>;
}

/** How a substrate reaches an adapter operation. The only outward reach an agent has. */
export interface ToolInvoker {
  invoke(
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ToolInvocationResult>;
}

export type ToolInvocationResult =
  | { readonly outcome: 'OK'; readonly value: unknown }
  | {
    readonly outcome: 'REFUSED';
    readonly refusal: 'scope_violation' | 'security_violation' | 'grant_missing' | 'ambiguous_state' | 'unknown_tool';
    readonly message: string;
    /** A security violation aborts the dispatch immediately. */
    readonly abortDispatch: boolean;
  }
  | { readonly outcome: 'ERROR'; readonly message: string };

/* ----------------------------------------------------------------------- adapters ------ */

export interface AdapterCallContext {
  readonly workItemId: string;
  readonly runId: string;
  readonly dispatchId: string | null;
  readonly mandate: { readonly in_scope: readonly string[]; readonly out_of_scope: readonly string[] };
  readonly grantsHeld: readonly string[];
  readonly stageMutating: boolean;
}

export type AdapterCallOutcome =
  | { readonly outcome: 'OK'; readonly value: unknown; readonly call: CallRecord; readonly mutations: readonly MutationEvent[] }
  | {
    readonly outcome: 'REFUSED';
    readonly refusal: 'scope_violation' | 'security_violation' | 'grant_missing' | 'ambiguous_state';
    readonly message: string;
    readonly call: CallRecord;
  }
  | { readonly outcome: 'ERROR'; readonly message: string; readonly call: CallRecord };

/**
 * The only path between agents and the world, and the one place every check the kernel
 * performs on an agent's claims is actually performed.
 */
export interface AdapterRegistry {
  descriptors(): readonly AdapterOperationDescriptor[];
  descriptor(adapter: string, op: string): AdapterOperationDescriptor | undefined;
  availability(): readonly AdapterAvailability[];
  call(
    adapter: string,
    op: string,
    args: Readonly<Record<string, unknown>>,
    context: AdapterCallContext,
  ): Promise<AdapterCallOutcome>;
  /** Replay for evidence verification. Restricted to `observation_safe` operations. */
  replay(locator: Locator, context: AdapterCallContext): Promise<ReplayResult>;
  classify(kind: Classification['kind'], subject: string): Promise<Classification>;
}

export type ReplayResult =
  | { readonly outcome: 'OK'; readonly value: unknown; readonly excerpt: string }
  | { readonly outcome: 'UNREPLAYABLE'; readonly reason: string }
  | { readonly outcome: 'REFUSED'; readonly reason: string };

/* ---------------------------------------------------------------------- discovery ------ */

/**
 * Probes are the only writers to the Context Package. The kernel holds this port because
 * it must re-probe a `STALE` reality element before evaluating a predicate over it, and
 * because entry-stage computation dispatches targeted discovery.
 */
export interface DiscoveryPort {
  /** Tier 1 orientation: enough to resolve the work item, and no more. */
  orient(request: OrientRequest): Promise<ContextPackage>;
  /** Tier 2: depth against the admitted scope, plus `current_reality`. */
  deepen(request: DeepenRequest): Promise<ContextPackage>;
  /** Tier 3: a named probe, on demand, as a recorded event. */
  probe(request: ProbeRequest): Promise<ProbeOutcome>;
  /** Re-read one reality element. A stale element is never used to decide a transition. */
  reprobeReality(
    element: RealityElement,
    workItem: WorkItem | null,
    scope: Scope,
  ): Promise<Assertion>;
}

export interface OrientRequest {
  readonly runId: string;
  readonly intake: IntakeRecord;
  readonly repositoryPath: string;
}

export interface DeepenRequest {
  readonly runId: string;
  readonly workItem: WorkItem;
  readonly repositoryPath: string;
  readonly previous: ContextPackage | null;
}

export interface ProbeRequest {
  readonly runId: string;
  readonly probe: string;
  readonly sections: readonly ContextSectionName[];
  readonly scope: Scope;
  readonly reason: string;
}

export interface ProbeOutcome {
  readonly probe: string;
  readonly assertions: Readonly<Record<string, Assertion>>;
  readonly evidence: readonly Evidence[];
  readonly available: boolean;
  readonly detail: string;
}

/* ---------------------------------------------------------------------- registries ----- */

export interface Registries {
  skills(): Promise<readonly SkillEntry[]>;
  models(): Promise<readonly ModelEntry[]>;
}

/* --------------------------------------------------------------------------- host ------ */

/** What the host can assert about who invoked AgentOS. */
export interface HostIdentity {
  readonly host: string;
  readonly principal: { readonly id: string; readonly asserted_by: string } | null;
  readonly trustClass: TrustClass;
}

/**
 * Where a human answers. The MVP gates nothing because it mutates nothing, so the CLI
 * channel answers `PENDING` for authorization and reads an operator answer for a question.
 */
export interface HumanChannel {
  ask(question: string, readings: readonly { readonly reading: string; readonly would_do: string }[]): Promise<string | null>;
  requestAuthorization(requestId: string, summary: string): Promise<'PENDING' | 'GRANTED' | 'DENIED'>;
}

/* -------------------------------------------------------------------- agent specs ------ */

/**
 * The kernel's view of an agent: a specification it can build an input package for. It
 * never learns what an agent is internally, which model it used, or how it reasoned.
 */
export interface AgentCatalog {
  spec(role: AgentRole, mandate: string): AgentSpecView | undefined;
  all(): readonly AgentSpecView[];
}

export interface AgentSpecView {
  readonly role: AgentRole;
  readonly mandate_name: string;
  readonly version: string;
  readonly objective: string;
  readonly required_inputs: readonly ContextSectionName[];
  readonly required_outputs: readonly string[];
  readonly permitted_adapters: readonly string[];
  readonly read_only: boolean;
  readonly dod_criteria_owned: readonly number[];
  readonly model_requirement: {
    readonly context: 'small' | 'medium' | 'large';
    readonly reasoning: 'shallow' | 'mid' | 'deep';
    readonly coding: boolean;
    readonly vision: boolean;
    readonly tool_use: 'none' | 'basic' | 'strong';
    readonly precision: 'standard' | 'high';
  };
}

/** What a dispatch returned, after the kernel validated it. */
export interface AcceptedEnvelope {
  readonly envelope: HandoffEnvelope;
}
