import type {
  CheckOutcome,
  DodProfileId,
  FrozenGraph,
  PredicateValue,
  RiskClass,
  Scope,
  TemplateStage,
  Violation,
  WorkItem,
  WorkflowProposal,
  WorkflowTemplate,
} from '@agentos/contracts';
import { checkFloor, checkWellFormed, withoutStages, type PolicySet } from '@agentos/policies';

import { pathMatches } from './predicates.js';
import type { PredicateEvaluator, PredicateEvaluation, PredicateInputs } from './predicates.js';

/**
 * Workflow admission.
 *
 * **Workflows are not authored, they are selected.** Templates live in `policies/workflows/`,
 * authored and reviewed by humans and checked against the workflow floor at policy load. The
 * Orchestrator chooses among the admissible ones, includes or excludes only the stages a
 * template marks optional, and sets a mandate scope bounded by the Work Item's. It cannot add
 * a stage that is not in the template — which is why "propose a dangerous stage" is
 * unreachable rather than merely gated — it cannot exclude a stage without the kernel
 * evaluating its predicate `FALSE`, and it cannot choose where the run starts.
 *
 * The deeper reason for the mechanism: validating an arbitrary model-authored graph would
 * require the kernel to decide whether a novel stage sequence is safe, which is judgment —
 * the one thing it must not do. **Validating a selection from a known set is arithmetic**, and
 * this file is the arithmetic.
 *
 * A failed admission is not negotiated. The kernel selects the most conservative admissible
 * template, records the override, and continues. The Orchestrator being wrong costs
 * efficiency, never safety.
 */

export interface WorkflowAdmissionInput {
  readonly workItem: WorkItem;
  readonly policies: PolicySet;
  readonly proposal: WorkflowProposal | null;
  readonly evaluator: PredicateEvaluator;
  readonly predicateInputs: PredicateInputs;
  /** Which DoD profile the run will judge against, for the graph's default. */
  readonly profile: DodProfileId;
  /**
   * Set where reality shows the outcome already holds, which admits a `COMPLETION`-only
   * parameterization of `investigation.readonly` (WORKFLOW_STATE_MACHINE 5.3). This is a
   * kernel path from observed reality, never a proposal.
   */
  readonly outcomeAlreadySatisfied: boolean;
}

export interface WorkflowAdmissionResult {
  readonly graph: FrozenGraph;
  readonly admissibleTemplates: readonly string[];
  readonly checks: readonly CheckOutcome[];
  readonly evaluations: readonly PredicateEvaluation[];
  /** Present where the proposal was refused and a fallback was selected instead. */
  readonly override: {
    readonly proposedTemplate: string | null;
    readonly selectedTemplate: string;
    readonly reason: string;
    readonly failedChecks: readonly CheckOutcome[];
  } | null;
  readonly violations: readonly Violation[];
}

/**
 * Risk class, derived from the admitted graph and the scope.
 *
 * `READ_ONLY` when no stage mutates; `LOCAL_MUTATION` when mutation stays inside a worktree;
 * `EXTERNAL_MUTATION` when a stage reaches an external system; `IRREVERSIBLE` when it reaches
 * merge, deploy, a production write, or a `reversal: null` operation.
 *
 * Derived rather than declared, because a declared risk class is a claim and the whole point
 * of the class is to select floor rows and the gate set.
 */
export function deriveRiskClass(
  stages: readonly TemplateStage[],
  policies: PolicySet,
): { readonly riskClass: RiskClass; readonly reason: string } {
  const mutating = stages.filter((s) => policies.stages.get(s)?.mutating === true);
  if (mutating.length === 0) {
    return {
      riskClass: 'READ_ONLY',
      reason: 'no stage in the graph mutates authoritative state outside AgentOS\'s own ledger',
    };
  }
  const irreversible = stages.filter(
    (s) => s === 'MERGE' || s === 'DEPLOY' || s === 'PRODUCTION_VALIDATION',
  );
  if (irreversible.length > 0) {
    return {
      riskClass: 'IRREVERSIBLE',
      reason: `the graph reaches ${irreversible.join(', ')}`,
    };
  }
  const external = stages.filter(
    (s) => s === 'PR_PREPARATION' || s === 'CHILD_COORDINATION' || s === 'AUTHORIZATION',
  );
  if (external.length > 0) {
    return {
      riskClass: 'EXTERNAL_MUTATION',
      reason: `the graph reaches an external system at ${external.join(', ')}`,
    };
  }
  return {
    riskClass: 'LOCAL_MUTATION',
    reason: `mutation is confined to a worktree: ${mutating.join(', ')}`,
  };
}

/**
 * The most conservative admissible template.
 *
 * "The one whose stage set is a superset of the others, or `investigation.readonly` if none
 * is." More stages means more verification, which is what conservative means here.
 */
export function mostConservative(
  admissible: readonly WorkflowTemplate[],
): WorkflowTemplate | null {
  const superset = admissible.find((candidate) => {
    const stages = new Set(candidate.stages);
    return admissible.every((other) => other.stages.every((s) => stages.has(s)));
  });
  if (superset !== undefined) return superset;
  return admissible.find((t) => t.template_id === 'investigation.readonly') ?? null;
}

/** A scope contained by another: every path and capability falls inside it. */
export function scopeContained(inner: Scope, outer: Scope): boolean {
  const pathsOk = inner.paths.every((path) => outer.paths.some((o) => pathMatches(path, o)));
  const capabilitiesOk = inner.capabilities.every((c) => outer.capabilities.includes(c));
  const repositoriesOk = inner.repositories.every((r) => outer.repositories.includes(r));
  return pathsOk && capabilitiesOk && repositoriesOk;
}

export async function admitWorkflow(
  input: WorkflowAdmissionInput,
): Promise<WorkflowAdmissionResult> {
  const { workItem, policies, proposal } = input;
  const checks: CheckOutcome[] = [];
  const evaluations: PredicateEvaluation[] = [];
  const violations: Violation[] = [];

  /* -------------------------------------------------- the admissible set ---- */

  const byType = policies.admissibleTemplates(workItem.type);
  const allowedRisk = new Set(policies.execution.admissible_risk_classes);
  const admissible = byType.filter((template) => {
    const { riskClass } = deriveRiskClass(template.stages, policies);
    return allowedRisk.has(riskClass);
  });
  const excludedByRisk = byType.filter((t) => !admissible.includes(t));

  checks.push({
    check: 'admissible_set',
    result: admissible.length > 0 ? 'PASS' : 'FAIL',
    detail: excludedByRisk.length === 0
      ? `${admissible.length} template(s) admissible for type ${workItem.type}`
      : `${admissible.length} of ${byType.length} template(s) admissible for type `
        + `${workItem.type}; ${excludedByRisk.map((t) => t.template_id).join(', ')} exceed the `
        + `risk classes this installation executes (${[...allowedRisk].join(', ')})`,
  });

  if (admissible.length === 0) {
    /* Unreachable while investigation.readonly is READ_ONLY and applies to every type, which
     * the policy loader asserts. Failing closed anyway: an empty admissible set would leave
     * the kernel choosing between guessing and refusing. */
    violations.push({
      code: 'STAGE_NOT_IN_TEMPLATE',
      rule: 'WORKFLOW_STATE_MACHINE section 3.4',
      message:
        `no template is admissible for type ${workItem.type} within the risk classes this `
        + 'installation executes',
      path: null,
      handled_as: 'REFUSED',
      subject: workItem.work_item_id,
    });
    throw new Error(
      'no admissible workflow template. Policy load asserts investigation.readonly is '
      + 'admissible for every type, so reaching here means the policy set changed under the run',
    );
  }

  /* ------------------------------- the kernel's own COMPLETION-only path (5.3) ---- */

  if (input.outcomeAlreadySatisfied) {
    const investigation = admissible.find((t) => t.template_id === 'investigation.readonly');
    if (investigation !== undefined) {
      const graph = freeze(investigation, ['COMPLETION'], [], {}, policies, input.profile);
      checks.push({
        check: 'outcome_already_satisfied',
        result: 'PASS',
        detail:
          'reality shows the desired outcome already holds, so investigation.readonly is '
          + 'admitted with a COMPLETION-only parameterization. The DoD still runs against '
          + 'existing evidence and can return INDETERMINATE if that evidence is not '
          + 'obtainable; nothing is re-implemented and no second PR is opened',
      });
      return {
        graph,
        admissibleTemplates: admissible.map((t) => t.template_id),
        checks,
        evaluations,
        override: proposal === null ? null : {
          proposedTemplate: proposal.template_id,
          selectedTemplate: 'investigation.readonly',
          reason:
            'the kernel computes where a run starts, and reality shows the outcome already '
            + 'holds. This parameterization is not proposable',
          failedChecks: [],
        },
        violations,
      };
    }
  }

  /* -------------------------------------------- the proposal, check by check ---- */

  const failed: CheckOutcome[] = [];

  if (proposal === null) {
    const fallback = mostConservative(admissible);
    if (fallback === null) throw new Error('no fallback template');
    const included = await includedStages(fallback, input, evaluations, failed);
    const graph = freeze(
      fallback,
      included.stages,
      included.excluded,
      {},
      policies,
      input.profile,
    );
    checks.push({
      check: 'template_selected',
      result: 'PASS',
      detail:
        `no proposal was made, so the most conservative admissible template `
        + `(${fallback.template_id}) applies`,
    });
    return {
      graph,
      admissibleTemplates: admissible.map((t) => t.template_id),
      checks,
      evaluations,
      override: null,
      violations,
    };
  }

  /* 1. Template exists, loaded from policy, version recorded. */
  const template = policies.templates.get(proposal.template_id);
  const existsCheck: CheckOutcome = {
    check: 'template_exists',
    result: template === undefined ? 'FAIL' : 'PASS',
    detail: template === undefined
      ? `${proposal.template_id} is not a template in policies/workflows/`
      : `${proposal.template_id} version ${template.version}`,
  };
  checks.push(existsCheck);
  if (template === undefined) failed.push(existsCheck);

  /* 2. `applies_to` matches the admitted work item type. */
  const appliesCheck: CheckOutcome = {
    check: 'applies_to_matches',
    result: template !== undefined && admissible.includes(template) ? 'PASS' : 'FAIL',
    detail: template === undefined
      ? 'no template to check'
      : admissible.includes(template)
        ? `admissible for ${workItem.type}`
        : `${template.template_id} is not admissible for ${workItem.type}`,
  };
  checks.push(appliesCheck);
  if (appliesCheck.result === 'FAIL') failed.push(appliesCheck);

  let includedResult: { readonly stages: readonly TemplateStage[]; readonly excluded: FrozenGraph['excluded_stages'] } = {
    stages: [], excluded: [],
  };

  if (template !== undefined && failed.length === 0) {
    /* 3. Every included stage is in the template's stages. */
    const templateStages = new Set(template.stages);
    const invented = proposal.include_optional.filter((s) => !templateStages.has(s));
    const inventedCheck: CheckOutcome = {
      check: 'no_stage_invention',
      result: invented.length === 0 ? 'PASS' : 'FAIL',
      detail: invented.length === 0
        ? 'every included stage is in the template'
        : `${invented.join(', ')} are not in ${template.template_id}. A stage not in the `
          + 'template cannot be added, which is why proposing a dangerous stage is unreachable '
          + 'rather than merely gated',
    };
    checks.push(inventedCheck);
    if (inventedCheck.result === 'FAIL') {
      failed.push(inventedCheck);
      violations.push({
        code: 'STAGE_NOT_IN_TEMPLATE',
        rule: 'WORKFLOW_STATE_MACHINE section 3.4 check 3',
        message: inventedCheck.detail,
        path: '/proposals/workflow/include_optional',
        handled_as: 'OVERRIDDEN',
        subject: template.template_id,
      });
    }

    /* 4. Every excluded optional stage has a `FALSE` predicate, evaluated by the kernel. */
    includedResult = await includedStages(template, input, evaluations, failed, proposal, violations);

    /* 5 and 6: the floor and well-formedness, on the resulting graph. */
    const graphView = {
      entry: template.entry,
      stages: includedResult.stages,
      edges: withoutStages(
        { entry: template.entry, stages: template.stages, edges: template.edges },
        new Set(template.stages.filter((s) => !includedResult.stages.includes(s))),
      ).edges,
    };

    const wellFormed = checkWellFormed(graphView);
    const formCheck: CheckOutcome = {
      check: 'graph_well_formed',
      result: wellFormed.ok ? 'PASS' : 'FAIL',
      detail: wellFormed.ok
        ? 'endpoints included, every stage reachable, COMPLETION reachable and the sole '
          + 'predecessor of COMPLETE'
        : wellFormed.problems.join('; '),
    };
    checks.push(formCheck);
    if (formCheck.result === 'FAIL') failed.push(formCheck);

    const predicateValues = new Map<string, PredicateValue>();
    for (const rule of policies.floor.rules) {
      if (rule.trigger.kind !== 'predicate_true') continue;
      const evaluation = await input.evaluator.evaluate(rule.trigger.predicate, input.predicateInputs);
      evaluations.push(evaluation);
      predicateValues.set(rule.trigger.predicate, evaluation.value);
    }
    const floorProblems = checkFloor(
      policies.floor,
      { ...graphView, applies_to: template.applies_to },
      policies.stages,
      { workItemType: workItem.type, predicateValues },
    );
    const floorCheck: CheckOutcome = {
      check: 'workflow_floor',
      result: floorProblems.length === 0 ? 'PASS' : 'FAIL',
      detail: floorProblems.length === 0
        ? 'the floor holds for the resulting graph'
        : floorProblems.map((p) => `${p.rule}: ${p.message}`).join('; '),
    };
    checks.push(floorCheck);
    if (floorCheck.result === 'FAIL') failed.push(floorCheck);

    /* Per-stage mandate scope, bounded by and never exceeding the Work Item's. */
    const mandates: Record<string, Scope> = {};
    for (const [stage, scope] of Object.entries(proposal.stage_mandates ?? {})) {
      if (scope === undefined) continue;
      if (!scopeContained(scope, workItem.scope)) {
        const scopeCheck: CheckOutcome = {
          check: 'mandate_scope_bounded',
          result: 'FAIL',
          detail:
            `the mandate for ${stage} is not contained by the Work Item's admitted scope. `
            + 'Scope becomes the mandate the adapters enforce, so exceeding it would be '
            + 'widening reach by proposal',
        };
        checks.push(scopeCheck);
        failed.push(scopeCheck);
        violations.push({
          code: 'SCOPE_EXCEEDS_WORK_ITEM',
          rule: 'WORKFLOW_STATE_MACHINE section 3.3',
          message: scopeCheck.detail,
          path: `/proposals/workflow/stage_mandates/${stage}`,
          handled_as: 'OVERRIDDEN',
          subject: stage,
        });
        continue;
      }
      mandates[stage] = scope;
    }

    /*
     * `failed` is pushed to by the checks above, and the compiler's narrowing of its length
     * from the enclosing block does not survive those pushes in a way the lint rule can see.
     */
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (failed.length === 0) {
      const graph = freeze(
        template,
        includedResult.stages,
        includedResult.excluded,
        mandates,
        policies,
        input.profile,
      );
      return {
        graph,
        admissibleTemplates: admissible.map((t) => t.template_id),
        checks,
        evaluations,
        override: null,
        violations,
      };
    }
  }

  /* ---------------------------------------------------------- the fallback ---- */

  const fallback = mostConservative(admissible);
  if (fallback === null) throw new Error('no fallback template');
  const fallbackIncluded = await includedStages(fallback, input, evaluations, []);
  const graph = freeze(
    fallback,
    fallbackIncluded.stages,
    fallbackIncluded.excluded,
    {},
    policies,
    input.profile,
  );

  return {
    graph,
    admissibleTemplates: admissible.map((t) => t.template_id),
    checks,
    evaluations,
    override: {
      proposedTemplate: proposal.template_id,
      selectedTemplate: fallback.template_id,
      reason:
        'a failed admission is not negotiated. The kernel selects the most conservative '
        + 'admissible template and continues; the Orchestrator being wrong costs efficiency, '
        + 'never safety',
      failedChecks: failed,
    },
    violations,
  };
}

/**
 * Which stages are included, and which exclusions the kernel actually granted.
 *
 * **Exclusion requires the stage's applicability predicate to evaluate `FALSE`** — evaluated
 * by the kernel, not claimed by the agent. `TRUE` or `INDETERMINATE` keeps the stage, per the
 * safer-branch rule, which applies unmodified here because including a review stage costs
 * only tokens.
 *
 * Optional stages sharing one predicate form one exclusion group: excluding `DEPLOY` without
 * `PRODUCTION_VALIDATION` would leave a deploy nobody validates, and one predicate evaluating
 * `FALSE` excludes the group it governs.
 */
async function includedStages(
  template: WorkflowTemplate,
  input: WorkflowAdmissionInput,
  evaluations: PredicateEvaluation[],
  failed: CheckOutcome[],
  proposal?: WorkflowProposal,
  violations?: Violation[],
): Promise<{
    readonly stages: readonly TemplateStage[];
    readonly excluded: FrozenGraph['excluded_stages'];
  }> {
  const groups = input.policies.exclusionGroups(template.template_id);
  const requested = new Set(proposal?.exclude_optional.map((e) => e.stage) ?? []);
  const claims = new Map(proposal?.exclude_optional.map((e) => [e.stage, e.claim]) ?? []);

  const excluded: FrozenGraph['excluded_stages'][number][] = [];
  const excludedStages = new Set<TemplateStage>();

  for (const [predicate, stages] of groups) {
    const groupRequested = stages.some((s) => requested.has(s));
    if (!groupRequested) continue;

    const evaluation = await input.evaluator.evaluate(predicate, {
      ...input.predicateInputs,
      claim: stages.map((s) => claims.get(s)).filter((c) => c !== undefined).join('; ') || null,
    });
    evaluations.push(evaluation);

    if (evaluation.value === 'FALSE') {
      for (const stage of stages) {
        excluded.push({ stage, predicate, evaluated: 'FALSE' });
        excludedStages.add(stage);
      }
      continue;
    }

    /*
     * TRUE or INDETERMINATE keeps the stage, and the override is logged with both the claim
     * and the evaluated value — so a systematically over-claiming agent becomes visible in
     * the run narrative rather than merely being ignored.
     */
    const kept: CheckOutcome = {
      check: 'exclusion_predicate_false',
      result: 'FAIL',
      detail:
        `${stages.join(', ')} stay in the graph: ${predicate} evaluates ${evaluation.value}, `
        + `and the claim was "${evaluation.claim ?? 'none'}". ${evaluation.reason}. `
        + 'INDETERMINATE keeps a non-mutating stage because the cost of an unnecessary review '
        + 'is tokens and the cost of a skipped one is a defect reaching production behind a '
        + 'green run',
    };
    failed.push(kept);
    violations?.push({
      code: 'EXCLUSION_PREDICATE_NOT_FALSE',
      rule: 'WORKFLOW_STATE_MACHINE section 3.3',
      message: kept.detail,
      path: '/proposals/workflow/exclude_optional',
      handled_as: 'OVERRIDDEN',
      subject: stages.join(', '),
    });
  }

  return {
    stages: template.stages.filter((s) => !excludedStages.has(s)),
    excluded,
  };
}

/** Freezes the parameterized instance. The graph is replayed on recovery, never recomputed. */
function freeze(
  template: WorkflowTemplate,
  stages: readonly TemplateStage[],
  excluded: FrozenGraph['excluded_stages'],
  mandates: Readonly<Record<string, Scope>>,
  policies: PolicySet,
  profile: DodProfileId,
): FrozenGraph {
  const removed = new Set(template.stages.filter((s) => !stages.includes(s)));
  const reduced = withoutStages(
    { entry: template.entry, stages: template.stages, edges: template.edges },
    removed,
  );
  const { riskClass } = deriveRiskClass(stages, policies);
  return {
    template_id: template.template_id,
    template_version: template.version,
    entry: reduced.entry,
    stages: [...stages],
    edges: reduced.edges,
    excluded_stages: excluded,
    stage_mandates: mandates,
    risk_class: riskClass,
    dod_profile_default: profile,
  };
}
