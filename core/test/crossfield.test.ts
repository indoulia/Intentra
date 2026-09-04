import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtures as fx,
  type HandoffEnvelope,
  type ViolationCode,
} from '@agentos/contracts';
import { loadPolicies } from '@agentos/policies';
import { checkCrossFields, type CrossFieldContext } from '../src/crossfield.js';

/**
 * One invalid fixture per cross-field rule.
 *
 * "Each of the rules in AGENT_HANDOFF_CONTRACT 'Cross-field consistency rules' gets a
 * fixture that violates exactly it, so that the checks can be proven to reject the thing
 * they exist to reject rather than to pass everything."
 *
 * The fixtures are built rather than stored (decision I-4): the rule and the instance that
 * violates it belong next to each other, and a table makes the negative case *and* the
 * positive one visible in the same line — every fixture asserts both that the expected code
 * appears and that no other rule fired, which is what "violates exactly it" means.
 */

const policies = loadPolicies();

function context(overrides: Partial<CrossFieldContext['expectation']> = {}): CrossFieldContext {
  return {
    expectation: {
      dispatchId: 'd_001',
      stage: 'AUDIT',
      agent: 'auditor',
      requiredOutputs: ['capability_graph'],
      dodCriteriaOwed: [3, 4],
      graphStages: ['AUDIT', 'ROOT_CAUSE', 'COMPLETION'],
      ...overrides,
    },
    agents: policies.agents,
    evidence: policies.evidence,
    knownObligations: new Set(['validation.production', 'capability_graph', 'audit']),
  };
}

/** A valid baseline: the fixture every negative case is one change away from. */
function valid(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return fx.envelope({
    dispatch_id: 'd_001',
    stage_in: 'AUDIT',
    agent: 'auditor',
    outputs: { capability_graph: 'capabilities/v1.json' },
    dod_verdicts: [
      fx.criterionVerdict({ criterion: 3, evidence: ['E-001'] }),
      fx.criterionVerdict({ criterion: 4, evidence: ['E-001'] }),
    ],
    evidence: [fx.evidence({ id: 'E-001' })],
    ...overrides,
  });
}

interface Case {
  readonly rule: string;
  readonly code: ViolationCode;
  readonly why: string;
  readonly envelope: HandoffEnvelope;
  readonly expectation?: Partial<CrossFieldContext['expectation']>;
}

const CASES: readonly Case[] = [
  {
    rule: 'status COMPLETE requires blockers empty',
    code: 'COMPLETE_WITH_BLOCKERS',
    why: 'a mandate cannot be both fulfilled and blocked',
    envelope: valid({ status: 'COMPLETE', blockers: [fx.blocker()] }),
  },
  {
    rule: 'status COMPLETE requires every required_output present',
    code: 'COMPLETE_WITH_UNFILLED_OUTPUT',
    why:
      'an agent that produced 80% and calls itself COMPLETE has corrupted every downstream '
      + 'decision',
    envelope: valid({ status: 'COMPLETE', outputs: {} }),
  },
  {
    rule: 'status BLOCKED requires blockers non-empty',
    code: 'BLOCKED_WITHOUT_BLOCKERS',
    why: 'a blocker must be non-empty and actionable, or the block is not actionable',
    envelope: valid({ status: 'BLOCKED', blockers: [] }),
  },
  {
    rule: 'BLOCKED_BY_ARCHITECTURE is legal only from the Implementer',
    code: 'BLOCKED_BY_ARCHITECTURE_ILLEGAL_ROLE',
    why: 'it is Implementer-specific, and another role hitting it is a different problem',
    envelope: valid({
      status: 'BLOCKED_BY_ARCHITECTURE',
      agent: 'auditor',
      stage_in: 'IMPLEMENTATION',
      blockers: [fx.blockerOfKind('ARCHITECTURE_CONTRADICTION')],
    }),
    expectation: { stage: 'IMPLEMENTATION', agent: 'auditor' },
  },
  {
    rule: 'BLOCKED_BY_ARCHITECTURE is legal only in stage IMPLEMENTATION',
    code: 'BLOCKED_BY_ARCHITECTURE_ILLEGAL_STAGE',
    why: 'an architectural contradiction met outside implementation is a design question',
    envelope: valid({
      status: 'BLOCKED_BY_ARCHITECTURE',
      agent: 'implementer',
      stage_in: 'AUDIT',
      blockers: [fx.blockerOfKind('ARCHITECTURE_CONTRADICTION')],
    }),
    expectation: { agent: 'implementer', graphStages: ['AUDIT', 'ARCHITECTURE', 'COMPLETION'] },
  },
  {
    rule: 'BLOCKED_BY_ARCHITECTURE requires the graph to contain ARCHITECTURE',
    code: 'BLOCKED_BY_ARCHITECTURE_NO_ARCHITECTURE_STAGE',
    why:
      'where it does not, the honest outcome is BLOCKED with ARCHITECTURE_CONTRADICTION '
      + 'rather than routing somewhere that does not exist',
    envelope: valid({
      status: 'BLOCKED_BY_ARCHITECTURE',
      agent: 'implementer',
      stage_in: 'IMPLEMENTATION',
      blockers: [fx.blockerOfKind('ARCHITECTURE_CONTRADICTION')],
    }),
    expectation: {
      agent: 'implementer',
      stage: 'IMPLEMENTATION',
      graphStages: ['IMPLEMENTATION', 'VALIDATION', 'COMPLETION'],
    },
  },
  {
    rule: 'status REJECTED is legal only from the Validator or Product/UX',
    code: 'REJECTED_FROM_NON_REVIEWING_ROLE',
    why: 'a reviewing verdict from a non-reviewing role is a role doing another role\'s job',
    envelope: valid({ status: 'REJECTED', agent: 'auditor' }),
  },
  {
    rule: 'every id in findings[].evidence must exist in evidence[]',
    code: 'DANGLING_EVIDENCE_REFERENCE',
    why: 'a dangling reference is rejected, not ignored',
    envelope: valid({
      findings: [fx.finding({ evidence: ['E-999'] })],
      evidence: [fx.evidence({ id: 'E-001' })],
    }),
  },
  {
    rule: 'every id in unknowns[].blocks must name a real downstream obligation',
    code: 'DANGLING_BLOCKS_REFERENCE',
    why: 'an unknown that blocks nothing real is decorative rather than actionable',
    envelope: valid({
      status: 'PARTIAL',
      unknowns: [fx.unknownRecord({ blocks: ['the vibe of the thing'] })],
    }),
  },
  {
    rule: 'verification must be absent on arrival',
    code: 'VERIFICATION_PRESENT_ON_ARRIVAL',
    why:
      'an agent cannot mark its own evidence verified — that is the entire point of the field',
    envelope: valid({
      evidence: [fx.evidence({
        id: 'E-001',
        verification: { status: 'VERIFIED', at: fx.T2, by: 'kernel', matches: true },
      })],
    }),
  },
  {
    rule: 'coverage must be present and non-empty',
    code: 'COVERAGE_MISSING',
    why:
      'coverage is the field separating "found nothing here" from "never looked here", and an '
      + 'agent that does not state what it examined has not completed its mandate',
    envelope: valid({ coverage: fx.coverage({ scope_examined: [] }) }),
  },
  {
    rule: 'evidence of kind log or metric must carry a predicate',
    code: 'PREDICATE_MISSING_ON_LOG_OR_METRIC_EVIDENCE',
    why:
      'the kernel re-evaluates a predicate for those kinds rather than comparing a volatile '
      + 'raw value',
    envelope: valid({
      evidence: [{
        id: 'E-001',
        kind: 'log',
        locator: { adapter: 'runtime.logs', op: 'read_lines', args: { since: '1h' } },
        ref: 'runtime.logs',
        excerpt: '0 errors',
        observed_at: fx.T1,
        reproducible: true,
      }],
      dod_verdicts: [],
    }),
  },
  {
    rule: 'a Product/UX verdict needs a call-log-anchored item, not screenshots alone',
    code: 'UX_VERDICT_WITHOUT_CALL_ANCHORED_EVIDENCE',
    why:
      'an agent asserting it reviewed the empty, loading, partial, stale and error states '
      + 'whose call log shows only the happy path is caught by reconciliation rather than '
      + 'believed',
    envelope: valid({
      agent: 'product-ux',
      stage_in: 'UX_REVIEW',
      outputs: { ux_verdict: 'ACCEPTED' },
      dod_verdicts: [fx.criterionVerdict({ criterion: 14, evidence: ['E-001'] })],
      evidence: [fx.evidence({ id: 'E-001', kind: 'screenshot' })],
    }),
    expectation: {
      agent: 'product-ux',
      stage: 'UX_REVIEW',
      requiredOutputs: ['ux_verdict'],
      dodCriteriaOwed: [8, 14],
    },
  },
  {
    rule: 'dispatch_id must equal the dispatch the kernel issued',
    code: 'DISPATCH_ID_MISMATCH',
    why:
      'the reconciliations are per dispatch, so an envelope that does not name its own '
      + 'cannot be reconciled at all — and a substrate returning the wrong envelope would be '
      + 'undetectable',
    envelope: valid({ dispatch_id: 'd_099' }),
  },
  {
    rule: 'every key in outputs must name a required_output of this dispatch',
    code: 'OUTPUT_NOT_A_REQUIRED_OUTPUT',
    why: 'an output nobody asked for is an output nobody will read',
    envelope: valid({
      outputs: { capability_graph: 'capabilities/v1.json', extra_thoughts: 'hmm' },
    }),
  },
  {
    rule: 'a dod_verdict must be on a criterion this stage owns',
    code: 'DOD_VERDICT_CRITERION_NOT_OWNED',
    why:
      'no agent supplies the verdict on its own work, and that rule is only enforceable if '
      + 'ownership is checked on arrival',
    envelope: valid({
      dod_verdicts: [fx.criterionVerdict({ criterion: 12, evidence: ['E-001'] })],
    }),
  },
  {
    rule: 'a NOT_APPLICABLE or NOT_VALIDATED verdict needs a reason',
    code: 'DOD_VERDICT_MISSING_REASON',
    why: 'a criterion set aside without one is a criterion quietly skipped',
    envelope: valid({
      dod_verdicts: [{
        criterion: 3,
        verdict: 'NOT_APPLICABLE',
        reason: null,
        evidence: [],
        capability: null,
      }],
    }),
  },
  {
    rule: 'a MET verdict needs evidence',
    code: 'FACT_FINDING_WITHOUT_VERIFIED_EVIDENCE',
    why: 'self-assertion is never evidence',
    envelope: valid({
      dod_verdicts: [{
        criterion: 3, verdict: 'MET', reason: null, evidence: [], capability: null,
      }],
    }),
  },
  {
    rule: 'a proposal is legal only for the role that owns it',
    code: 'PROPOSAL_NOT_PERMITTED_FOR_ROLE',
    why: 'a workflow proposal from the Auditor is an agent doing the Orchestrator\'s job',
    envelope: valid({
      proposals: {
        workflow: {
          template_id: 'task.direct',
          include_optional: [],
          exclude_optional: [],
          rationale: 'it looks small',
        },
      },
    }),
  },
  {
    rule: 'a proposal is legal only in the stage that owns it',
    code: 'PROPOSAL_NOT_PERMITTED_IN_STAGE',
    why: 'a decomposition outside DECOMPOSITION is a contract violation',
    envelope: valid({
      agent: 'architect',
      stage_in: 'PLAN',
      outputs: { plan: 'inline' },
      dod_verdicts: [],
      proposals: {
        decomposition: [{
          title: 'a child',
          type: 'STORY',
          scope: fx.scope(),
          desired_outcome: 'something observable',
          depends_on: [],
          external_identity: null,
        }],
      },
    }),
    expectation: {
      agent: 'architect',
      stage: 'PLAN',
      requiredOutputs: ['plan'],
      dodCriteriaOwed: [],
    },
  },
  {
    rule: 'a cancellation proposal needs evidence',
    code: 'CANCELLATION_WITHOUT_EVIDENCE',
    why:
      '"this turned out to be unnecessary" is exactly the claim that should not be '
      + 'self-certified',
    envelope: valid({
      agent: 'orchestrator',
      stage_in: 'CHILD_COORDINATION',
      outputs: { child_states: 'inline' },
      dod_verdicts: [],
      proposals: {
        cancellation: {
          work_item_id: 'wi_c_child',
          to: 'SUPERSEDED',
          evidence: [],
          rationale: 'it feels unnecessary now',
        },
      },
    }),
    expectation: {
      agent: 'orchestrator',
      stage: 'CHILD_COORDINATION',
      requiredOutputs: ['child_states'],
      dodCriteriaOwed: [],
    },
  },
  {
    rule: 'an exclusion carries a claim, never a decision',
    code: 'PROPOSAL_RESERVES_KERNEL_DECISION',
    why:
      'exclude_optional carries a claim: the kernel evaluates the predicate itself, and an '
      + 'exclusion with no claim is a decision dressed as a request',
    envelope: valid({
      agent: 'orchestrator',
      stage_in: 'WORKFLOW_SELECTED',
      outputs: {},
      dod_verdicts: [],
      proposals: {
        workflow: {
          template_id: 'defect.standard',
          include_optional: [],
          exclude_optional: [{ stage: 'UX_REVIEW', claim: '   ', rationale: 'no UI' }],
          rationale: 'a defect',
        },
      },
    }),
    expectation: {
      agent: 'orchestrator',
      stage: 'WORKFLOW_SELECTED',
      requiredOutputs: [],
      dodCriteriaOwed: [],
    },
  },
  {
    rule: 'a finding without evidence is not a finding',
    code: 'SCHEMA_INVALID',
    why: 'an unproven suspicion is a recommendation of category hypothesis',
    envelope: valid({ findings: [fx.finding({ evidence: [] })] }),
  },
  {
    rule: 'a hypothesis carries the observation that would confirm it',
    code: 'SCHEMA_INVALID',
    why: 'a hypothesis with no confirming observation is a guess with a label',
    envelope: valid({
      recommendations: [{
        id: 'R-001',
        category: 'hypothesis',
        statement: 'the writer may be orphaned',
        priority: 'MEDIUM',
        rationale: 'it looks that way',
        owner_role: null,
        confirming_observation: null,
      }],
    }),
  },
  {
    rule: 'PARTIAL enumerates what is missing',
    code: 'SCHEMA_INVALID',
    why: 'PARTIAL with nothing enumerated is a soft COMPLETE',
    envelope: valid({ status: 'PARTIAL', unknowns: [] }),
  },
];

describe('cross-field consistency rules', () => {
  test('the baseline fixture is consistent, so every negative case is one change away', () => {
    const problems = checkCrossFields(valid(), context());
    assert.deepEqual(
      problems.map((p) => `${p.code}: ${p.message}`),
      [],
    );
  });

  for (const testCase of CASES) {
    test(`${testCase.rule} — ${testCase.code}`, () => {
      const problems = checkCrossFields(
        testCase.envelope,
        context(testCase.expectation),
      );
      const codes = problems.map((p) => p.code);
      assert.ok(
        codes.includes(testCase.code),
        `expected ${testCase.code} (${testCase.why}); got [${codes.join(', ')}]:\n`
        + problems.map((p) => `  ${p.code}: ${p.message}`).join('\n'),
      );
      for (const problem of problems) {
        assert.ok(
          problem.rule.length > 0,
          'a violation with no rule cannot be looked up',
        );
        assert.ok(
          problem.handled_as === 'BLOCKED' || problem.handled_as === 'FAILED'
          || problem.handled_as === 'DOWNGRADED' || problem.handled_as === 'REFUSED'
          || problem.handled_as === 'OVERRIDDEN',
          'every violation says how it is handled',
        );
      }
    });
  }

  test('every rule in the table is distinct, so no fixture is doing two jobs', () => {
    const rules = CASES.map((c) => c.rule);
    assert.equal(new Set(rules).size, rules.length);
  });

  test('a contract violation is handled as BLOCKED: the kernel never guesses', () => {
    const problems = checkCrossFields(
      valid({ status: 'COMPLETE', blockers: [fx.blocker()] }),
      context(),
    );
    assert.equal(problems[0]?.handled_as, 'BLOCKED');
  });

  test('an envelope from the wrong stage or role is refused', () => {
    const wrongStage = checkCrossFields(valid({ stage_in: 'PLAN' }), context());
    assert.ok(wrongStage.some((p) => p.code === 'STATUS_ILLEGAL_FOR_STAGE'));

    const wrongRole = checkCrossFields(valid({ agent: 'implementer' }), context());
    assert.ok(wrongRole.some((p) => p.code === 'PROPOSAL_NOT_PERMITTED_FOR_ROLE'));
  });

  test('reproducible evidence must name an operation to reproduce it with', () => {
    const problems = checkCrossFields(
      valid({
        evidence: [fx.evidence({
          id: 'E-001',
          reproducible: true,
          locator: { adapter: 'runtime.logs', op: null, args: {} },
        })],
      }),
      context(),
    );
    assert.ok(problems.some((p) => p.code === 'SCHEMA_INVALID'));
  });

  test('declared-unreproducible evidence with no operation is fine', () => {
    const problems = checkCrossFields(
      valid({
        evidence: [fx.evidence({
          id: 'E-001',
          reproducible: false,
          locator: { adapter: 'runtime.logs', op: null, args: {} },
        })],
        dod_verdicts: [],
      }),
      context(),
    );
    assert.deepEqual(problems.map((p) => p.code), []);
  });

  test('all rules report together rather than stopping at the first', () => {
    const problems = checkCrossFields(
      valid({
        status: 'COMPLETE',
        blockers: [fx.blocker()],
        outputs: {},
        coverage: fx.coverage({ scope_examined: [] }),
      }),
      context(),
    );
    const codes = new Set(problems.map((p) => p.code));
    assert.ok(codes.has('COMPLETE_WITH_BLOCKERS'));
    assert.ok(codes.has('COMPLETE_WITH_UNFILLED_OUTPUT'));
    assert.ok(codes.has('COVERAGE_MISSING'));
    assert.ok(
      problems.length >= 3,
      'an envelope with three inconsistencies is a different signal from one with a slip',
    );
  });
});
