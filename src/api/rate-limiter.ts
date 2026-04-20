// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Request, Response, NextFunction } from 'express';
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

const userRequestLog = new Map<number, number[]>();
const ipRequestLog = new Map<string, number[]>();

const WINDOW_MS = 60 * 1000; // 1 minute

// Authenticated users get the configured per-user quota.
const USER_MAX_REQUESTS = config.ios?.rateLimit || 60;
// Unauthenticated traffic gets a TIGHTER cap because:
//   - legitimate use is rare (register/refresh are one-shot)
//   - abuse potential is much higher (brute-force invite codes,
//     credential stuffing, webhook flood)
// 30 reqs/min/IP still allows burst legitimate traffic but caps
// credential-stuffing at roughly 1 attempt every 2 seconds.
const UNAUTH_MAX_REQUESTS = Math.min(USER_MAX_REQUESTS, 30);

function extractClientIp(req: Request): string {
  // Express `req.ip` respects `trust proxy`. When behind the
  // Cloudflare Tunnel we deliberately DON'T trust the raw proxy chain
  // (spoofing risk); `req.socket.remoteAddress` is the tunnel's IP.
  // Falling back to that is acceptable because all legitimate ingress
  // is via the tunnel — the tight limit still protects the app.
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const userId = (req as AuthenticatedRequest).userId;
  const now = Date.now();

  if (typeof userId === 'number' && userId > 0) {
    // ── Authenticated path ──
    const userRequests = userRequestLog.get(userId) || [];
    const inWindow = userRequests.filter((ts) => now - ts < WINDOW_MS);
    inWindow.push(now);
    userRequestLog.set(userId, inWindow);

    const remaining = Math.max(0, USER_MAX_REQUESTS - inWindow.length);
    res.setHeader('X-RateLimit-Limit', USER_MAX_REQUESTS);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil((now + WINDOW_MS) / 1000));
    res.setHeader('X-RateLimit-Bucket', 'user');

    if (inWindow.length > USER_MAX_REQUESTS) {
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
  // because the JWT middleware hasn't run yet — falls into the IP
  // bucket so we still get some floor of abuse protection.
  const ip = extractClientIp(req);
  const ipRequests = ipRequestLog.get(ip) || [];
  const inWindow = ipRequests.filter((ts) => now - ts < WINDOW_MS);
  inWindow.push(now);
  ipRequestLog.set(ip, inWindow);

  const remaining = Math.max(0, UNAUTH_MAX_REQUESTS - inWindow.length);
  res.setHeader('X-RateLimit-Limit', UNAUTH_MAX_REQUESTS);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil((now + WINDOW_MS) / 1000));
  res.setHeader('X-RateLimit-Bucket', 'ip');

  if (inWindow.length > UNAUTH_MAX_REQUESTS) {
    const retryAfter = Math.ceil(WINDOW_MS / 1000);
    res.setHeader('Retry-After', retryAfter);
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Too many requests from this IP. Slow down.', retryAfter },
    });
    return;
  }

  next();
}

// Cleanup old entries every 5 minutes (both buckets).
setInterval(() => {
  const now = Date.now();
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
}, 5 * 60 * 1000);

/** Test-only: clear both buckets between test cases. */
export function _resetRateLimiterForTests(): void {
  userRequestLog.clear();
  ipRequestLog.clear();
}
