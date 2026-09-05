import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVELOPE_STATUSES,
  fixtures as fx,
  type FrozenGraph,
  type HandoffEnvelope,
  type StageCursorEntry,
} from '@agentos/contracts';
import { loadPolicies } from '@agentos/policies';
import {
  decideAction,
  isLegalTransition,
  loopExhausted,
  saferBranch,
  legalTargets,
  type TransitionContext,
} from '../src/state-machine.js';
import {
  computeEntryStage,
  resumeOrder,
  stageFromCursor,
  stagesRemaining,
} from '../src/entry-stage.js';
import { computeDod, effectiveProfile, countsAsMet } from '../src/dod.js';
import { PredicateEvaluator } from '../src/predicates.js';
import { FixedClock, FixtureDiscovery } from './doubles.js';

const policies = loadPolicies();

/** The frozen graph a defect run works over. */
function defectGraph(overrides: Partial<FrozenGraph> = {}): FrozenGraph {
  const template = policies.templates.get('defect.standard');
  assert.ok(template !== undefined);
  return {
    template_id: template.template_id,
    template_version: template.version,
    entry: template.entry,
    stages: [...template.stages],
    edges: [...template.edges],
    excluded_stages: [],
    stage_mandates: {},
    risk_class: 'IRREVERSIBLE',
    dod_profile_default: 'fix',
    ...overrides,
  };
}

function investigationGraph(): FrozenGraph {
  const template = policies.templates.get('investigation.readonly');
  assert.ok(template !== undefined);
  return {
    template_id: template.template_id,
    template_version: template.version,
    entry: template.entry,
    stages: [...template.stages],
    edges: [...template.edges],
    excluded_stages: [],
    stage_mandates: {},
    risk_class: 'READ_ONLY',
    dod_profile_default: 'audit',
  };
}

/** The frozen graph the resolution document's scenario C runs over. */
function storyGraph(): FrozenGraph {
  const template = policies.templates.get('story.standard');
  assert.ok(template !== undefined);
  return {
    template_id: template.template_id,
    template_version: template.version,
    entry: template.entry,
    stages: [...template.stages],
    edges: [...template.edges],
    excluded_stages: [],
    stage_mandates: {},
    risk_class: 'IRREVERSIBLE',
    dod_profile_default: 'internal-capability',
  };
}

function context(overrides: Partial<TransitionContext> = {}): TransitionContext {
  const graph = overrides.graph ?? defectGraph();
  const stage = overrides.currentStage ?? 'VALIDATION';
  return {
    graph,
    currentStage: stage,
    descriptor: policies.stages.get('VALIDATION') ?? null,
    budgets: policies.budgets,
    loopCounters: {},
    workItemLoopCounters: {},
    dispatchAttempt: 1,
    modelAlreadyEscalated: false,
    requiredForExit: ['layer_verdicts'],
    evaluate: async (when) => ({
      predicate: when,
      value: when === 'always' ? 'TRUE' : 'FALSE',
      claim: null,
      inputs: [],
      reprobed: false,
      reason: 'fixture',
    }),
    ...overrides,
  };
}

/* ============================================== envelope status to action ==== */

describe('every envelope status maps to exactly one kernel action', () => {
  test('the mapping is total over the status enum', async () => {
    const unmapped: string[] = [];
    for (const status of ENVELOPE_STATUSES) {
      const envelope = fx.envelopeWithStatus(status);
      const action = await decideAction(
        { ...envelope, stage_in: 'VALIDATION' },
        context({
          currentStage: 'VALIDATION',
          requiredForExit: [],
        }),
      );
      if (action === undefined) unmapped.push(status);
    }
    assert.deepEqual(
      unmapped,
      [],
      'the switch is exhaustive over EnvelopeStatus and assertNever closes it, so adding a '
      + 'status without deciding its action is a compile error rather than a silent case',
    );
  });

  test('COMPLETE takes the edge whose predicate holds', async () => {
    const action = await decideAction(
      fx.envelope({ status: 'COMPLETE', stage_in: 'AUDIT' }),
      context({
        graph: investigationGraph(),
        currentStage: 'AUDIT',
        requiredForExit: [],
      }),
    );
    assert.equal(action.kind, 'TRANSITION');
    if (action.kind !== 'TRANSITION') throw new Error('unreachable');
    assert.equal(action.to, 'ROOT_CAUSE');
  });

  test('the kernel evaluates the predicate itself and overrides a wrong proposal', async () => {
    const action = await decideAction(
      fx.envelope({
        status: 'COMPLETE',
        stage_in: 'AUDIT',
        next_action: {
          proposed_stage: 'COMPLETION',
          proposed_agent: 'orchestrator',
          rationale: 'nothing more to do here',
        },
      }),
      context({
        graph: investigationGraph(),
        currentStage: 'AUDIT',
        requiredForExit: [],
      }),
    );
    assert.equal(action.kind, 'TRANSITION');
    if (action.kind !== 'TRANSITION') throw new Error('unreachable');
    assert.equal(action.to, 'ROOT_CAUSE', 'an agent does not drive the run');
    assert.equal(action.overridden, true);
    assert.equal(
      action.proposedStage,
      'COMPLETION',
      'the override is logged with both the claim and the evaluated value',
    );
  });

  test('PARTIAL with an unfilled required output re-dispatches once, then blocks', async () => {
    const partial = fx.envelope({
      status: 'PARTIAL',
      stage_in: 'VALIDATION',
      unknowns: [fx.unknownRecord()],
      outputs: {},
    });

    const first = await decideAction(partial, context({ dispatchAttempt: 1 }));
    assert.equal(first.kind, 'REDISPATCH');
    if (first.kind !== 'REDISPATCH') throw new Error('unreachable');
    assert.deepEqual(first.namedGaps, ['layer_verdicts']);

    const second = await decideAction(partial, context({ dispatchAttempt: 2 }));
    assert.equal(second.kind, 'BLOCK');
  });

  test('PARTIAL whose gap the exit condition does not require proceeds', async () => {
    const action = await decideAction(
      fx.envelope({
        status: 'PARTIAL',
        stage_in: 'AUDIT',
        unknowns: [fx.unknownRecord()],
        outputs: {},
      }),
      context({
        graph: investigationGraph(),
        currentStage: 'AUDIT',
        requiredForExit: [],
      }),
    );
    assert.equal(
      action.kind,
      'TRANSITION',
      'not required means proceed, recording the gap as an unknown',
    );
  });

  test('BLOCKED carries the blocker and records the pre-block stage', async () => {
    const action = await decideAction(
      fx.envelope({
        status: 'BLOCKED',
        stage_in: 'VALIDATION',
        blockers: [fx.blockerOfKind('MISSING_ACCESS')],
      }),
      context(),
    );
    assert.equal(action.kind, 'BLOCK');
    if (action.kind !== 'BLOCK') throw new Error('unreachable');
    assert.equal(action.blockerKind, 'MISSING_ACCESS');
    assert.equal(action.preBlockStage, 'VALIDATION');
  });

  test('WORK_ITEM_MISCLASSIFIED ends the run RERESOLVED rather than blocking', async () => {
    const action = await decideAction(
      fx.envelope({
        status: 'BLOCKED',
        stage_in: 'ROOT_CAUSE',
        blockers: [fx.blockerOfKind('WORK_ITEM_MISCLASSIFIED')],
      }),
      context({ currentStage: 'ROOT_CAUSE' }),
    );
    assert.equal(
      action.kind,
      'RERESOLVE',
      'it is a blocker rather than a proposal because the run genuinely cannot continue: its '
      + 'graph is for different work',
    );
  });

  test('BLOCKED_BY_ARCHITECTURE routes to ARCHITECTURE and counts against its cap', async () => {
    const action = await decideAction(
      fx.envelope({
        status: 'BLOCKED_BY_ARCHITECTURE',
        agent: 'implementer',
        stage_in: 'IMPLEMENTATION',
        blockers: [fx.blockerOfKind('ARCHITECTURE_CONTRADICTION')],
      }),
      context({ currentStage: 'IMPLEMENTATION' }),
    );
    assert.equal(action.kind, 'TRANSITION');
    if (action.kind !== 'TRANSITION') throw new Error('unreachable');
    assert.equal(action.to, 'ARCHITECTURE');
    assert.equal(action.edge.counter, 'architecture');
  });

  test('BLOCKED_BY_ARCHITECTURE in a graph with no ARCHITECTURE stage blocks honestly', async () => {
    const action = await decideAction(
      fx.envelope({
        status: 'BLOCKED_BY_ARCHITECTURE',
        agent: 'implementer',
        stage_in: 'IMPLEMENTATION',
        blockers: [fx.blockerOfKind('ARCHITECTURE_CONTRADICTION')],
      }),
      context({
        graph: defectGraph({ stages: ['IMPLEMENTATION', 'VALIDATION', 'COMPLETION'] }),
        currentStage: 'IMPLEMENTATION',
      }),
    );
    assert.equal(action.kind, 'BLOCK');
    if (action.kind !== 'BLOCK') throw new Error('unreachable');
    assert.equal(
      action.blockerKind,
      'ARCHITECTURE_CONTRADICTION',
      'the honest outcome for a template that assumed no design work was needed',
    );
  });

  test('a third architecture contradiction blocks rather than looping', async () => {
    const action = await decideAction(
      fx.envelope({
        status: 'BLOCKED_BY_ARCHITECTURE',
        agent: 'implementer',
        stage_in: 'IMPLEMENTATION',
        blockers: [fx.blockerOfKind('ARCHITECTURE_CONTRADICTION')],
      }),
      context({
        currentStage: 'IMPLEMENTATION',
        loopCounters: { architecture: policies.budgets.loops.architecture.per_run },
      }),
    );
    assert.equal(action.kind, 'BLOCK');
    if (action.kind !== 'BLOCK') throw new Error('unreachable');
    assert.equal(action.blockerKind, 'BUDGET_EXHAUSTED');
    assert.match(
      action.reason,
      /pushing through is worse than stopping/,
    );
  });

  test('FAILED retries per policy, escalating the model once, then blocks', async () => {
    const failed = fx.envelope({ status: 'FAILED', stage_in: 'VALIDATION' });

    const first = await decideAction(failed, context({ dispatchAttempt: 1 }));
    assert.equal(first.kind, 'REDISPATCH');
    if (first.kind !== 'REDISPATCH') throw new Error('unreachable');
    assert.equal(first.escalateModel, true, 'escalating the model once is the policy');

    const second = await decideAction(
      failed,
      context({ dispatchAttempt: 2, modelAlreadyEscalated: true }),
    );
    assert.equal(second.kind, 'REDISPATCH');
    if (second.kind !== 'REDISPATCH') throw new Error('unreachable');
    assert.equal(second.escalateModel, false, 'escalation is bounded at one per dispatch');

    const last = await decideAction(
      failed,
      context({
        dispatchAttempt: policies.budgets.dispatch_retries + 1,
        modelAlreadyEscalated: true,
      }),
    );
    assert.equal(last.kind, 'BLOCK');
    if (last.kind !== 'BLOCK') throw new Error('unreachable');
    assert.equal(last.blockerKind, 'EXTERNAL_DEPENDENCY');
    assert.match(last.reason, /No state advances/);
  });

  test('REJECTED takes the REJECTED edge, which is REWORK where the template has one', async () => {
    const action = await decideAction(
      fx.envelope({ status: 'REJECTED', agent: 'validator', stage_in: 'VALIDATION' }),
      context(),
    );
    assert.equal(action.kind, 'TRANSITION');
    if (action.kind !== 'TRANSITION') throw new Error('unreachable');
    assert.equal(action.to, 'REWORK');
    assert.equal(action.edge.counter, 'rework');
  });

  test('REJECTED where no REWORK edge exists is a decision for a human', async () => {
    const action = await decideAction(
      fx.envelope({ status: 'REJECTED', agent: 'validator', stage_in: 'VALIDATION' }),
      context({
        graph: {
          ...investigationGraph(),
          stages: ['AUDIT', 'VALIDATION', 'COMPLETION'],
          edges: [
            { from: 'AUDIT', to: 'VALIDATION', when: 'always', kind: 'advance' },
            { from: 'VALIDATION', to: 'COMPLETION', when: 'always', kind: 'advance' },
            { from: 'COMPLETION', to: 'COMPLETE', when: 'always', kind: 'terminal' },
          ],
        },
      }),
    );
    assert.equal(action.kind, 'BLOCK');
    if (action.kind !== 'BLOCK') throw new Error('unreachable');
    assert.match(action.reason, /a decision for a human rather than a lap/);
  });

  test('the rework loop cap blocks with a report, not a quiet retry', async () => {
    const action = await decideAction(
      fx.envelope({ status: 'REJECTED', agent: 'validator', stage_in: 'VALIDATION' }),
      context({ loopCounters: { rework: policies.budgets.loops.rework.per_run } }),
    );
    assert.equal(action.kind, 'BLOCK');
    if (action.kind !== 'BLOCK') throw new Error('unreachable');
    assert.equal(action.blockerKind, 'BUDGET_EXHAUSTED');
    assert.ok(action.report.length > 0, 'the block report states what was tried');
  });

  test('the per-work-item cap bites even when the per-run cap has room', () => {
    const graph = defectGraph();
    const edge = graph.edges.find((e) => e.counter === 'rework');
    assert.ok(edge !== undefined);
    const exhausted = loopExhausted(edge, context({
      loopCounters: { rework: 0 },
      workItemLoopCounters: { rework: policies.budgets.loops.rework.per_work_item },
    }));
    assert.equal(exhausted.exhausted, true);
    assert.equal(
      exhausted.scope,
      'work_item',
      'three runs of two laps each is six laps, and a budget that resets on every attempt is '
      + 'not a budget',
    );
  });
});

/* ============================================================== transitions ==== */

describe('transition legality', () => {
  test('any stage may transition to BLOCKED or CANCELLED without a template edge', () => {
    const graph = investigationGraph();
    assert.equal(isLegalTransition(graph, 'AUDIT', 'BLOCKED'), true);
    assert.equal(isLegalTransition(graph, 'AUDIT', 'CANCELLED'), true);
  });

  test('a stage no edge reaches is not a legal target', () => {
    const graph = investigationGraph();
    assert.equal(isLegalTransition(graph, 'AUDIT', 'COMPLETION'), false);
    assert.deepEqual([...legalTargets(graph, 'AUDIT')], ['ROOT_CAUSE']);
  });
});

describe('the refined safer-branch rule', () => {
  test('INDETERMINATE on a non-mutating stage enters it: more verification, no mutation', () => {
    const branch = saferBranch('INDETERMINATE', false, true);
    assert.equal(branch.decision, 'TAKE');
    assert.match(branch.reason, /cost of an unnecessary review is/);
  });

  test('INDETERMINATE on a mutating stage discovers rather than choosing', () => {
    const branch = saferBranch('INDETERMINATE', true, true);
    assert.equal(branch.decision, 'DISCOVER');
    assert.match(branch.reason, /point in opposite directions/);
  });

  test('INDETERMINATE on a mutating stage with no discovery blocks', () => {
    const branch = saferBranch('INDETERMINATE', true, false);
    assert.equal(branch.decision, 'BLOCK_AMBIGUOUS_STATE');
    assert.match(
      branch.reason,
      /never re-executes a non-reversible operation on the strength of an INDETERMINATE/,
    );
  });

  test('TRUE and FALSE both simply take their arm', () => {
    assert.equal(saferBranch('TRUE', true, false).decision, 'TAKE');
    assert.equal(saferBranch('FALSE', true, false).decision, 'TAKE');
  });
});

/* ============================================================= entry stage ==== */

describe('entry-stage computation', () => {
  /** A prior run's history: the ledger, authoritative about what AgentOS previously did. */
  const priorRun = (stages: readonly string[]) => fx.factAssertion(
    [{ run_id: 'run_20260903T090000Z_0000aa', outcome: 'BLOCKED', stages_completed: stages }],
    { evidence: ['E-ledger-1'], probe: 'agentos.history' },
  );

  async function walk(
    reality: Parameters<typeof fx.currentReality>[0],
    graph = defectGraph(),
  ) {
    const discovery = new FixtureDiscovery({ reality });
    const context = await discovery.deepen();
    return computeEntryStage({
      graph,
      policies,
      evaluator: new PredicateEvaluator(policies, new FixedClock(), discovery),
      predicateInputs: {
        context,
        workItem: fx.workItemOfType('DEFECT'),
        capabilities: [],
        mutations: [],
      },
    });
  }

  test('the resume order starts at the entry and covers every stage', () => {
    const graph = defectGraph();
    const order = resumeOrder(graph);
    assert.equal(order[0], graph.entry);
    assert.equal(new Set(order).size, graph.stages.length);
    assert.deepEqual([...order], [...graph.stages]);
  });

  test('nothing done yet enters at the template entry', async () => {
    const result = await walk({});
    assert.equal(result.outcome, 'ENTRY');
    if (result.outcome !== 'ENTRY') throw new Error('unreachable');
    assert.equal(result.entryStage, 'AUDIT');
    assert.deepEqual(result.completedPrior, []);
  });

  test('scenario D: a resumed defect with a reviewed PR enters at REVIEW_TRIAGE', async () => {
    /*
     * git and the PR host say the work is done and under review; the AgentOS ledger says the
     * analysis happened. So the sweep marks the prefix COMPLETED_PRIOR and enters at triage.
     * Analysis, planning and implementation are not restarted, and not because an agent
     * decided they were done.
     */
    const result = await walk({
      agentos_history: priorRun(['AUDIT', 'ROOT_CAUSE', 'PLAN']),
      implementation_present: fx.factAssertion(true, { evidence: ['E-git-1'] }),
      tests_present: fx.factAssertion(true),
      pr: fx.factAssertion({ state: 'OPEN', number: 412, head_sha: '4de0117' }),
      reviews: fx.factAssertion({ approved: false, unresolved_threads: 3 }),
      ci: fx.factAssertion({ result: 'GREEN', head_sha: '4de0117' }),
    });
    assert.equal(result.outcome, 'ENTRY');
    if (result.outcome !== 'ENTRY') throw new Error('unreachable');
    assert.ok(
      result.completedPrior.includes('IMPLEMENTATION'),
      'implementation is marked already done from git, not from a claim',
    );
    assert.ok(result.completedPrior.includes('AUDIT'));
    assert.ok(result.completedPrior.includes('PR_PREPARATION'));
    assert.ok(
      result.completedPrior.includes('PR_REVIEW'),
      'a review that requested changes is still a review that happened',
    );
    assert.ok(
      !result.completedPrior.includes('MERGE'),
      'the PR is open, so the merge has not happened',
    );
    assert.equal(result.entryStage, 'REVIEW_TRIAGE');
  });

  test('scenario C: a resumed story with no review requested enters at PR_REVIEW', async () => {
    /*
     * The same shape one stage earlier, and the pair is the point: scenario C has a PR nobody
     * has reviewed, scenario D has a PR reviewed unfavourably. Keying PR_REVIEW on approval
     * rather than on a review having happened would collapse the two.
     */
    const result = await walk({
      agentos_history: priorRun(['AUDIT', 'PLAN']),
      implementation_present: fx.factAssertion(true, { evidence: ['E-git-1'] }),
      tests_present: fx.factAssertion(true),
      pr: fx.factAssertion({ state: 'OPEN', number: 77, head_sha: 'ab12cd3' }),
      reviews: fx.factAssertion({ approved: false, unresolved_threads: 0 }),
      ci: fx.factAssertion({ result: 'GREEN', head_sha: 'ab12cd3' }),
    }, storyGraph());
    assert.equal(result.outcome, 'ENTRY');
    if (result.outcome !== 'ENTRY') throw new Error('unreachable');
    assert.equal(result.entryStage, 'PR_REVIEW');
    assert.deepEqual(
      [...result.completedPrior],
      ['AUDIT', 'PLAN', 'IMPLEMENTATION', 'VALIDATION', 'PR_PREPARATION'],
      'exactly the set the resolution document names for this scenario',
    );
  });

  test('a stage the run never executed is PASSED_UNVERIFIED, not COMPLETED_PRIOR', async () => {
    /*
     * ARCHITECTURE never ran in the prior story run, and the sweep does not pretend it did.
     * It is passed over because re-entering it would walk backwards over an existing PR, and
     * its criteria stay NOT_VALIDATED so COMPLETION routes back to it.
     */
    const result = await walk({
      agentos_history: priorRun(['AUDIT', 'PLAN']),
      implementation_present: fx.factAssertion(true),
      tests_present: fx.factAssertion(true),
      pr: fx.factAssertion({ state: 'OPEN', number: 77, head_sha: 'ab12cd3' }),
      reviews: fx.factAssertion({ approved: false, unresolved_threads: 0 }),
    }, storyGraph());
    if (result.outcome !== 'ENTRY') throw new Error('unreachable');
    const step = result.walk.find((s) => s.stage === 'ARCHITECTURE');
    assert.equal(step?.decision, 'PASSED_UNVERIFIED');
    assert.ok(!result.completedPrior.includes('ARCHITECTURE'));
    assert.match(step?.reason ?? '', /NOT_VALIDATED and COMPLETION routes back to it/);
  });

  test('code existing never marks an analysis stage done: only the ledger does', async () => {
    /*
     * The inference the design refuses. A fix exists and no prior run analysed anything. The
     * sweep may skip past AUDIT because re-entering it would walk backwards over the existing
     * implementation, but it must not call the audit done: marking an audit COMPLETED_PRIOR
     * because a fix exists is exactly how a symptom patch would get blessed.
     */
    const result = await walk({
      implementation_present: fx.factAssertion(true),
      agentos_history: fx.factAssertion([]),
    });
    assert.equal(result.outcome, 'ENTRY');
    if (result.outcome !== 'ENTRY') throw new Error('unreachable');
    assert.ok(!result.completedPrior.includes('AUDIT'));
    assert.ok(!result.completedPrior.includes('ROOT_CAUSE'));
    assert.equal(
      result.walk.find((s) => s.stage === 'AUDIT')?.decision,
      'PASSED_UNVERIFIED',
    );
  });

  test('nothing observably done at all enters at the first stage', async () => {
    const result = await walk({ agentos_history: fx.factAssertion([]) });
    if (result.outcome !== 'ENTRY') throw new Error('unreachable');
    assert.equal(result.entryStage, 'AUDIT');
  });

  test('a COMPLETED_PRIOR marking records the evidence it rests on', async () => {
    const result = await walk({ agentos_history: priorRun(['AUDIT']) });
    if (result.outcome !== 'ENTRY') throw new Error('unreachable');
    const step = result.walk.find((s) => s.stage === 'AUDIT');
    assert.equal(step?.decision, 'COMPLETED_PRIOR');
    assert.ok(
      (step?.evidence.length ?? 0) > 0,
      'a stage skipped as already done must say what said so',
    );
  });

  test('a COMPLETED_PRIOR marking states that the criteria are still NOT_VALIDATED', async () => {
    const result = await walk({ agentos_history: priorRun(['AUDIT']) });
    if (result.outcome !== 'ENTRY') throw new Error('unreachable');
    const step = result.walk.find((s) => s.decision === 'COMPLETED_PRIOR');
    assert.match(step?.reason ?? '', /not that its criteria are met/);
  });

  test('an absent mutation before a completed one is AMBIGUOUS_STATE, not a resume', async () => {
    /*
     * "There is no implementation, and the pull request is merged" is two observations
     * contradicting each other. Resolving it by preferring either one would be a guess, so it
     * goes to a human.
     */
    const result = await walk({
      agentos_history: priorRun(['AUDIT', 'ROOT_CAUSE', 'PLAN']),
      implementation_present: fx.factAssertion(false),
      tests_present: fx.factAssertion(true),
      pr: fx.factAssertion({ state: 'MERGED', number: 412, head_sha: '4de0117' }),
      merge_state: fx.factAssertion({ state: 'MERGED' }),
      reviews: fx.factAssertion({ approved: true, unresolved_threads: 0 }),
    });
    assert.equal(result.outcome, 'BLOCKED');
    if (result.outcome !== 'BLOCKED') throw new Error('unreachable');
    assert.equal(result.blockerKind, 'AMBIGUOUS_STATE');
    assert.equal(result.stage, 'IMPLEMENTATION');
    assert.match(result.reason, /contradiction between two observations/);
  });

  test('INDETERMINATE on a mutating stage with no discovery blocks with AMBIGUOUS_STATE', async () => {
    const discovery = new FixtureDiscovery({
      reality: {
        agentos_history: priorRun(['AUDIT', 'ROOT_CAUSE', 'PLAN']),
        implementation_present: fx.unknownAssertion({ reason: 'UNAVAILABLE' }),
      },
    });
    const context = await discovery.deepen();
    /* No `discover` hook and no discovery port: the sweep has nothing to settle it with. */
    const result = await computeEntryStage({
      graph: defectGraph(),
      policies,
      evaluator: new PredicateEvaluator(policies, new FixedClock(), null),
      predicateInputs: {
        context,
        workItem: fx.workItemOfType('DEFECT'),
        capabilities: [],
        mutations: [],
      },
    });
    assert.equal(result.outcome, 'BLOCKED');
    if (result.outcome !== 'BLOCKED') throw new Error('unreachable');
    assert.equal(result.blockerKind, 'AMBIGUOUS_STATE');
    assert.equal(result.stage, 'IMPLEMENTATION');
    assert.match(
      result.reason,
      /never re-executes a non-reversible operation on the strength of an INDETERMINATE/,
    );
  });

  test('targeted discovery that settles an INDETERMINATE lets the sweep continue', async () => {
    const discovery = new FixtureDiscovery({
      reality: {
        agentos_history: priorRun(['AUDIT', 'ROOT_CAUSE', 'PLAN']),
        implementation_present: fx.unknownAssertion({ reason: 'UNAVAILABLE' }),
      },
    });
    const context = await discovery.deepen();
    const result = await computeEntryStage({
      graph: defectGraph(),
      policies,
      evaluator: new PredicateEvaluator(policies, new FixedClock(), null),
      predicateInputs: {
        context,
        workItem: fx.workItemOfType('DEFECT'),
        capabilities: [],
        mutations: [],
      },
      discover: async (_stage, predicate) => ({
        predicate,
        value: 'FALSE',
        claim: null,
        inputs: [],
        reprobed: true,
        reason: 'targeted discovery found no branch implementing this scope',
      }),
    });
    assert.equal(result.outcome, 'ENTRY');
    if (result.outcome !== 'ENTRY') throw new Error('unreachable');
    assert.equal(result.entryStage, 'IMPLEMENTATION');
    assert.match(
      result.walk.find((s) => s.stage === 'IMPLEMENTATION')?.reason ?? '',
      /targeted discovery settled it/,
    );
  });

  test('the cursor classifies every stage: done, active or simply not reached', async () => {
    const result = await walk({ agentos_history: priorRun(['AUDIT']) });
    if (result.outcome !== 'ENTRY') throw new Error('unreachable');
    const graph = defectGraph();
    assert.equal(result.cursor.length, graph.stages.length);
    assert.equal(result.cursor.filter((c) => c.state === 'ACTIVE').length, 1);
  });

  test('crash recovery reads the cursor rather than re-deriving the entry', () => {
    const graph = defectGraph();
    const cursor: readonly StageCursorEntry[] = [
      { stage: 'AUDIT', state: 'COMPLETED', reality_evidence: [], entered_at: null, left_at: null },
      { stage: 'ROOT_CAUSE', state: 'ACTIVE', reality_evidence: [], entered_at: null, left_at: null },
    ];
    assert.equal(
      stageFromCursor(cursor, graph),
      'ROOT_CAUSE',
      'the frozen graph and the cursor already say where the run was; recomputing would make '
      + 'recovery depend on reality having stayed still',
    );
    assert.ok(stagesRemaining(cursor, graph).includes('IMPLEMENTATION'));
    assert.ok(!stagesRemaining(cursor, graph).includes('AUDIT'));
  });

  test('a stage marked COMPLETED_PRIOR is not among the stages remaining', () => {
    /*
     * The resume sweep's own output, fed straight back. `COMPLETED_PRIOR` means the mutation
     * this stage performs has already occurred — the stage is not still to run, whatever its
     * criteria still owe.
     */
    const graph = defectGraph();
    const cursor: readonly StageCursorEntry[] = [
      {
        stage: 'AUDIT', state: 'COMPLETED_PRIOR', reality_evidence: ['E-ledger-1'],
        entered_at: null, left_at: null,
      },
      { stage: 'ROOT_CAUSE', state: 'ACTIVE', reality_evidence: [], entered_at: null, left_at: null },
    ];
    assert.ok(!stagesRemaining(cursor, graph).includes('AUDIT'));
    assert.ok(stagesRemaining(cursor, graph).includes('ROOT_CAUSE'), 'the active stage still owes its outputs');
  });

  test('a stage excluded at admission is not among the stages remaining', () => {
    /*
     * Two mechanisms, both of which must hold. Exclusion is decided once, at admission, and
     * the frozen graph simply does not carry the stage afterwards — so the walk cannot reach
     * it. The `EXCLUDED` cursor state says the same thing where a cursor carries one, and
     * `stagesRemaining` honours that too rather than depending on the graph alone.
     */
    const excluded = defectGraph({
      stages: policies.templates.get('defect.standard')?.stages.filter((s) => s !== 'UX_REVIEW'),
      excluded_stages: [{ stage: 'UX_REVIEW', predicate: 'ux.required', evaluated: 'FALSE' }],
    });
    assert.ok(
      !stagesRemaining([], excluded).includes('UX_REVIEW'),
      'an excluded stage is not a stage the run may still reach',
    );
    assert.ok(stagesRemaining([], excluded).includes('IMPLEMENTATION'));

    const cursor: readonly StageCursorEntry[] = [
      { stage: 'UX_REVIEW', state: 'EXCLUDED', reality_evidence: [], entered_at: null, left_at: null },
    ];
    assert.ok(!stagesRemaining(cursor, defectGraph()).includes('UX_REVIEW'));
  });
});

/* ==================================================================== DoD ==== */

describe('DoD arithmetic', () => {
  const graph = investigationGraph();

  function report(envelopes: readonly HandoffEnvelope[], completedPrior: readonly ('AUDIT' | 'ROOT_CAUSE' | 'COMPLETION')[] = []) {
    return computeDod({
      workItemId: 'wi_c_subject',
      runId: 'run_20260904T100000Z_000001',
      profileId: 'audit',
      policies,
      envelopes,
      completedPriorStages: completedPrior,
      graphStages: graph.stages,
      sourceDrift: null,
      computedAt: fx.T2,
    });
  }

  test('every applicable criterion MET is COMPLETE', () => {
    const result = report([
      fx.envelope({
        agent: 'context-discovery',
        stage_in: 'CONTEXT_DISCOVERY',
        dod_verdicts: [fx.criterionVerdict({ criterion: 1, evidence: ['E-1'] })],
      }),
      fx.envelope({
        agent: 'auditor',
        stage_in: 'AUDIT',
        dod_verdicts: [
          fx.criterionVerdict({ criterion: 3, evidence: ['E-1'] }),
          fx.criterionVerdict({ criterion: 4, evidence: ['E-1'] }),
        ],
      }),
    ]);
    assert.equal(result.report.verdict, 'COMPLETE');
  });

  test('NOT_VALIDATED is never MET, so an unsupplied criterion is not completion', () => {
    const result = report([
      fx.envelope({
        agent: 'auditor',
        stage_in: 'AUDIT',
        dod_verdicts: [fx.criterionVerdict({ criterion: 3, evidence: ['E-1'] })],
      }),
    ]);
    assert.notEqual(result.report.verdict, 'COMPLETE');
    assert.ok(result.report.not_validated.includes(4));
    assert.equal(countsAsMet('NOT_VALIDATED'), false);
  });

  test('a COMPLETED_PRIOR stage supplies no verdicts, so COMPLETION routes back', () => {
    /*
     * The property that makes resumption safe. Resumption is an optimization over *work*; it
     * has no authority over *completion*. A wrong resume costs a wasted lap and cannot
     * produce a false COMPLETE.
     */
    const result = report(
      [fx.envelope({
        agent: 'context-discovery',
        stage_in: 'CONTEXT_DISCOVERY',
        dod_verdicts: [fx.criterionVerdict({ criterion: 1, evidence: ['E-1'] })],
      })],
      ['AUDIT'],
    );
    assert.equal(result.report.verdict, 'INCOMPLETE');
    assert.equal(
      result.report.route_back_to,
      'AUDIT',
      'it routes back to the stage that owes the missing verdicts',
    );
    const criterion3 = result.report.criteria.find((c) => c.criterion === 3);
    assert.match(
      criterion3?.reason ?? '',
      /COMPLETED_PRIOR means the mutation has already occurred, not that the criteria are met/,
    );
  });

  test('a non-critical gap is COMPLETE_WITH_GAPS and names the gap', () => {
    const result = computeDod({
      workItemId: 'wi_c_subject',
      runId: 'run_x',
      profileId: 'internal-capability',
      policies,
      envelopes: [
        fx.envelope({
          agent: 'context-discovery',
          stage_in: 'CONTEXT_DISCOVERY',
          dod_verdicts: [fx.criterionVerdict({ criterion: 1, evidence: ['E-1'] })],
        }),
        fx.envelope({
          agent: 'validator',
          stage_in: 'VALIDATION',
          dod_verdicts: [
            fx.criterionVerdict({ criterion: 5, evidence: ['E-1'] }),
            fx.criterionVerdict({ criterion: 12, evidence: ['E-1'] }),
          ],
        }),
      ],
      completedPriorStages: [],
      graphStages: ['IMPLEMENTATION', 'VALIDATION', 'COMPLETION'],
      sourceDrift: null,
      computedAt: fx.T2,
    });
    assert.equal(result.report.verdict, 'COMPLETE_WITH_GAPS');
    assert.ok(result.report.gaps.length > 0, 'the gap is named');
    assert.match(result.rationale.join(' '), /Requires human acknowledgement/);
  });

  test('INDETERMINATE is not COMPLETE_WITH_GAPS: "could not check" is not "accepted a gap"', () => {
    const result = computeDod({
      workItemId: 'wi_c_subject',
      runId: 'run_x',
      profileId: 'audit',
      policies,
      envelopes: [],
      completedPriorStages: [],
      /* A graph with no stage owning 3 or 4: the evidence is unobtainable with this access. */
      graphStages: ['COMPLETION'],
      sourceDrift: null,
      computedAt: fx.T2,
    });
    assert.equal(result.report.verdict, 'INDETERMINATE');
    assert.match(
      result.rationale.join(' '),
      /"We could not check" is not "we checked and accepted a gap"/,
    );
  });

  test('a criterion the profile excludes by default is NOT_APPLICABLE with its reason', () => {
    const result = computeDod({
      workItemId: 'wi_c_subject',
      runId: 'run_x',
      profileId: 'service-capability',
      policies,
      envelopes: [],
      completedPriorStages: [],
      graphStages: ['AUDIT', 'VALIDATION', 'STRUCTURAL_REAUDIT', 'COMPLETION'],
      sourceDrift: null,
      computedAt: fx.T2,
    });
    const criterion8 = result.report.criteria.find((c) => c.criterion === 8);
    assert.equal(criterion8?.verdict, 'NOT_APPLICABLE');
    assert.ok(
      (criterion8?.reason ?? '').length > 0,
      'a profile that marks an inconvenient criterion NOT_APPLICABLE without a reason is rejected',
    );
  });

  test('source drift is disclosed in the completion report rather than chased', () => {
    const result = computeDod({
      workItemId: 'wi_c_subject',
      runId: 'run_x',
      profileId: 'audit',
      policies,
      envelopes: [],
      completedPriorStages: [],
      graphStages: graph.stages,
      sourceDrift: {
        state: 'CHANGED',
        hash_at_admission: 'a'.repeat(64),
        hash_now: 'b'.repeat(64),
        detail: 'the ticket was edited',
      },
      computedAt: fx.T2,
    });
    assert.ok(
      result.report.gaps.some((g) => g.includes('edited since admission')),
      'the verdict is computed against the admitted work item, and the reader is told the '
      + 'request has moved',
    );
  });

  test('a later verdict on the same criterion supersedes an earlier one', () => {
    const result = report([
      fx.envelope({
        envelope_id: 'env_1',
        agent: 'auditor',
        stage_in: 'AUDIT',
        dod_verdicts: [{
          criterion: 3, verdict: 'NOT_MET', reason: 'two stores claim ownership',
          evidence: [], capability: null,
        }],
      }),
      fx.envelope({
        envelope_id: 'env_2',
        agent: 'auditor',
        stage_in: 'AUDIT',
        dod_verdicts: [fx.criterionVerdict({ criterion: 3, evidence: ['E-1'] })],
      }),
    ]);
    const criterion3 = result.report.criteria.find((c) => c.criterion === 3);
    assert.equal(criterion3?.verdict, 'MET', 'a rework lap is supposed to change the answer');
    assert.equal(criterion3?.supplied_by_envelope, 'env_2');
  });

  test('the effective profile prefers the template default when the work item admits it', () => {
    assert.equal(effectiveProfile('fix', ['fix', 'audit']).profile, 'fix');
    const fallback = effectiveProfile('fix', ['audit']);
    assert.equal(fallback.profile, 'audit');
    assert.match(fallback.reason, /deterministic order/);
  });
});
