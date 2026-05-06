import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
const completeOneShotWithFallback = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/config', () => ({
  config: {
    anthropic: { apiKey: 'test-anthropic-key', classifierModel: 'claude-haiku-test' },
    gemini: { model: 'gemini-test' },
    openai: { apiKey: 'test-openai-key' },
    aiSafety: { callTimeoutMs: 1000 },
  },
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback,
}));

vi.mock('../../src/portal/anthropic-hook', () => ({
  trackedCreate: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import { isDuplicateIdea } from '../../src/services/content-dedup';

function seedIdea(userId: number, title: string, angleTag: string | null = null): void {
  testDb.prepare(`
    INSERT INTO saved_ideas (title, angle_tag, user_id, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(title, angleTag, userId);
}

describe('content dedup provider routing', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE saved_ideas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        angle_tag TEXT,
        user_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE content_topic_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        angle_tag TEXT,
        user_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    completeOneShotWithFallback.mockReset();
    completeOneShotWithFallback.mockResolvedValue({
      text: '{"isDuplicate":false,"similarTo":null,"confidence":0.1}',
      provider: 'gemini',
    });
  });

  afterEach(() => {
    testDb?.close();
  });

  it('uses the live one-shot routing cascade with user-scoped context', async () => {
    seedIdea(42, 'Race week recap');
    seedIdea(42, 'Fueling mistakes before long runs');
    seedIdea(42, 'Creator workflow for endurance athletes');
    seedIdea(77, 'Private tenant B launch plan');

    const result = await isDuplicateIdea('Race week content workflow', 'framework', 42);

    expect(result.isDuplicate).toBe(false);
    expect(completeOneShotWithFallback).toHaveBeenCalledTimes(1);
    const [systemPrompt, userPrompt, category, anthropicFallback, options] = completeOneShotWithFallback.mock.calls[0];
    expect(systemPrompt).toContain('strict semantic duplicate detector');
    expect(userPrompt).toContain('Race week recap');
    expect(userPrompt).not.toContain('Private tenant B launch plan');
    expect(category).toBe('content_dedup');
    expect(typeof anthropicFallback).toBe('function');
    expect(options).toMatchObject({
      maxTokens: 256,
      temperature: 0.1,
      jsonMode: true,
      userId: 42,
    });
  });

  it('partitions cache by user scope', async () => {
    seedIdea(42, 'User A topic one');
    seedIdea(42, 'User A topic two');
    seedIdea(42, 'User A topic three');
    seedIdea(77, 'User B topic one');
    seedIdea(77, 'User B topic two');
    seedIdea(77, 'User B topic three');

    await isDuplicateIdea('Shared title', 'opinion', 42);
    await isDuplicateIdea('Shared title', 'opinion', 77);

    expect(completeOneShotWithFallback).toHaveBeenCalledTimes(2);
    expect(completeOneShotWithFallback.mock.calls[0][1]).toContain('User A topic one');
    expect(completeOneShotWithFallback.mock.calls[1][1]).toContain('User B topic one');
  });
});
