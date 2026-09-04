import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaRegistry, SchemaError } from '../src/validator/validator.js';
import type { JsonSchemaObject } from '../src/validator/types.js';

/**
 * Tests for the validator itself.
 *
 * Everything else in AgentOS rests on this: if the validator accepts something a schema
 * forbids, every check built on the schema is decorative. So each supported keyword is
 * tested in both directions, and the keywords the validator refuses to support are tested
 * to be refused at load rather than ignored at validation — a constraint nobody enforces is
 * worse than one nobody wrote.
 */

const BASE = 'https://agentos.dev/test/';

function compile(body: JsonSchemaObject, extra: readonly JsonSchemaObject[] = []): SchemaRegistry {
  const registry = new SchemaRegistry();
  for (const s of extra) registry.add(s);
  registry.add({ $id: `${BASE}subject.json`, ...body });
  return registry.seal();
}

function accepts(body: JsonSchemaObject, value: unknown): boolean {
  return compile(body).validate(`${BASE}subject.json`, value).valid;
}

function errorsFor(body: JsonSchemaObject, value: unknown): readonly string[] {
  return compile(body)
    .validate(`${BASE}subject.json`, value)
    .errors.map((e) => `${e.instancePath}:${e.keyword}`);
}

describe('validator — type', () => {
  test('discriminates every JSON type', () => {
    const cases: ReadonlyArray<readonly [string, readonly unknown[], readonly unknown[]]> = [
      ['null', [null], [0, '', false, [], {}]],
      ['boolean', [true, false], [null, 0, '', [], {}]],
      ['string', ['', 'x'], [null, 0, false, [], {}]],
      ['number', [0, 1.5, -3], [null, '', false, [], {}]],
      ['integer', [0, -3], [1.5, null, '', false]],
      ['array', [[], [1]], [null, 0, '', false, {}]],
      ['object', [{}, { a: 1 }], [null, 0, '', false, []]],
    ];
    for (const [type, good, bad] of cases) {
      for (const v of good) assert.ok(accepts({ type }, v), `${type} should accept ${JSON.stringify(v)}`);
      for (const v of bad) assert.ok(!accepts({ type }, v), `${type} should reject ${JSON.stringify(v)}`);
    }
  });

  test('a type array is a union, which is how nullable fields are expressed', () => {
    assert.ok(accepts({ type: ['string', 'null'] }, 'x'));
    assert.ok(accepts({ type: ['string', 'null'] }, null));
    assert.ok(!accepts({ type: ['string', 'null'] }, 3));
  });

  test('an integer satisfies type number, but not the reverse', () => {
    assert.ok(accepts({ type: 'number' }, 4));
    assert.ok(!accepts({ type: 'integer' }, 4.5));
  });

  test('a failing type short-circuits, so downstream keywords do not also report', () => {
    const errors = errorsFor({ type: 'object', required: ['a'] }, 'not an object');
    assert.deepEqual(errors, [':type']);
  });
});

describe('validator — enum and const', () => {
  test('enum admits only listed values, by deep equality', () => {
    assert.ok(accepts({ enum: ['A', 'B'] }, 'A'));
    assert.ok(!accepts({ enum: ['A', 'B'] }, 'C'));
    assert.ok(accepts({ enum: [{ a: [1] }] }, { a: [1] }));
    assert.ok(!accepts({ enum: [{ a: [1] }] }, { a: [2] }));
  });

  test('const with a null value is enforced rather than treated as absent', () => {
    assert.ok(accepts({ const: null }, null));
    assert.ok(!accepts({ const: null }, 0));
  });
});

describe('validator — objects', () => {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'integer' } },
    required: ['a'],
    additionalProperties: false,
  };

  test('required is checked by presence, not by truthiness', () => {
    assert.ok(accepts(schema, { a: '' }));
    assert.ok(!accepts(schema, { b: 1 }));
  });

  test('an explicit undefined-valued key is still absent', () => {
    assert.ok(!accepts(schema, JSON.parse('{"b":1}')));
  });

  test('additionalProperties false refuses an unlisted key and names it', () => {
    const errors = errorsFor(schema, { a: 'x', c: 1 });
    assert.deepEqual(errors, ['/c:additionalProperties']);
  });

  test('a null-prototype hazard: inherited keys do not satisfy required', () => {
    const value = Object.create({ a: 'inherited' }) as Record<string, unknown>;
    value['b'] = 1;
    assert.ok(!accepts(schema, value));
  });

  test('patternProperties applies to matching keys and marks them evaluated', () => {
    const s: JsonSchemaObject = {
      type: 'object',
      patternProperties: { '^[a-z]+$': { type: 'integer' } },
      additionalProperties: false,
    };
    assert.ok(accepts(s, { ab: 1 }));
    assert.ok(!accepts(s, { ab: 'x' }));
    assert.ok(!accepts(s, { AB: 1 }));
  });

  test('propertyNames constrains keys themselves', () => {
    const s: JsonSchemaObject = { type: 'object', propertyNames: { minLength: 2 } };
    assert.ok(accepts(s, { ab: 1 }));
    assert.ok(!accepts(s, { a: 1 }));
  });

  test('dependentRequired fires only when its trigger is present', () => {
    const s: JsonSchemaObject = { type: 'object', dependentRequired: { a: ['b'] } };
    assert.ok(accepts(s, {}));
    assert.ok(accepts(s, { a: 1, b: 2 }));
    assert.ok(!accepts(s, { a: 1 }));
  });

  test('min and max properties', () => {
    assert.ok(!accepts({ type: 'object', minProperties: 1 }, {}));
    assert.ok(!accepts({ type: 'object', maxProperties: 1 }, { a: 1, b: 2 }));
  });

  test('a JSON Pointer in an error escapes / and ~ in property names', () => {
    const s: JsonSchemaObject = {
      type: 'object',
      properties: { 'a/b~c': { type: 'integer' } },
    };
    assert.deepEqual(errorsFor(s, { 'a/b~c': 'x' }), ['/a~1b~0c:type']);
  });
});

describe('validator — arrays', () => {
  test('items applies to every element and locates the failure', () => {
    const s: JsonSchemaObject = { type: 'array', items: { type: 'integer' } };
    assert.ok(accepts(s, [1, 2]));
    assert.deepEqual(errorsFor(s, [1, 'x', 3]), ['/1:type']);
  });

  test('prefixItems positions, and items covers the tail', () => {
    const s: JsonSchemaObject = {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'integer' }],
      items: { type: 'boolean' },
    };
    assert.ok(accepts(s, ['a', 1, true, false]));
    assert.ok(!accepts(s, ['a', 'b']));
    assert.ok(!accepts(s, ['a', 1, 2]));
  });

  test('min and max items', () => {
    assert.ok(!accepts({ type: 'array', minItems: 1 }, []));
    assert.ok(!accepts({ type: 'array', maxItems: 1 }, [1, 2]));
  });

  test('uniqueItems compares deeply, not by reference', () => {
    const s: JsonSchemaObject = { type: 'array', uniqueItems: true };
    assert.ok(accepts(s, [{ a: 1 }, { a: 2 }]));
    assert.ok(!accepts(s, [{ a: 1 }, { a: 1 }]));
    assert.ok(!accepts(s, [[1, 2], [1, 2]]));
  });

  test('contains with minContains and maxContains', () => {
    const s: JsonSchemaObject = {
      type: 'array',
      contains: { type: 'integer' },
      minContains: 2,
      maxContains: 3,
    };
    assert.ok(!accepts(s, [1]));
    assert.ok(accepts(s, [1, 2, 'x']));
    assert.ok(!accepts(s, [1, 2, 3, 4]));
  });
});

describe('validator — strings and numbers', () => {
  test('minLength and maxLength count code points, not UTF-16 units', () => {
    assert.ok(accepts({ type: 'string', maxLength: 1 }, '\u{1F600}'));
    assert.ok(!accepts({ type: 'string', minLength: 2 }, '\u{1F600}'));
  });

  test('pattern is unanchored unless the schema anchors it', () => {
    assert.ok(accepts({ type: 'string', pattern: 'b' }, 'abc'));
    assert.ok(!accepts({ type: 'string', pattern: '^b$' }, 'abc'));
  });

  test('format date-time is asserted, because timestamps are compared', () => {
    assert.ok(accepts({ type: 'string', format: 'date-time' }, '2026-09-04T10:14:00Z'));
    assert.ok(accepts({ type: 'string', format: 'date-time' }, '2026-09-04T10:14:00.123+02:00'));
    assert.ok(!accepts({ type: 'string', format: 'date-time' }, '2026-09-04'));
    assert.ok(!accepts({ type: 'string', format: 'date-time' }, 'yesterday'));
  });

  test('an unknown format is an annotation, not a silent failure', () => {
    assert.ok(accepts({ type: 'string', format: 'colour' }, 'anything'));
  });

  test('numeric bounds, inclusive and exclusive', () => {
    assert.ok(accepts({ minimum: 0 }, 0));
    assert.ok(!accepts({ exclusiveMinimum: 0 }, 0));
    assert.ok(accepts({ maximum: 1 }, 1));
    assert.ok(!accepts({ exclusiveMaximum: 1 }, 1));
  });

  test('multipleOf tolerates floating point representation', () => {
    assert.ok(accepts({ multipleOf: 0.1 }, 0.3));
    assert.ok(!accepts({ multipleOf: 0.1 }, 0.35));
  });
});

describe('validator — applicators', () => {
  test('allOf requires every branch', () => {
    const s: JsonSchemaObject = { allOf: [{ type: 'integer' }, { minimum: 5 }] };
    assert.ok(accepts(s, 6));
    assert.ok(!accepts(s, 4));
  });

  test('anyOf requires at least one, and reports all branch failures together', () => {
    const s: JsonSchemaObject = { anyOf: [{ type: 'integer' }, { type: 'string' }] };
    assert.ok(accepts(s, 1));
    assert.ok(accepts(s, 'x'));
    assert.deepEqual(errorsFor(s, true), [':anyOf']);
  });

  test('oneOf requires exactly one, so an ambiguous union is a schema defect', () => {
    const exclusive: JsonSchemaObject = {
      oneOf: [
        { type: 'object', properties: { k: { const: 'A' } }, required: ['k'] },
        { type: 'object', properties: { k: { const: 'B' } }, required: ['k'] },
      ],
    };
    assert.ok(accepts(exclusive, { k: 'A' }));
    assert.ok(!accepts(exclusive, { k: 'C' }));

    const ambiguous: JsonSchemaObject = { oneOf: [{ type: 'integer' }, { minimum: 0 }] };
    assert.ok(!accepts(ambiguous, 1), 'matching two branches must fail oneOf');
  });

  test('not inverts, and its own errors are not surfaced', () => {
    assert.ok(accepts({ not: { type: 'string' } }, 1));
    assert.deepEqual(errorsFor({ not: { type: 'string' } }, 'x'), [':not']);
  });

  test('if/then/else selects a branch and the if-failure is not an error', () => {
    const s: JsonSchemaObject = {
      if: { type: 'object', properties: { k: { const: 'A' } }, required: ['k'] },
      then: { type: 'object', required: ['a'] },
      else: { type: 'object', required: ['b'] },
    };
    assert.ok(accepts(s, { k: 'A', a: 1 }));
    assert.ok(!accepts(s, { k: 'A' }));
    assert.ok(accepts(s, { k: 'Z', b: 1 }));
  });

  test('unevaluatedProperties sees through allOf, which is what makes closed unions work', () => {
    const s: JsonSchemaObject = {
      allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }],
      type: 'object',
      properties: { b: { type: 'integer' } },
      unevaluatedProperties: false,
    };
    assert.ok(accepts(s, { a: 'x', b: 1 }));
    assert.ok(!accepts(s, { a: 'x', b: 1, c: true }));
  });

  test('true and false schemas', () => {
    assert.ok(accepts(true as unknown as JsonSchemaObject, 1));
    const registry = new SchemaRegistry();
    registry.add({ $id: `${BASE}f.json`, type: 'object', properties: { a: false } });
    registry.seal();
    assert.ok(!registry.validate(`${BASE}f.json`, { a: 1 }).valid);
    assert.ok(registry.validate(`${BASE}f.json`, {}).valid);
  });
});

describe('validator — references', () => {
  test('a local $defs pointer resolves', () => {
    const s: JsonSchemaObject = {
      $defs: { n: { type: 'integer' } },
      type: 'array',
      items: { $ref: '#/$defs/n' },
    };
    assert.ok(accepts(s, [1]));
    assert.ok(!accepts(s, ['x']));
  });

  test('a cross-file $ref resolves relative to the referring schema', () => {
    const other: JsonSchemaObject = {
      $id: `${BASE}other.json`,
      $defs: { n: { type: 'integer', minimum: 3 } },
    };
    const registry = compile({ type: 'array', items: { $ref: 'other.json#/$defs/n' } }, [other]);
    assert.ok(registry.validate(`${BASE}subject.json`, [3]).valid);
    assert.ok(!registry.validate(`${BASE}subject.json`, [2]).valid);
  });

  test('a $ref alongside sibling keywords applies both', () => {
    const s: JsonSchemaObject = {
      $defs: { s: { type: 'string' } },
      $ref: '#/$defs/s',
      minLength: 2,
    };
    assert.ok(accepts(s, 'ab'));
    assert.ok(!accepts(s, 'a'));
  });

  test('a dangling $ref fails at seal, not at the first instance that reaches it', () => {
    const registry = new SchemaRegistry();
    registry.add({ $id: `${BASE}d.json`, $ref: '#/$defs/missing' });
    assert.throws(() => registry.seal(), SchemaError);
  });

  test('a $ref to an unregistered document fails at seal', () => {
    const registry = new SchemaRegistry();
    registry.add({ $id: `${BASE}d.json`, $ref: 'nowhere.json' });
    assert.throws(() => registry.seal(), /unknown schema/);
  });
});

describe('validator — refusals at load', () => {
  test('an unsupported keyword is refused rather than ignored', () => {
    const registry = new SchemaRegistry();
    registry.add({ $id: `${BASE}u.json`, type: 'string', contentEncoding: 'base64' });
    assert.throws(() => registry.seal(), /unsupported keyword "contentEncoding"/);
  });

  test('default is forbidden: a contract states absence, it does not invent a value', () => {
    const registry = new SchemaRegistry();
    registry.add({ $id: `${BASE}v.json`, type: 'string', default: '' });
    assert.throws(() => registry.seal(), /keyword "default" is forbidden/);
  });

  test('dynamic references are refused', () => {
    for (const keyword of ['$dynamicRef', '$dynamicAnchor', '$anchor']) {
      const registry = new SchemaRegistry();
      registry.add({ $id: `${BASE}w.json`, [keyword]: 'x' });
      assert.throws(() => registry.seal(), /is forbidden/, keyword);
    }
  });

  test('a schema without a string $id is refused', () => {
    assert.throws(() => new SchemaRegistry().add({ type: 'string' }), /string \$id/);
  });

  test('a duplicate $id is refused, so one shape cannot have two definitions', () => {
    const registry = new SchemaRegistry();
    registry.add({ $id: `${BASE}x.json` });
    assert.throws(() => registry.add({ $id: `${BASE}x.json` }), /duplicate schema/);
  });

  test('a sealed registry refuses further additions', () => {
    const registry = new SchemaRegistry();
    registry.add({ $id: `${BASE}y.json` });
    registry.seal();
    assert.throws(() => registry.add({ $id: `${BASE}z.json` }), /sealed/);
  });

  test('validating an unregistered $id throws rather than passing vacuously', () => {
    const registry = compile({ type: 'string' });
    assert.throws(() => registry.validate(`${BASE}absent.json`, 'x'), /no schema registered/);
  });
});

describe('validator — error reporting', () => {
  test('every error locates itself in both the instance and the schema', () => {
    const s: JsonSchemaObject = {
      type: 'object',
      properties: { list: { type: 'array', items: { type: 'object', required: ['id'] } } },
    };
    const result = compile(s).validate(`${BASE}subject.json`, { list: [{}, { id: 1 }] });
    assert.equal(result.errors.length, 1);
    const error = result.errors[0];
    assert.ok(error !== undefined);
    assert.equal(error.instancePath, '/list/0');
    assert.equal(error.schemaPath, '#/properties/list/items/required');
    assert.equal(error.keyword, 'required');
    assert.match(error.message, /missing required property "id"/);
  });

  test('multiple independent failures are all reported, not just the first', () => {
    const s: JsonSchemaObject = {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
    };
    assert.equal(errorsFor(s, { a: 'x', b: 'y' }).length, 2);
  });
});
