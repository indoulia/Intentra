import { existsSync, rmSync } from 'node:fs';

export interface RemovalOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly remove?: (path: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Remove a test's temporary root, retrying only EPERM, and only a bounded number of times.
 *
 * On Windows another process holding a file in the tree (WP-8 verify `7d3920f` run 1) fails
 * `rmSync` with EPERM, which its own `maxRetries` does not retry; the lock lifts on its own.
 */
export async function removeTemporaryRoot(root: string, options: RemovalOptions = {}): Promise<void> {
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 100;
  const remove = options.remove ?? ((path: string) => { rmSync(path, { recursive: true, force: true }); });
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  for (let attempt = 1; ; attempt += 1) {
    try {
      remove(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      if (attempt >= attempts) {
        throw Object.assign(
          new Error(`${root} could not be removed after ${String(attempts)} attempts: ${(error as Error).message}`, { cause: error }),
          { code: 'EPERM' },
        );
      }
      await sleep(delayMs);
      continue;
    }
    if (existsSync(root)) throw new Error(`${root} still exists after its removal reported success`);
    return;
  }
}
