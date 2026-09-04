# AgentOS Architecture

## 1. What AgentOS is

AgentOS is a kernel that runs an engineering lifecycle over an arbitrary repository. It
holds durable state, decides which specialist agent runs next, gives that agent a typed
input package, records the typed envelope it returns, and enforces the boundaries where a
human must decide.

The intelligence lives in the agents. The **durability, coordination, evidence discipline
and safety** live in the kernel. That split is the whole design: agents are swappable and
occasionally wrong, and the kernel must remain correct anyway.

## 2. System shape

```
                         +------------------------------+
   GOAL  ---------------->        ORCHESTRATOR          |
                         |  (kernel: plan -> dispatch ->|
                         |   record -> decide -> repeat)|
                         +------+---------------+-------+
                                |               |
                  dispatch      |               |  read/write
                  typed input   |               |
                                v               v
       +--------------------------------+   +------------------------+
       |        SPECIALIST AGENTS       |   |      RUN STORE         |
       |                                |   |  state machine cursor  |
       |  Context Discovery             |   |  event log (append)    |
       |  Auditor / Forensics           |   |  Context Package       |
       |  Architect                     |   |  Capability Registry   |
       |  Implementer                   |   |  handoff envelopes     |
       |  Validator                     |   |  decisions & evidence  |
       |  Product / UX                  |   |  authorization records |
       |  Production                    |   +------------------------+
       +-----------+--------------------+
                   |  every agent works only through
                   v
       +------------------------------------------------------------+
       |                        ADAPTERS                            |
       |  repo . git . project-mgmt . runtime . host(tools/skills)  |
       +-----------+------------------------------------------------+
                   v
       target repository . git remote . Jira/GitHub . DB/API/logs . prod
```

Agents never touch the outside world directly. Every read and every mutation goes through
an adapter, which is where capability detection, redaction and the authorization
interlock live.

## 3. Components

### 3.1 Core (kernel)

**The Kernel and the Orchestrator Agent are two different things.** This is the single
most important boundary in AgentOS and it has its own document:
[KERNEL_BOUNDARY.md](KERNEL_BOUNDARY.md).

- **Kernel** (`core/`) — deterministic code. No model, no prompt, no judgment.
- **Orchestrator Agent** (`agents/`) — model-backed, like any other agent. It *advises*.

The Orchestrator Agent proposes; the Kernel disposes. The consequence is the property that
makes the system trustworthy: **a run's safety and durability do not depend on a model
behaving well.**

Kernel responsibilities:

- **Run loop** — `select next agent -> build input -> invoke -> validate envelope ->
  persist -> transition state`. The loop is deterministic with respect to the run store:
  given the same store and the same envelopes it makes the same decision, which is what
  makes a run resumable.
- **State machine** — the phases and legal transitions in
  [WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md). The kernel refuses illegal
  transitions rather than trusting an agent's claimed `next_action`.
- **Run ledger and event log** — append-only. Every dispatch, envelope, decision,
  evidence reference, file change, failure, rework loop and authorization event is a
  record. The log is the source of truth for "what happened"; the cursor is a derived
  projection. The kernel is the only writer to `state/`.
- **Policy and budget enforcement** — gates, the security floor, DoD applicability, rework
  and cost caps. Policy is data the kernel checks, never behaviour an agent is asked to
  remember.
- **Conflict detection and arbitration mechanics** — detection and rule-based resolution
  are mechanical; resolution on the merits is delegated to the Orchestrator Agent
  (section 6).
- **Operator interface** — CLI and the observability projections over the run store.

The kernel contains no domain knowledge and no prompts. The leak tests are in
[KERNEL_BOUNDARY.md](KERNEL_BOUNDARY.md).

**Dependency rule.** `agents -> contracts / policies / registries / adapters`, never
`agents -> core`. The practical test: delete `core/` and every agent should still compile.

### 3.2 Agents

Eight roles, defined in [AGENT_ROLES.md](AGENT_ROLES.md). An agent is a *specification*:
mandate, required inputs, permitted adapters, output envelope type, and the model/skill
requirements it declares. Multiple implementations of a role may exist (a cheap Auditor
and a deep Auditor); the kernel selects one via the model registry.

**Not every role runs for every goal.** The Orchestrator composes the pipeline from the
goal and the discovered context — a documentation change may run Context Discovery ->
Implementer -> Validator and nothing else. Roles are skipped explicitly with a recorded
reason, never silently.

### 3.3 Contracts

Schemas, versioned, machine-checkable. The kernel rejects any envelope that fails its
schema and treats that as an agent failure, not a data quirk.

- `HandoffEnvelope` — [AGENT_HANDOFF_CONTRACT.md](AGENT_HANDOFF_CONTRACT.md)
- `ContextPackage` — [CONTEXT_MODEL.md](CONTEXT_MODEL.md)
- `CapabilityRecord` and `CapabilityGraph` — [CAPABILITY_MODEL.md](CAPABILITY_MODEL.md)
- `Evidence`, `Assertion` (with `FACT | INFERENCE | UNKNOWN`)
- `Finding`, `Verdict`, `Blocker`
- `AuthorizationRequest` / `AuthorizationGrant` — [HUMAN_AUTHORIZATION.md](HUMAN_AUTHORIZATION.md)
- `DoDProfile` — [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md)

Contracts are the stable surface of AgentOS. Agents, models and adapters churn; contracts
change only with a version bump and a migration.

### 3.4 Discovery

Independent **probes**, each of which answers a narrow question, declares its own
availability, and degrades to `UNKNOWN` rather than guessing. Probes are the only writers
to the Context Package. See [CONTEXT_MODEL.md](CONTEXT_MODEL.md).

### 3.5 Registries

Three indexes of "what exists", sharing one lookup shape: **discover -> describe -> rank
-> select**, with every entry carrying provenance and a confidence class.

- **Capability registry** — what the *target system* can do, and where each capability is
  broken. [CAPABILITY_MODEL.md](CAPABILITY_MODEL.md)
- **Skill registry** — what *AgentOS* can invoke: global skills, repository skills,
  plugins, connectors, MCP servers, scripts.
  [SKILL_AND_MODEL_SELECTION.md](SKILL_AND_MODEL_SELECTION.md)
- **Model registry** — which models are reachable and what each is good at.

They are one component because they answer the same question at three levels and share
resolution machinery. They are *not* one namespace.

### 3.6 Policies

Declarative, human-readable, versioned in git:

- authorization boundaries and gate definitions
- the security floor (non-overridable)
- Definition-of-Done profiles and applicability rules
- data semantics vocabulary ([DATA_SEMANTICS.md](DATA_SEMANTICS.md))
- budget and stopping rules (rework loop caps, cost ceilings, time limits)

Policy is data the kernel enforces, not behaviour an agent is asked to remember. This is
the difference between a safeguard and a suggestion.

### 3.7 Adapters

- **Repository adapter** — filesystem, language/build detection, manifests, tests, CI
  config, optional `.agent/`. [REPOSITORY_ADAPTER.md](REPOSITORY_ADAPTER.md)
- **Git adapter** — branches, commits, tags, worktrees, merge history, PRs, blame.
- **Project-management adapter** — Jira, GitHub Issues, Confluence, markdown docs. Read
  by default; writing is gated.
- **Runtime adapter** — databases, HTTP APIs, service health, logs, deployed versions.
  Read-only unless authorized, and never against production without a grant.
- **Host adapter** — the agent execution environment: available tools, skills, models,
  sandbox, working directory, credentials *by reference only*.

Every adapter reports its own availability. An unreachable adapter is a recorded
`UNAVAILABLE`, which is a fact about the world and must not be confused with a fact about
the system under study.

### 3.8 State

Durable run state on disk (see [WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md)).
The store's schema is tracked in git; actual run data is ignored. Runs are addressable and
inspectable without AgentOS running.

## 4. The lifecycle

```
GOAL
 +-> CONTEXT DISCOVERY --> reconcile intent vs code vs runtime
      +-> AUDIT ---------> capability graph, orphans, gaps, provenance
           +-> ARCHITECT -> domain model, ownership, contracts, failure semantics
                +-> PLAN --> ordered work units, each with a DoD profile
                     +-> IMPLEMENT
                          +-> VALIDATE (unit . integration . capability . runtime . prod)
                               +-> PRODUCT/UX REVIEW (where a UI exists)
                                    +-> REWORK --+
                                         +-------+ (bounded loop)
                                              +-> READY
                                                   +-> HUMAN AUTHORIZATION (where required)
                                                        +-> MERGE / DEPLOY
                                                             +-> PRODUCTION VALIDATION
                                                                  +-> COMPLETE
```

Stages are gated by evidence, not by wall clock. A stage that cannot produce its required
evidence declares a blocker; it does not proceed on optimism.

## 5. The three-way reconciliation

The single most important thing Context Discovery does.

```
      PROJECT INTENT              CODE                RUNTIME REALITY
      (EPIC/issues/docs)      (repository)        (db/api/logs/prod)
              |                     |                      |
              +----------> RECONCILIATION MATRIX <---------+
```

Each capability lands in exactly one reconciliation state. The canonical enum is defined
once, in [CONTEXT_MODEL.md](CONTEXT_MODEL.md); it is repeated here only in summary:

- `ALIGNED` — intent, code and runtime agree. Confirm and move on.
- `INTENT_ONLY` — planned, not built. Ordinary backlog.
- `CODE_ONLY` — built, undocumented. Dead code, or missing documentation.
- `CODE_NO_RUNTIME` — the dangerous one. It exists, tests may pass, and it never actually
  runs or produces data in the real system.
- `RUNTIME_NO_CODE` — manual process, external system, or shadow implementation.
- `CLAIMED_DONE_UNPROVEN` — intent says complete, runtime provides no evidence. The
  highest-value finding AgentOS produces.
- `CONFLICTING` — sources actively contradict each other.
- `INDETERMINATE` — a source was unavailable; reconciliation is not yet possible. Not a
  failure, and not to be read as the optimistic case.

Reconciliation output is an input to the Auditor, not a conclusion by itself.

## 6. Multi-agent disagreement

Disagreement is expected and is treated as information.

1. **Detect.** Two envelopes make incompatible assertions about the same subject, or a
   Validator finding contradicts an Architect assumption.
2. **Classify.** Factual (settleable by evidence), interpretive (differing judgment on
   shared facts), or scope (different problem being solved).
3. **Resolve by rule first.** Where the two assertions differ in confidence class, `FACT`
   beats `INFERENCE` beats `UNKNOWN`, decided by the kernel with no model involved. Most
   conflicts die here.
4. **Resolve on the merits.** What survives goes to the Orchestrator Agent.
   - *Factual* -> it names the discriminating observation; the kernel dispatches a narrow
     probe or targeted validation and decides by result. Cheapest and most common path.
   - *Interpretive* -> it applies policy and DoD; if still tied, one additional independent
     review is requested with both positions supplied, unattributed.
   - *Scope* -> re-read the goal; if the goal is genuinely ambiguous between the two, this
     is one of the rare legitimate reasons to ask the human.
5. **Record.** The decision, the losing position, and the evidence go in the event log.
   A reversed decision must be traceable later.

The kernel never decides who is right on the merits; the agent never decides what happens
next. See [KERNEL_BOUNDARY.md](KERNEL_BOUNDARY.md).

Explicit anti-rules: never resolve by model tier, never average two designs into a third
nobody proposed, never let the most recent envelope win by recency.

## 7. Observability

The event log is designed so a human can reconstruct a run without a model. Every record
carries: run id, timestamp, state, agent, model, skills used, adapter calls, decision,
evidence references, artifacts changed, cost, and outcome.

Two derived views, both required:

- **Live view** — current state, running agent, model, elapsed, what it is waiting on,
  pending authorizations, rework loop count.
- **Run narrative** — the ordered story of the run: what was discovered, what was decided
  and why, what failed, what was reworked, what a human authorized, and how completion was
  judged.

If a run's story cannot be told from the log alone, the log is deficient — that is a
kernel bug, not a documentation gap.

## 8. Repository layout and why it is this small

```
agent-os/
  core/         run loop . state machine . run ledger . event log . arbitration
  agents/       role specifications
  contracts/    versioned schemas
  discovery/    probes
  registries/   capability . skill . model
  policies/     authorization . security floor . DoD profiles . data semantics . budgets
  adapters/     repo . git . pm . runtime . host
  state/        durable run store (schema tracked, data ignored)
  docs/         design
```

Deviations from the structure suggested in the brief, with reasons:

- **`orchestration/` merged into `core/`.** The orchestrator *is* the kernel. A separate
  directory implies a substitutable orchestration layer, which would be a lie — swapping
  it means swapping AgentOS.
- **`capability-registry/`, `skills/` and `model-registry/` merged into `registries/`.**
  All three are discover/describe/rank/select indexes with provenance. Three directories
  for one pattern invites three divergent implementations.
- **`state/` kept separate from `core/`.** Durable state must be inspectable and
  restorable independently of the code that writes it. That separation is what makes
  interruption recovery credible.

Nine directories, each with one reason to change — justified component by component in
[KERNEL_BOUNDARY.md](KERNEL_BOUNDARY.md), which maps every planned component to exactly
one primary directory and states the split for the seven that span two. Every code
directory currently contains only a README stating its purpose; there is no implementation
in Phase 0.

## 9. Deliberate non-decisions

Recorded here so they are not mistaken for oversights. Resolution is scheduled in
[IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md).

- **Implementation language.** Undecided. TypeScript and Python are both viable; the
  choice depends on the agent-execution host, not on preference.
- **Agent execution substrate.** Whether agents run as Claude Code subagents, SDK
  sessions, or a mix. The handoff contract is deliberately transport-agnostic so this can
  be deferred and later changed.
- **Run store backend.** Files first (inspectable, diffable, zero infrastructure). SQLite
  later if concurrency demands it.
- **Concurrency.** Sequential-by-default in the MVP. Parallel probes are obviously safe;
  parallel *implementers* are not, and the arbitration model must be proven serially
  first.
