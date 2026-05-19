// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';

export interface InternalAttributionClaims {
  userId: number;
  tenantId: number;
  category: string;
  issuedAt: number;
  expiresAt: number;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signingSecret(): string {
  return process.env.INTERNAL_ATTRIBUTION_SECRET
    || process.env.INTERNAL_API_SECRET
    || '';
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function normalizeId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

export function createInternalAttributionToken(input: {
  userId: number;
  tenantId: number;
  category: string;
  ttlSeconds?: number;
  nowMs?: number;
}): string | null {
  const userId = normalizeId(input.userId);
  const tenantId = normalizeId(input.tenantId);
  const category = input.category.trim();
  const secret = signingSecret();
  if (!userId || !tenantId || !category || !secret) return null;

  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const claims: InternalAttributionClaims = {
    userId,
    tenantId,
    category,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + Math.max(30, Math.min(input.ttlSeconds ?? 600, 3600)),
  };
  const payload = base64UrlEncode(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyInternalAttributionToken(token: unknown, expectedCategory: string, nowMs = Date.now()): InternalAttributionClaims | null {
  if (typeof token !== 'string' || token.length < 20) return null;
  const [payload, signature] = token.split('.');
  const secret = signingSecret();
  if (!payload || !signature || !secret) return null;

  const expected = sign(payload, secret);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
    return null;
  }

  try {
    const claims = JSON.parse(base64UrlDecode(payload)) as InternalAttributionClaims;
    const userId = normalizeId(claims.userId);
    const tenantId = normalizeId(claims.tenantId);
    const category = String(claims.category || '').trim();
    if (!userId || !tenantId || !category) return null;
    const expectedIsJsonRepair = expectedCategory === `${category}_json_repair`;
    if (category !== expectedCategory && !expectedIsJsonRepair) return null;
    if (!Number.isFinite(claims.expiresAt) || claims.expiresAt < Math.floor(nowMs / 1000)) return null;
    return { ...claims, userId, tenantId, category };
  } catch {
    return null;
  }
}
