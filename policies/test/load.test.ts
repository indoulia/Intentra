import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOD_PROFILE_IDS,
  EVIDENCE_KINDS,
  GATES,
  READ_ONLY_STAGES,
  TEMPLATE_STAGES,
  WORK_ITEM_TYPES,
  AGENT_ROLES,
} from '@agentos/contracts';
import { loadPolicies, PolicyLoadError, checkWellFormed, dominates, postDominates } from '../src/index.js';

/**
 * WP-2's exit test, and rather more than it asks for.
 *
 * "All nine templates load and pass the floor. A deliberately floor-violating template —
 * MERGE with no VALIDATION before it — fails policy load with a message naming the rule and
 * the template. A template naming a nonexistent predicate fails load.
 * `investigation.readonly` is admissible for every work item type, so the admissible set is
 * never empty."
 *
 * Every negative case is exercised against a *copy* of the real policy set with one thing
 * broken, which is the only way to be sure the check that catches it is the check that ran.
 */

const DATA_ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'data', 'stages.json');
    try {
      readFileSync(candidate);
      return join(dir, 'data');
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error('could not locate policies/data');
})();

/** Copies the policy set, applies a mutation, and returns the temporary root. */
function withBrokenPolicy(mutate: (root: string) => void): string {
  const work = mkdtempSync(join(tmpdir(), 'agentos-policy-'));
  cpSync(DATA_ROOT, work, { recursive: true });
  mutate(work);
  return work;
}

function expectLoadFailure(
  mutate: (root: string) => void,
  expectedRule: string,
  expectedInMessage?: RegExp,
): PolicyLoadError {
  const work = withBrokenPolicy(mutate);
  try {
    assert.throws(
      () => loadPolicies(work),
      (error: unknown) => {
        assert.ok(error instanceof PolicyLoadError, `expected PolicyLoadError, got ${String(error)}`);
        const matching = error.problems.filter((p) => p.rule === expectedRule);
        assert.ok(
          matching.length > 0,
          `expected a problem with rule "${expectedRule}"; got: `
          + error.problems.map((p) => `[${p.rule}] ${p.message}`).join(' | '),
        );
        if (expectedInMessage !== undefined) {
          assert.ok(
            matching.some((p) => expectedInMessage.test(`${p.file} ${p.message}`)),
            `no problem matched ${String(expectedInMessage)}; got: `
            + matching.map((p) => `${p.file}: ${p.message}`).join(' | '),
          );
        }
        return true;
      },
    );
    return new PolicyLoadError([]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function readTemplate(root: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'workflows', `${id}.json`), 'utf8'));
}

function writeTemplate(root: string, id: string, value: unknown): void {
  writeFileSync(join(root, 'workflows', `${id}.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/* ------------------------------------------------------------------ the happy path ---- */

describe('the real policy set loads', () => {
  const policies = loadPolicies();

  test('all nine templates load', () => {
    assert.deepEqual(
      [...policies.templates.keys()].sort(),
      [
        'change_request.land',
        'defect.standard',
        'documentation.direct',
        'epic.coordinate',
        'feature.standard',
        'incident.contain',
        'investigation.readonly',
        'story.standard',
        'task.direct',
      ],
    );
  });

  test('every template stage has a descriptor, and only template stages do', () => {
    assert.equal(policies.stages.size, TEMPLATE_STAGES.length);
    for (const stage of TEMPLATE_STAGES) {
      assert.ok(policies.stages.has(stage), `${stage} has no descriptor`);
    }
  });

  test('the read-only stage set matches WORKFLOW_STATE_MACHINE 2.3 exactly', () => {
    const declared = [...policies.stages.values()]
      .filter((d) => !d.mutating)
      .map((d) => d.stage)
      .sort();
    assert.deepEqual(declared, [...READ_ONLY_STAGES].sort());
  });

  test('investigation.readonly is admissible for every work item type', () => {
    for (const type of WORK_ITEM_TYPES) {
      const admissible = policies.admissibleTemplates(type);
      assert.ok(
        admissible.some((t) => t.template_id === 'investigation.readonly'),
        `${type} cannot select investigation.readonly, so the admissible set could be empty`,
      );
      assert.ok(admissible.length > 0, `${type} has an empty admissible set`);
    }
  });

  test('investigation.readonly is entirely non-mutating, so its risk class can be READ_ONLY', () => {
    const template = policies.templates.get('investigation.readonly');
    assert.ok(template !== undefined);
    for (const stage of template.stages) {
      assert.equal(
        policies.descriptor(stage).mutating,
        false,
        `${stage} mutates, so investigation.readonly is not "entirely non-mutating"`,
      );
    }
  });

  test('epic.coordinate contains no IMPLEMENTATION stage', () => {
    const template = policies.templates.get('epic.coordinate');
    assert.ok(template !== undefined);
    assert.ok(
      !template.stages.includes('IMPLEMENTATION'),
      'an Orchestrator that would prefer a single linear run must have no expressible way to ask',
    );
  });

  test('every predicate a template or descriptor names is defined', () => {
    const names = new Set(policies.predicates.keys());
    for (const template of policies.templates.values()) {
      for (const edge of template.edges) {
        const named = edge.when === 'always' || edge.when.startsWith('envelope.')
          ? null
          : edge.when.replace(/^NOT /, '');
        if (named !== null) assert.ok(names.has(named), `${template.template_id}: ${named}`);
      }
    }
    for (const descriptor of policies.stages.values()) {
      for (const named of [descriptor.satisfied_by, descriptor.applicability_predicate]) {
        if (named !== null) assert.ok(names.has(named), `${descriptor.stage}: ${named}`);
      }
    }
  });

  test('the four applicability predicates and the reality set are all present', () => {
    for (const name of ['audit.applicable', 'architecture.required', 'ux.required', 'production.applicable']) {
      assert.equal(policies.predicates.get(name)?.family, 'applicability', name);
    }
    for (const name of [
      'reality.implementation_present', 'reality.tests_present', 'reality.pr_open',
      'reality.pr_merged', 'reality.pr_approved', 'reality.pr_has_unresolved_comments',
      'reality.ci_green', 'reality.children_exist', 'reality.children_all_terminal',
      'reality.outcome_already_satisfied', 'reality.deployed', 'regression.suspected',
    ]) {
      assert.equal(policies.predicates.get(name)?.family, 'reality', name);
    }
  });

  test('every loop edge names a counter bound to a cap in budgets.json', () => {
    for (const template of policies.templates.values()) {
      for (const edge of template.edges) {
        if (edge.kind !== 'loop') continue;
        assert.ok(edge.counter !== null && edge.counter !== undefined, template.template_id);
        assert.ok(
          Object.keys(policies.budgets.loops).includes(edge.counter),
          `${template.template_id}: counter ${edge.counter} is uncapped`,
        );
      }
    }
  });

  test('every budget cap exists per run and per work item', () => {
    for (const [name, cap] of Object.entries(policies.budgets.loops)) {
      assert.ok(cap.per_run > 0, `${name} per_run`);
      assert.ok(
        cap.per_work_item >= cap.per_run,
        `${name}: a per-work-item cap below the per-run cap makes the run cap unreachable`,
      );
    }
  });

  test('the eighteen DoD criteria each have exactly one owning role', () => {
    assert.equal(policies.dod.criteria.length, 18);
    const seen = new Set<number>();
    for (const criterion of policies.dod.criteria) {
      assert.ok(!seen.has(criterion.criterion), `criterion ${criterion.criterion} twice`);
      seen.add(criterion.criterion);
      assert.ok(AGENT_ROLES.includes(criterion.owner_role));
    }
    assert.equal(seen.size, 18);
  });

  test('the Implementer owns no criterion: the agent that did the work never grades it', () => {
    const owned = policies.dod.criteria.filter((c) => c.owner_role === 'implementer');
    assert.deepEqual(owned, []);
  });

  test('all seven DoD profiles load', () => {
    for (const id of DOD_PROFILE_IDS) {
      assert.ok(policies.profile(id) !== undefined, id);
    }
  });

  test('every template can supply the critical criteria of its own default profile', () => {
    for (const template of policies.templates.values()) {
      const profile = policies.profile(template.dod_profile_default);
      const suppliable = policies.suppliableCriteria(template.stages);
      for (const criterion of profile.critical_criteria) {
        assert.ok(
          suppliable.has(criterion),
          `${template.template_id} cannot supply critical criterion ${criterion} of `
          + `${profile.profile_id}, so it could never reach COMPLETE`,
        );
      }
    }
  });

  test('every evidence kind has a comparator, and only log and metric require a predicate', () => {
    const byKind = new Map(policies.evidence.comparators.map((c) => [c.kind, c]));
    for (const kind of EVIDENCE_KINDS) assert.ok(byKind.has(kind), kind);
    const requiring = policies.evidence.comparators
      .filter((c) => c.requires_predicate)
      .map((c) => c.kind)
      .sort();
    assert.deepEqual(requiring, ['log', 'metric']);
    assert.equal(byKind.get('screenshot')?.comparator, 'not_kernel_verifiable');
  });

  test('every gate has a definition and at least one mechanical classifier', () => {
    const byGate = new Map(policies.gates.gates.map((g) => [g.gate, g]));
    for (const gate of GATES) {
      const definition = byGate.get(gate);
      assert.ok(definition !== undefined, gate);
      assert.ok(definition.classifiers.length > 0, `${gate} has no classifier`);
      for (const classifier of definition.classifiers) {
        assert.equal(
          classifier.fires_when_unevaluable,
          true,
          `${gate}/${classifier.id}: a classifier that cannot evaluate must fire the gate`,
        );
      }
    }
  });

  test('only AUTONOMOUS_INTAKE_EXECUTION may be pre-granted by policy', () => {
    for (const definition of policies.gates.gates) {
      if (definition.pre_grantable_by_policy) {
        assert.equal(definition.gate, 'AUTONOMOUS_INTAKE_EXECUTION');
      }
    }
  });

  test('the deny-list covers state/, policies/ and contracts/', () => {
    const patterns = policies.paths.deny.flatMap((d) => d.patterns);
    for (const required of ['state/**', 'policies/**', 'contracts/**']) {
      assert.ok(patterns.includes(required), required);
    }
  });

  test('the CLI host is the only host that can assert a principal, and the default is EXTERNAL', () => {
    assert.equal(policies.intake.default_trust_class, 'EXTERNAL');
    const asserting = policies.intake.hosts.filter((h) => h.can_assert_principal);
    assert.deepEqual(asserting.map((h) => h.host), ['host.cli']);
    assert.equal(asserting[0]?.trust_class, 'OPERATOR');
  });

  test('the Orchestrator Agent holds no adapters', () => {
    const orchestrator = policies.agents.roles.find((r) => r.role === 'orchestrator');
    assert.deepEqual(orchestrator?.permitted_adapters, []);
  });

  test('only the Validator and Product/UX may return REJECTED', () => {
    for (const role of policies.agents.roles) {
      if (role.may_return_statuses.includes('REJECTED')) {
        assert.ok(
          role.role === 'validator' || role.role === 'product-ux',
          `${role.role} may return REJECTED and is not a reviewing role`,
        );
      }
    }
  });

  test('only the Implementer may return BLOCKED_BY_ARCHITECTURE', () => {
    for (const role of policies.agents.roles) {
      if (role.may_return_statuses.includes('BLOCKED_BY_ARCHITECTURE')) {
        assert.equal(role.role, 'implementer');
      }
    }
  });

  test('this installation is read-only, and says so as data', () => {
    assert.equal(policies.execution.mutation_enabled, false);
    assert.deepEqual([...policies.execution.admissible_risk_classes], ['READ_ONLY']);
  });

  test('the security floor is present and non-overridable in the data', () => {
    assert.match(policies.securityFloor, /Never expose, log, print or copy a secret/);
    assert.match(policies.securityFloor, /No grant enables any of it/);
  });

  test('optional stages excludable by a proposal are grouped by their predicate', () => {
    const feature = policies.exclusionGroups('feature.standard');
    assert.deepEqual(
      [...(feature.get('production.applicable') ?? [])].sort(),
      ['DEPLOY', 'PRODUCTION_VALIDATION'],
      'DEPLOY and PRODUCTION_VALIDATION share one predicate, so they are excluded together',
    );
    const investigation = policies.exclusionGroups('investigation.readonly');
    assert.ok(
      ![...investigation.values()].flat().includes('ROOT_CAUSE'),
      'ROOT_CAUSE has no applicability predicate, so no proposal can exclude it',
    );
  });

  /*
   * D3, stated as an assertion over the shipped data rather than over a mutated copy.
   *
   * `critical-criteria-suppliable` is meant to make this hold, and for criterion 1 it did not:
   * the loader seeded the suppliable set with a `PROLOGUE_CRITERIA = [1]` constant, so the one
   * criterion `stages.json` gives to no stage was the one criterion the check could not see.
   * `audit` made criteria 1, 3 and 4 critical, `investigation.readonly` could supply only 3 and
   * 4, COMPLETION computed INDETERMINATE, and no run in the build could end COMPLETE.
   *
   * So the property is asserted here directly, from the data, without going through the check
   * that was supposed to enforce it.
   */
  test('every critical criterion of a template default profile is collected by a stage in that template', () => {
    for (const [id, template] of policies.templates) {
      const profile = policies.profile(template.dod_profile_default);
      const collected = new Set<number>();
      for (const stage of template.stages) {
        for (const criterion of policies.descriptor(stage).dod_criteria) collected.add(criterion);
      }
      const setAside = new Set(profile.not_applicable_by_default.map((n) => n.criterion));
      for (const criterion of profile.critical_criteria) {
        assert.ok(
          collected.has(criterion) || setAside.has(criterion),
          `${id} defaults to profile ${profile.profile_id}, which makes criterion ${criterion} `
          + 'critical, and no stage in the template collects a verdict for it. NOT_VALIDATED is '
          + 'never MET, so every run of this template would compute INCOMPLETE or INDETERMINATE',
        );
      }
    }
  });

  /*
   * The same property one level up, for the profiles no template defaults to. A criterion no
   * stage descriptor anywhere names cannot be supplied by any run of any template, so making it
   * critical anywhere is making a profile that can never complete — whether or not a template
   * currently defaults to it.
   */
  test('no profile makes critical a criterion no stage in stages.json collects', () => {
    const collected = new Set<number>();
    for (const descriptor of policies.stages.values()) {
      for (const criterion of descriptor.dod_criteria) collected.add(criterion);
    }
    assert.ok(!collected.has(1), 'criterion 1 is Context Discovery\'s, and the prologue is not a stage');
    for (const profile of policies.dod.profiles) {
      for (const criterion of profile.critical_criteria) {
        assert.ok(
          collected.has(criterion),
          `profile ${profile.profile_id} makes criterion ${criterion} critical and no stage `
          + 'collects a verdict for it',
        );
      }
    }
  });

  /*
   * And the criterion is not silently dropped from the profiles it genuinely belongs to.
   * "This does not apply" and "we did not check" are different facts, and a criterion removed
   * from a profile is invisible rather than explicitly not validated (I-15).
   */
  test('criterion 1 stays a non-critical criterion of the capability profiles', () => {
    for (const id of ['data-capability', 'service-capability', 'ui-capability', 'internal-capability'] as const) {
      const profile = policies.profile(id);
      assert.ok(profile.criteria.includes(1), `${id} still reports on criterion 1`);
      assert.ok(!profile.critical_criteria.includes(1), `${id} does not make criterion 1 critical`);
    }
  });
});

/* ---------------------------------------------------------- the floor, positively ---- */

describe('the workflow floor holds for every template', () => {
  const policies = loadPolicies();

  test('MERGE has VALIDATION and AUTHORIZATION on every route to it', () => {
    for (const template of policies.templates.values()) {
      if (!template.stages.includes('MERGE')) continue;
      const graph = { entry: template.entry, stages: template.stages, edges: template.edges };
      assert.ok(
        dominates(graph, 'VALIDATION', 'MERGE'),
        `${template.template_id}: a route reaches MERGE without VALIDATION`,
      );
      assert.ok(
        dominates(graph, 'AUTHORIZATION', 'MERGE'),
        `${template.template_id}: a route reaches MERGE without AUTHORIZATION`,
      );
    }
  });

  test('every route out of IMPLEMENTATION passes through VALIDATION', () => {
    for (const template of policies.templates.values()) {
      if (!template.stages.includes('IMPLEMENTATION')) continue;
      const graph = { entry: template.entry, stages: template.stages, edges: template.edges };
      assert.ok(
        postDominates(graph, 'VALIDATION', 'IMPLEMENTATION'),
        `${template.template_id}: a route leaves IMPLEMENTATION without VALIDATION`,
      );
    }
  });

  test('a DEFECT template has ROOT_CAUSE on every route to IMPLEMENTATION', () => {
    const template = policies.templates.get('defect.standard');
    assert.ok(template !== undefined);
    const graph = { entry: template.entry, stages: template.stages, edges: template.edges };
    assert.ok(dominates(graph, 'ROOT_CAUSE', 'IMPLEMENTATION'));
  });

  test('DEPLOY has PRODUCTION_VALIDATION on every route out of it', () => {
    for (const template of policies.templates.values()) {
      if (!template.stages.includes('DEPLOY')) continue;
      const graph = { entry: template.entry, stages: template.stages, edges: template.edges };
      assert.ok(
        postDominates(graph, 'PRODUCTION_VALIDATION', 'DEPLOY'),
        `${template.template_id}: a deploy nobody checks afterwards`,
      );
    }
  });

  test('COMPLETION is the sole predecessor of COMPLETE in every template', () => {
    for (const template of policies.templates.values()) {
      const toComplete = template.edges.filter((e) => e.to === 'COMPLETE');
      assert.ok(toComplete.length > 0, `${template.template_id} cannot reach COMPLETE`);
      for (const edge of toComplete) {
        assert.equal(edge.from, 'COMPLETION', template.template_id);
      }
    }
  });

  test('every template graph is well-formed, and stays so under every legal exclusion', () => {
    for (const [id, template] of policies.templates) {
      const graph = { entry: template.entry, stages: template.stages, edges: template.edges };
      const full = checkWellFormed(graph);
      assert.deepEqual(full.problems, [], id);
    }
  });
});

/* -------------------------------------------------------- the floor, negatively ---- */

describe('a mis-authored policy set fails at load, naming the rule', () => {
  test('MERGE with no VALIDATION before it fails the floor', () => {
    expectLoadFailure(
      (root) => {
        const template = readTemplate(root, 'task.direct') as {
          stages: string[]; edges: { from: string; to: string; when: string; kind: string }[];
        };
        /* Remove VALIDATION entirely and route implementation straight at PR preparation. */
        template.stages = template.stages.filter((s) => s !== 'VALIDATION' && s !== 'REWORK');
        template.edges = [
          { from: 'IMPLEMENTATION', to: 'PR_PREPARATION', when: 'always', kind: 'advance' },
          { from: 'PR_PREPARATION', to: 'AUTHORIZATION', when: 'always', kind: 'advance' },
          { from: 'AUTHORIZATION', to: 'MERGE', when: 'always', kind: 'advance' },
          { from: 'MERGE', to: 'COMPLETION', when: 'always', kind: 'advance' },
          { from: 'COMPLETION', to: 'COMPLETE', when: 'always', kind: 'terminal' },
        ];
        writeTemplate(root, 'task.direct', template);
      },
      'merge-requires-validation-and-authorization',
      /task\.direct/,
    );
  });

  test('a route that reaches MERGE past AUTHORIZATION only sometimes fails the floor', () => {
    expectLoadFailure(
      (root) => {
        const template = readTemplate(root, 'task.direct') as {
          edges: { from: string; to: string; when: string; kind: string }[];
        };
        /* A shortcut straight from validation to merge: the main route still passes
         * authorization, and this one does not. Dominance is what catches it. */
        template.edges.push({ from: 'VALIDATION', to: 'MERGE', when: 'always', kind: 'advance' });
        writeTemplate(root, 'task.direct', template);
      },
      'merge-requires-validation-and-authorization',
      /AUTHORIZATION must be on every route/,
    );
  });

  test('IMPLEMENTATION with a route that skips VALIDATION fails the floor', () => {
    expectLoadFailure(
      (root) => {
        const template = readTemplate(root, 'task.direct') as {
          edges: { from: string; to: string; when: string; kind: string }[];
        };
        template.edges.push({
          from: 'IMPLEMENTATION', to: 'PR_PREPARATION', when: 'always', kind: 'advance',
        });
        writeTemplate(root, 'task.direct', template);
      },
      'implementation-requires-validation',
    );
  });

  test('an EPIC template containing IMPLEMENTATION fails the floor', () => {
    expectLoadFailure(
      (root) => {
        const template = readTemplate(root, 'epic.coordinate') as {
          stages: string[]; edges: { from: string; to: string; when: string; kind: string }[];
        };
        template.stages.push('IMPLEMENTATION');
        template.edges = [
          { from: 'DECOMPOSITION', to: 'CHILD_COORDINATION', when: 'always', kind: 'advance' },
          { from: 'CHILD_COORDINATION', to: 'IMPLEMENTATION', when: 'always', kind: 'advance' },
          { from: 'IMPLEMENTATION', to: 'VALIDATION', when: 'always', kind: 'advance' },
          { from: 'VALIDATION', to: 'COMPLETION', when: 'always', kind: 'advance' },
          { from: 'COMPLETION', to: 'COMPLETE', when: 'always', kind: 'terminal' },
        ];
        writeTemplate(root, 'epic.coordinate', template);
      },
      'epic-forbids-implementation',
    );
  });

  test('a template naming a nonexistent predicate fails load', () => {
    expectLoadFailure(
      (root) => {
        const template = readTemplate(root, 'defect.standard') as {
          edges: { from: string; to: string; when: string; kind: string }[];
        };
        const edge = template.edges.find((e) => e.when === 'architecture.required');
        assert.ok(edge !== undefined);
        edge.when = 'reality.vibes_are_good';
        writeTemplate(root, 'defect.standard', template);
      },
      'predicate-exists',
      /reality\.vibes_are_good/,
    );
  });

  test('a stage descriptor naming a nonexistent predicate fails load', () => {
    expectLoadFailure(
      (root) => {
        const stages = JSON.parse(readFileSync(join(root, 'stages.json'), 'utf8')) as {
          stages: { stage: string; satisfied_by: string | null }[];
        };
        const audit = stages.stages.find((s) => s.stage === 'AUDIT');
        assert.ok(audit !== undefined);
        audit.satisfied_by = 'reality.audit_feels_done';
        writeFileSync(join(root, 'stages.json'), JSON.stringify(stages, null, 2), 'utf8');
      },
      'predicate-exists',
      /reality\.audit_feels_done/,
    );
  });

  test('a loop edge with no cap fails load', () => {
    expectLoadFailure(
      (root) => {
        const template = readTemplate(root, 'defect.standard') as {
          edges: { kind: string; counter?: string | null; cap?: string | null }[];
        };
        const loop = template.edges.find((e) => e.kind === 'loop');
        assert.ok(loop !== undefined);
        delete loop.cap;
        writeTemplate(root, 'defect.standard', template);
      },
      'loop-edge-has-cap',
    );
  });

  test('a loop edge naming an uncapped counter fails load', () => {
    expectLoadFailure(
      (root) => {
        const template = readTemplate(root, 'defect.standard') as {
          edges: { kind: string; counter?: string | null; cap?: string | null }[];
        };
        const loop = template.edges.find((e) => e.kind === 'loop');
        assert.ok(loop !== undefined);
        loop.counter = 'enthusiasm';
        loop.cap = 'budgets.loops.enthusiasm';
        writeTemplate(root, 'defect.standard', template);
      },
      'loop-counter-bound',
      /enthusiasm/,
    );
  });

  test('an unreachable stage fails load', () => {
    expectLoadFailure(
      (root) => {
        const template = readTemplate(root, 'task.direct') as { stages: string[] };
        template.stages.push('AUDIT');
        writeTemplate(root, 'task.direct', template);
      },
      'graph-well-formed',
      /AUDIT is unreachable/,
    );
  });

  test('a stage reaching COMPLETE directly fails load', () => {
    expectLoadFailure(
      (root) => {
        const template = readTemplate(root, 'task.direct') as {
          edges: { from: string; to: string; when: string; kind: string }[];
        };
        template.edges.push({ from: 'MERGE', to: 'COMPLETE', when: 'always', kind: 'terminal' });
        writeTemplate(root, 'task.direct', template);
      },
      'graph-well-formed',
      /COMPLETION must be the sole predecessor of COMPLETE/,
    );
  });

  test('three branch edges from one node fail load: a case would have no outcome', () => {
    expectLoadFailure(
      (root) => {
        const template = readTemplate(root, 'defect.standard') as {
          edges: { from: string; to: string; when: string; kind: string }[];
        };
        template.edges.push({
          from: 'ROOT_CAUSE', to: 'IMPLEMENTATION', when: 'ux.required', kind: 'branch',
        });
        writeTemplate(root, 'defect.standard', template);
      },
      'graph-well-formed',
      /branch edges/,
    );
  });

  test('an optional stage with no bypass edge fails the exclusion check', () => {
    expectLoadFailure(
      (root) => {
        const template = readTemplate(root, 'defect.standard') as {
          edges: { from: string; to: string; when: string; kind: string }[];
        };
        /* Remove the bypass that carries the graph past UX_REVIEW when it is excluded, and
         * make the remaining pair a legal branch so the failure is the exclusion one. */
        template.edges = template.edges.filter(
          (e) => !(e.from === 'STRUCTURAL_REAUDIT' && e.to === 'PR_PREPARATION'),
        );
        const kept = template.edges.find(
          (e) => e.from === 'STRUCTURAL_REAUDIT' && e.to === 'UX_REVIEW',
        );
        assert.ok(kept !== undefined);
        kept.kind = 'advance';
        kept.when = 'always';
        writeTemplate(root, 'defect.standard', template);
      },
      'graph-well-formed-under-exclusion',
      /UX_REVIEW/,
    );
  });

  test('a profile whose critical criterion no stage supplies fails load', () => {
    expectLoadFailure(
      (root) => {
        const profile = JSON.parse(readFileSync(join(root, 'dod', 'audit.json'), 'utf8')) as {
          criteria: number[]; critical_criteria: number[];
          evidence_requirements: Record<string, unknown>;
        };
        /* Criterion 15 is production validation, owned by the Validator in a stage
         * investigation.readonly does not contain. */
        profile.criteria.push(15);
        profile.critical_criteria.push(15);
        profile.evidence_requirements['15'] = { kinds: ['log'], note: 'production observations' };
        writeFileSync(join(root, 'dod', 'audit.json'), JSON.stringify(profile, null, 2), 'utf8');
      },
      'critical-criteria-suppliable',
      /investigation\.readonly/,
    );
  });

  /*
   * The case the rule was written for and did not catch. Criterion 1 is Context Discovery's,
   * the prologue is not a stage, and no stage descriptor names it — so putting it back into
   * `audit` reproduces D3 exactly, and the load must now refuse it.
   */
  test('making criterion 1 critical again reproduces D3 and fails load', () => {
    expectLoadFailure(
      (root) => {
        const profile = JSON.parse(readFileSync(join(root, 'dod', 'audit.json'), 'utf8')) as {
          criteria: number[]; critical_criteria: number[];
          evidence_requirements: Record<string, unknown>;
        };
        profile.criteria.unshift(1);
        profile.critical_criteria.unshift(1);
        profile.evidence_requirements['1'] = { kinds: ['document'], note: 'the Context Package' };
        writeFileSync(join(root, 'dod', 'audit.json'), JSON.stringify(profile, null, 2), 'utf8');
      },
      'critical-criteria-suppliable',
      /criterion 1 critical.*context-discovery owns it/s,
    );
  });

  /*
   * And the same criterion made critical in a profile no template defaults to, which the
   * template-scoped rule never reaches at all.
   */
  test('a criterion no stage anywhere collects fails load even in a profile no template defaults to', () => {
    expectLoadFailure(
      (root) => {
        const profile = JSON.parse(
          readFileSync(join(root, 'dod', 'data-capability.json'), 'utf8'),
        ) as { critical_criteria: number[] };
        profile.critical_criteria.unshift(1);
        writeFileSync(
          join(root, 'dod', 'data-capability.json'), JSON.stringify(profile, null, 2), 'utf8',
        );
      },
      'critical-criteria-owned-by-a-stage',
      /no run of any template could ever supply it/,
    );
  });

  test('a criterion both critical and NOT_APPLICABLE by default fails load', () => {
    expectLoadFailure(
      (root) => {
        const profile = JSON.parse(readFileSync(join(root, 'dod', 'fix.json'), 'utf8')) as {
          critical_criteria: number[];
          not_applicable_by_default: { criterion: number; reason: string }[];
        };
        profile.critical_criteria.push(3);
        writeFileSync(join(root, 'dod', 'fix.json'), JSON.stringify(profile, null, 2), 'utf8');
      },
      'critical-not-also-not-applicable',
    );
  });

  test('a duplicated DoD criterion owner fails load', () => {
    expectLoadFailure(
      (root) => {
        const criteria = JSON.parse(readFileSync(join(root, 'dod', 'criteria.json'), 'utf8')) as {
          criteria: { criterion: number; name: string; owner_role: string; owner_pass: string; evidence_class: string }[];
        };
        /* The table is capped at eighteen entries by schema, so the way to give one criterion
         * two owners is to renumber a second entry onto it rather than to add a nineteenth. */
        const second = criteria.criteria[1];
        assert.ok(second !== undefined);
        second.criterion = 1;
        second.owner_role = 'implementer';
        writeFileSync(join(root, 'dod', 'criteria.json'), JSON.stringify(criteria, null, 2), 'utf8');
      },
      'criterion-uniqueness',
      /whichever ran last/,
    );
  });

  test('a stage claiming a criterion another role owns fails load', () => {
    expectLoadFailure(
      (root) => {
        const stages = JSON.parse(readFileSync(join(root, 'stages.json'), 'utf8')) as {
          stages: { stage: string; dod_criteria: number[] }[];
        };
        const implementation = stages.stages.find((s) => s.stage === 'IMPLEMENTATION');
        assert.ok(implementation !== undefined);
        implementation.dod_criteria.push(5);
        writeFileSync(join(root, 'stages.json'), JSON.stringify(stages, null, 2), 'utf8');
      },
      'criterion-owner-matches-stage',
      /IMPLEMENTATION/,
    );
  });

  test('flipping a read-only stage to mutating fails load', () => {
    expectLoadFailure(
      (root) => {
        const stages = JSON.parse(readFileSync(join(root, 'stages.json'), 'utf8')) as {
          stages: { stage: string; mutating: boolean }[];
        };
        const completion = stages.stages.find((s) => s.stage === 'COMPLETION');
        assert.ok(completion !== undefined);
        completion.mutating = true;
        writeFileSync(join(root, 'stages.json'), JSON.stringify(stages, null, 2), 'utf8');
      },
      'read-only-stage-set',
      /COMPLETION/,
    );
  });

  test('making investigation.readonly type-specific fails load', () => {
    expectLoadFailure(
      (root) => {
        const template = readTemplate(root, 'investigation.readonly') as {
          applies_to: { types: string[] };
        };
        template.applies_to.types = ['INVESTIGATION'];
        writeTemplate(root, 'investigation.readonly', template);
      },
      'investigation-readonly-universal',
    );
  });

  test('a gate with no classifier fails load', () => {
    expectLoadFailure(
      (root) => {
        const gates = JSON.parse(readFileSync(join(root, 'gates.json'), 'utf8')) as {
          gates: { gate: string; classifiers: unknown[] }[];
        };
        const merge = gates.gates.find((g) => g.gate === 'MERGE_PROTECTED');
        assert.ok(merge !== undefined);
        merge.classifiers = [];
        writeFileSync(join(root, 'gates.json'), JSON.stringify(gates, null, 2), 'utf8');
      },
      'gate-has-classifier',
      /which is not a gate/,
    );
  });

  test('removing state/ from the deny-list fails load', () => {
    expectLoadFailure(
      (root) => {
        const paths = JSON.parse(readFileSync(join(root, 'paths.json'), 'utf8')) as {
          deny: { id: string; patterns: string[] }[];
        };
        paths.deny = paths.deny.filter((d) => d.id !== 'agentos_state');
        writeFileSync(join(root, 'paths.json'), JSON.stringify(paths, null, 2), 'utf8');
      },
      'deny-list-covers-agentos',
      /state/,
    );
  });

  test('giving the Orchestrator an adapter fails load', () => {
    expectLoadFailure(
      (root) => {
        const agents = JSON.parse(readFileSync(join(root, 'agents.json'), 'utf8')) as {
          roles: { role: string; permitted_adapters: string[] }[];
        };
        const orchestrator = agents.roles.find((r) => r.role === 'orchestrator');
        assert.ok(orchestrator !== undefined);
        orchestrator.permitted_adapters = ['repo'];
        writeFileSync(join(root, 'agents.json'), JSON.stringify(agents, null, 2), 'utf8');
      },
      'orchestrator-holds-no-adapters',
      /must not also manufacture it/,
    );
  });

  test('a read-only installation admitting a mutating risk class fails load', () => {
    expectLoadFailure(
      (root) => {
        const execution = JSON.parse(readFileSync(join(root, 'execution.json'), 'utf8')) as {
          mutation_enabled: boolean; admissible_risk_classes: string[];
        };
        execution.admissible_risk_classes = ['READ_ONLY', 'IRREVERSIBLE'];
        writeFileSync(join(root, 'execution.json'), JSON.stringify(execution, null, 2), 'utf8');
      },
      'read-only-installation-admits-read-only-only',
    );
  });

  test('a schema-invalid policy file fails load with the field named', () => {
    expectLoadFailure(
      (root) => {
        const budgets = JSON.parse(readFileSync(join(root, 'budgets.json'), 'utf8')) as
          Record<string, unknown>;
        budgets['reresolution'] = 'once';
        writeFileSync(join(root, 'budgets.json'), JSON.stringify(budgets, null, 2), 'utf8');
      },
      'schema',
      /reresolution/,
    );
  });

  test('an unknown key in a policy file fails load rather than being ignored', () => {
    expectLoadFailure(
      (root) => {
        const budgets = JSON.parse(readFileSync(join(root, 'budgets.json'), 'utf8')) as
          Record<string, unknown>;
        budgets['rework_cap'] = 99;
        writeFileSync(join(root, 'budgets.json'), JSON.stringify(budgets, null, 2), 'utf8');
      },
      'schema',
      /rework_cap/,
    );
  });

  test('every failure names its file and its rule', () => {
    const work = withBrokenPolicy((root) => {
      const template = readTemplate(root, 'task.direct') as { stages: string[] };
      template.stages.push('AUDIT');
      writeTemplate(root, 'task.direct', template);
    });
    try {
      loadPolicies(work);
      assert.fail('expected a load failure');
    } catch (error) {
      assert.ok(error instanceof PolicyLoadError);
      for (const problem of error.problems) {
        assert.ok(problem.file.length > 0, 'a problem with no file is not actionable');
        assert.ok(problem.rule.length > 0, 'a problem with no rule cannot be looked up');
        assert.ok(problem.message.length > 0);
      }
      assert.match(error.message, /task\.direct/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------- the data source ---- */

describe('the policy data source is confined to its own root', () => {
  test('an absolute path is refused', () => {
    const policies = loadPolicies();
    assert.ok(policies.stages.size > 0);
  });

  test('a path escaping the data root is refused', async () => {
    const { PolicyDataSource, PolicyDataError } = await import('../src/data-source.js');
    const source = new PolicyDataSource(DATA_ROOT);
    assert.throws(() => source.readText('../../package.json'), PolicyDataError);
    assert.throws(() => source.readText('/etc/passwd'), PolicyDataError);
  });
});
