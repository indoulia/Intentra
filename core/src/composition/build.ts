import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AdapterAvailability,
  AdapterCallContext,
  AgentCatalog,
  AgentSubstrate,
  Clock,
  DiscoveryPort,
  Evidence,
  HostIdentity,
  Locator,
  ModelEntry,
  Registries,
  SkillEntry,
  HumanChannel,
} from '@agentos/contracts';
import { validators } from '@agentos/contracts';
import {
  createAdapterSuite,
  hostHome,
  hostIdentity,
  SystemClock,
  type AdapterFramework,
  type CliIntake,
  type Connector,
  type DescriptorRegistry,
  type HostInventory,
  type ProcessRunner,
} from '@agentos/adapters';
import { loadPolicies, type PolicySet } from '@agentos/policies';
import { EnumeratedRegistries } from '@agentos/registries';
import { RunStore } from '@agentos/state';
import { DiscoveryService } from '@agentos/discovery';
import { ClaudeAgentSdkSubstrate, MvpAgentCatalog, type DispatchTransport } from '@agentos/agents';
import { Kernel, type KernelPorts } from '../kernel.js';
import type { IdentityResolution } from '../admission.js';
import {
  deriveAccess,
  type AccessClass,
  type AccessDerivation,
  type EnvironmentClassification,
} from './access.js';
import {
  hostInventoryFromEnvironment,
  type HostConfigurationProblem,
} from './inventory.js';
import {
  CliHumanChannel,
  RunLogMutationSink,
  StoreIdempotencyLedger,
  StoreRunLedgerReader,
  storeGrantChecker,
  UNATTENDED_OPERATOR,
  type OperatorPrompt,
} from './ports.js';

/**
 * The composition root: the one place the kernel is wired to real ports.
 *
 * Decision I-8 and the dependency-cruiser rule `kernel-reaches-agents-only-through-composition`
 * put this here and nowhere else. `core/src` may name `@agentos/agents` and
 * `@agentos/discovery` only from `core/src/composition/`, because the kernel's relationship
 * with an agent is one interface — dispatch a typed input, receive a typed envelope — and a
 * second file that could reach past it would make that a convention rather than a boundary.
 *
 * Everything here is injectable, and that is not a testing convenience. A port that could
 * only be built one way could only be *exercised* one way, and the parts of this system that
 * matter most — the disbelief machinery, the fail-closed classifications, the refusals — are
 * exactly the parts a live host is worst at reaching. So a test substitutes a scripted
 * substrate and a scratch repository and drives the same code the CLI does.
 *
 * Nothing degrades silently. A port that cannot be built is a refusal, and every port that
 * *is* built records what it observed: which adapters answered, which access classes that
 * established, what the host configuration declared and what was wrong with it. The build
 * report is part of the deliverable, because a run that proceeded on less reach than it
 * thought it had is the failure this whole layer exists to make visible.
 */

export interface KernelBuildOptions {
  /** Where durable state is written. The real store: a run must be inspectable afterwards. */
  readonly stateRoot: string;
  /** The repository this run works against. Path confinement is anchored to it. */
  readonly repositoryPath: string;

  /** What the operator typed, so `host.read_intake` can normalize and re-read it. */
  readonly intake?: CliIntake | null;

  /** The host identifier. Only `host.cli` may assert a principal (freeze D-5). */
  readonly host?: string;
  /**
   * The authenticated principal.
   *
   * Omitted, the CLI host asserts the authenticated OS user. Passing `null` explicitly
   * asserts none, which classifies the intake `EXTERNAL` — the honest posture for a host that
   * cannot authenticate anybody. It is never taken from content.
   */
  readonly principalId?: string | null;

  readonly installationRoot?: string;
  readonly home?: string;
  readonly clock?: Clock;
  readonly policies?: PolicySet;
  readonly store?: RunStore;

  /** Host configuration. Omitted, it is read from `env`, which defaults to `process.env`. */
  readonly inventory?: HostInventory;
  readonly env?: Readonly<Record<string, string | undefined>>;

  /** The three optional external systems. `null` means this host has none. */
  readonly vcsHost?: Connector | null;
  readonly projectManagement?: Connector | null;
  readonly runtime?: Connector | null;
  readonly runner?: ProcessRunner;

  /** Substitutions for the ports a test drives directly. */
  readonly substrate?: AgentSubstrate;
  readonly transport?: DispatchTransport;
  readonly discovery?: DiscoveryPort;
  readonly registries?: Registries;
  readonly agents?: AgentCatalog;
  readonly human?: HumanChannel;
  readonly operator?: OperatorPrompt;
  readonly random?: () => number;

  /**
   * An access set stated rather than derived.
   *
   * For a test that needs a specific reach without a connector to demonstrate it. A live
   * build never passes this: access is what the adapters were observed to reach, and a stated
   * set is a claim nobody checked.
   */
  readonly access?: ReadonlySet<AccessClass>;
}

/** Everything the build observed, alongside the kernel it produced. */
export interface BuiltKernel {
  readonly kernel: Kernel;
  readonly ports: KernelPorts;
  readonly store: RunStore;
  readonly policies: PolicySet;
  readonly framework: AdapterFramework;
  readonly descriptors: DescriptorRegistry;
  readonly host: HostIdentity;
  readonly availability: readonly AdapterAvailability[];
  readonly accessDerivation: AccessDerivation;
  readonly skills: readonly SkillEntry[];
  readonly models: readonly ModelEntry[];
  /** Enumeration failures and configuration problems. Reported, never swallowed. */
  readonly problems: readonly HostConfigurationProblem[];
}

/** The call context the build's own enumeration runs under, before any run exists. */
const BOOTSTRAP: AdapterCallContext = {
  workItemId: 'bootstrap',
  runId: 'bootstrap',
  dispatchId: null,
  mandate: { in_scope: [], out_of_scope: [] },
  grantsHeld: [],
  stageMutating: false,
};

export async function buildKernel(options: KernelBuildOptions): Promise<BuiltKernel> {
  const policies = options.policies ?? loadPolicies();
  const clock = options.clock ?? new SystemClock();
  const store = options.store ?? new RunStore(options.stateRoot);
  const worktreeRoot = resolve(options.repositoryPath);
  const problems: HostConfigurationProblem[] = [];

  const configured = options.inventory === undefined
    ? hostInventoryFromEnvironment(options.env ?? process.env, clock.now().toISOString())
    : { inventory: options.inventory, problems: [] as readonly HostConfigurationProblem[] };
  problems.push(...configured.problems);

  const hostName = options.host ?? 'host.cli';
  const principalId = options.principalId === undefined
    ? authenticatedPrincipal()
    : options.principalId;

  const hostOptions = {
    host: hostName,
    worktreeRoot,
    principalId,
    intake: options.intake ?? null,
    ledger: new StoreRunLedgerReader(store),
  };

  const suite = await createAdapterSuite({
    worktreeRoot,
    installationRoot: options.installationRoot ?? installationRoot(),
    home: options.home ?? hostHome(),
    paths: policies.paths,
    evidence: policies.evidence,
    execution: policies.execution,
    budgets: policies.budgets,
    clock,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    host: hostName,
    principalId,
    inventory: configured.inventory,
    intake: options.intake ?? null,
    ledger: hostOptions.ledger,
    vcsHost: options.vcsHost ?? null,
    projectManagement: options.projectManagement ?? null,
    runtime: options.runtime ?? null,
    grants: storeGrantChecker(store),
    mutations: new RunLogMutationSink(store, clock),
    idempotency: new StoreIdempotencyLedger(store),
  });

  const availability = suite.framework.availability();
  const environments = await observeEnvironments(suite.framework, availability);
  const accessDerivation = deriveAccess(availability, environments);
  const access = options.access ?? accessDerivation.access;

  const enumeratedAt = clock.now().toISOString();
  const skills = await enumerate<SkillEntry>({
    framework: suite.framework,
    op: 'list_skills',
    field: 'entries',
    validate: (entry) => validators.skillEntry.check(entry).valid,
    problems,
  });
  const models = await enumerate<ModelEntry>({
    framework: suite.framework,
    op: 'list_models',
    field: 'entries',
    validate: (entry) => validators.modelEntry.check(entry).valid,
    problems,
  });

  const ports: KernelPorts = {
    store,
    policies,
    clock,
    adapters: suite.framework,
    discovery: options.discovery ?? new DiscoveryService({
      adapters: suite.framework,
      clock,
      freshnessWindows: policies.budgets.freshness_windows_ms,
    }),
    registries: options.registries ?? new EnumeratedRegistries(skills, models, enumeratedAt),
    agents: options.agents ?? new MvpAgentCatalog(policies),
    substrate: options.substrate ?? new ClaudeAgentSdkSubstrate(
      options.transport === undefined ? {} : { transport: options.transport },
    ),
    host: hostIdentity(hostOptions),
    human: options.human ?? new CliHumanChannel(options.operator ?? UNATTENDED_OPERATOR),
    random: options.random ?? deterministicSampler(`${worktreeRoot}|${options.intake?.raw ?? ''}`),
    repositoryPath: worktreeRoot,
    access,
  };

  return {
    kernel: new Kernel(ports),
    ports,
    store,
    policies,
    framework: suite.framework,
    descriptors: suite.registry,
    host: ports.host,
    availability,
    accessDerivation,
    skills,
    models,
    problems,
  };
}

/* ------------------------------------------------------------------ the two callbacks -- */

/**
 * How an external identity resolves: through the adapter, never from the claim.
 *
 * A proposal naming a ticket is a claim about the world, and admission's first check is that
 * the claim was checked. Three outcomes reach the kernel and each leads somewhere different:
 * `RESOLVED` carries the evidence of the fetch, `ABSENT` says the key is wrong and a human
 * should hear it, and `UNAVAILABLE` says block and resume when the system returns.
 *
 * **`ABSENT` is not produced here, and that is a real limitation.** The adapter framework maps
 * both `ResourceAbsentError` and `ResourceUnreachableError` onto a single `ERROR` outcome, so
 * a failed read cannot be told apart from a missing ticket at this seam. Reporting `ABSENT`
 * on a guess would tell an operator their key is wrong when the server was merely down, which
 * is the more damaging of the two mistakes, so a reachable system that would not answer is
 * `UNAVAILABLE` with the adapter's own message attached.
 */
export function identityResolverFor(
  built: BuiltKernel,
): (claimed: string | null) => Promise<IdentityResolution> {
  return async (claimed) => {
    if (claimed === null || claimed.trim().length === 0) return { outcome: 'NOT_NAMED' };
    const identity = claimed.trim();

    const pm = built.availability.find((entry) => entry.adapter === 'pm');
    if (pm === undefined || pm.state !== 'AVAILABLE') {
      return {
        outcome: 'UNAVAILABLE',
        identity,
        detail:
          `the project-management adapter is ${pm?.state ?? 'not registered'}`
          + `${pm === undefined ? '' : `: ${pm.detail}`}. Whether ${identity} exists cannot be `
          + 'established, and unreachable is neither present nor absent',
      };
    }

    const call = await built.framework.call('pm', 'read_issue', { key: identity }, BOOTSTRAP);
    if (call.outcome === 'OK') {
      const observedAt = built.ports.clock.now().toISOString();
      const evidence: Evidence = {
        id: `E-identity-${call.call.call_id}`,
        kind: 'ticket',
        locator: { adapter: 'pm', op: 'read_issue', args: { key: identity } },
        ref: identity,
        excerpt: excerptOf(call.value),
        observed_at: observedAt,
        reproducible: true,
      };
      return { outcome: 'RESOLVED', identity, evidence };
    }

    return {
      outcome: 'UNAVAILABLE',
      identity,
      detail:
        `the project-management adapter answered ${call.outcome} for ${identity}: `
        + `${call.outcome === 'REFUSED' ? call.message : call.message}. The adapter reports a `
        + 'failed read and a missing item the same way, so this is recorded as unreachable '
        + 'rather than as a wrong key: telling an operator their key is wrong when the server '
        + 'was down is the more damaging of the two mistakes',
    };
  };
}

/**
 * Re-reads the intake source, for the drift check at `COMPLETION`.
 *
 * The locator is re-executed through the same framework the original observation went
 * through, which is the whole point of a locator: "the ticket said X" is checkable rather than
 * remembered. A source whose re-read produces no text is `UNAVAILABLE`, which makes drift
 * `INDETERMINATE` — a different verdict from "the source did not change", and the honest one.
 */
export function intakeRereaderFor(
  built: BuiltKernel,
): (locator: Locator) => Promise<
  { readonly outcome: 'OK'; readonly raw: string }
  | { readonly outcome: 'UNAVAILABLE'; readonly detail: string }
  > {
  return async (locator) => {
    if (locator.op === null) {
      return {
        outcome: 'UNAVAILABLE',
        detail:
          `the ${locator.adapter} locator names no operation to re-execute, so the source `
          + 'cannot be re-read and drift is indeterminate rather than absent',
      };
    }
    const call = await built.framework.call(locator.adapter, locator.op, locator.args, BOOTSTRAP);
    if (call.outcome !== 'OK') {
      return {
        outcome: 'UNAVAILABLE',
        detail:
          `re-reading ${locator.adapter}.${locator.op} answered ${call.outcome}: ${call.message}`,
      };
    }
    const raw = intakeTextOf(call.value);
    if (raw === null) {
      return {
        outcome: 'UNAVAILABLE',
        detail:
          `${locator.adapter}.${locator.op} answered, and what came back carries no text to `
          + 'compare against the recorded content hash. Drift is indeterminate',
      };
    }
    return { outcome: 'OK', raw };
  };
}

/**
 * The intake text the run is admitted against, read through the locator that will be
 * re-executed at `COMPLETION`.
 *
 * This is the second half of D4, and the half that matters. `sourceLocatorFor` was already
 * right that for a project-management intake the *ticket* is the source: the operator naming a
 * key is a pointer at the request, not the request. But `IntakeRecord.content_hash` is computed
 * over whatever `StartInput.raw` carries, and the CLI carried the key the operator typed. So
 * the hash was over `"INV-7"` and the re-read at `COMPLETION` was over the ticket body — two
 * different things, and the comparison between them would have said `CHANGED` on every run of
 * every ticket, for ever, without a ticket ever having changed. A drift check that always fires
 * is a drift check nobody reads.
 *
 * So the pointer is dereferenced here, once, through the same reader the drift check uses:
 * what is hashed at admission and what is re-read at completion are produced by the same code
 * against the same locator, which is the only way the comparison means anything.
 *
 * A source that cannot be read at admission is admitted on what the operator typed and its
 * locator is stripped of its operation, so `COMPLETION` records `UNAVAILABLE`. That is the
 * honest answer: the body was never seen, so nothing about it can have changed or stayed the
 * same. Inventing `CHANGED` from a hash of the key would be worse than saying nothing.
 */
export async function admitIntake(
  built: BuiltKernel,
  locator: Locator,
  typed: string,
): Promise<{
    readonly locator: Locator;
    readonly raw: string;
    /** Why the source could not be dereferenced, or `null` where it was. */
    readonly unresolved: string | null;
  }> {
  /*
   * `host.read_intake` answers with the invocation itself, so the typed text already *is* the
   * source. Dereferencing it would be a second read of the same string.
   */
  if (locator.adapter === 'host') return { locator, raw: typed, unresolved: null };

  const read = await intakeRereaderFor(built)(locator);
  if (read.outcome === 'OK') return { locator, raw: read.raw, unresolved: null };
  return {
    locator: { ...locator, op: null },
    raw: typed,
    unresolved: read.detail,
  };
}

/* ---------------------------------------------------------------------- helpers -------- */

/**
 * The authenticated OS user, per freeze D-5.
 *
 * Read from the operating system rather than from an environment variable, because an
 * environment variable is content and D-5 is about authenticated context. A host that cannot
 * establish one asserts none, and its intake classifies `EXTERNAL`: an invented principal
 * would be a security floor violation wearing a convenience's clothing.
 */
export function authenticatedPrincipal(): string | null {
  try {
    const name = userInfo().username;
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** The AgentOS installation, which path confinement denies every agent access to. */
export function installationRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

/**
 * A deterministic sampler, seeded from what this invocation is about.
 *
 * Evidence verification samples, and a sampler that drew differently on every invocation
 * would make an integrity finding unarguable — "it only failed that time" is not something a
 * verification pass should ever be able to say about itself.
 */
export function deterministicSampler(seed: string): () => number {
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619) >>> 0;
  }
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * The environments a reachable runtime describes, each with the adapter's classification.
 *
 * Only asked where the runtime answered at all. With no runtime configured this makes no
 * calls, which is why the default build reaches nothing to decide it holds no production
 * access — it holds none because nothing established that it does.
 */
async function observeEnvironments(
  framework: AdapterFramework,
  availability: readonly AdapterAvailability[],
): Promise<readonly EnvironmentClassification[]> {
  const runtime = availability.find((entry) => entry.adapter === 'runtime');
  if (runtime?.state !== 'AVAILABLE') return [];

  const call = await framework.call('runtime', 'list_environments', {}, BOOTSTRAP);
  if (call.outcome !== 'OK') return [];

  const names = environmentNames(unwrap(call.value));
  const classified: EnvironmentClassification[] = [];
  for (const environment of names) {
    classified.push({
      environment,
      classification: await framework.classify('environment', environment),
    });
  }
  return classified;
}

function environmentNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      names.push(entry);
      continue;
    }
    const record = asRecord(entry);
    const name = record['name'];
    if (typeof name === 'string' && name.length > 0) names.push(name);
  }
  return names;
}

/**
 * The entries of a host enumeration, checked against their own contract.
 *
 * An entry that does not satisfy `registry.json` is dropped **and reported**, because an
 * enumeration silently one entry short is a selection made from a list nobody knows the shape
 * of. Dropping rather than failing the build is deliberate: one malformed skill should not
 * stop a run that never needed it, and the problem list is what stops that being invisible.
 */
async function enumerate<T>(input: {
  readonly framework: AdapterFramework;
  readonly op: string;
  readonly field: string;
  readonly validate: (entry: unknown) => boolean;
  readonly problems: HostConfigurationProblem[];
}): Promise<readonly T[]> {
  const call = await input.framework.call('host', input.op, {}, BOOTSTRAP);
  if (call.outcome !== 'OK') {
    input.problems.push({
      variable: `host.${input.op}`,
      detail: `the host enumeration answered ${call.outcome}: ${call.message}`,
    });
    return [];
  }

  const record = asRecord(unwrap(call.value));
  const detail = record['detail'];
  if (typeof detail === 'string' && /could not be enumerated/.test(detail)) {
    input.problems.push({ variable: `host.${input.op}`, detail });
  }

  const raw = record[input.field];
  if (!Array.isArray(raw)) {
    input.problems.push({
      variable: `host.${input.op}`,
      detail: `the host enumeration carried no ${input.field} array, so nothing was enumerated`,
    });
    return [];
  }

  const entries: T[] = [];
  for (const [index, entry] of raw.entries()) {
    if (input.validate(entry)) {
      entries.push(entry as T);
      continue;
    }
    input.problems.push({
      variable: `host.${input.op}`,
      detail: `entry ${index} does not satisfy its contract and was not enumerated`,
    });
  }
  return entries;
}

/** An adapter value that may be wrapped in an assertion, unwrapped once. */
function unwrap(value: unknown): unknown {
  const record = asRecord(value);
  if ('value' in record && 'confidence' in record && 'observed_at' in record) {
    return record['value'];
  }
  return value;
}

/**
 * The text of an intake read, whatever shape the adapter answered with.
 *
 * The first half of D4. This used to accept a string or a `{raw}` record and nothing else,
 * which is the shape `host.read_intake` answers with — so a natural-language intake compared
 * fine and `pm.read_issue`, which answers with a ticket record, produced no text at all and
 * every project-management run recorded `source_drift: UNAVAILABLE`. "The ticket system did
 * not answer" and "the ticket answered and we could not read it" are different facts, and only
 * the first is a fact about the world.
 *
 * A record with no `raw` is rendered as sorted `key: value` lines. Sorted, because the hash has
 * to be over the ticket and not over the order a connector happened to serialize it in; as
 * lines rather than as JSON, because this text is what the narrative quotes back verbatim and
 * what a `CHANGED` diff is taken over, and both are read by a human.
 *
 * Volatile framing is dropped before rendering: `unwrap` removes the assertion envelope, whose
 * `observed_at` moves on every read and would make every ticket look edited.
 */
export function intakeTextOf(value: unknown): string | null {
  if (typeof value === 'string') return value.length === 0 ? null : value;
  const unwrapped = unwrap(value);
  if (typeof unwrapped === 'string') return unwrapped.length === 0 ? null : unwrapped;
  const record = asRecord(unwrapped);
  const raw = record['raw'];
  if (typeof raw === 'string') return raw;
  const keys = Object.keys(record).sort();
  if (keys.length === 0) return null;
  return keys
    .map((key) => `${key}: ${stableText(record[key])}`)
    .join('\n');
}

/** A field of an intake record, rendered so that two reads of the same value agree. */
function stableText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  /* A symbol or a function is not content a source can have sent, and neither stringifies. */
  if (typeof value !== 'object') return '';
  if (Array.isArray(value)) return `[${value.map(stableText).join(', ')}]`;
  const record = asRecord(value);
  return `{${Object.keys(record).sort().map((k) => `${k}: ${stableText(record[k])}`).join(', ')}}`;
}

function excerptOf(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 500);
  const unwrapped = unwrap(value);
  if (unwrapped === undefined || typeof unwrapped === 'function') return '';
  return JSON.stringify(unwrapped).slice(0, 500);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}
