/**
 * Webhook Registry Tests
 *
 * Tests subscription CRUD, HMAC signature verification, event logging,
 * idempotency/dedup, handler dispatch, delivery tracking, replay,
 * stats queries, and subscription expiry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

// Mock dependencies
let testDb: Database.Database;
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../../src/portal/telemetry', () => ({
  pushEvent: vi.fn(),
}));

import {
  setDbProvider,
  registerSubscription,
  getSubscriptions,
  getSubscription,
  updateSubscriptionStatus,
  removeSubscription,
  verifySignature,
  receiveWebhookEvent,
  getRecentEvents,
  replayEvent,
  getWebhookStats,
  expireSubscriptions,
  onWebhookEvent,
  type WebhookEvent,
} from '../../src/services/webhook-registry';
import { pushEvent } from '../../src/portal/telemetry';

describe('Webhook Registry', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    setDbProvider(() => testDb);
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  // ── Migration Tests ──────────────────────────────────────────────

  describe('migration 022_webhook_events.sql', () => {
    it('creates webhook_subscriptions table with correct columns', () => {
      const info = testDb.prepare("PRAGMA table_info('webhook_subscriptions')").all() as any[];
      const colNames = info.map(c => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('provider');
      expect(colNames).toContain('event_types');
      expect(colNames).toContain('endpoint_path');
      expect(colNames).toContain('secret');
      expect(colNames).toContain('status');
      expect(colNames).toContain('external_id');
      expect(colNames).toContain('metadata');
      expect(colNames).toContain('expires_at');
      expect(colNames).toContain('last_event_at');
      expect(colNames).toContain('event_count');
      expect(colNames).toContain('created_at');
      expect(colNames).toContain('updated_at');
    });

    it('creates webhook_events table with correct columns', () => {
      const info = testDb.prepare("PRAGMA table_info('webhook_events')").all() as any[];
      const colNames = info.map(c => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('subscription_id');
      expect(colNames).toContain('provider');
      expect(colNames).toContain('event_type');
      expect(colNames).toContain('payload');
      expect(colNames).toContain('headers');
      expect(colNames).toContain('status');
      expect(colNames).toContain('error_message');
      expect(colNames).toContain('idempotency_key');
      expect(colNames).toContain('received_at');
      expect(colNames).toContain('processed_at');
    });

    it('creates webhook_delivery_log table with correct columns', () => {
      const info = testDb.prepare("PRAGMA table_info('webhook_delivery_log')").all() as any[];
      const colNames = info.map(c => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('event_id');
      expect(colNames).toContain('handler');
      expect(colNames).toContain('status');
      expect(colNames).toContain('attempt');
      expect(colNames).toContain('duration_ms');
      expect(colNames).toContain('error_message');
      expect(colNames).toContain('created_at');
    });

    it('has indexes on webhook tables', () => {
      const indexes = testDb.prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_webhook%'"
      ).all() as any[];
      const names = indexes.map(i => i.name);
      expect(names).toContain('idx_webhook_subs_provider');
      expect(names).toContain('idx_webhook_subs_status');
      expect(names).toContain('idx_webhook_events_provider');
      expect(names).toContain('idx_webhook_events_status');
      expect(names).toContain('idx_webhook_events_received');
      expect(names).toContain('idx_webhook_events_idemp');
      expect(names).toContain('idx_webhook_delivery_event');
      expect(names).toContain('idx_webhook_delivery_status');
    });
  });

  // ── Subscription CRUD ────────────────────────────────────────────

  describe('registerSubscription()', () => {
    it('creates a subscription and returns ID', () => {
      const id = registerSubscription({
        provider: 'google_calendar',
        endpoint_path: '/api/webhooks/google_calendar',
        event_types: ['update', 'delete'],
      });
      expect(id).toBeGreaterThan(0);
    });

    it('stores event types as JSON', () => {
      const id = registerSubscription({
        provider: 'outlook_mail',
        endpoint_path: '/api/webhooks/outlook_mail',
        event_types: ['created', 'updated'],
      });
      const row = testDb.prepare('SELECT event_types FROM webhook_subscriptions WHERE id = ?').get(id) as any;
      expect(JSON.parse(row.event_types)).toEqual(['created', 'updated']);
    });

    it('defaults event_types to ["*"]', () => {
      const id = registerSubscription({
        provider: 'garmin',
        endpoint_path: '/api/webhooks/garmin',
      });
      const row = testDb.prepare('SELECT event_types FROM webhook_subscriptions WHERE id = ?').get(id) as any;
      expect(JSON.parse(row.event_types)).toEqual(['*']);
    });

    it('stores metadata as JSON', () => {
      const id = registerSubscription({
        provider: 'google_calendar',
        endpoint_path: '/api/webhooks/google_calendar',
        metadata: { calendarId: 'primary', resourceId: 'abc123' },
      });
      const row = testDb.prepare('SELECT metadata FROM webhook_subscriptions WHERE id = ?').get(id) as any;
      const meta = JSON.parse(row.metadata);
      expect(meta.calendarId).toBe('primary');
      expect(meta.resourceId).toBe('abc123');
    });

    it('stores secret and external_id', () => {
      const id = registerSubscription({
        provider: 'github',
        endpoint_path: '/api/webhooks/github',
        secret: 'my-secret-key',
        external_id: 'hook_12345',
      });
      const sub = getSubscription(id);
      expect(sub?.secret).toBe('my-secret-key');
      expect(sub?.external_id).toBe('hook_12345');
    });

    it('pushes telemetry event', () => {
      registerSubscription({
        provider: 'strava',
        endpoint_path: '/api/webhooks/strava',
      });
      expect(pushEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'auth',
        summary: expect.stringContaining('strava'),
      }));
    });
  });

  describe('getSubscriptions()', () => {
    it('returns all subscriptions', () => {
      registerSubscription({ provider: 'google_calendar', endpoint_path: '/a' });
      registerSubscription({ provider: 'outlook_mail', endpoint_path: '/b' });

      const subs = getSubscriptions();
      expect(subs.length).toBe(2);
    });

    it('filters by provider', () => {
      registerSubscription({ provider: 'google_calendar', endpoint_path: '/a' });
      registerSubscription({ provider: 'outlook_mail', endpoint_path: '/b' });
      registerSubscription({ provider: 'google_calendar', endpoint_path: '/c' });

      const subs = getSubscriptions({ provider: 'google_calendar' });
      expect(subs.length).toBe(2);
      expect(subs.every(s => s.provider === 'google_calendar')).toBe(true);
    });

    it('filters by status', () => {
      const id1 = registerSubscription({ provider: 'garmin', endpoint_path: '/a' });
      registerSubscription({ provider: 'strava', endpoint_path: '/b' });
      updateSubscriptionStatus(id1, 'paused');

      const active = getSubscriptions({ status: 'active' });
      expect(active.length).toBe(1);
      expect(active[0].provider).toBe('strava');
    });
  });

  describe('updateSubscriptionStatus()', () => {
    it('changes subscription status', () => {
      const id = registerSubscription({ provider: 'garmin', endpoint_path: '/a' });
      const ok = updateSubscriptionStatus(id, 'paused');
      expect(ok).toBe(true);

      const sub = getSubscription(id);
      expect(sub?.status).toBe('paused');
    });

    it('returns false for non-existent subscription', () => {
      const ok = updateSubscriptionStatus(9999, 'paused');
      expect(ok).toBe(false);
    });
  });

  describe('removeSubscription()', () => {
    it('deletes subscription', () => {
      const id = registerSubscription({ provider: 'garmin', endpoint_path: '/a' });
      const ok = removeSubscription(id);
      expect(ok).toBe(true);
      expect(getSubscription(id)).toBeNull();
    });

    it('returns false for non-existent subscription', () => {
      expect(removeSubscription(9999)).toBe(false);
    });
  });

  // ── HMAC Signature Verification ──────────────────────────────────

  describe('verifySignature()', () => {
    it('verifies valid HMAC-SHA256 signature', () => {
      const secret = 'test-webhook-secret';
      const body = '{"event":"test"}';
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

      const valid = verifySignature('custom', body, { 'x-webhook-signature': sig }, secret);
      expect(valid).toBe(true);
    });

    it('rejects invalid signature', () => {
      const secret = 'test-webhook-secret';
      const body = '{"event":"test"}';

      const valid = verifySignature('custom', body, { 'x-webhook-signature': 'deadbeef' }, secret);
      expect(valid).toBe(false);
    });

    it('handles GitHub sha256= prefix', () => {
      const secret = 'github-secret';
      const body = '{"action":"push"}';
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

      const valid = verifySignature('github', body, { 'x-hub-signature-256': `sha256=${sig}` }, secret);
      expect(valid).toBe(true);
    });

    it('uses provider-specific header name', () => {
      const secret = 'google-secret';
      const body = '{"resourceId":"abc"}';
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

      // Google uses x-goog-channel-token
      const valid = verifySignature('google_calendar', body, { 'x-goog-channel-token': sig }, secret);
      expect(valid).toBe(true);
    });

    it('returns true when no secret configured', () => {
      const valid = verifySignature('custom', 'body', {}, '');
      expect(valid).toBe(true);
    });

    it('returns false when signature header is missing', () => {
      const valid = verifySignature('custom', 'body', {}, 'secret');
      expect(valid).toBe(false);
    });

    it('handles Buffer body', () => {
      const secret = 'buffer-test';
      const body = Buffer.from('{"test":true}');
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

      const valid = verifySignature('custom', body, { 'x-webhook-signature': sig }, secret);
      expect(valid).toBe(true);
    });
  });

  // ── Event Logging & Dispatch ─────────────────────────────────────

  describe('receiveWebhookEvent()', () => {
    it('logs event to database', async () => {
      const eventId = await receiveWebhookEvent({
        provider: 'google_calendar',
        event_type: 'update',
        payload: { calendarId: 'primary', resourceId: 'xyz' },
      });
      expect(eventId).toBeGreaterThan(0);

      const row = testDb.prepare('SELECT * FROM webhook_events WHERE id = ?').get(eventId) as any;
      expect(row.provider).toBe('google_calendar');
      expect(row.event_type).toBe('update');
      expect(JSON.parse(row.payload).calendarId).toBe('primary');
    });

    it('marks event as ignored when no handlers registered', async () => {
      const eventId = await receiveWebhookEvent({
        provider: 'garmin',
        event_type: 'activity',
        payload: { activityId: 123 },
      });

      const row = testDb.prepare('SELECT status FROM webhook_events WHERE id = ?').get(eventId) as any;
      expect(row.status).toBe('ignored');
    });

    it('dispatches to registered handlers', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      onWebhookEvent('strava', 'activity', handler);

      const eventId = await receiveWebhookEvent({
        provider: 'strava',
        event_type: 'activity',
        payload: { object_id: 456 },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'strava',
        event_type: 'activity',
      }));

      const row = testDb.prepare('SELECT status FROM webhook_events WHERE id = ?').get(eventId) as any;
      expect(row.status).toBe('processed');
    });

    it('dispatches to wildcard handlers', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      onWebhookEvent('outlook_calendar', '*', handler);

      await receiveWebhookEvent({
        provider: 'outlook_calendar',
        event_type: 'updated',
        payload: { changeType: 'updated' },
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('records delivery log on success', async () => {
      onWebhookEvent('github', 'push', vi.fn().mockResolvedValue(undefined));

      const eventId = await receiveWebhookEvent({
        provider: 'github',
        event_type: 'push',
        payload: { ref: 'refs/heads/main' },
      });

      const deliveries = testDb.prepare(
        'SELECT * FROM webhook_delivery_log WHERE event_id = ?'
      ).all(eventId) as any[];
      expect(deliveries.length).toBe(1);
      expect(deliveries[0].status).toBe('success');
      expect(deliveries[0].duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('records delivery failure and marks event as failed', async () => {
      onWebhookEvent('custom', 'fail_test', vi.fn().mockRejectedValue(new Error('handler exploded')));

      const eventId = await receiveWebhookEvent({
        provider: 'custom',
        event_type: 'fail_test',
        payload: { ref: 'refs/heads/main' },
      });

      const delivery = testDb.prepare(
        'SELECT * FROM webhook_delivery_log WHERE event_id = ?'
      ).get(eventId) as any;
      expect(delivery.status).toBe('failed');
      expect(delivery.error_message).toContain('handler exploded');

      const event = testDb.prepare('SELECT status, error_message FROM webhook_events WHERE id = ?').get(eventId) as any;
      expect(event.status).toBe('failed');
      expect(event.error_message).toContain('handler exploded');
    });

    it('updates subscription stats on event receipt', async () => {
      const subId = registerSubscription({
        provider: 'google_calendar',
        endpoint_path: '/api/webhooks/google_calendar',
      });

      await receiveWebhookEvent({
        provider: 'google_calendar',
        event_type: 'update',
        payload: { resourceId: 'abc' },
        subscription_id: subId,
      });

      const sub = getSubscription(subId);
      expect(sub?.event_count).toBe(1);
      expect(sub?.last_event_at).toBeTruthy();
    });

    it('pushes telemetry event', async () => {
      await receiveWebhookEvent({
        provider: 'garmin',
        event_type: 'activity',
        payload: { activityId: 789 },
      });

      expect(pushEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'job',
        summary: expect.stringContaining('garmin/activity'),
      }));
    });

    it('stores headers as JSON', async () => {
      const eventId = await receiveWebhookEvent({
        provider: 'github',
        event_type: 'push',
        payload: { ref: 'refs/heads/main' },
        headers: { 'x-github-event': 'push', 'x-github-delivery': 'abc-123' },
      });

      const row = testDb.prepare('SELECT headers FROM webhook_events WHERE id = ?').get(eventId) as any;
      const headers = JSON.parse(row.headers);
      expect(headers['x-github-event']).toBe('push');
    });
  });

  // ── Idempotency / Dedup ──────────────────────────────────────────

  describe('idempotency', () => {
    it('deduplicates events with same idempotency key', async () => {
      const eventId1 = await receiveWebhookEvent({
        provider: 'google_calendar',
        event_type: 'update',
        payload: { data: 'first' },
        idempotency_key: 'msg-001',
      });

      const eventId2 = await receiveWebhookEvent({
        provider: 'google_calendar',
        event_type: 'update',
        payload: { data: 'duplicate' },
        idempotency_key: 'msg-001',
      });

      expect(eventId2).toBe(eventId1);
      const count = (testDb.prepare('SELECT COUNT(*) as c FROM webhook_events').get() as any).c;
      expect(count).toBe(1);
    });

    it('allows different idempotency keys', async () => {
      await receiveWebhookEvent({
        provider: 'google_calendar',
        event_type: 'update',
        payload: { data: 'first' },
        idempotency_key: 'msg-001',
      });

      await receiveWebhookEvent({
        provider: 'google_calendar',
        event_type: 'update',
        payload: { data: 'second' },
        idempotency_key: 'msg-002',
      });

      const count = (testDb.prepare('SELECT COUNT(*) as c FROM webhook_events').get() as any).c;
      expect(count).toBe(2);
    });
  });

  // ── Replay ───────────────────────────────────────────────────────

  describe('replayEvent()', () => {
    it('replays a failed event through handlers', async () => {
      let callCount = 0;
      onWebhookEvent('custom', 'test', async () => {
        callCount++;
        if (callCount === 1) throw new Error('first try failed');
      });

      const eventId = await receiveWebhookEvent({
        provider: 'custom',
        event_type: 'test',
        payload: { data: 'retry-me' },
      });

      // First attempt failed
      let event = testDb.prepare('SELECT status FROM webhook_events WHERE id = ?').get(eventId) as any;
      expect(event.status).toBe('failed');

      // Replay should succeed (second invocation won't throw)
      const success = await replayEvent(eventId);
      expect(success).toBe(true);

      event = testDb.prepare('SELECT status FROM webhook_events WHERE id = ?').get(eventId) as any;
      expect(event.status).toBe('processed');
    });

    it('returns false for non-existent event', async () => {
      const success = await replayEvent(9999);
      expect(success).toBe(false);
    });
  });

  // ── Recent Events Query ──────────────────────────────────────────

  describe('getRecentEvents()', () => {
    it('returns recent events newest-first', async () => {
      await receiveWebhookEvent({ provider: 'garmin', event_type: 'activity', payload: { n: 1 } });
      await receiveWebhookEvent({ provider: 'garmin', event_type: 'activity', payload: { n: 2 } });

      const events = getRecentEvents();
      expect(events.length).toBe(2);
      expect(events[0].payload).toEqual({ n: 2 });
    });

    it('filters by provider', async () => {
      await receiveWebhookEvent({ provider: 'garmin', event_type: 'activity', payload: {} });
      await receiveWebhookEvent({ provider: 'strava', event_type: 'activity', payload: {} });

      const events = getRecentEvents({ provider: 'garmin' });
      expect(events.length).toBe(1);
      expect(events[0].provider).toBe('garmin');
    });

    it('filters by status', async () => {
      await receiveWebhookEvent({ provider: 'garmin', event_type: 'a', payload: {} });
      await receiveWebhookEvent({ provider: 'strava', event_type: 'b', payload: {} });
      // Both events will be 'ignored' since no handler is registered for these
      const events = getRecentEvents({ status: 'ignored' });
      expect(events.length).toBe(2);
    });

    it('respects limit', async () => {
      for (let i = 0; i < 10; i++) {
        await receiveWebhookEvent({ provider: 'custom', event_type: 'test', payload: { i } });
      }
      const events = getRecentEvents({ limit: 3 });
      expect(events.length).toBe(3);
    });
  });

  // ── Stats ────────────────────────────────────────────────────────

  describe('getWebhookStats()', () => {
    it('returns zeros with no data', () => {
      const stats = getWebhookStats();
      expect(stats.totalSubscriptions).toBe(0);
      expect(stats.activeSubscriptions).toBe(0);
      expect(stats.eventsToday).toBe(0);
      expect(stats.eventsLast7d).toBe(0);
      expect(stats.failedToday).toBe(0);
      expect(stats.byProvider).toEqual([]);
    });

    it('counts subscriptions correctly', () => {
      registerSubscription({ provider: 'google_calendar', endpoint_path: '/a' });
      const id2 = registerSubscription({ provider: 'garmin', endpoint_path: '/b' });
      registerSubscription({ provider: 'strava', endpoint_path: '/c' });
      updateSubscriptionStatus(id2, 'paused');

      const stats = getWebhookStats();
      expect(stats.totalSubscriptions).toBe(3);
      expect(stats.activeSubscriptions).toBe(2);
    });

    it('counts events by provider', async () => {
      await receiveWebhookEvent({ provider: 'google_calendar', event_type: 'update', payload: {} });
      await receiveWebhookEvent({ provider: 'google_calendar', event_type: 'update', payload: {} });
      await receiveWebhookEvent({ provider: 'garmin', event_type: 'activity', payload: {} });

      const stats = getWebhookStats();
      expect(stats.eventsToday).toBe(3);
      expect(stats.eventsLast7d).toBe(3);

      const googleStats = stats.byProvider.find(p => p.provider === 'google_calendar');
      expect(googleStats?.count).toBe(2);
    });
  });

  // ── Subscription Expiry ──────────────────────────────────────────

  describe('expireSubscriptions()', () => {
    it('expires subscriptions past their expires_at', () => {
      registerSubscription({
        provider: 'google_calendar',
        endpoint_path: '/a',
        expires_at: '2020-01-01T00:00:00Z', // long past
      });
      registerSubscription({
        provider: 'garmin',
        endpoint_path: '/b',
        // no expires_at — should not expire
      });

      const expired = expireSubscriptions();
      expect(expired).toBe(1);

      const subs = getSubscriptions();
      const googleSub = subs.find(s => s.provider === 'google_calendar');
      const garminSub = subs.find(s => s.provider === 'garmin');
      expect(googleSub?.status).toBe('expired');
      expect(garminSub?.status).toBe('active');
    });

    it('returns 0 when nothing to expire', () => {
      registerSubscription({ provider: 'garmin', endpoint_path: '/a' });
      expect(expireSubscriptions()).toBe(0);
    });
  });
});
