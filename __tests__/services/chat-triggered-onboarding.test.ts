/**
 * Phase 3 Slice A — Chat-triggered onboarding tests
 *
 * Locks in the 3 layers of the flow:
 *
 *   1. Pure helpers (upsertProfileField / getMissingProfileFields /
 *      isProfileComplete) behave correctly against the SQLite store.
 *   2. The save_athlete_profile_field tool validates its inputs
 *      (profile type whitelist, field key exists, regex passes) and
 *      returns the remaining pending fields after each save.
 *   3. The triathlon domain state context builder injects an
 *      `<onboarding_pending>` block when a confident sport classification
 *      hits an incomplete profile, and OMITS it otherwise.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;
const mockInvalidateOnboardingDerivedCaches = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/services/onboarding-cache-invalidator', () => ({
  invalidateOnboardingDerivedCaches: (...args: unknown[]) => mockInvalidateOnboardingDerivedCaches(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [111111] },
    app: { timezone: 'Europe/Lisbon' },
    // anthropic.ts reads apiKey at module load time — stub to a
    // placeholder so the SDK constructor doesn't throw. The test
    // never actually hits the network.
    anthropic: { apiKey: 'sk-test-placeholder' },
    openai: { apiKey: 'sk-test-placeholder' },
    gemini: { apiKey: 'test-placeholder' },
  },
}));

// The context-engine pulls from a lot of tables on startup; stub it to
// return an empty string so buildSimpleStateContext stays focused on the
// onboarding path.
vi.mock('../../src/services/context-engine', () => ({
  getDailyContext: vi.fn(() => ''),
}));

// training-plans is exercised by other tests; stub the one function
// buildSimpleStateContext imports so its DB dependencies don't show up.
vi.mock('../../src/services/training-plans', () => ({
  getActivePlanSummary: vi.fn(() => null),
}));

// The shared-memory helper reads a separate summary builder; noop here.
vi.mock('../../src/state/shared-memory', () => ({
  setSharedMemory: vi.fn(),
  removeSharedMemory: vi.fn(),
  getSharedMemorySummary: vi.fn(() => ''),
  getSharedMemory: vi.fn(() => []),
  getSharedMemoryByScope: vi.fn(() => ({ userPrivate: [], tenantShared: [] })),
}));

// listTodos pulls from a table we haven't necessarily migrated in this
// test's in-memory DB; return an empty array so the builder's todo
// branch doesn't fire.
vi.mock('../../src/state/todos', () => ({
  listTodos: vi.fn(() => []),
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
  upsertProfileField,
  getMissingProfileFields,
  isProfileComplete,
  getProfile,
  getQuestionnaire,
} from '../../src/services/onboarding';
import { executeToolCall as executeToolCallRaw } from '../../src/services/tool-executor';
import { runWithChatToolAuthorization } from '../../src/services/chat-tool-authorization';
import { buildSimpleStateContext } from '../../src/domains/domain-handler';

// ─── Helper functions ──────────────────────────────────────────────

function executeToolCall(toolName: string, input: Record<string, any>, userId?: number): Promise<any> {
  if (!userId) return executeToolCallRaw(toolName, input, userId);
  return runWithChatToolAuthorization({
    userId,
    tenantId: userId,
    confirmedDestructiveAction: true,
    confirmationSource: 'explicit_current_turn',
  }, () => executeToolCallRaw(toolName, input, userId, userId)) as Promise<any>;
}

describe('Phase 3 Slice A — profile field helpers', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    mockInvalidateOnboardingDerivedCaches.mockReset();
  });
  afterEach(() => testDb?.close());

  describe('upsertProfileField', () => {
    it('creates a profile row when none exists', () => {
      upsertProfileField(100, 'triathlon-gym', 'training_age', '3-5 years');
      const profile = getProfile(100, 'triathlon-gym');
      expect(profile).not.toBeNull();
      expect(profile!.data.training_age).toBe('3-5 years');
    });

    it('merges a new field into an existing profile', () => {
      upsertProfileField(101, 'triathlon-gym', 'training_age', '1-3 years');
      upsertProfileField(101, 'triathlon-gym', 'squat_1rm_kg', '120');
      upsertProfileField(101, 'triathlon-gym', 'bench_1rm_kg', '80');

      const profile = getProfile(101, 'triathlon-gym');
      expect(profile!.data.training_age).toBe('1-3 years');
      expect(profile!.data.squat_1rm_kg).toBe('120');
      expect(profile!.data.bench_1rm_kg).toBe('80');
    });

    it('overwrites an existing field value on second call', () => {
      upsertProfileField(102, 'triathlon-running', 'weekly_mileage_km', '30');
      upsertProfileField(102, 'triathlon-running', 'weekly_mileage_km', '45');

      const profile = getProfile(102, 'triathlon-running');
      expect(profile!.data.weekly_mileage_km).toBe('45');
    });

    it('keeps different users\' profiles isolated', () => {
      upsertProfileField(103, 'triathlon-gym', 'training_age', '5+ years');
      upsertProfileField(104, 'triathlon-gym', 'training_age', '< 1 year');

      expect(getProfile(103, 'triathlon-gym')!.data.training_age).toBe('5+ years');
      expect(getProfile(104, 'triathlon-gym')!.data.training_age).toBe('< 1 year');
    });
  });

  describe('getMissingProfileFields', () => {
    it('returns all steps when no profile exists', () => {
      const missing = getMissingProfileFields(200, 'triathlon-gym');
      const questionnaire = getQuestionnaire('triathlon-gym')!;
      expect(missing).toHaveLength(questionnaire.steps.length);
    });

    it('returns only the unanswered steps when a profile is partial', () => {
      upsertProfileField(201, 'triathlon-gym', 'training_age', '1-3 years');
      upsertProfileField(201, 'triathlon-gym', 'squat_1rm_kg', '100');

      const missing = getMissingProfileFields(201, 'triathlon-gym');
      const keys = missing.map((s) => s.key);
      expect(keys).not.toContain('training_age');
      expect(keys).not.toContain('squat_1rm_kg');
      expect(keys).toContain('bench_1rm_kg');
      expect(keys).toContain('deadlift_1rm_kg');
    });

    it('returns an empty array when the profile is complete', () => {
      const questionnaire = getQuestionnaire('triathlon-swim')!;
      for (const step of questionnaire.steps) {
        upsertProfileField(202, 'triathlon-swim', step.key, 'placeholder value');
      }
      expect(getMissingProfileFields(202, 'triathlon-swim')).toHaveLength(0);
    });

    it('returns empty array for unknown questionnaire id', () => {
      expect(getMissingProfileFields(203, 'nonexistent')).toEqual([]);
    });

    it('preserves questionnaire step order', () => {
      // Answer only the middle step — the missing list must still be
      // in the same order as the questionnaire definition.
      upsertProfileField(204, 'triathlon-running', 'target_race', '10k');

      const missing = getMissingProfileFields(204, 'triathlon-running');
      const questionnaireKeys = getQuestionnaire('triathlon-running')!
        .steps
        .map((s) => s.key)
        .filter((k) => k !== 'target_race');
      expect(missing.map((s) => s.key)).toEqual(questionnaireKeys);
    });
  });

  describe('isProfileComplete', () => {
    it('returns false for an empty profile', () => {
      expect(isProfileComplete(300, 'triathlon-cycling')).toBe(false);
    });

    it('returns false for a partial profile', () => {
      upsertProfileField(301, 'triathlon-cycling', 'ftp_watts', '240');
      expect(isProfileComplete(301, 'triathlon-cycling')).toBe(false);
    });

    it('returns true after every field is answered', () => {
      const questionnaire = getQuestionnaire('triathlon-cycling')!;
      for (const step of questionnaire.steps) {
        upsertProfileField(302, 'triathlon-cycling', step.key, 'x');
      }
      expect(isProfileComplete(302, 'triathlon-cycling')).toBe(true);
    });
  });
});

// ─── save_athlete_profile_field tool handler ────────────────────────

describe('Phase 3 Slice A — save_athlete_profile_field tool', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('requires a user_id', async () => {
    const result = await executeToolCall('save_athlete_profile_field', {
      profile_type: 'triathlon-gym',
      field_key: 'training_age',
      value: '1-3 years',
    });
    expect(result).toMatchObject({
      success: false,
      code: 'AUTH_REQUIRED',
      error: 'save_athlete_profile_field requires authenticated chat authorization context',
    });
  });

  it('rejects unknown profile types (whitelist enforced)', async () => {
    const result = await executeToolCall(
      'save_athlete_profile_field',
      { profile_type: 'homeschool', field_key: 'child_age', value: '7' },
      400,
    );
    expect(result.error).toContain('not in the triathlon profile set');
  });

  it('rejects hallucinated field keys', async () => {
    const result = await executeToolCall(
      'save_athlete_profile_field',
      { profile_type: 'triathlon-gym', field_key: 'favorite_color', value: 'blue' },
      400,
    );
    expect(result.error).toContain('not a step');
    expect(result.allowed_fields).toContain('training_age');
  });

  it('rejects a value that fails the field\'s validation regex', async () => {
    // easy_pace_min_per_km requires format "m:ss" or "mm:ss"
    const result = await executeToolCall(
      'save_athlete_profile_field',
      { profile_type: 'triathlon-running', field_key: 'easy_pace_min_per_km', value: 'fast' },
      400,
    );
    expect(result.error).toContain('does not match the expected format');
  });

  it('accepts a valid answer and reports remaining pending fields', async () => {
    const result = await executeToolCall(
      'save_athlete_profile_field',
      { profile_type: 'triathlon-gym', field_key: 'training_age', value: '3-5 years' },
      500,
    );
    expect(result.success).toBe(true);
    expect(result.saved_field).toBe('training_age');
    expect(result.remaining_fields).toBeInstanceOf(Array);
    expect(result.remaining_fields).not.toContain('training_age');
    expect(result.profile_complete).toBe(false);
    expect(mockInvalidateOnboardingDerivedCaches).toHaveBeenCalledWith(500, 'triathlon-gym');
  });

  it('marks profile_complete: true after the last field is saved', async () => {
    const questionnaire = getQuestionnaire('triathlon-gym')!;
    const uid = 600;
    // Save every field except the last
    for (let i = 0; i < questionnaire.steps.length - 1; i++) {
      const step = questionnaire.steps[i];
      const value = step.type === 'number' ? '100' : (step.options?.[0] ?? 'x');
      await executeToolCall(
        'save_athlete_profile_field',
        { profile_type: 'triathlon-gym', field_key: step.key, value },
        uid,
      );
    }
    // Save the last field
    const lastStep = questionnaire.steps[questionnaire.steps.length - 1];
    const lastValue = lastStep.type === 'number' ? '100' : (lastStep.options?.[0] ?? 'x');
    const lastResult = await executeToolCall(
      'save_athlete_profile_field',
      { profile_type: 'triathlon-gym', field_key: lastStep.key, value: lastValue },
      uid,
    );
    expect(lastResult.profile_complete).toBe(true);
    expect(lastResult.remaining_fields).toHaveLength(0);
    expect(isProfileComplete(uid, 'triathlon-gym')).toBe(true);
  });
});

// ─── State context injection ───────────────────────────────────────

describe('Phase 3 Slice A — buildSimpleStateContext onboarding block', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('injects an <onboarding_pending> block for a confident sport with no profile', async () => {
    const ctx = await buildSimpleStateContext('triathlon', 700, '5x5 squats at RPE 9');
    expect(ctx).toContain('<onboarding_pending sport="gym"');
    expect(ctx).toContain('profile="triathlon-gym"');
    expect(ctx).toContain('save_athlete_profile_field');
    // Should list multiple missing fields
    expect(ctx).toContain('training_age');
    expect(ctx).toContain('squat_1rm_kg');
  });

  it('injects the block for a running message when running profile is missing', async () => {
    const ctx = await buildSimpleStateContext('triathlon', 701, '10k tempo run today');
    expect(ctx).toContain('<onboarding_pending sport="running"');
    expect(ctx).toContain('weekly_mileage_km');
  });

  it('injects the block for a cycling message (persona enum differs from sub-skill name)', async () => {
    // Sport classifier returns 'cycling', which maps to profile 'triathlon-cycling'
    const ctx = await buildSimpleStateContext('triathlon', 702, 'FTP test on the trainer');
    expect(ctx).toContain('<onboarding_pending sport="cycling"');
    expect(ctx).toContain('profile="triathlon-cycling"');
    expect(ctx).toContain('ftp_watts');
  });

  it('injects the block for a swim message', async () => {
    const ctx = await buildSimpleStateContext('triathlon', 703, '1500m freestyle at CSS');
    expect(ctx).toContain('<onboarding_pending sport="swim"');
    expect(ctx).toContain('primary_stroke');
  });

  it('OMITS the block when the sport profile is already complete', async () => {
    // Complete the gym profile first
    const questionnaire = getQuestionnaire('triathlon-gym')!;
    for (const step of questionnaire.steps) {
      const value = step.type === 'number' ? '100' : (step.options?.[0] ?? 'x');
      upsertProfileField(704, 'triathlon-gym', step.key, value);
    }
    const ctx = await buildSimpleStateContext('triathlon', 704, 'bench press today');
    expect(ctx).not.toContain('<onboarding_pending');
  });

  it('OMITS the block when the classifier returns null (ambiguous message)', async () => {
    const ctx = await buildSimpleStateContext('triathlon', 705, 'plan my week please');
    expect(ctx).not.toContain('<onboarding_pending');
  });

  it('OMITS the block when confidence is below threshold', async () => {
    // "workout" is not in any sport keyword list → classifier returns null
    const ctx = await buildSimpleStateContext('triathlon', 706, 'workout today');
    expect(ctx).not.toContain('<onboarding_pending');
  });

  it('OMITS the block when domain is NOT triathlon', async () => {
    // Content domain with a message that WOULD classify as gym shouldn't trigger
    const ctx = await buildSimpleStateContext('content', 707, '5x5 squats video idea');
    expect(ctx).not.toContain('<onboarding_pending');
  });

  it('OMITS the block when no message is passed', async () => {
    const ctx = await buildSimpleStateContext('triathlon', 708);
    expect(ctx).not.toContain('<onboarding_pending');
  });

  it('OMITS the block when no userId is passed', async () => {
    const ctx = await buildSimpleStateContext('triathlon', undefined, '5x5 squats');
    expect(ctx).not.toContain('<onboarding_pending');
  });

  it('shows only the MISSING fields in the pending list', async () => {
    // Answer 2 gym fields first
    upsertProfileField(709, 'triathlon-gym', 'training_age', '1-3 years');
    upsertProfileField(709, 'triathlon-gym', 'squat_1rm_kg', '120');

    const ctx = await buildSimpleStateContext('triathlon', 709, 'deadlift day');
    expect(ctx).toContain('<onboarding_pending');
    // Answered fields should not appear in the missing list
    // (but they may still appear in the instruction boilerplate — that's why
    // we look for "- training_age" with the leading bullet)
    expect(ctx).not.toContain('- training_age');
    expect(ctx).not.toContain('- squat_1rm_kg');
    expect(ctx).toContain('- bench_1rm_kg');
    expect(ctx).toContain('- deadlift_1rm_kg');
  });
});
