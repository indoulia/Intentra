import {
  AGENT_ROLES,
  DOD_PROFILE_IDS,
  EVIDENCE_KINDS,
  GATES,
  READ_ONLY_STAGES,
  TEMPLATE_STAGES,
  WORK_ITEM_TYPES,
  formatErrors,
  validators,
} from '@agentos/contracts';
import type {
  AgentPolicy,
  BudgetPolicy,
  DodCriterionId,
  DodPolicySet,
  DodProfile,
  DodProfileId,
  EvidencePolicy,
  ExecutionPolicy,
  GatePolicy,
  IntakePolicy,
  PathPolicy,
  PredicateDefinition,
  StageDescriptor,
  TemplateStage,
  WorkItemPolicy,
  WorkItemType,
  WorkflowEdge,
  WorkflowFloor,
  WorkflowTemplate,
} from '@agentos/contracts';
import { PolicyDataSource } from './data-source.js';
import {
  checkWellFormed,
  dominates,
  exclusionSubsets,
  postDominates,
  predicateOf,
  withoutStages,
  type GraphView,
} from './graph.js';

/**
 * The policy loader.
 *
 * Every behaviour the design calls policy exists as data, and a mis-authored policy fails
 * loudly at startup rather than quietly during a run. That is the whole reason this file is
 * as long as it is: referential integrity over the policy set is cheap, model-free, and
 * catches exactly the authoring errors that would otherwise surface mid-run — a template
 * naming a predicate nobody wrote, a loop edge with no cap, a profile demanding a verdict no
 * stage in its template owns.
 *
 * A failure names the rule and the file. "Policy failed to load" is not an actionable
 * message; "defect.standard violates merge-requires-validation-and-authorization" is.
 */

export interface PolicyProblem {
  /** The file the problem is in, relative to `policies/data`. */
  readonly file: string;
  /** The rule that was violated, named so it can be looked up. */
  readonly rule: string;
  readonly message: string;
}

export class PolicyLoadError extends Error {
  constructor(readonly problems: readonly PolicyProblem[]) {
    super(
      `${problems.length} policy problem(s):\n`
      + problems.map((p) => `  [${p.rule}] ${p.file}: ${p.message}`).join('\n'),
    );
    this.name = 'PolicyLoadError';
  }
}

export interface PolicySet {
  readonly stages: ReadonlyMap<TemplateStage, StageDescriptor>;
  readonly templates: ReadonlyMap<string, WorkflowTemplate>;
  readonly floor: WorkflowFloor;
  readonly predicates: ReadonlyMap<string, PredicateDefinition>;
  readonly workItems: WorkItemPolicy;
  readonly intake: IntakePolicy;
  readonly evidence: EvidencePolicy;
  readonly budgets: BudgetPolicy;
  readonly paths: PathPolicy;
  readonly gates: GatePolicy;
  readonly dod: DodPolicySet;
  readonly agents: AgentPolicy;
  readonly execution: ExecutionPolicy;
  readonly securityFloor: string;

  /** Templates whose `applies_to` admits this work item type. */
  admissibleTemplates(type: WorkItemType): readonly WorkflowTemplate[];
  descriptor(stage: TemplateStage): StageDescriptor;
  profile(id: DodProfileId): DodProfile;
  /** Stages a proposal may exclude, grouped by the predicate whose `FALSE` excludes them. */
  exclusionGroups(templateId: string): ReadonlyMap<string, readonly TemplateStage[]>;
  /** Which criteria the roles owning these stages can supply, plus the prologue's. */
  suppliableCriteria(stages: readonly TemplateStage[]): ReadonlySet<DodCriterionId>;
}

/** Criteria the prologue supplies, whatever template is selected. */
const PROLOGUE_CRITERIA: readonly DodCriterionId[] = [1];

export function loadPolicies(root?: string): PolicySet {
  const source = new PolicyDataSource(root);
  const problems: PolicyProblem[] = [];

  const fail = (file: string, rule: string, message: string): void => {
    problems.push({ file, rule, message });
  };

  /* ---------------------------------------------------------- schema conformance ---- */

  function parse<T>(
    file: string,
    validator: { check(v: unknown): { valid: boolean; errors: readonly unknown[] }; parse(v: unknown, label?: string): T },
    value: unknown,
  ): T | null {
    const result = validator.check(value);
    if (!result.valid) {
      fail(file, 'schema', formatErrors(result.errors as never));
      return null;
    }
    return value as T;
  }

  const stageSet = parse(
    'stages.json', validators.stageSet, source.readJson('stages.json'),
  );
  const floor = parse(
    'workflow-floor.json', validators.workflowFloor, source.readJson('workflow-floor.json'),
  );
  const predicateSet = parse(
    'predicates.json', validators.predicateSet, source.readJson('predicates.json'),
  );
  const workItems = parse(
    'work-items.json', validators.workItemPolicy, source.readJson('work-items.json'),
  );
  const intake = parse(
    'intake.json', validators.intakePolicy, source.readJson('intake.json'),
  );
  const evidence = parse(
    'evidence.json', validators.evidencePolicy, source.readJson('evidence.json'),
  );
  const budgets = parse(
    'budgets.json', validators.budgetPolicy, source.readJson('budgets.json'),
  );
  const paths = parse('paths.json', validators.pathPolicy, source.readJson('paths.json'));
  const gates = parse('gates.json', validators.gatePolicy, source.readJson('gates.json'));
  const agents = parse('agents.json', validators.agentPolicy, source.readJson('agents.json'));
  const execution = parse(
    'execution.json', validators.executionPolicy, source.readJson('execution.json'),
  );

  const templates = new Map<string, WorkflowTemplate>();
  for (const file of source.listJson('workflows')) {
    const raw = source.readJson(file);
    const template = parse(file, validators.workflowTemplate, raw);
    if (template === null) continue;
    const expectedFile = `workflows/${template.template_id}.json`;
    if (file !== expectedFile) {
      fail(file, 'template-file-name', `declares template_id ${template.template_id}, so it belongs at ${expectedFile}`);
    }
    if (templates.has(template.template_id)) {
      fail(file, 'template-uniqueness', `template_id ${template.template_id} is declared twice`);
    }
    templates.set(template.template_id, template);
  }

  /* The DoD set is assembled from a criteria table and one file per profile. */
  const criteriaFile = source.readJson('dod/criteria.json') as { version?: unknown; criteria?: unknown };
  const profiles: DodProfile[] = [];
  for (const file of source.listJson('dod')) {
    if (file === 'dod/criteria.json') continue;
    const profile = parse(file, validators.dodProfile, source.readJson(file));
    if (profile === null) continue;
    if (file !== `dod/${profile.profile_id}.json`) {
      fail(file, 'profile-file-name', `declares profile_id ${profile.profile_id}`);
    }
    profiles.push(profile);
  }
  const dod = parse('dod/', validators.dodPolicySet, {
    version: criteriaFile.version,
    criteria: criteriaFile.criteria,
    profiles,
  });

  const securityFloor = source.readText('security-floor.md');
  if (securityFloor.trim().length === 0) {
    fail('security-floor.md', 'security-floor-present', 'the security floor statement is empty');
  }

  if (
    stageSet === null || floor === null || predicateSet === null || workItems === null
    || intake === null || evidence === null || budgets === null || paths === null
    || gates === null || agents === null || execution === null || dod === null
  ) {
    throw new PolicyLoadError(problems);
  }

  /* -------------------------------------------------- indexes and derived lookups ---- */

  const descriptors = new Map<TemplateStage, StageDescriptor>();
  for (const descriptor of stageSet.stages) {
    if (descriptors.has(descriptor.stage)) {
      fail('stages.json', 'stage-uniqueness', `${descriptor.stage} is declared twice`);
    }
    descriptors.set(descriptor.stage, descriptor);
  }
  for (const stage of TEMPLATE_STAGES) {
    if (!descriptors.has(stage)) {
      fail('stages.json', 'stage-coverage', `${stage} has no descriptor`);
    }
  }

  const predicates = new Map<string, PredicateDefinition>();
  for (const predicate of predicateSet.predicates) {
    if (predicates.has(predicate.name)) {
      fail('predicates.json', 'predicate-uniqueness', `${predicate.name} is declared twice`);
    }
    predicates.set(predicate.name, predicate);
  }

  const profileById = new Map<DodProfileId, DodProfile>();
  for (const profile of dod.profiles) profileById.set(profile.profile_id, profile);
  for (const id of DOD_PROFILE_IDS) {
    if (!profileById.has(id)) fail('dod/', 'profile-coverage', `profile ${id} is missing`);
  }

  const criterionOwner = new Map<DodCriterionId, DodPolicySet['criteria'][number]>();
  for (const criterion of dod.criteria) {
    if (criterionOwner.has(criterion.criterion)) {
      fail('dod/criteria.json', 'criterion-uniqueness',
        `criterion ${criterion.criterion} is declared twice, so it would be decided by whichever ran last`);
    }
    criterionOwner.set(criterion.criterion, criterion);
  }
  for (let i = 1; i <= 18; i += 1) {
    if (!criterionOwner.has(i)) {
      fail('dod/criteria.json', 'criterion-coverage', `criterion ${i} has no owning role`);
    }
  }

  /** Which stages a role owns, from the stage descriptors. */
  const stagesByRole = new Map<string, TemplateStage[]>();
  for (const descriptor of descriptors.values()) {
    const list = stagesByRole.get(descriptor.default_agent) ?? [];
    list.push(descriptor.stage);
    stagesByRole.set(descriptor.default_agent, list);
  }

  function suppliableCriteria(stages: readonly TemplateStage[]): ReadonlySet<DodCriterionId> {
    const set = new Set<DodCriterionId>(PROLOGUE_CRITERIA);
    for (const stage of stages) {
      const descriptor = descriptors.get(stage);
      if (descriptor === undefined) continue;
      for (const criterion of descriptor.dod_criteria) set.add(criterion);
    }
    return set;
  }

  function exclusionGroups(templateId: string): ReadonlyMap<string, readonly TemplateStage[]> {
    const template = templates.get(templateId);
    const groups = new Map<string, TemplateStage[]>();
    if (template === undefined) return groups;
    for (const stage of template.optional_stages) {
      const descriptor = descriptors.get(stage);
      /*
       * An optional stage with no applicability predicate has nothing the kernel could
       * evaluate FALSE, so no proposal can exclude it. That is deliberate for
       * investigation.readonly's ROOT_CAUSE: the COMPLETION-only parameterization of
       * WORKFLOW_STATE_MACHINE 5.3 is admitted by the kernel from observed reality, never
       * proposed by an agent.
       */
      const predicate = descriptor?.applicability_predicate;
      if (predicate === null || predicate === undefined) continue;
      const list = groups.get(predicate) ?? [];
      list.push(stage);
      groups.set(predicate, list);
    }
    return groups;
  }

  /* ---------------------------------------------------- referential integrity ---- */

  /* Read-only stages must be exactly the set the state machine names. The contract layer
   * states it and the policy data declares it per stage; a disagreement is a policy defect
   * and it fails here rather than producing a run that gates the wrong thing. */
  const declaredReadOnly = new Set(
    [...descriptors.values()].filter((d) => !d.mutating).map((d) => d.stage),
  );
  const expectedReadOnly = new Set(READ_ONLY_STAGES);
  for (const stage of expectedReadOnly) {
    if (!declaredReadOnly.has(stage)) {
      fail('stages.json', 'read-only-stage-set',
        `${stage} is read-only in WORKFLOW_STATE_MACHINE 2.3 and mutating here`);
    }
  }
  for (const stage of declaredReadOnly) {
    if (!expectedReadOnly.has(stage)) {
      fail('stages.json', 'read-only-stage-set',
        `${stage} is declared non-mutating here and is not in the read-only set of WORKFLOW_STATE_MACHINE 2.3`);
    }
  }

  for (const descriptor of descriptors.values()) {
    for (const named of [descriptor.satisfied_by, descriptor.applicability_predicate]) {
      if (named === null) continue;
      if (!predicates.has(named)) {
        fail('stages.json', 'predicate-exists',
          `${descriptor.stage} names predicate ${named}, which predicates.json does not define`);
      }
    }
    for (const criterion of descriptor.dod_criteria) {
      if (!criterionOwner.has(criterion)) {
        fail('stages.json', 'criterion-exists',
          `${descriptor.stage} supplies criterion ${criterion}, which has no owning role`);
      } else {
        const owner = criterionOwner.get(criterion);
        if (owner !== undefined && owner.owner_role !== descriptor.default_agent) {
          fail('stages.json', 'criterion-owner-matches-stage',
            `${descriptor.stage} is owned by ${descriptor.default_agent} but supplies criterion `
            + `${criterion}, which ${owner.owner_role} owns`);
        }
      }
    }
    for (const gate of descriptor.gates_possible) {
      if (!GATES.includes(gate)) {
        fail('stages.json', 'gate-exists', `${descriptor.stage} names unknown gate ${gate}`);
      }
    }
  }

  const loopCounters = Object.keys(budgets.loops);
  for (const [id, template] of templates) {
    const file = `workflows/${id}.json`;
    const included = new Set<TemplateStage>(template.stages);

    if (!included.has(template.entry)) {
      fail(file, 'entry-included', `entry ${template.entry} is not in stages`);
    }
    for (const stage of template.stages) {
      if (!descriptors.has(stage)) {
        fail(file, 'stage-exists', `names stage ${stage}, which stages.json does not describe`);
      }
    }
    for (const stage of template.optional_stages) {
      if (!included.has(stage)) {
        fail(file, 'optional-stage-included', `optional stage ${stage} is not in stages`);
      }
    }
    for (const edge of template.edges) {
      const named = predicateOf(edge.when);
      if (named !== null && !predicates.has(named)) {
        fail(file, 'predicate-exists',
          `edge ${edge.from} -> ${edge.to} names predicate ${named}, which predicates.json does not define`);
      }
      if (edge.kind === 'loop') {
        if (edge.counter === null || edge.counter === undefined) {
          fail(file, 'loop-edge-has-counter',
            `loop edge ${edge.from} -> ${edge.to} names no counter, so it is an unbounded loop`);
        } else if (!loopCounters.includes(edge.counter)) {
          fail(file, 'loop-counter-bound',
            `loop edge ${edge.from} -> ${edge.to} names counter ${edge.counter}, which budgets.json does not cap`);
        }
        const cap = edge.cap;
        if (cap === null || cap === undefined) {
          fail(file, 'loop-edge-has-cap', `loop edge ${edge.from} -> ${edge.to} names no cap`);
        } else if (!cap.startsWith('budgets.loops.') || !loopCounters.includes(cap.slice('budgets.loops.'.length))) {
          fail(file, 'loop-cap-resolves',
            `loop edge ${edge.from} -> ${edge.to} names cap ${cap}, which does not resolve in budgets.json`);
        }
      }
      if (edge.kind === 'escalate' && edge.to !== 'BLOCKED') {
        fail(file, 'escalate-goes-to-blocked',
          `escalate edge ${edge.from} -> ${edge.to} must end at BLOCKED`);
      }
      if (edge.kind === 'terminal' && edge.to !== 'COMPLETE' && edge.to !== 'CANCELLED') {
        fail(file, 'terminal-goes-to-terminal-state',
          `terminal edge ${edge.from} -> ${edge.to} must end at COMPLETE or CANCELLED`);
      }
    }

    /* Well-formedness of the full template, and of every graph a legal exclusion produces. */
    const graph: GraphView = {
      entry: template.entry, stages: template.stages, edges: template.edges,
    };
    for (const problem of checkWellFormed(graph).problems) {
      fail(file, 'graph-well-formed', problem);
    }
    const groups = [...exclusionGroups(id).values()];
    for (const excluded of exclusionSubsets(groups)) {
      if (excluded.size === 0) continue;
      const reduced = withoutStages(graph, excluded);
      for (const problem of checkWellFormed(reduced).problems) {
        fail(file, 'graph-well-formed-under-exclusion',
          `excluding {${[...excluded].join(', ')}}: ${problem}`);
      }
    }

    /* The floor, on the full template. The parameterized instance is checked again at run
     * start; this catches the authoring error before any run exists. */
    for (const problem of checkFloor(floor, template, descriptors)) {
      fail(file, problem.rule, problem.message);
    }

    /* A template must be able to supply the critical criteria of its own default profile.
     * A profile demanding a verdict no stage in the template owns is a profile that can
     * never reach COMPLETE, and the failure would look like a mysterious INCOMPLETE. */
    const profile = profileById.get(template.dod_profile_default);
    if (profile === undefined) {
      fail(file, 'profile-exists',
        `dod_profile_default ${template.dod_profile_default} is not a defined profile`);
    } else {
      const suppliable = suppliableCriteria(template.stages);
      const notApplicable = new Set(
        profile.not_applicable_by_default.map((n) => n.criterion),
      );
      for (const criterion of profile.critical_criteria) {
        if (notApplicable.has(criterion)) {
          fail(`dod/${profile.profile_id}.json`, 'critical-not-also-not-applicable',
            `criterion ${criterion} is both critical and NOT_APPLICABLE by default`);
          continue;
        }
        if (!suppliable.has(criterion)) {
          const owner = criterionOwner.get(criterion);
          fail(file, 'critical-criteria-suppliable',
            `profile ${profile.profile_id} makes criterion ${criterion} critical, and no stage `
            + `in this template supplies it (${owner?.owner_role ?? 'unknown'} owns it)`);
        }
      }
    }
  }

  for (const profile of dod.profiles) {
    const file = `dod/${profile.profile_id}.json`;
    const declared = new Set(profile.criteria);
    for (const criterion of profile.criteria) {
      if (!criterionOwner.has(criterion)) {
        fail(file, 'criterion-exists', `names criterion ${criterion}, which has no owning role`);
      }
      if (!(String(criterion) in profile.evidence_requirements)) {
        fail(file, 'evidence-requirement-per-criterion',
          `criterion ${criterion} has no evidence requirement, so MET would have no required strength`);
      }
    }
    for (const criterion of profile.critical_criteria) {
      if (!declared.has(criterion)) {
        fail(file, 'critical-criteria-declared',
          `criterion ${criterion} is critical and not in this profile's criteria`);
      }
    }
    for (const entry of profile.not_applicable_by_default) {
      if (entry.reason.trim().length === 0) {
        fail(file, 'not-applicable-needs-reason',
          `criterion ${entry.criterion} is NOT_APPLICABLE with no reason, which is how a profile marks an inconvenient criterion away`);
      }
    }
    for (const type of profile.applies_when.work_item_types) {
      if (type !== '*' && !WORK_ITEM_TYPES.includes(type)) {
        fail(file, 'work-item-type-exists', `applies_when names unknown work item type ${type}`);
      }
    }
  }

  /* Every floor rule's predicate must exist. */
  for (const rule of floor.rules) {
    if (rule.trigger.kind === 'predicate_true' && !predicates.has(rule.trigger.predicate)) {
      fail('workflow-floor.json', 'predicate-exists',
        `rule ${rule.id} triggers on predicate ${rule.trigger.predicate}, which predicates.json does not define`);
    }
    if (rule.requires.length === 0 && rule.forbids.length === 0) {
      fail('workflow-floor.json', 'floor-rule-does-something',
        `rule ${rule.id} requires nothing and forbids nothing`);
    }
  }

  /* investigation.readonly must be admissible for every work item type, so the admissible
   * set is never empty and the fallback always has something to fall back to. */
  const investigation = templates.get('investigation.readonly');
  if (investigation === undefined) {
    fail('workflows/', 'investigation-readonly-exists',
      'investigation.readonly is missing; the admissible set could then be empty and the kernel '
      + 'would be choosing between guessing and refusing');
  } else if (!investigation.applies_to.types.includes('*')) {
    fail('workflows/investigation.readonly.json', 'investigation-readonly-universal',
      'applies_to must be ["*"]: it is the fallback for every work item type');
  }

  /* Work item types: each exactly once, each candidate profile defined. */
  const seenTypes = new Set<WorkItemType>();
  for (const entry of workItems.types) {
    if (seenTypes.has(entry.type)) {
      fail('work-items.json', 'work-item-type-uniqueness', `${entry.type} is declared twice`);
    }
    seenTypes.add(entry.type);
    for (const profile of entry.candidate_dod_profiles) {
      if (!profileById.has(profile)) {
        fail('work-items.json', 'profile-exists',
          `${entry.type} names candidate profile ${profile}, which is not defined`);
      }
    }
    if (entry.satisfied_by !== 'NONE' && entry.minimum_evidence.length === 0) {
      fail('work-items.json', 'evidence-minimum-present',
        `${entry.type} requires ${entry.satisfied_by} of an empty evidence list`);
    }
  }
  for (const type of WORK_ITEM_TYPES) {
    if (!seenTypes.has(type)) {
      fail('work-items.json', 'work-item-type-coverage', `${type} has no evidence minimum`);
    }
  }

  /* Evidence comparators: one per kind, and a predicate required exactly where the kernel
   * re-evaluates one rather than comparing a value. */
  const comparatorKinds = new Set(evidence.comparators.map((c) => c.kind));
  for (const kind of EVIDENCE_KINDS) {
    if (!comparatorKinds.has(kind)) {
      fail('evidence.json', 'comparator-coverage', `evidence kind ${kind} has no comparator`);
    }
  }
  for (const comparator of evidence.comparators) {
    const wantsPredicate = comparator.comparator === 'predicate_reevaluation';
    if (comparator.requires_predicate !== wantsPredicate) {
      fail('evidence.json', 'predicate-requirement-matches-comparator',
        `${comparator.kind} uses ${comparator.comparator} and requires_predicate is `
        + `${comparator.requires_predicate}`);
    }
  }
  if (evidence.sample_minimum_per_envelope < 1) {
    fail('evidence.json', 'sample-minimum',
      'at least one item per envelope must be verified, or an envelope of uncritical evidence is never checked at all');
  }

  /* Gates: every gate defined, every classifier fail-closed. */
  const gateById = new Set(gates.gates.map((g) => g.gate));
  for (const gate of GATES) {
    if (!gateById.has(gate)) fail('gates.json', 'gate-coverage', `gate ${gate} has no definition`);
  }
  for (const definition of gates.gates) {
    if (definition.classifiers.length === 0) {
      fail('gates.json', 'gate-has-classifier',
        `${definition.gate} has no classifier, so it would fire only when an agent volunteers — which is not a gate`);
    }
    if (definition.pre_grantable_by_policy && definition.gate !== 'AUTONOMOUS_INTAKE_EXECUTION') {
      fail('gates.json', 'pre-grant-restricted',
        `${definition.gate} is marked pre-grantable; only AUTONOMOUS_INTAKE_EXECUTION may be`);
    }
  }

  /* The absolute deny-list must cover the AgentOS-owned areas. Rule 3 of path confinement is
   * the backstop that holds when the worktree root or the mandate scope is computed wrongly,
   * so an incomplete deny-list removes the backstop. */
  const denyPatterns = paths.deny.flatMap((entry) => entry.patterns);
  for (const required of ['state/**', 'policies/**', 'contracts/**']) {
    if (!denyPatterns.includes(required)) {
      fail('paths.json', 'deny-list-covers-agentos',
        `the deny-list does not cover ${required}`);
    }
  }

  /* Agent policy: every role exactly once, every proposal stage real. */
  const seenRoles = new Set<string>();
  for (const role of agents.roles) {
    if (seenRoles.has(role.role)) {
      fail('agents.json', 'role-uniqueness', `${role.role} is declared twice`);
    }
    seenRoles.add(role.role);
    for (const [key, stages] of Object.entries(role.proposal_stages)) {
      if (!role.may_propose.includes(key as never)) {
        fail('agents.json', 'proposal-stage-matches-may-propose',
          `${role.role} restricts stages for proposal ${key}, which it may not make`);
      }
      for (const stage of stages ?? []) {
        if (stage === '*') continue;
        if (!TEMPLATE_STAGES.includes(stage as TemplateStage)
          && !['RESOLUTION', 'CONTEXT_DISCOVERY', 'UNDERSTOOD', 'WORKFLOW_SELECTED', 'INTAKE_RECEIVED'].includes(stage)) {
          fail('agents.json', 'stage-exists', `${role.role} names unknown stage ${stage}`);
        }
      }
    }
    for (const key of role.may_propose) {
      if (!(key in role.proposal_stages)) {
        fail('agents.json', 'may-propose-has-stages',
          `${role.role} may propose ${key} and declares no stage restriction for it; "*" says so explicitly`);
      }
    }
    if (role.role === 'orchestrator' && role.permitted_adapters.length > 0) {
      fail('agents.json', 'orchestrator-holds-no-adapters',
        'the Orchestrator Agent holds no adapters: the component that judges evidence must not also manufacture it');
    }
  }
  for (const role of AGENT_ROLES) {
    if (!seenRoles.has(role)) fail('agents.json', 'role-coverage', `${role} has no policy`);
  }

  /* Execution policy: a read-only installation must actually admit only read-only runs. */
  if (!execution.mutation_enabled) {
    const classes = [...execution.admissible_risk_classes];
    if (classes.length !== 1 || classes[0] !== 'READ_ONLY') {
      fail('execution.json', 'read-only-installation-admits-read-only-only',
        `mutation_enabled is false and admissible_risk_classes is [${classes.join(', ')}]`);
    }
  }

  if (problems.length > 0) throw new PolicyLoadError(problems);

  const templatesByType = new Map<WorkItemType, WorkflowTemplate[]>();
  for (const type of WORK_ITEM_TYPES) {
    templatesByType.set(
      type,
      [...templates.values()]
        .filter((t) => t.applies_to.types.includes('*') || t.applies_to.types.includes(type))
        .sort((a, b) => a.template_id.localeCompare(b.template_id)),
    );
  }

  return {
    stages: descriptors,
    templates,
    floor,
    predicates,
    workItems,
    intake,
    evidence,
    budgets,
    paths,
    gates,
    dod,
    agents,
    execution,
    securityFloor,
    admissibleTemplates: (type) => templatesByType.get(type) ?? [],
    descriptor: (stage) => {
      const descriptor = descriptors.get(stage);
      if (descriptor === undefined) throw new Error(`no descriptor for stage ${stage}`);
      return descriptor;
    },
    profile: (id) => {
      const profile = profileById.get(id);
      if (profile === undefined) throw new Error(`no DoD profile ${id}`);
      return profile;
    },
    exclusionGroups,
    suppliableCriteria,
  };
}

/**
 * The workflow floor, applied to a graph. Exported because the kernel applies the same rules
 * to a parameterized instance at run start, and two implementations of one rule is one
 * implementation too many.
 */
export function checkFloor(
  floor: WorkflowFloor,
  graph: {
    readonly entry: TemplateStage;
    readonly stages: readonly TemplateStage[];
    readonly edges: readonly WorkflowEdge[];
    readonly applies_to?: { readonly types: readonly string[] };
  },
  _descriptors: ReadonlyMap<TemplateStage, StageDescriptor>,
  context: {
    readonly workItemType?: WorkItemType;
    readonly predicateValues?: ReadonlyMap<string, 'TRUE' | 'FALSE' | 'INDETERMINATE'>;
  } = {},
): readonly { readonly rule: string; readonly message: string }[] {
  const problems: { rule: string; message: string }[] = [];
  const included = new Set<TemplateStage>(graph.stages);
  const view: GraphView = { entry: graph.entry, stages: graph.stages, edges: graph.edges };

  for (const rule of floor.rules) {
    let triggered: boolean;
    switch (rule.trigger.kind) {
      case 'always':
        triggered = true;
        break;
      case 'contains_stage':
        triggered = included.has(rule.trigger.stage);
        break;
      case 'work_item_type': {
        /*
         * At policy load there is no work item, so a type-keyed rule is checked against the
         * template's own `applies_to`: a template that declares itself applicable to DEFECT
         * must satisfy the DEFECT rules, which is the load-time form of the same rule.
         */
        const type = context.workItemType;
        triggered = type !== undefined
          ? type === rule.trigger.type
          : (graph.applies_to?.types.includes(rule.trigger.type) ?? false);
        break;
      }
      case 'predicate_true': {
        /*
         * A predicate-keyed rule keys on reality, and reality does not exist at policy load.
         * So it is a run-start rule: the caller supplies evaluated values and the rule is
         * checked against them, and at load it is skipped.
         *
         * Skipping it is not a weakening. A template that lacks `ARCHITECTURE` is not
         * mis-authored — `task.direct` deliberately lacks it — it is simply *inadmissible*
         * when `architecture.required` evaluates TRUE, and the kernel then falls back to the
         * most conservative admissible template and logs the override. Treating the rule as
         * a load-time obligation would force every template to contain every optional
         * analysis stage, which is the opposite of what the template set is for.
         *
         * `regression.suspected` is the rule this matters most for, and it is why it works:
         * a defect misclassified as a TASK selects `task.direct`, the rule fires at run start
         * from observed reality, `task.direct` fails admission for want of `ROOT_CAUSE`, and
         * the fallback is a read-only investigation. The misclassification costs a lap and
         * cannot buy a symptom patch.
         */
        const value = context.predicateValues?.get(rule.trigger.predicate);
        if (value === undefined) continue;
        triggered = value !== 'FALSE';
        break;
      }
      default:
        triggered = false;
    }
    if (!triggered) continue;

    for (const forbidden of rule.forbids) {
      if (included.has(forbidden)) {
        problems.push({
          rule: rule.id,
          message: `${rule.id} forbids ${forbidden} and the graph contains it`,
        });
      }
    }

    for (const requirement of rule.requires) {
      if (!included.has(requirement.stage)) {
        /*
         * A `before`/`after` requirement whose anchor is absent is vacuous: "ROOT_CAUSE
         * before IMPLEMENTATION" says nothing about a graph with no IMPLEMENTATION.
         */
        if (requirement.relative_to !== null && !included.has(requirement.relative_to)) continue;
        problems.push({
          rule: rule.id,
          message: `${rule.id} requires ${requirement.stage}`
            + (requirement.relative_to === null ? '' : ` ${requirement.position} ${requirement.relative_to}`)
            + ', and the graph does not contain it',
        });
        continue;
      }
      switch (requirement.position) {
        case 'present':
          break;
        case 'before': {
          const anchor = requirement.relative_to;
          if (anchor === null || !included.has(anchor)) break;
          if (!dominates(view, requirement.stage, anchor)) {
            problems.push({
              rule: rule.id,
              message: `${rule.id}: ${requirement.stage} must be on every route to ${anchor}, `
                + 'and a route reaches it without passing through',
            });
          }
          break;
        }
        case 'after': {
          const anchor = requirement.relative_to;
          if (anchor === null || !included.has(anchor)) break;
          if (!postDominates(view, requirement.stage, anchor)) {
            problems.push({
              rule: rule.id,
              message: `${rule.id}: every route out of ${anchor} must pass through `
                + `${requirement.stage}, and one does not`,
            });
          }
          break;
        }
        case 'sole_predecessor_of_complete': {
          const offenders = graph.edges
            .filter((e) => e.to === 'COMPLETE' && e.from !== requirement.stage)
            .map((e) => e.from);
          if (offenders.length > 0) {
            problems.push({
              rule: rule.id,
              message: `${rule.id}: ${offenders.join(', ')} reach COMPLETE directly, and only `
                + `${requirement.stage} may`,
            });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  return problems;
}
