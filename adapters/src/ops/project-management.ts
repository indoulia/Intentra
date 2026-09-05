import type { AdapterAvailability } from '@agentos/contracts';
import { fact, selfEvidence, unavailable, unknown } from '../assertions.js';
import {
  OPTIONAL_STRING_ARG,
  PATH_LIST_ARG,
  STRING_ARG,
  STRING_LIST_ARG,
  readOnlyOperation,
} from '../define.js';
import type { OperationInvocation, OperationRegistration } from '../descriptors.js';
import { ConfinementAbort } from '../framework.js';
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

/**
 * The selectors a caller actually supplied, or `null` where it supplied none.
 *
 * Path selectors are confined element by element on the way through. The framework has already
 * confined them, but it keys its resolved-path map by argument name and a list has no single
 * entry there — so this is where the worktree-relative form is taken, and taking it from a
 * verdict rather than from the raw argument is what stops an unchecked path being handed to a
 * connector that reaches off the machine.
 */
function selectors(
  invocation: OperationInvocation,
  names: readonly string[],
): Readonly<Record<string, unknown>> | null {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const raw = invocation.args[name];
    if (typeof raw === 'string' && raw.length > 0) {
      out[name] = raw;
      continue;
    }
    if (!Array.isArray(raw)) continue;
    const values = raw.filter((e): e is string => typeof e === 'string' && e.length > 0);
    if (values.length === 0) continue;
    out[name] = name.endsWith('_paths') ? values.map((v) => confined(invocation, v)) : values;
  }
  if (Object.keys(out).length === 0) return null;
  /* A bound on the answer is not a reason to ask, so it rides along and never counts as one. */
  const limit = invocation.args['limit'];
  if (limit !== undefined) out['limit'] = limit;
  return out;
}

function confined(invocation: OperationInvocation, requested: string): string {
  const verdict = invocation.confine(requested);
  if (verdict.outcome === 'REFUSED') throw new ConfinementAbort(verdict);
  return verdict.relative;
}

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
      description:
        'Searches the project-management system by free text, by the paths a work item scopes, '
        + 'by capability or by repository — or reports why it could not.',
      /*
       * A free-text `query` alone would make this answerable only by a caller that already
       * knows the system's own query language, and AgentOS never knows which system it is
       * talking to: no product name appears anywhere in this file, deliberately. The structured
       * selectors are the product-neutral form of the same question, and the connector — which
       * does know what it is — turns them into whatever its index wants.
       *
       * `scope_paths` is a path argument, so every element is confined against the worktree
       * root, the dispatch mandate and the deny-list before it is sent anywhere. That matters
       * more here than for a local read: there is a network on the other side of this call, and
       * an unchecked path in an outbound query is an unchecked path that left the machine.
       */
      args: {
        query: STRING_ARG,
        limit: OPTIONAL_STRING_ARG,
        scope_paths: PATH_LIST_ARG,
        capabilities: STRING_LIST_ARG,
        repositories: STRING_LIST_ARG,
      },
      evidenceKind: 'ticket',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const criteria = selectors(
          invocation, ['query', 'scope_paths', 'capabilities', 'repositories'],
        );
        if (criteria === null) {
          /*
           * No selector at all. "Every issue in the system" is not the question any probe meant
           * to ask, and answering it would put an unbounded listing behind an assertion about
           * one work item's scope. Nothing was established, and that is what is reported.
           */
          return {
            value: unknown(
              'pm.search_issues', at, 'INSUFFICIENT_EVIDENCE',
              'name what to search for: a query, the paths a work item scopes, a capability or '
              + 'a repository. A search with no criterion is a listing of everything, which is '
              + 'not evidence about anything',
              'no search criterion was supplied',
            ),
            excerpt: 'project management: no search criterion',
          };
        }
        const result = await reach('search', criteria, 'pm.search_issues', at);
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
      description: 'Documents attached to a project or work item, or to the paths a work item scopes, '
        + 'as declared intent to be reconciled against code and runtime rather than believed.',
      /*
       * `key` and `scope_paths` are two routes to the same set, and a caller usually holds only
       * one of them. Discovery reaches this at tier 2, where it has a scope and may have no
       * external identity at all — a repository with no project-management key still has
       * decision records worth reconciling — so requiring the key would make the observation
       * unreachable for exactly the repositories that need it most.
       */
      args: { key: STRING_ARG, scope_paths: PATH_LIST_ARG },
      evidenceKind: 'document',
      observationSafe: true,
      handler: async (invocation) => {
        const at = invocation.now.toISOString();
        const criteria = selectors(invocation, ['key', 'scope_paths']);
        if (criteria === null) {
          return {
            value: unknown(
              'pm.list_documents', at, 'INSUFFICIENT_EVIDENCE',
              'name a work item key, or the paths a work item scopes. Listing every document a '
              + 'system holds says nothing about this work',
              'no document selector was supplied',
            ),
            excerpt: 'project management: no document selector',
          };
        }
        const result = await reach('documents', criteria, 'pm.list_documents', at);
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
