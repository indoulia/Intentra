#!/usr/bin/env node
/**
 * Runs the whole test suite over the compiled output.
 *
 * Test files are discovered rather than listed, because a package whose tests were left out
 * of a hand-written glob is a package nobody notices is untested. Layer order follows the
 * plan: schema and fixture validation first (no I/O), then kernel unit and property tests
 * over fixtures, then adapters against a scratch repository, then the invariant suite, then
 * the end-to-end runs. A failure early makes the later layers uninformative.
 */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Packages in test-layer order. */
const PACKAGES = [
  'contracts',
  'policies',
  'registries',
  'state',
  'adapters',
  'discovery',
  'agents',
  'core',
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.test.js')) out.push(full);
  }
  return out;
}

const files = [];
const perPackage = [];
for (const pkg of PACKAGES) {
  const dir = join(ROOT, pkg, 'dist', 'test');
  if (!existsSync(dir)) {
    perPackage.push([pkg, 0]);
    continue;
  }
  const found = walk(dir).sort();
  perPackage.push([pkg, found.length]);
  files.push(...found);
}

if (files.length === 0) {
  console.error('no compiled test files found; run `npm run build` first');
  process.exit(1);
}

console.log('test files per package:');
for (const [pkg, count] of perPackage) {
  console.log(`  ${pkg.padEnd(12)} ${count === 0 ? '-' : count}`);
}
console.log('');

const args = ['--test', '--test-reporter=spec', ...files];
try {
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
} catch {
  process.exit(1);
}

/*
 * A skipped test is a failing test nobody has to look at.
 *
 * The suite is the evidence that the invariants hold, so a test that does not run is a
 * claim withdrawn without anyone deciding to withdraw it — and `skipped 0` printed in a
 * summary is not a check, it is a number scrolling past. Re-running under the TAP reporter
 * is cheap next to the whole suite and turns it into one.
 */
const tap = execFileSync(
  process.execPath,
  ['--test', '--test-reporter=tap', ...files],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 },
);
const skipped = [...tap.matchAll(/^(?:not ok|ok) \d+ - (.*?) # (SKIP|TODO)\b(.*)$/gm)];
if (skipped.length > 0) {
  console.log('');
  console.log('these tests did not run:');
  for (const [, name, kind, detail] of skipped) {
    console.log(`  ${kind}  ${name}${detail.trim() === '' ? '' : ` (${detail.trim()})`}`);
  }
  console.log('');
  console.log('A skipped test is a claim withdrawn without anyone deciding to withdraw it.');
  console.log('Delete it, fix it, or state in the commit why the claim no longer holds.');
  process.exit(1);
}
