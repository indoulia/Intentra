# state

Durable run store. Schema is tracked in git; run data is not.

state/runs/<run-id>/
  run.json          projection of current state
  events.ndjson     append-only log — the source of truth
  context/          Context Package snapshots
  capabilities/     capability registry
  envelopes/        immutable agent handoffs
  decisions/        arbitration and architecture decisions
  authorizations/   requests and grants
  artifacts/        diffs, reports, traces

See ../docs/WORKFLOW_STATE_MACHINE.md.

Empty in Phase 0 — design only.
