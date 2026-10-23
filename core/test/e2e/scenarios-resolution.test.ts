import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtures as fx, type Assertion, type ContextPackage, type Event, type Evidence, type HandoffEnvelope, type Scope, type ToolInvocationResult } from '@intentra/contracts';
import { loadPolicies, type PolicySet } from '@intentra/policies';
import { checkTypeEvidence } from '../../src/admission.js';
import { buildKernel } from '../../src/composition/index.js';
import { verifyEvidence } from '../../src/evidence-verification.js';
import { PredicateEvaluator } from '../../src/predicates.js';
import { decomposeEnvelope, triageEnvelope } from '../../src/orchestration.js';
import { FixedClock, FixtureDiscovery, README_CONTENT, ScriptedSubstrate, type ScriptedResponse } from '../doubles.js';
import { scratchWorld, type ScratchWorld } from './world.js';
import {
  DECLARED_MODEL,
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
 * Scenarios 1-9: what Intentra decided the work was.
 *
 * Every end-to-end test here drives the composition root — `buildKernel` wiring the real
 * adapter framework against a real scratch git repository, the real discovery service, the
 * real registries, the real agent catalogue and the real run store, and `admitIntake`
 * dereferencing the intake source exactly as the CLI does — with the substrate, and only the
 * substrate, replaced by a recording. `intentra status` and `intentra narrate` then read the run
 * back through `main()`. That is `intentra work` with the model swapped for a script and
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

    /* The decided intent survives into `intentra narrate`, not only into the in-memory result.
     * This is the frozen mitigation for v0.3's residual risk and it is checked on the CLI's
     * output, because a narrative only the test can see mitigates nothing. */
    assert.match(narrative.out, /Intentra decided this is a/);
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
    assert.match(narrative.out, /\*\*Intentra decided this is a TASK\*\*/);
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
    assert.match(narrative.out, /Intentra decided this is a/);
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
    assert.match(narrative.out, /\*\*Intentra decided this is a STORY\*\*/);
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
              'issues in the configured GitHub repository appear as work items in Intentra '
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
      /issues in the configured GitHub repository appear as work items in Intentra/,
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
    assert.match(narrative.out, /\*\*Intentra decided this is a EPIC\*\*/);
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

/* ================================== the resolution envelope's `proposals` ==== */

/**
 * What `dispatchResolution` does with an envelope that does not carry `proposals`.
 *
 * `SubstrateResult.envelope` is `unknown` by contract — the substrate parses and hands on,
 * and the kernel is what validates — so the cast to `HandoffEnvelope` inside
 * `dispatchResolution` asserts a shape nobody has checked. Reading `proposals.work_item`
 * through it threw a `TypeError` on any envelope without the field, and it threw *before*
 * `dispatch_result` was written: the exception left the prologue, left `Kernel.work`, and
 * left the process, with `dispatch_intent` as the last record in the intake log and no run
 * to recover from. That is the shape the first WP-8 pilot ended in.
 *
 * `proposals` is a required envelope field, so all three shapes below are contract-invalid,
 * and the three graph dispatches classify exactly this input as `MALFORMED_ENVELOPE` through
 * `receiveEnvelope`. Since WP-8 smoke-2 resolution does too: a malformed answer is an
 * agent-level failure (WORKFLOW_STATE_MACHINE section 4.2), re-dispatched per policy and then
 * BLOCKED, not a refusal of the request.
 *
 * The assertion that matters in every case is the terminal event. A block is a result; an
 * intent with nothing after it is a run nobody can account for.
 */
describe('a resolution envelope with no usable proposals is answered, not thrown', () => {
  const RAW = 'Make the README accurate.';
  const ATTEMPTS = loadPolicies().budgets.dispatch_retries + 1;

  /** The prologue log, which is where a run that never admitted a Work Item writes. */
  function prologue(outcome: Awaited<ReturnType<typeof work>>): readonly Event[] {
    return outcome.built.store.readIntakeLog('in_0001').records;
  }

  /**
   * An envelope that is a well-formed JSON object and nothing more.
   *
   * Built by hand rather than through `fx.envelope`, because the fixture supplies `proposals`
   * and the defect is precisely about an envelope that does not.
   */
  function envelopeWithout(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      envelope_version: '1.2',
      envelope_id: 'env_no_proposals',
      agent: 'context-discovery',
      stage_in: 'RESOLUTION',
      status: 'COMPLETE',
      summary: 'the resolution mandate answered without proposing a Work Item',
      ...overrides,
    };
  }

  /** The same response for every attempt the policy allows. */
  function everyAttempt(envelope: unknown): readonly ScriptedResponse[] {
    return Array.from({ length: ATTEMPTS }, () => ({ kind: 'ENVELOPE', envelope }) as const);
  }

  const shapes: readonly { readonly name: string; readonly envelope: Record<string, unknown> }[] = [
    { name: 'proposals absent', envelope: envelopeWithout({}) },
    { name: 'proposals null', envelope: envelopeWithout({ proposals: null }) },
    { name: 'proposals empty', envelope: envelopeWithout({ proposals: {} }) },
  ];

  for (const shape of shapes) {
    test(`${shape.name}: every dispatch is answered, the failure is recorded, nothing is admitted`, async () => {
      const world = newWorld();

      /*
       * Reaching a result at all is the regression. Before the repair this rejected with
       * `TypeError: Cannot read properties of undefined (reading 'work_item')`, and every
       * assertion below was unreachable.
       */
      const outcome = await work({ world, raw: RAW, script: everyAttempt(shape.envelope) });

      const log = prologue(outcome);
      const intents = eventsOf(log, 'dispatch_intent');
      const results = eventsOf(log, 'dispatch_result');

      assert.equal(intents.length, ATTEMPTS, 'each intent was written before the agent ran');
      assert.equal(
        results.length,
        ATTEMPTS,
        'and each dispatch was answered: an intent with no result after it is the failure '
        + 'signature this repair exists to remove',
      );
      for (const result of results) {
        assert.equal(result.stage, 'RESOLUTION');
        assert.equal(result.data.outcome, 'FAILED');
        assert.equal(result.data.failure_reason, 'MALFORMED_ENVELOPE');
        assert.match(result.data.detail ?? '', /does not satisfy its schema/);
      }

      assert.equal(outcome.result.outcome, 'BLOCKED');
      assert.match(outcome.result.detail, /resolution produced no admissible proposal/);
      assert.equal(outcome.result.workItemId, null, 'nothing was admitted from it');
      assert.deepEqual(
        [...outcome.built.store.listWorkItems()],
        [],
        'and no Work Item reached the store, so `intentra status` has nothing to report',
      );
    });
  }

  /* A schema-valid envelope that proposes nothing is the agent's answer, and stays a refusal. */
  test('a valid envelope with no work_item proposal is refused, once, with the gap named', async () => {
    const envelope = validResolution();
    delete proposalsOf(envelope)['work_item'];
    const outcome = await work({
      world: newWorld(),
      raw: RAW,
      script: [{ kind: 'ENVELOPE', stage: 'RESOLUTION', envelope }],
    });

    const log = prologue(outcome);
    assert.equal(eventsOf(log, 'dispatch_intent').length, 1, 'no re-dispatch');
    const results = eventsOf(log, 'dispatch_result');
    assert.equal(results[0]?.data.outcome, 'ENVELOPE', 'the substrate returned an envelope');
    assert.equal(results[0]?.data.detail, 'the envelope carried no work_item proposal');
    assert.equal(outcome.result.outcome, 'REFUSED');
    assert.match(outcome.result.detail, /resolution produced no admissible proposal/);
    assert.match(outcome.result.detail, /carried no work_item proposal/);
    assert.equal(outcome.result.workItemId, null);
  });

  /**
   * The positive control, in the same shape as the three above.
   *
   * Scenario 1 already drives a valid proposal end to end; this asserts the one thing those
   * three cannot — that the repair did not make every resolution look like a failure. The
   * same envelope with `proposals.work_item` present admits a Work Item and writes a
   * `dispatch_result` carrying the envelope's own id and no complaint.
   */
  test('an envelope that does carry a work_item proposal still admits one', async () => {
    const world = newWorld();
    const outcome = await work({ world, raw: 'Fix typo in README.', script: admittedScript([]) });

    const resolutionResult = eventsOf(prologue(outcome), 'dispatch_result')
      .find((event) => event.stage === 'RESOLUTION');

    assert.notEqual(resolutionResult, undefined, 'the resolution dispatch was answered');
    assert.equal(resolutionResult?.data.outcome, 'ENVELOPE');
    assert.equal(resolutionResult?.data.envelope_id, 'env_resolution');
    assert.equal(
      resolutionResult?.data.detail,
      '',
      'a proposal that is there is not reported as missing',
    );
    assert.notEqual(outcome.result.workItemId, null, 'and the Work Item was admitted');
  });

  const invalid: readonly {
    readonly name: string;
    readonly mutate: (envelope: Record<string, unknown>) => void;
  }[] = [
    { name: 'malformed: the proposal is a string', mutate: (e) => { proposalsOf(e)['work_item'] = 'TASK'; } },
    { name: 'malformed: an assertion has the wrong type', mutate: (e) => { workItemOf(e)['title'] = 'Fix typo'; } },
    { name: 'incomplete: the proposal has no external_identity', mutate: (e) => { delete workItemOf(e)['external_identity']; } },
    { name: 'incomplete: a valid proposal with no coverage', mutate: (e) => { delete e['coverage']; } },
    { name: 'incomplete: a valid proposal with no findings', mutate: (e) => { delete e['findings']; } },
    { name: 'unexpected: a field the contract does not define', mutate: (e) => { workItemOf(e)['priority'] = 'P0'; } },
  ];

  for (const shape of invalid) {
    test(`${shape.name}: failed with the schema errors named, re-dispatched per policy, then blocked`, async () => {
      const envelope = validResolution();
      shape.mutate(envelope);
      const outcome = await work({
        world: newWorld(),
        raw: 'Fix typo in README.',
        script: everyAttempt(envelope),
      });

      const log = prologue(outcome);
      assert.deepEqual(
        eventsOf(log, 'dispatch_intent').map((e) => e.data.attempt),
        Array.from({ length: ATTEMPTS }, (_, i) => i + 1),
        'the policy\'s attempts and no more, and no audit',
      );
      const results = eventsOf(log, 'dispatch_result');
      assert.equal(results.length, ATTEMPTS, 'every dispatch was answered');
      for (const result of results) {
        assert.equal(result.data.failure_reason, 'MALFORMED_ENVELOPE');
        assert.match(result.data.detail ?? '', /does not satisfy its schema/);
      }

      assert.equal(outcome.result.outcome, 'BLOCKED');
      assert.equal(outcome.result.blockerKind, 'EXTERNAL_DEPENDENCY');
      assert.match(
        outcome.result.detail,
        /no admissible proposal: the resolution envelope does not satisfy its schema/,
      );
      assert.equal(outcome.result.workItemId, null);
      assert.deepEqual([...outcome.built.store.listWorkItems()], []);
    });
  }
});

/* WP-8 attempt 2: unvalidated, these threw past the log or were admitted as though complete. */
function validResolution(): Record<string, unknown> {
  return structuredClone(resolution(TYPO_TASK)) as unknown as Record<string, unknown>;
}

const TYPO_TASK = {
  type: 'TASK',
  intent: 'MODIFY_ARTIFACT',
  title: 'Fix typo in README',
  desiredOutcome: 'the misspelling in README.md is corrected',
  scopePaths: ['README.md'],
  evidence: [fileEvidence('E-01', 'README.md', README_CONTENT)],
  cites: ['E-01'],
} as const;

function proposalsOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return envelope['proposals'] as Record<string, unknown>;
}

function workItemOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return proposalsOf(envelope)['work_item'] as Record<string, unknown>;
}

/** A full admitted run whose resolution answer is preceded by `before` and may be replaced by `answer`. */
function admittedScript(
  before: readonly ScriptedResponse[],
  answer?: ScriptedResponse,
): readonly ScriptedResponse[] {
  const evidence = fileEvidence('E-01', 'README.md', README_CONTENT);
  const [valid, ...rest] = investigationScript(
    investigationGraph({
      resolution: resolution(TYPO_TASK),
      evidence: [evidence],
      paths: ['README.md'],
      cause: 'the file was written with the wrong capitalization',
    }),
    ['README.md'],
  );
  if (valid === undefined) throw new Error('unreachable: the script has a resolution answer');
  return [...before, answer ?? valid, ...rest];
}

/* ============================== a malformed resolution answer is retried, then blocks ==== */

/**
 * WP-8 smoke-2: resolution's final message began with prose, the substrate rightly refused to
 * parse it as `MALFORMED_ENVELOPE`, and the kernel ended the request REFUSED on the first
 * attempt. WORKFLOW_STATE_MACHINE section 4.2 calls that an agent-level failure — "Retry per
 * policy, escalating the model once. On repeated failure: BLOCKED" — and section 3.1 of the
 * resolution document lists no exemption, so resolution now applies the graph's own rule.
 *
 * `TEXT` responses go through `parseEnvelope`, the parser the Claude substrate uses, so the
 * prose, fence, empty and truncated cases below are the real transport check, not a label.
 */
describe('a malformed resolution answer is an agent-level failure: re-dispatched per policy, then BLOCKED', () => {
  const POLICIES = loadPolicies();
  const ATTEMPTS = POLICIES.budgets.dispatch_retries + 1;
  const JSON_ANSWER = JSON.stringify(resolution(TYPO_TASK));
  const STRONGER = { ...DECLARED_MODEL, id: 'model.stronger', usd_per_mtok_input: 15, usd_per_mtok_output: 75 };

  function prologue(outcome: Awaited<ReturnType<typeof work>>): readonly Event[] {
    return outcome.built.store.readIntakeLog('in_0001').records;
  }

  function resolutionResults(outcome: Awaited<ReturnType<typeof work>>) {
    return eventsOf(prologue(outcome), 'dispatch_result').filter((e) => e.stage === 'RESOLUTION');
  }

  function attemptModels(outcome: Awaited<ReturnType<typeof work>>): readonly string[] {
    return eventsOf(prologue(outcome), 'dispatch_intent').map((e) => e.data.input_package.model);
  }

  function withBudgets(budgets: Partial<PolicySet['budgets']>): PolicySet {
    return { ...POLICIES, budgets: { ...POLICIES.budgets, ...budgets } };
  }

  function texts(count: number, text: string): readonly ScriptedResponse[] {
    return Array.from({ length: count }, () => ({ kind: 'TEXT', text }) as const);
  }

  test('A: prose before the JSON fails, the next attempt recovers, and only it is admitted', async () => {
    const world = newWorld();
    const outcome = await work({
      world,
      raw: 'Fix typo in README.',
      script: admittedScript(
        [{ kind: 'TEXT', text: `I have what I need. Here is the envelope:\n${JSON_ANSWER}` }],
        { kind: 'TEXT', text: JSON_ANSWER },
      ),
    });

    const log = prologue(outcome);
    assert.deepEqual(
      eventsOf(log, 'dispatch_intent').map((e) => e.data.attempt),
      [1, 2],
      'one re-dispatch, numbered',
    );
    const [failed, answered] = resolutionResults(outcome);
    assert.equal(failed?.data.outcome, 'FAILED');
    assert.equal(failed?.data.failure_reason, 'MALFORMED_ENVELOPE');
    assert.match(failed?.data.detail ?? '', /not JSON/, 'the parser\'s own reason is recorded');
    assert.equal(answered?.data.outcome, 'ENVELOPE');
    assert.equal(answered?.data.envelope_id, 'env_resolution');
    assert.equal(
      eventsOf(log, 'note').filter((e) => e.data.topic === 're-dispatch').length,
      1,
      'the re-dispatch is recorded with the rule that allowed it',
    );

    /* The recovered answer takes the normal path: evidence replay, admission, the run. */
    assert.equal(eventsOf(log, 'evidence_verification')[0]?.data.envelope_id, 'env_resolution');
    assert.notEqual(outcome.result.workItemId, null);
    assert.equal(outcome.built.store.listWorkItems().length, 1, 'one Work Item, from the valid answer');
    assert.deepEqual(
      outcome.substrate.dispatched.slice(0, 3).map((d) => d.stage),
      ['RESOLUTION', 'RESOLUTION', 'CONTEXT_DISCOVERY'],
      'nothing ran past resolution until the valid answer was admitted',
    );
    assert.deepEqual(outcome.after, outcome.before);
  });

  const malformed: readonly (readonly [string, string])[] = [
    ['prose before the JSON', `I have what I need.\n${JSON_ANSWER}`],
    ['prose after the JSON', `${JSON_ANSWER}\nThat is the envelope.`],
    ['a Markdown code fence', `\`\`\`json\n${JSON_ANSWER}\n\`\`\``],
    ['an empty answer', ''],
    ['a truncated answer', JSON_ANSWER.slice(0, Math.floor(JSON_ANSWER.length / 2))],
  ];

  for (const [name, text] of malformed) {
    test(`B/D: ${name} on every attempt is re-dispatched per policy, then BLOCKED, never REFUSED`, async () => {
      const world = newWorld();
      const outcome = await work({ world, raw: 'Fix typo in README.', script: texts(ATTEMPTS + 1, text) });

      const log = prologue(outcome);
      assert.deepEqual(
        eventsOf(log, 'dispatch_intent').map((e) => e.data.attempt),
        Array.from({ length: ATTEMPTS }, (_, i) => i + 1),
        'exactly the attempts the policy allows, though the script had one more to give',
      );
      const results = resolutionResults(outcome);
      assert.equal(results.length, ATTEMPTS);
      for (const result of results) {
        assert.equal(result.data.outcome, 'FAILED');
        assert.equal(result.data.failure_reason, 'MALFORMED_ENVELOPE');
        assert.ok((result.data.detail ?? '').length > 0, 'each failure names its reason');
      }
      assert.equal(eventsOf(log, 'note').filter((e) => e.data.topic === 're-dispatch').length, ATTEMPTS - 1);

      assert.equal(outcome.result.outcome, 'BLOCKED');
      assert.equal(outcome.result.blockerKind, 'EXTERNAL_DEPENDENCY');
      assert.match(outcome.result.detail, new RegExp(`failed ${ATTEMPTS} times`));
      assert.equal(outcome.result.workItemId, null);
      assert.equal(outcome.result.runId, null, 'no run was started');
      assert.deepEqual([...outcome.built.store.listWorkItems()], []);
      assert.equal(eventsOf(log, 'evidence_verification').length, 0, 'nothing was replayed or admitted');
      assert.equal(outcome.substrate.dispatched.length, ATTEMPTS, 'no model call outside the recorded attempts');
      assert.deepEqual(outcome.after, outcome.before);
    });
  }

  for (const retries of [0, 1, 2]) {
    test(`C: dispatch_retries ${retries} allows exactly ${retries + 1} attempt(s)`, async () => {
      const outcome = await work({
        world: newWorld(),
        raw: 'Fix typo in README.',
        policies: withBudgets({ dispatch_retries: retries }),
        script: texts(4, 'Done.'),
      });
      assert.equal(outcome.substrate.dispatched.length, retries + 1);
      assert.equal(eventsOf(prologue(outcome), 'dispatch_intent').length, retries + 1);
      assert.equal(outcome.result.outcome, 'BLOCKED');
    });
  }

  test('C: with a stronger model declared, the model is escalated once and held', async () => {
    const outcome = await work({
      world: newWorld(),
      raw: 'Fix typo in README.',
      models: [DECLARED_MODEL, STRONGER],
      script: texts(ATTEMPTS, 'Done.'),
    });
    const [first, ...retried] = attemptModels(outcome);
    assert.ok(first === 'model.scripted' || first === 'model.stronger');
    const other = first === 'model.scripted' ? 'model.stronger' : 'model.scripted';
    assert.deepEqual(retried, Array.from({ length: ATTEMPTS - 1 }, () => other));
  });

  test('C: with escalation disabled by policy, every attempt keeps the selected model', async () => {
    const outcome = await work({
      world: newWorld(),
      raw: 'Fix typo in README.',
      models: [DECLARED_MODEL, STRONGER],
      policies: withBudgets({ model_escalations_per_dispatch: 0 }),
      script: texts(ATTEMPTS, 'Done.'),
    });
    const models = attemptModels(outcome);
    assert.equal(models.length, ATTEMPTS);
    assert.equal(new Set(models).size, 1);
  });

  test('C: with one model declared, no escalation target is invented', async () => {
    const outcome = await work({ world: newWorld(), raw: 'Fix typo in README.', script: texts(ATTEMPTS, 'Done.') });
    assert.deepEqual(attemptModels(outcome), Array.from({ length: ATTEMPTS }, () => 'model.scripted'));
  });

  test('F: a re-dispatch holds the same grants, and its out-of-scope read is still refused', async () => {
    const outcome = await work({
      world: newWorld(),
      raw: 'Fix typo in README.',
      script: admittedScript(
        [{ kind: 'TEXT', text: 'Done.' }],
        {
          kind: 'CALLS_THEN_ENVELOPE',
          calls: [{ tool: 'repo__read_file', args: { path: 'README.md' } }],
          envelope: () => resolution(TYPO_TASK),
        },
      ),
    });

    const [first, second] = outcome.substrate.dispatched;
    assert.equal(second?.stage, 'RESOLUTION');
    assert.deepEqual(second?.tools_granted, first?.tools_granted, 'the grants are the policy\'s, not the attempt\'s');
    assert.deepEqual(second?.mandate.in_scope, [], 'and the resolution mandate still reaches no path');
    const calls = eventsOf(prologue(outcome), 'adapter_call');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.data.outcome, 'REFUSED');
    assert.equal(calls[0]?.data.refusal, 'scope_violation');
    assert.notEqual(outcome.result.workItemId, null, 'and the valid answer is still admitted');
  });

  test('F: an invalid request is still refused through admission, not retried as a failure', async () => {
    const unbounded = resolution({ ...TYPO_TASK, scopePaths: ['**'] });
    const outcome = await work({
      world: newWorld(),
      raw: 'Fix typo in README.',
      script: [
        { kind: 'ENVELOPE', envelope: unbounded },
        { kind: 'ENVELOPE', envelope: unbounded },
      ],
    });

    const log = prologue(outcome);
    assert.equal(eventsOf(log, 'dispatch_intent').length, 2, 'the frozen once-only re-dispatch of a rejected proposal');
    assert.ok(resolutionResults(outcome).every((r) => r.data.outcome === 'ENVELOPE'), 'no attempt failed');
    assert.equal(eventsOf(log, 'note').filter((e) => e.data.topic === 're-dispatch').length, 0);
    assert.equal(outcome.result.outcome, 'REFUSED');
    assert.match(outcome.result.detail, /resolution was refused twice/);
    assert.equal(outcome.result.workItemId, null);
  });
});

/* ===================================================== the excerpt the agent was shown ==== */

/* WP-8 smoke-1: replay compared the agent's excerpt with one the agent was never shown, so honest evidence could not verify. */
describe('resolution evidence quotes the excerpt its call showed, and admission replays exactly that', () => {
  const LISTED = { adapter: 'repo', op: 'list_paths', args: {} } as const;
  const TASK = {
    type: 'TASK',
    intent: 'MODIFY_ARTIFACT',
    title: 'Fix typo in README',
    desiredOutcome: 'the misspelling in README.md is corrected',
    scopePaths: ['README.md'],
    cites: ['E-01'],
  } as const;

  function prologue(outcome: Awaited<ReturnType<typeof work>>): readonly Event[] {
    return outcome.built.store.readIntakeLog('in_0001').records;
  }

  /** Lists the worktree through the granted tool, then cites the listing as `quote` renders what it showed; `undefined` omits the excerpt. */
  function citing(
    quote: (shown: string) => unknown,
    shownTo: string[] = [],
    readme: string = README_CONTENT,
  ): ScriptedResponse {
    return {
      kind: 'CALLS_THEN_ENVELOPE',
      calls: [{ tool: 'repo__list_paths', args: {} }],
      envelope: (results) => {
        const [listed] = results as readonly ToolInvocationResult[];
        assert.equal(listed?.outcome, 'OK', 'the listing was answered at resolution');
        const shown = listed?.outcome === 'OK' ? listed.excerpt : '';
        shownTo.push(shown);
        const cited: Record<string, unknown> = {
          ...fx.evidence({ id: 'E-02', kind: 'file', locator: { ...LISTED, args: {} }, ref: 'worktree root', reproducible: true }),
          excerpt: quote(shown),
        };
        if (cited['excerpt'] === undefined) delete cited['excerpt'];
        const envelope = resolution({
          ...TASK,
          evidence: [fileEvidence('E-01', 'README.md', readme), cited as unknown as Evidence],
        });
        /* A HIGH finding is always verified, so E-02's replay does not depend on the sampler. */
        return { ...envelope, findings: [fx.finding({ id: 'F-01', severity: 'HIGH', evidence: ['E-02'] })] };
      },
    };
  }

  function admittedRun(step: ScriptedResponse): readonly ScriptedResponse[] {
    const evidence = fileEvidence('E-01', 'README.md', README_CONTENT);
    const script = investigationScript(
      investigationGraph({
        resolution: resolution({ ...TASK, evidence: [evidence] }),
        evidence: [evidence],
        paths: ['README.md'],
        cause: 'the file was written with the wrong capitalization',
      }),
      ['README.md'],
    );
    return [step, ...script.slice(1)];
  }

  function verificationOf(log: readonly Event[]) {
    const [verification] = eventsOf(log, 'evidence_verification');
    assert.ok(verification !== undefined, 'admission replayed the resolution evidence');
    return verification.data;
  }

  test('quoted as shown: the shown excerpt is the replayed one, it verifies, and the Work Item is admitted', async () => {
    const world = newWorld();
    const shown: string[] = [];
    const outcome = await work({ world, raw: 'Fix typo in README.', script: admittedRun(citing((s) => s, shown)) });

    const replayed = await outcome.built.framework.replay(LISTED, {
      workItemId: 'in_0001',
      runId: 'in_0001',
      dispatchId: 'd_res',
      mandate: { in_scope: ['README.md'], out_of_scope: [] },
      grantsHeld: [],
      stageMutating: false,
    });
    assert.equal(replayed.outcome, 'OK');
    assert.equal(shown[0], replayed.outcome === 'OK' ? replayed.excerpt : null, 'adapter, kernel and substrate carried one string');

    const verification = verificationOf(prologue(outcome));
    const listed = verification.results.find((r) => r.evidence_id === 'E-02');
    assert.equal(listed?.status, 'VERIFIED');
    assert.equal(listed?.selected_because, 'ALWAYS_CRITICAL_FINDING');
    assert.equal(verification.mismatch_count, 0);

    assert.notEqual(outcome.result.workItemId, null, 'the Work Item was admitted');
    assert.deepEqual(outcome.after, outcome.before, 'and the repository is byte-identical');
  });

  test('mismatched: a quote that differs from what was shown is MISMATCH and withdrawn, never verified', async () => {
    const world = newWorld();
    const outcome = await work({
      world,
      raw: 'Fix typo in README.',
      script: admittedRun(citing((s) => `${s}\nsrc/invented.ts`)),
    });

    const verification = verificationOf(prologue(outcome));
    assert.equal(verification.results.find((r) => r.evidence_id === 'E-02')?.status, 'MISMATCH');
    assert.equal(verification.mismatch_count, 1);
    const schema = outcome.result.checks.find((c) => c.check === 'schema_and_confidence');
    assert.match(schema?.detail ?? '', /1 withdrawn as unconfirmed/);
    assert.deepEqual(outcome.after, outcome.before);
  });

  test('fabricated twice over: the envelope is rejected, re-dispatched once, refused, and nothing runs after it', async () => {
    const world = newWorld();
    const fabricated = citing(() => 'src/billing/invoice.ts', [], `${README_CONTENT} (as remembered)`);
    const outcome = await work({ world, raw: 'Fix typo in README.', script: [fabricated, fabricated] });

    const log = prologue(outcome);
    const verification = verificationOf(log);
    assert.equal(verification.mismatch_count, 2);
    assert.deepEqual(
      eventsOf(log, 'dispatch_intent').map((e) => e.stage),
      ['RESOLUTION', 'RESOLUTION'],
      'one re-dispatch, and no dispatch past resolution',
    );
    assert.equal(outcome.result.outcome, 'REFUSED');
    assert.match(outcome.result.detail, /resolution was refused twice/);
    assert.equal(outcome.result.workItemId, null);
    assert.deepEqual(outcome.log, [], 'no run was started');
    assert.deepEqual(outcome.after, outcome.before);
  });

  const unusable: readonly { readonly name: string; readonly quote: (shown: string) => unknown }[] = [
    { name: 'missing: the evidence has no excerpt', quote: () => undefined },
    { name: 'malformed: the excerpt is not a string', quote: () => 42 },
  ];

  for (const shape of unusable) {
    test(`${shape.name}: failed at the schema, before any replay, and blocked once retries run out`, async () => {
      const world = newWorld();
      const attempts = loadPolicies().budgets.dispatch_retries + 1;
      const outcome = await work({
        world,
        raw: 'Fix typo in README.',
        script: Array.from({ length: attempts }, () => citing(shape.quote)),
      });

      const log = prologue(outcome);
      assert.equal(eventsOf(log, 'evidence_verification').length, 0, 'nothing was replayed');
      assert.equal(eventsOf(log, 'dispatch_intent').length, attempts, 'the policy\'s attempts, and no audit');
      assert.equal(outcome.result.outcome, 'BLOCKED');
      assert.match(outcome.result.detail, /does not satisfy its schema/);
      assert.equal(outcome.result.workItemId, null);
      assert.deepEqual(outcome.after, outcome.before);
    });
  }
});

/* ======================================================= file evidence cites its lines ==== */

/* WP-8: CONTEXT_MODEL §2 cites read_file with `lines`; a whole-file locator forced evidence to quote the whole file. */
describe('file evidence cites the lines it rests on, and the replay reads exactly those lines', () => {
  const PATH = 'src/large.py';
  const LARGE = Array.from({ length: 1200 }, (_, i) => `    total_${i + 1} = compute(${i + 1})`).join('\n');
  const RELEVANT = LARGE.split('\n').slice(599, 604).join('\n');

  function largeWorld(): ScratchWorld {
    return newWorld([README, SESSION, { path: PATH, content: LARGE }]);
  }

  function cite(id: string, excerpt: string, lines?: string): Evidence {
    return fx.evidence({
      id,
      kind: 'file',
      locator: { adapter: 'repo', op: 'read_file', args: lines === undefined ? { path: PATH } : { path: PATH, lines } },
      ref: lines === undefined ? PATH : `${PATH}:${lines}`,
      excerpt,
      reproducible: true,
    });
  }

  /** A resolution scoped to the large file whose HIGH finding rests on `evidence`, so every item is always replayed. */
  function resolvingOn(evidence: readonly Evidence[]): HandoffEnvelope {
    const envelope = resolution({
      type: 'TASK',
      intent: 'MODIFY_ARTIFACT',
      title: 'Correct the totals in src/large.py',
      desiredOutcome: 'lines 600-604 of src/large.py compute the right totals',
      scopePaths: [PATH],
      evidence,
      cites: [evidence[0]?.id ?? ''],
    });
    return { ...envelope, findings: [fx.finding({ id: 'F-01', severity: 'HIGH', evidence: evidence.map((e) => e.id) })] };
  }

  async function verify(world: ScratchWorld, evidence: readonly Evidence[]) {
    const built = await buildKernel({
      stateRoot: world.stateRoot,
      repositoryPath: world.repositoryPath,
      intake: { source: 'NATURAL_LANGUAGE', raw: 'Correct the totals.', received_at: new Date().toISOString() },
      env: { AGENTOS_MODELS: '[]' },
      substrate: new ScriptedSubstrate([]),
      projectManagement: null,
      runtime: null,
    });
    return verifyEvidence({
      envelope: resolvingOn(evidence),
      policy: policies.evidence,
      adapters: built.framework,
      callContext: {
        workItemId: 'in_0001',
        runId: 'in_0001',
        dispatchId: 'd_res',
        mandate: { in_scope: [PATH], out_of_scope: [] },
        grantsHeld: [],
        stageMutating: false,
      },
      clock: new FixedClock(),
      calls: [],
    });
  }

  test('end to end: the relevant five lines of a 1,200-line file verify, and the Work Item is admitted', async () => {
    const world = largeWorld();
    const evidence = cite('E-01', RELEVANT, '600-604');
    const script = investigationScript(
      investigationGraph({ resolution: resolvingOn([evidence]), evidence: [evidence], paths: [PATH], cause: 'the totals are computed from the wrong index' }),
      [PATH],
    );
    const outcome = await work({ world, raw: 'Correct the totals in src/large.py.', script });

    const [verification] = eventsOf(outcome.built.store.readIntakeLog('in_0001').records, 'evidence_verification');
    assert.equal(verification?.data.results.find((r) => r.evidence_id === 'E-01')?.status, 'VERIFIED');
    assert.equal(verification?.data.mismatch_count, 0);
    assert.notEqual(outcome.result.workItemId, null);
    assert.deepEqual(outcome.after, outcome.before, 'and the repository is byte-identical');
  });

  test('end to end: a subset quoted against the whole file, and a changed line, are two mismatches; refused, nothing runs after', async () => {
    const world = largeWorld();
    const wrong = resolvingOn([
      cite('E-01', RELEVANT),
      cite('E-02', RELEVANT.replace('compute(602)', 'compute(-602)'), '600-604'),
    ]);
    const outcome = await work({
      world,
      raw: 'Correct the totals in src/large.py.',
      script: [{ kind: 'ENVELOPE', envelope: wrong }, { kind: 'ENVELOPE', envelope: wrong }],
    });

    const log = outcome.built.store.readIntakeLog('in_0001').records;
    const [verification] = eventsOf(log, 'evidence_verification');
    assert.deepEqual(verification?.data.results.map((r) => `${r.evidence_id}:${r.status}`).sort(), ['E-01:MISMATCH', 'E-02:MISMATCH']);
    assert.deepEqual(eventsOf(log, 'dispatch_intent').map((e) => e.stage), ['RESOLUTION', 'RESOLUTION']);
    assert.equal(outcome.result.outcome, 'REFUSED');
    assert.equal(outcome.result.workItemId, null);
    assert.deepEqual(outcome.log, []);
    assert.deepEqual(outcome.after, outcome.before);
  });

  const seam: readonly { readonly name: string; readonly evidence: () => Evidence; readonly status: string }[] = [
    { name: 'the relevant lines, quoted as read', evidence: () => cite('E-01', RELEVANT, '600-604'), status: 'VERIFIED' },
    { name: 'the whole file, quoted whole', evidence: () => cite('E-01', LARGE), status: 'VERIFIED' },
    { name: 'the relevant lines against a whole-file locator', evidence: () => cite('E-01', RELEVANT), status: 'MISMATCH' },
    { name: 'a range that is off by one', evidence: () => cite('E-01', RELEVANT, '601-605'), status: 'MISMATCH' },
    { name: 'a range past the end of the file', evidence: () => cite('E-01', RELEVANT, '1199-1300'), status: 'UNREPLAYABLE' },
    { name: 'fabricated lines', evidence: () => cite('E-01', '    total_3 = 0\n    total_4 = 0', '3-4'), status: 'MISMATCH' },
  ];

  for (const shape of seam) {
    test(`at the verifier, against the real adapter: ${shape.name} is ${shape.status}`, async () => {
      const report = await verify(largeWorld(), [shape.evidence()]);
      assert.equal(report.outcomes[0]?.status, shape.status);
      assert.equal(report.outcomes[0]?.status === 'VERIFIED', shape.status === 'VERIFIED', 'only an exact replay is verified');
    });
  }

  test('at the verifier: a line changed on disk after it was quoted is MISMATCH', async () => {
    const world = largeWorld();
    writeFileSync(join(world.repositoryPath, PATH), LARGE.replace('compute(602)', 'compute(603)'), 'utf8');
    const report = await verify(world, [cite('E-01', RELEVANT, '600-604')]);
    assert.equal(report.outcomes[0]?.status, 'MISMATCH');
  });
});
