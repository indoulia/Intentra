# adapters

The only path between agents and the outside world: repository, git, project-management,
runtime and host adapters.

Adapters are an enforcement layer, not a convenience layer. They own:

- **path confinement** — worktree root, mandate scope, absolute deny-list
- **fail-closed classification** — unknown branch means protected, unknown environment
  means production
- **gate classification** — mechanical detection of gated operations from what is observed
- **grant checking** — at execution time, never by the agent that requested it
- **call log** — every call logged, reads included, so coverage claims are reconcilable
- **mutation events** — emitted at call time, with reversals, before returning
- **idempotency** — completed-key records so a retried dispatch does not duplicate effects
- **evidence replay** — read-only re-execution of evidence locators for kernel verification
- **redaction** — secrets referenced, never captured
- **platform differences** — no OS assumption belongs in the kernel or an agent

Every operation carries a descriptor: `mutating`, `reversal` (or `null`),
`idempotent_by_key`, `external_destination`, `side_effect_free`.

See ../docs/REPOSITORY_ADAPTER.md and ../docs/KERNEL_BOUNDARY.md.

Empty in Phase 0 — design only.
