// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';

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

type PortalTokenScope = 'read' | 'write' | 'admin';
export type PortalCredentialKind = 'legacy' | 'read' | 'write' | 'admin' | 'local_bypass';

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
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 120) return undefined;
  if (/[\r\n\t]/.test(trimmed)) return undefined;
  if (!/^[A-Za-z0-9@._:+-]+$/.test(trimmed)) return undefined;
  return trimmed;
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
    const message = scope === 'admin'
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
