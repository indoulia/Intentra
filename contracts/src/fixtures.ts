import type {
  AdapterOperationDescriptor,
  AgentRole,
  Assertion,
  Blocker,
  BlockerKind,
  BlockerNeeds,
  CapabilityRecord,
  CapabilityStatus,
  ChainStage,
  ChainStageRecord,
  Coverage,
  CriterionVerdict,
  CurrentReality,
  DodVerdict,
  Evidence,
  EvidenceKind,
  EnvelopeStatus,
  Finding,
  FindingCategory,
  Freshness,
  HandoffEnvelope,
  InputPackage,
  IntakeRecord,
  IntakeSource,
  MutationEvent,
  ReconciliationState,
  Scope,
  Severity,
  Stage,
  TrustClass,
  UnknownRecord,
  WorkItem,
  WorkItemLifecycle,
  WorkItemType,
} from './generated/types.js';
import { sha256 } from './ids.js';

/**
 * Canonical builders for valid instances of every contract.
 *
 * Fixtures are the specification's test suite and are part of WP-1 rather than of a later
 * testing phase. They are built by function rather than stored as files for one reason: the
 * plan asks for a valid fixture per control-flow-bearing enum value, and a builder makes
 * "every value of this enum" a loop a test can close over the vocabulary. A file per value
 * would be a list to keep in step with the schema by hand, which is the failure the
 * generated types exist to avoid.
 *
 * Every default here is a *valid* value, never a plausible one: builders are for tests, and
 * a builder that quietly filled a required field with something meaningful-looking would
 * make a test pass for the wrong reason.
 */

export const T0 = '2026-09-04T10:00:00Z';
export const T1 = '2026-09-04T10:14:00Z';
export const T2 = '2026-09-04T10:41:00Z';

export const EMPTY_SCOPE: Scope = { paths: [], capabilities: [], repositories: [] };

export function scope(overrides: Partial<Scope> = {}): Scope {
  return { ...EMPTY_SCOPE, paths: ['src/**'], repositories: ['subject'], ...overrides };
}

export function evidence(overrides: Partial<Evidence> = {}): Evidence {
  const kind: EvidenceKind = overrides.kind ?? 'file';
  const base: Evidence = {
    id: 'E-001',
    kind,
    locator: { adapter: 'repo', op: 'read_file', args: { path: 'src/a.ts' } },
    ref: 'src/a.ts:1',
    excerpt: 'export const a = 1;',
    observed_at: T1,
    reproducible: true,
  };
  /*
   * `log` and `metric` evidence must carry a predicate: the kernel re-evaluates a predicate
   * for those kinds rather than comparing a volatile raw value.
   */
  const withPredicate: Evidence = (kind === 'log' || kind === 'metric')
    ? { ...base, predicate: { subject: 'count', operator: 'eq', operand: 0 } }
    : base;
  return { ...withPredicate, ...overrides };
}

export function factAssertion(value: unknown, overrides: Record<string, unknown> = {}): Assertion {
  return {
    value,
    confidence: 'FACT',
    evidence: ['E-001'],
    observed_at: T1,
    probe: 'repo.stack',
    freshness: 'CURRENT',
    ...overrides,
  };
}

export function inferenceAssertion(
  value: unknown,
  overrides: Record<string, unknown> = {},
): Assertion {
  return {
    value,
    confidence: 'INFERENCE',
    derived_from: ['A-001'],
    reasoning: 'derived from the observed manifest',
    observed_at: T1,
    probe: 'resolution',
    freshness: 'CURRENT',
    ...overrides,
  };
}

export function unknownAssertion(overrides: Record<string, unknown> = {}): Assertion {
  return {
    value: null,
    confidence: 'UNKNOWN',
    reason: 'UNAVAILABLE',
    recoverable_by: 'read access to the git host',
    observed_at: T1,
    probe: 'git.pr',
    freshness: 'UNKNOWN',
    ...overrides,
  };
}

export function assertionOfFreshness(freshness: Freshness): Assertion {
  return factAssertion(true, { freshness });
}

export function coverage(overrides: Partial<Coverage> = {}): Coverage {
  return {
    scope_examined: ['src/**'],
    scope_not_examined: [],
    confidence: 'FACT',
    ...overrides,
  };
}

export function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'F-001',
    title: 'writer with no reader',
    severity: 'HIGH',
    category: 'orphan-writer',
    capability: 'cap.subject',
    chain_stage: 'NORMALIZATION',
    description: 'the value is computed and stored, and nothing reads it',
    evidence: ['E-001'],
    confidence: 'FACT',
    impact: 'the capability produces data no consumer sees',
    ...overrides,
  };
}

export function findingOfCategory(category: FindingCategory): Finding {
  return finding({ category, id: `F-${category}` });
}

export function findingOfSeverity(severity: Severity): Finding {
  return finding({ severity, id: `F-${severity}` });
}

export function blocker(overrides: Partial<Blocker> = {}): Blocker {
  return {
    id: 'B-001',
    kind: 'MISSING_ACCESS',
    description: 'the git host refused the request',
    needs: 'access_grant',
    evidence: [],
    ...overrides,
  };
}

/** Each blocker kind with the `needs` value that actually unblocks it. */
const NEEDS_FOR_KIND: Readonly<Record<BlockerKind, BlockerNeeds>> = {
  ARCHITECTURE_CONTRADICTION: 'architect_decision',
  MISSING_ACCESS: 'access_grant',
  MISSING_CAPABILITY: 'human_decision',
  AMBIGUOUS_GOAL: 'human_decision',
  AMBIGUOUS_STATE: 'additional_discovery',
  WORK_ITEM_MISCLASSIFIED: 're_resolution',
  AUTHORIZATION_REQUIRED: 'human_authorization',
  BUDGET_EXHAUSTED: 'human_decision',
  UNRESOLVED_CONFLICT: 'human_decision',
  EXTERNAL_DEPENDENCY: 'external_fix',
};

export function blockerOfKind(kind: BlockerKind): Blocker {
  return blocker({ id: `B-${kind}`, kind, needs: NEEDS_FOR_KIND[kind] });
}

export function blockerNeeding(needs: BlockerNeeds): Blocker {
  return blocker({ id: `B-${needs}`, needs });
}

export function unknownRecord(overrides: Partial<UnknownRecord> = {}): UnknownRecord {
  return {
    id: 'U-001',
    subject: 'production ingestion cadence',
    reason: 'UNAVAILABLE',
    attempted: 'runtime.logs adapter, production scope',
    recoverable_by: 'read access to production logs, or a human answer',
    blocks: ['validation.production'],
    ...overrides,
  };
}

export function criterionVerdict(overrides: Partial<CriterionVerdict> = {}): CriterionVerdict {
  return {
    criterion: 3,
    verdict: 'MET',
    reason: null,
    evidence: ['E-001'],
    capability: 'cap.subject',
    ...overrides,
  };
}

export function criterionVerdictOf(verdict: DodVerdict, criterion = 3): CriterionVerdict {
  /* NOT_APPLICABLE and NOT_VALIDATED owe a reason; a criterion set aside without one is a
   * criterion quietly skipped. */
  const needsReason = verdict === 'NOT_APPLICABLE' || verdict === 'NOT_VALIDATED';
  return criterionVerdict({
    criterion,
    verdict,
    reason: needsReason ? 'no runtime access in this run' : null,
    evidence: verdict === 'MET' ? ['E-001'] : [],
  });
}

export function envelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  const base: HandoffEnvelope = {
    envelope_version: '1.2',
    work_item_id: 'wi_c_subject',
    run_id: 'run_20260904T100000Z_000001',
    envelope_id: 'env_001',
    dispatch_id: 'd_001',
    agent: 'auditor',
    agent_version: '1.0',
    model: 'claude-opus-5',
    skills_used: [],
    stage_in: 'AUDIT',
    started_at: T1,
    completed_at: T2,
    cost: { input_tokens: 1000, output_tokens: 100 },
    status: 'COMPLETE',
    summary: 'one paragraph a human can read without opening anything else',
    findings: [],
    evidence: [],
    assumptions: [],
    unknowns: [],
    artifacts_changed: [],
    recommendations: [],
    blockers: [],
    coverage: coverage(),
    outputs: {},
    dod_verdicts: [],
    proposals: {},
    next_action: null,
  };
  return { ...base, ...overrides };
}

/**
 * An envelope carrying an internally consistent status. `BLOCKED` needs a blocker,
 * `REJECTED` needs a reviewing role — the cross-field rules the kernel checks, satisfied,
 * so that a fixture for each status exercises the status rather than the rule.
 */
export function envelopeWithStatus(status: EnvelopeStatus): HandoffEnvelope {
  switch (status) {
    case 'COMPLETE':
      return envelope({ status });
    case 'PARTIAL':
      return envelope({ status, unknowns: [unknownRecord()] });
    case 'BLOCKED':
      return envelope({ status, blockers: [blocker()] });
    case 'BLOCKED_BY_ARCHITECTURE':
      return envelope({
        status,
        agent: 'implementer',
        stage_in: 'IMPLEMENTATION',
        blockers: [blockerOfKind('ARCHITECTURE_CONTRADICTION')],
      });
    case 'FAILED':
      return envelope({ status, summary: 'the model was unreachable' });
    case 'REJECTED':
      return envelope({ status, agent: 'validator', stage_in: 'VALIDATION' });
    default:
      return envelope({ status });
  }
}

export function envelopeFromRole(agent: AgentRole, stage: Stage = 'AUDIT'): HandoffEnvelope {
  return envelope({ agent, stage_in: stage });
}

export const INTAKE_RAW = 'Fix typo in README.';

export function intakeRecord(overrides: Partial<IntakeRecord> = {}): IntakeRecord {
  const raw = overrides.raw ?? INTAKE_RAW;
  return {
    intake_id: 'in_0001',
    received_at: T0,
    source: 'NATURAL_LANGUAGE',
    source_locator: { adapter: 'host.cli', op: 'read_invocation', args: { argv_index: 1 } },
    principal: { id: 'operator@example.com', asserted_by: 'host.cli' },
    trust_class: 'OPERATOR',
    raw,
    content_hash: sha256(raw),
    attachments: [],
    correlation: { prior_work_item: null, prior_run: null },
    ...overrides,
    ...(overrides.raw === undefined ? {} : { content_hash: sha256(overrides.raw) }),
  };
}

export function intakeOfSource(source: IntakeSource): IntakeRecord {
  const locators: Readonly<Record<IntakeSource, IntakeRecord['source_locator']>> = {
    NATURAL_LANGUAGE: { adapter: 'host.cli', op: 'read_invocation', args: { argv_index: 1 } },
    PROJECT_MANAGEMENT: { adapter: 'pm.jira', op: 'read_issue', args: { key: 'DEF-456' } },
    VCS: { adapter: 'git', op: 'read_pr', args: { number: 412 } },
    DOCUMENT: { adapter: 'pm.docs', op: 'read_document', args: { path: 'docs/spec.md' } },
    EVENT: { adapter: 'host.webhook', op: 'read_event', args: { id: 'evt_1' } },
    SCHEDULE: { adapter: 'host.schedule', op: 'read_trigger', args: { id: 'nightly' } },
    RUNTIME_ALERT: { adapter: 'runtime.logs', op: 'read_alert', args: { id: 'al_1' } },
  };
  return intakeRecord({ source, source_locator: locators[source], intake_id: `in_${source}` });
}

export function intakeOfTrust(trustClass: TrustClass): IntakeRecord {
  /* A host that cannot assert a principal must classify EXTERNAL, so EXTERNAL carries none. */
  return intakeRecord({
    trust_class: trustClass,
    intake_id: `in_${trustClass}`,
    principal: trustClass === 'EXTERNAL'
      ? { id: 'unauthenticated', asserted_by: 'host.webhook' }
      : { id: 'operator@example.com', asserted_by: 'host.cli' },
  });
}

export function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    work_item_id: 'wi_c_subject',
    created_at: T0,
    source_intake: 'in_0001',
    origin_trust_class: 'OPERATOR',
    type: 'TASK',
    claimed_type: null,
    title: 'Fix typo in README',
    external_identity: null,
    desired_outcome: 'the misspelling in README.md is corrected',
    scope: scope({ paths: ['README.md'] }),
    constraints: [],
    dependencies: [],
    lifecycle: 'RESOLVED',
    candidate_dod_profiles: ['documentation'],
    links: [],
    duplicate_candidates: [],
    lease: null,
    runs: [],
    reresolution_count: 0,
    decomposition_depth: 0,
    denied_gates: [],
    consumed_budget: {
      usd: 0, input_tokens: 0, output_tokens: 0, dispatches: 0, loops: {},
    },
    ...overrides,
  };
}

/** Per type, a profile its outcome plausibly binds to, so the fixture is admissible. */
const PROFILE_FOR_TYPE: Readonly<Record<WorkItemType, WorkItem['candidate_dod_profiles']>> = {
  EPIC: ['internal-capability'],
  FEATURE: ['service-capability'],
  STORY: ['service-capability'],
  DEFECT: ['fix'],
  TASK: ['documentation'],
  INCIDENT: ['fix'],
  INVESTIGATION: ['audit'],
  CHANGE_REQUEST: ['fix'],
  UNKNOWN: ['audit'],
};

export function workItemOfType(type: WorkItemType): WorkItem {
  return workItem({
    work_item_id: `wi_c_${type.toLowerCase()}`,
    type,
    candidate_dod_profiles: PROFILE_FOR_TYPE[type],
  });
}

export function workItemInLifecycle(lifecycle: WorkItemLifecycle): WorkItem {
  return workItem({ work_item_id: `wi_c_${lifecycle.toLowerCase()}`, lifecycle });
}

export function currentReality(overrides: Partial<CurrentReality> = {}): CurrentReality {
  const absent = unknownAssertion({ reason: 'NOT_APPLICABLE', probe: 'git.pr' });
  return {
    implementation_present: factAssertion(false),
    tests_present: factAssertion(false),
    pr: absent,
    ci: absent,
    reviews: absent,
    merge_state: absent,
    deployment: absent,
    outcome_evidence: factAssertion(false),
    children: absent,
    agentos_history: factAssertion([]),
    reconciliation: 'INDETERMINATE',
    ...overrides,
  };
}

export function realityWithReconciliation(state: ReconciliationState): CurrentReality {
  return currentReality({ reconciliation: state });
}

export function chainStageRecord(
  stage: ChainStage,
  overrides: Partial<ChainStageRecord> = {},
): ChainStageRecord {
  return {
    stage,
    applicable: 'TRUE',
    not_applicable_reason: null,
    implemented: 'TRUE',
    connected: 'TRUE',
    exercised: 'FALSE',
    evidence: ['E-001'],
    semantics: [],
    defects: [],
    ...overrides,
  };
}

export function capabilityRecord(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return {
    id: 'cap.subject',
    name: 'Subject capability',
    description: 'what it does for whom',
    canonical_entity: 'subject',
    status: 'PARTIAL',
    chain: [chainStageRecord('SOURCE'), chainStageRecord('API')],
    inputs: [],
    writers: [],
    storage: [],
    consumers: [],
    api: [],
    ui: [],
    provenance: 'INDETERMINATE',
    observability: [],
    validation: [],
    production_evidence: [],
    outcome: null,
    learning: null,
    reconciliation: 'CODE_ONLY',
    sources_seen: ['CODE'],
    findings: [],
    confidence: 'INFERENCE',
    scope_paths: ['src/**'],
    observed_at: T1,
    freshness: 'CURRENT',
    ...overrides,
  };
}

export function capabilityOfStatus(status: CapabilityStatus): CapabilityRecord {
  return capabilityRecord({ id: `cap.${status.toLowerCase()}`, status });
}

export function mutationEvent(overrides: Partial<MutationEvent> = {}): MutationEvent {
  return {
    work_item_id: 'wi_c_subject',
    run_id: 'run_20260904T100000Z_000001',
    dispatch_id: 'd_001',
    adapter: 'git',
    op: 'commit',
    target: 'worktree/agentos-run-000001',
    before: { head: '9f2c1ab' },
    after: { head: '4de0117' },
    reversal: { op: 'reset_hard', args: { to: '9f2c1ab' } },
    at: T2,
    ...overrides,
  };
}

export function operationDescriptor(
  overrides: Partial<AdapterOperationDescriptor> = {},
): AdapterOperationDescriptor {
  return {
    adapter: 'repo',
    op: 'read_file',
    description: 'read a file inside the worktree',
    mutating: false,
    reversal: null,
    idempotent_by_key: false,
    identity_args: [],
    external_destination: false,
    observation_safe: true,
    incidental_artifacts: [],
    args_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    gates: [],
    ...overrides,
  };
}

export function inputPackage(overrides: Partial<InputPackage> = {}): InputPackage {
  return {
    work_item_id: 'wi_c_subject',
    run_id: 'run_20260904T100000Z_000001',
    dispatch_id: 'd_001',
    agent: 'auditor',
    mandate_name: 'audit',
    stage: 'AUDIT',
    work_item_ref: '../work-item.json',
    intake_ref: null,
    workflow: {
      template_id: 'investigation.readonly',
      version: '1.0',
      stages_remaining: ['ROOT_CAUSE', 'COMPLETION'],
    },
    context_package_ref: 'context/v1.json',
    context_sections: {},
    capability_registry_ref: null,
    prior_envelopes: [],
    mandate: {
      objective: 'build the capability graph over the work item scope',
      in_scope: ['src/**'],
      out_of_scope: [],
      capabilities: [],
      advisory_notes: '',
    },
    required_inputs: ['repository', 'current_reality'],
    required_outputs: ['capability_graph', 'findings_report'],
    dod_profile_ref: 'policies/dod/audit.json',
    dod_criteria_owed: [3, 4],
    constraints: [],
    authorization_scope: { autonomous: [], gated: [], grants_held: [] },
    tools_granted: [],
    skills_available: [],
    model: 'claude-opus-5',
    budget: { max_usd: 5, max_turns: 40, max_wall_clock_ms: 900_000 },
    ...overrides,
  };
}
