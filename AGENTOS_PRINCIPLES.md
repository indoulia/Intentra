# AgentOS Principles

Fourteen rules. Everything else in this repository is an elaboration of them. Where a
design decision conflicts with a principle, the principle wins.

## 1. The user provides a goal, not a briefing

The user must never be required to supply EPICs, architecture, source files, prior
decisions, skills, tools, model choices or test strategy. If AgentOS needs it, AgentOS
discovers it. Asking the human for context that is discoverable is a defect.

## 2. Runtime is truth; code is reality; intent is a claim

Three sources disagree constantly:

- **Project intent** (EPICs, issues, docs, decisions) — what someone wanted.
- **Code** — what was actually built.
- **Runtime and production** — what actually happens.

Reconciliation is mandatory, not optional. An EPIC marked Done is a claim. A passing test
is evidence about a test, not proof of capability.

## 3. Every fact carries a confidence class

Everything in the Context Package is `FACT`, `INFERENCE`, or `UNKNOWN`, with the evidence
that justifies it. **UNKNOWN never silently becomes FACT.** An agent that needs a FACT and
has only an INFERENCE must either produce evidence or declare a blocker.

## 4. Evidence over assertion

An agent's conclusion is worth exactly as much as the evidence attached to it. Findings
without a traceable artifact — file and line, query result, log excerpt, HTTP response,
commit SHA — are recommendations at best, never findings.

## 5. Completion is capability-level, never "tests pass"

A capability is complete when its whole chain works and is observable end to end:
source → ingestion → normalization → canonical store → intelligence → API → UI →
outcome → learning. Applicability is determined per capability, not assumed. Green tests
over a disconnected writer are green tests over nothing.

## 6. Orphans are first-class defects

Writers with no readers, readers with no writers, tables nobody queries, APIs with no real
data, UI with no backing capability, calculations whose results are discarded, source
fields dropped in normalization — these are bugs of the highest severity because they are
invisible to tests and to demos.

## 7. Absence has meaning, and meanings do not collapse

`ZERO`, `NULL`, `EMPTY`, `UNKNOWN`, `UNAVAILABLE`, `NOT_APPLICABLE`, `NOT_COMPUTED`,
`STALE`, `CONFLICTING`, `PARTIAL` and `INSUFFICIENT_EVIDENCE` are distinct. Collapsing
them — a fabricated default, a zero standing in for "we never computed it" — is data
corruption, and it is the single most common way a system lies to its users.

## 8. Architecture is owned, not improvised

The Architect owns the domain model, canonical ownership, contracts, lifecycle,
provenance and failure semantics. When an implementer meets a contradiction it returns
`BLOCKED_BY_ARCHITECTURE`. Inventing architecture mid-implementation is forbidden, and so
is patching a symptom to make a test go green.

## 9. Handoff is a contract, not a conversation

Agents exchange typed envelopes containing status, findings, evidence, assumptions,
unknowns, artifacts changed, recommendations, blockers and next action. Never transcripts.
An agent must be replaceable, resumable, and independently auditable.

**The kernel disbelieves agents.** Nothing an agent supplies — evidence, a branch-condition
claim, a report of what it changed, a path, a judgment that an action is safe — becomes
trusted state because it was well-formed. Every one of them passes a check the kernel
performs itself, with a component that is not the agent.

**The kernel is not an agent.** The component that enforces state, budgets, policy and
persistence is deterministic code with no model in it. The Orchestrator *Agent* advises it
and can be wrong without consequence. Agents depend on contracts, policies, registries and
adapters — never on kernel internals. A run's safety must not depend on a model behaving
well.

## 10. State is durable and survives interruption

A run is a persisted state machine plus an append-only event log. Killing the process,
closing the terminal, or losing the model mid-step must lose at most the current step, and
that step must be safely retryable.

## 11. Maximum autonomy, minimum necessary human gates

Inspect, analyze, design, edit, test, branch, commit and prepare a PR are ordinary
autonomous work and require no permission. Protected merge, production deployment,
destructive migration, irreversible data mutation and credential or security changes
require an explicit human decision, every time, per run. Autonomy is expanded by removing
unnecessary gates, never by weakening necessary ones.

## 12. Disagreement is resolved by evidence, not seniority

When two agents conflict, the resolution does not average, vote, or defer to the more
expensive model. The kernel settles what it can by rule — `FACT` beats `INFERENCE` beats
`UNKNOWN` — and the Orchestrator Agent names the discriminating evidence for the rest. If
no evidence can settle it, the conflict escalates to a human with both positions stated
fairly.

## 13. The security floor is absolute

Never expose or invent secrets. Never bypass access controls. Never weaken a test,
disable a safeguard, or lower a threshold to reach green. Never mutate production
silently. Never use an unauthorized data source. These are not policy defaults; there is
no configuration that turns them off.

## 14. AgentOS is repository-agnostic

No product's business logic, vocabulary, schema, skill or heuristic is compiled into
AgentOS. Repository-specific knowledge lives in the target repository or is discovered.
A target repository with no AgentOS-specific files must work fully.

---

**Answerability test.** At any moment a human must be able to ask "what is AgentOS doing
right now, why, on what evidence, and what will it do next?" and get an accurate answer
from durable state — not from a model's recollection.
