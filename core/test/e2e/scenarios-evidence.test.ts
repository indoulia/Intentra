import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures as fx, type Evidence, type Event, type HandoffEnvelope } from '@intentra/contracts';
import { README_CONTENT, type ScriptedResponse } from '../doubles.js';
import { scratchWorld, type ScratchWorld } from './world.js';
import { completionVerdict, eventsOf, reading, work, type WorkOutcome } from './rig.js';
import { audit, fileEvidence, investigationGraph, resolution, rootCause } from './envelopes.js';

/**
 * Prompt 7A, defect 1 and the screenshot path, end to end: from the evidence an agent cites,
 * through receipt and replay against a real scratch worktree, to the Definition of Done.
 *
 * Every scenario is the read-only investigation whose control run below ends `COMPLETE`, so a
 * scenario that does not complete differs from it only in the evidence its `MET` rests on.
 * `VERIFIED` is a mechanical match of a quotation against its replay; none of this checks that
 * a genuine quotation supports the claim made with it.
 */

const README = { path: 'README.md', content: README_CONTENT };
const PATHS = ['README.md'];
const GENUINE = fileEvidence('E-01', 'README.md', README_CONTENT);

const worlds: ScratchWorld[] = [];
after(() => { for (const world of worlds) world.destroy(); });

function newWorld(): ScratchWorld {
  const world = scratchWorld([README]);
  worlds.push(world);
  return world;
}

/** A quotation of README.md that the file does not contain. */
function fabricated(id: string): Evidence {
  return fileEvidence(id, 'README.md', 'Intentra restores the namespace after every restart.');
}

/** A screenshot citing the read the Auditor really made, with content nobody can compare. */
function screenshot(id: string, excerpt = 'the restored namespace is shown after the restart'): Evidence {
  return fx.evidence({
    id,
    kind: 'screenshot',
    locator: { adapter: 'repo', op: 'read_file', args: { path: 'README.md' } },
    ref: 'restart.png',
    excerpt,
    reproducible: true,
  });
}

/**
 * The investigation, with the Auditor's criteria 3 and 4 citing `evidence` on both laps a
 * route-back allows. Each lap's envelopes carry their own ids: a reused id is malformed.
 */
function investigation(evidence: readonly Evidence[]): readonly ScriptedResponse[] {
  const [resolutionEnvelope, context, workflow, firstAudit, firstRootCause] = investigationGraph({
    resolution: resolution({
      type: 'INVESTIGATION',
      intent: 'INVESTIGATE',
      title: 'Namespace restoration bug',
      desiredOutcome: 'whether the namespace survives a restart is established',
      scopePaths: PATHS,
      evidence: [GENUINE],
      cites: [],
    }),
    evidence: [GENUINE],
    paths: PATHS,
    cause: 'the restore path is not exercised by any test',
    auditOverrides: {
      evidence: [...evidence],
      dod_verdicts: [3, 4].map((criterion) => fx.criterionVerdict({
        criterion, evidence: evidence.map((e) => e.id),
      })),
    },
  });
  const lap = (n: number): readonly ScriptedResponse[] => [
    reading(PATHS, audit({ evidence, scopeExamined: PATHS, overrides: { envelope_id: `env_audit_${n}` } })),
    reading(PATHS, rootCause({
      evidence: [GENUINE],
      scopeExamined: PATHS,
      cause: 'the restore path is not exercised by any test',
      overrides: { envelope_id: `env_root_cause_${n}` },
    })),
  ];
  return [
    { kind: 'ENVELOPE', envelope: resolutionEnvelope },
    reading(PATHS, context),
    { kind: 'ENVELOPE', envelope: workflow },
    reading(PATHS, firstAudit as HandoffEnvelope),
    reading(PATHS, firstRootCause as HandoffEnvelope),
    ...lap(2),
  ];
}

async function investigate(evidence: readonly Evidence[], viaTransport = false) {
  return work({
    world: newWorld(),
    raw: 'Fix the namespace restoration bug.',
    script: investigation(evidence),
    viaTransport,
  });
}

function firstCriterion3(log: readonly Event[]) {
  const [dod] = eventsOf(log, 'dod_computed');
  assert.ok(dod !== undefined, 'the run reached COMPLETION');
  const criterion = dod.data.criteria.find((c) => c.criterion === 3);
  assert.ok(criterion !== undefined);
  return criterion;
}

function verificationOf(log: readonly Event[], evidenceId: string) {
  const [verification] = eventsOf(log, 'evidence_verification')
    .filter((e) => e.stage === 'AUDIT')
    .map((e) => e.data.results.find((r) => r.evidence_id === evidenceId));
  assert.ok(verification !== undefined, `${evidenceId} was verified at AUDIT`);
  return verification;
}

describe('the control: genuine evidence, replayed and VERIFIED, still completes', () => {
  test('MET on a quotation that matches its replay is COMPLETE', async () => {
    const outcome = await investigate([GENUINE]);
    assert.equal(verificationOf(outcome.log, 'E-01').status, 'VERIFIED');
    assert.equal(firstCriterion3(outcome.log).verdict, 'MET');
    assert.equal(outcome.result.outcome, 'COMPLETE');
    assert.equal(completionVerdict(outcome.log), 'COMPLETE');
  });
});

describe('a fabricated quotation cannot lead to COMPLETE', () => {
  test('one MISMATCH is under the rejection threshold, and the MET it backs is NOT_VALIDATED', async () => {
    const outcome = await investigate([fabricated('F-01')]);
    assert.equal(verificationOf(outcome.log, 'F-01').status, 'MISMATCH');
    assert.ok(
      eventsOf(outcome.log, 'envelope_received').some((e) => e.data.envelope_id === 'env_audit'),
      'the envelope was accepted: one mismatch is a defect, not an untrustworthy witness',
    );
    const criterion = firstCriterion3(outcome.log);
    assert.equal(criterion.verdict, 'NOT_VALIDATED');
    assert.match(criterion.reason ?? '', /F-01 came back MISMATCH/);
    assert.notEqual(outcome.result.outcome, 'COMPLETE');
    assert.equal(completionVerdict(outcome.log), 'INCOMPLETE');
    assert.equal(eventsOf(outcome.log, 'run_ended').length, 1);
  });

  test('through the production substrate over a fake transport, the same', async () => {
    const outcome = await investigate([fabricated('F-01')], true);
    assert.equal(outcome.built.ports.substrate.name, 'scripted-transport', 'the Claude substrate carried it');
    assert.equal(verificationOf(outcome.log, 'F-01').status, 'MISMATCH');
    assert.equal(firstCriterion3(outcome.log).verdict, 'NOT_VALIDATED');
    assert.notEqual(outcome.result.outcome, 'COMPLETE');
    assert.equal(completionVerdict(outcome.log), 'INCOMPLETE');
  });

  test('and the genuine quotation through the fake transport still completes', async () => {
    const outcome = await investigate([GENUINE], true);
    assert.equal(outcome.result.outcome, 'COMPLETE');
  });
});

describe('screenshot evidence cannot independently support MET', () => {
  test('a fabricated screenshot quote citing a real read: provenance VERIFIED, content never compared, not MET', async () => {
    const outcome = await investigate([screenshot('S-01')]);
    const provenance = verificationOf(outcome.log, 'S-01');
    assert.equal(provenance.status, 'VERIFIED', 'the producing call is in the log, which is all that was checked');
    assert.match(provenance.detail, /content is not kernel-verifiable/);

    const criterion = firstCriterion3(outcome.log);
    assert.equal(criterion.verdict, 'NOT_VALIDATED');
    assert.match(criterion.reason ?? '', /S-01 is screenshot evidence, whose content is not kernel-verifiable/);
    assert.notEqual(outcome.result.outcome, 'COMPLETE', 'critical criteria resting on a screenshot alone');
    assert.equal(completionVerdict(outcome.log), 'INCOMPLETE');
  });

  test('the provenance result is kept as recorded: nothing fabricates a content result', async () => {
    const outcome = await investigate([screenshot('S-01')]);
    const workItemId = outcome.result.workItemId ?? '';
    const runId = outcome.result.runId ?? '';
    const persisted = outcome.built.store.getEnvelope(workItemId, runId, 'env_audit');
    const item = persisted?.evidence.find((e) => e.id === 'S-01');
    assert.equal(item?.verification?.status, 'VERIFIED');
    assert.equal(item?.excerpt, 'the restored namespace is shown after the restart');
  });

  test('a screenshot beside a content-verified item: the verified item carries MET, as the contract permits', async () => {
    const outcome = await investigate([screenshot('S-01'), GENUINE]);
    assert.equal(verificationOf(outcome.log, 'S-01').status, 'VERIFIED');
    assert.equal(verificationOf(outcome.log, 'E-01').status, 'VERIFIED');
    assert.equal(firstCriterion3(outcome.log).verdict, 'MET');
    assert.equal(outcome.result.outcome, 'COMPLETE');
  });
});

/** The system prompt the first `stage` dispatch was opened with, through the fake transport. */
function briefing(outcome: WorkOutcome, stage: string): string {
  const found = outcome.transport?.briefed.find((b) => b.stage === stage);
  assert.ok(found !== undefined, `a ${stage} dispatch went through the transport`);
  return found.systemPrompt;
}

/** The kinds a system prompt says `criterion` accepts, read as the agent reads them. */
function shownKinds(systemPrompt: string, criterion: number): readonly string[] | null {
  const line = new RegExp(`- criterion ${criterion} \\([^)]*\\): accepts ([a-z, ]+?)(?: in |[.;])`).exec(systemPrompt);
  return line?.[1]?.split(', ') ?? null;
}

/** A genuine quotation of README.md, labelled as a kind it is not. */
function relabelled(id: string, kind: Evidence['kind']): Evidence {
  return { ...fileEvidence(id, 'README.md', README_CONTENT), kind };
}

describe('the agent is told the kinds the Definition of Done enforces, from the same profile (Prompt 9)', () => {
  test('the Auditor is shown the kinds of the profile the run completes against, and accepted evidence carries MET', async () => {
    const outcome = await investigate([GENUINE], true);
    const [dod] = eventsOf(outcome.log, 'dod_computed');
    assert.ok(dod !== undefined, 'the run reached COMPLETION');
    const profile = outcome.built.policies.profile(dod.data.profile_id);
    const prompt = briefing(outcome, 'AUDIT');
    assert.match(prompt, new RegExp(`judged against DoD profile ${dod.data.profile_id}\\b`));
    for (const criterion of [3, 4]) {
      const shown = shownKinds(prompt, criterion);
      assert.deepEqual(shown, profile.evidence_requirements[String(criterion)]?.kinds);
      assert.ok(shown?.includes(GENUINE.kind), `${GENUINE.kind} is shown as accepted for criterion ${criterion}`);
    }
    assert.equal(firstCriterion3(outcome.log).verdict, 'MET');
    assert.equal(outcome.result.outcome, 'COMPLETE');
  });

  test('evidence of a kind the prompt did not list is refused, though its content replays VERIFIED', async () => {
    const outcome = await investigate([relabelled('R-01', 'http')], true);
    assert.ok(
      !(shownKinds(briefing(outcome, 'AUDIT'), 3) ?? ['http']).includes('http'),
      'the Auditor was told http does not count for criterion 3',
    );
    assert.equal(verificationOf(outcome.log, 'R-01').status, 'VERIFIED');
    const criterion = firstCriterion3(outcome.log);
    assert.equal(criterion.verdict, 'NOT_VALIDATED');
    assert.match(criterion.reason ?? '', /R-01 is http evidence, which profile \S+ does not accept for criterion 3/);
    assert.notEqual(outcome.result.outcome, 'COMPLETE');
  });

  test('a screenshot is described as unable to carry MET alone, and the kernel still refuses it alone', async () => {
    const outcome = await investigate([screenshot('S-01')], true);
    assert.match(briefing(outcome, 'AUDIT'), /screenshot evidence is VERIFIED when [^\n]*not what the item shows/);
    assert.equal(verificationOf(outcome.log, 'S-01').status, 'VERIFIED');
    assert.equal(firstCriterion3(outcome.log).verdict, 'NOT_VALIDATED');
    assert.notEqual(outcome.result.outcome, 'COMPLETE');
  });

  test('the context dispatch, which runs before a profile is chosen, is shown every candidate profile\'s kinds', async () => {
    const outcome = await investigate([GENUINE], true);
    const prompt = briefing(outcome, 'CONTEXT_DISCOVERY');
    assert.match(prompt, /No DoD profile is bound to this dispatch yet/);
    const including = outcome.built.policies.dod.profiles.filter((p) => p.criteria.includes(1));
    assert.ok(including.length > 0);
    for (const profile of including) {
      assert.deepEqual(shownKinds(prompt, 1), profile.evidence_requirements['1']?.kinds);
    }
  });
});
