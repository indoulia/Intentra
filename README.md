# AgentOS

A durable, repository-agnostic autonomous engineering operating system.

The user supplies a **goal**. AgentOS discovers everything else.

```
"Build X in repository Y."
```

AgentOS then runs the engineering lifecycle itself: discover context, understand the
existing system, audit it, architect a solution, plan, implement, validate, review the
product experience, rework, re-validate, and stop at the human authorization boundary
before anything high-impact happens.

## Status

**Architecture v0.2 — internally consistent, adversarially traced, implementation-ready,
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
USER          → GOAL
AGENTOS       → CONTEXT
AGENTS        → REASONING
REPOSITORY    → IMPLEMENTATION REALITY
RUNTIME/PROD  → TRUTH
TESTS         → EVIDENCE
ORCHESTRATOR  → COORDINATION
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
5. [docs/CONTEXT_MODEL.md](docs/CONTEXT_MODEL.md) — the Context Package and the discovery probes that fill it.
6. [docs/DATA_SEMANTICS.md](docs/DATA_SEMANTICS.md) — universal meanings of ZERO, NULL, UNKNOWN and friends.
7. [docs/CAPABILITY_MODEL.md](docs/CAPABILITY_MODEL.md) — capability registry and the capability graph the Auditor builds.
8. [docs/WORKFLOW_STATE_MACHINE.md](docs/WORKFLOW_STATE_MACHINE.md) — durable run state, transitions, interruption recovery.
9. [docs/AGENT_HANDOFF_CONTRACT.md](docs/AGENT_HANDOFF_CONTRACT.md) — the envelope every agent returns.
10. [docs/DEFINITION_OF_DONE.md](docs/DEFINITION_OF_DONE.md) — capability-level completion, dynamically scoped.
11. [docs/HUMAN_AUTHORIZATION.md](docs/HUMAN_AUTHORIZATION.md) — the gate model and security floor.
12. [docs/SKILL_AND_MODEL_SELECTION.md](docs/SKILL_AND_MODEL_SELECTION.md) — dynamic skill and model routing.
13. [docs/REPOSITORY_ADAPTER.md](docs/REPOSITORY_ADAPTER.md) — how AgentOS attaches to any repository.
14. [docs/IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md) — MVP, phases, and the Marksy proving ground.

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
├── state/        durable run state (schema tracked; run data ignored)
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
