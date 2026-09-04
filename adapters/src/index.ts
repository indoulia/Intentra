/**
 * `@agentos/adapters` — the only path between agents and the outside world.
 *
 * An enforcement layer, not a convenience layer. Path confinement, fail-closed
 * classification, grant checking at execution time, the call log, mutation events,
 * two-scope idempotency, evidence replay and redaction all live here, in one place, because
 * this is the system's single point of trust and a check performed in two places is a check
 * that will eventually be performed in one.
 *
 * Everything reaching outward goes through a port. `adapters/` may touch the filesystem and
 * spawn a process — it is the package the dependency rule names for that — but the grant
 * check, the idempotency ledger and the mutation journal belong to the kernel, so each
 * arrives here as an injected function that nevertheless *executes inside the adapter, at
 * call time*. That is what keeps "enforcement at execution in adapters/" true without
 * `adapters -> core` ever existing.
 */

export { AdapterFramework, ConfinementAbort } from './framework.js';
export type { FrameworkOptions } from './framework.js';

export { DescriptorRegistry } from './descriptors.js';
export type {
  ConfinedPath,
  DescriptorRegistryOptions,
  MutationDraft,
  OperationHandler,
  OperationInvocation,
  OperationRegistration,
  OperationResult,
} from './descriptors.js';

export {
  PATH_ARG,
  STRING_ARG,
  OPTIONAL_STRING_ARG,
  INTEGER_ARG,
  mutatingOperation,
  readOnlyOperation,
} from './define.js';
export type { MutatingOperationInput, ReadOnlyOperationInput } from './define.js';

export { NODE_FILESYSTEM, PathConfinement } from './paths.js';
export type {
  ConfinementOptions,
  FileSystemProbe,
  MandateScope,
  PathVerdict,
  PathRefusalKind,
} from './paths.js';

export { CallLog, RefusalLog } from './call-log.js';
export type { CallDraft, CallLogGranularity } from './call-log.js';

export {
  DANGEROUS_VALUE,
  SAFE_VALUE,
  classify,
  unprobed,
} from './classification.js';
export type {
  ClassificationKind,
  ClassificationObservation,
  ClassificationProbe,
} from './classification.js';

export {
  compareObservations,
  comparatorFor,
  contentHash,
  evaluatePredicate,
  normalizeObservation,
  requiresPredicate,
} from './evidence.js';
export type { Comparison, ComparatorName, ComparisonInput, ComparisonVerdict } from './evidence.js';

export { fact, inference, selfEvidence, unavailable, unknown } from './assertions.js';
export type { SelfEvidenceInput } from './assertions.js';

export { redactDeep, redactMessage, redactText } from './redaction.js';
export type { RedactionHit } from './redaction.js';

export { firstMatch, matchesAny, matchesGlob, specificity, toPosix } from './glob.js';

export {
  DescriptorError,
  NotConfiguredError,
  ResourceAbsentError,
  ResourceUnreachableError,
  isAbsent,
  isNotConfigured,
  isUnreachable,
  messageOf,
} from './errors.js';

export {
  DENY_ALL_GRANTS,
  EMPTY_IDEMPOTENCY_LEDGER,
  NO_CAPABILITY_ATTRIBUTION,
  REFUSING_MUTATION_SINK,
} from './ports.js';
export type {
  AvailabilityProbe,
  CapabilityAttribution,
  ChildWorkItemEntry,
  Connector,
  GrantCheckRequest,
  GrantChecker,
  GrantVerdict,
  IdempotencyLedger,
  MutationEmitVerdict,
  MutationSink,
  ProcessResult,
  ProcessRunner,
  RunLedgerEntry,
  RunLedgerReader,
} from './ports.js';

export { NO_PROCESS_RUNNER, NodeProcessRunner, SystemClock } from './system.js';

export * from './ops/index.js';
