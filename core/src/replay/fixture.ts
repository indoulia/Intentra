import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  validators,
  type AdapterAvailability,
  type AdapterOperationDescriptor,
  type AgentSpecView,
  type CallRecord,
  type Classification,
  type ContextPackage,
  type IntakeSource,
  type Locator,
  type ModelEntry,
  type SkillEntry,
} from '@agentos/contracts';

/**
 * A recorded run, on disk.
 *
 * `agentos replay <fixture-dir>` drives the whole kernel from one of these: no model, no
 * network and no repository. It is the tool that answers "what would the kernel do with these
 * envelopes", which is how a run is re-audited after the fact and how the kernel's own
 * behaviour is checked against recorded agent output — including the malformed, the
 * over-claiming and the fabricated, because those are the cases the disbelief machinery
 * exists for.
 *
 * The directory layout, all of it optional except the intake and at least one envelope:
 *
 * ```
 * <fixture-dir>/
 *   intake.json        the request: source, locator, raw text, and the reread for the
 *                      source-drift check
 *   context.json       a Context Package, returned by the recorded discovery port
 *   envelopes/         NN-<name>.json, dispatched in filename order, each optionally
 *                      accompanied by NN-<name>.calls.json: the tool calls that dispatch
 *                      made, re-issued against the recorded adapter results
 *   adapters.json      recorded operation descriptors, call results and replay results
 *   registries.json    the skills and models the selection layer chooses among
 *   agents.json        the agent specifications the kernel builds input packages for
 * ```
 *
 * Everything read here is **untrusted input**: it is validated against the contracts before
 * the kernel sees it, and a fixture that does not conform is refused with the reason rather
 * than half-loaded. A replay fixture is exactly as much a source of malformed data as an
 * agent is.
 */

export interface ReplayIntake {
  readonly source: IntakeSource;
  readonly source_locator: Locator;
  readonly raw: string;
  /**
   * What re-reading the source at `COMPLETION` returns. Absent means unavailable, which is
   * the honest answer for a fixture recorded from a source nobody can reach again.
   */
  readonly reread: { readonly raw: string } | null;
  /** How an external key resolves, if the intake names one. */
  readonly identity:
    | { readonly outcome: 'NOT_NAMED' }
    | { readonly outcome: 'RESOLVED'; readonly identity: string }
    | { readonly outcome: 'ABSENT'; readonly identity: string }
    | { readonly outcome: 'UNAVAILABLE'; readonly identity: string; readonly detail: string };
}

/** One recorded adapter operation: what it is, what a call returns, what a replay returns. */
export interface RecordedOperation {
  readonly descriptor: AdapterOperationDescriptor;
  /** Call results keyed by a canonical digest of the arguments; `*` matches any arguments. */
  readonly results?: Readonly<Record<string, unknown>>;
  /** What replaying this operation returns, for evidence verification. */
  readonly replay?:
    | { readonly outcome: 'OK'; readonly value: unknown; readonly excerpt: string }
    | { readonly outcome: 'UNREPLAYABLE'; readonly reason: string }
    | { readonly outcome: 'REFUSED'; readonly reason: string };
}

export interface RecordedAdapters {
  readonly operations: readonly RecordedOperation[];
  readonly availability?: readonly AdapterAvailability[];
  readonly classifications?: readonly Classification[];
}

/** One recorded tool call, re-issued during the replay so the call log is populated. */
export interface RecordedToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface RecordedDispatch {
  readonly file: string;
  /** As recorded, unvalidated: the kernel validates it. */
  readonly envelope: unknown;
  /**
   * The calls the recorded dispatch made.
   *
   * Re-issued through the tool invoker so that `coverage` and `artifacts_changed` are
   * reconciled against a real call log. Without them a replay could check everything about a
   * recorded envelope *except* the two claims the reconciliations exist for, and would report
   * every recorded run as having overstated its coverage.
   */
  readonly calls: readonly RecordedToolCall[];
}

export interface ReplayFixture {
  readonly directory: string;
  readonly intake: ReplayIntake;
  readonly context: ContextPackage | null;
  /** Dispatches in filename order. */
  readonly envelopes: readonly RecordedDispatch[];
  readonly adapters: RecordedAdapters;
  readonly skills: readonly SkillEntry[];
  readonly models: readonly ModelEntry[];
  readonly agents: readonly AgentSpecView[];
}

export class FixtureError extends Error {
  constructor(readonly directory: string, message: string) {
    super(`${directory}: ${message}`);
    this.name = 'FixtureError';
  }
}

function readJson(directory: string, file: string): unknown {
  const path = join(directory, file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new FixtureError(directory, `${file} could not be read`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new FixtureError(
      directory,
      `${file} is not valid JSON: ${error instanceof Error ? error.message : 'unparseable'}`,
    );
  }
}

function optionalJson(directory: string, file: string): unknown {
  return existsSync(join(directory, file)) ? readJson(directory, file) : null;
}

const INTAKE_SOURCES: readonly string[] = [
  'NATURAL_LANGUAGE', 'PROJECT_MANAGEMENT', 'VCS', 'DOCUMENT', 'EVENT', 'SCHEDULE',
  'RUNTIME_ALERT',
];

function readIntake(directory: string): ReplayIntake {
  const raw = readJson(directory, 'intake.json');
  if (raw === null || typeof raw !== 'object') {
    throw new FixtureError(directory, 'intake.json must be an object');
  }
  const record = raw as Record<string, unknown>;
  const source = record['source'];
  if (typeof source !== 'string' || !INTAKE_SOURCES.includes(source)) {
    throw new FixtureError(
      directory,
      `intake.json source must be one of ${INTAKE_SOURCES.join(', ')}`,
    );
  }
  const text = record['raw'];
  if (typeof text !== 'string' || text.length === 0) {
    throw new FixtureError(directory, 'intake.json raw must be a non-empty string');
  }
  const locator = readLocator(directory, record['source_locator']);

  const rereadRaw = record['reread'];
  let reread: ReplayIntake['reread'] = null;
  if (rereadRaw !== null && rereadRaw !== undefined) {
    if (typeof rereadRaw !== 'object') {
      throw new FixtureError(directory, 'intake.json reread must be an object or null');
    }
    const value = (rereadRaw as { raw?: unknown }).raw;
    if (typeof value !== 'string') {
      throw new FixtureError(directory, 'intake.json reread.raw must be a string');
    }
    reread = { raw: value };
  }

  return {
    source: source as IntakeSource,
    source_locator: locator,
    raw: text,
    reread,
    identity: readIdentity(directory, record['identity']),
  };
}

/**
 * A locator, checked structurally.
 *
 * `contracts/` publishes no standalone locator validator because a locator only ever appears
 * inside a document that has one. A fixture supplies it on its own, so the three fields are
 * checked here rather than assumed — an intake whose locator is malformed would otherwise
 * fail much later, during the source-drift check, with a much worse message.
 */
function readLocator(directory: string, raw: unknown): Locator {
  if (raw === null || typeof raw !== 'object') {
    throw new FixtureError(directory, 'intake.json source_locator must be an object');
  }
  const record = raw as Record<string, unknown>;
  const adapter = record['adapter'];
  const op = record['op'];
  const args = record['args'];
  if (typeof adapter !== 'string' || adapter.length === 0) {
    throw new FixtureError(directory, 'source_locator.adapter must be a non-empty string');
  }
  if (typeof op !== 'string' || op.length === 0) {
    throw new FixtureError(directory, 'source_locator.op must be a non-empty string');
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new FixtureError(directory, 'source_locator.args must be an object');
  }
  return { adapter, op, args: args as Readonly<Record<string, unknown>> };
}

function readIdentity(directory: string, raw: unknown): ReplayIntake['identity'] {
  if (raw === null || raw === undefined) return { outcome: 'NOT_NAMED' };
  if (typeof raw !== 'object') {
    throw new FixtureError(directory, 'intake.json identity must be an object or null');
  }
  const record = raw as Record<string, unknown>;
  const outcome = record['outcome'];
  const identity = record['identity'];
  switch (outcome) {
    case 'NOT_NAMED':
      return { outcome: 'NOT_NAMED' };
    case 'RESOLVED':
    case 'ABSENT':
      if (typeof identity !== 'string' || identity.length === 0) {
        throw new FixtureError(directory, `identity.${outcome} requires an identity string`);
      }
      return outcome === 'RESOLVED'
        ? { outcome: 'RESOLVED', identity }
        : { outcome: 'ABSENT', identity };
    case 'UNAVAILABLE': {
      if (typeof identity !== 'string' || identity.length === 0) {
        throw new FixtureError(directory, 'identity.UNAVAILABLE requires an identity string');
      }
      const detail = record['detail'];
      return {
        outcome: 'UNAVAILABLE',
        identity,
        detail: typeof detail === 'string' ? detail : 'the source was recorded as unreachable',
      };
    }
    default:
      throw new FixtureError(
        directory,
        'identity.outcome must be NOT_NAMED, RESOLVED, ABSENT or UNAVAILABLE',
      );
  }
}

function readEnvelopes(directory: string): readonly RecordedDispatch[] {
  const dir = join(directory, 'envelopes');
  if (!existsSync(dir)) throw new FixtureError(directory, 'envelopes/ is missing');
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.calls.json'))
    .sort();
  if (files.length === 0) throw new FixtureError(directory, 'envelopes/ contains no .json files');
  return files.map((file) => ({
    file,
    envelope: readJson(dir, file),
    calls: readCalls(directory, dir, `${file.slice(0, -'.json'.length)}.calls.json`),
  }));
}

function readCalls(
  directory: string,
  dir: string,
  file: string,
): readonly RecordedToolCall[] {
  if (!existsSync(join(dir, file))) return [];
  const raw = readJson(dir, file);
  if (!Array.isArray(raw)) {
    throw new FixtureError(directory, `envelopes/${file} must be an array of calls`);
  }
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new FixtureError(directory, `envelopes/${file}[${index}] must be an object`);
    }
    const call = entry as Record<string, unknown>;
    const tool = call['tool'];
    const args = call['args'] ?? {};
    if (typeof tool !== 'string' || tool.length === 0) {
      throw new FixtureError(directory, `envelopes/${file}[${index}].tool must be a tool name`);
    }
    if (typeof args !== 'object' || Array.isArray(args)) {
      throw new FixtureError(directory, `envelopes/${file}[${index}].args must be an object`);
    }
    return { tool, args: args as Readonly<Record<string, unknown>> };
  });
}

function readAdapters(directory: string): RecordedAdapters {
  const raw = optionalJson(directory, 'adapters.json');
  if (raw === null) return { operations: [] };
  if (typeof raw !== 'object') throw new FixtureError(directory, 'adapters.json must be an object');
  const record = raw as Record<string, unknown>;
  const operations = record['operations'];
  if (!Array.isArray(operations)) {
    throw new FixtureError(directory, 'adapters.json operations must be an array');
  }
  return {
    operations: operations.map((entry, index) => {
      if (entry === null || typeof entry !== 'object') {
        throw new FixtureError(directory, `adapters.json operations[${index}] must be an object`);
      }
      const op = entry as Record<string, unknown>;
      return {
        descriptor: validators.adapterOperationDescriptor.parse(
          op['descriptor'],
          `adapters.operations[${index}].descriptor`,
        ),
        ...(op['results'] === undefined
          ? {}
          : { results: op['results'] as Readonly<Record<string, unknown>> }),
        ...(op['replay'] === undefined
          ? {}
          : { replay: op['replay'] as RecordedOperation['replay'] }),
      };
    }),
    ...(record['availability'] === undefined
      ? {}
      : { availability: record['availability'] as readonly AdapterAvailability[] }),
    ...(record['classifications'] === undefined
      ? {}
      : { classifications: record['classifications'] as readonly Classification[] }),
  };
}

function readRegistries(
  directory: string,
): { readonly skills: readonly SkillEntry[]; readonly models: readonly ModelEntry[] } {
  const raw = optionalJson(directory, 'registries.json');
  if (raw === null) return { skills: [], models: [] };
  if (typeof raw !== 'object') {
    throw new FixtureError(directory, 'registries.json must be an object');
  }
  const record = raw as Record<string, unknown>;
  const skills = Array.isArray(record['skills']) ? record['skills'] : [];
  const models = Array.isArray(record['models']) ? record['models'] : [];
  return {
    skills: skills.map((entry, index) => validators.skillEntry.parse(entry, `skills[${index}]`)),
    models: models.map((entry, index) => validators.modelEntry.parse(entry, `models[${index}]`)),
  };
}

function readAgents(directory: string): readonly AgentSpecView[] {
  const raw = optionalJson(directory, 'agents.json');
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw new FixtureError(directory, 'agents.json must be an array');
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new FixtureError(directory, `agents.json[${index}] must be an object`);
    }
    return entry as AgentSpecView;
  });
}

function readContext(directory: string): ContextPackage | null {
  const raw = optionalJson(directory, 'context.json');
  if (raw === null) return null;
  return validators.contextPackage.parse(raw, 'context.json');
}

/** Loads a recorded run, refusing anything the contracts do not admit. */
export function loadFixture(directory: string): ReplayFixture {
  if (!existsSync(directory)) throw new FixtureError(directory, 'the directory does not exist');
  const registries = readRegistries(directory);
  return {
    directory,
    intake: readIntake(directory),
    context: readContext(directory),
    envelopes: readEnvelopes(directory),
    adapters: readAdapters(directory),
    skills: registries.skills,
    models: registries.models,
    agents: readAgents(directory),
  };
}

/** A canonical digest of call arguments, for keying recorded results. */
export function argsKey(args: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(args).sort();
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, args[key]])));
}

/** A call record, for a recorded call. */
export function recordedCall(
  callNumber: number,
  adapter: string,
  op: string,
  args: Readonly<Record<string, unknown>>,
  context: { readonly runId: string; readonly dispatchId: string | null },
  outcome: CallRecord['outcome'],
  at: string,
): CallRecord {
  return {
    call_id: `c_${String(callNumber).padStart(3, '0')}`,
    dispatch_id: context.dispatchId,
    adapter,
    op,
    args_digest: argsKey(args),
    paths_touched: typeof args['path'] === 'string' ? [args['path']] : [],
    capabilities_touched: [],
    outcome,
    refusal: null,
    aggregated_count: 1,
    started_at: at,
    duration_ms: 0,
  };
}
