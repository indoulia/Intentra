import type { AdapterAvailability, Classification } from '@agentos/contracts';

/**
 * The access classes a run holds, derived from what the adapters were observed to reach.
 *
 * `KernelPorts.access` decides which Definition of Done profiles a desired outcome may bind
 * to, so it is a statement about capability and a statement the kernel acts on. It is
 * therefore **derived, never assumed**: an adapter family enters the set only when its own
 * availability probe reported `AVAILABLE`, which is a reach somebody demonstrated rather than
 * one somebody configured.
 *
 * The direction the derivation fails in is the opposite of the one classification fails in,
 * and both are conservative for the question they answer. A classification asks "is this
 * dangerous", so an unknown answer takes the dangerous value. Access asks "can this run check
 * something", so an unknown answer takes the *absent* value: a run that quietly claimed reach
 * it does not have would bind its outcome to a profile it cannot evaluate and then report
 * `NOT_VALIDATED` criteria as though the gap were the work's rather than its own.
 *
 * **Unreachable and never-configured stay different all the way through.** Both leave the
 * class out of the set, and both are recorded here with the availability state that produced
 * them, because "this host has no project-management access" and "it is configured and the
 * server refused" lead to different decisions and only the second is worth waking a human
 * for.
 */

export type AccessClass = 'repository' | 'git' | 'project_management' | 'runtime' | 'production';

/**
 * Which adapter family establishes which access class.
 *
 * `host` is deliberately absent. The host adapter is available whenever AgentOS is running —
 * it is the host — so mapping it to an access class would put a member in the set that says
 * nothing about what this run can reach.
 */
export const ACCESS_BY_ADAPTER: Readonly<Record<string, AccessClass>> = Object.freeze({
  repo: 'repository',
  git: 'git',
  pm: 'project_management',
  runtime: 'runtime',
});

/** One environment the runtime described, with what the adapter's classifier made of it. */
export interface EnvironmentClassification {
  readonly environment: string;
  readonly classification: Classification;
}

/** Why one access class is held or not, in the words of the observation that decided it. */
export interface AccessFinding {
  readonly access: AccessClass;
  readonly held: boolean;
  /** The adapter family, or the classification, that decided it. */
  readonly source: string;
  /** `UNPROBED` where no probe for the source exists at all, which is not the same as absent. */
  readonly state: AdapterAvailability['state'] | 'UNPROBED';
  readonly detail: string;
}

export interface AccessDerivation {
  readonly access: ReadonlySet<AccessClass>;
  /** Every class, held or not, with the observation behind it. Held classes are not the story. */
  readonly findings: readonly AccessFinding[];
}

/**
 * Derives the access set from observed adapter availability.
 *
 * @param availability what `AdapterFramework.refreshAvailability()` observed.
 * @param environments the environments a reachable runtime described, each with the adapter's
 *   own `environment` classification. Only a classification that was *established* — that is,
 *   `failed_closed: false` — can put `production` in the set: "we could not tell, so assume
 *   production" is the right answer for whether a gate fires and the wrong one for whether
 *   this run can reach a production system and check something there.
 */
export function deriveAccess(
  availability: readonly AdapterAvailability[],
  environments: readonly EnvironmentClassification[] = [],
): AccessDerivation {
  const byAdapter = new Map(availability.map((entry) => [entry.adapter, entry]));
  const findings: AccessFinding[] = [];
  const held = new Set<AccessClass>();

  for (const [adapter, access] of Object.entries(ACCESS_BY_ADAPTER)) {
    const observed = byAdapter.get(adapter);
    if (observed === undefined) {
      findings.push({
        access,
        held: false,
        source: adapter,
        state: 'UNPROBED',
        detail:
          `no ${adapter} adapter is registered in this build, so nothing has looked for `
          + `${access} access. Unprobed is not the same as absent, and neither is access`,
      });
      continue;
    }
    const isHeld = observed.state === 'AVAILABLE';
    if (isHeld) held.add(access);
    findings.push({
      access,
      held: isHeld,
      source: adapter,
      state: observed.state,
      detail: observed.detail,
    });
  }

  findings.push(productionFinding(held.has('runtime'), byAdapter.get('runtime'), environments));
  const production = findings.find((finding) => finding.access === 'production');
  if (production?.held === true) held.add('production');

  return { access: held, findings };
}

/**
 * Whether this run can reach a production system.
 *
 * Two conditions, and both are observations. The runtime has to be reachable at all, and some
 * environment it described has to have been *classified* production rather than *assumed* to
 * be one. A run whose runtime is reachable and whose topology is undescribed must still treat
 * every reachable runtime as production for the purpose of gates — that rule lives in the
 * adapter's classifier and is untouched here — but it has not thereby demonstrated that it
 * can check anything in production, and access is the second question.
 */
function productionFinding(
  runtimeHeld: boolean,
  runtime: AdapterAvailability | undefined,
  environments: readonly EnvironmentClassification[],
): AccessFinding {
  if (!runtimeHeld) {
    return {
      access: 'production',
      held: false,
      source: 'runtime',
      state: runtime?.state ?? 'UNPROBED',
      detail:
        'the only path to a production system is the runtime adapter, and it is '
        + (runtime === undefined ? 'not registered' : `${runtime.state}: ${runtime.detail}`),
    };
  }

  const observed = environments.filter((entry) => !entry.classification.failed_closed);
  const productions = observed.filter((entry) => entry.classification.value === 'PRODUCTION');
  if (productions.length > 0) {
    return {
      access: 'production',
      held: true,
      source: 'runtime.environment classification',
      state: 'AVAILABLE',
      detail:
        `the runtime is reachable and classified ${productions.map((p) => p.environment).join(', ')} `
        + 'as production from its own topology, so this run can observe a production system',
    };
  }

  return {
    access: 'production',
    held: false,
    source: 'runtime.environment classification',
    state: 'AVAILABLE',
    detail:
      environments.length === 0
        ? 'the runtime is reachable and described no environments, so no environment has been '
          + 'established as production. Gates still treat every reachable runtime as '
          + 'production; being unable to name one is a different fact from being able to '
          + 'check it'
        : `the runtime described ${environments.length} environment(s) and `
          + `${observed.length} were classified without failing closed, none of them as `
          + 'production. An assumed production environment is not access to one',
  };
}
