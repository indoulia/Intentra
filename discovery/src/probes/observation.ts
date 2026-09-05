import { validators } from '@agentos/contracts';
import type { Assertion } from '@agentos/contracts';
import type { Observation, ObserveRequest, ProbeSession } from '../session.js';

/**
 * One adapter observation, with the adapter's own confidence honoured.
 *
 * Every operation in `adapters/` answers with an `Assertion` rather than with bare data, and
 * that is deliberate: it is how "git was not installed" stays distinguishable from "the
 * repository has no branches", and how `host.read_run_history` says *UNAVAILABLE* instead of
 * reporting an empty history that would make a resumed run redo work it had already done.
 *
 * A probe reading that wrapper as if it were the data would produce the exact lie the wrapper
 * exists to prevent — an `UNKNOWN` assertion is an object, an object with no `sha` in it reads
 * as "no commits", and a failure to look becomes a fact about the world. So the unwrapping
 * happens here, once, and every probe observes through it:
 *
 * - A `FACT` or an `INFERENCE` is the adapter saying it observed something. The observation
 *   carries its value, and the probe classifies it as it always did — the adapter's confidence
 *   is not silently promoted, because the probe's own evidence and freshness rules still apply.
 * - An `UNKNOWN` is the adapter saying it established nothing. That is not an observation, so
 *   it does not come back as one. It comes back as a failure to observe carrying the adapter's
 *   own reason and its own recovery, which is what `ProbeSession.noAccess` renders.
 * - Anything else is data the adapter meant literally, and is passed through untouched.
 */
export async function observe(
  session: ProbeSession,
  request: ObserveRequest,
): Promise<Observation> {
  const observation = await session.observe(request);
  if (observation.outcome !== 'OBSERVED') return observation;

  const assertion = asAssertion(observation.value);
  if (assertion === null) {
    const sequence = asAssertionMap(observation.value);
    return sequence === null ? observation : { ...observation, value: sequence };
  }

  if (assertion.confidence === 'UNKNOWN') {
    return {
      outcome: 'NO_ACCESS',
      state: accessState(assertion.reason),
      adapter: request.adapter,
      op: request.op,
      detail:
        `${request.adapter}.${request.op} answered and established nothing `
        + `(${assertion.reason}): ${assertion.recoverable_by}`
        + (assertion.attempted === undefined ? '' : `. It attempted: ${assertion.attempted}`),
      observedAt: observation.observedAt,
    };
  }

  return { ...observation, value: assertion.value };
}

/**
 * One named output of the attachment sequence, out of the map the sequence answers with.
 *
 * `repo.attach` computes all eight steps and the narrower operations project from it, so every
 * one of them answers with a **map keyed by attachment output** rather than with the output
 * itself — `repo.identify` with five entries, `repo.detect_stack` with eight, `repo.commands`
 * with exactly one. A probe reading a single-entry projection as though it were the entry is
 * off by one level, and the failure is silent: every field it looks for is `undefined`, so a
 * repository that declares a test command reports that it declares none.
 *
 * Reading it through here is what keeps the knowledge of that shape in one file, beside the
 * envelope unwrapping it belongs with. An absent key is `undefined` and stays `undefined` —
 * `asAssertionMap` drops the outputs the adapter established nothing about, and that gap is
 * the caller's to state.
 */
export function attachmentOutput(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Readonly<Record<string, unknown>>)[key];
}

/**
 * The paths a listing reported, whichever shape the adapter reports them in.
 *
 * Enumerations answer with a bare list of paths, with `{ path }` records, or with a listing
 * record that carries its `entries` alongside the flag saying whether it truncated. All three
 * are the same observation, and a reader that understood only one of them would read the other
 * two as "nothing found" — which is the difference between an empty subtree and an unread one.
 */
export function listedPaths(value: unknown): readonly string[] {
  if (Array.isArray(value)) return fromList(value);
  if (value === null || typeof value !== 'object') return [];
  const record = value as Readonly<Record<string, unknown>>;
  for (const field of ['entries', 'matched', 'paths']) {
    const listed = record[field];
    if (Array.isArray(listed)) return fromList(listed);
  }
  return [];
}

/**
 * A listing of named things, whether the adapter named them in records or in bare strings.
 *
 * Some listings are nothing but names — a tag is a ref name and git has no more to say about
 * it — and an adapter that answers `['v1.0.0']` is answering completely. A probe that read only
 * records would see that as an empty listing, which is the same silent shape as
 * `git_state.branches` reading `FACT []` against a repository with four branches: a real
 * observation discarded because it arrived in the simpler of two equivalent forms.
 *
 * Only for listings whose *whole* content is the name. Where a record carries fields a decision
 * turns on — a branch and its protection — a bare string is a listing that lost something, and
 * normalizing it here would manufacture a record with the deciding field missing.
 */
export function namedRecords(value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Readonly<Record<string, unknown>>> = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) {
      out.push({ name: entry });
      continue;
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    out.push(entry as Readonly<Record<string, unknown>>);
  }
  return out;
}

function fromList(list: readonly unknown[]): readonly string[] {
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string' && entry.length > 0) {
      out.push(entry);
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const path = (entry as Readonly<Record<string, unknown>>)['path'];
    if (typeof path === 'string' && path.length > 0) out.push(path);
  }
  return out;
}

/**
 * The adapter's value as an `Assertion`, or `null` where it is data.
 *
 * Checked against the contract's own schema rather than by sniffing for a `confidence` key.
 * The schema is what `adapters/` builds these with, so agreement with it is the definition of
 * "this is an assertion" — and a payload that merely happens to carry a similar field is not
 * unwrapped by accident.
 */
function asAssertion(value: unknown): Assertion | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return validators.assertion.check(value).valid ? (value as Assertion) : null;
}

/**
 * A record whose every entry is an assertion, unwrapped entry by entry — or `null`.
 *
 * The attachment sequence answers this way: `repo.identify` and `repo.detect_stack` return one
 * assertion per thing they established, because the sequence establishes eight things with
 * eight different confidences and collapsing them to one would lose seven of them.
 *
 * Each entry is unwrapped the same way a lone assertion is, and an `UNKNOWN` entry is **left
 * out** rather than carried through as an object. That is what makes the gap visible: a probe
 * reading a key nobody established gets `undefined` and says INSUFFICIENT_EVIDENCE, where a
 * carried-through `UNKNOWN` would arrive as a truthy object and be written into the Context
 * Package as though it were the value.
 */
function asAssertionMap(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>);
  if (entries.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    const assertion = asAssertion(entry);
    if (assertion === null) return null;
    if (assertion.confidence !== 'UNKNOWN') out[key] = assertion.value;
  }
  return out;
}

/**
 * Which kind of access gap an adapter's `UNKNOWN` is.
 *
 * `NOT_APPLICABLE` is the adapter saying nothing is attached — no project-management system,
 * no runtime — which is `NOT_CONFIGURED` and is a recorded limitation rather than a failure.
 * `UNAVAILABLE` is something attached that would not answer. Every other reason is the adapter
 * having been reached and having established nothing, which is `AVAILABLE` with the gap
 * stated: the operation ran, and the answer is still not known.
 */
function accessState(reason: string): 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'AVAILABLE' {
  if (reason === 'NOT_APPLICABLE') return 'NOT_CONFIGURED';
  if (reason === 'UNAVAILABLE') return 'UNAVAILABLE';
  return 'AVAILABLE';
}
