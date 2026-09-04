# discovery

Probes that fill the Context Package. Each answers one narrow question, declares its own
availability, mutates nothing, and degrades to UNKNOWN rather than guessing.

Two tiers matter to sequencing: tier-1 orientation probes run before the work item is
resolved, and tier-2 depth plus the `current_reality` set run after, scoped by the admitted
work item. `current_reality` — implementation, tests, PR, CI, reviews, merge state,
deployment, outcome evidence, children — is what every resume decision is computed from, and
nothing in it may be derived from the request's wording.

See ../docs/CONTEXT_MODEL.md and ../docs/INTENT_AND_WORK_ITEM_RESOLUTION.md.

Empty in Phase 0 — design only.
