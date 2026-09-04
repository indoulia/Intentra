/**
 * The generated-type naming table.
 *
 * JSON Schema is the source of truth and TypeScript types are generated from it, so the
 * mapping from `<file>#/$defs/<name>` to a TypeScript identifier has to live somewhere.
 * It lives here, explicitly, rather than in a heuristic: two definitions called `unknown`
 * in different files must get different names, and a heuristic that invents them silently
 * would rename a type the day a schema gains a definition.
 *
 * Key format: `<schema file base>` for a schema's root, `<base>#<defName>` for a `$defs`
 * entry. A missing key is an error, not a default — an unnamed definition is a definition
 * nobody decided the name of.
 */
export const TYPE_NAMES = {
  'common#id': 'Id',
  'common#timestamp': 'Timestamp',
  'common#nonEmptyString': 'NonEmptyString',
  'common#pathGlob': 'PathGlob',
  'common#confidenceClass': 'ConfidenceClass',
  'common#absenceReason': 'AbsenceReason',
  'common#dataSemantic': 'DataSemantic',
  'common#freshness': 'Freshness',
  'common#predicateValue': 'PredicateValue',
  'common#evidenceKind': 'EvidenceKind',
  'common#verificationStatus': 'VerificationStatus',
  'common#severity': 'Severity',
  'common#agentRole': 'AgentRole',
  'common#reviewingRole': 'ReviewingRole',
  'common#stage': 'Stage',
  'common#prologueStage': 'PrologueStage',
  'common#controlState': 'ControlState',
  'common#templateStage': 'TemplateStage',
  'common#workItemType': 'WorkItemType',
  'common#workItemLifecycle': 'WorkItemLifecycle',
  'common#workItemLinkKind': 'WorkItemLinkKind',
  'common#intakeSource': 'IntakeSource',
  'common#trustClass': 'TrustClass',
  'common#reconciliationState': 'ReconciliationState',
  'common#capabilityStatus': 'CapabilityStatus',
  'common#chainStage': 'ChainStage',
  'common#riskClass': 'RiskClass',
  'common#gate': 'Gate',
  'common#dodVerdict': 'DodVerdict',
  'common#completionVerdict': 'CompletionVerdict',
  'common#dodProfileId': 'DodProfileId',
  'common#runOutcome': 'RunOutcome',
  'common#locator': 'Locator',
  'common#scope': 'Scope',
  'common#cost': 'Cost',

  evidence: 'Evidence',
  'evidence#predicate': 'EvidencePredicate',
  'evidence#verification': 'EvidenceVerification',

  assertion: 'Assertion',
  'assertion#evidenceRef': 'EvidenceRef',
  'assertion#base': 'AssertionBase',
  'assertion#fact': 'FactAssertion',
  'assertion#inference': 'InferenceAssertion',
  'assertion#unknown': 'UnknownAssertion',

  'finding#finding': 'Finding',
  'finding#findingCategory': 'FindingCategory',
  'finding#blocker': 'Blocker',
  'finding#blockerKind': 'BlockerKind',
  'finding#needs': 'BlockerNeeds',
  'finding#unknown': 'UnknownRecord',
  'finding#assumption': 'Assumption',
  'finding#recommendation': 'Recommendation',
  'finding#artifactChange': 'ArtifactChange',
  'finding#coverage': 'Coverage',

  'handoff-envelope': 'HandoffEnvelope',
  'handoff-envelope#status': 'EnvelopeStatus',
  'handoff-envelope#nextAction': 'NextAction',
  'handoff-envelope#proposals': 'Proposals',
  'handoff-envelope#workflowProposal': 'WorkflowProposal',
  'handoff-envelope#decompositionProposal': 'DecompositionProposal',
  'handoff-envelope#triageProposal': 'TriageProposal',
  'handoff-envelope#cancellationProposal': 'CancellationProposal',
  'handoff-envelope#dispatchProposal': 'DispatchProposal',
  'handoff-envelope#arbitrationProposal': 'ArbitrationProposal',

  'input-package': 'InputPackage',
  'input-package#mandate': 'Mandate',
  'input-package#authorizationScope': 'AuthorizationScope',
  'input-package#toolGrant': 'ToolGrant',
  'input-package#skillOffer': 'SkillOffer',
  'input-package#dispatchBudget': 'DispatchBudget',

  'work-item#intakeRecord': 'IntakeRecord',
  'work-item#principal': 'Principal',
  'work-item#attachment': 'IntakeAttachment',
  'work-item#proposedWorkItem': 'ProposedWorkItem',
  'work-item#alternative': 'ResolutionAlternative',
  'work-item#scopeAssertion': 'ScopeAssertion',
  'work-item#workItem': 'WorkItem',
  'work-item#link': 'WorkItemLink',
  'work-item#lease': 'RunLease',
  'work-item#denial': 'GateDenial',
  'work-item#consumedBudget': 'ConsumedBudget',

  'workflow#stageDescriptor': 'StageDescriptor',
  'workflow#edge': 'WorkflowEdge',
  'workflow#workflowTemplate': 'WorkflowTemplate',
  'workflow#frozenGraph': 'FrozenGraph',
  'workflow#stageCursorEntry': 'StageCursorEntry',
  'workflow#run': 'RunRecord',

  'dod#criterionId': 'DodCriterionId',
  'dod#criterionVerdict': 'CriterionVerdict',
  'dod#dodProfile': 'DodProfile',
  'dod#completionReport': 'CompletionReport',
  'dod#sourceDrift': 'SourceDrift',

  'adapter#operationDescriptor': 'AdapterOperationDescriptor',
  'adapter#reversalSpec': 'ReversalSpec',
  'adapter#callRecord': 'CallRecord',
  'adapter#mutationEvent': 'MutationEvent',
  'adapter#idempotencyRecord': 'IdempotencyRecord',
  'adapter#classification': 'Classification',
  'adapter#availability': 'AdapterAvailability',

  'authorization#draftRequest': 'DraftAuthorizationRequest',
  'authorization#reversibility': 'Reversibility',
  'authorization#authorizationRequest': 'AuthorizationRequest',
  'authorization#authorizationGrant': 'AuthorizationGrant',
  'authorization#gateDefinition': 'GateDefinition',
  'authorization#classifier': 'GateClassifier',

  'capability#chainStageRecord': 'ChainStageRecord',
  'capability#capabilityRecord': 'CapabilityRecord',
  'capability#reference': 'CapabilityReference',
  'capability#layerVerdict': 'LayerVerdict',
  'capability#graphNode': 'CapabilityGraphNode',
  'capability#graphEdge': 'CapabilityGraphEdge',
  'capability#capabilityGraph': 'CapabilityGraph',
  'capability#capabilityRegistry': 'CapabilityRegistry',

  'context-package': 'ContextPackage',
  'context-package#sectionName': 'ContextSectionName',
  'context-package#section': 'ContextSection',
  'context-package#meta': 'ContextPackageMeta',
  'context-package#probeCoverage': 'ProbeCoverage',
  'context-package#currentReality': 'CurrentReality',
  'context-package#realityElement': 'RealityElement',
  'context-package#reconciliationMatrix': 'ReconciliationMatrix',

  'registry#skillEntry': 'SkillEntry',
  'registry#modelEntry': 'ModelEntry',
  'registry#requirement': 'ModelRequirement',
  'registry#rankedCandidate': 'RankedCandidate',
  'registry#skillRegistry': 'SkillRegistry',
  'registry#modelRegistry': 'ModelRegistry',
  'registry#agentSpec': 'AgentSpec',

  'policy#predicateDefinition': 'PredicateDefinition',
  'policy#predicateSet': 'PredicateSet',
  'policy#floorRule': 'FloorRule',
  'policy#floorTrigger': 'FloorTrigger',
  'policy#floorRequirement': 'FloorRequirement',
  'policy#floorSet': 'WorkflowFloor',
  'policy#stageSet': 'StageSet',
  'policy#workItemPolicy': 'WorkItemPolicy',
  'policy#intakePolicy': 'IntakePolicy',
  'policy#evidencePolicy': 'EvidencePolicy',
  'policy#budgetPolicy': 'BudgetPolicy',
  'policy#scopedCap': 'ScopedCap',
  'policy#pathPolicy': 'PathPolicy',
  'policy#gatePolicy': 'GatePolicy',
  'policy#dodPolicySet': 'DodPolicySet',
  'policy#agentPolicy': 'AgentPolicy',

  'rejection#violationCode': 'ViolationCode',
  'rejection#violation': 'Violation',
  'rejection#rejection': 'Rejection',

  event: 'Event',
  'event#base': 'EventBase',
  'event#eventKind': 'EventKind',
  'event#payload': 'EventPayload',
  'event#checkOutcome': 'CheckOutcome',
  'event#receiptStep': 'ReceiptStep',
  'event#pathRefusal': 'PathRefusal',
  'event#conflictPosition': 'ConflictPosition',
};

/**
 * `e_run_started` in event.json becomes `RunStartedLogEvent`. The `LogEvent` suffix rather
 * than `Event` avoids colliding with contract shapes that are themselves called events —
 * `adapter.json#/$defs/mutationEvent` is a `MutationEvent`, and the log record that carries
 * one is a `MutationLogEvent`.
 */
export function eventBranchName(defName) {
  const body = defName.slice(2);
  const pascal = body
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `${pascal}LogEvent`;
}

export function typeName(fileBase, defName) {
  if (defName === null) {
    const name = TYPE_NAMES[fileBase];
    if (name === undefined) throw new Error(`no type name for schema root ${fileBase}`);
    return name;
  }
  if (fileBase === 'event' && defName.startsWith('e_')) return eventBranchName(defName);
  const name = TYPE_NAMES[`${fileBase}#${defName}`];
  if (name === undefined) throw new Error(`no type name for ${fileBase}#/$defs/${defName}`);
  return name;
}
