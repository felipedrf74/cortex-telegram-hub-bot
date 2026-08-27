/**
 * Webhook Registry Tests
 *
 * Tests subscription CRUD, HMAC signature verification, event logging,
 * idempotency/dedup, handler dispatch, delivery tracking, replay,
 * stats queries, and subscription expiry.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import crypto from 'crypto';

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
  registerSubscription as registerOwnedSubscription,
  getSubscriptions,
  getSubscription,
  updateSubscriptionStatus,
  removeSubscription,
  verifySignature,
  receiveWebhookEvent as receiveOwnedWebhookEvent,
  getRecentEvents,
  getEvent,
  replayEvent,
  getWebhookStats,
  expireSubscriptions,
  onWebhookEvent,
  decryptWebhookJsonForOwner,
  type WebhookProvider,
  type WebhookEvent,
} from '../../src/services/webhook-registry';
import { pushEvent } from '../../src/portal/telemetry';

const TEST_WEBHOOK_USER_ID = 42;
const TEST_WEBHOOK_ENCRYPTION_KEY = 'webhook-registry-test-key-at-least-32-bytes';
const originalWebhookEncryptionKey = process.env.OAUTH_ENCRYPTION_KEY;
const originalFinanceEncryptionKey = process.env.FINANCE_ENCRYPTION_KEY;
const originalWebhookEncryptionWritesFlag = process.env.WEBHOOK_OWNER_ENCRYPTION_WRITES_ENABLED;
let subscriptionSequence = 0;

type RegisterSubscriptionInput = Omit<Parameters<typeof registerOwnedSubscription>[0], 'user_id'> & {
  user_id?: number;
};
type ReceiveWebhookEventInput = Omit<Parameters<typeof receiveOwnedWebhookEvent>[0], 'user_id'> & {
  user_id?: number;
};

function registerSubscription(params: RegisterSubscriptionInput): number {
  subscriptionSequence += 1;
  const nativeExternalIdentity = params.provider === 'google_calendar'
    || params.provider === 'outlook_calendar'
    || params.provider === 'outlook_mail'
    || params.provider === 'outlook_todo';
  return registerOwnedSubscription({
    user_id: TEST_WEBHOOK_USER_ID,
    ...params,
    secret: params.secret ?? `test-secret-${subscriptionSequence}`,
    external_id: params.external_id
      ?? (nativeExternalIdentity ? `test-external-${subscriptionSequence}` : undefined),
  });
}

function receiveWebhookEvent(params: ReceiveWebhookEventInput): Promise<number> {
  return receiveOwnedWebhookEvent({ user_id: TEST_WEBHOOK_USER_ID, ...params });
}

describe('Webhook Registry', () => {
  beforeAll(() => {
    process.env.OAUTH_ENCRYPTION_KEY = TEST_WEBHOOK_ENCRYPTION_KEY;
    testDb = createMigratedTestDatabase();
  });

  beforeEach(() => {
    process.env.OAUTH_ENCRYPTION_KEY = TEST_WEBHOOK_ENCRYPTION_KEY;
    delete process.env.FINANCE_ENCRYPTION_KEY;
    delete process.env.WEBHOOK_OWNER_ENCRYPTION_WRITES_ENABLED;
    subscriptionSequence = 0;
    testDb.exec('SAVEPOINT webhook_test_case');
    setDbProvider(() => testDb);
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.exec('ROLLBACK TO webhook_test_case');
    testDb.exec('RELEASE webhook_test_case');
    process.env.OAUTH_ENCRYPTION_KEY = TEST_WEBHOOK_ENCRYPTION_KEY;
    delete process.env.FINANCE_ENCRYPTION_KEY;
  });

  afterAll(() => {
    testDb.close();
    if (originalWebhookEncryptionKey === undefined) delete process.env.OAUTH_ENCRYPTION_KEY;
    else process.env.OAUTH_ENCRYPTION_KEY = originalWebhookEncryptionKey;
    if (originalFinanceEncryptionKey === undefined) delete process.env.FINANCE_ENCRYPTION_KEY;
    else process.env.FINANCE_ENCRYPTION_KEY = originalFinanceEncryptionKey;
    if (originalWebhookEncryptionWritesFlag === undefined) {
      delete process.env.WEBHOOK_OWNER_ENCRYPTION_WRITES_ENABLED;
    } else {
      process.env.WEBHOOK_OWNER_ENCRYPTION_WRITES_ENABLED = originalWebhookEncryptionWritesFlag;
    }
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
      expect(names).toContain('idx_webhook_subscriptions_owner_provider_status_v2');
      expect(names).toContain('idx_webhook_events_owner_subscription_idemp_lookup_v2');
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

    it('rejects malformed event-type allowlists at the registry boundary', () => {
      for (const eventTypes of [[], ['update', 'update'], ['*', 'update'], [' update']]) {
        expect(registerOwnedSubscription({
          user_id: TEST_WEBHOOK_USER_ID,
          provider: 'github',
          endpoint_path: '/api/webhooks/github',
          secret: `event-type-secret-${JSON.stringify(eventTypes)}`,
          event_types: eventTypes,
        })).toBe(-1);
      }
    });

    it('encrypts metadata at rest and returns it only through owner-bound decryption', () => {
      process.env.WEBHOOK_OWNER_ENCRYPTION_WRITES_ENABLED = 'true';
      const metadata = {
        calendarId: 'primary',
        resourceId: 'abc123',
        nested: { deep: { value: 42 } },
        tags: ['a', 'b', 'c'],
      };
      const id = registerSubscription({
        provider: 'google_calendar',
        endpoint_path: '/api/webhooks/google_calendar',
        metadata,
      });
      const row = testDb.prepare('SELECT metadata FROM webhook_subscriptions WHERE id = ?').get(id) as any;
      expect(row.metadata).toMatch(/^nexus-webhook-json-v1:/);
      expect(row.metadata).not.toContain('primary');
      expect(getSubscription(id)?.metadata).toEqual(metadata);
    });

    it('encrypts the signing secret while returning it to the internal verifier', () => {
      process.env.WEBHOOK_OWNER_ENCRYPTION_WRITES_ENABLED = 'true';
      const id = registerSubscription({
        provider: 'github',
        endpoint_path: '/api/webhooks/github',
        secret: 'my-secret-key',
        external_id: 'hook_12345',
      });
      const raw = testDb.prepare('SELECT secret FROM webhook_subscriptions WHERE id = ?').get(id) as any;
      expect(raw.secret).toMatch(/^nexus-webhook-json-v1:/);
      expect(raw.secret).not.toContain('my-secret-key');
      const sub = getSubscription(id);
      expect(sub?.secret).toBe('my-secret-key');
      expect(sub?.external_id).toBe('hook_12345');
    });

    it('keeps Release A writes plaintext by default for predecessor rollback compatibility', () => {
      const id = registerSubscription({
        provider: 'github',
        endpoint_path: '/api/webhooks/github',
        secret: 'release-a-secret',
        metadata: { phase: 'A' },
      });
      const row = testDb.prepare(
        'SELECT secret, metadata FROM webhook_subscriptions WHERE id = ?',
      ).get(id) as { secret: string; metadata: string };

      expect(row.secret).toBe('release-a-secret');
      expect(JSON.parse(row.metadata)).toEqual({ phase: 'A' });
    });

    it('never falls back to the Finance key for webhook envelope writes', () => {
      process.env.WEBHOOK_OWNER_ENCRYPTION_WRITES_ENABLED = 'true';
      delete process.env.OAUTH_ENCRYPTION_KEY;
      process.env.FINANCE_ENCRYPTION_KEY = 'finance-key-must-not-encrypt-webhooks';

      expect(registerOwnedSubscription({
        user_id: TEST_WEBHOOK_USER_ID,
        provider: 'github',
        endpoint_path: '/api/webhooks/github',
        secret: 'oauth-domain-key-required',
      })).toBe(-1);
    });

    it('rejects missing verifier material and providers without native verifiers', () => {
      expect(registerOwnedSubscription({
        user_id: TEST_WEBHOOK_USER_ID,
        provider: 'github',
        endpoint_path: '/api/webhooks/github',
      })).toBe(-1);
      expect(registerOwnedSubscription({
        user_id: TEST_WEBHOOK_USER_ID,
        provider: 'google_calendar',
        endpoint_path: '/api/webhooks/google_calendar',
        secret: 'calendar-secret',
      })).toBe(-1);
      expect(registerOwnedSubscription({
        user_id: TEST_WEBHOOK_USER_ID,
        provider: 'google_gmail',
        endpoint_path: '/api/webhooks/google_gmail',
        secret: 'not-an-oidc-verifier',
      })).toBe(-1);
      expect(registerOwnedSubscription({
        user_id: TEST_WEBHOOK_USER_ID,
        provider: 'strava',
        endpoint_path: '/api/webhooks/strava',
        secret: 'not-a-native-strava-verifier',
      })).toBe(-1);
    });

    it('serializes provider secret uniqueness with subscription insertion', () => {
      expect(registerSubscription({
        provider: 'github', endpoint_path: '/first', secret: 'same-secret',
      })).toBeGreaterThan(0);
      expect(registerOwnedSubscription({
        user_id: 77,
        provider: 'github',
        endpoint_path: '/second',
        secret: 'same-secret',
      })).toBe(-1);
    });

    it('pushes telemetry event', () => {
      registerSubscription({
        provider: 'custom',
        endpoint_path: '/api/webhooks/custom',
      });
      expect(pushEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'auth',
        summary: expect.stringContaining('custom'),
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

    it('filters subscriptions by exact owner', () => {
      registerSubscription({ provider: 'garmin', endpoint_path: '/owner-42' });
      registerOwnedSubscription({
        user_id: 77,
        provider: 'github',
        endpoint_path: '/owner-77',
        secret: 'owner-77-secret',
      });

      expect(getSubscriptions({ user_id: TEST_WEBHOOK_USER_ID }).map(sub => sub.user_id)).toEqual([42]);
      expect(getSubscriptions({ user_id: 77 }).map(sub => sub.user_id)).toEqual([77]);
    });

    it('filters by status', () => {
      const id1 = registerSubscription({ provider: 'garmin', endpoint_path: '/a' });
      registerSubscription({ provider: 'github', endpoint_path: '/b' });
      updateSubscriptionStatus(id1, 'paused');

      const active = getSubscriptions({ status: 'active' });
      expect(active.length).toBe(1);
      expect(active[0].provider).toBe('github');
      expect(getSubscriptions({ provider: 'github', status: 'active' })).toHaveLength(1);
      expect(getSubscriptions({ provider: 'garmin', status: 'active' })).toEqual([]);
    });

    it('does not advertise an active-status subscription after its exact expiry instant', () => {
      registerSubscription({
        provider: 'garmin',
        endpoint_path: '/expired-this-minute',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });

      expect(getSubscriptions()).toHaveLength(1);
      expect(getSubscriptions({ status: 'active' })).toEqual([]);
    });
  });

  describe('updateSubscriptionStatus()', () => {
    it('changes subscription status', () => {
      const id = registerSubscription({ provider: 'garmin', endpoint_path: '/a' });
      const ok = updateSubscriptionStatus(id, 'paused');
      expect(ok).toBe(true);

      const sub = getSubscription(id);
      expect(sub?.status).toBe('paused');
      expect(sub?.updated_at).toBeTruthy();
    });

    it('returns false for non-existent subscription', () => {
      const ok = updateSubscriptionStatus(9999, 'paused');
      expect(ok).toBe(false);
      expect(getSubscription(9999)).toBeNull();
    });
  });

  describe('removeSubscription()', () => {
    it('deletes subscription', () => {
      const id = registerSubscription({ provider: 'garmin', endpoint_path: '/a' });
      expect(removeSubscription(id, 77)).toBe(false);
      expect(getSubscription(id)).not.toBeNull();
      const ok = removeSubscription(id, TEST_WEBHOOK_USER_ID);
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

      const emptySig = crypto.createHmac('sha256', secret).update('').digest('hex');
      expect(verifySignature('custom', '', { 'x-webhook-signature': emptySig }, secret)).toBe(true);
    });

    it('rejects invalid signature', () => {
      const secret = 'test-webhook-secret';
      const body = '{"event":"test"}';

      expect(verifySignature('custom', body, { 'x-webhook-signature': 'deadbeef' }, secret)).toBe(false);
      expect(verifySignature('custom', body, { 'x-webhook-signature': 'tooshort' }, secret)).toBe(false);
      const originalSig = crypto.createHmac('sha256', secret).update('{"event":"original"}').digest('hex');
      expect(verifySignature('custom', body, { 'x-webhook-signature': originalSig }, secret)).toBe(false);
      const wrongSecretSig = crypto.createHmac('sha256', 'wrong-secret').update(body).digest('hex');
      expect(verifySignature('custom', body, { 'x-webhook-signature': wrongSecretSig }, secret)).toBe(false);
      const validSig = crypto.createHmac('sha256', secret).update(body).digest('hex');
      expect(verifySignature('custom', body, { 'x-webhook-signature': [validSig, validSig] as any }, secret)).toBe(false);
    });

    it('handles GitHub sha256= prefix', () => {
      const secret = 'github-secret';
      const body = '{"action":"push"}';
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

      const valid = verifySignature('github', body, { 'x-hub-signature-256': `sha256=${sig}` }, secret);
      expect(valid).toBe(true);
    });

    it('uses provider-native verifier material and fails Gmail closed', () => {
      const secret = 'google-secret';
      const body = '{"resourceId":"abc"}';
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

      expect(verifySignature(
        'google_calendar', body, { 'x-goog-channel-token': secret }, secret,
      )).toBe(true);
      expect(verifySignature(
        'google_calendar', body, { 'x-goog-channel-token': sig }, secret,
      )).toBe(false);
      expect(verifySignature(
        'google_gmail', body, { 'x-goog-channel-token': secret }, secret,
      )).toBe(false);
      expect(verifySignature(
        'strava', body, { 'x-strava-signature': sig }, secret,
      )).toBe(false);
      expect(verifySignature('garmin', body, { 'x-garmin-signature': sig }, secret)).toBe(true);
      expect(verifySignature('garmin', body, { 'x-webhook-signature': sig }, secret)).toBe(false);
      const outlookBody = JSON.stringify({ subscriptionId: 'sub-1', clientState: secret });
      expect(verifySignature('outlook_calendar', outlookBody, {}, secret)).toBe(true);
      expect(verifySignature('outlook_mail', outlookBody, {}, secret)).toBe(true);
      expect(verifySignature(
        'outlook_mail', JSON.stringify({ subscriptionId: 'sub-1' }), {}, secret,
      )).toBe(false);
    });

    it('fails closed when no secret is configured', () => {
      const valid = verifySignature('custom', 'body', {}, '');
      expect(valid).toBe(false);
    });

    it('returns false when signature header is missing', () => {
      const valid = verifySignature('custom', 'body', {}, 'secret');
      expect(valid).toBe(false);
    });

    it('handles Buffer body', () => {
      const secret = 'buffer-test';
      const body = Buffer.from([0xff, 0x00, 0x80, 0x7b, 0x7d]);
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

      const valid = verifySignature('custom', body, { 'x-webhook-signature': sig }, secret);
      expect(valid).toBe(true);
    });
  });

  // ── Event Logging & Dispatch ─────────────────────────────────────

  describe('receiveWebhookEvent()', () => {
    it('refuses missing ownership and cross-owner subscription reuse', async () => {
      expect(registerOwnedSubscription({
        user_id: 0,
        provider: 'custom',
        endpoint_path: '/api/webhooks/custom',
      })).toBe(-1);
      expect(await receiveOwnedWebhookEvent({
        user_id: 0,
        provider: 'custom',
        event_type: 'update',
        payload: {},
      })).toBe(-1);

      const subscriptionId = registerSubscription({
        provider: 'custom',
        endpoint_path: '/api/webhooks/custom',
      });
      expect(await receiveWebhookEvent({
        user_id: 77,
        subscription_id: subscriptionId,
        provider: 'custom',
        event_type: 'update',
        payload: {},
      })).toBe(-1);
    });

    it('enforces the subscription event-type allowlist inside atomic admission', async () => {
      const restrictedSubscription = registerSubscription({
        provider: 'custom',
        endpoint_path: '/api/webhooks/custom',
        event_types: ['update'],
      });
      expect(await receiveWebhookEvent({
        subscription_id: restrictedSubscription,
        provider: 'custom',
        event_type: 'delete',
        payload: {},
      })).toBe(-1);
      expect(await receiveWebhookEvent({
        subscription_id: restrictedSubscription,
        provider: 'custom',
        event_type: 'update',
        payload: {},
      })).toBeGreaterThan(0);

      const wildcardSubscription = registerSubscription({
        provider: 'github',
        endpoint_path: '/api/webhooks/github',
        event_types: ['*'],
      });
      expect(await receiveWebhookEvent({
        subscription_id: wildcardSubscription,
        provider: 'github',
        event_type: 'pull_request',
        payload: {},
      })).toBeGreaterThan(0);
      expect(await receiveWebhookEvent({
        subscription_id: wildcardSubscription,
        provider: 'github',
        event_type: '*',
        payload: {},
      })).toBe(-1);
    });

    it('rejects non-record payloads and headers at the shared registry boundary', async () => {
      expect(await receiveOwnedWebhookEvent({
        user_id: TEST_WEBHOOK_USER_ID,
        provider: 'custom',
        event_type: 'update',
        payload: [] as unknown as Record<string, unknown>,
      })).toBe(-1);
      expect(await receiveOwnedWebhookEvent({
        user_id: TEST_WEBHOOK_USER_ID,
        provider: 'custom',
        event_type: 'update',
        payload: {},
        headers: 'not-a-record' as unknown as Record<string, string>,
      })).toBe(-1);
    });

    it('rejects delivery after the bound subscription expiry instant even before reconciliation', async () => {
      const subscriptionId = registerSubscription({
        provider: 'garmin',
        endpoint_path: '/expired-this-minute',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });

      expect(await receiveWebhookEvent({
        subscription_id: subscriptionId,
        provider: 'garmin',
        event_type: 'activity',
        payload: {},
      })).toBe(-1);
      expect(getSubscription(subscriptionId)?.status).toBe('active');
    });

    it('logs event to database', async () => {
      process.env.WEBHOOK_OWNER_ENCRYPTION_WRITES_ENABLED = 'true';
      const eventId = await receiveWebhookEvent({
        provider: 'google_calendar',
        event_type: 'update',
        payload: { calendarId: 'primary', resourceId: 'xyz' },
      });
      expect(eventId).toBeGreaterThan(0);

      const row = testDb.prepare('SELECT * FROM webhook_events WHERE id = ?').get(eventId) as any;
      expect(row.provider).toBe('google_calendar');
      expect(row.event_type).toBe('update');
      expect(row.user_id).toBe(TEST_WEBHOOK_USER_ID);
      expect(row.payload).toMatch(/^nexus-webhook-json-v1:/);
      expect(getEvent(eventId)?.payload).toEqual({ calendarId: 'primary', resourceId: 'xyz' });
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
      expect(delivery.error_message).toBe('Error');

      const event = testDb.prepare('SELECT status, error_message FROM webhook_events WHERE id = ?').get(eventId) as any;
      expect(event.status).toBe('failed');
      expect(event.error_message).toBe('Error');
    });

    it('updates subscription stats on event receipt', async () => {
      const subId = registerSubscription({
        provider: 'google_calendar',
        endpoint_path: '/api/webhooks/google_calendar',
      });

      for (const eventType of ['update', 'update', 'delete']) {
        await receiveWebhookEvent({
          provider: 'google_calendar',
          event_type: eventType,
          payload: { resourceId: 'abc' },
          subscription_id: subId,
        });
      }

      const sub = getSubscription(subId);
      expect(sub?.event_count).toBe(3);
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
        summary: 'Webhook received: garmin',
      }));
    });

    it('encrypts persisted headers while returning them only through owner-bound decryption', async () => {
      process.env.WEBHOOK_OWNER_ENCRYPTION_WRITES_ENABLED = 'true';
      const eventId = await receiveWebhookEvent({
        provider: 'github',
        event_type: 'push',
        payload: { ref: 'refs/heads/main' },
        headers: { 'x-github-event': 'push', 'x-github-delivery': 'abc-123' },
      });

      const row = testDb.prepare('SELECT headers FROM webhook_events WHERE id = ?').get(eventId) as any;
      expect(row.headers).toMatch(/^nexus-webhook-json-v1:/);
      expect(getEvent(eventId)?.headers?.['x-github-event']).toBe('push');
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

    it('scopes idempotency keys to their explicit account owner', async () => {
      const first = await receiveWebhookEvent({
        provider: 'custom', event_type: 'update', payload: { owner: 42 }, idempotency_key: 'shared-key',
      });
      const second = await receiveWebhookEvent({
        user_id: 77, provider: 'custom', event_type: 'update', payload: { owner: 77 }, idempotency_key: 'shared-key',
      });

      expect(first).not.toBe(second);
      expect(getEvent(first)?.user_id).toBe(TEST_WEBHOOK_USER_ID);
      expect(getEvent(second)?.user_id).toBe(77);
    });

    it('scopes idempotency keys by provider as well as owner', async () => {
      const first = await receiveWebhookEvent({
        provider: 'google_calendar', event_type: 'update', payload: {}, idempotency_key: 'shared-provider-key',
      });
      const second = await receiveWebhookEvent({
        provider: 'google_gmail', event_type: 'update', payload: {}, idempotency_key: 'shared-provider-key',
      });

      expect(first).not.toBe(second);
    });

    it('scopes a provider retry key to its subscription inside immediate admission', async () => {
      const firstSubscription = registerSubscription({
        provider: 'google_calendar',
        endpoint_path: '/calendar/one',
        secret: 'calendar-one',
        external_id: 'channel-one',
      });
      const secondSubscription = registerSubscription({
        provider: 'google_calendar',
        endpoint_path: '/calendar/two',
        secret: 'calendar-two',
        external_id: 'channel-two',
      });

      const first = await receiveWebhookEvent({
        provider: 'google_calendar',
        event_type: 'update',
        payload: { channel: 'one' },
        subscription_id: firstSubscription,
        idempotency_key: 'message-1',
      });
      const retry = await receiveWebhookEvent({
        provider: 'google_calendar',
        event_type: 'update',
        payload: { channel: 'one-retry' },
        subscription_id: firstSubscription,
        idempotency_key: 'message-1',
      });
      const second = await receiveWebhookEvent({
        provider: 'google_calendar',
        event_type: 'update',
        payload: { channel: 'two' },
        subscription_id: secondSubscription,
        idempotency_key: 'message-1',
      });

      expect(retry).toBe(first);
      expect(second).not.toBe(first);
    });

    it('keeps the phase-A schema compatible with predecessor duplicate writes', () => {
      const subscriptionId = Number(testDb.prepare(`
        INSERT INTO webhook_subscriptions
          (provider, endpoint_path, user_id, secret, external_id)
        VALUES ('custom', '/legacy', ?, 'legacy-secret', 'legacy-external')
      `).run(TEST_WEBHOOK_USER_ID).lastInsertRowid);
      const insert = testDb.prepare(`
        INSERT INTO webhook_events
          (subscription_id, provider, event_type, payload, status, idempotency_key, user_id)
        VALUES (?, 'custom', 'atomic', '{}', ?, 'atomic-key', ?)
      `);
      insert.run(subscriptionId, 'received', TEST_WEBHOOK_USER_ID);
      expect(() => insert.run(subscriptionId, 'processing', TEST_WEBHOOK_USER_ID)).not.toThrow();
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
      const deliveriesBefore = (testDb.prepare(
        'SELECT COUNT(*) as count FROM webhook_delivery_log WHERE event_id = ?',
      ).get(eventId) as { count: number }).count;
      const success = await replayEvent(eventId);
      expect(success).toBe(true);

      event = testDb.prepare('SELECT status FROM webhook_events WHERE id = ?').get(eventId) as any;
      expect(event.status).toBe('processed');
      const deliveriesAfter = (testDb.prepare(
        'SELECT COUNT(*) as count FROM webhook_delivery_log WHERE event_id = ?',
      ).get(eventId) as { count: number }).count;
      expect(deliveriesAfter).toBeGreaterThan(deliveriesBefore);
    });

    it('returns false for non-existent event', async () => {
      const success = await replayEvent(9999);
      expect(success).toBe(false);
    });

    it('refuses replay when the expected management owner does not match', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      onWebhookEvent('custom', 'owner-scoped-replay', handler);
      const failedId = Number(testDb.prepare(`
        INSERT INTO webhook_events
          (provider, event_type, payload, status, user_id)
        VALUES ('custom', 'owner-scoped-replay', '{}', 'failed', ?)
      `).run(TEST_WEBHOOK_USER_ID).lastInsertRowid);

      expect(await replayEvent(failedId, 77)).toBe(false);
      expect(handler).not.toHaveBeenCalled();
      expect(getEvent(failedId)?.status).toBe('failed');
    });

    it('refuses replay when the same scoped retry key already has a non-failed admission', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      onWebhookEvent('custom', 'replay-conflict', handler);
      const failedId = Number(testDb.prepare(`
        INSERT INTO webhook_events
          (provider, event_type, payload, status, idempotency_key, user_id)
        VALUES ('custom', 'replay-conflict', '{}', 'failed', 'same-key', ?)
      `).run(TEST_WEBHOOK_USER_ID).lastInsertRowid);
      testDb.prepare(`
        INSERT INTO webhook_events
          (provider, event_type, payload, status, idempotency_key, user_id)
        VALUES ('custom', 'replay-conflict', '{}', 'received', 'same-key', ?)
      `).run(TEST_WEBHOOK_USER_ID);

      expect(await replayEvent(failedId)).toBe(false);
      expect(handler).not.toHaveBeenCalled();
      expect(getEvent(failedId)?.status).toBe('failed');
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

    it('filters recent events by exact owner', async () => {
      await receiveWebhookEvent({ provider: 'garmin', event_type: 'owner-42', payload: {} });
      await receiveWebhookEvent({ user_id: 77, provider: 'github', event_type: 'owner-77', payload: {} });

      expect(getRecentEvents({ user_id: TEST_WEBHOOK_USER_ID }).map(event => event.user_id)).toEqual([42]);
      expect(getRecentEvents({ user_id: 77 }).map(event => event.user_id)).toEqual([77]);
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

    it('clamps unsafe direct limits to the bounded 1..200 service contract', async () => {
      await receiveWebhookEvent({ provider: 'custom', event_type: 'one', payload: {} });
      await receiveWebhookEvent({ provider: 'custom', event_type: 'two', payload: {} });

      expect(getRecentEvents({ limit: -1 })).toHaveLength(1);
      expect(getRecentEvents({ limit: Number.NaN })).toHaveLength(2);
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
      registerSubscription({ provider: 'custom', endpoint_path: '/c' });
      registerSubscription({
        provider: 'github',
        endpoint_path: '/expired',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });
      updateSubscriptionStatus(id2, 'paused');

      const stats = getWebhookStats();
      expect(stats.totalSubscriptions).toBe(4);
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
      expect(googleStats?.lastEvent).toBeTruthy();
    });

    it('scopes management statistics to one owner', async () => {
      registerSubscription({ provider: 'garmin', endpoint_path: '/owner-42' });
      registerOwnedSubscription({
        user_id: 77,
        provider: 'github',
        endpoint_path: '/owner-77',
        secret: 'owner-77-secret',
      });
      await receiveWebhookEvent({ provider: 'garmin', event_type: 'owner-42', payload: {} });
      await receiveWebhookEvent({ user_id: 77, provider: 'github', event_type: 'owner-77', payload: {} });

      expect(getWebhookStats(TEST_WEBHOOK_USER_ID)).toMatchObject({
        totalSubscriptions: 1,
        eventsToday: 1,
      });
      expect(getWebhookStats(77)).toMatchObject({ totalSubscriptions: 1, eventsToday: 1 });
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

    it('reconciles ISO timestamps that expired earlier on the current UTC day', () => {
      const subscriptionId = registerSubscription({
        provider: 'garmin',
        endpoint_path: '/expired-this-minute',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });

      expect(expireSubscriptions()).toBe(1);
      expect(getSubscription(subscriptionId)?.status).toBe('expired');
    });
  });

  describe('Webhook schema and edge matrices', () => {
    it('refuses to decrypt legacy plaintext under an ownerless identity', () => {
      expect(() => decryptWebhookJsonForOwner('{}', 0)).toThrow(/positive user id/);
    });

    it('keeps subscription, event, and delivery defaults', () => {
      const subscriptionId = Number(testDb.prepare(`
        INSERT INTO webhook_subscriptions (provider, endpoint_path, user_id)
        VALUES ('garmin', '/api/webhooks/garmin', ${TEST_WEBHOOK_USER_ID})
      `).run().lastInsertRowid);
      const subscription = testDb.prepare('SELECT * FROM webhook_subscriptions WHERE id = ?').get(subscriptionId) as any;
      expect(subscription).toMatchObject({ status: 'active', event_types: '["*"]', event_count: 0 });
      expect(subscription.created_at).toBeTruthy();
      expect(subscription.updated_at).toBeTruthy();

      const eventId = Number(testDb.prepare(`
        INSERT INTO webhook_events (provider, event_type, payload, user_id)
        VALUES ('garmin', 'activity', '{}', ${TEST_WEBHOOK_USER_ID})
      `).run().lastInsertRowid);
      const event = testDb.prepare('SELECT * FROM webhook_events WHERE id = ?').get(eventId) as any;
      expect(event).toMatchObject({ status: 'received', subscription_id: null, processed_at: null });
      expect(event.received_at).toBeTruthy();

      const deliveryId = Number(testDb.prepare(`
        INSERT INTO webhook_delivery_log (event_id, handler)
        VALUES (?, 'test_handler')
      `).run(eventId).lastInsertRowid);
      const delivery = testDb.prepare('SELECT * FROM webhook_delivery_log WHERE id = ?').get(deliveryId) as any;
      expect(delivery).toMatchObject({ status: 'pending', attempt: 1 });
      expect(delivery.created_at).toBeTruthy();
    });

    it('enforces SET NULL and CASCADE foreign-key behavior', () => {
      const subscriptionId = Number(testDb.prepare(`
        INSERT INTO webhook_subscriptions (provider, endpoint_path, user_id)
        VALUES ('garmin', '/api/webhooks/garmin', ${TEST_WEBHOOK_USER_ID})
      `).run().lastInsertRowid);
      const eventId = Number(testDb.prepare(`
        INSERT INTO webhook_events (subscription_id, provider, event_type, payload, user_id)
        VALUES (?, 'garmin', 'activity', '{}', ${TEST_WEBHOOK_USER_ID})
      `).run(subscriptionId).lastInsertRowid);
      testDb.prepare(`
        INSERT INTO webhook_delivery_log (event_id, handler, status)
        VALUES (?, 'test_handler', 'success')
      `).run(eventId);

      testDb.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(subscriptionId);
      expect(testDb.prepare('SELECT subscription_id FROM webhook_events WHERE id = ?').get(eventId)).toMatchObject({ subscription_id: null });
      testDb.prepare('DELETE FROM webhook_events WHERE id = ?').run(eventId);
      expect((testDb.prepare('SELECT COUNT(*) as count FROM webhook_delivery_log').get() as { count: number }).count).toBe(0);
    });

    it('leaves predecessor writes schema-compatible while runtime APIs enforce ownership', async () => {
      const subscriptionId = Number(testDb.prepare(`
        INSERT INTO webhook_subscriptions (provider, endpoint_path, user_id)
        VALUES ('custom', '/api/webhooks/custom', 0)
      `).run().lastInsertRowid);
      expect(subscriptionId).toBeGreaterThan(0);
      expect(await receiveOwnedWebhookEvent({
        user_id: 0,
        subscription_id: subscriptionId,
        provider: 'custom',
        event_type: 'update',
        payload: {},
      })).toBe(-1);
    });

    it('cleans only old processed events and accepts multiple null idempotency keys', () => {
      testDb.prepare(`
        INSERT INTO webhook_events (provider, event_type, payload, status, received_at, user_id)
        VALUES ('garmin', 'old', '{}', 'processed', datetime('now', '-31 days'), ${TEST_WEBHOOK_USER_ID})
      `).run();
      testDb.prepare(`
        INSERT INTO webhook_events (provider, event_type, payload, status, received_at, user_id)
        VALUES ('garmin', 'old_failed', '{}', 'failed', datetime('now', '-31 days'), ${TEST_WEBHOOK_USER_ID})
      `).run();
      testDb.prepare(`INSERT INTO webhook_events (provider, event_type, payload, user_id) VALUES ('garmin', 'new-a', '{}', ?)`).run(TEST_WEBHOOK_USER_ID);
      testDb.prepare(`INSERT INTO webhook_events (provider, event_type, payload, user_id) VALUES ('garmin', 'new-b', '{}', ?)`).run(TEST_WEBHOOK_USER_ID);

      const types = (testDb.prepare('SELECT event_type FROM webhook_events').all() as Array<{ event_type: string }>).map(row => row.event_type);
      expect(types).not.toContain('old');
      expect(types).toEqual(expect.arrayContaining(['old_failed', 'new-a', 'new-b']));
    });

    it('round-trips empty and large event payloads', async () => {
      const payloads = [{}, Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field_${i}`, 'x'.repeat(100)]))];
      for (const [index, payload] of payloads.entries()) {
        const eventId = await receiveWebhookEvent({ provider: 'custom', event_type: `payload-${index}`, payload });
        expect(getEvent(eventId)?.payload).toEqual(payload);
      }
    });

    it('retries a failed idempotent event', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('always fails'));
      onWebhookEvent('custom', 'retry-matrix', handler);
      const first = await receiveWebhookEvent({
        provider: 'custom', event_type: 'retry-matrix', payload: {}, idempotency_key: 'retry-key-001',
      });
      const second = await receiveWebhookEvent({
        provider: 'custom', event_type: 'retry-matrix', payload: {}, idempotency_key: 'retry-key-001',
      });
      expect(first).toBeGreaterThan(0);
      expect(second).toBeGreaterThan(0);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('records every handler result when one handler fails', async () => {
      const failed = vi.fn().mockRejectedValue(new Error('fails'));
      const succeeded = vi.fn().mockResolvedValue(undefined);
      onWebhookEvent('custom', 'partial-failure-matrix', failed);
      onWebhookEvent('custom', 'partial-failure-matrix', succeeded);
      const eventId = await receiveWebhookEvent({
        provider: 'custom', event_type: 'partial-failure-matrix', payload: {},
      });
      expect(failed).toHaveBeenCalledTimes(1);
      expect(succeeded).toHaveBeenCalledTimes(1);
      expect(getEvent(eventId)?.status).toBe('failed');
      const statuses = (testDb.prepare(
        'SELECT status FROM webhook_delivery_log WHERE event_id = ?',
      ).all(eventId) as Array<{ status: string }>).map(row => row.status);
      expect(statuses).toEqual(expect.arrayContaining(['failed', 'success']));
    });

    it('counts failed events in daily stats', async () => {
      onWebhookEvent('custom', 'stats-failure-matrix', vi.fn().mockRejectedValue(new Error('boom')));
      await receiveWebhookEvent({ provider: 'custom', event_type: 'stats-failure-matrix', payload: {} });
      await receiveWebhookEvent({ provider: 'custom', event_type: 'stats-failure-matrix', payload: {} });
      expect(getWebhookStats()).toMatchObject({ failedToday: 2, eventsToday: 2 });
    });

    it('expires only active past-due subscriptions, including batches', () => {
      const paused = registerSubscription({
        provider: 'garmin', endpoint_path: '/paused', expires_at: '2020-01-01T00:00:00Z',
      });
      updateSubscriptionStatus(paused, 'paused');
      registerSubscription({ provider: 'garmin', endpoint_path: '/future', expires_at: '2099-12-31T23:59:59Z' });
      registerSubscription({ provider: 'custom', endpoint_path: '/expired-a', expires_at: '2020-01-01T00:00:00Z' });
      registerSubscription({ provider: 'github', endpoint_path: '/expired-b', expires_at: '2020-06-15T00:00:00Z' });
      expect(expireSubscriptions()).toBe(2);
      expect(getSubscription(paused)?.status).toBe('paused');
      expect(getSubscriptions({ status: 'active' }).map(sub => sub.endpoint_path)).toEqual(['/future']);
    });

    it('fails closed with safe defaults when the database is unavailable', async () => {
      setDbProvider(() => { throw new Error('no db'); });
      expect(registerSubscription({ provider: 'garmin', endpoint_path: '/a' })).toBe(-1);
      expect(getSubscriptions()).toEqual([]);
      expect(getSubscription(1)).toBeNull();
      expect(updateSubscriptionStatus(1, 'paused')).toBe(false);
      expect(removeSubscription(1)).toBe(false);
      expect(getEvent(1)).toBeNull();
      expect(getRecentEvents()).toEqual([]);
      expect(expireSubscriptions()).toBe(0);
      expect(getWebhookStats()).toMatchObject({ totalSubscriptions: 0, byProvider: [] });
      expect(await receiveWebhookEvent({ provider: 'garmin', event_type: 'activity', payload: {} })).toBe(-1);
    });

    it('supports declared providers for receipt while unverified registration fails closed', async () => {
      const providers: WebhookProvider[] = [
        'google_calendar', 'google_gmail', 'outlook_calendar', 'outlook_mail',
        'outlook_todo', 'garmin', 'strava', 'github', 'custom',
      ];
      for (const provider of providers) {
        const registered = registerSubscription({ provider, endpoint_path: `/api/webhooks/${provider}` });
        if (provider === 'google_gmail' || provider === 'strava') expect(registered).toBe(-1);
        else expect(registered).toBeGreaterThan(0);
        expect(await receiveWebhookEvent({ provider, event_type: 'provider-matrix', payload: { provider } })).toBeGreaterThan(0);
      }
      expect(getSubscriptions()).toHaveLength(providers.length - 2);
    });

    it('keeps webhook configuration typed with production defaults', async () => {
      const { config } = await import('../../src/config');
      expect(config.webhooks).toMatchObject({
        enabled: expect.any(Boolean),
        maxPayloadBytes: 1_048_576,
        eventRetentionDays: 30,
        ownerEncryptionWritesEnabled: false,
      });
    });

    it('returns an empty recent list and applies the default limit of 50', async () => {
      expect(getRecentEvents()).toEqual([]);
      for (let index = 0; index < 55; index += 1) {
        await receiveWebhookEvent({ provider: 'custom', event_type: 'bulk-matrix', payload: { index } });
      }
      expect(getRecentEvents()).toHaveLength(50);
    });

    it('combines provider and failure-status recent-event filters', async () => {
      onWebhookEvent('custom', 'combined-filter-matrix', vi.fn().mockRejectedValue(new Error('fail')));
      await receiveWebhookEvent({ provider: 'custom', event_type: 'combined-filter-matrix', payload: {} });
      await receiveWebhookEvent({ provider: 'garmin', event_type: 'other-matrix', payload: {} });
      expect(getRecentEvents({ provider: 'custom', status: 'failed' })).toEqual([
        expect.objectContaining({ provider: 'custom', status: 'failed' }),
      ]);
    });
  });
});
