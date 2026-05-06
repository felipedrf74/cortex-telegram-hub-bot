import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Optional migration dependencies are ignored in focused state tests.
      }
    }
  }
}

import {
  addChannel,
  addSystemChannel,
  buildKnowledgePromptBlock,
  createContentReferencesAdminContext,
  getAllChannels,
  getAllKnowledge,
  getKnowledgeByCategory,
  getSystemChannels,
  getSystemKnowledge,
  getSystemKnowledgeByCategory,
  upsertKnowledge,
  upsertSystemKnowledge,
} from '../../src/state/content-references';

describe('content-references admin/system-scope split', () => {
  const adminContext = createContentReferencesAdminContext('content references admin split test');

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('rejects invalid user ids before touching storage on user-scoped entry points', () => {
    const invalidUserIds = [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1];

    for (const invalidUserId of invalidUserIds) {
      expect(() => addChannel('https://youtube.com/@bad', 'manual', invalidUserId)).toThrow(/positive integer/);
      expect(() => getAllChannels(invalidUserId)).toThrow(/positive integer/);
      expect(() => getAllKnowledge(invalidUserId)).toThrow(/positive integer/);
      expect(() => getKnowledgeByCategory('brand_voice', invalidUserId)).toThrow(/positive integer/);
      expect(() => upsertKnowledge('brand_voice', 'voice', ['test'], invalidUserId)).toThrow(/positive integer/);
      expect(() => buildKnowledgePromptBlock(invalidUserId)).toThrow(/positive integer/);
    }
  });

  it('requires explicit admin context for system-scope channel writes and reads', () => {
    expect(() => addSystemChannel('https://youtube.com/@system', 'manual', undefined as any))
      .toThrow(/admin context required for system-scope channel write/);
    expect(() => getSystemChannels(undefined as any))
      .toThrow(/admin context required for system-scope channel read/);

    const systemChannel = addSystemChannel('https://youtube.com/@system', 'manual', adminContext);

    expect(systemChannel.user_id).toBe(0);
    expect(systemChannel.owner_scope).toBe('system');
    expect(getSystemChannels(adminContext)).toHaveLength(1);
  });

  it('keeps system rows out of positive-user reads unless they are deliberately shared', () => {
    addSystemChannel('https://youtube.com/@system', 'manual', adminContext);
    addChannel('https://youtube.com/@user', 'manual', 42);

    const userRows = getAllChannels(42);
    const systemRows = getSystemChannels(adminContext);

    expect(userRows.map((row) => row.channel_url)).toEqual(['https://youtube.com/@user']);
    expect(systemRows.map((row) => row.channel_url)).toEqual(['https://youtube.com/@system']);
  });

  it('requires explicit admin context for system knowledge and prevents cross-scope reads', () => {
    expect(() => upsertSystemKnowledge('brand_voice', 'System voice', ['system'], undefined as any))
      .toThrow(/admin context required for system-scope knowledge write/);
    expect(() => getSystemKnowledge(undefined as any))
      .toThrow(/admin context required for system-scope knowledge read/);

    upsertSystemKnowledge('brand_voice', 'System voice', ['system'], adminContext);
    upsertKnowledge('hook_style', 'User hook', ['user'], 42);

    expect(getSystemKnowledgeByCategory('brand_voice', adminContext)?.synthesized_text).toBe('System voice');
    expect(getKnowledgeByCategory('brand_voice', 42)).toBeUndefined();
    expect(getAllKnowledge(42).map((row) => row.synthesized_text)).toEqual(['User hook']);
    expect(getSystemKnowledge(adminContext).map((row) => row.synthesized_text)).toEqual(['System voice']);
  });
});
