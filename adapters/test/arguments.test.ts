import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Assertion } from '@agentos/contracts';
import { validators } from '@agentos/contracts';
import { createAdapterSuite, type AdapterSuite } from '../src/index.js';
import {
  BUDGETS,
  EVIDENCE,
  FakeConnector,
  FixedClock,
  PATHS,
  READ_ONLY_EXECUTION,
  ScriptedRunner,
  context,
  ok,
  scratch,
  type Scratch,
} from './helpers.js';

/**
 * The arguments the discovery layer actually passes, exercised against the handlers.
 *
 * `args_schema` carries `additionalProperties: false`, which makes it the granted surface
 * rather than a description of one — so an argument a probe passes and a descriptor does not
 * declare is not a warning, it is a refused call and a Context Package element that reads
 * `UNKNOWN` for a reason that has nothing to do with the repository. That is what had happened
 * across twelve operations.
 *
 * `discovery/test/conformance.test.ts` is what keeps the two shapes in step, because it can see
 * both sides and this file cannot: `adapters/` does not depend on `discovery/` and must not.
 * What this file adds is the other half of the same claim — that the arguments the schemas now
 * admit are arguments the handlers *honour*. A schema widened to make a call stop failing, with
 * a handler that ignores what arrived, would trade a loud failure for a silent one.
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

interface Options {
  readonly git?: ScriptedRunner;
  readonly pm?: FakeConnector | null;
  readonly runtime?: FakeConnector | null;
  readonly vcsHost?: FakeConnector | null;
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
    runner: options.git ?? new ScriptedRunner({}),
    principalId: 'os-user',
    projectManagement: options.pm ?? null,
    runtime: options.runtime ?? null,
    vcsHost: options.vcsHost ?? null,
  });
}

function assertion(value: unknown): Assertion {
  return validators.assertion.parse(value, 'an adapter output');
}

/* ------------------------------------------------------------------ repo.list_paths --- */

describe('repo.list_paths answers the question the probes ask', () => {
  beforeEach(() => {
    space.file('package.json', '{}');
    space.file('src/pricing/rate.ts', 'export const rate = 1;');
    space.file('src/pricing/rate.test.ts', 'test');
    space.file('src/api/routes/rate.ts', 'export const route = 1;');
    space.file('test/pricing/rounding.test.ts', 'test');
    space.file('docs/architecture.md', '# a');
  });

  test('a glob set selects across the whole tree, not one directory deep', async () => {
    const { framework } = await suite();
    const outcome = await framework.call(
      'repo', 'list_paths', { globs: ['**/*.test.ts'] }, context(),
    );
    assert.equal(outcome.outcome, 'OK');
    const value = outcome.outcome === 'OK'
      ? outcome.value as { entries: string[] }
      : { entries: [] };
    assert.deepEqual(
      value.entries.sort(),
      ['src/pricing/rate.test.ts', 'test/pricing/rounding.test.ts'],
      'a listing that only looked one level down would find neither, and the probe would '
      + 'record "no tests cover this scope" about a repository that has two',
    );
  });

  test('`under` narrows to the scope, and narrows rather than widens', async () => {
    const { framework } = await suite();
    const outcome = await framework.call(
      'repo', 'list_paths', { globs: ['**/*.ts'], under: ['src/pricing/**'] }, context(),
    );
    const value = outcome.outcome === 'OK'
      ? outcome.value as { entries: string[] }
      : { entries: [] };
    assert.deepEqual(
      value.entries.sort(), ['src/pricing/rate.test.ts', 'src/pricing/rate.ts'],
    );
  });

  test('`under` is confined: a scope path outside the mandate is refused', async () => {
    const { framework } = await suite();
    const outcome = await framework.call(
      'repo', 'list_paths',
      { globs: ['**/*.ts'], under: ['src/pricing/**'] },
      context({ mandate: { in_scope: ['docs/**'], out_of_scope: [] } }),
    );
    assert.equal(
      outcome.outcome, 'REFUSED',
      'a path list is a path argument. If the mandate check did not reach every element, the '
      + 'one argument that carries the mandate\'s own patterns would be the one it missed',
    );
    assert.equal(outcome.outcome === 'REFUSED' ? outcome.refusal : null, 'scope_violation');
  });

  test('the directory form still works, because repo.attach cites it as evidence', async () => {
    const { framework } = await suite();
    const outcome = await framework.call('repo', 'list_paths', { path: '.' }, context());
    assert.equal(outcome.outcome, 'OK');
    const value = outcome.outcome === 'OK'
      ? outcome.value as { entries: string[] }
      : { entries: [] };
    assert.ok(value.entries.includes('package.json'));
    assert.equal(
      value.entries.includes('src/pricing/rate.ts'), false,
      'one level deep, as a directory listing is. The glob form is what goes deeper',
    );
  });

  test('a named directory that does not exist is absent, not empty', async () => {
    const { framework } = await suite();
    const outcome = await framework.call(
      'repo', 'list_paths', { path: 'nowhere' }, context(),
    );
    assert.equal(outcome.outcome, 'ERROR');
  });
});

/* ------------------------------------------------------------------------- git.log --- */

describe('git.log narrows the way the reality probes need it to', () => {
  test('a base, a path set and message tokens all reach the command', async () => {
    const runner = new ScriptedRunner({
      git: () => ok(''),
    });
    const { framework } = await suite({ git: runner });
    space.file('src/pricing/rate.ts', 'x');
    const outcome = await framework.call(
      'git', 'log',
      {
        ref: 'feature/DEF-456',
        not: 'main',
        paths: ['src/pricing/rate.ts'],
        message_contains: ['DEF-456'],
      },
      context(),
    );
    assert.equal(outcome.outcome, 'OK');
    const args = runner.invocations.at(-1)?.args ?? [];
    assert.ok(
      args.includes('main..feature/DEF-456'),
      `the exclusion has to reach git as a range, saw ${args.join(' ')}`,
    );
    assert.ok(args.includes('--grep=DEF-456'));
    assert.ok(
      args.includes('--fixed-strings'),
      'a ticket key is a literal. Matched as an expression, DEF-456 would also match DEFX456',
    );
    const separator = args.indexOf('--');
    assert.ok(separator !== -1 && args[separator + 1] === 'src/pricing/rate.ts');
  });

  test('a path outside the mandate is refused before git is run', async () => {
    const runner = new ScriptedRunner({ git: () => ok('') });
    const { framework } = await suite({ git: runner });
    const outcome = await framework.call(
      'git', 'log', { paths: ['docs/architecture.md'] },
      context({ mandate: { in_scope: ['src/**'], out_of_scope: [] } }),
    );
    assert.equal(outcome.outcome, 'REFUSED');
    assert.deepEqual(runner.invocations, []);
  });

  test('git.churn takes the same path set', async () => {
    const runner = new ScriptedRunner({ git: () => ok('') });
    const { framework } = await suite({ git: runner });
    space.file('src/pricing/rate.ts', 'x');
    await framework.call('git', 'churn', { paths: ['src/pricing/rate.ts'] }, context());
    const args = runner.invocations.at(-1)?.args ?? [];
    assert.ok(args.includes('--'));
    assert.ok(args.includes('src/pricing/rate.ts'));
  });
});

/* ------------------------------------------------------------------ git.merge_state --- */

describe('git.merge_state', () => {
  test('with neither a ref nor a pull request, it establishes nothing', async () => {
    const { framework } = await suite();
    const outcome = await framework.call('git', 'merge_state', {}, context());
    const value = assertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(value.confidence, 'UNKNOWN');
    assert.equal(
      value.confidence === 'UNKNOWN' ? value.reason : null, 'INSUFFICIENT_EVIDENCE',
      'asking the host about a ref named "undefined" and reporting the answer as this '
      + "change's merge state is how a missing argument becomes a false fact",
    );
  });

  test('a pull-request identifier reaches the host', async () => {
    const host = new FakeConnector('vcs', true, (resource, args) => {
      if (resource === 'merge_state') return { asked: args['pull_request'], merged: false };
      return {};
    });
    const { framework } = await suite({ vcsHost: host });
    const outcome = await framework.call(
      'git', 'merge_state', { ref: 'feature/x', base: 'main', pull_request: '41' }, context(),
    );
    const value = assertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(value.confidence, 'FACT');
    assert.deepEqual(value.value, { asked: '41', merged: false });
  });
});

/* ------------------------------------------------------- pm and runtime selectors --- */

describe('the structured selectors reach the connector', () => {
  test('pm.search_issues sends the scope rather than a query language nobody knows', async () => {
    space.file('src/pricing/rate.ts', 'x');
    const seen: Array<Readonly<Record<string, unknown>>> = [];
    const pm = new FakeConnector('tracker', true, (resource, args) => {
      seen.push(args);
      return resource === 'search' ? [{ key: 'DEF-456' }] : {};
    });
    const { framework } = await suite({ pm });
    const outcome = await framework.call(
      'pm', 'search_issues',
      { scope_paths: ['src/pricing/**'], capabilities: ['pricing'], repositories: ['subject'] },
      context(),
    );
    assert.equal(outcome.outcome, 'OK');
    const sent = seen.at(-1) ?? {};
    assert.deepEqual(sent['scope_paths'], ['src/pricing/**']);
    assert.deepEqual(sent['capabilities'], ['pricing']);
    assert.deepEqual(sent['repositories'], ['subject']);
  });

  test('pm.search_issues with no criterion asks nothing and says so', async () => {
    const pm = new FakeConnector('tracker', true, () => [{ key: 'EVERYTHING' }]);
    const { framework } = await suite({ pm });
    const outcome = await framework.call('pm', 'search_issues', {}, context());
    const value = assertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(value.confidence, 'UNKNOWN');
    assert.equal(
      value.confidence === 'UNKNOWN' ? value.reason : null, 'INSUFFICIENT_EVIDENCE',
      'a search with no criterion is a listing of everything, which is not evidence about '
      + 'one work item',
    );
  });

  test('pm.search_issues confines the scope paths before they leave the machine', async () => {
    const pm = new FakeConnector('tracker', true, () => []);
    const { framework } = await suite({ pm });
    const outcome = await framework.call(
      'pm', 'search_issues', { scope_paths: ['../../etc/**'] }, context(),
    );
    assert.equal(outcome.outcome, 'REFUSED');
  });

  test('runtime.query takes a purpose where a caller has no query language', async () => {
    space.file('src/pricing/rate.ts', 'x');
    const seen: Array<Readonly<Record<string, unknown>>> = [];
    const runtime = new FakeConnector('cluster', true, (resource, args) => {
      seen.push(args);
      return resource === 'query' ? { rows: 3 } : {};
    });
    const { framework } = await suite({ runtime });
    const outcome = await framework.call(
      'runtime', 'query', { purpose: 'error_patterns', scope_paths: ['src/pricing/**'] },
      context(),
    );
    assert.equal(outcome.outcome, 'OK');
    assert.equal((seen.at(-1) ?? {})['purpose'], 'error_patterns');
  });

  test('runtime.query with neither a query nor a purpose asks nothing', async () => {
    const runtime = new FakeConnector('cluster', true, () => ({ rows: 0 }));
    const { framework } = await suite({ runtime });
    const outcome = await framework.call('runtime', 'query', {}, context());
    const value = assertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(value.confidence, 'UNKNOWN');
  });

  test('runtime.deployed_version answers for an environment with no service named', async () => {
    const runtime = new FakeConnector('cluster', true, (resource, args) => {
      if (resource === 'deployed_version') return { environment: args['environment'], version: '1.4.0' };
      return {};
    });
    const { framework } = await suite({ runtime });
    const outcome = await framework.call(
      'runtime', 'deployed_version', { environment: 'production' }, context(),
    );
    const value = assertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(
      value.confidence, 'FACT',
      '"what is running in production" is answerable by any runtime that knows its own '
      + 'topology, and requiring a service name would make a probe enumerate services first '
      + 'and attribute that enumeration\'s failures to the deployment',
    );
  });

  test('runtime.deployed_version with neither establishes nothing', async () => {
    const runtime = new FakeConnector('cluster', true, () => ({ version: 'whatever' }));
    const { framework } = await suite({ runtime });
    const outcome = await framework.call('runtime', 'deployed_version', {}, context());
    assert.equal(assertion(outcome.outcome === 'OK' ? outcome.value : null).confidence, 'UNKNOWN');
  });

  test('runtime.outcome_evidence still requires the outcome, and takes the context', async () => {
    space.file('src/pricing/rate.ts', 'x');
    const seen: Array<Readonly<Record<string, unknown>>> = [];
    const runtime = new FakeConnector('cluster', true, (resource, args) => {
      seen.push(args);
      return resource === 'outcome_evidence' ? { holds: true } : {};
    });
    const { framework } = await suite({ runtime });

    const missing = await framework.call(
      'runtime', 'outcome_evidence', { work_item_id: 'wi_c_subject' }, context(),
    );
    assert.equal(
      missing.outcome, 'ERROR',
      'an outcome nobody stated is an outcome nobody can check, so it stays required',
    );

    const outcome = await framework.call(
      'runtime', 'outcome_evidence',
      {
        outcome: 'reports show a per-record source',
        work_item_id: 'wi_c_subject',
        scope_paths: ['src/pricing/**'],
        capabilities: ['pricing'],
      },
      context(),
    );
    assert.equal(assertion(outcome.outcome === 'OK' ? outcome.value : null).confidence, 'FACT');
    assert.deepEqual((seen.at(-1) ?? {})['capabilities'], ['pricing']);
  });
});

/* ------------------------------------------------------------- the whole-repo reads --- */

describe('the attachment operations take no arguments', () => {
  test('identify, detect_stack and commands are about the one attached worktree', async () => {
    const { framework } = await suite();
    for (const op of ['identify', 'detect_stack', 'commands']) {
      const descriptor = framework.descriptor('repo', op);
      assert.deepEqual(
        Object.keys((descriptor?.args_schema as { properties: object }).properties), [],
        `${op} is answered about the worktree the adapter is attached to. A path argument `
        + 'would either be ignored, which makes the evidence locator say something the adapter '
        + 'did not do, or re-root the adapter, which is confinement decided by the caller',
      );
      assert.equal((await framework.call('repo', op, {}, context())).outcome, 'OK');
    }
  });
});
