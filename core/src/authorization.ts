import type {
  AdapterOperationDescriptor,
  AuthorizationGrant,
  AuthorizationRequest,
  Classification,
  DraftAuthorizationRequest,
  Gate,
  GateClassifier,
  GateDefinition,
  GateDenial,
  Stage,
  TrustClass,
  Violation,
} from '@agentos/contracts';
import type { PolicySet } from '@agentos/policies';
import { globToRegExp } from './reconciliation.js';

/**
 * Gates, requests and grants.
 *
 * Three properties hold whatever an agent says or does not say:
 *
 * - **A gate that fires only when an agent volunteers that it is crossing one is not a
 *   gate.** Gates fire from mechanical classifiers evaluated at the adapter, from what the
 *   adapter observes. Agent self-declaration is an *additional* trigger, never the only one:
 *   an agent that says nothing fires the gate anyway if a classifier matches.
 * - **A classifier that cannot evaluate fires the gate.** Unreadable diff, unknown file
 *   type, failed probe — uncertainty takes the safer branch, every time.
 * - **No agent may grant, extend, reinterpret or self-certify a grant.** Agents draft
 *   requests; the kernel records them; a human decides. And the grant is checked by the
 *   adapter at the moment of execution, not by the agent that asked for it.
 *
 * In the read-only MVP this whole file is exercised by fixtures and gates nothing, because
 * nothing mutates. That is deliberate: building mutation first and adding authorization
 * after is how the gate ends up bypassable, so the contract exists, the adapter checks it,
 * and when the first mutating operation is registered it lands in a system that already
 * cannot perform an unlogged or ungated one.
 */

export interface GateFiring {
  readonly gate: Gate;
  readonly target: string;
  readonly trigger: 'classifier' | 'self_declaration' | 'kernel_accounting' | 'kernel_policy';
  readonly classifierId: string | null;
  readonly classification: Classification | null;
  readonly reason: string;
}

export interface ClassifierInput {
  /** The operation about to run, where there is one. */
  readonly descriptor: AdapterOperationDescriptor | null;
  /** Paths the operation would touch. */
  readonly paths: readonly string[];
  /** Content the operation would write, for the content classifiers. */
  readonly content: string | null;
  /** Fail-closed classifications the adapter established. */
  readonly classifications: readonly Classification[];
  /** Paths outside the dispatch's mandate, from the adapter's own scope check. */
  readonly outOfScopePaths: readonly string[];
  /** The Work Item's originating trust class, set by the host from authenticated context. */
  readonly trustClass: TrustClass;
  readonly stage: Stage;
  readonly stageMutating: boolean;
  /** True where this work item has already crossed AUTONOMOUS_INTAKE_EXECUTION once. */
  readonly intakeGateAlreadyFired: boolean;
  /** Sources policy has pre-granted autonomous intake execution for. */
  readonly intakeSource: string;
  /** Anything the agent volunteered, which is an additional trigger and never the only one. */
  readonly selfDeclared: readonly Gate[];
}

/**
 * Evaluates every gate's classifiers against what the adapter observed.
 *
 * Returns every gate that fires, not the first: an operation can be both a credential change
 * and a destructive migration, and a human should see both.
 */
export function classifyGates(
  policies: PolicySet,
  input: ClassifierInput,
): readonly GateFiring[] {
  const firings: GateFiring[] = [];
  const target = describeTarget(input);

  for (const definition of policies.gates.gates) {
    if (definition.gate === 'AUTONOMOUS_INTAKE_EXECUTION') {
      const firing = classifyAutonomousIntake(definition, input, policies, target);
      if (firing !== null) firings.push(firing);
      continue;
    }

    for (const classifier of definition.classifiers) {
      const outcome = evaluateClassifier(classifier, definition.gate, input);
      if (outcome === null) continue;
      firings.push({ ...outcome, target });
      break;
    }
  }

  /* Self-declaration, as an additional trigger. A gate already fired by a classifier is not
   * added twice; a gate only the agent named still fires. */
  for (const gate of input.selfDeclared) {
    if (firings.some((f) => f.gate === gate)) continue;
    firings.push({
      gate,
      target,
      trigger: 'self_declaration',
      classifierId: null,
      classification: null,
      reason:
        'the agent declared it. Self-declaration is an additional trigger, never the only '
        + 'one: the gate does not depend on candour, and it fires here because candour was '
        + 'offered rather than because it was required',
    });
  }

  return firings;
}

function describeTarget(input: ClassifierInput): string {
  if (input.paths.length > 0) return input.paths.join(', ');
  if (input.descriptor !== null) return `${input.descriptor.adapter}.${input.descriptor.op}`;
  return input.stage;
}

function evaluateClassifier(
  classifier: GateClassifier,
  gate: Gate,
  input: ClassifierInput,
): Omit<GateFiring, 'target'> | null {
  switch (classifier.kind) {
    case 'path_pattern': {
      const matched = input.paths.filter(
        (path) => classifier.patterns.some((pattern) => globToRegExp(pattern).test(normalize(path))),
      );
      if (matched.length === 0) return null;
      /* A path-pattern classifier with a descriptor field checks that too — a migration
       * fires DESTRUCTIVE_MIGRATION on its path only when it also has no down step. */
      if (classifier.descriptor_field !== null) {
        const observed = descriptorField(input, classifier.descriptor_field);
        if (observed === undefined) {
          return {
            gate,
            trigger: 'classifier',
            classifierId: classifier.id,
            classification: null,
            reason:
              `${matched.join(', ')} matched, and ${classifier.descriptor_field} could not be `
              + 'established. A classifier that cannot evaluate fires the gate',
          };
        }
        if (observed !== classifier.expected) return null;
      }
      return {
        gate,
        trigger: 'classifier',
        classifierId: classifier.id,
        classification: null,
        reason: `${matched.join(', ')} matched a configured pattern`,
      };
    }

    case 'content_pattern': {
      if (input.content === null) {
        /* An unreadable diff cannot be classified, so the gate fires. */
        if (input.paths.length === 0) return null;
        return {
          gate,
          trigger: 'classifier',
          classifierId: classifier.id,
          classification: null,
          reason:
            'the content could not be read, so the content classifiers could not evaluate. A '
            + 'classifier that cannot evaluate fires the gate',
        };
      }
      const matched = classifier.patterns.filter(
        (pattern) => new RegExp(pattern).test(input.content as string),
      );
      if (matched.length === 0) return null;
      return {
        gate,
        trigger: 'classifier',
        classifierId: classifier.id,
        classification: null,
        reason: `the content matches ${matched.length} configured marker(s)`,
      };
    }

    case 'descriptor_flag': {
      const field = classifier.descriptor_field;
      if (field === null) return null;
      if (input.descriptor === null) return null;
      const observed = descriptorField(input, field);
      if (observed === undefined) {
        return {
          gate,
          trigger: 'classifier',
          classifierId: classifier.id,
          classification: null,
          reason: `${field} is not declared on the descriptor, so it could not be evaluated`,
        };
      }
      if (observed !== classifier.expected) return null;
      return {
        gate,
        trigger: 'classifier',
        classifierId: classifier.id,
        classification: null,
        reason: `the operation declares ${field} = ${JSON.stringify(observed)}`,
      };
    }

    case 'classification_value': {
      const kind = classifier.descriptor_field === 'branch_protection'
        ? 'branch_protection'
        : 'environment';
      const classification = input.classifications.find((c) => c.kind === kind);
      if (classification === undefined) {
        /*
         * No classification at all. Unknown branch protection means protected; unknown
         * environment means production. So the gate fires, and it fires with the absence
         * recorded rather than with a guess.
         */
        if (!input.stageMutating) return null;
        return {
          gate,
          trigger: 'classifier',
          classifierId: classifier.id,
          classification: null,
          reason:
            `no ${kind} classification was established. Unknown branch protection means `
            + 'protected and unknown environment means production, so the gate fires',
        };
      }
      if (classification.value !== classifier.expected) return null;
      return {
        gate,
        trigger: 'classifier',
        classifierId: classifier.id,
        classification,
        reason: classification.failed_closed
          ? `${kind} is ${classification.value} because the probe could not establish it. A `
            + 'run that was conservative because it was blind is distinguishable from one that '
            + 'was conservative because the target really was production, and this records which'
          : `${kind} is ${classification.value}`,
      };
    }

    case 'scope_escape': {
      if (input.outOfScopePaths.length === 0) return null;
      return {
        gate,
        trigger: 'classifier',
        classifierId: classifier.id,
        classification: null,
        reason:
          `${input.outOfScopePaths.join(', ')} fall outside the dispatch's mandate. This fires `
          + 'as a refusal at the adapter first; the gate is how legitimate scope growth is '
          + 'granted rather than smuggled',
      };
    }

    case 'kernel_accounting':
      /* Fired by the budget accounting rather than by an observation, so it is raised by the
       * caller that holds the budget state and not from here. */
      return null;

    case 'trust_class_and_mutating_stage':
      /* Handled separately: it is the one gate with a once-per-work-item rule and a
       * policy pre-grant. */
      return null;

    default:
      return null;
  }
}

function classifyAutonomousIntake(
  definition: GateDefinition,
  input: ClassifierInput,
  policies: PolicySet,
  target: string,
): GateFiring | null {
  /*
   * Fires once per Work Item, at first entry to any mutating stage, when the originating
   * trust class is EXTERNAL. Read-only work is ungated for every class, which is what keeps
   * the useful autonomy intact — and what makes this the narrowest gate in the set.
   */
  if (input.trustClass !== 'EXTERNAL') return null;
  if (!input.stageMutating) return null;
  if (input.intakeGateAlreadyFired) return null;

  if (
    definition.pre_grantable_by_policy
    && policies.intake.pre_granted_autonomous_intake.includes(input.intakeSource)
  ) {
    return null;
  }

  return {
    gate: 'AUTONOMOUS_INTAKE_EXECUTION',
    target,
    trigger: 'kernel_policy',
    classifierId: 'external_intake_entering_mutating_stage',
    classification: null,
    reason:
      `the work item originated from EXTERNAL intake and the run is entering ${input.stage}, `
      + 'which mutates. Every individual action might be autonomous; the question is whether '
      + 'this party gets to start the run at all',
  };
}

function descriptorField(input: ClassifierInput, field: string): unknown {
  if (input.descriptor === null) return undefined;
  const record = input.descriptor as unknown as Record<string, unknown>;
  if (field === 'reversal') return record['reversal'];
  if (field in record) return record[field];
  return undefined;
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/* ----------------------------------------------------------- the request record ---- */

export interface RequestInput {
  readonly requestId: string;
  readonly workItemId: string;
  readonly runId: string;
  readonly stage: Stage;
  readonly requestedBy: AuthorizationRequest['requested_by'];
  readonly requestedAt: string;
  readonly draft: DraftAuthorizationRequest;
  readonly firing: GateFiring | null;
}

/**
 * Records an authorization request.
 *
 * A human cannot authorize what they cannot evaluate, so the draft's every field survives
 * into the record: what will happen, why, the blast radius, the reversibility and whether it
 * has been verified, the evidence *including what was not validated*, the unknowns that bear
 * on the decision, the alternatives including doing nothing, and AgentOS's own
 * recommendation stated plainly.
 *
 * A request that oversells its confidence to get a yes has broken the only mechanism
 * protecting production, and is a more serious defect than the deployment failing.
 */
export function recordRequest(input: RequestInput): AuthorizationRequest {
  return {
    request_id: input.requestId,
    work_item_id: input.workItemId,
    run_id: input.runId,
    stage: input.stage,
    requested_by: input.requestedBy,
    requested_at: input.requestedAt,
    draft: input.draft,
    classification: input.firing?.classification ?? null,
    trigger: input.firing?.trigger ?? 'self_declaration',
    state: 'PENDING',
  };
}

export type GrantCheck =
  | { readonly ok: true; readonly grant: AuthorizationGrant }
  | { readonly ok: false; readonly violation: Violation };

/**
 * Checks a grant at the moment of execution.
 *
 * One gate, one target, one run. No blanket grants, no standing approvals. Time-bounded,
 * because an expired grant is not a grant — the situation it was granted against may have
 * changed. Non-transferable, and revocable at any time before the action executes.
 *
 * The requesting agent is never the checking component, which is why this is called from the
 * adapter and not from whatever asked for the grant. An agent holding a valid-looking grant
 * object still cannot act without the adapter agreeing.
 */
export function checkGrant(
  grants: readonly AuthorizationGrant[],
  gate: Gate,
  target: string,
  runId: string,
  now: Date,
): GrantCheck {
  const matching = grants.filter(
    (grant) => grant.gate === gate && grant.run_id === runId && grant.target === target,
  );

  if (matching.length === 0) {
    const wrongTarget = grants.filter((g) => g.gate === gate && g.run_id === runId);
    return {
      ok: false,
      violation: {
        code: wrongTarget.length > 0 ? 'GRANT_MISMATCHED' : 'GRANT_MISSING',
        rule: 'HUMAN_AUTHORIZATION section 3',
        message: wrongTarget.length > 0
          ? `a grant exists for ${gate} on ${wrongTarget.map((g) => g.target).join(', ')} and `
            + `not on ${target}. A grant is non-transferable: not to another action, target, `
            + 'run or agent'
          : `no grant for ${gate} on ${target} in run ${runId}`,
        path: null,
        handled_as: 'REFUSED',
        subject: target,
      },
    };
  }

  for (const grant of matching) {
    if (grant.revoked_at !== null) continue;
    if (Date.parse(grant.expires_at) <= now.getTime()) continue;
    return { ok: true, grant };
  }

  const expired = matching.filter(
    (g) => g.revoked_at === null && Date.parse(g.expires_at) <= now.getTime(),
  );
  const revoked = matching.filter((g) => g.revoked_at !== null);

  return {
    ok: false,
    violation: {
      code: 'GRANT_EXPIRED',
      rule: 'HUMAN_AUTHORIZATION section 3',
      message: revoked.length > 0
        ? `the grant for ${gate} on ${target} was revoked at `
          + String(revoked[0]?.revoked_at)
        : `the grant for ${gate} on ${target} expired at ${String(expired[0]?.expires_at)}. An `
          + 'expired grant is not a grant: the situation it was granted against may have changed',
      path: null,
      handled_as: 'REFUSED',
      subject: target,
    },
  };
}

/**
 * Has this gate already been denied for this work item?
 *
 * Denial moves the run to `BLOCKED` with the denial recorded, and AgentOS does not re-request
 * the same gate without new information — **nor in a later run against the same Work Item**.
 * Denials are recorded at the work item level precisely so that starting a fresh Workflow Run
 * is not a way to ask again. A denial is cleared by new information or by a human revisiting
 * it, never by a retry.
 */
export function previouslyDenied(
  denials: readonly GateDenial[],
  gate: Gate,
  target: string,
): GateDenial | null {
  return denials.find((d) => d.gate === gate && d.target === target) ?? null;
}
