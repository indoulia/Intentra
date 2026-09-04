import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtures as fx,
  type DecompositionProposal,
  type HandoffEnvelope,
  type Scope,
  type TriageProposal,
  type WorkItem,
} from '@agentos/contracts';
import { loadPolicies } from '@agentos/policies';
import {
  childWorkItem,
  coordinateChildren,
  decomposeEnvelope,
  externalChildren,
  triageEnvelope,
  withChildLink,
} from '../src/orchestration.js';
import { readReconciliation } from '../src/work-item-reconciliation.js';

/**
 * The structural stages, and the work-item-level reconciliation.
 *
 * `REVIEW_TRIAGE`, `DECOMPOSITION` and `CHILD_COORDINATION` had rules in `proposals.ts` and no
 * caller anywhere: nothing read `envelope.proposals.triage`, nothing called
 * `admitDecomposition`, nothing called `startableChildren` or `admitCancellation`, and nothing
 * in the codebase ever set `decomposition_depth` above zero.
 *
 * **`epic.coordinate` is inadmissible in this build.** `deriveRiskClass` classes
 * `CHILD_COORDINATION` as `EXTERNAL_MUTATION` and `policies/data/execution.json` admits
 * `READ_ONLY` only, so decomposition and child coordination are unreachable end to end and are
 * exercised here at unit level with doubles. That is deliberate: milestone 1 puts parallel
 * child work items explicitly out of scope.
 */

const policies = loadPolicies();

const PARENT_SCOPE: Scope = {
  paths: ['src/namespace/**', 'tests/namespace/**'],
  capabilities: ['cap.namespace-restore'],
  repositories: ['marksy'],
};

function parent(overrides: Partial<WorkItem> = {}): WorkItem {
  return fx.workItem({
    work_item_id: 'wi_jira_DEF-456',
    type: 'DEFECT',
    scope: PARENT_SCOPE,
    ...overrides,
  });
}

function triage(overrides: Partial<TriageProposal> = {}): TriageProposal {
  return {
    thread_id: 'rt_1',
    reading: 'Add a test covering restart recovery.',
    remediation_scope: {
      paths: ['tests/namespace/restart.test.ts'], capabilities: [], repositories: ['marksy'],
    },
    separable: 'FALSE',
    proposed_route: 'COMMENT_RESOLUTION',
    ...overrides,
  };
}

function envelopeWith(proposals: HandoffEnvelope['proposals']): HandoffEnvelope {
  return fx.envelope({ proposals });
}

/* ================================================================ REVIEW_TRIAGE ==== */

describe('REVIEW_TRIAGE: the kernel decides by scope containment', () => {
  test('inside the admitted scope routes to COMMENT_RESOLUTION, always', () => {
    const outcome = triageEnvelope(envelopeWith({ triage: [triage()] }), parent());
    assert.equal(outcome.decisions[0]?.route, 'COMMENT_RESOLUTION');
    assert.equal(outcome.children.length, 0, 'no new Defect or Story is created for it');
    assert.equal(outcome.scopeExpansions.length, 0);
  });

  test('outside scope and separable becomes a child Work Item linked DISCOVERED_BY', () => {
    const outcome = triageEnvelope(envelopeWith({
      triage: [triage({
        thread_id: 'rt_3',
        reading: 'the audit-log writer has the same bug',
        remediation_scope: { paths: ['src/audit/**'], capabilities: [], repositories: ['marksy'] },
        separable: 'TRUE',
      })],
    }), parent());
    assert.equal(outcome.children.length, 1);
    assert.equal(outcome.children[0]?.route, 'CHILD_WORK_ITEM');

    const decision = outcome.children[0];
    assert.ok(decision !== undefined);
    const child = childWorkItem({
      parent: parent(),
      title: decision.reading,
      type: 'TASK',
      scope: decision.remediationScope,
      desiredOutcome: decision.reading,
      externalIdentity: null,
      dependsOn: [],
      link: 'DISCOVERED_BY',
      now: fx.T1,
      policies,
    });
    assert.equal(child.links[0]?.kind, 'DISCOVERED_BY');
    assert.equal(child.links[0]?.target, 'wi_jira_DEF-456');
  });

  test('outside scope and inseparable is SCOPE_EXPANSION, which is a human decision', () => {
    const outcome = triageEnvelope(envelopeWith({
      triage: [triage({
        remediation_scope: { paths: ['src/audit/**'], capabilities: [], repositories: ['marksy'] },
        separable: 'FALSE',
      })],
    }), parent());
    assert.equal(outcome.scopeExpansions.length, 1);
    assert.match(outcome.scopeExpansions[0]?.reason ?? '', /widens the mandate or accepts the split/);
  });

  test('the agent\'s proposed_route is recorded and ignored', () => {
    /*
     * Routing is scope containment, which is a set computation over a typed field fixed at
     * admission — not an opinion, and not the agent's.
     */
    const outcome = triageEnvelope(envelopeWith({
      triage: [triage({ proposed_route: 'CHILD_WORK_ITEM' })],
    }), parent());
    const decision = outcome.decisions[0];
    assert.equal(decision?.route, 'COMMENT_RESOLUTION');
    assert.equal(decision?.proposedRoute, 'CHILD_WORK_ITEM');
    assert.equal(decision?.overridden, true, 'the disagreement is recorded, not hidden');
  });

  test('undeterminable containment counts as inside scope, creating nothing', () => {
    const outcome = triageEnvelope(envelopeWith({
      triage: [triage({
        remediation_scope: { paths: [], capabilities: [], repositories: [] },
        separable: 'INDETERMINATE',
      })],
    }), parent());
    assert.equal(outcome.decisions[0]?.route, 'COMMENT_RESOLUTION');
    assert.match(outcome.decisions[0]?.reason ?? '', /no new Defect or Story is created/);
  });

  test('an envelope with no triage proposals decides nothing', () => {
    assert.deepEqual(triageEnvelope(fx.envelope(), parent()).decisions, []);
  });
});

/* ================================================================ DECOMPOSITION ==== */

describe('DECOMPOSITION: the Architect proposes, the kernel creates', () => {
  const epic = (): WorkItem => fx.workItem({
    work_item_id: 'wi_jira_EPIC-336',
    type: 'EPIC',
    scope: { paths: ['src/**'], capabilities: [], repositories: ['marksy'] },
    decomposition_depth: 0,
  });

  function child(overrides: Partial<DecompositionProposal> = {}): DecompositionProposal {
    return {
      title: 'detect remote changes',
      type: 'STORY',
      scope: { paths: ['src/detect/**'], capabilities: [], repositories: ['marksy'] },
      desired_outcome: 'remote changes are detected within the configured interval',
      depends_on: [],
      external_identity: null,
      ...overrides,
    };
  }

  test('an admitted child carries decomposition_depth = parent + 1 and a CHILD_OF link', () => {
    /*
     * The regression. `admission.ts` hard-coded `decomposition_depth: 0` and nothing else ever
     * set it, so the depth bound in `budgets.decomposition` bounded nothing: every child was
     * depth zero however deeply nested it actually was.
     */
    const outcome = decomposeEnvelope({
      parent: epic(),
      envelope: envelopeWith({ decomposition: [child()] }),
      policies,
      existingExternalChildren: [],
      now: fx.T1,
    });
    assert.equal(outcome.result.outcome, 'ADMITTED');
    assert.equal(outcome.created.length, 1);
    const created = outcome.created[0];
    assert.ok(created !== undefined);
    assert.equal(created.decomposition_depth, 1);
    assert.equal(created.links[0]?.kind, 'CHILD_OF');
    assert.equal(created.links[0]?.target, 'wi_jira_EPIC-336');
    assert.equal(
      created.origin_trust_class,
      epic().origin_trust_class,
      'the child inherits where the *work* came from; resetting it would launder the gate',
    );
  });

  test('a grandchild is depth two, which is what the depth bound is about', () => {
    const first = decomposeEnvelope({
      parent: epic(),
      envelope: envelopeWith({ decomposition: [child({ type: 'EPIC' })] }),
      policies,
      existingExternalChildren: [],
      now: fx.T1,
    });
    const intermediate = first.created[0];
    assert.ok(intermediate !== undefined);
    const second = decomposeEnvelope({
      parent: intermediate,
      envelope: envelopeWith({
        decomposition: [child({
          title: 'a grandchild',
          scope: { paths: ['src/detect/inner/**'], capabilities: [], repositories: ['marksy'] },
        })],
      }),
      policies,
      existingExternalChildren: [],
      now: fx.T1,
    });
    assert.equal(second.created[0]?.decomposition_depth, 2);
  });

  test('discovery before creation: an existing external child is linked, never recreated', () => {
    /*
     * This is the rule that stops a resumed Epic from duplicating its own backlog. The
     * external children are read from the project-management adapter **before any are
     * proposed**, and an admitted child whose external identity already exists is linked.
     */
    const outcome = decomposeEnvelope({
      parent: epic(),
      envelope: envelopeWith({
        decomposition: [child({ external_identity: 'jira:STORY-201' })],
      }),
      policies,
      existingExternalChildren: ['jira:STORY-201'],
      now: fx.T1,
    });
    assert.equal(outcome.created.length, 0, 'nothing is recreated');
    assert.equal(outcome.linked.length, 1);
    assert.equal(outcome.linked[0]?.external_identity, 'jira:STORY-201');
    assert.equal(
      outcome.linked[0]?.work_item_id,
      'wi_jira_STORY-201',
      'the id derives from the external identity, so it is the same item across months',
    );
  });

  test('exceeding the breadth bound is BLOCKED with the proposal retained for a human', () => {
    const many = Array.from({ length: policies.budgets.decomposition.max_children + 1 }, (_, i) =>
      child({
        title: `child ${i}`,
        scope: { paths: [`src/c${i}/**`], capabilities: [], repositories: ['marksy'] },
      }));
    const outcome = decomposeEnvelope({
      parent: epic(),
      envelope: envelopeWith({ decomposition: many }),
      policies,
      existingExternalChildren: [],
      now: fx.T1,
    });
    assert.equal(outcome.result.outcome, 'BLOCKED');
    assert.equal(
      outcome.retained.length,
      many.length,
      'not a silent truncation and not a refusal: the proposal is evidence for a human',
    );
    assert.equal(outcome.created.length, 0);
  });

  test('a child proposing a scope outside the parent\'s is refused, not admitted narrower', () => {
    const outcome = decomposeEnvelope({
      parent: epic(),
      envelope: envelopeWith({
        decomposition: [child({
          scope: { paths: ['infra/**'], capabilities: [], repositories: ['marksy'] },
        })],
      }),
      policies,
      existingExternalChildren: [],
      now: fx.T1,
    });
    assert.equal(outcome.result.outcome, 'BLOCKED');
    if (outcome.result.outcome !== 'BLOCKED') throw new Error('unreachable');
    assert.equal(outcome.result.violation.code, 'SCOPE_EXCEEDS_WORK_ITEM');
  });

  test('a dependency cycle is refused', () => {
    const outcome = decomposeEnvelope({
      parent: epic(),
      envelope: envelopeWith({
        decomposition: [
          child({ title: 'a', depends_on: ['b'], scope: { paths: ['src/a/**'], capabilities: [], repositories: ['marksy'] } }),
          child({ title: 'b', depends_on: ['a'], scope: { paths: ['src/b/**'], capabilities: [], repositories: ['marksy'] } }),
        ],
      }),
      policies,
      existingExternalChildren: [],
      now: fx.T1,
    });
    assert.equal(outcome.result.outcome, 'BLOCKED');
    if (outcome.result.outcome !== 'BLOCKED') throw new Error('unreachable');
    assert.equal(outcome.result.violation.code, 'DECOMPOSITION_CYCLE');
  });

  test('existing external children are read out of the reality set', () => {
    assert.deepEqual(
      [...externalChildren(fx.factAssertion([
        { external_identity: 'jira:STORY-201', lifecycle: 'ACHIEVED' },
        { work_item_id: 'wi_local_child' },
        'jira:TASK-204',
      ]))],
      ['jira:STORY-201', 'wi_local_child', 'jira:TASK-204'],
    );
    assert.deepEqual(
      externalChildren(fx.unknownAssertion({ reason: 'UNAVAILABLE' })),
      [],
      'an unreadable child set is not an empty one, and yields nothing to link against',
    );
  });

  test('the parent gains a PARENT_OF link, once', () => {
    const withOne = withChildLink(epic(), 'wi_child');
    assert.equal(withOne.links.filter((l) => l.kind === 'PARENT_OF').length, 1);
    assert.equal(withChildLink(withOne, 'wi_child').links.length, withOne.links.length);
  });
});

/* =========================================================== CHILD_COORDINATION ==== */

describe('CHILD_COORDINATION: a blocked child leaves its siblings running', () => {
  const children = [
    { workItemId: 'wi_201', dependsOn: [] as readonly string[], lifecycle: 'ACHIEVED' as const },
    { workItemId: 'wi_202', dependsOn: [] as readonly string[], lifecycle: 'EXECUTING' as const },
    { workItemId: 'wi_203', dependsOn: [] as readonly string[], lifecycle: 'BLOCKED' as const },
    { workItemId: 'wi_204', dependsOn: ['wi_203'], lifecycle: 'RESOLVED' as const },
  ];

  test('scenario G: the startable start, the dependent waits, the Epic does not block', () => {
    const outcome = coordinateChildren({
      parent: parent({ type: 'EPIC' }),
      envelope: fx.envelope(),
      children,
      outcomeAlreadySatisfied: 'FALSE',
    });
    assert.deepEqual([...outcome.startable], ['wi_202']);
    assert.deepEqual(
      outcome.waiting.map((w) => w.workItemId),
      ['wi_204'],
      'its dependency is not terminal, so the kernel does not start it',
    );
    assert.equal(
      outcome.epicBlocks,
      false,
      'a blocked child does not block its siblings',
    );
  });

  test('the Epic blocks only when no child can progress', () => {
    const outcome = coordinateChildren({
      parent: parent({ type: 'EPIC' }),
      envelope: fx.envelope(),
      children: [
        { workItemId: 'wi_1', dependsOn: [], lifecycle: 'BLOCKED' },
        { workItemId: 'wi_2', dependsOn: ['wi_1'], lifecycle: 'RESOLVED' },
      ],
      outcomeAlreadySatisfied: 'FALSE',
    });
    assert.equal(outcome.epicBlocks, true);
    assert.match(outcome.detail, /no child can progress/);
  });

  test('a cancellation is admitted only on adapter evidence that the outcome already holds', () => {
    const admitted = coordinateChildren({
      parent: parent({ type: 'EPIC' }),
      envelope: envelopeWith({
        cancellation: {
          work_item_id: 'wi_202',
          to: 'SUPERSEDED',
          evidence: ['E-1'],
          rationale: 'another item achieved the outcome',
        },
      }),
      children,
      outcomeAlreadySatisfied: 'TRUE',
    });
    assert.equal(admitted.cancellation?.outcome, 'ADMITTED');
  });

  test('a cancellation without that evidence escalates to a human', () => {
    for (const value of ['FALSE', 'INDETERMINATE'] as const) {
      const escalated = coordinateChildren({
        parent: parent({ type: 'EPIC' }),
        envelope: envelopeWith({
          cancellation: {
            work_item_id: 'wi_202',
            to: 'ABANDONED',
            evidence: [],
            rationale: 'this turned out to be unnecessary',
          },
        }),
        children,
        outcomeAlreadySatisfied: value,
      });
      assert.equal(escalated.cancellation?.outcome, 'ESCALATED');
      assert.match(
        escalated.cancellation?.reason ?? '',
        /should not be self-certified/,
        '"this turned out to be unnecessary" is exactly the claim that must not self-certify',
      );
    }
  });

  test('no cancellation proposal is not a cancellation', () => {
    const outcome = coordinateChildren({
      parent: parent({ type: 'EPIC' }),
      envelope: fx.envelope(),
      children,
      outcomeAlreadySatisfied: 'TRUE',
    });
    assert.equal(outcome.cancellation, null);
  });
});

/* ======================================== the work-item three-way reconciliation ==== */

describe('the reconciliation matrix is read, never recomputed', () => {
  /*
   * `current_reality` is written only by probes, so `discovery/` computes the eight-state
   * matrix at capability level and at work-item level and the kernel reads what it wrote. Two
   * implementations of one rule is one implementation too many. What the kernel owes at this
   * boundary is a careful *reading* — because a consumer that reads absence as an answer
   * destroys the matrix just as thoroughly as computing it twice would.
   */

  test('every state the contract defines is read back as itself', () => {
    for (const state of [
      'ALIGNED', 'INTENT_ONLY', 'CODE_ONLY', 'CODE_NO_RUNTIME', 'RUNTIME_NO_CODE',
      'CLAIMED_DONE_UNPROVEN', 'CONFLICTING', 'INDETERMINATE',
    ] as const) {
      const reading = readReconciliation(fx.realityWithReconciliation(state));
      assert.equal(reading.state, state);
      assert.equal(reading.available, true);
      assert.ok(reading.detail.length > 0, `${state} says what it means for the run`);
    }
  });

  test('CLAIMED_DONE_UNPROVEN reads as a finding to establish or refute, not as done', () => {
    const reading = readReconciliation(
      fx.realityWithReconciliation('CLAIMED_DONE_UNPROVEN'),
    );
    assert.match(reading.detail, /at most an INFERENCE about the system/);
    assert.match(reading.detail, /rather than treating it as already done/);
  });

  test('an absent reality is INDETERMINATE, and never a negative answer', () => {
    /*
     * An unreachable project-management system does not mean nobody intends the work, and an
     * unreachable git host does not mean there is no pull request.
     */
    const reading = readReconciliation(null);
    assert.equal(reading.state, 'INDETERMINATE');
    assert.equal(reading.available, false);
    assert.match(reading.detail, /never a negative answer/);
  });

  test('a value outside the vocabulary fails closed rather than being trusted', () => {
    const corrupt = {
      ...fx.currentReality(),
      reconciliation: 'PROBABLY_FINE',
    } as unknown as Parameters<typeof readReconciliation>[0];
    const reading = readReconciliation(corrupt);
    assert.equal(reading.state, 'INDETERMINATE');
    assert.equal(reading.available, false);
    assert.match(reading.detail, /will not guess at it/);
  });

  test('a missing field is INDETERMINATE, not ALIGNED by omission', () => {
    const { reconciliation: _dropped, ...withoutField } = fx.currentReality();
    const reading = readReconciliation(
      withoutField as unknown as Parameters<typeof readReconciliation>[0],
    );
    assert.equal(reading.state, 'INDETERMINATE');
    assert.equal(reading.available, false);
  });
});
