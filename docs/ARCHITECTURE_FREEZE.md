# Architecture Freeze — v0.3

Frozen 2026-09-04, against commit `8edda5a`.

Architecture v0.3 is the implementation baseline. From this point the design is not a living
draft: it is a specification that code is written against, and a disagreement between code
and document is resolved by amending the document, never by deciding locally.

The freeze exists because of a specific failure mode. A design that keeps moving while code
is written against it produces components built to different versions of the same idea, and
the drift is invisible until two of them meet. Nothing in v0.3 needs to move for the first
milestone to be built, so nothing may.

## 1. The frozen set

Fourteen normative documents. Their content is pinned by hash in
[freeze/v0.3.sha256](freeze/v0.3.sha256), verifiable from the repository root:

```
sha256sum -c docs/freeze/v0.3.sha256
```

The manifest hashes LF content, and `.gitattributes` pins `*.md` to `eol=lf` so that it
verifies on a fresh clone regardless of the platform's line-ending default. Without that
pin the freeze would be checkable only on the machine that created it, which is not a
freeze.

- `AGENTOS_PRINCIPLES.md` — `a3914787ce6d0b66`
- `docs/AGENTOS_ARCHITECTURE.md` — `1573a60c51c2a388`
- `docs/KERNEL_BOUNDARY.md` — `78113d17cdca79cf`
- `docs/INTENT_AND_WORK_ITEM_RESOLUTION.md` — `4399cb1cef5dd7a9`
- `docs/AGENT_ROLES.md` — `deac3f391abda1bb`
- `docs/CONTEXT_MODEL.md` — `00cb581a3d7de54a`
- `docs/DATA_SEMANTICS.md` — `82248789997a6e23`
- `docs/CAPABILITY_MODEL.md` — `49953fc71f677f61`
- `docs/WORKFLOW_STATE_MACHINE.md` — `0f18f45ea7715854`
- `docs/AGENT_HANDOFF_CONTRACT.md` — `894082be8aeb540e`
- `docs/DEFINITION_OF_DONE.md` — `4a96122456712c78`
- `docs/HUMAN_AUTHORIZATION.md` — `4727e64466bb653a`
- `docs/SKILL_AND_MODEL_SELECTION.md` — `318c589f230da316`
- `docs/REPOSITORY_ADAPTER.md` — `9c224a03a1071842`

A hash mismatch means either an unrecorded amendment or an accident. Both are defects, and
the manifest exists so that neither can be mistaken for the baseline.

## 2. What is not frozen

- **`README.md`, `docs/README.md`** — navigation. Expected to change as documents are added.
- **`docs/IMPLEMENTATION_ROADMAP.md`** — the phase map and its readiness marks. Superseded
  for milestone 1 by [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), which is the
  executable version of the same sequencing; the roadmap remains the statement of *why* the
  order is what it is, and the pilot protocol in its section 12 is still authoritative.
- **This document and the plan** — they record decisions and sequencing, which is exactly the
  material that should move as measurement replaces assumption.
- **The directory `README.md` files** — they describe intent per directory and will gain
  implementation detail.

## 3. What the freeze obliges

**Implementation may not reinterpret a frozen document.** Where a document is silent, the
implementer records the gap and the plan's work package names who resolves it. Where a
document is wrong, that is a documentation defect and it is fixed by amendment before the
code that depends on it is written.

This is the same rule the architecture already applies to its own agents. An implementer
that meets a contradiction returns `BLOCKED_BY_ARCHITECTURE` rather than inventing
architecture mid-implementation (principle 9); the freeze applies that rule to the humans
and sessions building the kernel.

**Amendment protocol.** Four steps, and the third is the one that matters:

1. State the contradiction or gap concretely, naming the document and section, and the
   worked example or test that exposes it.
2. Decide the amendment against the principles. Where a proposed amendment conflicts with a
   principle, the principle wins and the amendment is wrong.
3. **Apply the amendment to the document, bump the affected contract's version if a shape
   changed, and record both in section 9 of this file.** A change that reaches code without
   reaching the document reintroduces exactly the drift the freeze prevents.
4. Re-run the manifest and commit the new hash with the amendment.

An amendment that changes a contract shape is a version bump on that contract, not a silent
edit — `contracts/` is the stable surface, and the whole point of versioning it is that a
consumer can tell whether it is looking at the shape it was built against.

**A new architecture version (v0.4) is required** for anything that changes the kernel
boundary, the dependency rule, the stage vocabulary, the envelope, the confidence or absence
vocabularies, or the authorization gate set. Those are the load-bearing agreements; moving
one is not an amendment, it is a new baseline.

## 4. Decisions closed at the freeze

Six of the eleven open decisions in IMPLEMENTATION_ROADMAP section 11 are settled here: five
closed outright (D-1 to D-5), and static-analysis depth (D-6) adopted provisionally with its
resolution scheduled inside the MVP rather than left to drift. Each records what would
reverse it, because a decision whose reversal condition is unstated tends to be defended
rather than revisited.

### D-1 — Implementation language: TypeScript

Node 22 LTS, ESM, `strict` throughout.

The deciding factor is that contracts are the product. JSON Schema is the source of truth
and TypeScript types are generated from it, so the schema and the types cannot drift — the
failure that would otherwise appear the first time a hand-written type and its schema
disagree about an optional field. Discriminated unions with exhaustiveness checking give the
envelope-status-to-kernel-action mapping (WORKFLOW_STATE_MACHINE 4.2) a compile-time
guarantee that every status has exactly one action, which is a rule the design states and
would otherwise be tested for. And the dependency rule is mechanically enforceable: one
package per directory, so `agents` cannot import `core` because its manifest does not
declare it.

Static analysis of target repositories is not a factor, because it lives behind adapters and
runs whatever tool suits the target language. Choosing a language for the kernel does not
choose one for the repositories it audits — and if it did, that would be a principle 17
violation.

**Reversed by:** the substrate decision changing to something with no TypeScript client, or
a measured need for in-process analysis of a language whose tooling is unreachable from
Node. Neither is currently in evidence.

### D-2 — Agent execution substrate: Claude Agent SDK, one session per dispatch

Each dispatch is a fresh non-interactive session. No session is reused across dispatches and
no conversation is carried between them, which is what the handoff contract already
requires: the envelope is the only transport, and transcripts are never passed.

**This decision carries one binding condition, and it is not optional.** The Agent SDK is
the Claude Code harness as a library, so it arrives with built-in file, shell, search and web
tools and with subagent spawning. AgentOS requires the opposite posture — all outside-world
access through adapters (KERNEL_BOUNDARY dependency rule 5), and no agent able to invoke
another agent (invariant W5). Making the SDK satisfy that is therefore a *subtraction*
problem, and subtraction fails open: a future SDK version that adds a built-in tool silently
widens every agent's reach unless the kernel is configured to allow rather than to deny.

So the condition:

- **The tool surface is an allowlist, never a denylist.** The effective tool set for a
  dispatch is exactly the adapter operations the kernel exposes as in-process tools, and
  every built-in tool is absent rather than forbidden.
- **No subagent or task-spawning tool is ever exposed.** Undetermined spawning behaviour
  counts as spawning, which the design already states.
- **A startup conformance check asserts the effective tool list equals the adapter set**, and
  fails the run — loudly, before dispatch — if it does not. An SDK upgrade that adds a tool
  must break this check rather than pass quietly.

The exact configuration surface must be read from the Agent SDK documentation
(`code.claude.com/docs/en/agent-sdk`) when WP-5 is built and not assumed from recollection;
the requirement above is behavioural and is what the check must verify, whatever the options
are called.

**Reversed by:** the allowlist condition proving unachievable on the SDK. The fallback is the
Anthropic SDK's tool runner (`@anthropic-ai/sdk`, `client.beta.messages.tool_runner`), which
has no built-in tools and no spawning, so adapter-only reach is true by construction rather
than by configuration. It costs more kernel code — the host adapter can enumerate far less —
and it costs no redesign, because the handoff contract is transport-agnostic precisely so
this can change late. Keep the dispatch boundary narrow enough that swapping it is a
one-file change; if it is not, that is a defect in the dispatch layer.

### D-3 — Run store backend: files

`work-item.json`, `run.json`, `events.ndjson`, and the run subdirectories exactly as
WORKFLOW_STATE_MACHINE section 7 lays them out. No database.

Inspectability is the reason. Every recovery property in the design is "replay the log", and
a log a human can read with `cat` during an incident is worth more than one that needs a
client. The lease needs atomic create, which the filesystem provides.

**Reversed by:** measured contention from concurrent runs against one work item, which the
lease is designed to make a refusal rather than a race. Revisit at phase 7, not before.

### D-4 — Work item identity without an external key: exact scope plus normalized title

The conservative first cut the roadmap already proposed: a content-derived id, and a
similarity check that matches only on identical scope and a normalized title. It will
under-match, surfacing two work items where one existed, and that is the correct direction to
be wrong in — a missed duplicate costs a surfaced candidate, while a wrong merge destroys
history. Candidates are surfaced, never auto-merged, which the design already requires.

**Reversed by:** measured duplicate rates high enough to be operationally annoying. The
replacement must still be deterministic and model-free, because it sits in the kernel.

### D-5 — Intake trust classification: closed for the CLI host only

The MVP has one host. The CLI host asserts `principal` from the authenticated OS user and
`trust_class: OPERATOR`. Every other source classifies `EXTERNAL` until a host exists that
can assert a principal for it, per the rule the design already fixes: a host that cannot
assert a principal must classify as `EXTERNAL`.

This closes the decision for the MVP and leaves it open per additional host, which is the
honest shape — what a host can assert is a property of that host and cannot be decided in
advance for hosts that do not exist yet.

**Reversed by:** nothing; extended by each new host, and each extension is a policy data
change in `intake.json` plus that host adapter's assertion, never a kernel change.

### D-6 — Static-analysis depth: provisional, resolved by measurement inside the MVP

Adopted provisionally as the roadmap's own hypothesis: cheap structural analysis for graph
edges, model reasoning for semantics. Structural edges are `INFERENCE`; edges confirmed by
tracing a real record through a runtime are `FACT`, which is what CAPABILITY_MODEL section 5
already requires.

This is the one decision the freeze does not actually close, and pretending otherwise would
be the wrong kind of tidy. It is resolved by the spike in WP-7, whose result is recorded here
as an amendment. The plan is arranged so that a disappointing result costs the graph and not
the milestone: data-semantics analysis, test-quality analysis and the reconciliation matrix
are pattern-based, independent of the graph, and ship regardless.

**Resolved by:** WP-7's measured recall and precision of structural edges against
hand-verified ground truth in the pilot repository.

## 5. Decisions deliberately left open

Five, none of which blocks milestone 1. Each carries what it may not be allowed to block,
because an open decision that quietly becomes a dependency is how a plan stalls.

- **Capability identity across runs** (phase 3). How a capability keeps a stable identity as
  code changes. **May not block the MVP:** the MVP builds a single-run registry, and
  carrying records forward into `.agent/capabilities.json` is deferred until identity is
  settled. A record carried forward under an unstable identity is worse than no record.
- **Cost model** (phase 2). Whether tiered discovery is sufficient for a large repository is
  unmeasured. **May not block anything:** it is measured by the pilot, which reports tokens,
  wall clock and human review time as a first-class output. Budgets in
  `policies/budgets.json` make the unmeasured case survivable — an expensive run blocks
  rather than surprising someone.
- **Product/UX evidence acquisition** (phase 5). Screenshots require running the application.
  Outside the MVP entirely, which writes nothing and reviews no UI.
- **Human interaction channel** (phase 6). Where authorization requests appear. Outside the
  MVP, which gates nothing because it mutates nothing. The grant *contract* and its
  adapter-side check are still built in the MVP — see the plan's WP-4 — so that the channel
  is the only thing left to decide later.
- **Multi-repository capability graphs** (phase 7). Sketched, not specified.

## 6. What this freeze does not claim

It does not claim the architecture is right. It claims the architecture is **settled enough
to build against**, which is a different and much weaker statement, and the pilot in
IMPLEMENTATION_ROADMAP section 12 is where the stronger one is tested.

Two residual risks are carried forward from v0.3 unchanged, and both are stated rather than
closed:

- **A plausible wrong reading of a legitimate request flows downstream as the run's statement
  of purpose**, and no mechanical check separates plausible-and-wrong from right. The
  mitigations are the narrative obligation and `WORK_ITEM_MISCLASSIFIED`. This is why the
  resolution dispatch gets the tightest test in the plan.
- **The kernel's disbelief machinery is only as good as its adapters.** Every check the
  kernel performs itself is performed through an adapter, so an adapter that misreports is a
  single point of trust. Path confinement, fail-closed classification and the call log are
  the mitigations, and they are all in one place on purpose.

## 7. The exit criterion, answered

> Can another engineer implement this architecture without having to invent missing
> architectural decisions?

**For milestone 1, yes.** Every work package in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
is `READY` or `NEEDS CONTRACT`, and nothing in it is `BLOCKED`. The three decisions the
roadmap identified as sitting inside the MVP are closed (D-1, D-2) or scoped so that the
milestone survives either answer (D-6).

**Beyond milestone 1, not yet**, and deliberately so: the human interaction channel and UX
evidence acquisition are genuinely better decided after a read-only AgentOS has been run
against real repositories by real people. Deciding them now would be guessing with more
ceremony.

## 8. Amendment log

None. Amendments are appended here with date, the document and section changed, the
contradiction that prompted the change, and the contract version bumped if any.
