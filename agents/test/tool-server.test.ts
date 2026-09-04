import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdapterToolServer,
  checkToolSchemas,
  type McpTransportLike,
} from '../src/substrate/claude-agent-sdk.js';
import type { TransportTool, TransportToolResult } from '../src/substrate/transport.js';
import { GRANTS } from './doubles.js';

/**
 * The in-process tool server, which is where the allowlist becomes an actual tool surface.
 *
 * This is the piece D-2's condition was most at risk on. The Agent SDK's own
 * `createSdkMcpServer` / `tool()` helpers take a Zod raw shape for `inputSchema`, and
 * `ToolGrant.args_schema` is JSON Schema — the source of truth for every shape in AgentOS.
 * Declaring the tools with an empty shape would have dropped the arguments entirely, so the
 * server is this file's own and the schema is handed over exactly as the adapter declared
 * it. These tests are what say that is still true.
 *
 * Nothing here loads the SDK: the server speaks JSON-RPC over a transport interface, and the
 * test supplies one.
 */

class Wire implements McpTransportLike {
  readonly sent: unknown[] = [];
  started = false;
  closed = false;
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  send(message: unknown): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const TOOLS: readonly TransportTool[] = GRANTS.map((grant) => ({
  name: grant.tool_name,
  description: grant.description,
  args_schema: grant.args_schema,
}));

interface Harness {
  readonly wire: Wire;
  readonly calls: { tool: string; args: Readonly<Record<string, unknown>> }[];
  request(method: string, params?: unknown, id?: number): Promise<unknown>;
  notify(method: string): Promise<void>;
}

async function harness(
  answer: (tool: string, args: Readonly<Record<string, unknown>>) => TransportToolResult
  = () => ({ ok: true, value: { ok: true } }),
): Promise<Harness> {
  const wire = new Wire();
  const calls: { tool: string; args: Readonly<Record<string, unknown>> }[] = [];
  const server = new AdapterToolServer(
    'agentos',
    TOOLS,
    (tool, args) => {
      calls.push({ tool, args });
      return Promise.resolve(answer(tool, args));
    },
  );
  await server.connect(wire);
  let next = 1;

  return {
    wire,
    calls,
    async request(method: string, params?: unknown, id?: number): Promise<unknown> {
      const messageId = id ?? next++;
      const before = wire.sent.length;
      wire.onmessage?.({ jsonrpc: '2.0', id: messageId, method, params });
      /* The handler is asynchronous; let its microtasks settle. */
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      return wire.sent[before];
    },
    async notify(method: string): Promise<void> {
      wire.onmessage?.({ jsonrpc: '2.0', method });
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function result(message: unknown): Record<string, unknown> {
  assert.ok(message !== null && typeof message === 'object');
  const record = message as Record<string, unknown>;
  assert.equal(record['error'], undefined, `expected a result, got ${JSON.stringify(record)}`);
  const payload = record['result'];
  assert.ok(payload !== null && typeof payload === 'object');
  return payload as Record<string, unknown>;
}

function fault(message: unknown): Record<string, unknown> {
  assert.ok(message !== null && typeof message === 'object');
  const record = message as Record<string, unknown>;
  const payload = record['error'];
  assert.ok(payload !== null && typeof payload === 'object', 'expected a JSON-RPC error');
  return payload as Record<string, unknown>;
}

describe('the in-process tool server', () => {
  test('connecting registers a handler and starts the transport', async () => {
    const h = await harness();
    assert.equal(h.wire.started, true);
    assert.equal(typeof h.wire.onmessage, 'function');
  });

  test('initialize echoes the offered protocol version and declares only tools', async () => {
    const h = await harness();
    const payload = result(await h.request('initialize', { protocolVersion: '2025-06-18' }));
    assert.equal(payload['protocolVersion'], '2025-06-18');
    assert.deepEqual(payload['capabilities'], { tools: { listChanged: false } });
    assert.deepEqual(payload['serverInfo'], { name: 'agentos', version: '0.3.0' });
  });

  test('initialize without an offer answers a version rather than nothing', async () => {
    const h = await harness();
    const payload = result(await h.request('initialize', {}));
    assert.equal(typeof payload['protocolVersion'], 'string');
  });

  test('tools/list carries the adapter\'s own JSON Schema, unaltered', async () => {
    const h = await harness();
    const payload = result(await h.request('tools/list'));
    const tools = payload['tools'];
    assert.ok(Array.isArray(tools));
    assert.deepEqual(tools.map((tool: { name: string }) => tool.name), [
      'repo__read_file',
      'repo__list_files',
    ]);
    /* The whole point of the server being ours: the schema is passed straight through. */
    assert.deepEqual(tools[0].inputSchema, GRANTS[0]?.args_schema);
    assert.equal(tools[0].description, GRANTS[0]?.description);
  });

  test('tools/list advertises nothing when nothing was granted', async () => {
    const wire = new Wire();
    const server = new AdapterToolServer('agentos', [], () => Promise.resolve({ ok: true, value: null }));
    await server.connect(wire);
    wire.onmessage?.({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(result(wire.sent[0])['tools'], []);
  });

  test('tools/call forwards the arguments verbatim and returns the value', async () => {
    const h = await harness((_tool, args) => ({ ok: true, value: { read: args['path'] } }));
    const payload = result(await h.request('tools/call', {
      name: 'repo__read_file',
      arguments: { path: 'src/a.ts' },
    }));
    assert.deepEqual(h.calls, [{ tool: 'repo__read_file', args: { path: 'src/a.ts' } }]);
    assert.equal(payload['isError'], false);
    assert.deepEqual(payload['content'], [{ type: 'text', text: '{"read":"src/a.ts"}' }]);
  });

  test('a refusal comes back as a tool error, not as a value', async () => {
    const h = await harness(() => ({ ok: false, message: 'refused (scope_violation): outside' }));
    const payload = result(await h.request('tools/call', {
      name: 'repo__read_file',
      arguments: { path: '../etc/passwd' },
    }));
    assert.equal(payload['isError'], true);
    assert.deepEqual(payload['content'], [
      { type: 'text', text: 'refused (scope_violation): outside' },
    ]);
  });

  test('a call to a tool the dispatch does not have never reaches the invoker', async () => {
    const h = await harness();
    const payload = fault(await h.request('tools/call', { name: 'Bash', arguments: { cmd: 'ls' } }));
    assert.equal(payload['code'], -32602);
    assert.match(String(payload['message']), /not one of the operations/);
    assert.deepEqual(h.calls, []);
  });

  test('a call with no tool name is refused', async () => {
    const h = await harness();
    assert.equal(fault(await h.request('tools/call', {}))['code'], -32602);
  });

  test('missing arguments become an empty object, never a guess', async () => {
    const h = await harness();
    await h.request('tools/call', { name: 'repo__list_files' });
    assert.deepEqual(h.calls, [{ tool: 'repo__list_files', args: {} }]);
  });

  test('an unimplemented method is answered as not found, never improvised', async () => {
    const h = await harness();
    for (const method of ['resources/list', 'prompts/list', 'sampling/createMessage']) {
      const payload = fault(await h.request(method));
      assert.equal(payload['code'], -32601);
    }
  });

  test('ping is answered so a health check does not look like a dead server', async () => {
    const h = await harness();
    assert.deepEqual(result(await h.request('ping')), {});
  });

  test('a notification is not answered', async () => {
    const h = await harness();
    await h.notify('notifications/initialized');
    assert.deepEqual(h.wire.sent, []);
  });

  test('a message that is not a request is ignored rather than answered', async () => {
    const h = await harness();
    h.wire.onmessage?.({ jsonrpc: '2.0', id: 9, result: {} });
    await Promise.resolve();
    assert.deepEqual(h.wire.sent, []);
  });

  test('an invoker that throws becomes an internal error, not an unhandled rejection', async () => {
    const wire = new Wire();
    const server = new AdapterToolServer('agentos', TOOLS, () => {
      throw new Error('the adapter registry is gone');
    });
    await server.connect(wire);
    wire.onmessage?.({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'repo__read_file', arguments: {} },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const payload = fault(wire.sent[0]);
    assert.equal(payload['code'], -32603);
    assert.match(String(payload['message']), /adapter registry is gone/);
  });

  test('closing the server closes the transport', async () => {
    const wire = new Wire();
    const server = new AdapterToolServer('agentos', TOOLS, () => Promise.resolve({ ok: true, value: null }));
    await server.connect(wire);
    await server.close();
    assert.equal(wire.closed, true);
  });
});

describe('a tool whose schema is not an object schema is refused, not exposed', () => {
  test('a well-formed grant passes', () => {
    assert.equal(checkToolSchemas(TOOLS), null);
  });

  test('a non-object schema is named and refused', () => {
    const problem = checkToolSchemas([
      { name: 'repo__read_file', description: 'x', args_schema: { type: 'string' } },
    ]);
    assert.match(String(problem), /repo__read_file declares an argument schema of type "string"/);
  });

  test('a schema that is not a schema at all is refused', () => {
    const problem = checkToolSchemas([
      { name: 'repo__read_file', description: 'x', args_schema: [] as unknown as Record<string, unknown> },
    ]);
    assert.match(String(problem), /not a JSON Schema object/);
  });
});
