/**
 * What a probe is allowed to write down.
 *
 * The Context Package persists and may be read by humans and models
 * ([CONTEXT_MODEL.md](../../docs/CONTEXT_MODEL.md) section 8), so secrets are never captured
 * and credentials are referenced by name and location only. That obligation lands here
 * rather than in each probe, because a rule every author has to remember is a rule that gets
 * forgotten in the one probe that reads a `.env` file.
 *
 * Redaction is deliberately blunt. It will mask things that were not secret, and that is the
 * correct direction to be wrong in: a masked build number costs a re-read, a captured token
 * costs a rotation.
 */

/** Key names whose value is masked wherever the key/value shape is recognisable. */
const SECRET_KEY = /(pass(?:word|wd)?|secret|token|api[_-]?key|apikey|auth(?:orization)?|credential|private[_-]?key|access[_-]?key|connection[_-]?string|dsn)/i;

/** `KEY=value`, `KEY: value`, `"key": "value"` — the three shapes configuration arrives in. */
const ASSIGNMENT = /([A-Za-z0-9_.\-"']*?)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/g;

/** PEM blocks and the long opaque strings that are almost always a credential. */
const BLOCK = /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g;
const BEARER = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

export const MASK = '[REDACTED]';

/**
 * Masks anything that looks like a credential, leaving the surrounding text readable.
 *
 * The key name survives and the value does not, which is exactly what "credentials are
 * referenced by name and location only" asks for: a reader still learns that
 * `DATABASE_PASSWORD` is set in this file.
 */
export function redact(text: string): string {
  return text
    .replace(BLOCK, `${MASK} (private key)`)
    .replace(URL_CREDENTIALS, `$1${MASK}@`)
    .replace(BEARER, MASK)
    .replace(ASSIGNMENT, (whole, key: string, separator: string) =>
      (SECRET_KEY.test(key) ? `${key}${separator}${MASK}` : whole));
}

/** How much of an observation an excerpt may carry. Evidence is a pointer, not a copy. */
export const EXCERPT_LIMIT = 600;

/**
 * A readable, redacted, bounded rendering of whatever an adapter returned.
 *
 * Deterministic for a given value: object keys are emitted in sorted order so that two
 * structurally equal observations produce the same excerpt and therefore compare equal under
 * the evidence policy's `normalized_exact_match`.
 */
export function excerptOf(value: unknown, limit: number = EXCERPT_LIMIT): string {
  const rendered = typeof value === 'string' ? value : stableJson(value);
  const cleaned = redact(rendered);
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit)}… (${cleaned.length} chars, truncated)`;
}

/** JSON with object keys sorted, so the rendering of a value does not depend on how it was built. */
export function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const render = (node: unknown): string => {
    if (node === null) return 'null';
    if (node === undefined) return 'null';
    if (typeof node === 'string') return JSON.stringify(node);
    if (typeof node === 'number') return Number.isFinite(node) ? String(node) : 'null';
    if (typeof node === 'boolean') return String(node);
    if (typeof node === 'bigint') return JSON.stringify(node.toString());
    if (typeof node !== 'object') return 'null';
    if (seen.has(node)) return '"[circular]"';
    seen.add(node);
    if (Array.isArray(node)) return `[${node.map(render).join(',')}]`;
    const entries = Object.entries(node as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${render(v)}`).join(',')}}`;
  };
  return render(value);
}
