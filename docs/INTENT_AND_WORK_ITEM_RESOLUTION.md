# Intent and Work Item Resolution

How arbitrary input becomes something AgentOS can safely execute.

v0.2 assumed the run began with a **goal**: a sentence an operator typed, taken at face
value as the thing to do. That assumption is the last place in the architecture where a
model's reading of free text became authoritative without a check. It also made the product
wrong: real work does not arrive as a well-formed goal. It arrives as a ticket key, a PR
link, a complaint, a webhook, a half-finished Epic, or a sentence with a typo in it.

This document defines the layer above the kernel's execution machinery: **what is this
work, what state is it actually in, and what outcome is being pursued** — answered before
any workflow is chosen, from evidence rather than from the wording of the request.

The v0.2 boundary is unchanged and this layer sits on top of it. The Orchestrator Agent
still proposes and the kernel still disposes. Nothing here gives any agent a way to mutate
state, invoke another agent, or enter a stage the kernel did not admit.

---

## 1. The pipeline

```
ANY SOURCE
    |
    v
[ INTAKE ]              adapter-normalized IntakeRecord         kernel + adapters
    |
    v
[ RESOLUTION ]          proposed -> admitted Work Item          agent proposes, kernel admits
    |
    v
[ CURRENT REALITY ]     what actually exists, from adapters     adapters only
    |
    v
[ UNDERSTOOD ]          sufficiency verdict                     kernel, computed
    |
    v
[ WORKFLOW SELECTION ]  template + parameterization             agent proposes, kernel admits
    |
    v
[ WORKFLOW RUN ]        the state machine of v0.2, generalized  kernel
```

Five things are worth stating before the detail, because they are what stop this layer from
becoming the place where a model quietly regains control:

1. **The input is not the workflow.** A sentence is an observation about what someone wants,
   not an instruction to the kernel.
2. **Current Reality is never inferred from the input.** It is established through adapters,
   or it is `UNKNOWN`.
3. **`UNDERSTOOD` is computed by the kernel, not declared by an agent.**
4. **Workflows are selected from policy-defined templates, never authored by an agent.**
5. **Intake content is data, never instruction.** Section 9.

---

## 2. Intake

### 2.1 Sources, and why there is no per-source architecture

Every supported source normalizes into one `IntakeRecord`. There is no natural-language
subsystem, no Jira subsystem and no PR subsystem — there is one record shape and a set of
adapters that produce it.

- natural-language prompt, CLI invocation — **host adapter** (operator interface)
- Epic, Feature, Story, Defect, Task, Incident, Change Request, ticket, issue — **project-management adapter**
- document, decision record, spec — **project-management adapter**
- PR, PR review, PR comment, branch, commit — **git adapter**
- API event, webhook, scheduled event — **host adapter**
- runtime alert, log pattern — **runtime adapter**

No new directory and no new adapter. Event and webhook intake belongs to the host adapter
because that adapter already owns *how AgentOS is invoked and by what*; a separate `intake/`
directory would be one file deep and would need its own copy of the availability, confidence
and redaction contracts adapters already carry.

The consequence that matters: **an unavailable source is `UNAVAILABLE`, never absent.** A
Jira server that fails to connect and an organisation with no Jira lead to different
decisions, and the adapter availability model already draws that distinction.

### 2.2 The IntakeRecord

```json
{
  "intake_id": "in_0091",
  "received_at": "2026-09-04T09:31:00Z",
  "source": "PROJECT_MANAGEMENT",
  "source_locator": {
    "adapter": "pm.jira", "op": "read_issue", "args": { "key": "EPIC-336" }
  },
  "principal": { "id": "psingh@example.com", "asserted_by": "host.cli" },
  "trust_class": "OPERATOR",
  "raw": "...verbatim content, redacted for secrets, never edited...",
  "content_hash": "c2e51920560a320759f0b9c755b15080ffccb5c161390d883699fa8cd9da0a02",
  "attachments": [],
  "correlation": { "prior_work_item": null, "prior_run": null }
}
```

`source` is one of `NATURAL_LANGUAGE` · `PROJECT_MANAGEMENT` · `VCS` · `DOCUMENT` · `EVENT` ·
`SCHEDULE` · `RUNTIME_ALERT`.

Three fields do real work:

- **`source_locator`** is a re-executable read. The intake is itself evidence, subject to the
  same replay the kernel applies to everything else. "The ticket said X" becomes checkable.
- **`principal` and `trust_class`** are set by the host from authenticated context, never
  from the content. Section 9.
- **`raw` is verbatim.** No agent summarizes intake before it is recorded. A summary that
  drops the discriminating clause is exactly how a resolution goes wrong invisibly.
- **`content_hash`** is the SHA-256 of `raw` at admission, and is what makes the source-drift
  check at `COMPLETION` a comparison rather than a re-reading
  ([WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) section 7.4). The check was
  specified against a hash the record did not carry (amendment A-5).

---

## 3. Resolution

### 3.1 Who does it

Resolution is a judgment — it means reading a ticket, a repository and a PR and deciding what
they collectively mean. It therefore belongs to an agent. It needs adapter access, so it
cannot belong to the Orchestrator Agent, which deliberately has none.

**It is a mandate of Context Discovery, not a ninth role.** Resolution is what Context
Discovery already does — run probes, classify every assertion, reconcile intent against code
against runtime — applied to the *task* rather than to a capability. The role's existing hard
limits are exactly the ones resolution needs: never mutate anything, never fill a gap with a
plausible value, never judge quality.

The dispatch differs from an ordinary discovery dispatch in three ways: it runs against
**tier-1 orientation discovery only** (identity, stack, structure, git state, PM access), its
`required_outputs` are the resolution fields below, and it runs **before any workflow
exists**. See [AGENT_ROLES.md](AGENT_ROLES.md) role 2.

This also settles something v0.2 left vague: *how does tiered discovery know what is
goal-relevant?* It does not, until resolution has produced a Work Item with a scope.
Resolution runs on tier 1; tier-2 depth is bought against the resolved scope.

### 3.2 What resolution produces

A **proposed Work Item**. Every field is an `Assertion` with a confidence class and evidence
([CONTEXT_MODEL.md](CONTEXT_MODEL.md) section 2) — including the type.

```json
{
  "proposed_work_item": {
    "source_intake": "in_0091",
    "intent": {
      "value": "RESOLVE_DEFECT", "confidence": "INFERENCE",
      "derived_from": ["A-11", "A-12"],
      "reasoning": "the ticket describes incorrect behaviour of an existing capability",
      "observed_at": "2026-09-04T09:33:00Z", "probe": "resolution", "freshness": "CURRENT"
    },
    "type": {
      "value": "DEFECT", "confidence": "INFERENCE", "derived_from": ["A-11"],
      "reasoning": "cap.namespace-restore exists and is reported to misbehave",
      "observed_at": "2026-09-04T09:33:00Z", "probe": "resolution", "freshness": "CURRENT"
    },
    "external_identity": {
      "value": "jira:DEF-456", "confidence": "FACT", "evidence": ["E-01"],
      "observed_at": "2026-09-04T09:32:00Z", "probe": "pm.jira", "freshness": "CURRENT"
    },
    "title": {
      "value": "BSESN namespace not restored after restart", "confidence": "FACT",
      "evidence": ["E-01"],
      "observed_at": "2026-09-04T09:32:00Z", "probe": "pm.jira", "freshness": "CURRENT"
    },
    "desired_outcome": {
      "value": "BSESN namespace present and correct after a service restart, shown on a real restart",
      "confidence": "INFERENCE", "derived_from": ["A-11", "A-13"],
      "reasoning": "the ticket states the symptom; the outcome names the observation that settles it",
      "observed_at": "2026-09-04T09:33:00Z", "probe": "resolution", "freshness": "CURRENT"
    },
    "scope": {
      "paths": ["src/namespace/**"],
      "capabilities": ["cap.namespace-restore"],
      "repositories": ["marksy"],
      "confidence": "INFERENCE"
    },
    "constraints": [],
    "dependencies": [],
    "parent": {
      "value": "jira:EPIC-336", "confidence": "FACT", "evidence": ["E-02"],
      "observed_at": "2026-09-04T09:32:00Z", "probe": "pm.jira", "freshness": "CURRENT"
    },
    "resolution_confidence": 0.82,
    "alternatives": [
      { "type": "INVESTIGATION",
        "reading": "nothing is broken; the reporter misread the namespace listing",
        "why_rejected": "reproduction steps are present and specific",
        "would_do": "audit and root cause, then report without changing anything" }
    ]
  }
}
```

Every field is the full `Assertion` of [CONTEXT_MODEL.md](CONTEXT_MODEL.md) section 2 —
`observed_at`, `probe` and `freshness` included, and `reasoning` on every `INFERENCE`. Earlier
drafts of this example abbreviated them, which made it the one worked example in the frozen
set that its own schema could not express (amendment A-5). `probe` names the probe or the
dispatch that produced the assertion, so an agent-authored inference still says where it came
from.

`alternatives[]` carries `reading` and `would_do` alongside `why_rejected`, because section 7
rung 4 and scenario I both ask a human to discriminate between readings and state what AgentOS
would do under each. `why_rejected` alone cannot be turned into that question.

`resolution_confidence` is the agent's own number and is treated as such: recorded, never the
reason anything is believed, and consulted by the kernel only at the threshold in section 7.

### 3.3 Work Item Type

```
EPIC            a coordinating parent; its outcome is achieved through children
FEATURE         a capability that does not exist yet
STORY           a bounded slice of a feature, independently completable
DEFECT          an existing capability behaves incorrectly
TASK            bounded work making no capability claim (chore, config, docs, cleanup)
INCIDENT        production is wrong right now; containment precedes correctness
INVESTIGATION   the deliverable is understanding; change is not assumed
CHANGE_REQUEST  a proposed change already exists and the outcome is that it lands
UNKNOWN         resolution did not establish a type
```

**`PR` and `REVIEW` are deliberately not types.** A pull request is an *Artifact* and a
*Source*; a review is *Evidence*. Admitting either as a Work Item Type would collapse the
type/stage distinction that the whole workflow model exists to protect — the point of "take
care of this PR" is that the PR is the current *state* of some work, not the work itself.
"Take care of this PR" resolves to whichever Work Item the PR serves; where no such item
exists, the PR itself is a `CHANGE_REQUEST` whose desired outcome is that the change lands,
with the PR as its external identity.

**Type is not a DoD profile.** Type says what kind of *work* this is; a
[DoD profile](DEFINITION_OF_DONE.md) says what kind of *thing* is being completed
(`data-capability`, `service-capability`, `fix`, `audit`, …). A `DEFECT` against a data
pipeline is the `fix` profile evaluated inside a `data-capability`. They are chosen
independently and by different components: type at resolution, profile by the Architect per
work unit.

### 3.4 Admission — what the kernel checks

The proposal is a claim. The kernel admits it only after checks it performs itself:

1. **Schema and confidence discipline.** Every field is an assertion; every `FACT` carries
   evidence; the evidence replays ([AGENT_HANDOFF_CONTRACT.md](AGENT_HANDOFF_CONTRACT.md)).
2. **External identity is verified, not accepted.** A claimed `jira:DEF-456` is fetched
   through the PM adapter.

   Where the intake **named** an external item and it cannot be resolved, the run
   **blocks** with `EXTERNAL_DEPENDENCY`. It does not degrade to investigating the repository
   instead: the work is definitionally that external item, and investigating something else is
   not a weaker version of it, it is a different task. The two cases are distinguished by
   whether the source is unreachable (`UNAVAILABLE` — block, resume when it returns) or
   reachable and the item does not exist (`INSUFFICIENT_EVIDENCE` — the key is wrong, and a
   human should hear that rather than watch AgentOS work on a guess).

   Where the intake named none, an unresolved identity is simply `NOT_APPLICABLE` and
   resolution proceeds on content.
3. **Identity and deduplication.** Section 4.1.
4. **Type is admissible for the evidence.** `policies/work-items.json` states, per type, the
   minimum evidence class required to assert it. `INCIDENT` requires a runtime or production
   observation, not a phrasing — nobody declares an incident by writing the word. `EPIC`
   requires either an external item typed as one, or child items. A type asserted without its
   minimum evidence is admitted as `UNKNOWN`, and the claimed type is recorded.
5. **Scope is typed and bounded.** `scope.paths` must resolve inside the target repositories;
   a scope of `**` is refused. Scope becomes the `mandate.in_scope` adapters enforce, so an
   over-wide scope is an over-wide grant of reach.
6. **Desired outcome is bindable.** It must map to at least one DoD profile whose criteria are
   checkable with the access this run has. An outcome nothing can ever demonstrate is not an
   outcome; it is a wish, and it is rejected with that stated.

A rejected proposal is re-dispatched once with the failure named, then escalates per section
7. It is never repaired by the kernel — repairing a resolution would require judgment, which
is the thing the kernel does not have.

---

## 4. The Work Item

The durable representation of what AgentOS is trying to accomplish. It outlives every attempt
to accomplish it.

```
state/work-items/<work-item-id>/
  work-item.json      identity, type, desired outcome, scope, links, lifecycle
  events.ndjson       work-item-level log — the source of truth at this layer
  runs/<run-id>/      one directory per Workflow Run, exactly the v0.2 run store
```

`state/runs/` from v0.2 becomes `state/work-items/<id>/runs/`. The run store's internals are
unchanged — `run.json`, `events.ndjson`, `context/`, `capabilities/`, `envelopes/`,
`decisions/`, `authorizations/`, `artifacts/`. What changes is that a run is now subordinate
to something durable.

### 4.1 Identity

- **With an external identity**, the work item id derives from it: `wi_jira_DEF-456`,
  `wi_github_marksy_pr_412`. Stable across runs, machines and months.
- **Without one**, the id is content-derived from the normalized intake, and the kernel runs
  a similarity check against open work items in the same scope. A candidate match is
  **surfaced, never auto-merged**: merging two work items is a judgment, and a wrong merge
  destroys history. The operator confirms, or two items exist and one is later linked
  `DUPLICATE_OF`.

**One active Workflow Run per Work Item.** The work item record holds a lease. A second
attempt to start a run against a leased item is refused with the active run named; takeover
requires the existing run to reach a terminal state, or an explicit operator takeover recorded
as an event. This is what makes "someone ran it twice" a refusal instead of two PRs.

### 4.2 Lifecycle

```
RESOLVED -> UNDERSTOOD -> EXECUTING -+-> ACHIEVED
                              |      +-> ABANDONED    (human decision, recorded)
                              |      +-> SUPERSEDED   (another item achieves the outcome)
                              +-> BLOCKED (resumable)
```

Distinct from the Workflow Run's own state machine, and distinct on purpose: a run can fail
without the work item failing, which is the entire reason the two are separate.

### 4.3 Relationship to the Capability

A Work Item is *what is being attempted*; a Capability is *what the system can do*. A work
item names the capabilities it touches in `scope.capabilities`; completion is judged per
capability, unchanged from [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md). A `TASK` may touch
no capability at all, which is why the `documentation` and `internal-capability` profiles
exist.

---

## 5. Current Reality

Where the work actually is, established from authoritative sources rather than from the
request. This is the input that makes resumption possible and re-execution avoidable.

### 5.1 Authority, in order

Each source is authoritative about its own subject and about nothing else. Stating this
precisely is what makes the contradictions in 5.3 resolvable by rule.

- **what the repository contains** — git adapter: commits, branches, worktrees, diffs
- **whether a change is proposed** — git adapter: PR existence, head SHA, mergeability
- **what reviewers said** — git adapter: review threads, states, resolution flags
- **whether it builds and tests pass** — CI via git/host adapter, or local execution
- **what runs in an environment** — runtime adapter
- **what someone intended, and the ticket's own status** — PM adapter
- **what AgentOS previously did** — the AgentOS event log

Note two asymmetries. A ticket's status field is authoritative about *the ticket* and is at
most an `INFERENCE` about the system — the v0.2 rule, unchanged, and the reason "Story marked
Done" never short-circuits anything. And the AgentOS event log is authoritative about
AgentOS's own actions and nothing external: it records that a PR was opened, not that the PR
is still open.

### 5.2 The reality set

Discovered into the Context Package as `current_reality`, one assertion per element:

```
implementation_present   is there a branch or commit implementing this scope
tests_present            do tests covering the scope exist, and did they run
pr                       exists, state, head SHA, mergeability, target branch
ci                       last result for the PR head, and its age
reviews                  reviewers, states, unresolved threads, thread subjects
merge_state              merged, mergeable, conflicted, blocked by policy
deployment               is the change in any environment
outcome_evidence         does the desired outcome already hold, observably
children                 for an EPIC: child items and their lifecycle states
agentos_history          prior runs against this work item and their outcomes
```

Every element is `FACT`, `INFERENCE` or `UNKNOWN` with a reason from
[DATA_SEMANTICS.md](DATA_SEMANTICS.md). An unreachable GitHub makes `pr` `UNAVAILABLE`; it
does not make it "no PR". That distinction is the whole point of the section.

### 5.3 Contradiction between sources

Reality assembly is the three-way reconciliation of [CONTEXT_MODEL.md](CONTEXT_MODEL.md)
section 5 applied to a work item, using the same enum. No new vocabulary:

- Jira says `Done`, no merged commit exists → `CLAIMED_DONE_UNPROVEN`
- the AgentOS log records a PR opened, GitHub shows none → `CONFLICTING`
- GitHub unreachable → `INDETERMINATE`, not "no PR"

`CONFLICTING` between AgentOS's log and an external system routes to arbitration
([AGENTOS_ARCHITECTURE.md](AGENTOS_ARCHITECTURE.md) section 6) with the authority list above
applied first as the rule-based step: the external system wins on its own state, and the
discrepancy is itself recorded as a finding — "AgentOS believes it opened a PR that does not
exist" is worth knowing regardless of which action follows.

### 5.4 The rule that makes reality load-bearing

> **Current Reality is established from adapters or it is `UNKNOWN`. It is never inferred
> from the intake, from a ticket's status field, or from a model's account of what happened
> last time.**

An agent's claim about reality is recorded as a `claim` and ignored, exactly as a branch
predicate claim is ([WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) section 4.3).

---

## 6. UNDERSTOOD

`UNDERSTOOD` replaces v0.2's `CONTEXT_READY`. Same idea — enough is known to proceed — with a
definition that can be evaluated rather than felt, and no agent supplies it.

The definition worth having is not a list of questions that feel answered. It is this:

> **Understanding is sufficient exactly when the workflow decision is determinate.**

Five conditions, all kernel-computable:

1. **Type is not `UNKNOWN`**, or the `investigation` template applies — which is what
   `UNKNOWN` routes to.
2. **`desired_outcome` binds to at least one DoD profile** whose criteria are checkable with
   the access this run has.
3. **Every predicate referenced by the entry edges of every candidate template evaluates
   `TRUE` or `FALSE`** — not `INDETERMINATE`. This condition does the work: it makes "do we
   know enough?" mean "can we choose without guessing?", and it is decidable by evaluating a
   finite set of named predicates.
4. **Every `UNKNOWN` in the reality set that `blocks` a mandatory stage** is resolved, or has
   a recorded handling.
5. **Resolution confidence meets the policy threshold**, or section 7 has been applied and its
   outcome recorded.

Failing 3 is the common case, and it is informative: it names exactly which predicate is
undetermined, which names exactly which discovery would resolve it. Sufficiency failures are
actionable by construction.

---

## 7. Uncertainty

Intent classification is a model output, and a model output is a claim. The ladder below is
kernel-driven and ordered by cost. Each rung is attempted before the next.

**1 — Proceed.** Type admissible on its evidence, external identity resolved, reality
determinate. The overwhelmingly common case, and it involves no human.

**2 — Discover.** Confidence is short, or a predicate is `INDETERMINATE`, and something
nameable would settle it — the `recoverable_by` field of the `UNKNOWN` says what. The kernel
dispatches that probe and re-resolves. Bounded by the discovery loop budget, so this cannot
spin.

**3 — Proceed along the common safe prefix.** Resolution is still ambiguous between candidate
templates, but they share a prefix and every stage in that prefix is non-mutating. Then the
ambiguity does not yet matter: execute the shared prefix and re-resolve at its exit, when far
more is known.

Mechanically: intersect the candidate templates' stage sequences from the entry node, take the
longest common prefix, and admit it only if every stage in it is declared non-mutating in the
stage vocabulary. In practice that prefix is `CONTEXT_DISCOVERY → AUDIT` or `… → ROOT_CAUSE`,
which is both the safest and the most informative thing to do under ambiguity. **This is how
AgentOS acts under uncertainty without guessing:** it does the part that is the same whichever
answer is right.

**4 — Ask.** No common prefix, or the divergence is between a mutating and a non-mutating
branch — the case where guessing has consequences. One question, carrying the candidate
readings, the evidence for each, and what AgentOS would do under each. Not a request for a
briefing: the human is asked to discriminate, not to supply context AgentOS could discover,
which would violate principle 1.

**5 — Block.** No answer within the policy window → `BLOCKED` with `AMBIGUOUS_GOAL`. Silence
is never consent, and the run resumes in place when an answer arrives.

**Escalate, at any rung**, where the ambiguity is between "this is routine" and "this is an
incident" — those differ in urgency, not only in workflow, and the safer reading is the one
that reaches a human sooner.

### The safer-branch rule at this layer

v0.2's rule — `INDETERMINATE` takes the branch that does more work — was written for stage
applicability, where the cost of the safer branch is tokens. At this layer that rule is
insufficient and, taken literally, unsafe. "We are not sure whether this was already done",
resolved toward *more work*, means doing it again — and doing it again can mean a second PR, a
second migration, a second notification.

> **Refinement.** `INDETERMINATE` takes the branch that does more **verification** and the
> branch that does less **irreversible mutation**. Where those point the same way, proceed.
> Where they point in opposite directions, the kernel does not choose: it performs additional
> discovery, and if that cannot settle it, it blocks for a human. AgentOS never re-executes a
> non-reversible operation on the strength of an `INDETERMINATE`.

The v0.2 rule is the special case where no irreversible mutation is in play — which is every
stage-applicability predicate it was written for. Nothing in v0.2 changes.

---

## 8. Review feedback

Review comments are the most common way work continues after it looked finished, and the most
tempting place to create spurious work items.

**The default is a loop, not a new item.** Feedback normally routes
`PR_REVIEW → REVIEW_TRIAGE → COMMENT_RESOLUTION → IMPLEMENTATION → VALIDATION → PR_REVIEW`,
inside the same Work Item and the same Workflow Run.

`REVIEW_TRIAGE` is agent judgment — deciding what a comment asks for requires reading it. But
the *consequence* of that judgment is bounded mechanically, because creating a child Work Item
is a state mutation and only the kernel performs one:

> A triage proposal becomes a child Work Item only when the remediation it proposes touches
> paths or capabilities **outside the parent's admitted `scope`**. Scope is a typed field
> fixed at admission, so containment is a set computation, not an opinion.

Three outcomes, and only three:

- **Inside scope** → `COMMENT_RESOLUTION`. Always. "Add a test covering restart recovery" is
  inside the scope of the defect whose fix is restart recovery.
- **Outside scope, separable** → a child Work Item, linked `DISCOVERED_BY`, independently
  executable, resumable, auditable and completable. The parent does not wait for it unless a
  dependency is declared.
- **Outside scope, inseparable** → the change cannot land without it. That is
  `SCOPE_EXPANSION`, an existing gate ([HUMAN_AUTHORIZATION.md](HUMAN_AUTHORIZATION.md)): the
  human either widens the mandate or accepts the split.

**Undeterminable containment counts as inside scope.** The refined safer-branch rule applied:
creating work items multiplies external side effects, so the uncertain branch is the one that
creates none. A comment that turns out to need its own item surfaces again at the next triage,
with more evidence.

**Comment authorship is not authority.** A review comment from a third party is `EXTERNAL`
intake (section 9). It cannot expand scope, cannot request a gate, and cannot on its own cause
a mutating stage to be entered.

**Nor can it stop a run.** A comment saying "stop, don't do this" is triaged like any other
feedback and reaches the loop on the next lap; it does not halt anything. Cancellation
authority is the operator channel, against an identity the host asserts — because a comment
that could cancel a run would let anyone with comment access halt any work, and a halt is as
consequential as a start.

---

## 9. Intake is data, never instruction

v0.2's goals came from an operator at a terminal. v0.3 accepts webhooks, third-party PR
comments and ticket bodies anyone can edit. That is a new attack surface, and it is the most
consequential thing this layer adds.

**Every `IntakeRecord` carries a `trust_class`, set by the host from authenticated context and
never from the content:**

- **`OPERATOR`** — a human acting through the interface, with an identity the host asserts.
- **`INTERNAL`** — an authenticated system inside the organisation's boundary: its own CI, its
  own Jira, its own scheduler.
- **`EXTERNAL`** — everything else. A public PR comment, an unauthenticated webhook, a ticket
  a customer can edit.

Rules, in force for all three classes:

1. **Intake content cannot name a workflow template, request a stage, set a confidence class,
   set a trust class, or widen a scope.** Those are kernel inputs; intake is an observation the
   resolver reasons over. Content that appears to instruct AgentOS is recorded verbatim and
   treated as text — the resolver may weigh it as evidence of what someone wants, exactly as it
   weighs the rest of the ticket.
2. **No grant ever originates from intake.** Authorization comes from a human through the
   authorization channel, against a request the kernel recorded. Text saying "approved" is
   text.
3. **`EXTERNAL` intake cannot autonomously reach a mutating stage.** A new gate,
   **`AUTONOMOUS_INTAKE_EXECUTION`**, fires once per Work Item at first entry to any mutating
   stage when the originating trust class is `EXTERNAL`. Policy may pre-grant it per configured
   source, so a trusted webhook stays autonomous and an unconfigured one does not. Read-only
   work — resolution, discovery, audit, investigation — is ungated for every class, which keeps
   the useful autonomy intact.

The gate is deliberately narrow. Every unnecessary gate is a defect, and this one earns its
place by covering the exact case nothing else does: the *work itself* was requested by someone
the organisation has not authenticated.

---

## 10. Epic decomposition

An Epic's workflow **coordinates; it does not implement.** This is enforced structurally rather
than by instruction: the `epic` template's node set contains no `IMPLEMENTATION` stage, so no
proposal can put one there.

```
EPIC-100  (Work Item)
  DECOMPOSITION        Architect proposes children; kernel admits and creates them
  CHILD_COORDINATION   each child is its own Work Item with its own runs
  COMPLETION           Epic DoD over the Epic's own desired outcome
```

**Decomposition is the Architect's mandate**, not a new capability: it already owns "an ordered
plan of work units each with an applicable DoD profile". A child Work Item is a work unit that
earned its own identity — because it is independently completable, and that is the test the
Architect applies.

Each child is created by the kernel with its own id, scope, desired outcome and lifecycle,
linked `CHILD_OF`. Each is independently executable, resumable, auditable and completable.
Children may declare dependencies on siblings; the kernel enforces ordering from the declared
edges and refuses a cycle.

**Breadth and depth are capped.** `budgets.decomposition` bounds children per Epic (default 12)
and nesting depth (default 2). Exceeding either is not a silent truncation and not a refusal —
it is `BLOCKED` with the proposed decomposition attached, for a human to confirm or narrow.
Each child carries its own run and its own budget, so an unbounded decomposition is an
unbounded cost commitment, and committing to one is a decision rather than a side effect of a
model's enthusiasm.

**Discovery before creation.** Where the Epic has an external identity, existing children are
read from the PM adapter before any are proposed. An admitted child whose external identity
already exists is *linked*, never recreated — which is what stops a resumed Epic from
duplicating its own backlog.

**Child failure does not fail the Epic.** A blocked child leaves its siblings running; the Epic
blocks only when no child can progress. **Child cancellation is a decision**: the Orchestrator
may propose `SUPERSEDED` or `ABANDONED`, and the kernel admits it only if
`reality.outcome_already_satisfied` evaluates `TRUE` from adapter evidence. Otherwise it
escalates to a human, because "this turned out to be unnecessary" is exactly the claim that
should not be self-certified.

**Epic completion is not child completion.** All children terminal is necessary and not
sufficient: the Epic's own desired outcome is evaluated against its own DoD profile. An Epic
whose children all completed but whose outcome has no supporting evidence is
`COMPLETE_WITH_GAPS` at best, and the gap is named. That is the `CLAIMED_DONE_UNPROVEN` pattern
applied to AgentOS's own work — the least comfortable and most necessary place to apply it.

---

## 11. What is authoritative, in one table

The question to ask of any step in this layer is *who decides, and can they be wrong without
consequence.*

| Step | Proposes | Decides | Authoritative artifact |
|---|---|---|---|
| Intake | adapter observation | kernel records | `IntakeRecord`, verbatim |
| Resolution | Context Discovery | kernel admits | admitted Work Item |
| Type | Context Discovery | kernel, against evidence minimums | `work-item.json` |
| Current Reality | nobody — it is observed | adapters | Context Package `current_reality` |
| Understanding | nobody | kernel computes | `UNDERSTOOD` verdict |
| Workflow | Orchestrator Agent | kernel admits from templates | frozen run graph |
| Stage transition | agent `next_action` | kernel evaluates predicate | event log |
| Decomposition | Architect | kernel creates children | child work items |
| Triage | Orchestrator Agent | kernel, by scope containment | resolution or child item |
| Cancellation | Orchestrator Agent | kernel, on adapter evidence, else human | work item lifecycle |
| Completion | agents supply criterion verdicts | kernel does the arithmetic | DoD report |

Every entry in the "Proposes" column can be wrong, adversarial or hallucinating without
corrupting state. That is the property v0.2 established for execution, extended to intake and
planning.

---

## 12. Worked scenarios

Nine, chosen because each stresses a different joint. The notation is uniform: `INTAKE →
INTENT → WORK ITEM → REALITY → WORKFLOW → ENTRY`, followed by what is authoritative at the
step that matters.

### A — "Fix typo in README."

```
INTAKE      NATURAL_LANGUAGE, trust OPERATOR
INTENT      MODIFY_ARTIFACT
WORK ITEM   TASK, no external identity, scope { paths: ["README.md"] }
            desired outcome: the misspelling is corrected
            type evidence: the named path exists and is documentation -> admissible
REALITY     implementation_present FALSE, pr UNAVAILABLE (no PR for this scope), ci N/A
WORKFLOW    task.direct
ENTRY       IMPLEMENTATION
```

`AUDIT` and `ARCHITECTURE` are absent from `task.direct` — not skipped by an agent's
judgment, simply not in the graph. The floor still requires `VALIDATION` after
`IMPLEMENTATION`, so the change is verified even though "verify a typo fix" sounds absurd:
verification here is cheap and catches the case where the model edited the wrong file.
`MERGE` requires `AUTHORIZATION` because merging into a protected branch is gated regardless
of triviality — the gate is on blast radius, not on importance.

**What this scenario tests:** that the cheap path is genuinely cheap, and that cheapness is
achieved by template selection rather than by relaxing anything.

### B — "Users are getting logged out after five minutes."

```
INTAKE      NATURAL_LANGUAGE, trust OPERATOR
INTENT      RESOLVE_DEFECT        confidence INFERENCE
WORK ITEM   DEFECT
            type evidence: the statement describes incorrect behaviour of an existing
              capability, and cap.session-management exists in the registry -> admissible
            desired outcome: sessions persist for their configured lifetime, shown by a
              session surviving past five minutes in a running environment
            scope: INFERENCE, derived from cap.session-management's chain
REALITY     outcome_already_satisfied FALSE (reproduced), implementation_present FALSE
WORKFLOW    defect.standard
ENTRY       AUDIT
```

Two things are worth noting. **This is not admitted as an `INCIDENT`** despite sounding
urgent: `INCIDENT` requires a runtime or production observation, and a user report is not
one. If the runtime probe then observes elevated session-expiry errors in production, the
kernel records a re-resolution and the type is upgraded — with evidence, as an event, not by
rephrasing.

And **`ROOT_CAUSE` is mandatory** in `defect.standard`. "Sessions expire after five minutes"
has at least four plausible causes (a token TTL, a cookie lifetime, a load-balancer idle
timeout, a clock skew) and no route to a correct fix that does not distinguish them. A
template that allowed `AUDIT → IMPLEMENTATION` would be a template that permits symptom
patching, which principle 9 forbids.

### C — "Work on STORY-123."

```
INTAKE      PROJECT_MANAGEMENT, trust OPERATOR
            source_locator: pm.jira read_issue STORY-123      (re-executable)
INTENT      ADVANCE_EXISTING_WORK
WORK ITEM   STORY, external identity jira:STORY-123 (FACT, fetched by the kernel)
            id wi_jira_STORY-123 -> deduplicates against any prior run
REALITY     branch feature/STORY-123 exists, 4 commits, tests present, CI green,
            pr OPEN, reviews none requested, merge_state MERGEABLE
WORKFLOW    story.standard
ENTRY       PR_REVIEW
```

The entry stage is the whole point. `AUDIT`, `PLAN`, `IMPLEMENTATION`, `VALIDATION` and
`PR_PREPARATION` are marked `COMPLETED_PRIOR` because **git and the PR host say so** — not
because the ticket's status field says `In Review`, which is authoritative only about the
ticket.

And they are not thereby forgiven. Those stages supplied no per-criterion verdicts, so at
`COMPLETION` the DoD computes `INCOMPLETE` and routes back to `VALIDATION` — which then
executes against the existing branch and either confirms the work or finds what the previous
attempt missed. **Resumption avoids redoing the mutation; it does not avoid the judgment.**

### D — "Take care of DEFECT-456." (PR open, three review comments)

```
INTAKE      NATURAL_LANGUAGE naming an external key, trust OPERATOR
WORK ITEM   DEFECT, external identity jira:DEF-456
REALITY     pr OPEN #412 head 4de0117, ci GREEN for 4de0117,
            reviews: 1 CHANGES_REQUESTED, 3 unresolved threads,
            merge_state BLOCKED_BY_REVIEW
WORKFLOW    defect.standard
ENTRY       REVIEW_TRIAGE
```

Then triage, per section 8:

```
thread rt_1  "Add a test covering restart recovery."
             remediation scope tests/namespace/**  -> INSIDE work item scope
             -> COMMENT_RESOLUTION

thread rt_2  "This variable name is misleading."
             remediation scope src/namespace/store.ts -> INSIDE
             -> COMMENT_RESOLUTION

thread rt_3  "While you are here, the audit-log writer has the same bug."
             remediation scope src/audit/** -> OUTSIDE work item scope, separable
             -> child Work Item, linked DISCOVERED_BY; parent does not wait
```

`rt_3` is the case the model exists for. It is a real finding, it is genuinely different
work, and folding it into this PR would silently widen the change a reviewer already
approved in scope. It becomes a child item — and had it been *inseparable* (the same
function, no way to fix one without the other), it would have been `SCOPE_EXPANSION` with a
human deciding whether to widen the mandate or split the PR.

The loop then runs `COMMENT_RESOLUTION → IMPLEMENTATION → VALIDATION → PR_REVIEW`, bounded
at five iterations. **No new Defect or Story was created for `rt_1` or `rt_2`.**

### E — "Add GitHub issue synchronization."

```
INTAKE      NATURAL_LANGUAGE, trust OPERATOR
INTENT      ADD_CAPABILITY
WORK ITEM   FEATURE
            type evidence: no capability record intersects the described behaviour, and
              no code implements it -> admissible as FEATURE, not DEFECT
            desired outcome: issues in the configured GitHub repository appear as work
              items in AgentOS within the configured interval, demonstrated end to end
              with a real issue
            scope: adapters/, contracts/, and cap.issue-sync (new)
REALITY     everything FALSE or NOT_APPLICABLE — genuinely new work
WORKFLOW    feature.standard   (ARCHITECTURE mandatory)
ENTRY       AUDIT
```

`ARCHITECTURE` is mandatory here and it is the floor that makes it so, not the Orchestrator's
preference: the scope touches a declared contract boundary (a new adapter surface and a new
contract), so `architecture.required` evaluates `TRUE` and the stage cannot be excluded.

The `desired_outcome` deserves attention because it is where a feature request usually goes
wrong. "Add GitHub issue synchronization" binds to nothing checkable. The admitted outcome
names an observation — a real issue appearing as a work item — which is what lets DoD
criterion 13 mean something. An outcome the admission step cannot bind to a checkable
profile is rejected as a wish (section 3.4, rule 6).

### F — "Implement autonomous repository synchronization." (Epic)

```
INTAKE      NATURAL_LANGUAGE, trust OPERATOR
WORK ITEM   EPIC
            type evidence: the described outcome spans multiple capabilities, none of
              which is independently the outcome -> admissible
            desired outcome: repositories stay synchronized without human action,
              demonstrated by an unattended cycle completing correctly
REALITY     children NONE (no external Epic to read children from)
WORKFLOW    epic.coordinate         (contains no IMPLEMENTATION stage)
ENTRY       DECOMPOSITION
```

The Architect proposes children; the kernel creates them:

```
wi_...epic-repo-sync   EPIC
  +-- STORY   detect remote changes                    (no dependencies)
  +-- STORY   reconcile local and remote state         (depends on: detect)
  +-- STORY   schedule and trigger cycles              (no dependencies)
  +-- TASK    operational visibility for a cycle       (depends on: schedule)
```

Each child is its own Work Item: its own id, scope, desired outcome, lifecycle, runs and DoD.
Each is independently executable, resumable, auditable and completable. The Epic's own graph
contains three stages and never touches code.

**Why the Epic cannot become one pipeline:** `epic.coordinate` has no `IMPLEMENTATION` node,
and the floor forbids adding one for type `EPIC`. An Orchestrator that would prefer a single
linear run has no expressible way to ask for it.

**Epic completion:** all four children terminal permits `COMPLETION`; the Epic's own outcome
is then judged separately. If the four shipped but nobody can demonstrate an unattended
cycle, the verdict is `COMPLETE_WITH_GAPS` with the gap named — `CLAIMED_DONE_UNPROVEN`
applied to AgentOS's own output.

### G — Partially completed Epic

Same Epic, resumed three weeks later. Now it has an external identity.

```
REALITY     children read from the PM adapter before anything is proposed:
              jira:STORY-201  detect remote changes      -> ACHIEVED   (merged, evidenced)
              jira:STORY-202  reconcile state            -> EXECUTING  (PR open, in review)
              jira:STORY-203  schedule cycles            -> BLOCKED    (awaiting a grant)
              jira:TASK-204   operational visibility     -> not started
WORKFLOW    epic.coordinate
ENTRY       CHILD_COORDINATION
```

Nothing is recreated. `DECOMPOSITION` is `COMPLETED_PRIOR` because children exist; each
child that already has an external identity is **linked, not recreated**, which is the rule
that stops a resumed Epic from duplicating its own backlog.

Each child then resumes independently, by its own entry computation:

- `STORY-201` — `outcome_already_satisfied TRUE`; the kernel admits a `COMPLETION`-only
  parameterization, evaluates the DoD against existing evidence, and stops. No
  re-implementation.
- `STORY-202` — enters at `REVIEW_TRIAGE`, exactly as scenario D.
- `STORY-203` — still `BLOCKED`; the recorded denial is at the *work item* level, so
  starting a fresh run is not a way to re-ask. It waits.
- `TASK-204` — its dependency (`STORY-203`) is not terminal, so the kernel does not start it.

**A blocked child does not block its siblings.** The Epic itself blocks only when no child
can progress.

### H — Work already complete

"Fix the BSESN namespace restoration bug" — submitted again, a week after it was fixed.

```
WORK ITEM   DEFECT, external identity jira:DEF-456
            id wi_jira_DEF-456 -> matches an existing work item, lifecycle ACHIEVED
REALITY     pr MERGED #412, ci GREEN, deployment PRESENT in production,
            outcome_already_satisfied TRUE
              evidence: runtime probe, post-restart namespace read, observed_at now
WORKFLOW    investigation.readonly, COMPLETION-only parameterization
ENTRY       COMPLETION
```

The DoD runs against existing evidence and the outcome is recorded. Nothing is
re-implemented, no branch is created, no second PR is opened.

Three ways this could have gone wrong, and what stops each:

- **Trusting the ticket.** Had Jira said `Done` with no runtime evidence, this would be
  `CLAIMED_DONE_UNPROVEN`, not `ACHIEVED`, and the run would proceed to establish or refute
  it. That finding is the most valuable output AgentOS produces and treating it as "already
  done" would discard exactly the thing worth having.
- **Trusting the prior run.** AgentOS's own log recording a successful run is authoritative
  about what AgentOS did, not about whether it still holds. `outcome_already_satisfied` is
  evaluated fresh, from the runtime.
- **Guessing under uncertainty.** Had the runtime been unreachable,
  `outcome_already_satisfied` would be `INDETERMINATE`. Re-implementing is both more work and
  more irreversible mutation, so the refined safer-branch rule forbids proceeding: the kernel
  discovers, and failing that blocks with `AMBIGUOUS_STATE`.

### I — Ambiguous request

"The pricing looks wrong."

```
INTAKE      NATURAL_LANGUAGE, trust OPERATOR
RESOLUTION  candidate readings, all INFERENCE, none dominant:
              DEFECT         the calculation is incorrect
              DEFECT         the calculation is right, the display is wrong
              INVESTIGATION  nothing is wrong; the reporter misread it
              CHANGE_REQUEST the pricing rule itself should change
            resolution_confidence 0.41  -> below threshold
```

The ladder, in order:

**Rung 2 — discover.** The `UNKNOWN` names `recoverable_by: "compare stored price against
recomputed price for a sample of records"`. The kernel dispatches that probe. Result: stored
and recomputed agree. That eliminates reading one and leaves three.

**Rung 3 — the common safe prefix.** The three survivors' templates are `defect.standard`,
`investigation.readonly` and `change_request.land`. Their common prefix from entry is
`AUDIT → ROOT_CAUSE`, and both stages are non-mutating. The kernel admits that prefix and
runs it. **AgentOS proceeds without knowing the answer, because it is doing the part that is
the same whichever answer is right.**

Root cause finds the display layer rounding before formatting. Re-resolution at the prefix
exit now returns `DEFECT` (display) at `FACT` confidence, and the run continues into
`defect.standard`. No human was involved.

**When it would have asked.** Had root cause instead found that the stored price is correct
under the current rule and the reporter simply disagrees with the rule, the surviving
candidates are `INVESTIGATION` (report and stop) and `CHANGE_REQUEST` (change the rule) —
which diverge immediately between a non-mutating and a mutating branch. That is rung 4, and
the question is a discrimination, not a briefing:

> The stored price matches the current rule (evidence: …). Two readings remain: the rule is
> being applied correctly and the report is a misunderstanding, or the rule itself should
> change. Under the first, AgentOS reports and stops. Under the second, it changes the
> pricing rule, which touches `src/pricing/**` and requires a migration. Which?

One question. Both readings. The evidence for each. What AgentOS would do under each. No
answer inside the policy window is `BLOCKED` with `AMBIGUOUS_GOAL` — silence is never
consent — and the run resumes in place when an answer arrives.
