/**
 * Content Learning Store — DB persistence + artifact chain tests.
 *
 * Covers:
 *   1. Script text durable storage
 *   2. Performance feedback persistence (replaces feedback.json)
 *   3. Learned pattern upsert (frequency + example merging)
 *   4. Artifact chain tracing (idea → script → performance → pattern)
 *   5. Voice agent script availability from DB
 *   6. Multi-tenant isolation (user_id scoping)
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
    anthropic: { apiKey: 'test' },
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
  storeScript,
  getRecentScripts,
  getScriptByPipelineId,
  logPerformanceFeedback,
  getPerformanceSummary,
  upsertLearnedPattern,
  getLearnedPatterns,
  getArtifactChain,
} from '../../src/services/content-learning-store';

// ═══════════════════════════════════════════════════════════════════
// 1. Script Text Durable Storage
// ═══════════════════════════════════════════════════════════════════

describe('content-learning-store: script storage', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('storeScript persists raw script text', () => {
    const id = storeScript({
      topic: 'AI for Athletes',
      format: 'youtube',
      scriptText: 'Fala galera, hoje vamos falar sobre...',
      hook: 'Você sabia que 90% dos atletas...',
      titleOptions: ['Title A', 'Title B'],
      sourcesUsed: [{ title: 'Study X', url: 'https://example.com' }],
      hashtags: ['#ai', '#athletes'],
      caption: 'Save this before your next training block.',
      cta: 'Send this to your training partner.',
      estimatedDuration: '8:00-10:00',
      niche: 'tech',
      generationDurationMs: 5000,
      userId: 1,
    });

    expect(id).toBeGreaterThan(0);
  });

  it('getRecentScripts returns stored scripts with full text', () => {
    storeScript({
      topic: 'Test Topic',
      format: 'reel',
      scriptText: 'Full script body here with all the content...',
      hook: 'Opening hook',
      userId: 1,
    });

    const scripts = getRecentScripts(1, 30, 10);
    expect(scripts).toHaveLength(1);
    expect(scripts[0].topic).toBe('Test Topic');
    expect(scripts[0].format).toBe('reel');
    expect(scripts[0].scriptText).toBe('Full script body here with all the content...');
    expect(scripts[0].hook).toBe('Opening hook');
  });

  it('stores packaging lineage alongside the generated script', () => {
    storeScript({
      topic: 'Solo SaaS',
      format: 'youtube',
      scriptText: 'Script text',
      hashtags: ['#buildinpublic', '#saas'],
      caption: 'A sharper caption',
      cta: 'Save this for your next sprint.',
      userId: 1,
    });

    const scripts = getRecentScripts(1, 30, 10);
    expect(scripts[0].hashtags).toEqual(['#buildinpublic', '#saas']);
    expect(scripts[0].caption).toBe('A sharper caption');
    expect(scripts[0].cta).toBe('Save this for your next sprint.');
  });

  it('script text survives independently of file system', () => {
    // Store a script — no file path needed
    storeScript({
      topic: 'Durable Script',
      format: 'youtube',
      scriptText: 'This text is in the DB, not a DOCX file',
      userId: 1,
    });

    // Can retrieve without any filesystem access
    const scripts = getRecentScripts(1, 30, 10);
    expect(scripts[0].scriptText).toContain('This text is in the DB');
  });

  it('scripts are user-scoped', () => {
    storeScript({ topic: 'User 1 Script', format: 'reel', scriptText: 'text1', userId: 1 });
    storeScript({ topic: 'User 2 Script', format: 'reel', scriptText: 'text2', userId: 2 });

    expect(getRecentScripts(1, 30, 10)).toHaveLength(1);
    expect(getRecentScripts(2, 30, 10)).toHaveLength(1);
    expect(getRecentScripts(1, 30, 10)[0].topic).toBe('User 1 Script');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Performance Feedback (replaces feedback.json)
// ═══════════════════════════════════════════════════════════════════

describe('content-learning-store: performance feedback', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('logPerformanceFeedback stores metrics', () => {
    const id = logPerformanceFeedback({
      views: 5000,
      retentionPct: 45.2,
      likes: 300,
      comments: 50,
      subsGained: 20,
      hookUsed: 'Curiosity gap opener',
      selectedTitle: 'How I would build it solo',
      finalCaption: 'A caption that shipped',
      finalCta: 'Follow for the next build log.',
      finalScriptVariant: 'variant-b',
      publishedHashtags: ['#saas', '#buildinpublic'],
      notes: 'Good engagement in first 30s',
      userId: 1,
    });

    expect(id).toBeGreaterThan(0);
  });

  it('getPerformanceSummary aggregates correctly', () => {
    logPerformanceFeedback({ views: 1000, retentionPct: 40, likes: 100, userId: 1 });
    logPerformanceFeedback({ views: 3000, retentionPct: 60, likes: 200, userId: 1 });

    const summary = getPerformanceSummary(1, 30);
    expect(summary.count).toBe(2);
    expect(summary.avgViews).toBe(2000);
    expect(summary.avgRetention).toBe(50);
    expect(summary.totalLikes).toBe(300);
  });

  it('stores packaging decisions in performance lineage', () => {
    logPerformanceFeedback({
      views: 2400,
      retentionPct: 58,
      hookUsed: 'Curiosity',
      selectedTitle: 'What nobody tells you about solo SaaS',
      finalCaption: 'Final shipping caption',
      finalCta: 'Share this with another solo builder.',
      finalScriptVariant: 'variant-a',
      publishedHashtags: ['#product', '#startup'],
      userId: 1,
    });

    const summary = getPerformanceSummary(1, 30);
    expect(summary.entries[0].selectedTitle).toBe('What nobody tells you about solo SaaS');
    expect(summary.entries[0].finalCaption).toBe('Final shipping caption');
    expect(summary.entries[0].finalCta).toBe('Share this with another solo builder.');
    expect(summary.entries[0].finalScriptVariant).toBe('variant-a');
    expect(summary.entries[0].publishedHashtags).toEqual(['#product', '#startup']);
  });

  it('feedback is user-scoped', () => {
    logPerformanceFeedback({ views: 1000, retentionPct: 40, userId: 1 });
    logPerformanceFeedback({ views: 5000, retentionPct: 80, userId: 2 });

    const summary1 = getPerformanceSummary(1, 30);
    const summary2 = getPerformanceSummary(2, 30);
    expect(summary1.count).toBe(1);
    expect(summary2.count).toBe(1);
    expect(summary1.avgViews).toBe(1000);
    expect(summary2.avgViews).toBe(5000);
  });

  it('feedback.json is no longer needed', () => {
    // The canonical store is SQLite, not the JSON file.
    // Verify the DB path works without any JSON file.
    logPerformanceFeedback({ views: 100, retentionPct: 50, userId: 1 });
    const summary = getPerformanceSummary(1, 30);
    expect(summary.count).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Learned Patterns (durable, survive signal expiry)
// ═══════════════════════════════════════════════════════════════════

describe('content-learning-store: learned patterns', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('upsertLearnedPattern creates new pattern', () => {
    upsertLearnedPattern({
      category: 'voice_addition',
      patternText: 'Felipe adds personal anecdotes to every script',
      examples: ['Na minha experiência...', 'Eu lembro que uma vez...'],
      confidence: 0.85,
      sourceAgent: 'voice-evolution',
      userId: 0,
    });

    const patterns = getLearnedPatterns(0, 'voice_addition');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].patternText).toContain('personal anecdotes');
    expect(patterns[0].confidence).toBe(0.85);
    expect(patterns[0].frequency).toBe(1);
    expect(patterns[0].examples).toHaveLength(2);
  });

  it('upsertLearnedPattern increments frequency on re-detection', () => {
    upsertLearnedPattern({
      category: 'voice_addition',
      patternText: 'Same pattern detected again',
      examples: ['Example 1'],
      confidence: 0.7,
      sourceAgent: 'voice-evolution',
      userId: 0,
    });

    upsertLearnedPattern({
      category: 'voice_addition',
      patternText: 'Same pattern detected again',
      examples: ['Example 2'],
      confidence: 0.9,
      sourceAgent: 'voice-evolution',
      userId: 0,
    });

    const patterns = getLearnedPatterns(0, 'voice_addition');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].frequency).toBe(2);
    // Confidence should be MAX(0.7, 0.9) = 0.9
    expect(patterns[0].confidence).toBe(0.9);
    // Examples should be merged and deduplicated
    expect(patterns[0].examples).toContain('Example 1');
    expect(patterns[0].examples).toContain('Example 2');
  });

  it('patterns are filterable by category', () => {
    upsertLearnedPattern({ category: 'voice_addition', patternText: 'adds A', userId: 0 });
    upsertLearnedPattern({ category: 'voice_removal', patternText: 'removes B', userId: 0 });
    upsertLearnedPattern({ category: 'hook_pattern', patternText: 'hook C', userId: 0 });

    expect(getLearnedPatterns(0, 'voice_addition')).toHaveLength(1);
    expect(getLearnedPatterns(0, 'voice_removal')).toHaveLength(1);
    expect(getLearnedPatterns(0)).toHaveLength(3);
  });

  it('prefers user learned patterns over system rows with the same content key', () => {
    upsertLearnedPattern({ category: 'voice_addition', patternText: 'shared pattern', userId: 0 });
    upsertLearnedPattern({ category: 'voice_addition', patternText: 'shared pattern', userId: 42 });

    const patterns = getLearnedPatterns(42, 'voice_addition');

    expect(patterns).toHaveLength(1);
    expect(patterns[0].userId).toBe(42);
    expect(patterns[0].patternText).toBe('shared pattern');
  });

  it('patterns never expire (unlike bus signals)', () => {
    // Bus signals have TTL (90 days). Patterns in the DB don't expire.
    // We can't fast-forward time in SQLite, but we verify there's no
    // expiry column or WHERE clause.
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/content-learning-store.ts'),
      'utf8',
    );

    // getLearnedPatterns should NOT have any date/expiry filter
    const getPatternsFn = source.slice(
      source.indexOf('export function getLearnedPatterns'),
      source.indexOf('}', source.indexOf('export function getLearnedPatterns') + 200) + 1,
    );
    expect(getPatternsFn).not.toContain('expires');
    expect(getPatternsFn).not.toContain('datetime');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Artifact Chain Tracing
// ═══════════════════════════════════════════════════════════════════

describe('content-learning-store: artifact chain', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('traces full chain from pipeline to script and performance', () => {
    // Create topic feedback
    testDb.prepare(`
      INSERT INTO content_topic_feedback (topic, niche, format, sentiment, source_job, hook_idea, why_now, user_id)
      VALUES ('AI Fitness', 'tech', 'youtube', 'approved', 'manual', 'Best hook', 'Trending now', 0)
    `).run();
    const feedbackId = (testDb.prepare('SELECT last_insert_rowid() as id').get() as any).id;

    // Create pipeline entry
    testDb.prepare(`
      INSERT INTO content_pipeline (topic_feedback_id, topic_title, niche, stage, script_path)
      VALUES (?, 'AI Fitness', 'tech', 'scripted', '/path/to/script.docx')
    `).run(feedbackId);
    const pipelineId = (testDb.prepare('SELECT last_insert_rowid() as id').get() as any).id;

    // Store script text
    storeScript({
      pipelineId,
      topicFeedbackId: feedbackId,
      topic: 'AI Fitness',
      format: 'youtube',
      scriptText: 'Full script text here...',
      hook: 'Opening hook about AI',
      titleOptions: ['Title 1', 'Title 2'],
      hashtags: ['#ai', '#fitness'],
      caption: 'Pipeline caption',
      cta: 'Pipeline CTA',
      userId: 0,
    });

    // Log performance
    logPerformanceFeedback({
      pipelineId,
      views: 10000,
      retentionPct: 55,
      likes: 800,
      userId: 0,
    });

    // Trace the chain
    const chain = getArtifactChain(pipelineId);

    expect(chain.topicFeedback).not.toBeNull();
    expect(chain.topicFeedback!.topic).toBe('AI Fitness');
    expect(chain.topicFeedback!.sentiment).toBe('approved');

    expect(chain.pipeline).not.toBeNull();
    expect(chain.pipeline!.stage).toBe('scripted');

    expect(chain.script).not.toBeNull();
    expect(chain.script!.scriptText).toBe('Full script text here...');
    expect(chain.script!.hook).toBe('Opening hook about AI');
    expect(chain.script!.titleOptions).toEqual(['Title 1', 'Title 2']);
    expect(chain.script!.hashtags).toEqual(['#ai', '#fitness']);
    expect(chain.script!.caption).toBe('Pipeline caption');
    expect(chain.script!.cta).toBe('Pipeline CTA');

    expect(chain.performance).toHaveLength(1);
    expect(chain.performance[0].views).toBe(10000);
  });

  it('returns empty chain for non-existent pipeline', () => {
    const chain = getArtifactChain(99999);
    expect(chain.pipeline).toBeNull();
    expect(chain.script).toBeNull();
    expect(chain.performance).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Voice Agent Script Availability
// ═══════════════════════════════════════════════════════════════════

describe('content-learning-store: voice agent access', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('voice agent can read full script text from DB (not DOCX)', () => {
    storeScript({
      topic: 'Voice Test Script',
      format: 'youtube',
      scriptText: 'This is the full 3000-word script that the voice agent can now read directly from the DB instead of trying to parse a DOCX file.',
      userId: 0,
    });

    // This is exactly what the voice-evolution-agent now does:
    const scripts = getRecentScripts(0, 30, 10);

    expect(scripts).toHaveLength(1);
    expect(scripts[0].scriptText).toContain('3000-word script');
    // The text is the real content, not "[Script file: ...]"
    expect(scripts[0].scriptText).not.toContain('[Script file:');
  });

  it('voice agent reads scripts within time window', () => {
    storeScript({ topic: 'Recent', format: 'reel', scriptText: 'recent text', userId: 0 });

    // Should find within 30 days
    expect(getRecentScripts(0, 30, 10)).toHaveLength(1);
    // Should find within 1 day
    expect(getRecentScripts(0, 1, 10)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Source Code Structural Checks
// ═══════════════════════════════════════════════════════════════════

describe('content-learning-store: structural', () => {
  it('voice-evolution-agent reads from content_scripts DB', () => {
    const agentSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/agents/voice-evolution-agent.ts'),
      'utf8',
    );

    // Should import getRecentScripts
    expect(agentSource).toContain('getRecentScripts');
    expect(agentSource).toContain('content-learning-store');
    expect(agentSource).toContain('getOwnerBootstrapTarget');
    expect(agentSource).not.toContain('getRecentScripts(0');
  });

  it('voice-evolution-agent persists patterns durably', () => {
    const agentSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/agents/voice-evolution-agent.ts'),
      'utf8',
    );

    expect(agentSource).toContain('upsertLearnedPattern');
    expect(agentSource).toContain('content-learning-store');
  });

  it('content-workflow stores script text after generation', () => {
    const workflowSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/content-workflow.ts'),
      'utf8',
    );

    expect(workflowSource).toContain('storeScript');
    expect(workflowSource).toContain('content-learning-store');
  });

  it('feedback.json has been fully removed from Python backend', () => {
    const feedbackSource = fs.readFileSync(
      path.resolve(__dirname, '../../content-engine/services/learning/feedback_loop.py'),
      'utf8',
    );

    // feedback.json path has been fully removed (April 2026)
    // The module now relies on the TS backend's content_performance table
    expect(feedbackSource).not.toContain('FEEDBACK_FILE');
    expect(feedbackSource).not.toContain('def _load_history');
    expect(feedbackSource).not.toContain('def _save_history');
    expect(feedbackSource).toContain('content_performance');
  });

  it('migration 059 creates all three learning tables', () => {
    const migrationSource = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/059_content_learning_store.sql'),
      'utf8',
    );

    expect(migrationSource).toContain('CREATE TABLE IF NOT EXISTS content_scripts');
    expect(migrationSource).toContain('CREATE TABLE IF NOT EXISTS content_performance');
    expect(migrationSource).toContain('CREATE TABLE IF NOT EXISTS content_learned_patterns');
  });
});
