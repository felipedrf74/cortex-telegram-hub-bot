import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  getDb: () => testDb,
  initDatabase: vi.fn(() => testDb),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  listUserScopedYoutubeChannelTargets,
  resolveUserScopedYoutubeChannelId,
} from '../../src/services/youtube-channel-scope';

function createSchema(): void {
  testDb.exec(`
    CREATE TABLE content_ref_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER,
      owner_user_id INTEGER,
      channel_id TEXT,
      channel_url TEXT NOT NULL,
      channel_name TEXT,
      status TEXT NOT NULL,
      added_via TEXT,
      source_metadata_json TEXT DEFAULT '{}'
    );
  `);
}

describe('user-scoped YouTube channel identity', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    createSchema();
  });

  afterEach(() => {
    testDb.close();
  });

  it('ignores system/global channels and ordinary reference channels', () => {
    testDb.prepare(`
      INSERT INTO content_ref_channels (user_id, tenant_id, channel_id, channel_url, status, added_via, source_metadata_json)
      VALUES
        (0, 0, 'UCglobal', 'https://youtube.com/@global', 'active', 'manual', '{}'),
        (101, 101, 'UCreference', 'https://youtube.com/@ref', 'active', 'manual', '{}')
    `).run();

    expect(listUserScopedYoutubeChannelTargets()).toEqual([]);
    expect(resolveUserScopedYoutubeChannelId(101)).toBeNull();
  });

  it('returns only authenticated creator channels marked as user-owned', () => {
    testDb.prepare(`
      INSERT INTO content_ref_channels (user_id, tenant_id, channel_id, channel_url, status, added_via, source_metadata_json)
      VALUES
        (101, 501, 'UCownerA', 'https://youtube.com/@ownerA', 'active', 'youtube_oauth', '{}'),
        (202, 602, 'UCownerB', 'https://youtube.com/@ownerB', 'active', 'manual', '{"role":"own_channel"}'),
        (303, 703, 'UCpending', 'https://youtube.com/@pending', 'pending', 'youtube_oauth', '{}')
    `).run();

    expect(listUserScopedYoutubeChannelTargets()).toEqual([
      { userId: 101, tenantId: 501, channelId: 'UCownerA' },
      { userId: 202, tenantId: 602, channelId: 'UCownerB' },
    ]);
    expect(resolveUserScopedYoutubeChannelId(101, 501)).toBe('UCownerA');
    expect(resolveUserScopedYoutubeChannelId(101, 602)).toBeNull();
  });

  it('handles malformed metadata, null tenant ids, unicode ids, and duplicate owner rows safely', () => {
    testDb.prepare(`
      INSERT INTO content_ref_channels (user_id, tenant_id, channel_id, channel_url, status, added_via, source_metadata_json)
      VALUES
        (101, NULL, 'UCownerUnicode_日本', 'https://youtube.com/@ownerA', 'active', 'youtube_oauth', '{bad-json'),
        (101, NULL, 'UCownerUnicode_日本', 'https://youtube.com/@ownerA-duplicate', 'active', 'youtube_oauth', '{"role":"own_channel"}'),
        (202, NULL, 'UCreference', 'https://youtube.com/@ref', 'active', 'manual', '{bad-json')
    `).run();

    expect(listUserScopedYoutubeChannelTargets()).toEqual([
      { userId: 101, tenantId: 101, channelId: 'UCownerUnicode_日本' },
    ]);
    expect(resolveUserScopedYoutubeChannelId(101)).toBe('UCownerUnicode_日本');
    expect(resolveUserScopedYoutubeChannelId(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
});
