import {
  REVIEWING_ROLES,
  assertNever,
  type AgentRole,
  type DodCriterionId,
  type HandoffEnvelope,
  type Stage,
  type TemplateStage,
  type Violation,
  type ViolationCode,
} from '@agentos/contracts';
import type { AgentPolicy, EvidencePolicy } from '@agentos/contracts';

/**
 * The cross-field consistency rules.
 *
 * **Schema conformance is not consistency**, and this file is the difference. A schema can
 * say `blockers` is an array of blockers; only a rule can say that `COMPLETE` with a
 * non-empty `blockers` is a contradiction. Every rule here is checked independently of
 * schema validation, is a contract violation when it fails, and is handled as `BLOCKED` —
 * the kernel never guesses what an agent meant.
 *
 * All of it is model-free. That is the point of step 2 of envelope receipt: it is the first
 * of the four disbelief steps, and the only one that needs nothing but the envelope itself.
 */

export interface DispatchExpectation {
  readonly dispatchId: string;
  readonly stage: Stage;
  readonly agent: AgentRole;
  readonly requiredOutputs: readonly string[];
  readonly dodCriteriaOwed: readonly DodCriterionId[];
  /** The frozen graph's stage set, for the `BLOCKED_BY_ARCHITECTURE` legality rule. */
  readonly graphStages: readonly TemplateStage[];
}

export interface CrossFieldContext {
  readonly expectation: DispatchExpectation;
  readonly agents: AgentPolicy;
  readonly evidence: EvidencePolicy;
  /** Downstream obligation names an `unknowns[].blocks` entry may legally reference. */
  readonly knownObligations: ReadonlySet<string>;
}

function violation(
  code: ViolationCode,
  rule: string,
  message: string,
  path: string | null,
  subject: string | null = null,
  handledAs: Violation['handled_as'] = 'BLOCKED',
): Violation {
  return { code, rule, message, path, handled_as: handledAs, subject };
}

const HANDOFF = 'AGENT_HANDOFF_CONTRACT cross-field consistency rules';
const STATE_MACHINE = 'WORKFLOW_STATE_MACHINE section 4.2';

/**
 * Applies every cross-field rule and returns every violation, not just the first.
 *
 * Returning all of them is deliberate: an envelope with three inconsistencies is a different
 * signal from one with a single slip, and a report that stops at the first hides that.
 */
export function checkCrossFields(
  envelope: HandoffEnvelope,
  context: CrossFieldContext,
): readonly Violation[] {
  const problems: Violation[] = [];
  const { expectation } = context;

  /* --------------------------------------------------------- dispatch identity ---- */

  if (envelope.dispatch_id !== expectation.dispatchId) {
    problems.push(violation(
      'DISPATCH_ID_MISMATCH',
      HANDOFF,
      `the envelope answers dispatch ${envelope.dispatch_id} and this dispatch is `
      + `${expectation.dispatchId}; the reconciliations are per dispatch, so an envelope that `
      + 'does not name its own cannot be reconciled at all',
      '/dispatch_id',
      envelope.envelope_id,
    ));
  }

  if (envelope.stage_in !== expectation.stage) {
    problems.push(violation(
      'STATUS_ILLEGAL_FOR_STAGE',
      HANDOFF,
      `the envelope reports stage ${envelope.stage_in} and the dispatch was in `
      + expectation.stage,
      '/stage_in',
      envelope.envelope_id,
    ));
  }

  if (envelope.agent !== expectation.agent) {
    problems.push(violation(
      'PROPOSAL_NOT_PERMITTED_FOR_ROLE',
      HANDOFF,
      `the envelope reports agent ${envelope.agent} and the dispatch was to `
      + expectation.agent,
      '/agent',
      envelope.envelope_id,
    ));
  }

  /* ------------------------------------------------------------------- status ---- */

  problems.push(...checkStatus(envelope, context));

  /* ------------------------------------------------------------------ outputs ---- */

  const required = new Set(expectation.requiredOutputs);
  const filled = new Set(
    Object.entries(envelope.outputs)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([name]) => name),
  );
  for (const name of Object.keys(envelope.outputs)) {
    if (!required.has(name)) {
      problems.push(violation(
        'OUTPUT_NOT_A_REQUIRED_OUTPUT',
        HANDOFF,
        `outputs names "${name}", which this dispatch did not ask for`,
        `/outputs/${name}`,
        envelope.envelope_id,
      ));
    }
  }
  if (envelope.status === 'COMPLETE') {
    for (const name of expectation.requiredOutputs) {
      if (!filled.has(name)) {
        problems.push(violation(
          'COMPLETE_WITH_UNFILLED_OUTPUT',
          HANDOFF,
          `status COMPLETE with required output "${name}" unfilled; PARTIAL is the honest `
          + 'status for that, and an agent that produced 80% and calls itself COMPLETE has '
          + 'corrupted every downstream decision',
          '/outputs',
          envelope.envelope_id,
        ));
      }
    }
  }

  /* --------------------------------------------------------------- references ---- */

  const evidenceIds = new Set(envelope.evidence.map((e) => e.id));
  for (const [index, finding] of envelope.findings.entries()) {
    for (const id of finding.evidence) {
      if (!evidenceIds.has(id)) {
        problems.push(violation(
          'DANGLING_EVIDENCE_REFERENCE',
          HANDOFF,
          `finding ${finding.id} cites evidence ${id}, which is not in evidence[]; a dangling `
          + 'reference is rejected, not ignored',
          `/findings/${index}/evidence`,
          finding.id,
        ));
      }
    }
  }
  for (const [index, blocker] of envelope.blockers.entries()) {
    for (const id of blocker.evidence) {
      if (!evidenceIds.has(id)) {
        problems.push(violation(
          'DANGLING_EVIDENCE_REFERENCE',
          HANDOFF,
          `blocker ${blocker.id} cites evidence ${id}, which is not in evidence[]`,
          `/blockers/${index}/evidence`,
          blocker.id,
        ));
      }
    }
  }
  for (const [index, verdict] of envelope.dod_verdicts.entries()) {
    for (const id of verdict.evidence) {
      if (!evidenceIds.has(id)) {
        problems.push(violation(
          'DANGLING_EVIDENCE_REFERENCE',
          HANDOFF,
          `the verdict on criterion ${verdict.criterion} cites evidence ${id}, which is not in `
          + 'evidence[]',
          `/dod_verdicts/${index}/evidence`,
          String(verdict.criterion),
        ));
      }
    }
  }
  for (const [index, unknown] of envelope.unknowns.entries()) {
    for (const obligation of unknown.blocks) {
      if (!context.knownObligations.has(obligation)) {
        problems.push(violation(
          'DANGLING_BLOCKS_REFERENCE',
          HANDOFF,
          `unknown ${unknown.id} blocks "${obligation}", which is not a downstream obligation `
          + 'this run has; an unknown that blocks nothing real is decorative rather than '
          + 'actionable',
          `/unknowns/${index}/blocks`,
          unknown.id,
        ));
      }
    }
  }

  /* -------------------------------------------------------------- evidence ---- */

  const comparators = new Map(context.evidence.comparators.map((c) => [c.kind, c]));
  for (const [index, evidence] of envelope.evidence.entries()) {
    if (evidence.verification !== undefined) {
      problems.push(violation(
        'VERIFICATION_PRESENT_ON_ARRIVAL',
        'AGENT_HANDOFF_CONTRACT, evidence',
        `evidence ${evidence.id} arrives with a verification block populated. That field is `
        + 'kernel-owned: an agent cannot mark its own evidence verified, which is the entire '
        + 'point of it',
        `/evidence/${index}/verification`,
        evidence.id,
      ));
    }
    const comparator = comparators.get(evidence.kind);
    if (comparator?.requires_predicate === true && evidence.predicate === undefined) {
      problems.push(violation(
        'PREDICATE_MISSING_ON_LOG_OR_METRIC_EVIDENCE',
        HANDOFF,
        `evidence ${evidence.id} is of kind ${evidence.kind}, which the kernel verifies by `
        + 're-evaluating a predicate rather than by comparing a volatile raw value, and it '
        + 'carries no predicate',
        `/evidence/${index}/predicate`,
        evidence.id,
      ));
    }
    if (evidence.reproducible && evidence.locator.op === null) {
      problems.push(violation(
        'SCHEMA_INVALID',
        'AGENT_HANDOFF_CONTRACT, evidence',
        `evidence ${evidence.id} declares itself reproducible and names no operation to `
        + 'reproduce it with',
        `/evidence/${index}`,
        evidence.id,
      ));
    }
  }

  /* ------------------------------------------------------------- DoD verdicts ---- */

  const owed = new Set<number>(expectation.dodCriteriaOwed);
  for (const [index, verdict] of envelope.dod_verdicts.entries()) {
    if (!owed.has(verdict.criterion)) {
      problems.push(violation(
        'DOD_VERDICT_CRITERION_NOT_OWNED',
        HANDOFF,
        `a verdict on criterion ${verdict.criterion}, which this stage does not own. No agent `
        + 'supplies the verdict on its own work, and that rule is only enforceable if '
        + 'ownership is checked on arrival',
        `/dod_verdicts/${index}`,
        String(verdict.criterion),
      ));
    }
    const needsReason = verdict.verdict === 'NOT_APPLICABLE' || verdict.verdict === 'NOT_VALIDATED';
    if (needsReason && (verdict.reason === null || verdict.reason.trim().length === 0)) {
      problems.push(violation(
        'DOD_VERDICT_MISSING_REASON',
        HANDOFF,
        `criterion ${verdict.criterion} is ${verdict.verdict} with no reason; a criterion set `
        + 'aside without one is a criterion quietly skipped',
        `/dod_verdicts/${index}/reason`,
        String(verdict.criterion),
      ));
    }
    if (verdict.verdict === 'MET' && verdict.evidence.length === 0) {
      problems.push(violation(
        'FACT_FINDING_WITHOUT_VERIFIED_EVIDENCE',
        'DEFINITION_OF_DONE section 4',
        `criterion ${verdict.criterion} is MET with no evidence. Self-assertion is never `
        + 'evidence',
        `/dod_verdicts/${index}/evidence`,
        String(verdict.criterion),
      ));
    }
  }

  /* ------------------------------------------------------------------ coverage ---- */

  if (envelope.coverage.scope_examined.length === 0) {
    problems.push(violation(
      'COVERAGE_MISSING',
      HANDOFF,
      'coverage.scope_examined is empty. An agent that does not state what it examined has '
      + 'not completed its mandate, and coverage is the field separating "found nothing here" '
      + 'from "never looked here"',
      '/coverage/scope_examined',
      envelope.envelope_id,
    ));
  }

  /* --------------------------------------------------------- Product/UX evidence ---- */

  if (envelope.agent === 'product-ux') {
    const anchored = envelope.evidence.filter((e) => e.kind !== 'screenshot');
    const claimsStates = envelope.dod_verdicts.some(
      (v) => (v.criterion === 8 || v.criterion === 14) && v.verdict === 'MET',
    );
    if (claimsStates && anchored.length === 0) {
      problems.push(violation(
        'UX_VERDICT_WITHOUT_CALL_ANCHORED_EVIDENCE',
        HANDOFF,
        'a Product/UX verdict marking criterion 8 or 14 MET on screenshots alone. A '
        + "screenshot's content is not kernel-verifiable, so a claim to have exercised the "
        + 'empty, loading, partial, stale and error states needs at least one call-log-'
        + 'anchored observation as well',
        '/evidence',
        envelope.envelope_id,
      ));
    }
  }

  /* ------------------------------------------------------------------ findings ---- */

  for (const [index, finding] of envelope.findings.entries()) {
    if (finding.evidence.length === 0) {
      problems.push(violation(
        'SCHEMA_INVALID',
        'AGENT_HANDOFF_CONTRACT, findings',
        `finding ${finding.id} carries no evidence. A finding without evidence is not a `
        + 'finding; an unproven suspicion is a recommendation of category hypothesis',
        `/findings/${index}/evidence`,
        finding.id,
      ));
    }
  }
  for (const [index, recommendation] of envelope.recommendations.entries()) {
    if (
      recommendation.category === 'hypothesis'
      && (recommendation.confirming_observation === null
        || recommendation.confirming_observation === undefined
        || recommendation.confirming_observation.trim().length === 0)
    ) {
      problems.push(violation(
        'SCHEMA_INVALID',
        'AGENT_HANDOFF_CONTRACT, findings',
        `recommendation ${recommendation.id} is a hypothesis with no confirming observation. `
        + 'A hypothesis carries the observation that would confirm it, or it is a guess with a '
        + 'label',
        `/recommendations/${index}/confirming_observation`,
        recommendation.id,
      ));
    }
  }

  /* ----------------------------------------------------------------- proposals ---- */

  problems.push(...checkProposals(envelope, context));

  return problems;
}

/**
 * Status legality: which statuses are legal from which stage and role.
 *
 * An envelope carrying a status that is illegal for its stage or role is a contract
 * violation, logged as such and handled as `BLOCKED`.
 */
function checkStatus(
  envelope: HandoffEnvelope,
  context: CrossFieldContext,
): readonly Violation[] {
  const problems: Violation[] = [];
  const { status } = envelope;
  const rolePolicy = context.agents.roles.find((r) => r.role === envelope.agent);

  if (rolePolicy !== undefined && !rolePolicy.may_return_statuses.includes(status)) {
    problems.push(violation(
      status === 'REJECTED' ? 'REJECTED_FROM_NON_REVIEWING_ROLE' : 'STATUS_ILLEGAL_FOR_STAGE',
      'policies/agents.json',
      `${envelope.agent} may not return ${status}`,
      '/status',
      envelope.envelope_id,
    ));
  }

  switch (status) {
    case 'COMPLETE':
      if (envelope.blockers.length > 0) {
        problems.push(violation(
          'COMPLETE_WITH_BLOCKERS',
          HANDOFF,
          `status COMPLETE with ${envelope.blockers.length} blocker(s)`,
          '/blockers',
          envelope.envelope_id,
        ));
      }
      break;

    case 'PARTIAL':
      /* PARTIAL is not a soft COMPLETE, and what is missing must be enumerated. */
      if (envelope.unknowns.length === 0) {
        problems.push(violation(
          'SCHEMA_INVALID',
          'AGENT_HANDOFF_CONTRACT, status values',
          'status PARTIAL with no unknowns. PARTIAL means some was produced and what is '
          + 'missing is enumerated; PARTIAL with nothing enumerated is a soft COMPLETE',
          '/unknowns',
          envelope.envelope_id,
        ));
      }
      break;

    case 'BLOCKED':
      if (envelope.blockers.length === 0) {
        problems.push(violation(
          'BLOCKED_WITHOUT_BLOCKERS',
          HANDOFF,
          'status BLOCKED with no blockers. A blocker must be non-empty and actionable',
          '/blockers',
          envelope.envelope_id,
        ));
      }
      break;

    case 'BLOCKED_BY_ARCHITECTURE': {
      if (envelope.blockers.length === 0) {
        problems.push(violation(
          'BLOCKED_WITHOUT_BLOCKERS',
          HANDOFF,
          'status BLOCKED_BY_ARCHITECTURE with no blockers',
          '/blockers',
          envelope.envelope_id,
        ));
      }
      if (envelope.agent !== 'implementer') {
        problems.push(violation(
          'BLOCKED_BY_ARCHITECTURE_ILLEGAL_ROLE',
          HANDOFF,
          `BLOCKED_BY_ARCHITECTURE from ${envelope.agent}; it is Implementer-specific`,
          '/status',
          envelope.envelope_id,
        ));
      }
      if (envelope.stage_in !== 'IMPLEMENTATION') {
        problems.push(violation(
          'BLOCKED_BY_ARCHITECTURE_ILLEGAL_STAGE',
          HANDOFF,
          `BLOCKED_BY_ARCHITECTURE from stage ${envelope.stage_in}; it is legal only in `
          + 'IMPLEMENTATION',
          '/status',
          envelope.envelope_id,
        ));
      }
      if (!context.expectation.graphStages.includes('ARCHITECTURE')) {
        /*
         * Where the graph has no ARCHITECTURE stage this is not a routing failure, it is the
         * honest outcome for a template that assumed no design work was needed — so it is
         * reported with its own code and handled as BLOCKED with ARCHITECTURE_CONTRADICTION.
         */
        problems.push(violation(
          'BLOCKED_BY_ARCHITECTURE_NO_ARCHITECTURE_STAGE',
          STATE_MACHINE,
          'BLOCKED_BY_ARCHITECTURE in a graph containing no ARCHITECTURE stage; the run blocks '
          + 'with ARCHITECTURE_CONTRADICTION rather than routing somewhere that does not exist',
          '/status',
          envelope.envelope_id,
        ));
      }
      break;
    }

    case 'FAILED':
      /* An agent-level failure, not a finding about the work. Nothing more to check: a
       * FAILED envelope never satisfies an exit condition, which the state machine enforces. */
      break;

    case 'REJECTED':
      if (!REVIEWING_ROLES.includes(envelope.agent as never)) {
        problems.push(violation(
          'REJECTED_FROM_NON_REVIEWING_ROLE',
          HANDOFF,
          `REJECTED from ${envelope.agent}; it is legal only from the Validator or Product/UX`,
          '/status',
          envelope.envelope_id,
        ));
      }
      break;

    default:
      assertNever(status, 'envelope status');
  }

  return problems;
}

/**
 * Proposal legality.
 *
 * Every key in `proposals` is legal only for the role and stage that owns it, and a proposal
 * carrying a decision the kernel reserves is a contract violation. The role and stage tables
 * are policy data, so adding a role's entitlement is a data change and not a kernel change.
 */
function checkProposals(
  envelope: HandoffEnvelope,
  context: CrossFieldContext,
): readonly Violation[] {
  const problems: Violation[] = [];
  const rolePolicy = context.agents.roles.find((r) => r.role === envelope.agent);
  const keys = Object.keys(envelope.proposals);

  for (const key of keys) {
    if (rolePolicy === undefined || !rolePolicy.may_propose.includes(key as never)) {
      problems.push(violation(
        'PROPOSAL_NOT_PERMITTED_FOR_ROLE',
        'policies/agents.json',
        `${envelope.agent} may not make a ${key} proposal`,
        `/proposals/${key}`,
        envelope.envelope_id,
      ));
      continue;
    }
    const stages = rolePolicy.proposal_stages[key] ?? [];
    if (!stages.includes('*') && !stages.includes(envelope.stage_in)) {
      problems.push(violation(
        'PROPOSAL_NOT_PERMITTED_IN_STAGE',
        'policies/agents.json',
        `${envelope.agent} may make a ${key} proposal only in ${stages.join(', ')}, and this `
        + `envelope is from ${envelope.stage_in}`,
        `/proposals/${key}`,
        envelope.envelope_id,
      ));
    }
  }

  /*
   * A proposal that carries a decision the kernel reserves. The schema keeps most of these
   * unexpressible — there is no field for a resolved transition or a granted authorization —
   * and the two that remain expressible are checked here.
   */
  const cancellation = envelope.proposals.cancellation;
  if (cancellation !== undefined && cancellation.evidence.length === 0) {
    problems.push(violation(
      'CANCELLATION_WITHOUT_EVIDENCE',
      'AGENT_HANDOFF_CONTRACT, proposals',
      'a cancellation proposal with no evidence. Cancellation is admitted only if '
      + 'reality.outcome_already_satisfied evaluates TRUE from adapter evidence; "this turned '
      + 'out to be unnecessary" is exactly the claim that should not be self-certified',
      '/proposals/cancellation/evidence',
      cancellation.work_item_id,
    ));
  }

  const workflow = envelope.proposals.workflow;
  if (workflow !== undefined) {
    for (const [index, exclusion] of workflow.exclude_optional.entries()) {
      if (exclusion.claim.trim().length === 0) {
        problems.push(violation(
          'PROPOSAL_RESERVES_KERNEL_DECISION',
          'AGENT_HANDOFF_CONTRACT, proposals',
          `the exclusion of ${exclusion.stage} carries no claim. exclude_optional carries a `
          + 'claim, never a decision: the kernel evaluates the predicate itself',
          `/proposals/workflow/exclude_optional/${index}/claim`,
          exclusion.stage,
        ));
      }
    }
  }

  return problems;
}
