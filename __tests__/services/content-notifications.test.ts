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
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
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
  getUnreadCount,
  markRead,
  markAllRead,
  resolveNotification,
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
// 4. Badge Count
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
});

// ═══════════════════════════════════════════════════════════════════
// 5. Portal Admin View
// ═══════════════════════════════════════════════════════════════════

describe('content-notifications: admin view', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('getAllNotifications returns all users notifications', () => {
    createNotification({ userId: 1, type: 'topic_candidates_ready', title: 'U1', body: 'a' });
    createNotification({ userId: 2, type: 'script_ready', title: 'U2', body: 'b' });

    const all = getAllNotifications();
    expect(all).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. No Grammy in Core Workflow
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

  it('telegram-content-adapter.ts exists and contains grammy', () => {
    const adapterPath = path.resolve(__dirname, '../../src/adapters/telegram-content-adapter.ts');
    expect(fs.existsSync(adapterPath)).toBe(true);

    const source = fs.readFileSync(adapterPath, 'utf8');
    expect(source).toContain("from 'grammy'");
    expect(source).toContain('@deprecated');
  });

  it('content-workflow.ts re-exports from adapter for backward compat', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/content-workflow.ts'),
      'utf8',
    );
    expect(source).toContain('telegram-content-adapter');
    expect(source).toContain('sendTopicCandidatesTelegram as sendTopicCandidates');
    expect(source).toContain('sendWeeklyPackageTelegram as sendWeeklyPackage');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Notification Types
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
// 8. Structural Checks
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

  it('portal has admin notification endpoint', () => {
    const portalSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/server.ts'),
      'utf8',
    );
    expect(portalSource).toContain("'/api/notifications'");
    expect(portalSource).toContain('getAllNotifications');
  });
});
