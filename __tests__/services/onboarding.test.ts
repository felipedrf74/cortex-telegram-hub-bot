/**
 * Tests for src/services/onboarding.ts
 *
 * Validates:
 * - Questionnaire definitions structure
 * - Session lifecycle (start, answer, complete, abandon)
 * - Profile persistence
 * - Per-user isolation
 * - Answer validation
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
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
// QUESTIONNAIRE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════

describe('Questionnaire definitions', () => {
  it('has fitness, diet, and homeschool questionnaires', () => {
    const available = getAvailableQuestionnaires();
    expect(available).toContain('fitness');
    expect(available).toContain('diet');
    expect(available).toContain('homeschool');
  });

  it('each questionnaire has required fields', () => {
    for (const [id, def] of Object.entries(QUESTIONNAIRES)) {
      expect(def.id).toBe(id);
      expect(def.title).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.steps.length).toBeGreaterThan(0);
    }
  });

  it('each step has key, prompt, and type', () => {
    for (const def of Object.values(QUESTIONNAIRES)) {
      for (const step of def.steps) {
        expect(step.key).toBeTruthy();
        expect(step.prompt).toBeTruthy();
        expect(['choice', 'text', 'number', 'multi_choice']).toContain(step.type);
        if (step.type === 'choice' || step.type === 'multi_choice') {
          expect(step.options).toBeDefined();
          expect(step.options!.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('step keys are unique within each questionnaire', () => {
    for (const def of Object.values(QUESTIONNAIRES)) {
      const keys = def.steps.map(s => s.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// SESSION LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('Session lifecycle', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('starts a new session', () => {
    const session = startOrResume(1, 'fitness');
    expect(session.user_id).toBe(1);
    expect(session.questionnaire).toBe('fitness');
    expect(session.current_step).toBe(0);
    expect(session.status).toBe('in_progress');
    expect(Object.keys(session.answers)).toHaveLength(0);
  });

  it('resumes an existing in-progress session', () => {
    startOrResume(1, 'fitness');
    answerStep(1, 'fitness', 'Intermediate (1-3 years)');

    const resumed = startOrResume(1, 'fitness');
    expect(resumed.current_step).toBe(1); // advanced to step 1
    expect(resumed.answers.experience_level).toBe('Intermediate (1-3 years)');
  });

  it('answers a step and advances', () => {
    startOrResume(1, 'fitness');
    const result = answerStep(1, 'fitness', 'Advanced (3+ years)');

    expect(result.session.current_step).toBe(1);
    expect(result.session.answers.experience_level).toBe('Advanced (3+ years)');
    expect(result.nextStep).toBeTruthy();
    expect(result.nextStep!.key).toBe('weekly_frequency');
  });

  it('completes a questionnaire when all steps answered', () => {
    startOrResume(1, 'fitness');
    const steps = QUESTIONNAIRES.fitness.steps;

    for (let i = 0; i < steps.length; i++) {
      const answer = steps[i].options ? steps[i].options![0] : 'test answer';
      const result = answerStep(1, 'fitness', answer);

      if (i < steps.length - 1) {
        expect(result.nextStep).toBeTruthy();
        expect(result.session.status).toBe('in_progress');
      } else {
        expect(result.nextStep).toBeNull();
        expect(result.session.status).toBe('completed');
      }
    }
  });

  it('saves profile on completion', () => {
    startOrResume(1, 'fitness');
    const steps = QUESTIONNAIRES.fitness.steps;

    for (const step of steps) {
      const answer = step.options ? step.options[0] : 'test';
      answerStep(1, 'fitness', answer);
    }

    const profile = getProfile(1, 'fitness');
    expect(profile).toBeTruthy();
    expect(profile!.data.experience_level).toBe(steps[0].options![0]);
  });

  it('getCurrentStep returns current question', () => {
    startOrResume(1, 'fitness');
    const step = getCurrentStep(1, 'fitness');
    expect(step).toBeTruthy();
    expect(step!.key).toBe('experience_level');
  });

  it('getCurrentStep returns null when no active session', () => {
    expect(getCurrentStep(1, 'fitness')).toBeNull();
  });

  it('abandons a session', () => {
    startOrResume(1, 'fitness');
    const abandoned = abandonSession(1, 'fitness');
    expect(abandoned).toBe(true);
    expect(getActiveSession(1, 'fitness')).toBeNull();
  });

  it('starting after completion resets the session', () => {
    startOrResume(1, 'fitness');
    for (const step of QUESTIONNAIRES.fitness.steps) {
      answerStep(1, 'fitness', step.options ? step.options[0] : 'test');
    }

    // Start again — should reset
    const newSession = startOrResume(1, 'fitness');
    expect(newSession.current_step).toBe(0);
    expect(newSession.status).toBe('in_progress');
    expect(Object.keys(newSession.answers)).toHaveLength(0);
  });

  it('throws for unknown questionnaire', () => {
    expect(() => startOrResume(1, 'nonexistent')).toThrow('Unknown questionnaire');
  });
});

// ═══════════════════════════════════════════════════════════════════
// USER ISOLATION
// ═══════════════════════════════════════════════════════════════════

describe('User isolation', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('isolates sessions between users', () => {
    startOrResume(1, 'fitness');
    startOrResume(2, 'fitness');

    answerStep(1, 'fitness', 'Beginner (< 1 year)');

    const session1 = getActiveSession(1, 'fitness');
    const session2 = getActiveSession(2, 'fitness');

    expect(session1!.current_step).toBe(1);
    expect(session2!.current_step).toBe(0);
  });

  it('isolates profiles between users', () => {
    startOrResume(1, 'fitness');
    for (const step of QUESTIONNAIRES.fitness.steps) {
      answerStep(1, 'fitness', step.options ? step.options[0] : 'test');
    }

    expect(getProfile(1, 'fitness')).toBeTruthy();
    expect(getProfile(2, 'fitness')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// PROFILE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

describe('Profile management', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('getAllProfiles returns all completed profiles for a user', () => {
    // Complete fitness
    startOrResume(1, 'fitness');
    for (const step of QUESTIONNAIRES.fitness.steps) {
      answerStep(1, 'fitness', step.options ? step.options[0] : 'test');
    }

    // Complete diet
    startOrResume(1, 'diet');
    for (const step of QUESTIONNAIRES.diet.steps) {
      answerStep(1, 'diet', step.options ? step.options[0] : '80');
    }

    const profiles = getAllProfiles(1);
    expect(profiles).toHaveLength(2);
    expect(profiles.map(p => p.profile_type).sort()).toEqual(['diet', 'fitness']);
  });

  it('profile updates on re-completion', () => {
    // First completion
    startOrResume(1, 'fitness');
    for (const step of QUESTIONNAIRES.fitness.steps) {
      answerStep(1, 'fitness', step.options ? step.options[0] : 'first');
    }

    const first = getProfile(1, 'fitness')!;
    expect(first.data.experience_level).toBe(QUESTIONNAIRES.fitness.steps[0].options![0]);

    // Second completion with different answers
    startOrResume(1, 'fitness');
    for (const step of QUESTIONNAIRES.fitness.steps) {
      const answer = step.options ? step.options[step.options.length - 1] : 'second';
      answerStep(1, 'fitness', answer);
    }

    const second = getProfile(1, 'fitness')!;
    expect(second.data.experience_level).toBe(QUESTIONNAIRES.fitness.steps[0].options![QUESTIONNAIRES.fitness.steps[0].options!.length - 1]);
  });
});
