// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Username + password sign-in for the admin portal.
 *
 *   GET  /api/auth/session/methods    which sign-in methods this deployment
 *                                     offers ({ token: true, password: bool })
 *   POST /api/auth/session/password   { username, password } → verifies the
 *                                     configured operator credential and mints
 *                                     the same signed `ps_` cookie session the
 *                                     token sign-in produces
 *
 * The credential is one username and one scrypt hash from the release env
 * (PORTAL_OPERATOR_USERNAME / PORTAL_OPERATOR_PASSWORD_HASH). Sessions keep
 * the configured actor and scope, so the actor allowlist, every guard and the
 * audit trail see exactly what they see for a pre-minted token. Both routes
 * sit outside the generic /api guard (see isPortalSessionAuthPath) and carry
 * their own limiter; failed attempts also trip a per-IP+username lockout.
 */

import type { Express, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { config } from '../config';
import { extractClientIp } from '../api/rate-limiter';
import { computePortalCsrfToken, recordPortalAuthAudit } from '../api/secret-guards';
import {
  portalUsernameMatches,
  readPortalOperatorCredentials,
  verifyPortalPassword,
  type PortalOperatorCredentials,
} from '../services/portal-password';
import { mintPortalSessionToken } from '../services/portal-session-mint';
import { logger } from '../utils/logger';
import { sendPortalInternalError } from './http';
import { buildSessionCookie, requestIsSecure } from './session-routes';

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const PASSWORD_LOCKOUT_ATTEMPTS = 5;
export const PASSWORD_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

/** Maps the parsed config back to the env shape the credential reader expects. */
export function operatorCredentialsFromConfig(portal: {
  operatorUsername?: string;
  operatorPasswordHash?: string;
  operatorActor?: string;
  operatorScope?: string;
}): PortalOperatorCredentials | null {
  return readPortalOperatorCredentials({
    PORTAL_OPERATOR_USERNAME: portal.operatorUsername || '',
    PORTAL_OPERATOR_PASSWORD_HASH: portal.operatorPasswordHash || '',
    PORTAL_OPERATOR_ACTOR: portal.operatorActor || '',
    PORTAL_OPERATOR_SCOPE: portal.operatorScope || 'admin',
  });
}

/**
 * Boot preflight: a half-configured or malformed operator credential refuses
 * to start rather than silently leaving password sign-in off.
 */
export function validatePortalOperatorCredentials(portal: Parameters<typeof operatorCredentialsFromConfig>[0]): void {
  operatorCredentialsFromConfig(portal);
}

interface LockoutEntry { failures: number; firstFailureAt: number; lockedUntil: number }
const lockouts = new Map<string, LockoutEntry>();

function lockoutKey(ip: string, username: string): string {
  return `${ip}|${username.trim().toLowerCase()}`;
}

function lockedUntil(key: string, now: number): number {
  const entry = lockouts.get(key);
  if (!entry) return 0;
  if (entry.lockedUntil > now) return entry.lockedUntil;
  if (now - entry.firstFailureAt > PASSWORD_LOCKOUT_WINDOW_MS) lockouts.delete(key);
  return 0;
}

function recordFailure(key: string, now: number): void {
  const entry = lockouts.get(key);
  if (!entry || now - entry.firstFailureAt > PASSWORD_LOCKOUT_WINDOW_MS) {
    lockouts.set(key, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
    return;
  }
  entry.failures += 1;
  if (entry.failures >= PASSWORD_LOCKOUT_ATTEMPTS) entry.lockedUntil = now + PASSWORD_LOCKOUT_WINDOW_MS;
}

export function _resetPasswordLockoutsForTests(): void {
  lockouts.clear();
}

export function registerPortalSessionPasswordRoutes(app: Express): void {
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(extractClientIp(req))}`,
    legacyHeaders: false,
    standardHeaders: true,
    handler: (_req, res) => {
      res.status(429).json({ ok: false, message: 'Too many sign-in attempts. Wait a minute and retry.' });
    },
  });

  app.get('/api/auth/session/methods', limiter, (_req: Request, res: Response) => {
    let password = false;
    try {
      password = Boolean(config.portal.sessionSecret) && operatorCredentialsFromConfig(config.portal) !== null;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Portal operator credential is misconfigured');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, token: true, password });
  });

  app.post('/api/auth/session/password', limiter, (req: Request, res: Response) => {
    try {
      const sessionSecret = config.portal.sessionSecret || '';
      const sessionMaxAgeMs = Number.isFinite(config.portal.sessionMaxAgeMs) ? config.portal.sessionMaxAgeMs : DEFAULT_SESSION_TTL_MS;
      if (!sessionSecret) {
        res.status(503).json({ ok: false, message: 'Portal sessions are not configured (PORTAL_SESSION_SECRET)' });
        return;
      }
      let credentials: PortalOperatorCredentials | null = null;
      try {
        credentials = operatorCredentialsFromConfig(config.portal);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Portal operator credential is misconfigured');
      }
      if (!credentials) {
        res.status(503).json({ ok: false, message: 'Password sign-in is not configured (PORTAL_OPERATOR_USERNAME / PORTAL_OPERATOR_PASSWORD_HASH)' });
        return;
      }

      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { username?: unknown; password?: unknown };
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const ip = extractClientIp(req);
      const key = lockoutKey(ip, username);
      const now = Date.now();
      const until = lockedUntil(key, now);
      if (until > 0) {
        recordPortalAuthAudit(req, credentials.scope, 'failure', 'password_locked_out', { method: 'password' });
        res.setHeader('Retry-After', Math.max(1, Math.ceil((until - now) / 1000)));
        res.status(429).json({ ok: false, message: 'Too many failed sign-ins. Try again later.' });
        return;
      }

      // Both checks always run so a wrong username costs the same time as a wrong password.
      const usernameOk = portalUsernameMatches(credentials.username, username);
      const passwordOk = verifyPortalPassword(password, credentials.passwordHash);
      if (!usernameOk || !passwordOk) {
        recordFailure(key, now);
        recordPortalAuthAudit(req, credentials.scope, 'failure', 'password_rejected', { method: 'password' });
        logger.warn({ ip }, 'Portal password sign-in rejected');
        res.status(401).json({ ok: false, message: 'Invalid username or password' });
        return;
      }

      lockouts.delete(key);
      const ttlMs = Math.min(DEFAULT_SESSION_TTL_MS, sessionMaxAgeMs);
      const minted = mintPortalSessionToken({
        secret: sessionSecret,
        actorHint: credentials.actor,
        scope: credentials.scope,
        ttlMs,
        maxAgeMs: sessionMaxAgeMs,
      });
      res.setHeader('Set-Cookie', buildSessionCookie(minted.token, ttlMs / 1000, requestIsSecure(req)));
      res.setHeader('Cache-Control', 'no-store');
      recordPortalAuthAudit(req, credentials.scope, 'success', 'password', { method: 'password', actor: minted.actor });
      logger.info({ scope: credentials.scope, actor: minted.actor, expiresAt: new Date(minted.expiresAt).toISOString() }, 'Portal session created (password)');
      res.json({
        ok: true,
        method: 'password',
        scope: credentials.scope,
        actor: minted.actor,
        expiresAt: new Date(minted.expiresAt).toISOString(),
        csrf: computePortalCsrfToken(sessionSecret, minted.token),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: password sign-in failed');
    }
  });
}
