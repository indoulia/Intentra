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
  "envelope_version": "1.0",
  "run_id": "run_2026_09_04_a1b2",
  "envelope_id": "env_007",
  "agent": "auditor",
  "agent_version": "1.0",
  "model": "claude-opus-5",
  "skills_used": ["repo-graph", "sql-inspect"],
  "state_in": "AUDIT",
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

  "next_action": {
    "proposed_state": "AUDIT_COMPLETE",
    "proposed_agent": "architect",
    "rationale": "..."
  }
}
```

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
which state and agent. That mapping is defined once, in
[WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) section 2.1. An envelope carrying a
status that is illegal for its state or role is a contract violation, logged as such and
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
  "ref": "select count(*) from classification where sme is not null",
  "excerpt": "0",
  "observed_at": "2026-09-04T10:22:00Z",
  "adapter": "runtime.postgres.staging",
  "reproducible": true
}
```

Kinds: `file` · `git` · `command` · `query` · `http` · `log` · `ticket` · `document` ·
`screenshot` · `metric`. Every evidence item must be independently checkable by a human;
`ref` plus `excerpt` must be enough to re-run or re-read it.

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

Every mutation: path, change kind, and for git operations the SHA and branch. Includes
files, commits, branches, migrations, tickets and runtime state. If an agent changed it,
it appears here — this is the reversal record and the basis of the run's blast radius.

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
`AMBIGUOUS_GOAL` · `AUTHORIZATION_REQUIRED` · `BUDGET_EXHAUSTED` · `UNRESOLVED_CONFLICT` ·
`EXTERNAL_DEPENDENCY`.

`needs` names what would unblock it: `architect_decision`, `human_decision`,
`human_authorization`, `access_grant`, `additional_discovery`, `external_fix`.

### coverage

What the agent actually examined and what it did not. Mandatory, and one of the highest
value fields in the envelope: it is the difference between "the Auditor found nothing
there" and "the Auditor never looked there". Downstream agents must treat unexamined scope
as `UNKNOWN`.

### next_action

A *proposal*. The kernel validates it against the state machine and may override; the
override and its reason are logged. An agent does not drive the run.

## Kernel enforcement

On receipt, the kernel:

1. Validates the envelope against its schema; a schema failure is an agent failure.
2. Rejects findings without evidence, `COMPLETE` with unfilled required outputs, and
   assertions whose confidence class is missing.
3. Rejects a `next_action` that is not a legal transition from the current state.
4. Persists the envelope immutably under `state/runs/<run-id>/envelopes/`.
5. Merges findings, capability updates, unknowns and assumptions into run state.
6. Cross-checks new assertions against existing ones and raises a conflict for arbitration
   where they are incompatible.

## Input package

Symmetrically, an agent receives a typed input, never a conversation:

```json
{
  "run_id": "...",
  "agent": "architect",
  "state": "ARCHITECTURE",
  "goal": { },
  "context_package_ref": "context/v3.json",
  "capability_registry_ref": "capabilities/v2.json",
  "prior_envelopes": ["env_002", "env_007"],
  "mandate": "...",
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

**`required_inputs` bounds what is materialized.** An agent declares which Context Package
sections it needs and the kernel builds only those into the dispatch. This is what keeps
input size independent of run length: the package grows, the dispatch does not. An agent
needing more requests it, which is a recorded event and therefore a measurable appetite
rather than an invisible one. See [CONTEXT_MODEL.md](CONTEXT_MODEL.md), "Bounding context
growth".
