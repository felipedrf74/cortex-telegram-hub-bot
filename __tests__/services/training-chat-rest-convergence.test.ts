// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const state = vi.hoisted(() => ({ db: null as any }));

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database'
  )),
  getDb: () => state.db,
}));

import {
  buildChatActionPlan,
  buildDeterministicChatActionPlan,
} from '../../src/services/chat';
import {
  getActivePendingChatAction,
  upsertPendingChatAction,
} from '../../src/services/chat-action-state';

const NOW = '2026-05-16T12:00:00+01:00';

describe('Training chat/REST convergence durable continuation (F26)', () => {
  beforeEach(() => {
    state.db = createMigratedTestDatabase();
  });

  afterEach(() => {
    state.db?.close();
    state.db = null;
  });

  it('persists the canonical draft and fills frequency only in the same scoped conversation', async () => {
    const conversationId = 'f26-durable-continuation';
    const turn1 = buildDeterministicChatActionPlan({
      userId: 77,
      tenantId: 88,
      conversationId,
      messageId: 'f26-turn-1',
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      channel: 'api',
      nowIso: NOW,
      text: 'Build me a running 10K plan in 12 weeks starting Monday',
    });
    const turn1Step = turn1?.steps[0];
    expect(turn1Step).toMatchObject({
      skill: 'training',
      action: 'training_plan_create',
      args: {
        objective: '10K',
        durationWeeks: 12,
        sessionsPerWeek: null,
        startPolicy: 'next_full_week',
      },
    });

    upsertPendingChatAction({
      userId: 77,
      tenantId: 88,
      conversationId,
      skill: 'training',
      action: 'training_plan_create',
      collectedSlots: turn1Step?.args as Record<string, unknown>,
      missingSlots: ['sessionsPerWeek'],
      riskClass: 'R1',
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      originatingSurface: 'api',
      nowIso: NOW,
    });

    const turn2 = await buildChatActionPlan({
      userId: 77,
      tenantId: 88,
      conversationId,
      messageId: 'f26-turn-2',
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      channel: 'api',
      nowIso: '2026-05-16T12:01:00+01:00',
      text: 'Make it 4 sessions per week',
    });

    expect(turn2?.steps[0]).toMatchObject({
      skill: 'training',
      action: 'training_plan_create',
      requiredArgsPresent: true,
      args: {
        objective: '10K',
        durationWeeks: 12,
        sessionsPerWeek: 4,
        startPolicy: 'next_full_week',
      },
    });
    expect(turn2?.steps[0]?.args).not.toHaveProperty('weeklyVolumeKm');
    expect(getActivePendingChatAction({
      userId: 77,
      tenantId: 88,
      conversationId,
      skill: 'training',
      nowIso: '2026-05-16T12:01:00+01:00',
    })?.missingSlots).toEqual(['sessionsPerWeek']);
  });

  it('does not invent a Training draft from a standalone frequency answer', async () => {
    const plan = await buildChatActionPlan({
      userId: 77,
      tenantId: 88,
      conversationId: 'f26-no-pending',
      messageId: 'f26-no-pending-turn',
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      channel: 'api',
      nowIso: NOW,
      text: 'Make it 4 sessions per week',
    });

    expect(plan?.steps.some((step) => step.action === 'training_plan_create')).not.toBe(true);
  });
});
