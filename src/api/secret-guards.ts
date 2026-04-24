// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import {
  PORTAL_SESSION_PREFIX,
  createPortalSessionToken,
  isPortalTokenScope,
  portalSessionScopeSatisfies,
  sanitizePortalActorHint,
  signPortalSessionPayload,
  type PortalSessionPayload,
  type PortalTokenScope,
} from '../services/portal-session-token';

export { createPortalSessionToken };

const PORTAL_AUTH_CONTEXT_KEY = Symbol.for('nexushub.portalAuthContext');

function extractRemoteIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || '';
}

function isLoopbackIp(ip: string): boolean {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1'
  );
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(' ', 2);
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

export function secureSecretMatches(expected: string, provided: string | null | undefined): boolean {
  if (!expected || !provided) return false;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export function bearerTokenMatches(expected: string, authHeader: string | undefined): boolean {
  return secureSecretMatches(expected, extractBearerToken(authHeader));
}

export type PortalCredentialKind = 'legacy' | 'read' | 'write' | 'admin' | 'session' | 'local_bypass';

export interface PortalAuthContext {
  requiredScope: PortalTokenScope;
  matchedCredential: PortalCredentialKind;
  usingLegacyFallback: boolean;
  dedicatedAdminConfigured: boolean;
  actorHint?: string;
  actorRequired: boolean;
  actorAllowlistConfigured: boolean;
  actorSignatureRequired: boolean;
  actorSignatureVerified: boolean;
  sessionScope?: PortalTokenScope;
  sessionExpiresAt?: number;
  sessionSignatureVerified?: boolean;
}

interface PortalSessionMatch {
  actorHint: string;
  scope: PortalTokenScope;
  issuedAt: number;
  expiresAt: number;
}

function normalizePortalTokenCandidates(): {
  legacy: string;
  read: string;
  write: string;
  admin: string;
  adminRequireActor: boolean;
  adminActorAllowlist: readonly string[];
  adminActorSignatureSecret: string;
  adminActorSignatureToleranceMs: number;
  sessionSecret: string;
  sessionMaxAgeMs: number;
  requireSessionAuth: boolean;
  allowLegacyFallback: boolean;
} {
  return {
    legacy: config.portal.token || '',
    read: config.portal.readToken || '',
    write: config.portal.writeToken || '',
    admin: config.portal.adminToken || '',
    adminRequireActor: config.portal.adminRequireActor === true,
    adminActorAllowlist: Array.isArray(config.portal.adminActorAllowlist)
      ? config.portal.adminActorAllowlist
      : [],
    adminActorSignatureSecret: config.portal.adminActorSignatureSecret || '',
    adminActorSignatureToleranceMs: Number.isFinite(config.portal.adminActorSignatureToleranceMs)
      ? config.portal.adminActorSignatureToleranceMs
      : 300000,
    sessionSecret: config.portal.sessionSecret || '',
    sessionMaxAgeMs: Number.isFinite(config.portal.sessionMaxAgeMs)
      ? config.portal.sessionMaxAgeMs
      : 28800000,
    requireSessionAuth: config.portal.requireSessionAuth === true,
    allowLegacyFallback: config.portal.allowLegacyFallback === true,
  };
}

function scopedTokensConfigured(tokens: ReturnType<typeof normalizePortalTokenCandidates>): boolean {
  return Boolean(tokens.read || tokens.write || tokens.admin);
}

function legacyTokenUsable(tokens: ReturnType<typeof normalizePortalTokenCandidates>): boolean {
  if (!tokens.legacy) return false;
  if (!scopedTokensConfigured(tokens)) return true;
  return tokens.allowLegacyFallback;
}

function tokenConfigured(tokens: ReturnType<typeof normalizePortalTokenCandidates>, scope: PortalTokenScope): boolean {
  if (tokens.requireSessionAuth) return Boolean(tokens.sessionSecret);
  if (tokens.sessionSecret) return true;
  if (legacyTokenUsable(tokens)) return true;
  if (scope === 'read') return Boolean(tokens.read || tokens.write || tokens.admin);
  if (scope === 'write') return Boolean(tokens.write || tokens.admin);
  return Boolean(tokens.admin);
}

function authorizationMatchesScope(
  tokens: ReturnType<typeof normalizePortalTokenCandidates>,
  authHeader: string | undefined,
  scope: PortalTokenScope,
): PortalCredentialKind | null {
  if (legacyTokenUsable(tokens) && bearerTokenMatches(tokens.legacy, authHeader)) return 'legacy';
  if (scope === 'read') {
    if (tokens.read && bearerTokenMatches(tokens.read, authHeader)) return 'read';
    if (tokens.write && bearerTokenMatches(tokens.write, authHeader)) return 'write';
    if (tokens.admin && bearerTokenMatches(tokens.admin, authHeader)) return 'admin';
    return null;
  }
  if (scope === 'write') {
    if (tokens.write && bearerTokenMatches(tokens.write, authHeader)) return 'write';
    if (tokens.admin && bearerTokenMatches(tokens.admin, authHeader)) return 'admin';
    return null;
  }
  if (tokens.admin && bearerTokenMatches(tokens.admin, authHeader)) return 'admin';
  return null;
}

function resolvePortalScopeForMethod(method: string | undefined): PortalTokenScope {
  const normalized = (method || 'GET').toUpperCase();
  return normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS'
    ? 'read'
    : 'write';
}

function attachPortalAuthContext(req: Request, context: PortalAuthContext): void {
  (req as Request & { [PORTAL_AUTH_CONTEXT_KEY]?: PortalAuthContext })[PORTAL_AUTH_CONTEXT_KEY] = context;
}

export function extractPortalActorHint(req: Request): string | undefined {
  const raw = req.header('x-portal-actor')
    ?? req.header('x-admin-actor')
    ?? req.header('x-operator-email')
    ?? undefined;
  return sanitizePortalActorHint(raw);
}

function extractPortalActorSignature(req: Request): string | undefined {
  return req.header('x-portal-actor-signature')
    ?? req.header('x-admin-actor-signature')
    ?? req.header('x-operator-signature')
    ?? undefined;
}

function extractPortalActorTimestamp(req: Request): string | undefined {
  return req.header('x-portal-actor-timestamp')
    ?? req.header('x-admin-actor-timestamp')
    ?? req.header('x-operator-timestamp')
    ?? undefined;
}

function normalizePortalActorSignature(signature: string | undefined): string | undefined {
  if (!signature) return undefined;
  const trimmed = signature.trim();
  const value = trimmed.startsWith('sha256=') ? trimmed.slice('sha256='.length) : trimmed;
  if (!/^[a-fA-F0-9]{64}$/.test(value)) return undefined;
  return value.toLowerCase();
}

export function computePortalActorSignature(
  secret: string,
  actorHint: string,
  timestamp: string | number,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${actorHint}.${timestamp}`)
    .digest('hex');
}

export function verifyPortalActorSignature(options: {
  secret: string;
  actorHint?: string;
  timestamp?: string;
  signature?: string;
  toleranceMs: number;
  nowMs?: number;
}): boolean {
  const { secret, actorHint, timestamp, signature, toleranceMs, nowMs = Date.now() } = options;
  if (!secret || !actorHint || !timestamp || !signature) return false;

  const parsedTimestamp = Number(timestamp);
  if (!Number.isFinite(parsedTimestamp)) return false;
  if (Math.abs(nowMs - parsedTimestamp) > toleranceMs) return false;

  const normalizedSignature = normalizePortalActorSignature(signature);
  if (!normalizedSignature) return false;

  const expected = computePortalActorSignature(secret, actorHint, timestamp);
  return secureSecretMatches(expected, normalizedSignature);
}

function portalActorMatchesAllowlist(
  actorHint: string | undefined,
  allowlist: readonly string[],
): boolean {
  if (allowlist.length === 0) return Boolean(actorHint);
  if (!actorHint) return false;
  return allowlist.includes(actorHint.toLowerCase());
}

function extractPortalSessionToken(req: Request): string | undefined {
  const headerToken = req.header('x-portal-session')
    ?? req.header('x-admin-session')
    ?? undefined;
  if (headerToken?.trim()) return headerToken.trim();

  const bearerToken = extractBearerToken(req.headers.authorization);
  if (bearerToken?.startsWith(PORTAL_SESSION_PREFIX)) return bearerToken;

  const cookieHeader = req.header('cookie');
  if (!cookieHeader) return undefined;
  const sessionCookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('portal_session='));
  if (!sessionCookie) return undefined;

  const rawValue = sessionCookie.slice('portal_session='.length);
  try {
    return decodeURIComponent(rawValue);
  } catch {
    return rawValue;
  }
}

function verifyPortalSessionToken(options: {
  secret: string;
  token?: string;
  requiredScope: PortalTokenScope;
  actorAllowlist: readonly string[];
  maxAgeMs: number;
  nowMs?: number;
}): PortalSessionMatch | null {
  const {
    secret,
    token,
    requiredScope,
    actorAllowlist,
    maxAgeMs,
    nowMs = Date.now(),
  } = options;
  if (!secret || !token) return null;

  const trimmed = token.trim();
  if (!trimmed.startsWith(PORTAL_SESSION_PREFIX)) return null;
  const body = trimmed.slice(PORTAL_SESSION_PREFIX.length);
  const parts = body.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return null;

  const expectedSignature = signPortalSessionPayload(secret, encodedPayload);
  if (!secureSecretMatches(expectedSignature, signature)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const payload = parsed as Partial<PortalSessionPayload>;
  const actorHint = sanitizePortalActorHint(payload.actor);
  if (payload.v !== 1 || !actorHint || !isPortalTokenScope(payload.scope)) return null;
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return null;
  if (payload.iat! > nowMs + 60000) return null;
  if (payload.exp! <= nowMs) return null;
  if (payload.exp! - payload.iat! > maxAgeMs) return null;
  if (!portalSessionScopeSatisfies(payload.scope, requiredScope)) return null;
  if (requiredScope === 'admin' && !portalActorMatchesAllowlist(actorHint, actorAllowlist)) return null;

  return {
    actorHint,
    scope: payload.scope,
    issuedAt: payload.iat!,
    expiresAt: payload.exp!,
  };
}

function matchPortalSession(
  req: Request,
  tokens: ReturnType<typeof normalizePortalTokenCandidates>,
  scope: PortalTokenScope,
): PortalSessionMatch | null {
  return verifyPortalSessionToken({
    secret: tokens.sessionSecret,
    token: extractPortalSessionToken(req),
    requiredScope: scope,
    actorAllowlist: tokens.adminActorAllowlist,
    maxAgeMs: tokens.sessionMaxAgeMs,
  });
}

function enforcePortalToken(req: Request, res: Response, next: NextFunction, scope: PortalTokenScope): void {
  const tokens = normalizePortalTokenCandidates();
  if (!tokenConfigured(tokens, scope)) {
    if (allowLocalPortalBypass(req)) {
      attachPortalAuthContext(req, {
        requiredScope: scope,
        matchedCredential: 'local_bypass',
        usingLegacyFallback: false,
        dedicatedAdminConfigured: Boolean(tokens.admin),
        actorHint: extractPortalActorHint(req),
        actorRequired: false,
        actorAllowlistConfigured: tokens.adminActorAllowlist.length > 0,
        actorSignatureRequired: false,
        actorSignatureVerified: false,
      });
      next();
      return;
    }
    const message = tokens.requireSessionAuth
      ? 'Portal session secret not configured'
      : scope === 'admin'
      ? 'Portal admin token not configured'
      : scope === 'write'
        ? 'Portal write token not configured'
        : 'Portal token not configured';
    res.status(401).json({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message,
      },
    });
    return;
  }

  const sessionMatch = matchPortalSession(req, tokens, scope);
  if (sessionMatch) {
    attachPortalAuthContext(req, {
      requiredScope: scope,
      matchedCredential: 'session',
      usingLegacyFallback: false,
      dedicatedAdminConfigured: Boolean(tokens.admin),
      actorHint: sessionMatch.actorHint,
      actorRequired: true,
      actorAllowlistConfigured: tokens.adminActorAllowlist.length > 0,
      actorSignatureRequired: false,
      actorSignatureVerified: false,
      sessionScope: sessionMatch.scope,
      sessionExpiresAt: sessionMatch.expiresAt,
      sessionSignatureVerified: true,
    });
    next();
    return;
  }

  if (tokens.requireSessionAuth) {
    res.status(401).json({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal session',
      },
    });
    return;
  }

  const matchedCredential = authorizationMatchesScope(tokens, req.headers.authorization, scope);
  if (!matchedCredential) {
    const message = scope === 'admin'
      ? 'Invalid portal admin token'
      : scope === 'write'
        ? 'Invalid portal write token'
        : 'Invalid portal token';
    res.status(401).json({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message,
      },
    });
    return;
  }

  const actorHint = extractPortalActorHint(req);
  const actorSignatureRequired = scope === 'admin'
    && matchedCredential !== 'local_bypass'
    && Boolean(tokens.adminActorSignatureSecret);
  const actorRequired = scope === 'admin'
    && matchedCredential !== 'local_bypass'
    && (tokens.adminRequireActor || tokens.adminActorAllowlist.length > 0 || actorSignatureRequired);
  if (actorRequired && !portalActorMatchesAllowlist(actorHint, tokens.adminActorAllowlist)) {
    res.status(401).json({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: tokens.adminActorAllowlist.length > 0
          ? 'Invalid portal admin actor'
          : 'Portal admin actor required',
      },
    });
    return;
  }
  const actorSignatureVerified = actorSignatureRequired
    ? verifyPortalActorSignature({
      secret: tokens.adminActorSignatureSecret,
      actorHint,
      timestamp: extractPortalActorTimestamp(req),
      signature: extractPortalActorSignature(req),
      toleranceMs: tokens.adminActorSignatureToleranceMs,
    })
    : false;
  if (actorSignatureRequired && !actorSignatureVerified) {
    res.status(401).json({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal admin actor signature',
      },
    });
    return;
  }

  attachPortalAuthContext(req, {
    requiredScope: scope,
    matchedCredential,
    usingLegacyFallback: matchedCredential === 'legacy',
    dedicatedAdminConfigured: Boolean(tokens.admin),
    actorHint,
    actorRequired,
    actorAllowlistConfigured: tokens.adminActorAllowlist.length > 0,
    actorSignatureRequired,
    actorSignatureVerified,
  });
  next();
}

export function allowLocalPortalBypass(req: Request): boolean {
  if (!config.portal.allowLocalBypass) return false;
  return isLoopbackIp(extractRemoteIp(req));
}

export function allowLocalHealthBypass(req: Request): boolean {
  if (!config.health.allowUnauthenticatedDetailed) return false;
  return isLoopbackIp(extractRemoteIp(req));
}

export function requirePortalToken(req: Request, res: Response, next: NextFunction): void {
  enforcePortalToken(req, res, next, 'read');
}

export function requirePortalWriteToken(req: Request, res: Response, next: NextFunction): void {
  enforcePortalToken(req, res, next, 'write');
}

export function requirePortalAdminToken(req: Request, res: Response, next: NextFunction): void {
  enforcePortalToken(req, res, next, 'admin');
}

export function requirePortalTokenByMethod(req: Request, res: Response, next: NextFunction): void {
  enforcePortalToken(req, res, next, resolvePortalScopeForMethod(req.method));
}

export function isLoopbackRequest(req: Request): boolean {
  return isLoopbackIp(extractRemoteIp(req));
}

export function getPortalAuthContext(req: Request): PortalAuthContext | undefined {
  return (req as Request & { [PORTAL_AUTH_CONTEXT_KEY]?: PortalAuthContext })[PORTAL_AUTH_CONTEXT_KEY];
}
