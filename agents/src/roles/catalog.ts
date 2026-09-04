import {
  PROLOGUE_STAGES,
  type AgentCatalog,
  type AgentRole,
  type AgentSpecView,
  type DodCriterionId,
  type Stage,
  type TemplateStage,
} from '@agentos/contracts';
import { loadPolicies, type PolicySet } from '@agentos/policies';
import { MVP_ROLE_SPECS, type ProposalKey, type RoleSpec } from './specs.js';

/**
 * The kernel's view of an agent, assembled from the role specification and the policy set.
 *
 * `AgentCatalog` is deliberately narrow: the kernel learns what an agent needs and what it
 * owes, and never what an agent is internally, which model it used, or how it reasoned. This
 * implementation keeps it that way by assembling every field from something already written
 * down — the specification for the mandate, `policies/data/agents.json` for the adapters and
 * the read-only flag, `policies/data/dod/criteria.json` for the criteria owed, and
 * `policies/data/stages.json` for what a stage's owning role must produce.
 *
 * Nothing is restated. A restated policy value is a second copy that drifts, and the drift
 * surfaces as an envelope the kernel refuses for an output nobody asked for — a defect that
 * looks like a model failure and is not.
 */
export class AgentCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCatalogError';
  }
}

/** Which Definition-of-Done pass a mandate supplies verdicts for, if any. */
const DOD_PASS: ReadonlyMap<string, 'first' | 'second' | 'only'> = new Map([
  /*
   * The `context` mandate owns criterion 1. The `resolution` mandate owns none, and that is
   * not an omission: resolution runs before a workflow and therefore before a DoD profile
   * exists, so there is no profile for a verdict to be counted against.
   */
  ['context-discovery/context', 'only'],
  /* AGENT_ROLES role 3: the first pass owns 3 and 4, the second pass owns 6, 16 and 17. */
  ['auditor/audit', 'first'],
  ['auditor/structural_reaudit', 'second'],
]);

/**
 * The stage whose `required_outputs` a mandate must agree with, where one exists.
 *
 * Only the template stages carry a descriptor; the prologue stages are the kernel's own and
 * have none, so a mandate that runs in the prologue is checked against nothing and declares
 * its outputs itself.
 */
const STAGE_OF_MANDATE: ReadonlyMap<string, TemplateStage> = new Map([
  ['auditor/audit', 'AUDIT'],
  ['auditor/structural_reaudit', 'STRUCTURAL_REAUDIT'],
]);

export class MvpAgentCatalog implements AgentCatalog {
  readonly #byKey: ReadonlyMap<string, AgentSpecView>;
  readonly #all: readonly AgentSpecView[];

  /**
   * @param policies the loaded policy set; loaded from the installation when omitted.
   * @param specs the role specifications to assemble. Overridable so a test can assemble a
   *   deliberately inconsistent one and see the check refuse it.
   */
  constructor(policies: PolicySet = loadPolicies(), specs: readonly RoleSpec[] = MVP_ROLE_SPECS) {
    const views = specs.map((spec) => assemble(spec, policies));
    const byKey = new Map<string, AgentSpecView>();
    for (const view of views) {
      const key = `${view.role}/${view.mandate_name}`;
      if (byKey.has(key)) {
        throw new AgentCatalogError(
          `two specifications claim ${key}. A mandate with two specifications is a dispatch `
          + 'whose obligations depend on which one was read',
        );
      }
      byKey.set(key, view);
    }
    this.#byKey = byKey;
    this.#all = Object.freeze(views);
  }

  spec(role: AgentRole, mandate: string): AgentSpecView | undefined {
    return this.#byKey.get(`${role}/${mandate}`);
  }

  all(): readonly AgentSpecView[] {
    return this.#all;
  }
}

function assemble(spec: RoleSpec, policies: PolicySet): AgentSpecView {
  const rolePolicy = policies.agents.roles.find((entry) => entry.role === spec.role);
  if (rolePolicy === undefined) {
    /*
     * Fail closed. A role the policy set does not describe has no stated adapter list and no
     * stated read-only flag, and defaulting either would be inventing the two values that
     * decide how far the dispatch can reach.
     */
    throw new AgentCatalogError(
      `policies/agents.json describes no role ${spec.role}, so the ${spec.mandate_name} `
      + 'mandate has no stated adapter set and no stated read-only flag. Both decide how far '
      + 'a dispatch reaches, and neither may be defaulted',
    );
  }

  const key = `${spec.role}/${spec.mandate_name}`;
  const pass = DOD_PASS.get(key);
  const owned: DodCriterionId[] = pass === undefined
    ? []
    : policies.dod.criteria
      .filter((c) => c.owner_role === spec.role && (c.owner_pass === pass || c.owner_pass === 'only'))
      .map((c) => c.criterion)
      .sort((a, b) => a - b);

  const stage = STAGE_OF_MANDATE.get(key);
  if (stage !== undefined) {
    const descriptor = policies.stages.get(stage);
    if (descriptor === undefined) {
      throw new AgentCatalogError(
        `${key} is dispatched into ${stage} and policies/stages.json has no descriptor for `
        + 'it, so there is nothing to check the mandate outputs against',
      );
    }
    const declared = [...spec.required_outputs].sort();
    const expected = [...descriptor.required_outputs].sort();
    if (declared.join(',') !== expected.join(',')) {
      throw new AgentCatalogError(
        `${key} declares outputs [${declared.join(', ')}] and stage ${stage} requires `
        + `[${expected.join(', ')}]. An agent told to produce one set while the stage exits `
        + 'on another produces an envelope the kernel refuses for an output nobody asked for',
      );
    }
    const stageCriteria = [...descriptor.dod_criteria].sort((a, b) => a - b);
    if (owned.join(',') !== stageCriteria.join(',')) {
      throw new AgentCatalogError(
        `${key} owes criteria [${owned.join(', ')}] and stage ${stage} collects `
        + `[${stageCriteria.join(', ')}]. A criterion nobody owes is a criterion that stays `
        + 'NOT_VALIDATED forever',
      );
    }
  }

  return {
    role: spec.role,
    mandate_name: spec.mandate_name,
    version: spec.version,
    objective: spec.objective,
    required_inputs: spec.required_inputs,
    required_outputs: spec.required_outputs,
    permitted_adapters: rolePolicy.permitted_adapters,
    read_only: rolePolicy.read_only,
    dod_criteria_owned: owned,
    model_requirement: spec.model_requirement,
  };
}

/**
 * The stages a run can actually reach in this installation.
 *
 * The prologue always runs, and a template is reachable only if every stage in it is
 * admissible — which, while `execution.json` admits `READ_ONLY` alone, means every stage in
 * it is non-mutating. A stage with no descriptor is treated as mutating, because an
 * operation whose effect cannot be established is the dangerous one.
 */
export function reachableStages(policies: PolicySet): ReadonlySet<Stage> {
  const reachable = new Set<Stage>(PROLOGUE_STAGES);
  const mutationAllowed = policies.execution.mutation_enabled;
  for (const template of policies.templates.values()) {
    const admissible = template.stages.every((stage) => {
      const descriptor = policies.stages.get(stage);
      if (descriptor === undefined) return false;
      return mutationAllowed || !descriptor.mutating;
    });
    if (!admissible) continue;
    for (const stage of template.stages) reachable.add(stage);
  }
  return reachable;
}

/**
 * The Orchestrator Agent's choices, derived rather than restated.
 *
 * AGENT_ROLES role 1 lists more things the Orchestrator may propose than a read-only
 * milestone can reach: triage belongs to `REVIEW_TRIAGE` and cancellation to
 * `CHILD_COORDINATION`, and neither stage appears in any template this installation admits;
 * an authorization request answers a gate, and nothing is gated when nothing mutates. What
 * survives is three — the workflow, the next dispatch, and the resolution of a surviving
 * disagreement — and computing that from the policy set rather than writing "three" down
 * means it becomes four on the day milestone 2 registers its first mutating stage, without
 * anybody having to remember this function exists.
 */
export function orchestratorChoices(policies: PolicySet): readonly ProposalKey[] {
  const role = policies.agents.roles.find((entry) => entry.role === 'orchestrator');
  if (role === undefined) {
    throw new AgentCatalogError(
      'policies/agents.json describes no orchestrator role, so what it may propose is '
      + 'unstated and cannot be defaulted',
    );
  }
  const reachable = reachableStages(policies);
  const choices = role.may_propose.filter((choice) => {
    /* A draft authorization request answers a gate, and no gate can fire while nothing in
     * this installation mutates. */
    if (choice === 'authorization_request' && !policies.execution.mutation_enabled) return false;
    const stages = role.proposal_stages[choice] ?? [];
    return stages.some((stage) => stage === '*' || reachable.has(stage));
  });
  return Object.freeze([...choices].sort());
}
