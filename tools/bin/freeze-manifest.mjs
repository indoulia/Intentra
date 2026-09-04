#!/usr/bin/env node
/**
 * Regenerates `docs/freeze/v0.3.sha256` and the short-hash list in
 * `docs/ARCHITECTURE_FREEZE.md` section 1.
 *
 * Step 4 of the amendment protocol is "re-run the manifest and commit the new hash with the
 * amendment". Doing that by hand is how a manifest ends up recording the state before the
 * amendment, so it is a script.
 *
 * `--check` verifies without rewriting, which is what CI runs: a mismatch means either an
 * unrecorded amendment or an accident, and both are defects.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = join(ROOT, 'docs', 'freeze', 'v0.3.sha256');
const FREEZE_DOC = join(ROOT, 'docs', 'ARCHITECTURE_FREEZE.md');

/** The frozen set, in the order ARCHITECTURE_FREEZE section 1 lists it. */
const FROZEN = [
  'AGENTOS_PRINCIPLES.md',
  'docs/AGENTOS_ARCHITECTURE.md',
  'docs/KERNEL_BOUNDARY.md',
  'docs/INTENT_AND_WORK_ITEM_RESOLUTION.md',
  'docs/AGENT_ROLES.md',
  'docs/CONTEXT_MODEL.md',
  'docs/DATA_SEMANTICS.md',
  'docs/CAPABILITY_MODEL.md',
  'docs/WORKFLOW_STATE_MACHINE.md',
  'docs/AGENT_HANDOFF_CONTRACT.md',
  'docs/DEFINITION_OF_DONE.md',
  'docs/HUMAN_AUTHORIZATION.md',
  'docs/SKILL_AND_MODEL_SELECTION.md',
  'docs/REPOSITORY_ADAPTER.md',
];

/** The manifest hashes LF content, so a CRLF checkout still verifies. */
function hashOf(relative) {
  const raw = readFileSync(join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

const hashes = FROZEN.map((f) => [f, hashOf(f)]);
const manifest = `${hashes.map(([f, h]) => `${h} ${f}`).join('\n')}\n`;

const doc = readFileSync(FREEZE_DOC, 'utf8');
const listStart = doc.indexOf('- `AGENTOS_PRINCIPLES.md` — `');
if (listStart === -1) throw new Error('could not find the short-hash list in section 1');
const listEnd = doc.indexOf('\n\n', listStart);
const wantList = hashes
  .map(([f, h]) => `- \`${f}\` — \`${h.slice(0, 16)}\``)
  .join('\n');
const newDoc = doc.slice(0, listStart) + wantList + doc.slice(listEnd);

const check = process.argv.includes('--check');
if (check) {
  const haveManifest = readFileSync(MANIFEST, 'utf8').replace(/\r\n/g, '\n');
  const failures = [];
  if (haveManifest !== manifest) failures.push('docs/freeze/v0.3.sha256');
  if (doc !== newDoc) failures.push('docs/ARCHITECTURE_FREEZE.md section 1 short hashes');
  if (failures.length > 0) {
    console.error(
      `freeze manifest is stale: ${failures.join(', ')}\n`
      + 'A frozen document changed without the manifest being re-run. Either record the\n'
      + 'amendment in ARCHITECTURE_FREEZE section 8 and run `node tools/bin/freeze-manifest.mjs`,\n'
      + 'or revert the change.',
    );
    process.exit(1);
  }
  console.log(`freeze manifest OK (${FROZEN.length} documents)`);
} else {
  writeFileSync(MANIFEST, manifest, { encoding: 'utf8' });
  writeFileSync(FREEZE_DOC, newDoc, { encoding: 'utf8' });
  console.log(`freeze manifest rewritten (${FROZEN.length} documents)`);
  for (const [f, h] of hashes) console.log(`  ${h.slice(0, 16)}  ${f}`);
}
