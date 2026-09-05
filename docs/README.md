# Intentra Design

Architecture v0.3 — **frozen 2026-09-04**, implementation baseline.

The public product is now branded **Intentra**. The fourteen normative architecture documents below retain their historical `AgentOS` terminology and are pinned by hash in [freeze/v0.3.sha256](freeze/v0.3.sha256). Do not edit a frozen document casually: read [ARCHITECTURE_FREEZE.md](ARCHITECTURE_FREEZE.md) section 3 before proposing an amendment.

## Read in this order

1. [../AGENTOS_PRINCIPLES.md](../AGENTOS_PRINCIPLES.md) — the frozen non-negotiables.
2. [AGENTOS_ARCHITECTURE.md](AGENTOS_ARCHITECTURE.md) — system shape, components, layout.
3. [KERNEL_BOUNDARY.md](KERNEL_BOUNDARY.md) — kernel vs agents, dependency rule and invariants.
4. [INTENT_AND_WORK_ITEM_RESOLUTION.md](INTENT_AND_WORK_ITEM_RESOLUTION.md) — how any source becomes a Work Item and how current reality is established.
5. [AGENT_ROLES.md](AGENT_ROLES.md) — the eight roles, mandates and hard limits.
6. [CONTEXT_MODEL.md](CONTEXT_MODEL.md) — the Context Package and discovery probes.
7. [DATA_SEMANTICS.md](DATA_SEMANTICS.md) — absence and uncertainty vocabulary.
8. [CAPABILITY_MODEL.md](CAPABILITY_MODEL.md) — capability registry and graph.
9. [WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) — stages, templates, graph, resumption and recovery.
10. [AGENT_HANDOFF_CONTRACT.md](AGENT_HANDOFF_CONTRACT.md) — the typed envelope.
11. [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md) — capability-level completion.
12. [HUMAN_AUTHORIZATION.md](HUMAN_AUTHORIZATION.md) — gates and security floor.
13. [SKILL_AND_MODEL_SELECTION.md](SKILL_AND_MODEL_SELECTION.md) — dynamic routing.
14. [REPOSITORY_ADAPTER.md](REPOSITORY_ADAPTER.md) — attaching to any repository.
15. [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) — phases, readiness, MVP and pilot.
16. [ARCHITECTURE_FREEZE.md](ARCHITECTURE_FREEZE.md) — what is frozen and the amendment protocol.
17. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — work packages and the invariant suite for the read-only MVP.

## Product model

Intentra is **source-agnostic and work-item-driven**:

`ANY SOURCE → INTENT → WORK ITEM → CURRENT REALITY → DESIRED OUTCOME → WORKFLOW → AGENTS / CAPABILITIES → POLICY / GATES → EXECUTION → VALIDATION → OUTCOME`

The kernel remains deterministic. Agents reason and propose; the kernel verifies, admits, persists and enforces. Work Items outlive individual Workflow Runs, and existing work resumes from reality rather than restarting from the request.

## Where each thing is defined, once

A term is defined in exactly one architecture document; everywhere else references it. The canonical map remains the one established by the frozen v0.3 architecture:

- Confidence classes — CONTEXT_MODEL
- Intake sources and `trust_class` — INTENT_AND_WORK_ITEM_RESOLUTION
- Work Item types and lifecycle — INTENT_AND_WORK_ITEM_RESOLUTION
- Current Reality and source-authority rule — INTENT_AND_WORK_ITEM_RESOLUTION
- Stages, workflow templates, workflow floor and resumption — WORKFLOW_STATE_MACHINE
- Adapter operation descriptor and `observation_safe` — REPOSITORY_ADAPTER
- Absence vocabulary — DATA_SEMANTICS
- Evidence kinds and reconciliation — CONTEXT_MODEL
- Capability statuses and chain stages — CAPABILITY_MODEL
- Envelope statuses and kernel actions — AGENT_HANDOFF_CONTRACT / WORKFLOW_STATE_MACHINE
- Blocker kinds — AGENT_HANDOFF_CONTRACT
- Work Item / Workflow Run split — WORKFLOW_STATE_MACHINE
- DoD criteria and verdicts — DEFINITION_OF_DONE
- Authorization gates and security floor — HUMAN_AUTHORIZATION
- Kernel/agent ownership — KERNEL_BOUNDARY

## Open decisions

The open decisions and their constraints are recorded in [ARCHITECTURE_FREEZE.md](ARCHITECTURE_FREEZE.md). None of the decisions left open at the v0.3 freeze is permitted to block the read-only MVP.
