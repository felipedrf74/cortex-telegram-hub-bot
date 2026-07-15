/**
 * Phase 2 Slice B — Sport-specific onboarding tests
 *
 * Locks in:
 *  - The 4 new sport questionnaires exist with the right step counts
 *  - Each sport sheet maps to the triathlon skill via SKILL_ONBOARDING_MAP
 *  - `renderProfile` produces the expected prompt-friendly block
 *  - `formatAthleteProfileBlock` aggregates multiple profiles, filters
 *    out unrelated ones (diet), sorts deterministically, and returns
 *    empty string when no profiles exist
 *  - Empty / "none" / "0" values are suppressed for prompt cleanliness
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [111111] },
    app: { timezone: 'Europe/Lisbon' },
  },
}));


import {
  QUESTIONNAIRES,
  SKILL_ONBOARDING_MAP,
  QUESTIONNAIRE_SKILL_MAP,
  getQuestionnaire,
  getAllQuestionnaires,
  renderProfile,
  formatAthleteProfileBlock,
  type UserProfile,
} from '../../src/services/onboarding';

// ─── Helpers ────────────────────────────────────────────────────────

function insertProfile(userId: number, profileType: string, data: Record<string, string>) {
  testDb.prepare(`
    INSERT INTO user_profiles (user_id, profile_type, data)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, profile_type) DO UPDATE SET data = excluded.data
  `).run(userId, profileType, JSON.stringify(data));
}

// ─── Questionnaire definitions ──────────────────────────────────────

describe('Phase 2 Slice B — sport questionnaire definitions', () => {
  const sports = ['triathlon-gym', 'triathlon-running', 'triathlon-cycling', 'triathlon-swim'] as const;

  for (const sport of sports) {
    it(`${sport} exists in QUESTIONNAIRES`, () => {
      expect(QUESTIONNAIRES[sport]).toBeDefined();
      expect(getQuestionnaire(sport)).toBeDefined();
    });

    it(`${sport} has 5-10 steps per Phase 1 decision 1.5`, () => {
      const q = QUESTIONNAIRES[sport];
      expect(q.steps.length).toBeGreaterThanOrEqual(5);
      expect(q.steps.length).toBeLessThanOrEqual(10);
    });

    it(`${sport} has a non-empty title and description`, () => {
      const q = QUESTIONNAIRES[sport];
      expect(q.title.length).toBeGreaterThan(0);
      expect(q.description.length).toBeGreaterThan(0);
    });

    it(`${sport} step keys are unique within the questionnaire`, () => {
      const q = QUESTIONNAIRES[sport];
      const keys = q.steps.map((s) => s.key);
      const unique = new Set(keys);
      expect(unique.size).toBe(keys.length);
    });

    it(`${sport} is reverse-mapped back to triathlon`, () => {
      expect(QUESTIONNAIRE_SKILL_MAP[sport]).toBe('triathlon');
    });
  }

  it('gym questionnaire asks for all three big lifts', () => {
    const q = QUESTIONNAIRES['triathlon-gym'];
    const keys = q.steps.map((s) => s.key);
    expect(keys).toContain('squat_1rm_kg');
    expect(keys).toContain('bench_1rm_kg');
    expect(keys).toContain('deadlift_1rm_kg');
  });

  it('running questionnaire asks for mileage, pace, and target race', () => {
    const q = QUESTIONNAIRES['triathlon-running'];
    const keys = q.steps.map((s) => s.key);
    expect(keys).toContain('weekly_mileage_km');
    expect(keys).toContain('easy_pace_min_per_km');
    expect(keys).toContain('target_race');
  });

  it('cycling questionnaire asks for FTP, hours, and discipline', () => {
    const q = QUESTIONNAIRES['triathlon-cycling'];
    const keys = q.steps.map((s) => s.key);
    expect(keys).toContain('ftp_watts');
    expect(keys).toContain('weekly_hours');
    expect(keys).toContain('primary_discipline');
  });

  it('swim questionnaire asks for stroke, pool, and 400m time', () => {
    const q = QUESTIONNAIRES['triathlon-swim'];
    const keys = q.steps.map((s) => s.key);
    expect(keys).toContain('primary_stroke');
    expect(keys).toContain('pool_access');
    expect(keys).toContain('time_400m_freestyle_min');
  });

  it('sport questionnaires capture preferred and blocked training days', () => {
    for (const sport of sports) {
      const keys = QUESTIONNAIRES[sport].steps.map((s) => s.key);
      expect(keys).toContain('preferred_training_days');
      expect(keys).toContain('blocked_days');
    }
  });

  it('getAllQuestionnaires returns all defined questionnaires', () => {
    const all = getAllQuestionnaires();
    const ids = all.map((q) => q.id);
    expect(ids).toContain('fitness');
    expect(ids).toContain('triathlon-gym');
    expect(ids).toContain('triathlon-running');
    expect(ids).toContain('triathlon-cycling');
    expect(ids).toContain('triathlon-swim');
    expect(ids).toContain('diet');
  });
});

// ─── Skill mapping ──────────────────────────────────────────────────

describe('Phase 2 Slice B — SKILL_ONBOARDING_MAP', () => {
  it('triathlon maps to an array of 5 questionnaires', () => {
    const mapped = SKILL_ONBOARDING_MAP.triathlon;
    expect(Array.isArray(mapped)).toBe(true);
    expect(mapped).toHaveLength(5);
  });

  it('cooking still maps to a single string (back-compat)', () => {
    expect(SKILL_ONBOARDING_MAP.cooking).toBe('diet');
  });
});

// ─── renderProfile ──────────────────────────────────────────────────

describe('renderProfile', () => {
  it('renders a gym profile with human-friendly labels', () => {
    const profile: UserProfile = {
      id: 1,
      user_id: 100,
      profile_type: 'triathlon-gym',
      data: {
        training_age: '3-5 years',
        current_split: 'Push-Pull-Legs',
        primary_goal: 'Hypertrophy',
        squat_1rm_kg: '150',
        bench_1rm_kg: '100',
        deadlift_1rm_kg: '180',
        sessions_per_week: '4',
        equipment_access: 'Full commercial gym',
      },
      created_at: '',
      updated_at: '',
    };
    const rendered = renderProfile(profile);
    expect(rendered).toContain('[Strength profile]');
    expect(rendered).toContain('Squat 1RM (kg): 150');
    expect(rendered).toContain('Bench 1RM (kg): 100');
    expect(rendered).toContain('Deadlift 1RM (kg): 180');
    expect(rendered).toContain('Strength training experience: 3-5 years');
  });

  it('suppresses empty, "none", and "0" values', () => {
    const profile: UserProfile = {
      id: 1,
      user_id: 100,
      profile_type: 'triathlon-gym',
      data: {
        training_age: '1-3 years',
        squat_1rm_kg: '0',      // skipped: empty/zero
        bench_1rm_kg: '',        // skipped: empty
        deadlift_1rm_kg: '120',
        equipment_access: 'none', // skipped: "none" sentinel
      },
      created_at: '',
      updated_at: '',
    };
    const rendered = renderProfile(profile);
    expect(rendered).toContain('1-3 years');
    expect(rendered).toContain('Deadlift 1RM (kg): 120');
    expect(rendered).not.toContain('Squat 1RM');
    expect(rendered).not.toContain('Bench 1RM');
    expect(rendered).not.toContain('Equipment access: none');
  });

  it('falls back to snake→space for unknown keys', () => {
    const profile: UserProfile = {
      id: 1,
      user_id: 100,
      profile_type: 'triathlon-gym',
      data: {
        some_custom_field: 'custom value',
      },
      created_at: '',
      updated_at: '',
    };
    const rendered = renderProfile(profile);
    expect(rendered).toContain('some custom field: custom value');
  });

  it('uses the profile_type header from PROFILE_TYPE_HEADERS', () => {
    const types: Array<[string, string]> = [
      ['fitness', 'Fitness basics'],
      ['triathlon-gym', 'Strength profile'],
      ['triathlon-running', 'Running profile'],
      ['triathlon-cycling', 'Cycling profile'],
      ['triathlon-swim', 'Swim profile'],
    ];
    for (const [type, header] of types) {
      const profile: UserProfile = {
        id: 1, user_id: 1, profile_type: type,
        data: { a: 'b' }, created_at: '', updated_at: '',
      };
      expect(renderProfile(profile)).toContain(`[${header}]`);
    }
  });
});

// ─── formatAthleteProfileBlock ──────────────────────────────────────

describe('formatAthleteProfileBlock — database-backed', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => testDb?.close());

  it('returns empty string when user has no profiles', () => {
    expect(formatAthleteProfileBlock(5001)).toBe('');
  });

  it('wraps a single profile in the athlete_profile tag', () => {
    insertProfile(5002, 'triathlon-gym', {
      training_age: '1-3 years',
      primary_goal: 'Strength (1RM)',
      squat_1rm_kg: '120',
    });
    const block = formatAthleteProfileBlock(5002);
    expect(block).toContain('<athlete_profile>');
    expect(block).toContain('[Strength profile]');
    expect(block).toContain('Squat 1RM (kg): 120');
    expect(block).toContain('</athlete_profile>');
  });

  it('aggregates multiple triathlon profiles into one block', () => {
    insertProfile(5003, 'triathlon-gym', { training_age: '3-5 years', squat_1rm_kg: '150' });
    insertProfile(5003, 'triathlon-running', { weekly_mileage_km: '45', target_race: '10k' });
    insertProfile(5003, 'triathlon-cycling', { ftp_watts: '240', weekly_hours: '6-10 hours' });

    const block = formatAthleteProfileBlock(5003);
    expect(block).toContain('[Strength profile]');
    expect(block).toContain('[Running profile]');
    expect(block).toContain('[Cycling profile]');
    expect(block).toContain('Squat 1RM (kg): 150');
    expect(block).toContain('FTP (watts): 240');
    expect(block).toContain('Weekly mileage (km): 45');
  });

  it('places core fitness profile first, then sport profiles alphabetical', () => {
    insertProfile(5004, 'triathlon-swim', { primary_stroke: 'Freestyle' });
    insertProfile(5004, 'triathlon-gym', { training_age: '1-3 years' });
    insertProfile(5004, 'fitness', { experience_level: 'Intermediate (1-3 years)' });
    insertProfile(5004, 'triathlon-running', { weekly_mileage_km: '40' });

    const block = formatAthleteProfileBlock(5004);
    // Find the positions of each header in the rendered block
    const fitnessPos = block.indexOf('[Fitness basics]');
    const gymPos = block.indexOf('[Strength profile]');
    const runningPos = block.indexOf('[Running profile]');
    const swimPos = block.indexOf('[Swim profile]');

    expect(fitnessPos).toBeGreaterThanOrEqual(0);
    expect(gymPos).toBeGreaterThan(fitnessPos);
    expect(runningPos).toBeGreaterThan(gymPos);
    expect(swimPos).toBeGreaterThan(runningPos);
  });

  it('does NOT include the cooking diet profile in the triathlon block', () => {
    insertProfile(5005, 'triathlon-gym', { training_age: '5+ years' });
    insertProfile(5005, 'diet', { diet_type: 'Carnivore', weight_kg: '80' });

    const block = formatAthleteProfileBlock(5005);
    expect(block).toContain('[Strength profile]');
    expect(block).not.toContain('[Nutrition profile]');
    expect(block).not.toContain('diet_type');
    expect(block).not.toContain('Carnivore');
  });

  it('includes fitness (core) alongside sport-specific profiles', () => {
    insertProfile(5006, 'fitness', {
      experience_level: 'Advanced (3+ years)',
      injuries: 'none',
      available_equipment: 'Full gym',
    });
    insertProfile(5006, 'triathlon-gym', { primary_goal: 'Powerlifting' });

    const block = formatAthleteProfileBlock(5006);
    expect(block).toContain('[Fitness basics]');
    expect(block).toContain('Training experience: Advanced (3+ years)');
    // "none" should be suppressed
    expect(block).not.toContain('Injuries / limitations: none');
    expect(block).toContain('[Strength profile]');
  });
});
