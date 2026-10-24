import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fixtures as fx,
  type AgentSubstrate,
  type Event,
  type HandoffEnvelope,
  type InputPackage,
  type SubstrateResult,
  type ToolGrant,
  type ToolInvoker,
} from '@intentra/contracts';
import { PolicyLoadError, type PolicySet } from '@intentra/policies';
import { RunStore } from '@intentra/state';
import { Kernel, type StartInput } from '../src/kernel.js';
import { buildKernel } from '../src/composition/index.js';
import { NO_SPEND, checkDispatchBudget, type DispatchSpend } from '../src/budgets.js';
import { workItemSpend } from '../src/metering.js';
import { Journal } from '../src/journal.js';
import {
  auditEnvelope,
  completionEnvelope,
  harness,
  README_CONTENT,
  resolutionEnvelope,
  rootCauseEnvelope,
  type ScriptedSubstrate,
  workflowEnvelope,
  type ScriptedResponse,
} from './doubles.js';

/**
 * One gate before every billable attempt (WP-8 Prompt 4).
 *
 * Every dispatch — resolution and each of its retries, the context mandate, the
 * Orchestrator, every stage — reserves its `max_usd` against what the run and the work item
 * have already committed, known and unknown, and is refused before any session exists when
 * the total would pass a cap. Equal to the cap is allowed; one micro-dollar over is not.
 */

const cleanup: (() => void)[] = [];
after(() => { for (const fn of cleanup) fn(); });

function rig(options: Parameters<typeof harness>[0] = {}) {
  const h = harness({ adapters: { files: [{ path: 'README.md', content: README_CONTENT }] }, ...options });
  cleanup.push(() => { h.destroy(); });
  return h;
}

function withCall(envelope: HandoffEnvelope): ScriptedResponse {
  return {
    kind: 'CALLS_THEN_ENVELOPE',
    calls: [{ tool: 'repo__read_file', args: { path: 'README.md' } }],
    envelope: () => envelope,
  };
}

function goodScript(): readonly ScriptedResponse[] {
  return [
    { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
    { kind: 'ENVELOPE', envelope: workflowEnvelope() },
    withCall(auditEnvelope()),
    withCall(rootCauseEnvelope()),
    withCall(completionEnvelope()),
  ];
}

const MALFORMED: ScriptedResponse = { kind: 'FAILED', failure: 'MALFORMED_ENVELOPE', detail: 'not JSON' };

function start(): StartInput {
  return {
    source: 'NATURAL_LANGUAGE',
    sourceLocator: { adapter: 'host.cli', op: 'read_invocation', args: { argv_index: 1 } },
    raw: 'Fix typo in README.',
    resolveIdentity: async () => ({ outcome: 'NOT_NAMED' }),
    rereadIntake: async () => ({ outcome: 'OK', raw: 'Fix typo in README.' }),
  };
}

function withRunCap(policies: PolicySet, runUsd: number): PolicySet {
  return {
    ...policies,
    budgets: { ...policies.budgets, cost: { ...policies.budgets.cost, run_usd: runUsd } },
  };
}

/** Overrides the scripted substrate's cost, call by call, and counts the sessions it started. */
class Costed implements AgentSubstrate {
  readonly name = 'costed';
  readonly started: InputPackage[] = [];

  constructor(
    private readonly inner: ScriptedSubstrate,
    private readonly usd: (number | null)[],
    private readonly onDispatch: (input: InputPackage) => void = () => undefined,
  ) {}

  conformance(grants: readonly ToolGrant[]) {
    return this.inner.conformance(grants);
  }

  async dispatch(input: InputPackage, invoker: ToolInvoker): Promise<SubstrateResult> {
    this.started.push(input);
    this.onDispatch(input);
    const result = await this.inner.dispatch(input, invoker);
    const usd = this.usd.length > 0 ? this.usd.shift() ?? null : result.cost.usd;
    return { ...result, cost: { ...result.cost, usd } };
  }
}

function intakeLog(h: ReturnType<typeof rig>): readonly Event[] {
  return h.store.readIntakeLog('in_0001').records;
}

function kinds(events: readonly Event[], kind: Event['event']): readonly Event[] {
  return events.filter((e) => e.event === kind);
}

function gateFired(events: readonly Event[]): readonly Event[] {
  return events.filter((e) => e.event === 'gate_fired' && e.data.gate === 'COST_CEILING_EXCEEDED');
}

/* ======================================================= the arithmetic ==== */

function spend(knownUsd: number, reservedUsd = 0, attempts = 0): DispatchSpend {
  return { ...NO_SPEND, knownMicros: knownUsd * 1e6, reservedMicros: reservedUsd * 1e6, attempts };
}

describe('the gate counts known spend, every reservation, and the next one', () => {
  const policies = rig().policies;
  const at = (run: DispatchSpend, workItem: DispatchSpend | null = null) => checkDispatchBudget(
    { run, workItem, runStartedAt: fx.T1 }, policies.budgets, new Date(fx.T1), 5_000_000,
  );

  test('equal to the run cap is allowed', () => {
    assert.equal(at(spend(20)).within, true);
  });

  test('one micro-dollar over the run cap is refused', () => {
    const verdict = at({ ...spend(20), knownMicros: 20_000_001 });
    assert.equal(verdict.within, false);
    assert.equal(!verdict.within && verdict.counter, 'cost.run_usd');
  });

  test('a reservation counts as spent', () => {
    const verdict = at(spend(0, 21));
    assert.equal(!verdict.within && verdict.scope, 'run');
  });

  test('the work item cap is checked with the work item\'s own spend', () => {
    const verdict = at(spend(0), spend(96));
    assert.equal(!verdict.within && verdict.scope, 'work_item');
  });

  test('an unknown cost with no reservation behind it refuses everything', () => {
    assert.equal(at({ ...NO_SPEND, unreservable: 1 }).within, false);
  });

  test('the dispatch cap counts attempts, not envelopes', () => {
    const verdict = at(spend(0, 0, policies.budgets.dispatches.per_run));
    assert.equal(!verdict.within && verdict.counter, 'dispatches');
  });
});

/* ======================================================= the four paths ==== */

describe('resolution, and every retry of it, passes the gate', () => {
  test('an over-cap resolution starts no session and blocks BUDGET_EXHAUSTED', async () => {
    const h = rig({ script: goodScript() });
    const substrate = h.ports.substrate as ScriptedSubstrate;
    const result = await new Kernel({ ...h.ports, policies: withRunCap(h.policies, 4) }).work(start());
    assert.equal(substrate.dispatched.length, 0);
    assert.equal(result.outcome, 'BLOCKED');
    assert.equal(result.blockerKind, 'BUDGET_EXHAUSTED');
    assert.equal(kinds(intakeLog(h), 'dispatch_intent').length, 0);
    assert.equal(gateFired(intakeLog(h)).length, 1);
    assert.equal(kinds(intakeLog(h), 'budget').length, 1);
  });

  test('each retry is a new attempt with its own reservation', async () => {
    const h = rig({ script: [MALFORMED, MALFORMED, MALFORMED] });
    const substrate = h.ports.substrate as ScriptedSubstrate;
    const result = await new Kernel({ ...h.ports, policies: withRunCap(h.policies, 5.05) }).work(start());
    assert.equal(substrate.dispatched.length, 2, 'the third attempt would pass the cap');
    assert.equal(result.blockerKind, 'BUDGET_EXHAUSTED');
    assert.equal(kinds(intakeLog(h), 'dispatch_intent').length, 2);
    assert.equal(gateFired(intakeLog(h)).length, 1);
  });

  test('a failed attempt\'s known cost counts against the next', async () => {
    const h = rig({ script: [MALFORMED, MALFORMED, MALFORMED] });
    const costed = new Costed(h.ports.substrate as ScriptedSubstrate, [2, 2, 2]);
    await new Kernel({ ...h.ports, substrate: costed, policies: withRunCap(h.policies, 8) }).work(start());
    assert.equal(costed.started.length, 2, '4 known + 5 reserved would pass 8');
  });

  test('a null cost keeps its reservation, so the next attempt is refused', async () => {
    const h = rig({ script: [MALFORMED, MALFORMED, MALFORMED] });
    const costed = new Costed(h.ports.substrate as ScriptedSubstrate, [null]);
    await new Kernel({ ...h.ports, substrate: costed, policies: withRunCap(h.policies, 9) }).work(start());
    assert.equal(costed.started.length, 1, '5 reserved + 5 more would pass 9');
  });

  test('an intent that cannot be written starts no session', async () => {
    const h = rig({ script: goodScript() });
    const substrate = h.ports.substrate as ScriptedSubstrate;
    class FailingStore extends RunStore {
      override appendIntakeEvent(intakeId: string, event: Event): void {
        if (event.event === 'dispatch_intent') throw new Error('disk full');
        super.appendIntakeEvent(intakeId, event);
      }
    }
    const store = new FailingStore(h.store.layout.root);
    await assert.rejects(new Kernel({ ...h.ports, store }).work(start()), /disk full/);
    assert.equal(substrate.dispatched.length, 0);
  });

  test('a re-resolution intent is durable before its session starts', async () => {
    const misclassified = fx.envelope({
      envelope_id: 'env_misclassified',
      agent: 'auditor',
      stage_in: 'ROOT_CAUSE',
      status: 'BLOCKED',
      outputs: {},
      coverage: fx.coverage({ scope_examined: ['README.md'] }),
      blockers: [fx.blocker({
        kind: 'WORK_ITEM_MISCLASSIFIED', description: 'never built', needs: 're_resolution', evidence: [],
      })],
      next_action: null,
    });
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(misclassified),
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        withCall(auditEnvelope()),
        withCall(rootCauseEnvelope()),
        withCall(completionEnvelope()),
      ],
    });
    const seen: number[] = [];
    let resolutions = 0;
    const costed = new Costed(h.ports.substrate as ScriptedSubstrate, [], (input) => {
      if (input.stage !== 'RESOLUTION') return;
      resolutions += 1;
      if (resolutions < 2) return;
      /* A resolution package names the intake; the re-resolution writes to the admitted item's log. */
      const [workItemId] = h.store.listWorkItems();
      seen.push(kinds(h.store.readWorkItemLog(workItemId ?? '').records, 'dispatch_intent').length);
    });
    const result = await new Kernel({ ...h.ports, substrate: costed }).work(start());
    assert.ok(result.workItemId !== null);
    assert.deepEqual(seen, [1], 'the re-resolution intent was on disk when the session started');
  });
});

describe('the context, Orchestrator and stage dispatches pass the same gate', () => {
  test('resolution spend counts against the run cap at CONTEXT_DISCOVERY', async () => {
    const h = rig({ script: goodScript() });
    const substrate = h.ports.substrate as ScriptedSubstrate;
    const result = await new Kernel({ ...h.ports, policies: withRunCap(h.policies, 5.04) }).work(start());
    assert.equal(substrate.dispatched.length, 1, '0.05 known + 5 reserved passes 5.04');
    assert.equal(result.blockerKind, 'BUDGET_EXHAUSTED');
    const log = h.store.readRunLog(result.workItemId ?? '', result.runId ?? '').records;
    assert.equal(gateFired(log)[0]?.stage, 'CONTEXT_DISCOVERY');
  });

  test('exactly at the cap the context dispatch runs, and the Orchestrator is refused', async () => {
    const h = rig({ script: goodScript() });
    const substrate = h.ports.substrate as ScriptedSubstrate;
    const result = await new Kernel({ ...h.ports, policies: withRunCap(h.policies, 5.05) }).work(start());
    assert.deepEqual(substrate.dispatched.map((d) => d.stage), ['RESOLUTION', 'CONTEXT_DISCOVERY']);
    assert.equal(result.outcome, 'BLOCKED');
    const log = h.store.readRunLog(result.workItemId ?? '', result.runId ?? '').records;
    const stages = gateFired(log).map((e) => e.stage);
    assert.equal(stages[0], 'WORKFLOW_SELECTED', 'the Orchestrator was refused first');
    assert.equal(stages.length, 2, 'then the first stage, which ended the run');
  });

  test('a stage dispatch past the cap is refused before its session', async () => {
    const h = rig({ script: goodScript() });
    const substrate = h.ports.substrate as ScriptedSubstrate;
    const result = await new Kernel({ ...h.ports, policies: withRunCap(h.policies, 5.14) }).work(start());
    assert.deepEqual(
      substrate.dispatched.map((d) => d.stage),
      ['RESOLUTION', 'CONTEXT_DISCOVERY', 'WORKFLOW_SELECTED'],
    );
    assert.equal(result.outcome, 'BLOCKED');
  });

  test('the kernel calls the substrate from exactly one place, the metered dispatch', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', '..', 'src', 'kernel.ts'), 'utf8');
    const calls = source.match(/substrate\.dispatch\(/g) ?? [];
    assert.equal(calls.length, 1);
    const at = source.indexOf('substrate.dispatch(');
    const owner = source.lastIndexOf('private async ', at);
    assert.match(source.slice(owner, owner + 40), /meteredDispatch/);
  });
});

/* ============================================ the pilot cap hand-off ==== */

describe('the composition the CLI uses loads a tighten-only cap from a policy folder', () => {
  function folder(content: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'intentra-caps-'));
    cleanup.push(() => { rmSync(dir, { recursive: true, force: true }); });
    writeFileSync(join(dir, 'budget-caps.json'), JSON.stringify(content));
    return dir;
  }

  function place(): { readonly stateRoot: string; readonly repositoryPath: string } {
    const root = mkdtempSync(join(tmpdir(), 'intentra-caps-build-'));
    cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
    mkdirSync(join(root, 'repo'));
    return { stateRoot: join(root, 'state'), repositoryPath: join(root, 'repo') };
  }

  test('AGENTOS_POLICY_OVERRIDES lowers the run cap the kernel enforces', async () => {
    const overrides = folder({ version: '1.0', cost: { run_usd: 8 } });
    const built = await buildKernel({ ...place(), env: { AGENTOS_POLICY_OVERRIDES: overrides } });
    assert.equal(built.policies.budgets.cost.run_usd, 8);
    assert.equal(built.ports.policies.budgets.cost.run_usd, 8);
    assert.deepEqual(built.policies.budgetCaps?.tightened.map((t) => t.field), ['cost.run_usd']);
  });

  test('an override that would raise a cap stops the build', async () => {
    const overrides = folder({ version: '1.0', cost: { run_usd: 26 } });
    await assert.rejects(
      buildKernel({ ...place(), env: { AGENTOS_POLICY_OVERRIDES: overrides } }),
      (error: unknown) => error instanceof PolicyLoadError,
    );
  });

  test('with no override named, the configured caps stand', async () => {
    const built = await buildKernel({ ...place(), env: {} });
    assert.equal(built.policies.budgetCaps, null);
    assert.equal(built.policies.budgets.cost.run_usd, 25);
  });
});

/* ===================================================== across runs ==== */

describe('a work item\'s spend is recovered from every log it has', () => {
  test('a dispatch killed mid-flight stays reserved against its work item in the next run', async () => {
    const h = rig({
      script: [
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
        { kind: 'ENVELOPE', envelope: workflowEnvelope() },
        { kind: 'ENVELOPE', envelope: resolutionEnvelope() },
      ],
    });
    let kill = true;
    const killing = new Costed(h.ports.substrate as ScriptedSubstrate, [], (input) => {
      if (kill && input.stage === 'AUDIT') throw new Error('killed mid-flight');
    });
    await assert.rejects(new Kernel({ ...h.ports, substrate: killing }).work(start()), /killed mid-flight/);
    const [workItemId] = h.store.listWorkItems();
    assert.ok(workItemId !== undefined);
    assert.equal(workItemSpend(h.store, workItemId).reservedMicros, 5_000_000);

    /* 0.20 known + 5 next fits 5.20 exactly; only the killed call's reservation makes it not fit. */
    kill = false;
    const policies = {
      ...h.policies,
      budgets: { ...h.policies.budgets, cost: { ...h.policies.budgets.cost, work_item_usd: 5.2 } },
    };
    const second = await new Kernel({ ...h.ports, substrate: killing, policies }).work(start());
    assert.equal(second.workItemId, workItemId);
    assert.equal(second.blockerKind, 'BUDGET_EXHAUSTED');
    const log = h.store.readRunLog(workItemId, second.runId ?? '').records;
    const exceeded = kinds(log, 'budget').filter((e) => e.event === 'budget' && e.data.kind === 'EXCEEDED');
    assert.equal(exceeded[0]?.event === 'budget' && exceeded[0].data.scope, 'work_item');
  });

  test('a prior run\'s interrupted dispatch stays reserved, and a replayed prologue is counted once', () => {
    const h = rig();
    const workItemId = 'wi_c_metered';
    const runId = 'run_20260904T100000Z_000001';
    h.store.putWorkItemProjection(fx.workItem({ work_item_id: workItemId }));
    h.store.createRun(workItemId, runId);

    const intake = fx.intakeRecord({ intake_id: 'in_0001' });
    const prologue: Event[] = [
      { seq: 1, at: fx.T1, work_item_id: 'in_0001', run_id: null, stage: 'INTAKE_RECEIVED', dispatch_id: null, agent: null, event: 'intake_recorded', data: intake } as Event,
      { seq: 2, at: fx.T1, work_item_id: 'in_0001', run_id: null, stage: 'RESOLUTION', dispatch_id: null, agent: null, event: 'dispatch_intent', data: { input_package: fx.inputPackage({ dispatch_id: 'd_res' }), attempt: 1 } } as Event,
      { seq: 3, at: fx.T1, work_item_id: 'in_0001', run_id: null, stage: 'RESOLUTION', dispatch_id: null, agent: null, event: 'dispatch_result', data: { outcome: 'ENVELOPE', envelope_id: 'env_r', failure_reason: null, detail: '', cost: { input_tokens: 1, output_tokens: 1, usd: 1.5 } } } as Event,
    ];
    for (const event of prologue) h.store.appendIntakeEvent('in_0001', event);

    const journal = Journal.open(h.store, h.clock, { workItemId, runId });
    for (const event of prologue) {
      journal.run(event.event as never, event.data as never, { stage: event.stage, dispatchId: null, agent: null });
    }
    journal.run('dispatch_intent', { input_package: fx.inputPackage({ dispatch_id: 'd_0001' }), attempt: 1 },
      { stage: 'AUDIT', dispatchId: 'd_0001', agent: 'auditor' });

    const spent = workItemSpend(h.store, workItemId);
    assert.equal(spent.knownMicros, 1_500_000, 'the prologue is counted once, not once per log');
    assert.equal(spent.reservedMicros, 5_000_000);
    assert.equal(spent.attempts, 2);
  });
});
