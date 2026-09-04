import { SchemaRegistry } from './validator/validator.js';
import type { ValidationResult, ValidationError } from './validator/types.js';
import { ALL_SCHEMAS, SCHEMA_ID } from './generated/schemas.js';
import type {
  Assertion,
  Evidence,
  HandoffEnvelope,
  InputPackage,
  IntakeRecord,
  WorkItem,
  ProposedWorkItem,
  WorkflowTemplate,
  StageDescriptor,
  FrozenGraph,
  RunRecord,
  ContextPackage,
  CapabilityRecord,
  CapabilityRegistry,
  AuthorizationRequest,
  AuthorizationGrant,
  AdapterOperationDescriptor,
  MutationEvent,
  CallRecord,
  DodProfile,
  CompletionReport,
  Event,
  Finding,
  Blocker,
  Coverage,
  UnknownRecord,
  Assumption,
  Recommendation,
  ArtifactChange,
  Proposals,
  NextAction,
  CurrentReality,
  CapabilityGraph,
  IdempotencyRecord,
  Classification,
  AdapterAvailability,
  DraftAuthorizationRequest,
  CriterionVerdict,
  Violation,
  StageCursorEntry,
  SkillRegistry,
  ModelRegistry,
  StageSet,
  WorkflowFloor,
  PredicateSet,
  WorkItemPolicy,
  IntakePolicy,
  EvidencePolicy,
  BudgetPolicy,
  PathPolicy,
  GatePolicy,
  DodPolicySet,
  AgentPolicy,
  ExecutionPolicy,
  AgentSpec,
  SkillEntry,
  ModelEntry,
} from './generated/types.js';

/*
 * Every `$defs` entry that is validated on its own gets a wrapper schema whose whole body
 * is a `$ref` to it. That keeps one registry and one definition of every shape, rather than
 * a second entry point into the same document.
 */
const DEF_VALIDATORS: ReadonlyArray<readonly [keyof typeof SCHEMA_ID, string]> = [
  ['finding', 'finding'],
  ['finding', 'blocker'],
  ['finding', 'coverage'],
  ['finding', 'unknown'],
  ['finding', 'assumption'],
  ['finding', 'recommendation'],
  ['finding', 'artifactChange'],
  ['handoff-envelope', 'proposals'],
  ['handoff-envelope', 'nextAction'],
  ['context-package', 'currentReality'],
  ['capability', 'capabilityGraph'],
  ['adapter', 'idempotencyRecord'],
  ['adapter', 'classification'],
  ['adapter', 'availability'],
  ['authorization', 'draftRequest'],
  ['dod', 'criterionVerdict'],
  ['rejection', 'violation'],
  ['workflow', 'stageCursorEntry'],
  ['registry', 'skillRegistry'],
  ['registry', 'modelRegistry'],
  ['work-item', 'intakeRecord'],
  ['work-item', 'proposedWorkItem'],
  ['work-item', 'workItem'],
  ['workflow', 'stageDescriptor'],
  ['workflow', 'workflowTemplate'],
  ['workflow', 'frozenGraph'],
  ['workflow', 'run'],
  ['capability', 'capabilityRecord'],
  ['capability', 'capabilityRegistry'],
  ['authorization', 'authorizationRequest'],
  ['authorization', 'authorizationGrant'],
  ['adapter', 'operationDescriptor'],
  ['adapter', 'mutationEvent'],
  ['adapter', 'callRecord'],
  ['dod', 'dodProfile'],
  ['dod', 'completionReport'],
  ['policy', 'stageSet'],
  ['policy', 'floorSet'],
  ['policy', 'predicateSet'],
  ['policy', 'workItemPolicy'],
  ['policy', 'intakePolicy'],
  ['policy', 'evidencePolicy'],
  ['policy', 'budgetPolicy'],
  ['policy', 'pathPolicy'],
  ['policy', 'gatePolicy'],
  ['policy', 'dodPolicySet'],
  ['policy', 'agentPolicy'],
  ['policy', 'executionPolicy'],
  ['registry', 'agentSpec'],
  ['registry', 'skillEntry'],
  ['registry', 'modelEntry'],
];

function wrapperId(file: keyof typeof SCHEMA_ID, pointer: string): string {
  return `${SCHEMA_ID[file]}?def=${pointer}`;
}

/**
 * The one compiled schema set. Sealed at module load, so a dangling `$ref` or an
 * unsupported keyword fails the moment `@agentos/contracts` is imported rather than on the
 * first instance that happens to reach it.
 */
export const SCHEMAS: SchemaRegistry = (() => {
  const registry = new SchemaRegistry();
  for (const schema of ALL_SCHEMAS) registry.add(schema);
  for (const [file, pointer] of DEF_VALIDATORS) {
    registry.add({
      $id: wrapperId(file, pointer),
      $comment: `Validation entry point for ${SCHEMA_ID[file]}#/$defs/${pointer}.`,
      $ref: `${SCHEMA_ID[file]}#/$defs/${pointer}`,
    });
  }
  return registry.seal();
})();

export type { ValidationResult, ValidationError };
export { SchemaError } from './validator/validator.js';

/** Formats errors for a message a human can act on. */
export function formatErrors(errors: readonly ValidationError[], limit = 12): string {
  const shown = errors.slice(0, limit).map((e) => {
    const at = e.instancePath === '' ? '(root)' : e.instancePath;
    return `  ${at}: ${e.message} [${e.keyword}]`;
  });
  const more = errors.length > limit ? `\n  ... and ${errors.length - limit} more` : '';
  return `${shown.join('\n')}${more}`;
}

/**
 * A validator whose success narrows its argument. Named after the contract it checks, and
 * generated from that contract's schema, so the type and the check cannot diverge.
 */
export interface Validator<T> {
  readonly schemaId: string;
  /** Validates without narrowing. Use when the errors matter more than the type. */
  check(value: unknown): ValidationResult;
  /** Narrowing predicate. */
  is(value: unknown): value is T;
  /** Validates and returns the value typed, or throws with a located message. */
  parse(value: unknown, label?: string): T;
}

export class ContractViolationError extends Error {
  constructor(
    readonly schemaId: string,
    readonly errors: readonly ValidationError[],
    label: string,
  ) {
    super(`${label} does not satisfy ${schemaId}:\n${formatErrors(errors)}`);
    this.name = 'ContractViolationError';
  }
}

function validator<T>(file: keyof typeof SCHEMA_ID, pointer?: string): Validator<T> {
  const effectiveId = pointer === undefined ? SCHEMA_ID[file] : wrapperId(file, pointer);
  if (!SCHEMAS.has(effectiveId)) {
    throw new Error(`schema ${effectiveId} was not registered`);
  }
  return {
    schemaId: effectiveId,
    check(value: unknown): ValidationResult {
      return SCHEMAS.validate(effectiveId, value);
    },
    is(value: unknown): value is T {
      return SCHEMAS.validate(effectiveId, value).valid;
    },
    parse(value: unknown, label = 'value'): T {
      const result = SCHEMAS.validate(effectiveId, value);
      if (!result.valid) throw new ContractViolationError(effectiveId, result.errors, label);
      return value as T;
    },
  };
}

export const validators = {
  assertion: validator<Assertion>('assertion'),
  evidence: validator<Evidence>('evidence'),
  handoffEnvelope: validator<HandoffEnvelope>('handoff-envelope'),
  inputPackage: validator<InputPackage>('input-package'),
  contextPackage: validator<ContextPackage>('context-package'),
  event: validator<Event>('event'),

  finding: validator<Finding>('finding', 'finding'),
  blocker: validator<Blocker>('finding', 'blocker'),
  coverage: validator<Coverage>('finding', 'coverage'),
  unknownRecord: validator<UnknownRecord>('finding', 'unknown'),
  assumption: validator<Assumption>('finding', 'assumption'),
  recommendation: validator<Recommendation>('finding', 'recommendation'),
  artifactChange: validator<ArtifactChange>('finding', 'artifactChange'),

  proposals: validator<Proposals>('handoff-envelope', 'proposals'),
  nextAction: validator<NextAction>('handoff-envelope', 'nextAction'),
  currentReality: validator<CurrentReality>('context-package', 'currentReality'),
  capabilityGraph: validator<CapabilityGraph>('capability', 'capabilityGraph'),
  idempotencyRecord: validator<IdempotencyRecord>('adapter', 'idempotencyRecord'),
  classification: validator<Classification>('adapter', 'classification'),
  adapterAvailability: validator<AdapterAvailability>('adapter', 'availability'),
  draftAuthorizationRequest:
    validator<DraftAuthorizationRequest>('authorization', 'draftRequest'),
  criterionVerdict: validator<CriterionVerdict>('dod', 'criterionVerdict'),
  violation: validator<Violation>('rejection', 'violation'),
  stageCursorEntry: validator<StageCursorEntry>('workflow', 'stageCursorEntry'),
  skillRegistry: validator<SkillRegistry>('registry', 'skillRegistry'),
  modelRegistry: validator<ModelRegistry>('registry', 'modelRegistry'),

  intakeRecord: validator<IntakeRecord>('work-item', 'intakeRecord'),
  proposedWorkItem: validator<ProposedWorkItem>('work-item', 'proposedWorkItem'),
  workItem: validator<WorkItem>('work-item', 'workItem'),

  stageDescriptor: validator<StageDescriptor>('workflow', 'stageDescriptor'),
  workflowTemplate: validator<WorkflowTemplate>('workflow', 'workflowTemplate'),
  frozenGraph: validator<FrozenGraph>('workflow', 'frozenGraph'),
  run: validator<RunRecord>('workflow', 'run'),

  capabilityRecord: validator<CapabilityRecord>('capability', 'capabilityRecord'),
  capabilityRegistry: validator<CapabilityRegistry>('capability', 'capabilityRegistry'),

  authorizationRequest: validator<AuthorizationRequest>(
    'authorization', 'authorizationRequest',
  ),
  authorizationGrant: validator<AuthorizationGrant>(
    'authorization', 'authorizationGrant',
  ),

  adapterOperationDescriptor: validator<AdapterOperationDescriptor>(
    'adapter', 'operationDescriptor',
  ),
  mutationEvent: validator<MutationEvent>('adapter', 'mutationEvent'),
  callRecord: validator<CallRecord>('adapter', 'callRecord'),

  dodProfile: validator<DodProfile>('dod', 'dodProfile'),
  completionReport: validator<CompletionReport>('dod', 'completionReport'),

  stageSet: validator<StageSet>('policy', 'stageSet'),
  workflowFloor: validator<WorkflowFloor>('policy', 'floorSet'),
  predicateSet: validator<PredicateSet>('policy', 'predicateSet'),
  workItemPolicy: validator<WorkItemPolicy>('policy', 'workItemPolicy'),
  intakePolicy: validator<IntakePolicy>('policy', 'intakePolicy'),
  evidencePolicy: validator<EvidencePolicy>('policy', 'evidencePolicy'),
  budgetPolicy: validator<BudgetPolicy>('policy', 'budgetPolicy'),
  pathPolicy: validator<PathPolicy>('policy', 'pathPolicy'),
  gatePolicy: validator<GatePolicy>('policy', 'gatePolicy'),
  dodPolicySet: validator<DodPolicySet>('policy', 'dodPolicySet'),
  agentPolicy: validator<AgentPolicy>('policy', 'agentPolicy'),
  executionPolicy: validator<ExecutionPolicy>('policy', 'executionPolicy'),

  agentSpec: validator<AgentSpec>('registry', 'agentSpec'),
  skillEntry: validator<SkillEntry>('registry', 'skillEntry'),
  modelEntry: validator<ModelEntry>('registry', 'modelEntry'),
} as const;

export type ValidatorName = keyof typeof validators;
