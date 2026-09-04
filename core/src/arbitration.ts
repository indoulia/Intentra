import type {
  ArbitrationProposal,
  Assertion,
  ConfidenceClass,
  ConflictPosition,
  Finding,
  HandoffEnvelope,
} from '@agentos/contracts';

/**
 * Conflict detection and arbitration's kernel half.
 *
 * Arbitration spans the boundary, so it is split explicitly. The kernel **detects** the
 * conflict — mechanical — and **classifies by rule where it can**: where two assertions
 * differ in confidence class, `FACT` beats `INFERENCE` beats `UNKNOWN`, with no model
 * involved. Most conflicts die there. What survives goes to the Orchestrator Agent, and the
 * kernel then **executes** the resolution and **records** the decision, the losing position
 * and the evidence.
 *
 * The kernel never decides *who is right* on the merits. The agent never decides *what
 * happens next*.
 *
 * Three anti-rules, held here because they are the tempting shortcuts: never resolve by
 * model tier, never average two designs into a third nobody proposed, never let the most
 * recent envelope win by recency.
 */

export interface Conflict {
  readonly conflictId: string;
  /** What the two positions disagree about. Mechanical: the same subject, incompatibly. */
  readonly subject: string;
  readonly positionA: ConflictPosition;
  readonly positionB: ConflictPosition;
}

export interface DetectionInput {
  /** Assertions already merged into run state, by subject. */
  readonly existing: ReadonlyMap<string, { readonly assertion: Assertion; readonly source: string }>;
  /** The envelope being received. */
  readonly envelope: HandoffEnvelope;
  /** Assertion subjects the envelope makes claims about, extracted by the caller. */
  readonly incoming: ReadonlyMap<string, Assertion>;
}

const RANK: Readonly<Record<ConfidenceClass, number>> = {
  FACT: 3,
  INFERENCE: 2,
  UNKNOWN: 1,
};

/** Are two assertions about one subject incompatible? Mechanical, and deliberately narrow. */
export function incompatible(a: Assertion, b: Assertion): boolean {
  /* Neither knows: not a conflict, a shared gap. */
  if (a.confidence === 'UNKNOWN' && b.confidence === 'UNKNOWN') return false;
  /* One knows and one does not: not a conflict either. The confidence rule settles it
   * without anyone having disagreed. */
  if (a.confidence === 'UNKNOWN' || b.confidence === 'UNKNOWN') return false;
  return JSON.stringify(a.value) !== JSON.stringify(b.value);
}

export function detectConflicts(input: DetectionInput): readonly Conflict[] {
  const conflicts: Conflict[] = [];
  let counter = 0;
  for (const [subject, assertion] of input.incoming) {
    const existing = input.existing.get(subject);
    if (existing === undefined) continue;
    if (!incompatible(existing.assertion, assertion)) continue;
    counter += 1;
    conflicts.push({
      conflictId: `cf_${input.envelope.envelope_id}_${String(counter).padStart(2, '0')}`,
      subject,
      positionA: {
        source: existing.source,
        claim: JSON.stringify(existing.assertion.value),
        confidence: existing.assertion.confidence,
        evidence: evidenceIds(existing.assertion),
      },
      positionB: {
        source: input.envelope.agent,
        claim: JSON.stringify(assertion.value),
        confidence: assertion.confidence,
        evidence: evidenceIds(assertion),
      },
    });
  }
  return conflicts;
}

function evidenceIds(assertion: Assertion): readonly string[] {
  if (assertion.confidence === 'UNKNOWN') return [];
  const references = assertion.confidence === 'FACT'
    ? assertion.evidence
    : (assertion.evidence ?? []);
  return references.map((reference) =>
    typeof reference === 'string' ? reference : reference.id);
}

export type RuleResolution =
  | {
    readonly phase: 'RESOLVED_BY_RULE';
    readonly winner: 'A' | 'B';
    readonly rule: string;
    readonly detail: string;
  }
  | {
    readonly phase: 'DELEGATED';
    readonly winner: 'NONE';
    readonly rule: null;
    readonly detail: string;
  };

/**
 * Step 3 of arbitration: classify by rule where possible.
 *
 * `FACT` beats `INFERENCE` beats `UNKNOWN`, decided by the kernel with no model involved.
 * Where the classes are equal there is no rule, and the conflict is delegated on the merits —
 * **not** resolved by whichever envelope arrived later, and **not** by which model was more
 * expensive.
 */
export function resolveByRule(conflict: Conflict): RuleResolution {
  const rankA = RANK[conflict.positionA.confidence];
  const rankB = RANK[conflict.positionB.confidence];
  if (rankA > rankB) {
    return {
      phase: 'RESOLVED_BY_RULE',
      winner: 'A',
      rule: `${conflict.positionA.confidence} beats ${conflict.positionB.confidence}`,
      detail: 'settled by confidence class with no model involved. Most conflicts die here',
    };
  }
  if (rankB > rankA) {
    return {
      phase: 'RESOLVED_BY_RULE',
      winner: 'B',
      rule: `${conflict.positionB.confidence} beats ${conflict.positionA.confidence}`,
      detail: 'settled by confidence class with no model involved',
    };
  }
  return {
    phase: 'DELEGATED',
    winner: 'NONE',
    rule: null,
    detail:
      `both positions are ${conflict.positionA.confidence}, so no rule selects a winner. The `
      + 'Orchestrator Agent resolves it on the merits: a factual conflict by naming the '
      + 'discriminating observation, an interpretive one by applying policy and DoD',
  };
}

export type ExecutedResolution =
  | {
    /** A factual conflict with a named observation. The kernel dispatches the probe. */
    readonly action: 'DISCOVER';
    readonly observation: string;
    readonly detail: string;
  }
  | {
    readonly action: 'ACCEPT';
    readonly winner: 'A' | 'B';
    readonly detail: string;
  }
  | {
    /** The agent said it cannot settle it. The kernel escalates with both positions stated. */
    readonly action: 'ESCALATE';
    readonly detail: string;
  };

/**
 * Step 4: execute the resolution the Orchestrator proposed.
 *
 * The agent's proposal is a proposal here as everywhere. A factual classification with a
 * named observation is the cheapest and most common path and the kernel dispatches it; an
 * interpretive one the agent could settle is accepted; `CANNOT_SETTLE` escalates to a human
 * with both positions stated fairly.
 */
export function executeResolution(
  proposal: ArbitrationProposal,
): ExecutedResolution {
  if (proposal.resolution === 'CANNOT_SETTLE') {
    return {
      action: 'ESCALATE',
      detail:
        `the Orchestrator cannot settle it: ${proposal.rationale}. It escalates to a human `
        + 'with both positions stated fairly',
    };
  }
  if (
    proposal.classification === 'FACTUAL'
    && proposal.discriminating_observation !== null
    && proposal.discriminating_observation.trim().length > 0
  ) {
    return {
      action: 'DISCOVER',
      observation: proposal.discriminating_observation,
      detail:
        'a factual conflict with a named discriminating observation. The kernel dispatches a '
        + 'narrow probe and decides by result, which is the cheapest and most common path',
    };
  }
  return {
    action: 'ACCEPT',
    winner: proposal.resolution,
    detail:
      `${proposal.classification.toLowerCase()} conflict resolved on the merits: `
      + proposal.rationale,
  };
}

/**
 * Whether a Validator failure may be overruled.
 *
 * It may not. "Does not overrule a Validator failure by reasoning; only new evidence clears
 * a failure." So the answer depends on nothing but whether new evidence arrived.
 */
export function mayClearValidationFailure(
  failure: Finding,
  newEvidenceIds: readonly string[],
): { readonly cleared: boolean; readonly reason: string } {
  const original = new Set(failure.evidence);
  const genuinelyNew = newEvidenceIds.filter((id) => !original.has(id));
  if (genuinelyNew.length === 0) {
    return {
      cleared: false,
      reason:
        `${failure.id} cites the same evidence it did before. Only new evidence clears a `
        + 'Validator failure; reasoning does not',
    };
  }
  return {
    cleared: true,
    reason: `${genuinelyNew.length} new evidence item(s) bear on ${failure.id}`,
  };
}
