import {
  RECONCILIATION_STATES,
  type CurrentReality,
  type ReconciliationState,
} from '@agentos/contracts';

/**
 * Reading the three-way reconciliation. **The kernel does not compute it.**
 *
 * `current_reality.reconciliation` is a Context Package field, and the Context Package is
 * written **only by probes** — so `discovery/` computes the eight-state matrix, at capability
 * level and at work-item level, and the kernel reads what discovery wrote. Two implementations
 * of one rule is one implementation too many, and the codebase already says so: the workflow
 * floor evaluator is shared between the policy loader and the kernel for exactly this reason.
 *
 * What stays here is the *reading*, and it is not nothing. Three things have to hold at this
 * boundary, and each of them is a way the matrix could be quietly destroyed by its consumer:
 *
 * - **An absent field is `INDETERMINATE`, never a negative.** A discovery run that could not
 *   reach the project-management system has not established that nobody intends the work, and
 *   one that could not reach the git host has not established that there is no pull request.
 *   The kernel must not read absence as an answer.
 * - **A value outside the vocabulary is `INDETERMINATE` too.** Failing closed on a state the
 *   contract does not define is the only safe reading of a field the kernel did not compute.
 * - **`CLAIMED_DONE_UNPROVEN` is a finding the run proceeds on, never a reason to stop.** A
 *   ticket in `Done` with no merged change is the most valuable output AgentOS produces, and a
 *   consumer that treated it as "already done" would discard exactly the thing worth having.
 *
 * The decision made *from* the matrix stays kernel work: where AgentOS's own ledger and an
 * external system disagree, `arbitration.ts` applies the authority ordering — the external
 * system wins on its own state, and the discrepancy is itself recorded as a finding.
 */

export interface ReconciliationReading {
  readonly state: ReconciliationState;
  /** False where discovery supplied nothing to read, which is a fact about access. */
  readonly available: boolean;
  readonly detail: string;
}

const KNOWN: ReadonlySet<string> = new Set(RECONCILIATION_STATES);

export function readReconciliation(
  reality: CurrentReality | null | undefined,
): ReconciliationReading {
  if (reality === null || reality === undefined) {
    return {
      state: 'INDETERMINATE',
      available: false,
      detail:
        'no current_reality was assembled, so the three-way reconciliation has not been '
        + 'computed. That is INDETERMINATE and never a negative answer: an unreachable '
        + 'project-management system does not mean nobody intends the work',
    };
  }

  const state: unknown = reality.reconciliation;
  if (typeof state !== 'string' || !KNOWN.has(state)) {
    return {
      state: 'INDETERMINATE',
      available: false,
      detail:
        `current_reality.reconciliation is ${JSON.stringify(state)}, which is not a state the `
        + 'contract defines. The kernel does not compute this field and will not guess at it, '
        + 'so it fails closed to INDETERMINATE',
    };
  }

  return {
    state: state as ReconciliationState,
    available: true,
    detail: describe(state as ReconciliationState),
  };
}

/** What each state means for the run, in the terms the run's reader needs. */
function describe(state: ReconciliationState): string {
  switch (state) {
    case 'ALIGNED':
      return 'intent, code and runtime agree, each read from the source authoritative for it';
    case 'INTENT_ONLY':
      return 'the work is intended and nothing implements it: genuinely new work';
    case 'CODE_ONLY':
      return 'code exists in scope and no intent record accounts for it';
    case 'CODE_NO_RUNTIME':
      return 'an implementation exists and nothing running demonstrates the outcome. Written '
        + 'is not working, and the gap between them is the one AgentOS exists to close rather '
        + 'than to report as closed';
    case 'RUNTIME_NO_CODE':
      return 'the outcome is observable and no implementation in scope accounts for it';
    case 'CLAIMED_DONE_UNPROVEN':
      return 'a source reports this finished and no merged change supports it. A ticket\'s '
        + 'status field is authoritative about the ticket and is at most an INFERENCE about '
        + 'the system, so the run proceeds to establish or refute it rather than treating it '
        + 'as already done — that finding is the most valuable output AgentOS produces';
    case 'CONFLICTING':
      return 'two sources disagree and no rule in the matrix selected a winner. The authority '
        + 'ordering applies as the rule-based step of arbitration: the external system wins on '
        + 'its own state, and the discrepancy is itself recorded as a finding';
    case 'INDETERMINATE':
    default:
      return 'a source could not be reached, so where this work stands could not be '
        + 'established. INDETERMINATE is never a negative answer';
  }
}
