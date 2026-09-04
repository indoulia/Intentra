# Implementation Roadmap

## 1. Sequencing principle

Build in the order that **fails fastest and cheapest**. The riskiest assumption in AgentOS
is not orchestration — it is that automated discovery can produce a Context Package good
enough to reason from. If that is false, nothing downstream matters, so it gets built and
tested first.

Corollary: the first real deliverable is a **read-only** AgentOS. It discovers, audits and
reports, and changes nothing. That is testable against real repositories immediately, is
safe by construction, and is genuinely useful on its own.

## 2. Phase 0 — Architecture (this phase, complete)

Design documents and repository skeleton. No code.

## 3. Phase 1 — Contracts and kernel skeleton

Deliverables:

- Versioned schemas: `Assertion`, `Evidence`, `Finding`, `Blocker`, `HandoffEnvelope`,
  `ContextPackage`, `CapabilityRecord`, `AuthorizationRequest`/`Grant`, `DoDProfile`
- Schema validation with useful rejection messages
- Run store: `run.json`, `events.ndjson`, envelope persistence
- State machine with transition enforcement
- Run loop dispatching a single trivial agent
- CLI: `agentos run`, `agentos status`, `agentos narrate`

**Exit test:** start a run, kill the process mid-agent, restart, and have it resume
correctly from the log — not from memory, and not by starting over.

## 4. Phase 2 — Discovery (the high-risk phase)

Deliverables:

- Repository adapter with language/stack/convention detection
- Git adapter
- Host adapter: skill, tool and model enumeration
- Repository, git and capability-probe set
- Context Package assembly with confidence classification
- Tiered discovery (orientation, goal-relevant, on-demand) and coverage reporting

**Exit test:** run discovery against three genuinely different repositories — including
Ferret and Tradsy, not just Marksy — and have a human who knows each one confirm the
package is accurate, that its `UNKNOWN`s are honest, and that nothing was inferred as fact.
Discovery that quietly guesses is worse than discovery that reports gaps.

## 5. Phase 3 — Audit (the first real value)

Deliverables:

- Capability identification from intent, code and runtime
- Capability graph construction
- Orphan detection: writers, readers, stores, dead calculations, phantom APIs and UI
- Data-semantics analysis: fabricated defaults, collapsed absence, missing provenance and
  timestamps
- Test-quality analysis: what tests actually assert on
- Reconciliation matrix
- Project-management adapter (read-only) and runtime adapter (read-only)
- Findings report with evidence

**Exit test:** the Marksy pilot in section 8. This is where AgentOS either earns trust or
does not.

**End of Phase 3, AgentOS is useful and still writes nothing.** That is a deliberate
stopping point, and shipping it before building mutation capability is the safest way to
learn whether the evidence model works.

## 6. Phase 4 — Architecture and implementation

Deliverables:

- Architect agent: domain model, ownership, contracts, failure semantics, decisions
- Planner output: work units with DoD profiles
- Implementer agent with worktree isolation and convention matching
- `BLOCKED_BY_ARCHITECTURE` loop
- Git mutation: branch, commit, PR preparation
- Skill and model selection

**Exit test:** implement a small, real, previously-identified defect in a real repository,
end to end, producing a PR a reviewer accepts without knowing it was machine-authored.

## 7. Phase 5 — Validation and UX

Deliverables:

- Validator across five layers with per-layer verdicts
- Capability validation: trace a real record end to end
- Product/UX agent, including vision-based state review
- Rework loop with budgets
- DoD evaluation and completion reporting

**Exit test:** a run that *correctly fails* — the Validator rejects an implementation that
passes its unit tests but does not work, rework fixes it, and re-validation passes. Proving
AgentOS can say no is more important than proving it can say yes.

## 8. Phase 6 — Authorization and production

Deliverables:

- Authorization gates, request generation, grant lifecycle and adapter-level enforcement
- Security floor enforcement and violation logging
- Production agent: release planning, deployment, rollback verification
- Production validation evidence collection
- Full run narrative and observability views

**Exit test:** a complete run from goal to production with exactly the intended human gates
hit — no more, no fewer — and a run narrative a person who was absent can follow.

## 9. Phase 7 — Refinement

Multi-agent arbitration under real disagreement, sub-runs, parallelism, carried-forward
`.agent/` knowledge, selection heuristics replaced by measured data.

## 10. MVP definition

**The MVP is Phases 1–3: a read-only AgentOS that discovers and audits.**

```
agentos audit --repo <path> --goal "<goal>"
```

Given a repository path and a goal, it produces:

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
parallelism, sub-runs.

## 11. Unresolved decisions

Listed with when they must be resolved.

- **Implementation language** (before Phase 1). TypeScript or Python. Depends primarily on
  the agent execution substrate.
- **Agent execution substrate** (before Phase 1). Claude Code subagents, Agent SDK
  sessions, or direct API. The handoff contract is transport-agnostic specifically so this
  can change later without redesign.
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
