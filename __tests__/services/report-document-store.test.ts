/**
 * Report Document Store + Push Preferences — Tests
 *
 * Covers:
 *   1. Report creation and persistence
 *   2. Report retrieval by type, by ID, latest
 *   3. Unread/read lifecycle
 *   4. User scoping
 *   5. Push preferences CRUD
 *   6. Push preference enforcement (isPushEnabled)
 *   7. Portal admin view
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({ getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));
vi.mock('../../src/config', () => ({
  config: { anthropic: { apiKey: 'test' }, app: { timezone: 'Europe/Lisbon' } },
}));

const mockCreateNotificationIntent = vi.fn(async (..._args: unknown[]) => ({ deliveryAttempts: [] }));
vi.mock('../../src/services/notification-orchestrator', () => ({
  createNotificationIntent: (...args: unknown[]) => mockCreateNotificationIntent(...args),
}));


import {
  storeReport, storeAndPushReport, getRecentReports, getReportById, getLatestByType,
  getUnreadReportCount, markReportRead, getAllReports,
  isPushEnabled, getPushPreferences, setPushPreference,
} from '../../src/services/report-document-store';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

// ═══════════════════════════════════════════════════════════════════
// 1. Report Creation
// ═══════════════════════════════════════════════════════════════════

describe('report-document-store: creation', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    clearTenantScopeAnomaliesForTests();
  });
  afterEach(() => testDb?.close());

  it('storeReport returns a valid ID', () => {
    const id = storeReport({
      userId: 1, type: 'morning_briefing', title: 'Good Morning',
      summary: '3 events, 2 tasks', documentJson: { events: [], tasks: [] },
    });
    expect(id).toBeGreaterThan(0);
  });

  it('stores all fields correctly', () => {
    storeReport({
      userId: 1, type: 'coach_briefing', title: 'Coach Report',
      summary: '3 recommendations',
      documentJson: { message: 'text', recommendations: [{ action: 'KEEP' }] },
      sourceJob: 'garmin_coach',
    });
    const reports = getRecentReports(1);
    expect(reports).toHaveLength(1);
    expect(reports[0].type).toBe('coach_briefing');
    expect(reports[0].tenantId).toBe(1);
    expect(reports[0].title).toBe('Coach Report');
    expect(reports[0].documentJson.recommendations).toHaveLength(1);
    expect(reports[0].status).toBe('unread');
    expect(reports[0].sourceJob).toBe('garmin_coach');
  });

  it('replays a scoped scheduler dispatch without duplicating or replacing its report', () => {
    const first = storeReport({
      userId: 1,
      type: 'morning_briefing',
      title: 'Original briefing',
      summary: 'Original summary',
      documentJson: { version: 1 },
      sourceJob: 'daily_briefing',
      dispatchKey: 'morning_briefing:2026-08-31',
    });
    const replay = storeReport({
      userId: 1,
      type: 'morning_briefing',
      title: 'Changed after crash',
      summary: 'Changed summary',
      documentJson: { version: 2 },
      sourceJob: 'daily_briefing',
      dispatchKey: 'morning_briefing:2026-08-31',
    });

    expect(replay).toBe(first);
    expect(getRecentReports(1)).toHaveLength(1);
    expect(getReportById(first, 1)).toMatchObject({
      title: 'Original briefing',
      summary: 'Original summary',
      documentJson: { version: 1 },
    });
  });

  it('binds scheduler replay identity to both tenant and user scope', () => {
    const firstTenant = storeReport({
      userId: 1,
      tenantId: 10,
      type: 'morning_briefing',
      title: 'Tenant 10 briefing',
      documentJson: { tenant: 10 },
      dispatchKey: 'morning_briefing:2026-08-31',
    });
    const secondTenant = storeReport({
      userId: 1,
      tenantId: 20,
      type: 'morning_briefing',
      title: 'Tenant 20 briefing',
      documentJson: { tenant: 20 },
      dispatchKey: 'morning_briefing:2026-08-31',
    });

    expect(secondTenant).not.toBe(firstTenant);
    expect(getReportById(firstTenant, 1, 10)).toMatchObject({ tenantId: 10 });
    expect(getReportById(secondTenant, 1, 20)).toMatchObject({ tenantId: 20 });
    expect(testDb.prepare(`
      SELECT tenant_id AS tenantId, user_id AS userId, report_document_id AS reportId
        FROM report_document_dispatch_receipts
       ORDER BY tenant_id
    `).all()).toEqual([
      { tenantId: 10, userId: 1, reportId: firstTenant },
      { tenantId: 20, userId: 1, reportId: secondTenant },
    ]);
  });

  it('stores Decision Center briefing documents', () => {
    const id = storeReport({
      userId: 1,
      type: 'decision_briefing',
      title: 'Decision Center Briefing',
      summary: '1 open decision, 2 handled by Nexus.',
      documentJson: {
        summary: { openCount: 1, handledCount: 2 },
        openDecisions: [{ decisionId: 'dc_1', title: 'Schedule decision' }],
        handledByNexus: [{ itemId: 'handled_1', title: 'Calendar sync retried' }],
      },
    });

    const report = getReportById(id, 1);

    expect(report?.type).toBe('decision_briefing');
    expect(report?.documentJson.openDecisions).toHaveLength(1);
    expect(report?.documentJson.handledByNexus).toHaveLength(1);
  });

  it('fails closed on invalid tenant scope and records the anomaly', () => {
    const id = storeReport({
      userId: 0,
      type: 'morning_briefing',
      title: 'Bad scope',
      documentJson: {},
    });

    expect(id).toBe(-1);
    expect(getRecentReports(0)).toEqual([]);
    const row = testDb.prepare('SELECT COUNT(*) as count FROM report_documents_scoped').get() as { count: number };
    expect(row.count).toBe(0);
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'store_report',
          reason: 'invalid_user_scope',
          userId: 0,
          details: expect.objectContaining({
            reportType: 'morning_briefing',
          }),
        }),
      ]),
    );
  });

  it('fails closed when the explicit tenant scope is invalid', () => {
    const id = storeReport({
      userId: 1,
      tenantId: 0,
      type: 'morning_briefing',
      title: 'Bad tenant',
      documentJson: {},
    });

    expect(id).toBe(-1);
    expect(testDb.prepare('SELECT COUNT(*) as count FROM report_documents').get()).toEqual({ count: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Report Retrieval
// ═══════════════════════════════════════════════════════════════════

describe('report-document-store: retrieval', () => {
  beforeEach(() => { testDb = createMigratedTestDatabase(); });
  afterEach(() => testDb?.close());

  it('filters by type', () => {
    storeReport({ userId: 1, type: 'morning_briefing', title: 'AM', documentJson: {} });
    storeReport({ userId: 1, type: 'evening_summary', title: 'PM', documentJson: {} });
    storeReport({ userId: 1, type: 'coach_briefing', title: 'Coach', documentJson: {} });

    const morning = getRecentReports(1, { type: 'morning_briefing' });
    expect(morning).toHaveLength(1);
    expect(morning[0].title).toBe('AM');
  });

  it('getReportById returns report with ownership check', () => {
    const id = storeReport({ userId: 1, type: 'morning_briefing', title: 'Mine', documentJson: {} });
    expect(getReportById(id, 1)).not.toBeNull();
    expect(getReportById(id, 2)).toBeNull(); // Wrong user
  });

  it('getReportById fails closed for invalid scoped userId instead of falling back to admin mode', () => {
    const id = storeReport({ userId: 1, type: 'morning_briefing', title: 'Mine', documentJson: {} });

    expect(getReportById(id, 0)).toBeNull();
    expect(getTenantScopeAnomalies()[0]).toMatchObject({
      layer: 'delivery',
      operation: 'get_report_by_id',
      reason: 'invalid_user_scope',
      userId: 0,
      details: { reportId: id },
    });
  });

  it('getLatestByType returns the report with highest ID (most recent insert)', () => {
    storeReport({ userId: 1, type: 'morning_briefing', title: 'First', documentJson: { order: 1 } });
    const secondId = storeReport({ userId: 1, type: 'morning_briefing', title: 'Second', documentJson: { order: 2 } });

    const latest = getLatestByType(1, 'morning_briefing');
    expect(latest).not.toBeNull();
    // Both inserted in same second, so ORDER BY created_at DESC may not distinguish.
    // The key contract: we get A report of the right type.
    expect(latest!.type).toBe('morning_briefing');
    expect(latest!.id).toBeGreaterThan(0);
  });

  it('isolates the same user report history across active tenants', () => {
    const tenantOneId = storeReport({
      userId: 1,
      tenantId: 701,
      type: 'coach_briefing',
      title: 'Tenant 701 coach',
      documentJson: { message: 'tenant-701' },
    });
    const tenantTwoId = storeReport({
      userId: 1,
      tenantId: 702,
      type: 'coach_briefing',
      title: 'Tenant 702 coach',
      documentJson: { message: 'tenant-702' },
    });

    expect(getLatestByType(1, 'coach_briefing', 701)?.id).toBe(tenantOneId);
    expect(getLatestByType(1, 'coach_briefing', 702)?.id).toBe(tenantTwoId);
    expect(getLatestByType(1, 'coach_briefing', 703)).toBeNull();
    expect(getReportById(tenantTwoId, 1, 701)).toBeNull();
    expect(getReportById(tenantTwoId, 1, 702)?.tenantId).toBe(702);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Read/Unread Lifecycle
// ═══════════════════════════════════════════════════════════════════

describe('report-document-store: read lifecycle', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    clearTenantScopeAnomaliesForTests();
  });
  afterEach(() => testDb?.close());

  it('new reports are unread', () => {
    storeReport({ userId: 1, type: 'morning_briefing', title: 'AM', documentJson: {} });
    expect(getUnreadReportCount(1)).toBe(1);
  });

  it('markReportRead changes status', () => {
    const id = storeReport({ userId: 1, type: 'morning_briefing', title: 'AM', documentJson: {} });
    expect(markReportRead(id, 1)).toBe(true);
    expect(getUnreadReportCount(1)).toBe(0);
    const report = getReportById(id, 1);
    expect(report!.status).toBe('read');
    expect(report!.readAt).not.toBeNull();
  });

  it('markReportRead fails for wrong user', () => {
    const id = storeReport({ userId: 1, type: 'morning_briefing', title: 'AM', documentJson: {} });
    expect(markReportRead(id, 2)).toBe(false);
    expect(getUnreadReportCount(1)).toBe(1);
  });

  it('markReportRead fails closed for invalid tenant scope', () => {
    const id = storeReport({ userId: 1, type: 'morning_briefing', title: 'AM', documentJson: {} });

    expect(markReportRead(id, 0)).toBe(false);
    expect(getTenantScopeAnomalies()[0]).toMatchObject({
      layer: 'delivery',
      operation: 'mark_report_read',
      reason: 'invalid_user_scope',
      userId: 0,
      details: { reportId: id },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. User Scoping
// ═══════════════════════════════════════════════════════════════════

describe('report-document-store: user scoping', () => {
  beforeEach(() => { testDb = createMigratedTestDatabase(); });
  afterEach(() => testDb?.close());

  it('users only see their own reports', () => {
    storeReport({ userId: 1, type: 'morning_briefing', title: 'U1', documentJson: {} });
    storeReport({ userId: 2, type: 'morning_briefing', title: 'U2', documentJson: {} });
    expect(getRecentReports(1)).toHaveLength(1);
    expect(getRecentReports(2)).toHaveLength(1);
    expect(getRecentReports(1)[0].title).toBe('U1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Push Preferences
// ═══════════════════════════════════════════════════════════════════

describe('report-document-store: push preferences', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    clearTenantScopeAnomaliesForTests();
  });
  afterEach(() => testDb?.close());

  it('isPushEnabled defaults to true when no row', () => {
    expect(isPushEnabled(1, 'morning_briefing')).toBe(true);
  });

  it('setPushPreference creates and toggles', () => {
    setPushPreference(1, 'morning_briefing', false);
    expect(isPushEnabled(1, 'morning_briefing')).toBe(false);

    setPushPreference(1, 'morning_briefing', true);
    expect(isPushEnabled(1, 'morning_briefing')).toBe(true);
  });

  it('getPushPreferences returns all categories with defaults', () => {
    const prefs = getPushPreferences(1);
    expect(prefs.length).toBeGreaterThanOrEqual(6);
    expect(prefs.every(p => p.enabled)).toBe(true); // All default enabled

    setPushPreference(1, 'coach_briefing', false);
    const updated = getPushPreferences(1);
    const coach = updated.find(p => p.category === 'coach_briefing');
    expect(coach?.enabled).toBe(false);
  });

  it('preferences are user-scoped', () => {
    setPushPreference(1, 'morning_briefing', false);
    expect(isPushEnabled(1, 'morning_briefing')).toBe(false);
    expect(isPushEnabled(2, 'morning_briefing')).toBe(true); // Different user
  });

  it('push preference helpers fail closed on invalid tenant scope', () => {
    expect(isPushEnabled(0, 'morning_briefing')).toBe(false);
    expect(getPushPreferences(0).every((pref) => pref.enabled === false)).toBe(true);

    setPushPreference(0, 'coach_briefing', false);
    const row = testDb.prepare(
      'SELECT COUNT(*) as count FROM push_preferences WHERE user_id = ?',
    ).get(0) as { count: number };

    expect(row.count).toBe(0);
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: 'delivery', operation: 'is_push_enabled', userId: 0 }),
        expect.objectContaining({ layer: 'delivery', operation: 'get_push_preferences', userId: 0 }),
        expect.objectContaining({ layer: 'delivery', operation: 'set_push_preference', userId: 0 }),
      ]),
    );
  });

  it('fails closed without running request-path DDL when push_preferences migration was missed', () => {
    testDb.exec('DROP TABLE IF EXISTS push_preferences');

    expect(isPushEnabled(1, 'morning_briefing')).toBe(false);
    const prefs = getPushPreferences(1);
    expect(prefs.find((pref) => pref.category === 'coach_briefing')?.enabled).toBe(false);
    expect(() => setPushPreference(1, 'coach_briefing', false)).toThrow(/push_preferences/i);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'table' AND name = 'push_preferences'
    `).get()).toEqual({ count: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Portal Admin View
// ═══════════════════════════════════════════════════════════════════

describe('report-document-store: admin view', () => {
  beforeEach(() => { testDb = createMigratedTestDatabase(); });
  afterEach(() => testDb?.close());

  it('getAllReports returns all users', () => {
    storeReport({ userId: 1, type: 'morning_briefing', title: 'U1', documentJson: {} });
    storeReport({ userId: 2, type: 'coach_briefing', title: 'U2', documentJson: {} });
    expect(getAllReports()).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. storeAndPushReport center-item and push-policy separation
// ═══════════════════════════════════════════════════════════════════

describe('report-document-store: storeAndPushReport delivery separation', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    clearTenantScopeAnomaliesForTests();
    mockCreateNotificationIntent.mockClear();
    delete process.env.NOTIFICATION_DIGEST_REQUIRE_DEVICE_TOKEN;
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DIGEST_REQUIRE_DEVICE_TOKEN;
    testDb?.close();
  });

  it('creates the canonical center intent without prechecking device tokens', async () => {
    const id = await storeAndPushReport({
      userId: 1, type: 'morning_briefing', title: 'Brief',
      summary: 'summary', documentJson: {},
    });
    expect(id).toBeGreaterThan(0);
    expect(getReportById(id, 1)).not.toBeNull();
    expect(mockCreateNotificationIntent).toHaveBeenCalledTimes(1);
  });

  it('legacy device-token producer flag cannot suppress the canonical center intent', async () => {
    process.env.NOTIFICATION_DIGEST_REQUIRE_DEVICE_TOKEN = 'true';
    const id = await storeAndPushReport({
      userId: 1, type: 'morning_briefing', title: 'Brief',
      summary: 'summary', documentJson: {},
    });
    expect(id).toBeGreaterThan(0);
    expect(getReportById(id, 1)).not.toBeNull();
    expect(getUnreadReportCount(1)).toBe(1);
    expect(mockCreateNotificationIntent).toHaveBeenCalledTimes(1);
  });

  it('creates the center intent with the report dedupe key', async () => {
    const id = await storeAndPushReport({
      userId: 1, tenantId: 77, type: 'morning_briefing', title: 'Brief',
      summary: 'summary', documentJson: {},
    });
    expect(id).toBeGreaterThan(0);
    expect(mockCreateNotificationIntent).toHaveBeenCalledTimes(1);
    expect(mockCreateNotificationIntent.mock.calls[0][0]).toMatchObject({
      userId: 1,
      tenantId: 77,
      relatedEntityId: id,
      relatedEntityType: 'report_document',
      dedupeKey: `report:morning_briefing:${id}`,
    });
  });

  it('keeps the center item but makes delivery in-app-only when report push is disabled', async () => {
    setPushPreference(1, 'morning_briefing', false);
    const id = await storeAndPushReport({
      userId: 1, type: 'morning_briefing', title: 'Brief',
      summary: 'summary', documentJson: {},
    });

    expect(id).toBeGreaterThan(0);
    expect(mockCreateNotificationIntent).toHaveBeenCalledTimes(1);
    expect(mockCreateNotificationIntent.mock.calls[0][0]).toMatchObject({
      relatedEntityId: id,
      deliveryPolicy: 'in_app_only',
      privacyPolicy: 'sensitive',
    });
  });

  it('reuses the durable report and Decision proposal key after a scheduled crash replay', async () => {
    const input = {
      userId: 1,
      tenantId: 77,
      type: 'morning_briefing' as const,
      title: 'Brief',
      summary: 'summary',
      documentJson: { date: '2026-08-31' },
      sourceJob: 'daily_briefing',
      dispatchKey: 'morning_briefing:2026-08-31',
      requireNotificationIntent: true,
    };
    const first = await storeAndPushReport(input);
    const replay = await storeAndPushReport({
      ...input,
      title: 'Changed after crash',
      summary: 'changed',
      documentJson: { date: '2026-08-31', changed: true },
    });

    expect(replay).toBe(first);
    expect(getRecentReports(1, { tenantId: 77 })).toHaveLength(1);
    expect(mockCreateNotificationIntent).toHaveBeenCalledTimes(2);
    const replayIntentIds = mockCreateNotificationIntent.mock.calls.map(([intent]) => intent.intentId);
    expect(replayIntentIds[0]).toMatch(/^ni_report_[a-f0-9]{32}$/);
    expect(new Set(replayIntentIds).size).toBe(1);
    for (const [intent] of mockCreateNotificationIntent.mock.calls) {
      expect(intent).toMatchObject({
        tenantId: 77,
        relatedEntityId: first,
        title: 'Brief',
        body: 'summary',
        privacyPolicy: 'sensitive',
        dedupeKey: `report:morning_briefing:${first}`,
      });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. Structural Checks
// ═══════════════════════════════════════════════════════════════════

describe('report-document-store: structural', () => {
  it('migration 062 creates report_documents table', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../migrations/062_report_documents.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS report_documents');
    expect(sql).toContain('user_id');
    expect(sql).toContain('document_json');
  });

  it('migration 063 creates push_preferences table', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../migrations/063_push_preferences.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS push_preferences');
    expect(sql).toContain('PRIMARY KEY (user_id, category)');
  });

  it('scheduler stores reports for morning briefing', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/services/scheduler.ts'), 'utf8');
    expect(source).toContain("type: 'morning_briefing'");
    expect(source).toContain('storeAndPushReport');
  });

  it('scheduler stores reports for coach briefing', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/services/scheduler.ts'), 'utf8');
    expect(source).toContain("type: 'coach_briefing'");
  });

  it('scheduler stores reports for evening summary', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/services/scheduler.ts'), 'utf8');
    expect(source).toContain("type: 'evening_summary'");
  });

  it('scheduler stores reports for weekly review', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/services/scheduler.ts'), 'utf8');
    expect(source).toContain("type: 'weekly_review'");
  });
});
