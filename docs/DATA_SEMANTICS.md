# Data Semantics

A universal vocabulary for absence, uncertainty and staleness. AgentOS uses it internally,
the Auditor tests target systems against it, and the Product/UX agent judges whether the
UI honours it.

**The core rule: these meanings do not collapse into one another.** The most common and
most damaging data defect in any system is a fabricated default — a `0`, an empty list, a
`"—"` — standing in for something that was never computed, never fetched, or failed. It
converts an operational failure into a confident lie, and it is invisible to tests.

## The vocabulary

**`ZERO`** — A measured quantity that is genuinely zero. Requires that measurement
happened. "Zero subscriptions recorded" is a claim about the world.

**`NULL`** — No value, and none is expected to exist. Structural absence. An optional field
that legitimately has no content.

**`EMPTY`** — A collection was queried, the query succeeded, and it contained nothing.
Distinct from `ZERO` (a measured scalar) and from `NOT_COMPUTED` (no query happened).

**`UNKNOWN`** — A value exists in the world but this system does not know it. Not an error;
a gap in knowledge.

**`UNAVAILABLE`** — The source could not be reached, was denied, or timed out. A fact about
access, not about the value. Distinguishing `UNAVAILABLE` from `EMPTY` is the difference
between "the exchange is down" and "there are no listings today".

**`NOT_APPLICABLE`** — The concept does not apply to this entity. Asking is a category
error, and displaying `0` or `—` implies otherwise.

**`NOT_COMPUTED`** — Computable, not yet computed. Nothing failed; the work has not run.
Extremely common in pipelines and almost always rendered as `0`.

**`STALE`** — A real value, computed too long ago to be relied on. Carries the value, its
`observed_at`, and the freshness threshold it violated. Usable with disclosure; never
usable silently.

**`CONFLICTING`** — Two or more sources give incompatible values and no rule selects a
winner. Carries all candidates with their provenance. Silently picking one is a
correctness bug.

**`PARTIAL`** — Some of the expected data is present, some is not, and the result is
incomplete. Carries what is present and what is missing. An aggregate over `PARTIAL` input
is itself `PARTIAL`.

**`INSUFFICIENT_EVIDENCE`** — Data exists but is too sparse or weak to support the
conclusion being asked for. A judgment about inference quality, not about the data's
presence. A model, score or recommendation that cannot be justified must return this rather
than a low-confidence number presented as a number.

## Adjacent distinctions that keep getting collapsed

- `ZERO` vs `NOT_COMPUTED` — "the value is 0" vs "we never calculated it"
- `EMPTY` vs `UNAVAILABLE` — "there is nothing" vs "we could not look"
- `UNKNOWN` vs `NOT_APPLICABLE` — "we do not know" vs "the question is meaningless here"
- `STALE` vs `CURRENT` — "true last week" vs "true now"
- `PARTIAL` vs `EMPTY` — "some of it" vs "none of it"
- `INSUFFICIENT_EVIDENCE` vs `UNKNOWN` — "we have data but it proves nothing" vs "we have
  no data"

## Propagation

Semantics propagate through computation; they do not evaporate at a boundary.

- Any aggregate over `PARTIAL` input is `PARTIAL`.
- Any calculation consuming `UNKNOWN` is `UNKNOWN` unless the calculation is provably
  independent of that input.
- `STALE` propagates, and the result's age is the age of the oldest input.
- `CONFLICTING` propagates until a documented resolution rule is applied, and applying that
  rule is recorded as provenance.
- A serialization boundary — API response, message, export, UI render — must carry the
  semantic, not flatten it to `null` and hope the consumer guesses.

## Presentation obligations

The Product/UX agent checks each of these:

- Distinct semantics render distinctly. "No data yet", "Not calculated", "Temporarily
  unavailable", "Not applicable", "Last updated 6 days ago" are five different messages.
- `UNAVAILABLE` reads as a system state, not as a user-facing fact about their data.
- `STALE` always shows its age.
- `PARTIAL` shows what is missing, not just what is present.
- `CONFLICTING` and `INSUFFICIENT_EVIDENCE` are never rendered as a confident value.
- Nothing displayed as a number was invented to fill a gap.

## Provenance and time

Every value that crosses a persistence boundary carries, at minimum:

- **origin** — which source produced it
- **derivation** — what transformed it, if anything
- **observed_at** — when the underlying observation was made
- **recorded_at** — when this system stored it
- **semantic** — one of the values above

A value that cannot answer "where did this come from and when" is untraceable, and the
Auditor treats untraceable values as findings regardless of whether they look correct.

## AgentOS's own use

The same vocabulary governs the Context Package, capability records and validation
verdicts. AgentOS is subject to its own rule: an `UNKNOWN` in the Context Package is never
rendered as a confident claim in a report, and `NOT_VALIDATED` is never reported as
`PASS`.
