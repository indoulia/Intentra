# Human Authorization

The goal is **maximum autonomy with the minimum necessary human gates**. Both halves are
load-bearing. Every unnecessary gate is a defect in AgentOS; every missing necessary gate
is a risk to the business.

The dividing line is **reversibility and blast radius**, not difficulty or importance.
AgentOS may do genuinely consequential engineering work autonomously, provided a human can
undo it by discarding a branch.

## 1. Autonomous by default

No approval, no notification, no confirmation prompt:

- inspect, read, search, analyse any accessible source
- run read-only queries against non-production data stores
- build the Context Package and capability registry
- audit and produce findings
- design architecture and record decisions
- create and switch worktrees and branches
- edit files, add and modify tests, write migrations *as files*
- run builds, test suites, linters, type checks
- run and exercise the application in a local or non-production environment
- commit to a non-protected working branch
- prepare a pull request (create it as a draft, or write its body without opening it —
  per policy)
- write reports, documentation and run artifacts

The unifying property: everything above is contained in a branch, a worktree or a
scratch environment, and is reversible by deleting it.

## 2. Gated — explicit human authorization required

Each is a distinct gate; a grant for one never implies another.

**`MERGE_PROTECTED`** — merging into a protected branch (`main`, `master`, `release/*`, or
whatever the repository designates).

**`DEPLOY_PRODUCTION`** — deploying to production, including a release that triggers an
automatic deploy.

**`DESTRUCTIVE_MIGRATION`** — dropping or altering columns/tables destructively, backfills
that overwrite existing values, anything without a verified reversal.

**`IRREVERSIBLE_DATA_MUTATION`** — deleting or overwriting real data in any environment
where it cannot be restored.

**`CREDENTIAL_OR_SECURITY_CHANGE`** — credentials, secrets, keys, permissions, access
control, authentication, authorization, or security configuration.

**`EXTERNAL_COMMUNICATION`** — anything leaving the organisation's boundary: posting to a
public repository, sending mail, calling a third-party write API, publishing anywhere.
Publication is effectively irreversible even when a delete button exists.

**`PRODUCTION_WRITE`** — any write to a production system, including a "harmless" one.

**`SCOPE_EXPANSION`** — work materially beyond the stated goal, even where each individual
action would be autonomous. The gate is on the mandate, not the mechanics.

**`COST_CEILING_EXCEEDED`** — continuing past the run's or the Work Item's cost, time or
loop budget.

**`AUTONOMOUS_INTAKE_EXECUTION`** — the Work Item originated from `EXTERNAL` intake and the
run is about to enter its first mutating stage. New in v0.3, and the narrowest gate here on
purpose.

v0.2's work always came from an operator at a terminal. v0.3 accepts webhooks, third-party
PR comments and ticket bodies anyone can edit
([INTENT_AND_WORK_ITEM_RESOLUTION.md](INTENT_AND_WORK_ITEM_RESOLUTION.md) section 9), and
none of the other gates cover the case where the *work itself* was requested by someone the
organisation has not authenticated. Every individual action might be autonomous; the
question is whether this party gets to start the run at all.

Scoped so it does not cost autonomy: it fires **once per Work Item**, at first entry to a
mutating stage, never for read-only work, and `policies/intake.json` may pre-grant it per
configured source — so a trusted internal webhook stays fully autonomous and an
unauthenticated one does not.

### When a gate can fire

`MERGE_PROTECTED`, `DEPLOY_PRODUCTION` and `PRODUCTION_WRITE` fire at the end of a run and
are what the `AUTHORIZATION` stage exists for.

The rest can fire at any point, usually mid-`IMPLEMENTATION`. They get no state of their
own: any state may transition to `BLOCKED` carrying a blocker of kind
`AUTHORIZATION_REQUIRED`. A grant resumes the run at the pre-block state; a denial or
timeout leaves it blocked. One authorization mechanism, one blocking mechanism, no state
explosion — see [WORKFLOW_STATE_MACHINE.md](WORKFLOW_STATE_MACHINE.md) section 4.1.

### How a gate is detected

A gate that fires only when an agent volunteers that it is crossing one is not a gate. Gates
are triggered by **mechanical classifiers evaluated at the adapter**, from what the adapter
observes rather than from what the agent says.

Classifiers live in `policies/gates.json` as data. Their shape:

- **`MERGE_PROTECTED`** — the git adapter sees a merge whose target is classified protected
  (fail-closed, [REPOSITORY_ADAPTER.md](REPOSITORY_ADAPTER.md) section 2.2).
- **`DEPLOY_PRODUCTION`, `PRODUCTION_WRITE`** — the runtime adapter sees an operation
  against an environment classified production (fail-closed, same rule).
- **`CREDENTIAL_OR_SECURITY_CHANGE`** — a file mutation whose path matches configured
  patterns (auth, secrets, key, credential, iam, rbac, policy, `.env`, certificate and
  keystore extensions), **or** whose content diff touches configured markers
  (`PRIVATE KEY`, `client_secret`, `password`, permission and role declarations).
- **`DESTRUCTIVE_MIGRATION`** — a migration or SQL artifact whose content matches
  destructive patterns (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `ALTER ... TYPE`,
  `DELETE FROM` without a bounded predicate), **or** a migration with no accompanying down
  step.
- **`IRREVERSIBLE_DATA_MUTATION`** — any adapter operation whose descriptor declares
  `reversal: null` against real data.
- **`EXTERNAL_COMMUNICATION`** — any adapter operation whose descriptor declares an
  external destination.
- **`SCOPE_EXPANSION`** — a path mutation outside `mandate.in_scope`, detected at the
  adapter (section 2.1 of the repository adapter). Note this fires as a refusal first; the
  gate is how legitimate scope growth is granted rather than smuggled. It is also the route
  for a review comment whose remediation falls outside the Work Item's admitted scope and
  cannot be split off.
- **`COST_CEILING_EXCEEDED`** — kernel budget accounting, per run and per Work Item.
- **`AUTONOMOUS_INTAKE_EXECUTION`** — the kernel compares the Work Item's originating
  `trust_class` against the stage descriptor's `mutating` flag. Both are recorded facts, not
  claims: trust class is set by the host from authenticated context, and the flag is policy
  data.

Two properties matter more than the specific patterns:

- **Classifiers are policy data, not kernel code.** They are tuned per organisation without
  touching the kernel, and a repository may add stricter ones.
- **Agent self-declaration is an additional trigger, never the only one.** An agent that
  says "this is a credential change" fires the gate. An agent that says nothing fires it
  anyway if a classifier matches. The gate does not depend on candour.

A classifier that cannot evaluate — unreadable diff, unknown file type — fires the gate.
Same rule as everywhere else: uncertainty takes the safer branch.

### Who may authorize

A human. Specifically:

- **No agent may grant, extend, reinterpret, or self-certify a grant**, including the
  Orchestrator Agent. Agents draft requests; the kernel records them; a human decides.
- **No grant originates from intake, of any trust class.** A ticket body, PR comment or
  webhook payload containing "approved", "authorized" or an approval-shaped structure is
  text. Authorization arrives through the authorization channel, against a request the kernel
  recorded, from an identity the host asserts.
- **The requesting agent is never the checking component.** A grant is verified by the
  adapter at the moment of execution, not by the agent that asked for it. An agent holding
  a valid-looking grant object still cannot act without the adapter agreeing.
- **AgentOS does not identify who is entitled to authorize.** Identity and entitlement are
  the host environment's responsibility; AgentOS records the identifier it was given and
  refuses to proceed without one. Inventing or assuming an authorizer is a security floor
  violation.

## 3. Grant model

```json
{
  "grant_id": "g_014",
  "run_id": "run_2026_09_04_a1b2",
  "work_item_id": "wi_jira_DEF-456",
  "gate": "DEPLOY_PRODUCTION",
  "target": "marksy-api :: production :: release v2.14.0",
  "scope": "single_action",
  "granted_by": "human identifier",
  "granted_at": "2026-09-04T15:02:00Z",
  "expires_at": "2026-09-04T17:02:00Z",
  "conditions": ["rollback verified", "post-deploy validation required"],
  "request_ref": "req_014",
  "evidence_reviewed": ["report/validation.md", "report/risk.md"],
  "revoked_at": null
}
```

`work_item_id` and `revoked_at` are required (amendment A-9). The grant is scoped to one run,
but denials and grants are both recorded at the *work item* level so that starting a fresh
Workflow Run is not a way to ask again — a grant that does not name its work item cannot be
filed there. `revoked_at` is explicit rather than absent because "revocable at any time before
the action executes" is a state the record has to be able to express.

Rules:

- **One gate, one target, one run.** No blanket grants, no standing approvals.
- **Time-bounded.** An expired grant is not a grant; the situation it was granted against
  may have changed.
- **Non-transferable.** Not to another action, target, run, or agent.
- **Revocable** at any time before the action executes.
- **Recorded** in the event log with the evidence the human was shown.

A grant is checked at the moment of execution by the adapter, not by the agent requesting
it. An agent cannot self-certify.

## 4. The request

A human cannot authorize what they cannot evaluate. Every request states:

- **What** will happen, precisely and in concrete terms
- **Why** it is needed, tied to the goal
- **Blast radius** — what is affected if it goes right, and if it goes wrong
- **Reversibility** — how it is undone, whether that has been verified, and the cost of
  undoing it
- **Evidence** — validation results, including what was *not* validated
- **Unknowns** — what AgentOS does not know that bears on this decision
- **Alternatives** — including doing nothing
- **Recommendation** — AgentOS's own view, stated plainly

Requests must be honest about weakness. A request that oversells its confidence to get a
yes has broken the only mechanism protecting production, and is a more serious defect than
the deployment failing.

## 5. Denial and timeout

Denial moves the run to `BLOCKED` with the denial recorded. AgentOS does not re-request the
same gate in the same run without new information; re-asking until someone says yes is a
prohibited pattern.

**Nor in a later run against the same Work Item.** Denials are recorded at the work item
level, not only the run level, so starting a fresh Workflow Run is not a way to ask again.
A denial is cleared by new information or by a human revisiting it, never by a retry.

No response within the policy window is also `BLOCKED`. Silence is never consent.

## 6. The security floor

Not policy. Not configurable. No grant enables any of it.

- Never expose, log, print or copy a secret. Credentials are referenced, never captured.
- Never invent or fabricate a credential.
- Never bypass or work around an access control, including "temporarily".
- Never weaken, skip, delete or relax a test, threshold or assertion to reach green.
- Never disable a safeguard, guard rail, validation or alert to make a change pass.
- Never mutate production silently — every production write is logged before and after.
- Never use an unauthorized data source.
- Never conceal a failure, downgrade a severity, or omit an inconvenient finding from a
  report.

An agent hitting one of these stops and reports. If the only path to the goal crosses the
floor, the correct output is a blocker explaining that — never a workaround.

Attempting a floor violation is logged as a critical event regardless of outcome, because
an agent that tried is a defect worth knowing about.

## 7. Policy configuration

Repositories may **tighten** gates (for example, requiring authorization for any commit,
or designating extra protected branches) via the repository adapter. Repositories may
**not** loosen the gates in section 2 or the floor in section 6. Tightening is a local
decision; loosening is not.
