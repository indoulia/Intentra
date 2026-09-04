# AgentOS Design

Architecture v0.2 — internally consistent, adversarially traced, implementation-ready,
zero production code.

## Read in this order

1. [../AGENTOS_PRINCIPLES.md](../AGENTOS_PRINCIPLES.md) — the non-negotiables, one page.
2. [AGENTOS_ARCHITECTURE.md](AGENTOS_ARCHITECTURE.md) — system shape, components, layout.
3. [KERNEL_BOUNDARY.md](KERNEL_BOUNDARY.md) — kernel vs agents, the dependency rule,
   component ownership, invariants. **The load-bearing document.**
4. [AGENT_ROLES.md](AGENT_ROLES.md) — the eight roles, mandates and hard limits.
5. [CONTEXT_MODEL.md](CONTEXT_MODEL.md) — the Context Package and discovery probes.
6. [DATA_SEMANTICS.md](DATA_SEMANTICS.md) — the absence and uncertainty vocabulary.
7. [CAPABILITY_MODEL.md](CAPABILITY_MODEL.md) — capability registry and graph.
8. [WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) — states, transitions, recovery.
9. [AGENT_HANDOFF_CONTRACT.md](AGENT_HANDOFF_CONTRACT.md) — the envelope.
10. [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md) — capability-level completion.
11. [HUMAN_AUTHORIZATION.md](HUMAN_AUTHORIZATION.md) — gates and the security floor.
12. [SKILL_AND_MODEL_SELECTION.md](SKILL_AND_MODEL_SELECTION.md) — dynamic routing.
13. [REPOSITORY_ADAPTER.md](REPOSITORY_ADAPTER.md) — attaching to any repository.
14. [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) — phases, readiness, MVP, pilot.

## Where each thing is defined, once

A term is defined in exactly one document; everywhere else references it. If you find a
definition restated, that is drift and should be replaced with a link.

- Confidence classes (`FACT` / `INFERENCE` / `UNKNOWN`) — CONTEXT_MODEL
- Absence vocabulary (`ZERO` … `INSUFFICIENT_EVIDENCE`) — DATA_SEMANTICS
- Freshness axis (`CURRENT` / `STALE` / `UNKNOWN`) — CONTEXT_MODEL
- Evidence kinds (the ten) — CONTEXT_MODEL, shared verbatim by the envelope
- Reconciliation states (`ALIGNED` … `INDETERMINATE`) — CONTEXT_MODEL
- Capability statuses (`PROVEN` … `UNKNOWN`) — CAPABILITY_MODEL
- Chain stages (`SOURCE` … `LEARNING`) — CAPABILITY_MODEL
- Envelope statuses and their kernel actions — AGENT_HANDOFF_CONTRACT (values),
  WORKFLOW_STATE_MACHINE section 2.1 (actions)
- Blocker kinds — AGENT_HANDOFF_CONTRACT
- Workflow states and transitions — WORKFLOW_STATE_MACHINE
- DoD criteria, ownership, verdicts — DEFINITION_OF_DONE
- Authorization gates and the security floor — HUMAN_AUTHORIZATION
- Kernel/agent ownership and the dependency rule — KERNEL_BOUNDARY

## Open decisions

Nine, in IMPLEMENTATION_ROADMAP section 11. Three sit inside the MVP and are the immediate
next work: agent execution substrate, static-analysis depth, implementation language.
