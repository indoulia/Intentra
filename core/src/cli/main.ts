#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { RunStore } from '@agentos/state';
import { loadPolicies, PolicyLoadError } from '@agentos/policies';
import { ContractViolationError, type IntakeSource, type Locator, type ModelEntry } from '@agentos/contracts';
import { Kernel, type RunResult } from '../kernel.js';
import { FixtureError } from '../replay/fixture.js';
import { replayFixture } from '../replay/run.js';
import {
  FrozenClock,
  NoHuman,
  RecordedAdapterRegistry,
  RecordedAgents,
  RecordedDiscovery,
  RecordedRegistries,
  RecordedSubstrate,
  replayHost,
  seededSampler,
} from '../replay/ports.js';
import {
  buildKernel,
  identityResolverFor,
  intakeRereaderFor,
  UNATTENDED_OPERATOR,
  type BuiltKernel,
  type OperatorPrompt,
} from '../composition/index.js';

/**
 * The AgentOS command line.
 *
 * Four commands, and the one that matters most is `narrate`. **A run that did the wrong thing
 * correctly is invisible without it**, which is why the narrative obligation is a deliverable
 * rather than a nicety: the residual risk v0.3 names is a confidently wrong resolution, and
 * the only mitigation available is that the run says out loud what it decided the work was and
 * why. `work` therefore prints the narrative on every path, including the ones that refuse.
 *
 * ```
 * agentos work    --repo <path> [--source <s>] "<request>"   start a run
 * agentos status  [<work-item-id>] [<run-id>]                where a run is, from the projection
 * agentos narrate <work-item-id> [<run-id>]                  what AgentOS decided and why
 * agentos replay  <fixture-dir>                              drive the kernel from recorded envelopes
 * ```
 *
 * Decision I-19 said `work` would be added "when the last port it needs exists", and it now
 * does: `core/src/composition/` assembles the live adapter framework, discovery, registries,
 * the agent catalogue and the substrate. The run it starts is read-only, because
 * `policies/data/execution.json` sets `mutation_enabled: false` and admits only `READ_ONLY`
 * risk classes, and because no mutating adapter operation is registered — the target
 * repository is byte-identical before and after.
 *
 * **The exit code distinguishes outcomes**, because a blocked run is not a crash and must not
 * look like success. A script branches on the number; a human reads the narrative.
 */

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly stateRoot: string;
  /**
   * Where a question to the operator goes.
   *
   * The uncertainty ladder's fourth rung asks a human, and a run that could never ask would
   * climb from probing straight to blocking. Absent, nobody is asked and every question goes
   * unanswered — which is a rung 5 outcome honestly reached, not a silent default answer.
   */
  readonly ask?: OperatorPrompt;
}

/**
 * Exit codes.
 *
 * Zero is a completed run and nothing else. Every other outcome gets its own number so that
 * `blocked`, `refused` and `failed` are distinguishable from each other and from the
 * argument, fixture, policy and contract errors `run()` maps below — a blocked run is a
 * result, and reporting it as a crash would be as wrong as reporting it as success.
 */
export const EXIT = Object.freeze({
  COMPLETE: 0,
  USAGE: 2,
  BLOCKED: 10,
  REFUSED: 11,
  FAILED: 12,
  CANCELLED: 13,
  RERESOLVED: 14,
});

const USAGE = [
  'usage: agentos <command> [arguments]',
  '',
  '  work    --repo <path> [--source <source>] "<request>"',
  '                                        resolve the request against the repository and run it',
  '  status  [<work-item-id>] [<run-id>]   where a run is, read from the projection',
  '  narrate <work-item-id> [<run-id>]     what AgentOS decided the work was, and why',
  '  replay  <fixture-dir>                 drive the kernel from recorded envelopes',
  '',
  'work sources: NATURAL_LANGUAGE (default), PROJECT_MANAGEMENT, VCS, DOCUMENT, EVENT,',
  '              SCHEDULE, RUNTIME_ALERT. A PROJECT_MANAGEMENT request is a ticket key, and',
  '              the ticket is the source the drift check re-reads.',
  '',
  'exit codes: 0 complete, 10 blocked, 11 refused, 12 failed, 13 cancelled, 14 re-resolved,',
  '            2 usage, 3 unusable fixture, 4 policy did not load, 5 contract violation.',
  '',
  'state is read from and written to AGENTOS_STATE, or ./state.',
  'models and host skills are declared in AGENTOS_MODELS and AGENTOS_SKILLS as JSON arrays.',
  'With no model declared every dispatch reports NO_MODEL and the run blocks on an external',
  'dependency, having advanced nothing.',
];

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      for (const line of USAGE) io.out(line);
      return command === undefined ? 1 : 0;

    case 'status':
      return status(rest, io);

    case 'narrate':
      return narrate(rest, io);

    case 'replay':
      return replay(rest, io);

    case 'work':
      return work(rest, io);

    default:
      io.err(`unknown command ${command}`);
      for (const line of USAGE) io.err(line);
      return EXIT.USAGE;
  }
}

function openStore(io: CliIo): RunStore {
  return new RunStore(io.stateRoot);
}

function status(args: readonly string[], io: CliIo): number {
  const store = openStore(io);
  const [workItemId, runId] = args;

  if (workItemId === undefined) {
    const items = store.listWorkItems();
    if (items.length === 0) {
      io.out(`no work items under ${io.stateRoot}`);
      return 0;
    }
    for (const id of items) {
      const item = store.getWorkItem(id);
      const runs = store.listRuns(id);
      io.out(
        `${id}  ${item?.type ?? 'UNKNOWN'}  ${item?.lifecycle ?? '?'}  `
        + `${runs.length} run(s)  ${item?.title ?? ''}`,
      );
    }
    return 0;
  }

  const kernel = kernelForReading(io);
  for (const line of kernel.status(workItemId, runId)) io.out(line);
  return 0;
}

function narrate(args: readonly string[], io: CliIo): number {
  const [workItemId, runId] = args;
  if (workItemId === undefined) {
    io.err('narrate needs a work item id. `agentos status` lists them.');
    return 2;
  }
  const kernel = kernelForReading(io);
  io.out(kernel.narrate(workItemId, runId));
  return 0;
}

async function replay(args: readonly string[], io: CliIo): Promise<number> {
  const [directory] = args;
  if (directory === undefined) {
    io.err('replay needs a fixture directory.');
    return 2;
  }
  const outcome = await replayFixture(resolve(directory), { stateRoot: io.stateRoot });

  io.out(`replayed ${outcome.fixture.directory}`);
  io.out(`  outcome    ${outcome.result.outcome}`);
  io.out(`  work item  ${outcome.result.workItemId ?? '(none admitted)'}`);
  io.out(`  run        ${outcome.result.runId ?? '(none started)'}`);
  io.out(`  detail     ${outcome.result.detail}`);
  io.out(`  envelopes  ${outcome.dispatched.join(', ') || '(none dispatched)'}`);
  if (outcome.unused.length > 0) {
    /*
     * Reported rather than ignored. A recording the run did not consume all of means the run
     * took a different path than the one that was recorded, which is usually the finding.
     */
    io.out(`  unused     ${outcome.unused.join(', ')}`);
  }
  io.out('');
  io.out(outcome.result.narrative);
  return outcome.result.outcome === 'COMPLETE' ? 0 : 1;
}

/**
 * A kernel for reading only.
 *
 * `status` and `narrate` read the store and touch nothing else, but `Kernel` is constructed
 * with every port. The recorded ports over an empty fixture are the honest way to say "this
 * kernel will not be dispatching anything": each of them answers from a recording, and there
 * is no recording.
 */
function kernelForReading(io: CliIo): Kernel {
  const clock = new FrozenClock(new Date().toISOString());
  const fixture = {
    directory: io.stateRoot,
    intake: {
      source: 'NATURAL_LANGUAGE' as const,
      source_locator: { adapter: 'host.cli', op: 'read_invocation', args: {} },
      raw: 'read-only invocation',
      reread: null,
      identity: { outcome: 'NOT_NAMED' as const },
    },
    context: null,
    envelopes: [],
    adapters: { operations: [] },
    skills: [],
    models: [],
    agents: [],
  };
  return new Kernel({
    store: openStore(io),
    policies: loadPolicies(),
    clock,
    adapters: new RecordedAdapterRegistry(fixture, clock),
    discovery: new RecordedDiscovery(fixture, clock),
    registries: new RecordedRegistries(fixture),
    agents: new RecordedAgents(fixture),
    substrate: new RecordedSubstrate(fixture),
    host: replayHost(),
    human: new NoHuman(),
    random: seededSampler('cli'),
    repositoryPath: process.cwd(),
    access: new Set(['repository', 'git']),
  });
}

/* ====================================================================== work ==== */

/** The intake sources the CLI accepts, checked rather than cast. */
const INTAKE_SOURCES: readonly IntakeSource[] = [
  'NATURAL_LANGUAGE', 'PROJECT_MANAGEMENT', 'VCS', 'DOCUMENT', 'EVENT', 'SCHEDULE',
  'RUNTIME_ALERT',
];

interface WorkArguments {
  readonly repositoryPath: string;
  readonly source: IntakeSource;
  readonly raw: string;
}

type ArgumentParse =
  | { readonly ok: true; readonly value: WorkArguments }
  | { readonly ok: false; readonly detail: string };

/**
 * `--repo` is required rather than defaulting to the working directory.
 *
 * A default would make the most likely accident — running AgentOS against its own
 * installation, where the path deny-list refuses every read — look like a broken repository
 * rather than like a missing argument.
 */
export function parseWorkArguments(args: readonly string[]): ArgumentParse {
  let repositoryPath: string | null = null;
  let source: IntakeSource = 'NATURAL_LANGUAGE';
  const words: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--repo' || argument === '--source') {
      const value = args[index + 1];
      if (value === undefined) return { ok: false, detail: `${argument} needs a value` };
      index += 1;
      if (argument === '--repo') {
        repositoryPath = value;
        continue;
      }
      const named = INTAKE_SOURCES.find((candidate) => candidate === value.toUpperCase());
      if (named === undefined) {
        return {
          ok: false,
          detail: `${value} is not an intake source. One of: ${INTAKE_SOURCES.join(', ')}`,
        };
      }
      source = named;
      continue;
    }
    if (argument !== undefined) words.push(argument);
  }

  if (repositoryPath === null) return { ok: false, detail: 'work needs --repo <path>' };
  const raw = words.join(' ').trim();
  if (raw.length === 0) {
    return {
      ok: false,
      detail:
        'work needs the request itself. AgentOS resolves what the work is; it cannot resolve '
        + 'nothing',
    };
  }
  return { ok: true, value: { repositoryPath: resolve(repositoryPath), source, raw } };
}

/**
 * The locator the source-drift check re-executes at `COMPLETION`.
 *
 * For a request the operator typed, the invocation itself is the source and `host.read_intake`
 * re-reads it. For a ticket, the ticket is the source: the operator naming a key is not the
 * request, it is a pointer at one, and "the ticket said X" has to be checkable rather than
 * remembered.
 */
export function sourceLocatorFor(source: IntakeSource, raw: string): Locator {
  if (source === 'PROJECT_MANAGEMENT') {
    return { adapter: 'pm', op: 'read_issue', args: { key: raw } };
  }
  return { adapter: 'host', op: 'read_intake', args: {} };
}

async function work(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseWorkArguments(args);
  if (!parsed.ok) {
    io.err(parsed.detail);
    for (const line of USAGE) io.err(line);
    return EXIT.USAGE;
  }
  const { repositoryPath, source, raw } = parsed.value;

  const built = await buildKernel({
    stateRoot: io.stateRoot,
    repositoryPath,
    intake: { source, raw, received_at: new Date().toISOString() },
    operator: io.ask ?? UNATTENDED_OPERATOR,
  });

  reportBuild(built, io);

  const result = await built.kernel.work({
    source,
    sourceLocator: sourceLocatorFor(source, raw),
    raw,
    resolveIdentity: identityResolverFor(built),
    rereadIntake: intakeRereaderFor(built),
  });

  return reportRun(result, built.models, io);
}

/**
 * What the build reached, before the run that depends on it.
 *
 * Printed every time, including on a run that goes on to succeed. An access class this build
 * does not hold changes which Definition of Done profiles the outcome may bind to, so it
 * changes what the run is allowed to conclude — and the reason a class is absent, `UNAVAILABLE`
 * against `NOT_CONFIGURED`, is the difference between something to go and fix and something to
 * accept.
 */
function reportBuild(built: BuiltKernel, io: CliIo): void {
  const principal = built.host.principal;
  io.out(`repository  ${built.ports.repositoryPath}`);
  io.out(
    `host        ${built.host.host}, trust class ${built.host.trustClass}, principal `
    + (principal === null ? '(none asserted)' : principal.id),
  );
  io.out(`adapters    ${built.availability.map((a) => `${a.adapter}=${a.state}`).join(' ')}`);

  const held = built.accessDerivation.findings.filter((finding) => finding.held);
  io.out(`access      ${held.map((finding) => finding.access).join(', ') || '(none)'}`);
  for (const finding of built.accessDerivation.findings) {
    if (finding.held) continue;
    io.out(`  no ${finding.access}: ${finding.state} — ${finding.detail}`);
  }

  const models = built.models.filter((entry) => entry.availability.state === 'AVAILABLE');
  io.out(`models      ${models.length} available of ${built.models.length} enumerated`);
  io.out(`skills      ${built.skills.length} enumerated`);
  for (const problem of built.problems) io.err(`  ${problem.variable}: ${problem.detail}`);
  io.out('');
}

/**
 * The outcome, and the narrative, and the exit code that tells them apart.
 *
 * The narrative is printed on every path — including a refusal, where it is the only account
 * of what AgentOS made of the request before it stopped. A run that refused silently would be
 * a run nobody could argue with.
 */
function reportRun(result: RunResult, models: readonly ModelEntry[], io: CliIo): number {
  const external = externalDependency(result, models);

  io.out(`outcome     ${external === null ? result.outcome : 'BLOCKED'}`);
  if (external !== null) io.out('blocker     EXTERNAL_DEPENDENCY');
  io.out(`work item   ${result.workItemId ?? '(none admitted)'}`);
  io.out(`run         ${result.runId ?? '(none started)'}`);
  io.out(`detail      ${result.detail}`);
  if (external !== null) io.out(`            ${external}`);
  io.out('');
  io.out(result.narrative);

  if (external !== null) return EXIT.BLOCKED;
  switch (result.outcome) {
    case 'COMPLETE': return EXIT.COMPLETE;
    case 'BLOCKED': return EXIT.BLOCKED;
    case 'REFUSED': return EXIT.REFUSED;
    case 'FAILED': return EXIT.FAILED;
    case 'CANCELLED': return EXIT.CANCELLED;
    case 'RERESOLVED': return EXIT.RERESOLVED;
  }
}

/**
 * Whether this run stopped because no model was reachable.
 *
 * With no model, the resolution dispatch fails before a Work Item exists, so the kernel has no
 * run to block and refuses instead — there is nothing yet to attach a blocker to. The
 * condition is nevertheless an external dependency and not a judgment about the request, and
 * reporting it as a plain refusal would tell an operator their request was inadmissible when
 * the truth is that AgentOS could not reach a model. Every kernel function still ran, no work
 * item was admitted and no run was started, so nothing advanced.
 *
 * The kernel's own `detail` is the evidence rather than a guess about it: `work()` returns the
 * reason resolution gave, and "no model available" is that reason stated by the component that
 * made the decision.
 */
function externalDependency(result: RunResult, models: readonly ModelEntry[]): string | null {
  if (result.outcome !== 'REFUSED') return null;
  if (!result.detail.includes('no model available')) return null;
  const available = models.filter((entry) => entry.availability.state === 'AVAILABLE');
  return `${models.length} model(s) enumerated and ${available.length} available. No work item `
    + 'was admitted and no run was started, so no state advanced; the same invocation resumes '
    + 'from here when a model returns. Declare models in AGENTOS_MODELS.';
}

/* --------------------------------------------------------------------- entry ---- */

/**
 * The operator, where there is a terminal to reach one through.
 *
 * A question asked into a pipe would sit unanswered until the policy window closed, so a
 * non-interactive invocation does not ask at all and the ladder records a rung it could not
 * climb. Both paths return `null` for "no answer", and neither ever supplies one: an answer
 * AgentOS invented would be the single input the design says a model may never provide.
 */
export function terminalOperator(): OperatorPrompt {
  if (!process.stdin.isTTY) return UNATTENDED_OPERATOR;
  return async (question, readings) => {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(`\n${question}\n`);
      for (const [index, reading] of readings.entries()) {
        process.stdout.write(`  ${index + 1}. ${reading.reading} -> ${reading.would_do}\n`);
      }
      const answer = (await reader.question('answer (empty leaves it unanswered): ')).trim();
      return answer.length === 0 ? null : answer;
    } finally {
      reader.close();
    }
  };
}

/** The process entry point: argv, stdout, and the exit code as a number. */
export async function run(argv: readonly string[]): Promise<number> {
  const io: CliIo = {
    out: (line) => { process.stdout.write(`${line}\n`); },
    err: (line) => { process.stderr.write(`${line}\n`); },
    stateRoot: process.env['AGENTOS_STATE'] ?? join(process.cwd(), 'state'),
    ask: terminalOperator(),
  };
  try {
    return await main(argv, io);
  } catch (error) {
    /*
     * Three failures get their own message because each names a different thing to go and
     * fix, and "Error: something" would hide which.
     */
    if (error instanceof FixtureError) {
      io.err(`the fixture is not usable: ${error.message}`);
      return 3;
    }
    if (error instanceof PolicyLoadError) {
      io.err('the policy set did not load:');
      for (const problem of error.problems) {
        io.err(`  ${problem.file}: ${problem.rule}: ${problem.message}`);
      }
      return 4;
    }
    if (error instanceof ContractViolationError) {
      io.err(`a document did not satisfy its contract: ${error.message}`);
      return 5;
    }
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/* istanbul ignore next -- the process boundary */
if (process.argv[1] !== undefined && process.argv[1].endsWith('main.js')) {
  run(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
