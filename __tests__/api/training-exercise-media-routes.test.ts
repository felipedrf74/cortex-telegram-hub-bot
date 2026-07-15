// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import http from 'node:http';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTrainingExerciseMediaRoutes } from '../../src/api/routes/training-exercise-media-routes';
import { lookupTrainingExerciseMedia } from '../../src/services/training-exercise-media';
import { recordTrainingMediaLookupObservations } from '../../src/services/training-learning-producers';
import type { UserEntitlement } from '../../src/services/entitlement';
import { runMigrationsForTest } from '../../src/services/database';
import { seedApprovedExerciseMedia } from '../fixtures/training-exercise-media';

function entitlement(userId: number): UserEntitlement {
  return {
    userId,
    plan: 'pro',
    source: 'stripe',
    status: 'active',
    subscriptionStatus: 'active',
    subscriptionProvider: 'stripe',
    subscriptionExpiresAt: null,
    isFounder: false,
    isOwner: false,
    isTrial: false,
    dailyCostCapUsd: 1,
    monthlyCostCapUsd: 1,
    billingPeriodStart: '2026-07-01T00:00:00.000Z',
    billingPeriodEnd: '2026-08-01T00:00:00.000Z',
    aiAccessAllowed: true,
    automationAllowed: false,
    nexusPointsAllowed: true,
    blockReason: null,
    automationBlockReason: null,
    allowedSkills: new Set(['training']),
    evaluatedAt: '2026-07-12T00:00:00.000Z',
  };
}

function ineligibleEntitlement(userId: number): UserEntitlement {
  return {
    ...entitlement(userId),
    plan: 'free',
    source: 'free',
    aiAccessAllowed: false,
    nexusPointsAllowed: false,
    blockReason: 'plan_required',
    allowedSkills: new Set(['secretary']),
  };
}

function goldenEnvelope(filename: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(
    path.resolve(process.cwd(), '__tests__/fixtures', filename),
    'utf8',
  )) as Record<string, unknown>;
}

function normalizedTimestamp(
  actual: Record<string, unknown>,
  golden: Record<string, unknown>,
): Record<string, unknown> {
  return { ...actual, timestamp: golden.timestamp };
}

describe('Training exercise media API contracts', () => {
  let db: Database.Database;
  let server: http.Server;
  let baseUrl: string;
  let env: NodeJS.ProcessEnv;
  let lookup: ReturnType<typeof vi.fn<typeof lookupTrainingExerciseMedia>>;
  let recordLearning: ReturnType<typeof vi.fn<typeof recordTrainingMediaLookupObservations>>;
  let resolveEntitlement: ReturnType<typeof vi.fn<(userId: number) => UserEntitlement>>;

  beforeEach(async () => {
    db = createMigratedTestDatabase();
    seedApprovedExerciseMedia(db, { alias: 'press_up' });
    env = { TRAINING_EXERCISE_MEDIA_V1_ENABLED: 'true' };
    lookup = vi.fn((tenantId, userId, ids, locale) => lookupTrainingExerciseMedia(
      tenantId, userId, ids, locale,
      { db, now: new Date('2026-07-12T12:00:00.000Z'), expectedExerciseIds: ['push_up'] },
    ));
    recordLearning = vi.fn((input) => recordTrainingMediaLookupObservations(input, db));
    resolveEntitlement = vi.fn((userId: number) => (
      userId === 9 ? ineligibleEntitlement(userId) : entitlement(userId)
    ));
    const app = express();
    app.use((req, _res, next) => {
      const userId = Number(req.header('x-test-user') ?? 7);
      (req as any).userId = userId;
      (req as any).tenantId = Number(req.header('x-test-tenant') ?? userId);
      if (req.header('x-test-entitled') !== 'false') (req as any).entitlement = entitlement(userId);
      next();
    });
    const router = Router();
    registerTrainingExerciseMediaRoutes(router, { env, lookup, resolveEntitlement, recordLearning });
    app.use(router);
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  it('does not resolve entitlement or touch the media catalog after the scope-aware feature-off check', async () => {
    env.TRAINING_EXERCISE_MEDIA_V1_ENABLED = 'false';
    const response = await fetch(`${baseUrl}/exercises?ids=push_up`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(lookup).not.toHaveBeenCalled();
    expect(resolveEntitlement).not.toHaveBeenCalled();
  });

  it('fails closed with the same hidden 404 for missing entitlement or mismatched tenant scope', async () => {
    const noEntitlement = await fetch(`${baseUrl}/exercises?ids=push_up`, {
      headers: { 'x-test-user': '9', 'x-test-entitled': 'false' },
    });
    const wrongTenant = await fetch(`${baseUrl}/exercises?ids=push_up`, {
      headers: { 'x-test-user': '7', 'x-test-tenant': '8' },
    });
    expect(noEntitlement.status).toBe(404);
    expect(wrongTenant.status).toBe(404);
    expect(await noEntitlement.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await wrongTenant.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('fails closed with a hidden 404 when entitlement resolution is unavailable', async () => {
    resolveEntitlement.mockImplementationOnce(() => { throw new Error('fixture entitlement unavailable'); });
    const response = await fetch(`${baseUrl}/exercises?ids=push_up`, {
      headers: { 'x-test-user': '10', 'x-test-entitled': 'false' },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('bounds batch input at 50 and rejects malformed identifiers before lookup', async () => {
    const tooMany = Array.from({ length: 51 }, (_, index) => `exercise_${index}`).join(',');
    const capped = await fetch(`${baseUrl}/exercises?ids=${tooMany}`);
    const malformed = await fetch(`${baseUrl}/exercises?ids=push_up,Bad%20Identifier`);
    expect(capped.status).toBe(400);
    expect(await capped.json()).toMatchObject({ error: { code: 'EXERCISE_ID_LIMIT_EXCEEDED' } });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'INVALID_EXERCISE_ID' } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('returns honest locale fallback and records only bounded redacted learning outcomes', async () => {
    const before = db.prepare('SELECT total_changes() AS count').get() as { count: number };
    const response = await fetch(`${baseUrl}/exercises?ids=push_up,press_up,future_modal_xyz`, {
      headers: { 'x-language': 'pt-PT' },
    });
    const after = db.prepare('SELECT total_changes() AS count').get() as { count: number };
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toMatch(/^W\/"[0-9a-f]{64}"$/);
    expect(response.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 'training_exercise_media_api.v1',
        requestedLocale: 'pt-PT',
        items: [
          { kind: 'AVAILABLE', requestedExerciseId: 'push_up', exerciseId: 'push_up' },
          { kind: 'AVAILABLE', requestedExerciseId: 'press_up', exerciseId: 'push_up' },
          {
            kind: 'UNAVAILABLE', requestedExerciseId: 'future_modal_xyz',
            rawIdentifier: 'future_modal_xyz', reason: 'UNKNOWN_EXERCISE',
            textFallbackRequired: true,
          },
        ],
      },
    });
    const golden = goldenEnvelope('training-exercise-media-golden-batch.json');
    expect(normalizedTimestamp(body, golden)).toEqual(golden);
    expect(after.count).toBeGreaterThan(before.count);
    expect(recordLearning).toHaveBeenCalledOnce();
    const learningCases = db.prepare(`
      SELECT redacted_input_json AS redactedInput,
             evidence_references_json AS evidenceReferences,
             lifecycle
        FROM product_learning_cases
       WHERE tenant_id = 7 AND user_id = 7
       ORDER BY redacted_input_json
    `).all() as Array<{ redactedInput: string; evidenceReferences: string; lifecycle: string }>;
    expect(learningCases).toHaveLength(2);
    expect(learningCases.map((row) => JSON.parse(row.redactedInput))).toEqual([
      expect.objectContaining({ kind: 'media_fallback', outcomeCode: 'fallback_used' }),
      expect.objectContaining({ kind: 'media_missing_mapping', outcomeCode: 'mapping_missing' }),
    ]);
    expect(learningCases.every((row) => row.lifecycle === 'observed')).toBe(true);
    expect(JSON.stringify(learningCases)).not.toContain('push_up');
    expect(JSON.stringify(learningCases)).not.toContain('press_up');
    expect(JSON.stringify(learningCases)).not.toContain('future_modal_xyz');
  });

  it('supports single-item 404 and conditional ETag revalidation', async () => {
    const unknown = await fetch(`${baseUrl}/exercises/future_modal_xyz`);
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.json() as Record<string, unknown>;
    expect(unknownBody).toMatchObject({
      error: {
        code: 'TRAINING_EXERCISE_MEDIA_NOT_FOUND',
        details: { exerciseId: 'future_modal_xyz', textFallbackRequired: true },
      },
    });
    const missingGolden = goldenEnvelope('training-exercise-media-golden-single-404.json');
    expect(normalizedTimestamp(unknownBody, missingGolden)).toEqual(missingGolden);

    const first = await fetch(`${baseUrl}/exercises/push_up`, {
      headers: { 'x-language': 'pt-PT' },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as Record<string, unknown>;
    const singleGolden = goldenEnvelope('training-exercise-media-golden-single.json');
    expect(normalizedTimestamp(firstBody, singleGolden)).toEqual(singleGolden);
    const eTag = first.headers.get('etag');
    expect(eTag).toBeTruthy();
    const notModified = await fetch(`${baseUrl}/exercises/push_up`, {
      headers: { 'if-none-match': eTag!, 'x-language': 'pt-PT' },
    });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe('');
  });

  it('does not let a wildcard validator suppress fresh governed availability', async () => {
    const firstBatch = await fetch(`${baseUrl}/exercises?ids=push_up`);
    expect(firstBatch.status).toBe(200);
    expect(await firstBatch.json()).toMatchObject({
      data: { items: [{ kind: 'AVAILABLE', exerciseId: 'push_up' }] },
    });
    const wildcardSingle = await fetch(`${baseUrl}/exercises/push_up`, {
      headers: { 'if-none-match': '*' },
    });
    expect(wildcardSingle.status).toBe(200);
    expect(await wildcardSingle.json()).toMatchObject({
      data: { exercise: { kind: 'AVAILABLE', exerciseId: 'push_up' } },
    });

    const manifest = db.prepare(`
      SELECT manifest_id
        FROM training_exercise_media_manifests
       WHERE publication_state = 'ACTIVE'
       LIMIT 1
    `).get() as { manifest_id: string };
    const asset = db.prepare(`
      SELECT asset_id
        FROM training_exercise_media_assets
       WHERE manifest_id = ? AND exercise_id = 'push_up'
       LIMIT 1
    `).get(manifest.manifest_id) as { asset_id: string };
    db.prepare(`
      INSERT INTO training_exercise_media_takedown_events (
        event_id, manifest_id, scope_key, asset_id, action, reason_code,
        authority_ref, replacement_asset_id, evidence_hash, effective_at, created_at
      ) VALUES (
        'route-wildcard-takedown', ?, '__global__', ?, 'REMOVE', 'FIXTURE_REVIEW',
        'fixture-authority', NULL, ?, '2026-07-12T11:00:00.000Z', '2026-07-12T11:00:00.000Z'
      )
    `).run(manifest.manifest_id, asset.asset_id, 'a'.repeat(64));

    const changedBatch = await fetch(`${baseUrl}/exercises?ids=push_up`, {
      headers: { 'if-none-match': '*' },
    });
    expect(changedBatch.status).toBe(200);
    expect(await changedBatch.json()).toMatchObject({
      data: {
        items: [{
          kind: 'UNAVAILABLE',
          requestedExerciseId: 'push_up',
          reason: 'MEDIA_UNAVAILABLE',
          textFallbackRequired: true,
        }],
      },
    });

    const singleUnavailable = await fetch(`${baseUrl}/exercises/push_up`, {
      headers: { 'if-none-match': '*' },
    });
    expect(singleUnavailable.status).toBe(404);
    expect(await singleUnavailable.json()).toMatchObject({
      error: {
        code: 'TRAINING_EXERCISE_MEDIA_NOT_FOUND',
        details: { exerciseId: 'push_up', reason: 'MEDIA_UNAVAILABLE' },
      },
    });
  });
});
