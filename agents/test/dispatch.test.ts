import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtures as fx,
  SCHEMA_ID,
  SCHEMAS,
  type ContextSectionName,
  type DodCriterionId,
  type DodProfile,
  type DodProfileId,
  type EvidenceKind,
  type InputPackage,
} from '@intentra/contracts';
import { loadPolicies, type PolicySet } from '@intentra/policies';
import {
  buildInputPackage,
  materializeSections,
  unmaterializedSections,
  type DispatchRequest,
} from '../src/dispatch/input-package.js';
import { parseEnvelope } from '../src/dispatch/envelope.js';
import {
  renderDispatchBrief,
  renderSystemSpecification,
  responseSchema,
} from '../src/dispatch/brief.js';
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

function refsIn(node: unknown): string[] {
  if (node === null || typeof node !== 'object') return [];
  const own = (node as { $ref?: unknown }).$ref;
  return [
    ...(typeof own === 'string' ? [own] : []),
    ...Object.values(node).flatMap((child) => refsIn(child)),
  ];
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

  test('every dispatch is told its envelope_id must be new to the run and store-safe', () => {
    const input = buildInputPackage(request());
    const rendered = renderSystemSpecification(input, undefined);
    assert.match(rendered, /envelope_id is new to this run: never one in prior_envelopes/);
    assert.match(rendered, /at most 128 characters of letters, digits, _ \. and -, starting with a letter or digit/);
  });

  test('every dispatch is shown the schema the kernel validates its answer against', () => {
    const input = buildInputPackage(request());
    const spec = MVP_ROLE_SPECS.find((candidate) => candidate.mandate_name === 'audit');
    const rendered = renderSystemSpecification(input, spec);
    const [root] = responseSchema();
    /* The parser's schema itself, not a description of it: WP-8 attempt 1 was told field names only. */
    assert.equal(root?.[0], `${SCHEMA_ID['handoff-envelope']}#`);
    const { $defs: _defs, ...envelope } = SCHEMAS.get(SCHEMA_ID['handoff-envelope']);
    assert.deepEqual(root[1], envelope);
    for (const [label, schema] of responseSchema()) {
      assert.ok(rendered.includes(`${label} ${JSON.stringify(schema)}`), `${label} reaches the agent`);
    }
    assert.doesNotMatch(rendered, /Your proposal/, 'and the audit mandate owes no proposal');
  });

  test('the schema shown is closed: every $ref names a fragment that was also shown', () => {
    const labels = new Set(responseSchema().map(([label]) => label));
    for (const [label, schema] of responseSchema()) {
      const document = label.slice(0, label.indexOf('#'));
      for (const ref of refsIn(schema)) {
        const hash = ref.indexOf('#');
        const uri = hash === -1 ? ref : ref.slice(0, hash);
        const target = `${uri === '' ? document : new URL(uri, document).href}#`
          + (hash === -1 ? '' : ref.slice(hash + 1));
        assert.ok(labels.has(target), `${label} refers to ${ref}, which the agent was never shown`);
      }
    }
  });

  test('the resolution mandate is told its deliverable is proposals.work_item', () => {
    const spec = catalog.spec('context-discovery', 'resolution');
    assert.ok(spec !== undefined);
    const input = buildInputPackage(request({ spec, stage: 'RESOLUTION', workflow: null }));
    const role = MVP_ROLE_SPECS.find((candidate) => candidate.mandate_name === 'resolution');
    const rendered = renderSystemSpecification(input, role);
    assert.match(rendered, /deliverable is proposals\.work_item/);
    assert.match(rendered, /outputs\.proposed_work_item is the string "inline"/);
    assert.ok(
      responseSchema().some(([label]) => label === `${SCHEMA_ID['work-item']}#/$defs/proposedWorkItem`),
      'and the shape of a proposed Work Item is part of the schema shown',
    );
  });

  /* WP-8 smoke-2: the format rule sat before ~35 KB of schema, and the first answer opened with prose. */
  test('the prompt ends with a format reminder that comes after the whole schema', () => {
    const rendered = renderSystemSpecification(buildInputPackage(request()), undefined);
    const reminder = rendered.slice(rendered.lastIndexOf('Final reminder'));
    const lastSchema = responseSchema().at(-1);
    assert.ok(lastSchema !== undefined);
    assert.ok(
      rendered.indexOf(`${lastSchema[0]} ${JSON.stringify(lastSchema[1])}`) < rendered.lastIndexOf('Final reminder'),
      'the reminder follows every schema line',
    );
    assert.ok(rendered.trimEnd().endsWith(reminder.trimEnd()), 'and nothing follows the reminder');
    assert.match(reminder, /exactly one JSON object/);
    assert.match(reminder, /no introductory prose/);
    assert.match(reminder, /no Markdown code fence/);
    assert.match(reminder, /no commentary after it/);
    assert.match(reminder, /no field the schema does not define/);
  });

  test('the reminder names only the schema the prompt shows, and no field of it', () => {
    const rendered = renderSystemSpecification(buildInputPackage(request()), undefined);
    const reminder = rendered.slice(rendered.lastIndexOf('Final reminder'));
    const shown = new Set(responseSchema().map(([label]) => label));
    const named = reminder.match(/https?:\/\/\S+?#\S*/g) ?? [];
    assert.deepEqual(named.map((uri) => uri.replace(/[.,:;]$/, '')), [responseSchema()[0]?.[0]]);
    for (const uri of named) assert.ok(shown.has(uri.replace(/[.,:;]$/, '')), `${uri} is shown above it`);
    assert.ok(rendered.slice(0, rendered.lastIndexOf('Final reminder')).includes('Response schema'));
    const [, root] = responseSchema()[0] ?? [];
    const fields = Object.keys((root as { properties?: object } | undefined)?.properties ?? {});
    assert.ok(fields.length > 0);
    for (const field of fields) {
      assert.doesNotMatch(reminder, new RegExp(`\\b${field}\\b`), `the reminder does not restate ${field}`);
    }
  });

  /* WP-8 smoke-1: every excerpt mismatched because no dispatch was told where the replayed excerpt is shown. */
  test('every dispatch is told its evidence excerpt is the one its tool result showed, copied whole', () => {
    const rendered = renderSystemSpecification(buildInputPackage(request()), undefined);
    assert.match(rendered, /evidence excerpt \(JSON string\)/);
    assert.match(rendered, /copied whole and unchanged/);
    assert.match(rendered, /same operation and arguments/);
    assert.match(rendered, /read just those lines with read_file's lines argument/);
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

/** The kinds the rendered specification says criterion `criterion` accepts, read as the agent reads them. */
function shownKinds(rendered: string, criterion: DodCriterionId): readonly string[] | null {
  const line = new RegExp(`- criterion ${criterion} \\([^)]*\\): accepts ([a-z, ]+?)(?: in |[.;])`).exec(rendered);
  return line?.[1]?.split(', ') ?? null;
}

/** The audit dispatch's input, bound to `profile` and owing `owed`. */
function owing(profile: DodProfileId | null, owed: readonly DodCriterionId[]): InputPackage {
  return {
    ...buildInputPackage(request({ dod_profile_ref: profile === null ? null : `policies/dod/${profile}.json` })),
    dod_criteria_owed: [...owed],
  };
}

/** `base` with one profile's requirement for one criterion replaced, or removed where `kinds` is null. */
function withKinds(
  base: PolicySet,
  profileId: DodProfileId,
  criterion: DodCriterionId,
  kinds: readonly EvidenceKind[] | null,
): PolicySet {
  const change = (profile: DodProfile): DodProfile => {
    if (profile.profile_id !== profileId) return profile;
    const { [String(criterion)]: _replaced, ...rest } = profile.evidence_requirements;
    return {
      ...profile,
      evidence_requirements: kinds === null
        ? rest
        : { ...rest, [String(criterion)]: { kinds, note: 'altered for this test' } },
    };
  };
  return {
    ...base,
    dod: { ...base.dod, profiles: base.dod.profiles.map(change) },
    profile: (id) => change(base.profile(id)),
  };
}

describe('each owed criterion is shown the evidence kinds its profile accepts (Prompt 9)', () => {
  test('the audit dispatch is shown, for criteria 3 and 4, exactly the kinds profile audit accepts', () => {
    const input = buildInputPackage(request());
    assert.deepEqual([...input.dod_criteria_owed], [3, 4]);
    const rendered = renderSystemSpecification(input, undefined, policies);
    assert.match(rendered, /judged against DoD profile audit/);
    for (const criterion of input.dod_criteria_owed) {
      assert.deepEqual(
        shownKinds(rendered, criterion),
        policies.profile('audit').evidence_requirements[String(criterion)]?.kinds,
      );
    }
  });

  test('another profile and other criteria are shown their own kinds, not one fixed list', () => {
    const owed = [8, 12, 13];
    const rendered = renderSystemSpecification(owing('fix', owed), undefined, policies);
    assert.match(rendered, /judged against DoD profile fix/);
    const shown = owed.map((criterion) => shownKinds(rendered, criterion));
    assert.deepEqual(shown, owed.map((c) => policies.profile('fix').evidence_requirements[String(c)]?.kinds));
    assert.notDeepEqual(shown[1], shown[2], 'criteria 12 and 13 accept different kinds');
  });

  test('the kinds come from the policy set given: a changed requirement changes what is shown', () => {
    const rendered = renderSystemSpecification(
      buildInputPackage(request()), undefined, withKinds(policies, 'audit', 3, ['git']),
    );
    assert.deepEqual(shownKinds(rendered, 3), ['git']);
    assert.deepEqual(shownKinds(rendered, 4), policies.profile('audit').evidence_requirements['4']?.kinds);
  });

  test('a criterion the profile gives no accepted kind is shown that no MET can stand on it', () => {
    const rendered = renderSystemSpecification(
      buildInputPackage(request()), undefined, withKinds(policies, 'audit', 3, null),
    );
    assert.match(rendered, /- criterion 3 \([^)]*\): no kind is accepted by profile audit, so no MET can stand on it/);
    assert.equal(shownKinds(rendered, 3), null);
  });

  test('a criterion the bound profile does not include is shown that a verdict on it is not counted', () => {
    const rendered = renderSystemSpecification(owing('documentation', [3]), undefined, policies);
    assert.match(rendered, /- criterion 3 \([^)]*\): not a criterion of profile documentation, so no verdict on it is counted/);
    assert.equal(shownKinds(rendered, 3), null);
  });

  test('the context dispatch, before a profile is bound, is shown what every profile including criterion 1 accepts', () => {
    const spec = catalog.spec('context-discovery', 'context');
    assert.ok(spec !== undefined);
    const input = buildInputPackage(request({ spec, stage: 'CONTEXT_DISCOVERY', dod_profile_ref: null }));
    assert.deepEqual([...input.dod_criteria_owed], [1]);
    const rendered = renderSystemSpecification(input, undefined, policies);
    assert.match(rendered, /No DoD profile is bound to this dispatch yet/);
    const lists = new Set(policies.dod.profiles
      .filter((profile) => profile.criteria.includes(1))
      .map((profile) => JSON.stringify(profile.evidence_requirements['1']?.kinds)));
    assert.equal(lists.size, 1, 'every profile that includes criterion 1 accepts the same kinds today');
    assert.deepEqual(shownKinds(rendered, 1), JSON.parse([...lists][0] ?? 'null'));
    assert.match(rendered, /- criterion 1 \([^)]*\): accepts [a-z, ]+ in every profile that includes it\./);
  });

  test('where the profiles a run could select disagree, each list is shown with the profiles holding it', () => {
    const rendered = renderSystemSpecification(owing(null, [1]), undefined, withKinds(policies, 'fix', 1, ['ticket']));
    const others = policies.dod.profiles
      .filter((profile) => profile.profile_id !== 'fix' && profile.criteria.includes(1))
      .map((profile) => profile.profile_id)
      .sort();
    const kinds = policies.profile('documentation').evidence_requirements['1']?.kinds.join(', ');
    assert.match(rendered, new RegExp(
      `- criterion 1 \\([^)]*\\): accepts ${kinds} in profiles ${others.join(', ')}; ticket in profile fix\\.`,
    ));
  });

  test('a dispatch that owes no criterion is given no evidence requirements', () => {
    const spec = catalog.spec('context-discovery', 'resolution');
    assert.ok(spec !== undefined);
    const input = buildInputPackage(request({ spec, stage: 'RESOLUTION', workflow: null, dod_profile_ref: null }));
    assert.deepEqual([...input.dod_criteria_owed], []);
    assert.doesNotMatch(renderSystemSpecification(input, undefined, policies), /Evidence each owed criterion accepts/);
  });

  test('without the policy set, or with a profile it does not define, no kind is invented', () => {
    const unsupplied = renderSystemSpecification(buildInputPackage(request()), undefined);
    assert.match(unsupplied, /Evidence each owed criterion accepts/);
    assert.match(unsupplied, /cannot be stated for this dispatch: no policy set was supplied/);
    assert.equal(shownKinds(unsupplied, 3), null);
    const unknown = renderSystemSpecification(
      buildInputPackage(request({ dod_profile_ref: 'policies/dod/unheard-of.json' })), undefined, policies,
    );
    assert.match(unknown, /cannot be stated for this dispatch: policies\/dod\/unheard-of\.json names no profile in the policy set/);
    assert.equal(shownKinds(unknown, 3), null);
  });

  test('the agent is told to label evidence by what it is and never to relabel it', () => {
    const rendered = renderSystemSpecification(buildInputPackage(request()), undefined, policies);
    assert.match(rendered, /Label every evidence item by what it actually represents/);
    assert.match(rendered, /never relabel one to a kind a criterion accepts/);
  });

  test('the agent is told a MET needs an accepted kind and a VERIFIED replay, neither excusing the other', () => {
    const rendered = renderSystemSpecification(buildInputPackage(request()), undefined, policies);
    assert.match(rendered, /at least one cited item is of a kind the criterion accepts and its content replayed VERIFIED/);
    assert.match(rendered, /no cited item came back MISMATCH or UNREPLAYABLE/);
    assert.match(rendered, /An accepted kind does not excuse a failed replay, and a VERIFIED replay does not make an unaccepted kind count/);
  });

  test('screenshot VERIFIED is described as confirming the producing call, never the content', () => {
    const provenanceOnly = policies.evidence.comparators
      .filter((c) => c.comparator === 'not_kernel_verifiable')
      .map((c) => c.kind);
    assert.deepEqual(provenanceOnly, ['screenshot']);
    const rendered = renderSystemSpecification(owing('fix', [8]), undefined, policies);
    assert.match(rendered, /screenshot evidence is VERIFIED when [^\n]*That confirms the call, not what the item shows/);
    assert.match(rendered, /- criterion 8 \([^)]*\): accepts screenshot, http, command; screenshot never carries a MET by itself/);
  });

  test('unavailable or insufficient evidence is to be reported honestly, never fabricated or relabelled', () => {
    const rendered = renderSystemSpecification(buildInputPackage(request()), undefined, policies);
    assert.match(rendered, /Where the evidence a criterion needs is unavailable or insufficient, say so/);
    assert.match(rendered, /NOT_VALIDATED with the reason/);
    assert.match(rendered, /Never fabricate, relabel or stretch evidence to reach MET/);
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
    ['prose after JSON', '{"status":"COMPLETE"}\nThat is my answer.'],
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

  /* A-18. Every advertised name is refused, so there is no roster to get out of date. */
  const observed = (agents: readonly string[], tools = ['repo__list_files', 'repo__read_file']) =>
    ({ tools, agents, detail: '' });

  test('each of the four dispatch surfaces conforms with no agent advertised', () => {
    const descriptors = [fx.operationDescriptor()];
    assert.equal(MVP_ROLE_SPECS.length, 4);
    for (const spec of MVP_ROLE_SPECS) {
      const view = catalog.spec(spec.role, spec.mandate_name);
      assert.ok(view !== undefined, `${spec.role}/${spec.mandate_name}`);
      const roleGrants = grantsFor(view, descriptors);
      const label = `${spec.role}/${spec.mandate_name}`;

      const clean = evaluateSurface({
        substrate: 'x',
        grants: roleGrants,
        observed: { tools: roleGrants.map((g) => g.tool_name), agents: [], detail: '' },
        qualify: (n) => n,
      });
      assert.equal(clean.verdict, 'CONFORMS', label);
      assert.deepEqual([...clean.unexpected], [], label);

      /* And the same surface with one agent advertised fails, on every role alike. */
      const advertised = evaluateSurface({
        substrate: 'x',
        grants: roleGrants,
        observed: { tools: roleGrants.map((g) => g.tool_name), agents: ['claude'], detail: '' },
        qualify: (n) => n,
      });
      assert.equal(advertised.verdict, 'UNEXPECTED_TOOLS', label);
      assert.deepEqual([...advertised.unexpected], ['agent:claude'], label);
    }
  });

  test('no name is privileged: the comparison holds no allowlist and matches no pattern', () => {
    /* Names a Claude-specific allowlist or a prefix/case/fragment rule would have admitted. */
    const names = [
      'claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup', 'output-style-setup',
      'General-Purpose', 'general-purpose-2', 'general', 'claude-code-guide', 'web-fetch', '',
    ];
    for (const name of names) {
      const report = evaluateSurface({
        substrate: 'x', grants, observed: observed([name]), qualify: (n) => n,
      });
      assert.equal(report.verdict, 'UNEXPECTED_TOOLS', name);
      assert.deepEqual([...report.unexpected], [`agent:${name}`], name);
    }
  });

  test('an advertised name never rescues, and is never rescued by, the tool comparison', () => {
    /* An unexpected effective tool is still refused when nothing is advertised, ... */
    const widened = evaluateSurface({
      substrate: 'x',
      grants,
      observed: observed([], ['repo__read_file', 'repo__list_files', 'Read']),
      qualify: (n) => n,
    });
    assert.equal(widened.verdict, 'UNEXPECTED_TOOLS');
    assert.deepEqual([...widened.unexpected], ['Read']);

    /* ... a spawning tool is still refused on its own, ... */
    const spawning = evaluateSurface({
      substrate: 'x',
      grants,
      observed: observed([], ['repo__read_file', 'repo__list_files', 'Task']),
      qualify: (n) => n,
    });
    assert.equal(spawning.verdict, 'UNEXPECTED_TOOLS');
    assert.ok(spawning.unexpected.includes('Task'));

    /* ... and both halves are reported together rather than one masking the other. */
    const both = evaluateSurface({
      substrate: 'x',
      grants,
      observed: observed(['claude'], ['repo__read_file', 'repo__list_files', 'Task']),
      qualify: (n) => n,
    });
    assert.equal(both.verdict, 'UNEXPECTED_TOOLS');
    assert.deepEqual([...both.unexpected], ['Task', 'agent:claude']);
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
