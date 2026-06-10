// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatActionName } from '../registry';
import type { ChatStepExecutor } from './types';
import { executeCalendarCreateStep, executeCalendarDeleteStep, executeCalendarReadOnlyStep, executeCalendarUpdateStep } from '../../skills/secretary/executor';
import { executeReminderSetStep } from '../../skills/reminders/executor';
import { executeMailInboxSummaryStep, executeMailUnreadCountStep } from '../../skills/mail/executor';
import { executeAddSubtasksToTaskStep, executeTaskCreateStep, executeTaskMutationStep, executeTaskWithSubtasksStep } from '../../skills/tasks/executor';
import { executeContentAgencyStep, executeContentPipelineHandoffStep, executeContentPipelineStageTransitionStep, executeContentScheduleWorkStep } from '../../skills/content/executor';
import { executeCookingGroceryListStep, executeCookingMealPlanStep, executeCookingSubstituteIngredientStep, executeCookingSupportStep } from '../../skills/cooking/executor';
import { executeFinanceCategorizeReceiptStep, executeFinancePaymentActionStep, executeFinanceReminderStep, executeFinanceSummaryStep } from '../../skills/finance/executor';
import { executeConnectionsReconnectGuidanceStep, executeConnectionsStatusStep } from '../../skills/connections/executor';
import { executeTrainingCoachReportStep, executeTrainingExplainSessionStep, executeTrainingPlanCreateStep, executeTrainingReflowStep } from '../../skills/training/executor';
import { executeNotificationExplainStep, executeNotificationMutationStep } from '../../skills/notifications/executor';
import { executeDecisionCenterStep } from '../../skills/decision_center/executor';

const TASK_MUTATION_EXECUTOR: ChatStepExecutor = (step, context) => executeTaskMutationStep(step, context.plan, context.input, context.deps.taskProviderForUser, context.persistRuns);

const CHAT_STEP_EXECUTORS: Partial<Record<ChatActionName, ChatStepExecutor>> = {
  schedule_event: (step, context) => executeCalendarCreateStep(step, context.plan, context.input, context.deps.calendar, context.persistRuns, context.confirmed),
  update_event: (step, context) => executeCalendarUpdateStep(step, context.plan, context.input, context.persistRuns),
  move_event: (step, context) => executeCalendarUpdateStep(step, context.plan, context.input, context.persistRuns),
  delete_event: (step, context) => executeCalendarDeleteStep(step, context.plan, context.input, context.persistRuns),
  check_calendar_conflicts: (step, context) => executeCalendarReadOnlyStep(step, context.input, context.deps.calendar),
  summarize_agenda: (step, context) => executeCalendarReadOnlyStep(step, context.input, context.deps.calendar),
  set_reminder: (step, context) => executeReminderSetStep(step, context.plan, context.input, context.persistRuns),
  mail_unread_count: (step, context) => executeMailUnreadCountStep(step, context.input),
  mail_inbox_summary: (step, context) => executeMailInboxSummaryStep(step, context.input),
  create_task: (step, context) => executeTaskCreateStep(step, context.plan, context.input, context.deps.taskProviderForUser, context.persistRuns),
  create_task_with_subtasks: (step, context) => executeTaskWithSubtasksStep(step, context.plan, context.input, context.deps.taskProviderForUser, context.persistRuns),
  add_subtasks_to_task: (step, context) => executeAddSubtasksToTaskStep(step, context.plan, context.input, context.deps.taskProviderForUser, context.persistRuns),
  update_task: TASK_MUTATION_EXECUTOR,
  complete_task: TASK_MUTATION_EXECUTOR,
  delete_task: TASK_MUTATION_EXECUTOR,
  create_checklist: TASK_MUTATION_EXECUTOR,
  set_task_reminder: TASK_MUTATION_EXECUTOR,
  content_brief_create: (step, context) => executeContentAgencyStep(step, context.plan, context.input, context.persistRuns),
  content_script_create: (step, context) => executeContentAgencyStep(step, context.plan, context.input, context.persistRuns),
  content_rewrite: (step, context) => executeContentAgencyStep(step, context.plan, context.input, context.persistRuns),
  content_schedule_work: (step, context) => executeContentScheduleWorkStep(step, context.plan, context.input, context.persistRuns),
  content_pipeline_handoff: (step, context) => executeContentPipelineHandoffStep(step, context.plan, context.input, context.persistRuns),
  content_pipeline_stage_transition: (step, context) => executeContentPipelineStageTransitionStep(step, context.plan, context.input, context.persistRuns),
  cooking_grocery_list: (step, context) => executeCookingGroceryListStep(step, context.plan, context.input, context.persistRuns),
  cooking_meal_plan: (step, context) => executeCookingMealPlanStep(step, context.plan, context.input, context.persistRuns),
  cooking_substitute_ingredient: (step, context) => executeCookingSubstituteIngredientStep(step, context.plan, context.input, context.persistRuns),
  cooking_meal_support: (step, context) => executeCookingSupportStep(step, context.input),
  cooking_fueling_support: (step, context) => executeCookingSupportStep(step, context.input),
  finance_summary: (step, context) => executeFinanceSummaryStep(step, context.input),
  finance_create_reminder: (step, context) => executeFinanceReminderStep(step, context.plan, context.input, context.deps.taskProviderForUser, context.persistRuns),
  finance_categorize_receipt: (step, context) => executeFinanceCategorizeReceiptStep(step, context.plan, context.input, context.persistRuns),
  finance_payment_action: (step, context) => executeFinancePaymentActionStep(step, context.plan, context.input, context.persistRuns),
  connections_status: (step, context) => executeConnectionsStatusStep(step, context.input),
  connections_reconnect_guidance: (step, context) => executeConnectionsReconnectGuidanceStep(step, context.input),
  training_coach_report: (step, context) => executeTrainingCoachReportStep(step, context.input),
  training_explain_session: (step, context) => executeTrainingExplainSessionStep(step, context.input),
  training_plan_create: (step, context) => executeTrainingPlanCreateStep(step, context.plan, context.input, context.persistRuns),
  training_reflow_preview: (step, context) => executeTrainingReflowStep(step, context.plan, context.input, context.persistRuns, context.confirmed),
  training_reflow_confirm: (step, context) => executeTrainingReflowStep(step, context.plan, context.input, context.persistRuns, context.confirmed),
  notification_explain: (step, context) => executeNotificationExplainStep(step, context.input),
  notification_update_preference: (step, context) => executeNotificationMutationStep(step, context.plan, context.input, context.persistRuns),
  notification_create_intent: (step, context) => executeNotificationMutationStep(step, context.plan, context.input, context.persistRuns),
  decision_choose: (step, context) => executeDecisionCenterStep(step, context.plan, context.input, context.persistRuns),
  decision_dismiss: (step, context) => executeDecisionCenterStep(step, context.plan, context.input, context.persistRuns),
  decision_snooze: (step, context) => executeDecisionCenterStep(step, context.plan, context.input, context.persistRuns),
  decision_follow_up: (step, context) => executeDecisionCenterStep(step, context.plan, context.input, context.persistRuns),
};

export function getChatStepExecutor(action: ChatActionName): ChatStepExecutor | undefined {
  return CHAT_STEP_EXECUTORS[action];
}
