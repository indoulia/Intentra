# Implementation Roadmap

## 1. Sequencing principle

Build in the order that **fails fastest and cheapest**. The riskiest assumption in AgentOS
is not orchestration — it is that automated discovery can produce a Context Package good
enough to reason from. If that is false, nothing downstream matters, so it gets built and
tested first.

Corollary: the first real deliverable is a **read-only** AgentOS. It discovers, audits and
reports, and changes nothing. That is testable against real repositories immediately, is
safe by construction, and is genuinely useful on its own.

## 1.5 Readiness marks

Every deliverable below carries one:

- **READY** — can be implemented now. No unresolved architectural decision blocks it.
- **NEEDS CONTRACT** — the design is settled but a schema in `contracts/` must exist first.
- **BLOCKED** — depends on an unresolved architectural decision (section 11). **Nothing
  marked BLOCKED may be implemented.** Resolving the decision is the work.

The test this exists to answer: *can another engineer implement this without inventing
missing architectural decisions?* Anything they would have to invent is BLOCKED, and saying
so is more useful than a roadmap that looks uniformly green.

## 2. Phase 0 — Architecture (complete)

Design documents and repository skeleton. No code.

Superseded by **Architecture v0.1** (section 2.5), which adds the kernel boundary and the
consistency fixes that make the design implementable.

## 2.5 Architecture v0.1 — internally consistent, implementation-ready

The milestone between design and code. Its exit criterion is a single question:

> Can another engineer implement this architecture without having to invent missing
> architectural decisions?

Delivered:

- **Kernel/Orchestrator Agent split** — [KERNEL_BOUNDARY.md](KERNEL_BOUNDARY.md). Resolves
  the contradiction between "the kernel is pure" and "the Orchestrator is a model-backed
  agent".
- **Dependency rule** — `agents -> contracts / policies / registries / adapters`, never
  `agents -> core`. Test: delete `core/` and every agent still compiles.
- **Component ownership map** — every planned component mapped to exactly one primary
  directory, with an explicit split for the seven that span two. CLI and observability
  projections, previously homeless, assigned to `core/`.
- **Envelope status to kernel action** — all six statuses mapped;
  `FAILED`, `PARTIAL` and `REJECTED` previously had no defined handling.
- **Mid-run authorization** — gates that fire during `IMPLEMENTATION` route through
  `BLOCKED` with `AUTHORIZATION_REQUIRED` rather than a new state.
- **DoD ownership** — exactly one agent per criterion; the Implementer owns none.
- **One absence vocabulary** — the Context Model's ad-hoc `UNKNOWN` reasons replaced by
  the [DATA_SEMANTICS.md](DATA_SEMANTICS.md) enum; freshness separated as an orthogonal
  axis.
- **One reconciliation enum** — defined in [CONTEXT_MODEL.md](CONTEXT_MODEL.md), referenced
  elsewhere rather than restated in prose.
- **Context growth bound** — `required_inputs` per dispatch, versioned packages,
  references not inlining.
- **Invariants answered** — the nine failure questions, in
  [KERNEL_BOUNDARY.md](KERNEL_BOUNDARY.md) section 8.

Still open and deliberately so: the decisions in section 11. Two of them block Phase 1.

## 2.6 Architecture v0.2 — the kernel disbelieves agents

v0.1 established that no agent can **drive** the run. An adversarial trace of fifteen
failure scenarios showed it had not established that the kernel can **disbelieve** an
agent: six of eight invariants failed, every one of them the kernel accepting agent-supplied
data as true because it was well-formed.

Closed in v0.2:

- **W1 Evidence verification** — `Evidence.locator` is mandatory and re-executable; the
  kernel replays evidence through the originating adapter (always for critical findings,
  authorization requests and DoD criteria marked `MET`; sampled otherwise). `verification`
  is kernel-owned and rejected if an agent supplies it. Repeated mismatch rejects the whole
  envelope.
- **W2 Transition predicates** — the four prose branch conditions became named predicates
  the kernel evaluates over the Context Package and mutation events. `INDETERMINATE` takes
  the branch that does more work.
- **W3 Mutation events** — adapters emit them at call time with reversals;
  `artifacts_changed` becomes a reconciliation that catches under- and over-reporting.
- **W4 Path confinement** — resolve, then check worktree root, mandate scope and an
  absolute deny-list covering `state/`, `policies/`, `contracts/` and the installation.
- **W5 `spawns_agents`** — skills that can start an agent are never selectable;
  undetermined counts as spawning. Folded into the substrate decision (section 11).
- **W6 Fail-closed classification** — unknown branch protection means protected; unknown
  environment means production.
- **W7 Mechanical gate classifiers** — gates fire from what the adapter observes; agent
  self-declaration is an additional trigger, never the only one.
- **W8 Idempotency** — keys at adapter-operation granularity, pre-retry reversal, fresh
  `dispatch_id` per attempt, and no automatic retry after a non-reversible operation.
- **W9 Structured mandate** — typed `objective`/`in_scope`/`out_of_scope` enforced at the
  adapter; free prose is labelled untrusted and grants nothing.
- **W10 Cross-field consistency** — enumerated and checked independently of schema
  conformance.
- **W11 Torn-write recovery** — trailing partial lines discarded and logged.

Also added: explicit behaviour when **no model is available at all** — the run blocks
cleanly and resumes, because every kernel function runs model-free.

New policy files this implies, all data rather than code: `gates.json`, `paths.json`,
`predicates.json`, `evidence.json`. No new directories.

## 2.7 Architecture v0.3 — intent, work items and dynamic workflows

v0.2 made the kernel disbelieve agents about *execution*. It still believed one thing without
checking: that the run began with a well-formed goal an operator had typed. Real work arrives
as a ticket key, a PR link, a complaint, a webhook or a half-finished Epic, and v0.2 had no
way to say what a request *was*, what state it was *already in*, or which workflow suited it
— there was one workflow and every run walked it.

**Contract correction carried in first.** `side_effect_free`, the descriptor field gating
evidence replay, was too absolute: test execution writes coverage files, caches and output
directories, so under a literal reading the evidence model could never have verified its most
important evidence. Replaced by **`observation_safe`** plus a declared `incidental_artifacts`
list, defined in [REPOSITORY_ADAPTER.md](REPOSITORY_ADAPTER.md) section 2.3. Same fail-closed
default; the property is now "replay cannot change what the conclusions rest on" rather than
"produces no effects".

Closed in v0.3:

- **X1 Source-agnostic intake** — one `IntakeRecord` produced by whichever adapter observed
  the source. No per-source architecture, no new directory; event and webhook intake belongs
  to the host adapter. The intake carries a re-executable locator, so "the ticket said X" is
  checkable.
- **X2 Resolution as an admitted proposal** — Context Discovery, in a `resolution` mandate,
  proposes a Work Item with every field an assertion. The kernel resolves the external
  identity itself, checks the claimed type against evidence minimums, bounds the scope, and
  requires the desired outcome to bind to a checkable DoD profile. No ninth role.
- **X3 Work Item / Workflow Run split** — the Work Item is durable and outlives every attempt;
  a run is one attempt. `state/runs/` becomes `state/work-items/<id>/runs/<run-id>/`. A lease
  enforces one active run per work item.
- **X4 Workflow templates as policy** — graphs live in `policies/workflows/`, authored by
  humans, checked against the workflow floor at policy load. The Orchestrator selects and
  parameterizes; it cannot author a graph. This is what keeps "the kernel disposes" true under
  dynamic workflow selection: validating a selection is arithmetic, validating a novel graph
  would be judgment.
- **X5 Stage vocabulary and graph** — completion markers became exit conditions and failure
  states became edge conditions, because `X`/`X_COMPLETE` does not survive branching. Loops,
  branches, escalation and cancellation are first-class.
- **X6 Kernel-computed entry stage** — resumption is a walk of the frozen graph against Current
  Reality, not an agent's reading of a prompt. A work item with an open PR under review enters
  at `REVIEW_TRIAGE`.
- **X7 `UNDERSTOOD` as computation** — replaces `CONTEXT_READY`. Understanding is sufficient
  exactly when every predicate the candidate templates' entry edges reference is determinate.
- **X8 The refined safer-branch rule** — `INDETERMINATE` takes the branch that does more
  verification and less irreversible mutation. Where those disagree, the kernel discovers, then
  blocks with the new `AMBIGUOUS_STATE`. v0.2's rule is the special case with no irreversible
  mutation in play.
- **X9 Work-item-scoped idempotency** — keys over an operation's declared `identity_args` for
  `external_destination` and `reversal: null` operations, so a second run does not open a
  second PR. v0.2's dispatch-scoped keys only ever protected within one run.
- **X10 Review feedback as a loop with a mechanical escape** — triage is agent judgment, but
  creating a child Work Item requires the remediation to fall provably outside the admitted
  scope. Undeterminable counts as in-scope. Outside-and-inseparable is `SCOPE_EXPANSION`.
- **X11 Epic decomposition into child Work Items** — replaces v0.2's sub-runs, which shared the
  parent's identity. The `epic` template contains no `IMPLEMENTATION` stage, so an Epic cannot
  become one enormous pipeline. Children are discovered before they are created.
- **X12 Intake is data, never instruction** — `trust_class` set by the host from authenticated
  context; content cannot name a template, request a stage, set a confidence class or widen a
  scope; no grant originates from intake; and the new narrow gate
  `AUTONOMOUS_INTAKE_EXECUTION` covers `EXTERNAL` intake reaching a mutating stage. This is the
  attack surface v0.3 opens and v0.2 did not have.

### The adversarial trace, and what it found

Twenty scenarios traced against the v0.3 draft. Thirteen held as written. Seven found real
gaps, every one of them the same shape: **a check keyed on something a model had resolved,
rather than on something an adapter had observed.** All seven are closed, and the pattern is
worth naming because it is where the next round of defects will be.

- **Y1 The regression floor rule.** A defect misclassified as a `TASK` selects a template with
  no `ROOT_CAUSE` stage — and the floor rule that would have demanded one was keyed on the type
  that was wrong. Added `regression.suspected`: outcome not satisfied **and** scope intersects a
  `WORKING`/`PROVEN` capability. Both are lookups, so it is arithmetic, and it cannot be
  defeated by misclassification. Generalized rule: where a floor rule can be keyed on reality
  instead of a resolved field, key it on reality.
  (WORKFLOW_STATE_MACHINE 3.5)
- **Y2 Re-resolution.** The draft said re-selecting a workflow was possible without saying who
  triggers it or what bounds it, leaving a misresolved run to a wasted completion. Added the
  `WORK_ITEM_MISCLASSIFIED` blocker: the run ends `RERESOLVED`, resolution re-runs with the new
  evidence, a new run starts against the **same** Work Item, capped at one.
  (WORKFLOW_STATE_MACHINE 4.5)
- **Y3 Decomposition caps.** Nothing bounded an Epic's children, and each child carries its own
  run and budget — so an over-enthusiastic decomposition was an unbounded cost commitment made
  as a side effect. Capped at 12 children and depth 2; exceeding is `BLOCKED` with the proposal
  attached, not truncated. (INTENT_AND_WORK_ITEM_RESOLUTION 10)
- **Y4 Verified idempotency.** The sharpest one. Work-item-scoped keys stop a second run from
  opening a second PR — but a *cached* key hit tells the run it has a PR that someone may since
  have closed. A key hit now re-reads the external resource: present → return the record; absent
  → invalidate and proceed; unreachable → `AMBIGUOUS_STATE`, neither trusting the record nor
  re-executing. **AgentOS's own ledger is authoritative about the past, not the present** — the
  same standard it already applied to a ticket's status field, now applied to itself.
  (WORKFLOW_STATE_MACHINE 7.3)
- **Y5 Reality re-probed, not snapshotted.** Reality predicates read the Context Package, and
  git state expires in minutes. Evaluating the review loop against a package assembled two
  stages ago would make a comment arriving mid-implementation invisible for the rest of the run.
  Stale elements are re-probed before a predicate is evaluated, never used stale.
  (WORKFLOW_STATE_MACHINE 4.3)
- **Y6 Source drift.** A ticket edited mid-run left a run completing correctly against a request
  that had moved, and saying nothing. At `COMPLETION` the kernel re-executes the intake locator
  and compares content hashes — the existing `ticket`/`document` comparator applied to the
  intake. Changed means disclosed, not chased. (WORKFLOW_STATE_MACHINE 7.4)
- **Y7 Atomic lease.** The one-active-run-per-work-item lease was specified without acquisition
  semantics, so its only job — two processes starting at the same moment — was the case it lost.
  Atomic create, plus a `lease_timeout` so a crashed run does not hold its work item forever.
  (WORKFLOW_STATE_MACHINE 1)

Two smaller corrections from the same pass: an intake that **names** an unresolvable external
item now blocks with `EXTERNAL_DEPENDENCY` rather than degrading to investigating something else
(INTENT_AND_WORK_ITEM_RESOLUTION 3.4), and `investigation.readonly` is declared universally
applicable so the admissible template set is never empty (WORKFLOW_STATE_MACHINE 3.2).

### Residual risk, stated rather than closed

**The admitted Work Item is derived from untrusted content and is read by every agent.** Its
`title`, `desired_outcome` and `scope` are typed, bounded and non-authoritative for anything the
kernel decides — a scope cannot exceed the repository, an outcome must bind to a checkable
profile, no field can name a template or request a gate — and `AUTONOMOUS_INTAKE_EXECUTION`
covers the `EXTERNAL` case. What remains is that a *plausible wrong reading* of a legitimate
request flows downstream as the run's statement of purpose, and no mechanical check distinguishes
plausible-and-wrong from right. The mitigations are the narrative obligation (resolution is
narrated alongside execution, so a run that did the wrong thing correctly is legible) and Y2
(a stage that discovers the misreading can end the run honestly). This is the residual, and it
is the reason the resolution dispatch is the highest-precision dispatch in the system.

New policy files, all data rather than code: `workflows/*.json`, `stages.json`,
`workflow-floor.json`, `work-items.json`, `intake.json`. Extended: `predicates.json` (the
reality predicates), `budgets.json` (per-work-item budgets, the review loop cap, `reresolution`,
`decomposition`, `lease_timeout`). No new directories; nine still stands.

Open after v0.3: the two items added to section 11.

## 3. Phase 1 — Contracts and kernel skeleton

Deliverables:

- **READY** — Versioned schemas: `Assertion`, `Evidence`, `IntakeRecord`, `WorkItem`,
  `Finding`, `Blocker`, `HandoffEnvelope`, `ContextPackage`, `CapabilityRecord`,
  `AuthorizationRequest`/`Grant`, `DoDProfile`, `WorkflowTemplate`, `StageDescriptor`. These
  are the minimum contracts; nothing else can be built first (section 3.5).
- **READY** — Schema validation with useful rejection messages.
- **READY** — Work item and run store: `work-item.json`, `run.json`, `events.ndjson` at both
  levels, envelope persistence, the single-active-run lease. Files, not SQLite; the backend
  decision is deferred but files are correct for Phase 1 regardless.
- **READY** — Template loader and workflow-floor check at policy load. Model-free, and the
  first thing that fails loudly if a template is authored wrong.
- **READY** — Workflow admission, entry-stage computation and the frozen graph. All arithmetic
  over templates and Current Reality; testable against fixture reality sets with no model.
- **READY** — State machine with transition enforcement over a frozen graph, including the
  envelope-status mapping (WORKFLOW_STATE_MACHINE.md section 4.2).
- **BLOCKED** — Run loop dispatching an agent. Depends on the agent execution substrate
  (section 11). The loop's *logic* is specified; how it invokes an agent is not.
- **READY** — CLI: `agentos run`, `agentos status`, `agentos narrate`. Lives in `core/`.

Everything in Phase 1 except the dispatch mechanism can be built and tested against
recorded fixture envelopes, with no model in the loop at all. That is the recommended
first increment: **a kernel that replays envelopes**.

**Exit test:** start a run, kill the process mid-agent, restart, and have it resume
correctly from the log — not from memory, and not by starting over.

**Second exit test, new in v0.3:** run twice against the same fixture Work Item, where the
first run reached a simulated open PR. The second run must enter at `REVIEW_TRIAGE`, must not
re-enter `IMPLEMENTATION`, and must not issue a second `create_pr`. This exercises the entry
computation, the reality predicates and work-item-scoped idempotency together, with no model
in the loop.

**Third exit test:** the same fixture, but the simulated PR has been deleted between runs, and
then a variant where the PR host is unreachable. The first must invalidate the idempotency
record and open a PR; the second must block with `AMBIGUOUS_STATE` and open nothing. A design
that passes the second exit test and fails this one has built a cache and called it
idempotency.

## 3.5 The minimum contract set

Six schemas must exist before any other implementation. They are the ones every other
component references, and inventing them ad hoc later means rewriting everything built
against the guesses.

1. **`Assertion`** — value plus `FACT | INFERENCE | UNKNOWN` plus evidence plus
   `observed_at` plus freshness. Every leaf value in the system is one, including every field
   of a proposed Work Item. Nothing else can be defined until this is.
2. **`Evidence`** — the ten-kind closed set, a mandatory re-executable `locator`, `ref`,
   `excerpt`, `observed_at`, `reproducible`, and a kernel-owned `verification` block.
   Shared verbatim by the Context Package and the envelope. Build this before anything that
   produces evidence, because retrofitting a locator means re-deriving every observation.
3. **`HandoffEnvelope`** — the only inter-agent transport. Its status enum drives the state
   machine, so the two must be defined together or they will drift.
4. **`ContextPackage`** — the shape discovery writes and every agent reads. Its section
   names are the vocabulary of `required_inputs`.
5. **`CapabilityRecord`** — the unit of truth for audit and completion.
6. **`AuthorizationRequest` / `Grant`** — must exist before any mutating adapter, because
   the adapter checks the grant. Building mutation first and adding authorization after is
   how the gate ends up bypassable.

To those six, v0.3 adds two more that must exist before the kernel can run anything:

7. **`IntakeRecord` / `WorkItem`** — the run's identity now hangs off the work item, so the
   store layout, the event log and every envelope reference it. Retrofitting this later means
   rewriting every path in `state/`.
8. **`WorkflowTemplate` / `StageDescriptor`** — the state machine is data-driven, so the
   machine cannot be built before the shape of its data. `StageDescriptor.mutating` in
   particular is read by the safe-prefix computation, the resume rule and a gate.

`Finding`, `Blocker`, `DoDProfile`, `AdapterOperationDescriptor` and `MutationEvent` are
needed slightly later but are cheap once the six above exist. The last two are what make
adapters enforceable rather than merely conventional, so they precede any mutating
adapter.

**Validation order.** Define `Assertion` and `Evidence` first, then `HandoffEnvelope`
against a hand-written fixture for every status value, then the rest. If a schema cannot
express a worked example from its own document, the document is wrong — fix it before
writing code against it.

## 4. Phase 2 — Discovery (the high-risk phase)

Deliverables:

- **READY** — Repository adapter with language/stack/convention detection.
- **READY** — Git adapter, including PR, review-thread and CI state — which `current_reality`
  and every resume decision depend on.
- **NEEDS CONTRACT** — Intake normalization across host, PM, git and runtime adapters. Needs
  `IntakeRecord`.
- **BLOCKED** — Resolution dispatch. Depends on the agent execution substrate, like every
  other dispatch.
- **BLOCKED** — Host adapter: skill, tool and model enumeration. Depends on the agent
  execution substrate; what is enumerable differs entirely between a Claude Code host and
  a direct-API host.
- **READY** — Repository and git probe set.
- **NEEDS CONTRACT** — Context Package assembly with confidence classification. Needs
  `ContextPackage` and `Assertion` from Phase 1.
- **READY** — Tiered discovery and coverage reporting.

**Exit test:** run discovery against three genuinely different repositories — including
Ferret and Tradsy, not just Marksy — and have a human who knows each one confirm the
package is accurate, that its `UNKNOWN`s are honest, and that nothing was inferred as fact.
Discovery that quietly guesses is worse than discovery that reports gaps.

## 5. Phase 3 — Audit (the first real value)

Deliverables:

- **NEEDS CONTRACT** — Capability identification from intent, code and runtime. Needs
  `CapabilityRecord`, plus stable capability identity across runs (section 11) before
  records can be carried forward — though a single-run registry is READY without it.
- **BLOCKED** — Capability graph construction. Depends on the static-analysis depth
  decision (section 11): cheap structural analysis for edges versus model reasoning. The
  graph's *shape* is specified; how edges are derived is not, and that choice determines
  whether an edge is `FACT` or `INFERENCE`.
- **BLOCKED** — Orphan detection. Downstream of the graph.
- **READY** — Data-semantics analysis: fabricated defaults, collapsed absence, missing
  provenance and timestamps. Pattern-based, independent of the graph.
- **READY** — Test-quality analysis: what tests actually assert on.
- **READY** — Reconciliation matrix.
- **READY** — Project-management adapter (read-only) and runtime adapter (read-only).
- **NEEDS CONTRACT** — Findings report with evidence. Needs `Finding` and `Evidence`.

**Exit test:** the Marksy pilot in section 8. This is where AgentOS either earns trust or
does not.

**End of Phase 3, AgentOS is useful and still writes nothing.** That is a deliberate
stopping point, and shipping it before building mutation capability is the safest way to
learn whether the evidence model works.

## 6. Phase 4 — Architecture and implementation

Deliverables:

- **BLOCKED** — Architect agent. Depends on the execution substrate.
- **NEEDS CONTRACT** — Planner output: work units with DoD profiles. Needs `DoDProfile`.
- **BLOCKED** — Implementer agent. Depends on the execution substrate.
- **READY** — `BLOCKED_BY_ARCHITECTURE` loop. Kernel-side; specified fully.
- **READY** — Git mutation: branch, commit, PR preparation.
- **READY** — Skill and model selection: registries rank, kernel selects.

**Exit test:** implement a small, real, previously-identified defect in a real repository,
end to end, producing a PR a reviewer accepts without knowing it was machine-authored.

## 7. Phase 5 — Validation and UX

Deliverables:

- **BLOCKED** — Validator across five layers. Execution substrate.
- **READY** — Capability validation: trace a real record end to end. The method is
  specified; only its dispatch is substrate-dependent.
- **BLOCKED** — Product/UX agent. Two dependencies: the execution substrate, and evidence
  acquisition — how screenshots are obtained when AgentOS cannot set up an environment
  (section 11).
- **READY** — Rework loop with budgets. Kernel-side.
- **READY** — DoD evaluation and completion reporting. The kernel does the arithmetic;
  ownership per criterion is settled (DEFINITION_OF_DONE.md section 3).

**Exit test:** a run that *correctly fails* — the Validator rejects an implementation that
passes its unit tests but does not work, rework fixes it, and re-validation passes. Proving
AgentOS can say no is more important than proving it can say yes.

## 8. Phase 6 — Authorization and production

Deliverables:

- **READY** — Authorization gates, grant lifecycle and adapter-level enforcement.
- **BLOCKED** — Request delivery and response. Depends on the human interaction channel
  (section 11) — CLI, PR comment, Jira or chat determines the response-window policy and
  the identity AgentOS records.
- **READY** — Security floor enforcement and violation logging.
- **BLOCKED** — Production agent. Execution substrate.
- **READY** — Production validation evidence collection.
- **READY** — Full run narrative and observability views.

**Exit test:** a complete run from goal to production with exactly the intended human gates
hit — no more, no fewer — and a run narrative a person who was absent can follow.

## 9. Phase 7 — Refinement

Multi-agent arbitration under real disagreement, parallel child Work Items, parallelism
within a run, carried-forward `.agent/` knowledge, selection heuristics replaced by measured
data.

## 10. MVP definition

**The MVP is Phases 1–3: a read-only AgentOS that discovers and audits.**

```
agentos work --repo <path> "<anything>"
```

The MVP accepts any intake source and resolves it, but every admissible template for it is
read-only — `investigation.readonly` and the audit path — because nothing mutates yet. That
is a useful property rather than a limitation: **the whole resolution and workflow-selection
layer can be exercised and judged before AgentOS can write anything.** Whether it correctly
identifies what a request is, and where that work already stands, is testable with zero risk.

Given a repository and any request, it produces:

- a Context Package with honest confidence classification
- a capability registry and capability graph
- an evidence-backed findings report
- an explicit coverage and unknowns statement
- a resumable run record

It mutates nothing.

This is the MVP because it exercises every hard part of the design — discovery,
reconciliation, evidence, confidence, capability modelling, durable state, handoff
contracts — while carrying no risk to any repository, and because a good audit is worth
shipping even if AgentOS never writes a line of code.

**Explicitly out of MVP scope:** implementation, validation beyond static analysis, UX
review, authorization gates (nothing is gated when nothing mutates), deployment,
parallelism, parallel child Work Items.

**The MVP is unblocked as of the v0.3 freeze.** Three decisions in section 11 sat inside it:
the agent execution substrate (blocked dispatch), implementation language, and static-analysis
depth (blocked the capability graph, and therefore orphan detection — the audit's headline
output). The first two are decided; the third is adopted provisionally and resolved by
measurement during the audit work package, with the plan arranged so that a disappointing
result costs the graph rather than the milestone. Nothing in Phases 1–3 is now BLOCKED.

Sequenced honestly, that means: build the contracts, build the kernel as an envelope replayer
with no model in the loop, then attach discovery. That sequence, decomposed into work packages
with exit tests, is [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## 11. Unresolved decisions

**Six of these were settled at the v0.3 freeze** — five closed outright and one adopted
provisionally — and this section is left as written so that the reasoning behind each remains
readable. For what was decided and what would reverse it,
see [ARCHITECTURE_FREEZE.md](ARCHITECTURE_FREEZE.md) section 4: implementation language
(TypeScript), agent execution substrate (Claude Agent SDK, one session per dispatch, under a
binding allowlist-only condition), run store backend (files), work item identity without an
external key (exact scope plus normalized title), intake trust classification (closed for the
CLI host, extended per host), and static-analysis depth (adopted provisionally, resolved by
measurement in the MVP). The five that remain open are in the freeze's section 5, and none of
them blocks the first milestone.

Listed with when they must be resolved.

- **Implementation language** (before Phase 1). TypeScript or Python. Depends primarily on
  the agent execution substrate.
- **Agent execution substrate** (before Phase 1). Claude Code subagents, Agent SDK
  sessions, or direct API. The handoff contract is transport-agnostic specifically so this
  can change later without redesign. **Must be decided together with W5**: whichever
  substrate is chosen has to make `spawns_agents` detectable and refusable, or the "no
  agent invokes another agent" invariant is unenforceable on it. That is now a selection
  criterion, not an afterthought.
- **Run store backend** (Phase 1, revisit Phase 7). Files first for inspectability; SQLite
  if concurrency demands it.
- **Static analysis depth** (Phase 3). How much language-specific analysis to build versus
  rely on the model reading code. Probably: cheap structural analysis for graph edges,
  model reasoning for semantics. Needs a real experiment, not a guess.
- **Capability identity across runs** (Phase 3). How a capability keeps a stable identity
  as code changes, so carried-forward records remain meaningful.
- **Cost model** (Phase 2). A full audit of a large repository could be expensive. Tiered
  discovery is the mitigation; whether it is sufficient is unmeasured.
- **Product/UX evidence acquisition** (Phase 5). Screenshots require running the app,
  which requires environment setup AgentOS may not be able to do autonomously.
- **Human interaction channel** (Phase 6). Where authorization requests appear — CLI, PR
  comment, Jira, chat. Affects response-window policy.
- **Multi-repository capability graphs** (Phase 7). Design sketched, not specified.
- **Work item identity without an external key** (Phase 1). Content-derived ids and the
  similarity check that surfaces a possible duplicate are specified in principle; the
  similarity function is not, and it must be deterministic and model-free to sit in the
  kernel. A conservative first cut — exact scope plus normalized title match — is
  implementable now and will under-match, which is the right direction to be wrong in.
- **Intake trust classification on each host** (Phase 2). The rule is settled: `trust_class`
  comes from the host's authenticated context, never from content. What a given host can
  actually assert is not, and it differs sharply between a CLI, a CI runner and a webhook
  receiver. A host that cannot assert a principal must classify as `EXTERNAL`.

None of these block Phase 1 except the first two.

## 12. Testing AgentOS against Marksy

**Not yet.** The pilot runs at the end of Phase 3.

### Why Marksy is the right first target

The problems in Marksy's IPO intelligence were found manually, so ground truth exists
independently of AgentOS. That makes it a real test rather than a demo.

### Protocol

1. **Freeze ground truth first.** Before AgentOS runs, write down the manually-found
   problems — SME classification gap, incorrect SME subscription book, disconnected
   writers and readers, GMP provenance concerns, lifecycle/API/UI gaps, incorrect
   empty-state semantics, missing outcome evidence, UI information architecture problems —
   with evidence and severity. Store this outside the run, sealed.
2. **Run blind.** `agentos audit --repo <marksy> --goal "Make Marksy IPO intelligence
   production-complete."` AgentOS is given nothing but the goal. No hints, no ground truth,
   no `.agent/` directory seeded with answers.
3. **Compare.**

### Scoring

- **Recall** — how many known problems did AgentOS independently find? Each is `FOUND`
  (with correct evidence), `PARTIAL` (right area, wrong or incomplete diagnosis), or
  `MISSED`.
- **Precision** — of what AgentOS reported, how much is real? Each finding is `TRUE`,
  `FALSE` or `UNVERIFIABLE`.
- **Novel findings** — real problems the humans missed. This is the strongest possible
  signal, and worth more than recall.
- **Evidence quality** — can a human verify each finding from its evidence alone, without
  re-investigating?
- **Honesty** — did any `UNKNOWN` get reported as a `FACT`? Is coverage stated accurately?
  Are the gaps real?
- **Cost** — tokens, wall-clock, and human time to review.

### Pass criteria

- Recall of `CRITICAL` ground-truth problems: **at least 70%** `FOUND`
- Precision: **at least 80%** of reported findings `TRUE`
- **Zero** confidence violations — no `UNKNOWN` presented as `FACT`. This one is
  non-negotiable; a single instance fails the pilot regardless of every other score,
  because a system that confidently invents findings is worse than no system.
- Coverage statement is accurate — it does not claim to have examined what it did not

### Then generalize

Repeat against Ferret and Tradsy with goals whose ground truth is also known in advance.
A system that only works on Marksy is a Marksy tool, and this is not one. If a Marksy-shaped
assumption is discovered in the kernel during the pilot, it is a defect to be removed
before Phase 4.
