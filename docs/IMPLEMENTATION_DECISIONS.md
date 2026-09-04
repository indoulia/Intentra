# Implementation Decisions

Decisions taken while implementing the frozen v0.3 architecture that the frozen documents do
not settle, recorded here so that none of them has to be re-derived from the code.

This is not an amendment log. Where implementation met a *contradiction* with a frozen
document, the fix landed in the document and is recorded in
[ARCHITECTURE_FREEZE.md](ARCHITECTURE_FREEZE.md) section 8. What follows is the other
category: choices the architecture leaves open, made conservatively and stated once.

Each entry records what was decided, why, and what would reverse it.

---

## WP-1 — the contract set

### I-1 · `@agentos/contracts` carries its own JSON Schema validator

The package declares no dependencies, and WP-1's exit test says so. A schema validator is a
dependency. So the package carries a JSON Schema 2020-12 validator implementing exactly the
keyword set the AgentOS schemas use, in `contracts/src/validator/`.

The keyword set is a closed allowlist, and an unsupported keyword is a **load-time error**
rather than a silently ignored constraint — a constraint nobody enforces is worse than one
nobody wrote. `default` is refused outright, which turns WP-1's "must not contain a default
that invents a value" from an audit into a mechanism.

The obvious cost is confidence: a hand-written validator is not a widely used one. That is
bought back by `tools/bin/ajv-parity.mjs`, which compiles the same schemas with `ajv` — a
build-time devDependency in `tools/`, never a dependency of the package — and requires the
two to agree on every instance the suite exercises, deliberate invalids included. It also
asserts every schema document is itself a valid 2020-12 schema, which the AgentOS validator
does not attempt.

**Reversed by:** a schema needing a keyword whose implementation is genuinely subtle
(`$dynamicRef`, `unevaluatedItems`, full `format` assertion). At that point the honest move
is to take the dependency and drop the exit test, not to write a subtle validator.

### I-2 · Schemas are embedded in a generated module, not read from disk

`contracts/src/generated/schemas.ts` carries the schema documents as frozen objects, emitted
by the same codegen pass that emits the types. `@agentos/contracts` therefore does no I/O at
all, which the conformance check enforces.

The alternative — reading `contracts/schema/*.json` at import — would have made the contract
package a second, quieter exception to "all outside-world access goes through adapters," and
would have made it unusable anywhere the files are not laid out as they are in this
repository.

### I-3 · Generated type names come from an explicit table, not a heuristic

`tools/lib/names.mjs` maps each `<schema>#/$defs/<name>` to a TypeScript identifier. A
missing entry is an error rather than a default.

Two `$defs` called `unknown` exist in different schemas — the `UNKNOWN` assertion variant and
the envelope's unknown record — and any heuristic that resolved that collision silently would
also silently rename a type the day a schema gained a definition. Event-log branches take a
`LogEvent` suffix (`MutationLogEvent`) so they cannot collide with the contract shapes they
carry (`MutationEvent`).

### I-4 · Enum and event fixtures are built, not stored

The plan asks for one valid fixture per control-flow-bearing enum value and treats a value
with no fixture as a value nothing has ever exercised. `contracts/src/fixtures.ts` provides
builders and `contracts/test/enum-coverage.test.ts` closes a loop over the vocabulary read
out of the schemas.

This is stronger than a directory of files, not weaker: a value added to a schema without a
builder case **fails the test**, where a file-per-value scheme would leave it silently
unexercised. The vocabulary itself is read from the schema at runtime
(`contracts/src/vocab.ts`), so there is no second list of enum values to keep in step.

Cross-field-rule fixtures are the mirror image and live with the checker that exists to
reject them, in `core/`, for the same reason: the rule and the instance that violates it
belong next to each other.

### I-5 · `Assertion.evidence` admits an id or an inline `Evidence`

Recorded as a decision rather than an amendment because neither document was wrong. A Context
Package assertion stands alone and carries its evidence inline; an envelope carries an
`evidence[]` pool and its assertions cite ids. Both forms are in the frozen set, both are the
same evidence, and the contract admits both.

### I-6 · `Assertion.probe` is required, and means "probe or dispatch"

Every assertion names its source, agent-authored inferences included. An optional `probe`
would have left the most consequential assertions in the system — the resolution's — as the
ones with no provenance.

---

## WP-2 — policy data and the loader

### I-11 · `policies/` reads its own data directory, and that is the whole exception

The policy loader touches the filesystem. KERNEL_BOUNDARY rule 5 sends all outside-world
access through adapters, and this is a stated exception rather than a hole in it: the adapters
exist to reach the *target repository* and external systems under path confinement and a call
log, and policy loading is AgentOS reading its own installation at startup. Routing it through
the adapters would be circular, because path confinement reads `paths.json`.

The exception is kept honest three ways. It is one file, `policies/src/data-source.ts`. That
file resolves the policy data root once and refuses any path that escapes it — the same rule
the repository adapter applies to a worktree, applied here because a confinement claim needs
an enforcement point wherever it is made. And `tools/bin/conformance.mjs` holds a list of
named I/O exceptions with the decision that permits each, fails on any file not on it, and
fails again on any entry that has become stale.

### I-12 · "before" and "after" in the workflow floor are dominance, not position

`MERGE requires VALIDATION and AUTHORIZATION before it` cannot mean "earlier in a list",
because the graph branches. It means **every forward route from the entry to `MERGE` passes
through them** — graph dominance — and the "after" rules are post-dominance.

This is not a reading imposed on the documents; it is the only reading that holds. It is also
what caught a real defect while authoring `change_request.land`: the summary in
WORKFLOW_STATE_MACHINE 3.2 routes an approved PR `PR_REVIEW → AUTHORIZATION → MERGE`, and
entered at `PR_REVIEW` with an already-approved PR that route reaches `MERGE` without AgentOS
having validated anything. Resumption does not save it — the DoD would compute `INCOMPLETE`
at `COMPLETION` and route back, but the merge has already happened by then, which is precisely
what the floor exists to prevent. The template therefore routes approval through `VALIDATION`
before `AUTHORIZATION`. Templates are policy data rather than frozen text, so this is an
authoring decision and not an amendment.

### I-13 · Excluding an optional stage requires the template to carry a bypass

Excluding a stage removes it and every edge incident to it. A template whose optional stage
sits on the only route through is a template that becomes disconnected when the stage is
excluded — mid-run, on a graph nobody checked. So the loader checks well-formedness for the
full template **and for every graph a legal exclusion produces**, which forces each optional
stage to be wrapped in a complementary branch pair: `A → X when P`, `A → B when NOT P`,
`X → B`.

Two consequences follow. Optional stages sharing one applicability predicate form one
exclusion **group** and are excluded together — which is why `DEPLOY` and
`PRODUCTION_VALIDATION` cannot be separated, and a deploy nobody validates afterwards is
unexpressible. And when exclusion leaves a lone `branch` edge, it is rewritten as an
`advance`: the stage was excluded because its predicate is `FALSE`, so the surviving arm no
longer represents a decision.

### I-14 · An optional stage with no applicability predicate cannot be excluded by a proposal

Exclusion requires the kernel to evaluate a predicate `FALSE`. A stage with no predicate has
nothing to evaluate, so no proposal can exclude it — and the loader's exclusion groups skip
it. `investigation.readonly` marks both `AUDIT` and `ROOT_CAUSE` optional, but only `AUDIT`
carries a predicate. That asymmetry is deliberate: the `COMPLETION`-only parameterization of
WORKFLOW_STATE_MACHINE 5.3 is admitted by the *kernel* from observed reality, never proposed
by an agent.

### I-15 · A template must be able to supply its own profile's critical criteria

`NOT_VALIDATED` is never `MET`, and `INCOMPLETE` is what a critical criterion not met
produces. So a template whose default profile makes critical a criterion that no stage in that
template owns can only ever compute `INCOMPLETE`, route back to a stage that does not exist,
and never terminate. The loader checks it.

Non-critical criteria are the opposite case and are allowed to come out `NOT_VALIDATED`: that
is `COMPLETE_WITH_GAPS`, which is a terminal verdict requiring human acknowledgement, and it
is exactly what DEFINITION_OF_DONE section 7 asks for when an Epic's children all shipped and
its outcome has no supporting evidence.

Applying this check is what raised amendment A-14: `epic.coordinate` had no stage the Validator
owns, so the Epic's own outcome verdict was owed to nobody.

### I-16 · Prologue events are written to an intake log and replayed into the run log

Intake recording, resolution dispatch and work-item admission all happen *before* a Workflow
Run exists, and every one of them can fail in a way a human needs to see. Writing them into a
run log that does not exist yet is impossible, and holding them in memory until one does would
lose exactly the events that explain why no run was ever created.

So the prologue writes to `state/intake/<intake_id>/events.ndjson`, and when a run is created
its prologue is replayed into the run log with the same content and fresh sequence numbers.
Both logs are append-only and both are durable, so a crash anywhere in the prologue leaves a
readable account of how far it got.

### I-17 · The resume order is the template's declared stage order

The resume sweep needs an order over the graph, and deriving one with Kahn's algorithm over
the forward edges is wrong for these graphs: the repair stages — `REWORK`, `REVIEW_TRIAGE`,
`COMMENT_RESOLUTION` — are reachable only through loop edges, so excluding loops to break the
cycles leaves them with no incoming edge at all and hoists them to the front. That put
`REWORK` second in `defect.standard` and made every resumed defect enter there.

The order is therefore the one the template declares, which is also the order a reviewer reads.
That makes the declaration order load-bearing, so `checkWellFormed` now checks it: the entry
must be the first declared stage, and no forward edge may run backwards through the
declaration unless it closes a cycle — which `change_request.land` legitimately does, looping
`STRUCTURAL_REAUDIT -> PR_REVIEW` back to its own entry, and a template that merely listed its
stages out of order does not.

### I-18 · The replay fixture loader is a named I/O exception

`core/src/replay/fixture.ts` reads a directory the operator names on the command line. It is
the same shape of exception as [I-11](#i-11): a boundary through which recorded data enters,
confined to one file, with everything validated against the contracts before the kernel sees
it. Nothing the kernel *decides* with does I/O — the ports a replay builds are in-memory and
answer from what was loaded.

The alternative was a separate package for the replay tool, which would have moved the same
I/O somewhere else and made `agentos replay` depend on a package that exists for one file.

### I-19 · `agentos work` is absent from this build rather than stubbed

The plan lists the CLI under WP-3, and three of its four commands are complete there:
`status` and `narrate` read the store, and `replay` drives the entire kernel from recorded
envelopes. `work` cannot be: starting a real run needs a live adapter registry (WP-4), an
agent substrate (WP-5) and a discovery implementation (WP-6), and the plan's own sequencing
puts all three after WP-3.

So the command is **not present**. Invoking it prints what is missing and exits non-zero. A
command that accepted the invocation and then did nothing useful would be a stub in
production, which is exactly what the conformance check exists to catch — and it would hide
the dependency rather than state it.

This is a dependency error in the plan rather than a decision about the design: "CLI and
projections" is listed as a WP-3 deliverable, and one quarter of it depends on WP-4 through
WP-6. The smallest correction is to build the three commands that only need the kernel and
the store, and to add `work` when the last port it needs exists.

---

## Cross-cutting

### I-7 · Ports live in `contracts/`, and the kernel's outward edges are injected

`contracts/src/ports.ts` declares the interfaces across which the kernel meets what it does
not contain: `AgentSubstrate`, `AdapterRegistry`, `DiscoveryPort`, `Registries`, `Clock`,
`HumanChannel`. They name only contract shapes, so `contracts/` still depends on nothing and
no port exposes a kernel internal.

This is what keeps `agents -> core` unnecessary rather than merely discouraged, and it is what
lets the kernel re-probe a stale reality element (WORKFLOW_STATE_MACHINE 4.3) without the
kernel package depending on `discovery/`.

### I-8 · `core/` declares `agents` and `discovery`, narrowed to one file

The plan's dependency table lists core's dependencies as contracts, policies, registries,
adapters and state. It also asks `dependency-cruiser` to enforce "`core -> agents` other than
through the dispatch interface", which presumes some edge exists to narrow.

The resolution: `core/package.json` declares both, so module resolution works, and
`.dependency-cruiser.cjs` permits the edge **only** from `core/src/composition/`. Every other
file in `core/` naming either package is a boundary violation that fails the build. The
delete-core test still passes, because nothing under `agents/` names `core/` in either
direction.

### I-9 · Node's built-in test runner, over compiled output

No test framework dependency, and tests run against exactly the JavaScript that ships.
`tools/bin/test.mjs` discovers test files rather than globbing a hand-written list, because a
package left out of a glob is a package nobody notices is untested. It reports the file count
per package, so a package with zero tests is visible rather than absent.

---

## WP-4 to WP-8 — reach, judgment and the read-only MVP

### I-20 · The Agent SDK is a declared dependency of `agents/`, and the only third-party one

D-2 selects the Claude Agent SDK as the execution substrate. A substrate is a transport, and
a transport has to be depended on rather than described, so `@agentos/agents` declares
`@anthropic-ai/claude-agent-sdk` and `tools/bin/conformance.mjs` carries the permission as a
named entry beside the dependency table — the same shape as the I/O exceptions, and for the
same reason: "AgentOS depends on nothing but its own contracts" is only worth saying if the
exceptions are countable.

It is one package, in one package, reached from one file
(`agents/src/substrate/claude-agent-sdk.ts`, already the named I/O exception), behind the
`AgentSubstrate` port declared in `contracts/`. That is what makes D-2's reversal clause real:
swapping to the Anthropic SDK's tool runner replaces that file and nothing else, and no other
package learns that the substrate changed.

The conformance check fails three ways rather than one: on a third-party dependency in any
package with no recorded decision, on any change to the `@agentos/*` edges, and on a
permission that has gone stale because the manifest no longer declares what it permits.

**Reversed by:** D-2's own reversal — the allowlist condition proving unachievable on the SDK.
The replacement is a dependency too, so what changes is which name is on the list, not whether
the list exists.

---

## WP-6 and WP-7 — resolution, the uncertainty ladder, and orchestration

### I-21 · The common safe prefix is computed over template stages

`INTENT_AND_WORK_ITEM_RESOLUTION.md` section 7 rung 3 states the mechanism and then gives an
example the mechanism cannot produce. The mechanism: "intersect the candidate templates' stage
sequences from the entry node, take the longest common prefix, and admit it only if every stage
in it is declared non-mutating in the stage vocabulary." The example: "in practice that prefix
is `CONTEXT_DISCOVERY → AUDIT`."

`CONTEXT_DISCOVERY` is a **prologue** stage. It is kernel-owned, runs in every run, and is
excluded from `templateStage` by construction (`contracts/schema/common.json`), so it appears
in no template's `stages` and no intersection of template stage sequences can ever yield it.

`commonSafePrefix` implements the mechanism, over template stages. The example is read as prose
about what the prologue plus the prefix look like together from the outside — the prologue does
run first, and does run `CONTEXT_DISCOVERY` — rather than as a claim about what the
intersection returns. For scenario I's three surviving candidates the intersection is computed
from `defect.standard`, `investigation.readonly` and `change_request.land`, and truncated at
the first stage not declared non-mutating.

Two consequences worth stating because they are not obvious:

- **A single candidate still has a prefix.** Where only one template is admissible, every stage
  in it is what AgentOS would do whichever reading is right, so the whole non-mutating head of
  it is the prefix. This is what makes `investigation.readonly` "the target of ambiguity rung 3"
  true in the read-only build rather than only in principle.
- **The candidate set spans the alternative readings.** The templates intersected are those
  admissible for the admitted type *and* for every `alternatives[].type`, because the ambiguity
  the ladder exists for is about which reading is right. Intersecting one type's set alone would
  answer a question nobody asked.

**Reversed by:** an amendment making the prologue expressible in a template's stage sequence,
which would be a much larger change than this paragraph.

### I-22 · Gate classification and the grant check reach `adapters/` as injected ports

`KERNEL_BOUNDARY.md` puts gate enforcement in `adapters/`, and `core/src/authorization.ts` says
`checkGrant` "is called from the adapter". `.dependency-cruiser.cjs` makes `adapters -> core` a
hard error, and rightly: the adapters are the enforcement surface and must not depend on the
thing they enforce for.

The resolution is a function port rather than an import. `core/`'s composition root builds a
`GrantEnforcer` and a `GateClassifierPort` closure over the policy set and the store and hands
them to the adapter registry, so both still execute **inside the adapter at call time** and no
dependency edge is created. The rule lives in `core/`; the enforcement runs in `adapters/`.

The port also closes a shape gap. `AdapterCallContext.grantsHeld` is a list of grant **ids** —
an adapter has no business holding grant records — and `checkGrant` needs the records, so the
injected closure is what resolves one into the other. Only grants the dispatch actually carries
are considered: a grant recorded for the run that this dispatch was not handed is not permission
this dispatch holds, and "some dispatch in this run has one" is exactly the transfer a
non-transferable grant forbids.

`GrantEnforcementRequest` and `GrantEnforcementVerdict` are declared in `core/` and match the
adapter framework's grant-checker port structurally rather than by import, for the same reason
the closure exists at all: `core/src/authorization.ts` naming `adapters` would be the boundary
violation outside `core/src/composition/`. Structural compatibility is what lets the composition
root hand one straight to the other with no edge in either direction.

**Reversed by:** moving the gate policy into `adapters/`, which would put policy interpretation
behind the enforcement boundary instead of in front of it.

### I-23 · Two contract gaps are carried as events rather than as fields

Neither is fixed by widening `contracts/`, because both are frozen-schema questions rather than
implementation choices. Both are reported.

**`WorkItem` has no `intent` field.** Resolution produces an `intent` assertion, and the
narrative's v0.3 obligation is to state what AgentOS decided the work was and why — "a run that
did the wrong thing correctly is the new failure mode this layer introduces, and it is invisible
unless resolution is narrated alongside execution". An intent nothing durable records is an
obligation nothing can discharge, so it is written to the **work-item** event log as a `note`
with topic `intent`, carrying the assertion, its confidence, its probe, the admitted type, the
resolver's own confidence and every rejected alternative. The work-item log is the right home
because intent outlives the run, exactly as the work item does.

**`IntakeRecord.principal` is a required object with a non-empty `id`.** A host that cannot
assert a principal must produce *absence*, and the record cannot express it. Fabricating
`{ id: 'unauthenticated' }` reads as an identity — "the unauthenticated user" — which is the
fabricated default `DATA_SEMANTICS.md` exists to forbid: it converts an operational fact
(nobody was authenticated) into a confident claim about who asked. So the id is the marker
`(no principal asserted)`, the absence is carried structurally on the intake result, and the
kernel records a `note` stating that the host asserted nobody. The intake classifies `EXTERNAL`
either way, which is the behaviour D-5 actually turns on.

**Reversed by:** an amendment making `principal` nullable and adding `intent` to the work item,
at which point both events become redundant with a field.

### I-24 · An unreadable capability registry is `INDETERMINATE`, not an empty one

`policies/work-items.json` states two capability requirements — `DEFECT` needs a record
intersecting its scope, `FEATURE` needs none to — and both were previously answered from an
empty array the live path passed in unconditionally. That made every `FEATURE` admissible for
the reason that nobody looked, and every `DEFECT` downgrade for the same reason.

`checkTypeEvidence` now takes whether the registry was **available**. Unavailable makes those
requirements `INDETERMINATE`, the check records `INDETERMINATE` rather than `PASS` or `FAIL`,
and the type downgrades to `UNKNOWN` with the reason stated — which routes to
`investigation.readonly`, the safe thing to do when you do not know what you are looking at.

In this build the registry genuinely is unavailable at admission: it is written by the Auditor
into a run's `capabilities/`, and `ContextPackage.capabilities` is a *reference* into one rather
than the records. The kernel therefore loads the newest registry any prior run of this
repository assembled, and reports unavailability when there is none. A first resolution of a new
work item has no registry, and says so.

**Reversed by:** a durable per-repository capability registry the prologue can read, at which
point availability is the ordinary case and this stays as the honest answer for the day the
store is unreadable.

### I-25 · The reconciliation matrix is computed in `discovery/` and read by the kernel

`current_reality.reconciliation` is a Context Package field, and the Context Package is written
only by probes, so the eight-state three-way matrix is computed once — in `discovery/`, at
capability level and at work-item level — and `core/` reads it. Two implementations of one rule
is one implementation too many; the workflow floor evaluator is shared between the policy loader
and the kernel for the same reason.

What stays in `core/` is the *reading*, and it is not nothing: an absent field, an absent
reality, or a value outside the vocabulary is `INDETERMINATE` and never a negative answer. A
discovery run that could not reach the project-management system has not established that nobody
intends the work, and one that could not reach the git host has not established that there is no
pull request. `core/src/work-item-reconciliation.ts` is that reader.

What also stays in `core/` is the *decision made from it*: where AgentOS's own ledger and an
external system disagree, `arbitration.ts` applies the authority ordering of
`INTENT_AND_WORK_ITEM_RESOLUTION.md` 5.1 as the rule-based step — the external system wins on
its own state, and the discrepancy is itself recorded as a finding.

**Reversed by:** nothing short of moving `current_reality` out of the Context Package.

### I-26 · `INCOMPLETE` routes back to the first unmet critical criterion a graph stage owns

`DEFINITION_OF_DONE.md` says the run "routes back to the stage that owes the verdicts", which
names a stage — so the criterion the route-back is chosen from has to be one a stage owns.
Taking the numerically first unmet critical criterion routes to `null` whenever a prologue
criterion is among the unmet, and criterion 1 is owned by no template stage, so that was every
run whose context package could not establish it: exactly the runs that most need to route back.

The route-back is bounded twice: by the dispatch cap the loop already checks each iteration, and
by **one lap per owing stage**. A second lap over a stage that supplied nothing the first time
is a quiet retry, and exceeding a bound is never one — so the run ends and a human sees what the
stage could not establish.

**Reversed by:** a policy cap for route-backs, if one lap turns out to be too few in practice.

### I-27 · Condition 4's "recorded handling" is kernel-recorded, never the gap's own account

`UNDERSTOOD` condition 4 asks that every `UNKNOWN` blocking a mandatory stage is "resolved, or
has a recorded handling". `recoverable_by` cannot be that handling: the schema requires it and
requires it non-empty, so a check keyed on it passes for every schema-valid Context Package and
decides nothing. Neither can `attempted`, for the same reason and a better one — it is the
agent's account of itself, and nobody supplies `UNDERSTOOD`.

So the two branches are: **resolved**, meaning the `current_reality` element the gap's subject
names is determinate now; and **handled**, meaning the *kernel* recorded what it did about it —
a ladder rung that dispatched the recovery the gap named, or a human answer. Everything else
fails the condition, which sends the run into the ladder.

The condition is also narrowed to gaps blocking a **mandatory** obligation. A gap blocking
`UX_REVIEW` in a template that may legitimately exclude it does not make the workflow decision
indeterminate.

**Reversed by:** a `handling` field on the unknown record, which would let a gap carry its own
disposition — at which point the question becomes who wrote it.
