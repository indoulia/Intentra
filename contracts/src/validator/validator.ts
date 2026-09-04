import type {
  JsonSchema,
  JsonSchemaObject,
  ValidationError,
  ValidationResult,
} from './types.js';

/** Keywords this validator implements. Anything else in a schema is a load-time error. */
const SUPPORTED = new Set([
  '$schema', '$id', '$comment', '$defs', '$ref',
  'title', 'description', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  'type', 'enum', 'const',
  'properties', 'required', 'additionalProperties', 'patternProperties', 'propertyNames',
  'minProperties', 'maxProperties', 'dependentRequired',
  'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'contains',
  'minContains', 'maxContains',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
  'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'unevaluatedProperties',
]);

/**
 * `default` is deliberately absent from the supported set. WP-1's "must not" list forbids a
 * contract carrying "a default that invents a value" — a schema default is exactly that, and
 * refusing the keyword is cheaper than auditing for it.
 */
const FORBIDDEN = new Map<string, string>([
  ['default', 'a schema default invents a value; AgentOS contracts state absence explicitly'],
  ['$dynamicRef', 'dynamic references are not supported'],
  ['$dynamicAnchor', 'dynamic anchors are not supported'],
  ['$anchor', 'plain-name anchors are not supported; use $defs pointers'],
]);

const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

type Instance = unknown;

interface Ctx {
  readonly errors: ValidationError[];
  /** Properties evaluated by subschemas, keyed by instance pointer. Feeds `unevaluatedProperties`. */
  readonly evaluated: Map<string, Set<string>>;
}

function typeOf(value: Instance): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return t;
}

function matchesType(value: Instance, type: string): boolean {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function deepEqual(a: Instance, b: Instance): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    if (!ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, Instance>)[k], (b as Record<string, Instance>)[k]),
    );
  }
  return false;
}

/**
 * `minLength` and `maxLength` count Unicode code points, not UTF-16 units, so a spread is
 * the correct decomposition here rather than a hazard: the schemas measure identifiers and
 * excerpts, and a surrogate pair is one character to the specification.
 */
function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * A set of schemas that can reference one another by `$id`. Compilation is eager: every
 * `$ref` is resolved when the registry is sealed, so a dangling reference fails at startup
 * rather than on the first instance that happens to reach it.
 */
export class SchemaRegistry {
  readonly #byId = new Map<string, JsonSchemaObject>();
  #sealed = false;

  add(schema: JsonSchemaObject): this {
    if (this.#sealed) throw new SchemaError('cannot add to a sealed registry');
    const id = schema['$id'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new SchemaError('every schema must declare a string $id');
    }
    if (this.#byId.has(id)) throw new SchemaError(`duplicate schema $id: ${id}`);
    this.#byId.set(id, schema);
    return this;
  }

  ids(): readonly string[] {
    return [...this.#byId.keys()].sort();
  }

  get(id: string): JsonSchemaObject {
    const s = this.#byId.get(id);
    if (s === undefined) throw new SchemaError(`no schema registered with $id ${id}`);
    return s;
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  /**
   * Walks every registered schema, rejecting unsupported or forbidden keywords and dangling
   * `$ref`s. Called once; after this the registry is immutable.
   */
  seal(): this {
    if (this.#sealed) return this;
    for (const [id, schema] of this.#byId) {
      this.#walk(schema, id, '');
    }
    this.#sealed = true;
    return this;
  }

  /*
   * `node` is `unknown` rather than `JsonSchema` on purpose: the schemas arrive as parsed
   * JSON, so the type is a claim about them and the walk is where the claim is checked.
   */
  #walk(raw: unknown, baseId: string, path: string): void {
    if (typeof raw === 'boolean') return;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SchemaError(`${baseId}#${path}: schema must be an object or boolean`);
    }
    const node = raw as JsonSchemaObject;
    for (const key of Object.keys(node)) {
      const forbidden = FORBIDDEN.get(key);
      if (forbidden !== undefined) {
        throw new SchemaError(`${baseId}#${path}: keyword "${key}" is forbidden - ${forbidden}`);
      }
      if (!SUPPORTED.has(key)) {
        throw new SchemaError(`${baseId}#${path}: unsupported keyword "${key}"`);
      }
    }
    const ref = node['$ref'];
    if (typeof ref === 'string') {
      this.#resolve(ref, baseId, `${baseId}#${path}`);
    }
    for (const key of ['properties', 'patternProperties', '$defs'] as const) {
      const sub = node[key];
      if (sub !== undefined) {
        if (typeof sub !== 'object' || sub === null || Array.isArray(sub)) {
          throw new SchemaError(`${baseId}#${path}/${key}: must be an object`);
        }
        for (const [name, child] of Object.entries(sub as Record<string, unknown>)) {
          this.#walk(child, baseId, `${path}/${key}/${escapePointer(name)}`);
        }
      }
    }
    for (const key of [
      'items', 'contains', 'not', 'if', 'then', 'else',
      'additionalProperties', 'propertyNames', 'unevaluatedProperties',
    ] as const) {
      const sub = node[key];
      if (sub !== undefined) this.#walk(sub, baseId, `${path}/${key}`);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const) {
      const sub = node[key];
      if (sub !== undefined) {
        if (!Array.isArray(sub)) {
          throw new SchemaError(`${baseId}#${path}/${key}: must be an array`);
        }
        sub.forEach((child, i) => {
          this.#walk(child, baseId, `${path}/${key}/${i}`);
        });
      }
    }
  }

  /** Resolves `$ref` against the registry. Supports `#/$defs/x`, `other.json`, `other.json#/$defs/x`. */
  #resolve(ref: string, baseId: string, where: string): JsonSchema {
    const hash = ref.indexOf('#');
    const uri = hash === -1 ? ref : ref.slice(0, hash);
    const pointer = hash === -1 ? '' : ref.slice(hash + 1);
    let target: JsonSchemaObject;
    if (uri === '') {
      target = this.get(baseId);
    } else {
      const absolute = uri.includes('://') ? uri : new URL(uri, baseId).href;
      if (!this.#byId.has(absolute)) {
        throw new SchemaError(`${where}: $ref "${ref}" resolves to unknown schema ${absolute}`);
      }
      target = this.get(absolute);
    }
    if (pointer === '') return target;
    if (!pointer.startsWith('/')) {
      throw new SchemaError(`${where}: $ref fragment "${pointer}" must be a JSON Pointer`);
    }
    let node: unknown = target;
    for (const rawToken of pointer.slice(1).split('/')) {
      const token = rawToken.replace(/~1/g, '/').replace(/~0/g, '~');
      if (node === null || typeof node !== 'object') {
        throw new SchemaError(`${where}: $ref "${ref}" does not resolve`);
      }
      node = (node as Record<string, unknown>)[token];
      if (node === undefined) {
        throw new SchemaError(`${where}: $ref "${ref}" does not resolve`);
      }
    }
    return node as JsonSchema;
  }

  /** Resolves a `$ref` at validation time. The registry is sealed, so this cannot fail. */
  deref(ref: string, baseId: string): JsonSchema {
    return this.#resolve(ref, baseId, `${baseId} (runtime)`);
  }

  /** Validates `instance` against the schema registered under `id`. */
  validate(id: string, instance: Instance): ValidationResult {
    if (!this.#sealed) this.seal();
    const ctx: Ctx = { errors: [], evaluated: new Map() };
    this.#validate(this.get(id), instance, id, '', '#', ctx);
    return { valid: ctx.errors.length === 0, errors: ctx.errors };
  }

  #note(ctx: Ctx, instancePath: string, name: string): void {
    let set = ctx.evaluated.get(instancePath);
    if (set === undefined) {
      set = new Set();
      ctx.evaluated.set(instancePath, set);
    }
    set.add(name);
  }

  #err(ctx: Ctx, e: ValidationError): void {
    ctx.errors.push(e);
  }

  #validate(
    schema: JsonSchema,
    instance: Instance,
    baseId: string,
    instancePath: string,
    schemaPath: string,
    ctx: Ctx,
  ): void {
    if (schema === true) return;
    if (schema === false) {
      this.#err(ctx, {
        instancePath, schemaPath, keyword: 'false',
        message: 'schema is false: no instance is valid here',
      });
      return;
    }
    const s = schema;

    const ref = s['$ref'];
    if (typeof ref === 'string') {
      const targetUri = ref.includes('#') ? ref.slice(0, ref.indexOf('#')) : ref;
      const nextBase = targetUri === ''
        ? baseId
        : (targetUri.includes('://') ? targetUri : new URL(targetUri, baseId).href);
      this.#validate(
        this.deref(ref, baseId), instance, nextBase, instancePath, `${schemaPath}/$ref`, ctx,
      );
    }

    const type = s['type'];
    if (type !== undefined) {
      const types = Array.isArray(type) ? (type as string[]) : [type as string];
      if (!types.some((t) => matchesType(instance, t))) {
        this.#err(ctx, {
          instancePath, schemaPath: `${schemaPath}/type`, keyword: 'type',
          message: `expected ${types.join(' or ')}, got ${typeOf(instance)}`,
        });
        return;
      }
    }

    const constValue = s['const'];
    if ('const' in s && !deepEqual(instance, constValue)) {
      this.#err(ctx, {
        instancePath, schemaPath: `${schemaPath}/const`, keyword: 'const',
        message: `must be ${JSON.stringify(constValue)}`,
      });
    }

    const enumValues = s['enum'];
    if (Array.isArray(enumValues) && !enumValues.some((v) => deepEqual(instance, v as Instance))) {
      this.#err(ctx, {
        instancePath, schemaPath: `${schemaPath}/enum`, keyword: 'enum',
        message: `must be one of ${enumValues.map((v) => JSON.stringify(v)).join(', ')}`,
      });
    }

    this.#applicators(s, instance, baseId, instancePath, schemaPath, ctx);

    const kind = typeOf(instance);
    if (kind === 'string') this.#strings(s, instance as string, instancePath, schemaPath, ctx);
    if (kind === 'number' || kind === 'integer') {
      this.#numbers(s, instance as number, instancePath, schemaPath, ctx);
    }
    if (kind === 'array') {
      this.#arrays(s, instance as Instance[], baseId, instancePath, schemaPath, ctx);
    }
    if (kind === 'object') {
      this.#objects(s, instance as Record<string, Instance>, baseId, instancePath, schemaPath, ctx);
    }
  }

  #applicators(
    s: JsonSchemaObject, instance: Instance, baseId: string,
    instancePath: string, schemaPath: string, ctx: Ctx,
  ): void {
    const allOf = s['allOf'];
    if (Array.isArray(allOf)) {
      allOf.forEach((sub, i) => {
        this.#validate(
          sub as JsonSchema, instance, baseId, instancePath, `${schemaPath}/allOf/${i}`, ctx,
        );
      });
    }

    const anyOf = s['anyOf'];
    if (Array.isArray(anyOf)) {
      const branchErrors = anyOf.map((sub, i) => {
        const probe: Ctx = { errors: [], evaluated: ctx.evaluated };
        this.#validate(
          sub as JsonSchema, instance, baseId, instancePath, `${schemaPath}/anyOf/${i}`, probe,
        );
        return probe.errors;
      });
      if (branchErrors.every((e) => e.length > 0)) {
        this.#err(ctx, {
          instancePath, schemaPath: `${schemaPath}/anyOf`, keyword: 'anyOf',
          message: `matched none of ${anyOf.length} alternatives: ${
            branchErrors.map((e) => e[0]?.message ?? 'invalid').join(' | ')}`,
        });
      }
    }

    const oneOf = s['oneOf'];
    if (Array.isArray(oneOf)) {
      const results = oneOf.map((sub, i) => {
        const probe: Ctx = { errors: [], evaluated: ctx.evaluated };
        this.#validate(
          sub as JsonSchema, instance, baseId, instancePath, `${schemaPath}/oneOf/${i}`, probe,
        );
        return probe.errors;
      });
      const passed = results.filter((e) => e.length === 0).length;
      if (passed !== 1) {
        this.#err(ctx, {
          instancePath, schemaPath: `${schemaPath}/oneOf`, keyword: 'oneOf',
          message: passed === 0
            ? `matched none of ${oneOf.length} alternatives: ${
              results.map((e) => e[0]?.message ?? 'invalid').join(' | ')}`
            : `matched ${passed} alternatives; exactly one is required`,
        });
      }
    }

    const not = s['not'];
    if (not !== undefined) {
      const probe: Ctx = { errors: [], evaluated: new Map() };
      this.#validate(not as JsonSchema, instance, baseId, instancePath, `${schemaPath}/not`, probe);
      if (probe.errors.length === 0) {
        this.#err(ctx, {
          instancePath, schemaPath: `${schemaPath}/not`, keyword: 'not',
          message: 'must not match the forbidden schema',
        });
      }
    }

    const ifSchema = s['if'];
    if (ifSchema !== undefined) {
      const probe: Ctx = { errors: [], evaluated: ctx.evaluated };
      this.#validate(
        ifSchema as JsonSchema, instance, baseId, instancePath, `${schemaPath}/if`, probe,
      );
      const branch = probe.errors.length === 0 ? s['then'] : s['else'];
      const label = probe.errors.length === 0 ? 'then' : 'else';
      if (branch !== undefined) {
        this.#validate(
          branch as JsonSchema, instance, baseId, instancePath, `${schemaPath}/${label}`, ctx,
        );
      }
    }
  }

  #strings(
    s: JsonSchemaObject, value: string, instancePath: string, schemaPath: string, ctx: Ctx,
  ): void {
    const minLength = s['minLength'];
    if (typeof minLength === 'number' && codePointLength(value) < minLength) {
      this.#err(ctx, {
        instancePath, schemaPath: `${schemaPath}/minLength`, keyword: 'minLength',
        message: `must be at least ${minLength} characters`,
      });
    }
    const maxLength = s['maxLength'];
    if (typeof maxLength === 'number' && codePointLength(value) > maxLength) {
      this.#err(ctx, {
        instancePath, schemaPath: `${schemaPath}/maxLength`, keyword: 'maxLength',
        message: `must be at most ${maxLength} characters`,
      });
    }
    const pattern = s['pattern'];
    if (typeof pattern === 'string' && !new RegExp(pattern, 'u').test(value)) {
      this.#err(ctx, {
        instancePath, schemaPath: `${schemaPath}/pattern`, keyword: 'pattern',
        message: `must match ${pattern}`,
      });
    }
    const format = s['format'];
    if (typeof format === 'string') {
      const ok = format === 'date-time'
        ? DATE_TIME.test(value)
        : format === 'uri'
          ? /^[a-z][a-z0-9+.-]*:/i.test(value)
          : true;
      if (!ok) {
        this.#err(ctx, {
          instancePath, schemaPath: `${schemaPath}/format`, keyword: 'format',
          message: `must be a valid ${format}`,
        });
      }
    }
  }

  #numbers(
    s: JsonSchemaObject, value: number, instancePath: string, schemaPath: string, ctx: Ctx,
  ): void {
    const checks: ReadonlyArray<
      readonly [string, (limit: number) => boolean, (limit: number) => string]
    > = [
      ['minimum', (l) => value < l, (l) => `must be >= ${l}`],
      ['maximum', (l) => value > l, (l) => `must be <= ${l}`],
      ['exclusiveMinimum', (l) => value <= l, (l) => `must be > ${l}`],
      ['exclusiveMaximum', (l) => value >= l, (l) => `must be < ${l}`],
    ];
    for (const [keyword, fails, message] of checks) {
      const limit = s[keyword];
      if (typeof limit === 'number' && fails(limit)) {
        this.#err(ctx, {
          instancePath, schemaPath: `${schemaPath}/${keyword}`, keyword, message: message(limit),
        });
      }
    }
    const multipleOf = s['multipleOf'];
    if (typeof multipleOf === 'number' && multipleOf > 0) {
      const quotient = value / multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        this.#err(ctx, {
          instancePath, schemaPath: `${schemaPath}/multipleOf`, keyword: 'multipleOf',
          message: `must be a multiple of ${multipleOf}`,
        });
      }
    }
  }

  #arrays(
    s: JsonSchemaObject, value: Instance[], baseId: string,
    instancePath: string, schemaPath: string, ctx: Ctx,
  ): void {
    const prefixItems = s['prefixItems'];
    let prefixCount = 0;
    if (Array.isArray(prefixItems)) {
      prefixCount = Math.min(prefixItems.length, value.length);
      for (let i = 0; i < prefixCount; i += 1) {
        this.#validate(
          prefixItems[i] as JsonSchema, value[i], baseId,
          `${instancePath}/${i}`, `${schemaPath}/prefixItems/${i}`, ctx,
        );
      }
    }
    const items = s['items'];
    if (items !== undefined) {
      for (let i = prefixCount; i < value.length; i += 1) {
        this.#validate(
          items as JsonSchema, value[i], baseId,
          `${instancePath}/${i}`, `${schemaPath}/items`, ctx,
        );
      }
    }
    const minItems = s['minItems'];
    if (typeof minItems === 'number' && value.length < minItems) {
      this.#err(ctx, {
        instancePath, schemaPath: `${schemaPath}/minItems`, keyword: 'minItems',
        message: `must contain at least ${minItems} item(s)`,
      });
    }
    const maxItems = s['maxItems'];
    if (typeof maxItems === 'number' && value.length > maxItems) {
      this.#err(ctx, {
        instancePath, schemaPath: `${schemaPath}/maxItems`, keyword: 'maxItems',
        message: `must contain at most ${maxItems} item(s)`,
      });
    }
    if (s['uniqueItems'] === true) {
      for (let i = 0; i < value.length; i += 1) {
        for (let j = i + 1; j < value.length; j += 1) {
          if (deepEqual(value[i], value[j])) {
            this.#err(ctx, {
              instancePath, schemaPath: `${schemaPath}/uniqueItems`, keyword: 'uniqueItems',
              message: `items ${i} and ${j} are duplicates`,
            });
          }
        }
      }
    }
    const contains = s['contains'];
    if (contains !== undefined) {
      const matches = value.filter((item, i) => {
        const probe: Ctx = { errors: [], evaluated: new Map() };
        this.#validate(
          contains as JsonSchema, item, baseId,
          `${instancePath}/${i}`, `${schemaPath}/contains`, probe,
        );
        return probe.errors.length === 0;
      }).length;
      const min = typeof s['minContains'] === 'number' ? s['minContains'] : 1;
      const max = typeof s['maxContains'] === 'number'
        ? s['maxContains']
        : Number.POSITIVE_INFINITY;
      if (matches < min || matches > max) {
        this.#err(ctx, {
          instancePath, schemaPath: `${schemaPath}/contains`, keyword: 'contains',
          message: `expected between ${min} and ${
            max === Number.POSITIVE_INFINITY ? 'any number of' : max
          } matching items, found ${matches}`,
        });
      }
    }
  }

  #objects(
    s: JsonSchemaObject, value: Record<string, Instance>, baseId: string,
    instancePath: string, schemaPath: string, ctx: Ctx,
  ): void {
    const keys = Object.keys(value);

    const required = s['required'];
    if (Array.isArray(required)) {
      for (const name of required as string[]) {
        if (!Object.prototype.hasOwnProperty.call(value, name)) {
          this.#err(ctx, {
            instancePath, schemaPath: `${schemaPath}/required`, keyword: 'required',
            message: `missing required property "${name}"`,
          });
        }
      }
    }

    const dependentRequired = s['dependentRequired'];
    if (dependentRequired !== null && typeof dependentRequired === 'object') {
      const map = dependentRequired as Record<string, string[]>;
      for (const [trigger, names] of Object.entries(map)) {
        if (!Object.prototype.hasOwnProperty.call(value, trigger)) continue;
        for (const name of names) {
          if (!Object.prototype.hasOwnProperty.call(value, name)) {
            this.#err(ctx, {
              instancePath, schemaPath: `${schemaPath}/dependentRequired`,
              keyword: 'dependentRequired',
              message: `property "${trigger}" requires "${name}"`,
            });
          }
        }
      }
    }

    const minProperties = s['minProperties'];
    if (typeof minProperties === 'number' && keys.length < minProperties) {
      this.#err(ctx, {
        instancePath, schemaPath: `${schemaPath}/minProperties`, keyword: 'minProperties',
        message: `must have at least ${minProperties} propert(ies)`,
      });
    }
    const maxProperties = s['maxProperties'];
    if (typeof maxProperties === 'number' && keys.length > maxProperties) {
      this.#err(ctx, {
        instancePath, schemaPath: `${schemaPath}/maxProperties`, keyword: 'maxProperties',
        message: `must have at most ${maxProperties} propert(ies)`,
      });
    }

    const matched = new Set<string>();

    const properties = s['properties'];
    if (properties !== null && typeof properties === 'object') {
      const map = properties as Record<string, JsonSchema>;
      for (const [name, sub] of Object.entries(map)) {
        if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
        matched.add(name);
        this.#note(ctx, instancePath, name);
        this.#validate(
          sub, value[name], baseId,
          `${instancePath}/${escapePointer(name)}`,
          `${schemaPath}/properties/${escapePointer(name)}`, ctx,
        );
      }
    }

    const patternProperties = s['patternProperties'];
    if (patternProperties !== null && typeof patternProperties === 'object') {
      const map = patternProperties as Record<string, JsonSchema>;
      for (const [pattern, sub] of Object.entries(map)) {
        const re = new RegExp(pattern, 'u');
        for (const name of keys) {
          if (!re.test(name)) continue;
          matched.add(name);
          this.#note(ctx, instancePath, name);
          this.#validate(
            sub, value[name], baseId,
            `${instancePath}/${escapePointer(name)}`,
            `${schemaPath}/patternProperties/${escapePointer(pattern)}`, ctx,
          );
        }
      }
    }

    const propertyNames = s['propertyNames'];
    if (propertyNames !== undefined) {
      for (const name of keys) {
        this.#validate(
          propertyNames as JsonSchema, name, baseId,
          `${instancePath}/${escapePointer(name)}`, `${schemaPath}/propertyNames`, ctx,
        );
      }
    }

    const additionalProperties = s['additionalProperties'];
    if (additionalProperties !== undefined) {
      for (const name of keys) {
        if (matched.has(name)) continue;
        this.#note(ctx, instancePath, name);
        if (additionalProperties === false) {
          this.#err(ctx, {
            instancePath: `${instancePath}/${escapePointer(name)}`,
            schemaPath: `${schemaPath}/additionalProperties`,
            keyword: 'additionalProperties',
            message: `property "${name}" is not permitted here`,
          });
        } else {
          this.#validate(
            additionalProperties as JsonSchema, value[name], baseId,
            `${instancePath}/${escapePointer(name)}`, `${schemaPath}/additionalProperties`, ctx,
          );
        }
      }
    }

    const unevaluatedProperties = s['unevaluatedProperties'];
    if (unevaluatedProperties !== undefined) {
      const seen = ctx.evaluated.get(instancePath) ?? new Set<string>();
      for (const name of keys) {
        if (seen.has(name)) continue;
        if (unevaluatedProperties === false) {
          this.#err(ctx, {
            instancePath: `${instancePath}/${escapePointer(name)}`,
            schemaPath: `${schemaPath}/unevaluatedProperties`,
            keyword: 'unevaluatedProperties',
            message: `property "${name}" is not evaluated by any subschema and is not permitted`,
          });
        } else {
          this.#validate(
            unevaluatedProperties as JsonSchema, value[name], baseId,
            `${instancePath}/${escapePointer(name)}`, `${schemaPath}/unevaluatedProperties`, ctx,
          );
        }
      }
    }
  }
}
