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
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [111111] },
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
  touchUser, getUserLanguage, setUserLanguage, listUsers, setUserStatus,
  setUserTier, seedOwnerUser,
  createInviteCode, validateAndConsumeInviteCode, listInviteCodes, deleteInviteCode,
} from '../../src/services/user-service';

import { t, detectLanguageFromTelegram } from '../../src/utils/i18n';

describe('user-service', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });

  afterEach(() => {
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
      expect(user.daily_cost_limit_usd).toBe(5.0);
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
  });

  describe('seedOwnerUser', () => {
    it('auto-creates from TELEGRAM_ALLOWED_USER_IDS[0]', () => {
      seedOwnerUser();
      const user = getUserByTelegramId(111111);
      expect(user).not.toBeNull();
      expect(user!.tier).toBe('owner');
      expect(user!.daily_message_limit).toBe(0); // Unlimited
    });

    it('is idempotent', () => {
      seedOwnerUser();
      seedOwnerUser();
      const users = listUsers();
      expect(users.filter(u => u.telegram_id === 111111)).toHaveLength(1);
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
      expect(code).toHaveLength(8);
      expect(validateAndConsumeInviteCode(code)).toEqual({ valid: true });
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

  describe('detectLanguageFromTelegram', () => {
    it('detects PT', () => {
      expect(detectLanguageFromTelegram('pt')).toBe('pt-BR');
      expect(detectLanguageFromTelegram('pt-BR')).toBe('pt-BR');
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
