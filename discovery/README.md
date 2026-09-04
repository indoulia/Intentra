# discovery

Probes that fill the Context Package. Each answers one narrow question, declares its own
availability, mutates nothing, and degrades to UNKNOWN rather than guessing.

Two tiers matter to sequencing: tier-1 orientation probes run before the work item is
resolved, and tier-2 depth plus the `current_reality` set run after, scoped by the admitted
work item. `current_reality` — implementation, tests, PR, CI, reviews, merge state,
deployment, outcome evidence, children, AgentOS history — is what every resume decision is
computed from, and nothing in it may be derived from the request's wording.

See ../docs/CONTEXT_MODEL.md and ../docs/INTENT_AND_WORK_ITEM_RESOLUTION.md.

## The one rule everything else serves

**Discovery that quietly guesses is worse than discovery that reports gaps.** A probe that
cannot establish a value says so, in the one absence vocabulary
([DATA_SEMANTICS.md](../docs/DATA_SEMANTICS.md)), with what it tried and what would fix it.
Nothing in this package fills an absence with a plausible default, and `UNKNOWN` never
silently becomes `FACT` — a strengthening needs evidence the previous assertion did not have,
and one without it is refused and the refusal recorded.

## No I/O lives here

`discovery/` opens no file, runs no process and reaches no network. Every observation goes
through the `AdapterRegistry` port injected at construction — dependency rule 5 of
[KERNEL_BOUNDARY.md](../docs/KERNEL_BOUNDARY.md), enforced by `tools/bin/conformance.mjs` and
by dependency-cruiser. That is what makes an observation replayable at all: a locator the
kernel can re-execute through the same registry.

`src/ops.ts` is the single list of adapter operations the probes ask for. An adapter that does
not offer one is not an absent source, and the probe says which operation is missing.

## Layout

| file | what it holds |
| --- | --- |
| `src/ops.ts` | the `adapter.op` vocabulary discovery asks for, in one table |
| `src/assertions.ts` | the two rules of CONTEXT_MODEL section 1: builders for `FACT`, `INFERENCE`, `UNKNOWN`, freshness, and the promotion guard |
| `src/redact.ts` | excerpting and credential masking — secrets are never captured |
| `src/session.ts` | the one door to the world: evidence minting, access classification, refusal surfacing, call recording |
| `src/probe.ts` | what a probe is: section probes and reality probes, and the ledger they read each other through |
| `src/probes/repository.ts` | identity, structure, stack, commands, manifests, configuration, conventions, schema, domain, sources, api, ui, tests, cicd, deployment, architecture, documentation |
| `src/probes/git.ts` | branches, commits, worktrees, tags, churn, pull requests |
| `src/probes/pm.ts` | access, the work item's ticket, surrounding intent, external documents |
| `src/probes/runtime.ts` | environments, services, data, logs, production |
| `src/probes/capabilities.ts` | skills, tools, plugins, connectors, models, and the authorization surface |
| `src/probes/reality.ts` | the ten `current_reality` elements |
| `src/reconciliation.ts` | the eight-state matrix, at work-item and capability level, with conflicts |
| `src/gaps.ts` | `gaps` as a first-class section, each naming what it blocks |
| `src/package.ts` | running the probes, coverage accounting, assembling a version |
| `src/audit.ts` | replaying every `FACT` through its locator — WP-6's exit test as code |
| `src/service.ts` | `DiscoveryPort`: `orient`, `deepen`, `probe`, `reprobeReality` |

## Tiers

- **`orient`** (tier 1) — identity, structure, stack, git state, project-management access,
  agent and model capabilities. Enough to resolve the work item, and no more. `current_reality`
  is `NOT_COMPUTED` here and says so; the tier-2 probes are recorded as `SKIPPED` with the
  reason rather than being absent from the coverage table.
- **`deepen`** (tier 2) — depth against the admitted scope, plus all ten reality elements. It
  builds on the previous version rather than replacing it.
- **`probe`** (tier 3) — one named probe on demand, producing a **new version** of the package.
- **`reprobeReality`** — not a tier. One element re-read against the world immediately before
  the kernel evaluates a predicate over it, which is what makes reality re-probed rather than
  snapshotted. Git and pull-request state expire in minutes.

## What the composition root injects

`AdapterRegistry`, a `Clock`, and the per-class freshness windows from
`budgets.freshness_windows_ms`. The windows are injected rather than loaded because
`discovery/` does not depend on `policies/`, and a window compiled in here would be a policy
threshold living in the wrong component. A `CapabilitySource` is optional: with none, the
capability matrix is built over the capability ids the work item's scope names.
