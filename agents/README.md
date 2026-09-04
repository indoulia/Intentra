# agents

Role specifications and the dispatch boundary: the one interface between the kernel and a
model.

Specifications, not prompts. A role here is data — what it owns, what it must be given, what
it owes back, which Definition-of-Done criteria it supplies verdicts for, and what model
*properties* its work needs. Text is a property of the substrate, and exactly one file turns
a specification into any.

See [../docs/AGENT_ROLES.md](../docs/AGENT_ROLES.md),
[../docs/AGENT_HANDOFF_CONTRACT.md](../docs/AGENT_HANDOFF_CONTRACT.md) and
[ARCHITECTURE_FREEZE D-2](../docs/ARCHITECTURE_FREEZE.md).

## What is here

```
src/roles/specs.ts             the MVP role specifications, as data
src/roles/catalog.ts           AgentCatalog: specification + policy, assembled and checked
src/dispatch/tool-grants.ts    permitted adapter operations -> the dispatch allowlist
src/dispatch/input-package.ts  the typed input, with only the required sections materialized
src/dispatch/brief.ts          the one place a specification becomes text
src/dispatch/envelope.ts       parsing, and deliberately nothing more
src/substrate/surface.ts       D-2's conformance check, as arithmetic over two sets
src/substrate/transport.ts     the seam a substrate swap replaces
src/substrate/claude-agent-sdk.ts   the only file that reaches outside
```

## The three MVP roles

Eight roles exist in the architecture. A read-only milestone dispatches three, and only those
three are specified here, because a specification written for a dispatch nobody makes is a
specification nobody has checked.

- **Context Discovery**, with both mandates. `resolution` runs before any workflow exists,
  against tier-1 orientation discovery, and turns an `IntakeRecord` into a proposed Work Item;
  `context` runs after admission and builds the Context Package. Resolution asks for mid
  context at **high precision** — the highest precision-per-token dispatch in the system,
  because every later decision inherits its reading of the work and no downstream check can
  tell a plausible wrong answer from a right one.
- **Auditor**, first pass. Deep reasoning at high precision: adversarial analysis of a system
  that looks fine. Its outputs and the criteria it owes are the `AUDIT` stage descriptor's,
  and the catalog refuses to build if the two ever disagree.
- **Orchestrator Agent**, whose `permitted_adapters` is empty — the component that judges
  evidence must not also manufacture it — and whose choices are exactly three while the
  milestone is read-only. Those three are derived from the policy set rather than written
  down, so they become four on the day something mutates.

No specification names a model. The registries rank what exists against these requirements and
the kernel selects and records; a model id compiled in here would be the hard-coding
[SKILL_AND_MODEL_SELECTION](../docs/SKILL_AND_MODEL_SELECTION.md) opens by forbidding.

## D-2's binding condition

The Agent SDK is the Claude Code harness as a library, so it arrives with built-in file,
shell, search and web tools and with subagent spawning. Making it satisfy AgentOS's posture is
a **subtraction** problem, and subtraction fails open. So:

- **The tool surface is an allowlist.** Every built-in tool is absent rather than forbidden,
  and the only tools that exist are the granted adapter operations, served by an in-process
  MCP server. No user, project or organisation setting can add to either.
- **No subagent or task-spawning tool is ever exposed**, in four layers: no grant may carry a
  spawning name, no subagent is defined, the permission callback denies anything off the
  allowlist, and the conformance check refuses a surface advertising any agent at all.
- **The conformance check reads the surface the substrate reports**, not the configuration it
  was given, and `UNVERIFIABLE` fails closed. An SDK upgrade that adds a tool breaks the
  check rather than passing quietly.

One dispatch is one fresh session. The transport port has no field for a session id, a resume
or a fork, so carrying conversation between dispatches is impossible rather than forbidden.

## What this package will not do

- Reach `core/`. Its manifest does not declare it, and `rm -rf core && tsc -b agents` is run
  rather than quoted.
- Reach the world anywhere but `src/substrate/claude-agent-sdk.ts`, which is the one file
  D-2's reversal clause wants a substrate swap to be a change to.
- Repair an envelope. A final message that is not exactly one JSON object is a `FAILED`
  dispatch; extracting one from prose or unwrapping a fence would be guessing which text the
  agent meant as its answer.
- Sanitize an agent's claim. A populated `verification` block, an overstated `coverage`, an
  invented `artifacts_changed` entry — all pass through exactly as written, so that the
  kernel's disbelief machinery has the actual claim to refuse.

## Tests

`test/` runs on Node's built-in runner against `dist/`, offline, with no API key and no
network. The substrate is driven over an injected fake transport; `test/fake-substrate.ts` is
a substrate-independent `AgentSubstrate` so the boundary and the roles can be exercised with
no model at all.
