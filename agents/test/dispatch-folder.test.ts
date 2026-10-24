import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeCodeTransport,
  WindowsFolderSecurity,
  judgeFolderAcl,
  sweepStaleSessions,
  type AclSnapshot,
  type FolderSecurity,
} from '../src/substrate/claude-agent-sdk.js';
import type { TransportEvent, TransportRequest } from '../src/substrate/transport.js';

/**
 * The dispatch folder holds the harness's configuration home, and the harness writes a
 * session key there (WP-8 Prompt 4). On Windows `mkdtemp` under `%TEMP%` inherited `%TEMP%`'s
 * ACL, which named sandbox and domain principals, and the SDK's mode 0600 is not enforced.
 *
 * So the folder is made inside a root that inherits nothing and names only the user and
 * SYSTEM, its owner and entries are read back as SIDs and checked, and the harness starts
 * only after both checks pass. Every way the check can fail is a dispatch that started no
 * session, and says so with a cost of exactly zero.
 */

const USER = 'S-1-5-21-1-2-3-1001';
const SYSTEM = 'S-1-5-18';
const FULL = 0x1f01ff;

const cleanup: string[] = [];
after(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function snapshot(overrides: Partial<AclSnapshot> = {}): AclSnapshot {
  return {
    path: 'C:\\root',
    owner: USER,
    protected: true,
    rules: [
      { sid: SYSTEM, allow: true, rights: FULL, inherited: false, inheritOnly: false },
      { sid: USER, allow: true, rights: FULL, inherited: false, inheritOnly: false },
    ],
    ...overrides,
  };
}

/* ========================================================= the judgement ==== */

describe('a dispatch folder names only the user and SYSTEM, and is owned by the user', () => {
  test('a protected root granting exactly the user and SYSTEM passes', () => {
    assert.equal(judgeFolderAcl(snapshot(), USER, true), null);
  });

  test('a root that inherits from its parent fails', () => {
    assert.match(judgeFolderAcl(snapshot({ protected: false }), USER, true) ?? '', /inherit/);
  });

  test('a root carrying an inherited entry fails', () => {
    const rules = snapshot().rules.map((r) => ({ ...r, inherited: true }));
    assert.match(judgeFolderAcl(snapshot({ rules }), USER, true) ?? '', /inherit/);
  });

  test('an entry for anyone else fails, Everyone or an unresolved domain SID alike', () => {
    for (const sid of ['S-1-1-0', 'S-1-5-21-9-9-9-1105', 'S-1-15-2-1']) {
      const rules = [...snapshot().rules, { sid, allow: true, rights: 0x1200a9, inherited: false, inheritOnly: false }];
      assert.match(judgeFolderAcl(snapshot({ rules }), USER, true) ?? '', new RegExp(sid));
    }
  });

  test('a deny entry is unexpected, even for the user', () => {
    const rules = [...snapshot().rules, { sid: USER, allow: false, rights: 0x10000, inherited: false, inheritOnly: false }];
    assert.match(judgeFolderAcl(snapshot({ rules }), USER, true) ?? '', /deny/);
  });

  test('an owner other than the user fails, Administrators included', () => {
    assert.match(judgeFolderAcl(snapshot({ owner: 'S-1-5-32-544' }), USER, true) ?? '', /owned by/);
  });

  test('a user without full control could not clean up, so it fails', () => {
    const rules = [{ sid: USER, allow: true, rights: 0x1200a9, inherited: false, inheritOnly: false }];
    assert.match(judgeFolderAcl(snapshot({ rules }), USER, true) ?? '', /full control/);
  });

  test('full control that only children inherit is not full control here', () => {
    const rules = [{ sid: USER, allow: true, rights: FULL, inherited: false, inheritOnly: true }];
    assert.match(judgeFolderAcl(snapshot({ rules }), USER, true) ?? '', /full control/);
  });

  test('a session folder may inherit from the protected root it was made in', () => {
    const rules = snapshot().rules.map((r) => ({ ...r, inherited: true }));
    assert.equal(judgeFolderAcl(snapshot({ protected: false, rules }), USER, false), null);
  });

  test('a user that is not a SID is refused', () => {
    assert.match(judgeFolderAcl(snapshot(), 'prsingh', true) ?? '', /SID/);
  });
});

/* ============================================== the transport, faults injected ==== */

const REQUEST: TransportRequest = {
  model: 'claude-opus-5',
  systemPrompt: 's',
  prompt: 'p',
  tools: [],
  maxTurns: 1,
  maxBudgetUsd: 1,
  invoke: () => Promise.resolve({ ok: false, message: 'unused' }),
};

/** A harness that never answers: enough to show it started, and with which options. */
function harnessSpy() {
  const started: Options[] = [];
  const order: string[] = [];
  return {
    started,
    order,
    startHarness: ({ options }: { readonly prompt: string; readonly options: Options }) => {
      started.push(options);
      order.push('harness');
      return {
        close: () => undefined,
        async *[Symbol.asyncIterator]() { /* ends without a result */ },
      };
    },
  };
}

/** A security double over a real folder tree, which says whatever each step is told to. */
class ScriptedSecurity implements FolderSecurity {
  readonly calls: string[] = [];
  constructor(
    private readonly faults: {
      readonly user?: () => Promise<string>;
      readonly root?: Partial<AclSnapshot>;
      readonly session?: Partial<AclSnapshot>;
      readonly own?: () => Promise<void>;
    } = {},
    private readonly order: string[] = [],
  ) {}

  currentUser(): Promise<string> {
    this.calls.push('user');
    return this.faults.user?.() ?? Promise.resolve(USER);
  }

  protect(path: string): Promise<void> {
    this.calls.push(`protect ${basename(path)}`);
    return Promise.resolve();
  }

  own(path: string): Promise<void> {
    this.calls.push(`own ${basename(path)}`);
    return this.faults.own?.() ?? Promise.resolve();
  }

  describe(paths: readonly string[]): Promise<readonly AclSnapshot[]> {
    this.calls.push(`describe ${paths.length}`);
    this.order.push(`describe ${paths.length}`);
    return Promise.resolve(paths.map((path, index) => {
      const isRoot = paths.length === 1;
      const base = snapshot({ path, protected: isRoot });
      const rules = isRoot ? base.rules : base.rules.map((r) => ({ ...r, inherited: true }));
      return { ...base, rules, ...(isRoot ? this.faults.root : index === 0 ? this.faults.session : {}) };
    }));
  }
}

async function drain(transport: ClaudeCodeTransport): Promise<readonly TransportEvent[]> {
  const session = transport.open(REQUEST);
  const events: TransportEvent[] = [];
  for await (const event of session) events.push(event);
  await session.close();
  return events;
}

function onlyResult(events: readonly TransportEvent[]): Extract<TransportEvent, { kind: 'RESULT' }> {
  assert.equal(events.length, 1);
  const [event] = events;
  assert.ok(event?.kind === 'RESULT');
  return event;
}

describe('the harness starts only inside a folder that passed its check', () => {
  test('a root that fails its check starts no harness, makes no session, and costs zero', async () => {
    const root = join(scratch('intentra-df-'), 'dispatch');
    const spy = harnessSpy();
    const transport = new ClaudeCodeTransport({
      dispatchRoot: root,
      security: new ScriptedSecurity({ root: { owner: 'S-1-5-32-544' } }),
      startHarness: spy.startHarness,
    });
    const result = onlyResult(await drain(transport));
    assert.equal(result.cost.usd, 0);
    assert.match(result.detail, /owned by/);
    assert.equal(spy.started.length, 0);
    assert.deepEqual(readdirSync(root), [], 'no session folder was made in a root that failed');
  });

  test('a session folder that fails its check is removed, and no harness starts', async () => {
    const root = join(scratch('intentra-df-'), 'dispatch');
    const spy = harnessSpy();
    const transport = new ClaudeCodeTransport({
      dispatchRoot: root,
      security: new ScriptedSecurity({ session: { rules: [...snapshot().rules, { sid: 'S-1-1-0', allow: true, rights: FULL, inherited: true, inheritOnly: false }] } }),
      startHarness: spy.startHarness,
    });
    const result = onlyResult(await drain(transport));
    assert.equal(result.cost.usd, 0);
    assert.match(result.detail, /S-1-1-0/);
    assert.equal(spy.started.length, 0);
    assert.deepEqual(readdirSync(root), [], 'the partly made session folder is gone');
  });

  test('a failure setting the owner leaves nothing behind and starts nothing', async () => {
    const root = join(scratch('intentra-df-'), 'dispatch');
    const spy = harnessSpy();
    const transport = new ClaudeCodeTransport({
      dispatchRoot: root,
      security: new ScriptedSecurity({ own: () => Promise.reject(new Error('icacls exited 5')) }),
      startHarness: spy.startHarness,
    });
    const result = onlyResult(await drain(transport));
    assert.equal(result.cost.usd, 0);
    assert.equal(spy.started.length, 0);
    assert.deepEqual(readdirSync(root), []);
  });

  test('a user that cannot be identified starts nothing', async () => {
    const root = join(scratch('intentra-df-'), 'dispatch');
    const spy = harnessSpy();
    const transport = new ClaudeCodeTransport({
      dispatchRoot: root,
      security: new ScriptedSecurity({ user: () => Promise.reject(new Error('whoami failed')) }),
      startHarness: spy.startHarness,
    });
    assert.equal(onlyResult(await drain(transport)).cost.usd, 0);
    assert.equal(spy.started.length, 0);
  });

  test('with no protected root available, nothing starts', async () => {
    const spy = harnessSpy();
    const transport = new ClaudeCodeTransport({
      dispatchRoot: null,
      security: new ScriptedSecurity(),
      startHarness: spy.startHarness,
    });
    const result = onlyResult(await drain(transport));
    assert.equal(result.cost.usd, 0);
    assert.match(result.detail, /LOCALAPPDATA/);
    assert.equal(spy.started.length, 0);
  });

  test('a passing folder is checked before the harness starts, which runs in it with TEMP and TMP inside it', async () => {
    const root = join(scratch('intentra-df-'), 'dispatch');
    const spy = harnessSpy();
    const security = new ScriptedSecurity({}, spy.order);
    const transport = new ClaudeCodeTransport({ dispatchRoot: root, security, startHarness: spy.startHarness });
    const session = transport.open(REQUEST);
    const events: TransportEvent[] = [];
    for await (const event of session) events.push(event);

    assert.equal(spy.started.length, 1);
    assert.deepEqual(spy.order, ['describe 1', 'describe 4', 'harness']);
    const options = spy.started[0];
    assert.ok(options !== undefined);
    const sandbox = dirname(options.cwd ?? '');
    assert.equal(dirname(sandbox), root);
    assert.match(basename(sandbox), new RegExp(`^d-${process.pid}-[A-Za-z0-9]{6}$`));
    assert.equal(options.env?.['CLAUDE_CONFIG_DIR'], join(sandbox, 'config'));
    assert.equal(options.env?.['TEMP'], join(sandbox, 'tmp'));
    assert.equal(options.env?.['TMP'], join(sandbox, 'tmp'));
    assert.ok(existsSync(join(sandbox, 'tmp')));
    assert.equal(events.length, 1, 'the spy ends without a result, which is reported, not hidden');
    const [only] = events;
    assert.equal(only?.kind === 'RESULT' ? only.cost.usd : 0, null, 'a started harness has an unknown cost');

    await session.close();
    assert.equal(existsSync(sandbox), false, 'and the folder goes when the session closes');
  });
});

/* ================================================== the SDK's own cost figure ==== */

describe('the SDK\'s cost figure is its estimate, and an impossible one is no figure', () => {
  function harnessAnswering(totalCostUsd: unknown) {
    return ({ options }: { readonly prompt: string; readonly options: Options }) => ({
      close: () => undefined,
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system', subtype: 'init', model: 'm', permissionMode: 'dontAsk', tools: [], agents: [],
          mcp_servers: [], slash_commands: [], skills: [], cwd: options.cwd,
        } as never;
        yield {
          type: 'result', subtype: 'success', is_error: false, result: '{}', modelUsage: {},
          total_cost_usd: totalCostUsd,
        } as never;
      },
    });
  }

  async function costReported(totalCostUsd: unknown): Promise<number | null> {
    const root = join(scratch('intentra-df-'), 'dispatch');
    const events = await drain(new ClaudeCodeTransport({
      dispatchRoot: root, security: new ScriptedSecurity(), startHarness: harnessAnswering(totalCostUsd),
    }));
    const result = events.find((e) => e.kind === 'RESULT');
    assert.ok(result?.kind === 'RESULT');
    return result.cost.usd;
  }

  test('a reported figure is carried as reported', async () => {
    assert.equal(await costReported(1.209929), 1.209929);
  });

  test('a missing, negative or non-finite figure is unknown, never zero', async () => {
    for (const figure of [undefined, -1, Number.NaN, '1.2']) {
      assert.equal(await costReported(figure), null, `for ${String(figure)}`);
    }
  });
});

/* ================================================== the sweep of stale folders ==== */

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise<void>((resolve) => { child.once('exit', () => { resolve(); }); });
  assert.ok(pid !== undefined);
  return pid;
}

describe('a startup sweep removes dead sessions, boundedly, and never a live one', () => {
  test('dead folders go, live and foreign ones stay, and the sweep stops at its limit', async () => {
    const root = scratch('intentra-sweep-');
    const dead = await deadPid();
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      const make = (name: string): string => {
        const path = join(root, name);
        mkdirSync(join(path, 'config'), { recursive: true });
        return path;
      };
      const mine = make(`d-${process.pid}-aaaaaa`);
      const alive = make(`d-${String(live.pid)}-bbbbbb`);
      const foreign = make('not-a-session');
      const stale = ['cccccc', 'dddddd', 'eeeeee'].map((suffix) => make(`d-${dead}-${suffix}`));

      const swept = await sweepStaleSessions(root, { limit: 2 });

      assert.equal(swept.removed.length, 2, 'bounded by its limit');
      assert.equal(stale.filter((path) => existsSync(path)).length, 1);
      for (const path of [mine, alive, foreign]) assert.ok(existsSync(path), `${path} was kept`);
    } finally {
      live.kill();
    }
  });

  test('the transport sweeps its checked root before its first session', async () => {
    const root = join(scratch('intentra-df-'), 'dispatch');
    const stale = join(root, `d-${await deadPid()}-ffffff`);
    mkdirSync(join(stale, 'config'), { recursive: true });
    const spy = harnessSpy();
    await drain(new ClaudeCodeTransport({ dispatchRoot: root, security: new ScriptedSecurity(), startHarness: spy.startHarness }));
    assert.equal(existsSync(stale), false);
  });

  test('a root that does not exist is nothing to sweep', async () => {
    const swept = await sweepStaleSessions(join(tmpdir(), 'intentra-sweep-absent'));
    assert.deepEqual(swept.removed, []);
  });
});

/* ========================================== real ACLs, disposable folders (Windows) ==== */

const WINDOWS = process.platform === 'win32' ? false : 'Windows ACL behaviour';

function icacls(...args: string[]): void {
  execFileSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe'), args, { stdio: 'ignore' });
}

describe('real Windows ACLs on disposable folders', { skip: WINDOWS }, () => {
  test('a fresh root is created protected, and a session runs inside it', async () => {
    const root = join(scratch('intentra-acl-'), 'dispatch');
    const spy = harnessSpy();
    const security = new WindowsFolderSecurity();
    const transport = new ClaudeCodeTransport({ dispatchRoot: root, security, startHarness: spy.startHarness });
    const session = transport.open(REQUEST);
    const events: TransportEvent[] = [];
    for await (const event of session) events.push(event);
    assert.equal(spy.started.length, 1);
    assert.equal(events.length, 1);

    const user = await security.currentUser();
    const sandbox = dirname(spy.started[0]?.cwd ?? '');
    const [rootAcl, sessionAcl] = await security.describe([root, join(sandbox, 'config')]);
    assert.ok(rootAcl !== undefined && sessionAcl !== undefined);
    assert.equal(judgeFolderAcl(rootAcl, user, true), null);
    assert.equal(judgeFolderAcl(sessionAcl, user, false), null);
    await session.close();
  });

  test('a root with an extra entry starts no harness', async () => {
    const root = join(scratch('intentra-acl-'), 'dispatch');
    const security = new WindowsFolderSecurity();
    const user = await security.currentUser();
    mkdirSync(root);
    await security.protect(root, user);
    icacls(root, '/grant', '*S-1-1-0:(R)');
    const spy = harnessSpy();
    const result = onlyResult(await drain(new ClaudeCodeTransport({ dispatchRoot: root, security, startHarness: spy.startHarness })));
    assert.equal(spy.started.length, 0);
    assert.equal(result.cost.usd, 0);
    assert.match(result.detail, /S-1-1-0/);
  });

  test('a root that inherits its parent\'s permissions starts no harness', async () => {
    const root = join(scratch('intentra-acl-'), 'dispatch');
    mkdirSync(root);
    const spy = harnessSpy();
    const result = onlyResult(await drain(new ClaudeCodeTransport({
      dispatchRoot: root, security: new WindowsFolderSecurity(), startHarness: spy.startHarness,
    })));
    assert.equal(spy.started.length, 0);
    assert.equal(result.cost.usd, 0);
  });

  test('a root owned by someone else starts no harness', async (t) => {
    const root = join(scratch('intentra-acl-'), 'dispatch');
    const security = new WindowsFolderSecurity();
    mkdirSync(root);
    await security.protect(root, await security.currentUser());
    try {
      icacls(root, '/setowner', '*S-1-5-18');
    } catch {
      t.skip('this process may not assign ownership to another principal');
      return;
    }
    const spy = harnessSpy();
    const result = onlyResult(await drain(new ClaudeCodeTransport({ dispatchRoot: root, security, startHarness: spy.startHarness })));
    assert.equal(spy.started.length, 0);
    assert.match(result.detail, /owned by S-1-5-18/);
  });
});
