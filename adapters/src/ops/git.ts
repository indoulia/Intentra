import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterAvailability } from '@agentos/contracts';
import { fact, inference, selfEvidence, unavailable, unknown } from '../assertions.js';
import {
  INTEGER_ARG,
  OPTIONAL_STRING_ARG,
  PATH_LIST_ARG,
  STRING_ARG,
  STRING_LIST_ARG,
  readOnlyOperation,
} from '../define.js';
import type { OperationInvocation, OperationRegistration } from '../descriptors.js';
import { ConfinementAbort } from '../framework.js';
import { ResourceAbsentError, ResourceUnreachableError, isAbsent, messageOf } from '../errors.js';
import type { AvailabilityProbe, Connector, ProcessRunner } from '../ports.js';
import { DANGEROUS_VALUE, classify } from '../classification.js';
import type { ClassificationObservation, ClassificationProbe } from '../classification.js';

/**
 * The git adapter: branches, commits, worktrees, pull requests, review threads and CI state.
 *
 * Every resume decision depends on what this reports. The kernel computes the entry stage by
 * walking the frozen graph against Current Reality, and Current Reality comes from here and
 * from the project-management adapter — never from an agent's account of a previous run. That
 * is why the failure mode this file is written against is not "the host is down" but "the
 * host is down and we reported `false`".
 *
 * **Where a pull-request or CI host is not reachable, the answer is `UNAVAILABLE`.** Never
 * absent, never `false`. "There is no pull request" and "the pull-request host would not
 * answer" lead to opposite decisions: the first says implementation has not been submitted,
 * the second says nothing at all and must not be allowed to look like the first.
 */

export interface GitOptions {
  readonly worktreeRoot: string;
  readonly runner: ProcessRunner;
  /** The pull-request and CI host, or `null` where none is configured. */
  readonly host: Connector | null;
  readonly timeoutMs?: number;
}

const ADAPTER = 'git';
/** The field separator git writes for %x1f, named so no editor rewrites the literal. */
const UNIT_SEPARATOR = String.fromCharCode(31);
const DEFAULT_TIMEOUT_MS = 20_000;

/** The branch listing, and the remote HEAD that says which of them is the default. */
const BRANCH_LIST_ARGS = [
  'branch', '--all', `--format=%(refname)%1f%(refname:short)`,
] as const;
const DEFAULT_BRANCH_ARGS = ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'] as const;

/**
 * A list argument, narrowed to the non-empty strings it holds.
 *
 * An absent list and an empty one mean the same thing to every caller here — do not narrow by
 * this — so both arrive as `[]` and no handler has to tell them apart.
 */
function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * A path-list argument, confined element by element, as worktree-relative paths.
 *
 * The framework confines every element of a list argument before the handler runs, but it
 * keys its resolved-path map by argument name, which a list cannot use. Confining again here
 * is what lets a handler hand a path to git having seen its verdict rather than having assumed
 * one — and it is where the worktree-relative form comes from, which is what a pathspec wants.
 */
function confinedList(invocation: OperationInvocation, name: string): readonly string[] {
  const out: string[] = [];
  for (const requested of stringList(invocation.args[name])) {
    const verdict = invocation.confine(requested);
    if (verdict.outcome === 'REFUSED') throw new ConfinementAbort(verdict);
    out.push(verdict.relative);
  }
  return out;
}

/** `-- a b c`, or nothing. The separator is what stops a path being read as a revision. */
function pathspec(paths: readonly string[]): readonly string[] {
  return paths.length === 0 ? [] : ['--', ...paths];
}

export function gitOperations(options: GitOptions): readonly OperationRegistration[] {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const git = async (args: readonly string[]): Promise<string> => {
    const result = await options.runner.run('git', args, {
      cwd: options.worktreeRoot,
      timeoutMs,
    });
    if (!result.started) {
      throw new ResourceUnreachableError(
        'git',
        `git could not be started in ${options.worktreeRoot}: ${result.stderr}`,
      );
    }
    if (result.code !== 0) {
      throw new ResourceUnreachableError(
        'git',
        `git ${args.join(' ')} exited ${String(result.code)}: ${result.stderr.trim()}`,
      );
    }
    return result.stdout;
  };

  /**
   * Reaches the pull-request or CI host, or explains which kind of silence this is.
   *
   * Three outcomes, kept apart all the way to the Context Package: not configured, configured
   * and unreachable, and answered.
   */
  const viaHost = async (
    resource: string,
    args: Readonly<Record<string, unknown>>,
    probe: string,
    at: string,
  ): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly assertion: ReturnType<typeof unknown> }> => {
    if (options.host === null || !options.host.configured) {
      return {
        ok: false,
        assertion: unknown(
          probe, at, 'UNAVAILABLE',
          'configure a pull-request and CI host for this repository, or accept that resume '
          + 'decisions depending on review and CI state cannot be made from observation',
          'no pull-request or CI host is configured on this repository',
        ),
      };
    }
    try {
      return { ok: true, value: await options.host.fetch(resource, args) };
    } catch (error) {
      if (isAbsent(error)) {
        return {
          ok: true,
          value: { present: false, detail: messageOf(error) },
        };
      }
      return {
        ok: false,
        assertion: unavailable(
          probe, at,
          'restore access to the pull-request and CI host. Until then the state of review and '
          + 'CI is unknown, which is a fact about access and not a fact about the work',
          messageOf(error),
        ),
      };
    }
  };

  const local = (
    op: string,
    description: string,
    args: readonly string[],
    parse: (stdout: string) => unknown,
  ): OperationRegistration => readOnlyOperation({
    adapter: ADAPTER,
    op,
    description,
    evidenceKind: 'git',
    observationSafe: true,
    handler: async (invocation) => {
      const at = invocation.now.toISOString();
      try {
        const stdout = await git(args);
        const value = parse(stdout);
        /* The evidence for a git observation is the command that made it, which the kernel
         * can run again and compare. That is what makes it a FACT rather than a claim. */
        const evidence = selfEvidence({
          adapter: ADAPTER,
          op,
          args: invocation.args,
          kind: 'git',
          ref: `git ${args.join(' ')}`,
          excerpt: stdout.trim(),
          observedAt: at,
        });
        return { value: fact(value, `${ADAPTER}.${op}`, at, evidence), excerpt: stdout.trim() };
      } catch (error) {
        /*
         * A git command that would not run leaves the answer unknown, not false. Reporting
         * "no branches" because git was missing is exactly the shape of lie the whole
         * evidence model exists to prevent.
         */
        return {
          value: unavailable(
            `${ADAPTER}.${op}`, at,
            'make git available on this host and grant read access to the repository metadata',
            messageOf(error),
          ),
          excerpt: `git ${args.join(' ')}: unavailable`,
        };
      }
    },
  });

  return [
    local(
      'current_branch',
      'The branch HEAD points at, or the commit where HEAD is detached.',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      (stdout) => stdout.trim(),
    ),
    readOnlyOperation({
      adapter: ADAPTER,
      op: 'list_branches',
      description:
        'Every local and remote branch: its short ref name, whether it is the default branch, '
        + 'and whether it is protected. Protection fails closed, and each branch carries the '
        + 'classification that says whether that was observed or assumed.',
      evidenceKind: 'git',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const probe = `${ADAPTER}.list_branches`;
        let stdout: string;
        try {
          stdout = await git(BRANCH_LIST_ARGS);
        } catch (error) {
          return {
            value: unavailable(
              probe, at,
              'make git available on this host and grant read access to the repository metadata',
              messageOf(error),
            ),
            excerpt: `git ${BRANCH_LIST_ARGS.join(' ')}: unavailable`,
          };
        }

        const names = stdout.split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => line.split(UNIT_SEPARATOR))
          /*
           * A remote's HEAD is a symbolic pointer at a branch, not a branch. It is excluded on
           * its **full** ref name, because the short form of `refs/remotes/origin/HEAD` is
           * `origin` — a plausible-looking branch name that is no branch at all, and one that
           * would otherwise be listed, counted, and asked about by the protection classifier.
           */
          .filter(([full]) => full !== undefined && !full.endsWith('/HEAD'))
          .map(([, short]) => short)
          .filter((short): short is string => short !== undefined && short.length > 0);

        /*
         * Which of them is the default, from the remote's own HEAD. Where that is not
         * readable, no branch is marked: `default` is left off every record rather than set
         * to `false`, because "this is not the default branch" is a claim and nothing here
         * established it. A reader looking for the base branch then finds none and says so.
         */
        let defaultRef: string | null = null;
        let defaultDetail = 'the remote HEAD is not readable, so no branch is marked default';
        try {
          const short = (await git(DEFAULT_BRANCH_ARGS)).trim().replace(/^origin\//, '');
          defaultRef = names.find((name) => name === short)
            ?? names.find((name) => name === `origin/${short}`)
            ?? null;
          defaultDetail = defaultRef === null
            ? `the remote HEAD names ${short}, which is not among the listed branches`
            : `the remote HEAD names ${short}`;
        } catch (error) {
          defaultDetail = `the remote HEAD could not be read: ${messageOf(error)}`;
        }

        /*
         * Attachment step 8, per branch. Protection lives on the VCS host and not in the
         * checkout, so with no host configured nothing is established and every branch comes
         * back protected at UNKNOWN confidence with `failed_closed: true`
         * (REPOSITORY_ADAPTER 2.2). The flag is what a caller gates on; the classification
         * beside it is what keeps "this branch really is protected" distinguishable from
         * "we could not find out", which is the distinction the whole rule rests on.
         */
        const protection = branchProtectionProbe(options);
        const branches: Array<Readonly<Record<string, unknown>>> = [];
        for (const name of names) {
          const classification = classify(
            'branch_protection', name, await protection.probe(name),
          );
          branches.push({
            name,
            ...(defaultRef === null ? {} : { default: name === defaultRef }),
            protected: classification.value === DANGEROUS_VALUE.branch_protection,
            protection: classification,
          });
        }

        const evidence = selfEvidence({
          adapter: ADAPTER,
          op: 'list_branches',
          args: invocation.args,
          kind: 'git',
          ref: `git ${BRANCH_LIST_ARGS.join(' ')}`,
          excerpt: stdout.trim(),
          observedAt: at,
        });
        return {
          value: fact(branches, probe, at, evidence),
          excerpt: `${String(branches.length)} branch(es); ${defaultDetail}`,
        };
      },
    }),
    local(
      'remotes',
      'Configured remotes and their fetch and push URLs.',
      ['remote', '-v'],
      (stdout) => stdout.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [name, url, direction] = line.split(/\s+/);
          return { name: name ?? '', url: url ?? '', direction: (direction ?? '').replace(/[()]/g, '') };
        }),
    ),
    local(
      'default_branch',
      "The remote's default branch, from its HEAD symbolic ref.",
      [...DEFAULT_BRANCH_ARGS],
      (stdout) => stdout.trim().replace(/^origin\//, ''),
    ),
    local(
      'status',
      'The working tree state, in porcelain form.',
      ['status', '--porcelain=v1', '--branch'],
      (stdout) => {
        const lines = stdout.split('\n').filter((line) => line.length > 0);
        const branchLine = lines.find((line) => line.startsWith('##')) ?? '';
        const changes = lines.filter((line) => !line.startsWith('##'));
        return { branch: branchLine.replace(/^##\s*/, ''), changes, clean: changes.length === 0 };
      },
    ),
    local(
      'list_worktrees',
      'Every worktree attached to this repository.',
      ['worktree', 'list', '--porcelain'],
      (stdout) => stdout.split(/\n\s*\n/)
        .map((block) => block.trim())
        .filter((block) => block.length > 0)
        .map((block) => {
          const entry: Record<string, string> = {};
          for (const line of block.split('\n')) {
            const [key, ...rest] = line.trim().split(' ');
            if (key !== undefined && key.length > 0) entry[key] = rest.join(' ');
          }
          return entry;
        }),
    ),

    local(
      'list_tags',
      'Every tag, newest first, which is how a release history is read.',
      ['tag', '--list', '--sort=-creatordate'],
      (stdout) => stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
    ),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'churn',
      description:
        'Which paths changed most over a window of commits, optionally restricted to a set of '
        + 'paths. Change concentration is an observation about where work has been happening, '
        + 'not a judgement about quality.',
      /*
       * `paths` is what makes this answerable about a work item rather than about the
       * repository: "where is the churn" is a different question from "where is the churn in
       * the code I am allowed to touch". It is a path argument, so every element is confined
       * against the worktree root, the dispatch mandate and the deny-list before it reaches
       * git's pathspec.
       */
      args: { limit: INTEGER_ARG, paths: PATH_LIST_ARG },
      evidenceKind: 'git',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const limit = typeof invocation.args['limit'] === 'number' ? invocation.args['limit'] : 200;
        const paths = confinedList(invocation, 'paths');
        try {
          const stdout = await git([
            'log', `--max-count=${String(limit)}`, '--numstat', '--format=%H',
            ...pathspec(paths),
          ]);
          const counts = new Map<string, { commits: number; added: number; removed: number }>();
          for (const line of stdout.split('\n')) {
            const parts = line.trim().split(/\t+/);
            if (parts.length !== 3) continue;
            const [added, removed, path] = parts;
            if (path === undefined || path.length === 0) continue;
            const entry = counts.get(path) ?? { commits: 0, added: 0, removed: 0 };
            entry.commits += 1;
            entry.added += Number(added) || 0;
            entry.removed += Number(removed) || 0;
            counts.set(path, entry);
          }
          const value = [...counts.entries()]
            .map(([path, entry]) => ({ path, ...entry }))
            .sort((a, b) => b.commits - a.commits || (a.path < b.path ? -1 : 1));
          return {
            value: fact(value, 'git.churn', at, selfEvidence({
              adapter: ADAPTER,
              op: 'churn',
              args: invocation.args,
              kind: 'git',
              ref: `git log --numstat over ${String(limit)} commits`,
              excerpt: value.slice(0, 40).map((e) => `${String(e.commits)} ${e.path}`).join('\n'),
              observedAt: at,
            })),
            excerpt: value.slice(0, 40).map((e) => `${String(e.commits)} ${e.path}`).join('\n'),
          };
        } catch (error) {
          return {
            value: unavailable(
              'git.churn', at,
              'make git available and grant read access to the repository history',
              messageOf(error),
            ),
            excerpt: 'git churn: unavailable',
          };
        }
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'merge_state',
      description:
        'Whether a ref has been merged into its base, from the VCS host where one is '
        + 'configured and from the local history otherwise. Never inferred from a green '
        + 'pipeline.',
      /*
       * `ref`/`base` is the pair the local history can settle with an ancestor test, so it is
       * what makes this answerable with no VCS host at all. `pull_request` is the host's own
       * identifier for the same question and is passed straight through where one is known —
       * a host knows whether a merge was recorded, which reachability does not say.
       */
      args: {
        ref: STRING_ARG,
        base: OPTIONAL_STRING_ARG,
        pull_request: OPTIONAL_STRING_ARG,
      },
      evidenceKind: 'git',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const ref = typeof invocation.args['ref'] === 'string' && invocation.args['ref'].length > 0
          ? invocation.args['ref']
          : null;
        const base = typeof invocation.args['base'] === 'string' && invocation.args['base'].length > 0
          ? invocation.args['base']
          : null;
        const pullRequest = typeof invocation.args['pull_request'] === 'string'
          ? invocation.args['pull_request']
          : null;
        if (ref === null && pullRequest === null) {
          /* Nothing to ask about. `String(undefined)` would have asked the host about a ref
           * named "undefined" and reported whatever came back as this change's merge state. */
          return {
            value: unknown(
              'git.merge_state', at, 'INSUFFICIENT_EVIDENCE',
              'name the ref whose merge state is wanted, or the pull request the host knows it '
              + 'by. Neither names a change',
              'neither a ref nor a pull request was supplied',
            ),
            excerpt: 'merge state: nothing was named',
          };
        }

        const hosted = await viaHost('merge_state', invocation.args, 'git.merge_state', at);
        if (hosted.ok) {
          return {
            value: fact(hosted.value, 'git.merge_state', at, selfEvidence({
              adapter: ADAPTER,
              op: 'merge_state',
              args: invocation.args,
              kind: 'git',
              ref: `merge state of ${ref ?? String(pullRequest)}`,
              excerpt: JSON.stringify(hosted.value),
              observedAt: at,
            })),
            excerpt: JSON.stringify(hosted.value),
          };
        }

        /*
         * No host, or a host that would not answer. The local history can still settle it
         * where a base is named: an ancestor test is an observation, and it is a weaker one
         * than the host's because it says nothing about how the merge was recorded.
         */
        if (base === null || ref === null) {
          return { value: hosted.assertion, excerpt: 'merge state: unavailable' };
        }
        try {
          const result = await options.runner.run(
            'git', ['merge-base', '--is-ancestor', ref, base],
            { cwd: options.worktreeRoot, timeoutMs },
          );
          if (!result.started) {
            return { value: hosted.assertion, excerpt: 'merge state: unavailable' };
          }
          /* Exit 0 means merged, exit 1 means not; anything else establishes nothing. */
          if (result.code !== 0 && result.code !== 1) {
            return { value: hosted.assertion, excerpt: 'merge state: unavailable' };
          }
          const merged = result.code === 0;
          return {
            value: inference({ ref, base, merged }, 'git.merge_state', at,
              'read from the local history with git merge-base --is-ancestor. It observes '
              + 'reachability rather than the host\'s merge record, so it is an inference '
              + 'until the host confirms it',
              selfEvidence({
                adapter: ADAPTER,
                op: 'merge_state',
                args: invocation.args,
                kind: 'git',
                ref: `git merge-base --is-ancestor ${ref} ${base}`,
                excerpt: String(merged),
                observedAt: at,
              })),
            excerpt: `${ref} merged into ${base}: ${String(merged)}`,
          };
        } catch (error) {
          return {
            value: unavailable(
              'git.merge_state', at,
              'configure a VCS host, or make git available so the local history can be read',
              messageOf(error),
            ),
            excerpt: 'merge state: unavailable',
          };
        }
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'log',
      description:
        'Commits reachable from a ref and not from another, newest first, optionally '
        + 'restricted to a set of paths and to subjects containing given text.',
      /*
       * Four narrowings, and each one is the difference between "the repository has commits"
       * and "this work item has an implementation".
       *
       * - `not` excludes what the base branch already had, which is the only way to see the
       *   commits a branch actually contributed rather than everything it inherited.
       * - `paths` restricts to the work item's scope. A path argument, so every element is
       *   confined before it becomes a pathspec.
       * - `message_contains` matches commit subjects against the work item's identity tokens,
       *   which is how a commit is recognised as belonging to a ticket in a repository whose
       *   branch names say nothing. The tokens are matched literally, never as expressions.
       *
       * Doing this narrowing in the adapter rather than in the caller is not a convenience:
       * `git log` can answer the narrow question directly, and a caller that had to read the
       * whole history and filter it would be citing evidence for one claim and drawing another.
       */
      args: {
        ref: OPTIONAL_STRING_ARG,
        limit: INTEGER_ARG,
        not: STRING_ARG,
        paths: PATH_LIST_ARG,
        message_contains: STRING_LIST_ARG,
      },
      evidenceKind: 'git',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const ref = typeof invocation.args['ref'] === 'string' && invocation.args['ref'].length > 0
          ? invocation.args['ref']
          : 'HEAD';
        const excluded = typeof invocation.args['not'] === 'string' && invocation.args['not'].length > 0
          ? invocation.args['not']
          : null;
        const limit = typeof invocation.args['limit'] === 'number' ? invocation.args['limit'] : 25;
        const paths = confinedList(invocation, 'paths');
        const tokens = stringList(invocation.args['message_contains']);
        const format = '%H%x1f%an%x1f%aI%x1f%s';
        /* `base..ref` rather than `ref ^base`: one revision argument, no shell metacharacter,
         * and the same meaning on every platform. */
        const range = excluded === null ? ref : `${excluded}..${ref}`;
        try {
          const stdout = await git([
            'log',
            `--max-count=${String(limit)}`,
            `--format=${format}`,
            /* Literal, so a ticket key with a dot or a bracket in it is not an expression. */
            ...(tokens.length > 0 ? ['--fixed-strings', ...tokens.map((t) => `--grep=${t}`)] : []),
            range,
            ...pathspec(paths),
          ]);
          const commits = stdout.split('\n')
            .filter((line) => line.length > 0)
            .map((line) => {
              const [sha, author, authoredAt, subject] = line.split(UNIT_SEPARATOR);
              return {
                sha: sha ?? '',
                author: author ?? '',
                authored_at: authoredAt ?? '',
                subject: subject ?? '',
              };
            });
          const evidence = selfEvidence({
            adapter: ADAPTER,
            op: 'log',
            args: invocation.args,
            kind: 'git',
            ref: `git log ${range}`,
            excerpt: stdout.trim(),
            observedAt: at,
          });
          return { value: fact(commits, 'git.log', at, evidence), excerpt: stdout.trim() };
        } catch (error) {
          return {
            value: unavailable(
              'git.log', at,
              'make git available and grant read access to the repository history',
              messageOf(error),
            ),
            excerpt: 'git log: unavailable',
          };
        }
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'read_pr',
      description:
        'Reads one pull request from the VCS host. Throws absent when the pull request is '
        + 'gone and unreachable when the host will not answer, which is what makes it usable '
        + 'as an idempotency re-read.',
      args: { id: STRING_ARG },
      required: ['id'],
      evidenceKind: 'http',
      observationSafe: true,
      handler: async (invocation) => {
        const id = String(invocation.args['id']);
        if (options.host === null || !options.host.configured) {
          throw new ResourceUnreachableError(
            id,
            'no pull-request host is configured, so whether this pull request exists cannot '
            + 'be established. Unreachable is not absent',
          );
        }
        const value = await options.host.fetch('pull_request', { id });
        if (value === null || value === undefined) {
          throw new ResourceAbsentError(id, `pull request ${id} does not exist on the host`);
        }
        const at = invocation.now.toISOString();
        return {
          value: fact(value, 'git.read_pr', at, selfEvidence({
            adapter: ADAPTER,
            op: 'read_pr',
            args: { id },
            kind: 'http',
            ref: `pull request ${id}`,
            excerpt: JSON.stringify(value),
            observedAt: at,
          })),
          excerpt: JSON.stringify(value),
          externalLocator: { adapter: ADAPTER, op: 'read_pr', args: { id } },
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'list_prs',
      description:
        'Pull requests on this repository, optionally narrowed by state, by head branch and '
        + 'by search tokens, or an explicit UNAVAILABLE.',
      /*
       * `search` carries the work item's identity tokens. Finding the pull request for a work
       * item by listing every pull request and filtering locally would be the same answer with
       * a worse failure mode: on a busy repository the listing truncates, and a truncated
       * listing that matched nothing is indistinguishable from a work item with no pull
       * request. Handing the tokens to the host makes the narrowing the host's, where the
       * index is.
       */
      args: {
        state: OPTIONAL_STRING_ARG,
        head: OPTIONAL_STRING_ARG,
        search: STRING_LIST_ARG,
      },
      evidenceKind: 'http',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await viaHost('pull_requests', invocation.args, 'git.list_prs', at);
        if (!result.ok) return { value: result.assertion, excerpt: 'pull requests: unavailable' };
        return {
          value: fact(result.value, 'git.list_prs', at, selfEvidence({
            adapter: ADAPTER,
            op: 'list_prs',
            args: invocation.args,
            kind: 'http',
            ref: 'git.list_prs',
            excerpt: JSON.stringify(result.value),
            observedAt: at,
          })),
          excerpt: JSON.stringify(result.value),
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'list_reviews',
      description: 'Reviews and review threads on a pull request, or an explicit UNAVAILABLE.',
      args: { pull_request: STRING_ARG },
      required: ['pull_request'],
      evidenceKind: 'http',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await viaHost('review_threads', invocation.args, 'git.list_reviews', at);
        if (!result.ok) return { value: result.assertion, excerpt: 'review threads: unavailable' };
        return {
          value: fact(result.value, 'git.list_reviews', at, selfEvidence({
            adapter: ADAPTER,
            op: 'list_reviews',
            args: invocation.args,
            kind: 'http',
            ref: 'git.list_reviews',
            excerpt: JSON.stringify(result.value),
            observedAt: at,
          })),
          excerpt: JSON.stringify(result.value),
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'ci_status',
      description:
        'The CI verdict for a ref. With no CI reachable the answer is UNAVAILABLE and '
        + 'validation is local only, which the report has to say.',
      args: { ref: STRING_ARG },
      required: ['ref'],
      evidenceKind: 'http',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await viaHost('ci_state', invocation.args, 'git.ci_status', at);
        if (!result.ok) return { value: result.assertion, excerpt: 'ci state: unavailable' };
        return {
          value: fact(result.value, 'git.ci_status', at, selfEvidence({
            adapter: ADAPTER,
            op: 'ci_status',
            args: invocation.args,
            kind: 'http',
            ref: 'git.ci_status',
            excerpt: JSON.stringify(result.value),
            observedAt: at,
          })),
          excerpt: JSON.stringify(result.value),
        };
      },
    }),
  ];
}

/**
 * Availability for git, in four states that are genuinely different.
 *
 * No `.git` and no git binary is `NOT_CONFIGURED` — there is nothing here to reach. A git
 * that is present and fails is `UNAVAILABLE`. The distinction is the one the whole
 * availability vocabulary exists for, and collapsing it would turn a broken install into a
 * repository that simply has no version control.
 */
export function gitAvailability(options: GitOptions): AvailabilityProbe {
  return {
    adapter: 'git',
    async probe(): Promise<Omit<AdapterAvailability, 'checked_at'>> {
      if (!existsSync(join(options.worktreeRoot, '.git'))) {
        return {
          adapter: 'git',
          state: 'NOT_CONFIGURED',
          detail: `${options.worktreeRoot} is not a git checkout`,
        };
      }
      const result = await options.runner.run('git', ['--version'], {
        cwd: options.worktreeRoot,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      if (!result.started) {
        return {
          adapter: 'git',
          state: 'NOT_CONFIGURED',
          detail: 'no git executable is available on this host',
        };
      }
      if (result.code !== 0) {
        return {
          adapter: 'git',
          state: 'UNAVAILABLE',
          detail: `git is present and did not run: ${result.stderr.trim()}`,
        };
      }
      const hosted = options.host !== null && options.host.configured;
      return {
        adapter: 'git',
        state: 'AVAILABLE',
        detail: hosted
          ? `${result.stdout.trim()}, with a pull-request and CI host configured`
          : `${result.stdout.trim()}, with no pull-request or CI host configured: review and `
            + 'CI state will be UNAVAILABLE rather than absent',
      };
    },
  };
}

/**
 * The branch-protection classifier.
 *
 * Protection lives on the VCS host, not in the checkout, so with no host configured nothing
 * can be established and the answer is `PROTECTED` at `UNKNOWN` confidence with
 * `failed_closed: true`. That is the value `policies/data/gates.json` fires `MERGE_PROTECTED`
 * on, and it has to be: a classification that came back saying "we could not tell" would
 * match no classifier, fire no gate, and quietly invert the rule it was written to enforce.
 *
 * Where the host does answer, the answer is a `FACT` and `failed_closed` is false — including
 * when the answer is `PROTECTED`, because "this branch really is protected" and "we could not
 * find out" are different situations and only one of them is fixed by granting access.
 */
export function branchProtectionProbe(options: GitOptions): ClassificationProbe {
  return {
    kind: 'branch_protection',
    async probe(subject: string): Promise<ClassificationObservation> {
      if (options.host === null || !options.host.configured) {
        return {
          established: false,
          detail:
            `no VCS host is configured, so whether ${subject} is protected cannot be read. `
            + 'Branch protection is a property of the host and not of the checkout',
        };
      }
      let record: unknown;
      try {
        record = await options.host.fetch('branch_protection', { branch: subject });
      } catch (error) {
        if (isAbsent(error)) {
          return {
            established: false,
            detail:
              `the host reports no protection record for ${subject}. An absent record is not `
              + 'a statement that the branch is unprotected: it is the absence of one',
          };
        }
        return {
          established: false,
          detail: `the host would not report protection for ${subject}: ${messageOf(error)}`,
        };
      }
      if (record === null || typeof record !== 'object'
        || typeof (record as { protected?: unknown }).protected !== 'boolean') {
        return {
          established: false,
          detail: `the host's protection record for ${subject} does not state whether it is protected`,
        };
      }
      return {
        established: true,
        dangerous: (record as { protected: boolean }).protected,
        confidence: 'FACT',
        detail:
          `the VCS host reports ${subject} protected=`
          + String((record as { protected: boolean }).protected),
      };
    },
  };
}
