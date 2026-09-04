# Definition of Done

Completion is judged at the **capability** level, against a **DoD profile** whose criteria
are selected dynamically for that capability.

Done is explicitly not "tests pass". A green suite over a disconnected writer is a green
suite over nothing, and that failure mode is common enough to be the reason this document
exists.

## 1. The criteria

Each is either `MET`, `NOT_MET`, `NOT_APPLICABLE` (with reason), or `NOT_VALIDATED` (with
reason). `NOT_VALIDATED` is never counted as met — that substitution is the single most
likely way this model gets quietly defeated.

**1. Context understood** — the capability, its consumers and its dependencies are
documented in the Context Package as `FACT`, not `INFERENCE`.

**2. Architecture coherent** — the implementation matches the approved architecture; no
unrecorded deviations.

**3. Canonical ownership** — exactly one owner for each entity the capability touches. No
duplicate sources of truth.

**4. Source and data contracts** — inputs and outputs have explicit contracts, including
failure and absence semantics.

**5. Implementation complete** — every planned work unit is done; no TODOs standing in for
required behaviour.

**6. Writers and readers connected** — data written is read; data read is written. No
orphans anywhere in the chain.

**7. API** — where consumers exist, an API exposes the capability, returns real data, and
preserves data semantics.

**8. UI** — where a user-facing surface applies, it exists and presents truth.

**9. Failure states** — every failure mode is handled explicitly. Errors are distinguished
from emptiness ([DATA_SEMANTICS.md](DATA_SEMANTICS.md)); no fabricated defaults.

**10. Provenance** — every persisted value can answer "where did this come from and when".

**11. Observability** — logs, metrics or traces let an operator tell whether this
capability is working right now.

**12. Tests** — unit and integration tests exist, they assert on real behaviour rather than
on mocks, and they fail when the capability breaks.

**13. Capability validation** — a real record has been traced end to end through the chain
with correct output.

**14. UX validation** — where a UI applies, the Product/UX agent accepted it, including
empty, loading, partial, stale and error states.

**15. Production validation** — where deployed, evidence from production that the
capability works with real data.

**16. Documentation** — documentation reflects what was built and is not contradicted by
the code.

**17. No known orphan capability** — the change introduced no new orphan writer, reader,
store, calculation, API or surface.

**18. Outcome and learning path** — what changes for the user is stated, and how the system
would learn it was wrong is either implemented or explicitly deferred with a reason.

Criterion 12 deserves emphasis: passing tests are evidence about the tests. Criterion 13 is
where a capability is actually proven, and 12 without 13 is the failure mode this whole
document is built to catch.

## 2. Profiles

Applicability is determined from the capability, not from the goal's wording. A profile is
a selection of the criteria above plus their evidence requirements.

- **`data-capability`** — a pipeline producing data. All chain stages apply. Provenance,
  semantics, orphan checks and capability validation are non-negotiable.
- **`service-capability`** — an API or service with no UI. Criterion 8 and 14 are
  `NOT_APPLICABLE`.
- **`ui-capability`** — a user-facing surface. Criterion 14 is mandatory; source and
  ingestion may be `NOT_APPLICABLE` if the capability only consumes an existing API.
- **`internal-capability`** — tooling or infrastructure. UI, outcome and learning usually
  `NOT_APPLICABLE`.
- **`fix`** — a defect repair inside an existing capability. Criteria narrow to the change
  and its blast radius, plus a regression test that fails without the fix.
- **`audit`** — the deliverable is findings. Done means findings are evidence-backed,
  coverage is stated, and every unknown is recorded.
- **`documentation`** — done means accurate against the code as verified, not merely
  written.

The Architect assigns a profile per work unit; the Orchestrator validates the assignment
against the capability record. A profile that marks an inconvenient criterion
`NOT_APPLICABLE` without a reason is rejected.

## 3. Evidence requirements

A criterion is `MET` only with evidence of the required strength:

- Structural criteria (3, 4, 6, 17) — static analysis plus the capability graph
- Implementation criteria (2, 5) — diff review against the architecture
- Behavioural criteria (9, 12) — test execution output
- Capability criteria (13) — a traced real record, with the trace recorded
- Runtime criteria (11) — observed logs, metrics or traces from a running system
- Production criteria (15) — production observations, under authorization
- UX criteria (8, 14) — the Product/UX verdict with the states actually exercised
- Knowledge criteria (1, 10, 16, 18) — package contents and documentation diffs

Self-assertion is never evidence. An Implementer saying "connected" does not satisfy
criterion 6; the graph does.

## 4. Completion verdicts

- **`COMPLETE`** — every applicable criterion `MET`.
- **`COMPLETE_WITH_GAPS`** — all critical criteria met, non-critical ones explicitly
  deferred with recorded reasons and follow-ups. Requires human acknowledgement.
- **`INCOMPLETE`** — one or more critical criteria not met.
- **`INDETERMINATE`** — completion cannot be judged because evidence was unobtainable, for
  example no production access. States exactly what is missing.

`INDETERMINATE` must never be reported as `COMPLETE_WITH_GAPS`. "We could not check" and
"we checked and accepted a gap" are different facts about the world, and only one of them
is a decision someone made.

## 5. Reporting

The completion report states, per criterion, the verdict and its evidence; then the
capability status (`PROVEN` / `WORKING` / `PARTIAL` / ...), what was validated, what was
not and why, what a human accepted, and what remains open.

It is written for a reader who was not present and does not trust the run.
