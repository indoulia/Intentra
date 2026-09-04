/**
 * Envelope ingestion, which is parsing and nothing else.
 *
 * IMPLEMENTATION_PLAN WP-5: "A malformed envelope is a `FAILED` dispatch, never a
 * parse-and-repair. The kernel does not guess what an agent meant." That rule is the reason
 * this file is fifteen lines of logic and a long comment rather than the reverse.
 *
 * Everything a repairing parser would be good at is a way to be wrong quietly. Extracting
 * the first `{...}` from prose picks up an example the agent was reasoning about; stripping a
 * code fence accepts an envelope the agent framed as illustration; taking the last of two
 * JSON objects picks the one that happened to be printed second. Each of those turns "the
 * agent did not answer in the required form" — an honest, retryable failure the kernel
 * already knows how to handle — into a plausible envelope nobody wrote. The dispatch
 * instructions state the requirement plainly, and a response that does not meet it fails.
 *
 * What is parsed is returned **unaltered and as `unknown`**. The substrate does not know what
 * a valid envelope is and must not: validation, the cross-field rules, evidence replay and
 * the reconciliations are the kernel's, and every one of them is defeated by a transport that
 * tidies the payload first. In particular a `verification` block, a fabricated `coverage` or
 * an invented `artifacts_changed` entry passes through exactly as written, so that the
 * kernel's disbelief machinery has the agent's actual claim to refuse.
 */

export type EnvelopeParse =
  | { readonly ok: true; readonly envelope: unknown }
  | { readonly ok: false; readonly detail: string };

export function parseEnvelope(text: string): EnvelopeParse {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      detail:
        'the dispatch produced no final text, so there is no envelope. An absent answer is '
        + 'not an empty one',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail:
        `the final text is not JSON (${reason}). It is taken whole and parsed whole: an `
        + 'envelope extracted from prose, unwrapped from a fence or chosen from among several '
        + 'objects would be a guess about which text the agent meant as its answer',
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      detail:
        `the final text parsed as ${describe(parsed)} rather than a JSON object. An envelope `
        + 'is an object, and nothing else can carry the fields the kernel checks',
    };
  }

  return { ok: true, envelope: parsed };
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
