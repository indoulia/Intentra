/**
 * The `intent` section keys the project-management probe writes and the reconciler reads.
 *
 * They are named here, once, and imported by both sides rather than spelled out in each.
 *
 * The reason is a specific near-miss. The reconciler keys `CLAIMED_DONE_UNPROVEN` on
 * `claims_completion`, and that verdict — "somebody marked this Done and nothing demonstrates
 * it" — is the single most valuable output the matrix produces. If the probe and the reconciler
 * ever disagree about where the claim lives, the verdict does not fail loudly: it quietly
 * degrades to `INTENT_ONLY` and nobody notices that the most interesting finding in the run
 * stopped being computed. A shared constant makes that drift a compile error instead of a
 * silence.
 */
export const INTENT_KEYS = {
  /** The ticket record itself, as read. A fact about the ticket. */
  ticket: 'work_item_ticket',
  /** The ticket's own status field, verbatim. Authoritative about the ticket and nothing else. */
  ticketStatus: 'ticket_status',
  /**
   * Whether that status claims the work is finished. An `INFERENCE`, deliberately: a ticket in
   * `Done` is a fact about the ticket and at most an inference about the system.
   */
  claimsCompletion: 'claims_completion',
  /** Issues whose scope touches this work, from the surrounding backlog. */
  issues: 'issues',
} as const;

export type IntentKey = (typeof INTENT_KEYS)[keyof typeof INTENT_KEYS];
