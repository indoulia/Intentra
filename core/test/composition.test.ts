import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connector } from '@agentos/adapters';
import { ResourceUnreachableError } from '@agentos/adapters';
import {
  admitIntake,
  buildKernel,
  intakeRereaderFor,
  intakeTextOf,
  type BuiltKernel,
} from '../src/composition/index.js';
import { sourceLocatorFor } from '../src/cli/main.js';
import { compareSourceDrift, recordIntake } from '../src/intake.js';

/**
 * The composition root, at the seam where the intake becomes a hash.
 *
 * D4 lived entirely here. `WORKFLOW_STATE_MACHINE` section 7.4 says `COMPLETION` re-executes
 * the intake locator and compares content hashes — unchanged says nothing, changed is
 * disclosed with the diff and the verdict is still computed against the admitted work item,
 * unreachable is `UNAVAILABLE` and is not a blocker. That comparison is only worth making if
 * the two hashes are over the same thing, and for a project-management intake they were not:
 * the hash was over the ticket key the operator typed and the re-read was over the ticket body
 * — which, had the re-read produced any text at all, would have said `CHANGED` on every run.
 *
 * These tests drive the two functions the kernel actually calls at `COMPLETION`
 * (`kernel.ts`: `recordIntake` at admission, `compareSourceDrift` against `intakeRereaderFor`)
 * in the same order and with the same inputs the CLI supplies, which is the smallest thing
 * that can tell the two halves of the fix apart.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface World {
  readonly repositoryPath: string;
  readonly stateRoot: string;
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), 'agentos-composition-'));
  roots.push(root);
  const repositoryPath = join(root, 'repo');
  const stateRoot = join(root, 'state');
  mkdirSync(repositoryPath, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(join(repositoryPath, 'README.md'), '# subject\n', 'utf8');
  const git = (args: readonly string[]): void => {
    execFileSync('git', [...args], { cwd: repositoryPath, stdio: 'ignore' });
  };
  git(['init', '--quiet', '--initial-branch', 'main']);
  git(['config', 'user.email', 'composition@agentos.test']);
  git(['config', 'user.name', 'AgentOS composition suite']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '--all']);
  git(['commit', '--quiet', '--message', 'the repository as the test finds it']);
  return { repositoryPath, stateRoot };
}

/** A project-management system whose one ticket the test can edit under the run. */
function editablePm(issue: { current: Readonly<Record<string, unknown>> }): Connector {
  return {
    id: 'pm.scripted',
    configured: true,
    fetch: (resource) => {
      if (resource === 'ping') return Promise.resolve({ ok: true });
      if (resource === 'children' || resource === 'links' || resource === 'documents') {
        return Promise.resolve([]);
      }
      if (resource === 'issues' || resource === 'search') return Promise.resolve([issue.current]);
      return Promise.resolve(issue.current);
    },
  };
}

function unreachablePm(): Connector {
  return {
    id: 'pm.scripted',
    configured: true,
    fetch: () => Promise.reject(
      new ResourceUnreachableError('INV-7', 'the project-management host refused the connection'),
    ),
  };
}

async function kernelFor(
  place: World,
  raw: string,
  source: 'NATURAL_LANGUAGE' | 'PROJECT_MANAGEMENT',
  projectManagement: Connector | null,
): Promise<BuiltKernel> {
  return buildKernel({
    stateRoot: place.stateRoot,
    repositoryPath: place.repositoryPath,
    intake: { source, raw, received_at: new Date().toISOString() },
    env: {},
    projectManagement,
  });
}

/**
 * Admission and the `COMPLETION` drift check, exactly as the kernel sequences them.
 *
 * `recordIntake` computes `content_hash` over the raw the caller admits; `compareSourceDrift`
 * compares it against the locator re-read. Nothing else stands between them, which is why a
 * mismatch between the two is invisible to every test that does not run both.
 */
async function driftAcross(
  built: BuiltKernel,
  source: 'NATURAL_LANGUAGE' | 'PROJECT_MANAGEMENT',
  typed: string,
): Promise<{
    readonly admittedRaw: string;
    readonly drift: ReturnType<typeof compareSourceDrift>;
    readonly rereadAt: () => Promise<ReturnType<typeof compareSourceDrift>>;
  }> {
  const admitted = await admitIntake(built, sourceLocatorFor(source, typed), typed);
  const { record } = recordIntake(
    {
      intakeId: 'in_0001',
      source,
      sourceLocator: admitted.locator,
      raw: admitted.raw,
      host: built.ports.host,
      receivedAt: new Date().toISOString(),
    },
    built.policies.intake,
  );
  const reread = async (): Promise<ReturnType<typeof compareSourceDrift>> => compareSourceDrift(
    record.content_hash,
    await intakeRereaderFor(built)(record.source_locator),
  );
  return { admittedRaw: record.raw, drift: await reread(), rereadAt: reread };
}

/* ================================================== the text of an intake read ==== */

describe('an intake read becomes text whatever shape the adapter answered with', () => {
  test('a string and a {raw} record are the two shapes that already worked', () => {
    assert.equal(intakeTextOf('Fix typo in README.'), 'Fix typo in README.');
    assert.equal(intakeTextOf({ raw: 'Fix typo in README.' }), 'Fix typo in README.');
  });

  test('a ticket record becomes text, which is the first half of D4', () => {
    const text = intakeTextOf({ key: 'INV-7', summary: 'Rename the widget', status: 'Open' });
    assert.equal(text, 'key: INV-7\nstatus: Open\nsummary: Rename the widget');
  });

  test('two reads of one ticket agree whatever order the connector serialized it in', () => {
    assert.equal(
      intakeTextOf({ status: 'Open', key: 'INV-7' }),
      intakeTextOf({ key: 'INV-7', status: 'Open' }),
      'the hash is over the ticket, not over a key order',
    );
  });

  test('the assertion envelope is dropped, because observed_at moves on every read', () => {
    const first = intakeTextOf({
      value: { key: 'INV-7', status: 'Open' },
      confidence: 'FACT',
      observed_at: '2026-01-01T00:00:00.000Z',
    });
    const second = intakeTextOf({
      value: { key: 'INV-7', status: 'Open' },
      confidence: 'FACT',
      observed_at: '2026-06-30T12:00:00.000Z',
    });
    assert.equal(first, 'key: INV-7\nstatus: Open');
    assert.equal(second, first, 'a re-read minutes later is not an edited ticket');
  });

  test('an answer carrying nothing is null, and UNAVAILABLE rather than an invented hash', () => {
    assert.equal(intakeTextOf({}), null);
    assert.equal(intakeTextOf(''), null);
    assert.equal(intakeTextOf(null), null);
  });
});

/* ============================================ source drift, admission to COMPLETION ==== */

describe('source drift for a project-management intake', () => {
  test('an unchanged ticket reports UNCHANGED', async () => {
    const issue = { current: { key: 'INV-7', summary: 'Rename the widget', status: 'Open' } };
    const built = await kernelFor(world(), 'INV-7', 'PROJECT_MANAGEMENT', editablePm(issue));
    const { admittedRaw, drift } = await driftAcross(built, 'PROJECT_MANAGEMENT', 'INV-7');

    assert.equal(drift.state, 'UNCHANGED');
    assert.equal(drift.hash_now, drift.hash_at_admission);
    assert.match(
      admittedRaw,
      /summary: Rename the widget/,
      'the run is admitted against the ticket, not against the key that points at it. The '
      + 'operator naming a key is a pointer at the request and not the request',
    );
  });

  test('an edited ticket reports CHANGED, and the admitted work item is unchanged by it', async () => {
    const issue = { current: { key: 'INV-7', summary: 'Rename the widget', status: 'Open' } };
    const built = await kernelFor(world(), 'INV-7', 'PROJECT_MANAGEMENT', editablePm(issue));
    const { admittedRaw, rereadAt } = await driftAcross(built, 'PROJECT_MANAGEMENT', 'INV-7');

    issue.current = { key: 'INV-7', summary: 'Rename the widget and the gadget', status: 'Open' };
    const drift = await rereadAt();

    assert.equal(drift.state, 'CHANGED');
    assert.notEqual(drift.hash_now, drift.hash_at_admission);
    assert.match(
      admittedRaw,
      /summary: Rename the widget$/m,
      'AgentOS discloses the drift and does not chase it: what was admitted is what the '
      + 'verdict is computed against, and the edit is disclosed rather than absorbed',
    );
    assert.doesNotMatch(admittedRaw, /gadget/);
  });

  test('an unreachable ticket reports UNAVAILABLE and is not a blocker', async () => {
    const built = await kernelFor(world(), 'INV-7', 'PROJECT_MANAGEMENT', unreachablePm());
    const { admittedRaw, drift } = await driftAcross(built, 'PROJECT_MANAGEMENT', 'INV-7');

    assert.equal(drift.state, 'UNAVAILABLE');
    assert.equal(drift.hash_now, null, 'no hash is invented for a read that did not happen');
    assert.match(drift.detail, /not a blocker/);
    assert.equal(
      admittedRaw,
      'INV-7',
      'a source that could not be dereferenced at admission is admitted on what the operator '
      + 'typed, and its locator is stripped so COMPLETION says UNAVAILABLE rather than '
      + 'comparing a key against a body and calling the difference an edit',
    );
  });

  test('a source unreadable at admission carries its reason out, and strips its locator', async () => {
    const built = await kernelFor(world(), 'INV-7', 'PROJECT_MANAGEMENT', unreachablePm());
    const admitted = await admitIntake(
      built, sourceLocatorFor('PROJECT_MANAGEMENT', 'INV-7'), 'INV-7',
    );
    assert.equal(admitted.locator.adapter, 'pm');
    assert.equal(admitted.locator.op, null);
    assert.ok(admitted.unresolved !== null && admitted.unresolved.length > 0);
  });
});

describe('source drift for a natural-language intake still works exactly as it did', () => {
  test('the invocation is its own source, and re-reading it reports UNCHANGED', async () => {
    const built = await kernelFor(world(), 'Fix typo in README.', 'NATURAL_LANGUAGE', null);
    const { admittedRaw, drift } = await driftAcross(
      built, 'NATURAL_LANGUAGE', 'Fix typo in README.',
    );

    assert.equal(admittedRaw, 'Fix typo in README.', 'the typed request is not dereferenced');
    assert.equal(drift.state, 'UNCHANGED');
    assert.equal(drift.hash_now, drift.hash_at_admission);
  });

  test('its locator is host.read_intake and is left intact', async () => {
    const built = await kernelFor(world(), 'Fix typo in README.', 'NATURAL_LANGUAGE', null);
    const admitted = await admitIntake(
      built, sourceLocatorFor('NATURAL_LANGUAGE', 'Fix typo in README.'), 'Fix typo in README.',
    );
    assert.deepEqual(admitted.locator, { adapter: 'host', op: 'read_intake', args: {} });
    assert.equal(admitted.unresolved, null);
  });
});
