# registries

Representation, indexing, query and **ranking** for what AgentOS can invoke: skills and
models.

**The registries rank; the kernel selects.** This package produces an ordered candidate list
with scores and reasons — deterministic, testable, model-free. The kernel picks from that
list, applies policy, and records the choice. That split is why skill and model selection is
not a place business logic accumulates: the ranking rules live here as data-driven scoring
rather than as branches in the run loop.

```
src/
  ranking.ts   the shared order: excluded last, score, then id, so a ranking is reproducible
  skills.ts    capability match, specificity, cost, reliability, safety — in that order
  models.ts    the cheapest model that meets the requirement, with every shortfall named
  index.ts     EnumeratedRegistries: the Registries port over what the host enumerated
```

`@agentos/registries` depends on `@agentos/contracts` and nothing else. It therefore cannot
reach a host, and does not try: **the host adapter enumerates, and the registry ranks what it
is handed.** That is the boundary doing its job, and it is why this package needs no I/O
exception in the conformance check.

Three rules the ranking holds, each of them a frozen requirement rather than a preference:

- **Nothing is omitted.** A candidate that cannot be used still appears, carrying
  `excluded_because`. An unreachable connector is recorded `UNAVAILABLE` and never dropped:
  "this host has no project-management access" and "it is configured and the server failed to
  connect" lead to different decisions, and only the second is worth reporting to a human.
- **A skill that can spawn an agent is never selectable**, and a skill whose spawning
  behaviour could not be determined counts as spawning.
- **Unknown never satisfies a requirement.** An unknown reasoning depth does not meet a
  deep-reasoning requirement and an unknown precision class does not meet a high-precision
  one. Selection degrades sensibly rather than assuming the best case.

No product-specific identifier appears anywhere in this package. AgentOS finds a skill
because a host exposes it, never because AgentOS was told to expect it.

The capability registry — what the *target system* can do — is a later work package
(CAPABILITY_MODEL.md); nothing here models it yet.

See ../docs/SKILL_AND_MODEL_SELECTION.md and ../docs/KERNEL_BOUNDARY.md.
