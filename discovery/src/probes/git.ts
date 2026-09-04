import type { Assertion } from '@agentos/contracts';
import { ADAPTERS, OPS } from '../ops.js';
import type { SectionProbe } from '../probe.js';
import { asNumber, asString, records } from '../probe.js';

/**
 * The git probe set.
 *
 * Git is authoritative about two things and no others: **what the repository contains**, and
 * **whether a change is proposed** ([INTENT_AND_WORK_ITEM_RESOLUTION.md](../../../docs/INTENT_AND_WORK_ITEM_RESOLUTION.md)
 * section 5.1). Every assertion here stays inside that authority. What a branch *means*, what
 * a pull request *achieves*, whether a ticket should be closed — none of those are git's to
 * say, and none of them are said here.
 *
 * These probes fill `git_state`. The same underlying observations are read again by the
 * reality probes, against one work item, into `current_reality` — deliberately, because the
 * two answer different questions. `git_state.pull_requests` is "what is open on this
 * repository"; `current_reality.pr` is "is there a change proposed for *this work*", and the
 * second is what a resume decision turns on.
 */

const GIT = ADAPTERS.git;

/** Branches, with divergence and staleness where the adapter reports them. */
export const branchesProbe: SectionProbe = {
  name: 'git.branches',
  section: 'git_state',
  tier: 1,
  freshnessClass: 'git',
  async run(session, _input) {
    const availability = session.adapterState(GIT);
    const access = session.derived(
      'git.branches',
      availability,
      ['adapter.availability'],
      'the git adapter reports its own availability. An unreachable git host is a fact about '
      + 'access and emphatically not a statement that there are no branches',
      'git',
      session.nowIso(),
    );

    const observation = await session.observe({
      probe: 'git.branches',
      adapter: GIT,
      op: OPS.git.listBranches,
      args: {},
      kind: 'git',
      ref: `${GIT}.${OPS.git.listBranches}`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertions: {
          git_access: access,
          branches: session.noAccess('git.branches', 'the branch list', observation),
        },
        available: false,
        detail: 'branches could not be listed',
        intendedScope: [],
      };
    }

    const branches = records(observation.value);
    const evidence = [observation.evidence];
    return {
      assertions: {
        git_access: access,
        branches: session.observedFact(
          'git.branches', branches, evidence, 'git', observation.observedAt,
        ),
        branch_count: session.observedFact(
          'git.branches', branches.length, evidence, 'git', observation.observedAt,
        ),
        protected_branches: session.observedFact(
          'git.branches',
          branches.filter((b) => b['protected'] === true).map((b) => asString(b['name'])),
          evidence,
          'git',
          observation.observedAt,
        ),
      },
      available: true,
      detail: `${branches.length} branch(es)`,
      intendedScope: [],
    };
  },
};

/**
 * Commit history, and the count that `audit.applicable` reads.
 *
 * The count matters more than it looks: `audit.applicable` is `TRUE` when the repository has
 * any commit history, and an `UNKNOWN` count makes it `INDETERMINATE`, which keeps the audit
 * rather than skipping it. A zero invented because git was unreachable would skip an audit on
 * the strength of a failure to look.
 */
export const commitsProbe: SectionProbe = {
  name: 'git.commits',
  section: 'git_state',
  tier: 1,
  freshnessClass: 'git',
  async run(session, input) {
    const args = input.scope.paths.length > 0 ? { paths: [...input.scope.paths] } : {};
    const observation = await session.observe({
      probe: 'git.commits',
      adapter: GIT,
      op: OPS.git.log,
      args,
      kind: 'git',
      ref: `${GIT}.${OPS.git.log}`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertions: {
          commit_count: session.noAccess('git.commits', 'the commit history', observation),
          commits: session.noAccess('git.commits', 'the commit history', observation),
        },
        available: false,
        detail: 'the commit log could not be read',
        intendedScope: input.scope.paths,
      };
    }
    const commits = records(observation.value);
    const evidence = [observation.evidence];
    const authors = new Set<string>();
    for (const commit of commits) {
      const author = asString(commit['author']);
      if (author !== null) authors.add(author);
    }
    const head = asString(commits[0]?.['sha']);
    return {
      assertions: {
        commits: session.observedFact(
          'git.commits', commits.slice(0, 50), evidence, 'git', observation.observedAt,
        ),
        commit_count: session.observedFact(
          'git.commits', commits.length, evidence, 'git', observation.observedAt,
        ),
        /*
         * A repository with no commits has no HEAD, and that is structural absence rather
         * than a value nobody looked up. Recording it as a FACT whose value is null would
         * make an empty repository indistinguishable from an unread one.
         */
        head_sha: head === null
          ? session.insufficient(
            'git.commits',
            'the commit log was read and contains no commit, so there is no head to name',
            'commit something, or widen the log window if the scope filter excluded everything',
            observation.observedAt,
          )
          : session.observedFact('git.commits', head, evidence, 'git', observation.observedAt),
        authors: session.observedFact(
          'git.commits', [...authors].sort(), evidence, 'git', observation.observedAt,
        ),
      },
      available: true,
      detail: `${commits.length} commit(s) in the observed window`,
      intendedScope: input.scope.paths,
    };
  },
};

export const worktreesProbe: SectionProbe = {
  name: 'git.worktrees',
  section: 'git_state',
  tier: 2,
  freshnessClass: 'git',
  async run(session, _input) {
    const observation = await session.observe({
      probe: 'git.worktrees',
      adapter: GIT,
      op: OPS.git.listWorktrees,
      args: {},
      kind: 'git',
      ref: `${GIT}.${OPS.git.listWorktrees}`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertions: {
          worktrees: session.noAccess('git.worktrees', 'the worktree list', observation),
        },
        available: false,
        detail: 'worktrees could not be listed',
        intendedScope: [],
      };
    }
    const worktrees = records(observation.value);
    return {
      assertions: {
        worktrees: session.observedFact(
          'git.worktrees', worktrees, [observation.evidence], 'git', observation.observedAt,
        ),
      },
      available: true,
      detail: `${worktrees.length} worktree(s)`,
      intendedScope: [],
    };
  },
};

export const tagsProbe: SectionProbe = {
  name: 'git.tags',
  section: 'git_state',
  tier: 2,
  freshnessClass: 'git',
  async run(session, _input) {
    const observation = await session.observe({
      probe: 'git.tags',
      adapter: GIT,
      op: OPS.git.listTags,
      args: {},
      kind: 'git',
      ref: `${GIT}.${OPS.git.listTags}`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertions: { tags: session.noAccess('git.tags', 'the tag list', observation) },
        available: false,
        detail: 'tags could not be listed',
        intendedScope: [],
      };
    }
    const tags = records(observation.value);
    return {
      assertions: {
        tags: session.observedFact(
          'git.tags', tags, [observation.evidence], 'git', observation.observedAt,
        ),
        releases: session.derived(
          'git.tags',
          tags.filter((t) => t['release'] === true || asString(t['name'])?.startsWith('v') === true),
          [observation.evidence.id],
          'release history read from the tag names. A tag is a fact; that a given tag was a '
          + 'release is a reading of the naming convention',
          'git',
          observation.observedAt,
          [observation.evidence],
        ),
      },
      available: true,
      detail: `${tags.length} tag(s)`,
      intendedScope: [],
    };
  },
};

/** Where the repository is changing, which is where a change is most likely to collide. */
export const churnProbe: SectionProbe = {
  name: 'git.churn',
  section: 'git_state',
  tier: 2,
  freshnessClass: 'git',
  async run(session, input) {
    const args = input.scope.paths.length > 0 ? { paths: [...input.scope.paths] } : {};
    const observation = await session.observe({
      probe: 'git.churn',
      adapter: GIT,
      op: OPS.git.churn,
      args,
      kind: 'git',
      ref: `${GIT}.${OPS.git.churn}`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertions: {
          churn: session.noAccess('git.churn', 'recent change concentration', observation),
        },
        available: false,
        detail: 'churn could not be computed',
        intendedScope: input.scope.paths,
      };
    }
    return {
      assertions: {
        churn: session.observedFact(
          'git.churn',
          records(observation.value),
          [observation.evidence],
          'git',
          observation.observedAt,
        ),
      },
      available: true,
      detail: 'change concentration observed',
      intendedScope: input.scope.paths,
    };
  },
};

/** Open and recent pull requests on the repository, with their review outcomes. */
export const pullRequestsProbe: SectionProbe = {
  name: 'git.pull_requests',
  section: 'git_state',
  tier: 2,
  freshnessClass: 'git',
  async run(session, _input) {
    const observation = await session.observe({
      probe: 'git.pull_requests',
      adapter: GIT,
      op: OPS.git.listPullRequests,
      args: {},
      kind: 'git',
      ref: `${GIT}.${OPS.git.listPullRequests}`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertions: {
          pull_requests: session.noAccess(
            'git.pull_requests', 'the pull request list', observation,
          ),
        },
        available: false,
        detail: 'pull requests could not be listed',
        intendedScope: [],
      };
    }
    const prs = records(observation.value);
    const evidence = [observation.evidence];
    const assertions: Record<string, Assertion> = {
      pull_requests: session.observedFact(
        'git.pull_requests', prs, evidence, 'git', observation.observedAt,
      ),
      open_pull_requests: session.observedFact(
        'git.pull_requests',
        prs.filter((pr) => pr['state'] === 'OPEN'),
        evidence,
        'git',
        observation.observedAt,
      ),
    };
    const reviewed = prs.filter((pr) => (asNumber(pr['review_count']) ?? 0) > 0);
    assertions['review_patterns'] = session.derived(
      'git.pull_requests',
      { pull_requests: prs.length, with_reviews: reviewed.length },
      evidence.map((e) => e.id),
      'the proportion of observed pull requests carrying a review. It describes the '
      + "repository's habit and says nothing about any particular change",
      'git',
      observation.observedAt,
      evidence,
    );
    return {
      assertions,
      available: true,
      detail: `${prs.length} pull request(s)`,
      intendedScope: [],
    };
  },
};

export const GIT_TIER_1: readonly SectionProbe[] = [branchesProbe, commitsProbe];

export const GIT_TIER_2: readonly SectionProbe[] = [
  worktreesProbe,
  tagsProbe,
  churnProbe,
  pullRequestsProbe,
];

export const GIT_PROBES: readonly SectionProbe[] = [...GIT_TIER_1, ...GIT_TIER_2];
