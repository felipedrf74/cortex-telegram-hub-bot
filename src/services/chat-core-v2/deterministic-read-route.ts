// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { type RuntimeFlagScope } from '../runtime-flags';
import { classifyShadowRoute, type ChatCoreV2ShadowRouteGuess } from './shadow-route-classifier';
import { isChatCoreV2CapabilityEnabled } from './capability-registry';
import {
  DECISION_CENTER_SUMMARY_CAPABILITY,
  NOTIFICATIONS_SUMMARY_CAPABILITY,
  TASKS_TODAY_SUMMARY_CAPABILITY,
} from './deterministic-read/common';
import { buildDecisionCenterSummaryRoute } from './deterministic-read/decision-center-summary-route';
import { buildNotificationsSummaryRoute } from './deterministic-read/notification-summary-route';
import { buildTaskSummaryRoute } from './deterministic-read/task-summary-route';
import type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2DeterministicReadBuilder,
  ChatCoreV2DeterministicReadCapabilityId,
  ChatCoreV2DeterministicReadRouteResult,
} from './deterministic-read/types';

export type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2DecisionCenterSummaryData,
  ChatCoreV2DecisionCenterSummaryItem,
  ChatCoreV2DeterministicReadCapabilityId,
  ChatCoreV2DeterministicReadData,
  ChatCoreV2DeterministicReadRouteResult,
  ChatCoreV2NotificationSummaryData,
  ChatCoreV2NotificationSummaryItem,
  ChatCoreV2TaskSummaryData,
  ChatCoreV2TaskSummaryItem,
} from './deterministic-read/types';

type ChatCoreV2CapabilityFlagInput = Parameters<typeof isChatCoreV2CapabilityEnabled>[1];

const DETERMINISTIC_READ_BUILDERS: Record<ChatCoreV2DeterministicReadCapabilityId, ChatCoreV2DeterministicReadBuilder> = {
  [TASKS_TODAY_SUMMARY_CAPABILITY]: buildTaskSummaryRoute,
  [DECISION_CENTER_SUMMARY_CAPABILITY]: buildDecisionCenterSummaryRoute,
  [NOTIFICATIONS_SUMMARY_CAPABILITY]: buildNotificationsSummaryRoute,
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
  if (routeGuess.domains[0] === 'decision_center' && routeGuess.capabilityIds.includes(DECISION_CENTER_SUMMARY_CAPABILITY)) {
    return DECISION_CENTER_SUMMARY_CAPABILITY;
  }
  if (routeGuess.domains[0] === 'notifications' && routeGuess.capabilityIds.includes(NOTIFICATIONS_SUMMARY_CAPABILITY)) {
    return NOTIFICATIONS_SUMMARY_CAPABILITY;
  }
  return null;
}
