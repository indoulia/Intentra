# Intentra

**From intent to verified outcome.**

Intentra is a source-agnostic, work-item-driven autonomous execution system. Give it work in whatever form it already exists; Intentra determines what the work is, where it stands, what outcome is wanted, which workflow applies, which capabilities are needed, and how to execute it safely.

```text
"Fix the namespace restoration bug."
"Work on EPIC-336."
"Take care of this PR."
<a webhook, a ticket, a review comment, a scheduled event>
```

Intentra resolves intent and work-item identity, discovers current reality, selects an admissible workflow, dispatches agents through typed contracts, validates their claims against evidence, adapts when reality changes, and stops at the human authorization boundary before high-impact actions.

The user does not need to say whether something is an Epic or Defect, which workflow applies, which stages are needed, or whether to resume or start over.

## Status

**Architecture v0.3 — frozen 2026-09-04. Read-only implementation baseline.**

The architecture is frozen. The fourteen normative documents are pinned by hash in [docs/freeze/v0.3.sha256](docs/freeze/v0.3.sha256), and disagreement between implementation and architecture is resolved through the documented amendment process in [docs/ARCHITECTURE_FREEZE.md](docs/ARCHITECTURE_FREEZE.md).

The implementation is being built as a **read-only MVP first**: it discovers, reasons, audits and validates, but performs no production mutations. The implementation sequence is defined in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

> **Naming note:** The architecture documents retain the historical `AgentOS` terminology because they are part of the frozen v0.3 record. The product and implementation are now branded **Intentra**.

## Design premise

Intentra is not a prompt library and not merely an agent framework. It is a durable execution system with typed contracts, evidence, explicit workflow policy, stateful runs and authorization boundaries. Agents are replaceable; the contracts and kernel guarantees are the product.

```text
ANY SOURCE       → INTENT
INTENTRA         → WHAT IT IS, WHERE IT STANDS, WHAT IT NEEDS
AGENTS           → REASONING
REPOSITORY       → IMPLEMENTATION REALITY
RUNTIME / PROD   → TRUTH
TESTS            → EVIDENCE
KERNEL           → COORDINATION, VERIFICATION, POLICY, STATE
HUMAN            → AUTHORITY FOR HIGH-IMPACT DECISIONS
```

## Core model

Intentra keeps these concepts distinct:

- **Work Item** — the durable unit of work.
- **Workflow Run** — one attempt to advance that Work Item.
- **Workflow** — an admissible graph selected from policy-defined templates.
- **Stage / Work Unit** — executable parts of a workflow.
- **Artifact** — code, PRs, documents and other produced or referenced objects.
- **Evidence** — observations used to establish what is true.
- **Gate** — an authorization or policy boundary.
- **Outcome** — the verified result of the work.

Existing work is resumed from current reality, never restarted merely because a new request arrived.

## Universality

Intentra encodes no business logic for a specific product. Marksy, Ferret and Tradsy are proving-ground repositories, not dependencies. Repository-specific knowledge is discovered or supplied through the optional [repository adapter](docs/REPOSITORY_ADAPTER.md). A target repository with no Intentra-specific files must work.

## Architecture documents

The frozen architecture is documented under `docs/`. Start here:

1. [AGENTOS_PRINCIPLES.md](AGENTOS_PRINCIPLES.md) — the frozen non-negotiables.
2. [docs/AGENTOS_ARCHITECTURE.md](docs/AGENTOS_ARCHITECTURE.md) — system shape and repository layout.
3. [docs/KERNEL_BOUNDARY.md](docs/KERNEL_BOUNDARY.md) — kernel/agent ownership and invariants.
4. [docs/INTENT_AND_WORK_ITEM_RESOLUTION.md](docs/INTENT_AND_WORK_ITEM_RESOLUTION.md) — intent resolution and current reality.
5. [docs/WORKFLOW_STATE_MACHINE.md](docs/WORKFLOW_STATE_MACHINE.md) — workflow graphs, resumption and recovery.
6. [docs/AGENT_HANDOFF_CONTRACT.md](docs/AGENT_HANDOFF_CONTRACT.md) — the typed agent envelope.
7. [docs/DEFINITION_OF_DONE.md](docs/DEFINITION_OF_DONE.md) — capability-level completion.
8. [docs/HUMAN_AUTHORIZATION.md](docs/HUMAN_AUTHORIZATION.md) — authorization gates and security floor.
9. [docs/ARCHITECTURE_FREEZE.md](docs/ARCHITECTURE_FREEZE.md) — the v0.3 freeze and amendment protocol.
10. [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) — implementation work packages and verification.

See [docs/README.md](docs/README.md) for the complete reading order and canonical definition map.

## Repository layout

```text
intentra/
├── core/         deterministic kernel: state, policy, gates and run ledger
├── agents/       role definitions and agent-facing execution
├── contracts/    typed schemas and handoff contracts
├── discovery/    probes that establish current reality
├── registries/   capability, skill and model registries
├── policies/     workflow, authorization and security policy
├── adapters/     repository, git, project-management and runtime adapters
├── state/        durable work items and workflow runs
└── docs/         architecture, freeze and implementation documentation
```

**Dependency rule:** `agents → contracts / policies / registries / adapters`, never `agents → core`. Delete `core/` and every agent should still compile.

## Non-goals

- Not a replacement for human judgment on irreversible actions.
- Not a CI system. Intentra invokes CI; it does not become CI.
- Not a chat wrapper. Conversation is never the transport between agents.
- Not a repository-specific automation product.

## License

License and distribution details will be added as the implementation matures.
