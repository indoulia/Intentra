import {
  type AgentSubstrate,
  type InputPackage,
  type SubstrateFailure,
  type SubstrateResult,
  type ToolGrant,
  type ToolInvoker,
  type ToolSurfaceReport,
} from '@agentos/contracts';

/**
 * A substrate with no substrate behind it.
 *
 * IMPLEMENTATION_PLAN WP-5 asks for a fake that lets the dispatch boundary and the role
 * specifications be exercised with no model, and this is it: the kernel-facing half of the
 * contract, answering from a script.
 *
 * It is honest about the two things a fake could most easily lie about. Its tool surface is
 * computed from the grants it was actually given rather than asserted, so a test that
 * granted nothing sees an empty surface. And it enforces the allowlist itself, so a scripted
 * call to an operation the dispatch did not receive is refused here rather than reaching the
 * invoker — which is what a real substrate must do, and a fake that forwarded everything
 * would let a boundary defect pass.
 */
export interface ScriptedDispatch {
  /** Calls to make through the invoker before answering, in order. */
  readonly calls?: readonly {
    readonly tool: string;
    readonly args?: Readonly<Record<string, unknown>>;
  }[];
  /** The envelope to return, exactly as written and never repaired. */
  readonly envelope?: unknown;
  /** Answer with a failure instead. */
  readonly failure?: SubstrateFailure;
  readonly detail?: string;
}

export class ScriptedSubstrate implements AgentSubstrate {
  readonly name = 'scripted';
  readonly dispatched: InputPackage[] = [];
  readonly refused: string[] = [];
  #index = 0;

  constructor(private readonly script: readonly ScriptedDispatch[]) {}

  conformance(grants: readonly ToolGrant[]): Promise<ToolSurfaceReport> {
    return Promise.resolve(this.#surface(grants));
  }

  async dispatch(input: InputPackage, invoker: ToolInvoker): Promise<SubstrateResult> {
    this.dispatched.push(input);
    const step = this.script[this.#index];
    this.#index += 1;
    const surface = this.#surface(input.tools_granted);
    const cost = { input_tokens: 0, output_tokens: 0, usd: null };

    if (step === undefined) {
      return {
        outcome: 'FAILED',
        failure: 'SUBSTRATE_ERROR',
        detail: `the script holds ${this.script.length} dispatch(es) and a further one was asked for`,
        toolSurface: surface,
        cost,
        model: input.model,
      };
    }

    const allowed = new Set(input.tools_granted.map((g) => g.tool_name));
    for (const call of step.calls ?? []) {
      if (!allowed.has(call.tool)) {
        this.refused.push(call.tool);
        continue;
      }
      const result = await invoker.invoke(call.tool, call.args ?? {});
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

    if (step.failure !== undefined) {
      return {
        outcome: 'FAILED',
        failure: step.failure,
        detail: step.detail ?? '',
        toolSurface: surface,
        cost,
        model: input.model,
      };
    }

    return {
      outcome: 'ENVELOPE',
      envelope: step.envelope,
      toolSurface: surface,
      cost,
      model: input.model,
    };
  }

  #surface(grants: readonly ToolGrant[]): ToolSurfaceReport {
    const expected = grants.map((g) => g.tool_name).sort();
    return {
      substrate: this.name,
      verdict: 'CONFORMS',
      expected,
      effective: expected,
      unexpected: [],
      missing: [],
      detail:
        'a scripted substrate reaches the world through the same invoker a live dispatch '
        + 'does, so its effective surface is the granted surface and nothing more',
    };
  }
}
