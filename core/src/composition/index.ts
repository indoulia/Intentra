/**
 * `core/src/composition` — where the kernel meets the world.
 *
 * The only place in `core/src` permitted to name `@agentos/agents` and `@agentos/discovery`
 * (decision I-8, enforced by `.dependency-cruiser.cjs`). Everything the kernel needs to run
 * against a real repository is assembled here and nowhere else, so "the kernel depends on
 * agents through one interface" is a property of the module graph rather than a convention.
 */

export { buildKernel, identityResolverFor, intakeRereaderFor } from './build.js';
export {
  authenticatedPrincipal,
  deterministicSampler,
  installationRoot,
} from './build.js';
export type { BuiltKernel, KernelBuildOptions } from './build.js';

export { ACCESS_BY_ADAPTER, deriveAccess } from './access.js';
export type {
  AccessClass,
  AccessDerivation,
  AccessFinding,
  EnvironmentClassification,
} from './access.js';

export {
  CliHumanChannel,
  RunLogMutationSink,
  StoreIdempotencyLedger,
  StoreRunLedgerReader,
  grantsRecordedFor,
  storeGrantChecker,
  UNATTENDED_OPERATOR,
} from './ports.js';
export type { OperatorPrompt } from './ports.js';

export {
  hostInventoryFromEnvironment,
  MODELS_VARIABLE,
  NOTHING_DECLARED,
  SKILLS_VARIABLE,
  TOOLS_VARIABLE,
} from './inventory.js';
export type { HostConfiguration, HostConfigurationProblem } from './inventory.js';
