import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import {
  STAGING_FIXTURE_USER_ID_MAX,
  STAGING_FIXTURE_USER_ID_MIN,
  hasStagingFixtureClaim,
  isProductionRuntime,
  isStagingFixtureUserId,
  validateStagingFixtureJwtPayload,
} from '../../src/services/staging-fixture-safety';

describe('staging fixture harness safety boundaries', () => {
  it('refuses production and non-staging hostnames before network work', async () => {
    const { validateStagingTarget, resolveTargetUrl } = await import('../../scripts/staging-fixture-harness.mjs');

    expect(validateStagingTarget('https://api.nexushub.me')).toEqual({
      ok: false,
      reason: 'Refusing production API hostname api.nexushub.me',
    });
    expect(validateStagingTarget('https://example.com')).toEqual({
      ok: false,
      reason: 'Refusing non-staging hostname example.com',
    });
    expect(validateStagingTarget('https://staging-api.nexushub.me').ok).toBe(true);
    expect(validateStagingTarget('http://localhost:8201').ok).toBe(true);
    expect(validateStagingTarget('http://127.0.0.1:8201').ok).toBe(true);
    expect(validateStagingTarget('http://localhost:8200')).toEqual({
      ok: false,
      reason: 'Refusing localhost non-staging port 8200',
    });
    expect(resolveTargetUrl({}, { PRODUCTION_URL: 'https://api.nexushub.me' })).toBe('https://api.nexushub.me');
  });

  it('normalizes the Felipe-volume calendar fixture knobs without network work', async () => {
    const { parseArgs, resolveFixtureCalendarEventCount } = await import('../../scripts/staging-fixture-harness.mjs');
    const {
      DEFAULT_FELIPE_VOLUME_CALENDAR_EVENT_COUNT,
      MAX_FIXTURE_CALENDAR_EVENT_COUNT,
      normalizeFixtureCalendarEventCount,
    } = await import('../../scripts/staging-fixture-seed.mjs');

    expect(resolveFixtureCalendarEventCount(parseArgs(['--felipe-volume-calendar']))).toBe(DEFAULT_FELIPE_VOLUME_CALENDAR_EVENT_COUNT);
    expect(resolveFixtureCalendarEventCount(parseArgs(['--calendar-events', '100']))).toBe(100);
    expect(resolveFixtureCalendarEventCount(parseArgs([]))).toBe(0);
    expect(normalizeFixtureCalendarEventCount(true)).toBe(DEFAULT_FELIPE_VOLUME_CALENDAR_EVENT_COUNT);
    expect(() => normalizeFixtureCalendarEventCount(MAX_FIXTURE_CALENDAR_EVENT_COUNT + 1)).toThrow(/Fixture calendar event count/);
  });

  it('builds a remote seed script that creates the fixture calendar table and requested volume', async () => {
    const { buildRemoteSeedScript } = await import('../../scripts/staging-fixture-seed.mjs');

    const script = buildRemoteSeedScript({
      userId: STAGING_FIXTURE_USER_ID_MIN,
      deviceId: 'staging-fixture-device-test',
      calendarEventCount: 100,
    });

    expect(script).toContain('const calendarEventCount = 100;');
    expect(script).toContain('CREATE TABLE IF NOT EXISTS staging_fixture_calendar_events');
    expect(script).toContain('seedFixtureCalendarEvents(userId, calendarEventCount);');
    expect(script).toContain('staging-fixture-cal-');
    expect(script).not.toContain('\\`');
    expect(() => new vm.Script(script)).not.toThrow();
  });

  it('recognizes only the reserved synthetic user-id range', () => {
    expect(isStagingFixtureUserId(STAGING_FIXTURE_USER_ID_MIN)).toBe(true);
    expect(isStagingFixtureUserId(STAGING_FIXTURE_USER_ID_MAX)).toBe(true);
    expect(isStagingFixtureUserId(STAGING_FIXTURE_USER_ID_MIN - 1)).toBe(false);
    expect(isStagingFixtureUserId(STAGING_FIXTURE_USER_ID_MAX + 1)).toBe(false);
    expect(isStagingFixtureUserId('1000000')).toBe(false);
  });

  it('detects production runtime without treating staging as production', () => {
    expect(isProductionRuntime({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionRuntime({ NODE_ENV: 'production', STAGING: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isProductionRuntime({ NODE_ENV: 'staging', STAGING: 'true' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('requires the staging_fixture claim and reserved user id to travel together', () => {
    expect(hasStagingFixtureClaim({ userId: STAGING_FIXTURE_USER_ID_MIN, staging_fixture: true })).toBe(true);

    expect(validateStagingFixtureJwtPayload({
      userId: STAGING_FIXTURE_USER_ID_MIN,
      staging_fixture: true,
    }, { NODE_ENV: 'staging', STAGING: 'true' } as NodeJS.ProcessEnv)).toEqual({ ok: true });

    expect(validateStagingFixtureJwtPayload({
      userId: STAGING_FIXTURE_USER_ID_MIN,
    }, { NODE_ENV: 'staging', STAGING: 'true' } as NodeJS.ProcessEnv)).toEqual({
      ok: false,
      reason: 'reserved_user_without_claim',
    });

    expect(validateStagingFixtureJwtPayload({
      userId: 25,
      staging_fixture: true,
    }, { NODE_ENV: 'staging', STAGING: 'true' } as NodeJS.ProcessEnv)).toEqual({
      ok: false,
      reason: 'claim_without_reserved_user',
    });
  });

  it('rejects staging fixture claims and reserved user IDs in production', () => {
    expect(validateStagingFixtureJwtPayload({
      userId: STAGING_FIXTURE_USER_ID_MIN,
      staging_fixture: true,
    }, { NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toEqual({
      ok: false,
      reason: 'production_claim',
    });

    expect(validateStagingFixtureJwtPayload({
      userId: STAGING_FIXTURE_USER_ID_MIN,
    }, { NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toEqual({
      ok: false,
      reason: 'production_reserved_user',
    });
  });
});
