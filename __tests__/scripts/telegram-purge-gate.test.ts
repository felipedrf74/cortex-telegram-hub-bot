import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Telegram purge Stage A — CI grep gate (M9, 2026-07).
 *
 * Telegram inbound was removed upstream (src/bot.ts and src/handlers/ no
 * longer exist). Stage A purged the dead telegram chat-path code from the
 * files below. This gate pins those files at ZERO live "telegram"
 * references so new ones cannot silently reappear.
 *
 * Scope notes (deliberate, keep in sync with the M21 milestone):
 * - Config/env/DB columns (`users.telegram_id`, `config.telegram.*`) are
 *   M21 Stage B–C work and are NOT covered by this gate.
 * - Notification-OUT surfaces (error-monitor / notification-contracts /
 *   scheduler alerting) still reference Telegram and are owned by M21.
 * - `src/services/user-service.ts` keeps `getUserByTelegramId` for the
 *   persisted `telegram_id` identity column until the M21 data migration.
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

/**
 * Allowed matches inside gated files. Currently empty on purpose: every
 * gated file is fully clean. If a schema/API-contract type member must be
 * kept for M21 compat, add a `{ file, pattern }` entry here with a comment.
 */
const ALLOWLIST: { file: string; pattern: RegExp }[] = [];

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
