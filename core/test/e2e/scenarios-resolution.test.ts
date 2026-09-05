import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx, type Assertion, type ContextPackage, type Evidence, type Scope } from '@agentos/contracts';
import { loadPolicies } from '@agentos/policies';
import { checkTypeEvidence } from '../../src/admission.js';
import { PredicateEvaluator } from '../../src/predicates.js';
import { decomposeEnvelope, triageEnvelope } from '../../src/orchestration.js';
import { FixedClock, FixtureDiscovery, README_CONTENT } from '../doubles.js';
import { scratchWorld, type ScratchWorld } from './world.js';
import {
  assertReadOnlyAndDurable,
  cli,
  completionVerdict,
  eventsOf,
  investigationScript,
  reachablePm,
  work,
} from './rig.js';
import { fileEvidence, investigationGraph, resolution, ticketEvidence } from './envelopes.js';

/**
 * Scenarios 1-9: what AgentOS decided the work was.
 *
 * Every end-to-end test here drives the composition root — `buildKernel` wiring the real
 * adapter framework against a real scratch git repository, the real discovery service, the
 * real registries, the real agent catalogue and the real run store, and `admitIntake`
 * dereferencing the intake source exactly as the CLI does — with the substrate, and only the
 * substrate, replaced by a recording. `agentos status` and `agentos narrate` then read the run
 * back through `main()`. That is `agentos work` with the model swapped for a script and
 * nothing else swapped.
 *
 * ## Two things a reader needs before the first assertion
 *
 * **1. `investigation.readonly` is the only admissible template in this build, by policy.**
 * `policies/data/execution.json` sets `mutation_enabled: false` and admits only `READ_ONLY`
 * risk classes, and every other template contains a mutating stage. So the templates and entry
 * stages the frozen worked scenarios name — `task.direct` at `IMPLEMENTATION`,
 * `defect.standard` at `AUDIT`, `story.standard` at `PR_REVIEW`, `epic.coordinate` at
 * `DECOMPOSITION` — are none of them reachable. That is milestone 1 working as designed, and
 * these tests say so rather than dressing the fallback up as the frozen outcome.
 *
 * **2. The five defects this suite found are fixed, and the assertions below are what the
 * corrected system does.** They are kept by name because the scenarios are read alongside the
 * decisions that repaired them, and because a scenario that no longer says why it asserts what
 * it asserts is a scenario nobody can check.
 *
 * - **D1 — `discovery/` called adapter operations with arguments the descriptors rejected.**
 *   Fixed in `discovery/` and `adapters/`: repository-, git- and history-shaped Current Reality
 *   is now established as `FACT`, so `implementation_present`, `tests_present`, `children` and
 *   `agentos_history` carry real observations and the entry-stage walk decides on them.
 *   What is still `UNAVAILABLE` in these scenarios — `pr`, `ci`, `reviews`, `merge_state`,
 *   `deployment`, `outcome_evidence` — is `UNAVAILABLE` because a scratch worktree has no git
 *   host and this build configures no runtime, which is an honest absence rather than a wiring
 *   defect, and the scenarios say which of the two they are looking at.
 * - **D2 — resolution evidence was replayed under an empty mandate, which refused every path.**
 *   Fixed by decision I-30: the replay runs under the *proposed* scope, which admission check 5
 *   bounds before anything rests on it. File evidence in a resolution envelope now survives,
 *   `named_path_exists` can be satisfied, and scenario 1 admits `TASK` — the frozen scenario A
 *   outcome — instead of downgrading it to `UNKNOWN` whatever the repository contained.
 * - **D3 — the `audit` DoD profile could never complete.** Fixed by decision I-33: the profile's
 *   criteria are the two the audit path actually supplies, 3 and 4, both owed by the Auditor's
 *   first pass, which is exactly what `AUDIT` collects. `investigation.readonly` now reaches
 *   `COMPLETE`.
 * - **D4 — source drift could never be computed for a project-management intake.** Fixed in
 *   `admitIntake` and `intakeRereaderFor`: the ticket is dereferenced once at admission through
 *   the same reader the drift check re-executes, so what is hashed and what is compared are the
 *   same text. `scenarios-reality.test.ts` scenario 16 asserts it.
 * - **D5 — an intake naming an unreachable external item was reported `REFUSED`.** Fixed: the
 *   blocker kind admission computed now travels with the outcome, so an unreachable ticket
 *   system is `BLOCKED` with `EXTERNAL_DEPENDENCY` and a wrong key is not confused with it.
 *
 * The remaining root cause was the sixth: **`CONTEXT_DISCOVERY` dispatched only the
 * `resolution` mandate**, so criterion 1 — owned by `context-discovery/context` and by nothing
 * else — was `NOT_VALIDATED` in every run of every template. The prologue now dispatches both
 * mandates, which is why every script below carries a `CONTEXT_DISCOVERY` envelope second.
 *
 * The consequence of all six is that scenarios **do** end `COMPLETE` here, and the admitted
 * type is what the evidence supports rather than `UNKNOWN` for want of a replay. Both facts
 * are asserted below.
 */

const policies = loadPolicies();
const README = { path: 'README.md', content: README_CONTENT };
const SESSION = {
  path: 'src/session.ts',
  content: 'export const SESSION_TTL_SECONDS = 300;\n',
};

const worlds: ScratchWorld[] = [];
after(() => {
  for (const world of worlds) world.destroy();
});

function newWorld(files = [README, SESSION]): ScratchWorld {
  const world = scratchWorld(files);
  worlds.push(world);
  return world;
}

function scopeOf(paths: readonly string[]): Scope {
  return { paths: [...paths], capabilities: [], repositories: ['subject'] };
}

/**
 * A Context Package with nothing observed in it.
 *
 * The type checks that read it — `child_items_exist`, `existing_change_proposal` — see UNKNOWN
 * elements and answer INDETERMINATE, which is the state a first resolution is genuinely in.
 */
function emptyContext(): Promise<ContextPackage> {
  return new FixtureDiscovery().orient();
}

/* ============================================================ 1. simple task ==== */

describe('scenario 1 — simple task ("Fix typo in README.")', () => {
  test('end to end: it resolves, runs the read-only graph, and leaves the repository byte-identical', async () => {
    const world = newWorld();
    const evidence = fileEvidence('E-01', 'README.md', README_CONTENT);
    const outcome = await work({
      world,
      raw: 'Fix typo in README.',
      script: investigationScript(
        investigationGraph({
          resolution: resolution({
            type: 'TASK',
            intent: 'MODIFY_ARTIFACT',
            title: 'Fix typo in README',
            desiredOutcome: 'the misspelling in README.md is corrected',
            scopePaths: ['README.md'],
            evidence: [evidence],
            cites: ['E-01'],
          }),
          evidence: [evidence],
          paths: ['README.md'],
          cause: 'the file was written with the wrong capitalization',
        }),
        ['README.md'],
      ),
    });

    const { narrative } = await assertReadOnlyAndDurable(world, outcome);

    /* The decided intent survives into `agentos narrate`, not only into the in-memory result.
     * This is the frozen mitigation for v0.3's residual risk and it is checked on the CLI's
     * output, because a narrative only the test can see mitigates nothing. */
    assert.match(narrative.out, /AgentOS decided this is a/);
    assert.match(narrative.out, /Fix typo in README/);
    assert.match(narrative.out, /the misspelling in README\.md is corrected/);

    assert.match(
      narrative.out,
      /template investigation\.readonly version 1\.0 was admitted from 1 admissible option\(s\)/,
      'no mutating template is admissible under mutation_enabled: false, and the run says so',
    );

    /*
     * D2 repaired, and this is the assertion that shows it. The resolution envelope's file
     * evidence is now replayed under the *proposed* scope rather than an empty mandate, it
     * survives, `named_path_exists` is satisfied, and `TASK` is admitted — the frozen scenario
     * A outcome. Nothing is downgraded, so the narrative prints no downgrade.
     */
    assert.match(narrative.out, /\*\*AgentOS decided this is a TASK\*\*/);
    assert.doesNotMatch(narrative.out, /the kernel admitted UNKNOWN/);
    assert.equal(
      outcome.built.store.getWorkItem(outcome.result.workItemId ?? '')?.claimed_type,
      null,
      'nothing was claimed and refused: TASK was claimed and TASK was admitted',
    );

    /*
     * And admitting `TASK` binds the outcome to the profiles a Task's outcome can bind to —
     * `documentation` first, by the deterministic rule — whose critical criteria 5 and 16 no
     * stage of `investigation.readonly` owns. So the run blocks on a completion it cannot
     * judge rather than reporting a false one, which is the honest end for a read-only build
     * asked to correct a file: it can audit the typo and it cannot demonstrate the correction.
     */
    assert.equal(outcome.result.outcome, 'BLOCKED');
    assert.equal(completionVerdict(outcome.log), 'INDETERMINATE');
    assert.match(
      outcome.result.detail,
      /"We could not check" is not "we checked and accepted a gap"/,
    );

    /*
     * Criterion 1 is supplied, by the mandate that owns it, and the report names the envelope
     * it came from. This is the observable end of the prologue's `context` dispatch: before it
     * existed the criterion was `NOT_VALIDATED` with `supplied_by_envelope: null` in every run
     * of every template.
     */
    const [dod] = eventsOf(outcome.log, 'dod_computed');
    assert.ok(dod !== undefined);
    assert.equal(dod.data.profile_id, 'documentation');
    const contextUnderstood = dod.data.criteria.find((c) => c.criterion === 1);
    assert.ok(contextUnderstood !== undefined, 'criterion 1 is in a Task profile');
    assert.equal(contextUnderstood.verdict, 'MET');
    assert.equal(contextUnderstood.owner_role, 'context-discovery');
    assert.equal(
      contextUnderstood.supplied_by_envelope,
      'env_context',
      'the criterion 1 verdict reached the Definition of Done inside the context mandate\'s '
      + 'own envelope, which is the only way a verdict reaches it at all',
    );
  });

  test('at the seam: TASK is admitted on evidence naming its own scope, and refused on evidence naming anything else', async () => {
    /*
     * The first half of this now happens end to end — the scenario above admits `TASK` on
     * exactly this rule. What the end-to-end half cannot show is the *negative*: a scenario
     * whose evidence names a path outside its own scope would be a scenario written to fail,
     * and the rule is what stops "the work names something that exists" from meaning "some
     * file exists". So it is exercised here directly, both ways, on evidence that reached it.
     */
    const evidence: readonly Evidence[] = [
      fx.evidence({
        id: 'E-01',
        kind: 'file',
        locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
        ref: 'README.md',
        excerpt: README_CONTENT,
      }),
    ];
    const named = checkTypeEvidence(
      'TASK', evidence, scopeOf(['README.md']), [], { outcome: 'NOT_NAMED' },
      await emptyContext(), policies.workItems,
    );
    assert.equal(named.admittedType, 'TASK');
    assert.equal(named.outcome.result, 'PASS');

    const elsewhere = checkTypeEvidence(
      'TASK', evidence, scopeOf(['src/**']), [], { outcome: 'NOT_NAMED' },
      await emptyContext(), policies.workItems,
    );
    assert.equal(
      elsewhere.admittedType,
      'UNKNOWN',
      '"the work names something that exists" has to mean the named path, not any file',
    );
  });
});

/* ================================================ 2. natural-language defect ==== */

describe('scenario 2 — natural-language defect ("Users are getting logged out after five minutes.")', () => {
  test('end to end: urgency in the wording does not become an INCIDENT, and the run says what it decided instead', async () => {
    const world = newWorld();
    const evidence = fileEvidence('E-01', 'src/session.ts', SESSION.content);
    const outcome = await work({
      world,
      raw: 'Users are getting logged out after five minutes.',
      script: investigationScript(
        investigationGraph({
          resolution: resolution({
            type: 'DEFECT',
            intent: 'RESOLVE_DEFECT',
            title: 'Sessions expire after five minutes',
            desiredOutcome:
              'sessions persist for their configured lifetime, shown by a session surviving '
              + 'past five minutes in a running environment',
            scopePaths: ['src/session.ts'],
            evidence: [evidence],
            cites: ['E-01'],
          }),
          evidence: [evidence],
          paths: ['src/session.ts'],
          cause: 'the session TTL constant is five minutes',
        }),
        ['src/session.ts'],
      ),
    });

    const { narrative, status } = await assertReadOnlyAndDurable(world, outcome);

    assert.doesNotMatch(status.out, /INCIDENT/, 'a user report is not a runtime observation');
    assert.match(narrative.out, /AgentOS decided this is a/);
    assert.match(narrative.out, /sessions persist for their configured lifetime/);

    /*
     * `DEFECT`'s evidence minimum is not a file naming its own scope but an observation of the
     * defect, and a user's report in words is not one — so the type is downgraded to `UNKNOWN`,
     * the outcome binds to `audit`, and the read-only investigation supplies both of that
     * profile's criteria. The run completes: the deliverable of an investigation is findings,
     * and the findings are there with the evidence that survived replay behind them.
     */
    assert.equal(outcome.result.outcome, 'COMPLETE');
    assert.equal(completionVerdict(outcome.log), 'COMPLETE');
    assert.match(narrative.out, /resolution claimed DEFECT and the kernel admitted UNKNOWN/);
  });

  test('at the seam: INCIDENT requires a runtime or production observation, and a report in words is not one', async () => {
    const scope = scopeOf(['src/session.ts']);
    const inWords: readonly Evidence[] = [
      fx.evidence({
        id: 'E-R',
        kind: 'ticket',
        locator: { adapter: 'pm', op: 'read_issue', args: { key: 'REP-1' } },
        ref: 'REP-1',
        excerpt: 'users say they are logged out after five minutes',
      }),
    ];
    assert.equal(
      checkTypeEvidence(
        'INCIDENT', inWords, scope, [], { outcome: 'NOT_NAMED' }, await emptyContext(),
        policies.workItems,
      ).admittedType,
      'UNKNOWN',
      'nobody declares an incident by writing the word',
    );

    const observed: readonly Evidence[] = [
      fx.evidence({
        id: 'E-M',
        kind: 'metric',
        locator: { adapter: 'runtime', op: 'query', args: { query: 'session_expiry_errors' } },
        ref: 'session_expiry_errors',
        excerpt: '412 in the last hour',
        predicate: { subject: 'count', operator: 'gt', operand: 0 },
      }),
    ];
    assert.equal(
      checkTypeEvidence(
        'INCIDENT', observed, scope, [], { outcome: 'NOT_NAMED' }, await emptyContext(),
        policies.workItems,
      ).admittedType,
      'INCIDENT',
      'a runtime observation is what makes it one',
    );
  });
});

/* ========================================================== 3. existing story ==== */

describe('scenario 3 — existing story ("Work on STORY-123.")', () => {
  const ticket = {
    key: 'STORY-123',
    type: 'Story',
    summary: 'Detect remote changes',
    status: 'In Review',
  };

  function script() {
    const ticketEv = ticketEvidence('E-T', 'STORY-123', ticket);
    const fileEv = fileEvidence('E-01', 'src/session.ts', SESSION.content);
    return investigationScript(
      investigationGraph({
        resolution: resolution({
          type: 'STORY',
          intent: 'ADVANCE_EXISTING_WORK',
          title: 'Detect remote changes',
          desiredOutcome: 'remote changes are detected and reported, demonstrated end to end',
          scopePaths: ['src/session.ts'],
          identity: 'STORY-123',
          evidence: [ticketEv, fileEv],
          cites: ['E-T'],
        }),
        evidence: [fileEv],
        paths: ['src/session.ts'],
        cause: 'the detector has no scheduler',
      }),
      ['src/session.ts'],
    );
  }

  test('end to end: the ticket is fetched through the adapter, STORY is admitted, and the id derives from it', async () => {
    const world = newWorld();
    const outcome = await work({
      world,
      source: 'PROJECT_MANAGEMENT',
      raw: 'STORY-123',
      projectManagement: reachablePm({ 'STORY-123': ticket }),
      script: script(),
    });

    const { narrative, status } = await assertReadOnlyAndDurable(world, outcome);

    /*
     * This is the one type in the suite that survives end to end, and the reason is precise:
     * `STORY`'s minimum evidence is satisfied by an *external item of this type*, and identity
     * resolution goes through the project-management adapter rather than through the evidence
     * replay D2 breaks.
     */
    assert.equal(outcome.result.workItemId, 'wi_STORY-123');
    assert.match(narrative.out, /\*\*AgentOS decided this is a STORY\*\*/);
    assert.match(
      narrative.out,
      /STORY-123 was fetched through the adapter, not accepted from the claim/,
    );
    assert.match(status.out, /wi_STORY-123: STORY/);

    /* Section 12 C's real point: the ticket's status field is authoritative about the ticket
     * and nothing else. It said "In Review"; the run did not thereby enter at PR_REVIEW. */
    assert.match(narrative.out, /entering at AUDIT/);
    assert.equal(outcome.result.outcome, 'BLOCKED');
    assert.equal(completionVerdict(outcome.log), 'INDETERMINATE');
  });

  test('end to end: a second invocation of the same ticket deduplicates onto the same work item', async () => {
    const world = newWorld();
    const options = {
      world,
      source: 'PROJECT_MANAGEMENT' as const,
      raw: 'STORY-123',
      projectManagement: reachablePm({ 'STORY-123': ticket }),
    };
    const first = await work({ ...options, script: script() });
    const second = await work({ ...options, script: script() });

    assert.equal(first.result.workItemId, second.result.workItemId);
    assert.notEqual(first.result.runId, second.result.runId, 'a second run, not a second item');

    const listing = await cli(world, ['status']);
    assert.equal(
      listing.out.split('\n').filter((line) => line.includes('wi_STORY-123')).length,
      1,
      'one work item with two runs, which is what deriving the id from the identity is for',
    );
    assert.match(listing.out, /2 run\(s\)/);
  });
});

/* ================================================================ 4. feature ==== */

describe('scenario 4 — feature ("Add GitHub issue synchronization.")', () => {
  test('end to end: it runs, and the desired outcome it is pursuing names an observation rather than a wish', async () => {
    const world = newWorld();
    const evidence = fileEvidence('E-01', 'README.md', README_CONTENT);
    const outcome = await work({
      world,
      raw: 'Add GitHub issue synchronization.',
      script: investigationScript(
        investigationGraph({
          resolution: resolution({
            type: 'FEATURE',
            intent: 'ADD_CAPABILITY',
            title: 'GitHub issue synchronization',
            desiredOutcome:
              'issues in the configured GitHub repository appear as work items in AgentOS '
              + 'within the configured interval, demonstrated end to end with a real issue',
            scopePaths: ['README.md'],
            evidence: [evidence],
            cites: ['E-01'],
          }),
          evidence: [evidence],
          paths: ['README.md'],
          cause: 'no synchronization component exists',
        }),
        ['README.md'],
      ),
    });

    const { narrative } = await assertReadOnlyAndDurable(world, outcome);
    assert.match(
      narrative.out,
      /issues in the configured GitHub repository appear as work items in AgentOS/,
      'the admitted outcome names something observable, which is what lets a DoD criterion '
      + 'bind to it at all',
    );

    /*
     * `FEATURE` needs a capability registry nobody has assembled for a first resolution, so the
     * type check is `INDETERMINATE` and the type is `UNKNOWN` — which binds the outcome to
     * `audit`, whose two criteria this graph supplies. The run completes as an investigation,
     * which is what it actually was.
     */
    assert.equal(outcome.result.outcome, 'COMPLETE');
    assert.equal(completionVerdict(outcome.log), 'COMPLETE');
  });

  test('at the seam: FEATURE is admissible only when the capability registry was actually readable', async () => {
    /*
     * End to end the registry is never readable — it is written by the Auditor into a run's
     * `capabilities/`, so an item resolved for the first time has none — and the requirement is
     * INDETERMINATE rather than answered from an empty list. An unreadable registry and an
     * empty one are the same array and opposite facts.
     */
    const evidence: readonly Evidence[] = [
      fx.evidence({ id: 'E-01', kind: 'file', ref: 'README.md', excerpt: README_CONTENT }),
    ];
    const scope = scopeOf(['adapters/**']);

    const unreadable = checkTypeEvidence(
      'FEATURE', evidence, scope, [], { outcome: 'NOT_NAMED' }, await emptyContext(),
      policies.workItems, false,
    );
    assert.equal(unreadable.admittedType, 'UNKNOWN');
    assert.equal(unreadable.outcome.result, 'INDETERMINATE');

    const readableAndEmpty = checkTypeEvidence(
      'FEATURE', evidence, scope, [], { outcome: 'NOT_NAMED' }, await emptyContext(),
      policies.workItems, true,
    );
    assert.equal(
      readableAndEmpty.admittedType,
      'FEATURE',
      'no capability record intersects the scope, and somebody actually looked',
    );
  });
});

/* ==================================================================== 5. epic ==== */

describe('scenario 5 — epic ("Implement autonomous repository synchronization.")', () => {
  const epic = {
    key: 'EPIC-9',
    type: 'Epic',
    summary: 'Autonomous repository synchronization',
    status: 'In Progress',
  };

  test('end to end (admission and fallback only): EPIC is admitted, epic.coordinate is inadmissible, and the fallback is recorded with its reason', async () => {
    /*
     * The end-to-end half of the Epic scenarios is exactly this much, and the test name says
     * so. `epic.coordinate` contains `CHILD_COORDINATION`, `deriveRiskClass` classes that
     * `EXTERNAL_MUTATION`, and `policies/data/execution.json` admits only `READ_ONLY` — so the
     * Epic's own template cannot run here and `DECOMPOSITION` is never entered. Scenarios 6 and
     * 7 assert the decomposition and linking logic at the seam.
     */
    const world = newWorld();
    const ticketEv = ticketEvidence('E-T', 'EPIC-9', epic);
    const fileEv = fileEvidence('E-01', 'README.md', README_CONTENT);
    const outcome = await work({
      world,
      source: 'PROJECT_MANAGEMENT',
      raw: 'EPIC-9',
      projectManagement: reachablePm({ 'EPIC-9': epic }),
      script: investigationScript(
        investigationGraph({
          resolution: resolution({
            type: 'EPIC',
            intent: 'ADD_CAPABILITY',
            title: 'Autonomous repository synchronization',
            desiredOutcome:
              'repositories stay synchronized without human action, demonstrated by an '
              + 'unattended cycle completing correctly',
            scopePaths: ['README.md'],
            identity: 'EPIC-9',
            evidence: [ticketEv, fileEv],
            cites: ['E-T'],
          }),
          evidence: [fileEv],
          paths: ['README.md'],
          cause: 'no synchronization cycle exists',
        }),
        ['README.md'],
      ),
    });

    const { narrative, status } = await assertReadOnlyAndDurable(world, outcome);

    assert.equal(outcome.result.workItemId, 'wi_EPIC-9');
    assert.match(narrative.out, /\*\*AgentOS decided this is a EPIC\*\*/);
    assert.match(status.out, /wi_EPIC-9: EPIC/);

    assert.match(
      narrative.out,
      /template investigation\.readonly version 1\.0 was admitted from 1 admissible option\(s\)/,
      'the Epic falls back, and the narrative states how many options there were',
    );
    assert.match(narrative.out, /Risk class READ_ONLY/);
    assert.match(narrative.out, /stages: AUDIT -> ROOT_CAUSE -> COMPLETION/);
    assert.doesNotMatch(narrative.out, /entering at DECOMPOSITION/);
    assert.ok(
      eventsOf(outcome.log, 'workflow_admitted').length > 0,
      'the admitted workflow is a durable event, not a decision taken in memory',
    );
    assert.equal(outcome.result.outcome, 'BLOCKED');
  });

  test('at the seam: epic.coordinate is what EPIC would have run, and it contains no IMPLEMENTATION stage', () => {
    const coordinate = policies.templates.get('epic.coordinate');
    assert.ok(coordinate !== undefined, 'the template is in the frozen policy set');
    assert.ok(
      !coordinate.stages.includes('IMPLEMENTATION'),
      'an Orchestrator that would prefer one linear run has no expressible way to ask for it',
    );
    assert.ok(coordinate.stages.includes('DECOMPOSITION'));
    assert.ok(coordinate.stages.includes('CHILD_COORDINATION'));
    assert.ok(
      coordinate.stages.includes('VALIDATION'),
      'amendment A-14: the Epic has a non-mutating stage for its own outcome, which is what '
      + 'makes its verdict computable rather than owed to nobody',
    );

    const admissible = policies.admissibleTemplates('EPIC').map((t) => t.template_id);
    assert.ok(admissible.includes('epic.coordinate'));
    assert.ok(
      admissible.includes('investigation.readonly'),
      'investigation.readonly applies to every type by design, so the fallback always has '
      + 'something to fall back to',
    );
  });
});

/* ==================================================== 6. epic decomposition ==== */

describe('scenario 6 — epic decomposition (at the seam: DECOMPOSITION is unreachable in this build)', () => {
  test('at the seam: the Architect proposes children and the kernel creates them, each its own Work Item', () => {
    const parent = fx.workItem({
      work_item_id: 'wi_EPIC-9',
      type: 'EPIC',
      title: 'Autonomous repository synchronization',
      scope: scopeOf(['src/**']),
    });
    const outcome = decomposeEnvelope({
      parent,
      envelope: fx.envelope({
        agent: 'architect',
        stage_in: 'DECOMPOSITION',
        proposals: {
          decomposition: [
            {
              type: 'STORY',
              title: 'detect remote changes',
              desired_outcome: 'a remote change is observed and reported',
              scope: scopeOf(['src/detect/**']),
              depends_on: [],
              external_identity: null,
            },
            {
              type: 'STORY',
              title: 'reconcile local and remote state',
              desired_outcome: 'local and remote agree after a cycle',
              scope: scopeOf(['src/reconcile/**']),
              depends_on: ['detect remote changes'],
              external_identity: null,
            },
            {
              type: 'TASK',
              title: 'operational visibility for a cycle',
              desired_outcome: 'a cycle is observable after it runs',
              scope: scopeOf(['src/observe/**']),
              depends_on: [],
              external_identity: null,
            },
          ],
        },
      }),
      policies,
      existingExternalChildren: [],
      now: fx.T1,
    });

    assert.equal(outcome.result.outcome, 'ADMITTED');
    assert.equal(outcome.created.length, 3);
    assert.equal(
      new Set(outcome.created.map((child) => child.work_item_id)).size,
      3,
      'each child is its own Work Item with its own id, scope and desired outcome',
    );
    for (const child of outcome.created) {
      assert.ok(
        child.links.some((link) => link.kind === 'CHILD_OF' && link.target === 'wi_EPIC-9'),
        'each child is linked to the Epic rather than absorbed into it',
      );
    }
    const reconcile = outcome.created.find((child) => child.title.includes('reconcile'));
    assert.ok(reconcile !== undefined);
    assert.deepEqual(
      reconcile.dependencies,
      ['detect remote changes'],
      'the declared dependency survives into the child, which is what makes ordering real',
    );
  });
});

/* ======================================================== 7. partial epic ==== */

describe('scenario 7 — partial epic (at the seam: DECOMPOSITION is unreachable in this build)', () => {
  test('at the seam: a child whose external identity already exists is linked, never recreated', () => {
    const outcome = decomposeEnvelope({
      parent: fx.workItem({ work_item_id: 'wi_EPIC-9', type: 'EPIC', title: 'Sync', scope: scopeOf(['src/**']) }),
      envelope: fx.envelope({
        agent: 'architect',
        stage_in: 'DECOMPOSITION',
        proposals: {
          decomposition: [
            {
              type: 'STORY',
              title: 'detect remote changes',
              desired_outcome: 'a remote change is observed and reported',
              scope: scopeOf(['src/detect/**']),
              depends_on: [],
              external_identity: 'STORY-201',
            },
            {
              type: 'TASK',
              title: 'operational visibility for a cycle',
              desired_outcome: 'a cycle is observable after it runs',
              scope: scopeOf(['src/observe/**']),
              depends_on: [],
              external_identity: null,
            },
          ],
        },
      }),
      policies,
      /* Read from the project-management adapter *before* anything is proposed. */
      existingExternalChildren: ['STORY-201'],
      now: fx.T1,
    });

    assert.equal(outcome.result.outcome, 'ADMITTED');
    assert.equal(outcome.linked.length, 1, 'the child that already exists is linked');
    assert.equal(outcome.created.length, 1, 'only the genuinely new child is created');
    assert.equal(outcome.linked[0]?.external_identity, 'STORY-201');
    assert.equal(
      outcome.linked[0]?.work_item_id,
      'wi_STORY-201',
      'the id derives from the external identity, which is what makes the link a '
      + 'deduplication rather than a coincidence — and stops a resumed Epic duplicating its '
      + 'own backlog',
    );
  });
});

/* ================================================= 8. existing defect, open PR ==== */

describe('scenario 8 — existing defect with an open PR ("Take care of DEFECT-456.")', () => {
  const defect = {
    key: 'DEF-456',
    type: 'Bug',
    summary: 'Namespace restoration after restart',
    status: 'In Review',
  };

  test('end to end: the external item resolves, and the PR is not observable from this build (D1)', async () => {
    const world = newWorld();
    const ticketEv = ticketEvidence('E-T', 'DEF-456', defect);
    const fileEv = fileEvidence('E-01', 'src/session.ts', SESSION.content);
    const outcome = await work({
      world,
      source: 'PROJECT_MANAGEMENT',
      raw: 'DEF-456',
      projectManagement: reachablePm({ 'DEF-456': defect }),
      script: investigationScript(
        investigationGraph({
          resolution: resolution({
            type: 'DEFECT',
            intent: 'RESOLVE_DEFECT',
            title: 'Namespace restoration after restart',
            desiredOutcome: 'the namespace is restored after a restart, observed in a run',
            scopePaths: ['src/session.ts'],
            identity: 'DEF-456',
            evidence: [ticketEv, fileEv],
            cites: ['E-T'],
          }),
          evidence: [fileEv],
          paths: ['src/session.ts'],
          cause: 'the restore path never runs',
        }),
        ['src/session.ts'],
      ),
    });

    const { narrative } = await assertReadOnlyAndDurable(world, outcome);
    assert.equal(outcome.result.workItemId, 'wi_DEF-456');
    assert.match(narrative.out, /DEF-456 was fetched through the adapter/);

    /*
     * D1 is fixed, and the honest statement is now about the world rather than about the
     * wiring: `git.list_prs` is called with arguments its descriptor admits, and a scratch
     * worktree with no git host answers `UNAVAILABLE`. So `reality.pr` is `UNKNOWN`,
     * `reality.pr_open` is `INDETERMINATE` and not `FALSE`, and the walk does not enter at
     * `REVIEW_TRIAGE` — because it has not established that there is a PR to triage, not
     * because it could not ask the question.
     */
    const context = outcome.built.store.getVersioned(
      outcome.result.workItemId ?? '', outcome.result.runId ?? '', 'context', 1,
    ) as { readonly current_reality: Record<string, { readonly confidence: string; readonly reason?: string }> };
    const pr = context.current_reality['pr'];
    assert.ok(pr !== undefined);
    assert.equal(pr.confidence, 'UNKNOWN');
    assert.equal(
      pr.reason,
      'UNAVAILABLE',
      'the git host could not be reached from a scratch worktree, which is UNAVAILABLE — not '
      + 'NOT_APPLICABLE, and emphatically not "there is no PR"',
    );
    assert.match(narrative.out, /entering at AUDIT/);
    assert.doesNotMatch(narrative.out, /entering at REVIEW_TRIAGE/);
    assert.equal(outcome.result.outcome, 'COMPLETE');
  });

  test('at the seam: with a PR open and reviews outstanding the predicates say so, and an unreachable PR host is INDETERMINATE rather than FALSE', async () => {
    /*
     * The half of scenario D that matters most is the one that decides nothing on silence.
     * `reality.pr` UNKNOWN makes `reality.pr_open` INDETERMINATE and not FALSE, which is what
     * stops a run whose PR host is down from concluding the work has never been started — and
     * then entering at the beginning and doing it again.
     */
    const evaluator = new PredicateEvaluator(policies, new FixedClock(), null);
    const inputs = async (pr: Assertion) => ({
      context: await new FixtureDiscovery({ reality: { pr } }).orient(),
      workItem: fx.workItem({ work_item_id: 'wi_DEF-456', type: 'DEFECT' }),
      capabilities: [],
      mutations: [],
    });

    const open = await evaluator.evaluate(
      'reality.pr_open',
      await inputs(fx.factAssertion({ state: 'OPEN', number: 412 }, { probe: 'git.read_pr' })),
    );
    assert.equal(open.value, 'TRUE');
    assert.match(open.reason, /the pull request is open/);

    evaluator.freshen();
    const unreachable = await evaluator.evaluate(
      'reality.pr_open',
      await inputs(fx.unknownAssertion({ reason: 'UNAVAILABLE', probe: 'git.read_pr' })),
    );
    assert.equal(
      unreachable.value,
      'INDETERMINATE',
      'an unreachable git host is not "there is no PR"',
    );
    assert.match(
      unreachable.reason,
      /An unreachable git host makes it UNAVAILABLE, which is emphatically not "there is no PR"/,
    );

    evaluator.freshen();
    const none = await evaluator.evaluate(
      'reality.pr_open',
      await inputs(fx.factAssertion({}, { probe: 'git.list_prs' })),
    );
    assert.equal(none.value, 'FALSE', 'and a host that answered "none" is a genuine FALSE');
  });
});

/* ============================================== 9. PR with review comments ==== */

describe('scenario 9 — PR with review comments (at the seam: REVIEW_TRIAGE is unreachable in this build)', () => {
  test('at the seam: comments inside scope stay in the loop; the one outside becomes a child work item', () => {
    /*
     * Section 12 D exactly. `rt_3` is the case the model exists for: a real finding, genuinely
     * different work, and folding it into this PR would silently widen a change a reviewer
     * already approved in scope. Routing is kernel scope containment — the agent's own
     * `proposed_route` is recorded and ignored, which is what the third proposal below shows.
     */
    const parent = fx.workItem({
      work_item_id: 'wi_DEF-456',
      type: 'DEFECT',
      scope: scopeOf(['src/namespace/**', 'tests/namespace/**']),
    });
    const outcome = triageEnvelope(
      fx.envelope({
        agent: 'orchestrator',
        stage_in: 'REVIEW_TRIAGE',
        proposals: {
          triage: [
            {
              thread_id: 'rt_1',
              reading: 'add a test covering restart recovery',
              remediation_scope: scopeOf(['tests/namespace/**']),
              separable: 'TRUE',
              proposed_route: 'COMMENT_RESOLUTION',
            },
            {
              thread_id: 'rt_2',
              reading: 'this variable name is misleading',
              remediation_scope: scopeOf(['src/namespace/store.ts']),
              separable: 'TRUE',
              proposed_route: 'COMMENT_RESOLUTION',
            },
            {
              thread_id: 'rt_3',
              reading: 'the audit-log writer has the same bug',
              remediation_scope: scopeOf(['src/audit/**']),
              separable: 'TRUE',
              /* The agent would rather fold it in. The kernel does not let it. */
              proposed_route: 'COMMENT_RESOLUTION',
            },
          ],
        },
      }),
      parent,
    );

    const routes = new Map(outcome.decisions.map((d) => [d.threadId, d.route]));
    assert.equal(routes.get('rt_1'), 'COMMENT_RESOLUTION');
    assert.equal(routes.get('rt_2'), 'COMMENT_RESOLUTION');
    assert.equal(routes.get('rt_3'), 'CHILD_WORK_ITEM');
    assert.equal(
      outcome.children.length,
      1,
      'no new Defect or Story was created for rt_1 or rt_2 — only for the one outside scope',
    );
    assert.ok(
      outcome.decisions.find((d) => d.threadId === 'rt_3')?.overridden,
      'the kernel overrode the proposed route, and records that it did',
    );
  });

  test('at the seam: an inseparable finding outside scope is a SCOPE_EXPANSION for a human, not a silent widening', () => {
    const outcome = triageEnvelope(
      fx.envelope({
        agent: 'orchestrator',
        stage_in: 'REVIEW_TRIAGE',
        proposals: {
          triage: [{
            thread_id: 'rt_4',
            reading: 'the same function has to change for both',
            remediation_scope: scopeOf(['src/audit/**']),
            separable: 'FALSE',
            proposed_route: 'COMMENT_RESOLUTION',
          }],
        },
      }),
      fx.workItem({ work_item_id: 'wi_DEF-456', type: 'DEFECT', scope: scopeOf(['src/namespace/**']) }),
    );
    assert.equal(outcome.scopeExpansions.length, 1);
    assert.equal(outcome.children.length, 0);
  });
});
