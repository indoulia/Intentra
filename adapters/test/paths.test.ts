import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PathConfinement, type PathVerdict } from '../src/index.js';
import { PATHS, makeSymlink, scratch, type Scratch } from './helpers.js';

/**
 * Path confinement.
 *
 * This is the file that decides whether worktree isolation is a claim or a fact. Every test
 * below is a way of making the string an operation was handed name something other than the
 * file it would open, and the expected answer to all of them is no.
 */

let space: Scratch;
let confinement: PathConfinement;

const OPEN: { in_scope: readonly string[]; out_of_scope: readonly string[] } = {
  in_scope: ['**'],
  out_of_scope: [],
};

beforeEach(() => {
  space = scratch();
  confinement = new PathConfinement({
    worktreeRoot: space.worktree,
    /* An installation somewhere else, so the installation deny-list does not swallow every
     * other rule. One test below deliberately makes them the same directory. */
    installationRoot: join(space.root, 'installation'),
    home: join(space.root, 'home'),
    paths: PATHS,
  });
  mkdirSync(join(space.root, 'installation'), { recursive: true });
  mkdirSync(join(space.root, 'home'), { recursive: true });
});

afterEach(() => {
  space.dispose();
});

function refusal(verdict: PathVerdict): Extract<PathVerdict, { outcome: 'REFUSED' }> {
  assert.equal(verdict.outcome, 'REFUSED', `expected a refusal, got ${verdict.outcome}`);
  return verdict as Extract<PathVerdict, { outcome: 'REFUSED' }>;
}

function allowed(verdict: PathVerdict): Extract<PathVerdict, { outcome: 'ALLOWED' }> {
  assert.equal(
    verdict.outcome, 'ALLOWED',
    `expected an allow, got ${verdict.outcome === 'REFUSED' ? verdict.record.detail : ''}`,
  );
  return verdict as Extract<PathVerdict, { outcome: 'ALLOWED' }>;
}

describe('the ordinary case', () => {
  test('a file inside the worktree and inside the mandate resolves', () => {
    space.file('src/app.ts', 'export const a = 1;\n');
    const verdict = allowed(confinement.confine('repo', 'read_file', 'src/app.ts', {
      in_scope: ['src/**'],
      out_of_scope: [],
    }));
    assert.equal(verdict.relative, 'src/app.ts');
    assert.equal(verdict.exists, true);
  });

  test('a path that does not exist yet still resolves against its nearest real ancestor', () => {
    space.dir('src');
    const verdict = allowed(confinement.confine('repo', 'stat_path', 'src/new.ts', OPEN));
    assert.equal(verdict.relative, 'src/new.ts');
    assert.equal(
      verdict.exists, false,
      'a path can be checked before the file is there; that is what makes a write checkable',
    );
  });
});

describe('traversal', () => {
  test('a relative ../ escape is a security violation naming the worktree root', () => {
    writeFileSync(join(space.outside, 'secret.txt'), 'x', 'utf8');
    const verdict = refusal(confinement.confine('repo', 'read_file', '../outside/secret.txt', OPEN));
    assert.equal(verdict.refusal, 'security_violation');
    assert.equal(verdict.record.rule, 'worktree_root');
    assert.equal(verdict.record.aborted_dispatch, true);
  });

  test('a ../ escape buried mid-path is collapsed and caught', () => {
    space.dir('src/deep');
    const verdict = refusal(
      confinement.confine('repo', 'read_file', 'src/deep/../../../outside/secret.txt', OPEN),
    );
    assert.equal(verdict.record.rule, 'worktree_root');
  });

  test('an absolute path outside the worktree is refused', () => {
    const verdict = refusal(
      confinement.confine('repo', 'read_file', join(space.outside, 'secret.txt'), OPEN),
    );
    assert.equal(verdict.record.rule, 'worktree_root');
  });

  test('mixed separators do not evade the check', () => {
    const verdict = refusal(
      confinement.confine('repo', 'read_file', '..\\outside\\secret.txt', OPEN),
    );
    assert.equal(verdict.refusal, 'security_violation');
  });

  test('a percent-encoded traversal is refused as unresolvable rather than decoded', () => {
    const verdict = refusal(
      confinement.confine('repo', 'read_file', '%2e%2e%2foutside%2fsecret.txt', OPEN),
    );
    assert.equal(verdict.record.rule, 'unresolvable');
    assert.match(verdict.record.detail, /percent/i);
  });

  test('a Windows environment expansion is refused for the same reason', () => {
    const verdict = refusal(confinement.confine('repo', 'read_file', '%USERPROFILE%/.ssh/id_rsa', OPEN));
    assert.equal(verdict.record.rule, 'unresolvable');
  });
});

/**
 * The same cases `confinement.test.ts` proves through the injected filesystem, run here
 * against a real one. Neither layer is optional and neither may skip: this one fails loudly
 * if the host will not create a link, because that is a broken environment rather than a
 * reason to stop asserting.
 */
describe('symlinks on a real filesystem: the target is checked, not the link path', () => {
  test('a symlink inside the worktree pointing outside it is refused on traversal', () => {
    writeFileSync(join(space.outside, 'secret.txt'), 'x', 'utf8');
    makeSymlink(space.outside, join(space.worktree, 'escape'), 'junction');

    const verdict = refusal(confinement.confine('repo', 'read_file', 'escape/secret.txt', OPEN));
    assert.equal(verdict.refusal, 'security_violation');
    assert.equal(
      verdict.record.rule, 'symlink_escape',
      'the link path is inside the worktree and the target is not, and the rule reported has '
      + 'to say which of those was the problem',
    );
    assert.equal(verdict.record.aborted_dispatch, true);
  });

  test('a chain of symlinks ending outside the worktree is refused', () => {
    writeFileSync(join(space.outside, 'secret.txt'), 'x', 'utf8');
    const hop = join(space.root, 'hop');
    makeSymlink(space.outside, hop, 'junction');
    makeSymlink(hop, join(space.worktree, 'chain'), 'junction');

    const verdict = refusal(confinement.confine('repo', 'read_file', 'chain/secret.txt', OPEN));
    assert.equal(verdict.record.rule, 'symlink_escape');
  });

  test('a symlink whose target is inside the worktree is allowed', () => {
    space.file('src/real.ts', 'x');
    makeSymlink(join(space.worktree, 'src'), join(space.worktree, 'alias'), 'junction');

    const verdict = allowed(confinement.confine('repo', 'read_file', 'alias/real.ts', OPEN));
    assert.equal(
      verdict.relative, 'src/real.ts',
      'the resolved path is the real one, so the mandate and the deny-list are checked '
      + 'against what would actually be opened',
    );
  });

  test('a broken symlink is refused rather than treated as a path that does not exist yet', () => {
    makeSymlink(join(space.root, 'gone'), join(space.worktree, 'dangling'), 'junction');

    const verdict = refusal(confinement.confine('repo', 'read_file', 'dangling/x.txt', OPEN));
    assert.equal(verdict.refusal, 'security_violation');
    assert.equal(verdict.record.rule, 'symlink_escape');
    assert.match(verdict.record.detail, /does not exist/);
  });
});

describe('the mandate', () => {
  test('a path outside in_scope is a scope violation and does not abort the dispatch', () => {
    space.file('docs/readme.md', 'x');
    const verdict = refusal(confinement.confine('repo', 'read_file', 'docs/readme.md', {
      in_scope: ['src/**'],
      out_of_scope: [],
    }));
    assert.equal(verdict.refusal, 'scope_violation');
    assert.equal(verdict.record.rule, 'mandate_in_scope');
    assert.equal(
      verdict.record.aborted_dispatch, false,
      'an in-scope failure is a scope violation; only the deny-list and an escape attempt '
      + 'abort the dispatch',
    );
  });

  test('out_of_scope beats in_scope', () => {
    space.file('src/generated/api.ts', 'x');
    const verdict = refusal(confinement.confine('repo', 'read_file', 'src/generated/api.ts', {
      in_scope: ['src/**'],
      out_of_scope: ['**/generated/**'],
    }));
    assert.equal(verdict.record.rule, 'mandate_out_of_scope');
  });

  test('an empty mandate admits nothing: an absent scope is not an unlimited one', () => {
    space.file('src/app.ts', 'x');
    const verdict = refusal(confinement.confine('repo', 'read_file', 'src/app.ts', {
      in_scope: [],
      out_of_scope: [],
    }));
    assert.equal(verdict.record.rule, 'mandate_in_scope');
  });
});

describe('the absolute deny-list, checked even when the worktree and mandate pass', () => {
  /**
   * The invariant suite's rule 2, run against the shape that actually threatens it: AgentOS
   * auditing its own repository, where `state/` genuinely does resolve inside the worktree.
   */
  function selfHosted(): PathConfinement {
    return new PathConfinement({
      worktreeRoot: space.worktree,
      installationRoot: space.worktree,
      home: join(space.root, 'home'),
      paths: PATHS,
    });
  }

  for (const [directory, entry] of [
    ['state', 'agentos_state'],
    ['policies', 'agentos_policies'],
    ['contracts', 'agentos_contracts'],
  ] as const) {
    test(`a write under ${directory}/ is refused even though it resolves inside the worktree`, () => {
      space.file(`${directory}/work-items/x.json`, '{}');
      const verdict = refusal(selfHosted().confine(
        'repo', 'read_file', `${directory}/work-items/x.json`, OPEN,
      ));
      assert.equal(verdict.refusal, 'security_violation');
      assert.equal(verdict.record.rule, 'deny_list');
      assert.equal(
        verdict.record.deny_list_entry, entry,
        'the entry reported has to be the specific rule and not the installation-wide '
        + 'backstop, or the message sends someone to the wrong file',
      );
      assert.equal(verdict.record.aborted_dispatch, true);
    });
  }

  test('a secret-bearing name inside the worktree is refused for a read', () => {
    space.file('.env', 'API_KEY=hunter2\n');
    const verdict = refusal(confinement.confine('repo', 'read_file', '.env', OPEN));
    assert.equal(verdict.record.deny_list_entry, 'secret_bearing_names');
    assert.equal(
      verdict.refusal, 'security_violation',
      'the security floor is never expose or copy a secret, not merely never change one, so '
      + 'a read is refused as well as a write',
    );
  });

  test('a private key by extension is refused wherever it sits', () => {
    space.file('deploy/keys/server.pem', 'x');
    const verdict = refusal(confinement.confine('repo', 'read_file', 'deploy/keys/server.pem', OPEN));
    assert.equal(verdict.record.deny_list_entry, 'secret_bearing_names');
  });

  test('the deny-list matches case-insensitively, so an uppercase alias does not evade it', () => {
    space.file('.ENV', 'x');
    const verdict = refusal(confinement.confine('repo', 'read_file', '.ENV', OPEN));
    assert.equal(verdict.record.deny_list_entry, 'secret_bearing_names');
  });

  test('a home-relative credential path is refused', () => {
    const home = join(space.root, 'home');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'known_hosts'), 'x', 'utf8');
    /* Reached through a worktree whose root *is* the home directory, which is the only way a
     * home path also satisfies rules 1 and 2 — and exactly the case rule 3 exists for. */
    const homed = new PathConfinement({
      worktreeRoot: home,
      installationRoot: join(space.root, 'installation'),
      home,
      paths: PATHS,
    });
    const verdict = refusal(homed.confine('repo', 'read_file', '.ssh/known_hosts', OPEN));
    assert.equal(verdict.record.deny_list_entry, 'host_credential_stores');
  });

  test('a path that matches nothing on the deny-list is allowed', () => {
    space.file('src/app.ts', 'x');
    assert.equal(confinement.denyMatch(join(space.worktree, 'src', 'app.ts')), null);
  });
});

describe('canonicalization ambiguity, every case failing closed', () => {
  const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
    ['an 8.3 short name', 'PROGRA~1/app.ts', /8\.3 short-name/],
    ['a trailing dot', 'src/app.ts.', /space or a dot/],
    ['a trailing space', 'src/app.ts ', /space or a dot/],
    ['a reserved device name', 'src/NUL', /reserved device name/],
    ['a reserved device name with an extension', 'src/CON.txt', /reserved device name/],
    ['an alternate data stream', 'src/app.ts:hidden', /alternate data stream/],
    ['a drive-relative path', 'C:app.ts', /drive-relative/],
    ['a Win32 device path', '\\\\?\\C:\\Windows\\System32\\config\\SAM', /device path/],
    ['a NUL byte', 'src/app\u0000.ts', /NUL byte/],
  ];

  for (const [name, path, expected] of cases) {
    test(`${name} is refused`, () => {
      const verdict = refusal(confinement.confine('repo', 'read_file', path, OPEN));
      assert.equal(verdict.refusal, 'security_violation');
      assert.match(verdict.record.detail, expected);
    });
  }

  test('an empty path names nothing and is refused', () => {
    const verdict = refusal(confinement.confine('repo', 'read_file', '   ', OPEN));
    assert.equal(verdict.record.rule, 'unresolvable');
  });

  test('a non-string path argument is refused', () => {
    const verdict = refusal(confinement.confine('repo', 'read_file', { path: 'src' }, OPEN));
    assert.equal(verdict.record.rule, 'unresolvable');
  });

  test('a UNC path is refused on its shape, without reaching the network', () => {
    const verdict = refusal(
      confinement.confine('repo', 'read_file', '//fileserver/share/secret.txt', OPEN),
    );
    assert.equal(verdict.refusal, 'security_violation');
    assert.equal(verdict.record.rule, 'unresolvable');
    assert.equal(
      verdict.record.resolved, null,
      'refusing on the shape means nothing was canonicalized, so nothing was reached',
    );
  });
});

/*
 * The inaccessible-path case lives in `confinement.test.ts`, driven through the injected
 * filesystem's EACCES. It was here as a real-filesystem test and could not assert on a host
 * that ignores mode bits — Windows, and any process running as root — so it decided at
 * runtime not to assert. A test that can do that is not a test, and its coverage moved to
 * somewhere that always runs rather than staying somewhere that sometimes does.
 */

describe('the refusal record', () => {
  test('carries every field the frozen pathRefusal shape requires', () => {
    const verdict = refusal(confinement.confine('git', 'read_pr', '../outside/x', OPEN));
    for (const field of [
      'adapter', 'op', 'requested', 'resolved', 'rule', 'deny_list_entry',
      'aborted_dispatch', 'detail',
    ]) {
      assert.ok(field in verdict.record, `pathRefusal requires ${field}`);
    }
    assert.equal(verdict.record.adapter, 'git');
    assert.equal(verdict.record.op, 'read_pr');
    assert.equal(verdict.record.requested, '../outside/x');
  });
});
