import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx, type HandoffEnvelope, type Locator } from '@agentos/contracts';
import { Kernel, type StartInput } from '../../src/kernel.js';
import { detectConflicts, resolveByRule, sourceAuthority } from '../../src/arbitration.js';
import {
  README_CONTENT,
  auditEnvelope,
  completionEnvelope,
  harness,
  resolutionEnvelope,
  rootCauseEnvelope,
  type Harness,
  type ScriptedResponse,
} from '../doubles.js';
import { scratchWorld, type ScratchWorld } from './world.js';
import {
  assertNothingAdvanced,
  assertReadOnlyAndDurable,
  completionVerdict,
  eventsOf,
  investigationScript,
  notes,
  reachableEmptyPm,
  reachablePm,
  unreachablePm,
  work,
} from './rig.js';
import { fileEvidence, investigationGraph, resolution, ticketEvidence } from './envelopes.js';

/**
 * Scenarios 10-16: what AgentOS made of the state it found.
 *
 * The header of `scenarios-resolution.test.ts` states the two facts that govern this whole
 * suite — `investigation.readonly` is the only admissible template under
 * `mutation_enabled: false`, and what became of the five defects these scenarios found. Two of
 * the five were found here, and this is what they are now.
 *
 * - **D4 — source drift could never be computed for a project-management intake.** Fixed in
 *   two halves. `intakeRereaderFor` turns a ticket record into text, so the re-read produces
 *   something to compare; and `admitIntake` dereferences the pointer *once, at admission,
 *   through the same reader*, so `IntakeRecord.content_hash` is taken over the ticket body
 *   rather than over the key the operator typed. What is hashed and what is compared are now
 *   produced by the same code against the same locator, which is the only arrangement in which
 *   the comparison means anything — and an unedited ticket reports `UNCHANGED` rather than
 *   `CHANGED` on every run for ever.
 * - **D5 — an intake naming an unreachable or absent external item was reported `REFUSED`.**
 *   Fixed: `core/src/admission.ts` computes `outcome: 'BLOCKED'` with
 *   `blockerKind: 'EXTERNAL_DEPENDENCY'`, and the kernel now routes that through `block(...)`
 *   rather than `refuse(...)`, so the kind travels with the outcome all the way to the caller.
 *   `REFUSED` and `BLOCKED` are different answers — the first says the request was
 *   inadmissible, the second says the request was fine and the world was not — and a script
 *   branching on the exit code is no longer told its ticket key was wrong when the ticket
 *   system is merely down.
 *
 * The sixth defect was the root cause the other five sat on top of: `CONTEXT_DISCOVERY`
 * dispatched only the `resolution` mandate, so criterion 1 — owned by
 * `context-discovery/context` — was `NOT_VALIDATED` in every run. The prologue now dispatches
 * both, which is why every script here carries a `CONTEXT_DISCOVERY` envelope second.
 */

const README = { path: 'README.md', content: README_CONTENT };
const SESSION = {
  path: 'src/session.ts',
  content: 'export const SESSION_TTL_SECONDS = 300;\n',
};

const worlds: ScratchWorld[] = [];
const rigs: Harness[] = [];
after(() => {
  for (const world of worlds) world.destroy();
  for (const rig of rigs) rig.destroy();
});

function newWorld(files = [README, SESSION]): ScratchWorld {
  const world = scratchWorld(files);
  worlds.push(world);
  return world;
}

/**
 * The seam rig: the real kernel, against doubles for the world.
 *
 * Used where the end-to-end half cannot reach the behaviour under test because of a defect in
 * the wiring between `discovery/` and `adapters/`. Everything kernel-side is production code —
 * the workflow admission, the entry-stage walk, the predicate evaluator, the Definition of
 * Done — and the only substitutions are the ones that stand in for a world nobody can observe
 * from here.
 */
function seam(options: Parameters<typeof harness>[0] = {}): Harness {
  const rig = harness(options);
  rigs.push(rig);
  return rig;
}

function seamStart(overrides: Partial<StartInput> = {}): StartInput {
  return {
    source: 'NATURAL_LANGUAGE',
    sourceLocator: { adapter: 'host.cli', op: 'read_invocation', args: { argv_index: 1 } },
    raw: 'Fix typo in README.',
    resolveIdentity: () => Promise.resolve({ outcome: 'NOT_NAMED' }),
    rereadIntake: () => Promise.resolve({ outcome: 'OK', raw: 'Fix typo in README.' }),
    ...overrides,
  };
}

/** An envelope preceded by a read, so its coverage claim is not overstated. */
function withRead(envelope: HandoffEnvelope): ScriptedResponse {
  return {
    kind: 'CALLS_THEN_ENVELOPE',
    calls: [{ tool: 'repo__read_file', args: { path: 'README.md' } }],
    envelope: () => envelope,
  };
}

/* ================================================== 10. already-complete work ==== */

describe('scenario 10 — work already complete', () => {
  test('at the seam: reality showing the outcome already holds admits a COMPLETION-only parameterization, not a re-implementation', async () => {
    /*
     * End to end this is unreachable. `reality.outcome_already_satisfied` is established from
     * `runtime.outcome_evidence`, which D1 makes answer `ERROR`, so the element is permanently
     * `UNKNOWN` and the predicate permanently `INDETERMINATE`. Here the real kernel runs
     * against a discovery double reporting the outcome as observed.
     *
     * The three failures section 12 H names are each visible in the result: the graph is
     * COMPLETION only, so nothing is re-implemented and no second PR is opened; the
     * parameterization is admitted by the kernel from observed reality rather than proposed by
     * anyone; and the DoD still runs against whatever evidence is actually there.
     */
    const rig = seam({
      discovery: {
        reality: {
          outcome_evidence: fx.factAssertion(true, { probe: 'runtime.outcome_evidence' }),
        },
      },
      adapters: { files: [README] },
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: completionEnvelope() },
      ],
    });

    const result = await new Kernel(rig.ports).work(seamStart());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = rig.store.readRunLog(result.workItemId, result.runId).records;

    const [admitted] = eventsOf(log, 'workflow_admitted');
    assert.ok(admitted !== undefined, 'a workflow was admitted');
    assert.deepEqual(
      [...admitted.data.graph.stages],
      ['COMPLETION'],
      'nothing is re-implemented, no branch is created, no second PR is opened',
    );
    assert.equal(admitted.data.graph.template_id, 'investigation.readonly');

    const check = admitted.data.checks.find((c) => c.check === 'outcome_already_satisfied');
    assert.ok(check !== undefined, 'the admission records why it took this path');
    assert.equal(check.result, 'PASS');
    assert.match(
      check.detail,
      /The DoD still runs against existing evidence and can return INDETERMINATE/,
      'a bare declaration of victory is exactly what this is not',
    );

    assert.ok(
      eventsOf(log, 'dod_computed').length > 0,
      'the Definition of Done ran, against real evidence, on a COMPLETION-only graph',
    );
  });

  test('at the seam: an unreachable runtime does not become "already done", and does not become "not done" either', async () => {
    /*
     * Section 12 H's third failure mode. With the outcome element UNKNOWN the predicate is
     * INDETERMINATE, the COMPLETION-only path is not taken, and the run investigates rather
     * than declaring the work done on a probe that answered nothing. Re-implementing is both
     * more work and more irreversible mutation, so the safer-branch rule forbids proceeding —
     * and investigating is what is left.
     */
    const rig = seam({
      discovery: {
        reality: {
          outcome_evidence: fx.unknownAssertion({
            reason: 'UNAVAILABLE',
            probe: 'runtime.outcome_evidence',
          }),
        },
      },
      adapters: { files: [README] },
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        withRead(auditEnvelope()),
        withRead(rootCauseEnvelope()),
        { kind: 'ENVELOPE', envelope: completionEnvelope() },
      ],
    });

    const result = await new Kernel(rig.ports).work(seamStart());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = rig.store.readRunLog(result.workItemId, result.runId).records;
    const [admitted] = eventsOf(log, 'workflow_admitted');
    assert.ok(admitted !== undefined);
    assert.notDeepEqual([...admitted.data.graph.stages], ['COMPLETION']);
    assert.ok([...admitted.data.graph.stages].includes('AUDIT'));
  });

  test('end to end: a run whose outcome cannot be observed says so, and does not claim completion', async () => {
    const world = newWorld();
    const evidence = fileEvidence('E-01', 'README.md', README_CONTENT);
    const outcome = await work({
      world,
      raw: 'Fix the namespace restoration bug.',
      script: investigationScript(
        investigationGraph({
          resolution: resolution({
            type: 'INVESTIGATION',
            intent: 'INVESTIGATE',
            title: 'Namespace restoration bug',
            desiredOutcome: 'whether the namespace survives a restart is established',
            scopePaths: ['README.md'],
            evidence: [evidence],
            cites: [],
          }),
          evidence: [evidence],
          paths: ['README.md'],
          cause: 'the restore path is not exercised by any test',
        }),
        ['README.md'],
      ),
    });

    const { narrative } = await assertReadOnlyAndDurable(world, outcome);

    /*
     * The investigation completed, and that is not the same claim as "the namespace bug is
     * fixed" — which is the distinction this scenario exists to hold. What the run was bound
     * to is an `INVESTIGATION`'s outcome, judged by the `audit` profile, whose criteria are the
     * two an audit path supplies; both were supplied, with evidence that survived replay.
     */
    assert.equal(outcome.result.outcome, 'COMPLETE');
    assert.equal(completionVerdict(outcome.log), 'COMPLETE');

    /*
     * And here is the part that would be false success if it went the other way. The outcome
     * element could not be observed — no runtime is configured — so
     * `reality.outcome_already_satisfied` is `INDETERMINATE`, the COMPLETION-only
     * parameterization is *not* taken, and the run investigated instead of declaring the work
     * already done on a probe that answered nothing.
     */
    const satisfied = eventsOf(outcome.log, 'predicate_evaluated')
      .filter((event) => event.data.predicate === 'reality.outcome_already_satisfied');
    assert.ok(satisfied.length > 0, 'the predicate that decides "already done" was evaluated');
    assert.ok(
      satisfied.every((event) => event.data.evaluated === 'INDETERMINATE'),
      'an unobservable outcome is INDETERMINATE, and INDETERMINATE is not TRUE: '
      + `the run evaluated ${satisfied.map((e) => e.data.evaluated).join(', ')}`,
    );
    const [admittedGraph] = eventsOf(outcome.log, 'workflow_admitted');
    assert.ok(admittedGraph !== undefined);
    assert.notDeepEqual(
      [...admittedGraph.data.graph.stages],
      ['COMPLETION'],
      'nothing was skipped to a bare declaration of victory',
    );
    assert.match(
      narrative.out,
      /the Definition of Done computed \*\*COMPLETE\*\*/,
      'and the account says what it concluded, in the words of the verdict',
    );
  });
});

/* ==================================================== 11. ambiguous work ==== */

describe('scenario 11 — ambiguous work ("The pricing looks wrong.")', () => {
  /**
   * Alternatives spanning routine and incident.
   *
   * This is the one shape that reaches rung 4 end to end in this build. Rung 3 would otherwise
   * always succeed, because a single admissible template trivially shares its whole prefix with
   * itself — so the safe prefix is always available and the ladder never climbs past it.
   * `escalationOverride` (`core/src/ladder.ts:174`) skips rungs 1-3 when the candidate readings
   * span routine and incident, because those differ in urgency and not only in workflow: the
   * safer reading is the one that reaches a human sooner.
   */
  const ambiguous = () => resolution({
    type: 'DEFECT',
    intent: 'RESOLVE_DEFECT',
    title: 'The pricing looks wrong',
    desiredOutcome: 'the stored price and the displayed price agree with the pricing rule',
    scopePaths: ['README.md'],
    evidence: [fileEvidence('E-01', 'README.md', README_CONTENT)],
    cites: [],
    confidence: 0.41,
    alternatives: [
      {
        type: 'INVESTIGATION',
        reading: 'nothing is wrong; the reporter misread the displayed price',
        why_rejected: 'the reporter attached a screenshot showing two different numbers',
        would_do: 'audit and report, changing nothing',
      },
      {
        type: 'INCIDENT',
        reading: 'production is charging the wrong amount right now',
        why_rejected: 'no runtime or production observation has been made',
        would_do: 'contain first: stop the incorrect charges, then find the cause',
      },
    ],
  });

  function script() {
    const evidence = fileEvidence('E-01', 'README.md', README_CONTENT);
    return investigationScript(
      investigationGraph({
        resolution: ambiguous(),
        evidence: [evidence],
        paths: ['README.md'],
        cause: 'the display layer rounds before formatting',
      }),
      ['README.md'],
    );
  }

  test('end to end: the ladder is entered and one question is asked, carrying both readings and what AgentOS would do under each', async () => {
    const world = newWorld();
    const asked: {
      question: string;
      readings: readonly { readonly reading: string; readonly would_do: string }[];
    }[] = [];
    const outcome = await work({
      world,
      raw: 'The pricing looks wrong.',
      script: script(),
      operator: (question, readings) => {
        asked.push({ question, readings });
        return Promise.resolve('the first reading: it is a defect in the display layer');
      },
    });

    await assertReadOnlyAndDurable(world, outcome);

    assert.equal(asked.length, 1, 'one question, not a briefing and not a series');
    const [first] = asked;
    assert.ok(first !== undefined);
    assert.ok(
      first.readings.length >= 2,
      'the question carries the admitted reading as well as the alternatives — a question '
      + 'offering only the rejected ones would be a question with no right answer',
    );
    for (const reading of first.readings) {
      assert.ok(
        reading.would_do.trim().length > 0,
        'every reading says what AgentOS would do under it, which is what makes the question a '
        + 'discrimination rather than a briefing',
      );
    }
    assert.ok(
      first.readings.some((reading) => reading.reading.includes('INCIDENT')),
      'the incident reading is one of the ones offered',
    );

    const settled = notes(outcome.log, 'uncertainty ladder');
    assert.ok(
      settled.some((detail) => /settled at rung ASK/.test(detail)),
      `the ladder reached the asking rung; it recorded: ${settled.join(' | ')}`,
    );

    /* The question is durable: asked, then answered, each as its own event. */
    const questions = eventsOf(outcome.log, 'question');
    assert.equal(questions.filter((q) => q.data.phase === 'ASKED').length, 1);
    const answered = questions.find((q) => q.data.phase === 'ANSWERED');
    assert.ok(answered !== undefined, 'the answer is recorded against the question it answered');
    assert.equal(answered.data.answered_by, 'human');
  });

  test('end to end: with nobody there to answer, silence is never consent', async () => {
    const world = newWorld();
    const outcome = await work({
      world,
      raw: 'The pricing looks wrong.',
      script: script(),
      /* No operator. Every question goes unanswered, and none is invented. */
    });

    /*
     * A run that blocks at UNDERSTOOD never selects a workflow, and its narrative correctly
     * carries no workflow paragraph: there is no decision to account for, because AgentOS
     * declined to make one on silence.
     */
    const { narrative } = await assertReadOnlyAndDurable(world, outcome, { selectedWorkflow: false });
    assert.equal(outcome.result.outcome, 'BLOCKED');
    assert.match(
      narrative.out,
      /UNDERSTOOD -> BLOCKED on AMBIGUOUS_GOAL/,
      'the transition itself names the ambiguity as the reason',
    );
    assert.match(
      narrative.out,
      /Silence is never consent, and the run resumes in place when an answer arrives/,
    );
    assert.match(
      narrative.out,
      /a question was timed_out: .+ with 3 readings and what AgentOS would do under each/,
      'the unanswered question is in the account a human reads, not only in the log',
    );

    const questions = eventsOf(outcome.log, 'question');
    assert.equal(questions.filter((q) => q.data.phase === 'ASKED').length, 1);
    const timedOut = questions.find((q) => q.data.phase === 'TIMED_OUT');
    assert.ok(timedOut !== undefined, 'the unanswered question is recorded as unanswered');
    assert.equal(timedOut.data.answer, null);
    assert.equal(
      timedOut.data.answered_by,
      null,
      'nobody answered, and nobody is recorded as having answered',
    );

    const settled = notes(outcome.log, 'uncertainty ladder');
    assert.ok(
      settled.some((detail) => /settled at rung BLOCK/.test(detail)),
      `the ladder ended at the blocking rung: ${settled.join(' | ')}`,
    );
  });
});

/* ======================================================== 12. unknown work ==== */

describe('scenario 12 — unknown work', () => {
  test('end to end: UNKNOWN is admitted rather than rejected, and routes to investigation.readonly', async () => {
    const world = newWorld();
    const evidence = fileEvidence('E-01', 'README.md', README_CONTENT);
    const outcome = await work({
      world,
      raw: 'Something is off with the way this repository handles restarts.',
      script: investigationScript(
        investigationGraph({
          resolution: resolution({
            type: 'UNKNOWN',
            intent: 'INVESTIGATE',
            title: 'Something is off with restart handling',
            desiredOutcome: 'what is actually wrong with restart handling is established',
            scopePaths: ['README.md'],
            evidence: [evidence],
            cites: [],
            confidence: 0.3,
          }),
          evidence: [evidence],
          paths: ['README.md'],
          cause: 'restart handling has no test and no documented contract',
        }),
        ['README.md'],
      ),
    });

    const { narrative, status } = await assertReadOnlyAndDurable(world, outcome);

    assert.match(status.out, /UNKNOWN/, 'the work item is admitted, with type UNKNOWN');
    assert.match(narrative.out, /\*\*AgentOS decided this is a UNKNOWN\*\*/);
    assert.doesNotMatch(
      narrative.out,
      /the kernel admitted UNKNOWN/,
      'nothing was downgraded: UNKNOWN was claimed and UNKNOWN was admitted, on its own terms '
      + 'rather than for want of evidence. The narrative prints an admission check only when it '
      + 'is not PASS, and the type check passed',
    );
    assert.equal(
      outcome.built.store.getWorkItem(outcome.result.workItemId ?? '')?.type,
      'UNKNOWN',
      'the durable work item carries the type, so a later run reads it rather than re-deciding',
    );
    assert.equal(
      outcome.built.store.getWorkItem(outcome.result.workItemId ?? '')?.claimed_type,
      null,
      'and no claimed type is recorded, because nothing was claimed and refused',
    );
    assert.match(narrative.out, /template investigation\.readonly/);
    assert.ok(
      outcome.built.store.workItemExists(outcome.result.workItemId ?? ''),
      'an unknown request produces a durable work item somebody can go and look at',
    );
    /*
     * The investigation completes, and what completes is the investigation. `UNKNOWN`'s
     * outcome binds to `audit`, whose criteria are the two an audit path supplies; the run
     * supplied both, so the deliverable — findings, with evidence — is done. The type stayed
     * `UNKNOWN` throughout: nothing about completing an investigation into unknown work turns
     * the work into a Defect, and the assertions above are what say so.
     */
    assert.equal(outcome.result.outcome, 'COMPLETE');
    const [dod] = eventsOf(outcome.log, 'dod_computed');
    assert.ok(dod !== undefined);
    assert.equal(dod.data.profile_id, 'audit');
    assert.deepEqual(
      dod.data.criteria.map((c) => [c.criterion, c.verdict]),
      [[3, 'MET'], [4, 'MET']],
      'every criterion the profile names is MET, and the report names each one rather than '
      + 'reporting a total',
    );
    assert.deepEqual(
      [...dod.data.not_validated],
      [],
      'and nothing was quietly NOT_VALIDATED: unknown state never became false success, '
      + 'because there was no unknown state left in the judgment',
    );
  });
});

/* ========================================== 13. unresolvable external item ==== */

describe('scenario 13 — unresolvable external item', () => {
  function script() {
    const evidence = fileEvidence('E-01', 'README.md', README_CONTENT);
    return investigationScript(
      investigationGraph({
        resolution: resolution({
          type: 'STORY',
          intent: 'ADVANCE_EXISTING_WORK',
          title: 'Whatever the ticket says',
          desiredOutcome: 'the ticket is advanced',
          scopePaths: ['README.md'],
          identity: 'STORY-999',
          evidence: [evidence],
          cites: ['E-01'],
        }),
        evidence: [evidence],
        paths: ['README.md'],
        cause: 'never reached',
      }),
      ['README.md'],
    );
  }

  test('end to end: an unreachable source stops the run, and does not degrade into investigating the repository', async () => {
    const world = newWorld();
    const outcome = await work({
      world,
      source: 'PROJECT_MANAGEMENT',
      raw: 'STORY-999',
      projectManagement: unreachablePm(),
      script: script(),
    });

    await assertNothingAdvanced(world, outcome);
    assert.match(
      outcome.result.detail,
      /this blocks and resumes when the source returns, rather than degrading into investigating the repository instead/,
      'the reason states the blocking rule in the words the admission gave it',
    );
    assert.equal(
      outcome.substrate.dispatched.filter((input) => input.stage !== 'RESOLUTION').length,
      0,
      'no stage of the read-only graph ran: this is not an investigation of the repository',
    );

    /*
     * D5, repaired, and asserted rather than described. Admission computes `BLOCKED` with
     * `EXTERNAL_DEPENDENCY`, and the kernel now routes that through `block(...)` rather than
     * `refuse(...)`, so the kind travels with the outcome instead of being flattened into
     * prose. `reportRun` maps `BLOCKED` to exit 10, which is what a script branching on the
     * number needs: "resume when the source returns", not "your key is wrong".
     */
    assert.equal(outcome.result.outcome, 'BLOCKED');
    assert.equal(
      outcome.result.blockerKind,
      'EXTERNAL_DEPENDENCY',
      'the request was fine and the world was not, and the answer says which',
    );

    /*
     * The narrative is still thin, and honestly so: `core/src/narrative.ts` renders only the
     * admission checks whose result is `FAIL`, and an unreachable external identity is
     * `INDETERMINATE` — a check that could not be answered rather than one that failed. What a
     * human reads is that the proposal was not admitted and the run blocked; the reason is on
     * the `detail` line the CLI prints beside it, asserted above.
     */
    assert.match(
      outcome.result.narrative,
      /the resolution proposal on attempt 1 was not admitted and the run blocked rather than being refused/,
    );
    assert.match(
      outcome.result.narrative,
      /external_identity INDETERMINATE/,
      'and it names the check that could not be answered, which is what distinguishes this '
      + 'from a proposal somebody refused',
    );
  });

  test('end to end: a reachable source that does not hold the item stops the run too — and the two cases arrive as one', async () => {
    const world = newWorld();
    const outcome = await work({
      world,
      source: 'PROJECT_MANAGEMENT',
      raw: 'STORY-999',
      /* Configured, answering, and simply without STORY-999 in it. */
      projectManagement: reachableEmptyPm(),
      script: script(),
    });

    await assertNothingAdvanced(world, outcome);
    assert.equal(outcome.result.outcome, 'BLOCKED');
    assert.equal(
      outcome.result.blockerKind,
      'EXTERNAL_DEPENDENCY',
      'both silences block on something external, which is the half D5 repaired',
    );

    /*
     * Here is the gap that remains, as an assertion rather than a comment. The adapter knows
     * the difference:
     * `pm.read_issue` threw `ResourceAbsentError`, and `AdapterFramework`'s own presence check
     * (`adapters/src/framework.ts:768`) reads exactly that distinction for the idempotency
     * ledger. But `AdapterCallOutcome.ERROR` carries only a message, so `identityResolverFor`
     * (`core/src/composition/build.ts`) reports both as `UNAVAILABLE` — and says in its own
     * docstring that it must, because telling an operator their key is wrong when the server
     * was down is the more damaging mistake. The cost is that the operator is told to wait for
     * a system that is already up.
     */
    assert.match(outcome.result.detail, /the source is unreachable/);
    assert.doesNotMatch(
      outcome.result.detail,
      /The key is wrong/,
      'reachable-but-absent is not distinguished end to end; see the defect report',
    );
  });

  test('at the seam: the kernel does distinguish them, and says different things to a human', async () => {
    const rig = seam({
      adapters: { files: [README] },
      /* Two runs, one resolution dispatch each; a rejected proposal is re-dispatched once, so
       * four responses is the safe number. */
      script: Array.from({ length: 4 }, () => ({
        kind: 'ENVELOPE' as const,
        envelope: resolutionEnvelope(),
      })),
    });
    const forIdentity = (identity: StartInput['resolveIdentity']): StartInput => seamStart({
      source: 'PROJECT_MANAGEMENT',
      sourceLocator: { adapter: 'pm', op: 'read_issue', args: { key: 'STORY-999' } },
      raw: 'STORY-999',
      resolveIdentity: identity,
    });

    const unreachable = await new Kernel(rig.ports).work(forIdentity(
      () => Promise.resolve({
        outcome: 'UNAVAILABLE',
        identity: 'STORY-999',
        detail: 'the project-management host refused the connection',
      }),
    ));
    assert.match(unreachable.detail, /the source is unreachable/);
    assert.match(unreachable.detail, /resumes when the source returns/);

    const absent = await new Kernel(rig.ports).work(forIdentity(
      () => Promise.resolve({
        outcome: 'ABSENT',
        identity: 'STORY-999',
        detail: 'STORY-999 does not exist in the configured system',
      }),
    ));
    assert.match(absent.detail, /the source is reachable, and no such item exists/);
    assert.match(
      absent.detail,
      /The key is wrong, and a human should hear that rather than watch AgentOS work on a guess/,
    );
    assert.notEqual(
      unreachable.detail,
      absent.detail,
      'the two silences stay apart in the component that computes them; what loses them is the '
      + 'adapter outcome that cannot carry the difference',
    );
  });
});

/* ============================================================ 14. stale state ==== */

describe('scenario 14 — stale state', () => {
  test('end to end: a stale reality element is re-probed before it decides anything', async () => {
    const world = newWorld();
    const evidence = fileEvidence('E-01', 'README.md', README_CONTENT);
    const outcome = await work({
      world,
      raw: 'Check whether the restart fix landed.',
      script: investigationScript(
        investigationGraph({
          resolution: resolution({
            type: 'INVESTIGATION',
            intent: 'INVESTIGATE',
            title: 'Whether the restart fix landed',
            desiredOutcome: 'whether the fix is present and effective is established',
            scopePaths: ['README.md'],
            evidence: [evidence],
            cites: [],
          }),
          evidence: [evidence],
          paths: ['README.md'],
          cause: 'the fix is not present in the working tree',
        }),
        ['README.md'],
      ),
    });

    const { narrative } = await assertReadOnlyAndDurable(world, outcome);

    const evaluated = eventsOf(outcome.log, 'predicate_evaluated');
    const reprobed = evaluated.filter((event) => event.data.reprobed);
    assert.ok(
      reprobed.length > 0,
      'a stale element was re-probed before the predicate reading it decided anything; the '
      + `run evaluated ${evaluated.map((e) => e.data.predicate).join(', ')}`,
    );
    assert.ok(
      reprobed.some((event) => event.data.predicate === 'reality.outcome_already_satisfied'),
      'and the predicate that decides whether the work is already done is one of them',
    );

    /* And a human reading `agentos narrate` is told, in the words of the rule. */
    assert.match(
      narrative.out,
      /was evaluated after re-probing a stale element: reality is re-probed rather than snapshotted, because a review comment arriving mid-run would otherwise be invisible/,
    );
  });

  test('at the seam: the value the predicate uses is the re-probed one, not the snapshot', async () => {
    /*
     * The end-to-end half proves a re-probe happened. This proves it is load bearing: the
     * snapshot says the outcome does not hold, the fresh probe says it does, and what comes
     * back is the fresh one.
     */
    const rig = seam({
      discovery: {
        reality: { outcome_evidence: fx.factAssertion(false, { freshness: 'STALE' }) },
        reprobed: { outcome_evidence: fx.factAssertion(true, { freshness: 'CURRENT' }) },
      },
    });
    const fresh = await rig.ports.discovery.reprobeReality(
      'outcome_evidence',
      null,
      { paths: ['README.md'], capabilities: [], repositories: ['subject'] },
    );
    assert.equal(fresh.value, true, 'the fresh observation is what comes back');
    assert.deepEqual(rig.discovery.reprobeCalls, ['outcome_evidence']);
  });
});

/* =================================================== 15. contradictory sources ==== */

describe('scenario 15 — contradictory sources', () => {
  test('at the seam: two sources that disagree surface as a conflict rather than one silently winning', () => {
    /*
     * Section 5.3. Run state already holds git's observation; an envelope arrives claiming the
     * opposite. Neither is discarded, and the rule that resolves it is named rather than
     * implied — a conflict settled by whichever source happened to be read last is a conflict
     * nobody can audit.
     */
    const conflicts = detectConflicts({
      existing: new Map([[
        'reality.implementation_present',
        { assertion: fx.factAssertion(false, { probe: 'git.log' }), source: 'git.log' },
      ]]),
      envelope: fx.envelope({ envelope_id: 'env_x', agent: 'context-discovery' }),
      incoming: new Map([[
        'reality.implementation_present',
        fx.factAssertion(true, { probe: 'pm.read_issue' }),
      ]]),
    });

    assert.equal(conflicts.length, 1, 'the disagreement is detected, not averaged away');
    const [conflict] = conflicts;
    assert.ok(conflict !== undefined);
    assert.equal(conflict.subject, 'reality.implementation_present');
    assert.equal(conflict.positionA.claim, 'false');
    assert.equal(conflict.positionB.claim, 'true');
    assert.equal(
      conflict.positionA.source,
      'git.log',
      'both positions keep the source that made them, which is what an authority rule needs',
    );

    const resolved = resolveByRule(conflict);
    assert.ok(
      resolved.phase === 'RESOLVED_BY_RULE' || resolved.phase === 'DELEGATED',
      'the resolution states whether a rule settled it or it was delegated, so a reader can '
      + 'disagree with the rule rather than with a number',
    );
    assert.ok(
      resolved.detail.length > 0,
      'and it says why in words, which is what makes a conflict auditable rather than merely '
      + 'resolved',
    );
    assert.equal(
      sourceAuthority('git.log'),
      'repository',
      'git is authoritative about the repository and a ticket about intent; the authority '
      + 'table is what keeps them apart',
    );
    assert.equal(sourceAuthority('pm.read_issue'), 'intent');
  });

  test('at the seam: an unreachable source is INDETERMINATE, never a negative', () => {
    /*
     * The failure this prevents: a ticket system that will not answer reading as "there is no
     * ticket", which turns a reachability failure into a fact about the work.
     */
    const conflicts = detectConflicts({
      existing: new Map([[
        'reality.implementation_present',
        { assertion: fx.factAssertion(true, { probe: 'git.log' }), source: 'git.log' },
      ]]),
      envelope: fx.envelope({ envelope_id: 'env_y', agent: 'context-discovery' }),
      incoming: new Map([[
        'reality.implementation_present',
        fx.unknownAssertion({ reason: 'UNAVAILABLE', probe: 'pm.read_issue' }),
      ]]),
    });
    assert.deepEqual(
      conflicts,
      [],
      'an UNKNOWN contradicts nothing: "we could not look" is not a competing claim',
    );
  });

  test('end to end: a configured-and-unreachable source is recorded as a reduction, not as an absence', async () => {
    const world = newWorld();
    const evidence = fileEvidence('E-01', 'README.md', README_CONTENT);
    const outcome = await work({
      world,
      raw: 'Reconcile what the tracker says with what the code does.',
      /* Configured, and it will not answer. Not the same as having no tracker at all. */
      projectManagement: unreachablePm(),
      script: investigationScript(
        investigationGraph({
          resolution: resolution({
            type: 'INVESTIGATION',
            intent: 'INVESTIGATE',
            title: 'Tracker against code',
            desiredOutcome: 'where the tracker and the code disagree is established',
            scopePaths: ['README.md'],
            evidence: [evidence],
            cites: [],
          }),
          evidence: [evidence],
          paths: ['README.md'],
          cause: 'the tracker could not be read',
          /*
           * The fixture, made honest.
           *
           * It used to script a `context` mandate that judged criterion 1 `MET` and an `AUDIT`
           * that judged criteria 3 and 4 `MET` — while the one source this work item is *about*
           * would not answer. That produced a passing run, which is precisely the thing this
           * suite exists to catch: a dishonest agent is the failure mode, and a dishonest
           * fixture certifies that the machinery would not notice it.
           *
           * What an honest agent returns instead is below. Context Discovery is `PARTIAL`: it
           * read the repository, it could not perform the three-way reconciliation, and it says
           * which, so criterion 1 is `NOT_VALIDATED` with the reason rather than `MET`. The
           * Auditor is `BLOCKED`: it was asked to reconcile a tracker against code and the
           * tracker is unreachable, so it supplies no verdict at all — a criterion nobody could
           * judge is not a criterion met.
           */
          contextVerdict: {
            verdict: 'NOT_VALIDATED',
            reason:
              'the project-management source is configured and would not answer, so intent '
              + 'could not be read and the three-way reconciliation of intent against code '
              + 'against runtime was not performed. What the repository says is recorded; what '
              + 'anybody intended is not known',
            evidence: [],
          },
          contextOverrides: {
            status: 'PARTIAL',
            outputs: {
              context_package: 'context/v1.json',
              current_reality: 'context/v1.json#current_reality',
              discovery_gaps: 'context/v1.json#gaps',
            },
            unknowns: [fx.unknownRecord({
              id: 'U-tracker',
              subject: 'what the tracker says about this work',
              reason: 'UNAVAILABLE',
              attempted: 'the project-management adapter, which refused the connection',
              recoverable_by: 'restore connectivity to the tracker and re-run discovery',
              blocks: [],
            })],
          },
          auditOverrides: {
            status: 'BLOCKED',
            summary:
              'the audit is a reconciliation of the tracker against the code, and the tracker '
              + 'would not answer. The repository half was read; the comparison was not made',
            outputs: {},
            dod_verdicts: [],
            blockers: [fx.blocker({
              id: 'B-tracker',
              kind: 'MISSING_ACCESS',
              description:
                'the project-management source is configured and unreachable, so canonical '
                + 'ownership and the source contracts cannot be established against what the '
                + 'tracker declares',
              needs: 'access_grant',
              evidence: [],
            })],
            next_action: null,
          },
        }),
        ['README.md'],
      ),
    });

    await assertReadOnlyAndDurable(world, outcome);

    const finding = outcome.built.accessDerivation.findings.find(
      (entry) => entry.access === 'project_management',
    );
    assert.ok(finding !== undefined);
    assert.equal(finding.held, false);
    assert.equal(
      finding.state,
      'UNAVAILABLE',
      'configured-and-unreachable is UNAVAILABLE, which is worth waking a human for; '
      + 'NOT_CONFIGURED is not, and the two never collapse into each other',
    );

    /* The principle, unchanged and now actually exercised. */
    assert.notEqual(
      completionVerdict(outcome.log),
      'COMPLETE',
      'a run that could not read one of its sources does not report completion',
    );
    assert.equal(outcome.result.outcome, 'BLOCKED');
    assert.equal(
      outcome.result.blockerKind,
      'MISSING_ACCESS',
      'the run stopped where the access was missing, and says so in the blocker kind rather '
      + 'than only in prose',
    );
    assert.equal(
      completionVerdict(outcome.log),
      null,
      'COMPLETION was never reached: the stage that owed the verdicts said it could not supply '
      + 'them, and a Definition of Done computed over verdicts nobody gave would be arithmetic '
      + 'over absence',
    );

    /* And the criterion the prologue owns is NOT_VALIDATED with its reason, not quietly MET. */
    const [contextEnvelope] = eventsOf(outcome.log, 'envelope_received')
      .filter((event) => event.stage === 'CONTEXT_DISCOVERY');
    assert.ok(contextEnvelope !== undefined, 'the context mandate answered');
    assert.equal(contextEnvelope.data.status, 'PARTIAL');
  });
});

/* ================================================== 16. changed requirements ==== */

describe('scenario 16 — changed requirements', () => {
  const evidence = fileEvidence('E-01', 'README.md', README_CONTENT);
  const request = 'Rename the widget to a gadget throughout the documentation.';

  function script() {
    return investigationScript(
      investigationGraph({
        resolution: resolution({
          type: 'INVESTIGATION',
          intent: 'INVESTIGATE',
          title: 'Rename the widget to a gadget',
          desiredOutcome: 'every documented mention of the widget is identified',
          scopePaths: ['README.md'],
          evidence: [evidence],
          cites: [],
        }),
        evidence: [evidence],
        paths: ['README.md'],
        cause: 'the documentation names the widget in one place',
      }),
      ['README.md'],
    );
  }

  test('end to end: an unedited source is re-read at COMPLETION and recorded UNCHANGED, with both hashes', async () => {
    const world = newWorld();
    const outcome = await work({ world, raw: request, script: script() });

    await assertReadOnlyAndDurable(world, outcome);
    const drift = eventsOf(outcome.log, 'source_drift');
    assert.equal(drift.length, 1, 'the drift check runs on every completion, not only on doubt');
    const [only] = drift;
    assert.ok(only !== undefined);
    assert.equal(only.data.state, 'UNCHANGED');
    assert.equal(
      only.data.hash_now,
      only.data.hash_at_admission,
      'the check is a comparison of content hashes, re-executed through the same locator the '
      + 'original observation went through',
    );
  });

  test('end to end (with the re-reader standing in for an edited source, per D4): drift is disclosed and the verdict is computed against the admitted work item', async () => {
    /*
     * One substitution: `rereadIntake` answers with the edited text. Everything downstream is
     * production code — `compareSourceDrift`, the `source_drift` event, the disclosure in the
     * narrative, and the verdict. It is substituted because D4 makes a genuinely edited ticket
     * unobservable: `intakeRereaderFor` cannot extract text from `pm.read_issue`'s answer, so a
     * PM-sourced run records `UNAVAILABLE` whatever the ticket says.
     */
    const world = newWorld();
    const edited = 'Rename the widget to a doohickey throughout the documentation, and the code.';
    const outcome = await work({
      world,
      raw: request,
      script: script(),
      rereadIntake: (locator: Locator) => {
        assert.equal(locator.adapter, 'host', 'the locator re-executed is the recorded one');
        assert.equal(locator.op, 'read_intake');
        return Promise.resolve({ outcome: 'OK', raw: edited });
      },
    });

    const { narrative } = await assertReadOnlyAndDurable(world, outcome);

    const [drift] = eventsOf(outcome.log, 'source_drift');
    assert.ok(drift !== undefined);
    assert.equal(drift.data.state, 'CHANGED');
    assert.notEqual(
      drift.data.hash_now,
      drift.data.hash_at_admission,
      'the disclosure is the two hashes, which is the diff a reader can check',
    );
    assert.match(
      drift.data.detail,
      /The verdict is computed against the admitted work item, because that is what was actually done, and the reader is told the request has moved/,
    );

    /* Disclosed in the narrative a human reads, not merely journalled. */
    assert.match(narrative.out, /the intake source/i);

    /* And AgentOS did not chase the edit: it reports against the outcome it admitted. */
    assert.match(narrative.out, /every documented mention of the widget is identified/);
    assert.doesNotMatch(narrative.out, /doohickey/);
  });

  test('end to end: a source that cannot be re-read is UNAVAILABLE and not a blocker, because the work is finished either way', async () => {
    const world = newWorld();
    const outcome = await work({
      world,
      raw: request,
      script: script(),
      rereadIntake: () => Promise.resolve({
        outcome: 'UNAVAILABLE',
        detail: 'the host would not answer',
      }),
    });

    await assertReadOnlyAndDurable(world, outcome);
    const [drift] = eventsOf(outcome.log, 'source_drift');
    assert.ok(drift !== undefined);
    assert.equal(drift.data.state, 'UNAVAILABLE');
    assert.equal(drift.data.hash_now, null, 'no hash is invented for a read that did not happen');
    assert.match(drift.data.detail, /Recorded as UNAVAILABLE and not a blocker/);
  });

  test('end to end: a project-management intake compares the ticket body against the ticket body, which is D4 repaired', async () => {
    const ticket = { key: 'INV-7', type: 'Task', summary: 'Rename the widget', status: 'Open' };
    const world = newWorld();
    const ticketEv = ticketEvidence('E-T', 'INV-7', ticket);
    const outcome = await work({
      world,
      source: 'PROJECT_MANAGEMENT',
      raw: 'INV-7',
      projectManagement: reachablePm({ 'INV-7': ticket }),
      script: investigationScript(
        investigationGraph({
          resolution: resolution({
            type: 'INVESTIGATION',
            intent: 'INVESTIGATE',
            title: 'Rename the widget',
            desiredOutcome: 'every documented mention of the widget is identified',
            scopePaths: ['README.md'],
            identity: 'INV-7',
            evidence: [ticketEv, evidence],
            cites: ['E-T'],
          }),
          evidence: [evidence],
          paths: ['README.md'],
          cause: 'the documentation names the widget in one place',
        }),
        ['README.md'],
      ),
    });

    await assertReadOnlyAndDurable(world, outcome);
    assert.equal(
      outcome.unresolvedIntake,
      null,
      'the ticket was dereferenced at admission, through the same reader the drift check '
      + 're-executes at COMPLETION',
    );
    const [drift] = eventsOf(outcome.log, 'source_drift');
    assert.ok(drift !== undefined);
    assert.equal(
      drift.data.state,
      'UNCHANGED',
      'nobody edited INV-7 between admission and completion, and the check says so. Before D4 '
      + 'was repaired this could only ever be UNAVAILABLE — and had the text been extractable '
      + 'it would have been CHANGED on every run for ever, because the hash was taken over the '
      + 'key the operator typed and the re-read produced the ticket body',
    );
    assert.equal(
      drift.data.hash_now,
      drift.data.hash_at_admission,
      'both hashes are over the ticket body, produced by the same code against the same '
      + 'locator, which is the only arrangement in which the comparison means anything',
    );
  });
});
