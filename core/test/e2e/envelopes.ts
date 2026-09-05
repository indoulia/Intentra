import {
  fixtures as fx,
  type CriterionVerdict,
  type Evidence,
  type HandoffEnvelope,
  type ProposedWorkItem,
  type ResolutionAlternative,
  type WorkItemType,
  type WorkflowProposal,
} from '@agentos/contracts';

/**
 * The envelopes the scripted substrate hands back, built for a *real* repository.
 *
 * `core/test/doubles.ts` already has envelope fixtures and they are reused wherever they fit.
 * These exist for the one thing those cannot do: carry evidence whose locator the real
 * adapter framework will actually re-execute against a real scratch worktree, and whose
 * excerpt therefore has to be the file's real bytes rather than a constant two fixtures agree
 * on. Evidence that does not survive replay is withdrawn from the pool the type minimums are
 * judged against, so getting this right is the difference between a scenario that tests
 * admission and one that tests the downgrade path by accident.
 */

/** Evidence naming a real file in the scratch repository, with its real content. */
export function fileEvidence(id: string, path: string, content: string): Evidence {
  return fx.evidence({
    id,
    kind: 'file',
    locator: { adapter: 'repo', op: 'read_file', args: { path } },
    ref: path,
    excerpt: content,
    reproducible: true,
  });
}

/** Evidence naming an external item, as the project-management adapter returns it. */
export function ticketEvidence(id: string, key: string, issue: unknown): Evidence {
  return fx.evidence({
    id,
    kind: 'ticket',
    locator: { adapter: 'pm', op: 'read_issue', args: { key } },
    ref: key,
    excerpt: JSON.stringify(issue),
    reproducible: true,
  });
}

/** Evidence naming a pull request, as the git adapter returns it. */
export function pullRequestEvidence(id: string, number: number, excerpt: string): Evidence {
  return fx.evidence({
    id,
    kind: 'git',
    locator: { adapter: 'git', op: 'read_pr', args: { id: String(number) } },
    ref: `#${number}`,
    excerpt,
    reproducible: true,
  });
}

export interface ResolutionInput {
  readonly type: WorkItemType;
  readonly intent: string;
  readonly title: string;
  readonly desiredOutcome: string;
  readonly scopePaths: readonly string[];
  /** The external item this work definitionally is, or `null`. */
  readonly identity?: string | null;
  readonly evidence: readonly Evidence[];
  /** Which evidence ids the FACT-confidence fields cite. */
  readonly cites: readonly string[];
  readonly confidence?: number;
  readonly alternatives?: readonly ResolutionAlternative[];
  readonly scopeExamined?: readonly string[];
  readonly parent?: string | null;
}

/** A resolution envelope over real evidence. */
export function resolution(input: ResolutionInput): HandoffEnvelope {
  const cites = [...input.cites];
  const proposal: ProposedWorkItem = {
    source_intake: 'in_0001',
    intent: fx.inferenceAssertion(input.intent, { probe: 'resolution' }),
    type: cites.length > 0
      ? fx.factAssertion(input.type, { evidence: cites, probe: 'resolution' })
      : fx.inferenceAssertion(input.type, { probe: 'resolution' }),
    external_identity: input.identity === undefined || input.identity === null
      ? fx.unknownAssertion({ reason: 'NOT_APPLICABLE', recoverable_by: 'name a ticket key' })
      : fx.factAssertion(input.identity, { evidence: cites, probe: 'pm.read_issue' }),
    title: cites.length > 0
      ? fx.factAssertion(input.title, { evidence: cites, probe: 'resolution' })
      : fx.inferenceAssertion(input.title, { probe: 'resolution' }),
    desired_outcome: fx.inferenceAssertion(input.desiredOutcome, { probe: 'resolution' }),
    scope: {
      paths: [...input.scopePaths],
      capabilities: [],
      repositories: ['subject'],
      confidence: 'FACT',
    },
    constraints: [],
    dependencies: [],
    parent: input.parent === undefined || input.parent === null
      ? fx.unknownAssertion({ reason: 'NOT_APPLICABLE', recoverable_by: 'name a parent item' })
      : fx.factAssertion(input.parent, { evidence: cites, probe: 'pm.read_issue' }),
    resolution_confidence: input.confidence ?? 0.9,
    alternatives: [...(input.alternatives ?? [])],
  };
  return fx.envelope({
    envelope_id: 'env_resolution',
    agent: 'context-discovery',
    stage_in: 'RESOLUTION',
    outputs: { proposed_work_item: 'inline' },
    coverage: fx.coverage({
      scope_examined: [...(input.scopeExamined ?? input.scopePaths)],
    }),
    proposals: { work_item: proposal },
    evidence: [...input.evidence],
  });
}

/**
 * The `context` mandate's envelope, answered at `CONTEXT_DISCOVERY`.
 *
 * The prologue dispatches this in every run, after admission, and it is the only owner of
 * Definition-of-Done criterion 1 — so it is where "context understood" enters the completion
 * report at all. Its outputs are the four `agents/src/roles/specs.ts` declares for the mandate;
 * a `COMPLETE` envelope with one of them unfilled is refused, and rightly.
 *
 * Note what it does *not* do. `current_reality` here is the agent's account of the package it
 * was given, not a source for it: the probes wrote reality before this dispatch and the kernel
 * merges nothing back. A scenario proving that is in `scenarios-reality.test.ts`.
 */
export function context(input: {
  readonly evidence: readonly Evidence[];
  readonly scopeExamined: readonly string[];
  /**
   * The criterion-1 verdict. `MET` is honest only where the agent actually reached the scope;
   * a run whose sources would not answer owes `NOT_VALIDATED` with the reason, and scenario 15
   * is exactly that case.
   */
  readonly verdict?: Partial<CriterionVerdict>;
  readonly overrides?: Partial<HandoffEnvelope>;
}): HandoffEnvelope {
  const ids = input.evidence.map((entry) => entry.id);
  const verdict: CriterionVerdict = {
    criterion: 1,
    verdict: 'MET',
    reason: null,
    evidence: ids,
    capability: null,
    ...input.verdict,
  };
  return fx.envelope({
    envelope_id: 'env_context',
    agent: 'context-discovery',
    stage_in: 'CONTEXT_DISCOVERY',
    summary:
      'the admitted scope was read, the Context Package the probes built was reconciled '
      + 'against it, and what could not be discovered is recorded rather than filled in',
    outputs: {
      context_package: 'context/v1.json',
      reconciliation_matrix: 'context/v1.json#reconciliation',
      current_reality: 'context/v1.json#current_reality',
      discovery_gaps: 'context/v1.json#gaps',
    },
    coverage: fx.coverage({ scope_examined: [...input.scopeExamined] }),
    evidence: [...input.evidence],
    dod_verdicts: [verdict],
    next_action: null,
    ...input.overrides,
  });
}

/**
 * The Orchestrator's workflow proposal, answered at `WORKFLOW_SELECTED`.
 *
 * Every run reaches this dispatch, and what it may honestly say is narrow. It holds no
 * adapters, so it claims no repository coverage and cites no evidence; it may name a template
 * from the admissible set and nothing else, because a template the installation does not admit
 * is refused and overridden rather than run. In this build the admissible set for every type
 * has exactly one member, which is why the proposal below names it — the policy working, not
 * the fixture agreeing with itself. `exclude_optional` is empty because
 * `investigation.readonly` marks no stage optional, so there is nothing an exclusion could
 * legally ask for.
 *
 * The kernel is free to disagree with all of it, and the scenarios that make it disagree —
 * a template that does not exist, one outside the admissible set — override `proposal` here so
 * that the refusal is exercised against an otherwise honest envelope.
 */
export function workflow(input: {
  readonly proposal?: Partial<WorkflowProposal>;
  readonly overrides?: Partial<HandoffEnvelope>;
} = {}): HandoffEnvelope {
  const proposal: WorkflowProposal = {
    template_id: 'investigation.readonly',
    include_optional: [],
    exclude_optional: [],
    rationale:
      'the deliverable is findings over an existing system, nothing in the graph mutates, and '
      + 'the observed reality gives no reason to prefer a different reading of the work',
    ...input.proposal,
  };
  return fx.envelope({
    envelope_id: 'env_workflow',
    agent: 'orchestrator',
    stage_in: 'WORKFLOW_SELECTED',
    summary:
      'one template in the admissible set fits this work item and this observed reality, and '
      + 'the reasoning for it is stated over the evidence the dispatch was given',
    outputs: { rationale: 'inline' },
    coverage: fx.coverage({ scope_examined: ['(no adapters)'], confidence: 'INFERENCE' }),
    proposals: { workflow: proposal },
    next_action: null,
    ...input.overrides,
  });
}

/**
 * The AUDIT envelope of `investigation.readonly`, with its three required outputs filled.
 *
 * A stage that reports `COMPLETE` with a required output unfilled is rejected by the
 * cross-field rules, which is correct and which makes an under-filled fixture a test of the
 * rejection path rather than of the stage.
 */
export function audit(input: {
  readonly evidence: readonly Evidence[];
  readonly scopeExamined: readonly string[];
  readonly findings?: readonly ReturnType<typeof fx.finding>[];
  readonly overrides?: Partial<HandoffEnvelope>;
}): HandoffEnvelope {
  const ids = input.evidence.map((entry) => entry.id);
  return fx.envelope({
    envelope_id: 'env_audit',
    agent: 'auditor',
    stage_in: 'AUDIT',
    outputs: {
      capability_graph: 'capabilities/v1.json',
      findings_report: 'artifacts/findings.md',
      orphan_inventory: 'artifacts/orphans.md',
    },
    coverage: fx.coverage({ scope_examined: [...input.scopeExamined] }),
    evidence: [...input.evidence],
    findings: [...(input.findings ?? [])],
    dod_verdicts: [
      fx.criterionVerdict({ criterion: 3, evidence: ids }),
      fx.criterionVerdict({ criterion: 4, evidence: ids }),
    ],
    next_action: {
      proposed_stage: 'ROOT_CAUSE',
      proposed_agent: 'auditor',
      rationale: 'the audit found something worth explaining',
    },
    ...input.overrides,
  });
}

/** The ROOT_CAUSE envelope of `investigation.readonly`. */
export function rootCause(input: {
  readonly evidence: readonly Evidence[];
  readonly scopeExamined: readonly string[];
  readonly cause: string;
  readonly overrides?: Partial<HandoffEnvelope>;
}): HandoffEnvelope {
  return fx.envelope({
    envelope_id: 'env_root_cause',
    agent: 'auditor',
    stage_in: 'ROOT_CAUSE',
    outputs: {
      root_cause: input.cause,
      evidence_chain: input.evidence.map((entry) => entry.id).join(','),
    },
    coverage: fx.coverage({ scope_examined: [...input.scopeExamined] }),
    evidence: [...input.evidence],
    next_action: {
      proposed_stage: 'COMPLETION',
      proposed_agent: 'orchestrator',
      rationale: 'the cause is established and the deliverable is findings',
    },
    ...input.overrides,
  });
}

/**
 * The whole run, prologue included, as the substrate would answer it.
 *
 * The prologue's two Context Discovery mandates — `resolution` on tier-1 orientation and
 * `context` after admission — then `AUDIT -> ROOT_CAUSE -> COMPLETION`, with every dispatch
 * that claims coverage actually reading the files it claims to have examined. Every scenario
 * whose work is admitted runs this graph, because `investigation.readonly` is the only
 * template `policies/data/execution.json` admits in a build with `mutation_enabled: false` —
 * which is why it appears everywhere below: the policy working, not the fixture cheating.
 */
export function investigationGraph(input: {
  readonly resolution: HandoffEnvelope;
  readonly evidence: readonly Evidence[];
  readonly paths: readonly string[];
  readonly cause: string;
  /** The criterion-1 verdict the `context` mandate returns. `MET` unless stated otherwise. */
  readonly contextVerdict?: Partial<CriterionVerdict>;
  readonly contextOverrides?: Partial<HandoffEnvelope>;
  /** The Orchestrator's proposal, where a scenario wants the kernel to refuse one. */
  readonly workflowProposal?: Partial<WorkflowProposal>;
  readonly auditOverrides?: Partial<HandoffEnvelope>;
  readonly completionOverrides?: Partial<HandoffEnvelope>;
}): readonly HandoffEnvelope[] {
  return [
    input.resolution,
    context({
      evidence: [...input.evidence],
      scopeExamined: [...input.paths],
      ...(input.contextVerdict === undefined ? {} : { verdict: input.contextVerdict }),
      ...(input.contextOverrides === undefined ? {} : { overrides: input.contextOverrides }),
    }),
    workflow(input.workflowProposal === undefined ? {} : { proposal: input.workflowProposal }),
    audit({
      evidence: [...input.evidence],
      scopeExamined: [...input.paths],
      ...(input.auditOverrides === undefined ? {} : { overrides: input.auditOverrides }),
    }),
    rootCause({ evidence: [...input.evidence], scopeExamined: [...input.paths], cause: input.cause }),
    completion(input.completionOverrides ?? {}),
  ];
}

/** The COMPLETION envelope of `investigation.readonly`. */
export function completion(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return fx.envelope({
    envelope_id: 'env_completion',
    agent: 'orchestrator',
    stage_in: 'COMPLETION',
    outputs: { completion_report: 'decisions/completion.json', run_narrative: 'inline' },
    coverage: fx.coverage({ scope_examined: ['(no adapters)'], confidence: 'INFERENCE' }),
    next_action: null,
    ...overrides,
  });
}
