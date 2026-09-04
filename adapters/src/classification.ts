import type { Classification, ConfidenceClass } from '@agentos/contracts';

/**
 * Fail-closed classification.
 *
 * Two facts gate everything dangerous — is this branch protected, is this environment
 * production — and both are discovered, and discovery can fail. The rule is that **`UNKNOWN`
 * is treated as the dangerous case** (REPOSITORY_ADAPTER 2.2), and this is where that
 * inversion is actually performed.
 *
 * The value a failed probe produces is the **dangerous value itself**, not a third value
 * meaning "we could not tell". That is not a stylistic choice. `policies/data/gates.json`
 * fires `MERGE_PROTECTED` on a classification whose value equals `PROTECTED` and
 * `DEPLOY_PRODUCTION` on one equal to `PRODUCTION`, and the kernel compares by equality. A
 * classification that came back saying `unknown` would satisfy no classifier, fire no gate,
 * and turn the fail-closed rule into a fail-open one — with the `failed_closed: true` flag
 * sitting on the record documenting a caution that never happened.
 *
 * So: the value says what the run must treat the subject as; `confidence` and `failed_closed`
 * say whether that was observed or assumed. A run that was conservative because it was blind
 * stays distinguishable from one that was conservative because the target really was
 * production — which is the whole reason the two fields exist — without the distinction ever
 * being what decides whether the gate fires.
 */

export type ClassificationKind = Classification['kind'];

/** The value each kind takes when its probe could not establish anything. */
export const DANGEROUS_VALUE: Readonly<Record<ClassificationKind, string>> = Object.freeze({
  branch_protection: 'PROTECTED',
  environment: 'PRODUCTION',
  observation_safety: 'UNSAFE',
  spawns_agents: 'SPAWNS',
});

/** The value each kind takes when a probe positively established the safe case. */
export const SAFE_VALUE: Readonly<Record<ClassificationKind, string>> = Object.freeze({
  branch_protection: 'UNPROTECTED',
  environment: 'NON_PRODUCTION',
  observation_safety: 'SAFE',
  spawns_agents: 'DOES_NOT_SPAWN',
});

export type ClassificationObservation =
  | {
    readonly established: true;
    readonly dangerous: boolean;
    readonly confidence: Extract<ConfidenceClass, 'FACT' | 'INFERENCE'>;
    readonly detail: string;
  }
  | { readonly established: false; readonly detail: string };

/** A probe for one kind of classification. Missing probes are the same as failing ones. */
export interface ClassificationProbe {
  readonly kind: ClassificationKind;
  probe(subject: string): Promise<ClassificationObservation>;
}

/**
 * Turns an observation into the record the kernel gates on.
 *
 * An unestablished observation yields the dangerous value at `UNKNOWN` confidence with
 * `failed_closed: true`. An established one yields whichever value the probe found, at the
 * confidence the probe earned, with `failed_closed: false` — including when what it found was
 * the dangerous value, because "this really is production" and "we could not tell" are
 * different facts and only one of them is fixable by granting access.
 */
export function classify(
  kind: ClassificationKind,
  subject: string,
  observation: ClassificationObservation,
): Classification {
  if (!observation.established) {
    return {
      subject,
      kind,
      value: DANGEROUS_VALUE[kind],
      confidence: 'UNKNOWN',
      failed_closed: true,
      probe_detail:
        `${observation.detail}. The probe could not establish it, so the conservative value `
        + `${DANGEROUS_VALUE[kind]} is taken. Where this bites incorrectly the fix is to give `
        + 'AgentOS the access it needs to classify, or to declare the topology, not to relax '
        + 'the rule',
    };
  }
  return {
    subject,
    kind,
    value: observation.dangerous ? DANGEROUS_VALUE[kind] : SAFE_VALUE[kind],
    confidence: observation.confidence,
    failed_closed: false,
    probe_detail: observation.detail,
  };
}

/** The classification produced when no probe for a kind is wired in at all. */
export function unprobed(kind: ClassificationKind, subject: string): Classification {
  return classify(kind, subject, {
    established: false,
    detail:
      `no ${kind} probe is available to this adapter framework, so nothing about ${subject} `
      + 'was observed',
  });
}
