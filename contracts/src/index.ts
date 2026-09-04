/**
 * `@agentos/contracts` — the stable surface of AgentOS.
 *
 * Every shape in the system, defined once. JSON Schema in `contracts/schema/` is the source
 * of truth; the TypeScript types are generated from it and the validators are compiled from
 * it, so there is exactly one definition of every shape.
 *
 * This package depends on nothing. That is enforced by its manifest declaring no
 * dependencies rather than by anyone remembering — a contract that imports a kernel type has
 * coupled the two sides together permanently.
 */

export type * from './generated/types.js';
export { ALL_SCHEMAS, SCHEMA_ID } from './generated/schemas.js';
export * from './validate.js';
export * from './vocab.js';
export * from './ids.js';
export type * from './ports.js';
export * as fixtures from './fixtures.js';
export type { JsonSchema, JsonSchemaObject, JsonValue } from './validator/types.js';
export { SchemaRegistry } from './validator/validator.js';
