/**
 * A minimal, dependency-free JSON Schema 2020-12 validator.
 *
 * `@agentos/contracts` has zero dependencies by design (IMPLEMENTATION_PLAN section 2), so
 * the validator that compiles the schemas ships with them rather than being pulled in. The
 * supported keyword set is exactly what the AgentOS schemas use; an unsupported keyword is a
 * load-time error rather than a silently ignored constraint, because a constraint nobody
 * enforces is worse than one nobody wrote.
 */

/** One failed constraint, located by JSON Pointer into the instance. */
export interface ValidationError {
  /** JSON Pointer into the validated instance, e.g. `/findings/0/evidence`. */
  readonly instancePath: string;
  /** JSON Pointer into the schema that failed, e.g. `/properties/findings/items`. */
  readonly schemaPath: string;
  /** The keyword that rejected the instance. */
  readonly keyword: string;
  /** Human-readable explanation. */
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
}

/** A JSON Schema document, or a boolean schema. */
export type JsonSchema = boolean | JsonSchemaObject;

export interface JsonSchemaObject {
  readonly [keyword: string]: unknown;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
