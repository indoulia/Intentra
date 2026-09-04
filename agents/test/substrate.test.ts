import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx, type SubstrateResult } from '@agentos/contracts';
import {
  ClaudeAgentSdkSubstrate,
  ClaudeCodeTransport,
  permitTool,
} from '../src/substrate/claude-agent-sdk.js';
import { FakeTransport, GRANTS, RecordingInvoker, grant, type ScriptStep } from './doubles.js';

/**
 * The substrate, tested adversarially.
 *
 * ARCHITECTURE_FREEZE D-2 is a *subtraction* problem and subtraction fails open, so the tests
 * that matter are the ones that prove a failure is refused rather than the one that proves a
 * success is accepted. Every case below is a way the boundary could quietly widen: a tool
 * that was not granted, a subagent that was, a surface nobody could see, an envelope that
 * almost parses, a claim the substrate could helpfully tidy away.
 *
 * None of them needs a model, an API key or a network. The transport is injected, which is
 * the same seam D-2's reversal clause exists for: if the substrate is ever swapped, these
 * tests are the specification the replacement has to meet.
 */

const ENVELOPE_TEXT = JSON.stringify({
  envelope_version: '1.2',
  status: 'COMPLETE',
  summary: 'a well-formed answer',
});

function substrateOver(scripts: readonly (readonly ScriptStep[])[], qualify?: (n: string) => string) {
  const transport = new FakeTransport(scripts, qualify === undefined ? {} : { qualify });
  return { transport, substrate: new ClaudeAgentSdkSubstrate({ transport }) };
}

function input(overrides: Parameters<typeof fx.inputPackage>[0] = {}) {
  return fx.inputPackage({ tools_granted: [...GRANTS], ...overrides });
}

function failureOf(result: SubstrateResult): string {
  assert.equal(result.outcome, 'FAILED', `expected a failure, got ${result.outcome}`);
  return result.outcome === 'FAILED' ? result.failure : '';
}

/* ------------------------------------------------------- the startup conformance check -- */

describe('conformance: the effective surface is observed, not assumed', () => {
  test('conforms when the effective tool list equals the grants', async () => {
    const { substrate } = substrateOver([[{ kind: 'surface' }]]);
    const report = await substrate.conformance(GRANTS);
    assert.equal(report.verdict, 'CONFORMS');
    assert.deepEqual([...report.expected], ['repo__list_files', 'repo__read_file']);
    assert.deepEqual([...report.effective], ['repo__list_files', 'repo__read_file']);
    assert.deepEqual([...report.unexpected], []);
    assert.deepEqual([...report.missing], []);
  });

  test('an unexpected tool in the effective list is UNEXPECTED_TOOLS', async () => {
    const { substrate } = substrateOver([
      [{ kind: 'surface', tools: ['repo__read_file', 'repo__list_files', 'Bash'] }],
    ]);
    const report = await substrate.conformance(GRANTS);
    assert.equal(report.verdict, 'UNEXPECTED_TOOLS');
    assert.deepEqual([...report.unexpected], ['Bash']);
    /* Verbatim. A name nothing accounts for is never normalized into something familiar. */
    assert.ok(report.effective.includes('Bash'));
  });

  test('a granted tool absent from the effective list is MISSING_TOOLS', async () => {
    const { substrate } = substrateOver([[{ kind: 'surface', tools: ['repo__read_file'] }]]);
    const report = await substrate.conformance(GRANTS);
    assert.equal(report.verdict, 'MISSING_TOOLS');
    assert.deepEqual([...report.missing], ['repo__list_files']);
    assert.deepEqual([...report.unexpected], []);
  });

  test('unexpected outranks missing when the surface is wrong in both directions', async () => {
    const { substrate } = substrateOver([[{ kind: 'surface', tools: ['WebFetch'] }]]);
    const report = await substrate.conformance(GRANTS);
    assert.equal(report.verdict, 'UNEXPECTED_TOOLS');
    assert.deepEqual([...report.missing], ['repo__list_files', 'repo__read_file']);
  });

  test('a surface that cannot be observed is UNVERIFIABLE, and says why', async () => {
    const { substrate } = substrateOver([[{ kind: 'result', failure: 'ERROR', detail: 'boom' }]]);
    const report = await substrate.conformance(GRANTS);
    assert.equal(report.verdict, 'UNVERIFIABLE');
    assert.match(report.detail, /not permission to dispatch/);
    assert.match(report.detail, /boom/);
  });

  test('a transport that throws is UNVERIFIABLE rather than an exception', async () => {
    const { substrate } = substrateOver([[{ kind: 'throw', message: 'no executable' }]]);
    const report = await substrate.conformance(GRANTS);
    assert.equal(report.verdict, 'UNVERIFIABLE');
    assert.match(report.detail, /no executable/);
  });

  test('any advertised subagent is refused, whether or not one was ever invoked', async () => {
    const { substrate } = substrateOver([[{ kind: 'surface', agents: ['general-purpose'] }]]);
    const report = await substrate.conformance(GRANTS);
    assert.equal(report.verdict, 'UNEXPECTED_TOOLS');
    assert.deepEqual([...report.unexpected], ['agent:general-purpose']);
  });

  test('a spawning tool on the surface is refused even under a granted-looking name', async () => {
    const { substrate } = substrateOver([
      [{ kind: 'surface', tools: ['repo__read_file', 'repo__list_files', 'Task'] }],
    ]);
    const report = await substrate.conformance(GRANTS);
    assert.equal(report.verdict, 'UNEXPECTED_TOOLS');
    assert.ok(report.unexpected.includes('Task'));
  });

  test('the Orchestrator surface is empty, and an empty surface is checked as strictly', async () => {
    const conforming = substrateOver([[{ kind: 'surface', tools: [] }]]);
    const empty = await conforming.substrate.conformance([]);
    assert.equal(empty.verdict, 'CONFORMS');
    assert.deepEqual([...empty.expected], []);

    const widened = substrateOver([[{ kind: 'surface', tools: ['Read'] }]]);
    const report = await widened.substrate.conformance([]);
    assert.equal(report.verdict, 'UNEXPECTED_TOOLS');
    assert.deepEqual([...report.unexpected], ['Read']);
  });

  test('names are compared in the substrate\'s own namespace', async () => {
    const qualify = (name: string) => `mcp__agentos__${name}`;
    const { substrate } = substrateOver([
      [{ kind: 'surface', tools: ['mcp__agentos__repo__read_file', 'mcp__agentos__repo__list_files'] }],
    ], qualify);
    const report = await substrate.conformance(GRANTS);
    assert.equal(report.verdict, 'CONFORMS');
    /* Reported in grant space, so the kernel compares against what it granted. */
    assert.deepEqual([...report.effective], ['repo__list_files', 'repo__read_file']);
  });

  test('an unqualified name is not silently accepted as its qualified twin', async () => {
    const qualify = (name: string) => `mcp__agentos__${name}`;
    const { substrate } = substrateOver([
      [{ kind: 'surface', tools: ['repo__read_file', 'repo__list_files'] }],
    ], qualify);
    const report = await substrate.conformance(GRANTS);
    assert.equal(report.verdict, 'UNEXPECTED_TOOLS');
  });

  test('the real transport exposes granted operations under one predictable name', () => {
    const transport = new ClaudeCodeTransport();
    assert.equal(transport.qualify('repo__read_file'), 'mcp__agentos__repo__read_file');
    assert.equal(transport.name, 'claude-agent-sdk');
  });
});

/* -------------------------------------------------- the surface gates the whole dispatch -- */

describe('dispatch refuses before it reaches anything', () => {
  test('an unexpected tool fails the dispatch and no tool ever runs', async () => {
    const invoker = new RecordingInvoker();
    const { substrate, transport } = substrateOver([[
      { kind: 'surface', tools: ['repo__read_file', 'repo__list_files', 'Bash'] },
      { kind: 'call', tool: 'repo__read_file' },
      { kind: 'result', text: ENVELOPE_TEXT },
    ]]);
    const result = await substrate.dispatch(input(), invoker);
    assert.equal(failureOf(result), 'TOOL_SURFACE_VIOLATION');
    assert.equal(result.outcome === 'FAILED' && result.toolSurface?.verdict, 'UNEXPECTED_TOOLS');
    assert.deepEqual(invoker.calls, []);
    assert.equal(transport.sessions[0]?.closed, true);
  });

  test('a missing granted tool fails the dispatch', async () => {
    const invoker = new RecordingInvoker();
    const { substrate } = substrateOver([[
      { kind: 'surface', tools: ['repo__read_file'] },
      { kind: 'result', text: ENVELOPE_TEXT },
    ]]);
    const result = await substrate.dispatch(input(), invoker);
    assert.equal(failureOf(result), 'TOOL_SURFACE_VIOLATION');
    assert.equal(result.outcome === 'FAILED' && result.toolSurface?.verdict, 'MISSING_TOOLS');
  });

  test('an unobservable surface is refused, not proceeded past', async () => {
    const invoker = new RecordingInvoker();
    const { substrate } = substrateOver([[
      /* No surface at all: straight to a tool call and a perfectly good envelope. */
      { kind: 'call', tool: 'repo__read_file', args: { path: 'src/a.ts' } },
      { kind: 'result', text: ENVELOPE_TEXT },
    ]]);
    const result = await substrate.dispatch(input(), invoker);
    assert.equal(failureOf(result), 'TOOL_SURFACE_VIOLATION');
    assert.equal(result.outcome === 'FAILED' && result.toolSurface?.verdict, 'UNVERIFIABLE');
    /* The call was refused before the invoker saw it: an unasserted surface reaches nothing. */
    assert.deepEqual(invoker.calls, []);
  });

  test('advertised subagents fail the dispatch', async () => {
    const { substrate } = substrateOver([[
      { kind: 'surface', agents: ['explorer'] },
      { kind: 'result', text: ENVELOPE_TEXT },
    ]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(failureOf(result), 'TOOL_SURFACE_VIOLATION');
    assert.ok(result.outcome === 'FAILED' && result.toolSurface?.unexpected.includes('agent:explorer'));
  });

  test('a grant that names a way to spawn an agent is refused before a session exists', async () => {
    const { substrate, transport } = substrateOver([[{ kind: 'surface' }]]);
    const result = await substrate.dispatch(
      input({ tools_granted: [grant({ adapter: 'host', op: 'spawn_agent', tool_name: 'host__spawn_agent' })] }),
      new RecordingInvoker(),
    );
    assert.equal(failureOf(result), 'TOOL_SURFACE_VIOLATION');
    assert.deepEqual(transport.opened, []);
  });
});

/* ---------------------------------------------------------------- the adapter-only reach -- */

describe('the only reach is the injected invoker', () => {
  test('a granted call is forwarded verbatim and its value returned', async () => {
    const invoker = new RecordingInvoker(() => ({ outcome: 'OK', value: { lines: 3 } }));
    const { substrate, transport } = substrateOver([[
      { kind: 'surface' },
      { kind: 'call', tool: 'repo__read_file', args: { path: 'src/a.ts' } },
      { kind: 'result', text: ENVELOPE_TEXT },
    ]]);
    const result = await substrate.dispatch(input(), invoker);
    assert.equal(result.outcome, 'ENVELOPE');
    assert.deepEqual(invoker.calls, [{ tool: 'repo__read_file', args: { path: 'src/a.ts' } }]);
    assert.equal(transport.sessions[0]?.calls[0]?.result.ok, true);
  });

  test('a tool the dispatch was not granted is refused and never reaches an adapter', async () => {
    const invoker = new RecordingInvoker();
    const { substrate, transport } = substrateOver([[
      { kind: 'surface' },
      { kind: 'call', tool: 'repo__write_file', args: { path: 'src/a.ts', body: 'x' } },
      { kind: 'result', text: ENVELOPE_TEXT },
    ]]);
    const result = await substrate.dispatch(input(), invoker);
    assert.equal(result.outcome, 'ENVELOPE');
    assert.deepEqual(invoker.calls, []);
    assert.match(transport.sessions[0]?.calls[0]?.result.detail ?? '', /allowlist/);
  });

  test('canUseTool denies the same name independently of the allowlist', () => {
    const allowed = ['mcp__agentos__repo__read_file'];
    assert.deepEqual(permitTool(allowed, 'mcp__agentos__repo__read_file'), { behavior: 'allow' });
    const denied = permitTool(allowed, 'Bash');
    assert.equal(denied.behavior, 'deny');
    assert.equal(denied.behavior === 'deny' && denied.interrupt, true);
    assert.equal(permitTool(allowed, 'Task').behavior, 'deny');
    assert.equal(permitTool(allowed, 'mcp__agentos__repo__write_file').behavior, 'deny');
  });

  test('an attempt to write kernel state, spawn or self-authorize is refused by name', async () => {
    const invoker = new RecordingInvoker();
    const attempts = ['state__write_run', 'host__spawn_agent', 'auth__grant', 'agents__dispatch'];
    const { substrate, transport } = substrateOver([[
      { kind: 'surface' },
      ...attempts.map((tool): ScriptStep => ({ kind: 'call', tool })),
      { kind: 'result', text: ENVELOPE_TEXT },
    ]]);
    await substrate.dispatch(input(), invoker);
    assert.deepEqual(invoker.calls, []);
    assert.equal(transport.sessions[0]?.calls.length, attempts.length);
    for (const call of transport.sessions[0]?.calls ?? []) {
      assert.equal(call.result.ok, false);
    }
  });

  test('a refusal carrying abortDispatch aborts with SECURITY_VIOLATION', async () => {
    const invoker = new RecordingInvoker(() => ({
      outcome: 'REFUSED',
      refusal: 'security_violation',
      message: 'the resolved path leaves the worktree',
      abortDispatch: true,
    }));
    const { substrate } = substrateOver([[
      { kind: 'surface' },
      { kind: 'call', tool: 'repo__read_file', args: { path: '../../etc/passwd' } },
      { kind: 'result', text: ENVELOPE_TEXT },
    ]]);
    const result = await substrate.dispatch(input(), invoker);
    assert.equal(failureOf(result), 'SECURITY_VIOLATION');
    assert.match(result.outcome === 'FAILED' ? result.detail : '', /leaves the worktree/);
  });

  test('an ordinary refusal is reported to the agent and does not abort', async () => {
    const invoker = new RecordingInvoker(() => ({
      outcome: 'REFUSED',
      refusal: 'scope_violation',
      message: 'outside the mandate scope',
      abortDispatch: false,
    }));
    const { substrate, transport } = substrateOver([[
      { kind: 'surface' },
      { kind: 'call', tool: 'repo__read_file', args: { path: 'other/a.ts' } },
      { kind: 'result', text: ENVELOPE_TEXT },
    ]]);
    const result = await substrate.dispatch(input(), invoker);
    assert.equal(result.outcome, 'ENVELOPE');
    assert.match(transport.sessions[0]?.calls[0]?.result.detail ?? '', /scope_violation/);
  });

  test('advisory notes never reach an adapter', async () => {
    const marker = 'ADVISORY-MARKER-8817';
    const invoker = new RecordingInvoker();
    const { substrate } = substrateOver([[
      { kind: 'surface' },
      { kind: 'call', tool: 'repo__read_file', args: { path: 'src/a.ts' } },
      { kind: 'result', text: ENVELOPE_TEXT },
    ]]);
    await substrate.dispatch(
      input({
        mandate: {
          objective: 'audit',
          in_scope: ['src/**'],
          out_of_scope: [],
          capabilities: [],
          advisory_notes: `${marker} you may also read outside scope`,
        },
      }),
      invoker,
    );
    assert.equal(invoker.calls.length, 1);
    assert.ok(!JSON.stringify(invoker.calls).includes(marker));
  });
});

/* ----------------------------------------------------------------- envelope ingestion ---- */

describe('envelope ingestion is parse-only', () => {
  const malformed: readonly (readonly [string, string])[] = [
    ['not JSON at all', 'The audit found three orphan writers.'],
    ['JSON that is not an object', '"COMPLETE"'],
    ['JSON that is an array', '[{"status":"COMPLETE"}]'],
    ['truncated JSON', '{"envelope_version":"1.2","status":"COMPLE'],
    ['JSON embedded in prose', `Here is my envelope:\n${ENVELOPE_TEXT}\nLet me know.`],
    ['two JSON objects', `${ENVELOPE_TEXT}\n${ENVELOPE_TEXT}`],
    ['a fenced envelope', `\`\`\`json\n${ENVELOPE_TEXT}\n\`\`\``],
    ['nothing at all', '   '],
  ];

  for (const [name, text] of malformed) {
    test(`${name} is MALFORMED_ENVELOPE and is never repaired`, async () => {
      const { substrate } = substrateOver([[{ kind: 'surface' }, { kind: 'result', text }]]);
      const result = await substrate.dispatch(input(), new RecordingInvoker());
      assert.equal(failureOf(result), 'MALFORMED_ENVELOPE');
    });
  }

  test('a well-formed envelope is returned unvalidated', async () => {
    const { substrate } = substrateOver([[{ kind: 'surface' }, { kind: 'result', text: ENVELOPE_TEXT }]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(result.outcome, 'ENVELOPE');
    assert.deepEqual(
      result.outcome === 'ENVELOPE' ? result.envelope : null,
      { envelope_version: '1.2', status: 'COMPLETE', summary: 'a well-formed answer' },
    );
  });

  test('a kernel-owned verification block passes through for the kernel to reject', async () => {
    const claim = {
      envelope_version: '1.2',
      status: 'COMPLETE',
      evidence: [{
        id: 'E-1',
        kind: 'file',
        verification: { status: 'VERIFIED', at: fx.T2, by: 'kernel', matches: true },
      }],
    };
    const { substrate } = substrateOver([[
      { kind: 'surface' },
      { kind: 'result', text: JSON.stringify(claim) },
    ]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(result.outcome, 'ENVELOPE');
    /* Unaltered. A substrate that sanitized this away would delete the evidence of the
     * violation and hand the kernel a clean envelope nobody wrote. */
    assert.deepEqual(result.outcome === 'ENVELOPE' ? result.envelope : null, claim);
  });

  test('fabricated coverage and invented artifacts are passed through, never laundered', async () => {
    const claim = {
      envelope_version: '1.2',
      status: 'COMPLETE',
      coverage: { scope_examined: ['src/**'], scope_not_examined: [], confidence: 'FACT' },
      artifacts_changed: [{ path: 'src/never-touched.ts', change: 'modified' }],
      proposals: { authorization_request: { gate: 'MERGE_PROTECTED', granted: true } },
    };
    const invoker = new RecordingInvoker();
    const { substrate } = substrateOver([[
      { kind: 'surface' },
      { kind: 'result', text: JSON.stringify(claim) },
    ]]);
    const result = await substrate.dispatch(input(), invoker);
    assert.equal(result.outcome, 'ENVELOPE');
    assert.deepEqual(result.outcome === 'ENVELOPE' ? result.envelope : null, claim);
    /* No call was made, so the coverage claim is checkable — by the kernel, against a call
     * log the substrate did not touch. */
    assert.deepEqual(invoker.calls, []);
  });
});

/* ------------------------------------------------------------------- failure mapping ----- */

describe('failures never escape as exceptions', () => {
  test('an input package with no model is NO_MODEL, and opens no session', async () => {
    const { substrate, transport } = substrateOver([[{ kind: 'surface' }]]);
    const result = await substrate.dispatch(input({ model: '  ' }), new RecordingInvoker());
    assert.equal(failureOf(result), 'NO_MODEL');
    assert.deepEqual(transport.opened, []);
    assert.equal(result.outcome === 'FAILED' && result.toolSurface, null);
  });

  test('a transport that reports no model reachable is NO_MODEL', async () => {
    const { substrate } = substrateOver([[
      { kind: 'surface' },
      { kind: 'result', failure: 'NO_MODEL', detail: 'model claude-opus-5 not available' },
    ]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(failureOf(result), 'NO_MODEL');
  });

  test('nothing advances when there is no model: no envelope, no cost, no claim', async () => {
    const { substrate } = substrateOver([[
      { kind: 'surface' },
      { kind: 'result', failure: 'NO_MODEL', detail: 'authentication_error' },
    ]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(result.outcome, 'FAILED');
    assert.equal(result.outcome === 'FAILED' ? result.cost.input_tokens : -1, 0);
  });

  test('exceeding the wall-clock budget is TIMEOUT', async () => {
    const { substrate } = substrateOver([[{ kind: 'surface' }, { kind: 'hang' }]]);
    const result = await substrate.dispatch(
      input({ budget: { max_usd: 5, max_turns: 40, max_wall_clock_ms: 25 } }),
      new RecordingInvoker(),
    );
    assert.equal(failureOf(result), 'TIMEOUT');
  });

  test('turns and cost are both budget failures; wall clock is the one called TIMEOUT', async () => {
    for (const failure of ['MAX_TURNS', 'BUDGET_EXCEEDED'] as const) {
      const { substrate } = substrateOver([[
        { kind: 'surface' },
        { kind: 'result', failure, detail: 'over' },
      ]]);
      const result = await substrate.dispatch(input(), new RecordingInvoker());
      assert.equal(failureOf(result), 'BUDGET_EXCEEDED');
    }
  });

  test('an unclassified transport error is SUBSTRATE_ERROR', async () => {
    const { substrate } = substrateOver([[
      { kind: 'surface' },
      { kind: 'result', failure: 'ERROR', detail: 'the process exited with code 1' },
    ]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(failureOf(result), 'SUBSTRATE_ERROR');
  });

  test('a transport that throws mid-session is SUBSTRATE_ERROR, not a rejected promise', async () => {
    const { substrate } = substrateOver([[
      { kind: 'surface' },
      { kind: 'throw', message: 'socket hang up' },
    ]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(failureOf(result), 'SUBSTRATE_ERROR');
    assert.match(result.outcome === 'FAILED' ? result.detail : '', /socket hang up/);
  });

  test('a session that ends without a result is SUBSTRATE_ERROR, not a silent success', async () => {
    const { substrate } = substrateOver([[{ kind: 'surface' }]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(failureOf(result), 'SUBSTRATE_ERROR');
  });

  test('cost is carried out of the transport onto the result', async () => {
    const { substrate } = substrateOver([[
      { kind: 'surface' },
      {
        kind: 'result',
        text: ENVELOPE_TEXT,
        cost: { input_tokens: 412_000, output_tokens: 19_000, usd: 12.5 },
        model: 'claude-opus-5',
      },
    ]]);
    const result = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(result.outcome, 'ENVELOPE');
    if (result.outcome !== 'ENVELOPE') return;
    assert.deepEqual(result.cost, { input_tokens: 412_000, output_tokens: 19_000, usd: 12.5 });
    assert.equal(result.model, 'claude-opus-5');
  });
});

/* --------------------------------------------------------------- one session per dispatch -- */

describe('session isolation', () => {
  test('two dispatches open two sessions and share nothing', async () => {
    const { substrate, transport } = substrateOver([
      [{ kind: 'surface' }, { kind: 'result', text: ENVELOPE_TEXT }],
      [{ kind: 'surface' }, { kind: 'result', text: ENVELOPE_TEXT }],
    ]);
    await substrate.dispatch(input({ dispatch_id: 'd_001' }), new RecordingInvoker());
    await substrate.dispatch(input({ dispatch_id: 'd_002' }), new RecordingInvoker());

    assert.equal(transport.opened.length, 2);
    assert.notEqual(transport.sessions[0], transport.sessions[1]);
    for (const session of transport.sessions) assert.equal(session.closed, true);

    const first = transport.opened[0];
    const second = transport.opened[1];
    assert.ok(first !== undefined && second !== undefined);
    /* The second dispatch's brief carries its own dispatch id and no trace of the first. */
    assert.ok(second.prompt.includes('d_002'));
    assert.ok(!second.prompt.includes('d_001'));
  });

  test('a security violation in one dispatch does not leak into the next', async () => {
    const abort = new RecordingInvoker(() => ({
      outcome: 'REFUSED',
      refusal: 'security_violation',
      message: 'denied path',
      abortDispatch: true,
    }));
    const { substrate } = substrateOver([
      [{ kind: 'surface' }, { kind: 'call', tool: 'repo__read_file' }, { kind: 'result', text: ENVELOPE_TEXT }],
      [{ kind: 'surface' }, { kind: 'call', tool: 'repo__read_file' }, { kind: 'result', text: ENVELOPE_TEXT }],
    ]);
    const first = await substrate.dispatch(input(), abort);
    assert.equal(failureOf(first), 'SECURITY_VIOLATION');
    const second = await substrate.dispatch(input(), new RecordingInvoker());
    assert.equal(second.outcome, 'ENVELOPE');
  });

  test('no transcript crosses the boundary in either direction', async () => {
    const { substrate, transport } = substrateOver([[
      { kind: 'surface' },
      { kind: 'result', text: ENVELOPE_TEXT },
    ]]);
    await substrate.dispatch(
      input({ prior_envelopes: ['env_002', 'env_007'] }),
      new RecordingInvoker(),
    );
    const opened = transport.opened[0];
    assert.ok(opened !== undefined);
    /* References, not text. The ids appear; nothing a previous agent said does. */
    assert.ok(opened.prompt.includes('env_002'));
    assert.ok(!opened.prompt.includes('a well-formed answer'));
    /* And the request has nowhere at all to put a session to resume. */
    assert.deepEqual(
      Object.keys(opened).sort(),
      ['invoke', 'maxBudgetUsd', 'maxTurns', 'model', 'prompt', 'systemPrompt', 'tools'],
    );
  });

  test('only the granted operations are advertised to the transport', async () => {
    const { substrate, transport } = substrateOver([[
      { kind: 'surface' },
      { kind: 'result', text: ENVELOPE_TEXT },
    ]]);
    await substrate.dispatch(input(), new RecordingInvoker());
    assert.deepEqual(
      transport.opened[0]?.tools.map((tool) => tool.name),
      ['repo__read_file', 'repo__list_files'],
    );
    /* The adapter's own JSON Schema, passed through rather than re-expressed. */
    assert.deepEqual(transport.opened[0]?.tools[0]?.args_schema, GRANTS[0]?.args_schema);
  });

  test('the Orchestrator dispatch advertises no tool at all', async () => {
    const { substrate, transport } = substrateOver([[
      { kind: 'surface', tools: [] },
      { kind: 'result', text: ENVELOPE_TEXT },
    ]]);
    const result = await substrate.dispatch(
      input({ agent: 'orchestrator', mandate_name: 'orchestration', tools_granted: [] }),
      new RecordingInvoker(),
    );
    assert.equal(result.outcome, 'ENVELOPE');
    assert.deepEqual(transport.opened[0]?.tools, []);
    assert.deepEqual([...(result.toolSurface?.expected ?? ['not empty'])], []);
  });
});
