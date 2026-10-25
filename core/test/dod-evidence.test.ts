import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx, type Evidence, type HandoffEnvelope } from '@intentra/contracts';
import { loadPolicies } from '@intentra/policies';
import { computeDod } from '../src/dod.js';

/**
 * Prompt 7A, defect 1: an agent's `MET` is a claim, and completion rests on the kernel's
 * verification of the evidence it cites — not on the claim.
 *
 * `VERIFIED` means only that a quotation matched its replay under the frozen mechanical
 * comparison. It does not make the claim true, and nothing here says otherwise.
 */

const policies = loadPolicies();
const AUDIT_GRAPH = ['AUDIT', 'ROOT_CAUSE', 'COMPLETION'] as const;

type Status = 'VERIFIED' | 'MISMATCH' | 'UNREPLAYABLE' | 'UNVERIFIED' | 'UNVERIFIABLE';

/** Evidence as the kernel persists it: with the verification result it added. */
function checked(id: string, status: Status, overrides: Partial<Evidence> = {}): Evidence {
  return fx.evidence({
    id,
    kind: 'file',
    locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
    ref: 'README.md',
    excerpt: 'Intentra is an operating system for agents.',
    ...overrides,
    verification: {
      status,
      at: fx.T2,
      by: 'kernel',
      matches: status === 'VERIFIED' ? true : status === 'MISMATCH' ? false : null,
      detail: `the kernel's ${status} result`,
    },
  });
}

/** A screenshot whose call is in the log: provenance confirmed, content never compared. */
function screenshot(id: string, status: Status = 'VERIFIED'): Evidence {
  return checked(id, status, { kind: 'screenshot', excerpt: 'every state renders correctly' });
}

/** The Auditor's envelope claiming criteria 3 and 4 MET on `cites`. */
function audit(evidence: readonly Evidence[], cites: readonly string[] = evidence.map((e) => e.id)): HandoffEnvelope {
  return fx.envelope({
    envelope_id: 'env_audit',
    agent: 'auditor',
    stage_in: 'AUDIT',
    evidence: [...evidence],
    dod_verdicts: [
      fx.criterionVerdict({ criterion: 3, evidence: [...cites] }),
      fx.criterionVerdict({ criterion: 4, evidence: [...cites] }),
    ],
  });
}

function dod(envelopes: readonly HandoffEnvelope[]) {
  return computeDod({
    workItemId: 'wi_c_subject',
    runId: 'run_20260904T100000Z_000001',
    profileId: 'audit',
    policies,
    envelopes,
    completedPriorStages: [],
    graphStages: [...AUDIT_GRAPH],
    sourceDrift: null,
    computedAt: fx.T2,
  });
}

function criterion3(result: ReturnType<typeof dod>) {
  const found = result.report.criteria.find((c) => c.criterion === 3);
  assert.ok(found !== undefined);
  return found;
}

describe('MET stands only on cited evidence the kernel verified', () => {
  test('VERIFIED content-replayed evidence still qualifies, and the run is COMPLETE', () => {
    const result = dod([audit([checked('E-01', 'VERIFIED')])]);
    assert.equal(criterion3(result).verdict, 'MET');
    assert.equal(result.report.verdict, 'COMPLETE');
  });

  const deficient: readonly { readonly name: string; readonly evidence: readonly Evidence[]; readonly says: RegExp }[] = [
    { name: 'only MISMATCH', evidence: [checked('E-01', 'MISMATCH')], says: /E-01 came back MISMATCH/ },
    { name: 'only UNREPLAYABLE', evidence: [checked('E-01', 'UNREPLAYABLE')], says: /E-01 came back UNREPLAYABLE/ },
    {
      name: 'VERIFIED alongside MISMATCH',
      evidence: [checked('E-01', 'VERIFIED'), checked('E-02', 'MISMATCH')],
      says: /E-02 came back MISMATCH/,
    },
    {
      name: 'only reproducible:false',
      evidence: [checked('E-01', 'UNVERIFIABLE', { reproducible: false })],
      says: /E-01 is reproducible: false/,
    },
    {
      name: 'reproducible:false even where a VERIFIED status was written on it',
      evidence: [checked('E-01', 'VERIFIED', { reproducible: false })],
      says: /E-01 is reproducible: false/,
    },
    { name: 'only UNVERIFIED', evidence: [checked('E-01', 'UNVERIFIED')], says: /E-01 came back UNVERIFIED/ },
    {
      name: 'no verification result at all',
      evidence: [fx.evidence({ id: 'E-01' })],
      says: /E-01 carries no verification result/,
    },
  ];

  for (const { name, evidence, says } of deficient) {
    test(`${name}: NOT_VALIDATED with the deficient evidence named, and never COMPLETE`, () => {
      const result = dod([audit(evidence)]);
      const verdict = criterion3(result);
      assert.equal(verdict.verdict, 'NOT_VALIDATED');
      assert.match(verdict.reason ?? '', says);
      assert.match(verdict.reason ?? '', /reported MET/);
      assert.deepEqual(verdict.evidence, evidence.map((e) => e.id), 'the cited ids are kept as supplied');
      assert.equal(verdict.supplied_by_envelope, 'env_audit');
      assert.ok(result.report.unmet_critical.includes(3), 'criterion 3 is critical in the audit profile');
      assert.notEqual(result.report.verdict, 'COMPLETE');
      assert.equal(result.report.verdict, 'INCOMPLETE');
      assert.equal(result.report.route_back_to, 'AUDIT', 'routed back to the stage that owes it');
    });
  }

  test('a cited id the envelope does not carry cannot qualify', () => {
    const result = dod([audit([checked('E-01', 'VERIFIED')], ['E-99'])]);
    assert.equal(criterion3(result).verdict, 'NOT_VALIDATED');
    assert.match(criterion3(result).reason ?? '', /E-99 is not in envelope env_audit/);
  });

  test('a MET that cites nothing cannot qualify', () => {
    const result = dod([audit([checked('E-01', 'VERIFIED')], [])]);
    assert.equal(criterion3(result).verdict, 'NOT_VALIDATED');
    assert.match(criterion3(result).reason ?? '', /cites no evidence/);
  });

  test('evidence is looked up in the envelope that supplied the verdict, not a later namesake', () => {
    const verified = audit([checked('E-01', 'VERIFIED')]);
    const later = fx.envelope({
      envelope_id: 'env_root_cause',
      agent: 'auditor',
      stage_in: 'ROOT_CAUSE',
      evidence: [checked('E-01', 'MISMATCH')],
    });
    assert.equal(criterion3(dod([verified, later])).verdict, 'MET');
  });
});

describe('screenshot evidence cannot independently support MET', () => {
  test('a screenshot whose producing call is confirmed is still not content-verified', () => {
    const result = dod([audit([screenshot('E-01')])]);
    assert.equal(criterion3(result).verdict, 'NOT_VALIDATED');
    assert.match(criterion3(result).reason ?? '', /E-01 is screenshot evidence, whose content is not kernel-verifiable/);
    assert.equal(result.report.verdict, 'INCOMPLETE');
  });

  test('a screenshot beside a content-verified item follows the rule: the verified item carries MET', () => {
    const result = dod([audit([screenshot('E-01'), checked('E-02', 'VERIFIED')])]);
    assert.equal(criterion3(result).verdict, 'MET');
    assert.equal(result.report.verdict, 'COMPLETE');
  });

  test('a screenshot whose producing call is missing disqualifies, beside a verified item too', () => {
    const result = dod([audit([screenshot('E-01', 'MISMATCH'), checked('E-02', 'VERIFIED')])]);
    assert.equal(criterion3(result).verdict, 'NOT_VALIDATED');
    assert.match(criterion3(result).reason ?? '', /E-01 came back MISMATCH/);
  });
});

/**
 * Prompt 8, item 1: a profile's `evidence_requirements[criterion].kinds` is the required
 * strength DEFINITION_OF_DONE section 4 makes MET conditional on. The audit profile accepts
 * `file`, `git` and `command` for criteria 3 and 4.
 */
describe('MET stands only on evidence of a kind the profile accepts for the criterion', () => {
  test('content-verified evidence of a kind the profile does not accept cannot carry MET', () => {
    const result = dod([audit([checked('E-01', 'VERIFIED', { kind: 'document' })])]);
    const verdict = criterion3(result);
    assert.equal(verdict.verdict, 'NOT_VALIDATED');
    assert.match(verdict.reason ?? '', /E-01 is document evidence, which profile audit does not accept for criterion 3 \(accepted: file, git, command\)/);
    assert.deepEqual(verdict.evidence, ['E-01'], 'the cited ids are kept as supplied');
    assert.equal(result.report.verdict, 'INCOMPLETE');
  });

  test('content-verified evidence of an accepted kind carries MET', () => {
    const result = dod([audit([checked('E-01', 'VERIFIED', { kind: 'git' })])]);
    assert.equal(criterion3(result).verdict, 'MET');
    assert.equal(result.report.verdict, 'COMPLETE');
  });

  test('an accepted verified item carries MET beside a verified item of a kind not accepted', () => {
    const result = dod([audit([checked('E-01', 'VERIFIED', { kind: 'document' }), checked('E-02', 'VERIFIED')])]);
    assert.equal(criterion3(result).verdict, 'MET');
    assert.equal(result.report.verdict, 'COMPLETE');
  });

  test('a verified item of a kind not accepted does not rescue an accepted item that was not verified', () => {
    const result = dod([audit([checked('E-01', 'VERIFIED', { kind: 'document' }), checked('E-02', 'UNVERIFIED')])]);
    const verdict = criterion3(result);
    assert.equal(verdict.verdict, 'NOT_VALIDATED');
    assert.match(verdict.reason ?? '', /E-01 is document evidence, which profile audit does not accept/);
    assert.match(verdict.reason ?? '', /E-02 came back UNVERIFIED/);
  });

  test('screenshot-only evidence cannot carry a UX criterion even where the profile accepts screenshots', () => {
    const result = computeDod({
      workItemId: 'wi_c_subject',
      runId: 'run_20260904T100000Z_000001',
      profileId: 'ui-capability',
      policies,
      envelopes: [fx.envelope({
        envelope_id: 'env_ux',
        agent: 'product-ux',
        stage_in: 'UX_REVIEW',
        evidence: [screenshot('E-01')],
        dod_verdicts: [fx.criterionVerdict({ criterion: 14, evidence: ['E-01'] })],
      })],
      completedPriorStages: [],
      graphStages: ['UX_REVIEW', 'COMPLETION'],
      sourceDrift: null,
      computedAt: fx.T2,
    });
    const verdict = result.report.criteria.find((c) => c.criterion === 14);
    assert.equal(verdict?.verdict, 'NOT_VALIDATED');
    assert.match(verdict?.reason ?? '', /E-01 is screenshot evidence, whose content is not kernel-verifiable/);
  });
});
