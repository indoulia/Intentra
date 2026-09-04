#!/usr/bin/env node
/**
 * Generates `contracts/src/generated/types.ts` from `contracts/schema/*.json`.
 *
 * Generated types are committed so consumers need no build step to read them, and they are
 * never hand-edited: a hand-edit is the moment the schema and the type begin to disagree,
 * and the disagreement surfaces later as an optional field one side thinks is required.
 * `--check` regenerates into memory and fails on any difference, which is what makes the
 * rule enforceable rather than remembered.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { typeName } from '../lib/names.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_DIR = join(ROOT, 'contracts', 'schema');
const OUT = join(ROOT, 'contracts', 'src', 'generated', 'types.ts');
const OUT_SCHEMAS = join(ROOT, 'contracts', 'src', 'generated', 'schemas.ts');

const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.json')).sort();
const schemas = new Map();
for (const file of files) {
  const base = basename(file, '.json');
  schemas.set(base, JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')));
}

/** Resolves a `$ref` to the TypeScript name it denotes. */
function refToTypeName(ref, currentBase) {
  const hash = ref.indexOf('#');
  const uri = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? '' : ref.slice(hash + 1);
  const base = uri === '' ? currentBase : basename(uri, '.json');
  if (!schemas.has(base)) throw new Error(`$ref "${ref}" names unknown schema ${base}`);
  if (pointer === '') return typeName(base, null);
  const m = /^\/\$defs\/(.+)$/.exec(pointer);
  if (m === null) throw new Error(`$ref "${ref}" must point at a $defs entry`);
  return typeName(base, m[1]);
}

const INDENT = '  ';

function docComment(node, indent) {
  const text = node.description;
  if (typeof text !== 'string' || text.length === 0) return '';
  const wrapped = wrap(text, 92 - indent.length);
  if (wrapped.length === 1) return `${indent}/** ${wrapped[0]} */\n`;
  return `${indent}/**\n${wrapped.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`;
}

function wrap(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function literal(value) {
  return JSON.stringify(value);
}

function propertyKey(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** Renders a schema node as a TypeScript type expression. */
function render(node, base, indent) {
  if (node === true) return 'unknown';
  if (node === false) return 'never';
  if (typeof node !== 'object' || node === null) {
    throw new Error('schema node must be an object or boolean');
  }

  if (typeof node.$ref === 'string') {
    const named = refToTypeName(node.$ref, base);
    const siblings = Object.keys(node).filter((k) => k !== '$ref' && k !== 'description');
    if (siblings.length === 0) return named;
    const rest = { ...node };
    delete rest.$ref;
    return `${named} & ${render(rest, base, indent)}`;
  }

  if (Array.isArray(node.allOf)) {
    const parts = node.allOf.map((sub) => render(sub, base, indent));
    const own = { ...node };
    delete own.allOf;
    delete own.description;
    delete own.unevaluatedProperties;
    if (Object.keys(own).length > 0) parts.push(render(own, base, indent));
    return parts.length === 1 ? parts[0] : parts.join(' & ');
  }

  if (Array.isArray(node.oneOf)) return renderUnion(node.oneOf, base, indent);
  if (Array.isArray(node.anyOf)) return renderUnion(node.anyOf, base, indent);

  if ('const' in node) return literal(node.const);
  if (Array.isArray(node.enum)) return node.enum.map(literal).join(' | ');

  const types = node.type === undefined
    ? undefined
    : Array.isArray(node.type) ? node.type : [node.type];

  if (types === undefined) return 'unknown';

  const rendered = types.map((t) => renderForType(t, node, base, indent));
  return rendered.length === 1 ? rendered[0] : rendered.join(' | ');
}

function renderUnion(members, base, indent) {
  const parts = members.map((sub) => render(sub, base, indent));
  return parts.map((p) => (p.includes('&') || p.includes('|') ? `(${p})` : p)).join(' | ');
}

function renderForType(t, node, base, indent) {
  switch (t) {
    case 'null': return 'null';
    case 'boolean': return 'boolean';
    case 'integer':
    case 'number': return 'number';
    case 'string': return 'string';
    case 'array': {
      if (Array.isArray(node.prefixItems)) {
        const tuple = node.prefixItems.map((sub) => render(sub, base, indent)).join(', ');
        return `readonly [${tuple}]`;
      }
      if (node.items === undefined) return 'readonly unknown[]';
      const item = render(node.items, base, indent);
      const needsParens = item.includes('|') || item.includes('&') || item.includes(' ');
      return needsParens ? `ReadonlyArray<${item}>` : `readonly ${item}[]`;
    }
    case 'object': return renderObject(node, base, indent);
    default: throw new Error(`unsupported JSON Schema type "${t}"`);
  }
}

function renderObject(node, base, indent) {
  const inner = indent + INDENT;
  const lines = [];
  const required = new Set(Array.isArray(node.required) ? node.required : []);

  if (node.properties !== undefined) {
    for (const [name, sub] of Object.entries(node.properties)) {
      const doc = docComment(sub, inner);
      const optional = required.has(name) ? '' : '?';
      lines.push(`${doc}${inner}readonly ${propertyKey(name)}${optional}: ${render(sub, base, inner)};`);
    }
  }

  if (node.patternProperties !== undefined) {
    const valueTypes = Object.values(node.patternProperties)
      .map((sub) => render(sub, base, inner));
    const unique = [...new Set(valueTypes)];
    const value = unique.length === 1 ? unique[0] : unique.join(' | ');
    lines.push(`${inner}readonly [key: string]: ${value === 'unknown' ? 'unknown' : `${value} | undefined`};`);
  } else if (
    node.properties === undefined
    && node.additionalProperties === undefined
    && node.propertyNames === undefined
  ) {
    return 'Readonly<Record<string, unknown>>';
  } else if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
    lines.push(`${inner}readonly [key: string]: ${render(node.additionalProperties, base, inner)};`);
  }

  if (lines.length === 0) return 'Readonly<Record<string, never>>';
  return `{\n${lines.join('\n')}\n${indent}}`;
}

const out = [];
out.push('/*');
out.push(' * GENERATED FILE - DO NOT EDIT.');
out.push(' *');
out.push(' * Produced from contracts/schema/*.json by `npm run codegen`. JSON Schema is the source');
out.push(' * of truth; these types are a projection of it. A hand-edit here is the moment the schema');
out.push(' * and the type begin to disagree, so `npm run codegen:check` fails the build on any');
out.push(' * difference between this file and a fresh generation.');
out.push(' */');
out.push('');
out.push('/* eslint-disable @typescript-eslint/no-explicit-any */');
out.push('');

for (const [base, schema] of schemas) {
  out.push(`// ${'='.repeat(88 - base.length - 6)} ${base}.json`);
  out.push('');

  const defs = schema.$defs ?? {};
  for (const [defName, def] of Object.entries(defs)) {
    const name = typeName(base, defName);
    out.push(`${docComment(def, '')}export type ${name} = ${render(def, base, '')};`);
    out.push('');
  }

  const rootIsType = schema.type !== undefined
    || schema.oneOf !== undefined
    || schema.anyOf !== undefined
    || schema.allOf !== undefined
    || schema.enum !== undefined;
  if (rootIsType) {
    const name = typeName(base, null);
    const root = { ...schema };
    delete root.$defs;
    delete root.$schema;
    delete root.$id;
    delete root.title;
    out.push(`${docComment(root, '')}export type ${name} = ${render(root, base, '')};`);
    out.push('');
  }
}

const generated = `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;

/*
 * The schema documents are embedded rather than read from disk. `@agentos/contracts` does no
 * I/O — all outside-world access goes through adapters, and a package that reads its own
 * schema files off the filesystem would be a second, quieter exception to that rule.
 */
const schemaOut = [];
schemaOut.push('/*');
schemaOut.push(' * GENERATED FILE - DO NOT EDIT.');
schemaOut.push(' *');
schemaOut.push(' * The schema documents from contracts/schema/*.json, embedded so that');
schemaOut.push(' * `@agentos/contracts` needs neither a filesystem nor a dependency to validate.');
schemaOut.push(' * Produced by `npm run codegen`.');
schemaOut.push(' */');
schemaOut.push('');
schemaOut.push("import type { JsonSchemaObject } from '../validator/types.js';");
schemaOut.push('');
for (const [base, schema] of schemas) {
  const constName = `${base.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_SCHEMA`;
  schemaOut.push(
    `export const ${constName}: JsonSchemaObject = ${JSON.stringify(schema, null, 2)};`,
  );
  schemaOut.push('');
}
schemaOut.push('/** Every schema document, in a stable order. */');
schemaOut.push('export const ALL_SCHEMAS: readonly JsonSchemaObject[] = [');
for (const base of schemas.keys()) {
  schemaOut.push(`  ${base.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_SCHEMA,`);
}
schemaOut.push('];');
schemaOut.push('');
schemaOut.push('/** Schema `$id` per contract, for callers that validate by name. */');
schemaOut.push('export const SCHEMA_ID = {');
for (const [base, schema] of schemas) {
  schemaOut.push(`  ${JSON.stringify(base)}: ${JSON.stringify(schema.$id)},`);
}
schemaOut.push('} as const;');
const generatedSchemas = `${schemaOut.join('\n')}\n`;

if (process.argv.includes('--check')) {
  const compare = (path, want, label) => {
    let existing = '';
    try {
      existing = readFileSync(path, 'utf8');
    } catch {
      console.error(`generated ${label} are missing; run \`npm run codegen\``);
      process.exit(1);
    }
    if (existing !== want) {
      console.error(
        `generated ${label} differ from a fresh generation.\n`
        + 'Either a schema changed without regeneration, or the generated file was hand-edited.\n'
        + 'Run `npm run codegen` and commit the result.',
      );
      process.exit(1);
    }
  };
  compare(OUT, generated, 'types');
  compare(OUT_SCHEMAS, generatedSchemas, 'embedded schemas');
  console.log(`codegen:check OK (${schemas.size} schemas)`);
} else {
  writeFileSync(OUT, generated, 'utf8');
  writeFileSync(OUT_SCHEMAS, generatedSchemas, 'utf8');
  console.log(`wrote types and embedded schemas from ${schemas.size} schemas`);
}
