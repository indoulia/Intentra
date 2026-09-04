# contracts

Versioned schemas. The stable surface of AgentOS: agents, models and adapters churn;
contracts change only with a version bump and a migration.

Minimum set, in build order (../docs/IMPLEMENTATION_ROADMAP.md section 3.5):

`Assertion` · `Evidence` · `HandoffEnvelope` · `ContextPackage` · `CapabilityRecord` ·
`AuthorizationRequest`/`Grant`, then `Finding` · `Blocker` · `DoDProfile` ·
`AdapterOperationDescriptor` · `MutationEvent`.

Two fields are kernel-owned and rejected if an agent supplies them: `Evidence.verification`
and everything in the mutation event stream.

`contracts/` depends on nothing. A contract that imports a kernel type has coupled the two
sides together permanently.

Empty in Phase 0 — design only.
