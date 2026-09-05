import {
  validators,
  formatErrors,
  type AdapterCallContext,
  type AdapterRegistry,
  type Assertion,
  type CallRecord,
  type CheckOutcome,
  type Clock,
  type Evidence,
  type EvidencePolicy,
  type Finding,
  type HandoffEnvelope,
  type MutationEvent,
  type ReceiptStep,
  type Recommendation,
  type ToolGrant,
  type Violation,
} from '@agentos/contracts';
import type { AgentPolicy } from '@agentos/contracts';
import { checkCrossFields, type CrossFieldContext, type DispatchExpectation } from './crossfield.js';
import { reconcile } from './reconciliation.js';
import { verifyEvidence, type VerificationReport } from './evidence-verification.js';
import { detectConflicts, resolveByRule, type Conflict, type RuleResolution } from './arbitration.js';

/**
 * Envelope receipt — the eight steps, in order, with later steps not running when an
 * earlier one rejects.
 *
 * 1. Schema. A schema failure is an agent failure.
 * 2. Cross-field consistency rules.
 * 3. Reconcile `artifacts_changed` against the mutation events, and `coverage` against the
 *    adapter call log.
 * 4. Verify evidence per the verification policy, downgrading or rejecting as specified.
 * 5. Reject a `next_action` that is not a legal transition, and evaluate the transition's
 *    predicate rather than accepting the agent's claim.
 * 6. Persist the envelope immutably, including the verification results the kernel added.
 * 7. Merge surviving findings, capability updates, unknowns and assumptions into run state.
 * 8. Cross-check new assertions against existing ones and raise a conflict for arbitration.
 *
 * **Steps 2 through 5 are the kernel's disbelief machinery. Everything an agent says is a
 * claim until one of them passes it.** Step 5 is performed by the state machine and step 6
 * by the store, so this module runs 1 to 4 and 8 and reports what 5 to 7 should do — which
 * keeps the ordering in one place without giving one module the store, the graph and the
 * adapters all at once.
 */

export interface ReceiptInput {
  readonly raw: unknown;
  readonly expectation: DispatchExpectation;
  readonly agents: AgentPolicy;
  readonly evidencePolicy: EvidencePolicy;
  readonly adapters: AdapterRegistry;
  readonly callContext: AdapterCallContext;
  readonly clock: Clock;
  /** Mutation events recorded for this dispatch, in order. */
  readonly mutations: readonly MutationEvent[];
  /** Adapter calls recorded for this dispatch, reads included. */
  readonly calls: readonly CallRecord[];
  /**
   * The adapter operations the kernel exposed to this dispatch, for step 3.
   *
   * An empty set is a dispatch that could not have touched anything, which the coverage
   * reconciliation has to be able to tell apart from a dispatch that held tools and used none.
   */
  readonly grantedTools: readonly ToolGrant[];
  /** Downstream obligations an `unknowns[].blocks` entry may reference. */
  readonly knownObligations: ReadonlySet<string>;
  /** Assertions already in run state, for step 8. */
  readonly existingAssertions: ReadonlyMap<string, { readonly assertion: Assertion; readonly source: string }>;
  /** Assertions the envelope makes, extracted by the caller from its proposals and outputs. */
  readonly incomingAssertions: ReadonlyMap<string, Assertion>;
  readonly sampler?: () => number;
}

export type ReceiptResult =
  | {
    readonly outcome: 'REJECTED';
    /** Which step rejected it. Later steps did not run. */
    readonly step: ReceiptStep;
    readonly violations: readonly Violation[];
    readonly steps: readonly CheckOutcome[];
    /**
     * A malformed envelope is a `FAILED` dispatch, never a parse-and-repair. Every other
     * rejection is a contract violation handled as `BLOCKED`.
     */
    readonly handleAs: 'FAILED' | 'BLOCKED';
  }
  | {
    readonly outcome: 'ACCEPTED';
    readonly envelope: HandoffEnvelope;
    readonly steps: readonly CheckOutcome[];
    readonly verification: VerificationReport;
    /** Findings that survived, with those that lost their evidence demoted. */
    readonly findings: readonly Finding[];
    readonly demotedToRecommendations: readonly Recommendation[];
    readonly conflicts: readonly { readonly conflict: Conflict; readonly resolution: RuleResolution }[];
    /** Violations that downgraded something rather than rejecting the envelope. */
    readonly downgrades: readonly Violation[];
  };

export async function receiveEnvelope(input: ReceiptInput): Promise<ReceiptResult> {
  const steps: CheckOutcome[] = [];

  /* ------------------------------------------------------------ 1. schema ---- */

  const schema = validators.handoffEnvelope.check(input.raw);
  if (!schema.valid) {
    steps.push({
      check: 'schema',
      result: 'FAIL',
      detail: formatErrors(schema.errors),
    });
    return {
      outcome: 'REJECTED',
      step: 'schema',
      handleAs: 'FAILED',
      steps,
      violations: [{
        code: 'SCHEMA_INVALID',
        rule: 'AGENT_HANDOFF_CONTRACT, kernel enforcement step 1',
        message:
          'the envelope does not satisfy its schema. A malformed envelope is a FAILED '
          + `dispatch, never a parse-and-repair: the kernel does not guess what an agent `
          + `meant.\n${formatErrors(schema.errors)}`,
        path: null,
        handled_as: 'FAILED',
        subject: null,
      }],
    };
  }
  const envelope = input.raw as HandoffEnvelope;
  steps.push({ check: 'schema', result: 'PASS', detail: 'conforms to HandoffEnvelope 1.2' });

  /* ------------------------------------------------------- 2. cross-field ---- */

  const crossFieldContext: CrossFieldContext = {
    expectation: input.expectation,
    agents: input.agents,
    evidence: input.evidencePolicy,
    knownObligations: input.knownObligations,
  };
  const crossField = checkCrossFields(envelope, crossFieldContext);
  if (crossField.length > 0) {
    steps.push({
      check: 'cross_field',
      result: 'FAIL',
      detail: crossField.map((v) => `${v.code}: ${v.message}`).join(' | '),
    });
    return {
      outcome: 'REJECTED',
      step: 'cross_field',
      handleAs: 'BLOCKED',
      steps,
      violations: crossField,
    };
  }
  steps.push({
    check: 'cross_field',
    result: 'PASS',
    detail: 'schema conformance is not consistency, and the consistency rules hold',
  });

  /* ----------------------------------------------------- 3. reconciliation ---- */

  const reconciliation = reconcile({
    envelope,
    mutations: input.mutations,
    calls: input.calls,
    grantedTools: input.grantedTools,
  });
  if (reconciliation.violations.length > 0) {
    steps.push({
      check: 'reconciliation',
      result: 'FAIL',
      detail: reconciliation.violations.map((v) => `${v.code}: ${v.message}`).join(' | '),
    });
    return {
      outcome: 'REJECTED',
      step: 'reconciliation',
      handleAs: 'BLOCKED',
      steps,
      violations: reconciliation.violations,
    };
  }
  steps.push({
    check: 'reconciliation',
    /*
     * A coverage claim the call log cannot answer is neither supported nor overstated. It is
     * reported as INDETERMINATE rather than PASS so the gap is visible: silently passing a
     * capability-shaped claim nothing could check would leave the field that distinguishes
     * "found nothing there" from "never looked there" as the one nobody verified.
     */
    result: reconciliation.unreconciledScope.length === 0 ? 'PASS' : 'INDETERMINATE',
    detail:
      `${input.mutations.length} mutation event(s) and ${input.calls.length} adapter call(s) `
      + 'account for what was declared, in both directions'
      + (reconciliation.unreconciledScope.length === 0
        ? ''
        : `. ${reconciliation.unreconciledScope.join(', ')} cannot be answered by the call log `
          + (input.grantedTools.length === 0
            ? 'because the kernel granted this dispatch no adapter operation at all, so nothing '
              + 'it claims to have examined could have been touched'
            : 'because they name capabilities and no call in this dispatch carried any '
              + 'capabilities_touched to reconcile them against')
          + ', so they are unreconciled rather than accepted'),
  });

  /* -------------------------------------------------------- 4. verification ---- */

  const existingValues = new Map<string, unknown>();
  for (const [subject, held] of input.existingAssertions) {
    if (held.assertion.confidence === 'UNKNOWN') continue;
    existingValues.set(subject, held.assertion.value);
  }
  const contradicts = (evidence: Evidence): boolean => {
    /*
     * An item supporting a FACT that contradicts existing run state is always verified. This
     * is the case where believing the wrong one corrupts the run, so it is the case where
     * neither is taken on trust.
     */
    for (const [subject, incoming] of input.incomingAssertions) {
      if (incoming.confidence !== 'FACT') continue;
      const ids = incoming.evidence.map((r) => (typeof r === 'string' ? r : r.id));
      if (!ids.includes(evidence.id)) continue;
      if (!existingValues.has(subject)) continue;
      if (JSON.stringify(existingValues.get(subject)) !== JSON.stringify(incoming.value)) {
        return true;
      }
    }
    return false;
  };

  const verification = await verifyEvidence({
    envelope,
    policy: input.evidencePolicy,
    adapters: input.adapters,
    callContext: input.callContext,
    clock: input.clock,
    calls: input.calls,
    contradicts,
    sampler: input.sampler,
  });

  if (verification.rejectEnvelope) {
    steps.push({
      check: 'evidence_verification',
      result: 'FAIL',
      detail:
        `${verification.mismatchCount} mismatch(es). One fabrication is a defect; two is an `
        + 'untrustworthy witness, and nothing it said should be merged',
    });
    return {
      outcome: 'REJECTED',
      step: 'evidence_verification',
      handleAs: 'FAILED',
      steps,
      violations: verification.violations,
    };
  }
  steps.push({
    check: 'evidence_verification',
    result: verification.mismatchCount === 0 ? 'PASS' : 'INDETERMINATE',
    detail:
      `${verification.outcomes.filter((o) => o.status === 'VERIFIED').length} verified, `
      + `${verification.mismatchCount} mismatched, `
      + `${verification.outcomes.filter((o) => o.status === 'UNVERIFIED').length} not selected`,
  });

  /* -------------------------- findings that lost their last verified evidence ---- */

  const demoted = new Set(verification.demotedFindings);
  const findings = envelope.findings.filter((finding) => !demoted.has(finding.id));
  const demotedToRecommendations: Recommendation[] = envelope.findings
    .filter((finding) => demoted.has(finding.id))
    .map((finding) => ({
      id: `${finding.id}-hypothesis`,
      category: 'hypothesis' as const,
      statement: finding.title,
      priority: finding.severity,
      rationale:
        `demoted from a finding: every supporting evidence item failed verification. A finding `
        + 'without evidence is not a finding, and an unproven suspicion is a hypothesis',
      owner_role: null,
      confirming_observation:
        finding.remediation_hint ?? 'replay the evidence this finding rested on',
      evidence: finding.evidence,
    }));

  /* --------------------------------------------------- 8. conflict detection ---- */

  const conflicts = detectConflicts({
    existing: input.existingAssertions,
    envelope,
    incoming: input.incomingAssertions,
  }).map((conflict) => ({ conflict, resolution: resolveByRule(conflict) }));

  steps.push({
    check: 'conflict_check',
    result: conflicts.length === 0 ? 'PASS' : 'INDETERMINATE',
    detail: conflicts.length === 0
      ? 'no new assertion is incompatible with one already in run state'
      : `${conflicts.length} conflict(s); `
        + `${conflicts.filter((c) => c.resolution.phase === 'RESOLVED_BY_RULE').length} died `
        + 'at the confidence-class rule with no model involved',
  });

  return {
    outcome: 'ACCEPTED',
    envelope,
    steps,
    verification,
    findings,
    demotedToRecommendations,
    conflicts,
    downgrades: verification.violations,
  };
}

/**
 * Writes the kernel's verification results onto the envelope before it is persisted.
 *
 * `verification` is kernel-owned, and this is the only place it is ever written. Persisting
 * the envelope *with* the results is what makes the audit trail complete: a reader sees both
 * what the agent claimed and what the kernel found when it checked.
 */
export function withVerification(
  envelope: HandoffEnvelope,
  verification: VerificationReport,
  at: string,
): HandoffEnvelope {
  const byId = new Map(verification.outcomes.map((o) => [o.evidence_id, o]));
  return {
    ...envelope,
    evidence: envelope.evidence.map((evidence) => {
      const outcome = byId.get(evidence.id);
      if (outcome === undefined) return evidence;
      return {
        ...evidence,
        verification: {
          status: outcome.status,
          at,
          by: 'kernel' as const,
          matches: outcome.status === 'VERIFIED'
            ? true
            : outcome.status === 'MISMATCH' ? false : null,
          detail: outcome.detail,
        },
      };
    }),
  };
}
