import assert from 'node:assert/strict';
import type { Connector } from '@agentos/adapters';
import { ResourceAbsentError, ResourceUnreachableError } from '@agentos/adapters';
import type { Event, IntakeSource, ModelEntry, Registries } from '@agentos/contracts';
import type { RunResult, StartInput } from '../../src/kernel.js';
import {
  admitIntake,
  buildKernel,
  identityResolverFor,
  intakeRereaderFor,
  type BuiltKernel,
  type OperatorPrompt,
} from '../../src/composition/index.js';
import { main, sourceLocatorFor, type CliIo } from '../../src/cli/main.js';
import { ScriptedSubstrate, type ScriptedResponse } from '../doubles.js';
import { assertUnchanged, type ScratchWorld, type WorldFingerprint } from './world.js';

/**
 * The end-to-end rig.
 *
 * Every scenario drives the *composition root*, not a hand-assembled port bag: `buildKernel`
 * wires the real adapter framework against a real scratch repository, the real discovery
 * service, the real registries, the real agent catalogue and the real run store, the intake is
 * admitted through `admitIntake` exactly as `agentos work` admits it, and then
 * `kernel.work(...)` runs with the same two callbacks `agentos work` passes. The single
 * substitution is the substrate — a scripted double instead of a model — because the ground
 * rule for this suite is that no test may need a network, a key or a live model.
 *
 * That substitution is exactly the one `core/src/cli/main.ts` does *not* make, so a scenario
 * here is `agentos work` with the model replaced by a recording and nothing else replaced.
 * `status` and `narrate` are then driven through `main()` itself against the same state root,
 * which is what makes "the flow reached a durable run record" a claim about the CLI rather
 * than about the store.
 */

/** A model the host declares. One is enough; scenario 19 declares none on purpose. */
export const DECLARED_MODEL: Partial<ModelEntry> = {
  id: 'model.scripted',
  context_window: 200_000,
  reasoning: 'deep',
  coding: 'strong',
  vision: 'strong',
  tool_use: 'strong',
  usd_per_mtok_input: 3,
  usd_per_mtok_output: 15,
  latency_class: 'medium',
  precision_class: 'high',
};

export interface WorkOptions {
  readonly world: ScratchWorld;
  readonly raw: string;
  readonly source?: IntakeSource;
  /** The envelopes the substrate hands back, dispatch by dispatch. */
  readonly script: readonly ScriptedResponse[];
  /** What the host declares. `[]` is a host with no model, which blocks every dispatch. */
  readonly models?: readonly Partial<ModelEntry>[];
  /** Where a question to the operator goes. Absent, nobody answers and nobody invents one. */
  readonly operator?: OperatorPrompt;
  /** The project-management system, or `null` for a host that has none. */
  readonly projectManagement?: Connector | null;
  /** The runtime, or `null` for a host that can reach no running system. */
  readonly runtime?: Connector | null;
  /** Overrides for the two callbacks the CLI supplies, for the seam-level scenarios. */
  readonly resolveIdentity?: StartInput['resolveIdentity'];
  readonly rereadIntake?: StartInput['rereadIntake'];
  /**
   * The model and skill registry, for the one scenario that needs it to change mid-run.
   *
   * Scenario 19's second case withdraws the model after admission, which nothing else in the
   * build can express: the registry is enumerated once at build time and is otherwise a
   * constant for the life of the run.
   */
  readonly registries?: Registries;
}

export interface WorkOutcome {
  readonly built: BuiltKernel;
  readonly result: RunResult;
  readonly substrate: ScriptedSubstrate;
  /** The run log, or `[]` where no run was ever started. */
  readonly log: readonly Event[];
  readonly before: WorldFingerprint;
  readonly after: WorldFingerprint;
  /**
   * Why the intake source could not be dereferenced at admission, or `null` where it was.
   *
   * `agentos work` prints this on stderr and runs on what the operator typed, which is why the
   * drift check will say `UNAVAILABLE` at the end. Carried out of the rig so a scenario can
   * assert the reason rather than only the consequence.
   */
  readonly unresolvedIntake: string | null;
}

export async function work(options: WorkOptions): Promise<WorkOutcome> {
  const source = options.source ?? 'NATURAL_LANGUAGE';
  const substrate = new ScriptedSubstrate(options.script);
  const before = options.world.fingerprint();

  const built = await buildKernel({
    stateRoot: options.world.stateRoot,
    repositoryPath: options.world.repositoryPath,
    intake: { source, raw: options.raw, received_at: new Date().toISOString() },
    env: { AGENTOS_MODELS: JSON.stringify(options.models ?? [DECLARED_MODEL]) },
    substrate,
    projectManagement: options.projectManagement ?? null,
    runtime: options.runtime ?? null,
    ...(options.registries === undefined ? {} : { registries: options.registries }),
    ...(options.operator === undefined ? {} : { operator: options.operator }),
  });

  /*
   * The intake, admitted the way `agentos work` admits it.
   *
   * This used to hand the kernel `sourceLocatorFor(source, raw)` and the operator's `raw`
   * directly, which is what `core/src/cli/main.ts` did *before* D4 was fixed — and the reason
   * this rig then quietly certified a code path production no longer takes. `admitIntake`
   * dereferences a pointer-shaped source once, through the same reader the drift check
   * re-executes at `COMPLETION`, so what is hashed at admission and what is compared at the end
   * are produced by the same code against the same locator. A scenario that skipped it would
   * be a scenario about a CLI nobody ships.
   *
   * The three calls below are, deliberately, the same three `main.ts`'s `work()` makes and in
   * the same order. The substrate is the only substitution this rig makes.
   */
  const admitted = await admitIntake(built, sourceLocatorFor(source, options.raw), options.raw);

  const result = await built.kernel.work({
    source,
    sourceLocator: admitted.locator,
    raw: admitted.raw,
    resolveIdentity: options.resolveIdentity ?? identityResolverFor(built),
    rereadIntake: options.rereadIntake ?? intakeRereaderFor(built),
  });

  const after = options.world.fingerprint();
  const log = result.workItemId !== null && result.runId !== null
    && built.store.runExists(result.workItemId, result.runId)
    ? built.store.readRunLog(result.workItemId, result.runId).records
    : [];

  return { built, result, substrate, log, before, after, unresolvedIntake: admitted.unresolved };
}

/**
 * An envelope preceded by the reads that make its coverage claim true.
 *
 * `COVERAGE_OVERSTATED` is a cross-field rejection: an envelope claiming it examined a path no
 * adapter call touched is refused, because coverage is the field that distinguishes "found
 * nothing there" from "never looked there". A scripted agent therefore has to actually read
 * the files it says it read — through the granted tool, through the real adapter, against the
 * real worktree — which is also what makes the read-only claim worth something.
 */
export function reading(
  paths: readonly string[],
  envelope: unknown,
): ScriptedResponse {
  return {
    kind: 'CALLS_THEN_ENVELOPE',
    calls: paths.map((path) => ({ tool: 'repo__read_file', args: { path } })),
    envelope: () => envelope,
  };
}

/**
 * The six envelopes of a full run — the prologue's three, then `investigation.readonly` — as a
 * script.
 *
 * The context, audit and root-cause envelopes are wrapped in the reads that make their
 * coverage claims true; the resolution, workflow and completion envelopes claim no repository
 * coverage and need none. The order is the order the dispatches happen in, which is what makes
 * a positional script honest: `context-discovery/resolution` on tier-1 orientation,
 * `context-discovery/context` after admission, `orchestrator/orchestration` at
 * `WORKFLOW_SELECTED`, and only then the template's own stages.
 *
 * The third position is the one decision K-1 added. Before it was corrected the Orchestrator's
 * dispatch never fired, every run took the kernel's fallback template, and the proposal path
 * was reached by no scenario in this suite.
 */
export function investigationScript(
  envelopes: readonly unknown[],
  paths: readonly string[],
): readonly ScriptedResponse[] {
  const [resolution, context, workflow, audit, rootCause, completion] = envelopes;
  return [
    { kind: 'ENVELOPE', envelope: resolution },
    reading(paths, context),
    { kind: 'ENVELOPE', envelope: workflow },
    reading(paths, audit),
    reading(paths, rootCause),
    { kind: 'ENVELOPE', envelope: completion },
  ];
}

/* ------------------------------------------------------------------ the CLI ------- */

export interface CliResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Runs `agentos <argv>` against a world's state root, capturing both streams. */
export async function cli(
  world: ScratchWorld,
  argv: readonly string[],
  ask?: OperatorPrompt,
): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stateRoot: world.stateRoot,
    ...(ask === undefined ? {} : { ask }),
  };
  const code = await main(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/* ------------------------------------------------- what every scenario asserts ---- */

export interface DurabilityExpectations {
  /**
   * Whether the run got as far as selecting a workflow.
   *
   * A run that blocks at `UNDERSTOOD` — the ambiguity ladder's fifth rung, say — never
   * selects one, and demanding the workflow paragraph of its narrative would be demanding an
   * account of a decision it correctly declined to make.
   */
  readonly selectedWorkflow?: boolean;
}

/**
 * The four obligations every scenario in this suite carries, checked in one place.
 *
 * They are checked together rather than scattered because the point of the suite is that a run
 * reaches a durable, readable, honest record *and* leaves the world alone — and a scenario that
 * quietly dropped one of the four would be the failure that makes the whole exercise
 * worthless.
 */
export async function assertReadOnlyAndDurable(
  world: ScratchWorld,
  outcome: WorkOutcome,
  expectations: DurabilityExpectations = {},
): Promise<{ readonly status: CliResult; readonly narrative: CliResult }> {
  /* 1. Nothing was mutated: the repository is byte-identical and git agrees. */
  assertUnchanged(outcome.before, outcome.after, (actual, expected, message) => {
    assert.equal(actual, expected, message);
  });

  /* 2. No mutating adapter operation was called, and no mutation event was journalled. */
  assertNoMutatingCall(outcome);

  /* 3. A durable run record exists, and the CLI can read it. */
  assert.notEqual(outcome.result.workItemId, null, 'a work item was admitted and is durable');
  assert.notEqual(outcome.result.runId, null, 'a run was started and is durable');
  const workItemId = outcome.result.workItemId ?? '';
  const runId = outcome.result.runId ?? '';
  assert.ok(
    outcome.built.store.runExists(workItemId, runId),
    'the run directory and its log survive the process that wrote them',
  );

  const status = await cli(world, ['status', workItemId, runId]);
  assert.equal(status.code, 0, 'agentos status reads the run back');
  assert.ok(status.out.length > 0, 'agentos status has something to say about the run');

  const narrative = await cli(world, ['narrate', workItemId, runId]);
  assert.equal(narrative.code, 0, 'agentos narrate reads the run back');

  /* 4. The narrative states what AgentOS decided the work was, and why — and the decision is
   *    durable in the log the narrative is rendered from. */
  assertNarrativeStatesTheDecision(narrative.out, expectations.selectedWorkflow ?? true);
  assertIntentIsDurable(outcome);

  return { status, narrative };
}

/**
 * No mutating operation was called, from either side of the boundary.
 *
 * Two independent observations, because either alone is weak. The call log says which
 * operations ran and the descriptor registry says which of those are declared mutating; the
 * run log says whether a mutation event was ever journalled. An unlogged mutation would be
 * caught by the first and a mutation through an undeclared operation by the second.
 */
export function assertNoMutatingCall(outcome: WorkOutcome): void {
  const mutating: string[] = [];
  for (const call of outcome.built.framework.calls()) {
    const descriptor = outcome.built.framework.descriptor(call.adapter, call.op);
    if (descriptor === undefined) {
      mutating.push(`${call.adapter}.${call.op} (undeclared operation)`);
      continue;
    }
    if (descriptor.mutating) mutating.push(`${call.adapter}.${call.op}`);
  }
  assert.deepEqual(mutating, [], 'no mutating adapter operation was called');

  const events = outcome.log.filter((event) => event.event === 'mutation');
  assert.deepEqual(events, [], 'no mutation event was journalled, because none happened');
}

/**
 * The narrative says what AgentOS decided the work was and why.
 *
 * v0.3 names a confidently wrong resolution as its residual risk and names the narrative as
 * the mitigation, so this is the assertion that makes the mitigation real: a run that did the
 * wrong thing correctly is invisible without it. The check is on the substance — the decided
 * intent, the admitted type, and a reason — not on the wording.
 */
export function assertNarrativeStatesTheDecision(
  narrative: string,
  selectedWorkflow = true,
): void {
  assert.match(
    narrative,
    /\*\*AgentOS decided this is an? [A-Z_]+\*\*/,
    'the narrative states, in the type it admitted, what AgentOS decided the work was',
  );
  assert.match(
    narrative,
    /the outcome it is pursuing: .+/,
    'the narrative states the outcome the run is bound to, which is what a wrong resolution '
    + 'would be visible in',
  );
  assert.match(
    narrative,
    /## What AgentOS decided the work was, and why/,
    'the account leads with the decision rather than burying it under the transcript',
  );
  if (selectedWorkflow) {
    assert.match(
      narrative,
      /template [\w.]+ version [\d.]+ was admitted from \d+ admissible option\(s\), entering at [A-Z_]+/,
      'the narrative states which workflow it chose, out of how many, and where it entered — '
      + 'which is the shape a wrong resolution shows up in',
    );
    assert.match(
      narrative,
      /the entry stage was computed as [A-Z_]+ by walking the frozen graph against Current Reality/,
      'and that the entry was computed rather than proposed, which is what makes it arguable',
    );
  }
  assert.match(
    narrative,
    /## How completion was judged/,
    'the account ends by saying what it concluded and on what basis',
  );
}

/**
 * The durable one-line record of what AgentOS decided, from the run log.
 *
 * `WorkItem` carries no intent field, so this `note` is the only place the decided intent
 * survives — and it is written to the work-item log as well as the run log, so it outlives the
 * run that made it. A narrative rendered from a log that never recorded the decision would be
 * a narrative nobody could check.
 */
export function assertIntentIsDurable(outcome: WorkOutcome): void {
  const recorded = notes(outcome.log, 'intent');
  assert.ok(recorded.length > 0, 'the decided intent is a durable event');
  assert.match(recorded[0] ?? '', /AgentOS decided this work is [A-Z_]+/);
  assert.match(recorded[0] ?? '', /admitted as type [A-Z_]+/);
  assert.match(
    recorded[0] ?? '',
    /The WorkItem contract carries no intent field, so this event is the durable record/,
  );
}

/**
 * The obligations a scenario that never reached a Work Item can still carry.
 *
 * Three scenarios stop in the prologue — an unreachable ticket, an absent ticket, and a host
 * with no model — and for those "the flow reaches a durable run record" is not available,
 * because no work item was admitted and no run was started. What *is* available is the intake
 * record, the narrative, and the fact that nothing advanced; asserting those instead of
 * quietly dropping the obligation is the honest version.
 */
export async function assertNothingAdvanced(
  world: ScratchWorld,
  outcome: WorkOutcome,
): Promise<void> {
  assertUnchanged(outcome.before, outcome.after, (actual, expected, message) => {
    assert.equal(actual, expected, message);
  });
  assertNoMutatingCall(outcome);
  assert.equal(outcome.result.workItemId, null, 'no work item was admitted');
  assert.equal(outcome.result.runId, null, 'no run was started');
  assert.deepEqual(
    outcome.built.store.listWorkItems(),
    [],
    'the store holds no work item, so nothing advanced and the same invocation resumes here',
  );

  const listing = await cli(world, ['status']);
  assert.equal(listing.code, 0, 'agentos status still reads the state root');
  assert.match(
    listing.out,
    /no work items under/,
    'agentos status reports an empty state root rather than inventing a run',
  );

  /*
   * The narrative is printed on every path, including the ones that stop. It is the only
   * account of what AgentOS made of the request before it stopped — a run that refused
   * silently would be a run nobody could argue with.
   */
  assert.match(
    outcome.result.narrative,
    /## What AgentOS decided the work was, and why/,
    'the refusal still leads with an account of the request',
  );
  assert.match(
    outcome.result.narrative,
    /the request arrived as [A-Z_]+ from .+, trust class [A-Z_]+/,
  );
  assert.match(outcome.result.narrative, /verbatim: ".+"/);
  assert.ok(
    outcome.result.detail.trim().length > 0,
    'and the reason it stopped is stated, in the words of the check that stopped it',
  );
}

/**
 * The completion verdict the run computed, or `null` where `COMPLETION` was never reached.
 *
 * Read from the `dod_computed` event rather than from the outcome, because `INDETERMINATE` and
 * `INCOMPLETE` both end the run `BLOCKED` and only the report says which — and the whole point
 * of the distinction is that "we could not check" is not "we checked and found a gap".
 */
export function completionVerdict(log: readonly Event[]): string | null {
  const computed = eventsOf(log, 'dod_computed');
  const last = computed[computed.length - 1];
  return last === undefined ? null : last.data.verdict;
}

/** Every `note` event whose topic contains `topic`, in order. */
export function notes(log: readonly Event[], topic: string): readonly string[] {
  return log
    .filter((event): event is Extract<Event, { event: 'note' }> => event.event === 'note')
    .filter((event) => event.data.topic.includes(topic))
    .map((event) => event.data.detail);
}

/** Every event of one kind, typed. */
export function eventsOf<K extends Event['event']>(
  log: readonly Event[],
  kind: K,
): readonly Extract<Event, { event: K }>[] {
  return log.filter((event): event is Extract<Event, { event: K }> => event.event === kind);
}

/* --------------------------------------------------------------- pm connectors ---- */

/** The `key` argument of a connector fetch, as a string, or `''` where it is not one. */
function keyOf(args: Readonly<Record<string, unknown>>): string {
  const key = args['key'];
  return typeof key === 'string' ? key : '';
}

/**
 * A project-management system that answers with the recorded issues.
 *
 * `ping` is the availability probe and answers whatever the connector holds, because a
 * connector that refuses its own probe is `UNAVAILABLE` and `identityResolverFor` never gets
 * as far as asking about a key. A key nobody recorded is `ResourceAbsentError`, which is the
 * adapter's word for "the source is reachable and the item is not there".
 */
export function reachablePm(
  issues: Readonly<Record<string, unknown>>,
  children: Readonly<Record<string, readonly unknown[]>> = {},
): Connector {
  return {
    id: 'pm.scripted',
    configured: true,
    fetch: (resource, args) => {
      if (resource === 'ping') return Promise.resolve({ ok: true });
      const key = keyOf(args);
      if (resource === 'children') return Promise.resolve(children[key] ?? []);
      if (resource === 'issues' || resource === 'search') return Promise.resolve(Object.values(issues));
      if (resource === 'documents') return Promise.resolve([]);
      if (resource === 'links') return Promise.resolve([]);
      const issue = issues[key];
      if (issue === undefined) {
        return Promise.reject(new ResourceAbsentError(key, `${key} does not exist in pm.scripted`));
      }
      return Promise.resolve(issue);
    },
  };
}

/** A project-management system that is configured and will not answer at all. */
export function unreachablePm(
  detail = 'the project-management host refused the connection',
): Connector {
  return {
    id: 'pm.scripted',
    configured: true,
    fetch: (_resource, args) => Promise.reject(
      new ResourceUnreachableError(keyOf(args) || '(unknown)', detail),
    ),
  };
}

/**
 * A project-management system that is reachable and holds nothing.
 *
 * The counterpart to `unreachablePm`, and the case scenario 13 exists to keep apart from it:
 * the source answered, the key is wrong, and a human should hear that rather than watch
 * AgentOS wait for a system that is already up.
 */
export function reachableEmptyPm(): Connector {
  return reachablePm({});
}

/** A runtime that answers the recorded observations, for the reality-shaped scenarios. */
export function scriptedRuntime(answers: Readonly<Record<string, unknown>>): Connector {
  return {
    id: 'runtime.scripted',
    configured: true,
    fetch: (resource) => {
      if (resource === 'ping') return Promise.resolve({ ok: true });
      const answer = answers[resource];
      return Promise.resolve(answer === undefined ? [] : answer);
    },
  };
}

/** A runtime that is configured and unreachable: every observation is INDETERMINATE. */
export function unreachableRuntime(): Connector {
  return {
    id: 'runtime.scripted',
    configured: true,
    fetch: (resource) => Promise.reject(
      new ResourceUnreachableError(resource, 'the runtime host refused the connection'),
    ),
  };
}
