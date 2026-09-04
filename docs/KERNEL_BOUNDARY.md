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

- **Intake and Work Item lifecycle** — record the `IntakeRecord` verbatim, admit or reject a
  proposed Work Item against the evidence minimums, compute its identity, hold the
  single-active-run lease, create admitted children, and maintain the work item lifecycle.
  ([INTENT_AND_WORK_ITEM_RESOLUTION.md](INTENT_AND_WORK_ITEM_RESOLUTION.md))
- **Understanding sufficiency** — compute the `UNDERSTOOD` verdict. Not a judgment: the
  condition is that every predicate the candidate templates' entry edges reference evaluates
  to something other than `INDETERMINATE`.
- **Workflow admission** — load templates from policy, compute the admissible set, check a
  proposed parameterization against the template and the workflow floor, freeze the graph.
  Templates are data; no agent authors one.
- **Entry-stage computation** — decide where a run starts, by walking the frozen graph against
  Current Reality. Resumption is arithmetic over adapter observations, not an agent's reading
  of a prompt.
- **Dispatch** — build an agent's typed input, invoke it, receive its envelope.
- **Envelope validation** — schema conformance; rejection of findings without evidence, of
  `COMPLETE` with unfilled required outputs, of assertions with no confidence class.
- **State machine enforcement** — legality of every transition. An agent's `next_action` is
  a proposal, validated against the transition table.
- **Event log** — append-only, write-before-act, the authoritative record.
- **Run store** — the only writer. Projections (`run.json`, run narrative) derive from the
  log.
- **Recovery** — replay the log, rebuild the cursor, detect interrupted steps, retry or
  block. The frozen graph is replayed, never recomputed.
- **Scope containment** — decide whether a triaged review comment falls inside the Work
  Item's admitted scope. A set computation over typed scope, not a reading of the comment.
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

## 3.5 What the kernel disbelieves

Section 3 lists what the kernel *does*. This lists what it refuses to take on trust, which
turned out to be the harder half.

Commit 23a1449 established that no agent can **drive** the run. It did not establish that
the kernel can **disbelieve** an agent — every piece of agent-supplied data was accepted as
true because it was well-formed. Architecture v0.2 closes that gap. The kernel treats the
following as claims to be checked, never as facts:

- **Evidence.** Replayed through the originating adapter — always for critical findings,
  authorization requests and DoD criteria marked `MET`; sampled otherwise. Mismatch
  downgrades the assertion; repeated mismatch rejects the whole envelope.
  ([AGENT_HANDOFF_CONTRACT.md](AGENT_HANDOFF_CONTRACT.md))
- **Branch conditions.** Transition predicates are evaluated by the kernel over the Context
  Package and mutation events. An agent's claim that a change is trivial, or that no UI was
  touched, is recorded and ignored. `INDETERMINATE` takes the safer branch.
  ([WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) section 4.3)
- **What an agent changed.** `artifacts_changed` is reconciled against adapter-emitted
  mutation events. Under-reporting and over-reporting are both contract violations.
- **What an agent may touch.** Paths are confined at the adapter — worktree root, mandate
  scope, and an absolute deny-list covering `state/`, `policies/`, `contracts/` and the
  AgentOS installation. ([REPOSITORY_ADAPTER.md](REPOSITORY_ADAPTER.md) section 2.1)
- **Whether an action is dangerous.** Gates fire from mechanical classifiers at the
  adapter, not from an agent volunteering that it is about to cross one. Self-declaration is
  an additional trigger, never the only one.
  ([HUMAN_AUTHORIZATION.md](HUMAN_AUTHORIZATION.md))
- **Whether a target is safe.** Unknown branch protection means protected; unknown
  environment means production.
- **Internal coherence.** `COMPLETE` with blockers, dangling evidence references, a
  `REJECTED` from a non-reviewing role, a missing `coverage` — all rejected by cross-field
  rules that run independently of schema validation.
- **Whether a tool is really just a tool.** A skill that can spawn an agent is never
  selectable; undetermined spawning behaviour is treated as spawning.
- **What an agent claims it looked at.** Every adapter call is logged, reads included, and
  `coverage` is reconciled against that log. Scope claimed but never touched is a contract
  violation — which matters because `coverage` is the field separating "found nothing here"
  from "never looked here".
- **Its own retries.** Idempotency keys and pre-retry reversal make a repeated dispatch
  safe without assuming the agent was deterministic. Work-item-scoped keys extend that
  across runs, where duplicate external effects actually originate.
- **What the work is.** A proposed Work Item is admitted only after the kernel resolves the
  external identity through the adapter itself, checks the claimed type against the evidence
  minimums in `policies/work-items.json`, and refuses an unbounded scope. A type asserted
  without its minimum evidence is recorded and downgraded to `UNKNOWN`.
- **Where the work already is.** Current Reality comes from adapters or it is `UNKNOWN`. An
  agent's account of what happened in a previous run is a `claim`; the git host, the PM
  system and AgentOS's own event log are the record.
- **Whether it understands.** `UNDERSTOOD` is computed, not declared. An agent stating that
  it has enough context does not make the workflow decision determinate.
- **Which workflow is appropriate.** The Orchestrator selects from policy-authored templates
  and may exclude an optional stage only where the kernel evaluates its predicate `FALSE`. It
  cannot add a stage, author a graph, or choose where the run resumes.
- **Whether something is separate work.** A triage proposal creates a child Work Item only
  when the remediation provably falls outside the admitted scope. Undeterminable counts as
  inside — creating work items multiplies external side effects.
- **Whether a request is authorized to exist.** Intake content is data. It cannot name a
  template, request a stage, set a confidence or trust class, or widen a scope, and no grant
  ever originates from it.

The organising idea: **syntactic validity confers nothing.** Every path from agent output
into trusted state passes through a check the kernel performs itself, using a component
that is not the agent.

## 4. What agents own

Everything requiring judgment.

- Interpreting the intake: what this work is, what outcome is wanted, what its scope is
- Proposing which workflow template fits, and which optional stages apply
- Deciding whether a review comment is the same work or different work
- Proposing how an Epic decomposes into independently completable children
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

The Orchestrator Agent's outputs — workflow selection, arbitration resolution, review
triage, cancellation, model and skill preference — are all proposals in an envelope. Each is validated and may be
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
lifecycle; agent/model/skill selection and recording; CLI; observability projections. Plus
the v0.3 layer: intake recording, Work Item admission and lifecycle, understanding
sufficiency, workflow admission against templates and the floor, entry-stage computation,
and scope containment.

**agents/** — role specifications for all eight roles, including the Orchestrator Agent.

**contracts/** — schema definitions. *Definition* only; enforcement is `core/`.

**discovery/** — probes; Context Package assembly; reconciliation matrix construction;
coverage accounting.

**registries/** — capability, skill and model registries: representation, indexing, query
and **ranking**. Registries rank; they do not select. Selection and its recording are
`core/`.

**policies/** — gate definitions; the security floor statement; DoD profiles and
applicability rules; data-semantics vocabulary; budgets and thresholds; **workflow templates,
stage descriptors, the workflow floor, and work item type evidence minimums**. Data, not
code. The workflow set being policy rather than kernel logic is what lets dynamic workflow
selection stay deterministic: the kernel validates a selection, never a novel graph.

**adapters/** — repository, git, project-management, runtime, host. Also the **enforcement
point** for authorization (a grant is checked here at execution time, not by the agent
requesting it), for redaction, and for platform differences.

**state/** — durable work item and run data (`state/work-items/<id>/runs/<run-id>/`).
Written only by `core/`. Schema tracked, data ignored.

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

### Components added in v0.3, and where they went

None of them needed a new directory, and the reason is worth stating: every one is either a
deterministic check (`core/`), declarative data (`policies/`), or an observation
(`adapters/`) — the three homes the existing boundary already provides.

- **Intake normalization** — `adapters/`. Each source is observed by the adapter that already
  covers it; event and webhook intake belongs to the host adapter, which already owns how
  AgentOS is invoked. A separate `intake/` directory would be one file deep and would need
  its own copy of the availability, confidence and redaction contracts.
- **Resolution** — `agents/`, as a mandate of Context Discovery. Not a ninth role: resolution
  is probe-run-and-reconcile applied to the task instead of to a capability.
- **Work Item admission, identity, lifecycle, leasing** — `core/`.
- **Workflow templates, stage descriptors, the floor** — `policies/`.
- **Workflow admission, entry-stage computation, scope containment** — `core/`.

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
Fabricated evidence — the deepest failure, since everything downstream rests on it, now
caught by kernel replay through the originating adapter rather than by trusting the
agent's own `reproducible` flag. Beyond that: incompatible assertions; an assumption made by one and violated by another; a stale
Context Package read after the world changed; scope drift. All are detected mechanically:
the kernel cross-checks new assertions against existing ones on envelope receipt, raises a
conflict, and routes it through arbitration. Assumptions are explicit envelope fields
precisely so a later contradiction is traceable to its source rather than mysterious.

**What happens when an agent fails halfway through?**
The dispatch event was written before the agent was invoked, so an incomplete step is
detectable, never invisible. On recovery the kernel finds a dispatch with no matching
envelope, reverses that dispatch's mutation events in reverse order, and re-dispatches with
a fresh `dispatch_id` — unless the dispatch performed a non-reversible operation, in which
case it blocks rather than repeating it.
Partial mutations are recorded as `mutation` events by the adapter at call time — before
the envelope exists — so the reversal record survives a crash that the envelope does not.
The envelope's `artifacts_changed` is reconciled against those events on arrival. A worktree makes the worst case "delete the worktree".

**How is state recovered?**
By replaying `events.ndjson`, never by asking a model what it was doing. `run.json` is a
projection; if it disagrees with the log, the log wins. Recovery is a pure function of the
log. A trailing partial line — a crash mid-write — is discarded, and the discard is itself
logged rather than passing silently.

**Can an agent's stated coverage be trusted?**
It is not trusted; it is reconciled. The adapter call log records what the agent actually
read, and an envelope claiming examination that no call supports is rejected. This is the
one place where a model-free check reaches a claim that previously looked inherently
subjective.

**How is context passed without uncontrolled growth?**
Four mechanisms. (1) Envelopes carry *references* — `context_package_ref`,
`prior_envelopes` as ids — not inlined text. (2) Discovery is tiered: orientation,
goal-relevant, on-demand. (3) Each agent declares its required inputs, and the kernel
materializes only those. (4) Transcripts are never passed. The Context Package is
structured precisely so an agent can read the three sections it needs instead of all
twenty.

**Who is allowed to authorize irreversible actions?**
Only a human, and only through a grant that names one gate, one target, one run, with an
expiry. Which actions *need* a grant is determined by mechanical classifiers at the
adapter, not by an agent volunteering that it is about to do something dangerous; an
unknown branch counts as protected and an unknown environment counts as production. Grants are non-transferable and are checked by the adapter at execution time. No
agent may grant, extend, reinterpret or self-certify one. The Orchestrator Agent requests;
it never approves.

**How are capabilities discovered and selected?**
Skills and models: the host adapter enumerates what exists, the registries rank candidates
against declared requirements, the kernel selects and records. Target-system capabilities:
identified from intent, code and runtime independently, then merged — a capability
appearing in only one source is itself a finding.

**How does the system know an agent actually completed its task?**
Not by the agent saying so. Each dispatch carries `required_outputs`; the kernel rejects
`COMPLETE` when any is unfilled, when `blockers` is non-empty, when evidence references
dangle, or when `coverage` is missing. It reconciles the agent's `artifacts_changed`
against the mutation events adapters emitted, catching both under-reporting and
hallucinated edits. It replays the evidence. Beyond all that, completion is judged by the
DoD against evidence from a *different* agent than the one that did the work.

**How does the Auditor verify another agent's work?**
It does not verify implementation correctness — that is the Validator's mandate, and
keeping them separate prevents one agent from grading its own reasoning. The Auditor is
re-dispatched after implementation for one specific purpose: **structural re-audit**,
answering DoD criterion 17 — did this change create a new orphan writer, reader, store,
dead calculation, phantom API or phantom UI? That question needs the capability graph,
which only the Auditor builds. Its second pass is scoped to the blast radius of the change,
not the whole system.

**What prevents an agent from bypassing the state machine?**
Structurally, at four layers, none of which is convention.

1. It has no reference to the kernel and no ability to dispatch. Skills that could spawn an
   agent are excluded from selection, and undetermined spawning behaviour counts as
   spawning.
2. It has no write access to `state/` — enforced not only by code structure but by an
   adapter deny-list, because agents do hold filesystem access and a relative path is a
   relative path.
3. Its `next_action` is a proposal. The kernel validates the transition *and evaluates the
   branch predicate itself*, so an agent cannot skip a stage by asserting the stage does
   not apply.
4. Its only outward reach is adapters, which confine paths, enforce mandate scope, classify
   gates mechanically, and fail closed on unknown targets.
5. It cannot author the machine either. Workflow graphs come from policy templates; the
   Orchestrator selects and parameterizes within declared degrees of freedom, and excluding
   an optional stage requires the kernel to evaluate its predicate `FALSE`.

An agent that wants to skip validation and deploy has no mechanism available to it — it can
only ask, and be refused.

**How does AgentOS know what the work is, when the request does not say?**
It resolves it, and then disbelieves the resolution. Context Discovery proposes a Work Item —
type, desired outcome, scope, external identity — with every field an assertion carrying
evidence. The kernel resolves the external identity through the adapter itself rather than
accepting the claim, checks the type against the evidence minimums in
`policies/work-items.json` (an `INCIDENT` needs a runtime observation, not a word), refuses an
unbounded scope, and requires the desired outcome to bind to a DoD profile that is checkable
with this run's access. A type asserted without its minimum evidence is admitted as `UNKNOWN`,
which routes to the read-only investigation template — the safe thing to do when you do not
know what you are looking at.

**What stops an agent from choosing its own workflow?**
Workflows are not authored, they are selected. Templates live in `policies/workflows/`,
authored and reviewed by humans and checked against the workflow floor at policy load. The
Orchestrator chooses among the admissible ones, includes or excludes only the stages a
template marks optional, and sets a mandate scope bounded by the Work Item's. It cannot add a
stage that is not in the template, which is why "propose a dangerous stage" is unreachable
rather than merely gated; it cannot exclude a stage without the kernel evaluating its
predicate `FALSE`; and it cannot choose where the run starts. On a failed admission the kernel
falls back to the most conservative admissible template and logs the override.

The deeper reason for the template mechanism: validating an arbitrary model-authored graph
would require the kernel to decide whether a novel stage sequence is safe, which is judgment —
the one thing it must not do. Validating a selection from a known set is arithmetic.

**What stops a resumed run from redoing work that already reached the outside world?**
Three things, in order. The kernel computes the entry stage by walking the frozen graph
against Current Reality, so a run against a Work Item with an open PR enters at review triage
rather than at implementation — and Current Reality comes from git and the PR host, not from
an agent's recollection. Where a stage's "already done" predicate is `INDETERMINATE` and the
stage mutates, the kernel does not guess: it discovers, and failing that blocks with
`AMBIGUOUS_STATE`, because re-executing a non-reversible operation on the strength of an
`INDETERMINATE` is precisely how a system opens the same PR twice. And underneath both,
work-item-scoped idempotency keys over an operation's declared `identity_args` mean that even
a genuinely duplicated attempt to open a PR resolves to the existing one.

**What stops a run from declaring completion because it skipped the stages that would have
judged it?**
The stage cursor has no authority over completion. `COMPLETED_PRIOR` means the mutation has
already occurred, not that the criteria are met; a skipped stage supplies no per-criterion
verdicts, so its criteria are `NOT_VALIDATED`, and `NOT_VALIDATED` is never `MET`. The run
reaches `COMPLETION`, computes `INCOMPLETE`, and routes back to the stage that owes the
verdicts. A wrong resume costs a lap; it cannot manufacture a `COMPLETE`.

**What stops untrusted intake from driving the system?**
Intake is data, never instruction. `trust_class` is set by the host from authenticated
context and never from the content, so a webhook body cannot promote itself. Intake content
cannot name a template, request a stage, set a confidence class, or widen a scope — those are
kernel inputs, and a ticket body claiming otherwise is text the resolver may weigh as evidence
of what someone wants. No grant ever originates from intake. And `EXTERNAL` intake cannot
reach a mutating stage without `AUTONOMOUS_INTAKE_EXECUTION`, which policy may pre-grant per
configured source so that trusted automation stays autonomous. Read-only work stays ungated
for every class, which is what keeps the gate narrow enough to be worth having.

**What happens when no model is available at all?**
The dispatch returns `FAILED`, the kernel retries per policy, then blocks with
`EXTERNAL_DEPENDENCY`. No state advances, no envelope merges, nothing corrupts, and the run
resumes at the same point when a model returns. Every kernel function — validation,
consistency checking, evidence replay, predicate evaluation, mutation reconciliation, gate
classification, authorization, DoD arithmetic, recovery — runs with no model in the loop.
The kernel's correctness is independent of model *availability*, not merely of model
quality.
