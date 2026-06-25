import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;
const {
  completeOneShotWithFallback,
  getWorkflowEligibleIdeas,
  readSignals,
  getScript,
  storeScript,
  getUserLanguage,
} = vi.hoisted(() => ({
  completeOneShotWithFallback: vi.fn(),
  getWorkflowEligibleIdeas: vi.fn(() => []),
  readSignals: vi.fn(() => []),
  getScript: vi.fn(),
  storeScript: vi.fn(),
  getUserLanguage: vi.fn(() => 'pt-BR'),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    anthropic: { apiKey: 'test', classifierModel: 'test-model' },
    app: { timezone: 'Europe/Lisbon' },
  },
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback,
}));

vi.mock('../../src/portal/anthropic-hook', () => ({
  trackedCreate: vi.fn(),
}));

vi.mock('../../src/utils/prompt-loader', () => ({
  loadPromptWithConfig: vi.fn((_name: string, values: Record<string, string>) => [
    values.KNOWLEDGE_BLOCK || '',
    values.TASTE_PROFILE || '',
  ].join('\n')),
}));

vi.mock('../../src/services/content-dedup', () => ({
  buildAngleDiversityBlock: () => '',
  isDuplicateIdea: vi.fn(async () => ({ isDuplicate: false, confidence: 0, similarTo: null })),
}));

vi.mock('../../src/state/saved-ideas', () => ({
  getWorkflowEligibleIdeas,
  markIdeaPromoted: vi.fn(),
}));

vi.mock('../../src/services/intelligence-bus', () => ({
  readSignals,
}));

vi.mock('../../src/services/content-engine', () => ({
  getScript,
}));

vi.mock('../../src/services/content-learning-store', () => ({
  storeScript,
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage,
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
        // Some repo migrations depend on optional tables; ignore in focused tests.
      }
    }
  }
}

function seedGroundedReference(userId: number): void {
  testDb.prepare(`
    INSERT INTO content_reference_links (
      user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
      url, title, source_type, extraction_status, freshness_score, quality_score, trust_level,
      broken_status, stale_status, created_by, updated_by, audit_metadata_json
    )
    VALUES (?, ?, ?, 'user_private', 'active', 'active', ?, ?, 'link', 'ready', 0.9, 0.9, 'curated', 'ok', 'fresh', ?, ?, '{}')
  `).run(
    userId,
    userId,
    userId,
    `https://example.com/source-${userId}`,
    'Trusted source',
    userId,
    userId,
  );
}

import {
  generateScript,
  generateTopicCandidates,
  getTopicById,
  markScriptGenerated,
  updateFeedback,
} from '../../src/services/content-workflow';

describe('content-workflow: user-scoped knowledge injection', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    completeOneShotWithFallback.mockReset();
    getWorkflowEligibleIdeas.mockReset();
    readSignals.mockReset();
    getScript.mockReset();
    storeScript.mockReset();
    getUserLanguage.mockReset();
    completeOneShotWithFallback.mockResolvedValue({
      text: '[]',
      provider: 'gemini',
    });
    getWorkflowEligibleIdeas.mockReturnValue([]);
    readSignals.mockReturnValue([]);
    getUserLanguage.mockReturnValue('pt-BR');
  });

  afterEach(() => {
    testDb?.close();
  });

  it('injects the authenticated user voice DNA instead of the shared system fallback', async () => {
    testDb.prepare(`
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, user_id, owner_scope, version)
      VALUES ('brand_voice', 'System voice', '["system"]', 0, 'system', 1)
    `).run();
    testDb.prepare(`
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, user_id, owner_scope, version)
      VALUES ('brand_voice', 'User voice', '["@user"]', 42, 'user', 2)
    `).run();

    await generateTopicCandidates('reel', 1, false, 42);

    expect(completeOneShotWithFallback).toHaveBeenCalledTimes(1);
    const [systemPrompt] = completeOneShotWithFallback.mock.calls[0];
    expect(systemPrompt).toContain('User voice');
    expect(systemPrompt).not.toContain('System voice');
  });

  it('reads workflow discovery and book signals with explicit user scope', async () => {
    await generateTopicCandidates('youtube', 2, true, 42);

    expect(readSignals).toHaveBeenCalledWith('content-workflow', ['book_knowledge'], 20, 42);
    expect(getWorkflowEligibleIdeas).toHaveBeenCalledWith(42, 42);
  });

  it('scopes topic feedback mutations and reads when userId is provided', () => {
    const insert = testDb.prepare(`
      INSERT INTO content_topic_feedback
        (topic, niche, format, sentiment, source_job, hook_idea, why_now, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const ownedId = Number(insert.run(
      'Owned topic',
      'ai-tech',
      'reel',
      'pending',
      'manual',
      'Open with tension',
      'Useful this week',
      42,
    ).lastInsertRowid);
    const otherId = Number(insert.run(
      'Other topic',
      'ai-tech',
      'reel',
      'pending',
      'manual',
      'Open with tension',
      'Useful this week',
      77,
    ).lastInsertRowid);

    updateFeedback(otherId, 'approved', 42, 42);
    markScriptGenerated(otherId, 42, 42);
    updateFeedback(ownedId, 'approved', 42, 42);
    markScriptGenerated(ownedId, 42, 42);

    const owned = testDb.prepare('SELECT sentiment, script_generated FROM content_topic_feedback WHERE id = ?').get(ownedId) as any;
    const other = testDb.prepare('SELECT sentiment, script_generated FROM content_topic_feedback WHERE id = ?').get(otherId) as any;

    expect(owned).toEqual({ sentiment: 'approved', script_generated: 1 });
    expect(other).toEqual({ sentiment: 'pending', script_generated: 0 });
    expect(getTopicById(ownedId, 42, 42)?.title).toBe('Owned topic');
    expect(getTopicById(otherId, 42, 42)).toBeNull();
  });

  it('forwards first-party topic context and packaging lineage through generateScript', async () => {
    seedGroundedReference(42);
    getUserLanguage.mockReturnValue('en-US');
    getScript.mockResolvedValue({
      topic: 'Build solo with vibe coding',
      script: '[0:00] Open strong',
      hook: 'Ship ugly first',
      title_options: ['Title A', 'Title B'],
      sources_used: [{ title: 'Source', url: 'https://example.com', source_type: 'web', relevance_note: 'Relevant' }],
      estimated_duration: '8:00',
      duration_ms: 900,
      hashtags: ['#saas', '#buildinpublic'],
      caption: 'Final caption',
      cta: 'Save this for your next sprint.',
    });

    await generateScript({
      title: 'Build solo with vibe coding',
      niche: 'product',
      whyNow: 'Builders can ship faster with AI tooling',
      hookIdea: 'Ship the first ugly version fast',
      angleTag: 'build-in-public',
      feedbackId: 77,
    }, 'youtube', 42);

    expect(getScript).toHaveBeenCalledWith(
      'Build solo with vibe coding',
      'product',
      8,
      'YouTube',
      'standard',
      null,
      'en-US',
      'structured',
      42,
      undefined,
      {
        topicFeedbackId: 77,
        niche: 'product',
        hookIdea: 'Ship the first ugly version fast',
        whyNow: 'Builders can ship faster with AI tooling',
        angleTag: 'build-in-public',
      },
      'detailed',
    );

    expect(storeScript).toHaveBeenCalledWith(expect.objectContaining({
      topicFeedbackId: 77,
      topic: 'Build solo with vibe coding',
      hashtags: ['#saas', '#buildinpublic'],
      caption: 'Final caption',
      cta: 'Save this for your next sprint.',
      userId: 42,
    }));
  });

  it('refuses sourced script generation when the tenant has no grounded references', async () => {
    await expect(generateScript({
      title: 'Unsupported source-required script',
      niche: 'product',
      whyNow: 'Needs proof',
      hookIdea: 'Proof first',
    }, 'youtube', 42)).rejects.toMatchObject({
      code: 'CONTENT_GENERATION_REFUSED_NO_REFERENCES',
    });

    expect(getScript).not.toHaveBeenCalled();
    expect(storeScript).not.toHaveBeenCalled();
  });
});
