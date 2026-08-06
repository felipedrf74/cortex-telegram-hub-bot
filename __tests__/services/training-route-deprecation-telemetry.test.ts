// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  TRAINING_SUMMARY_ROUTE_PATH,
  readTrainingSummaryDeprecationUsage,
  recordTrainingSummaryDeprecationHit,
} from '../../src/services/training-route-deprecation-telemetry';

describe('Training summary deprecation telemetry (F37)', () => {
  let db: ReturnType<typeof createMigratedTestDatabase>;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => {
    db?.close();
  });

  it('persists only an exact-path daily aggregate across callers and processes', () => {
    recordTrainingSummaryDeprecationHit(db, new Date('2026-08-02T01:00:00.000Z'));
    recordTrainingSummaryDeprecationHit(db, new Date('2026-08-02T23:00:00.000Z'));
    recordTrainingSummaryDeprecationHit(db, new Date('2026-08-01T23:00:00.000Z'));

    expect(readTrainingSummaryDeprecationUsage(db, {
      now: new Date('2026-08-02T23:30:00.000Z'),
      windowDays: 2,
    })).toEqual({
      routePath: TRAINING_SUMMARY_ROUTE_PATH,
      windowDays: 2,
      requestCount: 3,
      firstHitDate: '2026-08-01',
      lastHitDate: '2026-08-02',
    });

    const columns = db.prepare('PRAGMA table_info(api_route_deprecation_metrics_daily)')
      .all()
      .map((row: any) => row.name);
    expect(columns).toEqual(['metric_date', 'route_path', 'request_count', 'updated_at']);
    expect(columns).not.toEqual(expect.arrayContaining([
      'user_id', 'tenant_id', 'query', 'body', 'headers', 'response',
    ]));
  });

  it('reports no evidence explicitly instead of treating silence as removal authority', () => {
    expect(readTrainingSummaryDeprecationUsage(db, {
      now: new Date('2026-08-02T23:30:00.000Z'),
      windowDays: 30,
    })).toEqual({
      routePath: TRAINING_SUMMARY_ROUTE_PATH,
      windowDays: 30,
      requestCount: 0,
      firstHitDate: null,
      lastHitDate: null,
    });
  });
});
