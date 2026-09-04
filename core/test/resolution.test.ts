import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtures as fx,
  type CapabilityRecord,
  type ContextPackage,
  type Evidence,
  type ProposedWorkItem,
  type Scope,
} from '@agentos/contracts';
import { loadPolicies } from '@agentos/policies';
import {
  admitWorkItem,
  checkTypeEvidence,
  type AdmissionInput,
} from '../src/admission.js';
import { computeUnderstood } from '../src/understood.js';
import { PredicateEvaluator } from '../src/predicates.js';
import type { VerificationReport } from '../src/evidence-verification.js';
import { FixedClock, FixtureDiscovery } from './doubles.js';

/**
 * WP-6: what the kernel checks before it believes what the work *is*.
 *
 * Every test here is a regression: each one failed before the defect above it was closed, and
 * each names the specific way a proposal could previously become kernel truth without the
 * check that was supposed to stop it.
 */

const policies = loadPolicies();
const ACCESS = new Set(['repository', 'git'] as const);
const FULL_ACCESS = new Set([
  'repository', 'git', 'project_management', 'runtime', 'production',
] as const);

async function ctx(
  reality: Parameters<typeof fx.currentReality>[0] = {},
  options: ConstructorParameters<typeof FixtureDiscovery>[0] = {},
): Promise<ContextPackage> {
  return new FixtureDiscovery({ reality, ...options }).deepen();
}

/** Evidence that names a path, which is what "the named path exists" needs. */
function fileEvidence(id: string, path: string): Evidence {
  return fx.evidence({
    id,
    kind: 'file',
    locator: { adapter: 'repo', op: 'read_file', args: { path } },
    ref: path,
  });
}

function proposal(overrides: Partial<ProposedWorkItem> = {}): ProposedWorkItem {
  return {
    source_intake: 'in_0001',
    intent: fx.inferenceAssertion('MODIFY_ARTIFACT'),
    type: fx.inferenceAssertion('TASK'),
    external_identity: fx.unknownAssertion({ reason: 'NOT_APPLICABLE' }),
    /* The envelope form of decision I-5: the assertion cites an id into the envelope's pool. */
    title: fx.factAssertion('Fix typo in README', { evidence: ['E-01'] }),
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

async function input(overrides: Partial<AdmissionInput> = {}): Promise<AdmissionInput> {
  return {
    intake: fx.intakeRecord(),
    proposal: proposal(),
    policies,
    context: await ctx(),
    capabilities: [],
    capabilityRegistryAvailable: true,
    evidence: [fileEvidence('E-01', 'README.md')],
    verification: null,
    identity: { outcome: 'NOT_NAMED' },
    existing: [],
    access: ACCESS,
    now: fx.T1,
    ...overrides,
  };
}

function check(checks: readonly { check: string; result: string; detail: string }[], name: string) {
  return checks.find((c) => c.check === name);
}

/* ============================ A1: check 1 resolves the envelope's evidence pool ==== */

describe('admission check 1: every field is an assertion, every FACT carries evidence', () => {
  test('a FACT citing an evidence id resolves against the envelope\'s pool', async () => {
    /*
     * The regression. Check 1 walked only *inline* `Evidence` hanging off FACT assertions and
     * recorded PASS unconditionally, so an envelope-form proposal — the form decision I-5
     * describes and the form the frozen document's own worked example uses — arrived at the
     * type check with **zero** evidence. `DEFECT`, `TASK`, `STORY` and `INCIDENT` would all
     * have failed their own minimums for the reason that nobody passed the pool in.
     */
    const result = admitWorkItem(await input());
    assert.equal(result.outcome, 'ADMITTED');
    if (result.outcome !== 'ADMITTED') throw new Error('unreachable');
    assert.equal(
      result.workItem.type,
      'TASK',
      'the type is admissible on evidence cited by id, exactly as on evidence inlined',
    );
    const schema = check(result.checks, 'schema_and_confidence');
    assert.equal(schema?.result, 'PASS');
    assert.match(schema?.detail ?? '', /1 evidence reference\(s\) resolved against a pool of 1/);
  });

  test('inline evidence and an id into the pool are the same evidence', async () => {
    const inline = admitWorkItem(await input({
      proposal: proposal({
        title: fx.factAssertion('Fix typo in README', {
          evidence: [fileEvidence('E-01', 'README.md')],
        }),
      }),
      evidence: [],
    }));
    assert.equal(inline.outcome, 'ADMITTED');
    if (inline.outcome !== 'ADMITTED') throw new Error('unreachable');
    assert.equal(inline.workItem.type, 'TASK');
  });

  test('a FACT citing an id nothing supplies is a dangling reference and a violation', async () => {
    /*
     * Invariant 5. A FACT resting on an id the pool does not contain is a FACT nothing
     * supports, and admitting it would make the evidence discipline decorative.
     */
    const result = admitWorkItem(await input({
      proposal: proposal({ title: fx.factAssertion('Fix typo', { evidence: ['E-nowhere'] }) }),
      evidence: [],
    }));
    assert.equal(result.outcome, 'REJECTED');
    if (result.outcome !== 'REJECTED') throw new Error('unreachable');
    assert.ok(result.violations.some((v) => v.code === 'DANGLING_EVIDENCE_REFERENCE'));
    assert.match(
      result.violations.find((v) => v.code === 'DANGLING_EVIDENCE_REFERENCE')?.message ?? '',
      /a FACT nothing supports/i,
    );
  });

  test('a FACT with no evidence at all is refused', async () => {
    const result = admitWorkItem(await input({
      proposal: proposal({ title: fx.factAssertion('Fix typo', { evidence: [] }) }),
    }));
    assert.equal(result.outcome, 'REJECTED');
    if (result.outcome !== 'REJECTED') throw new Error('unreachable');
    assert.ok(result.violations.some((v) => v.code === 'ASSERTION_WITHOUT_CONFIDENCE'));
  });
});

/* ================================================ A2: the evidence replays ==== */

describe('admission check 1 ends "the evidence replays"', () => {
  function report(overrides: Partial<VerificationReport> = {}): VerificationReport {
    return {
      outcomes: [],
      mismatchCount: 0,
      rejectEnvelope: false,
      violations: [],
      demotedFindings: [],
      downgrades: [],
      ...overrides,
    };
  }

  test('evidence that did not replay supports nothing, so the type it carried downgrades', async () => {
    /*
     * The regression. Nothing called the verifier from admission, so a fabricated locator
     * admitted a type on evidence that does not exist. Withdrawing it is not a decoration on
     * the check: a type admitted on evidence that failed to replay is a type admitted on
     * nothing.
     */
    const result = admitWorkItem(await input({
      verification: report({
        outcomes: [{
          evidence_id: 'E-01',
          status: 'MISMATCH',
          selected_because: 'SAMPLED',
          detail: 'replayed through repo and the result differs',
        }],
        mismatchCount: 1,
      }),
    }));
    assert.equal(result.outcome, 'ADMITTED');
    if (result.outcome !== 'ADMITTED') throw new Error('unreachable');
    assert.equal(
      result.workItem.type,
      'UNKNOWN',
      'TASK needs the named path to exist, and the only evidence for it did not replay',
    );
    assert.equal(result.workItem.claimed_type, 'TASK');
    assert.equal(check(result.checks, 'schema_and_confidence')?.result, 'INDETERMINATE');
    assert.match(
      check(result.checks, 'schema_and_confidence')?.detail ?? '',
      /1 withdrawn as unconfirmed/,
    );
  });

  test('evidence that replayed and matched supports the type it carries', async () => {
    const result = admitWorkItem(await input({
      verification: report({
        outcomes: [{
          evidence_id: 'E-01',
          status: 'VERIFIED',
          selected_because: 'SAMPLED',
          detail: 'replayed through repo and the result matches',
        }],
      }),
    }));
    assert.equal(result.outcome, 'ADMITTED');
    if (result.outcome !== 'ADMITTED') throw new Error('unreachable');
    assert.equal(result.workItem.type, 'TASK');
    assert.equal(check(result.checks, 'schema_and_confidence')?.result, 'PASS');
  });

  test('the two-strikes rule refuses the proposal outright', async () => {
    /*
     * One fabrication is a defect; two is an untrustworthy witness, and a resolution is
     * exactly the thing that must not be built on one.
     */
    const result = admitWorkItem(await input({
      verification: report({ mismatchCount: 2, rejectEnvelope: true }),
    }));
    assert.equal(result.outcome, 'REJECTED');
    if (result.outcome !== 'REJECTED') throw new Error('unreachable');
    assert.ok(result.violations.some((v) => v.code === 'EVIDENCE_MISMATCH_THRESHOLD'));
  });

  test('an admission with no verification says so rather than implying one happened', async () => {
    const result = admitWorkItem(await input({ verification: null }));
    assert.match(
      check(result.checks, 'schema_and_confidence')?.detail ?? '',
      /the evidence was not replayed for this admission/,
    );
  });
});

/* ========================= A3: the capability registry, present or unavailable ==== */

describe('the capability requirements are INDETERMINATE when nothing could read the registry', () => {
  const featureScope: Scope = {
    paths: ['src/sync/**'], capabilities: [], repositories: ['subject'],
  };

  test('an unreadable registry does not silently admit every FEATURE', async () => {
    /*
     * The regression, and the most consequential of the set. The live path passed
     * `capabilities: []` into admission, so `no_capability_record_intersecting_scope` was
     * satisfied by an empty list — every FEATURE passed for the reason that nobody looked —
     * and `capability_record_intersecting_scope` failed for the same reason, downgrading every
     * DEFECT. An empty registry and an unreadable one are the same array and opposite facts.
     */
    const unavailable = checkTypeEvidence(
      'FEATURE',
      [fileEvidence('E-1', 'src/sync/a.ts')],
      featureScope,
      [],
      { outcome: 'NOT_NAMED' },
      await ctx(),
      policies.workItems,
      false,
    );
    assert.equal(unavailable.admittedType, 'UNKNOWN');
    assert.equal(unavailable.outcome.result, 'INDETERMINATE');
    assert.match(unavailable.outcome.detail, /An unreadable registry is not an empty one/);
    assert.match(unavailable.outcome.detail, /could not be judged/);
  });

  test('an empty but readable registry does admit a FEATURE, which is the honest answer', async () => {
    const available = checkTypeEvidence(
      'FEATURE',
      [fileEvidence('E-1', 'src/sync/a.ts')],
      featureScope,
      [],
      { outcome: 'NOT_NAMED' },
      await ctx(),
      policies.workItems,
      true,
    );
    assert.equal(available.admittedType, 'FEATURE');
    assert.equal(available.outcome.result, 'PASS');
  });

  test('an unreadable registry downgrades a DEFECT too, and says why', async () => {
    const record: CapabilityRecord = fx.capabilityRecord({
      id: 'cap.sync', scope_paths: ['src/sync/**'],
    });
    const readable = checkTypeEvidence(
      'DEFECT',
      [fileEvidence('E-1', 'src/sync/a.ts'), fx.evidence({ id: 'E-2', kind: 'log' })],
      featureScope, [record], { outcome: 'NOT_NAMED' }, await ctx(), policies.workItems, true,
    );
    assert.equal(readable.admittedType, 'DEFECT');

    const blind = checkTypeEvidence(
      'DEFECT',
      [fileEvidence('E-1', 'src/sync/a.ts'), fx.evidence({ id: 'E-2', kind: 'log' })],
      featureScope, [], { outcome: 'NOT_NAMED' }, await ctx(), policies.workItems, false,
    );
    assert.equal(blind.admittedType, 'UNKNOWN');
    assert.equal(
      blind.outcome.result,
      'INDETERMINATE',
      'FAIL would say the evidence was looked for and missing; nobody looked',
    );
  });

  test('an UNKNOWN children element makes an EPIC INDETERMINATE rather than not-an-Epic', async () => {
    const result = checkTypeEvidence(
      'EPIC',
      [fx.evidence({ id: 'E-epic', kind: 'ticket' })],
      featureScope, [], { outcome: 'NOT_NAMED' },
      await ctx({ children: fx.unknownAssertion({ reason: 'UNAVAILABLE' }) }),
      policies.workItems,
    );
    assert.equal(result.admittedType, 'UNKNOWN');
    assert.equal(result.outcome.result, 'INDETERMINATE');
  });
});

/* ================================ A4: named_path_exists means the named path ==== */

describe('"the named path exists" means the evidence establishes the named path', () => {
  test('file evidence for an unrelated path does not bound the scope', async () => {
    /*
     * The regression. The fallback was `evidence.some(e => e.kind === 'file')`, so *any* file
     * evidence anywhere satisfied it — which made "the work names something that exists" mean
     * "the agent read some file", a requirement a proposal could satisfy with its scope
     * bounded by nothing at all.
     */
    const elsewhere = checkTypeEvidence(
      'TASK',
      [fileEvidence('E-elsewhere', 'src/unrelated/thing.ts')],
      { paths: ['README.md'], capabilities: [], repositories: ['subject'] },
      [], { outcome: 'NOT_NAMED' }, await ctx(), policies.workItems,
    );
    assert.equal(elsewhere.admittedType, 'UNKNOWN');
    assert.match(elsewhere.outcome.detail, /named_path_exists/);
  });

  test('file evidence for a path inside the scope does bound it', async () => {
    const named = checkTypeEvidence(
      'TASK',
      [fileEvidence('E-readme', 'README.md')],
      { paths: ['README.md'], capabilities: [], repositories: ['subject'] },
      [], { outcome: 'NOT_NAMED' }, await ctx(), policies.workItems,
    );
    assert.equal(named.admittedType, 'TASK');
  });

  test('a glob scope is satisfied by evidence for a file under it', async () => {
    const under = checkTypeEvidence(
      'TASK',
      [fileEvidence('E-deep', 'docs/guide/install.md')],
      { paths: ['docs/**'], capabilities: [], repositories: ['subject'] },
      [], { outcome: 'NOT_NAMED' }, await ctx(), policies.workItems,
    );
    assert.equal(under.admittedType, 'TASK');
  });

  test('file evidence whose locator names no path establishes nothing', async () => {
    const anonymous = checkTypeEvidence(
      'TASK',
      [fx.evidence({ id: 'E-x', kind: 'file', locator: { adapter: 'repo', op: 'list_paths', args: {} } })],
      { paths: ['README.md'], capabilities: [], repositories: ['subject'] },
      [], { outcome: 'NOT_NAMED' }, await ctx(), policies.workItems,
    );
    assert.equal(anonymous.admittedType, 'UNKNOWN');
  });
});

/* ============================= A5: dependencies and the parent link survive ==== */

describe('the proposal\'s dependencies and parent reach the admitted record', () => {
  test('declared dependencies are carried, not dropped', async () => {
    /*
     * The regression: `dependencies: []` was hard-coded, so declared ordering between siblings
     * vanished at the moment it became durable — and the kernel enforces ordering from the
     * declared edges, which is nothing to enforce if nothing carries them.
     */
    const result = admitWorkItem(await input({
      proposal: proposal({ dependencies: ['wi_jira_STORY-201', 'wi_jira_STORY-202'] }),
    }));
    assert.equal(result.outcome, 'ADMITTED');
    if (result.outcome !== 'ADMITTED') throw new Error('unreachable');
    assert.deepEqual(
      [...result.workItem.dependencies],
      ['wi_jira_STORY-201', 'wi_jira_STORY-202'],
    );
  });

  test('a proposed parent produces a CHILD_OF link', async () => {
    /*
     * `links: []` was hard-coded too, so a proposed parent produced no link at all — a child
     * arrived indistinguishable from a top-level item, and nothing downstream could tell.
     */
    const result = admitWorkItem(await input({
      proposal: proposal({
        parent: fx.factAssertion('jira:EPIC-336', { evidence: ['E-01'] }),
      }),
    }));
    assert.equal(result.outcome, 'ADMITTED');
    if (result.outcome !== 'ADMITTED') throw new Error('unreachable');
    assert.equal(result.workItem.links.length, 1);
    assert.equal(result.workItem.links[0]?.kind, 'CHILD_OF');
    assert.match(result.workItem.links[0]?.target ?? '', /EPIC-336/);
  });

  test('no proposed parent produces no link, rather than a link to nothing', async () => {
    const result = admitWorkItem(await input());
    assert.equal(result.outcome, 'ADMITTED');
    if (result.outcome !== 'ADMITTED') throw new Error('unreachable');
    assert.deepEqual(result.workItem.links, []);
  });
});

/* ================================================ A7: the intent is recorded ==== */

describe('what AgentOS decided the work was is carried out of admission', () => {
  test('the intent assertion and the resolver\'s confidence survive admission', async () => {
    /*
     * The `WorkItem` contract carries no `intent` field — a contract gap, reported rather than
     * fixed by widening `contracts/`. The narrative's v0.3 obligation is to state what AgentOS
     * decided the work was and why, and an intent that never leaves admission is an obligation
     * nothing can discharge. It leaves here and is written to the work-item event log.
     */
    const result = admitWorkItem(await input({
      proposal: proposal({
        intent: fx.inferenceAssertion('RESOLVE_DEFECT'),
        resolution_confidence: 0.82,
      }),
    }));
    assert.equal(result.outcome, 'ADMITTED');
    if (result.outcome !== 'ADMITTED') throw new Error('unreachable');
    assert.equal(result.intent.value, 'RESOLVE_DEFECT');
    assert.equal(result.intent.confidence, 'INFERENCE');
    assert.equal(
      result.resolutionConfidence,
      0.82,
      "the agent's own number, carried so the ladder's threshold has something to read",
    );
    assert.ok(
      !('intent' in result.workItem),
      'and it is not on the record, because the contract has no field for it',
    );
  });
});

/* ========================= A9: condition 4 has two branches, and they differ ==== */

describe('UNDERSTOOD condition 4: resolved, or with a recorded handling', () => {
  const OBSERVED = {
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
  const SECTIONS = {
    domain_model: { canonical_ownership: fx.factAssertion({}) },
    ui_map: { surfaces: fx.factAssertion([]) },
    api_map: { endpoints: fx.factAssertion([]) },
    source_map: { sources: fx.factAssertion([]) },
  };

  async function verdict(options: {
    readonly gaps?: ContextPackage['gaps'];
    readonly reality?: Parameters<typeof fx.currentReality>[0];
    readonly recordedHandlings?: ReadonlySet<string>;
  } = {}) {
    const discovery = new FixtureDiscovery({
      reality: options.reality ?? OBSERVED,
      sections: SECTIONS,
      gaps: options.gaps ?? [],
    });
    const context = await discovery.deepen();
    const workItem = fx.workItemOfType('TASK');
    return computeUnderstood({
      workItem,
      policies,
      context,
      evaluator: new PredicateEvaluator(policies, new FixedClock(), discovery),
      predicateInputs: { context, workItem, capabilities: [], mutations: [] },
      access: FULL_ACCESS,
      resolutionConfidence: 0.9,
      ladderApplied: false,
      recordedHandlings: options.recordedHandlings,
    });
  }

  const blockingGap: ContextPackage['gaps'] = [fx.unknownRecord({
    id: 'U-1',
    subject: 'current_reality.pr for this scope',
    reason: 'UNAVAILABLE',
    attempted: 'the git host was queried and timed out',
    recoverable_by: 're-read the pull request through the git adapter',
    blocks: ['completion'],
  })];

  test('a blocking unknown with nothing recorded about it fails condition 4', () => {
    /*
     * The regression. Condition 4 tested only that `recoverable_by` was non-empty — a field
     * the schema requires and requires to be non-empty, so the check passed for every
     * schema-valid Context Package and decided nothing. "Or has a recorded handling" was never
     * a distinct branch, so a gap blocking a mandatory stage with nothing done about it was
     * indistinguishable from one that had been probed.
     */
    return verdict({
      gaps: blockingGap,
      reality: { ...OBSERVED, pr: fx.unknownAssertion({ reason: 'UNAVAILABLE' }) },
    }).then((result) => {
      const condition = result.conditions.find((c) => c.check === 'blocking_unknowns_handled');
      assert.equal(condition?.result, 'FAIL');
      assert.match(condition?.detail ?? '', /U-1/);
      assert.match(condition?.detail ?? '', /nobody supplies UNDERSTOOD/);
    });
  });

  test('branch one: the element the gap names is determinate now, so it is resolved', async () => {
    const result = await verdict({ gaps: blockingGap, reality: OBSERVED });
    const condition = result.conditions.find((c) => c.check === 'blocking_unknowns_handled');
    assert.equal(condition?.result, 'PASS');
    assert.match(condition?.detail ?? '', /1 resolved since/);
  });

  test('branch two: a recorded handling is sufficient even where the gap is not resolved', async () => {
    const result = await verdict({
      gaps: blockingGap,
      reality: { ...OBSERVED, pr: fx.unknownAssertion({ reason: 'UNAVAILABLE' }) },
      recordedHandlings: new Set(['U-1']),
    });
    const condition = result.conditions.find((c) => c.check === 'blocking_unknowns_handled');
    assert.equal(condition?.result, 'PASS');
    assert.match(condition?.detail ?? '', /1 with a recorded handling/);
  });

  test('a gap blocking only an optional stage is not a mandatory obligation', async () => {
    /*
     * The condition is about unknowns that block a **mandatory** stage. A gap blocking
     * `UX_REVIEW` in a template that may legitimately exclude it does not make the workflow
     * decision indeterminate, and treating it as if it did would block runs for a stage that
     * may not even be in the graph.
     */
    const result = await verdict({
      gaps: [fx.unknownRecord({
        id: 'U-2',
        subject: 'the UI surface map',
        reason: 'NOT_COMPUTED',
        attempted: 'no ui probe ran',
        recoverable_by: 'run the ui_map probe',
            blocks: ['ux_review'],
      })],
      reality: OBSERVED,
    });
    const condition = result.conditions.find((c) => c.check === 'blocking_unknowns_handled');
    assert.equal(condition?.result, 'PASS');
  });
});
