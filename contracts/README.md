# contracts

Versioned schemas. The stable surface of AgentOS: agents, models and adapters churn;
contracts change only with a version bump and a migration.

Minimum set, in build order (../docs/IMPLEMENTATION_ROADMAP.md section 3.5):

`Assertion` · `Evidence` · `IntakeRecord` · `WorkItem` · `HandoffEnvelope` ·
`ContextPackage` · `CapabilityRecord` · `AuthorizationRequest`/`Grant` · `WorkflowTemplate` ·
`StageDescriptor`, then `Finding` · `Blocker` · `DoDProfile` ·
`AdapterOperationDescriptor` · `MutationEvent`.

`WorkItem` and the workflow contracts come early for a structural reason: the store layout
hangs off the work item, and the state machine is data-driven, so neither can be built before
the shape of its data exists.

Two fields are kernel-owned and rejected if an agent supplies them: `Evidence.verification`
and everything in the mutation event stream.

`contracts/` depends on nothing. A contract that imports a kernel type has coupled the two
sides together permanently.

**JSON Schema (2020-12) under `schema/` is the source of truth; TypeScript types under
`types/` are generated from it and never hand-edited.** A hand-edited type is the moment a
schema and its type begin to disagree about an optional field, and the disagreement surfaces
much later as a validated envelope the compiler was happy with. Validators are compiled from
the same schemas, so there is one definition of every shape.

`fixtures/` carries a valid example for every enum value that drives control flow, and an
invalid example for every cross-field consistency rule. Those fixtures are what the kernel's
rejection paths are tested against, and every worked JSON example in the frozen design
documents must validate — a doc example that will not is a documentation defect, not a schema
limitation. See ../docs/IMPLEMENTATION_PLAN.md section 2.

Empty in Phase 0 — design only.
