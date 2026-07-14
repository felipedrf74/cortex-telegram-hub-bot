// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrationsForTest, withDatabaseForTest } from '../../src/services/database';
import { getTrainingM4AuthoritativeCapacityContext } from '../../src/services/training-m4-capacity-context';
import {
  readMaterializedTrainingM4CapacityContext,
  refreshTrainingM4AuthoritativeCapacityContext,
  registerTrainingM4CapacityCalendarReader,
  TRAINING_M4_CAPACITY_PROVIDER_TIMEOUT_MS,
  TRAINING_M4_CAPACITY_EXPIRED_RETENTION_PER_USER,
  TRAINING_M4_CAPACITY_REFRESH_MAX_WINDOWS,
  type TrainingM4CapacityRefreshRequest,
} from '../../src/services/training-m4-capacity-snapshots';
import type { UnifiedCalendarFetchResult } from '../../src/services/unified-calendar';

const NOW = new Date('2026-07-14T09:00:00.000Z');
const request: TrainingM4CapacityRefreshRequest = {
  planStartDate: '2026-08-03',
  horizonWeeks: 4,
  profileWindows: [
    { dayOfWeek: 'monday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon', allowedDisciplines: ['running'] },
    { dayOfWeek: 'wednesday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon', allowedDisciplines: ['running'] },
  ],
};

describe('Training M4 authoritative capacity snapshots', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrationsForTest(db);
    db.prepare(`
      INSERT INTO user_profiles (user_id, profile_type, data)
      VALUES (7, 'fitness', '{"weekly_frequency":2}'),
             (8, 'fitness', '{"weekly_frequency":2}')
    `).run();
  });

  afterEach(() => db.close());

  it('isolates two users and materializes only windows free across the complete horizon', async () => {
    const loader = vi.fn(async (_start: string, _end: string, userId: number) => userId === 7
      ? readyCalendar('google', [{
        id: 'work-7', source: 'google', summary: 'Private',
        start: '2026-08-03T05:30:00.000Z', end: '2026-08-03T06:00:00.000Z',
      }])
      : readyCalendar('outlook', []));
    const configuredSources = (userId: number) => userId === 7
      ? ['google' as const]
      : ['outlook' as const];

    const seven = await refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'refresh-user-7', request,
      dependencies: { db, now: NOW, loadCalendar: loader, configuredSources },
    });
    const eight = await refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 8, tenantId: 8 }, idempotencyKey: 'refresh-user-8',
      request: {
        ...request,
        profileWindows: request.profileWindows.map((window) => ({
          ...window, startTime: '17:00', endTime: '19:00',
        })),
      },
      dependencies: { db, now: NOW, loadCalendar: loader, configuredSources },
    });

    expect(seven).toMatchObject({
      source: 'AUTHORITATIVE', calendarSources: ['google'], conflictCount: 1,
      planStartDate: '2026-08-03', planEndDate: '2026-08-30', horizonWeeks: 4,
    });
    expect(seven.windows).toEqual([
      { dayOfWeek: 'monday', startTime: '06:00', endTime: '06:30', timezone: 'Europe/Lisbon', allowedDisciplines: ['running'] },
      { dayOfWeek: 'monday', startTime: '07:00', endTime: '08:00', timezone: 'Europe/Lisbon', allowedDisciplines: ['running'] },
      { dayOfWeek: 'wednesday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon', allowedDisciplines: ['running'] },
    ]);
    expect(eight).toMatchObject({ calendarSources: ['outlook'], conflictCount: 0 });
    expect(eight.contextVersion).not.toBe(seven.contextVersion);
    expect(readMaterializedTrainingM4CapacityContext({
      scope: { userId: 7, tenantId: 7 }, db, now: NOW, configuredSources: ['google'],
    })?.contextVersion).toBe(seven.contextVersion);
    expect(readMaterializedTrainingM4CapacityContext({
      scope: { userId: 8, tenantId: 8 }, db, now: NOW, configuredSources: ['outlook'],
    })?.contextVersion).toBe(eight.contextVersion);
    expect(readMaterializedTrainingM4CapacityContext({
      scope: { userId: 7, tenantId: 8 }, db, now: NOW, configuredSources: ['google'],
    })).toBeNull();
  });

  it('is idempotent and fails closed after expiry, profile drift, or provider disconnect', async () => {
    const loader = vi.fn(async () => readyCalendar('google', []));
    const dependencies = {
      db, now: NOW, loadCalendar: loader,
      configuredSources: () => ['google' as const],
    };
    const first = await refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'same-refresh', request, dependencies,
    });
    const replay = await refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'same-refresh', request, dependencies,
    });
    expect(replay.contextVersion).toBe(first.contextVersion);
    expect(loader).toHaveBeenCalledTimes(1);
    await expect(refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'same-refresh',
      request: { ...request, horizonWeeks: 5 }, dependencies,
    })).rejects.toMatchObject({ code: 'TRAINING_M4_CAPACITY_IDEMPOTENCY_CONFLICT' });

    expect(readMaterializedTrainingM4CapacityContext({
      scope: { userId: 7, tenantId: 7 }, db,
      now: new Date('2026-07-14T09:05:00.001Z'), configuredSources: ['google'],
    })).toBeNull();
    expect(readMaterializedTrainingM4CapacityContext({
      scope: { userId: 7, tenantId: 7 }, db, now: NOW, configuredSources: [],
    })).toBeNull();
    db.prepare("UPDATE user_profiles SET data = '{\"weekly_frequency\":3}' WHERE user_id = 7").run();
    expect(readMaterializedTrainingM4CapacityContext({
      scope: { userId: 7, tenantId: 7 }, db, now: NOW, configuredSources: ['google'],
    })).toBeNull();
  });

  it('bounds duplicate snapshots even when their shared context is revision-referenced', async () => {
    const first = await refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 },
      idempotencyKey: 'retention-refresh-0',
      request,
      dependencies: {
        db,
        now: NOW,
        configuredSources: () => ['google'],
        loadCalendar: async () => readyCalendar('google', []),
      },
    });
    seedRevisionReferencingCapacityContext(db, first.contextVersion);
    for (let index = 1; index < TRAINING_M4_CAPACITY_EXPIRED_RETENTION_PER_USER + 10; index += 1) {
      await refreshTrainingM4AuthoritativeCapacityContext({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: `retention-refresh-${index}`,
        request,
        dependencies: {
          db,
          now: new Date(NOW.getTime() + index * 6 * 60_000),
          configuredSources: () => ['google'],
          loadCalendar: async () => readyCalendar('google', []),
        },
      });
    }
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM training_m4_capacity_snapshots
       WHERE tenant_id = 7 AND user_id = 7
    `).get()).toEqual({ count: TRAINING_M4_CAPACITY_EXPIRED_RETENTION_PER_USER + 1 });
    expect(db.prepare(`
      SELECT COUNT(DISTINCT context_version) AS count FROM training_m4_capacity_snapshots
       WHERE tenant_id = 7 AND user_id = 7
    `).get()).toEqual({ count: 1 });
    const expired = db.prepare(`
      SELECT snapshot_id AS snapshotId FROM training_m4_capacity_snapshots
       WHERE tenant_id = 7 AND user_id = 7 ORDER BY observed_at ASC LIMIT 1
    `).get() as { snapshotId: string };
    expect(() => db.prepare('DELETE FROM training_m4_capacity_snapshots WHERE snapshot_id = ?')
      .run(expired.snapshotId)).toThrow('training M4 capacity snapshots are immutable');
    expect(db.prepare('SELECT COUNT(*) AS count FROM training_m4_capacity_prune_authorizations').get())
      .toEqual({ count: 0 });
  });

  it('preserves one referenced context when two old duplicates fall beyond the global retention rank', async () => {
    // Deliberately decouple the injected service clock from SQLite's wall
    // clock. Retention authority must bind to the same cutoff used by the
    // pruning query, not to order-dependent test/process time.
    const retentionNow = new Date('2099-01-01T09:00:00.000Z');
    const referenced = await refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'ranked-reference-0', request,
      dependencies: {
        db, now: retentionNow, configuredSources: () => ['google'],
        loadCalendar: async () => readyCalendar('google', []),
      },
    });
    await refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'ranked-reference-1', request,
      dependencies: {
        db, now: new Date(retentionNow.getTime() + 6 * 60_000), configuredSources: () => ['google'],
        loadCalendar: async () => readyCalendar('google', []),
      },
    });
    seedRevisionReferencingCapacityContext(db, referenced.contextVersion);

    for (let index = 0; index < TRAINING_M4_CAPACITY_EXPIRED_RETENTION_PER_USER; index += 1) {
      const observedAt = new Date(retentionNow.getTime() + (12 + index) * 60_000);
      const expiresAt = new Date(observedAt.getTime() + 5 * 60_000);
      db.prepare(`
        INSERT INTO training_m4_capacity_snapshots (
          snapshot_id, tenant_id, user_id, schema_version, context_version,
          idempotency_key, request_hash, profile_source_version,
          calendar_event_set_hash, provider_sources_json, provider_status,
          plan_start_date, plan_end_date, horizon_weeks, range_start_at,
          range_end_at, profile_windows_json, capacity_windows_json,
          conflict_count, observed_at, expires_at
        )
        SELECT ?, tenant_id, user_id, schema_version, ?, ?, request_hash,
               profile_source_version, calendar_event_set_hash, provider_sources_json,
               provider_status, plan_start_date, plan_end_date, horizon_weeks,
               range_start_at, range_end_at, profile_windows_json, capacity_windows_json,
               conflict_count, ?, ?
          FROM training_m4_capacity_snapshots
         WHERE snapshot_id = (
           SELECT snapshot_id FROM training_m4_capacity_snapshots
            WHERE tenant_id = 7 AND user_id = 7
            ORDER BY observed_at DESC, rowid DESC LIMIT 1
         )
      `).run(
        `ranked-distinct-${index}`,
        `m4cap_${index.toString(16).padStart(48, '0')}`,
        `ranked-distinct-idempotency-${index}`,
        observedAt.toISOString(),
        expiresAt.toISOString(),
      );
    }

    await expect(refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'ranked-reference-prune', request,
      dependencies: {
        db,
        now: new Date(retentionNow.getTime() + 2 * 60 * 60_000),
        configuredSources: () => ['google'],
        loadCalendar: async () => readyCalendar('google', [{
          id: 'new-context-evidence', source: 'google', summary: 'Private',
          start: '2026-08-03T12:00:00.000Z', end: '2026-08-03T12:15:00.000Z',
        }]),
      },
    })).resolves.toMatchObject({ source: 'AUTHORITATIVE' });

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM training_m4_capacity_snapshots
       WHERE tenant_id = 7 AND user_id = 7 AND context_version = ?
    `).get(referenced.contextVersion)).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM training_m4_capacity_snapshots
       WHERE tenant_id = 7 AND user_id = 7
    `).get()).toEqual({ count: TRAINING_M4_CAPACITY_EXPIRED_RETENTION_PER_USER + 2 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM training_m4_capacity_prune_authorizations').get())
      .toEqual({ count: 0 });
  });

  it('converges concurrent refreshes with the same idempotency key onto one immutable snapshot', async () => {
    let calls = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    const loadCalendar = vi.fn(async () => {
      calls += 1;
      if (calls === 2) release();
      await bothStarted;
      return readyCalendar('google', []);
    });
    const input = {
      scope: { userId: 7, tenantId: 7 },
      idempotencyKey: 'concurrent-refresh',
      request,
      dependencies: {
        db, now: NOW, loadCalendar,
        configuredSources: () => ['google' as const],
      },
    };
    const [first, second] = await Promise.all([
      refreshTrainingM4AuthoritativeCapacityContext(input),
      refreshTrainingM4AuthoritativeCapacityContext(input),
    ]);
    expect(first).toEqual(second);
    expect(loadCalendar).toHaveBeenCalledTimes(2);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM training_m4_capacity_snapshots
       WHERE tenant_id = 7 AND user_id = 7 AND idempotency_key = 'concurrent-refresh'
    `).get()).toEqual({ count: 1 });
  });

  it('reads capability context from the materialized snapshot without a provider network call', async () => {
    await refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'materialized-capability-read', request,
      dependencies: {
        db, now: NOW,
        loadCalendar: async () => readyCalendar('google', []),
        configuredSources: () => ['google'],
      },
    });
    const loadCalendar = vi.fn(async () => {
      throw new Error('capability reads must not call providers');
    });
    const unregister = registerTrainingM4CapacityCalendarReader({
      configuredSources: () => ['google'],
      loadCalendar,
    });
    try {
      const context = withDatabaseForTest(db, () => getTrainingM4AuthoritativeCapacityContext(
        { userId: 7, tenantId: 7 },
        NOW,
      ));
      expect(context?.contextVersion).toMatch(/^m4cap_[a-f0-9]{48}$/);
      expect(loadCalendar).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('does not publish a snapshot from degraded, unavailable, or malformed provider evidence', async () => {
    for (const calendar of [
      {
        events: [], status: 'degraded', warningCodes: ['OUTLOOK_CALENDAR_UNAVAILABLE'], warnings: [],
        sources: { configured: ['google', 'outlook'], fulfilled: ['google'], failed: ['outlook'] },
      },
      {
        events: [], status: 'unavailable', warningCodes: ['GOOGLE_CALENDAR_UNAVAILABLE'], warnings: [],
        sources: { configured: ['google'], fulfilled: [], failed: ['google'] },
      },
      readyCalendar('google', [{
        id: 'bad-event', source: 'google', summary: 'Private', start: 'invalid', end: 'invalid',
      }]),
    ] as UnifiedCalendarFetchResult[]) {
      await expect(refreshTrainingM4AuthoritativeCapacityContext({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: `failure-${calendar.status}-${calendar.events.length}`,
        request,
        dependencies: {
          db, now: NOW, loadCalendar: async () => calendar,
          configuredSources: () => calendar.sources.configured,
        },
      })).rejects.toMatchObject({ code: expect.stringMatching(/^TRAINING_M4_CAPACITY_/) });
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM training_m4_capacity_snapshots').get())
      .toEqual({ count: 0 });
  });

  it('fails closed within the aggregate provider-read deadline', async () => {
    vi.useFakeTimers();
    try {
      const pending = refreshTrainingM4AuthoritativeCapacityContext({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: 'stalled-provider-read',
        request,
        dependencies: {
          db,
          now: NOW,
          configuredSources: () => ['outlook'],
          loadCalendar: async () => new Promise(() => {}),
        },
      });
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'TRAINING_M4_CAPACITY_PROVIDER_UNAVAILABLE',
        statusCode: 503,
      });
      await vi.advanceTimersByTimeAsync(TRAINING_M4_CAPACITY_PROVIDER_TIMEOUT_MS + 1);
      await rejection;
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_m4_capacity_snapshots').get())
        .toEqual({ count: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects multiple windows per weekday or mixed profile timezones before provider work', async () => {
    const loadCalendar = vi.fn(async () => readyCalendar('google', []));
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
    await expect(refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'too-many-profile-windows',
      request: {
        ...request,
        profileWindows: [
          ...days.map((dayOfWeek) => ({
            dayOfWeek, startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon',
          })),
          { dayOfWeek: 'monday', startTime: '17:00', endTime: '19:00', timezone: 'Europe/Lisbon' },
        ],
      },
      dependencies: { db, now: NOW, configuredSources: () => ['google'], loadCalendar },
    })).rejects.toMatchObject({ code: 'TRAINING_M4_CAPACITY_PROFILE_WINDOW_COUNT_INVALID', statusCode: 400 });
    await expect(refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'duplicate-weekday-window',
      request: {
        ...request,
        profileWindows: [
          { dayOfWeek: 'monday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon' },
          { dayOfWeek: 'monday', startTime: '17:00', endTime: '19:00', timezone: 'Europe/Lisbon' },
        ],
      },
      dependencies: { db, now: NOW, configuredSources: () => ['google'], loadCalendar },
    })).rejects.toMatchObject({ code: 'TRAINING_M4_CAPACITY_PROFILE_WINDOW_DAY_DUPLICATE', statusCode: 400 });
    await expect(refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'mixed-profile-timezones',
      request: {
        ...request,
        profileWindows: [
          { dayOfWeek: 'monday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon' },
          { dayOfWeek: 'wednesday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/London' },
        ],
      },
      dependencies: { db, now: NOW, configuredSources: () => ['google'], loadCalendar },
    })).rejects.toMatchObject({ code: 'TRAINING_M4_CAPACITY_PROFILE_TIMEZONE_MISMATCH', statusCode: 400 });
    expect(loadCalendar).not.toHaveBeenCalled();
  });

  it('bounds the longest advertised seven-day materialization without per-minute event-loop work', async () => {
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
    const profileWindows = days.map((dayOfWeek) => ({
      dayOfWeek,
      startTime: '00:00',
      endTime: '23:59',
      timezone: 'UTC',
    }));
    const events = Array.from({ length: 50_000 }, (_, index) => ({
      id: `max-event-${index}`,
      source: 'google' as const,
      summary: 'Private',
      start: '2026-08-03T23:59:00.000Z',
      end: '2026-08-04T00:00:00.000Z',
    }));
    let diagnostics: { wallClockDayBuilds: number; timezoneOffsetLookups: number } | undefined;

    const startedAt = performance.now();
    const context = await refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 },
      idempotencyKey: 'max-shape-indexed-materialization',
      request: { planStartDate: '2026-08-03', horizonWeeks: 52, profileWindows },
      dependencies: {
        db,
        now: NOW,
        configuredSources: () => ['google'],
        loadCalendar: async () => readyCalendar('google', events),
        observeMaterializationDiagnostics: (value) => { diagnostics = value; },
      },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(profileWindows).toHaveLength(TRAINING_M4_CAPACITY_REFRESH_MAX_WINDOWS);
    expect(context.windows).toHaveLength(TRAINING_M4_CAPACITY_REFRESH_MAX_WINDOWS);
    expect(context.conflictCount).toBe(0);
    expect(diagnostics).toEqual({ wallClockDayBuilds: 364, timezoneOffsetLookups: 6_188 });
    expect(elapsedMs).toBeLessThan(1_000);
  }, 10_000);

  it('treats provider-zone all-day events as conflicts and persists no raw calendar content', async () => {
    const privateEventId = 'provider-private-event-raw-id';
    const privateSummary = 'Confidential appointment title';
    const context = await refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 },
      idempotencyKey: 'all-day-private-event',
      request,
      dependencies: {
        db,
        now: NOW,
        configuredSources: () => ['google'],
        loadCalendar: async () => readyCalendar('google', [{
          id: privateEventId,
          source: 'google',
          summary: privateSummary,
          start: '2026-08-03',
          end: '2026-08-04',
          isAllDay: true,
          timeZone: 'Europe/Lisbon',
        }]),
      },
    });
    expect(context.conflictCount).toBe(1);
    expect(context.windows).toEqual([
      {
        dayOfWeek: 'wednesday', startTime: '06:00', endTime: '08:00',
        timezone: 'Europe/Lisbon', allowedDisciplines: ['running'],
      },
    ]);
    const persisted = JSON.stringify(db.prepare('SELECT * FROM training_m4_capacity_snapshots').all());
    expect(persisted).not.toContain(privateEventId);
    expect(persisted).not.toContain(privateSummary);
  });

  it('blocks a date-only all-day event across the profile zone even when the provider omits its zone', async () => {
    const context = await refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 },
      idempotencyKey: 'all-day-without-provider-zone',
      request: {
        planStartDate: '2026-08-03',
        horizonWeeks: 1,
        profileWindows: [
          { dayOfWeek: 'monday', startTime: '20:00', endTime: '22:00', timezone: 'America/New_York' },
          { dayOfWeek: 'wednesday', startTime: '20:00', endTime: '22:00', timezone: 'America/New_York' },
        ],
      },
      dependencies: {
        db,
        now: NOW,
        configuredSources: () => ['google'],
        loadCalendar: async () => readyCalendar('google', [{
          id: 'all-day-no-zone', source: 'google', summary: 'Private',
          start: '2026-08-03', end: '2026-08-04', isAllDay: true,
        }]),
      },
    });

    expect(context.conflictCount).toBe(1);
    expect(context.windows).toEqual([{
      dayOfWeek: 'wednesday', startTime: '20:00', endTime: '22:00', timezone: 'America/New_York',
    }]);
  });

  it('maps conflicts and nonexistent minutes on a DST transition using wall-clock offsets', async () => {
    const context = await refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 },
      idempotencyKey: 'dst-wall-clock-capacity',
      request: {
        planStartDate: '2026-03-23',
        horizonWeeks: 1,
        profileWindows: [{
          dayOfWeek: 'sunday', startTime: '00:00', endTime: '04:00', timezone: 'Europe/Lisbon',
        }],
      },
      dependencies: {
        db,
        now: new Date('2026-03-01T09:00:00.000Z'),
        configuredSources: () => ['google'],
        loadCalendar: async () => readyCalendar('google', [{
          id: 'dst-busy', source: 'google', summary: 'Private',
          start: '2026-03-29T03:00:00+01:00', end: '2026-03-29T04:00:00+01:00',
          timeZone: 'Europe/Lisbon',
        }]),
      },
    });

    expect(context.conflictCount).toBe(1);
    expect(context.windows).toEqual([
      { dayOfWeek: 'sunday', startTime: '00:00', endTime: '01:00', timezone: 'Europe/Lisbon' },
      { dayOfWeek: 'sunday', startTime: '02:00', endTime: '03:00', timezone: 'Europe/Lisbon' },
    ]);
    expect(context.windows).not.toContainEqual(expect.objectContaining({ startTime: '03:00' }));
  });

  it('does not lose a conflict when the nominal window starts inside a spring-forward gap', async () => {
    const context = await refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 },
      idempotencyKey: 'dst-gap-window-start',
      request: {
        planStartDate: '2026-03-23',
        horizonWeeks: 1,
        profileWindows: [{
          dayOfWeek: 'sunday', startTime: '01:30', endTime: '03:00', timezone: 'Europe/Lisbon',
        }],
      },
      dependencies: {
        db,
        now: new Date('2026-03-01T09:00:00.000Z'),
        configuredSources: () => ['google'],
        loadCalendar: async () => readyCalendar('google', [{
          id: 'dst-gap-busy', source: 'google', summary: 'Private',
          start: '2026-03-29T02:00:00+01:00', end: '2026-03-29T02:30:00+01:00',
          timeZone: 'Europe/Lisbon',
        }]),
      },
    });

    expect(context.conflictCount).toBe(1);
    expect(context.windows).toEqual([{
      dayOfWeek: 'sunday', startTime: '02:30', endTime: '03:00', timezone: 'Europe/Lisbon',
    }]);
  });

  it('excludes the repeated wall-clock hour on the autumn DST transition', async () => {
    const context = await refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 },
      idempotencyKey: 'dst-repeated-hour',
      request: {
        planStartDate: '2026-10-19',
        horizonWeeks: 1,
        profileWindows: [{
          dayOfWeek: 'sunday', startTime: '00:00', endTime: '03:00', timezone: 'Europe/Lisbon',
        }],
      },
      dependencies: {
        db,
        now: new Date('2026-10-01T09:00:00.000Z'),
        configuredSources: () => ['google'],
        loadCalendar: async () => readyCalendar('google', []),
      },
    });

    expect(context.conflictCount).toBe(0);
    expect(context.windows).toEqual([
      { dayOfWeek: 'sunday', startTime: '00:00', endTime: '01:00', timezone: 'Europe/Lisbon' },
      { dayOfWeek: 'sunday', startTime: '02:00', endTime: '03:00', timezone: 'Europe/Lisbon' },
    ]);
  });
});

function seedRevisionReferencingCapacityContext(db: Database.Database, contextVersion: string): void {
  db.prepare(`
    INSERT INTO training_profile_snapshots (
      snapshot_id, tenant_id, user_id, snapshot_sequence, schema_version,
      content_hash, encrypted_snapshot_body, snapshot_body_key_version,
      display_factor_index_json, normalized_goals_json, normalized_constraints_json,
      factor_evidence_json, source_versions_json, consent_context_json,
      missing_inputs_json, observed_at, captured_at
    ) VALUES (
      'capacity-retention-profile', 7, 7, 1, 'training-profile-snapshot.v1',
      ?, 'encrypted-profile', 'training-profile-snapshot-aes256gcm.v1',
      '[]', '{}', '{}', '[]', '{}', '{}', '[]', datetime('now'), datetime('now')
    )
  `).run('a'.repeat(64));
  db.prepare(`
    INSERT INTO training_plan_families (
      family_id, tenant_id, user_id, family_key, plan_mode, discipline, origin
    ) VALUES (
      'capacity-retention-family', 7, 7, 'capacity-retention', 'continuous', 'running', 'GENERATED'
    )
  `).run();
  db.prepare(`
    INSERT INTO training_plan_revisions (
      revision_id, tenant_id, user_id, family_id, revision_sequence,
      profile_snapshot_id, origin, lifecycle_state, approval_state,
      creation_context_version, policy_version, catalog_version, catalog_source_hash,
      capability_registry_version, document_schema_version, revision_document_json,
      content_hash, quality_report_json
    ) VALUES (
      'capacity-retention-revision', 7, 7, 'capacity-retention-family', 1,
      'capacity-retention-profile', 'GENERATED', 'CANDIDATE', 'UNREVIEWED',
      'capacity-retention-context', 'capacity-retention-policy', 'capacity-retention-catalog', ?,
      'training-workout-capabilities.v1', 'training-plan-revision.v1', ?, ?, '{}'
    )
  `).run(
    'b'.repeat(64),
    JSON.stringify({ capacityContextVersion: contextVersion }),
    'c'.repeat(64),
  );
}

function readyCalendar(
  source: 'google' | 'outlook',
  events: UnifiedCalendarFetchResult['events'],
): UnifiedCalendarFetchResult {
  return {
    events,
    status: 'ready',
    warningCodes: [],
    warnings: [],
    sources: { configured: [source], fulfilled: [source], failed: [] },
  };
}
