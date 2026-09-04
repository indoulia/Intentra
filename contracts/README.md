# contracts/

The stable surface of AgentOS. Every shape in the system, defined once.

**JSON Schema (2020-12) in `schema/` is the source of truth.** TypeScript types and the
embedded schema documents in `src/generated/` are produced from it by `npm run codegen` and
are never hand-edited — `npm run codegen:check` fails the build on any difference between the
committed output and a fresh generation, because a hand-edit is the moment the schema and the
type begin to disagree.

**This package depends on nothing.** Not as a convention: its manifest declares no
dependencies, `tools/bin/conformance.mjs` asserts that it declares none, and it performs no
I/O — the schemas are embedded rather than read from disk. A contract that imports a kernel
type has coupled the two sides together permanently.

```
schema/                 the source of truth, one file per group of related shapes
  common.json           the closed vocabularies everything else draws on
  assertion.json        every leaf value in the system
  evidence.json         the ten kinds, the re-executable locator, kernel-owned verification
  finding.json          the envelope's sections: finding, blocker, unknown, coverage, ...
  handoff-envelope.json the only thing that crosses the boundary between agents
  input-package.json    what an agent receives: typed, never a conversation
  work-item.json        intake, the proposed Work Item, the admitted Work Item
  workflow.json         stage descriptors, templates, the frozen run graph, run.json
  dod.json              profiles, per-criterion verdicts, the completion report
  capability.json       capability records, the chain, the graph
  authorization.json    requests, grants, gate definitions and their classifiers
  context-package.json  the twenty-three sections, current_reality first-class
  adapter.json          operation descriptors, call log, mutation events, idempotency
  event.json            the event log record: one uniform frame, content under `data`
  policy.json           the shape of every policy file the loader validates
  registry.json         skill, model and agent-spec entries
  rejection.json        violation codes: what the kernel refused, and which rule says so

src/
  validator/            a dependency-free JSON Schema 2020-12 validator (decision I-1)
  generated/            types.ts and schemas.ts — generated, committed, never edited
  validate.ts           the sealed schema registry and one typed validator per contract
  vocab.ts              runtime enum values, read out of the schemas rather than restated
  ids.ts                deterministic identity, hashing and idempotency keys
  ports.ts              the interfaces across which the kernel meets what it does not contain
  fixtures.ts           canonical builders for valid instances of every contract

fixtures/               reserved for stored fixtures; enum and event coverage is built
                        rather than stored (decision I-4)
test/
  validator.test.ts     the validator itself, in both directions, keyword by keyword
  doc-examples.test.ts  the expressiveness test: every worked JSON example in the fourteen
                        frozen documents validates, read from the documents themselves
  enum-coverage.test.ts one valid instance per enum value and per event kind
```

## What this package must not contain

- a kernel type
- a default that invents a value (the validator refuses the `default` keyword outright)
- a field an agent may write that the kernel is supposed to own — `Evidence.verification` is
  in the schema because the kernel writes it, and an envelope arriving with it populated is a
  contract violation the kernel detects on receipt

## Versioning

Contracts are the stable surface: agents, models and adapters churn, and a contract changes
only with a version bump and a migration. `HandoffEnvelope` is at **1.2**; the amendments
that took it there are recorded in [ARCHITECTURE_FREEZE.md](../docs/ARCHITECTURE_FREEZE.md)
section 8.
