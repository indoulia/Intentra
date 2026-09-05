/**
 * The adapter operations discovery asks for, named once.
 *
 * Probes reach the world only through the `AdapterRegistry` port
 * ([KERNEL_BOUNDARY.md](../../docs/KERNEL_BOUNDARY.md) dependency rule 5), so the operation
 * names are a coupling between this package and `adapters/` that exists whether or not it is
 * written down. Writing it down in one table is what makes it checkable: a probe that asks
 * for an operation no adapter offers degrades to `UNKNOWN` with the operation named, and an
 * adapter author has one list to implement against rather than a search through probe
 * bodies.
 *
 * The five adapters are the five of [AGENTOS_ARCHITECTURE.md](../../docs/AGENTOS_ARCHITECTURE.md)
 * section 8 — `repo`, `git`, `pm`, `runtime`, `host` — and no probe invents a sixth.
 */

export const ADAPTERS = {
  /** Filesystem, language and build detection, manifests, tests, CI definitions. */
  repo: 'repo',
  /** Branches, commits, tags, worktrees, merge history, pull requests, reviews, CI results. */
  git: 'git',
  /** Jira, GitHub Issues, Confluence, markdown decision records. Read mostly. */
  pm: 'pm',
  /** Databases, HTTP APIs, service health, logs, deployed versions. */
  runtime: 'runtime',
  /** The agent execution environment, and AgentOS's own run ledger. */
  host: 'host',
} as const;

export type AdapterName = (typeof ADAPTERS)[keyof typeof ADAPTERS];

/**
 * Every operation a probe in this package calls.
 *
 * Grouped by adapter and named as `adapter.op` in the values, because that pair is what a
 * `Locator` carries and what the kernel replays.
 */
export const OPS = {
  repo: {
    /** Path, VCS, default branch, current branch, remotes. Attachment step 1. */
    identify: 'identify',
    /** Paths under a glob. The one enumeration primitive every repository probe uses. */
    listPaths: 'list_paths',
    /** File content, optionally a line range. */
    readFile: 'read_file',
    /** Languages, frameworks, build system, package manager, test runner, linters, CI. */
    detectStack: 'detect_stack',
    /** Build, test, lint and run commands, discovered from manifests and CI. */
    commands: 'commands',
  },
  git: {
    listBranches: 'list_branches',
    /**
     * The remote's default branch, and the remotes themselves.
     *
     * Attachment step 1 names both as outputs of *identify*
     * ([REPOSITORY_ADAPTER.md](../../docs/REPOSITORY_ADAPTER.md) section 1), and neither is
     * the repository adapter's to answer: it reads files and does not run the VCS. So the
     * identity probe asks git for the two halves of its own section that only git knows.
     */
    defaultBranch: 'default_branch',
    remotes: 'remotes',
    log: 'log',
    listWorktrees: 'list_worktrees',
    listTags: 'list_tags',
    /** Change concentration: which areas are churning. */
    churn: 'churn',
    listPullRequests: 'list_prs',
    readPullRequest: 'read_pr',
    listReviews: 'list_reviews',
    /** Check runs and their conclusions for one commit. */
    ciStatus: 'ci_status',
    mergeState: 'merge_state',
  },
  pm: {
    readIssue: 'read_issue',
    searchIssues: 'search_issues',
    listChildren: 'list_children',
    listLinks: 'list_links',
    listDocuments: 'list_documents',
  },
  runtime: {
    listEnvironments: 'list_environments',
    listServices: 'list_services',
    health: 'health',
    deployedVersion: 'deployed_version',
    query: 'query',
    /**
     * Whether the work item's desired outcome observably holds, checked by the adapter that
     * can actually reach the running system. Discovery does not guess this from a merge or a
     * green pipeline: an outcome inferred from a deployment is exactly the
     * `CLAIMED_DONE_UNPROVEN` the reconciliation exists to name.
     */
    outcomeEvidence: 'outcome_evidence',
  },
  host: {
    listSkills: 'list_skills',
    listModels: 'list_models',
    listTools: 'list_tools',
    listPlugins: 'list_plugins',
    /** Includes servers configured and unreachable, which are UNAVAILABLE and never absent. */
    listMcpServers: 'list_mcp_servers',
    /**
     * Prior AgentOS runs against one work item, from AgentOS's own ledger.
     *
     * The ledger lives under `state/`, which discovery may not reach directly
     * (dependency rule 5, and the dependency-cruiser rule that forbids
     * `discovery -> state`), so it arrives the same way every other observation does. It is
     * authoritative about what AgentOS did and says nothing about whether it still holds,
     * which is the right scope for `reality.stage_completed_previously`.
     */
    readRunHistory: 'read_run_history',
    /** Child work items AgentOS itself recorded, with their lifecycle states. */
    readChildWorkItems: 'read_child_work_items',
  },
} as const;
