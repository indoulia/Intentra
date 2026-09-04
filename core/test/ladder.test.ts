import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtures as fx,
  type ResolutionAlternative,
  type UnknownRecord,
  type WorkflowTemplate,
} from '@agentos/contracts';
import { loadPolicies, type PolicySet } from '@agentos/policies';
import {
  climbLadder,
  commonSafePrefix,
  discriminatingQuestion,
  escalationOverride,
  type LadderDiscovery,
  type LadderReading,
  type LadderResult,
  type LadderStep,
} from '../src/ladder.js';
import type { UnderstoodVerdict } from '../src/understood.js';
import { admissibleTemplatesFor } from '../src/workflow-admission.js';
import { policiesAllowingMutation } from './doubles.js';

/**
 * The uncertainty ladder (INTENT_AND_WORK_ITEM_RESOLUTION section 7).
 *
 * Nothing implemented rungs 2 to 5, and `HumanChannel.ask` was never called from anywhere.
 * Worse, the `UNDERSTOOD` verdict gated nothing: an `INSUFFICIENT` verdict was logged and the
 * run proceeded to workflow selection regardless, which made the whole sufficiency computation
 * a report rather than a decision.
 */

const policies = loadPolicies();
const mutating = policiesAllowingMutation();

const SUFFICIENT: UnderstoodVerdict = {
  verdict: 'SUFFICIENT',
  conditions: [],
  undeterminedPredicates: [],
  checkableProfiles: ['audit'],
};
const INSUFFICIENT: UnderstoodVerdict = {
  verdict: 'INSUFFICIENT',
  conditions: [],
  undeterminedPredicates: ['reality.pr_open'],
  checkableProfiles: ['audit'],
};

function gap(overrides: Partial<UnknownRecord> = {}): UnknownRecord {
  return fx.unknownRecord({
    id: 'U-1',
    subject: 'current_reality.pr for this scope',
    reason: 'UNAVAILABLE',
    attempted: 'the git host was queried and timed out',
    recoverable_by: 're-read the pull request through the git adapter',
    blocks: ['completion'],
    ...overrides,
  });
}

interface Recorded {
  readonly steps: LadderStep[];
  readonly asked: { question: string; readings: readonly LadderReading[] }[];
  readonly probes: string[];
}

async function climb(options: {
  readonly understood?: UnderstoodVerdict;
  readonly gaps?: readonly UnknownRecord[];
  readonly alternatives?: readonly ResolutionAlternative[];
  readonly templates?: readonly WorkflowTemplate[];
  readonly confidence?: number;
  readonly answer?: string | null;
  readonly discovery?: LadderDiscovery;
  readonly loops?: { run: number; workItem: number };
  readonly type?: Parameters<typeof fx.workItemOfType>[0];
  readonly policySet?: PolicySet;
} = {}): Promise<{ readonly result: LadderResult; readonly recorded: Recorded }> {
  const recorded: Recorded = { steps: [], asked: [], probes: [] };
  const set = options.policySet ?? policies;
  const result = await climbLadder({
    workItem: fx.workItemOfType(options.type ?? 'TASK'),
    policies: set,
    understood: options.understood ?? INSUFFICIENT,
    gaps: options.gaps ?? [],
    resolutionConfidence: options.confidence ?? 0.9,
    alternatives: options.alternatives ?? [],
    admissibleTemplates: options.templates ?? admissibleTemplatesFor('TASK', set),
    discoveryLoops: options.loops ?? { run: 0, workItem: 0 },
    ports: {
      discover: async (probe) => {
        recorded.probes.push(probe.gapId);
        return options.discovery ?? { ran: true, settled: true, detail: 'the probe settled it' };
      },
      ask: async (question, readings) => {
        recorded.asked.push({ question, readings });
        return options.answer ?? null;
      },
      record: (step) => { recorded.steps.push(step); },
    },
  });
  return { result, recorded };
}

const alternative = (overrides: Partial<ResolutionAlternative> = {}): ResolutionAlternative => ({
  type: 'INVESTIGATION',
  reading: 'nothing is broken; the reporter misread the listing',
  why_rejected: 'reproduction steps are present and specific',
  would_do: 'audit and root cause, then report without changing anything',
  ...overrides,
});

/* ============================================================ rung 1: proceed ==== */

describe('rung 1 — proceed', () => {
  test('a determinate workflow decision needs no rung at all, and involves no human', async () => {
    const { result, recorded } = await climb({ understood: SUFFICIENT });
    assert.equal(result.rung, 'PROCEED');
    assert.deepEqual(recorded.asked, [], 'the overwhelmingly common case involves no human');
    assert.deepEqual(recorded.probes, []);
  });
});

/* =========================================================== rung 2: discover ==== */

describe('rung 2 — discover what the UNKNOWN says would settle it', () => {
  test('a blocking unknown naming a recovery is probed, and the probe is a recorded handling', async () => {
    const { result, recorded } = await climb({ gaps: [gap()] });
    assert.equal(result.rung, 'DISCOVER');
    assert.deepEqual(recorded.probes, ['U-1'], 'the kernel dispatches what the UNKNOWN named');
    assert.deepEqual(
      [...result.handled],
      ['U-1'],
      'a dispatched probe is a recorded handling whatever it found',
    );
    assert.equal(result.probesDispatched, 1);
  });

  test('a probe that settles nothing is still recorded, and the ladder keeps climbing', async () => {
    const { result } = await climb({
      gaps: [gap()],
      discovery: { ran: true, settled: false, detail: 'the git host is still unreachable' },
      alternatives: [alternative()],
    });
    assert.notEqual(result.rung, 'DISCOVER');
    assert.deepEqual([...result.handled], ['U-1'], '"we looked and this came back" is a handling');
  });

  test('the discovery loop budget bounds rung 2, so it cannot spin', async () => {
    /*
     * `budgets.loops.discovery` is 8 per run and 16 per work item — and the counter was
     * incremented **nowhere**, so the bound on "the kernel discovers rather than choosing"
     * bounded nothing at all.
     */
    const gaps = Array.from({ length: 12 }, (_, i) => gap({ id: `U-${i + 1}` }));
    const { result, recorded } = await climb({
      gaps,
      discovery: { ran: true, settled: false, detail: 'still unreachable' },
    });
    assert.equal(
      result.probesDispatched,
      policies.budgets.loops.discovery.per_run,
      'exactly the per-run cap, and not one more',
    );
    assert.ok(recorded.steps.some(
      (s) => s.rung === 'DISCOVER' && s.outcome === 'EXHAUSTED',
    ));
  });

  test('a run that has already spent the budget dispatches nothing', async () => {
    const { result } = await climb({
      gaps: [gap()],
      loops: { run: policies.budgets.loops.discovery.per_run, workItem: 0 },
    });
    assert.equal(result.probesDispatched, 0);
  });

  test('the per-work-item cap binds across runs, so a fresh run is not a way to re-ask', async () => {
    const { result } = await climb({
      gaps: Array.from({ length: 4 }, (_, i) => gap({ id: `U-${i + 1}` })),
      loops: { run: 0, workItem: policies.budgets.loops.discovery.per_work_item },
    });
    assert.equal(result.probesDispatched, 0);
  });

  test('confidence below the threshold is not something a probe can fix', async () => {
    /*
     * `resolution_confidence` is the agent's own number about its own work. A probe settles
     * facts about the world; it does not settle whether the resolver was sure, so the ladder
     * climbs past rung 2 for that alone.
     */
    const { result } = await climb({
      gaps: [gap()],
      confidence: 0.41,
      alternatives: [alternative()],
    });
    assert.notEqual(result.rung, 'DISCOVER');
  });
});

/* ================================================= rung 3: the common safe prefix ==== */

describe('rung 3 — proceed along the common safe prefix', () => {
  test('the intersection of the candidates\' stage sequences, truncated at the first mutation', () => {
    /*
     * Scenario I's three survivors. The documented example prefix is
     * `CONTEXT_DISCOVERY -> AUDIT`, and `CONTEXT_DISCOVERY` is a prologue stage excluded from
     * `templateStage` by construction — so no intersection of *template* stage sequences can
     * produce it. The mechanism the same paragraph states is over template stages, and this is
     * what it yields. Recorded as decision I-21.
     */
    const candidates = ['defect.standard', 'investigation.readonly', 'change_request.land']
      .map((id) => mutating.templates.get(id))
      .filter((t): t is WorkflowTemplate => t !== undefined);
    assert.equal(candidates.length, 3);

    const safe = commonSafePrefix(candidates, mutating);
    assert.ok(
      safe.prefix.length === 0 || safe.prefix.every(
        (stage) => mutating.stages.get(stage)?.mutating === false,
      ),
      'every stage in an admitted prefix is declared non-mutating',
    );
  });

  test('a single non-mutating candidate yields the whole template as the prefix', () => {
    const investigation = policies.templates.get('investigation.readonly');
    assert.ok(investigation !== undefined);
    const safe = commonSafePrefix([investigation], policies);
    assert.deepEqual([...safe.prefix], ['AUDIT', 'ROOT_CAUSE', 'COMPLETION']);
    assert.match(safe.reason, /whichever answer is right/);
  });

  test('a candidate whose first stage mutates admits no prefix at all', () => {
    const task = mutating.templates.get('task.direct');
    assert.ok(task !== undefined);
    assert.equal(task.entry, 'IMPLEMENTATION');
    const safe = commonSafePrefix([task], mutating);
    assert.deepEqual(safe.prefix, [], 'IMPLEMENTATION mutates, so nothing is shared and safe');
  });

  test('candidates that share no first stage share no prefix', () => {
    const a = mutating.templates.get('task.direct');
    const b = mutating.templates.get('defect.standard');
    assert.ok(a !== undefined && b !== undefined);
    assert.deepEqual(commonSafePrefix([a, b], mutating).prefix, []);
  });

  test('rung 3 is taken before rung 4, and asks nobody', async () => {
    const { result, recorded } = await climb({
      confidence: 0.41,
      alternatives: [alternative()],
    });
    assert.equal(result.rung, 'SAFE_PREFIX');
    assert.deepEqual(recorded.asked, [], 'AgentOS proceeds without knowing the answer');
    if (result.rung !== 'SAFE_PREFIX') throw new Error('unreachable');
    assert.ok(result.prefix.length > 0);
  });
});

/* ================================================================= rung 4: ask ==== */

describe('rung 4 — one question, both readings, and what AgentOS would do under each', () => {
  test('the question is built from alternatives[].reading and .would_do', () => {
    /*
     * `alternatives[]` was never consulted anywhere, so rung 4's question could not be built —
     * and `why_rejected` alone cannot be turned into it, which is exactly why the contract
     * carries `reading` and `would_do` beside it.
     */
    const built = discriminatingQuestion(
      fx.workItemOfType('INVESTIGATION'),
      [alternative({ type: 'CHANGE_REQUEST', reading: 'the pricing rule itself should change' })],
      policies,
      ['reality.outcome_already_satisfied'],
    );
    assert.ok(built !== null);
    assert.equal(built.readings.length, 2, 'the admitted reading is one of the candidates');
    for (const reading of built.readings) {
      assert.ok(reading.would_do.length > 0, 'what AgentOS would do under each');
    }
    assert.match(built.question, /Which reading is right\?/);
    assert.match(
      built.question,
      /not a request for context AgentOS could discover/,
      'the human discriminates; they are never asked to supply context AgentOS could discover',
    );
  });

  test('a proposal with no alternatives produces no question, and the kernel invents none', () => {
    assert.equal(
      discriminatingQuestion(fx.workItemOfType('TASK'), [], policies, []),
      null,
    );
  });

  test('an answer inside the window lets the run proceed, and is recorded', async () => {
    const { result, recorded } = await climb({
      alternatives: [alternative()],
      templates: [],
      answer: 'the second reading: the rule itself should change',
    });
    assert.equal(result.rung, 'ASK');
    if (result.rung !== 'ASK') throw new Error('unreachable');
    assert.equal(result.answer, 'the second reading: the rule itself should change');
    assert.equal(recorded.asked.length, 1, 'one question, not a conversation');
  });
});

/* ============================================================== rung 5: block ==== */

describe('rung 5 — silence is never consent', () => {
  test('no answer inside the window is BLOCKED with AMBIGUOUS_GOAL', async () => {
    const { result } = await climb({
      alternatives: [alternative()],
      templates: [],
      answer: null,
    });
    assert.equal(result.rung, 'BLOCK');
    if (result.rung !== 'BLOCK') throw new Error('unreachable');
    assert.equal(result.blockerKind, 'AMBIGUOUS_GOAL');
    assert.match(result.detail, /Silence is never consent/);
    assert.ok(result.question !== null, 'the question is retained, so the run resumes in place');
  });

  test('an empty answer is not an answer', async () => {
    const { result } = await climb({
      alternatives: [alternative()],
      templates: [],
      answer: '   ',
    });
    assert.equal(result.rung, 'BLOCK');
  });

  test('no rung could settle it and nothing could be asked: BLOCKED, not proceeded', async () => {
    const { result } = await climb({ templates: [], alternatives: [] });
    assert.equal(result.rung, 'BLOCK');
    if (result.rung !== 'BLOCK') throw new Error('unreachable');
    assert.equal(result.question, null);
    assert.equal(result.blockerKind, 'AMBIGUOUS_GOAL');
  });
});

/* ================================================== the escalation override ==== */

describe('the escalation override: routine versus incident reaches a human sooner', () => {
  test('an ambiguity spanning routine and incident escalates', () => {
    const override = escalationOverride('DEFECT', [alternative({ type: 'INCIDENT' })]);
    assert.equal(override.escalate, true);
    assert.match(override.reason, /reaches a human sooner/);
  });

  test('no INCIDENT among the readings is no escalation', () => {
    assert.equal(escalationOverride('DEFECT', [alternative()]).escalate, false);
  });

  test('every reading being an INCIDENT is not an ambiguity between routine and incident', () => {
    assert.equal(
      escalationOverride('INCIDENT', [alternative({ type: 'INCIDENT' })]).escalate,
      false,
    );
  });

  test('the override skips the rungs that would proceed without asking, at any rung', async () => {
    /*
     * Even where understanding is sufficient and rung 1 would proceed. Those readings differ
     * in urgency and not only in workflow, and the override does not manufacture the INCIDENT
     * type — a type still has to earn its evidence minimum.
     */
    const { result, recorded } = await climb({
      understood: SUFFICIENT,
      type: 'DEFECT',
      alternatives: [alternative({ type: 'INCIDENT' })],
      answer: 'treat it as an incident',
    });
    assert.equal(result.rung, 'ASK');
    assert.equal(recorded.asked.length, 1);
    for (const rung of ['PROCEED', 'DISCOVER', 'SAFE_PREFIX'] as const) {
      assert.ok(
        recorded.steps.some((s) => s.rung === rung && s.outcome === 'SKIPPED'),
        `rung ${rung} is skipped, and the skip is recorded`,
      );
    }
  });
});

/* ================================================================ the ordering ==== */

describe('each rung is attempted before the next', () => {
  test('the recorded steps run in cost order', async () => {
    const { recorded } = await climb({
      gaps: [gap()],
      confidence: 0.41,
      alternatives: [alternative()],
      templates: [],
      answer: null,
    });
    const order = recorded.steps.map((s) => s.rung);
    const rank: Record<string, number> = {
      PROCEED: 1, DISCOVER: 2, SAFE_PREFIX: 3, ASK: 4, BLOCK: 5,
    };
    for (let i = 1; i < order.length; i += 1) {
      const previous = rank[order[i - 1] as string] ?? 0;
      const current = rank[order[i] as string] ?? 0;
      assert.ok(current >= previous, `rung ${order[i]} does not precede rung ${order[i - 1]}`);
    }
  });
});
