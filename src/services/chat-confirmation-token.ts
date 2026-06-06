// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { config } from '../config';

export interface ChatConfirmationTokenPayload {
  v: 1;
  pendingId: string;
  userId: number;
  tenantId: number;
  intentClass: string;
  sourceMessageId?: string | null;
  exp: number;
  iat: number;
}

export type ChatConfirmationTokenValidation =
  | { ok: true; payload: ChatConfirmationTokenPayload }
  | { ok: false; code: 'missing_token' | 'invalid_token' | 'expired_token' | 'wrong_scope' | 'wrong_intent' };

export interface SignChatConfirmationTokenInput {
  pendingId: string;
  userId: number;
  tenantId: number;
  intentClass: string;
  expiresAt: string;
  sourceMessageId?: string | null;
  now?: Date;
}

function secret(): string {
  const configured = process.env.IOS_API_JWT_SECRET || config.ios.jwtSecret;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'test') return 'test-chat-confirmation-token-secret';
  throw new Error('IOS_API_JWT_SECRET is required to sign chat confirmation tokens');
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signPayload(payloadSegment: string): string {
  return crypto
    .createHmac('sha256', secret())
    .update(payloadSegment)
    .digest('base64url');
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

export function signChatConfirmationToken(input: SignChatConfirmationTokenInput): string {
  const exp = Math.floor(new Date(input.expiresAt).getTime() / 1000);
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const payload: ChatConfirmationTokenPayload = {
    v: 1,
    pendingId: input.pendingId,
    userId: input.userId,
    tenantId: input.tenantId,
    intentClass: input.intentClass,
    sourceMessageId: input.sourceMessageId ?? null,
    exp,
    iat: now,
  };
  const payloadSegment = base64urlJson(payload);
  return `${payloadSegment}.${signPayload(payloadSegment)}`;
}

export function validateChatConfirmationToken(
  token: string | null | undefined,
  expected: {
    userId: number;
    tenantId: number;
    intentClass?: string | null;
    now?: Date;
  },
): ChatConfirmationTokenValidation {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (!trimmed) return { ok: false, code: 'missing_token' };
  const [payloadSegment, signature, extra] = trimmed.split('.');
  if (!payloadSegment || !signature || extra != null) return { ok: false, code: 'invalid_token' };
  if (!timingSafeEqual(signature, signPayload(payloadSegment))) return { ok: false, code: 'invalid_token' };

  let payload: ChatConfirmationTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as ChatConfirmationTokenPayload;
  } catch {
    return { ok: false, code: 'invalid_token' };
  }

  if (payload.v !== 1 || typeof payload.pendingId !== 'string' || typeof payload.intentClass !== 'string') {
    return { ok: false, code: 'invalid_token' };
  }
  if (payload.userId !== expected.userId || payload.tenantId !== expected.tenantId) {
    return { ok: false, code: 'wrong_scope' };
  }
  if (expected.intentClass && payload.intentClass !== expected.intentClass) {
    return { ok: false, code: 'wrong_intent' };
  }
  const now = Math.floor((expected.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= now) {
    return { ok: false, code: 'expired_token' };
  }
  return { ok: true, payload };
}

export function hashChatConfirmationToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
