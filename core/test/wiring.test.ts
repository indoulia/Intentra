import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtures as fx,
  type AuthorizationGrant,
  type CallRecord,
  type Classification,
  type Event,
  type HandoffEnvelope,
  type SkillEntry,
  type StageDescriptor,
} from '@agentos/contracts';
import { loadPolicies } from '@agentos/policies';
import { Kernel, type StartInput } from '../src/kernel.js';
import { classifyGates, grantEnforcer, type ClassifierInput } from '../src/authorization.js';
import { resolveByRule, sourceAuthority, subjectAuthority, type Conflict } from '../src/arbitration.js';
import { reconcile } from '../src/reconciliation.js';
import { decideAction, type TransitionContext } from '../src/state-machine.js';
import { discoveryLoopAllowed } from '../src/budgets.js';
import { classifyDispatch } from '../src/selection.js';
import {
  AnsweringHuman,
  README_CONTENT,
  auditEnvelope,
  completionEnvelope,
  defaultModel,
  defaultSpecs,
  harness,
  policiesAllowingMutation,
  resolutionEnvelope,
  rootCauseEnvelope,
  workflowEnvelope,
  type ScriptedResponse,
} from './doubles.js';

/**
 * WP-7's unwired paths, and the adversarial cases they exist for.
 *
 * Everything here was reachable in principle and dead in practice: a function with rules and
 * no caller, a `discover` hook nothing supplied, a route-back journalled and not taken, a
 * classifier that failed open on a probe that failed.
 */

const policies = loadPolicies();

const README = { path: 'README.md', content: README_CONTENT };

const cleanup: (() => void)[] = [];
after(() => {
  for (const fn of cleanup) fn();
});

function rig(options: Parameters<typeof harness>[0] = {}) {
  const h = harness({ adapters: { files: [README], ...options.adapters }, ...options });
  cleanup.push(() => { h.destroy(); });
  return h;
}

function withCall(envelope: HandoffEnvelope, path = 'README.md'): ScriptedResponse {
  return {
    kind: 'CALLS_THEN_ENVELOPE',
    calls: [{ tool: 'repo__read_file', args: { path } }],
    envelope: () => envelope,
  };
}

function start(overrides: Partial<StartInput> = {}): StartInput {
  return {
    source: 'NATURAL_LANGUAGE',
    sourceLocator: { adapter: 'host.cli', op: 'read_invocation', args: { argv_index: 1 } },
    raw: 'Fix typo in README.',
    resolveIdentity: async () => ({ outcome: 'NOT_NAMED' }),
    rereadIntake: async () => ({ outcome: 'OK', raw: 'Fix typo in README.' }),
    ...overrides,
  };
}

function notes(log: readonly Event[], topic: string): readonly string[] {
  return log
    .filter((e): e is Extract<Event, { event: 'note' }> => e.event === 'note')
    .filter((e) => e.data.topic.includes(topic))
    .map((e) => e.data.detail);
}

/**
 * A resolution whose reading is genuinely ambiguous.
 *
 * Rung 4 needs alternatives to build a question from, and a run whose understanding is
 * insufficient with no shared safe prefix and nothing to ask has nowhere to go but rung 5. A
 * proposal carrying alternatives is what a resolver produces when it is not sure, and it is
 * what lets a test reach anything past `UNDERSTOOD` in that state.
 */
function ambiguousResolution(): HandoffEnvelope {
  return resolutionEnvelope({
    alternatives: [{
      type: 'INVESTIGATION',
      reading: 'nothing needs changing; the reporter misread the file',
      why_rejected: 'the misspelling is present in the file that was read',
      would_do: 'audit and report, changing nothing',
    }],
  });
}

/**
 * Context sections that make the applicability predicates determinate.
 *
 * Without them `architecture.required` and `ux.required` are INDETERMINATE, the safer-branch
 * rule keeps both stages, and the workflow floor refuses every template that does not contain
 * them — which is correct, and which means a test about the *resume sweep* would never reach
 * one.
 */
const DETERMINATE_SECTIONS = {
  domain_model: { canonical_ownership: fx.factAssertion({}) },
  ui_map: { surfaces: fx.factAssertion([]) },
  api_map: { endpoints: fx.factAssertion([]) },
  source_map: { sources: fx.factAssertion([]) },
};

/* ================================================= C1: targeted resume discovery ==== */

describe('C1 — the resume sweep dispatches targeted discovery, in production', () => {
  test('an INDETERMINATE mutating stage is probed rather than going straight to AMBIGUOUS_STATE', async () => {
    /*
     * `computeEntryStage` accepted a `discover` hook and the kernel never supplied one, so the
     * DISCOVER arm of the resume rule was dead: every indeterminate mutating stage went
     * straight to `AMBIGUOUS_STATE`. Safe, and wrong — it blocked runs a single re-read would
     * have resumed.
     *
     * A mutating stage is needed for the arm to be reachable at all, so this runs against the
     * policy set with mutating templates admissible.
     */
    const h = rig({
      policies: policiesAllowingMutation(),
      discovery: {
        reality: {
          implementation_present: fx.unknownAssertion({ reason: 'UNAVAILABLE' }),
        },
        sections: DETERMINATE_SECTIONS,
      },
      human: new AnsweringHuman('the first reading: it is a task'),
      script: [
        { kind: 'ENVELOPE', envelope: ambiguousResolution() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope({ template_id: 'task.direct' }) },
        ...Array.from({ length: 8 }, () => withCall(auditEnvelope())),
      ],
    });

    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = h.store.readRunLog(result.workItemId, result.runId).records;

    const probes = log.filter(
      (e): e is Extract<Event, { event: 'discovery' }> => e.event === 'discovery',
    ).filter((e) => e.data.kind === 'TARGETED_PROBE');

    assert.ok(
      probes.length > 0,
      'the kernel supplies the discover hook, so the DISCOVER arm is reachable in production',
    );
    assert.match(
      probes[0]?.data.reason ?? '',
      /the kernel probes rather than choosing/,
    );
    assert.ok(
      h.discovery.reprobeCalls.includes('implementation_present'),
      'and the probe goes through DiscoveryPort.reprobeReality, not through a model',
    );
  });

  test('a targeted probe is counted against the discovery loop budget', async () => {
    const h = rig({
      policies: policiesAllowingMutation(),
      discovery: {
        reality: { implementation_present: fx.unknownAssertion({ reason: 'UNAVAILABLE' }) },
        sections: DETERMINATE_SECTIONS,
      },
      human: new AnsweringHuman('the first reading: it is a task'),
      script: [
        { kind: 'ENVELOPE', envelope: ambiguousResolution() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope({ template_id: 'task.direct' }) },
        ...Array.from({ length: 8 }, () => withCall(auditEnvelope())),
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = h.store.readRunLog(result.workItemId, result.runId).records;
    const consumed = log.filter(
      (e): e is Extract<Event, { event: 'budget' }> => e.event === 'budget',
    ).filter((e) => e.data.counter === 'loops.discovery' && e.data.kind === 'CONSUMED');
    assert.ok(
      consumed.length > 0,
      'the discovery loop counter was previously incremented nowhere at all, so the bound on '
      + '"the kernel discovers rather than choosing" bounded nothing',
    );
  });

  test('the discovery budget is checked per run and per work item', () => {
    const caps = policies.budgets.loops.discovery;
    assert.equal(discoveryLoopAllowed({ run: 0, workItem: 0 }, policies.budgets).allowed, true);
    const spentRun = discoveryLoopAllowed(
      { run: caps.per_run, workItem: 0 }, policies.budgets,
    );
    assert.equal(spentRun.allowed, false);
    assert.equal(spentRun.scope, 'run');
    const spentItem = discoveryLoopAllowed(
      { run: 0, workItem: caps.per_work_item }, policies.budgets,
    );
    assert.equal(spentItem.allowed, false);
    assert.equal(spentItem.scope, 'work_item');
    assert.match(spentItem.reason, /not a budget/);
  });
});

/* ============================================================ C5: re-resolution ==== */

describe('C5 — re-resolution re-runs RESOLUTION and starts a new run', () => {
  function misclassified(): HandoffEnvelope {
    return fx.envelope({
      envelope_id: 'env_misclassified',
      agent: 'auditor',
      stage_in: 'ROOT_CAUSE',
      status: 'BLOCKED',
      outputs: {},
      coverage: fx.coverage({ scope_examined: ['README.md'] }),
      blockers: [fx.blocker({
        kind: 'WORK_ITEM_MISCLASSIFIED',
        description: 'the feature this supposed defect is about was never built',
        needs: 're_resolution',
        evidence: [],
      })],
      next_action: null,
    });
  }

  test('the run ends RERESOLVED, resolution runs again, and a new run starts on the same item', async () => {
    /*
     * The regression. The kernel ended the run `RERESOLVED`, counted it against the cap, wrote
     * `new_run_id: null` — and never re-ran `RESOLUTION` and never started the new run. Steps
     * 2 and 3 of section 4.5 did not exist, so "the run ends honestly and a new one starts"
     * was half true.
     */
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(misclassified()),
        /* The re-resolution: a second RESOLUTION dispatch, then a whole new run. */
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });

    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null);

    const runs = h.store.listRuns(result.workItemId);
    assert.equal(runs.length, 2, 'a new Workflow Run against the same Work Item');
    assert.notEqual(
      result.runId,
      runs[0],
      'the result is the new run, and the old one is still there',
    );

    const workItemLog = h.store.readWorkItemLog(result.workItemId).records;
    const reresolved = workItemLog.filter(
      (e): e is Extract<Event, { event: 'reresolved' }> => e.event === 'reresolved',
    );
    assert.ok(reresolved.length >= 2, 'the run ending, and which run the work item became');
    assert.ok(
      reresolved.some((e) => e.data.new_run_id !== null),
      'the new run id is recorded, which it never was',
    );

    /* Identity, history and every prior envelope survive; only the graph is new. */
    const first = runs[0];
    assert.ok(first !== undefined);
    assert.ok(
      h.store.readRunLog(result.workItemId, first).records.length > 0,
      'the previous run\'s log is untouched',
    );
    const item = h.store.getWorkItem(result.workItemId);
    assert.equal(item?.reresolution_count, 1);
    assert.equal(item?.runs.length, 2);
  });

  test('a second re-resolution is refused: BLOCKED with a human beats a third guess', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(misclassified()),
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(misclassified()),
      ],
    });

    const result = await new Kernel(h.ports).work(start());
    assert.equal(result.outcome, 'BLOCKED');
    assert.match(result.detail, /re-resolution is capped at 1/);
    assert.ok(result.workItemId !== null);
    assert.equal(
      h.store.listRuns(result.workItemId).length,
      2,
      'two runs, and no third: the cap is what stops a third guess',
    );
  });
});

/* ================================================== C6: the INCOMPLETE route-back ==== */

describe('C6 — INCOMPLETE routes back into the graph, and the route-back runs', () => {
  /*
   * An INVESTIGATION binds to the `audit` profile, whose critical criteria 3 and 4 are owned
   * by `AUDIT` — a stage this template contains. A profile whose unmet criteria no stage in
   * the graph owns computes INDETERMINATE instead, which is a different and equally correct
   * outcome, and not the one this behaviour is about.
   */
  const investigation = (): HandoffEnvelope => resolutionEnvelope({
    type: fx.inferenceAssertion('INVESTIGATION'),
  });

  test('a stage that owes verdicts and supplied none is re-entered', async () => {
    /*
     * This is the mechanism that makes resumption safe. `COMPLETED_PRIOR` means the mutation
     * has already happened, not that the criteria are met — so the criteria come back
     * `NOT_VALIDATED`, `COMPLETION` computes `INCOMPLETE`, and the run routes back to the stage
     * that owes them. A route-back that is journalled and not taken is a safety property
     * nothing enforces.
     */
    const partialAudit = auditEnvelope({
      dod_verdicts: [fx.criterionVerdict({ criterion: 3, evidence: ['E-01'] })],
    });
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: investigation() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(partialAudit),
        withCall(rootCauseEnvelope()),
        /* The route-back lands here: AUDIT again, this time supplying what it owed. Envelopes
         * are immutable in the store, so the second lap's carry their own ids. */
        withCall(auditEnvelope({ envelope_id: 'env_audit_2' })),
        withCall(rootCauseEnvelope({ envelope_id: 'env_root_cause_2' })),
      ],
    });

    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = h.store.readRunLog(result.workItemId, result.runId).records;

    const routeBacks = log.filter(
      (e): e is Extract<Event, { event: 'transition' }> => e.event === 'transition',
    ).filter((e) => e.data.from === 'COMPLETION' && e.data.to === 'AUDIT');
    assert.equal(routeBacks.length, 1, 'the transition is journalled');

    const auditDispatches = log.filter(
      (e) => e.event === 'dispatch_intent' && e.stage === 'AUDIT',
    );
    assert.equal(
      auditDispatches.length,
      2,
      'and it is executed: AUDIT runs again, which is what a wasted lap looks like',
    );
    assert.ok(notes(log, 'route back').some((d) => d.includes('has no authority over')));
  });

  test('a COMPLETED_PRIOR stage does not yield COMPLETE', async () => {
    /*
     * The adversarial case the route-back exists for. A resumed run marks a stage
     * `COMPLETED_PRIOR` because git says the mutation happened; that stage supplies no
     * verdicts; and the run must not thereby be complete.
     */
    const h = rig({
      discovery: {
        reality: {
          agentos_history: fx.factAssertion([
            { run_id: 'run_prior', stages_completed: ['AUDIT', 'ROOT_CAUSE'] },
          ]),
        },
      },
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(completionEnvelope()),
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });

    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = h.store.readRunLog(result.workItemId, result.runId).records;

    const marked = log.filter((e) => e.event === 'stage_marked_completed_prior');
    assert.ok(marked.length > 0, 'AUDIT and ROOT_CAUSE are skipped as already done');
    assert.notEqual(
      result.outcome,
      'COMPLETE',
      'a wrong resume costs a lap; it cannot manufacture a COMPLETE',
    );
  });

  test('a stage already routed back to once is not routed back to twice', async () => {
    const partialAudit = auditEnvelope({
      dod_verdicts: [fx.criterionVerdict({ criterion: 3, evidence: ['E-01'] })],
    });
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: investigation() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(partialAudit),
        withCall(rootCauseEnvelope()),
        withCall(auditEnvelope({
          envelope_id: 'env_audit_2',
          dod_verdicts: [fx.criterionVerdict({ criterion: 3, evidence: ['E-01'] })],
        })),
        withCall(rootCauseEnvelope({ envelope_id: 'env_root_cause_2' })),
      ],
    });

    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = h.store.readRunLog(result.workItemId, result.runId).records;
    const auditDispatches = log.filter(
      (e) => e.event === 'dispatch_intent' && e.stage === 'AUDIT',
    );
    assert.equal(auditDispatches.length, 2, 'one lap, not an unbounded ping-pong');
    assert.ok(notes(log, 'route back').some((d) => d.includes('a quiet retry')));
  });
});

/* =============================================== C7: gates are classified, not gating ==== */

describe('C7 — gates fire, are recorded, and gate nothing in a build that mutates nothing', () => {
  function classifierInput(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
    return {
      descriptor: null,
      paths: [],
      content: null,
      classifications: [],
      outOfScopePaths: [],
      trustClass: 'OPERATOR',
      stage: 'MERGE',
      stageMutating: true,
      intakeGateAlreadyFired: false,
      intakeSource: 'host.cli',
      selfDeclared: [],
      ...overrides,
    };
  }

  test('a read-only run records no gate that stopped it', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = h.store.readRunLog(result.workItemId, result.runId).records;
    const blocked = log.filter(
      (e): e is Extract<Event, { event: 'transition' }> => e.event === 'transition',
    ).filter((e) => e.data.to === 'BLOCKED' && e.data.trigger.includes('AUTHORIZATION'));
    assert.equal(blocked.length, 0, 'the MVP gates nothing, because nothing mutates');
  });

  test('a path outside the mandate fires SCOPE_EXPANSION from what the adapter observed', () => {
    const firings = classifyGates(policies, classifierInput({
      outOfScopePaths: ['src/audit/writer.ts'],
    }));
    assert.ok(firings.some((f) => f.gate === 'SCOPE_EXPANSION'));
    assert.equal(firings.find((f) => f.gate === 'SCOPE_EXPANSION')?.trigger, 'classifier');
  });

  test('self-declaration is an additional trigger, never the only one', () => {
    const declared = classifyGates(policies, classifierInput({
      selfDeclared: ['EXTERNAL_COMMUNICATION'],
    }));
    assert.ok(declared.some(
      (f) => f.gate === 'EXTERNAL_COMMUNICATION' && f.trigger === 'self_declaration',
    ));
    assert.match(
      declared.find((f) => f.gate === 'EXTERNAL_COMMUNICATION')?.reason ?? '',
      /does not depend on candour/,
    );
  });

  test('EXTERNAL intake entering a mutating stage fires AUTONOMOUS_INTAKE_EXECUTION once', () => {
    const first = classifyGates(policies, classifierInput({ trustClass: 'EXTERNAL' }));
    assert.ok(first.some((f) => f.gate === 'AUTONOMOUS_INTAKE_EXECUTION'));
    const second = classifyGates(policies, classifierInput({
      trustClass: 'EXTERNAL', intakeGateAlreadyFired: true,
    }));
    assert.ok(!second.some((f) => f.gate === 'AUTONOMOUS_INTAKE_EXECUTION'));
  });

  test('read-only work is ungated for every trust class', () => {
    const firings = classifyGates(policies, classifierInput({
      trustClass: 'EXTERNAL', stage: 'AUDIT', stageMutating: false,
    }));
    assert.ok(!firings.some((f) => f.gate === 'AUTONOMOUS_INTAKE_EXECUTION'));
  });

  /* --------------------------------------------------------------------- C11 ---- */

  test('a classification the probe could not establish fires the gate whatever value it carries', () => {
    /*
     * The regression, and the sharpest of the set. The absence branch fired the gate, and a
     * *present* classification with `failed_closed: true` and a non-matching value fired
     * nothing — so an adapter that failed to probe and returned its own placeholder defeated
     * the fail-closed rule entirely. The confidence decides, not the string.
     */
    const blind: Classification = {
      subject: '/repo',
      kind: 'branch_protection',
      value: 'unknown',
      confidence: 'UNKNOWN',
      failed_closed: true,
      probe_detail: 'the probe could not reach the host',
    };
    const firings = classifyGates(policies, classifierInput({ classifications: [blind] }));
    const merge = firings.find((f) => f.gate === 'MERGE_PROTECTED');
    assert.ok(merge !== undefined, 'a classifier that cannot evaluate fires the gate');
    assert.equal(
      merge.classification,
      blind,
      'and the classification is recorded, so "conservative because blind" stays '
      + 'distinguishable from "conservative because it really was production"',
    );
    assert.match(merge.reason, /could not be established/);
  });

  test('an established classification that does not match fires nothing', () => {
    const open: Classification = {
      subject: '/repo',
      kind: 'branch_protection',
      value: 'UNPROTECTED',
      confidence: 'FACT',
      failed_closed: false,
      probe_detail: 'the branch has no protection rules',
    };
    const firings = classifyGates(policies, classifierInput({ classifications: [open] }));
    assert.ok(!firings.some((f) => f.gate === 'MERGE_PROTECTED'));
  });

  test('the injected grant enforcer resolves ids to records and refuses what is not held', () => {
    /*
     * The check has to execute inside the adapter at the moment of execution, and
     * `adapters -> core` is a boundary violation, so the rule reaches the adapter as an
     * injected closure (decision I-22). `AdapterCallContext.grantsHeld` carries grant **ids**;
     * this is what turns them into records.
     */
    const grant: AuthorizationGrant = {
      grant_id: 'g_1',
      run_id: 'run_1',
      work_item_id: 'wi_1',
      gate: 'MERGE_PROTECTED',
      target: 'main',
      scope: 'single_action',
      granted_by: 'operator@example.com',
      granted_at: fx.T0,
      expires_at: '2099-01-01T00:00:00Z',
      conditions: [],
      request_ref: 'ar_1',
      evidence_reviewed: [],
      revoked_at: null,
    };
    const enforce = grantEnforcer({ grantsFor: () => [grant] });
    const base = {
      gate: 'MERGE_PROTECTED' as const,
      target: 'main',
      runId: 'run_1',
      workItemId: 'wi_1',
      now: new Date(fx.T1),
    };

    assert.equal(enforce({ ...base, grantsHeld: ['g_1'] }).ok, true);

    const notHeld = enforce({ ...base, grantsHeld: [] });
    assert.equal(
      notHeld.ok,
      false,
      'a grant recorded for the run that this dispatch was not handed is not permission this '
      + 'dispatch holds',
    );
    if (notHeld.ok) throw new Error('unreachable');
    assert.equal(notHeld.code, 'GRANT_MISSING');

    const wrongTarget = enforce({ ...base, target: 'release', grantsHeld: ['g_1'] });
    assert.equal(wrongTarget.ok, false);
    if (wrongTarget.ok) throw new Error('unreachable');
    assert.equal(wrongTarget.code, 'GRANT_MISMATCHED');
  });

  test('an established classification that matches fires, and says so plainly', () => {
    const protectedBranch: Classification = {
      subject: '/repo',
      kind: 'branch_protection',
      value: 'PROTECTED',
      confidence: 'FACT',
      failed_closed: false,
      probe_detail: 'branch protection rules are configured',
    };
    const firings = classifyGates(policies, classifierInput({
      classifications: [protectedBranch],
    }));
    const merge = firings.find((f) => f.gate === 'MERGE_PROTECTED');
    assert.ok(merge !== undefined);
    assert.equal(merge.reason, 'branch_protection is PROTECTED');
  });
});

/* ============================================== C8: a PARTIAL records its gap ==== */

describe('C8 — a PARTIAL that proceeds records the gap', () => {
  function context(required: readonly string[]): TransitionContext {
    const graph = {
      template_id: 'investigation.readonly',
      template_version: '1.0',
      entry: 'AUDIT' as const,
      stages: ['AUDIT', 'ROOT_CAUSE', 'COMPLETION'] as const,
      edges: [
        { from: 'AUDIT' as const, to: 'ROOT_CAUSE' as const, when: 'always', kind: 'advance' as const, counter: null, cap: null, blocker_kind: null },
      ],
      excluded_stages: [],
      stage_mandates: {},
      risk_class: 'READ_ONLY' as const,
      dod_profile_default: 'audit' as const,
    };
    const descriptor = policies.stages.get('AUDIT') as StageDescriptor;
    return {
      graph,
      currentStage: 'AUDIT',
      descriptor,
      budgets: policies.budgets,
      loopCounters: {},
      workItemLoopCounters: {},
      dispatchAttempt: 1,
      modelAlreadyEscalated: false,
      requiredForExit: required,
      evaluate: async (when) => ({
        predicate: when, value: 'TRUE', claim: null, inputs: [], reprobed: false, reason: '',
      }),
    };
  }

  test('the unfilled outputs travel with the transition, so the log says what was left undone', async () => {
    /*
     * `PARTIAL` is never a soft `COMPLETE`. Proceeding without recording the gap made the log
     * of a `PARTIAL` that advanced indistinguishable from the log of a `COMPLETE` — which is
     * precisely how the one becomes the other.
     */
    const envelope = fx.envelope({
      status: 'PARTIAL',
      outputs: { findings_report: 'artifacts/findings.md', orphan_inventory: null },
      unknowns: [fx.unknownRecord({ blocks: [] })],
    });
    const action = await decideAction(envelope, context([]));
    assert.equal(action.kind, 'TRANSITION');
    if (action.kind !== 'TRANSITION') throw new Error('unreachable');
    assert.deepEqual([...(action.unfilledOutputs ?? [])], ['orphan_inventory']);
  });

  test('a PARTIAL missing an output the exit condition requires does not proceed', async () => {
    const envelope = fx.envelope({
      status: 'PARTIAL',
      outputs: { findings_report: null },
      unknowns: [fx.unknownRecord({ blocks: [] })],
    });
    const action = await decideAction(envelope, context(['findings_report']));
    assert.equal(action.kind, 'REDISPATCH');
  });

  test('a PARTIAL with everything filled carries no gap', async () => {
    const envelope = fx.envelope({
      status: 'PARTIAL',
      outputs: { findings_report: 'artifacts/findings.md' },
      unknowns: [fx.unknownRecord({ blocks: [] })],
    });
    const action = await decideAction(envelope, context([]));
    assert.equal(action.kind, 'TRANSITION');
    if (action.kind !== 'TRANSITION') throw new Error('unreachable');
    assert.deepEqual([...(action.unfilledOutputs ?? [])], []);
  });
});

/* ============================================= C9: arbitration's authority ordering ==== */

describe('C9 — the external system wins on its own state, and the discrepancy is a finding', () => {
  function conflict(overrides: Partial<Conflict> = {}): Conflict {
    return {
      conflictId: 'cf_1',
      subject: 'pull request state for this work item',
      positionA: {
        source: 'agentos.event_log',
        claim: '"OPEN"',
        confidence: 'FACT',
        evidence: ['E-log'],
      },
      positionB: {
        source: 'git.github',
        claim: '"NONE"',
        confidence: 'INFERENCE',
        evidence: ['E-host'],
      },
      ...overrides,
    };
  }

  test('the AgentOS log loses to the git host on the git host\'s own subject', () => {
    /*
     * The regression. `resolveByRule` ranked only by confidence class, so a `FACT` from
     * AgentOS's own ledger beat an `INFERENCE` from the source that actually speaks for the
     * subject — the exact inversion section 5.1 exists to prevent. The ledger is authoritative
     * about what AgentOS *did* and says nothing about whether it still holds.
     */
    const resolution = resolveByRule(conflict());
    assert.equal(resolution.phase, 'RESOLVED_BY_RULE');
    if (resolution.phase !== 'RESOLVED_BY_RULE') throw new Error('unreachable');
    assert.equal(resolution.winner, 'B');
    assert.match(resolution.rule, /git\.github is authoritative/);
    assert.ok(resolution.finding !== undefined, 'the discrepancy is itself recorded as a finding');
    assert.match(
      resolution.finding,
      /says nothing about whether it still holds/,
    );
  });

  test('the PM adapter wins on the ticket\'s own status and loses on the repository', () => {
    const onTicket = resolveByRule(conflict({
      subject: 'the ticket status',
      positionA: { source: 'pm.jira', claim: '"Done"', confidence: 'INFERENCE', evidence: [] },
      positionB: { source: 'git.github', claim: '"In Progress"', confidence: 'FACT', evidence: [] },
    }));
    assert.equal(onTicket.phase, 'RESOLVED_BY_RULE');
    if (onTicket.phase !== 'RESOLVED_BY_RULE') throw new Error('unreachable');
    assert.equal(onTicket.winner, 'A');

    const onRepository = resolveByRule(conflict({
      subject: 'the merge commit on main',
      positionA: { source: 'pm.jira', claim: '"merged"', confidence: 'FACT', evidence: [] },
      positionB: { source: 'git.github', claim: '"not merged"', confidence: 'INFERENCE', evidence: [] },
    }));
    assert.equal(onRepository.phase, 'RESOLVED_BY_RULE');
    if (onRepository.phase !== 'RESOLVED_BY_RULE') throw new Error('unreachable');
    assert.equal(
      onRepository.winner,
      'B',
      'a ticket is authoritative about the ticket and at most an INFERENCE about the system',
    );
  });

  test('where no source speaks for the subject, confidence class decides as before', () => {
    const resolution = resolveByRule(conflict({
      subject: 'the preferred naming convention',
      positionA: { source: 'architect', claim: '"snake"', confidence: 'FACT', evidence: [] },
      positionB: { source: 'implementer', claim: '"camel"', confidence: 'INFERENCE', evidence: [] },
    }));
    assert.equal(resolution.phase, 'RESOLVED_BY_RULE');
    if (resolution.phase !== 'RESOLVED_BY_RULE') throw new Error('unreachable');
    assert.equal(resolution.winner, 'A');
    assert.match(resolution.rule, /FACT beats INFERENCE/);
  });

  test('two equal positions with no authority between them are delegated, never decided by recency', () => {
    const resolution = resolveByRule(conflict({
      subject: 'the preferred naming convention',
      positionA: { source: 'architect', claim: '"snake"', confidence: 'INFERENCE', evidence: [] },
      positionB: { source: 'implementer', claim: '"camel"', confidence: 'INFERENCE', evidence: [] },
    }));
    assert.equal(resolution.phase, 'DELEGATED');
    assert.match(resolution.detail, /no rule selects a winner/);
  });

  test('the authority tables map sources and subjects the way section 5.1 states', () => {
    assert.equal(sourceAuthority('agentos.event_log'), 'agentos_log');
    assert.equal(sourceAuthority('git.github'), 'repository');
    assert.equal(sourceAuthority('pm.jira'), 'intent');
    assert.equal(sourceAuthority('runtime.logs'), 'runtime');
    assert.equal(sourceAuthority('the architect'), null);
    assert.equal(subjectAuthority('pull request head sha'), 'repository');
    assert.equal(subjectAuthority('unresolved review threads'), 'reviews');
    assert.equal(subjectAuthority('the deployment in production'), 'runtime');
    assert.equal(subjectAuthority('a naming convention'), null);
  });
});

/* ======================================= C13: coverage degrades honestly, both ways ==== */

describe('C13 — coverage reconciliation with no capability registry to reconcile against', () => {
  function call(overrides: Partial<CallRecord> = {}): CallRecord {
    return {
      call_id: 'c_001',
      dispatch_id: 'd_001',
      adapter: 'repo',
      op: 'read_file',
      args_digest: '{}',
      paths_touched: ['README.md'],
      capabilities_touched: [],
      outcome: 'OK',
      refusal: null,
      aggregated_count: 1,
      started_at: fx.T1,
      duration_ms: 1,
      ...overrides,
    };
  }

  test('a capability coverage claim with no capabilities_touched anywhere is unreconciled, not a violation', () => {
    /*
     * `capabilities_touched` is required on every CallRecord and is populated by mapping paths
     * onto capability ids, which needs a capability registry — a later work package. Rejecting
     * every such envelope would turn a missing package into a contract violation by every
     * agent; accepting every such claim would leave the most consequential field in the
     * envelope as the one nobody verified.
     */
    const result = reconcile({
      envelope: fx.envelope({
        coverage: fx.coverage({ scope_examined: ['cap.namespace-restore'] }),
      }),
      mutations: [],
      calls: [call()],
    });
    assert.deepEqual([...result.unreconciledScope], ['cap.namespace-restore']);
    assert.deepEqual(result.unsupportedScope, []);
    assert.equal(result.violations.length, 0, 'not a violation');
  });

  test('once some call carries capabilities_touched, an unsupported capability claim is a violation', () => {
    const result = reconcile({
      envelope: fx.envelope({
        coverage: fx.coverage({ scope_examined: ['cap.namespace-restore'] }),
      }),
      mutations: [],
      calls: [call({ capabilities_touched: ['cap.something-else'] })],
    });
    assert.deepEqual([...result.unsupportedScope], ['cap.namespace-restore']);
    assert.deepEqual(result.unreconciledScope, []);
    assert.ok(result.violations.some((v) => v.code === 'COVERAGE_OVERSTATED'));
  });

  test('a supported capability claim passes, and is not reported as unreconciled', () => {
    const result = reconcile({
      envelope: fx.envelope({
        coverage: fx.coverage({ scope_examined: ['cap.namespace-restore'] }),
      }),
      mutations: [],
      calls: [call({ capabilities_touched: ['cap.namespace-restore'] })],
    });
    assert.deepEqual(result.unsupportedScope, []);
    assert.deepEqual(result.unreconciledScope, []);
  });

  test('a path coverage claim is reconciled on paths, registry or no registry', () => {
    const supported = reconcile({
      envelope: fx.envelope({ coverage: fx.coverage({ scope_examined: ['README.md'] }) }),
      mutations: [],
      calls: [call()],
    });
    assert.deepEqual(supported.unsupportedScope, []);

    const overstated = reconcile({
      envelope: fx.envelope({ coverage: fx.coverage({ scope_examined: ['src/**'] }) }),
      mutations: [],
      calls: [call()],
    });
    assert.deepEqual(
      [...overstated.unsupportedScope],
      ['src/**'],
      'a path claim no call touched is still a violation, and it always was',
    );
  });
});

/* ============================================ the registries rank, the kernel selects ==== */

describe('the registries rank and the kernel selects, over real scores', () => {
  const readOnlySkill = (overrides: Partial<SkillEntry> = {}): SkillEntry => ({
    id: 'repo-map',
    source: 'repository',
    description: 'maps the repository structure',
    declared_inputs: [],
    declared_outputs: [],
    availability: { adapter: 'host.skills', state: 'AVAILABLE', detail: '', checked_at: fx.T1 },
    mutating: false,
    spawns_agents: false,
    spawns_agents_determined: true,
    external_destination: false,
    reversal: null,
    domains: ['repository_analysis'],
    operations: ['read', 'analyse'],
    targets: ['filesystem'],
    observed_success_rate: 0.4,
    cost_hint: 'high',
    ...overrides,
  });

  test('the recorded selection carries real scores and reasons, not zeros', async () => {
    /*
     * The regression. The kernel built its candidate lists inline with `score: 0` and a
     * one-line reason, so the five ranking criteria the document specifies had no effect and
     * selection was really "the first candidate that passes the policy filters". The registries
     * rank; the kernel selects — and the record has to show the ranking it selected from.
     */
    const h = rig({
      models: [
        defaultModel({ id: 'cheap-shallow', reasoning: 'shallow', precision_class: 'standard', usd_per_mtok_input: 1, usd_per_mtok_output: 2 }),
        defaultModel({ id: 'deep-precise' }),
      ],
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = h.store.readRunLog(result.workItemId, result.runId).records;
    const selections = log.filter(
      (e): e is Extract<Event, { event: 'selection' }> => e.event === 'selection',
    ).filter((e) => e.data.kind === 'MODEL');

    assert.ok(selections.length > 0);
    const candidates = selections.flatMap((e) => e.data.candidates);
    assert.ok(candidates.length > 0, 'the ranked list is recorded');
    assert.ok(
      candidates.some((c) => c.score !== 0),
      'real scores, from the registry that computed them',
    );
    assert.ok(
      candidates.some((c) => c.reasons.some((r) => /meets every declared requirement|falls short/.test(r))),
      "and the registry's reasons, which name what each candidate did and did not meet",
    );
  });

  test('a read-only stage prefers a read-only skill over a mutating one that ranks higher elsewhere', async () => {
    /*
     * "A read-only option always outranks a mutating one for a read task." The mutating
     * candidate here is better on every other axis — purpose-built, cheap, perfect observed
     * success rate — and it is still not offered, because a non-mutating stage may not select
     * a mutating skill and the risk dimension is not the agent's to guess.
     */
    const h = rig({
      skills: [
        readOnlySkill({
          id: 'fast-rewriter',
          mutating: true,
          cost_hint: 'low',
          observed_success_rate: 1,
          operations: ['read', 'analyse', 'mutate'],
        }),
        readOnlySkill(),
      ],
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);

    const audit = h.substrate.dispatched.find((d) => d.stage === 'AUDIT');
    assert.ok(audit !== undefined);
    const offered = audit.skills_available.map((o) => o.id);
    assert.deepEqual(
      offered,
      ['repo-map'],
      'the mutating skill is excluded from a non-mutating stage, however well it ranks',
    );

    const log = h.store.readRunLog(result.workItemId, result.runId).records;
    const skillSelection = log.filter(
      (e): e is Extract<Event, { event: 'selection' }> => e.event === 'selection',
    ).find((e) => e.data.kind === 'SKILL' && e.stage === 'AUDIT');
    assert.ok(
      skillSelection?.data.candidates.some(
        (c) => c.id === 'fast-rewriter' && c.excluded_because !== null,
      ),
      'the exclusion is recorded rather than the candidate silently vanishing',
    );
  });

  test('the dispatch classification is derived, and a read-only stage asks for no mutation', () => {
    const descriptor = policies.stages.get('AUDIT') as StageDescriptor;
    const spec = defaultSpecs().find((s) => s.mandate_name === 'audit');
    assert.ok(spec !== undefined);
    const request = classifyDispatch(spec, descriptor);
    assert.equal(request.stageMutating, false);
    assert.ok(!request.operations.includes('mutate'));
    assert.ok(!request.operations.includes('generate'));
    assert.ok(request.domains.includes('repository_analysis'));
    assert.ok(request.targets.includes('filesystem'));
  });
});

/* ================================================== the run-level adversarial set ==== */

describe('the adversarial cases the wiring exists for', () => {
  test('a fabricated resolution proposal is not admitted on evidence that does not replay', async () => {
    /*
     * Forged evidence at the resolution step. The locator names a file the adapter cannot
     * produce, so the replay comes back UNREPLAYABLE, the evidence is withdrawn and the type
     * downgrades to UNKNOWN — which routes to the read-only investigation template, the safe
     * thing to do when you do not know what you are looking at.
     */
    const forged = resolutionEnvelope();
    const h = rig({
      script: [
        {
          kind: 'ENVELOPE',
          envelope: {
            ...forged,
            evidence: [fx.evidence({
              id: 'E-01',
              kind: 'file',
              locator: { adapter: 'repo', op: 'read_file', args: { path: 'invented.md' } },
              ref: 'invented.md',
              excerpt: 'a file that does not exist',
            })],
          },
        },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });

    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null);
    const item = h.store.getWorkItem(result.workItemId);
    assert.equal(item?.type, 'UNKNOWN');
    assert.equal(item?.claimed_type, 'TASK', 'and the claim is recorded rather than discarded');
  });

  test('a changed intake source is disclosed at COMPLETION rather than chased', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });
    const result = await new Kernel(h.ports).work(start({
      rereadIntake: async () => ({ outcome: 'OK', raw: 'Fix typo in README and rewrite the installer.' }),
    }));
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = h.store.readRunLog(result.workItemId, result.runId).records;
    const drift = log.find(
      (e): e is Extract<Event, { event: 'source_drift' }> => e.event === 'source_drift',
    );
    assert.equal(drift?.data.state, 'CHANGED');
  });

  test('the narrative states what AgentOS decided the work was, from the durable record', async () => {
    /*
     * The `WorkItem` contract has no `intent` field, so the intent lives in the work-item event
     * log. A narrative obligation nothing durable can discharge is a narrative obligation
     * nobody has.
     */
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null);
    const workItemLog = h.store.readWorkItemLog(result.workItemId).records;
    const intent = notes(workItemLog, 'intent');
    assert.equal(intent.length, 1);
    assert.match(intent[0] ?? '', /AgentOS decided this work is MODIFY_ARTIFACT/);
    assert.match(intent[0] ?? '', /never the reason anything is believed/);
  });

  test('an unauthenticated host records the absence of a principal rather than inventing one', async () => {
    const h = rig({
      host: { host: 'host.webhook', principal: null, trustClass: 'EXTERNAL' },
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = h.store.readRunLog(result.workItemId, result.runId).records;
    assert.ok(notes(log, 'principal absent').length === 1);
    const item = h.store.getWorkItem(result.workItemId);
    assert.equal(item?.origin_trust_class, 'EXTERNAL');
  });

  test('the work-item reconciliation is computed and recorded on every run', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = h.store.readRunLog(result.workItemId, result.runId).records;
    assert.equal(notes(log, 'work item reconciliation').length, 1);
    assert.ok(result.checks.some((c) => c.check === 'work_item_reconciliation'));
  });

  test('a stale reality element is re-probed before it decides anything', async () => {
    /*
     * Reality is re-probed, not snapshotted. Git and PR state expire in minutes, and a
     * predicate evaluated against a package assembled two stages ago would close the review
     * loop on a snapshot rather than on the pull request.
     */
    const h = rig({
      discovery: {
        reality: { outcome_evidence: fx.assertionOfFreshness('STALE') },
        reprobed: { outcome_evidence: fx.factAssertion(false) },
      },
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });
    await new Kernel(h.ports).work(start());
    assert.ok(
      h.discovery.reprobeCalls.includes('outcome_evidence'),
      'a STALE element is re-probed before the predicate over it is evaluated',
    );
  });

  test('an unreconciled capability coverage claim is reported, not silently accepted', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope({
          coverage: fx.coverage({ scope_examined: ['README.md', 'cap.namespace-restore'] }),
        })),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = h.store.readRunLog(result.workItemId, result.runId).records;
    const received = log.filter(
      (e): e is Extract<Event, { event: 'envelope_received' }> => e.event === 'envelope_received',
    );
    const step = received
      .flatMap((e) => e.data.steps)
      .find((c) => c.check === 'reconciliation' && c.result === 'INDETERMINATE');
    assert.ok(step !== undefined, 'the gap is visible rather than passing quietly');
    assert.match(step.detail, /unreconciled rather than accepted/);
  });

  test('the capability registry being unavailable is stated, not assumed away', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });
    const result = await new Kernel(h.ports).work(start());
    assert.ok(result.workItemId !== null && result.runId !== null);
    const log = h.store.readRunLog(result.workItemId, result.runId).records;
    assert.match(
      notes(log, 'capability registry')[0] ?? '',
      /an unreadable registry and an empty one are the same array and opposite facts/,
    );
  });
});
