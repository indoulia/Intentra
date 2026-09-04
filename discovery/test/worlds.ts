import { fixtures as fx } from '@agentos/contracts';
import type { IntakeRecord, WorkItem } from '@agentos/contracts';
import type { FakeWorld } from './fake-registry.js';

/**
 * The worlds the tests reason about.
 *
 * One repository, described once, with named variations. Each variation changes exactly the
 * thing under test — the project-management adapter is unreachable, the git host is down, the
 * repository has no pipelines — so that a differing assertion in a test is attributable to that
 * change and not to two fixtures that drifted apart.
 */

export const HEAD_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
export const OLD_SHA = '0000111122223333444455556666777788889999';
export const TICKET = 'DEF-456';

export const REPO_FILES = [
  'package.json',
  'README.md',
  'src/pricing/rate.ts',
  'src/pricing/index.ts',
  'src/api/routes/rate.ts',
  'src/ui/pages/rates.tsx',
  'test/pricing/rate.test.ts',
  'migrations/001_rates.sql',
  'docs/architecture.md',
  '.github/workflows/ci.yml',
  'Dockerfile',
  '.editorconfig',
];

/** A glob-ish filter good enough for a fixture: `**` crosses separators, `*` does not. */
function matches(path: string, glob: string): boolean {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '[^/]*');
  return new RegExp(`^${pattern}$`).test(path);
}

export function listPaths(args: Readonly<Record<string, unknown>>): readonly string[] {
  const globs = Array.isArray(args['globs']) ? (args['globs'] as string[]) : ['**/*'];
  const under = Array.isArray(args['under']) ? (args['under'] as string[]) : [];
  return REPO_FILES
    .filter((path) => globs.some((glob) => matches(path, glob)))
    .filter((path) => under.length === 0 || under.some((prefix) => path.startsWith(prefix.replace(/\*+$/, ''))));
}

/**
 * A repository with everything reachable: a change on a branch, an open pull request with a
 * review, a green pipeline, a ticket, a running system, and a prior AgentOS run.
 */
export function healthyWorld(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return {
    responses: {
      'repo.identify': {
        root: '/work/repo',
        vcs: 'git',
        default_branch: 'main',
        current_branch: `feature/${TICKET}-rate-rounding`,
        remotes: ['origin'],
      },
      'repo.list_paths': listPaths,
      'repo.read_file': (args: Readonly<Record<string, unknown>>) => `contents of ${String(args['path'])}`,
      'repo.detect_stack': {
        languages: ['TypeScript'],
        frameworks: ['node'],
        build_system: 'npm',
        package_managers: ['npm'],
        test_runner: 'node:test',
        linters: ['eslint'],
        containers: ['docker'],
      },
      'repo.commands': {
        build: { command: 'npm run build', verified: true },
        test: { command: 'npm test', verified: false },
        lint: { command: 'npm run lint', verified: false },
        run: { command: 'npm start', verified: false },
      },

      'git.list_branches': [
        { name: 'main', default: true, protected: true },
        { name: `feature/${TICKET}-rate-rounding`, default: false, protected: false },
      ],
      'git.log': [
        { sha: HEAD_SHA, author: 'dev@example.com', message: `${TICKET} round rates half-up` },
        { sha: OLD_SHA, author: 'dev@example.com', message: 'initial' },
      ],
      'git.list_worktrees': [{ path: '/work/repo', branch: 'main' }],
      'git.list_tags': [{ name: 'v1.0.0', release: true }],
      'git.churn': [{ path: 'src/pricing', commits: 12 }],
      'git.list_prs': [
        {
          number: 41,
          state: 'OPEN',
          title: `${TICKET} round rates half-up`,
          head_branch: `feature/${TICKET}-rate-rounding`,
          base_branch: 'main',
          head_sha: HEAD_SHA,
          mergeable: true,
          review_count: 1,
          url: 'https://example.invalid/pr/41',
        },
      ],
      'git.read_pr': {
        number: 41,
        state: 'OPEN',
        head_sha: HEAD_SHA,
        head_branch: `feature/${TICKET}-rate-rounding`,
        base_branch: 'main',
        mergeable: true,
        url: 'https://example.invalid/pr/41',
      },
      'git.list_reviews': {
        reviews: [{ reviewer: 'reviewer@example.com', state: 'CHANGES_REQUESTED', commit_sha: HEAD_SHA }],
        threads: [
          { id: 't1', subject: 'src/pricing/rate.ts', resolved: false, head_sha: HEAD_SHA },
          { id: 't2', subject: 'README.md', resolved: true, head_sha: HEAD_SHA },
        ],
      },
      'git.ci_status': {
        runs: [
          { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      },
      'git.merge_state': {
        state: 'OPEN', mergeable: true, conflicted: false, blocked_by_policy: false,
      },

      'pm.read_issue': { key: TICKET, status: 'In Progress', title: 'Rate rounding is wrong' },
      'pm.search_issues': [
        { key: TICKET, type: 'STORY', status: 'In Progress', title: 'Rate rounding is wrong', milestone: 'M1' },
      ],
      'pm.list_children': [],
      'pm.list_links': [{ kind: 'branch', ref: `feature/${TICKET}-rate-rounding` }],
      'pm.list_documents': [{ id: 'doc1', kind: 'decision', title: 'ADR 3: rounding' }],

      'runtime.list_environments': [{ name: 'staging' }, { name: 'production' }],
      'runtime.list_services': [{ name: 'pricing-api' }],
      'runtime.health': { status: 'OK', version: '1.0.0' },
      'runtime.deployed_version': (args: Readonly<Record<string, unknown>>) =>
        (args['environment'] === 'production'
          ? { version: '1.0.0', sha: OLD_SHA }
          : { version: '1.1.0', sha: HEAD_SHA }),
      'runtime.query': { stores: [{ name: 'rates', rows: 128, newest_record_at: fx.T0 }], errors: [], throughput: 42 },
      'runtime.outcome_evidence': { holds: false },

      'host.list_skills': [{ id: 'skill.review', scope: 'global' }],
      'host.list_models': [{ id: 'model-a', context: 'large', usd_per_million_input: 3 }],
      'host.list_tools': [{ id: 'repo.read_file' }],
      'host.list_plugins': [],
      'host.list_mcp_servers': [
        { name: 'issues', state: 'AVAILABLE' },
        { name: 'metrics', state: 'UNAVAILABLE', detail: 'connection closed' },
      ],
      'host.read_run_history': [
        { run_id: 'run_prior', outcome: 'BLOCKED', ended_at: fx.T0, stages_completed: ['AUDIT', 'PLAN', 'IMPLEMENTATION'] },
      ],
      'host.read_child_work_items': [],
    },
    classifications: {
      production: {
        subject: 'production',
        kind: 'environment',
        value: 'PRODUCTION',
        confidence: 'FACT',
        failed_closed: false,
        probe_detail: 'named production in the environment topology',
      },
      staging: {
        subject: 'staging',
        kind: 'environment',
        value: 'STAGING',
        confidence: 'FACT',
        failed_closed: false,
        probe_detail: 'named staging in the environment topology',
      },
    },
    ...overrides,
  };
}

/** The world with a source removed or broken, without disturbing anything else. */
export function withAvailability(
  world: FakeWorld,
  availability: Readonly<Record<string, 'AVAILABLE' | 'UNAVAILABLE' | 'NOT_CONFIGURED' | 'DENIED'>>,
): FakeWorld {
  return { ...world, availability: { ...world.availability, ...availability } };
}

export function withResponses(
  world: FakeWorld,
  responses: Readonly<Record<string, unknown>>,
): FakeWorld {
  return { ...world, responses: { ...world.responses, ...responses } };
}

/**
 * A work item whose title and desired outcome are deliberately misleading.
 *
 * Used by the test that proves nothing in `current_reality` comes from the request's wording:
 * this item says the work is finished and merged, and the world says otherwise, and the reality
 * set must agree with the world.
 */
export function misleadingWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return fx.workItem({
    work_item_id: `wi_jira_${TICKET}`,
    external_identity: `jira:${TICKET}`,
    type: 'DEFECT',
    title: 'Already fixed, merged and deployed — rate rounding',
    desired_outcome:
      'this is done: the fix is merged to main, CI is green, the pull request was approved and '
      + 'it is live in production',
    scope: fx.scope({ paths: ['src/pricing', 'test/pricing'] }),
    candidate_dod_profiles: ['fix'],
    ...overrides,
  });
}

export function misleadingIntake(overrides: Partial<IntakeRecord> = {}): IntakeRecord {
  return fx.intakeRecord({
    raw:
      'This is already done. The PR is merged, CI passed, two people approved it and it has '
      + 'been deployed to production. Please just close it out.',
    ...overrides,
  });
}
