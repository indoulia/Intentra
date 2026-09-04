import type { RankedCandidate, SkillEntry } from '@agentos/contracts';
import { coverage, order, type Scored } from './ranking.js';

/**
 * Skill ranking.
 *
 * SKILL_AND_MODEL_SELECTION names five criteria, in this order of importance: capability
 * match, specificity, cost, reliability, safety. The weights below are that order made
 * arithmetic, and each one is here rather than in the kernel precisely so that changing how
 * tools are chosen is a change to a scoring table rather than a change to a branch in the run
 * loop.
 *
 * **Exclusions are recorded, never omitted.** Three of them:
 *
 * - A skill that can spawn an agent — *including one whose spawning behaviour could not be
 *   determined*, which is treated as spawning. No agent may invoke another agent, and a skill
 *   that spawns a subagent is that violation wearing a tool's clothing.
 * - A mutating skill for a non-mutating task. The risk dimension is not the agent's to guess:
 *   the stage descriptor declares whether the stage mutates.
 * - A skill that cannot do the required operation on the required target at all.
 *
 * An unreachable connector is **not** an exclusion from the list. It is recorded
 * `UNAVAILABLE` and stays in it, because "this host has no project-management access" and "it
 * is configured and the server failed to connect" lead to different decisions and only the
 * second is worth waking someone for.
 *
 * No product name appears here or anywhere in this package. AgentOS ranks what the host
 * enumerated; it has never been told what to expect to find.
 */

export type SkillDomain = SkillEntry['domains'][number];
export type SkillOperation = SkillEntry['operations'][number];
export type SkillTarget = SkillEntry['targets'][number];

export interface SkillRequest {
  /** The domains the task is in. An empty list means the task does not constrain domain. */
  readonly domains: readonly SkillDomain[];
  readonly operations: readonly SkillOperation[];
  readonly targets: readonly SkillTarget[];
  /**
   * Whether the stage this is for mutates. Declared by the stage descriptor, checked here,
   * and never inferred from what the task sounds like.
   */
  readonly stageMutating: boolean;
  /**
   * What the Orchestrator Agent asked for. An input to ranking and not a bypass of it: a
   * preferred skill that is excluded stays excluded, and a preferred skill that is eligible
   * moves up.
   */
  readonly preferred?: readonly string[];
}

/*
 * The weights. Ordered as the document orders the criteria, and spaced so that no amount of
 * one criterion outranks the one above it: a perfectly cheap, perfectly reliable general tool
 * never beats a purpose-built one that actually does the required operation.
 */
const CAPABILITY_WEIGHT = 100;
const SPECIFICITY_WEIGHT = 25;
const COST_WEIGHT = 10;
const RELIABILITY_WEIGHT = 6;
const SAFETY_WEIGHT = 3;

const COST_SCORE: Readonly<Record<SkillEntry['cost_hint'], number>> = {
  low: 1,
  medium: 0.5,
  high: 0.1,
  /* Unknown cost scores as the expensive case: selection degrades sensibly rather than
   * assuming the best case, here as everywhere. */
  unknown: 0.1,
};

/**
 * How specific a skill is to the task.
 *
 * A purpose-built skill beats a general tool, and the mechanical reading of "purpose-built"
 * is "declares fewer things it does, all of which are wanted". A tool that claims every
 * domain claims none of them in particular.
 */
function specificity(entry: SkillEntry, request: SkillRequest): number {
  const declared = entry.domains.length + entry.operations.length + entry.targets.length;
  if (declared === 0) return 0;
  const wanted = request.domains.length + request.operations.length + request.targets.length;
  if (wanted === 0) return 0;
  const overlap =
    entry.domains.filter((d) => request.domains.includes(d)).length
    + entry.operations.filter((o) => request.operations.includes(o)).length
    + entry.targets.filter((t) => request.targets.includes(t)).length;
  return overlap / declared;
}

/** A repository-provided skill knows its own repository's conventions. */
function repositoryBonus(entry: SkillEntry): number {
  return entry.source === 'repository' ? 1 : 0;
}

export function rankSkills(
  entries: readonly SkillEntry[],
  request: SkillRequest,
): readonly RankedCandidate[] {
  const preferred = new Set(request.preferred ?? []);
  const scored: Scored[] = entries.map((entry) => {
    const reasons: string[] = [];

    const domainMatch = coverage(request.domains, entry.domains);
    const operationMatch = coverage(request.operations, entry.operations);
    const targetMatch = coverage(request.targets, entry.targets);
    const capability = (domainMatch + operationMatch + targetMatch) / 3;

    reasons.push(
      `capability match ${percent(capability)} (domain ${percent(domainMatch)}, operation `
      + `${percent(operationMatch)}, target ${percent(targetMatch)})`,
    );

    const specific = specificity(entry, request);
    if (specific > 0) reasons.push(`specificity ${percent(specific)} of what it declares is wanted`);
    if (repositoryBonus(entry) > 0) {
      reasons.push('provided by the repository, which knows its own conventions');
    }

    const cost = COST_SCORE[entry.cost_hint];
    reasons.push(
      entry.cost_hint === 'unknown'
        ? 'cost is unknown, which scores as the expensive case rather than the cheap one'
        : `cost hint ${entry.cost_hint}`,
    );

    const reliability = entry.observed_success_rate;
    reasons.push(
      reliability === null
        ? 'no observed success rate yet, which scores neutral rather than good'
        : `observed success rate ${percent(reliability)}`,
    );

    /* Safety: a read-only option always outranks a mutating one for a read task. */
    const safety = (entry.mutating ? 0 : 0.5)
      + (entry.external_destination ? 0 : 0.3)
      + (entry.reversal !== null ? 0.2 : 0);
    reasons.push(
      `least privilege ${percent(safety)}: mutating=${String(entry.mutating)}, external=`
      + `${String(entry.external_destination)}, reversal=${entry.reversal ?? 'none'}`,
    );

    let score = capability * CAPABILITY_WEIGHT
      + (specific + repositoryBonus(entry)) * SPECIFICITY_WEIGHT
      + cost * COST_WEIGHT
      + (reliability ?? 0.5) * RELIABILITY_WEIGHT
      + safety * SAFETY_WEIGHT;

    if (preferred.has(entry.id)) {
      /*
       * The Orchestrator's preference is worth less than a capability difference and more
       * than a cost one. It reorders among things that fit; it never promotes something that
       * does not.
       */
      score += SPECIFICITY_WEIGHT;
      reasons.push('preferred by the proposing agent, which reorders and does not admit');
    }

    return {
      id: entry.id,
      score,
      reasons,
      excludedBecause: exclusion(entry, request, operationMatch, targetMatch),
    };
  });

  return order(scored);
}

/**
 * Why a candidate may not be selected, or `null`.
 *
 * Order matters only for which reason is reported, and the hardest rule is reported first:
 * an agent-spawning skill is excluded whatever else is true of it.
 */
function exclusion(
  entry: SkillEntry,
  request: SkillRequest,
  operationMatch: number,
  targetMatch: number,
): string | null {
  if (entry.spawns_agents || !entry.spawns_agents_determined) {
    return entry.spawns_agents_determined
      ? 'it can start another agent, session, subagent or task, and no agent may invoke '
        + 'another agent'
      : 'its spawning behaviour could not be determined, and undetermined spawning behaviour '
        + 'is treated as spawning. Uncertainty takes the safer branch';
  }
  if (entry.mutating && !request.stageMutating) {
    return 'it mutates and this task does not. Never invoke a mutating skill for a read-only '
      + 'task, and the risk dimension is the stage descriptor\'s to declare rather than the '
      + 'agent\'s to guess';
  }
  if (entry.availability.state !== 'AVAILABLE') {
    return `${entry.availability.state}: ${entry.availability.detail}. Recorded rather than `
      + 'omitted: an unreachable connector and an absent one lead to different decisions';
  }
  if (request.operations.length > 0 && operationMatch === 0) {
    return `it performs none of the required operations (${request.operations.join(', ')})`;
  }
  if (request.targets.length > 0 && targetMatch === 0) {
    return `it acts on none of the required targets (${request.targets.join(', ')})`;
  }
  return null;
}

function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}
