/**
 * `@agentos/policies` — declarative, human-readable, versioned in git.
 *
 * Policy is data the kernel enforces, not behaviour an agent is asked to remember. This is
 * the difference between a safeguard and a suggestion. The package holds the data in
 * `data/` and the loader that refuses a mis-authored policy set at startup rather than
 * mid-run.
 */
export { loadPolicies, checkFloor, PolicyLoadError } from './load.js';
export type { PolicySet, PolicyProblem } from './load.js';
export {
  checkWellFormed,
  dominates,
  postDominates,
  reachable,
  incoming,
  outgoing,
  withoutStages,
  exclusionSubsets,
  predicateOf,
} from './graph.js';
export type { GraphView, WellFormedness } from './graph.js';
export { PolicyDataSource, PolicyDataError } from './data-source.js';
