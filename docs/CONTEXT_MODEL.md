# Context Model

The Context Package is the durable, structured answer to "what is actually true about this
repository, its intent, and its runtime?" It is built by discovery probes, consumed by
every downstream agent, and persisted with the run.

It answers two questions that must not be confused. **What is true about the system** — the
bulk of the package. And **where this particular piece of work actually stands** — the
`current_reality` section, which is what makes resumption possible and re-execution
avoidable ([INTENT_AND_WORK_ITEM_RESOLUTION.md](INTENT_AND_WORK_ITEM_RESOLUTION.md) section
5).

It exists so that no agent has to re-derive context, and so that a human can audit what
AgentOS believed and why.

## 1. The two rules

**Rule 1 — every assertion carries a confidence class.**

- `FACT` — directly observed through an adapter, with a citable artifact.
- `INFERENCE` — derived from facts by reasoning. Must name the facts it derives from.
- `UNKNOWN` — not determined. Must name why, using the vocabulary in
  [DATA_SEMANTICS.md](DATA_SEMANTICS.md): `NOT_COMPUTED` (not attempted),
  `UNAVAILABLE` (unreachable, denied, timed out), `NOT_APPLICABLE` (out of scope for this
  subject), `INSUFFICIENT_EVIDENCE` (looked, found too little), or `CONFLICTING` (sources
  disagree and no rule selects a winner).

There is one absence vocabulary in AgentOS and this is it. A probe must not invent a
reason string.

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
`screenshot`, `metric`. The same closed set is used by the
[handoff envelope](AGENT_HANDOFF_CONTRACT.md); it is defined once in `contracts/`.

**Freshness is a second, orthogonal axis.** `CURRENT | STALE | UNKNOWN` describes the age
of an observation; the semantic vocabulary above describes the nature of a value. A value
can be `FACT` and `STALE` at once, and conflating the two axes loses exactly the
information that makes stale data safe to use.

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
  meta            run id, work item id, timestamps, probe coverage, package version
  work_item       -> the admitted Work Item (reference, not a copy)
  current_reality where this work actually stands: implementation, tests, PR, CI,
                  reviews, merge state, deployment, outcome evidence, children,
                  AgentOS history (section 5.5)
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

Three structural notes:

- `capabilities` is a reference into the Capability Registry rather than a copy. There is
  one representation of a capability per run.
- `work_item` is likewise a reference. v0.2's `goal` section is gone: the raw request now
  lives verbatim in the `IntakeRecord`, and the interpreted version is the admitted Work
  Item. Keeping a third copy in the package would give the run two answers to "what are we
  doing", and the one an agent happened to read would win.
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

### 5.5 Reconciliation at the work-item level

The same enum, the same probes and the same rule applied to the question "where does this
piece of work stand" rather than "does this capability work". Jira says `Done` with no
merged commit is `CLAIMED_DONE_UNPROVEN`. The AgentOS log records a PR that GitHub does not
have is `CONFLICTING`. An unreachable git host is `INDETERMINATE`, which is emphatically not
"there is no PR".

The authority rule that resolves the contradictions: **each source is authoritative about
its own subject and nothing else.** Git owns repository content and PR existence; the PM
system owns the ticket's own status and is at most an `INFERENCE` about the system; the
AgentOS event log owns what AgentOS did and says nothing about whether it still holds. The
full list is in
[INTENT_AND_WORK_ITEM_RESOLUTION.md](INTENT_AND_WORK_ITEM_RESOLUTION.md) section 5.1.

**`current_reality` is written only by probes.** No part of it may be derived from the
intake text, from a ticket's status field alone, or from an agent's account of a previous
run. An agent's claim about reality is recorded as a `claim` and ignored, exactly as a
branch-predicate claim is.

## 6. Scope and cost

Full discovery of a large repository is expensive and mostly wasted. Discovery runs in
tiers:

1. **Orientation** (always, cheap) — identity, stack, structure, git state, PM access,
   agent and model capabilities, entry points. Enough to resolve the work item.
2. **Work-item-relevant depth** (always) — deep discovery of the subsystems the admitted
   Work Item's `scope` touches, plus their immediate dependencies and consumers, and the
   `current_reality` set for that work item.
3. **On-demand** — anything an agent later requests, or the uncertainty ladder calls for,
   dispatched as a targeted probe and merged into the package.

Tier 1 runs before resolution; tier 2 runs after it. This is what answers a question v0.2
left open — *how does discovery know what is relevant?* It does not, until a Work Item with
a scope exists, which is why `RESOLUTION` precedes `CONTEXT_DISCOVERY` in the prologue.

Coverage is recorded explicitly. An agent must be able to distinguish "the Auditor found no
orphan readers here" from "discovery never looked here" — conflating the two produces
confident wrong answers, which is the worst output AgentOS can generate.

### Bounding context growth

The package grows across a run; an agent's input must not. Four rules keep them
independent:

1. **Envelopes carry references, never inlined context.** `context_package_ref` and
   `prior_envelopes` are ids. Transcripts are never passed.
2. **Each agent declares its required sections**, and the kernel materializes only those.
   The Architect needs `domain_model`, `data_map` and `api_map`; it does not need
   `git_state`.
3. **Discovery is tiered** (above), so depth is bought only where the goal needs it.
4. **The package is versioned, not appended.** On-demand discovery produces a new
   version; agents read one version, and superseded detail is retrievable from the store
   rather than resident in every dispatch.

If an agent needs more than its declared sections, it requests them — a recorded event,
which makes context appetite measurable instead of invisible.

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
