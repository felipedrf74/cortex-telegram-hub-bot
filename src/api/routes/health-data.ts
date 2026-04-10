// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// HealthKit data sync endpoint — receives daily health snapshots from
// the iOS app and stores them in apple_health_data for the
// AppleHealthAdapter to consume.
//
// The existing wearable provider abstraction already has an
// AppleHealthAdapter (src/services/wearable/apple-health-adapter.ts)
// that queries apple_health_data. This endpoint is the missing data
// input: iOS reads from HealthKit → POSTs here → backend stores →
// AppleHealthAdapter reads → WearableService returns normalized data →
// TrainingRepository / Dashboard consumes.
//
// The full data pipeline:
//   iOS HealthKitService.dailySnapshot()
//     ↓ POST /api/v1/health-data/sync
//   This endpoint (upserts into apple_health_data)
//     ↓ WearableService.getReadiness() / getDailySummary() / getSleep()
//   AppleHealthAdapter reads apple_health_data
//     ↓ NormalizedReadiness / NormalizedDailySummary / NormalizedSleep
//   TrainingRepository / DashboardViewModel / iOS UI

import { Router, Response } from 'express';
import { logger } from '../../utils/logger';
import { getDb } from '../../services/database';
import type { AuthenticatedRequest } from '../auth-middleware';

/** POST /api/v1/health-data/sync request body shape.
 *  Matches the iOS HealthDaySnapshot struct. */
interface HealthSyncPayload {
  date: string;             // YYYY-MM-DD
  hrvMs?: number | null;
  restingHeartRate?: number | null;
  steps?: number;
  activeCalories?: number;
  totalSleepMinutes?: number;
  deepSleepMinutes?: number;
  remSleepMinutes?: number;
  vo2Max?: number | null;
  workouts?: Array<{
    activityType: number;   // HKWorkoutActivityType raw value
    start: string;          // ISO8601
    end: string;
    durationMinutes: number;
    totalEnergyBurned?: number;
    totalDistance?: number;
    source: string;
  }>;
}

function sendSuccess(res: Response, data: Record<string, unknown> = {}): void {
  res.json({ ok: true, ...data });
}

function sendError(res: Response, code: string, message: string, status = 400): void {
  res.status(status).json({ ok: false, error: { code, message } });
}

export function healthDataRoutes(): Router {
  const router = Router();

  /** POST /api/v1/health-data/sync — receive a daily health snapshot from iOS */
  router.post('/sync', (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const payload = req.body as HealthSyncPayload;

    if (!payload.date || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
      return sendError(res, 'BAD_REQUEST', 'date is required in YYYY-MM-DD format');
    }

    try {
      const db = getDb();
      const upsert = db.prepare(`
        INSERT INTO apple_health_data (user_id, date, data_type, data_json, source)
        VALUES (?, ?, ?, ?, 'ios_app')
        ON CONFLICT(user_id, date, data_type)
        DO UPDATE SET data_json = excluded.data_json, synced_at = datetime('now')
      `);

      let typesUpserted = 0;

      // ── HRV ────────────────────────────────────────────────
      if (payload.hrvMs != null) {
        upsert.run(userId, payload.date, 'hrv', JSON.stringify({ sdnn_ms: payload.hrvMs }));
        typesUpserted++;
      }

      // ── Resting Heart Rate ─────────────────────────────────
      if (payload.restingHeartRate != null) {
        upsert.run(userId, payload.date, 'resting_hr', JSON.stringify({ bpm: payload.restingHeartRate }));
        typesUpserted++;
      }

      // ── Sleep ──────────────────────────────────────────────
      if ((payload.totalSleepMinutes ?? 0) > 0) {
        upsert.run(userId, payload.date, 'sleep', JSON.stringify({
          totalMinutes: payload.totalSleepMinutes,
          deepMinutes: payload.deepSleepMinutes ?? 0,
          remMinutes: payload.remSleepMinutes ?? 0,
        }));
        typesUpserted++;
      }

      // ── Steps ──────────────────────────────────────────────
      if ((payload.steps ?? 0) > 0) {
        upsert.run(userId, payload.date, 'steps', JSON.stringify({ count: payload.steps }));
        typesUpserted++;
      }

      // ── Active Calories ────────────────────────────────────
      if ((payload.activeCalories ?? 0) > 0) {
        upsert.run(userId, payload.date, 'calories', JSON.stringify({ kcal: payload.activeCalories }));
        typesUpserted++;
      }

      // ── VO2 Max ────────────────────────────────────────────
      if (payload.vo2Max != null) {
        upsert.run(userId, payload.date, 'vo2max', JSON.stringify({ value: payload.vo2Max }));
        typesUpserted++;
      }

      // ── Workouts ───────────────────────────────────────────
      if (payload.workouts && payload.workouts.length > 0) {
        upsert.run(userId, payload.date, 'workouts', JSON.stringify(payload.workouts));
        typesUpserted++;
      }

      logger.info(
        { userId, date: payload.date, typesUpserted },
        'Apple Health data synced',
      );

      sendSuccess(res, { date: payload.date, typesUpserted });
    } catch (err: any) {
      logger.error({ err, userId }, 'Health data sync failed');
      sendError(res, 'INTERNAL', err?.message || 'Sync failed', 500);
    }
  });

  /** GET /api/v1/health-data/latest — returns the most recent sync date
   *  and data availability per type. Used by the iOS Settings health
   *  section to show "last synced: ..." without fetching full data. */
  router.get('/latest', (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT data_type, MAX(date) as latest_date, MAX(synced_at) as latest_sync
        FROM apple_health_data
        WHERE user_id = ?
        GROUP BY data_type
      `).all(userId) as Array<{ data_type: string; latest_date: string; latest_sync: string }>;

      sendSuccess(res, { types: rows });
    } catch (err: any) {
      logger.error({ err, userId }, 'Health data latest query failed');
      sendError(res, 'INTERNAL', err?.message || 'Query failed', 500);
    }
  });

  return router;
}
