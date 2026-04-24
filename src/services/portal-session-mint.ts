// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  createPortalSessionToken,
  isPortalTokenScope,
  sanitizePortalActorHint,
  type PortalTokenScope,
} from './portal-session-token';

export interface PortalSessionMintResult {
  token: string;
  actor: string;
  scope: PortalTokenScope;
  issuedAt: number;
  expiresAt: number;
  ttlMs: number;
  maxAgeMs: number;
  jti?: string;
}

export function mintPortalSessionToken(options: {
  secret: string;
  actorHint: string;
  scope: string;
  ttlMs: number;
  maxAgeMs: number;
  nowMs?: number;
  jti?: string;
}): PortalSessionMintResult {
  const {
    secret,
    actorHint,
    scope,
    ttlMs,
    maxAgeMs,
    nowMs = Date.now(),
    jti,
  } = options;
  const actor = sanitizePortalActorHint(actorHint);
  if (!secret) throw new Error('PORTAL_SESSION_SECRET is required to mint portal sessions');
  if (!actor) throw new Error('A valid --actor value is required');
  if (!isPortalTokenScope(scope)) {
    throw new Error('A valid --scope value is required: read, write, or admin');
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('A positive --ttl-ms value is required');
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error('PORTAL_SESSION_MAX_AGE_MS must be positive');
  }
  if (ttlMs > maxAgeMs) {
    throw new Error(`Requested ttl ${ttlMs}ms exceeds PORTAL_SESSION_MAX_AGE_MS ${maxAgeMs}ms`);
  }

  const token = createPortalSessionToken({
    secret,
    actorHint: actor,
    scope,
    ttlMs,
    nowMs,
    jti,
  });

  return {
    token,
    actor,
    scope,
    issuedAt: nowMs,
    expiresAt: nowMs + ttlMs,
    ttlMs,
    maxAgeMs,
    ...(jti ? { jti } : {}),
  };
}
