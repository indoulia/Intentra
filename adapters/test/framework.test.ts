import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AdapterCallOutcome, Locator } from '@agentos/contracts';
import { validators, workItemIdempotencyKey } from '@agentos/contracts';
import {
  AdapterFramework,
  DescriptorRegistry,
  PATH_ARG,
  ResourceAbsentError,
  ResourceUnreachableError,
  STRING_ARG,
  mutatingOperation,
  readOnlyOperation,
  type OperationRegistration,
} from '../src/index.js';
import {
  BUDGETS,
  EVIDENCE,
  FakeGrantChecker,
  FakeLedger,
  FixedClock,
  MUTATION_ENABLED_EXECUTION,
  PATHS,
  READ_ONLY_EXECUTION,
  RecordingMutationSink,
  context,
  grant,
  scratch,
  type Scratch,
} from './helpers.js';

/**
 * The framework: the order of the checks, and what each of them refuses.
 *
 * Milestone 1 registers no mutating operation, so everything about mutation, grants and
 * idempotency is exercised here against a **test-only** registry built with
 * `mutationEnabled: true`. That is the arrangement the plan asks for: the machinery is built
 * and proven now, so that when the first mutating operation is registered it lands in a
 * system that already cannot perform an unlogged or unauthorized one.
 */

let space: Scratch;
let sink: RecordingMutationSink;
let ledger: FakeLedger;
let clock: FixedClock;

/* What the scripted external resource currently reports back to a re-read. */
type ResourceState = 'PRESENT' | 'ABSENT' | 'UNREACHABLE';
let resourceState: ResourceState;

beforeEach(() => {
  space = scratch();
  sink = new RecordingMutationSink();
  ledger = new FakeLedger();
  clock = new FixedClock();
  resourceState = 'PRESENT';
});

afterEach(() => {
  space.dispose();
});

/* ------------------------------------------------------------- the test operations --- */

const EXTERNAL_LOCATOR: Locator = {
  adapter: 'probe',
  op: 'read_resource',
  args: { id: 'resource-1' },
};

function readResource(): OperationRegistration {
  return readOnlyOperation({
    adapter: 'probe',
    op: 'read_resource',
    description: 'Reads one external resource. Absent and unreachable are different answers.',
    args: { id: STRING_ARG },
    required: ['id'],
    evidenceKind: 'http',
    observationSafe: true,
    handler: (invocation) => {
      const id = String(invocation.args['id']);
      if (resourceState === 'ABSENT') {
        return Promise.reject(new ResourceAbsentError(id, `${id} no longer exists`));
      }
      if (resourceState === 'UNREACHABLE') {
        return Promise.reject(new ResourceUnreachableError(id, `${id} could not be reached`));
      }
      return Promise.resolve({ value: { id, present: true }, excerpt: `${id}: present` });
    },
  });
}

function readFile(): OperationRegistration {
  return readOnlyOperation({
    adapter: 'probe',
    op: 'read_text',
    description: 'Reads a worktree file, so path confinement has something to confine.',
    args: { path: PATH_ARG },
    required: ['path'],
    evidenceKind: 'file',
    observationSafe: true,
    handler: (invocation) => {
      const confined = invocation.paths.get('path');
      return Promise.resolve({
        value: { path: confined?.relative ?? null },
        excerpt: confined?.relative ?? '',
      });
    },
  });
}

function alwaysFails(): OperationRegistration {
  return readOnlyOperation({
    adapter: 'probe',
    op: 'broken',
    description: 'An operation whose implementation throws, for the adapter-failure case.',
    evidenceKind: 'command',
    observationSafe: true,
    handler: () => Promise.reject(new Error('the underlying tool crashed: token=ghp_abcdefghijklmnopqrstuvwx')),
  });
}

/** A mutating operation. Registered only into a test-only registry. */
let executions = 0;
function createThing(): OperationRegistration {
  return mutatingOperation({
    adapter: 'probe',
    op: 'create_thing',
    description: 'Creates one external thing. Test-only: nothing like it ships in milestone 1.',
    args: { id: STRING_ARG, note: STRING_ARG },
    required: ['id'],
    evidenceKind: 'http',
    reversal: { op: 'delete_thing', args_from: { id: 'id' } },
    idempotentByKey: true,
    identityArgs: ['id'],
    externalDestination: true,
    gates: ['EXTERNAL_COMMUNICATION'],
    captureBefore: (invocation) => Promise.resolve({
      target: String(invocation.args['id']),
      before: { present: false },
    }),
    handler: (invocation) => {
      executions += 1;
      const id = String(invocation.args['id']);
      return Promise.resolve({
        value: { id, created: true },
        excerpt: `${id}: created`,
        externalLocator: { adapter: 'probe', op: 'read_resource', args: { id: 'resource-1' } },
        mutation: {
          target: id,
          before: { present: false },
          after: { present: true },
          reversalArgs: { id },
        },
      });
    },
  });
}

/* --------------------------------------------------------------------- assembly ------ */

interface BuildOptions {
  readonly mutating?: boolean;
  readonly grants?: FakeGrantChecker;
  readonly withMutationSink?: boolean;
  readonly withLedger?: boolean;
}

function build(options: BuildOptions = {}): AdapterFramework {
  const mutating = options.mutating ?? false;
  const registry = new DescriptorRegistry({
    mutationEnabled: mutating,
    scratchRoots: PATHS.scratch_roots,
  });
  registry.register(readResource());
  registry.register(readFile());
  registry.register(alwaysFails());
  if (mutating) registry.register(createThing());

  return new AdapterFramework({
    registry,
    clock,
    worktreeRoot: space.worktree,
    installationRoot: join(space.root, 'installation'),
    home: join(space.root, 'home'),
    paths: PATHS,
    evidence: EVIDENCE,
    execution: mutating ? MUTATION_ENABLED_EXECUTION : READ_ONLY_EXECUTION,
    budgets: BUDGETS,
    ...(options.grants === undefined ? {} : { grants: options.grants }),
    ...(options.withMutationSink === false ? {} : { mutations: sink }),
    ...(options.withLedger === false ? {} : { idempotency: ledger }),
  });
}

function refused(outcome: AdapterCallOutcome): Extract<AdapterCallOutcome, { outcome: 'REFUSED' }> {
  assert.equal(
    outcome.outcome, 'REFUSED',
    `expected a refusal, got ${outcome.outcome}: ${'message' in outcome ? outcome.message : ''}`,
  );
  return outcome as Extract<AdapterCallOutcome, { outcome: 'REFUSED' }>;
}

/* ---------------------------------------------------------------------- the tests ---- */

describe('operations that do not exist', () => {
  test('an unknown adapter is an error naming the descriptor rule', async () => {
    const framework = build();
    const outcome = await framework.call('nowhere', 'read_text', {}, context());
    assert.equal(outcome.outcome, 'ERROR');
    assert.match(outcome.outcome === 'ERROR' ? outcome.message : '', /not a registered adapter operation/);
  });

  test('capability confusion: an operation of one adapter invoked on another', async () => {
    const framework = build();
    space.file('src/app.ts', 'x');
    const outcome = await framework.call('git', 'read_text', { path: 'src/app.ts' }, context());
    assert.equal(
      outcome.outcome, 'ERROR',
      'read_text belongs to probe. Registering it under probe does not make it reachable '
      + 'through git, and the pair is the key',
    );
  });

  test('an unknown operation on a known adapter is an error', async () => {
    const framework = build();
    const outcome = await framework.call('probe', 'delete_everything', {}, context());
    assert.equal(outcome.outcome, 'ERROR');
  });

  test('every one of those is still logged as a call', async () => {
    const framework = build();
    await framework.call('nowhere', 'read_text', {}, context());
    await framework.call('probe', 'delete_everything', {}, context());
    assert.equal(
      framework.calls().length, 2,
      'aggregation is permitted and omission is not, and that applies to a call that failed '
      + 'before it reached an implementation',
    );
    for (const record of framework.calls()) assert.equal(record.outcome, 'ERROR');
  });
});

describe('arguments', () => {
  test('an argument the descriptor does not declare is refused', async () => {
    const framework = build();
    space.file('src/app.ts', 'x');
    const outcome = await framework.call(
      'probe', 'read_text', { path: 'src/app.ts', sudo: true }, context(),
    );
    assert.equal(outcome.outcome, 'ERROR');
    assert.match(
      outcome.outcome === 'ERROR' ? outcome.message : '',
      /arguments its descriptor does not admit/,
    );
  });

  test('a missing required argument is refused', async () => {
    const framework = build();
    const outcome = await framework.call('probe', 'read_resource', {}, context());
    assert.equal(outcome.outcome, 'ERROR');
  });
});

describe('the call log', () => {
  test('every call produces a schema-valid CallRecord', async () => {
    const framework = build();
    space.file('src/app.ts', 'x');
    const outcome = await framework.call('probe', 'read_text', { path: 'src/app.ts' }, context());
    assert.equal(outcome.outcome, 'OK');
    validators.callRecord.parse(outcome.call, 'the call record');
    assert.deepEqual(outcome.call.paths_touched, ['src/app.ts']);
    assert.deepEqual(
      outcome.call.capabilities_touched, [],
      'the capability registry is a later work package, and an empty list is honest where an '
      + 'invented capability id would not be',
    );
  });

  test('identical consecutive reads aggregate rather than being dropped', async () => {
    const framework = build();
    space.file('src/app.ts', 'x');
    for (let i = 0; i < 4; i += 1) {
      await framework.call('probe', 'read_text', { path: 'src/app.ts' }, context());
    }
    assert.equal(framework.calls().length, 1);
    assert.equal(
      framework.calls()[0]?.aggregated_count, 4,
      'four reads happened and one record says so. Aggregation is permitted; omission is not',
    );
  });

  test('aggregation stops at the policy window, so nothing is silently merged forever', async () => {
    const framework = build();
    space.file('src/app.ts', 'x');
    await framework.call('probe', 'read_text', { path: 'src/app.ts' }, context());
    clock.advance(BUDGETS.read_call_log_granularity.aggregate_identical_within_ms + 1);
    await framework.call('probe', 'read_text', { path: 'src/app.ts' }, context());
    assert.equal(framework.calls().length, 2);
  });

  test('a refusal is logged with its refusal kind', async () => {
    const framework = build();
    const outcome = await framework.call(
      'probe', 'read_text', { path: '../outside/x' }, context(),
    );
    const refusal = refused(outcome);
    assert.equal(refusal.refusal, 'security_violation');
    assert.equal(refusal.call.outcome, 'REFUSED');
    assert.equal(refusal.call.refusal, 'security_violation');
    assert.equal(
      framework.refusals().length, 1,
      'the refusal is also kept separately, because a security violation is reported '
      + "regardless of the run's outcome",
    );
    assert.equal(framework.refusals()[0]?.aborted_dispatch, true);
  });
});

describe('failures', () => {
  test('an adapter that throws produces an ERROR, not a value', async () => {
    const framework = build();
    const outcome = await framework.call('probe', 'broken', {}, context());
    assert.equal(outcome.outcome, 'ERROR');
    assert.equal(outcome.call.outcome, 'ERROR');
  });

  test("a failure's message carries no secret out of the adapter", async () => {
    const framework = build();
    const outcome = await framework.call('probe', 'broken', {}, context());
    const message = outcome.outcome === 'ERROR' ? outcome.message : '';
    assert.doesNotMatch(message, /ghp_abcdefghijklmnopqrstuvwx/);
    assert.match(message, /\[redacted:vcs_personal_token@probe\.broken\]/);
  });

  test('a partial external failure is reported, not swallowed', async () => {
    const framework = build();
    resourceState = 'UNREACHABLE';
    const outcome = await framework.call(
      'probe', 'read_resource', { id: 'resource-1' }, context(),
    );
    assert.equal(
      outcome.outcome, 'ERROR',
      'a resource that could not be reached is an error and never a value meaning absent',
    );
  });
});

describe('mutation is refused wherever it cannot be governed', () => {
  test('a mutating operation cannot be registered while mutation is disabled', () => {
    const registry = new DescriptorRegistry({
      mutationEnabled: false,
      scratchRoots: PATHS.scratch_roots,
    });
    assert.throws(
      () => registry.register(createThing()),
      /mutation_enabled: false/,
      'milestone 1 registers no mutating operation, and this is what makes that mechanical',
    );
  });

  test('a mutating operation in a non-mutating stage is refused before anything else', async () => {
    const framework = build({ mutating: true, grants: new FakeGrantChecker([grant()]) });
    executions = 0;
    const outcome = await framework.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: false,
      grantsHeld: ['grant_001'],
    }));
    assert.equal(refused(outcome).refusal, 'security_violation');
    assert.equal(executions, 0);
  });

  test('a mutating operation with no matching grant is refused grant_missing', async () => {
    const framework = build({ mutating: true, grants: new FakeGrantChecker([]) });
    executions = 0;
    const outcome = await framework.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
    }));
    assert.equal(refused(outcome).refusal, 'grant_missing');
    assert.equal(executions, 0, 'the check runs before the operation, not after it');
  });

  test('an unknown grant id establishes nothing and is refused', async () => {
    const framework = build({ mutating: true, grants: new FakeGrantChecker([grant()]) });
    const outcome = await framework.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_that_does_not_exist'],
    }));
    assert.equal(refused(outcome).refusal, 'grant_missing');
  });

  test('an expired grant is not a grant', async () => {
    const framework = build({
      mutating: true,
      grants: new FakeGrantChecker([grant({ expires_at: '2026-09-04T09:00:00.000Z' })]),
    });
    const outcome = await framework.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_001'],
    }));
    assert.equal(refused(outcome).refusal, 'grant_missing');
  });

  test('a revoked grant is not a grant', async () => {
    const framework = build({
      mutating: true,
      grants: new FakeGrantChecker([grant({ revoked_at: '2026-09-04T09:30:00.000Z' })]),
    });
    const outcome = await framework.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_001'],
    }));
    assert.equal(refused(outcome).refusal, 'grant_missing');
  });

  test('a grant for another target does not transfer', async () => {
    const framework = build({
      mutating: true,
      grants: new FakeGrantChecker([grant({ target: 'a-different-thing' })]),
    });
    const outcome = await framework.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_001'],
    }));
    assert.equal(refused(outcome).refusal, 'grant_missing');
  });

  test('a mutation that cannot be logged is refused before it happens', async () => {
    const framework = build({
      mutating: true,
      grants: new FakeGrantChecker([grant({ target: 'thing-1' })]),
    });
    sink.refuse('the run log is not writable');
    executions = 0;
    const outcome = await framework.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_001'],
    }));
    assert.equal(refused(outcome).refusal, 'security_violation');
    assert.equal(
      executions, 0,
      'an adapter that cannot emit a mutation event must refuse the mutation, and a refusal '
      + 'after the mutation is not a refusal',
    );
    assert.equal(sink.events.length, 0);
  });

  test('a framework with no mutation sink at all refuses every mutation', async () => {
    const framework = build({
      mutating: true,
      grants: new FakeGrantChecker([grant({ target: 'thing-1' })]),
      withMutationSink: false,
    });
    executions = 0;
    const outcome = await framework.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_001'],
    }));
    assert.equal(refused(outcome).refusal, 'security_violation');
    assert.equal(executions, 0);
  });

  test('a mutation outside any dispatch cannot be attributed, so it is refused', async () => {
    const framework = build({
      mutating: true,
      grants: new FakeGrantChecker([grant({ target: 'thing-1' })]),
    });
    const outcome = await framework.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_001'],
      dispatchId: null,
    }));
    assert.equal(refused(outcome).refusal, 'security_violation');
  });

  test('an emit that fails after the mutation is reported as a floor violation', async () => {
    const framework = build({
      mutating: true,
      grants: new FakeGrantChecker([grant({ target: 'thing-1' })]),
    });
    sink.failOnEmit('the log write failed');
    const outcome = await framework.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_001'],
    }));
    const refusal = refused(outcome);
    assert.equal(refusal.refusal, 'security_violation');
    assert.match(refusal.message, /could not be emitted/);
  });
});

describe('a mutation that is fully governed', () => {
  function permitted(): AdapterFramework {
    return build({
      mutating: true,
      grants: new FakeGrantChecker([grant({ target: 'thing-1' })]),
    });
  }

  test('emits a schema-valid mutation event before returning', async () => {
    const framework = permitted();
    executions = 0;
    const outcome = await framework.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_001'],
    }));
    assert.equal(outcome.outcome, 'OK');
    assert.equal(executions, 1);
    assert.equal(sink.events.length, 1);
    const event = sink.events[0];
    validators.mutationEvent.parse(event, 'the mutation event');
    assert.equal(event?.target, 'thing-1');
    assert.deepEqual(event?.reversal, { op: 'delete_thing', args: { id: 'thing-1' } });
    assert.equal(
      outcome.outcome === 'OK' ? outcome.mutations.length : 0, 1,
      'the event reaches the caller with the call it belongs to',
    );
  });

  test('records the completed key at both scopes', async () => {
    const framework = permitted();
    await framework.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_001'],
    }));
    const scopes = framework.idempotencyEvents()
      .filter((event) => event.verdict === 'RECORDED')
      .map((event) => event.scope)
      .sort();
    assert.deepEqual(scopes, ['dispatch', 'work_item']);
    assert.equal(ledger.size(), 1);
  });
});

describe('idempotency is not a cache', () => {
  function permitted(): AdapterFramework {
    return build({
      mutating: true,
      grants: new FakeGrantChecker([grant({ target: 'thing-1' })]),
    });
  }

  const mutatingContext = context({ stageMutating: true, grantsHeld: ['grant_001'] });

  test('a dispatch-scoped key hit performs no work', async () => {
    const framework = permitted();
    executions = 0;
    await framework.call('probe', 'create_thing', { id: 'thing-1' }, mutatingContext);
    const second = await framework.call('probe', 'create_thing', { id: 'thing-1' }, mutatingContext);
    assert.equal(second.outcome, 'OK');
    assert.equal(executions, 1, 'a retried dispatch does not duplicate the effect');
    assert.equal(second.call.outcome, 'DEDUPLICATED');
  });

  test('a work-item key hit whose resource is present returns the record', async () => {
    const first = permitted();
    executions = 0;
    await first.call('probe', 'create_thing', { id: 'thing-1' }, mutatingContext);
    assert.equal(executions, 1);

    /* A second run: a fresh framework, so the dispatch-scoped map is empty and only the
     * work-item ledger survives. That is the case the rule exists for. */
    resourceState = 'PRESENT';
    const second = permitted();
    const outcome = await second.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_001'],
      dispatchId: 'dsp_002',
    }));
    assert.equal(outcome.outcome, 'OK');
    assert.equal(outcome.call.outcome, 'DEDUPLICATED');
    assert.equal(executions, 1, 'no second thing was created');
    const event = second.idempotencyEvents().find((e) => e.scope === 'work_item');
    assert.equal(event?.verdict, 'DEDUPLICATED');
    assert.equal(event?.reread, 'PRESENT');
  });

  test('a stale hit — the resource is gone — invalidates the record and proceeds', async () => {
    const first = permitted();
    executions = 0;
    await first.call('probe', 'create_thing', { id: 'thing-1' }, mutatingContext);

    resourceState = 'ABSENT';
    const second = permitted();
    const outcome = await second.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_001'],
      dispatchId: 'dsp_002',
    }));
    assert.equal(outcome.outcome, 'OK');
    assert.equal(
      executions, 2,
      'the recorded effect is gone, so returning the record would report work that does not '
      + 'exist. The record is invalidated and the operation runs',
    );
    const events = second.idempotencyEvents().filter((e) => e.scope === 'work_item');
    assert.equal(events[0]?.verdict, 'IDEMPOTENCY_DIVERGENCE');
    assert.equal(events[0]?.reread, 'ABSENT');
    assert.equal(ledger.deleted.length, 1, 'the stale record was deleted through the ledger port');
  });

  test('an unreachable resource is ambiguous_state and does nothing at all', async () => {
    const first = permitted();
    executions = 0;
    await first.call('probe', 'create_thing', { id: 'thing-1' }, mutatingContext);
    const executionsAfterFirst = executions;

    resourceState = 'UNREACHABLE';
    const second = permitted();
    const outcome = await second.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_001'],
      dispatchId: 'dsp_002',
    }));
    assert.equal(refused(outcome).refusal, 'ambiguous_state');
    assert.equal(
      executions, executionsAfterFirst,
      'unreachable is neither present nor absent: nothing is returned and nothing is executed',
    );
    assert.equal(ledger.deleted.length, 0, 'and the record is not invalidated either');
    const event = second.idempotencyEvents().find((e) => e.scope === 'work_item');
    assert.equal(event?.verdict, 'AMBIGUOUS_STATE');
    assert.equal(event?.reread, 'UNREACHABLE');
  });

  test('a record with no external locator cannot be verified, so it is ambiguous', async () => {
    /*
     * The key is computed with the kernel's own function over the operation's declared
     * identity_args, so the record this plants is the record the framework will find.
     */
    const key = workItemIdempotencyKey(
      'wi_c_subject', 'probe', 'create_thing', { id: 'thing-1' }, ['id'],
    );
    ledger.put('wi_c_subject', {
      key,
      scope: 'work_item',
      adapter: 'probe',
      op: 'create_thing',
      result: { id: 'thing-1', created: true },
      external_locator: null,
      recorded_at: '2026-09-04T09:00:00.000Z',
    });

    const framework = permitted();
    executions = 0;
    const outcome = await framework.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_001'],
      dispatchId: 'dsp_003',
    }));
    assert.equal(
      refused(outcome).refusal, 'ambiguous_state',
      'a record that names no way to re-read what it recorded is a record nothing can verify, '
      + 'and an unverifiable record is trusted by exactly nobody',
    );
    assert.equal(executions, 0);
    assert.equal(ledger.deleted.length, 0);
  });

  test('a locator naming an operation that is not observation_safe cannot verify a hit', async () => {
    const framework = permitted();
    /* Reach the ledger the framework wrote, then replace its locator with one that names an
     * operation nothing may replay. A re-read that could itself mutate is not a re-read. */
    await framework.call('probe', 'create_thing', { id: 'thing-1' }, mutatingContext);
    const recordedKey = framework.idempotencyEvents()
      .find((event) => event.scope === 'work_item' && event.verdict === 'RECORDED')?.key;
    assert.ok(recordedKey !== undefined);
    const existing = ledger.get('wi_c_subject', recordedKey);
    assert.ok(existing !== null);
    ledger.put('wi_c_subject', {
      ...existing,
      external_locator: { adapter: 'probe', op: 'create_thing', args: { id: 'thing-1' } },
    });

    const second = build({
      mutating: true,
      grants: new FakeGrantChecker([grant({ target: 'thing-1' })]),
    });
    const outcome = await second.call('probe', 'create_thing', { id: 'thing-1' }, context({
      stageMutating: true,
      grantsHeld: ['grant_001'],
      dispatchId: 'dsp_004',
    }));
    assert.equal(refused(outcome).refusal, 'ambiguous_state');
  });

  test('the external locator recorded on the key is the one the operation declared', async () => {
    const framework = permitted();
    await framework.call('probe', 'create_thing', { id: 'thing-1' }, mutatingContext);
    const key = framework.idempotencyEvents()
      .find((event) => event.scope === 'work_item')?.key;
    assert.ok(key !== undefined);
    const record = ledger.get('wi_c_subject', key);
    assert.deepEqual(record?.external_locator, EXTERNAL_LOCATOR);
    validators.idempotencyRecord.parse(record, 'the idempotency record');
  });
});
