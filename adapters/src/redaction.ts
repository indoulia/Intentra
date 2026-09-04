/**
 * Redaction: secrets referenced by name and location, never captured.
 *
 * The security floor is "never expose or copy a secret", not "never change one"
 * (`policies/data/paths.json`, entry `secret_bearing_names`). The deny-list stops a secret
 * *file* being opened; this stops a secret that turns up inside something that was legitimate
 * to open — a config file with an inline token, a command's error output echoing a
 * connection string, a stack trace carrying an Authorization header.
 *
 * Two rules govern the pattern set:
 *
 * - **Narrow.** Every pattern matches a shape that is a credential and not a shape that
 *   merely mentions one, because a redactor that mangles source code makes the excerpts it
 *   protects useless as evidence.
 * - **Named.** A redaction leaves behind what was found and where, so a human can go and
 *   look. `[redacted:aws_access_key_id@repo.read_file .env.example:12]` is actionable;
 *   `[redacted]` is not.
 */

export interface RedactionHit {
  /** What kind of secret was found, not the secret. */
  readonly name: string;
  /** Where it was found: an adapter operation, a path, a field. Never a value. */
  readonly location: string;
}

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
}

/*
 * Ordered most specific first. A PEM block must be matched before the generic assignment
 * rule can chew on the `KEY` inside its header.
 */
const RULES: readonly Rule[] = [
  {
    name: 'private_key_block',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { name: 'vcs_personal_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: 'chat_bot_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'cloud_access_key_id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    name: 'json_web_token',
    pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  { name: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { name: 'basic_authorization', pattern: /\bBasic\s+[A-Za-z0-9+/=]{16,}/gi },
  {
    name: 'url_embedded_credentials',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@/gi,
  },
  {
    name: 'assigned_secret',
    pattern:
      /\b(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|connection[_-]?string|sas[_-]?token)\b(\s*[:=]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,;)\]}]{4,})/gi,
  },
];

function placeholder(name: string, location: string): string {
  return `[redacted:${name}@${location}]`;
}

/**
 * Replaces every credential-shaped run in `text`, reporting what was replaced and where.
 *
 * The `assigned_secret` rule keeps the key and the separator so the surrounding structure
 * still parses and still reads: `api_key = [redacted:api_key@...]`.
 */
export function redactText(
  text: string,
  location: string,
): { readonly text: string; readonly hits: readonly RedactionHit[] } {
  const hits: RedactionHit[] = [];
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (...groups: unknown[]) => {
      hits.push({ name: rule.name, location });
      if (rule.name !== 'assigned_secret') return placeholder(rule.name, location);
      const key = String(groups[1]);
      const separator = String(groups[2]);
      return `${key}${separator}${placeholder(key.toLowerCase(), location)}`;
    });
  }
  return { text: out, hits };
}

/**
 * Redacts every string reachable inside a value, however deeply nested.
 *
 * Applied to everything an adapter returns and to every message it reports. A redactor that
 * only covered excerpts would leave the same secret in the error the failed read produced,
 * and the error is the one people paste into a ticket.
 */
export function redactDeep(
  value: unknown,
  location: string,
): { readonly value: unknown; readonly hits: readonly RedactionHit[] } {
  const hits: RedactionHit[] = [];
  const walk = (node: unknown, depth: number): unknown => {
    /* A cycle or a pathological nesting depth is not worth following; the value is already
     * beyond what an excerpt should carry, and refusing to descend is the safe end. */
    if (depth > 24) return '[redacted:undescendable_depth@' + location + ']';
    if (typeof node === 'string') {
      const result = redactText(node, location);
      hits.push(...result.hits);
      return result.text;
    }
    if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1));
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
        out[key] = walk(entry, depth + 1);
      }
      return out;
    }
    return node;
  };
  return { value: walk(value, 0), hits };
}

/** The common case: a message that must not carry a secret into a log or a refusal. */
export function redactMessage(message: string, location: string): string {
  return redactText(message, location).text;
}
