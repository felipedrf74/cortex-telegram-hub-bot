// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { type RuntimeFlagScope } from '../runtime-flags';
import { classifyShadowRoute, type ChatCoreV2ShadowRouteGuess } from './shadow-route-classifier';
import { isChatCoreV2CapabilityEnabled } from './capability-registry';
import {
  CONNECTIONS_STATUS_CAPABILITY,
  CONTENT_PIPELINE_SUMMARY_CAPABILITY,
  COOKING_MEAL_PLAN_SUMMARY_CAPABILITY,
  DECISION_CENTER_SUMMARY_CAPABILITY,
  FINANCE_SUMMARY_CAPABILITY,
  NOTIFICATIONS_SUMMARY_CAPABILITY,
  SECRETARY_AGENDA_SUMMARY_CAPABILITY,
  TASKS_TODAY_SUMMARY_CAPABILITY,
  TRAINING_SESSION_EXPLAIN_CAPABILITY,
} from './deterministic-read/common';
import { buildAgendaSummaryRoute } from './deterministic-read/agenda-summary-route';
import { buildConnectionsStatusRoute } from './deterministic-read/connection-status-route';
import { buildContentPipelineSummaryRoute } from './deterministic-read/content-pipeline-route';
import { buildCookingMealPlanSummaryRoute } from './deterministic-read/cooking-meal-plan-route';
import { buildDecisionCenterSummaryRoute } from './deterministic-read/decision-center-summary-route';
import { buildFinanceSummaryRoute } from './deterministic-read/finance-summary-route';
import { buildNotificationsSummaryRoute } from './deterministic-read/notification-summary-route';
import { buildTaskSummaryRoute } from './deterministic-read/task-summary-route';
import { buildTrainingSessionExplainRoute } from './deterministic-read/training-session-route';
import type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2DeterministicReadBuilder,
  ChatCoreV2DeterministicReadCapabilityId,
  ChatCoreV2DeterministicReadRouteResult,
} from './deterministic-read/types';

export type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2AgendaSummaryData,
  ChatCoreV2AgendaSummaryItem,
  ChatCoreV2ConnectionStatusData,
  ChatCoreV2ConnectionStatusItem,
  ChatCoreV2ContentPipelineSummaryData,
  ChatCoreV2ContentPipelineSummaryItem,
  ChatCoreV2CookingMealPlanSummaryData,
  ChatCoreV2CookingMealSummaryItem,
  ChatCoreV2CookingShoppingSummaryItem,
  ChatCoreV2DecisionCenterSummaryData,
  ChatCoreV2DecisionCenterSummaryItem,
  ChatCoreV2DeterministicReadCapabilityId,
  ChatCoreV2DeterministicReadData,
  ChatCoreV2DeterministicReadRouteResult,
  ChatCoreV2FinanceSummaryData,
  ChatCoreV2NotificationSummaryData,
  ChatCoreV2NotificationSummaryItem,
  ChatCoreV2TaskSummaryData,
  ChatCoreV2TaskSummaryItem,
  ChatCoreV2TrainingSessionExplainData,
  ChatCoreV2TrainingSessionSummaryItem,
} from './deterministic-read/types';

type ChatCoreV2CapabilityFlagInput = Parameters<typeof isChatCoreV2CapabilityEnabled>[1];

const DETERMINISTIC_READ_BUILDERS: Record<ChatCoreV2DeterministicReadCapabilityId, ChatCoreV2DeterministicReadBuilder> = {
  [SECRETARY_AGENDA_SUMMARY_CAPABILITY]: buildAgendaSummaryRoute,
  [TASKS_TODAY_SUMMARY_CAPABILITY]: buildTaskSummaryRoute,
  [DECISION_CENTER_SUMMARY_CAPABILITY]: buildDecisionCenterSummaryRoute,
  [NOTIFICATIONS_SUMMARY_CAPABILITY]: buildNotificationsSummaryRoute,
  [CONNECTIONS_STATUS_CAPABILITY]: buildConnectionsStatusRoute,
  [FINANCE_SUMMARY_CAPABILITY]: buildFinanceSummaryRoute,
  [TRAINING_SESSION_EXPLAIN_CAPABILITY]: buildTrainingSessionExplainRoute,
  [CONTENT_PIPELINE_SUMMARY_CAPABILITY]: buildContentPipelineSummaryRoute,
  [COOKING_MEAL_PLAN_SUMMARY_CAPABILITY]: buildCookingMealPlanSummaryRoute,
};

export function tryBuildChatCoreV2DeterministicReadRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
): ChatCoreV2DeterministicReadRouteResult | null {
  const text = input.normalizedText.trim();
  if (!text) return null;

  const routeGuess = classifyShadowRoute(text);
  const capabilityId = deterministicReadCapabilityForRouteGuess(routeGuess);
  if (!capabilityId) return null;

  const scope: RuntimeFlagScope = { userId: input.userId, tenantId: input.tenantId };
  const flagInput: ChatCoreV2CapabilityFlagInput = {
    env: input.env ?? process.env,
    scope,
  };
  if (!isChatCoreV2CapabilityEnabled(capabilityId, flagInput)) {
    return null;
  }

  return DETERMINISTIC_READ_BUILDERS[capabilityId](input, routeGuess);
}

function deterministicReadCapabilityForRouteGuess(
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2DeterministicReadCapabilityId | null {
  if (routeGuess.intent !== 'app_question') return null;
  if (routeGuess.domains.length !== 1) return null;
  if (routeGuess.domains[0] === 'tasks' && routeGuess.capabilityIds.includes(TASKS_TODAY_SUMMARY_CAPABILITY)) {
    return TASKS_TODAY_SUMMARY_CAPABILITY;
  }
  if (routeGuess.domains[0] === 'secretary' && routeGuess.capabilityIds.includes(SECRETARY_AGENDA_SUMMARY_CAPABILITY)) {
    return SECRETARY_AGENDA_SUMMARY_CAPABILITY;
  }
  if (routeGuess.domains[0] === 'decision_center' && routeGuess.capabilityIds.includes(DECISION_CENTER_SUMMARY_CAPABILITY)) {
    return DECISION_CENTER_SUMMARY_CAPABILITY;
  }
  if (routeGuess.domains[0] === 'notifications' && routeGuess.capabilityIds.includes(NOTIFICATIONS_SUMMARY_CAPABILITY)) {
    return NOTIFICATIONS_SUMMARY_CAPABILITY;
  }
  if (routeGuess.domains[0] === 'connections' && routeGuess.capabilityIds.includes(CONNECTIONS_STATUS_CAPABILITY)) {
    return CONNECTIONS_STATUS_CAPABILITY;
  }
  if (routeGuess.domains[0] === 'finance' && routeGuess.capabilityIds.includes(FINANCE_SUMMARY_CAPABILITY)) {
    return FINANCE_SUMMARY_CAPABILITY;
  }
  if (routeGuess.domains[0] === 'training' && routeGuess.capabilityIds.includes(TRAINING_SESSION_EXPLAIN_CAPABILITY)) {
    return TRAINING_SESSION_EXPLAIN_CAPABILITY;
  }
  if (routeGuess.domains[0] === 'content' && routeGuess.capabilityIds.includes(CONTENT_PIPELINE_SUMMARY_CAPABILITY)) {
    return CONTENT_PIPELINE_SUMMARY_CAPABILITY;
  }
  if (routeGuess.domains[0] === 'cooking' && routeGuess.capabilityIds.includes(COOKING_MEAL_PLAN_SUMMARY_CAPABILITY)) {
    return COOKING_MEAL_PLAN_SUMMARY_CAPABILITY;
  }
  return null;
}
