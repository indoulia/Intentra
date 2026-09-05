import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SchemaRegistry, fixtures as fx } from '@agentos/contracts';
import type {
  AdapterCallContext,
  AdapterOperationDescriptor,
  Assertion,
  ContextPackage,
  IntakeRecord,
  PathPolicy,
  RealityElement,
  WorkItem,
} from '@agentos/contracts';
import {
  DescriptorRegistry,
  NO_PROCESS_RUNNER,
  PathConfinement,
  gitOperations,
  hostOperations,
  projectManagementOperations,
  repositoryOperations,
  runtimeOperations,
  type ConfinedPath,
  type Connector,
  type OperationRegistration,
  type ProcessResult,
  type ProcessRunner,
} from '@agentos/adapters';
import { DiscoveryService, REALITY_ELEMENTS } from '../src/index.js';
import { ADAPTERS, OPS } from '../src/ops.js';
import { ALL_SECTION_PROBES } from '../src/service.js';
import {
  FakeAdapters, TestClock, WINDOWS,
  type FakeWorld, type ProbeRequest, type Responder,
} from './fake-registry.js';
import {
  HEAD_SHA,
  OLD_SHA,
  TICKET,
  healthyWorld,
  misleadingIntake,
  misleadingWorkItem,
  withAvailability,
  withResponses,
} from './worlds.js';

/**
 * The operation surface, checked from both ends at once.
 *
 * `discovery/` and `adapters/` are two packages that have to agree about a set of function
 * signatures neither of them can see: a probe names an operation and hands it a bag of
 * arguments, and an adapter declares an `args_schema` with `additionalProperties: false`. When
 * they drift, the call is refused as *"was called with arguments its descriptor does not
 * admit"*, the probe degrades to `UNKNOWN`, `current_reality` empties out, and every workflow
 * predicate over it evaluates `INDETERMINATE`. It looks exactly like a repository nobody could
 * observe, which is the most expensive way for a type error to present itself.
 *
 * Nothing in the type system catches it. `adapters/` cannot import `discovery/` and must not,
 * the arguments are `Record<string, unknown>` at the boundary by construction, and the probe
 * suite's own double answers whatever it is asked — so a probe suite can be entirely green
 * against a set of schemas that would reject every call it makes. That is precisely what had
 * happened: twelve operations, sixteen refused `repo.list_paths` calls in a single run.
 *
 * So this file closes the loop mechanically. It drives the **real probes** over the fake world
 * — which is what makes them build their arguments the way they really do — records every call
 * as it was made, and validates each one against the **real descriptor** the real adapter
 * factories register, using the contract's own validator. Neither side is restated here. A
 * probe that starts passing a new argument, or a descriptor that stops admitting an old one,
 * fails this test on the next run.
 */

/* ------------------------------------------------------------------ the real surface --- */

/**
 * The descriptors the real adapters register.
 *
 * Built from the operation factories rather than from `createAdapterSuite`, because the
 * argument schemas are static — they do not depend on a worktree, a connector or a clock — and
 * probing five adapters' availability to read a schema would make this test depend on the host
 * it runs on. The options are the minimum each factory requires, and none of them reaches
 * anything: no connector is configured and no process may be run.
 */
const PATHS: PathPolicy = { version: '1.0', deny: [], scratch_roots: [] };

function realDescriptors(worktreeRoot: string): ReadonlyMap<string, AdapterOperationDescriptor> {
  const registry = new DescriptorRegistry({ mutationEnabled: false, scratchRoots: [] });
  for (const registration of [
    ...repositoryOperations({ worktreeRoot, paths: PATHS }),
    ...gitOperations({ worktreeRoot, runner: NO_PROCESS_RUNNER, host: null }),
    ...hostOperations({
      host: 'host.cli',
      worktreeRoot,
      principalId: null,
      intake: null,
      ledger: null,
    }),
    ...projectManagementOperations({ connector: null }),
    ...runtimeOperations({ connector: null }),
  ]) {
    registry.register(registration);
  }
  const out = new Map<string, AdapterOperationDescriptor>();
  for (const descriptor of registry.descriptors()) {
    out.set(`${descriptor.adapter}.${descriptor.op}`, descriptor);
  }
  return out;
}

/** The vocabulary `discovery/src/ops.ts` declares, flattened to `adapter.op`. */
function declaredOperations(): readonly string[] {
  const out: string[] = [];
  for (const [adapter, ops] of Object.entries(OPS)) {
    for (const op of Object.values(ops)) out.push(`${adapter}.${op}`);
  }
  return out.sort();
}

/* -------------------------------------------------------------- the calls really made --- */

const WORK_ITEM: WorkItem = misleadingWorkItem();
const INTAKE: IntakeRecord = misleadingIntake();

/**
 * Every call the probe set makes, over enough worlds to reach every branch that calls one.
 *
 * A conformance check that only drove the happy path would miss exactly the arguments that are
 * built conditionally — the pull-request search tokens, the merge-state branch pair, the CI
 * fallback listing — and those are where the drift was. So the worlds vary the things that
 * change which branch runs: a change with no pull request, a git host that will not answer, a
 * runtime that is not configured, a work item whose scope is empty.
 */
async function everyCall(): Promise<readonly ProbeRequest[]> {
  const requests: ProbeRequest[] = [];

  const worlds = [
    healthyWorld(),
    withResponses(healthyWorld(), { 'git.list_prs': [] }),
    withResponses(healthyWorld(), { 'runtime.list_environments': [] }),
    withAvailability(healthyWorld(), { pm: 'NOT_CONFIGURED' }),
    withAvailability(healthyWorld(), { runtime: 'UNAVAILABLE' }),
  ];

  /* An empty scope and a full one take different branches in every path-shaped probe. */
  const workItems: readonly WorkItem[] = [
    WORK_ITEM,
    misleadingWorkItem({ scope: { paths: [], capabilities: [], repositories: [] } }),
  ];

  for (const world of worlds) {
    for (const workItem of workItems) {
      const adapters = new FakeAdapters(world);
      const service = new DiscoveryService({
        adapters,
        clock: new TestClock(),
        freshnessWindows: WINDOWS,
      });
      await service.orient({
        runId: 'run_conformance', intake: INTAKE, repositoryPath: '/work/repo',
      });
      await service.deepen({
        runId: 'run_conformance', workItem, repositoryPath: '/work/repo', previous: null,
      });
      /* Tier 3, which runs any probe on demand, and the re-probe the kernel uses. */
      for (const probe of ALL_SECTION_PROBES) {
        await service.probe({
          runId: 'run_conformance',
          probe: probe.name,
          sections: [probe.section],
          scope: workItem.scope,
          reason: 'the conformance check drives every probe, including the ones a healthy '
            + 'world never needs',
        });
      }
      for (const element of REALITY_ELEMENTS as readonly RealityElement[]) {
        await service.reprobeReality(element, workItem, workItem.scope);
      }
      requests.push(...adapters.requests);
    }
  }
  return requests;
}


/* --------------------------------------------- the answers the adapters really give --- */

/**
 * A repository the real repository adapter can attach to, and a git history to match.
 *
 * Files, not fixtures. `repositoryOperations` reads the worktree — manifests, layout, CI
 * definitions, `.git/HEAD` — so the only way to see what it really answers is to give it
 * something real to read. The tree deliberately mirrors `worlds.ts`: the same scope paths, the
 * same manifest, the same pipeline, so the two runs compared below differ in *where the
 * answers came from* and in nothing else.
 */
function realRepository(root: string): void {
  const file = (relative: string, content: string): void => {
    const full = join(root, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  };
  file('package.json', JSON.stringify({
    name: 'pricing',
    version: '1.0.0',
    scripts: {
      build: 'npm run build', test: 'npm test', lint: 'npm run lint', start: 'npm start',
    },
  }, null, 2));
  file('README.md', '# pricing\n');
  file('Dockerfile', 'FROM node:22\n');
  file('.github/workflows/ci.yml', 'name: ci\n');
  file('docs/architecture.md', '# architecture\n');
  file('src/pricing/rate.ts', 'export const rate = () => 1;\n');
  file('src/pricing/index.ts', 'export * from "./rate.js";\n');
  file('src/api/routes/rate.ts', 'export const route = "/rate";\n');
  file('src/ui/pages/rates.tsx', 'export const Rates = () => null;\n');
  file('test/pricing/rate.test.ts', 'import "node:test";\n');
  file('migrations/001_rates.sql', 'create table rates (id int);\n');
  /* No git process runs here, so the ref file is the whole of what the adapter reads. */
  file('.git/HEAD', `ref: refs/heads/feature/${TICKET}-rate-rounding\n`);
}

const UNIT_SEPARATOR = String.fromCharCode(31);

/**
 * git, scripted at the level of its own output.
 *
 * Not a stub of the adapter: a stub of `git`. The adapter's real parsers run over real
 * porcelain, which is the half of the coupling a hand-written response object silently skips —
 * `list_branches` answered bare ref names for as long as it did precisely because no test ever
 * made the parser's output meet the probe that reads it.
 */
function scriptedGit(): ProcessRunner {
  const ok = (stdout: string): ProcessResult =>
    ({ started: true, code: 0, stdout, stderr: '' });
  const branch = (full: string, short: string): string => `${full}${UNIT_SEPARATOR}${short}`;
  return {
    run(command: string, args: readonly string[]): Promise<ProcessResult> {
      assert.equal(command, 'git');
      switch (args[0]) {
        case 'branch':
          return Promise.resolve(ok([
            branch('refs/heads/main', 'main'),
            branch(
              `refs/heads/feature/${TICKET}-rate-rounding`,
              `feature/${TICKET}-rate-rounding`,
            ),
            /* The remote's HEAD, whose short form is a plausible-looking non-branch. */
            branch('refs/remotes/origin/HEAD', 'origin'),
            branch('refs/remotes/origin/main', 'origin/main'),
          ].join('\n') + '\n'));
        case 'symbolic-ref':
          return Promise.resolve(ok('origin/main\n'));
        case 'rev-parse':
          return Promise.resolve(ok(`feature/${TICKET}-rate-rounding\n`));
        case 'remote':
          return Promise.resolve(ok(
            'origin\thttps://example.invalid/repo.git (fetch)\n'
            + 'origin\thttps://example.invalid/repo.git (push)\n',
          ));
        case 'status':
          return Promise.resolve(ok(`## feature/${TICKET}-rate-rounding...origin/main\n`));
        case 'worktree':
          return Promise.resolve(ok(
            `worktree /work/repo\nHEAD ${HEAD_SHA}\nbranch refs/heads/main\n`,
          ));
        case 'tag':
          return Promise.resolve(ok('v1.0.0\n'));
        /* `log` answers two questions here, and `--numstat` is what tells them apart. */
        case 'log':
          return Promise.resolve(ok(args.includes('--numstat')
            ? `${HEAD_SHA}\n12\t3\tsrc/pricing/rate.ts\n4\t0\tsrc/pricing/index.ts\n`
            : [
              [HEAD_SHA, 'dev@example.com', fx.T1, `${TICKET} round rates half-up`],
              [OLD_SHA, 'dev@example.com', fx.T0, 'initial'],
            ].map((fields) => fields.join(UNIT_SEPARATOR)).join('\n') + '\n'));
        default:
          return Promise.resolve(ok(''));
      }
    },
  };
}

/** The pull-request and CI host, answering exactly what the hand-written world answers. */
function scriptedHost(): Connector {
  const world = healthyWorld().responses ?? {};
  return {
    id: 'test.vcs',
    configured: true,
    fetch(resource: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
      switch (resource) {
        case 'pull_requests': return Promise.resolve(world['git.list_prs']);
        case 'pull_request': return Promise.resolve(world['git.read_pr']);
        case 'review_threads': return Promise.resolve(world['git.list_reviews']);
        case 'ci_state': return Promise.resolve(world['git.ci_status']);
        case 'merge_state': return Promise.resolve(world['git.merge_state']);
        case 'branch_protection':
          return Promise.resolve({ protected: args['branch'] === 'main' });
        default: return Promise.reject(new Error(`no fixture for ${resource}`));
      }
    },
  };
}

const CALL_CONTEXT: AdapterCallContext = {
  workItemId: `wi_jira_${TICKET}`,
  runId: 'run_conformance',
  dispatchId: null,
  /*
   * The whole worktree, because a discovery dispatch gets the whole worktree and because what
   * is under test here is what the adapters *answer*. Whether a narrower mandate refuses the
   * right paths is confinement's own question, and `adapters/test/confinement.test.ts` asks it
   * against an injected filesystem rather than by proxy through a probe.
   */
  mandate: { in_scope: ['**'], out_of_scope: [] },
  grantsHeld: [],
  stageMutating: false,
};

/**
 * The real handlers, wired as a world's answers.
 *
 * Each responder invokes the operation the adapter really registered, with the arguments the
 * probe really passed, and hands back the `Assertion` it really produces. Path arguments go
 * through the real `PathConfinement` because the handlers read the resolved forms out of the
 * invocation — this stands in for the framework's pre-handler confinement and for nothing
 * else, which is why it is the real class rather than a permissive stub.
 */
function realAnswers(worktreeRoot: string, home: string): Readonly<Record<string, Responder>> {
  const confinement = new PathConfinement({
    worktreeRoot, installationRoot: join(home, 'agentos'), home, paths: PATHS,
  });
  const registrations: readonly OperationRegistration[] = [
    ...repositoryOperations({ worktreeRoot, paths: PATHS }),
    ...gitOperations({ worktreeRoot, runner: scriptedGit(), host: scriptedHost() }),
  ];

  const out: Record<string, Responder> = {};
  for (const registration of registrations) {
    const { adapter, op, args_schema: schema } = registration.descriptor;
    const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    out[`${adapter}.${op}`] = async (args) => {
      const paths = new Map<string, ConfinedPath>();
      for (const [name, property] of Object.entries(properties)) {
        if ((property as { format?: unknown }).format !== 'path') continue;
        const requested = args[name];
        if (typeof requested !== 'string') continue;
        const verdict = confinement.confine(adapter, op, requested, CALL_CONTEXT.mandate);
        if (verdict.outcome !== 'ALLOWED') continue;
        paths.set(name, {
          resolved: verdict.resolved, relative: verdict.relative, exists: verdict.exists,
        });
      }
      const result = await registration.handler({
        args,
        context: CALL_CONTEXT,
        now: new Date(fx.T1),
        paths,
        confine: (requested) => confinement.confine(adapter, op, requested, CALL_CONTEXT.mandate),
        redact: (value) => value,
      });
      return result.value;
    };
  }
  return out;
}

/** One package, discovered over one world, through both tiers. */
async function discover(world: FakeWorld): Promise<ContextPackage> {
  const service = new DiscoveryService({
    adapters: new FakeAdapters(world), clock: new TestClock(), freshnessWindows: WINDOWS,
  });
  await service.orient({
    runId: 'run_shape', intake: INTAKE, repositoryPath: '/work/repo',
  });
  return service.deepen({
    runId: 'run_shape', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: null,
  });
}

/**
 * Whether an assertion carries an observation somebody can act on.
 *
 * `UNKNOWN` is the loud failure and an empty `FACT` is the quiet one, and the quiet one is why
 * this check exists: `git_state.branches` read `FACT []` against a repository with four
 * branches for as long as it did, because nothing anywhere asserted that a fact has to contain
 * something. Both mean "the probe could not read the answer", and both fail here.
 */
function carriesAnObservation(assertion: Assertion | undefined): boolean {
  if (assertion === undefined || assertion.confidence === 'UNKNOWN') return false;
  const value: unknown = assertion.value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/* -------------------------------------------------------------------------- the check --- */

let scratch: string;
let realRoot: string;
let realHome: string;
let descriptors: ReadonlyMap<string, AdapterOperationDescriptor>;
let schemas: SchemaRegistry;
let calls: readonly ProbeRequest[];

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'agentos-conformance-'));
  mkdirSync(join(scratch, 'worktree'), { recursive: true });
  realRoot = join(scratch, 'real');
  realHome = join(scratch, 'home');
  mkdirSync(realHome, { recursive: true });
  realRepository(realRoot);
  descriptors = realDescriptors(join(scratch, 'worktree'));

  /* The kernel's own validator, over the descriptors' own schemas. Not a restatement. */
  schemas = new SchemaRegistry();
  for (const [key, descriptor] of descriptors) {
    schemas.add({ ...(descriptor.args_schema as Record<string, unknown>), $id: `urn:args:${key}` });
  }
  schemas.seal();

  calls = await everyCall();
});

describe('the operation vocabulary', () => {
  test('every operation discovery declares is one an adapter registers', () => {
    const missing = declaredOperations().filter((key) => !descriptors.has(key));
    assert.deepEqual(
      missing, [],
      'a probe asking for an operation no adapter offers degrades to UNKNOWN with the '
      + 'operation named, which is a gap caused by a naming drift rather than by the world',
    );
  });

  test('every operation discovery calls is one it declared', () => {
    const declared = new Set(declaredOperations());
    const undeclared = [...new Set(calls.map((c) => `${c.adapter}.${c.op}`))]
      .filter((key) => !declared.has(key));
    assert.deepEqual(
      undeclared, [],
      'ops.ts is the one place the coupling is written down. A probe reaching past it is a '
      + 'coupling nobody can check',
    );
  });

  test('the five adapter families are the five, and no probe invents a sixth', () => {
    const families = [...new Set(calls.map((c) => c.adapter))].sort();
    assert.deepEqual(families.filter((f) => !(f in ADAPTERS)), []);
  });
});

describe('the arguments the probes pass', () => {
  test('every call is admitted by the descriptor the adapter actually registers', () => {
    const failures: string[] = [];
    const seen = new Set<string>();
    for (const call of calls) {
      const key = `${call.adapter}.${call.op}`;
      const fingerprint = `${key} ${Object.keys(call.args).sort().join(',')}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      const descriptor = descriptors.get(key);
      if (descriptor === undefined) continue; /* named by the vocabulary test above */

      const result = schemas.validate(`urn:args:${key}`, call.args);
      if (result.valid) continue;
      failures.push(
        `${key}(${JSON.stringify(call.args)}) — `
        + result.errors.map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; '),
      );
    }
    assert.deepEqual(
      failures, [],
      'the adapter framework refuses a call whose arguments its descriptor does not admit, so '
      + 'each of these is a probe that would come back ERROR against a real repository and a '
      + 'Context Package element that would read UNKNOWN for a reason that has nothing to do '
      + 'with the repository:\n' + failures.join('\n'),
    );
  });

  test('the check is not vacuous: every declared operation was actually driven', () => {
    /*
     * An operation no world drives is an operation this check says nothing about, so the set
     * of them is stated rather than tolerated. Asserting equality rather than containment
     * means this fails in both directions: when something stops being driven, and when one of
     * these finally is — at which point the exception is stale and has to go.
     *
     * `repo.read_file` is in the vocabulary and is called by no probe. It is not dead: adapter
     * evidence cites `repo.read_file` locators that the kernel replays, and a tier-3 targeted
     * read is the obvious next caller. What it is, is unchecked by this test, and saying so is
     * the point.
     */
    const NOT_YET_DRIVEN: readonly string[] = ['repo.read_file'];

    const called = new Set(calls.map((c) => `${c.adapter}.${c.op}`));
    const undriven = declaredOperations().filter((key) => !called.has(key));
    assert.deepEqual(undriven, [...NOT_YET_DRIVEN].sort());
  });

  test('and it checked a real number of distinct argument shapes', () => {
    const shapes = new Set(
      calls.map((c) => `${c.adapter}.${c.op} ${Object.keys(c.args).sort().join(',')}`),
    );
    assert.ok(
      shapes.size >= 30,
      `only ${shapes.size} distinct argument shapes were exercised; the drift this test exists `
      + 'to catch lives in the conditional arguments, and a run that built few of them has not '
      + 'looked where the problem was',
    );
  });

  test('a required argument is supplied on every call that is made', () => {
    /*
     * Stated separately from the schema check because it is the half that fails silently in
     * the other direction: a probe that omits a required argument produces the same ERROR, and
     * reading it in the aggregate makes it easy to miss which side is short.
     */
    const short: string[] = [];
    for (const call of calls) {
      const descriptor = descriptors.get(`${call.adapter}.${call.op}`);
      if (descriptor === undefined) continue;
      const required = (descriptor.args_schema as { required?: readonly string[] }).required ?? [];
      for (const name of required) {
        if (call.args[name] === undefined) short.push(`${call.adapter}.${call.op} omits ${name}`);
      }
    }
    assert.deepEqual([...new Set(short)], []);
  });
});

describe('path arguments stay path arguments', () => {
  /*
   * Confinement is driven off the schema: `format: "path"` on a property, or on an array's
   * items, is what makes the framework resolve the value against the worktree root, check it
   * against the dispatch mandate and check it against the deny-list before the handler ever
   * sees it. An argument that names a path and is declared as a plain string is an argument
   * that reaches the filesystem unchecked — so the naming convention is enforced rather than
   * trusted.
   */
  const PATH_SHAPED = /^(path|paths|under)$|_paths?$/;

  function isPathArgument(property: unknown): boolean {
    if (property === null || typeof property !== 'object') return false;
    const schema = property as Record<string, unknown>;
    if (schema['format'] === 'path') return true;
    const items = schema['items'];
    return items !== null && typeof items === 'object'
      && (items as Record<string, unknown>)['format'] === 'path';
  }

  test('every path-shaped argument on a registered descriptor is declared as one', () => {
    const unconfined: string[] = [];
    for (const [key, descriptor] of descriptors) {
      const properties = (descriptor.args_schema as { properties?: Record<string, unknown> })
        .properties ?? {};
      for (const [name, property] of Object.entries(properties)) {
        if (!PATH_SHAPED.test(name)) continue;
        if (!isPathArgument(property)) unconfined.push(`${key}.${name}`);
      }
    }
    assert.deepEqual(
      unconfined, [],
      'an argument named for a path and declared as a plain string is not confined, is not '
      + 'checked against the dispatch mandate, and is not checked against the deny-list',
    );
  });

  test('and at least one operation actually carries one, so the rule is exercised', () => {
    const carriers = [...descriptors.entries()].filter(([, descriptor]) => {
      const properties = (descriptor.args_schema as { properties?: Record<string, unknown> })
        .properties ?? {};
      return Object.values(properties).some(isPathArgument);
    });
    assert.ok(carriers.length >= 4, `only ${carriers.length} operation(s) declare a path argument`);
  });
});

describe('what the adapters answer, the probes can read', () => {
  /*
   * The other half of the same coupling. Every operation in `adapters/` answers with an
   * `Assertion`, which is how "git is not installed" stays distinguishable from "the repository
   * has no branches" — and a probe that read that wrapper as though it were the data would turn
   * a failure to look into a fact about the world, which is the one thing this layer exists to
   * prevent. `probes/observation.ts` unwraps it; this is the check that it keeps doing so.
   */
  test('an UNKNOWN answer is not an observation, and never becomes a value', async () => {
    const { observe } = await import('../src/probes/observation.js');
    const { unknown } = await import('@agentos/adapters');
    const adapters = new FakeAdapters(withResponses(healthyWorld(), {
      'git.list_branches': unknown(
        'git.list_branches', fx.T1, 'UNAVAILABLE',
        'make git available on this host',
        'git could not be started',
      ),
    }));
    const service = new DiscoveryService({
      adapters, clock: new TestClock(), freshnessWindows: WINDOWS,
    });
    await service.orient({
      runId: 'run_unwrap', intake: INTAKE, repositoryPath: '/work/repo',
    });
    const context = await service.deepen({
      runId: 'run_unwrap', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: null,
    });
    const branches = context.git_state['branches'];
    assert.equal(
      branches?.confidence, 'UNKNOWN',
      'the adapter said it could not read the branches. Reporting that as "there are no '
      + 'branches" is the failure the assertion wrapper exists to prevent',
    );
    assert.equal(typeof observe, 'function');
  });

  test('a FACT answer arrives as its value, not as the assertion around it', async () => {
    const { fact, selfEvidence } = await import('@agentos/adapters');
    const adapters = new FakeAdapters(withResponses(healthyWorld(), {
      'git.list_tags': fact(
        [{ name: 'v9.9.9', release: true }], 'git.list_tags', fx.T1,
        selfEvidence({
          adapter: 'git', op: 'list_tags', args: {}, kind: 'git',
          ref: 'git tag --list', excerpt: 'v9.9.9', observedAt: fx.T1,
        }),
      ),
    }));
    const service = new DiscoveryService({
      adapters, clock: new TestClock(), freshnessWindows: WINDOWS,
    });
    await service.orient({
      runId: 'run_unwrap', intake: INTAKE, repositoryPath: '/work/repo',
    });
    const context = await service.deepen({
      runId: 'run_unwrap', workItem: WORK_ITEM, repositoryPath: '/work/repo', previous: null,
    });
    const tags = context.git_state['tags'];
    assert.equal(tags?.confidence, 'FACT');
    assert.deepEqual(
      tags?.confidence === 'FACT' ? tags.value : null,
      [{ name: 'v9.9.9', release: true }],
      'the probe must see the observation, not the envelope it arrived in',
    );
  });


  /*
   * The other end of the same coupling, and the end that stayed open.
   *
   * Everything above checks what a probe *asks*. Nothing above checks what it can *read*, and
   * three mismatches lived in that gap for as long as they did because the world the probe
   * suite is driven over is written by hand, in the probe's own vocabulary: it answered
   * `{ name, default, protected }` branch records to a `list_branches` that returned bare ref
   * names, `root` to an `identify` that reports `path`, and flat commands to a `commands` that
   * nests them one level down. Every probe test passed. Every one of those calls would have
   * come back unreadable against a real repository.
   *
   * So this drives the **same real probes** over a world whose repository and git answers are
   * produced by the **real adapter handlers** — real manifest parsing, real git porcelain
   * parsing, real `Assertion` wrapping — and compares the package it produces against the
   * package the hand-written world produces. Anything the hand-written world can state and the
   * real answers cannot is a shape mismatch, and it is named rather than tolerated.
   */
  test('every repository and git fact the hand-written world states, the real answers state too', async () => {
    /*
     * Stated rather than tolerated, and asserted as equality so it fails in both directions:
     * when something new stops being readable, and when one of these becomes readable and the
     * exemption goes stale. Each is a key the fixture world answers and the real repository
     * adapter genuinely does not: `detect_stack` establishes ecosystems from manifests and
     * says nothing about frameworks, build system, test runner or linters, and the probe
     * reports INSUFFICIENT_EVIDENCE for them rather than reading a framework off a filename —
     * which is the detection-from-a-name the attachment sequence forbids.
     */
    const NOT_ESTABLISHED_BY_THE_REAL_ADAPTER: readonly string[] = [
      'repository.build_system',
      'repository.frameworks',
      'repository.linters',
      'repository.test_runner',
    ];

    const handWritten = await discover(healthyWorld());
    const real = await discover(withResponses(healthyWorld(), realAnswers(realRoot, realHome)));

    const unreadable: string[] = [];
    const why: string[] = [];
    let compared = 0;
    for (const section of ['repository', 'git_state'] as const) {
      for (const [key, assertion] of Object.entries(handWritten[section])) {
        if (!carriesAnObservation(assertion)) continue;
        compared += 1;
        const answered = real[section][key];
        if (carriesAnObservation(answered)) continue;
        unreadable.push(`${section}.${key}`);
        why.push(`${section}.${key} — the probe produced ` + (answered === undefined
          ? 'nothing'
          : answered.confidence === 'UNKNOWN'
            ? `UNKNOWN (${answered.reason})`
            : `${answered.confidence} with an empty value`));
      }
    }

    assert.deepEqual(
      unreadable.sort(), [...NOT_ESTABLISHED_BY_THE_REAL_ADAPTER].sort(),
      'each of these is a Context Package key that reads populated against the fixture and '
      + 'empty against a real repository, which is the most expensive kind of green there is:\n'
      + why.join('\n'),
    );
    assert.ok(
      compared >= 25,
      `only ${String(compared)} key(s) were compared; a run that established little has not `
      + 'looked where the problem was',
    );
  });

  /*
   * The three that were wrong, named individually.
   *
   * The comparison above is mechanical and would have caught all three, but it says only
   * "unreadable" — and each of these carries a specific obligation about *what* has to be
   * readable, which is worth stating where someone changing the shape will read it.
   */
  test('a branch listing carries names, the default branch, and a protection classification', async () => {
    const real = await discover(withResponses(healthyWorld(), realAnswers(realRoot, realHome)));
    const branches = real.git_state['branches'];
    assert.equal(branches?.confidence, 'FACT');
    const listed = (branches?.confidence === 'FACT' ? branches.value : []) as ReadonlyArray<
      Readonly<Record<string, unknown>>
    >;

    assert.deepEqual(
      listed.map((b) => b['name']).sort(),
      ['feature/DEF-456-rate-rounding', 'main', 'origin/main'],
      'a listing of ref-name strings reads as no branches at all through `records`, and the '
      + "remote's HEAD is a symbolic pointer rather than a branch called `origin`",
    );
    assert.deepEqual(
      listed.filter((b) => b['default'] === true).map((b) => b['name']), ['main'],
      'nothing downstream can name a base branch without this',
    );
    for (const branch of listed) {
      const classification = branch['protection'] as { value?: unknown; confidence?: unknown };
      assert.equal(
        typeof branch['protected'], 'boolean',
        `${String(branch['name'])} carries no protection flag, and unknown protection is `
        + 'protected rather than absent',
      );
      assert.ok(
        classification.value !== undefined && classification.confidence !== undefined,
        'the classification and its confidence are recorded, so a branch treated as protected '
        + 'because nobody could tell stays distinguishable from one the host says is protected',
      );
    }
  });

  test('repository identity and stack are read in the Context Model\'s vocabulary', async () => {
    const real = await discover(withResponses(healthyWorld(), realAnswers(realRoot, realHome)));
    assert.equal(
      real.repository['root']?.confidence, 'FACT',
      'the attachment sequence identifies a `path` and this section is written in `root`; '
      + 'the translation is the probe\'s job and its absence is not a gap in the repository',
    );
    assert.ok(
      carriesAnObservation(real.repository['languages']),
      'an ecosystem read off a manifest is not a language, so the languages are counted from '
      + 'the layout — but they are established, not left INSUFFICIENT_EVIDENCE',
    );
    assert.equal(real.repository['ecosystems']?.confidence, 'FACT');
  });

  test('the commands are read out of the attachment-output map, not from one level too high', async () => {
    const real = await discover(withResponses(healthyWorld(), realAnswers(realRoot, realHome)));
    for (const key of ['build_command', 'test_command', 'lint_command', 'run_command']) {
      const command = real.repository[key];
      assert.equal(
        command?.confidence, 'INFERENCE',
        `${key} was not read; a repository that declares its commands must not report that it `
        + 'declares none. It stays an INFERENCE until something executes it',
      );
    }
  });
});

test('the scratch directory is removed', () => {
  rmSync(scratch, { recursive: true, force: true });
});
