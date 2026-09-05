import type { Assertion } from '@agentos/contracts';
import { ADAPTERS, OPS } from '../ops.js';
import type { SectionProbe } from '../probe.js';
import { asString, records } from '../probe.js';
import { observe } from './observation.js';

/**
 * Agent and model capability probes, and the authorization surface they imply.
 *
 * What AgentOS itself can reach is part of the answer to "what is actually true", because a
 * plan that assumes a connector nobody has is a plan that fails late. The rule that matters
 * here is one sentence in [CONTEXT_MODEL.md](../../../docs/CONTEXT_MODEL.md) section 3:
 *
 * > Includes servers configured but unreachable — a failed connector is `UNAVAILABLE`, never
 * > "absent".
 *
 * A connector list that quietly drops the ones that failed to start reads as a smaller
 * capability surface, which sends a run down a worse path for a reason nobody can see. So the
 * unreachable ones are listed, separately and by name, with what they said.
 */

const HOST = ADAPTERS.host;

/** Skills, tools, plugins and connectors: what an agent could actually be given. */
export const agentCapabilitiesProbe: SectionProbe = {
  name: 'host.agent_capabilities',
  section: 'agent_capabilities',
  tier: 1,
  freshnessClass: 'agentos',
  async run(session, _input) {
    const availability = session.adapterState(HOST);
    const observedAt = session.nowIso();
    const assertions: Record<string, Assertion> = {
      host_access: session.derived(
        'host.agent_capabilities',
        availability,
        ['adapter.availability'],
        'the host adapter reports its own availability. Without it AgentOS does not know what '
        + 'it can reach, which is a limitation on the run rather than an empty capability set',
        'agentos',
        observedAt,
      ),
    };

    for (const [key, op] of [
      ['skills', OPS.host.listSkills],
      ['tools', OPS.host.listTools],
      ['plugins', OPS.host.listPlugins],
    ] as const) {
      const observation = await observe(session, {
        probe: 'host.agent_capabilities',
        adapter: HOST,
        op,
        args: {},
        kind: 'command',
        ref: `${HOST}.${op}`,
      });
      assertions[key] = observation.outcome === 'OBSERVED'
        ? session.observedFact(
          'host.agent_capabilities',
          records(observation.value),
          [observation.evidence],
          'agentos',
          observation.observedAt,
        )
        : session.noAccess('host.agent_capabilities', `the installed ${key}`, observation);
    }

    const servers = await observe(session, {
      probe: 'host.agent_capabilities',
      adapter: HOST,
      op: OPS.host.listMcpServers,
      args: {},
      kind: 'command',
      ref: `${HOST}.${OPS.host.listMcpServers}`,
    });
    if (servers.outcome === 'OBSERVED') {
      const listed = records(servers.value);
      const evidence = [servers.evidence];
      const reachable = listed.filter((s) => asString(s['state'])?.toUpperCase() === 'AVAILABLE');
      const unreachable = listed.filter((s) => {
        const state = asString(s['state'])?.toUpperCase();
        return state !== undefined && state !== 'AVAILABLE' && state !== 'NOT_CONFIGURED';
      });
      assertions['connectors'] = session.observedFact(
        'host.agent_capabilities', listed, evidence, 'agentos', servers.observedAt,
      );
      assertions['connectors_reachable'] = session.observedFact(
        'host.agent_capabilities', reachable, evidence, 'agentos', servers.observedAt,
      );
      /*
       * Kept as its own key, and kept even when empty. A configured connector that failed to
       * start is a fact about access that changes what this run can attempt, and folding it
       * into the reachable list or dropping it entirely are the two ways that fact
       * disappears.
       */
      assertions['connectors_unavailable'] = session.observedFact(
        'host.agent_capabilities', unreachable, evidence, 'agentos', servers.observedAt,
      );
    } else {
      assertions['connectors'] = session.noAccess(
        'host.agent_capabilities', 'the configured connectors', servers,
      );
      assertions['connectors_unavailable'] = session.noAccess(
        'host.agent_capabilities', 'the connectors that failed to start', servers,
      );
    }

    return {
      assertions,
      available: availability.state === 'AVAILABLE',
      detail: `host adapter is ${availability.state}`,
      intendedScope: [],
    };
  },
};

/** Models, their limits and their properties, where the host can say. */
export const modelCapabilitiesProbe: SectionProbe = {
  name: 'host.model_capabilities',
  section: 'model_capabilities',
  tier: 1,
  freshnessClass: 'agentos',
  async run(session, _input) {
    const observation = await observe(session, {
      probe: 'host.model_capabilities',
      adapter: HOST,
      op: OPS.host.listModels,
      args: {},
      kind: 'command',
      ref: `${HOST}.${OPS.host.listModels}`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertions: {
          models: session.noAccess('host.model_capabilities', 'the available models', observation),
        },
        available: false,
        detail: 'models could not be listed',
        intendedScope: [],
      };
    }
    const models = records(observation.value);
    const evidence = [observation.evidence];
    return {
      assertions: {
        models: session.observedFact(
          'host.model_capabilities', models, evidence, 'agentos', observation.observedAt,
        ),
        model_count: session.observedFact(
          'host.model_capabilities', models.length, evidence, 'agentos', observation.observedAt,
        ),
        /*
         * Cost and speed are recorded where the host states them and left unknown where it
         * does not. A price nobody published, filled in from memory, would be a fabricated
         * default in the one section a budget decision reads.
         */
        cost_known_for: session.observedFact(
          'host.model_capabilities',
          models.filter((m) => m['usd_per_million_input'] !== undefined).map((m) => asString(m['id'])),
          evidence,
          'agentos',
          observation.observedAt,
        ),
      },
      available: true,
      detail: `${models.length} model(s)`,
      intendedScope: [],
    };
  },
};

/**
 * What this run may do without asking, read off the declared operation surface.
 *
 * The descriptors are the authority: an operation is mutating or it is not, it fires gates or
 * it does not, and it names its reversal or it declares itself non-reversible. Reading the
 * authorization posture off the descriptors rather than off a policy summary keeps it a
 * statement about what is actually reachable this run.
 */
export const authorizationProbe: SectionProbe = {
  name: 'host.authorization',
  section: 'authorization',
  tier: 1,
  freshnessClass: 'agentos',
  run(session, _input) {
    const descriptors = session.descriptors();
    const observedAt = session.nowIso();
    const gated = descriptors.filter((d) => d.gates.length > 0);
    const irreversible = descriptors.filter((d) => d.mutating && d.reversal === null);
    return Promise.resolve({
      assertions: {
        operations_available: session.derived(
          'host.authorization',
          descriptors.map((d) => `${d.adapter}.${d.op}`),
          ['adapter.descriptors'],
          'the declared operation surface of this run. It is what the adapters offer, which is '
          + 'a different question from what a given dispatch is granted',
          'agentos',
          observedAt,
        ),
        mutating_operations: session.derived(
          'host.authorization',
          descriptors.filter((d) => d.mutating).map((d) => `${d.adapter}.${d.op}`),
          ['adapter.descriptors'],
          'operations that change authoritative state. Discovery calls none of them',
          'agentos',
          observedAt,
        ),
        gated_operations: session.derived(
          'host.authorization',
          gated.map((d) => ({ operation: `${d.adapter}.${d.op}`, gates: d.gates })),
          ['adapter.descriptors'],
          'operations that fire an authorization gate. A human decides these, and the record '
          + 'exists so that the decision is evaluable rather than assumed',
          'agentos',
          observedAt,
        ),
        non_reversible_operations: session.derived(
          'host.authorization',
          irreversible.map((d) => `${d.adapter}.${d.op}`),
          ['adapter.descriptors'],
          'mutating operations that declare no reversal. A dispatch that performed one is '
          + 'never automatically retried',
          'agentos',
          observedAt,
        ),
        observation_safe_operations: session.derived(
          'host.authorization',
          descriptors.filter((d) => d.observation_safe).map((d) => `${d.adapter}.${d.op}`),
          ['adapter.descriptors'],
          'operations the kernel may replay to verify evidence. Evidence naming anything else '
          + 'cannot be checked, which is why an assertion resting on it is capped at INFERENCE',
          'agentos',
          observedAt,
        ),
      },
      available: true,
      detail: `${descriptors.length} declared operation(s)`,
      intendedScope: [],
    });
  },
};

export const CAPABILITY_TIER_1: readonly SectionProbe[] = [
  agentCapabilitiesProbe,
  modelCapabilitiesProbe,
  authorizationProbe,
];

export const CAPABILITY_PROBES: readonly SectionProbe[] = CAPABILITY_TIER_1;
