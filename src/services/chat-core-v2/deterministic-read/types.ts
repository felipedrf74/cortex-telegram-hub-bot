// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2ShadowRouteGuess } from '../shadow-route-classifier';
import type { ChatCoreV2ReadContextPack, ChatCoreV2ReadModelResult } from '../types';
import type { ChatCoreV2Response } from '../response-contracts';

export type ChatCoreV2DeterministicReadCapabilityId =
  | 'secretary.agenda_summary'
  | 'tasks.today_summary'
  | 'decision_center.summary'
  | 'notifications.summary'
  | 'connections.status'
  | 'finance.summary'
  | 'training.session_explain'
  | 'content.pipeline_summary'
  | 'cooking.meal_plan_summary';

export interface ChatCoreV2AgendaSummaryItem {
  entityId: string;
  title: string;
  sourceSkill: string;
  lifecycleState: string;
  providerSyncState: string;
  startAt: string | null;
  endAt: string | null;
  durationMinutes: number | null;
  bucket: 'today' | 'upcoming' | 'unscheduled';
}

export interface ChatCoreV2AgendaSummaryData {
  activeCount: number;
  todayCount: number;
  unscheduledCount: number;
  providerAttentionCount: number;
  timezone: string;
  topItems: ChatCoreV2AgendaSummaryItem[];
}

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

export interface ChatCoreV2ConnectionStatusItem {
  entityId: string;
  provider: string;
  state: string;
  connectedAt: string | null;
  capabilities: string[];
  needsAttention: boolean;
  reasonCode: string | null;
  lastCheckedAt: string | null;
}

export interface ChatCoreV2ConnectionStatusData {
  providerCount: number;
  connectedCount: number;
  degradedCount: number;
  revokedCount: number;
  pendingCount: number;
  disconnectedCount: number;
  attentionCount: number;
  capabilities: {
    mail: boolean;
    calendar: boolean;
    externalTasks: boolean;
    health: boolean;
  };
  topProviders: ChatCoreV2ConnectionStatusItem[];
}

export interface ChatCoreV2FinanceSummaryData {
  month: string;
  basisCurrency: string;
  currencies: string[];
  totalIncome: number;
  totalExpenses: number;
  totalDeductions: number;
  netIncome: number;
  transactionCount: number;
  integrity: string;
  affordability: string;
  currentRemaining: number | null;
  projectedRemaining: number | null;
  recurringExpenseEstimate: number;
  recurringExpenseCount: number;
  notes: string[];
}

export interface ChatCoreV2TrainingSessionSummaryItem {
  entityId: string;
  title: string;
  dayOfWeek: string;
  sessionType: string;
  status: string;
  durationMinutes: number | null;
  intensityText: string | null;
}

export interface ChatCoreV2TrainingSessionExplainData {
  hasActivePlan: boolean;
  planName: string | null;
  sport: string | null;
  goal: string | null;
  durationWeeks: number | null;
  currentWeekNumber: number | null;
  currentWeekFocus: string | null;
  currentWeekIntensityPct: number | null;
  adherenceRate: number | null;
  completedSessions: number;
  skippedSessions: number;
  pendingSessions: number;
  totalSessions: number;
  topSessions: ChatCoreV2TrainingSessionSummaryItem[];
}

export interface ChatCoreV2ContentPipelineSummaryItem {
  entityId: string;
  title: string;
  kind: 'topic' | 'desk_item' | 'signal';
  status: string;
  scheduledDate: string | null;
  priority: string | null;
  createdAt: string | null;
}

export interface ChatCoreV2ContentPipelineSummaryData {
  topicCount: number;
  plannedCount: number;
  draftingCount: number;
  readyCount: number;
  publishedCount: number;
  scheduledCount: number;
  deskReadyCount: number;
  urgentSignalCount: number;
  topItems: ChatCoreV2ContentPipelineSummaryItem[];
}

export interface ChatCoreV2CookingMealSummaryItem {
  entityId: string;
  date: string;
  mealType: string;
  title: string;
}

export interface ChatCoreV2CookingShoppingSummaryItem {
  name: string;
  aisle: string;
  checked: boolean;
  pantryStatus: string | null;
}

export interface ChatCoreV2CookingMealPlanSummaryData {
  rangeStart: string;
  rangeEnd: string;
  plannedMealCount: number;
  plannedDateCount: number;
  shoppingListWeekStart: string;
  shoppingItemCount: number;
  checkedShoppingItemCount: number;
  pantryAvailableShoppingItemCount: number;
  pantryExpiredShoppingItemCount: number;
  pantryAvailableCount: number;
  pantryUseSoonCount: number;
  pantryUnknownCount: number;
  topMeals: ChatCoreV2CookingMealSummaryItem[];
  topShoppingItems: ChatCoreV2CookingShoppingSummaryItem[];
}

export type ChatCoreV2DeterministicReadData =
  | ChatCoreV2AgendaSummaryData
  | ChatCoreV2TaskSummaryData
  | ChatCoreV2DecisionCenterSummaryData
  | ChatCoreV2NotificationSummaryData
  | ChatCoreV2ConnectionStatusData
  | ChatCoreV2FinanceSummaryData
  | ChatCoreV2TrainingSessionExplainData
  | ChatCoreV2ContentPipelineSummaryData
  | ChatCoreV2CookingMealPlanSummaryData;

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
