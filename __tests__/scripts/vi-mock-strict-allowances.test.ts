import { describe, expect, it } from 'vitest';
import {
  evaluateViMockStrictFindings,
  parseViMockStrictBaseline,
  passesViMockStrictGate,
} from '../../scripts/lib/vi-mock-strict-allowances.mjs';

const modulePath = 'src/services/database.ts';
const missing = ['initializeDatabaseCore', 'withReleaseMaintenanceDatabase'];

function baseline(maximum = 1) {
  return parseViMockStrictBaseline([
    'partialMockCount=0',
    `allowExactPartialMocks=${modulePath}|${missing.join(',')}|max=${maximum}`,
  ].join('\n'));
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    severity: 'partial-mock',
    realModule: modulePath,
    missing: [...missing].reverse(),
    defaultMismatch: false,
    hasReExport: false,
    ...overrides,
  };
}

describe('vi.mock strict scoped allowances', () => {
  it.each([
    'allowExactPartialMocks=services/database.ts|initializeDatabaseCore|max=1',
    `allowExactPartialMocks=${modulePath}|initializeDatabaseCore|max=0`,
  ])('rejects a malformed allowance: %s', (allowance) => {
    expect(() => parseViMockStrictBaseline(`partialMockCount=0\n${allowance}`))
      .toThrow('invalid vi.mock strict allowance');
  });

  it('rejects duplicate allowances for the same module', () => {
    expect(() => parseViMockStrictBaseline([
      'partialMockCount=0',
      `allowExactPartialMocks=${modulePath}|initializeDatabaseCore|max=1`,
      `allowExactPartialMocks=${modulePath}|withReleaseMaintenanceDatabase|max=1`,
    ].join('\n'))).toThrow(`duplicate vi.mock strict allowance for ${modulePath}`);
  });

  it.each([
    ['module', { realModule: 'src/services/not-database.ts' }],
    ['missing-key set', { missing: ['initializeDatabaseCore'] }],
  ])('fails closed when the %s differs', (_description, overrides) => {
    const parsed = baseline();
    const evaluation = evaluateViMockStrictFindings([finding(overrides)], parsed);

    expect(evaluation.allowedCount).toBe(0);
    expect(evaluation.evaluatedPartialMockCount).toBe(1);
    expect(passesViMockStrictGate(parsed, evaluation)).toBe(false);
  });

  it('fails closed when matching findings exceed the maximum', () => {
    const parsed = baseline(1);
    const evaluation = evaluateViMockStrictFindings([finding(), finding()], parsed);

    expect(evaluation.exceededAllowances).toEqual([{
      realModule: modulePath,
      count: 2,
      maximum: 1,
    }]);
    expect(passesViMockStrictGate(parsed, evaluation)).toBe(false);
  });

  it('passes only the exact allowed module, missing keys, and count', () => {
    const parsed = baseline(1);
    const evaluation = evaluateViMockStrictFindings([finding()], parsed);

    expect(evaluation).toEqual({
      allowedCount: 1,
      evaluatedPartialMockCount: 0,
      exceededAllowances: [],
    });
    expect(passesViMockStrictGate(parsed, evaluation)).toBe(true);
  });
});
