# Agent Handoff Contract

Every agent returns one `HandoffEnvelope`. The envelope is the *only* thing that crosses
the boundary between agents.

Conversation is never the transport. Transcripts are not passed, summarized or replayed.
An agent that only works because it saw what a previous agent said is not a component; it
is a coincidence.

Three properties follow from that, and they are the point of the contract:

- **Replaceable** — any agent can be swapped for another implementation or model.
- **Resumable** — a run can restart from persisted envelopes alone.
- **Auditable** — a human can read the envelopes and reconstruct the reasoning.

## Envelope

```json
{
  "envelope_version": "1.1",
  "work_item_id": "wi_jira_DEF-456",
  "run_id": "run_2026_09_04_a1b2",
  "envelope_id": "env_007",
  "agent": "auditor",
  "agent_version": "1.0",
  "model": "claude-opus-5",
  "skills_used": ["repo-graph", "sql-inspect"],
  "stage_in": "AUDIT",
  "started_at": "2026-09-04T10:14:00Z",
  "completed_at": "2026-09-04T10:41:00Z",
  "cost": { "input_tokens": 412000, "output_tokens": 19000 },

  "status": "COMPLETE",

  "summary": "One paragraph a human can read without opening anything else.",

  "findings": [],
  "evidence": [],
  "assumptions": [],
  "unknowns": [],
  "artifacts_changed": [],
  "recommendations": [],
  "blockers": [],

  "coverage": {
    "scope_examined": "...",
    "scope_not_examined": "...",
    "confidence": "INFERENCE"
  },

  "proposals": {},

  "next_action": {
    "proposed_stage": "ARCHITECTURE",
    "proposed_agent": "architect",
    "rationale": "..."
  }
}
```

`state_in` became `stage_in` and `proposed_state` became `proposed_stage` in envelope
version 1.1, following the vocabulary change in
[WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) section 2.

## Status values

- `COMPLETE` — mandate fulfilled, outputs produced
- `PARTIAL` — some produced; what is missing is enumerated in `unknowns`
- `BLOCKED` — cannot proceed; `blockers` is non-empty and actionable
- `BLOCKED_BY_ARCHITECTURE` — Implementer-specific; an architectural contradiction was hit
- `FAILED` — the agent itself failed (tooling, model, timeout); distinct from `BLOCKED`,
  which is about the work
- `REJECTED` — a reviewing agent rejects the work under review (Validator, Product/UX)

`PARTIAL` is not a soft `COMPLETE`. An agent that produced 80% and calls itself `COMPLETE`
has corrupted every downstream decision.

Each status maps to exactly one kernel action, including which statuses are legal from
which stage and agent. That mapping is defined once, in
[WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) section 4.2. An envelope carrying a
status that is illegal for its stage or role is a contract violation, logged as such and
handled as `BLOCKED` — the kernel never guesses what an agent meant.

## Sections

### findings

```json
{
  "id": "F-014",
  "title": "SME classification never persisted",
  "severity": "CRITICAL",
  "category": "orphan-writer",
  "capability": "cap.ipo-classification",
  "chain_stage": "NORMALIZATION",
  "description": "...",
  "evidence": ["E-031", "E-032"],
  "confidence": "FACT",
  "impact": "...",
  "remediation_hint": "..."
}
```

Severity: `CRITICAL` (capability does not work / data is wrong) · `HIGH` (works
incorrectly under real conditions) · `MEDIUM` (works, with material gaps) · `LOW`
(quality) · `INFO`.

**A finding without evidence is not a finding.** An unproven suspicion is a
`recommendation` of category `hypothesis`, carrying the observation that would confirm it.

### evidence

```json
{
  "id": "E-031",
  "kind": "query",
  "locator": {
    "adapter": "runtime.postgres.staging",
    "op": "read_query",
    "args": { "sql": "select count(*) from classification where sme is not null" }
  },
  "ref": "runtime.postgres.staging :: classification.sme",
  "excerpt": "0",
  "observed_at": "2026-09-04T10:22:00Z",
  "verification": {
    "status": "VERIFIED",
    "at": "2026-09-04T10:23:11Z",
    "by": "kernel",
    "matches": true
  }
}
```

Kinds: `file` · `git` · `command` · `query` · `http` · `log` · `ticket` · `document` ·
`screenshot` · `metric`.

**`locator` is mandatory and must be re-executable by the kernel.** It names an adapter, a
read-only operation on that adapter, and the arguments needed to reproduce the observation.
`ref` and `excerpt` remain for human reading; `locator` is what makes evidence a claim the
system can check rather than a claim it must believe. Evidence whose observation is
genuinely unrepeatable (a log line since rotated, a one-shot runtime state) sets
`locator.op` to `null` and carries `reproducible: false` — which caps the assertion it
supports at `INFERENCE`, never `FACT`.

**`verification` is written only by the kernel.** An envelope arriving with a
`verification` block populated is a contract violation, logged as such and handled as
`BLOCKED`. An agent cannot mark its own evidence verified — that is the entire point of the
field.

Statuses: `VERIFIED` (replayed, result matches), `MISMATCH` (replayed, result differs),
`UNREPLAYABLE` (adapter could not replay it), `UNVERIFIED` (not selected for checking),
`UNVERIFIABLE` (`reproducible: false` by declaration).

### Evidence verification (kernel)

Before an envelope's contents are merged into run state, the kernel replays evidence
through the originating adapter.

**Always verified:**

- every evidence item supporting a `CRITICAL` or `HIGH` finding
- every evidence item cited in an `AuthorizationRequest`
- every evidence item supporting a Definition-of-Done criterion marked `MET`
- every evidence item supporting an assertion the agent classified `FACT` that contradicts
  an existing assertion in run state

**Sampled:** a policy-defined proportion of the remaining `FACT` evidence
(`policies/evidence.json`, default 20%, minimum one item per envelope).

**On `MISMATCH` or `UNREPLAYABLE`:**

1. Every assertion resting on that evidence is downgraded — `MISMATCH` to `UNKNOWN` with
   reason `CONFLICTING`, `UNREPLAYABLE` to `UNKNOWN` with reason `UNAVAILABLE`.
2. Findings that lose their last verified evidence become `recommendations` of category
   `hypothesis`. They do not survive as findings.
3. An `evidence_integrity` event is logged against the producing agent and model.
4. On a policy-defined count of `MISMATCH` results within one envelope (default: two, or
   any single mismatch on evidence backing an authorization request), the **entire envelope
   is rejected** and the dispatch is treated as `FAILED`. One fabrication is a defect; two
   is an untrustworthy witness, and nothing it said should be merged.

Verification cannot itself mutate: `locator.op` must be an operation the adapter declares
`observation_safe` ([REPOSITORY_ADAPTER.md](REPOSITORY_ADAPTER.md) section 2.3) — replayable
without altering authoritative state, without consuming what it measured, and with no effect
beyond its declared incidental artifacts. Test execution and its coverage output qualify; a
destructive queue read does not. An agent cannot use the evidence channel to make the kernel
perform a mutation on its behalf.

**Comparison is mechanical, per kind.** The kernel does not judge whether two observations
"mean the same thing" — that would require a model, and the verifier must be model-free.
Comparators are defined per evidence kind in `policies/evidence.json`:

- `file`, `git`, `query`, `command`, `http` — normalized exact match on the excerpt
  (whitespace and ordering normalization only).
- `log`, `metric` — **predicate match.** The evidence states a predicate the observation
  satisfied (`count == 0`, `error_rate < 0.01`); the kernel re-evaluates the predicate
  rather than comparing a volatile raw value. Evidence of these kinds must carry a
  predicate, not just a number.
- `ticket`, `document` — match on identifier plus content hash, with a changed hash
  reported as `MISMATCH` and the version difference recorded.
- `screenshot` — **not kernel-verifiable.** Pixels are not comparable mechanically.

### Evidence that cannot be content-verified

A screenshot's *content* cannot be checked, but its *provenance* can. Every adapter call is
logged, reads included ([WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) section
5.1), so the kernel confirms the call that produced it actually happened — that URL, that
viewport, that application state, at that time.

Consequently a Product/UX verdict may not rest on screenshot evidence alone. Criterion 8
and 14 (`UI`, `UX validation`) require, alongside any screenshots, at least one
call-log-anchored item per state claimed exercised. An agent asserting it reviewed the
empty, loading, partial, stale and error states, whose call log shows it only ever loaded
the happy path, is caught by reconciliation rather than believed.

### Coverage reconciliation

`coverage.scope_examined` is reconciled against the dispatch's call log on receipt. Scope
claimed but never touched by any call is a contract violation.

This matters more than it first appears. `coverage` is the field separating "the Auditor
found no orphan readers here" from "the Auditor never looked here" — the distinction the
whole evidence model rests on. Leaving it as an unchecked self-report would have left the
most consequential claim in the envelope as the one nobody verified.

### proposals

The v0.3 additions, and the only place an agent may ask for something structural. Every one
is a **proposal** the kernel admits, adjusts or refuses, and every one is optional — an
agent fills only the keys its mandate calls for.

```json
{
  "proposals": {
    "work_item": { },
    "workflow": {
      "template_id": "defect.standard",
      "include_optional": ["ARCHITECTURE"],
      "exclude_optional": [
        { "stage": "UX_REVIEW", "claim": "ux.required is FALSE", "rationale": "..." }
      ],
      "rationale": "..."
    },
    "decomposition": [
      { "title": "...", "type": "STORY", "scope": { }, "desired_outcome": "...",
        "depends_on": [], "external_identity": "jira:STORY-101" }
    ],
    "triage": [
      { "thread_id": "rt_7", "reading": "...", "remediation_scope": { "paths": ["..."] },
        "proposed_route": "COMMENT_RESOLUTION" }
    ],
    "cancellation": { "work_item_id": "...", "to": "SUPERSEDED", "evidence": ["E-12"] }
  }
}
```

What the kernel does with each:

- **`work_item`** — admitted per
  [INTENT_AND_WORK_ITEM_RESOLUTION.md](INTENT_AND_WORK_ITEM_RESOLUTION.md) section 3.4:
  external identity resolved through the adapter, type checked against evidence minimums,
  scope bounded, outcome required to bind to a checkable DoD profile.
- **`workflow`** — admitted against the template set and the workflow floor. `exclude_optional`
  carries a `claim`, never a decision: the kernel evaluates the stage's predicate itself and
  keeps the stage on `TRUE` or `INDETERMINATE`. A refused parameterization falls back to the
  most conservative admissible template, and the override is logged.
- **`decomposition`** — legal only from the Architect, only in `DECOMPOSITION`. Existing
  children are read from the PM adapter first; a child whose external identity already exists
  is linked, never recreated. Dependency cycles are refused.
- **`triage`** — routed by kernel scope containment, not by `proposed_route`. Inside the
  parent's admitted scope, or undeterminable, means `COMMENT_RESOLUTION`; provably outside
  means a child Work Item; outside and inseparable means `SCOPE_EXPANSION`.
- **`cancellation`** — admitted only if `reality.outcome_already_satisfied` evaluates `TRUE`
  from adapter evidence. Otherwise it escalates to a human.

A proposal an agent is not entitled to make — a workflow proposal from the Implementer, a
decomposition outside `DECOMPOSITION` — is a contract violation, logged and handled as
`BLOCKED`.

### assumptions

Anything the agent relied on that it did not verify. Each carries what breaks if it is
wrong and how to verify it. Assumptions are inherited by downstream agents and are
re-checkable later — which is how a wrong conclusion becomes traceable to its bad
assumption instead of looking like a mystery.

### unknowns

```json
{
  "id": "U-003",
  "subject": "production ingestion cadence",
  "reason": "UNAVAILABLE",
  "attempted": "runtime.logs adapter, production scope",
  "recoverable_by": "read access to production logs, or a human answer",
  "blocks": ["validation.production"]
}
```

Reasons match [DATA_SEMANTICS.md](DATA_SEMANTICS.md): `UNKNOWN`, `UNAVAILABLE`,
`NOT_APPLICABLE`, `NOT_COMPUTED`, `INSUFFICIENT_EVIDENCE`, `CONFLICTING`. `blocks` names
which downstream obligations cannot be met — this is what makes an unknown actionable
instead of decorative.

### artifacts_changed

The agent's account of every mutation it made: path, change kind, and for git operations
the SHA and branch. Includes files, commits, branches, migrations, tickets and runtime
state.

**This is not the reversal record.** The reversal record is the stream of `mutation` events
that adapters emit at call time
([WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) section 7.2) — those exist whether
or not an envelope ever arrives, which is what makes a mid-dispatch crash recoverable.

`artifacts_changed` is a **reconciliation**. On receipt the kernel diffs it against the
mutation events recorded for that dispatch:

- **Under-report** — a mutation happened that the agent did not declare. Contract
  violation, logged; the envelope is rejected. An agent that touches things it does not
  report cannot be trusted about anything else it reports.
- **Over-report** — the agent claims a mutation no adapter performed. Contract violation,
  logged. Usually a hallucinated edit, and worth catching precisely because the code looks
  fine and the change is absent.
- **Match** — proceed.

The blast radius of a dispatch is computed from the mutation events, never from this
field.

### recommendations

Out-of-scope observations passed up rather than acted on: priority, rationale, and the
agent that should own it. This is the pressure valve that keeps agents inside their
mandate — an Implementer that spots an unrelated defect records it here instead of fixing
it.

### blockers

```json
{
  "id": "B-002",
  "kind": "ARCHITECTURE_CONTRADICTION",
  "description": "Canonical ownership of `listing` is claimed by two stores.",
  "conflicting_requirements": ["...", "..."],
  "options": ["...", "..."],
  "needs": "architect_decision",
  "evidence": ["E-051"]
}
```

Kinds: `ARCHITECTURE_CONTRADICTION` · `MISSING_ACCESS` · `MISSING_CAPABILITY` ·
`AMBIGUOUS_GOAL` · `AMBIGUOUS_STATE` · `WORK_ITEM_MISCLASSIFIED` · `AUTHORIZATION_REQUIRED` ·
`BUDGET_EXHAUSTED` · `UNRESOLVED_CONFLICT` · `EXTERNAL_DEPENDENCY`.

`WORK_ITEM_MISCLASSIFIED` is how a stage reports that the work is not what was resolved — a
root-cause pass finding that the "broken" feature was never built. It ends the run as
`RERESOLVED` and starts a new one against the same Work Item, bounded by
`budgets.reresolution` ([WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) section 4.5). It
is a blocker rather than a proposal because the run cannot continue: its graph is for
different work.

`AMBIGUOUS_STATE` is new in v0.3 and is deliberately distinct from `AMBIGUOUS_GOAL`. "We do
not know what you want" and "we do not know whether this was already done" call for
different questions to a human and different evidence to resolve them, and collapsing them
would hide the more dangerous of the two. It is the terminal rung of the refined
safer-branch rule: raised only when a mutating stage's "already done" predicate stays
`INDETERMINATE` after discovery.

`needs` names what would unblock it: `architect_decision`, `human_decision`,
`human_authorization`, `access_grant`, `additional_discovery`, `external_fix`,
`re_resolution`.

### coverage

What the agent actually examined and what it did not. Mandatory, and one of the highest
value fields in the envelope: it is the difference between "the Auditor found nothing
there" and "the Auditor never looked there". Downstream agents must treat unexamined scope
as `UNKNOWN`.

### next_action

A *proposal*. The kernel validates it against the state machine and may override; the
override and its reason are logged. An agent does not drive the run.

## Cross-field consistency rules

Schema conformance is not consistency. These are checked independently, and each failure is
a contract violation handled as `BLOCKED`:

- `status: COMPLETE` requires `blockers` empty and every `required_output` present.
- `status: BLOCKED` and `BLOCKED_BY_ARCHITECTURE` require `blockers` non-empty.
- `status: BLOCKED_BY_ARCHITECTURE` is legal only from the Implementer, only in stage
  `IMPLEMENTATION`, and only where the frozen graph contains an `ARCHITECTURE` stage.
- Every key in `proposals` is legal only for the role and stage that owns it, and a proposal
  carrying a decision the kernel reserves — a resolved transition, a `verification` block, a
  granted authorization — is a contract violation.
- `status: REJECTED` is legal only from the Validator or Product/UX.
- Every id in `findings[].evidence` must exist in `evidence[]`. Dangling references are
  rejected, not ignored.
- Every id in `unknowns[].blocks` must name a real downstream obligation.
- `findings[].confidence: FACT` requires at least one supporting evidence item whose
  `verification.status` is `VERIFIED` after the kernel's verification pass.
- `verification` must be absent on arrival (kernel-owned, see above).
- `coverage` must be present and non-empty, and must reconcile against the dispatch's
  adapter call log. An agent that does not state what it examined has not completed its
  mandate; an agent that overstates it has committed a contract violation.
- Evidence of kind `log` or `metric` must carry a predicate, not a bare value.
- A Product/UX verdict on a claimed-exercised state requires at least one
  call-log-anchored evidence item for that state, not screenshots alone.
- Every assertion carries a confidence class.

## Kernel enforcement

On receipt, in this order — later steps do not run if an earlier one rejects:

1. Validates the envelope against its schema; a schema failure is an agent failure.
2. Applies the cross-field consistency rules above.
3. Reconciles `artifacts_changed` against the dispatch's mutation events, and `coverage`
   against its adapter call log.
4. Verifies evidence per the verification policy, downgrading or rejecting as specified.
5. Rejects a `next_action` that is not a legal transition, and evaluates the transition's
   predicate itself rather than accepting the agent's claim
   ([WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) section 4.3).
6. Persists the envelope immutably under the run's `envelopes/` directory, including the
   verification results it added.
7. Merges surviving findings, capability updates, unknowns and assumptions into run state.
8. Cross-checks new assertions against existing ones and raises a conflict for arbitration
   where they are incompatible.

Steps 2 through 5 are the kernel's disbelief machinery. Everything an agent says is a claim
until one of them passes it.

## Input package

Symmetrically, an agent receives a typed input, never a conversation:

```json
{
  "work_item_id": "wi_jira_DEF-456",
  "run_id": "...",
  "agent": "architect",
  "stage": "ARCHITECTURE",
  "work_item_ref": "../work-item.json",
  "workflow": { "template_id": "defect.standard", "version": "1.0",
                "stages_remaining": ["PLAN", "IMPLEMENTATION", "..."] },
  "context_package_ref": "context/v3.json",
  "capability_registry_ref": "capabilities/v2.json",
  "prior_envelopes": ["env_002", "env_007"],
  "dispatch_id": "d_014",
  "mandate": {
    "objective": "...",
    "in_scope": ["src/pricing/**"],
    "out_of_scope": ["src/auth/**", "tests/fixtures/**"],
    "advisory_notes": "untrusted free text from the Orchestrator Agent"
  },
  "required_inputs": ["goal", "domain_model", "data_map", "api_map"],
  "required_outputs": ["target_architecture", "plan", "decisions"],
  "dod_profile_ref": "policies/dod/service-capability.json",
  "constraints": { },
  "authorization_scope": { },
  "skills_available": [],
  "budget": { }
}
```

`prior_envelopes` are references to structured envelopes, not transcript text.

**`work_item_ref` replaces v0.2's inlined `goal`.** There is one authoritative statement of
what is being attempted, and every agent reads the same one. `workflow` is supplied
read-only so an agent knows what comes after it — useful for writing a handoff, and
insufficient for changing anything, since the graph is frozen and the kernel evaluates the
edges.

**`mandate` is structured, not prose.** `objective`, `in_scope` and `out_of_scope` are
typed fields the kernel derives from the approved plan and work unit — not from the
Orchestrator Agent's free text. The adapters enforce `in_scope` and `out_of_scope` as path
constraints on top of worktree confinement
([REPOSITORY_ADAPTER.md](REPOSITORY_ADAPTER.md) section 2.1), so an out-of-scope edit fails
at the adapter rather than relying on the receiving agent to decline.

`advisory_notes` carries whatever prose the Orchestrator Agent wants to add. It is labelled
untrusted, it grants nothing, and no adapter consults it. This keeps a useful channel open
without making one agent's text a way to widen another agent's reach.

**`dispatch_id` seeds idempotency.** Every mutating adapter call made during this dispatch
derives its idempotency key from it
([WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) section 7.3).

**`required_inputs` bounds what is materialized.** An agent declares which Context Package
sections it needs and the kernel builds only those into the dispatch. This is what keeps
input size independent of run length: the package grows, the dispatch does not. An agent
needing more requests it, which is a recorded event and therefore a measurable appetite
rather than an invisible one. See [CONTEXT_MODEL.md](CONTEXT_MODEL.md), "Bounding context
growth".
