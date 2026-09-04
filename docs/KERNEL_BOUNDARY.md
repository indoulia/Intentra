# Kernel Boundary

The load-bearing separation in AgentOS. Everything else can be refactored; if this line
blurs, the system degrades into a prompt collection with extra files.

## 1. The contradiction this document resolves

The Phase 0 drafts said two incompatible things:

- the kernel "contains no domain knowledge and no prompts" and its run loop is "pure with
  respect to the run store"
- the Orchestrator is one of eight agents, runs on a model, and "composes the pipeline
  from the goal and the discovered context"

Both cannot be true of one component. Composing a pipeline from a natural-language goal is
judgment; judgment needs a model; a model is not pure.

**Resolution: split them.**

- **Kernel** — deterministic code. No model, no prompt, no judgment.
- **Orchestrator Agent** — a model-backed agent like any other. It *advises*.

The Orchestrator Agent proposes; the Kernel disposes. Where they disagree, the Kernel
wins, and the override is logged.

This preserves the property that matters: **a run's safety and durability do not depend on
a model behaving well.** A confused, adversarial or hallucinating Orchestrator Agent can
degrade a run's quality. It cannot corrupt state, skip a gate, or escape the state
machine.

## 2. The dependency rule

```
        agents  ---->  contracts  <----  kernel
           |            policies           |
           |            registries         |
           |               ^               |
           +----> adapters +---------------+

        allowed:  agents -> contracts, policies, registries, adapters
        allowed:  kernel -> contracts, policies, registries, adapters, state
        FORBIDDEN: agents -> core/   (any kernel internal, at all)
        FORBIDDEN: kernel -> agents/ (except by the dispatch interface)
        FORBIDDEN: contracts -> anything
```

Stated as rules:

1. **Agents never import, call, or read kernel internals.** Not the run loop, not the
   state machine, not the event log writer, not the run store. An agent that can reach
   into `core/` can bypass every guarantee in this document.
2. **Agents depend only on `contracts/`, `policies/`, `registries/` and `adapters/`.**
   These are the agent-facing surface.
3. **The kernel depends on agents only through one interface** — dispatch a typed input,
   receive a typed envelope. The kernel does not know what an agent is internally, which
   model it used, or how it reasoned.
4. **`contracts/` depends on nothing.** It is the shared vocabulary. A contract that
   imports a kernel type has coupled the two sides together permanently.
5. **All outside-world access goes through `adapters/`.** No agent and no kernel component
   opens a file, runs a command, or makes a request directly.
6. **Only the kernel writes to `state/`.** Agents produce envelopes; the kernel persists
   them. An agent that can write run state can rewrite history.

The practical test: **delete `core/` and every agent should still compile.** If an agent
breaks, the boundary has leaked.

## 3. What the kernel owns

Everything here is deterministic, model-free, and testable without a model.

- **Dispatch** — build an agent's typed input, invoke it, receive its envelope.
- **Envelope validation** — schema conformance; rejection of findings without evidence, of
  `COMPLETE` with unfilled required outputs, of assertions with no confidence class.
- **State machine enforcement** — legality of every transition. An agent's `next_action` is
  a proposal, validated against the transition table.
- **Event log** — append-only, write-before-act, the authoritative record.
- **Run store** — the only writer. Projections (`run.json`, run narrative) derive from the
  log.
- **Recovery** — replay the log, rebuild the cursor, detect interrupted steps, retry or
  block.
- **Budget and loop accounting** — rework counts, architecture-loop counts, cost, wall
  clock. Enforcement is mechanical; exceeding a cap is `BLOCKED`.
- **Policy enforcement** — gates, the security floor, DoD applicability. Policy is data the
  kernel checks, not behaviour an agent is asked to remember.
- **DoD arithmetic** — given per-criterion verdicts from agents, compute the completion
  verdict. The kernel does not judge a criterion; it counts them and applies the rule that
  `NOT_VALIDATED` is never `MET`.
- **Conflict detection** — mechanical comparison of new assertions against existing ones.
- **Authorization lifecycle** — request records, grant records, expiry, scope, revocation.
- **Selection and recording** — choosing an agent, model and skills from ranked candidates
  supplied by the registries, and recording the choice.
- **Operator interface** — CLI and observability projections over the run store.

## 4. What agents own

Everything requiring judgment.

- Interpreting the goal
- Deciding what to look at and how deep
- Reading and understanding code
- Determining whether evidence supports a claim
- Identifying capabilities and drawing graph edges
- Designing architecture
- Writing code and tests
- Judging whether a capability works
- Judging whether a UI is acceptable
- Proposing which agents should run next, and why
- Proposing how to resolve a disagreement

The Orchestrator Agent's outputs — pipeline composition, arbitration resolution, model and
skill preference — are all proposals in an envelope. Each is validated and may be
overridden.

## 5. The one hard case: arbitration

Arbitration spans the boundary, so it is split explicitly:

1. **Kernel detects** the conflict — two assertions about the same subject are
   incompatible. Mechanical.
2. **Kernel classifies** by rule where it can: if the two assertions differ in confidence
   class, `FACT` beats `INFERENCE` beats `UNKNOWN` with no model involved. Most conflicts
   die here.
3. **Orchestrator Agent resolves** what remains — factual conflicts by naming the
   discriminating observation, interpretive ones by applying policy and DoD.
4. **Kernel executes** the resolution: dispatching the probe, or escalating to a human when
   the agent says it cannot settle it.
5. **Kernel records** the decision, the losing position and the evidence.

The kernel never decides *who is right* on the merits. The agent never decides *what
happens next*.

## 6. Business-logic leak tests

Apply these to any kernel change. A `yes` to any of them means the logic belongs in an
agent, a policy file, or a registry.

- Does it require reading source code to decide?
- Does it require understanding what the product does?
- Does it name a language, framework, database, or vendor?
- Would it need editing when a new target repository is onboarded?
- Would it need editing when a new model becomes available?
- Does it contain a prompt, a heuristic, or a threshold that someone tuned by feel?
- Would two reasonable engineers disagree about the right answer?

Thresholds that are genuinely tunable (rework cap, cost ceiling, freshness windows) live in
`policies/` as data, not in kernel code.

## 7. Component ownership map

Every planned component, its primary directory, and — where it spans two — the split.

**core/** — run loop; state machine enforcement; event log; run store writer; recovery;
budget accounting; policy enforcement; DoD arithmetic; conflict detection; authorization
lifecycle; agent/model/skill selection and recording; CLI; observability projections.

**agents/** — role specifications for all eight roles, including the Orchestrator Agent.

**contracts/** — schema definitions. *Definition* only; enforcement is `core/`.

**discovery/** — probes; Context Package assembly; reconciliation matrix construction;
coverage accounting.

**registries/** — capability, skill and model registries: representation, indexing, query
and **ranking**. Registries rank; they do not select. Selection and its recording are
`core/`.

**policies/** — gate definitions; the security floor statement; DoD profiles and
applicability rules; data-semantics vocabulary; budgets and thresholds. Data, not code.

**adapters/** — repository, git, project-management, runtime, host. Also the **enforcement
point** for authorization (a grant is checked here at execution time, not by the agent
requesting it), for redaction, and for platform differences.

**state/** — durable run data. Written only by `core/`. Schema tracked, data ignored.

**docs/** — design.

### Components that span directories, resolved

- **Schemas** — defined in `contracts/`, enforced in `core/`.
- **Authorization** — gates defined in `policies/`, request/grant lifecycle in `core/`,
  enforcement at execution in `adapters/`.
- **Security floor** — stated in `policies/`, enforced in `adapters/`, violations logged by
  `core/`.
- **Capability registry** — schema and query in `registries/`, populated by agents through
  envelopes, persisted by `core/`.
- **Skill and model selection** — ranking in `registries/`, selection and recording in
  `core/`.
- **Budgets** — limits in `policies/`, accounting and enforcement in `core/`.
- **DoD** — profiles in `policies/`, per-criterion verdicts from agents, arithmetic in
  `core/`.

### Components that had no home, now assigned

- **CLI (`agentos run|status|narrate|audit`)** — `core/`. It is the operator interface to
  the kernel and has no independent reason to change. A separate `cli/` directory would be
  one file deep.
- **Observability projections (live view, run narrative)** — `core/`. They are pure
  functions of the event log, which the kernel owns. Placing them elsewhere would give a
  second component read access to run internals.

No new directories are required. Nine stands — not because nine is tidy, but because every
component maps to exactly one primary directory and every span above has a stated split.

## 8. Invariants

The guarantees the kernel must hold regardless of agent behaviour.

**What can go wrong between two agents?**
Incompatible assertions; an assumption made by one and violated by another; a stale
Context Package read after the world changed; scope drift. All are detected mechanically:
the kernel cross-checks new assertions against existing ones on envelope receipt, raises a
conflict, and routes it through arbitration. Assumptions are explicit envelope fields
precisely so a later contradiction is traceable to its source rather than mysterious.

**What happens when an agent fails halfway through?**
The dispatch event was written before the agent was invoked, so an incomplete step is
detectable, never invisible. On recovery the kernel finds a dispatch with no matching
envelope and either retries (if the step is declared idempotent) or blocks with a report.
Partial file mutations are recorded in `artifacts_changed` as they happen and are
reversible from the log. A worktree makes the worst case "delete the worktree".

**How is state recovered?**
By replaying `events.ndjson`, never by asking a model what it was doing. `run.json` is a
projection; if it disagrees with the log, the log wins. Recovery is a pure function of the
log.

**How is context passed without uncontrolled growth?**
Four mechanisms. (1) Envelopes carry *references* — `context_package_ref`,
`prior_envelopes` as ids — not inlined text. (2) Discovery is tiered: orientation,
goal-relevant, on-demand. (3) Each agent declares its required inputs, and the kernel
materializes only those. (4) Transcripts are never passed. The Context Package is
structured precisely so an agent can read the three sections it needs instead of all
twenty.

**Who is allowed to authorize irreversible actions?**
Only a human, and only through a grant that names one gate, one target, one run, with an
expiry. Grants are non-transferable and are checked by the adapter at execution time. No
agent may grant, extend, reinterpret or self-certify one. The Orchestrator Agent requests;
it never approves.

**How are capabilities discovered and selected?**
Skills and models: the host adapter enumerates what exists, the registries rank candidates
against declared requirements, the kernel selects and records. Target-system capabilities:
identified from intent, code and runtime independently, then merged — a capability
appearing in only one source is itself a finding.

**How does the system know an agent actually completed its task?**
Not by the agent saying so. Each dispatch carries `required_outputs`; the kernel rejects
`COMPLETE` when any is unfilled, rejects findings without evidence, and rejects assertions
without a confidence class. Beyond that, completion is judged by the DoD against evidence
from a *different* agent than the one that did the work.

**How does the Auditor verify another agent's work?**
It does not verify implementation correctness — that is the Validator's mandate, and
keeping them separate prevents one agent from grading its own reasoning. The Auditor is
re-dispatched after implementation for one specific purpose: **structural re-audit**,
answering DoD criterion 17 — did this change create a new orphan writer, reader, store,
dead calculation, phantom API or phantom UI? That question needs the capability graph,
which only the Auditor builds. Its second pass is scoped to the blast radius of the change,
not the whole system.

**What prevents an agent from bypassing the state machine?**
Structurally, not by convention. An agent has no write access to `state/`, no reference to
the kernel, and no ability to invoke another agent. Its `next_action` is a proposal
validated against the transition table; an illegal proposal is rejected and logged as a
contract violation. Its only outward reach is through adapters, which enforce
authorization independently. An agent that wants to skip validation and deploy has no
mechanism available to it — it can only ask, and be refused.
