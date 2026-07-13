// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNormalizedDecisionAction } from '../../src/services/decision-action-contract';
import type { LoadedDecisionConflictContext } from '../../src/services/decision-conflict-context';

const state = vi.hoisted(() => ({
  context: null as LoadedDecisionConflictContext | null,
}));

vi.mock('../../src/services/decision-conflict-context', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/decision-conflict-context')>(
    '../../src/services/decision-conflict-context',
  );
  return {
    ...actual,
    loadDecisionConflictContext: () => state.context,
  };
});
vi.mock('../../src/services/unified-calendar', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/unified-calendar')>(
    '../../src/services/unified-calendar',
  );
  return {
    ...actual,
    hasConnectedCalendarForUser: () => true,
    hasWritableCalendarForUser: () => true,
  };
});
vi.mock('../../src/services/database', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined }) }),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  closeDatabase: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  initDatabase: vi.fn(),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

import {
  registerDecisionPreconditionAdapter,
  revalidateNormalizedDecisionAction,
} from '../../src/services/decision-preexecution-revalidator';

function action(contextVersion = 'ctx_candidate') {
  return buildNormalizedDecisionAction({
    intent: 'review_resource_change',
    targetEntities: [{ type: 'task', id: 'task-1', version: '1' }],
    affectedResources: [{ type: 'shared_resource', id: 'primary' }],
    preconditions: [],
    expectedEffects: [{ type: 'reserve', targetRef: 'task:task-1' }],
    prohibitedEffects: [],
    dependencies: [],
    exclusivityKeys: ['shared_resource:1:primary'],
    authorizationScope: ['decision_center:read'],
    risk: 'low',
    reversibility: 'reversible',
    contextVersion,
  });
}

describe('decision-preexecution-revalidator', () => {
  beforeEach(() => {
    state.context = {
      existing: [],
      activeExecutionExclusivityKeys: [],
      sourceHealth: [{ source: 'authoritative_test', status: 'available' }],
    };
  });

  it('keeps persisted comparisons without decision ids on proposal-time revalidation', () => {
    const existing = action('ctx_existing');
    const result = revalidateNormalizedDecisionAction({
      scope: { userId: 1, tenantId: 1 },
      action: action(),
      additionalExisting: [{
        action: existing,
        authority: 'approved_commitment',
        approved: true,
        createdAt: '2026-07-10T10:00:00.000Z',
      }],
      now: new Date('2026-07-10T11:00:00.000Z'),
    });

    expect(result.conflictEvaluation.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ class: 'resource_competition' }),
    ]));
    expect(result.canExecute).toBe(false);
  });

  it('fails closed for an unsupported required precondition', () => {
    const candidate = action();
    candidate.preconditions = [{ type: 'unsupported_test', ref: 'opaque', required: true }];
    const result = revalidateNormalizedDecisionAction({ scope: { userId: 1, tenantId: 1 }, action: candidate });
    expect(result.preconditions[0]).toMatchObject({ ok: false, reasonCode: 'unsupported_required_precondition' });
    expect(result.conflictEvaluation.reasonCodes).toContain('missing_precondition:unsupported_test:unsupported_required_precondition');
  });

  it('fails closed when a required precondition source throws', () => {
    registerDecisionPreconditionAdapter({
      type: 'throwing_test',
      validate: () => { throw new Error('unavailable'); },
    });
    const candidate = action();
    candidate.preconditions = [{ type: 'throwing_test', ref: 'opaque', required: true }];
    const result = revalidateNormalizedDecisionAction({ scope: { userId: 1, tenantId: 1 }, action: candidate });
    expect(result.preconditions[0]).toMatchObject({ ok: false, reasonCode: 'precondition_source_unavailable' });
  });

  it('fails closed when authoritative conflict context is unavailable', () => {
    state.context!.sourceHealth = [{ source: 'authoritative_test', status: 'failed' }];
    const result = revalidateNormalizedDecisionAction({ scope: { userId: 1, tenantId: 1 }, action: action() });
    expect(result.contextSourcesHealthy).toBe(false);
    expect(result.conflictEvaluation.reasonCodes).toContain('missing_precondition:authoritative_conflict_context');
  });

  it('fails closed when a persisted comparison cannot be normalized', () => {
    const result = revalidateNormalizedDecisionAction({
      scope: { userId: 1, tenantId: 1 },
      action: action(),
      additionalExisting: [{ invalid: true } as never],
    });
    expect(result.conflictEvaluation.reasonCodes).toContain('missing_precondition:persisted_conflict_comparison_invalid');
  });
});
