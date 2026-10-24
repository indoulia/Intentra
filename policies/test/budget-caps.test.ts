import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicies, PolicyLoadError } from '../src/index.js';

/**
 * A policy-folder override that can only tighten the configured cost caps (WP-8 Prompt 4).
 *
 * It exists so a launcher can hand the kernel a run ceiling no higher than the budget it was
 * authorized to spend, without editing `budgets.json`. It can lower a cap and nothing else:
 * a raised cap, a value in the wrong unit, a misspelled field or a missing file all refuse the
 * whole policy set, because an override that half-applied would be a ceiling nobody chose.
 */

const BASE = loadPolicies();
const cleanup: string[] = [];
after(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }); });

function folder(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'intentra-caps-'));
  cleanup.push(dir);
  writeFileSync(
    join(dir, 'budget-caps.json'),
    typeof content === 'string' ? content : JSON.stringify(content),
  );
  return dir;
}

function refusal(content: unknown): PolicyLoadError {
  const overrides = folder(content);
  try {
    loadPolicies(undefined, { overrides });
  } catch (error) {
    assert.ok(error instanceof PolicyLoadError, `expected a PolicyLoadError, got ${String(error)}`);
    return error;
  }
  throw new Error('the override was accepted');
}

describe('a budget-caps override tightens and never loosens', () => {
  test('with no override the configured caps stand, and none is recorded', () => {
    assert.equal(BASE.budgetCaps, null);
  });

  test('a lower run cap replaces the configured one, and the change is recorded', () => {
    const overrides = folder({ version: '1.0', cost: { run_usd: 8 } });
    const policies = loadPolicies(undefined, { overrides });
    assert.equal(policies.budgets.cost.run_usd, 8);
    assert.equal(policies.budgets.cost.dispatch_usd, BASE.budgets.cost.dispatch_usd);
    assert.equal(policies.budgets.cost.work_item_usd, BASE.budgets.cost.work_item_usd);
    assert.deepEqual(policies.budgetCaps?.tightened, [
      { field: 'cost.run_usd', from: BASE.budgets.cost.run_usd, to: 8 },
    ]);
    assert.equal(policies.budgetCaps?.source, join(overrides, 'budget-caps.json'));
  });

  test('a cap equal to the configured one is accepted and changes nothing', () => {
    const overrides = folder({ version: '1.0', cost: { dispatch_usd: BASE.budgets.cost.dispatch_usd } });
    const policies = loadPolicies(undefined, { overrides });
    assert.deepEqual(policies.budgetCaps?.tightened, []);
  });

  test('a cap above the configured one refuses the policy set', () => {
    const error = refusal({ version: '1.0', cost: { run_usd: BASE.budgets.cost.run_usd + 0.000001 } });
    assert.ok(error.problems.some((p) => p.rule === 'budget-caps-tighten-only'));
  });

  test('a huge cap is refused, never wrapped', () => {
    assert.ok(refusal({ version: '1.0', cost: { work_item_usd: 1e308 } }).problems.length > 0);
  });

  for (const [name, content] of [
    ['a number written as a string', { version: '1.0', cost: { run_usd: '8' } }],
    ['a negative cap', { version: '1.0', cost: { run_usd: -1 } }],
    ['a null cap', { version: '1.0', cost: { run_usd: null } }],
    ['finer than a micro-dollar', { version: '1.0', cost: { run_usd: 8.0000001 } }],
    ['a misspelled field', { version: '1.0', cost: { run_cap_usd: 8 } }],
    ['a field outside cost', { version: '1.0', cost: { run_usd: 8 }, dispatches: { per_run: 1 } }],
    ['no version', { cost: { run_usd: 8 } }],
    ['an unknown version', { version: '2.0', cost: { run_usd: 8 } }],
    ['no cost at all', { version: '1.0' }],
    ['a cost that names nothing', { version: '1.0', cost: {} }],
    ['not an object', [8]],
    ['not JSON', '{ "version": "1.0", '],
  ] as const) {
    test(`${name} refuses the policy set`, () => {
      const overrides = folder(content);
      assert.throws(() => loadPolicies(undefined, { overrides }));
    });
  }

  test('a named folder with no budget-caps.json refuses the policy set', () => {
    const empty = mkdtempSync(join(tmpdir(), 'intentra-caps-'));
    cleanup.push(empty);
    assert.throws(() => loadPolicies(undefined, { overrides: empty }), /budget-caps\.json/);
  });

  test('an empty folder name is refused rather than read as the working directory', () => {
    assert.throws(() => loadPolicies(undefined, { overrides: '' }), /empty/);
  });
});
