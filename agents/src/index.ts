/**
 * `@agentos/agents` — the dispatch boundary and the role specifications.
 *
 * Two things live here and nothing else. **The roles**, as specifications rather than
 * prompts: what each owns, what it must be given, what it owes back, and what model
 * properties its work needs. And **the boundary**, which is the one interface between the
 * kernel and a model: build a typed input package, run one fresh isolated session, assert
 * the tool surface against the grants before anything reaches the world, and return an
 * envelope the kernel will disbelieve until its checks pass.
 *
 * The package cannot reach `core/` — its manifest does not declare it, and the delete-core
 * test is run rather than quoted — and every outward reach is confined to
 * `substrate/claude-agent-sdk.ts`, which is the one file ARCHITECTURE_FREEZE D-2's reversal
 * clause wants a substrate swap to be a change to.
 */

export { MVP_ROLE_SPECS, PROPOSAL_KEYS } from './roles/specs.js';
export type { ProposalKey, RoleSpec } from './roles/specs.js';

export {
  AgentCatalogError,
  MvpAgentCatalog,
  orchestratorChoices,
  reachableStages,
} from './roles/catalog.js';

export {
  SPAWNING_TOOL_NAMES,
  ToolGrantError,
  grantsFor,
  isSpawningToolName,
  toolNameFor,
} from './dispatch/tool-grants.js';

export {
  buildInputPackage,
  materializeSections,
  unmaterializedSections,
} from './dispatch/input-package.js';
export type { DispatchRequest } from './dispatch/input-package.js';

export { renderDispatchBrief, renderSystemSpecification } from './dispatch/brief.js';
export { parseEnvelope } from './dispatch/envelope.js';
export type { EnvelopeParse } from './dispatch/envelope.js';

export { evaluateSurface } from './substrate/surface.js';
export type { ObservedSurface, SurfaceComparison } from './substrate/surface.js';

export type {
  DispatchTransport,
  TransportCost,
  TransportEvent,
  TransportFailure,
  TransportRequest,
  TransportSession,
  TransportTool,
  TransportToolResult,
} from './substrate/transport.js';

export { ClaudeAgentSdkSubstrate, ClaudeCodeTransport } from './substrate/claude-agent-sdk.js';
export type { ClaudeAgentSdkSubstrateOptions } from './substrate/claude-agent-sdk.js';
