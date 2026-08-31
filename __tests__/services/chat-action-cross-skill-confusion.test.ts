// Phase 3 batch 17 (2026-05-15): cross-skill confusion fixtures.
//
// Documents the planner's priority when a phrase could plausibly route to
// more than one skill. Each fixture pins the expected winner, the runner-up
// that COULD claim, and the reason the chosen action wins.
//
// Pattern: each fixture documents (a) the surface ambiguity, (b) the
// disambiguating signal, (c) the chosen skill+action. If a new parser feature
// causes the runner-up to win, this test fails loudly — adjust deliberately.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/chat-action-state', () => ({
  cancelPendingChatActions: vi.fn(() => 0),
  getActivePendingChatAction: vi.fn(() => null),
  markPendingChatActionNeedsUserFollowup: vi.fn(() => false),
  recordChatActionTelemetry: vi.fn(),
  rememberRecentChatEntity: vi.fn(),
  resolveRecentChatEntity: vi.fn(() => ({ status: 'none', candidates: [] })),
  upsertPendingChatAction: vi.fn(),
  makeSlotProvenance: vi.fn((input: any) => ({
    slot: input.slot, value: input.value, rawText: input.rawText ?? null,
    turnId: input.turnId, spanStart: input.spanStart ?? null, spanEnd: input.spanEnd ?? null,
    sourceType: input.sourceType ?? 'user_message', normalizer: input.normalizer,
    confidence: input.confidence, validation: input.validation ?? 'passed',
  })),
}));

import {
  buildDeterministicChatActionPlan,
  type ChatPlannerInput,
} from '../../src/services/chat';

const FROZEN_NOW = '2026-05-14T12:00:00+01:00';

function input(text: string, locale: string = 'en-US'): ChatPlannerInput {
  return {
    userId: 1, tenantId: 1,
    conversationId: `confusion-${Date.now()}-${Math.random()}`,
    messageId: `confusion-msg-${Date.now()}-${Math.random()}`,
    locale, timezone: 'Europe/Lisbon', channel: 'telegram',
    text, nowIso: FROZEN_NOW,
  };
}

interface ConfusionFixture {
  text: string;
  locale?: string;
  expectedSkill: string;
  expectedAction: string;
  runnerUp: string;
  reason: string;
}

const FIXTURES: ConfusionFixture[] = [
  {
    text: 'Remind me to pay the credit card on Friday',
    expectedSkill: 'finance',
    expectedAction: 'finance_create_reminder',
    runnerUp: 'tasks.set_task_reminder OR tasks.create_task',
    reason:
      '"credit card" anchors the message to finance domain. The finance parser claims before tasks because notifications/decisions run first in parseBroadSkillActionIntent and finance precedes tasks in the broad-skill order via the "lembrete/reminder" + financial-object combination.',
  },
  {
    text: 'Add a task called call Pedro for tomorrow at 5pm',
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    runnerUp: 'tasks.set_task_reminder, finance.finance_create_reminder',
    reason:
      'Explicit "task called X" form. The Phase 2 batch 11 "Add" verb extension + literal-title policy means the title is "call Pedro" and the due slot is populated. Finance reminder requires a financial object (credit card, fatura, etc.) which is absent.',
  },
  {
    text: 'Schedule a meeting called workout review for Friday at 2pm',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'schedule_event',
    runnerUp: 'training.training_explain_session (because of "workout")',
    reason:
      '"Schedule a [meeting/event] called X for [time]" routes to the natural-language calendar parser before the training-gate has a chance. The literal-title span ("workout review") survives unchanged via the title-marker pattern. Training would only claim if the message lacked the calendar object "meeting".',
  },
  {
    text: 'Plan my meals for next week',
    expectedSkill: 'cooking',
    expectedAction: 'cooking_meal_support',
    runnerUp: 'secretary_calendar.schedule_event, training.training_plan_create',
    reason:
      '"meals" anchors to Cooking, while a bulk weekly request remains advisory because the executable write contract persists one dated meal slot at a time.',
  },
  {
    text: 'Plan my training for the next 12 weeks',
    expectedSkill: 'training',
    expectedAction: 'training_plan_create',
    runnerUp: 'secretary_calendar.schedule_event, cooking.cooking_meal_plan',
    reason:
      '"training" anchors to training. The "for the next 12 weeks" temporal scope is consistent with a multi-week plan, and the create-verb "plan" + training-object satisfies parseTrainingActionStep.',
  },
  {
    text: 'Cancel the meeting with Pedro',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'delete_event',
    runnerUp: 'decision_center.decision_dismiss',
    reason:
      '"meeting" anchors to calendar mutations. Decision dismiss requires explicit "decision" noun, which is absent.',
  },
  {
    text: 'Show me what I have on Friday',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'summarize_agenda',
    runnerUp: 'tasks (which tasks are due Friday)',
    reason:
      'Conversational agenda-query — the calendar read-intent short-circuit at top-of-planner claims. Task-due queries require an explicit "tasks" reference.',
  },
  {
    text: 'Any new mail from Pedro this morning',
    expectedSkill: 'mail',
    expectedAction: 'mail_unread_count',
    runnerUp: 'secretary_calendar (because of "this morning")',
    reason:
      '"new mail" anchors to mail.unread_count. The temporal qualifier "this morning" doesn\'t shift the dominant object.',
  },
  {
    text: "What's on my agenda today",
    expectedSkill: 'secretary_calendar',
    expectedAction: 'summarize_agenda',
    runnerUp: 'tasks (today\'s tasks)',
    reason:
      'Top-of-planner calendar read-intent claims. "Agenda" is the dominant noun; tasks would need explicit "tasks/todos" object.',
  },
  {
    text: 'Marca essa tarefa como feita',
    locale: 'pt-PT',
    expectedSkill: 'tasks',
    expectedAction: 'complete_task',
    runnerUp: 'secretary_calendar.schedule_event (because "marca" is a calendar write verb in PT)',
    reason:
      'The complete-task-by-mark short-circuit (parseCompleteTaskByMarkIntent) runs BEFORE parseNaturalLanguageCalendarEvent\'s ability to claim "marca" + tarefa. The mark-as-done pattern is specific enough to beat the generic calendar-write verb.',
  },
  // Phase 4 batch 21 (2026-05-15): 15 additional confusion axes documenting
  // priority between non-trivial cross-skill pairs.
  {
    text: 'Schedule a follow-up email for Friday',
    expectedSkill: 'mail',
    expectedAction: 'mail_unread_count',
    runnerUp: 'secretary_calendar.schedule_event (because "schedule for Friday")',
    reason:
      'Mail parser runs before calendar parser in parseBroadSkillActionIntent and matches "email". The default mail branch is unread_count when no specific verb-class match. Calendar would need an explicit event-noun ("meeting", "event") to claim.',
  },
  {
    text: 'Schedule a recording session for the meal-prep reel on Sunday',
    expectedSkill: 'content',
    expectedAction: 'content_schedule_work',
    runnerUp: 'cooking.cooking_meal_plan (because "meal-prep"), secretary_calendar.schedule_event',
    reason:
      'The explicit recording-session noun makes this local Content work rather than publication scheduling; the dominant content noun "reel" wins.',
  },
  {
    text: 'Create a notification when my budget goes negative',
    expectedSkill: 'notifications',
    expectedAction: 'notification_create_intent',
    runnerUp: 'finance.finance_summary (because of "budget")',
    reason:
      'Notifications parser runs FIRST in parseBroadSkillActionIntent (Phase 2 reorder). "Create a notification" satisfies the create-intent fallback; "budget" is the trigger condition, not the matrix object.',
  },
  {
    text: 'Add a workout task for Saturday',
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    runnerUp: 'training.training_explain_session (because "workout"), secretary_calendar.schedule_event',
    reason:
      '"task" is the dominant object and "Add" is a Phase 2-extended create-verb. The simple-task parser claims before training_explain_session\'s fallback path.',
  },
  {
    text: 'Create a task to review the Stripe report',
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    runnerUp: 'finance.finance_summary (because "Stripe")',
    reason:
      'Explicit "Create a task" satisfies parseSimpleTaskStep. The "Stripe" mention is a TITLE token, not a finance gate trigger — the title span comes after "task to".',
  },
  {
    text: 'Write a script about my training week',
    expectedSkill: 'content',
    expectedAction: 'content_script_create',
    runnerUp: 'training.training_coach_report (because "training")',
    reason:
      'Content gate ("script") + create-verb ("Write") fires before training_coach_report which requires "coach|report|relatorio" keyword.',
  },
  {
    text: 'Snooze the notification about the readiness drop',
    expectedSkill: 'notifications',
    expectedAction: 'notification_create_intent',
    runnerUp: 'decision_center.decision_snooze (because "Snooze")',
    reason:
      '"notification" is the dominant object — notifications parser runs first. Decision_snooze would need an explicit "decision" noun. Note: future Phase 5 could add a `notification_dismiss` action; for now, snooze + notification routes to create_intent fallback.',
  },
  {
    text: 'Schedule my long run for Saturday at 7am',
    expectedSkill: 'training',
    expectedAction: 'training_explain_session',
    runnerUp: 'secretary_calendar.schedule_event (because "Schedule")',
    reason:
      '"long run" is in the training-skill gate; training parser claims at the broad-skill phase. Calendar parser fails because the message lacks an explicit calendar-object ("event", "meeting", "appointment"). Behaviour documents an edge — Felipe may want this to route to calendar in the future when scheduling existing-plan sessions.',
  },
  {
    text: 'Categorize this receipt as travel and add a reminder',
    expectedSkill: 'finance',
    expectedAction: 'finance_categorize_receipt',
    runnerUp: 'finance.finance_create_reminder (because "add a reminder")',
    reason:
      'Categorize-receipt branch runs BEFORE reminder branch in parseFinanceActionStep (Phase 1 batch 6). The "add a reminder" tail is treated as a secondary action; the primary categorization claims.',
  },
  {
    text: 'Pay the credit card bill',
    expectedSkill: 'finance',
    expectedAction: 'finance_payment_action',
    runnerUp: 'finance.finance_create_reminder (because "credit card" anchors finance)',
    reason:
      'Direct "Pay" verb + "credit card bill" object — the finance parser\'s payment branch claims after the reminder check fails (no "remind me" form).',
  },
  {
    text: 'Show me the agenda for the dentist appointment',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'summarize_agenda',
    runnerUp: 'tasks (if "dentist" is interpreted as a task name)',
    reason:
      'The calendar-read short-circuit fires on "show me the agenda" (Phase 2 batch 11 conversational pattern). "dentist appointment" is the scope qualifier, not the matrix verb.',
  },
  {
    text: 'Adjust my training to add more long runs',
    expectedSkill: 'training',
    expectedAction: 'training_adjust_plan',
    runnerUp: 'training.training_explain_session',
    reason:
      '"adjust" matches the adjust verb in parseTrainingActionStep, claiming before the explain fallback. Without an explicit adjust-verb, the training gate would route to training_explain_session.',
  },
  {
    text: 'Reschedule the dentist event to 4pm',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'move_event',
    runnerUp: 'secretary_calendar.update_event (because "reschedule" overlaps both)',
    reason:
      'Move/reschedule verbs in parseCalendarMutationIntent are checked BEFORE update verbs. "Reschedule" is explicit move-intent — a time change rather than a field change.',
  },
  {
    text: 'Am I free Friday morning to take a call',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'check_calendar_conflicts',
    runnerUp: 'secretary_calendar.summarize_agenda',
    reason:
      'Conflict-check intent claims via the explicit "am I free" pattern in parseCheckCalendarConflictsIntent. summarize_agenda would lose because it needs "agenda" or the conversational read-form. The "take a call" tail is descriptive, not a calendar object.',
  },
  {
    text: 'Mostra a lista de compras desta semana',
    locale: 'pt-PT',
    expectedSkill: 'cooking',
    expectedAction: 'cooking_meal_support',
    runnerUp: 'tasks.create_checklist (because "lista")',
    reason:
      'Cooking claims the qualified shopping-list read before task checklist parsing, and "mostra" keeps it read-only instead of regenerating persisted list state.',
  },
];

describe('cross-skill confusion priority (Phase 3 batch 17)', () => {
  for (const fixture of FIXTURES) {
    it(`"${fixture.text}" → ${fixture.expectedSkill}.${fixture.expectedAction}`, () => {
      const plan = buildDeterministicChatActionPlan(input(fixture.text, fixture.locale ?? 'en-US'));
      expect(plan, `plan must not be null for confusion fixture: ${fixture.text}`).not.toBeNull();
      const step = plan?.steps[0];
      expect(step?.skill, `runner-up was: ${fixture.runnerUp}\nreason: ${fixture.reason}`).toBe(
        fixture.expectedSkill,
      );
      expect(step?.action, `runner-up was: ${fixture.runnerUp}\nreason: ${fixture.reason}`).toBe(
        fixture.expectedAction,
      );
    });
  }

  it('every fixture has a non-empty reason and runner-up note', () => {
    for (const fixture of FIXTURES) {
      expect(fixture.reason.length).toBeGreaterThan(30);
      expect(fixture.runnerUp.length).toBeGreaterThan(0);
    }
  });

  it('covers a meaningful set of cross-skill axes', () => {
    const skills = new Set(FIXTURES.map((f) => f.expectedSkill));
    expect(skills.size).toBeGreaterThanOrEqual(5);
  });
});
