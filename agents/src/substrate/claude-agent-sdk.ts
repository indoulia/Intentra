import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  McpSdkServerConfigWithInstance,
  Options,
  PermissionResult,
  Query,
  SDKResultMessage,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  assertNever,
  type AgentSubstrate,
  type InputPackage,
  type SubstrateFailure,
  type SubstrateResult,
  type ToolGrant,
  type ToolInvoker,
  type ToolSurfaceReport,
} from '@agentos/contracts';
import { renderDispatchBrief, renderSystemSpecification } from '../dispatch/brief.js';
import { parseEnvelope } from '../dispatch/envelope.js';
import { isSpawningToolName } from '../dispatch/tool-grants.js';
import { MVP_ROLE_SPECS, type RoleSpec } from '../roles/specs.js';
import { evaluateSurface, type ObservedSurface } from './surface.js';
import type {
  DispatchTransport,
  TransportCost,
  TransportEvent,
  TransportFailure,
  TransportRequest,
  TransportSession,
  TransportTool,
} from './transport.js';

/**
 * The Claude Agent SDK substrate — the one file in `agents/` that reaches outside.
 *
 * ARCHITECTURE_FREEZE D-2 selects the Claude Agent SDK and attaches a binding condition,
 * because the SDK is the Claude Code harness as a library: it arrives with built-in file,
 * shell, search and web tools and with subagent spawning, and AgentOS requires the opposite
 * posture. Making it satisfy that is a *subtraction* problem, and subtraction fails open — a
 * future SDK version that adds a built-in tool silently widens every agent's reach unless the
 * kernel is configured to allow rather than to deny. So the condition, stated as three rules
 * and implemented here as three mechanisms:
 *
 * 1. **The tool surface is an allowlist, never a denylist.** `tools: []` removes every
 *    built-in rather than forbidding them one at a time (`Options.tools`, sdk.d.ts 1505:
 *    "`[]` (empty array) - Disable all built-in tools"). The only tools that exist are the
 *    granted adapter operations, served by an in-process MCP server this file constructs,
 *    and `allowedTools` names exactly those. `settingSources: []` and `strictMcpConfig: true`
 *    stop a user, project or organisation setting from adding to either.
 * 2. **No subagent or task-spawning tool is ever exposed.** `Options.agents` is never
 *    populated and `Options.agent` is never set, so no subagent is defined; with `tools: []`
 *    the Task tool that would invoke one does not exist. Three further layers back that up,
 *    as SKILL_AND_MODEL_SELECTION asks for on exactly this rule: no grant may carry a
 *    spawning name, `canUseTool` denies any name outside the allowlist, and the conformance
 *    check refuses a surface that advertises any agent at all.
 * 3. **A startup conformance check asserts the effective tool list equals the adapter set**,
 *    and it is performed against what the SDK *reports*, not against what was asked for. The
 *    `system`/`init` message (sdk.d.ts 5084) carries `tools`, `agents`, `mcp_servers`,
 *    `model` and `permissionMode`, and it is emitted before the first turn — so the surface
 *    is observed, compared and refused before any tool can run. An SDK upgrade that adds a
 *    tool breaks this check rather than passing quietly.
 *
 * **One dispatch is one fresh session.** `continue`, `resume`, `forkSession`, `sessionId` and
 * `resumeSessionAt` are never set — the `DispatchTransport` port has nowhere to put them —
 * `persistSession: false` keeps the session off disk, and `CLAUDE_CONFIG_DIR` points at a
 * directory created for this dispatch and removed when it ends. Session isolation is
 * therefore a property of the filesystem and of the port's shape rather than of an option
 * anybody has to remember. `cwd` is that same empty directory: the agent's reach to the
 * repository is the adapter operations it was granted, and pointing the harness at the
 * repository would leave a second path open in case one of the other three failed.
 *
 * **Everything the substrate returns is unvalidated.** The envelope is parsed and handed on
 * as `unknown`; the kernel validates. A transport that tidied the payload would defeat the
 * checks that exist to catch a tidy-looking lie.
 */

/** How long a conformance probe is allowed to take before it is treated as unobservable. */
const CONFORMANCE_PROBE_MS = 120_000;

const ZERO_COST: TransportCost = { input_tokens: 0, output_tokens: 0, usd: null };

export interface ClaudeAgentSdkSubstrateOptions {
  /**
   * The transport to run over. Injected so the boundary can be tested without a model, an
   * API key or a network — and so that D-2's reversal, if it is ever taken, replaces one
   * implementation of one interface.
   */
  readonly transport?: DispatchTransport;
  /** The role specifications whose hard limits and declarations reach the agent. */
  readonly specs?: readonly RoleSpec[];
}

export class ClaudeAgentSdkSubstrate implements AgentSubstrate {
  readonly name: string;
  readonly #transport: DispatchTransport;
  readonly #specs: ReadonlyMap<string, RoleSpec>;

  constructor(options: ClaudeAgentSdkSubstrateOptions = {}) {
    this.#transport = options.transport ?? new ClaudeCodeTransport();
    this.name = this.#transport.name;
    this.#specs = new Map(
      (options.specs ?? MVP_ROLE_SPECS).map((spec) => [`${spec.role}/${spec.mandate_name}`, spec]),
    );
  }

  /**
   * D-2's startup check: open a session with the grants in force, read the surface the
   * substrate reports, and close before a turn happens.
   *
   * The probe spends nothing — it is closed at the init message, before the first request,
   * and `maxBudgetUsd: 0` is the backstop if the close ever races. What it costs is one
   * subprocess start, once, in exchange for the difference between asserting a configuration
   * and observing its effect.
   */
  async conformance(grants: readonly ToolGrant[]): Promise<ToolSurfaceReport> {
    let observed: ObservedSurface | null = null;
    let detail = '';
    let session: TransportSession | null = null;
    const timer = setTimeout(() => {
      detail = `the probe did not report a surface within ${CONFORMANCE_PROBE_MS}ms`;
      void session?.close();
    }, CONFORMANCE_PROBE_MS);

    try {
      session = this.#transport.open({
        model: null,
        systemPrompt: CONFORMANCE_SYSTEM_PROMPT,
        prompt: CONFORMANCE_PROMPT,
        tools: toolsOf(grants),
        maxTurns: 1,
        maxBudgetUsd: 0,
        invoke: refuseEverything,
      });
      for await (const event of session) {
        if (event.kind === 'SURFACE') {
          observed = event.surface;
          break;
        }
        detail = event.detail === '' ? 'the probe ended before reporting a surface' : event.detail;
        break;
      }
    } catch (error) {
      detail = messageOf(error);
    } finally {
      clearTimeout(timer);
      await session?.close();
    }

    const report = evaluateSurface({
      substrate: this.name,
      grants,
      observed,
      qualify: (name) => this.#transport.qualify(name),
    });
    if (observed !== null || detail === '') return report;
    return { ...report, detail: `${report.detail}: ${detail}` };
  }

  async dispatch(input: InputPackage, invoker: ToolInvoker): Promise<SubstrateResult> {
    const grants = input.tools_granted;
    const expected = grants.map((grant) => grant.tool_name);

    const model = input.model.trim();
    if (model === '') {
      return failure(
        'NO_MODEL',
        'the input package names no model. The registries rank and the kernel selects; a '
        + 'dispatch that arrives without a selection has nothing to run on, and choosing one '
        + 'here would be the substrate making a decision the kernel records',
        null,
        ZERO_COST,
        null,
      );
    }

    const spawning = expected.filter((name) => isSpawningToolName(name));
    if (spawning.length > 0) {
      /* Refused before a session exists. Invariant W5 is violated by the offer, not by the
       * call, so there is nothing to observe and nothing to weigh. */
      return failure(
        'TOOL_SURFACE_VIOLATION',
        `the dispatch was granted ${spawning.join(', ')}, which reads as a way to start `
        + 'another agent. No agent may invoke another agent',
        {
          substrate: this.name,
          verdict: 'UNEXPECTED_TOOLS',
          expected: [...expected].sort(),
          effective: [],
          unexpected: [...spawning].sort(),
          missing: [],
          detail:
            'refused before the session was opened, so no surface was observed and none had '
            + 'to be',
        },
        ZERO_COST,
        model,
      );
    }

    const allowed = new Set(expected);
    /* Per-dispatch state, held in this call's own object rather than on the instance, so
     * that two dispatches over one substrate cannot see each other's. */
    const guard = new DispatchGuard();

    const invoke: TransportRequest['invoke'] = async (toolName, args) => {
      if (guard.securityViolation !== null) {
        return { ok: false, message: 'refused: this dispatch is aborting on a security violation' };
      }
      if (!guard.conforming) {
        /*
         * The surface is asserted before anything reaches the world, and this is where that
         * ordering is enforced rather than assumed. A transport that reported its surface
         * late, or not at all, cannot get a tool call through in the meantime.
         */
        return {
          ok: false,
          message:
            'refused: the effective tool surface has not been asserted for this dispatch, and '
            + 'an unasserted surface is not permission to reach anything',
        };
      }
      if (!allowed.has(toolName)) {
        return {
          ok: false,
          message:
            `refused: ${toolName} is not one of the operations this dispatch was granted. The `
            + 'tool surface is an allowlist',
        };
      }
      const result = await invoker.invoke(toolName, args);
      switch (result.outcome) {
        case 'OK':
          return { ok: true, value: result.value };
        case 'REFUSED':
          if (result.abortDispatch) {
            guard.securityViolation = `${toolName}: ${result.message}`;
            void session.close();
          }
          return { ok: false, message: `refused (${result.refusal}): ${result.message}` };
        case 'ERROR':
          return { ok: false, message: `error: ${result.message}` };
        default:
          return assertNever(result, 'tool invocation outcome');
      }
    };

    const spec = this.#specs.get(`${input.agent}/${input.mandate_name}`);
    const session = this.#transport.open({
      model,
      systemPrompt: renderSystemSpecification(input, spec),
      prompt: renderDispatchBrief(input),
      tools: toolsOf(grants),
      maxTurns: input.budget.max_turns,
      maxBudgetUsd: input.budget.max_usd,
      invoke,
    });

    const timer = setTimeout(() => {
      guard.timedOut = true;
      void session.close();
    }, input.budget.max_wall_clock_ms);

    let surface: ToolSurfaceReport | null = null;
    let result: Extract<TransportEvent, { kind: 'RESULT' }> | null = null;
    let thrown: string | null = null;

    try {
      for await (const event of session) {
        if (event.kind === 'SURFACE') {
          surface = evaluateSurface({
            substrate: this.name,
            grants,
            observed: event.surface,
            qualify: (name) => this.#transport.qualify(name),
          });
          if (surface.verdict !== 'CONFORMS') break;
          guard.conforming = true;
          continue;
        }
        result = event;
        break;
      }
    } catch (error) {
      thrown = messageOf(error);
    } finally {
      clearTimeout(timer);
      await session.close();
    }

    const cost = result?.cost ?? ZERO_COST;
    const ran = result?.model ?? model;

    if (guard.securityViolation !== null) {
      return failure(
        'SECURITY_VIOLATION',
        'an adapter refused a call as a security violation and the dispatch was aborted: '
        + `${guard.securityViolation}. A security violation is reported regardless of the `
        + 'outcome of the run',
        surface,
        cost,
        ran,
      );
    }

    if (surface !== null && surface.verdict !== 'CONFORMS') {
      return failure('TOOL_SURFACE_VIOLATION', surface.detail, surface, cost, ran);
    }

    if (guard.timedOut) {
      return failure(
        'TIMEOUT',
        `the dispatch exceeded its wall-clock budget of ${input.budget.max_wall_clock_ms}ms `
        + 'and was aborted',
        surface,
        cost,
        ran,
      );
    }

    if (surface === null) {
      const unverifiable = evaluateSurface({
        substrate: this.name,
        grants,
        observed: null,
        qualify: (name) => this.#transport.qualify(name),
      });
      return failure(
        'TOOL_SURFACE_VIOLATION',
        `${unverifiable.detail}${thrown === null ? '' : `: ${thrown}`}`,
        unverifiable,
        cost,
        ran,
      );
    }

    if (thrown !== null) {
      return failure('SUBSTRATE_ERROR', thrown, surface, cost, ran);
    }

    if (result === null) {
      return failure(
        'SUBSTRATE_ERROR',
        'the session ended without producing a result. A session that stops mid-turn has '
        + 'produced no envelope, and treating silence as an answer is how a partial dispatch '
        + 'becomes a complete one',
        surface,
        cost,
        ran,
      );
    }

    if (result.failure !== null) {
      return failure(mapFailure(result.failure), result.detail, surface, cost, ran);
    }

    const parsed = parseEnvelope(result.text);
    if (!parsed.ok) {
      return failure('MALFORMED_ENVELOPE', parsed.detail, surface, cost, ran);
    }

    return {
      outcome: 'ENVELOPE',
      envelope: parsed.envelope,
      toolSurface: surface,
      cost: { ...cost, usd: cost.usd },
      model: ran,
    };
  }
}

/* --------------------------------------------------------------------------- helpers ---- */

/**
 * The three facts about a dispatch that the tool path and the message loop both need.
 *
 * It is one object per call to `dispatch`, never a field on the substrate. Two dispatches
 * over one substrate must not be able to see each other's state at all, and holding it here
 * makes that structural rather than careful.
 */
class DispatchGuard {
  /** Set only after the effective surface has been observed and found to conform. */
  conforming = false;
  /** The refusal that aborted the dispatch, or `null`. */
  securityViolation: string | null = null;
  /** Set when the wall-clock budget ran out. */
  timedOut = false;
}

function failure(
  kind: SubstrateFailure,
  detail: string,
  toolSurface: ToolSurfaceReport | null,
  cost: TransportCost,
  model: string | null,
): SubstrateResult {
  return { outcome: 'FAILED', failure: kind, detail, toolSurface, cost, model };
}

/**
 * The transport's vocabulary mapped to the contract's.
 *
 * `max_turns` and `max_usd` are both `DispatchBudget` fields, so exceeding either is a budget
 * failure; `max_wall_clock_ms` is the one the contract gives its own name to.
 */
function mapFailure(kind: TransportFailure): SubstrateFailure {
  switch (kind) {
    case 'NO_MODEL':
      return 'NO_MODEL';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'BUDGET_EXCEEDED':
    case 'MAX_TURNS':
      return 'BUDGET_EXCEEDED';
    case 'ERROR':
      return 'SUBSTRATE_ERROR';
    default:
      return assertNever(kind, 'transport failure');
  }
}

function toolsOf(grants: readonly ToolGrant[]): readonly TransportTool[] {
  return grants.map((grant) => ({
    name: grant.tool_name,
    description: grant.description,
    args_schema: grant.args_schema,
  }));
}

function refuseEverything(): Promise<{ ok: false; message: string }> {
  return Promise.resolve({
    ok: false,
    message:
      'refused: this is a conformance probe. It exists to read the tool surface and reaches '
      + 'nothing',
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CONFORMANCE_SYSTEM_PROMPT =
  'This session exists to report its own tool surface and is closed before any turn runs. '
  + 'There is nothing to do.';

const CONFORMANCE_PROMPT = 'Report nothing and take no action.';

/* ------------------------------------------------------- the Claude Agent SDK itself ---- */

/** The in-process MCP server name. Tools appear as `mcp__<server>__<tool_name>`. */
const SERVER_NAME = 'agentos';
const SERVER_VERSION = '0.3.0';

/**
 * The MCP protocol version answered when a client offers none.
 *
 * The client here is the harness this substrate is embedded in, so its offer is echoed: a
 * server that speaks only `initialize`, `ping`, `tools/list` and `tools/call` implements
 * those the same way in every revision that has defined them.
 */
const PROTOCOL_FALLBACK = '2025-06-18';

/**
 * Built-in names that mean "start another agent", denied explicitly.
 *
 * This is the backstop and never the mechanism. D-2 is explicit that the surface is an
 * allowlist and not a denylist, and `tools: []` is what makes every built-in absent; this
 * list only ensures that if a future SDK reintroduced one through some path the allowlist
 * did not cover, it would still be refused. A denylist that were load-bearing would be the
 * failure mode D-2 exists to prevent.
 */
const DENIED_SPAWNING_TOOLS: readonly string[] = ['Task', 'Agent', 'SendMessage'];

/**
 * The permission callback's decision, as a function so that it can be asserted on.
 *
 * This is the second of the three layers on the spawning rule and, more generally, the
 * defence in depth behind the allowlist: even if a tool somehow existed that the kernel did
 * not grant, calling it is denied here, and `interrupt: true` ends the turn rather than
 * letting the agent try the next thing. It is deliberately a total function of the allowlist
 * and the name — no state, no policy, nothing to get out of step.
 */
export function permitTool(
  allowedTools: readonly string[],
  toolName: string,
): PermissionResult {
  if (allowedTools.includes(toolName)) return { behavior: 'allow' };
  return {
    behavior: 'deny',
    message:
      `${toolName} is not one of the operations this dispatch was granted. AgentOS exposes an `
      + 'allowlist, and everything outside it is refused.',
    interrupt: true,
  };
}

export class ClaudeCodeTransport implements DispatchTransport {
  readonly name = 'claude-agent-sdk';
  readonly #serverName: string;

  constructor(options: { readonly serverName?: string } = {}) {
    this.#serverName = options.serverName ?? SERVER_NAME;
  }

  qualify(toolName: string): string {
    return `mcp__${this.#serverName}__${toolName}`;
  }

  open(request: TransportRequest): TransportSession {
    return new ClaudeCodeSession(request, this.#serverName);
  }
}

class ClaudeCodeSession implements TransportSession {
  readonly #request: TransportRequest;
  readonly #serverName: string;
  readonly #controller = new AbortController();
  #sandbox: string | null = null;
  #stream: { close(): void } | null = null;
  #model: string | null = null;
  #closed = false;

  constructor(request: TransportRequest, serverName: string) {
    this.#request = request;
    this.#serverName = serverName;
  }

  [Symbol.asyncIterator](): AsyncIterator<TransportEvent> {
    return this.#run();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort();
    try {
      this.#stream?.close();
    } catch {
      /* Closing an already-finished query is not an error worth surfacing: the session is
       * over either way, and the sandbox below is what actually has to be cleaned up. */
    }
    this.#stream = null;
    const sandbox = this.#sandbox;
    this.#sandbox = null;
    if (sandbox !== null) await rm(sandbox, { recursive: true, force: true });
  }

  async *#run(): AsyncGenerator<TransportEvent, void> {
    const schemaProblem = checkToolSchemas(this.#request.tools);
    if (schemaProblem !== null) {
      yield errorResult(schemaProblem);
      return;
    }

    const sdk = await import('@anthropic-ai/claude-agent-sdk');

    /*
     * One directory per dispatch, and it is both the working directory and the harness's
     * configuration home. The working directory is empty because the agent's reach to a
     * repository is the adapter operations it was granted and nothing else; the
     * configuration home is per-dispatch so that no session state can outlive the dispatch
     * that produced it even if a future SDK wrote some despite `persistSession: false`.
     */
    const sandbox = await mkdtemp(join(tmpdir(), 'agentos-dispatch-'));
    this.#sandbox = sandbox;
    const cwd = join(sandbox, 'cwd');
    const configHome = join(sandbox, 'config');
    await mkdir(cwd, { recursive: true });
    await mkdir(configHome, { recursive: true });

    if (this.#closed) {
      await rm(sandbox, { recursive: true, force: true });
      this.#sandbox = null;
      return;
    }

    const server = new AdapterToolServer(
      this.#serverName,
      this.#request.tools,
      this.#request.invoke,
    );
    const allowedTools = this.#request.tools.map((tool) => `mcp__${this.#serverName}__${tool.name}`);

    const options: Options = {
      abortController: this.#controller,
      /* An empty directory. Nothing the agent could read is here, and nothing it writes
       * survives the dispatch. */
      cwd,
      /* `env` REPLACES the subprocess environment rather than merging, so the parent's is
       * spread deliberately: the harness needs PATH, a home directory and whatever
       * credential the host is configured with, and stripping those would fail the run for
       * reasons that look like model unavailability. */
      env: { ...process.env, CLAUDE_CONFIG_DIR: configHome },
      /* Rule 1. Every built-in tool absent rather than forbidden. */
      tools: [],
      /* Exactly the granted adapter operations, auto-allowed without prompting. */
      allowedTools,
      /* The backstop described above; never the mechanism. */
      disallowedTools: [...DENIED_SPAWNING_TOOLS],
      /*
       * `dontAsk` is the only mode that neither prompts nor auto-approves: `default` prompts,
       * `acceptEdits` auto-accepts edits, `bypassPermissions` bypasses every check, `plan`
       * executes no tools at all, and `auto` hands the decision to a model classifier —
       * which is precisely the thing a permission boundary may not be.
       */
      permissionMode: 'dontAsk',
      /* `'host'` so `canUseTool` below is consulted; `'none'` would skip it entirely. */
      permissionPrompts: 'host',
      canUseTool: (toolName: string): Promise<PermissionResult> => Promise.resolve(
        permitTool(allowedTools, toolName),
      ),
      mcpServers: {
        [this.#serverName]: {
          type: 'sdk',
          name: this.#serverName,
          /*
           * The server instance is this file's own. `createSdkMcpServer` and `tool()` take a
           * Zod raw shape for `inputSchema`, and `ToolGrant.args_schema` is JSON Schema —
           * the source of truth for every shape in AgentOS. Converting it would need a Zod
           * dependency this package does not have and may not add, and declaring the tools
           * with an empty shape would drop the arguments entirely, because an empty Zod
           * object strips unknown keys. `McpServerConfig` admits an instance directly, so
           * the schema is passed through exactly as the adapter declared it.
           */
          instance: server as unknown as McpSdkServerConfigWithInstance['instance'],
        },
      },
      /* Ignore project `.mcp.json`, user settings, plugins and agent frontmatter MCP. */
      strictMcpConfig: true,
      /* No user, project or organisation setting may widen any of the above. */
      settingSources: [],
      plugins: [],
      /* A skill is reached through the Skill tool, which `tools: []` removed; declaring none
       * says so rather than relying on that. */
      skills: [],
      /* Nothing written to disk, and nothing to resume even if something were. */
      persistSession: false,
      includePartialMessages: false,
      forwardSubagentText: false,
      /*
       * The role specification, verbatim. Not `{ type: 'preset', preset: 'claude_code' }`:
       * that preset is the coding harness's own instructions, which describe a different job
       * and a tool surface this dispatch does not have.
       */
      systemPrompt: { type: 'custom', prompt: this.#request.systemPrompt, snapshot: false },
      maxTurns: this.#request.maxTurns,
      maxBudgetUsd: this.#request.maxBudgetUsd,
    };
    if (this.#request.model !== null) {
      /* No `fallbackModel`. The kernel selects the model and records what it selected; a
       * silent substitution would make that record wrong. */
      options.model = this.#request.model;
    }

    let stream: Query;
    try {
      stream = sdk.query({ prompt: this.#request.prompt, options });
      this.#stream = stream;
    } catch (error) {
      yield errorResult(messageOf(error));
      return;
    }

    try {
      for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init') {
          this.#model = message.model;
          yield { kind: 'SURFACE', surface: surfaceOf(message) };
          continue;
        }
        if (message.type === 'result') {
          yield resultOf(message, this.#model);
          return;
        }
      }
      yield errorResult(
        'the session ended without a result message, so the turn produced no final text',
        this.#model,
      );
    } catch (error) {
      yield {
        kind: 'RESULT',
        text: '',
        failure: classify(messageOf(error)),
        detail: messageOf(error),
        cost: ZERO_COST,
        model: this.#model,
      };
    }
  }

}

/**
 * MCP requires an object schema per tool, and an operation whose schema is not one cannot be
 * exposed honestly.
 *
 * Refusing produces a precise failure the operator can act on. Exposing it anyway would
 * produce a tool the model cannot call correctly *and* a conformance report saying the
 * surface is fine — which is the combination the whole check exists to prevent.
 */
export function checkToolSchemas(tools: readonly TransportTool[]): string | null {
  for (const tool of tools) {
    const schema: unknown = tool.args_schema;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      return `${tool.name} declares an argument schema that is not a JSON Schema object`;
    }
    const type = (schema as Record<string, unknown>)['type'];
    if (type !== 'object') {
      return (
        `${tool.name} declares an argument schema of type ${JSON.stringify(type)}. A tool's `
        + 'arguments are an object, and exposing one whose schema says otherwise would '
        + 'advertise a call shape that cannot be made'
      );
    }
  }
  return null;
}

/**
 * The `system`/`init` message, read as an observation rather than as a confirmation.
 *
 * `tools` and `agents` are the two fields D-2's check turns on. The rest is recorded in
 * `detail` because a report that says only "conforms" leaves nobody able to tell a session
 * that was configured correctly from one that was configured for something else and happened
 * to expose the same tools.
 */
function surfaceOf(message: SDKSystemMessage): ObservedSurface {
  const servers = message.mcp_servers.map((entry) => `${entry.name}:${entry.status}`);
  return {
    tools: message.tools,
    agents: message.agents ?? [],
    detail:
      `init reports model ${message.model}, permission mode ${message.permissionMode}, mcp `
      + `servers [${servers.join(', ')}], ${message.slash_commands.length} slash command(s), `
      + `${message.skills.length} skill(s)`,
  };
}

function resultOf(message: SDKResultMessage, model: string | null): TransportEvent {
  const cost = costOf(message);
  switch (message.subtype) {
    case 'success':
      if (message.is_error) {
        return {
          kind: 'RESULT',
          text: '',
          failure: classify(message.result),
          detail: message.result,
          cost,
          model,
        };
      }
      return { kind: 'RESULT', text: message.result, failure: null, detail: '', cost, model };
    case 'error_max_turns':
      return {
        kind: 'RESULT',
        text: '',
        failure: 'MAX_TURNS',
        detail: `the dispatch used its ${message.num_turns} permitted turns without answering`,
        cost,
        model,
      };
    case 'error_max_budget_usd':
      return {
        kind: 'RESULT',
        text: '',
        failure: 'BUDGET_EXCEEDED',
        detail: `the dispatch exceeded its cost budget at ${message.total_cost_usd} USD`,
        cost,
        model,
      };
    case 'error_during_execution':
    case 'error_max_structured_output_retries': {
      const detail = message.errors.join('; ');
      return { kind: 'RESULT', text: '', failure: classify(detail), detail, cost, model };
    }
    default:
      return assertNever(message, 'sdk result subtype');
  }
}

function costOf(message: SDKResultMessage): TransportCost {
  let input = 0;
  let output = 0;
  for (const usage of Object.values(message.modelUsage)) {
    input += usage.inputTokens;
    output += usage.outputTokens;
  }
  return { input_tokens: input, output_tokens: output, usd: message.total_cost_usd };
}

/**
 * Which failures mean "no model was reachable".
 *
 * SKILL_AND_MODEL_SELECTION treats model unavailability as an ordinary, expected condition
 * rather than an exception, and the kernel handles it differently from a substrate defect:
 * it retries per policy, escalates the model once, then blocks with `EXTERNAL_DEPENDENCY`
 * and resumes at the same point when a model returns. Anything this does not recognize is
 * `ERROR`, which is the conservative direction — a generic substrate error advances nothing
 * either, and it does not claim to know why.
 */
const NO_MODEL_PATTERNS: readonly RegExp[] = [
  /\bno (?:such )?model\b/i,
  /\bmodel\b[^.]{0,60}\b(?:not found|not available|unavailable|unknown|not supported)\b/i,
  /\b(?:invalid|missing|expired)\b[^.]{0,30}\b(?:api key|credential|token)\b/i,
  /\bauthentication[_ ]?error\b/i,
  /\bANTHROPIC_API_KEY\b/,
  /\bcredit balance\b/i,
  /\b(?:401|403)\b/,
];

function classify(detail: string): TransportFailure {
  return NO_MODEL_PATTERNS.some((pattern) => pattern.test(detail)) ? 'NO_MODEL' : 'ERROR';
}

function errorResult(detail: string, model: string | null = null): TransportEvent {
  return { kind: 'RESULT', text: '', failure: 'ERROR', detail, cost: ZERO_COST, model };
}

/* ------------------------------------------------------- the in-process tool server ---- */

/**
 * The MCP transport the SDK hands an in-process server.
 *
 * Structural rather than imported: `@modelcontextprotocol/sdk` is a peer of the Agent SDK
 * and not a dependency of this package, and the contract this side needs is four methods and
 * three callbacks.
 */
export interface McpTransportLike {
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

class RpcFault extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcFault';
    this.code = code;
  }
}

/**
 * The granted adapter operations, served as MCP tools and nothing else.
 *
 * Every handler does one thing: forward to the injected invoker and return what it says.
 * There is no adapter reference here, no filesystem access, no branching on the tool name
 * and no interpretation of the result — the enforcement lives in the adapters, where
 * KERNEL_BOUNDARY puts it, and a tool server that did any of its own would be a second place
 * to look for a check that is supposed to be in one.
 *
 * It implements `initialize`, `ping`, `tools/list` and `tools/call`. Anything else is
 * answered with "method not found", because a server that answered a method it does not
 * implement would be claiming a capability.
 */
export class AdapterToolServer {
  readonly #name: string;
  readonly #tools: readonly TransportTool[];
  readonly #invoke: TransportRequest['invoke'];
  #transport: McpTransportLike | null = null;

  constructor(
    name: string,
    tools: readonly TransportTool[],
    invoke: TransportRequest['invoke'],
  ) {
    this.#name = name;
    this.#tools = tools;
    this.#invoke = invoke;
  }

  async connect(transport: McpTransportLike): Promise<void> {
    this.#transport = transport;
    transport.onmessage = (message: unknown): void => {
      void this.#receive(message);
    };
    await transport.start();
  }

  async close(): Promise<void> {
    const transport = this.#transport;
    this.#transport = null;
    if (transport !== null) await transport.close();
  }

  async #receive(message: unknown): Promise<void> {
    if (!isRecord(message)) return;
    const method = message['method'];
    /* Not a request. This server sends none, so anything without a method is not ours. */
    if (typeof method !== 'string') return;

    const id = message['id'];
    const answerable = typeof id === 'string' || typeof id === 'number';
    if (method.startsWith('notifications/')) return;

    try {
      const result = await this.#handle(method, message['params']);
      if (answerable) await this.#send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (!answerable) return;
      const fault = error instanceof RpcFault ? error : new RpcFault(-32603, messageOf(error));
      await this.#send({
        jsonrpc: '2.0',
        id,
        error: { code: fault.code, message: fault.message },
      });
    }
  }

  async #handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: negotiate(params),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.#name, version: SERVER_VERSION },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: this.#tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            /* The adapter's own JSON Schema, unaltered. */
            inputSchema: tool.args_schema,
          })),
        };
      case 'tools/call':
        return await this.#call(params);
      default:
        throw new RpcFault(
          -32601,
          `${this.#name} serves initialize, ping, tools/list and tools/call. ${method} is not `
          + 'implemented, and answering it would be claiming a capability this server does '
          + 'not have',
        );
    }
  }

  async #call(params: unknown): Promise<unknown> {
    const request = isRecord(params) ? params : {};
    const name = request['name'];
    if (typeof name !== 'string') {
      throw new RpcFault(-32602, 'tools/call requires the name of the tool to call');
    }
    const tool = this.#tools.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      throw new RpcFault(
        -32602,
        `${name} is not one of the operations this dispatch was granted`,
      );
    }
    const args = request['arguments'];
    const outcome = await this.#invoke(name, isRecord(args) ? args : {});
    if (outcome.ok) {
      return { content: [{ type: 'text', text: render(outcome.value) }], isError: false };
    }
    return { content: [{ type: 'text', text: outcome.message }], isError: true };
  }

  async #send(message: unknown): Promise<void> {
    const transport = this.#transport;
    if (transport === null) return;
    await transport.send(message);
  }
}

function negotiate(params: unknown): string {
  if (isRecord(params)) {
    const offered = params['protocolVersion'];
    if (typeof offered === 'string' && offered !== '') return offered;
  }
  return PROTOCOL_FALLBACK;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function render(value: unknown): string {
  if (typeof value === 'string') return value;
  /* `JSON.stringify` is typed as returning a string and returns `undefined` for a value
   * with no JSON form. An adapter result should always have one; if it ever does not, the
   * agent reads `null` rather than the word `undefined`. */
  const json: unknown = JSON.stringify(value);
  return typeof json === 'string' ? json : 'null';
}
