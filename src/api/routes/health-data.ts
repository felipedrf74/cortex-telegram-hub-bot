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
import { invalidateTrainingDerivedCaches } from '../../services/training-cache-invalidator';
import { sendInternalError as sendApiInternalError } from '../response-helpers';
import type { AuthenticatedRequest } from '../auth-middleware';
import type Database from 'better-sqlite3';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';

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
  respiratoryRate?: number | null;
  oxygenSaturation?: number | null;
  walkingHeartRateAverage?: number | null;
  bodyMassKg?: number | null;
  bodyFatPercentage?: number | null;
  leanBodyMassKg?: number | null;
  basalCalories?: number | null;
  exerciseMinutes?: number | null;
  workouts?: Array<{
    activityType?: number;
    workoutActivityType?: string;
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

function sendInternalError(res: Response, message: string): void {
  sendApiInternalError(res, message);
}

function prepareAppleHealthUpsert(db: Database.Database): Database.Statement {
  const tableInfo = db.prepare(`PRAGMA table_info(apple_health_data)`).all() as Array<{ name: string }>;
  const columnNames = new Set(tableInfo.map((row) => row.name));
  const sourceColumn = columnNames.has('source')
    ? 'source'
    : columnNames.has('source_name')
      ? 'source_name'
      : null;
  const hasSyncedAt = columnNames.has('synced_at');

  const insertColumns = ['user_id', 'date', 'data_type', 'data_json'];
  const insertValues = ['?', '?', '?', '?'];
  if (sourceColumn) {
    insertColumns.push(sourceColumn);
    insertValues.push(`'ios_app'`);
  }

  const updates = ['data_json = excluded.data_json'];
  if (hasSyncedAt) {
    updates.push(`synced_at = datetime('now')`);
  }

  const conflictTarget = sourceColumn === 'source_name'
    ? '(user_id, data_type, date, source_name)'
    : '(user_id, date, data_type)';

  return db.prepare(`
    INSERT INTO apple_health_data (${insertColumns.join(', ')})
    VALUES (${insertValues.join(', ')})
    ON CONFLICT${conflictTarget}
    DO UPDATE SET ${updates.join(', ')}
  `);
}

export function healthDataRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'health_data_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /** POST /api/v1/health-data/sync — receive a daily health snapshot from iOS */
  router.post('/sync', (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const payload = req.body as HealthSyncPayload;

    if (!payload.date || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
      return sendError(res, 'BAD_REQUEST', 'date is required in YYYY-MM-DD format');
    }

    try {
      const db = getDb();
      const upsert = prepareAppleHealthUpsert(db);

      let typesUpserted = 0;

      // ── HRV ────────────────────────────────────────────────
      if (payload.hrvMs != null) {
        upsert.run(userId, payload.date, 'hrv', JSON.stringify({
          value: payload.hrvMs,
          sdnn_ms: payload.hrvMs,
        }));
        typesUpserted++;
      }

      // ── Resting Heart Rate ─────────────────────────────────
      if (payload.restingHeartRate != null) {
        upsert.run(userId, payload.date, 'resting_heart_rate', JSON.stringify({
          value: payload.restingHeartRate,
          bpm: payload.restingHeartRate,
        }));
        typesUpserted++;
      }

      // ── Sleep ──────────────────────────────────────────────
      if ((payload.totalSleepMinutes ?? 0) > 0) {
        upsert.run(userId, payload.date, 'sleep', JSON.stringify({
          totalSleepSeconds: Math.round((payload.totalSleepMinutes ?? 0) * 60),
          deepSleepSeconds: Math.round((payload.deepSleepMinutes ?? 0) * 60),
          remSleepSeconds: Math.round((payload.remSleepMinutes ?? 0) * 60),
          coreSleepSeconds: Math.max(
            0,
            Math.round(((payload.totalSleepMinutes ?? 0) - (payload.deepSleepMinutes ?? 0) - (payload.remSleepMinutes ?? 0)) * 60),
          ),
          awakeSleepSeconds: 0,
          totalMinutes: payload.totalSleepMinutes ?? 0,
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

      // ── Body composition + metabolic context ─────────────────
      if (payload.bodyMassKg != null) {
        upsert.run(userId, payload.date, 'body_mass', JSON.stringify({ value: payload.bodyMassKg, kg: payload.bodyMassKg }));
        typesUpserted++;
      }

      if (payload.bodyFatPercentage != null) {
        upsert.run(
          userId,
          payload.date,
          'body_fat_percentage',
          JSON.stringify({ value: payload.bodyFatPercentage, percent: payload.bodyFatPercentage }),
        );
        typesUpserted++;
      }

      if (payload.leanBodyMassKg != null) {
        upsert.run(
          userId,
          payload.date,
          'lean_body_mass',
          JSON.stringify({ value: payload.leanBodyMassKg, kg: payload.leanBodyMassKg }),
        );
        typesUpserted++;
      }

      if ((payload.basalCalories ?? 0) > 0) {
        upsert.run(userId, payload.date, 'basal_calories', JSON.stringify({ kcal: payload.basalCalories }));
        typesUpserted++;
      }

      if ((payload.exerciseMinutes ?? 0) > 0) {
        upsert.run(userId, payload.date, 'exercise_minutes', JSON.stringify({ minutes: payload.exerciseMinutes }));
        typesUpserted++;
      }

      // ── Workouts ───────────────────────────────────────────
      if (payload.workouts && payload.workouts.length > 0) {
        upsert.run(userId, payload.date, 'workout', JSON.stringify(payload.workouts));
        typesUpserted++;
      }

      // ── Daily summary — raw health context for future scoring ──
      if (
        (payload.steps ?? 0) > 0
        || (payload.activeCalories ?? 0) > 0
        || payload.restingHeartRate != null
        || payload.vo2Max != null
        || payload.respiratoryRate != null
        || payload.oxygenSaturation != null
        || payload.walkingHeartRateAverage != null
        || payload.bodyMassKg != null
        || payload.bodyFatPercentage != null
        || payload.leanBodyMassKg != null
        || (payload.basalCalories ?? 0) > 0
        || (payload.exerciseMinutes ?? 0) > 0
        || (payload.totalSleepMinutes ?? 0) > 0
      ) {
        upsert.run(userId, payload.date, 'daily_summary', JSON.stringify({
          steps: payload.steps ?? null,
          activeCalories: payload.activeCalories ?? null,
          restingHeartRate: payload.restingHeartRate ?? null,
          vo2Max: payload.vo2Max ?? null,
          totalSleepMinutes: payload.totalSleepMinutes ?? null,
          deepSleepMinutes: payload.deepSleepMinutes ?? null,
          remSleepMinutes: payload.remSleepMinutes ?? null,
          respiratoryRate: payload.respiratoryRate ?? null,
          oxygenSaturation: payload.oxygenSaturation ?? null,
          walkingHeartRateAverage: payload.walkingHeartRateAverage ?? null,
          bodyMassKg: payload.bodyMassKg ?? null,
          bodyFatPercentage: payload.bodyFatPercentage ?? null,
          leanBodyMassKg: payload.leanBodyMassKg ?? null,
          basalCalories: payload.basalCalories ?? null,
          exerciseMinutes: payload.exerciseMinutes ?? null,
          workoutsCount: payload.workouts?.length ?? 0,
        }));
        typesUpserted++;
      }

      logger.info(
        { userId, date: payload.date, typesUpserted },
        'Apple Health data synced',
      );

      invalidateTrainingDerivedCaches(userId);
      sendSuccess(res, { date: payload.date, typesUpserted });
    } catch (err: any) {
      logger.error({ err, userId }, 'Health data sync failed');
      sendInternalError(res, 'Sync failed');
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
      sendInternalError(res, 'Query failed');
    }
  });

  return router;
}
