#!/usr/bin/env node
/**
 * The delete-core test.
 *
 * KERNEL_BOUNDARY section 2 states the practical test for the dependency rule: "delete
 * `core/` and every agent should still compile." The plan says it is worth running rather
 * than quoting, so this runs it — against a copy, in a temporary directory, so a failing
 * run cannot damage the working tree.
 *
 * If an agent breaks, the boundary has leaked, and that is an architecture change rather
 * than a code change.
 */
import { cpSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COPIED = [
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'contracts',
  'policies',
  'registries',
  'state',
  'adapters',
  'discovery',
  'agents',
];

const work = mkdtempSync(join(tmpdir(), 'agentos-delete-core-'));
try {
  for (const entry of COPIED) {
    const from = join(ROOT, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(work, entry), {
      recursive: true,
      filter: (src) => !src.includes(`${'node_modules'}`) && !src.includes(`${'dist'}`),
    });
  }
  cpSync(join(ROOT, 'node_modules'), join(work, 'node_modules'), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });

  /* A solution tsconfig that references everything except core/. If agents compiles here,
   * nothing in agents/ or below reaches the kernel. */
  const solution = {
    files: [],
    references: [
      { path: './contracts' },
      { path: './policies' },
      { path: './registries' },
      { path: './state' },
      { path: './adapters' },
      { path: './discovery' },
      { path: './agents' },
    ],
  };
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(work, 'tsconfig.json'), `${JSON.stringify(solution, null, 2)}\n`, 'utf8');

  /* Strip the kernel-facing declaration from the agents manifest as well, so the test
   * proves the boundary rather than proving the copy still had core/ available. */
  for (const pkg of ['agents', 'discovery', 'adapters', 'registries', 'policies', 'state']) {
    const manifestPath = join(work, pkg, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.dependencies !== undefined && '@agentos/core' in manifest.dependencies) {
      throw new Error(`${pkg}/package.json declares @agentos/core, which the rule forbids`);
    }
  }

  const tsc = join(work, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [tsc, '-b', 'agents'], {
    cwd: work,
    stdio: 'inherit',
  });
  console.log('delete-core test OK: agents compiles with no core/ present');
} finally {
  rmSync(work, { recursive: true, force: true });
}
