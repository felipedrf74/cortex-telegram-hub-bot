/**
 * CHARACTERIZATION test for chat-segment-router (M6 reliability backfill,
 * updated by M16 multi-step upgrade).
 *
 * M16 replaced the tasks-only hardcoded $ref action list inside
 * resolvePronounReferenceForStep with registry-declared outputRefs
 * (schema-driven producer/consumer matching). Pins that documented the
 * tasks-only limitation were deliberately flipped — see the per-test
 * justification comments referencing M16.
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

  it('M16: pronoun $ref resolution wires taskId/listId from the prior task-creation producer', async () => {
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

  it('M16 pin flip: a calendar follow-up with a pronoun now gets eventId $ref wiring', async () => {
    // Pre-M16 this pin documented the tasks-only limitation: "schedule an
    // event, then move it" got NO wiring. M16's registry-declared
    // outputRefs (schedule_event -> { eventId: 'event.id' }) fix exactly
    // this case: eventId is wired, while the still-missing start/end times
    // keep the plan in clarification.
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
    expect(followup?.args.eventId).toEqual({ $ref: 'step_1.result.event.id' });
    expect(followup?.args.taskId).toBeUndefined();
    // startDateTime/endDateTime remain unresolved — the step is wired but
    // still not executable, so the clarification flow is preserved.
    expect(followup?.requiredArgsPresent).toBe(false);
    expect(result.plan?.clarificationReason).toBe('missing_required_fields');
    expect(result.plan?.clarificationQuestion).toBe(
      'I need one more detail for secretary_calendar.move_event before I run the full plan.',
    );
  });

  it('M16: cross-domain chaining — create the workout task and add IT to my calendar', async () => {
    // tasks -> secretary_calendar: schedule_event is missing its title;
    // create_task declares outputRefs { title: 'task.title' }, so the
    // pronoun wires the calendar step's title from the created task and the
    // step becomes executable (times/provider were parsed from the text).
    const { builder } = plannerReturning([
      makePlan([makeStep({ args: { title: 'Workout' } })]),
      makePlan([makeStep({
        skill: 'secretary_calendar' as ChatPlanStep['skill'],
        action: 'schedule_event',
        args: {
          startDateTime: '2026-07-21T18:00:00+01:00',
          endDateTime: '2026-07-21T19:00:00+01:00',
          timezone: 'UTC',
          provider: 'google_calendar',
        },
        requiredArgsPresent: false,
      })]),
    ]);
    const segments = [
      makeSegment(0, 'create the workout task'),
      makeSegment(1, 'add it to my calendar at 6pm', { connective: 'and', pronounMentions: ['it'] }),
    ];

    const result = await routeChatMultiStepSegments(PLANNER_INPUT, segments, builder);

    const followup = result.plan?.steps[1];
    expect(followup?.args.title).toEqual({ $ref: 'step_1.result.task.title' });
    expect(followup?.requiredArgsPresent).toBe(true);
    // The wired $ref is data flow — the DAG chains the calendar step onto
    // the task creation even though the connective is a relaxed 'and'.
    expect(followup?.dependsOnStepIds).toEqual(['step_1']);
    expect(result.plan?.clarificationQuestion).toBeUndefined();
  });

  it("M16 adversarial fix (PT repro): 'cria a lista mercado e adiciona leite nela' chains step 2 onto step 1 and wires listId", async () => {
    // Segments come from the REAL splitter so the fix is proven end-to-end:
    // the PT contracted anaphora 'nela' must be extracted and wired through
    // the registry outputRefs of the list-producing step.
    const { splitChatMultiStepRequest } = await import('../../src/services/chat-multi-step-splitter');
    const split = splitChatMultiStepRequest('cria a lista mercado e adiciona leite nela');
    expect(split.segments.map((segment) => segment.text)).toEqual([
      'cria a lista mercado',
      'adiciona leite nela',
    ]);

    const { builder } = plannerReturning([
      makePlan([makeStep({ action: 'create_checklist', args: { title: 'mercado', items: [] } })]),
      makePlan([makeStep({
        action: 'add_subtasks_to_task',
        args: { title: 'mercado', subtasks: ['leite'] },
        requiredArgsPresent: true,
      })]),
    ]);

    const result = await routeChatMultiStepSegments(PLANNER_INPUT, split.segments, builder);

    const followup = result.plan?.steps[1];
    expect(followup?.args.listId).toEqual({ $ref: 'step_1.result.task.listId' });
    expect(followup?.args.taskId).toEqual({ $ref: 'step_1.result.task.id' });
    expect(followup?.dependsOnStepIds).toEqual(['step_1']);
  });

  it("M16 adversarial fix (EN repro): 'create a grocery list and add milk to the list' chains via 'the list' anaphora", async () => {
    const { splitChatMultiStepRequest } = await import('../../src/services/chat-multi-step-splitter');
    const split = splitChatMultiStepRequest('create a grocery list and add milk to the list');
    expect(split.segments.map((segment) => segment.text)).toEqual([
      'create a grocery list',
      'add milk to the list',
    ]);

    const { builder } = plannerReturning([
      makePlan([makeStep({ action: 'create_checklist', args: { title: 'grocery', items: [] } })]),
      makePlan([makeStep({
        action: 'add_subtasks_to_task',
        args: { title: 'milk', subtasks: ['milk'] },
        requiredArgsPresent: true,
      })]),
    ]);

    const result = await routeChatMultiStepSegments(PLANNER_INPUT, split.segments, builder);

    const followup = result.plan?.steps[1];
    expect(followup?.args.listId).toEqual({ $ref: 'step_1.result.task.listId' });
    expect(followup?.dependsOnStepIds).toEqual(['step_1']);
  });

  it('M16 adversarial fix (data-need chaining): a relaxed segment with NO recognized anaphora still wires a missing REQUIRED field a prior producer can supply', async () => {
    // 'and' segments used to run independently whenever pronoun extraction
    // failed — the consumer step then stalled in clarification even though
    // the producer's registry outputRefs could satisfy its required field.
    const { builder } = plannerReturning([
      makePlan([makeStep({ args: { title: 'buy milk' } })]),
      makePlan([makeStep({
        action: 'complete_task',
        args: {},
        requiredArgsPresent: false,
      })]),
    ]);
    const segments = [
      makeSegment(0, 'create a task to buy milk'),
      // Deliberately NO pronounMentions: unrecognized anaphora ('the thing').
      makeSegment(1, 'mark the thing done', { connective: 'and', pronounMentions: [] }),
    ];

    const result = await routeChatMultiStepSegments(PLANNER_INPUT, segments, builder);

    const followup = result.plan?.steps[1];
    expect(followup?.args.taskId).toEqual({ $ref: 'step_1.result.task.id' });
    expect(followup?.requiredArgsPresent).toBe(true);
    expect(followup?.dependsOnStepIds).toEqual(['step_1']);
    expect(result.plan?.clarificationQuestion).toBeUndefined();
  });

  it('M16 data-need chaining stays conservative: no producer for the missing field means no wiring', async () => {
    const { builder } = plannerReturning([
      makePlan([makeStep({ skill: 'secretary_calendar' as ChatPlanStep['skill'], action: 'check_calendar_conflicts', args: {} })]),
      makePlan([makeStep({
        action: 'complete_task',
        args: {},
        requiredArgsPresent: false,
      })]),
    ]);
    const segments = [
      makeSegment(0, 'check my calendar for conflicts'),
      makeSegment(1, 'mark the thing done', { connective: 'and', pronounMentions: [] }),
    ];

    const result = await routeChatMultiStepSegments(PLANNER_INPUT, segments, builder);

    const followup = result.plan?.steps[1];
    expect(followup?.args.taskId).toBeUndefined();
    expect(followup?.requiredArgsPresent).toBe(false);
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
