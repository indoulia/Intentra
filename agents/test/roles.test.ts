import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx, type AdapterOperationDescriptor } from '@agentos/contracts';
import { loadPolicies } from '@agentos/policies';
import {
  AgentCatalogError,
  MvpAgentCatalog,
  orchestratorChoices,
  reachableStages,
} from '../src/roles/catalog.js';
import { MVP_ROLE_SPECS } from '../src/roles/specs.js';
import { ToolGrantError, grantsFor, isSpawningToolName, toolNameFor } from '../src/dispatch/tool-grants.js';
import { specView } from './doubles.js';

/**
 * The three MVP roles, as specifications the policy set agrees with.
 *
 * Most of these are consistency tests rather than behaviour tests, and that is deliberate:
 * the failure mode a role specification actually has is drift — an agent told to produce one
 * set of outputs while the stage it runs in exits on another, or a criterion nobody owes so
 * it stays NOT_VALIDATED forever. Neither shows up as an exception; both show up as a run
 * that cannot complete for reasons nobody can locate.
 */

const policies = loadPolicies();
const catalog = new MvpAgentCatalog(policies);

describe('the MVP catalog', () => {
  test('carries exactly the three roles a read-only milestone dispatches', () => {
    const roles = new Set(catalog.all().map((spec) => spec.role));
    assert.deepEqual([...roles].sort(), ['auditor', 'context-discovery', 'orchestrator']);
    assert.equal(catalog.all().length, 4, 'Context Discovery carries two mandates');
  });

  test('Context Discovery is dispatched twice, with different mandates', () => {
    const resolution = catalog.spec('context-discovery', 'resolution');
    const context = catalog.spec('context-discovery', 'context');
    assert.ok(resolution !== undefined && context !== undefined);
    assert.notDeepEqual(resolution.required_outputs, context.required_outputs);
    assert.ok(resolution.required_outputs.includes('proposed_work_item'));
    assert.ok(context.required_outputs.includes('current_reality'));
  });

  test('every MVP role is read-only, and says so from policy rather than from here', () => {
    for (const spec of catalog.all()) {
      assert.equal(spec.read_only, true, `${spec.role} must be read-only in milestone 1`);
      const fromPolicy = policies.agents.roles.find((entry) => entry.role === spec.role);
      assert.equal(spec.read_only, fromPolicy?.read_only);
      assert.deepEqual([...spec.permitted_adapters], [...(fromPolicy?.permitted_adapters ?? [])]);
    }
  });

  test('the Orchestrator holds no adapters', () => {
    const spec = catalog.spec('orchestrator', 'orchestration');
    assert.ok(spec !== undefined);
    assert.deepEqual([...spec.permitted_adapters], []);
    assert.deepEqual([...spec.dod_criteria_owned], []);
  });

  test('the criteria owed are the ones the policy assigns, per pass', () => {
    assert.deepEqual([...(catalog.spec('context-discovery', 'context')?.dod_criteria_owned ?? [])], [1]);
    assert.deepEqual([...(catalog.spec('auditor', 'audit')?.dod_criteria_owned ?? [])], [3, 4]);
    /* Resolution runs before a workflow, so there is no profile for a verdict to count
     * against and it owes none. */
    assert.deepEqual([...(catalog.spec('context-discovery', 'resolution')?.dod_criteria_owned ?? [])], []);
  });

  test('the Auditor first pass agrees with the AUDIT stage descriptor', () => {
    const spec = catalog.spec('auditor', 'audit');
    const stage = policies.stages.get('AUDIT');
    assert.ok(spec !== undefined && stage !== undefined);
    assert.deepEqual([...spec.required_outputs].sort(), [...stage.required_outputs].sort());
    assert.deepEqual([...spec.dod_criteria_owned].sort(), [...stage.dod_criteria].sort());
  });

  test('a mandate whose outputs drift from its stage is refused at construction', () => {
    const drifted = MVP_ROLE_SPECS.map((spec) => (
      spec.mandate_name === 'audit'
        ? { ...spec, required_outputs: ['capability_graph'] }
        : spec
    ));
    assert.throws(
      () => new MvpAgentCatalog(policies, drifted),
      (error: unknown) => error instanceof AgentCatalogError && /stage AUDIT requires/.test(error.message),
    );
  });

  test('a role the policy set does not describe is refused rather than defaulted', () => {
    const stripped = {
      ...policies,
      agents: {
        ...policies.agents,
        roles: policies.agents.roles.filter((entry) => entry.role !== 'auditor'),
      },
    };
    assert.throws(
      () => new MvpAgentCatalog(stripped),
      (error: unknown) => error instanceof AgentCatalogError && /no stated adapter set/.test(error.message),
    );
  });

  test('two specifications for one mandate are refused', () => {
    const first = MVP_ROLE_SPECS[0];
    assert.ok(first !== undefined);
    assert.throws(() => new MvpAgentCatalog(policies, [first, first]), AgentCatalogError);
  });

  test('an unknown mandate is undefined, not a default', () => {
    assert.equal(catalog.spec('auditor', 'structural_reaudit'), undefined);
    assert.equal(catalog.spec('implementer', 'implementation'), undefined);
  });
});

describe('what the model requirements ask for', () => {
  test('the resolution dispatch is mid context at high precision', () => {
    const spec = catalog.spec('context-discovery', 'resolution');
    assert.ok(spec !== undefined);
    assert.equal(spec.model_requirement.context, 'medium');
    assert.equal(spec.model_requirement.reasoning, 'mid');
    assert.equal(spec.model_requirement.precision, 'high');
  });

  test('the audit dispatch is deep reasoning at high precision', () => {
    const spec = catalog.spec('auditor', 'audit');
    assert.ok(spec !== undefined);
    assert.equal(spec.model_requirement.reasoning, 'deep');
    assert.equal(spec.model_requirement.precision, 'high');
  });

  test('the Orchestrator needs no tool use, because it holds no adapters', () => {
    const spec = catalog.spec('orchestrator', 'orchestration');
    assert.equal(spec?.model_requirement.tool_use, 'none');
  });

  test('no specification names a model; the registries rank and the kernel selects', () => {
    const text = JSON.stringify(MVP_ROLE_SPECS);
    assert.ok(!/claude-/i.test(text), 'a role specification must not hard-code a model id');
  });
});

describe('the Orchestrator\'s choices, derived from policy', () => {
  test('are exactly three while the milestone is read-only', () => {
    assert.deepEqual([...orchestratorChoices(policies)], ['arbitration', 'dispatch', 'workflow']);
  });

  test('exclude the stages no admissible template contains', () => {
    const reachable = reachableStages(policies);
    assert.ok(reachable.has('AUDIT'));
    assert.ok(reachable.has('WORKFLOW_SELECTED'), 'the prologue always runs');
    assert.ok(!reachable.has('REVIEW_TRIAGE'), 'no read-only template contains a pull request');
    assert.ok(!reachable.has('CHILD_COORDINATION'), 'child coordination mutates');
    assert.ok(!reachable.has('IMPLEMENTATION'));
  });

  test('become four the day something mutates', () => {
    const mutating = { ...policies, execution: { ...policies.execution, mutation_enabled: true } };
    const choices = orchestratorChoices(mutating);
    assert.ok(choices.includes('authorization_request'));
    assert.ok(choices.length > 3, 'a gate that can fire is a draft request that can be made');
  });
});

/* ------------------------------------------------------------------- the tool surface ---- */

const REPO_READ = fx.operationDescriptor();
const REPO_LIST = fx.operationDescriptor({ op: 'list_files', description: 'list files' });
const REPO_WRITE = fx.operationDescriptor({ op: 'write_file', mutating: true, observation_safe: false });
const GIT_LOG = fx.operationDescriptor({ adapter: 'git', op: 'log', description: 'read commits' });
const PM_ISSUE = fx.operationDescriptor({ adapter: 'pm', op: 'read_issue', description: 'read an issue' });

const DESCRIPTORS: readonly AdapterOperationDescriptor[] = [
  REPO_READ, REPO_LIST, REPO_WRITE, GIT_LOG, PM_ISSUE,
];

describe('grants are an allowlist built from policy and descriptors', () => {
  test('a read-only role never receives a mutating operation', () => {
    const grants = grantsFor(specView({ permitted_adapters: ['repo'] }), DESCRIPTORS);
    assert.deepEqual(grants.map((g) => g.tool_name), ['repo__list_files', 'repo__read_file']);
    assert.ok(!grants.some((g) => g.op === 'write_file'));
  });

  test('a mutating role could receive one, so the read-only flag is what excludes it', () => {
    const grants = grantsFor(
      specView({ permitted_adapters: ['repo'], read_only: false }),
      DESCRIPTORS,
    );
    assert.ok(grants.some((g) => g.op === 'write_file'));
  });

  test('an adapter the role does not hold is absent rather than denied', () => {
    const grants = grantsFor(specView({ permitted_adapters: ['repo', 'git'] }), DESCRIPTORS);
    assert.deepEqual([...new Set(grants.map((g) => g.adapter))].sort(), ['git', 'repo']);
  });

  test('the Orchestrator receives nothing at all', () => {
    const spec = catalog.spec('orchestrator', 'orchestration');
    assert.ok(spec !== undefined);
    assert.deepEqual(grantsFor(spec, DESCRIPTORS), []);
  });

  test('every MVP role, granted against real descriptors, receives only read-only operations', () => {
    for (const spec of catalog.all()) {
      for (const granted of grantsFor(spec, DESCRIPTORS)) {
        const descriptor = DESCRIPTORS.find(
          (d) => d.adapter === granted.adapter && d.op === granted.op,
        );
        assert.equal(descriptor?.mutating, false, `${granted.tool_name} mutates`);
      }
    }
  });

  test('the argument schema is the adapter\'s own, passed through unchanged', () => {
    const grants = grantsFor(specView({ permitted_adapters: ['repo'] }), [REPO_READ]);
    assert.deepEqual(grants[0]?.args_schema, REPO_READ.args_schema);
    assert.equal(grants[0]?.description, REPO_READ.description);
  });

  test('an operation that would be exposed as a way to spawn an agent is refused', () => {
    const spawner = fx.operationDescriptor({ adapter: 'host', op: 'spawn_agent' });
    assert.throws(
      () => grantsFor(specView({ permitted_adapters: ['host'] }), [spawner]),
      (error: unknown) => error instanceof ToolGrantError && /start another agent/.test(error.message),
    );
  });

  test('a tool name collision is refused rather than silently deduplicated', () => {
    const twin = fx.operationDescriptor({ description: 'a second operation with one name' });
    assert.throws(
      () => grantsFor(specView({ permitted_adapters: ['repo'] }), [REPO_READ, twin]),
      ToolGrantError,
    );
  });

  test('the same inputs produce the same allowlist, in the same order', () => {
    const spec = specView({ permitted_adapters: ['repo', 'git', 'pm'] });
    assert.deepEqual(grantsFor(spec, DESCRIPTORS), grantsFor(spec, [...DESCRIPTORS].reverse()));
  });

  test('names are predictable, and spawning names are recognized wherever they appear', () => {
    assert.equal(toolNameFor('repo', 'read_file'), 'repo__read_file');
    assert.equal(isSpawningToolName('repo__read_file'), false);
    assert.equal(isSpawningToolName('pm__create_task'), false, 'creating a ticket starts nothing');
    assert.equal(isSpawningToolName('Task'), true);
    assert.equal(isSpawningToolName('agent'), true);
    assert.equal(isSpawningToolName('host__spawn_agent'), true);
    assert.equal(isSpawningToolName('run__subagent_now'), true);
  });
});
