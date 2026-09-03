// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { config } from '../config';
import { canonicalizeIanaTimezone } from './secretary-timezone';
import { getDb } from './database';

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_WORKING_WINDOWS = 14;
const MAX_FOCUS_WINDOWS = 14;
const MAX_PROTECTED_ROUTINES = 28;
export const SECRETARY_ROUTINE_IDEMPOTENCY_RETENTION_DAYS = 30;
const IDEMPOTENCY_RETENTION_MS = SECRETARY_ROUTINE_IDEMPOTENCY_RETENTION_DAYS
  * 24 * 60 * 60 * 1000;
const DEFAULT_RECEIPT_PRUNE_LIMIT = 500;
const MAX_RECEIPT_PRUNE_LIMIT = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOCK_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const IDEMPOTENCY_KEY_PATTERN = /^[^\u0000-\u001f\u007f]+$/;

export type SecretaryRoutineKind =
  | 'focus'
  | 'training'
  | 'meal'
  | 'recovery'
  | 'personal'
  | 'travel';

const ROUTINE_KINDS = new Set<SecretaryRoutineKind>([
  'focus',
  'training',
  'meal',
  'recovery',
  'personal',
  'travel',
]);

export interface SecretaryRoutineScope {
  userId: number;
  tenantId: number;
}

export interface SecretaryRoutineWindow {
  id: string;
  weekdays: number[];
  start: string;
  end: string;
}

export interface SecretaryProtectedRoutine extends SecretaryRoutineWindow {
  label: string;
  kind: SecretaryRoutineKind;
}

export interface SecretaryRoutineProfile {
  status: 'unconfigured' | 'configured';
  version: number;
  timezone: string;
  workingWindows: SecretaryRoutineWindow[];
  preferredFocusWindows: SecretaryRoutineWindow[];
  protectedRoutines: SecretaryProtectedRoutine[];
  updatedAt: string | null;
}

export interface PutSecretaryRoutineProfileInput {
  expectedVersion: number;
  idempotencyKey: string;
  timezone: string;
  workingWindows: SecretaryRoutineWindow[];
  preferredFocusWindows: SecretaryRoutineWindow[];
  protectedRoutines: SecretaryProtectedRoutine[];
}

export type SecretaryRoutineProfileErrorCode =
  | 'INVALID_INPUT'
  | 'ROUTINE_PROFILE_INVALID'
  | 'SECRETARY_ROUTINE_VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED';

export class SecretaryRoutineProfileError extends Error {
  readonly code: SecretaryRoutineProfileErrorCode;
  readonly status: 400 | 409 | 422;
  readonly details?: Record<string, unknown>;

  constructor(
    code: SecretaryRoutineProfileErrorCode,
    message: string,
    status: 400 | 409 | 422,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SecretaryRoutineProfileError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type StoredProfileRow = {
  version: number;
  working_windows_json: string;
  preferred_focus_windows_json: string;
  protected_routines_json: string;
  updated_at: string;
};

type StoredReceiptRow = {
  request_hash: string;
  response_json: string;
};

type StoredReceiptPayload = {
  profile: SecretaryRoutineProfile;
  changed: boolean;
};

type CanonicalPutInput = PutSecretaryRoutineProfileInput;

function invalidInput(message: string, details?: Record<string, unknown>): never {
  throw new SecretaryRoutineProfileError('INVALID_INPUT', message, 400, details);
}

function invalidProfile(message: string, details?: Record<string, unknown>): never {
  throw new SecretaryRoutineProfileError('ROUTINE_PROFILE_INVALID', message, 422, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  reject: (message: string) => never,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) reject(`${field} contains unsupported field ${unexpected.sort()[0]}.`);
}

function assertCanonicalScope(scope: SecretaryRoutineScope): void {
  if (
    !Number.isSafeInteger(scope.userId)
    || scope.userId <= 0
    || !Number.isSafeInteger(scope.tenantId)
    || scope.tenantId <= 0
    || scope.userId !== scope.tenantId
  ) {
    invalidInput('Authenticated user and tenant scope must be the same canonical identifier.');
  }
}

function requestSizeBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') invalidInput('Request body must be a JSON object.');
    return Buffer.byteLength(encoded, 'utf8');
  } catch (error) {
    if (error instanceof SecretaryRoutineProfileError) throw error;
    invalidInput('Request body must be valid JSON.');
  }
}

function normalizeIdempotencyKey(bodyValue: unknown, headerValue: unknown): string {
  if (typeof bodyValue !== 'string' || typeof headerValue !== 'string') {
    invalidInput('idempotencyKey and X-Idempotency-Key are required.');
  }
  const bodyKey = bodyValue.trim();
  const headerKey = headerValue.trim();
  if (
    bodyKey.length < 8
    || bodyKey.length > 200
    || !IDEMPOTENCY_KEY_PATTERN.test(bodyKey)
  ) {
    invalidInput('idempotencyKey must contain 8 to 200 visible characters.');
  }
  if (bodyKey !== headerKey) {
    invalidInput('idempotencyKey must match X-Idempotency-Key.');
  }
  return bodyKey;
}

function normalizeExpectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalidInput('expectedVersion must be a non-negative integer.');
  }
  return Number(value);
}

function normalizeTimezone(value: unknown): string {
  if (typeof value !== 'string') invalidProfile('timezone must be a valid IANA zone identifier.');
  const timezone = canonicalizeIanaTimezone(value);
  if (!timezone) invalidProfile('timezone must be a valid IANA zone identifier.');
  return timezone;
}

function normalizeWeekdays(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 7) {
    invalidProfile(`${field}.weekdays must contain one to seven ISO weekdays.`);
  }
  const weekdays = value.map((day) => {
    if (!Number.isInteger(day) || Number(day) < 1 || Number(day) > 7) {
      invalidProfile(`${field}.weekdays must use ISO weekday integers 1 through 7.`);
    }
    return Number(day);
  });
  if (new Set(weekdays).size !== weekdays.length) {
    invalidProfile(`${field}.weekdays must not contain duplicates.`);
  }
  return weekdays.sort((left, right) => left - right);
}

function normalizeClockRange(
  value: Record<string, unknown>,
  field: string,
): { start: string; end: string } {
  const start = typeof value.start === 'string' ? value.start.trim() : '';
  const end = typeof value.end === 'string' ? value.end.trim() : '';
  if (!CLOCK_TIME_PATTERN.test(start) || !CLOCK_TIME_PATTERN.test(end)) {
    invalidProfile(`${field}.start and ${field}.end must use same-day HH:mm values.`);
  }
  if (start >= end) {
    invalidProfile(`${field}.start must be earlier than ${field}.end on the same day.`);
  }
  return { start, end };
}

function normalizeWindow(
  value: unknown,
  field: string,
  additionalKeys: readonly string[] = [],
): SecretaryRoutineWindow {
  if (!isRecord(value)) invalidProfile(`${field} must be an object.`);
  assertOnlyKeys(value, ['id', 'weekdays', 'start', 'end', ...additionalKeys], field, invalidProfile);
  const id = typeof value.id === 'string' ? value.id.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(id)) invalidProfile(`${field}.id must be a UUID.`);
  const weekdays = normalizeWeekdays(value.weekdays, field);
  const { start, end } = normalizeClockRange(value, field);
  return { id, weekdays, start, end };
}

function normalizeProtectedRoutine(value: unknown, field: string): SecretaryProtectedRoutine {
  if (!isRecord(value)) invalidProfile(`${field} must be an object.`);
  const window = normalizeWindow(value, field, ['label', 'kind']);
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  if (Array.from(label).length < 1 || Array.from(label).length > 80) {
    invalidProfile(`${field}.label must contain 1 to 80 characters.`);
  }
  const kind = typeof value.kind === 'string'
    ? value.kind.trim().toLowerCase() as SecretaryRoutineKind
    : '' as SecretaryRoutineKind;
  if (!ROUTINE_KINDS.has(kind)) {
    invalidProfile(`${field}.kind must be focus, training, meal, recovery, personal, or travel.`);
  }
  return { ...window, label, kind };
}

function compareWindows(left: SecretaryRoutineWindow, right: SecretaryRoutineWindow): number {
  return (left.weekdays[0] ?? 0) - (right.weekdays[0] ?? 0)
    || left.start.localeCompare(right.start)
    || left.end.localeCompare(right.end)
    || left.id.localeCompare(right.id);
}

function normalizeWindowArray(
  value: unknown,
  field: string,
  maxItems: number,
): SecretaryRoutineWindow[] {
  if (!Array.isArray(value)) invalidProfile(`${field} must be an array.`);
  if (value.length > maxItems) invalidProfile(`${field} may contain at most ${maxItems} entries.`);
  return value.map((entry, index) => normalizeWindow(entry, `${field}[${index}]`)).sort(compareWindows);
}

function normalizeProtectedRoutineArray(value: unknown): SecretaryProtectedRoutine[] {
  if (!Array.isArray(value)) invalidProfile('protectedRoutines must be an array.');
  if (value.length > MAX_PROTECTED_ROUTINES) {
    invalidProfile(`protectedRoutines may contain at most ${MAX_PROTECTED_ROUTINES} entries.`);
  }
  return value
    .map((entry, index) => normalizeProtectedRoutine(entry, `protectedRoutines[${index}]`))
    .sort(compareWindows);
}

function assertUniqueIds(
  working: SecretaryRoutineWindow[],
  focus: SecretaryRoutineWindow[],
  protectedRoutines: SecretaryProtectedRoutine[],
): void {
  const ids = [...working, ...focus, ...protectedRoutines].map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) invalidProfile('Routine entry UUIDs must be unique across the profile.');
}

function minuteOfDay(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours! * 60 + minutes!;
}

function assertNoOverlap(windows: SecretaryRoutineWindow[], field: string): void {
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const intervals = windows
      .filter((window) => window.weekdays.includes(weekday))
      .map((window) => ({ ...window, startMinute: minuteOfDay(window.start), endMinute: minuteOfDay(window.end) }))
      .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);
    for (let index = 1; index < intervals.length; index += 1) {
      const previous = intervals[index - 1]!;
      const current = intervals[index]!;
      if (current.startMinute < previous.endMinute) {
        invalidProfile(`${field} entries must not overlap on ISO weekday ${weekday}.`);
      }
    }
  }
}

function assertFocusContained(
  focusWindows: SecretaryRoutineWindow[],
  workingWindows: SecretaryRoutineWindow[],
): void {
  for (const focus of focusWindows) {
    for (const weekday of focus.weekdays) {
      const contained = workingWindows.some((working) => (
        working.weekdays.includes(weekday)
        && working.start <= focus.start
        && working.end >= focus.end
      ));
      if (!contained) {
        invalidProfile(`preferredFocusWindows entry ${focus.id} must be contained in a working window on ISO weekday ${weekday}.`);
      }
    }
  }
}

function normalizePutInput(
  value: unknown,
  headerIdempotencyKey: unknown,
): CanonicalPutInput {
  if (requestSizeBytes(value) > MAX_REQUEST_BYTES) {
    invalidInput(`Request body must not exceed ${MAX_REQUEST_BYTES} bytes.`);
  }
  if (!isRecord(value)) invalidInput('Request body must be a JSON object.');
  assertOnlyKeys(value, [
    'expectedVersion',
    'idempotencyKey',
    'timezone',
    'workingWindows',
    'preferredFocusWindows',
    'protectedRoutines',
  ], 'Request body', invalidInput);

  const expectedVersion = normalizeExpectedVersion(value.expectedVersion);
  const idempotencyKey = normalizeIdempotencyKey(value.idempotencyKey, headerIdempotencyKey);
  const timezone = normalizeTimezone(value.timezone);

  const workingWindows = normalizeWindowArray(
    value.workingWindows,
    'workingWindows',
    MAX_WORKING_WINDOWS,
  );
  const preferredFocusWindows = normalizeWindowArray(
    value.preferredFocusWindows,
    'preferredFocusWindows',
    MAX_FOCUS_WINDOWS,
  );
  const protectedRoutines = normalizeProtectedRoutineArray(value.protectedRoutines);
  assertUniqueIds(workingWindows, preferredFocusWindows, protectedRoutines);
  assertNoOverlap(workingWindows, 'workingWindows');
  assertNoOverlap(preferredFocusWindows, 'preferredFocusWindows');
  assertNoOverlap(protectedRoutines, 'protectedRoutines');
  assertFocusContained(preferredFocusWindows, workingWindows);

  return {
    expectedVersion,
    idempotencyKey,
    timezone,
    workingWindows,
    preferredFocusWindows,
    protectedRoutines,
  };
}

function canonicalRequestHash(input: CanonicalPutInput): string {
  return createHash('sha256').update(JSON.stringify({
    expectedVersion: input.expectedVersion,
    timezone: input.timezone,
    workingWindows: input.workingWindows,
    preferredFocusWindows: input.preferredFocusWindows,
    protectedRoutines: input.protectedRoutines,
  })).digest('hex');
}

function parseStoredArray<T>(value: string, field: string): T[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Stored Secretary routine ${field} is not an array.`);
  return parsed as T[];
}

function parseStoredReceipt(value: string): StoredReceiptPayload {
  const parsed = JSON.parse(value) as unknown;
  if (isRecord(parsed) && isRecord(parsed.profile) && typeof parsed.changed === 'boolean') {
    return {
      profile: parsed.profile as unknown as SecretaryRoutineProfile,
      changed: parsed.changed,
    };
  }
  // One-release compatibility for receipts written by the initial additive
  // implementation, which stored only the profile. Conservatively request a
  // cache invalidation: it is harmless for a historical no-op and closes the
  // commit-before-invalidation crash window for a historical mutation.
  return {
    profile: parsed as SecretaryRoutineProfile,
    changed: true,
  };
}

function getStoredUserTimezone(database: Database.Database, userId: number): string {
  const row = database.prepare('SELECT timezone FROM users WHERE id = ?').get(userId) as { timezone: string } | undefined;
  if (!row) invalidInput('Authenticated user no longer exists.');
  return row.timezone;
}

/**
 * Legacy rows may predate strict IANA validation. Reads stay side-effect free
 * and return the same safe fallback as the planner; either settings write can
 * then replace the corrupt value transactionally.
 */
function resolveReadableUserTimezone(storedTimezone: string): string {
  return canonicalizeIanaTimezone(storedTimezone)
    ?? canonicalizeIanaTimezone(config.app.timezone)
    ?? 'Europe/Lisbon';
}

function getStoredProfile(
  database: Database.Database,
  scope: SecretaryRoutineScope,
): StoredProfileRow | undefined {
  return database.prepare(`
    SELECT version, working_windows_json, preferred_focus_windows_json,
           protected_routines_json, updated_at
      FROM secretary_routine_profiles
     WHERE user_id = ? AND tenant_id = ?
  `).get(scope.userId, scope.tenantId) as StoredProfileRow | undefined;
}

function toProfile(timezone: string, row?: StoredProfileRow): SecretaryRoutineProfile {
  if (!row) {
    return {
      status: 'unconfigured',
      version: 0,
      timezone,
      workingWindows: [],
      preferredFocusWindows: [],
      protectedRoutines: [],
      updatedAt: null,
    };
  }
  return {
    status: 'configured',
    version: row.version,
    timezone,
    workingWindows: parseStoredArray<SecretaryRoutineWindow>(row.working_windows_json, 'workingWindows'),
    preferredFocusWindows: parseStoredArray<SecretaryRoutineWindow>(
      row.preferred_focus_windows_json,
      'preferredFocusWindows',
    ),
    protectedRoutines: parseStoredArray<SecretaryProtectedRoutine>(
      row.protected_routines_json,
      'protectedRoutines',
    ),
    updatedAt: row.updated_at,
  };
}

function notificationProfilesTableExists(database: Database.Database): boolean {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notification_profiles'
  `).get());
}

function synchronizeExistingNotificationProfile(
  database: Database.Database,
  scope: SecretaryRoutineScope,
  timezone: string,
  nowIso: string,
): void {
  if (!notificationProfilesTableExists(database)) return;
  database.prepare(`
    UPDATE notification_profiles
       SET timezone = ?, updated_at = ?
     WHERE user_id = ? AND tenant_id = ? AND timezone <> ?
  `).run(timezone, nowIso, scope.userId, scope.tenantId, timezone);
}

export function getSecretaryRoutineProfile(
  scope: SecretaryRoutineScope,
  databaseOverride?: Database.Database,
): SecretaryRoutineProfile {
  // Scope is intentionally checked before resolving the process database.
  // A mismatched authenticated scope therefore performs zero SQL.
  assertCanonicalScope(scope);
  const database = databaseOverride ?? getDb();
  const timezone = resolveReadableUserTimezone(getStoredUserTimezone(database, scope.userId));
  return toProfile(timezone, getStoredProfile(database, scope));
}

/**
 * Bounded global retention sweep for durable routine idempotency receipts.
 * The daily scheduler owns cadence; the scoped PUT cleanup below remains so a
 * caller can reuse its own expired key even while a larger backlog is draining.
 */
export function pruneExpiredSecretaryRoutineIdempotencyReceipts(
  databaseOverride?: Database.Database,
  input: { now?: Date; limit?: number } = {},
): { deleted: number; remaining: number } {
  const database = databaseOverride ?? getDb();
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('secretary_routine_receipt_retention_now_invalid');
  const requestedLimit = input.limit ?? DEFAULT_RECEIPT_PRUNE_LIMIT;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new Error('secretary_routine_receipt_retention_limit_invalid');
  }
  const pruneLimit = Math.min(requestedLimit, MAX_RECEIPT_PRUNE_LIMIT);
  const nowIso = now.toISOString();

  const deleted = database.prepare(`
    DELETE FROM secretary_routine_idempotency_receipts
     WHERE rowid IN (
       SELECT rowid
         FROM secretary_routine_idempotency_receipts
        WHERE expires_at <= ?
        ORDER BY expires_at, rowid
        LIMIT ?
     )
  `).run(nowIso, pruneLimit).changes;
  const remaining = (database.prepare(`
    SELECT COUNT(*) AS count
      FROM secretary_routine_idempotency_receipts
     WHERE expires_at <= ?
  `).get(nowIso) as { count: number }).count;
  return { deleted, remaining };
}

export function putSecretaryRoutineProfile(
  scope: SecretaryRoutineScope,
  rawInput: unknown,
  headerIdempotencyKey: unknown,
  databaseOverride?: Database.Database,
): { profile: SecretaryRoutineProfile; replayed: boolean; changed: boolean } {
  assertCanonicalScope(scope);
  const input = normalizePutInput(rawInput, headerIdempotencyKey);
  const database = databaseOverride ?? getDb();
  const requestHash = canonicalRequestHash(input);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + IDEMPOTENCY_RETENTION_MS).toISOString();

  return database.transaction(() => {
    getStoredUserTimezone(database, scope.userId);
    database.prepare(`
      DELETE FROM secretary_routine_idempotency_receipts
       WHERE user_id = ? AND tenant_id = ? AND expires_at <= ?
    `).run(scope.userId, scope.tenantId, nowIso);

    const receipt = database.prepare(`
      SELECT request_hash, response_json
        FROM secretary_routine_idempotency_receipts
       WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
    `).get(scope.userId, scope.tenantId, input.idempotencyKey) as StoredReceiptRow | undefined;
    if (receipt) {
      if (receipt.request_hash !== requestHash) {
        throw new SecretaryRoutineProfileError(
          'IDEMPOTENCY_KEY_REUSED',
          'This idempotency key was already used for a different request.',
          409,
        );
      }
      const stored = parseStoredReceipt(receipt.response_json);
      return {
        profile: stored.profile,
        replayed: true,
        // Preserve the original mutation outcome so a retry after a process
        // crash can finish successful-only planning-cache invalidation.
        changed: stored.changed,
      };
    }

    const existing = getStoredProfile(database, scope);
    const storedTimezone = getStoredUserTimezone(database, scope.userId);
    const currentTimezone = resolveReadableUserTimezone(storedTimezone);
    const current = toProfile(currentTimezone, existing);
    if (current.version !== input.expectedVersion) {
      throw new SecretaryRoutineProfileError(
        'SECRETARY_ROUTINE_VERSION_CONFLICT',
        'The Secretary routine profile changed. Reload it before saving again.',
        409,
        { current },
      );
    }

    const workingJson = JSON.stringify(input.workingWindows);
    const focusJson = JSON.stringify(input.preferredFocusWindows);
    const protectedJson = JSON.stringify(input.protectedRoutines);
    const unchanged = Boolean(existing)
      && storedTimezone === input.timezone
      && existing!.working_windows_json === workingJson
      && existing!.preferred_focus_windows_json === focusJson
      && existing!.protected_routines_json === protectedJson;

    let profile: SecretaryRoutineProfile;
    if (unchanged) {
      synchronizeExistingNotificationProfile(database, scope, input.timezone, nowIso);
      profile = current;
    } else {
      database.prepare('UPDATE users SET timezone = ? WHERE id = ?')
        .run(input.timezone, scope.userId);
      synchronizeExistingNotificationProfile(database, scope, input.timezone, nowIso);

      if (existing) {
        const updated = database.prepare(`
          UPDATE secretary_routine_profiles
             SET version = version + 1,
                 working_windows_json = ?,
                 preferred_focus_windows_json = ?,
                 protected_routines_json = ?,
                 updated_at = ?
           WHERE user_id = ? AND tenant_id = ? AND version = ?
        `).run(
          workingJson,
          focusJson,
          protectedJson,
          nowIso,
          scope.userId,
          scope.tenantId,
          input.expectedVersion,
        );
        if (updated.changes !== 1) throw new Error('Secretary routine CAS update lost inside an immediate transaction.');
      } else {
        database.prepare(`
          INSERT INTO secretary_routine_profiles (
            user_id, tenant_id, version, working_windows_json,
            preferred_focus_windows_json, protected_routines_json,
            created_at, updated_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
        `).run(
          scope.userId,
          scope.tenantId,
          workingJson,
          focusJson,
          protectedJson,
          nowIso,
          nowIso,
        );
      }
      profile = toProfile(input.timezone, getStoredProfile(database, scope));
    }

    database.prepare(`
      INSERT INTO secretary_routine_idempotency_receipts (
        user_id, tenant_id, idempotency_key, request_hash,
        response_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope.userId,
      scope.tenantId,
      input.idempotencyKey,
      requestHash,
      JSON.stringify({ profile, changed: !unchanged } satisfies StoredReceiptPayload),
      nowIso,
      expiresAt,
    );

    return { profile, replayed: false, changed: !unchanged };
  }).immediate();
}

/**
 * Keep the legacy timezone endpoint compatible while converging its write on
 * the same canonical users/notification projection as routine-profile saves.
 * A configured routine version advances when its canonical timezone changes;
 * an unconfigured account remains unconfigured.
 */
export function synchronizeCanonicalUserTimezone(
  scope: SecretaryRoutineScope,
  rawTimezone: unknown,
  databaseOverride?: Database.Database,
): { timezone: string; routineVersion: number; changed: boolean } {
  assertCanonicalScope(scope);
  const timezone = normalizeTimezone(rawTimezone);
  const database = databaseOverride ?? getDb();
  const nowIso = new Date(Date.now()).toISOString();

  return database.transaction(() => {
    const previousTimezone = getStoredUserTimezone(database, scope.userId);
    const existing = getStoredProfile(database, scope);
    const changed = previousTimezone !== timezone;
    if (changed) {
      database.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(timezone, scope.userId);
      if (existing) {
        database.prepare(`
          UPDATE secretary_routine_profiles
             SET version = version + 1, updated_at = ?
           WHERE user_id = ? AND tenant_id = ? AND version = ?
        `).run(nowIso, scope.userId, scope.tenantId, existing.version);
      }
    }
    synchronizeExistingNotificationProfile(database, scope, timezone, nowIso);
    return {
      timezone,
      routineVersion: existing ? existing.version + (changed ? 1 : 0) : 0,
      changed,
    };
  }).immediate();
}
