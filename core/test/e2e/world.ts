import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

/**
 * A scratch world: a real git repository and a real state root, both under the OS temp
 * directory and both thrown away afterwards.
 *
 * A real repository rather than a fixture, because every scenario in this suite has to be
 * able to say *nothing was mutated* and mean it about a filesystem. A double that recorded
 * "no write was requested" would be asserting on the double.
 */

export interface ScratchWorld {
  /** The repository the run works against. Path confinement is anchored here. */
  readonly repositoryPath: string;
  /** Where durable run state is written. `agentos status` and `agentos narrate` read it. */
  readonly stateRoot: string;
  /** The worktree content hash and the git ref state, as of now. */
  fingerprint(): WorldFingerprint;
  destroy(): void;
}

export interface WorldFingerprint {
  /** sha256 over every worktree path and its bytes, `.git` excluded. */
  readonly tree: string;
  /** `git rev-parse HEAD`, so a commit, reset or checkout could not hide inside the hash. */
  readonly head: string;
  /** `git status --porcelain`, so a staged or untracked change could not hide either. */
  readonly status: string;
  /** Every ref and its target, so a branch or tag created or moved is visible. */
  readonly refs: string;
}

/**
 * Why `.git` is not in the byte hash, and what covers it instead.
 *
 * The git adapter shells out to `git`, and several read-only git commands legitimately touch
 * `.git/index` — refreshing stat information is not a mutation of authoritative state, and a
 * byte hash over `.git` would make every scenario fail for a reason that has nothing to do
 * with what the scenario is about. The three git observations in the fingerprint cover the
 * mutations that would matter: `HEAD` catches a commit, reset or checkout, `status --porcelain`
 * catches a staged or untracked working-tree change, and the ref listing catches a branch or
 * tag being created or moved. A mutation that changes none of those and no worktree byte is
 * not a mutation of authoritative state.
 */
const GIT_EXCLUDED = '.git';

export interface WorldFile {
  readonly path: string;
  readonly content: string;
}

export function scratchWorld(files: readonly WorldFile[]): ScratchWorld {
  const root = mkdtempSync(join(tmpdir(), 'agentos-e2e-'));
  const repositoryPath = join(root, 'repo');
  const stateRoot = join(root, 'state');
  mkdirSync(repositoryPath, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });

  for (const file of files) {
    const full = join(repositoryPath, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content, 'utf8');
  }

  git(repositoryPath, ['init', '--quiet', '--initial-branch', 'main']);
  git(repositoryPath, ['config', 'user.email', 'e2e@agentos.test']);
  git(repositoryPath, ['config', 'user.name', 'AgentOS end-to-end suite']);
  git(repositoryPath, ['config', 'commit.gpgsign', 'false']);
  git(repositoryPath, ['add', '--all']);
  git(repositoryPath, ['commit', '--quiet', '--message', 'the repository as the scenario finds it']);

  return {
    repositoryPath,
    stateRoot,
    fingerprint: () => ({
      tree: hashTree(repositoryPath),
      head: git(repositoryPath, ['rev-parse', 'HEAD']),
      status: git(repositoryPath, ['status', '--porcelain']),
      refs: git(repositoryPath, ['show-ref', '--head']),
    }),
    destroy: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Runs git in the scratch repository, with the ambient configuration kept out of it. */
export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(cwd, '.git', 'nonexistent-global-config'),
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

/** sha256 over `<relative path>\0<bytes>` for every worktree file, in sorted path order. */
export function hashTree(root: string): string {
  const hash = createHash('sha256');
  for (const path of walk(root)) {
    hash.update(relative(root, path).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function walk(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === GIT_EXCLUDED) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** The two fingerprints, compared field by field so a failure names what moved. */
export function assertUnchanged(
  before: WorldFingerprint,
  after: WorldFingerprint,
  assertEqual: (actual: string, expected: string, message: string) => void,
): void {
  assertEqual(
    after.tree,
    before.tree,
    'the worktree is byte-identical: this build mutates nothing and the repository is the proof',
  );
  assertEqual(after.head, before.head, 'HEAD did not move: no commit, reset or checkout happened');
  assertEqual(after.status, before.status, 'the working tree is as clean as it was found');
  assertEqual(after.refs, before.refs, 'no ref was created, moved or deleted');
}
