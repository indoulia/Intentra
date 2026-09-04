import type {
  ContextPackage,
  DodProfileId,
  WorkItem,
  WorkflowTemplate,
} from '@agentos/contracts';
import type { PolicySet } from '@agentos/policies';
import { predicateOf } from '@agentos/policies';
import type { CheckOutcome } from '@agentos/contracts';
import type { PredicateEvaluator, PredicateInputs } from './predicates.js';

/**
 * `UNDERSTOOD` — computed, never declared.
 *
 * The definition worth having is not a list of questions that feel answered:
 *
 * > **Understanding is sufficient exactly when the workflow decision is determinate.**
 *
 * Five conditions, all kernel-computable. Condition 3 does the work: it makes "do we know
 * enough?" mean "can we choose without guessing?", and it is decidable by evaluating a
 * finite set of named predicates. An agent stating that it has enough context does not make
 * the workflow decision determinate.
 *
 * Failing 3 is the common case, and it is informative: it names exactly which predicate is
 * undetermined, which names exactly which discovery would resolve it. **Sufficiency failures
 * are actionable by construction**, and this reports them that way rather than as a verdict.
 */

export interface UnderstoodInput {
  readonly workItem: WorkItem;
  readonly policies: PolicySet;
  readonly context: ContextPackage;
  readonly evaluator: PredicateEvaluator;
  readonly predicateInputs: PredicateInputs;
  /** Access classes this run has, for condition 2. */
  readonly access: ReadonlySet<'repository' | 'git' | 'project_management' | 'runtime' | 'production'>;
  readonly resolutionConfidence: number;
  /** Set where the uncertainty ladder has already been applied and its outcome recorded. */
  readonly ladderApplied: boolean;
}

export interface UnderstoodVerdict {
  readonly verdict: 'SUFFICIENT' | 'INSUFFICIENT';
  readonly conditions: readonly CheckOutcome[];
  /**
   * Which predicates are undetermined. Naming them names the discovery that would resolve
   * them, which is what makes the failure actionable rather than a shrug.
   */
  readonly undeterminedPredicates: readonly string[];
  /** Profiles the outcome binds to that this run can actually check. */
  readonly checkableProfiles: readonly DodProfileId[];
}

/** A predicate a run start depends on, and the stage it is about where it is about one. */
export interface EntryPredicate {
  readonly predicate: string;
  /**
   * The stage whose `satisfied_by` this is, or `null` for a predicate about the world.
   *
   * `reality.stage_completed_previously` asks about a particular stage, so evaluating it with
   * no stage supplied returns `INDETERMINATE` by construction — which would make every run
   * `INSUFFICIENT` for a reason that is not about the work.
   */
  readonly stage: string | null;
}

/**
 * The predicates a candidate template's *entry edges* reference.
 *
 * Entry edges are the edges out of the stages a run could start in — the template's entry
 * and, because the kernel computes the entry from reality, every stage's `satisfied_by` as
 * well. Both are needed: a `satisfied_by` that cannot be evaluated is a stage the resume
 * walk cannot classify, which is the same failure as an unevaluable branch.
 */
export function entryPredicates(
  template: WorkflowTemplate,
  policies: PolicySet,
): readonly EntryPredicate[] {
  const out = new Map<string, EntryPredicate>();
  const add = (predicate: string, stage: string | null): void => {
    const key = `${predicate}\u0000${stage ?? ''}`;
    if (!out.has(key)) out.set(key, { predicate, stage });
  };

  for (const edge of template.edges) {
    if (edge.from !== template.entry) continue;
    const named = predicateOf(edge.when);
    if (named !== null) add(named, template.entry);
  }
  for (const stage of template.stages) {
    const descriptor = policies.stages.get(stage);
    const satisfiedBy = descriptor?.satisfied_by ?? null;
    if (satisfiedBy !== null) add(satisfiedBy, stage);
    const applicability = descriptor?.applicability_predicate ?? null;
    if (applicability !== null) add(applicability, stage);
  }
  /* Floor rules keyed on a predicate fire at run start, so their predicates have to be
   * determinate too — a floor rule nobody can evaluate is a floor rule that does not hold. */
  for (const rule of policies.floor.rules) {
    if (rule.trigger.kind === 'predicate_true') add(rule.trigger.predicate, null);
  }
  return [...out.values()].sort(
    (a, b) => a.predicate.localeCompare(b.predicate) || (a.stage ?? '').localeCompare(b.stage ?? ''),
  );
}

export async function computeUnderstood(
  input: UnderstoodInput,
): Promise<UnderstoodVerdict> {
  const { workItem, policies } = input;
  const conditions: CheckOutcome[] = [];

  /* --------------------------------------------------- 1. type is not UNKNOWN ---- */

  const admissible = policies.admissibleTemplates(workItem.type);
  const investigationApplies = admissible.some(
    (t) => t.template_id === 'investigation.readonly',
  );
  conditions.push({
    check: 'type_known_or_investigation',
    result: workItem.type !== 'UNKNOWN' || investigationApplies ? 'PASS' : 'FAIL',
    detail: workItem.type === 'UNKNOWN'
      ? 'the type is UNKNOWN, which routes to investigation.readonly — the template that '
        + 'exists so the admissible set is never empty'
      : `the type is ${workItem.type}, with ${admissible.length} admissible template(s)`,
  });

  /* -------------------------------------------- 2. the outcome binds to a profile ---- */

  const checkable: DodProfileId[] = [];
  const unreachable: string[] = [];
  for (const id of workItem.candidate_dod_profiles) {
    const profile = policies.profile(id);
    const missing = profile.applies_when.requires_access.filter((a) => !input.access.has(a));
    if (missing.length === 0) checkable.push(id);
    else unreachable.push(`${id} needs ${missing.join(', ')}`);
  }
  conditions.push({
    check: 'outcome_binds_to_profile',
    result: checkable.length > 0 ? 'PASS' : 'FAIL',
    detail: checkable.length > 0
      ? `binds to ${checkable.join(', ')} with this run's access`
      : `binds only to profiles this run cannot check: ${unreachable.join('; ')}`,
  });

  /* ---------------------------- 3. every entry-edge predicate is determinate ---- */

  const undetermined: string[] = [];
  const evaluated = new Set<string>();
  for (const template of admissible) {
    for (const entry of entryPredicates(template, policies)) {
      const key = `${entry.predicate}\u0000${entry.stage ?? ''}`;
      if (evaluated.has(key)) continue;
      evaluated.add(key);
      const evaluation = await input.evaluator.evaluate(entry.predicate, {
        ...input.predicateInputs,
        stage: entry.stage,
      });
      if (evaluation.value !== 'INDETERMINATE') continue;
      /*
       * Reported per predicate rather than per stage. A `satisfied_by` that cannot be
       * evaluated is undetermined for every stage that shares it, and naming the predicate
       * names the discovery that would resolve it — which is the point of the report.
       */
      if (!undetermined.includes(entry.predicate)) undetermined.push(entry.predicate);
    }
  }
  conditions.push({
    check: 'entry_predicates_determinate',
    result: undetermined.length === 0 ? 'PASS' : 'FAIL',
    detail: undetermined.length === 0
      ? `all ${evaluated.size} predicate(s) referenced by candidate entry edges evaluate `
        + 'TRUE or FALSE'
      : `${undetermined.join(', ')} evaluate INDETERMINATE. Each names the discovery that `
        + 'would resolve it, which is what makes this failure actionable by construction',
  });

  /* --------------------- 4. every UNKNOWN that blocks a mandatory stage is handled ---- */

  const blockingUnknowns = input.context.gaps.filter((gap) => gap.blocks.length > 0);
  const unhandled = blockingUnknowns.filter(
    (gap) => gap.recoverable_by.trim().length === 0,
  );
  conditions.push({
    check: 'blocking_unknowns_handled',
    result: unhandled.length === 0 ? 'PASS' : 'FAIL',
    detail: unhandled.length === 0
      ? `${blockingUnknowns.length} unknown(s) block a downstream obligation and each names `
        + 'what would recover it'
      : `${unhandled.map((g) => g.id).join(', ')} block an obligation and name no recovery`,
  });

  /* ----------------------------------- 5. resolution confidence, or the ladder ---- */

  const threshold = policies.workItems.resolution_confidence_threshold;
  const confident = input.resolutionConfidence >= threshold;
  conditions.push({
    check: 'resolution_confidence',
    result: confident || input.ladderApplied ? 'PASS' : 'FAIL',
    detail: confident
      ? `${input.resolutionConfidence} meets the threshold of ${threshold}`
      : input.ladderApplied
        ? `${input.resolutionConfidence} is below the threshold of ${threshold}, and the `
          + 'uncertainty ladder has been applied with its outcome recorded'
        : `${input.resolutionConfidence} is below the threshold of ${threshold} and the `
          + 'uncertainty ladder has not been applied',
  });

  const verdict = conditions.every((c) => c.result === 'PASS' || c.result === 'NOT_APPLICABLE')
    ? 'SUFFICIENT'
    : 'INSUFFICIENT';

  return {
    verdict,
    conditions,
    undeterminedPredicates: undetermined,
    checkableProfiles: checkable,
  };
}
