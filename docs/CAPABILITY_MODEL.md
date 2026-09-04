# Capability Model

A **capability** is something the target system can actually do for someone, end to end.
Not a module, not a table, not an endpoint, not a ticket.

The capability is AgentOS's unit of truth. Completion is judged per capability
([DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md)), audits are structured per capability, and
the reconciliation of intent, code and runtime happens per capability.

The registry's purpose is blunt: **make disconnected architecture visible**. A system where
every module is well written and nothing is connected passes every test suite and delivers
nothing.

## 1. The capability chain

```
SOURCE -> INGESTION -> NORMALIZATION -> CANONICAL STORE -> INTELLIGENCE
       -> API -> UI -> OUTCOME -> LEARNING
```

Each stage, and the honest question it must answer:

- **SOURCE** — where the raw information originates. Is it real, reachable, authorized,
  and does its contract match what we assume?
- **INGESTION** — how it gets in. Does it actually run? When did it last succeed? What
  happens when it fails?
- **NORMALIZATION** — how raw becomes canonical. **Which source fields are dropped here,
  and was that deliberate?** This stage is where information dies quietly.
- **CANONICAL STORE** — where the truth lives. Is there exactly one owner for this entity?
  Does the stored data carry provenance and timestamps?
- **INTELLIGENCE** — derivation, classification, scoring, aggregation. Are the results
  stored and read, or computed and discarded? Is the confidence honest?
- **API** — how consumers get it. Does it return real data, or defaults and fixtures? Does
  it preserve data semantics?
- **UI** — how a human sees it. Does the surface exist, does it show truth, does it handle
  empty, partial, stale and error states?
- **OUTCOME** — what changes for the user because this exists. Is there any evidence anyone
  uses it?
- **LEARNING** — how the system knows whether it was right, and improves. Often absent, and
  its absence should be stated, not ignored.

Not every stage applies to every capability. Applicability is determined per capability and
recorded; a stage marked `NOT_APPLICABLE` must carry a reason.

## 2. Capability record

```
CapabilityRecord
  id                   stable slug within the run
  name                 human-readable
  description          what it does for whom
  canonical_entity     the entity it owns or operates on
  status               see section 4
  chain                per-stage records (section 3)
  inputs               sources with contracts and freshness expectations
  writers              what produces or mutates the data
  storage              where it lives, who owns it, retention
  consumers            what reads it (code references, not assumptions)
  api                  endpoints exposing it
  ui                   surfaces presenting it
  provenance           can each value's origin and age be established
  observability        logs, metrics, traces, alerts covering it
  validation           per-layer verdicts (see DEFINITION_OF_DONE.md)
  production_evidence  proof it works in production
  outcome              what it changes for a user; evidence of use
  learning             feedback loop, if any
  reconciliation       ALIGNED | CODE_NO_RUNTIME | CLAIMED_DONE_UNPROVEN | ...
  findings             linked audit findings
  confidence           FACT | INFERENCE | UNKNOWN for the record as a whole
```

## 3. Stage record

Each stage carries:

- `applicable` — true, false, or unknown, with a reason when false
- `implemented` — is there code
- `connected` — is it wired to the adjacent stages
- `exercised` — does it demonstrably run
- `evidence` — what proves the above
- `semantics` — how it represents absence and uncertainty
  ([DATA_SEMANTICS.md](DATA_SEMANTICS.md))
- `defects` — findings attached to this stage

`implemented` without `connected` is an orphan. `connected` without `exercised` is a
capability that exists only on paper. Both are findings; the second is the one that gets
demoed successfully and then fails in production.

## 4. Capability status

- `PROVEN` — chain complete and validated with production evidence
- `WORKING` — validated end to end in a runtime environment, not yet proven in production
- `PARTIAL` — some stages work, some do not; the specific break is identified
- `DISCONNECTED` — stages exist but the chain is broken; nothing flows end to end
- `ORPHANED` — code exists with no consumer, or a consumer exists with no producer
- `CLAIMED` — asserted complete by intent, with no supporting evidence
- `ABSENT` — does not exist
- `UNKNOWN` — could not be determined; must state why

`CLAIMED` is deliberately distinct from `WORKING`. Most "done" features in most systems are
`CLAIMED` until someone traces a real record end to end.

## 5. The capability graph

Nodes are stages, edges are real data flow established from code and, where possible,
confirmed at runtime. The graph is what turns vague unease into a specific finding.

Detectable structurally:

- **Orphan writer** — a node with no outbound edge into any consumer
- **Orphan reader** — a node consuming a field with no writer
- **Orphan store** — a store with writers and no readers, or readers and no writers
- **Dead calculation** — an intelligence node whose output reaches no store, API or UI
- **Broken chain** — no path from SOURCE to UI (or to the terminal consumer)
- **Phantom API** — an API node with no path back to a real source
- **Phantom UI** — a UI node with no backing API or with an API returning only defaults
- **Duplicate ownership** — two stores claiming canonical ownership of one entity
- **Field loss** — source fields present at ingestion and absent after normalization
- **Provenance break** — an edge across which origin or timestamp is not carried

Graph edges carry confidence. A static-analysis edge is an `INFERENCE`; an edge confirmed
by tracing a real record through a runtime is a `FACT`. The Auditor should upgrade critical
edges from inference to fact wherever runtime access allows, because that upgrade is where
most real defects surface.

## 6. Discovery

Capabilities are identified from evidence, not from a taxonomy:

1. **Intent** — EPICs, issues and docs name intended capabilities.
2. **Code** — entry points, endpoints, jobs, pipelines and UI routes imply capabilities.
3. **Runtime** — tables with data, endpoints receiving traffic, jobs that ran.
4. **Merge** — reconcile into one list, keeping every source's claim distinct.

A capability that appears in only one source is itself a finding, and which source it
appears in tells you what kind of finding it is.

## 7. Registry lifecycle

The registry is built during Context Discovery, deepened during Audit, updated by the
Architect (new and changed capabilities), by the Implementer (chain stages now
implemented), by the Validator (verdicts and evidence) and by Production (production
evidence).

It is persisted with the run, and its schema is stable enough to be carried into the target
repository's `.agent/` directory as durable knowledge, so the next run starts from what the
last run established rather than rediscovering it. Carried-forward records are re-validated
for freshness before use, never trusted blindly.

## 8. What the registry is for

Two questions, answerable at a glance:

- "Which capabilities does this system genuinely have, and how do we know?"
- "Where exactly is this capability broken?"

If a registry cannot answer both with evidence, it has become documentation, and
documentation is what AgentOS exists to stop trusting.
