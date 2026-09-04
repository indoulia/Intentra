# state

Durable work item and run store. Schema is tracked in git; data is not.

state/work-items/<work-item-id>/
  work-item.json      identity, type, desired outcome, scope, links, lifecycle, run lease
  events.ndjson       work-item-level log: runs started, outcomes, links, reclassifications
  runs/<run-id>/
    run.json          projection: frozen graph, current stage, cursor, budgets
    events.ndjson     append-only log — the source of truth for this attempt
    context/          Context Package snapshots, including current_reality
    capabilities/     capability registry
    envelopes/        immutable agent handoffs
    decisions/        arbitration, architecture and admission decisions
    authorizations/   requests and grants
    artifacts/        diffs, reports, traces

A Work Item is durable and outlives every attempt at it; a run is one attempt. A run failing
does not destroy work item identity or history, which is why the two levels are separate.

See ../docs/WORKFLOW_STATE_MACHINE.md and ../docs/INTENT_AND_WORK_ITEM_RESOLUTION.md.

Empty in Phase 0 — design only.
