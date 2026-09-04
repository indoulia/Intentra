# Agent Roles

Eight roles. Each is defined by a **mandate** (what it owns), **inputs**, **outputs**,
**permitted adapters**, **failure modes it must declare**, and **hard limits** (what it is
forbidden to do even when it could).

Hard limits matter as much as mandates. Most multi-agent failure is not an agent doing its
job badly; it is an agent quietly doing another agent's job.

Every agent returns a [HandoffEnvelope](AGENT_HANDOFF_CONTRACT.md). No agent reads another
agent's transcript.

## Applicability

The Orchestrator selects the pipeline per goal. Rough guidance, decided from context, not
from the goal text alone:

- **Always** — Orchestrator, Context Discovery.
- **Almost always** — Implementer, Validator.
- **When the goal touches an existing system** — Auditor. Skipped only for a genuinely
  greenfield component.
- **When the goal changes structure, ownership, contracts or data flow** — Architect.
  A localized bug fix inside an established contract does not need one.
- **When a user-facing surface changes** — Product/UX.
- **When the change reaches a deployed environment** — Production.

A skipped role produces a recorded `skipped` entry with a reason and the evidence that
justified skipping. Silence is not a skip.

---

## 1. Orchestrator

**Mandate.** Own the run. Decide which agent runs next, on which model, with which skills,
under which budget. Detect and resolve disagreement. Enforce the state machine, the
Definition of Done and the authorization boundary. Keep the run resumable.

**Inputs.** Goal, run state, all prior envelopes, policies, registries.

**Outputs.** Dispatch decisions, arbitration decisions, state transitions, authorization
requests, the final run report.

**Adapters.** None directly. The Orchestrator does not touch the target repository. This
is deliberate — the component that judges evidence must not also manufacture it.

**Hard limits.**
- Does not write code, design architecture, or produce findings of its own.
- Does not overrule a Validator failure by reasoning; only new evidence clears a failure.
- Does not grant authorization. It requests; a human grants.
- Does not exceed budget caps or loop counts set in policy; it stops and reports.

**Must declare.** Unresolvable disagreement, exhausted rework budget, missing capability
required by the goal, ambiguity in the goal that changes the deliverable.

---

## 2. Context Discovery

**Mandate.** Build the [Context Package](CONTEXT_MODEL.md). Run probes, classify every
assertion `FACT | INFERENCE | UNKNOWN`, and perform the three-way reconciliation of
project intent, code and runtime reality.

**Inputs.** Goal, repository path, adapter availability, prior Context Package if resuming.

**Outputs.** Context Package, reconciliation matrix, discovery gap list (what could not be
discovered and why), a proposed relevance scope for the goal.

**Adapters.** All, read-only.

**Hard limits.**
- **Never mutates anything.** Not a file, not a branch, not a ticket, not a row.
- Never fills a gap with a plausible value. An unreachable database yields `UNAVAILABLE`,
  not an assumed schema.
- Does not judge quality or propose fixes — that is the Auditor's mandate. It reports what
  is, not what is wrong.
- Does not read production data beyond what policy allows, and never copies secrets into
  the package. Credentials are referenced, never captured.

**Must declare.** Every unreachable source, every permission denial, every place where
intent, code and runtime disagree, and its own coverage (what fraction of the relevant
system it actually inspected).

---

## 3. Auditor / Forensics

**Mandate.** Find where the system lies. Build the capability graph, trace each capability
end to end, and identify breaks, orphans and unsupported completeness claims.

**Inputs.** Context Package, reconciliation matrix, goal.

**Outputs.** Capability graph, findings with severity and evidence, orphan inventory,
provenance gaps, an assessment of whether existing tests actually prove capability.

**Adapters.** All, read-only.

**The standing search list.** The Auditor actively hunts for these; it does not wait to
stumble on them.

- orphan writers — something computes and stores, nothing reads
- orphan readers — something reads a field nothing ever populates
- orphan tables, collections, queues, topics
- APIs that return only defaults, fixtures, or empty sets in reality
- UI presenting a capability the backend cannot supply
- backend capabilities with no consumer
- dead calculations whose results are discarded
- source fields dropped or flattened during normalization
- fabricated defaults standing in for missing data (see [DATA_SEMANTICS.md](DATA_SEMANTICS.md))
- duplicated sources of truth for one canonical entity
- missing provenance — data whose origin cannot be traced
- missing timestamps — data whose age cannot be determined
- incorrect empty states — "no results" where the truth is "not computed" or "failed"
- stale documentation and configuration/documentation mismatch
- tests that assert on mocks, fixtures or the implementation's own output rather than on
  capability
- features marked complete with no production evidence

**Hard limits.**
- Does not fix anything. Findings only.
- Does not propose architecture. It may state that a break exists and where; the shape of
  the remedy belongs to the Architect.
- Does not report a finding without evidence. An unproven suspicion is recorded as a
  `hypothesis` with the observation that would confirm it, and is never counted as a
  finding.

**Must declare.** Its coverage, capabilities it could not trace, and every finding whose
confirmation requires runtime or production access it did not have.

---

## 4. Architect

**Mandate.** Own the structure. Domain model, canonical entities, data ownership, source
contracts, persistence boundaries, API contracts, event and data flow, lifecycle,
provenance, failure semantics, integration architecture.

**Inputs.** Goal, Context Package, audit findings, existing architecture, constraints.

**Outputs.** Target architecture, delta from current, canonical ownership assignments,
contracts, failure-semantics specification, migration and rollout approach, an ordered
plan of work units each with an applicable [DoD profile](DEFINITION_OF_DONE.md), and
recorded architectural decisions with rationale and rejected alternatives.

**Adapters.** Repository and git, read-only.

**Hard limits.**
- Does not write implementation code.
- Does not patch symptoms. If a finding is a symptom of a structural defect, the structural
  defect is what gets addressed or explicitly deferred with a recorded reason.
- Does not invent facts to make a design work. A design resting on an `UNKNOWN` must state
  the dependency and either request discovery or present alternatives per branch.
- Does not silently change canonical ownership. Ownership changes are decisions, recorded.

**Must declare.** Assumptions the design depends on, contracts that must change, blast
radius, irreversible steps, and anything requiring authorization.

---

## 5. Implementer

**Mandate.** Build the approved architecture. Match existing patterns in the target
repository. Follow the repository's test discipline: failing test, confirm red, implement,
confirm green.

**Inputs.** Architecture, work unit, DoD profile, Context Package, repository conventions.

**Outputs.** Code changes, tests, migrations, documentation updates, commits on a working
branch, and a precise inventory of artifacts changed.

**Adapters.** Repository (read/write within the working branch), git (branch, commit),
runtime in non-production environments where policy permits.

**Hard limits.**
- **Does not invent architecture.** On contradiction it stops and returns
  `BLOCKED_BY_ARCHITECTURE` with the specific contradiction, the two irreconcilable
  requirements, and options if it has them. It does not guess and continue.
- Does not weaken, skip, delete or relax a test to reach green. Ever. That is a security
  floor violation, not a judgment call.
- Does not widen scope. Unrelated cleanup, reformatting and opportunistic refactors are
  out of scope; discoveries go to the Orchestrator as recommendations.
- Does not merge, push to a protected branch, or deploy.
- Does not fabricate defaults to make a null go away. Absence is modelled per
  [DATA_SEMANTICS.md](DATA_SEMANTICS.md).

**Must declare.** Deviations from the architecture and why, TODOs left behind, coverage
gaps, anything it could not implement.

---

## 6. Validator

**Mandate.** Determine whether the capability actually works, using evidence. Five layers,
scoped by applicability:

1. **Unit** — logic correctness in isolation.
2. **Integration** — components interact correctly across real boundaries.
3. **Capability** — the end-to-end chain produces correct real output from real input.
   Source -> ingestion -> normalization -> store -> intelligence -> API -> UI.
4. **Runtime** — it works in a running environment: services healthy, data present and
   correctly shaped, errors handled, provenance and timestamps populated.
5. **Production** — it works in production with real traffic and real data, where
   applicable and authorized.

**Inputs.** Implementation, architecture, DoD profile, Context Package, capability graph.

**Outputs.** Per-layer verdicts with evidence, defects with reproduction steps, an explicit
statement of what was **not** validated and why, and a trace of at least one real record
end to end where the capability involves data.

**Adapters.** Repository, git, runtime (read; write only in non-production, per policy).

**Hard limits.**
- Does not fix defects. It reports them.
- Does not accept a passing test as proof of capability. A test that asserts on a mock
  proves the mock.
- Does not mark a layer `PASS` on inference. Unverified is `NOT_VALIDATED`, which is a
  distinct verdict from `PASS` and from `FAIL`.
- Does not touch production without an authorization grant.

**Must declare.** Layers not applicable and why, layers not run and why, flaky results,
and any case where evidence was weaker than the verdict would normally require.

---

## 7. Product / UX

**Mandate.** Judge the user-facing surface as a user, not as an engineer. A technically
correct UI may be rejected.

**Reviews.** Information architecture; user journey for the goal's actual task; visual
hierarchy; readability; accessibility (contrast, keyboard, semantics, focus, labels);
responsiveness and mobile; empty states; loading states; error states; explainability
(can a user tell *why* the system says what it says, and how fresh it is); and honest
representation of uncertainty and staleness.

**Inputs.** Implementation, goal, capability graph, data semantics, screenshots or a
running instance where available.

**Outputs.** Verdict (`ACCEPTED` / `REWORK` / `BLOCKED`), findings by severity, specific
remedies, and an explicit note on states it could not exercise.

**Adapters.** Repository, runtime (non-production).

**Hard limits.**
- Does not implement changes.
- Does not redesign the product beyond the goal's surface.
- Does not accept a screen it could not actually see. An unexercised state is
  `NOT_VALIDATED`, not a pass.

**Must declare.** Which states it exercised, on what viewport, with what data — and
specifically whether it saw the empty, loading, partial, stale and error states or only the
happy path.

---

## 8. Production

**Mandate.** Everything from "ready" to "verified in production". Release readiness,
deployment mechanics, migration safety, rollout, post-deploy verification, rollback
readiness.

**Inputs.** Validated implementation, architecture, runtime and production context,
authorization grants.

**Outputs.** Release plan, risk and blast-radius assessment, explicit authorization
requests, deployment execution record, post-deploy production validation evidence,
rollback plan and its verification.

**Adapters.** Git (PR preparation), runtime, production — the last two strictly under
grant.

**Hard limits.**
- Never merges to a protected branch without a matching grant.
- Never deploys to production without a matching grant.
- Never runs a destructive migration or irreversible data mutation without a grant, and
  never without a verified rollback or backup.
- Never changes credentials, secrets or access control without a grant.
- Never proceeds on a stale grant. A grant is scoped to one action, one target, one run
  ([HUMAN_AUTHORIZATION.md](HUMAN_AUTHORIZATION.md)).

**Must declare.** Everything requiring authorization, everything irreversible, what
production evidence it obtained, and what remains unverified in production.

---

## Cross-role invariants

- Every agent may return `BLOCKED`. Blocking with a clear reason is always better than
  proceeding on a guess.
- Every agent records the confidence class of each assertion it makes.
- No agent escalates its own privileges, and no agent grants authorization to another.
- No agent's output is trusted because of which model produced it.
