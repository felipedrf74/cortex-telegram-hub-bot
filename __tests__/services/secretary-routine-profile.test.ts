import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  getSecretaryRoutineProfile,
  pruneExpiredSecretaryRoutineIdempotencyReceipts,
  putSecretaryRoutineProfile,
  SecretaryRoutineProfileError,
  synchronizeCanonicalUserTimezone,
  type PutSecretaryRoutineProfileInput,
} from '../../src/services/secretary-routine-profile';

let db: Database.Database;

const scope = { userId: 1, tenantId: 1 };

function seedUser(userId: number, timezone = 'Europe/Lisbon'): void {
  db.prepare(`
    INSERT INTO users (id, telegram_id, first_name, language, timezone, status, auth_provider)
    VALUES (?, ?, 'Routine Tester', 'en-US', ?, 'active', 'invite_code')
  `).run(userId, userId, timezone);
}

function validInput(
  overrides: Partial<PutSecretaryRoutineProfileInput> = {},
): PutSecretaryRoutineProfileInput {
  return {
    expectedVersion: 0,
    idempotencyKey: 'routine-save-0001',
    timezone: 'America/Sao_Paulo',
    workingWindows: [{
      id: '11111111-1111-4111-8111-111111111111',
      weekdays: [5, 1, 3, 2, 4],
      start: '09:00',
      end: '18:00',
    }],
    preferredFocusWindows: [{
      id: '22222222-2222-4222-8222-222222222222',
      weekdays: [1, 3],
      start: '10:00',
      end: '12:00',
    }],
    protectedRoutines: [{
      id: '33333333-3333-4333-8333-333333333333',
      weekdays: [2, 4],
      start: '07:00',
      end: '08:00',
      label: 'Training',
      kind: 'training',
    }],
    ...overrides,
  };
}

function captureRoutineError(run: () => unknown): SecretaryRoutineProfileError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretaryRoutineProfileError);
    return error as SecretaryRoutineProfileError;
  }
  throw new Error('Expected SecretaryRoutineProfileError');
}

describe('Secretary routine profile service', () => {
  beforeEach(() => {
    db = createMigratedTestDatabase();
    seedUser(1);
  });

  afterEach(() => {
    db.close();
  });

  it('returns an unconfigured version-zero profile without writing', () => {
    const beforeChanges = db.prepare('SELECT total_changes() AS count').get() as { count: number };

    const profile = getSecretaryRoutineProfile(scope, db);

    const afterChanges = db.prepare('SELECT total_changes() AS count').get() as { count: number };
    expect(profile).toEqual({
      status: 'unconfigured',
      version: 0,
      timezone: 'Europe/Lisbon',
      workingWindows: [],
      preferredFocusWindows: [],
      protectedRoutines: [],
      updatedAt: null,
    });
    expect(afterChanges.count).toBe(beforeChanges.count);
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_routine_profiles').get())
      .toEqual({ count: 0 });
  });

  it('returns a canonical timezone for a valid legacy alias without writing', () => {
    db.prepare("UPDATE users SET timezone = 'Etc/UTC' WHERE id = 1").run();
    const beforeChanges = db.prepare('SELECT total_changes() AS count').get() as { count: number };

    const profile = getSecretaryRoutineProfile(scope, db);

    const afterChanges = db.prepare('SELECT total_changes() AS count').get() as { count: number };
    expect(profile).toMatchObject({ status: 'unconfigured', version: 0, timezone: 'UTC' });
    expect(afterChanges.count).toBe(beforeChanges.count);
    expect(db.prepare('SELECT timezone FROM users WHERE id = 1').get())
      .toEqual({ timezone: 'Etc/UTC' });
  });

  it('keeps an invalid legacy timezone readable and repairable through both settings writers', () => {
    db.prepare("UPDATE users SET timezone = 'legacy-invalid-zone' WHERE id = 1").run();
    const beforeRead = (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count;

    const readable = getSecretaryRoutineProfile(scope, db);

    expect(readable).toMatchObject({ status: 'unconfigured', version: 0, timezone: 'Europe/Lisbon' });
    expect((db.prepare('SELECT total_changes() AS count').get() as { count: number }).count)
      .toBe(beforeRead);

    const saved = putSecretaryRoutineProfile(scope, validInput(), 'routine-save-0001', db);
    expect(saved).toMatchObject({ changed: true, profile: { version: 1, timezone: 'America/Sao_Paulo' } });
    expect(db.prepare('SELECT timezone FROM users WHERE id = 1').get())
      .toEqual({ timezone: 'America/Sao_Paulo' });

    db.prepare("UPDATE users SET timezone = 'legacy-invalid-again' WHERE id = 1").run();
    expect(synchronizeCanonicalUserTimezone(scope, 'Asia/Tokyo', db))
      .toEqual({ timezone: 'Asia/Tokyo', routineVersion: 2, changed: true });
    expect(db.prepare('SELECT timezone FROM users WHERE id = 1').get())
      .toEqual({ timezone: 'Asia/Tokyo' });
  });

  it('rejects a mismatched authenticated scope before touching the database override', () => {
    const forbiddenDb = new Proxy({} as Database.Database, {
      get() {
        throw new Error('database was touched');
      },
    });

    const error = captureRoutineError(() => getSecretaryRoutineProfile(
      { userId: 1, tenantId: 2 },
      forbiddenDb,
    ));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.status).toBe(400);
  });

  it('creates an explicit profile, canonicalizes it, and synchronizes existing timezone projections', () => {
    db.prepare(`
      INSERT INTO notification_profiles (user_id, tenant_id, timezone)
      VALUES (1, 1, 'Europe/Lisbon')
    `).run();

    const result = putSecretaryRoutineProfile(
      scope,
      validInput(),
      'routine-save-0001',
      db,
    );

    expect(result.replayed).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.profile).toMatchObject({
      status: 'configured',
      version: 1,
      timezone: 'America/Sao_Paulo',
    });
    expect(result.profile.workingWindows[0]?.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(result.profile.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(db.prepare('SELECT timezone FROM users WHERE id = 1').get())
      .toEqual({ timezone: 'America/Sao_Paulo' });
    expect(db.prepare('SELECT timezone FROM notification_profiles WHERE user_id = 1 AND tenant_id = 1').get())
      .toEqual({ timezone: 'America/Sao_Paulo' });
    const receipt = db.prepare(`
      SELECT request_hash AS requestHash, response_json AS responseJson,
             created_at AS createdAt, expires_at AS expiresAt
        FROM secretary_routine_idempotency_receipts
       WHERE user_id = 1 AND tenant_id = 1
    `).get() as Record<string, string>;
    expect(receipt.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(receipt.responseJson)).toEqual({ profile: result.profile, changed: true });
    expect(Date.parse(receipt.expiresAt) - Date.parse(receipt.createdAt))
      .toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('rolls back user, routine, receipt, and notification timezone writes atomically', () => {
    db.prepare(`
      INSERT INTO notification_profiles (user_id, tenant_id, timezone)
      VALUES (1, 1, 'Europe/Lisbon')
    `).run();
    db.exec(`
      CREATE TRIGGER reject_secretary_notification_timezone
      BEFORE UPDATE OF timezone ON notification_profiles
      WHEN NEW.user_id = 1 AND NEW.tenant_id = 1
      BEGIN
        SELECT RAISE(ABORT, 'injected notification timezone failure');
      END;
    `);

    const input = validInput();
    expect(() => putSecretaryRoutineProfile(scope, input, input.idempotencyKey, db))
      .toThrow('injected notification timezone failure');

    expect(db.prepare('SELECT timezone FROM users WHERE id = 1').get())
      .toEqual({ timezone: 'Europe/Lisbon' });
    expect(db.prepare('SELECT timezone FROM notification_profiles WHERE user_id = 1 AND tenant_id = 1').get())
      .toEqual({ timezone: 'Europe/Lisbon' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_routine_profiles').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_routine_idempotency_receipts').get())
      .toEqual({ count: 0 });
  });

  it('canonicalizes a valid IANA alias before persisting authoritative timezone state', () => {
    const input = validInput({ timezone: 'Etc/UTC' });

    const result = putSecretaryRoutineProfile(scope, input, input.idempotencyKey, db);

    expect(result.profile.timezone).toBe('UTC');
    expect(db.prepare('SELECT timezone FROM users WHERE id = 1').get())
      .toEqual({ timezone: 'UTC' });
  });

  it('replays an exact key and request without advancing the profile', () => {
    const input = validInput();
    const first = putSecretaryRoutineProfile(scope, input, input.idempotencyKey, db);
    const firstUpdatedAt = first.profile.updatedAt;
    const beforeChanges = (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count;

    const replay = putSecretaryRoutineProfile(scope, input, input.idempotencyKey, db);

    expect(replay).toEqual({ profile: first.profile, replayed: true, changed: true });
    expect(replay.profile.updatedAt).toBe(firstUpdatedAt);
    expect(replay.profile.version).toBe(1);
    const afterChanges = (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
    expect(afterChanges).toBe(beforeChanges);
  });

  it('rejects reuse of a live idempotency key for another canonical request', () => {
    const input = validInput();
    putSecretaryRoutineProfile(scope, input, input.idempotencyKey, db);

    const error = captureRoutineError(() => putSecretaryRoutineProfile(
      scope,
      { ...input, timezone: 'Europe/Lisbon' },
      input.idempotencyKey,
      db,
    ));

    expect(error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(error.status).toBe(409);
  });

  it('expires a receipt after 30 days and permits the key to identify a later request', () => {
    const first = validInput();
    putSecretaryRoutineProfile(scope, first, first.idempotencyKey, db);
    db.prepare(`
      UPDATE secretary_routine_idempotency_receipts
         SET expires_at = '2000-01-01T00:00:00.000Z'
       WHERE user_id = 1 AND tenant_id = 1 AND idempotency_key = ?
    `).run(first.idempotencyKey);

    const later = validInput({
      expectedVersion: 1,
      timezone: 'Europe/Lisbon',
    });
    const result = putSecretaryRoutineProfile(scope, later, later.idempotencyKey, db);

    expect(result).toMatchObject({ replayed: false, changed: true });
    expect(result.profile).toMatchObject({ version: 2, timezone: 'Europe/Lisbon' });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
        FROM secretary_routine_idempotency_receipts
       WHERE user_id = 1 AND tenant_id = 1 AND idempotency_key = ?
    `).get(first.idempotencyKey)).toEqual({ count: 1 });
  });

  it('globally prunes expired receipts for inactive users in bounded batches', () => {
    seedUser(2, 'Asia/Tokyo');
    putSecretaryRoutineProfile(scope, validInput(), 'routine-save-0001', db);
    const userTwoScope = { userId: 2, tenantId: 2 };
    const userTwoInput = validInput({ idempotencyKey: 'routine-save-user2' });
    putSecretaryRoutineProfile(userTwoScope, userTwoInput, userTwoInput.idempotencyKey, db);
    const freshInput = validInput({
      expectedVersion: 1,
      idempotencyKey: 'routine-save-user2-fresh',
    });
    putSecretaryRoutineProfile(userTwoScope, freshInput, freshInput.idempotencyKey, db);
    db.prepare(`
      UPDATE secretary_routine_idempotency_receipts
         SET expires_at = CASE
           WHEN idempotency_key = 'routine-save-user2-fresh'
             THEN '2099-01-01T00:00:00.000Z'
           ELSE '2000-01-01T00:00:00.000Z'
         END
    `).run();

    expect(pruneExpiredSecretaryRoutineIdempotencyReceipts(db, {
      now: new Date('2026-08-30T12:00:00.000Z'),
      limit: 1,
    })).toEqual({ deleted: 1, remaining: 1 });
    expect(pruneExpiredSecretaryRoutineIdempotencyReceipts(db, {
      now: new Date('2026-08-30T12:00:00.000Z'),
      limit: 1,
    })).toEqual({ deleted: 1, remaining: 0 });
    expect(db.prepare('SELECT idempotency_key FROM secretary_routine_idempotency_receipts').all())
      .toEqual([{ idempotency_key: 'routine-save-user2-fresh' }]);
  });

  it('returns the authoritative current profile on a CAS conflict', () => {
    const first = validInput();
    putSecretaryRoutineProfile(scope, first, first.idempotencyKey, db);

    const conflicting = validInput({ idempotencyKey: 'routine-save-0002', expectedVersion: 0 });
    const error = captureRoutineError(() => putSecretaryRoutineProfile(
      scope,
      conflicting,
      conflicting.idempotencyKey,
      db,
    ));

    expect(error.code).toBe('SECRETARY_ROUTINE_VERSION_CONFLICT');
    expect(error.status).toBe(409);
    expect(error.details?.current).toMatchObject({ version: 1, status: 'configured' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_routine_idempotency_receipts').get())
      .toEqual({ count: 1 });
  });

  it('preserves version and updatedAt for a semantic no-op with a new key', () => {
    const firstInput = validInput();
    const first = putSecretaryRoutineProfile(scope, firstInput, firstInput.idempotencyKey, db);
    const noOpInput = validInput({
      expectedVersion: 1,
      idempotencyKey: 'routine-save-0003',
      workingWindows: [...firstInput.workingWindows].reverse(),
    });

    const noOp = putSecretaryRoutineProfile(scope, noOpInput, noOpInput.idempotencyKey, db);

    expect(noOp.changed).toBe(false);
    expect(noOp.replayed).toBe(false);
    expect(noOp.profile.version).toBe(1);
    expect(noOp.profile.updatedAt).toBe(first.profile.updatedAt);
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_routine_idempotency_receipts').get())
      .toEqual({ count: 2 });

    const replay = putSecretaryRoutineProfile(scope, noOpInput, noOpInput.idempotencyKey, db);
    expect(replay).toEqual({ profile: noOp.profile, replayed: true, changed: false });
  });

  it('bumps a configured profile when the compatible timezone endpoint changes canonical time', () => {
    const input = validInput();
    putSecretaryRoutineProfile(scope, input, input.idempotencyKey, db);
    db.prepare(`
      INSERT INTO notification_profiles (user_id, tenant_id, timezone)
      VALUES (1, 1, 'America/Sao_Paulo')
    `).run();

    const changed = synchronizeCanonicalUserTimezone(scope, 'Asia/Tokyo', db);
    const profile = getSecretaryRoutineProfile(scope, db);

    expect(changed).toEqual({ timezone: 'Asia/Tokyo', routineVersion: 2, changed: true });
    expect(profile).toMatchObject({ timezone: 'Asia/Tokyo', version: 2 });
    expect(db.prepare('SELECT timezone FROM notification_profiles WHERE user_id = 1 AND tenant_id = 1').get())
      .toEqual({ timezone: 'Asia/Tokyo' });
  });

  it('fails profile semantics for overlap, uncontained focus, duplicate UUID, invalid zone, and oversized input', () => {
    const overlap = validInput({
      workingWindows: [
        validInput().workingWindows[0]!,
        {
          id: '44444444-4444-4444-8444-444444444444',
          weekdays: [1],
          start: '17:00',
          end: '20:00',
        },
      ],
    });
    expect(captureRoutineError(() => putSecretaryRoutineProfile(scope, overlap, overlap.idempotencyKey, db)).code)
      .toBe('ROUTINE_PROFILE_INVALID');

    const uncontained = validInput({
      preferredFocusWindows: [{
        id: '55555555-5555-4555-8555-555555555555',
        weekdays: [6],
        start: '10:00',
        end: '12:00',
      }],
    });
    expect(captureRoutineError(() => putSecretaryRoutineProfile(scope, uncontained, uncontained.idempotencyKey, db)).code)
      .toBe('ROUTINE_PROFILE_INVALID');

    const duplicate = validInput({
      preferredFocusWindows: [{
        ...validInput().workingWindows[0]!,
        start: '10:00',
        end: '11:00',
      }],
    });
    expect(captureRoutineError(() => putSecretaryRoutineProfile(scope, duplicate, duplicate.idempotencyKey, db)).code)
      .toBe('ROUTINE_PROFILE_INVALID');

    const invalidZone = validInput({ timezone: 'Mars/Olympus_Mons' });
    expect(captureRoutineError(() => putSecretaryRoutineProfile(scope, invalidZone, invalidZone.idempotencyKey, db)).status)
      .toBe(422);

    const oversized = { ...validInput(), padding: 'x'.repeat(33 * 1024) };
    expect(captureRoutineError(() => putSecretaryRoutineProfile(scope, oversized, oversized.idempotencyKey, db)).code)
      .toBe('INVALID_INPUT');
  });

  it('enforces collection, weekday, wall-clock, and protected-label limits before writing', () => {
    const window = (index: number) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      weekdays: [1],
      start: '09:00',
      end: '10:00',
    });
    const cases: PutSecretaryRoutineProfileInput[] = [
      validInput({ workingWindows: Array.from({ length: 15 }, (_, index) => window(index + 10)) }),
      validInput({ preferredFocusWindows: Array.from({ length: 15 }, (_, index) => window(index + 30)) }),
      validInput({
        protectedRoutines: Array.from({ length: 29 }, (_, index) => ({
          ...window(index + 50),
          label: `Protected ${index}`,
          kind: 'personal' as const,
        })),
      }),
      validInput({
        workingWindows: [{ ...window(90), weekdays: [1, 2, 3, 4, 5, 6, 7, 1] }],
      }),
      validInput({
        workingWindows: [{ ...window(91), start: '10:00', end: '10:00' }],
      }),
      validInput({
        protectedRoutines: [{
          ...window(92),
          label: 'x'.repeat(81),
          kind: 'personal',
        }],
      }),
    ];

    for (const input of cases) {
      const error = captureRoutineError(() => putSecretaryRoutineProfile(
        scope,
        input,
        input.idempotencyKey,
        db,
      ));
      expect(error).toMatchObject({ code: 'ROUTINE_PROFILE_INVALID', status: 422 });
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_routine_profiles').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_routine_idempotency_receipts').get())
      .toEqual({ count: 0 });
  });

  it('keeps profiles isolated between canonical user scopes', () => {
    seedUser(2, 'Asia/Tokyo');
    putSecretaryRoutineProfile(scope, validInput(), 'routine-save-0001', db);

    expect(getSecretaryRoutineProfile({ userId: 2, tenantId: 2 }, db)).toEqual({
      status: 'unconfigured',
      version: 0,
      timezone: 'Asia/Tokyo',
      workingWindows: [],
      preferredFocusWindows: [],
      protectedRoutines: [],
      updatedAt: null,
    });
  });
});
