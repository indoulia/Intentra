import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { validators } from '@agentos/contracts';
import type { Classification, GateDefinition } from '@agentos/contracts';
import {
  AdapterFramework,
  DANGEROUS_VALUE,
  SAFE_VALUE,
  branchProtectionProbe,
  classify,
  environmentProbe,
  readOnlyOperation,
  spawningProbe,
  unprobed,
  type ClassificationProbe,
} from '../src/index.js';
import {
  BUDGETS,
  EVIDENCE,
  FakeConnector,
  FixedClock,
  PATHS,
  POLICIES,
  READ_ONLY_EXECUTION,
  ScriptedRunner,
  emptyRegistry,
  scratch,
  unreachableConnector,
  type Scratch,
} from './helpers.js';

/**
 * Fail-closed classification.
 *
 * Two facts gate everything dangerous: is this branch protected, is this environment
 * production. Both are discovered, discovery can fail, and `UNKNOWN` is treated as the
 * dangerous case.
 *
 * The sharpest test in this file is the one about the *value*. It is not enough for a failed
 * probe to set `failed_closed: true` — `policies/data/gates.json` fires `MERGE_PROTECTED` on a
 * classification whose value equals `PROTECTED` and the kernel compares by equality, so a
 * classification that came back saying "unknown" would satisfy no classifier, fire no gate,
 * and turn the fail-closed rule into a fail-open one with a flag on it documenting a caution
 * that never happened.
 */

let space: Scratch;

beforeEach(() => {
  space = scratch();
});

afterEach(() => {
  space.dispose();
});

function framework(probes: readonly ClassificationProbe[]): AdapterFramework {
  const registry = emptyRegistry();
  registry.register(readOnlyOperation({
    adapter: 'probe',
    op: 'noop',
    description: 'A registered operation, so the framework has a family to report.',
    evidenceKind: 'command',
    observationSafe: true,
    handler: () => Promise.resolve({ value: null }),
  }));
  return new AdapterFramework({
    registry,
    clock: new FixedClock(),
    worktreeRoot: space.worktree,
    installationRoot: join(space.root, 'installation'),
    home: join(space.root, 'home'),
    paths: PATHS,
    evidence: EVIDENCE,
    execution: READ_ONLY_EXECUTION,
    budgets: BUDGETS,
    classificationProbes: probes,
  });
}

function classifierExpecting(gate: string): string | boolean | null {
  const definition: GateDefinition | undefined = POLICIES.gates.gates.find(
    (candidate) => candidate.gate === gate,
  );
  const classifier = definition?.classifiers.find(
    (candidate) => candidate.kind === 'classification_value',
  );
  return classifier?.expected ?? null;
}

describe('the fail-closed value is the dangerous value itself', () => {
  test('an unestablished branch protection classifies PROTECTED', () => {
    const result = classify('branch_protection', 'main', {
      established: false,
      detail: 'no VCS host is configured',
    });
    assert.equal(result.value, 'PROTECTED');
    assert.equal(result.confidence, 'UNKNOWN');
    assert.equal(result.failed_closed, true);
    validators.classification.parse(result, 'the classification');
  });

  test('an unestablished environment classifies PRODUCTION', () => {
    const result = classify('environment', 'staging-2', {
      established: false,
      detail: 'the runtime described no environments',
    });
    assert.equal(result.value, 'PRODUCTION');
    assert.equal(result.confidence, 'UNKNOWN');
    assert.equal(result.failed_closed, true);
  });

  test('an unestablished observation safety classifies UNSAFE', () => {
    const result = classify('observation_safety', 'probe.mystery', {
      established: false,
      detail: 'not registered',
    });
    assert.equal(result.value, 'UNSAFE');
    assert.equal(result.failed_closed, true);
  });

  test('undetermined spawning classifies SPAWNS', () => {
    const result = classify('spawns_agents', 'script:build', {
      established: false,
      detail: 'the skill declares nothing about spawning',
    });
    assert.equal(result.value, 'SPAWNS');
    assert.equal(result.failed_closed, true);
  });

  test('the fail-closed value is exactly what the gate classifiers compare against', () => {
    assert.equal(
      classifierExpecting('MERGE_PROTECTED'), DANGEROUS_VALUE.branch_protection,
      'a value the classifier does not recognize fires no gate, whatever failed_closed says',
    );
    assert.equal(
      classifierExpecting('DEPLOY_PRODUCTION'), DANGEROUS_VALUE.environment,
    );
  });

  test('the safe values are distinct from the dangerous ones for every kind', () => {
    for (const kind of ['branch_protection', 'environment', 'observation_safety', 'spawns_agents'] as const) {
      assert.notEqual(SAFE_VALUE[kind], DANGEROUS_VALUE[kind]);
    }
  });
});

describe('an established classification is not failed closed', () => {
  test('a branch the host says is protected is PROTECTED as a FACT', () => {
    const result = classify('branch_protection', 'main', {
      established: true,
      dangerous: true,
      confidence: 'FACT',
      detail: 'the host reports main protected=true',
    });
    assert.equal(result.value, 'PROTECTED');
    assert.equal(result.confidence, 'FACT');
    assert.equal(
      result.failed_closed, false,
      '"this branch really is protected" and "we could not find out" are different facts, and '
      + 'only one of them is fixed by granting access',
    );
  });

  test('a branch the host says is unprotected is UNPROTECTED', () => {
    const result = classify('branch_protection', 'feature/x', {
      established: true,
      dangerous: false,
      confidence: 'FACT',
      detail: 'the host reports feature/x protected=false',
    });
    assert.equal(result.value, 'UNPROTECTED');
    assert.equal(result.failed_closed, false);
  });
});

describe('the framework routes classification through its probes', () => {
  test('with no probe for a kind at all, the answer is the dangerous value', async () => {
    const result = await framework([]).classify('branch_protection', 'main');
    assert.equal(result.value, 'PROTECTED');
    assert.equal(result.failed_closed, true);
  });

  test('a probe that throws establishes nothing and fails closed', async () => {
    const probe: ClassificationProbe = {
      kind: 'environment',
      probe: () => Promise.reject(new Error('the runtime refused: token=ghp_abcdefghijklmnopqrstuvwx')),
    };
    const result = await framework([probe]).classify('environment', 'prod-eu');
    assert.equal(result.value, 'PRODUCTION');
    assert.equal(result.failed_closed, true);
    assert.doesNotMatch(
      result.probe_detail, /ghp_abcdefghijklmnopqrstuvwx/,
      'a probe failure carries no secret into the classification record',
    );
  });

  test('unprobed() and a missing probe agree', () => {
    const direct = unprobed('environment', 'prod-eu');
    assert.equal(direct.value, 'PRODUCTION');
    assert.equal(direct.failed_closed, true);
  });
});

describe('branch protection, probed through the VCS host', () => {
  const gitOptions = (host: FakeConnector | null) => ({
    worktreeRoot: space.worktree,
    runner: new ScriptedRunner({}),
    host,
  });

  test('with no host configured, PROTECTED and failed closed', async () => {
    const result = await framework([branchProtectionProbe(gitOptions(null))])
      .classify('branch_protection', 'main');
    assert.equal(result.value, 'PROTECTED');
    assert.equal(result.failed_closed, true);
    assert.match(result.probe_detail, /no VCS host is configured/);
  });

  test('with the host unreachable, PROTECTED and failed closed', async () => {
    const host = unreachableConnector('vcs') as FakeConnector;
    const result = await framework([branchProtectionProbe(gitOptions(host))])
      .classify('branch_protection', 'main');
    assert.equal(result.value, 'PROTECTED');
    assert.equal(result.failed_closed, true);
  });

  test('with the host reporting protection, PROTECTED as a FACT', async () => {
    const host = new FakeConnector('vcs', true, () => ({ protected: true }));
    const result = await framework([branchProtectionProbe(gitOptions(host))])
      .classify('branch_protection', 'main');
    assert.equal(result.value, 'PROTECTED');
    assert.equal(result.confidence, 'FACT');
    assert.equal(result.failed_closed, false);
  });

  test('a protection record that does not say fails closed', async () => {
    const host = new FakeConnector('vcs', true, () => ({ rules: [] }));
    const result = await framework([branchProtectionProbe(gitOptions(host))])
      .classify('branch_protection', 'main');
    assert.equal(result.value, 'PROTECTED');
    assert.equal(result.failed_closed, true);
    assert.match(result.probe_detail, /does not state whether it is protected/);
  });
});

describe('environment classification, probed through the runtime', () => {
  test('with no runtime, PRODUCTION and failed closed', async () => {
    const result = await framework([environmentProbe({ connector: null })])
      .classify('environment', 'staging');
    assert.equal(result.value, 'PRODUCTION');
    assert.equal(result.failed_closed, true);
  });

  test('with no topology discovered at all, every runtime is production', async () => {
    const connector = new FakeConnector('runtime', true, () => []);
    const result = await framework([environmentProbe({ connector })])
      .classify('environment', 'staging');
    assert.equal(result.value, 'PRODUCTION');
    assert.equal(result.failed_closed, true);
    assert.match(result.probe_detail, /no topology discovered at all/);
  });

  test('an environment absent from the discovered topology fails closed', async () => {
    const connector = new FakeConnector('runtime', true, () => [
      { name: 'prod', production: true },
    ]);
    const result = await framework([environmentProbe({ connector })])
      .classify('environment', 'staging');
    assert.equal(result.value, 'PRODUCTION');
    assert.equal(result.failed_closed, true);
  });

  test('an environment the runtime says is not production is NON_PRODUCTION', async () => {
    const connector = new FakeConnector('runtime', true, () => [
      { name: 'staging', production: false },
    ]);
    const result = await framework([environmentProbe({ connector })])
      .classify('environment', 'staging');
    assert.equal(result.value, 'NON_PRODUCTION');
    assert.equal(result.confidence, 'FACT');
    assert.equal(result.failed_closed, false);
  });
});

describe('spawning classification, over the enumerated skills', () => {
  test('a script the repository merely contains is SPAWNS, undetermined', async () => {
    space.file('package.json', JSON.stringify({ scripts: { build: 'tsc -b' } }));
    const probe = spawningProbe({
      host: 'host.cli',
      worktreeRoot: space.worktree,
      principalId: 'operator',
    });
    const result = await framework([probe]).classify('spawns_agents', 'script:build');
    assert.equal(
      result.value, 'SPAWNS',
      'a skill whose spawning behaviour cannot be determined is treated as spawning, and is '
      + 'therefore never selectable',
    );
    assert.equal(result.failed_closed, true);
  });

  test('a declared repository skill that says it does not spawn is believed', async () => {
    space.file('.agent/skills/lint.json', JSON.stringify({
      id: 'repo.lint',
      description: 'runs the linter',
      spawns_agents: false,
      mutating: false,
      external_destination: false,
    }));
    const probe = spawningProbe({
      host: 'host.cli',
      worktreeRoot: space.worktree,
      principalId: 'operator',
    });
    const result = await framework([probe]).classify('spawns_agents', 'repo.lint');
    assert.equal(result.value, 'DOES_NOT_SPAWN');
    assert.equal(result.confidence, 'FACT');
    assert.equal(result.failed_closed, false);
  });

  test('a skill nobody enumerated fails closed', async () => {
    const probe = spawningProbe({
      host: 'host.cli',
      worktreeRoot: space.worktree,
      principalId: 'operator',
    });
    const result = await framework([probe]).classify('spawns_agents', 'ghost.skill');
    assert.equal(result.value, 'SPAWNS');
    assert.equal(result.failed_closed, true);
  });
});

describe('every classification is a contract value', () => {
  test('each kind produces something the Classification schema accepts', async () => {
    const instance = framework([]);
    for (const kind of ['branch_protection', 'environment', 'observation_safety', 'spawns_agents'] as const) {
      const result: Classification = await instance.classify(kind, 'subject');
      validators.classification.parse(result, `${kind} classification`);
      assert.ok(result.probe_detail.length > 0, 'the record says why, always');
    }
  });
});
