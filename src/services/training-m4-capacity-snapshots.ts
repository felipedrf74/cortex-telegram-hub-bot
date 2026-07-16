// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DateTime, IANAZone } from 'luxon';
import { config } from '../config';
import { getDb } from './database';
import { TrainingPlanRevisionError } from './training-plan-revision-errors';
import {
  getConfiguredCalendarSourcesForUser,
  getEventsWithDiagnostics,
  type CalendarSource,
  type UnifiedCalendarEvent,
  type UnifiedCalendarFetchResult,
} from './unified-calendar';
import {
  TRAINING_M4_DAYS,
  trainingM4PlanEndDate,
  validateTrainingM4CapacityWindowShapes,
  type TrainingM4CapacityWindow,
} from './training-m4-plan-strategies';
import type { TrainingM4AuthoritativeCapacityContext } from './training-m4-capacity-context';
import { withTimeout } from '../utils/timeout';

const SNAPSHOT_SCHEMA_VERSION = 'training-m4-capacity-snapshot.v1' as const;
export const TRAINING_M4_CAPACITY_TTL_MINUTES = 5;
export const TRAINING_M4_CAPACITY_PROVIDER_TIMEOUT_MS = 30_000;
export const TRAINING_M4_CAPACITY_EXPIRED_RETENTION_PER_USER = 64;
export const TRAINING_M4_CAPACITY_REFRESH_MAX_WINDOWS = 7;
const MIN_CAPACITY_SEGMENT_MINUTES = 15;

export interface TrainingM4CapacityRefreshRequest {
  planStartDate: string;
  horizonWeeks: number;
  profileWindows: TrainingM4CapacityWindow[];
}

interface SnapshotRow {
  snapshot_id: string;
  context_version: string;
  request_hash: string;
  profile_source_version: string;
  calendar_event_set_hash: string;
  provider_sources_json: string;
  provider_status: string;
  plan_start_date: string;
  plan_end_date: string;
  horizon_weeks: number;
  range_start_at: string;
  range_end_at: string;
  profile_windows_json: string;
  capacity_windows_json: string;
  conflict_count: number;
  observed_at: string;
  expires_at: string;
}

export interface TrainingM4CapacitySnapshotDependencies {
  db?: Database.Database;
  now?: Date;
  loadCalendar?: (
    startDate: string,
    endDate: string,
    userId: number,
  ) => Promise<UnifiedCalendarFetchResult>;
  configuredSources?: (userId: number) => CalendarSource[];
  observeMaterializationDiagnostics?: (
    diagnostics: TrainingM4CapacityMaterializationDiagnostics,
  ) => void;
}

export interface TrainingM4CapacityMaterializationDiagnostics {
  wallClockDayBuilds: number;
  timezoneOffsetLookups: number;
}

let runtimeCalendarReader: Pick<
  TrainingM4CapacitySnapshotDependencies,
  'loadCalendar' | 'configuredSources'
> | null = null;

/** Deterministic composition seam used by isolated runtime tests. */
export function registerTrainingM4CapacityCalendarReader(
  reader: Required<Pick<TrainingM4CapacitySnapshotDependencies, 'loadCalendar' | 'configuredSources'>>,
): () => void {
  if (runtimeCalendarReader) throw new Error('TRAINING_M4_CAPACITY_CALENDAR_READER_ALREADY_REGISTERED');
  runtimeCalendarReader = reader;
  return () => {
    if (runtimeCalendarReader === reader) runtimeCalendarReader = null;
  };
}

export async function refreshTrainingM4AuthoritativeCapacityContext(input: {
  scope: { userId: number; tenantId: number };
  idempotencyKey: string;
  request: TrainingM4CapacityRefreshRequest;
  dependencies?: TrainingM4CapacitySnapshotDependencies;
}): Promise<TrainingM4AuthoritativeCapacityContext> {
  requirePersonalScope(input.scope);
  requireIdempotencyKey(input.idempotencyKey);
  const db = input.dependencies?.db ?? getDb();
  requireSnapshotSchema(db);
  const now = input.dependencies?.now ?? new Date();
  requireValidClock(now);
  const request = normalizeRefreshRequest(input.request);
  const requestHash = sha256({ scope: input.scope, request });
  const configuredSources = input.dependencies?.configuredSources
    ?? runtimeCalendarReader?.configuredSources
    ?? getConfiguredCalendarSourcesForUser;

  const prior = db.prepare(`
    SELECT * FROM training_m4_capacity_snapshots
     WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?
     LIMIT 1
  `).get(input.scope.tenantId, input.scope.userId, input.idempotencyKey) as SnapshotRow | undefined;
  if (prior) {
    if (prior.request_hash !== requestHash) {
      throw capacityError(
        'TRAINING_M4_CAPACITY_IDEMPOTENCY_CONFLICT',
        'The capacity refresh idempotency key was already used for different inputs.',
        409,
      );
    }
    const replay = contextFromRow(prior, input.scope, db, now, configuredSources(input.scope.userId));
    if (!replay) {
      throw capacityError(
        'TRAINING_M4_CAPACITY_IDEMPOTENCY_REPLAY_STALE',
        'The prior capacity refresh is no longer current; retry with a new idempotency key.',
        409,
      );
    }
    return replay;
  }

  const expectedSources = normalizedSources(configuredSources(input.scope.userId));
  if (expectedSources.length === 0) {
    throw capacityError(
      'TRAINING_M4_CAPACITY_PROVIDER_REQUIRED',
      'A personal calendar provider must be connected before authoritative capacity can be refreshed.',
      409,
    );
  }
  const fetchRange = calendarFetchRange(request);
  const loadCalendar = input.dependencies?.loadCalendar
    ?? runtimeCalendarReader?.loadCalendar
    ?? getEventsWithDiagnostics;
  let calendar: UnifiedCalendarFetchResult;
  try {
    calendar = await withTimeout(
      loadCalendar(fetchRange.startAt, fetchRange.endAt, input.scope.userId),
      TRAINING_M4_CAPACITY_PROVIDER_TIMEOUT_MS,
    );
  } catch {
    throw capacityError(
      'TRAINING_M4_CAPACITY_PROVIDER_UNAVAILABLE',
      'Calendar capacity could not be refreshed from every connected provider.',
      503,
    );
  }
  const reportedSources = normalizedSources(calendar.sources.configured);
  const fulfilledSources = normalizedSources(calendar.sources.fulfilled);
  if (calendar.status !== 'ready'
      || calendar.sources.failed.length > 0
      || !sameSources(expectedSources, reportedSources)
      || !sameSources(reportedSources, fulfilledSources)) {
    throw capacityError(
      'TRAINING_M4_CAPACITY_PROVIDER_DEGRADED',
      'Authoritative capacity requires a complete read from every connected calendar provider.',
      503,
    );
  }

  const events = validateAndNormalizeEvents(
    calendar.events,
    [...new Set(request.profileWindows.map((window) => window.timezone))],
  );
  const materialized = materializeConflictFreeWindows(request, events);
  input.dependencies?.observeMaterializationDiagnostics?.({ ...materialized.diagnostics });
  if (materialized.windows.length === 0) {
    throw capacityError(
      'TRAINING_M4_AUTHORITATIVE_CAPACITY_EMPTY',
      'No recurring profile window remains conflict-free across the requested planning horizon.',
      409,
    );
  }
  validateTrainingM4CapacityWindowShapes(materialized.windows);

  const profileSourceVersion = computeTrainingM4CapacityProfileSourceVersion(
    db,
    input.scope,
    request.profileWindows,
  );
  const calendarEventSetHash = sha256({
    range: fetchRange,
    sources: reportedSources,
    events,
  });
  const observedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TRAINING_M4_CAPACITY_TTL_MINUTES * 60_000).toISOString();
  const contextVersion = `m4cap_${sha256({
    scope: input.scope,
    request,
    profileSourceVersion,
    calendarEventSetHash,
    windows: materialized.windows,
  }).slice(0, 48)}`;
  const snapshotId = `trm4cap_${randomUUID()}`;

  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO training_m4_capacity_snapshots (
          snapshot_id, tenant_id, user_id, schema_version, context_version,
          idempotency_key, request_hash, profile_source_version,
          calendar_event_set_hash, provider_sources_json, provider_status,
          plan_start_date, plan_end_date, horizon_weeks, range_start_at,
          range_end_at, profile_windows_json, capacity_windows_json,
          conflict_count, observed_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshotId,
        input.scope.tenantId,
        input.scope.userId,
        SNAPSHOT_SCHEMA_VERSION,
        contextVersion,
        input.idempotencyKey,
        requestHash,
        profileSourceVersion,
        calendarEventSetHash,
        JSON.stringify(reportedSources),
        request.planStartDate,
        trainingM4PlanEndDate(request.planStartDate, request.horizonWeeks),
        request.horizonWeeks,
        fetchRange.startAt,
        fetchRange.endAt,
        JSON.stringify(request.profileWindows),
        JSON.stringify(materialized.windows),
        materialized.conflictCount,
        observedAt,
        expiresAt,
      );
      pruneExpiredCapacitySnapshots(db, input.scope, now);
    })();
  } catch (error) {
    if (!isSqliteConstraint(error)) throw error;
    const winner = db.prepare(`
      SELECT * FROM training_m4_capacity_snapshots
       WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?
       LIMIT 1
    `).get(input.scope.tenantId, input.scope.userId, input.idempotencyKey) as SnapshotRow | undefined;
    if (!winner) throw error;
    if (winner.request_hash !== requestHash) {
      throw capacityError(
        'TRAINING_M4_CAPACITY_IDEMPOTENCY_CONFLICT',
        'The capacity refresh idempotency key was concurrently used for different inputs.',
        409,
      );
    }
    const replay = contextFromRow(winner, input.scope, db, now, expectedSources);
    if (!replay) {
      throw capacityError(
        'TRAINING_M4_CAPACITY_IDEMPOTENCY_REPLAY_STALE',
        'The concurrent capacity refresh result is not current.',
        409,
      );
    }
    return replay;
  }

  return {
    source: 'AUTHORITATIVE',
    contextVersion,
    windows: cloneWindows(materialized.windows),
    observedAt,
    expiresAt,
    profileSourceVersion,
    calendarEventSetHash,
    calendarSources: reportedSources,
    planStartDate: request.planStartDate,
    planEndDate: trainingM4PlanEndDate(request.planStartDate, request.horizonWeeks),
    horizonWeeks: request.horizonWeeks,
    conflictCount: materialized.conflictCount,
  };
}

function pruneExpiredCapacitySnapshots(
  db: Database.Database,
  scope: { userId: number; tenantId: number },
  now: Date,
): void {
  const authorizationId = `trm4prune_${randomUUID()}`;
  db.prepare(`
    INSERT INTO training_m4_capacity_prune_authorizations
      (authorization_id, tenant_id, user_id, prune_before_at, expires_at)
    VALUES (?, ?, ?, ?, datetime('now', '+1 minute'))
  `).run(authorizationId, scope.tenantId, scope.userId, now.toISOString());
  db.prepare(`
    DELETE FROM training_m4_capacity_snapshots
     WHERE tenant_id = ? AND user_id = ?
       AND snapshot_id IN (
         WITH context_ranked AS (
           SELECT candidate.snapshot_id,
                  candidate.tenant_id,
                  candidate.user_id,
                  candidate.context_version,
                  candidate.observed_at,
                  candidate.expires_at,
                  candidate.rowid,
                  ROW_NUMBER() OVER (
                    PARTITION BY candidate.context_version
                    ORDER BY candidate.observed_at DESC, candidate.rowid DESC
                  ) AS context_rank
             FROM training_m4_capacity_snapshots candidate
            WHERE candidate.tenant_id = ? AND candidate.user_id = ?
         ), ranked_expired AS (
           SELECT candidate.*,
                  ROW_NUMBER() OVER (
                    ORDER BY candidate.observed_at DESC, candidate.rowid DESC
                  ) AS retention_rank
             FROM context_ranked candidate
            WHERE datetime(candidate.expires_at) < datetime(?)
         )
         SELECT candidate.snapshot_id
           FROM ranked_expired candidate
          WHERE candidate.retention_rank > ?
            AND (
              NOT EXISTS (
                SELECT 1 FROM training_plan_revisions revision
                 WHERE revision.tenant_id = candidate.tenant_id
                   AND revision.user_id = candidate.user_id
                   AND json_extract(revision.revision_document_json, '$.capacityContextVersion') = candidate.context_version
              )
              OR candidate.context_rank > 1
            )
       )
  `).run(
    scope.tenantId,
    scope.userId,
    scope.tenantId,
    scope.userId,
    now.toISOString(),
    TRAINING_M4_CAPACITY_EXPIRED_RETENTION_PER_USER,
  );
  db.prepare(`
    DELETE FROM training_m4_capacity_prune_authorizations
     WHERE authorization_id = ? AND tenant_id = ? AND user_id = ?
  `).run(authorizationId, scope.tenantId, scope.userId);
}

export function readMaterializedTrainingM4CapacityContext(input: {
  scope: { userId: number; tenantId: number };
  db?: Database.Database;
  now?: Date;
  configuredSources?: CalendarSource[];
}): TrainingM4AuthoritativeCapacityContext | null {
  if (input.scope.userId !== input.scope.tenantId) return null;
  const db = input.db ?? getDb();
  if (!tableExists(db, 'training_m4_capacity_snapshots')) return null;
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return null;
  const row = db.prepare(`
    SELECT * FROM training_m4_capacity_snapshots
     WHERE tenant_id = ? AND user_id = ?
     ORDER BY observed_at DESC, rowid DESC
     LIMIT 1
  `).get(input.scope.tenantId, input.scope.userId) as SnapshotRow | undefined;
  if (!row) return null;
  const sources = input.configuredSources
    ?? runtimeCalendarReader?.configuredSources?.(input.scope.userId)
    ?? getConfiguredCalendarSourcesForUser(input.scope.userId);
  return contextFromRow(row, input.scope, db, now, sources);
}

/**
 * Return the identity of the newest retained authoritative capacity snapshot.
 *
 * The five-minute snapshot TTL controls whether cached calendar material may
 * be reused for candidate generation. It must not invalidate an immutable
 * Decision review whose execution path will freshly reread every connected
 * provider before applying anything. Retained rows still pass the same
 * structural, profile-source, and connected-provider integrity checks; only
 * cache freshness is intentionally ignored here.
 */
export function readLatestRetainedTrainingM4CapacityContextVersion(input: {
  scope: { userId: number; tenantId: number };
  db?: Database.Database;
  now?: Date;
  configuredSources?: CalendarSource[];
}): string | null {
  if (input.scope.userId !== input.scope.tenantId) return null;
  const db = input.db ?? getDb();
  if (!tableExists(db, 'training_m4_capacity_snapshots')) return null;
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return null;
  const row = db.prepare(`
    SELECT * FROM training_m4_capacity_snapshots
     WHERE tenant_id = ? AND user_id = ?
     ORDER BY observed_at DESC, rowid DESC
     LIMIT 1
  `).get(input.scope.tenantId, input.scope.userId) as SnapshotRow | undefined;
  if (!row) return null;
  const sources = input.configuredSources
    ?? runtimeCalendarReader?.configuredSources?.(input.scope.userId)
    ?? getConfiguredCalendarSourcesForUser(input.scope.userId);
  return contextFromRow(row, input.scope, db, now, sources, { allowExpired: true })?.contextVersion ?? null;
}

/**
 * Re-fetch every connected provider immediately before Decision execution.
 * The expected snapshot supplies the immutable profile windows and horizon;
 * caller data cannot expand either input during approval.
 */
export async function refreshTrainingM4CapacityContextForDecision(input: {
  scope: { userId: number; tenantId: number };
  expectedContextVersion: string;
  executionId: string;
  dependencies?: TrainingM4CapacitySnapshotDependencies;
}): Promise<TrainingM4AuthoritativeCapacityContext> {
  requirePersonalScope(input.scope);
  const db = input.dependencies?.db ?? getDb();
  requireSnapshotSchema(db);
  const row = db.prepare(`
    SELECT * FROM training_m4_capacity_snapshots
     WHERE tenant_id = ? AND user_id = ? AND context_version = ?
     ORDER BY observed_at DESC, rowid DESC
     LIMIT 1
  `).get(
    input.scope.tenantId,
    input.scope.userId,
    input.expectedContextVersion,
  ) as SnapshotRow | undefined;
  if (!row) {
    throw capacityError(
      'TRAINING_M4_AUTHORITATIVE_CAPACITY_STALE',
      'The reviewed authoritative capacity snapshot is no longer available.',
      409,
    );
  }
  let profileWindows: TrainingM4CapacityWindow[];
  try {
    profileWindows = JSON.parse(row.profile_windows_json) as TrainingM4CapacityWindow[];
    validateTrainingM4CapacityWindowShapes(profileWindows);
  } catch {
    throw capacityError(
      'TRAINING_M4_CAPACITY_SNAPSHOT_INVALID',
      'The reviewed authoritative capacity snapshot failed integrity validation.',
      409,
    );
  }
  return refreshTrainingM4AuthoritativeCapacityContext({
    scope: input.scope,
    // A Decision retry must still perform a new provider read. Reusing only the
    // execution id would replay the prior snapshot for up to the TTL and could
    // miss an event added between activation attempts.
    idempotencyKey: `decision-capacity:${input.executionId}:${randomUUID()}`,
    request: {
      planStartDate: row.plan_start_date,
      horizonWeeks: row.horizon_weeks,
      profileWindows,
    },
    dependencies: input.dependencies,
  });
}

export function computeTrainingM4CapacityProfileSourceVersion(
  db: Database.Database,
  scope: { userId: number; tenantId: number },
  profileWindows: readonly TrainingM4CapacityWindow[],
): string {
  const profileRows = tableExists(db, 'user_profiles')
    ? db.prepare(`
        SELECT profile_type, data, created_at, updated_at
          FROM user_profiles WHERE user_id = ?
         ORDER BY profile_type, id
      `).all(scope.userId)
    : [];
  return `m4profile_${sha256({
    tenantId: scope.tenantId,
    userId: scope.userId,
    profileRows,
    profileWindows: normalizeWindows(profileWindows),
  })}`;
}

function contextFromRow(
  row: SnapshotRow,
  scope: { userId: number; tenantId: number },
  db: Database.Database,
  now: Date,
  configuredSources: CalendarSource[],
  options: { allowExpired?: boolean } = {},
): TrainingM4AuthoritativeCapacityContext | null {
  try {
    const observedMs = Date.parse(row.observed_at);
    const expiresMs = Date.parse(row.expires_at);
    const rangeStartMs = Date.parse(row.range_start_at);
    const rangeEndMs = Date.parse(row.range_end_at);
    if (row.provider_status !== 'ready'
        || !/^m4cap_[a-f0-9]{48}$/.test(row.context_version)
        || !/^m4profile_[a-f0-9]{64}$/.test(row.profile_source_version)
        || !/^[a-f0-9]{64}$/.test(row.calendar_event_set_hash)
        || ![observedMs, expiresMs, rangeStartMs, rangeEndMs].every(Number.isFinite)
        || observedMs > now.getTime()
        || (!options.allowExpired && expiresMs <= now.getTime())
        || expiresMs <= observedMs
        || rangeEndMs <= rangeStartMs
        || row.horizon_weeks < 1 || row.horizon_weeks > 52
        || !Number.isSafeInteger(row.conflict_count) || row.conflict_count < 0
        || row.plan_end_date !== trainingM4PlanEndDate(row.plan_start_date, row.horizon_weeks)) return null;
    const profileWindows = JSON.parse(row.profile_windows_json) as TrainingM4CapacityWindow[];
    const windows = JSON.parse(row.capacity_windows_json) as TrainingM4CapacityWindow[];
    const sources = normalizedSources(JSON.parse(row.provider_sources_json) as CalendarSource[]);
    validateTrainingM4CapacityWindowShapes(profileWindows);
    validateTrainingM4CapacityWindowShapes(windows);
    if (sources.length === 0 || !sameSources(sources, normalizedSources(configuredSources))) return null;
    if (row.profile_source_version !== computeTrainingM4CapacityProfileSourceVersion(
      db,
      scope,
      profileWindows,
    )) return null;
    return {
      source: 'AUTHORITATIVE',
      contextVersion: row.context_version,
      windows: cloneWindows(windows),
      observedAt: row.observed_at,
      expiresAt: row.expires_at,
      profileSourceVersion: row.profile_source_version,
      calendarEventSetHash: row.calendar_event_set_hash,
      calendarSources: sources,
      planStartDate: row.plan_start_date,
      planEndDate: row.plan_end_date,
      horizonWeeks: row.horizon_weeks,
      conflictCount: row.conflict_count,
    };
  } catch {
    return null;
  }
}

function normalizeRefreshRequest(request: TrainingM4CapacityRefreshRequest): TrainingM4CapacityRefreshRequest {
  if (!request || typeof request !== 'object'
      || !/^\d{4}-\d{2}-\d{2}$/.test(request.planStartDate ?? '')
      || !DateTime.fromISO(request.planStartDate, { zone: 'utc' }).isValid) {
    throw capacityError('TRAINING_M4_CAPACITY_PLAN_START_INVALID', 'A valid plan start date is required.', 400);
  }
  if (!Number.isSafeInteger(request.horizonWeeks) || request.horizonWeeks < 1 || request.horizonWeeks > 52) {
    throw capacityError('TRAINING_M4_CAPACITY_HORIZON_INVALID', 'Capacity horizon must be between 1 and 52 weeks.', 400);
  }
  try {
    validateTrainingM4CapacityWindowShapes(request.profileWindows);
  } catch {
    throw capacityError('TRAINING_M4_CAPACITY_PROFILE_WINDOWS_INVALID', 'Profile availability windows are invalid.', 400);
  }
  if (request.profileWindows.length > TRAINING_M4_CAPACITY_REFRESH_MAX_WINDOWS) {
    throw capacityError(
      'TRAINING_M4_CAPACITY_PROFILE_WINDOW_COUNT_INVALID',
      'Authoritative capacity accepts at most one availability window for each weekday.',
      400,
    );
  }
  if (new Set(request.profileWindows.map((window) => window.dayOfWeek)).size !== request.profileWindows.length) {
    throw capacityError(
      'TRAINING_M4_CAPACITY_PROFILE_WINDOW_DAY_DUPLICATE',
      'Authoritative capacity accepts one availability window for each selected weekday.',
      400,
    );
  }
  if (new Set(request.profileWindows.map((window) => window.timezone)).size !== 1) {
    throw capacityError(
      'TRAINING_M4_CAPACITY_PROFILE_TIMEZONE_MISMATCH',
      'Authoritative capacity requires one consistent profile timezone.',
      400,
    );
  }
  return {
    planStartDate: request.planStartDate,
    horizonWeeks: request.horizonWeeks,
    profileWindows: normalizeWindows(request.profileWindows),
  };
}

function calendarFetchRange(request: TrainingM4CapacityRefreshRequest): { startAt: string; endAt: string } {
  const endDate = trainingM4PlanEndDate(request.planStartDate, request.horizonWeeks);
  const zones = [...new Set(request.profileWindows.map((window) => window.timezone))];
  const starts = zones.map((zone) => DateTime.fromISO(`${request.planStartDate}T00:00`, { zone }).toUTC());
  const ends = zones.map((zone) => DateTime.fromISO(`${endDate}T00:00`, { zone }).plus({ days: 1 }).toUTC());
  const start = starts.reduce((earliest, value) => value.toMillis() < earliest.toMillis() ? value : earliest);
  const end = ends.reduce((latest, value) => value.toMillis() > latest.toMillis() ? value : latest);
  return { startAt: start.toISO()!, endAt: end.toISO()! };
}

function materializeConflictFreeWindows(
  request: TrainingM4CapacityRefreshRequest,
  events: NormalizedCalendarEvent[],
): {
  windows: TrainingM4CapacityWindow[];
  conflictCount: number;
  diagnostics: TrainingM4CapacityMaterializationDiagnostics;
} {
  const endDate = trainingM4PlanEndDate(request.planStartDate, request.horizonWeeks);
  const busyIntervals = mergeCalendarBusyIntervals(events);
  const wallClockDays: WallClockDayCache = {
    values: new Map(),
    diagnostics: { wallClockDayBuilds: 0, timezoneOffsetLookups: 0 },
  };
  const occurrenceRanges = materializationOccurrenceRanges(request, endDate, wallClockDays);
  const windows = request.profileWindows.flatMap((window) => {
    const duration = clockMinutes(window.endTime) - clockMinutes(window.startTime);
    let common: Segment[] = [{ start: 0, end: duration }];
    for (const date of occurrenceDates(request.planStartDate, endDate, window.dayOfWeek)) {
      const instantRanges = wallClockWindowInstantRanges(date, window, wallClockDays);
      if (instantRanges.length === 0) return [];
      const instantStartMs = instantRanges[0].startMs;
      const instantEndMs = instantRanges.at(-1)!.endMs;
      const busy = [
        ...unavailableWallClockSegments(date, window, duration, wallClockDays),
        ...busyIntervalsOverlapping(busyIntervals, instantStartMs, instantEndMs).flatMap((interval) => {
        const busyStart = wallClockOffsetMinutes(
          interval.startMs, date, window.timezone, clockMinutes(window.startTime), 'floor',
        );
        const busyEnd = wallClockOffsetMinutes(
          interval.endMs, date, window.timezone, clockMinutes(window.startTime), 'ceil',
        );
        if (busyEnd <= 0 || busyStart >= duration || busyEnd <= busyStart) return [];
        return [{
          start: Math.max(0, busyStart),
          end: Math.min(duration, busyEnd),
        }];
        }),
      ];
      common = intersectSegments(common, subtractSegments(duration, busy));
      if (common.length === 0) break;
    }
    return common
      .filter((segment) => segment.end - segment.start >= MIN_CAPACITY_SEGMENT_MINUTES)
      .map((segment) => ({
        dayOfWeek: window.dayOfWeek,
        startTime: timeFromMinutes(clockMinutes(window.startTime) + segment.start),
        endTime: timeFromMinutes(clockMinutes(window.startTime) + segment.end),
        timezone: window.timezone,
        ...(window.allowedDisciplines
          ? { allowedDisciplines: [...window.allowedDisciplines] }
          : {}),
      }));
  });
  return {
    windows: normalizeWindows(windows),
    conflictCount: countConflictingEvents(events, occurrenceRanges),
    diagnostics: { ...wallClockDays.diagnostics },
  };
}

interface Segment { start: number; end: number }
interface InstantRange { startMs: number; endMs: number }
interface WallClockDaySegment extends Segment { offsetMinutes: number }
interface WallClockDayCache {
  values: Map<string, WallClockDaySegment[]>;
  diagnostics: TrainingM4CapacityMaterializationDiagnostics;
}

interface NormalizedCalendarEvent {
  identity: string;
  id: string;
  source: CalendarSource;
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  isAllDay: boolean;
  timeZone: string;
  blocksTime: boolean;
  syncedSources: CalendarSource[];
}

function mergeCalendarBusyIntervals(events: NormalizedCalendarEvent[]): InstantRange[] {
  const merged: InstantRange[] = [];
  for (const event of events) {
    if (!event.blocksTime) continue;
    const previous = merged.at(-1);
    if (!previous || event.startMs > previous.endMs) {
      merged.push({ startMs: event.startMs, endMs: event.endMs });
    } else {
      previous.endMs = Math.max(previous.endMs, event.endMs);
    }
  }
  return merged;
}

function busyIntervalsOverlapping(
  intervals: InstantRange[],
  startMs: number,
  endMs: number,
): InstantRange[] {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (intervals[middle].endMs <= startMs) low = middle + 1;
    else high = middle;
  }
  const overlapping: InstantRange[] = [];
  for (let index = low; index < intervals.length && intervals[index].startMs < endMs; index += 1) {
    overlapping.push(intervals[index]);
  }
  return overlapping;
}

function materializationOccurrenceRanges(
  request: TrainingM4CapacityRefreshRequest,
  endDate: string,
  wallClockDays: WallClockDayCache,
): InstantRange[] {
  const ranges = request.profileWindows.flatMap((window) =>
    occurrenceDates(request.planStartDate, endDate, window.dayOfWeek)
      .flatMap((date) => wallClockWindowInstantRanges(date, window, wallClockDays)))
    .filter((range) => Number.isFinite(range.startMs) && Number.isFinite(range.endMs) && range.endMs > range.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  return ranges.reduce<InstantRange[]>((merged, range) => {
    const previous = merged.at(-1);
    if (!previous || range.startMs > previous.endMs) merged.push({ ...range });
    else previous.endMs = Math.max(previous.endMs, range.endMs);
    return merged;
  }, []);
}

function wallClockWindowInstantRanges(
  date: string,
  window: TrainingM4CapacityWindow,
  cache: WallClockDayCache,
): InstantRange[] {
  const startMinute = clockMinutes(window.startTime);
  const endMinute = clockMinutes(window.endTime);
  const localDayStartMs = Date.parse(`${date}T00:00:00.000Z`);
  const ranges: InstantRange[] = [];
  for (const segment of wallClockDaySegments(date, window.timezone, cache)) {
    const start = Math.max(startMinute, segment.start);
    const end = Math.min(endMinute, segment.end);
    if (end <= start) continue;
    const range = {
      startMs: localDayStartMs + (start - segment.offsetMinutes) * 60_000,
      endMs: localDayStartMs + (end - segment.offsetMinutes) * 60_000,
    };
    const previous = ranges.at(-1);
    if (previous?.endMs === range.startMs) previous.endMs = range.endMs;
    else ranges.push(range);
  }
  return ranges;
}

function countConflictingEvents(
  events: NormalizedCalendarEvent[],
  occurrenceRanges: InstantRange[],
): number {
  const identities = new Set<string>();
  let rangeIndex = 0;
  for (const event of events) {
    if (!event.blocksTime) continue;
    while (rangeIndex < occurrenceRanges.length
        && occurrenceRanges[rangeIndex].endMs <= event.startMs) rangeIndex += 1;
    const range = occurrenceRanges[rangeIndex];
    if (range && range.startMs < event.endMs) identities.add(event.identity);
  }
  return identities.size;
}

function validateAndNormalizeEvents(
  events: UnifiedCalendarEvent[],
  profileTimeZones: string[],
): NormalizedCalendarEvent[] {
  if (!Array.isArray(events) || events.length > 50_000) {
    throw capacityError('TRAINING_M4_CAPACITY_EVENT_SET_INVALID', 'Calendar event coverage is invalid.', 503);
  }
  const instantCache = new Map<string, number>();
  return events.map((event) => {
    if (event.blocksTime !== undefined && typeof event.blocksTime !== 'boolean') {
      throw capacityError('TRAINING_M4_CAPACITY_EVENT_SET_INVALID', 'Calendar event coverage is invalid.', 503);
    }
    if (event.timeZone !== undefined && !validTimeZone(event.timeZone)) {
      throw capacityError('TRAINING_M4_CAPACITY_EVENT_SET_INVALID', 'Calendar event coverage is invalid.', 503);
    }
    const isAllDay = Boolean(event.isAllDay)
      || (/^\d{4}-\d{2}-\d{2}$/.test(event.start) && /^\d{4}-\d{2}-\d{2}$/.test(event.end));
    const hasExplicitStartOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(event.start);
    if (!isAllDay && !hasExplicitStartOffset && event.timeZone === undefined) {
      throw capacityError('TRAINING_M4_CAPACITY_EVENT_SET_INVALID', 'Calendar event coverage is invalid.', 503);
    }
    const timeZone = event.timeZone ?? profileTimeZones[0] ?? config.app.timezone;
    if (!validTimeZone(timeZone)) {
      throw capacityError('TRAINING_M4_CAPACITY_EVENT_SET_INVALID', 'Calendar event coverage is invalid.', 503);
    }
    const allDayZones = isAllDay
      ? [...new Set([timeZone, ...profileTimeZones])]
      : [timeZone];
    const starts = allDayZones.map((zone) => calendarInstant(event.start, zone, isAllDay, instantCache));
    const ends = allDayZones.map((zone) => calendarInstant(event.end, zone, isAllDay, instantCache));
    const startMs = Math.min(...starts);
    const endMs = Math.max(...ends);
    if (!event.id || !['google', 'outlook'].includes(event.source)
        || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw capacityError('TRAINING_M4_CAPACITY_EVENT_SET_INVALID', 'Calendar event coverage is invalid.', 503);
    }
    const syncedSources = normalizedSources(event.syncedSources ?? []);
    return {
      identity: `${event.source}:${event.id}`,
      id: event.id,
      source: event.source,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      startMs,
      endMs,
      isAllDay,
      timeZone,
      blocksTime: event.blocksTime !== false,
      syncedSources,
    };
  }).sort((left, right) => left.startMs - right.startMs
    || left.endMs - right.endMs
    || left.identity.localeCompare(right.identity));
}

function wallClockOffsetMinutes(
  instantMs: number,
  date: string,
  timeZone: string,
  windowStartMinute: number,
  rounding: 'floor' | 'ceil',
): number {
  const local = DateTime.fromMillis(instantMs, { zone: timeZone });
  const dayDelta = Math.round(
    DateTime.fromISO(local.toISODate()!, { zone: 'utc' }).diff(
      DateTime.fromISO(date, { zone: 'utc' }),
      'days',
    ).days,
  );
  const wallMinute = (dayDelta * 1440)
    + (local.hour * 60)
    + local.minute
    + (local.second / 60)
    + (local.millisecond / 60_000)
    - windowStartMinute;
  return rounding === 'floor' ? Math.floor(wallMinute) : Math.ceil(wallMinute);
}

/**
 * A recurring wall-clock window can cross a DST gap or repeated hour. Mark
 * every nonexistent or ambiguous local minute unavailable so the materialized
 * recurring capacity never schedules a session into a wall time that cannot
 * be represented consistently across the horizon.
 */
function unavailableWallClockSegments(
  date: string,
  window: TrainingM4CapacityWindow,
  duration: number,
  cache: WallClockDayCache,
): Segment[] {
  const startMinute = clockMinutes(window.startTime);
  const endMinute = startMinute + duration;
  const unavailable: Segment[] = [];
  let cursor = startMinute;
  for (const segment of wallClockDaySegments(date, window.timezone, cache)) {
    const validStart = Math.max(startMinute, segment.start);
    const validEnd = Math.min(endMinute, segment.end);
    if (validEnd <= validStart) continue;
    if (validStart > cursor) {
      unavailable.push({ start: cursor - startMinute, end: validStart - startMinute });
    }
    cursor = Math.max(cursor, validEnd);
  }
  if (cursor < endMinute) unavailable.push({ start: cursor - startMinute, end: duration });
  return unavailable;
}

/**
 * Build the unambiguous wall-clock minute ranges for one local date without a
 * per-minute Luxon allocation. UTC offset segments are discovered with a small
 * bounded scan and exact transition search, then projected onto the local day.
 * Gaps have zero covering segments and repeated hours have two, so both remain
 * unavailable exactly as required by the capacity contract.
 */
function wallClockDaySegments(
  date: string,
  timeZone: string,
  cache: WallClockDayCache,
): WallClockDaySegment[] {
  const key = `${date}\u0000${timeZone}`;
  const cached = cache.values.get(key);
  if (cached) return cached;
  cache.diagnostics.wallClockDayBuilds += 1;

  const zone = IANAZone.create(timeZone);
  const localDayStartMs = Date.parse(`${date}T00:00:00.000Z`);
  const localDayEndMs = localDayStartMs + 24 * 60 * 60_000;
  const searchStartMs = localDayStartMs - 36 * 60 * 60_000;
  const searchEndMs = localDayEndMs + 36 * 60 * 60_000;
  const probeStepMs = 6 * 60 * 60_000;
  const utcSegments: Array<InstantRange & { offsetMinutes: number }> = [];
  let segmentStartMs = searchStartMs;
  let offsetMinutes = timezoneOffset(zone, searchStartMs, cache);

  for (let probeStartMs = searchStartMs;
    probeStartMs < searchEndMs;
    probeStartMs += probeStepMs) {
    const probeEndMs = Math.min(searchEndMs, probeStartMs + probeStepMs);
    const nextOffsetMinutes = timezoneOffset(zone, probeEndMs, cache);
    if (nextOffsetMinutes === offsetMinutes) continue;
    const transitionMs = firstOffsetChange(zone, probeStartMs, probeEndMs, offsetMinutes, cache);
    utcSegments.push({ startMs: segmentStartMs, endMs: transitionMs, offsetMinutes });
    segmentStartMs = transitionMs;
    offsetMinutes = timezoneOffset(zone, transitionMs, cache);
  }
  utcSegments.push({ startMs: segmentStartMs, endMs: searchEndMs, offsetMinutes });

  const projected = utcSegments.map((segment) => ({
    startMs: Math.max(localDayStartMs, segment.startMs + segment.offsetMinutes * 60_000),
    endMs: Math.min(localDayEndMs, segment.endMs + segment.offsetMinutes * 60_000),
    offsetMinutes: segment.offsetMinutes,
  })).filter((segment) => segment.endMs > segment.startMs);
  const boundaries = [...new Set(projected.flatMap((segment) => [segment.startMs, segment.endMs]))]
    .sort((left, right) => left - right);
  const result: WallClockDaySegment[] = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const startMs = boundaries[index];
    const endMs = boundaries[index + 1];
    const active = projected.filter((segment) => segment.startMs <= startMs && segment.endMs >= endMs);
    if (active.length !== 1) continue;
    const start = Math.ceil((startMs - localDayStartMs) / 60_000);
    const end = Math.ceil((endMs - localDayStartMs) / 60_000);
    if (end <= start) continue;
    const previous = result.at(-1);
    if (previous?.end === start && previous.offsetMinutes === active[0].offsetMinutes) previous.end = end;
    else result.push({ start, end, offsetMinutes: active[0].offsetMinutes });
  }
  cache.values.set(key, result);
  return result;
}

function firstOffsetChange(
  zone: IANAZone,
  startMs: number,
  endMs: number,
  startingOffsetMinutes: number,
  cache: WallClockDayCache,
): number {
  let low = startMs;
  let high = endMs;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (timezoneOffset(zone, middle, cache) === startingOffsetMinutes) low = middle;
    else high = middle;
  }
  return high;
}

function timezoneOffset(zone: IANAZone, instantMs: number, cache: WallClockDayCache): number {
  cache.diagnostics.timezoneOffsetLookups += 1;
  return zone.offset(instantMs);
}

function subtractSegments(duration: number, busy: Segment[]): Segment[] {
  const normalized = busy
    .filter((segment) => segment.end > segment.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .reduce<Segment[]>((result, segment) => {
      const previous = result.at(-1);
      if (!previous || segment.start > previous.end) result.push({ ...segment });
      else previous.end = Math.max(previous.end, segment.end);
      return result;
    }, []);
  const free: Segment[] = [];
  let cursor = 0;
  for (const segment of normalized) {
    if (segment.start > cursor) free.push({ start: cursor, end: segment.start });
    cursor = Math.max(cursor, segment.end);
  }
  if (cursor < duration) free.push({ start: cursor, end: duration });
  return free;
}

function intersectSegments(left: Segment[], right: Segment[]): Segment[] {
  const intersections: Segment[] = [];
  for (const first of left) {
    for (const second of right) {
      const start = Math.max(first.start, second.start);
      const end = Math.min(first.end, second.end);
      if (end > start) intersections.push({ start, end });
    }
  }
  return intersections;
}

function calendarInstant(
  value: string,
  timeZone: string,
  isAllDay: boolean,
  cache?: Map<string, number>,
): number {
  const cacheKey = `${isAllDay ? 'day' : 'time'}\u0000${timeZone}\u0000${value}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey)!;
  let result: number;
  if (isAllDay) {
    result = DateTime.fromISO(value.slice(0, 10), { zone: timeZone }).startOf('day').toMillis();
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    result = Date.parse(value);
  } else {
    result = DateTime.fromISO(value, { zone: timeZone }).toMillis();
  }
  cache?.set(cacheKey, result);
  return result;
}

function validTimeZone(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 100
    && DateTime.now().setZone(value).isValid;
}

function occurrenceDates(startDate: string, endDate: string, dayOfWeek: string): string[] {
  const index = TRAINING_M4_DAYS.indexOf(dayOfWeek as never);
  const dates: string[] = [];
  for (let date = DateTime.fromISO(startDate, { zone: 'utc' });
    date.toISODate()! <= endDate;
    date = date.plus({ days: 1 })) {
    const weekday = date.weekday === 7 ? 6 : date.weekday - 1;
    if (weekday === index) dates.push(date.toISODate()!);
  }
  return dates;
}

function normalizeWindows(windows: readonly TrainingM4CapacityWindow[]): TrainingM4CapacityWindow[] {
  return cloneWindows(windows).map((window) => ({
    ...window,
    ...(window.allowedDisciplines
      ? { allowedDisciplines: [...new Set(window.allowedDisciplines)].sort() }
      : {}),
  })).sort((left, right) => TRAINING_M4_DAYS.indexOf(left.dayOfWeek) - TRAINING_M4_DAYS.indexOf(right.dayOfWeek)
    || left.startTime.localeCompare(right.startTime)
    || left.endTime.localeCompare(right.endTime)
    || left.timezone.localeCompare(right.timezone)
    || JSON.stringify(left.allowedDisciplines ?? []).localeCompare(JSON.stringify(right.allowedDisciplines ?? [])));
}

function cloneWindows(windows: readonly TrainingM4CapacityWindow[]): TrainingM4CapacityWindow[] {
  return windows.map((window) => ({
    ...window,
    ...(window.allowedDisciplines ? { allowedDisciplines: [...window.allowedDisciplines] } : {}),
  }));
}

function normalizedSources(sources: readonly CalendarSource[]): CalendarSource[] {
  return [...new Set(sources.filter((source) => source === 'google' || source === 'outlook'))].sort();
}

function sameSources(left: readonly CalendarSource[], right: readonly CalendarSource[]): boolean {
  return left.length === right.length && left.every((source, index) => source === right[index]);
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function timeFromMinutes(value: number): string {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function requirePersonalScope(scope: { userId: number; tenantId: number }): void {
  if (!Number.isSafeInteger(scope.userId) || scope.userId <= 0
      || !Number.isSafeInteger(scope.tenantId) || scope.tenantId <= 0
      || scope.userId !== scope.tenantId) {
    throw capacityError(
      'TRAINING_M4_CAPACITY_PERSONAL_SCOPE_REQUIRED',
      'Authoritative capacity is limited to the exact personal tenant and user scope.',
      404,
    );
  }
}

function requireIdempotencyKey(value: string): void {
  if (!value?.trim() || value !== value.trim() || value.length > 200) {
    throw capacityError('TRAINING_M4_CAPACITY_IDEMPOTENCY_REQUIRED', 'A valid Idempotency-Key is required.', 428);
  }
}

function requireValidClock(now: Date): void {
  if (!Number.isFinite(now.getTime())) {
    throw capacityError('TRAINING_M4_CAPACITY_CLOCK_INVALID', 'Capacity refresh clock is invalid.', 500);
  }
}

function requireSnapshotSchema(db: Database.Database): void {
  if (!tableExists(db, 'training_m4_capacity_snapshots')) {
    throw capacityError('TRAINING_M4_CAPACITY_SCHEMA_UNAVAILABLE', 'Capacity snapshot schema is unavailable.', 503);
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function isSqliteConstraint(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && String((error as { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT'));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function capacityError(code: string, message: string, statusCode: number): TrainingPlanRevisionError {
  return new TrainingPlanRevisionError(code, message, statusCode);
}
