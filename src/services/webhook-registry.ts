// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Webhook Registry — event-driven integration infrastructure.
 *
 * Manages webhook subscriptions, verifies signatures, logs events,
 * and dispatches to internal handlers. Replaces cron-based polling
 * for integrations that support push notifications.
 *
 * This module follows the zero-project-import pattern (same as
 * telemetry.ts and intelligence-bus.ts) to avoid circular deps.
 * Uses setDbProvider() callback initialized from src/index.ts.
 */

import crypto from 'crypto';
import { logger } from '../utils/logger';
import { pushEvent } from '../portal/telemetry';
import { decryptValue, encryptValue } from '../utils/encryption';

// ─── Types ──────────────────────────────────────────────────────────

export type WebhookProvider =
  | 'google_calendar'
  | 'google_gmail'
  | 'outlook_calendar'
  | 'outlook_mail'
  | 'outlook_todo'
  | 'garmin'
  | 'strava'
  | 'github'
  | 'custom';

export type SubscriptionStatus = 'active' | 'paused' | 'expired' | 'revoked';
export type EventStatus = 'received' | 'processing' | 'processed' | 'failed' | 'ignored';
export type DeliveryStatus = 'pending' | 'success' | 'failed' | 'skipped';

export interface WebhookSubscription {
  id: number;
  user_id: number;
  provider: WebhookProvider;
  event_types: string[];
  endpoint_path: string;
  secret: string | null;
  status: SubscriptionStatus;
  external_id: string | null;
  metadata: Record<string, unknown> | null;
  expires_at: string | null;
  last_event_at: string | null;
  event_count: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookEvent {
  id: number;
  user_id: number;
  subscription_id: number | null;
  provider: string;
  event_type: string;
  payload: Record<string, unknown>;
  headers: Record<string, string> | null;
  status: EventStatus;
  error_message: string | null;
  idempotency_key: string | null;
  received_at: string;
  processed_at: string | null;
}

export interface WebhookDelivery {
  id: number;
  event_id: number;
  handler: string;
  status: DeliveryStatus;
  attempt: number;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
}

export interface WebhookStats {
  totalSubscriptions: number;
  activeSubscriptions: number;
  eventsToday: number;
  eventsLast7d: number;
  failedToday: number;
  byProvider: { provider: string; count: number; lastEvent: string | null }[];
}

// ─── Provider Signature Headers ─────────────────────────────────────
// Maps providers that use HMAC to their signature header. Calendar channel
// tokens and Microsoft Graph clientState are verified in dedicated branches;
// Gmail Pub/Sub remains disabled until its OIDC identity can be verified.

const SIGNATURE_HEADERS: Record<string, string> = {
  garmin: 'x-garmin-signature',
  github: 'x-hub-signature-256',
  custom: 'x-webhook-signature',
};

// ─── Database Provider (lazy, avoids circular imports) ───────────────

interface DbLike {
  prepare(sql: string): {
    run(...args: unknown[]): { lastInsertRowid?: number; changes?: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): {
    (): T;
    immediate(): T;
  };
}

type DbProvider = () => DbLike;
let _getDb: DbProvider | null = null;

export function setDbProvider(fn: DbProvider): void {
  _getDb = fn;
}

function db(): DbLike | null {
  if (!_getDb) return null;
  try { return _getDb(); } catch { return null; }
}

export const WEBHOOK_ENCRYPTED_JSON_PREFIX = 'nexus-webhook-json-v1:';

const WEBHOOK_PROVIDERS = new Set<WebhookProvider>([
  'google_calendar',
  'google_gmail',
  'outlook_calendar',
  'outlook_mail',
  'outlook_todo',
  'garmin',
  'strava',
  'github',
  'custom',
]);
const MAX_WEBHOOK_EVENT_TYPES = 64;
const MAX_WEBHOOK_EVENT_TYPE_LENGTH = 128;

export function isWebhookProvider(value: unknown): value is WebhookProvider {
  return typeof value === 'string' && WEBHOOK_PROVIDERS.has(value as WebhookProvider);
}

export function isValidWebhookEventTypes(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_WEBHOOK_EVENT_TYPES) {
    return false;
  }
  const seen = new Set<string>();
  for (const eventType of value) {
    if (typeof eventType !== 'string'
        || eventType.length < 1
        || eventType.length > MAX_WEBHOOK_EVENT_TYPE_LENGTH
        || eventType !== eventType.trim()
        || seen.has(eventType)) return false;
    seen.add(eventType);
  }
  return !seen.has('*') || seen.size === 1;
}

function webhookEncryptionKey(): string {
  // Webhook envelopes belong to the OAuth rotation domain. Never fall through
  // to another domain key: adding OAUTH_ENCRYPTION_KEY later must not silently
  // change which key decrypts already-written webhook values.
  return process.env.OAUTH_ENCRYPTION_KEY || '';
}

function assertPositiveUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('Webhook ownership requires a positive user id.');
  }
}

function isPlainWebhookRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainWebhookRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!isPlainWebhookRecord(value)) {
    throw new Error(`Webhook ${field} must be a JSON object.`);
  }
}

function secureWebhookSecretMatches(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function encryptWebhookValue(value: string, userId: number): string {
  assertPositiveUserId(userId);
  const key = webhookEncryptionKey();
  if (!key) throw new Error('Webhook payload encryption key is unavailable.');
  return WEBHOOK_ENCRYPTED_JSON_PREFIX + encryptValue(value, key, userId);
}

export function webhookOwnerEncryptionWritesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.WEBHOOK_OWNER_ENCRYPTION_WRITES_ENABLED === 'true';
}

function serializeWebhookValue(value: string, userId: number): string {
  // Release A keeps predecessor rollback readable: old binaries can read the
  // plaintext written while this flag is OFF. A later protected release may
  // enable envelope writes only after Release A is the verified rollback floor.
  return webhookOwnerEncryptionWritesEnabled()
    ? encryptWebhookValue(value, userId)
    : value;
}

function decryptWebhookValueForOwner(stored: unknown, userId: number): string | null {
  assertPositiveUserId(userId);
  if (stored == null) return null;
  if (typeof stored !== 'string') {
    throw new Error('Webhook encrypted value must be stored as text.');
  }
  if (!stored.startsWith(WEBHOOK_ENCRYPTED_JSON_PREFIX)) {
    // Read compatibility for positive-owner legacy rows and phase-A writes
    // created while envelope writes are deliberately disabled.
    return stored;
  }
  const key = webhookEncryptionKey();
  if (!key) throw new Error('Webhook payload encryption key is unavailable.');
  return decryptValue(
    stored.slice(WEBHOOK_ENCRYPTED_JSON_PREFIX.length),
    key,
    userId,
  );
}

function serializeWebhookJson(value: unknown, userId: number): string {
  return serializeWebhookValue(JSON.stringify(value), userId);
}

export function decryptWebhookJsonForOwner<T>(stored: unknown, userId: number): T {
  assertPositiveUserId(userId);
  if (typeof stored !== 'string') return stored as T;
  const plaintext = decryptWebhookValueForOwner(stored, userId);
  if (plaintext == null) return plaintext as T;
  return JSON.parse(plaintext) as T;
}

function safeWebhookErrorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError';
}

// ─── Event Handler Registry ─────────────────────────────────────────
// Internal handlers subscribe to provider+event_type combinations.

export type WebhookHandler = (event: WebhookEvent) => Promise<void>;

const _handlers = new Map<string, WebhookHandler[]>();

/**
 * Register an internal handler for a provider + event type.
 * Key format: "provider:event_type" or "provider:*" for all events.
 */
export function onWebhookEvent(
  provider: WebhookProvider,
  eventType: string,
  handler: WebhookHandler,
): void {
  const key = `${provider}:${eventType}`;
  const handlers = _handlers.get(key) || [];
  handlers.push(handler);
  _handlers.set(key, handlers);
}

/**
 * Get handlers matching a provider + event type.
 * Falls back to wildcard handlers if no specific match.
 */
function getHandlers(provider: string, eventType: string): { key: string; handler: WebhookHandler }[] {
  const results: { key: string; handler: WebhookHandler }[] = [];
  // Exact match
  const exact = _handlers.get(`${provider}:${eventType}`);
  if (exact) {
    for (const h of exact) results.push({ key: `${provider}:${eventType}`, handler: h });
  }
  // Wildcard match
  const wildcard = _handlers.get(`${provider}:*`);
  if (wildcard) {
    for (const h of wildcard) results.push({ key: `${provider}:*`, handler: h });
  }
  return results;
}

// ─── Provider Authentication Verification ──────────────────────────

/**
 * Verify an incoming webhook using its provider-native authentication
 * contract. Returns true only if a configured subscription secret validates.
 */
export function verifySignature(
  provider: WebhookProvider,
  rawBody: string | Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  if (!secret) return false;

  if (provider === 'google_calendar') {
    const channelToken = headers['x-goog-channel-token'];
    return typeof channelToken === 'string'
      && secureWebhookSecretMatches(channelToken, secret);
  }

  // Gmail push is delivered through Cloud Pub/Sub and requires OIDC JWT
  // signature, audience, and service-account verification. This registry does
  // not yet have those trusted inputs, so never reinterpret Gmail as a Calendar
  // channel-token webhook.
  if (provider === 'google_gmail') return false;

  // Strava's callback verification and event delivery contract is not an HMAC
  // header contract. Until its GET challenge and owner-bound POST identity are
  // implemented, never treat a made-up signature header as native proof.
  if (provider === 'strava') return false;

  if (provider === 'outlook_calendar'
      || provider === 'outlook_mail'
      || provider === 'outlook_todo') {
    try {
      const parsed: unknown = JSON.parse(
        typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8'),
      );
      return isPlainWebhookRecord(parsed)
        && typeof parsed.clientState === 'string'
        && secureWebhookSecretMatches(parsed.clientState, secret);
    } catch {
      return false;
    }
  }

  const headerName = SIGNATURE_HEADERS[provider] || 'x-webhook-signature';
  const providedSig = headers[headerName];
  if (!providedSig || typeof providedSig !== 'string') return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // GitHub prefixes with "sha256=", others may just send the hex digest
  const normalizedProvided = providedSig.startsWith('sha256=')
    ? providedSig.slice(7)
    : providedSig;

  // Timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(normalizedProvided, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    return false;
  }
}

// ─── Subscription CRUD ──────────────────────────────────────────────

/**
 * Register a new webhook subscription.
 * Returns the subscription ID, or -1 on failure.
 */
export function registerSubscription(params: {
  user_id: number;
  provider: WebhookProvider;
  event_types?: string[];
  endpoint_path: string;
  secret?: string;
  external_id?: string;
  metadata?: Record<string, unknown>;
  expires_at?: string;
}): number {
  const d = db();
  if (!d) return -1;
  try {
    assertPositiveUserId(params.user_id);
    if (!isWebhookProvider(params.provider)) throw new Error('Unsupported webhook provider.');
    if (params.metadata !== undefined) assertPlainWebhookRecord(params.metadata, 'metadata');
    const eventTypes = params.event_types ?? ['*'];
    if (!isValidWebhookEventTypes(eventTypes)) {
      throw new Error('Webhook event_types must be a bounded non-empty string array.');
    }
    const secret = params.secret?.trim() ?? '';
    const externalId = params.external_id?.trim() ?? '';
    if (!secret) throw new Error('Webhook subscription secret is required.');
    if (params.provider === 'google_gmail' || params.provider === 'strava') {
      throw new Error('Webhook provider native verification is not configured.');
    }
    if ((params.provider === 'google_calendar'
          || params.provider === 'outlook_calendar'
          || params.provider === 'outlook_mail'
          || params.provider === 'outlook_todo')
        && !externalId) {
      throw new Error('Webhook provider external identity is required.');
    }
    const register = d.transaction(() => {
      const existingRows = d.prepare(`
        SELECT user_id, secret
        FROM webhook_subscriptions
        WHERE provider = ? AND user_id > 0 AND secret IS NOT NULL
      `).all(params.provider) as Array<{ user_id: number; secret: unknown }>;
      for (const existing of existingRows) {
        const existingSecret = decryptWebhookValueForOwner(existing.secret, existing.user_id);
        if (existingSecret !== null && secureWebhookSecretMatches(existingSecret, secret)) {
          throw new Error('Webhook subscription secret must be unique within its provider.');
        }
      }
      return d.prepare(`
        INSERT INTO webhook_subscriptions
          (provider, event_types, endpoint_path, secret, external_id, metadata, expires_at, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.provider,
        JSON.stringify(eventTypes),
        params.endpoint_path,
        serializeWebhookValue(secret, params.user_id),
        externalId || null,
        params.metadata ? serializeWebhookJson(params.metadata, params.user_id) : null,
        params.expires_at || null,
        params.user_id,
      );
    });
    // Serialize the decrypt-and-compare uniqueness decision with the insert.
    const result = register.immediate();
    const id = (result.lastInsertRowid as number) ?? -1;
    logger.info({ provider: params.provider }, 'Webhook subscription registered');
    pushEvent({
      ts: new Date().toISOString(),
      type: 'auth',
      summary: `Webhook subscription registered: ${params.provider}`,
    });
    return id;
  } catch (err) {
    logger.error({ errorName: safeWebhookErrorName(err) }, 'Failed to register webhook subscription');
    return -1;
  }
}

/**
 * Get all subscriptions, optionally filtered by provider or status.
 */
export function getSubscriptions(filter?: {
  user_id?: number;
  provider?: WebhookProvider;
  status?: SubscriptionStatus;
}): WebhookSubscription[] {
  const d = db();
  if (!d) return [];
  try {
    let sql = 'SELECT * FROM webhook_subscriptions WHERE user_id > 0';
    const args: unknown[] = [];
    if (filter?.user_id !== undefined) {
      assertPositiveUserId(filter.user_id);
      sql += ' AND user_id = ?';
      args.push(filter.user_id);
    }
    if (filter?.provider) {
      sql += ' AND provider = ?';
      args.push(filter.provider);
    }
    if (filter?.status) {
      sql += ' AND status = ?';
      args.push(filter.status);
      if (filter.status === 'active') {
        // Status reconciliation is periodic, so authorization reads must also
        // fence wall-clock expiry directly.
        sql += " AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))";
      }
    }
    sql += ' ORDER BY created_at DESC';

    return (d.prepare(sql).all(...args) as Record<string, unknown>[]).map(parseSubscriptionRow);
  } catch {
    return [];
  }
}

/**
 * Get a single subscription by ID.
 */
export function getSubscription(id: number): WebhookSubscription | null {
  const d = db();
  if (!d) return null;
  try {
    const row = d.prepare('SELECT * FROM webhook_subscriptions WHERE id = ? AND user_id > 0').get(id);
    return row ? parseSubscriptionRow(row as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Update subscription status.
 */
export function updateSubscriptionStatus(id: number, status: SubscriptionStatus): boolean {
  const d = db();
  if (!d) return false;
  try {
    const result = d.prepare(
      "UPDATE webhook_subscriptions SET status = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(status, id);
    return (result.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Remove a subscription.
 */
export function removeSubscription(id: number, expectedUserId?: number): boolean {
  const d = db();
  if (!d) return false;
  try {
    if (expectedUserId !== undefined) assertPositiveUserId(expectedUserId);
    const result = expectedUserId === undefined
      ? d.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(id)
      : d.prepare('DELETE FROM webhook_subscriptions WHERE id = ? AND user_id = ?')
        .run(id, expectedUserId);
    return (result.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

// ─── Event Logging & Processing ─────────────────────────────────────

/**
 * Log an incoming webhook event and dispatch to registered handlers.
 * Returns the event ID, or -1 on failure.
 */
export async function receiveWebhookEvent(params: {
  user_id: number;
  provider: WebhookProvider;
  event_type: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
  idempotency_key?: string;
  subscription_id?: number;
}): Promise<number> {
  const d = db();
  if (!d) return -1;
  try {
    assertPositiveUserId(params.user_id);
    if (!isWebhookProvider(params.provider)) throw new Error('Unsupported webhook provider.');
    if (params.event_type === '*' || !isValidWebhookEventTypes([params.event_type])) {
      throw new Error('Webhook event_type must be a bounded non-empty string.');
    }
    assertPlainWebhookRecord(params.payload, 'payload');
    if (params.headers !== undefined) assertPlainWebhookRecord(params.headers, 'headers');
  } catch {
    logger.warn('Webhook event rejected because ownership or provider validation failed');
    return -1;
  }

  let admission: { eventId: number; duplicate: boolean };
  try {
    const storedPayload = serializeWebhookJson(params.payload, params.user_id);
    const storedHeaders = params.headers
      ? serializeWebhookJson(params.headers, params.user_id)
      : null;
    const admit = d.transaction((): { eventId: number; duplicate: boolean } => {
      if (params.subscription_id != null) {
        const subscription = d.prepare(`
          SELECT user_id, provider, status, event_types
          FROM webhook_subscriptions
          WHERE id = ?
            AND status = 'active'
            AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))
        `).get(params.subscription_id) as {
          user_id: number;
          provider: string;
          status: string;
          event_types: unknown;
        } | undefined;
        const subscriptionEventTypes = typeof subscription?.event_types === 'string'
          ? JSON.parse(subscription.event_types) as unknown
          : subscription?.event_types;
        if (!subscription
            || subscription.user_id !== params.user_id
            || subscription.provider !== params.provider
            || subscription.status !== 'active'
            || !isValidWebhookEventTypes(subscriptionEventTypes)
            || (!subscriptionEventTypes.includes('*')
              && !subscriptionEventTypes.includes(params.event_type))) {
          throw new Error('WebhookSubscriptionOwnershipMismatch');
        }
      }

      if (params.idempotency_key) {
        const existing = d.prepare(
          `SELECT id FROM webhook_events
           WHERE user_id = ? AND provider = ? AND subscription_id IS ?
             AND idempotency_key = ? AND status <> 'failed'
           ORDER BY id DESC LIMIT 1`
        ).get(
          params.user_id,
          params.provider,
          params.subscription_id ?? null,
          params.idempotency_key,
        ) as { id: number } | undefined;
        if (existing) return { eventId: existing.id, duplicate: true };
      }

      const result = d.prepare(`
        INSERT INTO webhook_events
          (subscription_id, provider, event_type, payload, headers, idempotency_key, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.subscription_id ?? null,
        params.provider,
        params.event_type,
        storedPayload,
        storedHeaders,
        params.idempotency_key ?? null,
        params.user_id,
      );
      return {
        eventId: (result.lastInsertRowid as number) ?? -1,
        duplicate: false,
      };
    });
    // BEGIN IMMEDIATE is the phase-A concurrency boundary. It keeps ownership
    // validation, dedup lookup, and insert atomic without a new unique index
    // that an older binary could trip over after rollback.
    admission = admit.immediate();
  } catch (err) {
    logger.warn({ provider: params.provider, errorName: safeWebhookErrorName(err) }, 'Webhook event admission failed');
    return -1;
  }

  if (admission.duplicate) {
    logger.debug({ provider: params.provider }, 'Webhook event deduplicated');
    return admission.eventId;
  }
  const eventId = admission.eventId;

  if (eventId < 0) return -1;

  // Update subscription stats
  if (params.subscription_id) {
    try {
      d.prepare(`
        UPDATE webhook_subscriptions
        SET last_event_at = datetime('now'),
            event_count = event_count + 1,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(params.subscription_id);
    } catch { /* non-critical */ }
  }

  // Push telemetry event
  pushEvent({
    ts: new Date().toISOString(),
    type: 'job',
    summary: `Webhook received: ${params.provider}`,
  });

  // Dispatch to handlers
  const event = getEvent(eventId);
  if (!event) {
    try {
      d.prepare(`
        UPDATE webhook_events
        SET status = 'failed', error_message = 'WebhookPayloadDecryptionError',
            processed_at = datetime('now')
        WHERE id = ?
      `).run(eventId);
    } catch { /* non-critical */ }
    return -1;
  }

  const handlers = getHandlers(params.provider, params.event_type);
  if (handlers.length === 0) {
    // No handlers registered — mark as ignored
    try {
      d.prepare("UPDATE webhook_events SET status = 'ignored' WHERE id = ?").run(eventId);
    } catch { /* non-critical */ }
    return eventId;
  }

  // Mark as processing
  try {
    d.prepare("UPDATE webhook_events SET status = 'processing' WHERE id = ?").run(eventId);
  } catch { /* non-critical */ }

  let allSucceeded = true;
  let lastError: string | null = null;

  for (const { key, handler } of handlers) {
    const start = Date.now();
    try {
      await handler(event);
      logDelivery(eventId, key, 'success', Date.now() - start);
    } catch (err: unknown) {
      allSucceeded = false;
      const errMsg = safeWebhookErrorName(err);
      lastError = errMsg;
      logDelivery(eventId, key, 'failed', Date.now() - start, errMsg);
      logger.error({ errorName: errMsg, handler: key }, 'Webhook handler failed');
    }
  }

  // Update event status
  try {
    d.prepare(`
      UPDATE webhook_events
      SET status = ?, error_message = ?, processed_at = datetime('now')
      WHERE id = ?
    `).run(
      allSucceeded ? 'processed' : 'failed',
      lastError,
      eventId,
    );
  } catch { /* non-critical */ }

  return eventId;
}

/**
 * Get a single event by ID.
 */
export function getEvent(id: number): WebhookEvent | null {
  const d = db();
  if (!d) return null;
  try {
    const row = d.prepare('SELECT * FROM webhook_events WHERE id = ?').get(id);
    return row ? parseEventRow(row as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Get recent events, optionally filtered by provider or status.
 */
export function getRecentEvents(filter?: {
  user_id?: number;
  provider?: string;
  status?: EventStatus;
  limit?: number;
}): WebhookEvent[] {
  const d = db();
  if (!d) return [];
  try {
    let sql = 'SELECT * FROM webhook_events WHERE user_id > 0';
    const args: unknown[] = [];
    if (filter?.user_id !== undefined) {
      assertPositiveUserId(filter.user_id);
      sql += ' AND user_id = ?';
      args.push(filter.user_id);
    }
    if (filter?.provider) {
      sql += ' AND provider = ?';
      args.push(filter.provider);
    }
    if (filter?.status) {
      sql += ' AND status = ?';
      args.push(filter.status);
    }
    sql += ' ORDER BY received_at DESC LIMIT ?';
    const requestedLimit = filter?.limit ?? 50;
    args.push(Number.isSafeInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 50);

    return (d.prepare(sql).all(...args) as Record<string, unknown>[]).map(parseEventRow);
  } catch {
    return [];
  }
}

/**
 * Replay a failed event by re-dispatching to handlers.
 */
export async function replayEvent(eventId: number, expectedUserId?: number): Promise<boolean> {
  if (expectedUserId !== undefined) {
    try { assertPositiveUserId(expectedUserId); } catch { return false; }
  }
  const event = getEvent(eventId);
  if (!event
      || event.user_id <= 0
      || event.status !== 'failed'
      || (expectedUserId !== undefined && event.user_id !== expectedUserId)) return false;

  const handlers = getHandlers(event.provider, event.event_type);
  if (handlers.length === 0) return false;

  const d = db();
  if (!d) return false;

  try {
    const claimReplay = d.transaction((): boolean => {
      const current = d.prepare(`
        SELECT id, user_id, provider, subscription_id, idempotency_key, status
        FROM webhook_events
        WHERE id = ?
      `).get(eventId) as Pick<
        WebhookEvent,
        'id' | 'user_id' | 'provider' | 'subscription_id' | 'idempotency_key' | 'status'
      > | undefined;
      if (!current
          || current.user_id <= 0
          || current.status !== 'failed'
          || (expectedUserId !== undefined && current.user_id !== expectedUserId)) return false;
      if (current.idempotency_key) {
        const newerAdmission = d.prepare(`
          SELECT id
          FROM webhook_events
          WHERE id <> ? AND user_id = ? AND provider = ?
            AND subscription_id IS ? AND idempotency_key = ?
            AND status <> 'failed'
          LIMIT 1
        `).get(
          current.id,
          current.user_id,
          current.provider,
          current.subscription_id,
          current.idempotency_key,
        );
        if (newerAdmission) return false;
      }
      const admitted = d.prepare(`
        UPDATE webhook_events
        SET status = 'processing', error_message = NULL
        WHERE id = ? AND status = 'failed'
      `).run(eventId);
      return admitted.changes === 1;
    });
    // Serialize replay claiming against provider retry admission so the old
    // failed row and a replacement delivery cannot both become active.
    if (!claimReplay.immediate()) return false;
  } catch {
    // A concurrent status transition makes this an explicit replay refusal.
    return false;
  }

  let allSucceeded = true;
  let lastError: string | null = null;

  for (const { key, handler } of handlers) {
    const start = Date.now();
    try {
      await handler(event);
      logDelivery(eventId, key, 'success', Date.now() - start);
    } catch (err: unknown) {
      allSucceeded = false;
      const errMsg = safeWebhookErrorName(err);
      lastError = errMsg;
      logDelivery(eventId, key, 'failed', Date.now() - start, errMsg);
    }
  }

  try {
    d.prepare(`
      UPDATE webhook_events
      SET status = ?, error_message = ?, processed_at = datetime('now')
      WHERE id = ?
    `).run(allSucceeded ? 'processed' : 'failed', lastError, eventId);
  } catch { /* non-critical */ }

  return allSucceeded;
}

// ─── Stats & Monitoring ─────────────────────────────────────────────

/**
 * Get webhook infrastructure stats for the portal.
 */
export function getWebhookStats(userId?: number): WebhookStats {
  const d = db();
  if (!d) return {
    totalSubscriptions: 0,
    activeSubscriptions: 0,
    eventsToday: 0,
    eventsLast7d: 0,
    failedToday: 0,
    byProvider: [],
  };

  try {
    if (userId !== undefined) assertPositiveUserId(userId);
    const ownerSql = userId === undefined ? 'user_id > 0' : 'user_id = ?';
    const ownerArgs = userId === undefined ? [] : [userId];
    const totalSubs = (d.prepare(
      `SELECT COUNT(*) as c FROM webhook_subscriptions WHERE ${ownerSql}`
    ).get(...ownerArgs) as { c: number }).c;

    const activeSubs = (d.prepare(
      `SELECT COUNT(*) as c FROM webhook_subscriptions
       WHERE status = 'active' AND ${ownerSql}
         AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))`
    ).get(...ownerArgs) as { c: number }).c;

    const eventsToday = (d.prepare(
      `SELECT COUNT(*) as c FROM webhook_events
       WHERE received_at >= date('now') AND ${ownerSql}`
    ).get(...ownerArgs) as { c: number }).c;

    const eventsLast7d = (d.prepare(
      `SELECT COUNT(*) as c FROM webhook_events
       WHERE received_at >= date('now', '-7 days') AND ${ownerSql}`
    ).get(...ownerArgs) as { c: number }).c;

    const failedToday = (d.prepare(
      `SELECT COUNT(*) as c FROM webhook_events
       WHERE received_at >= date('now') AND status = 'failed' AND ${ownerSql}`
    ).get(...ownerArgs) as { c: number }).c;

    const byProvider = d.prepare(`
      SELECT provider, COUNT(*) as count, MAX(received_at) as lastEvent
      FROM webhook_events
      WHERE received_at >= date('now', '-7 days') AND ${ownerSql}
      GROUP BY provider
      ORDER BY count DESC
    `).all(...ownerArgs) as { provider: string; count: number; lastEvent: string | null }[];

    return {
      totalSubscriptions: totalSubs,
      activeSubscriptions: activeSubs,
      eventsToday,
      eventsLast7d,
      failedToday,
      byProvider,
    };
  } catch (err) {
    logger.warn({ errorName: safeWebhookErrorName(err) }, 'Webhook registry: failed to query stats');
    return {
      totalSubscriptions: 0,
      activeSubscriptions: 0,
      eventsToday: 0,
      eventsLast7d: 0,
      failedToday: 0,
      byProvider: [],
    };
  }
}

/**
 * Reconcile subscriptions past their exact expires_at instant. Authorization
 * reads also enforce the same wall-clock fence between reconciliation runs.
 * Returns count of expired subscriptions.
 */
export function expireSubscriptions(): number {
  const d = db();
  if (!d) return 0;
  try {
    const result = d.prepare(`
      UPDATE webhook_subscriptions
      SET status = 'expired', updated_at = datetime('now')
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND julianday(expires_at) <= julianday('now')
    `).run();
    const count = result.changes ?? 0;
    if (count > 0) {
      logger.info({ count }, 'Expired webhook subscriptions');
    }
    return count;
  } catch {
    return 0;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function logDelivery(
  eventId: number,
  handler: string,
  status: DeliveryStatus,
  durationMs: number,
  errorMessage?: string,
): void {
  const d = db();
  if (!d) return;
  try {
    d.prepare(`
      INSERT INTO webhook_delivery_log (event_id, handler, status, duration_ms, error_message)
      VALUES (?, ?, ?, ?, ?)
    `).run(eventId, handler, status, durationMs, errorMessage ?? null);
  } catch { /* non-critical */ }
}

function parseSubscriptionRow(row: Record<string, unknown>): WebhookSubscription {
  const userId = row.user_id as number;
  assertPositiveUserId(userId);
  const eventTypes = typeof row.event_types === 'string'
    ? JSON.parse(row.event_types) as unknown
    : row.event_types;
  if (!isValidWebhookEventTypes(eventTypes)) {
    throw new Error('Webhook subscription has invalid event_types.');
  }
  const signingMaterial = decryptWebhookValueForOwner(row.secret, userId);
  return {
    id: row.id as number,
    user_id: userId,
    provider: row.provider as WebhookProvider,
    event_types: eventTypes,
    endpoint_path: row.endpoint_path as string,
    secret: signingMaterial,
    status: row.status as SubscriptionStatus,
    external_id: row.external_id as string | null,
    metadata: row.metadata == null
      ? null
      : decryptWebhookJsonForOwner<Record<string, unknown>>(row.metadata, userId),
    expires_at: row.expires_at as string | null,
    last_event_at: row.last_event_at as string | null,
    event_count: row.event_count as number,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function parseEventRow(row: Record<string, unknown>): WebhookEvent {
  const userId = row.user_id as number;
  return {
    id: row.id as number,
    user_id: userId,
    subscription_id: row.subscription_id as number | null,
    provider: row.provider as string,
    event_type: row.event_type as string,
    payload: decryptWebhookJsonForOwner<Record<string, unknown>>(row.payload, userId),
    headers: row.headers == null
      ? null
      : decryptWebhookJsonForOwner<Record<string, string>>(row.headers, userId),
    status: row.status as EventStatus,
    error_message: row.error_message as string | null,
    idempotency_key: row.idempotency_key as string | null,
    received_at: row.received_at as string,
    processed_at: row.processed_at as string | null,
  };
}
