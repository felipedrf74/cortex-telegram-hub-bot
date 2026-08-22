// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Request, Response } from 'express';
import express from 'express';
import {
  createPublicCheckoutSession,
  isStripeCheckoutUnavailableError,
  isStripeConfigured,
} from '../../services/stripe-service';
import { config } from '../../config';
import { hashWaitlistIpAddress } from '../../services/waitlist-ip-hash';
import { hashEmail } from '../../utils/identity';
import { logger } from '../../utils/logger';

const CORS_ALLOWLIST = new Set<string>([
  'https://nexushub.me',
  'https://www.nexushub.me',
]);
const CORS_ALLOWLIST_REGEX = /^https:\/\/[a-z0-9-]+\.nexushub-landing\.pages\.dev$/;

const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 10;
const checkoutTimestamps = new Map<string, number[]>();

function applyCors(req: Request, res: Response): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && (CORS_ALLOWLIST.has(origin) || CORS_ALLOWLIST_REGEX.test(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
  }
}

function hashIp(req: Request): string {
  const cloudflareIp = req.headers['cf-connecting-ip'];
  const forwarded = req.headers['x-forwarded-for'];
  const ip = typeof cloudflareIp === 'string'
    ? cloudflareIp.trim()
    : Array.isArray(cloudflareIp) && typeof cloudflareIp[0] === 'string'
      ? cloudflareIp[0].trim()
      : Array.isArray(forwarded)
        ? forwarded[0]
        : typeof forwarded === 'string'
          ? forwarded.split(',')[0].trim()
          : req.socket.remoteAddress || 'unknown';
  return hashWaitlistIpAddress(ip);
}

function pruneRateLimitMap(now: number): void {
  for (const [key, timestamps] of checkoutTimestamps.entries()) {
    const recent = timestamps.filter((ts) => now - ts < WINDOW_MS);
    if (recent.length === 0) {
      checkoutTimestamps.delete(key);
    } else if (recent.length !== timestamps.length) {
      checkoutTimestamps.set(key, recent);
    }
  }
}

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  pruneRateLimitMap(now);
  const timestamps = checkoutTimestamps.get(key) || [];
  const recent = timestamps.filter((ts) => now - ts < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) return false;
  recent.push(now);
  checkoutTimestamps.set(key, recent);
  return true;
}

export function safeCheckoutUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = new URL(value);
    if (CORS_ALLOWLIST.has(parsed.origin) || CORS_ALLOWLIST_REGEX.test(parsed.origin)) {
      return parsed.toString();
    }
  } catch { /* ignore invalid client URL */ }
  return fallback;
}

export function _resetPublicBillingRateLimiterForTests(): void {
  checkoutTimestamps.clear();
}

export function createPublicBillingRouter(): Router {
  const router = Router();
  const json = express.json({ limit: '16kb' });

  router.use((req: Request, res: Response, next) => {
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  router.post('/checkout', json, async (req: Request, res: Response) => {
    // Anonymous email checkout stops accepting NEW sessions once the hybrid
    // commerce sunset flips at launch (plan §3); in-flight claim sessions
    // continue through their existing compatibility path.
    if (!config.hybridCommerce.anonymousCheckoutEnabled) {
      res.status(410).json({ ok: false, error: 'Anonymous checkout is closed. Sign in to subscribe.' });
      return;
    }
    if (!isStripeConfigured()) {
      res.status(503).json({ ok: false, error: 'Stripe billing is not configured.' });
      return;
    }

    const body = req.body || {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const rateKey = `${hashIp(req)}:${email ? hashEmail(email, 16) : 'missing'}`;
    if (!checkRateLimit(rateKey)) {
      res.status(429).json({ ok: false, error: 'Too many checkout attempts. Try again later.' });
      return;
    }

    const successUrl = safeCheckoutUrl(body.successUrl, 'https://nexushub.me/?checkout=success');
    const cancelUrl = safeCheckoutUrl(body.cancelUrl, 'https://nexushub.me/?checkout=canceled');

    try {
      const url = await createPublicCheckoutSession({
        email,
        plan: body.plan,
        currency: body.currency,
        successUrl,
        cancelUrl,
      });
      res.json({ ok: true, url });
    } catch (err: any) {
      if (['INVALID_EMAIL', 'INVALID_PLAN', 'INVALID_CURRENCY', 'PRICE_NOT_CONFIGURED'].includes(err?.message)) {
        res.status(400).json({ ok: false, error: 'Invalid checkout request.' });
        return;
      }
      if (isStripeCheckoutUnavailableError(err)) {
        res.status(503).json({ ok: false, error: 'Checkout is temporarily unavailable.' });
        return;
      }
      logger.error({ err, emailHash: email ? hashEmail(email, 16) : null }, 'Public checkout failed');
      res.status(500).json({ ok: false, error: 'Could not start checkout. Please try again.' });
    }
  });

  return router;
}
