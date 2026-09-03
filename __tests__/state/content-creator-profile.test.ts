/**
 * CONTENT-UI-O1 (2026-05-04): unified per-tenant ContentCreatorProfile.
 *
 * Verifies the SQLite state helper round-trips all 13 fields, partitions
 * by (tenant_id, owner_user_id), refuses cross-tenant reads, sanitizes
 * incoming arrays/strings (length caps + non-string filtering), and
 * computes the same completeness function as the iOS Codable struct.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: { app: { timezone: 'Europe/Lisbon' } },
}));

import {
  getContentCreatorProfile,
  upsertContentCreatorProfile,
  resetContentCreatorProfile,
  computeContentCreatorProfileCompleteness,
  sanitizeContentCreatorProfile,
  ContentCreatorProfile,
} from '../../src/state/content-creator-profile';


const USER_A = 1001;
const USER_B = 1002;

describe('content-creator-profile (CONTENT-UI-O1)', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => {
    if (testDb) testDb.close();
  });

  // ─────────────────── Round-trip ───────────────────

  it('returns the empty profile when no row exists', () => {
    const p = getContentCreatorProfile(USER_A);
    expect(p.pillars).toEqual([]);
    expect(p.audience).toBe('');
    expect(p.platforms).toEqual([]);
    expect(p.languagePreference).toBe('');
    expect(p.updatedAt).toBeNull();
  });

  it('surfaces scoped profile storage failure instead of returning a neutral profile', () => {
    testDb.exec('DROP TABLE content_creator_profile');

    expect(() => getContentCreatorProfile(USER_A, USER_A)).toThrow(expect.objectContaining({
      code: 'CONTENT_CREATOR_PROFILE_UNAVAILABLE',
      status: 503,
    }));
  });

  it.each([
    ['pillars_json', '{not-json'],
    ['niches_json', '{"not":"an-array"}'],
    ['voice_rules_json', '["valid",7]'],
    ['platforms_json', '[{"name":"YouTube"}]'],
  ])('withholds an active profile with malformed stored %s', (column, malformedValue) => {
    upsertContentCreatorProfile(USER_A, USER_A, { pillars: ['Preserved'] });
    testDb.prepare(`UPDATE content_creator_profile SET ${column} = ? WHERE owner_user_id = ?`)
      .run(malformedValue, USER_A);

    expect(() => getContentCreatorProfile(USER_A, USER_A)).toThrow(expect.objectContaining({
      code: 'CONTENT_CREATOR_PROFILE_UNAVAILABLE',
      status: 503,
    }));
    expect(testDb.prepare(`SELECT ${column} AS value FROM content_creator_profile WHERE owner_user_id = ?`)
      .get(USER_A)).toEqual({ value: malformedValue });
  });

  it.each([
    { pillars: 'not-an-array' },
    { audience: [] },
    { platforms: {} },
    { unknownField: 'ignored-before-this-contract' },
    {},
  ])('rejects malformed partial updates without writing them: %j', (patch) => {
    upsertContentCreatorProfile(USER_A, USER_A, { pillars: ['Preserved'] });

    expect(() => upsertContentCreatorProfile(USER_A, USER_A, patch as any)).toThrow(
      expect.objectContaining({ code: 'CONTENT_CREATOR_PROFILE_INVALID', status: 400 }),
    );
    expect(getContentCreatorProfile(USER_A, USER_A).pillars).toEqual(['Preserved']);
  });

  it('round-trips all 13 fields end-to-end', () => {
    const written = upsertContentCreatorProfile(USER_A, USER_A, {
      pillars: ['AI automation', 'Marathon training'],
      niches: ['Indie creator stack'],
      audience: 'Indie devs and self-coached marathon trainees',
      platforms: [
        { name: 'YouTube', cadence: '1x/week', enabled: true },
        { name: 'LinkedIn', cadence: '2x/week', enabled: true },
      ],
      voiceRules: ['Short sentences. Active voice.', 'No hype words.'],
      preferredFormats: ['Tutorial walkthrough'],
      dislikedTopics: ['Shallow motivation'],
      bannedTopics: ['Hustle culture endorsements'],
      trustedSources: ['Anthropic Docs'],
      dislikedSources: ['Unverified Twitter threads'],
      contentGoals: ['Build authority with intermediate creators'],
      languagePreference: 'en',
      voiceExamples: ['Most creator stacks are 80% noise. Here\'s the 4 I run.'],
    });
    expect(written.pillars).toEqual(['AI automation', 'Marathon training']);
    expect(written.audience).toBe('Indie devs and self-coached marathon trainees');
    expect(written.platforms).toHaveLength(2);
    expect(written.platforms[0]).toEqual({ name: 'YouTube', cadence: '1x/week', enabled: true });
    expect(written.languagePreference).toBe('en-US');

    const read = getContentCreatorProfile(USER_A, USER_A);
    expect(read).toEqual(expect.objectContaining({
      pillars: ['AI automation', 'Marathon training'],
      niches: ['Indie creator stack'],
      audience: 'Indie devs and self-coached marathon trainees',
      voiceRules: ['Short sentences. Active voice.', 'No hype words.'],
      preferredFormats: ['Tutorial walkthrough'],
      dislikedTopics: ['Shallow motivation'],
      bannedTopics: ['Hustle culture endorsements'],
      trustedSources: ['Anthropic Docs'],
      dislikedSources: ['Unverified Twitter threads'],
      contentGoals: ['Build authority with intermediate creators'],
      languagePreference: 'en-US',
      voiceExamples: ['Most creator stacks are 80% noise. Here\'s the 4 I run.'],
    }));
    expect(read.updatedAt).not.toBeNull();
  });

  it('upsert merges patch with existing fields (only patched fields change)', () => {
    upsertContentCreatorProfile(USER_A, USER_A, {
      pillars: ['Initial'],
      audience: 'Initial audience',
    });
    const after = upsertContentCreatorProfile(USER_A, USER_A, {
      pillars: ['Updated'],
    });
    expect(after.pillars).toEqual(['Updated']);
    expect(after.audience).toBe('Initial audience'); // preserved
  });

  // ─────────────────── Tenant isolation ───────────────────

  it('User A profile is invisible from User B scope', () => {
    upsertContentCreatorProfile(USER_A, USER_A, {
      pillars: ['AI'],
      audience: 'A audience',
    });
    upsertContentCreatorProfile(USER_B, USER_B, {
      pillars: ['Cooking'],
      audience: 'B audience',
    });

    const a = getContentCreatorProfile(USER_A, USER_A);
    const b = getContentCreatorProfile(USER_B, USER_B);

    expect(a.pillars).toEqual(['AI']);
    expect(a.audience).toBe('A audience');
    expect(b.pillars).toEqual(['Cooking']);
    expect(b.audience).toBe('B audience');
  });

  it('User B with no profile reads the empty profile, NOT User A data', () => {
    upsertContentCreatorProfile(USER_A, USER_A, {
      pillars: ['Sensitive A pillar'],
      audience: 'Sensitive A audience',
    });
    const b = getContentCreatorProfile(USER_B, USER_B);
    expect(b.pillars).toEqual([]);
    expect(b.audience).toBe('');
    expect(b.audience).not.toBe('Sensitive A audience');
  });

  it('different tenant_id under same user_id is also isolated', () => {
    // Same user, different tenants — distinct profiles.
    upsertContentCreatorProfile(USER_A, /*tenantId*/ 5000, {
      pillars: ['Tenant 5000'],
    });
    upsertContentCreatorProfile(USER_A, /*tenantId*/ 6000, {
      pillars: ['Tenant 6000'],
    });
    expect(getContentCreatorProfile(USER_A, 5000).pillars).toEqual(['Tenant 5000']);
    expect(getContentCreatorProfile(USER_A, 6000).pillars).toEqual(['Tenant 6000']);
  });

  // ─────────────────── Sanitization ───────────────────

  it('sanitizes non-string array entries', () => {
    const sanitized = sanitizeContentCreatorProfile({
      pillars: ['valid', null, 42, '', '   ', { fake: 'object' }, 'second'],
    });
    expect(sanitized.pillars).toEqual(['valid', 'second']);
  });

  it('caps array length at 50 items per field', () => {
    const tooMany = Array.from({ length: 200 }, (_, i) => `item-${i}`);
    const sanitized = sanitizeContentCreatorProfile({ pillars: tooMany });
    expect(sanitized.pillars).toHaveLength(50);
  });

  it('caps individual string length to prevent abuse', () => {
    const bigBlob = 'a'.repeat(5000);
    const sanitized = sanitizeContentCreatorProfile({ audience: bigBlob });
    expect(sanitized.audience.length).toBeLessThanOrEqual(1500);
  });

  it.each([
    ['en', 'en-US'],
    ['English', 'en-US'],
    ['pt', 'pt-BR'],
    ['Brazilian Portuguese', 'pt-BR'],
    ['pt-PT', 'pt-PT'],
    ['European Portuguese', 'pt-PT'],
    ['es-419', 'en-US'],
    ['Spanish', 'en-US'],
    ['Español', 'en-US'],
    ['fr-FR', 'en-US'],
  ])('canonicalizes creator output language %s to %s on writes', (input, expected) => {
    const sanitized = sanitizeContentCreatorProfile({ languagePreference: input });
    expect(sanitized.languagePreference).toBe(expected);
  });

  it('persists only the canonical output language on a new profile write', () => {
    upsertContentCreatorProfile(USER_A, USER_A, {
      languagePreference: 'Spanish',
    });

    const raw = testDb.prepare(`
      SELECT language_preference
        FROM content_creator_profile
       WHERE tenant_id = ? AND owner_user_id = ?
    `).get(USER_A, USER_A) as { language_preference: string };
    expect(raw.language_preference).toBe('en-US');
  });

  it('projects a historical Spanish language preference to English without rewriting the row', () => {
    upsertContentCreatorProfile(USER_A, USER_A, {
      pillars: ['Historical'],
      languagePreference: 'pt-BR',
    });
    testDb.prepare(`
      UPDATE content_creator_profile
         SET language_preference = 'es-419'
       WHERE tenant_id = ? AND owner_user_id = ?
    `).run(USER_A, USER_A);

    expect(getContentCreatorProfile(USER_A, USER_A).languagePreference).toBe('en-US');
    const raw = testDb.prepare(`
      SELECT language_preference
        FROM content_creator_profile
       WHERE tenant_id = ? AND owner_user_id = ?
    `).get(USER_A, USER_A) as { language_preference: string };
    expect(raw.language_preference).toBe('es-419');
  });

  it('rejects platform entries without a name', () => {
    const sanitized = sanitizeContentCreatorProfile({
      platforms: [
        { name: '', cadence: '1x/week', enabled: true },
        { cadence: 'no name', enabled: true } as any,
        { name: 'YouTube', cadence: '', enabled: false },
      ],
    });
    expect(sanitized.platforms).toHaveLength(1);
    expect(sanitized.platforms[0].name).toBe('YouTube');
  });

  // ─────────────────── Reset ───────────────────

  it('reset archives the profile (subsequent reads are empty)', () => {
    upsertContentCreatorProfile(USER_A, USER_A, {
      pillars: ['Pre-reset'],
    });
    expect(getContentCreatorProfile(USER_A, USER_A).pillars).toEqual(['Pre-reset']);
    resetContentCreatorProfile(USER_A, USER_A);
    expect(getContentCreatorProfile(USER_A, USER_A).pillars).toEqual([]);
  });

  it('upsert after reset reactivates the archived singleton with the new profile', () => {
    upsertContentCreatorProfile(USER_A, USER_A, {
      pillars: ['Pre-reset'],
      audience: 'Pre-reset audience',
    });
    resetContentCreatorProfile(USER_A, USER_A);

    const after = upsertContentCreatorProfile(USER_A, USER_A, {
      pillars: ['Reactivated'],
      audience: 'New profile audience',
    });

    expect(after.pillars).toEqual(['Reactivated']);
    expect(after.audience).toBe('New profile audience');
    expect(getContentCreatorProfile(USER_A, USER_A)).toEqual(expect.objectContaining({
      pillars: ['Reactivated'],
      audience: 'New profile audience',
    }));
    expect(testDb.prepare(`
      SELECT scope_status, visibility_scope, lifecycle_state
        FROM content_creator_profile
       WHERE tenant_id = ? AND owner_user_id = ?
    `).get(USER_A, USER_A)).toEqual({
      scope_status: 'active',
      visibility_scope: 'user_private',
      lifecycle_state: 'active',
    });
  });

  it('reset only affects the same (tenant, owner); other tenant is preserved', () => {
    upsertContentCreatorProfile(USER_A, USER_A, { pillars: ['Keep'] });
    upsertContentCreatorProfile(USER_B, USER_B, { pillars: ['Untouched'] });
    resetContentCreatorProfile(USER_A, USER_A);
    expect(getContentCreatorProfile(USER_A, USER_A).pillars).toEqual([]);
    expect(getContentCreatorProfile(USER_B, USER_B).pillars).toEqual(['Untouched']);
  });

  // ─────────────────── Completeness math ───────────────────

  it('completeness is 0 for an empty profile', () => {
    expect(computeContentCreatorProfileCompleteness({
      pillars: [], niches: [], audience: '', platforms: [],
      voiceRules: [], preferredFormats: [], dislikedTopics: [],
      bannedTopics: [], trustedSources: [], dislikedSources: [],
      contentGoals: [], languagePreference: '', voiceExamples: [],
    })).toBe(0);
  });

  it('completeness is 1 for a fully populated profile', () => {
    const full: ContentCreatorProfile = {
      pillars: ['p'], niches: ['n'], audience: 'a',
      platforms: [{ name: 'YT', cadence: 'wk', enabled: true }],
      voiceRules: ['vr'], preferredFormats: ['pf'],
      dislikedTopics: ['dt'], bannedTopics: ['bt'],
      trustedSources: ['ts'], dislikedSources: ['ds'],
      contentGoals: ['cg'], languagePreference: 'en',
      voiceExamples: ['ex'],
    };
    expect(computeContentCreatorProfileCompleteness(full)).toBeCloseTo(1, 5);
  });

  it('pillars carry more weight than preferred formats', () => {
    const onlyPillars: ContentCreatorProfile = {
      pillars: ['p'], niches: [], audience: '', platforms: [],
      voiceRules: [], preferredFormats: [], dislikedTopics: [],
      bannedTopics: [], trustedSources: [], dislikedSources: [],
      contentGoals: [], languagePreference: '', voiceExamples: [],
    };
    const onlyFormats: ContentCreatorProfile = {
      ...onlyPillars,
      pillars: [], preferredFormats: ['fmt'],
    };
    expect(computeContentCreatorProfileCompleteness(onlyPillars))
      .toBeGreaterThan(computeContentCreatorProfileCompleteness(onlyFormats));
  });
});
