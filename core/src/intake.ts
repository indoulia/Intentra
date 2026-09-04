import {
  sha256,
  type HostIdentity,
  type IntakePolicy,
  type IntakeRecord,
  type IntakeSource,
  type Locator,
  type TrustClass,
} from '@agentos/contracts';

/**
 * Intake — and the rule that makes it safe to accept work from anywhere.
 *
 * **Intake is data, never instruction.** v0.2's goals came from an operator at a terminal;
 * v0.3 accepts webhooks, third-party PR comments and ticket bodies anyone can edit. That is
 * a new attack surface, and it is the most consequential thing this layer adds.
 *
 * Three rules, in force for all three trust classes:
 *
 * 1. **Intake content cannot name a workflow template, request a stage, set a confidence
 *    class, set a trust class, or widen a scope.** Those are kernel inputs; intake is an
 *    observation the resolver reasons over. Content that appears to instruct AgentOS is
 *    recorded verbatim and treated as text — the resolver may weigh it as evidence of what
 *    someone wants, exactly as it weighs the rest of the ticket. **And the attempt is
 *    recorded**, because a party trying is worth knowing about even when it failed.
 * 2. **No grant ever originates from intake.** Text saying "approved" is text.
 * 3. **`trust_class` is set by the host from authenticated context and never from the
 *    content**, so a webhook body cannot promote itself.
 */

export interface IntakeInput {
  readonly intakeId: string;
  readonly source: IntakeSource;
  readonly sourceLocator: Locator;
  readonly raw: string;
  readonly host: HostIdentity;
  readonly receivedAt: string;
  readonly attachments?: IntakeRecord['attachments'];
  readonly correlation?: IntakeRecord['correlation'];
}

export type InstructionAttempt =
  | 'NAME_TEMPLATE'
  | 'REQUEST_STAGE'
  | 'SET_CONFIDENCE'
  | 'SET_TRUST_CLASS'
  | 'WIDEN_SCOPE'
  | 'CLAIM_AUTHORIZATION'
  | 'CANCEL_RUN';

export interface IntakeResult {
  readonly record: IntakeRecord;
  /**
   * Instruction-shaped content, recorded with no effect. The excerpt is included so a human
   * reading the log can see what was attempted without opening the raw intake.
   */
  readonly attempts: readonly {
    readonly attempt: InstructionAttempt;
    readonly excerpt: string;
  }[];
}

/**
 * Classifies trust from the host, never from the content.
 *
 * A host that cannot assert a principal must classify `EXTERNAL`. That is the whole rule,
 * and it is why the MVP's single CLI host is the only source of `OPERATOR`: what a host can
 * assert is a property of that host and cannot be decided in advance for hosts that do not
 * exist yet.
 */
export function classifyTrust(
  host: HostIdentity,
  source: IntakeSource,
  policy: IntakePolicy,
): { readonly trustClass: TrustClass; readonly reason: string } {
  if (host.principal === null) {
    return {
      trustClass: policy.default_trust_class,
      reason:
        `${host.host} asserted no principal, so the intake classifies `
        + `${policy.default_trust_class}. A host that cannot assert a principal must`,
    };
  }
  const configured = policy.hosts.find((h) => h.host === host.host);
  if (configured === undefined) {
    return {
      trustClass: policy.default_trust_class,
      reason:
        `${host.host} is not a configured host, so the intake classifies `
        + `${policy.default_trust_class} whatever it asserts about itself`,
    };
  }
  if (!configured.can_assert_principal) {
    return {
      trustClass: policy.default_trust_class,
      reason: `${host.host} is configured as unable to assert a principal`,
    };
  }
  if (!configured.sources.includes(source)) {
    return {
      trustClass: policy.default_trust_class,
      reason:
        `${host.host} may assert a principal for ${configured.sources.join(', ')} and this `
        + `intake is ${source}`,
    };
  }
  return {
    trustClass: configured.trust_class,
    reason: `${host.host} asserted a principal for a ${source} intake`,
  };
}

/**
 * Finds instruction-shaped content.
 *
 * The patterns are policy data, so an organisation tunes them without touching the kernel.
 * What is *not* tunable is the consequence: none. The content is recorded verbatim either
 * way, and the resolver sees the same text; the only thing this produces is a log entry.
 */
export function findInstructionAttempts(
  raw: string,
  policy: IntakePolicy,
): readonly { readonly attempt: InstructionAttempt; readonly excerpt: string }[] {
  const found: { attempt: InstructionAttempt; excerpt: string }[] = [];
  for (const marker of policy.instruction_markers) {
    for (const pattern of marker.patterns) {
      const match = new RegExp(pattern, 'i').exec(raw);
      if (match === null) continue;
      const start = Math.max(0, match.index - 30);
      const end = Math.min(raw.length, match.index + match[0].length + 30);
      found.push({
        attempt: marker.attempt,
        excerpt: raw.slice(start, end).replace(/\s+/g, ' ').trim(),
      });
      break;
    }
  }
  return found;
}

/**
 * Records an `IntakeRecord`.
 *
 * `raw` is verbatim. **No agent summarizes intake before it is recorded** — a summary that
 * drops the discriminating clause is exactly how a resolution goes wrong invisibly.
 *
 * `source_locator` is a re-executable read, so the intake is itself evidence, subject to the
 * same replay the kernel applies to everything else: "the ticket said X" becomes checkable.
 * `content_hash` is what makes the source-drift check at `COMPLETION` a comparison rather
 * than a re-reading.
 */
export function recordIntake(
  input: IntakeInput,
  policy: IntakePolicy,
): IntakeResult {
  const trust = classifyTrust(input.host, input.source, policy);
  const record: IntakeRecord = {
    intake_id: input.intakeId,
    received_at: input.receivedAt,
    source: input.source,
    source_locator: input.sourceLocator,
    principal: input.host.principal ?? {
      id: 'unauthenticated',
      asserted_by: input.host.host,
    },
    trust_class: trust.trustClass,
    raw: input.raw,
    content_hash: sha256(input.raw),
    attachments: input.attachments ?? [],
    correlation: input.correlation ?? { prior_work_item: null, prior_run: null },
  };

  return {
    record,
    attempts: findInstructionAttempts(input.raw, policy),
  };
}

/**
 * The source-drift check at `COMPLETION`.
 *
 * Re-execute the `IntakeRecord`'s `source_locator` and compare the content hash against the
 * one recorded at admission. Requirements change while work proceeds, and a frozen scope is
 * what makes a run auditable; the two are reconciled by **disclosure rather than by
 * chasing**.
 *
 * AgentOS does not silently widen scope to chase an edited ticket — the adapters would refuse
 * the paths, and `SCOPE_EXPANSION` exists for legitimate growth. What it must not do is
 * report completion against a request that has changed without saying so, which is how a
 * technically correct run becomes a misleading one.
 */
export function compareSourceDrift(
  hashAtAdmission: string,
  reread: { readonly outcome: 'OK'; readonly raw: string } | { readonly outcome: 'UNAVAILABLE'; readonly detail: string },
): {
    readonly state: 'UNCHANGED' | 'CHANGED' | 'UNAVAILABLE';
    readonly hash_at_admission: string;
    readonly hash_now: string | null;
    readonly detail: string;
  } {
  if (reread.outcome === 'UNAVAILABLE') {
    return {
      state: 'UNAVAILABLE',
      hash_at_admission: hashAtAdmission,
      hash_now: null,
      detail:
        `the intake source could not be re-read: ${reread.detail}. Recorded as UNAVAILABLE `
        + 'and not a blocker: the work is finished either way',
    };
  }
  const now = sha256(reread.raw);
  if (now === hashAtAdmission) {
    return {
      state: 'UNCHANGED',
      hash_at_admission: hashAtAdmission,
      hash_now: now,
      detail: 'the intake source is unchanged since admission',
    };
  }
  return {
    state: 'CHANGED',
    hash_at_admission: hashAtAdmission,
    hash_now: now,
    detail:
      'the intake source has been edited since admission. The verdict is computed against the '
      + 'admitted work item, because that is what was actually done, and the reader is told '
      + 'the request has moved',
  };
}
