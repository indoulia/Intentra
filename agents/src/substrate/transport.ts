import type { ObservedSurface } from './surface.js';

/**
 * The seam between the dispatch boundary and whatever actually runs a model.
 *
 * ARCHITECTURE_FREEZE D-2's reversal clause is explicit: "Keep the dispatch boundary narrow
 * enough that swapping it is a one-file change; if it is not, that is a defect in the
 * dispatch layer." This is the narrowing. Everything above it — building the input package,
 * the allowlist, the conformance arithmetic, the refusal to repair an envelope — is
 * substrate-independent, and the one file that reaches a real execution host implements
 * exactly the four members below.
 *
 * What the interface does **not** have is as load-bearing as what it does. There is no
 * session id, no resume, no continue, no fork, and no transcript in either direction. A
 * substrate cannot carry conversation across dispatches through this port because the port
 * has nowhere to put it: one dispatch is one fresh session, and the envelope is the only
 * transport. That is a property of the type rather than a rule someone has to keep.
 */
export interface DispatchTransport {
  /** Names the substrate in every `ToolSurfaceReport` it produces. */
  readonly name: string;
  /** How this substrate names a granted operation on the wire. */
  qualify(toolName: string): string;
  /** Starts one session. Nothing is shared with any session opened before or after. */
  open(request: TransportRequest): TransportSession;
}

/** One adapter operation, as the transport must advertise it. */
export interface TransportTool {
  readonly name: string;
  readonly description: string;
  /** The operation's JSON Schema, passed through unaltered from the `ToolGrant`. */
  readonly args_schema: Readonly<Record<string, unknown>>;
}

export type TransportToolResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

export interface TransportRequest {
  /** `null` asks the substrate for its own default, used only by the conformance probe. */
  readonly model: string | null;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly tools: readonly TransportTool[];
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  /**
   * The only path from a tool call to the world. The transport calls it and forwards the
   * answer; it never reaches an adapter itself and holds no other outward reference.
   */
  readonly invoke: (
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<TransportToolResult>;
}

/**
 * A running session.
 *
 * It emits at most one `SURFACE` — first, before anything else can happen — and exactly one
 * `RESULT`. The ordering is what makes the conformance check meaningful: a surface reported
 * after a tool ran would be a report about a session that had already reached the world.
 */
export interface TransportSession extends AsyncIterable<TransportEvent> {
  close(): Promise<void>;
}

export type TransportEvent =
  | { readonly kind: 'SURFACE'; readonly surface: ObservedSurface }
  | {
    readonly kind: 'RESULT';
    /** The final text, whatever it is. Never trimmed, extracted from or repaired. */
    readonly text: string;
    readonly failure: TransportFailure | null;
    readonly detail: string;
    readonly cost: TransportCost;
    /** What the substrate reported it ran on, where it said. */
    readonly model: string | null;
  };

/**
 * What went wrong, in the transport's own vocabulary.
 *
 * Deliberately not `SubstrateFailure`: the mapping from one to the other is a decision the
 * substrate makes and states, and a transport that could name a contract failure directly
 * would be making it.
 */
export type TransportFailure =
  | 'NO_MODEL'
  | 'TIMEOUT'
  | 'BUDGET_EXCEEDED'
  | 'MAX_TURNS'
  | 'ERROR';

export interface TransportCost {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly usd: number | null;
}
