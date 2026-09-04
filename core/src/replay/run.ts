import { loadPolicies } from '@agentos/policies';
import { RunStore } from '@agentos/state';
import { Kernel, type RunResult } from '../kernel.js';
import type { IdentityResolution } from '../admission.js';
import { loadFixture, type ReplayFixture } from './fixture.js';
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
} from './ports.js';

/**
 * Drives the whole kernel from a recorded run.
 *
 * The plan's `agentos replay <fixture-dir>`. Everything the kernel meets is recorded, so what
 * comes out is a statement about the kernel and the envelopes and nothing else — which is
 * what makes it usable as the driver for the end-to-end scenarios and as the way a run is
 * re-examined after it happened.
 *
 * The state written is real: the same store, the same append-only logs, the same projections.
 * A replay is a run, and its log is readable by `agentos status` and `agentos narrate`
 * afterwards. That is deliberate — a replay whose output could not be inspected the way a
 * real run's can would be a different thing wearing the same name.
 */

export interface ReplayOptions {
  /** Where the replay's state is written. A real store, so the replay is inspectable. */
  readonly stateRoot: string;
  /** The repository the recording was taken against, for the mandate. Never read. */
  readonly repositoryPath?: string;
  /** Frozen clock, so the same fixture replays to the same run. */
  readonly at?: string;
  readonly access?: ReadonlySet<'repository' | 'git' | 'project_management' | 'runtime' | 'production'>;
}

export interface ReplayOutcome {
  readonly fixture: ReplayFixture;
  readonly result: RunResult;
  /** The envelope files the run actually consumed, in order. */
  readonly dispatched: readonly string[];
  /** Envelope files the recording carried and the run never asked for. */
  readonly unused: readonly string[];
}

const DEFAULT_AT = '2026-01-01T00:00:00.000Z';

export async function replayFixture(
  directory: string,
  options: ReplayOptions,
): Promise<ReplayOutcome> {
  const fixture = loadFixture(directory);
  const clock = new FrozenClock(options.at ?? DEFAULT_AT);
  const substrate = new RecordedSubstrate(fixture);

  const kernel = new Kernel({
    store: new RunStore(options.stateRoot),
    policies: loadPolicies(),
    clock,
    adapters: new RecordedAdapterRegistry(fixture, clock),
    discovery: new RecordedDiscovery(fixture, clock),
    registries: new RecordedRegistries(fixture),
    agents: new RecordedAgents(fixture),
    substrate,
    host: replayHost(),
    human: new NoHuman(),
    random: seededSampler(directory),
    repositoryPath: options.repositoryPath ?? directory,
    access: options.access ?? new Set(['repository', 'git']),
  });

  const result = await kernel.work({
    source: fixture.intake.source,
    sourceLocator: fixture.intake.source_locator,
    raw: fixture.intake.raw,
    resolveIdentity: () => Promise.resolve(resolveRecordedIdentity(fixture, clock)),
    rereadIntake: () => Promise.resolve(
      fixture.intake.reread === null
        ? {
          outcome: 'UNAVAILABLE',
          detail:
            'the fixture records no re-read of the intake source, so source drift is '
            + 'INDETERMINATE rather than absent',
        }
        : { outcome: 'OK', raw: fixture.intake.reread.raw },
    ),
  });

  const dispatched = [...substrate.dispatchedFiles];
  return {
    fixture,
    result,
    dispatched,
    unused: fixture.envelopes
      .map((entry) => entry.file)
      .filter((file) => !dispatched.includes(file)),
  };
}

/**
 * The recorded resolution of an external key.
 *
 * A replay cannot fetch a ticket, so it reports what the recording said the fetch returned.
 * `RESOLVED` carries evidence naming the recording, because an identity accepted on a
 * fixture's word with no evidence would be an identity accepted on a claim — which is the
 * thing the admission check exists to prevent.
 */
function resolveRecordedIdentity(
  fixture: ReplayFixture,
  clock: FrozenClock,
): IdentityResolution {
  const identity = fixture.intake.identity;
  if (identity.outcome !== 'RESOLVED') return identity;
  return {
    outcome: 'RESOLVED',
    identity: identity.identity,
    evidence: {
      id: 'E-replay-identity',
      kind: 'ticket',
      locator: {
        adapter: 'replay',
        op: 'read_fixture',
        args: { file: 'intake.json', field: 'identity' },
      },
      ref: identity.identity,
      excerpt: `the fixture records ${identity.identity} as resolved`,
      observed_at: clock.now().toISOString(),
      reproducible: true,
    },
  };
}
