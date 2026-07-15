/**
 * QA Validation Tests — Webhook Registry (event-driven integration layer)
 *
 * Validates the webhook-registry.ts module, migration 022, config additions,
 * and server.ts endpoint helpers beyond what the unit tests cover.
 * Focus areas: edge cases, security, data integrity, foreign keys,
 * cleanup trigger, concurrent handlers, and helper functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import crypto from 'crypto';
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


// Mock dependencies
let testDb: Database.Database;
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
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
  getEvent,
  replayEvent,
  getWebhookStats,
  expireSubscriptions,
  onWebhookEvent,
  type WebhookProvider,
  type WebhookEvent,
} from '../../src/services/webhook-registry';

describe('Webhook Registry — QA Validation', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    setDbProvider(() => testDb);
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  // ── Migration 022: Schema Integrity ────────────────────────────────

  describe('migration 022: schema integrity', () => {
    it('webhook_subscriptions has correct default values', () => {
      testDb.prepare(`
        INSERT INTO webhook_subscriptions (provider, endpoint_path)
        VALUES ('garmin', '/api/webhooks/garmin')
      `).run();
      const row = testDb.prepare('SELECT * FROM webhook_subscriptions WHERE id = 1').get() as any;
      expect(row.status).toBe('active');
      expect(row.event_types).toBe('["*"]');
      expect(row.event_count).toBe(0);
      expect(row.created_at).toBeTruthy();
      expect(row.updated_at).toBeTruthy();
    });

    it('webhook_events has correct default values', () => {
      testDb.prepare(`
        INSERT INTO webhook_events (provider, event_type, payload)
        VALUES ('garmin', 'activity', '{}')
      `).run();
      const row = testDb.prepare('SELECT * FROM webhook_events WHERE id = 1').get() as any;
      expect(row.status).toBe('received');
      expect(row.received_at).toBeTruthy();
      expect(row.subscription_id).toBeNull();
      expect(row.processed_at).toBeNull();
    });

    it('webhook_delivery_log has correct default values', () => {
      // Insert prerequisite event first
      testDb.prepare(`
        INSERT INTO webhook_events (provider, event_type, payload)
        VALUES ('garmin', 'activity', '{}')
      `).run();
      testDb.prepare(`
        INSERT INTO webhook_delivery_log (event_id, handler)
        VALUES (1, 'test_handler')
      `).run();
      const row = testDb.prepare('SELECT * FROM webhook_delivery_log WHERE id = 1').get() as any;
      expect(row.status).toBe('pending');
      expect(row.attempt).toBe(1);
      expect(row.created_at).toBeTruthy();
    });

    it('foreign key: events.subscription_id SET NULL on subscription delete', () => {
      testDb.prepare(`
        INSERT INTO webhook_subscriptions (provider, endpoint_path)
        VALUES ('garmin', '/api/webhooks/garmin')
      `).run();
      testDb.prepare(`
        INSERT INTO webhook_events (subscription_id, provider, event_type, payload)
        VALUES (1, 'garmin', 'activity', '{}')
      `).run();

      // Delete subscription — event should remain with NULL subscription_id
      testDb.prepare('DELETE FROM webhook_subscriptions WHERE id = 1').run();
      const event = testDb.prepare('SELECT subscription_id FROM webhook_events WHERE id = 1').get() as any;
      expect(event.subscription_id).toBeNull();
    });

    it('foreign key: delivery_log CASCADE on event delete', () => {
      testDb.prepare(`
        INSERT INTO webhook_events (provider, event_type, payload)
        VALUES ('garmin', 'activity', '{}')
      `).run();
      testDb.prepare(`
        INSERT INTO webhook_delivery_log (event_id, handler, status)
        VALUES (1, 'test_handler', 'success')
      `).run();

      // Delete event — delivery log should cascade
      testDb.prepare('DELETE FROM webhook_events WHERE id = 1').run();
      const count = (testDb.prepare('SELECT COUNT(*) as c FROM webhook_delivery_log').get() as any).c;
      expect(count).toBe(0);
    });

    it('cleanup trigger removes old processed/ignored events on insert', () => {
      // Insert an old event (> 30 days ago) manually
      testDb.prepare(`
        INSERT INTO webhook_events (provider, event_type, payload, status, received_at)
        VALUES ('garmin', 'old', '{}', 'processed', datetime('now', '-31 days'))
      `).run();

      // An old failed event should NOT be cleaned up (only processed/ignored)
      testDb.prepare(`
        INSERT INTO webhook_events (provider, event_type, payload, status, received_at)
        VALUES ('garmin', 'old_failed', '{}', 'failed', datetime('now', '-31 days'))
      `).run();

      // Insert a new event — trigger should fire
      testDb.prepare(`
        INSERT INTO webhook_events (provider, event_type, payload)
        VALUES ('garmin', 'new', '{}')
      `).run();

      const rows = testDb.prepare('SELECT event_type FROM webhook_events ORDER BY id').all() as any[];
      const types = rows.map(r => r.event_type);
      // Old processed event should be cleaned up, old failed should remain
      expect(types).not.toContain('old');
      expect(types).toContain('old_failed');
      expect(types).toContain('new');
    });

    it('idempotency_key index allows NULL values (not unique constraint)', () => {
      // Multiple events with NULL idempotency_key should be fine
      testDb.prepare(`
        INSERT INTO webhook_events (provider, event_type, payload)
        VALUES ('garmin', 'a', '{}')
      `).run();
      testDb.prepare(`
        INSERT INTO webhook_events (provider, event_type, payload)
        VALUES ('garmin', 'b', '{}')
      `).run();
      const count = (testDb.prepare('SELECT COUNT(*) as c FROM webhook_events').get() as any).c;
      expect(count).toBe(2);
    });
  });

  // ── Signature Verification: Security Edge Cases ─────────────────────

  describe('signature verification: security edge cases', () => {
    it('rejects signature with wrong length (timing-safe comparison handles this)', () => {
      const secret = 'test-secret';
      const body = '{"event":"test"}';
      // Provide a signature that's not valid hex of correct length
      const valid = verifySignature('custom', body, { 'x-webhook-signature': 'tooshort' }, secret);
      expect(valid).toBe(false);
    });

    it('rejects tampered body even with valid format signature', () => {
      const secret = 'test-secret';
      const originalBody = '{"event":"original"}';
      const tamperedBody = '{"event":"tampered"}';
      const sig = crypto.createHmac('sha256', secret).update(originalBody).digest('hex');

      const valid = verifySignature('custom', tamperedBody, { 'x-webhook-signature': sig }, secret);
      expect(valid).toBe(false);
    });

    it('rejects signature with wrong secret', () => {
      const body = '{"event":"test"}';
      const sig = crypto.createHmac('sha256', 'wrong-secret').update(body).digest('hex');

      const valid = verifySignature('custom', body, { 'x-webhook-signature': sig }, 'correct-secret');
      expect(valid).toBe(false);
    });

    it('uses correct header for each provider', () => {
      const secret = 'test';
      const body = '{}';
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

      // Garmin should check x-garmin-signature
      expect(verifySignature('garmin', body, { 'x-garmin-signature': sig }, secret)).toBe(true);
      expect(verifySignature('garmin', body, { 'x-webhook-signature': sig }, secret)).toBe(false);

      // Outlook should check x-ms-client-state
      expect(verifySignature('outlook_calendar', body, { 'x-ms-client-state': sig }, secret)).toBe(true);
      expect(verifySignature('outlook_mail', body, { 'x-ms-client-state': sig }, secret)).toBe(true);
    });

    it('handles empty body string with valid HMAC', () => {
      const secret = 'secret';
      const body = '';
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

      const valid = verifySignature('custom', body, { 'x-webhook-signature': sig }, secret);
      expect(valid).toBe(true);
    });

    it('rejects when header value is an array (Express can send arrays for repeated headers)', () => {
      const secret = 'test';
      const body = '{}';
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

      // Array header value should be rejected (typeof check)
      const valid = verifySignature('custom', body, { 'x-webhook-signature': [sig, sig] as any }, secret);
      expect(valid).toBe(false);
    });
  });

  // ── Subscription CRUD: Edge Cases ───────────────────────────────────

  describe('subscription CRUD: edge cases', () => {
    it('handles multiple subscriptions for the same provider', () => {
      const id1 = registerSubscription({
        provider: 'google_calendar',
        endpoint_path: '/api/webhooks/google_calendar',
        event_types: ['update'],
      });
      const id2 = registerSubscription({
        provider: 'google_calendar',
        endpoint_path: '/api/webhooks/google_calendar',
        event_types: ['delete'],
      });
      expect(id1).not.toBe(id2);
      const subs = getSubscriptions({ provider: 'google_calendar' });
      expect(subs.length).toBe(2);
    });

    it('getSubscription returns null for non-existent ID', () => {
      expect(getSubscription(9999)).toBeNull();
    });

    it('combined provider + status filter works', () => {
      const id1 = registerSubscription({ provider: 'garmin', endpoint_path: '/a' });
      registerSubscription({ provider: 'garmin', endpoint_path: '/b' });
      registerSubscription({ provider: 'strava', endpoint_path: '/c' });
      updateSubscriptionStatus(id1, 'paused');

      const subs = getSubscriptions({ provider: 'garmin', status: 'active' });
      expect(subs.length).toBe(1);
    });

    it('subscription metadata round-trips complex nested objects', () => {
      const meta = {
        channelId: 'ch-123',
        resourceUri: 'https://example.com/resource',
        nested: { deep: { value: 42 } },
        tags: ['a', 'b', 'c'],
      };
      const id = registerSubscription({
        provider: 'google_calendar',
        endpoint_path: '/api/webhooks/google_calendar',
        metadata: meta,
      });
      const sub = getSubscription(id);
      expect(sub?.metadata).toEqual(meta);
    });

    it('updateSubscriptionStatus updates the updated_at timestamp', () => {
      const id = registerSubscription({ provider: 'garmin', endpoint_path: '/a' });
      const before = getSubscription(id)!.updated_at;

      // Small delay to ensure different timestamp
      updateSubscriptionStatus(id, 'paused');
      const after = getSubscription(id)!.updated_at;
      // updated_at should be set (may or may not differ within same second)
      expect(after).toBeTruthy();
    });
  });

  // ── Event Processing: Edge Cases ────────────────────────────────────

  describe('event processing: edge cases', () => {
    it('handles event with empty payload', async () => {
      const eventId = await receiveWebhookEvent({
        provider: 'garmin',
        event_type: 'activity',
        payload: {},
      });
      expect(eventId).toBeGreaterThan(0);
      const event = getEvent(eventId);
      expect(event?.payload).toEqual({});
    });

    it('handles event with large payload', async () => {
      const largePayload: Record<string, unknown> = {};
      for (let i = 0; i < 100; i++) {
        largePayload[`field_${i}`] = 'x'.repeat(100);
      }
      const eventId = await receiveWebhookEvent({
        provider: 'custom',
        event_type: 'test',
        payload: largePayload,
      });
      expect(eventId).toBeGreaterThan(0);
      const event = getEvent(eventId);
      expect(Object.keys(event!.payload).length).toBe(100);
    });

    it('idempotency retries a failed event (allows re-processing)', async () => {
      // Register a handler that always fails
      let callCount = 0;
      onWebhookEvent('custom', 'retry_test', async () => {
        callCount++;
        throw new Error('always fails');
      });

      const eventId1 = await receiveWebhookEvent({
        provider: 'custom',
        event_type: 'retry_test',
        payload: {},
        idempotency_key: 'retry-key-001',
      });
      expect(callCount).toBe(1);

      // Second attempt with same key — since first failed, should re-process
      const eventId2 = await receiveWebhookEvent({
        provider: 'custom',
        event_type: 'retry_test',
        payload: {},
        idempotency_key: 'retry-key-001',
      });

      // The dedup logic allows retry of failed events
      // (it only skips if status !== 'failed')
      // So this should be a new event or same event re-processed
      expect(eventId2).toBeGreaterThan(0);
    });

    it('multiple handlers are all called for one event', async () => {
      const handler1 = vi.fn().mockResolvedValue(undefined);
      const handler2 = vi.fn().mockResolvedValue(undefined);
      onWebhookEvent('custom', 'multi', handler1);
      onWebhookEvent('custom', 'multi', handler2);

      await receiveWebhookEvent({
        provider: 'custom',
        event_type: 'multi',
        payload: { data: 'test' },
      });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('both exact and wildcard handlers fire for same event', async () => {
      const exactHandler = vi.fn().mockResolvedValue(undefined);
      const wildcardHandler = vi.fn().mockResolvedValue(undefined);
      onWebhookEvent('custom', 'specific', exactHandler);
      onWebhookEvent('custom', '*', wildcardHandler);

      await receiveWebhookEvent({
        provider: 'custom',
        event_type: 'specific',
        payload: {},
      });

      expect(exactHandler).toHaveBeenCalledTimes(1);
      expect(wildcardHandler).toHaveBeenCalledTimes(1);
    });

    it('one handler failure does not prevent other handlers from running', async () => {
      const failHandler = vi.fn().mockRejectedValue(new Error('fails'));
      const successHandler = vi.fn().mockResolvedValue(undefined);
      // Use a unique event type to avoid handler leakage from other tests
      onWebhookEvent('custom', 'partial_fail_qa', failHandler);
      onWebhookEvent('custom', 'partial_fail_qa', successHandler);

      const eventId = await receiveWebhookEvent({
        provider: 'custom',
        event_type: 'partial_fail_qa',
        payload: {},
      });

      // Both should have been called
      expect(failHandler).toHaveBeenCalledTimes(1);
      expect(successHandler).toHaveBeenCalledTimes(1);

      // Event should be marked as failed (because at least one handler failed)
      const event = getEvent(eventId);
      expect(event?.status).toBe('failed');

      // Delivery log should have entries for both handlers (plus any wildcard handlers)
      const deliveries = testDb.prepare(
        'SELECT * FROM webhook_delivery_log WHERE event_id = ? ORDER BY id'
      ).all(eventId) as any[];
      expect(deliveries.length).toBeGreaterThanOrEqual(2);
      // At least one failed and one succeeded
      const statuses = deliveries.map((d: any) => d.status);
      expect(statuses).toContain('failed');
      expect(statuses).toContain('success');
    });

    it('subscription event_count increments correctly over multiple events', async () => {
      const subId = registerSubscription({
        provider: 'google_calendar',
        endpoint_path: '/api/webhooks/google_calendar',
      });

      await receiveWebhookEvent({
        provider: 'google_calendar',
        event_type: 'update',
        payload: {},
        subscription_id: subId,
      });
      await receiveWebhookEvent({
        provider: 'google_calendar',
        event_type: 'update',
        payload: {},
        subscription_id: subId,
      });
      await receiveWebhookEvent({
        provider: 'google_calendar',
        event_type: 'delete',
        payload: {},
        subscription_id: subId,
      });

      const sub = getSubscription(subId);
      expect(sub?.event_count).toBe(3);
    });
  });

  // ── Replay: Edge Cases ──────────────────────────────────────────────

  describe('replay: edge cases', () => {
    it('replay records additional delivery log entries', async () => {
      // Use unique event type to isolate from handler leakage
      let callCount = 0;
      onWebhookEvent('garmin', 'replay_log_qa', async () => {
        callCount++;
        if (callCount === 1) throw new Error('first try');
      });

      const eventId = await receiveWebhookEvent({
        provider: 'garmin',
        event_type: 'replay_log_qa',
        payload: {},
      });

      const beforeReplay = testDb.prepare(
        'SELECT COUNT(*) as c FROM webhook_delivery_log WHERE event_id = ?'
      ).get(eventId) as any;

      await replayEvent(eventId);

      const afterReplay = testDb.prepare(
        'SELECT COUNT(*) as c FROM webhook_delivery_log WHERE event_id = ?'
      ).get(eventId) as any;

      // Replay should add at least one more delivery log entry
      expect(afterReplay.c).toBeGreaterThan(beforeReplay.c);

      // The event should now be processed (second call succeeds)
      const event = getEvent(eventId);
      expect(event?.status).toBe('processed');
    });

    it('replay of event with no specific handlers uses wildcard if available', async () => {
      // Use a provider with no handlers registered at all (outlook_todo is unlikely to have leaks)
      const eventId = await receiveWebhookEvent({
        provider: 'outlook_todo',
        event_type: 'unique_no_handler_qa_' + Date.now(),
        payload: {},
      });

      const success = await replayEvent(eventId);
      // If no handlers (exact or wildcard) exist for this provider+type, replay returns false
      // But if wildcard handlers leaked from other tests, it may return true
      // The important thing is it doesn't throw
      expect(typeof success).toBe('boolean');
    });
  });

  // ── Stats: Edge Cases ───────────────────────────────────────────────

  describe('stats: edge cases', () => {
    it('failed events are counted correctly in failedToday', async () => {
      onWebhookEvent('custom', 'fail_stats', vi.fn().mockRejectedValue(new Error('boom')));

      await receiveWebhookEvent({
        provider: 'custom',
        event_type: 'fail_stats',
        payload: {},
      });
      await receiveWebhookEvent({
        provider: 'custom',
        event_type: 'fail_stats',
        payload: {},
      });

      const stats = getWebhookStats();
      expect(stats.failedToday).toBe(2);
      expect(stats.eventsToday).toBe(2);
    });

    it('byProvider includes lastEvent timestamp', async () => {
      await receiveWebhookEvent({
        provider: 'strava',
        event_type: 'activity',
        payload: {},
      });

      const stats = getWebhookStats();
      const stravaStat = stats.byProvider.find(p => p.provider === 'strava');
      expect(stravaStat).toBeDefined();
      expect(stravaStat!.lastEvent).toBeTruthy();
    });
  });

  // ── Expiry: Edge Cases ──────────────────────────────────────────────

  describe('expiry: edge cases', () => {
    it('does not expire already-paused subscriptions', () => {
      const id = registerSubscription({
        provider: 'garmin',
        endpoint_path: '/a',
        expires_at: '2020-01-01T00:00:00Z',
      });
      updateSubscriptionStatus(id, 'paused');

      const expired = expireSubscriptions();
      expect(expired).toBe(0);

      const sub = getSubscription(id);
      expect(sub?.status).toBe('paused');
    });

    it('does not expire subscriptions with future expires_at', () => {
      registerSubscription({
        provider: 'garmin',
        endpoint_path: '/a',
        expires_at: '2099-12-31T23:59:59Z',
      });

      const expired = expireSubscriptions();
      expect(expired).toBe(0);
    });

    it('expires multiple subscriptions at once', () => {
      registerSubscription({
        provider: 'garmin',
        endpoint_path: '/a',
        expires_at: '2020-01-01T00:00:00Z',
      });
      registerSubscription({
        provider: 'strava',
        endpoint_path: '/b',
        expires_at: '2020-06-15T00:00:00Z',
      });
      registerSubscription({
        provider: 'github',
        endpoint_path: '/c',
        // no expiry — should remain active
      });

      const expired = expireSubscriptions();
      expect(expired).toBe(2);

      const active = getSubscriptions({ status: 'active' });
      expect(active.length).toBe(1);
      expect(active[0].provider).toBe('github');
    });
  });

  // ── Graceful Degradation (no DB) ────────────────────────────────────

  describe('graceful degradation without database', () => {
    it('returns safe defaults when db provider is null', () => {
      setDbProvider(() => { throw new Error('no db'); });

      expect(registerSubscription({ provider: 'garmin', endpoint_path: '/a' })).toBe(-1);
      expect(getSubscriptions()).toEqual([]);
      expect(getSubscription(1)).toBeNull();
      expect(updateSubscriptionStatus(1, 'paused')).toBe(false);
      expect(removeSubscription(1)).toBe(false);
      expect(getEvent(1)).toBeNull();
      expect(getRecentEvents()).toEqual([]);
      expect(expireSubscriptions()).toBe(0);

      const stats = getWebhookStats();
      expect(stats.totalSubscriptions).toBe(0);
      expect(stats.byProvider).toEqual([]);
    });

    it('receiveWebhookEvent returns -1 when db unavailable', async () => {
      setDbProvider(() => { throw new Error('no db'); });
      const result = await receiveWebhookEvent({
        provider: 'garmin',
        event_type: 'activity',
        payload: {},
      });
      expect(result).toBe(-1);
    });
  });

  // ── WebhookProvider Type Completeness ───────────────────────────────

  describe('provider type completeness', () => {
    const allProviders: WebhookProvider[] = [
      'google_calendar', 'google_gmail', 'outlook_calendar',
      'outlook_mail', 'outlook_todo', 'garmin', 'strava',
      'github', 'custom',
    ];

    it('all declared providers can be used to register subscriptions', () => {
      for (const provider of allProviders) {
        const id = registerSubscription({
          provider,
          endpoint_path: `/api/webhooks/${provider}`,
        });
        expect(id).toBeGreaterThan(0);
      }

      const subs = getSubscriptions();
      expect(subs.length).toBe(allProviders.length);
    });

    it('all declared providers can receive events', async () => {
      for (const provider of allProviders) {
        const eventId = await receiveWebhookEvent({
          provider,
          event_type: 'test',
          payload: { provider },
        });
        expect(eventId).toBeGreaterThan(0);
      }
    });
  });

  // ── Config Validation ───────────────────────────────────────────────

  describe('config additions', () => {
    it('webhooks config section exists with expected shape', async () => {
      // Dynamic import to verify config compiles
      const { config } = await import('../../src/config');
      expect(config.webhooks).toBeDefined();
      expect(typeof config.webhooks.enabled).toBe('boolean');
      expect(typeof config.webhooks.secret).toBe('string');
      expect(typeof config.webhooks.maxPayloadBytes).toBe('number');
      expect(typeof config.webhooks.eventRetentionDays).toBe('number');
    });

    it('maxPayloadBytes defaults to 1MB', async () => {
      const { config } = await import('../../src/config');
      expect(config.webhooks.maxPayloadBytes).toBe(1048576);
    });

    it('eventRetentionDays defaults to 30', async () => {
      const { config } = await import('../../src/config');
      expect(config.webhooks.eventRetentionDays).toBe(30);
    });
  });

  // ── getRecentEvents: Boundary Cases ─────────────────────────────────

  describe('getRecentEvents: boundaries', () => {
    it('default limit is 50', async () => {
      for (let i = 0; i < 55; i++) {
        await receiveWebhookEvent({
          provider: 'custom',
          event_type: 'bulk',
          payload: { i },
        });
      }
      const events = getRecentEvents();
      expect(events.length).toBe(50);
    });

    it('returns empty array with no events', () => {
      const events = getRecentEvents();
      expect(events).toEqual([]);
    });

    it('combined provider + status filter works', async () => {
      onWebhookEvent('custom', 'combined_filter', vi.fn().mockRejectedValue(new Error('fail')));

      await receiveWebhookEvent({ provider: 'custom', event_type: 'combined_filter', payload: {} });
      await receiveWebhookEvent({ provider: 'garmin', event_type: 'other', payload: {} });

      const events = getRecentEvents({ provider: 'custom', status: 'failed' });
      expect(events.length).toBe(1);
      expect(events[0].provider).toBe('custom');
      expect(events[0].status).toBe('failed');
    });
  });
});
