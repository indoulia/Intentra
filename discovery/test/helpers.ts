import assert from 'node:assert/strict';
import type { Assertion, ContextPackage } from '@agentos/contracts';
import { validators } from '@agentos/contracts';
import { DiscoveryService, type DiscoveryOptions } from '../src/index.js';
import { FakeAdapters, TestClock, WINDOWS, type FakeWorld } from './fake-registry.js';

/** The absence reason of an assertion, or a marker naming what it was instead. */
export function reasonOf(assertion: Assertion | undefined): string {
  if (assertion === undefined) return 'absent';
  return assertion.confidence === 'UNKNOWN' ? assertion.reason : `not-unknown:${assertion.confidence}`;
}

export function attemptedOf(assertion: Assertion | undefined): string {
  if (assertion === undefined) return '';
  return assertion.confidence === 'UNKNOWN' ? (assertion.attempted ?? '') : '';
}

export function recoverableOf(assertion: Assertion | undefined): string {
  if (assertion === undefined) return '';
  return assertion.confidence === 'UNKNOWN' ? assertion.recoverable_by : '';
}

/** A discovery service over one world, with the fake registry and clock it runs on. */
export function serviceOver(
  world: FakeWorld,
  overrides: Partial<DiscoveryOptions> = {},
): {
    readonly service: DiscoveryService;
    readonly adapters: FakeAdapters;
    readonly clock: TestClock;
  } {
  const adapters = new FakeAdapters(world);
  const clock = new TestClock();
  const service = new DiscoveryService({
    adapters,
    clock,
    freshnessWindows: WINDOWS,
    ...overrides,
  });
  return { service, adapters, clock };
}

/**
 * Every package the tests produce is checked against the contract.
 *
 * The schema is the source of truth for the shape, and a package that satisfies the assertions
 * of a test while violating the contract would be a test passing against something the kernel
 * would reject.
 */
export function assertValidPackage(context: ContextPackage): void {
  const result = validators.contextPackage.check(context);
  assert.equal(
    result.valid,
    true,
    result.valid
      ? ''
      : result.errors.map((e) => `${e.instancePath}: ${e.message}`).join('\n'),
  );
}

/** Which operations were actually called, as `adapter.op`. */
export function operationsCalled(adapters: FakeAdapters): readonly string[] {
  return [...new Set(adapters.calls.map((call) => `${call.adapter}.${call.op}`))];
}
