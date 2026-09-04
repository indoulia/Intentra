import type { AdapterAvailability } from '@agentos/contracts';
import { fact, selfEvidence, unavailable, unknown } from '../assertions.js';
import { OPTIONAL_STRING_ARG, STRING_ARG, readOnlyOperation } from '../define.js';
import type { OperationRegistration } from '../descriptors.js';
import { ResourceAbsentError, ResourceUnreachableError, isAbsent, messageOf } from '../errors.js';
import type { AvailabilityProbe, Connector } from '../ports.js';

/**
 * The project-management adapter, read-only.
 *
 * Its whole job in this milestone is to degrade honestly. REPOSITORY_ADAPTER 4 lists "no
 * project management access" as a recorded limitation rather than a failure: intent comes
 * from documentation and commit history instead, and the reconciliation matrix gets an
 * `INDETERMINATE` intent axis. That only works if the two silences stay apart —
 *
 * - **`NOT_CONFIGURED`** — this host has no project-management access. Nothing is wrong; the
 *   intent axis is indeterminate and the report says which capability was reduced.
 * - **`UNAVAILABLE`** — it is configured and would not answer. Something *is* wrong, and it
 *   is worth telling a human, because the fix is different and so is the confidence anyone
 *   should place in a run that proceeded without it.
 *
 * Collapsing them would make a broken connector look like a deliberate configuration, which
 * is the difference between "we chose not to look" and "we could not look and did not say".
 *
 * No product name appears anywhere here. AgentOS finds a project-management system because
 * the host exposes one, never because AgentOS was told which one to expect.
 */

export interface ProjectManagementOptions {
  /** The configured system, or `null` where the host has none. */
  readonly connector: Connector | null;
}

const ADAPTER = 'pm';

export function projectManagementOperations(
  options: ProjectManagementOptions,
): readonly OperationRegistration[] {
  const reach = async (
    resource: string,
    args: Readonly<Record<string, unknown>>,
    probe: string,
    at: string,
  ): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly value: unknown }> => {
    const connector = options.connector;
    if (connector === null) {
      return {
        ok: false,
        value: unknown(
          probe, at, 'NOT_APPLICABLE',
          'configure a project-management system for this host. Without one, intent comes '
          + 'from documentation and commit history and the reconciliation matrix carries an '
          + 'INDETERMINATE intent axis — a recorded limitation, not a failure',
          'no project-management system is configured on this host',
        ),
      };
    }
    if (!connector.configured) {
      return {
        ok: false,
        value: unknown(
          probe, at, 'NOT_APPLICABLE',
          `the ${connector.id} connector is present but not configured. Configure it, or `
          + 'accept an INDETERMINATE intent axis',
          `${connector.id} reports itself unconfigured`,
        ),
      };
    }
    try {
      return { ok: true, value: await connector.fetch(resource, args) };
    } catch (error) {
      if (isAbsent(error)) {
        return {
          ok: true,
          value: { present: false, detail: messageOf(error) },
        };
      }
      return {
        ok: false,
        value: unavailable(
          probe, at,
          `restore access to the ${connector.id} project-management system. It is configured, `
          + 'so this is a reachability failure and not an absence of intent data — the two '
          + 'lead to different decisions and are kept apart',
          messageOf(error),
        ),
      };
    }
  };

  return [
    readOnlyOperation({
      adapter: ADAPTER,
      op: 'read_issue',
      description:
        'Reads one work item from the project-management system. Absent and unreachable are '
        + 'reported as different things.',
      args: { key: STRING_ARG },
      required: ['key'],
      evidenceKind: 'ticket',
      observationSafe: true,
      handler: async (invocation) => {
        const key = String(invocation.args['key']);
        const at = invocation.now.toISOString();
        const connector = options.connector;
        if (connector === null || !connector.configured) {
          /*
           * Thrown rather than returned, because this operation is also an idempotency
           * re-read and a source-drift locator. "Not configured" is not "absent": it
           * establishes nothing, so it has to reach the caller as unreachable.
           */
          throw new ResourceUnreachableError(
            key,
            'no project-management system is configured, so whether this item exists cannot '
            + 'be established. Unreachable is neither present nor absent',
          );
        }
        const result = await connector.fetch('issue', { key });
        if (result === null || result === undefined) {
          throw new ResourceAbsentError(key, `${key} does not exist in ${connector.id}`);
        }
        return {
          value: fact(result, 'pm.read_issue', at, selfEvidence({
            adapter: ADAPTER,
            op: 'read_issue',
            args: invocation.args,
            kind: 'ticket',
            ref: 'pm.read_issue',
            excerpt: JSON.stringify(result),
            observedAt: at,
          })),
          excerpt: JSON.stringify(result),
          externalLocator: { adapter: ADAPTER, op: 'read_issue', args: { key } },
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'search_issues',
      description: 'Searches the project-management system, or reports why it could not.',
      args: { query: STRING_ARG, limit: OPTIONAL_STRING_ARG },
      required: ['query'],
      evidenceKind: 'ticket',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await reach('search', invocation.args, 'pm.search_issues', at);
        if (!result.ok) return { value: result.value, excerpt: 'project management: unavailable' };
        return {
          value: fact(result.value, 'pm.search_issues', at, selfEvidence({
            adapter: ADAPTER,
            op: 'search_issues',
            args: invocation.args,
            kind: 'ticket',
            ref: 'pm.search_issues',
            excerpt: JSON.stringify(result.value),
            observedAt: at,
          })),
          excerpt: JSON.stringify(result.value),
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'list_children',
      description: 'Child work items the project-management system records for one parent. Unioned by '
        + 'discovery with what AgentOS recorded itself, because either source alone is a '
        + 'partial view of what the work decomposed into.',
      args: { key: STRING_ARG },
      required: ['key'],
      evidenceKind: 'ticket',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await reach('children', invocation.args, 'pm.list_children', at);
        if (!result.ok) return { value: result.value, excerpt: 'project management: unavailable' };
        return {
          value: fact(result.value, 'pm.list_children', at, selfEvidence({
            adapter: ADAPTER,
            op: 'list_children',
            args: invocation.args,
            kind: 'ticket',
            ref: 'pm.list_children',
            excerpt: JSON.stringify(result.value),
            observedAt: at,
          })),
          excerpt: JSON.stringify(result.value),
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'list_links',
      description: 'Links between work items: duplicates, dependencies, supersessions. Read only, and '
        + 'never merged automatically.',
      args: { key: STRING_ARG },
      required: ['key'],
      evidenceKind: 'ticket',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await reach('links', invocation.args, 'pm.list_links', at);
        if (!result.ok) return { value: result.value, excerpt: 'project management: unavailable' };
        return {
          value: fact(result.value, 'pm.list_links', at, selfEvidence({
            adapter: ADAPTER,
            op: 'list_links',
            args: invocation.args,
            kind: 'ticket',
            ref: 'pm.list_links',
            excerpt: JSON.stringify(result.value),
            observedAt: at,
          })),
          excerpt: JSON.stringify(result.value),
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'list_documents',
      description: 'Documents attached to a project or work item, as declared intent to be reconciled '
        + 'against code and runtime rather than believed.',
      args: { key: STRING_ARG },
      required: ['key'],
      evidenceKind: 'document',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await reach('documents', invocation.args, 'pm.list_documents', at);
        if (!result.ok) return { value: result.value, excerpt: 'project management: unavailable' };
        return {
          value: fact(result.value, 'pm.list_documents', at, selfEvidence({
            adapter: ADAPTER,
            op: 'list_documents',
            args: invocation.args,
            kind: 'document',
            ref: 'pm.list_documents',
            excerpt: JSON.stringify(result.value),
            observedAt: at,
          })),
          excerpt: JSON.stringify(result.value),
        };
      },
    }),

    readOnlyOperation({
      adapter: ADAPTER,
      op: 'read_project',
      description: 'Reads one project or board, for the intent axis of the reconciliation matrix.',
      args: { key: STRING_ARG },
      required: ['key'],
      evidenceKind: 'ticket',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const result = await reach('project', invocation.args, 'pm.read_project', at);
        if (!result.ok) return { value: result.value, excerpt: 'project management: unavailable' };
        return {
          value: fact(result.value, 'pm.read_project', at, selfEvidence({
            adapter: ADAPTER,
            op: 'read_project',
            args: invocation.args,
            kind: 'ticket',
            ref: 'pm.read_project',
            excerpt: JSON.stringify(result.value),
            observedAt: at,
          })),
          excerpt: JSON.stringify(result.value),
        };
      },
    }),
  ];
}

export function projectManagementAvailability(
  options: ProjectManagementOptions,
): AvailabilityProbe {
  return {
    adapter: ADAPTER,
    async probe(): Promise<Omit<AdapterAvailability, 'checked_at'>> {
      const connector = options.connector;
      if (connector === null) {
        return {
          adapter: ADAPTER,
          state: 'NOT_CONFIGURED',
          detail:
            'this host has no project-management access. Intent comes from documentation and '
            + 'commit history, and the reconciliation matrix carries an INDETERMINATE intent '
            + 'axis. A recorded limitation, not a failure',
        };
      }
      if (!connector.configured) {
        return {
          adapter: ADAPTER,
          state: 'NOT_CONFIGURED',
          detail: `${connector.id} is present and reports itself unconfigured`,
        };
      }
      try {
        await connector.fetch('ping', {});
        return { adapter: ADAPTER, state: 'AVAILABLE', detail: `${connector.id} answered` };
      } catch (error) {
        return {
          adapter: ADAPTER,
          state: 'UNAVAILABLE',
          detail:
            `${connector.id} is configured and did not answer: ${messageOf(error)}. Configured `
            + 'and unreachable is never reported as not configured',
        };
      }
    },
  };
}
