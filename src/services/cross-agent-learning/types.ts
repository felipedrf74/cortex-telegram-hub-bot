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
import type { UnifiedCalendarEvent } from '../unified-calendar';
import type { UserMailPressureSummary } from '../unified-mail-pressure';

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
  /** Persistent coach narrative state (macro phase, adherence trend,
   *  recent deloads, active concern). Null for users who haven't had
   *  a coach phase memory written yet; consumers fall back to
   *  stateless interpretation in that case. */
  coachPhaseMemory: CoachPhaseMemoryForContext | null;
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
  weekStart: string;
  weekEnd: string;
  meals: MealPlan[];
  shoppingList: ShoppingList | null;
  derivedSignals: MeshSignalDraft[];
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
  derivedSignals: MeshSignalDraft[];
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
  derivedSignals: MeshSignalDraft[];
}
