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

## 2. Transitions

```
GOAL_RECEIVED
  -> CONTEXT_DISCOVERY                   always
  -> BLOCKED                             goal unintelligible / repository unreachable

CONTEXT_DISCOVERY
  -> CONTEXT_READY                       coverage sufficient for the goal
  -> BLOCKED                             critical source unreachable and required

CONTEXT_READY
  -> AUDIT                               goal touches an existing system  [default]
  -> ARCHITECTURE                        audit not applicable (recorded reason)
  -> IMPLEMENTATION                      trivial change within an established contract
  -> BLOCKED                             goal contradicts discovered reality

AUDIT
  -> AUDIT_COMPLETE
  -> BLOCKED                             cannot audit without access it lacks

AUDIT_COMPLETE
  -> ARCHITECTURE                        structural change needed  [default]
  -> IMPLEMENTATION                      findings are localized, contracts unchanged
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
  -> UX_REVIEW                           user-facing surface changed
  -> READY_FOR_HUMAN_AUTHORIZATION       validation passed, no UI surface
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
  -> VALIDATION_FAILED                   production contradicts pre-deploy validation
  -> BLOCKED                             cannot obtain production evidence

BLOCKED
  -> <state at time of block>            blocker resolved; resume
  -> COMPLETE                            abandoned by human decision, recorded
```

Every transition is an event carrying: from, to, trigger, deciding agent, evidence
references, timestamp.

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
- **Steps are idempotent or explicitly resumable.** Re-running a step after a crash must
  either be safe or refuse and require a decision. This is enforced at dispatch, not
  assumed.
- **Mutations are recorded with their reversal.** Every file change, commit and branch
  operation is logged with enough information to undo it.
- **Recovery replays, it does not resume from memory.** On restart the kernel reads the
  log, rebuilds the cursor, identifies any step interrupted mid-flight, and either retries
  it (idempotent) or blocks with a clear report (not idempotent).

Nothing about resumption depends on a model remembering anything.

## 6. Observability projections

- `run.json` — the live answer to "what is AgentOS doing right now": state, agent, model,
  elapsed, what it awaits, pending authorizations, loop counters, budget consumed.
- **Run narrative** — generated from the event log: what was discovered, decided, built,
  failed, reworked, authorized and completed, in order, with evidence links.

Both must be readable without AgentOS running. A run whose story is not reconstructible
from its own log is a kernel defect.
