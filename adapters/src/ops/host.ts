import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { EOL, homedir, platform, tmpdir, type } from 'node:os';
import { sep, join } from 'node:path';
import { sha256 } from '@agentos/contracts';
import type {
  AdapterAvailability,
  HostIdentity,
  IntakeRecord,
  IntakeSource,
  ModelEntry,
  SkillEntry,
  TrustClass,
} from '@agentos/contracts';
import { fact, selfEvidence, unavailable, unknown } from '../assertions.js';
import { OPTIONAL_STRING_ARG, STRING_ARG, readOnlyOperation } from '../define.js';
import type { OperationRegistration } from '../descriptors.js';
import { messageOf } from '../errors.js';
import { toPosix } from '../glob.js';
import type { AvailabilityProbe, RunLedgerReader } from '../ports.js';
import type { ClassificationObservation, ClassificationProbe } from '../classification.js';

/**
 * The host adapter: who invoked AgentOS, on what, with what available.
 *
 * It owns three things nothing else may:
 *
 * - **Identity.** `principal` and `trust_class` come from *authenticated context* and never
 *   from content (freeze D-5). The CLI host asserts the authenticated OS user and
 *   `OPERATOR`; every other source is `EXTERNAL` until a host exists that can assert a
 *   principal for it. A webhook body cannot promote itself, and neither can a ticket.
 * - **Enumeration.** Skills, tools and models, *including those configured but unreachable*,
 *   which are recorded `UNAVAILABLE` and never omitted: "this host has no project-management
 *   access" and "it is configured and the server failed to connect" lead to different
 *   decisions, and the second is worth telling a human about.
 * - **Platform differences.** Separator, line ending, case sensitivity, shell. No platform
 *   assumption belongs in the kernel or in an agent, so this is where they live.
 *
 * A skill whose spawning behaviour cannot be determined is `spawns_agents: true` and is
 * excluded from every candidate list. That is not caution about a hypothetical: on some
 * execution substrates a subagent tool is the default way to work, and a skill that spawns
 * one is invariant W5's violation wearing a tool's clothing.
 */

export interface HostInventory {
  /** Global, plugin, connector, MCP and built-in skills, which live outside the worktree. */
  skills(): Promise<readonly SkillEntry[]>;
  models(): Promise<readonly ModelEntry[]>;
  tools(): Promise<readonly string[]>;
}

/**
 * The default inventory: nothing, honestly.
 *
 * Global skills live under the user's home configuration, which the deny-list refuses to
 * open — deliberately, since that is where credentials are. So what exists outside the
 * worktree is something the composition root supplies from its own configuration, and a
 * framework with none reports none rather than guessing.
 */
export const EMPTY_HOST_INVENTORY: HostInventory = {
  skills(): Promise<readonly SkillEntry[]> {
    return Promise.resolve([]);
  },
  models(): Promise<readonly ModelEntry[]> {
    return Promise.resolve([]);
  },
  tools(): Promise<readonly string[]> {
    return Promise.resolve([]);
  },
};

export interface CliIntake {
  readonly source: IntakeSource;
  readonly raw: string;
  readonly received_at: string;
  readonly correlation?: {
    readonly prior_work_item: string | null;
    readonly prior_run: string | null;
  };
}

export interface HostOptions {
  /** The host identifier. `host.cli` is the only one that can assert a principal today. */
  readonly host: string;
  readonly worktreeRoot: string;
  /** The authenticated OS user, where the host can assert one. */
  readonly principalId: string | null;
  readonly inventory?: HostInventory;
  /** What the operator typed, where this invocation came from the command line. */
  readonly intake?: CliIntake | null;
  /**
   * Read-only access to AgentOS's own run ledger, supplied by the composition root.
   *
   * `state/` is the kernel's to write and neither this package nor `discovery/` may reach it,
   * so the ledger arrives as a port and leaves as an ordinary observation with a replayable
   * locator. Absent, the two operations that read it report `UNAVAILABLE`.
   */
  readonly ledger?: RunLedgerReader | null;
}

const ADAPTER = 'host';
const CLI_HOST = 'host.cli';
/** Built rather than typed, so no tool rewrites the separator inside an excerpt. */
const NEWLINE = String.fromCharCode(10);

/**
 * Enumerates the entries of one or more sources, keeping the unreachable ones.
 *
 * "An unreachable connector is recorded UNAVAILABLE, never omitted" is a rule about this
 * function: a filter here would erase the difference between a host that has no such server
 * and a host whose server refused, and those lead to different decisions.
 */
async function enumerateSource(
  inventory: HostInventory,
  op: string,
  sources: readonly SkillEntry['source'][],
  at: string,
): Promise<{ value: unknown; excerpt: string }> {
  let entries: readonly SkillEntry[] = [];
  let detail = 'the host inventory answered';
  try {
    entries = (await inventory.skills()).filter((entry) => sources.includes(entry.source));
  } catch (error) {
    detail = `the host inventory could not be enumerated: ${messageOf(error)}`;
  }
  return {
    value: { op, entries, enumerated_at: at, detail },
    excerpt: entries
      .map((entry) => `${entry.id} ${entry.availability.state}`)
      .join(NEWLINE),
  };
}

/** Freeze D-5, as a function. A host that cannot assert a principal classifies EXTERNAL. */
export function hostIdentity(options: HostOptions): HostIdentity {
  if (options.host === CLI_HOST && options.principalId !== null && options.principalId.length > 0) {
    return {
      host: options.host,
      principal: { id: options.principalId, asserted_by: options.host },
      trustClass: 'OPERATOR',
    };
  }
  return { host: options.host, principal: null, trustClass: 'EXTERNAL' };
}

export function hostOperations(options: HostOptions): readonly OperationRegistration[] {
  const inventory = options.inventory ?? EMPTY_HOST_INVENTORY;

  return [
    readOnlyOperation({
      adapter: ADAPTER,
      op: 'identity',
      description:
        'Who invoked AgentOS, and how far that assertion goes. The trust class comes from '
        + 'authenticated context and never from content.',
      evidenceKind: 'command',
      observationSafe: true,
      handler: (invocation) => {
        const identity = hostIdentity(options);
        return Promise.resolve({
          value: {
            ...identity,
            rule:
              'the CLI host asserts the authenticated OS user and OPERATOR. Every other '
              + 'source is EXTERNAL until a host exists that can assert a principal for it',
            observed_at: invocation.now.toISOString(),
          },
          excerpt: `${identity.host} ${identity.trustClass} ${identity.principal?.id ?? '(none)'}`,
        });
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'platform',
      description:
        'Platform differences the kernel and agents must not assume: separator, line ending, '
        + 'case sensitivity, temp root.',
      evidenceKind: 'command',
      observationSafe: true,
      handler: (invocation) => {
        const at = invocation.now.toISOString();
        const os = platform();
        /*
         * One piece of evidence for the whole set: re-running `host.platform` re-observes
         * every field of it, which is exactly what a locator is for.
         */
        const evidence = selfEvidence({
          adapter: ADAPTER,
          op: 'platform',
          args: {},
          kind: 'command',
          ref: 'host.platform',
          excerpt: `${os} ${type()} ${sep} ${EOL === '\r\n' ? 'crlf' : 'lf'}`,
          observedAt: at,
        });
        const value = {
          platform: fact(os, 'host.platform', at, evidence),
          kernel: fact(type(), 'host.platform', at, evidence),
          path_separator: fact(sep, 'host.platform', at, evidence),
          line_ending: fact(EOL === '\r\n' ? 'crlf' : 'lf', 'host.platform', at, evidence),
          /*
           * Case sensitivity is a property of the *filesystem*, not of the platform, and the
           * cheap platform test is wrong on a case-sensitive volume mounted on macOS. Where
           * it cannot be established it is reported unknown, and path confinement is written
           * so that being wrong about it refuses rather than admits.
           */
          case_sensitive_paths: os === 'linux'
            ? fact(true, 'host.platform', at, evidence)
            : unknown(
              'host.platform', at, 'UNKNOWN',
              'probe the actual volume the worktree sits on. Path confinement matches its '
              + 'allow-list case-sensitively and its deny-list case-insensitively, so an '
              + 'unknown answer refuses rather than admits either way',
            ),
          temp_root: fact(toPosix(tmpdir()), 'host.platform', at, evidence),
        };
        return Promise.resolve({ value, excerpt: `${os} ${sep} ${EOL === '\r\n' ? 'crlf' : 'lf'}` });
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'list_skills',
      description:
        'Every invocable capability this host offers, including connectors configured but '
        + 'unreachable, which are recorded UNAVAILABLE and never omitted.',
      evidenceKind: 'command',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const repository = repositorySkills(options.worktreeRoot, at);
        let external: readonly SkillEntry[] = [];
        let detail = 'the host inventory answered';
        try {
          external = await inventory.skills();
        } catch (error) {
          detail = `the host inventory could not be enumerated: ${messageOf(error)}`;
        }
        const entries = [...external, ...repository]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return {
          value: { entries, enumerated_at: at, detail },
          excerpt: entries.map((entry) => `${entry.id} ${entry.source} spawns=${entry.spawns_agents}`)
            .join('\n'),
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'list_models',
      description:
        'Reachable models with what is knowable about each. An unknowable property is null '
        + 'and selection degrades rather than assuming the best case.',
      evidenceKind: 'command',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        try {
          const entries = await inventory.models();
          return {
            value: { entries, enumerated_at: at },
            excerpt: entries.map((entry) => `${entry.id} ${entry.availability.state}`).join('\n'),
          };
        } catch (error) {
          /*
           * No model reachable is an ordinary, expected condition and not an exception. The
           * enumeration says so; the kernel then blocks with EXTERNAL_DEPENDENCY, advancing
           * nothing.
           */
          return {
            value: {
              entries: [],
              enumerated_at: at,
              detail:
                `models could not be enumerated: ${messageOf(error)}. Model unavailability is `
                + 'ordinary: every kernel function still runs and the run blocks rather than '
                + 'advancing on a model it does not have',
            },
            excerpt: 'models: unavailable',
          };
        }
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'list_tools',
      description: 'The built-in tools the execution substrate exposes, for the conformance check.',
      evidenceKind: 'command',
      observationSafe: true,
      handler: async (invocation) => {
        try {
          const tools = await inventory.tools();
          return { value: { tools }, excerpt: tools.join('\n') };
        } catch (error) {
          return {
            value: {
              tools: [],
              detail:
                `the built-in tool set could not be enumerated: ${messageOf(error)}. A tool `
                + 'surface that cannot be enumerated is unverifiable, and an unverifiable '
                + 'surface fails the conformance check rather than passing it',
              verifiable: false,
              observed_at: invocation.now.toISOString(),
            },
            excerpt: 'tools: unverifiable',
          };
        }
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'list_plugins',
      description:
        'Plugins this host offers, including any that are configured and unreachable.',
      evidenceKind: 'command',
      observationSafe: true,
      handler: async (invocation) => enumerateSource(
        inventory, 'list_plugins', ['plugin'], invocation.now.toISOString(),
      ),
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'list_mcp_servers',
      description:
        'Connectors and MCP servers, including those configured but unreachable, which are '
        + 'recorded UNAVAILABLE and never omitted.',
      evidenceKind: 'command',
      observationSafe: true,
      handler: async (invocation) => enumerateSource(
        inventory, 'list_mcp_servers', ['mcp', 'connector'], invocation.now.toISOString(),
      ),
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'read_run_history',
      description:
        "Prior AgentOS runs against one work item, from AgentOS's own ledger. The only "
        + 'honest observation that an analysis stage actually ran.',
      args: { work_item_id: STRING_ARG },
      required: ['work_item_id'],
      evidenceKind: 'document',
      observationSafe: true,
      handler: (invocation) => {
        const at = invocation.now.toISOString();
        const workItemId = String(invocation.args['work_item_id']);
        const ledger = options.ledger ?? null;
        if (ledger === null) {
          /*
           * No reader, so nothing was observed. Reporting an empty history here would read as
           * "no prior run", and a resumed run would re-enter at AUDIT and redo analysis it had
           * already done — the exact failure amendment A-15 exists to prevent. UNAVAILABLE is
           * the only honest answer, and it is a different one from "there were none".
           */
          return Promise.resolve({
            value: unknown(
              'host.read_run_history', at, 'UNAVAILABLE',
              "wire AgentOS's run ledger into the adapter framework. Until then whether a "
              + 'stage completed in a previous run is unknown, and an unknown is not the same '
              + 'as a no',
              'no run-ledger reader is available to this adapter framework',
            ),
            excerpt: 'run history: unavailable',
          });
        }

        let runs;
        try {
          runs = ledger.runs(workItemId);
        } catch (error) {
          return Promise.resolve({
            value: unavailable(
              'host.read_run_history', at,
              "restore access to AgentOS's own state directory",
              messageOf(error),
            ),
            excerpt: 'run history: unavailable',
          });
        }

        const stagesCompleted = [...new Set(runs.flatMap((run) => run.stages_completed))].sort();
        const value = { work_item_id: workItemId, runs, stages_completed: stagesCompleted };
        const excerpt = runs
          .map((run) => `${run.run_id} ${run.outcome ?? 'RUNNING'} [${run.stages_completed.join(' ')}]`)
          .join(NEWLINE);
        return Promise.resolve({
          value: fact(value, 'host.read_run_history', at, selfEvidence({
            adapter: ADAPTER,
            op: 'read_run_history',
            args: { work_item_id: workItemId },
            kind: 'document',
            ref: `AgentOS run ledger for ${workItemId}`,
            excerpt,
            observedAt: at,
          })),
          excerpt,
        });
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'read_child_work_items',
      description:
        'Child work items AgentOS itself recorded, with their lifecycle states. Unioned by '
        + "discovery with the project-management system's own children.",
      args: { work_item_id: STRING_ARG },
      required: ['work_item_id'],
      evidenceKind: 'document',
      observationSafe: true,
      handler: (invocation) => {
        const at = invocation.now.toISOString();
        const workItemId = String(invocation.args['work_item_id']);
        const ledger = options.ledger ?? null;
        if (ledger === null) {
          return Promise.resolve({
            value: unknown(
              'host.read_child_work_items', at, 'UNAVAILABLE',
              "wire AgentOS's run ledger into the adapter framework. An empty list would read "
              + 'as "this work item has no children", which is a different claim from "we '
              + 'could not look"',
              'no run-ledger reader is available to this adapter framework',
            ),
            excerpt: 'child work items: unavailable',
          });
        }

        let children;
        try {
          children = ledger.children(workItemId);
        } catch (error) {
          return Promise.resolve({
            value: unavailable(
              'host.read_child_work_items', at,
              "restore access to AgentOS's own state directory",
              messageOf(error),
            ),
            excerpt: 'child work items: unavailable',
          });
        }

        const excerpt = children
          .map((child) => `${child.work_item_id} ${child.type} ${child.lifecycle}`)
          .join(NEWLINE);
        return Promise.resolve({
          value: fact(
            { work_item_id: workItemId, children },
            'host.read_child_work_items', at,
            selfEvidence({
              adapter: ADAPTER,
              op: 'read_child_work_items',
              args: { work_item_id: workItemId },
              kind: 'document',
              ref: `AgentOS child work items of ${workItemId}`,
              excerpt,
              observedAt: at,
            }),
          ),
          excerpt,
        });
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'read_intake',
      description:
        'The invocation that started this run, normalized into an IntakeRecord with a '
        + 're-executable locator and a content hash.',
      args: { intake_id: OPTIONAL_STRING_ARG },
      evidenceKind: 'command',
      observationSafe: true,
      handler: (invocation) => {
        const intake = options.intake ?? null;
        if (intake === null) {
          return Promise.resolve({
            value: unknown(
              'host.read_intake', invocation.now.toISOString(), 'NOT_APPLICABLE',
              'invoke AgentOS through a host that carries an intake. This framework was built '
              + 'without one, so there is nothing to normalize',
            ),
            excerpt: 'intake: none',
          });
        }
        const identity = hostIdentity(options);
        const id = typeof invocation.args['intake_id'] === 'string'
          && invocation.args['intake_id'].length > 0
          ? invocation.args['intake_id']
          : `intake_${sha256(intake.raw + intake.received_at).slice(0, 12)}`;
        const record: IntakeRecord = {
          intake_id: id,
          received_at: intake.received_at,
          source: intake.source,
          source_locator: { adapter: ADAPTER, op: 'read_intake', args: { intake_id: id } },
          /*
           * A host that cannot assert a principal still has to name one, and naming the host
           * itself is the honest form: the record then says the identity is the host's own
           * and the EXTERNAL trust class says how far that goes.
           */
          principal: identity.principal ?? { id: options.host, asserted_by: options.host },
          trust_class: identity.trustClass satisfies TrustClass,
          raw: intake.raw,
          content_hash: sha256(intake.raw),
          attachments: [],
          correlation: intake.correlation
            ?? { prior_work_item: null, prior_run: null },
        };
        return Promise.resolve({
          value: record,
          excerpt: record.raw,
          externalLocator: record.source_locator,
        });
      },
    }),
  ];
}

/** The host adapter is available whenever AgentOS is running, because it is the host. */
export function hostAvailability(options: HostOptions): AvailabilityProbe {
  return {
    adapter: ADAPTER,
    probe(): Promise<Omit<AdapterAvailability, 'checked_at'>> {
      const identity = hostIdentity(options);
      return Promise.resolve({
        adapter: ADAPTER,
        state: 'AVAILABLE',
        detail:
          `${identity.host}, trust class ${identity.trustClass}`
          + (identity.principal === null
            ? '. This host cannot assert a principal, so its intake classifies EXTERNAL'
            : `, principal asserted as ${identity.principal.id}`)
          + (options.ledger === undefined || options.ledger === null
            ? ". No run ledger is wired in, so AgentOS's own history of this work item is "
              + 'UNAVAILABLE rather than empty'
            : ''),
      });
    },
  };
}

/**
 * The spawning classifier, over the enumerated skills.
 *
 * `spawns_agents` is the one classification whose subject is a skill rather than a branch or
 * an environment, and it fails closed the same way: a skill whose behaviour was never
 * determined is treated as spawning, which excludes it. Three layers guard this — policy,
 * the registry's candidate list and the host's own refusal — because it is substrate-
 * dependent and easy to reintroduce by accident.
 */
export function spawningProbe(options: HostOptions): ClassificationProbe {
  const inventory = options.inventory ?? EMPTY_HOST_INVENTORY;
  return {
    kind: 'spawns_agents',
    async probe(subject: string): Promise<ClassificationObservation> {
      const repository = repositorySkills(options.worktreeRoot, new Date(0).toISOString());
      let external: readonly SkillEntry[] = [];
      try {
        external = await inventory.skills();
      } catch {
        external = [];
      }
      const entry = [...external, ...repository].find((candidate) => candidate.id === subject);
      if (entry === undefined) {
        return {
          established: false,
          detail: `no enumerated skill is named ${subject}`,
        };
      }
      if (!entry.spawns_agents_determined) {
        return {
          established: false,
          detail:
            `${subject} does not declare whether it can start another agent, session, `
            + 'subagent or task',
        };
      }
      return {
        established: true,
        dangerous: entry.spawns_agents,
        confidence: 'FACT',
        detail: `${subject} declares spawns_agents: ${String(entry.spawns_agents)}`,
      };
    },
  };
}

/* ---------------------------------------------------------------------- helpers ------ */

function availability(state: AdapterAvailability['state'], detail: string, at: string): AdapterAvailability {
  return { adapter: ADAPTER, state, detail, checked_at: at };
}

function undeclaredSkill(
  id: string,
  source: SkillEntry['source'],
  description: string,
  at: string,
): SkillEntry {
  return {
    id,
    source,
    description,
    declared_inputs: [],
    declared_outputs: [],
    availability: availability('AVAILABLE', 'discovered in the worktree', at),
    /* Undeclared, so every flag takes the branch that excludes rather than admits. */
    mutating: true,
    spawns_agents: true,
    spawns_agents_determined: false,
    external_destination: true,
    reversal: null,
    domains: [],
    operations: [],
    targets: [],
    observed_success_rate: null,
    cost_hint: 'unknown',
  };
}

/**
 * Skills the repository itself offers.
 *
 * Two kinds, and the difference between them is the whole point. A skill declared in
 * `.agent/skills/*.json` states its own flags and can therefore be selectable. Anything
 * merely *found* — a package script, a Makefile target, a shell script — declares nothing, so
 * every flag fails closed and the entry is enumerated but never a candidate. That is not the
 * enumeration being useless: a repository that wants its scripts used declares them, and
 * until it does, "we did not know what this would do" is the honest reason not to run it.
 */
export function repositorySkills(worktreeRoot: string, at: string): readonly SkillEntry[] {
  const entries: SkillEntry[] = [];

  const declaredDirectory = join(worktreeRoot, '.agent', 'skills');
  if (existsSync(declaredDirectory)) {
    let names: readonly string[] = [];
    try {
      names = readdirSync(declaredDirectory).filter((name) => name.endsWith('.json')).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      const declared = readDeclaredSkill(join(declaredDirectory, name), at);
      if (declared !== null) entries.push(declared);
    }
  }

  const manifest = join(worktreeRoot, 'package.json');
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> };
      for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
        entries.push(undeclaredSkill(
          `script:${name}`, 'script',
          `package script "${name}": ${command}`,
          at,
        ));
      }
    } catch {
      /* An unparseable manifest yields no scripts. Nothing is invented from a broken file. */
    }
  }

  for (const file of ['Makefile', 'makefile', 'GNUmakefile']) {
    const path = join(worktreeRoot, file);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, 'utf8');
      for (const line of text.split('\n')) {
        const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line);
        if (match?.[1] !== undefined) {
          entries.push(undeclaredSkill(
            `make:${match[1]}`, 'script', `Makefile target "${match[1]}"`, at,
          ));
        }
      }
    } catch {
      /* Unreadable: contributes nothing. */
    }
  }

  return entries;
}

function readDeclaredSkill(path: string, at: string): SkillEntry | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const id = typeof parsed['id'] === 'string' && parsed['id'].length > 0 ? parsed['id'] : null;
  if (id === null) return null;
  const declaredSpawning = typeof parsed['spawns_agents'] === 'boolean';
  return {
    id,
    source: 'repository',
    description: typeof parsed['description'] === 'string' && parsed['description'].length > 0
      ? parsed['description']
      : `repository skill ${id}`,
    declared_inputs: stringArray(parsed['declared_inputs']),
    declared_outputs: stringArray(parsed['declared_outputs']),
    availability: availability('AVAILABLE', `declared in ${toPosix(path)}`, at),
    mutating: parsed['mutating'] === false ? false : true,
    spawns_agents: declaredSpawning ? parsed['spawns_agents'] === true : true,
    spawns_agents_determined: declaredSpawning,
    external_destination: parsed['external_destination'] === false ? false : true,
    reversal: typeof parsed['reversal'] === 'string' && parsed['reversal'].length > 0
      ? parsed['reversal']
      : null,
    domains: enumArray(parsed['domains'], [
      'repository_analysis', 'git', 'database', 'api', 'ui', 'testing', 'deployment',
      'project_management', 'documentation',
    ]) as SkillEntry['domains'],
    operations: enumArray(parsed['operations'], [
      'read', 'analyse', 'generate', 'mutate', 'verify',
    ]) as SkillEntry['operations'],
    targets: enumArray(parsed['targets'], [
      'filesystem', 'vcs', 'data_store', 'network', 'runtime',
    ]) as SkillEntry['targets'],
    observed_success_rate: typeof parsed['observed_success_rate'] === 'number'
      ? parsed['observed_success_rate']
      : null,
    cost_hint: isCostHint(parsed['cost_hint']) ? parsed['cost_hint'] : 'unknown',
  };
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function enumArray(value: unknown, permitted: readonly string[]): readonly string[] {
  return stringArray(value).filter((entry) => permitted.includes(entry));
}

function isCostHint(value: unknown): value is SkillEntry['cost_hint'] {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'unknown';
}

/** The home directory, exposed so the composition root need not import `node:os` itself. */
export function hostHome(): string {
  return homedir();
}

/** The `STRING_ARG` re-export keeps the schema fragments in one place for host callers. */
export { STRING_ARG };
