# Workflow State Machine

A **Work Item** is the durable thing AgentOS is trying to accomplish. A **Workflow Run** is
one attempt to accomplish it: a persisted state machine plus an append-only event log, which
must survive process death, terminal closure, model failure and machine restart.

The kernel owns transitions. An agent proposes `next_action`; the kernel decides. An agent
that claims a transition it is not entitled to make is a contract violation, logged as such.

v0.2 had one workflow, hard-wired, and every run walked it. v0.3 replaces that with a graph
selected per work item from **templates defined in policy** — without giving any agent the
ability to author a graph, skip a stage, or decide where a run resumes. How that is possible
is the subject of sections 3 and 4.

Where work comes from and how it becomes a Work Item is
[INTENT_AND_WORK_ITEM_RESOLUTION.md](INTENT_AND_WORK_ITEM_RESOLUTION.md). This document
starts once a Work Item has been admitted.

## 1. Work Item and Workflow Run

```
WORK ITEM  wi_jira_STORY-724            durable; survives every attempt
   |
   +-- WORKFLOW RUN #1   run_...a1b2    FAILED     (model outage mid-implementation)
   +-- WORKFLOW RUN #2   run_...c3d4    BLOCKED    (awaiting merge authorization)
   +-- WORKFLOW RUN #3   run_...e5f6    COMPLETE
```

- The **Work Item** holds identity, type, desired outcome, scope, links and lifecycle.
- A **Workflow Run** holds a frozen graph, a cursor, an event log and its envelopes.
- A run failing does not fail the Work Item. Crash, retry, model failure and human pause
  destroy neither work item identity nor history.
- **One active run per Work Item**, enforced by a lease on the work item record. A second
  attempt is refused with the active run named.

**The lease must be acquired atomically** — an exclusive create, or a create-and-rename, never
a read-then-write — because the case it exists for is two processes starting at the same
moment, which is exactly when a check-then-act loses. A lease whose holder is gone is
reclaimable only after a policy timeout (`budgets.lease_timeout`), and the reclamation is
logged with the abandoned run id. Without the timeout a crashed run holds its work item
forever; without the atomicity the lease does not do the one job it has.

The graph is **frozen at run start**. Re-selecting a workflow means starting a new Workflow
Run against the same Work Item, which is a recorded event with a reason. A run whose graph
could change under it would not be replayable, and replayability is what recovery rests on.

## 2. Stages

A stage is a phase, not a single dispatch. One stage may involve several agent invocations
before its exit condition is met, and transitions are driven by exit conditions rather than
by envelope arrival.

### 2.1 The prologue — kernel-owned, in every run

No template contains these, no template can alter them, and no proposal can skip them.

```
INTAKE_RECEIVED     the IntakeRecord is durable
RESOLUTION          Context Discovery (resolution mandate) -> admitted Work Item
CONTEXT_DISCOVERY   tier-2 depth, scoped by the admitted Work Item; Current Reality
UNDERSTOOD          kernel-computed sufficiency verdict
WORKFLOW_SELECTED   template admitted, parameterization fixed, graph frozen
```

This is the structural answer to "an Orchestrator that skips analysis": the analysis
happens before any Orchestrator proposal exists.

### 2.2 Template stages

```
AUDIT                 capability graph, findings, orphans over the work item's scope
ROOT_CAUSE            why the observed behaviour occurs, with evidence
ARCHITECTURE          structure, ownership, contracts, failure semantics
PLAN                  ordered work units, each with a DoD profile
DECOMPOSITION         Epic only: propose child Work Items
CHILD_COORDINATION    Epic only: children execute as independent Work Items
IMPLEMENTATION        build the approved plan
VALIDATION            the Validator's five layers
STRUCTURAL_REAUDIT    the Auditor's second pass: DoD criteria 6, 16, 17
UX_REVIEW             Product/UX judgment on a user-facing surface
REWORK                route a rejection back into implementation
PR_PREPARATION        branch, commits, PR body, PR opened or drafted
PR_REVIEW             wait on and read human review
REVIEW_TRIAGE         classify feedback: in-scope, separable, or scope expansion
COMMENT_RESOLUTION    address in-scope feedback
AUTHORIZATION         the end-of-run human gate
MERGE                 merge into the target branch
DEPLOY                release to an environment
PRODUCTION_VALIDATION evidence the capability works in production
COMPLETION            DoD arithmetic, outcome record, work item lifecycle update
```

Control states, not stages: `BLOCKED` (semi-terminal, resumable), `CANCELLED` (terminal, by
human decision or admitted supersession), `COMPLETE` (terminal).

### 2.3 Stage descriptors

`policies/stages.json` declares, per stage:

```
mutating           does entering it change authoritative state
default_agent      which role owns it
required_outputs   what its dispatches must fill
exit_condition     what must hold to leave it
satisfied_by       the reality predicate meaning "already done" (section 5)
gates_possible     which authorization gates can fire here
dod_criteria       which DoD criteria this stage supplies verdicts for
```

`mutating` is load-bearing in three places: the safe-prefix computation under ambiguity, the
resume rule in section 5, and the `AUTONOMOUS_INTAKE_EXECUTION` gate. Read-only stages are
`AUDIT`, `ROOT_CAUSE`, `ARCHITECTURE`, `PLAN`, `VALIDATION` (non-production layers),
`STRUCTURAL_REAUDIT`, `UX_REVIEW`, `PR_REVIEW`, `REVIEW_TRIAGE` and `DECOMPOSITION`.

### 2.4 Mapping from v0.2

The v0.2 state list mixed phases with completion markers. `X` and `X_COMPLETE` does not
survive branching: after a loop, there is no single `AUDIT_COMPLETE` to return to.
Completion markers become **exit conditions**; failure states become **edge conditions**.

```
GOAL_RECEIVED                  -> INTAKE_RECEIVED
CONTEXT_READY                  -> UNDERSTOOD (superset; see resolution doc section 6)
AUDIT_COMPLETE                 -> exit condition of AUDIT
ARCHITECTURE_READY             -> exit condition of ARCHITECTURE
PLAN_READY                     -> PLAN stage + its exit condition
IMPLEMENTATION_COMPLETE        -> exit condition of IMPLEMENTATION
VALIDATION_FAILED              -> edge VALIDATION --[REJECTED]--> REWORK
UX_FAILED                      -> edge UX_REVIEW --[REJECTED]--> REWORK
READY_FOR_HUMAN_AUTHORIZATION  -> AUTHORIZATION
AUTHORIZED                     -> exit condition of AUTHORIZATION
DEPLOYING                      -> DEPLOY
```

`VALIDATION` keeps its name. The brief's "TESTING" would weaken it: `DEFINITION_OF_DONE`
criterion 12 (tests exist and pass) is deliberately distinct from criterion 13 (a real record
traced end to end), and "testing" reads as the first when the stage means both.

The Auditor's second pass, previously an unnamed extra dispatch inside `VALIDATION`, becomes
`STRUCTURAL_REAUDIT` — a node, because in a graph it needs edges of its own.

## 3. Workflow templates

### 3.1 Templates are policy data

A workflow template lives in `policies/workflows/*.json`, versioned in git, authored and
reviewed by humans. **No agent authors a graph.** The Orchestrator Agent selects among
templates and parameterizes within their declared degrees of freedom.

This is the load-bearing decision of v0.3, and it is what keeps "the kernel disposes" true
in the presence of dynamic workflows. A kernel cannot validate an arbitrary model-authored
graph without judgment — it would have to decide whether a novel sequence of stages is safe,
and that is exactly the reasoning it is forbidden to do. Validating a *selection* from a
known set is arithmetic.

```json
{
  "template_id": "defect.standard",
  "version": "1.0",
  "description": "A defect in an existing capability: root cause before any fix.",
  "applies_to": { "types": ["DEFECT"] },
  "entry": "AUDIT",
  "stages": ["AUDIT", "ROOT_CAUSE", "ARCHITECTURE", "PLAN", "IMPLEMENTATION",
             "VALIDATION", "STRUCTURAL_REAUDIT", "UX_REVIEW", "PR_PREPARATION",
             "PR_REVIEW", "REVIEW_TRIAGE", "COMMENT_RESOLUTION", "REWORK",
             "AUTHORIZATION", "MERGE", "COMPLETION"],
  "optional_stages": ["ARCHITECTURE", "UX_REVIEW"],
  "edges": [
    { "from": "AUDIT", "to": "ROOT_CAUSE", "when": "always", "kind": "advance" },
    { "from": "ROOT_CAUSE", "to": "BLOCKED", "when": "envelope.BLOCKED", "kind": "escalate" },
    { "from": "ROOT_CAUSE", "to": "ARCHITECTURE", "when": "architecture.required", "kind": "branch" },
    { "from": "ROOT_CAUSE", "to": "PLAN", "when": "NOT architecture.required", "kind": "branch" },
    { "from": "VALIDATION", "to": "REWORK", "when": "envelope.REJECTED", "kind": "loop",
      "counter": "rework", "cap": "budgets.rework" },
    { "from": "PR_REVIEW", "to": "REVIEW_TRIAGE", "when": "reality.pr_has_unresolved_comments", "kind": "loop",
      "counter": "review", "cap": "budgets.review" },
    { "from": "PR_REVIEW", "to": "AUTHORIZATION", "when": "reality.pr_approved", "kind": "advance" }
  ],
  "dod_profile_default": "fix"
}
```

The `edges` list above is abbreviated to the edges worth reading; a real template also carries
the ordinary advance edges between the remaining stages and the escalation edge from every
stage to `BLOCKED`. `description` is required (amendment A-7): a template is human-authored
policy data, and a reviewer reading `policies/workflows/` needs to know what each one is for
without reconstructing it from the stage list.

### 3.2 The template set

Nine, covering the resolvable types. The set is data; an organisation adds to it without
touching the kernel.

- **`task.direct`** — `IMPLEMENTATION → VALIDATION → PR_PREPARATION → AUTHORIZATION → MERGE
  → COMPLETION`. The tiny-change path. No audit, no architecture, no root cause.
- **`defect.standard`** — above. `ROOT_CAUSE` is mandatory: a defect fixed without a
  root cause is a symptom patched, which principle 9 forbids.
- **`story.standard`** — `AUDIT → ARCHITECTURE? → PLAN → IMPLEMENTATION → VALIDATION →
  STRUCTURAL_REAUDIT → UX_REVIEW? → PR_PREPARATION → PR_REVIEW ⇄ REVIEW_TRIAGE →
  AUTHORIZATION → MERGE → COMPLETION`.
- **`feature.standard`** — story plus mandatory `ARCHITECTURE` and `DEPLOY` /
  `PRODUCTION_VALIDATION` where `production.applicable`.
- **`epic.coordinate`** — `DECOMPOSITION → CHILD_COORDINATION → COMPLETION`. **Contains no
  `IMPLEMENTATION` stage**, which is how "do not turn an Epic into one enormous linear
  workflow" is enforced structurally rather than advised.
- **`change_request.land`** — for an existing PR: `PR_REVIEW ⇄ REVIEW_TRIAGE →
  COMMENT_RESOLUTION → IMPLEMENTATION → VALIDATION → PR_REVIEW → AUTHORIZATION → MERGE →
  COMPLETION`. Entry is computed, not fixed (section 5).
- **`investigation.readonly`** — `AUDIT → ROOT_CAUSE → COMPLETION`. Entirely non-mutating;
  the deliverable is findings. This is the target of `UNKNOWN` type and of ambiguity rung 3.
  Its `applies_to` is `{ "types": ["*"] }` **by design**: it is admissible for every work item
  type, so the admissible set is never empty and the fallback in 3.4 always has something to
  fall back to. A template set whose intersection with some work item is empty would leave the
  kernel choosing between guessing and refusing, and this removes that case.
- **`incident.contain`** — `ROOT_CAUSE → AUTHORIZATION(containment) → … → PRODUCTION_VALIDATION`.
  Containment precedes correctness, and every mutating stage is gated.
- **`documentation.direct`** — `IMPLEMENTATION → VALIDATION(docs) → PR_PREPARATION →
  AUTHORIZATION → MERGE → COMPLETION`.

### 3.3 What the Orchestrator may choose

Exactly three things, all bounded:

1. **Which template**, from the set the kernel computed as admissible for this work item's
   type and reality.
2. **Which optional stages to include.** Inclusion is always allowed. **Exclusion requires
   the stage's applicability predicate to evaluate `FALSE`** — evaluated by the kernel, not
   claimed by the agent. `INDETERMINATE` means the stage is included, per the v0.2
   safer-branch rule, which applies unmodified here because including a review stage costs
   only tokens.
3. **Per-stage mandate scope**, bounded by and never exceeding the Work Item's admitted
   `scope`.

It may not choose the entry stage. **The kernel computes where the run starts** from Current
Reality (section 5). This matters: "resume from the right place" is the decision most
vulnerable to an agent's optimistic reading of a prompt, and it is removed from the agent
entirely.

### 3.4 Admission

At **policy load**, every template is checked against the workflow floor. A template that
violates it never loads, and the failure is reported loudly at startup — an authoring error
should not wait for a run to surface.

At **run start**, the parameterized instance is checked again:

1. **Template exists, loaded from policy, version recorded.**
2. **`applies_to` matches** the admitted work item type.
3. **Every included stage is in the template's `stages`.** A stage not in the template cannot
   be added. This is why "the Orchestrator proposes a dangerous stage" is not reachable: it
   cannot put `DEPLOY` into a template that does not have one.
4. **Every excluded optional stage has a `FALSE` predicate**, evaluated by the kernel.
5. **The floor holds** for the resulting graph.
6. **The graph is well-formed**: every edge's endpoints are included stages, every stage is
   reachable from the entry, `COMPLETION` is reachable, every loop edge names a counter bound
   to a policy cap.

A failed admission is not negotiated. The kernel selects the most conservative admissible
template — the one whose stage set is a superset of the others, or `investigation.readonly`
if none is — records the override, and continues. The Orchestrator being wrong costs
efficiency, never safety.

### 3.5 The workflow floor

`policies/workflow-floor.json`. Rules of the form *if the graph contains X, it must contain
Y before it*. Data, not kernel code.

```
contains MERGE            requires VALIDATION and AUTHORIZATION before it
contains DEPLOY           requires VALIDATION, AUTHORIZATION, and PRODUCTION_VALIDATION after
contains IMPLEMENTATION   requires VALIDATION after it
type DEFECT               requires ROOT_CAUSE before IMPLEMENTATION
type EPIC                 forbids IMPLEMENTATION
scope touches a contract  requires ARCHITECTURE          (architecture.required)
scope touches a UI        requires UX_REVIEW             (ux.required)
regression.suspected      requires ROOT_CAUSE before IMPLEMENTATION
every template            requires COMPLETION as the sole predecessor of COMPLETE
```

The floor is why "the Orchestrator skips analysis" fails at three independent points: the
prologue runs regardless, the floor requires the analysis stage, and excluding an optional
stage needs a kernel-evaluated `FALSE`.

### The regression rule, and why it is keyed on reality rather than type

`regression.suspected` is the one floor rule not keyed on the work item type, and it exists
because every other rule here inherits the type's correctness. A defect misclassified as a
`TASK` selects `task.direct`, which has no `ROOT_CAUSE` stage — and the rule that would have
required one is keyed on the type that was wrong.

```
regression.suspected  ==  reality.outcome_already_satisfied is FALSE
                          AND the work item scope intersects a capability record whose
                              status is WORKING or PROVEN
```

Both terms are registry and predicate lookups, so this is arithmetic. It reads as: *something
that demonstrably used to work does not now*. That is a regression whatever anyone called it,
and it may not be fixed without establishing why.

The point generalises. **A floor rule keyed on a resolved field can only be as good as the
resolution; a rule keyed on observed reality cannot be defeated by misclassification.** Where
a floor rule can be expressed either way, it should be expressed over reality.

### 3.6 Risk class

The kernel derives a risk class from the admitted graph and scope, and records it:

```
READ_ONLY            no mutating stage
LOCAL_MUTATION       mutates only inside a worktree
EXTERNAL_MUTATION    reaches an external system (PR, ticket, notification)
IRREVERSIBLE         reaches merge, deploy, production write, or a reversal: null operation
```

Risk class selects floor rows and the gate set, and it is what
`AUTONOMOUS_INTAKE_EXECUTION` keys on for `EXTERNAL` intake.

## 4. Transitions

### 4.1 Edges

Every edge carries `from`, `to`, `when` (a named predicate, `always`, or an envelope status),
and `kind`:

- **`advance`** — ordinary progress
- **`branch`** — mutually exclusive alternatives; exactly one predicate must hold
- **`loop`** — returns to an earlier stage; must name a counter and a policy cap
- **`escalate`** — to `BLOCKED` with a blocker kind
- **`terminal`** — to `COMPLETE` or `CANCELLED`

Every transition is an event carrying from, to, trigger, deciding agent, evidence references
and timestamp.

**Any stage may transition to `BLOCKED`.** Authorization required, budget exhausted, external
dependency, unresolved conflict, ambiguous state — one blocking mechanism, no state
explosion. The pre-block stage is recorded so the run resumes in place.

**Production failure does not fall back into `REWORK`.** Code is already live, so the next
decision is a rollback decision, and that is a human's. `PRODUCTION_VALIDATION` failure goes
to `BLOCKED` with the Production agent's rollback recommendation attached. Resuming into
`REWORK` requires either a completed rollback or an explicit human decision to fix forward,
both recorded as authorization events.

### 4.2 Envelope status to kernel action

Unchanged from v0.2 in substance. Every value of `HandoffEnvelope.status`
([AGENT_HANDOFF_CONTRACT.md](AGENT_HANDOFF_CONTRACT.md)) maps to exactly one kernel action.

- `COMPLETE` — evaluate the proposed `next_action` against the graph's edges from the current
  stage; transition if legal and its predicate holds, else override and log.
- `PARTIAL` — **never** a soft `COMPLETE`. The kernel checks whether the unfilled outputs are
  required by the current stage's exit condition. Not required → proceed, recording the gap as
  an `unknown`. Required → re-dispatch once with the gap named, then `BLOCKED` if it recurs.
- `BLOCKED` — transition to `BLOCKED`, carrying the blocker. The pre-block stage is recorded.
- `BLOCKED_BY_ARCHITECTURE` — `IMPLEMENTATION → ARCHITECTURE`, counted against the
  architecture loop cap. Legal only from `IMPLEMENTATION`, and only when the graph contains
  `ARCHITECTURE`; where it does not, it is `BLOCKED` with `ARCHITECTURE_CONTRADICTION`, which
  is the honest outcome for a template that assumed no design work was needed.
- `FAILED` — an agent-level failure (tooling, model, timeout), not a finding about the work.
  Retry per policy, escalating the model once. On repeated failure: `BLOCKED`. The stage does
  not advance, and a `FAILED` envelope never satisfies an exit condition.
- `REJECTED` — legal only from a reviewing agent. From the Validator or Product/UX it takes
  the `REJECTED` edge from the current stage, which is `REWORK` in every template that has
  one. From any other agent it is a contract violation.

An envelope whose status is illegal for the current stage or agent is logged as a contract
violation and handled as `BLOCKED`. The kernel never guesses what an agent meant.

### 4.3 Transition predicates

A transition table whose branch conditions are prose is a table an agent decides. Every
conditional edge names a **predicate the kernel evaluates itself**, over the Context Package,
the capability registry, Current Reality and the dispatch's mutation events. The agent's
opinion is recorded as a `claim` and is never the decision.

Predicates are data in `policies/predicates.json`.

**Applicability predicates** (v0.2, unchanged):

- **`audit.applicable`** — the capability registry contains a record whose scope intersects
  the work item scope, or the repository has any commit history.
- **`architecture.required`** — a planned or actual change touches a declared contract
  boundary (`api_map`, `source_map`, schema/migration paths); or would change canonical
  ownership in `domain_model`; or an audit finding is categorized structural.
- **`ux.required`** — `context.ui_map` is non-empty and a mutation event touches a path under
  a `ui_map` surface, or an API whose consumers include a `ui_map` surface changed shape.
- **`production.applicable`** — `environments` includes an environment classified production
  and the work item scope reaches it.

**Reality predicates** (v0.3, evaluated over `context.current_reality`, which comes from
adapters only):

- **`reality.implementation_present`** — a branch or commit within scope implements the work
- **`reality.tests_present`** — tests covering the scope exist and executed
- **`reality.pr_open`** / **`reality.pr_merged`** / **`reality.pr_approved`**
- **`reality.pr_has_unresolved_comments`** — unresolved review threads on the current head
- **`reality.ci_green`** — CI passed for the current head SHA, within the freshness window
- **`reality.children_all_terminal`** — every child work item is `ACHIEVED`, `ABANDONED` or
  `SUPERSEDED`
- **`reality.outcome_already_satisfied`** — the desired outcome holds, observably, now
- **`reality.deployed`** — the change is present in a named environment

Every reality predicate reads assertions whose confidence class is part of the value. A
predicate over an `UNKNOWN` assertion is `INDETERMINATE`, never `FALSE`.

**Reality is re-probed, not snapshotted.** A predicate is evaluated against a `current_reality`
element that is `CURRENT` within its freshness window
([CONTEXT_MODEL.md](CONTEXT_MODEL.md) section 7); a `STALE` element is re-probed before the
predicate is evaluated, and a stale element is never used to decide a transition.

This matters more than it looks. Git and PR state expire in minutes, and the whole resume and
review-loop model rests on reality predicates. Evaluating `reality.pr_has_unresolved_comments`
against a package version assembled forty minutes and two stages ago would mean a review
comment arriving mid-implementation is invisible for the rest of the run — the loop would
close on a snapshot rather than on the PR. Re-probing at evaluation is what makes the loop
converge on what reviewers actually said.

### 4.4 The safer-branch rule

**`INDETERMINATE` takes the branch that does more verification and the branch that does less
irreversible mutation.**

Where those agree, take that branch. Cannot tell whether a UI changed? Run the UX review —
more verification, no mutation. Cannot tell whether architecture is needed? Run the Architect.

Where they disagree — the case v0.2 did not have, and v0.3 does — the kernel does not choose.
Cannot tell whether a PR already exists? Opening a second one is more work *and* more
irreversible mutation. The kernel performs additional discovery; if that cannot settle it, it
blocks with `AMBIGUOUS_STATE`. **AgentOS never re-executes a non-reversible operation on the
strength of an `INDETERMINATE`.**

The v0.2 formulation is the special case where no irreversible mutation is in play, which is
every applicability predicate it was written for. The rationale is unchanged: the cost of an
unnecessary review is tokens; the cost of a skipped one is a defect reaching production behind
a green run; and where a predicate's inputs are missing because discovery could not reach
them, the safer branch is also the honest one — AgentOS does not get to skip a stage because
it failed to look.

An agent may not propose a transition whose predicate the kernel evaluates against it. Such a
`next_action` is overridden, and the override is logged with both the claim and the evaluated
value, so a systematically over-claiming agent becomes visible in the run narrative.

### 4.5 Re-resolution — when the work turns out to be something else

A frozen graph is right for durability and wrong for the case where a stage discovers that the
work item itself was misresolved: `ROOT_CAUSE` on a supposed defect finding that the feature
was never built, or an investigation concluding that the request is really an Epic.

An agent may return `BLOCKED` with the blocker kind **`WORK_ITEM_MISCLASSIFIED`**, carrying the
evidence for the corrected reading. It is a blocker rather than a proposal because the run
genuinely cannot continue: its graph is for different work.

The kernel then:

1. Ends the Workflow Run with outcome `RERESOLVED`, recorded with the evidence.
2. Re-runs `RESOLUTION` with the new evidence supplied alongside the original intake, and
   admits the result through the ordinary checks — the corrected type earns no exemption from
   its evidence minimum.
3. Starts a **new** Workflow Run against the **same** Work Item. Identity, history and every
   prior envelope survive; only the graph is new.
4. Counts it against `budgets.reresolution` (default 1). A second re-resolution means the work
   is not understood, and `BLOCKED` with a human is better than a third guess.

Without this the only options were a frozen wrong graph running to a wasted completion, or a
graph an agent could mutate mid-run. This is the third option: the run ends honestly and a new
one starts, which is exactly the distinction the Work Item / Workflow Run split was for.

## 5. Resumption — where a run starts

The kernel computes the entry stage. No agent proposes it, and the intake never implies it.

### 5.1 The computation

Walk the frozen graph in topological order from the template's entry. For each stage, evaluate
its `satisfied_by` predicate over Current Reality:

```
satisfied_by TRUE            -> mark COMPLETED_PRIOR, record the reality evidence, continue
satisfied_by FALSE           -> this is the entry stage; stop
satisfied_by INDETERMINATE
    and stage is non-mutating -> enter it (more verification, no mutation)
    and stage is mutating     -> dispatch targeted discovery; if still INDETERMINATE,
                                 BLOCKED with AMBIGUOUS_STATE
```

For `STORY-724` with implementation complete, tests complete, a PR open and three unresolved
review comments, the walk marks `AUDIT`, `PLAN`, `IMPLEMENTATION`, `VALIDATION` and
`PR_PREPARATION` as `COMPLETED_PRIOR` and enters at `REVIEW_TRIAGE`. Analysis, planning and
implementation are not restarted — not because an agent decided they were done, but because
git and the PR host said so.

### 5.2 Resumption never fakes completion

`COMPLETED_PRIOR` means *the mutation this stage performs has already occurred*. It does not
mean the stage's DoD criteria are met.

**Completion is judged by the DoD at `COMPLETION`, from per-criterion verdicts supplied by
agents, never from the stage cursor.** A stage skipped as `COMPLETED_PRIOR` supplied no
verdicts, so its criteria are `NOT_VALIDATED` — and `NOT_VALIDATED` is never `MET`
([DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md)). The run therefore reaches `COMPLETION` and
computes `INCOMPLETE`, which routes back into the graph at the stage that owns the missing
verdicts.

This is the property that makes resumption safe. The resume computation is an optimization
over *work*; it has no authority over *completion*. A wrong resume costs a wasted lap; it
cannot produce a false `COMPLETE`.

### 5.3 Work already complete

Where `reality.outcome_already_satisfied` is `TRUE` at `UNDERSTOOD` — the fix is merged, the
behaviour is observably correct — the kernel admits `investigation.readonly` with a
`COMPLETION`-only parameterization. The run evaluates the DoD against existing evidence,
records the outcome, sets the work item `ACHIEVED`, and stops. It does not re-implement, and
it does not simply declare victory: the DoD still runs, against real evidence, and can return
`INDETERMINATE` if that evidence is not obtainable.

Where the outcome is claimed complete but unproven — a ticket in `Done` with no supporting
runtime evidence — that is `CLAIMED_DONE_UNPROVEN`, not `ACHIEVED`, and the run proceeds to
establish or refute it. That case is the most valuable output AgentOS produces, and treating
it as "already done" would discard exactly the finding worth having.

### 5.4 Crash recovery

Unchanged from v0.2 and detailed in section 7: replay the log, rebuild the cursor, detect
interrupted dispatches, reverse their mutations, re-dispatch with a fresh `dispatch_id`. The
resume computation in 5.1 is for *new runs against existing work*; crash recovery is for *the
same run continuing*. They are different mechanisms and must not be confused: crash recovery
never re-derives the entry stage, because the frozen graph and the cursor already say where
the run was.

## 6. Loops and budgets

Four loops, all bounded by policy caps in `policies/budgets.json`:

- **Rework loop** — `VALIDATION | UX_REVIEW --[REJECTED]--> REWORK → IMPLEMENTATION →
  VALIDATION`. Default cap 3.
- **Architecture loop** — `IMPLEMENTATION → ARCHITECTURE → … → IMPLEMENTATION`. Default cap 2.
  A third contradiction means the problem is not understood, and pushing through is worse than
  stopping.
- **Review loop** — `PR_REVIEW → REVIEW_TRIAGE → COMMENT_RESOLUTION → IMPLEMENTATION →
  VALIDATION → PR_REVIEW`. Default cap 5, higher than rework because a reviewer asking for
  three rounds of changes is normal engineering rather than a failing run. Exceeding it is
  `BLOCKED`, and the block report is what a human needs to see: the review is not converging.
- **Discovery loop** — an on-demand probe requested mid-run, including the re-resolution in
  the uncertainty ladder. Not counted against rework; bounded by cost budget.

Exceeding a cap is `BLOCKED`, never a quiet retry. The block report states what was tried, what
failed each time, and what a human would need to decide.

Also bounded: total cost, wall clock, and per-agent invocation count — **per Workflow Run and
per Work Item**. The second is new and necessary: three runs of two laps each is six laps, and
a budget that resets on every attempt is not a budget.

## 7. Durability

```
state/work-items/<work-item-id>/
  work-item.json      identity, type, desired outcome, scope, links, lifecycle, run lease
  events.ndjson       work-item-level log: runs started, outcomes, links, reclassifications
  runs/<run-id>/
    run.json          identity, frozen graph, current stage, cursor, budgets consumed
    events.ndjson     append-only run log; the source of truth for this attempt
    context/          Context Package snapshots, including current_reality
    capabilities/     capability registry
    envelopes/        one file per agent handoff, immutable
    decisions/        arbitration, architecture and admission decisions
    authorizations/   requests and grants
    artifacts/        diffs, reports, screenshots, traces
```

v0.2's `state/runs/<run-id>/` becomes `state/work-items/<id>/runs/<run-id>/`. Its internals are
unchanged.

Rules that make interruption survivable:

- **The event log is authoritative.** `run.json` and `work-item.json` are projections and can
  be rebuilt from their logs. If they disagree, the log wins.
- **Write before act.** An intent-to-dispatch event is written before the agent is invoked, so
  a crash mid-agent is detectable rather than invisible.
- **Every event is one newline-terminated line, appended and flushed.** On recovery a trailing
  partial line — the signature of a power loss mid-write — is discarded and the discard is
  itself logged. A partial line is never parsed, and never silently dropped.
- **Recovery replays, it does not resume from memory.** On restart the kernel reads the log,
  rebuilds the cursor, identifies any dispatch interrupted mid-flight, and applies the retry
  protocol in 7.3.
- **The frozen graph is part of `run.json` and is replayed, not recomputed.** Re-selecting a
  workflow on recovery would make recovery depend on a model.

Nothing about resumption depends on a model remembering anything, or on a model being available
at all.

### 7.1 The adapter call log

**Every adapter call is logged — reads included, not only mutations.** A `call` event records
dispatch, adapter, operation, arguments, outcome and timing. Mutating calls additionally emit
the `mutation` event below.

Logging reads costs little and buys the thing nothing else can: **the kernel knows what an
agent actually looked at.** That makes two otherwise unverifiable claims checkable.

- **Coverage.** An agent's `coverage.scope_examined` is reconciled against its call log. An
  agent claiming it examined a subsystem that no call touched is a contract violation. Without
  this, `coverage` — the field distinguishing "found nothing there" from "never looked there" —
  is exactly the kind of unchecked self-report the rest of the design removes.
- **Evidence that cannot be replayed.** A screenshot cannot be byte-compared, but the adapter
  call that produced it can be confirmed to have happened, against that URL, in that state, at
  that time. The observation's *provenance* is verifiable even when its *content* is not.

Read calls are logged at a policy-defined granularity, since a discovery run makes many.
Aggregation is permitted; omission is not.

### 7.2 Mutation events

**Adapters emit a `mutation` event at call time, before returning to the caller.** Not at the
end of a dispatch, and not from the envelope — an envelope that never arrives cannot record
anything, which is exactly the crash this rule exists for.

```json
{
  "seq": 37,
  "at": "2026-09-04T11:02:44Z",
  "work_item_id": "wi_jira_DEF-456",
  "run_id": "run_2026_09_04_a1b2",
  "stage": "IMPLEMENTATION",
  "dispatch_id": "d_014",
  "agent": "implementer",
  "event": "mutation",
  "data": {
    "work_item_id": "wi_jira_DEF-456",
    "run_id": "run_2026_09_04_a1b2",
    "dispatch_id": "d_014",
    "adapter": "git", "op": "commit",
    "target": "worktree/agentos-run-a1b2",
    "before": { "head": "9f2c1ab" },
    "after":  { "head": "4de0117" },
    "reversal": { "op": "reset_hard", "args": { "to": "9f2c1ab" } },
    "at": "2026-09-04T11:02:44Z"
  }
}
```

**Every log line has the same frame.** `seq`, `at`, `work_item_id`, `run_id`, `stage`,
`dispatch_id`, `agent` and `event` are common to every record, and the record's own content
is under `data`. Earlier drafts showed this example flattened, which would have given the
log two shapes and made a replayer's discriminated union impossible to type (amendment A-8).
`seq` is monotonic within one log, which is what makes "any prefix of the log" a well-defined
thing to replay.

Consequences:

- The reversal record exists the moment the mutation does.
- The blast radius of any dispatch is computable from the log alone.
- `artifacts_changed` in the envelope becomes a *reconciliation* the kernel checks against
  these events, catching both under- and over-reporting.

An adapter that cannot emit a mutation event must refuse the mutation. Unlogged mutation is not
permitted, and "the log was unavailable" is a reason to stop, not to proceed.

Incidental artifacts — coverage output, build caches, temp files declared in an operation's
`incidental_artifacts` ([REPOSITORY_ADAPTER.md](REPOSITORY_ADAPTER.md) section 2.3) — are not
authoritative state and emit no mutation events. Declaring them is how a test run stays
replayable without pretending it wrote nothing.

### 7.3 Retry and idempotency

Retry is defined at the granularity where side effects actually happen — the adapter operation
— not at the granularity of an agent.

**Two idempotency scopes.** v0.2 had one, keyed to the dispatch, which makes a crash-retry safe
*within* a run. It does nothing across runs, and across runs is where duplicate external side
effects actually come from: a run fails after opening a PR, a new run starts against the same
Work Item, and a second PR appears.

```
key_dispatch  = hash(run_id, dispatch_id, adapter, op, normalized_args)
key_work_item = hash(work_item_id, adapter, op, identity_args)
```

- **Dispatch scope** applies to every mutating operation. Replaying a known key performs no
  work and returns the recorded result.
- **Work-item scope** applies additionally to operations declared `external_destination: true`
  or `reversal: null` — opening a PR, posting a comment, transitioning a ticket, sending a
  notification. Its key is computed over the operation's **`identity_args`**, declared in the
  descriptor: for `create_pr` that is (repository, head branch, base branch), not the PR body,
  so a second run with a differently worded description still resolves to the existing PR
  rather than opening a second one.

**A work-item-scoped key hit is verified, never trusted.** A recorded result says what
happened once; it does not say the world still looks that way. Someone may have closed the PR,
deleted the branch, or reverted the ticket. On a key hit for an operation with an external
destination, the adapter **re-reads the external resource** before returning:

```
resource confirmed present   -> return the recorded result, log `deduplicated`
resource confirmed absent    -> invalidate the record, log `idempotency_divergence`,
                                and perform the operation
resource unreachable         -> INDETERMINATE. Do not return the record and do not
                                re-execute: BLOCKED with AMBIGUOUS_STATE.
```

The third line is the refined safer-branch rule at the sharpest point in the system. Returning
a stale record makes the run believe it has a PR that does not exist; re-executing may open a
second one. Neither is acceptable on a guess, so the kernel does not guess.

This closes the gap left by a cached-key design: **AgentOS's own record of what it did is
authoritative about the past and not about the present.** The same rule the architecture applies
to a ticket's status field applies to its own idempotency ledger.

**Pre-retry reset.** Before re-dispatching an interrupted or failed agent, the kernel reads the
dispatch's mutation events, applies their reversals in reverse order, logs a
`dispatch_rollback` event listing what was reversed, and re-dispatches with a **new**
`dispatch_id` so the retry's operations get fresh dispatch keys. Work-item keys are deliberately
not refreshed — that is the point of them.

**Non-reversible operations.** An operation whose `reversal` is `null` — an external API write,
an email, a published artifact — is declared non-reversible in the adapter's descriptor. A
dispatch that performed one **is never automatically retried**. The run blocks with
`EXTERNAL_DEPENDENCY`, stating precisely what already happened, and a human decides. This is the
one place where "retry safely" is not available, and pretending otherwise is how a system sends
the same notification four times.

**Interaction with budgets.** Retries count against the run's and the work item's loop and cost
budgets. A dispatch that fails repeatedly exhausts its budget and blocks rather than looping.

## 7.4 Source drift

Requirements change while work proceeds, and a frozen scope is what makes a run auditable. The
two are reconciled by disclosure rather than by chasing.

At `COMPLETION`, the kernel re-executes the `IntakeRecord`'s `source_locator` and compares the
content hash against the one recorded at admission. This is the existing `ticket`/`document`
comparator ([AGENT_HANDOFF_CONTRACT.md](AGENT_HANDOFF_CONTRACT.md)), applied to the intake
itself.

- **Unchanged** — nothing to say.
- **Changed** — a `source_drift` event, and the completion report states plainly that the
  source has been edited since admission, with the diff. The verdict is computed against the
  admitted work item, because that is what was actually done, and the reader is told the
  request has moved.
- **Unreachable** — recorded as `UNAVAILABLE`. Not a blocker: the work is finished either way.

AgentOS does not silently widen scope to chase an edited ticket — the adapters would refuse the
paths, and `SCOPE_EXPANSION` exists for legitimate growth. What it must not do is report
completion against a request that has changed without saying so, which is how a technically
correct run becomes a misleading one.

## 8. Observability projections

- `run.json` — the live answer to "what is AgentOS doing right now": work item, stage, agent,
  model, elapsed, what it awaits, pending authorizations, loop counters, budget consumed, and
  the frozen graph with `COMPLETED_PRIOR` stages marked.
- `work-item.json` — the answer to "where does this piece of work stand", across attempts:
  lifecycle, every run and its outcome, children and their states, links.
- **Run narrative** — generated from the event log: how the work was resolved and on what
  evidence, what reality was found, which template was selected and why, what was skipped as
  already done, then what was discovered, decided, built, failed, reworked, authorized and
  completed, in order, with evidence links.

The narrative gains one obligation in v0.3: **it must state what AgentOS decided the work
was, and why.** A run that did the wrong thing correctly is the new failure mode this layer
introduces, and it is invisible unless resolution is narrated alongside execution.

Both projections must be readable without AgentOS running. A run whose story is not
reconstructible from its own log is a kernel defect.
