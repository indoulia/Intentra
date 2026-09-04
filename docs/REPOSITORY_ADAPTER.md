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
   are production. **These two determinations fail closed** (section 2.2): where protection
   or production status cannot be established, the adapter treats the branch as protected
   and the environment as production.

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

## 2.1 Path confinement

Worktree isolation is a containment claim, and a claim needs an enforcement point. The
repository adapter is it.

**Every path argument is resolved before use** — expanded, normalized, `..` collapsed, and
symlinks followed to a real path — and then checked:

1. The resolved path must be under the worktree root. Anything else is refused.
2. It must satisfy the dispatch's `mandate.in_scope` and not match `mandate.out_of_scope`
   ([AGENT_HANDOFF_CONTRACT.md](AGENT_HANDOFF_CONTRACT.md)). Scope is enforced here, not
   left to the receiving agent's discretion.
3. It must not match the **absolute deny-list** in `policies/paths.json`, which is checked
   even for paths that pass 1 and 2:
   - the AgentOS installation directory
   - `state/` and everything under it
   - `policies/` and `contracts/`
   - the host's credential stores and the user's home configuration
4. Symlink targets are checked, not just link paths. A symlink inside the worktree pointing
   outside it is refused on traversal.

A refused path is not an error the agent can retry differently: it is logged as a
`scope_violation` (in-scope failure) or a `security_violation` (deny-list or escape
attempt). A security violation aborts the dispatch immediately and is reported regardless
of the run's outcome — an agent that attempted it is worth knowing about even if it failed.

The deny-list exists because rules 1 and 2 depend on correctly computing a worktree root
and a scope. Rule 3 is the backstop that holds when they are wrong.

## 2.2 Fail-closed classification

Two facts gate everything dangerous: **is this branch protected**, and **is this
environment production**. Both are discovered, and discovery can fail.

**The rule: `UNKNOWN` is treated as the dangerous case.**

- Branch protection `UNKNOWN` or `UNAVAILABLE` -> the branch is **protected**. Merging into
  it requires a `MERGE_PROTECTED` grant.
- Environment classification `UNKNOWN` or `UNAVAILABLE` -> the environment is
  **production**. Writes to it require a grant.
- No environment topology discovered at all -> every reachable runtime is production.

This inverts the tempting default, and it inverts it deliberately. "We could not determine
whether this was production" is not a licence to write to it. Where the rule bites
incorrectly, the fix is to give AgentOS the access it needs to classify — or to declare the
topology in `.agent/environments.json` — not to relax the rule.

The classification and its confidence are recorded on every gated operation, so a run that
was conservative because it was blind is distinguishable from one that was conservative
because the target really was production.

## 2.3 Operation descriptors

Every adapter operation carries a descriptor. Five fields, and the last one is what makes
evidence verification possible without turning the verification channel into a mutation
channel.

- **`mutating`** — does it change **authoritative state**: repository content, VCS refs, an
  external system, a data store, or AgentOS run state. A mutating operation must emit a
  `mutation` event at call time and declare a `reversal`
  ([WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) section 7.2).
- **`reversal`** — the operation that undoes it, or `null` for non-reversible. A dispatch
  that performed a `reversal: null` operation is never automatically retried.
- **`idempotent_by_key`** — whether key-based deduplication is sound for it. Every mutating
  operation accepts an idempotency key and records completed keys; replaying a known key
  performs no work and returns the recorded result
  ([WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) section 7.3).
- **`external_destination`** — can it send anything outside the organisation's boundary.
  Fires `EXTERNAL_COMMUNICATION`.
- **`observation_safe`** — may the kernel replay this operation to verify evidence.
  Defined below.

### `observation_safe`

Earlier drafts called this field `side_effect_free`, which was wrong in a way that would
have bitten during implementation. Executing a test suite is the archetypal
evidence-producing operation, and it writes coverage files, populates build and dependency
caches, emits logs and leaves test output directories behind. Under a literal reading of
"side-effect-free" no test run could ever be replayed, and the evidence model's central
verification would have been unavailable for a large class of its most important evidence.

The property actually wanted is not that an operation produces no effects. It is that
**replaying it cannot change any state the run's conclusions rest on.**

> An operation is `observation_safe` when re-executing it with the same arguments cannot
> alter authoritative state, cannot consume or destroy the observation it reports, and
> produces no effect outside its declared incidental artifacts.

Three conditions, all checkable from the descriptor:

1. **`mutating: false`.** Authoritative state is untouched: no source file changed, no ref
   moved, no row written, no ticket updated, no call with an external destination.
2. **Effects confined and declared.** Any by-product lies within the worktree or the run's
   scratch area and matches a pattern in the operation's **`incidental_artifacts`** list —
   coverage output, build and package caches, compiled intermediates, temp directories, log
   files. These require no `mutation` event and no reversal; they are declared once in the
   descriptor rather than recorded per call, because nothing a decision rests on depends on
   them.
3. **Repeatable.** Re-execution neither consumes a one-shot resource nor destroys what it
   measured. A destructive queue read, a single-use token exchange, a log tail that advances
   a cursor — all `observation_safe: false`, though all are `mutating: false`.

The two flags are orthogonal in one direction only: `observation_safe: true` implies
`mutating: false`; `mutating: false` does not imply `observation_safe: true`.

**Incidental artifacts are not a loophole.** A by-product qualifies only when nothing else
depends on it surviving. Where one is itself cited as `Evidence` — a coverage report a DoD
criterion rests on — the adapter snapshots it into `artifacts/` before replay, so the cited
observation stays readable after the replay overwrites the live file. A by-product that
cannot be snapshotted and would be destroyed by replay makes the operation
`observation_safe: false`.

**An operation whose observation safety cannot be established is `observation_safe:
false`.** Same fail-closed rule as branch protection and environment classification. The
consequence of guessing wrong here is a mutation performed under cover of verification,
which is precisely what the evidence channel must never become.

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
