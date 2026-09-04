# policies

Declarative data the kernel and adapters enforce. Policy is enforced, not remembered.

Files this design calls for:

- `gates.json` — authorization gate definitions and the mechanical classifiers that fire
  them (path patterns, content markers, destructive-SQL patterns)
- `paths.json` — the absolute adapter deny-list: AgentOS installation, `state/`,
  `policies/`, `contracts/`, host credential stores
- `predicates.json` — transition predicates (`audit.applicable`, `architecture.required`,
  `ux.required`, `production.applicable`) and the safer-branch rule
- `evidence.json` — verification policy: always-verify classes, sample rate, mismatch
  thresholds
- `dod/*.json` — Definition-of-Done profiles and applicability rules
- `budgets.json` — rework and architecture loop caps, cost ceilings, freshness windows
- `security-floor.md` — the non-overridable statement

A repository may tighten these through `.agent/policies.json`. It may never loosen them.

See ../docs/HUMAN_AUTHORIZATION.md, ../docs/WORKFLOW_STATE_MACHINE.md and
../docs/DEFINITION_OF_DONE.md.

Empty in Phase 0 — design only.
