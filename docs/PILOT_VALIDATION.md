# WP-8 Pilot — Human Validation Procedure

**Status: the pilot has not been run.** This document is the procedure, not a result.

The protocol, the scoring vocabulary and the pass criteria are
[IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) section 12 and are **not restated or
reinterpreted here**. This file is the operational checklist that executes them against the
implementation as it actually exists: the commands, the paths the evidence lands in, and the
form the scoring is recorded in. Where this document and section 12 disagree, section 12 wins
and this file is the defect.

Nothing here is a product feature. Every step is performed by a human, and the only thing
Intentra does is the read-only run in step D.

---

## Preconditions

The implementation gate is green before a pilot begins:

```
npm ci
npm run verify
```

The gate is freeze → codegen → build → typecheck → lint → tests → ajv-parity → boundary →
delete-core → conformance, and the first failure stops it. A pilot run mounted on a red gate
measures nothing.

One known flake, on Windows only: `core/test/composition.test.ts` builds real git repositories
under the system temp directory, and `node --test` runs test files in parallel, so its `after()`
teardown can hit `EBUSY: rmdir` while Windows still holds a handle on `<temp>/repo`. Every
assertion in the file passes; the failure is in cleanup. Observed once in three consecutive gate
runs (the other two, and the file run in isolation, are clean). If the gate fails this way,
re-run it and record that you did — do not treat a teardown `EBUSY` as a green gate without a
clean run to point at.

**A model must be declared or the run cannot dispatch.** With none, every dispatch reports
`NO_MODEL` and the run blocks with `EXTERNAL_DEPENDENCY` having advanced nothing — invariant 16
as the default behaviour of an unconfigured host. See step D for the declaration.

---

## A. Repository selection

Three repositories, chosen and written down **before** any of them is run.

1. Each must have problems that were **found by humans, independently of Intentra**, on a date
   that precedes this pilot. A repository whose problems were found by reading Intentra's
   output is not a test.
2. The roadmap's named targets are Marksy first, then Ferret and Tradsy. Three is the number
   because one is a demo: a system that only works on the first is a tool for that repository.
3. Each is pinned to a commit. Record the SHA. Ground truth is true *of that commit*, and a
   repository that moves under the pilot invalidates its own scoring.
4. The working tree must be clean, and must remain byte-identical after the run — see step D's
   read-only assertion.

Record per repository: name, remote, pinned SHA, who selected it, the date, and one sentence on
why its ground truth is independent.

## B. Ground-truth sealing

**Sealed before Intentra runs. Writing it down afterwards is not a test.**

For each repository, one file, authored by a human, stored **outside the state root and outside
the repository under test**:

- One entry per known problem: stable id, title, `severity` (`CRITICAL` / `HIGH` / `MEDIUM` /
  `LOW` / `INFO`, the frozen vocabulary), the evidence a human can point at (file, line, commit,
  ticket, log), and the one-sentence diagnosis.
- The severity assignment matters: the recall criterion is scored over `CRITICAL` entries only.
  Assign severity before the run, never after seeing what was found.
- Seal it: commit it to a separate repository, or hash it and record the hash with a timestamp
  somewhere the pilot operator cannot silently rewrite. `sha256sum ground-truth-<repo>.md`, with
  the hash recorded in the pilot log, is sufficient.
- **Do not** place it inside the repository under test, inside `AGENTOS_STATE`, or anywhere an
  adapter read could reach it. A ground truth Intentra can read is a hint, not a truth.

For D-6, the structural-edge measurement additionally needs **hand-verified edges**: for a
bounded, named slice of the repository, the human writes down the true `DATA_FLOW` / `CALL` /
`READ` / `WRITE` / `RENDER` edges between capability chain stages. Bound the slice explicitly and
record the bound — recall is only meaningful against a set someone actually enumerated.

## C. Input / work-item sampling

One goal per repository, written before the run, in the operator's own words, and nothing else:

> "Make Marksy IPO intelligence production-complete."

Constraints, all of them from the protocol:

- **No hints.** The goal names an outcome — not a problem, not an area, not a file.
- **No seeded state.** The state root for the run starts empty. Nothing is pre-populated with
  answers.
- **Intake is data.** Do not attempt to name a workflow template, request a stage, set a
  confidence or a trust class, or widen a scope from inside the request text. Invariant 18 says
  the attempt has no effect and is recorded; the pilot is not the place to exercise it.
- Record the exact goal string. It is an input to the scoring.

## D. Running Intentra read-only

The run is **read-only by construction**, not by convention: `policies/data/execution.json` sets
`mutation_enabled: false` and admits only `READ_ONLY` risk classes, and no mutating adapter
operation is registered.

Build once:

```
npm ci
npm run build
```

Declare the host inventory. Every undeclared model property defaults to the value that *fails* a
requirement, so an under-declared model is enumerated and then never selected. The MVP's most
demanding role is the Auditor: `context: large` (a 400 000-token floor), `reasoning: deep`,
`tool_use: strong`, `precision: high`.

PowerShell:

```powershell
$env:AGENTOS_STATE  = 'C:\pilot\state\marksy'
$env:AGENTOS_MODELS = '[{"id":"<model-id>","context_window":1000000,"reasoning":"deep","coding":"strong","vision":"none","tool_use":"strong","latency_class":"medium","precision_class":"high","usd_per_mtok_input":null,"usd_per_mtok_output":null}]'
$env:AGENTOS_TOOLS  = ''
```

`AGENTOS_SKILLS` is optional and defaults to none. `AGENTOS_TOOLS` is the built-in tool surface
the substrate exposes, for the tool-surface conformance check, and **empty is correct** — freeze
D-2 requires a substrate with no built-in tools, and an agent's entire reach is the adapter
operations it was granted.

Record the repository's pre-run state, run, then assert it did not move:

```
git -C <repo> rev-parse HEAD
git -C <repo> status --porcelain          # must be empty before
node core/dist/src/cli/main.js work --repo <repo> "<goal>"
git -C <repo> status --porcelain          # must be empty after
git -C <repo> rev-parse HEAD              # must be unchanged
```

A non-empty `status` after the run is a **pilot failure and a defect**, not an observation to
note. Stop and record it.

Read the exit code rather than assuming success: `0` complete, `10` blocked, `11` refused, `12`
failed, `13` cancelled, `14` re-resolved, `2` usage, `3` unusable fixture, `4` policy did not
load, `5` contract violation. **A blocked run is a result, not a crash** — it is scored, not
re-run with different inputs until it completes. If you do re-run with a changed goal, it is a
new numbered attempt with its own record, not a retry.

## E. Capturing Intentra's decisions and evidence

Everything is on disk under `AGENTOS_STATE` and readable without Intentra running. Snapshot the
whole tree, read-only, before anyone starts scoring:

```
state/intake/                                  the intake records, hashed
state/work-items/<work-item-id>/
  work-item.json                               identity, type, outcome, scope, lifecycle
  events.ndjson                                work-item log
  runs/<run-id>/
    run.json                                   frozen graph, stage, cursor, budgets consumed
    events.ndjson                              append-only run log; the source of truth
    context/                                   Context Package snapshots, current_reality
    capabilities/                              CapabilityRegistry — records and graph
    envelopes/                                 one immutable file per agent handoff
    decisions/                                 arbitration, architecture, admission
    authorizations/                            requests and grants (empty: nothing mutates)
    artifacts/                                 reports and traces
```

Also capture the two projections, which are what a human actually reads:

```
node core/dist/src/cli/main.js status
node core/dist/src/cli/main.js narrate <work-item-id> [<run-id>]
```

**`narrate` is the primary artefact of the pilot.** The residual risk v0.3 carries forward is a
plausible-but-wrong resolution flowing downstream as the run's statement of purpose, and no
mechanical check separates plausible-and-wrong from right. The narrative is the only mitigation,
so it is read in full and scored (step J), not skimmed.

The scoring surfaces are:

- **Findings** — in `envelopes/`, each with `severity`, `category`, `confidence`, `impact` and
  `evidence[]` ids resolving into that envelope's evidence pool.
- **Coverage** — each envelope's `coverage`, the claim about what was examined.
- **Structural edges (D-6)** — `capabilities/`, `CapabilityRegistry.graph.edges`, each with
  `kind`, `confidence` and `evidence[]`.
- **Cost** — tokens and wall clock from the run log; human review time is timed by the reviewer
  and recorded, because it is a first-class output of the pilot rather than an afterthought.

Snapshot before scoring, and score from the snapshot. Nothing in the state tree is edited.

## F. Human comparison against sealed truth

Unseal the ground truth only now. Then, per repository:

1. Walk the sealed entries in order. For each, search the captured findings for a match.
2. Match on the *problem*, not on the wording. A finding that names the same defect with a
   different title matches; one that names the same file for a different reason does not.
3. Two humans where the budget allows, scoring independently, disagreements resolved by reading
   the evidence rather than by discussion. A single scorer is acceptable and is recorded as such.
4. Every judgement cites the envelope and finding id it was made from.

## G. Recall / precision scoring

The vocabularies are the roadmap's and are used verbatim.

**Recall** — one row per sealed ground-truth entry:

| ground-truth id | severity | verdict | finding id | note |
|---|---|---|---|---|

`verdict` is `FOUND` (with correct evidence), `PARTIAL` (right area, wrong or incomplete
diagnosis) or `MISSED`. `PARTIAL` is not half of `FOUND` and does not count toward recall.

**Precision** — one row per finding Intentra reported:

| finding id | severity | claim | verdict | note |
|---|---|---|---|---|

`verdict` is `TRUE`, `FALSE` or `UNVERIFIABLE`. Every reported finding is scored; none is
skipped as uninteresting.

**Novel findings** — real problems the humans missed, listed separately with the evidence that
confirms each. **Worth more than recall**, and the strongest available signal, so they are
recorded even when the pilot fails on another criterion.

**Structural edges (D-6)** — the same two tables over the bounded slice from step B, scored
against the hand-verified edge set. Report recall, precision and cost. This is the measurement
that resolves D-6, and it is recorded as a freeze amendment (step L) whatever the result: a
disappointing result costs the graph, not the milestone.

Compute and record `recall = FOUND / total CRITICAL sealed entries` and
`precision = TRUE / total findings reported`. Show the numerator and denominator, not only the
percentage.

## H. False-positive / false-negative classification

Not a tally. Each `FALSE` and each `MISSED` gets a one-line cause, because the cause is what
changes the system:

- **False positive (`FALSE`)** — was the evidence wrong, or was the evidence right and the
  inference from it wrong? An envelope whose evidence does not replay should have been rejected
  by verification before it reached a human; a `FALSE` finding whose evidence *did* verify is a
  reasoning defect, and the two have different fixes.
- **False negative (`MISSED`)** — was the area not examined (a coverage gap), examined and
  nothing concluded (a discovery gap), or concluded and suppressed (a confidence or threshold
  gap)? `coverage` and the run log answer this; do not guess.

Record, per repository, whether any miss traces to a **repository-shaped assumption in the
kernel**. Per the plan, that is a defect to be removed before milestone 2, and it is named here
rather than in a retrospective.

## I. Ambiguous and INDETERMINATE cases

The frozen vocabularies are the only ones used. Do not invent a scoring value.

- A predicate over an `UNKNOWN` assertion is `INDETERMINATE`, never `FALSE`. An `INDETERMINATE`
  that correctly stopped a run from claiming something is **correct behaviour** and is not scored
  as a miss.
- A run that ended `BLOCKED` with `AMBIGUOUS_STATE` rather than guessing is likewise correct
  behaviour. Record it, with the observation that was ambiguous.
- A ground-truth entry that turns out on inspection to be wrong is struck from the sealed set
  **with a written reason and a timestamp, and the strike is disclosed in the result**. It is
  never silently deleted; a set that shrinks under scoring pressure is itself a finding about
  the pilot.
- A finding a human cannot adjudicate from its evidence alone scores `UNVERIFIABLE` for
  precision — and separately fails the evidence-quality criterion in step J, since the whole
  point of the evidence field is that a human need not re-investigate.

## J. Residual-risk observations

Three things are read for, deliberately, because they are risks v0.3 states rather than closes:

1. **Honesty.** Did any `UNKNOWN` get presented as a `FACT`? Is the coverage statement accurate
   — does it claim to have examined anything no adapter call touched? Are the stated gaps real?
   This is a full pass over the findings' `confidence` fields against their evidence, not a spot
   check.
2. **Narrative adequacy.** Read `narrate` in full. Does it state what Intentra decided the work
   was, and why, in terms a human can disagree with? A run that did the wrong thing correctly is
   invisible without it. Record a plain verdict: could a reader have caught a wrong resolution
   from this narrative alone?
3. **Cost.** Tokens, wall clock, and human review time. The freeze leaves the cost model open and
   names the pilot as what measures it, so an unrecorded cost is a missing pilot output.

## K. Pass / fail decision

The criteria are the roadmap's, unchanged, and all four must hold **per repository**:

- Recall of `CRITICAL` ground-truth problems: **at least 70%** `FOUND`.
- Precision: **at least 80%** of reported findings `TRUE`.
- **Zero confidence violations** — no `UNKNOWN` presented as `FACT`. Non-negotiable: a single
  instance fails the pilot regardless of every other score, because a system that confidently
  invents findings is worse than no system.
- The coverage statement is accurate: it does not claim to have examined what it did not.

Additionally, and outside the four: the repository must be byte-identical after the run (step D).

A repository is `PASS` or `FAIL`, with the numbers. **The pilot passes only if all three
repositories pass** — a system that works on one is a tool for that one. Record the decision, who
made it, and the date, next to the numbers it was made from.

Nothing about the MVP is claimed complete before this decision exists and reads `PASS`.

## L. Recording the result as a freeze amendment

Required by [ARCHITECTURE_FREEZE.md](ARCHITECTURE_FREEZE.md) section 3, and by D-6 itself.
Whatever the outcome:

1. **State the result concretely** — the numbers, per repository, and the commit each was
   measured at.
2. **Resolve D-6.** It is the one decision the freeze does not close, and it is "resolved by
   WP-7's measured recall and precision of structural edges against hand-verified ground truth in
   the pilot repository". Record the measurement and the decision it supports in section 4 under
   D-6.
3. **Append to section 8**, the amendment log, with the date, the document and section changed,
   the contradiction or measurement that prompted it, and the contract version bumped if a shape
   changed. An amendment that changes a contract shape is a version bump on that contract, not a
   silent edit.
4. **Re-run the manifest and commit the new hash** if a frozen document changed:

   ```
   npm run freeze
   npm run freeze:check
   ```

   `docs/ARCHITECTURE_FREEZE.md` is not itself in the frozen set, so an amendment recorded only
   there moves no hash — and `freeze:check` must still pass, which is what proves no frozen
   document was edited in passing.
5. **A new architecture version (v0.4) is required** — not an amendment — for anything that
   changes the kernel boundary, the dependency rule, the stage vocabulary, the envelope, the
   confidence or absence vocabularies, or the authorization gate set. If the pilot's result
   implies one of those, say so and stop; do not amend.
6. Where the pilot exposes a defect rather than an architectural gap, it is fixed as a defect and
   the fix re-runs `npm run verify`.

---

## Note on the command name

[IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) section 12 step 2 named the run
`intentra audit --repo <repo> --goal "<goal>"`. The implemented command is
`intentra work --repo <repo> "<request>"`: the read-only audit is what a `work` run *is* under
`mutation_enabled: false`, and the goal is the request rather than a flag. No `audit` command and
no `--goal` flag exist, and none is being added for the pilot — the protocol is unchanged, and
only its command string was stale.
