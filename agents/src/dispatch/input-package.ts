import type {
  AgentSpecView,
  AuthorizationScope,
  ContextPackage,
  ContextSectionName,
  DispatchBudget,
  InputPackage,
  Mandate,
  SkillOffer,
  Stage,
  ToolGrant,
} from '@agentos/contracts';

/**
 * Building the typed input an agent receives.
 *
 * The whole point of the shape is that it is a *typed input, never a conversation*. Three
 * properties are enforced here rather than trusted:
 *
 * - **Only the `required_inputs` sections are materialized.** CONTEXT_MODEL's rule for
 *   bounding context growth is that the package grows and the dispatch does not, and the
 *   mechanism is that the agent declares which sections it needs and the kernel builds only
 *   those. A section the specification did not ask for is **absent**, not present and empty:
 *   an empty section reads as "discovery found nothing there", which is exactly the
 *   confusion the `gaps` section exists to prevent.
 * - **References, never copies.** `work_item_ref`, `context_package_ref`,
 *   `capability_registry_ref` and `prior_envelopes` are identifiers. There is one
 *   authoritative statement of what is being attempted and every agent reads the same one.
 * - **`required_outputs` and `dod_criteria_owed` come from the dispatch, not from the
 *   agent.** An agent that inferred what it owed would be grading its own paper.
 */
export interface DispatchRequest {
  readonly work_item_id: string;
  readonly run_id: string;
  readonly dispatch_id: string;
  /** The assembled specification for the role and mandate being dispatched. */
  readonly spec: AgentSpecView;
  readonly stage: Stage;
  /** `null` for the resolution mandate, which runs before a Work Item exists. */
  readonly work_item_ref: string | null;
  /** Populated for exactly that case. */
  readonly intake_ref: string | null;
  readonly workflow: InputPackage['workflow'];
  readonly context_package_ref: string | null;
  /** The package to materialize sections from. `null` before any discovery has run. */
  readonly context: ContextPackage | null;
  readonly capability_registry_ref: string | null;
  readonly prior_envelopes: readonly string[];
  readonly mandate: Mandate;
  readonly dod_profile_ref: string | null;
  readonly constraints: readonly string[];
  readonly authorization_scope: AuthorizationScope;
  readonly tools_granted: readonly ToolGrant[];
  readonly skills_available: readonly SkillOffer[];
  readonly model: string;
  readonly budget: DispatchBudget;
  /**
   * The stage's required outputs, where the stage declares them. Omitted, the mandate's own
   * are used: the prologue stages have no descriptor, so a resolution or discovery dispatch
   * has nothing else to be checked against.
   */
  readonly required_outputs?: readonly string[];
}

/**
 * Materializes exactly the named sections, and nothing else.
 *
 * A section named but absent from the package is omitted rather than filled with `null` or
 * `{}`. Discovery records what it could not reach in `gaps`, which is a first-class section
 * carrying a reason; a fabricated empty section would be a second, quieter answer to the
 * same question, and it would be the optimistic one.
 */
export function materializeSections(
  context: ContextPackage | null,
  required: readonly ContextSectionName[],
): Readonly<Record<string, unknown>> {
  const sections: Record<string, unknown> = {};
  if (context === null) return Object.freeze(sections);
  const source = context as unknown as Record<string, unknown>;
  for (const name of required) {
    const value = source[name];
    if (value === undefined) continue;
    sections[name] = value;
  }
  return Object.freeze(sections);
}

/** Which of the requested sections the package could not supply. */
export function unmaterializedSections(
  context: ContextPackage | null,
  required: readonly ContextSectionName[],
): readonly ContextSectionName[] {
  if (context === null) return [...required];
  const source = context as unknown as Record<string, unknown>;
  return required.filter((name) => source[name] === undefined);
}

export function buildInputPackage(request: DispatchRequest): InputPackage {
  const { spec } = request;
  return {
    work_item_id: request.work_item_id,
    run_id: request.run_id,
    dispatch_id: request.dispatch_id,
    agent: spec.role,
    mandate_name: spec.mandate_name,
    stage: request.stage,
    work_item_ref: request.work_item_ref,
    intake_ref: request.intake_ref,
    workflow: request.workflow,
    context_package_ref: request.context_package_ref,
    context_sections: materializeSections(request.context, spec.required_inputs),
    capability_registry_ref: request.capability_registry_ref,
    prior_envelopes: request.prior_envelopes,
    mandate: request.mandate,
    required_inputs: spec.required_inputs,
    required_outputs: request.required_outputs ?? spec.required_outputs,
    dod_profile_ref: request.dod_profile_ref,
    dod_criteria_owed: spec.dod_criteria_owned,
    constraints: request.constraints,
    authorization_scope: request.authorization_scope,
    tools_granted: request.tools_granted,
    skills_available: request.skills_available,
    model: request.model,
    budget: request.budget,
  };
}
