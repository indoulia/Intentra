import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import type { CheckOutcome, Event, WorkflowProposal } from '@agentos/contracts';
import { MvpAgentCatalog } from '@agentos/agents';
import { README_CONTENT } from '../doubles.js';
import { scratchWorld, type ScratchWorld } from './world.js';
import {
  assertReadOnlyAndDurable,
  eventsOf,
  investigationScript,
  work,
  type WorkOutcome,
} from './rig.js';
import { fileEvidence, investigationGraph, resolution } from './envelopes.js';

/**
 * K-1: the Orchestrator's workflow dispatch happens on the live path.
 *
 * The defect this file exists for was not a wrong answer. `core/src/kernel.ts` asked the agent
 * catalogue for a mandate named `workflow`, `agents/src/roles/specs.ts` specifies it as
 * `orchestration`, the lookup returned `undefined`, and `dispatchOrchestrator` returned before
 * it reached the substrate. Every run took the kernel's fallback template. Nothing failed,
 * because in a build where `execution.json` admits one template for every work item type the
 * fallback and the proposal choose the same graph — so the *outcome* of a run with the
 * Orchestrator wired and a run with it disconnected is identical, and 1225 passing tests said
 * nothing about which of the two was happening.
 *
 * That is what makes this a wiring test rather than a behaviour test, and why it lives in the
 * end-to-end suite rather than beside the unit tests for `admitWorkflow`. Every assertion here
 * is against a run driven through `buildKernel` — the real composition root, the real
 * `MvpAgentCatalog`, the real policy set — with the substrate and only the substrate replaced
 * by a recording. A test built on the kernel-unit harness could not have caught K-1 at all:
 * that harness's agent double answers a mandate lookup that misses by falling back to any
 * specification the role has, which is exactly the miss the composition root cannot absorb.
 *
 * The four things asserted, in the order a reader should want them:
 *
 * 1. The dispatch happens, to the mandate the real catalogue actually specifies.
 * 2. Its proposal reaches admission and is what the frozen graph came from — established from
 *    the checks `admitWorkflow` recorded, not from the template id, because the template id is
 *    the same either way and that is the whole reason this went unnoticed.
 * 3. A proposal that fails admission is overridden, recorded, and does not stop the run.
 * 4. The Orchestrator reaches the world through nothing: its granted tool set is empty on the
 *    live path, and its envelope is received through the same receipt as every other.
 */

const README = { path: 'README.md', content: README_CONTENT };

const worlds: ScratchWorld[] = [];
after(() => {
  for (const world of worlds) world.destroy();
});

function newWorld(): ScratchWorld {
  const world = scratchWorld([README]);
  worlds.push(world);
  return world;
}

/**
 * The standard read-only run, with the Orchestrator's proposal overridable.
 *
 * `proposal` is spread into the `WorkflowProposal` the recording returns, so a case that wants
 * the kernel to refuse changes one field of an otherwise honest envelope rather than inventing
 * a shape no Orchestrator would send.
 */
function run(
  world: ScratchWorld,
  proposal?: Partial<WorkflowProposal>,
): Promise<WorkOutcome> {
  const evidence = fileEvidence('E-01', 'README.md', README_CONTENT);
  return work({
    world,
    raw: 'Audit how this repository documents itself.',
    script: investigationScript(
      investigationGraph({
        resolution: resolution({
          type: 'INVESTIGATION',
          intent: 'INVESTIGATE',
          title: 'Self-documentation',
          desiredOutcome: 'what the repository claims about itself is established',
          scopePaths: ['README.md'],
          evidence: [evidence],
          cites: [],
        }),
        evidence: [evidence],
        paths: ['README.md'],
        cause: 'the documentation is the only account of the behaviour',
        ...(proposal === undefined ? {} : { workflowProposal: proposal }),
      }),
      ['README.md'],
    ),
  });
}

/** The `dispatch_intent` the Orchestrator's workflow dispatch wrote, or `undefined`. */
function workflowIntent(log: readonly Event[]) {
  return eventsOf(log, 'dispatch_intent')
    .find((event) => event.stage === 'WORKFLOW_SELECTED');
}

/** A named check from the one `workflow_admitted` event, or `undefined`. */
function admissionCheck(log: readonly Event[], name: string): CheckOutcome | undefined {
  const admitted = eventsOf(log, 'workflow_admitted')[0];
  return admitted?.data.checks.find((check) => check.check === name);
}

describe('K-1 — the composed runtime reaches the Orchestrator\'s workflow dispatch', () => {
  test('the live path dispatches the mandate the real agent catalogue specifies', async () => {
    const world = newWorld();
    const outcome = await run(world);
    await assertReadOnlyAndDurable(world, outcome);

    const intent = workflowIntent(outcome.log);
    assert.ok(
      intent !== undefined,
      'the composed runtime dispatches at WORKFLOW_SELECTED. Without this event the '
      + 'Orchestrator was never asked and every run silently took the fallback template, '
      + 'which is decision K-1 and is invisible in every other assertion in this suite',
    );

    const input = intent?.data.input_package;
    assert.equal(input?.agent, 'orchestrator');
    assert.equal(input?.stage, 'WORKFLOW_SELECTED');

    /*
     * The anti-drift assertion, and the reason this test is worth its runtime.
     *
     * The kernel names the mandate it looks up; the specification names the mandate it
     * provides; K-1 is the two disagreeing. Comparing the dispatched name against the real
     * catalogue rather than against a literal means renaming either side breaks this test,
     * which is the only arrangement under which a rename cannot silently disconnect the
     * dispatch again.
     */
    const catalogue = new MvpAgentCatalog();
    const spec = catalogue.spec('orchestrator', input?.mandate_name ?? '');
    assert.ok(
      spec !== undefined,
      `the dispatch names mandate "${input?.mandate_name ?? ''}" and the real catalogue `
      + `provides ${catalogue.all().filter((s) => s.role === 'orchestrator')
        .map((s) => s.mandate_name).join(', ') || 'none'} for the orchestrator. A lookup that `
      + 'misses is indistinguishable from a role that is not installed, and it costs the run '
      + 'its only judgment about which workflow to run',
    );
    assert.deepEqual(input?.required_outputs, spec?.required_outputs);
    assert.deepEqual(input?.required_inputs, spec?.required_inputs);

    /*
     * And the sections it declared were actually built. `materialize` copies only the sections
     * present on the Context Package, so a specification asking for a section name the package
     * does not carry would produce a dispatch that reads as complete and was handed nothing —
     * a proposal reasoned over an empty package, which is worse than no proposal at all.
     */
    assert.deepEqual(
      Object.keys(input?.context_sections ?? {}).sort(),
      [...(spec?.required_inputs ?? [])].sort(),
      'every section the mandate declares is materialized, none silently dropped',
    );

    /* And it was answered: an intent with no result is an interrupted dispatch, not a live one. */
    const result = eventsOf(outcome.log, 'dispatch_result')
      .find((event) => event.stage === 'WORKFLOW_SELECTED');
    assert.equal(result?.data.outcome, 'ENVELOPE');
    assert.notEqual(result?.data.envelope_id, null);
  });

  test('the proposal reaches admission, and the frozen graph is what admitted it', async () => {
    const world = newWorld();
    const outcome = await run(world);

    /*
     * Not asserted on the template id. `investigation.readonly` is what the fallback selects
     * too, so an assertion on the id would pass with the dispatch disconnected — which is
     * precisely how K-1 survived. The checks say which path ran: `admitWorkflow` records
     * `template_selected` only where no proposal arrived, and the four proposal checks only
     * where one did.
     */
    assert.equal(
      admissionCheck(outcome.log, 'template_selected'),
      undefined,
      'no "no proposal was made" check, because a proposal was made',
    );
    for (const name of ['template_exists', 'applies_to_matches', 'no_stage_invention']) {
      assert.equal(
        admissionCheck(outcome.log, name)?.result,
        'PASS',
        `${name} ran, which only happens against an actual proposal`,
      );
    }

    assert.equal(
      eventsOf(outcome.log, 'workflow_admitted')[0]?.data.graph.template_id,
      'investigation.readonly',
      'and the admitted graph is the one the Orchestrator named — which in this build is also '
      + 'the only one the installation would have run',
    );

    /*
     * What a *correct* proposal costs in this installation, said out loud rather than left for
     * somebody to discover in a narrative.
     *
     * The workflow floor's predicate-keyed rules fire on INDETERMINATE as well as on TRUE, by
     * the safer-branch rule. `architecture.required` is INDETERMINATE against a scratch
     * repository with no api map, so `contract-boundary-requires-architecture` requires a stage
     * `investigation.readonly` does not contain — and `investigation.readonly` is the only
     * template this build admits. So every proposal, including the right one, fails the floor
     * and the kernel selects the same graph as the fallback. The record has to say that it was
     * the installation and not the proposer, or every run in v0.3 reads as an Orchestrator that
     * got it wrong.
     */
    const override = eventsOf(outcome.log, 'workflow_override')[0];
    assert.equal(override?.data.proposed_template, 'investigation.readonly');
    assert.equal(override?.data.selected_template, 'investigation.readonly');
    assert.match(
      override?.data.reason ?? '',
      /not about the proposal being wrong/,
      'the override does not blame the Orchestrator for a template set that cannot satisfy the '
      + 'floor',
    );
    assert.deepEqual(
      override?.data.failed_checks.map((check) => check.check),
      ['workflow_floor'],
      'and it names what actually failed',
    );
  });

  test('a proposal that fails admission is overridden and recorded, and the run continues', async () => {
    const world = newWorld();
    /*
     * A template that does not exist. The Orchestrator being wrong costs efficiency and never
     * safety: the kernel selects the most conservative admissible template, records the
     * override with the failed check, and the run finishes.
     */
    const outcome = await run(world, { template_id: 'implementation.aggressive' });
    await assertReadOnlyAndDurable(world, outcome);

    const override = eventsOf(outcome.log, 'workflow_override')[0];
    assert.ok(override !== undefined, 'the override is recorded rather than silently applied');
    assert.equal(override?.data.proposed_template, 'implementation.aggressive');
    assert.equal(override?.data.selected_template, 'investigation.readonly');
    assert.ok(
      override?.data.failed_checks.some((check) => check.check === 'template_exists'),
      'and it names the check that failed, so an Orchestrator that is systematically wrong is '
      + 'visible in the narrative rather than merely ignored',
    );
    assert.equal(
      outcome.result.outcome,
      'COMPLETE',
      'a failed admission is not negotiated and is not fatal: the fallback runs',
    );
  });

  test('the Orchestrator holds no adapters on the live path, and its envelope is received', async () => {
    const world = newWorld();
    const outcome = await run(world);

    const input = workflowIntent(outcome.log)?.data.input_package;
    assert.deepEqual(
      input?.tools_granted,
      [],
      'the component that judges evidence must not also manufacture it, and the granted tool '
      + 'set is what makes that true rather than intended',
    );

    const surface = eventsOf(outcome.log, 'tool_surface_conformance')
      .find((event) => event.stage === 'WORKFLOW_SELECTED');
    assert.equal(
      surface?.data.verdict,
      'CONFORMS',
      'D-2 applies to this dispatch too: the effective surface is compared against the empty '
      + 'granted set rather than left unchecked because it is empty',
    );
    assert.deepEqual(surface?.data.effective, []);

    const received = eventsOf(outcome.log, 'envelope_received')
      .find((event) => event.stage === 'WORKFLOW_SELECTED');
    assert.ok(
      received !== undefined,
      'the proposal arrives inside an envelope that passed receipt, not as raw JSON the '
      + 'kernel trusted to have the shape it expected',
    );
    assert.ok(
      received?.data.steps.some((step) => step.check === 'schema' && step.result === 'PASS'),
    );
    assert.ok(
      received?.data.steps.some((step) => step.check === 'cross_field' && step.result === 'PASS'),
    );
    /*
     * Coverage is unanswerable rather than overstated here, and that distinction is the
     * kernel's to make: the reconciliation is told what the dispatch was granted, so a claim
     * from a dispatch that held no adapter is recorded as unreconciled instead of rejected as
     * a lie. A dispatch that *held* tools and claimed coverage it never touched is still
     * refused, which `disbelief.test.ts` asserts.
     */
    assert.equal(
      received?.data.steps.find((step) => step.check === 'reconciliation')?.result,
      'INDETERMINATE',
    );
  });
});
