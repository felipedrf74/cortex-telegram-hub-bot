/**
 * User Service Tests
 *
 * Tests: registration, invite codes, owner seeding, access control, i18n.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [111111] },
    isStaging: false,
    app: { timezone: 'Europe/Lisbon' },
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip deps */ }
    }
  }
}

import {
  getOrCreateUser, getUserByTelegramId, isUserAuthorized, isOwner,
  isOwnerBootstrapTelegramId,
  getOwnerBootstrapTelegramId, isOwnerUserRef,
  assertOwnerBootstrapReadyForRuntime,
  touchUser, getUserLanguage, setUserLanguage, listUsers, setUserStatus,
  setUserTier, seedOwnerUser,
  createEmailUser,
  sanitizeDisplayName, getPreferredDisplayName,
  createInviteCode, validateAndConsumeInviteCode, peekInviteCode, listInviteCodes, deleteInviteCode,
} from '../../src/services/user-service';

import { t, detectLanguageFromTelegram } from '../../src/utils/i18n';

describe('user-service', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    vi.stubEnv('OWNER_TELEGRAM_ID', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDb?.close();
  });

  describe('getOrCreateUser', () => {
    it('creates user on first call with Phase 1 default pro tier', () => {
      const user = getOrCreateUser(123456, { username: 'alice', firstName: 'Alice' });
      expect(user.telegram_id).toBe(123456);
      expect(user.username).toBe('alice');
      expect(user.first_name).toBe('Alice');
      // Phase 1: new users default to pro so they get all skills;
      // admin manually downgrades to free via portal if needed.
      expect(user.tier).toBe('pro');
      expect(user.status).toBe('active');
      expect(user.daily_message_limit).toBe(200);
      expect(user.daily_token_limit).toBe(500000);
      expect(user.daily_cost_limit_usd).toBe(0.04);
    });

    it('returns existing on second call', () => {
      const u1 = getOrCreateUser(123456, { username: 'alice' });
      const u2 = getOrCreateUser(123456, { username: 'alice_changed' });
      expect(u1.id).toBe(u2.id);
      expect(u2.username).toBe('alice'); // Not updated
    });
  });

  describe('getUserByTelegramId', () => {
    it('returns null for unregistered user', () => {
      expect(getUserByTelegramId(999)).toBeNull();
    });

    it('returns user for registered user', () => {
      getOrCreateUser(123, {});
      const user = getUserByTelegramId(123);
      expect(user).not.toBeNull();
      expect(user!.telegram_id).toBe(123);
    });
  });

  describe('isUserAuthorized', () => {
    it('returns false for unregistered user', () => {
      expect(isUserAuthorized(999)).toBe(false);
    });

    it('returns true for active user', () => {
      getOrCreateUser(123, {});
      expect(isUserAuthorized(123)).toBe(true);
    });

    it('returns false for suspended user', () => {
      getOrCreateUser(123, {});
      setUserStatus(123, 'suspended');
      expect(isUserAuthorized(123)).toBe(false);
    });
  });

  describe('isOwner', () => {
    it('returns true for owner tier', () => {
      getOrCreateUser(123, {});
      setUserTier(123, 'owner');
      expect(isOwner(123)).toBe(true);
    });

    it('returns false for free tier', () => {
      getOrCreateUser(123, {});
      expect(isOwner(123)).toBe(false);
    });

    it('does not treat a persisted owner tier as canonical AI owner identity', () => {
      getOrCreateUser(123, {});
      setUserTier(123, 'owner');

      expect(isOwnerUserRef(123)).toBe(true);
      expect(isOwnerUserRef(123, {
        allowPersistedTier: false,
        requireConfiguredIdentity: true,
      })).toBe(false);
    });

    it('recognizes the configured owner identity for canonical AI access', () => {
      vi.stubEnv('OWNER_TELEGRAM_ID', '123');
      getOrCreateUser(123, {});

      expect(isOwnerUserRef(123, {
        allowPersistedTier: false,
        requireConfiguredIdentity: true,
      })).toBe(true);
    });
  });

  describe('seedOwnerUser', () => {
    it('auto-creates from OWNER_TELEGRAM_ID', () => {
      vi.stubEnv('OWNER_TELEGRAM_ID', '111111');
      seedOwnerUser();
      const user = getUserByTelegramId(111111);
      expect(user).not.toBeNull();
      expect(user!.tier).toBe('owner');
      expect(user!.daily_message_limit).toBe(0); // Unlimited
    });

    it('is idempotent', () => {
      vi.stubEnv('OWNER_TELEGRAM_ID', '111111');
      seedOwnerUser();
      seedOwnerUser();
      const users = listUsers();
      expect(users.filter(u => u.telegram_id === 111111)).toHaveLength(1);
    });

    it('exposes the explicit owner bootstrap Telegram identity helper', () => {
      vi.stubEnv('OWNER_TELEGRAM_ID', '111111');
      expect(isOwnerBootstrapTelegramId(111111)).toBe(true);
      expect(isOwnerBootstrapTelegramId(222222)).toBe(false);
    });

    it('prefers a persisted owner row over the legacy allowed-user fallback', () => {
      testDb.prepare(`
        INSERT INTO users (
          telegram_id, first_name, language, tier, status,
          daily_message_limit, daily_token_limit, daily_cost_limit_usd
        )
        VALUES (222222, 'Persisted Owner', 'pt-BR', 'owner', 'active', 0, 0, 0)
      `).run();

      expect(getOwnerBootstrapTelegramId()).toBe(222222);
      expect(isOwnerBootstrapTelegramId(222222)).toBe(true);
      expect(isOwnerBootstrapTelegramId(111111)).toBe(false);
    });

    it('no longer falls back to TELEGRAM_ALLOWED_USER_IDS[0] when no explicit or persisted owner exists', () => {
      expect(getOwnerBootstrapTelegramId()).toBeNull();
      expect(isOwnerBootstrapTelegramId(111111)).toBe(false);
    });

    it('upgrades an existing matching Telegram user into the owner bootstrap user', () => {
      vi.stubEnv('OWNER_TELEGRAM_ID', '111111');
      getOrCreateUser(111111, { firstName: 'Felipe' });

      seedOwnerUser();

      const user = getUserByTelegramId(111111);
      expect(user).not.toBeNull();
      expect(user!.tier).toBe('owner');
      expect(user!.status).toBe('active');
      expect(user!.daily_message_limit).toBe(0);
      expect(user!.daily_token_limit).toBe(0);
      expect(user!.daily_cost_limit_usd).toBe(0);
    });

    it('fails fast in production when no explicit or persisted owner bootstrap exists', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('VITEST', '');
      expect(() => assertOwnerBootstrapReadyForRuntime()).toThrow(
        'Owner bootstrap unavailable. Set OWNER_TELEGRAM_ID or persist an owner-tier user row before starting Nexus Hub.',
      );
    });

    it('fails fast in production when OWNER_TELEGRAM_ID disagrees with the persisted owner row', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('VITEST', '');
      vi.stubEnv('OWNER_TELEGRAM_ID', '111111');
      testDb.prepare(`
        INSERT INTO users (
          telegram_id, first_name, language, tier, status,
          daily_message_limit, daily_token_limit, daily_cost_limit_usd
        )
        VALUES (222222, 'Persisted Owner', 'pt-BR', 'owner', 'active', 0, 0, 0)
      `).run();

      expect(() => assertOwnerBootstrapReadyForRuntime()).toThrow(
        'Owner bootstrap mismatch: OWNER_TELEGRAM_ID=111111 but persisted owner telegram_id=222222. Align bootstrap configuration before starting Nexus Hub.',
      );
    });
  });

  describe('bootstrap boundary structure', () => {
    it('legacy Telegram bot factory stays deleted (no whitelist auth reintroduction)', () => {
      // The Grammy bot factory (src/bot.ts) was removed with the Telegram
      // legacy delivery path (2026-07). Its raw allowedUserIds whitelist
      // auth must not come back.
      expect(fs.existsSync(path.resolve(__dirname, '../../src/bot.ts'))).toBe(false);
    });
  });

  describe('language', () => {
    it('defaults to pt-BR', () => {
      getOrCreateUser(123, {});
      expect(getUserLanguage(123)).toBe('pt-BR');
    });

    it('can be changed', () => {
      getOrCreateUser(123, {});
      setUserLanguage(123, 'en-US');
      expect(getUserLanguage(123)).toBe('en-US');
    });

    it('resolves language by canonical user id for iOS users', () => {
      const user = createEmailUser('ios-language@example.com', 'hash', { firstName: 'iOS' });
      expect(getUserLanguage(user.id)).toBe('pt-BR');

      setUserLanguage(user.id, 'en-US');
      expect(getUserLanguage(user.id)).toBe('en-US');
    });
  });

  describe('display name sanitization', () => {
    it('filters technical fallback identifiers', () => {
      expect(sanitizeDisplayName('Beta-D36C3E05')).toBe('');
      expect(sanitizeDisplayName('felipe@example.com')).toBe('');
      expect(sanitizeDisplayName('Felipe')).toBe('Felipe');
    });

    it('prefers the first human-friendly profile field', () => {
      const user = createEmailUser('display@example.com', 'hash', { firstName: 'Beta-D36C3E05' });
      testDb.prepare('UPDATE users SET username = ? WHERE id = ?').run('felipedf', user.id);

      expect(getPreferredDisplayName(user.id)).toBe('felipedf');
    });
  });

  describe('touchUser', () => {
    it('updates last_active_at', () => {
      getOrCreateUser(123, {});
      touchUser(123);
      const user = getUserByTelegramId(123);
      expect(user!.last_active_at).not.toBeNull();
    });
  });

  describe('tier management', () => {
    it('setUserTier updates tier and limits', () => {
      getOrCreateUser(123, {});
      setUserTier(123, 'pro');
      const user = getUserByTelegramId(123)!;
      expect(user.tier).toBe('pro');
      expect(user.daily_message_limit).toBe(200);
      expect(user.daily_cost_limit_usd).toBe(0.04);
    });

    it('owner tier gets unlimited (0)', () => {
      getOrCreateUser(123, {});
      setUserTier(123, 'owner');
      const user = getUserByTelegramId(123)!;
      expect(user.daily_message_limit).toBe(0);
      expect(user.daily_token_limit).toBe(0);
    });
  });

  describe('invite codes', () => {
    it('creates and validates a code', () => {
      const code = createInviteCode(111111);
      expect(code.length).toBeGreaterThanOrEqual(22);
      expect(validateAndConsumeInviteCode(code)).toEqual({ valid: true });
    });

    it('peeks expiring database invite codes without consuming them', () => {
      const code = createInviteCode(111111, 1, 30);
      const peeked = peekInviteCode(code);
      expect(peeked.valid).toBe(true);
      expect(peeked.expiresAt).toBeTruthy();
      expect(validateAndConsumeInviteCode(code).valid).toBe(true);
    });

    it('code exhausted after max uses', () => {
      const code = createInviteCode(111111, 1);
      expect(validateAndConsumeInviteCode(code).valid).toBe(true);
      expect(validateAndConsumeInviteCode(code).valid).toBe(false); // Exhausted
    });

    it('multi-use code works up to max', () => {
      const code = createInviteCode(111111, 3);
      expect(validateAndConsumeInviteCode(code).valid).toBe(true);
      expect(validateAndConsumeInviteCode(code).valid).toBe(true);
      expect(validateAndConsumeInviteCode(code).valid).toBe(true);
      expect(validateAndConsumeInviteCode(code).valid).toBe(false);
    });

    it('expired code returns invalid', () => {
      const code = createInviteCode(111111, 1, -1); // Expired 1 day ago
      expect(validateAndConsumeInviteCode(code).valid).toBe(false);
    });

    it('invalid code returns invalid', () => {
      expect(validateAndConsumeInviteCode('NOTACODE').valid).toBe(false);
    });

    it('returns skill preset when present', () => {
      const code = createInviteCode(111111);
      // Manually set skill_preset
      testDb.prepare('UPDATE invite_codes SET skill_preset = ? WHERE code = ?')
        .run(JSON.stringify({ triathlon: true, cooking: false }), code);
      const result = validateAndConsumeInviteCode(code);
      expect(result.valid).toBe(true);
      expect(result.skillPreset).toEqual({ triathlon: true, cooking: false });
    });

    it('returns no skill preset when column is null', () => {
      const code = createInviteCode(111111);
      const result = validateAndConsumeInviteCode(code);
      expect(result.valid).toBe(true);
      expect(result.skillPreset).toBeUndefined();
    });

    it('listInviteCodes returns all codes', () => {
      createInviteCode(111111);
      createInviteCode(111111);
      expect(listInviteCodes()).toHaveLength(2);
    });

    it('deleteInviteCode removes a code', () => {
      const code = createInviteCode(111111);
      expect(deleteInviteCode(code)).toBe(true);
      expect(listInviteCodes()).toHaveLength(0);
    });
  });
});

describe('i18n', () => {
  it('returns PT-BR for PT-BR lang', () => {
    expect(t('welcome', 'pt-BR')).toContain('Bem-vindo');
  });

  it('returns PT-PT variant when available', () => {
    expect(t('welcome', 'pt-PT')).toContain('o teu assistente');
    expect(t('rate_limited', 'pt-PT', { limit: '40', timezone: 'Europe/Lisbon' })).toContain('Atingiste');
  });

  it('returns EN for EN lang', () => {
    expect(t('welcome', 'en-US')).toContain('Welcome');
  });

  it('substitutes {variables}', () => {
    const msg = t('rate_limited', 'en-US', { limit: '40', timezone: 'Europe/Lisbon' });
    expect(msg).toContain('40');
    expect(msg).toContain('Europe/Lisbon');
  });

  it('falls back to EN for unknown lang key', () => {
    const msg = t('welcome', 'en-US');
    expect(msg).toBeTruthy();
    expect(msg).not.toBe('welcome');
  });

  it('returns key when message not found', () => {
    expect(t('nonexistent_key', 'en-US')).toBe('nonexistent_key');
  });

  it('falls back from pt-PT to pt-BR when no dedicated variant exists', () => {
    expect(t('coach_good_training', 'pt-PT')).toBe('💪 Bom treino amanhã!');
  });

  describe('detectLanguageFromTelegram', () => {
    it('detects PT', () => {
      expect(detectLanguageFromTelegram('pt')).toBe('pt-BR');
      expect(detectLanguageFromTelegram('pt-BR')).toBe('pt-BR');
      expect(detectLanguageFromTelegram('pt-PT')).toBe('pt-PT');
    });

    it('detects EN', () => {
      expect(detectLanguageFromTelegram('en')).toBe('en-US');
      expect(detectLanguageFromTelegram('en-US')).toBe('en-US');
    });

    it('defaults to PT-BR for undefined', () => {
      expect(detectLanguageFromTelegram(undefined)).toBe('pt-BR');
    });

    it('defaults to EN for other languages', () => {
      expect(detectLanguageFromTelegram('de')).toBe('en-US');
      expect(detectLanguageFromTelegram('fr')).toBe('en-US');
    });
  });
});
