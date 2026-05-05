/**
 * QA Validation Tests for src/services/onboarding.ts
 *
 * Covers edge cases, answer validation, concurrent sessions,
 * migration schema integrity, and error boundaries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (!applied) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  startOrResume,
  answerStep,
  getCurrentStep,
  getActiveSession,
  abandonSession,
  getProfile,
  getAllProfiles,
  getAvailableQuestionnaires,
  getQuestionnaire,
  QUESTIONNAIRES,
} from '../../src/services/onboarding';

// ═══════════════════════════════════════════════════════════════════
// MIGRATION SCHEMA VALIDATION
// ═══════════════════════════════════════════════════════════════════

describe('QA: Onboarding migration schema', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('onboarding_sessions table has expected columns', () => {
    const cols = testDb.pragma('table_info(onboarding_sessions)') as any[];
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('user_id');
    expect(colNames).toContain('questionnaire');
    expect(colNames).toContain('current_step');
    expect(colNames).toContain('answers');
    expect(colNames).toContain('status');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('completed_at');
  });

  it('user_profiles table has expected columns', () => {
    const cols = testDb.pragma('table_info(user_profiles)') as any[];
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('user_id');
    expect(colNames).toContain('profile_type');
    expect(colNames).toContain('data');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('updated_at');
  });

  it('enforces UNIQUE(user_id, questionnaire) on sessions', () => {
    testDb.prepare(`
      INSERT INTO onboarding_sessions (user_id, questionnaire, current_step, answers, status)
      VALUES (1, 'fitness', 0, '{}', 'in_progress')
    `).run();

    // Direct duplicate insert should fail (without ON CONFLICT)
    expect(() => {
      testDb.prepare(`
        INSERT INTO onboarding_sessions (user_id, questionnaire, current_step, answers, status)
        VALUES (1, 'fitness', 0, '{}', 'in_progress')
      `).run();
    }).toThrow();
  });

  it('enforces UNIQUE(user_id, profile_type) on profiles', () => {
    testDb.prepare(`
      INSERT INTO user_profiles (user_id, profile_type, data)
      VALUES (1, 'fitness', '{}')
    `).run();

    expect(() => {
      testDb.prepare(`
        INSERT INTO user_profiles (user_id, profile_type, data)
        VALUES (1, 'fitness', '{}')
      `).run();
    }).toThrow();
  });

  it('indexes exist for onboarding lookups', () => {
    const indexes = testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'onboarding_sessions'").all() as any[];
    const indexNames = indexes.map((i: any) => i.name);
    expect(indexNames.some((n: string) => n.includes('idx_onboard_user'))).toBe(true);
  });

  it('indexes exist for profile lookups', () => {
    const indexes = testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user_profiles'").all() as any[];
    const indexNames = indexes.map((i: any) => i.name);
    expect(indexNames.some((n: string) => n.includes('idx_profile_user'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ANSWER VALIDATION
// ═══════════════════════════════════════════════════════════════════

describe('QA: Answer validation', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('diet weight_kg accepts valid formats', () => {
    const validation = QUESTIONNAIRES.diet.steps.find(s => s.key === 'weight_kg')!.validation!;
    expect(validation.test('80')).toBe(true);
    expect(validation.test('80.5')).toBe(true);
    expect(validation.test('100')).toBe(true);
    expect(validation.test('65.0')).toBe(true);
  });

  it('diet weight_kg rejects invalid formats', () => {
    const validation = QUESTIONNAIRES.diet.steps.find(s => s.key === 'weight_kg')!.validation!;
    expect(validation.test('')).toBe(false);
    expect(validation.test('abc')).toBe(false);
    expect(validation.test('5')).toBe(false);        // single digit
    expect(validation.test('1000')).toBe(false);     // 4 digits
    expect(validation.test('80.55')).toBe(false);    // two decimal places
  });

  it('diet height_cm accepts valid formats', () => {
    const validation = QUESTIONNAIRES.diet.steps.find(s => s.key === 'height_cm')!.validation!;
    expect(validation.test('170')).toBe(true);
    expect(validation.test('65')).toBe(true);
    expect(validation.test('180')).toBe(true);
  });

  it('diet height_cm rejects invalid formats', () => {
    const validation = QUESTIONNAIRES.diet.steps.find(s => s.key === 'height_cm')!.validation!;
    expect(validation.test('5')).toBe(false);
    expect(validation.test('1700')).toBe(false);
    expect(validation.test('170.5')).toBe(false);     // no decimals allowed
  });

  it('homeschool child_age accepts valid ages', () => {
    const validation = QUESTIONNAIRES.homeschool.steps.find(s => s.key === 'child_age')!.validation!;
    expect(validation.test('5')).toBe(true);
    expect(validation.test('12')).toBe(true);
    expect(validation.test('17')).toBe(true);
  });

  it('homeschool child_age rejects invalid ages', () => {
    const validation = QUESTIONNAIRES.homeschool.steps.find(s => s.key === 'child_age')!.validation!;
    expect(validation.test('')).toBe(false);
    expect(validation.test('abc')).toBe(false);
    expect(validation.test('123')).toBe(false);       // 3 digits
  });

  it('rejects answer that fails validation in answerStep', () => {
    startOrResume(1, 'diet');
    // First step is diet_type (choice, no validation). Answer it.
    answerStep(1, 'diet', 'Carnivore');
    // Second step is weight_kg with validation
    expect(() => answerStep(1, 'diet', 'not-a-number')).toThrow('Invalid answer format');
  });

  it('accepts valid number answer in answerStep', () => {
    startOrResume(1, 'diet');
    answerStep(1, 'diet', 'Carnivore'); // diet_type
    const result = answerStep(1, 'diet', '80'); // weight_kg
    expect(result.session.answers.weight_kg).toBe('80');
    expect(result.session.current_step).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// CONCURRENT MULTI-QUESTIONNAIRE SESSIONS
// ═══════════════════════════════════════════════════════════════════

describe('QA: Concurrent sessions per user', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('user can have active sessions in multiple questionnaires simultaneously', () => {
    startOrResume(1, 'fitness');
    startOrResume(1, 'diet');
    startOrResume(1, 'homeschool');

    expect(getActiveSession(1, 'fitness')).toBeTruthy();
    expect(getActiveSession(1, 'diet')).toBeTruthy();
    expect(getActiveSession(1, 'homeschool')).toBeTruthy();
  });

  it('answering one questionnaire does not affect another', () => {
    startOrResume(1, 'fitness');
    startOrResume(1, 'diet');

    answerStep(1, 'fitness', 'Beginner (< 1 year)');

    const fitness = getActiveSession(1, 'fitness')!;
    const diet = getActiveSession(1, 'diet')!;

    expect(fitness.current_step).toBe(1);
    expect(diet.current_step).toBe(0);
    expect(Object.keys(diet.answers)).toHaveLength(0);
  });

  it('completing one questionnaire leaves others in progress', () => {
    startOrResume(1, 'fitness');
    startOrResume(1, 'diet');

    // Complete fitness
    for (const step of QUESTIONNAIRES.fitness.steps) {
      answerStep(1, 'fitness', step.options ? step.options[0] : 'test');
    }

    expect(getActiveSession(1, 'fitness')).toBeNull(); // completed, not in_progress
    expect(getActiveSession(1, 'diet')).toBeTruthy();
    expect(getProfile(1, 'fitness')).toBeTruthy();
    expect(getProfile(1, 'diet')).toBeNull();
  });

  it('abandoning one questionnaire does not affect another', () => {
    startOrResume(1, 'fitness');
    startOrResume(1, 'diet');

    abandonSession(1, 'fitness');

    expect(getActiveSession(1, 'fitness')).toBeNull();
    expect(getActiveSession(1, 'diet')).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// ERROR BOUNDARIES & EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('QA: Error boundaries', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('answerStep throws when no active session exists', () => {
    expect(() => answerStep(1, 'fitness', 'test')).toThrow('No active session');
  });

  it('answerStep throws for unknown questionnaire', () => {
    expect(() => answerStep(1, 'nonexistent', 'test')).toThrow('Unknown questionnaire');
  });

  it('startOrResume throws for unknown questionnaire', () => {
    expect(() => startOrResume(1, 'nonexistent')).toThrow('Unknown questionnaire');
  });

  it('getCurrentStep returns null for unknown questionnaire', () => {
    expect(getCurrentStep(1, 'nonexistent')).toBeNull();
  });

  it('getActiveSession returns null when session is completed', () => {
    startOrResume(1, 'fitness');
    for (const step of QUESTIONNAIRES.fitness.steps) {
      answerStep(1, 'fitness', step.options ? step.options[0] : 'none');
    }
    expect(getActiveSession(1, 'fitness')).toBeNull();
  });

  it('getActiveSession returns null when session is abandoned', () => {
    startOrResume(1, 'fitness');
    abandonSession(1, 'fitness');
    expect(getActiveSession(1, 'fitness')).toBeNull();
  });

  it('double abandon returns false on second call', () => {
    startOrResume(1, 'fitness');
    expect(abandonSession(1, 'fitness')).toBe(true);
    expect(abandonSession(1, 'fitness')).toBe(false);
  });

  it('abandon on non-existent session returns false', () => {
    expect(abandonSession(999, 'fitness')).toBe(false);
  });

  it('getProfile returns null for non-existent user', () => {
    expect(getProfile(999, 'fitness')).toBeNull();
  });

  it('getAllProfiles returns empty array for user with no profiles', () => {
    expect(getAllProfiles(999)).toEqual([]);
  });

  it('getQuestionnaire returns undefined for unknown id', () => {
    expect(getQuestionnaire('nonexistent')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// SESSION RESTART AFTER ABANDON
// ═══════════════════════════════════════════════════════════════════

describe('QA: Session restart after abandon', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('restarting after abandon creates a fresh session', () => {
    startOrResume(1, 'fitness');
    answerStep(1, 'fitness', 'Advanced (3+ years)');
    abandonSession(1, 'fitness');

    const fresh = startOrResume(1, 'fitness');
    expect(fresh.current_step).toBe(0);
    expect(Object.keys(fresh.answers)).toHaveLength(0);
    expect(fresh.status).toBe('in_progress');
  });

  it('abandoned session answers are discarded on restart', () => {
    startOrResume(1, 'fitness');
    answerStep(1, 'fitness', 'Beginner (< 1 year)');
    answerStep(1, 'fitness', '2-3 days');
    abandonSession(1, 'fitness');

    const restarted = startOrResume(1, 'fitness');
    expect(restarted.answers).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════
// FULL COMPLETION FLOWS (ALL QUESTIONNAIRES)
// ═══════════════════════════════════════════════════════════════════

describe('QA: Full completion flow — fitness', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('completes all 5 fitness steps and saves profile', () => {
    const userId = 42;
    startOrResume(userId, 'fitness');

    const answers = [
      'Intermediate (1-3 years)',
      '4-5 days',
      'Strength',
      'none',
      'Full gym',
    ];

    for (let i = 0; i < answers.length; i++) {
      const result = answerStep(userId, 'fitness', answers[i]);
      if (i < answers.length - 1) {
        expect(result.session.status).toBe('in_progress');
      } else {
        expect(result.session.status).toBe('completed');
        expect(result.nextStep).toBeNull();
      }
    }

    const profile = getProfile(userId, 'fitness')!;
    expect(profile).toBeTruthy();
    expect(profile.data.experience_level).toBe('Intermediate (1-3 years)');
    expect(profile.data.weekly_frequency).toBe('4-5 days');
    expect(profile.data.training_goals).toBe('Strength');
    expect(profile.data.injuries).toBe('none');
    expect(profile.data.available_equipment).toBe('Full gym');
  });
});

describe('QA: Full completion flow — diet', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('completes all 6 diet steps with validation', () => {
    const userId = 42;
    startOrResume(userId, 'diet');

    const answers = [
      'Carnivore',
      '85',
      '180',
      'none',
      '3 meals',
      'Muscle gain',
    ];

    for (let i = 0; i < answers.length; i++) {
      const result = answerStep(userId, 'diet', answers[i]);
      if (i < answers.length - 1) {
        expect(result.session.status).toBe('in_progress');
      } else {
        expect(result.session.status).toBe('completed');
      }
    }

    const profile = getProfile(userId, 'diet')!;
    expect(profile.data.diet_type).toBe('Carnivore');
    expect(profile.data.weight_kg).toBe('85');
    expect(profile.data.height_cm).toBe('180');
    expect(profile.data.allergies).toBe('none');
    expect(profile.data.meal_frequency).toBe('3 meals');
    expect(profile.data.nutrition_goal).toBe('Muscle gain');
  });
});

describe('QA: Full completion flow — homeschool', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('completes all 5 homeschool steps with validation', () => {
    const userId = 42;
    startOrResume(userId, 'homeschool');

    const answers = [
      '7',
      'K-2',
      'Visual',
      'Math',
      'Morning only (8-12)',
    ];

    for (let i = 0; i < answers.length; i++) {
      const result = answerStep(userId, 'homeschool', answers[i]);
      if (i < answers.length - 1) {
        expect(result.session.status).toBe('in_progress');
      } else {
        expect(result.session.status).toBe('completed');
      }
    }

    const profile = getProfile(userId, 'homeschool')!;
    expect(profile.data.child_age).toBe('7');
    expect(profile.data.grade_level).toBe('K-2');
    expect(profile.data.learning_style).toBe('Visual');
    expect(profile.data.subjects_focus).toBe('Math');
    expect(profile.data.schedule_preference).toBe('Morning only (8-12)');
  });
});

// ═══════════════════════════════════════════════════════════════════
// PROFILE UPSERT BEHAVIOR
// ═══════════════════════════════════════════════════════════════════

describe('QA: Profile upsert on re-completion', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('re-completing overwrites profile data without duplicating rows', () => {
    const userId = 10;

    // First completion
    startOrResume(userId, 'fitness');
    for (const step of QUESTIONNAIRES.fitness.steps) {
      answerStep(userId, 'fitness', step.options ? step.options[0] : 'first');
    }

    // Second completion with last options
    startOrResume(userId, 'fitness');
    for (const step of QUESTIONNAIRES.fitness.steps) {
      const answer = step.options ? step.options[step.options.length - 1] : 'second';
      answerStep(userId, 'fitness', answer);
    }

    // Should still have exactly one profile row
    const profiles = getAllProfiles(userId);
    const fitnessProfiles = profiles.filter(p => p.profile_type === 'fitness');
    expect(fitnessProfiles).toHaveLength(1);

    // Data should be from second completion
    expect(fitnessProfiles[0].data.experience_level).toBe('Advanced (3+ years)');
  });

  it('session table has exactly one row per user+questionnaire after re-start', () => {
    const userId = 10;

    startOrResume(userId, 'fitness');
    for (const step of QUESTIONNAIRES.fitness.steps) {
      answerStep(userId, 'fitness', step.options ? step.options[0] : 'test');
    }

    // Re-start
    startOrResume(userId, 'fitness');

    const rows = testDb.prepare(
      "SELECT COUNT(*) as count FROM onboarding_sessions WHERE user_id = ? AND questionnaire = ?",
    ).get(userId, 'fitness') as any;
    expect(rows.count).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// QUESTIONNAIRE DEFINITION INTEGRITY
// ═══════════════════════════════════════════════════════════════════

describe('QA: Questionnaire definition integrity', () => {
  it('all choice steps have at least 2 options', () => {
    for (const def of Object.values(QUESTIONNAIRES)) {
      for (const step of def.steps) {
        if (step.type === 'choice' || step.type === 'multi_choice') {
          expect(step.options!.length).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it('all number/text steps without options do not reference options', () => {
    for (const def of Object.values(QUESTIONNAIRES)) {
      for (const step of def.steps) {
        if (step.type === 'text' || step.type === 'number') {
          // options should be undefined for text/number types
          // (not strictly required but good practice)
          if (step.options) {
            // If options exist on a text/number type, that's a definition error
            expect.soft(step.options).toBeUndefined();
          }
        }
      }
    }
  });

  it('fitness questionnaire has exactly 5 steps', () => {
    expect(QUESTIONNAIRES.fitness.steps).toHaveLength(5);
  });

  it('diet questionnaire has exactly 6 steps', () => {
    expect(QUESTIONNAIRES.diet.steps).toHaveLength(6);
  });

  it('homeschool questionnaire has exactly 5 steps', () => {
    expect(QUESTIONNAIRES.homeschool.steps).toHaveLength(5);
  });

  it('validation regex is only present on number or text steps', () => {
    // Phase 2 Slice B: text-type steps can carry a format regex too,
    // for things like "pace min/km" ("6:00") or ISO dates. Choice /
    // multi_choice steps never need a regex because the options are
    // an enumerated list.
    for (const def of Object.values(QUESTIONNAIRES)) {
      for (const step of def.steps) {
        if (step.validation) {
          expect(['number', 'text'], `step ${def.id}.${step.key}`).toContain(step.type);
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// ROUTER INTEGRATION
// ═══════════════════════════════════════════════════════════════════

describe('QA: Router recognizes onboarding commands', () => {
  it('/onboard and /profile are system commands', async () => {
    const { isSystemCommand } = await import('../../src/router');
    expect(isSystemCommand('/onboard')).toBeTruthy();
    expect(isSystemCommand('/profile')).toBeTruthy();
    expect(isSystemCommand('/onboard fitness')).toBeTruthy();
  });
});
