import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: null as null | InstanceType<typeof import('better-sqlite3')>,
  getEffectiveEntitlement: vi.fn(() => ({
    plan: 'pro',
    status: 'active',
    billingPeriodStart: '2026-09-01T00:00:00.000Z',
    subscriptionExpiresAt: '2026-10-01T00:00:00.000Z',
  })),
}));

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
  initializeDatabaseCore: vi.fn(),
  withReleaseMaintenanceDatabase: vi.fn(),
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
  getEffectiveEntitlement: hoisted.getEffectiveEntitlement,
  FREE_TIER_ALLOWED_SKILLS: [],
  BETA_TIER_ALLOWED_SKILLS: [],
  isAiInteractiveEntitlementEligible: vi.fn(() => true),
  isAiAutomationEntitlementEligible: vi.fn(() => true),
  isPaidAiCostControlsEnforcementEnabled: vi.fn(() => false),
  isAiInteractiveAllowedForRuntime: vi.fn(() => true),
  isAiAutomationAllowedForRuntime: vi.fn(() => true),
  isSkillAllowedByEntitlement: vi.fn(() => true),
  isCoachBriefingEntitlementEligible: vi.fn(() => true),
  entitlementPlanToSkillTier: vi.fn(() => 'pro'),
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
    hoisted.getEffectiveEntitlement.mockReset();
    hoisted.getEffectiveEntitlement.mockReturnValue({
      plan: 'pro',
      status: 'active',
      billingPeriodStart: '2026-09-01T00:00:00.000Z',
      subscriptionExpiresAt: '2026-10-01T00:00:00.000Z',
    });
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

  it('covers validation, emit, and list edge branches', () => {
    expect(validateProductAnalyticsEvent('day7_retained', null)).toEqual({
      event: 'day7_retained',
      properties: {},
    });
    expect(() => validateProductAnalyticsEvent('app_open', null)).toThrow(/required/);
    expect(() => validateProductAnalyticsEvent('app_open', [])).toThrow(/object/);
    expect(() => validateProductAnalyticsEvent('app_open', {
      app_version: '  ',
      build: '1',
      surface: 'ios',
    })).toThrow(/required/);
    expect(() => validateProductAnalyticsEvent('app_open', {
      app_version: 1,
      build: '1',
      surface: 'ios',
    })).toThrow(/string/);

    expect(emitProductAnalyticsEvent({
      userId: 0,
      event: 'app_open',
      properties: { app_version: '1.5.0', build: '1', surface: 'ios' },
    })).toBeNull();
    expect(emitProductAnalyticsEvent({
      userId: 1.5,
      event: 'app_open',
      properties: { app_version: '1.5.0', build: '1', surface: 'ios' },
    })).toBeNull();

    emitSkillFirstSuccess(12, 'decision_center' as never);
    emitDecisionCenterActed(12, '   ', true);
    emitModelAccessDenied(12, 'TIER_REQUIRED');
    emitProductAnalyticsEvent({
      userId: 12,
      event: 'skill_first_success',
      properties: { skill: 'content' },
    });
    expect(listProductAnalyticsEvents(12, 'skill_first_success')).toHaveLength(1);

    emitProductAnalyticsEvent({
      userId: 12,
      event: 'onboarding_completed',
      properties: { locale: 'en-GB', skipped: 'true' },
      source: 'ios',
      idempotencyKey: '   ',
    });
    emitProductAnalyticsEvent({
      userId: 12,
      event: 'onboarding_completed',
      properties: { locale: 'pt', skipped: 'false' },
    });
    emitProductAnalyticsEvent({
      userId: 12,
      tenantId: 44,
      event: 'paywall_viewed',
      properties: { plan_shown: 'Pro', trigger: 'Limit' },
    });
    expect(() => validateProductAnalyticsEvent('onboarding_completed', {
      locale: 'xx',
      skipped: 'true',
    })).toThrow(/locale/);
    expect(() => validateProductAnalyticsEvent('onboarding_completed', {
      locale: 1,
      skipped: true,
    })).toThrow(/locale must be a string/);
    expect(() => validateProductAnalyticsEvent('onboarding_completed', {
      locale: 'en',
      skipped: 1,
    })).toThrow(/boolean/);
    expect(validateProductAnalyticsEvent('onboarding_completed', {
      locale: 'pt-pt',
      skipped: true,
    }).properties.locale).toBe('pt-PT');
    expect(validateProductAnalyticsEvent('onboarding_completed', {
      locale: 'en',
      skipped: false,
    }).properties.locale).toBe('en');

    const listed = listProductAnalyticsEvents(12);
    expect(listed.map((row) => row.eventName).sort()).toEqual([
      'onboarding_completed',
      'paywall_viewed',
      'skill_first_success',
    ]);
    expect(listed.find((row) => row.eventName === 'onboarding_completed')?.properties).toEqual({
      locale: 'en',
      skipped: true,
    });
  });

  it('does not emit purchase_completed for unpaid or inactive entitlements', () => {
    hoisted.getEffectiveEntitlement.mockReturnValue({
      plan: 'free',
      status: 'active',
      billingPeriodStart: '2026-09-01T00:00:00.000Z',
      subscriptionExpiresAt: '2026-10-01T00:00:00.000Z',
    });
    emitPurchaseCompletedIfEntitled(12, 'stripe');
    expect(listProductAnalyticsEvents(12, 'purchase_completed')).toHaveLength(0);

    hoisted.getEffectiveEntitlement.mockReturnValue({
      plan: 'pro',
      status: 'canceled',
      billingPeriodStart: '2026-09-01T00:00:00.000Z',
      subscriptionExpiresAt: '2026-10-01T00:00:00.000Z',
    });
    emitPurchaseCompletedIfEntitled(12, 'stripe');
    expect(listProductAnalyticsEvents(12, 'purchase_completed')).toHaveLength(0);

    hoisted.getEffectiveEntitlement.mockImplementation(() => {
      throw new Error('entitlement unavailable');
    });
    emitPurchaseCompletedIfEntitled(12, 'apple');
    expect(listProductAnalyticsEvents(12, 'purchase_completed')).toHaveLength(0);
  });

  it('maps malformed stored properties and sqlite timestamps without throwing', () => {
    emitProductAnalyticsEvent({
      userId: 12,
      event: 'app_open',
      properties: { app_version: '1.5.0', build: '1', surface: 'ios' },
      source: 'ios',
    });
    hoisted.db!.prepare(`
      UPDATE product_analytics_events
         SET created_at = 'not-a-date'
       WHERE user_id = 12 AND event_name = 'app_open'
    `).run();
    emitProductAnalyticsEvent({
      userId: 12,
      event: 'app_open',
      properties: { app_version: '1.5.0', build: '2', surface: 'ios' },
      source: 'ios',
    });
    expect(listProductAnalyticsEvents(12, 'day7_retained')).toHaveLength(0);

    hoisted.db!.prepare(`
      UPDATE product_analytics_events
         SET created_at = '2026-08-01 00:00:00'
       WHERE user_id = 12 AND event_name = 'app_open' AND properties_json LIKE '%"build":"1"%'
    `).run();
    emitProductAnalyticsEvent({
      userId: 12,
      event: 'app_open',
      properties: { app_version: '1.5.0', build: '3', surface: 'ios' },
      source: 'ios',
    });
    expect(listProductAnalyticsEvents(12, 'day7_retained')).toHaveLength(1);

    emitProductAnalyticsEvent({
      userId: 12,
      event: 'app_open',
      properties: { app_version: '1.5.0', build: '4', surface: 'ios' },
      source: 'ios',
    });
    expect(listProductAnalyticsEvents(12, 'day7_retained')).toHaveLength(1);

    hoisted.db!.prepare(`
      INSERT INTO product_analytics_events (
        event_id, user_id, tenant_id, event_name, properties_json, source, created_at
      ) VALUES ('evt-bad', 12, 12, 'paywall_viewed', 'not-json', 'server', datetime('now'))
    `).run();
    const mapped = listProductAnalyticsEvents(12, 'paywall_viewed');
    expect(mapped[0].properties).toEqual({});
  });

  it('returns null when persist cannot use the database', () => {
    hoisted.db?.close();
    hoisted.db = null;
    expect(emitProductAnalyticsEvent({
      userId: 12,
      event: 'app_open',
      properties: { app_version: '1.5.0', build: '1', surface: 'ios' },
    })).toBeNull();
    expect(listProductAnalyticsEvents(12)).toEqual([]);
  });
});
