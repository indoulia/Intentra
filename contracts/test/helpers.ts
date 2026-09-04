import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test-side filesystem access.
 *
 * `@agentos/contracts` itself does no I/O — the schemas are embedded. Its tests do, because
 * the expressiveness test has to read the frozen documents to check that every worked
 * example in them validates, and a test that read an embedded copy of a document would be
 * checking the copy.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Walks up from the compiled test directory to the repository root. */
export const REPO_ROOT: string = (() => {
  let dir = HERE;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'docs', 'ARCHITECTURE_FREEZE.md'))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`could not locate the repository root from ${HERE}`);
})();

export function readRepoFile(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

export function readJsonFile<T = unknown>(relative: string): T {
  return JSON.parse(readRepoFile(relative)) as T;
}

export function listDir(relative: string): readonly string[] {
  const dir = join(REPO_ROOT, relative);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

/** The fourteen normative documents, in the order ARCHITECTURE_FREEZE section 1 lists them. */
export const FROZEN_DOCUMENTS: readonly string[] = [
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

export interface JsonBlock {
  readonly document: string;
  readonly index: number;
  readonly line: number;
  readonly text: string;
  readonly value: unknown;
}

/** Every fenced ```json block in a frozen document, with where it came from. */
export function jsonBlocks(document: string): readonly JsonBlock[] {
  const source = readRepoFile(document);
  const blocks: JsonBlock[] = [];
  const pattern = /```json\n([\s\S]*?)```/g;
  let match = pattern.exec(source);
  let index = 0;
  while (match !== null) {
    const text = match[1] ?? '';
    const line = source.slice(0, match.index).split('\n').length;
    blocks.push({ document, index, line, text, value: JSON.parse(text) });
    index += 1;
    match = pattern.exec(source);
  }
  return blocks;
}

export function allJsonBlocks(): readonly JsonBlock[] {
  return FROZEN_DOCUMENTS.flatMap((doc) => jsonBlocks(doc));
}
