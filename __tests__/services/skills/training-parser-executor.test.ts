import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeSlotProvenance: vi.fn((input: any) => ({
    slot: input.slot,
    value: input.value,
    rawText: input.rawText ?? null,
    turnId: input.turnId,
    spanStart: input.spanStart ?? null,
    spanEnd: input.spanEnd ?? null,
    sourceType: input.sourceType ?? 'user_message',
    normalizer: input.normalizer,
    confidence: input.confidence,
    validation: input.validation ?? 'passed',
  })),
  upsertPendingChatAction: vi.fn(() => ({ id: 'pending-training-plan' })),
  previewTrainingSessionReflow: vi.fn(),
  confirmTrainingSessionReflow: vi.fn(),
  getActivePlanSummary: vi.fn(),
  getPlanById: vi.fn(),
  getSessionById: vi.fn(),
}));

vi.mock('../../../src/services/chat-action-state', () => ({
  makeSlotProvenance: mocks.makeSlotProvenance,
  upsertPendingChatAction: mocks.upsertPendingChatAction,
}));

vi.mock('../../../src/api/routes/training-plan-calendar-sync', () => ({
  previewTrainingSessionReflow: mocks.previewTrainingSessionReflow,
  confirmTrainingSessionReflow: mocks.confirmTrainingSessionReflow,
}));

vi.mock('../../../src/services/training-plans', () => ({
  getActivePlanSummary: mocks.getActivePlanSummary,
  getPlanById: mocks.getPlanById,
  getSessionById: mocks.getSessionById,
}));

import { foldCalendarText } from '../../../src/services/calendar-natural-language-parser';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../../src/services/chat/types';
import {
  executeTrainingCoachReportStep,
  executeTrainingExplainSessionStep,
  executeTrainingPlanCreateStep,
  executeTrainingReflowStep,
} from '../../../src/services/skills/training/executor';
import { extractTrainingPlanSlots, extractTrainingStartDate, extractWeeklyVolumeKm } from '../../../src/services/skills/training/helpers';
import { parseTrainingActionStep } from '../../../src/services/skills/training/parser';

const NOW_ISO = '2026-05-13T10:00:00+01:00';

function plannerInput(text: string): ChatPlannerInput {
  return {
    userId: 42,
    tenantId: 42,
    conversationId: 'training-parser-executor',
    messageId: 'training-parser-executor-message',
    channel: 'ios',
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
    text,
    nowIso: NOW_ISO,
  };
}

function parse(text: string): ChatPlanStep | null {
  return parseTrainingActionStep(
    {
      ...plannerInput(text),
      timezone: 'Europe/Lisbon',
      messageId: `msg-${text}`,
    },
    foldCalendarText(text),
  );
}

function planWithStep(step: ChatPlanStep): ChatActionPlan {
  return {
    schemaVersion: 1,
    userId: '42',
    tenantId: '42',
    conversationId: 'training-parser-executor',
    messageId: 'training-parser-executor-message',
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
    channel: 'ios',
    createdAt: NOW_ISO,
    planner: 'deterministic',
    steps: [step],
    requiresConfirmation: false,
    confidence: 0.9,
  };
}

describe('training parser and executor hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires tenant scope for training coach report reads', () => {
    const step = {
      stepId: 'training-report',
      skill: 'training',
      type: 'training_coach_report',
      action: 'training_coach_report',
      args: {},
    } as unknown as ChatPlanStep;
    const input = { ...plannerInput('training report'), tenantId: 0 } as ChatPlannerInput;

    const result = executeTrainingCoachReportStep(step, input);

    expect(result).toMatchObject({
      status: 'blocked',
      error: 'training_tenant_scope_required',
    });
    expect(mocks.getActivePlanSummary).not.toHaveBeenCalled();
  });

  it('passes tenant scope to training coach report summary reads', () => {
    mocks.getActivePlanSummary.mockReturnValueOnce('Tenant-scoped plan');
    const step = {
      stepId: 'training-report',
      skill: 'training',
      type: 'training_coach_report',
      action: 'training_coach_report',
      args: {},
    } as unknown as ChatPlanStep;

    const result = executeTrainingCoachReportStep(step, plannerInput('training report'));

    expect(result).toMatchObject({
      status: 'verified_success',
      result: { summary: 'Tenant-scoped plan' },
    });
    expect(mocks.getActivePlanSummary).toHaveBeenCalledWith(42, 42);
  });

  it('blocks same-user training session explains across tenants', () => {
    mocks.getSessionById.mockReturnValueOnce({ id: 501, plan_id: 900, title: 'Tempo', session_type: 'run' });
    mocks.getPlanById.mockReturnValueOnce({ id: 900, user_id: 42, tenant_id: 99 });
    const step = {
      stepId: 'training-explain',
      skill: 'training',
      type: 'training_explain_session',
      action: 'training_explain_session',
      args: { sessionId: 501 },
    } as unknown as ChatPlanStep;

    const result = executeTrainingExplainSessionStep(step, plannerInput('explain training session'));

    expect(result).toMatchObject({
      status: 'blocked',
      error: 'training_session_not_found_or_unauthorized',
    });
  });

  it('extracts Portuguese running verbs as running sport', () => {
    const extracted = extractTrainingPlanSlots({
      ...plannerInput('Quero correr 50 km por semana para maratona em 12 semanas começando segunda'),
      text: 'Quero correr 50 km por semana para maratona em 12 semanas começando segunda',
    });

    expect(extracted.slots.sport).toBe('running');
  });

  it('stops goal extraction before Spanish duration qualifiers', () => {
    const extracted = extractTrainingPlanSlots({
      ...plannerInput('Create a running plan para maratona en 12 semanas starting Monday, 50 km per week'),
      text: 'Create a running plan para maratona en 12 semanas starting Monday, 50 km per week',
    });

    expect(extracted.slots.goal).toBe('maratona');
    expect(String(extracted.slots.goal)).not.toContain('12 semanas');
  });

  it('parses weekday training start dates from English and Portuguese phrases', () => {
    expect(extractTrainingStartDate({
      ...plannerInput('Create a training plan starting Monday'),
      text: 'Create a training plan starting Monday',
    })?.value).toBe('2026-05-18');

    expect(extractTrainingStartDate({
      ...plannerInput('Cria um plano de treino começando segunda'),
      text: 'Cria um plano de treino começando segunda',
    })?.value).toBe('2026-05-18');
  });

  it('only extracts weekly volume when the km value is explicitly weekly', () => {
    expect(extractWeeklyVolumeKm('I ran 10 km yesterday, plan my training for the week')).toBeNull();
    expect(extractWeeklyVolumeKm('I am running 50 km per week')).toBe(50);
    expect(extractWeeklyVolumeKm('Minha semana tem 42 km')).toBe(42);
  });

  it('does not route generic plans, reports, or budget changes into training', () => {
    expect(parse('Generate a report generator plan')).toBeNull();
    expect(parse('Make a plan')).toBeNull();
    expect(parse('Adjust my budget plan')).toBeNull();
    expect(parse('Adjust my plan')).toBeNull();
    expect(parse('ajusta mi plan')).toBeNull();
  });

  it('still routes qualified training adjustments', () => {
    const step = parse('Adjust my training plan to reduce intensity this week');

    expect(step?.skill).toBe('training');
    expect(step?.action).toBe('training_adjust_plan');
  });

  it('dry-run plan creation does not create pending chat action rows', () => {
    const step = parse('Create a training plan for the next 12 weeks');
    expect(step).not.toBeNull();

    const result = executeTrainingPlanCreateStep(
      step as ChatPlanStep,
      planWithStep(step as ChatPlanStep),
      plannerInput('Create a training plan for the next 12 weeks'),
      false,
    );

    expect(result.status).toBe('verified_pending');
    expect(result.result).toMatchObject({
      pendingActionId: null,
      openSurface: 'training_plan_builder',
      verified: false,
    });
    expect(mocks.upsertPendingChatAction).not.toHaveBeenCalled();
  });

  it('maps missing reflow preview sessions to blocked instead of failed', async () => {
    mocks.previewTrainingSessionReflow.mockResolvedValueOnce({
      status: 'not_found',
      data: { reason: 'session_not_found' },
    });
    const step = {
      ...(parse('Show me the training reflow preview') as ChatPlanStep),
      args: { sessionId: 123, rawRequest: 'Show me the training reflow preview' },
    };

    const result = await executeTrainingReflowStep(
      step,
      planWithStep(step),
      plannerInput('Show me the training reflow preview'),
      false,
      false,
    );

    expect(result.status).toBe('blocked');
    expect(result.error).toBe('session_not_found');
  });
});
