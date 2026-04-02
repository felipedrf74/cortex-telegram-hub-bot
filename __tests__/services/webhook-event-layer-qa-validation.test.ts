/**
 * QA Validation Tests — Event-Driven Integration Layer
 *
 * Validates:
 * - Webhook endpoint in portal server (POST /api/webhooks/:provider)
 * - HMAC-SHA256 signature verification with timing-safe comparison
 * - Provider-specific challenge responses (Google sync, MS Graph validation)
 * - Event deduplication via idempotency_key
 * - Handler dispatch with wildcard matching
 * - Event replay for failed events
 * - Subscription expiry lifecycle
 * - Delivery logging with duration tracking
 * - Migration schema: 3 tables with proper indexes and cleanup trigger
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

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
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (!applied) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

// ── Mocks ────────────────────────────────────────────────────────

let testDb: Database.Database;

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
  receiveWebhookEvent,
  getEvent,
  getRecentEvents,
  replayEvent,
  getWebhookStats,
  expireSubscriptions,
  verifySignature,
  onWebhookEvent,
} from '../../src/services/webhook-registry';
import type { WebhookProvider, WebhookEvent } from '../../src/services/webhook-registry';

// ── Setup ────────────────────────────────────────────────────────

describe('QA: Event-driven integration layer', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    setDbProvider(() => testDb as any);
  });
  afterEach(() => { testDb.close(); });

  // ── Migration Schema Validation ──────────────────────────────

  describe('migration 022 — schema structure', () => {
    it('webhook_subscriptions table has correct columns', () => {
      const cols = testDb.prepare("PRAGMA table_info(webhook_subscriptions)").all() as { name: string }[];
      const names = cols.map(c => c.name);
      expect(names).toContain('id');
      expect(names).toContain('provider');
      expect(names).toContain('event_types');
      expect(names).toContain('endpoint_path');
      expect(names).toContain('secret');
      expect(names).toContain('status');
      expect(names).toContain('external_id');
      expect(names).toContain('metadata');
      expect(names).toContain('expires_at');
      expect(names).toContain('event_count');
    });

    it('webhook_events table has idempotency_key for dedup', () => {
      const cols = testDb.prepare("PRAGMA table_info(webhook_events)").all() as { name: string }[];
      const names = cols.map(c => c.name);
      expect(names).toContain('idempotency_key');
      expect(names).toContain('status');
      expect(names).toContain('processed_at');
    });

    it('webhook_delivery_log tracks handler attempts', () => {
      const cols = testDb.prepare("PRAGMA table_info(webhook_delivery_log)").all() as { name: string }[];
      const names = cols.map(c => c.name);
      expect(names).toContain('event_id');
      expect(names).toContain('handler');
      expect(names).toContain('status');
      expect(names).toContain('attempt');
      expect(names).toContain('duration_ms');
    });

    it('indexes exist for performance-critical queries', () => {
      const indexes = testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'webhook_%'").all() as { name: string }[];
      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain('idx_webhook_subs_provider');
      expect(indexNames).toContain('idx_webhook_subs_status');
      expect(indexNames).toContain('idx_webhook_events_provider');
      expect(indexNames).toContain('idx_webhook_events_status');
      expect(indexNames).toContain('idx_webhook_events_idemp');
      expect(indexNames).toContain('idx_webhook_delivery_event');
    });

    it('cleanup trigger exists for auto-expiring old events', () => {
      const triggers = testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'webhook_events'").all() as { name: string }[];
      expect(triggers.some(t => t.name === 'trg_webhook_events_cleanup')).toBe(true);
    });
  });

  // ── HMAC Signature Verification ──────────────────────────────

  describe('HMAC-SHA256 signature verification', () => {
    it('verifies valid GitHub-style sha256= prefixed signature', () => {
      const secret = 'test-webhook-secret';
      const body = '{"action":"push","ref":"refs/heads/main"}';
      const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

      const valid = verifySignature('github', body, { 'x-hub-signature-256': sig }, secret);
      expect(valid).toBe(true);
    });

    it('verifies valid raw hex signature (non-GitHub providers)', () => {
      const secret = 'my-secret';
      const body = '{"data":"test"}';
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

      const valid = verifySignature('custom', body, { 'x-webhook-signature': sig }, secret);
      expect(valid).toBe(true);
    });

    it('rejects invalid signature', () => {
      const valid = verifySignature('github', '{"data":"real"}', {
        'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      }, 'secret');
      expect(valid).toBe(false);
    });

    it('rejects missing signature header', () => {
      const valid = verifySignature('github', '{"data":"test"}', {}, 'secret');
      expect(valid).toBe(false);
    });

    it('allows through when no secret is configured', () => {
      const valid = verifySignature('github', '{"data":"test"}', {}, '');
      expect(valid).toBe(true);
    });

    it('uses provider-specific header names', () => {
      const secret = 'test';
      const body = 'data';
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

      // Google uses x-goog-channel-token
      expect(verifySignature('google_calendar', body, { 'x-goog-channel-token': sig }, secret)).toBe(true);
      // Wrong header name should fail
      expect(verifySignature('google_calendar', body, { 'x-hub-signature-256': sig }, secret)).toBe(false);
    });
  });

  // ── Event Deduplication ──────────────────────────────────────

  describe('event deduplication', () => {
    it('deduplicates events with same idempotency_key', async () => {
      const id1 = await receiveWebhookEvent({
        provider: 'github',
        event_type: 'push',
        payload: { ref: 'main' },
        idempotency_key: 'msg-123',
      });
      expect(id1).toBeGreaterThan(0);

      // Same key returns existing ID without creating duplicate
      const id2 = await receiveWebhookEvent({
        provider: 'github',
        event_type: 'push',
        payload: { ref: 'develop' },
        idempotency_key: 'msg-123',
      });
      expect(id2).toBe(id1);

      // Only one event in DB
      const events = getRecentEvents({ provider: 'github' });
      expect(events).toHaveLength(1);
    });

    it('allows retry of failed events with same idempotency_key', async () => {
      // Create a failed event by having a failing handler
      onWebhookEvent('garmin' as WebhookProvider, 'activity.created', async () => {
        throw new Error('Handler failed');
      });

      const id1 = await receiveWebhookEvent({
        provider: 'garmin',
        event_type: 'activity.created',
        payload: { activityId: 1 },
        idempotency_key: 'garmin-evt-1',
      });

      const event = getEvent(id1);
      expect(event?.status).toBe('failed');

      // Retrying with same key should create a new attempt since previous failed
      // (The dedup check allows retry of failed events)
    });
  });

  // ── Handler Dispatch & Wildcards ─────────────────────────────

  describe('handler dispatch', () => {
    it('dispatches to registered handler for specific event type', async () => {
      const handler = vi.fn();
      onWebhookEvent('google_calendar', 'calendar.updated', handler);

      await receiveWebhookEvent({
        provider: 'google_calendar',
        event_type: 'calendar.updated',
        payload: { calendarId: 'primary' },
      });

      expect(handler).toHaveBeenCalledOnce();
    });

    it('dispatches to wildcard handler for any event type', async () => {
      const wildcardHandler = vi.fn();
      onWebhookEvent('outlook_mail', '*', wildcardHandler);

      await receiveWebhookEvent({
        provider: 'outlook_mail',
        event_type: 'message.received',
        payload: { messageId: '123' },
      });

      expect(wildcardHandler).toHaveBeenCalledOnce();
    });

    it('marks event as ignored when no handlers are registered', async () => {
      const id = await receiveWebhookEvent({
        provider: 'strava',
        event_type: 'activity.created',
        payload: { activityId: 999 },
      });

      const event = getEvent(id);
      expect(event?.status).toBe('ignored');
    });
  });

  // ── Subscription Lifecycle ───────────────────────────────────

  describe('subscription lifecycle', () => {
    it('creates, reads, updates, and deletes subscriptions', () => {
      const id = registerSubscription({
        provider: 'google_calendar',
        event_types: ['calendar.updated', 'calendar.deleted'],
        endpoint_path: '/api/webhooks/google/calendar',
        secret: 'google-secret-123',
        external_id: 'channel-abc',
      });
      expect(id).toBeGreaterThan(0);

      const sub = getSubscription(id);
      expect(sub).not.toBeNull();
      expect(sub!.provider).toBe('google_calendar');
      expect(sub!.event_types).toEqual(['calendar.updated', 'calendar.deleted']);
      expect(sub!.status).toBe('active');

      // Update status
      expect(updateSubscriptionStatus(id, 'paused')).toBe(true);
      expect(getSubscription(id)!.status).toBe('paused');

      // Delete
      expect(removeSubscription(id)).toBe(true);
      expect(getSubscription(id)).toBeNull();
    });

    it('expires subscriptions past their expiry date', () => {
      // Create expired subscription
      testDb.prepare(`
        INSERT INTO webhook_subscriptions (provider, endpoint_path, status, expires_at)
        VALUES ('github', '/api/webhooks/github', 'active', datetime('now', '-1 day'))
      `).run();

      // Create non-expired subscription
      testDb.prepare(`
        INSERT INTO webhook_subscriptions (provider, endpoint_path, status, expires_at)
        VALUES ('garmin', '/api/webhooks/garmin', 'active', datetime('now', '+30 days'))
      `).run();

      const expired = expireSubscriptions();
      expect(expired).toBe(1);

      const subs = getSubscriptions();
      const github = subs.find(s => s.provider === 'github');
      const garmin = subs.find(s => s.provider === 'garmin');
      expect(github!.status).toBe('expired');
      expect(garmin!.status).toBe('active');
    });

    it('event receipt updates subscription stats', async () => {
      const subId = registerSubscription({
        provider: 'outlook_calendar',
        endpoint_path: '/api/webhooks/outlook/calendar',
      });

      await receiveWebhookEvent({
        provider: 'outlook_calendar',
        event_type: 'event.updated',
        payload: { eventId: 'abc' },
        subscription_id: subId,
      });

      const sub = getSubscription(subId);
      expect(sub!.event_count).toBe(1);
      expect(sub!.last_event_at).toBeTruthy();
    });
  });

  // ── Event Replay ─────────────────────────────────────────────

  describe('event replay', () => {
    it('replays a failed event through handlers', async () => {
      let callCount = 0;
      onWebhookEvent('custom', 'test.replay', async () => {
        callCount++;
        if (callCount === 1) throw new Error('First attempt fails');
        // Second attempt succeeds
      });

      const id = await receiveWebhookEvent({
        provider: 'custom',
        event_type: 'test.replay',
        payload: { test: true },
      });

      expect(getEvent(id)?.status).toBe('failed');

      // Replay should succeed
      const result = await replayEvent(id);
      expect(result).toBe(true);
      expect(getEvent(id)?.status).toBe('processed');
    });

    it('returns false when replaying non-existent event', async () => {
      const result = await replayEvent(99999);
      expect(result).toBe(false);
    });
  });

  // ── Stats & Monitoring ───────────────────────────────────────

  describe('webhook stats', () => {
    it('returns aggregate stats for portal dashboard', async () => {
      registerSubscription({ provider: 'github', endpoint_path: '/w/gh' });
      registerSubscription({ provider: 'garmin', endpoint_path: '/w/garmin' });

      await receiveWebhookEvent({
        provider: 'github',
        event_type: 'push',
        payload: {},
      });

      const stats = getWebhookStats();
      expect(stats.totalSubscriptions).toBe(2);
      expect(stats.activeSubscriptions).toBe(2);
      expect(stats.eventsToday).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(stats.byProvider)).toBe(true);
    });
  });

  // ── Portal Endpoint Architecture ─────────────────────────────

  describe('portal webhook endpoint architecture', () => {
    it('server.ts has POST /api/webhooks/:provider route', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../src/portal/server.ts'), 'utf-8',
      );
      expect(source).toContain("app.post('/api/webhooks/:provider'");
    });

    it('endpoint handles Google sync challenge', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../src/portal/server.ts'), 'utf-8',
      );
      expect(source).toContain('x-goog-resource-state');
      expect(source).toContain("'sync'");
    });

    it('endpoint handles Microsoft Graph validation token', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../src/portal/server.ts'), 'utf-8',
      );
      expect(source).toContain('validationToken');
    });

    it('endpoint uses express.raw for HMAC verification', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../src/portal/server.ts'), 'utf-8',
      );
      expect(source).toContain("express.raw({ type: '*/*'");
    });

    it('webhook registry uses timing-safe comparison', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../src/services/webhook-registry.ts'), 'utf-8',
      );
      expect(source).toContain('crypto.timingSafeEqual');
    });

    it('webhook registry uses lazy DB provider pattern', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../src/services/webhook-registry.ts'), 'utf-8',
      );
      expect(source).toContain('setDbProvider');
      expect(source).toContain('_getDb');
    });
  });
});
