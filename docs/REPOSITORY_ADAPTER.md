# Repository Adapter

How AgentOS attaches to an arbitrary repository.

**The governing constraint: a repository with no AgentOS-specific files must work fully.**
The `.agent/` directory is an optimization and a place to record human decisions — never a
prerequisite. Any code path that requires it is a bug.

## 1. Attachment sequence

1. **Identify** — path, VCS, remotes, default branch, protected branches, current branch,
   worktree state.
2. **Detect** — languages, frameworks, build system, package manager, test runner, linters,
   containers, CI. From manifests and layout, never from a name.
3. **Map** — modules, entry points, layering, source directories, generated code, vendored
   code.
4. **Locate** — configuration, schemas, migrations, tests, CI definitions, deployment
   definitions, documentation.
5. **Infer conventions** — naming, error handling, logging, layering, test structure. The
   Implementer must match these; a change that is correct but foreign is a defect.
6. **Check for `.agent/`** — if present, load it as *declared* context. If absent, proceed
   with what was discovered and record nothing as missing.
7. **Determine commands** — build, test, lint, run. Discovered from manifests and CI, then
   verified by execution where safe.
8. **Establish boundaries** — which branches are protected, which environments exist, which
   are production.

Every output of this sequence is an assertion with a confidence class. Detection is often
`INFERENCE`; verification by running a command upgrades it to `FACT`, and doing that
upgrade for build and test commands early is worth the cost.

## 2. Working in the repository

- **Worktree isolation.** Work happens in a dedicated worktree or branch, never on a
  protected branch. This is what makes autonomy safe: the reversal is deleting the
  worktree.
- **Match, do not impose.** AgentOS adopts the repository's conventions, formatting and
  test idioms. It does not introduce its own style, tooling or structure.
- **No unrelated changes.** Only files required by the goal are touched. Opportunistic
  cleanup and reformatting are out of scope and become recommendations instead.
- **No footprint.** AgentOS does not add dependencies, configuration or files to the target
  repository except what the goal requires and, where the human enables it, `.agent/`
  artifacts.

## 3. The optional `.agent/` directory

Where a repository chooses to keep durable context. Everything in it is optional, and
everything in it is treated as a **claim** to be reconciled with code and runtime — the
same standard applied to an EPIC.

```
.agent/
  README.md          what this directory is
  context.md         product purpose, domain vocabulary, users
  architecture.md    declared architecture and boundaries
  capabilities.json  carried-forward capability registry from prior runs
  conventions.md     conventions AgentOS should follow
  decisions/         architectural decision records
  policies.json      repository-specific gate tightening (never loosening)
  environments.json  environment topology, which is production
  runs/              prior run summaries and their outcomes
```

Three rules:

- **Declared context never overrides observed reality.** Where `.agent/architecture.md`
  and the code disagree, that disagreement is a finding, and the code is what exists.
- **Carried-forward capability records are re-validated for freshness** before use. Stale
  records are marked `STALE`, never used silently.
- **`policies.json` may only tighten** the authorization model in
  [HUMAN_AUTHORIZATION.md](HUMAN_AUTHORIZATION.md). Loosening directives are rejected and
  logged.

## 4. Degradation

AgentOS states its own reduced capability rather than pretending completeness. Each of
these is a recorded limitation, not a failure:

- **No `.agent/`** — full discovery from scratch. Slower, complete.
- **No project management access** — intent comes from documentation and commit history;
  the reconciliation matrix has an `INDETERMINATE` intent axis.
- **No runtime access** — capability validation caps at integration level. Every capability
  is at most `PARTIAL`, never `PROVEN`, and the Validator says so.
- **No production access** — production validation is `NOT_VALIDATED`; completion is at
  best `COMPLETE_WITH_GAPS`, and the gap is named.
- **No tests in the repository** — the Implementer establishes a test approach as part of
  the work; absence of tests is itself a finding.
- **No CI** — validation is local only, and the report says so.

The pattern throughout: reduced access reduces the strength of claims AgentOS is allowed to
make. It never reduces honesty about them.

## 5. Multi-repository goals

A goal may span repositories (a service and its client, an API and its UI). Each repository
gets its own adapter instance and its own discovery; the capability graph spans them, since
a capability chain that crosses a repository boundary is exactly where orphans hide.

Authorization is per repository. A grant in one is never a grant in another.

## 6. Host portability

The adapter must not assume a shell, path separator, or line ending. Windows, macOS and
Linux are all first-class. Commands are discovered from the repository and executed through
the host adapter, which owns platform differences — no platform assumption belongs in the
kernel or in an agent.
