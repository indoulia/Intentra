# agents

Role specifications: mandate, required inputs, permitted adapters, output envelope type,
model and skill requirements. Specifications, not prompts.

Eight roles. Context Discovery carries two mandates — `resolution`, which turns an
`IntakeRecord` into a proposed Work Item before any workflow exists, and `context`, the
ordinary Context Package build. Resolution is a mandate rather than a ninth role because it
is the same work — run probes, classify assertions, reconcile sources — applied to the task
instead of to a capability.

See ../docs/AGENT_ROLES.md.

Empty in Phase 0 — design only.
