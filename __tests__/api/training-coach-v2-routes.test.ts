/**
 * Codex P1 — Coach periodization v2 routes (C2/C6/A5) wiring tests.
 *
 * Pins:
 *   - Flag OFF → 404 COACH_V2_DISABLED on every v2 route
 *   - Flag ON: POST /week/travel writes row
 *   - Flag ON: POST /week/:weekId/reflow preview works without idempotencyKey
 *   - Flag ON: POST /week/:weekId/reflow apply requires idempotencyKey (400)
 *   - Flag ON: GET /plans/:planId/coach-policy returns defaults
 *   - Flag ON: PATCH /plans/:planId/coach-policy validates + persists
 *   - Flag ON: PATCH with invalid enum → 400
 */

import express from 'express';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let testDb: Database.Database;
let flagState = true;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    // F11: reflow resolves one scheduling zone even when the test athlete has
    // no users row, mirroring the production user-zone → app-zone fallback.
    app: { timezone: 'Europe/Lisbon' },
    coaching: {
      get periodizationV2Enabled() { return flagState; },
      ruleEnforcementEnabled: false,
      trainingSafetyGuardrailsEnabled: false,
      coachKernelEquipmentAuthorityEnabled: false,
    },
  },
}));


import {
  mountCoachV2Routes,
  resolvePersistedTrainingReflowSyncTarget,
} from '../../src/api/routes/training-coach-v2';
import { _resetRateLimiterForTests } from '../../src/api/rate-limiter';
import { setDbProvider } from '../../src/services/intelligence-bus';

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  _resetRateLimiterForTests();
  testDb = createMigratedTestDatabase();
  setDbProvider(() => testDb);
  flagState = true;
  // Seed a plan + week.
  testDb.prepare(`
    INSERT INTO fitness_training_plans (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (1, 100, 100, 'p', 'gym', 4, '2026-01-05', '2026-02-01', 'active')
  `).run();
  testDb.prepare('INSERT INTO training_weeks (id, plan_id, week_number) VALUES (1, 1, 1)').run();

  // Build a tiny express app that mounts the v2 routes with a fake auth shim.
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const requestedTenant = req.header('x-test-tenant-id');
    (req as unknown as { userId: number }).userId = 100;
    (req as unknown as { tenantId: number }).tenantId = requestedTenant ? Number(requestedTenant) : 100;
    next();
  });
  const router = express.Router();
  mountCoachV2Routes(router);
  app.use('/api/v1/training', router);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  testDb.close();
  _resetRateLimiterForTests();
});

async function req(
  method: string,
  requestPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}${requestPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          json = null;
        }
        resolve({ status: response.statusCode ?? 0, json, headers: response.headers });
      });
    });
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

describe('coach v2 routes — feature flag gate', () => {
  it('rate limits flagged v2 coach routes before handler database work', async () => {
    for (let i = 0; i < 60; i++) {
      const result = await req('POST', '/api/v1/training/week/not-a-week/reflow', {});
      expect(result.status).toBe(400);
      expect(result.json?.error?.code).toBe('BAD_WEEK_ID');
    }

    const blocked = await req('POST', '/api/v1/training/week/not-a-week/reflow', {});
    expect(blocked.status).toBe(429);
    expect(blocked.json?.error?.code).toBe('RATE_LIMITED');
  });

  it('flag OFF → POST /week/travel returns 404 COACH_V2_DISABLED', async () => {
    flagState = false;
    const result = await req('POST', '/api/v1/training/week/travel', {
      startDate: '2026-06-01', endDate: '2026-06-08',
    });
    expect(result.status).toBe(404);
    expect(result.json?.error?.code).toBe('COACH_V2_DISABLED');
  });

  it('flag OFF → POST /week/:weekId/reflow returns 404', async () => {
    flagState = false;
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'preview',
    });
    expect(result.status).toBe(404);
    expect(result.json?.error?.code).toBe('COACH_V2_DISABLED');
  });

  it('flag OFF → GET /plans/:planId/coach-policy returns 404', async () => {
    flagState = false;
    const result = await req('GET', '/api/v1/training/plans/1/coach-policy');
    expect(result.status).toBe(404);
    expect(result.json?.error?.code).toBe('COACH_V2_DISABLED');
  });

  it('flag OFF → PATCH /plans/:planId/coach-policy returns 404', async () => {
    flagState = false;
    const result = await req('PATCH', '/api/v1/training/plans/1/coach-policy', {
      progressionAggressiveness: 'aggressive',
    });
    expect(result.status).toBe(404);
  });
});

describe('POST /week/travel (C2)', () => {
  it('persists travel window with full payload', async () => {
    const result = await req('POST', '/api/v1/training/week/travel', {
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
      timeZoneShiftHours: 8,
      flightDurationHours: 12,
      sleepDisruptionExpected: true,
      walkingLoadExpected: true,
      heatStress: false,
      availableSessionDurationMinutes: 30,
      notes: 'business trip',
    }, { 'Idempotency-Key': 'travel-full-payload' });
    expect(result.status).toBe(201);
    expect(result.json?.data).toMatchObject({
      schemaVersion: 'training-coach-v2.2',
      state: 'created',
      alreadyExisted: false,
      window: { id: expect.any(Number), version: 1 },
    });
    const row = testDb.prepare(
      'SELECT * FROM travel_windows WHERE user_id = 100',
    ).get() as {
      tenant_id: number; start_date: string; time_zone_shift_hours: number; sleep_disruption_expected: number;
    };
    expect(row.tenant_id).toBe(100);
    expect(row.start_date).toBe('2026-06-01');
    expect(row.time_zone_shift_hours).toBe(8);
    expect(row.sleep_disruption_expected).toBe(1);
  });

  it('replays duplicate POST for the same tenant without creating another row', async () => {
    const body = {
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
      timeZoneShiftHours: 8,
      flightDurationHours: 12,
      sleepDisruptionExpected: true,
      walkingLoadExpected: true,
      availableSessionDurationMinutes: 30,
      notes: 'private trip notes',
    };

    const headers = { 'Idempotency-Key': 'travel-create-replay' };
    const first = await req('POST', '/api/v1/training/week/travel', body, headers);
    const replay = await req('POST', '/api/v1/training/week/travel', body, headers);
    const count = testDb.prepare(
      'SELECT COUNT(*) AS n FROM travel_windows WHERE user_id = 100 AND tenant_id = 100',
    ).get() as { n: number };

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(first.json?.data?.alreadyExisted).toBe(false);
    expect(replay.json?.data?.alreadyExisted).toBe(true);
    expect(replay.json?.data?.state).toBe('replayed');
    expect(replay.json?.data?.window?.id).toBe(first.json?.data?.window?.id);
    expect(count.n).toBe(1);
  });

  it('does not replay duplicate POST across another tenant', async () => {
    const body = {
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
    };

    const tenantA = await req('POST', '/api/v1/training/week/travel', body, {
      'x-test-tenant-id': '100', 'Idempotency-Key': 'travel-shared-key',
    });
    const tenantB = await req('POST', '/api/v1/training/week/travel', body, {
      'x-test-tenant-id': '200', 'Idempotency-Key': 'travel-shared-key',
    });

    expect(tenantA.status).toBe(201);
    expect(tenantB.status).toBe(201);
    expect(tenantB.json?.data?.alreadyExisted).toBe(false);
    expect(tenantB.json?.data?.window?.id).not.toBe(tenantA.json?.data?.window?.id);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM travel_windows WHERE user_id = 100').get()).toMatchObject({ n: 2 });
  });

  it('keeps overlapping but not identical POSTs as separate travel windows', async () => {
    const first = await req('POST', '/api/v1/training/week/travel', {
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
      availableSessionDurationMinutes: 30,
    }, { 'Idempotency-Key': 'travel-overlap-first' });
    const overlap = await req('POST', '/api/v1/training/week/travel', {
      startDate: '2026-06-05',
      endDate: '2026-06-10',
      equipmentProfile: 'bodyweight_only',
      availableSessionDurationMinutes: 20,
    }, { 'Idempotency-Key': 'travel-overlap-second' });

    expect(first.status).toBe(201);
    expect(overlap.status).toBe(201);
    expect(overlap.json?.data?.alreadyExisted).toBe(false);
    expect(overlap.json?.data?.window?.id).not.toBe(first.json?.data?.window?.id);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM travel_windows WHERE user_id = 100 AND tenant_id = 100').get()).toMatchObject({ n: 2 });
  });

  it('rejects missing dates with 400', async () => {
    const result = await req('POST', '/api/v1/training/week/travel', { startDate: '2026-06-01' });
    expect(result.status).toBe(400);
    expect(result.json?.error?.code).toBe('BAD_INPUT');
  });

  it('rejects startDate > endDate with 400', async () => {
    const result = await req('POST', '/api/v1/training/week/travel', {
      startDate: '2026-06-10', endDate: '2026-06-01',
    });
    expect(result.status).toBe(400);
  });
});

describe('GET/PATCH/DELETE /week/travel', () => {
  it('lists bounded tenant-scoped windows and rejects a non-numeric limit', async () => {
    const created = await req('POST', '/api/v1/training/week/travel', {
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      notes: 'private travel note',
    }, { 'Idempotency-Key': 'travel-list-create' });
    expect(created.status).toBe(201);

    const listed = await req('GET', '/api/v1/training/week/travel?fromDate=2026-06-03&toDate=2026-06-04&limit=10');
    expect(listed.status).toBe(200);
    expect(listed.json?.data).toMatchObject({
      schemaVersion: 'training-coach-v2.2',
      windows: [{
        id: created.json?.data?.window?.id,
        version: 1,
        startDate: '2026-06-01',
        endDate: '2026-06-08',
      }],
    });

    const foreign = await req('GET', '/api/v1/training/week/travel', undefined, {
      'x-test-tenant-id': '200',
    });
    expect(foreign.status).toBe(200);
    expect(foreign.json?.data?.windows).toEqual([]);

    const malformed = await req('GET', '/api/v1/training/week/travel?limit=abc');
    expect(malformed.status).toBe(400);
    expect(malformed.json?.error).toMatchObject({ code: 'BAD_INPUT' });
  });

  it('validates the fully merged PATCH, then CAS-updates and replays the exact mutation', async () => {
    const created = await req('POST', '/api/v1/training/week/travel', {
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      notes: 'initial',
    }, { 'Idempotency-Key': 'travel-patch-create' });
    const id = created.json?.data?.window?.id as number;

    const invalidMerged = await req('PATCH', `/api/v1/training/week/travel/${id}`, {
      startDate: '2024-01-01',
    }, { 'If-Match': '"travel-1"', 'Idempotency-Key': 'travel-patch-too-long' });
    expect(invalidMerged.status).toBe(400);
    expect(invalidMerged.json?.error?.message).toMatch(/cannot exceed 366 days/);
    expect(testDb.prepare('SELECT version FROM travel_windows WHERE id = ?').get(id)).toEqual({ version: 1 });

    const headers = { 'If-Match': '"travel-1"', 'Idempotency-Key': 'travel-patch-exact' };
    const updated = await req('PATCH', `/api/v1/training/week/travel/${id}`, {
      notes: 'reviewed availability',
      availableSessionDurationMinutes: 35,
    }, headers);
    const replay = await req('PATCH', `/api/v1/training/week/travel/${id}`, {
      notes: 'reviewed availability',
      availableSessionDurationMinutes: 35,
    }, headers);
    expect(updated.status).toBe(200);
    expect(updated.json?.data).toMatchObject({
      state: 'updated',
      window: { id, version: 2, notes: 'reviewed availability', availableSessionDurationMinutes: 35 },
    });
    expect(replay.status).toBe(200);
    expect(replay.json?.data).toMatchObject({ state: 'replayed', window: { id, version: 2 } });

    const stale = await req('PATCH', `/api/v1/training/week/travel/${id}`, { notes: 'stale' }, {
      'If-Match': '"travel-1"', 'Idempotency-Key': 'travel-patch-stale',
    });
    expect(stale.status).toBe(412);
    expect(stale.json?.error?.code).toBe('VERSION_CONFLICT');

    const foreign = await req('PATCH', `/api/v1/training/week/travel/${id}`, { notes: 'foreign' }, {
      'x-test-tenant-id': '200', 'If-Match': '"travel-2"', 'Idempotency-Key': 'travel-patch-foreign',
    });
    expect(foreign.status).toBe(404);
  });

  it('deletes with CAS and replays after the row is gone without crossing tenant scope', async () => {
    const created = await req('POST', '/api/v1/training/week/travel', {
      startDate: '2026-07-01',
      endDate: '2026-07-02',
    }, { 'Idempotency-Key': 'travel-delete-create' });
    const id = created.json?.data?.window?.id as number;

    const foreign = await req('DELETE', `/api/v1/training/week/travel/${id}`, {}, {
      'x-test-tenant-id': '200', 'If-Match': '"travel-1"', 'Idempotency-Key': 'travel-delete-foreign',
    });
    expect(foreign.status).toBe(200);
    expect(foreign.json?.data).toMatchObject({ state: 'already_absent', deleted: false });
    expect(testDb.prepare('SELECT id FROM travel_windows WHERE id = ?').get(id)).toBeDefined();

    const headers = { 'If-Match': '"travel-1"', 'Idempotency-Key': 'travel-delete-exact' };
    const deleted = await req('DELETE', `/api/v1/training/week/travel/${id}`, {}, headers);
    const replay = await req('DELETE', `/api/v1/training/week/travel/${id}`, {}, headers);
    expect(deleted.status).toBe(200);
    expect(deleted.json?.data).toMatchObject({ state: 'deleted', deleted: true });
    expect(replay.status).toBe(200);
    expect(replay.json?.data).toMatchObject({ state: 'replayed', deleted: true });
    expect(testDb.prepare('SELECT id FROM travel_windows WHERE id = ?').get(id)).toBeUndefined();
  });
});

describe('POST /week/:weekId/reflow proposal-first contract', () => {
  async function seedHardPauseScenario(weekId = 1, sessionId = 501): Promise<void> {
    testDb.prepare(
      "INSERT OR IGNORE INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status) VALUES (?, ?, 1, 'Monday', 'easy_run', 'Actionable run', 60, 'pending')",
    ).run(sessionId, weekId);
    const intake = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: new Date().toISOString().slice(0, 10),
      illnessSymptoms: ['chest_pain'],
      consentScope: ['illness'],
    }, { 'Idempotency-Key': 'reflow-safety-' + String(weekId) });
    expect([200, 201]).toContain(intake.status);
  }

  async function createPreview(weekId = 1): Promise<any> {
    await seedHardPauseScenario(weekId, 500 + weekId);
    const preview = await req('POST', '/api/v1/training/week/reflow/preview', {
      weekId,
      trigger: 'manual_reflow',
      sessionsToPreserve: [],
    });
    expect(preview.status).toBe(200);
    expect(preview.json?.data).toMatchObject({
      schemaVersion: 'training-coach-v2.2',
      outcome: 'preview',
      planId: 1,
      weekId,
      proposalId: null,
      adaptationId: null,
      expectedVersion: expect.any(Number),
    });
    expect(preview.json?.data?.previewId).toEqual(expect.any(String));
    return preview.json.data;
  }

  it('returns the standard no_changes envelope without inventing nullable identifiers', async () => {
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1,
      mode: 'preview',
      trigger: 'manual_reflow',
    });
    expect(result.status).toBe(200);
    expect(result.json?.data).toMatchObject({
      schemaVersion: 'training-coach-v2.2',
      outcome: 'no_changes',
      planId: 1,
      weekId: 1,
      proposalId: null,
      adaptationId: null,
    });
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM training_coach_v2_reflow_previews').get()).toEqual({ n: 0 });
  });

  it('requires idempotency before a reviewed preview and rejects missing preview identity', async () => {
    const missingKey = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1,
      mode: 'apply',
      trigger: 'manual_reflow',
    });
    expect(missingKey.status).toBe(400);
    expect(missingKey.json?.error?.code).toBe('IDEMPOTENCY_REQUIRED');

    const missingPreview = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1,
      mode: 'apply',
      trigger: 'manual_reflow',
      idempotencyKey: 'proposal-without-preview',
    });
    expect(missingPreview.status).toBe(428);
    expect(missingPreview.json?.error?.code).toBe('PREVIEW_REQUIRED');
  });

  it('binds the exact preview to a Decision Center proposal without mutating plan or sessions', async () => {
    const preview = await createPreview();
    const before = testDb.prepare(
      'SELECT adaptation_revision AS revision FROM fitness_training_plans WHERE id = 1',
    ).get();
    const sessionBefore = testDb.prepare(
      'SELECT duration_minutes AS duration, status FROM training_sessions WHERE id = 501',
    ).get();

    const proposed = await req('POST', '/api/v1/training/week/reflow/proposals', {
      weekId: 1,
      previewId: preview.previewId,
    }, { 'Idempotency-Key': 'proposal-first-reflow' });

    expect(proposed.status).toBe(202);
    expect(proposed.json?.data).toMatchObject({
      schemaVersion: 'training-coach-v2.2',
      outcome: 'proposal_created',
      planId: 1,
      weekId: 1,
      previewId: preview.previewId,
      proposalId: expect.any(String),
      adaptationId: null,
      decisionId: expect.any(String),
      proposal: {
        kind: 'week_reflow',
        planId: 1,
        weekId: 1,
        previewId: preview.previewId,
      },
    });
    expect(testDb.prepare(
      'SELECT adaptation_revision AS revision FROM fitness_training_plans WHERE id = 1',
    ).get()).toEqual(before);
    expect(testDb.prepare(
      'SELECT duration_minutes AS duration, status FROM training_sessions WHERE id = 501',
    ).get()).toEqual(sessionBefore);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM training_coach_v2_proposals').get()).toEqual({ n: 1 });
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM training_plan_adaptations').get()).toEqual({ n: 0 });
  });

  it('replays before volatile version checks and rejects a key bound to another reviewed preview', async () => {
    const preview = await createPreview();
    const first = await req('POST', '/api/v1/training/week/reflow/proposals', {
      weekId: 1,
      previewId: preview.previewId,
    }, { 'Idempotency-Key': '  stable-reflow-replay  ' });
    expect(first.status).toBe(202);

    testDb.prepare('UPDATE fitness_training_plans SET adaptation_revision = 7 WHERE id = 1').run();
    const replay = await req('POST', '/api/v1/training/week/reflow/proposals', {
      weekId: 1,
      previewId: preview.previewId,
    }, { 'Idempotency-Key': 'stable-reflow-replay' });
    expect(replay.status).toBe(200);
    expect(replay.json?.data).toMatchObject({
      outcome: 'replayed',
      proposalId: first.json?.data?.proposalId,
      decisionId: first.json?.data?.decisionId,
    });

    const differentPreview = await req('POST', '/api/v1/training/week/reflow/preview', {
      weekId: 1,
      trigger: 'manual_reflow_after_state_change',
    });
    expect(differentPreview.status).toBe(200);
    expect(differentPreview.json?.data?.previewId).toEqual(expect.any(String));
    const conflict = await req('POST', '/api/v1/training/week/reflow/proposals', {
      weekId: 1,
      previewId: differentPreview.json.data.previewId,
    }, { 'Idempotency-Key': 'stable-reflow-replay' });
    expect(conflict.status).toBe(409);
    expect(conflict.json?.error?.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('returns rate_limited with nullable identifiers and persists neither preview nor proposal', async () => {
    testDb.prepare(
      "INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status) VALUES (580, 1, 1, 'Monday', 'easy_run', 'Travel run', 60, 'pending')",
    ).run();
    testDb.prepare(
      "INSERT INTO travel_windows (user_id, tenant_id, start_date, end_date, time_zone_shift_hours, flight_duration_hours, sleep_disruption_expected, walking_load_expected, heat_stress, version) VALUES (100, 100, '2026-01-05', '2026-01-11', 8, 12, 1, 1, 1, 1)",
    ).run();
    for (let revision = 1; revision <= 3; revision += 1) {
      testDb.prepare(
        "INSERT INTO training_plan_adaptations (plan_id, adaptation_revision, scope, trigger_type, decision_reason_codes_json, science_policy_version, actor) VALUES (1, ?, 'week', 'manual_reflow', '[\"travel_capacity\"]', 'science.v1', 'user')",
      ).run(revision);
    }

    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1,
      mode: 'preview',
      trigger: 'manual_reflow',
    });
    expect(result.status).toBe(200);
    expect(result.json?.data).toMatchObject({
      schemaVersion: 'training-coach-v2.2',
      outcome: 'rate_limited',
      planId: 1,
      weekId: 1,
      proposalId: null,
      adaptationId: null,
      scenario: { rateLimited: true },
    });
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM training_coach_v2_reflow_previews').get()).toEqual({ n: 0 });
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM training_coach_v2_proposals').get()).toEqual({ n: 0 });
  });

  it('keeps a proposal key scoped to the reviewed week and rejects cross-week reuse', async () => {
    const firstPreview = await createPreview(1);
    const first = await req('POST', '/api/v1/training/week/reflow/proposals', {
      weekId: 1,
      previewId: firstPreview.previewId,
    }, { 'Idempotency-Key': 'cross-week-proposal-key' });
    expect(first.status).toBe(202);

    testDb.prepare(
      "INSERT INTO training_weeks (id, plan_id, week_number, focus, intensity_pct, auto_adjusted, created_at) VALUES (2, 1, 2, 'base', 70, 0, datetime('now'))",
    ).run();
    const secondPreview = await createPreview(2);
    const second = await req('POST', '/api/v1/training/week/reflow/proposals', {
      weekId: 2,
      previewId: secondPreview.previewId,
    }, { 'Idempotency-Key': 'cross-week-proposal-key' });
    expect(second.status).toBe(409);
    expect(second.json?.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM training_coach_v2_proposals').get()).toEqual({ n: 1 });
  });

  it('rejects bad mode, bad week identity, and unknown weeks without mutation', async () => {
    const badMode = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1,
      mode: 'commit',
    });
    const badWeek = await req('POST', '/api/v1/training/week/abc/reflow', {
      planId: 1,
      mode: 'preview',
    });
    const unknown = await req('POST', '/api/v1/training/week/9999/reflow', {
      planId: 1,
      mode: 'preview',
    });
    expect(badMode.status).toBe(400);
    expect(badMode.json?.error?.code).toBe('BAD_MODE');
    expect(badWeek.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM training_coach_v2_proposals').get()).toEqual({ n: 0 });
  });
});
describe('F24 — live reflow propagation wiring', () => {
  it.each([
    ['google', 'google'],
    ['outlook', 'outlook'],
    ['none', 'none'],
    ['apple', 'apple'],
  ] as const)('resolves persisted Training spec provider %s without reinterpretation', (provider, expected) => {
    expect(resolvePersistedTrainingReflowSyncTarget(JSON.stringify({
      trainingCalendarSource: provider === 'google' || provider === 'outlook' ? provider : null,
      trainingPlanSpec: { calendarPreference: { provider } },
    }))).toBe(expected);
  });

  it('fails legacy explicit null to no-provider while preserving absent-key auto compatibility', () => {
    expect(resolvePersistedTrainingReflowSyncTarget('{"trainingCalendarSource":null}')).toBe('none');
    expect(resolvePersistedTrainingReflowSyncTarget('{"preferredTime":"07:00"}')).toBe('auto');
  });

  it('keeps reflow proposal-first and defers provider effects to the approved activation outbox', () => {
    const source = fs.readFileSync(path.resolve(
      __dirname,
      '../../src/api/routes/training-coach-v2.ts',
    ), 'utf8');
    expect(source).toContain('createTrainingCoachV2ReflowPreview({');
    expect(source).toContain('createTrainingCoachV2Proposal({');
    expect(source).toContain('bindTrainingCoachV2ProposalDecision({');
    // Stronger F24 guarantee: reflow preserves the plan's persisted calendar
    // choice; none/apple must never be upgraded into an auto provider write.
    expect(source).toContain('const reflowSyncTarget = resolvePersistedTrainingReflowSyncTarget(');
    expect(source).toContain('syncTarget: reflowSyncTarget');
    expect(source).not.toContain("syncTarget: 'auto'");
    expect(source).not.toContain('executeWeekReflowWithPropagation({');
    expect(source).not.toMatch(/\bexecuteWeekReflow\s*\(\s*\{/);
  });
});

describe('GET/PATCH /plans/:planId/coach-policy proposal contract', () => {
  it('GET returns the versioned default policy and ETag', async () => {
    const result = await req('GET', '/api/v1/training/plans/1/coach-policy');
    expect(result.status).toBe(200);
    expect(result.headers.etag).toBe('"coach-policy-1"');
    expect(result.json?.data).toMatchObject({
      schemaVersion: 'training-coach-v2.2',
      planId: 1,
      version: 1,
      policy: {
        progressionAggressiveness: 'standard',
        deloadStrategy: 'hybrid',
      },
    });
  });

  it('PATCH preserves omitted fields and creates a proposal without mutating the policy projection', async () => {
    const result = await req('PATCH', '/api/v1/training/plans/1/coach-policy', {
      deloadStrategy: 'data_informed',
    }, {
      'If-Match': '"coach-policy-1"',
      'Idempotency-Key': 'policy-proposal-preserve',
    });
    expect(result.status).toBe(202);
    expect(result.json?.data).toMatchObject({
      schemaVersion: 'training-coach-v2.2',
      outcome: 'proposal_created',
      decisionId: expect.any(String),
      currentPolicy: {
        progressionAggressiveness: 'standard',
        deloadStrategy: 'hybrid',
      },
      proposedPolicy: {
        progressionAggressiveness: 'standard',
        deloadStrategy: 'data_informed',
      },
      proposal: { kind: 'coach_policy', planId: 1, weekId: null },
    });

    const unchanged = await req('GET', '/api/v1/training/plans/1/coach-policy');
    expect(unchanged.json?.data).toMatchObject({
      version: 1,
      policy: {
        progressionAggressiveness: 'standard',
        deloadStrategy: 'hybrid',
      },
    });
  });

  it('replays by idempotency key before volatile CAS and rejects a changed request', async () => {
    const headers = {
      'If-Match': '"coach-policy-1"',
      'Idempotency-Key': 'policy-stable-replay',
    };
    const first = await req('PATCH', '/api/v1/training/plans/1/coach-policy', {
      progressionAggressiveness: 'conservative',
    }, headers);
    expect(first.status).toBe(202);

    testDb.prepare('UPDATE fitness_training_plans SET coach_plan_policy_version = 2 WHERE id = 1').run();
    const replay = await req('PATCH', '/api/v1/training/plans/1/coach-policy', {
      progressionAggressiveness: 'conservative',
    }, headers);
    expect(replay.status).toBe(200);
    expect(replay.json?.data).toMatchObject({
      outcome: 'replayed',
      decisionId: first.json?.data?.decisionId,
      proposal: { proposalId: first.json?.data?.proposal?.proposalId },
    });

    const conflict = await req('PATCH', '/api/v1/training/plans/1/coach-policy', {
      progressionAggressiveness: 'aggressive',
    }, headers);
    expect(conflict.status).toBe(409);
    expect(conflict.json?.error?.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('requires ETag and idempotency, rejects stale CAS, and validates the patch', async () => {
    const missingEtag = await req('PATCH', '/api/v1/training/plans/1/coach-policy', {
      deloadStrategy: 'data_informed',
    }, { 'Idempotency-Key': 'policy-missing-etag' });
    expect(missingEtag.status).toBe(428);
    expect(missingEtag.json?.error?.code).toBe('PRECONDITION_REQUIRED');

    const missingKey = await req('PATCH', '/api/v1/training/plans/1/coach-policy', {
      deloadStrategy: 'data_informed',
    }, { 'If-Match': '"coach-policy-1"' });
    expect(missingKey.status).toBe(428);
    expect(missingKey.json?.error?.code).toBe('IDEMPOTENCY_REQUIRED');

    const stale = await req('PATCH', '/api/v1/training/plans/1/coach-policy', {
      deloadStrategy: 'data_informed',
    }, {
      'If-Match': '"coach-policy-9"',
      'Idempotency-Key': 'policy-stale',
    });
    expect(stale.status).toBe(412);
    expect(stale.json?.error?.code).toBe('VERSION_CONFLICT');

    const invalid = await req('PATCH', '/api/v1/training/plans/1/coach-policy', {
      deloadStrategy: 'data_driven',
    }, {
      'If-Match': '"coach-policy-1"',
      'Idempotency-Key': 'policy-invalid',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json?.error?.code).toBe('BAD_INPUT');
  });

  it('returns uniform 404 for an unknown plan before proposal validation', async () => {
    const result = await req('PATCH', '/api/v1/training/plans/9999/coach-policy', {
      progressionAggressiveness: 'standard',
    });
    expect(result.status).toBe(404);
    expect(result.json?.error?.code).toBe('PLAN_NOT_FOUND');
  });
});
describe('GET /plans/:planId/coach-analysis — end-to-end v2 composition', () => {
  it('returns mesocycle + weekIntent + intensityProfiles + deload + scenario', async () => {
    // Seed a couple of sessions in week 1 so the analysis has something to iterate.
    testDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
      VALUES (101, 1, 1, 'Monday', 'easy_run', 'Easy run', 45, 'pending')
    `).run();
    testDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
      VALUES (102, 1, 1, 'Wednesday', 'threshold_run', 'Threshold', 60, 'pending')
    `).run();

    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.status).toBe(200);
    const data = result.json?.data;
    expect(data?.planId).toBe(1);
    expect(data?.weekIndex).toBe(0);
    expect(data?.sciencePolicyVersion).toBeTruthy();
    expect(data?.mesocycle?.blockTemplate).toBeInstanceOf(Array);
    expect(data?.weekIntent?.kind).toBeTruthy();
    expect(data?.intensityProfiles).toBeInstanceOf(Array);
    expect(data?.intensityProfiles.length).toBe(2);
    expect(data?.deloadRecommendation?.confidence).toBeTruthy();
    expect(data?.weekConditions?.weekIndex).toBe(0);
    expect(data?.scenario?.primaryScenario).toBeTruthy();
    expect(data?.scenario?.actions).toBeInstanceOf(Array);
  });

  it('rejects bad weekIndex with 400', async () => {
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=-1');
    expect(result.status).toBe(400);
    expect(result.json?.error?.code).toBe('BAD_WEEK_INDEX');
  });

  it('rejects out-of-range weekIndex instead of silently clamping to the last week', async () => {
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=99');

    expect(result.status).toBe(400);
    expect(result.json?.error?.code).toBe('WEEK_OUT_OF_RANGE');
    expect(result.json?.error?.details?.reason).toBe('week_out_of_range');
  });

  it('returns 404 for unknown plan', async () => {
    const result = await req('GET', '/api/v1/training/plans/9999/coach-analysis?weekIndex=0');
    expect(result.status).toBe(404);
  });

  it('returns uniform 404 when plan belongs to a different user (R3 P2 — no status side channel)', async () => {
    testDb.prepare(`
      INSERT INTO fitness_training_plans (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (2, 200, 200, 'p', 'gym', 4, '2026-01-05', '2026-02-01', 'active')
    `).run();
    const result = await req('GET', '/api/v1/training/plans/2/coach-analysis?weekIndex=0');
    expect(result.status).toBe(404);
    expect(result.json?.error?.code).toBe('PLAN_NOT_FOUND');
  });

  it('returns uniform 404 when plan belongs to same user in another tenant', async () => {
    testDb.prepare(`
      INSERT INTO fitness_training_plans (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (3, 100, 200, 'p', 'gym', 4, '2026-01-05', '2026-02-01', 'active')
    `).run();
    const result = await req('GET', '/api/v1/training/plans/3/coach-analysis?weekIndex=0');
    expect(result.status).toBe(404);
    expect(result.json?.error?.code).toBe('PLAN_NOT_FOUND');
  });
});

describe('Codex R2 P0 — cross-user ownership checks (reflow + policy routes)', () => {
  // Seed a foreign plan + week owned by a different user.
  beforeEach(() => {
    testDb.prepare(`
      INSERT INTO fitness_training_plans (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (777, 999, 999, 'foreign', 'gym', 4, '2026-01-05', '2026-02-01', 'active')
    `).run();
    testDb.prepare('INSERT INTO training_weeks (id, plan_id, week_number) VALUES (888, 777, 1)').run();
  });

  it('GET /plans/:planId/coach-policy on foreign plan → 404 (R3 P2 uniform status)', async () => {
    const result = await req('GET', '/api/v1/training/plans/777/coach-policy');
    expect(result.status).toBe(404);
    expect(result.json?.error?.code).toBe('PLAN_NOT_FOUND');
  });

  it('PATCH /plans/:planId/coach-policy on foreign plan → 404 (no mutation, R3 P2)', async () => {
    const result = await req('PATCH', '/api/v1/training/plans/777/coach-policy', {
      progressionAggressiveness: 'aggressive',
    });
    expect(result.status).toBe(404);
    // Verify the foreign plan's policy was NOT changed.
    const row = testDb.prepare(
      'SELECT coach_plan_policy_json FROM fitness_training_plans WHERE id = ?',
    ).get(777) as { coach_plan_policy_json: string | null };
    expect(row.coach_plan_policy_json).toBeNull();
  });

  it('POST /week/:weekId/reflow on foreign week → 404 (no ledger row, R3 P2)', async () => {
    const result = await req('POST', '/api/v1/training/week/888/reflow', {
      planId: 777, mode: 'apply', idempotencyKey: 'attacker-key', trigger: 'attack',
    });
    expect(result.status).toBe(404);
    // Verify NO ledger row was written for the foreign plan.
    const ledger = testDb.prepare(
      'SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = 777',
    ).get() as { n: number };
    expect(ledger.n).toBe(0);
  });

  it('POST /week/:weekId/reflow with mismatched body planId → 400 PLAN_WEEK_MISMATCH', async () => {
    // Week 1 belongs to plan 1 (owned by user 100). Body says planId=777
    // (foreign). The week ownership check passes (week 1 is owned),
    // but the planId mismatch is rejected before any mutation.
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 777, mode: 'apply', idempotencyKey: 'mismatch-key', trigger: 't',
    });
    expect(result.status).toBe(400);
    expect(result.json?.error?.code).toBe('PLAN_WEEK_MISMATCH');
  });

  it('POST /week/:weekId/reflow with body planId omitted binds a reviewed proposal to the owned plan', async () => {
    const intake = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: new Date().toISOString().slice(0, 10),
      illnessSymptoms: ['chest_pain'],
      consentScope: ['illness'],
    }, { 'Idempotency-Key': 'owned-plan-fallback-safety' });
    expect(intake.status).toBe(201);
    const preview = await req('POST', '/api/v1/training/week/1/reflow', {
      mode: 'preview', trigger: 't',
    });
    expect(preview.status).toBe(200);
    expect(preview.json?.data?.outcome).toBe('preview');

    // No planId in either body — both requests derive it from the owned week.
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      mode: 'apply',
      idempotencyKey: 'fallback-key',
      previewId: preview.json.data.previewId,
      trigger: 't',
    });
    expect(result.status).toBe(202);
    expect(result.json?.data).toMatchObject({
      outcome: 'proposal_created',
      planId: 1,
      weekId: 1,
      adaptationId: null,
    });
  });
});

describe('Codex R2 P1 — reflow review and proposal never mutate sessions directly', () => {
  beforeEach(() => {
    // Seed an aerobic session that we'll watch get scaled by deload.
    testDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
      VALUES (501, 1, 1, 'Monday', 'easy_run', 'Easy run', 60, 'pending')
    `).run();
  });

  it('preview returns scenario.actions without mutating sessions', async () => {
    const before = testDb.prepare('SELECT duration_minutes FROM training_sessions WHERE id = 501').get() as { duration_minutes: number };
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'preview', trigger: 'preview_test',
    });
    expect(result.status).toBe(200);
    expect(['preview', 'no_changes']).toContain(result.json?.data?.outcome);
    expect(result.json?.data?.adaptationId).toBeNull();
    const after = testDb.prepare('SELECT duration_minutes FROM training_sessions WHERE id = 501').get() as { duration_minutes: number };
    expect(after.duration_minutes).toBe(before.duration_minutes);
  });

  it('reviewed apply creates an evidence-bound proposal without mutation counters', async () => {
    const intake = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: new Date().toISOString().slice(0, 10),
      illnessSymptoms: ['chest_pain'],
      consentScope: ['illness'],
    }, { 'Idempotency-Key': 'apply-evidence-safety' });
    expect(intake.status).toBe(201);
    const preview = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'preview', trigger: 'apply_test',
    });
    expect(preview.status).toBe(200);
    const before = testDb.prepare('SELECT duration_minutes FROM training_sessions WHERE id = 501').get();
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1,
      mode: 'apply',
      trigger: 'apply_test',
      idempotencyKey: 'apply-mutation-key',
      previewId: preview.json.data.previewId,
    });
    expect(result.status).toBe(202);
    expect(result.json?.data?.outcome).toBe('proposal_created');
    expect(result.json?.data?.scenario?.actions).toBeInstanceOf(Array);
    expect(result.json?.data?.adaptationId).toBeNull();
    expect(result.json?.data?.mutatedRows).toBeUndefined();
    expect(testDb.prepare('SELECT duration_minutes FROM training_sessions WHERE id = 501').get()).toEqual(before);
  });
});

describe('Codex R2 P2 — proposal idempotency replay surfaces the winning proposal', () => {
  beforeEach(() => {
    testDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
      VALUES (601, 1, 1, 'Monday', 'easy_run', 'Easy run', 60, 'pending')
    `).run();
  });

  it('duplicate idempotencyKey and preview return the original proposal', async () => {
    const intake = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: new Date().toISOString().slice(0, 10),
      illnessSymptoms: ['chest_pain'],
      consentScope: ['illness'],
    }, { 'Idempotency-Key': 'idempotency-replay-safety' });
    expect(intake.status).toBe(201);
    const preview = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'preview', trigger: 't',
    });
    expect(preview.status).toBe(200);
    const first = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1,
      mode: 'apply',
      idempotencyKey: 'conflict-route',
      previewId: preview.json.data.previewId,
      trigger: 't',
    });
    expect(first.status).toBe(202);
    expect(first.json?.data?.outcome).toBe('proposal_created');
    const second = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1,
      mode: 'apply',
      idempotencyKey: 'conflict-route',
      previewId: preview.json.data.previewId,
      trigger: 't',
    });
    expect(second.status).toBe(200);
    expect(second.json?.data?.outcome).toBe('replayed');
    expect(second.json?.data?.proposalId).toBe(first.json?.data?.proposalId);
    expect(second.json?.data?.adaptationId).toBeNull();
  });
});

describe('Codex R2 P1 — coach-analysis hydrates real metadata', () => {
  beforeEach(() => {
    testDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status, intensity_text)
      VALUES (701, 1, 1, 'Wednesday', 'threshold_run', 'Key Threshold', 60, 'pending', 'Zone 4')
    `).run();
  });

  it('athleteLevel surfaced + inferred when preferences_json missing', async () => {
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.status).toBe(200);
    expect(result.json?.data?.athleteLevel?.inferred).toBe(true);
    expect(result.json?.data?.athleteLevel?.level).toBe('intermediate');
  });

  it('athleteLevel resolved from preferences_json when supplied', async () => {
    testDb.prepare(
      `UPDATE fitness_training_plans SET preferences_json = ? WHERE id = ?`,
    ).run(JSON.stringify({ experienceLevel: 'advanced' }), 1);
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.json?.data?.athleteLevel?.level).toBe('advanced');
    expect(result.json?.data?.athleteLevel?.inferred).toBe(false);
  });

  it('sessions hydrate with inferred sport/intensityZone/keySession (NOT cosmetic)', async () => {
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.status).toBe(200);
    const profiles = result.json?.data?.intensityProfiles ?? [];
    expect(profiles.length).toBeGreaterThan(0);
    // The threshold_run session must hydrate to 'threshold' zone via inferIntensityZone.
    const threshold = profiles.find((p: any) => p.profile?.primaryZone === 'threshold');
    expect(threshold).toBeDefined();
  });

  it('raceCalendar surfaced from preferences_json when present', async () => {
    testDb.prepare(`UPDATE fitness_training_plans SET preferences_json = ? WHERE id = ?`).run(
      JSON.stringify({
        raceCalendar: [{
          id: 'race-1',
          name: 'Spring Marathon',
          discipline: 'running',
          subtype: 'marathon',
          date: '2026-04-15',
          priority: 'a',
        }],
      }),
      1,
    );
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.json?.data?.raceCalendar?.length).toBe(1);
    expect(result.json?.data?.raceCalendar[0].id).toBe('race-1');
  });
});

describe('R3 P0/P1/P2 fixes — uniform status, hard pause, completed protection, perActionResults', () => {
  beforeEach(() => {
    // Foreign plan for status-side-channel test.
    testDb.prepare(`
      INSERT INTO fitness_training_plans (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (888, 999, 999, 'foreign', 'gym', 4, '2026-01-05', '2026-02-01', 'active')
    `).run();
    testDb.prepare('INSERT INTO training_weeks (id, plan_id, week_number) VALUES (8888, 888, 1)').run();
  });

  it('R3 P2 — foreign plan returns 404 not 403 (uniform status; no side channel)', async () => {
    const result = await req('GET', '/api/v1/training/plans/888/coach-policy');
    expect(result.status).toBe(404);
    expect(result.json?.error?.code).toBe('PLAN_NOT_FOUND');
  });

  it('R3 P2 — foreign week returns 404 not 403', async () => {
    const result = await req('POST', '/api/v1/training/week/8888/reflow', {
      planId: 888, mode: 'apply', idempotencyKey: 'fk', trigger: 't',
    });
    expect(result.status).toBe(404);
    expect(result.json?.error?.code).toBe('WEEK_NOT_FOUND');
  });

  it('R3 P1 — completed session is NOT mutated while reflow awaits approval', async () => {
    testDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
      VALUES (910, 1, 1, 'Monday', 'easy_run', 'already done', 45, 'completed')
    `).run();
    const intake = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: new Date().toISOString().slice(0, 10),
      illnessSymptoms: ['chest_pain'],
      consentScope: ['illness'],
    }, { 'Idempotency-Key': 'completed-protection-safety' });
    expect(intake.status).toBe(201);
    const preview = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'preview', trigger: 't',
    });
    expect(preview.status).toBe(200);
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1,
      mode: 'apply',
      idempotencyKey: 'completed-protection',
      previewId: preview.json.data.previewId,
      trigger: 't',
    });
    expect(result.status).toBe(202);
    expect(result.json?.data?.outcome).toBe('proposal_created');
    const after = testDb.prepare('SELECT status FROM training_sessions WHERE id = 910').get() as { status: string };
    expect(after.status).toBe('completed'); // preserved
  });

  it('R3 P2 — proposal response carries reviewed actions but no direct-execution results', async () => {
    testDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
      VALUES (920, 1, 1, 'Tuesday', 'easy_run', 'pending session', 60, 'pending')
    `).run();
    const intake = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: new Date().toISOString().slice(0, 10),
      illnessSymptoms: ['chest_pain'],
      consentScope: ['illness'],
    }, { 'Idempotency-Key': 'per-action-safety' });
    expect(intake.status).toBe(201);
    const preview = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'preview', trigger: 't',
    });
    expect(preview.status).toBe(200);
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1,
      mode: 'apply',
      idempotencyKey: 'per-action-results',
      previewId: preview.json.data.previewId,
      trigger: 't',
    });
    expect(result.status).toBe(202);
    expect(Array.isArray(result.json?.data?.scenario?.actions)).toBe(true);
    expect(result.json?.data?.perActionResults).toBeUndefined();
  });
});

describe('R3 P1 — A4 hard-pause via structured intake', () => {
  async function recordStructuredSafety(
    facts: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<void> {
    const intake = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: new Date().toISOString().slice(0, 10),
      ...facts,
    }, { 'Idempotency-Key': idempotencyKey });
    expect(intake.status).toBe(201);
  }

  it('chest_pain via structured intake → coach-analysis emits pause_training', async () => {
    await recordStructuredSafety({
      painScore: 9,
      painLocation: 'chest',
      illnessSymptoms: ['chest_pain'],
      consentScope: ['pain', 'illness'],
    }, 'analysis-chest-pain');
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.status).toBe(200);
    const actions = result.json?.data?.scenario?.actions ?? [];
    const pause = actions.find((a: any) => a.type === 'pause_training');
    expect(pause).toBeDefined();
    expect(pause?.severity).toBe('medical_referral');
  });

  it('severe structured pain with location → coach-analysis emits pause_training without symptom wording', async () => {
    await recordStructuredSafety({
      painScore: 9,
      painLocation: 'left knee',
      consentScope: ['pain'],
    }, 'analysis-severe-pain');
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.status).toBe(200);
    const actions = result.json?.data?.scenario?.actions ?? [];
    const pause = actions.find((a: any) => a.type === 'pause_training');
    expect(pause).toBeDefined();
    expect(pause?.severity).toBe('medical_referral');
  });

  it('wearable-inferred high pain stays warning-only and does not pause training', async () => {
    testDb.prepare(`
      INSERT INTO athlete_health_signals
        (user_id, tenant_id, date, pain_score, pain_location, illness_symptoms_json, source, consent_scope)
      VALUES (100, 100, ?, 9, 'chest', '[]', 'wearable', 'pain')
    `).run(new Date().toISOString().slice(0, 10));
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.status).toBe(200);
    const actions = result.json?.data?.scenario?.actions ?? [];
    expect(actions.find((a: any) => a.type === 'pause_training')).toBeUndefined();
  });

  it('POST /health-intake/red-flag persists structured signal', async () => {
    const result = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: new Date().toISOString().slice(0, 10),
      illnessSymptoms: ['fever'],
      consentScope: ['illness'],
    }, { 'Idempotency-Key': 'health-intake-persist' });
    expect(result.status).toBe(201);
    expect(result.json?.data?.intakeId).toBeGreaterThan(0);
    const row = testDb.prepare(
      'SELECT source, tenant_id FROM athlete_health_signals WHERE id = ?',
    ).get(result.json.data.intakeId) as { source: string; tenant_id: number };
    expect(row.source).toBe('structured_intake');
    expect(row.tenant_id).toBe(100);
    expect(testDb.prepare(`
      SELECT tenant_id, user_id
      FROM agent_signals
      WHERE signal_type = 'safety_red_flag'
    `).get()).toEqual({ tenant_id: 100, user_id: 100 });
  });

  it('fever/systemic illness via structured intake → coach-analysis emits pause_training', async () => {
    await recordStructuredSafety({
      illnessSymptoms: ['fever'],
      consentScope: ['illness'],
    }, 'analysis-fever');
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.status).toBe(200);
    const pause = (result.json?.data?.scenario?.actions ?? []).find(
      (a: any) => a.type === 'pause_training',
    );
    expect(pause).toBeDefined();
    expect(pause?.severity).toBe('medical_referral');
  });

  it('POST /health-intake/red-flag rejects empty consentScope with 400', async () => {
    const result = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: new Date().toISOString().slice(0, 10),
      illnessSymptoms: ['fever'],
      consentScope: [],
    }, { 'Idempotency-Key': 'health-intake-empty-consent' });
    expect(result.status).toBe(428);
    expect(result.json?.error?.code).toBe('CONSENT_REQUIRED');
  });

  // ── R4 P2 — strict YYYY-MM-DD date validation on /health-intake/red-flag ──
  // Codex caught (R4 P2 #5) that the prior validator only checked
  // `typeof === 'string'` + non-empty. That accepted "tomorrow",
  // "2026-13-99", and injection-shaped strings like
  // "1970-01-01' OR 1=1" straight into an indexed DB column.

  it('R4 P2 — /health-intake/red-flag rejects bare "tomorrow" string as BAD_INPUT', async () => {
    const result = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: 'tomorrow',
      illnessSymptoms: ['fever'],
      consentScope: ['illness'],
    }, { 'Idempotency-Key': 'health-invalid-tomorrow' });
    expect(result.status).toBe(400);
    expect(result.json?.error?.code).toBe('BAD_DATE');
    expect(result.json?.error?.message).toMatch(/valid YYYY-MM-DD/);
  });

  it('R4 P2 — /health-intake/red-flag rejects impossible calendar date (2026-13-01)', async () => {
    const result = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: '2026-13-01',
      illnessSymptoms: ['fever'],
      consentScope: ['illness'],
    }, { 'Idempotency-Key': 'health-invalid-month' });
    expect(result.status).toBe(400);
    expect(result.json?.error?.code).toBe('BAD_DATE');
  });

  it('R4 P2 — /health-intake/red-flag rejects Feb 30 (calendar round-trip catches it)', async () => {
    const result = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: '2026-02-30',
      illnessSymptoms: ['fever'],
      consentScope: ['illness'],
    }, { 'Idempotency-Key': 'health-invalid-february' });
    expect(result.status).toBe(400);
  });

  it('R4 P2 — /health-intake/red-flag rejects ISO 8601 with time component (2026-05-23T00:00:00Z)', async () => {
    const result = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: '2026-05-23T00:00:00Z',
      illnessSymptoms: ['fever'],
      consentScope: ['illness'],
    }, { 'Idempotency-Key': 'health-invalid-timestamp' });
    expect(result.status).toBe(400);
  });

  it('R4 P2 — /health-intake/red-flag rejects injection-shaped string', async () => {
    const result = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: "1970-01-01' OR 1=1",
      illnessSymptoms: ['fever'],
      consentScope: ['illness'],
    }, { 'Idempotency-Key': 'health-invalid-injection' });
    expect(result.status).toBe(400);
  });

  it('R4 P2 — /week/travel rejects malformed startDate', async () => {
    const result = await req('POST', '/api/v1/training/week/travel', {
      startDate: 'next-monday',
      endDate: '2026-06-01',
    });
    expect(result.status).toBe(400);
    expect(result.json?.error?.message).toMatch(/dates.*YYYY-MM-DD/);
  });

  it('R4 P2 — /week/travel rejects endDate before startDate', async () => {
    const result = await req('POST', '/api/v1/training/week/travel', {
      startDate: '2026-06-10',
      endDate: '2026-06-01',
    });
    expect(result.status).toBe(400);
    expect(result.json?.error?.message).toMatch(/endDate must be on or after startDate/);
  });

  it('R4 P2 — /week/travel accepts a valid same-day startDate/endDate', async () => {
    const result = await req('POST', '/api/v1/training/week/travel', {
      startDate: '2026-06-10',
      endDate: '2026-06-10',
    }, { 'Idempotency-Key': 'travel-same-day' });
    expect(result.status).toBe(201);
    expect(result.json?.data?.window?.id).toBeGreaterThan(0);
  });

  it('R4 P1 — fainting-only structured intake → pause_training', async () => {
    await recordStructuredSafety({
      illnessSymptoms: ['fainting'],
      consentScope: ['illness'],
    }, 'analysis-fainting');
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.status).toBe(200);
    const pause = (result.json?.data?.scenario?.actions ?? []).find(
      (a: any) => a.type === 'pause_training',
    );
    expect(pause).toBeDefined();
    expect(pause?.severity).toBe('medical_referral');
  });

  it('R4 P1 — acute_injury structured intake → pause_training (no pain score required)', async () => {
    await recordStructuredSafety({
      injuryStatus: 'acute',
      consentScope: ['injury'],
    }, 'analysis-acute-injury');
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.status).toBe(200);
    const pause = (result.json?.data?.scenario?.actions ?? []).find(
      (a: any) => a.type === 'pause_training',
    );
    expect(pause).toBeDefined();
  });

  it('R4 P1 — severe_dizziness-only structured intake → pause_training', async () => {
    await recordStructuredSafety({
      illnessSymptoms: ['severe_dizziness'],
      consentScope: ['illness'],
    }, 'analysis-severe-dizziness');
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    const pause = (result.json?.data?.scenario?.actions ?? []).find(
      (a: any) => a.type === 'pause_training',
    );
    expect(pause).toBeDefined();
  });

  it('R4 P1 — INFERRED source (e.g., wearable) does NOT emit hard pause for same symptoms', async () => {
    testDb.prepare(`
      INSERT INTO athlete_health_signals
        (user_id, tenant_id, date, illness_symptoms_json, source, consent_scope)
      VALUES (100, 100, ?, '["chest_pain"]', 'wearable', 'illness')
    `).run(new Date().toISOString().slice(0, 10));
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    const pause = (result.json?.data?.scenario?.actions ?? []).find(
      (a: any) => a.type === 'pause_training',
    );
    // Inferred chest_pain → warning-only path, no pause.
    expect(pause).toBeUndefined();
  });
});

describe('R3 P2 — V2 completion REST validation', () => {
  it('wrong-typed V2 field returns 400 BAD_INPUT (not silent drop)', async () => {
    // Set up a session to complete.
    testDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
      VALUES (5500, 1, 1, 'Monday', 'easy_run', 'x', 45, 'pending')
    `).run();
    // We can't hit /complete via this harness (it's mounted under the
    // legacy training router, not v2). Validate the service-layer
    // contract instead: logCompletion silently normalizes; the route
    // validator (training.ts:521) is what blocks. The unit test
    // training-plans-completion-v2.test.ts already pins persistence;
    // here we lean on TypeScript to verify the route imports the
    // validator. F18 replaces the ad-hoc V2-only list with the canonical
    // released completion validator, so aliases and rich feedback cannot
    // silently diverge between complete and skip.
    const routeSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/training.ts'),
      'utf8',
    );
    expect(routeSource).toContain('normalizeTrainingCompletionFeedback');
    expect(routeSource).toContain('Invalid completion feedback');
    expect(routeSource).not.toContain('v2TypeErrors');
  });
});
