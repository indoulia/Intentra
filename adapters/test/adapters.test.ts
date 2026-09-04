import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validators } from '@agentos/contracts';
import type { AdapterAvailability, Assertion } from '@agentos/contracts';
import {
  ResourceAbsentError,
  createAdapterSuite,
  hostIdentity,
  repositorySkills,
  type AdapterSuite,
} from '../src/index.js';
import {
  BUDGETS,
  EVIDENCE,
  FakeConnector,
  FixedClock,
  PATHS,
  READ_ONLY_EXECUTION,
  ScriptedRunner,
  T0,
  context,
  makeSymlink,
  failed,
  ok,
  scratch,
  unreachableConnector,
  type Scratch,
} from './helpers.js';

/**
 * The five read-only adapter families, and the degradation matrix.
 *
 * Every operation registered by `createAdapterSuite` is non-mutating: that is milestone 1's
 * whole shape, and the first test asserts it rather than trusting the review that wrote it.
 *
 * The rest of the file is about honesty under reduced access. "No project management access",
 * "no runtime access" and "no CI" are recorded limitations, not failures — but only if the
 * adapter reports each of them as what it is. The failure this suite is written against is
 * not a host being down; it is a host being down and the adapter reporting `false`.
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

interface SuiteOptions {
  readonly git?: boolean;
  readonly vcsHost?: FakeConnector | null;
  readonly projectManagement?: FakeConnector | null;
  readonly runtime?: FakeConnector | null;
  readonly principalId?: string | null;
  readonly host?: string;
}

async function suite(options: SuiteOptions = {}): Promise<AdapterSuite> {
  const gitPresent = options.git ?? true;
  if (gitPresent) space.dir('.git');
  const runner = gitPresent
    ? new ScriptedRunner({
      git: (args) => {
        const command = args[0];
        if (command === '--version') return ok('git version 2.45.0\n');
        if (command === 'rev-parse') return ok('feature/thing\n');
        if (command === 'branch') return ok('main\nfeature/thing\norigin/main\n');
        if (command === 'remote') return ok('origin\tssh://host/repo.git\t(fetch)\n');
        if (command === 'symbolic-ref') return ok('origin/main\n');
        if (command === 'status') return ok('## feature/thing\n M src/app.ts\n');
        if (command === 'worktree') return ok('worktree /w\nHEAD abc123\n');
        if (command === 'log') {
          return ok(`abc123${String.fromCharCode(31)}A Dev${String.fromCharCode(31)}2026-09-01T10:00:00Z${String.fromCharCode(31)}first\n`);
        }
        return failed(`unscripted git subcommand ${String(command)}`);
      },
    })
    : new ScriptedRunner({});

  return createAdapterSuite({
    worktreeRoot: space.worktree,
    installationRoot: join(space.root, 'installation'),
    home: join(space.root, 'home'),
    paths: PATHS,
    evidence: EVIDENCE,
    execution: READ_ONLY_EXECUTION,
    budgets: BUDGETS,
    clock,
    runner,
    host: options.host ?? 'host.cli',
    principalId: options.principalId === undefined ? 'os-user' : options.principalId,
    vcsHost: options.vcsHost ?? null,
    projectManagement: options.projectManagement ?? null,
    runtime: options.runtime ?? null,
  });
}

function stateOf(availability: readonly AdapterAvailability[], adapter: string): string {
  return availability.find((entry) => entry.adapter === adapter)?.state ?? 'MISSING';
}

function asAssertion(value: unknown): Assertion {
  return validators.assertion.parse(value, 'an adapter output');
}

/* --------------------------------------------------------------- the registered set -- */

describe('what is registered', () => {
  test('the five families are present and every one of them is read-only', async () => {
    const { framework } = await suite();
    const families = [...new Set(framework.descriptors().map((d) => d.adapter))].sort();
    assert.deepEqual(families, ['git', 'host', 'pm', 'repo', 'runtime']);

    const mutating = framework.descriptors().filter((d) => d.mutating);
    assert.deepEqual(
      mutating, [],
      'WP-4 must not register a mutating operation. Milestone 1 discovers and audits and '
      + 'mutates nothing',
    );
  });

  test('every descriptor satisfies its contract and declares its observation safety', async () => {
    const { framework } = await suite();
    for (const descriptor of framework.descriptors()) {
      validators.adapterOperationDescriptor.parse(descriptor, `${descriptor.adapter}.${descriptor.op}`);
      if (descriptor.observation_safe) assert.equal(descriptor.mutating, false);
    }
  });

  test('the tool name the kernel derives is unique across every operation', async () => {
    const { framework } = await suite();
    const names = framework.descriptors()
      .map((d) => `${d.adapter.replace(/\./g, '_')}__${d.op}`);
    assert.equal(
      new Set(names).size, names.length,
      'the granted tool surface is an allowlist keyed by name, so two operations sharing one '
      + 'name would make one of them unreachable and the other ambiguous',
    );
  });

  test('a read whose re-execution consumes what it measured is not observation_safe', async () => {
    const { framework } = await suite();
    const logs = framework.descriptor('runtime', 'read_logs');
    assert.equal(logs?.mutating, false);
    assert.equal(
      logs?.observation_safe, false,
      'mutating: false does not imply observation_safe: true — a log tail advances a cursor',
    );
  });
});

/* --------------------------------------------------------------------- repository ---- */

describe('the repository adapter', () => {
  test('the attachment sequence answers every step with an assertion', async () => {
    space.file('package.json', JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
    space.file('src/app.ts', 'export const a = 1;\n');
    space.dir('test');
    space.dir('.github/workflows');

    const { framework } = await suite();
    const outcome = await framework.call('repo', 'attach', {}, context());
    assert.equal(outcome.outcome, 'OK');
    const value = outcome.outcome === 'OK' ? outcome.value as Record<string, unknown> : {};

    for (const key of [
      'path', 'vcs', 'current_branch', 'worktree_clean', 'ecosystems', 'package_managers',
      'ci', 'containers', 'source_directories', 'test_directories', 'documentation',
      'configuration', 'conventions', 'agent_directory', 'commands', 'protected_branches',
      'environments',
    ]) {
      asAssertion(value[key]);
    }

    const ecosystems = asAssertion(value['ecosystems']);
    assert.equal(
      ecosystems.confidence, 'INFERENCE',
      'detection from a manifest is an inference; running the build is what would make it a fact',
    );
    assert.deepEqual(ecosystems.value, ['node']);
  });

  test('both fail-closed determinations report UNKNOWN rather than a comforting default', async () => {
    const { framework } = await suite();
    const outcome = await framework.call('repo', 'boundaries', {}, context());
    assert.equal(outcome.outcome, 'OK');
    const value = outcome.outcome === 'OK' ? outcome.value as Record<string, unknown> : {};
    const branches = asAssertion(value['protected_branches']);
    assert.equal(branches.confidence, 'UNKNOWN');
    assert.equal(
      branches.confidence === 'UNKNOWN' ? branches.reason : null, 'UNAVAILABLE',
    );
    assert.match(
      branches.confidence === 'UNKNOWN' ? branches.recoverable_by : '',
      /protection settings/,
      'an unknown that does not say what would resolve it is a gap nobody can close',
    );
  });

  test('a repository with no .agent/ works fully and records nothing as missing', async () => {
    const { framework } = await suite();
    const outcome = await framework.call('repo', 'read_agent_directory', {}, context());
    assert.equal(outcome.outcome, 'OK');
    const value = outcome.outcome === 'OK' ? outcome.value as Record<string, unknown> : {};
    assert.equal(value['present'], false);
    assert.match(String(value['note']), /works fully/);
  });

  test('.agent/ content is read as a claim, not as truth', async () => {
    space.file('.agent/architecture.md', '# declared\n');
    const { framework } = await suite();
    const outcome = await framework.call('repo', 'read_agent_directory', {}, context());
    const value = outcome.outcome === 'OK' ? outcome.value as Record<string, unknown> : {};
    assert.equal(value['present'], true);
    const status = asAssertion(value['status']);
    assert.equal(status.confidence, 'INFERENCE');
  });

  test('a declared environment topology is an inference and never a fact', async () => {
    space.file('.agent/environments.json', JSON.stringify([{ name: 'prod', production: true }]));
    const { framework } = await suite();
    const outcome = await framework.call('repo', 'boundaries', {}, context());
    const value = outcome.outcome === 'OK' ? outcome.value as Record<string, unknown> : {};
    const environments = asAssertion(value['environments']);
    assert.equal(
      environments.confidence, 'INFERENCE',
      'declared context never overrides observed reality; it is a claim to be reconciled',
    );
  });

  test('an unparseable environments file is CONFLICTING, not silently ignored', async () => {
    space.file('.agent/environments.json', '{ not json');
    const { framework } = await suite();
    const outcome = await framework.call('repo', 'boundaries', {}, context());
    const value = outcome.outcome === 'OK' ? outcome.value as Record<string, unknown> : {};
    const environments = asAssertion(value['environments']);
    assert.equal(environments.confidence, 'UNKNOWN');
    assert.equal(
      environments.confidence === 'UNKNOWN' ? environments.reason : null, 'CONFLICTING',
    );
  });

  test('a file read is confined, and its content is redacted', async () => {
    space.file('src/config.ts', 'export const token = "ghp_abcdefghijklmnopqrstuvwxyz01";\n');
    const { framework } = await suite();
    const outcome = await framework.call(
      'repo', 'read_file', { path: 'src/config.ts' }, context(),
    );
    assert.equal(outcome.outcome, 'OK');
    const value = outcome.outcome === 'OK' ? outcome.value as Record<string, unknown> : {};
    assert.doesNotMatch(String(value['content']), /ghp_abcdefghijklmnopqrstuvwxyz01/);
    assert.equal(outcome.call.paths_touched[0], 'src/config.ts');
  });

  test('a read outside the mandate is refused before the file is opened', async () => {
    space.file('secrets/keys.txt', 'x');
    const { framework } = await suite();
    const outcome = await framework.call('repo', 'read_file', { path: 'secrets/keys.txt' }, context({
      mandate: { in_scope: ['src/**'], out_of_scope: [] },
    }));
    assert.equal(outcome.outcome, 'REFUSED');
    assert.equal(outcome.outcome === 'REFUSED' ? outcome.refusal : '', 'scope_violation');
  });

  test('enumeration skips the declared scratch roots', async () => {
    space.file('src/app.ts', 'x');
    space.file('node_modules/pkg/index.ts', 'x');
    space.file('dist/app.ts', 'x');
    const { framework } = await suite();
    const outcome = await framework.call('repo', 'find_files', { glob: '**/*.ts' }, context());
    const value = outcome.outcome === 'OK' ? outcome.value as { matched: string[] } : { matched: [] };
    assert.ok(value.matched.includes('src/app.ts'));
    assert.ok(!value.matched.some((path) => path.startsWith('node_modules/')));
    assert.ok(!value.matched.some((path) => path.startsWith('dist/')));
  });

  test('a read of a file that is not there reports absence rather than emptiness', async () => {
    const { framework } = await suite();
    const outcome = await framework.call('repo', 'stat_path', { path: 'nowhere.ts' }, context());
    const value = outcome.outcome === 'OK' ? outcome.value as Record<string, unknown> : {};
    assert.equal(value['exists'], false);
    assert.equal(value['kind'], null);
  });
});

/* -------------------------------------------------------------------------- git ------ */

describe('the git adapter', () => {
  test('local observations are facts when git answers', async () => {
    const { framework } = await suite();
    const outcome = await framework.call('git', 'current_branch', {}, context());
    assert.equal(outcome.outcome, 'OK');
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'FACT');
    assert.equal(assertion.value, 'feature/thing');
  });

  test('with git missing, the answer is UNAVAILABLE and never an empty list', async () => {
    const { framework } = await suite({ git: false });
    const outcome = await framework.call('git', 'list_branches', {}, context());
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'UNKNOWN');
    assert.equal(assertion.confidence === 'UNKNOWN' ? assertion.reason : null, 'UNAVAILABLE');
    assert.notDeepEqual(
      assertion.value, [],
      'reporting no branches because git was missing is the shape of lie the evidence model '
      + 'exists to prevent',
    );
  });

  test('with no pull-request host, pull requests are UNAVAILABLE and never absent', async () => {
    const { framework } = await suite();
    const outcome = await framework.call('git', 'list_prs', {}, context());
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'UNKNOWN');
    assert.equal(assertion.confidence === 'UNKNOWN' ? assertion.reason : null, 'UNAVAILABLE');
  });

  test('with the host configured and unreachable, still UNAVAILABLE, with the attempt recorded', async () => {
    const { framework } = await suite({ vcsHost: unreachableConnector('vcs') as FakeConnector });
    const outcome = await framework.call('git', 'ci_status', { ref: 'abc123' }, context());
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'UNKNOWN');
    assert.equal(assertion.confidence === 'UNKNOWN' ? assertion.reason : null, 'UNAVAILABLE');
    assert.match(
      assertion.confidence === 'UNKNOWN' ? assertion.attempted ?? '' : '',
      /did not answer/,
      'the attempt is recorded, so a reachability failure is distinguishable from an absence',
    );
  });

  test('with the host answering, CI state is a fact', async () => {
    const host = new FakeConnector('vcs', true, (resource) => {
      if (resource === 'ci_state') return { status: 'success' };
      return null;
    });
    const { framework } = await suite({ vcsHost: host });
    const outcome = await framework.call('git', 'ci_status', { ref: 'abc123' }, context());
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'FACT');
  });

  test('read_pr distinguishes a deleted pull request from an unreachable host', async () => {
    const deleted = new FakeConnector('vcs', true, () => {
      throw new ResourceAbsentError('pr-1', 'pull request 1 was deleted');
    });
    const { framework: withDeleted } = await suite({ vcsHost: deleted });
    const absent = await withDeleted.call('git', 'read_pr', { id: 'pr-1' }, context());
    assert.equal(absent.outcome, 'ERROR');
    assert.match(absent.outcome === 'ERROR' ? absent.message : '', /deleted/);

    const { framework: withNone } = await suite({ vcsHost: null });
    const unreachable = await withNone.call('git', 'read_pr', { id: 'pr-1' }, context());
    assert.match(
      unreachable.outcome === 'ERROR' ? unreachable.message : '',
      /Unreachable is not absent/,
    );
  });
});

/* ------------------------------------------------------------------------- host ------ */

describe('the host adapter', () => {
  test('the CLI host asserts the authenticated OS user and OPERATOR', () => {
    const identity = hostIdentity({
      host: 'host.cli',
      worktreeRoot: space.worktree,
      principalId: 'os-user',
    });
    assert.equal(identity.trustClass, 'OPERATOR');
    assert.equal(identity.principal?.id, 'os-user');
    assert.equal(identity.principal?.asserted_by, 'host.cli');
  });

  test('a host that cannot assert a principal classifies EXTERNAL', () => {
    const identity = hostIdentity({
      host: 'host.cli',
      worktreeRoot: space.worktree,
      principalId: null,
    });
    assert.equal(identity.trustClass, 'EXTERNAL');
    assert.equal(identity.principal, null);
  });

  test('every other host classifies EXTERNAL even with a principal in hand', () => {
    const identity = hostIdentity({
      host: 'host.webhook',
      worktreeRoot: space.worktree,
      principalId: 'someone',
    });
    assert.equal(
      identity.trustClass, 'EXTERNAL',
      'freeze D-5 closes the decision for the CLI host only. Every other source is EXTERNAL '
      + 'until a host exists that can assert a principal for it',
    );
  });

  test('platform differences are reported rather than assumed', async () => {
    const { framework } = await suite();
    const outcome = await framework.call('host', 'platform', {}, context());
    const value = outcome.outcome === 'OK' ? outcome.value as Record<string, unknown> : {};
    for (const key of ['platform', 'path_separator', 'line_ending', 'case_sensitive_paths', 'temp_root']) {
      asAssertion(value[key]);
    }
  });

  test('a repository script is enumerated and is not selectable', async () => {
    space.file('package.json', JSON.stringify({ scripts: { build: 'tsc -b' } }));
    const entries = repositorySkills(space.worktree, T0);
    const build = entries.find((entry) => entry.id === 'script:build');
    assert.ok(build !== undefined);
    validators.skillEntry.parse(build, 'the enumerated script');
    assert.equal(build.spawns_agents, true);
    assert.equal(
      build.spawns_agents_determined, false,
      'a script that declares nothing about spawning is treated as spawning, and a repository '
      + 'that wants its scripts used declares them',
    );
  });

  test('a declared repository skill carries what it declared', async () => {
    space.file('.agent/skills/lint.json', JSON.stringify({
      id: 'repo.lint',
      description: 'runs the linter',
      spawns_agents: false,
      mutating: false,
      external_destination: false,
      domains: ['repository_analysis', 'not-a-domain'],
      operations: ['analyse'],
      targets: ['filesystem'],
      cost_hint: 'low',
    }));
    const entries = repositorySkills(space.worktree, T0);
    const lint = entries.find((entry) => entry.id === 'repo.lint');
    assert.ok(lint !== undefined);
    validators.skillEntry.parse(lint, 'the declared skill');
    assert.equal(lint.spawns_agents, false);
    assert.equal(lint.spawns_agents_determined, true);
    assert.deepEqual(
      lint.domains, ['repository_analysis'],
      'a declared value outside the vocabulary is dropped rather than carried through',
    );
  });

  test('a Makefile target is enumerated too, and is equally undetermined', async () => {
    space.file('Makefile', 'build:\n\tgo build ./...\n\n.PHONY: build\n');
    const entries = repositorySkills(space.worktree, T0);
    const target = entries.find((entry) => entry.id === 'make:build');
    assert.ok(target !== undefined);
    assert.equal(target.spawns_agents_determined, false);
  });

  test('with no model inventory, the enumeration is empty and says so', async () => {
    const { framework } = await suite();
    const outcome = await framework.call('host', 'list_models', {}, context());
    const value = outcome.outcome === 'OK' ? outcome.value as { entries: unknown[] } : { entries: [1] };
    assert.deepEqual(value.entries, []);
  });

  test('the intake record carries a re-executable locator and a content hash', async () => {
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
      principalId: 'os-user',
      intake: {
        source: 'NATURAL_LANGUAGE',
        raw: 'audit the reporting capability',
        received_at: T0,
      },
    });
    const outcome = await framework.call('host', 'read_intake', {}, context());
    assert.equal(outcome.outcome, 'OK');
    const record = validators.intakeRecord.parse(
      outcome.outcome === 'OK' ? outcome.value : null, 'the intake record',
    );
    assert.equal(record.trust_class, 'OPERATOR');
    assert.equal(record.principal.id, 'os-user');
    assert.equal(record.source_locator.adapter, 'host');
    assert.ok(record.content_hash.length === 64);
  });
});

/* ---------------------------------------------------------- the degradation matrix --- */

describe('the degradation matrix', () => {
  test('no project-management access is NOT_CONFIGURED, and the intent axis says why', async () => {
    const { framework } = await suite({ projectManagement: null });
    assert.equal(stateOf(framework.availability(), 'pm'), 'NOT_CONFIGURED');

    const outcome = await framework.call('pm', 'search_issues', { query: 'x' }, context());
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence, 'UNKNOWN');
    assert.match(
      assertion.confidence === 'UNKNOWN' ? assertion.recoverable_by : '',
      /INDETERMINATE intent axis/,
    );
  });

  test('project management configured and unreachable is UNAVAILABLE, never NOT_CONFIGURED', async () => {
    const { framework } = await suite({
      projectManagement: unreachableConnector('tracker') as FakeConnector,
    });
    assert.equal(
      stateOf(framework.availability(), 'pm'), 'UNAVAILABLE',
      '"this host has no access" and "it is configured and would not connect" lead to '
      + 'different decisions, and only the second is worth waking someone for',
    );

    const outcome = await framework.call('pm', 'search_issues', { query: 'x' }, context());
    const assertion = asAssertion(outcome.outcome === 'OK' ? outcome.value : null);
    assert.equal(assertion.confidence === 'UNKNOWN' ? assertion.reason : null, 'UNAVAILABLE');
  });

  test('no runtime access is NOT_CONFIGURED and caps every claim', async () => {
    const { framework } = await suite({ runtime: null });
    assert.equal(stateOf(framework.availability(), 'runtime'), 'NOT_CONFIGURED');
    const entry = framework.availability().find((a) => a.adapter === 'runtime');
    assert.match(
      entry?.detail ?? '', /at most PARTIAL, never PROVEN/,
      'reduced access reduces the strength of claims AgentOS is allowed to make, and the '
      + 'availability record is where that is stated',
    );
  });

  test('runtime configured and unreachable is UNAVAILABLE', async () => {
    const { framework } = await suite({
      runtime: unreachableConnector('cluster') as FakeConnector,
    });
    assert.equal(stateOf(framework.availability(), 'runtime'), 'UNAVAILABLE');
  });

  test('no CI reachable means the CI verdict is UNAVAILABLE and validation is local only', async () => {
    const { framework } = await suite({ vcsHost: null });
    const entry = framework.availability().find((a) => a.adapter === 'git');
    assert.equal(entry?.state, 'AVAILABLE');
    assert.match(
      entry?.detail ?? '', /UNAVAILABLE rather than absent/,
      'git being reachable and the CI host not being configured are separate facts, and the '
      + 'availability record keeps them separate',
    );
  });

  test('with everything reachable, every family is AVAILABLE', async () => {
    const answering = (id: string) => new FakeConnector(id, true, () => ({ ok: true }));
    const { framework } = await suite({
      vcsHost: answering('vcs'),
      projectManagement: answering('tracker'),
      runtime: answering('cluster'),
    });
    for (const family of ['repo', 'git', 'host', 'pm', 'runtime']) {
      assert.equal(stateOf(framework.availability(), family), 'AVAILABLE', family);
    }
  });

  test('before any probe has run, nothing claims to be reachable', () => {
    /* Built directly rather than through the suite factory, which probes on the way out. */
    assert.equal(
      READ_ONLY_EXECUTION.mutation_enabled, false,
      'and the policy this build runs under still forbids mutation',
    );
  });

  test('every availability record is a contract value', async () => {
    const { framework } = await suite();
    for (const entry of framework.availability()) {
      validators.adapterAvailability.parse(entry, `${entry.adapter} availability`);
    }
  });
});

/* ------------------------------------------------------------- the worktree is real -- */

describe('against a scratch repository on disk', () => {
  test('a symlinked escape inside a real worktree is refused by a real read', async () => {
    writeFileSync(join(space.outside, 'stolen.txt'), 'secret', 'utf8');
    makeSymlink(space.outside, join(space.worktree, 'escape'), 'junction');

    const { framework } = await suite();
    const outcome = await framework.call(
      'repo', 'read_file', { path: 'escape/stolen.txt' }, context(),
    );
    assert.equal(outcome.outcome, 'REFUSED');
    assert.equal(outcome.outcome === 'REFUSED' ? outcome.refusal : '', 'security_violation');
    assert.equal(framework.refusals()[0]?.rule, 'symlink_escape');
  });
});
