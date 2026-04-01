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
// Maps each provider to the header containing the HMAC signature.

const SIGNATURE_HEADERS: Record<string, string> = {
  google_calendar: 'x-goog-channel-token',
  google_gmail: 'x-goog-channel-token',
  outlook_calendar: 'x-ms-client-state',   // clientState set during subscription
  outlook_mail: 'x-ms-client-state',
  outlook_todo: 'x-ms-client-state',
  garmin: 'x-garmin-signature',
  strava: 'x-strava-signature',            // not used currently, placeholder
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

// ─── HMAC Signature Verification ────────────────────────────────────

/**
 * Verify the HMAC-SHA256 signature of an incoming webhook request.
 * Returns true if signature is valid or if no secret is configured.
 */
export function verifySignature(
  provider: WebhookProvider,
  rawBody: string | Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  if (!secret) return true; // no secret configured — skip verification

  const headerName = SIGNATURE_HEADERS[provider] || 'x-webhook-signature';
  const providedSig = headers[headerName];
  if (!providedSig || typeof providedSig !== 'string') return false;

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
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
    const result = d.prepare(`
      INSERT INTO webhook_subscriptions
        (provider, event_types, endpoint_path, secret, external_id, metadata, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.provider,
      JSON.stringify(params.event_types || ['*']),
      params.endpoint_path,
      params.secret || null,
      params.external_id || null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      params.expires_at || null,
    );
    const id = (result.lastInsertRowid as number) ?? -1;
    logger.info({ provider: params.provider, id }, 'Webhook subscription registered');
    pushEvent({
      ts: new Date().toISOString(),
      type: 'auth',
      summary: `Webhook subscription registered: ${params.provider}`,
    });
    return id;
  } catch (err) {
    logger.error({ err }, 'Failed to register webhook subscription');
    return -1;
  }
}

/**
 * Get all subscriptions, optionally filtered by provider or status.
 */
export function getSubscriptions(filter?: {
  provider?: WebhookProvider;
  status?: SubscriptionStatus;
}): WebhookSubscription[] {
  const d = db();
  if (!d) return [];
  try {
    let sql = 'SELECT * FROM webhook_subscriptions WHERE 1=1';
    const args: unknown[] = [];
    if (filter?.provider) {
      sql += ' AND provider = ?';
      args.push(filter.provider);
    }
    if (filter?.status) {
      sql += ' AND status = ?';
      args.push(filter.status);
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
    const row = d.prepare('SELECT * FROM webhook_subscriptions WHERE id = ?').get(id);
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
export function removeSubscription(id: number): boolean {
  const d = db();
  if (!d) return false;
  try {
    const result = d.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(id);
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
  provider: WebhookProvider;
  event_type: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
  idempotency_key?: string;
  subscription_id?: number;
}): Promise<number> {
  const d = db();
  if (!d) return -1;

  // Dedup check: if idempotency_key exists and was already processed
  if (params.idempotency_key) {
    const existing = d.prepare(
      "SELECT id, status FROM webhook_events WHERE idempotency_key = ?"
    ).get(params.idempotency_key) as { id: number; status: string } | undefined;
    if (existing && existing.status !== 'failed') {
      logger.debug({ key: params.idempotency_key }, 'Webhook event deduplicated');
      return existing.id;
    }
  }

  // Log the event
  let eventId: number;
  try {
    const result = d.prepare(`
      INSERT INTO webhook_events
        (subscription_id, provider, event_type, payload, headers, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      params.subscription_id ?? null,
      params.provider,
      params.event_type,
      JSON.stringify(params.payload),
      params.headers ? JSON.stringify(params.headers) : null,
      params.idempotency_key ?? null,
    );
    eventId = (result.lastInsertRowid as number) ?? -1;
  } catch (err) {
    logger.error({ err }, 'Failed to log webhook event');
    return -1;
  }

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
    summary: `Webhook received: ${params.provider}/${params.event_type}`,
  });

  // Dispatch to handlers
  const event = getEvent(eventId);
  if (!event) return eventId;

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
      const errMsg = err instanceof Error ? err.message : String(err);
      lastError = errMsg;
      logDelivery(eventId, key, 'failed', Date.now() - start, errMsg);
      logger.error({ err, handler: key, eventId }, 'Webhook handler failed');
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
  provider?: string;
  status?: EventStatus;
  limit?: number;
}): WebhookEvent[] {
  const d = db();
  if (!d) return [];
  try {
    let sql = 'SELECT * FROM webhook_events WHERE 1=1';
    const args: unknown[] = [];
    if (filter?.provider) {
      sql += ' AND provider = ?';
      args.push(filter.provider);
    }
    if (filter?.status) {
      sql += ' AND status = ?';
      args.push(filter.status);
    }
    sql += ' ORDER BY received_at DESC LIMIT ?';
    args.push(filter?.limit ?? 50);

    return (d.prepare(sql).all(...args) as Record<string, unknown>[]).map(parseEventRow);
  } catch {
    return [];
  }
}

/**
 * Replay a failed event by re-dispatching to handlers.
 */
export async function replayEvent(eventId: number): Promise<boolean> {
  const event = getEvent(eventId);
  if (!event) return false;

  const handlers = getHandlers(event.provider, event.event_type);
  if (handlers.length === 0) return false;

  const d = db();
  if (!d) return false;

  try {
    d.prepare("UPDATE webhook_events SET status = 'processing', error_message = NULL WHERE id = ?").run(eventId);
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
      const errMsg = err instanceof Error ? err.message : String(err);
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
export function getWebhookStats(): WebhookStats {
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
    const totalSubs = (d.prepare(
      'SELECT COUNT(*) as c FROM webhook_subscriptions'
    ).get() as { c: number }).c;

    const activeSubs = (d.prepare(
      "SELECT COUNT(*) as c FROM webhook_subscriptions WHERE status = 'active'"
    ).get() as { c: number }).c;

    const eventsToday = (d.prepare(
      "SELECT COUNT(*) as c FROM webhook_events WHERE received_at >= date('now')"
    ).get() as { c: number }).c;

    const eventsLast7d = (d.prepare(
      "SELECT COUNT(*) as c FROM webhook_events WHERE received_at >= date('now', '-7 days')"
    ).get() as { c: number }).c;

    const failedToday = (d.prepare(
      "SELECT COUNT(*) as c FROM webhook_events WHERE received_at >= date('now') AND status = 'failed'"
    ).get() as { c: number }).c;

    const byProvider = d.prepare(`
      SELECT provider, COUNT(*) as count, MAX(received_at) as lastEvent
      FROM webhook_events
      WHERE received_at >= date('now', '-7 days')
      GROUP BY provider
      ORDER BY count DESC
    `).all() as { provider: string; count: number; lastEvent: string | null }[];

    return {
      totalSubscriptions: totalSubs,
      activeSubscriptions: activeSubs,
      eventsToday,
      eventsLast7d,
      failedToday,
      byProvider,
    };
  } catch (err) {
    logger.warn({ err }, 'Webhook registry: failed to query stats');
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
 * Expire subscriptions past their expires_at date. Run on startup and periodically.
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
        AND expires_at < datetime('now')
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
  return {
    id: row.id as number,
    provider: row.provider as WebhookProvider,
    event_types: typeof row.event_types === 'string' ? JSON.parse(row.event_types) : row.event_types as string[],
    endpoint_path: row.endpoint_path as string,
    secret: row.secret as string | null,
    status: row.status as SubscriptionStatus,
    external_id: row.external_id as string | null,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata as Record<string, unknown> | null,
    expires_at: row.expires_at as string | null,
    last_event_at: row.last_event_at as string | null,
    event_count: row.event_count as number,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function parseEventRow(row: Record<string, unknown>): WebhookEvent {
  return {
    id: row.id as number,
    subscription_id: row.subscription_id as number | null,
    provider: row.provider as string,
    event_type: row.event_type as string,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload as Record<string, unknown>,
    headers: typeof row.headers === 'string' ? JSON.parse(row.headers) : row.headers as Record<string, string> | null,
    status: row.status as EventStatus,
    error_message: row.error_message as string | null,
    idempotency_key: row.idempotency_key as string | null,
    received_at: row.received_at as string,
    processed_at: row.processed_at as string | null,
  };
}
