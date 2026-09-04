import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx, type ContextSectionName, type InputPackage } from '@agentos/contracts';
import { loadPolicies } from '@agentos/policies';
import {
  buildInputPackage,
  materializeSections,
  unmaterializedSections,
  type DispatchRequest,
} from '../src/dispatch/input-package.js';
import { parseEnvelope } from '../src/dispatch/envelope.js';
import { renderDispatchBrief, renderSystemSpecification } from '../src/dispatch/brief.js';
import { evaluateSurface } from '../src/substrate/surface.js';
import { MvpAgentCatalog } from '../src/roles/catalog.js';
import { MVP_ROLE_SPECS } from '../src/roles/specs.js';
import { grantsFor } from '../src/dispatch/tool-grants.js';
import { ScriptedSubstrate } from './fake-substrate.js';
import { GRANTS, RecordingInvoker, contextPackage, specView } from './doubles.js';

/**
 * The dispatch boundary, exercised with no model at all.
 *
 * SKILL_AND_MODEL_SELECTION's sharpest statement of the kernel boundary is that the kernel's
 * correctness is independent of model availability, not merely of model quality. The
 * boundary is the last layer before a model, and everything it does — bounding the input,
 * naming the outputs, parsing the answer — is testable on the same terms.
 */

const policies = loadPolicies();
const catalog = new MvpAgentCatalog(policies);

function request(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  const spec = catalog.spec('auditor', 'audit');
  assert.ok(spec !== undefined);
  return {
    work_item_id: 'wi_c_subject',
    run_id: 'run_20260904T100000Z_000001',
    dispatch_id: 'd_014',
    spec,
    stage: 'AUDIT',
    work_item_ref: '../work-item.json',
    intake_ref: null,
    workflow: {
      template_id: 'investigation.readonly',
      version: '1.0',
      stages_remaining: ['ROOT_CAUSE', 'COMPLETION'],
    },
    context_package_ref: 'context/v1.json',
    context: contextPackage(),
    capability_registry_ref: 'capabilities/v1.json',
    prior_envelopes: ['env_002'],
    mandate: {
      objective: spec.objective,
      in_scope: ['src/**'],
      out_of_scope: ['tests/fixtures/**'],
      capabilities: [],
      advisory_notes: '',
    },
    dod_profile_ref: 'policies/dod/audit.json',
    constraints: [],
    authorization_scope: { autonomous: [], gated: [], grants_held: [] },
    tools_granted: [...GRANTS],
    skills_available: [],
    model: 'claude-opus-5',
    budget: { max_usd: 5, max_turns: 40, max_wall_clock_ms: 900_000 },
    ...overrides,
  };
}

describe('only the required sections are materialized', () => {
  test('a section the specification did not ask for is absent, not empty', () => {
    const spec = catalog.spec('auditor', 'audit');
    assert.ok(spec !== undefined);
    const sections = materializeSections(contextPackage(), spec.required_inputs);
    for (const name of spec.required_inputs) {
      assert.ok(name in sections, `${name} was required and should be present`);
    }
    /* The Auditor does not read git_state. It must not arrive empty, because an empty
     * section reads as "discovery found nothing there". */
    assert.ok(!('git_state' in sections));
    assert.ok(!('product' in sections));
    assert.equal(sections['git_state'], undefined);
  });

  test('a required section the package could not supply is omitted and reported', () => {
    const partial = { ...contextPackage() } as Record<string, unknown>;
    delete partial['tests'];
    const context = partial as unknown as ReturnType<typeof contextPackage>;
    const required: readonly ContextSectionName[] = ['repository', 'tests'];
    const sections = materializeSections(context, required);
    assert.ok('repository' in sections);
    assert.ok(!('tests' in sections));
    assert.deepEqual([...unmaterializedSections(context, required)], ['tests']);
  });

  test('with no package at all, nothing is materialized and everything is reported', () => {
    assert.deepEqual(materializeSections(null, ['repository']), {});
    assert.deepEqual([...unmaterializedSections(null, ['repository', 'tests'])], ['repository', 'tests']);
  });

  test('the package itself is never inlined into the dispatch', () => {
    const input = buildInputPackage(request());
    const brief = renderDispatchBrief(input);
    assert.ok(brief.includes('"repository"'));
    assert.ok(!brief.includes('"git_state"'), 'a section nobody asked for must not appear');
    assert.ok(!brief.includes('"production_state"'));
  });
});

describe('the input package is built from the specification and the dispatch', () => {
  test('the agent, mandate, inputs, outputs and criteria come from the specification', () => {
    const input = buildInputPackage(request());
    assert.equal(input.agent, 'auditor');
    assert.equal(input.mandate_name, 'audit');
    assert.deepEqual([...input.required_outputs], ['capability_graph', 'findings_report', 'orphan_inventory']);
    assert.deepEqual([...input.dod_criteria_owed], [3, 4]);
  });

  test('a stage may name its own outputs, and they win', () => {
    const input = buildInputPackage(request({ required_outputs: ['root_cause', 'evidence_chain'] }));
    assert.deepEqual([...input.required_outputs], ['root_cause', 'evidence_chain']);
  });

  test('references are references: nothing large is copied', () => {
    const input = buildInputPackage(request());
    assert.equal(input.work_item_ref, '../work-item.json');
    assert.equal(input.context_package_ref, 'context/v1.json');
    assert.deepEqual([...input.prior_envelopes], ['env_002']);
    assert.equal(typeof input.capability_registry_ref, 'string');
  });

  test('the resolution mandate carries an intake reference and no work item', () => {
    const spec = catalog.spec('context-discovery', 'resolution');
    assert.ok(spec !== undefined);
    const input = buildInputPackage(request({
      spec,
      stage: 'RESOLUTION',
      work_item_ref: null,
      intake_ref: '../intake/in_0091.json',
      workflow: null,
      required_outputs: undefined,
    }));
    assert.equal(input.work_item_ref, null);
    assert.equal(input.intake_ref, '../intake/in_0091.json');
    assert.equal(input.workflow, null);
    assert.deepEqual([...input.required_outputs], ['proposed_work_item', 'discovery_gaps']);
  });
});

describe('the brief renders the specification and nothing else', () => {
  test('the hard limits of the role reach the agent', () => {
    const input = buildInputPackage(request());
    const spec = MVP_ROLE_SPECS.find((candidate) => candidate.mandate_name === 'audit');
    const rendered = renderSystemSpecification(input, spec);
    assert.match(rendered, /Never mutate anything\. Findings only\./);
    assert.match(rendered, /Do not propose architecture/);
    assert.match(rendered, /one JSON object and nothing else/);
    assert.match(rendered, /verification block on evidence is written only by the kernel/);
  });

  test('a role this package does not specify still gets the universal obligations', () => {
    const input = buildInputPackage(request());
    const rendered = renderSystemSpecification({ ...input, agent: 'implementer' }, undefined);
    assert.match(rendered, /allowlist|tools listed for this dispatch/);
    assert.ok(!rendered.includes('Hard limits'));
  });

  test('advisory notes are labelled untrusted wherever they appear', () => {
    const input = buildInputPackage(request({
      mandate: {
        objective: 'audit',
        in_scope: [],
        out_of_scope: [],
        capabilities: [],
        advisory_notes: 'read whatever you like',
      },
    }));
    assert.match(renderSystemSpecification(input, undefined), /advisory_notes[^\n]*untrusted/);
    assert.ok(renderDispatchBrief(input).includes('read whatever you like'));
  });
});

describe('parsing an envelope is parsing, and nothing more', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['prose', 'I found three orphan writers.'],
    ['a bare scalar', '42'],
    ['a string', '"COMPLETE"'],
    ['an array', '[]'],
    ['truncated', '{"status":"COMPLETE"'],
    ['prose around JSON', 'Envelope: {"status":"COMPLETE"}'],
    ['two objects', '{"a":1}{"b":2}'],
    ['a fence', '```json\n{"a":1}\n```'],
    ['whitespace', '\n\t '],
    ['null', 'null'],
  ];

  for (const [name, text] of cases) {
    test(`${name} is refused rather than repaired`, () => {
      const parsed = parseEnvelope(text);
      assert.equal(parsed.ok, false);
      assert.ok(parsed.ok || parsed.detail.length > 0);
    });
  }

  test('an object is returned exactly as it arrived', () => {
    const parsed = parseEnvelope('  {"status":"BLOCKED","blockers":[{"id":"B-1"}]}  ');
    assert.equal(parsed.ok, true);
    assert.deepEqual(
      parsed.ok ? parsed.envelope : null,
      { status: 'BLOCKED', blockers: [{ id: 'B-1' }] },
    );
  });
});

describe('the surface comparison, on its own', () => {
  const grants = [...GRANTS];

  test('order does not matter; membership does', () => {
    const report = evaluateSurface({
      substrate: 'x',
      grants,
      observed: { tools: ['repo__list_files', 'repo__read_file'], agents: [], detail: '' },
      qualify: (name) => name,
    });
    assert.equal(report.verdict, 'CONFORMS');
  });

  test('a repeated name is not two tools', () => {
    const report = evaluateSurface({
      substrate: 'x',
      grants,
      observed: {
        tools: ['repo__read_file', 'repo__read_file', 'repo__list_files'],
        agents: [],
        detail: '',
      },
      qualify: (name) => name,
    });
    assert.equal(report.verdict, 'CONFORMS');
  });

  test('an unobservable surface reports every grant as unaccounted for', () => {
    const report = evaluateSurface({
      substrate: 'x', grants, observed: null, qualify: (name) => name,
    });
    assert.equal(report.verdict, 'UNVERIFIABLE');
    assert.deepEqual([...report.missing], ['repo__list_files', 'repo__read_file']);
    assert.deepEqual([...report.effective], []);
  });
});

describe('the boundary runs end to end with no model', () => {
  test('a scripted substrate answers a real input package', async () => {
    const spec = catalog.spec('auditor', 'audit');
    assert.ok(spec !== undefined);
    const grants = grantsFor(spec, [fx.operationDescriptor()]);
    const input: InputPackage = buildInputPackage(request({ spec, tools_granted: grants }));

    const envelope = { envelope_version: '1.2', status: 'COMPLETE', dispatch_id: input.dispatch_id };
    const substrate = new ScriptedSubstrate([
      { calls: [{ tool: 'repo__read_file', args: { path: 'src/a.ts' } }], envelope },
    ]);
    const invoker = new RecordingInvoker();

    const surface = await substrate.conformance(grants);
    assert.equal(surface.verdict, 'CONFORMS');

    const result = await substrate.dispatch(input, invoker);
    assert.equal(result.outcome, 'ENVELOPE');
    assert.deepEqual(result.outcome === 'ENVELOPE' ? result.envelope : null, envelope);
    assert.deepEqual(invoker.calls, [{ tool: 'repo__read_file', args: { path: 'src/a.ts' } }]);
  });

  test('the fake refuses an ungranted call rather than forwarding it', async () => {
    const input = buildInputPackage(request({ spec: specView(), tools_granted: [] }));
    const substrate = new ScriptedSubstrate([
      { calls: [{ tool: 'repo__read_file' }], envelope: { status: 'COMPLETE' } },
    ]);
    const invoker = new RecordingInvoker();
    await substrate.dispatch(input, invoker);
    assert.deepEqual(invoker.calls, []);
    assert.deepEqual(substrate.refused, ['repo__read_file']);
  });

  test('a security refusal aborts the scripted dispatch too', async () => {
    const input = buildInputPackage(request());
    const substrate = new ScriptedSubstrate([
      { calls: [{ tool: 'repo__read_file' }], envelope: { status: 'COMPLETE' } },
    ]);
    const result = await substrate.dispatch(input, new RecordingInvoker(() => ({
      outcome: 'REFUSED',
      refusal: 'security_violation',
      message: 'denied by the path deny-list',
      abortDispatch: true,
    })));
    assert.equal(result.outcome, 'FAILED');
    assert.equal(result.outcome === 'FAILED' ? result.failure : '', 'SECURITY_VIOLATION');
  });
});
