/**
 * CHARACTERIZATION test for chat-segment-router (M6 reliability backfill).
 *
 * These are pins of CURRENT behavior, including known limitations —
 * most importantly the tasks-only $ref resolution inside
 * resolvePronounReferenceForStep. M16 (multi-step upgrade) is expected to
 * change several of these pins deliberately; when it does, update the pins
 * with intent instead of treating a diff here as a regression.
 */

import { describe, expect, it, vi } from 'vitest';

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

import { routeChatMultiStepSegments } from '../../src/services/chat-segment-router';
import type { ChatMultiStepSegment } from '../../src/services/chat-multi-step-splitter';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../src/services/chat/types';

const NOW_ISO = '2026-07-20T12:00:00.000Z';

const PLANNER_INPUT: ChatPlannerInput = {
  text: 'create a task to buy milk and then complete it',
  userId: 4242,
  tenantId: 4242,
  conversationId: 'conv-1',
  messageId: 'msg-1',
  channel: 'ios',
  locale: 'en-US',
  timezone: 'UTC',
  nowIso: NOW_ISO,
};

function makeSegment(index: number, text: string, overrides: Partial<ChatMultiStepSegment> = {}): ChatMultiStepSegment {
  return {
    index,
    text,
    connective: index === 0 ? null : 'and then',
    pronounMentions: [],
    ...overrides,
  };
}

function makeStep(overrides: Partial<ChatPlanStep> = {}): ChatPlanStep {
  return {
    stepId: 'step_x',
    skill: 'tasks',
    type: 'provider_write',
    action: 'create_task',
    risk: 'safe_write',
    args: { title: 'buy milk' },
    requiredArgsPresent: true,
    idempotencyKey: 'idem-1',
    verification: { required: false, method: 'none' },
    ...overrides,
  } as ChatPlanStep;
}

function makePlan(steps: ChatPlanStep[], overrides: Partial<ChatActionPlan> = {}): ChatActionPlan {
  return {
    schemaVersion: 1,
    userId: '4242',
    tenantId: '4242',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    locale: 'en-US',
    timezone: 'UTC',
    channel: 'ios',
    createdAt: NOW_ISO,
    planner: 'deterministic',
    steps,
    requiresConfirmation: false,
    confidence: 0.9,
    ...overrides,
  };
}

function plannerReturning(plans: Array<ChatActionPlan | null>) {
  const calls: ChatPlannerInput[] = [];
  const builder = vi.fn(async (input: ChatPlannerInput) => {
    calls.push(input);
    return plans[calls.length - 1] ?? null;
  });
  return { builder, calls };
}

describe('chat-segment-router (characterization pins)', () => {
  it('CURRENT: merges per-segment plans into one mixed plan with segment-suffixed message ids', async () => {
    const { builder, calls } = plannerReturning([
      makePlan([makeStep()]),
      makePlan([makeStep({ action: 'complete_task', args: { taskId: 'task-1' } })], { confidence: 0.8 }),
    ]);
    const segments = [
      makeSegment(0, 'create a task to buy milk'),
      makeSegment(1, 'complete it'),
    ];

    const result = await routeChatMultiStepSegments(PLANNER_INPUT, segments, builder);

    expect(result.blockedReason).toBeUndefined();
    expect(calls.map((call) => call.messageId)).toEqual(['msg-1:segment-1', 'msg-1:segment-2']);
    expect(calls.map((call) => call.text)).toEqual(['create a task to buy milk', 'complete it']);
    expect(result.plan).toMatchObject({
      planner: 'mixed',
      messageId: 'msg-1',
      confidence: 0.8,
      effectiveConfidence: 0.8,
      // The DAG forces confirmation for any >=2-step plan.
      requiresConfirmation: true,
    });
    expect(result.plan?.steps.map((step) => step.stepId)).toEqual(['step_1', 'step_2']);
    expect(result.plan?.steps[1]?.dependsOnStepIds).toEqual(['step_1']);
    expect(result.plan?.debug?.routingSignals).toEqual(
      expect.arrayContaining(['multi_step_segment_router', 'multi_step_splitter', 'multi_step_dag']),
    );
  });

  it('CURRENT: blocks as segment_unresolved when any segment yields no plan or no steps', async () => {
    const nullPlan = await routeChatMultiStepSegments(
      PLANNER_INPUT,
      [makeSegment(0, 'create a task'), makeSegment(1, 'gibberish')],
      plannerReturning([makePlan([makeStep()]), null]).builder,
    );
    expect(nullPlan).toEqual({ plan: null, blockedReason: 'segment_unresolved' });

    const emptyPlan = await routeChatMultiStepSegments(
      PLANNER_INPUT,
      [makeSegment(0, 'create a task')],
      plannerReturning([makePlan([])]).builder,
    );
    expect(emptyPlan).toEqual({ plan: null, blockedReason: 'segment_unresolved' });
  });

  it('CURRENT: surfaces a refused segment plan as segment_refused', async () => {
    const refusedPlan = makePlan([
      makeStep({ args: { rejectionReason: 'policy_blocked' } }),
    ]);

    const result = await routeChatMultiStepSegments(
      PLANNER_INPUT,
      [makeSegment(0, 'do something disallowed')],
      plannerReturning([refusedPlan]).builder,
    );

    expect(result.blockedReason).toBe('segment_refused');
    expect(result.plan).toBe(refusedPlan);
  });

  it('CURRENT LIMITATION: pronoun $ref resolution only targets prior TASKS creation steps', async () => {
    const { builder } = plannerReturning([
      makePlan([makeStep()]),
      makePlan([makeStep({
        action: 'complete_task',
        args: {},
        requiredArgsPresent: false,
      })]),
    ]);
    const segments = [
      makeSegment(0, 'create a task to buy milk'),
      makeSegment(1, 'then complete it', { pronounMentions: ['it'] }),
    ];

    const result = await routeChatMultiStepSegments(PLANNER_INPUT, segments, builder);

    const followup = result.plan?.steps[1];
    expect(followup?.args.taskId).toEqual({ $ref: 'step_1.result.task.id' });
    expect(followup?.args.listId).toEqual({ $ref: 'step_1.result.task.listId' });
    // complete_task/delete_task are force-marked ready once the $ref is wired.
    expect(followup?.requiredArgsPresent).toBe(true);
    expect(result.plan?.clarificationQuestion).toBeUndefined();
  });

  it('CURRENT LIMITATION: a calendar follow-up with a pronoun gets NO $ref wiring', async () => {
    // "schedule an event, then move it" — move_event is not in the
    // tasks-only action list, so the pronoun is silently ignored and the
    // step stays missing its required args. M16 owns fixing this.
    const { builder } = plannerReturning([
      makePlan([makeStep({ skill: 'secretary_calendar' as ChatPlanStep['skill'], action: 'schedule_event', args: { title: 'standup' } })]),
      makePlan([makeStep({
        skill: 'secretary_calendar' as ChatPlanStep['skill'],
        action: 'move_event',
        args: {},
        requiredArgsPresent: false,
      })]),
    ]);
    const segments = [
      makeSegment(0, 'schedule standup tomorrow'),
      makeSegment(1, 'then move it to 5pm', { pronounMentions: ['it'] }),
    ];

    const result = await routeChatMultiStepSegments(PLANNER_INPUT, segments, builder);

    const followup = result.plan?.steps[1];
    expect(followup?.args.taskId).toBeUndefined();
    expect(followup?.args.$ref).toBeUndefined();
    expect(followup?.requiredArgsPresent).toBe(false);
    expect(result.plan?.clarificationReason).toBe('missing_required_fields');
    expect(result.plan?.clarificationQuestion).toBe(
      'I need one more detail for secretary_calendar.move_event before I run the full plan.',
    );
  });

  it('CURRENT LIMITATION: a task follow-up with a pronoun but no prior task-creation step stays unresolved', async () => {
    const { builder } = plannerReturning([
      makePlan([makeStep({ skill: 'secretary_calendar' as ChatPlanStep['skill'], action: 'schedule_event', args: { title: 'standup' } })]),
      makePlan([makeStep({
        action: 'complete_task',
        args: {},
        requiredArgsPresent: false,
      })]),
    ]);
    const segments = [
      makeSegment(0, 'schedule standup tomorrow'),
      makeSegment(1, 'then complete it', { pronounMentions: ['it'] }),
    ];

    const result = await routeChatMultiStepSegments(PLANNER_INPUT, segments, builder);

    const followup = result.plan?.steps[1];
    expect(followup?.args.taskId).toBeUndefined();
    expect(followup?.requiredArgsPresent).toBe(false);
  });

  it('CURRENT: pronoun wiring keeps caller-provided ids and resolves to the LAST task creation', async () => {
    const { builder } = plannerReturning([
      makePlan([makeStep({ args: { title: 'first' } })]),
      makePlan([makeStep({ args: { title: 'second' } })]),
      makePlan([makeStep({
        action: 'update_task',
        args: { taskId: 'explicit-id', note: 'x' },
        requiredArgsPresent: false,
      })]),
    ]);
    const segments = [
      makeSegment(0, 'create task first'),
      makeSegment(1, 'create task second'),
      makeSegment(2, 'then update it', { pronounMentions: ['it'] }),
    ];

    const result = await routeChatMultiStepSegments(PLANNER_INPUT, segments, builder);

    const followup = result.plan?.steps[2];
    // Explicit taskId wins; only the missing listId gets a $ref — and it
    // points at the most recent task-creation step (step_2).
    expect(followup?.args.taskId).toBe('explicit-id');
    expect(followup?.args.listId).toEqual({ $ref: 'step_2.result.task.listId' });
    // update_task is not force-marked ready.
    expect(followup?.requiredArgsPresent).toBe(false);
  });

  it('CURRENT: pt locale produces the Portuguese clarification and localized fallback', async () => {
    const { builder } = plannerReturning([
      makePlan([makeStep({ args: {}, requiredArgsPresent: false })]),
    ]);

    const result = await routeChatMultiStepSegments(
      { ...PLANNER_INPUT, locale: 'pt-BR' },
      [makeSegment(0, 'criar tarefa')],
      builder,
    );

    expect(result.plan?.locale).toBe('pt-BR');
    expect(result.plan?.clarificationQuestion).toBe(
      'Preciso de mais um detalhe para completar tasks.create_task antes de executar o plano completo.',
    );
  });

  it('CURRENT: empty locale falls back to pt-BR and empty segments block as empty', async () => {
    const { builder } = plannerReturning([]);
    const result = await routeChatMultiStepSegments(
      { ...PLANNER_INPUT, locale: '' },
      [],
      builder,
    );

    // No segments -> no steps -> DAG reports 'empty'.
    expect(result).toEqual({ plan: null, blockedReason: 'empty' });
  });

  it('CURRENT: requiresConfirmation propagates from any segment plan and telemetry pins tier0', async () => {
    const { builder } = plannerReturning([
      makePlan([makeStep()], { requiresConfirmation: true, confidence: 0.95 }),
    ]);

    const result = await routeChatMultiStepSegments(
      PLANNER_INPUT,
      [makeSegment(0, 'create a task to buy milk')],
      builder,
    );

    expect(result.plan?.requiresConfirmation).toBe(true);
    expect(result.plan?.telemetry).toMatchObject({
      routeTier: 'tier0_deterministic',
      calibratedScore: 0.95,
      threshold: 0.72,
      verifierStatus: 'not_required',
    });
    expect(result.plan?.locale).toBe('en-US');
  });
});
