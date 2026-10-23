import type { ToolGrant, ToolSurfaceReport } from '@intentra/contracts';
import { isSpawningToolName } from '../dispatch/tool-grants.js';

/**
 * The startup conformance check, as arithmetic over two sets.
 *
 * ARCHITECTURE_FREEZE D-2 carries one binding condition and this is the part of it that can
 * be tested without a model: **the effective tool set for a dispatch is exactly the adapter
 * operations the kernel exposed**, and an SDK upgrade that adds a tool must break this check
 * rather than pass quietly. Keeping the comparison here, pure and substrate-independent,
 * means the rule survives a change of substrate — the substrate supplies what it observed
 * and how it names things, and the verdict is computed the same way either side of the swap.
 *
 * Four properties matter more than the code:
 *
 * - **`UNVERIFIABLE` fails closed.** A surface that could not be observed is not a surface
 *   that is fine. The verdict exists so that "we could not check" is a distinct, refusable
 *   answer rather than an absence of complaint.
 * - **An advertised agent is refused without being called reach** (D-2, A-18). A name in the
 *   observed roster is not evidence that spawning is reachable — that question is answered by
 *   the effective tool list, and a session with no spawning tool cannot spawn whatever the
 *   roster says. It is refused because an Intentra session disables the harness's built-in
 *   roster at source, so a name arriving anyway means the surface is not the one that was
 *   configured, and a surface that is not the one that was configured is not one to dispatch
 *   into. The comparison learns no substrate's names to make that judgement.
 * - **An unmappable effective name appears verbatim.** A name the substrate cannot account
 *   for is reported as it was seen, never normalized into something recognizable, because
 *   normalizing is how an unexpected tool becomes an expected one.
 * - **`UNEXPECTED_TOOLS` outranks `MISSING_TOOLS`.** Reach the kernel did not grant is worse
 *   than reach it granted and did not get, and a surface that is wrong in both directions
 *   should be reported by its more dangerous half.
 */
export interface ObservedSurface {
  /** Every tool the substrate reports as effective for the session, as it names them. */
  readonly tools: readonly string[];
  /** Every agent the substrate advertises. Any at all contradicts the configuration. */
  readonly agents: readonly string[];
  /** Whatever else the substrate saw that a human reading the report would want. */
  readonly detail: string;
}

export interface SurfaceComparison {
  readonly substrate: string;
  readonly grants: readonly ToolGrant[];
  /** `null` where the surface could not be observed at all. */
  readonly observed: ObservedSurface | null;
  /** How this substrate names a granted operation on the wire. */
  readonly qualify: (toolName: string) => string;
}

export function evaluateSurface(comparison: SurfaceComparison): ToolSurfaceReport {
  const { substrate, grants, observed, qualify } = comparison;
  const expected = grants.map((grant) => grant.tool_name).sort();

  if (observed === null) {
    return {
      substrate,
      verdict: 'UNVERIFIABLE',
      expected,
      effective: [],
      unexpected: [],
      /* Everything granted is unaccounted for, because nothing was accounted for. Reporting
       * the grants as missing rather than as an empty comparison keeps the report readable
       * as what it is: no evidence, not evidence of absence. */
      missing: expected,
      detail:
        `${substrate} could not report its effective tool surface. D-2 requires the surface `
        + 'to be asserted before dispatch, and a surface that cannot be observed is not '
        + 'permission to dispatch',
    };
  }

  /* Granted name keyed by the name the substrate would use for it. */
  const fromWire = new Map<string, string>();
  for (const name of expected) fromWire.set(qualify(name), name);

  const effective: string[] = [];
  const unexpected: string[] = [];
  for (const seen of dedupe(observed.tools)) {
    const granted = fromWire.get(seen);
    if (granted === undefined) {
      /* Verbatim. A name nothing accounts for is reported as it arrived. */
      effective.push(seen);
      unexpected.push(seen);
      continue;
    }
    effective.push(granted);
  }

  /*
   * An advertised agent is not a tool and has no place in either set, so it is reported as an
   * unexpected entry under a prefix that cannot collide with a tool name. A-18: this is not
   * where W5 is held — the four spawning layers hold it, and an advertised name is metadata
   * the harness publishes about itself rather than a capability offered to the dispatch. It
   * is refused because an Intentra session asks the harness for no built-in agents at all, so
   * any name here contradicts the configuration the surface was supposed to have. Refusing
   * the whole set keeps this comparison free of every substrate's naming: there is no roster
   * to match against, no pattern, and nothing that a harness upgrade can age out of date.
   */
  for (const agent of dedupe(observed.agents)) unexpected.push(`agent:${agent}`);

  /*
   * The third layer of the spawning rule. The first refuses to build such a grant; the
   * second is the substrate's own permission callback; this one refuses a surface that
   * carries such a name however it got there, including one the kernel itself granted.
   */
  for (const name of dedupe([...expected, ...observed.tools])) {
    if (isSpawningToolName(name) && !unexpected.includes(name)) unexpected.push(name);
  }

  const missing = expected.filter((name) => !effective.includes(name));

  if (unexpected.length > 0) {
    return {
      substrate,
      verdict: 'UNEXPECTED_TOOLS',
      expected,
      effective: effective.sort(),
      unexpected: unexpected.sort(),
      missing: missing.sort(),
      detail:
        `${substrate} reports reach the kernel did not grant: ${unexpected.sort().join(', ')}. `
        + 'The tool surface is an allowlist, so anything outside it is a violation and not a '
        + `preference. ${observed.detail}`,
    };
  }

  if (missing.length > 0) {
    return {
      substrate,
      verdict: 'MISSING_TOOLS',
      expected,
      effective: effective.sort(),
      unexpected: [],
      missing: missing.sort(),
      detail:
        `${substrate} did not offer every granted operation: ${missing.sort().join(', ')} are `
        + 'absent. A dispatch that cannot reach what it was granted would report gaps as '
        + `findings about the system rather than about itself. ${observed.detail}`,
    };
  }

  return {
    substrate,
    verdict: 'CONFORMS',
    expected,
    effective: effective.sort(),
    unexpected: [],
    missing: [],
    detail:
      `${substrate} reports exactly the ${expected.length} granted operation(s) and no `
      + `subagents. ${observed.detail}`,
  };
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
