# Workflow State Machine

A run is a persisted state machine plus an append-only event log. The state must survive
process death, terminal closure, model failure and machine restart.

The kernel owns transitions. An agent proposes `next_action`; the kernel decides. An agent
that claims a transition it is not entitled to make is a contract violation, logged as
such.

## 1. States

```
GOAL_RECEIVED
CONTEXT_DISCOVERY
CONTEXT_READY
AUDIT
AUDIT_COMPLETE
ARCHITECTURE
ARCHITECTURE_READY
PLAN_READY
IMPLEMENTATION
IMPLEMENTATION_COMPLETE
VALIDATION
VALIDATION_FAILED
UX_REVIEW
UX_FAILED
REWORK
READY_FOR_HUMAN_AUTHORIZATION
AUTHORIZED
DEPLOYING
PRODUCTION_VALIDATION
COMPLETE
BLOCKED
```

Terminal: `COMPLETE`. Semi-terminal: `BLOCKED` (resumable when the blocker clears).
Everything else is transient and must have a defined next transition.

**A state is a phase, not a single dispatch.** One state may involve several agent
invocations before its exit condition is met — `VALIDATION`, for instance, dispatches the
Validator and then the Auditor's structural second pass for Definition-of-Done criterion 17
([AGENT_ROLES.md](AGENT_ROLES.md), role 3). Transitions are driven by exit conditions, not
by envelope arrival.

## 2. Transitions

```
GOAL_RECEIVED
  -> CONTEXT_DISCOVERY                   always
  -> BLOCKED                             goal unintelligible / repository unreachable

CONTEXT_DISCOVERY
  -> CONTEXT_READY                       coverage sufficient for the goal
  -> BLOCKED                             critical source unreachable and required

CONTEXT_READY
  -> AUDIT                               [default]
  -> ARCHITECTURE                        NOT audit.applicable
  -> IMPLEMENTATION                      NOT audit.applicable AND NOT architecture.required
  -> BLOCKED                             goal contradicts discovered reality

AUDIT
  -> AUDIT_COMPLETE
  -> BLOCKED                             cannot audit without access it lacks

AUDIT_COMPLETE
  -> ARCHITECTURE                        architecture.required  [default]
  -> IMPLEMENTATION                      NOT architecture.required
  -> READY_FOR_HUMAN_AUTHORIZATION       audit-only goal; findings are the deliverable

ARCHITECTURE
  -> ARCHITECTURE_READY
  -> BLOCKED                             requirements irreconcilable / decision needed

ARCHITECTURE_READY
  -> PLAN_READY                          plan produced, DoD profiles assigned

PLAN_READY
  -> IMPLEMENTATION
  -> READY_FOR_HUMAN_AUTHORIZATION       plan itself requires authorization to execute

IMPLEMENTATION
  -> IMPLEMENTATION_COMPLETE             all work units done
  -> ARCHITECTURE                        BLOCKED_BY_ARCHITECTURE  (loop, counted)
  -> BLOCKED                             cannot implement; not an architecture question

IMPLEMENTATION_COMPLETE
  -> VALIDATION

VALIDATION
  -> UX_REVIEW                           ux.required
  -> READY_FOR_HUMAN_AUTHORIZATION       NOT ux.required
  -> VALIDATION_FAILED
  -> BLOCKED                             cannot validate (environment unavailable)

VALIDATION_FAILED
  -> REWORK                              within rework budget
  -> ARCHITECTURE                        defect is structural
  -> BLOCKED                             rework budget exhausted

UX_REVIEW
  -> READY_FOR_HUMAN_AUTHORIZATION       accepted
  -> UX_FAILED

UX_FAILED
  -> REWORK                              within rework budget
  -> ARCHITECTURE                        defect is structural
  -> BLOCKED                             rework budget exhausted

REWORK
  -> IMPLEMENTATION

READY_FOR_HUMAN_AUTHORIZATION
  -> AUTHORIZED                          grant received
  -> COMPLETE                            nothing gated remains (e.g. PR prepared only)
  -> BLOCKED                             denied, or no response within policy window

AUTHORIZED
  -> DEPLOYING                           grant covers merge/deploy
  -> COMPLETE                            grant covers a non-deploy action, now done

DEPLOYING
  -> PRODUCTION_VALIDATION
  -> BLOCKED                             deployment failed; rollback executed and recorded

PRODUCTION_VALIDATION
  -> COMPLETE                            production evidence satisfies the DoD
  -> BLOCKED                             production contradicts pre-deploy validation,
                                         OR production evidence cannot be obtained

BLOCKED
  -> <state at time of block>            blocker resolved; resume
  -> COMPLETE                            abandoned by human decision, recorded
```

Every transition is an event carrying: from, to, trigger, deciding agent, evidence
references, timestamp.

**Production failure does not fall back into `REWORK`.** Code is already live, so the next
decision is a rollback decision, and that is a human's. `PRODUCTION_VALIDATION` failure
goes to `BLOCKED` with the Production agent's rollback recommendation attached. Resuming
into `REWORK` requires either a completed rollback or an explicit human decision to fix
forward — both recorded as authorization events.

## 2.1 Envelope status to kernel action

Every value of `HandoffEnvelope.status`
([AGENT_HANDOFF_CONTRACT.md](AGENT_HANDOFF_CONTRACT.md)) maps to exactly one kernel
action. Without this mapping the two documents do not compose.

- `COMPLETE` — evaluate the agent's proposed `next_action` against the transition table;
  transition if legal, else override and log.
- `PARTIAL` — **never** treated as a soft `COMPLETE`. The kernel checks whether the
  unfilled outputs are required by the current state's exit condition. Not required ->
  proceed, recording the gap as an `unknown`. Required -> re-dispatch once with the gap
  named, then `BLOCKED` if it recurs.
- `BLOCKED` — transition to `BLOCKED`, carrying the blocker. The pre-block state is
  recorded so the run can resume in place.
- `BLOCKED_BY_ARCHITECTURE` — `IMPLEMENTATION -> ARCHITECTURE`, counted against the
  architecture loop cap. Legal only from `IMPLEMENTATION`; from any other state it is a
  contract violation and is treated as `BLOCKED`.
- `FAILED` — an agent-level failure (tooling, model, timeout), not a finding about the
  work. The kernel retries per policy, escalating the model once
  ([SKILL_AND_MODEL_SELECTION.md](SKILL_AND_MODEL_SELECTION.md)). On repeated failure:
  `BLOCKED`. The state does **not** advance, and a `FAILED` envelope never satisfies an
  exit condition.
- `REJECTED` — legal only from a reviewing agent. From the Validator -> `VALIDATION_FAILED`;
  from Product/UX -> `UX_FAILED`. From any other agent it is a contract violation.

An envelope whose status is illegal for the current state or agent is logged as a contract
violation and handled as `BLOCKED`. The kernel never guesses what an agent meant.

## 2.2 Authorization requested mid-run

`READY_FOR_HUMAN_AUTHORIZATION` covers the end-of-run gate. But several gates in
[HUMAN_AUTHORIZATION.md](HUMAN_AUTHORIZATION.md) — `SCOPE_EXPANSION`,
`COST_CEILING_EXCEEDED`, `CREDENTIAL_OR_SECURITY_CHANGE`, `DESTRUCTIVE_MIGRATION` — can
trigger at any point, typically during `IMPLEMENTATION`.

These do **not** get their own state. Any state may transition to `BLOCKED` with a blocker
of kind `AUTHORIZATION_REQUIRED`, carrying the request. A grant resumes the run at the
pre-block state; a denial or timeout leaves it `BLOCKED`.

One authorization mechanism, one blocking mechanism, and no state explosion. The
distinction between "waiting on a human" and "waiting on anything else" lives in the
blocker kind, which is where an operator already looks.

## 2.3 Transition predicates

A transition table whose branch conditions are prose is a table an agent decides. Every
conditional transition above names a **predicate** the kernel evaluates itself, over the
Context Package, the capability registry and the dispatch's mutation events. The agent's
opinion is recorded as a `claim` and is never the decision.

Predicates are defined as data in `policies/predicates.json`. Their meanings:

- **`audit.applicable`** — the capability registry contains at least one record whose
  scope intersects the goal scope, **or** the target repository has any commit history.
  False only for genuinely greenfield work.
- **`architecture.required`** — any of: a planned or actual change touches a declared
  contract boundary (`api_map`, `source_map`, schema/migration paths); the work would
  change canonical ownership of an entity in `domain_model`; an audit finding is
  categorized structural (`orphan-*`, `duplicate-ownership`, `broken-chain`,
  `provenance-break`).
- **`ux.required`** — `context.ui_map` is non-empty **and** the dispatch's mutation events
  include a path under any `ui_map` surface, **or** an API whose consumers include a
  `ui_map` surface changed shape.
- **`production.applicable`** — `environments` includes an environment classified
  production **and** the goal scope reaches it.

### The safer-branch rule

A predicate evaluates to `TRUE`, `FALSE`, or `INDETERMINATE`. **`INDETERMINATE` takes the
branch that does more work, not less.** Cannot tell whether a UI changed? Run the UX
review. Cannot tell whether architecture is needed? Run the Architect. Cannot tell whether
audit applies? Audit.

This is deliberately biased. The cost of an unnecessary review is tokens; the cost of a
skipped one is a defect reaching production behind a green run. Where a predicate's inputs
are missing because discovery could not reach them, the safer branch is also the honest
one — AgentOS does not get to skip a stage because it failed to look.

An agent may not propose a transition whose predicate the kernel evaluates against it. Such
a `next_action` is overridden, and the override is logged with both the claim and the
evaluated value, so a systematically over-claiming agent becomes visible in the run
narrative.

## 3. Loops and budgets

Three loops exist, all bounded by policy:

- **Rework loop** — `VALIDATION_FAILED | UX_FAILED -> REWORK -> IMPLEMENTATION ->
  VALIDATION`. Default cap: 3.
- **Architecture loop** — `IMPLEMENTATION -> ARCHITECTURE -> ... -> IMPLEMENTATION`.
  Default cap: 2. A third contradiction means the problem is not understood, and pushing
  through is worse than stopping.
- **Discovery loop** — an on-demand probe requested mid-run. Not counted against rework;
  bounded by cost budget.

Exceeding a cap is `BLOCKED`, never a quiet retry. The block report states what was tried,
what failed each time, and what a human would need to decide.

Also bounded by policy: total cost, wall-clock, and per-agent invocation count. AgentOS
stopping and explaining beats AgentOS spinning.

## 4. Sub-runs

A goal decomposing into independent capabilities may spawn sub-runs, each with its own
state machine and its own DoD, sharing the parent's Context Package by reference. The
parent completes when all sub-runs reach a terminal state; a blocked sub-run does not block
its siblings.

Sub-runs are how AgentOS handles a large goal without a single unbounded run. The MVP runs
them sequentially.

## 5. Durability

State lives on disk under `state/runs/<run-id>/`:

```
run.json          identity, goal, current state, cursor, budgets consumed
events.ndjson     append-only event log; the source of truth
context/          Context Package (versioned snapshots)
capabilities/     capability registry
envelopes/        one file per agent handoff, immutable
decisions/        arbitration and architecture decisions
authorizations/   requests and grants
artifacts/        diffs, reports, screenshots, traces
```

Rules that make interruption survivable:

- **The event log is authoritative.** `run.json` is a projection and can be rebuilt from
  the log. If they disagree, the log wins.
- **Write before act.** An intent-to-dispatch event is written before the agent is invoked,
  so a crash mid-agent is detectable rather than invisible.
- **Every event is one newline-terminated line, appended and flushed.** On recovery a
  trailing partial line — the signature of a power loss mid-write — is discarded and the
  discard is itself logged. A partial line is never parsed, and never silently dropped.
- **Recovery replays, it does not resume from memory.** On restart the kernel reads the
  log, rebuilds the cursor, identifies any dispatch interrupted mid-flight, and applies the
  retry protocol below.

Nothing about resumption depends on a model remembering anything, or on a model being
available at all.

### 5.1 The adapter call log

**Every adapter call is logged — reads included, not only mutations.** A `call` event
records dispatch, adapter, operation, arguments, outcome and timing. Mutating calls
additionally emit the `mutation` event below.

Logging reads costs little and buys the thing nothing else can: **the kernel knows what an
agent actually looked at.** That makes two otherwise unverifiable claims checkable.

- **Coverage.** An agent's `coverage.scope_examined` is reconciled against its call log. An
  agent claiming it examined a subsystem that no call touched is a contract violation.
  Without this, `coverage` — the field that distinguishes "found nothing there" from "never
  looked there" — is exactly the kind of unchecked self-report the rest of v0.2 removes.
- **Evidence that cannot be replayed.** A screenshot cannot be byte-compared, but the
  adapter call that produced it can be confirmed to have happened, against that URL, in that
  state, at that time. The observation's *provenance* is verifiable even when its *content*
  is not.

Read calls are logged at a policy-defined granularity, since a discovery run makes many.
Aggregation is permitted; omission is not.

### 5.2 Mutation events

**Adapters emit a `mutation` event at call time, before returning to the caller.** Not at
the end of a dispatch, and not from the envelope — an envelope that never arrives cannot
record anything, which is exactly the crash this rule exists for.

```json
{
  "event": "mutation",
  "run_id": "...", "dispatch_id": "d_014", "seq": 37,
  "adapter": "git", "op": "commit",
  "target": "worktree/agentos-run-a1b2",
  "before": { "head": "9f2c1ab" },
  "after":  { "head": "4de0117" },
  "reversal": { "op": "reset_hard", "args": { "to": "9f2c1ab" } },
  "at": "2026-09-04T11:02:44Z"
}
```

Consequences:

- The reversal record exists the moment the mutation does.
- The blast radius of any dispatch is computable from the log alone.
- `artifacts_changed` in the envelope becomes a *reconciliation* the kernel checks against
  these events ([AGENT_HANDOFF_CONTRACT.md](AGENT_HANDOFF_CONTRACT.md)) — under-reporting
  and over-reporting are both caught.

An adapter that cannot emit a mutation event must refuse the mutation. Unlogged mutation is
not permitted, and "the log was unavailable" is a reason to stop, not to proceed.

### 5.3 Retry protocol

Retry is defined at the granularity where side effects actually happen — the adapter
operation — not at the granularity of an agent.

**Idempotency keys.** Every mutating adapter call carries
`key = hash(run_id, dispatch_id, adapter, op, normalized_args)`. The adapter records
completed keys. On replay of a known key it performs no work and returns the recorded
result. This makes a re-dispatch after a crash safe *per operation*, without requiring the
agent to be deterministic.

**Pre-retry reset.** Before re-dispatching an interrupted or failed agent, the kernel:

1. Reads the dispatch's mutation events.
2. Applies their reversals in reverse order, restoring the worktree to its pre-dispatch
   state.
3. Logs a `dispatch_rollback` event listing what was reversed.
4. Re-dispatches with a **new** `dispatch_id`, so the retry's operations get fresh keys and
   are not confused with the abandoned attempt's.

**Non-reversible operations.** An adapter operation whose `reversal` is `null` — an
external API write, an email, a published artifact — is declared non-reversible in the
adapter's descriptor. A dispatch that performed one **is never automatically retried**. The
run blocks with `EXTERNAL_DEPENDENCY`, stating precisely what already happened, and a human
decides. This is the one place where "retry safely" is not available, and pretending
otherwise is how a system sends the same notification four times.

**Interaction with budgets.** Retries count against the run's loop and cost budgets. A
dispatch that fails repeatedly exhausts its budget and blocks rather than looping.

## 6. Observability projections

- `run.json` — the live answer to "what is AgentOS doing right now": state, agent, model,
  elapsed, what it awaits, pending authorizations, loop counters, budget consumed.
- **Run narrative** — generated from the event log: what was discovered, decided, built,
  failed, reworked, authorized and completed, in order, with evidence links.

Both must be readable without AgentOS running. A run whose story is not reconstructible
from its own log is a kernel defect.
