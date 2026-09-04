#!/usr/bin/env node
/**
 * Cross-checks AgentOS's own JSON Schema validator against ajv.
 *
 * `@agentos/contracts` has zero dependencies, so it carries its own validator. That buys
 * determinism and no supply chain, and it costs the confidence that comes from a widely
 * used implementation. This script buys that confidence back without adding a dependency to
 * the package: ajv is a build-time devDependency here in `tools/`, and the two validators
 * must agree on every instance the test suite exercises.
 *
 * A disagreement is a defect in one of them, and the report says which instance and which
 * verdict, so it can be settled against the specification rather than by preference.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_DIR = join(ROOT, 'contracts', 'schema');

const contracts = await import(
  new URL(`file://${join(ROOT, 'contracts', 'dist', 'src', 'index.js').replace(/\\/g, '/')}`).href
);
const { SCHEMAS, validators, fixtures: fx, ALL_SCHEMAS, SCHEMA_ID } = contracts;

/* ajv is configured to match the schemas' own posture: strict mode off (the schemas use
 * `$comment` and description freely), formats asserted for date-time only. */
const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  validateFormats: true,
  formats: {
    'date-time': /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/,
    uri: /^[a-z][a-z0-9+.-]*:/i,
  },
});

for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.json'))) {
  ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')));
}
/* The wrapper schemas `@agentos/contracts` registers for `$defs` entry points. */
for (const id of SCHEMAS.ids()) {
  if (!id.includes('?def=')) continue;
  ajv.addSchema(SCHEMAS.get(id));
}

/* ------------------------------------------------------------------ the instance set ---- */

const cases = [];
function add(validatorName, label, instance) {
  cases.push({ validatorName, label, instance });
}

/* Every worked example in the frozen documents, read from the documents. */
const FROZEN = [
  ['docs/AGENT_HANDOFF_CONTRACT.md', ['handoffEnvelope', 'finding', 'evidence', 'proposals', 'unknownRecord', 'blocker', 'inputPackage']],
  ['docs/INTENT_AND_WORK_ITEM_RESOLUTION.md', ['intakeRecord', 'proposedWorkItem']],
  ['docs/CONTEXT_MODEL.md', ['assertion']],
  ['docs/WORKFLOW_STATE_MACHINE.md', ['workflowTemplate', 'event']],
  ['docs/HUMAN_AUTHORIZATION.md', ['authorizationGrant']],
];
const POINTERS = { proposals: '/proposals', proposedWorkItem: '/proposed_work_item' };

for (const [doc, names] of FROZEN) {
  const source = readFileSync(join(ROOT, doc), 'utf8').replace(/\r\n/g, '\n');
  const blocks = [...source.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  names.forEach((name, i) => {
    let value = blocks[i];
    const pointer = POINTERS[name];
    if (pointer !== undefined) value = value[pointer.slice(1)];
    add(name, `${basename(doc)} #${i}`, value);
  });
}

/* Every builder fixture, plus deliberately invalid variants: the two validators must agree
 * about rejection as much as about acceptance. */
add('assertion', 'fact assertion', fx.factAssertion('x'));
add('assertion', 'inference assertion', fx.inferenceAssertion('x'));
add('assertion', 'unknown assertion', fx.unknownAssertion());
add('assertion', 'INVALID assertion with no confidence', { value: 1, observed_at: fx.T1, probe: 'p', freshness: 'CURRENT' });
add('assertion', 'INVALID fact with no evidence', { value: 1, confidence: 'FACT', evidence: [], observed_at: fx.T1, probe: 'p', freshness: 'CURRENT' });
add('assertion', 'INVALID unknown with a value', { value: 1, confidence: 'UNKNOWN', reason: 'UNKNOWN', recoverable_by: 'x', observed_at: fx.T1, probe: 'p', freshness: 'CURRENT' });
add('evidence', 'file evidence', fx.evidence());
add('evidence', 'log evidence with a predicate', fx.evidence({ kind: 'log' }));
add('evidence', 'INVALID evidence with an unknown kind', fx.evidence({ kind: 'guess' }));
add('evidence', 'INVALID evidence with an extra field', { ...fx.evidence(), extra: 1 });
add('finding', 'finding', fx.finding());
add('finding', 'INVALID finding with no evidence', fx.finding({ evidence: [] }));
add('blocker', 'blocker', fx.blocker());
add('unknownRecord', 'unknown record', fx.unknownRecord());
add('coverage', 'coverage', fx.coverage());
add('coverage', 'INVALID coverage with nothing examined', fx.coverage({ scope_examined: [] }));
add('handoffEnvelope', 'envelope', fx.envelope());
add('handoffEnvelope', 'INVALID envelope at version 1.1', fx.envelope({ envelope_version: '1.1' }));
add('handoffEnvelope', 'INVALID envelope with no coverage', (() => { const e = { ...fx.envelope() }; delete e.coverage; return e; })());
add('intakeRecord', 'intake record', fx.intakeRecord());
add('intakeRecord', 'INVALID intake with a short content hash', fx.intakeRecord({ content_hash: 'abc' }));
add('workItem', 'work item', fx.workItem());
add('workItem', 'INVALID work item with no candidate profile', fx.workItem({ candidate_dod_profiles: [] }));
add('currentReality', 'current reality', fx.currentReality());
add('capabilityRecord', 'capability record', fx.capabilityRecord());
add('mutationEvent', 'mutation event', fx.mutationEvent());
add('adapterOperationDescriptor', 'operation descriptor', fx.operationDescriptor());
add('inputPackage', 'input package', fx.inputPackage());
add('criterionVerdict', 'criterion verdict', fx.criterionVerdict());

/* ----------------------------------------------------------------------- comparison ---- */

let checked = 0;
const disagreements = [];

for (const { validatorName, label, instance } of cases) {
  const validator = validators[validatorName];
  if (validator === undefined) throw new Error(`no validator named ${validatorName}`);
  const mine = validator.check(instance).valid;
  const ajvValidate = ajv.getSchema(validator.schemaId);
  if (ajvValidate === undefined) throw new Error(`ajv has no schema ${validator.schemaId}`);
  const theirs = Boolean(ajvValidate(instance));
  checked += 1;
  if (mine !== theirs) {
    disagreements.push({
      label,
      validatorName,
      schemaId: validator.schemaId,
      agentos: mine,
      ajv: theirs,
      ajvErrors: (ajvValidate.errors ?? []).slice(0, 4),
      agentosErrors: validator.check(instance).errors.slice(0, 4),
    });
  }
}

/* Also compare the two on every registered schema's own meta-shape: each schema document
 * must itself be a valid 2020-12 schema, which ajv checks and the AgentOS validator does
 * not attempt. This is the one asymmetry, and it is deliberate: the AgentOS validator
 * rejects unsupported keywords at seal, which is stricter than the metaschema. */
let metaChecked = 0;
for (const schema of ALL_SCHEMAS) {
  const valid = ajv.validateSchema(schema);
  metaChecked += 1;
  if (!valid) {
    disagreements.push({
      label: `metaschema ${schema.$id}`,
      validatorName: '(metaschema)',
      schemaId: 'https://json-schema.org/draft/2020-12/schema',
      agentos: true,
      ajv: false,
      ajvErrors: (ajv.errors ?? []).slice(0, 4),
      agentosErrors: [],
    });
  }
}

if (disagreements.length > 0) {
  console.error(`ajv parity FAILED: ${disagreements.length} disagreement(s) of ${checked}\n`);
  for (const d of disagreements) {
    console.error(`  ${d.label} against ${d.schemaId}`);
    console.error(`    agentos: ${d.agentos ? 'valid' : 'invalid'}   ajv: ${d.ajv ? 'valid' : 'invalid'}`);
    if (d.agentosErrors.length > 0) {
      console.error(`    agentos says: ${d.agentosErrors.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`);
    }
    if (d.ajvErrors.length > 0) {
      console.error(`    ajv says: ${d.ajvErrors.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`);
    }
  }
  process.exit(1);
}

console.log(
  `ajv parity OK: ${checked} instances agreed across ${Object.keys(SCHEMA_ID).length} schemas, `
  + `${metaChecked} schema documents are valid 2020-12 schemas`,
);
