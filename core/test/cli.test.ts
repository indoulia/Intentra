import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, type CliIo } from '../src/cli/main.js';
import { FixtureError, loadFixture } from '../src/replay/fixture.js';
import { replayFixture } from '../src/replay/run.js';

/**
 * The CLI, and `agentos replay` under it.
 *
 * `replay` drives the entire kernel from recorded envelopes, which is what makes it the
 * driver for the end-to-end scenarios and the way a run is re-examined after it happened.
 * These tests run it over a committed recording and assert on what came out.
 */

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fixtures',
  'typo-readme',
);

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-cli-'));
  roots.push(root);
  return root;
}

interface Captured {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

function capture(stateRoot = tempRoot()): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line) => { out.push(line); },
      err: (line) => { err.push(line); },
      stateRoot,
    },
    out,
    err,
  };
}

/** A copy of the committed fixture, for the tests that break one deliberately. */
function brokenFixture(mutate: (root: string) => void): string {
  const root = tempRoot();
  const work = join(root, 'fixture');
  cpSync(FIXTURE, work, { recursive: true });
  mutate(work);
  return work;
}

/* ================================================================ the fixture ==== */

describe('a replay fixture is untrusted input', () => {
  test('the committed recording loads and carries what a run needs', () => {
    const fixture = loadFixture(FIXTURE);
    assert.equal(fixture.intake.source, 'NATURAL_LANGUAGE');
    assert.equal(fixture.intake.raw, 'Fix typo in README.');
    assert.ok(fixture.context !== null, 'a replay with no reality would decide against nothing');
    assert.equal(fixture.envelopes.length, 5);
    assert.deepEqual(
      fixture.envelopes.map((e) => e.file),
      [
        '01-resolution.json', '02-context.json', '03-workflow.json', '04-audit.json',
        '05-root-cause.json',
      ],
      'dispatched in filename order, which is why the files are numbered',
    );
    assert.ok(
      fixture.envelopes[3]?.calls.length === 1,
      'the audit dispatch records the call it made, so its coverage claim is checkable',
    );
    assert.ok(
      fixture.envelopes[1]?.calls.length === 1,
      'and so does the context dispatch, which is not exempt from the reconciliation either',
    );
    assert.ok(fixture.adapters.operations.length > 0);
    assert.ok(fixture.models.length > 0, 'a run with no model makes no progress');
    assert.ok(fixture.agents.length > 0);
  });

  test('a directory that is not there is refused with that as the reason', () => {
    assert.throws(
      () => loadFixture(join(tempRoot(), 'nope')),
      (error: unknown) => error instanceof FixtureError && /does not exist/.test(error.message),
    );
  });

  test('a fixture with no envelopes is refused rather than replayed as an empty run', () => {
    const work = brokenFixture((root) => {
      rmSync(join(root, 'envelopes'), { recursive: true, force: true });
      mkdirSync(join(root, 'envelopes'));
    });
    assert.throws(
      () => loadFixture(work),
      (error: unknown) => error instanceof FixtureError && /no \.json files/.test(error.message),
    );
  });

  test('an intake with no source is refused, naming the sources that exist', () => {
    const work = brokenFixture((root) => {
      writeFileSync(
        join(root, 'intake.json'),
        JSON.stringify({ raw: 'x', source_locator: { adapter: 'a', op: 'b', args: {} } }),
        'utf8',
      );
    });
    assert.throws(
      () => loadFixture(work),
      (error: unknown) => error instanceof FixtureError
        && /source must be one of NATURAL_LANGUAGE/.test(error.message),
    );
  });

  test('a malformed locator is refused at load, not at the source-drift check', () => {
    const work = brokenFixture((root) => {
      writeFileSync(
        join(root, 'intake.json'),
        JSON.stringify({ source: 'NATURAL_LANGUAGE', raw: 'x', source_locator: { op: 'b' } }),
        'utf8',
      );
    });
    assert.throws(
      () => loadFixture(work),
      (error: unknown) => error instanceof FixtureError
        && /source_locator\.adapter/.test(error.message),
    );
  });

  test('a context package the contracts refuse is refused here too', () => {
    const work = brokenFixture((root) => {
      writeFileSync(join(root, 'context.json'), JSON.stringify({ meta: {} }), 'utf8');
    });
    assert.throws(() => loadFixture(work));
  });

  test('unparseable JSON says which file and why', () => {
    const work = brokenFixture((root) => {
      writeFileSync(join(root, 'adapters.json'), '{ not json', 'utf8');
    });
    assert.throws(
      () => loadFixture(work),
      (error: unknown) => error instanceof FixtureError
        && /adapters\.json is not valid JSON/.test(error.message),
    );
  });
});

/* ================================================================== the replay ==== */

describe('agentos replay drives the whole kernel from recorded envelopes', () => {
  test('the recorded run reaches COMPLETION and the DoD judges it', async () => {
    const outcome = await replayFixture(FIXTURE, { stateRoot: tempRoot() });
    assert.deepEqual(
      [...outcome.dispatched],
      [
        '01-resolution.json', '02-context.json', '03-workflow.json', '04-audit.json',
        '05-root-cause.json',
      ],
      'every recorded envelope was consumed, in order',
    );
    assert.deepEqual(outcome.unused, [], 'the run took the path the recording took');
    assert.equal(
      outcome.result.outcome,
      'BLOCKED',
      'a read-only run cannot demonstrate a documentation fix, so completion is unjudgeable',
    );
    assert.match(outcome.result.detail, /^INDETERMINATE: /);
  });

  test('the same fixture replays to the same run, twice', async () => {
    const first = await replayFixture(FIXTURE, { stateRoot: tempRoot() });
    const second = await replayFixture(FIXTURE, { stateRoot: tempRoot() });
    assert.equal(first.result.workItemId, second.result.workItemId);
    assert.equal(first.result.runId, second.result.runId);
    assert.equal(first.result.detail, second.result.detail);
    assert.equal(
      first.result.narrative,
      second.result.narrative,
      'a frozen clock and a seeded sampler make a replay reproducible, which is what makes it '
      + 'usable as a test',
    );
  });

  test('the replay writes a real log, so status and narrate read it afterwards', async () => {
    const root = tempRoot();
    const outcome = await replayFixture(FIXTURE, { stateRoot: root });
    assert.ok(outcome.result.workItemId !== null);

    const listed = capture(root);
    assert.equal(await main(['status'], listed.io), 0);
    assert.ok(
      listed.out.some((line) => line.includes(outcome.result.workItemId ?? '')),
      'the replayed work item is listed like any other',
    );

    const narrated = capture(root);
    assert.equal(await main(['narrate', outcome.result.workItemId], narrated.io), 0);
    assert.match(narrated.out.join('\n'), /What AgentOS decided the work was, and why/);
  });

  test('an envelope answering a stale dispatch is not what a replay tests', async () => {
    /*
     * The recording carries the ids of the run it came from, and a replay allocates new ones.
     * Rebinding them is a transport concern: the recorded substrate really is answering this
     * dispatch. Everything substantive arrives as recorded, which the coverage reconciliation
     * below demonstrates — it is checked against calls that were actually re-issued.
     */
    const outcome = await replayFixture(FIXTURE, { stateRoot: tempRoot() });
    assert.ok(outcome.result.runId !== null);
    assert.ok(!/DISPATCH_ID_MISMATCH/.test(outcome.result.detail));
  });

  test('an envelope whose coverage no recorded call supports is still rejected', async () => {
    /*
     * The reconciliation is not disabled by the replay, it is fed. Removing the recorded call
     * from the audit dispatch leaves its coverage claim unsupported, and the run blocks — which
     * is exactly what would have happened live.
     */
    const work = brokenFixture((root) => {
      rmSync(join(root, 'envelopes', '04-audit.calls.json'));
    });
    const outcome = await replayFixture(work, { stateRoot: tempRoot() });
    assert.equal(outcome.result.outcome, 'BLOCKED');
    assert.match(outcome.result.detail, /COVERAGE_OVERSTATED/);
    assert.ok(
      outcome.unused.includes('05-root-cause.json'),
      'the run stopped where the rejection stopped it, and says which envelopes it never asked for',
    );
  });

  test('a run that asks for more envelopes than were recorded fails honestly', async () => {
    const work = brokenFixture((root) => {
      rmSync(join(root, 'envelopes', '05-root-cause.json'));
      rmSync(join(root, 'envelopes', '05-root-cause.calls.json'));
    });
    const outcome = await replayFixture(work, { stateRoot: tempRoot() });
    assert.notEqual(outcome.result.outcome, 'COMPLETE');
    assert.ok(outcome.result.runId !== null);
  });

  test('an adapter call the recording does not cover is an error, never an invented result', async () => {
    const work = brokenFixture((root) => {
      writeFileSync(
        join(root, 'adapters.json'),
        JSON.stringify({ operations: [] }),
        'utf8',
      );
    });
    const outcome = await replayFixture(work, { stateRoot: tempRoot() });
    assert.notEqual(
      outcome.result.outcome,
      'COMPLETE',
      'a replay answers from the recording or not at all',
    );
  });
});

/* ===================================================================== the CLI ==== */

describe('the command line', () => {
  test('no command prints usage and fails, so a bare invocation is not a no-op', async () => {
    const cli = capture();
    assert.equal(await main([], cli.io), 1);
    assert.match(cli.out.join('\n'), /usage: agentos <command>/);
  });

  test('help succeeds and lists every command that exists', async () => {
    const cli = capture();
    assert.equal(await main(['--help'], cli.io), 0);
    const text = cli.out.join('\n');
    for (const command of ['status', 'narrate', 'replay']) {
      assert.match(text, new RegExp(command));
    }
  });

  test('an unknown command is refused, and says so on stderr', async () => {
    const cli = capture();
    assert.equal(await main(['deploy-everything'], cli.io), 2);
    assert.match(cli.err.join('\n'), /unknown command deploy-everything/);
  });

  test('work names the repository it needs rather than guessing one', async () => {
    /*
     * `work` was absent rather than stubbed until the ports it needs existed (decision I-19).
     * They do now, so the command runs — and the thing it must not do is invent the one
     * argument that decides what it will read. A run against the wrong worktree is a run
     * whose every observation is about the wrong system, and defaulting to the current
     * directory is how that happens quietly.
     */
    const cli = capture();
    assert.equal(await main(['work', 'fix the typo'], cli.io), 2);
    assert.match(cli.err.join('\n'), /--repo/);
    assert.doesNotMatch(
      cli.err.join('\n'),
      /not available in this build/,
      'the command exists now, and a stale refusal would misdescribe the build',
    );
  });

  test('status on an empty state root says so rather than failing', async () => {
    const cli = capture();
    assert.equal(await main(['status'], cli.io), 0);
    assert.match(cli.out.join('\n'), /no work items under/);
  });

  test('narrate with no work item id is refused with what to do instead', async () => {
    const cli = capture();
    assert.equal(await main(['narrate'], cli.io), 2);
    assert.match(cli.err.join('\n'), /agentos status/);
  });

  test('status on a work item that does not exist says that, and does not invent one', async () => {
    const cli = capture();
    assert.equal(await main(['status', 'wi_c_nothing'], cli.io), 0);
    assert.match(cli.out.join('\n'), /no work item wi_c_nothing/);
  });

  test('replay with no directory is refused', async () => {
    const cli = capture();
    assert.equal(await main(['replay'], cli.io), 2);
    assert.match(cli.err.join('\n'), /needs a fixture directory/);
  });

  test('replay reports the outcome, the envelopes and the narrative', async () => {
    const cli = capture();
    const code = await main(['replay', FIXTURE], cli.io);
    const text = cli.out.join('\n');
    assert.equal(code, 1, 'the exit code follows the run outcome, so a script can branch on it');
    assert.match(text, /outcome\s+BLOCKED/);
    assert.match(text, /envelopes\s+01-resolution\.json/);
    assert.match(text, /What AgentOS decided the work was, and why/);
  });
});
