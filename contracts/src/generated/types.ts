/*
 * GENERATED FILE - DO NOT EDIT.
 *
 * Produced from contracts/schema/*.json by `npm run codegen`. JSON Schema is the source
 * of truth; these types are a projection of it. A hand-edit here is the moment the schema
 * and the type begin to disagree, so `npm run codegen:check` fails the build on any
 * difference between this file and a fresh generation.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// =========================================================================== adapter.json

/**
 * REPOSITORY_ADAPTER section 2.3. Fail-closed defaults throughout: an operation whose
 * observation safety cannot be established is observation_safe: false.
 */
export type AdapterOperationDescriptor = {
  readonly adapter: NonEmptyString;
  readonly op: NonEmptyString;
  readonly description: NonEmptyString;
  /**
   * Does it change authoritative state: repository content, VCS refs, an external system, a
   * data store, or AgentOS run state.
   */
  readonly mutating: boolean;
  /**
   * The operation that undoes it, or null for non-reversible. A dispatch that performed a
   * reversal: null operation is never automatically retried.
   */
  readonly reversal: ReversalSpec | null;
  readonly idempotent_by_key: boolean;
  /**
   * The argument names the work-item-scoped idempotency key is computed over. For create_pr
   * that is repository, head and base — not the PR body.
   */
  readonly identity_args: readonly NonEmptyString[];
  readonly external_destination: boolean;
  /**
   * May the kernel replay this to verify evidence. observation_safe: true implies mutating:
   * false; the converse does not hold.
   */
  readonly observation_safe: boolean;
  /**
   * Declared by-products: coverage output, caches, temp files. No mutation event, no reversal,
   * and not a loophole — a by-product something else depends on surviving disqualifies the
   * operation.
   */
  readonly incidental_artifacts: readonly PathGlob[];
  /** JSON Schema for the operation's arguments, used to build the dispatch tool surface. */
  readonly args_schema: Readonly<Record<string, unknown>>;
  /** Gates this operation can fire, in addition to whatever the classifiers detect. */
  readonly gates: readonly Gate[];
};

export type ReversalSpec = {
  readonly op: NonEmptyString;
  /** How the reversal's arguments are derived from the mutation event's `before` state. */
  readonly args_from: Readonly<Record<string, unknown>>;
};

/**
 * Every adapter call, reads included. This is what makes coverage checkable and screenshot
 * provenance verifiable.
 */
export type CallRecord = {
  readonly call_id: Id;
  readonly dispatch_id: string | null;
  readonly adapter: NonEmptyString;
  readonly op: NonEmptyString;
  readonly args_digest: string;
  readonly paths_touched: readonly string[];
  readonly capabilities_touched: readonly string[];
  readonly outcome: "OK" | "REFUSED" | "ERROR" | "DEDUPLICATED" | "BLOCKED";
  readonly refusal: ("scope_violation" | "security_violation" | "grant_missing" | "ambiguous_state") | null;
  /**
   * Reads are logged at a policy-defined granularity. Aggregation is permitted; omission is
   * not.
   */
  readonly aggregated_count: number;
  readonly started_at: Timestamp;
  readonly duration_ms: number;
};

/**
 * Emitted by the adapter at call time, before returning. The reversal record exists the moment
 * the mutation does.
 */
export type MutationEvent = {
  readonly work_item_id: Id;
  readonly run_id: Id;
  readonly dispatch_id: Id;
  readonly adapter: NonEmptyString;
  readonly op: NonEmptyString;
  readonly target: NonEmptyString;
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
  readonly reversal: {
    readonly op: NonEmptyString;
    readonly args: Readonly<Record<string, unknown>>;
  } | null;
  readonly at: Timestamp;
};

export type IdempotencyRecord = {
  readonly key: string;
  readonly scope: "dispatch" | "work_item";
  readonly adapter: NonEmptyString;
  readonly op: NonEmptyString;
  readonly result: unknown;
  /**
   * How to re-read the external resource on a key hit. A work-item-scoped hit is verified,
   * never trusted.
   */
  readonly external_locator: Locator | null;
  readonly recorded_at: Timestamp;
};

/**
 * A fail-closed determination, recorded with its confidence so a run that was conservative
 * because it was blind is distinguishable from one that was conservative because the target
 * really was production.
 */
export type Classification = {
  readonly subject: NonEmptyString;
  readonly kind: "branch_protection" | "environment" | "observation_safety" | "spawns_agents";
  readonly value: NonEmptyString;
  readonly confidence: ConfidenceClass;
  /** True when the value was chosen because the probe could not establish it. */
  readonly failed_closed: boolean;
  readonly probe_detail: string;
};

/**
 * An unreachable adapter is a recorded UNAVAILABLE, which is a fact about access and not a
 * fact about the system under study.
 */
export type AdapterAvailability = {
  readonly adapter: NonEmptyString;
  readonly state: "AVAILABLE" | "UNAVAILABLE" | "NOT_CONFIGURED" | "DENIED";
  readonly detail: string;
  readonly checked_at: Timestamp;
};

// ========================================================================= assertion.json

/**
 * An evidence id where an evidence pool exists to reference — an envelope carries `evidence[]`
 * and its assertions cite ids — or the evidence itself where the assertion stands alone, as
 * every assertion in the Context Package does. Both forms occur in the frozen documents and
 * both are the same evidence.
 */
export type EvidenceRef = Id | Evidence;

export type AssertionBase = {
  readonly value: unknown;
  readonly confidence: ConfidenceClass;
  readonly observed_at: Timestamp;
  /**
   * The probe or dispatch that produced this assertion. Required so that every assertion names
   * its source, agent-authored inferences included.
   */
  readonly probe: NonEmptyString;
  readonly freshness: Freshness;
};

export type FactAssertion = AssertionBase & {
  readonly confidence?: "FACT";
  /** A FACT with no evidence is an INFERENCE that has not admitted it. */
  readonly evidence: readonly EvidenceRef[];
};

export type InferenceAssertion = AssertionBase & {
  readonly confidence?: "INFERENCE";
  /** Assertion or evidence ids this was reasoned from. */
  readonly derived_from: readonly Id[];
  readonly reasoning: NonEmptyString;
  readonly evidence?: readonly EvidenceRef[];
};

export type UnknownAssertion = AssertionBase & {
  readonly confidence?: "UNKNOWN";
  readonly value?: null;
  readonly reason: AbsenceReason;
  /**
   * What would resolve it. This is what makes an unknown actionable rather than decorative,
   * and it is what the uncertainty ladder's rung 2 dispatches.
   */
  readonly recoverable_by: NonEmptyString;
  readonly attempted?: string;
};

/**
 * Every leaf value in the system is one. A discriminated union on `confidence`, so the
 * obligations of each class are structural rather than remembered: FACT owes evidence,
 * INFERENCE owes what it was derived from, UNKNOWN owes a reason and what would recover it.
 */
export type Assertion = FactAssertion | InferenceAssertion | UnknownAssertion;

// ===================================================================== authorization.json

/**
 * What an agent may put in an envelope. A draft is not a request: the kernel records the
 * request, and a human decides.
 */
export type DraftAuthorizationRequest = {
  readonly gate: Gate;
  readonly target: NonEmptyString;
  readonly what: NonEmptyString;
  readonly why: NonEmptyString;
  readonly blast_radius: NonEmptyString;
  readonly reversibility: Reversibility;
  readonly evidence: readonly Id[];
  readonly unknowns: readonly NonEmptyString[];
  /** Including doing nothing. */
  readonly alternatives: readonly NonEmptyString[];
  readonly recommendation: NonEmptyString;
};

export type Reversibility = {
  readonly how: NonEmptyString;
  readonly verified: boolean;
  readonly cost: NonEmptyString;
};

/**
 * The kernel's record. A human cannot authorize what they cannot evaluate, so every field of
 * the draft survives into the record.
 */
export type AuthorizationRequest = {
  readonly request_id: Id;
  readonly work_item_id: Id;
  readonly run_id: Id;
  readonly stage: Stage;
  readonly requested_by: AgentRole;
  readonly requested_at: Timestamp;
  readonly draft: DraftAuthorizationRequest;
  /**
   * The mechanical classification that fired the gate, if any. A gate that fires only when an
   * agent volunteers is not a gate.
   */
  readonly classification: Classification | null;
  readonly trigger: "classifier" | "self_declaration" | "kernel_accounting" | "kernel_policy";
  readonly state: "PENDING" | "GRANTED" | "DENIED" | "EXPIRED" | "REVOKED";
};

/** One gate, one target, one run. No blanket grants, no standing approvals. */
export type AuthorizationGrant = {
  readonly grant_id: Id;
  readonly run_id: Id;
  readonly work_item_id: Id;
  readonly gate: Gate;
  readonly target: NonEmptyString;
  readonly scope: "single_action";
  /**
   * The identifier the host asserted. AgentOS records it and refuses to proceed without one;
   * inventing an authorizer is a security floor violation.
   */
  readonly granted_by: NonEmptyString;
  readonly granted_at: Timestamp;
  readonly expires_at: Timestamp;
  readonly conditions: readonly NonEmptyString[];
  readonly request_ref: Id;
  readonly evidence_reviewed: readonly NonEmptyString[];
  readonly revoked_at: string | null;
};

/** policies/gates.json. Classifiers are policy data, not kernel code. */
export type GateDefinition = {
  readonly gate: Gate;
  readonly description: NonEmptyString;
  readonly fires_at_end_of_run: boolean;
  readonly once_per_work_item: boolean;
  readonly classifiers: readonly GateClassifier[];
  /**
   * Whether policy may pre-grant this gate per configured source. Only
   * AUTONOMOUS_INTAKE_EXECUTION is, so a trusted webhook stays autonomous.
   */
  readonly pre_grantable_by_policy: boolean;
};

export type GateClassifier = {
  readonly id: NonEmptyString;
  readonly kind: "path_pattern" | "content_pattern" | "descriptor_flag" | "classification_value" | "kernel_accounting" | "trust_class_and_mutating_stage" | "scope_escape";
  readonly patterns: readonly NonEmptyString[];
  readonly descriptor_field: string | null;
  readonly expected: string | boolean | null;
  /**
   * A classifier that cannot evaluate fires the gate. Always true; declared so the rule is
   * visible in the data.
   */
  readonly fires_when_unevaluable: true;
};

// ======================================================================== capability.json

/**
 * `implemented` without `connected` is an orphan. `connected` without `exercised` is a
 * capability that exists only on paper.
 */
export type ChainStageRecord = {
  readonly stage: ChainStage;
  readonly applicable: PredicateValue;
  readonly not_applicable_reason: string | null;
  readonly implemented: PredicateValue;
  readonly connected: PredicateValue;
  readonly exercised: PredicateValue;
  readonly evidence: readonly Id[];
  /** How this stage represents absence and uncertainty. */
  readonly semantics: readonly DataSemantic[];
  readonly defects: readonly Id[];
};

export type CapabilityRecord = {
  readonly id: Id;
  readonly name: NonEmptyString;
  readonly description: NonEmptyString;
  readonly canonical_entity: string | null;
  readonly status: CapabilityStatus;
  readonly chain: readonly ChainStageRecord[];
  readonly inputs: readonly CapabilityReference[];
  readonly writers: readonly CapabilityReference[];
  readonly storage: readonly CapabilityReference[];
  /** What reads it, from code references rather than assumptions. */
  readonly consumers: readonly CapabilityReference[];
  readonly api: readonly CapabilityReference[];
  readonly ui: readonly CapabilityReference[];
  readonly provenance: PredicateValue;
  readonly observability: readonly CapabilityReference[];
  readonly validation: readonly LayerVerdict[];
  readonly production_evidence: readonly Id[];
  readonly outcome: string | null;
  readonly learning: string | null;
  readonly reconciliation: ReconciliationState;
  /**
   * Which of intent, code and runtime named this capability. A capability appearing in only
   * one source is itself a finding, and which source tells you what kind.
   */
  readonly sources_seen: ReadonlyArray<"INTENT" | "CODE" | "RUNTIME">;
  readonly findings: readonly Id[];
  readonly confidence: ConfidenceClass;
  readonly scope_paths: readonly PathGlob[];
  readonly observed_at: Timestamp;
  readonly freshness: Freshness;
};

export type CapabilityReference = {
  readonly label: NonEmptyString;
  readonly locator: Locator;
  readonly confidence: ConfidenceClass;
};

export type LayerVerdict = {
  readonly layer: "UNIT" | "INTEGRATION" | "CAPABILITY" | "RUNTIME" | "PRODUCTION";
  readonly verdict: "PASS" | "FAIL" | "NOT_APPLICABLE" | "NOT_VALIDATED";
  readonly reason: string | null;
  readonly evidence: readonly Id[];
};

export type CapabilityGraphNode = {
  readonly node_id: Id;
  readonly capability: Id;
  readonly stage: ChainStage;
  readonly label: NonEmptyString;
  readonly locator: Locator;
};

/**
 * A structural edge is an INFERENCE; an edge confirmed by tracing a real record through a
 * runtime is a FACT.
 */
export type CapabilityGraphEdge = {
  readonly from: Id;
  readonly to: Id;
  readonly kind: "DATA_FLOW" | "CALL" | "READ" | "WRITE" | "RENDER";
  readonly confidence: ConfidenceClass;
  readonly carries_provenance: PredicateValue;
  readonly evidence: readonly Id[];
};

export type CapabilityGraph = {
  readonly version: number;
  readonly nodes: readonly CapabilityGraphNode[];
  readonly edges: readonly CapabilityGraphEdge[];
  readonly built_at: Timestamp;
};

export type CapabilityRegistry = {
  readonly version: number;
  readonly run_id: Id;
  readonly records: readonly CapabilityRecord[];
  readonly graph: CapabilityGraph;
  readonly assembled_at: Timestamp;
};

// ============================================================================ common.json

export type Id = string;

export type Timestamp = string;

export type NonEmptyString = string;

export type PathGlob = string;

/** CONTEXT_MODEL section 1. UNKNOWN never silently becomes FACT. */
export type ConfidenceClass = "FACT" | "INFERENCE" | "UNKNOWN";

/** DATA_SEMANTICS. The one absence vocabulary; a probe must not invent a reason string. */
export type AbsenceReason = "UNKNOWN" | "UNAVAILABLE" | "NOT_APPLICABLE" | "NOT_COMPUTED" | "INSUFFICIENT_EVIDENCE" | "CONFLICTING";

/** DATA_SEMANTICS full vocabulary, used when describing a target system's values. */
export type DataSemantic = "ZERO" | "NULL" | "EMPTY" | "UNKNOWN" | "UNAVAILABLE" | "NOT_APPLICABLE" | "NOT_COMPUTED" | "STALE" | "CONFLICTING" | "PARTIAL" | "INSUFFICIENT_EVIDENCE";

/** CONTEXT_MODEL section 2: orthogonal to confidence. A value can be FACT and STALE at once. */
export type Freshness = "CURRENT" | "STALE" | "UNKNOWN";

/**
 * WORKFLOW_STATE_MACHINE section 4.3. A predicate over an UNKNOWN assertion is INDETERMINATE,
 * never FALSE.
 */
export type PredicateValue = "TRUE" | "FALSE" | "INDETERMINATE";

export type EvidenceKind = "file" | "git" | "command" | "query" | "http" | "log" | "ticket" | "document" | "screenshot" | "metric";

export type VerificationStatus = "VERIFIED" | "MISMATCH" | "UNREPLAYABLE" | "UNVERIFIED" | "UNVERIFIABLE";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

/**
 * AGENT_ROLES: the eight roles. `context-discovery` covers both the resolution and context
 * mandates.
 */
export type AgentRole = "orchestrator" | "context-discovery" | "auditor" | "architect" | "implementer" | "validator" | "product-ux" | "production";

/** The roles entitled to return REJECTED (AGENT_HANDOFF_CONTRACT cross-field rules). */
export type ReviewingRole = "validator" | "product-ux";

/** WORKFLOW_STATE_MACHINE section 2: prologue, template stages, and control states. */
export type Stage = "INTAKE_RECEIVED" | "RESOLUTION" | "CONTEXT_DISCOVERY" | "UNDERSTOOD" | "WORKFLOW_SELECTED" | "AUDIT" | "ROOT_CAUSE" | "ARCHITECTURE" | "PLAN" | "DECOMPOSITION" | "CHILD_COORDINATION" | "IMPLEMENTATION" | "VALIDATION" | "STRUCTURAL_REAUDIT" | "UX_REVIEW" | "REWORK" | "PR_PREPARATION" | "PR_REVIEW" | "REVIEW_TRIAGE" | "COMMENT_RESOLUTION" | "AUTHORIZATION" | "MERGE" | "DEPLOY" | "PRODUCTION_VALIDATION" | "COMPLETION" | "BLOCKED" | "CANCELLED" | "COMPLETE";

export type PrologueStage = "INTAKE_RECEIVED" | "RESOLUTION" | "CONTEXT_DISCOVERY" | "UNDERSTOOD" | "WORKFLOW_SELECTED";

export type ControlState = "BLOCKED" | "CANCELLED" | "COMPLETE";

/**
 * Stages a workflow template may contain. The prologue and the control states are excluded: no
 * template contains them and no proposal can add one.
 */
export type TemplateStage = "AUDIT" | "ROOT_CAUSE" | "ARCHITECTURE" | "PLAN" | "DECOMPOSITION" | "CHILD_COORDINATION" | "IMPLEMENTATION" | "VALIDATION" | "STRUCTURAL_REAUDIT" | "UX_REVIEW" | "REWORK" | "PR_PREPARATION" | "PR_REVIEW" | "REVIEW_TRIAGE" | "COMMENT_RESOLUTION" | "AUTHORIZATION" | "MERGE" | "DEPLOY" | "PRODUCTION_VALIDATION" | "COMPLETION";

/** INTENT_AND_WORK_ITEM_RESOLUTION section 3.3. PR and REVIEW are deliberately not types. */
export type WorkItemType = "EPIC" | "FEATURE" | "STORY" | "DEFECT" | "TASK" | "INCIDENT" | "INVESTIGATION" | "CHANGE_REQUEST" | "UNKNOWN";

export type WorkItemLifecycle = "RESOLVED" | "UNDERSTOOD" | "EXECUTING" | "BLOCKED" | "ACHIEVED" | "ABANDONED" | "SUPERSEDED";

export type WorkItemLinkKind = "CHILD_OF" | "PARENT_OF" | "DUPLICATE_OF" | "DISCOVERED_BY" | "DEPENDS_ON" | "SUPERSEDES" | "SUPERSEDED_BY";

export type IntakeSource = "NATURAL_LANGUAGE" | "PROJECT_MANAGEMENT" | "VCS" | "DOCUMENT" | "EVENT" | "SCHEDULE" | "RUNTIME_ALERT";

/** Set by the host from authenticated context, never from intake content. */
export type TrustClass = "OPERATOR" | "INTERNAL" | "EXTERNAL";

/** CONTEXT_MODEL section 5. Used at capability level and at work-item level. */
export type ReconciliationState = "ALIGNED" | "INTENT_ONLY" | "CODE_ONLY" | "CODE_NO_RUNTIME" | "RUNTIME_NO_CODE" | "CLAIMED_DONE_UNPROVEN" | "CONFLICTING" | "INDETERMINATE";

export type CapabilityStatus = "PROVEN" | "WORKING" | "PARTIAL" | "DISCONNECTED" | "ORPHANED" | "CLAIMED" | "ABSENT" | "UNKNOWN";

export type ChainStage = "SOURCE" | "INGESTION" | "NORMALIZATION" | "CANONICAL_STORE" | "INTELLIGENCE" | "API" | "UI" | "OUTCOME" | "LEARNING";

/** WORKFLOW_STATE_MACHINE section 3.6, derived by the kernel from the admitted graph and scope. */
export type RiskClass = "READ_ONLY" | "LOCAL_MUTATION" | "EXTERNAL_MUTATION" | "IRREVERSIBLE";

export type Gate = "MERGE_PROTECTED" | "DEPLOY_PRODUCTION" | "DESTRUCTIVE_MIGRATION" | "IRREVERSIBLE_DATA_MUTATION" | "CREDENTIAL_OR_SECURITY_CHANGE" | "EXTERNAL_COMMUNICATION" | "PRODUCTION_WRITE" | "SCOPE_EXPANSION" | "COST_CEILING_EXCEEDED" | "AUTONOMOUS_INTAKE_EXECUTION";

/** DEFINITION_OF_DONE section 1. NOT_VALIDATED is never counted as MET. */
export type DodVerdict = "MET" | "NOT_MET" | "NOT_APPLICABLE" | "NOT_VALIDATED";

export type CompletionVerdict = "COMPLETE" | "COMPLETE_WITH_GAPS" | "INCOMPLETE" | "INDETERMINATE";

export type DodProfileId = "data-capability" | "service-capability" | "ui-capability" | "internal-capability" | "fix" | "audit" | "documentation";

export type RunOutcome = "COMPLETE" | "BLOCKED" | "FAILED" | "CANCELLED" | "RERESOLVED";

/**
 * A re-executable read. `op: null` marks a genuinely unrepeatable observation, which caps the
 * assertion it supports at INFERENCE.
 */
export type Locator = {
  readonly adapter: NonEmptyString;
  readonly op: string | null;
  readonly args: Readonly<Record<string, unknown>>;
};

/**
 * A typed, bounded scope. Becomes `mandate.in_scope`, so an over-wide scope is an over-wide
 * grant of reach.
 */
export type Scope = {
  readonly paths: readonly PathGlob[];
  readonly capabilities: readonly Id[];
  readonly repositories: readonly NonEmptyString[];
};

export type Cost = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly usd?: number | null;
};

// =================================================================== context-package.json

export type ContextSectionName = "meta" | "work_item" | "current_reality" | "repository" | "product" | "capabilities" | "architecture" | "domain_model" | "source_map" | "data_map" | "api_map" | "ui_map" | "tests" | "git_state" | "runtime_state" | "production_state" | "intent" | "reconciliation" | "agent_capabilities" | "model_capabilities" | "constraints" | "authorization" | "gaps";

/**
 * Every leaf is an assertion, never a bare value. Probes choose the keys within a section; the
 * section names themselves are fixed.
 */
export type ContextSection = {
  readonly [key: string]: Assertion | undefined;
};

export type ContextPackageMeta = {
  readonly run_id: Id;
  readonly work_item_id: string | null;
  /** The package is versioned, not appended. On-demand discovery produces a new version. */
  readonly package_version: number;
  readonly assembled_at: Timestamp;
  /** 1 orientation, 2 work-item-relevant depth, 3 on-demand. */
  readonly tier: number;
  readonly probe_coverage: readonly ProbeCoverage[];
  readonly adapter_availability: readonly AdapterAvailability[];
};

/**
 * An agent must be able to distinguish 'found no orphan readers here' from 'discovery never
 * looked here'.
 */
export type ProbeCoverage = {
  readonly probe: NonEmptyString;
  readonly section: ContextSectionName;
  readonly state: "RAN" | "SKIPPED" | "UNAVAILABLE" | "PARTIAL";
  readonly reason: string | null;
  readonly scope_examined: readonly PathGlob[];
  readonly scope_not_examined: readonly PathGlob[];
  readonly observed_at: Timestamp;
};

/**
 * Written only by probes. No part of it may be derived from the intake text, from a ticket's
 * status field alone, or from an agent's account of a previous run.
 */
export type CurrentReality = {
  readonly implementation_present: Assertion;
  readonly tests_present: Assertion;
  readonly pr: Assertion;
  readonly ci: Assertion;
  readonly reviews: Assertion;
  readonly merge_state: Assertion;
  readonly deployment: Assertion;
  readonly outcome_evidence: Assertion;
  readonly children: Assertion;
  readonly agentos_history: Assertion;
  /**
   * The three-way reconciliation applied to the work item rather than to a capability. Same
   * enum, same rule.
   */
  readonly reconciliation: ReconciliationState;
};

export type RealityElement = "implementation_present" | "tests_present" | "pr" | "ci" | "reviews" | "merge_state" | "deployment" | "outcome_evidence" | "children" | "agentos_history";

export type ReconciliationMatrix = ReadonlyArray<{
  readonly capability: Id;
  readonly intent: Assertion;
  readonly code: Assertion;
  readonly runtime: Assertion;
  readonly state: ReconciliationState;
  readonly rationale: NonEmptyString;
}>;

/**
 * The durable, structured answer to what is actually true about this repository, its intent
 * and its runtime. Twenty-three sections; the section names are the vocabulary of
 * `required_inputs`, so they are load-bearing identifiers and not documentation.
 */
export type ContextPackage = {
  readonly meta: ContextPackageMeta;
  /**
   * A reference, not a copy. Keeping a third copy would give the run two answers to what it is
   * doing.
   */
  readonly work_item: string | null;
  readonly current_reality: CurrentReality;
  readonly repository: ContextSection;
  readonly product: ContextSection;
  /**
   * A reference into the Capability Registry rather than a copy. There is one representation
   * of a capability per run.
   */
  readonly capabilities: string | null;
  readonly architecture: ContextSection;
  readonly domain_model: ContextSection;
  readonly source_map: ContextSection;
  readonly data_map: ContextSection;
  readonly api_map: ContextSection;
  readonly ui_map: ContextSection;
  readonly tests: ContextSection;
  readonly git_state: ContextSection;
  readonly runtime_state: ContextSection;
  readonly production_state: ContextSection;
  readonly intent: ContextSection;
  readonly reconciliation: ReconciliationMatrix;
  readonly agent_capabilities: ContextSection;
  readonly model_capabilities: ContextSection;
  readonly constraints: ContextSection;
  readonly authorization: ContextSection;
  /**
   * A first-class section, not a footnote. What AgentOS does not know is as operationally
   * important as what it does.
   */
  readonly gaps: readonly UnknownRecord[];
};

// =============================================================================== dod.json

export type DodCriterionId = number;

/** One agent owns each criterion, and no agent supplies the verdict on its own work. */
export type CriterionVerdict = {
  readonly criterion: DodCriterionId;
  readonly verdict: DodVerdict;
  /**
   * Mandatory for NOT_APPLICABLE and NOT_VALIDATED: a criterion set aside without a reason is
   * a criterion quietly skipped.
   */
  readonly reason: string | null;
  readonly evidence: readonly Id[];
  readonly capability: string | null;
};

export type DodProfile = {
  readonly profile_id: DodProfileId;
  readonly description: NonEmptyString;
  readonly criteria: readonly DodCriterionId[];
  /** Criteria whose failure makes the verdict INCOMPLETE rather than COMPLETE_WITH_GAPS. */
  readonly critical_criteria: readonly DodCriterionId[];
  /**
   * Criteria this kind of thing genuinely does not have, each with the reason. A profile that
   * marks an inconvenient criterion NOT_APPLICABLE without a reason is rejected.
   */
  readonly not_applicable_by_default: ReadonlyArray<{
    readonly criterion: DodCriterionId;
    readonly reason: NonEmptyString;
  }>;
  readonly evidence_requirements: {
    readonly [key: string]: {
      readonly kinds: readonly EvidenceKind[];
      readonly note: NonEmptyString;
    } | undefined;
  };
  /** Applicability rules the kernel checks a profile assignment against. */
  readonly applies_when: {
    readonly capability_kinds: readonly NonEmptyString[];
    readonly work_item_types: ReadonlyArray<WorkItemType | "*">;
    /**
     * Access classes the profile's criteria need. An outcome binding only to a profile whose
     * access this run lacks is not checkable, and admission says so.
     */
    readonly requires_access: ReadonlyArray<"repository" | "git" | "project_management" | "runtime" | "production">;
  };
};

/** Written for a reader who was not present and does not trust the run. */
export type CompletionReport = {
  readonly work_item_id: Id;
  readonly run_id: Id;
  readonly profile_id: DodProfileId;
  readonly verdict: CompletionVerdict;
  readonly criteria: ReadonlyArray<{
    readonly criterion: DodCriterionId;
    readonly verdict: DodVerdict;
    readonly reason: string | null;
    readonly evidence: readonly Id[];
    readonly owner_role: AgentRole;
    readonly supplied_by_envelope: string | null;
  }>;
  readonly unmet_critical: readonly DodCriterionId[];
  readonly not_validated: readonly DodCriterionId[];
  readonly gaps: readonly NonEmptyString[];
  /** The stage that owes the missing verdicts. Populated when the verdict is INCOMPLETE. */
  readonly route_back_to: TemplateStage | null;
  readonly source_drift: SourceDrift | null;
  readonly computed_at: Timestamp;
};

/** The intake's own locator, re-executed at COMPLETION. Disclosure, never chasing. */
export type SourceDrift = {
  readonly state: "UNCHANGED" | "CHANGED" | "UNAVAILABLE";
  readonly hash_at_admission: string;
  readonly hash_now: string | null;
  readonly detail: string;
};

// ============================================================================= event.json

export type EventBase = {
  /**
   * Monotonic within one log. Recovery is a pure function of the log, and the sequence is what
   * makes a prefix well-defined.
   */
  readonly seq: number;
  readonly at: Timestamp;
  readonly work_item_id: Id;
  readonly run_id: string | null;
  readonly stage: Stage | null;
  readonly dispatch_id: string | null;
  readonly agent: AgentRole | null;
  readonly event: EventKind;
  readonly data: unknown;
};

export type EventKind = "run_started" | "run_ended" | "intake_recorded" | "work_item_admitted" | "work_item_rejected" | "understood_computed" | "workflow_admitted" | "workflow_override" | "entry_stage_computed" | "stage_marked_completed_prior" | "transition" | "dispatch_intent" | "dispatch_result" | "envelope_received" | "envelope_rejected" | "contract_violation" | "evidence_verification" | "evidence_integrity" | "mutation" | "adapter_call" | "dispatch_rollback" | "idempotency" | "gate_fired" | "authorization_requested" | "authorization_decided" | "scope_violation" | "security_violation" | "conflict" | "budget" | "dod_computed" | "source_drift" | "reresolved" | "child_work_item" | "lease" | "recovery" | "selection" | "question" | "discovery" | "context_package_versioned" | "capability_registry_updated" | "work_item_lifecycle" | "tool_surface_conformance" | "intake_instruction_attempt" | "duplicate_candidates" | "predicate_evaluated" | "note";

export type EventPayload = RunStartedLogEvent | RunEndedLogEvent | IntakeRecordedLogEvent | WorkItemAdmittedLogEvent | WorkItemRejectedLogEvent | UnderstoodComputedLogEvent | WorkflowAdmittedLogEvent | WorkflowOverrideLogEvent | EntryStageComputedLogEvent | StageMarkedCompletedPriorLogEvent | TransitionLogEvent | DispatchIntentLogEvent | DispatchResultLogEvent | EnvelopeReceivedLogEvent | EnvelopeRejectedLogEvent | ContractViolationLogEvent | EvidenceVerificationLogEvent | EvidenceIntegrityLogEvent | MutationLogEvent | AdapterCallLogEvent | DispatchRollbackLogEvent | IdempotencyLogEvent | GateFiredLogEvent | AuthorizationRequestedLogEvent | AuthorizationDecidedLogEvent | ScopeViolationLogEvent | SecurityViolationLogEvent | ConflictLogEvent | BudgetLogEvent | DodComputedLogEvent | SourceDriftLogEvent | ReresolvedLogEvent | ChildWorkItemLogEvent | LeaseLogEvent | RecoveryLogEvent | SelectionLogEvent | QuestionLogEvent | DiscoveryLogEvent | ContextPackageVersionedLogEvent | CapabilityRegistryUpdatedLogEvent | WorkItemLifecycleLogEvent | ToolSurfaceConformanceLogEvent | IntakeInstructionAttemptLogEvent | DuplicateCandidatesLogEvent | PredicateEvaluatedLogEvent | NoteLogEvent;

export type RunStartedLogEvent = {
  readonly event: "run_started";
  readonly data: {
    readonly run_id: Id;
    readonly holder: NonEmptyString;
    readonly reason: "NEW" | "RESUME" | "RERESOLUTION" | "RETRY";
  };
};

export type RunEndedLogEvent = {
  readonly event: "run_ended";
  readonly data: {
    readonly outcome: RunOutcome;
    readonly detail: string;
  };
};

export type IntakeRecordedLogEvent = {
  readonly event: "intake_recorded";
  readonly data: IntakeRecord;
};

export type WorkItemAdmittedLogEvent = {
  readonly event: "work_item_admitted";
  readonly data: {
    readonly work_item: WorkItem;
    readonly checks: readonly CheckOutcome[];
    /** True where a type was asserted without its minimum evidence and admitted as UNKNOWN. */
    readonly type_downgraded: boolean;
  };
};

export type WorkItemRejectedLogEvent = {
  readonly event: "work_item_rejected";
  readonly data: {
    readonly checks: readonly CheckOutcome[];
    readonly attempt: number;
    readonly next: "REDISPATCH" | "LADDER" | "BLOCKED";
  };
};

export type UnderstoodComputedLogEvent = {
  readonly event: "understood_computed";
  readonly data: {
    readonly verdict: "SUFFICIENT" | "INSUFFICIENT";
    readonly conditions: readonly CheckOutcome[];
    /**
     * Naming which predicate is undetermined names which discovery would resolve it.
     * Sufficiency failures are actionable by construction.
     */
    readonly undetermined_predicates: readonly NonEmptyString[];
  };
};

export type WorkflowAdmittedLogEvent = {
  readonly event: "workflow_admitted";
  readonly data: {
    readonly graph: FrozenGraph;
    readonly admissible_templates: readonly string[];
    readonly checks: readonly CheckOutcome[];
  };
};

export type WorkflowOverrideLogEvent = {
  readonly event: "workflow_override";
  readonly data: {
    readonly proposed_template: string | null;
    readonly selected_template: NonEmptyString;
    readonly reason: NonEmptyString;
    readonly failed_checks: readonly CheckOutcome[];
  };
};

export type EntryStageComputedLogEvent = {
  readonly event: "entry_stage_computed";
  readonly data: {
    readonly entry_stage: Stage | null;
    readonly walk: ReadonlyArray<{
      readonly stage: TemplateStage;
      readonly satisfied_by: string | null;
      readonly evaluated: PredicateValue;
      readonly mutating: boolean;
      readonly decision: "COMPLETED_PRIOR" | "ENTER" | "DISCOVER" | "BLOCK_AMBIGUOUS_STATE";
      readonly evidence: readonly Id[];
    }>;
  };
};

export type StageMarkedCompletedPriorLogEvent = {
  readonly event: "stage_marked_completed_prior";
  readonly data: {
    readonly marked_stage: TemplateStage;
    readonly predicate: NonEmptyString;
    readonly evidence: readonly Id[];
    /** COMPLETED_PRIOR means the mutation has already occurred, not that the criteria are met. */
    readonly note: "criteria remain NOT_VALIDATED";
  };
};

export type TransitionLogEvent = {
  readonly event: "transition";
  readonly data: {
    readonly from: Stage;
    readonly to: Stage;
    readonly trigger: NonEmptyString;
    readonly edge_kind: "advance" | "branch" | "loop" | "escalate" | "terminal";
    readonly proposed_by: AgentRole | null;
    readonly proposed_stage: Stage | null;
    /**
     * True when the agent proposed something else. The override is logged with both the claim
     * and the evaluated value.
     */
    readonly overridden: boolean;
    readonly evidence: readonly Id[];
  };
};

/**
 * Written before the agent is invoked, so a crash mid-agent is detectable rather than
 * invisible.
 */
export type DispatchIntentLogEvent = {
  readonly event: "dispatch_intent";
  readonly data: {
    readonly input_package: InputPackage;
    readonly attempt: number;
  };
};

export type DispatchResultLogEvent = {
  readonly event: "dispatch_result";
  readonly data: {
    readonly outcome: "ENVELOPE" | "FAILED" | "ABORTED";
    readonly envelope_id: string | null;
    readonly failure_reason: ("NO_MODEL" | "TIMEOUT" | "TOOL_SURFACE_VIOLATION" | "MALFORMED_ENVELOPE" | "SUBSTRATE_ERROR" | "BUDGET_EXCEEDED" | "SECURITY_VIOLATION") | null;
    readonly detail: string;
    readonly cost: Cost;
  };
};

export type EnvelopeReceivedLogEvent = {
  readonly event: "envelope_received";
  readonly data: {
    readonly envelope_id: Id;
    readonly status: EnvelopeStatus;
    /** The eight receipt steps, in order. Later steps do not run if an earlier one rejects. */
    readonly steps: readonly CheckOutcome[];
  };
};

export type EnvelopeRejectedLogEvent = {
  readonly event: "envelope_rejected";
  readonly data: {
    readonly envelope_id: string | null;
    readonly step: ReceiptStep;
    readonly violations: readonly Violation[];
  };
};

export type ContractViolationLogEvent = {
  readonly event: "contract_violation";
  readonly data: Violation;
};

export type EvidenceVerificationLogEvent = {
  readonly event: "evidence_verification";
  readonly data: {
    readonly envelope_id: Id;
    readonly results: ReadonlyArray<{
      readonly evidence_id: Id;
      readonly status: VerificationStatus;
      readonly selected_because: "ALWAYS_CRITICAL_FINDING" | "ALWAYS_AUTHORIZATION" | "ALWAYS_DOD_MET" | "ALWAYS_CONTRADICTS" | "SAMPLED" | "NOT_SELECTED" | "DECLARED_UNREPRODUCIBLE";
      readonly detail: string;
    }>;
    readonly mismatch_count: number;
  };
};

/**
 * Logged against the producing agent and model. One fabrication is a defect; two is an
 * untrustworthy witness.
 */
export type EvidenceIntegrityLogEvent = {
  readonly event: "evidence_integrity";
  readonly data: {
    readonly envelope_id: Id;
    readonly evidence_id: Id;
    readonly model: NonEmptyString;
    readonly status: "MISMATCH" | "UNREPLAYABLE";
    readonly downgraded_assertions: readonly Id[];
    readonly demoted_findings: readonly Id[];
    readonly envelope_rejected: boolean;
  };
};

export type MutationLogEvent = {
  readonly event: "mutation";
  readonly data: MutationEvent;
};

export type AdapterCallLogEvent = {
  readonly event: "adapter_call";
  readonly data: CallRecord;
};

export type DispatchRollbackLogEvent = {
  readonly event: "dispatch_rollback";
  readonly data: {
    readonly rolled_back_dispatch: Id;
    readonly reversed: ReadonlyArray<{
      readonly adapter: NonEmptyString;
      readonly op: NonEmptyString;
      readonly target: NonEmptyString;
      readonly reversal_op: NonEmptyString;
      readonly outcome: "REVERSED" | "FAILED";
    }>;
    readonly new_dispatch_id: string | null;
    /**
     * True where the dispatch performed a reversal: null operation. Such a dispatch is never
     * automatically retried.
     */
    readonly blocked_non_reversible: boolean;
  };
};

export type IdempotencyLogEvent = {
  readonly event: "idempotency";
  readonly data: {
    readonly key: string;
    readonly scope: "dispatch" | "work_item";
    readonly adapter: NonEmptyString;
    readonly op: NonEmptyString;
    /**
     * A work-item-scoped key hit is verified, never trusted. Unreachable is neither a return
     * nor a re-execute.
     */
    readonly verdict: "RECORDED" | "DEDUPLICATED" | "IDEMPOTENCY_DIVERGENCE" | "AMBIGUOUS_STATE";
    readonly reread: ("PRESENT" | "ABSENT" | "UNREACHABLE" | "NOT_ATTEMPTED") | null;
    readonly detail: string;
  };
};

export type GateFiredLogEvent = {
  readonly event: "gate_fired";
  readonly data: {
    readonly gate: Gate;
    readonly target: NonEmptyString;
    readonly trigger: "classifier" | "self_declaration" | "kernel_accounting" | "kernel_policy";
    readonly classifier_id: string | null;
    readonly classification: Classification | null;
    readonly request_id: string | null;
  };
};

export type AuthorizationRequestedLogEvent = {
  readonly event: "authorization_requested";
  readonly data: AuthorizationRequest;
};

export type AuthorizationDecidedLogEvent = {
  readonly event: "authorization_decided";
  readonly data: {
    readonly request_id: Id;
    readonly decision: "GRANTED" | "DENIED" | "EXPIRED" | "REVOKED";
    readonly grant: AuthorizationGrant | null;
    readonly decided_by: string | null;
    readonly reason: string;
  };
};

export type ScopeViolationLogEvent = {
  readonly event: "scope_violation";
  readonly data: PathRefusal;
};

/**
 * Aborts the dispatch immediately and is reported regardless of the run's outcome. An agent
 * that attempted it is worth knowing about even if it failed.
 */
export type SecurityViolationLogEvent = {
  readonly event: "security_violation";
  readonly data: PathRefusal;
};

export type ConflictLogEvent = {
  readonly event: "conflict";
  readonly data: {
    readonly conflict_id: Id;
    readonly subject: NonEmptyString;
    readonly position_a: ConflictPosition;
    readonly position_b: ConflictPosition;
    readonly phase: "DETECTED" | "RESOLVED_BY_RULE" | "DELEGATED" | "RESOLVED_ON_MERITS" | "ESCALATED";
    readonly winner: "A" | "B" | "NONE";
    readonly rule: string | null;
    readonly detail: string;
  };
};

export type BudgetLogEvent = {
  readonly event: "budget";
  readonly data: {
    readonly kind: "CONSUMED" | "EXCEEDED";
    readonly counter: NonEmptyString;
    readonly scope: "run" | "work_item";
    readonly value: number;
    readonly cap: number | null;
    readonly tried: readonly string[];
  };
};

export type DodComputedLogEvent = {
  readonly event: "dod_computed";
  readonly data: CompletionReport;
};

export type SourceDriftLogEvent = {
  readonly event: "source_drift";
  readonly data: SourceDrift;
};

export type ReresolvedLogEvent = {
  readonly event: "reresolved";
  readonly data: {
    readonly reason: NonEmptyString;
    readonly evidence: readonly Id[];
    readonly count: number;
    readonly cap: number;
    readonly new_run_id: string | null;
  };
};

export type ChildWorkItemLogEvent = {
  readonly event: "child_work_item";
  readonly data: {
    readonly action: "CREATED" | "LINKED" | "REFUSED";
    readonly child_id: string | null;
    readonly external_identity: string | null;
    readonly depends_on: readonly Id[];
    readonly reason: string;
  };
};

export type LeaseLogEvent = {
  readonly event: "lease";
  readonly data: {
    readonly action: "ACQUIRED" | "REFUSED" | "RECLAIMED" | "RELEASED";
    readonly run_id: Id;
    readonly active_run_id: string | null;
    readonly abandoned_run_id: string | null;
    readonly holder: NonEmptyString;
  };
};

export type RecoveryLogEvent = {
  readonly event: "recovery";
  readonly data: {
    readonly phase: "STARTED" | "PARTIAL_LINE_DISCARDED" | "INTERRUPTED_DISPATCH_FOUND" | "COMPLETED";
    readonly replayed_events: number;
    readonly discarded_bytes: number;
    readonly interrupted_dispatch: string | null;
    readonly detail: string;
  };
};

export type SelectionLogEvent = {
  readonly event: "selection";
  readonly data: {
    readonly kind: "MODEL" | "SKILL" | "AGENT";
    readonly selected: string | null;
    readonly candidates: ReadonlyArray<{
      readonly id: NonEmptyString;
      readonly score: number;
      readonly reasons: readonly string[];
      readonly excluded_because: string | null;
    }>;
    readonly why: NonEmptyString;
    readonly escalated_from: string | null;
    readonly escalation_trigger: string | null;
  };
};

export type QuestionLogEvent = {
  readonly event: "question";
  readonly data: {
    readonly phase: "ASKED" | "ANSWERED" | "TIMED_OUT";
    readonly question: NonEmptyString;
    /**
     * One question, both readings, the evidence for each, and what AgentOS would do under
     * each.
     */
    readonly readings: ReadonlyArray<{
      readonly reading: NonEmptyString;
      readonly evidence: readonly Id[];
      readonly would_do: NonEmptyString;
    }>;
    readonly answer: string | null;
    readonly answered_by: string | null;
  };
};

export type DiscoveryLogEvent = {
  readonly event: "discovery";
  readonly data: {
    readonly kind: "TIER_RUN" | "ON_DEMAND_REQUESTED" | "TARGETED_PROBE" | "REPROBE_STALE";
    readonly tier: number | null;
    readonly probes: readonly NonEmptyString[];
    readonly reason: NonEmptyString;
    readonly requested_sections: readonly ContextSectionName[];
  };
};

export type ContextPackageVersionedLogEvent = {
  readonly event: "context_package_versioned";
  readonly data: {
    readonly version: number;
    readonly tier: number;
    readonly path: NonEmptyString;
    readonly supersedes: number | null;
  };
};

export type CapabilityRegistryUpdatedLogEvent = {
  readonly event: "capability_registry_updated";
  readonly data: {
    readonly version: number;
    readonly path: NonEmptyString;
    readonly record_count: number;
    readonly edge_count: number;
    readonly updated_by: AgentRole;
  };
};

export type WorkItemLifecycleLogEvent = {
  readonly event: "work_item_lifecycle";
  readonly data: {
    readonly from: WorkItemLifecycle;
    readonly to: WorkItemLifecycle;
    readonly reason: NonEmptyString;
    readonly evidence: readonly Id[];
    readonly decided_by: "kernel" | "human";
  };
};

/**
 * D-2's binding condition. An SDK upgrade that adds a tool must break this check rather than
 * pass quietly.
 */
export type ToolSurfaceConformanceLogEvent = {
  readonly event: "tool_surface_conformance";
  readonly data: {
    readonly substrate: NonEmptyString;
    readonly verdict: "CONFORMS" | "UNEXPECTED_TOOLS" | "MISSING_TOOLS" | "UNVERIFIABLE";
    readonly expected: readonly string[];
    readonly effective: readonly string[];
    readonly unexpected: readonly string[];
    readonly missing: readonly string[];
    readonly detail: string;
  };
};

/**
 * Intake content naming a template, requesting a stage, setting a confidence or trust class,
 * widening a scope, or claiming an authorization has no effect, and the attempt is recorded.
 */
export type IntakeInstructionAttemptLogEvent = {
  readonly event: "intake_instruction_attempt";
  readonly data: {
    readonly intake_id: Id;
    readonly trust_class: TrustClass;
    readonly attempted: ReadonlyArray<"NAME_TEMPLATE" | "REQUEST_STAGE" | "SET_CONFIDENCE" | "SET_TRUST_CLASS" | "WIDEN_SCOPE" | "CLAIM_AUTHORIZATION" | "CANCEL_RUN">;
    readonly excerpt: string;
    readonly effect: "NONE";
  };
};

export type DuplicateCandidatesLogEvent = {
  readonly event: "duplicate_candidates";
  readonly data: {
    readonly candidates: readonly Id[];
    readonly basis: "identical scope and normalized title";
    readonly action: "SURFACED";
  };
};

/**
 * Both the agent's claim and the kernel's evaluated value, so a systematically over-claiming
 * agent becomes visible in the run narrative.
 */
export type PredicateEvaluatedLogEvent = {
  readonly event: "predicate_evaluated";
  readonly data: {
    readonly predicate: NonEmptyString;
    readonly evaluated: PredicateValue;
    readonly claim: string | null;
    readonly inputs: readonly string[];
    readonly reprobed: boolean;
    readonly reason: string;
  };
};

export type NoteLogEvent = {
  readonly event: "note";
  readonly data: {
    readonly topic: NonEmptyString;
    readonly detail: NonEmptyString;
  };
};

export type CheckOutcome = {
  readonly check: NonEmptyString;
  readonly result: "PASS" | "FAIL" | "NOT_APPLICABLE" | "INDETERMINATE";
  readonly detail: string;
};

export type ReceiptStep = "schema" | "cross_field" | "reconciliation" | "evidence_verification" | "transition" | "persist" | "merge" | "conflict_check";

export type PathRefusal = {
  readonly adapter: NonEmptyString;
  readonly op: NonEmptyString;
  readonly requested: NonEmptyString;
  readonly resolved: string | null;
  readonly rule: "worktree_root" | "mandate_in_scope" | "mandate_out_of_scope" | "deny_list" | "symlink_escape" | "unresolvable";
  readonly deny_list_entry: string | null;
  readonly aborted_dispatch: boolean;
  readonly detail: string;
};

export type ConflictPosition = {
  readonly source: NonEmptyString;
  readonly claim: NonEmptyString;
  readonly confidence: ConfidenceClass;
  readonly evidence: readonly Id[];
};

/**
 * The authoritative record. run.json and work-item.json are projections; if they disagree with
 * the log, the log wins. One newline-terminated line per event.
 */
export type Event = EventBase & EventPayload;

// ========================================================================== evidence.json

/**
 * A machine-evaluable statement about an observation, e.g. `count == 0` or `error_rate <
 * 0.01`.
 */
export type EvidencePredicate = {
  readonly subject: NonEmptyString;
  readonly operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "contains" | "not_contains" | "matches";
  readonly operand: string | number | boolean | null;
};

export type EvidenceVerification = {
  readonly status: VerificationStatus;
  readonly at: Timestamp;
  readonly by: "kernel";
  readonly matches: boolean | null;
  readonly detail?: string;
};

/**
 * An observation the kernel can re-execute. `locator` is what makes evidence a claim the
 * system can check rather than a claim it must believe.
 */
export type Evidence = {
  readonly id: Id;
  readonly kind: EvidenceKind;
  readonly locator: Locator;
  /** Human-readable pointer. For human reading only; never the basis of a check. */
  readonly ref: NonEmptyString;
  readonly excerpt: string;
  readonly observed_at: Timestamp;
  /**
   * False for a genuinely unrepeatable observation, which caps the assertion it supports at
   * INFERENCE.
   */
  readonly reproducible: boolean;
  /**
   * Mandatory for kind `log` and `metric`: the kernel re-evaluates a predicate rather than
   * comparing a volatile raw value.
   */
  readonly predicate?: EvidencePredicate;
  /** Kernel-owned. An envelope arriving with this populated is a contract violation. */
  readonly verification?: EvidenceVerification;
};

// =========================================================================== finding.json

/**
 * A finding without evidence is not a finding; it is a recommendation of category
 * `hypothesis`.
 */
export type Finding = {
  readonly id: Id;
  readonly title: NonEmptyString;
  readonly severity: Severity;
  readonly category: FindingCategory;
  readonly capability: string | null;
  readonly chain_stage: ChainStage | null;
  readonly description: NonEmptyString;
  readonly evidence: readonly Id[];
  readonly confidence: ConfidenceClass;
  readonly impact: NonEmptyString;
  readonly remediation_hint?: string;
};

/**
 * The ten structural detectors of CAPABILITY_MODEL section 5, plus the data-semantics,
 * test-quality and generic categories the Auditor's standing search list names.
 */
export type FindingCategory = "orphan-writer" | "orphan-reader" | "orphan-store" | "dead-calculation" | "broken-chain" | "phantom-api" | "phantom-ui" | "duplicate-ownership" | "field-loss" | "provenance-break" | "fabricated-default" | "collapsed-absence" | "missing-provenance" | "missing-timestamp" | "stale-documentation" | "test-asserts-on-mock" | "unproven-completion" | "structural" | "correctness" | "security" | "other";

export type Blocker = {
  readonly id: Id;
  readonly kind: BlockerKind;
  readonly description: NonEmptyString;
  readonly conflicting_requirements?: readonly string[];
  readonly options?: readonly string[];
  readonly needs: BlockerNeeds;
  readonly evidence: readonly Id[];
};

export type BlockerKind = "ARCHITECTURE_CONTRADICTION" | "MISSING_ACCESS" | "MISSING_CAPABILITY" | "AMBIGUOUS_GOAL" | "AMBIGUOUS_STATE" | "WORK_ITEM_MISCLASSIFIED" | "AUTHORIZATION_REQUIRED" | "BUDGET_EXHAUSTED" | "UNRESOLVED_CONFLICT" | "EXTERNAL_DEPENDENCY";

export type BlockerNeeds = "architect_decision" | "human_decision" | "human_authorization" | "access_grant" | "additional_discovery" | "external_fix" | "re_resolution";

export type UnknownRecord = {
  readonly id: Id;
  readonly subject: NonEmptyString;
  readonly reason: AbsenceReason;
  readonly attempted: NonEmptyString;
  readonly recoverable_by: NonEmptyString;
  /**
   * Downstream obligations that cannot be met. Every entry must name a real obligation; a
   * decorative unknown is a contract violation.
   */
  readonly blocks: readonly NonEmptyString[];
};

export type Assumption = {
  readonly id: Id;
  readonly statement: NonEmptyString;
  readonly breaks_if_wrong: NonEmptyString;
  readonly verify_by: NonEmptyString;
};

export type Recommendation = {
  readonly id: Id;
  readonly category: "hypothesis" | "out-of-scope" | "improvement" | "risk";
  readonly statement: NonEmptyString;
  readonly priority: Severity;
  readonly rationale: NonEmptyString;
  readonly owner_role: AgentRole | null;
  /** Mandatory for `hypothesis`: the observation that would turn a suspicion into a finding. */
  readonly confirming_observation?: string | null;
  readonly evidence?: readonly Id[];
};

/**
 * The agent's account of a mutation. Reconciled against adapter mutation events; it is not the
 * reversal record.
 */
export type ArtifactChange = {
  readonly kind: "file" | "commit" | "branch" | "migration" | "ticket" | "runtime" | "pr" | "comment";
  readonly target: NonEmptyString;
  readonly change: "created" | "modified" | "deleted" | "renamed" | "transitioned";
  readonly sha?: string | null;
  readonly branch?: string | null;
};

/**
 * The difference between 'found nothing there' and 'never looked there'. Mandatory, and
 * reconciled against the dispatch's adapter call log.
 */
export type Coverage = {
  readonly scope_examined: readonly PathGlob[];
  readonly scope_not_examined: readonly PathGlob[];
  readonly confidence: ConfidenceClass;
  readonly notes?: string;
};

// ================================================================== handoff-envelope.json

/**
 * Every value maps to exactly one kernel action (WORKFLOW_STATE_MACHINE section 4.2). PARTIAL
 * is never a soft COMPLETE.
 */
export type EnvelopeStatus = "COMPLETE" | "PARTIAL" | "BLOCKED" | "BLOCKED_BY_ARCHITECTURE" | "FAILED" | "REJECTED";

export type NextAction = {
  readonly proposed_stage: Stage;
  readonly proposed_agent: AgentRole | null;
  readonly rationale: NonEmptyString;
};

/**
 * The only place an agent may ask for something structural. Every key is optional and every
 * one is a proposal the kernel admits, adjusts or refuses.
 */
export type Proposals = {
  readonly work_item?: ProposedWorkItem;
  readonly workflow?: WorkflowProposal;
  readonly decomposition?: readonly DecompositionProposal[];
  readonly triage?: readonly TriageProposal[];
  readonly cancellation?: CancellationProposal;
  readonly dispatch?: DispatchProposal;
  readonly arbitration?: ArbitrationProposal;
  readonly authorization_request?: DraftAuthorizationRequest;
};

export type WorkflowProposal = {
  readonly template_id: NonEmptyString;
  readonly include_optional: readonly TemplateStage[];
  readonly exclude_optional: ReadonlyArray<{
    readonly stage: TemplateStage;
    /**
     * A claim, never a decision. The kernel evaluates the stage's predicate itself and keeps
     * the stage on TRUE or INDETERMINATE.
     */
    readonly claim: NonEmptyString;
    readonly rationale: NonEmptyString;
  }>;
  /** Per-stage mandate scope, bounded by and never exceeding the Work Item's admitted scope. */
  readonly stage_mandates?: {
    readonly [key: string]: Scope | undefined;
  };
  readonly rationale: NonEmptyString;
};

export type DecompositionProposal = {
  readonly title: NonEmptyString;
  readonly type: WorkItemType;
  readonly scope: Scope;
  readonly desired_outcome: NonEmptyString;
  readonly depends_on: readonly NonEmptyString[];
  readonly external_identity: string | null;
};

export type TriageProposal = {
  readonly thread_id: Id;
  readonly reading: NonEmptyString;
  readonly remediation_scope: Scope;
  /**
   * The agent's reading of whether the remediation can be split off. Undeterminable is
   * expressed as UNKNOWN and counts as inside scope.
   */
  readonly separable: PredicateValue;
  /** Recorded and ignored. Routing is kernel scope containment. */
  readonly proposed_route: "COMMENT_RESOLUTION" | "CHILD_WORK_ITEM" | "SCOPE_EXPANSION";
};

export type CancellationProposal = {
  readonly work_item_id: Id;
  readonly to: "SUPERSEDED" | "ABANDONED";
  readonly evidence: readonly Id[];
  readonly rationale: NonEmptyString;
};

/**
 * The Orchestrator's proposed next dispatch. The kernel selects; this is an input to ranking,
 * not a bypass of it.
 */
export type DispatchProposal = {
  readonly stage: Stage;
  readonly agent: AgentRole;
  readonly objective: NonEmptyString;
  readonly mandate_scope: Scope;
  /** Untrusted free text. Grants nothing, and no adapter consults it. */
  readonly advisory_notes: string;
  readonly model_preference?: string | null;
  readonly skill_preference?: readonly NonEmptyString[];
};

export type ArbitrationProposal = {
  readonly conflict_id: Id;
  readonly classification: "FACTUAL" | "INTERPRETIVE" | "SCOPE";
  readonly discriminating_observation: string | null;
  readonly resolution: "A" | "B" | "CANNOT_SETTLE";
  readonly rationale: NonEmptyString;
};

/**
 * The only thing that crosses the boundary between agents. Conversation is never the
 * transport.
 */
export type HandoffEnvelope = {
  readonly envelope_version: "1.2";
  readonly work_item_id: Id;
  readonly run_id: Id;
  readonly envelope_id: Id;
  /**
   * Echoes the dispatch this envelope answers, so a substrate returning the wrong envelope is
   * detectable rather than merged.
   */
  readonly dispatch_id: Id;
  readonly agent: AgentRole;
  readonly agent_version: NonEmptyString;
  readonly model: NonEmptyString;
  readonly skills_used: readonly NonEmptyString[];
  readonly stage_in: Stage;
  readonly started_at: Timestamp;
  readonly completed_at: Timestamp;
  readonly cost: Cost;
  readonly status: EnvelopeStatus;
  readonly summary: NonEmptyString;
  readonly findings: readonly Finding[];
  readonly evidence: readonly Evidence[];
  readonly assumptions: readonly Assumption[];
  readonly unknowns: readonly UnknownRecord[];
  readonly artifacts_changed: readonly ArtifactChange[];
  readonly recommendations: readonly Recommendation[];
  readonly blockers: readonly Blocker[];
  readonly coverage: Coverage;
  /**
   * The dispatch's `required_outputs`, filled. Keyed by output name; a missing or null key is
   * an unfilled output, which is what separates PARTIAL from COMPLETE.
   */
  readonly outputs: Readonly<Record<string, never>>;
  /**
   * Per-criterion verdicts this stage owes. The kernel does the arithmetic and never judges a
   * criterion itself.
   */
  readonly dod_verdicts: readonly CriterionVerdict[];
  readonly proposals: Proposals;
  /**
   * A proposal. The kernel validates it against the frozen graph and evaluates the transition
   * predicate itself.
   */
  readonly next_action: NextAction | null;
};

// ===================================================================== input-package.json

/**
 * Structured, not prose. The adapters enforce in_scope and out_of_scope as path constraints on
 * top of worktree confinement.
 */
export type Mandate = {
  readonly objective: NonEmptyString;
  readonly in_scope: readonly PathGlob[];
  readonly out_of_scope: readonly PathGlob[];
  readonly capabilities: readonly Id[];
  /**
   * Untrusted free text from the Orchestrator Agent. It grants nothing and no adapter consults
   * it.
   */
  readonly advisory_notes: string;
};

export type AuthorizationScope = {
  readonly autonomous: readonly NonEmptyString[];
  readonly gated: readonly Gate[];
  readonly grants_held: readonly Id[];
};

export type ToolGrant = {
  readonly adapter: NonEmptyString;
  readonly op: NonEmptyString;
  /**
   * The name the substrate exposes. The conformance check compares effective tool names
   * against exactly this set.
   */
  readonly tool_name: NonEmptyString;
  readonly description: NonEmptyString;
  readonly args_schema: Readonly<Record<string, unknown>>;
};

/**
 * A suggestion to the agent, not an obligation. A skill that can spawn an agent never appears
 * here.
 */
export type SkillOffer = {
  readonly id: NonEmptyString;
  readonly source: "global" | "repository" | "plugin" | "connector" | "mcp" | "builtin" | "script";
  readonly description: NonEmptyString;
  readonly mutating: boolean;
};

export type DispatchBudget = {
  readonly max_usd: number;
  readonly max_turns: number;
  readonly max_wall_clock_ms: number;
};

/**
 * What an agent receives. A typed input, never a conversation. `prior_envelopes` are
 * references to structured envelopes, not transcript text.
 */
export type InputPackage = {
  readonly work_item_id: Id;
  readonly run_id: Id;
  /** Seeds idempotency: every mutating adapter call in this dispatch derives its key from it. */
  readonly dispatch_id: Id;
  readonly agent: AgentRole;
  /**
   * Which of the role's mandates this dispatch is. Context Discovery has two: `resolution`
   * before admission, `context` after it.
   */
  readonly mandate_name: NonEmptyString;
  readonly stage: Stage;
  /**
   * Replaces v0.2's inlined goal. One authoritative statement of what is being attempted, read
   * by every agent.
   */
  readonly work_item_ref: string | null;
  /** Populated for the resolution mandate, which runs before a Work Item exists. */
  readonly intake_ref: string | null;
  /**
   * Read-only, so an agent knows what comes after it. Insufficient for changing anything: the
   * graph is frozen and the kernel evaluates the edges.
   */
  readonly workflow: {
    readonly template_id: NonEmptyString;
    readonly version: NonEmptyString;
    readonly stages_remaining: readonly TemplateStage[];
  } | null;
  readonly context_package_ref: string | null;
  /**
   * The materialized subset. `required_inputs` bounds what is built, which is what keeps input
   * size independent of run length.
   */
  readonly context_sections: {
    readonly [key: string]: unknown;
  };
  readonly capability_registry_ref: string | null;
  readonly prior_envelopes: readonly Id[];
  readonly mandate: Mandate;
  readonly required_inputs: readonly ContextSectionName[];
  readonly required_outputs: readonly NonEmptyString[];
  readonly dod_profile_ref: string | null;
  readonly dod_criteria_owed: readonly DodCriterionId[];
  readonly constraints: readonly NonEmptyString[];
  readonly authorization_scope: AuthorizationScope;
  /**
   * The exact adapter operations this dispatch may reach. The effective tool surface is an
   * allowlist, and a startup conformance check asserts it equals this set.
   */
  readonly tools_granted: readonly ToolGrant[];
  readonly skills_available: readonly SkillOffer[];
  readonly model: NonEmptyString;
  readonly budget: DispatchBudget;
};

// ============================================================================ policy.json

/**
 * policies/predicates.json. A transition table whose branch conditions are prose is a table an
 * agent decides.
 */
export type PredicateDefinition = {
  readonly name: string;
  readonly family: "applicability" | "reality";
  readonly description: NonEmptyString;
  /**
   * Which named inputs the evaluator consults. A predicate over an UNKNOWN input is
   * INDETERMINATE, never FALSE.
   */
  readonly reads: readonly NonEmptyString[];
  /**
   * Which freshness window governs the inputs. A STALE input is re-probed before the predicate
   * is evaluated.
   */
  readonly freshness_class: "git" | "runtime" | "repository" | "intent" | "agentos";
  /**
   * The kernel evaluator that implements it. Naming it in data keeps the mapping auditable
   * without putting the logic here.
   */
  readonly evaluator: NonEmptyString;
};

export type PredicateSet = {
  readonly version: NonEmptyString;
  readonly predicates: readonly PredicateDefinition[];
};

/**
 * policies/workflow-floor.json. Rules of the form: if the graph contains X, it must contain Y
 * before it.
 */
export type FloorRule = {
  readonly id: NonEmptyString;
  readonly description: NonEmptyString;
  readonly trigger: FloorTrigger;
  readonly requires: readonly FloorRequirement[];
  readonly forbids: readonly TemplateStage[];
  /**
   * A floor rule keyed on a resolved field can only be as good as the resolution; a rule keyed
   * on observed reality cannot be defeated by misclassification.
   */
  readonly keyed_on: "graph" | "type" | "reality" | "scope";
};

export type FloorTrigger = {
  readonly kind: "contains_stage";
  readonly stage: TemplateStage;
} | {
  readonly kind: "work_item_type";
  readonly type: WorkItemType;
} | {
  readonly kind: "predicate_true";
  readonly predicate: NonEmptyString;
} | {
  readonly kind: "always";
};

export type FloorRequirement = {
  readonly stage: TemplateStage;
  readonly position: "before" | "after" | "present" | "sole_predecessor_of_complete";
  readonly relative_to: TemplateStage | null;
};

export type WorkflowFloor = {
  readonly version: NonEmptyString;
  readonly rules: readonly FloorRule[];
};

export type StageSet = {
  readonly version: NonEmptyString;
  readonly stages: readonly StageDescriptor[];
};

/**
 * policies/work-items.json. Per type, the minimum evidence class required to assert it. Nobody
 * declares an incident by writing the word.
 */
export type WorkItemPolicy = {
  readonly version: NonEmptyString;
  readonly resolution_confidence_threshold: number;
  readonly types: ReadonlyArray<{
    readonly type: WorkItemType;
    readonly description: NonEmptyString;
    readonly minimum_evidence: ReadonlyArray<{
      readonly requirement: "external_item_of_this_type" | "child_items_exist" | "runtime_or_production_observation" | "capability_record_intersecting_scope" | "no_capability_record_intersecting_scope" | "named_path_exists" | "existing_change_proposal" | "reproduction_or_incorrect_behaviour_report" | "none";
      readonly kinds: readonly EvidenceKind[];
      readonly note: NonEmptyString;
    }>;
    /**
     * `ALL` requires every entry; `ANY` requires one. `UNKNOWN` requires none, which is why it
     * is the fallback.
     */
    readonly satisfied_by: "ALL" | "ANY" | "NONE";
    readonly candidate_dod_profiles: readonly DodProfileId[];
  }>;
};

export type IntakePolicy = {
  readonly version: NonEmptyString;
  /** What each host can assert. A host that cannot assert a principal must classify EXTERNAL. */
  readonly hosts: ReadonlyArray<{
    readonly host: NonEmptyString;
    readonly can_assert_principal: boolean;
    readonly trust_class: TrustClass;
    readonly sources: readonly IntakeSource[];
  }>;
  /**
   * EXTERNAL. Every source classifies EXTERNAL until a host exists that can assert a principal
   * for it.
   */
  readonly default_trust_class: "EXTERNAL";
  /**
   * Sources for which AUTONOMOUS_INTAKE_EXECUTION is pre-granted, so a trusted webhook stays
   * autonomous and an unconfigured one does not.
   */
  readonly pre_granted_autonomous_intake: readonly NonEmptyString[];
  /**
   * Patterns whose presence in intake content is recorded as an attempted instruction and
   * otherwise ignored.
   */
  readonly instruction_markers: ReadonlyArray<{
    readonly attempt: "NAME_TEMPLATE" | "REQUEST_STAGE" | "SET_CONFIDENCE" | "SET_TRUST_CLASS" | "WIDEN_SCOPE" | "CLAIM_AUTHORIZATION" | "CANCEL_RUN";
    readonly patterns: readonly NonEmptyString[];
  }>;
};

export type EvidencePolicy = {
  readonly version: NonEmptyString;
  readonly always_verify: ReadonlyArray<"critical_or_high_finding" | "authorization_request" | "dod_criterion_met" | "fact_contradicting_existing_assertion">;
  readonly sample_rate: number;
  readonly sample_minimum_per_envelope: number;
  readonly mismatch_threshold_per_envelope: number;
  readonly authorization_mismatch_threshold: number;
  readonly comparators: ReadonlyArray<{
    readonly kind: EvidenceKind;
    readonly comparator: "normalized_exact_match" | "predicate_reevaluation" | "identifier_plus_content_hash" | "not_kernel_verifiable";
    readonly requires_predicate: boolean;
    readonly note: NonEmptyString;
  }>;
};

export type BudgetPolicy = {
  readonly version: NonEmptyString;
  readonly loops: {
    readonly rework: ScopedCap;
    readonly architecture: ScopedCap;
    readonly review: ScopedCap;
    readonly discovery: ScopedCap;
  };
  readonly reresolution: number;
  readonly decomposition: {
    readonly max_children: number;
    readonly max_depth: number;
  };
  readonly cost: {
    readonly run_usd: number;
    readonly work_item_usd: number;
    readonly dispatch_usd: number;
  };
  readonly wall_clock_ms: {
    readonly run: number;
    readonly dispatch: number;
  };
  readonly dispatches: ScopedCap;
  readonly dispatch_retries: number;
  readonly model_escalations_per_dispatch: number;
  readonly max_turns_per_dispatch: number;
  readonly lease_timeout_ms: number;
  readonly authorization_window_ms: number;
  readonly question_window_ms: number;
  readonly freshness_windows_ms: {
    readonly git: number;
    readonly runtime: number;
    readonly repository: number;
    readonly intent: number;
    readonly agentos: number;
  };
  /** Reads are logged at this granularity. Aggregation is permitted; omission is not. */
  readonly read_call_log_granularity: {
    readonly aggregate_identical_within_ms: number;
    readonly max_aggregated: number;
  };
};

/** Per Workflow Run and per Work Item. A budget that resets on every attempt is not a budget. */
export type ScopedCap = {
  readonly per_run: number;
  readonly per_work_item: number;
};

/**
 * policies/paths.json. The absolute deny-list, checked even for paths that pass worktree and
 * mandate checks. Rule 3 is the backstop that holds when 1 and 2 are wrong.
 */
export type PathPolicy = {
  readonly version: NonEmptyString;
  readonly deny: ReadonlyArray<{
    readonly id: NonEmptyString;
    readonly description: NonEmptyString;
    readonly kind: "installation_relative" | "absolute" | "home_relative" | "name_anywhere";
    readonly patterns: readonly PathGlob[];
  }>;
  /**
   * Where incidental artifacts may land without disqualifying an operation's observation
   * safety.
   */
  readonly scratch_roots: readonly PathGlob[];
};

export type GatePolicy = {
  readonly version: NonEmptyString;
  readonly gates: readonly GateDefinition[];
};

export type DodPolicySet = {
  readonly version: NonEmptyString;
  /**
   * The eighteen criteria and their single owning role. A criterion with two owners is decided
   * by whichever ran last.
   */
  readonly criteria: ReadonlyArray<{
    readonly criterion: DodCriterionId;
    readonly name: NonEmptyString;
    readonly owner_role: AgentRole;
    /** Which pass of the owning role supplies it. The Auditor's second pass owns 6, 16 and 17. */
    readonly owner_pass: "first" | "second" | "only";
    readonly evidence_class: "structural" | "implementation" | "behavioural" | "capability" | "runtime" | "production" | "ux" | "knowledge";
  }>;
  readonly profiles: readonly DodProfile[];
};

/**
 * Which proposals and statuses each role may make, and in which stages. Enforced as
 * cross-field rules on envelope receipt.
 */
export type AgentPolicy = {
  readonly version: NonEmptyString;
  readonly roles: ReadonlyArray<{
    readonly role: AgentRole;
    readonly may_propose: ReadonlyArray<"work_item" | "workflow" | "decomposition" | "triage" | "cancellation" | "dispatch" | "arbitration" | "authorization_request">;
    /**
     * Stage restrictions per proposal key. A decomposition outside DECOMPOSITION is a contract
     * violation.
     */
    readonly proposal_stages: {
      readonly [key: string]: ReadonlyArray<Stage | "*"> | undefined;
    };
    readonly may_return_statuses: readonly EnvelopeStatus[];
    /**
     * The Orchestrator's is empty on purpose: the component that judges evidence must not also
     * manufacture it.
     */
    readonly permitted_adapters: readonly NonEmptyString[];
    readonly read_only: boolean;
  }>;
};

// ========================================================================== registry.json

export type SkillEntry = {
  readonly id: NonEmptyString;
  readonly source: "global" | "repository" | "plugin" | "connector" | "mcp" | "builtin" | "script";
  readonly description: NonEmptyString;
  readonly declared_inputs: readonly string[];
  readonly declared_outputs: readonly string[];
  readonly availability: AdapterAvailability;
  readonly mutating: boolean;
  /**
   * A skill with spawns_agents: true is never selectable. A skill whose spawning behaviour
   * cannot be determined is treated as true.
   */
  readonly spawns_agents: boolean;
  readonly spawns_agents_determined: boolean;
  readonly external_destination: boolean;
  readonly reversal: string | null;
  readonly domains: ReadonlyArray<"repository_analysis" | "git" | "database" | "api" | "ui" | "testing" | "deployment" | "project_management" | "documentation">;
  readonly operations: ReadonlyArray<"read" | "analyse" | "generate" | "mutate" | "verify">;
  readonly targets: ReadonlyArray<"filesystem" | "vcs" | "data_store" | "network" | "runtime">;
  readonly observed_success_rate: number | null;
  readonly cost_hint: "low" | "medium" | "high" | "unknown";
};

/**
 * Where a property is not knowable it is null, and selection degrades sensibly rather than
 * assuming the best case.
 */
export type ModelEntry = {
  readonly id: NonEmptyString;
  readonly availability: AdapterAvailability;
  readonly context_window: number | null;
  readonly reasoning: "shallow" | "mid" | "deep" | "unknown";
  readonly coding: "none" | "basic" | "strong" | "unknown";
  readonly vision: "none" | "basic" | "strong" | "unknown";
  readonly tool_use: "none" | "basic" | "strong" | "unknown";
  readonly usd_per_mtok_input: number | null;
  readonly usd_per_mtok_output: number | null;
  readonly latency_class: "fast" | "medium" | "slow" | "unknown";
  readonly precision_class: "standard" | "high" | "unknown";
};

/** Each agent declares what it needs, not which model it wants. */
export type ModelRequirement = {
  readonly context: "small" | "medium" | "large";
  readonly reasoning: "shallow" | "mid" | "deep";
  readonly coding: boolean;
  readonly vision: boolean;
  readonly tool_use: "none" | "basic" | "strong";
  readonly precision: "standard" | "high";
};

export type RankedCandidate = {
  readonly id: NonEmptyString;
  readonly score: number;
  readonly reasons: readonly NonEmptyString[];
  readonly excluded_because: string | null;
};

export type SkillRegistry = {
  readonly entries: readonly SkillEntry[];
  readonly enumerated_at: Timestamp;
};

export type ModelRegistry = {
  readonly entries: readonly ModelEntry[];
  readonly enumerated_at: Timestamp;
};

/**
 * An agent is a specification: mandate, required inputs, permitted adapters, output envelope
 * type, and the model and skill requirements it declares.
 */
export type AgentSpec = {
  readonly role: AgentRole;
  readonly mandate_name: NonEmptyString;
  readonly version: NonEmptyString;
  readonly objective: NonEmptyString;
  readonly stages: readonly Stage[];
  readonly required_inputs: readonly ContextSectionName[];
  readonly required_outputs: readonly NonEmptyString[];
  readonly permitted_adapters: readonly NonEmptyString[];
  readonly read_only: boolean;
  /**
   * Hard limits matter as much as mandates. Most multi-agent failure is an agent quietly doing
   * another agent's job.
   */
  readonly hard_limits: readonly NonEmptyString[];
  readonly must_declare: readonly NonEmptyString[];
  readonly model_requirement: ModelRequirement;
  readonly dod_criteria_owned: readonly DodCriterionId[];
};

// ========================================================================= rejection.json

/**
 * One code per rule the kernel enforces itself. Each maps to a cross-field rule, an invariant,
 * or an admission check.
 */
export type ViolationCode = "SCHEMA_INVALID" | "COMPLETE_WITH_BLOCKERS" | "COMPLETE_WITH_UNFILLED_OUTPUT" | "BLOCKED_WITHOUT_BLOCKERS" | "BLOCKED_BY_ARCHITECTURE_ILLEGAL_ROLE" | "BLOCKED_BY_ARCHITECTURE_ILLEGAL_STAGE" | "BLOCKED_BY_ARCHITECTURE_NO_ARCHITECTURE_STAGE" | "REJECTED_FROM_NON_REVIEWING_ROLE" | "STATUS_ILLEGAL_FOR_STAGE" | "PROPOSAL_NOT_PERMITTED_FOR_ROLE" | "PROPOSAL_NOT_PERMITTED_IN_STAGE" | "PROPOSAL_RESERVES_KERNEL_DECISION" | "DANGLING_EVIDENCE_REFERENCE" | "DANGLING_BLOCKS_REFERENCE" | "FACT_FINDING_WITHOUT_VERIFIED_EVIDENCE" | "VERIFICATION_PRESENT_ON_ARRIVAL" | "COVERAGE_MISSING" | "COVERAGE_OVERSTATED" | "PREDICATE_MISSING_ON_LOG_OR_METRIC_EVIDENCE" | "UX_VERDICT_WITHOUT_CALL_ANCHORED_EVIDENCE" | "ASSERTION_WITHOUT_CONFIDENCE" | "ARTIFACTS_UNDER_REPORTED" | "ARTIFACTS_OVER_REPORTED" | "EVIDENCE_MISMATCH_THRESHOLD" | "DISPATCH_ID_MISMATCH" | "OUTPUT_NOT_A_REQUIRED_OUTPUT" | "DOD_VERDICT_CRITERION_NOT_OWNED" | "DOD_VERDICT_MISSING_REASON" | "ILLEGAL_TRANSITION" | "STAGE_NOT_IN_TEMPLATE" | "EXCLUSION_PREDICATE_NOT_FALSE" | "SCOPE_EXCEEDS_WORK_ITEM" | "UNBOUNDED_SCOPE" | "TYPE_WITHOUT_MINIMUM_EVIDENCE" | "EXTERNAL_IDENTITY_UNRESOLVED" | "OUTCOME_NOT_BINDABLE" | "DECOMPOSITION_BOUND_EXCEEDED" | "DECOMPOSITION_CYCLE" | "CANCELLATION_WITHOUT_EVIDENCE" | "INTAKE_INSTRUCTION_IGNORED" | "GRANT_MISSING" | "GRANT_EXPIRED" | "GRANT_MISMATCHED" | "SECURITY_FLOOR_VIOLATION" | "TOOL_SURFACE_NON_CONFORMANT" | "SPAWNING_SKILL_SELECTED" | "MUTATING_SKILL_FOR_READ_ONLY_STAGE" | "UNLOGGABLE_MUTATION" | "OBSERVATION_NOT_SAFE_FOR_REPLAY";

export type Violation = {
  readonly code: ViolationCode;
  /**
   * Where the rule is written, e.g. `AGENT_HANDOFF_CONTRACT cross-field rules` or
   * `KERNEL_BOUNDARY section 8 invariant 4`.
   */
  readonly rule: NonEmptyString;
  readonly message: NonEmptyString;
  /** JSON Pointer into the offending document, where one applies. */
  readonly path: string | null;
  /** A contract violation is handled as BLOCKED; the kernel never guesses what an agent meant. */
  readonly handled_as: "BLOCKED" | "FAILED" | "DOWNGRADED" | "REFUSED" | "OVERRIDDEN";
  readonly subject: string | null;
};

/**
 * The result of any kernel admission or receipt. `accepted: false` always carries at least one
 * violation.
 */
export type Rejection = {
  readonly accepted: boolean;
  readonly violations: readonly Violation[];
};

// ========================================================================= work-item.json

/**
 * Adapter-normalized. `raw` is verbatim: no agent summarizes intake before it is recorded,
 * because a summary that drops the discriminating clause is how a resolution goes wrong
 * invisibly.
 */
export type IntakeRecord = {
  readonly intake_id: Id;
  readonly received_at: Timestamp;
  readonly source: IntakeSource;
  readonly source_locator: Locator;
  readonly principal: Principal;
  /**
   * Set by the host from authenticated context, never from the content. A webhook body cannot
   * promote itself.
   */
  readonly trust_class: TrustClass;
  readonly raw: string;
  /**
   * Hash of `raw` at admission. Compared at COMPLETION against a re-execution of
   * `source_locator` to detect source drift.
   */
  readonly content_hash: string;
  readonly attachments: readonly IntakeAttachment[];
  readonly correlation: {
    readonly prior_work_item: string | null;
    readonly prior_run: string | null;
  };
};

export type Principal = {
  readonly id: NonEmptyString;
  /**
   * Which host asserted this identity. A host that cannot assert a principal classifies the
   * intake EXTERNAL.
   */
  readonly asserted_by: NonEmptyString;
};

export type IntakeAttachment = {
  readonly name: NonEmptyString;
  readonly locator: Locator;
  readonly media_type: NonEmptyString;
};

/** Resolution's output. Every field is an assertion with a confidence class, the type included. */
export type ProposedWorkItem = {
  readonly source_intake: Id;
  readonly intent: Assertion;
  readonly type: Assertion;
  readonly external_identity: Assertion;
  readonly title: Assertion;
  readonly desired_outcome: Assertion;
  readonly scope: ScopeAssertion;
  readonly constraints: readonly NonEmptyString[];
  readonly dependencies: readonly NonEmptyString[];
  readonly parent: Assertion;
  /**
   * The agent's own number. Recorded, never the reason anything is believed, consulted only at
   * the policy threshold.
   */
  readonly resolution_confidence: number;
  /**
   * Every alternative reading considered and why it was rejected. This list is what the
   * uncertainty ladder and any question to a human are built from.
   */
  readonly alternatives: readonly ResolutionAlternative[];
};

export type ResolutionAlternative = {
  readonly type: WorkItemType;
  readonly reading: NonEmptyString;
  readonly why_rejected: NonEmptyString;
  /**
   * What AgentOS would do under this reading. Rung 4 of the uncertainty ladder asks with this
   * in hand.
   */
  readonly would_do?: string;
};

export type ScopeAssertion = {
  readonly paths: readonly PathGlob[];
  readonly capabilities: readonly Id[];
  readonly repositories: readonly NonEmptyString[];
  readonly confidence: ConfidenceClass;
};

/** The durable thing AgentOS is trying to accomplish. It outlives every attempt. */
export type WorkItem = {
  readonly work_item_id: Id;
  readonly created_at: Timestamp;
  readonly source_intake: Id;
  readonly origin_trust_class: TrustClass;
  readonly type: WorkItemType;
  /**
   * What resolution asserted, kept when the kernel admitted the item as UNKNOWN for want of
   * the type's minimum evidence.
   */
  readonly claimed_type: WorkItemType | null;
  readonly title: NonEmptyString;
  readonly external_identity: string | null;
  readonly desired_outcome: NonEmptyString;
  readonly scope: Scope;
  readonly constraints: readonly NonEmptyString[];
  readonly dependencies: readonly Id[];
  readonly lifecycle: WorkItemLifecycle;
  /**
   * Profiles the desired outcome binds to. Non-empty is an admission requirement: an outcome
   * nothing can demonstrate is a wish.
   */
  readonly candidate_dod_profiles: readonly DodProfileId[];
  readonly links: readonly WorkItemLink[];
  /** Surfaced, never auto-merged. A wrong merge destroys history. */
  readonly duplicate_candidates: readonly Id[];
  readonly lease: RunLease | null;
  readonly runs: readonly Id[];
  readonly reresolution_count: number;
  readonly decomposition_depth: number;
  /**
   * Denials are recorded at the work item level, so starting a fresh run is not a way to
   * re-ask.
   */
  readonly denied_gates: readonly GateDenial[];
  readonly consumed_budget: ConsumedBudget;
};

export type WorkItemLink = {
  readonly kind: WorkItemLinkKind;
  readonly target: Id;
};

/**
 * One active Workflow Run per Work Item. Acquired atomically by exclusive create, never
 * read-then-write.
 */
export type RunLease = {
  readonly run_id: Id;
  readonly acquired_at: Timestamp;
  readonly holder: NonEmptyString;
};

export type GateDenial = {
  readonly gate: Gate;
  readonly target: NonEmptyString;
  readonly denied_at: Timestamp;
  readonly denied_by: NonEmptyString;
  readonly reason: string;
};

/**
 * Per Work Item, not only per run: three runs of two laps each is six laps, and a budget that
 * resets on every attempt is not a budget.
 */
export type ConsumedBudget = {
  readonly usd: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly dispatches: number;
  readonly loops: {
    readonly [key: string]: number | undefined;
  };
};

// ========================================================================== workflow.json

/**
 * policies/stages.json, one per stage. `mutating` is load-bearing in three places: the
 * safe-prefix computation, the resume rule, and the AUTONOMOUS_INTAKE_EXECUTION gate.
 */
export type StageDescriptor = {
  readonly stage: TemplateStage;
  readonly mutating: boolean;
  readonly default_agent: AgentRole;
  readonly required_outputs: readonly NonEmptyString[];
  readonly exit_condition: NonEmptyString;
  /**
   * The reality predicate meaning 'already done'. `null` where a stage can never be satisfied
   * by prior reality.
   */
  readonly satisfied_by: string | null;
  readonly gates_possible: readonly Gate[];
  readonly dod_criteria: readonly number[];
  /**
   * Evaluated by the kernel when a proposal asks to exclude this stage. TRUE or INDETERMINATE
   * keeps the stage.
   */
  readonly applicability_predicate: string | null;
};

export type WorkflowEdge = {
  readonly from: TemplateStage;
  readonly to: Stage;
  /** `always`, a named predicate (optionally negated with `NOT `), or `envelope.<STATUS>`. */
  readonly when: NonEmptyString;
  readonly kind: "advance" | "branch" | "loop" | "escalate" | "terminal";
  readonly counter?: string | null;
  readonly cap?: string | null;
  readonly blocker_kind?: BlockerKind | null;
};

export type WorkflowTemplate = {
  readonly template_id: NonEmptyString;
  readonly version: NonEmptyString;
  readonly description: NonEmptyString;
  readonly applies_to: {
    /** Work item types, or `["*"]` for a template admissible for every type. */
    readonly types: ReadonlyArray<WorkItemType | "*">;
  };
  readonly entry: TemplateStage;
  readonly stages: readonly TemplateStage[];
  readonly optional_stages: readonly TemplateStage[];
  readonly edges: readonly WorkflowEdge[];
  readonly dod_profile_default: DodProfileId;
};

/** The parameterized instance, frozen at run start. Replayed on recovery, never recomputed. */
export type FrozenGraph = {
  readonly template_id: NonEmptyString;
  readonly template_version: NonEmptyString;
  readonly entry: TemplateStage;
  readonly stages: readonly TemplateStage[];
  readonly edges: readonly WorkflowEdge[];
  readonly excluded_stages: ReadonlyArray<{
    readonly stage: TemplateStage;
    readonly predicate: NonEmptyString;
    readonly evaluated: "FALSE";
  }>;
  readonly stage_mandates: {
    readonly [key: string]: Scope | undefined;
  };
  readonly risk_class: RiskClass;
  readonly dod_profile_default: DodProfileId;
};

export type StageCursorEntry = {
  readonly stage: TemplateStage;
  /** COMPLETED_PRIOR means the mutation has already occurred, not that the criteria are met. */
  readonly state: "PENDING" | "ACTIVE" | "COMPLETED" | "COMPLETED_PRIOR" | "EXCLUDED";
  readonly reality_evidence: readonly Id[];
  readonly entered_at: string | null;
  readonly left_at: string | null;
};

/** run.json — a projection rebuildable from events.ndjson. If they disagree, the log wins. */
export type RunRecord = {
  readonly run_id: Id;
  readonly work_item_id: Id;
  readonly started_at: Timestamp;
  readonly ended_at: string | null;
  readonly outcome: RunOutcome | null;
  readonly graph: FrozenGraph;
  readonly current_stage: Stage;
  readonly pre_block_stage: Stage | null;
  readonly cursor: readonly StageCursorEntry[];
  readonly loop_counters: {
    readonly [key: string]: number | undefined;
  };
  readonly consumed_budget: ConsumedBudget;
  readonly open_blockers: readonly Blocker[];
  readonly pending_authorizations: readonly Id[];
  readonly envelope_ids: readonly Id[];
  readonly context_package_version: number | null;
  readonly last_seq: number;
};
