import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { PathConfinement, type FileSystemProbe, type PathVerdict } from '../src/index.js';
import { PATHS } from './helpers.js';

/**
 * Path confinement, driven through the filesystem seam.
 *
 * Every case in this file is one a real filesystem produces only with privileges some hosts
 * withhold — a symlink escaping the worktree, a two-hop chain, a link whose target is gone, a
 * directory this process may not traverse, a cycle, a path that resolves to one place and then
 * to another. Those are the assertions WP-4 exists to make, so **none of them may depend on
 * the host running the suite**. Driving them through an injected filesystem is what makes
 * them run everywhere; `paths.test.ts` then runs the same cases against a real filesystem as
 * a second layer.
 *
 * The fake is a filesystem in the only sense confinement cares about: what a path really
 * resolves to, and whether an entry is a link. It throws the way `node:fs` throws, so a
 * refusal produced here is produced by exactly the code path a real `EACCES` would take.
 */

/**
 * Absolute paths, anchored the way the host anchors them.
 *
 * `node:path.resolve` is what confinement uses to turn an argument into an absolute path, and
 * on Windows that attaches a drive. Building the fake's paths the same way keeps the test
 * about confinement rather than about which platform it runs on.
 */
function at(path: string): string {
  return posix(resolve(path));
}

const WORKTREE = at('/repo/worktree');
const OUTSIDE = at('/repo/outside');
const INSTALLATION = at('/opt/agentos');
const HOME = at('/home/operator');
const HOP = at('/repo/hop');
const GONE = at('/repo/gone');
const REAL_WORKTREE = at('/real/worktree');
/*
 * The filesystem root in its native form. Kept native rather than posix-normalized because
 * `C:` and `C:\` mean different things on Windows — the first is drive-relative and resolves
 * against a per-drive working directory, which is exactly the ambiguity confinement refuses.
 */
const FILESYSTEM_ROOT = resolve('/');

const OPEN = { in_scope: ['**'], out_of_scope: [] };

function errno(code: string, message = code): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function posix(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

/**
 * A filesystem defined by three facts per path: does it exist, is it a link, and what does a
 * link point at. Links are followed transitively, so a chain is a chain and not a shortcut.
 */
class InMemoryFilesystem implements FileSystemProbe {
  readonly present = new Set<string>();
  readonly links = new Map<string, string>();
  readonly errors = new Map<string, string>();
  /** How many link hops the last resolution took, so a chain test can prove it was one. */
  hops = 0;
  /** Successive answers for one path, for the resolve-twice case. */
  readonly sequences = new Map<string, string[]>();

  exists(...paths: readonly string[]): this {
    for (const path of paths) this.present.add(posix(path));
    return this;
  }

  link(from: string, to: string): this {
    this.links.set(posix(from), posix(to));
    return this;
  }

  fail(path: string, code: string): this {
    this.errors.set(posix(path), code);
    return this;
  }

  /** The path resolves to each of these in turn, one per call. */
  sequence(path: string, ...answers: readonly string[]): this {
    this.sequences.set(posix(path), answers.map(posix));
    return this;
  }

  realpath(path: string): string {
    const start = posix(path);
    this.hops = 0;

    const scripted = this.sequences.get(start);
    if (scripted !== undefined && scripted.length > 0) {
      return scripted.length === 1 ? (scripted[0] as string) : (scripted.shift() as string);
    }

    let current = start;
    for (let step = 0; step < 32; step += 1) {
      const code = this.#errorFor(current);
      if (code !== undefined) throw errno(code, `${code} on ${current}`);
      const followed = this.#follow(current);
      if (followed === null) {
        if (!this.#exists(current)) throw errno('ENOENT', `no such path ${current}`);
        return current;
      }
      this.hops += 1;
      current = followed;
    }
    throw errno('ELOOP', `too many symbolic links resolving ${start}`);
  }

  isSymbolicLink(path: string): boolean {
    const target = posix(path);
    const code = this.#errorFor(target);
    if (code !== undefined) throw errno(code, `${code} on ${target}`);
    if (this.links.has(target)) return true;
    if (this.#exists(target)) return false;
    throw errno('ENOENT', `no such path ${target}`);
  }

  /** The longest link prefix of `path`, substituted, or `null` when there is none. */
  #follow(path: string): string | null {
    let best: string | null = null;
    for (const key of this.links.keys()) {
      if (path !== key && !path.startsWith(`${key}/`)) continue;
      if (best === null || key.length > best.length) best = key;
    }
    if (best === null) return null;
    const target = this.links.get(best);
    if (target === undefined) return null;
    return path === best ? target : target + path.slice(best.length);
  }

  #errorFor(path: string): string | undefined {
    for (const [key, code] of this.errors) {
      if (path === key || path.startsWith(`${key}/`)) return code;
    }
    return undefined;
  }

  #exists(path: string): boolean {
    if (this.present.has(path)) return true;
    for (const entry of this.present) {
      if (entry.startsWith(`${path}/`)) return true;
    }
    return false;
  }
}

let fs: InMemoryFilesystem;

function confinement(): PathConfinement {
  return new PathConfinement({
    worktreeRoot: WORKTREE,
    installationRoot: INSTALLATION,
    home: HOME,
    paths: PATHS,
    fs,
  });
}

beforeEach(() => {
  fs = new InMemoryFilesystem().exists(WORKTREE, OUTSIDE, INSTALLATION, HOME);
});

function refusal(verdict: PathVerdict): Extract<PathVerdict, { outcome: 'REFUSED' }> {
  assert.equal(
    verdict.outcome, 'REFUSED',
    `expected a refusal, got ${verdict.outcome === 'ALLOWED' ? verdict.resolved : ''}`,
  );
  return verdict as Extract<PathVerdict, { outcome: 'REFUSED' }>;
}

function allowed(verdict: PathVerdict): Extract<PathVerdict, { outcome: 'ALLOWED' }> {
  assert.equal(
    verdict.outcome, 'ALLOWED',
    `expected an allow, got ${verdict.outcome === 'REFUSED' ? verdict.record.detail : ''}`,
  );
  return verdict as Extract<PathVerdict, { outcome: 'ALLOWED' }>;
}

describe('the seam agrees with the real filesystem on the ordinary case', () => {
  test('a real file inside the worktree resolves', () => {
    fs.exists(`${WORKTREE}/src/app.ts`);
    const verdict = allowed(confinement().confine('repo', 'read_file', 'src/app.ts', OPEN));
    assert.equal(verdict.relative, 'src/app.ts');
    assert.equal(verdict.exists, true);
  });

  test('a path that does not exist yet resolves against its nearest real ancestor', () => {
    fs.exists(`${WORKTREE}/src`);
    const verdict = allowed(confinement().confine('repo', 'stat_path', 'src/new.ts', OPEN));
    assert.equal(verdict.relative, 'src/new.ts');
    assert.equal(verdict.exists, false);
  });
});

describe('symlink escape: the target is checked, not the link path', () => {
  test('a link inside the worktree pointing outside it is refused', () => {
    fs.link(`${WORKTREE}/escape`, OUTSIDE).exists(`${OUTSIDE}/secret.txt`);
    const verdict = refusal(confinement().confine('repo', 'read_file', 'escape/secret.txt', OPEN));
    assert.equal(verdict.refusal, 'security_violation');
    assert.equal(verdict.record.rule, 'symlink_escape');
    assert.equal(verdict.record.aborted_dispatch, true);
    assert.equal(
      verdict.record.resolved, `${OUTSIDE}/secret.txt`,
      'the refusal records where the path really led, which is what makes it investigable',
    );
  });

  test('a two-hop chain ending outside the worktree is refused, and both hops are taken', () => {
    fs.link(`${WORKTREE}/chain`, HOP)
      .link(HOP, OUTSIDE)
      .exists(`${OUTSIDE}/secret.txt`);
    const verdict = refusal(confinement().confine('repo', 'read_file', 'chain/secret.txt', OPEN));
    assert.equal(verdict.record.rule, 'symlink_escape');
    assert.equal(fs.hops, 2, 'a chain is followed to its end, not to its first hop');
  });

  test('a link whose target is inside the worktree is allowed, at its real path', () => {
    fs.link(`${WORKTREE}/alias`, `${WORKTREE}/src`).exists(`${WORKTREE}/src/real.ts`);
    const verdict = allowed(confinement().confine('repo', 'read_file', 'alias/real.ts', OPEN));
    assert.equal(
      verdict.relative, 'src/real.ts',
      'the mandate and the deny-list are checked against what would actually be opened',
    );
  });

  test('a link inside the worktree pointing at a denied path is still refused', () => {
    fs.link(`${WORKTREE}/keys`, `${HOME}/.ssh`).exists(`${HOME}/.ssh/id_rsa`);
    const verdict = refusal(confinement().confine('repo', 'read_file', 'keys/id_rsa', OPEN));
    assert.equal(verdict.refusal, 'security_violation');
    assert.equal(
      verdict.record.rule, 'symlink_escape',
      'it left the worktree, which is caught before the deny-list is even consulted',
    );
  });

  test('a link that resolves inside the worktree onto a denied name is refused by rule 3', () => {
    fs.link(`${WORKTREE}/config`, `${WORKTREE}/.env`).exists(`${WORKTREE}/.env`);
    const verdict = refusal(confinement().confine('repo', 'read_file', 'config', OPEN));
    assert.equal(verdict.record.rule, 'deny_list');
    assert.equal(
      verdict.record.deny_list_entry, 'secret_bearing_names',
      'rules 1 and 2 passed and rule 3 is the backstop that holds when they do',
    );
  });
});

describe('a link that leads nowhere', () => {
  test('a broken symlink is refused rather than treated as "not there yet"', () => {
    fs.link(`${WORKTREE}/dangling`, GONE);
    const verdict = refusal(confinement().confine('repo', 'read_file', 'dangling/x.txt', OPEN));
    assert.equal(verdict.refusal, 'security_violation');
    assert.equal(verdict.record.rule, 'symlink_escape');
    assert.match(verdict.record.detail, /target does not exist/);
  });

  test('a broken link on an ancestor is caught while walking up', () => {
    fs.link(`${WORKTREE}/a`, GONE);
    const verdict = refusal(confinement().confine('repo', 'read_file', 'a/b/c/d.txt', OPEN));
    assert.equal(verdict.record.rule, 'symlink_escape');
  });

  test('a symlink cycle names no file at all and is refused', () => {
    fs.link(`${WORKTREE}/loop`, `${WORKTREE}/loop2`).link(`${WORKTREE}/loop2`, `${WORKTREE}/loop`);
    const verdict = refusal(confinement().confine('repo', 'read_file', 'loop/x.txt', OPEN));
    assert.equal(verdict.record.rule, 'symlink_escape');
    assert.match(verdict.record.detail, /cycle/);
  });
});

describe('a path the process cannot inspect', () => {
  test('EACCES on the path itself is refused as unresolvable', () => {
    fs.exists(`${WORKTREE}/locked/inner.txt`).fail(`${WORKTREE}/locked`, 'EACCES');
    const verdict = refusal(confinement().confine('repo', 'read_file', 'locked/inner.txt', OPEN));
    assert.equal(verdict.refusal, 'security_violation');
    assert.equal(verdict.record.rule, 'unresolvable');
    assert.match(
      verdict.record.detail, /unverifiable path is refused/,
      'an unreadable path is an unverifiable path, and confinement refuses what it cannot check',
    );
  });

  test('EPERM is treated the same way', () => {
    fs.fail(`${WORKTREE}/locked`, 'EPERM');
    const verdict = refusal(confinement().confine('repo', 'read_file', 'locked/inner.txt', OPEN));
    assert.equal(verdict.record.rule, 'unresolvable');
  });

  test('EACCES discovered while walking up to an existing ancestor is refused', () => {
    /* The leaf does not exist, so the walk climbs — and the climb hits a directory it may
     * not stat, which establishes nothing about where the path would have led. */
    fs.fail(`${WORKTREE}/locked`, 'EACCES');
    const verdict = refusal(confinement().confine('repo', 'stat_path', 'locked/deep/new.txt', OPEN));
    assert.equal(verdict.record.rule, 'unresolvable');
  });

  test('an unexpected errno is refused rather than interpreted', () => {
    fs.fail(`${WORKTREE}/weird`, 'EIO');
    const verdict = refusal(confinement().confine('repo', 'read_file', 'weird/x.txt', OPEN));
    assert.equal(verdict.record.rule, 'unresolvable');
    assert.match(verdict.record.detail, /EIO/);
  });
});

describe('a path whose resolution changes between calls', () => {
  test('each call is confined against what the path resolves to now', () => {
    /*
     * The check-then-use window, made deterministic. Confinement resolves once per call and
     * decides on that resolution, so a path swapped for a link out of the worktree between
     * two calls is allowed the first time and refused the second — never allowed twice on
     * the strength of the first answer.
     */
    fs.exists(`${WORKTREE}/swap`)
      .sequence(`${WORKTREE}/swap`, `${WORKTREE}/swap`, `${OUTSIDE}/swap`);

    const confine = confinement();
    assert.equal(confine.confine('repo', 'read_file', 'swap', OPEN).outcome, 'ALLOWED');
    const second = refusal(confine.confine('repo', 'read_file', 'swap', OPEN));
    assert.equal(
      second.record.rule, 'symlink_escape',
      'nothing is cached: a second call is a second resolution and a second decision',
    );
  });
});

describe('the worktree root itself', () => {
  test('a root that is a symlink is canonicalized once, so paths under it are not escapes', () => {
    fs.link(WORKTREE, REAL_WORKTREE).exists(`${REAL_WORKTREE}/src/app.ts`);
    const confine = confinement();
    assert.equal(posix(confine.worktreeRoot), REAL_WORKTREE);
    const verdict = allowed(confine.confine('repo', 'read_file', 'src/app.ts', OPEN));
    assert.equal(verdict.relative, 'src/app.ts');
  });

  test('a root that cannot be canonicalized falls back to itself and never widens', () => {
    fs = new InMemoryFilesystem().exists(OUTSIDE, INSTALLATION, HOME);
    const confine = confinement();
    assert.equal(
      posix(confine.worktreeRoot), WORKTREE,
      'where the root will not resolve, the declared root stands. Falling back to an ancestor '
      + 'would silently widen the containment the whole layer exists to hold',
    );
    const escape = refusal(confine.confine('repo', 'read_file', '../outside/secret.txt', OPEN));
    assert.equal(escape.refusal, 'security_violation');
  });
});

describe('the deny-list under the seam', () => {
  test('the installation is denied even when it sits inside the worktree', () => {
    const selfHosted = new PathConfinement({
      worktreeRoot: WORKTREE,
      installationRoot: WORKTREE,
      home: HOME,
      paths: PATHS,
      fs,
    });
    fs.exists(`${WORKTREE}/state/work-items/x.json`);
    const verdict = refusal(selfHosted.confine('repo', 'read_file', 'state/work-items/x.json', OPEN));
    assert.equal(verdict.record.deny_list_entry, 'agentos_state');
  });

  test('a home-relative credential path is denied wherever it is reached from', () => {
    const homed = new PathConfinement({
      worktreeRoot: HOME,
      installationRoot: INSTALLATION,
      home: HOME,
      paths: PATHS,
      fs,
    });
    fs.exists(`${HOME}/.aws/credentials`);
    const verdict = refusal(homed.confine('repo', 'read_file', '.aws/credentials', OPEN));
    assert.equal(verdict.record.deny_list_entry, 'host_credential_stores');
  });

  test('an absolute OS credential path is denied', () => {
    const rooted = new PathConfinement({
      worktreeRoot: FILESYSTEM_ROOT,
      installationRoot: INSTALLATION,
      home: HOME,
      paths: PATHS,
      fs,
    });
    fs.exists(at('/etc/shadow'), FILESYSTEM_ROOT);
    const verdict = refusal(rooted.confine('repo', 'read_file', at('/etc/shadow'), OPEN));
    assert.equal(
      verdict.record.deny_list_entry, 'os_credential_paths',
      `refused for ${verdict.record.rule}: ${verdict.record.detail}`,
    );
  });

  test('a deny-list entry whose kind cannot be evaluated is treated as matching', () => {
    const unknownKind = new PathConfinement({
      worktreeRoot: WORKTREE,
      installationRoot: INSTALLATION,
      home: HOME,
      paths: {
        ...PATHS,
        deny: [{
          id: 'from_the_future',
          description: 'a deny kind this build does not know',
          kind: 'container_relative' as never,
          patterns: ['**'],
        }],
      },
      fs,
    });
    fs.exists(`${WORKTREE}/src/app.ts`);
    const verdict = refusal(unknownKind.confine('repo', 'read_file', 'src/app.ts', OPEN));
    assert.equal(verdict.record.deny_list_entry, 'from_the_future');
    assert.match(
      verdict.record.detail, /cannot evaluate/,
      'a rule nobody enforces is worse than a rule nobody wrote',
    );
  });
});

describe('the ambiguities, which never reach the filesystem at all', () => {
  const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
    ['an 8.3 short name', 'PROGRA~1/app.ts', /8\.3 short-name/],
    ['a trailing dot', 'src/app.ts.', /space or a dot/],
    ['a trailing space', 'src/app.ts ', /space or a dot/],
    ['a reserved device name', 'src/NUL', /reserved device name/],
    ['an alternate data stream', 'src/app.ts:hidden', /alternate data stream/],
    ['a drive-relative path', 'C:app.ts', /drive-relative/],
    ['a Win32 device path', '\\\\?\\C:\\Windows\\System32\\config\\SAM', /device path/],
    ['a UNC share', '//fileserver/share/x', /UNC network share/],
    ['a percent-encoded traversal', '%2e%2e/outside/x', /percent/],
    ['a NUL byte', 'src/app\u0000.ts', /NUL byte/],
  ];

  for (const [name, path, expected] of cases) {
    test(`${name} is refused before anything is resolved`, () => {
      const verdict = refusal(confinement().confine('repo', 'read_file', path, OPEN));
      assert.equal(verdict.refusal, 'security_violation');
      assert.match(verdict.record.detail, expected);
      assert.equal(
        verdict.record.resolved, null,
        'refusing on the shape means nothing was opened, canonicalized or reached',
      );
    });
  }

  test('a case-differing path fails the mandate rather than passing it', () => {
    /*
     * Case-insensitive collision: the host would open `src/app.ts` for `SRC/app.ts`. The
     * allow-list is matched case-sensitively, so the mandate refuses — being wrong in the
     * restrictive direction, which is the direction to be wrong in.
     */
    fs.exists(`${WORKTREE}/src/app.ts`).link(`${WORKTREE}/SRC`, `${WORKTREE}/src`);
    const verdict = refusal(confinement().confine('repo', 'read_file', 'SRC/app.ts', {
      in_scope: ['SRC/**'],
      out_of_scope: [],
    }));
    assert.equal(verdict.record.rule, 'mandate_in_scope');
    assert.equal(verdict.refusal, 'scope_violation');
  });

  test('a denied name reached in a different case is still denied', () => {
    fs.exists(`${WORKTREE}/.ENV`);
    const verdict = refusal(confinement().confine('repo', 'read_file', '.ENV', OPEN));
    assert.equal(
      verdict.record.deny_list_entry, 'secret_bearing_names',
      'the deny-list matches case-insensitively, which is restrictive in the other direction',
    );
  });
});
