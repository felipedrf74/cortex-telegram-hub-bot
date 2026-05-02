/**
 * Integration Status — provider-combination truth tests.
 *
 * Covers Gap 6's core product requirement: the backend must correctly
 * represent integration state for every supported provider combination,
 * including "exactly one provider connected" and the Garmin lifecycle
 * states that the legacy `/api/v1/connections` endpoint silently hid.
 *
 * Test matrix:
 *   1. No provider connected
 *   2. Gmail only (google with gmail scope)
 *   3. Outlook only (outlook with mail + calendar + tasks scope)
 *   4. Garmin only (health-only user)
 *   5. Gmail + Garmin
 *   6. Outlook + Garmin
 *   7. Garmin needs_reauth → revoked
 *   8. Garmin mfa_pending → pending
 *   9. Garmin expired → revoked
 *  10. Probe-history degradation → degraded overlay on connected
 *  11. Capabilities flags (mail/calendar/tasks/health) across combinations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [111111] },
    // OAuth-app credentials present for google + outlook so the test asserts
    // the provider is connectable (not `not_configured`).
    google: { clientId: 'gid', clientSecret: 'gsec', refreshToken: '' },
    outlook: { clientId: 'oid', clientSecret: 'osec', tenantId: 'common', refreshToken: '' },
    financeEncryption: { masterKey: '' },
    app: { timezone: 'Europe/Lisbon' },
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    filename TEXT UNIQUE,
    applied_at TEXT DEFAULT (datetime('now'))
  )`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        /* skip dependent migrations that need tables we don't rely on */
      }
    }
  }
}

import {
  storeTokens,
  _resetDecryptCacheForTests,
} from '../../src/services/oauth-store';
import {
  getIntegrationSummary,
  getProviderStatus,
  isGarminActivelyIntegrated,
  hasUsableMailProvider,
  hasUsableCalendarProvider,
  hasUsableHealthProvider,
} from '../../src/services/integration-status';

function seedGoogle(userId: number, scopes: string[] = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.readonly',
]): void {
  storeTokens(userId, 'google', {
    accessToken: 'at_google',
    refreshToken: 'rt_google',
    tokenType: 'Bearer',
    expiresAt: '2026-12-31T00:00:00Z',
    scopes,
  });
}

function seedOutlook(userId: number, scopes: string[] = [
  'Calendars.ReadWrite',
  'Mail.ReadWrite',
  'Tasks.ReadWrite',
]): void {
  storeTokens(userId, 'outlook', {
    accessToken: 'at_outlook',
    refreshToken: 'rt_outlook',
    tokenType: 'Bearer',
    expiresAt: '2026-12-31T00:00:00Z',
    scopes,
  });
}

function seedGarmin(
  userId: number,
  status: 'active' | 'mfa_pending' | 'needs_reauth' | 'expired',
): void {
  // Replicates the schema in migration 054 — one row per user, status column
  // drives the canonical state mapping.
  testDb
    .prepare(
      `INSERT INTO garmin_user_tokens (user_id, garmin_email, tokens_json, status)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         status = excluded.status,
         tokens_json = excluded.tokens_json,
         updated_at = datetime('now')`,
    )
    .run(userId, 'felipe@example.com', '{}', status);

  if (status === 'active') {
    testDb
      .prepare(
        `INSERT INTO garmin_sessions (user_id, oauth1_token_json, oauth2_token_json, last_refreshed_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           oauth1_token_json = excluded.oauth1_token_json,
           oauth2_token_json = excluded.oauth2_token_json,
           last_refreshed_at = excluded.last_refreshed_at,
           updated_at = datetime('now')`,
      )
      .run(userId, '{"token":"oauth1"}', '{"token":"oauth2"}');
  }
}

function seedAppleHealth(userId: number, date = new Date().toISOString().slice(0, 10)): void {
  testDb
    .prepare(
      `INSERT INTO apple_health_data (user_id, data_type, date, data_json, source_name)
       VALUES (?, 'daily_summary', ?, ?, 'ios_app')`,
    )
    .run(userId, date, JSON.stringify({ steps: 4200, totalSleepMinutes: 430 }));
}

function seedProbeFailures(provider: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    testDb
      .prepare(
        `INSERT INTO integration_health (provider, status, error_message)
         VALUES (?, 'fail', ?)`,
      )
      .run(provider, `probe failure ${i}`);
  }
}

describe('integration-status', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    process.env.OAUTH_ENCRYPTION_KEY = 'test-key-deterministic-for-vitest-32chars';
    delete process.env.FINANCE_ENCRYPTION_KEY;
    // Clear env for the adapter providers so `not_configured` / `coming_soon`
    // routing is deterministic across tests.
    process.env.STRAVA_CLIENT_ID = '';
    process.env.STRAVA_CLIENT_SECRET = '';
    process.env.WHOOP_CLIENT_ID = '';
    process.env.WHOOP_CLIENT_SECRET = '';
    process.env.FITBIT_CLIENT_ID = '';
    process.env.FITBIT_CLIENT_SECRET = '';
    process.env.TODOIST_CLIENT_ID = '';
    process.env.TODOIST_CLIENT_SECRET = '';
    process.env.NOTION_CLIENT_ID = '';
    process.env.NOTION_CLIENT_SECRET = '';
    _resetDecryptCacheForTests();
  });

  afterEach(() => {
    testDb?.close();
  });

  // ── No provider ──────────────────────────────────────────────────

  describe('no provider connected', () => {
    it('returns disconnected state for every OAuth-configured provider', () => {
      const summary = getIntegrationSummary(777);
      const byProvider = Object.fromEntries(summary.providers.map((p) => [p.provider, p]));

      expect(byProvider.google.state).toBe('disconnected');
      expect(byProvider.outlook.state).toBe('disconnected');
      expect(byProvider.apple_health.state).toBe('disconnected');
      expect(byProvider.garmin.state).toBe('disconnected');
      // whoop is coming_soon regardless of env
      expect(byProvider.whoop.state).toBe('coming_soon');
      // strava/fitbit/todoist/notion have no client id — not_configured
      expect(byProvider.strava.state).toBe('not_configured');
      expect(byProvider.fitbit.state).toBe('not_configured');
      expect(byProvider.todoist.state).toBe('not_configured');
      expect(byProvider.notion.state).toBe('not_configured');
    });

    it('reports zero capabilities', () => {
      const summary = getIntegrationSummary(777);
      expect(summary.capabilities).toEqual({
        mail: false,
        calendar: false,
        externalTasks: false,
        health: false,
      });
      expect(summary.counts.connected).toBe(0);
      expect(summary.counts.disconnected).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Single-provider cases (the core Gap 6 requirement) ───────────

  describe('Gmail only', () => {
    it('reports google:connected with gmail + calendar capabilities', () => {
      seedGoogle(42);
      const summary = getIntegrationSummary(42);
      const google = summary.providers.find((p) => p.provider === 'google')!;

      expect(google.state).toBe('connected');
      expect(google.capabilities).toEqual(expect.arrayContaining(['calendar', 'gmail']));
      expect(google.scopes).toHaveLength(2);
    });

    it('does NOT imply Outlook is connected', () => {
      seedGoogle(42);
      const summary = getIntegrationSummary(42);
      const outlook = summary.providers.find((p) => p.provider === 'outlook')!;

      expect(outlook.state).toBe('disconnected');
      expect(outlook.connectedAt).toBeNull();
    });

    it('exposes hasMail + hasCalendar but not hasHealth', () => {
      seedGoogle(42);
      const summary = getIntegrationSummary(42);
      expect(summary.capabilities.mail).toBe(true);
      expect(summary.capabilities.calendar).toBe(true);
      expect(summary.capabilities.health).toBe(false);
      expect(summary.capabilities.externalTasks).toBe(false);
    });
  });

  describe('Outlook only', () => {
    it('reports outlook:connected with full capabilities', () => {
      seedOutlook(43);
      const summary = getIntegrationSummary(43);
      const outlook = summary.providers.find((p) => p.provider === 'outlook')!;

      expect(outlook.state).toBe('connected');
      expect(outlook.capabilities).toEqual(['calendar', 'email', 'tasks']);
    });

    it('does NOT imply Gmail is connected', () => {
      seedOutlook(43);
      const summary = getIntegrationSummary(43);
      const google = summary.providers.find((p) => p.provider === 'google')!;

      expect(google.state).toBe('disconnected');
    });

    it('exposes hasMail + hasCalendar + externalTasks but not hasHealth', () => {
      seedOutlook(43);
      const summary = getIntegrationSummary(43);
      expect(summary.capabilities.mail).toBe(true);
      expect(summary.capabilities.calendar).toBe(true);
      expect(summary.capabilities.externalTasks).toBe(true);
      expect(summary.capabilities.health).toBe(false);
    });
  });

  describe('Garmin only (health-only user)', () => {
    it('reports garmin:connected when status=active', () => {
      seedGarmin(44, 'active');
      const summary = getIntegrationSummary(44);
      const garmin = summary.providers.find((p) => p.provider === 'garmin')!;

      expect(garmin.state).toBe('connected');
      expect(garmin.capabilities).toEqual(['training', 'sleep', 'readiness']);
    });

    it('does not report Garmin connected from an active metadata row without scoped tokens', () => {
      testDb
        .prepare(
          `INSERT INTO garmin_user_tokens (user_id, garmin_email, tokens_json, status)
           VALUES (?, ?, '{}', 'active')`,
        )
        .run(1444, 'wrong-user@garmin.example');

      const summary = getIntegrationSummary(1444);
      const garmin = summary.providers.find((p) => p.provider === 'garmin')!;

      expect(garmin.state).toBe('disconnected');
      expect(summary.capabilities.health).toBe(false);
      expect(isGarminActivelyIntegrated(1444)).toBe(false);
    });

    it('does NOT imply any email provider is connected', () => {
      seedGarmin(44, 'active');
      const summary = getIntegrationSummary(44);
      const google = summary.providers.find((p) => p.provider === 'google')!;
      const outlook = summary.providers.find((p) => p.provider === 'outlook')!;

      expect(google.state).toBe('disconnected');
      expect(outlook.state).toBe('disconnected');
    });

    it('exposes hasHealth but not mail/calendar', () => {
      seedGarmin(44, 'active');
      const summary = getIntegrationSummary(44);
      expect(summary.capabilities.health).toBe(true);
      expect(summary.capabilities.mail).toBe(false);
      expect(summary.capabilities.calendar).toBe(false);
    });
  });

  describe('Apple Health only (device-local health user)', () => {
    it('reports apple_health:connected when iOS has synced recent HealthKit data', () => {
      seedAppleHealth(144);
      const summary = getIntegrationSummary(144);
      const appleHealth = summary.providers.find((p) => p.provider === 'apple_health')!;

      expect(appleHealth.state).toBe('connected');
      expect(appleHealth.capabilities).toEqual(['health', 'sleep', 'readiness', 'training']);
      expect(appleHealth.scopes).toEqual(['HealthKit read']);
    });

    it('exposes hasHealth without implying mail or calendar', () => {
      seedAppleHealth(144);
      const summary = getIntegrationSummary(144);

      expect(summary.capabilities.health).toBe(true);
      expect(summary.capabilities.mail).toBe(false);
      expect(summary.capabilities.calendar).toBe(false);
      expect(hasUsableHealthProvider(144)).toBe(true);
    });
  });

  // ── Two-provider combinations ─────────────────────────────────────

  describe('Gmail + Garmin', () => {
    it('reports both as connected without implying Outlook', () => {
      seedGoogle(45);
      seedGarmin(45, 'active');
      const summary = getIntegrationSummary(45);
      const byProvider = Object.fromEntries(summary.providers.map((p) => [p.provider, p]));

      expect(byProvider.google.state).toBe('connected');
      expect(byProvider.garmin.state).toBe('connected');
      expect(byProvider.outlook.state).toBe('disconnected');
      expect(summary.capabilities).toEqual({
        mail: true,
        calendar: true,
        externalTasks: false,
        health: true,
      });
      expect(summary.counts.connected).toBe(2);
    });
  });

  describe('Outlook + Garmin', () => {
    it('reports both as connected without implying Gmail', () => {
      seedOutlook(46);
      seedGarmin(46, 'active');
      const summary = getIntegrationSummary(46);
      const byProvider = Object.fromEntries(summary.providers.map((p) => [p.provider, p]));

      expect(byProvider.outlook.state).toBe('connected');
      expect(byProvider.garmin.state).toBe('connected');
      expect(byProvider.google.state).toBe('disconnected');
      expect(summary.capabilities).toEqual({
        mail: true,
        calendar: true,
        externalTasks: true,
        health: true,
      });
    });
  });

  // ── Garmin lifecycle states (the hidden-state bug) ────────────────

  describe('Garmin revoked lifecycle', () => {
    it('maps status=needs_reauth to state=revoked with NEEDS_REAUTH reason', () => {
      seedGarmin(47, 'needs_reauth');
      const status = getProviderStatus(47, 'garmin');

      expect(status.state).toBe('revoked');
      expect(status.reasonCode).toBe('NEEDS_REAUTH');
      expect(status.detail).toMatch(/reconnect/i);
    });

    it('maps status=expired to state=revoked with EXPIRED reason', () => {
      seedGarmin(48, 'expired');
      const status = getProviderStatus(48, 'garmin');

      expect(status.state).toBe('revoked');
      expect(status.reasonCode).toBe('EXPIRED');
    });

    it('maps status=mfa_pending to state=pending with MFA_PENDING reason', () => {
      seedGarmin(49, 'mfa_pending');
      const status = getProviderStatus(49, 'garmin');

      expect(status.state).toBe('pending');
      expect(status.reasonCode).toBe('MFA_PENDING');
    });

    it('revoked Garmin does not count as usable health (capability false)', () => {
      seedGarmin(50, 'needs_reauth');
      const summary = getIntegrationSummary(50);
      expect(summary.capabilities.health).toBe(false);
      expect(summary.counts.revoked).toBe(1);
      expect(summary.counts.connected).toBe(0);
    });

    it('pending Garmin does not yet count as usable health', () => {
      seedGarmin(51, 'mfa_pending');
      const summary = getIntegrationSummary(51);
      expect(summary.capabilities.health).toBe(false);
      expect(summary.counts.pending).toBe(1);
    });
  });

  // ── Probe-derived degradation ─────────────────────────────────────

  describe('probe-derived degradation', () => {
    it('marks a connected provider as degraded after three consecutive probe failures', () => {
      seedGoogle(60);
      seedProbeFailures('google', 3);
      const status = getProviderStatus(60, 'google');

      expect(status.state).toBe('degraded');
      expect(status.reasonCode).toBe('PROBE_FAILING');
      expect(status.detail).toBeTruthy();
    });

    it('stays connected if the probe streak is below threshold', () => {
      seedGoogle(61);
      seedProbeFailures('google', 2);
      const status = getProviderStatus(61, 'google');

      expect(status.state).toBe('connected');
    });

    it('degraded still counts as mail-capable (last-known data is better than nothing)', () => {
      seedGoogle(62);
      seedProbeFailures('google', 3);
      const summary = getIntegrationSummary(62);

      expect(summary.capabilities.mail).toBe(true);
      expect(summary.counts.degraded).toBe(1);
    });

    it('probe failures do not leak across providers', () => {
      seedGoogle(63);
      seedOutlook(63);
      seedProbeFailures('google', 3);

      const summary = getIntegrationSummary(63);
      const byProvider = Object.fromEntries(summary.providers.map((p) => [p.provider, p]));
      expect(byProvider.google.state).toBe('degraded');
      expect(byProvider.outlook.state).toBe('connected');
    });

    it('clears degraded badge after the user reauths a previously failing provider', () => {
      // Probe failures from BEFORE the reauth — the dead refresh token's
      // signature. These must NOT keep the provider stuck at `degraded`
      // once the user has supplied fresh tokens via OAuth, otherwise the
      // in-app Reconnect button looks broken (Felipe reported this on
      // 2026-04-26: "still getting invalid grant after retry").
      // Probe timestamps mirror the production format
      // (`datetime('now')` → 'YYYY-MM-DD HH:MM:SS', no T/Z) so the
      // string comparison in `loadRecentProbes` matches real-world
      // ordering. A pinned date in the past guarantees the seed predates
      // SQLite's CURRENT_TIMESTAMP for `storeTokens`.
      const insertProbe = testDb.prepare(
        `INSERT INTO integration_health (provider, status, ts, error_message)
         VALUES (?, 'fail', ?, ?)`,
      );
      insertProbe.run('google', '2025-01-01 22:00:00', 'invalid_grant');
      insertProbe.run('google', '2025-01-01 22:30:00', 'invalid_grant');
      insertProbe.run('google', '2025-01-01 23:00:00', 'invalid_grant');

      // User completes OAuth → storeTokens sets updated_at to NOW (>> 2025).
      seedGoogle(64);

      const status = getProviderStatus(64, 'google');
      expect(status.state).toBe('connected');
      expect(status.reasonCode).toBeUndefined();
    });

    it('still degrades when fresh probe failures arrive AFTER a reauth', () => {
      // Reauth happens first (storeTokens → updated_at = NOW), then 3 new
      // probe failures stack up. Those failures are NOT pre-reauth signal —
      // they are real evidence the new tokens are also broken.
      seedGoogle(65);
      seedProbeFailures('google', 3);

      const status = getProviderStatus(65, 'google');
      expect(status.state).toBe('degraded');
      expect(status.reasonCode).toBe('PROBE_FAILING');
    });
  });

  // ── Convenience helpers ──────────────────────────────────────────

  describe('convenience helpers', () => {
    it('isGarminActivelyIntegrated returns false when never connected', () => {
      expect(isGarminActivelyIntegrated(999)).toBe(false);
    });

    it('isGarminActivelyIntegrated returns false when revoked', () => {
      seedGarmin(70, 'needs_reauth');
      expect(isGarminActivelyIntegrated(70)).toBe(false);
    });

    it('isGarminActivelyIntegrated returns true when active', () => {
      seedGarmin(71, 'active');
      expect(isGarminActivelyIntegrated(71)).toBe(true);
    });

    it('isGarminActivelyIntegrated returns true when degraded (last-known data)', () => {
      seedGarmin(72, 'active');
      seedProbeFailures('garmin', 3);
      expect(isGarminActivelyIntegrated(72)).toBe(true);
    });

    it('hasUsableMailProvider / hasUsableCalendarProvider / hasUsableHealthProvider agree with summary', () => {
      seedGoogle(80);
      seedGarmin(80, 'active');
      expect(hasUsableMailProvider(80)).toBe(true);
      expect(hasUsableCalendarProvider(80)).toBe(true);
      expect(hasUsableHealthProvider(80)).toBe(true);
    });
  });

  // ── Scope-aware capability surfacing ──────────────────────────────

  describe('scope-aware capabilities', () => {
    it('Google with only calendar scope does not expose gmail capability', () => {
      seedGoogle(90, ['https://www.googleapis.com/auth/calendar']);
      const status = getProviderStatus(90, 'google');
      expect(status.capabilities).toEqual(['calendar']);

      const summary = getIntegrationSummary(90);
      expect(summary.capabilities.calendar).toBe(true);
      expect(summary.capabilities.mail).toBe(false);
    });

    it('Google with only gmail scope does not expose calendar capability', () => {
      seedGoogle(91, ['https://www.googleapis.com/auth/gmail.readonly']);
      const status = getProviderStatus(91, 'google');
      expect(status.capabilities).toEqual(['gmail']);

      const summary = getIntegrationSummary(91);
      expect(summary.capabilities.calendar).toBe(false);
      expect(summary.capabilities.mail).toBe(true);
    });

    it('Outlook without tasks scope does not expose externalTasks', () => {
      seedOutlook(92, ['Calendars.ReadWrite', 'Mail.ReadWrite']);
      const summary = getIntegrationSummary(92);
      expect(summary.capabilities.externalTasks).toBe(false);
      expect(summary.capabilities.mail).toBe(true);
    });
  });

  // ── Summary shape invariants ─────────────────────────────────────

  describe('summary shape invariants', () => {
    it('returns exactly one entry per connectable provider', () => {
      seedGoogle(100);
      seedGarmin(100, 'active');
      const summary = getIntegrationSummary(100);
      const providers = summary.providers.map((p) => p.provider).sort();
      expect(providers).toEqual(
        ['google', 'outlook', 'garmin', 'apple_health', 'strava', 'whoop', 'fitbit', 'todoist', 'notion'].sort(),
      );
    });

    it('counts reflect state distribution', () => {
      seedGoogle(101);
      seedOutlook(101);
      seedGarmin(101, 'needs_reauth');
      const summary = getIntegrationSummary(101);
      expect(summary.counts.connected).toBe(2);
      expect(summary.counts.revoked).toBe(1);
    });
  });
});
