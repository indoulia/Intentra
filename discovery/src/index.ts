/**
 * `@agentos/discovery` — the probes that fill the Context Package.
 *
 * Each probe answers one narrow question, declares its own availability, mutates nothing, and
 * degrades to `UNKNOWN` rather than guessing. Two rules hold across the whole package and are
 * worth stating where the surface is declared, because everything else here is in service of
 * them:
 *
 * 1. **Discovery that quietly guesses is worse than discovery that reports gaps.** No probe
 *    fills an absence with a plausible value, and `UNKNOWN` never silently becomes `FACT`.
 * 2. **`current_reality` is written only by probes.** No part of it is derived from the intake
 *    text, from a ticket's status field, or from an agent's account of a previous run.
 *
 * Nothing here opens a file, runs a process or reaches the network. Every observation goes
 * through the `AdapterRegistry` port, which is dependency rule 5 and is what makes an
 * observation replayable at all.
 */

export { DiscoveryService, TIER_1_PROBES, TIER_2_PROBES, ALL_SECTION_PROBES } from './service.js';
export type { DiscoveryOptions, ReprobeRecord } from './service.js';

export { assemble, ASSERTION_SECTIONS, REALITY_ELEMENTS, SECTION_NAMES } from './package.js';
export type { AssembleInput, AssembleResult } from './package.js';

export { ProbeSession } from './session.js';
export type { Observation, ObserveRequest, ProbeRefusal, SessionOptions } from './session.js';

export {
  fact,
  freshnessOf,
  inference,
  inlineEvidence,
  isUnknown,
  makeEvidence,
  promote,
  unknown,
  evidenceId,
} from './assertions.js';
export type {
  AssertionInput,
  EvidenceInput,
  FreshnessClass,
  FreshnessWindows,
  Promotion,
  PromotionOutcome,
  UnknownInput,
} from './assertions.js';

export { makeLedger, asArray, asBoolean, asNumber, asRecord, asString, paths, records } from './probe.js';
export type {
  ProbeInput,
  ProbeLedger,
  RealityProbe,
  RealityProbeResult,
  SectionAssertions,
  SectionProbe,
  SectionProbeResult,
} from './probe.js';

export {
  buildCapabilityMatrix,
  conflictSummary,
  isMerged,
  reconcileWorkItem,
} from './reconciliation.js';
export type {
  AxisReading,
  CapabilityMatrixInput,
  CapabilitySource,
  SourceConflict,
  WorkItemReconciliation,
  WorkItemReconciliationInput,
} from './reconciliation.js';

export { INTENT_KEYS } from './intent-keys.js';
export type { IntentKey } from './intent-keys.js';

export { collectGaps, GAP_TABLE_ELEMENTS } from './gaps.js';
export type { GapInput } from './gaps.js';

export { auditFacts, evaluatePredicate, normalize } from './audit.js';
export type { AssertionAudit, AuditOptions, AuditReport, AuditVerdict } from './audit.js';

export { excerptOf, redact, stableJson, EXCERPT_LIMIT, MASK } from './redact.js';

export { ADAPTERS, OPS } from './ops.js';
export type { AdapterName } from './ops.js';

export { REALITY_PROBES, realityProbeFor, identityTokens, COVERED_ELEMENTS } from './probes/reality.js';
export { REPOSITORY_PROBES } from './probes/repository.js';
export { GIT_PROBES } from './probes/git.js';
export { PM_PROBES, claimsCompletion } from './probes/pm.js';
export { RUNTIME_PROBES } from './probes/runtime.js';
export { CAPABILITY_PROBES } from './probes/capabilities.js';
