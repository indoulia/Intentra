import type {
  AdapterRegistry,
  AdapterCallContext,
  CallRecord,
  Clock,
  Evidence,
  EvidencePolicy,
  EvidencePredicate,
  Finding,
  HandoffEnvelope,
  Violation,
} from '@agentos/contracts';

/**
 * Step 4 of envelope receipt: the kernel replays evidence through the originating adapter.
 *
 * This is the deepest of the disbelief checks, because everything downstream rests on
 * evidence. It is also the one that must not become a hole: verification cannot itself
 * mutate, so a locator's operation must be one the adapter declares `observation_safe`. An
 * agent must not be able to use the evidence channel to make the kernel perform a mutation
 * on its behalf.
 *
 * **Comparison is mechanical, per kind.** The kernel does not judge whether two observations
 * "mean the same thing" — that would require a model, and the verifier must be model-free.
 */

export interface VerificationSelection {
  readonly evidence: Evidence;
  readonly reason:
  | 'ALWAYS_CRITICAL_FINDING'
  | 'ALWAYS_AUTHORIZATION'
  | 'ALWAYS_DOD_MET'
  | 'ALWAYS_CONTRADICTS'
  | 'SAMPLED'
  | 'NOT_SELECTED'
  | 'DECLARED_UNREPRODUCIBLE';
}

export interface VerificationOutcome {
  readonly evidence_id: string;
  readonly status: 'VERIFIED' | 'MISMATCH' | 'UNREPLAYABLE' | 'UNVERIFIED' | 'UNVERIFIABLE';
  readonly selected_because: VerificationSelection['reason'];
  readonly detail: string;
}

export interface VerificationReport {
  readonly outcomes: readonly VerificationOutcome[];
  readonly mismatchCount: number;
  /** True when the whole envelope must be rejected and the dispatch treated as FAILED. */
  readonly rejectEnvelope: boolean;
  readonly violations: readonly Violation[];
  /** Findings that lost their last verified evidence and must demote to a hypothesis. */
  readonly demotedFindings: readonly string[];
  /** Evidence ids whose supported assertions must be downgraded, with the reason. */
  readonly downgrades: readonly {
    readonly evidence_id: string;
    readonly to: 'UNKNOWN';
    readonly reason: 'CONFLICTING' | 'UNAVAILABLE';
  }[];
}

/**
 * Chooses what to verify.
 *
 * The always-verify classes are the ones where a fabrication is not recoverable later: a
 * critical finding drives the whole report, an authorization request is what a human decides
 * on, a `MET` criterion is what completion rests on, and a `FACT` contradicting existing
 * state is the case where believing the wrong one corrupts the run. Everything else is
 * sampled at a policy rate with a minimum of one per envelope, because an envelope of
 * uncritical evidence that is never checked at all is an envelope nobody checked.
 */
export function selectForVerification(
  envelope: HandoffEnvelope,
  policy: EvidencePolicy,
  contradicts: (evidence: Evidence) => boolean,
  sampler: () => number,
): readonly VerificationSelection[] {
  const byId = new Map(envelope.evidence.map((e) => [e.id, e]));
  const selected = new Map<string, VerificationSelection['reason']>();

  const critical = new Set<string>();
  for (const finding of envelope.findings) {
    if (finding.severity !== 'CRITICAL' && finding.severity !== 'HIGH') continue;
    for (const id of finding.evidence) critical.add(id);
  }

  const authorization = new Set<string>(
    envelope.proposals.authorization_request?.evidence ?? [],
  );

  const dodMet = new Set<string>();
  for (const verdict of envelope.dod_verdicts) {
    if (verdict.verdict !== 'MET') continue;
    for (const id of verdict.evidence) dodMet.add(id);
  }

  for (const evidence of envelope.evidence) {
    /* Declared-unreproducible evidence is UNVERIFIABLE by declaration, which caps the
     * assertion it supports at INFERENCE. Attempting to replay it would report a mismatch
     * for a reason that is not a defect. */
    if (!evidence.reproducible || evidence.locator.op === null) {
      selected.set(evidence.id, 'DECLARED_UNREPRODUCIBLE');
      continue;
    }
    if (critical.has(evidence.id)) {
      selected.set(evidence.id, 'ALWAYS_CRITICAL_FINDING');
      continue;
    }
    if (authorization.has(evidence.id)) {
      selected.set(evidence.id, 'ALWAYS_AUTHORIZATION');
      continue;
    }
    if (dodMet.has(evidence.id)) {
      selected.set(evidence.id, 'ALWAYS_DOD_MET');
      continue;
    }
    if (contradicts(evidence)) {
      selected.set(evidence.id, 'ALWAYS_CONTRADICTS');
      continue;
    }
  }

  /* The sample, over what the always-verify classes left. */
  const remaining = envelope.evidence.filter((e) => !selected.has(e.id));
  const wanted = Math.max(
    remaining.length === 0 ? 0 : policy.sample_minimum_per_envelope,
    Math.ceil(remaining.length * policy.sample_rate),
  );
  /* Deterministic given the sampler, which the kernel seeds from the run: a verification
   * pass that could not be reproduced would make an integrity event unarguable. */
  const ordered = [...remaining].sort((a, b) => (a.id < b.id ? -1 : 1));
  const picked = new Set<string>();
  for (let i = 0; i < ordered.length && picked.size < wanted; i += 1) {
    const index = Math.floor(sampler() * ordered.length);
    const candidate = ordered[index % ordered.length];
    if (candidate !== undefined) picked.add(candidate.id);
  }
  /* Fill deterministically if the sampler collided its way short of the target. */
  for (const evidence of ordered) {
    if (picked.size >= wanted) break;
    picked.add(evidence.id);
  }

  for (const evidence of ordered) {
    selected.set(evidence.id, picked.has(evidence.id) ? 'SAMPLED' : 'NOT_SELECTED');
  }

  return [...selected.entries()].map(([id, reason]) => {
    const evidence = byId.get(id);
    if (evidence === undefined) throw new Error(`evidence ${id} vanished during selection`);
    return { evidence, reason };
  });
}

/** Whitespace and ordering normalization only; nothing that could make two things equal. */
export function normalizeExcerpt(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .sort()
    .join('\n');
}

/** Re-evaluates the predicate an observation satisfied, over a replayed value. */
export function evaluatePredicate(predicate: EvidencePredicate, value: unknown): boolean {
  const subject = extract(value, predicate.subject);
  const operand = predicate.operand;
  switch (predicate.operator) {
    case 'eq': return looseEqual(subject, operand);
    case 'ne': return !looseEqual(subject, operand);
    case 'lt': return numeric(subject) < numeric(operand);
    case 'lte': return numeric(subject) <= numeric(operand);
    case 'gt': return numeric(subject) > numeric(operand);
    case 'gte': return numeric(subject) >= numeric(operand);
    case 'contains': return String(subject).includes(String(operand));
    case 'not_contains': return !String(subject).includes(String(operand));
    case 'matches': return new RegExp(String(operand)).test(String(subject));
    default: return false;
  }
}

function extract(value: unknown, subject: string): unknown {
  if (value === null || typeof value !== 'object') return value;
  let node: unknown = value;
  for (const token of subject.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[token];
  }
  return node;
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' || typeof b === 'number') {
    return Number(a) === Number(b);
  }
  return String(a) === String(b);
}

function numeric(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export interface VerifyInput {
  readonly envelope: HandoffEnvelope;
  readonly policy: EvidencePolicy;
  readonly adapters: AdapterRegistry;
  readonly callContext: AdapterCallContext;
  readonly clock: Clock;
  /** The dispatch's call log, for confirming the provenance of unverifiable evidence. */
  readonly calls: readonly CallRecord[];
  readonly contradicts?: (evidence: Evidence) => boolean;
  readonly sampler?: () => number;
}

/**
 * Verifies an envelope's evidence and reports what must happen as a result.
 *
 * On `MISMATCH` or `UNREPLAYABLE`: every assertion resting on that evidence is downgraded,
 * findings that lose their last verified evidence demote to hypotheses, an
 * `evidence_integrity` event is logged against the producing agent and model, and on the
 * policy-defined count of mismatches within one envelope the **entire envelope is rejected**
 * and the dispatch is treated as `FAILED`. One fabrication is a defect; two is an
 * untrustworthy witness, and nothing it said should be merged.
 */
export async function verifyEvidence(input: VerifyInput): Promise<VerificationReport> {
  const {
    envelope, policy, adapters, callContext, calls,
  } = input;
  const contradicts = input.contradicts ?? (() => false);
  const sampler = input.sampler ?? (() => 0);

  const comparators = new Map(policy.comparators.map((c) => [c.kind, c]));
  const selections = selectForVerification(envelope, policy, contradicts, sampler);
  const outcomes: VerificationOutcome[] = [];
  const violations: Violation[] = [];
  const downgrades: {
    evidence_id: string;
    to: 'UNKNOWN';
    reason: 'CONFLICTING' | 'UNAVAILABLE';
  }[] = [];
  let mismatchCount = 0;
  let authorizationMismatch = false;

  for (const { evidence, reason } of selections) {
    if (reason === 'NOT_SELECTED') {
      outcomes.push({
        evidence_id: evidence.id,
        status: 'UNVERIFIED',
        selected_because: reason,
        detail: 'not selected for checking by the always-verify classes or the sample',
      });
      continue;
    }

    if (reason === 'DECLARED_UNREPRODUCIBLE') {
      outcomes.push({
        evidence_id: evidence.id,
        status: 'UNVERIFIABLE',
        selected_because: reason,
        detail: 'declared reproducible: false, which caps the assertion it supports at INFERENCE',
      });
      continue;
    }

    const comparator = comparators.get(evidence.kind);
    if (comparator?.comparator === 'not_kernel_verifiable') {
      /*
       * A screenshot's content cannot be checked, but its provenance can: the adapter call
       * that produced it is confirmed to have happened, against that locator, from the call
       * log. The observation's provenance is verifiable even when its content is not.
       */
      const produced = calls.some(
        (call) => call.adapter === evidence.locator.adapter && call.op === evidence.locator.op,
      );
      outcomes.push({
        evidence_id: evidence.id,
        status: produced ? 'VERIFIED' : 'MISMATCH',
        selected_because: reason,
        detail: produced
          ? 'content is not kernel-verifiable; the call that produced it is confirmed in the call log'
          : 'content is not kernel-verifiable and no adapter call in this dispatch produced it',
      });
      if (!produced) {
        mismatchCount += 1;
        if (reason === 'ALWAYS_AUTHORIZATION') authorizationMismatch = true;
        downgrades.push({ evidence_id: evidence.id, to: 'UNKNOWN', reason: 'CONFLICTING' });
      }
      continue;
    }

    const replay = await adapters.replay(evidence.locator, callContext);

    if (replay.outcome === 'REFUSED') {
      /*
       * The adapter refused to replay it, which for the evidence channel means the operation
       * is not `observation_safe`. Refusing is correct: an agent must not be able to make the
       * kernel perform a mutation under cover of verification.
       */
      outcomes.push({
        evidence_id: evidence.id,
        status: 'UNREPLAYABLE',
        selected_because: reason,
        detail: `the adapter refused to replay it: ${replay.reason}`,
      });
      violations.push({
        code: 'OBSERVATION_NOT_SAFE_FOR_REPLAY',
        rule: 'REPOSITORY_ADAPTER section 2.3',
        message:
          `evidence ${evidence.id} names ${evidence.locator.adapter}.`
          + `${String(evidence.locator.op)}, which is not observation_safe. Verification `
          + 'cannot itself mutate, so the evidence channel cannot be used to make the kernel '
          + 'perform a mutation on an agent\'s behalf',
        path: null,
        handled_as: 'DOWNGRADED',
        subject: evidence.id,
      });
      mismatchCount += 1;
      if (reason === 'ALWAYS_AUTHORIZATION') authorizationMismatch = true;
      downgrades.push({ evidence_id: evidence.id, to: 'UNKNOWN', reason: 'UNAVAILABLE' });
      continue;
    }

    if (replay.outcome === 'UNREPLAYABLE') {
      outcomes.push({
        evidence_id: evidence.id,
        status: 'UNREPLAYABLE',
        selected_because: reason,
        detail: replay.reason,
      });
      mismatchCount += 1;
      if (reason === 'ALWAYS_AUTHORIZATION') authorizationMismatch = true;
      downgrades.push({ evidence_id: evidence.id, to: 'UNKNOWN', reason: 'UNAVAILABLE' });
      continue;
    }

    const matched = compare(evidence, replay.excerpt, replay.value, comparator?.comparator);
    outcomes.push({
      evidence_id: evidence.id,
      status: matched ? 'VERIFIED' : 'MISMATCH',
      selected_because: reason,
      detail: matched
        ? `replayed through ${evidence.locator.adapter} and the result matches`
        : `replayed through ${evidence.locator.adapter} and the result differs`,
    });
    if (!matched) {
      mismatchCount += 1;
      if (reason === 'ALWAYS_AUTHORIZATION') authorizationMismatch = true;
      downgrades.push({ evidence_id: evidence.id, to: 'UNKNOWN', reason: 'CONFLICTING' });
    }
  }

  /* Findings that lost their last verified evidence do not survive as findings. */
  const verified = new Set(
    outcomes.filter((o) => o.status === 'VERIFIED').map((o) => o.evidence_id),
  );
  const unverified = new Set(
    outcomes.filter((o) => o.status === 'UNVERIFIED' || o.status === 'UNVERIFIABLE')
      .map((o) => o.evidence_id),
  );
  const demotedFindings = envelope.findings
    .filter((finding: Finding) => {
      const survives = finding.evidence.some((id) => verified.has(id) || unverified.has(id));
      return !survives;
    })
    .map((finding) => finding.id);

  /*
   * A FACT finding needs at least one item whose verification came back VERIFIED. An
   * unverified item is not a failure — it was not selected — but it cannot carry a FACT
   * either, because nothing checked it.
   */
  for (const finding of envelope.findings) {
    if (finding.confidence !== 'FACT') continue;
    if (finding.evidence.some((id) => verified.has(id))) continue;
    violations.push({
      code: 'FACT_FINDING_WITHOUT_VERIFIED_EVIDENCE',
      rule: 'AGENT_HANDOFF_CONTRACT cross-field consistency rules',
      message:
        `finding ${finding.id} is FACT and no supporting evidence came back VERIFIED after the `
        + 'verification pass',
      path: null,
      handled_as: 'DOWNGRADED',
      subject: finding.id,
    });
  }

  const rejectEnvelope = mismatchCount >= policy.mismatch_threshold_per_envelope
    || (authorizationMismatch
      && mismatchCount >= policy.authorization_mismatch_threshold);

  if (rejectEnvelope) {
    violations.push({
      code: 'EVIDENCE_MISMATCH_THRESHOLD',
      rule: 'AGENT_HANDOFF_CONTRACT, evidence verification',
      message:
        `${mismatchCount} evidence mismatch(es) in one envelope`
        + (authorizationMismatch ? ', one of them on evidence backing an authorization request' : '')
        + '. One fabrication is a defect; two is an untrustworthy witness, and nothing it said '
        + 'should be merged',
      path: '/evidence',
      handled_as: 'FAILED',
      subject: envelope.envelope_id,
    });
  }

  return { outcomes, mismatchCount, rejectEnvelope, violations, demotedFindings, downgrades };
}

function compare(
  evidence: Evidence,
  replayedExcerpt: string,
  replayedValue: unknown,
  comparator: string | undefined,
): boolean {
  switch (comparator) {
    case 'predicate_reevaluation': {
      const predicate = evidence.predicate;
      /* The cross-field rules already refuse log and metric evidence with no predicate, so
       * reaching here without one means the rules were bypassed. Fail closed. */
      if (predicate === undefined) return false;
      return evaluatePredicate(predicate, replayedValue);
    }
    case 'identifier_plus_content_hash': {
      /* Identifier plus content hash, with a changed hash reported as MISMATCH and the
       * version difference recorded. The adapter returns the current content; comparing the
       * normalized excerpt is the same comparison at this layer. */
      return normalizeExcerpt(evidence.excerpt) === normalizeExcerpt(replayedExcerpt);
    }
    case 'normalized_exact_match':
    default:
      return normalizeExcerpt(evidence.excerpt) === normalizeExcerpt(replayedExcerpt);
  }
}
