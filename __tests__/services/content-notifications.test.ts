/**
 * Content Notification Store — Durable Inbox Tests
 *
 * Covers:
 *   1. Notification creation and persistence
 *   2. Unread/read/resolved state transitions
 *   3. User-scoped isolation
 *   4. APNs push triggering (non-blocking)
 *   5. No grammy dependency in core workflow
 *   6. Portal admin view
 *   7. Unread count for badge display
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

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
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    anthropic: { apiKey: 'test' },
    app: { timezone: 'Europe/Lisbon' },
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip deps */ }
    }
  }
}

import {
  createNotification,
  getUnreadNotifications,
  getNotifications,
  getNotificationById,
  getUnreadCount,
  getUnreadCountExcludingNotificationIds,
  listUnreadContentNotificationIdsByTypes,
  markRead,
  markAllRead,
  resolveNotification,
  resolveContentNotificationDeepLink,
  getAllNotifications,
} from '../../src/services/content-notification-store';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

// ═══════════════════════════════════════════════════════════════════
// 1. Notification Creation
// ═══════════════════════════════════════════════════════════════════

describe('content-notifications: creation', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    clearTenantScopeAnomaliesForTests();
  });
  afterEach(() => testDb?.close());

  it('creates a notification and returns its ID', () => {
    const id = createNotification({
      userId: 1,
      type: 'topic_candidates_ready',
      title: 'New Topics Ready',
      body: '5 reel topic candidates waiting for your review',
      data: { format: 'reel', count: 5 },
    });

    expect(id).toBeGreaterThan(0);
  });

  it('stores all fields correctly', () => {
    createNotification({
      userId: 1,
      type: 'script_ready',
      title: 'Script Generated',
      body: 'Your AI Fitness script is ready',
      data: { pipelineId: 42 },
    });

    const notifications = getUnreadNotifications(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('script_ready');
    expect(notifications[0].title).toBe('Script Generated');
    expect(notifications[0].body).toBe('Your AI Fitness script is ready');
    expect(notifications[0].data).toEqual({ pipelineId: 42 });
    expect(notifications[0].status).toBe('unread');
    expect(notifications[0].pushSent).toBe(false);
  });

  it('fails closed on invalid tenant scope and records the anomaly', () => {
    const id = createNotification({
      userId: 0,
      type: 'script_ready',
      title: 'Invalid',
      body: 'Should not persist',
    });

    expect(id).toBe(-1);
    expect(getUnreadNotifications(0)).toEqual([]);
    const row = testDb.prepare('SELECT COUNT(*) as count FROM content_notifications').get() as { count: number };
    expect(row.count).toBe(0);
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'create_content_notification',
          reason: 'invalid_user_scope',
          userId: 0,
          details: { notificationType: 'script_ready' },
        }),
      ]),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. State Transitions
// ═══════════════════════════════════════════════════════════════════

describe('content-notifications: state transitions', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    clearTenantScopeAnomaliesForTests();
  });
  afterEach(() => testDb?.close());

  it('markRead changes status from unread to read', () => {
    const id = createNotification({
      userId: 1,
      type: 'topic_candidates_ready',
      title: 'Test',
      body: 'Test body',
    });

    expect(markRead(id, 1)).toBe(true);

    const notifications = getNotifications(1, { status: 'read' });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].status).toBe('read');
  });

  it('markRead returns false for wrong userId', () => {
    const id = createNotification({
      userId: 1,
      type: 'topic_candidates_ready',
      title: 'Test',
      body: 'Test body',
    });

    // User 2 can't mark user 1's notification
    expect(markRead(id, 2)).toBe(false);
  });

  it('markAllRead marks all unread as read', () => {
    createNotification({ userId: 1, type: 'topic_candidates_ready', title: 'A', body: 'a' });
    createNotification({ userId: 1, type: 'script_ready', title: 'B', body: 'b' });
    createNotification({ userId: 1, type: 'weekly_package_ready', title: 'C', body: 'c' });

    const count = markAllRead(1);
    expect(count).toBe(3);
    expect(getUnreadCount(1)).toBe(0);
  });

  it('resolveNotification sets status and resolved_at', () => {
    const id = createNotification({
      userId: 1,
      type: 'content_action_required',
      title: 'Action',
      body: 'Review topics',
    });

    expect(resolveNotification(id, 1)).toBe(true);

    const notifications = getNotifications(1, { status: 'resolved' });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].resolvedAt).not.toBeNull();
  });

  it('state transitions fail closed on invalid tenant scope', () => {
    const id = createNotification({
      userId: 1,
      type: 'content_action_required',
      title: 'Action',
      body: 'Review topics',
    });

    expect(markRead(id, 0)).toBe(false);
    expect(markAllRead(0)).toBe(0);
    expect(resolveNotification(id, 0)).toBe(false);
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: 'delivery', operation: 'mark_content_notification_read', userId: 0 }),
        expect.objectContaining({ layer: 'delivery', operation: 'mark_all_content_notifications_read', userId: 0 }),
        expect.objectContaining({ layer: 'delivery', operation: 'resolve_content_notification', userId: 0 }),
      ]),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. User Scoping
// ═══════════════════════════════════════════════════════════════════

describe('content-notifications: user scoping', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    clearTenantScopeAnomaliesForTests();
  });
  afterEach(() => testDb?.close());

  it('users only see their own notifications', () => {
    createNotification({ userId: 1, type: 'topic_candidates_ready', title: 'User 1', body: 'a' });
    createNotification({ userId: 2, type: 'script_ready', title: 'User 2', body: 'b' });

    const user1 = getUnreadNotifications(1);
    const user2 = getUnreadNotifications(2);

    expect(user1).toHaveLength(1);
    expect(user1[0].title).toBe('User 1');
    expect(user2).toHaveLength(1);
    expect(user2[0].title).toBe('User 2');
  });

  it('unread count is per-user', () => {
    createNotification({ userId: 1, type: 'topic_candidates_ready', title: 'A', body: 'a' });
    createNotification({ userId: 1, type: 'script_ready', title: 'B', body: 'b' });
    createNotification({ userId: 2, type: 'weekly_package_ready', title: 'C', body: 'c' });

    expect(getUnreadCount(1)).toBe(2);
    expect(getUnreadCount(2)).toBe(1);
  });

  it('single notification lookup is scoped to the owner user', () => {
    const user1Id = createNotification({ userId: 1, type: 'script_ready', title: 'User 1', body: 'a', data: { scriptId: 42 } });
    createNotification({ userId: 2, type: 'script_ready', title: 'User 2', body: 'b', data: { scriptId: 99 } });

    expect(getNotificationById(user1Id, 1)?.data).toEqual({ scriptId: 42 });
    expect(getNotificationById(user1Id, 2)).toBeNull();
  });

  it('read surfaces fail closed on invalid tenant scope', () => {
    createNotification({ userId: 1, type: 'topic_candidates_ready', title: 'User 1', body: 'a' });

    expect(getUnreadNotifications(0)).toEqual([]);
    expect(getNotifications(0)).toEqual([]);
    expect(getUnreadCount(0)).toBe(0);
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: 'delivery', operation: 'get_unread_content_notifications', userId: 0 }),
        expect.objectContaining({ layer: 'delivery', operation: 'get_content_notifications', userId: 0 }),
        expect.objectContaining({ layer: 'delivery', operation: 'get_unread_content_notification_count', userId: 0 }),
      ]),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Deep Link Resolver
// ═══════════════════════════════════════════════════════════════════

describe('content-notifications: deep link resolver', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    clearTenantScopeAnomaliesForTests();
  });
  afterEach(() => testDb?.close());

  it('resolves a script notification to a concrete script target without mutating status', () => {
    const id = createNotification({
      userId: 1,
      type: 'script_ready',
      title: 'Script ready',
      body: 'Review the new draft',
      data: { scriptId: 'script_42' },
    });

    const resolution = resolveContentNotificationDeepLink(id, 1);

    expect(resolution).toMatchObject({
      contractVersion: 1,
      notification: { id, status: 'unread' },
      deepLink: {
        targetKind: 'script',
        targetId: 'script_42',
        screen: 'contentScript',
        route: 'content/scripts/script_42',
        action: 'open_script',
        canOpenConcreteTarget: true,
      },
    });
    expect(getNotificationById(id, 1)?.status).toBe('unread');
  });

  it('resolves approval and source-review actions to workflow-specific targets', () => {
    const approvalId = createNotification({
      userId: 1,
      type: 'content_action_required',
      title: 'Approval needed',
      body: 'Approve this draft before scheduling',
      data: { contentObjectId: 'draft_7', approvalId: 'approval_3' },
    });
    const sourceReviewId = createNotification({
      userId: 1,
      type: 'content_action_required',
      title: 'Source review needed',
      body: 'Review provenance before publishing',
      data: { workflowObjectId: 'draft_8', action: 'source_review_required' },
    });

    expect(resolveContentNotificationDeepLink(approvalId, 1)?.deepLink).toMatchObject({
      targetKind: 'approval',
      targetId: 'draft_7',
      screen: 'contentApproval',
      route: 'content/workflow/draft_7/approval',
      action: 'review_approval',
      canOpenConcreteTarget: true,
    });
    expect(resolveContentNotificationDeepLink(sourceReviewId, 1)?.deepLink).toMatchObject({
      targetKind: 'source_review',
      targetId: 'draft_8',
      screen: 'contentSourceReview',
      route: 'content/workflow/draft_8/source-review',
      action: 'source_review_required',
      canOpenConcreteTarget: true,
    });
  });

  it('falls back to Content Home when the notification has no concrete artifact id', () => {
    const id = createNotification({
      userId: 1,
      type: 'topic_candidates_ready',
      title: 'Topics ready',
      body: 'Review new ideas',
      data: { count: 5 },
    });

    const resolution = resolveContentNotificationDeepLink(id, 1);

    expect(resolution?.deepLink).toMatchObject({
      targetKind: 'content_home',
      targetId: null,
      screen: 'contentHome',
      route: 'content/home',
      action: 'review_topics',
      canOpenConcreteTarget: false,
      reasonCodes: expect.arrayContaining(['topic_candidates_without_topic_id', 'no_concrete_content_target']),
    });
  });

  it('does not resolve another user notification', () => {
    const id = createNotification({
      userId: 1,
      type: 'script_ready',
      title: 'Private script',
      body: 'Do not leak',
      data: { scriptId: 'private_1' },
    });

    expect(resolveContentNotificationDeepLink(id, 2)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Badge Count
// ═══════════════════════════════════════════════════════════════════

describe('content-notifications: unread count', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('returns 0 for no notifications', () => {
    expect(getUnreadCount(1)).toBe(0);
  });

  it('decrements when marked read', () => {
    const id = createNotification({ userId: 1, type: 'topic_candidates_ready', title: 'A', body: 'a' });
    createNotification({ userId: 1, type: 'script_ready', title: 'B', body: 'b' });

    expect(getUnreadCount(1)).toBe(2);
    markRead(id, 1);
    expect(getUnreadCount(1)).toBe(1);
  });

  it('lists unread ids by type for the entity-stable bridge exclusion contract', () => {
    const reauthA = createNotification({ userId: 1, type: 'content_action_required', title: 'Garmin', body: 'Reconnect' });
    const reauthB = createNotification({ userId: 1, type: 'content_action_required', title: 'Garmin', body: 'Reconnect again' });
    const script = createNotification({ userId: 1, type: 'script_ready', title: 'Script', body: 'Ready' });
    const otherUser = createNotification({ userId: 2, type: 'content_action_required', title: 'Garmin', body: 'Reconnect' });
    markRead(reauthB, 1);

    // Only unread rows of the requested types for the requested user.
    expect(listUnreadContentNotificationIdsByTypes(1, ['content_action_required'])).toEqual([reauthA]);
    expect(listUnreadContentNotificationIdsByTypes(1, ['content_action_required', 'script_ready']).sort())
      .toEqual([reauthA, script].sort());
    expect(listUnreadContentNotificationIdsByTypes(2, ['content_action_required'])).toEqual([otherUser]);
    expect(listUnreadContentNotificationIdsByTypes(1, [])).toEqual([]);
    expect(listUnreadContentNotificationIdsByTypes(1, ['', '  '])).toEqual([]);
    expect(listUnreadContentNotificationIdsByTypes(0, ['content_action_required'])).toEqual([]);

    // The expanded ids feed the existing unread-count exclusion unchanged.
    expect(getUnreadCountExcludingNotificationIds(1, [reauthA, script])).toBe(0);
    expect(getUnreadCountExcludingNotificationIds(1, [reauthA])).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Portal Admin View
// ═══════════════════════════════════════════════════════════════════

describe('content-notifications: admin view', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('getAllNotifications requires an explicit portal scope', () => {
    createNotification({ userId: 1, type: 'topic_candidates_ready', title: 'U1', body: 'a' });

    expect(() => (getAllNotifications as any)()).toThrow(/notification tenant scope required/);
  });

  it('getAllNotifications returns only the requested user and tenant scope', () => {
    createNotification({ userId: 1, type: 'topic_candidates_ready', title: 'U1', body: 'a' });
    createNotification({ userId: 2, type: 'script_ready', title: 'U2', body: 'b' });

    const all = getAllNotifications(100, { userId: 1, tenantId: 1 });
    expect(all).toHaveLength(1);
    expect(all[0].userId).toBe(1);
  });

  it('getAllNotifications rejects forged cross-tenant portal scope', () => {
    createNotification({ userId: 1, type: 'topic_candidates_ready', title: 'U1', body: 'a' });

    expect(() => getAllNotifications(100, { userId: 1, tenantId: 2 })).toThrow(/notification tenant scope required/);
  });

  it('getAllNotifications does not leak another user when scoped', () => {
    createNotification({ userId: 1, type: 'topic_candidates_ready', title: 'U1', body: 'a' });
    createNotification({ userId: 2, type: 'script_ready', title: 'U2', body: 'b' });

    const all = getAllNotifications(100, { userId: 2, tenantId: 2 });
    expect(all).toHaveLength(1);
    expect(all.map((item) => item.userId)).toEqual([2]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. No Grammy in Core Workflow
// ═══════════════════════════════════════════════════════════════════

describe('content-notifications: no grammy in core workflow', () => {
  it('content-workflow.ts has no grammy import', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/content-workflow.ts'),
      'utf8',
    );

    const lines = source.split('\n');
    const grammyImports = lines.filter((line: string) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) return false;
      return trimmed.startsWith('import') && trimmed.includes("'grammy'");
    });

    expect(grammyImports).toHaveLength(0);
  });

  it('the legacy telegram-content-adapter module is gone', () => {
    const adapterPath = path.resolve(__dirname, '../../src/adapters/telegram-content-adapter.ts');
    expect(fs.existsSync(adapterPath)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. Notification Types
// ═══════════════════════════════════════════════════════════════════

describe('content-notifications: type filtering', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('filters by notification type', () => {
    createNotification({ userId: 1, type: 'topic_candidates_ready', title: 'Topics', body: 'a' });
    createNotification({ userId: 1, type: 'script_ready', title: 'Script', body: 'b' });
    createNotification({ userId: 1, type: 'weekly_package_ready', title: 'Weekly', body: 'c' });

    const scripts = getNotifications(1, { type: 'script_ready' });
    expect(scripts).toHaveLength(1);
    expect(scripts[0].type).toBe('script_ready');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. Structural Checks
// ═══════════════════════════════════════════════════════════════════

describe('content-notifications: structural', () => {
  it('migration 061 creates content_notifications table', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/061_content_notifications.sql'),
      'utf8',
    );
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS content_notifications');
    expect(migration).toContain('user_id');
    expect(migration).toContain('type');
    expect(migration).toContain('status');
    expect(migration).toContain('push_sent');
  });

  it('notification routes exist in iOS API', () => {
    const routerSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/router.ts'),
      'utf8',
    );
    expect(routerSource).toContain('notificationRoutes');
    expect(routerSource).toContain("'/notifications'");
  });

  it('content notification deep-link resolver is registered under the Content API', () => {
    const contentRouterSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/content.ts'),
      'utf8',
    );
    const resolverSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/content-notification-routes.ts'),
      'utf8',
    );

    expect(contentRouterSource).toContain('registerContentNotificationRoutes');
    expect(resolverSource).toContain("GET /api/v1/content/notifications/:id");
    expect(resolverSource).toContain("router.get('/notifications/:id'");
  });

  it('portal has admin notification endpoint', () => {
    const portalSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/document-routes.ts'),
      'utf8',
    );
    expect(portalSource).toContain("'/api/notifications'");
    expect(portalSource).toContain('getAllNotifications');
  });
});
