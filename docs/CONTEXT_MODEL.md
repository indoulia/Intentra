# Context Model

The Context Package is the durable, structured answer to "what is actually true about this
repository, its intent, and its runtime?" It is built by discovery probes, consumed by
every downstream agent, and persisted with the run.

It exists so that no agent has to re-derive context, and so that a human can audit what
AgentOS believed and why.

## 1. The two rules

**Rule 1 — every assertion carries a confidence class.**

- `FACT` — directly observed through an adapter, with a citable artifact.
- `INFERENCE` — derived from facts by reasoning. Must name the facts it derives from.
- `UNKNOWN` — not determined. Must name why: not attempted, unreachable, denied,
  ambiguous, or out of scope.

**Rule 2 — `UNKNOWN` never silently becomes `FACT`.**

Promotion requires new evidence and is recorded as an event. A downstream agent that needs
a `FACT` and finds an `INFERENCE` must either request discovery or declare a blocker. This
is enforced by the kernel, not left to agent discretion.

## 2. Assertion shape

Every leaf value in the package is an assertion, not a bare value.

```json
{
  "value": "postgres",
  "confidence": "FACT",
  "evidence": [
    { "kind": "file", "ref": "docker-compose.yml:12", "excerpt": "image: postgres:15" }
  ],
  "observed_at": "2026-09-04T10:14:00Z",
  "probe": "repo.stack",
  "freshness": "CURRENT"
}
```

For `INFERENCE`, `evidence` is replaced or supplemented by `derived_from` (assertion ids)
plus the reasoning in one sentence. For `UNKNOWN`, `reason` is mandatory and
`recoverable_by` names what would resolve it.

Evidence kinds: `file`, `git`, `command`, `query`, `http`, `log`, `ticket`, `document`,
`screenshot`, `metric`.

## 3. Probes

A probe answers one narrow question, declares its own availability, and degrades to
`UNKNOWN`. Probes are independent and safely parallel; none of them mutate anything.

Availability is itself recorded: a probe that cannot run yields
`UNAVAILABLE(reason)`, which is a fact about access, not a fact about the system.

### Repository probes

- **structure** — layout, modules, entry points, ownership files
- **stack** — languages, frameworks, build system, package managers, versions
- **manifests** — dependencies, versions, lockfiles, known vulnerabilities where available
- **configuration** — config files, environment variables, feature flags, per-environment
  differences
- **schema** — database schemas, migrations, ORM models, applied-vs-pending migration state
- **api** — endpoints, contracts, request/response shapes, generated specs, versioning
- **ui** — surfaces, routes, components, state management, design system
- **tests** — suites, frameworks, coverage where available, and *what the tests actually
  assert on* — real integrations, or mocks and fixtures
- **cicd** — pipelines, gates, environments, promotion rules, protected branches
- **deployment** — infrastructure definitions, containers, hosting, environment topology
- **documentation** — README, architecture docs, ADRs, comments, and their last-modified
  dates relative to the code they describe
- **conventions** — naming, error handling, logging, layering — the patterns an Implementer
  must match

### Git probes

- branches (including staleness and divergence), commits, tags, worktrees
- merge history and release history
- recent change concentration — which areas are churning
- authorship and review patterns where visible
- open and recent pull requests, their state and review outcomes

### Project-management probes

- EPICs, issues, milestones, their claimed state and their evidence
- linked commits, branches and PRs per issue
- project documentation, decision records, meeting outcomes where accessible

Everything from this source is **claimed intent**, never confirmed capability. An issue in
`Done` is a `FACT` about the ticket's status and at most an `INFERENCE` about the system.

### Runtime probes

- databases: reachable, schema-in-use, row counts, sample shapes, null distributions,
  freshness of the newest record
- services and APIs: health, versions, real responses to real requests
- logs: error patterns, throughput, silence where activity was expected
- deployed versions and drift from the repository
- production state, strictly within policy and read-only without a grant

Runtime is the closest thing to truth. Where it disagrees with code or intent, runtime is
the finding.

### Agent capability probes

Installed skills, repository skills, global skills, plugins, connectors, MCP servers,
available tools, scripts. Includes servers configured but unreachable — a failed connector
is `UNAVAILABLE`, never "absent".

### Model capability probes

Available models, context limits, reasoning, coding and vision capability, cost and speed
where knowable. See [SKILL_AND_MODEL_SELECTION.md](SKILL_AND_MODEL_SELECTION.md).

## 4. Package structure

```
ContextPackage
  meta            run id, goal, timestamps, probe coverage, package version
  goal            raw goal, parsed intent, target repository, success criteria,
                  explicit non-goals
  repository      identity, stack, structure, conventions, build & test commands
  product         what the system is for, its users, its domain vocabulary
  capabilities    -> Capability Registry (see CAPABILITY_MODEL.md)
  architecture    observed architecture, layering, boundaries, integrations
  domain_model    entities, relationships, canonical ownership, identifiers
  source_map      external and internal data sources, contracts, refresh cadence
  data_map        stores, schemas, ownership, flow, provenance, retention
  api_map         endpoints, contracts, consumers, auth, versioning
  ui_map          surfaces, routes, states, data dependencies, design system
  tests           suites, what they cover, and what they actually prove
  git_state       branches, commits, PRs, tags, worktrees, churn
  runtime_state   services, databases, versions, health, data reality
  production_state deployed versions, real data, real errors, real usage
  intent          EPICs, issues, milestones, decisions, documentation
  reconciliation  the intent / code / runtime matrix (section 5)
  agent_capabilities skills, tools, plugins, connectors, scripts
  model_capabilities models and their properties
  constraints     technical, policy, business, compliance, timing
  authorization   what this run may do autonomously and what needs a human
  gaps            every UNKNOWN with its reason and how to resolve it
```

Two structural notes:

- `capabilities` is a reference into the Capability Registry rather than a copy. There is
  one representation of a capability per run.
- `gaps` is a first-class top-level section, not a footnote. What AgentOS does not know is
  as operationally important as what it does, and it drives whether an agent may proceed.

## 5. Reconciliation

For each capability, discovery records what each of the three sources says and the
resulting state:

- `ALIGNED` — all three agree
- `INTENT_ONLY` — planned, not built
- `CODE_ONLY` — built, no stated intent
- `CODE_NO_RUNTIME` — exists in code, never observed to run or produce data
- `RUNTIME_NO_CODE` — happens in the running system, not in this repository
- `CLAIMED_DONE_UNPROVEN` — intent says complete, runtime provides no evidence
- `CONFLICTING` — sources actively contradict each other
- `INDETERMINATE` — one or more sources unavailable; cannot be reconciled yet

`INDETERMINATE` is not a failure of the run. It is an honest state, and downstream agents
must handle it rather than assume the optimistic reading.

## 6. Scope and cost

Full discovery of a large repository is expensive and mostly wasted. Discovery runs in
tiers:

1. **Orientation** (always, cheap) — identity, stack, structure, git state, agent and
   model capabilities, entry points. Enough to decide what matters.
2. **Goal-relevant depth** (always) — deep discovery of the subsystems the goal touches,
   plus their immediate dependencies and consumers.
3. **On-demand** — anything an agent later requests, dispatched as a targeted probe and
   merged into the package.

Coverage is recorded explicitly. An agent must be able to distinguish "the Auditor found no
orphan readers here" from "discovery never looked here" — conflating the two produces
confident wrong answers, which is the worst output AgentOS can generate.

## 7. Freshness

Context decays. Every assertion carries `observed_at`, and the package carries a freshness
policy: git and runtime state expire in minutes, repository structure in hours, product
intent in days. Stale assertions are marked `STALE` and re-probed on demand, never used
silently. See [DATA_SEMANTICS.md](DATA_SEMANTICS.md).

## 8. Security

The package is an artifact that persists and may be read by humans and models.

- Secrets are never captured. Credentials are referenced by name and location only.
- Production data samples are minimized and redacted; personal data is not copied into the
  package.
- The package records which sources were used and under what authorization, so that an
  unauthorized source is detectable after the fact.
