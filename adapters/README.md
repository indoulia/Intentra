# adapters

The only path between agents and the outside world: repository, git, host, project-management
and runtime adapters.

Adapters are also how work *arrives*: each one normalizes the sources it covers into an
`IntakeRecord` carrying a re-executable locator, so "the ticket said X" is checkable rather
than remembered. Event and webhook intake belongs to the host adapter.

Adapters are an enforcement layer, not a convenience layer. They own:

- **path confinement** — worktree root, mandate scope, absolute deny-list
- **fail-closed classification** — unknown branch means protected, unknown environment
  means production
- **gate classification** — mechanical detection of gated operations from what is observed
- **grant checking** — at execution time, never by the agent that requested it
- **call log** — every call logged, reads included, so coverage claims are reconcilable
- **mutation events** — emitted at call time, with reversals, before returning
- **idempotency** — completed-key records at two scopes: per dispatch, so a retried dispatch
  does not duplicate effects, and per work item for external and non-reversible operations, so
  a second run does not open a second PR
- **evidence replay** — read-only re-execution of evidence locators for kernel verification
- **redaction** — secrets referenced, never captured
- **platform differences** — no OS assumption belongs in the kernel or an agent

Every operation carries a descriptor: `mutating`, `reversal` (or `null`),
`idempotent_by_key`, `identity_args`, `external_destination`, `observation_safe` (+
`incidental_artifacts`), `args_schema` and `gates`. `observation_safe` is what gates evidence
replay: replayable without altering authoritative state, without consuming what it measured,
and with no effect beyond declared incidental artifacts such as coverage output and build
caches. Defined in ../docs/REPOSITORY_ADAPTER.md section 2.3.

## Layout

```
src/
  descriptors.ts   the registry, and everything it refuses at startup
  define.ts        how an operation is declared, with every default failing closed
  framework.ts     AdapterRegistry: the order of the checks, and what each refuses
  paths.ts         path confinement — resolve, confine, deny
  glob.ts          the matcher the deny-list, the mandate and the artifact check share
  classification.ts fail-closed classification, and why the value is the dangerous one
  evidence.ts      the per-kind comparators from policies/evidence.json
  assertions.ts    FACT owes evidence, INFERENCE owes what it came from, UNKNOWN owes a fix
  call-log.ts      the call log and the refusal log
  redaction.ts     secrets by name and location, never by value
  ports.ts         the injected edges: grants, mutations, both ledgers, the process runner
  errors.ts        absent, unreachable, not configured — three different silences
  system.ts        the real host, behind those ports
  ops/             the five read-only families, and the suite factory
```

## What is injected, and why

`adapters/` may touch the filesystem and spawn a process; it is the package the dependency
rule names for that. Four things it may **not** own, and each arrives as a port the
composition root supplies:

- **`GrantChecker`** — the grant lifecycle is `core/`'s (KERNEL_BOUNDARY 7), and
  `adapters -> core` is a forbidden edge. The check still *executes inside the adapter, at
  call time*, which is the property that matters.
- **`IdempotencyLedger`** — the work-item-scoped completed-key ledger is durable run state,
  and only the kernel writes `state/`. The adapter reads and invalidates through the port.
- **`MutationSink`** — a mutation event is a journal entry the kernel appends.
- **`RunLedgerReader`** — AgentOS's own run history, which `host.read_run_history` and
  `host.read_child_work_items` report. Same reason: it lives under `state/`.

Every one of them **fails closed by default**: no checker means no grant, no sink means no
mutation, no idempotency ledger means no deduplication, and no run-ledger reader means
`UNAVAILABLE` rather than an empty history. A missing collaborator is not permission, and an
empty answer is not the same as no answer.

`PathConfinement` takes a fifth injectable, `FileSystemProbe`, defaulting to `node:fs`. It is
there so the assertions that matter most — a symlink escaping the worktree, a chain, a broken
link, `EACCES`, `ELOOP`, a path that resolves differently on a second call — run on every
host rather than only on one that grants symlink privilege. `confinement.test.ts` drives them
through an injected filesystem; `paths.test.ts` runs the same cases against the real one. No
test in this package decides at runtime not to assert.

## The operation vocabulary

Forty-eight operations across the five families. The names are load-bearing: the kernel
matches an agent spec's `permitted_adapters` against the **first dotted segment** of
`descriptor.adapter`, and derives the granted tool name as
`adapter.replace(/\./g, '_') + '__' + op` — so `repo.read_file` becomes `repo__read_file`,
which is the set D-2's tool-surface conformance check compares against. `discovery/src/ops.ts`
declares the vocabulary its probes call and every entry in it is registered here;
`discovery-surface.test.ts` fails when the two drift.

`observation_safe` is decided per operation rather than granted wholesale. Exactly one
registered operation declares it `false`: `runtime.read_logs`, whose re-execution advances a
cursor and consumes the observation it reported.

## Milestone 1

**No mutating operation is registered**, and `DescriptorRegistry` refuses to register one
while `policies/execution.json` says `mutation_enabled: false`. The mutation, reversal,
idempotency and grant machinery is nevertheless complete and exercised — by tests that build a
test-only registry with mutation enabled — so that when the first mutating operation is
registered it lands in a system that already cannot perform an unlogged or unauthorized one.

See ../docs/REPOSITORY_ADAPTER.md and ../docs/KERNEL_BOUNDARY.md.
