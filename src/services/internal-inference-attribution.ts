// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AiRequestSource } from './api-usage-attribution';
import { getDb } from './database';

const AUDIENCE = 'nexus-skill-inference-v1';

export interface InternalInferenceAttributionClaims {
  audience: typeof AUDIENCE;
  tokenId: string;
  userId: number;
  tenantId: number;
  category: string;
  allowedCategories: string[];
  requestSource: AiRequestSource;
  baseCategory: string;
  jobName: string | null;
  operationId: string;
  privacyClass: 'public' | 'private' | 'redacted';
  cloudEscalationAllowed: boolean;
  proofKeyEnvelope: string;
  issuedAt: number;
  expiresAt: number;
}

export interface VerifiedInternalInferenceAttributionClaims
  extends InternalInferenceAttributionClaims {
  /** Decrypted only inside the trusted TS boundary; never serialized. */
  proofKey: string;
}

export interface InternalInferenceAttributionGrant {
  token: string;
  /** Passed to the Content Engine separately and used only to MAC requests. */
  proofKey: string;
}

const MAX_TRACKED_REQUEST_NONCES = 100_000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function signingSecret(): string {
  return process.env.INTERNAL_ATTRIBUTION_SECRET || process.env.INTERNAL_API_SECRET || '';
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`${AUDIENCE}.${payload}`).digest('base64url');
}

function proofEnvelopeKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(`${AUDIENCE}.proof-envelope.${secret}`).digest();
}

function encryptProofKey(proofKey: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', proofEnvelopeKey(secret), iv);
  cipher.setAAD(Buffer.from(AUDIENCE, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(proofKey, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString('base64url')).join('.');
}

function decryptProofKey(envelope: string, secret: string): string | null {
  try {
    const parts = envelope.split('.');
    if (parts.length !== 3) return null;
    const [ivPart, tagPart, encryptedPart] = parts;
    const iv = Buffer.from(ivPart!, 'base64url');
    const tag = Buffer.from(tagPart!, 'base64url');
    const encrypted = Buffer.from(encryptedPart!, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', proofEnvelopeKey(secret), iv);
    decipher.setAAD(Buffer.from(AUDIENCE, 'utf8'));
    decipher.setAuthTag(tag);
    const proofKey = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    return Buffer.from(proofKey, 'base64url').length === 32 ? proofKey : null;
  } catch {
    return null;
  }
}

function positiveId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function bounded(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Mint identity and operation attribution plus its independently transported
 * proof key. There is deliberately no token-only minting API: a caller must
 * possess the request-bound MAC key before it can delegate work to Python.
 * This grant never represents cloud budget approval.
 */
export function createInternalInferenceAttributionGrant(input: {
  userId: number;
  tenantId: number;
  category: string;
  additionalCategories?: readonly string[];
  requestSource: AiRequestSource;
  baseCategory: string;
  jobName?: string | null;
  operationId: string;
  privacyClass: 'public' | 'private' | 'redacted';
  cloudEscalationAllowed: boolean;
  ttlSeconds?: number;
  nowMs?: number;
}): InternalInferenceAttributionGrant | null {
  const secret = signingSecret();
  const userId = positiveId(input.userId);
  const tenantId = positiveId(input.tenantId);
  const category = bounded(input.category, 160);
  const baseCategory = bounded(input.baseCategory, 160);
  const jobName = bounded(input.jobName, 160) || null;
  const operationId = bounded(input.operationId, 160);
  const additionalCategories = Array.isArray(input.additionalCategories)
    ? input.additionalCategories
    : [];
  if (additionalCategories.length > 3) return null;
  const allowedCategories = [...new Set([
    category,
    ...additionalCategories.map((value) => bounded(value, 160)),
  ])];
  if (!secret || !userId || !tenantId || !category || !baseCategory || !operationId
      || allowedCategories.length > 4
      || allowedCategories.some((value) => !/^content_engine(?:_[a-z0-9]+)*$/u.test(value))) {
    return null;
  }
  const issuedAt = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const proofKey = crypto.randomBytes(32).toString('base64url');
  const claims: InternalInferenceAttributionClaims = {
    audience: AUDIENCE,
    tokenId: crypto.randomUUID(),
    userId,
    tenantId,
    category,
    allowedCategories,
    requestSource: input.requestSource,
    baseCategory,
    jobName,
    operationId,
    privacyClass: input.privacyClass,
    cloudEscalationAllowed: input.cloudEscalationAllowed,
    proofKeyEnvelope: encryptProofKey(proofKey, secret),
    issuedAt,
    expiresAt: issuedAt + Math.max(30, Math.min(input.ttlSeconds ?? 900, 3600)),
  };
  const payload = encode(claims);
  return { token: `${payload}.${sign(payload, secret)}`, proofKey };
}

export function verifyInternalInferenceAttributionToken(
  token: unknown,
  expectedCategory?: string,
  nowMs = Date.now(),
): VerifiedInternalInferenceAttributionClaims | null {
  if (typeof token !== 'string' || token.length < 20) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const secret = signingSecret();
  if (!payload || !signature || !secret) return null;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const tokenId = bounded(raw.tokenId, 64);
    const userId = positiveId(raw.userId);
    const tenantId = positiveId(raw.tenantId);
    const category = bounded(raw.category, 160);
    const allowedCategories = raw.allowedCategories === undefined
      ? [category]
      : Array.isArray(raw.allowedCategories)
        ? [...new Set(raw.allowedCategories.map((value) => bounded(value, 160)))]
        : [];
    const baseCategory = bounded(raw.baseCategory, 160);
    const jobName = bounded(raw.jobName, 160) || null;
    const operationId = bounded(raw.operationId, 160);
    const requestSource = raw.requestSource;
    const privacyClass = raw.privacyClass;
    const proofKeyEnvelope = bounded(raw.proofKeyEnvelope, 512);
    const issuedAt = Number(raw.issuedAt);
    const expiresAt = Number(raw.expiresAt);
    const nowSeconds = Math.floor(nowMs / 1000);
    if (raw.audience !== AUDIENCE || !UUID_V4_PATTERN.test(tokenId)
        || !userId || !tenantId
        || (expectedCategory !== undefined && category !== expectedCategory)
        || allowedCategories.length === 0 || allowedCategories.length > 4
        || !allowedCategories.includes(category)
        || allowedCategories.some((value) => !/^content_engine(?:_[a-z0-9]+)*$/u.test(value))
        || !baseCategory || !operationId
        || (requestSource !== 'interactive' && requestSource !== 'automation' && requestSource !== 'system')
        || (privacyClass !== 'public' && privacyClass !== 'private' && privacyClass !== 'redacted')
        || typeof raw.cloudEscalationAllowed !== 'boolean'
        || !proofKeyEnvelope
        || !Number.isSafeInteger(issuedAt)
        || !Number.isSafeInteger(expiresAt)
        || issuedAt > nowSeconds + 60
        || expiresAt <= nowSeconds
        || expiresAt <= issuedAt
        || expiresAt - issuedAt > 3600) {
      return null;
    }
    const proofKey = decryptProofKey(proofKeyEnvelope, secret);
    if (!proofKey) return null;
    const verified = {
      audience: AUDIENCE,
      tokenId,
      userId,
      tenantId,
      category,
      allowedCategories,
      requestSource,
      baseCategory,
      jobName,
      operationId,
      privacyClass,
      cloudEscalationAllowed: raw.cloudEscalationAllowed,
      proofKeyEnvelope,
      issuedAt,
      expiresAt,
    } as VerifiedInternalInferenceAttributionClaims;
    Object.defineProperty(verified, 'proofKey', {
      value: proofKey,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return verified;
  } catch {
    return null;
  }
}

function canonicalTemperature(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeDoubleBE(normalized, 0);
  return encoded.toString('hex');
}

function internalInferenceRequestProofPayload(input: {
  category: string;
  runId: string;
  prompt: string;
  system: string;
  maxTokens: number;
  temperature: number;
  jsonMode: boolean;
  skillId: string;
  taskType: string;
  riskClass: string;
  executionClass: string;
  schemaId: string;
}): string {
  const hash = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  return [
    AUDIENCE,
    input.category,
    input.runId,
    input.skillId,
    input.taskType,
    input.riskClass,
    input.executionClass,
    input.schemaId,
    String(input.maxTokens),
    canonicalTemperature(input.temperature),
    input.jsonMode ? 'true' : 'false',
    hash(input.prompt),
    hash(input.system),
  ].join('\n');
}

export function createInternalInferenceRequestProof(
  proofKey: string,
  input: Parameters<typeof internalInferenceRequestProofPayload>[0],
): string | null {
  const key = Buffer.from(proofKey, 'base64url');
  if (key.length !== 32) return null;
  return crypto.createHmac('sha256', key)
    .update(internalInferenceRequestProofPayload(input), 'utf8')
    .digest('base64url');
}

export function verifyInternalInferenceRequestProof(
  claims: VerifiedInternalInferenceAttributionClaims,
  proof: unknown,
  input: Parameters<typeof internalInferenceRequestProofPayload>[0],
): boolean {
  if (typeof proof !== 'string' || proof.length < 32 || proof.length > 128) return false;
  const expected = createInternalInferenceRequestProof(claims.proofKey, input);
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(proof);
  return expectedBytes.length === actualBytes.length
    && crypto.timingSafeEqual(expectedBytes, actualBytes);
}

/**
 * Consume one request nonce under a signed, short-lived delegation. The
 * Content Engine may perform multiple stages under one attribution token, but
 * an intercepted HTTP request cannot be replayed with the same run id. This
 * ledger is deliberately bounded and fail-closed; expiry is no longer than
 * the signed token's one-hour maximum lifetime. SQLite gives every backend
 * instance the same atomic replay decision.
 */
export function consumeInternalInferenceRequestNonce(
  claims: VerifiedInternalInferenceAttributionClaims,
  requestNonce: unknown,
  nowMs = Date.now(),
  db: Database.Database = getDb(),
): boolean {
  if (typeof requestNonce !== 'string'
      || !UUID_V4_PATTERN.test(requestNonce)) {
    return false;
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  try {
    return db.transaction(() => {
      db.prepare('DELETE FROM internal_inference_request_nonces WHERE expires_at <= ?')
        .run(nowSeconds);
      const count = db.prepare('SELECT COUNT(*) AS count FROM internal_inference_request_nonces')
        .get() as { count: number };
      if (Number(count.count) >= MAX_TRACKED_REQUEST_NONCES) return false;
      const inserted = db.prepare(`INSERT OR IGNORE INTO internal_inference_request_nonces (
        token_id, request_nonce, tenant_id, user_id, operation_id, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          claims.tokenId.toLowerCase(),
          requestNonce.toLowerCase(),
          claims.tenantId,
          claims.userId,
          claims.operationId,
          claims.expiresAt,
        );
      return inserted.changes === 1;
    }).immediate();
  } catch {
    return false;
  }
}

export function resetInternalInferenceRequestNoncesForTests(db?: Database.Database): void {
  if (!db) return;
  db.prepare('DELETE FROM internal_inference_request_nonces').run();
}
