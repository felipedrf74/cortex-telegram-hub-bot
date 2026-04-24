// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';

export type PortalTokenScope = 'read' | 'write' | 'admin';

export interface PortalSessionPayload {
  v: 1;
  actor: string;
  scope: PortalTokenScope;
  iat: number;
  exp: number;
  jti?: string;
}

export const PORTAL_SESSION_PREFIX = 'ps_';

export function sanitizePortalActorHint(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 120) return undefined;
  if (/[\r\n\t]/.test(trimmed)) return undefined;
  if (!/^[A-Za-z0-9@._:+-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

export function isPortalTokenScope(value: unknown): value is PortalTokenScope {
  return value === 'read' || value === 'write' || value === 'admin';
}

export function portalScopeRank(scope: PortalTokenScope): number {
  if (scope === 'admin') return 3;
  if (scope === 'write') return 2;
  return 1;
}

export function portalSessionScopeSatisfies(
  sessionScope: PortalTokenScope,
  requiredScope: PortalTokenScope,
): boolean {
  return portalScopeRank(sessionScope) >= portalScopeRank(requiredScope);
}

export function signPortalSessionPayload(secret: string, encodedPayload: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');
}

export function createPortalSessionToken(options: {
  secret: string;
  actorHint: string;
  scope: PortalTokenScope;
  ttlMs: number;
  nowMs?: number;
  jti?: string;
}): string {
  const { secret, actorHint, scope, ttlMs, nowMs = Date.now(), jti } = options;
  const actor = sanitizePortalActorHint(actorHint);
  if (!secret) throw new Error('Portal session secret is required');
  if (!actor) throw new Error('Valid portal actor is required');
  if (!isPortalTokenScope(scope)) throw new Error('Valid portal session scope is required');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Valid portal session ttl is required');

  const payload: PortalSessionPayload = {
    v: 1,
    actor,
    scope,
    iat: nowMs,
    exp: nowMs + ttlMs,
    ...(jti ? { jti } : {}),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signPortalSessionPayload(secret, encodedPayload);
  return `${PORTAL_SESSION_PREFIX}${encodedPayload}.${signature}`;
}
