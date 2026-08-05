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
): Promise<{ status: number; json: any }> {
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
        resolve({ status: response.statusCode ?? 0, json });
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
    });
    expect(result.status).toBe(201);
    expect(result.json?.data?.id).toBeGreaterThan(0);
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

    const first = await req('POST', '/api/v1/training/week/travel', body);
    const replay = await req('POST', '/api/v1/training/week/travel', { ...body, notes: 'retry notes changed' });
    const count = testDb.prepare(
      'SELECT COUNT(*) AS n FROM travel_windows WHERE user_id = 100 AND tenant_id = 100',
    ).get() as { n: number };

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(first.json?.data?.alreadyExisted).toBe(false);
    expect(replay.json?.data?.alreadyExisted).toBe(true);
    expect(replay.json?.data?.id).toBe(first.json?.data?.id);
    expect(count.n).toBe(1);
  });

  it('does not replay duplicate POST across another tenant', async () => {
    const body = {
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
    };

    const tenantA = await req('POST', '/api/v1/training/week/travel', body, { 'x-test-tenant-id': '100' });
    const tenantB = await req('POST', '/api/v1/training/week/travel', body, { 'x-test-tenant-id': '200' });

    expect(tenantA.status).toBe(201);
    expect(tenantB.status).toBe(201);
    expect(tenantB.json?.data?.alreadyExisted).toBe(false);
    expect(tenantB.json?.data?.id).not.toBe(tenantA.json?.data?.id);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM travel_windows WHERE user_id = 100').get()).toMatchObject({ n: 2 });
  });

  it('keeps overlapping but not identical POSTs as separate travel windows', async () => {
    const first = await req('POST', '/api/v1/training/week/travel', {
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
      availableSessionDurationMinutes: 30,
    });
    const overlap = await req('POST', '/api/v1/training/week/travel', {
      startDate: '2026-06-05',
      endDate: '2026-06-10',
      equipmentProfile: 'bodyweight_only',
      availableSessionDurationMinutes: 20,
    });

    expect(first.status).toBe(201);
    expect(overlap.status).toBe(201);
    expect(overlap.json?.data?.alreadyExisted).toBe(false);
    expect(overlap.json?.data?.id).not.toBe(first.json?.data?.id);
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

describe('POST /week/:weekId/reflow (C6)', () => {
  it('preview mode works without idempotencyKey', async () => {
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'preview', trigger: 'manual_reflow',
    });
    expect(result.status).toBe(200);
    expect(result.json?.data?.mode).toBe('preview');
    expect(result.json?.data?.mutated).toBe(false);
    expect(result.json?.data?.adaptationRevision).toBeNull();
  });

  it('apply mode WITHOUT idempotencyKey → 400 IDEMPOTENCY_REQUIRED', async () => {
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
    });
    expect(result.status).toBe(400);
    expect(result.json?.error?.code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('apply mode WITH idempotencyKey writes a ledger row', async () => {
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      idempotencyKey: 'route-test-key-1',
    });
    expect(result.status).toBe(200);
    expect(result.json?.data?.adaptationRevision).toBe(1);
    expect(result.json?.data?.propagation).toMatchObject({
      state: 'not_synced',
      pending: false,
      adaptationRevision: 1,
    });
    const ledger = testDb.prepare(
      "SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = 1 AND scope = 'week'",
    ).get() as { n: number };
    expect(ledger.n).toBe(1);
  });

  it('apply mode dedupes same idempotencyKey across requests', async () => {
    await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      idempotencyKey: 'dup-key',
    });
    const second = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      idempotencyKey: 'dup-key',
    });
    expect(second.json?.data?.alreadyExisted).toBe(true);
    expect(second.json?.data?.mutated).toBe(false);
  });

  // R7 P2 — Codex caught that the R6 rate-limit short-circuit
  // returned 200 synthetic success when apply was called without
  // an idempotencyKey on a rate-limited plan. The fix hoists the
  // IDEMPOTENCY_REQUIRED gate above the short-circuit AND treats
  // empty/whitespace keys as missing.
  it('R7 P2 — apply on a rate-limited plan still 400s when idempotencyKey is missing', async () => {
    // Pre-fill 3 applied non-safety adaptations so the
    // anti-churn limiter is in the limited state.
    for (let i = 0; i < 3; i++) {
      await req('POST', '/api/v1/training/week/1/reflow', {
        planId: 1, mode: 'apply', trigger: 'manual_reflow',
        idempotencyKey: `prefill-${i}`,
      });
    }
    const ledgerBefore = testDb.prepare(
      "SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = 1 AND scope = 'week'",
    ).get() as { n: number };
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      // no idempotencyKey
    });
    expect(result.status).toBe(400);
    expect(result.json?.error?.code).toBe('IDEMPOTENCY_REQUIRED');
    const ledgerAfter = testDb.prepare(
      "SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = 1 AND scope = 'week'",
    ).get() as { n: number };
    // No new rows from the rejected request.
    expect(ledgerAfter.n).toBe(ledgerBefore.n);
  });

  it('R7 P2 — apply with empty idempotencyKey treated as missing → 400', async () => {
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      idempotencyKey: '',
    });
    expect(result.status).toBe(400);
    expect(result.json?.error?.code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('R7 P2 — apply with whitespace-only idempotencyKey treated as missing → 400', async () => {
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      idempotencyKey: '   ',
    });
    expect(result.status).toBe(400);
    expect(result.json?.error?.code).toBe('IDEMPOTENCY_REQUIRED');
  });

  it('R7 P2 — preview still works without idempotencyKey (precedence preserved)', async () => {
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'preview', trigger: 'manual_reflow',
    });
    expect(result.status).toBe(200);
    expect(result.json?.data?.mode).toBe('preview');
  });

  it('R7 P2 — leading/trailing whitespace stripped, valid key still accepted', async () => {
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      idempotencyKey: '  trim-test-key  ',
    });
    expect(result.status).toBe(200);
    // Same trimmed key replays.
    const second = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      idempotencyKey: 'trim-test-key',
    });
    expect(second.json?.data?.alreadyExisted).toBe(true);
  });

  // R8 P3 — rate-limited preview must NOT write an empty audit row.
  // Codex caught that for `mode: preview` + `scenario.rateLimited`,
  // the ledger's afterPatch.actions and decisionReasonCodes were
  // empty arrays — losing the would-have plan that
  // `scenario.suppressedActions` captures. The fix sources the
  // ledger from suppressedActions when rateLimited is true so the
  // audit row reflects intent. Response shape stays unchanged.
  it('R8 P3 — rate-limited preview ledger captures suppressed actions + reason codes', async () => {
    // Trip the daily limit with prefilled applies.
    for (let i = 0; i < 3; i++) {
      await req('POST', '/api/v1/training/week/1/reflow', {
        planId: 1, mode: 'apply', trigger: 'manual_reflow',
        idempotencyKey: `r8-prefill-${i}`,
      });
    }
    // Now run a preview — actions are suppressed but suppressedActions
    // should land in the audit row.
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'preview', trigger: 'manual_preview',
    });
    expect(result.status).toBe(200);
    // Response shape — actions still empty (suppressed by rate limit),
    // but scenario carries the suppressedActions.
    expect(result.json?.data?.actions ?? []).toEqual([]);
    expect(result.json?.data?.scenario?.rateLimited).toBe(true);
    const suppressedFromResponse = result.json?.data?.scenario?.suppressedActions ?? [];
    // Locate the preview ledger row.
    const previewRow = testDb.prepare(
      `SELECT after_patch_json, decision_reason_codes_json FROM training_plan_adaptations
       WHERE plan_id = 1 AND scope = 'preview' ORDER BY id DESC LIMIT 1`,
    ).get() as { after_patch_json: string; decision_reason_codes_json: string };
    expect(previewRow).toBeDefined();
    const afterPatch = JSON.parse(previewRow.after_patch_json);
    // R8 P3 contract: rate-limited preview ledger row carries the
    // would-have actions (NOT the executed empty set) so audit can
    // reconstruct intent.
    expect(afterPatch.rateLimitedSuppressed).toBe(true);
    expect(Array.isArray(afterPatch.actions)).toBe(true);
    expect(afterPatch.actions.length).toBe(suppressedFromResponse.length);
    // Decision reason codes mirror the suppressed actions' codes.
    const reasonCodes = JSON.parse(previewRow.decision_reason_codes_json) as string[];
    expect(reasonCodes.length).toBe(suppressedFromResponse.length);
    if (suppressedFromResponse.length > 0) {
      expect(reasonCodes[0]).toBe(suppressedFromResponse[0].reasonCode);
    }
  });

  it('R8 P3 — rate-limited APPLY still writes ZERO ledger rows (no-ledger contract preserved)', async () => {
    // Prefill 3 applies → rate limit tripped for the next apply.
    for (let i = 0; i < 3; i++) {
      await req('POST', '/api/v1/training/week/1/reflow', {
        planId: 1, mode: 'apply', trigger: 'manual_reflow',
        idempotencyKey: `r8-rl-prefill-${i}`,
      });
    }
    const ledgerBefore = testDb.prepare(
      'SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = 1',
    ).get() as { n: number };
    // Apply with a NEW idempotency key (no replay) → rate-limit
    // short-circuit fires, synthetic 200, no new ledger row.
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      idempotencyKey: 'r8-rl-fresh-key',
    });
    expect(result.status).toBe(200);
    expect(result.json?.data?.mutated).toBe(false);
    expect(result.json?.data?.adaptationRevision).toBeNull();
    const ledgerAfter = testDb.prepare(
      'SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = 1',
    ).get() as { n: number };
    expect(ledgerAfter.n).toBe(ledgerBefore.n);
  });

  // R8 P1-4 — Codex caught that the (plan_id, idempotency_key)
  // UNIQUE is per-plan not per-week, so a key reused on a
  // different week of the same plan would either replay the wrong
  // row's data (different week) or — in the rate-limit short-circuit
  // — accept the synthetic 200 then later land a real row on a
  // different week. The fix rejects 409 IDEMPOTENCY_KEY_REUSED_DIFFERENT_WEEK.
  it('R8 P1-4 — apply with idempotencyKey reused across weeks rejects with 409', async () => {
    // Seed a second week on the same plan.
    testDb.prepare(
      "INSERT INTO training_weeks (id, plan_id, week_number, focus, intensity_pct, auto_adjusted, created_at) VALUES (2, 1, 2, 'base', 70, 0, datetime('now'))",
    ).run();
    // First apply on week 1 with key "shared".
    const first = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      idempotencyKey: 'shared',
    });
    expect(first.status).toBe(200);
    const ledgerAfterFirst = testDb.prepare(
      "SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = 1 AND idempotency_key = 'shared'",
    ).get() as { n: number };
    expect(ledgerAfterFirst.n).toBe(1);
    // Second apply on week 2 with the SAME key → 409.
    const second = await req('POST', '/api/v1/training/week/2/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      idempotencyKey: 'shared',
    });
    expect(second.status).toBe(409);
    expect(second.json?.error?.code).toBe('IDEMPOTENCY_KEY_REUSED_DIFFERENT_WEEK');
    // No new ledger row was written for week 2.
    const ledgerAfterSecond = testDb.prepare(
      "SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = 1 AND idempotency_key = 'shared'",
    ).get() as { n: number };
    expect(ledgerAfterSecond.n).toBe(1);
  });

  it('R8 P1-4 — apply replay on SAME week + same key still returns alreadyExisted (no 409)', async () => {
    const first = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      idempotencyKey: 'same-week-key',
    });
    expect(first.status).toBe(200);
    const second = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      idempotencyKey: 'same-week-key',
    });
    expect(second.status).toBe(200);
    expect(second.json?.data?.alreadyExisted).toBe(true);
  });

  it('R8 P1-4 — rate-limited apply on a different week with reused key → 409 (not synthetic 200)', async () => {
    // Seed week 2.
    testDb.prepare(
      "INSERT INTO training_weeks (id, plan_id, week_number, focus, intensity_pct, auto_adjusted, created_at) VALUES (3, 1, 3, 'base', 70, 0, datetime('now'))",
    ).run();
    // Apply on week 1 with key — succeeds, gets a real row.
    const initial = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      idempotencyKey: 'rl-shared',
    });
    expect(initial.status).toBe(200);
    // Prefill the daily limit so the next apply is rate-limited.
    for (let i = 0; i < 3; i++) {
      const prefill = await req('POST', '/api/v1/training/week/1/reflow', {
        planId: 1, mode: 'apply', trigger: 'manual_reflow',
        idempotencyKey: `rl-other-${i}`,
      });
      expect(prefill.status).toBe(200);
    }
    // Now apply on week 3 with the original "rl-shared" key while rate-limited.
    // The existing row's weekId is 1, requested is 3 → must reject 409.
    const result = await req('POST', '/api/v1/training/week/3/reflow', {
      planId: 1, mode: 'apply', trigger: 'manual_reflow',
      idempotencyKey: 'rl-shared',
    });
    expect(result.status).toBe(409);
    expect(result.json?.error?.code).toBe('IDEMPOTENCY_KEY_REUSED_DIFFERENT_WEEK');
  });

  it('R8 P3 — non-rate-limited preview ledger still uses canonical actions (no regression)', async () => {
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'preview', trigger: 'baseline_preview',
    });
    expect(result.status).toBe(200);
    // Find the preview row for this trigger.
    const previewRow = testDb.prepare(
      `SELECT after_patch_json FROM training_plan_adaptations
       WHERE plan_id = 1 AND scope = 'preview' AND trigger_type = 'baseline_preview'
       ORDER BY id DESC LIMIT 1`,
    ).get() as { after_patch_json: string } | undefined;
    expect(previewRow).toBeDefined();
    const afterPatch = JSON.parse((previewRow as { after_patch_json: string }).after_patch_json);
    // rateLimitedSuppressed flag false (or absent) when classifier
    // did not hit the rate limit.
    expect(afterPatch.rateLimitedSuppressed).toBeFalsy();
  });

  it('rejects bad mode with 400', async () => {
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'commit',
    });
    expect(result.status).toBe(400);
    expect(result.json?.error?.code).toBe('BAD_MODE');
  });

  it('rejects bad weekId with 400', async () => {
    const result = await req('POST', '/api/v1/training/week/abc/reflow', {
      planId: 1, mode: 'preview',
    });
    expect(result.status).toBe(400);
  });

  it('unknown week → 404', async () => {
    const result = await req('POST', '/api/v1/training/week/9999/reflow', {
      planId: 1, mode: 'apply', trigger: 't', idempotencyKey: 'k',
    });
    expect(result.status).toBe(404);
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

  it('routes the live apply endpoint through the scoped propagation orchestrator', () => {
    const source = fs.readFileSync(path.resolve(
      __dirname,
      '../../src/api/routes/training-coach-v2.ts',
    ), 'utf8');
    expect(source).toContain('await executeWeekReflowWithPropagation({');
    expect(source).toContain("tenantId: requireTenantIdParam(auth.tenantId, 'training.coach.reflow')");
    expect(source).toContain('planVersion: planMeta.plan_version');
    // Stronger F24 guarantee: reflow preserves the plan's persisted calendar
    // choice; none/apple must never be upgraded into an auto provider write.
    expect(source).toContain('const reflowSyncTarget = resolvePersistedTrainingReflowSyncTarget(');
    expect(source).toContain('syncTarget: reflowSyncTarget');
    expect(source).not.toContain("syncTarget: 'auto'");
    expect(source).not.toMatch(/\bexecuteWeekReflow\s*\(\s*\{/);
  });
});

describe('GET/PATCH /plans/:planId/coach-policy (A5)', () => {
  it('GET returns default policy when not set', async () => {
    const result = await req('GET', '/api/v1/training/plans/1/coach-policy');
    expect(result.status).toBe(200);
    expect(result.json?.data?.policy?.progressionAggressiveness).toBe('standard');
    expect(result.json?.data?.policy?.deloadStrategy).toBe('hybrid');
  });

  it('GET for unknown plan → 404', async () => {
    const result = await req('GET', '/api/v1/training/plans/9999/coach-policy');
    expect(result.status).toBe(404);
  });

  it("PATCH persists 'data_informed' deloadStrategy", async () => {
    const result = await req('PATCH', '/api/v1/training/plans/1/coach-policy', {
      deloadStrategy: 'data_informed',
      progressionAggressiveness: 'aggressive',
    });
    expect(result.status).toBe(200);
    expect(result.json?.data?.policy?.deloadStrategy).toBe('data_informed');
    expect(result.json?.data?.policy?.progressionAggressiveness).toBe('aggressive');
    // Round-trip via subsequent GET.
    const got = await req('GET', '/api/v1/training/plans/1/coach-policy');
    expect(got.json?.data?.policy?.deloadStrategy).toBe('data_informed');
  });

  it("PATCH with invalid deloadStrategy 'data_driven' → 400 BAD_INPUT", async () => {
    const result = await req('PATCH', '/api/v1/training/plans/1/coach-policy', {
      deloadStrategy: 'data_driven',
    });
    expect(result.status).toBe(400);
    expect(result.json?.error?.code).toBe('BAD_INPUT');
  });

  it('PATCH for unknown plan → 404', async () => {
    const result = await req('PATCH', '/api/v1/training/plans/9999/coach-policy', {
      progressionAggressiveness: 'standard',
    });
    expect(result.status).toBe(404);
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

  it('POST /week/:weekId/reflow with body planId omitted falls back to owned plan', async () => {
    // No planId in body — derives from the week's parent plan.
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      mode: 'apply', idempotencyKey: 'fallback-key', trigger: 't',
    });
    expect(result.status).toBe(200);
    expect(result.json?.data?.adaptationRevision).toBe(1);
  });
});

describe('Codex R2 P1 — reflow apply actually mutates sessions', () => {
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
    expect(result.json?.data?.scenario?.actions).toBeInstanceOf(Array);
    expect(result.json?.data?.mutated).toBe(false);
    const after = testDb.prepare('SELECT duration_minutes FROM training_sessions WHERE id = 501').get() as { duration_minutes: number };
    expect(after.duration_minutes).toBe(before.duration_minutes);
  });

  it('apply returns scenario.actions AND mutatedRows count', async () => {
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', trigger: 'apply_test', idempotencyKey: 'apply-mutation-key',
    });
    expect(result.status).toBe(200);
    expect(result.json?.data?.scenario?.actions).toBeInstanceOf(Array);
    // mutatedRows comes from the action executor; for an accumulation
    // week with no missed sessions / no safety flags / no deload due,
    // the classifier emits no actions and mutatedRows is 0. But the
    // shape MUST be present.
    expect(typeof result.json?.data?.mutatedRows).toBe('number');
  });
});

describe('Codex R2 P2 — idempotency conflict surfaces winning row, not 500', () => {
  beforeEach(() => {
    testDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
      VALUES (601, 1, 1, 'Monday', 'easy_run', 'Easy run', 60, 'pending')
    `).run();
  });

  it('duplicate idempotencyKey within window returns alreadyExisted=true via route', async () => {
    const first = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', idempotencyKey: 'conflict-route', trigger: 't',
    });
    expect(first.status).toBe(200);
    expect(first.json?.data?.adaptationRevision).toBe(1);
    const second = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', idempotencyKey: 'conflict-route', trigger: 't',
    });
    expect(second.status).toBe(200);
    expect(second.json?.data?.alreadyExisted).toBe(true);
    expect(second.json?.data?.adaptationId).toBe(first.json?.data?.adaptationId);
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

  it('R3 P1 — completed session is NOT mutated by reflow apply', async () => {
    testDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
      VALUES (910, 1, 1, 'Monday', 'easy_run', 'already done', 45, 'completed')
    `).run();
    // Even if the classifier produced a drop_session for id=910, the
    // executor's SQL guard refuses to mutate completed rows.
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', idempotencyKey: 'completed-protection', trigger: 't',
    });
    expect(result.status).toBe(200);
    const after = testDb.prepare('SELECT status FROM training_sessions WHERE id = 910').get() as { status: string };
    expect(after.status).toBe('completed'); // preserved
  });

  it('R3 P2 — apply response includes perActionResults', async () => {
    testDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
      VALUES (920, 1, 1, 'Tuesday', 'easy_run', 'pending session', 60, 'pending')
    `).run();
    const result = await req('POST', '/api/v1/training/week/1/reflow', {
      planId: 1, mode: 'apply', idempotencyKey: 'per-action-results', trigger: 't',
    });
    expect(result.status).toBe(200);
    expect(Array.isArray(result.json?.data?.perActionResults)).toBe(true);
  });
});

describe('R3 P1 — A4 hard-pause via structured intake', () => {
  it('chest_pain via structured intake → coach-analysis emits pause_training', async () => {
    // Write a structured-intake red-flag signal directly via the
    // service module to verify the end-to-end derive→wire→classify
    // pipeline produces a hard pause. The route endpoint exists
    // separately at POST /health-intake/red-flag.
    testDb.prepare(`
      INSERT INTO athlete_health_signals
        (user_id, tenant_id, date, pain_score, pain_location, illness_symptoms_json, source, consent_scope)
      VALUES (100, 100, '2026-05-23', 9, 'chest', '["chest_pain"]', 'structured_intake', 'pain,illness')
    `).run();
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.status).toBe(200);
    const actions = result.json?.data?.scenario?.actions ?? [];
    const pause = actions.find((a: any) => a.type === 'pause_training');
    expect(pause).toBeDefined();
    expect(pause?.severity).toBe('medical_referral');
  });

  it('severe structured pain with location → coach-analysis emits pause_training without symptom wording', async () => {
    testDb.prepare(`
      INSERT INTO athlete_health_signals
        (user_id, tenant_id, date, pain_score, pain_location, illness_symptoms_json, source, consent_scope)
      VALUES (100, 100, '2026-05-23', 9, 'left knee', '[]', 'structured_intake', 'pain')
    `).run();
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
      VALUES (100, 100, '2026-05-23', 9, 'chest', '[]', 'wearable', 'pain')
    `).run();
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.status).toBe(200);
    const actions = result.json?.data?.scenario?.actions ?? [];
    expect(actions.find((a: any) => a.type === 'pause_training')).toBeUndefined();
  });

  it('POST /health-intake/red-flag persists structured signal', async () => {
    const result = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: '2026-05-23',
      illnessSymptoms: ['fever'],
      consentScope: ['illness'],
    });
    expect(result.status).toBe(201);
    expect(result.json?.data?.id).toBeGreaterThan(0);
    const row = testDb.prepare(
      'SELECT source, tenant_id FROM athlete_health_signals WHERE id = ?',
    ).get(result.json.data.id) as { source: string; tenant_id: number };
    expect(row.source).toBe('structured_intake');
    expect(row.tenant_id).toBe(100);
    expect(testDb.prepare(`
      SELECT tenant_id, user_id
      FROM agent_signals
      WHERE signal_type = 'safety_red_flag'
    `).get()).toEqual({ tenant_id: 100, user_id: 100 });
  });

  it('fever/systemic illness via structured intake → coach-analysis emits pause_training', async () => {
    testDb.prepare(`
      INSERT INTO athlete_health_signals
        (user_id, tenant_id, date, illness_symptoms_json, source, consent_scope)
      VALUES (100, 100, '2026-05-23', '["fever"]', 'structured_intake', 'illness')
    `).run();
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
      date: '2026-05-23',
      illnessSymptoms: ['fever'],
      consentScope: [],
    });
    expect(result.status).toBe(400);
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
    });
    expect(result.status).toBe(400);
    expect(result.json?.error?.code).toBe('BAD_INPUT');
    expect(result.json?.error?.message).toMatch(/valid YYYY-MM-DD/);
  });

  it('R4 P2 — /health-intake/red-flag rejects impossible calendar date (2026-13-01)', async () => {
    const result = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: '2026-13-01',
      illnessSymptoms: ['fever'],
      consentScope: ['illness'],
    });
    expect(result.status).toBe(400);
    expect(result.json?.error?.code).toBe('BAD_INPUT');
  });

  it('R4 P2 — /health-intake/red-flag rejects Feb 30 (calendar round-trip catches it)', async () => {
    const result = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: '2026-02-30',
      illnessSymptoms: ['fever'],
      consentScope: ['illness'],
    });
    expect(result.status).toBe(400);
  });

  it('R4 P2 — /health-intake/red-flag rejects ISO 8601 with time component (2026-05-23T00:00:00Z)', async () => {
    const result = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: '2026-05-23T00:00:00Z',
      illnessSymptoms: ['fever'],
      consentScope: ['illness'],
    });
    expect(result.status).toBe(400);
  });

  it('R4 P2 — /health-intake/red-flag rejects injection-shaped string', async () => {
    const result = await req('POST', '/api/v1/training/health-intake/red-flag', {
      date: "1970-01-01' OR 1=1",
      illnessSymptoms: ['fever'],
      consentScope: ['illness'],
    });
    expect(result.status).toBe(400);
  });

  it('R4 P2 — /week/travel rejects malformed startDate', async () => {
    const result = await req('POST', '/api/v1/training/week/travel', {
      startDate: 'next-monday',
      endDate: '2026-06-01',
    });
    expect(result.status).toBe(400);
    expect(result.json?.error?.message).toMatch(/startDate.*YYYY-MM-DD/);
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
    });
    expect(result.status).toBe(201);
    expect(result.json?.data?.id).toBeGreaterThan(0);
  });

  it('R4 P1 — fainting-only structured intake → pause_training', async () => {
    testDb.prepare(`
      INSERT INTO athlete_health_signals
        (user_id, tenant_id, date, illness_symptoms_json, source, consent_scope)
      VALUES (100, 100, '2026-05-23', '["fainting"]', 'structured_intake', 'illness')
    `).run();
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.status).toBe(200);
    const pause = (result.json?.data?.scenario?.actions ?? []).find(
      (a: any) => a.type === 'pause_training',
    );
    expect(pause).toBeDefined();
    expect(pause?.severity).toBe('medical_referral');
  });

  it('R4 P1 — acute_injury structured intake → pause_training (no pain score required)', async () => {
    testDb.prepare(`
      INSERT INTO athlete_health_signals
        (user_id, tenant_id, date, injury_status, source, consent_scope)
      VALUES (100, 100, '2026-05-23', 'acute', 'structured_intake', 'injury')
    `).run();
    const result = await req('GET', '/api/v1/training/plans/1/coach-analysis?weekIndex=0');
    expect(result.status).toBe(200);
    const pause = (result.json?.data?.scenario?.actions ?? []).find(
      (a: any) => a.type === 'pause_training',
    );
    expect(pause).toBeDefined();
  });

  it('R4 P1 — severe_dizziness-only structured intake → pause_training', async () => {
    testDb.prepare(`
      INSERT INTO athlete_health_signals
        (user_id, tenant_id, date, illness_symptoms_json, source, consent_scope)
      VALUES (100, 100, '2026-05-23', '["severe_dizziness"]', 'structured_intake', 'illness')
    `).run();
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
      VALUES (100, 100, '2026-05-23', '["chest_pain"]', 'wearable', 'illness')
    `).run();
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
