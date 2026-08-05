// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { assertStrongIosJwtSecret } from './ios-jwt';
import { fingerprintTrainingPlanGenerationRequest } from './training-plan-generation-idempotency';

const TOKEN_VERSION = 1 as const;
const TOKEN_TTL_SECONDS = 15 * 60;
const MAX_TOKEN_LENGTH = 2_048;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface TrainingPlanPreviewTokenPayload {
  v: typeof TOKEN_VERSION;
  userId: number;
  tenantId: number;
  contextFingerprint: string;
  candidateFingerprint: string;
  iat: number;
  exp: number;
}

export interface SignTrainingPlanPreviewTokenInput {
  userId: number;
  tenantId: number;
  contextFingerprint: string;
  candidateFingerprint: string;
  now?: Date;
}

export type TrainingPlanPreviewTokenValidation =
  | { ok: true; payload: TrainingPlanPreviewTokenPayload }
  | {
      ok: false;
      code: 'missing_token' | 'invalid_token' | 'expired_token' | 'wrong_scope';
    };

export class TrainingPlanPreviewStaleError extends Error {
  readonly code = 'TRAINING_PLAN_PREVIEW_STALE';
  readonly reason: 'candidate_changed';

  constructor(reason: 'candidate_changed' = 'candidate_changed') {
    super('The finalized Training plan no longer matches the reviewed preview');
    this.name = 'TrainingPlanPreviewStaleError';
    this.reason = reason;
  }
}

/**
 * Fingerprint the complete finalized candidate plus the exact preview
 * semantics shown to the athlete. The signed token carries only this digest,
 * never profile values, notes, calendar contents, or workout prose.
 */
export function fingerprintTrainingPlanPreviewCandidate(candidate: unknown): string {
  return fingerprintTrainingPlanGenerationRequest({
    contract: 'training_plan_preview_candidate.v1',
    candidate,
  });
}

export function signTrainingPlanPreviewToken(
  input: SignTrainingPlanPreviewTokenInput,
): string {
  assertScopeId(input.userId, 'userId');
  assertScopeId(input.tenantId, 'tenantId');
  assertFingerprint(input.contextFingerprint, 'contextFingerprint');
  assertFingerprint(input.candidateFingerprint, 'candidateFingerprint');

  const iat = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  if (!Number.isFinite(iat)) throw new Error('Invalid training plan preview token time');
  const payload: TrainingPlanPreviewTokenPayload = {
    v: TOKEN_VERSION,
    userId: input.userId,
    tenantId: input.tenantId,
    contextFingerprint: input.contextFingerprint,
    candidateFingerprint: input.candidateFingerprint,
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
  };
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadSegment}.${signPayload(payloadSegment)}`;
}

export function validateTrainingPlanPreviewToken(
  token: string | null | undefined,
  expected: { userId: number; tenantId: number; now?: Date },
): TrainingPlanPreviewTokenValidation {
  const normalized = typeof token === 'string' ? token.trim() : '';
  if (!normalized) return { ok: false, code: 'missing_token' };
  if (normalized.length > MAX_TOKEN_LENGTH) return { ok: false, code: 'invalid_token' };

  const [payloadSegment, signature, extra] = normalized.split('.');
  if (!payloadSegment || !signature || extra != null) {
    return { ok: false, code: 'invalid_token' };
  }
  const expectedSignature = signPayload(payloadSegment);
  const signatureBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expectedSignature);
  if (signatureBytes.length !== expectedBytes.length
    || !timingSafeEqual(signatureBytes, expectedBytes)) {
    return { ok: false, code: 'invalid_token' };
  }

  let payload: TrainingPlanPreviewTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadSegment, 'base64url').toString('utf8'),
    ) as TrainingPlanPreviewTokenPayload;
  } catch {
    return { ok: false, code: 'invalid_token' };
  }

  if (!isValidPayload(payload)) return { ok: false, code: 'invalid_token' };
  if (payload.userId !== expected.userId || payload.tenantId !== expected.tenantId) {
    return { ok: false, code: 'wrong_scope' };
  }
  const nowSeconds = Math.floor((expected.now ?? new Date()).getTime() / 1_000);
  if (!Number.isFinite(nowSeconds) || payload.exp <= nowSeconds) {
    return { ok: false, code: 'expired_token' };
  }
  return { ok: true, payload };
}

function isValidPayload(payload: TrainingPlanPreviewTokenPayload): boolean {
  return payload?.v === TOKEN_VERSION
    && Number.isInteger(payload.userId)
    && payload.userId > 0
    && Number.isInteger(payload.tenantId)
    && payload.tenantId > 0
    && SHA256_HEX.test(payload.contextFingerprint)
    && SHA256_HEX.test(payload.candidateFingerprint)
    && Number.isInteger(payload.iat)
    && Number.isInteger(payload.exp)
    && payload.exp > payload.iat
    && payload.exp - payload.iat === TOKEN_TTL_SECONDS;
}

function signPayload(payloadSegment: string): string {
  return createHmac('sha256', previewTokenSecret())
    .update(payloadSegment)
    .digest('base64url');
}

function previewTokenSecret(): string {
  const configured = process.env.TRAINING_PLAN_PREVIEW_HMAC_SECRET
    || process.env.CHAT_CONFIRMATION_HMAC_SECRET
    || process.env.IOS_API_JWT_SECRET
    || config.ios.jwtSecret;
  if (configured) {
    return assertStrongIosJwtSecret(configured, 'TRAINING_PLAN_PREVIEW_HMAC_SECRET');
  }
  if (process.env.NODE_ENV === 'test') {
    return assertStrongIosJwtSecret(
      'test-training-plan-preview-token-secret-0000000000000000',
      'TRAINING_PLAN_PREVIEW_HMAC_SECRET',
    );
  }
  throw new Error(
    'TRAINING_PLAN_PREVIEW_HMAC_SECRET or IOS_API_JWT_SECRET is required to sign Training preview tokens',
  );
}

function assertScopeId(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid training plan preview token ${field}`);
  }
}

function assertFingerprint(value: string, field: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new Error(`Invalid training plan preview token ${field}`);
  }
}
