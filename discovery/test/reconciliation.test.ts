import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx } from '@agentos/contracts';
import type { Assertion, CapabilityRecord, ReconciliationState } from '@agentos/contracts';
import {
  buildCapabilityMatrix,
  INTENT_KEYS,
  ProbeSession,
  reconcileWorkItem,
  type SectionAssertions,
} from '../src/index.js';
import { FakeAdapters, callContext, TestClock, WINDOWS } from './fake-registry.js';
import { serviceOver } from './helpers.js';
import {
  HEAD_SHA,
  healthyWorld,
  misleadingWorkItem,
  withAvailability,
  withResponses,
  TICKET,
} from './worlds.js';

/**
 * The reconciliation matrix, all eight states, at both levels.
 *
 * The state that matters most is `INDETERMINATE`, and the test that matters most is the one
 * where a source is missing: an unreachable runtime must never resolve to "it does not work",
 * because the optimistic and the pessimistic readings are both fabrications when nobody looked.
 *
 * The second thing under test is the authority rule. Each source is authoritative about its own
 * subject and nothing else, and where two disagree the rule selects the value **and the
 * disagreement is still recorded**. A reconciliation that took git's answer and moved on would
 * throw away the only sign that AgentOS believes something the world does not.
 */

function session(): ProbeSession {
  return new ProbeSession({
    registry: new FakeAdapters(healthyWorld()),
    context: callContext(),
    clock: new TestClock(),
    windows: WINDOWS,
  });
}

function known(value: unknown): Assertion {
  return fx.factAssertion(value, { probe: 'test' });
}

function absent(): Assertion {
  return fx.unknownAssertion({ probe: 'test', reason: 'UNAVAILABLE' });
}

function reality(overrides: Readonly<Record<string, Assertion>> = {}): Readonly<Record<string, Assertion>> {
  return {
    implementation_present: known(false),
    tests_present: known(false),
    pr: known({ exists: false }),
    ci: known({ result: 'NONE' }),
    reviews: known({ review_count: 0, approved: false, unresolved_threads: 0 }),
    merge_state: known({ state: 'NOT_PROPOSED' }),
    deployment: known({ environments: [] }),
    outcome_evidence: known(false),
    children: known([]),
    agentos_history: known([]),
    ...overrides,
  };
}

function intent(overrides: SectionAssertions = {}): SectionAssertions {
  return {
    work_item_ticket: known({ key: TICKET, status: 'In Progress' }),
    claims_completion: known(false),
    ...overrides,
  };
}

describe('the work-item reconciliation reaches every state it needs to', () => {
  const cases: ReadonlyArray<readonly [ReconciliationState, string, () => ReturnType<typeof reconcileWorkItem>]> = [
    ['ALIGNED', 'intent, code and runtime all account for the work', () => reconcileWorkItem({
      reality: reality({
        implementation_present: known(true),
        pr: known({ state: 'MERGED' }),
        merge_state: known({ state: 'MERGED' }),
        outcome_evidence: known(true),
        deployment: known({ environments: [{ name: 'production' }] }),
      }),
      intent: intent({ claims_completion: known(true) }),
      workItem: null,
    })],
    ['INTENT_ONLY', 'a ticket exists and nothing is built', () => reconcileWorkItem({
      reality: reality(),
      intent: intent(),
      workItem: null,
    })],
    ['CODE_ONLY', 'a change exists with no stated intent', () => reconcileWorkItem({
      reality: reality({ implementation_present: known(true), outcome_evidence: known(true) }),
      intent: { work_item_ticket: known([]), claims_completion: known(false) },
      workItem: null,
    })],
    ['CODE_NO_RUNTIME', 'built, never observed to run', () => reconcileWorkItem({
      reality: reality({ implementation_present: known(true) }),
      intent: intent(),
      workItem: null,
    })],
    ['RUNTIME_NO_CODE', 'it happens and it is not in this repository', () => reconcileWorkItem({
      reality: reality({ outcome_evidence: known(true) }),
      intent: intent(),
      workItem: null,
    })],
    ['CLAIMED_DONE_UNPROVEN', 'the ticket says done and nothing is merged', () => reconcileWorkItem({
      reality: reality({ implementation_present: known(true) }),
      intent: intent({ claims_completion: known(true) }),
      workItem: null,
    })],
    ['CONFLICTING', 'AgentOS logged a pull request git does not have', () => reconcileWorkItem({
      reality: reality({
        agentos_history: known([{ run_id: 'r1', stages_completed: ['PR_PREPARATION'] }]),
      }),
      intent: intent(),
      workItem: null,
    })],
    ['INDETERMINATE', 'the runtime axis could not be read', () => reconcileWorkItem({
      reality: reality({ outcome_evidence: absent(), deployment: absent() }),
      intent: intent(),
      workItem: null,
    })],
  ];

  for (const [expected, why, build] of cases) {
    test(`${expected}: ${why}`, () => {
      const result = build();
      assert.equal(result.state, expected, result.rationale);
      assert.ok(result.rationale.length > 0);
    });
  }

  test('all eight states are covered by this table', () => {
    const covered = new Set(cases.map(([state]) => state));
    assert.equal(covered.size, 8);
  });
});

describe('a disagreement is recorded even when a rule resolves it', () => {
  test('git wins on pull request existence, and the discrepancy is still a finding', () => {
    const result = reconcileWorkItem({
      reality: reality({
        agentos_history: known([{ run_id: 'r1', stages_completed: ['PR_PREPARATION'] }]),
      }),
      intent: intent(),
      workItem: null,
    });

    assert.equal(result.state, 'CONFLICTING');
    const conflict = result.conflicts.find((c) => c.subject === 'current_reality.pr');
    assert.ok(conflict !== undefined);
    assert.equal(conflict.resolution, 'AUTHORITY_RULE');
    assert.equal(conflict.winner, 'git');
    assert.equal(conflict.candidates.length, 2);
    assert.match(conflict.detail, /believes it opened a pull request that does not exist/);
    for (const candidate of conflict.candidates) {
      assert.ok(candidate.authority.length > 0, 'each candidate names what it is authoritative about');
    }
  });

  test('the ticket claiming completion with nothing merged is recorded as a conflict too', () => {
    const result = reconcileWorkItem({
      reality: reality({ implementation_present: known(true) }),
      intent: intent({ claims_completion: known(true) }),
      workItem: null,
    });
    assert.equal(result.state, 'CLAIMED_DONE_UNPROVEN');
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0]?.winner, 'git');
  });

  test('an unreachable git host is INDETERMINATE, and is never read as "there is no PR"', () => {
    const result = reconcileWorkItem({
      reality: reality({ pr: absent(), implementation_present: absent(), merge_state: absent() }),
      intent: intent(),
      workItem: null,
    });
    assert.equal(result.state, 'INDETERMINATE');
    assert.equal(result.axes.code, 'UNKNOWN');
    assert.match(result.rationale, /emphatically not an empty one/);
  });

  test('conflicts reach the package, carried with their provenance', async () => {
    const { service } = serviceOver(withResponses(healthyWorld(), {
      'git.list_prs': [],
      'host.read_run_history': [
        { run_id: 'run_prior', outcome: 'BLOCKED', stages_completed: ['PR_PREPARATION'] },
      ],
    }));
    await service.orient({ runId: 'r', intake: fx.intakeRecord(), repositoryPath: '/work/repo' });
    const context = await service.deepen({
      runId: 'r',
      workItem: misleadingWorkItem(),
      repositoryPath: '/work/repo',
      previous: null,
    });

    assert.equal(context.current_reality.reconciliation, 'CONFLICTING');
    const recorded = context.intent['source_conflicts'];
    assert.equal(recorded?.confidence, 'INFERENCE');
    const listed = recorded?.value as ReadonlyArray<{ subject: string }>;
    assert.equal(listed.some((c) => c.subject === 'current_reality.pr'), true);
    assert.equal(service.conflicts().length >= 1, true);
  });
});

describe('the capability-level matrix', () => {
  function record(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
    return fx.capabilityRecord({ id: 'cap.pricing', ...overrides });
  }

  const sections = (over: Partial<Record<string, SectionAssertions>> = {}) => ({
    repository: {}, product: {}, architecture: {}, domain_model: {}, source_map: {},
    data_map: {}, api_map: {}, ui_map: {}, tests: {}, git_state: {}, runtime_state: {},
    production_state: {}, intent: {}, agent_capabilities: {}, model_capabilities: {},
    constraints: {}, authorization: {},
    ...over,
  }) as Parameters<typeof buildCapabilityMatrix>[0]['sections'];

  test('a capability all three sources account for is ALIGNED', () => {
    const matrix = buildCapabilityMatrix({
      sections: sections({
        intent: { claimed_capabilities: known([{ key: 'cap.pricing' }]) },
        api_map: { endpoints: known(['src/api/cap.pricing.ts']) },
        runtime_state: { services: known([{ name: 'cap.pricing' }]) },
      }),
      workItem: fx.workItem({ scope: fx.scope({ capabilities: ['cap.pricing'] }) }),
      capabilities: [],
      session: session(),
    });
    assert.equal(matrix.length, 1);
    assert.equal(matrix[0]?.state, 'ALIGNED');
  });

  test('a capability nobody could see the runtime of is INDETERMINATE, never broken', () => {
    const matrix = buildCapabilityMatrix({
      sections: sections({
        intent: { claimed_capabilities: known([{ key: 'cap.pricing' }]) },
        api_map: { endpoints: known(['src/api/cap.pricing.ts']) },
        runtime_state: { services: absent() },
      }),
      workItem: fx.workItem({ scope: fx.scope({ capabilities: ['cap.pricing'] }) }),
      capabilities: [],
      session: session(),
    });
    assert.equal(matrix[0]?.state, 'INDETERMINATE');
    assert.match(matrix[0]?.rationale ?? '', /runtime axis is unavailable/);
    assert.equal(matrix[0]?.runtime.confidence, 'UNKNOWN');
  });

  test('code with no intent is CODE_ONLY, and intent with no code is INTENT_ONLY', () => {
    const built = buildCapabilityMatrix({
      sections: sections({
        intent: { claimed_capabilities: known([]) },
        api_map: { endpoints: known(['src/api/cap.pricing.ts']) },
        runtime_state: { services: known([]) },
      }),
      workItem: fx.workItem({ scope: fx.scope({ capabilities: ['cap.pricing'] }) }),
      capabilities: [],
      session: session(),
    });
    assert.equal(built[0]?.state, 'CODE_ONLY');

    const planned = buildCapabilityMatrix({
      sections: sections({
        intent: { claimed_capabilities: known([{ key: 'cap.pricing' }]) },
        api_map: { endpoints: known([]) },
        runtime_state: { services: known([]) },
      }),
      workItem: fx.workItem({ scope: fx.scope({ capabilities: ['cap.pricing'] }) }),
      capabilities: [],
      session: session(),
    });
    assert.equal(planned[0]?.state, 'INTENT_ONLY');
  });

  test('a registry record asserted complete with no runtime evidence is CLAIMED_DONE_UNPROVEN', () => {
    const matrix = buildCapabilityMatrix({
      sections: sections({
        intent: { claimed_capabilities: known([{ key: 'cap.pricing' }]) },
        api_map: { endpoints: known(['src/api/cap.pricing.ts']) },
        runtime_state: { services: known([]) },
      }),
      workItem: null,
      capabilities: [record({ status: 'CLAIMED', sources_seen: ['INTENT'] })],
      session: session(),
    });
    assert.equal(matrix[0]?.state, 'CLAIMED_DONE_UNPROVEN');
  });

  test('each row carries all three axes as assertions, so the weak one is visible', () => {
    const matrix = buildCapabilityMatrix({
      sections: sections({
        intent: { claimed_capabilities: known([{ key: 'cap.pricing' }]) },
        api_map: { endpoints: known(['src/api/cap.pricing.ts']) },
        runtime_state: { services: known([{ name: 'cap.pricing' }]) },
      }),
      workItem: fx.workItem({ scope: fx.scope({ capabilities: ['cap.pricing'] }) }),
      capabilities: [],
      session: session(),
    });
    const row = matrix[0];
    assert.equal(row?.intent.confidence, 'INFERENCE');
    assert.equal(
      row?.code.confidence,
      'INFERENCE',
      'a structural derivation is an inference until a real record is traced through it',
    );
    assert.equal(row?.runtime.confidence, 'INFERENCE');
  });

  test('with no capability identity at all the matrix is empty rather than invented', async () => {
    const { service } = serviceOver(withAvailability(healthyWorld(), {}));
    await service.orient({ runId: 'r', intake: fx.intakeRecord(), repositoryPath: '/work/repo' });
    const context = await service.deepen({
      runId: 'r',
      workItem: misleadingWorkItem({ scope: fx.scope({ paths: ['src/pricing'], capabilities: [] }) }),
      repositoryPath: '/work/repo',
      previous: null,
    });
    assert.deepEqual(context.reconciliation, []);
  });
});

describe('an element is read the way the kernel reads it, never by truthiness', () => {
  /*
   * Two defects, the same mistake in two places: treating the presence of a key, or the
   * truthiness of a value, as an observation. A `current_reality` element is a small typed
   * record, and an absent or out-of-vocabulary field has established nothing. Reading one any
   * other way manufactures agreement or disagreement out of a shape.
   */

  const withPr = (value: unknown) => reconcileWorkItem({
    reality: reality({ pr: known(value) }),
    intent: intent(),
    workItem: null,
  });

  const absences: ReadonlyArray<readonly [string, unknown]> = [
    ['an explicit NONE state', { state: 'NONE' }],
    ['a NOT_PROPOSED state', { state: 'NOT_PROPOSED' }],
    ['a null state', { exists: false, state: null }],
    ['no state field at all', { exists: false, searched: true }],
  ];

  for (const [label, value] of absences) {
    test(`${label} is an observed absence, so the code axis stays ABSENT`, () => {
      const result = withPr(value);
      assert.equal(
        result.axes.code,
        'ABSENT',
        'an observed "nobody has proposed a change" must not read as code progress',
      );
      assert.equal(
        result.state,
        'INTENT_ONLY',
        'a ticket with nothing built is INTENT_ONLY, never CODE_NO_RUNTIME',
      );
    });
  }

  test('an open pull request is PRESENT, so the reading is not simply always ABSENT', () => {
    const result = withPr({ state: 'OPEN', number: 41 });
    assert.equal(result.axes.code, 'PRESENT');
    assert.equal(result.state, 'CODE_NO_RUNTIME');
  });

  test('a state outside the vocabulary is UNKNOWN, not a guess in either direction', () => {
    const result = reconcileWorkItem({
      reality: reality({ pr: known({ state: 42 }), implementation_present: absent() }),
      intent: intent(),
      workItem: null,
    });
    assert.equal(result.axes.code, 'UNKNOWN');
    assert.equal(result.state, 'INDETERMINATE');
  });

  test('a deployment element with no environments list has established nothing', () => {
    const result = reconcileWorkItem({
      reality: reality({
        deployment: known({ revisions_sought: ['abc'] }),
        outcome_evidence: absent(),
      }),
      intent: intent(),
      workItem: null,
    });
    assert.equal(
      result.axes.runtime,
      'UNKNOWN',
      'a missing field is not an empty one, and an empty one is not "not deployed"',
    );
    assert.equal(result.state, 'INDETERMINATE');
  });

  test('an empty environments list is an observed absence', () => {
    const result = reconcileWorkItem({
      reality: reality({ deployment: known({ environments: [] }), outcome_evidence: absent() }),
      intent: intent(),
      workItem: null,
    });
    assert.equal(result.axes.runtime, 'ABSENT');
  });

  test('a non-boolean implementation_present is UNKNOWN rather than truthy', () => {
    const result = reconcileWorkItem({
      reality: reality({
        implementation_present: known({ branch: 'feature/x' }),
        pr: known({ state: 'NONE' }),
      }),
      intent: intent(),
      workItem: null,
    });
    assert.equal(result.axes.code, 'ABSENT', 'the object is not an observation of a boolean');
  });

  test('an unread merge state never manufactures CLAIMED_DONE_UNPROVEN', () => {
    const result = reconcileWorkItem({
      reality: reality({ pr: absent(), merge_state: absent(), implementation_present: absent() }),
      intent: intent({ claims_completion: known(true) }),
      workItem: null,
    });
    assert.equal(
      result.state,
      'INDETERMINATE',
      'accusing a ticket of being unproven because git was unreachable is the same fabrication '
      + 'in the opposite direction',
    );
  });
});

describe('the ticket claim survives the whole way from the probe to the verdict', () => {
  /*
   * End to end through the real project-management probe, deliberately. The reconciler keys
   * CLAIMED_DONE_UNPROVEN on one assertion the probe writes, and a disagreement about that key
   * would not fail loudly: the verdict would quietly become INTENT_ONLY, and the most valuable
   * finding AgentOS produces would stop being computed with nobody noticing. Driving it through
   * the probe is what stops the two drifting apart.
   */
  async function verdictFor(world: Parameters<typeof serviceOver>[0]) {
    const { service } = serviceOver(world);
    await service.orient({ runId: 'r', intake: fx.intakeRecord(), repositoryPath: '/work/repo' });
    return service.deepen({
      runId: 'r',
      workItem: misleadingWorkItem(),
      repositoryPath: '/work/repo',
      previous: null,
    });
  }

  test('a ticket marked Done with nothing merged reaches CLAIMED_DONE_UNPROVEN', async () => {
    const context = await verdictFor(withResponses(healthyWorld(), {
      'pm.read_issue': { key: TICKET, status: 'Done', title: 'Rate rounding is wrong' },
    }));

    assert.equal(context.intent['claims_completion']?.value, true, 'the probe wrote the claim');
    assert.equal(
      context.current_reality.reconciliation,
      'CLAIMED_DONE_UNPROVEN',
      'and the reconciler read the same key the probe wrote',
    );
  });

  test('it still fires when no pull request was ever opened', async () => {
    const context = await verdictFor(withResponses(healthyWorld(), {
      'pm.read_issue': { key: TICKET, status: 'Closed', title: 'Rate rounding is wrong' },
      'git.list_prs': [],
    }));
    assert.equal(context.current_reality.reconciliation, 'CLAIMED_DONE_UNPROVEN');
  });

  test('the same ticket in progress does not fire it', async () => {
    const context = await verdictFor(healthyWorld());
    assert.equal(context.intent['claims_completion']?.value, false);
    assert.notEqual(context.current_reality.reconciliation, 'CLAIMED_DONE_UNPROVEN');
  });

  test('a Done ticket whose change really is merged and live is ALIGNED', async () => {
    const merged = {
      number: 41,
      state: 'MERGED',
      head_branch: `feature/${TICKET}-rate-rounding`,
      head_sha: HEAD_SHA,
    };
    const context = await verdictFor(withResponses(healthyWorld(), {
      'pm.read_issue': { key: TICKET, status: 'Done', title: 'Rate rounding is wrong' },
      'git.list_prs': [merged],
      'git.read_pr': merged,
      'git.merge_state': { state: 'MERGED', mergeable: false, conflicted: false },
      'runtime.outcome_evidence': { holds: true },
    }));
    assert.equal(
      context.current_reality.reconciliation,
      'ALIGNED',
      'the claim is load-bearing in both directions, not merely never satisfied',
    );
  });

  test('every intent key the reconciler reads is a key the probe writes', async () => {
    const context = await verdictFor(healthyWorld());
    const read = [
      INTENT_KEYS.ticket,
      INTENT_KEYS.ticketStatus,
      INTENT_KEYS.claimsCompletion,
      INTENT_KEYS.issues,
    ];
    for (const key of read) {
      assert.ok(
        context.intent[key] !== undefined,
        `${key} is named in INTENT_KEYS and no probe wrote it`,
      );
    }
  });
});
