import type { AdapterAvailability } from '@agentos/contracts';
import { fact, selfEvidence, unavailable, unknown } from '../assertions.js';
import { OPTIONAL_STRING_ARG, STRING_ARG, readOnlyOperation } from '../define.js';
import type { OperationRegistration } from '../descriptors.js';
import { isAbsent, messageOf } from '../errors.js';
import { classify, type ClassificationObservation, type ClassificationProbe } from '../classification.js';
import type { AvailabilityProbe, Connector } from '../ports.js';

/**
 * The runtime adapter: read-only, and optional.
 *
 * Optional in the sense REPOSITORY_ADAPTER 4 means it — its absence reduces the strength of
 * claims AgentOS is allowed to make and never reduces honesty about them. With no runtime
 * access, capability validation caps at integration level: every capability is at most
 * `PARTIAL`, never `PROVEN`, and the Validator says so. That sentence is the deliverable, not
 * the connector.
 *
 * The interesting descriptor here is `read_logs`, which is `observation_safe: false` while
 * every other read in this file is true. A log tail that advances a cursor consumes the
 * observation it reports, and REPOSITORY_ADAPTER 2.3 names exactly that case: `mutating:
 * false` does not imply `observation_safe: true`. So the kernel will refuse to replay it, and
 * evidence resting on it is `UNVERIFIABLE` rather than verified — which is the honest verdict
 * and a different one from a mismatch.
 */

export interface RuntimeOptions {
  /** The configured runtime, or `null` where the host has none. */
  readonly connector: Connector | null;
}

const ADAPTER = 'runtime';

export function runtimeOperations(options: RuntimeOptions): readonly OperationRegistration[] {
  const reach = async (
    resource: string,
    args: Readonly<Record<string, unknown>>,
    probe: string,
    at: string,
  ): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly value: unknown }> => {
    const connector = options.connector;
    if (connector === null || !connector.configured) {
      return {
        ok: false,
        value: unknown(
          probe, at, 'NOT_APPLICABLE',
          'grant runtime access. Without it, capability validation caps at integration level: '
          + 'every capability is at most PARTIAL and never PROVEN, and the report says so',
          'no runtime is configured on this host',
        ),
      };
    }
    try {
      return { ok: true, value: await connector.fetch(resource, args) };
    } catch (error) {
      if (isAbsent(error)) return { ok: true, value: { present: false, detail: messageOf(error) } };
      return {
        ok: false,
        value: unavailable(
          probe, at,
          'restore runtime access. It is configured, so this is a reachability failure and '
          + 'not an absence of runtime — the difference decides whether a human should look',
          messageOf(error),
        ),
      };
    }
  };

  return [
    readOnlyOperation({
      adapter: ADAPTER,
      op: 'list_environments',
      description:
        'The runtime topology. With none discovered at all, every reachable runtime is '
        + 'production.',
      evidenceKind: 'query',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await reach('environments', {}, 'runtime.list_environments', at);
        if (!result.ok) return { value: result.value, excerpt: 'environments: unavailable' };
        return {
          value: fact(result.value, 'runtime.list_environments', at, selfEvidence({
            adapter: ADAPTER,
            op: 'list_environments',
            args: invocation.args,
            kind: 'query',
            ref: 'runtime.list_environments',
            excerpt: JSON.stringify(result.value),
            observedAt: at,
          })),
          excerpt: JSON.stringify(result.value),
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'health',
      description: 'The health of one service, where a runtime is reachable.',
      args: { service: STRING_ARG },
      required: ['service'],
      evidenceKind: 'http',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await reach('health', invocation.args, 'runtime.health', at);
        if (!result.ok) return { value: result.value, excerpt: 'health: unavailable' };
        return {
          value: fact(result.value, 'runtime.health', at, selfEvidence({
            adapter: ADAPTER,
            op: 'health',
            args: invocation.args,
            kind: 'http',
            ref: 'runtime.health',
            excerpt: JSON.stringify(result.value),
            observedAt: at,
          })),
          excerpt: JSON.stringify(result.value),
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'query',
      description:
        'Runs one read-only query against a runtime data store. Repeatable, and therefore '
        + 'replayable for evidence verification.',
      args: { query: STRING_ARG, target: OPTIONAL_STRING_ARG },
      required: ['query'],
      evidenceKind: 'query',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await reach('query', invocation.args, 'runtime.query', at);
        if (!result.ok) return { value: result.value, excerpt: 'query: unavailable' };
        return {
          value: fact(result.value, 'runtime.query', at, selfEvidence({
            adapter: ADAPTER,
            op: 'query',
            args: invocation.args,
            kind: 'query',
            ref: 'runtime.query',
            excerpt: JSON.stringify(result.value),
            observedAt: at,
          })),
          excerpt: JSON.stringify(result.value),
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'list_services',
      description: 'The services a reachable runtime is running, per environment.',
      args: { environment: OPTIONAL_STRING_ARG },
      evidenceKind: 'query',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await reach('services', invocation.args, 'runtime.list_services', at);
        if (!result.ok) return { value: result.value, excerpt: 'services: unavailable' };
        return {
          value: fact(result.value, 'runtime.list_services', at, selfEvidence({
            adapter: ADAPTER,
            op: 'list_services',
            args: invocation.args,
            kind: 'query',
            ref: 'runtime.list_services',
            excerpt: JSON.stringify(result.value),
            observedAt: at,
          })),
          excerpt: JSON.stringify(result.value),
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'deployed_version',
      description:
        'Which build a runtime is actually running. What is deployed is an observation; '
        + 'that it works is not, and this operation does not claim it.',
      args: { service: STRING_ARG, environment: OPTIONAL_STRING_ARG },
      required: ['service'],
      evidenceKind: 'http',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await reach('deployed_version', invocation.args, 'runtime.deployed_version', at);
        if (!result.ok) return { value: result.value, excerpt: 'deployed version: unavailable' };
        return {
          value: fact(result.value, 'runtime.deployed_version', at, selfEvidence({
            adapter: ADAPTER,
            op: 'deployed_version',
            args: invocation.args,
            kind: 'http',
            ref: 'runtime.deployed_version',
            excerpt: JSON.stringify(result.value),
            observedAt: at,
          })),
          excerpt: JSON.stringify(result.value),
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'outcome_evidence',
      description:
        "Whether a work item's desired outcome observably holds in a running system. Asked "
        + 'of the runtime and of nothing else: an outcome inferred from a merge, a green '
        + 'pipeline or a deployment is exactly CLAIMED_DONE_UNPROVEN.',
      args: { outcome: STRING_ARG, environment: OPTIONAL_STRING_ARG },
      required: ['outcome'],
      evidenceKind: 'query',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const outcome = String(invocation.args['outcome']);
        const result = await reach('outcome_evidence', invocation.args, 'runtime.outcome_evidence', at);

        if (!result.ok) {
          /*
           * No runtime, or a runtime that would not answer. Either way nothing was observed,
           * and the one thing that must not happen here is a verdict derived from something
           * cheaper. A merge is not an outcome; a deployment is not an outcome; a passing
           * pipeline is not an outcome. UNAVAILABLE is the honest answer and it caps every
           * capability that rests on it at PARTIAL.
           */
          return { value: result.value, excerpt: 'outcome evidence: unavailable' };
        }

        const observed = result.value;
        const holds = observed !== null && typeof observed === 'object'
          && typeof (observed as { holds?: unknown }).holds === 'boolean'
            ? (observed as { holds: boolean }).holds
            : null;

        if (holds === null) {
          /*
           * The runtime answered and did not say. That is a third state and not a `false`:
           * "we asked and it would not tell us" is insufficient evidence, which routes to
           * more discovery rather than to a conclusion.
           */
          return {
            value: unknown(
              'runtime.outcome_evidence', at, 'INSUFFICIENT_EVIDENCE',
              `state a checkable form of the outcome "${outcome}", or give the runtime a way `
              + 'to report whether it holds. An outcome nobody can observe cannot be '
              + 'validated, and inferring it from a deployment is the fabrication this '
              + 'operation exists to refuse',
              JSON.stringify(observed),
            ),
            excerpt: 'outcome evidence: insufficient',
          };
        }

        return {
          value: fact({ outcome, holds, observed }, 'runtime.outcome_evidence', at, selfEvidence({
            adapter: ADAPTER,
            op: 'outcome_evidence',
            args: invocation.args,
            kind: 'query',
            ref: `runtime observation of "${outcome}"`,
            excerpt: JSON.stringify(observed),
            observedAt: at,
          })),
          excerpt: `${outcome}: ${String(holds)}`,
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'read_metrics',
      description:
        'Reads a metric series. Verified by re-evaluating the predicate the observation '
        + 'satisfied, because the exact value is not checkable a minute later and the '
        + 'predicate is.',
      args: { metric: STRING_ARG, window: OPTIONAL_STRING_ARG },
      required: ['metric'],
      evidenceKind: 'metric',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await reach('metrics', invocation.args, 'runtime.read_metrics', at);
        if (!result.ok) return { value: result.value, excerpt: 'metrics: unavailable' };
        return {
          value: result.value,
          excerpt: JSON.stringify(result.value),
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'read_logs',
      description:
        'Tails a log stream. Not observation_safe: re-execution advances the cursor and '
        + 'consumes the observation it reports, so the kernel may not replay it.',
      args: { query: STRING_ARG, since: OPTIONAL_STRING_ARG },
      required: ['query'],
      evidenceKind: 'log',
      /*
       * mutating: false and observation_safe: false, which is the pair REPOSITORY_ADAPTER 2.3
       * exists to make expressible. Nothing authoritative changes when logs are read, and
       * reading them twice does not produce the same observation, so replay would report a
       * mismatch that is a property of the stream rather than of the evidence.
       */
      observationSafe: false,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await reach('logs', invocation.args, 'runtime.read_logs', at);
        if (!result.ok) return { value: result.value, excerpt: 'logs: unavailable' };
        return {
          value: result.value,
          excerpt: JSON.stringify(result.value),
        };
      },
    }),
  ];
}

export function runtimeAvailability(options: RuntimeOptions): AvailabilityProbe {
  return {
    adapter: ADAPTER,
    async probe(): Promise<Omit<AdapterAvailability, 'checked_at'>> {
      const connector = options.connector;
      if (connector === null || !connector.configured) {
        return {
          adapter: ADAPTER,
          state: 'NOT_CONFIGURED',
          detail:
            'no runtime access. Capability validation caps at integration level: every '
            + 'capability is at most PARTIAL, never PROVEN, and the Validator says so',
        };
      }
      try {
        await connector.fetch('ping', {});
        return { adapter: ADAPTER, state: 'AVAILABLE', detail: `${connector.id} answered` };
      } catch (error) {
        return {
          adapter: ADAPTER,
          state: 'UNAVAILABLE',
          detail: `${connector.id} is configured and did not answer: ${messageOf(error)}`,
        };
      }
    },
  };
}

/**
 * The environment classifier, and the reason it is here rather than in the kernel.
 *
 * "Unknown environment means production", and "no environment topology discovered at all
 * means every reachable runtime is production". Both are observations, and an observation
 * belongs to the adapter that made it. The classification's `confidence` and `failed_closed`
 * then let a run that was conservative because it was blind be told apart from one that was
 * conservative because the target really was production — without either of them changing
 * whether the gate fires.
 */
export function environmentProbe(options: RuntimeOptions): ClassificationProbe {
  return {
    kind: 'environment',
    async probe(subject: string): Promise<ClassificationObservation> {
      const connector = options.connector;
      if (connector === null || !connector.configured) {
        return {
          established: false,
          detail:
            `no runtime is configured, so no environment topology was discovered and ${subject} `
            + 'cannot be placed in one',
        };
      }
      let topology: unknown;
      try {
        topology = await connector.fetch('environments', {});
      } catch (error) {
        return {
          established: false,
          detail: `the runtime would not describe its environments: ${messageOf(error)}`,
        };
      }
      if (!Array.isArray(topology) || topology.length === 0) {
        return {
          established: false,
          detail:
            'the runtime described no environments, and with no topology discovered at all '
            + 'every reachable runtime is production',
        };
      }
      const entry = topology.find(
        (candidate): candidate is { name: string; production: boolean } =>
          candidate !== null && typeof candidate === 'object'
          && (candidate as { name?: unknown }).name === subject
          && typeof (candidate as { production?: unknown }).production === 'boolean',
      );
      if (entry === undefined) {
        return {
          established: false,
          detail:
            `${subject} does not appear in the discovered topology, or appears without a `
            + 'production flag',
        };
      }
      return {
        established: true,
        dangerous: entry.production,
        confidence: 'FACT',
        detail: `the runtime reports ${subject} production=${String(entry.production)}`,
      };
    },
  };
}

/** Re-exported so a composition root can build a classification without importing two files. */
export { classify };
