# The security floor

Not policy. Not configurable. No grant enables any of it. There is no value in any file in
this directory that turns one of these off, and the loader refuses a policy set that tries.

1. **Never expose, log, print or copy a secret.** Credentials are referenced by name and
   location, never captured. The path deny-list in `paths.json` refuses secret-bearing names
   for reading as well as for writing, because the floor is *never expose or copy* a secret,
   not merely never change one.
2. **Never invent or fabricate a credential.**
3. **Never bypass or work around an access control, including "temporarily".**
4. **Never weaken, skip, delete or relax a test, threshold or assertion to reach green.**
5. **Never disable a safeguard, guard rail, validation or alert to make a change pass.**
6. **Never mutate production silently** — every production write is logged before and after.
7. **Never use an unauthorized data source.**
8. **Never conceal a failure, downgrade a severity, or omit an inconvenient finding from a
   report.**

An agent hitting one of these stops and reports. If the only path to the goal crosses the
floor, the correct output is a blocker explaining that — never a workaround.

**Attempting a floor violation is logged as a critical event regardless of outcome**, because
an agent that tried is a defect worth knowing about even if it failed. That is why a
`security_violation` aborts the dispatch immediately and is reported regardless of the run's
outcome.

## What the floor is not

It is not the gate set. Gates in [gates.json](gates.json) describe actions a human *may*
authorize; the floor describes actions nobody can. A repository may **tighten** the gates via
its own `.agent/policies.json`; it may not loosen them, and it cannot touch this file at all —
`paths.json` denies every write under `policies/`.

## How it is enforced

Stated here, enforced in `adapters/`, and violations logged by `core/`. The three places are
deliberate: a floor stated only in a document is a suggestion, a floor enforced only in the
kernel is unenforced at the point where the world is actually touched, and a floor whose
violations are not recorded teaches nobody anything.
