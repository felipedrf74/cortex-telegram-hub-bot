/**
 * CONTENT-UI-O3 (2026-05-04): Content Performance aggregate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
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
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));
vi.mock('../../src/config', () => ({
  config: { app: { timezone: 'Europe/Lisbon' } },
}));

import { getContentPerformanceAggregate } from '../../src/state/content-performance-aggregate';
import { recordRadarFeedback } from '../../src/state/content-radar-feedback';


const USER_A = 3001;
const USER_B = 3002;

function insertTopic(
  userId: number,
  tenantId: number,
  status: string,
  scheduledDate: string | null = null,
  daysAgo = 0,
): void {
  const dateExpr = daysAgo === 0 ? "datetime('now')" : `datetime('now', '-${daysAgo} days')`;
  testDb.prepare(`
    INSERT INTO content_topics (
      user_id, tenant_id, owner_user_id, visibility_scope, scope_status,
      title, status, scheduled_date, lifecycle_state,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'user_private', 'active', ?, ?, ?, 'active', ${dateExpr}, ${dateExpr})
  `).run(userId, tenantId, userId, `Topic for ${userId}-${status}-${Math.random()}`, status, scheduledDate);
}

function insertScript(userId: number, tenantId: number, daysAgo = 0): void {
  const dateExpr = daysAgo === 0 ? "datetime('now')" : `datetime('now', '-${daysAgo} days')`;
  testDb.prepare(`
    INSERT INTO content_scripts (
      user_id, tenant_id, owner_user_id, visibility_scope, scope_status,
      topic, format, script_text, created_at
    ) VALUES (?, ?, ?, 'user_private', 'active', ?, 'youtube', 'script body', ${dateExpr})
  `).run(userId, tenantId, userId, `Script for ${userId}-${Math.random()}`);
}

function insertPerformance(
  userId: number,
  tenantId: number,
  opts: {
    title: string;
    views: number;
    retentionPct: number;
    likes?: number;
    comments?: number;
    subsGained?: number;
    daysAgo?: number;
    scopeStatus?: string;
  },
): void {
  const dateExpr = opts.daysAgo === undefined || opts.daysAgo === 0
    ? "datetime('now')"
    : `datetime('now', '-${opts.daysAgo} days')`;
  testDb.prepare(`
    INSERT INTO content_performance (
      user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
      scope_status, created_by, updated_by, audit_metadata_json, selected_title,
      video_url, views, retention_pct, likes, comments, subs_gained, logged_at
    ) VALUES (
      ?, ?, ?, 'user_private', 'active',
      ?, ?, ?, '{}', ?,
      NULL, ?, ?, ?, ?, ?, ${dateExpr}
    )
  `).run(
    userId,
    tenantId,
    userId,
    opts.scopeStatus ?? 'active',
    userId,
    userId,
    opts.title,
    opts.views,
    opts.retentionPct,
    opts.likes ?? 0,
    opts.comments ?? 0,
    opts.subsGained ?? 0,
  );
}

describe('content-performance-aggregate (CONTENT-UI-O3)', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => { if (testDb) testDb.close(); });

  it('returns the empty aggregate for a user with no data', () => {
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.topics.total).toBe(0);
    expect(a.scripts.total).toBe(0);
    expect(a.ideas.total).toBe(0);
    expect(a.radarFeedback.total).toBe(0);
    expect(a.performance.total).toBe(0);
    expect(a.highlights).toEqual([]);
  });

  it('counts topics by status', () => {
    insertTopic(USER_A, USER_A, 'planned');
    insertTopic(USER_A, USER_A, 'planned');
    insertTopic(USER_A, USER_A, 'drafting');
    insertTopic(USER_A, USER_A, 'published');
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.topics.total).toBe(4);
    expect(a.topics.byStatus.planned).toBe(2);
    expect(a.topics.byStatus.drafting).toBe(1);
    expect(a.topics.byStatus.published).toBe(1);
  });

  it('counts publishedLast30d but excludes older publishes', () => {
    insertTopic(USER_A, USER_A, 'published', null, 5);   // within 30d
    insertTopic(USER_A, USER_A, 'published', null, 50);  // older — outside window
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.topics.publishedLast30d).toBe(1);
  });

  it('aggregates radar feedback by action', () => {
    recordRadarFeedback(USER_A, USER_A, { signalId: 's1', action: 'accept', signalTopic: 'AI workflows' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's2', action: 'accept', signalTopic: 'AI workflows' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's3', action: 'reject', signalTopic: 'Crypto trading' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's4', action: 'reject', signalTopic: 'Crypto trading' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's5', action: 'reject', signalTopic: 'Crypto trading' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's6', action: 'save', signalTopic: 'Saved A' });
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.radarFeedback.total).toBe(6);
    expect(a.radarFeedback.byAction.accept).toBe(2);
    expect(a.radarFeedback.byAction.reject).toBe(3);
    expect(a.radarFeedback.byAction.save).toBe(1);
    expect(a.radarFeedback.topAcceptedTopics[0].topic).toBe('AI workflows');
    expect(a.radarFeedback.topAcceptedTopics[0].count).toBe(2);
    expect(a.radarFeedback.topRejectedTopics[0].topic).toBe('Crypto trading');
    expect(a.radarFeedback.topRejectedTopics[0].count).toBe(3);
  });

  it('uses signal summary instead of signal id when radar topic is missing', () => {
    recordRadarFeedback(USER_A, USER_A, {
      signalId: 'summary-only-1',
      action: 'accept',
      signalSummary: 'Summary-backed opportunity label',
    });

    const a = getContentPerformanceAggregate(USER_A, USER_A);

    expect(a.radarFeedback.topAcceptedTopics[0]).toEqual({
      topic: 'Summary-backed opportunity label',
      count: 1,
    });
    expect(a.radarFeedback.topAcceptedTopics[0].topic).not.toBe('summary-only-1');
  });

  it('warning fires when rejects exceed 2x accepts and reject count >= 5', () => {
    for (let i = 0; i < 6; i++) {
      recordRadarFeedback(USER_A, USER_A, { signalId: `r-${i}`, action: 'reject' });
    }
    recordRadarFeedback(USER_A, USER_A, { signalId: 'a-1', action: 'accept' });
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.warnings.some(w => w.toLowerCase().includes('under-fitting'))).toBe(true);
  });

  it('warning fires when topics exist but no scripts and no published', () => {
    for (let i = 0; i < 6; i++) {
      insertTopic(USER_A, USER_A, 'planned');
    }
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.warnings.length).toBeGreaterThanOrEqual(1);
    // Either the "no published" or "no scripts" warning
    expect(a.warnings.some(w => /no topics published|no scripts/i.test(w))).toBe(true);
  });

  it('counts scripts using the real content_scripts schema without updated_at', () => {
    insertScript(USER_A, USER_A, 2);
    insertScript(USER_A, USER_A, 45);
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.scripts.total).toBe(2);
    expect(a.scripts.last30d).toBe(1);
  });

  it('aggregates live content_performance metrics and excludes inactive or out-of-scope rows', () => {
    insertPerformance(USER_A, USER_A, {
      title: 'High-retention training explainer',
      views: 1000,
      retentionPct: 60,
      likes: 100,
      comments: 20,
      subsGained: 3,
      daysAgo: 3,
    });
    insertPerformance(USER_A, USER_A, {
      title: 'Lower-retention calendar clip',
      views: 500,
      retentionPct: 40,
      likes: 20,
      comments: 5,
      subsGained: 1,
      daysAgo: 10,
    });
    insertPerformance(USER_A, USER_A, {
      title: 'Old but popular clip',
      views: 9000,
      retentionPct: 70,
      likes: 800,
      comments: 60,
      subsGained: 20,
      daysAgo: 45,
    });
    insertPerformance(USER_A, USER_A, {
      title: 'Quarantined row',
      views: 9999,
      retentionPct: 90,
      scopeStatus: 'quarantined',
    });
    insertPerformance(USER_B, USER_B, {
      title: 'Other user row',
      views: 9999,
      retentionPct: 90,
    });

    const a = getContentPerformanceAggregate(USER_A, USER_A);

    expect(a.performance.total).toBe(3);
    expect(a.performance.last30d).toBe(2);
    expect(a.performance.avgViewsLast30d).toBe(750);
    expect(a.performance.avgRetentionLast30d).toBe(50);
    expect(a.performance.totalLikesLast30d).toBe(120);
    expect(a.performance.totalCommentsLast30d).toBe(25);
    expect(a.performance.totalSubsGainedLast30d).toBe(4);
    expect(a.performance.topByViews[0]).toMatchObject({
      title: 'Old but popular clip',
      views: 9000,
      retentionPct: 70,
    });
    expect(a.highlights.some(h => h.includes('Published content is holding attention'))).toBe(true);
  });

  it('warns when recent published performance is under-retaining viewers', () => {
    insertPerformance(USER_A, USER_A, {
      title: 'Weak hook test',
      views: 800,
      retentionPct: 18,
      daysAgo: 1,
    });
    insertPerformance(USER_A, USER_A, {
      title: 'Weak pacing test',
      views: 400,
      retentionPct: 20,
      daysAgo: 2,
    });

    const a = getContentPerformanceAggregate(USER_A, USER_A);

    expect(a.performance.last30d).toBe(2);
    expect(a.performance.avgRetentionLast30d).toBe(19);
    expect(a.warnings.some(w => w.includes('under-retaining viewers'))).toBe(true);
  });

  it('warns when recent published performance has true zero retention', () => {
    insertPerformance(USER_A, USER_A, {
      title: 'Zero-retention hook test',
      views: 800,
      retentionPct: 0,
      daysAgo: 1,
    });

    const a = getContentPerformanceAggregate(USER_A, USER_A);

    expect(a.performance.last30d).toBe(1);
    expect(a.performance.avgRetentionLast30d).toBe(0);
    expect(a.warnings.some(w => w.includes('0% average retention'))).toBe(true);
  });

  it('User A aggregate is invisible to User B', () => {
    insertTopic(USER_A, USER_A, 'published');
    recordRadarFeedback(USER_A, USER_A, { signalId: 'sa', action: 'accept' });
    insertPerformance(USER_A, USER_A, {
      title: 'A-only performance row',
      views: 1000,
      retentionPct: 60,
    });
    const b = getContentPerformanceAggregate(USER_B, USER_B);
    expect(b.topics.total).toBe(0);
    expect(b.radarFeedback.total).toBe(0);
    expect(b.performance.total).toBe(0);
  });

  it('returns empty aggregate for invalid userId', () => {
    const a = getContentPerformanceAggregate(0);
    expect(a.topics.total).toBe(0);
    expect(a.tenantId).toBe(0);
  });
});
