import type {
  AdapterCallContext,
  AdapterRegistry,
  Assertion,
  ConfidenceClass,
  ContextPackage,
  Evidence,
  EvidencePredicate,
} from '@agentos/contracts';
import { inlineEvidence } from './assertions.js';
import { ASSERTION_SECTIONS, REALITY_ELEMENTS } from './package.js';
import { excerptOf } from './redact.js';

/**
 * The assertion-level audit: every `FACT` must replay through its locator.
 *
 * This is WP-6's own exit test, written as code rather than as a procedure, because "we
 * checked the facts" is not a check. It walks the package, samples from every section, and
 * re-executes each sampled `FACT`'s evidence through the adapter registry's replay channel —
 * the same channel the kernel verifies agent evidence through, restricted to
 * `observation_safe` operations so that verification can never become a mutation channel.
 *
 * A `MISMATCH` is the finding that matters. It means the package states something the world
 * does not, which is the one output discovery must never produce, and it is worth more than
 * any number of passing rows.
 */

export type AuditVerdict = 'MATCH' | 'MISMATCH' | 'UNREPLAYABLE' | 'REFUSED' | 'NO_LOCATOR';

export interface AssertionAudit {
  readonly subject: string;
  readonly confidence: ConfidenceClass;
  readonly evidence: string;
  readonly verdict: AuditVerdict;
  readonly detail: string;
}

export interface AuditReport {
  readonly checked: number;
  readonly matches: number;
  readonly mismatches: number;
  readonly unreplayable: number;
  readonly refused: number;
  /** Every section that contained at least one assertion, so a skipped section is visible. */
  readonly sectionsSampled: readonly string[];
  readonly entries: readonly AssertionAudit[];
  /** True when every sampled `FACT` replayed to the value it was recorded with. */
  readonly clean: boolean;
}

export interface AuditOptions {
  /**
   * Sample every nth fact per section, or every one when 1. The exit test samples from every
   * section rather than exhaustively, because the property being checked is that facts are
   * replayable at all — a systematic fabrication shows up in the first sample.
   */
  readonly everyNth?: number;
  /** At least this many per section, where the section has that many. */
  readonly minimumPerSection?: number;
}

/** Whitespace and line-ending normalization only. Nothing that makes two different values equal. */
export function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

/** Re-evaluates a predicate rather than comparing a volatile raw value. */
export function evaluatePredicate(value: unknown, predicate: EvidencePredicate): boolean {
  const subject = readSubject(value, predicate.subject);
  const operand = predicate.operand;
  switch (predicate.operator) {
    case 'eq': return subject === operand;
    case 'ne': return subject !== operand;
    case 'lt': return numeric(subject) < numeric(operand);
    case 'lte': return numeric(subject) <= numeric(operand);
    case 'gt': return numeric(subject) > numeric(operand);
    case 'gte': return numeric(subject) >= numeric(operand);
    case 'contains': return String(subject).includes(String(operand));
    case 'not_contains': return !String(subject).includes(String(operand));
    case 'matches': return new RegExp(String(operand)).test(String(subject));
    default: return false;
  }
}

function numeric(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

function readSubject(value: unknown, subject: string): unknown {
  if (value === null || typeof value !== 'object') return value;
  let node: unknown = value;
  for (const token of subject.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[token];
  }
  return node;
}

function factEvidence(assertion: Assertion): readonly Evidence[] {
  if (assertion.confidence !== 'FACT') return [];
  return inlineEvidence(assertion);
}

/**
 * Replays the sampled facts.
 *
 * `INFERENCE` and `UNKNOWN` are counted and not replayed: an inference's obligation is to name
 * what it derived from, and an unknown's is to say why. Only a `FACT` claims that a locator
 * re-executes to the observed value, and only a `FACT` is held to it.
 */
export async function auditFacts(
  context: ContextPackage,
  registry: AdapterRegistry,
  callContext: AdapterCallContext,
  options: AuditOptions = {},
): Promise<AuditReport> {
  const everyNth = options.everyNth ?? 1;
  const minimum = options.minimumPerSection ?? 1;
  const entries: AssertionAudit[] = [];
  const sectionsSampled: string[] = [];

  const groups: Array<{ readonly name: string; readonly assertions: ReadonlyArray<readonly [string, Assertion]> }> = [];
  for (const section of ASSERTION_SECTIONS) {
    const values = context[section];
    const pairs = Object.entries(values)
      .filter((entry): entry is [string, Assertion] => entry[1] !== undefined)
      .map(([key, assertion]) => [`${section}.${key}`, assertion] as const);
    if (pairs.length > 0) groups.push({ name: section, assertions: pairs });
  }
  const realityPairs = REALITY_ELEMENTS
    .map((element) => [`current_reality.${element}`, context.current_reality[element]] as const);
  groups.push({ name: 'current_reality', assertions: realityPairs });

  for (const group of groups) {
    sectionsSampled.push(group.name);
    const facts = group.assertions.filter(([, assertion]) => assertion.confidence === 'FACT');
    const sampled = facts.filter((_, index) => index % everyNth === 0);
    const chosen = sampled.length >= Math.min(minimum, facts.length)
      ? sampled
      : facts.slice(0, minimum);

    for (const [subject, assertion] of chosen) {
      const evidence = factEvidence(assertion);
      if (evidence.length === 0) {
        entries.push({
          subject,
          confidence: assertion.confidence,
          evidence: '',
          verdict: 'NO_LOCATOR',
          detail: 'a FACT carrying no inline evidence. A FACT with no evidence is an INFERENCE '
            + 'that has not admitted it',
        });
        continue;
      }
      for (const item of evidence) {
        entries.push(await replayOne(subject, assertion, item, registry, callContext));
      }
    }
  }

  const matches = entries.filter((e) => e.verdict === 'MATCH').length;
  const mismatches = entries.filter((e) => e.verdict === 'MISMATCH').length;
  const unreplayable = entries.filter((e) => e.verdict === 'UNREPLAYABLE' || e.verdict === 'NO_LOCATOR').length;
  const refused = entries.filter((e) => e.verdict === 'REFUSED').length;

  return {
    checked: entries.length,
    matches,
    mismatches,
    unreplayable,
    refused,
    sectionsSampled,
    entries,
    clean: mismatches === 0 && unreplayable === 0,
  };
}

async function replayOne(
  subject: string,
  assertion: Assertion,
  evidence: Evidence,
  registry: AdapterRegistry,
  callContext: AdapterCallContext,
): Promise<AssertionAudit> {
  if (evidence.locator.op === null) {
    return {
      subject,
      confidence: assertion.confidence,
      evidence: evidence.id,
      verdict: 'NO_LOCATOR',
      detail: 'the locator names no operation, which marks a genuinely unrepeatable '
        + 'observation and caps the assertion it supports at INFERENCE',
    };
  }

  const result = await registry.replay(evidence.locator, callContext);
  if (result.outcome === 'REFUSED') {
    return {
      subject,
      confidence: assertion.confidence,
      evidence: evidence.id,
      verdict: 'REFUSED',
      detail: result.reason,
    };
  }
  if (result.outcome === 'UNREPLAYABLE') {
    return {
      subject,
      confidence: assertion.confidence,
      evidence: evidence.id,
      verdict: 'UNREPLAYABLE',
      detail: result.reason,
    };
  }

  if (evidence.predicate !== undefined) {
    const holds = evaluatePredicate(result.value, evidence.predicate);
    return {
      subject,
      confidence: assertion.confidence,
      evidence: evidence.id,
      verdict: holds ? 'MATCH' : 'MISMATCH',
      detail: holds
        ? `the predicate the observation satisfied still holds on re-execution`
        : `the predicate ${evidence.predicate.subject} ${evidence.predicate.operator} `
          + `${String(evidence.predicate.operand)} no longer holds`,
    };
  }

  const replayed = normalize(excerptOf(result.value));
  const recorded = normalize(evidence.excerpt);
  if (replayed === recorded) {
    return {
      subject,
      confidence: assertion.confidence,
      evidence: evidence.id,
      verdict: 'MATCH',
      detail: `${evidence.locator.adapter}.${evidence.locator.op} re-executed to the recorded value`,
    };
  }
  /* The adapter's own excerpt is accepted as a second comparison, because a replay channel is
   * entitled to render a value differently from the probe that first read it. What is not
   * accepted is a different value. */
  if (normalize(result.excerpt) === recorded) {
    return {
      subject,
      confidence: assertion.confidence,
      evidence: evidence.id,
      verdict: 'MATCH',
      detail: 'the replay excerpt matches the recorded excerpt',
    };
  }
  return {
    subject,
    confidence: assertion.confidence,
    evidence: evidence.id,
    verdict: 'MISMATCH',
    detail: `${evidence.locator.adapter}.${evidence.locator.op} re-executed to something else. `
      + 'The package states what the world does not',
  };
}
