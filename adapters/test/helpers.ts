import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  AdapterCallContext,
  AuthorizationGrant,
  BudgetPolicy,
  Clock,
  EvidencePolicy,
  ExecutionPolicy,
  IdempotencyRecord,
  MutationEvent,
  ModelEntry,
  PathPolicy,
  SkillEntry,
} from '@agentos/contracts';
import { loadPolicies } from '@agentos/policies';
import {
  DescriptorRegistry,
  ResourceAbsentError,
  ResourceUnreachableError,
  type Connector,
  type GrantCheckRequest,
  type GrantChecker,
  type GrantVerdict,
  type IdempotencyLedger,
  type MutationEmitVerdict,
  type MutationSink,
  type ProcessResult,
  type ProcessRunner,
} from '../src/index.js';

/**
 * Test doubles and scratch repositories.
 *
 * Everything here that stands in for the kernel refuses by default, exactly as the real
 * defaults do, so a test that wants a mutation to succeed has to say so explicitly. A double
 * that permitted by default would let a missing check pass unnoticed, which is the one thing
 * this suite exists to prevent.
 *
 * `contracts/src/fixtures.ts` builds an `AdapterOperationDescriptor` and a `MutationEvent`
 * but no `CallRecord`, `IdempotencyRecord`, `Classification` or `AdapterAvailability`, so
 * those are built here rather than added to a package this work package does not own.
 */

export const POLICIES = loadPolicies();
export const PATHS: PathPolicy = POLICIES.paths;
export const EVIDENCE: EvidencePolicy = POLICIES.evidence;
export const BUDGETS: BudgetPolicy = POLICIES.budgets;
export const READ_ONLY_EXECUTION: ExecutionPolicy = POLICIES.execution;

/** The same policy with mutation permitted, for the test-only mutating registry. */
export const MUTATION_ENABLED_EXECUTION: ExecutionPolicy = {
  ...POLICIES.execution,
  mutation_enabled: true,
};

export const T0 = '2026-09-04T10:00:00.000Z';

export class FixedClock implements Clock {
  #at: number;

  constructor(iso: string = T0) {
    this.#at = Date.parse(iso);
  }

  now(): Date {
    return new Date(this.#at);
  }

  advance(ms: number): void {
    this.#at += ms;
  }
}

/* ------------------------------------------------------------------ scratch trees ---- */

export interface Scratch {
  readonly root: string;
  readonly worktree: string;
  readonly outside: string;
  file(relativePath: string, content: string): string;
  dir(relativePath: string): string;
  dispose(): void;
}

export function scratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), 'agentos-adapters-'));
  const worktree = join(root, 'worktree');
  const outside = join(root, 'outside');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return {
    root,
    worktree,
    outside,
    file(relativePath: string, content: string): string {
      const full = join(worktree, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
      return full;
    },
    dir(relativePath: string): string {
      const full = join(worktree, relativePath);
      mkdirSync(full, { recursive: true });
      return full;
    },
    dispose(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Creates a symlink, and fails the test if it cannot.
 *
 * It deliberately offers no way to skip. A test may not decide at runtime not to assert, and
 * a symlink test that quietly did nothing would be the most dangerous green in the suite. The
 * confinement logic itself is proven unconditionally through the injected filesystem in
 * `confinement.test.ts`; these real-filesystem tests are the second layer, and a host that
 * cannot create a junction is a broken environment rather than a licence to stop asserting.
 */
export function makeSymlink(
  target: string,
  path: string,
  type: 'file' | 'dir' | 'junction',
): void {
  try {
    symlinkSync(target, path, type);
  } catch (error) {
    throw new Error(
      `could not create a ${type} symlink at ${path} `
      + `(${(error as NodeJS.ErrnoException).code ?? 'unknown'}). On Windows this needs `
      + 'developer mode or elevation. The confinement logic is covered unconditionally in '
      + 'confinement.test.ts through the injected filesystem; this layer additionally '
      + 'exercises the real one and cannot run without it',
      { cause: error },
    );
  }
}

/* --------------------------------------------------------------------- contexts ------ */

export function context(overrides: Partial<AdapterCallContext> = {}): AdapterCallContext {
  return {
    workItemId: 'wi_c_subject',
    runId: 'run_20260904T100000Z_000001',
    dispatchId: 'dsp_001',
    mandate: { in_scope: ['**'], out_of_scope: [] },
    grantsHeld: [],
    stageMutating: false,
    ...overrides,
  };
}

/* ----------------------------------------------------------------------- doubles ----- */

/** A grant checker over a fixed set of grants, using the kernel's own matching rules. */
export class FakeGrantChecker implements GrantChecker {
  readonly requests: GrantCheckRequest[] = [];

  constructor(private readonly grants: readonly AuthorizationGrant[] = []) {}

  check(request: GrantCheckRequest): GrantVerdict {
    this.requests.push(request);
    const held = new Set(request.grantsHeld);
    const matching = this.grants.filter(
      (grant) => held.has(grant.grant_id)
        && grant.gate === request.gate
        && grant.target === request.target
        && grant.run_id === request.runId,
    );
    for (const grant of matching) {
      if (grant.revoked_at !== null) continue;
      if (Date.parse(grant.expires_at) <= request.now.getTime()) continue;
      return { ok: true, grant };
    }
    return {
      ok: false,
      code: matching.length > 0 ? 'GRANT_EXPIRED' : 'GRANT_MISSING',
      message: `no usable grant for ${request.gate} on ${request.target}`,
    };
  }
}

export class RecordingMutationSink implements MutationSink {
  readonly events: MutationEvent[] = [];
  #verdict: MutationEmitVerdict = { ok: true };
  #throwOnEmit: string | null = null;

  canEmit(): MutationEmitVerdict {
    return this.#verdict;
  }

  emit(event: MutationEvent): void {
    if (this.#throwOnEmit !== null) throw new Error(this.#throwOnEmit);
    this.events.push(event);
  }

  refuse(reason: string): void {
    this.#verdict = { ok: false, reason };
  }

  failOnEmit(reason: string): void {
    this.#throwOnEmit = reason;
  }
}

/** An in-memory stand-in for the run store's work-item-scoped ledger. */
export class FakeLedger implements IdempotencyLedger {
  readonly #records = new Map<string, IdempotencyRecord>();
  readonly deleted: string[] = [];

  get(workItemId: string, key: string): IdempotencyRecord | null {
    return this.#records.get(`${workItemId} ${key}`) ?? null;
  }

  put(workItemId: string, record: IdempotencyRecord): void {
    this.#records.set(`${workItemId} ${record.key}`, record);
  }

  delete(workItemId: string, key: string): void {
    this.#records.delete(`${workItemId} ${key}`);
    this.deleted.push(key);
  }

  size(): number {
    return this.#records.size;
  }
}

export type ScriptedCommand = (args: readonly string[]) => ProcessResult;

/** A process runner that answers from a script and starts nothing. */
export class ScriptedRunner implements ProcessRunner {
  readonly invocations: { command: string; args: readonly string[] }[] = [];

  constructor(private readonly script: Readonly<Record<string, ScriptedCommand>>) {}

  run(command: string, args: readonly string[]): Promise<ProcessResult> {
    this.invocations.push({ command, args });
    const handler = this.script[command];
    if (handler === undefined) {
      return Promise.resolve({
        code: null,
        stdout: '',
        stderr: `${command} is not installed on this scripted host`,
        started: false,
      });
    }
    return Promise.resolve(handler(args));
  }
}

export function ok(stdout: string): ProcessResult {
  return { code: 0, stdout, stderr: '', started: true };
}

export function failed(stderr: string, code = 1): ProcessResult {
  return { code, stdout: '', stderr, started: true };
}

export type ConnectorScript = (
  resource: string,
  args: Readonly<Record<string, unknown>>,
) => unknown;

export class FakeConnector implements Connector {
  constructor(
    readonly id: string,
    readonly configured: boolean,
    private readonly script: ConnectorScript,
  ) {}

  fetch(resource: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    try {
      return Promise.resolve(this.script(resource, args));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** A connector that is configured and never answers: the UNAVAILABLE case. */
export function unreachableConnector(id: string): Connector {
  return new FakeConnector(id, true, () => {
    throw new ResourceUnreachableError(id, `${id} did not answer`);
  });
}

/** A connector that answers, and reports one named resource as gone. */
export function absentConnector(id: string, absentResource: string): Connector {
  return new FakeConnector(id, true, (resource) => {
    if (resource === absentResource) {
      throw new ResourceAbsentError(resource, `${resource} no longer exists`);
    }
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ registries ------- */

export function emptyRegistry(mutationEnabled = false): DescriptorRegistry {
  return new DescriptorRegistry({
    mutationEnabled,
    scratchRoots: PATHS.scratch_roots,
  });
}

export function grant(overrides: Partial<AuthorizationGrant> = {}): AuthorizationGrant {
  return {
    grant_id: 'grant_001',
    run_id: 'run_20260904T100000Z_000001',
    work_item_id: 'wi_c_subject',
    gate: 'EXTERNAL_COMMUNICATION',
    target: 'the-target',
    scope: 'single_action',
    granted_by: 'operator',
    granted_at: T0,
    expires_at: '2026-09-05T10:00:00.000Z',
    conditions: [],
    request_ref: 'req_001',
    evidence_reviewed: [],
    revoked_at: null,
    ...overrides,
  };
}

export function skill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    id: 'skill.read',
    source: 'repository',
    description: 'reads things',
    declared_inputs: [],
    declared_outputs: [],
    availability: {
      adapter: 'host',
      state: 'AVAILABLE',
      detail: 'enumerated',
      checked_at: T0,
    },
    mutating: false,
    spawns_agents: false,
    spawns_agents_determined: true,
    external_destination: false,
    reversal: null,
    domains: ['repository_analysis'],
    operations: ['read'],
    targets: ['filesystem'],
    observed_success_rate: null,
    cost_hint: 'low',
    ...overrides,
  };
}

export function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: 'model.mid',
    availability: {
      adapter: 'host',
      state: 'AVAILABLE',
      detail: 'enumerated',
      checked_at: T0,
    },
    context_window: 200_000,
    reasoning: 'mid',
    coding: 'strong',
    vision: 'none',
    tool_use: 'strong',
    usd_per_mtok_input: 3,
    usd_per_mtok_output: 15,
    latency_class: 'medium',
    precision_class: 'standard',
    ...overrides,
  };
}
