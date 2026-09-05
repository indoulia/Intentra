import type { Assertion } from '@agentos/contracts';
import { ADAPTERS, OPS } from '../ops.js';
import type { SectionProbe } from '../probe.js';
import { asNumber, asString, records } from '../probe.js';
import { namedRecords, observe } from './observation.js';

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

    const observation = await observe(session, {
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
    /*
     * A listing that carried entries and no branch records is not an empty repository.
     *
     * It is the one shape that must not degrade quietly here: a bare list of ref names would
     * leave every `protected` flag `undefined`, no branch would be collected as protected, and
     * the section would read "nothing here is protected" — a fail-open answer produced by a
     * failure to read, which is the exact inversion of the rule the classification enforces.
     * So the gap is stated instead.
     */
    if (branches.length === 0 && Array.isArray(observation.value) && observation.value.length > 0) {
      const gap = session.insufficient(
        'git.branches',
        `${GIT}.${OPS.git.listBranches} listed ${String(observation.value.length)} entr(ies) and `
        + 'none of them is a branch record, so neither the names nor their protection could be '
        + 'read from it',
        `have ${GIT}.${OPS.git.listBranches} answer a record per branch carrying its name and `
        + 'its branch_protection classification, then re-probe',
        observation.observedAt,
      );
      return {
        assertions: { git_access: access, branches: gap, protected_branches: gap },
        available: true,
        detail: 'the branch listing was in a shape the probe could not read',
        intendedScope: [],
      };
    }
    const protectedNames = branches
      .filter((b) => b['protected'] === true)
      .map((b) => asString(b['name']))
      .filter((name): name is string => name !== null);
    /*
     * Whether any branch is protected *because nobody could tell*.
     *
     * The adapter fails closed: protection lives on the VCS host, and where the host cannot be
     * reached every branch comes back protected at `UNKNOWN` confidence with `failed_closed`
     * set ([REPOSITORY_ADAPTER.md](../../../docs/REPOSITORY_ADAPTER.md) section 2.2). That is
     * the right value to gate on and the wrong thing to call a FACT — "every branch here is
     * protected" and "we could not read protection for any of them" are different statements
     * about the repository, and only the second is fixed by granting access. So the list is
     * stated as an inference over the classifications whenever one of them failed closed, and
     * the reasoning names which.
     */
    const assumed = branches
      .filter((b) => {
        const classification = b['protection'];
        return classification !== null && typeof classification === 'object'
          && (classification as { failed_closed?: unknown }).failed_closed === true;
      })
      .map((b) => asString(b['name']))
      .filter((name): name is string => name !== null);
    return {
      assertions: {
        git_access: access,
        branches: session.observedFact(
          'git.branches', branches, evidence, 'git', observation.observedAt,
        ),
        branch_count: session.observedFact(
          'git.branches', branches.length, evidence, 'git', observation.observedAt,
        ),
        protected_branches: assumed.length === 0
          ? session.observedFact(
            'git.branches', protectedNames, evidence, 'git', observation.observedAt,
          )
          : session.derived(
            'git.branches',
            protectedNames,
            evidence.map((e) => e.id),
            `branch protection could not be read for ${assumed.join(', ')}, and unknown `
            + 'protection is protected, so those names are here because the classification '
            + 'failed closed rather than because a host reported them protected',
            'git',
            observation.observedAt,
            evidence,
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
    const observation = await observe(session, {
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
    const observation = await observe(session, {
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
    const observation = await observe(session, {
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
    /* A tag is a ref name and nothing else, so a listing of names is a complete listing. */
    const tags = namedRecords(observation.value);
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
    const observation = await observe(session, {
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
    const observation = await observe(session, {
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
