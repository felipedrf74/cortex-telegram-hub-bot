// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cookie-backed operator sessions for the admin SPA.
 *
 *   POST /api/auth/session          { token, actor? } → validates a configured
 *                                   portal token, mints a signed `ps_` session
 *                                   with the matching scope, sets the
 *                                   `portal_session` cookie, returns
 *                                   { scope, expiresAt, csrf }
 *   GET  /api/auth/session          the current cookie session (scope, actor,
 *                                   expiresAt, csrf) — 404 when the request is
 *                                   not carrying a cookie session
 *   POST /api/auth/session/logout   clears the cookie
 *
 * Why: the SPA used to hold the raw portal token in tab memory, so every
 * reload was a re-login and the long-lived credential sat in JS. A session
 * cookie is HttpOnly (unreadable from script), scoped to the token's rights,
 * expires on its own, and every mutating request must also carry the
 * `x-portal-csrf` header derived from it (`rejectCookieSessionCsrf`), so a
 * cross-site form or fetch cannot ride the cookie.
 *
 * Requires PORTAL_SESSION_SECRET. Without it the routes answer 503 and the
 * SPA keeps the in-memory bearer flow.
 */

import type { Express, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { config } from '../config';
import { extractClientIp } from '../api/rate-limiter';
import {
  computePortalCsrfToken,
  extractPortalActorHint,
  getPortalAuthContext,
  requirePortalToken,
  secureSecretMatches,
  type PortalAuthContext,
} from '../api/secret-guards';
import { mintPortalSessionToken } from '../services/portal-session-mint';
import { PORTAL_SESSION_PREFIX, sanitizePortalActorHint, type PortalTokenScope } from '../services/portal-session-token';
import { logger } from '../utils/logger';
import { sendPortalInternalError } from './http';

export const PORTAL_SESSION_COOKIE = 'portal_session';
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_ACTOR = 'portal-operator';

export interface PortalSessionSettings {
  sessionSecret: string;
  sessionMaxAgeMs: number;
  requireSessionAuth: boolean;
  legacyToken: string;
  readToken: string;
  writeToken: string;
  adminToken: string;
  allowLegacyFallback: boolean;
}

function settings(): PortalSessionSettings {
  return {
    sessionSecret: config.portal.sessionSecret || '',
    sessionMaxAgeMs: Number.isFinite(config.portal.sessionMaxAgeMs) ? config.portal.sessionMaxAgeMs : DEFAULT_SESSION_TTL_MS,
    requireSessionAuth: config.portal.requireSessionAuth === true,
    legacyToken: config.portal.token || '',
    readToken: config.portal.readToken || '',
    writeToken: config.portal.writeToken || '',
    adminToken: config.portal.adminToken || '',
    allowLegacyFallback: config.portal.allowLegacyFallback === true,
  };
}

/**
 * Maps a presented portal token to the scope it grants, mirroring the bearer
 * rules in secret-guards: dedicated tokens win; the legacy full-access token
 * counts as admin only while no scoped token is configured or legacy fallback
 * is explicitly allowed.
 */
export function resolveScopeForPortalToken(provided: string, s: PortalSessionSettings): PortalTokenScope | null {
  if (!provided) return null;
  if (s.adminToken && secureSecretMatches(s.adminToken, provided)) return 'admin';
  if (s.writeToken && secureSecretMatches(s.writeToken, provided)) return 'write';
  if (s.readToken && secureSecretMatches(s.readToken, provided)) return 'read';
  const scopedConfigured = Boolean(s.readToken || s.writeToken || s.adminToken);
  if (s.legacyToken && (!scopedConfigured || s.allowLegacyFallback) && secureSecretMatches(s.legacyToken, provided)) return 'admin';
  return null;
}

/**
 * Verifies a pre-minted `ps_` session token (the credential operators use when
 * PORTAL_REQUIRE_SESSION_AUTH is on) by running the portal read guard against
 * a synthetic bearer request, so verification stays in secret-guards.
 */
export function verifyPresentedSessionToken(token: string, req: Request): { scope: PortalTokenScope; actor: string | undefined; expiresAt: number } | null {
  if (!token.startsWith(PORTAL_SESSION_PREFIX)) return null;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const synthetic = {
    method: 'GET',
    path: req.path,
    ip: req.ip,
    headers,
    header: (name: string) => headers[name.toLowerCase()],
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  let passed = false;
  const sink = {
    status() { return sink; },
    json() { return sink; },
    setHeader() { /* ignored */ },
    set() { return sink; },
  } as unknown as Response;
  requirePortalToken(synthetic, sink, () => { passed = true; });
  if (!passed) return null;
  // A ps_ bearer can only pass the guard as a session credential, and every
  // session carries its scope, actor and expiry — the guard verified them.
  const context = getPortalAuthContext(synthetic) as PortalAuthContext;
  return {
    scope: context.sessionScope as PortalTokenScope,
    actor: context.actorHint,
    expiresAt: context.sessionExpiresAt as number,
  };
}

function requestIsSecure(req: Request): boolean {
  if (req.secure) return true;
  const forwarded = (req.header('x-forwarded-proto') || '').toLowerCase();
  return forwarded.split(',').map((part) => part.trim()).includes('https');
}

export function buildSessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${PORTAL_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function readSessionCookie(req: Request): string | null {
  const header = req.header('cookie');
  if (!header) return null;
  const match = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${PORTAL_SESSION_COOKIE}=`));
  if (!match) return null;
  const raw = match.slice(PORTAL_SESSION_COOKIE.length + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function registerPortalSessionRoutes(app: Express): void {
  const loginLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(extractClientIp(req))}`,
    legacyHeaders: false,
    standardHeaders: true,
    handler: (_req, res) => {
      res.status(429).json({ ok: false, message: 'Too many sign-in attempts. Wait a minute and retry.' });
    },
  });

  app.post('/api/auth/session', loginLimiter, (req: Request, res: Response) => {
    try {
      const s = settings();
      if (!s.sessionSecret) {
        res.status(503).json({ ok: false, message: 'Portal sessions are not configured (PORTAL_SESSION_SECRET)' });
        return;
      }
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { token?: unknown; actor?: unknown };
      const provided = typeof body.token === 'string' ? body.token.trim() : '';

      // A pre-minted ps_ session token becomes the cookie session as-is.
      const presented = verifyPresentedSessionToken(provided, req);
      if (presented) {
        const remainingMs = Math.max(0, presented.expiresAt - Date.now());
        res.setHeader('Set-Cookie', buildSessionCookie(provided, remainingMs / 1000, requestIsSecure(req)));
        res.setHeader('Cache-Control', 'no-store');
        logger.info({ scope: presented.scope, actor: presented.actor, source: 'presented-session' }, 'Portal session adopted');
        res.json({
          ok: true,
          scope: presented.scope,
          actor: presented.actor,
          expiresAt: new Date(presented.expiresAt).toISOString(),
          csrf: computePortalCsrfToken(s.sessionSecret, provided),
        });
        return;
      }
      // Session-only deployments never accept static tokens, exactly like the guards.
      const scope = s.requireSessionAuth ? null : resolveScopeForPortalToken(provided, s);
      if (!scope) {
        logger.warn({ ip: extractClientIp(req) }, 'Portal session sign-in rejected');
        res.status(401).json({ ok: false, message: 'Invalid portal token' });
        return;
      }
      const actorHint = sanitizePortalActorHint(typeof body.actor === 'string' ? body.actor : undefined)
        ?? sanitizePortalActorHint(extractPortalActorHint(req))
        ?? DEFAULT_ACTOR;
      const ttlMs = Math.min(DEFAULT_SESSION_TTL_MS, s.sessionMaxAgeMs);
      const minted = mintPortalSessionToken({
        secret: s.sessionSecret,
        actorHint,
        scope,
        ttlMs,
        maxAgeMs: s.sessionMaxAgeMs,
      });
      res.setHeader('Set-Cookie', buildSessionCookie(minted.token, ttlMs / 1000, requestIsSecure(req)));
      res.setHeader('Cache-Control', 'no-store');
      logger.info({ scope, actor: minted.actor, expiresAt: new Date(minted.expiresAt).toISOString() }, 'Portal session created');
      res.json({
        ok: true,
        scope,
        actor: minted.actor,
        expiresAt: new Date(minted.expiresAt).toISOString(),
        csrf: computePortalCsrfToken(s.sessionSecret, minted.token),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to create portal session', 'Portal: session create failed');
    }
  });

  app.get('/api/auth/session', loginLimiter, requirePortalToken, (req: Request, res: Response) => {
    try {
      const s = settings();
      const context = getPortalAuthContext(req);
      const token = readSessionCookie(req);
      if (!s.sessionSecret || !context || context.matchedCredential !== 'session' || context.sessionSource !== 'cookie' || !token) {
        res.status(404).json({ ok: false, message: 'No cookie session' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        scope: context.sessionScope ?? context.requiredScope,
        actor: context.actorHint ?? null,
        expiresAt: context.sessionExpiresAt ? new Date(context.sessionExpiresAt).toISOString() : null,
        csrf: computePortalCsrfToken(s.sessionSecret, token),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to read portal session', 'Portal: session read failed');
    }
  });

  app.post('/api/auth/session/logout', loginLimiter, (req: Request, res: Response) => {
    res.setHeader('Set-Cookie', buildSessionCookie('', 0, requestIsSecure(req)));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  });
}
