import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

import { getContentCreatorProfile, upsertContentCreatorProfile } from '../../src/state/content-creator-profile';
import { buildContentCreativeProfileContext } from '../../src/services/content-memory-profile';
import {
  buildCreatorVoiceBrandCardV2,
  evaluateVoiceBrandQuality,
} from '../../src/services/content-voice-brand-card';

describe('Creator voice brand card v2', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('scores an empty profile low and reports missing voice keys', () => {
    const profile = getContentCreatorProfile(501, 501);
    const memoryContext = buildContentCreativeProfileContext({ userId: 501, tenantId: 501 });
    const quality = evaluateVoiceBrandQuality(profile, memoryContext, {
      audienceSegments: [],
      contentPillars: [],
      toneRules: [],
      proofLibrary: [],
      phrasesToAvoid: [],
      formatPreferences: [],
    });

    expect(quality.completenessScore).toBe(0);
    expect(quality.specificityScore).toBeLessThan(30);
    expect(quality.missingCriticalKeys).toEqual(expect.arrayContaining([
      'brand.audience_specificity',
      'brand.content_pillars',
      'voice.tone',
      'brand.proof_library',
    ]));
  });

  it('builds a richer card from profile data and separates banned topics from banned phrases', () => {
    upsertContentCreatorProfile(501, 501, {
      audience: 'Hybrid operators building source-backed creator businesses',
      pillars: ['brand voice systems', 'research-backed script production'],
      voiceRules: ['Direct, practical, evidence-led', 'Warm but not hype-driven'],
      preferredFormats: ['youtube_long_form', 'linkedin_post'],
      bannedTopics: ['political hot takes'],
      dislikedTopics: ['daily routine hacks'],
      trustedSources: ['creator analytics dashboard', 'approved case studies'],
      contentGoals: ['Turn research into useful scripts'],
      voiceExamples: ['Most creator advice collapses because nobody checks the source trail.'],
      languagePreference: 'en',
    });

    const card = buildCreatorVoiceBrandCardV2({
      userId: 501,
      tenantId: 501,
      language: 'en',
      platform: 'youtube',
    });

    expect(card.quality.completenessScore).toBeGreaterThan(80);
    expect(card.quality.missingCriticalKeys).not.toContain('brand.content_pillars');
    expect(card.quality.missingCriticalKeys).not.toContain('voice.tone');
    expect(card.contentPillars).toEqual(expect.arrayContaining(['brand voice systems']));
    expect(card.bannedTopics).toEqual(expect.arrayContaining(['political hot takes', 'daily routine hacks']));
    expect(card.phrasesToAvoid).not.toContain('political hot takes');
    expect(card.phrasesToAvoid).not.toContain('daily routine hacks');
    expect(card.voiceFitCriteria.phrasesToAvoid).not.toContain('political hot takes');
    expect(card.promptText).toContain('Avoid topics or angles: political hot takes; daily routine hacks');
  });

  it('warns on generic audience and conflicting voice rules', () => {
    upsertContentCreatorProfile(777, 777, {
      audience: 'creators',
      pillars: ['content'],
      voiceRules: ['formal executive tone', 'casual humor in every paragraph'],
      trustedSources: ['approved notes'],
    });

    const card = buildCreatorVoiceBrandCardV2({
      userId: 777,
      tenantId: 777,
      language: 'en',
    });

    expect(card.quality.missingCriticalKeys).toContain('brand.audience_specificity');
    expect(card.quality.warnings).toContain('voice_rules_may_conflict');
    expect(card.quality.specificityScore).toBeLessThan(75);
  });
});
