# AgentOS

A durable, repository-agnostic autonomous engineering operating system.

The user supplies **work**, in whatever form it already exists. AgentOS determines
everything else.

```
"Fix the namespace restoration bug."
"Work on EPIC-336."
"Take care of this PR."
<a webhook, a ticket, a review comment, a scheduled event>
```

AgentOS decides what the work actually is, what state it is already in, what outcome is
wanted, which workflow suits it, which agents it needs, and how to execute it safely — then
runs that workflow: discover context, understand the existing system, audit it, architect a
solution, plan, implement, validate, review the product experience, rework, re-validate,
handle review feedback, and stop at the human authorization boundary before anything
high-impact happens.

The user never has to say whether something is an Epic or a Defect, which workflow applies,
which stages are needed, or whether to resume or start over.

## Status

**Architecture v0.3 — internally consistent, adversarially traced, implementation-ready,
zero production code.**

There is no application code in this repository yet, and that is deliberate. This phase
produces the contracts and models that the implementation must satisfy. See
[docs/IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md) for what gets built and
in what order.

## Design premise

AgentOS is not a prompt library. It is a system with durable state, typed contracts
between agents, an evidence model, and explicit authorization boundaries. Agents are
replaceable; the contracts are the product.

```
USER          → WORK, IN ANY FORM
AGENTOS       → WHAT IT IS, WHERE IT STANDS, WHAT IT NEEDS
AGENTS        → REASONING
REPOSITORY    → IMPLEMENTATION REALITY
RUNTIME/PROD  → TRUTH
TESTS         → EVIDENCE
KERNEL        → COORDINATION, AND THE REFUSAL TO TAKE ANY OF IT ON TRUST
HUMAN         → AUTHORITY FOR HIGH-IMPACT DECISIONS
```

## Universality

AgentOS encodes **no** business logic for any specific product. Marksy, Ferret and Tradsy
are target repositories, not dependencies. Anything a target repository needs to tell
AgentOS is either discovered automatically or supplied through the optional
[repository adapter](docs/REPOSITORY_ADAPTER.md). A repository with no `.agent/`
directory must work.

## Documents

Read in this order.

1. [AGENTOS_PRINCIPLES.md](AGENTOS_PRINCIPLES.md) — the non-negotiables, one page.
2. [docs/AGENTOS_ARCHITECTURE.md](docs/AGENTOS_ARCHITECTURE.md) — system shape, components, repository layout.
3. [docs/KERNEL_BOUNDARY.md](docs/KERNEL_BOUNDARY.md) — kernel vs agents, the dependency rule, component ownership, invariants.
4. [docs/AGENT_ROLES.md](docs/AGENT_ROLES.md) — the eight roles, their mandates and limits.
5. [docs/INTENT_AND_WORK_ITEM_RESOLUTION.md](docs/INTENT_AND_WORK_ITEM_RESOLUTION.md) — how any source becomes a Work Item, and how AgentOS finds out where it already stands.
6. [docs/CONTEXT_MODEL.md](docs/CONTEXT_MODEL.md) — the Context Package and the discovery probes that fill it.
7. [docs/DATA_SEMANTICS.md](docs/DATA_SEMANTICS.md) — universal meanings of ZERO, NULL, UNKNOWN and friends.
8. [docs/CAPABILITY_MODEL.md](docs/CAPABILITY_MODEL.md) — capability registry and the capability graph the Auditor builds.
9. [docs/WORKFLOW_STATE_MACHINE.md](docs/WORKFLOW_STATE_MACHINE.md) — stages, workflow templates, the graph, resumption, durable state, interruption recovery.
10. [docs/AGENT_HANDOFF_CONTRACT.md](docs/AGENT_HANDOFF_CONTRACT.md) — the envelope every agent returns.
11. [docs/DEFINITION_OF_DONE.md](docs/DEFINITION_OF_DONE.md) — capability-level completion, dynamically scoped.
12. [docs/HUMAN_AUTHORIZATION.md](docs/HUMAN_AUTHORIZATION.md) — the gate model and security floor.
13. [docs/SKILL_AND_MODEL_SELECTION.md](docs/SKILL_AND_MODEL_SELECTION.md) — dynamic skill and model routing.
14. [docs/REPOSITORY_ADAPTER.md](docs/REPOSITORY_ADAPTER.md) — how AgentOS attaches to any repository.
15. [docs/IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md) — MVP, phases, and the Marksy proving ground.

## Repository layout

```
agent-os/
├── core/         kernel: orchestration loop, state machine, run ledger, event log
├── agents/       role definitions (mandate, inputs, outputs, tools) — specs, not prompts
├── contracts/    schemas: handoff envelope, context package, capability record, verdicts
├── discovery/    probes that fill the Context Package
├── registries/   capability, skill and model registries
├── policies/     authorization boundaries, security floor, DoD profiles, data semantics
├── adapters/     repository, git, project-management, runtime and host adapters
├── state/        durable work items and their runs (schema tracked; data ignored)
└── docs/         this design
```

Each code directory currently holds only a README describing its purpose; `docs/` holds the
design. Nothing is implemented yet. Every planned component is mapped to exactly one of
these directories in [docs/KERNEL_BOUNDARY.md](docs/KERNEL_BOUNDARY.md).

**Dependency rule:** `agents -> contracts / policies / registries / adapters`, never
`agents -> core`. Delete `core/` and every agent should still compile.

## Non-goals

- Not a replacement for human judgment on irreversible actions.
- Not a CI system. AgentOS invokes CI; it does not become CI.
- Not a chat wrapper. Conversation is never the transport between agents.
