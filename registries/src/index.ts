import type {
  ModelEntry,
  ModelRegistry,
  ModelRequirement,
  RankedCandidate,
  Registries,
  SkillEntry,
  SkillRegistry,
} from '@agentos/contracts';
import { rankModels, type ModelRankingOptions } from './models.js';
import { rankSkills, type SkillRequest } from './skills.js';

/**
 * `@agentos/registries` — representation, indexing, query and **ranking**.
 *
 * Registries rank; they do not select. Selection and its recording are the kernel's
 * (KERNEL_BOUNDARY 7), and keeping the two apart is what stops business logic accumulating
 * here: the ranking rules are data-driven scoring, not kernel branches, and the kernel
 * applies policy to an ordered list rather than reimplementing why the list is ordered.
 *
 * The package depends on `@agentos/contracts` and nothing else. It therefore cannot reach a
 * host, and does not try: **the host adapter enumerates, and the registry ranks what it is
 * handed.** That is not a limitation worked around — it is the boundary doing its job, and it
 * is why this package has no I/O exception in the conformance check and needs none.
 */

export class EnumeratedRegistries implements Registries {
  readonly #skills: readonly SkillEntry[];
  readonly #models: readonly ModelEntry[];
  readonly #enumeratedAt: string;

  /**
   * @param skills What the host adapter enumerated, unreachable connectors included. An
   *   unreachable connector is recorded `UNAVAILABLE` and never omitted, and this constructor
   *   is where that promise is kept or broken: it filters nothing.
   */
  constructor(
    skills: readonly SkillEntry[],
    models: readonly ModelEntry[],
    enumeratedAt: string,
  ) {
    this.#skills = [...skills];
    this.#models = [...models];
    this.#enumeratedAt = enumeratedAt;
  }

  skills(): Promise<readonly SkillEntry[]> {
    return Promise.resolve(this.#skills);
  }

  models(): Promise<readonly ModelEntry[]> {
    return Promise.resolve(this.#models);
  }

  /** The registry as a contract value, for persistence with the run. */
  skillRegistry(): SkillRegistry {
    return { entries: this.#skills, enumerated_at: this.#enumeratedAt };
  }

  modelRegistry(): ModelRegistry {
    return { entries: this.#models, enumerated_at: this.#enumeratedAt };
  }

  /** Ordered skill candidates with scores and reasons. The kernel picks from this. */
  rankSkills(request: SkillRequest): readonly RankedCandidate[] {
    return rankSkills(this.#skills, request);
  }

  /** Ordered model candidates: cheapest adequate first, every shortfall named. */
  rankModels(
    requirement: ModelRequirement,
    options: ModelRankingOptions = {},
  ): readonly RankedCandidate[] {
    return rankModels(this.#models, requirement, options);
  }
}

export { rankSkills } from './skills.js';
export type { SkillRequest, SkillDomain, SkillOperation, SkillTarget } from './skills.js';
export { rankModels, shortfalls } from './models.js';
export type { ModelRankingOptions } from './models.js';
export { coverage, order } from './ranking.js';
export type { Scored } from './ranking.js';
