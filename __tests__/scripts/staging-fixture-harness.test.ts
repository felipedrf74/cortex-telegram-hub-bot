import { afterAll, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STAGING_FIXTURE_USER_ID_MAX,
  STAGING_FIXTURE_USER_ID_MIN,
  hasStagingFixtureClaim,
  isProductionRuntime,
  isStagingFixtureUserId,
  validateStagingFixtureJwtPayload,
} from '../../src/services/staging-fixture-safety';

const fixtureRoots: string[] = [];

function immutableStagingFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-staging-current-'));
  fixtureRoots.push(root);
  const release = path.join(root, 'releases', 'a'.repeat(40));
  fs.mkdirSync(path.join(release, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(release, 'node_modules'));
  fs.mkdirSync(path.join(release, 'scripts'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, '.env'), 'FIXTURE_ENV_FROM_BASE=yes\nDATABASE_PATH=/unsafe/env.db\n');
  fs.writeFileSync(path.join(root, 'data', 'bot.db'), '');
  fs.symlinkSync(path.join(root, '.env'), path.join(release, '.env'));
  fs.symlinkSync(path.join(root, 'data'), path.join(release, 'data'));
  fs.symlinkSync(release, path.join(root, 'current'));
  return { root, release };
}

describe('staging fixture harness safety boundaries', () => {
  it('runs fixture Node from the exact current release with base env/data and detects selector drift', async () => {
    const { buildRemoteNodeCommand } = await import('../../scripts/staging-fixture-seed.mjs');
    const first = immutableStagingFixture();
    const command = buildRemoteNodeCommand(first.root, { nodeBin: process.execPath });
    const probe = spawnSync('/bin/sh', ['-c', command], {
      input: `process.stdout.write(JSON.stringify({
        cwd: process.cwd(),
        databasePath: process.env.DATABASE_PATH,
        dbPath: process.env.DB_PATH,
        fromBase: process.env.FIXTURE_ENV_FROM_BASE,
        nodePath: process.env.NODE_PATH,
      }));`,
      encoding: 'utf8',
    });

    expect(probe.status, probe.stderr).toBe(0);
    const canonicalRoot = fs.realpathSync(first.root);
    const canonicalRelease = fs.realpathSync(first.release);
    expect(JSON.parse(probe.stdout)).toEqual({
      cwd: canonicalRelease,
      databasePath: path.join(canonicalRoot, 'data', 'bot.db'),
      dbPath: path.join(canonicalRoot, 'data', 'bot.db'),
      fromBase: 'yes',
      nodePath: path.join(canonicalRelease, 'node_modules'),
    });

    const second = immutableStagingFixture();
    const replacement = path.join(second.root, 'releases', 'replacement');
    fs.mkdirSync(replacement);
    const drift = spawnSync('/bin/sh', [
      '-c',
      buildRemoteNodeCommand(second.root, { nodeBin: process.execPath }),
    ], {
      input: `const fs = require('node:fs');
        fs.unlinkSync(${JSON.stringify(path.join(second.root, 'current'))});
        fs.symlinkSync(${JSON.stringify(replacement)}, ${JSON.stringify(path.join(second.root, 'current'))});`,
      encoding: 'utf8',
    });

    expect(drift.status).toBe(74);
    expect(drift.stderr).toContain('staging current selector changed during fixture operation');
  });

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
    expect(script).toContain('tenant_id: userId');
    expect(script).toContain('owner_user_id: userId');
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

afterAll(() => {
  while (fixtureRoots.length > 0) {
    fs.rmSync(fixtureRoots.pop()!, { recursive: true, force: true });
  }
});
