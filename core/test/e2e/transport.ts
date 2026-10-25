import type { DispatchTransport, TransportEvent, TransportRequest, TransportSession } from '@intentra/agents';
import type { InputPackage, ToolInvocationResult } from '@intentra/contracts';
import type { ScriptedSubstrate } from '../doubles.js';

/**
 * A fake wire under the production `ClaudeAgentSdkSubstrate` (Prompt 7A).
 *
 * The scripted substrate answers, but through the shipped brief rendering, surface check and
 * final-text parser: the input package is read back from the brief the substrate rendered, tool
 * calls go through the substrate's own guard, and the envelope crosses as one JSON text.
 */
export class ScriptedTransport implements DispatchTransport {
  readonly name = 'scripted-transport';
  /** What each dispatch was told, in the order the sessions opened (Prompt 9). */
  readonly briefed: { readonly stage: string; readonly systemPrompt: string }[] = [];

  constructor(private readonly script: ScriptedSubstrate) {}

  qualify(toolName: string): string {
    return `mcp__intentra__${toolName}`;
  }

  open(request: TransportRequest): TransportSession {
    const input = JSON.parse(request.prompt.slice(request.prompt.indexOf('\n\n') + 2)) as InputPackage;
    this.briefed.push({ stage: input.stage, systemPrompt: request.systemPrompt });
    const tools = request.tools.map((tool) => this.qualify(tool.name));
    const script = this.script;

    async function* session(): AsyncGenerator<TransportEvent> {
      yield { kind: 'SURFACE', surface: { tools, agents: [], detail: 'exactly the granted tools' } };
      const answer = await script.dispatch(input, {
        invoke: async (name, args): Promise<ToolInvocationResult> => {
          const result = await request.invoke(name, args);
          return result.ok
            ? { outcome: 'OK', value: result.value, excerpt: result.excerpt }
            : { outcome: 'ERROR', message: result.message };
        },
      });
      yield {
        kind: 'RESULT',
        text: answer.outcome === 'ENVELOPE' ? JSON.stringify(answer.envelope) : '',
        failure: answer.outcome === 'ENVELOPE' ? null : 'ERROR',
        detail: answer.outcome === 'ENVELOPE' ? '' : answer.detail,
        cost: answer.cost,
        model: answer.model,
      };
    }

    const events = session();
    return {
      [Symbol.asyncIterator]: () => events,
      close: async () => { await events.return(undefined); },
    };
  }
}
