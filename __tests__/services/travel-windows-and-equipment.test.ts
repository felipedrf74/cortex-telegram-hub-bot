/**
 * Slices C2 + C3 — travel windows + per-week equipment override.
 *
 * Pins:
 *   - Migrations 161 + 214 create travel_windows table, equipment_override column,
 *     and tenant-scoped travel-window reads
 *   - recordTravelWindow persists all fields
 *   - findTravelWindowsInRange finds overlapping windows
 *   - computeTravelStressScore combines flags into [0..1]
 *   - setWeekEquipmentOverride / getWeekEquipmentOverride round-trip
 *   - clearWeekEquipmentOverride sets column to NULL
 *   - startDate > endDate throws
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));


import {
  computeTravelStressScore,
  deleteTravelWindow,
  deleteTravelWindowIdempotently,
  findTravelWindowsInRange,
  getTravelWindowById,
  listTravelWindows,
  recordTravelWindow,
  TravelWindowIdempotencyConflictError,
  TravelWindowVersionConflictError,
  updateTravelWindow,
  updateTravelWindowIdempotently,
} from '../../src/services/travel-windows';
import {
  clearWeekEquipmentOverride,
  getWeekEquipmentOverride,
  setWeekEquipmentOverride,
} from '../../src/services/week-equipment-override';

beforeEach(() => {
  testDb = createMigratedTestDatabase();
});

afterEach(() => testDb.close());

describe('travel-window migrations', () => {
  it('creates travel_windows with expected columns', () => {
    const cols = testDb.prepare("PRAGMA table_info('travel_windows')").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('user_id')).toBe(true);
    expect(names.has('tenant_id')).toBe(true);
    expect(names.has('start_date')).toBe(true);
    expect(names.has('end_date')).toBe(true);
    expect(names.has('time_zone_shift_hours')).toBe(true);
    expect(names.has('sleep_disruption_expected')).toBe(true);
    expect(names.has('walking_load_expected')).toBe(true);
    expect(names.has('heat_stress')).toBe(true);
  });

  it('adds equipment_override_json to training_weeks', () => {
    const cols = testDb.prepare("PRAGMA table_info('training_weeks')").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'equipment_override_json')).toBe(true);
  });
});

describe('recordTravelWindow', () => {
  it('persists all fields', () => {
    const result = recordTravelWindow({
      userId: 100,
      tenantId: 1000,
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
      timeZoneShiftHours: 6,
      flightDurationHours: 8,
      sleepDisruptionExpected: true,
      walkingLoadExpected: true,
      heatStress: true,
      availableSessionDurationMinutes: 30,
      notes: 'work trip',
    });
    expect(result.id).toBeGreaterThan(0);
    const row = testDb.prepare('SELECT * FROM travel_windows WHERE id = ?').get(result.id) as {
      tenant_id: number; time_zone_shift_hours: number; sleep_disruption_expected: number; notes: string;
    };
    expect(row.tenant_id).toBe(1000);
    expect(row.time_zone_shift_hours).toBe(6);
    expect(row.sleep_disruption_expected).toBe(1);
    expect(row.notes).toBe('work trip');
  });

  it('rejects startDate > endDate', () => {
    expect(() => recordTravelWindow({
      userId: 100, startDate: '2026-06-10', endDate: '2026-06-01',
    })).toThrow(/startDate/);
  });

  it('treats notes as part of travel identity and idempotency', () => {
    const first = recordTravelWindow({
      userId: 100,
      tenantId: 1000,
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
      timeZoneShiftHours: 6,
      sleepDisruptionExpected: true,
      availableSessionDurationMinutes: 30,
      notes: 'first note',
    });
    const distinct = recordTravelWindow({
      userId: 100,
      tenantId: 1000,
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
      timeZoneShiftHours: 6,
      sleepDisruptionExpected: true,
      availableSessionDurationMinutes: 30,
      notes: 'second note creates an honestly distinct window',
    });

    const count = testDb.prepare('SELECT COUNT(*) AS n FROM travel_windows WHERE user_id = 100 AND tenant_id = 1000').get() as { n: number };
    expect(distinct.id).not.toBe(first.id);
    expect(first.alreadyExisted).toBe(false);
    expect(distinct.alreadyExisted).toBe(false);
    expect(count.n).toBe(2);

    const keyed = recordTravelWindow({
      userId: 101,
      tenantId: 1000,
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      notes: 'original',
      idempotencyKey: 'travel-notes-identity',
    });
    expect(() => recordTravelWindow({
      userId: 101,
      tenantId: 1000,
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      notes: 'changed',
      idempotencyKey: 'travel-notes-identity',
    })).toThrow(TravelWindowIdempotencyConflictError);
    expect(keyed.alreadyExisted).toBe(false);
  });

  it('does not replay duplicate logical window across different tenants', () => {
    const tenantA = recordTravelWindow({
      userId: 100,
      tenantId: 1000,
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
    });
    const tenantB = recordTravelWindow({
      userId: 100,
      tenantId: 2000,
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
    });

    expect(tenantB.id).not.toBe(tenantA.id);
    expect(tenantB.alreadyExisted).toBe(false);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM travel_windows WHERE user_id = 100').get()).toMatchObject({ n: 2 });
  });

  it('replays duplicate logical travel window for legacy null tenant rows without crossing into scoped tenants', () => {
    const legacyFirst = recordTravelWindow({
      userId: 102,
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
    });
    const legacyReplay = recordTravelWindow({
      userId: 102,
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
    });
    const scoped = recordTravelWindow({
      userId: 102,
      tenantId: 1000,
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
    });

    expect(legacyReplay.id).toBe(legacyFirst.id);
    expect(legacyReplay.alreadyExisted).toBe(true);
    expect(scoped.id).not.toBe(legacyFirst.id);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM travel_windows WHERE user_id = 102').get()).toMatchObject({ n: 2 });
  });

  it('keeps overlapping but materially different travel windows separate', () => {
    const first = recordTravelWindow({
      userId: 101,
      tenantId: 1000,
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
      availableSessionDurationMinutes: 30,
    });
    const overlap = recordTravelWindow({
      userId: 101,
      tenantId: 1000,
      startDate: '2026-06-05',
      endDate: '2026-06-10',
      equipmentProfile: 'bodyweight_only',
      availableSessionDurationMinutes: 20,
    });

    expect(overlap.id).not.toBe(first.id);
    expect(overlap.alreadyExisted).toBe(false);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM travel_windows WHERE user_id = 101 AND tenant_id = 1000').get()).toMatchObject({ n: 2 });
  });
});

describe('travel-window lifecycle and bounded inputs', () => {
  it('lists, reads, CAS-updates, and deletes a tenant-scoped window', () => {
    const created = recordTravelWindow({
      userId: 300,
      tenantId: 3000,
      startDate: '2026-09-01',
      endDate: '2026-09-03',
      idempotencyKey: 'travel-lifecycle-create',
    });

    expect(listTravelWindows(300, 3000, {
      fromDate: '2026-09-02',
      toDate: '2026-09-02',
      limit: 10,
    })).toHaveLength(1);
    expect(getTravelWindowById(300, 3000, created.id)).toMatchObject({ version: 1 });
    expect(getTravelWindowById(300, 4000, created.id)).toBeNull();
    expect(updateTravelWindow({
      userId: 300,
      tenantId: 3000,
      id: created.id,
      expectedVersion: 1,
      patch: {},
    })).toMatchObject({
      version: 2,
      equipment_profile: null,
      sleep_disruption_expected: 0,
      walking_load_expected: 0,
      heat_stress: 0,
      available_session_duration_minutes: null,
      notes: null,
    });
    expect(updateTravelWindow({
      userId: 300,
      tenantId: 3000,
      id: 999_999,
      expectedVersion: 1,
      patch: {},
    })).toBeNull();
    expect(() => updateTravelWindow({
      userId: 300,
      tenantId: 3000,
      id: created.id,
      expectedVersion: 1,
      patch: { notes: 'stale' },
    })).toThrow(TravelWindowVersionConflictError);
    expect(() => deleteTravelWindow({
      userId: 300,
      tenantId: 3000,
      id: created.id,
      expectedVersion: 1,
    })).toThrow(TravelWindowVersionConflictError);
    expect(deleteTravelWindow({
      userId: 300,
      tenantId: 3000,
      id: created.id,
      expectedVersion: 2,
    })).toBe(true);
    expect(deleteTravelWindow({
      userId: 300,
      tenantId: 3000,
      id: created.id,
      expectedVersion: 2,
    })).toBe(false);
  });

  it('replays PATCH and DELETE receipts and rejects cross-operation key reuse', () => {
    const created = recordTravelWindow({
      userId: 301,
      tenantId: 3001,
      startDate: '2026-09-04',
      endDate: '2026-09-05',
      notes: 'original',
      idempotencyKey: 'travel-receipt-create',
    });
    const patch = {
      userId: 301,
      tenantId: 3001,
      id: created.id,
      expectedVersion: 1,
      patch: {
        notes: 'updated',
        sleepDisruptionExpected: true,
        walkingLoadExpected: true,
        heatStress: true,
        availableSessionDurationMinutes: 45,
      },
      idempotencyKey: 'travel-receipt-patch',
    };
    const first = updateTravelWindowIdempotently(patch);
    const replay = updateTravelWindowIdempotently(patch);
    expect(first).toMatchObject({ replayed: false, window: { version: 2, notes: 'updated' } });
    expect(replay).toMatchObject({ replayed: true, window: { version: 2, notes: 'updated' } });
    expect(() => updateTravelWindowIdempotently({
      ...patch,
      patch: { ...patch.patch, notes: 'different request' },
    })).toThrow(TravelWindowIdempotencyConflictError);
    expect(() => deleteTravelWindowIdempotently({
      userId: 301,
      tenantId: 3001,
      id: created.id,
      expectedVersion: 2,
      idempotencyKey: 'travel-receipt-patch',
    })).toThrow(TravelWindowIdempotencyConflictError);

    const deleted = deleteTravelWindowIdempotently({
      userId: 301,
      tenantId: 3001,
      id: created.id,
      expectedVersion: 2,
      idempotencyKey: 'travel-receipt-delete',
    });
    const deletedReplay = deleteTravelWindowIdempotently({
      userId: 301,
      tenantId: 3001,
      id: created.id,
      expectedVersion: 2,
      idempotencyKey: 'travel-receipt-delete',
    });
    expect(deleted).toEqual({ deleted: true, replayed: false });
    expect(deletedReplay).toEqual({ deleted: true, replayed: true });

    const missing = deleteTravelWindowIdempotently({
      userId: 301,
      tenantId: 3001,
      id: 999_999,
      expectedVersion: 1,
      idempotencyKey: 'travel-receipt-delete-missing',
    });
    expect(missing).toEqual({ deleted: false, replayed: false });
    expect(() => updateTravelWindowIdempotently({
      userId: 301,
      tenantId: 3001,
      id: 999_998,
      expectedVersion: 1,
      patch: { notes: 'missing' },
      idempotencyKey: 'travel-receipt-patch-missing',
    })).toThrow(/TRAVEL_WINDOW_NOT_FOUND/);
  });

  it('fails CAS when a concurrent trigger suppresses the final update or delete', () => {
    const updateTarget = recordTravelWindow({
      userId: 304,
      tenantId: 3004,
      startDate: '2026-09-10',
      endDate: '2026-09-11',
    });
    testDb.exec(`
      CREATE TRIGGER travel_test_ignore_update
      BEFORE UPDATE ON travel_windows
      WHEN OLD.id = ${updateTarget.id}
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    expect(() => updateTravelWindow({
      userId: 304,
      tenantId: 3004,
      id: updateTarget.id,
      expectedVersion: 1,
      patch: { notes: 'lost race' },
    })).toThrow(/changed before the update/);
    testDb.exec('DROP TRIGGER travel_test_ignore_update;');

    const deleteTarget = recordTravelWindow({
      userId: 304,
      tenantId: 3004,
      startDate: '2026-09-12',
      endDate: '2026-09-13',
    });
    testDb.exec(`
      CREATE TRIGGER travel_test_ignore_delete
      BEFORE DELETE ON travel_windows
      WHEN OLD.id = ${deleteTarget.id}
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    expect(() => deleteTravelWindow({
      userId: 304,
      tenantId: 3004,
      id: deleteTarget.id,
      expectedVersion: 1,
    })).toThrow(/changed before it could be deleted/);
  });

  it.each([
    ['malformed date', { startDate: '09/01/2026', endDate: '2026-09-02' }],
    ['impossible date', { startDate: '2026-02-30', endDate: '2026-03-02' }],
    ['oversized window', { startDate: '2026-01-01', endDate: '2027-01-03' }],
    ['blank equipment', { startDate: '2026-09-01', endDate: '2026-09-02', equipmentProfile: ' ' }],
    ['long equipment', { startDate: '2026-09-01', endDate: '2026-09-02', equipmentProfile: 'x'.repeat(65) }],
    ['long notes', { startDate: '2026-09-01', endDate: '2026-09-02', notes: 'x'.repeat(501) }],
    ['timezone range', { startDate: '2026-09-01', endDate: '2026-09-02', timeZoneShiftHours: 15 }],
    ['flight range', { startDate: '2026-09-01', endDate: '2026-09-02', flightDurationHours: -1 }],
    ['duration integer', { startDate: '2026-09-01', endDate: '2026-09-02', availableSessionDurationMinutes: 30.5 }],
    ['finite number', { startDate: '2026-09-01', endDate: '2026-09-02', timeZoneShiftHours: Number.POSITIVE_INFINITY }],
  ])('rejects bounded input: %s', (_label, input) => {
    expect(() => recordTravelWindow({ userId: 302, tenantId: 3002, ...input }))
      .toThrow(/BAD_TRAVEL_INPUT/);
  });

  it('rejects empty and oversized mutation keys before changing a row', () => {
    for (const idempotencyKey of [' ', 'x'.repeat(161)]) {
      expect(() => deleteTravelWindowIdempotently({
        userId: 303,
        tenantId: 3003,
        id: 1,
        expectedVersion: 1,
        idempotencyKey,
      })).toThrow(TravelWindowIdempotencyConflictError);
    }
  });
});

describe('findTravelWindowsInRange', () => {
  it('returns overlapping windows', () => {
    recordTravelWindow({ userId: 200, tenantId: 1000, startDate: '2026-06-01', endDate: '2026-06-08' });
    recordTravelWindow({ userId: 200, tenantId: 1000, startDate: '2026-06-15', endDate: '2026-06-20' });
    recordTravelWindow({ userId: 200, tenantId: 1000, startDate: '2026-07-01', endDate: '2026-07-05' });
    const range = findTravelWindowsInRange(200, '2026-06-05', '2026-06-18', 1000);
    expect(range.length).toBe(2);
  });

  it('returns empty when no overlap', () => {
    recordTravelWindow({ userId: 201, tenantId: 1000, startDate: '2026-06-01', endDate: '2026-06-08' });
    expect(findTravelWindowsInRange(201, '2026-08-01', '2026-08-15', 1000)).toEqual([]);
  });

  it('fails closed instead of reading legacy/global travel windows without a tenant', () => {
    recordTravelWindow({ userId: 203, startDate: '2026-06-01', endDate: '2026-06-08' });

    expect(() => findTravelWindowsInRange(203, '2026-06-03', '2026-06-05')).toThrow(/tenant/i);
  });

  it('isolates same-user travel windows by tenant when tenantId is provided', () => {
    recordTravelWindow({
      userId: 202,
      tenantId: 10,
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'hotel_only',
    });
    recordTravelWindow({
      userId: 202,
      tenantId: 20,
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      equipmentProfile: 'full_gym',
    });

    const tenantTen = findTravelWindowsInRange(202, '2026-06-03', '2026-06-05', 10);
    const tenantTwenty = findTravelWindowsInRange(202, '2026-06-03', '2026-06-05', 20);

    expect(tenantTen).toHaveLength(1);
    expect(tenantTen[0]?.equipment_profile).toBe('hotel_only');
    expect(tenantTwenty).toHaveLength(1);
    expect(tenantTwenty[0]?.equipment_profile).toBe('full_gym');
  });
});

describe('computeTravelStressScore', () => {
  it('zero when no flags set', () => {
    const score = computeTravelStressScore({
      id: 1, user_id: 1, start_date: 'x', end_date: 'x',
      tenant_id: null,
      equipment_profile: null, time_zone_shift_hours: null, flight_duration_hours: null,
      sleep_disruption_expected: 0, walking_load_expected: 0, heat_stress: 0,
      available_session_duration_minutes: null, notes: null, created_at: 'x',
    });
    expect(score).toBe(0);
  });

  it('combines flags up to 1.0', () => {
    const score = computeTravelStressScore({
      id: 1, user_id: 1, start_date: 'x', end_date: 'x',
      tenant_id: null,
      equipment_profile: null, time_zone_shift_hours: 6, flight_duration_hours: 8,
      sleep_disruption_expected: 1, walking_load_expected: 1, heat_stress: 1,
      available_session_duration_minutes: null, notes: null, created_at: 'x',
    });
    // 0.2 + 0.25 + 0.20 + 0.15 + 0.20 = 1.0
    expect(score).toBe(1);
  });

  it('clamps at 1.0 when sum exceeds', () => {
    // No way the current formula exceeds 1.0, but verify the clamp anyway.
    const score = computeTravelStressScore({
      id: 1, user_id: 1, start_date: 'x', end_date: 'x',
      tenant_id: null,
      equipment_profile: null, time_zone_shift_hours: 12, flight_duration_hours: 12,
      sleep_disruption_expected: 1, walking_load_expected: 1, heat_stress: 1,
      available_session_duration_minutes: null, notes: null, created_at: 'x',
    });
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('week equipment override', () => {
  function seedWeek(weekId: number): void {
    testDb.prepare(`
      INSERT INTO fitness_training_plans (id, user_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (10, 100, 'p', 'gym', 4, '2026-01-05', '2026-02-01', 'active')
    `).run();
    testDb.prepare('INSERT INTO training_weeks (id, plan_id, week_number) VALUES (?, 10, 1)').run(weekId);
  }

  it('set + get round-trips JSON', () => {
    seedWeek(1);
    setWeekEquipmentOverride(1, { fullGym: false, dumbbells: true, bands: true });
    const got = getWeekEquipmentOverride(1);
    expect(got).toEqual({ fullGym: false, dumbbells: true, bands: true });
  });

  it('get returns null when unset', () => {
    seedWeek(2);
    expect(getWeekEquipmentOverride(2)).toBeNull();
  });

  it('clear sets to null', () => {
    seedWeek(3);
    setWeekEquipmentOverride(3, { bands: true });
    clearWeekEquipmentOverride(3);
    expect(getWeekEquipmentOverride(3)).toBeNull();
  });

  it('malformed JSON returns null defensively', () => {
    seedWeek(4);
    testDb.prepare(
      'UPDATE training_weeks SET equipment_override_json = ? WHERE id = ?',
    ).run('not json', 4);
    expect(getWeekEquipmentOverride(4)).toBeNull();
  });

  // R8 P1-3 — the prior silent swallow made corrupt JSON
  // indistinguishable from "no override stored" — user's
  // hotel-week equipment selection silently disappeared. The fix
  // logs warn so SRE can see corruption signal, while preserving
  // the safe `null` return.
  it('R8 P1-3 — malformed JSON returns null AND logs a warning with weekId context', async () => {
    seedWeek(5);
    testDb.prepare(
      'UPDATE training_weeks SET equipment_override_json = ? WHERE id = ?',
    ).run('{ broken: json', 5);
    const { logger } = await import('../../src/utils/logger');
    const warnSpy = vi.mocked(logger.warn);
    warnSpy.mockClear();

    expect(getWeekEquipmentOverride(5)).toBeNull();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [meta, msg] = warnSpy.mock.calls[0]!;
    expect(msg).toBe('week_equipment_override.parse_failed');
    expect(meta).toMatchObject({ weekId: 5 });
    expect((meta as { err?: unknown }).err).toBeInstanceOf(Error);
  });
});
