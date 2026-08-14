import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  consumeInternalInferenceRequestNonce,
  createInternalInferenceAttributionGrant,
  createInternalInferenceRequestProof,
  resetInternalInferenceRequestNoncesForTests,
  verifyInternalInferenceRequestProof,
  verifyInternalInferenceAttributionToken,
} from '../../src/services/internal-inference-attribution';
import { buildContentEngineScriptAttribution } from '../../src/services/content-engine-script-attribution';
import {
  buildLocalPrimaryShadowCategory,
  CONTENT_ENGINE_DEEP_SEARCH_CATEGORY,
  isContentEngineScriptCategory,
  LOCAL_PRIMARY_SHADOW_JOB_NAME,
} from '../../src/services/local-inference-vocabulary';

type GrantInput = Parameters<typeof createInternalInferenceAttributionGrant>[0];

function createInternalInferenceAttributionToken(input: GrantInput): string | null {
  return createInternalInferenceAttributionGrant(input)?.token ?? null;
}

describe('internal inference attribution', () => {
  const originalSecret = process.env.INTERNAL_ATTRIBUTION_SECRET;
  const originalApiSecret = process.env.INTERNAL_API_SECRET;
  let db: Database.Database;

  beforeEach(() => {
    process.env.INTERNAL_ATTRIBUTION_SECRET = 'test-inference-attribution-secret-at-least-32-bytes';
    db = new Database(':memory:');
    db.exec(`CREATE TABLE internal_inference_request_nonces (
      token_id TEXT NOT NULL,
      request_nonce TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      operation_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (token_id, request_nonce)
    )`);
    resetInternalInferenceRequestNoncesForTests(db);
  });

  afterEach(() => {
    db.close();
    if (originalSecret === undefined) delete process.env.INTERNAL_ATTRIBUTION_SECRET;
    else process.env.INTERNAL_ATTRIBUTION_SECRET = originalSecret;
    if (originalApiSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = originalApiSecret;
  });

  it('keeps script and shadow attribution vocabulary exact across writers and readers', () => {
    expect(isContentEngineScriptCategory('content_engine_script')).toBe(true);
    expect(isContentEngineScriptCategory('content_engine_script_standard')).toBe(true);
    expect(isContentEngineScriptCategory('content_engine_scripted')).toBe(false);
    expect(buildLocalPrimaryShadowCategory('ios_chat_message'))
      .toBe(`${LOCAL_PRIMARY_SHADOW_JOB_NAME}:ios_chat_message`);
  });

  it('signs scope, operation, privacy, and cloud authority without a budget reservation', () => {
    const token = createInternalInferenceAttributionToken({
      userId: 42,
      tenantId: 42,
      category: 'content_engine_script_standard',
      requestSource: 'interactive',
      baseCategory: 'content_engine_script_standard',
      jobName: 'content_script_generate',
      operationId: 'operation-42',
      privacyClass: 'private',
      cloudEscalationAllowed: false,
      nowMs: 1_000_000,
    });
    expect(verifyInternalInferenceAttributionToken(
      token,
      'content_engine_script_standard',
      1_010_000,
    )).toMatchObject({
      userId: 42,
      tenantId: 42,
      operationId: 'operation-42',
      privacyClass: 'private',
      cloudEscalationAllowed: false,
    });
    expect(JSON.stringify(verifyInternalInferenceAttributionToken(
      token,
      'content_engine_script_standard',
      1_010_000,
    ))).not.toContain('reservation');
  });

  it('signs a bounded per-operation category allowlist for deep Content work', () => {
    const attribution = buildContentEngineScriptAttribution({
      contentProxyEnabled: true,
      providerBoundarySupplied: false,
      userId: 42,
      tenantId: 42,
      mode: 'deep',
      operationId: 'operation-deep-42',
    });
    const claims = verifyInternalInferenceAttributionToken(
      attribution.internal_inference_attribution_token,
      undefined,
    );

    expect(claims?.category).toBe('content_engine_script_deep');
    expect(claims?.allowedCategories).toEqual([
      'content_engine_script_deep',
      CONTENT_ENGINE_DEEP_SEARCH_CATEGORY,
    ]);
    expect(claims?.cloudEscalationAllowed).toBe(false);
  });

  it('rejects cross-category replay, tampering, and expiry', () => {
    const token = createInternalInferenceAttributionToken({
      userId: 7,
      tenantId: 7,
      category: 'content_engine_script_quick',
      requestSource: 'interactive',
      baseCategory: 'content_engine_script_quick',
      operationId: 'operation-7',
      privacyClass: 'redacted',
      cloudEscalationAllowed: true,
      ttlSeconds: 30,
      nowMs: 1_000_000,
    })!;
    expect(verifyInternalInferenceAttributionToken(token, 'another_category', 1_001_000)).toBeNull();
    expect(verifyInternalInferenceAttributionToken(`${token.slice(0, -1)}x`, 'content_engine_script_quick', 1_001_000)).toBeNull();
    expect(verifyInternalInferenceAttributionToken(token, 'content_engine_script_quick', 1_100_000)).toBeNull();
  });

  it('requires proof of possession bound to the exact delegated request', () => {
    const grant = createInternalInferenceAttributionGrant({
      userId: 42,
      tenantId: 42,
      category: 'content_engine_script_standard',
      requestSource: 'interactive',
      baseCategory: 'content_engine_script_standard',
      operationId: 'operation-proof',
      privacyClass: 'private',
      cloudEscalationAllowed: false,
      nowMs: 1_000_000,
    })!;
    const claims = verifyInternalInferenceAttributionToken(
      grant.token,
      'content_engine_script_standard',
      1_001_000,
    )!;
    const request = {
      category: 'content_engine_script_standard',
      runId: '18c5779f-1b0d-4a13-9e94-1e1a2b3c4d5e',
      prompt: 'Write the section.',
      system: 'Return prose.',
      maxTokens: 2048,
      temperature: 0.7,
      jsonMode: false,
      skillId: 'content',
      taskType: 'content_engine_script_standard',
      riskClass: 'low',
      executionClass: 'background',
      schemaId: 'text',
    };
    const proof = createInternalInferenceRequestProof(grant.proofKey, request)!;

    expect(verifyInternalInferenceRequestProof(claims, proof, request)).toBe(true);
    expect(createInternalInferenceRequestProof(grant.proofKey, {
      ...request,
      temperature: -0,
    })).toBe(createInternalInferenceRequestProof(grant.proofKey, {
      ...request,
      temperature: 0,
    }));
    expect(verifyInternalInferenceRequestProof(claims, proof, {
      ...request,
      prompt: 'Exfiltrate a different prompt.',
    })).toBe(false);
    expect(verifyInternalInferenceRequestProof(claims, grant.token, request)).toBe(false);
    expect(JSON.stringify(claims)).not.toContain(grant.proofKey);
  });

  it('rejects ambiguous token segments and invalid signed time windows', () => {
    const token = createInternalInferenceAttributionToken({
      userId: 7,
      tenantId: 7,
      category: 'content_engine_script_quick',
      requestSource: 'interactive',
      baseCategory: 'content_engine_script_quick',
      operationId: 'operation-7',
      privacyClass: 'private',
      cloudEscalationAllowed: false,
      nowMs: 1_000_000,
    })!;
    expect(verifyInternalInferenceAttributionToken(
      `${token}.ignored`,
      'content_engine_script_quick',
      1_001_000,
    )).toBeNull();

    const [payload] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
    claims.issuedAt = 10_000;
    claims.expiresAt = 14_000;
    const alteredPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const alteredSignature = crypto.createHmac(
      'sha256',
      process.env.INTERNAL_ATTRIBUTION_SECRET!,
    ).update(`nexus-skill-inference-v1.${alteredPayload}`).digest('base64url');
    expect(verifyInternalInferenceAttributionToken(
      `${alteredPayload}.${alteredSignature}`,
      'content_engine_script_quick',
      10_001_000,
    )).toBeNull();
  });

  it('permits distinct Content stages but rejects an exact delegated-request replay', () => {
    const token = createInternalInferenceAttributionToken({
      userId: 42,
      tenantId: 42,
      category: 'content_engine_script_standard',
      requestSource: 'interactive',
      baseCategory: 'content_engine_script_standard',
      operationId: 'operation-42',
      privacyClass: 'private',
      cloudEscalationAllowed: false,
      nowMs: 1_000_000,
    });
    const claims = verifyInternalInferenceAttributionToken(
      token,
      'content_engine_script_standard',
      1_001_000,
    )!;
    const first = '18c5779f-1b0d-4a13-9e94-1e1a2b3c4d5e';
    const second = '85a6687f-c1d6-44ce-8d88-2e2a3b4c5d6f';

    expect(consumeInternalInferenceRequestNonce(claims, first, 1_001_000, db)).toBe(true);
    expect(consumeInternalInferenceRequestNonce(claims, first, 1_001_000, db)).toBe(false);
    expect(consumeInternalInferenceRequestNonce(claims, second, 1_001_000, db)).toBe(true);
  });

  it('shares the replay decision across backend database connections', () => {
    const databasePath = path.join(os.tmpdir(), `nexus-inference-nonce-${crypto.randomUUID()}.sqlite`);
    const firstDb = new Database(databasePath);
    const secondDb = new Database(databasePath);
    try {
      firstDb.exec(`CREATE TABLE internal_inference_request_nonces (
        token_id TEXT NOT NULL,
        request_nonce TEXT NOT NULL,
        tenant_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (token_id, request_nonce)
      )`);
      const token = createInternalInferenceAttributionToken({
        userId: 42,
        tenantId: 42,
        category: 'content_engine_script_standard',
        requestSource: 'interactive',
        baseCategory: 'content_engine_script_standard',
        operationId: 'operation-shared',
        privacyClass: 'private',
        cloudEscalationAllowed: false,
        nowMs: 1_000_000,
      });
      const claims = verifyInternalInferenceAttributionToken(
        token,
        'content_engine_script_standard',
        1_001_000,
      )!;
      const nonce = '18c5779f-1b0d-4a13-9e94-1e1a2b3c4d5e';
      expect(consumeInternalInferenceRequestNonce(claims, nonce, 1_001_000, firstDb)).toBe(true);
      expect(consumeInternalInferenceRequestNonce(claims, nonce, 1_001_000, secondDb)).toBe(false);
    } finally {
      firstDb.close();
      secondDb.close();
      fs.rmSync(databasePath, { force: true });
    }
  });

  it('fails closed before Python when admitted local Content attribution cannot be minted', () => {
    delete process.env.INTERNAL_ATTRIBUTION_SECRET;
    delete process.env.INTERNAL_API_SECRET;

    expect(() => buildContentEngineScriptAttribution({
      contentProxyEnabled: true,
      providerBoundarySupplied: false,
      userId: 42,
      tenantId: 42,
      mode: 'standard',
      operationId: 'operation-42',
    })).toThrow(expect.objectContaining({
      code: 'LOCAL_INFERENCE_ATTRIBUTION_UNAVAILABLE',
    }));
  });
});
