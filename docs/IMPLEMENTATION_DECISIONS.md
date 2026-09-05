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

### I-28 · A stage the run stopped at is `ACTIVE` in the cursor; only a stage it left is `COMPLETED`

`project()` marked a transition's `from` stage `COMPLETED` on every edge, including the
escalation to `BLOCKED` and the terminal to `CANCELLED`. `BLOCKED` is semi-terminal and
resumable, and the design's rule is that the pre-block stage is recorded so the run resumes *in
place* — so marking it completed said the opposite of what the run did. A stage that blocked,
including one that never dispatched at all because no model was reachable, read as done in the
projection every recovery decision is rebuilt from. Both readers of the cursor then pointed past
it: `stagesRemaining` dropped a stage that still owed everything, and `stageFromCursor`, finding
nothing `ACTIVE` and nothing `PENDING`, answered `COMPLETION` — a resumed run judging work that
never happened. That is unknown state converted into false success.

The rule is now: `to` of `BLOCKED` or `CANCELLED` leaves the `from` stage `ACTIVE`; every other
edge completes it, `COMPLETION -> COMPLETE` included, where the stage really did finish.

`preBlockStage` already carried the truth, but it carried it *alongside* a cursor that
contradicted it, and only for `BLOCKED` — `CANCELLED` has no equivalent. One fact, in the
cursor, is what makes "resume in place" a single thing that cannot disagree with itself.

**Reversed by:** nothing. A cursor that disagrees with the log's own account of where the run
stopped has no defensible reading.

### I-29 · `stages_remaining` is derived from `project()`, not from a cursor the loop carries

Each dispatch's input package was built with `stagesRemaining([], graph)` — a hard-coded empty
cursor, which filters nothing — so every agent was told every stage was still outstanding,
including stages this run had already completed and stages the resume sweep had marked
`COMPLETED_PRIOR` from observed reality. An agent planning against "everything is still to do"
is planning against a fact that is not one.

The cursor is now rebuilt at dispatch time by `project()` over the run's own log: the same
function that rebuilds `run.json` and the same one a recovering kernel replays with. Carrying a
second cursor in the loop was the obvious alternative and is the wrong one — two notions of
"which stages are done" drift the moment one of them learns something the other does not, and
the one that would drift is the in-memory one, because the log is what survives a crash. This is
the same reason the workflow floor evaluator is shared between the policy loader and the kernel
rather than written twice.

Exclusion needs no cursor entry to be honoured: a stage excluded at admission is not in the
frozen graph's `stages`, and `stagesRemaining` walks those. The `EXCLUDED` cursor state is
therefore a second expression of the same fact rather than the mechanism, and it is filtered too.

**Reversed by:** a projection cost that shows up in a real run — at which point the answer is to
make the journal hand back the events it has already written, not to keep a separate cursor.

### I-30 · Resolution evidence is replayed under the *proposed* scope

`verifyResolution` replayed the resolution envelope's evidence with
`mandate: { in_scope: [], out_of_scope: [] }`. The path adapter's rule is that an absent scope is
not an unlimited one, so an empty `in_scope` refuses every path argument — every replay came back
`REFUSED`, every citation was withdrawn as unconfirmed, `named_path_exists` became unsatisfiable,
and `TASK`, `FEATURE`, `DEFECT` and `INCIDENT` all downgraded to `UNKNOWN` whatever the repository
actually contained. Resolution could not succeed against a real repository.

The two packages disagreed about what an empty mandate means: `adapters/` reads it as "nothing is
in scope", `discovery/` reads tier-1 orientation's as "deliberately repository-wide". Neither
reading is the kernel's to impose here, and the kernel does not need one — it has a third option.
The proposal has not been admitted, so the work item's *admitted* scope does not exist yet; but
the *proposed* scope does, and `Scope` is defined in the contract as the thing that "becomes
`mandate.in_scope`". Admission check 5 has already bounded it — `checkScope` refuses `**` and
anything unbounded — so this cannot become a route to unlimited reach.

So the replay runs under `proposal.scope.paths`. The reading is the conservative one: **a proposal
gets evidence confirmed only for the paths it is asking for.** A resolution that cites a file
outside the scope it claims does not get that citation believed — it either widens its scope, and
is bounded by check 5 for the wider claim, or the citation is withdrawn. The alternative,
repository-wide replay, would let a proposal claiming `docs/**` have a `FACT` confirmed about
`src/`, which is reach the proposal never asked for and admission never bounded.

The kernel's other empty mandate — the resolution *dispatch*'s own tool calls — is deliberately
left alone: at that point no proposal exists, so there is no claimed scope to bound it by, and
that is a different question with a different answer.

**Reversed by:** a resolution agent that legitimately needs to cite evidence outside the scope it
proposes, at which point the honest fix is a second, explicitly bounded mandate for the resolution
channel — not widening this one to everything.

### I-31 · A blocked run keeps its blocker kind, and `RunResult` carries it

`admitWorkItem` computes `{ outcome: 'BLOCKED', blockerKind: 'EXTERNAL_DEPENDENCY' }` for a named
external item that is unreachable or absent. The kernel routed both through `refuse`, which kept
the reason text and dropped the kind, and `REFUSED` and `BLOCKED` map to different exit codes — so
a script was told its request was inadmissible when the ticket system was merely down.

The two are different answers and must stay so. A refusal says the request cannot be admitted and
a fresh attempt at the same request fails the same way; a block says nothing is wrong with the
request and the run resumes when the dependency returns. The frozen rule is explicit that where
the intake named an external item and it cannot be resolved the run **blocks** — it does not
degrade into investigating the repository instead.

`RunResult` gains a `blockerKind`, and the prologue gains a `block()` beside `refuse()`. No Work
Item was admitted and no run was started on this path, so there is no run log to end and no
blocker record to write against a work item — but the outcome and the kind still travel to the
caller, which is the whole point. `end()` takes the kind as an optional argument, so the graph's
blocks that already had one in hand (the uncertainty ladder's `AMBIGUOUS_GOAL`, a state-machine
`BLOCK` action's own kind) stop dropping it too.

The two external-item cases stay distinguishable without needing two kinds: unreachable records
`external_identity: INDETERMINATE` ("resume when the source returns"), absent records `FAIL`
("the key is wrong, and a human should hear that"), and the reasons say which.

**Reversed by:** a `Blocker` record written for a pre-admission block, which would need a Work
Item to hang off — and there is deliberately none.

### I-32 · The narrative renders `INDETERMINATE` checks, and never ends a line at a colon

`resolutionSection` rendered only admission checks whose result was `FAIL`. An unreachable
external identity is `INDETERMINATE` — the source could not be reached, so nothing was
established either way — so a run blocked on one produced `…and blocked followed: ` and stopped
mid-sentence. The narrative obligation is the stated mitigation for v0.3's residual risk, because
"a run that did the wrong thing correctly is invisible without it"; a blocked run whose narrative
does not say why is precisely that failure.

Two changes, and the second is the one that generalises. The rejection line now renders every
check that stopped the proposal — `FAIL` and `INDETERMINATE` both, each with its result named, so
"could not be established" is visibly not "was established false" — and says "blocked rather than
being refused" where that is what happened. And `narrate` now strips a trailing colon or dash from
every line it assembles, dropping the line entirely if nothing survives.

The guard is structural rather than a discipline at each call site because there are dozens of
sites and every one of them renders a list that could turn out empty. A half-sentence is worse
than a missing line: it reads as a run that stopped for no reason, which is unknown state
presented as an account of what happened. Where a reason genuinely is not recorded, the line now
says so out loud and calls it a kernel defect.

**Reversed by:** nothing foreseeable; a line that wants to end in a colon can put the colon
somewhere a reader can see it belongs there.

### I-33 · Criterion 1 is critical in no profile, because no stage supplies it

`DEFINITION_OF_DONE` section 3 gives criterion 1 to Context Discovery. Context Discovery's
`context` mandate does own it (`agents/src/roles/catalog.ts`), and `CONTEXT_DISCOVERY` runs in
every run — but it runs in the **prologue**, and the prologue is not a stage a template
contains. A criterion verdict reaches `computeDod` only inside an accepted `HandoffEnvelope`,
`policies/data/stages.json` gives criterion 1 to no stage, and `DOD_VERDICT_CRITERION_NOT_OWNED`
refuses a verdict from any stage whose descriptor does not name the criterion. So in this build
criterion 1 is owed to a mandate no code path dispatches, and it comes out `NOT_VALIDATED` in
every run of every template.

`NOT_VALIDATED` is never `MET`. Five of the seven profiles made criterion 1 **critical**, so
five profiles could only ever compute `INCOMPLETE` or `INDETERMINATE`, and the remaining two
carried it non-critical, so their ceiling was `COMPLETE_WITH_GAPS`. **No run in the build could
end `COMPLETE`.**

Giving criterion 1 to a template stage would have been the other repair and is not available:
"every criterion has exactly one agent that supplies its verdict" is frozen, and the Auditor
supplying Context Discovery's verdict breaks it. So the criterion is critical nowhere, and the
two cases are treated differently because they are different:

- **`audit` drops criterion 1 entirely.** Its own contract is that its criteria are the ones an
  audit path can supply, and 3 and 4 — the Auditor's first pass, which is exactly what `AUDIT`
  collects — are that set. `investigation.readonly` can now reach `COMPLETE`.
- **The four capability profiles keep criterion 1, non-critical.** Removing it would make
  "context understood" invisible in the completion report, and the distinction the model exists
  to keep is between "this does not apply" and "we did not check". Non-critical and
  `NOT_VALIDATED` says the second out loud, is `COMPLETE_WITH_GAPS`, and requires a human to
  acknowledge it — which is what I-15 already sanctions for a criterion nobody could supply.

The residual defect is upstream of policy and is recorded here rather than papered over: the
prologue owns a criterion it never dispatches a mandate to supply. When `CONTEXT_DISCOVERY`
dispatches `context-discovery/context` and its envelope reaches `computeDod`, criterion 1
becomes suppliable, the capability profiles' `NOT_VALIDATED` turns `MET` with no policy change,
and only then can it be made critical again — which the new loader rule will permit exactly
then and not before.

**Reversed by:** the prologue supplying criterion-1 verdicts, at which point `stages.json` or an
equivalent statement makes it suppliable and the profiles may restore it to critical.

### I-34 · A load rule may assert only what the policy data states

The loader already had the rule that would have caught I-33: `critical-criteria-suppliable`,
written for I-15, is the check whose application raised amendment A-14. It did not fire, and the
reason is worth more than the defect. `suppliableCriteria` seeded its result from a constant —

```ts
const PROLOGUE_CRITERIA: readonly DodCriterionId[] = [1];
```

— on the reasoning that the prologue runs in every run and owns criterion 1. The stage does run.
It supplies no verdict. So the constant exempted from the check the one criterion `stages.json`
gives to no stage, which is precisely the criterion the check exists to catch: a rule whose
blind spot is its own subject matter. Everything it was meant to guard for criterion 1 was
unguarded, silently, and the failure surfaced as a mysterious `INDETERMINATE` at `COMPLETION` —
which is the failure mode I-15 was written to prevent.

The seed is gone. A load rule reads the policy data and asserts nothing the data does not state:
that a stage supplies a criterion is stated in `stages.json` and nowhere else, so that is the
only thing consulted. A claim about a component the loader cannot see is not a fact it may
assume; if the prologue is to supply a criterion, the data has to say so and the loader has to
be able to read it.

A second rule was added rather than only widening the first, because the template-scoped rule
has two holes and criterion 1 fell through both. `critical-criteria-owned-by-a-stage` asks of
**every** profile — including those no template defaults to, which the first rule never reaches —
whether a criterion `stages.json` gives to no stage at all is critical, and names the cause once
instead of once per template. And `policies/test/load.test.ts` now asserts the property directly
against the shipped data, without going through either check, so a future exemption inside a
rule cannot hide the thing the rule is for.

**Reversed by:** nothing. A check that trusts an assumption it cannot verify is not a check.

### I-35 · A pointer-shaped intake is dereferenced at admission, so drift compares like with like

`WORKFLOW_STATE_MACHINE` section 7.4 has `COMPLETION` re-execute the intake locator and compare
content hashes. `sourceLocatorFor` was already right that for a project-management intake the
*ticket* is the source — the operator naming a key is a pointer at the request, not the request —
but `IntakeRecord.content_hash` is computed over whatever `StartInput.raw` carries, and the CLI
carried the key. The hash was over `"INV-7"` and the re-read over the ticket body: two different
things, and their comparison would have said `CHANGED` on every run of every ticket for ever,
without a ticket ever having changed. It did not even get that far, because `rawTextOf` accepted
only a string or a `{raw}` record and a ticket is neither, so every such run recorded
`source_drift: UNAVAILABLE` — "the ticket answered and we could not read it" reported as "the
ticket system did not answer".

So the pointer is dereferenced once, at admission, through the same reader the drift check uses
(`admitIntake`). What is hashed and what is re-read are produced by the same code against the
same locator, which is the only arrangement under which the comparison means anything. For a
`host.read_intake` intake the typed text already *is* the source and nothing is dereferenced.

Two consequences are deliberate. `IntakeRecord.raw` for a project-management intake is now the
ticket, so the narrative quotes the ticket verbatim and the instruction-attempt scan reads the
ticket — which is right on both counts: the ticket is the request, and it is the untrusted text.
And a source unreadable *at admission* is admitted on what the operator typed with its locator
stripped of its operation, so `COMPLETION` records `UNAVAILABLE`: the body was never seen, so
nothing about it can have changed or stayed the same, and inventing `CHANGED` from a hash of the
key would be worse than saying nothing.

A ticket record is rendered as sorted `key: value` lines, and the assertion envelope — whose
`observed_at` moves on every read — is dropped before rendering. Sorted because the hash is over
the ticket and not over the order a connector happened to serialize it in; as lines because the
text is what the narrative quotes and what a `CHANGED` diff is taken over, and a human reads both.

**Reversed by:** an adapter that can answer with the source's own canonical text and an etag,
which would let the comparison be over the source's identity of content rather than over ours.

### I-36 · The probe/descriptor argument surface is checked by driving both sides, not by restating either

`discovery/` and `adapters/` were built against the same port and disagreed about the arguments
of twelve operations. Nothing caught it. `adapters/` cannot import `discovery/` and must not;
the arguments cross the boundary as `Record<string, unknown>` by construction, so no type
relates the two; and `discovery`'s own double answers whatever it is asked, so a fully green
probe suite proved nothing about the schemas the real adapters declare. The existing check
compared operation *names* — which agreed — and stopped there.

What it cost is the shape of the failure rather than its size. `args_schema` carries
`additionalProperties: false`, which is what makes it the granted surface rather than a
description of one, so every drifted call came back `ERROR: was called with arguments its
descriptor does not admit`. Against a real repository with every connector reachable: 24 OK, 32
ERROR, `repo.list_paths` refused sixteen times out of sixteen. Nine of the ten `current_reality`
elements read `UNKNOWN`, `architecture.required` and `regression.suspected` evaluated
`INDETERMINATE`, understanding computed `INSUFFICIENT`, and no run reached a determinate
workflow decision. A repository that discovery could see perfectly well presented as one nobody
could observe.

The check that now holds it (`discovery/test/conformance.test.ts`) restates neither side. It
drives the real probes over the fake worlds — which is what makes them build their arguments the
way they really do, conditional branches included — records every call as it was made, and
validates each against the descriptor the real adapter factories register, using the contract's
own validator. Its failure names the operation, the arguments and the rejected property. Two
supporting claims are asserted with it, because each is a way the check could pass while saying
nothing: every declared operation was actually driven (with the one that is not — `repo.read_file`
— named explicitly rather than tolerated), and a floor on how many distinct argument shapes were
exercised, since the drift lived in the conditional arguments and a run that built few of them
has not looked where the problem was.

The same file enforces the rule confinement depends on: an argument named for a path must be
*declared* as one. `format: "path"`, on a property or on an array's items, is what makes the
framework resolve a value against the worktree root and check it against the mandate and the
deny-list before a handler sees it. An argument that names a path and is declared as a plain
string reaches the filesystem unchecked, so the naming convention is checked rather than trusted.
Globs are deliberately not path arguments and are exercised as such — confining `**` + `/x` would
produce a verdict about a file that does not exist; what makes a glob safe is that it only ever
filters entries already enumerated beneath a confined root.

Widening the schemas to `additionalProperties: true` would have made every symptom disappear in
one line. It is the wrong repair for the reason the flag exists: the refusal is the check that
found this, and a probe calling an operation with arguments it does not have would then be
answered rather than refused — the same drift, reported as a fact about the repository.

Which side moved was decided per operation, on which shape is the better observation. The
descriptor moved where the probe was asking the more useful question and the adapter could
answer it (`repo.list_paths` over globs, `git.log` narrowed by base, path set and message tokens,
the structured selectors on `pm.search_issues` and `runtime.query` — a probe cannot invent a
product-specific query string for a system it has never seen, and AgentOS never knows which
system it is talking to). The probe moved where the descriptor's shape was safer or more general:
the attachment operations take no arguments because the adapter is attached to exactly one
worktree, and a `path` there would either be ignored — making the evidence locator claim
something the adapter did not do — or re-root the adapter, which is confinement decided by the
caller. Where an argument was relaxed from required, the handler answers `INSUFFICIENT_EVIDENCE`
rather than defaulting: a search with no criterion is a listing of everything, and an outcome
nobody stated is one nobody can check.

Fixing the arguments exposed the second half of the same coupling, and fixing only the first half
would have been worse than leaving both. Every adapter operation answers with an `Assertion`
rather than with bare data — that is how "git is not installed" stays distinguishable from "the
repository has no branches" — and the probes read that wrapper as though it were the data. While
the calls were failing this was invisible. With the calls succeeding it turned an `UNAVAILABLE`
run ledger into `agentos_history: FACT []`, which is a resumed run being told it has no history
and redoing analysis it had already done. So the unwrapping happens in one place
(`discovery/src/probes/observation.ts`) and every probe observes through it: a `FACT` or
`INFERENCE` yields its value, an `UNKNOWN` is not an observation and comes back as a failure to
observe carrying the adapter's own reason, and an `UNKNOWN` entry of an attachment sequence is
left out rather than passed through as a truthy object.

**Not fixed, and named here rather than left to be rediscovered:** three operations still
disagree about the *shape* of what they answer, which is a separate defect from the arguments and
needs adjudication against the frozen documents rather than a decision here.
`git.list_branches` answers with ref-name strings and the probes read `{ name, default, protected }`
records, so `git_state.branches` reads `FACT []` on a repository with branches — and the
protection flag is the one that must fail closed, which is why this cannot be resolved by making
the adapter guess. `repo.identify` and `repo.detect_stack` answer in the attachment sequence's
vocabulary (`path`, `ecosystems`) and the probes read the Context Model's (`root`, `languages`),
which leaves those keys `INSUFFICIENT_EVIDENCE` — fail-closed and honest, and still not the
observation that was available. `repo.commands` nests its answer one level deeper than the probe
reads. Each is a mismatch between two frozen vocabularies, not a bug in either package.

**Reversed by:** nothing. Two packages that must agree about a signature neither can see have to
be checked against each other by something that has both, and a check that restates one side is
a third thing to keep in step.


### I-37 · Two frozen vocabularies, reconciled in the probe; the observation the adapter owes, supplied failing closed

I-36 fixed the arguments and named three return-shape mismatches it deliberately did not fix,
because each looked like a clash between two frozen documents rather than a defect in either
package: `REPOSITORY_ADAPTER.md` section 1, which describes what the eight-step attachment
sequence produces, against `CONTEXT_MODEL.md` section 3, which describes what a Context Package
section contains. Read carefully, neither document has to change, and this is what each of the
three actually is.

**The reconciliation belongs to the probe, and only the probe.** A probe is the thing that
populates a `ContextPackage` section; an adapter answers about the world in the words its own
contract gives it. So where the attachment sequence identifies a `path` and the Context Model's
`repository` section is written in `root`, the translation is the probe's job, and the adapter
keeps answering `path`. What is not acceptable is what was happening instead: the probe looked
for `root`, found nothing, and reported `INSUFFICIENT_EVIDENCE` — fail-closed, honest, and a
gap manufactured out of a vocabulary difference rather than out of anything about the
repository. The same reading settles `repo.commands`, whose answer is attachment step 7
*projected out of the whole sequence* and therefore arrives as `{ commands: … }` rather than as
the commands; reading it one level too shallow reported that a repository declaring four
commands declared none, silently and identically to one that really declares none.

**`languages` is the one case where the two vocabularies genuinely disagree rather than merely
spell differently, and renaming would have been the wrong repair.** `detect_stack` establishes
*ecosystems* from manifests, and an ecosystem is not a language: `package.json` says node and
says nothing about whether the source is JavaScript or TypeScript. Mapping one onto the other
would have been the detection-from-a-name the attachment sequence forbids. So the adapter's
answer is carried through under its own name — the Context Model has no synonym for it, and
discarding a real observation because the section is written in different words is the same
error in the other direction — and the language question is answered where the answer is, by
counting source extensions over the observed listing. That is an `INFERENCE` citing the listing
it derives from, never a `FACT`: the extensions are observed and what a file is written in is a
reading of them. `frameworks`, `build_system`, `test_runner` and `linters` remain
`INSUFFICIENT_EVIDENCE`, and that is honest rather than unfinished — nothing the repository
adapter reads establishes them, and a framework read off a filename would be a fabrication with
a confidence class attached.

**Where the adapter genuinely owes the observation, the adapter supplies it — failing closed.**
`git.list_branches` answered ref-name strings, and the probes read `{ name, default, protected }`
records, so `git_state.branches` read `FACT []` on a repository with four branches. This one
could not be repaired on the probe side, because `protected` is not a field the probe may
default: attachment step 8 establishes boundaries and section 2.2 makes protection fail closed,
so a probe normalizing `['main', 'feature/x']` into records would leave every `protected` flag
`undefined`, collect no branch as protected, and report "nothing here is protected" — a
fail-open answer produced by a failure to read, which is the exact inversion of the rule. So
`list_branches` now answers a record per branch carrying the flag a caller gates on *and* the
`Classification` behind it. With no VCS host reachable every branch is `protected: true` at
`UNKNOWN` confidence with `failed_closed: true`, which is what `policies/data/gates.json` fires
`MERGE_PROTECTED` on; where the host answers, the same fields say `FACT` and `failed_closed:
false`, including when the answer is "protected", because "this branch really is protected" and
"we could not find out" are different facts and only one is fixed by granting access. The probe
carries that distinction into the package: `git_state.protected_branches` is a `FACT` when every
classification was observed and an `INFERENCE` naming the branches whose protection failed closed
when any was not. `default` is left *off* a record entirely when the remote HEAD is unreadable,
rather than set to `false`, because "this is not the default branch" is a claim and nothing
established it — a reader looking for a base branch then finds none and says so. And the
listing is filtered on full ref names rather than short ones, because the short form of
`refs/remotes/origin/HEAD` is `origin`: a plausible-looking name that is no branch at all and
would otherwise be listed, counted, and asked about by the protection classifier.

Against a real scratch repository — four branches, a manifest with four scripts, a remote HEAD —
`git_state.branches` goes from `FACT []` to four records, `branch_count` from 0 to 4,
`repository.root` / `default_branch` / `remotes` / `languages` from `INSUFFICIENT_EVIDENCE` to
`FACT`/`FACT`/`FACT`/`INFERENCE`, and all four `*_command` keys from `INSUFFICIENT_EVIDENCE` to
the commands the repository declares, at `INFERENCE` because nothing has executed them.

**The check that let all three survive is the one worth changing.** I-36's conformance file
drove the real probes over the real descriptors and validated every call's *arguments*; it said
nothing about answers, and the world the probes are driven over is written by hand in the
probe's own vocabulary — it answered `{ name, default, protected }` records to an operation that
returned strings, `root` to one that reports `path`, and flat commands to one that nests them.
Every probe test passed against answers no adapter could produce. So the conformance file now
drives the same probes over a world whose repository and git answers come from the **real
adapter handlers**, invoked with the arguments the probes really pass: real manifest parsing,
real git porcelain parsing through a scripted `git` process, real `Assertion` wrapping, real
path confinement. It then compares that package against the hand-written one, key by key, and
fails on any `repository` or `git_state` key the fixture can state and the real answers cannot —
where "cannot" covers the empty `FACT` as well as the `UNKNOWN`, because `FACT []` is the quiet
half of this failure and the half that survived. The four keys the real adapter genuinely does
not establish are asserted as an exact set, so the exemption fails when it goes stale as well as
when it grows. Running it found a fourth mismatch of the same family immediately:
`git.list_tags` answers ref names and `git.tags` read records, so `git_state.tags` was `FACT []`
on a tagged repository. A tag *is* its name, nothing gates on it, and no classification is
involved, so that one is normalized in the probe — which is exactly the distinction the branch
case is not.

**Reversed by:** nothing. The general shape here is that a fixture written to please the code
that reads it proves only that the code reads its own fixture, and the repair is to make the
fixture come from the other side.

### I-38 · The prologue dispatches both Context Discovery mandates, so criterion 1 has an owner that runs

`IMPLEMENTATION_PLAN` WP-5 asks for "**Context Discovery** with both mandates (`resolution` on
tier-1 orientation, `context` after admission)". Only `resolution` was ever dispatched. At
`CONTEXT_DISCOVERY` the kernel called `discovery.deepen()`, versioned the package, and moved on
to `UNDERSTOOD` without dispatching anything.

That was not a missing nicety. `context-discovery/context` is the **sole owner of
Definition-of-Done criterion 1**, a criterion verdict reaches `computeDod` only inside an
accepted `HandoffEnvelope`, and no envelope existed — so criterion 1 came out `NOT_VALIDATED`
in every run of every template, with `supplied_by_envelope: null`. I-33 recorded the
consequence and repaired the *symptom* in policy data: criterion 1 was made critical nowhere,
`audit` dropped it entirely, and the four capability profiles kept it non-critical so the gap
stayed visible as `COMPLETE_WITH_GAPS`. I-33 also said what would reverse it — "when
`CONTEXT_DISCOVERY` dispatches `context-discovery/context` and its envelope reaches
`computeDod`". This is that.

**The dispatch is ordinary, and that is the point.** It is `d_ctx`, it appears in the run log
exactly as `d_0001` does, and it goes through everything: the dispatch budget is checked before
it, the model is ranked by the registries and selected and the selection journalled, the granted
tool set is the read-only surface the role's permitted adapters expose, the substrate's
effective tool surface must equal that set or the dispatch aborts, and the envelope goes through
all eight receipt steps with its evidence replayed through the originating adapters. Nothing
about it is a special case, because a dispatch exempt from the disbelief machinery is a hole in
the machinery shaped like whatever it was exempted for.

**The probes remain the only writers of `current_reality`.** `discovery.deepen()` produces the
observations before the dispatch and the kernel merges nothing back out of the envelope — its
`current_reality` output is the agent's account of the package it was handed, never a source
for it. The run log says so in a `note` at `CONTEXT_DISCOVERY`, and a scenario asserts that a
context envelope claiming a reality element changes nothing about what the probes observed. An
agent that supplied both the observations and the judgment of them would be judging its own
work, which is the separation the whole evidence model rests on.

**A failure blocks; it does not advance.** A `FAILED` dispatch, a malformed envelope, a
contract violation, a non-conforming tool surface, or an envelope whose own status is `BLOCKED`
or `FAILED` all end the run at `CONTEXT_DISCOVERY` with the reason named and, where the kernel
has a name for it, the blocker kind. The alternative — proceeding on the probe package alone
and letting criterion 1 fall out `NOT_VALIDATED` — would advance the state machine on the
strength of a dispatch nothing believed. It gets **one attempt**: the graph's retry protocol
lives in the run loop, which owns an attempt counter and a stage cursor, and a second private
retry loop in the prologue would be a second implementation of a rule that already exists.

With no model reachable the two-case split of invariant 16 is preserved. Before admission there
is no run to hang a blocker on, so the prologue refuses; at `CONTEXT_DISCOVERY` a run exists —
the lease is held and the log is open — so it blocks with `EXTERNAL_DEPENDENCY` and resumes at
the same point when a model returns.

**What this does not change.** Criterion 1 is still critical in no profile, and the loader rule
that would refuse it is still right to. `critical-criteria-owned-by-a-stage` reads `stages.json`
and nothing else — I-34's rule that a load rule may assert only what the policy data states —
and `stages.json` gives criterion 1 to no stage, because the prologue is not a stage a template
contains. So the policy workaround is now *safe* to revert and not yet *loadable*: making
criterion 1 critical again needs the loader to learn that a criterion may also be supplied by a
mandate the prologue dispatches, from data that states it, before any profile may depend on it.
Restoring it in `policies/data` first would fail the load, which is the check working.

**Reversed by:** a statement in policy data that the prologue's `context` mandate supplies
criterion 1, at which point `critical-criteria-owned-by-a-stage` can read it and the capability
profiles may make the criterion critical again.

---

## Known defects, recorded rather than fixed

These are defects, not decisions. They are recorded here because the honest place
for a known defect is where the next person will look, and because a defect nobody
wrote down becomes a surprise rather than a task.

### K-1 · The Orchestrator's workflow dispatch never happens

`core/src/kernel.ts` looks up `agents.spec('orchestrator', 'workflow')`. The spec's
mandate is named `orchestration` (`agents/src/roles/specs.ts`). The lookup misses,
`dispatchOrchestrator` returns `null` before it reaches the registry, and **every run
silently takes the fallback template**.

**Why it is not currently visible.** With `execution.mutation_enabled: false` and
`admissible_risk_classes: ["READ_ONLY"]`, `investigation.readonly` is the only
admissible template for every work item type, so the fallback and the proposal would
select the same graph. The outcome of every run in this build is identical either
way. What is lost is not correctness here but *exercise*: the Orchestrator proposal
path — template selection, optional-stage exclusion with the kernel evaluating the
predicate, stage mandates bounded by the work item's scope, and the override record
when a proposal fails admission — has never run in a live dispatch. Those checks are
unit-tested against `admitWorkflow` directly and are not reached end to end.

**Why it is recorded rather than fixed.** The correction is one word. Turning it on
adds a dispatch to every run, which invalidates every scripted substrate and every
recorded envelope fixture: applied, it takes the suite from 1225 passing to 17
failing, all of them fixtures needing an honest orchestrator envelope. That is the
same shape and size of work as dispatching the `context` mandate (I-38), and it
deserves the same care rather than being rushed in alongside it. Rushing it is how
a fixture gets written to satisfy a reconciliation check instead of to record what
an agent could honestly have returned.

**What to do.** Change the mandate name at the lookup, then give each scripted
substrate and `core/test/fixtures/typo-readme/` a workflow proposal envelope that an
Orchestrator could really have produced — a template from the admissible set, no
invented stage, and any exclusion carrying a claim the kernel is free to evaluate
against it. The fallback and override paths must keep their own tests: a proposal
that now succeeds must not remove the coverage of one that fails.

**Related, and deliberately not fixed here:** `core/src/composition/build.ts`'s
`identityResolverFor` collapses "reachable but absent" into `UNAVAILABLE` before the
kernel sees it, because `AdapterCallOutcome.ERROR` carries only a message. The
kernel distinguishes the two (`admitWorkItem` says different things about a wrong
key and an unreachable source), and the adapter framework's internal presence check
distinguishes them too — the information exists at both ends and is discarded in the
middle. Surfacing presence on the call outcome would close it.
