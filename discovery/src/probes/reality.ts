import type { Evidence, RealityElement, WorkItem } from '@agentos/contracts';
import { ADAPTERS, OPS } from '../ops.js';
import type { ProbeInput, RealityProbe, RealityProbeResult } from '../probe.js';
import { asBoolean, asNumber, asRecord, asString, records } from '../probe.js';
import type { Observation, ProbeSession } from '../session.js';
import { listedPaths, observe } from './observation.js';

/**
 * The `current_reality` probe set: where this particular piece of work actually stands.
 *
 * This is the section that makes resumption possible and re-execution avoidable, and it is
 * governed by one rule that the rest of the package exists to protect
 * ([INTENT_AND_WORK_ITEM_RESOLUTION.md](../../../docs/INTENT_AND_WORK_ITEM_RESOLUTION.md)
 * section 5.4):
 *
 * > **Current Reality is established from adapters or it is `UNKNOWN`. It is never inferred
 * > from the intake, from a ticket's status field, or from a model's account of what happened
 * > last time.**
 *
 * Nothing in this file reads `intake.raw`, a ticket status, or an envelope. The work item's
 * identity is used as a *lookup key* — that is how anything is found — and every value comes
 * back from git, from the runtime, or from AgentOS's own ledger, each within its own
 * authority. Git owns whether a change is proposed. The runtime owns what is deployed. The
 * ledger owns what AgentOS did, and says nothing about whether it still holds.
 *
 * The second rule is the one about absence. "An unreachable GitHub makes `pr` `UNAVAILABLE`;
 * it does not make it 'no PR'." A predicate over an `UNKNOWN` element evaluates
 * `INDETERMINATE`, and the kernel's safer-branch rule then does more verification rather than
 * less — which is only sound if this file never dresses a failure to look up as a negative
 * answer.
 */

const GIT = ADAPTERS.git;
const REPO = ADAPTERS.repo;
const RUNTIME = ADAPTERS.runtime;
const HOST = ADAPTERS.host;

const TEST_GLOBS = [
  '**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**',
  '**/*Test.*', '**/*Tests.*', '**/*_test.*',
] as const;

const CI_GLOBS = [
  '.github/workflows/**', '.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile',
  '.circleci/**', '.drone.yml', 'bitbucket-pipelines.yml', '**/*.pipeline.yml',
] as const;

/**
 * The tokens a branch or a commit message would carry if it were about this work item.
 *
 * Derived from the work item's *identity*, never from its title or its description. An
 * identity is a key: matching `DEF-456` against a branch name is a lookup. Matching words from
 * a request against a branch name would be reading the intake into reality, and the difference
 * is the whole point of the section.
 */
export function identityTokens(workItem: WorkItem | null): readonly string[] {
  if (workItem === null) return [];
  const tokens = new Set<string>();
  const external = workItem.external_identity;
  if (external !== null) {
    tokens.add(external);
    const tail = external.split(/[:/]/).filter((part) => part !== '').pop();
    if (tail !== undefined) tokens.add(tail);
  }
  tokens.add(workItem.work_item_id);
  const suffix = workItem.work_item_id.replace(/^wi_(c_)?/, '');
  if (suffix !== '') tokens.add(suffix);
  return [...tokens].filter((token) => token.length >= 3);
}

function matchesIdentity(candidate: string, tokens: readonly string[]): boolean {
  const haystack = candidate.toLowerCase();
  return tokens.some((token) => haystack.includes(token.toLowerCase()));
}

interface BranchLookup {
  readonly branch: string | null;
  readonly base: string | null;
  readonly evidence: readonly Evidence[];
  readonly failure: Observation | null;
  readonly branchCount: number;
}

/**
 * Which branch, if any, carries this work.
 *
 * Every reality probe that needs a branch performs this lookup itself rather than reading it
 * from a shared package. `reprobeReality` re-reads one element on its own, moments before a
 * predicate is evaluated over it, and an element that quietly depended on a cached branch name
 * from two stages ago would be exactly the snapshot the re-probe exists to avoid.
 */
async function lookupBranch(
  session: ProbeSession,
  probe: string,
  workItem: WorkItem | null,
): Promise<BranchLookup> {
  const observation = await observe(session, {
    probe,
    adapter: GIT,
    op: OPS.git.listBranches,
    args: {},
    kind: 'git',
    ref: `${GIT}.${OPS.git.listBranches}`,
  });
  if (observation.outcome !== 'OBSERVED') {
    return { branch: null, base: null, evidence: [], failure: observation, branchCount: 0 };
  }
  const branches = records(observation.value);
  const tokens = identityTokens(workItem);
  const match = branches.find((branch) => {
    const name = asString(branch['name']);
    return name !== null && matchesIdentity(name, tokens);
  });
  const base = branches.find((branch) => branch['default'] === true);
  return {
    branch: match === undefined ? null : asString(match['name']),
    base: base === undefined ? null : asString(base['name']),
    evidence: [observation.evidence],
    failure: null,
    branchCount: branches.length,
  };
}

/** The pull request for this work, read fresh. Shared by four elements that all need it. */
interface PullRequestLookup {
  readonly pr: Readonly<Record<string, unknown>> | null;
  readonly evidence: readonly Evidence[];
  readonly failure: Observation | null;
  /** True when the listing succeeded and matched nothing — which is not the same as a failure. */
  readonly searched: boolean;
}

/**
 * The host's own identifier for a pull request, as a string.
 *
 * Hosts spell it differently — `id`, `number`, `key` — and the adapter takes whichever one the
 * host uses, opaque and unparsed. Reading the record's own fields in that order is what keeps
 * this probe from assuming one host's shape; where none of them is present, the answer is
 * `null` and the observation is not attempted, because an identifier nobody supplied cannot be
 * invented.
 */
function pullRequestId(pr: Readonly<Record<string, unknown>>): string | null {
  for (const field of ['id', 'number', 'key']) {
    const value = pr[field];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** The merge question, as the adapter asks it: a ref, its base, and the host's own id. */
function mergeStateArgs(pr: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const ref = asString(pr['head_branch']) ?? asString(pr['head_sha']) ?? asString(pr['head']);
  const base = asString(pr['base_branch']) ?? asString(pr['base']);
  const id = pullRequestId(pr);
  return {
    ...(ref === null ? {} : { ref }),
    ...(base === null ? {} : { base }),
    ...(id === null ? {} : { pull_request: id }),
  };
}

async function lookupPullRequest(
  session: ProbeSession,
  probe: string,
  input: ProbeInput,
): Promise<PullRequestLookup> {
  const branchLookup = await lookupBranch(session, probe, input.workItem);
  if (branchLookup.failure !== null) {
    return { pr: null, evidence: branchLookup.evidence, failure: branchLookup.failure, searched: false };
  }
  const tokens = identityTokens(input.workItem);
  const args: Record<string, unknown> = { state: 'ALL' };
  if (branchLookup.branch !== null) args['head'] = branchLookup.branch;
  if (tokens.length > 0) args['search'] = tokens;

  const observation = await observe(session, {
    probe,
    adapter: GIT,
    op: OPS.git.listPullRequests,
    args,
    kind: 'git',
    ref: `${GIT}.${OPS.git.listPullRequests} for this work item`,
  });
  if (observation.outcome !== 'OBSERVED') {
    return {
      pr: null,
      evidence: branchLookup.evidence,
      failure: observation,
      searched: false,
    };
  }
  const evidence = [...branchLookup.evidence, observation.evidence];
  const candidates = records(observation.value).filter((pr) => {
    const head = asString(pr['head_branch']) ?? asString(pr['head']);
    const title = asString(pr['title']) ?? '';
    if (branchLookup.branch !== null && head === branchLookup.branch) return true;
    return tokens.length > 0 && (matchesIdentity(head ?? '', tokens) || matchesIdentity(title, tokens));
  });

  /* Open before merged before closed: the one that is live is the one a resume decision is
   * about, and a stale closed attempt must never mask it. */
  const rank = (pr: Readonly<Record<string, unknown>>): number => {
    const state = asString(pr['state'])?.toUpperCase();
    if (state === 'OPEN') return 0;
    if (state === 'MERGED') return 1;
    return 2;
  };
  const chosen = [...candidates].sort((a, b) => rank(a) - rank(b))[0] ?? null;

  if (chosen === null) {
    return { pr: null, evidence, failure: null, searched: true };
  }

  /*
   * The host's identifier for the pull request, as a string.
   *
   * `number` is one host's spelling of it and not the others'. The adapter takes an opaque
   * `id`, which is also what it hands back as the external locator an idempotency re-read
   * follows, so the identifier has to survive as the thing the host itself uses.
   */
  const id = pullRequestId(chosen);
  const detail = id === null
    ? null
    : await observe(session, {
      probe,
      adapter: GIT,
      op: OPS.git.readPullRequest,
      args: { id },
      kind: 'git',
      ref: `${GIT}.${OPS.git.readPullRequest} ${id}`,
    });
  if (detail !== null && detail.outcome === 'OBSERVED') {
    const full = asRecord(detail.value);
    if (full !== null) {
      return { pr: { ...chosen, ...full }, evidence: [...evidence, detail.evidence], failure: null, searched: true };
    }
  }
  return { pr: chosen, evidence, failure: null, searched: true };
}

function noPullRequestValue(): Record<string, unknown> {
  /*
   * Deliberately carries no `state`. The kernel reads `state` to decide `reality.pr_open` and
   * `reality.pr_merged`; an absent one is what "there is no pull request" looks like, and
   * inventing `state: 'NONE'` would put a value into a field whose vocabulary does not contain
   * it.
   */
  return { exists: false, searched: true };
}

/* ============================================== implementation_present ==== */

export const implementationProbe: RealityProbe = {
  name: 'reality.implementation',
  element: 'implementation_present',
  freshnessClass: 'git',
  async run(session, input): Promise<RealityProbeResult> {
    const lookup = await lookupBranch(session, 'reality.implementation', input.workItem);
    if (lookup.failure !== null) {
      return {
        assertion: session.noAccess(
          'reality.implementation', 'whether an implementation exists', lookup.failure,
        ),
        available: false,
        detail: 'the branch list could not be read',
        intendedScope: input.scope.paths,
      };
    }

    const scopePaths = input.scope.paths;
    const tokens = identityTokens(input.workItem);
    if (lookup.branch === null && scopePaths.length === 0 && tokens.length === 0) {
      return {
        assertion: session.insufficient(
          'reality.implementation',
          `${lookup.branchCount} branch(es) were listed and the work item supplies neither a `
          + 'scope nor an identity, so there is nothing to recognise an implementation by',
          'resolve the work item with a scope or an external identity, then re-probe',
        ),
        available: true,
        detail: 'nothing to match an implementation against',
        intendedScope: [],
      };
    }

    const logArgs: Record<string, unknown> = {};
    if (lookup.branch !== null) logArgs['ref'] = lookup.branch;
    if (lookup.base !== null && lookup.branch !== null) logArgs['not'] = lookup.base;
    if (scopePaths.length > 0) logArgs['paths'] = [...scopePaths];
    if (tokens.length > 0) logArgs['message_contains'] = tokens;

    const log = await observe(session, {
      probe: 'reality.implementation',
      adapter: GIT,
      op: OPS.git.log,
      args: logArgs,
      kind: 'git',
      ref: `${GIT}.${OPS.git.log} for the work item's scope`,
    });
    if (log.outcome !== 'OBSERVED') {
      return {
        assertion: session.noAccess(
          'reality.implementation', 'commits implementing this work', log,
        ),
        available: false,
        detail: 'the commit log could not be read',
        intendedScope: scopePaths,
      };
    }

    const commits = records(log.value);
    const evidence = [...lookup.evidence, log.evidence];
    return {
      assertion: session.observedFact(
        'reality.implementation',
        commits.length > 0,
        evidence,
        'git',
        log.observedAt,
      ),
      available: true,
      detail: lookup.branch === null
        ? `${commits.length} commit(s) matching the work item, on no dedicated branch`
        : `branch ${lookup.branch} carries ${commits.length} commit(s) in scope`,
      intendedScope: scopePaths,
    };
  },
};

/* ======================================================= tests_present ==== */

/**
 * "Tests covering the scope exist **and executed**."
 *
 * Both halves, and the second is the one that gets skipped. A repository full of test files
 * nobody has run is exactly the state this predicate must not report as satisfied, so existence
 * without an observed execution is `INSUFFICIENT_EVIDENCE` rather than `true` — which makes the
 * predicate `INDETERMINATE`, which keeps validation in the run.
 */
export const testsProbe: RealityProbe = {
  name: 'reality.tests',
  element: 'tests_present',
  freshnessClass: 'git',
  async run(session, input): Promise<RealityProbeResult> {
    const scopePaths = input.scope.paths;
    const args: Record<string, unknown> = { globs: [...TEST_GLOBS] };
    if (scopePaths.length > 0) args['under'] = [...scopePaths];

    const listing = await observe(session, {
      probe: 'reality.tests',
      adapter: REPO,
      op: OPS.repo.listPaths,
      args,
      kind: 'file',
      ref: `${REPO}.${OPS.repo.listPaths} for tests covering the scope`,
    });
    if (listing.outcome !== 'OBSERVED') {
      return {
        assertion: session.noAccess('reality.tests', 'tests covering the scope', listing),
        available: false,
        detail: 'the test files could not be listed',
        intendedScope: scopePaths,
      };
    }

    const found = listedPaths(listing.value);
    if (found.length === 0) {
      return {
        assertion: session.observedFact(
          'reality.tests', false, [listing.evidence], 'git', listing.observedAt,
        ),
        available: true,
        detail: 'no test files cover the scope',
        intendedScope: scopePaths,
      };
    }

    const pr = await lookupPullRequest(session, 'reality.tests', input);
    const headSha = pr.pr === null ? null : asString(pr.pr['head_sha']);
    if (headSha === null) {
      return {
        assertion: session.insufficient(
          'reality.tests',
          `${found.length} test file(s) cover the scope and no revision was identified to look `
          + 'for an execution against, so whether they ran is not established. Test files that '
          + 'exist and have not been observed to run are not tests that passed',
          'execute the suite through the repository adapter and cite the result, or open the '
          + 'change so that a CI run has a head to report against',
          listing.observedAt,
        ),
        available: true,
        detail: `${found.length} test file(s), execution not established`,
        intendedScope: scopePaths,
      };
    }

    const ci = await observe(session, {
      probe: 'reality.tests',
      adapter: GIT,
      op: OPS.git.ciStatus,
      /* A commit sha is a ref. The adapter names the argument for what it accepts — a
       * branch, a tag or a sha — rather than for the one form this probe happens to hold. */
      args: { ref: headSha },
      kind: 'git',
      ref: `${GIT}.${OPS.git.ciStatus} ${headSha}`,
    });
    if (ci.outcome !== 'OBSERVED') {
      return {
        assertion: session.insufficient(
          'reality.tests',
          `${found.length} test file(s) cover the scope and no execution record could be read `
          + `for ${headSha}: the check runs were not available`,
          'restore access to the CI provider, or execute the suite locally through the '
          + 'repository adapter and cite the result',
          ci.observedAt,
        ),
        available: true,
        detail: 'test execution could not be established',
        intendedScope: scopePaths,
      };
    }

    const runs = records(asRecord(ci.value)?.['runs'] ?? ci.value);
    const executed = runs.filter((run) => {
      const status = asString(run['status'])?.toUpperCase();
      return status === 'COMPLETED' || status === 'FINISHED';
    });
    const evidence = [listing.evidence, ...pr.evidence, ci.evidence];
    if (executed.length === 0) {
      return {
        assertion: session.insufficient(
          'reality.tests',
          `${found.length} test file(s) cover the scope and no completed check run was observed `
          + `for ${headSha}`,
          'wait for the pipeline to finish, or execute the suite through the repository '
          + 'adapter and cite the result',
          ci.observedAt,
        ),
        available: true,
        detail: 'tests exist and no completed run was observed',
        intendedScope: scopePaths,
      };
    }
    return {
      assertion: session.observedFact('reality.tests', true, evidence, 'git', ci.observedAt),
      available: true,
      detail: `${found.length} test file(s), ${executed.length} completed run(s)`,
      intendedScope: scopePaths,
    };
  },
};

/* ==================================================================== pr ==== */

export const prProbe: RealityProbe = {
  name: 'reality.pr',
  element: 'pr',
  freshnessClass: 'git',
  async run(session, input): Promise<RealityProbeResult> {
    const lookup = await lookupPullRequest(session, 'reality.pr', input);
    if (lookup.failure !== null) {
      return {
        assertion: session.noAccess(
          'reality.pr', 'whether a change is proposed for this work', lookup.failure,
        ),
        available: false,
        detail: 'the pull request state could not be read. An unreachable git host is not '
          + '"there is no PR"',
        intendedScope: [],
      };
    }
    if (lookup.pr === null) {
      return {
        assertion: session.observedFact(
          'reality.pr', noPullRequestValue(), lookup.evidence, 'git', session.nowIso(),
        ),
        available: true,
        detail: 'the pull requests were listed and none is for this work item',
        intendedScope: [],
      };
    }
    const pr = lookup.pr;
    return {
      assertion: session.observedFact(
        'reality.pr',
        {
          exists: true,
          number: pr['number'],
          state: asString(pr['state'])?.toUpperCase() ?? null,
          head_sha: asString(pr['head_sha']),
          head_branch: asString(pr['head_branch']) ?? asString(pr['head']),
          base: asString(pr['base_branch']) ?? asString(pr['base']),
          mergeable: asBoolean(pr['mergeable']),
          url: asString(pr['url']),
        },
        lookup.evidence,
        'git',
        session.nowIso(),
      ),
      available: true,
      detail: `pull request #${String(pr['number'])} is ${String(pr['state'])}`,
      intendedScope: [],
    };
  },
};

/* ==================================================================== ci ==== */

export const ciProbe: RealityProbe = {
  name: 'reality.ci',
  element: 'ci',
  freshnessClass: 'git',
  async run(session, input): Promise<RealityProbeResult> {
    const lookup = await lookupPullRequest(session, 'reality.ci', input);
    if (lookup.failure !== null) {
      return {
        assertion: session.noAccess('reality.ci', 'the CI result for the current head', lookup.failure),
        available: false,
        detail: 'the head to ask about could not be established',
        intendedScope: [],
      };
    }
    const headSha = lookup.pr === null ? null : asString(lookup.pr['head_sha']);
    if (headSha === null) {
      return {
        assertion: session.insufficient(
          'reality.ci',
          'no proposed change was found, so there is no current head for a CI result to be '
          + 'about',
          'open the change, then re-probe the CI result for its head',
        ),
        available: true,
        detail: 'no head to ask about',
        intendedScope: [],
      };
    }

    const observation = await observe(session, {
      probe: 'reality.ci',
      adapter: GIT,
      op: OPS.git.ciStatus,
      args: { ref: headSha },
      kind: 'git',
      ref: `${GIT}.${OPS.git.ciStatus} ${headSha}`,
    });
    if (observation.outcome !== 'OBSERVED') {
      /*
       * Before calling it unavailable, establish whether the repository has CI at all. A
       * repository with no pipelines is not a repository whose pipeline failed, and the
       * degradation for the first is "validation is local only", which is a stated limitation
       * rather than a gap in access.
       */
      const definitions = await observe(session, {
        probe: 'reality.ci',
        adapter: REPO,
        op: OPS.repo.listPaths,
        args: { globs: [...CI_GLOBS] },
        kind: 'file',
        ref: `${REPO}.${OPS.repo.listPaths} for pipeline definitions`,
      });
      if (definitions.outcome === 'OBSERVED' && listedPaths(definitions.value).length === 0) {
        return {
          assertion: session.notApplicable(
            'reality.ci',
            'the repository declares no pipeline definitions and the CI provider returned no '
            + 'result, so there is no continuous integration for a head SHA to have passed',
            'configure a pipeline, or execute the suite locally through the repository adapter '
            + 'and cite the result as evidence. Validation is local only until then, and the '
            + 'report says so',
            definitions.observedAt,
          ),
          available: true,
          detail: 'the repository has no CI',
          intendedScope: [],
        };
      }
      return {
        assertion: session.noAccess('reality.ci', `the CI result for ${headSha}`, observation),
        available: false,
        detail: 'the CI result could not be read',
        intendedScope: [],
      };
    }

    const payload = asRecord(observation.value);
    const runs = records(payload?.['runs'] ?? observation.value);
    const evidence = [...lookup.evidence, observation.evidence];
    const conclusions = runs.map((run) => asString(run['conclusion'])?.toUpperCase() ?? 'UNKNOWN');
    const statuses = runs.map((run) => asString(run['status'])?.toUpperCase() ?? 'UNKNOWN');

    let result: string;
    if (runs.length === 0) result = 'NONE';
    else if (statuses.some((s) => s !== 'COMPLETED' && s !== 'FINISHED')) result = 'PENDING';
    else if (conclusions.every((c) => c === 'SUCCESS' || c === 'NEUTRAL' || c === 'SKIPPED')) {
      result = 'GREEN';
    } else if (conclusions.some((c) => c === 'UNKNOWN')) result = 'INDETERMINATE';
    else result = 'RED';

    return {
      assertion: session.observedFact(
        'reality.ci',
        {
          result,
          head_sha: headSha,
          runs: runs.length,
          conclusions,
          checked_at: observation.observedAt,
        },
        evidence,
        'git',
        observation.observedAt,
      ),
      available: true,
      detail: `CI for ${headSha} is ${result}`,
      intendedScope: [],
    };
  },
};

/* =============================================================== reviews ==== */

export const reviewsProbe: RealityProbe = {
  name: 'reality.reviews',
  element: 'reviews',
  freshnessClass: 'git',
  async run(session, input): Promise<RealityProbeResult> {
    const lookup = await lookupPullRequest(session, 'reality.reviews', input);
    if (lookup.failure !== null) {
      return {
        assertion: session.noAccess('reality.reviews', 'what reviewers said', lookup.failure),
        available: false,
        detail: 'the review state could not be read',
        intendedScope: [],
      };
    }
    if (lookup.pr === null) {
      /*
       * No pull request means no review has been delivered, and that is an observation rather
       * than an absence: the listing succeeded. `reality.pr_reviewed` reads FALSE, which keeps
       * PR_REVIEW in the run.
       */
      return {
        assertion: session.observedFact(
          'reality.reviews',
          { review_count: 0, approved: false, unresolved_threads: 0, threads: [], reviewers: [] },
          lookup.evidence,
          'git',
          session.nowIso(),
        ),
        available: true,
        detail: 'no proposed change, so nobody has reviewed one',
        intendedScope: [],
      };
    }

    /*
     * The reviews hang off the pull request's own identifier, so a record that carries none is
     * a record this probe cannot follow. Sending an empty identifier would ask the host about a
     * pull request that does not exist and read its "no reviews" as this one's.
     */
    const reviewedId = pullRequestId(lookup.pr);
    if (reviewedId === null) {
      return {
        assertion: session.insufficient(
          'reality.reviews',
          'a pull request was found and the record carries no identifier the review host would '
          + 'recognise, so the review threads cannot be looked up',
          'have the pull-request host report an id, a number or a key on each record',
        ),
        available: true,
        detail: 'the pull request carries no identifier',
        intendedScope: [],
      };
    }

    const observation = await observe(session, {
      probe: 'reality.reviews',
      adapter: GIT,
      op: OPS.git.listReviews,
      args: { pull_request: reviewedId },
      kind: 'git',
      ref: `${GIT}.${OPS.git.listReviews} ${reviewedId}`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertion: session.noAccess('reality.reviews', 'the review threads', observation),
        available: false,
        detail: 'the review threads could not be read',
        intendedScope: [],
      };
    }

    const payload = asRecord(observation.value);
    const reviews = records(payload?.['reviews'] ?? observation.value);
    const threads = records(payload?.['threads']);
    const headSha = asString(lookup.pr['head_sha']);
    const evidence = [...lookup.evidence, observation.evidence];

    /*
     * Approval is read against the current head. An approval of an earlier revision is a fact
     * about that revision, and treating it as approval of the current one is how a
     * post-approval push reaches merge unreviewed.
     */
    const approved = reviews.some((review) => {
      const state = asString(review['state'])?.toUpperCase();
      if (state !== 'APPROVED') return false;
      const reviewedSha = asString(review['commit_sha']) ?? asString(review['head_sha']);
      return reviewedSha === null || headSha === null || reviewedSha === headSha;
    });
    const unresolved = threads.filter((thread) => {
      if (thread['resolved'] === true) return false;
      const threadSha = asString(thread['head_sha']);
      return threadSha === null || headSha === null || threadSha === headSha;
    });

    return {
      assertion: session.observedFact(
        'reality.reviews',
        {
          review_count: reviews.length,
          approved,
          unresolved_threads: unresolved.length,
          threads: unresolved.map((thread) => ({
            id: thread['id'],
            subject: asString(thread['subject']) ?? asString(thread['path']),
          })),
          reviewers: [...new Set(reviews.map((r) => asString(r['reviewer'])).filter((r) => r !== null))],
          head_sha: headSha,
        },
        evidence,
        'git',
        observation.observedAt,
      ),
      available: true,
      detail: `${reviews.length} review(s), ${unresolved.length} unresolved thread(s)`,
      intendedScope: [],
    };
  },
};

/* =========================================================== merge_state ==== */

export const mergeStateProbe: RealityProbe = {
  name: 'reality.merge_state',
  element: 'merge_state',
  freshnessClass: 'git',
  async run(session, input): Promise<RealityProbeResult> {
    const lookup = await lookupPullRequest(session, 'reality.merge_state', input);
    if (lookup.failure !== null) {
      return {
        assertion: session.noAccess('reality.merge_state', 'the merge state', lookup.failure),
        available: false,
        detail: 'the merge state could not be read',
        intendedScope: [],
      };
    }
    if (lookup.pr === null) {
      return {
        assertion: session.observedFact(
          'reality.merge_state',
          { state: 'NOT_PROPOSED', mergeable: null, conflicted: false, blocked_by_policy: false },
          lookup.evidence,
          'git',
          session.nowIso(),
        ),
        available: true,
        detail: 'nothing is proposed, so nothing is merged',
        intendedScope: [],
      };
    }

    /*
     * A merge question needs something to ask it about: a ref the local history can test, or
     * the host's own identifier for the change. A record carrying neither leaves the pull
     * request's own state as the only thing established, which is the weaker answer below.
     */
    const mergeArgs = mergeStateArgs(lookup.pr);
    if (Object.keys(mergeArgs).length === 0) {
      const state = asString(lookup.pr['state'])?.toUpperCase() ?? null;
      return {
        assertion: state === null
          ? session.insufficient(
            'reality.merge_state',
            'the pull request record names neither a branch nor an identifier, so there is '
            + 'nothing to ask the merge question about',
            'have the pull-request host report a head branch and a base branch on each record',
          )
          : session.derived(
            'reality.merge_state',
            { state, mergeable: asBoolean(lookup.pr['mergeable']), conflicted: null, blocked_by_policy: null },
            lookup.evidence.map((e) => e.id),
            'the pull request record states its own merge state, and it names neither a branch '
            + 'pair the local history could test nor an identifier the host would recognise, so '
            + 'mergeability and policy blocks are not established',
            'git',
            session.nowIso(),
            lookup.evidence,
          ),
        available: true,
        detail: 'the pull request record carries nothing to ask the merge question about',
        intendedScope: [],
      };
    }

    const observation = await observe(session, {
      probe: 'reality.merge_state',
      adapter: GIT,
      op: OPS.git.mergeState,
      /*
       * The branch pair, and the pull request's own identifier where there is one.
       *
       * The pair is what makes this answerable with no VCS host at all: the local history can
       * settle whether the head is an ancestor of the base. Sending only the pull-request
       * number would make "merged?" unanswerable on every repository whose host AgentOS
       * cannot reach, which is the case the fail-closed rules exist for.
       */
      args: mergeArgs,
      kind: 'git',
      ref: `${GIT}.${OPS.git.mergeState} ${pullRequestId(lookup.pr) ?? '?'}`,
    });

    const prState = asString(lookup.pr['state'])?.toUpperCase() ?? null;
    if (observation.outcome !== 'OBSERVED') {
      if (prState === null) {
        return {
          assertion: session.noAccess('reality.merge_state', 'the merge state', observation),
          available: false,
          detail: 'the merge state could not be read',
          intendedScope: [],
        };
      }
      /*
       * The pull request record already carries its own state, and the dedicated merge-state
       * operation adds mergeability and policy blocks. Where only the second is missing, the
       * first still stands, and the assertion is weakened rather than discarded.
       */
      return {
        assertion: session.derived(
          'reality.merge_state',
          { state: prState, mergeable: asBoolean(lookup.pr['mergeable']), conflicted: null, blocked_by_policy: null },
          lookup.evidence.map((e) => e.id),
          'the pull request record states its own merge state; the dedicated merge-state '
          + 'operation was unavailable, so mergeability and policy blocks are not established '
          + 'and the assertion is weaker than the observation of a merge would be',
          'git',
          observation.observedAt,
          lookup.evidence,
        ),
        available: true,
        detail: `merge state ${prState} from the pull request record only`,
        intendedScope: [],
      };
    }

    const merge = asRecord(observation.value);
    return {
      assertion: session.observedFact(
        'reality.merge_state',
        {
          state: asString(merge?.['state'])?.toUpperCase() ?? prState,
          mergeable: asBoolean(merge?.['mergeable']) ?? asBoolean(lookup.pr['mergeable']),
          conflicted: asBoolean(merge?.['conflicted']),
          blocked_by_policy: asBoolean(merge?.['blocked_by_policy']),
          merged_sha: asString(merge?.['merged_sha']),
        },
        [...lookup.evidence, observation.evidence],
        'git',
        observation.observedAt,
      ),
      available: true,
      detail: 'merge state observed',
      intendedScope: [],
    };
  },
};

/* ============================================================ deployment ==== */

export const deploymentProbe: RealityProbe = {
  name: 'reality.deployment',
  element: 'deployment',
  freshnessClass: 'runtime',
  async run(session, input): Promise<RealityProbeResult> {
    const environments = await observe(session, {
      probe: 'reality.deployment',
      adapter: RUNTIME,
      op: OPS.runtime.listEnvironments,
      args: {},
      kind: 'http',
      ref: `${RUNTIME}.${OPS.runtime.listEnvironments}`,
    });
    if (environments.outcome !== 'OBSERVED') {
      return {
        assertion: session.noAccess(
          'reality.deployment', 'whether the change is deployed anywhere', environments,
        ),
        available: false,
        detail: 'the environments could not be listed',
        intendedScope: [],
      };
    }

    const lookup = await lookupPullRequest(session, 'reality.deployment', input);
    const headSha = lookup.pr === null ? null : asString(lookup.pr['head_sha']);
    const merged = lookup.pr === null ? null : asString(lookup.pr['merge_commit_sha']);
    const wanted = [headSha, merged].filter((sha): sha is string => sha !== null);

    if (wanted.length === 0) {
      return {
        assertion: session.insufficient(
          'reality.deployment',
          'no revision for this work item was identified, so there is nothing to look for in '
          + 'an environment',
          'establish the change (a branch, a commit or a pull request) and re-probe the '
          + 'deployment',
          environments.observedAt,
        ),
        available: true,
        detail: 'no revision to look for',
        intendedScope: [],
      };
    }

    const evidence: Evidence[] = [environments.evidence, ...lookup.evidence];
    const present: Array<Record<string, unknown>> = [];
    const unreachable: string[] = [];
    for (const environment of records(environments.value)) {
      const name = asString(environment['name']);
      if (name === null) continue;
      const observation = await observe(session, {
        probe: 'reality.deployment',
        adapter: RUNTIME,
        op: OPS.runtime.deployedVersion,
        args: { environment: name },
        kind: 'http',
        ref: `${RUNTIME}.${OPS.runtime.deployedVersion} ${name}`,
      });
      if (observation.outcome !== 'OBSERVED') {
        unreachable.push(name);
        continue;
      }
      evidence.push(observation.evidence);
      const deployed = asRecord(observation.value);
      const sha = deployed === null ? null : asString(deployed['sha']);
      if (sha !== null && wanted.includes(sha)) {
        present.push({ name, sha, version: deployed?.['version'] });
      }
    }

    if (unreachable.length > 0 && present.length === 0) {
      return {
        assertion: session.insufficient(
          'reality.deployment',
          `${unreachable.length} environment(s) could not be asked for a deployed revision `
          + `(${unreachable.join(', ')}) and the change was not found in the ones that `
          + 'answered, so whether it is deployed is not established',
          'restore runtime access to those environments and re-probe',
          environments.observedAt,
        ),
        available: false,
        detail: 'partial environment coverage with no positive result',
        intendedScope: [],
      };
    }

    return {
      assertion: session.observedFact(
        'reality.deployment',
        { environments: present, revisions_sought: wanted, environments_unreachable: unreachable },
        evidence,
        'runtime',
        environments.observedAt,
      ),
      available: true,
      detail: `present in ${present.length} environment(s)`,
      intendedScope: [],
    };
  },
};

/* ====================================================== outcome_evidence ==== */

/**
 * Does the desired outcome hold, observably, now?
 *
 * The one element that cannot be answered from the repository at all. A merged change, a green
 * pipeline and a successful deployment are each compatible with the outcome not holding, and
 * deriving this from any of them is precisely the `CLAIMED_DONE_UNPROVEN` reading that the
 * reconciliation exists to name. So it is asked of the runtime, which is the only thing that
 * can see the answer, and it is `UNKNOWN` where there is no runtime.
 */
export const outcomeProbe: RealityProbe = {
  name: 'reality.outcome',
  element: 'outcome_evidence',
  freshnessClass: 'runtime',
  async run(session, input): Promise<RealityProbeResult> {
    const workItem = input.workItem;
    if (workItem === null) {
      return {
        assertion: session.notComputed(
          'reality.outcome',
          'there is no admitted work item, so there is no desired outcome to check',
          'resolve the work item first; the reality set is computed against an admitted scope',
        ),
        available: true,
        detail: 'no work item',
        intendedScope: [],
      };
    }

    const observation = await observe(session, {
      probe: 'reality.outcome',
      adapter: RUNTIME,
      op: OPS.runtime.outcomeEvidence,
      /* `outcome` is the statement to be checked and is what the adapter requires; the rest is
       * context telling the runtime where to look, never a substitute for it. */
      args: {
        outcome: workItem.desired_outcome,
        work_item_id: workItem.work_item_id,
        ...(workItem.scope.paths.length === 0 ? {} : { scope_paths: [...workItem.scope.paths] }),
        ...(workItem.scope.capabilities.length === 0
          ? {}
          : { capabilities: [...workItem.scope.capabilities] }),
      },
      kind: 'query',
      ref: `${RUNTIME}.${OPS.runtime.outcomeEvidence} for ${workItem.work_item_id}`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertion: session.noAccess(
          'reality.outcome', 'whether the desired outcome already holds', observation,
        ),
        available: false,
        detail: 'the outcome could not be checked against a running system',
        intendedScope: workItem.scope.paths,
      };
    }

    const payload = asRecord(observation.value);
    const holds = asBoolean(payload?.['holds'] ?? observation.value);
    if (holds === null) {
      return {
        assertion: session.insufficient(
          'reality.outcome',
          'the runtime was asked whether the desired outcome holds and returned no verdict, so '
          + 'nothing about the outcome is established. A merged change is not an outcome',
          'have the runtime adapter report a verdict for the outcome check, or dispatch the '
          + 'Validator to establish it against real behaviour',
          observation.observedAt,
        ),
        available: true,
        detail: 'the outcome check returned no verdict',
        intendedScope: workItem.scope.paths,
      };
    }
    return {
      assertion: session.observedFact(
        'reality.outcome', holds, [observation.evidence], 'runtime', observation.observedAt,
      ),
      available: true,
      detail: holds ? 'the desired outcome already holds' : 'the desired outcome does not hold',
      intendedScope: workItem.scope.paths,
    };
  },
};

/* ============================================================== children ==== */

export const childrenProbe: RealityProbe = {
  name: 'reality.children',
  element: 'children',
  freshnessClass: 'agentos',
  async run(session, input): Promise<RealityProbeResult> {
    const workItem = input.workItem;
    if (workItem === null) {
      return {
        assertion: session.notComputed(
          'reality.children',
          'there is no admitted work item, so there is nothing to have children',
          'resolve the work item first',
        ),
        available: true,
        detail: 'no work item',
        intendedScope: [],
      };
    }

    const ledger = await observe(session, {
      probe: 'reality.children',
      adapter: HOST,
      op: OPS.host.readChildWorkItems,
      args: { work_item_id: workItem.work_item_id },
      kind: 'command',
      ref: `${HOST}.${OPS.host.readChildWorkItems} ${workItem.work_item_id}`,
    });

    const external = workItem.external_identity;
    const pm = external === null
      ? null
      : await observe(session, {
        probe: 'reality.children',
        adapter: ADAPTERS.pm,
        op: OPS.pm.listChildren,
        args: { key: external },
        kind: 'ticket',
        ref: `${ADAPTERS.pm}.${OPS.pm.listChildren} ${external}`,
      });

    const evidence: Evidence[] = [];
    const children: Array<Record<string, unknown>> = [];
    const unread: string[] = [];

    if (ledger.outcome === 'OBSERVED') {
      evidence.push(ledger.evidence);
      for (const child of records(ledger.value)) {
        const id = asString(child['work_item_id']) ?? asString(child['id']);
        if (id === null) continue;
        children.push({
          id,
          lifecycle: asString(child['lifecycle']) ?? 'UNKNOWN',
          source: 'agentos-ledger',
        });
      }
    } else {
      unread.push(`AgentOS's own ledger (${HOST}.${OPS.host.readChildWorkItems})`);
    }

    if (pm !== null) {
      if (pm.outcome === 'OBSERVED') {
        evidence.push(pm.evidence);
        for (const child of records(pm.value)) {
          const key = asString(child['key']) ?? asString(child['id']);
          if (key === null || children.some((existing) => existing['id'] === key)) continue;
          /*
           * A ticket AgentOS has never run against has no AgentOS lifecycle, and the ticket's
           * own status is not one. `UNKNOWN` here is what makes `children_all_terminal`
           * INDETERMINATE rather than confidently false, which is the honest answer.
           */
          children.push({ id: key, lifecycle: 'UNKNOWN', source: 'project-management' });
        }
      } else {
        unread.push(`the project-management system (${ADAPTERS.pm}.${OPS.pm.listChildren})`);
      }
    }

    if (evidence.length === 0) {
      const failure = ledger.outcome === 'OBSERVED' ? pm : ledger;
      return {
        assertion: failure === null
          ? session.insufficient(
            'reality.children',
            'no source of child work items could be read',
            'restore access to AgentOS\'s run ledger or to the project-management system',
          )
          : session.noAccess('reality.children', 'the child work items', failure),
        available: false,
        detail: 'no source of children could be read',
        intendedScope: [],
      };
    }

    if (unread.length > 0) {
      /*
       * PARTIAL propagates. One source answered and another did not, so the union is what is
       * known and not what is true, and it is stated as an inference naming the source that
       * was not read.
       */
      return {
        assertion: session.derived(
          'reality.children',
          children,
          evidence.map((e) => e.id),
          `the child set is the union of the sources that answered; ${unread.join(' and ')} `
          + 'could not be read, so this is what is known rather than everything that exists',
          'agentos',
          session.nowIso(),
          evidence,
        ),
        available: true,
        detail: `${children.length} child(ren) from a partial set of sources`,
        intendedScope: [],
      };
    }

    return {
      assertion: session.observedFact(
        'reality.children', children, evidence, 'agentos', session.nowIso(),
      ),
      available: true,
      detail: `${children.length} child work item(s)`,
      intendedScope: [],
    };
  },
};

/* ======================================================= agentos_history ==== */

/**
 * What AgentOS itself did against this work item.
 *
 * The ledger is authoritative about AgentOS's own actions and about nothing else: it records
 * that a pull request was opened, not that the pull request is still open. That is the right
 * scope for `reality.stage_completed_previously`, whose question — "did we analyse this" — is
 * a question about the past. Code existing does not mean an analysis happened, which is why
 * this element and not `implementation_present` is what the read-only analysis stages read.
 */
export const historyProbe: RealityProbe = {
  name: 'reality.agentos_history',
  element: 'agentos_history',
  freshnessClass: 'agentos',
  async run(session, input): Promise<RealityProbeResult> {
    const workItem = input.workItem;
    if (workItem === null) {
      return {
        assertion: session.notComputed(
          'reality.agentos_history',
          'there is no admitted work item, so there is no prior run against one to read',
          'resolve the work item first',
        ),
        available: true,
        detail: 'no work item',
        intendedScope: [],
      };
    }

    const observation = await observe(session, {
      probe: 'reality.agentos_history',
      adapter: HOST,
      op: OPS.host.readRunHistory,
      args: { work_item_id: workItem.work_item_id },
      kind: 'command',
      ref: `${HOST}.${OPS.host.readRunHistory} ${workItem.work_item_id}`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertion: session.noAccess(
          'reality.agentos_history', "AgentOS's own history for this work item", observation,
        ),
        available: false,
        detail: 'the run ledger could not be read',
        intendedScope: [],
      };
    }

    const runs = records(observation.value).map((run) => ({
      run_id: asString(run['run_id']),
      outcome: asString(run['outcome']),
      ended_at: asString(run['ended_at']),
      stages_completed: stageNames(run['stages_completed']),
      dispatches: asNumber(run['dispatches']),
    }));

    return {
      assertion: session.observedFact(
        'reality.agentos_history', runs, [observation.evidence], 'agentos', observation.observedAt,
      ),
      available: true,
      detail: `${runs.length} prior run(s) against this work item`,
      intendedScope: [],
    };
  },
};

/**
 * Stage names out of a ledger record, which may carry either bare names or stage records.
 *
 * `reality.stage_completed_previously` tests membership of this list, so a shape the reader
 * did not expect must produce an empty list rather than a list of `undefined` — an entry that
 * matches nothing is safe, and an entry that matches by accident marks a stage done that was
 * never run.
 */
function stageNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const direct = asString(entry);
    if (direct !== null) {
      out.push(direct);
      continue;
    }
    const record = asRecord(entry);
    const name = record === null ? null : asString(record['stage']);
    if (name !== null) out.push(name);
  }
  return out;
}

/** Every reality probe, in the order the package assembles them. */
export const REALITY_PROBES: readonly RealityProbe[] = [
  implementationProbe,
  testsProbe,
  prProbe,
  ciProbe,
  reviewsProbe,
  mergeStateProbe,
  deploymentProbe,
  outcomeProbe,
  childrenProbe,
  historyProbe,
];

const BY_ELEMENT = new Map<RealityElement, RealityProbe>(
  REALITY_PROBES.map((probe) => [probe.element, probe]),
);

export function realityProbeFor(element: RealityElement): RealityProbe {
  const probe = BY_ELEMENT.get(element);
  if (probe === undefined) {
    throw new Error(
      `no probe writes current_reality.${element}. The reality set is written only by probes, `
      + 'so an element with no probe is an element the kernel would have to guess',
    );
  }
  return probe;
}

/** Every element a probe writes, for the completeness check the assembler runs. */
export const COVERED_ELEMENTS: readonly RealityElement[] = REALITY_PROBES.map((p) => p.element);
