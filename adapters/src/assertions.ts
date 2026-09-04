import { digest } from '@agentos/contracts';
import type { AbsenceReason, Assertion, Evidence, EvidenceKind, Locator } from '@agentos/contracts';

/**
 * Assertion construction, so that "every output of the attachment sequence is an assertion
 * with a confidence class" is true by the only means available rather than by discipline.
 *
 * The discriminated union does the work, and the contract enforces the obligations rather
 * than restating them: a `FACT` owes **at least one** piece of evidence, an `INFERENCE` owes
 * **at least one** thing it was derived from plus its reasoning, and an `UNKNOWN` owes a
 * reason and what would recover it. There is no constructor here that produces a value with
 * no confidence, and none that produces a `FACT` with nothing behind it — a `FACT` with no
 * evidence is an `INFERENCE` that has not admitted it, and the schema says so.
 *
 * The evidence an adapter attaches to its own observation is the **locator of the call that
 * produced it**. That is what makes the assertion checkable: the kernel can re-execute the
 * same operation with the same arguments and compare, which is the whole reason `locator` is
 * mandatory on every piece of evidence.
 */

export interface SelfEvidenceInput {
  readonly adapter: string;
  readonly op: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly kind: EvidenceKind;
  /** A human-readable pointer. For reading only; never the basis of a check. */
  readonly ref: string;
  readonly excerpt: string;
  readonly observedAt: string;
  /** False for a genuinely unrepeatable observation, which caps what it supports. */
  readonly reproducible?: boolean;
}

/**
 * The evidence for an observation the adapter just made: how to make it again.
 *
 * The id is derived from the locator and the moment, so two observations of the same thing at
 * the same instant are the same evidence and two at different moments are not. Deterministic,
 * because an id that moved between runs would make a replay disagree with its own recording.
 */
export function selfEvidence(input: SelfEvidenceInput): Evidence {
  const locator: Locator = { adapter: input.adapter, op: input.op, args: input.args };
  return {
    id: `ev_${digest({ locator, at: input.observedAt }).slice(0, 16)}`,
    kind: input.kind,
    locator,
    ref: input.ref,
    excerpt: input.excerpt,
    observed_at: input.observedAt,
    reproducible: input.reproducible ?? true,
  };
}

function list(evidence: Evidence | readonly Evidence[]): readonly Evidence[] {
  return Array.isArray(evidence) ? evidence : [evidence as Evidence];
}

/**
 * A `FACT`, with the evidence that makes it one.
 *
 * The evidence argument is not optional and not permitted to be empty: the one way to produce
 * a `FACT` here is to have something behind it.
 */
export function fact(
  value: unknown,
  probe: string,
  observedAt: string,
  evidence: Evidence | readonly Evidence[],
): Assertion {
  const items = list(evidence);
  if (items.length === 0) {
    throw new Error(
      `${probe} produced a FACT with no evidence. A FACT with no evidence is an INFERENCE `
      + 'that has not admitted it, and the contract refuses it',
    );
  }
  return {
    value,
    confidence: 'FACT',
    observed_at: observedAt,
    probe,
    freshness: 'CURRENT',
    evidence: [...items],
  };
}

/**
 * An `INFERENCE`, with what it was reasoned from.
 *
 * `derived_from` carries the ids of the evidence the reasoning rests on, and the evidence
 * itself travels with the assertion, because a Context Package assertion stands alone and has
 * no envelope pool to cite into.
 */
export function inference(
  value: unknown,
  probe: string,
  observedAt: string,
  reasoning: string,
  from: Evidence | readonly Evidence[],
): Assertion {
  const items = list(from);
  if (items.length === 0) {
    throw new Error(
      `${probe} produced an INFERENCE derived from nothing. What it was reasoned from is what `
      + 'makes a later contradiction traceable to its source rather than mysterious',
    );
  }
  return {
    value,
    confidence: 'INFERENCE',
    observed_at: observedAt,
    probe,
    freshness: 'CURRENT',
    derived_from: items.map((entry) => entry.id),
    reasoning,
    evidence: [...items],
  };
}

/**
 * An assertion that says it does not know, and what would fix that.
 *
 * `recoverable_by` is what makes an unknown actionable rather than decorative. An adapter
 * that reports "could not determine" without saying what access would determine it has
 * produced a gap nobody can close.
 */
export function unknown(
  probe: string,
  observedAt: string,
  reason: AbsenceReason,
  recoverableBy: string,
  attempted?: string,
): Assertion {
  const base = {
    value: null,
    confidence: 'UNKNOWN' as const,
    observed_at: observedAt,
    probe,
    freshness: 'UNKNOWN' as const,
    reason,
    recoverable_by: recoverableBy,
  };
  return attempted === undefined ? base : { ...base, attempted };
}

/**
 * The specific unknown that means "this exists and would not answer".
 *
 * `UNAVAILABLE` and absence are different facts and lead to different decisions: "this host
 * has no project-management access" is not worth reporting to a human and "the project
 * management server is configured and failed to connect" is.
 */
export function unavailable(
  probe: string,
  observedAt: string,
  recoverableBy: string,
  attempted: string,
): Assertion {
  return unknown(probe, observedAt, 'UNAVAILABLE', recoverableBy, attempted);
}
