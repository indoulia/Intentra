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
