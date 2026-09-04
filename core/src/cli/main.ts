#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { RunStore } from '@agentos/state';
import { loadPolicies, PolicyLoadError } from '@agentos/policies';
import { ContractViolationError } from '@agentos/contracts';
import { Kernel } from '../kernel.js';
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

/**
 * The AgentOS command line.
 *
 * Four commands, and the one that matters most is `narrate`. **A run that did the wrong thing
 * correctly is invisible without it**, which is why the narrative obligation is a deliverable
 * rather than a nicety: the residual risk v0.3 names is a confidently wrong resolution, and
 * the only mitigation available is that the run says out loud what it decided the work was and
 * why.
 *
 * ```
 * agentos status  [<work-item-id>] [<run-id>]   where a run is, from the projection
 * agentos narrate <work-item-id> [<run-id>]     what AgentOS decided and why
 * agentos replay  <fixture-dir>                 drive the kernel from recorded envelopes
 * agentos work    ...                           not in this build (see below)
 * ```
 *
 * `work` is absent rather than stubbed. Starting a real run needs a live adapter registry, a
 * discovery implementation and an agent substrate — WP-4, WP-6 and WP-5 respectively — and a
 * command that accepted the invocation and then did nothing useful would be worse than a
 * command that says the build cannot do it yet. `replay` is the driver that exists now, and
 * it drives the entire kernel.
 */

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly stateRoot: string;
}

const USAGE = [
  'usage: agentos <command> [arguments]',
  '',
  '  status  [<work-item-id>] [<run-id>]   where a run is, read from the projection',
  '  narrate <work-item-id> [<run-id>]     what AgentOS decided the work was, and why',
  '  replay  <fixture-dir>                 drive the kernel from recorded envelopes',
  '',
  'state is read from and written to AGENTOS_STATE, or ./state.',
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
      io.err(
        'agentos work is not available in this build: starting a run needs a live adapter '
        + 'registry, a discovery implementation and an agent substrate. `agentos replay '
        + '<fixture-dir>` drives the whole kernel from recorded envelopes.',
      );
      return 2;

    default:
      io.err(`unknown command ${command}`);
      for (const line of USAGE) io.err(line);
      return 2;
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

/* --------------------------------------------------------------------- entry ---- */

/** The process entry point: argv, stdout, and the exit code as a number. */
export async function run(argv: readonly string[]): Promise<number> {
  const io: CliIo = {
    out: (line) => { process.stdout.write(`${line}\n`); },
    err: (line) => { process.stderr.write(`${line}\n`); },
    stateRoot: process.env['AGENTOS_STATE'] ?? join(process.cwd(), 'state'),
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
