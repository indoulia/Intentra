import type {
  CompletionReport,
  CompletionVerdict,
  CriterionVerdict,
  DodCriterionId,
  DodProfile,
  DodProfileId,
  DodPolicySet,
  DodVerdict,
  HandoffEnvelope,
  SourceDrift,
  TemplateStage,
} from '@agentos/contracts';
import type { PolicySet } from '@agentos/policies';

/**
 * The Definition-of-Done arithmetic.
 *
 * **The kernel does the arithmetic, not the judging.** It collects per-criterion verdicts,
 * checks applicability against the profile, and computes the completion verdict — applying
 * mechanically the rule that `NOT_VALIDATED` is never `MET`. It never decides a criterion
 * itself.
 *
 * That rule is the one this whole model most likely gets quietly defeated by, so it is
 * implemented once, here, and there is no path through this file on which a
 * `NOT_VALIDATED` counts as met.
 */

export interface CollectedVerdict extends CriterionVerdict {
  /** Which envelope supplied it, so the report can say who judged what. */
  readonly supplied_by_envelope: string;
  readonly owner_role: string;
}

export interface DodInput {
  readonly workItemId: string;
  readonly runId: string;
  readonly profileId: DodProfileId;
  readonly policies: PolicySet;
  /** Every envelope the run accepted, in order. */
  readonly envelopes: readonly HandoffEnvelope[];
  /** Stages the entry computation marked COMPLETED_PRIOR. They supplied no verdicts. */
  readonly completedPriorStages: readonly TemplateStage[];
  /** Stages in the frozen graph, for routing an INCOMPLETE back to the stage that owes. */
  readonly graphStages: readonly TemplateStage[];
  readonly sourceDrift: SourceDrift | null;
  readonly computedAt: string;
}

/**
 * Collects the verdicts the run actually received.
 *
 * A later envelope from the same role on the same criterion supersedes an earlier one — a
 * rework lap is supposed to change the answer. Two *different* roles on one criterion cannot
 * happen: policy load checks that every criterion has exactly one owning role, and envelope
 * receipt refuses a verdict from a role that does not own it.
 */
export function collectVerdicts(input: DodInput): readonly CollectedVerdict[] {
  const byCriterion = new Map<DodCriterionId, CollectedVerdict>();
  const owners = new Map(
    input.policies.dod.criteria.map((c) => [c.criterion, c.owner_role]),
  );
  for (const envelope of input.envelopes) {
    for (const verdict of envelope.dod_verdicts) {
      byCriterion.set(verdict.criterion, {
        ...verdict,
        supplied_by_envelope: envelope.envelope_id,
        owner_role: owners.get(verdict.criterion) ?? envelope.agent,
      });
    }
  }
  return [...byCriterion.values()].sort((a, b) => a.criterion - b.criterion);
}

/** Which stage owes a criterion, from the stage descriptors. */
export function stageOwning(
  policies: PolicySet,
  criterion: DodCriterionId,
  graphStages: readonly TemplateStage[],
): TemplateStage | null {
  for (const stage of graphStages) {
    const descriptor = policies.stages.get(stage);
    if (descriptor === undefined) continue;
    if (descriptor.dod_criteria.includes(criterion)) return stage;
  }
  return null;
}

export interface DodComputation {
  readonly report: CompletionReport;
  /** The verdict, and why it is that verdict rather than the next one up. */
  readonly rationale: readonly string[];
}

/**
 * Computes the completion verdict.
 *
 * - `COMPLETE` — every applicable criterion `MET`.
 * - `COMPLETE_WITH_GAPS` — all critical criteria met, non-critical ones explicitly deferred
 *   with recorded reasons. Requires human acknowledgement.
 * - `INCOMPLETE` — one or more critical criteria not met.
 * - `INDETERMINATE` — completion cannot be judged because evidence was unobtainable.
 *
 * `INDETERMINATE` must never be reported as `COMPLETE_WITH_GAPS`. "We could not check" and
 * "we checked and accepted a gap" are different facts about the world, and only one of them
 * is a decision someone made — so the two are separated by *why* a criterion is not met,
 * not by how many are.
 */
export function computeDod(input: DodInput): DodComputation {
  const profile = input.policies.profile(input.profileId);
  const collected = collectVerdicts(input);
  const byCriterion = new Map(collected.map((v) => [v.criterion, v]));
  const notApplicableByDefault = new Map(
    profile.not_applicable_by_default.map((n) => [n.criterion, n.reason]),
  );
  const critical = new Set(profile.critical_criteria);
  const owners = new Map(input.policies.dod.criteria.map((c) => [c.criterion, c]));

  const criteria: CompletionReport['criteria'][number][] = [];
  const rationale: string[] = [];

  for (const criterion of profile.criteria) {
    const supplied = byCriterion.get(criterion);
    const owner = owners.get(criterion);
    const ownerRole = owner?.owner_role ?? 'validator';

    if (supplied !== undefined) {
      criteria.push({
        criterion,
        verdict: supplied.verdict,
        reason: supplied.reason,
        evidence: supplied.evidence,
        owner_role: ownerRole,
        supplied_by_envelope: supplied.supplied_by_envelope,
      });
      continue;
    }

    const defaultReason = notApplicableByDefault.get(criterion);
    if (defaultReason !== undefined) {
      criteria.push({
        criterion,
        verdict: 'NOT_APPLICABLE',
        reason: defaultReason,
        evidence: [],
        owner_role: ownerRole,
        supplied_by_envelope: null,
      });
      continue;
    }

    /*
     * Nobody supplied it. Which is exactly what a stage marked COMPLETED_PRIOR produces —
     * and the reason says so, because "the stage was skipped as already done" and "the
     * stage ran and could not establish it" are different facts and the report must not
     * flatten them.
     */
    const owningStage = stageOwning(input.policies, criterion, input.graphStages);
    const skipped = owningStage !== null && input.completedPriorStages.includes(owningStage);
    criteria.push({
      criterion,
      verdict: 'NOT_VALIDATED',
      reason: skipped
        ? `${owningStage} was marked COMPLETED_PRIOR, so it supplied no verdict. `
          + 'COMPLETED_PRIOR means the mutation has already occurred, not that the criteria '
          + 'are met'
        : owningStage === null
          ? `no stage in this graph owns criterion ${criterion}, so no verdict was owed`
          : `${owningStage} supplied no verdict for criterion ${criterion}`,
      evidence: [],
      owner_role: ownerRole,
      supplied_by_envelope: null,
    });
  }

  const met = criteria.filter((c) => c.verdict === 'MET');
  const notMet = criteria.filter((c) => c.verdict === 'NOT_MET');
  const notValidated = criteria.filter((c) => c.verdict === 'NOT_VALIDATED');
  const notApplicable = criteria.filter((c) => c.verdict === 'NOT_APPLICABLE');

  const unmetCritical = [...notMet, ...notValidated]
    .filter((c) => critical.has(c.criterion))
    .map((c) => c.criterion);

  /*
   * INDETERMINATE is the case where completion cannot be *judged*: nothing failed, and the
   * evidence a verdict needed was unobtainable. It is distinguished by every unmet criterion
   * being NOT_VALIDATED rather than NOT_MET, and by there being nowhere in this graph to
   * route back to — a criterion no stage owns cannot be obtained by running a stage again.
   */
  const unobtainable = notValidated.filter(
    (c) => stageOwning(input.policies, c.criterion, input.graphStages) === null,
  );

  let verdict: CompletionVerdict;
  let routeBackTo: TemplateStage | null = null;

  if (unmetCritical.length === 0 && notMet.length === 0 && notValidated.length === 0) {
    verdict = 'COMPLETE';
    rationale.push(
      `every applicable criterion is MET (${met.length} met, ${notApplicable.length} not applicable)`,
    );
  } else if (
    unmetCritical.length > 0
    && unmetCritical.every((c) => unobtainable.some((u) => u.criterion === c))
  ) {
    verdict = 'INDETERMINATE';
    rationale.push(
      `completion cannot be judged: critical criteria ${unmetCritical.join(', ')} are `
      + 'NOT_VALIDATED and no stage in this graph owns them, so the evidence is unobtainable '
      + 'with this run\'s access. "We could not check" is not "we checked and accepted a gap"',
    );
  } else if (unmetCritical.length > 0) {
    verdict = 'INCOMPLETE';
    /*
     * The first unmet critical criterion **some stage in this graph owns**.
     *
     * Not simply the first unmet one: criterion 1 is owned by no template stage — the prologue
     * supplies it — so taking the numerically first would route back to `null` whenever a
     * prologue criterion is among the unmet, which is exactly the run that most needs to route
     * back. "Routes back into the graph at the stage owning the missing verdicts" names a
     * stage, so the criterion chosen has to be one a stage owns.
     */
    routeBackTo = unmetCritical
      .map((criterion) => stageOwning(input.policies, criterion, input.graphStages))
      .find((stage) => stage !== null) ?? null;
    rationale.push(
      `critical criteria ${unmetCritical.join(', ')} are not met. NOT_VALIDATED is never MET, `
      + 'so the run routes back to the stage that owes the verdicts rather than declaring '
      + 'completion',
    );
  } else {
    verdict = 'COMPLETE_WITH_GAPS';
    rationale.push(
      `every critical criterion is MET, and ${notMet.length + notValidated.length} `
      + 'non-critical criteria are not. Requires human acknowledgement',
    );
  }

  const gaps = [...notMet, ...notValidated].map(
    (c) => `criterion ${c.criterion} (${owners.get(c.criterion)?.name ?? 'unnamed'}): `
      + `${c.verdict}${c.reason === null ? '' : ` — ${c.reason}`}`,
  );

  if (input.sourceDrift?.state === 'CHANGED') {
    /*
     * Disclosure rather than chasing. The verdict is computed against the admitted work item,
     * because that is what was actually done, and the reader is told the request has moved.
     */
    gaps.push(
      'the intake source has been edited since admission; the verdict is computed against the '
      + 'admitted work item, which is what was actually done',
    );
  }

  return {
    report: {
      work_item_id: input.workItemId,
      run_id: input.runId,
      profile_id: input.profileId,
      verdict,
      criteria,
      unmet_critical: unmetCritical,
      not_validated: notValidated.map((c) => c.criterion),
      gaps,
      route_back_to: routeBackTo,
      source_drift: input.sourceDrift,
      computed_at: input.computedAt,
    },
    rationale,
  };
}

/**
 * The effective profile for a run.
 *
 * The template carries a default and the work item carries the profiles its outcome binds
 * to. Where the default is among them it wins, because the template was selected for this
 * kind of work; where it is not, the first candidate does, deterministically, and the choice
 * is recorded. Picking by preference rather than by rule would make the evidence bar depend
 * on which component happened to answer first.
 */
export function effectiveProfile(
  templateDefault: DodProfileId,
  candidates: readonly DodProfileId[],
): { readonly profile: DodProfileId; readonly reason: string } {
  if (candidates.includes(templateDefault)) {
    return {
      profile: templateDefault,
      reason: `the template's default profile is among the work item's candidates`,
    };
  }
  const first = [...candidates].sort()[0];
  if (first === undefined) {
    return {
      profile: templateDefault,
      reason: 'the work item bound to no profile, so the template default stands',
    };
  }
  return {
    profile: first,
    reason:
      `the template default ${templateDefault} is not among the work item's candidates `
      + `(${candidates.join(', ')}), so the first candidate in a deterministic order applies`,
  };
}

/** Does this verdict count as met? One function, so there is one answer. */
export function countsAsMet(verdict: DodVerdict): boolean {
  return verdict === 'MET';
}

/** The criteria a profile expects a verdict for, after its default exclusions. */
export function expectedCriteria(profile: DodProfile): readonly DodCriterionId[] {
  const excluded = new Set(profile.not_applicable_by_default.map((n) => n.criterion));
  return profile.criteria.filter((c) => !excluded.has(c));
}

/** Every criterion a profile set defines, for the loader and the reports. */
export function allCriteria(dod: DodPolicySet): readonly DodCriterionId[] {
  return dod.criteria.map((c) => c.criterion).sort((a, b) => a - b);
}
