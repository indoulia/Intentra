import type {
  AgentRole,
  AgentSpecView,
  ModelEntry,
  ModelRequirement,
  RankedCandidate,
  SkillEntry,
  SkillOffer,
  StageDescriptor,
  Violation,
} from '@agentos/contracts';
import type { SkillRequest } from '@agentos/registries';

/**
 * Selection and recording.
 *
 * **The registries rank; the kernel selects.** Registries produce an ordered candidate list
 * with scores and reasons — deterministic, testable, model-free. The kernel picks from that
 * list, applies policy, and records the choice. The Orchestrator Agent may express a
 * preference in its proposed dispatch; it is an input to ranking, not a bypass of it.
 *
 * Two policy rules are applied here rather than remembered by an agent:
 *
 * - **A skill with `spawns_agents: true` is never selectable**, and a skill whose spawning
 *   behaviour cannot be determined is treated as spawning. No agent may invoke another agent;
 *   direct invocation is already impossible, and a skill that spawns a subagent is the same
 *   violation wearing a tool's clothing.
 * - **A non-mutating stage may not select a mutating skill.** The risk dimension is not the
 *   agent's to guess: the stage descriptor declares whether the stage mutates, and this is
 *   checked at selection.
 */

export interface SelectionRecord<T> {
  readonly selected: T | null;
  readonly candidates: readonly RankedCandidate[];
  readonly why: string;
  readonly escalatedFrom: string | null;
  readonly escalationTrigger: string | null;
  readonly violations: readonly Violation[];
}

/* ------------------------------------------------- classifying the dispatch ---- */

/** Which skill domains an adapter family covers. */
const ADAPTER_DOMAINS: Readonly<Record<string, readonly SkillRequest['domains'][number][]>> = {
  repo: ['repository_analysis', 'documentation'],
  git: ['git'],
  pm: ['project_management'],
  runtime: ['deployment', 'api'],
  host: [],
};

/** Which targets an adapter family reaches. */
const ADAPTER_TARGETS: Readonly<Record<string, readonly SkillRequest['targets'][number][]>> = {
  repo: ['filesystem'],
  git: ['vcs'],
  pm: ['network'],
  runtime: ['runtime', 'network'],
  host: [],
};

/** Domains a stage is about, over and above what its adapters reach. */
const STAGE_DOMAINS: Readonly<Record<string, readonly SkillRequest['domains'][number][]>> = {
  VALIDATION: ['testing'],
  STRUCTURAL_REAUDIT: ['testing'],
  UX_REVIEW: ['ui'],
  DEPLOY: ['deployment'],
  PRODUCTION_VALIDATION: ['deployment'],
  COMPLETION: ['documentation'],
  PR_PREPARATION: ['git'],
  PR_REVIEW: ['git'],
  REVIEW_TRIAGE: ['git'],
  MERGE: ['git'],
  DECOMPOSITION: ['project_management'],
  CHILD_COORDINATION: ['project_management'],
};

/**
 * Classifies a dispatch for the skill registry to rank against.
 *
 * The document puts task classification on the Orchestrator Agent — domain, operation, target
 * and risk — and then removes the one dimension that matters: "**the risk dimension is not the
 * agent's to guess.** The stage descriptor declares whether the stage mutates." Here the whole
 * classification is derived rather than proposed, which is the same rule applied to the rest of
 * it: an agent that could widen its own operation set to `mutate` would be choosing its own
 * risk class, and the `DispatchProposal` contract carries no classification fields precisely
 * because it is not the agent's to make.
 *
 * The derivation is mechanical: operations from whether the stage mutates, domains and targets
 * from the adapters this role is permitted plus what the stage is about. It is an input to
 * ranking, and ranking never admits a candidate the kernel's policy filters reject.
 */
export function classifyDispatch(
  spec: AgentSpecView,
  descriptor: StageDescriptor,
  preference: readonly string[] = [],
): SkillRequest {
  const domains = new Set<SkillRequest['domains'][number]>();
  const targets = new Set<SkillRequest['targets'][number]>();

  for (const adapter of spec.permitted_adapters) {
    const family = adapter.split('.')[0] ?? adapter;
    for (const domain of ADAPTER_DOMAINS[family] ?? []) domains.add(domain);
    for (const target of ADAPTER_TARGETS[family] ?? []) targets.add(target);
  }
  for (const domain of STAGE_DOMAINS[descriptor.stage] ?? []) domains.add(domain);

  /*
   * A non-mutating stage asks for nothing that generates or mutates. That is the safety
   * criterion made arithmetic rather than remembered: a read-only option outranks a mutating
   * one for a read task because the mutating one does not match the operations asked for, and
   * the kernel's own filter refuses it even if it did.
   */
  const operations: SkillRequest['operations'][number][] = descriptor.mutating
    ? ['read', 'analyse', 'generate', 'mutate', 'verify']
    : ['read', 'analyse', 'verify'];

  return {
    domains: [...domains],
    operations,
    targets: [...targets],
    stageMutating: descriptor.mutating,
    preferred: [...preference],
  };
}

/* --------------------------------------------------------------------- skills ---- */

export interface SkillSelectionInput {
  readonly ranked: readonly RankedCandidate[];
  readonly entries: readonly SkillEntry[];
  readonly stageMutating: boolean;
  readonly agent: AgentRole;
  readonly preference: readonly string[];
}

/**
 * Filters the ranked skill list to what is selectable, and offers the rest to the dispatch.
 *
 * Skills are suggestions to the agent, not obligations — a poor tool used dutifully is worse
 * than no tool — so this produces an *offer* list rather than an assignment.
 */
export function selectSkills(input: SkillSelectionInput): {
  readonly offers: readonly SkillOffer[];
  readonly excluded: readonly RankedCandidate[];
  readonly violations: readonly Violation[];
} {
  const byId = new Map(input.entries.map((e) => [e.id, e]));
  const offers: SkillOffer[] = [];
  const excluded: RankedCandidate[] = [];
  const violations: Violation[] = [];

  for (const candidate of input.ranked) {
    const entry = byId.get(candidate.id);
    if (entry === undefined) {
      excluded.push({ ...candidate, excluded_because: 'no registry entry' });
      continue;
    }

    if (entry.spawns_agents || !entry.spawns_agents_determined) {
      const reason = entry.spawns_agents_determined
        ? 'it can spawn an agent, and no agent may invoke another agent'
        : 'its spawning behaviour could not be determined, and undetermined spawning '
          + 'behaviour is treated as spawning';
      excluded.push({ ...candidate, excluded_because: reason });
      violations.push({
        code: 'SPAWNING_SKILL_SELECTED',
        rule: 'SKILL_AND_MODEL_SELECTION, spawns_agents is a hard exclusion',
        message:
          `${entry.id} was ranked as a candidate and is not selectable: ${reason}. The kernel `
          + 'remains the only thing that starts an agent',
        path: null,
        handled_as: 'REFUSED',
        subject: entry.id,
      });
      continue;
    }

    if (entry.mutating && !input.stageMutating) {
      const reason =
        'it mutates and this stage does not. A non-mutating stage may not select a mutating '
        + 'skill, and the risk dimension is not the agent\'s to guess';
      excluded.push({ ...candidate, excluded_because: reason });
      violations.push({
        code: 'MUTATING_SKILL_FOR_READ_ONLY_STAGE',
        rule: 'SKILL_AND_MODEL_SELECTION, selection rules',
        message: `${entry.id} was ranked as a candidate and is not selectable: ${reason}`,
        path: null,
        handled_as: 'REFUSED',
        subject: entry.id,
      });
      continue;
    }

    if (entry.availability.state !== 'AVAILABLE') {
      /*
       * An unreachable connector is recorded UNAVAILABLE, never omitted. "This host has no
       * Jira access" and "Jira is configured but the server failed to connect" lead to
       * different decisions, and the second is worth reporting to a human.
       */
      excluded.push({
        ...candidate,
        excluded_because: `${entry.availability.state}: ${entry.availability.detail}`,
      });
      continue;
    }

    offers.push({
      id: entry.id,
      source: entry.source,
      description: entry.description,
      mutating: entry.mutating,
    });
  }

  /* A preference reorders the offers and cannot add to them. */
  const preferred = new Set(input.preference);
  offers.sort((a, b) => {
    const aPreferred = preferred.has(a.id) ? 0 : 1;
    const bPreferred = preferred.has(b.id) ? 0 : 1;
    return aPreferred - bPreferred;
  });

  return { offers, excluded, violations };
}

/* --------------------------------------------------------------------- models ---- */

export interface ModelSelectionInput {
  readonly ranked: readonly RankedCandidate[];
  readonly entries: readonly ModelEntry[];
  readonly requirement: ModelRequirement;
  readonly preference: string | null;
  /** Set on a retry, where escalation is permitted once. */
  readonly escalate: boolean;
  readonly previousModel: string | null;
  readonly escalationTrigger: string | null;
}

/*
 * Ranks for the declared capability vocabularies. `unknown` ranks 0 on purpose: where a
 * property is not knowable, selection degrades sensibly rather than assuming the best case,
 * so an unknown capability never satisfies a requirement for one.
 */
const REASONING_RANK: Readonly<Record<string, number | undefined>> = {
  shallow: 1, mid: 2, deep: 3, unknown: 0,
};
const CAPABILITY_RANK: Readonly<Record<string, number | undefined>> = {
  none: 0, basic: 1, strong: 2, unknown: 0,
};
const CONTEXT_RANK: Readonly<Record<string, number | undefined>> = {
  small: 1, medium: 2, large: 3,
};

function rank(table: Readonly<Record<string, number | undefined>>, key: string): number {
  return table[key] ?? 0;
}

/** Does this model meet the declared requirement? Unknown properties do not count as met. */
export function meetsRequirement(
  entry: ModelEntry,
  requirement: ModelRequirement,
): { readonly meets: boolean; readonly shortfalls: readonly string[] } {
  const shortfalls: string[] = [];

  if (entry.availability.state !== 'AVAILABLE') {
    shortfalls.push(`availability is ${entry.availability.state}`);
  }
  if (rank(REASONING_RANK, entry.reasoning) < rank(REASONING_RANK, requirement.reasoning)) {
    shortfalls.push(
      `reasoning is ${entry.reasoning} and ${requirement.reasoning} is required`,
    );
  }
  if (requirement.coding && rank(CAPABILITY_RANK, entry.coding) < 2) {
    shortfalls.push(`coding is ${entry.coding} and strong coding is required`);
  }
  if (requirement.vision && rank(CAPABILITY_RANK, entry.vision) < 1) {
    shortfalls.push(`vision is ${entry.vision} and vision is required`);
  }
  if (rank(CAPABILITY_RANK, entry.tool_use) < rank(CAPABILITY_RANK, requirement.tool_use)) {
    shortfalls.push(`tool use is ${entry.tool_use} and ${requirement.tool_use} is required`);
  }
  if (requirement.precision === 'high' && entry.precision_class !== 'high') {
    /*
     * Where a property is not knowable it is UNKNOWN, and selection degrades sensibly
     * rather than assuming the best case. So an unknown precision class does not meet a
     * high-precision requirement.
     */
    shortfalls.push(
      `precision class is ${entry.precision_class} and high precision is required`,
    );
  }
  const contextNeeded = rank(CONTEXT_RANK, requirement.context);
  if (entry.context_window === null && contextNeeded > 1) {
    shortfalls.push('the context window is UNKNOWN and more than a small context is required');
  }

  return { meets: shortfalls.length === 0, shortfalls };
}

/**
 * Selects a model.
 *
 * **Choose the cheapest model that meets the requirements, then escalate on evidence.** The
 * ranking comes from the registry; the choice and its recording are the kernel's. Escalation
 * is bounded at one per dispatch and is recorded with its trigger.
 *
 * Degradation is explicit: if the preferred model is unavailable, AgentOS may proceed on a
 * lesser one **only** for work whose precision requirement it still meets. Otherwise the run
 * blocks — proceeding on an inadequate model and reporting the result as normal is a form of
 * dishonesty the evidence model exists to prevent.
 */
export function selectModel(input: ModelSelectionInput): SelectionRecord<string> {
  const byId = new Map(input.entries.map((e) => [e.id, e]));
  const candidates: RankedCandidate[] = [];
  const eligible: { entry: ModelEntry; candidate: RankedCandidate }[] = [];

  for (const candidate of input.ranked) {
    const entry = byId.get(candidate.id);
    if (entry === undefined) {
      candidates.push({ ...candidate, excluded_because: 'no registry entry' });
      continue;
    }
    const { meets, shortfalls } = meetsRequirement(entry, input.requirement);
    if (!meets) {
      candidates.push({ ...candidate, excluded_because: shortfalls.join('; ') });
      continue;
    }
    candidates.push(candidate);
    eligible.push({ entry, candidate });
  }

  if (eligible.length === 0) {
    return {
      selected: null,
      candidates,
      why:
        'no reachable model meets the declared requirement. Proceeding on an inadequate model '
        + 'and reporting the result as normal is a form of dishonesty the evidence model is '
        + 'built to prevent, so the dispatch fails and the run blocks',
      escalatedFrom: input.previousModel,
      escalationTrigger: input.escalationTrigger,
      violations: [],
    };
  }

  /* The registry's order is the ranking. A preference reorders within the eligible set. */
  if (input.preference !== null) {
    const index = eligible.findIndex((e) => e.entry.id === input.preference);
    if (index > 0) {
      const [preferred] = eligible.splice(index, 1);
      if (preferred !== undefined) eligible.unshift(preferred);
    }
  }

  if (input.escalate && eligible.length > 1 && input.previousModel !== null) {
    /*
     * Escalate past the model that just failed, to the next eligible one. Bounded at one
     * escalation per dispatch, and recorded with its trigger, so the record shows which tier
     * was actually needed rather than which was guessed.
     */
    const next = eligible.find((e) => e.entry.id !== input.previousModel);
    if (next !== undefined) {
      return {
        selected: next.entry.id,
        candidates,
        why:
          `escalated from ${input.previousModel} to ${next.entry.id}: `
          + next.candidate.reasons.join('; '),
        escalatedFrom: input.previousModel,
        escalationTrigger: input.escalationTrigger,
        violations: [],
      };
    }
  }

  const chosen = eligible[0];
  if (chosen === undefined) throw new Error('unreachable: eligible is non-empty');
  return {
    selected: chosen.entry.id,
    candidates,
    why:
      `the cheapest model meeting the declared requirement: ${chosen.candidate.reasons.join('; ')}`,
    escalatedFrom: null,
    escalationTrigger: null,
    violations: [],
  };
}
