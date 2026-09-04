#!/usr/bin/env node
/** Removes build output. Generated sources under contracts/src/generated are not output. */
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGES = [
  'contracts', 'policies', 'registries', 'state',
  'adapters', 'discovery', 'agents', 'core',
];
for (const pkg of PACKAGES) {
  rmSync(join(ROOT, pkg, 'dist'), { recursive: true, force: true });
  rmSync(join(ROOT, pkg, 'tsconfig.tsbuildinfo'), { force: true });
}
console.log('cleaned');
