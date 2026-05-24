// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';

import type { ChatActionRunStatus } from '../../chat-action-run-store';
import { isChatOpenSurfaceHandoffEnabled } from '../../runtime-flags';
import type {
  ChatActionPlan,
  ChatActionRouteResponse,
  ChatPlannerInput,
  ChatPlanStep,
} from '../types';

type StepResult = { step: ChatPlanStep; result?: unknown };
type StepRunResult = StepResult & { status: ChatActionRunStatus; error?: string };

export function domainForPlan(plan: ChatActionPlan): ChatActionRouteResponse['domain'] {
  const skill = plan.steps[0]?.skill;
  if (skill === 'secretary_calendar' || skill === 'mail') return 'secretary';
  if (skill === 'tasks') return 'tasks';
  if (skill === 'training') return 'training';
  if (skill === 'content') return 'content';
  if (skill === 'cooking') return 'cooking';
  if (skill === 'finance') return 'finance';
  return 'unknown';
}

export function firstTitle(results: Array<{ step: ChatPlanStep }>): string | undefined {
  const title = (results[0]?.step.args as any)?.title;
  return typeof title === 'string' ? title : undefined;
}

export function calendarCardEvents(results: StepResult[]): Array<Record<string, string>> | undefined {
  const calendarSteps = results.filter((result) => result.step.action === 'schedule_event');
  if (calendarSteps.length === 0) return undefined;
  return calendarSteps.map((result) => {
    const args = result.step.args as any;
    const start = DateTime.fromISO(String(args.startDateTime));
    const end = DateTime.fromISO(String(args.endDateTime));
    return {
      title: String(args.title),
      time: `${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}`,
      source: args.provider === 'outlook_calendar' ? 'outlook' : 'google',
    };
  });
}

export function resultCardPayload(results: StepResult[]): Record<string, unknown> {
  const first = results[0];
  if (!first) return {};
  if (first.step.action === 'content_brief_create' || first.step.action === 'content_script_create') {
    const result = first.result as any;
    return {
      contentPackage: result ? {
        packageId: result.packageId,
        qualityScore: result.quality?.score ?? null,
        blockers: result.quality?.blockers ?? [],
        warnings: result.quality?.warnings ?? [],
        script: result.firstScript ? {
          title: result.firstScript.title,
          coldOpen: result.firstScript.coldOpen,
          promise: result.firstScript.promise,
          cta: result.firstScript.cta,
        } : null,
      } : null,
    };
  }
  if (first.step.action === 'create_task_with_subtasks' || first.step.action === 'add_subtasks_to_task') {
    const result = first.result as any;
    return {
      taskId: result?.taskId ?? null,
      listId: result?.listId ?? null,
      title: result?.title ?? (first.step.args as any).title ?? null,
      subtasks: Array.isArray(result?.subtasks) ? result.subtasks : [],
      failedSubtasks: Array.isArray(result?.failedSubtasks) ? result.failedSubtasks : [],
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
      taskVerificationStatus: result?.verificationStatus ?? null,
    };
  }
  if (first.step.action === 'cooking_grocery_list') {
    const result = first.result as any;
    return { groceryList: result ? { weekStart: result.weekStart, itemCount: result.itemCount, items: result.items } : null };
  }
  if (first.step.action === 'cooking_substitute_ingredient') {
    const result = first.result as any;
    return {
      cookingSubstitution: result ? {
        substitution: result.substitution ?? null,
        meal: result.meal ?? null,
        recipe: result.recipe ?? null,
        shoppingListUpdated: Boolean(result.substitution?.shoppingListUpdated),
      } : null,
    };
  }
  if (first.step.action === 'finance_summary') return { finance: first.result ?? null };
  if (first.step.action === 'connections_status') return { connections: first.result ?? null };
  if (first.step.action === 'training_coach_report') return { training: first.result ?? null };
  return {};
}

export function actionButtonsForResults(results: Array<{ step: ChatPlanStep }>): string[] {
  const first = results[0]?.step;
  if (!first) return [];
  if (first.action === 'schedule_event') return ['open_provider_event', 'undo_created_event'];
  if (first.action === 'create_task' || first.action === 'create_checklist' || first.action === 'create_task_with_subtasks' || first.action === 'add_subtasks_to_task') return ['open_skill', 'undo'];
  if (first.skill === 'content' || first.skill === 'cooking' || first.skill === 'finance' || first.skill === 'connections' || first.skill === 'training') return ['open_skill'];
  if (first.skill === 'notifications' || first.skill === 'decision_center') return ['open_skill'];
  return [];
}

export function openSurfacePayloadForStep(
  step: ChatPlanStep,
  result: unknown,
  input: ChatPlannerInput,
): Record<string, unknown> | null {
  if (!isChatOpenSurfaceHandoffEnabled(process.env, { userId: input.userId, tenantId: input.tenantId })) return null;
  if (step.action === 'training_plan_create') {
    return {
      surface: 'training_plan_builder',
      pendingActionId: (result as any)?.pendingActionId ?? null,
      prefill: {
        sport: (step.args as any).sport ?? null,
        goal: (step.args as any).goal ?? null,
        durationWeeks: (step.args as any).durationWeeks ?? null,
        startDate: (step.args as any).startDate ?? null,
        weeklyVolumeKm: (step.args as any).weeklyVolumeKm ?? null,
        constraints: (step.args as any).constraints ?? [],
      },
    };
  }
  if (step.skill === 'content') return { surface: 'script_studio', prefill: step.args };
  if (step.skill === 'tasks') return { surface: 'task_detail', prefill: step.args };
  if (step.skill === 'secretary_calendar') return { surface: 'calendar_event', prefill: step.args };
  if (step.skill === 'finance') return { surface: 'finance_review', prefill: step.args };
  if (step.skill === 'cooking') return { surface: 'cooking_meal_plan', prefill: step.args };
  return null;
}

export function sanitizeActionResults(results: StepRunResult[]): Array<Record<string, unknown>> {
  return results.map((result) => ({
    stepId: result.step.stepId,
    skill: result.step.skill,
    action: result.step.action,
    status: result.status,
    provider: result.step.provider,
    title: typeof (result.step.args as any).title === 'string' ? (result.step.args as any).title : undefined,
    error: result.error,
  }));
}
