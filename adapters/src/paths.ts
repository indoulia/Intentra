import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { PathPolicy, PathRefusal } from '@agentos/contracts';
import { firstMatch, matchesAny, matchesGlob, specificity, toPosix } from './glob.js';

/**
 * The two filesystem questions confinement asks, behind a seam.
 *
 * Not for tidiness: **every branch below is a case a real filesystem can only be made to
 * produce with privileges some hosts withhold.** A symlink pointing out of the worktree, a
 * two-hop chain, a link whose target is gone, a directory this process may not traverse, a
 * cycle, a path that resolves to one place and then to another — these are the assertions
 * this work package exists for, and a suite that skipped them on an unprivileged host would
 * be reporting green for the thing it was written to catch. The seam makes them assertable
 * everywhere; the real-filesystem tests then run as a second layer rather than as the only
 * one.
 *
 * Both methods throw the way `node:fs` throws: an `Error` carrying an errno `code`. The
 * caller reads the code, so a fake that reports `EACCES` produces exactly the refusal a
 * genuinely unreadable directory would.
 */
export interface FileSystemProbe {
  /** The canonical, absolute path with every symlink followed. */
  realpath(path: string): string;
  /** True when the entry exists and is a symbolic link. */
  isSymbolicLink(path: string): boolean;
}

/** The real filesystem. `realpathSync.native` because the OS resolution is the one that counts. */
export const NODE_FILESYSTEM: FileSystemProbe = {
  realpath(path: string): string {
    return realpathSync.native(path);
  },
  isSymbolicLink(path: string): boolean {
    return lstatSync(path).isSymbolicLink();
  },
};

/**
 * Path confinement — the enforcement point for the containment claim.
 *
 * Worktree isolation is a claim, and a claim needs somewhere it is actually checked
 * (REPOSITORY_ADAPTER 2.1). Every path argument that reaches an adapter passes through here
 * first: expanded, normalized, `..` collapsed, symlinks followed to a real path, and then
 * checked against the worktree root, the dispatch's mandate, and the absolute deny-list —
 * the third **even for paths that pass the first two**, because rules 1 and 2 depend on
 * correctly computing a root and a scope and rule 3 is what holds when they are wrong.
 *
 * The governing rule everywhere below is that **ambiguity is refusal**. A path whose real
 * location cannot be established — a broken symlink, a symlink loop, a directory the process
 * cannot enter, a Windows 8.3 alias, a percent-encoded segment, a device path — is refused
 * rather than resolved on a best guess. Every one of those is a way to make a check pass
 * against a string that names something other than the file that would be opened, and the
 * only safe answer to "I could not tell what this points at" is no.
 */

export type PathRefusalKind = 'scope_violation' | 'security_violation';

export type PathVerdict =
  | {
    readonly outcome: 'ALLOWED';
    /** The real, canonical, absolute path. This is what an operation must open. */
    readonly resolved: string;
    /** Its `/`-separated path relative to the worktree root, for logs and coverage. */
    readonly relative: string;
    readonly exists: boolean;
  }
  | {
    readonly outcome: 'REFUSED';
    readonly refusal: PathRefusalKind;
    /** The frozen `PathRefusal` shape, ready to be logged as its event. */
    readonly record: PathRefusal;
  };

export interface MandateScope {
  readonly in_scope: readonly string[];
  readonly out_of_scope: readonly string[];
}

export interface ConfinementOptions {
  /** The worktree a dispatch may reach. Resolved once, at construction. */
  readonly worktreeRoot: string;
  /** The AgentOS installation, which the deny-list is relative to. */
  readonly installationRoot: string;
  /** The user's home directory, which the credential deny patterns are relative to. */
  readonly home: string;
  readonly paths: PathPolicy;
  /** Defaults to the real filesystem. Injected so every refusal branch is assertable. */
  readonly fs?: FileSystemProbe;
}

/** Windows reserved device names. Opening one of these does not open a file. */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** `PROGRA~1` and friends: an alias for a name the check would otherwise be applied to. */
const SHORT_NAME = /^[^.\\/]{1,6}~\d+(\.[^.\\/]{1,3})?$/;

/** A colon that is not the drive-letter colon: an alternate data stream, or a stream alias. */
function hasStreamColon(path: string): boolean {
  const withoutDrive = /^[A-Za-z]:[\\/]/.test(path) ? path.slice(2) : path;
  return withoutDrive.includes(':');
}

interface RealPathOk {
  readonly ok: true;
  readonly real: string;
  readonly exists: boolean;
  /** True when a symlink was traversed to get here, so an escape can name the reason. */
  readonly followed: boolean;
}

interface RealPathFailure {
  readonly ok: false;
  readonly rule: PathRefusal['rule'];
  readonly detail: string;
}

/**
 * Resolves a path to its real location, or explains why it cannot be resolved.
 *
 * A path that does not exist yet is still resolvable: its longest existing ancestor is
 * canonicalized and the missing tail appended, which is what makes a write to a new file
 * checkable before the file is there. What is *not* resolvable is an ancestor that exists as
 * a link pointing at nothing, a loop, or an entry the process may not stat — and each of
 * those returns a failure rather than a guess.
 */
function realPathOf(target: string, fs: FileSystemProbe): RealPathOk | RealPathFailure {
  try {
    const real = fs.realpath(target);
    return { ok: true, real, exists: true, followed: real !== target };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      return {
        ok: false,
        rule: 'symlink_escape',
        detail: 'the path is a symbolic link cycle, so it names no file at all',
      };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        ok: false,
        rule: 'unresolvable',
        detail:
          'the path cannot be canonicalized because the process may not traverse it. An '
          + 'unreadable path is an unverifiable path, and an unverifiable path is refused',
      };
    }
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return {
        ok: false,
        rule: 'unresolvable',
        detail: `the path cannot be canonicalized (${String(code)})`,
      };
    }
  }

  /*
   * ENOENT/ENOTDIR: something on the way does not exist. Walk up to the deepest ancestor
   * that does, canonicalizing that, and re-attach the missing tail. Each step first asks
   * whether the entry exists *as a link*, because a link whose target is gone is exactly the
   * case that must not be silently treated as "not there yet".
   */
  const missing: string[] = [];
  let current = target;
  for (let depth = 0; depth < 64; depth += 1) {
    let link = false;
    try {
      link = fs.isSymbolicLink(current);
      if (!link) {
        /* It exists and is not a link, yet realpath failed above: a component below it is
         * not a directory. Ambiguous, so refused. */
        const real = fs.realpath(current);
        return { ok: true, real: join(real, ...missing), exists: false, followed: real !== current };
      }
      return {
        ok: false,
        rule: 'symlink_escape',
        detail:
          'the path traverses a symbolic link whose target does not exist. A broken link '
          + 'cannot be checked against the worktree, the mandate or the deny-list, so it is '
          + 'refused rather than resolved to where it might one day point',
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        return {
          ok: false,
          rule: 'unresolvable',
          detail:
            'an ancestor of the path cannot be inspected by this process, so where the path '
            + 'really leads cannot be established',
        };
      }
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return {
          ok: false,
          rule: 'unresolvable',
          detail: `an ancestor of the path cannot be inspected (${String(code)})`,
        };
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }

  return {
    ok: false,
    rule: 'unresolvable',
    detail:
      'no existing ancestor of the path could be found within the traversal bound, so the '
      + 'path cannot be anchored to a real location',
  };
}

/** True when `child` is `parent` or lies beneath it, compared on canonical paths. */
function isUnder(child: string, parent: string): boolean {
  const a = toPosix(child).replace(/\/+$/, '');
  const b = toPosix(parent).replace(/\/+$/, '');
  if (a === b) return true;
  return a.startsWith(`${b}/`);
}

/** The `/`-separated path of `child` relative to `parent`, or `.` for the root itself. */
function relativeUnder(child: string, parent: string): string {
  const a = toPosix(child).replace(/\/+$/, '');
  const b = toPosix(parent).replace(/\/+$/, '');
  if (a === b) return '.';
  return a.slice(b.length + 1);
}

export class PathConfinement {
  readonly worktreeRoot: string;
  readonly installationRoot: string;
  readonly home: string;
  readonly #policy: PathPolicy;
  readonly #fs: FileSystemProbe;

  constructor(options: ConfinementOptions) {
    this.#fs = options.fs ?? NODE_FILESYSTEM;
    /*
     * The roots are canonicalized once. Comparing a canonical path against a root that is
     * itself a symlink would make every path under the worktree look like an escape, and
     * comparing against an uncanonicalized root would make an escape look like a path under
     * it. Where a root does not exist, the resolved-but-uncanonicalized form is kept: a
     * confinement against a missing root refuses everything, which is the safe end.
     */
    this.worktreeRoot = this.#canonicalRoot(options.worktreeRoot);
    this.installationRoot = this.#canonicalRoot(options.installationRoot);
    this.home = this.#canonicalRoot(options.home);
    this.#policy = options.paths;
  }

  #canonicalRoot(root: string): string {
    const absolute = resolve(root);
    try {
      return this.#fs.realpath(absolute);
    } catch {
      return absolute;
    }
  }

  /**
   * The whole sequence, in the order REPOSITORY_ADAPTER 2.1 states it.
   *
   * `adapter` and `op` are carried so a refusal is a complete `PathRefusal` the moment it is
   * produced, rather than a boolean somebody later has to explain.
   */
  confine(
    adapter: string,
    op: string,
    requested: unknown,
    mandate: MandateScope,
  ): PathVerdict {
    if (typeof requested !== 'string' || requested.trim().length === 0) {
      return this.#refuse(adapter, op, String(requested), null, 'unresolvable', null,
        'a path argument must be a non-empty string; an empty or non-string path names '
        + 'nothing and cannot be checked');
    }

    const ambiguity = PathConfinement.#ambiguity(requested);
    if (ambiguity !== null) {
      return this.#refuse(adapter, op, requested, null, 'unresolvable', null, ambiguity);
    }

    const expanded = this.#expand(requested);

    /*
     * A relative path is relative to the worktree, which is the only root a dispatch has. An
     * absolute path is taken as written and then checked — it is not rejected out of hand,
     * because the worktree root is itself absolute and an operation may legitimately be
     * handed a full path to a file inside it.
     */
    const anchored = isAbsolute(expanded) ? resolve(expanded) : resolve(this.worktreeRoot, expanded);

    /* Where the path points before symlinks are followed, so an escape can say which kind. */
    const lexicallyInside = isUnder(anchored, this.worktreeRoot);

    const real = realPathOf(anchored, this.#fs);
    if (!real.ok) {
      return this.#refuse(adapter, op, requested, anchored, real.rule, null, real.detail);
    }

    /* 1. The worktree root. */
    if (!isUnder(real.real, this.worktreeRoot)) {
      const viaLink = lexicallyInside;
      return this.#refuse(
        adapter, op, requested, real.real,
        viaLink ? 'symlink_escape' : 'worktree_root', null,
        viaLink
          ? 'the path lies inside the worktree but resolves through a symbolic link to a '
            + 'target outside it. Symlink targets are checked, not just link paths'
          : 'the resolved path is outside the worktree root. Work happens in a dedicated '
            + 'worktree, and the containment claim is enforced here rather than left to the '
            + 'receiving agent',
      );
    }

    const relative = relativeUnder(real.real, this.worktreeRoot);

    /* 2. The mandate. `out_of_scope` first: an exclusion beats an inclusion. */
    const excluded = firstMatch(relative, mandate.out_of_scope, false);
    if (excluded !== null) {
      return this.#refuse(
        adapter, op, requested, real.real, 'mandate_out_of_scope', null,
        `the path matches the dispatch mandate's out_of_scope pattern ${excluded}`,
      );
    }
    if (!matchesAny(relative, mandate.in_scope, true)) {
      return this.#refuse(
        adapter, op, requested, real.real, 'mandate_in_scope', null,
        mandate.in_scope.length === 0
          ? 'the dispatch mandate admits no paths at all, so every path argument is out of '
            + 'scope. An absent scope is not an unlimited one'
          : `the path is not covered by the dispatch mandate's in_scope patterns `
            + `(${mandate.in_scope.join(', ')})`,
      );
    }

    /* 3. The absolute deny-list, checked even though 1 and 2 passed. */
    const denied = this.denyMatch(real.real);
    if (denied !== null) {
      return this.#refuse(
        adapter, op, requested, real.real, 'deny_list', denied.id,
        `the path matches deny-list entry ${denied.id} (${denied.pattern}). ${denied.description}`,
      );
    }

    return { outcome: 'ALLOWED', resolved: real.real, relative, exists: real.exists };
  }

  /**
   * Which deny-list entry a canonical path matches, or `null`.
   *
   * All four `kind`s in `paths.json` are distinct and all four are checked:
   * `installation_relative` against the AgentOS installation, `home_relative` against the
   * user's home, `absolute` against the path as written, and `name_anywhere` against every
   * segment — the last of which is why a `.env` **inside** the worktree is refused for a read
   * and not only for a write.
   */
  denyMatch(
    resolved: string,
  ): { readonly id: string; readonly pattern: string; readonly description: string } | null {
    const posix = toPosix(resolved);
    const segments = posix.split('/').filter((s) => s.length > 0);
    const matches: { id: string; pattern: string; description: string }[] = [];

    for (const entry of this.#policy.deny) {
      switch (entry.kind) {
        case 'installation_relative': {
          if (!isUnder(resolved, this.installationRoot)) break;
          const pattern = firstMatch(
            relativeUnder(resolved, this.installationRoot), entry.patterns, false,
          );
          if (pattern !== null) {
            matches.push({ id: entry.id, pattern, description: entry.description });
          }
          break;
        }
        case 'home_relative': {
          if (!isUnder(resolved, this.home)) break;
          const pattern = firstMatch(
            relativeUnder(resolved, this.home), entry.patterns, false,
          );
          if (pattern !== null) {
            matches.push({ id: entry.id, pattern, description: entry.description });
          }
          break;
        }
        case 'absolute': {
          /* Absolute patterns are written with `/` and, on Windows, a drive letter. Both the
           * full path and its drive-less form are offered, so `/etc/shadow` still matches on
           * a host that reports it under a drive. */
          const driveless = posix.replace(/^[A-Za-z]:/, '');
          const pattern = firstMatch(posix, entry.patterns, false)
            ?? firstMatch(driveless, entry.patterns, false);
          if (pattern !== null) {
            matches.push({ id: entry.id, pattern, description: entry.description });
          }
          break;
        }
        case 'name_anywhere': {
          for (const pattern of entry.patterns) {
            if (segments.some((segment) => matchesGlob(segment, pattern, false))) {
              matches.push({ id: entry.id, pattern, description: entry.description });
            }
          }
          break;
        }
        default: {
          /* An unrecognized deny kind is a policy this adapter cannot evaluate. Treating it
           * as matching is the only fail-closed reading: a rule nobody enforces is worse
           * than a rule nobody wrote. */
          matches.push({
            id: entry.id,
            pattern: '**',
            description:
              'the deny-list entry declares a kind this adapter cannot evaluate, so it is '
              + 'treated as matching. A rule that cannot be checked is not a rule that passes',
          });
          break;
        }
      }
    }

    if (matches.length === 0) return null;

    /*
     * Several entries can match one path — `agentos_installation` is `**` and covers
     * everything under the installation, so a write under `state/` matches both it and
     * `agentos_state`. The refusal is identical either way; only the message differs, and a
     * message naming the backstop instead of the rule sends someone to the wrong file. So
     * the most specific matched pattern, counted in literal characters, is the one reported.
     */
    let best = matches[0] as { id: string; pattern: string; description: string };
    for (const candidate of matches) {
      if (specificity(candidate.pattern) > specificity(best.pattern)) best = candidate;
    }
    return best;
  }

  /**
   * The canonicalization ambiguities, each of which makes the string and the file disagree.
   *
   * Returns the reason to refuse, or `null` when the path is unambiguous.
   */
  static #ambiguity(requested: string): string | null {
    if (requested.includes('\0')) {
      return 'the path contains a NUL byte, which truncates it for some callers and not for '
        + 'others';
    }
    if (requested.includes('%')) {
      return 'the path contains a percent sign. Percent-encoded segments (%2e%2e, %2f) and '
        + 'Windows %VAR% expansions both make a path mean something other than what it says, '
        + 'and neither can be distinguished from a literal percent without guessing';
    }
    if (/^\\\\[?.]\\/.test(requested)) {
      return 'the path is a Win32 device path, which bypasses the normalization every check '
        + 'here depends on';
    }
    if (/^([\\/]){2}/.test(requested)) {
      /*
       * A UNC share is never under a local worktree root, so this would be refused anyway —
       * but canonicalizing it first would reach the network to find that out, which is both
       * slow and an outward reach nobody asked for. Refusing on the shape is the same answer
       * without the request.
       */
      return 'the path names a UNC network share, which is outside every local worktree root '
        + 'and would have to be reached over the network to be canonicalized at all';
    }
    if (/^[A-Za-z]:(?![\\/])/.test(requested)) {
      return 'the path is drive-relative (a drive letter with no separator), so where it '
        + 'points depends on a per-drive current directory this process does not control';
    }
    if (hasStreamColon(requested)) {
      return 'the path contains a colon outside a drive specifier, which names an alternate '
        + 'data stream rather than the file the checks would be applied to';
    }
    const segments = toPosix(requested).split('/');
    for (const segment of segments) {
      if (segment.length === 0 || segment === '.' || segment === '..') continue;
      if (SHORT_NAME.test(segment)) {
        return `the segment ${segment} is an 8.3 short-name alias. Two different long names `
          + 'can share one alias, so a deny-list check against it proves nothing';
      }
      if (/[ .]$/.test(segment)) {
        return `the segment ${segment} ends in a space or a dot, which some filesystems strip `
          + 'and others keep, so the name checked is not necessarily the name opened';
      }
      const stem = segment.split('.')[0]?.toLowerCase() ?? '';
      if (RESERVED.has(stem)) {
        return `the segment ${segment} is a reserved device name, which names a device rather `
          + 'than a file';
      }
    }
    return null;
  }

  /** `~` and `~/…` only. Nothing else is expanded, because nothing else is unambiguous. */
  #expand(requested: string): string {
    if (requested === '~') return this.home;
    if (requested.startsWith('~/') || requested.startsWith('~\\')) {
      return join(this.home, requested.slice(2));
    }
    return requested;
  }

  #refuse(
    adapter: string,
    op: string,
    requested: string,
    resolved: string | null,
    rule: PathRefusal['rule'],
    denyListEntry: string | null,
    detail: string,
  ): PathVerdict {
    /*
     * Which refusals are security violations: everything except failing the dispatch's own
     * mandate. REPOSITORY_ADAPTER 2.1 splits them exactly there — an in-scope failure is a
     * `scope_violation`, and the deny-list or an escape attempt is a `security_violation`,
     * which aborts the dispatch and is reported regardless of the run's outcome.
     */
    const security = rule !== 'mandate_in_scope' && rule !== 'mandate_out_of_scope';
    return {
      outcome: 'REFUSED',
      refusal: security ? 'security_violation' : 'scope_violation',
      record: {
        adapter,
        op,
        requested,
        resolved,
        rule,
        deny_list_entry: denyListEntry,
        aborted_dispatch: security,
        detail,
      },
    };
  }
}
