// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

const applyMocks = vi.hoisted(() => ({
  assertLegacyCalendarEventMutationAllowed: vi.fn(),
  getSessionByCalendarEvent: vi.fn(),
  syncSessionWithCoachRecommendation: vi.fn(),
  updateEvent: vi.fn(),
  withTrainingCalendarOperationLock: vi.fn(),
}));

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database',
  )),
  getDb: () => testDb,
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

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: vi.fn(),
  hasConnectedCalendarForUser: vi.fn(() => false),
  updateEvent: (...args: unknown[]) => applyMocks.updateEvent(...args),
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlanSummary: vi.fn(() => null),
  getSessionByCalendarEvent: (...args: unknown[]) => applyMocks.getSessionByCalendarEvent(...args),
  syncSessionWithCoachRecommendation: (...args: unknown[]) => (
    applyMocks.syncSessionWithCoachRecommendation(...args)
  ),
}));

vi.mock('../../src/services/training-plan-revision-legacy-guard', () => ({
  assertLegacyCalendarEventMutationAllowed: (...args: unknown[]) => (
    applyMocks.assertLegacyCalendarEventMutationAllowed(...args)
  ),
}));

vi.mock('../../src/services/training-operation-locks', () => ({
  withTrainingCalendarOperationLock: (...args: unknown[]) => (
    applyMocks.withTrainingCalendarOperationLock(...args)
  ),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguageById: vi.fn(() => 'en-US'),
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
  resolveCurrentTenantIdForUser: vi.fn((userId: number) => userId),
}));

vi.mock('../../src/state/conversation', () => ({
  getConversationHistory: vi.fn(() => []),
  addToConversation: vi.fn(),
}));

vi.mock('../../src/state/todos', () => ({ listTodos: vi.fn(() => []) }));
vi.mock('../../src/state/shared-memory', () => ({
  getSharedMemorySummary: vi.fn(() => ''),
  getSharedMemory: vi.fn(() => []),
  getSharedMemoryByScope: vi.fn(() => ({ userPrivate: [], tenantShared: [] })),
}));
vi.mock('../../src/services/tool-executor', () => ({ executeToolCall: vi.fn() }));
vi.mock('../../src/services/provider-registry', () => ({
  getActiveProvider: vi.fn(() => null),
  ensureActiveProvider: vi.fn(() => null),
}));
vi.mock('../../src/services/anthropic', () => ({
  callDomain: vi.fn(),
  continueWithToolResults: vi.fn(),
  getDomainSystemPrompt: vi.fn(() => ''),
}));

import {
  __resetLastCoachStateCacheForTests,
  getLastCoachState,
  setLastCoachState,
} from '../../src/domains/domain-handler';
import { applyCoachRecommendations } from '../../src/services/garmin-coach';

function ensureUser(userId: number): void {
  testDb.prepare(`
    INSERT INTO users (
      id,
      telegram_id,
      first_name,
      language,
      timezone,
      tier,
      status,
      auth_provider,
      created_at,
      last_active_at
    )
    VALUES (?, ?, ?, 'en-US', 'Europe/Lisbon', 'pro', 'active', 'telegram', datetime('now'), datetime('now'))
  `).run(userId, userId, `Coach apply ${userId}`);
}

describe('durable delegated-tenant coach apply', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    ensureUser(42);
    __resetLastCoachStateCacheForTests();
    vi.clearAllMocks();
    applyMocks.getSessionByCalendarEvent.mockReturnValue({
      id: 901,
      plan_id: 801,
      title: 'Tempo Run',
    });
    applyMocks.syncSessionWithCoachRecommendation.mockReturnValue(true);
    applyMocks.updateEvent.mockResolvedValue({ id: 'event-1', source: 'outlook' });
    applyMocks.withTrainingCalendarOperationLock.mockImplementation(
      async (_scope: unknown, operation: (lease: unknown) => Promise<unknown>) => {
        const signal = new AbortController().signal;
        return operation({ signal, assertActive: vi.fn() });
      },
    );
  });

  afterEach(() => {
    __resetLastCoachStateCacheForTests();
    testDb.close();
  });

  it('restores the exact user+tenant state after restart and applies only inside that scope', async () => {
    const recommendation = {
      eventId: 'event-1',
      source: 'outlook' as const,
      action: 'MODIFY' as const,
      originalTitle: 'Tempo Run',
      newTitle: 'Easy Run',
      newStart: null,
      newEnd: null,
      summary: 'Reduce intensity',
      reason: 'Recovery is low',
    };
    setLastCoachState(42, [recommendation], 'Use an easy run', 77);

    // A fresh process must reload from SQLite, not the in-memory LRU.
    __resetLastCoachStateCacheForTests();
    expect(getLastCoachState(42, 78)).toBeNull();

    await expect(applyCoachRecommendations(42, 77, ['event-1'])).resolves.toMatchObject({
      count: 1,
      appliedRecommendations: [recommendation],
    });
    expect(applyMocks.withTrainingCalendarOperationLock).toHaveBeenCalledWith(
      { userId: 42, tenantId: 77, operation: 'coach_apply' },
      expect.any(Function),
    );
    expect(applyMocks.getSessionByCalendarEvent).toHaveBeenCalledWith(
      'event-1',
      'outlook',
      { userId: 42, tenantId: 77 },
    );
    expect(applyMocks.updateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_id: 'event-1', new_title: 'Easy Run' }),
      'outlook',
      42,
      { signal: expect.objectContaining({ aborted: false }) },
    );
    expect(applyMocks.syncSessionWithCoachRecommendation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42, tenantId: 77 }),
    );

    applyMocks.updateEvent.mockClear();
    await expect(applyCoachRecommendations(42, 78, ['event-1']))
      .rejects.toThrow('No active coach recommendations found');
    expect(applyMocks.updateEvent).not.toHaveBeenCalled();
  });
});
