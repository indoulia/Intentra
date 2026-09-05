import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { validators } from '@agentos/contracts';
import type { Assertion } from '@agentos/contracts';
import {
  createAdapterSuite,
  type AdapterSuite,
  type ChildWorkItemEntry,
  type Connector,
  type RunLedgerEntry,
  type RunLedgerReader,
} from '../src/index.js';
import {
  BUDGETS,
  EVIDENCE,
  FakeConnector,
  FixedClock,
  PATHS,
  READ_ONLY_EXECUTION,
  ScriptedRunner,
  context,
  failed,
  ok,
  scratch,
  unreachableConnector,
  type Scratch,
  type ScriptedCommand,
} from './helpers.js';

/**
 * The operations the discovery layer reads Current Reality from.
 *
 * Three of them decide whether a resumed run is safe, and each fails in a way that is easy to
 * get wrong in the same direction:
 *
 * - **`host.read_run_history`** is the only input to `reality.stage_completed_previously`
 *   (amendment A-15). Code existing does not mean an analysis happened; AgentOS's own ledger
 *   is the only honest observation that it did. If this returned an empty history when it
 *   could not look, every resumed run would re-enter at `AUDIT` and redo work it had already
 *   done — so "we could not look" and "there were none" must stay different answers.
 * - **`host.read_child_work_items`** feeds `children_exist` and `children_all_terminal`. Same
 *   failure shape: an empty list is a claim, not a silence.
 * - **`runtime.outcome_evidence`** is the one thing that may not be derived from anything
 *   cheaper. An outcome inferred from a merge, a green pipeline or a deployment is exactly
 *   `CLAIMED_DONE_UNPROVEN`, which is the state the reconciliation matrix exists to name.
 */

let space: Scratch;
let clock: FixedClock;

beforeEach(() => {
  space = scratch();
  clock = new FixedClock();
  mkdirSync(join(space.root, 'installation'), { recursive: true });
  mkdirSync(join(space.root, 'home'), { recursive: true });
});

afterEach(() => {
  space.dispose();
});

function run(overrides: Partial<RunLedgerEntry> = {}): RunLedgerEntry {
  return {
    run_id: 'run_20260901T090000Z_0000aa',
    work_item_id: 'wi_c_subject',
    started_at: '2026-09-01T09:00:00.000Z',
    ended_at: '2026-09-01T11:00:00.000Z',
    outcome: 'BLOCKED',
    stages_completed: ['AUDIT', 'PLAN'],
    ...overrides,
  };
}

function child(overrides: Partial<ChildWorkItemEntry> = {}): ChildWorkItemEntry {
  return {
    work_item_id: 'wi_c_child',
    parent_work_item_id: 'wi_c_subject',
    type: 'STORY',
    lifecycle: 'EXECUTING',
    title: 'a child',
    ...overrides,
  };
}

class FakeLedgerReader implements RunLedgerReader {
  constructor(
    private readonly entries: readonly RunLedgerEntry[] = [],
    private readonly kids: readonly ChildWorkItemEntry[] = [],
    private readonly failure: string | null = null,
  ) {}

  runs(workItemId: string): readonly RunLedgerEntry[] {
    if (this.failure !== null) throw new Error(this.failure);
    return this.entries.filter((entry) => entry.work_item_id === workItemId);
  }

  children(workItemId: string): readonly ChildWorkItemEntry[] {
    if (this.failure !== null) throw new Error(this.failure);
    return this.kids.filter((entry) => entry.parent_work_item_id === workItemId);
  }
}

interface Options {
  readonly ledger?: RunLedgerReader | null;
  readonly runtime?: FakeConnector | null;
}

async function suite(options: Options = {}): Promise<AdapterSuite> {
  return createAdapterSuite({
    worktreeRoot: space.worktree,
    installationRoot: join(space.root, 'installation'),
    home: join(space.root, 'home'),
    paths: PATHS,
    evidence: EVIDENCE,
    execution: READ_ONLY_EXECUTION,
    budgets: BUDGETS,
    clock,
    runner: new ScriptedRunner({}),
    principalId: 'os-user',
    ledger: options.ledger ?? null,
    runtime: options.runtime ?? null,
  });
}

function asAssertion(value: unknown): Assertion {
  return validators.assertion.parse(value, 'an adapter output');
}

describe('host.read_run_history', () => {
  test('with no ledger wired in, the answer is UNAVAILABLE and never an empty history', async () => {
    const { framework } = await suite({ ledger: null });
    const outcome = await framework.call(
      'host', 'read_run_history', { work_item_id: 'wi_c_subject' }, context(),
    );
    assert.equal(outcome.outcome, 'OK');
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'UNKNOWN');
    assert.equal(assertion.confidence === 'UNKNOWN' ? assertion.reason : null, 'UNAVAILABLE');
    assert.equal(
      assertion.value, null,
      'an empty history would read as "no prior run", and a resumed run would re-enter at '
      + 'AUDIT and redo analysis it had already done',
    );
  });

  test('a ledger that will not answer is UNAVAILABLE, with the attempt recorded', async () => {
    const { framework } = await suite({
      ledger: new FakeLedgerReader([], [], 'the state directory is unreadable'),
    });
    const outcome = await framework.call(
      'host', 'read_run_history', { work_item_id: 'wi_c_subject' }, context(),
    );
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence === 'UNKNOWN' ? assertion.reason : null, 'UNAVAILABLE');
    assert.match(
      assertion.confidence === 'UNKNOWN' ? assertion.attempted ?? '' : '',
      /state directory is unreadable/,
    );
  });

  test('a work item with no prior run reports an empty history as a FACT', async () => {
    const { framework } = await suite({ ledger: new FakeLedgerReader([]) });
    const outcome = await framework.call(
      'host', 'read_run_history', { work_item_id: 'wi_c_subject' }, context(),
    );
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(
      assertion.confidence, 'FACT',
      'a ledger that was read and held nothing is an observation; a ledger nobody could read '
      + 'is not, and the two must not produce the same value',
    );
    assert.deepEqual(
      (assertion.value as { stages_completed: string[] }).stages_completed, [],
    );
  });

  test('the stages a prior run completed are reported, which is what resume reads', async () => {
    const { framework } = await suite({
      ledger: new FakeLedgerReader([
        run({ run_id: 'run_a', stages_completed: ['AUDIT', 'PLAN'] }),
        run({ run_id: 'run_b', stages_completed: ['PLAN', 'IMPLEMENTATION'] }),
      ]),
    });
    const outcome = await framework.call(
      'host', 'read_run_history', { work_item_id: 'wi_c_subject' }, context(),
    );
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'FACT');
    const value = assertion.value as { runs: RunLedgerEntry[]; stages_completed: string[] };
    assert.equal(value.runs.length, 2);
    assert.deepEqual(value.stages_completed, ['AUDIT', 'IMPLEMENTATION', 'PLAN']);
  });

  test('another work item\'s runs are not reported as this one\'s', async () => {
    const { framework } = await suite({
      ledger: new FakeLedgerReader([run({ work_item_id: 'wi_c_other' })]),
    });
    const outcome = await framework.call(
      'host', 'read_run_history', { work_item_id: 'wi_c_subject' }, context(),
    );
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.deepEqual((assertion.value as { runs: unknown[] }).runs, []);
  });

  test('it is observation_safe, so the kernel can replay the resume evidence', async () => {
    const { framework } = await suite({ ledger: new FakeLedgerReader([run()]) });
    assert.equal(framework.descriptor('host', 'read_run_history')?.observation_safe, true);
    const replay = await framework.replay(
      { adapter: 'host', op: 'read_run_history', args: { work_item_id: 'wi_c_subject' } },
      context(),
    );
    assert.equal(replay.outcome, 'OK');
  });
});

describe('host.read_child_work_items', () => {
  test('with no ledger, UNAVAILABLE rather than "this work item has no children"', async () => {
    const { framework } = await suite({ ledger: null });
    const outcome = await framework.call(
      'host', 'read_child_work_items', { work_item_id: 'wi_c_subject' }, context(),
    );
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence === 'UNKNOWN' ? assertion.reason : null, 'UNAVAILABLE');
  });

  test('recorded children are reported with their lifecycle states', async () => {
    const { framework } = await suite({
      ledger: new FakeLedgerReader([], [
        child({ work_item_id: 'wi_c_one', lifecycle: 'ACHIEVED' }),
        child({ work_item_id: 'wi_c_two', lifecycle: 'EXECUTING' }),
      ]),
    });
    const outcome = await framework.call(
      'host', 'read_child_work_items', { work_item_id: 'wi_c_subject' }, context(),
    );
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'FACT');
    const children = (assertion.value as { children: ChildWorkItemEntry[] }).children;
    assert.deepEqual(
      children.map((entry) => entry.lifecycle).sort(), ['ACHIEVED', 'EXECUTING'],
      'children_all_terminal is arithmetic over these, so the lifecycle has to survive',
    );
  });

  test('a work item that genuinely has none reports an empty list as a FACT', async () => {
    const { framework } = await suite({ ledger: new FakeLedgerReader([], []) });
    const outcome = await framework.call(
      'host', 'read_child_work_items', { work_item_id: 'wi_c_subject' }, context(),
    );
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'FACT');
    assert.deepEqual((assertion.value as { children: unknown[] }).children, []);
  });
});

describe('runtime.outcome_evidence', () => {
  test('with no runtime, UNAVAILABLE — and nothing cheaper is substituted', async () => {
    const { framework } = await suite({ runtime: null });
    const outcome = await framework.call(
      'runtime', 'outcome_evidence', { outcome: 'reports show a per-record source' }, context(),
    );
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'UNKNOWN');
    assert.equal(assertion.value, null);
    assert.match(
      assertion.confidence === 'UNKNOWN' ? assertion.recoverable_by : '',
      /PARTIAL and never PROVEN/,
      'no runtime access caps every capability at PARTIAL, and the assertion says so rather '
      + 'than inferring the outcome from a merge or a deployment',
    );
  });

  test('with the runtime unreachable, still UNAVAILABLE', async () => {
    const { framework } = await suite({
      runtime: unreachableConnector('cluster') as FakeConnector,
    });
    const outcome = await framework.call(
      'runtime', 'outcome_evidence', { outcome: 'x' }, context(),
    );
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence === 'UNKNOWN' ? assertion.reason : null, 'UNAVAILABLE');
  });

  test('a runtime that answers without a verdict is INSUFFICIENT_EVIDENCE, not false', async () => {
    const connector = new FakeConnector('cluster', true, (resource) => {
      if (resource === 'outcome_evidence') return { rows: 0, note: 'nothing to report' };
      return { ok: true };
    });
    const { framework } = await suite({ runtime: connector });
    const outcome = await framework.call(
      'runtime', 'outcome_evidence', { outcome: 'x' }, context(),
    );
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(
      assertion.confidence === 'UNKNOWN' ? assertion.reason : null, 'INSUFFICIENT_EVIDENCE',
      '"we asked and it would not tell us" routes to more discovery, not to a conclusion',
    );
  });

  test('a runtime that reports the outcome holds is a FACT', async () => {
    const connector = new FakeConnector('cluster', true, (resource) => {
      if (resource === 'outcome_evidence') return { holds: true, sample: 42 };
      return { ok: true };
    });
    const { framework } = await suite({ runtime: connector });
    const outcome = await framework.call(
      'runtime', 'outcome_evidence', { outcome: 'x' }, context(),
    );
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'FACT');
    assert.equal((assertion.value as { holds: boolean }).holds, true);
  });

  test('a runtime that reports the outcome does not hold is equally a FACT', async () => {
    const connector = new FakeConnector('cluster', true, (resource) => {
      if (resource === 'outcome_evidence') return { holds: false };
      return { ok: true };
    });
    const { framework } = await suite({ runtime: connector });
    const outcome = await framework.call(
      'runtime', 'outcome_evidence', { outcome: 'x' }, context(),
    );
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'FACT');
    assert.equal((assertion.value as { holds: boolean }).holds, false);
  });

  test('it lives on the runtime adapter and nowhere else', async () => {
    const { framework } = await suite();
    assert.notEqual(framework.descriptor('runtime', 'outcome_evidence'), undefined);
    assert.equal(
      framework.descriptor('git', 'outcome_evidence'), undefined,
      'an outcome derived from a merge is CLAIMED_DONE_UNPROVEN, so the git adapter offers no '
      + 'way to produce one',
    );
    assert.equal(framework.descriptor('repo', 'outcome_evidence'), undefined);
  });
});

describe('git.list_branches', () => {
  /*
   * Attachment steps 1 and 8, in one answer.
   *
   * The sequence identifies the branches, the default branch and the protected branches, and
   * **the last of those fails closed** (REPOSITORY_ADAPTER 2.2). A listing of bare ref names
   * satisfies the first and silently drops the other two, and a consumer reading it has no way
   * to tell "this branch is unprotected" from "nothing here said". So each record carries the
   * flag a caller gates on *and* the classification that says whether it was observed or
   * assumed — the second is what keeps a run that was conservative because it was blind
   * distinguishable from one that was conservative because the branch really was protected.
   */
  /** `git branch --all --format=%(refname)%1f%(refname:short)`, as git writes it. */
  const SEPARATOR = String.fromCharCode(31);
  const BRANCHES = [
    ['refs/heads/main', 'main'],
    ['refs/heads/feature/x', 'feature/x'],
    /* The remote's HEAD. Its short form is `origin`, which is no branch at all. */
    ['refs/remotes/origin/HEAD', 'origin'],
    ['refs/remotes/origin/main', 'origin/main'],
  ].map((pair) => pair.join(SEPARATOR)).join('\n');

  function gitScript(): Readonly<Record<string, ScriptedCommand>> {
    return {
      git: (args) => {
        if (args[0] === 'branch') return ok(`${BRANCHES}\n`);
        if (args[0] === 'symbolic-ref') return ok('origin/main\n');
        return ok('');
      },
    };
  }

  async function branchSuite(host: Connector | null): Promise<AdapterSuite> {
    return createAdapterSuite({
      worktreeRoot: space.worktree,
      installationRoot: join(space.root, 'installation'),
      home: join(space.root, 'home'),
      paths: PATHS,
      evidence: EVIDENCE,
      execution: READ_ONLY_EXECUTION,
      budgets: BUDGETS,
      clock,
      runner: new ScriptedRunner(gitScript()),
      vcsHost: host,
    });
  }

  async function listed(host: Connector | null): Promise<ReadonlyArray<Record<string, unknown>>> {
    const { framework } = await branchSuite(host);
    const outcome = await framework.call('git', 'list_branches', {}, context());
    assert.equal(outcome.outcome, 'OK');
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'FACT');
    return (assertion.confidence === 'FACT' ? assertion.value : []) as ReadonlyArray<
      Record<string, unknown>
    >;
  }

  test('a branch is a record: its name, whether it is the default, whether it is protected', async () => {
    const branches = await listed(null);
    assert.deepEqual(
      branches.map((branch) => branch['name']),
      ['main', 'feature/x', 'origin/main'],
      "the remote's HEAD is a symbolic pointer at a branch and not a branch, and its short "
      + 'form `origin` would otherwise be listed, counted and classified as one',
    );
    assert.deepEqual(
      branches.filter((branch) => branch['default'] === true).map((branch) => branch['name']),
      ['main'],
      'exactly one, taken from the remote HEAD and preferring the local ref over its remote '
      + 'twin, so that a base branch named from this is a branch a merge can target',
    );
  });

  test('with no VCS host, every branch is protected and the record says it failed closed', async () => {
    for (const branch of await listed(null)) {
      assert.equal(
        branch['protected'], true,
        'unknown protection means protected: merging into it requires a MERGE_PROTECTED grant',
      );
      const classification = branch['protection'] as Record<string, unknown>;
      assert.equal(classification['value'], 'PROTECTED');
      assert.equal(classification['confidence'], 'UNKNOWN');
      assert.equal(
        classification['failed_closed'], true,
        'the conservative value is what gates, and this flag is what says nobody observed it. '
        + 'Without it a blind run and a genuinely protected branch read identically',
      );
    }
  });

  test('where the host answers, the classification is a FACT and did not fail closed', async () => {
    const host = new FakeConnector('vcs', true, (resource, args) => {
      if (resource !== 'branch_protection') throw new Error(`no fixture for ${resource}`);
      return { protected: args['branch'] === 'main' };
    });
    const branches = await listed(host);
    const byName = new Map(branches.map((branch) => [branch['name'], branch]));

    const main = byName.get('main') as Record<string, unknown>;
    assert.equal(main['protected'], true);
    assert.equal((main['protection'] as Record<string, unknown>)['confidence'], 'FACT');
    assert.equal((main['protection'] as Record<string, unknown>)['failed_closed'], false);

    const feature = byName.get('feature/x') as Record<string, unknown>;
    assert.equal(
      feature['protected'], false,
      'a host that positively reports a branch unprotected is an observation, and the whole '
      + 'point of recording confidence is that this case stays available',
    );
    assert.equal((feature['protection'] as Record<string, unknown>)['failed_closed'], false);
  });

  test('a host that will not answer protection fails closed rather than reporting unprotected', async () => {
    const branches = await listed(unreachableConnector('vcs'));
    for (const branch of branches) {
      assert.equal(branch['protected'], true);
      assert.equal((branch['protection'] as Record<string, unknown>)['failed_closed'], true);
    }
  });

  test('git that will not run is UNAVAILABLE, never a repository with no branches', async () => {
    const { framework } = await createAdapterSuite({
      worktreeRoot: space.worktree,
      installationRoot: join(space.root, 'installation'),
      home: join(space.root, 'home'),
      paths: PATHS,
      evidence: EVIDENCE,
      execution: READ_ONLY_EXECUTION,
      budgets: BUDGETS,
      clock,
      runner: new ScriptedRunner({}),
    });
    const outcome = await framework.call('git', 'list_branches', {}, context());
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'UNKNOWN');
    assert.equal(assertion.confidence === 'UNKNOWN' ? assertion.reason : null, 'UNAVAILABLE');
  });

  test('an unreadable remote HEAD marks no branch default rather than guessing one', async () => {
    const { framework } = await createAdapterSuite({
      worktreeRoot: space.worktree,
      installationRoot: join(space.root, 'installation'),
      home: join(space.root, 'home'),
      paths: PATHS,
      evidence: EVIDENCE,
      execution: READ_ONLY_EXECUTION,
      budgets: BUDGETS,
      clock,
      runner: new ScriptedRunner({
        git: (args) => (args[0] === 'branch' ? ok(`${BRANCHES}\n`) : failed('no such ref')),
      }),
    });
    const outcome = await framework.call('git', 'list_branches', {}, context());
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    const branches = (assertion.confidence === 'FACT' ? assertion.value : []) as ReadonlyArray<
      Record<string, unknown>
    >;
    assert.ok(branches.length > 0);
    for (const branch of branches) {
      assert.equal(
        'default' in branch, false,
        '`default: false` on every branch would be a claim nobody established. The key is '
        + 'absent, so a reader looking for the base branch finds none and says so',
      );
    }
  });
});

describe('the operations the probes name all exist', () => {
  /*
   * `discovery/src/ops.ts` declares the whole vocabulary in one table so that this coupling
   * is checkable rather than implicit. `discovery` cannot be imported here — `adapters` does
   * not depend on it, and must not — so the table is restated and the two are kept in step by
   * this test failing when they drift.
   */
  const EXPECTED: Readonly<Record<string, readonly string[]>> = {
    repo: ['identify', 'list_paths', 'read_file', 'detect_stack', 'commands'],
    git: [
      'list_branches', 'default_branch', 'remotes', 'log', 'list_worktrees', 'list_tags',
      'churn', 'list_prs', 'read_pr', 'list_reviews', 'ci_status', 'merge_state',
    ],
    pm: ['read_issue', 'search_issues', 'list_children', 'list_links', 'list_documents'],
    runtime: [
      'list_environments', 'list_services', 'health', 'deployed_version', 'query',
      'outcome_evidence',
    ],
    host: [
      'list_skills', 'list_models', 'list_tools', 'list_plugins', 'list_mcp_servers',
      'read_run_history', 'read_child_work_items',
    ],
  };

  test('every operation discovery declares is registered', async () => {
    const { framework } = await suite();
    const registered = new Set(
      framework.descriptors().map((descriptor) => `${descriptor.adapter}.${descriptor.op}`),
    );
    const missing: string[] = [];
    for (const [family, ops] of Object.entries(EXPECTED)) {
      for (const op of ops) {
        if (!registered.has(`${family}.${op}`)) missing.push(`${family}.${op}`);
      }
    }
    assert.deepEqual(
      missing, [],
      'a probe that asks for an operation no adapter offers degrades to UNKNOWN, which is a '
      + 'gap in the Context Package caused by a naming drift rather than by the world',
    );
  });

  test('and every one of them is non-mutating', async () => {
    const { framework } = await suite();
    for (const [family, ops] of Object.entries(EXPECTED)) {
      for (const op of ops) {
        assert.equal(framework.descriptor(family, op)?.mutating, false, `${family}.${op}`);
      }
    }
  });

  test('observation safety is per operation, not blanket true', async () => {
    const { framework } = await suite();
    const safe = framework.descriptors().filter((d) => d.observation_safe).length;
    const unsafe = framework.descriptors().filter((d) => !d.observation_safe);
    assert.ok(safe > 0);
    assert.deepEqual(
      unsafe.map((d) => `${d.adapter}.${d.op}`), ['runtime.read_logs'],
      'exactly the read whose re-execution advances a cursor and consumes what it measured. '
      + 'Evidence resting on it is UNVERIFIABLE, which is a different verdict from a mismatch',
    );
  });
});
