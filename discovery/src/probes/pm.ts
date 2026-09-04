import type { Assertion } from '@agentos/contracts';
import { INTENT_KEYS } from '../intent-keys.js';
import { ADAPTERS, OPS } from '../ops.js';
import type { SectionProbe } from '../probe.js';
import { asRecord, asString, records } from '../probe.js';

/**
 * The project-management probe set.
 *
 * One rule governs the whole file, and it is the rule that most often gets broken in systems
 * like this one:
 *
 * > Everything from this source is **claimed intent**, never confirmed capability. An issue in
 * > `Done` is a `FACT` about the ticket's status and at most an `INFERENCE` about the system
 * > ([CONTEXT_MODEL.md](../../../docs/CONTEXT_MODEL.md) section 3).
 *
 * So the ticket's own fields are recorded as facts about the ticket, under keys that say so,
 * and any reading of what they imply about the system is a separate assertion, an
 * `INFERENCE`, with the asymmetry written into its reasoning. Nothing here writes
 * `current_reality`; a ticket's status field is explicitly forbidden from reaching it
 * ([INTENT_AND_WORK_ITEM_RESOLUTION.md](../../../docs/INTENT_AND_WORK_ITEM_RESOLUTION.md)
 * section 5.4).
 *
 * The other rule is the one about access. "This host has no project-management adapter" and
 * "the configured project-management server failed to connect" are different outcomes with
 * different recoveries, and neither of them means the ticket does not exist.
 */

const PM = ADAPTERS.pm;

/** Statuses that claim the work is finished. Claimed, in every case. */
const TERMINAL_CLAIMS = new Set(['DONE', 'CLOSED', 'RESOLVED', 'COMPLETE', 'COMPLETED', 'SHIPPED']);

export function claimsCompletion(status: string | null): boolean {
  return status !== null && TERMINAL_CLAIMS.has(status.trim().toUpperCase());
}

/**
 * Tier-1 orientation: is there project-management access at all?
 *
 * Orientation needs this and not the tickets themselves. Whether AgentOS can see intent
 * changes what resolution may conclude, and it is cheap; reading the backlog is tier 2's job
 * and needs a scope to be worth anything.
 */
export const pmAccessProbe: SectionProbe = {
  name: 'pm.access',
  section: 'intent',
  tier: 1,
  freshnessClass: 'intent',
  run(session, _input) {
    const availability = session.adapterState(PM);
    const observedAt = session.nowIso();
    return Promise.resolve({
      assertions: {
        pm_access: session.derived(
          'pm.access',
          availability,
          ['adapter.availability'],
          'the project-management adapter reports its own availability. NOT_CONFIGURED means '
          + 'nothing is attached and nothing failed; UNAVAILABLE means something is attached '
          + 'and could not be reached. Neither is evidence about any ticket',
          'intent',
          observedAt,
        ),
        pm_reachable: session.derived(
          'pm.access',
          availability.state === 'AVAILABLE',
          ['adapter.availability'],
          'whether intent can be read at all this run. With no project-management access the '
          + 'reconciliation matrix has an INDETERMINATE intent axis, which is a stated '
          + 'limitation rather than an empty backlog',
          'intent',
          observedAt,
        ),
      },
      available: true,
      detail: `the project-management adapter is ${availability.state}`,
      intendedScope: [],
    });
  },
};

/**
 * The ticket behind this work item, read as a ticket.
 *
 * Runs only where the work item carries an external identity, because without one there is
 * nothing to look up and inventing a search would put a guessed ticket into the record.
 */
export const workItemTicketProbe: SectionProbe = {
  name: 'pm.work_item',
  section: 'intent',
  tier: 2,
  freshnessClass: 'intent',
  async run(session, input) {
    const key = input.workItem?.external_identity ?? null;
    const observedAt = session.nowIso();
    if (key === null) {
      return {
        assertions: {
          [INTENT_KEYS.ticket]: session.notComputed(
            'pm.work_item',
            'the work item carries no external identity, so there is no ticket to read. '
            + 'Searching for one by title would put a guessed ticket into the record',
            'resolve the work item against an external identity, or accept that this work has '
            + 'no ticket and that its intent axis is INTENT_ONLY by absence',
            observedAt,
          ),
        },
        available: true,
        detail: 'no external identity to look up',
        intendedScope: [],
      };
    }

    const observation = await session.observe({
      probe: 'pm.work_item',
      adapter: PM,
      op: OPS.pm.readIssue,
      args: { key },
      kind: 'ticket',
      ref: `${PM}.${OPS.pm.readIssue} ${key}`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertions: {
          [INTENT_KEYS.ticket]: session.noAccess('pm.work_item', `ticket ${key}`, observation),
        },
        available: false,
        detail: `ticket ${key} could not be read`,
        intendedScope: [],
      };
    }

    const ticket = asRecord(observation.value);
    if (ticket === null) {
      return {
        assertions: {
          [INTENT_KEYS.ticket]: session.insufficient(
            'pm.work_item',
            `${PM}.${OPS.pm.readIssue} returned no ticket record for ${key}`,
            'check that the external identity resolves in the configured project-management '
            + 'system',
            observation.observedAt,
          ),
        },
        available: true,
        detail: 'the ticket read returned an unusable shape',
        intendedScope: [],
      };
    }

    const evidence = [observation.evidence];
    const status = asString(ticket['status']);
    const assertions: Record<string, Assertion> = {
      [INTENT_KEYS.ticket]: session.observedFact(
        'pm.work_item', ticket, evidence, 'intent', observation.observedAt,
      ),
      /*
       * A fact about the ticket, and only about the ticket. The key is `ticket_status` rather
       * than `status` because `status` alone invites a reader to treat it as the status of the
       * *work*, and it comes from `INTENT_KEYS` so that the probe and the reconciler cannot
       * drift apart about where the ticket's own claim lives.
       */
      [INTENT_KEYS.ticketStatus]: status === null
        ? session.insufficient(
          'pm.work_item',
          `ticket ${key} was read and carries no status field`,
          'check the project-management adapter\'s field mapping',
          observation.observedAt,
        )
        : session.observedFact(
          'pm.work_item', status, evidence, 'intent', observation.observedAt,
        ),
      /*
       * And the reading of it, kept separate and kept weaker. This is the assertion the
       * reconciler keys `CLAIMED_DONE_UNPROVEN` on — the most valuable verdict the matrix
       * produces — and nothing consults it for reality.
       */
      [INTENT_KEYS.claimsCompletion]: session.derived(
        'pm.work_item',
        claimsCompletion(status),
        evidence.map((e) => e.id),
        `the ticket's own status field is ${status ?? 'absent'}. That is authoritative about `
        + 'the ticket and is at most an inference about the system: a ticket in Done with no '
        + 'merged change is CLAIMED_DONE_UNPROVEN, which is why this never reaches '
        + 'current_reality',
        'intent',
        observation.observedAt,
        evidence,
      ),
    };

    const links = await session.observe({
      probe: 'pm.work_item',
      adapter: PM,
      op: OPS.pm.listLinks,
      args: { key },
      kind: 'ticket',
      ref: `${PM}.${OPS.pm.listLinks} ${key}`,
    });
    assertions['linked_changes'] = links.outcome === 'OBSERVED'
      ? session.observedFact(
        'pm.work_item', records(links.value), [links.evidence], 'intent', links.observedAt,
      )
      : session.noAccess('pm.work_item', `links on ticket ${key}`, links);

    return {
      assertions,
      available: true,
      detail: `ticket ${key} read`,
      intendedScope: [],
    };
  },
};

/** The surrounding intent: EPICs, issues and milestones whose scope touches this work. */
export const intentProbe: SectionProbe = {
  name: 'pm.issues',
  section: 'intent',
  tier: 2,
  freshnessClass: 'intent',
  async run(session, input) {
    const observation = await session.observe({
      probe: 'pm.issues',
      adapter: PM,
      op: OPS.pm.searchIssues,
      args: {
        scope_paths: [...input.scope.paths],
        capabilities: [...input.scope.capabilities],
        repositories: [...input.scope.repositories],
      },
      kind: 'query',
      ref: `${PM}.${OPS.pm.searchIssues} over the admitted scope`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertions: {
          [INTENT_KEYS.issues]: session.noAccess('pm.issues', 'the issues touching this scope', observation),
          epics: session.noAccess('pm.issues', 'the epics touching this scope', observation),
        },
        available: false,
        detail: 'intent could not be searched',
        intendedScope: input.scope.paths,
      };
    }
    const issues = records(observation.value);
    const evidence = [observation.evidence];
    return {
      assertions: {
        [INTENT_KEYS.issues]: session.observedFact(
          'pm.issues', issues, evidence, 'intent', observation.observedAt,
        ),
        epics: session.observedFact(
          'pm.issues',
          issues.filter((i) => asString(i['type'])?.toUpperCase() === 'EPIC'),
          evidence,
          'intent',
          observation.observedAt,
        ),
        milestones: session.observedFact(
          'pm.issues',
          [...new Set(issues.map((i) => asString(i['milestone'])).filter((m) => m !== null))],
          evidence,
          'intent',
          observation.observedAt,
        ),
        claimed_capabilities: session.derived(
          'pm.issues',
          issues.map((i) => ({
            key: asString(i['key']),
            title: asString(i['title']),
            claims_completion: claimsCompletion(asString(i['status'])),
          })),
          evidence.map((e) => e.id),
          'capabilities named by intent. Intent naming a capability is one of the three '
          + 'sources the registry is merged from, and a capability that appears only here is '
          + 'itself a finding',
          'intent',
          observation.observedAt,
          evidence,
        ),
      },
      available: true,
      detail: `${issues.length} issue(s) touching the scope`,
      intendedScope: input.scope.paths,
    };
  },
};

/** Decision records and project documentation held outside the repository. */
export const pmDocumentsProbe: SectionProbe = {
  name: 'pm.documents',
  section: 'intent',
  tier: 2,
  freshnessClass: 'intent',
  async run(session, input) {
    const observation = await session.observe({
      probe: 'pm.documents',
      adapter: PM,
      op: OPS.pm.listDocuments,
      args: { scope_paths: [...input.scope.paths] },
      kind: 'document',
      ref: `${PM}.${OPS.pm.listDocuments}`,
    });
    if (observation.outcome !== 'OBSERVED') {
      return {
        assertions: {
          external_documents: session.noAccess(
            'pm.documents', 'project documentation outside the repository', observation,
          ),
        },
        available: false,
        detail: 'external documentation could not be listed',
        intendedScope: input.scope.paths,
      };
    }
    const documents = records(observation.value);
    return {
      assertions: {
        external_documents: session.observedFact(
          'pm.documents', documents, [observation.evidence], 'intent', observation.observedAt,
        ),
        decisions: session.observedFact(
          'pm.documents',
          documents.filter((d) => /decision|adr/i.test(asString(d['kind']) ?? asString(d['title']) ?? '')),
          [observation.evidence],
          'intent',
          observation.observedAt,
        ),
      },
      available: true,
      detail: `${documents.length} document(s)`,
      intendedScope: input.scope.paths,
    };
  },
};

export const PM_TIER_1: readonly SectionProbe[] = [pmAccessProbe];

export const PM_TIER_2: readonly SectionProbe[] = [
  workItemTicketProbe,
  intentProbe,
  pmDocumentsProbe,
];

export const PM_PROBES: readonly SectionProbe[] = [...PM_TIER_1, ...PM_TIER_2];
