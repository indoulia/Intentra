import type { Event, WorkItem } from '@agentos/contracts';
import type { Projection } from './recovery.js';

/**
 * The observability projections.
 *
 * All three are pure functions of the event log. **If a run's story cannot be told from the
 * log alone, the log is deficient — that is a kernel bug, not a documentation gap.**
 *
 * The narrative gains one obligation in v0.3, and it is the mitigation for the residual risk
 * the freeze carries forward: **it must state what AgentOS decided the work was, and why.**
 * A run that misread its intake and then executed flawlessly is the new failure mode this
 * layer introduces, and it is invisible unless resolution is narrated alongside execution.
 * So the narrative opens with the resolution and its evidence, and not with the first
 * dispatch.
 *
 * The answerability test is the standard: at any moment a human must be able to ask "what is
 * AgentOS doing right now, why, on what evidence, and what will it do next?" and get an
 * accurate answer from durable state — not from a model's recollection.
 */

export interface NarrativeSection {
  readonly heading: string;
  readonly lines: readonly string[];
}

export interface Narrative {
  readonly sections: readonly NarrativeSection[];
  readonly text: string;
}

/** Renders the run narrative from the log. */
export function narrate(
  events: readonly Event[],
  workItem: WorkItem | null,
): Narrative {
  const sections: NarrativeSection[] = [];

  sections.push(resolutionSection(events, workItem));
  sections.push(realitySection(events));
  sections.push(selectionSection(events));
  sections.push(skippedSection(events));
  sections.push(executionSection(events));
  sections.push(disbeliefSection(events));
  sections.push(authorizationSection(events));
  sections.push(completionSection(events));

  const guarded = sections.map((section) => ({
    heading: section.heading,
    lines: section.lines.map(withoutDanglingColon).filter((line) => line.length > 0),
  }));
  const populated = guarded.filter((section) => section.lines.length > 0);
  const text = populated
    .map((section) => `## ${section.heading}\n\n${section.lines.map((l) => `- ${l}`).join('\n')}`)
    .join('\n\n');

  return { sections: populated, text };
}

/**
 * A line that promised a reason and then supplied none.
 *
 * Rendering a list that turned out to be empty leaves `…: ` dangling, and a sentence that
 * stops mid-clause reads as a run that stopped for no reason. Every caller below states its
 * own reason where it has one; this is the structural backstop that keeps a missing one from
 * reaching a reader as a half-sentence rather than as a visible gap.
 */
function withoutDanglingColon(line: string): string {
  return line.replace(/\s*[:—-]\s*$/, '').trimEnd();
}

/**
 * What AgentOS decided the work was, and why. First, always.
 *
 * This is the section the narrative exists for. A reader who stops after it should be able to
 * tell whether the run was about the right thing.
 */
function resolutionSection(
  events: readonly Event[],
  workItem: WorkItem | null,
): NarrativeSection {
  const lines: string[] = [];

  const intake = events.find((e) => e.event === 'intake_recorded');
  if (intake !== undefined) {
    const record = intake.data;
    lines.push(
      `the request arrived as ${record.source} from ${record.principal.id} `
      + `(asserted by ${record.principal.asserted_by}), trust class ${record.trust_class}`,
    );
    lines.push(
      `it is re-readable at ${record.source_locator.adapter}.`
      + `${String(record.source_locator.op)}, so "the ticket said X" is checkable rather than `
      + 'remembered',
    );
    const excerpt = record.raw.replace(/\s+/g, ' ').trim().slice(0, 200);
    lines.push(`verbatim: "${excerpt}${record.raw.length > 200 ? '…' : ''}"`);
  }

  const attempts = events.filter((e) => e.event === 'intake_instruction_attempt');
  for (const attempt of attempts) {
    lines.push(
      `the intake content attempted ${attempt.data.attempted.join(', ')} and had no effect: `
      + `intake is data, never instruction. Recorded because a party trying is worth knowing `
      + `about. Excerpt: "${attempt.data.excerpt}"`,
    );
  }

  const admitted = events.find((e) => e.event === 'work_item_admitted');
  if (admitted !== undefined) {
    const item = admitted.data.work_item;
    lines.push(
      `**AgentOS decided this is a ${item.type}**: "${item.title}", scoped to `
      + (item.scope.paths.join(', ') || 'no paths')
      + (item.scope.capabilities.length > 0
        ? ` and ${item.scope.capabilities.join(', ')}`
        : ''),
    );
    lines.push(`the outcome it is pursuing: ${item.desired_outcome}`);
    if (admitted.data.type_downgraded && item.claimed_type !== null) {
      lines.push(
        `resolution claimed ${item.claimed_type} and the kernel admitted UNKNOWN: the type was `
        + 'asserted without its minimum evidence. The claimed type is recorded and the run '
        + 'routes to the read-only investigation template, which is the safe thing to do when '
        + 'you do not know what you are looking at',
      );
    }
    if (item.external_identity !== null) {
      lines.push(
        `its external identity ${item.external_identity} was fetched through the adapter, not `
        + 'accepted from the claim',
      );
    }
    if (item.duplicate_candidates.length > 0) {
      lines.push(
        `${item.duplicate_candidates.length} candidate duplicate(s) were surfaced and not `
        + `merged: ${item.duplicate_candidates.join(', ')}. Merging two work items is a `
        + 'judgment, and a wrong merge destroys history',
      );
    }
    for (const check of admitted.data.checks) {
      if (check.result === 'PASS') continue;
      lines.push(`admission check ${check.check}: ${check.result} — ${check.detail}`);
    }
  }

  const rejected = events.filter((e) => e.event === 'work_item_rejected');
  for (const event of rejected) {
    /*
     * Every check that stopped the proposal, not only the ones that failed.
     *
     * An unreachable external identity records INDETERMINATE — the source could not be
     * reached, so nothing was established either way — and rendering FAIL alone left this line
     * ending in a colon with nothing after it. A blocked run whose narrative does not say why
     * is exactly the failure the narrative obligation exists to prevent: unknown state read as
     * a run that stopped for no stated reason.
     */
    const reasons = event.data.checks
      .filter((c) => c.result === 'FAIL' || c.result === 'INDETERMINATE')
      .map((c) => `${c.check} ${c.result} — ${c.detail}`);
    const what = event.data.next === 'BLOCKED'
      ? `the resolution proposal on attempt ${event.data.attempt} was not admitted and the run `
        + 'blocked rather than being refused: the request is admissible and something it '
        + 'depends on is not'
      : `a resolution proposal was refused on attempt ${event.data.attempt} and `
        + `${event.data.next.toLowerCase()} followed`;
    lines.push(
      `${what}: `
      + (reasons.length > 0
        ? reasons.join('; ')
        : 'no admission check recorded a reason, which is itself the finding — a stop the log '
          + 'cannot account for is a kernel defect, not a quiet success'),
    );
  }

  const reresolved = events.filter((e) => e.event === 'reresolved');
  for (const event of reresolved) {
    lines.push(
      `the work turned out to be something else (${event.data.count} of ${event.data.cap}): `
      + `${event.data.reason}. This run ended RERESOLVED and a new one started against the `
      + 'same Work Item — identity, history and every prior envelope survive; only the graph '
      + 'is new',
    );
  }

  const understood = events.find((e) => e.event === 'understood_computed');
  if (understood !== undefined) {
    lines.push(
      `understanding was computed ${understood.data.verdict}: understanding is sufficient `
      + 'exactly when the workflow decision is determinate, and no agent supplies that verdict',
    );
    for (const condition of understood.data.conditions) {
      if (condition.result === 'PASS') continue;
      lines.push(`  ${condition.check}: ${condition.result} — ${condition.detail}`);
    }
    if (understood.data.undetermined_predicates.length > 0) {
      lines.push(
        `undetermined: ${understood.data.undetermined_predicates.join(', ')} — each names the `
        + 'discovery that would resolve it',
      );
    }
  }

  const questions = events.filter((e) => e.event === 'question');
  for (const event of questions) {
    lines.push(
      `a question was ${event.data.phase.toLowerCase()}: "${event.data.question}" with `
      + `${event.data.readings.length} readings and what AgentOS would do under each`
      + (event.data.answer === null ? '' : `. Answer: ${event.data.answer}`),
    );
  }

  if (lines.length === 0 && workItem !== null) {
    lines.push(
      `the work item is a ${workItem.type}: "${workItem.title}". Its resolution is recorded in `
      + 'an earlier run',
    );
  }

  return { heading: 'What AgentOS decided the work was, and why', lines };
}

/** What reality it found, from adapters or UNKNOWN. */
function realitySection(events: readonly Event[]): NarrativeSection {
  const lines: string[] = [];

  for (const event of events) {
    if (event.event !== 'discovery') continue;
    lines.push(
      event.data.kind.toLowerCase().replace(/_/g, ' ')
      + (event.data.tier === null ? '' : ` at tier ${event.data.tier}`)
      + `: ${event.data.reason}`
      + (event.data.probes.length > 0 ? ` (${event.data.probes.join(', ')})` : ''),
    );
  }

  for (const event of events) {
    if (event.event !== 'context_package_versioned') continue;
    lines.push(
      `Context Package v${event.data.version} at tier ${event.data.tier}`
      + (event.data.supersedes === null ? '' : `, superseding v${event.data.supersedes}`)
      + '. The package is versioned rather than appended, so an agent reads one version',
    );
  }

  for (const event of events) {
    if (event.event !== 'predicate_evaluated') continue;
    if (!event.data.reprobed) continue;
    lines.push(
      `${event.data.predicate} was evaluated after re-probing a stale element: reality is `
      + 're-probed rather than snapshotted, because a review comment arriving mid-run would '
      + 'otherwise be invisible for the rest of it',
    );
  }

  return { heading: 'What reality it found', lines };
}

/** Which template was selected and why, and every override. */
function selectionSection(events: readonly Event[]): NarrativeSection {
  const lines: string[] = [];

  for (const event of events) {
    if (event.event !== 'workflow_admitted') continue;
    const graph = event.data.graph;
    lines.push(
      `template ${graph.template_id} version ${graph.template_version} was admitted from `
      + `${event.data.admissible_templates.length} admissible option(s), entering at `
      + `${graph.entry}. Risk class ${graph.risk_class}`,
    );
    lines.push(`stages: ${graph.stages.join(' -> ')}`);
    for (const exclusion of graph.excluded_stages) {
      lines.push(
        `${exclusion.stage} was excluded: the kernel evaluated ${exclusion.predicate} FALSE. `
        + 'Exclusion requires that, and TRUE or INDETERMINATE keeps the stage',
      );
    }
  }

  for (const event of events) {
    if (event.event !== 'workflow_override') continue;
    lines.push(
      `the proposed template ${String(event.data.proposed_template)} was refused and `
      + `${event.data.selected_template} selected instead: ${event.data.reason}`,
    );
    for (const check of event.data.failed_checks) {
      lines.push(`  ${check.check}: ${check.detail}`);
    }
  }

  for (const event of events) {
    if (event.event !== 'selection') continue;
    lines.push(
      `${event.data.kind.toLowerCase()} ${String(event.data.selected)}: ${event.data.why}`
      + (event.data.escalated_from === null
        ? ''
        : ` (escalated from ${event.data.escalated_from} because `
          + `${String(event.data.escalation_trigger)})`),
    );
  }

  return { heading: 'Which workflow it selected, and why', lines };
}

/** What was skipped as already done, and what that does not mean. */
function skippedSection(events: readonly Event[]): NarrativeSection {
  const lines: string[] = [];

  for (const event of events) {
    if (event.event !== 'entry_stage_computed') continue;
    lines.push(
      `the entry stage was computed as ${String(event.data.entry_stage)} by walking the frozen `
      + 'graph against Current Reality. No agent proposes it and the intake never implies it',
    );
    for (const step of event.data.walk) {
      lines.push(
        `  ${step.stage}: ${String(step.satisfied_by)} = ${step.evaluated} -> ${step.decision}`,
      );
    }
  }

  const prior = events.filter((e) => e.event === 'stage_marked_completed_prior');
  if (prior.length > 0) {
    lines.push(
      `${prior.length} stage(s) were marked COMPLETED_PRIOR. **That means the mutation each `
      + 'performs has already occurred, not that its criteria are met**: a skipped stage '
      + 'supplies no verdicts, so its criteria are NOT_VALIDATED, and NOT_VALIDATED is never '
      + 'MET. A wrong resume costs a lap and cannot manufacture a COMPLETE',
    );
    for (const event of prior) {
      lines.push(
        `  ${event.data.marked_stage}: ${event.data.predicate} held, on evidence `
        + (event.data.evidence.join(', ') || '(none recorded)'),
      );
    }
  }

  return { heading: 'What it skipped as already done', lines };
}

/** What was discovered, decided, built, failed and reworked, in order. */
function executionSection(events: readonly Event[]): NarrativeSection {
  const lines: string[] = [];

  for (const event of events) {
    switch (event.event) {
      case 'dispatch_intent':
        lines.push(
          `dispatched ${event.data.input_package.agent} in `
          + `${event.data.input_package.stage} (attempt ${event.data.attempt}) with `
          + `${event.data.input_package.tools_granted.length} granted tool(s) and the model `
          + event.data.input_package.model,
        );
        break;
      case 'dispatch_result':
        if (event.data.outcome === 'ENVELOPE') break;
        lines.push(
          `the dispatch ${event.data.outcome.toLowerCase()}: `
          + `${String(event.data.failure_reason)} — ${event.data.detail}`,
        );
        break;
      case 'transition':
        lines.push(
          `${event.data.from} -> ${event.data.to} on ${event.data.trigger} `
          + `(${event.data.edge_kind})`
          + (event.data.overridden
            ? `. The agent proposed ${String(event.data.proposed_stage)}; the kernel evaluated `
              + 'the predicate itself and overrode it'
            : ''),
        );
        break;
      case 'mutation':
        lines.push(
          `mutation: ${event.data.adapter}.${event.data.op} on ${event.data.target}`
          + (event.data.reversal === null
            ? ' — declared non-reversible, so this dispatch is never automatically retried'
            : ` (reversible by ${event.data.reversal.op})`),
        );
        break;
      case 'budget':
        if (event.data.kind !== 'EXCEEDED') break;
        lines.push(
          `the ${event.data.counter} budget was exceeded per ${event.data.scope}: `
          + `${event.data.value} against ${String(event.data.cap)}. Exceeding a cap is BLOCKED, `
          + 'never a quiet retry',
        );
        break;
      case 'recovery':
        lines.push(
          `recovery ${event.data.phase.toLowerCase().replace(/_/g, ' ')}: ${event.data.detail}`
          + (event.data.discarded_bytes > 0
            ? ` (${event.data.discarded_bytes} byte(s) of a torn write discarded)`
            : ''),
        );
        break;
      case 'dispatch_rollback':
        lines.push(
          `the interrupted dispatch ${event.data.rolled_back_dispatch} was rolled back: `
          + `${event.data.reversed.length} mutation(s) reversed in reverse order`
          + (event.data.blocked_non_reversible
            ? '. It performed a non-reversible operation, so the run blocked rather than '
              + 'repeating it'
            : `, and it re-dispatched as ${String(event.data.new_dispatch_id)} with fresh `
              + 'dispatch keys'),
        );
        break;
      case 'child_work_item':
        lines.push(
          `child work item ${event.data.action.toLowerCase()}: `
          + `${String(event.data.child_id)} — ${event.data.reason}`,
        );
        break;
      case 'conflict':
        lines.push(
          `conflict on ${event.data.subject}: ${event.data.phase.toLowerCase().replace(/_/g, ' ')}`
          + (event.data.rule === null ? '' : ` by rule (${event.data.rule})`)
          + `, winner ${event.data.winner}`,
        );
        break;
      case 'lease':
        if (event.data.action === 'ACQUIRED') break;
        lines.push(
          `the run lease was ${event.data.action.toLowerCase()}`
          + (event.data.active_run_id === null
            ? ''
            : `; ${event.data.active_run_id} holds it`)
          + (event.data.abandoned_run_id === null
            ? ''
            : `; ${event.data.abandoned_run_id} was abandoned`),
        );
        break;
      default:
        break;
    }
  }

  return { heading: 'What it discovered, decided, built and reworked', lines };
}

/** What the kernel refused to take on trust, and what happened as a result. */
function disbeliefSection(events: readonly Event[]): NarrativeSection {
  const lines: string[] = [];

  for (const event of events) {
    switch (event.event) {
      case 'envelope_rejected':
        lines.push(
          `envelope ${String(event.data.envelope_id)} was rejected at the `
          + `${event.data.step.replace(/_/g, ' ')} step: `
          + event.data.violations.map((v) => `${v.code} — ${v.message}`).join('; '),
        );
        break;
      case 'contract_violation':
        lines.push(`contract violation ${event.data.code}: ${event.data.message}`);
        break;
      case 'evidence_integrity':
        lines.push(
          `evidence ${event.data.evidence_id} came back ${event.data.status} against the model `
          + event.data.model
          + (event.data.demoted_findings.length > 0
            ? `; ${event.data.demoted_findings.join(', ')} lost their last verified evidence `
              + 'and demoted to hypotheses'
            : '')
          + (event.data.envelope_rejected
            ? '. The whole envelope was rejected: one fabrication is a defect, two is an '
              + 'untrustworthy witness'
            : ''),
        );
        break;
      case 'security_violation':
        lines.push(
          `**security violation**: ${event.data.adapter}.${event.data.op} on `
          + `${event.data.requested} was refused by the ${event.data.rule} rule`
          + (event.data.aborted_dispatch
            ? '. The dispatch was aborted immediately, and this is reported regardless of the '
              + "run's outcome — an agent that attempted it is worth knowing about even if it "
              + 'failed'
            : ''),
        );
        break;
      case 'scope_violation':
        lines.push(
          `scope violation: ${event.data.requested} falls outside the dispatch's mandate `
          + `(${event.data.rule})`,
        );
        break;
      case 'idempotency':
        lines.push(
          `idempotency ${event.data.verdict.toLowerCase().replace(/_/g, ' ')} on `
          + `${event.data.adapter}.${event.data.op}`
          + (event.data.reread === null
            ? ''
            : `, external resource ${event.data.reread.toLowerCase()}`)
          + `: ${event.data.detail}`,
        );
        break;
      case 'tool_surface_conformance':
        if (event.data.verdict === 'CONFORMS') break;
        lines.push(
          `**the tool surface did not conform**: ${event.data.verdict}. `
          + (event.data.unexpected.length > 0
            ? `unexpected tools ${event.data.unexpected.join(', ')}. `
            : '')
          + (event.data.missing.length > 0
            ? `missing tools ${event.data.missing.join(', ')}. `
            : '')
          + event.data.detail,
        );
        break;
      case 'predicate_evaluated':
        if (event.data.claim === null) break;
        lines.push(
          `${event.data.predicate} evaluated ${event.data.evaluated} and the agent claimed `
          + `"${event.data.claim}". Both are recorded, so a systematically over-claiming agent `
          + 'becomes visible',
        );
        break;
      default:
        break;
    }
  }

  return { heading: 'What the kernel refused to take on trust', lines };
}

/** Gates, requests and decisions. */
function authorizationSection(events: readonly Event[]): NarrativeSection {
  const lines: string[] = [];
  for (const event of events) {
    switch (event.event) {
      case 'gate_fired':
        lines.push(
          `the ${event.data.gate} gate fired on ${event.data.target} by `
          + event.data.trigger.replace(/_/g, ' ')
          + (event.data.classification === null
            ? ''
            : `; ${event.data.classification.kind} classified `
              + event.data.classification.value
              + (event.data.classification.failed_closed
                ? ' because the probe could not establish it, which is why a run that was '
                  + 'conservative because it was blind is distinguishable from one that was '
                  + 'conservative because the target really was production'
                : '')),
        );
        break;
      case 'authorization_requested':
        lines.push(
          `authorization requested for ${event.data.draft.gate} on ${event.data.draft.target}: `
          + `${event.data.draft.what}. Blast radius: ${event.data.draft.blast_radius}. `
          + `Reversible by ${event.data.draft.reversibility.how} `
          + `(${event.data.draft.reversibility.verified ? 'verified' : 'unverified'})`,
        );
        break;
      case 'authorization_decided':
        lines.push(
          `authorization ${event.data.decision.toLowerCase()} by `
          + `${String(event.data.decided_by)}: ${event.data.reason}`
          + (event.data.decision === 'DENIED'
            ? '. Recorded at the work item level, so starting a fresh run is not a way to ask '
              + 'again'
            : ''),
        );
        break;
      default:
        break;
    }
  }
  return { heading: 'What needed a human, and what a human decided', lines };
}

/** How completion was judged. */
function completionSection(events: readonly Event[]): NarrativeSection {
  const lines: string[] = [];

  for (const event of events) {
    if (event.event !== 'source_drift') continue;
    lines.push(
      `the intake source is ${event.data.state}: ${event.data.detail}`,
    );
  }

  for (const event of events) {
    if (event.event !== 'dod_computed') continue;
    const report = event.data;
    lines.push(
      `the Definition of Done computed **${report.verdict}** against the `
      + `${report.profile_id} profile`,
    );
    for (const criterion of report.criteria) {
      if (criterion.verdict === 'MET') continue;
      lines.push(
        `  criterion ${criterion.criterion} is ${criterion.verdict}`
        + (criterion.reason === null ? '' : `: ${criterion.reason}`)
        + ` (owned by ${criterion.owner_role})`,
      );
    }
    if (report.route_back_to !== null) {
      lines.push(
        `it routes back to ${report.route_back_to}, which owes the missing verdicts. `
        + 'NOT_VALIDATED is never MET, so the cursor has no authority over completion',
      );
    }
    for (const gap of report.gaps) lines.push(`  gap: ${gap}`);
  }

  for (const event of events) {
    if (event.event !== 'work_item_lifecycle') continue;
    lines.push(
      `the work item moved ${event.data.from} -> ${event.data.to} `
      + `(decided by ${event.data.decided_by}): ${event.data.reason}`,
    );
  }

  for (const event of events) {
    if (event.event !== 'run_ended') continue;
    lines.push(`the run ended ${event.data.outcome}: ${event.data.detail}`);
  }

  return { heading: 'How completion was judged', lines };
}

/**
 * The live view: what AgentOS is doing right now, why, on what evidence, and what next.
 *
 * A projection over the log rather than a status a component reports, so it cannot disagree
 * with what actually happened.
 */
export function liveView(
  projection: Projection,
  events: readonly Event[],
  workItem: WorkItem | null,
): readonly string[] {
  const lines: string[] = [];

  if (workItem !== null) {
    lines.push(`work item ${workItem.work_item_id}: ${workItem.type} — "${workItem.title}"`);
    lines.push(`lifecycle ${workItem.lifecycle}`);
  }

  lines.push(`stage ${projection.currentStage}`);
  if (projection.preBlockStage !== null) {
    lines.push(
      `blocked; the pre-block stage is ${projection.preBlockStage}, so a grant or an answer `
      + 'resumes the run in place',
    );
  }
  if (projection.graph !== null) {
    lines.push(
      `graph ${projection.graph.template_id} v${projection.graph.template_version}, risk class `
      + projection.graph.risk_class,
    );
    const marked = projection.cursor.map((entry) => {
      const suffix = entry.state === 'COMPLETED_PRIOR'
        ? ' (already done)'
        : entry.state === 'ACTIVE' ? ' <- here' : '';
      return `${entry.stage}${suffix}`;
    });
    lines.push(`cursor: ${marked.join(' -> ')}`);
  }

  const lastDispatch = [...events].reverse().find((e) => e.event === 'dispatch_intent');
  if (lastDispatch !== undefined) {
    lines.push(
      `last dispatch: ${lastDispatch.data.input_package.agent} with model `
      + `${lastDispatch.data.input_package.model}, objective `
      + `"${lastDispatch.data.input_package.mandate.objective}"`,
    );
  }

  if (projection.pendingAuthorizations.length > 0) {
    lines.push(`awaiting ${projection.pendingAuthorizations.length} authorization(s)`);
  }
  for (const [counter, value] of Object.entries(projection.loopCounters)) {
    if (value === 0) continue;
    lines.push(`${counter} loop: ${value}`);
  }
  lines.push(
    `consumed: ${projection.consumedBudget.dispatches} dispatch(es), `
    + `${projection.consumedBudget.input_tokens} in / `
    + `${projection.consumedBudget.output_tokens} out, `
    + `${projection.consumedBudget.usd.toFixed(2)} usd`,
  );
  if (projection.outcome !== null) lines.push(`outcome ${projection.outcome}`);

  return lines;
}

/** The work item view: where this piece of work stands across attempts. */
export function workItemView(
  workItem: WorkItem,
  events: readonly Event[],
): readonly string[] {
  const lines: string[] = [
    `${workItem.work_item_id}: ${workItem.type} — "${workItem.title}"`,
    `lifecycle ${workItem.lifecycle}`,
    `outcome sought: ${workItem.desired_outcome}`,
    `scope: ${workItem.scope.paths.join(', ') || 'no paths'}`,
  ];

  if (workItem.claimed_type !== null) {
    lines.push(
      `resolution claimed ${workItem.claimed_type}; admitted as ${workItem.type} for want of `
      + 'the claimed type\'s minimum evidence',
    );
  }

  for (const event of events) {
    if (event.event === 'run_started') {
      lines.push(`run ${event.data.run_id} started (${event.data.reason.toLowerCase()})`);
    }
    if (event.event === 'run_ended') {
      lines.push(`  ended ${event.data.outcome}: ${event.data.detail}`);
    }
    if (event.event === 'child_work_item') {
      lines.push(
        `child ${event.data.action.toLowerCase()}: ${String(event.data.child_id)}`,
      );
    }
  }

  for (const link of workItem.links) {
    lines.push(`link ${link.kind} -> ${link.target}`);
  }
  for (const denial of workItem.denied_gates) {
    lines.push(
      `${denial.gate} was denied on ${denial.target} at ${denial.denied_at} by `
      + `${denial.denied_by}: ${denial.reason}. A denial is cleared by new information or by a `
      + 'human revisiting it, never by a retry',
    );
  }
  if (workItem.reresolution_count > 0) {
    lines.push(`re-resolved ${workItem.reresolution_count} time(s)`);
  }

  return lines;
}
