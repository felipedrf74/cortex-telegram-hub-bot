// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Stable public contracts for deterministic cross-agent learning adapters. */

import type { MeshPriority, SignalPriority, SignalType } from '../intelligence-bus';
import type { MealPlan, ShoppingList } from '../cooking-chef';
import type { ContentNotification } from '../content-notification-store';
import type { ContentFilmingRecommendation, ContentTopicStatus } from '../content-scheduler';
import type { getKnowledgeStats, getVoiceDna } from '../content-dashboard-service';
import type {
  ContentDeskItem,
  ContentExecutionHint,
  ContentPillarSummary,
  ContentSignalDigest,
} from '../content-intelligence';
import type {
  AnnualTaxSummary,
  MonthlyBudgetView,
  MonthlySummary,
  TaxEvent,
} from '../finance-tracker';
import type { ReportDocument } from '../report-document-store';
import type { SubscriptionStatus } from '../stripe-service';
import type { NormalizedTask } from '../task-store/types';
import type { FocusBlockRecommendation } from '../focus-planner';
import type { TrainingContext } from '../training-signals';
import type {
  TrainingPlan,
  TrainingSession,
  TrainingWeek,
  WeeklyAdherenceStats,
} from '../training-plans';
import type { UnifiedCalendarEvent, UnifiedCalendarFetchStatus } from '../unified-calendar';
import type { UserMailPressureSummary } from '../unified-mail-pressure';
import type { PlanSourceHealth } from '../secretary-planning-context';

/** Cooking distinguishes an optional, unconfigured calendar from a failed read. */
export type CookingCalendarStatus = UnifiedCalendarFetchStatus | 'not_configured';

export interface AgentContext {
  /** Voice patterns from Voice Evolution Agent (phrases, style notes). */
  voicePatterns: VoiceContext[];
  /** Pillar performance rankings from Performance Agent. */
  pillarRankings: PillarContext[];
  /** Active hook effectiveness insights. */
  hookInsights: HookContext[];
  /** Retention patterns (what keeps viewers watching). */
  retentionInsights: RetentionContext[];
  /** Keyword opportunities from SEO Agent. */
  keywordOpportunities: KeywordContext[];
  /** Content formulas — validated content patterns that work. */
  contentFormulas: ContentFormulaContext[];
  /** Raw signals consumed (for agent run logging). */
  signalsConsumed: number;
}
export interface VoiceContext {
  observation: string;
  patterns: { pattern: string; frequency: string }[];
  strength: number;
}

export interface PillarContext {
  pillar: string;
  avgViews: number;
  engagementRate: number;
  trend: string;
}

export interface HookContext {
  hookType: string;
  effectiveness: number;
  examples: string[];
}

export interface RetentionContext {
  pattern: string;
  impact: string;
  avgRetention: number;
}

export interface KeywordContext {
  keyword: string;
  direction: string;
  volumeHint: string;
}

export interface ContentFormulaContext {
  formula: string;
  pillar: string;
  confidence: number;
  source: string;
}

export interface MeshSignalDraft {
  sourceAgent: string;
  signalType: SignalType;
  meshPriority: MeshPriority;
  priority: SignalPriority;
  payload: Record<string, unknown>;
  expiresAt?: string;
}

/** Privacy-bounded, attention-first current-state aggregate from Secretary for
 * one Training plan. Agenda/source identifiers, per-intent versions, and exact
 * timestamps stay in the owning service; plan and coach consumers receive only
 * allowlisted scheduling consequences. */
export interface TrainingSecretaryFeedbackForContext {
  planId: number;
  feedbackType: 'compressed_session' | 'reflowed_session' | 'schedule_attention' | 'needs_context' | 'schedule_confirmed';
  status: 'scheduled' | 'reflowed' | 'compressed' | 'deferred' | 'unscheduled' | 'rejected' | 'needs_more_context';
  reasonCodes: string[];
  shouldRefreshSource: boolean;
  hints: string[];
  scheduledDurationMinutes: number | null;
}

export interface TrainingMeshContext {
  userId: number;
  weekStart: string;
  weekEnd: string;
  activePlan: TrainingPlan | null;
  activeWeek: TrainingWeek | null;
  sessions: TrainingSession[];
  trainingContext: TrainingContext;
  coachBriefing: ReportDocument | null;
  adherence: WeeklyAdherenceStats | null;
  /** Attention-first Secretary aggregate for this exact active plan version. */
  secretaryFeedback: TrainingSecretaryFeedbackForContext | null;
  /** Persistent coach narrative state (macro phase, adherence trend,
   *  recent deloads, active concern). Null for users who haven't had
   *  a coach phase memory written yet; consumers fall back to
   *  stateless interpretation in that case. */
  coachPhaseMemory: CoachPhaseMemoryForContext | null;
  /** Internal read health used by aggregate planners; never exposes source IDs. */
  sourceHealth?: PlanSourceHealth;
  derivedSignals: MeshSignalDraft[];
}

/** Narrow view of CoachPhaseMemory for cross-agent-learning consumers.
 *  Kept local so cross-agent-learning can import it without pulling the
 *  full service (which would create a cycle through report-document-store). */
export interface CoachPhaseMemoryForContext {
  phase: string;
  weekInPhase?: number;
  phaseTotalWeeks?: number;
  narrative: string;
  adherenceTrend?: string;
  recentDeloadDates?: string[];
  activeConcern?: string | null;
  nextExpectedShift?: string | null;
  writtenAt: string;
}

export interface CookingMeshContext {
  userId: number;
  /** IANA zone used for every date window and event-to-day projection. */
  timezone?: string;
  weekStart: string;
  weekEnd: string;
  meals: MealPlan[];
  shoppingList: ShoppingList | null;
  /**
   * Health of each source needed to interpret an empty Cooking result.
   * Live contexts always populate this; absence on older fixtures is treated
   * as unverified by orchestration consumers.
   */
  sourceHealth?: {
    mealPlan: CookingSourceHealth;
    shoppingList: CookingSourceHealth;
    recipes: CookingSourceHealth;
    focus: CookingSourceHealth;
    /** Current-preference projection for persisted meals and shopping data. */
    safety?: CookingSafetySourceHealth;
  };
  /** Verified local-day availability evidence used for prep placement. */
  availability?: {
    busyDates: string[];
    fragmentedDates: string[];
    travelDates: string[];
    focusDate: string | null;
  };
  /**
   * Calendar evidence used to classify constrained meal-prep dates.
   * The live adapter always sets this. It remains optional for older persisted
   * fixtures; consumers treat `not_configured` as verified empty availability,
   * while absence, unavailable, or degraded remains unverified.
   */
  calendar?: {
    status: CookingCalendarStatus;
    warningCodes: string[];
  };
  derivedSignals: MeshSignalDraft[];
}

export interface CookingSourceHealth {
  status: UnifiedCalendarFetchStatus;
  warningCodes: string[];
}

export interface CookingSafetySourceHealth extends CookingSourceHealth {
  /** Number of persisted meals withheld from every downstream projection. */
  excludedMealCount: number;
  /** One entry per withheld meal so daily consumers can count by local date. */
  excludedMealDates: string[];
  /** Optional per-meal reason metadata used by newer daily projections. */
  excludedMeals?: Array<{
    date: string;
    reason: 'preference_conflict' | 'unverified_recipe' | 'preference_conflict_and_unverified_recipe';
  }>;
}

export interface ContentMeshContext {
  userId: number;
  weekStart: string;
  weekEnd: string;
  upcomingTopicCount: number;
  scheduledTopics: Array<{
    id: number;
    title: string;
    scheduledDate: string;
    status: ContentTopicStatus;
  }>;
  filmingRecommendation: ContentFilmingRecommendation | null;
  unreadNotifications: ContentNotification[];
  deskItems: ContentDeskItem[];
  monitoredPillars: ContentPillarSummary[];
  recentSignals: ContentSignalDigest[];
  nextExecution: ContentExecutionHint | null;
  voiceDnaEntries: ReturnType<typeof getVoiceDna>;
  knowledgeStats: ReturnType<typeof getKnowledgeStats>;
  /** Internal read health used by aggregate planners; never exposes source IDs. */
  sourceHealth?: PlanSourceHealth;
  derivedSignals: MeshSignalDraft[];
}

export interface SecretaryMeshContext {
  userId: number;
  weekStart: string;
  weekEnd: string;
  events: UnifiedCalendarEvent[];
  focusBlock: FocusBlockRecommendation | null;
  dueToday: NormalizedTask[];
  dueThisWeek: NormalizedTask[];
  overdue: NormalizedTask[];
  pending: NormalizedTask[];
  writableCalendar: boolean;
  mailPressure?: UserMailPressureSummary | null;
  /** Nexus-owned commitments that are not already represented by a matching
   * provider event. These remain internal to orchestration and never expose
   * agenda ledger identifiers through the public plan contract. */
  localAgendaItems?: SecretaryMeshAgendaItem[];
  sourceHealth?: {
    calendar: PlanSourceHealth;
    tasks: PlanSourceHealth;
    mail: PlanSourceHealth;
    focus: PlanSourceHealth;
  };
  warningCodes?: string[];
  warnings?: string[];
  derivedSignals: MeshSignalDraft[];
}

export interface SecretaryMeshAgendaItem {
  title: string;
  startAt: string;
  endAt: string;
  providerEventId: string | null;
  providerSource: 'google' | 'outlook' | null;
  routineKind?: 'focus' | 'training' | 'meal' | 'recovery' | 'personal' | 'travel';
}

export interface FinanceMeshContext {
  userId: number;
  weekStart: string;
  weekEnd: string;
  month: string;
  monthlySummary: MonthlySummary;
  budgetView: MonthlyBudgetView;
  taxEvents: TaxEvent[];
  annualSummary: AnnualTaxSummary;
  subscription: SubscriptionStatus;
  /** Internal read health used by aggregate planners; never exposes source IDs. */
  sourceHealth?: PlanSourceHealth;
  derivedSignals: MeshSignalDraft[];
}
