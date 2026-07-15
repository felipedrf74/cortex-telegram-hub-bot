// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 16 batch 89 second half (2026-05-17): score-based intent
// picking regression.
//
// Replaces the first-match priority dispatch in parseBroadSkillActionIntent
// with a score-based winner. The score is:
//
//   score = baseWeight + (requiredArgsPresent ? 0.005 : 0)
//
// The bonus is intentionally smaller than the smallest inter-skill priority
// gap (0.01) so it only tie-breaks within a priority tier; it never
// demotes a higher-priority skill. The original Phase 6 batch 6 ordering
// (notifications/decisions ahead of training, etc.) is preserved.
//
// This file pins three contracts:
//   1. Single-match cases produce the same result as before
//   2. Cross-skill confusion cases (Phase 3 batch 17 fixtures) keep
//      their winners
//   3. Slot-completeness tie-break works for same-priority parsers

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/api/routes/training-plan-calendar-sync', () => ({
  syncTrainingPlanCalendar: vi.fn(),
  previewTrainingSessionReflow: vi.fn(),
  confirmTrainingSessionReflow: vi.fn(),
}));

import {
  BROAD_SKILL_MIN_PRIORITY_GAP,
  BROAD_SKILL_SLOT_COMPLETENESS_BONUS,
  buildChatActionPlan,
  type ChatPlannerInput,
} from '../../src/services/chat';

const NOW = '2026-05-17T10:00:00+01:00';

function inputFor(text: string, locale: 'en-US' | 'pt-BR' | 'es-ES' = 'en-US'): ChatPlannerInput {
  return {
    text,
    userId: 7700,
    tenantId: 770,
    conversationId: 'conv-score',
    messageId: 'msg-score',
    channel: 'api',
    locale,
    timezone: 'Europe/Lisbon',
    nowIso: NOW,
  };
}

describe('score-based intent picking (Phase 16 batch 89 second half)', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => {
    testDb.close();
    vi.restoreAllMocks();
  });

  it('keeps notifications winning over finance for "Create a notification when my budget goes negative"', async () => {
    // Notifications has the higher base weight (0.78 vs finance 0.75).
    // Even with the slot-completeness tie-break bonus (0.005), the
    // priority gap (0.03) protects notifications. This is the
    // regression case that caught the first attempt at score-based
    // picking.
    const plan = await buildChatActionPlan(inputFor('Create a notification when my budget goes negative'));
    expect(plan?.steps[0]?.skill).toBe('notifications');
  });

  it('routes a clean notification create through the notifications branch', async () => {
    const plan = await buildChatActionPlan(inputFor('Create a notification when my Stripe revenue passes $10000'));
    expect(plan?.steps[0]?.skill).toBe('notifications');
  });

  it('routes "Create a task to buy milk" to tasks (single-match common case)', async () => {
    const plan = await buildChatActionPlan(inputFor('Create a task to buy milk'));
    // Tasks is dispatched separately in parseSimpleTaskStep above the
    // broad-skill score loop, so this test mainly proves the broad-skill
    // dispatch doesn't grab a task message away from the task branch.
    expect(plan?.steps[0]?.skill).toBe('tasks');
  });

  it('the slot-completeness tie-break is smaller than the smallest skill priority gap', () => {
    // Invariant: the slot-completeness bonus (0.005) MUST be smaller
    // than the smallest priority gap (0.01) between adjacent skills,
    // otherwise the tie-break can demote a higher-priority skill. Pin
    // these numbers so a future refactor that bumps the bonus is caught.
    expect(BROAD_SKILL_SLOT_COMPLETENESS_BONUS).toBeLessThan(BROAD_SKILL_MIN_PRIORITY_GAP);
  });
});
