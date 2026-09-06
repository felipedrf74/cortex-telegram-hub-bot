import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ db: null as null | InstanceType<typeof import('better-sqlite3')> }));

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    if (!hoisted.db) throw new Error('test database not initialized');
    return hoisted.db;
  },
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  applyMigrationFileForTest: vi.fn(),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/entitlement', () => ({
  getEffectiveEntitlement: vi.fn(() => ({
    plan: 'pro',
    status: 'active',
    billingPeriodStart: '2026-09-01T00:00:00.000Z',
    subscriptionExpiresAt: '2026-10-01T00:00:00.000Z',
  })),
}));

import {
  emitDecisionCenterActed,
  emitModelAccessDenied,
  emitProductAnalyticsEvent,
  emitPurchaseCompletedIfEntitled,
  emitSkillFirstSuccess,
  listProductAnalyticsEvents,
  ProductAnalyticsValidationError,
  validateProductAnalyticsEvent,
} from '../../src/services/product-analytics';

describe('product analytics v1.1 contract', () => {
  beforeEach(() => {
    hoisted.db = new Database(':memory:');
  });

  afterEach(() => {
    hoisted.db?.close();
    hoisted.db = null;
  });

  it('accepts only the locked event names and required properties', () => {
    expect(validateProductAnalyticsEvent('app_open', {
      app_version: '1.5.0',
      build: '261',
      surface: 'ios',
    }).event).toBe('app_open');
    expect(() => validateProductAnalyticsEvent('session_start', {})).toThrow(ProductAnalyticsValidationError);
    expect(() => validateProductAnalyticsEvent('skill_first_success', { skill: 'decision_center' }))
      .toThrow(/decision_center/);
    expect(() => validateProductAnalyticsEvent('model_access_denied', { code: 'TIER_REQUIRED' }))
      .toThrow(ProductAnalyticsValidationError);
    expect(() => validateProductAnalyticsEvent('app_open', {
      app_version: '1.5.0',
      build: '261',
      surface: 'ios',
      email: 'user@example.com',
    })).toThrow(/PII/);
  });

  it('persists a verified skill first success once', () => {
    emitSkillFirstSuccess(12, 'training');
    emitSkillFirstSuccess(12, 'training');
    emitSkillFirstSuccess(12, 'cooking');

    const training = listProductAnalyticsEvents(12, 'skill_first_success');
    expect(training).toHaveLength(2);
    expect(training.map((row) => row.properties.skill)).toEqual(['training', 'cooking']);
  });

  it('records model denials and decision actions without PII bodies', () => {
    emitModelAccessDenied(12, 'AI_PLAN_REQUIRED');
    emitDecisionCenterActed(12, 'mark_paid', true);
    emitDecisionCenterActed(12, 'accept_reflow', false);

    const denials = listProductAnalyticsEvents(12, 'model_access_denied');
    expect(denials).toHaveLength(1);
    expect(denials[0].properties).toEqual({ code: 'AI_PLAN_REQUIRED' });

    const acted = listProductAnalyticsEvents(12, 'decision_center_acted');
    expect(acted.map((row) => row.properties)).toEqual([
      { action_kind: 'mark_paid', result: 'success' },
      { action_kind: 'accept_reflow', result: 'failure' },
    ]);
  });

  it('emits purchase_completed only when entitlement is paid', () => {
    emitPurchaseCompletedIfEntitled(12, 'apple');
    emitPurchaseCompletedIfEntitled(12, 'apple');
    const purchases = listProductAnalyticsEvents(12, 'purchase_completed');
    expect(purchases).toHaveLength(1);
    expect(purchases[0].properties).toEqual({ plan: 'pro', provider: 'apple' });
  });

  it('derives day7_retained from app_open instead of a client fire', () => {
    emitProductAnalyticsEvent({
      userId: 12,
      event: 'app_open',
      properties: { app_version: '1.5.0', build: '1', surface: 'ios' },
      source: 'ios',
    });
    hoisted.db!.prepare(`
      UPDATE product_analytics_events
         SET created_at = ?
       WHERE user_id = 12 AND event_name = 'app_open'
    `).run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString());

    emitProductAnalyticsEvent({
      userId: 12,
      event: 'app_open',
      properties: { app_version: '1.5.0', build: '2', surface: 'ios' },
      source: 'ios',
    });

    expect(listProductAnalyticsEvents(12, 'day7_retained')).toHaveLength(1);
    expect(() => emitProductAnalyticsEvent({
      userId: 12,
      event: 'day7_retained',
      properties: {},
      source: 'ios',
    })).not.toThrow();
    expect(listProductAnalyticsEvents(12, 'day7_retained')).toHaveLength(1);
  });
});
