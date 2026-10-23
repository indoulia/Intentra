import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemporaryRoot } from './temporary-root.js';

/** A root with the shape the composition suite leaves behind: nested directories and files. */
function populatedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'intentra-temporary-root-'));
  mkdirSync(join(root, 'repo', '.git', 'objects'), { recursive: true });
  writeFileSync(join(root, 'repo', 'README.md'), '# subject\n', 'utf8');
  writeFileSync(join(root, 'repo', '.git', 'objects', 'blob'), 'x', 'utf8');
  return root;
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}, simulated: the root`), { code });
}

/** Records every removal and every wait, so attempt counts and delays are asserted, not timed. */
function recorder(failures: readonly (Error | null)[], fallthrough: Error | null = null) {
  const removals: string[] = [];
  const waits: number[] = [];
  return {
    removals,
    waits,
    remove: (path: string): void => {
      const failure = removals.length < failures.length ? failures[removals.length] : fallthrough;
      removals.push(path);
      if (failure) throw failure;
      rmSync(path, { recursive: true, force: true });
    },
    sleep: async (ms: number): Promise<void> => { waits.push(ms); },
  };
}

describe('removeTemporaryRoot', () => {
  test('an unlocked root is removed on the first attempt, with no wait', async () => {
    const root = populatedRoot();
    const r = recorder([]);
    await removeTemporaryRoot(root, { remove: r.remove, sleep: r.sleep });
    assert.equal(existsSync(root), false);
    assert.deepEqual(r.removals, [root]);
    assert.deepEqual(r.waits, []);
  });

  test('the default removal deletes a real tree', async () => {
    const root = populatedRoot();
    await removeTemporaryRoot(root);
    assert.equal(existsSync(root), false);
  });

  test('a transient EPERM is retried after a bounded wait until the root is gone', async () => {
    const root = populatedRoot();
    const r = recorder([errno('EPERM'), errno('EPERM')]);
    await removeTemporaryRoot(root, { attempts: 5, delayMs: 100, remove: r.remove, sleep: r.sleep });
    assert.equal(existsSync(root), false);
    assert.equal(r.removals.length, 3);
    assert.deepEqual(r.waits, [100, 100]);
  });

  test('a persistent EPERM fails after exactly the bounded attempts, keeping the original error', async () => {
    const root = populatedRoot();
    const last = errno('EPERM');
    const r = recorder([], last);
    try {
      await assert.rejects(
        removeTemporaryRoot(root, { attempts: 4, delayMs: 50, remove: r.remove, sleep: r.sleep }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.cause, last, 'the original error is carried, not replaced');
          assert.equal((error as NodeJS.ErrnoException).code, 'EPERM');
          assert.match(error.message, /could not be removed after 4 attempts/);
          assert.ok(error.message.includes(root), 'the message names the root');
          assert.ok(error.message.includes(last.message), 'the message keeps the original text');
          return true;
        },
      );
      assert.equal(r.removals.length, 4);
      assert.deepEqual(r.waits, [50, 50, 50]);
      assert.equal(existsSync(root), true, 'nothing pretends the locked root is gone');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the default bound is 20 attempts and under two seconds of waiting', async () => {
    const root = populatedRoot();
    const r = recorder([], errno('EPERM'));
    try {
      await assert.rejects(removeTemporaryRoot(root, { remove: r.remove, sleep: r.sleep }), /after 20 attempts/);
      assert.equal(r.removals.length, 20);
      assert.ok(r.waits.reduce((a, b) => a + b, 0) < 2_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const code of ['EBUSY', 'EACCES', 'ENOTEMPTY']) {
    test(`${code} is not retried: the error itself is thrown on the first attempt`, async () => {
      const root = populatedRoot();
      const failure = errno(code);
      const r = recorder([failure]);
      try {
        await assert.rejects(removeTemporaryRoot(root, { remove: r.remove, sleep: r.sleep }), (error) => error === failure);
        assert.equal(r.removals.length, 1);
        assert.deepEqual(r.waits, []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('an error without a code is thrown as is', async () => {
    const root = populatedRoot();
    const failure = new Error('not a filesystem error');
    const r = recorder([failure]);
    try {
      await assert.rejects(removeTemporaryRoot(root, { remove: r.remove, sleep: r.sleep }), (error) => error === failure);
      assert.equal(r.removals.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a removal that reports success but leaves the root behind fails', async () => {
    const root = populatedRoot();
    try {
      await assert.rejects(
        removeTemporaryRoot(root, { remove: () => undefined, sleep: async () => undefined }),
        /still exists after its removal reported success/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
