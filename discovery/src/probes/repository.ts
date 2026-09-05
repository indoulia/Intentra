import type { Assertion, ContextSectionName, Evidence } from '@agentos/contracts';
import type { FreshnessClass } from '../assertions.js';
import { OPS, ADAPTERS } from '../ops.js';
import type {
  ProbeInput,
  SectionAssertions,
  SectionProbe,
  SectionProbeResult,
} from '../probe.js';
import { asRecord, asString } from '../probe.js';
import type { Observation, ProbeSession } from '../session.js';
import { attachmentOutput, listedPaths, observe } from './observation.js';

/**
 * The repository probe set.
 *
 * The twelve of [CONTEXT_MODEL.md](../../../docs/CONTEXT_MODEL.md) section 3, plus the
 * identity and command determination that
 * [REPOSITORY_ADAPTER.md](../../../docs/REPOSITORY_ADAPTER.md) section 1 makes steps 1 and 7
 * of attachment. Each answers one narrow question about what the repository *contains*, which
 * is the one subject git and the filesystem are authoritative about.
 *
 * Two disciplines run through all of them.
 *
 * **Detection is an `INFERENCE` until something verifies it.** A `package.json` in the tree is
 * a fact about a file and an inference about the build system; a build command that was
 * discovered is an inference, and one the adapter reports as having been executed is a fact.
 * The distinction is not pedantry: it is what stops "the test command is `npm test`" from
 * being cited as evidence that tests run.
 *
 * **A repository with no AgentOS-specific files must work fully.** `.agent/` is read where it
 * exists and its absence records nothing as missing, because any code path that requires it
 * is a bug.
 */

/**
 * The worktree root, as the repository adapter names it in the paths it reports touching.
 *
 * Coverage is arithmetic over those reports — `scope_examined` is what a probe intended
 * intersected with what its calls actually reached — so a probe naming the host's absolute
 * path here would be claiming coverage of something no call ever reported. Every other path
 * in this file is worktree-relative, and this is the same rule applied to the root.
 */
const WORKTREE = '.';

/** The paths a repository declares itself through, independent of language or ecosystem. */
const MANIFEST_GLOBS = [
  '**/package.json', '**/*.csproj', '**/*.fsproj', '**/*.sln', '**/pom.xml',
  '**/build.gradle', '**/build.gradle.kts', '**/Cargo.toml', '**/go.mod',
  '**/pyproject.toml', '**/setup.py', '**/requirements*.txt', '**/Gemfile',
  '**/composer.json', '**/mix.exs', '**/pubspec.yaml', '**/CMakeLists.txt',
] as const;

const LOCKFILE_GLOBS = [
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/Cargo.lock',
  '**/go.sum', '**/poetry.lock', '**/Gemfile.lock', '**/composer.lock',
  '**/packages.lock.json',
] as const;

const CONFIG_GLOBS = [
  '**/*.config.js', '**/*.config.ts', '**/*.config.json', '**/appsettings*.json',
  '**/.env*', '**/config/**', '**/*.ini', '**/*.toml', '**/*.yaml', '**/*.yml',
] as const;

const SCHEMA_GLOBS = [
  '**/migrations/**', '**/migrate/**', '**/*.sql', '**/schema.prisma',
  '**/schema.graphql', '**/models/**', '**/entities/**',
] as const;

const API_GLOBS = [
  '**/openapi*.json', '**/openapi*.yaml', '**/swagger*.json', '**/*.proto',
  '**/routes/**', '**/controllers/**', '**/handlers/**', '**/api/**', '**/endpoints/**',
] as const;

const UI_GLOBS = [
  '**/*.tsx', '**/*.jsx', '**/*.vue', '**/*.svelte', '**/*.razor', '**/*.cshtml',
  '**/pages/**', '**/views/**', '**/components/**', '**/screens/**',
] as const;

const TEST_GLOBS = [
  '**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**',
  '**/*Test.*', '**/*Tests.*', '**/*_test.*',
] as const;

const CI_GLOBS = [
  '.github/workflows/**', '.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile',
  '.circleci/**', '.drone.yml', 'bitbucket-pipelines.yml', '**/*.pipeline.yml',
] as const;

const DEPLOYMENT_GLOBS = [
  '**/Dockerfile*', '**/docker-compose*.yml', '**/docker-compose*.yaml',
  '**/*.tf', '**/*.bicep', '**/helm/**', '**/k8s/**', '**/kubernetes/**',
  '**/serverless.yml', '**/*.nomad',
] as const;

const DOC_GLOBS = [
  'README*', 'CONTRIBUTING*', 'ARCHITECTURE*', 'CHANGELOG*',
  '**/docs/**', '**/doc/**', '**/*.md', '**/adr/**', '**/decisions/**',
] as const;

const OWNERSHIP_GLOBS = [
  'CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS', 'OWNERS', '**/OWNERS',
] as const;

const AGENT_DIR_GLOBS = ['.agent/**'] as const;

const SOURCE_GLOBS = [
  '**/clients/**', '**/integrations/**', '**/adapters/**', '**/connectors/**',
  '**/providers/**', '**/*Client.*', '**/*client.*',
] as const;

/**
 * One listing call, with its evidence.
 *
 * Every path-shaped probe makes exactly one adapter call, which keeps the coverage
 * attribution honest: the paths the call reports touching are the paths the probe examined,
 * and there is no second call whose scope somebody has to remember to add.
 */
async function listing(
  session: ProbeSession,
  probe: string,
  globs: readonly string[],
  scopePaths: readonly string[],
): Promise<{
    readonly found: readonly string[];
    readonly evidence: readonly Evidence[];
    readonly failure: Observation | null;
  }> {
  const args = scopePaths.length > 0
    ? { globs: [...globs], under: [...scopePaths] }
    : { globs: [...globs] };
  const observation = await observe(session, {
    probe,
    adapter: ADAPTERS.repo,
    op: OPS.repo.listPaths,
    args,
    kind: 'file',
    ref: `${ADAPTERS.repo}.${OPS.repo.listPaths} over ${globs.length} pattern(s)`,
  });
  if (observation.outcome !== 'OBSERVED') {
    return { found: [], evidence: [], failure: observation };
  }
  return {
    found: listedPaths(observation.value),
    evidence: [observation.evidence],
    failure: null,
  };
}

interface CatalogueSpec {
  readonly name: string;
  readonly section: ContextSectionName;
  readonly tier: 1 | 2;
  readonly freshnessClass: FreshnessClass;
  readonly globs: readonly string[];
  /** What the probe is establishing, for the absence record when it cannot. */
  readonly subject: string;
  /**
   * Assertions built from the listing.
   *
   * Called only when the listing succeeded, so an implementation never has to decide what an
   * empty result means: an empty listing here is a successful query that found nothing, which
   * is `EMPTY` and not `UNAVAILABLE`, and that difference is already made for it.
   */
  build(
    found: readonly string[],
    context: {
      readonly session: ProbeSession;
      readonly probe: string;
      readonly evidence: readonly Evidence[];
      readonly observedAt: string;
      readonly freshnessClass: FreshnessClass;
    },
  ): SectionAssertions;
}

/**
 * A probe whose whole observation is "which paths matching these patterns exist".
 *
 * The pattern recurs because it is what the filesystem can actually tell you. What varies is
 * the interpretation, and interpretation is where the confidence class is decided — which is
 * why `build` receives the evidence and mints its own assertions rather than being handed
 * pre-made ones.
 */
function catalogueProbe(spec: CatalogueSpec): SectionProbe {
  return {
    name: spec.name,
    section: spec.section,
    tier: spec.tier,
    freshnessClass: spec.freshnessClass,
    async run(session: ProbeSession, input: ProbeInput): Promise<SectionProbeResult> {
      const scopePaths = spec.tier === 2 ? input.scope.paths : [];
      const result = await listing(session, spec.name, spec.globs, scopePaths);
      if (result.failure !== null) {
        return {
          assertions: { [spec.subject]: session.noAccess(spec.name, spec.subject, result.failure) },
          available: false,
          detail: `${spec.name} could not list the repository`,
          intendedScope: scopePaths.length > 0 ? scopePaths : [...spec.globs],
        };
      }
      return {
        assertions: spec.build(result.found, {
          session,
          probe: spec.name,
          evidence: result.evidence,
          observedAt: session.nowIso(),
          freshnessClass: spec.freshnessClass,
        }),
        available: true,
        detail: `${result.found.length} path(s) matched`,
        intendedScope: scopePaths.length > 0 ? scopePaths : [...spec.globs],
      };
    },
  };
}

/** Directory prefixes, which is how a path listing becomes a statement about structure. */
function directories(found: readonly string[], depth: number): readonly string[] {
  const out = new Set<string>();
  for (const path of found) {
    const parts = path.replace(/\\/g, '/').split('/').filter((p) => p !== '');
    if (parts.length <= 1) continue;
    out.add(parts.slice(0, Math.min(depth, parts.length - 1)).join('/'));
  }
  return [...out].sort();
}

/** File extensions, ordered by how much of the tree they account for. */
function extensionHistogram(found: readonly string[]): ReadonlyArray<{
  readonly extension: string;
  readonly files: number;
}> {
  const counts = new Map<string, number>();
  for (const path of found) {
    const match = /\.([A-Za-z0-9_]+)$/.exec(path);
    if (match === null) continue;
    const extension = `.${(match[1] ?? '').toLowerCase()}`;
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([extension, files]) => ({ extension, files }))
    .sort((a, b) => b.files - a.files || (a.extension < b.extension ? -1 : 1));
}

/* ============================================================== identity ==== */

/**
 * Attachment step 1: path, VCS, default branch, current branch, remotes.
 *
 * The one probe that must run first, because every other locator is relative to what it
 * establishes. It also records the repository adapter's own availability into the section, so
 * a reader of `repository` alone can tell a repository with nothing in it from a repository
 * nobody could open.
 */
export const identityProbe: SectionProbe = {
  name: 'repo.identity',
  section: 'repository',
  tier: 1,
  freshnessClass: 'repository',
  async run(session, input) {
    const availability = session.adapterState(ADAPTERS.repo);
    const observedAt = session.nowIso();
    const access = session.derived(
      'repo.identity',
      availability,
      ['adapter.availability'],
      'the repository adapter reports its own availability; that report is a fact about '
      + 'access rather than an observation of the repository, so it is stated as an inference '
      + 'over the adapter registry',
      'repository',
      observedAt,
    );

    const observation = await observe(session, {
      probe: 'repo.identity',
      adapter: ADAPTERS.repo,
      op: OPS.repo.identify,
      /*
       * No arguments. The repository adapter is attached to exactly one worktree and
       * answers about that one; a `path` here would either be ignored, which would make
       * the evidence locator say something the adapter did not do, or it would re-root the
       * adapter, which is confinement decided by the caller.
       */
      args: {},
      kind: 'command',
      ref: `${ADAPTERS.repo}.${OPS.repo.identify} at ${input.repositoryPath}`,
    });

    if (observation.outcome !== 'OBSERVED') {
      return {
        assertions: {
          repo_access: access,
          identity: session.noAccess('repo.identity', 'repository identity', observation),
        },
        available: false,
        detail: 'the repository could not be identified',
        intendedScope: [WORKTREE],
      };
    }

    const identity = asRecord(observation.value);
    if (identity === null) {
      return {
        assertions: {
          repo_access: access,
          identity: session.insufficient(
            'repo.identity',
            `${ADAPTERS.repo}.${OPS.repo.identify} returned something that is not a repository `
            + 'record, so identity could not be read from it',
            'fix the repository adapter to return an identity record, then re-probe',
            observation.observedAt,
          ),
        },
        available: true,
        detail: 'the identity operation returned an unusable shape',
        intendedScope: [WORKTREE],
      };
    }

    const evidence = [observation.evidence];
    const assertions: Record<string, Assertion> = {
      repo_access: access,
      identity: session.observedFact(
        'repo.identity', identity, evidence, 'repository', observation.observedAt,
      ),
    };
    /*
     * Two vocabularies, one observation.
     *
     * The adapter answers in the attachment sequence's words — step 1 identifies the
     * repository's `path` ([REPOSITORY_ADAPTER.md](../../../docs/REPOSITORY_ADAPTER.md)
     * section 1) — and this section of the Context Package is written in the Context Model's,
     * where the same thing is the `root`. Neither document is wrong and neither has to change:
     * mapping one onto the other is what a probe is for, because the probe is what populates a
     * `ContextPackage` section. What must not happen is the mapping being skipped and the
     * section reporting INSUFFICIENT_EVIDENCE for something the adapter plainly established.
     */
    for (const [key, fields] of [
      ['root', ['root', 'path']],
      ['vcs', ['vcs']],
      ['current_branch', ['current_branch']],
    ] as const) {
      const field = fields.find((name) => identity[name] !== undefined);
      assertions[key] = field === undefined
        ? session.insufficient(
          'repo.identity',
          `the identity record carries none of: ${fields.join(', ')}`,
          `have the repository adapter report ${fields[0]}`,
          observation.observedAt,
        )
        : session.observedFact(
          'repo.identity', identity[field], evidence, 'repository', observation.observedAt,
        );
    }

    /*
     * The two halves of identify the repository adapter cannot answer.
     *
     * Attachment step 1 names remotes and the default branch among its outputs, and the
     * repository adapter reads files rather than running the VCS — it says so itself, and
     * defers `worktree_clean` to `git.status` for the same reason. So they are asked of the
     * adapter that owns them. An unreachable git is `UNAVAILABLE` here, never "no remotes".
     */
    for (const [key, op, subject] of [
      ['default_branch', OPS.git.defaultBranch, "the remote's default branch"],
      ['remotes', OPS.git.remotes, 'the configured remotes'],
    ] as const) {
      const fromGit = await observe(session, {
        probe: 'repo.identity',
        adapter: ADAPTERS.git,
        op,
        args: {},
        kind: 'git',
        ref: `${ADAPTERS.git}.${op}`,
      });
      assertions[key] = fromGit.outcome === 'OBSERVED'
        ? session.observedFact(
          'repo.identity', fromGit.value, [fromGit.evidence], 'repository', fromGit.observedAt,
        )
        : session.noAccess('repo.identity', subject, fromGit);
    }
    return {
      assertions,
      available: true,
      detail: 'repository identified',
      intendedScope: [WORKTREE],
    };
  },
};

/* ============================================================= structure ==== */

export const structureProbe: SectionProbe = catalogueProbe({
  name: 'repo.structure',
  section: 'repository',
  tier: 1,
  freshnessClass: 'repository',
  subject: 'structure',
  globs: ['**/*'],
  build: (found, ctx) => ({
    structure: ctx.session.observedFact(
      ctx.probe,
      {
        file_count: found.length,
        top_level: directories(found, 1),
        modules: directories(found, 2),
        extensions: extensionHistogram(found).slice(0, 20),
      },
      ctx.evidence,
      ctx.freshnessClass,
      ctx.observedAt,
    ),
    /*
     * Entry points are read off the layout, so they are an inference. A file called `main.ts`
     * is a fact; that it is how the system starts is a reading of a convention, and the
     * runtime probe is what turns that into a fact by observing the thing run.
     */
    entry_points: ctx.session.derived(
      ctx.probe,
      found.filter((p) => /(^|\/)(main|index|program|app|server|cli|__main__)\.[A-Za-z0-9]+$/i.test(p)),
      ctx.evidence.map((e) => e.id),
      'candidate entry points identified from filename convention in the observed listing; '
      + 'the layout is a fact and what starts the system is a reading of it',
      ctx.freshnessClass,
      ctx.observedAt,
      ctx.evidence,
    ),
    ownership_files: ctx.session.observedFact(
      ctx.probe,
      found.filter((p) => OWNERSHIP_GLOBS.some((g) => p.endsWith(g.replace(/^\*\*\//, '')))),
      ctx.evidence,
      ctx.freshnessClass,
      ctx.observedAt,
    ),
    /*
     * `.agent/` is an optimization and never a prerequisite. Its absence records nothing as
     * missing — an empty list here is EMPTY, not a gap — and its contents are read as
     * declared claims to be reconciled with code, never as observed reality.
     */
    agent_directory: ctx.session.observedFact(
      ctx.probe,
      found.filter((p) => AGENT_DIR_GLOBS.some((g) => p.startsWith(g.replace('**', '')))),
      ctx.evidence,
      ctx.freshnessClass,
      ctx.observedAt,
    ),
  }),
});

/* ================================================================= stack ==== */

/**
 * Languages, frameworks, build system, package managers.
 *
 * Asks the adapter first, because stack detection is the adapter's job and it can read a
 * manifest properly. Where the adapter offers no detection, the probe falls back to the
 * manifest listing and says plainly that the result is an inference from filenames — which is
 * weaker, and is stated as weaker rather than presented as the same answer.
 */
export const stackProbe: SectionProbe = {
  name: 'repo.stack',
  section: 'repository',
  tier: 1,
  freshnessClass: 'repository',
  async run(session, _input) {
    const observation = await observe(session, {
      probe: 'repo.stack',
      adapter: ADAPTERS.repo,
      op: OPS.repo.detectStack,
      /*
       * No arguments. The repository adapter is attached to exactly one worktree and
       * answers about that one; a `path` here would either be ignored, which would make
       * the evidence locator say something the adapter did not do, or it would re-root the
       * adapter, which is confinement decided by the caller.
       */
      args: {},
      kind: 'command',
      ref: `${ADAPTERS.repo}.${OPS.repo.detectStack}`,
    });

    if (observation.outcome === 'OBSERVED') {
      const stack = asRecord(observation.value);
      if (stack !== null) {
        const evidence = [observation.evidence];
        const assertions: Record<string, Assertion> = {};
        for (const key of [
          'languages', 'frameworks', 'build_system', 'package_managers', 'test_runner',
          'linters', 'containers',
        ]) {
          const value = stack[key];
          if (value !== undefined) {
            assertions[key] = session.observedFact(
              'repo.stack', value, evidence, 'repository', observation.observedAt,
            );
            continue;
          }
          /*
           * `languages` is the one key the two vocabularies genuinely disagree about rather
           * than merely spell differently. The attachment sequence detects **ecosystems**
           * from manifests, and an ecosystem is not a language: `package.json` says node, and
           * says nothing about whether the source is JavaScript or TypeScript. So the
           * adapter's answer is not renamed into this key — it is carried through under its
           * own name below, and the language question is answered from the layout, which is
           * where the answer actually is and what this probe's own `recoverable_by` has been
           * naming all along.
           */
          const census = key === 'languages'
            ? await languageCensus(session, observation.observedAt)
            : null;
          assertions[key] = census ?? session.insufficient(
            'repo.stack',
            `the stack detection returned no ${key}`,
            `have the repository adapter report ${key}, or read it from the manifests`,
            observation.observedAt,
          );
        }
        /*
         * The adapter's own words, kept where it established something the Context Model has
         * no synonym for. Dropping it because this section is written in a different
         * vocabulary would throw away a real observation; inventing a gap for a key the
         * Context Model never asked for would be the opposite error, so it appears only when
         * the adapter answered it.
         */
        const ecosystems = stack['ecosystems'];
        if (ecosystems !== undefined) {
          assertions['ecosystems'] = session.observedFact(
            'repo.stack', ecosystems, evidence, 'repository', observation.observedAt,
          );
        }
        return {
          assertions,
          available: true,
          detail: 'stack detected by the repository adapter',
          intendedScope: [WORKTREE],
        };
      }
    }

    const fallback = await listing(session, 'repo.stack', MANIFEST_GLOBS, []);
    if (fallback.failure !== null) {
      const failure = observation.outcome === 'OBSERVED' ? fallback.failure : observation;
      return {
        assertions: { languages: session.noAccess('repo.stack', 'the technology stack', failure) },
        available: false,
        detail: 'neither stack detection nor a manifest listing was possible',
        intendedScope: [WORKTREE],
      };
    }

    const observedAt = session.nowIso();
    const ids = fallback.evidence.map((e) => e.id);
    return {
      assertions: {
        manifests: session.observedFact(
          'repo.stack', fallback.found, fallback.evidence, 'repository', observedAt,
        ),
        package_managers: session.derived(
          'repo.stack',
          [...new Set(fallback.found.map(manifestToPackageManager).filter((m) => m !== null))],
          ids,
          'the repository adapter offers no stack detection, so the package managers are read '
          + 'from the manifest filenames that were observed. A filename is a fact and what '
          + 'builds the project is a reading of it',
          'repository',
          observedAt,
          fallback.evidence,
        ),
        languages: session.insufficient(
          'repo.stack',
          'the repository adapter offers no stack detection and a manifest listing cannot '
          + 'establish which languages the source is written in',
          `implement ${ADAPTERS.repo}.${OPS.repo.detectStack}, or run a language census over `
          + 'the observed extensions',
          observedAt,
        ),
      },
      available: true,
      detail: 'stack inferred from manifests because the adapter offers no detection',
      intendedScope: [WORKTREE],
    };
  },
};

/**
 * Source extensions, and the language each one *is*.
 *
 * Deliberately not exhaustive and deliberately not clever. An extension nobody put here is
 * counted as nothing rather than guessed at, because a census that named a language from an
 * extension it did not recognise would be the "detection from a name" the attachment sequence
 * forbids. Configuration, markup and data extensions are absent on purpose: a repository is
 * not written in JSON.
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust', '.java': 'Java',
  '.kt': 'Kotlin', '.kts': 'Kotlin', '.scala': 'Scala', '.swift': 'Swift',
  '.cs': 'C#', '.fs': 'F#', '.vb': 'Visual Basic',
  '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.cxx': 'C++', '.hpp': 'C++',
  '.m': 'Objective-C', '.mm': 'Objective-C++',
  '.php': 'PHP', '.ex': 'Elixir', '.exs': 'Elixir', '.erl': 'Erlang',
  '.dart': 'Dart', '.lua': 'Lua', '.pl': 'Perl', '.r': 'R', '.jl': 'Julia',
  '.sh': 'Shell', '.bash': 'Shell', '.ps1': 'PowerShell', '.sql': 'SQL',
};

/**
 * Which languages the source is written in, counted off the layout.
 *
 * An `INFERENCE` and never a `FACT`, and the distinction is the whole point: the file listing
 * is the observation, and "this repository is written in TypeScript" is a reading of it. The
 * reading is a good one — an extension is a stronger signal than a manifest, which is why the
 * adapter refuses to answer this from a manifest at all — but it is still a reading, so it
 * cites the listing it derives from and says so in one sentence.
 *
 * Returns `null` where nothing can be read: the listing failed, or nothing in it carries a
 * recognised source extension. The caller then states the gap, because a census that found no
 * source and an empty answer must not read the same.
 */
async function languageCensus(
  session: ProbeSession,
  observedAt: string,
): Promise<Assertion | null> {
  const found = await listing(session, 'repo.stack', ['**/*'], []);
  if (found.failure !== null) return null;

  const counts = new Map<string, number>();
  for (const path of found.found) {
    const dot = path.lastIndexOf('.');
    if (dot <= 0) continue;
    const language = LANGUAGE_BY_EXTENSION[path.slice(dot).toLowerCase()];
    if (language === undefined) continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return session.derived(
    'repo.stack',
    ranked.map(([language]) => language),
    found.evidence.map((e) => e.id),
    'counted from the source extensions in the observed listing, commonest first ('
    + ranked.map(([language, count]) => `${language} ${String(count)}`).join(', ')
    + '). The listing is the fact and which language a file is written in is a reading of its '
    + 'extension; compiling or running the source is what would settle it',
    'repository',
    observedAt,
    found.evidence,
  );
}

function manifestToPackageManager(path: string): string | null {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  if (name === 'package.json') return 'npm-compatible';
  if (name === 'pom.xml') return 'maven';
  if (name.startsWith('build.gradle')) return 'gradle';
  if (name === 'Cargo.toml') return 'cargo';
  if (name === 'go.mod') return 'go modules';
  if (name === 'pyproject.toml' || name === 'setup.py' || name.startsWith('requirements')) {
    return 'python';
  }
  if (name === 'Gemfile') return 'bundler';
  if (name === 'composer.json') return 'composer';
  if (name.endsWith('.csproj') || name.endsWith('.fsproj') || name.endsWith('.sln')) return 'nuget';
  if (name === 'mix.exs') return 'mix';
  if (name === 'pubspec.yaml') return 'pub';
  if (name === 'CMakeLists.txt') return 'cmake';
  return null;
}

/* ============================================================== commands ==== */

/**
 * Attachment step 7: build, test, lint and run, "discovered from manifests and CI, then
 * verified by execution where safe".
 *
 * A discovered command is an `INFERENCE`. The adapter says whether it verified one by running
 * it, and only that upgrades the assertion — because a command nobody ran is a plan, and the
 * Implementer that trusts a plan as a fact discovers otherwise at the worst moment.
 */
export const commandsProbe: SectionProbe = {
  name: 'repo.commands',
  section: 'repository',
  tier: 2,
  freshnessClass: 'repository',
  async run(session, _input) {
    const observation = await observe(session, {
      probe: 'repo.commands',
      adapter: ADAPTERS.repo,
      op: OPS.repo.commands,
      /*
       * No arguments. The repository adapter is attached to exactly one worktree and
       * answers about that one; a `path` here would either be ignored, which would make
       * the evidence locator say something the adapter did not do, or it would re-root the
       * adapter, which is confinement decided by the caller.
       */
      args: {},
      kind: 'command',
      ref: `${ADAPTERS.repo}.${OPS.repo.commands}`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertions: {
          commands: session.noAccess('repo.commands', 'the build and test commands', observation),
        },
        available: false,
        detail: 'commands could not be determined',
        intendedScope: [WORKTREE],
      };
    }
    /*
     * The commands, out of the attachment-output map they arrive in.
     *
     * `repo.commands` is attachment step 7 projected out of the whole sequence, so it answers
     * `{ commands: <the commands> }` and not the commands themselves. Reading it one level too
     * shallow finds no `test` key and reports a repository that declares no test command —
     * silently, and identically to a repository that really declares none. Where the operation
     * answers the commands directly, that is read too: the shape the projection produces is
     * the adapter's business, and neither reading invents anything.
     */
    const projected = asRecord(attachmentOutput(observation.value, 'commands'));
    const discovered = projected ?? asRecord(observation.value);
    if (discovered === null) {
      return {
        assertions: {
          commands: session.insufficient(
            'repo.commands',
            'the command operation returned no command record',
            'have the repository adapter report build, test, lint and run commands',
            observation.observedAt,
          ),
        },
        available: true,
        detail: 'the command operation returned an unusable shape',
        intendedScope: [WORKTREE],
      };
    }

    const evidence = [observation.evidence];
    const assertions: Record<string, Assertion> = {};
    /*
     * `start` is what a Node manifest calls the run command, and nothing else in the sequence
     * claims that name. Reading it as `run` is reading the repository's own vocabulary, which
     * is what attachment step 7 discovers from; every one of these stays an INFERENCE until
     * something executes it, so nothing is upgraded by the alias.
     */
    for (const [kind, aliases] of [
      ['build', ['build']], ['test', ['test']], ['lint', ['lint']], ['run', ['run', 'start']],
    ] as const) {
      const declared = aliases.map((name) => discovered[name]).find((v) => v !== undefined);
      const entry = asRecord(declared);
      const command = entry === null ? asString(declared) : asString(entry['command']);
      const key = `${kind}_command`;
      if (command === null) {
        assertions[key] = session.insufficient(
          'repo.commands',
          `no ${kind} command was discovered in the manifests or the CI definitions`,
          `declare a ${kind} command in the repository, or supply one through the adapter`,
          observation.observedAt,
        );
        continue;
      }
      const verified = entry !== null && entry['verified'] === true;
      assertions[key] = verified
        ? session.observedFact(
          'repo.commands', command, evidence, 'repository', observation.observedAt,
        )
        : session.derived(
          'repo.commands',
          command,
          evidence.map((e) => e.id),
          `the ${kind} command was discovered from the repository's own declarations and has `
          + 'not been executed, so it is what the repository says rather than what was '
          + 'observed to work',
          'repository',
          observation.observedAt,
          evidence,
        );
    }
    return {
      assertions,
      available: true,
      detail: 'commands determined',
      intendedScope: [WORKTREE],
    };
  },
};

/* ==================================================== the catalogue probes ==== */

export const manifestsProbe: SectionProbe = catalogueProbe({
  name: 'repo.manifests',
  section: 'repository',
  tier: 2,
  freshnessClass: 'repository',
  subject: 'manifests',
  globs: [...MANIFEST_GLOBS, ...LOCKFILE_GLOBS],
  build: (found, ctx) => ({
    manifest_paths: ctx.session.observedFact(
      ctx.probe,
      found.filter((p) => !LOCKFILE_GLOBS.some((g) => p.endsWith(g.replace('**/', '')))),
      ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    lockfiles: ctx.session.observedFact(
      ctx.probe,
      found.filter((p) => LOCKFILE_GLOBS.some((g) => p.endsWith(g.replace('**/', '')))),
      ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    /*
     * Dependency versions and known vulnerabilities need the manifest parsed and an advisory
     * source consulted. Neither is a path listing, and claiming an empty vulnerability list
     * from a listing would be a fabricated default of exactly the kind DATA_SEMANTICS names.
     */
    known_vulnerabilities: ctx.session.insufficient(
      ctx.probe,
      'the manifests were located and no advisory source was consulted, so nothing is known '
      + 'about vulnerabilities in them. An empty list here would be a fabricated default',
      'give AgentOS an advisory source, or run the ecosystem audit command and record its '
      + 'output as evidence',
      ctx.observedAt,
    ),
  }),
});

export const configurationProbe: SectionProbe = catalogueProbe({
  name: 'repo.configuration',
  section: 'repository',
  tier: 2,
  freshnessClass: 'repository',
  subject: 'configuration',
  globs: CONFIG_GLOBS,
  build: (found, ctx) => ({
    configuration_paths: ctx.session.observedFact(
      ctx.probe, found, ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    environment_files: ctx.session.observedFact(
      ctx.probe,
      found.filter((p) => /(^|\/)\.env/.test(p)),
      ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    /*
     * Values are deliberately not captured. Configuration is where credentials live, and the
     * package persists: the file is named and located, and what is in it is not copied.
     */
    configuration_values: ctx.session.notComputed(
      ctx.probe,
      'configuration files were located and their contents were not read into the package. '
      + 'Secrets are never captured and credentials are referenced by name and location only',
      'read a specific configuration value through a targeted probe when a decision needs it, '
      + 'so that the read is recorded and bounded',
      ctx.observedAt,
    ),
  }),
});

export const schemaProbe: SectionProbe = catalogueProbe({
  name: 'repo.schema',
  section: 'data_map',
  tier: 2,
  freshnessClass: 'repository',
  subject: 'stores',
  globs: SCHEMA_GLOBS,
  build: (found, ctx) => ({
    schema_paths: ctx.session.observedFact(
      ctx.probe,
      found.filter((p) => /\.(sql|prisma|graphql)$/i.test(p) || /(^|\/)(models|entities)\//i.test(p)),
      ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    migration_paths: ctx.session.observedFact(
      ctx.probe,
      found.filter((p) => /(^|\/)(migrations|migrate)\//i.test(p)),
      ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    /*
     * Which migrations have been applied is a property of a database, not of a repository.
     * The runtime probes own it, and answering it from the repository would be the
     * intent-for-reality substitution the whole model exists to refuse.
     */
    applied_migrations: ctx.session.notComputed(
      ctx.probe,
      'migration files were located in the repository; which of them a database has applied is '
      + 'a runtime fact and is not answerable from the repository',
      'give AgentOS runtime access to the database and re-probe applied-versus-pending state',
      ctx.observedAt,
    ),
  }),
});

export const domainProbe: SectionProbe = catalogueProbe({
  name: 'repo.domain',
  section: 'domain_model',
  tier: 2,
  freshnessClass: 'repository',
  subject: 'entities',
  globs: ['**/models/**', '**/entities/**', '**/domain/**', '**/*.entity.*', '**/*.model.*'],
  build: (found, ctx) => ({
    entity_paths: ctx.session.observedFact(
      ctx.probe, found, ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    /*
     * Canonical ownership is a claim about which store owns an entity, and two stores both
     * claiming one entity is a finding the Auditor raises. A path listing cannot establish it,
     * and a confident empty answer here would hide exactly that finding.
     */
    canonical_ownership: ctx.session.insufficient(
      ctx.probe,
      'entity definitions were located by path; which store canonically owns each entity needs '
      + 'the definitions read and the writers traced, which is the Auditor\'s work over the '
      + 'capability graph',
      'run the capability audit, or grant runtime access so ownership can be confirmed against '
      + 'real records',
      ctx.observedAt,
    ),
  }),
});

export const sourceMapProbe: SectionProbe = catalogueProbe({
  name: 'repo.sources',
  section: 'source_map',
  tier: 2,
  freshnessClass: 'repository',
  subject: 'sources',
  globs: SOURCE_GLOBS,
  build: (found, ctx) => ({
    integration_paths: ctx.session.observedFact(
      ctx.probe, found, ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    sources: ctx.session.derived(
      ctx.probe,
      directories(found, 2),
      ctx.evidence.map((e) => e.id),
      'external and internal source candidates read off the integration layout. A directory of '
      + 'clients is a fact; that each is a live source is a reading confirmed only by watching '
      + 'one respond',
      ctx.freshnessClass,
      ctx.observedAt,
      ctx.evidence,
    ),
    refresh_cadence: ctx.session.insufficient(
      ctx.probe,
      'source integrations were located and how often each refreshes is a scheduling fact that '
      + 'the repository layout does not carry',
      'read the scheduler definitions, or observe ingestion timestamps through the runtime '
      + 'adapter',
      ctx.observedAt,
    ),
  }),
});

export const apiProbe: SectionProbe = catalogueProbe({
  name: 'repo.api',
  section: 'api_map',
  tier: 2,
  freshnessClass: 'repository',
  subject: 'endpoints',
  globs: API_GLOBS,
  build: (found, ctx) => ({
    paths: ctx.session.observedFact(
      ctx.probe, found, ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    specifications: ctx.session.observedFact(
      ctx.probe,
      found.filter((p) => /(openapi|swagger)/i.test(p) || p.endsWith('.proto')),
      ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    endpoints: ctx.session.derived(
      ctx.probe,
      found.filter((p) => /(routes|controllers|handlers|endpoints|api)\//i.test(p)),
      ctx.evidence.map((e) => e.id),
      'endpoint-bearing files identified from the routing layout. Which endpoints they declare '
      + 'needs the files parsed, and whether those endpoints answer needs the runtime',
      ctx.freshnessClass,
      ctx.observedAt,
      ctx.evidence,
    ),
    consumers: ctx.session.insufficient(
      ctx.probe,
      'endpoint-bearing files were located; who calls each endpoint needs call sites traced '
      + 'across the repository and, for external consumers, traffic observed',
      'run the capability audit to trace consumers from code references, and confirm the '
      + 'critical edges against runtime traffic',
      ctx.observedAt,
    ),
  }),
});

export const uiProbe: SectionProbe = catalogueProbe({
  name: 'repo.ui',
  section: 'ui_map',
  tier: 2,
  freshnessClass: 'repository',
  subject: 'surfaces',
  globs: UI_GLOBS,
  build: (found, ctx) => ({
    surfaces: ctx.session.observedFact(
      ctx.probe,
      found.map((path) => ({ path })),
      ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    routes: ctx.session.derived(
      ctx.probe,
      found.filter((p) => /(^|\/)(pages|views|screens|routes)\//i.test(p)),
      ctx.evidence.map((e) => e.id),
      'route-bearing surfaces read off the layout convention; the routes themselves need the '
      + 'files parsed or the application exercised',
      ctx.freshnessClass,
      ctx.observedAt,
      ctx.evidence,
    ),
    empty_partial_stale_states: ctx.session.insufficient(
      ctx.probe,
      'surfaces were located; whether each honours empty, partial, stale and error states is a '
      + 'rendering question that a path listing cannot answer',
      'run the Product/UX review against the running surfaces',
      ctx.observedAt,
    ),
  }),
});

export const testsProbe: SectionProbe = catalogueProbe({
  name: 'repo.tests',
  section: 'tests',
  tier: 2,
  freshnessClass: 'repository',
  subject: 'suites',
  globs: TEST_GLOBS,
  build: (found, ctx) => ({
    suites: ctx.session.observedFact(
      ctx.probe, found, ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    suite_count: ctx.session.observedFact(
      ctx.probe, found.length, ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    /*
     * "What the tests actually assert on — real integrations, or mocks and fixtures" is the
     * question that makes this probe worth running, and it needs the test bodies read. Saying
     * so is more useful than a suite count presented as coverage.
     */
    asserts_on: ctx.session.insufficient(
      ctx.probe,
      'test files were located and their bodies were not analysed, so whether they assert on '
      + 'real integrations or on mocks and fixtures is not established',
      'read the suites in scope through a targeted probe, or run the capability audit which '
      + 'owns the test-asserts-on-mock finding',
      ctx.observedAt,
    ),
    coverage: ctx.session.insufficient(
      ctx.probe,
      'no coverage report was observed. A coverage number nobody measured is the archetypal '
      + 'fabricated default',
      'execute the test suite through the repository adapter and cite the coverage artifact it '
      + 'produces',
      ctx.observedAt,
    ),
  }),
});

export const cicdProbe: SectionProbe = catalogueProbe({
  name: 'repo.cicd',
  section: 'constraints',
  tier: 2,
  freshnessClass: 'repository',
  subject: 'pipelines',
  globs: CI_GLOBS,
  build: (found, ctx) => ({
    pipeline_definitions: ctx.session.observedFact(
      ctx.probe, found, ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    ci_configured: ctx.session.observedFact(
      ctx.probe, found.length > 0, ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    gates: ctx.session.insufficient(
      ctx.probe,
      'pipeline definitions were located and their gate and promotion rules were not parsed',
      'read the pipeline definitions in scope through a targeted probe',
      ctx.observedAt,
    ),
  }),
});

export const deploymentProbe: SectionProbe = catalogueProbe({
  name: 'repo.deployment',
  section: 'architecture',
  tier: 2,
  freshnessClass: 'repository',
  subject: 'deployment_definitions',
  globs: DEPLOYMENT_GLOBS,
  build: (found, ctx) => ({
    deployment_definitions: ctx.session.observedFact(
      ctx.probe, found, ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    containers: ctx.session.observedFact(
      ctx.probe,
      found.filter((p) => /docker/i.test(p)),
      ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    /*
     * Infrastructure definitions describe an intended topology. What is actually deployed is a
     * runtime fact, and the runtime probes own it; `runtime_state.environments` merges the two
     * with the declared side kept as the inference it is.
     */
    declared_environments: ctx.session.derived(
      ctx.probe,
      directories(found.filter((p) => /(helm|k8s|kubernetes|\.tf$|\.bicep$)/i.test(p)), 2),
      ctx.evidence.map((e) => e.id),
      'environment names read off infrastructure definitions. They are what the repository '
      + 'intends to exist, which is a different claim from what is running',
      ctx.freshnessClass,
      ctx.observedAt,
      ctx.evidence,
    ),
  }),
});

export const architectureProbe: SectionProbe = catalogueProbe({
  name: 'repo.architecture',
  section: 'architecture',
  tier: 2,
  freshnessClass: 'repository',
  subject: 'layering',
  globs: ['**/*'],
  build: (found, ctx) => ({
    module_tree: ctx.session.observedFact(
      ctx.probe, directories(found, 3), ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    layering: ctx.session.derived(
      ctx.probe,
      directories(found, 1),
      ctx.evidence.map((e) => e.id),
      'the top-level directories are the observed layering. Whether the code respects that '
      + 'layering is an import-graph question and is the Auditor\'s to answer',
      ctx.freshnessClass,
      ctx.observedAt,
      ctx.evidence,
    ),
    boundaries_enforced: ctx.session.insufficient(
      ctx.probe,
      'the module layout was observed and no import graph was built, so whether the boundaries '
      + 'are enforced or merely drawn is not established',
      'run the capability audit, which builds the graph and detects the crossings',
      ctx.observedAt,
    ),
  }),
});

export const documentationProbe: SectionProbe = catalogueProbe({
  name: 'repo.documentation',
  section: 'product',
  tier: 2,
  freshnessClass: 'repository',
  subject: 'documentation',
  globs: DOC_GLOBS,
  build: (found, ctx) => ({
    documentation_paths: ctx.session.observedFact(
      ctx.probe, found, ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    decision_records: ctx.session.observedFact(
      ctx.probe,
      found.filter((p) => /(^|\/)(adr|decisions)\//i.test(p)),
      ctx.evidence, ctx.freshnessClass, ctx.observedAt,
    ),
    /*
     * Documentation staleness is the comparison of a document's last-modified date against the
     * code it describes, and both dates are git facts. The git probes hold the commit history;
     * the comparison is the Auditor's stale-documentation finding.
     */
    documentation_freshness: ctx.session.insufficient(
      ctx.probe,
      'documents were located and their modification dates were not compared against the code '
      + 'they describe',
      'compare each document\'s last-modified commit with the commits touching what it '
      + 'describes, which the git history supports',
      ctx.observedAt,
    ),
    purpose: ctx.session.insufficient(
      ctx.probe,
      'documentation was located and not read, so what the system is for, who its users are '
      + 'and its domain vocabulary are not established from it',
      'read the located documentation through a targeted probe, and reconcile it against the '
      + 'project-management intent, which is a claim rather than a confirmation',
      ctx.observedAt,
    ),
  }),
});

export const conventionsProbe: SectionProbe = {
  name: 'repo.conventions',
  section: 'repository',
  tier: 2,
  freshnessClass: 'repository',
  async run(session, input) {
    const scopePaths = input.scope.paths;
    const result = await listing(
      session,
      'repo.conventions',
      ['**/.editorconfig', '**/.eslintrc*', '**/eslint.config.*', '**/.prettierrc*',
        '**/.stylelintrc*', '**/setup.cfg', '**/.flake8', '**/ruff.toml', '**/rustfmt.toml',
        '**/.rubocop.yml', '**/.clang-format', '**/CONTRIBUTING*', '**/.editorconfig'],
      scopePaths,
    );
    if (result.failure !== null) {
      return {
        assertions: {
          conventions: session.noAccess('repo.conventions', 'the repository conventions', result.failure),
        },
        available: false,
        detail: 'convention files could not be listed',
        intendedScope: scopePaths.length > 0 ? scopePaths : ['**/*'],
      };
    }
    const observedAt = session.nowIso();
    return {
      assertions: {
        convention_files: session.observedFact(
          'repo.conventions', result.found, result.evidence, 'repository', observedAt,
        ),
        /*
         * A linter configuration is a declared convention. The conventions an Implementer must
         * actually match — naming, error handling, logging, layering — are read off the code
         * itself, and a declared config is evidence about the declaration and not about the
         * code's adherence to it.
         */
        conventions: session.derived(
          'repo.conventions',
          { declared_by: result.found, enforced: result.found.length > 0 },
          result.evidence.map((e) => e.id),
          'the repository declares conventions through the located tool configurations. '
          + 'Whether the code follows them is a question about the code, and a change that is '
          + 'correct but foreign is a defect whichever way the config reads',
          'repository',
          observedAt,
          result.evidence,
        ),
      },
      available: true,
      detail: `${result.found.length} convention declaration(s)`,
      intendedScope: scopePaths.length > 0 ? scopePaths : ['**/*'],
    };
  },
};

/** Tier-1 repository orientation: identity, structure, stack. Enough to resolve, and no more. */
export const REPOSITORY_TIER_1: readonly SectionProbe[] = [
  identityProbe,
  structureProbe,
  stackProbe,
];

/** Tier-2 repository depth, scoped by the admitted work item. */
export const REPOSITORY_TIER_2: readonly SectionProbe[] = [
  commandsProbe,
  manifestsProbe,
  configurationProbe,
  conventionsProbe,
  schemaProbe,
  domainProbe,
  sourceMapProbe,
  apiProbe,
  uiProbe,
  testsProbe,
  cicdProbe,
  deploymentProbe,
  architectureProbe,
  documentationProbe,
];

/** Exported for the on-demand tier, which dispatches probes by name. */
export const REPOSITORY_PROBES: readonly SectionProbe[] = [
  ...REPOSITORY_TIER_1,
  ...REPOSITORY_TIER_2,
];
