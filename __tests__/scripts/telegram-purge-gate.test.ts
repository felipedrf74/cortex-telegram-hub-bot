import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Telegram purge — CI grep gate.
 *
 * Stage A (M9, 2026-07): Telegram inbound was removed upstream (src/bot.ts
 * and src/handlers/ no longer exist) and the dead telegram chat-path code
 * was purged from the Stage-A files below.
 *
 * Stage B–C (M21, 2026-07): config/env surfaces (src/config.ts,
 * .env.example TELEGRAM_*, package.json eval:training wrapper), the
 * notification-out Telegram channel (registry alert channels + smoke
 * builder + notification-contracts 'legacy_telegram'), the error-monitor
 * Telegram wording, and the JWT-userId telegram-id identity fallbacks
 * (dashboard-home-input / skills getCaller / onboarding) were purged.
 * Stage C added migration 259 (archive-first copy of users.telegram_id
 * into telegram_identity_archive; the live column is intentionally KEPT
 * this release because the owner bootstrap still reads it).
 *
 * Deliberate remnants (NOT gated — keep in sync with scripts/telegram-audit.sh):
 * - Owner bootstrap identity: OWNER_TELEGRAM_ID env + users.telegram_id
 *   reads in src/services/user-service.ts (seedOwnerUser and friends) and
 *   src/services/owner-bootstrap-preflight.ts. Production's owner row is
 *   keyed by telegram_id; refactoring to a non-telegram key is a separate
 *   owner-gated identity migration.
 * - skills.ts override target lookups + garmin-session-store byTelegram
 *   fallback: legacy request contracts still keyed to the telegram_id
 *   column; removal is blocked on the same identity migration.
 * Runtime delivery safety uses the transport-neutral
 * NEXUS_CONTENT_LIVE_EVAL_DELIVERY_DISABLED guard. No live TELEGRAM_* config
 * remains outside the explicitly deferred OWNER_TELEGRAM_ID bootstrap.
 *
 * ALLOWLIST: entries here are the only permitted matches inside gated
 * files. Additions require explicit justification in the commit message.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Files purged by M9 — must contain zero case-insensitive telegram refs. */
const GATED_FILES = [
  'src/utils/chat-html-formatter.ts',
  'src/adapters/message-adapter.ts',
  'src/adapters/whatsapp-adapter.ts',
  'src/adapters/ios-adapter.ts',
  'src/api/response-helpers.ts',
  'src/api/routes/chat-message-routes.ts',
  'src/api/websocket.ts',
];

/** Files purged by M21 Stage B — must contain zero case-insensitive telegram refs. */
const STAGE_B_GATED_FILES = [
  'src/config.ts',
  '.env.example',
  'src/services/error-monitor.ts',
  'src/services/notification-contracts.ts',
  'src/services/registry-cross-tenant-alert-channels.ts',
  'src/services/registry-channel-smoke-builder.ts',
  'src/services/registry-channel-routing-policy.ts',
  'src/api/routes/dashboard-home-input.ts',
  'src/services/onboarding.ts',
  'ecosystem.config.js',
  'ecosystem.staging.config.js',
];

/** Config/eval/smoke surfaces where no generic TELEGRAM_* key may survive. */
const STAGE_B_ENV_SURFACES = [
  '.env.local.example',
  'docker-compose.decision-center-ios-smoke.yml',
  'docker-compose.training-e2e.yml',
  'scripts/chat-tenant-security-smoke.js',
  'scripts/content-live-eval-local.sh',
  'scripts/debug-env.js',
  'scripts/decision-center-ios-smoke.sh',
  'scripts/full-nexus-local-engine.sh',
  'scripts/seed-training-catalog.ts',
  'scripts/training-e2e-live-calendar.ts',
];

/**
 * Allowed matches inside gated files. Each entry needs a justification:
 * - ecosystem.staging.config.js: `telegram-hub-bot*` is the historical deploy
 *   directory name. Its deployment-specific parent is injected through
 *   NEXUS_RELEASE_BASE_DIR; the directory name is not live Telegram behavior.
 */
const ALLOWLIST: { file: string; pattern: RegExp }[] = [
  { file: 'ecosystem.staging.config.js', pattern: /telegram-hub-bot/ },
  // Owner bootstrap identity remnant — see the header note and the dedicated
  // .env.example test below.
  { file: '.env.example', pattern: /OWNER_TELEGRAM_ID/ },
];

function liveTelegramMatches(file: string): string[] {
  const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const matches: string[] = [];
  source.split('\n').forEach((line, idx) => {
    if (!/telegram/i.test(line)) return;
    const allowed = ALLOWLIST.some((a) => a.file === file && a.pattern.test(line));
    if (!allowed) matches.push(`${file}:${idx + 1}: ${line.trim()}`);
  });
  return matches;
}

describe('telegram purge gate (Stage A)', () => {
  it('purged chat-path files contain no live telegram references', () => {
    const offenders = GATED_FILES.flatMap(liveTelegramMatches);
    expect(offenders, `New telegram references appeared in M9-purged files:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the legacy telegram-formatter module stays deleted', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'src/utils/telegram-formatter.ts'))).toBe(false);
  });

  it('the successor chat-html-formatter module exists and is imported by the live chat paths', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'src/utils/chat-html-formatter.ts'))).toBe(true);
    const fastpath = fs.readFileSync(path.join(REPO_ROOT, 'src/api/routes/chat-fastpath.ts'), 'utf8');
    expect(fastpath).toContain("utils/chat-html-formatter'");
  });

  it('the telegram audit script is present and executable shell', () => {
    const script = path.join(REPO_ROOT, 'scripts', 'telegram-audit.sh');
    expect(fs.existsSync(script)).toBe(true);
    expect(fs.readFileSync(script, 'utf8')).toContain('grep -ril');
  });
});

describe('telegram purge gate (Stage B — config/env + notification-out + identity fallbacks)', () => {
  it('Stage-B purged files contain no live telegram references', () => {
    const offenders = STAGE_B_GATED_FILES.flatMap(liveTelegramMatches);
    expect(offenders, `New telegram references appeared in M21 Stage-B purged files:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('.env.example carries no TELEGRAM_* variables; OWNER_TELEGRAM_ID stays documented as the bootstrap remnant', () => {
    const env = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
    expect(env).not.toMatch(/^TELEGRAM_/m);
    // The owner bootstrap (seedOwnerUser / assertOwnerBootstrapReadyForRuntime)
    // still resolves the owner identity from OWNER_TELEGRAM_ID + the persisted
    // users.telegram_id row, so the variable must remain documented until the
    // owner-gated identity migration replaces it.
    expect(env).toMatch(/^OWNER_TELEGRAM_ID/m);
  });

  it('package.json eval:training no longer wraps TELEGRAM_* env and drops the telegram keyword', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(String(pkg.scripts['eval:training'])).not.toMatch(/TELEGRAM/i);
    expect(pkg.keywords ?? []).not.toContain('telegram');
  });

  it('purges generic TELEGRAM_* config from eval, smoke, and local-runtime surfaces', () => {
    const offenders = STAGE_B_ENV_SURFACES.flatMap((file) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      return source.split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /\bTELEGRAM_[A-Z0-9_]+\b/.test(line))
        .map(({ line, index }) => `${file}:${index + 1}: ${line.trim()}`);
    });
    expect(offenders, `Generic TELEGRAM_* config remains:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('skills/dashboard-home/onboarding JWT-userId paths no longer fall back to getUserByTelegramId', () => {
    for (const file of [
      'src/api/routes/dashboard-home-input.ts',
      'src/services/onboarding.ts',
    ]) {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(source, `${file} must not reference getUserByTelegramId`).not.toContain('getUserByTelegramId');
    }
    // skills.ts getCaller (JWT userId) must be canonical-id only; the
    // owner-gated override TARGET lookups legitimately remain telegram-keyed
    // until the identity migration, so the file is not fully gated.
    const skills = fs.readFileSync(path.join(REPO_ROOT, 'src/api/routes/skills.ts'), 'utf8');
    expect(skills).not.toMatch(/getUserById\(userId\)\s*\|\|\s*getUserByTelegramId\(userId\)/);
  });
});

describe('telegram purge gate (Stage C — archive-first data migration)', () => {
  const up = path.join(REPO_ROOT, 'migrations', '259_telegram_identity_archive.sql');
  const down = path.join(REPO_ROOT, 'migrations', 'down', '259_telegram_identity_archive.sql');

  it('migration 259 exists with a reversible down migration', () => {
    expect(fs.existsSync(up)).toBe(true);
    expect(fs.existsSync(down)).toBe(true);
  });

  it('migration 259 is archive-first and SCHEMA-ONLY: never drops, nulls, or references the live column in SQL', () => {
    const sql = fs.readFileSync(up, 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS telegram_identity_archive/);
    // The backfill deliberately does NOT live in SQL: migration rehearsals
    // replay this file against historically-divergent users schemas (the 226
    // repair rehearsal rebuilds users without telegram_id), and SQLite cannot
    // reference a column conditionally. The runtime backfill owns the copy.
    expect(sql).not.toMatch(/INSERT\s+OR\s+IGNORE\s+INTO\s+telegram_identity_archive/i);
    expect(sql).toMatch(/backfillTelegramIdentityArchive/);
    // NEVER DROP in this migration; the owner bootstrap still reads the column.
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+users/i);
    expect(sql).not.toMatch(/UPDATE\s+users\s+SET\s+telegram_id/i);
    // One-release-cycle soak documented in the header before any future DROP.
    expect(sql).toMatch(/soak/i);
  });

  it('the runtime backfill is pragma-guarded, idempotent, and wired into initDatabase', () => {
    const userService = fs.readFileSync(path.join(REPO_ROOT, 'src/services/user-service.ts'), 'utf8');
    expect(userService).toMatch(/export function backfillTelegramIdentityArchive/);
    expect(userService).toMatch(/pragma_table_info\('users'\)/);
    expect(userService).toMatch(/INSERT OR IGNORE INTO telegram_identity_archive/);
    const databaseCore = fs.readFileSync(path.join(REPO_ROOT, 'src/services/database.ts'), 'utf8');
    const databaseBootstrap = fs.readFileSync(
      path.join(REPO_ROOT, 'src/services/database-bootstrap.ts'),
      'utf8',
    );
    expect(databaseCore).not.toMatch(/backfillTelegramIdentityArchive/);
    expect(databaseBootstrap).toMatch(/backfillTelegramIdentityArchive/);
  });

  it('down migration only removes the archive table', () => {
    const sql = fs.readFileSync(down, 'utf8');
    expect(sql).toMatch(/DROP TABLE IF EXISTS telegram_identity_archive/);
    expect(sql).not.toMatch(/users/i);
  });
});
