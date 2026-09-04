import {
  fixtures as fx,
  type AgentSpecView,
  type ContextPackage,
  type ToolGrant,
  type ToolInvocationResult,
  type ToolInvoker,
} from '@agentos/contracts';
import type {
  DispatchTransport,
  TransportCost,
  TransportEvent,
  TransportFailure,
  TransportRequest,
  TransportSession,
} from '../src/substrate/transport.js';

/**
 * Test doubles for WP-5.
 *
 * The suite must pass offline, deterministically, and with no API key, so the substrate is
 * exercised over a transport that is scripted rather than real. These doubles are
 * deliberately *not* mocks of the thing under test: the fake transport really drives the
 * substrate's tool path, really reports whatever surface the script says, and really hangs
 * when the script says to hang, so a test about the timeout is a test about the timeout.
 *
 * Nothing here reaches the network, spawns a process or reads a repository.
 */

export const ZERO_COST: TransportCost = { input_tokens: 0, output_tokens: 0, usd: null };

/** One thing the scripted session does, in order. */
export type ScriptStep =
  | {
    readonly kind: 'surface';
    /** Defaults to exactly the qualified names of the tools the request carried. */
    readonly tools?: readonly string[];
    readonly agents?: readonly string[];
    readonly detail?: string;
  }
  | {
    readonly kind: 'call';
    readonly tool: string;
    readonly args?: Readonly<Record<string, unknown>>;
  }
  | {
    readonly kind: 'result';
    readonly text?: string;
    readonly failure?: TransportFailure;
    readonly detail?: string;
    readonly cost?: TransportCost;
    readonly model?: string | null;
  }
  /** Yields nothing further and waits to be closed. */
  | { readonly kind: 'hang' }
  | { readonly kind: 'throw'; readonly message: string };

export interface RecordedToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: { readonly ok: boolean; readonly detail: string };
}

export class FakeSession implements TransportSession {
  readonly calls: RecordedToolCall[] = [];
  closed = false;
  #wake: (() => void) | null = null;

  constructor(
    readonly request: TransportRequest,
    private readonly script: readonly ScriptStep[],
    private readonly qualify: (name: string) => string,
  ) {}

  close(): Promise<void> {
    this.closed = true;
    this.#wake?.();
    this.#wake = null;
    return Promise.resolve();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<TransportEvent, void> {
    for (const step of this.script) {
      if (this.closed) return;
      switch (step.kind) {
        case 'surface':
          yield {
            kind: 'SURFACE',
            surface: {
              tools: step.tools ?? this.request.tools.map((tool) => this.qualify(tool.name)),
              agents: step.agents ?? [],
              detail: step.detail ?? 'scripted surface',
            },
          };
          continue;
        case 'call': {
          const args = step.args ?? {};
          const outcome = await this.request.invoke(step.tool, args);
          this.calls.push({
            tool: step.tool,
            args,
            result: outcome.ok
              ? { ok: true, detail: JSON.stringify(outcome.value) }
              : { ok: false, detail: outcome.message },
          });
          continue;
        }
        case 'result':
          yield {
            kind: 'RESULT',
            text: step.text ?? '',
            failure: step.failure ?? null,
            detail: step.detail ?? '',
            cost: step.cost ?? ZERO_COST,
            model: step.model ?? null,
          };
          return;
        case 'hang':
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
          return;
        case 'throw':
          throw new Error(step.message);
      }
    }
  }
}

export interface FakeTransportOptions {
  /** How the substrate names a granted operation. Identity keeps most tests readable. */
  readonly qualify?: (name: string) => string;
  readonly name?: string;
}

export class FakeTransport implements DispatchTransport {
  readonly name: string;
  readonly opened: TransportRequest[] = [];
  readonly sessions: FakeSession[] = [];
  readonly #scripts: ScriptStep[][];
  readonly #qualify: (name: string) => string;

  constructor(scripts: readonly (readonly ScriptStep[])[], options: FakeTransportOptions = {}) {
    this.#scripts = scripts.map((script) => [...script]);
    this.#qualify = options.qualify ?? ((name) => name);
    this.name = options.name ?? 'fake';
  }

  qualify(toolName: string): string {
    return this.#qualify(toolName);
  }

  open(request: TransportRequest): TransportSession {
    this.opened.push(request);
    const script = this.#scripts.shift() ?? [];
    const session = new FakeSession(request, script, this.#qualify);
    this.sessions.push(session);
    return session;
  }
}

/** Records every call the substrate forwards, and answers however the test says. */
export class RecordingInvoker implements ToolInvoker {
  readonly calls: { tool: string; args: Readonly<Record<string, unknown>> }[] = [];

  constructor(
    private readonly answer: (
      tool: string,
      args: Readonly<Record<string, unknown>>,
    ) => ToolInvocationResult = () => ({ outcome: 'OK', value: 'ok' }),
  ) {}

  invoke(
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ToolInvocationResult> {
    this.calls.push({ tool: toolName, args: { ...args } });
    return Promise.resolve(this.answer(toolName, args));
  }
}

/** A grant for a read-only repository operation. */
export function grant(overrides: Partial<ToolGrant> = {}): ToolGrant {
  return {
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
    ...overrides,
  };
}

export const GRANTS: readonly ToolGrant[] = [
  grant(),
  grant({ op: 'list_files', tool_name: 'repo__list_files', description: 'list files' }),
];

/** An agent specification with no policy behind it, for the boundary tests. */
export function specView(overrides: Partial<AgentSpecView> = {}): AgentSpecView {
  return {
    role: 'auditor',
    mandate_name: 'audit',
    version: '1.0',
    objective: 'find where the system lies',
    required_inputs: ['repository', 'tests'],
    required_outputs: ['capability_graph'],
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
    ...overrides,
  };
}

const EMPTY_SECTION = {};

/**
 * A Context Package with every section present and distinguishable.
 *
 * Each section carries one assertion whose value names the section, so a test can tell which
 * sections were materialized and prove that an unrequested one is absent rather than empty.
 */
export function contextPackage(overrides: Partial<ContextPackage> = {}): ContextPackage {
  const section = (name: string) => ({ marker: fx.factAssertion(name) });
  return {
    meta: {
      run_id: 'run_20260904T100000Z_000001',
      work_item_id: 'wi_c_subject',
      package_version: 1,
      assembled_at: fx.T1,
      tier: 2,
      probe_coverage: [],
      adapter_availability: [],
    },
    work_item: '../work-item.json',
    current_reality: fx.currentReality(),
    repository: section('repository'),
    product: section('product'),
    capabilities: 'capabilities/v1.json',
    architecture: section('architecture'),
    domain_model: section('domain_model'),
    source_map: section('source_map'),
    data_map: section('data_map'),
    api_map: section('api_map'),
    ui_map: section('ui_map'),
    tests: section('tests'),
    git_state: section('git_state'),
    runtime_state: section('runtime_state'),
    production_state: section('production_state'),
    intent: section('intent'),
    reconciliation: [],
    agent_capabilities: section('agent_capabilities'),
    model_capabilities: section('model_capabilities'),
    constraints: EMPTY_SECTION,
    authorization: EMPTY_SECTION,
    gaps: [],
    ...overrides,
  };
}
