// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingContinuationHelpers } from '../../src/services/chat/planner/pending-types';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../src/services/chat/types';

const stateMocks = vi.hoisted(() => ({
  getActivePendingChatAction: vi.fn(),
}));

vi.mock('../../src/services/chat-action-state', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/chat-action-state')>(),
  getActivePendingChatAction: stateMocks.getActivePendingChatAction,
}));

import { buildPendingSlotContinuationPlan } from '../../src/services/skills/training/pending';

function trainingInput(text = 'Make it 4 sessions per week'): ChatPlannerInput {
  return {
    text,
    userId: 42,
    tenantId: 84,
    conversationId: 'training-pending-continuation',
    messageId: 'training-pending-continuation-message',
    channel: 'ios',
    locale: 'en',
    timezone: 'Europe/Lisbon',
    nowIso: '2026-08-06T23:58:00+01:00',
    persistRuns: false,
  };
}

function continuationHarness(): {
  helpers: PendingContinuationHelpers;
  buildPlanFromSteps: ReturnType<typeof vi.fn>;
  buildNeedsInputPlan: ReturnType<typeof vi.fn>;
} {
  const buildPlanFromSteps = vi.fn((_input: ChatPlannerInput, steps: ChatPlanStep[]) => ({
    steps,
  }) as ChatActionPlan);
  const buildNeedsInputPlan = vi.fn(() => ({}) as ChatActionPlan);
  return {
    buildPlanFromSteps,
    buildNeedsInputPlan,
    helpers: {
      buildPlanFromSteps,
      buildNeedsInputPlan,
      buildTargetedClarificationQuestion: vi.fn(() => 'Which plan detail should change?'),
    },
  };
}

function pendingDraft(
  collectedSlots: Record<string, unknown>,
  missingSlots: string[],
): Record<string, unknown> {
  return {
    pendingActionId: 'pending-training-focused',
    skill: 'training',
    action: 'training_plan_create',
    userId: 42,
    tenantId: 84,
    conversationId: 'training-pending-continuation',
    collectedSlots,
    missingSlots,
    ttlExpiresAt: '2026-08-07T23:58:00+01:00',
  };
}

describe('Training pending continuation guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMocks.getActivePendingChatAction.mockReturnValue(null);
  });

  it('does not invent a Training plan when frequency arrives without pending context', () => {
    const input = trainingInput();
    const { helpers } = continuationHarness();

    expect(buildPendingSlotContinuationPlan(input, helpers)).toBeNull();
    expect(stateMocks.getActivePendingChatAction).toHaveBeenCalledWith({
      userId: 42,
      tenantId: 84,
      conversationId: 'training-pending-continuation',
      skill: 'training',
      nowIso: '2026-08-06T23:58:00+01:00',
    });
    expect(helpers.buildPlanFromSteps).not.toHaveBeenCalled();
    expect(helpers.buildNeedsInputPlan).not.toHaveBeenCalled();
    expect(helpers.buildTargetedClarificationQuestion).not.toHaveBeenCalled();
  });

  it('adopts pending sessionsPerWeek provenance without overwriting collected canonical fields', () => {
    const input = trainingInput();
    const { helpers, buildPlanFromSteps, buildNeedsInputPlan } = continuationHarness();

    stateMocks.getActivePendingChatAction.mockReturnValue(pendingDraft({
      objective: '10k',
      durationWeeks: 12,
      startPolicy: 'next_full_week',
    }, ['sessionsPerWeek']));
    const adopted = buildPendingSlotContinuationPlan(input, helpers);
    expect(adopted?.steps[0]).toMatchObject({
      args: {
        objective: '10k',
        durationWeeks: 12,
        sessionsPerWeek: 4,
        startPolicy: 'next_full_week',
      },
      slotProvenance: {
        sessionsPerWeek: {
          slot: 'sessionsPerWeek',
          value: 4,
          rawText: input.text,
          turnId: input.messageId,
          normalizer: 'training_sessions_per_week_v1',
          validation: 'passed',
        },
      },
    });

    stateMocks.getActivePendingChatAction.mockReturnValue(pendingDraft({
      objective: '10k',
      durationWeeks: 12,
      sessionsPerWeek: 5,
    }, ['startPolicy']));
    buildPendingSlotContinuationPlan(input, helpers);
    expect(buildNeedsInputPlan).toHaveBeenLastCalledWith(input, expect.objectContaining({
      args: expect.objectContaining({ sessionsPerWeek: 5 }),
    }));
    expect(buildPlanFromSteps).toHaveBeenCalledTimes(1);

    // A recovered draft's explicit missing-slot list is authoritative even
    // when stale collected data still contains a value for that same slot.
    stateMocks.getActivePendingChatAction.mockReturnValue(pendingDraft({
      objective: '10k',
      durationWeeks: 12,
      sessionsPerWeek: 5,
      startPolicy: 'next_full_week',
    }, ['sessionsPerWeek']));
    expect(buildPendingSlotContinuationPlan(input, helpers)?.steps[0]?.args.sessionsPerWeek).toBe(4);

    // Conversely, a null collected value remains fillable when a recovered
    // legacy missing-slot list forgot to name it.
    stateMocks.getActivePendingChatAction.mockReturnValue(pendingDraft({
      objective: '10k',
      durationWeeks: 12,
      sessionsPerWeek: null,
    }, ['startPolicy']));
    expect(buildPendingSlotContinuationPlan(input, helpers)?.steps[0]?.args.sessionsPerWeek).toBe(4);
    expect(buildPlanFromSteps).toHaveBeenCalledTimes(3);
  });
});
