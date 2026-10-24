import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx, type SubstrateResult } from '@intentra/contracts';
import { ClaudeAgentSdkSubstrate, ClaudeCodeTransport } from '../src/substrate/claude-agent-sdk.js';
import type { DispatchTransport, TransportRequest, TransportSession } from '../src/substrate/transport.js';
import { FakeTransport, GRANTS, RecordingInvoker, grant, type ScriptStep } from './doubles.js';

/**
 * What a dispatch's cost says about whether anything could have been charged (WP-8 Prompt 4).
 *
 * `usd: 0` is a claim: no session was opened, so nothing could be billed. `usd: null` is the
 * absence of a claim: a session may have run, and its cost is not known. The kernel reserves
 * the dispatch's whole `max_usd` against a `null` and releases it on a `0`, so a `0` on a path
 * where a session might have started would be an unknown cost silently recorded as free.
 */

function substrateOver(scripts: readonly (readonly ScriptStep[])[]) {
  const transport = new FakeTransport(scripts);
  return { transport, substrate: new ClaudeAgentSdkSubstrate({ transport }) };
}

function input(overrides: Parameters<typeof fx.inputPackage>[0] = {}) {
  return fx.inputPackage({ tools_granted: [...GRANTS], ...overrides });
}

function usdOf(result: SubstrateResult): number | null {
  return result.cost.usd;
}

describe('a dispatch that opened no session reports a confirmed zero', () => {
  test('no model: usd 0 and no session', async () => {
    const { substrate, transport } = substrateOver([[{ kind: 'surface' }]]);
    const result = await substrate.dispatch(input({ model: ' ' }), new RecordingInvoker());
    assert.equal(result.outcome, 'FAILED');
    assert.deepEqual(transport.opened, []);
    assert.equal(usdOf(result), 0);
  });

  test('a spawning grant: usd 0 and no session', async () => {
    const { substrate, transport } = substrateOver([[{ kind: 'surface' }]]);
    const result = await substrate.dispatch(
      input({ tools_granted: [grant({ tool_name: 'Task', op: 'task' })] }),
      new RecordingInvoker(),
    );
    assert.equal(result.outcome === 'FAILED' && result.failure, 'TOOL_SURFACE_VIOLATION');
    assert.deepEqual(transport.opened, []);
    assert.equal(usdOf(result), 0);
  });

  test('a transport that confirms it started nothing is a substrate error at usd 0', async () => {
    const { substrate } = substrateOver([[
      {
        kind: 'result',
        failure: 'ERROR',
        detail: 'the dispatch folder could not be protected',
        cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      },
    ]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(result.outcome === 'FAILED' && result.failure, 'SUBSTRATE_ERROR');
    assert.match(result.outcome === 'FAILED' ? result.detail : '', /could not be protected/);
    assert.equal(usdOf(result), 0);
  });
});

describe('the real transport confirms zero only where it never reached the SDK', () => {
  test('an argument schema that is not an object is refused at usd 0, before any SDK call', async () => {
    const session = new ClaudeCodeTransport().open({
      model: 'claude-opus-5',
      systemPrompt: 's',
      prompt: 'p',
      tools: [{ name: 'repo__read_file', description: 'x', args_schema: { type: 'string' } }],
      maxTurns: 1,
      maxBudgetUsd: 1,
      invoke: () => Promise.resolve({ ok: false, message: 'unused' }),
    });
    const events = [];
    for await (const event of session) events.push(event);
    await session.close();
    assert.equal(events.length, 1);
    const [only] = events;
    assert.equal(only?.kind, 'RESULT');
    assert.equal(only?.kind === 'RESULT' ? only.cost.usd : -1, 0);
  });
});

describe('a dispatch whose session may have run never reports zero for an unknown cost', () => {
  test('timeout: usd null', async () => {
    const { substrate } = substrateOver([[{ kind: 'surface' }, { kind: 'hang' }]]);
    const result = await substrate.dispatch(
      input({ budget: { max_usd: 5, max_turns: 40, max_wall_clock_ms: 25 } }),
      new RecordingInvoker(),
    );
    assert.equal(result.outcome === 'FAILED' && result.failure, 'TIMEOUT');
    assert.equal(usdOf(result), null);
  });

  test('security-violation abort: usd null', async () => {
    const { substrate } = substrateOver([[
      { kind: 'surface' },
      { kind: 'call', tool: 'repo__read_file', args: { path: '.env' } },
      { kind: 'hang' },
    ]]);
    const result = await substrate.dispatch(
      input(),
      new RecordingInvoker(() => ({
        outcome: 'REFUSED',
        refusal: 'security_violation',
        message: 'deny-listed',
        abortDispatch: true,
      })),
    );
    assert.equal(result.outcome === 'FAILED' && result.failure, 'SECURITY_VIOLATION');
    assert.equal(usdOf(result), null);
  });

  test('stream error mid-session: usd null', async () => {
    const { substrate } = substrateOver([[{ kind: 'surface' }, { kind: 'throw', message: 'socket hang up' }]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(result.outcome === 'FAILED' && result.failure, 'SUBSTRATE_ERROR');
    assert.equal(usdOf(result), null);
  });

  test('a session that ends with no result: usd null', async () => {
    const { substrate } = substrateOver([[{ kind: 'surface' }]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(result.outcome, 'FAILED');
    assert.equal(usdOf(result), null);
  });

  test('a tool list that fails conformance after the session opened: usd null', async () => {
    const { substrate } = substrateOver([[{ kind: 'surface', tools: ['repo__read_file', 'Bash'] }]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(result.outcome === 'FAILED' && result.failure, 'TOOL_SURFACE_VIOLATION');
    assert.equal(usdOf(result), null);
  });

  test('a session that failed before reporting a surface, with no cost claim: usd null', async () => {
    const { substrate } = substrateOver([[{ kind: 'result', failure: 'ERROR', detail: 'exited 1' }]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(result.outcome, 'FAILED');
    assert.equal(usdOf(result), null);
  });

  test('a transport whose open() throws resolves as a substrate error at usd null', async () => {
    const throwing: DispatchTransport = {
      name: 'throwing',
      qualify: (name) => name,
      open(_request: TransportRequest): TransportSession {
        throw new Error('spawn failed after the process may have started');
      },
    };
    const substrate = new ClaudeAgentSdkSubstrate({ transport: throwing });
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(result.outcome === 'FAILED' && result.failure, 'SUBSTRATE_ERROR');
    assert.equal(usdOf(result), null);
  });

  test('a reported cost is carried through unchanged', async () => {
    const { substrate } = substrateOver([[
      { kind: 'surface' },
      { kind: 'result', failure: 'BUDGET_EXCEEDED', detail: 'over', cost: { input_tokens: 9, output_tokens: 1, usd: 5.2 } },
    ]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(usdOf(result), 5.2);
  });
});
