import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  McpSdkServerConfigWithInstance,
  Options,
  PermissionResult,
  SDKMessage,
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
} from '@intentra/contracts';
import type { PolicySet } from '@intentra/policies';
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
 * shell, search and web tools and with subagent spawning, and Intentra requires the opposite
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
 *
 *    That last rule is only tenable because of `DISABLE_BUILTIN_AGENTS` below: the harness
 *    publishes its own built-in agent roster in `init.agents` whether or not anything can
 *    reach an entry, so a session that did not disable them advertises five names and fails
 *    a check that is right to refuse them. The answer is to disable the roster at its source
 *    rather than to teach the check which names are currently benign — Intentra does not
 *    track Claude Code's built-in agent names, and a harness upgrade that adds one changes
 *    nothing here.
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

/**
 * The SDK control that empties the harness's built-in agent roster, and the value it reads.
 *
 * `init.agents` is not curated metadata: it is `activeAgents.map(a => a.agentType)`, the same
 * list the harness resolves a subagent launch against. Under `settingSources: []` that list is
 * whatever the build compiles in — five names in 0.3.260 (`claude`, `Explore`,
 * `general-purpose`, `Plan`, `statusline-setup`), each behind an independent internal flag, so
 * it is neither stable across versions nor derivable from one. Pinning it would make Intentra
 * responsible for tracking Claude Code's internals; disabling it makes the question not arise.
 *
 * The variable is parsed as a boolean, not read for truthiness — `0` and `false` leave the
 * roster populated — so the value matters and is asserted by the tests. The control applies
 * only to a non-interactive host, which every Intentra dispatch is.
 *
 * Verified by running the installed 0.3.260 binary under this file's own options: unset, `0`
 * and `false` each advertise the five; `1` and `true` each advertise none.
 */
const DISABLE_BUILTIN_AGENTS = { name: 'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS', value: '1' } as const;

/**
 * The environment one dispatch's harness subprocess runs under.
 *
 * A function rather than an inline literal so that what reaches the subprocess can be asserted
 * without starting one: the two things this boundary depends on are that the roster is disabled
 * and that the configuration directory is the sandbox, and both are properties of this value.
 */
export function dispatchEnvironment(configHome: string, tempDir?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: configHome,
    [DISABLE_BUILTIN_AGENTS.name]: DISABLE_BUILTIN_AGENTS.value,
    /* WP-8 Prompt 4: the harness's own temporary files stay inside the protected folder. */
    ...(tempDir === undefined ? {} : { TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir }),
  };
}

/** How long a conformance probe is allowed to take before it is treated as unobservable. */
const CONFORMANCE_PROBE_MS = 120_000;

/** SDK 0.3.260 rejects `--max-budget-usd 0` before `system`/`init`; smallest positive value. */
const CONFORMANCE_PROBE_BUDGET_USD = 0.01;

/**
 * The two costs a dispatch can report without a figure from the SDK (WP-8 Prompt 4).
 *
 * `usd: 0` asserts that no session was opened, so nothing could have been charged; the kernel
 * releases the dispatch's reservation on it. `usd: null` asserts nothing: a session may have
 * run, and the kernel keeps the whole reservation. A figure the SDK does report is its own
 * `total_cost_usd` estimate, not an invoice.
 */
const NOT_DISPATCHED: TransportCost = { input_tokens: 0, output_tokens: 0, usd: 0 };
const UNKNOWN_COST: TransportCost = { input_tokens: 0, output_tokens: 0, usd: null };

export interface ClaudeAgentSdkSubstrateOptions {
  /**
   * The transport to run over. Injected so the boundary can be tested without a model, an
   * API key or a network — and so that D-2's reversal, if it is ever taken, replaces one
   * implementation of one interface.
   */
  readonly transport?: DispatchTransport;
  /** The role specifications whose hard limits and declarations reach the agent. */
  readonly specs?: readonly RoleSpec[];
  /** The kernel's policy set, whose DoD profiles tell each dispatch the evidence kinds its criteria accept. */
  readonly policies?: PolicySet;
}

export class ClaudeAgentSdkSubstrate implements AgentSubstrate {
  readonly name: string;
  readonly #transport: DispatchTransport;
  readonly #specs: ReadonlyMap<string, RoleSpec>;
  readonly #policies: PolicySet | undefined;

  constructor(options: ClaudeAgentSdkSubstrateOptions = {}) {
    this.#transport = options.transport ?? new ClaudeCodeTransport();
    this.name = this.#transport.name;
    this.#policies = options.policies;
    this.#specs = new Map(
      (options.specs ?? MVP_ROLE_SPECS).map((spec) => [`${spec.role}/${spec.mandate_name}`, spec]),
    );
  }

  /**
   * D-2's startup check: open a session with the grants in force, read the surface the
   * substrate reports, and close before a turn happens.
   *
   * The probe spends nothing — it is closed at the init message, before the first request,
   * and `CONFORMANCE_PROBE_BUDGET_USD` is the backstop if the close ever races. What it costs
   * is one subprocess start, once, in exchange for the difference between asserting a
   * configuration and observing its effect.
   */
  async conformance(grants: readonly ToolGrant[]): Promise<ToolSurfaceReport> {
    let observed: ObservedSurface | null = null;
    let detail = '';
    let session: TransportSession | null = null;
    const timer = setTimeout(() => {
      detail = `the probe did not report a surface within ${CONFORMANCE_PROBE_MS}ms`;
      void closeQuietly(session);
    }, CONFORMANCE_PROBE_MS);

    try {
      session = this.#transport.open({
        model: null,
        systemPrompt: CONFORMANCE_SYSTEM_PROMPT,
        prompt: CONFORMANCE_PROMPT,
        tools: toolsOf(grants),
        maxTurns: 1,
        maxBudgetUsd: CONFORMANCE_PROBE_BUDGET_USD,
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
      await closeQuietly(session);
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
        NOT_DISPATCHED,
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
        NOT_DISPATCHED,
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
          return { ok: true, value: result.value, excerpt: result.excerpt };
        case 'REFUSED':
          if (result.abortDispatch) {
            guard.securityViolation = `${toolName}: ${result.message}`;
            void closeQuietly(session);
          }
          return { ok: false, message: `refused (${result.refusal}): ${result.message}` };
        case 'ERROR':
          return { ok: false, message: `error: ${result.message}` };
        default:
          return assertNever(result, 'tool invocation outcome');
      }
    };

    const spec = this.#specs.get(`${input.agent}/${input.mandate_name}`);
    let session: TransportSession;
    try {
      session = this.#transport.open({
        model,
        systemPrompt: renderSystemSpecification(input, spec, this.#policies),
        prompt: renderDispatchBrief(input),
        tools: toolsOf(grants),
        maxTurns: input.budget.max_turns,
        maxBudgetUsd: input.budget.max_usd,
        invoke,
      });
    } catch (error) {
      /* WP-8 Prompt 4: a transport that threw on open may already have started something. */
      return failure('SUBSTRATE_ERROR', messageOf(error), null, UNKNOWN_COST, model);
    }

    const timer = setTimeout(() => {
      guard.timedOut = true;
      void closeQuietly(session);
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
      /*
       * The one line the WP-8 pilot turned on. A throw from a `finally` supersedes whatever
       * the `try` computed, so an unguarded close here does not merely fail — it deletes the
       * result, the surface report and the failure classification on its way out.
       */
      await closeQuietly(session);
    }

    const cost = result?.cost ?? UNKNOWN_COST;
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

    if (surface === null && result !== null && result.failure !== null && result.cost.usd === 0) {
      /* WP-8 Prompt 4: the transport confirmed it started nothing, so there was no surface to observe. */
      return failure(mapFailure(result.failure), result.detail, null, cost, ran);
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

/**
 * Close a session without letting the close decide the dispatch.
 *
 * `ClaudeCodeSession.close()` already absorbs its own cleanup failure, so over the real
 * transport this catch never fires. It is here for every *other* implementation of the port.
 * `DispatchTransport` is the seam D-2 keeps swappable, `close()` returns a promise, and a
 * `dispatch()` whose totality depended on each future transport's teardown being well-behaved
 * would be total by agreement rather than by construction. `dispatch()` and `conformance()`
 * both promise a value on every path; this is what makes that structural.
 *
 * The `void` callers need it for a second reason. An unhandled rejection ends the process
 * under Node's default policy, which loses the outcome exactly as throwing would — and those
 * two call sites fire on the timeout and security-violation paths, where there is a failure
 * to report and reporting it is the whole point.
 */
async function closeQuietly(session: TransportSession | null): Promise<void> {
  try {
    await session?.close();
  } catch {
    /* Teardown cannot change what a dispatch found. */
  }
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
      `${toolName} is not one of the operations this dispatch was granted. Intentra exposes an `
      + 'allowlist, and everything outside it is refused.',
    interrupt: true,
  };
}

/**
 * How long the sandbox removal keeps trying before it accepts that it lost the race.
 *
 * `abortController.abort()` returns before the harness subprocess does, and on Windows a
 * directory that is any live process's current working directory cannot be removed — so the
 * removal races the child's exit and loses it with `EBUSY`. Retrying is what turns the
 * ordinary case of that race into a slow win, because the lock lifts the moment the child
 * exits.
 *
 * The bound is a wall clock rather than `fs.rm`'s own `maxRetries`, and that is a correction
 * made by measurement: `{ maxRetries: 10, retryDelay: 50 }` against a permanently locked
 * directory took **34 seconds**, because the retry budget is spent per path and the recursive
 * walk compounds it at every level. Thirty-four seconds added to a teardown is a second way
 * to lose a dispatch. A deadline is a bound that can be stated, and it holds whatever `fs.rm`
 * does internally.
 *
 * Two seconds is the compromise: long enough for a subprocess that is already being killed,
 * short enough that a genuinely stuck handle costs the run almost nothing. Past it the
 * directory is left behind and said out loud.
 */
const SANDBOX_REMOVAL_DEADLINE_MS = 2_000;
const SANDBOX_REMOVAL_RETRY_MS = 100;

/**
 * Remove one dispatch sandbox, and never fail the dispatch over it.
 *
 * This returns a description of the leak rather than throwing one, because throwing is what
 * it did in the WP-8 pilot: an `EBUSY` on the locked `cwd` propagated out of `close()`, out
 * of the `finally` in `dispatch()` — where a throw supersedes the result the `try` had
 * already computed — and out of the process, leaving a `dispatch_intent` in the log with no
 * `dispatch_result` after it and no work item to recover from. What a dispatch found is
 * decided by the model and the kernel. The state of a temporary directory is not part of
 * that finding and may not overwrite it.
 *
 * The leak is still said out loud. A warning reaches stderr, changes no exit code and ends
 * no process, and the alternative is what made the pilot's leftover sandbox discoverable
 * only by going and looking in `%TEMP%`.
 */
export async function discardSandbox(sandbox: string): Promise<string | null> {
  const deadline = Date.now() + SANDBOX_REMOVAL_DEADLINE_MS;
  for (;;) {
    try {
      /* `maxRetries` deliberately left at its default. The loop below owns the timing, and
       * two retry mechanisms would multiply rather than agree. */
      await rm(sandbox, { recursive: true, force: true });
      return null;
    } catch (error) {
      if (Date.now() >= deadline) {
        const detail = `${sandbox} could not be removed: ${messageOf(error)}`;
        process.emitWarning(detail, 'IntentraSandboxLeak');
        return detail;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, SANDBOX_REMOVAL_RETRY_MS));
    }
  }
}

/* -------------------------------------------------------------- the dispatch folder ---- */

/*
 * WP-8 Prompt 4. The configuration home is where the harness writes its session key, and on
 * Windows a folder made by `mkdtemp` under `%TEMP%` inherits `%TEMP%`'s ACL — in the pilot,
 * Modify for a sandbox group, an unresolved domain SID and an AppContainer — while the SDK's
 * mode 0600 means nothing there. So every session folder is made inside one root that inherits
 * nothing and names only the user and SYSTEM; the root and then the session tree are read back
 * by SID and judged; and the harness starts only when both pass. Any failure before that is a
 * dispatch that opened no session, reported at a cost of exactly zero.
 */

const SYSTEM_SID = 'S-1-5-18';
/** `FileSystemRights.FullControl`, which is what removing the folder afterwards needs. */
const FULL_CONTROL = 0x1f01ff;
const SID_PATTERN = /^S-1-\d+(?:-\d+)+$/;
/** `d-<pid>-<six>`: the owning process is in the name, so a sweep can tell a live session. */
const SESSION_NAME = /^d-(\d+)-[A-Za-z0-9]{6}$/;
/** How many stale folders one sweep removes, each under `discardSandbox`'s own deadline. */
const SWEEP_LIMIT = 8;

export interface AclEntry {
  readonly sid: string;
  readonly allow: boolean;
  readonly rights: number;
  readonly inherited: boolean;
  /** Applies only to children, not to the folder itself. */
  readonly inheritOnly: boolean;
}

/** A folder's security descriptor as SIDs, so nothing turns on resolving a name. */
export interface AclSnapshot {
  readonly path: string;
  readonly owner: string;
  /** Inheritance from the parent is blocked. */
  readonly protected: boolean;
  readonly rules: readonly AclEntry[];
}

/** The four operations the folder's protection rests on, injectable so each can be made to fail. */
export interface FolderSecurity {
  currentUser(): Promise<string>;
  /** Blocks inheritance, grants exactly the user and SYSTEM full control, and makes the user owner. */
  protect(path: string, user: string): Promise<void>;
  /** Makes the user the owner of a tree: an elevated process's new folders belong to Administrators. */
  own(path: string, user: string): Promise<void>;
  describe(paths: readonly string[]): Promise<readonly AclSnapshot[]>;
}

/**
 * Whether a dispatch folder may hold a session key: `null` if so, the reason if not.
 *
 * Owned by the user; every entry an allow for the user or SYSTEM; the user holding full
 * control of the folder itself, which is what lets the session be removed afterwards. The
 * root must also inherit nothing. A session folder inherits from that root, so its entries
 * may be inherited, and are held to the same two principals.
 */
export function judgeFolderAcl(acl: AclSnapshot, user: string, root: boolean): string | null {
  if (!SID_PATTERN.test(user)) return `the current user ${user} is not a SID`;
  if (acl.owner !== user) return `${acl.path} is owned by ${acl.owner}, not by ${user}`;
  if (root && !acl.protected) return `${acl.path} inherits permissions from its parent`;
  for (const rule of acl.rules) {
    if (!rule.allow) return `${acl.path} carries a deny entry for ${rule.sid}, which nothing here sets`;
    if (rule.sid !== user && rule.sid !== SYSTEM_SID) {
      return `${acl.path} grants ${rule.sid}, which is neither ${user} nor SYSTEM`;
    }
    if (root && rule.inherited) return `${acl.path} carries an entry inherited from its parent`;
  }
  const full = acl.rules.some((rule) => rule.sid === user && !rule.inheritOnly
    && (rule.rights & FULL_CONTROL) === FULL_CONTROL);
  return full ? null : `${acl.path} does not give ${user} full control, so it could not be cleaned up`;
}

const execFileAsync = promisify(execFile);

function system32(...path: string[]): string {
  return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', ...path);
}

/** Reads each path's owner, protection and entries as SIDs. Paths arrive in the environment, never in the script. */
const DESCRIBE_ACL = [
  "$ErrorActionPreference = 'Stop'",
  '$type = [System.Security.Principal.SecurityIdentifier]',
  "$out = @(foreach ($p in ($env:INTENTRA_ACL_PATHS -split '\\|')) {",
  '  $acl = Get-Acl -LiteralPath $p',
  '  [pscustomobject]@{ path = $p; owner = $acl.GetOwner($type).Value; protected = $acl.AreAccessRulesProtected;',
  '    rules = @($acl.GetAccessRules($true, $true, $type) | ForEach-Object { [pscustomobject]@{',
  "      sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq 'Allow');",
  '      rights = [int64]$_.FileSystemRights; inherited = $_.IsInherited;',
  '      inheritOnly = (($_.PropagationFlags -band 2) -ne 0) } }) }',
  '})',
  'ConvertTo-Json -InputObject $out -Depth 4 -Compress',
].join('\n');

function isAclSnapshot(value: unknown): value is AclSnapshot {
  if (!isRecord(value)) return false;
  const rules = value['rules'];
  return typeof value['path'] === 'string' && typeof value['owner'] === 'string'
    && typeof value['protected'] === 'boolean' && Array.isArray(rules)
    && rules.every((rule: unknown) => isRecord(rule) && typeof rule['sid'] === 'string'
      && typeof rule['allow'] === 'boolean' && typeof rule['rights'] === 'number'
      && typeof rule['inherited'] === 'boolean' && typeof rule['inheritOnly'] === 'boolean');
}

/** The Windows implementation: `whoami`, `icacls` and `Get-Acl`, each from System32 and without a shell. */
export class WindowsFolderSecurity implements FolderSecurity {
  async currentUser(): Promise<string> {
    const { stdout } = await execFileAsync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      windowsHide: true, timeout: 30_000,
    });
    const sid = /"(S-1-[\d-]+)"\s*$/.exec(stdout.trim())?.[1];
    if (sid === undefined || !SID_PATTERN.test(sid)) throw new Error('whoami reported no SID for the current user');
    return sid;
  }

  async protect(path: string, user: string): Promise<void> {
    /* Grant before anything else could leave the list empty, then take ownership. */
    await this.#icacls([path, '/inheritance:r', '/grant:r', `*${user}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`]);
    await this.#icacls([path, '/setowner', `*${user}`]);
  }

  async own(path: string, user: string): Promise<void> {
    await this.#icacls([path, '/setowner', `*${user}`, '/T', '/Q']);
  }

  async describe(paths: readonly string[]): Promise<readonly AclSnapshot[]> {
    const { stdout } = await execFileAsync(
      system32('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', DESCRIBE_ACL],
      { windowsHide: true, timeout: 60_000, env: { ...process.env, INTENTRA_ACL_PATHS: paths.join('|') } },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.length !== paths.length || !parsed.every(isAclSnapshot)) {
      throw new Error('the security descriptors could not be read back as SIDs');
    }
    return parsed;
  }

  async #icacls(args: readonly string[]): Promise<void> {
    await execFileAsync(system32('icacls.exe'), [...args], { windowsHide: true, timeout: 30_000 });
  }
}

/** Whether a process with this id is running. `EPERM` means it is, and belongs to someone else. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes session folders whose process has ended, at most `limit` of them.
 *
 * Only `d-<pid>-<six>` directories directly in the root are candidates, never a link. A folder
 * whose process is this one or is still running is kept, whatever its age: a reused process id
 * keeps a dead folder, which is the safe way to be wrong. Each removal is bounded by
 * `discardSandbox`, and a failure is reported and left.
 */
export async function sweepStaleSessions(
  root: string,
  options: { readonly limit?: number; readonly isAlive?: (pid: number) => boolean } = {},
): Promise<{ readonly removed: readonly string[]; readonly kept: readonly string[]; readonly failed: readonly string[] }> {
  const limit = options.limit ?? SWEEP_LIMIT;
  const isAlive = options.isAlive ?? processAlive;
  const removed: string[] = [];
  const kept: string[] = [];
  const failed: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { removed, kept, failed };
  }
  for (const entry of entries) {
    const match = SESSION_NAME.exec(entry.name);
    if (match === null || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const pid = Number(match[1]);
    const path = join(root, entry.name);
    if (pid === process.pid || isAlive(pid)) {
      kept.push(path);
      continue;
    }
    if (removed.length + failed.length >= limit) break;
    if (await discardSandbox(path) === null) removed.push(path);
    else failed.push(path);
  }
  return { removed, kept, failed };
}

/** Raised before the harness starts; it becomes a result that says no session was opened. */
class FolderRefusal extends Error {}

/** The default root: Windows protects one per user; elsewhere `mkdtemp`'s 0700 already does. */
function defaultDispatchRoot(): string | null {
  if (process.platform !== 'win32') return tmpdir();
  const local = process.env['LOCALAPPDATA'];
  return local === undefined || local === '' ? null : join(local, 'Intentra', 'dispatch');
}

/** Starts the harness; the Agent SDK's `query` unless a test passes a double. */
export type HarnessStarter = (request: { readonly prompt: string; readonly options: Options }) =>
  AsyncIterable<SDKMessage> & { close(): void };

export interface ClaudeCodeTransportOptions {
  readonly serverName?: string;
  /** Where session folders are made. `null` means no protected root exists, and nothing starts. */
  readonly dispatchRoot?: string | null;
  /** Defaults to `WindowsFolderSecurity` on Windows and to none elsewhere. */
  readonly security?: FolderSecurity | null;
  readonly startHarness?: HarnessStarter;
}

/** What one session needs to make its folder, shared by every session of one transport. */
interface DispatchPlace {
  readonly root: string | null;
  readonly security: FolderSecurity | null;
  readonly startHarness: HarnessStarter | null;
  /** Runs the stale sweep once per transport, after the root has passed its check. */
  sweepOnce(root: string): Promise<void>;
}

/** The three directories a session runs in, all inside its checked folder. */
interface PreparedFolder {
  readonly cwd: string;
  readonly configHome: string;
  readonly tempDir: string;
}

export class ClaudeCodeTransport implements DispatchTransport {
  readonly name = 'claude-agent-sdk';
  readonly #serverName: string;
  readonly #place: DispatchPlace;

  constructor(options: ClaudeCodeTransportOptions = {}) {
    this.#serverName = options.serverName ?? SERVER_NAME;
    let swept: Promise<void> | null = null;
    this.#place = {
      root: options.dispatchRoot === undefined ? defaultDispatchRoot() : options.dispatchRoot,
      security: options.security === undefined
        ? (process.platform === 'win32' ? new WindowsFolderSecurity() : null)
        : options.security,
      startHarness: options.startHarness ?? null,
      sweepOnce: (root) => {
        swept ??= sweepStaleSessions(root).then((outcome) => {
          for (const path of outcome.failed) process.emitWarning(`${path} could not be swept`, 'IntentraSandboxLeak');
        });
        return swept;
      },
    };
  }

  qualify(toolName: string): string {
    return `mcp__${this.#serverName}__${toolName}`;
  }

  open(request: TransportRequest): TransportSession {
    return new ClaudeCodeSession(request, this.#serverName, this.#place);
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

  /**
   * What this session could not clean up, where it could not.
   *
   * Nothing in the dispatch path reads it, and that is deliberate: a cleanup failure is not
   * an input to any decision the substrate makes. It is recorded because the alternative is
   * the one this file already took once — the sandbox stays, nothing says so, and the next
   * person to know is whoever finds it in `%TEMP%` afterwards.
   */
  cleanupFailure: string | null = null;

  readonly #place: DispatchPlace;

  constructor(request: TransportRequest, serverName: string, place: DispatchPlace) {
    this.#request = request;
    this.#serverName = serverName;
    this.#place = place;
  }

  /**
   * Makes this session's folder and proves it fit to hold a session key, or throws a refusal.
   *
   * The root is checked before anything is made in it, and the session tree after it is made
   * and owned, and nothing is written into it until both checks pass. A folder made and then
   * refused is removed by the caller, since `#sandbox` is set the moment it exists.
   */
  async #prepare(): Promise<PreparedFolder> {
    const { root, security } = this.#place;
    if (root === null) {
      throw new FolderRefusal(
        'no protected dispatch root is available: LOCALAPPDATA is not set, and a session key is '
        + 'not written anywhere less protected',
      );
    }
    let user: string | null = null;
    if (security !== null) {
      user = await security.currentUser();
      if ((await mkdir(root, { recursive: true })) !== undefined) await security.protect(root, user);
      const [rootAcl] = await security.describe([root]);
      const problem = rootAcl === undefined
        ? `${root} could not be read back`
        : judgeFolderAcl(rootAcl, user, true);
      if (problem !== null) throw new FolderRefusal(problem);
      await this.#place.sweepOnce(root);
    }

    const sandbox = await mkdtemp(join(root, security === null ? 'intentra-dispatch-' : `d-${process.pid}-`));
    this.#sandbox = sandbox;
    const cwd = join(sandbox, 'cwd');
    const configHome = join(sandbox, 'config');
    const tempDir = join(sandbox, 'tmp');
    for (const dir of [cwd, configHome, tempDir]) await mkdir(dir, { recursive: true });

    if (security !== null && user !== null) {
      await security.own(sandbox, user);
      const tree = [sandbox, cwd, configHome, tempDir];
      const acls = await security.describe(tree);
      for (const path of tree) {
        const acl = acls.find((candidate) => candidate.path === path);
        const problem = acl === undefined ? `${path} could not be read back` : judgeFolderAcl(acl, user, false);
        if (problem !== null) throw new FolderRefusal(problem);
      }
    }
    return { cwd, configHome, tempDir };
  }

  /** Removes a folder this session made before its harness could start. */
  async #abandon(): Promise<void> {
    const sandbox = this.#sandbox;
    this.#sandbox = null;
    if (sandbox !== null) this.cleanupFailure = await discardSandbox(sandbox);
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
    if (sandbox !== null) this.cleanupFailure = await discardSandbox(sandbox);
  }

  async *#run(): AsyncGenerator<TransportEvent, void> {
    const schemaProblem = checkToolSchemas(this.#request.tools);
    if (schemaProblem !== null) {
      yield errorResult(schemaProblem, null, NOT_DISPATCHED);
      return;
    }

    /*
     * One directory per dispatch, and it is both the working directory and the harness's
     * configuration home. The working directory is empty because the agent's reach to a
     * repository is the adapter operations it was granted and nothing else; the
     * configuration home is per-dispatch so that no session state can outlive the dispatch
     * that produced it even if a future SDK wrote some despite `persistSession: false`.
     */
    let folder: PreparedFolder;
    try {
      folder = await this.#prepare();
    } catch (error) {
      await this.#abandon();
      yield errorResult(`the dispatch folder was refused: ${messageOf(error)}`, null, NOT_DISPATCHED);
      return;
    }
    const { cwd, configHome, tempDir } = folder;

    if (this.#closed) {
      /* `#abandon` nulls the sandbox before removing it, so a `close()` arriving during the
       * retries cannot start a second removal of the same directory. */
      await this.#abandon();
      yield errorResult('the session was closed before its harness started', null, NOT_DISPATCHED);
      return;
    }

    let start: HarnessStarter;
    try {
      start = this.#place.startHarness ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
    } catch (error) {
      yield errorResult(messageOf(error), null, NOT_DISPATCHED);
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
       * reasons that look like model unavailability.
       *
       * Both assignments come after the spread and therefore win: an operator who exported
       * `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=0` cannot re-enable the built-in agents for
       * a dispatch, any more than one who exported `CLAUDE_CONFIG_DIR` can move the session
       * back onto their own configuration. */
      env: dispatchEnvironment(configHome, tempDir),
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
           * the source of truth for every shape in Intentra. Converting it would need a Zod
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

    let stream: ReturnType<HarnessStarter>;
    try {
      stream = start({ prompt: this.#request.prompt, options });
      this.#stream = stream;
    } catch (error) {
      /* A start that threw may already have spawned the harness, so its cost is not known to be zero. */
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
        cost: UNKNOWN_COST,
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
  /* WP-8 Prompt 4: a figure that is not a finite non-negative number is no figure at all. */
  const usd: unknown = message.total_cost_usd;
  return {
    input_tokens: input,
    output_tokens: output,
    usd: typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : null,
  };
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

function errorResult(
  detail: string,
  model: string | null = null,
  cost: TransportCost = UNKNOWN_COST,
): TransportEvent {
  return { kind: 'RESULT', text: '', failure: 'ERROR', detail, cost, model };
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
      /* JSON-encoded so the agent can paste it into its envelope byte for byte (WP-8). */
      return {
        content: [
          { type: 'text', text: render(outcome.value) },
          { type: 'text', text: `evidence excerpt (JSON string): ${JSON.stringify(outcome.excerpt)}` },
        ],
        isError: false,
      };
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
