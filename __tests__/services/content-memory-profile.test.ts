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

import {
  applyContentMemoryCorrection,
  buildContentCreativeProfileContext,
  filterContentSuggestionsWithMemory,
  markContentCreativeMemoryStaleForVersion,
  recordContentPerformanceMemory,
  upsertContentBrandProfile,
  upsertContentVoiceProfile,
} from '../../src/services/content-memory-profile';

describe('Content memory and voice profile', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('keeps tenant A voice profile out of tenant B profile context', () => {
    upsertContentVoiceProfile({
      tenantId: 101,
      userId: 501,
      tone: 'Direct operator voice for Tenant A.',
      source: 'voice_dna',
      confidence: 0.91,
    });
    upsertContentVoiceProfile({
      tenantId: 202,
      userId: 501,
      tone: 'Warm community voice for Tenant B.',
      source: 'voice_dna',
      confidence: 0.9,
    });

    const tenantB = buildContentCreativeProfileContext({ tenantId: 202, userId: 501 });

    expect(tenantB.contextBlock).toContain('Warm community voice for Tenant B.');
    expect(tenantB.contextBlock).not.toContain('Tenant A');
  });

  it('omits user-private creative preferences from tenant-shared output unless explicitly allowed', () => {
    upsertContentVoiceProfile({
      tenantId: 501,
      userId: 501,
      scope: 'user_private',
      tone: 'Felipe private spicy draft style.',
      source: 'user_preference',
    });
    upsertContentBrandProfile({
      tenantId: 501,
      userId: 501,
      scope: 'tenant_shared',
      audience: ['operators and founders'],
      contentPillars: ['systems'],
      positioning: 'Calm execution intelligence.',
      source: 'brand_profile',
    });

    const restricted = buildContentCreativeProfileContext({
      tenantId: 501,
      userId: 501,
      outputVisibilityScope: 'tenant_shared',
    });
    const allowed = buildContentCreativeProfileContext({
      tenantId: 501,
      userId: 501,
      outputVisibilityScope: 'tenant_shared',
      allowUserPrivateForTenantShared: true,
    });

    expect(restricted.contextBlock).toContain('operators and founders');
    expect(restricted.contextBlock).not.toContain('Felipe private spicy draft style');
    expect(restricted.omittedPrivateMemoryKeys).toContain('voice.tone');
    expect(restricted.warnings).toContain('user_private_memory_omitted_for_tenant_shared_output');
    expect(allowed.contextBlock).toContain('Felipe private spicy draft style');
  });

  it('applies user corrections over older voice memory', () => {
    upsertContentVoiceProfile({
      tenantId: 101,
      userId: 501,
      directness: 'Use a soft and indirect tone.',
      source: 'onboarding',
      confidence: 0.65,
    });

    const corrected = applyContentMemoryCorrection({
      tenantId: 101,
      userId: 501,
      memoryKey: 'voice.directness',
      correctedValue: 'Use a more direct tone.',
      source: 'user_said_use_more_direct_tone',
    });
    const context = buildContentCreativeProfileContext({ tenantId: 101, userId: 501 });

    expect(corrected.freshnessStatus).toBe('corrected');
    expect(context.contextBlock).toContain('Use a more direct tone.');
    expect(context.contextBlock).not.toContain('soft and indirect');
  });

  it('downgrades stale version memory so old voice does not override the current profile', () => {
    upsertContentVoiceProfile({
      tenantId: 101,
      userId: 501,
      tone: 'Old hype-heavy style.',
      source: 'legacy_voice_profile',
      relatedSkillVersion: '2.0.0',
    });
    expect(buildContentCreativeProfileContext({ tenantId: 101, userId: 501 }).contextBlock)
      .toContain('Old hype-heavy style.');

    const changed = markContentCreativeMemoryStaleForVersion({
      tenantId: 101,
      relatedSkillVersion: '3.0.0',
      reason: 'major content voice profile upgrade',
    });

    expect(changed).toBe(1);
    const context = buildContentCreativeProfileContext({ tenantId: 101, userId: 501 });
    expect(context.contextBlock).not.toContain('Old hype-heavy style.');
  });

  it('applies platform-specific voice without leaking another platform style', () => {
    upsertContentVoiceProfile({
      tenantId: 101,
      userId: 501,
      tone: 'Default practical voice.',
      platformVoice: {
        youtube: 'YouTube style uses stronger narrative setup.',
        linkedin: 'LinkedIn style is concise and professional.',
      },
      source: 'voice_profile',
    });

    const context = buildContentCreativeProfileContext({ tenantId: 101, userId: 501, platform: 'youtube' });

    expect(context.contextBlock).toContain('Default practical voice.');
    expect(context.contextBlock).toContain('YouTube style uses stronger narrative setup.');
    expect(context.contextBlock).not.toContain('LinkedIn style is concise and professional.');
  });

  it('avoids disliked formats and rejected topics when scoring content suggestions', () => {
    upsertContentBrandProfile({
      tenantId: 501,
      userId: 501,
      dislikedFormats: ['carousel'],
      topicsToAvoid: ['daily routine hacks'],
      source: 'brand_profile',
    });
    recordContentPerformanceMemory({
      tenantId: 501,
      userId: 501,
      rejectedPatterns: ['generic productivity'],
      source: 'editorial_review',
    });
    const context = buildContentCreativeProfileContext({ tenantId: 501, userId: 501 });

    const suggestions = filterContentSuggestionsWithMemory([
      { id: 'a', title: 'Daily routine hacks for creators', format: 'youtube' },
      { id: 'b', title: 'Generic productivity carousel', format: 'carousel' },
      { id: 'c', title: 'Build a content operating system', format: 'youtube' },
    ], context);

    expect(suggestions.map((suggestion) => suggestion.id)).toEqual(['c']);
  });

  it('boosts suggestions that match successful content patterns', () => {
    recordContentPerformanceMemory({
      tenantId: 501,
      userId: 501,
      successfulTopics: ['content operating system'],
      successfulFormats: ['youtube'],
      successfulHooks: ['stop losing ideas'],
      source: 'performance_review',
      confidence: 0.84,
    });
    const context = buildContentCreativeProfileContext({ tenantId: 501, userId: 501 });

    const suggestions = filterContentSuggestionsWithMemory([
      {
        id: 'strong',
        title: 'Build a content operating system',
        topic: 'content operating system',
        format: 'youtube',
        hook: 'Stop losing ideas in notes apps',
      },
      {
        id: 'plain',
        title: 'Random creator Q&A',
        format: 'newsletter',
      },
    ], context);

    expect(suggestions[0]).toMatchObject({
      id: 'strong',
      score: 1.85,
      reasonCodes: expect.arrayContaining([
        'matches_successful_topic_memory',
        'matches_successful_format_memory',
        'matches_successful_hook_memory',
      ]),
    });
  });

  it('asks targeted follow-ups when critical brand/voice profile data is missing', () => {
    const context = buildContentCreativeProfileContext({ tenantId: 101, userId: 501, platform: 'youtube' });

    expect(context.quality.completenessScore).toBe(0);
    expect(context.followUpQuestions).toEqual(expect.arrayContaining([
      'What tone should Content Creation default to for this creator or brand?',
      'Who is the primary audience for this content?',
    ]));
  });
});
