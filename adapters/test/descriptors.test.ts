import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterOperationDescriptor } from '@agentos/contracts';
import {
  DescriptorError,
  DescriptorRegistry,
  readOnlyOperation,
  type OperationRegistration,
} from '../src/index.js';
import { PATHS, emptyRegistry } from './helpers.js';

/**
 * The descriptor registry, and what it refuses at startup.
 *
 * "Expose an operation without a descriptor" is on WP-4's must-not list. The way this file
 * makes that unreachable rather than merely forbidden is that the descriptor is the thing you
 * register: there is no other entry point, so there is no operation without one. What remains
 * is to prove that a *malformed* descriptor is refused too, and refused while the process is
 * starting rather than mid-run against a real repository.
 */

function fine(): OperationRegistration {
  return readOnlyOperation({
    adapter: 'probe',
    op: 'read_thing',
    description: 'A well-formed read.',
    evidenceKind: 'file',
    observationSafe: true,
    handler: () => Promise.resolve({ value: null }),
  });
}

/** Builds a registration around a descriptor deliberately made wrong. */
function withDescriptor(descriptor: unknown): OperationRegistration {
  return {
    descriptor: descriptor as AdapterOperationDescriptor,
    evidenceKind: 'file',
    handler: () => Promise.resolve({ value: null }),
  };
}

describe('a well-formed registration', () => {
  test('is accepted, and its descriptor is retrievable by the (adapter, op) pair', () => {
    const registry = emptyRegistry();
    registry.register(fine());
    assert.equal(registry.size(), 1);
    assert.equal(registry.get('probe', 'read_thing')?.descriptor.op, 'read_thing');
    assert.equal(registry.get('probe', 'something_else'), undefined);
    assert.deepEqual(registry.families(), ['probe']);
  });

  test('defaults every dangerous flag to the safe value', () => {
    const descriptor = fine().descriptor;
    assert.equal(descriptor.mutating, false);
    assert.equal(descriptor.reversal, null);
    assert.equal(descriptor.idempotent_by_key, false);
    assert.equal(descriptor.external_destination, false);
    assert.deepEqual(descriptor.gates, []);
    assert.deepEqual(descriptor.incidental_artifacts, []);
  });

  test('observation safety is stated at the call site, never inherited', () => {
    const unsafe = readOnlyOperation({
      adapter: 'probe',
      op: 'tail_log',
      description: 'A read whose re-execution advances a cursor.',
      evidenceKind: 'log',
      observationSafe: false,
      handler: () => Promise.resolve({ value: null }),
    });
    assert.equal(unsafe.descriptor.observation_safe, false);
  });
});

describe('registrations that are refused', () => {
  test('a duplicate (adapter, op) is refused', () => {
    const registry = emptyRegistry();
    registry.register(fine());
    assert.throws(
      () => registry.register(fine()),
      (error: unknown) => error instanceof DescriptorError
        && /already registered/.test(error.message),
      'two descriptors for one operation means whichever registered last decides what it may do',
    );
  });

  test('a descriptor that does not satisfy the contract is refused', () => {
    const registry = emptyRegistry();
    const broken = { ...fine().descriptor } as Record<string, unknown>;
    delete broken['observation_safe'];
    assert.throws(
      () => registry.register(withDescriptor(broken)),
      /does not satisfy the AdapterOperationDescriptor contract/,
    );
  });

  test('a descriptor with no adapter name still produces a locatable error', () => {
    const registry = emptyRegistry();
    assert.throws(
      () => registry.register(withDescriptor({ op: 'read_thing' })),
      /\?\.read_thing: /,
    );
  });

  test('a malformed adapter family name is refused', () => {
    const registry = emptyRegistry();
    const descriptor = { ...fine().descriptor, adapter: 'Probe Adapter!' };
    assert.throws(
      () => registry.register(withDescriptor(descriptor)),
      /well-formed adapter family name/,
    );
  });

  test('a malformed operation name is refused', () => {
    const registry = emptyRegistry();
    const descriptor = { ...fine().descriptor, op: 'ReadThing' };
    assert.throws(() => registry.register(withDescriptor(descriptor)), /lower_snake_case/);
  });

  test('an args_schema that is not an object schema is refused', () => {
    const registry = emptyRegistry();
    const descriptor = { ...fine().descriptor, args_schema: { type: 'string' } };
    assert.throws(
      () => registry.register(withDescriptor(descriptor)),
      /object schema with declared properties/,
    );
  });

  test('an evidence kind that is not one of the ten is refused', () => {
    const registry = emptyRegistry();
    assert.throws(
      () => registry.register({ ...fine(), evidenceKind: 'vibes' as never }),
      /is not an evidence kind/,
    );
  });

  test('observation_safe with mutating is refused: the implication runs one way', () => {
    const registry = emptyRegistry(true);
    const descriptor = {
      ...fine().descriptor,
      mutating: true,
      observation_safe: true,
      gates: ['PRODUCTION_WRITE'],
    };
    assert.throws(
      () => registry.register({ ...withDescriptor(descriptor), captureBefore: () => Promise.resolve({ target: 't', before: {} }) }),
      /observation_safe: true implies mutating: false/,
    );
  });

  test('a mutating operation with no gate has nothing to check a grant against', () => {
    const registry = emptyRegistry(true);
    const descriptor = {
      ...fine().descriptor, mutating: true, observation_safe: false, gates: [],
    };
    assert.throws(
      () => registry.register({
        ...withDescriptor(descriptor),
        captureBefore: () => Promise.resolve({ target: 't', before: {} }),
      }),
      /must declare at least one gate/,
    );
  });

  test('a mutating operation with no captureBefore cannot be logged, so it is refused', () => {
    const registry = emptyRegistry(true);
    const descriptor = {
      ...fine().descriptor,
      mutating: true,
      observation_safe: false,
      gates: ['PRODUCTION_WRITE'],
    };
    assert.throws(
      () => registry.register(withDescriptor(descriptor)),
      /must supply captureBefore/,
    );
  });

  test('keyed idempotency with no identity_args would be one key for every call', () => {
    const registry = emptyRegistry(true);
    const descriptor = {
      ...fine().descriptor,
      mutating: true,
      observation_safe: false,
      gates: ['PRODUCTION_WRITE'],
      idempotent_by_key: true,
      identity_args: [],
    };
    assert.throws(
      () => registry.register({
        ...withDescriptor(descriptor),
        captureBefore: () => Promise.resolve({ target: 't', before: {} }),
      }),
      /one key for every call/,
    );
  });

  test('a non-mutating operation supplying captureBefore is refused', () => {
    const registry = emptyRegistry();
    assert.throws(
      () => registry.register({
        ...fine(),
        captureBefore: () => Promise.resolve({ target: 't', before: {} }),
      }),
      /there is nothing to undo/,
    );
  });
});

describe('incidental artifacts are not a loophole', () => {
  test('a by-product inside a declared scratch root is accepted', () => {
    const registry = emptyRegistry();
    registry.register(readOnlyOperation({
      adapter: 'probe',
      op: 'run_tests',
      description: 'Runs the suite, which writes coverage output.',
      evidenceKind: 'command',
      observationSafe: true,
      incidentalArtifacts: ['**/coverage/**'],
      handler: () => Promise.resolve({ value: null }),
    }));
    assert.equal(registry.size(), 1);
  });

  test('a by-product outside every scratch root is refused', () => {
    const registry = emptyRegistry();
    assert.throws(
      () => registry.register(readOnlyOperation({
        adapter: 'probe',
        op: 'run_tests',
        description: 'Runs the suite and claims the source tree as a by-product.',
        evidenceKind: 'command',
        observationSafe: true,
        incidentalArtifacts: ['src/**'],
        handler: () => Promise.resolve({ value: null }),
      })),
      /not covered by any scratch root/,
      'the set of places a by-product may land is policy, and a descriptor cannot extend it',
    );
  });

  test('an absolute or upward-escaping by-product pattern is refused', () => {
    const registry = emptyRegistry();
    for (const pattern of ['/tmp/**', '../elsewhere/**', 'C:/temp/**']) {
      assert.throws(
        () => registry.register(readOnlyOperation({
          adapter: 'probe',
          op: `run_${pattern.replace(/\W/g, '')}`.slice(0, 40).toLowerCase(),
          description: 'A by-product pattern that can name anywhere.',
          evidenceKind: 'command',
          observationSafe: true,
          incidentalArtifacts: [pattern],
          handler: () => Promise.resolve({ value: null }),
        })),
        /absolute or escapes upwards|not covered by any scratch root/,
      );
    }
  });
});

describe('the scratch roots come from policy', () => {
  test('the registry is built from policies/paths.json rather than from a local list', () => {
    const registry = new DescriptorRegistry({
      mutationEnabled: false,
      scratchRoots: PATHS.scratch_roots,
    });
    assert.ok(PATHS.scratch_roots.length > 0, 'the policy declares scratch roots');
    registry.register(readOnlyOperation({
      adapter: 'probe',
      op: 'build',
      description: 'Builds, which writes into the build directory.',
      evidenceKind: 'command',
      observationSafe: true,
      incidentalArtifacts: ['**/dist/**'],
      handler: () => Promise.resolve({ value: null }),
    }));
    assert.equal(registry.size(), 1);
  });
});
