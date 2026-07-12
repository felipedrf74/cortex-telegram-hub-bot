import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  withDatabaseForTestAsync: vi.fn(),
}));

import {
  addChannel,
  addSystemChannel,
  buildKnowledgePromptBlock,
  buildSystemKnowledgePromptBlock,
  createContentReferencesAdminContext,
  getActiveChannels,
  getAllChannels,
  getAllKnowledge,
  getAllPatternsByCategory,
  getChannel,
  getKnowledgeByCategory,
  getPatternsForChannel,
  getPendingChannels,
  getSystemChannels,
  getSystemKnowledge,
  getSystemKnowledgeByCategory,
  getSystemPatternsByCategory,
  removeChannel,
  updateChannelStatus,
  upsertKnowledge,
  upsertPatterns,
  upsertSystemKnowledge,
} from '../../src/state/content-references';

const INVALID_USER_IDS = [0, -1, null, undefined, Number.NaN, '0', '1', Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1] as const;
const VALID_USER_IDS = [1, 2, 100, Number.MAX_SAFE_INTEGER] as const;
const REQUIRED_USER_ID_ERROR = /userId required: must be a positive integer/;
const ADMIN_CONTEXT_ERROR = /admin context required for system-scope/;

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

function pattern(text: string) {
  return [{
    category: 'brand_voice' as const,
    pattern_text: text,
    examples: [text],
    confidence: 0.9,
    source_videos: ['video-1'],
  }];
}

describe('state/content-references isolation contract', () => {
  const adminContext = createContentReferencesAdminContext('state isolation pack');

  beforeEach(() => {
    testDb = new Database(':memory:');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  describe.each(INVALID_USER_IDS)('invalid userId %s', (userId) => {
    it('user-scoped channel functions reject', () => {
      expect(() => addChannel('https://youtube.com/@unsafe', 'manual', userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => getAllChannels(userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => getActiveChannels(userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => getPendingChannels(userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => getChannel(1, { userId: userId as number })).toThrow(REQUIRED_USER_ID_ERROR);
    });

    it('user-scoped pattern and knowledge functions reject', () => {
      expect(() => getAllPatternsByCategory('brand_voice', userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => upsertKnowledge('brand_voice', 'unsafe', ['unsafe'], userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => getAllKnowledge(userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => getKnowledgeByCategory('brand_voice', userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
      expect(() => buildKnowledgePromptBlock(userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
    });
  });

  describe.each(VALID_USER_IDS)('valid userId %s', (userId) => {
    it('round-trips user-scoped channels and knowledge', () => {
      const channel = addChannel(`https://youtube.com/@user-${userId}`, 'manual', userId);
      updateChannelStatus(channel.id, 'active', { channel_name: `User ${userId}` }, { userId });
      upsertPatterns(channel.id, pattern(`voice-${userId}`), { userId });
      upsertKnowledge('brand_voice', `knowledge-${userId}`, [`source-${userId}`], userId);

      expect(getAllChannels(userId).map((row) => row.channel_url)).toEqual([`https://youtube.com/@user-${userId}`]);
      expect(getAllPatternsByCategory('brand_voice', userId).map((row) => row.pattern_text)).toEqual([`voice-${userId}`]);
      expect(getKnowledgeByCategory('brand_voice', userId)?.synthesized_text).toBe(`knowledge-${userId}`);
    });
  });

  it('requires explicit admin context for every system-scoped entry point', () => {
    expect(() => addSystemChannel('https://youtube.com/@system', 'manual', undefined as any)).toThrow(ADMIN_CONTEXT_ERROR);
    expect(() => getSystemChannels(undefined as any)).toThrow(ADMIN_CONTEXT_ERROR);
    expect(() => upsertSystemKnowledge('brand_voice', 'system', ['system'], undefined as any)).toThrow(ADMIN_CONTEXT_ERROR);
    expect(() => getSystemKnowledge(undefined as any)).toThrow(ADMIN_CONTEXT_ERROR);
    expect(() => getSystemKnowledgeByCategory('brand_voice', undefined as any)).toThrow(ADMIN_CONTEXT_ERROR);
    expect(() => getSystemPatternsByCategory('brand_voice', undefined as any)).toThrow(ADMIN_CONTEXT_ERROR);
    expect(() => buildSystemKnowledgePromptBlock(undefined as any)).toThrow(ADMIN_CONTEXT_ERROR);
    expect(() => updateChannelStatus(1, 'active', undefined, { adminContext: undefined as any })).toThrow(ADMIN_CONTEXT_ERROR);
    expect(() => removeChannel(1, { adminContext: undefined as any })).toThrow(ADMIN_CONTEXT_ERROR);
    expect(() => getPatternsForChannel(1, { adminContext: undefined as any })).toThrow(ADMIN_CONTEXT_ERROR);
  });

  it('keeps user-scoped channel rows isolated from system-scope reads', () => {
    const systemChannel = addSystemChannel('https://youtube.com/@system', 'manual', adminContext);
    const userChannel = addChannel('https://youtube.com/@user', 'manual', 42);

    expect(getAllChannels(42).map((row) => row.channel_url)).toEqual(['https://youtube.com/@user']);
    expect(getSystemChannels(adminContext).map((row) => row.channel_url)).toEqual(['https://youtube.com/@system']);
    expect(getChannel(systemChannel.id, { userId: 42 })).toBeUndefined();
    expect(getChannel(userChannel.id, { adminContext })).toMatchObject({ channel_url: 'https://youtube.com/@user' });
  });

  it('refuses cross-scope channel writes and deletes', () => {
    const systemChannel = addSystemChannel('https://youtube.com/@system', 'manual', adminContext);
    const userChannel = addChannel('https://youtube.com/@user', 'manual', 42);

    expect(() => updateChannelStatus(systemChannel.id, 'active', undefined, { userId: 42 }))
      .toThrow(/channel not found in requested user scope/);
    expect(removeChannel(systemChannel.id, { userId: 42 })).toBe(false);
    expect(() => upsertPatterns(systemChannel.id, pattern('leak'), { userId: 42 }))
      .toThrow(/channel not found in requested user scope/);

    updateChannelStatus(systemChannel.id, 'active', { channel_name: 'System' }, { adminContext });
    updateChannelStatus(userChannel.id, 'active', { channel_name: 'User' }, { userId: 42 });

    expect(removeChannel(systemChannel.id, { adminContext })).toBe(true);
    expect(removeChannel(systemChannel.id, { adminContext })).toBe(false);
    expect(getAllChannels(42)).toMatchObject([{ channel_url: 'https://youtube.com/@user' }]);
  });

  it('keeps system patterns and user patterns out of each other reads', () => {
    const systemChannel = addSystemChannel('https://youtube.com/@system', 'manual', adminContext);
    const userChannel = addChannel('https://youtube.com/@user', 'manual', 42);

    updateChannelStatus(systemChannel.id, 'active', { channel_name: 'System' }, { adminContext });
    updateChannelStatus(userChannel.id, 'active', { channel_name: 'User' }, { userId: 42 });
    upsertPatterns(systemChannel.id, pattern('system pattern'), { adminContext });
    upsertPatterns(userChannel.id, pattern('user pattern'), { userId: 42 });

    expect(getPatternsForChannel(systemChannel.id, { adminContext }).map((row) => row.pattern_text))
      .toEqual(['system pattern']);
    expect(getPatternsForChannel(systemChannel.id, { userId: 42 })).toEqual([]);
    expect(getPatternsForChannel(userChannel.id, { userId: 42 }).map((row) => row.pattern_text))
      .toEqual(['user pattern']);
    expect(getSystemPatternsByCategory('brand_voice', adminContext).map((row) => row.pattern_text))
      .toEqual(['system pattern']);
    expect(getAllPatternsByCategory('brand_voice', 42).map((row) => row.pattern_text))
      .toEqual(['user pattern']);
  });

  it('keeps system knowledge and user knowledge out of each other prompt paths', () => {
    upsertSystemKnowledge('brand_voice', 'System voice', ['system'], adminContext);
    upsertKnowledge('brand_voice', 'User voice', ['user'], 42);

    expect(getSystemKnowledge(adminContext).map((row) => row.synthesized_text)).toEqual(['System voice']);
    expect(getAllKnowledge(42).map((row) => row.synthesized_text)).toEqual(['User voice']);
    expect(getSystemKnowledgeByCategory('brand_voice', adminContext)?.synthesized_text).toBe('System voice');
    expect(getKnowledgeByCategory('brand_voice', 42)?.synthesized_text).toBe('User voice');
    expect(buildSystemKnowledgePromptBlock(adminContext)).toContain('System voice');
    expect(buildSystemKnowledgePromptBlock(adminContext)).not.toContain('User voice');
    expect(buildKnowledgePromptBlock(42)).toContain('User voice');
    expect(buildKnowledgePromptBlock(42)).not.toContain('System voice');
  });

  it('records a durable marker when system-derived knowledge enters a user prompt', () => {
    const systemChannel = addSystemChannel('https://youtube.com/@shared-source', 'manual', adminContext);
    updateChannelStatus(systemChannel.id, 'active', { channel_name: 'Shared Source' }, { adminContext });
    upsertKnowledge('brand_voice', 'Adapted shared guidance', ['Shared Source'], 42);

    expect(buildKnowledgePromptBlock(42, 42)).toContain('Adapted shared guidance');
    expect(testDb.prepare(`
      SELECT user_id, tenant_id, source
        FROM shared_knowledge_consumption
       WHERE user_id = 42
    `).get()).toEqual({
      user_id: 42,
      tenant_id: 42,
      source: 'content_prompt',
    });

    // Daily uniqueness prevents prompt construction from inflating evidence.
    buildKnowledgePromptBlock(42, 42);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM shared_knowledge_consumption
       WHERE user_id = 42
    `).get()).toEqual({ count: 1 });
  });
});
