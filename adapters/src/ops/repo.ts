import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AdapterAvailability, Assertion, Evidence, EvidenceKind, PathPolicy } from '@agentos/contracts';
import { fact, inference, selfEvidence, unknown } from '../assertions.js';
import { PATH_ARG, STRING_ARG, INTEGER_ARG, readOnlyOperation } from '../define.js';
import type { OperationInvocation, OperationRegistration, OperationResult } from '../descriptors.js';
import { ConfinementAbort } from '../framework.js';
import { matchesAny, matchesGlob, toPosix } from '../glob.js';
import { ResourceAbsentError } from '../errors.js';
import type { AvailabilityProbe } from '../ports.js';

/**
 * The repository adapter: how AgentOS attaches to an arbitrary repository.
 *
 * The governing constraint is REPOSITORY_ADAPTER's own: **a repository with no
 * AgentOS-specific files must work fully.** `.agent/` is an optimization and a place to
 * record human decisions, never a prerequisite, so every operation here works without it and
 * `read_agent_directory` reports its absence as an ordinary observation rather than as a gap.
 *
 * Every output is an assertion with a confidence class. Detection from a manifest is an
 * `INFERENCE`; the presence of a file is a `FACT`; and the two determinations that gate
 * everything dangerous — branch protection and environment classification — fail closed,
 * which is why `boundaries` reports `PROTECTED` and `PRODUCTION` when it cannot establish
 * otherwise instead of reporting that it did not know.
 */

export interface RepoOptions {
  readonly worktreeRoot: string;
  readonly paths: PathPolicy;
  /** How many entries a single enumeration may return before it says it truncated. */
  readonly enumerationLimit?: number;
}

const ADAPTER = 'repo';
const DEFAULT_LIMIT = 2000;
/** Built rather than typed, so no tool rewrites the separator inside an excerpt. */
const NEWLINE = String.fromCharCode(10);

/** Manifests, and what each implies. Read from the repository, never from a name. */
const MANIFESTS: ReadonlyArray<{
  readonly file: string;
  readonly ecosystem: string;
  readonly packageManagers: readonly string[];
}> = [
  { file: 'package.json', ecosystem: 'node', packageManagers: ['npm', 'yarn', 'pnpm'] },
  { file: 'pyproject.toml', ecosystem: 'python', packageManagers: ['pip', 'poetry', 'uv'] },
  { file: 'requirements.txt', ecosystem: 'python', packageManagers: ['pip'] },
  { file: 'Cargo.toml', ecosystem: 'rust', packageManagers: ['cargo'] },
  { file: 'go.mod', ecosystem: 'go', packageManagers: ['go'] },
  { file: 'pom.xml', ecosystem: 'jvm', packageManagers: ['maven'] },
  { file: 'build.gradle', ecosystem: 'jvm', packageManagers: ['gradle'] },
  { file: 'build.gradle.kts', ecosystem: 'jvm', packageManagers: ['gradle'] },
  { file: 'Gemfile', ecosystem: 'ruby', packageManagers: ['bundler'] },
  { file: 'composer.json', ecosystem: 'php', packageManagers: ['composer'] },
  { file: 'CMakeLists.txt', ecosystem: 'c-family', packageManagers: ['cmake'] },
];

const CI_DEFINITIONS: readonly string[] = [
  '.github/workflows',
  '.gitlab-ci.yml',
  'azure-pipelines.yml',
  'Jenkinsfile',
  '.circleci/config.yml',
  'bitbucket-pipelines.yml',
  '.drone.yml',
];

const CONTAINER_DEFINITIONS: readonly string[] = [
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'Containerfile',
];

const SOURCE_DIRECTORIES: readonly string[] = ['src', 'lib', 'app', 'source', 'internal', 'pkg'];
const TEST_DIRECTORIES: readonly string[] = ['test', 'tests', 'spec', '__tests__', 'e2e'];
const DOC_DIRECTORIES: readonly string[] = ['docs', 'doc', 'documentation'];
const CONFIG_HINTS: readonly string[] = [
  'config', 'conf', 'settings', '.config', 'appsettings.json', 'tsconfig.json',
];

export function repositoryOperations(options: RepoOptions): readonly OperationRegistration[] {
  const root = options.worktreeRoot;
  const limit = options.enumerationLimit ?? DEFAULT_LIMIT;
  const scratch = options.paths.scratch_roots;

  /** Resolves a path argument the framework already confined, or confines it now. */
  const resolveArg = (invocation: OperationInvocation, name: string): string => {
    const already = invocation.paths.get(name);
    if (already !== undefined) return already.resolved;
    const verdict = invocation.confine(invocation.args[name]);
    if (verdict.outcome === 'REFUSED') throw new ConfinementAbort(verdict);
    return verdict.resolved;
  };

  /**
   * Enumerates a subtree, skipping the scratch roots.
   *
   * Skipping them here is the one thing `paths.json`'s `scratch_roots` is used for at
   * enumeration time, and it is a *narrowing*: a build cache is not part of the repository's
   * source and walking it turns a discovery pass into a directory crawl. It never widens
   * confinement — a path inside a scratch root that is asked for by name is confined exactly
   * as any other path is.
   */
  const walk = (from: string, maxDepth: number): { entries: string[]; truncated: boolean } => {
    const entries: string[] = [];
    let truncated = false;
    const visit = (directory: string, depth: number): void => {
      if (truncated || depth > maxDepth) return;
      let names: string[];
      try {
        names = readdirSync(directory).sort();
      } catch {
        /* A directory that cannot be read is reported by its absence from the listing, and
         * the caller's `truncated`/`unreadable` flags say the listing is not exhaustive. */
        truncated = true;
        return;
      }
      for (const name of names) {
        const full = join(directory, name);
        const rel = toPosix(relative(root, full));
        if (matchesAny(rel, scratch, false)) continue;
        if (entries.length >= limit) {
          truncated = true;
          return;
        }
        entries.push(rel);
        let isDirectory = false;
        try {
          isDirectory = lstatSync(full).isDirectory();
        } catch {
          continue;
        }
        if (isDirectory) visit(full, depth + 1);
      }
    };
    visit(from, 0);
    return { entries, truncated };
  };

  const exists = (relativePath: string): boolean => existsSync(join(root, relativePath));

  /**
   * Evidence for something this adapter just observed: the locator that observes it again.
   *
   * Every FACT below carries one. That is the contract's rule — a FACT with no evidence is an
   * INFERENCE that has not admitted it — and it is also what makes the attachment sequence
   * checkable: the kernel can re-execute `repo.stat_path` against `.git` and see for itself.
   */
  const ev = (
    op: string,
    args: Readonly<Record<string, unknown>>,
    kind: EvidenceKind,
    ref: string,
    excerpt: string,
    at: string,
  ): Evidence => selfEvidence({ adapter: ADAPTER, op, args, kind, ref, excerpt, observedAt: at });

  const attach = (at: string): Readonly<Record<string, Assertion>> => {
    const probe = 'repo.attach';

    /* 1. Identify. What the filesystem itself can settle. */
    const hasGit = exists('.git');
    const head = hasGit ? readIfPresent(join(root, '.git', 'HEAD')) : null;
    const branch = head === null ? null : parseHead(head);

    /* 2. Detect. From manifests and layout, never from a name. */
    const manifests = MANIFESTS.filter((entry) => exists(entry.file));
    const ci = CI_DEFINITIONS.filter((entry) => exists(entry));
    const containers = CONTAINER_DEFINITIONS.filter((entry) => exists(entry));

    /* 3. Map. */
    const sources = SOURCE_DIRECTORIES.filter((entry) => exists(entry));
    const tests = TEST_DIRECTORIES.filter((entry) => exists(entry));

    /* 4. Locate. */
    const docs = DOC_DIRECTORIES.filter((entry) => exists(entry));
    const configs = CONFIG_HINTS.filter((entry) => exists(entry));

    /* 6. `.agent/`, as a claim and never as a prerequisite. */
    const agentDirectory = exists('.agent');

    const listing = ev(
      'list_paths', { path: '.' }, 'file', 'the worktree root listing',
      [...manifests.map((m) => m.file), ...ci, ...containers, ...sources, ...tests,
        ...docs, ...configs].sort().join(NEWLINE),
      at,
    );

    return {
      /* 1 */
      path: fact(
        root, probe, at,
        ev('stat_path', { path: '.' }, 'file', 'the worktree root', root, at),
      ),
      vcs: hasGit
        ? fact(
          'git', probe, at,
          ev('stat_path', { path: '.git' }, 'file', '.git', 'present', at),
        )
        : unknown(
          probe, at, 'UNKNOWN',
          'run the attachment against a checkout with version control, or name the VCS in '
          + '.agent/context.md. Nothing under the worktree root identifies one',
        ),
      current_branch: branch === null
        ? unknown(
          probe, at, 'UNAVAILABLE',
          'grant read access to the repository\'s VCS metadata, or query the git adapter, '
          + 'which reads the ref rather than the file',
          hasGit ? 'read .git/HEAD' : 'no .git directory is present',
        )
        : fact(
          branch, probe, at,
          ev('read_file', { path: '.git/HEAD' }, 'file', '.git/HEAD', head ?? '', at),
        ),
      worktree_clean: unknown(
        probe, at, 'NOT_COMPUTED',
        'query git.status, which observes the working tree. The repository adapter reads '
        + 'files and does not run the VCS',
      ),

      /* 2 */
      ecosystems: manifests.length === 0
        ? unknown(
          probe, at, 'INSUFFICIENT_EVIDENCE',
          'add or point at a build manifest. Detection is from manifests and layout and '
          + 'never from a directory name, so a repository with neither reports nothing',
        )
        : inference(
          [...new Set(manifests.map((entry) => entry.ecosystem))], probe, at,
          `manifests present: ${manifests.map((entry) => entry.file).join(', ')}. A manifest `
          + 'implies an ecosystem; running its build is what would upgrade this to a FACT',
          listing,
        ),
      package_managers: manifests.length === 0
        ? unknown(probe, at, 'INSUFFICIENT_EVIDENCE', 'add or point at a build manifest')
        : inference(
          [...new Set(manifests.flatMap((entry) => entry.packageManagers))], probe, at,
          'the candidate package managers each present manifest admits. Which one is actually '
          + 'used is settled by a lockfile or by running it',
          listing,
        ),
      ci: ci.length === 0
        ? unknown(
          probe, at, 'UNKNOWN',
          'point at the CI definition, or accept that validation is local only. No CI means '
          + 'validation is local only and the report says so',
        )
        : fact(ci, probe, at, listing),
      containers: containers.length === 0
        ? unknown(probe, at, 'NOT_APPLICABLE', 'no container definition is present')
        : fact(containers, probe, at, listing),

      /* 3 */
      source_directories: sources.length === 0
        ? unknown(
          probe, at, 'INSUFFICIENT_EVIDENCE',
          'name the source layout in .agent/architecture.md, or run a deeper source map',
        )
        : fact(sources, probe, at, listing),
      test_directories: tests.length === 0
        ? unknown(
          probe, at, 'UNKNOWN',
          'no conventional test directory is present. Absence of tests is itself a finding '
          + 'rather than a fact about this probe',
        )
        : fact(tests, probe, at, listing),

      /* 4 */
      documentation: docs.length === 0
        ? unknown(probe, at, 'UNKNOWN', 'point at the documentation root')
        : fact(docs, probe, at, listing),
      configuration: configs.length === 0
        ? unknown(probe, at, 'UNKNOWN', 'point at the configuration root')
        : fact(configs, probe, at, listing),

      /* 5 */
      conventions: agentDirectory && exists(join('.agent', 'conventions.md'))
        ? inference(
          'declared in .agent/conventions.md', probe, at,
          'declared context is a claim to be reconciled with the code, never an override of '
          + 'it. Where the two disagree, that disagreement is a finding and the code is what '
          + 'exists',
          ev(
            'read_file', { path: '.agent/conventions.md' }, 'document',
            '.agent/conventions.md', 'present', at,
          ),
        )
        : unknown(
          probe, at, 'NOT_COMPUTED',
          'infer conventions from the source itself, which is a dispatch and not a file read',
        ),

      /* 6 */
      agent_directory: fact(
        agentDirectory, probe, at,
        ev(
          'stat_path', { path: '.agent' }, 'file', '.agent',
          agentDirectory ? 'present' : 'absent', at,
        ),
      ),

      /* 7 */
      commands: discoverCommands(root, probe, at, listing),

      /* 8 — and these two fail closed. */
      protected_branches: unknown(
        probe, at, 'UNAVAILABLE',
        'grant access to the VCS host\'s branch protection settings. Until then every branch '
        + 'is treated as protected: unknown protection means protected, and merging into one '
        + 'requires a MERGE_PROTECTED grant',
        'the filesystem carries no branch protection record',
      ),
      environments: readEnvironments(root, probe, at),
    };
  };

  /**
   * One step of the attachment sequence, on its own.
   *
   * `attach` computes the whole sequence and the narrower operations project from it, so the
   * two can never disagree about what was observed. Recomputing costs a directory listing and
   * buys the guarantee that `repo.identify` and `repo.attach` answer the same question the
   * same way.
   */
  const subset = (at: string, keys: readonly string[]): Readonly<Record<string, Assertion>> => {
    const all = attach(at);
    const out: Record<string, Assertion> = {};
    for (const key of keys) {
      const assertion = all[key];
      if (assertion !== undefined) out[key] = assertion;
    }
    return out;
  };

  const operations: OperationRegistration[] = [
    readOnlyOperation({
      adapter: ADAPTER,
      op: 'attach',
      description:
        'The attachment sequence: identify, detect, map, locate, infer conventions, check for '
        + '.agent/, determine commands, establish boundaries. Every output an assertion.',
      evidenceKind: 'file',
      observationSafe: true,
      handler: (invocation) => {
        const at = invocation.now.toISOString();
        const value = attach(at);
        return Promise.resolve({
          value,
          excerpt: summarize(value),
          pathsTouched: ['.'],
        });
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'identify',
      description:
        'Attachment step 1: where the repository is, what version control it uses, which '
        + 'branch is checked out, and whether it carries a .agent/ directory.',
      evidenceKind: 'file',
      observationSafe: true,
      handler: (invocation) => {
        const value = subset(invocation.now.toISOString(), [
          'path', 'vcs', 'current_branch', 'worktree_clean', 'agent_directory',
        ]);
        return Promise.resolve({ value, excerpt: summarize(value), pathsTouched: ['.'] });
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'detect_stack',
      description:
        'Languages, build system, package manager, test layout, containers and CI, from '
        + 'manifests and layout and never from a name.',
      evidenceKind: 'file',
      observationSafe: true,
      handler: (invocation) => {
        const value = subset(invocation.now.toISOString(), [
          'ecosystems', 'package_managers', 'ci', 'containers', 'source_directories',
          'test_directories', 'documentation', 'configuration',
        ]);
        return Promise.resolve({ value, excerpt: summarize(value), pathsTouched: ['.'] });
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'commands',
      description:
        'Build, test, lint and run commands, discovered from manifests and CI. An INFERENCE '
        + 'until one has actually been run, which this operation does not do.',
      evidenceKind: 'file',
      /*
       * Reading a manifest is repeatable and changes nothing, so this is replayable. It
       * would not be if it verified a command by executing it — that is attachment step 7's
       * second half, and it belongs to an operation that declares what running it costs.
       */
      observationSafe: true,
      handler: (invocation) => {
        const value = subset(invocation.now.toISOString(), ['commands']);
        return Promise.resolve({ value, excerpt: summarize(value), pathsTouched: ['.'] });
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'read_file',
      description: 'Reads one file from the worktree, confined and redacted.',
      args: { path: PATH_ARG },
      required: ['path'],
      evidenceKind: 'file',
      observationSafe: true,
      handler: (invocation) => {
        const resolved = resolveArg(invocation, 'path');
        let content: string;
        try {
          content = readFileSync(resolved, 'utf8');
        } catch (error) {
          throw new ResourceAbsentError(
            resolved,
            `the file could not be read: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const normalized = content.replace(/\r\n/g, '\n');
        const value = {
          path: toPosix(relative(root, resolved)),
          bytes: Buffer.byteLength(content, 'utf8'),
          lines: normalized.split('\n').length,
          content: normalized,
        };
        return Promise.resolve({
          value,
          excerpt: normalized,
          pathsTouched: [toPosix(relative(root, resolved))],
        });
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'list_paths',
      description: 'Lists the entries under one directory of the worktree, one level deep.',
      args: { path: PATH_ARG, depth: INTEGER_ARG },
      required: ['path'],
      evidenceKind: 'file',
      observationSafe: true,
      handler: (invocation) => {
        const resolved = resolveArg(invocation, 'path');
        const depth = typeof invocation.args['depth'] === 'number' ? invocation.args['depth'] : 1;
        if (!existsSync(resolved)) {
          throw new ResourceAbsentError(resolved, `${resolved} does not exist`);
        }
        const { entries, truncated } = walk(resolved, Math.max(0, depth - 1));
        const value = { root: toPosix(relative(root, resolved)) || '.', entries, truncated };
        return Promise.resolve({
          value,
          excerpt: entries.join('\n'),
          pathsTouched: [toPosix(relative(root, resolved)) || '.'],
        });
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'find_files',
      description: 'Finds worktree paths matching a glob, skipping declared scratch roots.',
      args: { glob: STRING_ARG },
      required: ['glob'],
      evidenceKind: 'file',
      observationSafe: true,
      handler: (invocation) => {
        const pattern = String(invocation.args['glob']);
        const { entries, truncated } = walk(root, 32);
        const matched = entries.filter((entry) => matchesGlob(entry, pattern, true));
        return Promise.resolve({
          value: { glob: pattern, matched, truncated },
          excerpt: matched.join('\n'),
          pathsTouched: matched,
        });
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'stat_path',
      description: 'Reports whether a path exists and what kind of entry it is.',
      args: { path: PATH_ARG },
      required: ['path'],
      evidenceKind: 'file',
      observationSafe: true,
      handler: (invocation) => {
        const resolved = resolveArg(invocation, 'path');
        const relativePath = toPosix(relative(root, resolved)) || '.';
        if (!existsSync(resolved)) {
          return Promise.resolve<OperationResult>({
            value: { path: relativePath, exists: false, kind: null, bytes: null },
            excerpt: `${relativePath}: absent`,
            pathsTouched: [relativePath],
          });
        }
        const stats = statSync(resolved);
        const kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
        return Promise.resolve({
          value: {
            path: relativePath,
            exists: true,
            kind,
            bytes: stats.isFile() ? stats.size : null,
          },
          excerpt: `${relativePath}: ${kind}`,
          pathsTouched: [relativePath],
        });
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'read_agent_directory',
      description:
        'Reads the optional .agent/ directory as declared context. Its absence is an ordinary '
        + 'observation, never a missing prerequisite.',
      evidenceKind: 'file',
      observationSafe: true,
      handler: (invocation) => {
        const at = invocation.now.toISOString();
        const present = exists('.agent');
        if (!present) {
          return Promise.resolve({
            value: {
              present: false,
              files: [],
              note:
                'a repository with no AgentOS-specific files works fully. Discovery proceeds '
                + 'from scratch and nothing is recorded as missing',
            },
            excerpt: '.agent: absent',
            pathsTouched: ['.'],
          });
        }
        const { entries, truncated } = walk(join(root, '.agent'), 2);
        return Promise.resolve({
          value: {
            present: true,
            files: entries,
            truncated,
            status: inference(
              'declared context', 'repo.read_agent_directory', at,
              'everything in .agent/ is a claim to be reconciled with code and runtime, the '
              + 'same standard applied to an EPIC. Declared context never overrides observed '
              + 'reality',
              ev(
                'read_agent_directory', {}, 'document', '.agent/',
                entries.join(NEWLINE), at,
              ),
            ),
          },
          excerpt: entries.join('\n'),
          pathsTouched: entries,
        });
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'boundaries',
      description:
        'Which branches are protected and which environments are production. Both fail '
        + 'closed: unestablished protection is protected, unestablished environment is '
        + 'production.',
      evidenceKind: 'file',
      observationSafe: true,
      handler: (invocation) => {
        const at = invocation.now.toISOString();
        const environments = readEnvironments(root, 'repo.boundaries', at);
        const value = {
          protected_branches: unknown(
            'repo.boundaries', at, 'UNAVAILABLE',
            'grant access to the VCS host\'s protection settings, or declare them in '
            + '.agent/policies.json, which may only tighten',
            'the worktree carries no branch protection record',
          ),
          environments,
          rule:
            'where protection or production status cannot be established, the branch is '
            + 'treated as protected and the environment as production. Where no environment '
            + 'topology is discovered at all, every reachable runtime is production',
        };
        return Promise.resolve({ value, excerpt: summarize(value), pathsTouched: ['.'] });
      },
    }),
  ];

  return operations;
}

/** The repository adapter is available when its worktree root is a readable directory. */
export function repositoryAvailability(options: RepoOptions): AvailabilityProbe {
  return {
    adapter: ADAPTER,
    probe(): Promise<Omit<AdapterAvailability, 'checked_at'>> {
      try {
        const stats = statSync(options.worktreeRoot);
        if (!stats.isDirectory()) {
          return Promise.resolve({
            adapter: ADAPTER,
            state: 'NOT_CONFIGURED',
            detail: `${options.worktreeRoot} is not a directory, so no worktree is attached`,
          });
        }
        readdirSync(options.worktreeRoot);
        return Promise.resolve({
          adapter: ADAPTER,
          state: 'AVAILABLE',
          detail: `attached to ${options.worktreeRoot}`,
        });
      } catch (error) {
        return Promise.resolve({
          adapter: ADAPTER,
          state: 'UNAVAILABLE',
          detail:
            'the worktree root exists in configuration and could not be read: '
            + (error instanceof Error ? error.message : String(error)),
        });
      }
    },
  };
}

/* ---------------------------------------------------------------------- helpers ------ */

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function parseHead(head: string): string | null {
  const match = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
  if (match?.[1] !== undefined) return match[1];
  /* A detached HEAD is a commit id, which is a real answer and not a branch. */
  return /^[0-9a-f]{7,40}$/i.test(head.trim()) ? `detached@${head.trim().slice(0, 12)}` : null;
}

/**
 * The environment topology, from `.agent/environments.json` where a human declared one.
 *
 * A declared topology is an `INFERENCE` and not a `FACT`: it is a claim about the world
 * written down, and REPOSITORY_ADAPTER 3 is explicit that declared context never overrides
 * observed reality. Where there is none, the answer is `UNKNOWN` — and the fail-closed rule
 * then makes every reachable runtime production, which is what the classification reports.
 */
function readEnvironments(root: string, probe: string, at: string): Assertion {
  const path = join(root, '.agent', 'environments.json');
  const text = readIfPresent(path);
  if (text === null) {
    return unknown(
      probe, at, 'UNKNOWN',
      'declare the topology in .agent/environments.json, or grant AgentOS the access it '
      + 'needs to classify. With no topology discovered at all, every reachable runtime is '
      + 'production',
      'read .agent/environments.json',
    );
  }
  try {
    return inference(
      JSON.parse(text), probe, at,
      'declared in .agent/environments.json, which is a claim to be reconciled with the '
      + 'runtime rather than an observation of it',
      selfEvidence({
        adapter: 'repo',
        op: 'read_file',
        args: { path: '.agent/environments.json' },
        kind: 'document',
        ref: '.agent/environments.json',
        excerpt: text,
        observedAt: at,
      }),
    );
  } catch (error) {
    return unknown(
      probe, at, 'CONFLICTING',
      'fix .agent/environments.json so it parses. A topology file that cannot be read is not '
      + 'a topology, and the fail-closed rule applies as though none were declared',
      `parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Build, test, lint and run commands, from the manifests that declare them.
 *
 * An `INFERENCE` and not a `FACT`, always. A script named `test` is a claim that running it
 * tests the repository, and REPOSITORY_ADAPTER's own attachment step 7 says the upgrade to
 * `FACT` comes from executing it. This operation does not execute anything, so it does not
 * make that claim.
 */
function discoverCommands(
  root: string,
  probe: string,
  at: string,
  evidence: Evidence,
): Assertion {
  const commands: Record<string, string> = {};

  const manifest = readIfPresent(join(root, 'package.json'));
  if (manifest !== null) {
    try {
      const parsed = JSON.parse(manifest) as { scripts?: Record<string, string> };
      for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
        if (/^(build|test|lint|start|run|typecheck|verify)$/.test(name)) {
          commands[name] = command;
        }
      }
    } catch {
      /* An unparseable manifest declares no commands. Nothing is invented from a broken file. */
    }
  }

  for (const file of ['Makefile', 'makefile', 'GNUmakefile']) {
    const text = readIfPresent(join(root, file));
    if (text === null) continue;
    for (const line of text.split('\n')) {
      const match = /^(build|test|lint|run|check)\s*:(?!=)/.exec(line);
      if (match?.[1] !== undefined && commands[match[1]] === undefined) {
        commands[match[1]] = `make ${match[1]}`;
      }
    }
  }

  if (Object.keys(commands).length === 0) {
    return unknown(
      probe, at, 'INSUFFICIENT_EVIDENCE',
      'declare the build, test and lint commands in a manifest, a Makefile or the CI '
      + 'definition. Nothing under the worktree root names one, and guessing a command to run '
      + 'against someone\'s repository is not a gap this fills',
      'read package.json scripts and Makefile targets',
    );
  }

  return inference(
    commands, probe, at,
    'declared in the repository\'s own manifests. A script named "test" is a claim that '
    + 'running it tests the repository; executing it is what would upgrade this to a FACT, '
    + 'and this operation executes nothing',
    evidence,
  );
}

/** A short rendering for the evidence excerpt: keys and confidence, not whole values. */
function summarize(value: Readonly<Record<string, unknown>>): string {
  return Object.entries(value)
    .map(([key, entry]) => {
      if (entry !== null && typeof entry === 'object' && 'confidence' in entry) {
        return `${key}: ${String(entry.confidence)}`;
      }
      return `${key}: ${typeof entry}`;
    })
    .sort()
    .join('\n');
}
