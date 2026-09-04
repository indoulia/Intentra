/**
 * The one place `@agentos/policies` touches the filesystem.
 *
 * KERNEL_BOUNDARY rule 5 sends all outside-world access through adapters, and this is a
 * narrow, stated exception rather than a hole in it (decision I-11): the adapters exist to
 * reach the *target repository* and external systems under path confinement and a call log,
 * and policy loading is AgentOS reading its own installation at startup. Routing it through
 * the adapters would be circular — path confinement reads `paths.json`.
 *
 * The exception is kept honest three ways. It is one file. It reads only under the policy
 * data root, which it resolves once and refuses to escape. And `tools/bin/conformance.mjs`
 * asserts that no other file in `policies/src` imports an I/O module.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export class PolicyDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyDataError';
  }
}

/** Locates `policies/data`, walking up from the compiled module. */
function defaultRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'data');
    if (existsSync(join(candidate, 'stages.json'))) return candidate;
    dir = dirname(dir);
  }
  throw new PolicyDataError(
    'could not locate policies/data; pass an explicit root to loadPolicies()',
  );
}

/**
 * A reader confined to one directory tree. Every path is resolved and checked to be under
 * the root before it is opened — the same rule the repository adapter applies to a worktree,
 * applied here because a confinement claim needs an enforcement point wherever it is made.
 */
export class PolicyDataSource {
  readonly root: string;

  constructor(root?: string) {
    this.root = resolve(root ?? defaultRoot());
    if (!existsSync(this.root)) {
      throw new PolicyDataError(`policy data root does not exist: ${this.root}`);
    }
  }

  #confine(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new PolicyDataError(`policy paths are relative to the data root: ${relativePath}`);
    }
    const full = resolve(this.root, relativePath);
    const inside = relative(this.root, full);
    if (inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) {
      throw new PolicyDataError(`policy path escapes the data root: ${relativePath}`);
    }
    return full;
  }

  exists(relativePath: string): boolean {
    return existsSync(this.#confine(relativePath));
  }

  readText(relativePath: string): string {
    const full = this.#confine(relativePath);
    if (!existsSync(full)) {
      throw new PolicyDataError(`policy file is missing: ${relativePath}`);
    }
    return readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
  }

  readJson(relativePath: string): unknown {
    const text = this.readText(relativePath);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new PolicyDataError(
        `policy file is not valid JSON: ${relativePath} — `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /** Every `.json` file directly inside a subdirectory, sorted for a deterministic load. */
  listJson(relativeDir: string): readonly string[] {
    const full = this.#confine(relativeDir);
    if (!existsSync(full) || !statSync(full).isDirectory()) {
      throw new PolicyDataError(`policy directory is missing: ${relativeDir}`);
    }
    return readdirSync(full)
      .filter((entry) => entry.endsWith('.json'))
      .sort()
      .map((entry) => `${relativeDir}/${entry}`);
  }
}
