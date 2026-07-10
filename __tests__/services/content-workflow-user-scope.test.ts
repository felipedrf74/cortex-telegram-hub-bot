import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;
const {
  completeOneShotWithFallback,
  completeOneShotWithSearch,
  completeOneShotWithWebSearch,
  isOpenAIConfigured,
  isPaidAiCostControlsEnforcementEnabled,
  getWorkflowEligibleIdeas,
  readSignals,
  getScript,
  storeScript,
  getUserLanguage,
  trackedCreate,
  isDuplicateIdeaInBatch,
  markIdeaPromoted,
} = vi.hoisted(() => ({
  completeOneShotWithFallback: vi.fn(),
  completeOneShotWithSearch: vi.fn(),
  completeOneShotWithWebSearch: vi.fn(),
  isOpenAIConfigured: vi.fn(() => false),
  isPaidAiCostControlsEnforcementEnabled: vi.fn(() => false),
  getWorkflowEligibleIdeas: vi.fn(() => []),
  readSignals: vi.fn(() => []),
  getScript: vi.fn(),
  storeScript: vi.fn(),
  getUserLanguage: vi.fn(() => 'pt-BR'),
  trackedCreate: vi.fn(),
  isDuplicateIdeaInBatch: vi.fn(),
  markIdeaPromoted: vi.fn(),
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
  completeOneShotWithSearch,
}));

vi.mock('../../src/services/openai-provider', () => ({
  completeOneShotWithWebSearch,
  isOpenAIConfigured,
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  withAiBudgetReservation: vi.fn(async (_request: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../src/services/entitlement', () => ({
  isPaidAiCostControlsEnforcementEnabled,
}));

vi.mock('../../src/portal/anthropic-hook', () => ({
  trackedCreate,
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
  isDuplicateIdeaInBatch,
}));

vi.mock('../../src/state/saved-ideas', () => ({
  getWorkflowEligibleIdeas,
  markIdeaPromoted,
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
  generateAndStoreTopicCandidates,
  generateWeeklyPackage,
  generateScript,
  generateTopicCandidates,
  getMissingScheduledInventoryCount,
  getTopicById,
  markScriptGenerated,
  storeTopicCandidates,
  shouldAttachTrendingWebSearch,
  updateFeedback,
} from '../../src/services/content-workflow';

describe('content-workflow: user-scoped knowledge injection', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    completeOneShotWithFallback.mockReset();
    completeOneShotWithSearch.mockReset();
    completeOneShotWithWebSearch.mockReset();
    isOpenAIConfigured.mockReset();
    isPaidAiCostControlsEnforcementEnabled.mockReset();
    getWorkflowEligibleIdeas.mockReset();
    readSignals.mockReset();
    getScript.mockReset();
    storeScript.mockReset();
    getUserLanguage.mockReset();
    trackedCreate.mockReset();
    isDuplicateIdeaInBatch.mockReset();
    markIdeaPromoted.mockReset();
    completeOneShotWithFallback.mockResolvedValue({
      text: '[]',
      provider: 'gemini',
    });
    completeOneShotWithSearch.mockResolvedValue({ text: '[]', sources: [] });
    completeOneShotWithWebSearch.mockResolvedValue({ text: '[]', sources: [] });
    isOpenAIConfigured.mockReturnValue(false);
    isPaidAiCostControlsEnforcementEnabled.mockReturnValue(false);
    getWorkflowEligibleIdeas.mockReturnValue([]);
    readSignals.mockReturnValue([]);
    getUserLanguage.mockReturnValue('pt-BR');
    isDuplicateIdeaInBatch.mockImplementation((newIdea: string, _angleTag: string | undefined, accepted: Array<{ title: string }>) => {
      const normalized = newIdea.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const match = accepted.find((candidate) => (
        candidate.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === normalized
      ));
      return match
        ? { isDuplicate: true, confidence: 0.95, similarTo: match.title }
        : { isDuplicate: false, confidence: 0, similarTo: null };
    });
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
    expect(getWorkflowEligibleIdeas).toHaveBeenCalledWith(42);
  });

  it('reuses fresh Discovery/Radar context without attaching a paid Anthropic web-search tool', async () => {
    getWorkflowEligibleIdeas.mockReturnValue([{
      id: 9,
      title: 'Fresh discovery idea',
      created_at: new Date().toISOString(),
    }]);
    readSignals.mockImplementation((_consumer: string, signalTypes: string[]) => (
      signalTypes.includes('trending_spike')
        ? [{ payload: { title: 'Fresh radar topic', reason: 'Spiking today' } }]
        : []
    ));
    completeOneShotWithFallback.mockResolvedValue({
      provider: 'gemini',
      text: JSON.stringify([{
          title: 'Fresh topic',
          niche: 'product',
          whyNow: 'Spiking today',
          hookIdea: 'Open with the spike',
          angle_tag: 'trending-take',
          pillar_emoji: '',
          time_sensitivity: 'react-today',
        }]),
    });

    const result = await generateTopicCandidates('reel', 1, true, 42, 42);

    expect(result).toHaveLength(1);
    expect(trackedCreate).not.toHaveBeenCalled();
    expect(completeOneShotWithSearch).not.toHaveBeenCalled();
    expect(completeOneShotWithFallback.mock.calls[0][1]).toContain('Fresh Content Radar Signals');
    expect(String(completeOneShotWithFallback.mock.calls[0][0]).length).toBeLessThanOrEqual(6500);
    expect(String(completeOneShotWithFallback.mock.calls[0][1]).length).toBeLessThanOrEqual(6500);
    expect(completeOneShotWithFallback.mock.calls[0][4]).toMatchObject({
      model: 'gemini-2.5-flash',
    });
    expect(shouldAttachTrendingWebSearch(true, true)).toBe(false);
    expect(shouldAttachTrendingWebSearch(true, false)).toBe(true);
  });

  it('marks Discovery ideas only after generated candidates are durably stored', async () => {
    getWorkflowEligibleIdeas.mockReturnValue([{
      id: 91,
      title: 'Fresh discovery source',
      created_at: new Date().toISOString(),
    }]);
    completeOneShotWithFallback.mockResolvedValue({
      provider: 'gemini',
      text: JSON.stringify([{
        title: 'Stored candidate',
        niche: 'product',
        whyNow: 'Useful now',
        hookIdea: 'Open with proof',
        angle_tag: 'framework',
        pillar_emoji: '',
        time_sensitivity: 'evergreen',
      }]),
    });

    const result = await generateAndStoreTopicCandidates(42, 'reel', 'tuesday_reels', 42, 1);

    expect(result.candidates).toHaveLength(1);
    expect((testDb.prepare(
      "SELECT COUNT(*) AS count FROM content_topic_feedback WHERE user_id = 42 AND source_job = 'tuesday_reels'",
    ).get() as { count: number }).count).toBe(1);
    expect(markIdeaPromoted).toHaveBeenCalledWith(91, 42);
  });

  it('does not consume a Discovery marker when the generated batch is empty', async () => {
    getWorkflowEligibleIdeas.mockReturnValue([{
      id: 92,
      title: 'Unconsumed discovery source',
      created_at: new Date().toISOString(),
    }]);
    completeOneShotWithFallback.mockResolvedValue({ provider: 'gemini', text: '[]' });

    const result = await generateAndStoreTopicCandidates(42, 'reel', 'tuesday_reels', 42, 1);

    expect(result.candidates).toEqual([]);
    expect(markIdeaPromoted).not.toHaveBeenCalled();
  });

  it('rolls back candidate inserts and keeps Discovery unpromoted when persistence fails', async () => {
    getWorkflowEligibleIdeas.mockReturnValue([{
      id: 93,
      title: 'Retryable discovery source',
      created_at: new Date().toISOString(),
    }]);
    completeOneShotWithFallback.mockResolvedValue({
      provider: 'gemini',
      text: JSON.stringify([{
        title: 'Candidate whose insert fails',
        niche: 'product',
        whyNow: 'Useful now',
        hookIdea: 'Open with proof',
        angle_tag: 'framework',
        pillar_emoji: '',
        time_sensitivity: 'evergreen',
      }]),
    });
    testDb.exec(`
      CREATE TRIGGER fail_scheduled_candidate_insert
      BEFORE INSERT ON content_topic_feedback
      WHEN NEW.source_job = 'tuesday_reels'
      BEGIN
        SELECT RAISE(ABORT, 'scheduled insert failed');
      END;
    `);

    await expect(generateAndStoreTopicCandidates(42, 'reel', 'tuesday_reels', 42, 1))
      .rejects.toThrow('scheduled insert failed');

    expect((testDb.prepare(
      "SELECT COUNT(*) AS count FROM content_topic_feedback WHERE user_id = 42 AND source_job = 'tuesday_reels'",
    ).get() as { count: number }).count).toBe(0);
    expect(markIdeaPromoted).not.toHaveBeenCalled();
  });

  it('uses an explicitly grounded provider path when fresh tenant signals are absent', async () => {
    completeOneShotWithSearch.mockResolvedValue({
      sources: ['https://example.test/current'],
      text: JSON.stringify([{
        title: 'Grounded topic',
        niche: 'product',
        whyNow: 'Current source',
        hookIdea: 'Open with the new evidence',
        angle_tag: 'trending-take',
        pillar_emoji: '',
        time_sensitivity: 'react-today',
      }]),
    });

    const result = await generateTopicCandidates('reel', 1, true, 42, 42);

    expect(result).toHaveLength(1);
    expect(completeOneShotWithSearch).toHaveBeenCalledTimes(1);
    expect(completeOneShotWithFallback).not.toHaveBeenCalled();
    expect(trackedCreate).not.toHaveBeenCalled();
  });

  it('uses one bounded OpenAI search first for enforced interactive research', async () => {
    isPaidAiCostControlsEnforcementEnabled.mockReturnValue(true);
    isOpenAIConfigured.mockReturnValue(true);
    completeOneShotWithWebSearch.mockResolvedValue({
      sources: ['https://example.test/bounded-search'],
      text: JSON.stringify([{
        title: 'Bounded grounded topic',
        niche: 'product',
        whyNow: 'Verified by current search',
        hookIdea: 'Open with the verified evidence',
        angle_tag: 'trending-take',
        pillar_emoji: '',
        time_sensitivity: 'react-today',
      }]),
    });

    const result = await generateTopicCandidates('reel', 1, true, 42, 42);

    expect(result.map((item) => item.title)).toEqual(['Bounded grounded topic']);
    expect(completeOneShotWithWebSearch).toHaveBeenCalledTimes(1);
    expect(completeOneShotWithWebSearch.mock.calls[0][2]).toContain('openai_web_search');
    expect(completeOneShotWithSearch).not.toHaveBeenCalled();
    expect(trackedCreate).not.toHaveBeenCalled();
  });

  it('uses an explicitly evergreen provider prompt when paid grounding cannot fit automation', async () => {
    isPaidAiCostControlsEnforcementEnabled.mockReturnValue(true);
    completeOneShotWithFallback.mockResolvedValue({
      provider: 'gemini',
      text: JSON.stringify([{
        title: 'Durable audience topic',
        niche: 'product',
        whyNow: 'A recurring audience need',
        hookIdea: 'Open with the durable pain point',
        angle_tag: 'framework',
        pillar_emoji: '',
        time_sensitivity: 'evergreen',
      }]),
    });

    const result = await generateTopicCandidates(
      'reel',
      1,
      true,
      42,
      42,
      { requestSource: 'automation', jobName: 'tuesday_reels' },
    );

    expect(result.map((item) => item.title)).toEqual(['Durable audience topic']);
    expect(completeOneShotWithSearch).not.toHaveBeenCalled();
    expect(completeOneShotWithWebSearch).not.toHaveBeenCalled();
    expect(completeOneShotWithFallback.mock.calls[0][1]).toContain('without live web search');
    expect(completeOneShotWithFallback.mock.calls[0][1]).toContain('Do not claim that a topic is currently trending');
  });

  it('rejects an ungrounded Gemini search response and requires grounded Anthropic fallback', async () => {
    completeOneShotWithSearch.mockResolvedValue({
      sources: [],
      text: JSON.stringify([{ title: 'Unverified topic' }]),
    });
    trackedCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      usage: { server_tool_use: { web_search_requests: 1 } },
      content: [{
        type: 'text',
        text: JSON.stringify([{
          title: 'Grounded fallback topic',
          niche: 'product',
          whyNow: 'Verified today',
          hookIdea: 'Open with the verified change',
          angle_tag: 'trending-take',
          pillar_emoji: '',
          time_sensitivity: 'react-today',
        }]),
      }],
    });

    const result = await generateTopicCandidates('reel', 1, true, 42, 42);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Grounded fallback topic');
    expect(completeOneShotWithSearch).toHaveBeenCalledTimes(1);
    expect(trackedCreate).toHaveBeenCalledTimes(1);
  });

  it('generates only the missing portion of seven-day pending inventory', () => {
    storeTopicCandidates([
      { title: 'A', niche: 'product', whyNow: 'Now', hookIdea: 'Hook A' },
      { title: 'B', niche: 'product', whyNow: 'Now', hookIdea: 'Hook B' },
      { title: 'C', niche: 'product', whyNow: 'Now', hookIdea: 'Hook C' },
    ], 'reel', 'tuesday_reels', 42, 42);
    storeTopicCandidates([
      { title: 'Other tenant', niche: 'product', whyNow: 'Now', hookIdea: 'Other hook' },
    ], 'reel', 'tuesday_reels', 77, 77);
    const oldId = storeTopicCandidates([
      { title: 'Expired inventory', niche: 'product', whyNow: 'Old', hookIdea: 'Old hook' },
    ], 'reel', 'tuesday_reels', 42, 42)[0];
    testDb.prepare("UPDATE content_topic_feedback SET created_at = datetime('now', '-8 days') WHERE id = ?").run(oldId);

    expect(getMissingScheduledInventoryCount(42, {
      format: 'reel',
      sourceJob: 'tuesday_reels',
      targetCount: 5,
      windowDays: 7,
    })).toBe(2);
  });

  it('builds and stores the Friday package with one validated provider call', async () => {
    completeOneShotWithFallback.mockResolvedValue({
      provider: 'gemini',
      text: JSON.stringify({
        youtube: [
          { title: 'YT A', niche: 'product', whyNow: 'Evergreen A', hookIdea: 'YT hook A', angle_tag: 'comparison', pillar_emoji: '', time_sensitivity: 'evergreen' },
          { title: 'YT B', niche: 'product', whyNow: 'Evergreen B', hookIdea: 'YT hook B', angle_tag: 'framework', pillar_emoji: '', time_sensitivity: 'evergreen' },
        ],
        reels: [
          { title: 'Reel A', niche: 'product', whyNow: 'Evergreen C', hookIdea: 'Reel hook A', angle_tag: 'opinion', pillar_emoji: '', time_sensitivity: 'evergreen' },
          { title: 'Reel B', niche: 'product', whyNow: 'Evergreen D', hookIdea: 'Reel hook B', angle_tag: 'how-to', pillar_emoji: '', time_sensitivity: 'evergreen' },
          { title: 'Reel C', niche: 'product', whyNow: 'Evergreen E', hookIdea: 'Reel hook C', angle_tag: 'story', pillar_emoji: '', time_sensitivity: 'evergreen' },
          { title: 'Reel D', niche: 'product', whyNow: 'Evergreen F', hookIdea: 'Reel hook D', angle_tag: 'myth-bust', pillar_emoji: '', time_sensitivity: 'evergreen' },
        ],
      }),
    });

    const result = await generateWeeklyPackage(42, 42);

    expect(result.youtube).toHaveLength(2);
    expect(result.reels).toHaveLength(4);
    expect(completeOneShotWithFallback).toHaveBeenCalledTimes(1);
    expect(completeOneShotWithFallback.mock.calls[0][2]).toBe('content_workflow_weekly');
    expect(completeOneShotWithFallback.mock.calls[0][4]).toMatchObject({
      model: 'gemini-2.5-flash',
      maxTokens: 1832,
    });
    const rows = testDb.prepare(`
      SELECT format, COUNT(*) AS count
        FROM content_topic_feedback
       WHERE user_id = 42 AND source_job = 'friday_weekly'
       GROUP BY format
       ORDER BY format
    `).all();
    expect(rows).toEqual([
      { format: 'reel', count: 4 },
      { format: 'youtube', count: 2 },
    ]);
  });

  it('persists nothing when the Friday batch is short or violates the live contract', async () => {
    const valid = (title: string) => ({
      title,
      niche: 'product',
      whyNow: 'Evergreen',
      hookIdea: 'Open strong',
      angle_tag: 'framework',
      pillar_emoji: '',
      time_sensitivity: 'evergreen',
    });
    completeOneShotWithFallback.mockResolvedValue({
      provider: 'gemini',
      text: JSON.stringify({
        youtube: [valid('Only one YouTube topic')],
        reels: [valid('Reel A'), valid('Reel B'), valid('Reel C'), valid('')],
      }),
    });

    const result = await generateWeeklyPackage(42, 42);

    expect(result).toEqual({ youtube: [], reels: [] });
    expect(completeOneShotWithFallback).toHaveBeenCalledTimes(1);
    const stored = (testDb.prepare(
      "SELECT COUNT(*) AS count FROM content_topic_feedback WHERE user_id = 42 AND source_job = 'friday_weekly'",
    ).get() as { count: number }).count;
    expect(stored).toBe(0);
  });

  it('rejects the whole Friday package when a topic repeats across formats', async () => {
    const valid = (title: string, angle_tag: string) => ({
      title,
      niche: 'product',
      whyNow: 'Evergreen',
      hookIdea: `Open ${title}`,
      angle_tag,
      pillar_emoji: '',
      time_sensitivity: 'evergreen',
    });
    completeOneShotWithFallback.mockResolvedValue({
      provider: 'gemini',
      text: JSON.stringify({
        youtube: [
          valid('Shared package topic', 'framework'),
          valid('YouTube B', 'comparison'),
        ],
        reels: [
          valid('Shared package topic', 'opinion'),
          valid('Reel B', 'how-to'),
          valid('Reel C', 'story'),
          valid('Reel D', 'myth-bust'),
        ],
      }),
    });

    const result = await generateWeeklyPackage(42, 42);

    expect(result).toEqual({ youtube: [], reels: [] });
    expect(isDuplicateIdeaInBatch).toHaveBeenCalled();
    const stored = (testDb.prepare(
      "SELECT COUNT(*) AS count FROM content_topic_feedback WHERE user_id = 42 AND source_job = 'friday_weekly'",
    ).get() as { count: number }).count;
    expect(stored).toBe(0);
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
