import {
  validators,
  type ModelEntry,
  type SkillEntry,
  type ValidationError,
  type ValidationResult,
} from '@agentos/contracts';
import type { HostInventory } from '@agentos/adapters';

/**
 * What this host offers beyond the worktree: models, global skills, built-in tools.
 *
 * The host adapter enumerates and the registry ranks, and neither can reach a host's own
 * configuration — global skills live under the user's home directory, which the path deny
 * list refuses to open, deliberately, because that is where credentials are. So the
 * enumeration outside the worktree is something **the composition root supplies from
 * configuration**, and a build with none supplies none.
 *
 * None is the honest answer and it is also a consequential one: with no model declared,
 * nothing is selectable, every dispatch reports `NO_MODEL`, and the run blocks with
 * `EXTERNAL_DEPENDENCY` having advanced nothing. That is invariant 16 as the *default*
 * behaviour of an unconfigured host rather than as an edge case, and it is the right default:
 * a model catalogue compiled into the kernel would be a set of claims about the model market
 * that nobody re-checks, and the first thing it would do when it went stale is select a model
 * this host cannot reach and report the failure as the work's.
 *
 * Three environment variables, all optional, all read once at build time:
 *
 * - `AGENTOS_MODELS` — a JSON array of model entries. `id` is required; every other property
 *   defaults to `unknown` or `null`, which never satisfies a requirement, so an
 *   under-declared model is excluded rather than assumed adequate.
 * - `AGENTOS_SKILLS` — a JSON array of skill entries offered by the host rather than by the
 *   repository. Every undeclared flag takes the value that excludes.
 * - `AGENTOS_TOOLS` — a comma-separated list of the built-in tools the execution substrate
 *   exposes, for the tool-surface conformance check. Empty is correct for a substrate
 *   configured with an empty built-in tool set, which is what freeze D-2 requires.
 *
 * A variable that is present and malformed makes the corresponding enumeration **throw**,
 * not return empty. The host operation turns that into "models could not be enumerated",
 * which is a different fact from "this host has no models" and the only one that tells an
 * operator to go and fix something.
 */

export interface HostConfigurationProblem {
  readonly variable: string;
  readonly detail: string;
}

export interface HostConfiguration {
  readonly inventory: HostInventory;
  /** Everything wrong with the configuration, for the build report. Never silently dropped. */
  readonly problems: readonly HostConfigurationProblem[];
}

export const MODELS_VARIABLE = 'AGENTOS_MODELS';
export const SKILLS_VARIABLE = 'AGENTOS_SKILLS';
export const TOOLS_VARIABLE = 'AGENTOS_TOOLS';

/** An inventory that offers nothing, and says so rather than guessing. */
export const NOTHING_DECLARED: HostInventory = {
  skills: () => Promise.resolve([]),
  models: () => Promise.resolve([]),
  tools: () => Promise.resolve([]),
};

export function hostInventoryFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  now: string,
): HostConfiguration {
  const problems: HostConfigurationProblem[] = [];

  const models = parseEntries<ModelEntry>({
    variable: MODELS_VARIABLE,
    raw: env[MODELS_VARIABLE],
    complete: (entry) => completeModel(entry, now),
    check: (entry) => validators.modelEntry.check(entry),
    problems,
  });

  const skills = parseEntries<SkillEntry>({
    variable: SKILLS_VARIABLE,
    raw: env[SKILLS_VARIABLE],
    complete: (entry) => completeSkill(entry, now),
    check: (entry) => validators.skillEntry.check(entry),
    problems,
  });

  const declaredTools = env[TOOLS_VARIABLE];
  const tools = declaredTools === undefined
    ? []
    : declaredTools.split(',').map((name) => name.trim()).filter((name) => name.length > 0);

  return {
    inventory: {
      models: () => resolveOrReject(models),
      skills: () => resolveOrReject(skills),
      tools: () => Promise.resolve(tools),
    },
    problems,
  };
}

/* ---------------------------------------------------------------------- parsing -------- */

type Parsed<T> =
  | { readonly ok: true; readonly entries: readonly T[] }
  | { readonly ok: false; readonly detail: string };

function resolveOrReject<T>(parsed: Parsed<T>): Promise<readonly T[]> {
  return parsed.ok ? Promise.resolve(parsed.entries) : Promise.reject(new Error(parsed.detail));
}

function parseEntries<T>(input: {
  readonly variable: string;
  readonly raw: string | undefined;
  readonly complete: (entry: Readonly<Record<string, unknown>>) => unknown;
  readonly check: (entry: unknown) => ValidationResult;
  readonly problems: HostConfigurationProblem[];
}): Parsed<T> {
  if (input.raw === undefined || input.raw.trim().length === 0) {
    return { ok: true, entries: [] };
  }

  let value: unknown;
  try {
    value = JSON.parse(input.raw);
  } catch (error) {
    const detail = `${input.variable} is not valid JSON: ${messageOf(error)}`;
    input.problems.push({ variable: input.variable, detail });
    return { ok: false, detail };
  }

  if (!Array.isArray(value)) {
    const detail = `${input.variable} must be a JSON array, and is ${describe(value)}`;
    input.problems.push({ variable: input.variable, detail });
    return { ok: false, detail };
  }

  const entries: T[] = [];
  const rejected: string[] = [];
  for (const [index, raw] of value.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      rejected.push(`entry ${index} is ${describe(raw)} rather than an object`);
      continue;
    }
    const completed = input.complete(raw as Readonly<Record<string, unknown>>);
    const result = input.check(completed);
    if (!result.valid) {
      rejected.push(`entry ${index} does not satisfy its contract: ${format(result.errors)}`);
      continue;
    }
    entries.push(completed as T);
  }

  if (rejected.length > 0) {
    /*
     * A declaration that cannot be represented is not an unreachable entry, which would be
     * enumerated `UNAVAILABLE` and kept. It is a broken configuration, and the whole variable
     * is reported unenumerable rather than silently short: an operator who declared four
     * models and got two would have no way to know which two.
     */
    const detail = `${input.variable}: ${rejected.join('; ')}`;
    input.problems.push({ variable: input.variable, detail });
    return { ok: false, detail };
  }

  return { ok: true, entries };
}

/* ------------------------------------------------------------------ completions -------- */

/**
 * Fills a partial model declaration.
 *
 * Every default is the value that *fails* a requirement: unknown reasoning does not satisfy
 * deep reasoning, an unknown context window is not assumed to be large enough, and an unknown
 * precision class does not satisfy a high-precision dispatch. So the effect of declaring a
 * model without its properties is that no dispatch selects it and every dispatch says why.
 */
function completeModel(entry: Readonly<Record<string, unknown>>, now: string): unknown {
  return {
    context_window: null,
    reasoning: 'unknown',
    coding: 'unknown',
    vision: 'unknown',
    tool_use: 'unknown',
    usd_per_mtok_input: null,
    usd_per_mtok_output: null,
    latency_class: 'unknown',
    precision_class: 'unknown',
    ...entry,
    /*
     * A declared model is one the host says it offers, which is what `AVAILABLE` means for an
     * enumeration. It is not a demonstration of reach: reach is demonstrated by a dispatch,
     * and a dispatch that cannot reach the model fails with `NO_MODEL` and blocks the run. An
     * operator who knows a model is configured and unreachable says so by declaring its
     * availability explicitly, and it is then enumerated and excluded rather than omitted.
     */
    availability: {
      adapter: 'host.models',
      state: 'AVAILABLE',
      detail: `declared in ${MODELS_VARIABLE}`,
      checked_at: now,
      ...asRecord(entry['availability']),
    },
  };
}

/** Fills a partial skill declaration. Every undeclared flag takes the value that excludes. */
function completeSkill(entry: Readonly<Record<string, unknown>>, now: string): unknown {
  const declaresSpawning = typeof entry['spawns_agents'] === 'boolean';
  return {
    source: 'plugin',
    description: `host skill ${typeof entry['id'] === 'string' ? entry['id'] : '(unnamed)'}`,
    declared_inputs: [],
    declared_outputs: [],
    reversal: null,
    domains: [],
    operations: [],
    targets: [],
    observed_success_rate: null,
    cost_hint: 'unknown',
    ...entry,
    /*
     * Three flags fail closed whatever the declaration omitted, and `spawns_agents` is the one
     * that matters most: a skill whose spawning behaviour was never determined is treated as
     * spawning and excluded from every candidate list, because on some substrates a subagent
     * tool is the ordinary way to work and invariant W5 is one tool call away.
     */
    mutating: entry['mutating'] === false ? false : true,
    spawns_agents: declaresSpawning ? entry['spawns_agents'] === true : true,
    spawns_agents_determined: declaresSpawning,
    external_destination: entry['external_destination'] === false ? false : true,
    availability: {
      adapter: 'host.skills',
      state: 'AVAILABLE',
      detail: `declared in ${SKILLS_VARIABLE}`,
      checked_at: now,
      ...asRecord(entry['availability']),
    },
  };
}

/* ---------------------------------------------------------------------- helpers -------- */

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function format(errors: readonly ValidationError[]): string {
  return errors
    .map((error) => `${error.instancePath === '' ? '(root)' : error.instancePath}: ${error.message}`)
    .join(', ');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
