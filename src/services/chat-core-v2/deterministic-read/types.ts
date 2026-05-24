// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2ShadowRouteGuess } from '../shadow-route-classifier';
import type { ChatCoreV2ReadContextPack, ChatCoreV2ReadModelResult } from '../types';
import type { ChatCoreV2Response } from '../response-contracts';

export type ChatCoreV2DeterministicReadCapabilityId =
  | 'tasks.today_summary'
  | 'decision_center.summary'
  | 'notifications.summary';

export interface ChatCoreV2TaskSummaryItem {
  entityId: string;
  title: string;
  projectName?: string;
  dueDate?: string;
  priority: number;
  bucket: 'overdue' | 'today' | 'upcoming' | 'unscheduled';
}

export interface ChatCoreV2TaskSummaryData {
  pendingCount: number;
  dueTodayCount: number;
  overdueCount: number;
  highPriorityCount: number;
  timezone: string;
  topTasks: ChatCoreV2TaskSummaryItem[];
}

export interface ChatCoreV2DecisionCenterSummaryItem {
  entityId: string;
  title: string;
  sourceSkill: string;
  urgency: string;
  status: string;
  actionLabel: string | null;
  why: string | null;
}

export interface ChatCoreV2DecisionCenterSummaryData {
  openCount: number;
  urgentCount: number;
  todayCount: number;
  handledTodayCount: number;
  badgeCount: number;
  ctaLabel: string;
  topDecisionTitle: string | null;
  topDecisionWhy: string | null;
  topSuggestionTitle: string | null;
  topItems: ChatCoreV2DecisionCenterSummaryItem[];
}

export interface ChatCoreV2NotificationSummaryItem {
  entityId: string;
  title: string;
  body: string;
  sourceSkill: string;
  type: string;
  priority: string;
  status: string;
  actionLabels: string[];
  createdAt: string;
  expiresAt: string | null;
}

export interface ChatCoreV2NotificationSummaryData {
  unreadCount: number;
  urgentCount: number;
  actionRequiredCount: number;
  remindersCount: number;
  sourceSkills: string[];
  topItems: ChatCoreV2NotificationSummaryItem[];
}

export type ChatCoreV2DeterministicReadData =
  | ChatCoreV2TaskSummaryData
  | ChatCoreV2DecisionCenterSummaryData
  | ChatCoreV2NotificationSummaryData;

export interface ChatCoreV2DeterministicReadRouteResult {
  capabilityId: ChatCoreV2DeterministicReadCapabilityId;
  routeGuess: ChatCoreV2ShadowRouteGuess;
  readModel: ChatCoreV2ReadModelResult<ChatCoreV2DeterministicReadData>;
  contextPack: ChatCoreV2ReadContextPack;
  response: ChatCoreV2Response;
}

export interface BuildChatCoreV2DeterministicReadRouteInput {
  normalizedText: string;
  userId: number;
  tenantId: number;
  locale?: string | null;
  timezone?: string | null;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export type ChatCoreV2DeterministicReadBuilder = (
  input: BuildChatCoreV2DeterministicReadRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
) => ChatCoreV2DeterministicReadRouteResult | null;
