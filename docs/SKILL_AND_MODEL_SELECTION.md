# Skill and Model Selection

Skills and models are **discovered and ranked at runtime**, never hard-coded. AgentOS must
work on a host with a rich skill set and on a bare one, and must never assume a particular
product's tooling exists.

Both follow the same shape:

```
task -> requirements -> discover what exists -> rank -> select -> record -> observe
```

The final step matters: what was selected and how it performed is logged, so selection can
improve from evidence rather than from intuition.

## Part 1 — Skills

### Discovery

The host adapter enumerates every invocable capability:

- global skills (user-level)
- repository skills (project-level, including `.agent/skills/`)
- plugins
- connectors and MCP servers, **including those configured but unreachable**
- built-in tools
- repository scripts (`package.json` scripts, `Makefile` targets, `*.ps1`, `*.sh`)

Each entry records: identifier, source, description, declared inputs and outputs, declared
side effects, availability, whether it mutates anything, and three capability flags that
gate selection:

- **`spawns_agents`** — can this skill start another agent, session, subagent or task?
- **`external_destination`** — can it send anything outside the organisation's boundary?
- **`reversal`** — the operation that undoes it, or `null` for non-reversible.

### `spawns_agents` is a hard exclusion

**No agent may invoke another agent.** Direct invocation is already impossible — agents hold
no dispatch reference — but a skill that spawns a subagent is the same violation wearing a
tool's clothing, and on some execution substrates such tools are the default way to work.

Therefore: a skill with `spawns_agents: true` is **never selectable for an agent dispatch**.
Policy forbids it, the registry excludes it from candidate lists, and the host adapter
refuses the invocation if it is somehow requested. Three layers, because this one is
substrate-dependent and easy to reintroduce accidentally.

A skill whose spawning behaviour cannot be determined is treated as `spawns_agents: true`.
Same rule as everywhere: uncertainty takes the safer branch.

The kernel remains the only thing that starts an agent. Anything that appears in the run
narrative as work done by an agent must correspond to a dispatch event, and an agent
population that cannot be enumerated from the log is not a system anyone can reason about.

An unreachable connector is recorded `UNAVAILABLE`, never omitted. "This host has no Jira
access" and "Jira is configured but the server failed to connect" lead to different
decisions — the second is worth reporting to a human, the first is not.

### Task classification

The Orchestrator Agent classifies each dispatch along dimensions that actually change tool
choice: domain (repository analysis, git, database, API, UI, testing, deployment, project
management, documentation), operation (read, analyse, generate, mutate, verify), target
(filesystem, VCS, data store, network, runtime), and risk (read-only, reversible,
irreversible).

### Ranking and selection are different jobs

**The registries rank; the kernel selects.** Registries produce an ordered candidate list
with scores and reasons — deterministic, testable, model-free. The kernel picks from that
list, applies policy (a read-only task may not pick a mutating skill), and records the
choice. The Orchestrator Agent may express a preference in its proposed dispatch; it is an
input to ranking, not a bypass of it.

This split is why skill and model selection is not a place business logic accumulates: the
ranking rules live in `registries/` as data-driven scoring, not in kernel branches.

Rank candidates by:

1. **Capability match** — does it do the required operation on the required target
2. **Specificity** — a purpose-built skill beats a general tool
3. **Cost** — token and time cost, and whether it replaces expensive exploration
4. **Reliability** — observed success rate from prior runs
5. **Safety** — least privilege, least mutation; a read-only option always outranks a
   mutating one for a read task

### Selection rules

- **Never invoke a mutating skill for a read-only task.**
- **Prefer repository-provided skills** over generic ones when both fit — the repository
  knows its own conventions.
- **Fall back explicitly.** If the preferred skill is unavailable, the fallback and the
  reason are recorded. Degraded capability is stated, never hidden.
- **Declare unmet needs.** If no available skill can perform a required operation, the
  agent returns `BLOCKED` with `MISSING_CAPABILITY` rather than improvising something
  unsafe.
- **Skills are suggestions to the agent, not obligations.** A poor tool used dutifully is
  worse than no tool.

### Anti-requirements

No product's skills are referenced anywhere in AgentOS. If Marksy provides a skill, AgentOS
finds it because Marksy exposes it — not because AgentOS was told it exists. Any
product-specific identifier appearing in AgentOS code or policy is a bug.

## Part 2 — Models

### Discovery

The host adapter enumerates reachable models with, where knowable: context window,
reasoning capability, coding capability, vision capability, tool-use capability, cost per
token, latency, and rate limits.

Where a property is not knowable it is `UNKNOWN`, and selection must degrade sensibly
rather than assume the best case.

### Requirements per dispatch

Each agent declares what it needs, not which model it wants:

- **context** — how much of the Context Package and how many artifacts must be in view
- **reasoning depth** — shallow extraction versus deep architectural reasoning
- **coding** — does it write code
- **vision** — does it evaluate screenshots or diagrams
- **tool use** — how many adapter calls, how interdependent
- **precision requirement** — does an error here corrupt everything downstream

### Selection

Choose the **cheapest model that meets the requirements**, then escalate on evidence.

Typical assignments, indicative and not binding:

- Context Discovery probes — cheap and fast; extraction and structuring, high volume
- Context reconciliation — mid; genuine cross-source judgment
- Auditor — high; this is adversarial reasoning about a system that looks fine
- Architect — highest; errors here propagate through everything after
- Implementer — high coding capability; long context for repository conventions
- Validator — high; must resist the temptation to accept plausible-looking output
- Product/UX — vision capability where screenshots exist; mid otherwise
- Production — high precision; consequences are irreversible
- Orchestrator Agent — mid, except arbitration, which is high (the kernel itself uses no
  model)

Escalation triggers, all evidence-based: the agent returned `PARTIAL` or `FAILED`; output
failed schema validation twice; the agent's own stated confidence is low; arbitration is
required; the work unit is on the critical path of an irreversible action.

Escalation is bounded — at most one escalation per dispatch — and recorded with its
trigger.

### Degradation

If the preferred model is unavailable, AgentOS may proceed on a lesser model **only** for
work whose precision requirement it still meets. Otherwise the run blocks. Proceeding on an
inadequate model and reporting the result as normal is a form of dishonesty the evidence
model is built to prevent — and the degradation, if it happens, appears in the run report.

### No model at all

Model unavailability is an ordinary, expected condition, not an exception.

A dispatch that cannot obtain any adequate model returns `FAILED`. The kernel retries per
policy, then transitions to `BLOCKED` with `EXTERNAL_DEPENDENCY`. The state does not
advance, no envelope is merged, and the run resumes at the same point when a model returns.

Everything the kernel does — schema validation, cross-field consistency, evidence
verification, transition predicates, mutation reconciliation, gate classification,
authorization lifecycle, DoD arithmetic, recovery — runs with no model in the loop. A run
with zero available models makes no progress and suffers no corruption. That is the
intended behaviour, and it is the sharpest statement of the kernel boundary: **the kernel's
correctness is independent of model availability, not merely of model quality.**

### Recording

Every dispatch records the model, why it was chosen, cost, outcome and any escalation. Over
time this yields real data on which model tier is actually needed for which role, which is
how selection heuristics get replaced by measurements.
