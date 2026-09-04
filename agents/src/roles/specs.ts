import type { AgentRole, ContextSectionName } from '@agentos/contracts';

/**
 * The MVP role specifications — specifications, and deliberately not prompts.
 *
 * A prompt is an instruction to one model. A specification is what the role owns, what it
 * must be given, and what it owes back, and it survives the model that happens to execute
 * it. The kernel reads the specification to build an input package; the substrate is the
 * only thing that ever turns one into text, and it does so in one place so that swapping
 * substrates is the one-file change ARCHITECTURE_FREEZE D-2 requires.
 *
 * Three roles ship in milestone 1, because a read-only AgentOS needs exactly three:
 * Context Discovery with both of its mandates, the Auditor's first pass, and the
 * Orchestrator Agent. The other five roles exist in AGENT_ROLES and in the policy data; they
 * are not specified here because milestone 1 dispatches none of them, and a specification
 * written for a dispatch nobody makes is a specification nobody has checked.
 *
 * Two fields are *not* here on purpose:
 *
 * - **`permitted_adapters` and `read_only`** are read from `policies/data/agents.json` by
 *   the catalog rather than restated, because a second copy of a policy value is a second
 *   thing to keep in step and the copy always loses.
 * - **A model id.** SKILL_AND_MODEL_SELECTION opens with "discovered and ranked at runtime,
 *   never hard-coded": each role declares what it *needs*, the registries rank what exists
 *   against that, and the kernel selects and records. IMPLEMENTATION_PLAN WP-5 names
 *   `claude-opus-5` for resolution and audit; that is the expected outcome of ranking these
 *   requirements on a host where it is reachable, not a constant this package may assert.
 */
export interface RoleSpec {
  readonly role: AgentRole;
  readonly mandate_name: string;
  readonly version: string;
  readonly objective: string;
  readonly required_inputs: readonly ContextSectionName[];
  readonly required_outputs: readonly string[];
  readonly hard_limits: readonly string[];
  readonly must_declare: readonly string[];
  readonly model_requirement: {
    readonly context: 'small' | 'medium' | 'large';
    readonly reasoning: 'shallow' | 'mid' | 'deep';
    readonly coding: boolean;
    readonly vision: boolean;
    readonly tool_use: 'none' | 'basic' | 'strong';
    readonly precision: 'standard' | 'high';
  };
}

/**
 * Context Discovery, `resolution` mandate.
 *
 * Runs before any workflow exists, against tier-1 orientation discovery only, and turns an
 * `IntakeRecord` into a proposed Work Item (INTENT_AND_WORK_ITEM_RESOLUTION 3.1 and 3.2).
 *
 * Its model requirement is the one place in the MVP where `precision: 'high'` is bought at
 * merely `medium` context and `mid` reasoning, and SKILL_AND_MODEL_SELECTION says why: every
 * later decision inherits this reading of the work, and a wrong type or a wrong scope is the
 * one error the downstream checks cannot catch, because they all validate against it. It is
 * the highest precision-per-token dispatch in the system.
 */
const RESOLUTION: RoleSpec = {
  role: 'context-discovery',
  mandate_name: 'resolution',
  version: '1.0',
  objective:
    'Given an IntakeRecord and tier-1 orientation discovery, produce a proposed Work Item: '
    + 'intent, type, external identity, title, desired outcome, scope, constraints, '
    + 'dependencies, parent, and every alternative reading you considered. Every field is an '
    + 'assertion carrying its own confidence class, evidence or derivation, observed_at, '
    + 'probe and freshness — the type included. Report what the sources say. Whether what '
    + 'they say amounts to completion is a Definition-of-Done question decided elsewhere.',
  required_inputs: ['repository', 'git_state', 'intent', 'agent_capabilities', 'gaps'],
  required_outputs: ['proposed_work_item', 'discovery_gaps'],
  hard_limits: [
    'Never mutate anything: not a file, not a branch, not a ticket, not a row.',
    'Never fill a gap with a plausible value. An unreachable source yields UNAVAILABLE, '
    + 'never an assumed answer.',
    'Do not propose a workflow, do not propose a stage, and do not state that the work is '
    + 'already complete.',
    'Do not judge quality or propose fixes. Report what is, not what is wrong.',
    'Never copy a secret into an assertion. Credentials are referenced, never captured.',
  ],
  must_declare: [
    'Every unreachable source and every permission denial.',
    'Every place where intent, code and runtime disagree.',
    'Your own coverage: what fraction of the relevant system you actually inspected.',
    'Every alternative reading you considered and why you rejected each, with what AgentOS '
    + 'would do under each — that list is what a question to a human is built from.',
  ],
  model_requirement: {
    context: 'medium',
    reasoning: 'mid',
    coding: false,
    vision: false,
    tool_use: 'strong',
    precision: 'high',
  },
};

/**
 * Context Discovery, `context` mandate — the ordinary Context Package build.
 *
 * Runs after admission, scoped by the admitted Work Item, and additionally produces
 * `current_reality`. It reads broadly, so it asks for a large context window; it is
 * extraction and structuring rather than adversarial reasoning, so it asks for `mid` depth
 * and standard precision.
 */
const CONTEXT: RoleSpec = {
  role: 'context-discovery',
  mandate_name: 'context',
  version: '1.0',
  objective:
    'Build the Context Package for the admitted Work Item. Run probes, classify every '
    + 'assertion FACT, INFERENCE or UNKNOWN, perform the three-way reconciliation of project '
    + 'intent against code against runtime, and produce current_reality for this work item. '
    + 'Record what you could not discover and why as a first-class result, not as a footnote.',
  required_inputs: [
    'meta',
    'repository',
    'product',
    'architecture',
    'git_state',
    'intent',
    'runtime_state',
    'reconciliation',
    'current_reality',
    'gaps',
  ],
  required_outputs: [
    'context_package',
    'reconciliation_matrix',
    'current_reality',
    'discovery_gaps',
  ],
  hard_limits: [
    'Never mutate anything: not a file, not a branch, not a ticket, not a row.',
    'Never fill a gap with a plausible value. An unreachable database yields UNAVAILABLE, '
    + 'never an assumed schema.',
    'Do not judge quality or propose fixes. Report what is, not what is wrong.',
    'Do not derive any part of current_reality from the intake text, from a ticket status '
    + 'field, or from an account of a previous run. Only a probe writes it.',
    'Never copy a secret into the package. Credentials are referenced, never captured.',
  ],
  must_declare: [
    'Every unreachable source and every permission denial.',
    'Every place where intent, code and runtime disagree.',
    'Your own coverage: what fraction of the relevant system you actually inspected.',
  ],
  model_requirement: {
    context: 'large',
    reasoning: 'mid',
    coding: false,
    vision: false,
    tool_use: 'strong',
    precision: 'standard',
  },
};

/**
 * The Auditor's first pass.
 *
 * `required_outputs` and `dod_criteria_owned` are not invented here: they are the AUDIT
 * stage descriptor's, and the catalog checks that they still agree with
 * `policies/data/stages.json` and `policies/data/dod/criteria.json` when it is built. A role
 * specification that drifted from the stage it is dispatched into would produce an envelope
 * the kernel refuses for an output it never asked for.
 *
 * SKILL_AND_MODEL_SELECTION puts the Auditor at "high — this is adversarial reasoning about
 * a system that looks fine", which is `deep` reasoning at `high` precision: the whole value
 * of the pass is finding what a plausible reading misses.
 */
const AUDIT: RoleSpec = {
  role: 'auditor',
  mandate_name: 'audit',
  version: '1.0',
  objective:
    'Find where the system lies. Build the capability graph over the work item scope, trace '
    + 'each capability end to end, and identify breaks, orphans and unsupported completeness '
    + 'claims. Hunt the standing search list actively rather than waiting to stumble on it: '
    + 'orphan writers and readers, orphan stores, APIs that return only defaults, UI a '
    + 'backend cannot supply, backend capability with no consumer, dead calculations, fields '
    + 'dropped in normalization, fabricated defaults, duplicated sources of truth, missing '
    + 'provenance, missing timestamps, incorrect empty states, stale documentation, tests '
    + 'that assert on mocks rather than on capability, and features marked complete with no '
    + 'production evidence.',
  required_inputs: [
    'repository',
    'architecture',
    'domain_model',
    'source_map',
    'data_map',
    'api_map',
    'ui_map',
    'tests',
    'capabilities',
    'reconciliation',
    'runtime_state',
    'gaps',
  ],
  required_outputs: ['capability_graph', 'findings_report', 'orphan_inventory'],
  hard_limits: [
    'Never mutate anything. Findings only.',
    'Do not propose architecture. You may state that a break exists and where; the shape of '
    + 'the remedy belongs to the Architect.',
    'Do not report a finding without evidence. An unproven suspicion is a recommendation of '
    + 'category hypothesis carrying the observation that would confirm it, and it is never '
    + 'counted as a finding.',
    'Do not assess implementation correctness. That is the Validator mandate, and keeping '
    + 'the two apart is what stops one agent grading its own reasoning.',
  ],
  must_declare: [
    'Your coverage, as scope examined and scope not examined.',
    'Every capability you could not trace.',
    'Every finding whose confirmation requires runtime or production access you did not have.',
  ],
  model_requirement: {
    context: 'large',
    reasoning: 'deep',
    coding: false,
    vision: false,
    tool_use: 'strong',
    precision: 'high',
  },
};

/**
 * The Orchestrator Agent — not the kernel.
 *
 * `permitted_adapters` is empty, and that emptiness is the specification rather than an
 * omission: the component that judges evidence must not also manufacture it. The catalog
 * reads it from policy, and the grant builder therefore produces no tool for this role at
 * all — its effective tool surface is the empty set, and the conformance check asserts that
 * as strictly as it asserts any other surface.
 *
 * Its choices are three, and `orchestratorChoices` derives them from the policy set rather
 * than restating them, so that they stay three exactly as long as the milestone stays
 * read-only. Everything else it might want to say is a proposal the kernel admits, adjusts
 * or refuses. It proposes; it never decides.
 */
const ORCHESTRATION: RoleSpec = {
  role: 'orchestrator',
  mandate_name: 'orchestration',
  version: '1.0',
  objective:
    'Supply the judgment the kernel cannot, at one decision point, and nothing else. In this '
    + 'milestone exactly three choices are yours to propose: which admissible workflow '
    + 'template fits this work item and its observed reality, what the next dispatch should '
    + 'be told to do, and how a surviving disagreement should be resolved. Each is a '
    + 'proposal. The kernel admits it, adjusts it or refuses it, and logs any override. You '
    + 'hold no adapters, so state the reasoning over the evidence you were given rather than '
    + 'the evidence you would like to have.',
  required_inputs: ['current_reality', 'reconciliation', 'constraints', 'gaps'],
  required_outputs: ['rationale'],
  hard_limits: [
    'Do not write code, design architecture, or produce findings of your own.',
    'Do not author a workflow. Select among policy-defined templates and include or exclude '
    + 'only the stages a template marks optional. You cannot add a stage, and an exclusion '
    + 'carries a claim the kernel evaluates for itself.',
    'Do not decide where a run resumes. The entry stage is computed by the kernel from '
    + 'observed reality.',
    'Do not decide that a review comment is separate work, and do not decide that a work '
    + 'item is unnecessary.',
    'Do not overrule a Validator failure by reasoning. Only new evidence clears a failure.',
    'Do not grant authorization, transition state, write to the run store, or invoke another '
    + 'agent. You have no mechanism to do any of these.',
  ],
  must_declare: [
    'Unresolvable disagreement.',
    'Exhausted rework or review budget.',
    'A capability the work item requires and this installation does not have.',
    'Ambiguity that changes the deliverable, including where two candidate templates diverge '
    + 'and the divergence matters.',
  ],
  model_requirement: {
    context: 'medium',
    reasoning: 'mid',
    coding: false,
    vision: false,
    tool_use: 'none',
    precision: 'standard',
  },
};

/** The three MVP roles, four mandates. Order is the order they are dispatched in. */
export const MVP_ROLE_SPECS: readonly RoleSpec[] = Object.freeze([
  RESOLUTION,
  CONTEXT,
  AUDIT,
  ORCHESTRATION,
]);

/** Every proposal key the handoff contract defines, in the order `Proposals` declares them. */
export const PROPOSAL_KEYS = Object.freeze([
  'work_item',
  'workflow',
  'decomposition',
  'triage',
  'cancellation',
  'dispatch',
  'arbitration',
  'authorization_request',
] as const);

export type ProposalKey = (typeof PROPOSAL_KEYS)[number];
