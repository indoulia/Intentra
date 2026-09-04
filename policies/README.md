# policies

Declarative data the kernel and adapters enforce. Policy is enforced, not remembered.

Files this design calls for:

- `gates.json` — authorization gate definitions and the mechanical classifiers that fire
  them (path patterns, content markers, destructive-SQL patterns)
- `paths.json` — the absolute adapter deny-list: AgentOS installation, `state/`,
  `policies/`, `contracts/`, host credential stores
- `predicates.json` — applicability predicates (`audit.applicable`, `architecture.required`,
  `ux.required`, `production.applicable`), the reality predicates (`reality.pr_open`,
  `reality.ci_green`, `reality.outcome_already_satisfied`, …) and the safer-branch rule
- `workflows/*.json` — the workflow templates. Graphs are policy data authored and reviewed
  by humans; no agent composes one. This is what keeps dynamic workflow selection
  deterministic
- `stages.json` — stage descriptors: `mutating`, owning role, required outputs, exit
  condition, `satisfied_by` reality predicate, possible gates, DoD criteria supplied
- `workflow-floor.json` — what a graph must contain given what it contains: merge requires
  validation and authorization before it, a defect requires root cause before implementation,
  an epic forbids implementation. Checked at policy load, not only at run start
- `work-items.json` — per Work Item Type, the minimum evidence class required to assert it
- `intake.json` — trust classification per source, and any pre-granted
  `AUTONOMOUS_INTAKE_EXECUTION` sources
- `evidence.json` — verification policy: always-verify classes, sample rate, mismatch
  thresholds
- `dod/*.json` — Definition-of-Done profiles and applicability rules
- `budgets.json` — rework, architecture, review and discovery loop caps, cost ceilings,
  freshness windows, `reresolution` cap, `decomposition` breadth and depth caps,
  `lease_timeout` — per run **and** per work item, since a budget that resets on every attempt
  is not a budget
- `security-floor.md` — the non-overridable statement

A repository may tighten these through `.agent/policies.json`. It may never loosen them.

See ../docs/HUMAN_AUTHORIZATION.md, ../docs/WORKFLOW_STATE_MACHINE.md and
../docs/DEFINITION_OF_DONE.md.

Empty in Phase 0 — design only.
