#!/usr/bin/env node
/**
 * The full validation gate, in order.
 *
 * One script rather than a list in a document, because a gate someone has to remember to
 * run in the right order is a gate that gets run in the wrong order. Each stage prints its
 * own result and the first failure stops the run — a typecheck failure makes every later
 * result meaningless, and reporting them anyway would bury the one that matters.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

/** The declared package source roots, in dependency order. */
const PACKAGES = [
  'contracts', 'policies', 'registries', 'state', 'adapters', 'discovery', 'agents', 'core',
];

/** Stage name, argv. Order matters and is the order of the plan's final validation gate. */
const STAGES = [
  ['freeze', [process.execPath, ['tools/bin/freeze-manifest.mjs', '--check']]],
  ['codegen', [process.execPath, ['tools/bin/codegen.mjs', '--check']]],
  ['build', [process.execPath, [tscBin(), '-b']]],
  ['typecheck', [process.execPath, [tscBin(), '-b', '--force']]],
  ['lint', [process.execPath, [eslintBin(), '.', '--max-warnings', '0']]],
  ['tests', [process.execPath, ['tools/bin/test.mjs']]],
  ['ajv-parity', [process.execPath, ['tools/bin/ajv-parity.mjs']]],
  ['boundary', [process.execPath, [depcruiseBin(), '--config', '.dependency-cruiser.cjs',
    ...sourceRoots()]]],
  ['delete-core', [process.execPath, ['tools/bin/delete-core-test.mjs']]],
  ['conformance', [process.execPath, ['tools/bin/conformance.mjs']]],
];

/*
 * Every stage is invoked as `node <script>` rather than through `npm run`. npm ships with the
 * node installation rather than in the project, so its CLI is not at a path this script can
 * name portably — and shelling out to a `npm`/`npm.cmd` on PATH would make the gate depend on
 * shell resolution differing between a POSIX shell and cmd.exe.
 */
function tscBin() {
  return join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
}
function eslintBin() {
  return join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
}
function depcruiseBin() {
  return join(ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruise.mjs');
}

/**
 * The source roots that exist.
 *
 * dependency-cruiser fails on a directory that is not there, and a package with no source yet
 * has none. Filtering keeps the boundary check runnable while the implementation is partial,
 * and the conformance check is what notices a package that should have source and does not —
 * so a silently skipped package cannot pass unnoticed.
 */
function sourceRoots() {
  return PACKAGES.map((p) => `${p}/src`).filter((p) => existsSync(join(ROOT, p)));
}

const results = [];
let failed = null;

for (const [name, [command, args]] of STAGES) {
  if (only.length > 0 && !only.includes(name)) continue;
  process.stdout.write(`\n=== ${name} ${'='.repeat(Math.max(0, 60 - name.length))}\n`);
  const started = Date.now();
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
    results.push([name, 'PASS', Date.now() - started]);
  } catch {
    results.push([name, 'FAIL', Date.now() - started]);
    failed = name;
    break;
  }
}

process.stdout.write(`\n${'='.repeat(64)}\n`);
for (const [name, verdict, ms] of results) {
  process.stdout.write(`${verdict === 'PASS' ? 'PASS' : 'FAIL'}  ${name.padEnd(16)} ${ms} ms\n`);
}
if (failed !== null) {
  process.stdout.write(`\nverify FAILED at ${failed}\n`);
  process.exit(1);
}
process.stdout.write('\nverify OK\n');
