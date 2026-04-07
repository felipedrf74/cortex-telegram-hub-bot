// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Public waitlist endpoints for the nexushub.me landing page.
 *
 * Mounted at the root of the Express app (NOT under /api) so it bypasses
 * the portal-token auth gate — this is an unauthenticated public form that
 * random visitors from the internet POST to.
 *
 * Routes:
 *   POST /waitlist          → create or upgrade a waitlist entry
 *   GET  /waitlist/stats    → public counter (founder slots remaining)
 *
 * Admin routes (list / approve / convert to invite) live in portal/server.ts
 * under the /api/waitlist namespace where they inherit the portal token gate.
 */

import { Router, Request, Response } from 'express';
import express from 'express';
import crypto from 'crypto';
import { getDb } from '../../services/database';
import { logger } from '../../utils/logger';

// ─── Rate limiting (anti-spam) ──────────────────────────────────────

/**
 * Simple in-memory rate limiter keyed by hashed IP.
 *
 * Accepts up to 3 signups per IP per hour to allow legitimate mistakes
 * (typo'd email, user forgot they signed up) without letting a single
 * attacker burn through the founder slot counter.
 *
 * Per-process, resets on restart. This is fine because the SAME attacker
 * would need to work around both the rate limiter AND the UNIQUE email
 * constraint AND Cloudflare's own DDoS protection sitting in front.
 */
const WINDOW_MS = 60 * 60 * 1000;    // 1 hour
const MAX_PER_WINDOW = 3;
const ipTimestamps = new Map<string, number[]>();

function checkRateLimit(ipHash: string): boolean {
  const now = Date.now();
  const timestamps = ipTimestamps.get(ipHash) || [];
  // Drop timestamps older than the window
  const recent = timestamps.filter((ts) => now - ts < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) return false;
  recent.push(now);
  ipTimestamps.set(ipHash, recent);
  return true;
}

/** Test-only: clear the rate limiter between runs. */
export function _resetRateLimiterForTests(): void {
  ipTimestamps.clear();
}

// ─── Validation ─────────────────────────────────────────────────────

// RFC 5322 is insane. This regex matches the realistic subset that actual
// email providers accept — it's intentionally stricter than RFC to catch
// typos ("foo@bar" with no TLD) while still accepting every deliverable
// address I've seen in production.
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const MAX_EMAIL_LENGTH = 254;   // RFC 5321 hard limit
const MAX_USE_CASE_LENGTH = 500;
const MAX_SOURCE_LENGTH = 100;

function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  if (email.length > MAX_EMAIL_LENGTH) return false;
  return EMAIL_REGEX.test(email);
}

function sanitizeString(value: unknown, maxLen: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, maxLen);
  return trimmed || null;
}

// ─── IP hashing ─────────────────────────────────────────────────────

/**
 * Hash an IP with a short salt so the admin can detect bursts from the
 * same source WITHOUT the backend retaining raw IPs (GDPR-friendlier).
 *
 * The salt comes from env so rotating it invalidates every previously-
 * stored hash — useful if the salt ever leaks or if you want a clean slate.
 * Defaults to a per-process random value, which still gives burst detection
 * across requests in the same process lifetime.
 */
const IP_SALT = process.env.WAITLIST_IP_SALT || crypto.randomBytes(16).toString('hex');

function hashIp(req: Request): string {
  // Honor X-Forwarded-For if present (Cloudflare sets this when we're
  // behind a tunnel), else fall back to the direct socket IP.
  const forwarded = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded)
    ? forwarded[0]
    : typeof forwarded === 'string'
      ? forwarded.split(',')[0].trim()
      : req.socket.remoteAddress || 'unknown';
  return crypto.createHash('sha256').update(IP_SALT + ip).digest('hex').slice(0, 16);
}

// ─── Founder slot counter ──────────────────────────────────────────

export const MAX_FOUNDER_SLOTS = 100;

/**
 * Count how many founder slots are filled. Runs on every GET /waitlist/stats
 * call so the landing page counter is always live.
 */
export function countFounderSlots(): { filled: number; remaining: number; max: number } {
  try {
    const db = getDb();
    const row = db.prepare(
      "SELECT COUNT(*) AS cnt FROM waitlist WHERE intent = 'founder' AND status != 'rejected'",
    ).get() as { cnt: number };
    const filled = row.cnt || 0;
    return { filled, remaining: Math.max(0, MAX_FOUNDER_SLOTS - filled), max: MAX_FOUNDER_SLOTS };
  } catch (err) {
    logger.debug({ err }, 'countFounderSlots failed');
    return { filled: 0, remaining: MAX_FOUNDER_SLOTS, max: MAX_FOUNDER_SLOTS };
  }
}

// ─── Router ─────────────────────────────────────────────────────────

export function createWaitlistRouter(): Router {
  const router = Router();
  const json = express.json({ limit: '32kb' });

  /**
   * POST /waitlist
   *
   * Body: {
   *   email: string (required)
   *   intent: 'founder' | 'general' (default 'general')
   *   source?: string  — which CTA fired ('hero', 'pricing', 'footer', etc.)
   *   useCase?: string — optional "what do you use today?" field
   *   utm_source?: string
   *   utm_medium?: string
   *   utm_campaign?: string
   * }
   *
   * Response: {
   *   ok: true,
   *   intent: 'founder' | 'general',
   *   founderSlot?: number   — only when intent === 'founder'
   *   position?: number       — only when intent === 'general' (queue position)
   * }
   */
  router.post('/', json, (req: Request, res: Response) => {
    const ipHash = hashIp(req);

    // Rate limit BEFORE any DB work so a hostile loop is cheap to reject
    if (!checkRateLimit(ipHash)) {
      res.status(429).json({ ok: false, error: 'Too many signups from this network. Try again later.' });
      return;
    }

    const body = req.body || {};
    const email = sanitizeString(body.email, MAX_EMAIL_LENGTH)?.toLowerCase();
    if (!email || !isValidEmail(email)) {
      res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
      return;
    }

    const intent: 'founder' | 'general' = body.intent === 'founder' ? 'founder' : 'general';
    const source = sanitizeString(body.source, MAX_SOURCE_LENGTH);
    const useCase = sanitizeString(body.useCase, MAX_USE_CASE_LENGTH);
    const utmSource = sanitizeString(body.utm_source, MAX_SOURCE_LENGTH);
    const utmMedium = sanitizeString(body.utm_medium, MAX_SOURCE_LENGTH);
    const utmCampaign = sanitizeString(body.utm_campaign, MAX_SOURCE_LENGTH);
    const userAgent = sanitizeString(req.headers['user-agent'], 500);

    try {
      const db = getDb();

      // Use a transaction so the founder slot counter assignment is race-free.
      // SQLite's BEGIN/COMMIT wraps the whole upsert + slot calculation.
      const result = db.transaction(() => {
        // Already exists?
        const existing = db.prepare(
          'SELECT id, intent, founder_slot FROM waitlist WHERE email = ?',
        ).get(email) as { id: number; intent: string; founder_slot: number | null } | undefined;

        // Assign a founder slot only when:
        //   a) intent is 'founder', AND
        //   b) slots remain, AND
        //   c) this email doesn't already have one
        let founderSlot: number | null = null;
        if (intent === 'founder') {
          if (existing?.founder_slot) {
            // They're already a founder — just return their existing slot
            founderSlot = existing.founder_slot;
          } else {
            const filled = db.prepare(
              "SELECT COUNT(*) AS cnt FROM waitlist WHERE intent = 'founder' AND status != 'rejected'",
            ).get() as { cnt: number };
            if ((filled.cnt || 0) >= MAX_FOUNDER_SLOTS) {
              // Slots exhausted — silently downgrade to general intent
              return { ok: false as const, reason: 'slots_exhausted' as const };
            }
            founderSlot = (filled.cnt || 0) + 1;
          }
        }

        if (existing) {
          // Upgrade path: general → founder (slot assigned above)
          // OR idempotent re-submit with the same intent (no-op for counters)
          db.prepare(
            `UPDATE waitlist SET
               intent = ?,
               founder_slot = COALESCE(?, founder_slot),
               source = COALESCE(?, source),
               use_case = COALESCE(?, use_case),
               utm_source = COALESCE(?, utm_source),
               utm_medium = COALESCE(?, utm_medium),
               utm_campaign = COALESCE(?, utm_campaign)
             WHERE id = ?`,
          ).run(
            intent,
            founderSlot,
            source,
            useCase,
            utmSource,
            utmMedium,
            utmCampaign,
            existing.id,
          );
          return {
            ok: true as const,
            intent,
            founderSlot: founderSlot ?? undefined,
            upserted: true,
          };
        }

        // New entry
        const info = db.prepare(
          `INSERT INTO waitlist (
             email, intent, source, use_case,
             utm_source, utm_medium, utm_campaign,
             ip_hash, user_agent, founder_slot
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          email, intent, source, useCase,
          utmSource, utmMedium, utmCampaign,
          ipHash, userAgent, founderSlot,
        );

        // General position = row count of all 'general'-intent rows up to now
        let position: number | undefined;
        if (intent === 'general') {
          const count = db.prepare(
            "SELECT COUNT(*) AS cnt FROM waitlist WHERE intent = 'general'",
          ).get() as { cnt: number };
          position = count.cnt;
        }

        return {
          ok: true as const,
          intent,
          founderSlot: founderSlot ?? undefined,
          position,
          id: Number(info.lastInsertRowid),
        };
      })();

      if (!result.ok) {
        // Slots exhausted — the landing page can fall back to general intent
        res.status(409).json({
          ok: false,
          error: 'All 100 founder slots are filled. Join the general waitlist instead.',
          code: 'founder_slots_exhausted',
        });
        return;
      }

      logger.info(
        { email, intent, founderSlot: result.founderSlot, source },
        'Waitlist signup',
      );

      res.json({
        ok: true,
        intent: result.intent,
        founderSlot: result.founderSlot,
        position: 'position' in result ? result.position : undefined,
      });
    } catch (err: any) {
      logger.error({ err, email }, 'Waitlist signup failed');
      res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
    }
  });

  /**
   * GET /waitlist/stats
   *
   * Public endpoint the landing page polls to show the live founder
   * counter ("37 of 100 slots remaining"). Also returns the total general
   * waitlist size, which can be used as social proof on the landing page.
   */
  router.get('/stats', (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const founder = countFounderSlots();
      const general = db.prepare(
        "SELECT COUNT(*) AS cnt FROM waitlist WHERE intent = 'general'",
      ).get() as { cnt: number };
      res.json({
        ok: true,
        founder,
        general: { total: general.cnt || 0 },
      });
    } catch (err) {
      logger.debug({ err }, 'GET /waitlist/stats failed');
      res.json({
        ok: true,
        founder: { filled: 0, remaining: MAX_FOUNDER_SLOTS, max: MAX_FOUNDER_SLOTS },
        general: { total: 0 },
      });
    }
  });

  return router;
}
