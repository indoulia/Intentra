import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMAS, formatErrors, validators } from '../src/index.js';
import { allJsonBlocks, type JsonBlock } from './helpers.js';

/**
 * The expressiveness test.
 *
 * "Every worked JSON example in the fourteen frozen documents must validate against the
 * schemas" (IMPLEMENTATION_PLAN section 2). A doc example that will not validate means the
 * document and the schema disagree, and per the freeze that is a documentation defect
 * resolved by amendment before code is written against either.
 *
 * The examples are read out of the documents rather than copied into fixtures, so the test
 * cannot pass against a stale copy. Every block must be claimed by an entry below: an
 * unclaimed block fails, because an example nobody decided the shape of is an example
 * nobody checked.
 */

interface Claim {
  readonly document: string;
  readonly index: number;
  /** The contract the example must satisfy. */
  readonly validator: keyof typeof validators;
  /** JSON Pointer into the block, where the example is wrapped in a naming object. */
  readonly pointer?: string;
  readonly what: string;
}

const CLAIMS: readonly Claim[] = [
  {
    document: 'docs/AGENT_HANDOFF_CONTRACT.md',
    index: 0,
    validator: 'handoffEnvelope',
    what: 'the envelope',
  },
  {
    document: 'docs/AGENT_HANDOFF_CONTRACT.md',
    index: 1,
    validator: 'finding',
    what: 'a finding',
  },
  {
    document: 'docs/AGENT_HANDOFF_CONTRACT.md',
    index: 2,
    validator: 'evidence',
    what: 'an evidence item, with the kernel-written verification block populated',
  },
  {
    document: 'docs/AGENT_HANDOFF_CONTRACT.md',
    index: 3,
    validator: 'proposals',
    pointer: '/proposals',
    what: 'the proposals block, every key filled at once',
  },
  {
    document: 'docs/AGENT_HANDOFF_CONTRACT.md',
    index: 4,
    validator: 'unknownRecord',
    what: 'an unknown',
  },
  {
    document: 'docs/AGENT_HANDOFF_CONTRACT.md',
    index: 5,
    validator: 'blocker',
    what: 'a blocker',
  },
  {
    document: 'docs/AGENT_HANDOFF_CONTRACT.md',
    index: 6,
    validator: 'inputPackage',
    what: 'the input package',
  },
  {
    document: 'docs/INTENT_AND_WORK_ITEM_RESOLUTION.md',
    index: 0,
    validator: 'intakeRecord',
    what: 'the IntakeRecord',
  },
  {
    document: 'docs/INTENT_AND_WORK_ITEM_RESOLUTION.md',
    index: 1,
    validator: 'proposedWorkItem',
    pointer: '/proposed_work_item',
    what: 'the proposed Work Item',
  },
  {
    document: 'docs/CONTEXT_MODEL.md',
    index: 0,
    validator: 'assertion',
    what: 'an assertion with inline evidence',
  },
  {
    document: 'docs/WORKFLOW_STATE_MACHINE.md',
    index: 0,
    validator: 'workflowTemplate',
    what: 'the defect.standard template',
  },
  {
    document: 'docs/WORKFLOW_STATE_MACHINE.md',
    index: 1,
    validator: 'event',
    what: 'a mutation event as a log record',
  },
  {
    document: 'docs/HUMAN_AUTHORIZATION.md',
    index: 0,
    validator: 'authorizationGrant',
    what: 'an authorization grant',
  },
];

function resolvePointer(value: unknown, pointer: string | undefined): unknown {
  if (pointer === undefined) return value;
  let node = value;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    assert.ok(
      node !== null && typeof node === 'object',
      `pointer ${pointer} does not resolve`,
    );
    node = (node as Record<string, unknown>)[token];
  }
  return node;
}

const blocks = allJsonBlocks();

describe('worked examples in the frozen documents', () => {
  test('every JSON block is claimed by exactly one entry', () => {
    const unclaimed: string[] = [];
    for (const block of blocks) {
      const matches = CLAIMS.filter(
        (c) => c.document === block.document && c.index === block.index,
      );
      if (matches.length === 0) {
        unclaimed.push(`${block.document}:${block.line} (block #${block.index})`);
      }
      assert.ok(
        matches.length <= 1,
        `${block.document} block #${block.index} is claimed ${matches.length} times`,
      );
    }
    assert.deepEqual(
      unclaimed,
      [],
      'these worked examples are not checked against any schema; classify them or amend the'
      + ' document:\n  ' + unclaimed.join('\n  '),
    );
  });

  test('every claim names a block that exists', () => {
    for (const claim of CLAIMS) {
      const found = blocks.some(
        (b) => b.document === claim.document && b.index === claim.index,
      );
      assert.ok(
        found,
        `claim for ${claim.document} block #${claim.index} (${claim.what}) matches no block`,
      );
    }
  });

  for (const claim of CLAIMS) {
    test(`${claim.document} #${claim.index} — ${claim.what}`, () => {
      const block = blocks.find(
        (b): b is JsonBlock => b.document === claim.document && b.index === claim.index,
      );
      assert.ok(block !== undefined);
      const value = resolvePointer(block.value, claim.pointer);
      const validator = validators[claim.validator];
      const result = validator.check(value);
      assert.ok(
        result.valid,
        `${claim.document}:${block.line} does not satisfy ${validator.schemaId}\n`
        + `${formatErrors(result.errors)}\n\n`
        + 'Per ARCHITECTURE_FREEZE section 3 this is a documentation defect: amend the\n'
        + 'document (and record it in section 8), do not loosen the schema to fit.',
      );
    });
  }

  test('at least one example exercises each of the six contracts most at risk of drift', () => {
    const covered = new Set(CLAIMS.map((c) => c.validator));
    for (const required of [
      'handoffEnvelope',
      'inputPackage',
      'intakeRecord',
      'proposedWorkItem',
      'workflowTemplate',
      'assertion',
    ] as const) {
      assert.ok(covered.has(required), `no frozen document example exercises ${required}`);
    }
  });
});

describe('schema set integrity', () => {
  test('every schema seals: no dangling $ref, no unsupported keyword', () => {
    // Sealing happens at import; reaching here means it succeeded. Assert the set is whole.
    assert.ok(SCHEMAS.ids().length >= 17, 'expected at least the seventeen schema documents');
  });

  test('every registered schema declares an absolute $id under the AgentOS namespace', () => {
    for (const id of SCHEMAS.ids()) {
      assert.match(id, /^https:\/\/agentos\.dev\/schema\/[a-z-]+\.json(\?def=[a-zA-Z]+)?$/, id);
    }
  });

  test('no schema carries a default: a contract states absence, it does not invent a value', () => {
    for (const id of SCHEMAS.ids()) {
      const text = JSON.stringify(SCHEMAS.get(id));
      assert.ok(
        !text.includes('"default"'),
        `${id} carries a default; WP-1 forbids a contract that invents a value`,
      );
    }
  });
});
