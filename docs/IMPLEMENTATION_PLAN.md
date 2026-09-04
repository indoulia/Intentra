# Implementation Plan

The executable version of [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md), written
against the frozen [Architecture v0.3](ARCHITECTURE_FREEZE.md). The roadmap says why the
order is what it is; this says what gets built, in what order, and how each piece is proven.

One milestone ships: **a read-only AgentOS that discovers and audits and mutates nothing.**
Everything else is sketched deliberately at low resolution, because the pilot at the end of
milestone 1 should inform it and a detailed plan written now would be fiction.

## 1. The shape of the plan

**Contracts first, in the strict sense.** WP-1 gates every other work package. Not as a
matter of tidiness — the six-then-eight minimum contract set exists because every other
component references those shapes, and building against a guess means rewriting everything
built on the guess (IMPLEMENTATION_ROADMAP 3.5).

**Then a kernel with no model in it.** WP-2 and WP-3 produce a kernel that replays recorded
envelopes: it admits work items, selects workflows, computes entry stages, enforces
transitions, verifies envelopes, accounts budgets, does DoD arithmetic and recovers from
crashes — against fixtures, with no repository and no model anywhere near it. This is the
single highest-value increment in the plan, because every safety property in the design is a
property of this layer and all of them are testable without an agent.

**Then reach, then judgment, then value.** Adapters (WP-4) before dispatch (WP-5) before
discovery (WP-6) before audit (WP-7), because each is the input to the next and because the
adapters are where the kernel's disbelief machinery actually touches the world.

**Then the pilot** (WP-8), which is where AgentOS either earns trust or does not.

Three checkpoints, each independently demonstrable:

- **C1 — the kernel replays envelopes.** WP-1 + WP-2 + WP-3. No model, no repository.
- **C2 — an honest Context Package.** + WP-4 + WP-5 + WP-6. First run against a real repository.
- **C3 — the read-only MVP.** + WP-7 + WP-8. Pilot scored, pass criteria met.

## 2. What "contracts-first" means concretely

**JSON Schema (2020-12) in `contracts/schema/` is the source of truth. TypeScript types are
generated from it.** Generated types are committed so that consumers need no build step to
read them, and they are never hand-edited — a hand-edit is the moment the schema and the type
begin to disagree, and the disagreement surfaces later as an optional field one side thinks is
required. Validators are compiled from the same schemas, so there is exactly one definition of
every shape in the system.

**Fixtures are the specification's test suite, and they are part of WP-1, not of a later
testing phase.** Two kinds:

- **One valid fixture per control-flow-bearing enum value.** Every envelope status, every
  blocker kind, every evidence kind, every verification status, every confidence class, every
  freshness value, every absence value, every reconciliation state, every capability status,
  every chain stage, every work item type and lifecycle state, every intake source, every
  stage, every edge kind, every risk class, every DoD verdict and completion verdict, every
  gate, every `needs` value. An enum value with no fixture is an enum value nothing has ever
  exercised.
- **One invalid fixture per cross-field rule.** Each of the rules in
  [AGENT_HANDOFF_CONTRACT.md](AGENT_HANDOFF_CONTRACT.md) "Cross-field consistency rules" gets
  a fixture that violates exactly it, so that WP-3's checks can be proven to reject the thing
  they exist to reject rather than to pass everything.

**The expressiveness test.** Every worked JSON example in the fourteen frozen documents must
validate against the schemas: the envelope, the input package, the evidence and finding and
blocker and unknown examples, the `proposals` block, the `IntakeRecord`, the proposed Work
Item, the `defect.standard` template, the mutation event. A doc example that will not validate
means the document and the schema disagree, and per the freeze that is a **documentation
defect** resolved by amendment before code is written against either.

**What is not schema.** Schema conformance is not consistency, and the plan keeps them apart
because the design does: cross-field rules, evidence verification, coverage reconciliation,
`artifacts_changed` reconciliation and predicate evaluation are kernel checks in WP-3 and WP-4,
with their own fixtures. A schema that tried to express them would be a schema nobody can read
and a rule nobody can locate.

**`contracts/` depends on nothing**, and this is enforced by its package manifest having no
dependencies rather than by anyone remembering.

## 3. Layout and mechanical enforcement

The nine directories stand unchanged. Each becomes an npm workspace package, which turns the
dependency rule from a convention into a fact a manifest states:

```
contracts/    @agentos/contracts     deps: none
policies/     @agentos/policies      deps: contracts
registries/   @agentos/registries    deps: contracts
adapters/     @agentos/adapters      deps: contracts, policies
discovery/    @agentos/discovery     deps: contracts, adapters
agents/       @agentos/agents        deps: contracts, policies, registries, adapters
core/         @agentos/core          deps: contracts, policies, registries, adapters, state
state/        @agentos/state         deps: contracts
tools/        build-time only: schema codegen, fixture runner, boundary checks
```

`@agentos/agents` cannot import `@agentos/core` because it does not declare it. Three checks
back that up in CI:

- **`dependency-cruiser`** for the forbidden-edge rules, including the ones a manifest cannot
  express: `contracts -> anything`, and `core -> agents` other than through the dispatch
  interface.
- **The delete-core test.** `rm -rf core && tsc -b agents` must succeed. This is the
  design's own stated test for the boundary, and it is worth running rather than quoting.
- **The generated-types check.** Regenerate from schema; a diff means someone hand-edited a
  type.

Test layers, in the order they run: schema and fixture validation (no I/O), kernel unit and
property tests over fixtures (no I/O), adapter tests against a scratch repository, the
invariant suite (section 5), then the live runs.

## 4. Milestone 1 — the read-only MVP

```
agentos work --repo <path> "<anything>"
```

Accepts any intake source and resolves it. Every admissible template for it is read-only —
`investigation.readonly` and the audit path — because nothing mutates yet. That is the point
rather than a limitation: **the whole resolution and workflow-selection layer can be exercised
and judged before AgentOS can write anything.** Whether it correctly identifies what a request
is, and where that work already stands, is testable at zero risk to any repository.

Produces: a Context Package with honest confidence classification; a capability registry and
graph; an evidence-backed findings report; an explicit coverage and unknowns statement; a
resumable run record. Mutates nothing.

**Out of scope, explicitly:** implementation, validation beyond static analysis, UX review,
authorization gates (nothing is gated when nothing mutates), deployment, parallelism, parallel
child work items.

Every work package below is `READY` or `NEEDS CONTRACT`. Nothing is `BLOCKED`.

---

### WP-1 — The contract set · READY · L

**Goal.** Every shape in the system, defined once, with the fixtures that prove each is
expressive enough for the design that uses it.

**Build order.** As IMPLEMENTATION_ROADMAP 3.5, with one refinement: `Finding` and `Blocker`
move ahead of `HandoffEnvelope` rather than trailing it, because the envelope embeds both and
cannot validate its own worked example without them. The roadmap's ordering is not wrong about
their cost, only about their position, and this is exactly the kind of thing the expressiveness
test is for.

1. `Assertion` — value, `FACT | INFERENCE | UNKNOWN`, evidence, `derived_from`, `reason`,
   `recoverable_by`, `observed_at`, `probe`, freshness. Every leaf value in the system is one.
2. `Evidence` — the ten kinds, the mandatory re-executable `locator`, `ref`, `excerpt`,
   `observed_at`, `reproducible`, and the **kernel-owned** `verification` block, which must be
   rejected when present on arrival.
3. `Finding`, `Blocker` — severity and category; the ten blocker kinds and the seven `needs`
   values.
4. `HandoffEnvelope` — including `proposals`, `coverage`, `next_action`. Its status enum and
   the state machine are defined together, because separated they drift.
5. `ContextPackage` — the twenty-three sections, with `current_reality` and `gaps` first-class.
   Section names are the vocabulary of `required_inputs`, so they are load-bearing identifiers
   and not documentation.
6. `CapabilityRecord` — record, chain stage records, the eight statuses, the nine chain stages.
7. `AuthorizationRequest` / `Grant` — before any mutating adapter exists, per section 6.
8. `IntakeRecord`, `WorkItem` — identity, the nine types, the lifecycle, scope, the lease.
9. `WorkflowTemplate`, `StageDescriptor` — the machine is data-driven, so its data has a shape
   before the machine does. `StageDescriptor.mutating` is read by the safe-prefix computation,
   the resume rule and a gate.
10. `DoDProfile`, `AdapterOperationDescriptor`, `MutationEvent` — the last two are what make
    adapters enforceable rather than conventional.

**Exit test.** Every worked example in the fourteen frozen documents validates. Every
control-flow-bearing enum value has a valid fixture. Every cross-field rule has an invalid
fixture. `@agentos/contracts` has zero dependencies. Generated types match their schemas.

**Must not.** Contain a kernel type, a default that invents a value, or a field an agent may
write that the kernel is supposed to own.

---

### WP-2 — Policy data and the loader · READY · M

**Goal.** Every behaviour the design calls "policy" exists as data, and a mis-authored policy
fails loudly at startup rather than quietly during a run.

**Deliverables.** `stages.json` (all stages with the seven descriptor fields; the read-only set
exactly as WORKFLOW_STATE_MACHINE 2.3 names it); `workflows/*.json` (all nine templates);
`workflow-floor.json` (the nine floor rules, including `regression.suspected` keyed on reality
rather than on type); `predicates.json` (four applicability predicates, ten reality
predicates); `work-items.json` (per-type minimum evidence class); `intake.json` (trust
classification per source, per D-5); `evidence.json` (always-verify classes, sample rate,
mismatch thresholds, the per-kind comparators); `budgets.json` (loop caps, cost ceilings,
freshness windows, `reresolution`, `decomposition`, `lease_timeout`, per run **and** per work
item); `paths.json` (the absolute deny-list); `gates.json` (defined, and inert in the MVP);
`dod/*.json` (the seven profiles and their applicability rules); `security-floor.md`.

**The loader.** Validates every template against the floor at load, plus referential integrity
over the whole policy set — which is cheap, model-free, and catches the authoring errors that
would otherwise surface mid-run:

- every stage named by any template exists in `stages.json`
- every predicate named by any edge or `satisfied_by` exists in `predicates.json`
- every loop edge names a counter bound to a key present in `budgets.json`
- every template's graph is well-formed: endpoints included, every stage reachable from the
  entry, `COMPLETION` reachable, `COMPLETION` the sole predecessor of `COMPLETE`
- every DoD criterion named by a stage exists in a profile, and every criterion has exactly one
  owning role

**Exit test.** All nine templates load and pass the floor. A deliberately floor-violating
template — `MERGE` with no `VALIDATION` before it — fails policy load with a message naming the
rule and the template. A template naming a nonexistent predicate fails load. `investigation.readonly`
is admissible for every work item type, so the admissible set is never empty.

**Must not.** Contain code, a prompt, a threshold expressed anywhere but here, or a template
whose stage set was chosen to make a test pass.

---

### WP-3 — The kernel as an envelope replayer · READY · L

**Goal.** Everything the kernel owns, running against recorded fixture envelopes with no model
and no repository. This is the recommended first increment and the checkpoint that matters
most: if this layer is right, a confused or adversarial agent can degrade a run's quality and
cannot corrupt its state.

**Deliverables.**

- **Stores.** Work item and run store at `state/work-items/<id>/runs/<run-id>/`, append-only
  `events.ndjson` at both levels, one newline-terminated flushed line per event, write-before-act
  for dispatch intent, `run.json` and `work-item.json` as projections rebuildable from their
  logs. A trailing partial line is discarded on recovery and the discard is itself logged.
- **The lease.** Atomic acquisition — exclusive create or create-and-rename, never
  read-then-write — plus `lease_timeout` reclamation logged with the abandoned run id.
- **Work item admission.** The six checks of INTENT_AND_WORK_ITEM_RESOLUTION 3.4, identity
  derivation (external key, else content-derived per D-4), the similarity check, duplicate
  candidates surfaced and never auto-merged.
- **`UNDERSTOOD`.** The five kernel-computable conditions, reporting which predicate is
  undetermined when it fails — the failure is actionable by construction and should say so.
- **Workflow admission.** The six run-start checks, the frozen graph, risk class derivation,
  fallback to the most conservative admissible template with the override logged.
- **Entry-stage computation.** The topological walk against Current Reality, `COMPLETED_PRIOR`
  marking with its reality evidence, and the refined safer-branch rule including
  `AMBIGUOUS_STATE`.
- **Envelope receipt.** The eight steps in order, later steps not running when an earlier one
  rejects. Steps 2–5 are the disbelief machinery and get the invalid fixtures from WP-1.
- **The state machine.** Transition legality over the frozen graph, the envelope-status-to-action
  mapping as an exhaustive discriminated switch, `next_action` as a proposal with the kernel
  evaluating the predicate itself and logging both the claim and the evaluated value.
- **Budgets and loops.** The four loops with their caps, per run and per work item; exceeding is
  `BLOCKED` with a report stating what was tried and what a human must decide.
- **DoD arithmetic.** Per-criterion verdicts collected, applicability checked against the
  profile, the four completion verdicts, and `NOT_VALIDATED` never counted as `MET`.
- **Re-resolution.** `WORK_ITEM_MISCLASSIFIED` ends the run `RERESOLVED` and starts a new run
  against the same work item, capped at one.
- **Recovery.** Replay the log, rebuild the cursor, detect an interrupted dispatch, reverse its
  mutation events in reverse order, re-dispatch with a fresh `dispatch_id`; block instead where
  the dispatch performed a `reversal: null` operation.
- **Source drift.** At `COMPLETION`, re-execute the intake locator and compare content hashes;
  changed means disclosed with the diff, not chased.
- **Conflict detection and arbitration's kernel half.** Mechanical incompatibility detection and
  the confidence-class rule; escalation for what remains.
- **CLI and projections.** `agentos work`, `agentos status`, `agentos narrate`, and
  `agentos replay <fixture-dir>` which drives the whole kernel from recorded envelopes. **The
  narrative must state what AgentOS decided the work was and why** — this is not a later
  nicety, it is the mitigation for v0.3's stated residual risk, and a run that did the wrong
  thing correctly is invisible without it.

**Exit tests.** The roadmap's three, plus two:

1. Start a run, kill the process mid-dispatch, restart; it resumes correctly from the log, not
   from memory and not by starting over.
2. Run twice against the same fixture work item where the first run reached a simulated open
   PR. The second enters at `REVIEW_TRIAGE`, does not re-enter `IMPLEMENTATION`, and issues no
   second `create_pr`.
3. The same fixture with the PR deleted between runs, then a variant with the PR host
   unreachable. The first invalidates the idempotency record and proceeds; the second blocks
   with `AMBIGUOUS_STATE` and does nothing. **A design that passes test 2 and fails test 3 has
   built a cache and called it idempotency.**
4. Two processes start a run against one work item at the same instant; exactly one wins and
   the other is refused with the active run named.
5. Property test: recovery is a pure function of the log. Replay any prefix of any fixture log
   twice and get identical projections.

**Must not.** Dispatch an agent, read a target repository, import an agent module, or contain a
threshold that is not read from `policies/`.

---

### WP-4 — Adapter framework and the read-only adapters · READY · L

**Goal.** The only path between agents and the world, built as an enforcement layer. Every
check the kernel performs on an agent's claims is performed *through* here, which makes this
the system's single point of trust and the reason it is one place.

**Deliverables.**

- **Descriptor registry.** Every operation declares `mutating`, `reversal`,
  `idempotent_by_key`, `external_destination`, `observation_safe` and `incidental_artifacts`.
  Fail-closed defaults throughout: an operation whose observation safety cannot be established
  is `observation_safe: false`.
- **Path confinement.** Resolve, expand, normalize, collapse `..`, follow symlinks to a real
  path; then worktree root, then `mandate.in_scope` / `out_of_scope`, then the absolute
  deny-list — checked even for paths that pass the first two. Symlink *targets* are checked, not
  just link paths. A refusal is a `scope_violation` or a `security_violation`, and a security
  violation aborts the dispatch and is reported regardless of the run's outcome.
- **Fail-closed classification.** Unknown branch protection means protected; unknown environment
  means production; no topology discovered means every reachable runtime is production. The
  classification and its confidence are recorded on every gated operation, so a run that was
  conservative because it was blind is distinguishable from one that was conservative because
  the target really was production.
- **The call log.** Every call logged, reads included, at policy-defined granularity.
  Aggregation permitted, omission not. This is what makes `coverage` checkable.
- **Mutation events and idempotency.** Both frameworks built now, with **no mutating operation
  registered** (section 6). Emitted at call time before returning; an adapter that cannot emit
  a mutation event must refuse the mutation. Two key scopes, with a work-item-scoped key hit
  **verified rather than trusted**: present returns the record, absent invalidates it,
  unreachable is `AMBIGUOUS_STATE`.
- **Grant checking.** At execution time, in the adapter, never by the agent that requested it.
  Built now, exercised by fixtures, gating nothing because nothing mutates.
- **Evidence replay.** The kernel-driven replay service, restricted to `observation_safe`
  operations, with the per-kind comparators from `evidence.json`: normalized exact match for
  `file`/`git`/`query`/`command`/`http`; predicate re-evaluation for `log`/`metric`; identifier
  plus content hash for `ticket`/`document`; `screenshot` not kernel-verifiable, provenance
  confirmed from the call log instead.
- **Redaction.** Secrets referenced by name and location, never captured.
- **The read-only adapters.** Repository (the eight-step attachment sequence, every output an
  assertion); git (branches, commits, worktrees, PRs, review threads, CI state — which every
  resume decision depends on); host (skill, tool and model enumeration; CLI intake; `principal`
  and `trust_class` per D-5; platform differences); project management, read-only; runtime,
  read-only and optional.

**Exit tests.** A `../` escape, a symlink pointing out of the worktree, and a write under
`state/` are each refused and logged with the correct event kind. Branch protection and
environment classification each fail closed when their probe fails, with the confidence
recorded. A fixture envelope claiming coverage of a subsystem no call touched is rejected. Each
evidence comparator behaves as specified, including the screenshot case. The degradation matrix
runs: with no PM access, no runtime access, and no CI, the package is honest about each and the
strength of claims drops accordingly.

**Must not.** Register a mutating operation. Expose an operation without a descriptor. Perform a
mutation it cannot log.

---

### WP-5 — Dispatch and the three MVP roles · READY · M

**Goal.** The one interface between the kernel and a model, and the three roles the read-only
MVP needs.

**Deliverables.**

- **The dispatch boundary.** Build the typed input package, materializing **only** the
  `required_inputs` sections; invoke one fresh session per dispatch; receive an envelope. Kept
  narrow enough that changing substrate is a one-file change, per D-2's reversal clause.
- **The tool surface conformance check.** Per D-2's binding condition: the effective tool set
  equals the adapter operations the kernel exposed, no built-in file/shell/search/web tools, no
  subagent or spawning tool. Asserted at startup, failing loudly before any dispatch. Read the
  configuration surface from the Agent SDK documentation when building this; do not assume
  option names.
- **Envelope ingestion.** A malformed envelope is a `FAILED` dispatch, never a parse-and-repair.
  The kernel does not guess what an agent meant.
- **Model and skill selection.** Registries rank, kernel selects and records. `claude-opus-5`
  for resolution and audit — the highest-precision dispatches in the system; cheaper models are
  a measured optimization later, not an opening assumption.
- **Role specifications**, as specs and not prompts: **Context Discovery** with both mandates
  (`resolution` on tier-1 orientation, `context` after admission), **Auditor** first pass, and
  the **Orchestrator Agent**, whose adapters are none and whose choices are exactly three.

**Exit tests.**

1. **The nine worked scenarios.** INTENT_AND_WORK_ITEM_RESOLUTION section 12, A through I. Each
   must produce the documented resolution or block for the documented reason — including H
   (work already complete resolves to a `COMPLETION`-only parameterization, not a
   re-implementation), G (partially completed Epic), and I (ambiguity reaching rung 4 asks one
   question naming both readings). This is the tightest test in the plan because the residual
   risk in the freeze lives here.
2. **Fabricated evidence.** A dispatch whose envelope carries evidence with a locator that
   replays to something else: the assertion is downgraded, the finding demotes to a
   `hypothesis` recommendation, an `evidence_integrity` event is logged; a second mismatch in
   the same envelope rejects the whole envelope and fails the dispatch.
3. **No model available.** Dispatch returns `FAILED`, the kernel retries per policy, escalates
   the model once, then blocks with `EXTERNAL_DEPENDENCY`. No state advances, nothing merges,
   and the run resumes at the same point when a model returns.

**Must not.** Pass a transcript, reuse a session across dispatches, inline the Context Package
into a prompt, or let `advisory_notes` reach an adapter.

---

### WP-6 — Discovery · NEEDS CONTRACT (`ContextPackage`, `Assertion`) · L

**Goal.** The riskiest assumption in AgentOS, tested: that automated discovery can produce a
Context Package good enough to reason from.

**Deliverables.** The repository and git probe sets; the project-management and runtime probes
where access exists; agent and model capability probes including servers configured but
unreachable, which are `UNAVAILABLE` and never "absent". Tiered execution: tier 1 before
resolution, tier 2 against the admitted scope, tier 3 on demand as a recorded event. The
`current_reality` set — all ten elements, written **only** by probes. Confidence classification
with `UNKNOWN` never silently becoming `FACT`. The reconciliation matrix, all eight states, at
capability level and at work-item level. Freshness with per-class windows, and re-probing at
predicate evaluation rather than reading a snapshot. Coverage accounting and `gaps` as a
first-class section. Package versioning rather than appending.

**Exit tests.** Discovery against three genuinely different repositories, with a human who
knows each confirming the package is accurate, that its `UNKNOWN`s are honest, and that nothing
was inferred as fact — **discovery that quietly guesses is worse than discovery that reports
gaps.** Plus an assertion-level audit: sample from every section, and every `FACT` must replay
through its locator. Plus a freshness test: a predicate over a `STALE` element re-probes before
evaluating and never decides on the stale value.

**Must not.** Fill a gap with a plausible value. Derive any part of `current_reality` from the
intake text, a ticket's status field, or an agent's account of a previous run.

---

### WP-7 — Audit · NEEDS CONTRACT (`CapabilityRecord`, `Finding`) · L

**Goal.** The MVP's headline output: where this system lies, with evidence.

**Deliverables.** Capability identification from intent, code and runtime independently, then
merged — a capability appearing in only one source is itself a finding, and which source tells
you what kind. A single-run registry (carry-forward deferred; see the freeze's open decisions).
The capability graph, with edge confidence honest: structural edges are `INFERENCE`,
runtime-confirmed edges are `FACT`. The ten structural detectors: orphan writer, orphan reader,
orphan store, dead calculation, broken chain, phantom API, phantom UI, duplicate ownership,
field loss, provenance break. Data-semantics analysis: fabricated defaults, collapsed absence,
missing provenance and timestamps. Test-quality analysis: what tests actually assert on, real
integrations versus mocks. The findings report, evidence-backed, with coverage stated. The
`audit` DoD profile evaluated at `COMPLETION`.

**The D-6 spike, first.** Measure structural edge derivation against hand-verified ground truth
before committing to depth: recall and precision of edges, and cost. The plan is arranged so a
disappointing result costs the graph and not the milestone — data-semantics analysis,
test-quality analysis and the reconciliation matrix are pattern-based, independent of the
graph, and ship either way. Record the result as an amendment to the freeze.

**Exit test.** WP-8.

**Must not.** Report a finding without evidence — an unproven suspicion is a `recommendation`
of category `hypothesis` carrying the observation that would confirm it. Verify implementation
correctness; that is the Validator's mandate and keeping them apart is what stops one agent
grading its own reasoning.

---

### WP-8 — The pilot, then generalize · READY · M

**Goal.** Find out whether any of this works, against ground truth established independently.

Protocol, scoring and pass criteria are IMPLEMENTATION_ROADMAP section 12 and are not restated
here. Three points bear repeating because they are the ones under pressure when results
arrive:

- **Ground truth is frozen and sealed before AgentOS runs.** Writing it down afterwards is not
  a test.
- **Zero confidence violations is non-negotiable.** A single `UNKNOWN` presented as `FACT`
  fails the pilot regardless of every other score, because a system that confidently invents
  findings is worse than no system.
- **Novel findings are worth more than recall.** Real problems the humans missed are the
  strongest available signal.

Then repeat against two further repositories whose ground truth is also known in advance. **A
system that only works on one repository is a tool for that repository, and this is not one.** A
repository-shaped assumption discovered in the kernel during the pilot is a defect to be
removed before milestone 2.

---

### Sequencing

WP-1 gates everything. WP-2 can start as soon as `Assertion` and `Evidence` exist, and runs
alongside the rest of WP-1. WP-3 and WP-4 both need WP-1 and can be built in parallel by
different people — they meet at evidence replay and the call log, which are the two interfaces
to agree on first. WP-5 needs WP-3 and WP-4. WP-6 needs WP-5. WP-7 needs WP-6. WP-8 is last and
is not begun until the ground truth is sealed.

The critical path is WP-1 → WP-3 → WP-5 → WP-6 → WP-7 → WP-8. WP-2 and WP-4 are parallel
capacity, not path length.

## 5. The invariant suite

The tests that make the freeze mean something. Each maps to a stated invariant, most need only
fixtures, and they run in CI from C1 onward. A change that breaks one of these is a change to
the architecture, not a change to the code.

1. **Boundary.** `rm -rf core && tsc -b agents` succeeds.
2. **State isolation.** An agent-initiated write under `state/`, `policies/` or `contracts/` is
   refused by the deny-list even when the path resolves inside the worktree.
3. **Kernel-owned fields.** An envelope arriving with `verification` populated is a contract
   violation, handled as `BLOCKED`.
4. **`COMPLETE` discipline.** `COMPLETE` with non-empty `blockers`, or with an unfilled
   `required_output`, or with `coverage` missing, is rejected.
5. **Dangling references.** A finding citing an evidence id absent from `evidence[]` is
   rejected, not ignored.
6. **Coverage.** An envelope claiming examined scope that no adapter call touched is a contract
   violation.
7. **Mutation reconciliation.** Under-reported and over-reported `artifacts_changed` are both
   rejected — the second catches a hallucinated edit, which is worth catching precisely because
   the code looks fine and the change is absent.
8. **Two strikes.** Two evidence mismatches in one envelope reject the whole envelope and fail
   the dispatch. One fabrication is a defect; two is an untrustworthy witness.
9. **Stage exclusion.** An `exclude_optional` whose predicate the kernel evaluates `TRUE` or
   `INDETERMINATE` keeps the stage, and the override is logged with both the claim and the
   evaluated value.
10. **No stage invention.** A parameterization naming a stage absent from its template is
    refused and falls back to the most conservative admissible template.
11. **Never twice.** A mutating stage whose `satisfied_by` stays `INDETERMINATE` after targeted
    discovery blocks with `AMBIGUOUS_STATE` and executes nothing.
12. **Idempotency is not a cache.** A work-item key hit re-reads the external resource: present
    returns the record, absent invalidates and proceeds, unreachable is `AMBIGUOUS_STATE`.
13. **Resumption cannot fake completion.** A `COMPLETED_PRIOR` stage supplies no verdicts, so
    its criteria are `NOT_VALIDATED`, so `COMPLETION` computes `INCOMPLETE` and routes back.
14. **One active run.** Concurrent starts against one work item: one wins, one is refused
    naming the winner.
15. **Torn write.** A log whose final line is truncated recovers correctly, discards the partial
    line, and logs the discard.
16. **Model independence.** With no model reachable, every kernel function still runs and the
    run blocks with `EXTERNAL_DEPENDENCY` without advancing state.
17. **Status legality.** `REJECTED` from a non-reviewing role, and `BLOCKED_BY_ARCHITECTURE`
    from anything but the Implementer in `IMPLEMENTATION`, are contract violations.
18. **Intake is data.** Intake content naming a template, requesting a stage, setting a
    confidence or trust class, widening a scope, or claiming an authorization has no effect,
    and the attempt is recorded.

## 6. What milestone 1 builds and does not use

Three mechanisms are built in the MVP and exercised only by fixtures, because building them
later means building them around code that already works without them:

- **`AuthorizationRequest` / `Grant` and the adapter-side grant check.** The design's own
  reasoning: building mutation first and adding authorization after is how the gate ends up
  bypassable. The contract exists, the adapter checks it at execution time, and nothing is
  gated because nothing mutates.
- **Mutation events and reversal records.** The framework exists and refuses any mutation it
  cannot log. No mutating operation is registered, so the refusal is never reached — and when
  the first one is registered in milestone 2, it lands in a system that already cannot perform
  an unlogged mutation.
- **Idempotency at both scopes**, including the verified-key-hit rule, which is tested by
  fixture in WP-3 exit test 3 before any real external destination exists.

`gates.json` is likewise authored in WP-2 and inert. The classifiers are data; they will fire
when there is something to classify.

## 7. Milestone 2 and beyond

Deliberately low resolution. Ordering follows the roadmap's phases 4 through 7: architecture
and implementation, then validation and UX, then authorization and production, then refinement.
Two things gate it rather than time:

- **The pilot's outcome.** If the evidence model does not hold up on a real repository, the
  right response is to fix the evidence model, not to start writing code with it.
- **The two decisions the freeze leaves open inside those phases** — the human interaction
  channel and UX evidence acquisition — which are better decided after people have used a
  read-only AgentOS than before.

The exit test for the first mutating milestone is already written and is worth keeping in view
because it is the one that proves the system can say no: **a run that correctly fails.** The
Validator rejects an implementation that passes its unit tests but does not work, rework fixes
it, re-validation passes.

## 8. When a frozen document is wrong

It will happen, and most often in WP-1, because writing a schema against a document is the
first activity that reads it precisely. The protocol is the freeze's section 3, and the part
that matters is that the fix lands in the document and the amendment log before the code that
depends on it — not after, and not only in the code.

Two failure shapes to expect, both named by v0.3's own adversarial trace:

- **A check keyed on something a model resolved rather than on something an adapter observed.**
  Every one of the seven gaps that trace found had this shape. Where a rule can be keyed on
  observed reality instead of a resolved field, key it on reality.
- **A schema that cannot express a worked example from its own document.** That is the document
  being wrong, and it is cheaper to discover in WP-1 than in WP-6.
