import type {
  BudgetPolicy,
  Clock,
  EvidencePolicy,
  ExecutionPolicy,
  PathPolicy,
} from '@agentos/contracts';
import { DescriptorRegistry } from '../descriptors.js';
import { AdapterFramework } from '../framework.js';
import type { ClassificationProbe } from '../classification.js';
import type {
  AvailabilityProbe,
  CapabilityAttribution,
  Connector,
  GrantChecker,
  IdempotencyLedger,
  MutationSink,
  ProcessRunner,
  RunLedgerReader,
} from '../ports.js';
import { NodeProcessRunner, SystemClock } from '../system.js';
import { gitAvailability, gitOperations, branchProtectionProbe } from './git.js';
import {
  hostAvailability,
  hostOperations,
  spawningProbe,
  type CliIntake,
  type HostInventory,
} from './host.js';
import { projectManagementAvailability, projectManagementOperations } from './project-management.js';
import { repositoryAvailability, repositoryOperations } from './repo.js';
import { environmentProbe, runtimeAvailability, runtimeOperations } from './runtime.js';

/**
 * The five read-only adapter families, composed into one framework.
 *
 * Five, and each is a distinct family with its own availability: **repo**, **git**, **host**,
 * **pm** and **runtime**. The kernel matches an agent spec's `permitted_adapters` against the
 * first dotted segment of an operation's adapter name and derives the granted tool name from
 * the pair, so these names are identifiers rather than labels — renaming one changes the tool
 * surface D-2's conformance check compares against.
 *
 * Not one of them is mutating. That is milestone 1's whole shape: the mutation, reversal,
 * idempotency and grant machinery is built and exercised, and no operation registered here
 * can reach it, so when the first mutating operation is registered in milestone 2 it lands in
 * a system that already cannot perform an unlogged mutation.
 */

export interface AdapterSuiteOptions {
  readonly worktreeRoot: string;
  readonly installationRoot: string;
  readonly home: string;
  readonly paths: PathPolicy;
  readonly evidence: EvidencePolicy;
  readonly execution: ExecutionPolicy;
  readonly budgets: BudgetPolicy;

  readonly clock?: Clock;
  readonly runner?: ProcessRunner;

  /** The host identity, per freeze D-5. `host.cli` is the only one asserting a principal. */
  readonly host?: string;
  readonly principalId?: string | null;
  readonly inventory?: HostInventory;
  readonly intake?: CliIntake | null;
  /**
   * Read-only access to AgentOS's own run ledger, for `host.read_run_history` and
   * `host.read_child_work_items`. Absent, both report UNAVAILABLE rather than empty.
   */
  readonly ledger?: RunLedgerReader | null;

  /** The pull-request and CI host, the project-management system, and the runtime. */
  readonly vcsHost?: Connector | null;
  readonly projectManagement?: Connector | null;
  readonly runtime?: Connector | null;

  /** The kernel's collaborators. Each defaults to the refusing implementation. */
  readonly grants?: GrantChecker;
  readonly mutations?: MutationSink;
  readonly idempotency?: IdempotencyLedger;
  readonly capabilities?: CapabilityAttribution;
}

export interface AdapterSuite {
  readonly framework: AdapterFramework;
  readonly registry: DescriptorRegistry;
}

/**
 * Builds the registry and the framework, and probes availability once.
 *
 * Availability is probed here rather than lazily because the four states are an input to
 * every later decision — a run that proceeds believing a connector is reachable and finds out
 * mid-dispatch has already made claims it cannot support.
 */
export async function createAdapterSuite(
  options: AdapterSuiteOptions,
): Promise<AdapterSuite> {
  const clock = options.clock ?? new SystemClock();
  const runner = options.runner ?? new NodeProcessRunner();
  const vcsHost = options.vcsHost ?? null;
  const projectManagement = options.projectManagement ?? null;
  const runtime = options.runtime ?? null;

  const repoOptions = { worktreeRoot: options.worktreeRoot, paths: options.paths };
  const gitOptions = { worktreeRoot: options.worktreeRoot, runner, host: vcsHost };
  const hostOptions = {
    host: options.host ?? 'host.cli',
    worktreeRoot: options.worktreeRoot,
    principalId: options.principalId ?? null,
    ...(options.inventory === undefined ? {} : { inventory: options.inventory }),
    intake: options.intake ?? null,
    ledger: options.ledger ?? null,
  };
  const pmOptions = { connector: projectManagement };
  const runtimeOptions = { connector: runtime };

  const registry = new DescriptorRegistry({
    mutationEnabled: options.execution.mutation_enabled,
    scratchRoots: options.paths.scratch_roots,
  });

  for (const registration of [
    ...repositoryOperations(repoOptions),
    ...gitOperations(gitOptions),
    ...hostOperations(hostOptions),
    ...projectManagementOperations(pmOptions),
    ...runtimeOperations(runtimeOptions),
  ]) {
    registry.register(registration);
  }

  const availabilityProbes: readonly AvailabilityProbe[] = [
    repositoryAvailability(repoOptions),
    gitAvailability(gitOptions),
    hostAvailability(hostOptions),
    projectManagementAvailability(pmOptions),
    runtimeAvailability(runtimeOptions),
  ];

  const classificationProbes: readonly ClassificationProbe[] = [
    branchProtectionProbe(gitOptions),
    environmentProbe(runtimeOptions),
    spawningProbe(hostOptions),
    observationSafetyProbe(registry),
  ];

  const framework = new AdapterFramework({
    registry,
    clock,
    worktreeRoot: options.worktreeRoot,
    installationRoot: options.installationRoot,
    home: options.home,
    paths: options.paths,
    evidence: options.evidence,
    execution: options.execution,
    budgets: options.budgets,
    ...(options.grants === undefined ? {} : { grants: options.grants }),
    ...(options.mutations === undefined ? {} : { mutations: options.mutations }),
    ...(options.idempotency === undefined ? {} : { idempotency: options.idempotency }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    availabilityProbes,
    classificationProbes,
  });

  await framework.refreshAvailability();
  return { framework, registry };
}

/**
 * Observation safety, classified from the descriptor rather than probed.
 *
 * The subject is `adapter.op`. A registered operation declares its own answer, so the
 * classification is a `FACT` and `failed_closed` is false either way — including when the
 * declared answer is `UNSAFE`, which is a decision someone made and recorded rather than a
 * gap. An operation nobody registered has no declaration, and an operation with no
 * declaration is `UNSAFE` with `failed_closed: true`: the same rule as branch protection and
 * environment, applied to the flag that decides whether the verification channel may execute
 * something.
 */
export function observationSafetyProbe(registry: DescriptorRegistry): ClassificationProbe {
  return {
    kind: 'observation_safety',
    probe(subject: string) {
      const separator = subject.lastIndexOf('.');
      const adapter = separator === -1 ? subject : subject.slice(0, separator);
      const op = separator === -1 ? '' : subject.slice(separator + 1);
      const registration = registry.get(adapter, op);
      if (registration === undefined) {
        return Promise.resolve({
          established: false as const,
          detail:
            `${subject} is not a registered operation, so nothing has established that `
            + 'replaying it cannot alter authoritative state',
        });
      }
      return Promise.resolve({
        established: true as const,
        dangerous: !registration.descriptor.observation_safe,
        confidence: 'FACT' as const,
        detail:
          `${subject} declares observation_safe: `
          + String(registration.descriptor.observation_safe),
      });
    },
  };
}

export { gitOperations, gitAvailability, branchProtectionProbe } from './git.js';
export {
  hostOperations,
  hostAvailability,
  hostIdentity,
  hostHome,
  spawningProbe,
  repositorySkills,
  EMPTY_HOST_INVENTORY,
} from './host.js';
export type { HostInventory, HostOptions, CliIntake } from './host.js';
export { repositoryOperations, repositoryAvailability } from './repo.js';
export type { RepoOptions } from './repo.js';
export type { GitOptions } from './git.js';
export {
  projectManagementOperations,
  projectManagementAvailability,
} from './project-management.js';
export type { ProjectManagementOptions } from './project-management.js';
export { runtimeOperations, runtimeAvailability, environmentProbe } from './runtime.js';
export type { RuntimeOptions } from './runtime.js';
