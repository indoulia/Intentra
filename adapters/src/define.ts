import type { AdapterOperationDescriptor, EvidenceKind, Gate } from '@agentos/contracts';
import type { OperationHandler, OperationRegistration } from './descriptors.js';

/**
 * How an operation is declared, with every default failing closed.
 *
 * The descriptor is eleven fields and most operations differ in three of them, so the
 * boilerplate would otherwise be where a mistake hides. What this helper does *not* do is
 * supply a permissive default for anything that matters: `observation_safe` is `false` unless
 * the caller establishes otherwise, `external_destination` is `false` only because a
 * read-only operation that reaches outside must say so, and `mutating` has its own function
 * so that no operation becomes mutating by forgetting a flag.
 */

export interface ReadOnlyOperationInput {
  readonly adapter: string;
  readonly op: string;
  readonly description: string;
  /** JSON Schema properties. A path argument declares `format: 'path'` and is confined. */
  readonly args?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly evidenceKind: EvidenceKind;
  /**
   * Whether the kernel may replay this to verify evidence. Stated explicitly at every call
   * site: an operation whose observation safety cannot be established is `false`, and the way
   * to keep that true is to never let it be the value nobody typed.
   */
  readonly observationSafe: boolean;
  readonly incidentalArtifacts?: readonly string[];
  readonly externalDestination?: boolean;
  readonly gates?: readonly Gate[];
  readonly handler: OperationHandler;
}

function argsSchema(
  properties: Readonly<Record<string, unknown>> | undefined,
  required: readonly string[] | undefined,
): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    properties: properties ?? {},
    required: [...(required ?? [])],
    /*
     * An argument the descriptor did not declare was never granted. Refusing it is what makes
     * `args_schema` the tool surface rather than a description of it.
     */
    additionalProperties: false,
  };
}

export function readOnlyOperation(input: ReadOnlyOperationInput): OperationRegistration {
  const descriptor: AdapterOperationDescriptor = {
    adapter: input.adapter,
    op: input.op,
    description: input.description,
    mutating: false,
    reversal: null,
    idempotent_by_key: false,
    identity_args: [],
    external_destination: input.externalDestination ?? false,
    observation_safe: input.observationSafe,
    incidental_artifacts: [...(input.incidentalArtifacts ?? [])],
    args_schema: argsSchema(input.args, input.required),
    gates: [...(input.gates ?? [])],
  };
  return { descriptor, evidenceKind: input.evidenceKind, handler: input.handler };
}

export interface MutatingOperationInput extends Omit<ReadOnlyOperationInput, 'observationSafe'> {
  /** The operation that undoes it, or `null` for a genuinely non-reversible one. */
  readonly reversal: AdapterOperationDescriptor['reversal'];
  readonly idempotentByKey: boolean;
  readonly identityArgs: readonly string[];
  readonly gates: readonly Gate[];
  readonly captureBefore: NonNullable<OperationRegistration['captureBefore']>;
}

/**
 * A mutating operation.
 *
 * Separate from `readOnlyOperation` on purpose. `mutating: true` is never a flag someone
 * flips on an existing declaration; it is a different call, with a reversal, a gate set and a
 * `captureBefore` all required by the type. And registering one is still refused while
 * `policies/execution.json` says `mutation_enabled: false`, which is what makes milestone 1's
 * "no mutating operation is registered" a fact rather than an intention.
 */
export function mutatingOperation(input: MutatingOperationInput): OperationRegistration {
  const descriptor: AdapterOperationDescriptor = {
    adapter: input.adapter,
    op: input.op,
    description: input.description,
    mutating: true,
    reversal: input.reversal,
    idempotent_by_key: input.idempotentByKey,
    identity_args: [...input.identityArgs],
    external_destination: input.externalDestination ?? false,
    observation_safe: false,
    incidental_artifacts: [...(input.incidentalArtifacts ?? [])],
    args_schema: argsSchema(input.args, input.required),
    gates: [...input.gates],
  };
  return {
    descriptor,
    evidenceKind: input.evidenceKind,
    handler: input.handler,
    captureBefore: input.captureBefore,
  };
}

/** The schema fragment for a path argument, so `format: 'path'` is never mistyped. */
export const PATH_ARG = Object.freeze({ type: 'string', minLength: 1, format: 'path' });
export const STRING_ARG = Object.freeze({ type: 'string', minLength: 1 });
export const OPTIONAL_STRING_ARG = Object.freeze({ type: 'string' });
export const INTEGER_ARG = Object.freeze({ type: 'integer', minimum: 1 });

/**
 * A list of path arguments.
 *
 * `items.format: 'path'` is what the framework reads to decide an argument names paths, and
 * it confines every element before the handler sees any of them. A path argument that arrives
 * as a list is still a path argument: declaring the list any other way would take the
 * confinement off exactly the arguments that need it most.
 */
export const PATH_LIST_ARG = Object.freeze({ type: 'array', items: PATH_ARG });

/**
 * A list of glob patterns.
 *
 * Not path arguments, and deliberately so. A pattern like `**` + `/package.json` is not a path
 * and cannot be resolved to one, so confining it is meaningless; what makes a glob safe is
 * that it is only ever matched against entries an operation has *already* enumerated beneath
 * a root the confinement layer approved. `repo.find_files` has declared its `glob` this way
 * since it was written, and this is the same rule applied to a list of them.
 */
export const GLOB_LIST_ARG = Object.freeze({ type: 'array', items: STRING_ARG });

/** A list of opaque identifiers: capability names, repository names, search tokens. */
export const STRING_LIST_ARG = Object.freeze({ type: 'array', items: STRING_ARG });
