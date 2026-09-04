import { ALL_SCHEMAS, COMMON_SCHEMA, EVENT_SCHEMA, FINDING_SCHEMA, HANDOFF_ENVELOPE_SCHEMA, REJECTION_SCHEMA, CONTEXT_PACKAGE_SCHEMA } from './generated/schemas.js';
import type { JsonSchemaObject } from './validator/types.js';
import type {
  AbsenceReason,
  AgentRole,
  BlockerKind,
  BlockerNeeds,
  CapabilityStatus,
  ChainStage,
  CompletionVerdict,
  ConfidenceClass,
  ContextSectionName,
  ControlState,
  DataSemantic,
  DodProfileId,
  DodVerdict,
  EnvelopeStatus,
  EventKind,
  EvidenceKind,
  FindingCategory,
  Freshness,
  Gate,
  IntakeSource,
  PredicateValue,
  PrologueStage,
  RealityElement,
  ReconciliationState,
  ReviewingRole,
  RiskClass,
  RunOutcome,
  Severity,
  Stage,
  TemplateStage,
  TrustClass,
  ViolationCode,
  VerificationStatus,
  WorkItemLifecycle,
  WorkItemLinkKind,
  WorkItemType,
} from './generated/types.js';

/**
 * Runtime enum values, read out of the schemas rather than restated.
 *
 * The kernel needs to iterate these — the fixture set requires one valid fixture per
 * control-flow-bearing enum value, the envelope-status switch must be exhaustive, and the
 * policy loader checks referential integrity across them. Restating them in TypeScript
 * would create a second list to keep in step; taking them from the schema means the
 * schema is still the only place a value is added.
 */
function enumOf<T extends string>(schema: JsonSchemaObject, pointer: string): readonly T[] {
  let node: unknown = schema;
  for (const token of pointer.split('/')) {
    if (node === null || typeof node !== 'object') {
      throw new Error(`vocab: ${pointer} does not resolve`);
    }
    node = (node as Record<string, unknown>)[token];
  }
  if (node === null || typeof node !== 'object') {
    throw new Error(`vocab: ${pointer} does not resolve to a schema`);
  }
  const values = (node as JsonSchemaObject)['enum'];
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`vocab: ${pointer} has no non-empty enum`);
  }
  return Object.freeze(values.map(String)) as readonly T[];
}

const C = '$defs';

export const CONFIDENCE_CLASSES = enumOf<ConfidenceClass>(COMMON_SCHEMA, `${C}/confidenceClass`);
export const ABSENCE_REASONS = enumOf<AbsenceReason>(COMMON_SCHEMA, `${C}/absenceReason`);
export const DATA_SEMANTICS = enumOf<DataSemantic>(COMMON_SCHEMA, `${C}/dataSemantic`);
export const FRESHNESS_VALUES = enumOf<Freshness>(COMMON_SCHEMA, `${C}/freshness`);
export const PREDICATE_VALUES = enumOf<PredicateValue>(COMMON_SCHEMA, `${C}/predicateValue`);
export const EVIDENCE_KINDS = enumOf<EvidenceKind>(COMMON_SCHEMA, `${C}/evidenceKind`);
export const VERIFICATION_STATUSES =
  enumOf<VerificationStatus>(COMMON_SCHEMA, `${C}/verificationStatus`);
export const SEVERITIES = enumOf<Severity>(COMMON_SCHEMA, `${C}/severity`);
export const AGENT_ROLES = enumOf<AgentRole>(COMMON_SCHEMA, `${C}/agentRole`);
export const REVIEWING_ROLES = enumOf<ReviewingRole>(COMMON_SCHEMA, `${C}/reviewingRole`);
export const STAGES = enumOf<Stage>(COMMON_SCHEMA, `${C}/stage`);
export const PROLOGUE_STAGES = enumOf<PrologueStage>(COMMON_SCHEMA, `${C}/prologueStage`);
export const CONTROL_STATES = enumOf<ControlState>(COMMON_SCHEMA, `${C}/controlState`);
export const TEMPLATE_STAGES = enumOf<TemplateStage>(COMMON_SCHEMA, `${C}/templateStage`);
export const WORK_ITEM_TYPES = enumOf<WorkItemType>(COMMON_SCHEMA, `${C}/workItemType`);
export const WORK_ITEM_LIFECYCLES =
  enumOf<WorkItemLifecycle>(COMMON_SCHEMA, `${C}/workItemLifecycle`);
export const WORK_ITEM_LINK_KINDS =
  enumOf<WorkItemLinkKind>(COMMON_SCHEMA, `${C}/workItemLinkKind`);
export const INTAKE_SOURCES = enumOf<IntakeSource>(COMMON_SCHEMA, `${C}/intakeSource`);
export const TRUST_CLASSES = enumOf<TrustClass>(COMMON_SCHEMA, `${C}/trustClass`);
export const RECONCILIATION_STATES =
  enumOf<ReconciliationState>(COMMON_SCHEMA, `${C}/reconciliationState`);
export const CAPABILITY_STATUSES =
  enumOf<CapabilityStatus>(COMMON_SCHEMA, `${C}/capabilityStatus`);
export const CHAIN_STAGES = enumOf<ChainStage>(COMMON_SCHEMA, `${C}/chainStage`);
export const RISK_CLASSES = enumOf<RiskClass>(COMMON_SCHEMA, `${C}/riskClass`);
export const GATES = enumOf<Gate>(COMMON_SCHEMA, `${C}/gate`);
export const DOD_VERDICTS = enumOf<DodVerdict>(COMMON_SCHEMA, `${C}/dodVerdict`);
export const COMPLETION_VERDICTS =
  enumOf<CompletionVerdict>(COMMON_SCHEMA, `${C}/completionVerdict`);
export const DOD_PROFILE_IDS = enumOf<DodProfileId>(COMMON_SCHEMA, `${C}/dodProfileId`);
export const RUN_OUTCOMES = enumOf<RunOutcome>(COMMON_SCHEMA, `${C}/runOutcome`);

export const ENVELOPE_STATUSES =
  enumOf<EnvelopeStatus>(HANDOFF_ENVELOPE_SCHEMA, `${C}/status`);
export const BLOCKER_KINDS = enumOf<BlockerKind>(FINDING_SCHEMA, `${C}/blockerKind`);
export const BLOCKER_NEEDS = enumOf<BlockerNeeds>(FINDING_SCHEMA, `${C}/needs`);
export const FINDING_CATEGORIES =
  enumOf<FindingCategory>(FINDING_SCHEMA, `${C}/findingCategory`);
export const EVENT_KINDS = enumOf<EventKind>(EVENT_SCHEMA, `${C}/eventKind`);
export const VIOLATION_CODES = enumOf<ViolationCode>(REJECTION_SCHEMA, `${C}/violationCode`);
export const CONTEXT_SECTION_NAMES =
  enumOf<ContextSectionName>(CONTEXT_PACKAGE_SCHEMA, `${C}/sectionName`);
export const REALITY_ELEMENTS =
  enumOf<RealityElement>(CONTEXT_PACKAGE_SCHEMA, `${C}/realityElement`);

/** Every registered schema `$id`, for the audit that no schema is orphaned. */
export const SCHEMA_IDS: readonly string[] = Object.freeze(
  ALL_SCHEMAS.map((s) => String(s['$id'])).sort(),
);

/**
 * The stages a template may contain that do not mutate authoritative state.
 *
 * Declared in `policies/stages.json` per stage; this list exists so the contract layer can
 * state what WORKFLOW_STATE_MACHINE 2.3 names, and the policy loader asserts the two agree.
 * A disagreement is a policy-authoring defect and fails at load.
 */
export const READ_ONLY_STAGES: readonly TemplateStage[] = Object.freeze([
  'AUDIT',
  'ROOT_CAUSE',
  'ARCHITECTURE',
  'PLAN',
  'VALIDATION',
  'STRUCTURAL_REAUDIT',
  'UX_REVIEW',
  'PR_REVIEW',
  'REVIEW_TRIAGE',
  'DECOMPOSITION',
]);

/** Exhaustiveness helper: a `never` argument the compiler rejects if a case is missed. */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}
