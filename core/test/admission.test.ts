import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtures as fx,
  type CapabilityRecord,
  type ContextPackage,
  type ProposedWorkItem,
  type Scope,
  type WorkItem,
  type WorkflowProposal,
} from '@agentos/contracts';
import { loadPolicies } from '@agentos/policies';
import {
  admitWorkItem,
  checkOutcomeBindable,
  checkScope,
  checkTypeEvidence,
  deriveIdentity,
  type AdmissionInput,
  type IdentityResolution,
} from '../src/admission.js';
import { computeUnderstood, entryPredicates } from '../src/understood.js';
import {
  admitWorkflow,
  deriveRiskClass,
  mostConservative,
  scopeContained,
} from '../src/workflow-admission.js';
import { PredicateEvaluator } from '../src/predicates.js';
import { FixedClock, FixtureDiscovery, policiesAllowingMutation } from './doubles.js';

const policies = loadPolicies();

/** A Context Package with the given Current Reality, as discovery would have produced it. */
async function ctx(reality: Parameters<typeof fx.currentReality>[0] = {}): Promise<ContextPackage> {
  return new FixtureDiscovery({ reality }).deepen();
}

const ACCESS = new Set(['repository', 'git'] as const);
const FULL_ACCESS = new Set([
  'repository', 'git', 'project_management', 'runtime', 'production',
] as const);

function baseProposal(overrides: Partial<ProposedWorkItem> = {}): ProposedWorkItem {
  return {
    source_intake: 'in_0001',
    intent: fx.inferenceAssertion('MODIFY_ARTIFACT'),
    type: fx.inferenceAssertion('TASK'),
    external_identity: fx.unknownAssertion({ reason: 'NOT_APPLICABLE' }),
    title: fx.factAssertion('Fix typo in README', {
      evidence: [fx.evidence({
        id: 'E-01',
        locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
        ref: 'README.md',
      })],
    }),
    desired_outcome: fx.inferenceAssertion('the misspelling in README.md is corrected'),
    scope: { paths: ['README.md'], capabilities: [], repositories: ['subject'], confidence: 'FACT' },
    constraints: [],
    dependencies: [],
    parent: fx.unknownAssertion({ reason: 'NOT_APPLICABLE' }),
    resolution_confidence: 0.9,
    alternatives: [],
    ...overrides,
  };
}

async function admissionInput(
  overrides: Partial<AdmissionInput> = {},
  reality: Parameters<typeof fx.currentReality>[0] = {},
): Promise<AdmissionInput> {
  const context = await new FixtureDiscovery({ reality }).deepen();
  return {
    intake: fx.intakeRecord(),
    proposal: baseProposal(),
    policies,
    context,
    capabilities: [],
    identity: { outcome: 'NOT_NAMED' },
    existing: [],
    access: ACCESS,
    now: fx.T1,
    ...overrides,
  };
}

function outcome(checks: readonly { check: string; result: string }[], name: string): string {
  return checks.find((c) => c.check === name)?.result ?? 'MISSING';
}

/* ================================================== work item admission ==== */

describe('work item admission: the six checks', () => {
  test('a well-formed proposal is admitted and every check is recorded', async () => {
    const result = admitWorkItem(await admissionInput());
    assert.equal(result.outcome, 'ADMITTED');
    if (result.outcome !== 'ADMITTED') throw new Error('unreachable');
    const reported = new Set(result.checks.map((c) => c.check));
    for (const check of [
      'schema_and_confidence', 'external_identity', 'identity', 'type_minimum_evidence',
      'scope_bounded', 'outcome_bindable',
    ]) {
      assert.ok(reported.has(check), `check ${check} of section 3.4 is reported`);
    }
    assert.equal(result.workItem.type, 'TASK');
    assert.equal(result.typeDowngraded, false);
  });

  test('the agent\'s own confidence number is recorded and gates nothing', async () => {
    /*
     * Section 3.4 has six checks and this is not one of them. It is recorded because a
     * resolution the agent itself was unsure of is worth seeing in the log, and it is
     * INDETERMINATE rather than FAIL because a number an agent chose about its own work
     * cannot be the reason anything is refused.
     */
    const result = admitWorkItem(await admissionInput({
      proposal: baseProposal({ resolution_confidence: 0.1 }),
    }));
    assert.equal(result.outcome, 'ADMITTED');
    const confidence = result.checks.find((c) => c.check === 'resolution_confidence');
    assert.equal(confidence?.result, 'INDETERMINATE');
    assert.match(confidence?.detail ?? '', /never the reason anything is believed/);
  });

  test('an unbounded scope is refused, because scope becomes the adapters\' mandate', () => {
    const check = checkScope({ paths: ['**'], capabilities: [], repositories: ['subject'] });
    assert.equal(check.result, 'FAIL');
    assert.match(check.detail, /\*\*/);
  });

  test('an empty scope is refused: nothing is not a bounded scope', () => {
    assert.equal(
      checkScope({ paths: [], capabilities: [], repositories: [] }).result,
      'FAIL',
    );
  });

  test('a capability-only scope is bounded, because a capability names its own paths', () => {
    assert.equal(
      checkScope({ paths: [], capabilities: ['cap.session'], repositories: ['subject'] }).result,
      'PASS',
    );
  });

  test('an escaping path is refused before it can become a grant', () => {
    const check = checkScope({
      paths: ['../../etc/passwd'],
      capabilities: [],
      repositories: ['subject'],
    });
    assert.equal(check.result, 'FAIL');
  });

  test('a scope violation is a violation, not a warning', async () => {
    const result = admitWorkItem(await admissionInput({
      proposal: baseProposal({
        scope: { paths: ['**'], capabilities: [], repositories: ['subject'], confidence: 'FACT' },
      }),
    }));
    assert.equal(result.outcome, 'REJECTED');
    if (result.outcome !== 'REJECTED') throw new Error('unreachable');
    assert.ok(result.violations.some((v) => v.code === 'UNBOUNDED_SCOPE'));
    assert.ok(result.violations.every((v) => v.handled_as === 'REFUSED'));
  });

  test('an unresolvable external key blocks, and does not degrade to investigating something else', async () => {
    const result = admitWorkItem(await admissionInput({
      identity: { outcome: 'UNAVAILABLE', identity: 'jira:DEF-456', detail: 'host unreachable' },
    }));
    assert.equal(result.outcome, 'BLOCKED');
    if (result.outcome !== 'BLOCKED') throw new Error('unreachable');
    assert.equal(result.blockerKind, 'EXTERNAL_DEPENDENCY');
    assert.match(result.reason, /degrading into investigating the repository instead/);
    assert.equal(outcome(result.checks, 'external_identity'), 'INDETERMINATE');
  });

  test('a reachable source with no such item blocks too: the key is wrong', async () => {
    const result = admitWorkItem(await admissionInput({
      identity: { outcome: 'ABSENT', identity: 'jira:DEF-999' },
    }));
    assert.equal(result.outcome, 'BLOCKED');
    if (result.outcome !== 'BLOCKED') throw new Error('unreachable');
    assert.match(result.reason, /the key is wrong/i);
    assert.equal(
      outcome(result.checks, 'external_identity'),
      'FAIL',
      'absent is a failure, where unreachable is INDETERMINATE: the two are not the same answer',
    );
  });

  test('a claimed DEFECT with no capability record and no report is admitted as UNKNOWN', async () => {
    const result = admitWorkItem(await admissionInput({
      proposal: baseProposal({
        type: fx.inferenceAssertion('DEFECT'),
        title: fx.inferenceAssertion('sessions expire early'),
        scope: {
          paths: ['src/session/**'], capabilities: [], repositories: ['subject'],
          confidence: 'INFERENCE',
        },
      }),
    }));
    assert.equal(result.outcome, 'ADMITTED');
    if (result.outcome !== 'ADMITTED') throw new Error('unreachable');
    assert.equal(result.workItem.type, 'UNKNOWN');
    assert.equal(result.typeDowngraded, true);
    assert.equal(
      result.workItem.claimed_type,
      'DEFECT',
      'the claim is recorded rather than discarded: what the agent thought is evidence about the agent',
    );
    assert.match(
      outcome(result.checks, 'type_minimum_evidence') === 'FAIL'
        ? result.checks.find((c) => c.check === 'type_minimum_evidence')?.detail ?? ''
        : '',
      /routes to the read-only investigation template/,
    );
  });

  test('a DEFECT needs both of its minimums: the capability exists and something reports it broken', async () => {
    /*
     * `satisfied_by: ALL`. A complaint about something never built is not a defect, and a
     * capability existing is not a report that it misbehaves. Each half alone downgrades.
     */
    const capability: CapabilityRecord = fx.capabilityRecord({
      id: 'cap.session-management',
      scope_paths: ['src/session/**'],
    });
    const scope = {
      paths: ['src/session/**'], capabilities: [], repositories: ['subject'],
      confidence: 'INFERENCE' as const,
    };
    const defect = (evidence: readonly ReturnType<typeof fx.evidence>[]) => baseProposal({
      type: fx.inferenceAssertion('DEFECT'),
      scope,
      title: fx.factAssertion('sessions expire after five minutes', { evidence: [...evidence] }),
    });

    const both = admitWorkItem(await admissionInput({
      capabilities: [capability],
      proposal: defect([
        fx.evidence({ id: 'E-code', kind: 'file' }),
        fx.evidence({ id: 'E-report', kind: 'log' }),
      ]),
    }));
    assert.equal(both.outcome, 'ADMITTED');
    if (both.outcome !== 'ADMITTED') throw new Error('unreachable');
    assert.equal(both.workItem.type, 'DEFECT');

    const reportOnly = admitWorkItem(await admissionInput({
      capabilities: [capability],
      proposal: defect([fx.evidence({ id: 'E-report', kind: 'log' })]),
    }));
    assert.equal(
      reportOnly.outcome === 'ADMITTED' ? reportOnly.workItem.type : 'REJECTED',
      'UNKNOWN',
      'a report with nothing establishing the capability exists does not make a DEFECT',
    );

    const noCapabilityRecord = admitWorkItem(await admissionInput({
      capabilities: [],
      proposal: defect([
        fx.evidence({ id: 'E-code', kind: 'file' }),
        fx.evidence({ id: 'E-report', kind: 'log' }),
      ]),
    }));
    assert.equal(
      noCapabilityRecord.outcome === 'ADMITTED' ? noCapabilityRecord.workItem.type : 'REJECTED',
      'UNKNOWN',
      'a complaint about something never built is not a defect',
    );
  });

  test('a FEATURE requires that no capability already implements it', async () => {
    const scope: Scope = { paths: ['src/sync/**'], capabilities: [], repositories: ['subject'] };
    const clashing = fx.capabilityRecord({ id: 'cap.sync', scope_paths: ['src/sync/**'] });
    const context = await ctx();
    const evidence = [fx.evidence({ id: 'E-none', kind: 'file' })];
    const withClash = checkTypeEvidence(
      'FEATURE', evidence, scope, [clashing], { outcome: 'NOT_NAMED' },
      context, policies.workItems,
    );
    assert.equal(
      withClash.admittedType,
      'UNKNOWN',
      'a capability record already covering the scope means this is a DEFECT question, not a FEATURE',
    );
    const withoutClash = checkTypeEvidence(
      'FEATURE', evidence, scope, [], { outcome: 'NOT_NAMED' },
      context, policies.workItems,
    );
    assert.equal(withoutClash.admittedType, 'FEATURE');
  });

  test('an INCIDENT requires a runtime observation, so urgency alone is not one', async () => {
    const scope: Scope = { paths: ['src/**'], capabilities: [], repositories: ['subject'] };
    const context = await ctx();
    const fromReport = checkTypeEvidence(
      'INCIDENT',
      [fx.evidence({ id: 'E-1', kind: 'file' })],
      scope, [], { outcome: 'NOT_NAMED' }, context, policies.workItems,
    );
    assert.equal(
      fromReport.admittedType,
      'UNKNOWN',
      'a user report is not a production observation, however urgent it sounds',
    );
    const fromRuntime = checkTypeEvidence(
      'INCIDENT',
      [fx.evidence({
        id: 'E-2',
        kind: 'log',
        locator: { adapter: 'runtime.logs', op: 'query', args: { q: 'expiry' } },
      })],
      scope, [], { outcome: 'NOT_NAMED' }, context, policies.workItems,
    );
    assert.equal(fromRuntime.admittedType, 'INCIDENT');
  });

  test('an EPIC requires children to exist', async () => {
    const scope: Scope = { paths: ['src/**'], capabilities: [], repositories: ['subject'] };
    const ticket = [fx.evidence({ id: 'E-epic', kind: 'ticket' })];
    const none = checkTypeEvidence(
      'EPIC', ticket, scope, [], { outcome: 'NOT_NAMED' },
      await ctx({ children: fx.factAssertion([]) }), policies.workItems,
    );
    assert.equal(none.admittedType, 'UNKNOWN');
    const some = checkTypeEvidence(
      'EPIC', ticket, scope, [], { outcome: 'NOT_NAMED' },
      await ctx({ children: fx.factAssertion([{ work_item_id: 'wi_child' }]) }),
      policies.workItems,
    );
    assert.equal(some.admittedType, 'EPIC');
    const external = checkTypeEvidence(
      'EPIC', ticket, scope, [],
      { outcome: 'RESOLVED', identity: 'jira:EPIC-1', evidence: fx.evidence({ id: 'E-pm' }) },
      await ctx({ children: fx.factAssertion([]) }), policies.workItems,
    );
    assert.equal(
      external.admittedType,
      'EPIC',
      'satisfied_by ANY: an external item typed as an Epic is enough on its own',
    );
  });

  test('an empty outcome is refused', () => {
    const empty = checkOutcomeBindable('TASK', '   ', policies, ACCESS);
    assert.equal(empty.outcome.result, 'FAIL');
    assert.match(empty.outcome.detail, /empty/);
    assert.deepEqual(empty.profiles, []);
  });

  test('a profile this run cannot check is not a profile the outcome binds to', () => {
    /*
     * The service, data and UI profiles all require runtime access. Without it a FEATURE binds
     * only to `internal-capability`, and the bar it is judged against is the one this run can
     * actually check rather than the one that sounded right.
     */
    const outcomeText = 'issues appear as work items within the configured interval';
    const withoutRuntime = checkOutcomeBindable('FEATURE', outcomeText, policies, ACCESS);
    const withRuntime = checkOutcomeBindable('FEATURE', outcomeText, policies, FULL_ACCESS);
    assert.deepEqual([...withoutRuntime.profiles], ['internal-capability']);
    assert.ok(withRuntime.profiles.length > withoutRuntime.profiles.length);
    assert.match(withoutRuntime.outcome.detail, /with this run's access/);
  });

  test('an outcome binding only to profiles this run cannot check is rejected as a wish', () => {
    const result = checkOutcomeBindable(
      'FEATURE',
      'the service returns the new field',
      policies,
      new Set(['project_management'] as const),
    );
    assert.equal(result.outcome.result, 'FAIL');
    assert.match(result.outcome.detail, /wish rather than an outcome/);
  });

  test('an external identity deduplicates against a prior run of the same item', () => {
    const identity: IdentityResolution = {
      outcome: 'RESOLVED', identity: 'jira:DEF-456', evidence: fx.evidence({ id: 'E-pm' }),
    };
    const first = deriveIdentity(identity, 'anything', fx.EMPTY_SCOPE, []);
    const existing: WorkItem = fx.workItem({
      work_item_id: first.workItemId,
      external_identity: 'jira:DEF-456',
      lifecycle: 'BLOCKED',
    });
    const second = deriveIdentity(identity, 'a different title entirely', fx.scope(), [existing]);
    assert.equal(
      second.workItemId,
      first.workItemId,
      'identity comes from the external key, so a reworded intake is the same work item',
    );
    assert.match(second.check.detail, /deduplicates/);
    assert.deepEqual(second.duplicateCandidates, []);
  });

  test('an intake reworded past normalization is the same work item, not a candidate', () => {
    const scope = fx.scope({ paths: ['README.md'] });
    const first = deriveIdentity({ outcome: 'NOT_NAMED' }, 'Fix typo in README', scope, []);
    const existing = fx.workItem({
      work_item_id: first.workItemId,
      external_identity: null,
      title: 'Fix typo in README',
      scope,
    });
    const second = deriveIdentity(
      { outcome: 'NOT_NAMED' }, 'fix   TYPO in readme!', scope, [existing],
    );
    assert.equal(
      second.workItemId,
      first.workItemId,
      'the content-derived id is the deduplication mechanism, and it works before the similarity check does',
    );
    assert.deepEqual(second.duplicateCandidates, []);
    assert.match(second.check.detail, /the same id as the existing work item/);
  });

  test('an open work item in an intersecting scope is surfaced and never auto-merged', () => {
    /*
     * Section 4.1's similarity check. "Fix the session timeout" and "sessions expire too
     * early" are two intakes over one piece of code, and they are two work items until a
     * human says otherwise.
     */
    const existing = fx.workItem({
      work_item_id: 'wi_c_theotherone',
      external_identity: null,
      title: 'sessions expire too early',
      scope: fx.scope({ paths: ['src/session/**'] }),
      lifecycle: 'EXECUTING',
    });
    const result = deriveIdentity(
      { outcome: 'NOT_NAMED' },
      'fix the session timeout',
      fx.scope({ paths: ['src/session/store.ts'] }),
      [existing],
    );
    assert.deepEqual([...result.duplicateCandidates], ['wi_c_theotherone']);
    assert.match(result.check.detail, /never auto-merged/);
    assert.equal(
      result.check.result,
      'PASS',
      'a duplicate candidate is information for a human, not a refusal',
    );
  });

  test('a finished work item is not a duplicate candidate', () => {
    const done = fx.workItem({
      work_item_id: 'wi_c_finished',
      external_identity: null,
      scope: fx.scope({ paths: ['src/session/**'] }),
      lifecycle: 'ACHIEVED',
    });
    const result = deriveIdentity(
      { outcome: 'NOT_NAMED' }, 'fix the session timeout',
      fx.scope({ paths: ['src/session/store.ts'] }), [done],
    );
    assert.deepEqual(result.duplicateCandidates, []);
  });

  test('an item with an external identity is never a content duplicate candidate', () => {
    const external = fx.workItem({
      work_item_id: 'wi_jira_DEF_1',
      external_identity: 'jira:DEF-1',
      scope: fx.scope({ paths: ['src/session/**'] }),
      lifecycle: 'EXECUTING',
    });
    const result = deriveIdentity(
      { outcome: 'NOT_NAMED' }, 'fix the session timeout',
      fx.scope({ paths: ['src/session/store.ts'] }), [external],
    );
    assert.deepEqual(result.duplicateCandidates, []);
  });

  test('a work item admitted with candidates carries them on the record', async () => {
    const existing = fx.workItem({
      work_item_id: 'wi_c_neighbour',
      external_identity: null,
      scope: fx.scope({ paths: ['README.md'] }),
      lifecycle: 'EXECUTING',
    });
    const result = admitWorkItem(await admissionInput({ existing: [existing] }));
    assert.equal(result.outcome, 'ADMITTED');
    if (result.outcome !== 'ADMITTED') throw new Error('unreachable');
    assert.deepEqual([...result.workItem.duplicate_candidates], ['wi_c_neighbour']);
    assert.deepEqual([...result.duplicateCandidates], ['wi_c_neighbour']);
  });
});

/* ============================================================= UNDERSTOOD ==== */

/**
 * Reality with every element observed, which is what a working discovery tier 2 produces.
 *
 * Note `pr: { state: 'NONE' }` rather than `null`: a predicate over an assertion whose value
 * is null is INDETERMINATE, and "there is no pull request" is an observation rather than an
 * absence of one. Getting that distinction wrong in a fixture is how a test comes to assert
 * that the kernel treats missing knowledge as a negative answer.
 */
const OBSERVED_REALITY = {
  implementation_present: fx.factAssertion(false),
  tests_present: fx.factAssertion(false),
  pr: fx.factAssertion({ state: 'NONE' }),
  reviews: fx.factAssertion({ approved: false, unresolved_threads: 0, review_count: 0 }),
  ci: fx.factAssertion({ result: 'NONE' }),
  children: fx.factAssertion([]),
  agentos_history: fx.factAssertion([]),
  outcome_evidence: fx.factAssertion(false),
  deployment: fx.factAssertion(null),
  merge_state: fx.factAssertion({ state: 'MERGEABLE' }),
};

/** Context sections that make the applicability predicates determinate. */
const OBSERVED_SECTIONS = {
  domain_model: { canonical_ownership: fx.factAssertion({}) },
  ui_map: { surfaces: fx.factAssertion([]) },
  api_map: { endpoints: fx.factAssertion([]) },
  source_map: { sources: fx.factAssertion([]) },
};

describe('UNDERSTOOD: the five kernel-computable conditions', () => {
  async function verdict(overrides: {
    workItem?: WorkItem;
    reality?: Parameters<typeof fx.currentReality>[0];
    sections?: Record<string, Record<string, ReturnType<typeof fx.factAssertion>>>;
    access?: AdmissionInput['access'];
    resolutionConfidence?: number;
    ladderApplied?: boolean;
  } = {}) {
    const discovery = new FixtureDiscovery({
      reality: overrides.reality ?? {},
      sections: overrides.sections ?? {},
    });
    const context = await discovery.deepen();
    const workItem = overrides.workItem ?? fx.workItemOfType('TASK');
    return computeUnderstood({
      workItem,
      policies,
      context,
      evaluator: new PredicateEvaluator(policies, new FixedClock(), discovery),
      predicateInputs: { context, workItem, capabilities: [], mutations: [] },
      access: overrides.access ?? FULL_ACCESS,
      resolutionConfidence: overrides.resolutionConfidence ?? 0.9,
      ladderApplied: overrides.ladderApplied ?? false,
    });
  }

  test('a fully observed task is SUFFICIENT and reports all five conditions', async () => {
    const result = await verdict({
      reality: OBSERVED_REALITY,
      sections: OBSERVED_SECTIONS,
    });
    assert.equal(result.verdict, 'SUFFICIENT');
    assert.deepEqual(result.undeterminedPredicates, []);
    assert.deepEqual(
      result.conditions.map((c) => c.check),
      [
        'type_known_or_investigation', 'outcome_binds_to_profile',
        'entry_predicates_determinate', 'blocking_unknowns_handled', 'resolution_confidence',
      ],
      'the five conditions, in the order the document lists them',
    );
  });

  test('an INSUFFICIENT verdict names the undetermined predicates', async () => {
    const result = await verdict({ reality: {} });
    assert.equal(result.verdict, 'INSUFFICIENT');
    assert.ok(
      result.undeterminedPredicates.length > 0,
      'naming the predicate names the discovery that would resolve it',
    );
    const failing = result.conditions.find((c) => c.check === 'entry_predicates_determinate');
    assert.equal(failing?.result, 'FAIL');
    for (const predicate of result.undeterminedPredicates) {
      assert.ok(
        failing?.detail.includes(predicate),
        `the condition names ${predicate} rather than merely reporting that something is undetermined`,
      );
    }
    assert.match(failing?.detail ?? '', /makes this failure actionable/);
  });

  test('an UNKNOWN element is INDETERMINATE, never a negative answer', async () => {
    /*
     * The distinction the whole absence vocabulary exists for. An unreachable PR host makes
     * `reality.pr_open` INDETERMINATE, and INDETERMINATE is not "there is no PR".
     */
    const result = await verdict({
      reality: { ...OBSERVED_REALITY, pr: fx.unknownAssertion({ reason: 'UNAVAILABLE' }) },
      sections: OBSERVED_SECTIONS,
    });
    assert.equal(result.verdict, 'INSUFFICIENT');
    assert.deepEqual([...result.undeterminedPredicates], ['reality.pr_open']);
  });

  test('an UNKNOWN type is sufficient, because it routes to investigation rather than guessing', async () => {
    const result = await verdict({
      workItem: fx.workItemOfType('UNKNOWN'),
      reality: OBSERVED_REALITY,
      sections: OBSERVED_SECTIONS,
    });
    const condition = result.conditions.find((c) => c.check === 'type_known_or_investigation');
    assert.equal(condition?.result, 'PASS');
    assert.match(condition?.detail ?? '', /investigation/i);
    assert.equal(
      result.verdict,
      'SUFFICIENT',
      'not knowing what the work is does not block understanding it; it decides what to do about it',
    );
  });

  test('an outcome that binds to no checkable profile is insufficient', async () => {
    const result = await verdict({
      workItem: fx.workItem({ type: 'FEATURE', candidate_dod_profiles: [] }),
      reality: OBSERVED_REALITY,
      sections: OBSERVED_SECTIONS,
      access: new Set(['project_management'] as const),
    });
    assert.equal(result.verdict, 'INSUFFICIENT');
    assert.ok(result.conditions.some(
      (c) => c.check === 'outcome_binds_to_profile' && c.result === 'FAIL',
    ));
  });

  test('low resolution confidence is insufficient until the ladder has been applied', async () => {
    const unresolved = await verdict({
      reality: OBSERVED_REALITY, sections: OBSERVED_SECTIONS, resolutionConfidence: 0.2,
    });
    assert.equal(unresolved.verdict, 'INSUFFICIENT');
    assert.ok(result_condition(unresolved.conditions, 'resolution_confidence') !== 'PASS');
    const laddered = await verdict({
      reality: OBSERVED_REALITY,
      sections: OBSERVED_SECTIONS,
      resolutionConfidence: 0.2,
      ladderApplied: true,
    });
    assert.equal(
      laddered.verdict,
      'SUFFICIENT',
      'the ladder is what turns low confidence into a recorded decision; running it is the fix',
    );
  });

  test('the entry predicates of a template include every satisfied_by it depends on', () => {
    const template = policies.templates.get('defect.standard');
    assert.ok(template !== undefined);
    const entries = entryPredicates(template, policies);
    const names = entries.map((e) => e.predicate);
    assert.ok(names.includes('reality.stage_completed_previously'));
    assert.ok(names.includes('reality.implementation_present'));
    assert.ok(names.includes('reality.pr_reviewed'));
    assert.deepEqual([...names], [...names].sort(), 'sorted, so the report is stable');
    assert.ok(
      entries.filter((e) => e.predicate === 'reality.stage_completed_previously').length > 1,
      'a stage-parameterized predicate is asked once per stage that declares it, because '
      + '"did we analyse this" is a question about a particular stage',
    );
    assert.equal(
      entries.find((e) => e.predicate === 'reality.pr_merged')?.stage,
      'MERGE',
    );
  });
});

function result_condition(
  conditions: readonly { check: string; result: string }[],
  name: string,
): string {
  return conditions.find((c) => c.check === name)?.result ?? 'MISSING';
}

/* ==================================================== workflow admission ==== */

describe('workflow admission: what this installation will execute', () => {
  /*
   * v0.3 ships read-only. `policies/data/execution.json` admits READ_ONLY only, which is the
   * milestone-1 safety property and is checked here first: it holds for every work item type,
   * and it holds in the layer that selects the graph rather than in the layer that would have
   * performed the mutation.
   */
  async function admitUnder(
    set: typeof policies,
    overrides: {
      workItem?: WorkItem;
      proposal?: WorkflowProposal | null;
      reality?: Parameters<typeof fx.currentReality>[0];
      sections?: Record<string, Record<string, ReturnType<typeof fx.factAssertion>>>;
      profile?: Parameters<typeof admitWorkflow>[0]['profile'];
      outcomeAlreadySatisfied?: boolean;
    } = {},
  ) {
    const discovery = new FixtureDiscovery({
      reality: overrides.reality ?? OBSERVED_REALITY,
      sections: overrides.sections ?? OBSERVED_SECTIONS,
    });
    const context = await discovery.deepen();
    const workItem = overrides.workItem ?? fx.workItemOfType('DEFECT');
    return admitWorkflow({
      workItem,
      policies: set,
      proposal: overrides.proposal ?? null,
      evaluator: new PredicateEvaluator(set, new FixedClock(), discovery),
      predicateInputs: { context, workItem, capabilities: [], mutations: [] },
      profile: overrides.profile ?? 'fix',
      outcomeAlreadySatisfied: overrides.outcomeAlreadySatisfied ?? false,
    });
  }

  function proposal(overrides: Partial<WorkflowProposal> = {}): WorkflowProposal {
    return {
      template_id: 'defect.standard',
      include_optional: [],
      exclude_optional: [],
      rationale: 'the Orchestrator proposes',
      ...overrides,
    };
  }

  test('a mutating template is inadmissible in a read-only installation, whatever the type', async () => {
    for (const type of ['DEFECT', 'STORY', 'FEATURE', 'TASK', 'INCIDENT'] as const) {
      const result = await admitUnder(policies, {
        workItem: fx.workItemOfType(type),
        profile: 'audit',
      });
      assert.equal(
        result.graph.template_id,
        'investigation.readonly',
        `a ${type} resolves to the read-only template while this installation admits READ_ONLY only`,
      );
      assert.equal(result.graph.risk_class, 'READ_ONLY');
      assert.match(
        result.checks.find((c) => c.check === 'admissible_set')?.detail ?? '',
        /exceed the risk classes this installation executes/,
      );
    }
  });

  test('the read-only floor is not something a proposal can argue with', async () => {
    const result = await admitUnder(policies, { proposal: proposal() });
    assert.equal(result.graph.template_id, 'investigation.readonly');
    assert.ok(result.override !== null);
    assert.equal(result.override.proposedTemplate, 'defect.standard');
  });

  test('the risk class is derived from the graph, never proposed', () => {
    const readOnly = policies.templates.get('investigation.readonly');
    const defect = policies.templates.get('defect.standard');
    assert.ok(readOnly !== undefined && defect !== undefined);
    assert.equal(deriveRiskClass([...readOnly.stages], policies).riskClass, 'READ_ONLY');
    assert.equal(deriveRiskClass([...defect.stages], policies).riskClass, 'IRREVERSIBLE');
    assert.match(
      deriveRiskClass([...defect.stages], policies).reason,
      /MERGE/,
      'the class states which stage made it that class',
    );
    assert.equal(
      deriveRiskClass(['IMPLEMENTATION', 'VALIDATION', 'COMPLETION'], policies).riskClass,
      'LOCAL_MUTATION',
    );
    assert.equal(
      deriveRiskClass(['IMPLEMENTATION', 'PR_PREPARATION', 'COMPLETION'], policies).riskClass,
      'EXTERNAL_MUTATION',
    );
  });

  test('scope containment is a real subset test, not a string comparison', () => {
    const outer: Scope = { paths: ['src/**'], capabilities: [], repositories: ['subject'] };
    assert.equal(
      scopeContained({ paths: ['src/a.ts'], capabilities: [], repositories: ['subject'] }, outer),
      true,
    );
    assert.equal(
      scopeContained({ paths: ['lib/a.ts'], capabilities: [], repositories: ['subject'] }, outer),
      false,
    );
    assert.equal(
      scopeContained({ paths: ['src/a.ts'], capabilities: [], repositories: ['other'] }, outer),
      false,
      'a repository the work item does not name is out of scope however the path reads',
    );
  });

  test('the most conservative admissible template does not depend on candidate order', () => {
    const readOnly = policies.templates.get('investigation.readonly');
    const defect = policies.templates.get('defect.standard');
    assert.ok(readOnly !== undefined && defect !== undefined);
    assert.equal(
      mostConservative([defect, readOnly])?.template_id,
      mostConservative([readOnly, defect])?.template_id,
    );
    assert.equal(mostConservative([readOnly])?.template_id, 'investigation.readonly');
    assert.equal(mostConservative([])?.template_id, undefined);
  });
});

describe('workflow admission with mutating templates admissible', () => {
  /*
   * The selection mechanics, run against a copy of the real policy set with
   * `admissible_risk_classes` widened — which is exactly what enabling milestone 2 will be.
   * Without this the six run-start checks are unexercisable, because a read-only installation
   * never has more than one candidate to choose between.
   */
  const mutating = policiesAllowingMutation();

  async function admit(overrides: {
    workItem?: WorkItem;
    proposal?: WorkflowProposal | null;
    reality?: Parameters<typeof fx.currentReality>[0];
    sections?: Record<string, Record<string, ReturnType<typeof fx.factAssertion>>>;
    profile?: Parameters<typeof admitWorkflow>[0]['profile'];
    outcomeAlreadySatisfied?: boolean;
  } = {}) {
    const discovery = new FixtureDiscovery({
      reality: overrides.reality ?? OBSERVED_REALITY,
      sections: overrides.sections ?? OBSERVED_SECTIONS,
    });
    const context = await discovery.deepen();
    const workItem = overrides.workItem ?? fx.workItemOfType('DEFECT');
    return admitWorkflow({
      workItem,
      policies: mutating,
      proposal: overrides.proposal ?? null,
      evaluator: new PredicateEvaluator(mutating, new FixedClock(), discovery),
      predicateInputs: { context, workItem, capabilities: [], mutations: [] },
      profile: overrides.profile ?? 'fix',
      outcomeAlreadySatisfied: overrides.outcomeAlreadySatisfied ?? false,
    });
  }

  function proposal(overrides: Partial<WorkflowProposal> = {}): WorkflowProposal {
    return {
      template_id: 'defect.standard',
      include_optional: [],
      exclude_optional: [],
      rationale: 'the Orchestrator proposes',
      ...overrides,
    };
  }

  test('with no proposal the most conservative admissible template applies', async () => {
    const result = await admit();
    assert.deepEqual(
      [...result.admissibleTemplates],
      ['defect.standard', 'investigation.readonly'],
    );
    assert.equal(
      result.graph.template_id,
      'defect.standard',
      'the most conservative template is the one whose stage set is a superset of the others '
      + '(WORKFLOW_STATE_MACHINE 3.4): more stages means more verification, so an unproposed '
      + 'run gets the fullest pipeline rather than the shortest',
    );
    assert.equal(result.override, null);
  });

  test('a proposal naming an admissible template for the type is accepted', async () => {
    const result = await admit({ proposal: proposal() });
    assert.equal(result.graph.template_id, 'defect.standard');
    assert.equal(result.override, null);
    assert.equal(result.graph.risk_class, 'IRREVERSIBLE');
  });

  test('a proposal naming a template the type does not map to is refused, not negotiated', async () => {
    const result = await admit({ proposal: proposal({ template_id: 'task.direct' }) });
    assert.notEqual(result.graph.template_id, 'task.direct');
    assert.ok(result.override !== null);
    assert.equal(result.override.proposedTemplate, 'task.direct');
    assert.ok(
      result.override.failedChecks.some((c) => c.result === 'FAIL'),
      'the failure is recorded rather than the proposal being adjusted into something admissible',
    );
    assert.match(result.override.reason, /.+/);
  });

  test('a proposal naming a template that does not exist falls back and says so', async () => {
    const result = await admit({ proposal: proposal({ template_id: 'defect.yolo' }) });
    assert.ok(result.override !== null);
    assert.ok(result.override.failedChecks.some((c) => c.check === 'template_exists'));
  });

  test('excluding a stage with no applicability predicate is refused', async () => {
    /*
     * `ROOT_CAUSE` is mandatory in `defect.standard` and declares no applicability predicate,
     * so no observation could make it optional. A proposal to drop it is a proposal to permit
     * symptom patching.
     */
    const result = await admit({
      proposal: proposal({
        exclude_optional: [{
          stage: 'ROOT_CAUSE',
          claim: 'the cause is obvious from the report',
          rationale: 'saves a lap',
        }],
      }),
    });
    assert.ok(result.graph.stages.includes('ROOT_CAUSE'));
    assert.ok(result.graph.excluded_stages.every((e) => e.stage !== 'ROOT_CAUSE'));
  });

  test('excluding an optional stage whose predicate is TRUE is refused', async () => {
    /*
     * `architecture.required` holds when the scope reaches a declared contract boundary. An
     * optional stage is only optional while its predicate says so, and the predicate is the
     * kernel's to evaluate rather than the agent's to claim.
     */
    const result = await admit({
      workItem: fx.workItem({
        type: 'DEFECT',
        scope: {
          paths: ['contracts/schema/work-item.json'],
          capabilities: [],
          repositories: ['subject'],
        },
      }),
      sections: {
        ...OBSERVED_SECTIONS,
        source_map: { sources: fx.factAssertion(['contracts/schema/**']) },
      },
      proposal: proposal({
        exclude_optional: [{
          stage: 'ARCHITECTURE',
          claim: 'no contract boundary is touched',
          rationale: 'small change',
        }],
      }),
    });
    const evaluated = result.evaluations.find((e) => e.predicate === 'architecture.required');
    assert.ok(evaluated !== undefined, 'the kernel evaluated the predicate itself');
    /*
     * The precondition is asserted rather than branched on. `architecture.required` is only
     * satisfiable by an observation, and the scope here reaches a declared contract boundary,
     * so it is TRUE — and if it ever stopped being TRUE this test would have to say so out
     * loud rather than quietly stop checking anything.
     */
    assert.equal(
      evaluated.value,
      'TRUE',
      'the scope reaches a declared contract boundary, so the stage is not optional here',
    );
    assert.ok(
      result.graph.stages.includes('ARCHITECTURE'),
      'TRUE or INDETERMINATE keeps the stage: including a review costs only tokens',
    );
    assert.ok(result.violations.some((v) => v.code === 'EXCLUSION_PREDICATE_NOT_FALSE'));
    assert.ok(
      result.graph.excluded_stages.every((e) => e.stage !== 'ARCHITECTURE'),
      'and the stage is not recorded as excluded either: the claim was overridden, not honoured',
    );
  });

  test('an excluded stage records the predicate and the value the kernel evaluated', async () => {
    const result = await admit({
      proposal: proposal({
        exclude_optional: [{
          stage: 'UX_REVIEW',
          claim: 'no user-facing surface changes',
          rationale: 'backend only',
        }],
      }),
    });
    assert.ok(
      result.evaluations.some((e) => e.predicate === 'ux.required'),
      'the kernel evaluated the predicate itself, whatever the claim said',
    );
    const excluded = result.graph.excluded_stages.find((e) => e.stage === 'UX_REVIEW');
    assert.ok(excluded !== undefined, 'ui_map is empty, so ux.required is FALSE and the stage goes');
    assert.equal(excluded.evaluated, 'FALSE');
    assert.equal(excluded.predicate, 'ux.required');
    assert.ok(!result.graph.stages.includes('UX_REVIEW'));
  });

  test('an excluded stage leaves a well-formed graph, because the template carries the bypass', async () => {
    const result = await admit({
      proposal: proposal({
        exclude_optional: [{
          stage: 'UX_REVIEW', claim: 'no surfaces', rationale: 'backend only',
        }],
      }),
    });
    const graph = result.graph;
    assert.ok(!graph.stages.includes('UX_REVIEW'));
    assert.ok(graph.edges.every((e) => e.from !== 'UX_REVIEW' && e.to !== 'UX_REVIEW'));
    assert.ok(
      graph.edges.some((e) => e.from === 'STRUCTURAL_REAUDIT' && e.to === 'PR_PREPARATION'),
      'the bypass edge the template declared is what keeps the graph connected',
    );
  });

  test('a stage mandate wider than the work item scope is refused', async () => {
    const result = await admit({
      workItem: fx.workItem({
        type: 'DEFECT',
        scope: { paths: ['src/session/**'], capabilities: [], repositories: ['subject'] },
      }),
      proposal: proposal({
        stage_mandates: {
          IMPLEMENTATION: { paths: ['**'], capabilities: [], repositories: ['subject'] },
        },
      }),
    });
    assert.ok(
      result.violations.some((v) => v.code === 'SCOPE_EXCEEDS_WORK_ITEM')
      || (result.override?.failedChecks ?? []).some((c) => c.result === 'FAIL'),
      'a stage cannot be granted reach the work item was never admitted to have',
    );
    const mandate = result.graph.stage_mandates['IMPLEMENTATION'];
    assert.ok(
      mandate === undefined || !mandate.paths.includes('**'),
      'and the over-wide mandate does not survive into the frozen graph',
    );
  });

  test('a stage mandate inside the work item scope is accepted and frozen', async () => {
    const result = await admit({
      workItem: fx.workItem({
        type: 'DEFECT',
        scope: { paths: ['src/session/**'], capabilities: [], repositories: ['subject'] },
      }),
      proposal: proposal({
        stage_mandates: {
          IMPLEMENTATION: {
            paths: ['src/session/store.ts'], capabilities: [], repositories: ['subject'],
          },
        },
      }),
    });
    assert.deepEqual(
      result.graph.stage_mandates['IMPLEMENTATION']?.paths,
      ['src/session/store.ts'],
    );
  });

  test('the frozen graph carries what a run needs to be replayed', async () => {
    const result = await admit({ proposal: proposal() });
    const graph = result.graph;
    assert.equal(graph.entry, graph.stages[0]);
    assert.ok(graph.stages.includes('COMPLETION'));
    assert.ok(graph.edges.some((e) => e.to === 'COMPLETE'));
    assert.equal(typeof graph.template_version, 'string');
    assert.equal(
      graph.dod_profile_default,
      'fix',
      'the profile is frozen with the graph, so a mid-run policy edit cannot change the bar',
    );
  });

  test('an already-satisfied outcome admits a COMPLETION-only read-only run', async () => {
    /*
     * WORKFLOW_STATE_MACHINE 5.3. It does not re-implement and it does not declare victory
     * either: the DoD still runs, against real evidence, and can return INDETERMINATE.
     */
    const result = await admit({
      profile: 'audit',
      outcomeAlreadySatisfied: true,
      reality: { ...OBSERVED_REALITY, outcome_evidence: fx.factAssertion(true) },
    });
    assert.equal(result.graph.template_id, 'investigation.readonly');
    assert.deepEqual([...result.graph.stages], ['COMPLETION']);
    assert.equal(result.graph.risk_class, 'READ_ONLY');
    assert.match(
      result.checks.find((c) => c.check === 'outcome_already_satisfied')?.detail ?? '',
      /nothing is re-implemented and no second PR is opened/,
    );
  });

  test('the COMPLETION-only parameterization is not something an agent can propose', async () => {
    const result = await admit({
      profile: 'audit',
      outcomeAlreadySatisfied: true,
      proposal: proposal({ template_id: 'investigation.readonly' }),
      reality: { ...OBSERVED_REALITY, outcome_evidence: fx.factAssertion(true) },
    });
    assert.ok(result.override !== null);
    assert.match(result.override.reason, /not proposable/);
  });
});
