// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Request, Response, NextFunction } from 'express';
import net from 'node:net';
import { config } from '../config';
import type { AuthenticatedRequest } from './auth-middleware';

/**
 * In-memory rate limiter.
 *
 * Keyed behavior:
 *   - Authenticated requests   → keyed by userId (existing behavior).
 *   - Unauthenticated requests → keyed by client IP (HARDENING AUDIT
 *     2026-04-20 FIX). Before, requests with no userId called `next()`
 *     unconditionally — so routes BEFORE authMiddleware (e.g.
 *     `/auth/register`, `/auth/refresh`, webhook endpoints) had ZERO
 *     rate limit and the invite code `BETA2026` was brute-forceable.
 *
 * Sliding window: WINDOW_MS. Over-window requests → 429 with
 * Retry-After. All responses carry X-RateLimit-* headers, including
 * the IP-bucket bucket where applicable.
 *
 * State is in-process. Under PM2 cluster (not currently used) the
 * buckets would be per-worker and attackers would get N× the quota —
 * flagged in the audit handoff as a future move to Redis-backed
 * buckets if we scale horizontally.
 */

const userReadRequestLog = new Map<number, number[]>();
const userRequestLog = new Map<number, number[]>();
const ipRequestLog = new Map<string, number[]>();
const ipAuthRequestLog = new Map<string, number[]>();
const ipPortalRequestLog = new Map<string, number[]>();
const internalRequestLog = new Map<string, number[]>();
const internalAiRequestLog = new Map<string, number[]>();

const WINDOW_MS = 60 * 1000; // 1 minute

// Authenticated users get the configured per-user quota.
const USER_MAX_REQUESTS = config.ios?.rateLimit || 60;
// Navigation/read-heavy iOS screens can legitimately make many GETs while
// keeping the app responsive. Keep reads on a separate, higher bucket so a
// rapid tab switch does not starve the tighter mutation/chat budget.
const USER_READ_MAX_REQUESTS = config.ios?.readRateLimit || Math.max(USER_MAX_REQUESTS, 300);
// Unauthenticated traffic gets a TIGHTER cap because:
//   - legitimate use is rare (register/refresh are one-shot)
//   - abuse potential is much higher (brute-force invite codes,
//     credential stuffing, webhook flood)
// 30 reqs/min/IP still allows burst legitimate traffic but caps
// credential-stuffing at roughly 1 attempt every 2 seconds.
const UNAUTH_MAX_REQUESTS = Math.min(USER_MAX_REQUESTS, 30);
// Browser auth and portal pages perform several unauthenticated API calls
// during OAuth handshakes and dashboard boot. Keep those on separate buckets
// so a normal `/user` session cannot burn the generic abuse floor.
const UNAUTH_AUTH_MAX_REQUESTS = optionalIntWithFallback(
  process.env.UNAUTH_AUTH_RATE_LIMIT,
  Math.max(UNAUTH_MAX_REQUESTS, 90),
);
const PORTAL_API_MAX_REQUESTS = optionalIntWithFallback(
  process.env.PORTAL_API_RATE_LIMIT,
  Math.max(UNAUTH_MAX_REQUESTS, 180),
);
// Internal shared-secret routes are service-to-service and should not be
// user-facing hot paths, but we keep the defaults generous enough to avoid
// choking the Python engine during legitimate batches. The important win is
// that abuse now burns a bounded IP budget instead of getting unlimited
// shared-secret guesses.
const INTERNAL_MAX_REQUESTS = optionalIntWithFallback(
  process.env.INTERNAL_API_RATE_LIMIT,
  180,
);
const INTERNAL_AI_MAX_REQUESTS = optionalIntWithFallback(
  process.env.INTERNAL_AI_COMPLETE_RATE_LIMIT,
  60,
);

function optionalIntWithFallback(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const first = raw.split(',')[0]?.trim();
  return first || undefined;
}

function normalizeIp(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  return net.isIP(trimmed) ? trimmed : null;
}

function ipv4IsPrivateOrLoopback(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false;
  const [a, b] = parts;
  return (
    a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
  );
}

function isTrustedImmediatePeer(rawIp: string | undefined): boolean {
  const ip = normalizeIp(rawIp);
  if (!ip) return false;
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    return ipv4IsPrivateOrLoopback(lower.slice('::ffff:'.length));
  }
  if (net.isIP(lower) === 4) return ipv4IsPrivateOrLoopback(lower);
  return lower === '::1'
    || lower.startsWith('fc')
    || lower.startsWith('fd')
    || lower.startsWith('fe80:');
}

export function extractClientIp(req: Request): string {
  // Cloudflare Tunnel connects from a local/private peer, so the immediate
  // socket address alone would collapse all visitors into one rate-limit
  // bucket. Trust CF-Connecting-IP only when the direct peer is local/private;
  // direct public-origin spoofing keeps using req.ip/socket.remoteAddress.
  const peerIp = req.socket?.remoteAddress || req.ip;
  const cloudflareIp = normalizeIp(firstHeaderValue(req.headers?.['cf-connecting-ip']));
  if (cloudflareIp && isTrustedImmediatePeer(peerIp)) return cloudflareIp;

  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function unauthenticatedBucketFor(req: Request): {
  bucket: Map<string, number[]>;
  limit: number;
  name: string;
  message: string;
} {
  const originalUrl = req.originalUrl || req.url || '';
  const baseUrl = req.baseUrl || '';
  const path = req.path || '';
  const route = originalUrl || `${baseUrl}${path}`;

  if (
    route.startsWith('/api/v1/auth')
    || baseUrl.startsWith('/api/v1/auth')
  ) {
    return {
      bucket: ipAuthRequestLog,
      limit: UNAUTH_AUTH_MAX_REQUESTS,
      name: 'auth-ip',
      message: 'Too many auth requests from this IP. Slow down.',
    };
  }

  if (
    (route.startsWith('/api/') || route === '/api' || baseUrl === '/api')
    && !route.startsWith('/api/v1')
  ) {
    return {
      bucket: ipPortalRequestLog,
      limit: PORTAL_API_MAX_REQUESTS,
      name: 'portal-ip',
      message: 'Too many portal requests from this IP. Slow down.',
    };
  }

  return {
    bucket: ipRequestLog,
    limit: UNAUTH_MAX_REQUESTS,
    name: 'ip',
    message: 'Too many requests from this IP. Slow down.',
  };
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const userId = (req as AuthenticatedRequest).userId;
  const now = Date.now();

  if (typeof userId === 'number' && userId > 0) {
    // ── Authenticated path ──
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    const bucket = isRead ? userReadRequestLog : userRequestLog;
    const maxRequests = isRead ? USER_READ_MAX_REQUESTS : USER_MAX_REQUESTS;
    const bucketName = isRead ? 'user-read' : 'user';
    const userRequests = bucket.get(userId) || [];
    const inWindow = userRequests.filter((ts) => now - ts < WINDOW_MS);
    inWindow.push(now);
    bucket.set(userId, inWindow);

    const remaining = Math.max(0, maxRequests - inWindow.length);
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil((now + WINDOW_MS) / 1000));
    res.setHeader('X-RateLimit-Bucket', bucketName);

    if (inWindow.length > maxRequests) {
      const retryAfter = Math.ceil(WINDOW_MS / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.', retryAfter },
      });
      return;
    }

    next();
    return;
  }

  // ── Unauthenticated path (hardening audit 2026-04-20) ──
  // Any request reaching the middleware without a userId — either
  // because it's a pre-auth route (register/refresh/webhook) or
  // because the JWT middleware hasn't run yet — falls into a route-aware
  // IP bucket so we still get abuse protection without starving the portal UI.
  const unauthBucket = unauthenticatedBucketFor(req);
  applyIpBucketLimit(
    req,
    res,
    next,
    unauthBucket.bucket,
    unauthBucket.limit,
    unauthBucket.name,
    unauthBucket.message,
  );
}

// Cleanup old entries every 5 minutes (both buckets).
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of userReadRequestLog) {
    const inWindow = timestamps.filter((ts) => now - ts < WINDOW_MS);
    if (inWindow.length === 0) {
      userReadRequestLog.delete(userId);
    } else {
      userReadRequestLog.set(userId, inWindow);
    }
  }
  for (const [userId, timestamps] of userRequestLog) {
    const inWindow = timestamps.filter((ts) => now - ts < WINDOW_MS);
    if (inWindow.length === 0) {
      userRequestLog.delete(userId);
    } else {
      userRequestLog.set(userId, inWindow);
    }
  }
  for (const [ip, timestamps] of ipRequestLog) {
    const inWindow = timestamps.filter((ts) => now - ts < WINDOW_MS);
    if (inWindow.length === 0) {
      ipRequestLog.delete(ip);
    } else {
      ipRequestLog.set(ip, inWindow);
    }
  }
  for (const [ip, timestamps] of ipAuthRequestLog) {
    const inWindow = timestamps.filter((ts) => now - ts < WINDOW_MS);
    if (inWindow.length === 0) {
      ipAuthRequestLog.delete(ip);
    } else {
      ipAuthRequestLog.set(ip, inWindow);
    }
  }
  for (const [ip, timestamps] of ipPortalRequestLog) {
    const inWindow = timestamps.filter((ts) => now - ts < WINDOW_MS);
    if (inWindow.length === 0) {
      ipPortalRequestLog.delete(ip);
    } else {
      ipPortalRequestLog.set(ip, inWindow);
    }
  }
  for (const [ip, timestamps] of webhookRequestLog) {
    const inWindow = timestamps.filter((ts) => now - ts < WINDOW_MS);
    if (inWindow.length === 0) {
      webhookRequestLog.delete(ip);
    } else {
      webhookRequestLog.set(ip, inWindow);
    }
  }
}, 5 * 60 * 1000);

// ── Webhook rate limit (L-1 from tenant hardening pass 2026-04-21) ─
//
// Apple App Store and Stripe webhooks had no rate-limit. Legitimate
// Apple + Stripe traffic is infrastructure-driven and low-volume, but
// a forged payload burst (especially before signature verification
// would reject it) could flood the handler, CPU-starve the Node
// event loop, and cascade into iOS API timeouts.
//
// We use a SEPARATE bucket with a looser cap than `/auth/*` because:
//   - Stripe batches renewal events and can send ~dozens/minute on a
//     busy billing day — 30/min (auth cap) is too tight.
//   - Webhook signature verification is cheap, so 120/min/IP gives
//     comfortable headroom without letting a forger spam us.
// The 120/min cap applies PER client IP. Stripe uses a few egress
// IPs; Apple sends from its own range. Under Cloudflare Tunnel the IP
// observed is the tunnel's, so all webhook traffic shares a single
// bucket — which is exactly what we want: protect the node, not the
// vendor.
const webhookRequestLog = new Map<string, number[]>();
const WEBHOOK_MAX_REQUESTS = 120; // per minute

export function webhookRateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip = extractClientIp(req);
  const now = Date.now();
  const requests = webhookRequestLog.get(ip) || [];
  const inWindow = requests.filter((ts) => now - ts < WINDOW_MS);
  inWindow.push(now);
  webhookRequestLog.set(ip, inWindow);

  res.setHeader('X-RateLimit-Limit', WEBHOOK_MAX_REQUESTS);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, WEBHOOK_MAX_REQUESTS - inWindow.length));
  res.setHeader('X-RateLimit-Reset', Math.ceil((now + WINDOW_MS) / 1000));
  res.setHeader('X-RateLimit-Bucket', 'webhook');

  if (inWindow.length > WEBHOOK_MAX_REQUESTS) {
    const retryAfter = Math.ceil(WINDOW_MS / 1000);
    res.setHeader('Retry-After', retryAfter);
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Too many webhook deliveries from this IP.' },
    });
    return;
  }

  next();
}

function applyIpBucketLimit(
  req: Request,
  res: Response,
  next: NextFunction,
  bucket: Map<string, number[]>,
  limit: number,
  bucketName: string,
  message: string,
): void {
  const ip = extractClientIp(req);
  const now = Date.now();
  const requests = bucket.get(ip) || [];
  const inWindow = requests.filter((ts) => now - ts < WINDOW_MS);
  inWindow.push(now);
  bucket.set(ip, inWindow);

  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - inWindow.length));
  res.setHeader('X-RateLimit-Reset', Math.ceil((now + WINDOW_MS) / 1000));
  res.setHeader('X-RateLimit-Bucket', bucketName);

  if (inWindow.length > limit) {
    const retryAfter = Math.ceil(WINDOW_MS / 1000);
    res.setHeader('Retry-After', retryAfter);
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message,
        retryAfter,
      },
    });
    return;
  }

  next();
}

export function internalRateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  applyIpBucketLimit(
    req,
    res,
    next,
    internalRequestLog,
    INTERNAL_MAX_REQUESTS,
    'internal',
    'Too many internal requests from this IP.',
  );
}

export function internalAiCompleteRateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  applyIpBucketLimit(
    req,
    res,
    next,
    internalAiRequestLog,
    INTERNAL_AI_MAX_REQUESTS,
    'internal-ai',
    'Too many internal AI completion requests from this IP.',
  );
}

/** Test-only: clear both buckets between test cases. */
export function _resetRateLimiterForTests(): void {
  userReadRequestLog.clear();
  userRequestLog.clear();
  ipRequestLog.clear();
  ipAuthRequestLog.clear();
  ipPortalRequestLog.clear();
  webhookRequestLog.clear();
  internalRequestLog.clear();
  internalAiRequestLog.clear();
}
