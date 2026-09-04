import type { Assertion, Classification, Evidence } from '@agentos/contracts';
import { ADAPTERS, OPS } from '../ops.js';
import type { SectionProbe } from '../probe.js';
import { asArray, asNumber, asRecord, asString, records } from '../probe.js';

/**
 * The runtime probe set.
 *
 * "Runtime is the closest thing to truth. Where it disagrees with code or intent, runtime is
 * the finding" ([CONTEXT_MODEL.md](../../../docs/CONTEXT_MODEL.md) section 3). These probes
 * are also the ones most often unavailable, and the degradation is stated rather than papered
 * over: with no runtime access every capability caps at `PARTIAL` and never reaches `PROVEN`,
 * and the package says so instead of quietly reporting a shorter list.
 *
 * Everything here is read-only. Nothing in this package writes to a running system, in any
 * environment, under any grant — discovery observes, and a probe that mutated would make the
 * package's own evidence unreliable.
 */

const RUNTIME = ADAPTERS.runtime;

/**
 * How many environments to classify individually.
 *
 * A bound rather than a policy threshold: classification is one adapter call each, and a
 * topology with hundreds of environments is a case where listing them is the useful answer and
 * classifying every one is not. The ones past the bound are recorded as unclassified, which
 * fails closed to production like every other unclassified environment.
 */
const CLASSIFY_LIMIT = 24;

/**
 * Environment topology, classified fail-closed.
 *
 * Three sources feed one answer, and each keeps its own strength. What the repository declares
 * is an `INFERENCE` — infrastructure definitions describe an intended topology. What the
 * runtime reports is a `FACT`. What could not be classified is **production**, because
 * "we could not determine whether this was production" is not a licence to write to it
 * ([REPOSITORY_ADAPTER.md](../../../docs/REPOSITORY_ADAPTER.md) section 2.2).
 */
export const environmentsProbe: SectionProbe = {
  name: 'runtime.environments',
  section: 'runtime_state',
  tier: 2,
  freshnessClass: 'runtime',
  async run(session, input) {
    const availability = session.adapterState(RUNTIME);
    const access = session.derived(
      'runtime.environments',
      availability,
      ['adapter.availability'],
      'the runtime adapter reports its own availability. With no runtime access capability '
      + 'validation caps at integration level: every capability is at most PARTIAL and never '
      + 'PROVEN, and that is a stated limitation rather than a shorter list of findings',
      'runtime',
      session.nowIso(),
    );

    const declared = input.ledger.value('architecture', 'declared_environments');
    const declaredNames = (asArray(declared) ?? [])
      .map((entry) => asString(entry))
      .filter((entry): entry is string => entry !== null);

    const observation = await session.observe({
      probe: 'runtime.environments',
      adapter: RUNTIME,
      op: OPS.runtime.listEnvironments,
      args: {},
      kind: 'http',
      ref: `${RUNTIME}.${OPS.runtime.listEnvironments}`,
    });

    if (observation.outcome !== 'OBSERVED') {
      const assertions: Record<string, Assertion> = {
        runtime_access: access,
        environments: session.noAccess(
          'runtime.environments', 'the environment topology', observation,
        ),
      };
      if (declaredNames.length > 0) {
        assertions['declared_environments'] = session.derived(
          'runtime.environments',
          declaredNames.map((name) => ({ name, classification: 'UNKNOWN', source: 'repository' })),
          ['architecture.declared_environments'],
          'the repository declares these environments and none of them was observed running. '
          + 'A declared environment is an intention, and it is kept separate from the '
          + 'observed topology so that nothing reads it as one',
          'repository',
          observation.observedAt,
        );
      }
      return {
        assertions,
        available: false,
        detail: 'the environment topology could not be observed',
        intendedScope: [],
      };
    }

    const observed = records(observation.value);
    const evidence: Evidence[] = [observation.evidence];
    const entries: Array<{
      readonly name: string;
      readonly classification: string;
      readonly failed_closed: boolean;
      readonly source: string;
      readonly classification_confidence: string;
    }> = [];

    for (const [index, environment] of observed.entries()) {
      const name = asString(environment['name']);
      if (name === null) continue;
      const classification: Classification | null = index < CLASSIFY_LIMIT
        ? await session.classify('environment', name)
        : null;
      entries.push({
        name,
        classification: classification?.value ?? 'PRODUCTION',
        failed_closed: classification?.failed_closed ?? true,
        source: 'runtime',
        classification_confidence: classification?.confidence ?? 'UNKNOWN',
      });
    }

    /*
     * No topology discovered at all means every reachable runtime is production. The rule
     * inverts the tempting default deliberately, and it bites here rather than at the moment
     * somebody writes to the thing.
     */
    if (entries.length === 0) {
      return {
        assertions: {
          runtime_access: access,
          environments: session.derived(
            'runtime.environments',
            [{
              name: 'unclassified-runtime',
              classification: 'PRODUCTION',
              failed_closed: true,
              source: 'fail-closed',
              classification_confidence: 'UNKNOWN',
            }],
            evidence.map((e) => e.id),
            'the runtime adapter is reachable and reported no environment topology. No '
            + 'topology discovered at all means every reachable runtime is production, so the '
            + 'reachable runtime is classified production and the classification is marked as '
            + 'having failed closed',
            'runtime',
            observation.observedAt,
            evidence,
          ),
        },
        available: true,
        detail: 'reachable runtime with no declared topology, classified production',
        intendedScope: [],
      };
    }

    const declaredOnly = declaredNames
      .filter((name) => !entries.some((e) => e.name === name))
      .map((name) => ({
        name,
        classification: 'UNKNOWN',
        failed_closed: true,
        source: 'repository',
        classification_confidence: 'UNKNOWN',
      }));

    return {
      assertions: {
        runtime_access: access,
        environments: session.observedFact(
          'runtime.environments', entries, evidence, 'runtime', observation.observedAt,
        ),
        declared_not_observed: session.derived(
          'runtime.environments',
          declaredOnly,
          ['architecture.declared_environments', ...evidence.map((e) => e.id)],
          'environments the repository declares and the runtime does not show. That gap is '
          + 'the finding, not a reason to assume either side is wrong',
          'runtime',
          observation.observedAt,
          evidence,
        ),
      },
      available: true,
      detail: `${entries.length} environment(s) classified`,
      intendedScope: [],
    };
  },
};

/** Services, and whether they actually answer. */
export const servicesProbe: SectionProbe = {
  name: 'runtime.services',
  section: 'runtime_state',
  tier: 2,
  freshnessClass: 'runtime',
  async run(session, _input) {
    const listed = await session.observe({
      probe: 'runtime.services',
      adapter: RUNTIME,
      op: OPS.runtime.listServices,
      args: {},
      kind: 'http',
      ref: `${RUNTIME}.${OPS.runtime.listServices}`,
    });
    if (listed.outcome !== 'OBSERVED') {
      return {
        assertions: {
          services: session.noAccess('runtime.services', 'the running services', listed),
          service_health: session.noAccess('runtime.services', 'service health', listed),
        },
        available: false,
        detail: 'services could not be listed',
        intendedScope: [],
      };
    }

    const services = records(listed.value);
    const evidence: Evidence[] = [listed.evidence];
    const health: Array<Record<string, unknown>> = [];
    for (const service of services.slice(0, CLASSIFY_LIMIT)) {
      const name = asString(service['name']);
      if (name === null) continue;
      const observation = await session.observe({
        probe: 'runtime.services',
        adapter: RUNTIME,
        op: OPS.runtime.health,
        args: { service: name },
        kind: 'http',
        ref: `${RUNTIME}.${OPS.runtime.health} ${name}`,
      });
      if (observation.outcome === 'OBSERVED') {
        evidence.push(observation.evidence);
        const record = asRecord(observation.value);
        health.push({
          service: name,
          reachable: true,
          status: record === null ? null : record['status'],
          version: record === null ? null : record['version'],
        });
        continue;
      }
      /*
       * A service that did not answer is recorded as unreachable with the reason. It is not
       * recorded as unhealthy, and it is certainly not omitted: a service missing from a
       * health list reads as a service that does not exist.
       */
      health.push({
        service: name,
        reachable: false,
        status: 'UNAVAILABLE',
        detail: observation.outcome === 'NO_ACCESS' ? observation.detail : observation.outcome,
      });
    }

    return {
      assertions: {
        services: session.observedFact(
          'runtime.services', services, [listed.evidence], 'runtime', listed.observedAt,
        ),
        service_health: session.observedFact(
          'runtime.services', health, evidence, 'runtime', listed.observedAt,
        ),
      },
      available: true,
      detail: `${services.length} service(s), ${health.length} checked`,
      intendedScope: [],
    };
  },
};

/** What the data actually looks like: reachability, volume, and how fresh the newest record is. */
export const dataProbe: SectionProbe = {
  name: 'runtime.data',
  section: 'runtime_state',
  tier: 2,
  freshnessClass: 'runtime',
  async run(session, input) {
    const observation = await session.observe({
      probe: 'runtime.data',
      adapter: RUNTIME,
      op: OPS.runtime.query,
      args: { purpose: 'data_reality', scope_paths: [...input.scope.paths] },
      kind: 'query',
      ref: `${RUNTIME}.${OPS.runtime.query} data reality over the admitted scope`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertions: {
          stores: session.noAccess('runtime.data', 'the data stores in use', observation),
        },
        available: false,
        detail: 'the data reality could not be queried',
        intendedScope: input.scope.paths,
      };
    }
    const result = asRecord(observation.value);
    const stores = records(result?.['stores']);
    const evidence = [observation.evidence];
    return {
      assertions: {
        stores: session.observedFact(
          'runtime.data', stores, evidence, 'runtime', observation.observedAt,
        ),
        /*
         * An empty store is EMPTY: the query succeeded and there was nothing in it. That is a
         * different statement from UNAVAILABLE, and keeping them apart is the difference
         * between "there are no listings today" and "the exchange is down".
         */
        empty_stores: session.observedFact(
          'runtime.data',
          stores.filter((s) => asNumber(s['rows']) === 0).map((s) => asString(s['name'])),
          evidence,
          'runtime',
          observation.observedAt,
        ),
        newest_record_at: session.observedFact(
          'runtime.data',
          stores.map((s) => ({ store: asString(s['name']), at: asString(s['newest_record_at']) })),
          evidence,
          'runtime',
          observation.observedAt,
        ),
      },
      available: true,
      detail: `${stores.length} store(s) observed`,
      intendedScope: input.scope.paths,
    };
  },
};

/**
 * Error patterns, throughput, and silence where activity was expected.
 *
 * Log evidence carries a predicate rather than a raw excerpt, because a log line that has
 * since rotated would mismatch on re-execution for the wrong reason. The kernel re-evaluates
 * the predicate the observation satisfied.
 */
export const logsProbe: SectionProbe = {
  name: 'runtime.logs',
  section: 'runtime_state',
  tier: 2,
  freshnessClass: 'runtime',
  async run(session, input) {
    const observation = await session.observe({
      probe: 'runtime.logs',
      adapter: RUNTIME,
      op: OPS.runtime.query,
      args: { purpose: 'error_patterns', scope_paths: [...input.scope.paths] },
      kind: 'log',
      ref: `${RUNTIME}.${OPS.runtime.query} error patterns`,
      /*
       * "Errors are present" or "no errors were seen", rather than a count that will have
       * moved by the time anyone checks. The predicate states what the observation actually
       * established, which is the property that survives the log rotating underneath it.
       */
      predicateFrom: (value) => {
        const count = records(asRecord(value)?.['errors']).length;
        return count === 0
          ? { subject: 'errors.length', operator: 'eq', operand: 0 }
          : { subject: 'errors.length', operator: 'gte', operand: 1 };
      },
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertions: {
          error_patterns: session.noAccess('runtime.logs', 'the error patterns', observation),
        },
        available: false,
        detail: 'logs could not be queried',
        intendedScope: input.scope.paths,
      };
    }
    const result = asRecord(observation.value);
    const errors = records(result?.['errors']);
    return {
      assertions: {
        error_patterns: session.observedFact(
          'runtime.logs', errors, [observation.evidence], 'runtime', observation.observedAt,
        ),
        error_count: session.observedFact(
          'runtime.logs', errors.length, [observation.evidence], 'runtime', observation.observedAt,
        ),
        throughput: asNumber(result?.['throughput']) === null
          ? session.insufficient(
            'runtime.logs',
            'the log query returned no throughput figure, so whether the system is silent '
            + 'where activity was expected is not established',
            'have the runtime adapter report throughput alongside error patterns',
            observation.observedAt,
          )
          : session.observedFact(
            'runtime.logs',
            asNumber(result?.['throughput']),
            [observation.evidence],
            'runtime',
            observation.observedAt,
          ),
      },
      available: true,
      detail: `${errors.length} error pattern(s)`,
      intendedScope: input.scope.paths,
    };
  },
};

/** What is actually deployed, and how far it has drifted from the repository. */
export const productionProbe: SectionProbe = {
  name: 'runtime.production',
  section: 'production_state',
  tier: 2,
  freshnessClass: 'runtime',
  async run(session, input) {
    const environments = input.ledger.value('runtime_state', 'environments');
    const list = records(environments);
    const production = list.filter((e) => asString(e['classification']) === 'PRODUCTION');
    const observedAt = session.nowIso();

    if (list.length === 0) {
      return {
        assertions: {
          deployed_versions: session.notComputed(
            'runtime.production',
            'no environment topology was established, so there was no environment to ask for a '
            + 'deployed version. Production validation is NOT_VALIDATED and completion is at '
            + 'best COMPLETE_WITH_GAPS',
            'give AgentOS runtime access, or declare the environment topology, and re-probe',
            observedAt,
          ),
        },
        available: false,
        detail: 'no environments to interrogate',
        intendedScope: [],
      };
    }

    const evidence: Evidence[] = [];
    const versions: Array<Record<string, unknown>> = [];
    for (const environment of production.slice(0, CLASSIFY_LIMIT)) {
      const name = asString(environment['name']);
      if (name === null) continue;
      const observation = await session.observe({
        probe: 'runtime.production',
        adapter: RUNTIME,
        op: OPS.runtime.deployedVersion,
        args: { environment: name },
        kind: 'http',
        ref: `${RUNTIME}.${OPS.runtime.deployedVersion} ${name}`,
      });
      if (observation.outcome !== 'OBSERVED') {
        versions.push({
          environment: name,
          reachable: false,
          detail: observation.outcome === 'NO_ACCESS' ? observation.detail : observation.outcome,
        });
        continue;
      }
      evidence.push(observation.evidence);
      const record = asRecord(observation.value);
      versions.push({
        environment: name,
        reachable: true,
        version: record === null ? observation.value : record['version'],
        sha: record === null ? null : asString(record['sha']),
      });
    }

    const head = input.ledger.value('git_state', 'head_sha');
    const headSha = asString(head);
    const drift = headSha === null
      ? session.insufficient(
        'runtime.production',
        'the repository head is not established, so drift between what is deployed and what '
        + 'the repository contains cannot be computed',
        'restore git access and re-probe',
        observedAt,
      )
      : session.derived(
        'runtime.production',
        versions.map((v) => ({
          environment: v['environment'],
          matches_head: v['sha'] === headSha,
          deployed_sha: v['sha'],
          head_sha: headSha,
        })),
        ['git_state.head_sha', ...evidence.map((e) => e.id)],
        'drift is the comparison of an observed deployed revision against the observed '
        + 'repository head. Both sides are facts and the comparison between them is the '
        + 'inference',
        'runtime',
        observedAt,
        evidence,
      );

    return {
      assertions: {
        deployed_versions: evidence.length === 0
          ? session.insufficient(
            'runtime.production',
            `${production.length} production environment(s) were named and none answered a `
            + 'deployed-version request',
            'restore runtime access to the production environments and re-probe',
            observedAt,
          )
          : session.observedFact(
            'runtime.production', versions, evidence, 'runtime', observedAt,
          ),
        drift_from_repository: drift,
        production_environments: session.derived(
          'runtime.production',
          production.map((e) => asString(e['name'])),
          ['runtime_state.environments'],
          'environments classified production by the adapter, including any classified '
          + 'production because the classification failed closed',
          'runtime',
          observedAt,
        ),
      },
      available: evidence.length > 0,
      detail: `${production.length} production environment(s)`,
      intendedScope: [],
    };
  },
};

export const RUNTIME_TIER_2: readonly SectionProbe[] = [
  environmentsProbe,
  servicesProbe,
  dataProbe,
  logsProbe,
  productionProbe,
];

export const RUNTIME_PROBES: readonly SectionProbe[] = RUNTIME_TIER_2;
