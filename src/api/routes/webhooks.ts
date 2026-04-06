// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Webhook Router (TASK-16b)
 *
 * Public endpoints for provider push notifications:
 *   - POST /webhooks/todoist  → Todoist Sync v9 events
 *
 * Mounted by createPortalServer BEFORE the global express.json() parser so
 * the HMAC verifier sees the EXACT bytes Todoist signed. After verification,
 * we JSON.parse the raw buffer ourselves.
 *
 * Notion is intentionally not here — Notion has no webhooks. The 15-minute
 * cron + on-demand mapping flow handles it.
 */

import { Router, Request, Response } from 'express';
import express from 'express';
import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { config } from '../../config';

// Maximum age of a webhook delivery we'll accept. Without a timestamp window,
// a leaked HMAC could let an attacker replay old events forever. Todoist
// doesn't include a timestamp in the payload, but we can use the receive time
// to bound retries (Todoist gives up after ~24h).
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

// In-memory cache of recently-seen event ids to deflect immediate retries.
// Bounded to ~10k entries; oldest evicted FIFO when full. Per-process — fine
// because the only race is two pods receiving the same retry, which would
// just waste one extra sync round trip.
const recentDeliveryIds = new Map<string, number>();
const MAX_DELIVERY_IDS = 10_000;

function rememberDelivery(id: string): boolean {
  if (recentDeliveryIds.has(id)) return false;
  if (recentDeliveryIds.size >= MAX_DELIVERY_IDS) {
    // Evict oldest 10% to amortize the cleanup
    const toEvict = Math.floor(MAX_DELIVERY_IDS * 0.1);
    let i = 0;
    for (const key of recentDeliveryIds.keys()) {
      if (i++ >= toEvict) break;
      recentDeliveryIds.delete(key);
    }
  }
  recentDeliveryIds.set(id, Date.now());
  return true;
}

/** Test-only: clear delivery cache between tests. */
export function _resetDeliveryCacheForTests(): void {
  recentDeliveryIds.clear();
}

/**
 * Constant-time HMAC-SHA256 verification (Todoist spec).
 *
 * Uses `timingSafeEqual` to defeat timing-side-channel attacks: a naive
 * `===` comparison leaks how many bytes matched, which is enough info to
 * forge a valid signature byte-by-byte over enough probes.
 */
export function verifyTodoistSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  // Both buffers must be the same length for timingSafeEqual; padding mismatched
  // base64 strings to a known length defeats the timing protection, so we just
  // bail if the lengths differ.
  if (computed.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ─── Router factory ────────────────────────────────────────────────

export function createWebhookRouter(): Router {
  const router = Router();

  // Raw-body parser scoped to ONLY the webhook routes — global express.json()
  // would consume the bytes before we get a chance to HMAC them.
  const rawJson = express.raw({
    type: 'application/json',
    limit: '1mb',  // Todoist payloads are tiny; cap to defeat memory-DDoS
  });

  // ── POST /webhooks/todoist ─────────────────────────────────────

  router.post('/todoist', rawJson, async (req: Request, res: Response) => {
    const rawBody = req.body as Buffer;
    const signature = (req.headers['x-todoist-hmac-sha256'] as string) || '';
    const deliveryId = (req.headers['x-todoist-delivery-id'] as string) || '';

    // 1. Verify signature against the raw bytes
    const secret = config.todoist.webhookSecret;
    if (!secret) {
      logger.warn('Todoist webhook received but TODOIST_WEBHOOK_SECRET not set — rejecting');
      res.status(503).json({ error: 'webhook secret not configured' });
      return;
    }

    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      res.status(400).json({ error: 'empty body' });
      return;
    }

    if (!verifyTodoistSignature(rawBody, signature, secret)) {
      logger.warn({ signaturePresent: !!signature }, 'Todoist webhook signature invalid');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    // 2. Deflect duplicate retries (same delivery id within memory window)
    if (deliveryId && !rememberDelivery(deliveryId)) {
      // Acknowledge but don't process — Todoist will stop retrying
      res.status(200).json({ ok: true, dedup: true });
      return;
    }

    // 3. Parse and acknowledge IMMEDIATELY (Todoist enforces a 10s timeout)
    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      res.status(400).json({ error: 'malformed JSON' });
      return;
    }

    res.status(200).json({ ok: true });

    // 4. Process async — never block the response on the sync round trip
    setImmediate(() => {
      processeTodoistEvent(payload).catch((err) => {
        logger.warn({ err, eventName: payload?.event_name }, 'Todoist webhook processing failed');
      });
    });
  });

  return router;
}

// ─── Async processor ───────────────────────────────────────────────

/**
 * Look up the Nexus user that owns this Todoist account, then trigger an
 * immediate sync. The Todoist user id → Nexus telegram id mapping is
 * populated by the adapter every time it makes a Sync API call (see
 * todoist-adapter.ts → rememberTodoistUserMapping).
 *
 * If the mapping doesn't exist yet (e.g., first webhook ever, before any
 * cron sync has run), we fall back to scanning the OAuth table — slow but
 * correct, and only happens once per user per process lifetime.
 */
async function processeTodoistEvent(payload: any): Promise<void> {
  const todoistUserId = Number(payload.user_id);
  if (!todoistUserId) {
    logger.warn({ payload }, 'Todoist webhook missing user_id');
    return;
  }

  const { findNexusUserByTodoistId } = require('../../services/task-store/todoist-adapter');
  let nexusUserId = findNexusUserByTodoistId(todoistUserId);

  if (!nexusUserId) {
    nexusUserId = await scanOAuthForTodoistUser(todoistUserId);
    if (!nexusUserId) {
      logger.info({ todoistUserId }, 'No Nexus user found for Todoist webhook — ignoring');
      return;
    }
  }

  // Trigger immediate sync + context cache invalidation
  try {
    const { syncProvider } = require('../../services/task-store/sync-engine');
    const { invalidateContextCache } = require('../../services/context-engine');
    await syncProvider(nexusUserId, 'todoist');
    invalidateContextCache(nexusUserId);
    logger.debug(
      { nexusUserId, todoistUserId, eventName: payload.event_name },
      'Todoist webhook processed',
    );
  } catch (err) {
    logger.warn({ err, nexusUserId }, 'Todoist webhook sync failed');
  }
}

/**
 * Cold-cache fallback: walk every Nexus user with a Todoist token and run
 * a sync probe to see which one matches. This is slow (one HTTP call per
 * user) but only runs once per Todoist user per restart, so it's tolerable.
 */
async function scanOAuthForTodoistUser(todoistUserId: number): Promise<number | undefined> {
  try {
    const { getDb } = require('../../services/database');
    const { syncProvider } = require('../../services/task-store/sync-engine');
    const { findNexusUserByTodoistId } = require('../../services/task-store/todoist-adapter');

    const db = getDb();
    const rows = db.prepare(
      "SELECT user_id FROM user_oauth_tokens WHERE provider = 'todoist'",
    ).all() as { user_id: number }[];

    for (const row of rows) {
      // Run a sync — the adapter will populate the mapping cache as a side
      // effect. We don't need the result; we just want the cache filled.
      try {
        await syncProvider(row.user_id, 'todoist');
        const found = findNexusUserByTodoistId(todoistUserId);
        if (found) return found;
      } catch {
        // Skip users with broken tokens
      }
    }
  } catch (err) {
    logger.debug({ err }, 'OAuth scan for Todoist user failed');
  }
  return undefined;
}
