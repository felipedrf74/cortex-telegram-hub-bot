// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M19 — plan-level cross-skill ownership transform.
 *
 * Failing-first evidence (pre-M19 probe, 2026-07-20): the fixture
 * "create this week's workout plan and add it to my calendar" planned its
 * second segment as tasks.add_subtasks_to_task with title "calendar" and
 * subtasks ["it"] — a calendar-placement intent executed by the wrong skill.
 * These tests pin the manifest-driven rewrite that fixes that class of
 * misroute, plus the flag/master-kill gating and the synthetic-manifest-row
 * proof that nothing is hardcoded per skill.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/utils/logger', () => ({
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

import {
  _resetCrossSkillOwnershipForTests,
  applyCrossSkillOwnershipToSteps,
  enforceCrossSkillPreview,
  executableSkillsForPlan,
  getChatActionOwnershipRows,
  isCrossSkillExecutionEnabled,
  CROSS_SKILL_EXECUTION_ENV_VAR,
} from '../../../../src/services/chat/planner/cross-skill-ownership';
import { MANIFEST_ROUTING_MASTER_KILL_ENV_VAR } from '../../../../src/services/intent-resolution/manifest-routing-flags';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../../../src/services/chat/types';

const INPUT: ChatPlannerInput = {
  text: "create this week's workout plan and add it to my calendar",
  userId: 91,
  tenantId: 91,
  conversationId: 'conv-m19',
  messageId: 'msg-m19',
  channel: 'ios',
  locale: 'en-US',
  timezone: 'UTC',
  nowIso: '2026-07-20T12:00:00.000Z',
};

function makeStep(overrides: Partial<ChatPlanStep>): ChatPlanStep {
  return {
    stepId: 'step-test',
    skill: 'tasks',
    type: 'provider_write',
    action: 'add_subtasks_to_task',
    risk: 'safe_write',
    riskClass: 'R1',
    provider: 'nexus',
    args: { title: 'calendar', subtasks: ['it'] },
    requiredArgsPresent: true,
    idempotencyKey: 'idem-test',
    verification: { required: false, method: 'none' },
    ...overrides,
  } as ChatPlanStep;
}

beforeEach(() => {
  _resetCrossSkillOwnershipForTests();
});

describe('isCrossSkillExecutionEnabled', () => {
  it('defaults OFF', () => {
    expect(isCrossSkillExecutionEnabled({})).toBe(false);
  });

  it('enables via AI_CROSS_SKILL_EXECUTION', () => {
    expect(isCrossSkillExecutionEnabled({ [CROSS_SKILL_EXECUTION_ENV_VAR]: 'true' })).toBe(true);
    expect(isCrossSkillExecutionEnabled({ [CROSS_SKILL_EXECUTION_ENV_VAR]: '1' })).toBe(true);
  });

  it('master kill always wins over the enable', () => {
    expect(isCrossSkillExecutionEnabled({
      [CROSS_SKILL_EXECUTION_ENV_VAR]: 'true',
      [MANIFEST_ROUTING_MASTER_KILL_ENV_VAR]: 'true',
    })).toBe(false);
  });
});

describe('getChatActionOwnershipRows', () => {
  it('compiles the manifest calendar_placement row owned by secretary_calendar.schedule_event', () => {
    const rows = getChatActionOwnershipRows();
    const calendarRow = rows.find((row) => row.category === 'calendar_placement');
    expect(calendarRow).toBeDefined();
    expect(calendarRow?.capabilityId).toBe('secretary');
    expect(calendarRow?.ownerSkill).toBe('secretary_calendar');
    expect(calendarRow?.ownerAction).toBe('schedule_event');
    expect(calendarRow?.evidence.length).toBeGreaterThan(0);
  });
});

describe('applyCrossSkillOwnershipToSteps', () => {
  it('rewrites a tasks-originated calendar-placement step to the secretary-owned action (not duplicated)', () => {
    const step = makeStep({});
    const { steps, rewrites } = applyCrossSkillOwnershipToSteps([step], 'add it to my calendar', INPUT);
    expect(steps).toHaveLength(1);
    expect(steps[0].skill).toBe('secretary_calendar');
    expect(steps[0].action).toBe('schedule_event');
    // Slots are re-extracted from the segment text; a no-time segment must
    // NOT claim readiness.
    expect(steps[0].requiredArgsPresent).toBe(false);
    expect(rewrites).toEqual([{
      fromSkill: 'tasks',
      fromAction: 'add_subtasks_to_task',
      toSkill: 'secretary_calendar',
      toAction: 'schedule_event',
      category: 'calendar_placement',
    }]);
  });

  it('rewrites a training-originated calendar-placement step to the secretary-owned action', () => {
    const step = makeStep({
      skill: 'training',
      action: 'training_plan_create',
      args: { sport: null, goal: null, durationWeeks: null, startDate: null, weeklyVolumeKm: null },
      requiredArgsPresent: false,
    });
    const { steps, rewrites } = applyCrossSkillOwnershipToSteps([step], 'put the workout on my calendar', INPUT);
    expect(steps[0].skill).toBe('secretary_calendar');
    expect(steps[0].action).toBe('schedule_event');
    expect(rewrites[0]?.fromSkill).toBe('training');
  });

  it('leaves a step already on the owner action untouched (same reference)', () => {
    const step = makeStep({ skill: 'secretary_calendar', action: 'schedule_event', args: { title: 'sync' } });
    const { steps, rewrites } = applyCrossSkillOwnershipToSteps([step], 'add it to my calendar', INPUT);
    expect(steps[0]).toBe(step);
    expect(rewrites).toHaveLength(0);
  });

  it('leaves non-matching segments untouched (same reference)', () => {
    const step = makeStep({});
    const { steps, rewrites } = applyCrossSkillOwnershipToSteps([step], 'add milk to the grocery list', INPUT);
    expect(steps[0]).toBe(step);
    expect(rewrites).toHaveLength(0);
  });

  it('never rewrites answer, clarification, or refusal steps', () => {
    const answer = makeStep({ type: 'answer', args: { text: 'ok' } });
    const clarification = makeStep({ type: 'clarification' });
    const refusal = makeStep({ args: { rejectionReason: 'blocked_by_policy' } });
    const { steps, rewrites } = applyCrossSkillOwnershipToSteps(
      [answer, clarification, refusal],
      'add it to my calendar',
      INPUT,
    );
    expect(steps[0]).toBe(answer);
    expect(steps[1]).toBe(clarification);
    expect(steps[2]).toBe(refusal);
    expect(rewrites).toHaveLength(0);
  });

  it('keeps a reminder step whose own action matches the segment — the calendar mention is the reminder BODY, not a placement misroute', () => {
    // Adversarial finding (M19 remediation, 2026-07-21): "remind me to add
    // the offsite to my calendar next week" matched the calendar_placement
    // evidence and rewrote the reminder step into schedule_event, destroying
    // the reminder intent. The step's own action's readableIntents ("remind
    // me") match the segment, so the planner's choice is corroborated and
    // the rewrite must be skipped.
    const segment = 'remind me to add the offsite to my calendar next week';
    const step = makeStep({
      skill: 'secretary_reminders',
      action: 'set_reminder',
      args: { text: 'add the offsite to my calendar', datetime: null },
      requiredArgsPresent: false,
    });
    const { steps, rewrites } = applyCrossSkillOwnershipToSteps([step], segment, INPUT);
    expect(steps[0]).toBe(step);
    expect(rewrites).toHaveLength(0);
  });

  it('keeps a task-creation step for "remind me to ..." phrasing (readableIntents corroborate the planned action)', () => {
    const segment = 'remind me to add the offsite to my calendar next week';
    const step = makeStep({
      skill: 'tasks',
      action: 'create_task',
      args: { title: 'add the offsite to my calendar' },
      requiredArgsPresent: true,
    });
    const { steps, rewrites } = applyCrossSkillOwnershipToSteps([step], segment, INPUT);
    expect(steps[0]).toBe(step);
    expect(rewrites).toHaveLength(0);
  });

  it('rewrites AT MOST ONE step per segment (first match) — one placement intent never fans out to duplicates', () => {
    const first = makeStep({ stepId: 'step-a' });
    const second = makeStep({ stepId: 'step-b', action: 'update_task', args: { taskId: 't-1' } });
    const { steps, rewrites } = applyCrossSkillOwnershipToSteps([first, second], 'add it to my calendar', INPUT);
    expect(steps[0].skill).toBe('secretary_calendar');
    expect(steps[0].action).toBe('schedule_event');
    expect(steps[1]).toBe(second);
    expect(rewrites).toHaveLength(1);
  });

  it('is fully generic: a synthetic manifest row drives the rewrite (no hardcoding)', () => {
    const syntheticRows = [{
      capabilityId: 'synthetic',
      category: 'notification_delivery',
      ownerSkill: 'notifications' as const,
      ownerAction: 'notification_create_intent' as const,
      evidence: [/\bping\s+me\b/i],
    }];
    const step = makeStep({});
    const { steps, rewrites } = applyCrossSkillOwnershipToSteps(
      [step],
      'ping me when the report lands',
      INPUT,
      syntheticRows,
    );
    expect(steps[0].skill).toBe('notifications');
    expect(steps[0].action).toBe('notification_create_intent');
    expect(rewrites[0]?.category).toBe('notification_delivery');
  });
});

describe('enforceCrossSkillPreview / executableSkillsForPlan', () => {
  function planWith(steps: ChatPlanStep[], requiresConfirmation = false): ChatActionPlan {
    return {
      schemaVersion: 1,
      userId: '91',
      tenantId: '91',
      conversationId: 'conv-m19',
      messageId: 'msg-m19',
      locale: 'en-US',
      timezone: 'UTC',
      channel: 'ios',
      createdAt: INPUT.nowIso!,
      planner: 'mixed',
      steps,
      requiresConfirmation,
      confidence: 0.9,
    } as ChatActionPlan;
  }

  it('forces confirmation for a plan spanning >=2 skills', () => {
    const plan = planWith([
      makeStep({ skill: 'training', action: 'training_plan_create' }),
      makeStep({ skill: 'secretary_calendar', action: 'schedule_event' }),
    ]);
    expect(enforceCrossSkillPreview(plan).requiresConfirmation).toBe(true);
  });

  it('is a no-op for single-skill plans (same reference)', () => {
    const plan = planWith([makeStep({}), makeStep({ stepId: 'step-2' })]);
    expect(enforceCrossSkillPreview(plan)).toBe(plan);
  });

  it('ignores answer/clarification steps when counting skills', () => {
    const steps = [
      makeStep({ skill: 'tasks' }),
      makeStep({ skill: 'connections', type: 'answer', action: 'connections_status', args: { text: 'hi' } }),
    ];
    expect(executableSkillsForPlan(steps)).toEqual(['tasks']);
  });
});

// crossSkillPlanPathCoverage was deleted in the M19 remediation: it existed
// only to suppress the cross_skill_bridge prompt block, but that block only
// renders on turns the planner DECLINED, so coverage-based suppression
// guaranteed a silent drop of the second intent. The bridge now always
// renders on the legacy/model path (see chat-skill-orchestrator.test.ts).
