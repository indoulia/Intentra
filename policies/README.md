# policies/

Declarative, human-readable, versioned in git. **Policy is data the kernel enforces, not
behaviour an agent is asked to remember** — that is the difference between a safeguard and a
suggestion.

Nothing in `data/` is code, and `tools/bin/conformance.mjs` asserts that: only `.json` and
`.md` files live there. No threshold appears anywhere else in the system — the kernel reads
every cap, window, rate and bound from here.

```
data/
  stages.json           the twenty template stages, one descriptor each
  workflows/*.json      the nine templates
  workflow-floor.json   the nine floor rules
  predicates.json       four applicability predicates, twelve reality predicates
  work-items.json       per type, the minimum evidence class required to assert it
  intake.json           what each host can assert, and the instruction markers to record
  evidence.json         always-verify classes, sample rate, thresholds, per-kind comparators
  budgets.json          loop caps, cost ceilings, freshness windows — per run and per work item
  paths.json            the absolute deny-list, and the scratch roots
  gates.json            the ten gates and their mechanical classifiers
  execution.json        which risk classes this installation may execute
  agents.json           which proposals and statuses each role may make, and where
  dod/criteria.json     the eighteen criteria and their single owning role
  dod/<profile>.json    the seven profiles
  security-floor.md     not policy, not configurable, no grant enables any of it

src/
  data-source.ts        the one file here that touches the filesystem (decision I-11)
  graph.ts              graph arithmetic: reachability, dominance, exclusion, well-formedness
  load.ts               the loader, and the workflow floor
```

## The loader's job

A mis-authored policy set fails **loudly at startup** rather than quietly during a run, and a
failure names the rule and the file. `[merge-requires-validation-and-authorization]
workflows/task.direct.json: VALIDATION must be on every route to MERGE` is actionable;
"policy failed to load" is not.

Referential integrity over the whole set is cheap, model-free, and catches the authoring
errors that would otherwise surface mid-run:

- every stage a template names has a descriptor, and the read-only set matches
  WORKFLOW_STATE_MACHINE 2.3 exactly
- every predicate an edge, a `satisfied_by` or a floor rule names is defined
- every loop edge names a counter bound to a cap in `budgets.json`
- every graph is well-formed, **and stays well-formed under every legal exclusion** — which
  is what forces a template to carry a bypass edge around each optional stage
- every branch is a complementary pair, so exactly one arm can hold
- every template passes the floor, with "before" and "after" read as **dominance** rather
  than as position in a list: `AUTHORIZATION before MERGE` has to hold on every route to
  merge, not merely on the one someone had in mind
- every template can supply the **critical** criteria of its own default profile — a profile
  demanding a verdict no stage in the template owns is a profile that can never complete, and
  the failure would otherwise look like a mysterious `INCOMPLETE`
- every DoD criterion has exactly one owning role, and the Implementer owns none
- every gate has at least one mechanical classifier, and every classifier fires when it
  cannot evaluate
- the deny-list covers `state/`, `policies/` and `contracts/`
- the Orchestrator Agent holds no adapters

## Predicate-keyed floor rules are run-start rules

`architecture.required`, `ux.required` and `regression.suspected` key on reality, and reality
does not exist at policy load, so the loader skips them. That is not a weakening.
`task.direct` deliberately has no `ROOT_CAUSE` stage; it is not mis-authored, it is simply
**inadmissible** when `regression.suspected` evaluates `TRUE`, and the kernel then falls back
to the most conservative admissible template and logs the override.

That is the mechanism the regression rule exists for. A defect misclassified as a `TASK`
selects `task.direct`, the rule fires at run start from observed reality, admission fails for
want of `ROOT_CAUSE`, and the fallback is a read-only investigation. **The misclassification
costs a lap and cannot buy a symptom patch.**

## Tightening, not loosening

A repository may tighten the gates through its own `.agent/policies.json` — extra protected
branches, authorization for any commit. It may not loosen them, and it cannot touch this
directory at all: `paths.json` denies every write under `policies/`.
