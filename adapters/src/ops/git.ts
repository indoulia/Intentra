import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterAvailability } from '@agentos/contracts';
import { fact, inference, selfEvidence, unavailable, unknown } from '../assertions.js';
import { INTEGER_ARG, OPTIONAL_STRING_ARG, STRING_ARG, readOnlyOperation } from '../define.js';
import type { OperationRegistration } from '../descriptors.js';
import { ResourceAbsentError, ResourceUnreachableError, isAbsent, messageOf } from '../errors.js';
import type { AvailabilityProbe, Connector, ProcessRunner } from '../ports.js';
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
    local(
      'list_branches',
      'Every local and remote branch, by short ref name.',
      ['branch', '--all', '--format=%(refname:short)'],
      (stdout) => stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
    ),
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
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
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
        'Which paths changed most over a window of commits. Change concentration is an '
        + 'observation about where work has been happening, not a judgement about quality.',
      args: { limit: INTEGER_ARG },
      evidenceKind: 'git',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const limit = typeof invocation.args['limit'] === 'number' ? invocation.args['limit'] : 200;
        try {
          const stdout = await git([
            'log', `--max-count=${String(limit)}`, '--numstat', '--format=%H',
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
      args: { ref: STRING_ARG, base: OPTIONAL_STRING_ARG },
      evidenceKind: 'git',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const ref = String(invocation.args['ref']);
        const base = typeof invocation.args['base'] === 'string' && invocation.args['base'].length > 0
          ? invocation.args['base']
          : null;

        const hosted = await viaHost('merge_state', invocation.args, 'git.merge_state', at);
        if (hosted.ok) {
          return {
            value: fact(hosted.value, 'git.merge_state', at, selfEvidence({
              adapter: ADAPTER,
              op: 'merge_state',
              args: invocation.args,
              kind: 'git',
              ref: `merge state of ${ref}`,
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
        if (base === null) {
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
      description: 'Commits reachable from a ref, newest first.',
      args: { ref: OPTIONAL_STRING_ARG, limit: INTEGER_ARG },
      evidenceKind: 'git',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const ref = typeof invocation.args['ref'] === 'string' && invocation.args['ref'].length > 0
          ? invocation.args['ref']
          : 'HEAD';
        const limit = typeof invocation.args['limit'] === 'number' ? invocation.args['limit'] : 25;
        const format = '%H%x1f%an%x1f%aI%x1f%s';
        try {
          const stdout = await git(['log', `--max-count=${String(limit)}`, `--format=${format}`, ref]);
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
            ref: `git log ${ref}`,
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
      description: 'Pull requests on this repository, or an explicit UNAVAILABLE.',
      args: { state: OPTIONAL_STRING_ARG, head: OPTIONAL_STRING_ARG },
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
