/**
 * Deterministic identity and hashing.
 *
 * Everything here is model-free and reproducible: work item identity without an external
 * key is content-derived (freeze D-4), idempotency keys are hashes over declared argument
 * subsets, and the intake content hash is what makes source drift detectable. All of it
 * sits in the kernel's path, so all of it has to be a pure function of its inputs.
 *
 * The hash is SHA-256 from `node:crypto`, which is a Node builtin rather than a dependency,
 * so `@agentos/contracts` still declares none.
 */
import { createHash } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Canonical JSON: object keys sorted, no insignificant whitespace. Two structurally equal
 * values must hash identically regardless of how they were built, or an idempotency key
 * depends on property insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }
  /*
   * Only `string` and `boolean` reach here — `undefined` cannot appear as a JSON value and
   * every other type is handled above — so the encoding is total.
   */
  return JSON.stringify(value);
}

export function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

/**
 * Title normalization for the duplicate check. Deliberately conservative: it will
 * under-match, surfacing two work items where one existed, and that is the correct
 * direction to be wrong in — a missed duplicate costs a surfaced candidate, while a wrong
 * merge destroys history (freeze D-4).
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[`'"''""]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** `jira:DEF-456` becomes `wi_jira_DEF-456`: stable across runs, machines and months. */
export function workItemIdFromExternalIdentity(externalIdentity: string): string {
  const sanitized = externalIdentity.replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/:/g, '_');
  return `wi_${sanitized}`;
}

/** Content-derived identity for work with no external key (freeze D-4). */
export function workItemIdFromContent(
  scope: { readonly paths: readonly string[]; readonly capabilities: readonly string[]; readonly repositories: readonly string[] },
  title: string,
): string {
  const key = canonicalJson({
    paths: [...scope.paths].sort(),
    capabilities: [...scope.capabilities].sort(),
    repositories: [...scope.repositories].sort(),
    title: normalizeTitle(title),
  });
  return `wi_c_${sha256(key).slice(0, 24)}`;
}

/** The similarity check: identical scope and normalized title, and nothing looser. */
export function workItemContentKey(
  scope: { readonly paths: readonly string[]; readonly capabilities: readonly string[]; readonly repositories: readonly string[] },
  title: string,
): string {
  return canonicalJson({
    paths: [...scope.paths].sort(),
    capabilities: [...scope.capabilities].sort(),
    repositories: [...scope.repositories].sort(),
    title: normalizeTitle(title),
  });
}

/**
 * `key_dispatch = hash(run_id, dispatch_id, adapter, op, normalized_args)`.
 * Safe within a run: a crash-retry that replays a known key performs no work.
 */
export function dispatchIdempotencyKey(
  runId: string,
  dispatchId: string,
  adapter: string,
  op: string,
  args: unknown,
): string {
  return digest({ scope: 'dispatch', runId, dispatchId, adapter, op, args });
}

/**
 * `key_work_item = hash(work_item_id, adapter, op, identity_args)`.
 * Safe across runs, which is where duplicate external side effects actually originate. The
 * key is computed over the operation's declared `identity_args` only, so a second run with
 * a differently worded PR description still resolves to the existing PR.
 */
export function workItemIdempotencyKey(
  workItemId: string,
  adapter: string,
  op: string,
  args: Readonly<Record<string, unknown>>,
  identityArgs: readonly string[],
): string {
  const identity: Record<string, unknown> = {};
  for (const name of [...identityArgs].sort()) identity[name] = args[name] ?? null;
  return digest({ scope: 'work_item', workItemId, adapter, op, identity });
}

/**
 * Monotonic, sortable, human-legible run ids. Time first so a directory listing is
 * chronological, then a random suffix so two runs starting in the same millisecond differ.
 */
export function runId(now: Date, random: () => number = Math.random): string {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const suffix = Math.floor(random() * 0xffffff).toString(16).padStart(6, '0');
  return `run_${iso}_${suffix}`;
}

export function shortId(prefix: string, seed: string): string {
  return `${prefix}_${sha256(seed).slice(0, 12)}`;
}

/** Sequential, zero-padded ids for envelopes, dispatches, evidence and the like. */
export function sequentialId(prefix: string, n: number, width = 3): string {
  return `${prefix}_${String(n).padStart(width, '0')}`;
}
