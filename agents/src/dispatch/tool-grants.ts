import type {
  AdapterOperationDescriptor,
  AgentSpecView,
  ToolGrant,
} from '@agentos/contracts';

/**
 * Turning permitted adapter operations into the dispatch's tool surface.
 *
 * `tools_granted` is the allowlist ARCHITECTURE_FREEZE D-2 requires and the set the startup
 * conformance check compares the substrate's effective surface against. It is built here,
 * once, from three inputs and nothing else: the operations the adapter registry declares,
 * the adapters the role's policy entry permits, and whether the role is read-only.
 *
 * Every rule below fails closed. An operation whose adapter is not named is absent rather
 * than denied; an operation the registry declares `mutating` never reaches a read-only role;
 * a name that could be a way to start another agent is refused outright rather than
 * inspected further. The result is that widening a surface takes an edit to policy data or
 * to an adapter descriptor, and never an edit here.
 */
export class ToolGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolGrantError';
  }
}

/**
 * Names that mean "start another agent" on some substrate, in lower case.
 *
 * SKILL_AND_MODEL_SELECTION asks for three layers on exactly this rule, "because this one is
 * substrate-dependent and easy to reintroduce accidentally". This is the first: no adapter
 * operation may ever be exposed under one of these names, whatever its descriptor says.
 * Invariant W5 is that no agent may invoke another agent, and a tool that spawns a subagent
 * is that violation wearing a tool's clothing.
 */
export const SPAWNING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'task',
  'agent',
  'agents',
  'subagent',
  'sendmessage',
]);

/**
 * Fragments that mean spawning wherever they appear in a name.
 *
 * Kept to two, and both unambiguous. A wider list would refuse honest operations —
 * `pm__create_task` creates a ticket and starts nothing — and a rule that refuses honest
 * work gets relaxed by whoever meets it next, which is how a safety check stops being one.
 */
const SPAWNING_FRAGMENTS: readonly string[] = ['spawn', 'subagent'];

/** The tool name an adapter operation is exposed as. One shape, so a name is predictable. */
export function toolNameFor(adapter: string, op: string): string {
  return `${adapter}__${op}`;
}

/** True where the name is, or contains, a way to start another agent. */
export function isSpawningToolName(name: string): boolean {
  const lowered = name.toLowerCase();
  if (SPAWNING_TOOL_NAMES.has(lowered)) return true;
  return SPAWNING_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

/**
 * The grants a dispatch of this specification may hold.
 *
 * @param spec the assembled agent specification; its `permitted_adapters` and `read_only`
 *   come from policy, so this function has no policy of its own.
 * @param descriptors every operation the adapter registry declares.
 */
export function grantsFor(
  spec: AgentSpecView,
  descriptors: readonly AdapterOperationDescriptor[],
): readonly ToolGrant[] {
  const permitted = new Set(spec.permitted_adapters);
  const grants: ToolGrant[] = [];
  const seen = new Set<string>();

  for (const descriptor of descriptors) {
    if (!permitted.has(descriptor.adapter)) continue;
    /*
     * AGENT_ROLES states the read-only limit as an absolute — "never mutates anything: not a
     * file, not a branch, not a ticket, not a row". Enforcing it here as well as in the
     * adapter means a read-only role cannot even see the operation, which is a smaller
     * surface than one it can see and be refused for calling.
     */
    if (spec.read_only && descriptor.mutating) continue;

    const tool_name = toolNameFor(descriptor.adapter, descriptor.op);
    if (isSpawningToolName(tool_name)) {
      throw new ToolGrantError(
        `${descriptor.adapter}.${descriptor.op} would be exposed as ${tool_name}, which reads `
        + 'as a way to start another agent. No agent may invoke another agent, and a tool '
        + 'that could is refused before it is offered rather than after it is called',
      );
    }
    if (seen.has(tool_name)) {
      throw new ToolGrantError(
        `two operations would be exposed as ${tool_name}. A dispatch whose tool names collide `
        + 'cannot be reconciled against its call log, and the conformance check would compare '
        + 'a set against a smaller one and call it equal',
      );
    }
    seen.add(tool_name);

    grants.push({
      adapter: descriptor.adapter,
      op: descriptor.op,
      tool_name,
      description: descriptor.description,
      args_schema: descriptor.args_schema,
    });
  }

  /* Sorted so that two dispatches built from the same inputs produce the same allowlist, and
   * so that a conformance report reads the same way twice. */
  return Object.freeze(grants.sort((a, b) => a.tool_name.localeCompare(b.tool_name)));
}
