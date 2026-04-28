// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cross-Agent Learning Service
 *
 * Builds per-agent context from peer signals so each agent can incorporate
 * learnings from other agents in its analysis. Pull-based model — each
 * agent requests what it needs before running.
 *
 * Signal flow:
 *   Performance → pillar_performance, hook_effectiveness, retention_pattern
 *   SEO         → keyword_opportunity, keyword_rank_change
 *   Reaction    → reaction_opportunity, trending_spike
 *   Voice       → voice_pattern, voice_phrase_trend
 *   Pipeline    → pipeline_bottleneck, pipeline_capacity
 *
 * Cross-agent consumption (NEW in v2):
 *   Performance reads: voice_pattern (correlate voice alignment with views)
 *   SEO reads: retention_pattern, hook_effectiveness (inform keyword strategy)
 *   Reaction reads: voice_pattern (suggest reactions in Felipe's style)
 *   Voice reads: pillar_performance (focus analysis on high-performing content)
 *   Pipeline reads: keyword_opportunity, hook_effectiveness (prioritize topics)
 */

import { DateTime } from 'luxon';
import {
  readSignals, writeSignal, markConsumed,
  type SignalType, type AgentSignal, type MeshPriority, type SignalPriority,
} from './intelligence-bus';
import { config } from '../config';
import {
  classifyIngredientAisle,
  getMealPlan,
  getRecipeById,
  getShoppingList,
  type Ingredient,
  type MealPlan,
  type ShoppingItem,
  type ShoppingList,
} from './cooking-chef';
import { getUnreadNotifications, type ContentNotification } from './content-notification-store';
import {
  getFilmingRecommendation,
  getTopics,
  getUpcomingTopicCount,
  type ContentTopicStatus,
  type ContentFilmingRecommendation,
} from './content-scheduler';
import { getKnowledgeStats, getVoiceDna } from './content-dashboard-service';
import {
  getActiveContentPillars,
  getContentDeskItems,
  getNextContentExecutionHint,
  getRankedContentSignals,
  type ContentDeskItem,
  type ContentExecutionHint,
  type ContentPillarSummary,
  type ContentSignalDigest,
} from './content-intelligence';
import {
  convertPlanningEstimateFromBrl,
  getPreferredCurrencyForUser,
  getAnnualTaxSummary,
  getMonthlyBudgetView,
  getMonthlySummary,
  getTaxEvents,
  type AnnualTaxSummary,
  type MonthlyBudgetView,
  type MonthlySummary,
  type TaxEvent,
} from './finance-tracker';
import { getLatestByType, type ReportDocument } from './report-document-store';
import { getCurrentCoachPhase } from './coach-phase-memory';
import { getSubscriptionStatus, type SubscriptionStatus } from './stripe-service';
import {
  getOverdueTasks,
  getPendingTasks,
  getTasksDueThisWeek,
  getTasksDueToday,
} from './task-store/unified-task-store';
import type { NormalizedTask } from './task-store/types';
import { getFocusBlockRecommendation, type FocusBlockRecommendation } from './focus-planner';
import { readTrainingContextAll, type TrainingContext } from './training-signals';
import {
  getActivePlans,
  getSessionsForWeek,
  getWeeklyAdherence,
  getWeeksForPlan,
  type TrainingPlan,
  type TrainingSession,
  type TrainingWeek,
  type WeeklyAdherenceStats,
} from './training-plans';
import { getEvents, hasWritableCalendarForUser, type UnifiedCalendarEvent } from './unified-calendar';
import { getUnreadMailSummaryForUser, type UserMailPressureSummary } from './unified-mail-pressure';
import { logger } from '../utils/logger';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';

// ── Types ──────────────────────────────────────────────────────────

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

function emptyTrainingFlags(): TrainingContext['flags'] {
  return {
    lowSleep: false,
    lowHrv: false,
    lowReadiness: false,
    highLegLoad: false,
    highShoulderLoad: false,
    raceThisWeek: false,
    lowAdherence: false,
    highAdherence: false,
    planDrift: false,
    calendarConflict: false,
    scheduleStale: false,
    fuelingGap: false,
    budgetConstraint: false,
    contentCommitment: false,
    otherSportRpeToday: 0,
  };
}

function reportInvalidMeshScope(operation: string, userId: number | null | undefined, weekStart?: string): void {
  recordTenantScopeAnomaly({
    layer: 'mesh_context',
    operation,
    reason: userId == null ? 'missing_user_scope' : 'invalid_user_scope',
    userId: userId ?? null,
    details: {
      weekStart: weekStart ?? null,
    },
  });
}

export function createEmptyTrainingMeshContext(opts: { userId: number; weekStart?: string }): TrainingMeshContext {
  const window = resolveWeekWindow(opts.weekStart);
  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    activePlan: null,
    activeWeek: null,
    sessions: [],
    trainingContext: {
      signals: [],
      flags: emptyTrainingFlags(),
    },
    coachBriefing: null,
    adherence: null,
    coachPhaseMemory: null,
    derivedSignals: [],
  };
}

export function createEmptyCookingMeshContext(opts: { userId: number; weekStart?: string }): CookingMeshContext {
  const window = resolveWeekWindow(opts.weekStart);
  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    meals: [],
    shoppingList: null,
    derivedSignals: [],
  };
}

export function createEmptyContentMeshContext(opts: { userId: number; weekStart?: string }): ContentMeshContext {
  const window = resolveWeekWindow(opts.weekStart);
  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    upcomingTopicCount: 0,
    scheduledTopics: [],
    filmingRecommendation: null,
    unreadNotifications: [],
    deskItems: [],
    monitoredPillars: [],
    recentSignals: [],
    nextExecution: null,
    voiceDnaEntries: [],
    knowledgeStats: {
      categories: [],
      referenceChannels: 0,
    },
    derivedSignals: [],
  };
}

export function createEmptySecretaryMeshContext(opts: { userId: number; weekStart?: string }): SecretaryMeshContext {
  const window = resolveWeekWindow(opts.weekStart);
  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    events: [],
    focusBlock: null,
    dueToday: [],
    dueThisWeek: [],
    overdue: [],
    pending: [],
    writableCalendar: false,
    derivedSignals: [],
  };
}

export function createEmptyFinanceMeshContext(opts: { userId: number; weekStart?: string }): FinanceMeshContext {
  const window = resolveWeekWindow(opts.weekStart);
  const month = window.start.toFormat('yyyy-MM');
  const year = window.start.year;
  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    month,
    monthlySummary: {
      month,
      totalIncome: 0,
      totalExpenses: 0,
      totalDeductions: 0,
      netIncome: 0,
      transactionCount: 0,
    },
    budgetView: {
      month,
      basisCurrency: 'EUR',
      currencies: ['EUR'],
      integrity: 'no_income',
      affordability: 'unknown',
      incomeInBasisCurrency: 0,
      expensesInBasisCurrency: 0,
      currentRemainingInBasisCurrency: null,
      currentRemainingRatio: null,
      projectedExpensesInBasisCurrency: null,
      projectedRemainingInBasisCurrency: null,
      projectedRemainingRatio: null,
      recurringExpenseEstimate: 0,
      recurringExpenseCount: 0,
      recurringExpenses: [],
      notes: [],
    },
    taxEvents: [],
    annualSummary: {
      year,
      totalGrossIncome: 0,
      totalDeductions: 0,
      totalInssDue: 0,
      totalTaxDue: 0,
      totalPaid: 0,
      totalPending: 0,
      effectiveAnnualRate: 0,
      monthsPaid: 0,
      monthsPending: 0,
      months: [],
    },
    subscription: {
      plan: 'free',
      period: 'monthly',
      status: 'inactive',
      provider: 'none',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      isActive: false,
      isPro: false,
    },
    derivedSignals: [],
  };
}

// ── Agent-specific signal consumption maps ─────────────────────────

/** Which signal types each agent should consume from peers. */
const AGENT_PEER_SIGNALS: Record<string, SignalType[]> = {
  'performance-agent': ['voice_pattern', 'keyword_opportunity', 'content_formula'],
  'seo-agent': ['retention_pattern', 'hook_effectiveness', 'pillar_performance', 'content_formula'],
  'reaction-radar': ['voice_pattern', 'pillar_performance', 'hook_effectiveness', 'content_formula'],
  'voice-evolution': ['pillar_performance', 'retention_pattern', 'content_formula'],
  'pipeline-agent': ['keyword_opportunity', 'hook_effectiveness', 'pillar_performance', 'content_formula'],
};

// ── Context Builder ────────────────────────────────────────────────

/**
 * Build cross-agent context for a specific agent.
 * Reads peer signals and structures them into typed context.
 * Call this at the start of each agent run.
 */
export function buildAgentContext(agentName: string): AgentContext {
  const peerTypes = AGENT_PEER_SIGNALS[agentName] || [];
  if (peerTypes.length === 0) {
    return emptyContext();
  }

  const signals = readSignals(agentName, peerTypes, 100);
  let consumed = 0;

  const ctx: AgentContext = emptyContext();

  for (const signal of signals) {
    consumed++;
    try {
      switch (signal.signal_type) {
        case 'voice_pattern':
          ctx.voicePatterns.push(extractVoice(signal));
          break;
        case 'pillar_performance':
          ctx.pillarRankings.push(...extractPillarRankings(signal));
          break;
        case 'hook_effectiveness':
          ctx.hookInsights.push(extractHook(signal));
          break;
        case 'retention_pattern':
          ctx.retentionInsights.push(extractRetention(signal));
          break;
        case 'keyword_opportunity':
          ctx.keywordOpportunities.push(extractKeyword(signal));
          break;
        case 'content_formula':
          ctx.contentFormulas.push(extractFormula(signal));
          break;
      }
      markConsumed(signal.id, agentName);
    } catch (err) {
      logger.debug({ err, signal: signal.id }, 'Cross-agent: skipped malformed signal');
    }
  }

  ctx.signalsConsumed = consumed;
  logger.info(
    { agent: agentName, consumed, voices: ctx.voicePatterns.length, pillars: ctx.pillarRankings.length },
    'Cross-agent context built',
  );
  return ctx;
}

/**
 * Format cross-agent context as a text block for inclusion in agent prompts.
 * Returns empty string if no relevant learnings.
 */
export function formatContextForPrompt(ctx: AgentContext): string {
  const sections: string[] = [];

  if (ctx.voicePatterns.length > 0) {
    const voiceLines = ctx.voicePatterns
      .filter(v => v.strength >= 0.5)
      .slice(0, 5)
      .map(v => `  - ${v.observation} (confidence: ${(v.strength * 100).toFixed(0)}%)`);
    if (voiceLines.length > 0) {
      sections.push(`Voice patterns (from Voice Evolution Agent):\n${voiceLines.join('\n')}`);
    }
  }

  if (ctx.pillarRankings.length > 0) {
    const pillarLines = ctx.pillarRankings
      .slice(0, 5)
      .map(p => `  - ${p.pillar}: ${p.avgViews} avg views, ${(p.engagementRate * 100).toFixed(1)}% engagement, trend: ${p.trend}`);
    sections.push(`Pillar performance (from Performance Agent):\n${pillarLines.join('\n')}`);
  }

  if (ctx.hookInsights.length > 0) {
    const hookLines = ctx.hookInsights
      .slice(0, 3)
      .map(h => `  - ${h.hookType}: ${(h.effectiveness * 100).toFixed(0)}% effective`);
    sections.push(`Hook effectiveness (from Performance Agent):\n${hookLines.join('\n')}`);
  }

  if (ctx.keywordOpportunities.length > 0) {
    const kwLines = ctx.keywordOpportunities
      .filter(k => k.direction !== 'stable')
      .slice(0, 5)
      .map(k => `  - "${k.keyword}" — ${k.direction}, volume: ${k.volumeHint}`);
    if (kwLines.length > 0) {
      sections.push(`Keyword opportunities (from SEO Agent):\n${kwLines.join('\n')}`);
    }
  }

  if (ctx.contentFormulas.length > 0) {
    const formulaLines = ctx.contentFormulas
      .filter(f => f.confidence >= 0.6)
      .slice(0, 3)
      .map(f => `  - ${f.formula} (pillar: ${f.pillar}, confidence: ${(f.confidence * 100).toFixed(0)}%)`);
    if (formulaLines.length > 0) {
      sections.push(`Validated content formulas:\n${formulaLines.join('\n')}`);
    }
  }

  if (sections.length === 0) return '';
  return `\n--- Cross-Agent Learnings ---\n${sections.join('\n\n')}\n---`;
}

// ── Learning Digest Writer ─────────────────────────────────────────

/**
 * Produce a learning_digest signal that synthesizes insights from
 * multiple agents. Called weekly (after Performance Agent runs).
 */
export function produceLearningDigest(): number {
  const voiceSignals = readSignals('learning-digest', ['voice_pattern'], 10);
  const pillarSignals = readSignals('learning-digest', ['pillar_performance'], 5);
  const hookSignals = readSignals('learning-digest', ['hook_effectiveness'], 10);
  const kwSignals = readSignals('learning-digest', ['keyword_opportunity'], 10);

  if (voiceSignals.length === 0 && pillarSignals.length === 0) {
    return -1; // nothing to digest
  }

  // Extract top insights
  const topPillars = pillarSignals.flatMap(s => extractPillarRankings(s))
    .sort((a, b) => b.engagementRate - a.engagementRate)
    .slice(0, 3);

  const topVoice = voiceSignals
    .map(s => extractVoice(s))
    .filter(v => v.strength >= 0.7)
    .slice(0, 3);

  const risingKeywords = kwSignals
    .map(s => extractKeyword(s))
    .filter(k => k.direction === 'up' || k.direction === 'new')
    .slice(0, 5);

  const digest = {
    period: new Date().toISOString().slice(0, 10),
    topPillars,
    voiceInsights: topVoice,
    risingKeywords,
    hookCount: hookSignals.length,
    summary: buildDigestSummary(topPillars, topVoice, risingKeywords),
  };

  // Mark all source signals as consumed by digest
  for (const s of [...voiceSignals, ...pillarSignals, ...hookSignals, ...kwSignals]) {
    markConsumed(s.id, 'learning-digest');
  }

  return writeSignal({
    source_agent: 'learning-digest',
    signal_type: 'learning_digest',
    payload: digest,
    priority: 'normal',
  });
}

/**
 * Produce a content_formula signal when a successful pattern is detected.
 *
 * Accepts optional lineage fields (hookType, angleTag, sampleVideoIds,
 * avgViews, avgRetentionPct) so downstream consumers (pipeline
 * scheduler, script generator) can trace a validated formula back to
 * the actual performing content that produced it. Without lineage the
 * signal is pillar-only, which tells the script generator "X pillar
 * works" but not "X pillar with hook type Y and angle Z works at 85%
 * retention". The new fields are optional for backward compatibility —
 * callers that only know the pillar can still pass five positional args.
 */
export function writeContentFormula(
  sourceAgent: string,
  formula: string,
  pillar: string,
  confidence: number,
  evidence: string,
  lineage?: {
    hookType?: string;
    angleTag?: string;
    sampleVideoIds?: string[];
    avgViews?: number;
    avgRetentionPct?: number;
  },
): number {
  return writeSignal({
    source_agent: sourceAgent,
    signal_type: 'content_formula',
    payload: {
      formula,
      pillar,
      confidence,
      evidence,
      detected_at: new Date().toISOString(),
      ...(lineage?.hookType ? { hookType: lineage.hookType } : {}),
      ...(lineage?.angleTag ? { angleTag: lineage.angleTag } : {}),
      ...(lineage?.sampleVideoIds?.length ? { sampleVideoIds: lineage.sampleVideoIds } : {}),
      ...(typeof lineage?.avgViews === 'number' ? { avgViews: lineage.avgViews } : {}),
      ...(typeof lineage?.avgRetentionPct === 'number' ? { avgRetentionPct: lineage.avgRetentionPct } : {}),
    },
    priority: confidence >= 0.8 ? 'normal' : 'background',
    pillar_tag: pillar || undefined,
  });
}

// ── Extractors (signal payload → typed context) ────────────────────

function extractVoice(signal: AgentSignal): VoiceContext {
  const p = signal.payload;
  return {
    observation: p.observation || p.description || '',
    patterns: Array.isArray(p.patterns) ? p.patterns.map((pt: any) => ({
      pattern: pt.pattern || pt.description || '',
      frequency: pt.frequency || 'unknown',
    })) : [],
    strength: typeof p.strength === 'number' ? p.strength : 0.5,
  };
}

function extractPillarRankings(signal: AgentSignal): PillarContext[] {
  const rankings = signal.payload.rankings;
  if (!Array.isArray(rankings)) return [];
  return rankings.map((r: any) => ({
    pillar: r.pillar || '',
    avgViews: r.avg_views || 0,
    engagementRate: r.engagement_rate || 0,
    trend: r.trend || 'stable',
  }));
}

function extractHook(signal: AgentSignal): HookContext {
  const p = signal.payload;
  return {
    hookType: p.hook_type || p.hookType || 'unknown',
    effectiveness: typeof p.effectiveness === 'number' ? p.effectiveness : 0.5,
    examples: Array.isArray(p.examples) ? p.examples : [],
  };
}

function extractRetention(signal: AgentSignal): RetentionContext {
  const p = signal.payload;
  return {
    pattern: p.pattern || p.description || '',
    impact: p.impact || 'neutral',
    avgRetention: typeof p.avg_retention === 'number' ? p.avg_retention : 0,
  };
}

function extractKeyword(signal: AgentSignal): KeywordContext {
  const p = signal.payload;
  return {
    keyword: p.keyword || '',
    direction: p.direction || 'stable',
    volumeHint: p.volume_hint || p.volumeHint || 'unknown',
  };
}

function extractFormula(signal: AgentSignal): ContentFormulaContext {
  const p = signal.payload;
  return {
    formula: p.formula || '',
    pillar: p.pillar || '',
    confidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
    source: signal.source_agent,
  };
}

function buildDigestSummary(
  pillars: PillarContext[],
  voice: VoiceContext[],
  keywords: KeywordContext[],
): string {
  const parts: string[] = [];
  if (pillars.length > 0) {
    parts.push(`Top pillars: ${pillars.map(p => p.pillar).join(', ')}`);
  }
  if (voice.length > 0) {
    parts.push(`${voice.length} voice pattern(s) detected`);
  }
  if (keywords.length > 0) {
    parts.push(`${keywords.length} rising keyword(s): ${keywords.map(k => k.keyword).join(', ')}`);
  }
  return parts.join('. ') || 'No significant learnings this period';
}

function emptyContext(): AgentContext {
  return {
    voicePatterns: [],
    pillarRankings: [],
    hookInsights: [],
    retentionInsights: [],
    keywordOpportunities: [],
    contentFormulas: [],
    signalsConsumed: 0,
  };
}

// ── Stage 2 mesh context helpers ───────────────────────────────────

export async function readTrainingMeshContext(opts: {
  userId: number;
  weekStart?: string;
}): Promise<TrainingMeshContext> {
  if (!isValidTenantUserId(opts.userId)) {
    reportInvalidMeshScope('read_training_mesh_context', opts.userId, opts.weekStart);
    return createEmptyTrainingMeshContext(opts);
  }

  const window = resolveWeekWindow(opts.weekStart);
  const trainingContext = readTrainingContextAll({ userId: opts.userId });
  const coachBriefing = getLatestByType(opts.userId, 'coach_briefing');
  const activePlanMatch = findActivePlanForWeek(opts.userId, window.start);

  const sessions = activePlanMatch?.week ? getSessionsForWeek(activePlanMatch.week.id) : [];
  const adherence = activePlanMatch?.week
    ? getWeeklyAdherence(activePlanMatch.plan.id, activePlanMatch.week.id)
    : null;

  const scheduledSessions = sessions
    .map((session) => ({
      session,
      date: sessionDateForWeek(session, window.start),
      load: inferTrainingLoad(session),
    }))
    .filter((entry) => Boolean(entry.date));

  const hardDays = scheduledSessions
    .filter((entry) => entry.load === 'hard')
    .map((entry) => entry.date);
  const nextSession = nextScheduledSessionForWindow(scheduledSessions);
  const restDays = weekIsoDates(window.start).filter((date) => !scheduledSessions.some((entry) => entry.date === date));
  const recoverySignalIds = trainingContext.signals
    .filter((signal) => ['low_sleep', 'low_hrv', 'low_readiness'].includes(signal.signal_type))
    .map((signal) => signal.id);

  const recoveryState = recoverySignalIds.length >= 2
    ? 'critical'
    : recoverySignalIds.length === 1
      ? 'strained'
      : trainingContext.flags.highAdherence
        ? 'primed'
        : 'stable';

  const derivedSignals: MeshSignalDraft[] = [
    {
      sourceAgent: 'mesh.training-context',
      signalType: 'training_load_forecast',
      meshPriority: 3,
      priority: 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        weekStart: window.weekStart,
        weekEnd: window.weekEnd,
        totalSessions: scheduledSessions.length,
        hardDays,
        hardSessionCount: hardDays.length,
        focus: activePlanMatch?.week?.focus ?? null,
        adherenceRate: adherence?.adherenceRate ?? null,
      },
    },
    {
      sourceAgent: 'mesh.training-context',
      signalType: 'recovery_state',
      meshPriority: recoveryState === 'critical' || recoveryState === 'strained' ? 2 : 3,
      priority: recoveryState === 'critical' || recoveryState === 'strained' ? 'urgent' : 'normal',
      expiresAt: endOfDayIso(window.start),
      payload: {
        date: nextSession?.date ?? window.weekStart,
        state: recoveryState,
        lowSleep: trainingContext.flags.lowSleep,
        lowHrv: trainingContext.flags.lowHrv,
        lowReadiness: trainingContext.flags.lowReadiness,
        sourceSignalIds: recoverySignalIds,
        coachBriefingCreatedAt: coachBriefing?.createdAt ?? null,
      },
    },
  ];

  if (nextSession) {
    derivedSignals.push({
      sourceAgent: 'mesh.training-context',
      signalType: 'session_prescription',
      meshPriority: 3,
      priority: 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        date: nextSession.date,
        title: nextSession.session.title,
        sessionType: nextSession.session.session_type,
        durationMinutes: nextSession.session.duration_minutes,
        intensity: nextSession.session.intensity_text,
        description: nextSession.session.description,
      },
    });

    const immovability = deriveSessionImmovability(nextSession);
    if (immovability) {
      derivedSignals.push({
        sourceAgent: 'mesh.training-context',
        signalType: 'session_immovability',
        meshPriority: immovability.level === 'high' ? 2 : 3,
        priority: immovability.level === 'high' ? 'urgent' : 'normal',
        expiresAt: endOfDayIso(window.end),
        payload: {
          date: nextSession.date,
          title: nextSession.session.title,
          sessionType: nextSession.session.session_type,
          load: nextSession.load,
          level: immovability.level,
          reason: immovability.reason,
        },
      });
    }

    const fueling = deriveFuelingRequirements(nextSession);
    if (fueling) {
      derivedSignals.push({
        sourceAgent: 'mesh.training-context',
        signalType: 'fueling_requirements',
        meshPriority: fueling.supportLevel === 'elevated' ? 2 : 3,
        priority: fueling.supportLevel === 'elevated' ? 'urgent' : 'normal',
        expiresAt: endOfDayIso(window.end),
        payload: {
          date: nextSession.date,
          title: nextSession.session.title,
          sessionType: nextSession.session.session_type,
          load: nextSession.load,
          supportLevel: fueling.supportLevel,
          carbFocus: fueling.carbFocus,
          hydrationFocus: fueling.hydrationFocus,
          proteinRecovery: fueling.proteinRecovery,
          timing: fueling.timing,
        },
      });
    }

    const storyOpportunity = deriveTrainingContentCaptureOpportunity({
      nextSession,
      adherenceRate: adherence?.adherenceRate ?? null,
      recoveryState,
      activeWeekFocus: activePlanMatch?.week?.focus ?? null,
    });
    if (storyOpportunity) {
      derivedSignals.push({
        sourceAgent: 'mesh.training-context',
        signalType: 'content_capture_opportunity',
        meshPriority: storyOpportunity.meshPriority,
        priority: storyOpportunity.priority,
        expiresAt: endOfDayIso(window.end),
        payload: {
          date: nextSession.date,
          title: nextSession.session.title,
          sessionType: nextSession.session.session_type,
          load: nextSession.load,
          angle: storyOpportunity.angle,
          reason: storyOpportunity.reason,
          focus: activePlanMatch?.week?.focus ?? null,
          adherenceRate: adherence?.adherenceRate ?? null,
          recoveryState,
        },
      });
    }
  }

  if (restDays.length > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.training-context',
      signalType: 'rest_day_scheduled',
      meshPriority: 2,
      priority: 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        dates: restDays,
      },
    });
  }

  // Load any persisted coach phase narrative (base / build / peak /
  // taper / recovery + adherence trend + recent deloads) so consumers
  // can interpret this week's signals in the context of the athlete's
  // arc rather than each week as an isolated snapshot.
  const coachPhase = safely(() => getCurrentCoachPhase(opts.userId), null);
  const coachPhaseMemory = coachPhase
    ? {
        phase: coachPhase.phase,
        weekInPhase: coachPhase.weekInPhase,
        phaseTotalWeeks: coachPhase.phaseTotalWeeks,
        narrative: coachPhase.narrative,
        adherenceTrend: coachPhase.adherenceTrend,
        recentDeloadDates: coachPhase.recentDeloadDates,
        activeConcern: coachPhase.activeConcern,
        nextExpectedShift: coachPhase.nextExpectedShift,
        writtenAt: coachPhase.writtenAt,
      }
    : null;

  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    activePlan: activePlanMatch?.plan ?? null,
    activeWeek: activePlanMatch?.week ?? null,
    sessions,
    trainingContext,
    coachBriefing,
    adherence,
    coachPhaseMemory,
    derivedSignals,
  };
}

export async function readCookingMeshContext(opts: {
  userId: number;
  weekStart?: string;
}): Promise<CookingMeshContext> {
  if (!isValidTenantUserId(opts.userId)) {
    reportInvalidMeshScope('read_cooking_mesh_context', opts.userId, opts.weekStart);
    return createEmptyCookingMeshContext(opts);
  }

  const window = resolveWeekWindow(opts.weekStart);
  let meals: MealPlan[] = [];
  let shoppingList: ShoppingList | null = null;

  try {
    meals = getMealPlan(opts.userId, window.weekStart, window.weekEnd);
  } catch (err) {
    logger.debug({ err, userId: opts.userId }, 'Mesh: cooking meal plan unavailable');
  }

  try {
    shoppingList = getShoppingList(opts.userId, window.weekStart);
  } catch (err) {
    logger.debug({ err, userId: opts.userId }, 'Mesh: shopping list unavailable');
  }

  const mealProfiles = meals.map((meal) => buildCookingMealProfile(opts.userId, meal));
  const [calendarEvents, focusBlock] = await Promise.all([
    safelyAsync(
      () => getEvents(window.start.toUTC().toISO()!, window.end.toUTC().toISO()!, opts.userId),
      [] as UnifiedCalendarEvent[],
    ),
    safelyAsync(
      () => getFocusBlockRecommendation(opts.userId, { horizonDays: 7 }),
      null as FocusBlockRecommendation | null,
    ),
  ]);

  const coveredDays = new Set(meals.map((meal) => meal.date));
  const missingDates = weekIsoDates(window.start).filter((date) => !coveredDays.has(date));
  const busyDates = new Set(summarizeBusyDates(calendarEvents));
  const fragmentedDates = new Set(summarizeCalendarFragmentation(calendarEvents).fragmentedDates);
  const travelDates = new Set(extractTravelDates(calendarEvents));
  const focusDate = focusBlock?.date ?? null;
  const constrainedDates = new Set<string>([
    ...busyDates,
    ...fragmentedDates,
    ...travelDates,
    ...(focusDate ? [focusDate] : []),
  ]);
  const prepPressureDates = uniqueStrings(
    mealProfiles
      .filter((profile) => constrainedDates.has(profile.date) && (!profile.hasLinkedRecipe || profile.isHighEffort))
      .map((profile) => profile.date),
  );
  const constrainedMealDates = uniqueStrings(
    meals
      .map((meal) => meal.date)
      .filter((date) => constrainedDates.has(date)),
  );
  const shoppingForecastSource = deriveShoppingForecastSource(shoppingList?.items ?? [], mealProfiles, meals.length);
  const aisleCount = new Set(shoppingForecastSource.items.map((item) => normalizeShoppingAisle(item.aisle)).filter(Boolean)).size;
  const estimatedSpendBrl = estimateShoppingSpendBrl(shoppingForecastSource.items);
  const preferredCurrency = getPreferredCurrencyForUser(opts.userId);
  const estimatedSpend = convertPlanningEstimateFromBrl(estimatedSpendBrl, preferredCurrency);
  const shoppingReady = (shoppingList?.items.length ?? 0) > 0;
  const manualMealCount = mealProfiles.filter((profile) => !profile.hasLinkedRecipe).length;
  const highEffortMealCount = mealProfiles.filter((profile) => profile.isHighEffort).length;
  const totalPrepMinutes = mealProfiles.reduce((sum, profile) => sum + profile.prepMinutes, 0);
  const totalCookMinutes = mealProfiles.reduce((sum, profile) => sum + profile.cookMinutes, 0);

  const activePlanMatch = findActivePlanForWeek(opts.userId, window.start);
  const trainingSessions = activePlanMatch?.week ? getSessionsForWeek(activePlanMatch.week.id) : [];
  const scheduledTraining = trainingSessions
    .map((session) => ({
      session,
      date: sessionDateForWeek(session, window.start),
      load: inferTrainingLoad(session),
    }))
    .filter((entry) => Boolean(entry.date));
  const trainingDates = uniqueStrings(scheduledTraining.map((entry) => entry.date));
  const hardTrainingDates = uniqueStrings(
    scheduledTraining
      .filter((entry) => entry.load === 'hard')
      .map((entry) => entry.date),
  );
  const trainingDatesMissingMeals = trainingDates.filter((date) => !coveredDays.has(date));
  const hardDatesMissingMeals = hardTrainingDates.filter((date) => !coveredDays.has(date));
  const trainingCoverageRatio = trainingDates.length > 0
    ? roundTo((trainingDates.length - trainingDatesMissingMeals.length) / trainingDates.length, 2)
    : null;
  const fuelingSupportStatus = trainingDates.length === 0
    ? null
    : hardDatesMissingMeals.length > 0
      ? 'at_risk'
      : trainingDatesMissingMeals.length > 0 || !shoppingReady
      ? 'partial'
        : 'ready';
  const mealExecutionStatus = missingDates.length >= 3 && !shoppingReady
    ? 'at_risk'
    : prepPressureDates.length >= 2
      ? 'at_risk'
      : missingDates.length > 0 || !shoppingReady || prepPressureDates.length > 0 || manualMealCount > 0
      ? 'partial'
      : 'ready';

  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    meals,
    shoppingList,
    derivedSignals: [
      {
        sourceAgent: 'mesh.cooking-context',
        signalType: 'meal_plan_window',
        meshPriority: 3,
        priority: 'normal',
        expiresAt: endOfDayIso(window.end),
        payload: {
          weekStart: window.weekStart,
          weekEnd: window.weekEnd,
          coveredDays: [...coveredDays],
          totalMeals: meals.length,
          missingDates,
        },
      },
      ...(fuelingSupportStatus
        ? [{
            sourceAgent: 'mesh.cooking-context',
            signalType: 'fueling_support_status' as const,
            meshPriority: (fuelingSupportStatus === 'at_risk' ? 2 : 3) as MeshPriority,
            priority: fuelingSupportStatus === 'at_risk' ? 'urgent' as const : 'normal' as const,
            expiresAt: endOfDayIso(window.end),
            payload: {
              status: fuelingSupportStatus,
              trainingDates,
              trainingDatesMissingMeals,
              hardDatesMissingMeals,
              trainingCoverageRatio,
              shoppingReady,
            },
          }]
        : []),
      {
        sourceAgent: 'mesh.cooking-context',
        signalType: 'meal_execution_readiness',
        meshPriority: (mealExecutionStatus === 'at_risk' ? 2 : 3) as MeshPriority,
        priority: mealExecutionStatus === 'at_risk' ? 'urgent' : 'normal',
        expiresAt: endOfDayIso(window.end),
        payload: {
          status: mealExecutionStatus,
          missingDates,
          shoppingReady,
          shoppingItemCount: shoppingList?.items.length ?? 0,
          coveredDayCount: coveredDays.size,
          constrainedMealDates,
          prepPressureDates,
          manualMealCount,
          highEffortMealCount,
          totalPrepMinutes,
          totalCookMinutes,
          focusDate,
        },
      },
      {
        sourceAgent: 'mesh.cooking-context',
        signalType: 'grocery_spend_forecast',
        meshPriority: 3 as MeshPriority,
        priority: 'background',
        expiresAt: endOfDayIso(window.end),
        payload: {
          estimatedSpendBrl,
          estimatedSpend,
          currency: preferredCurrency,
          itemCount: shoppingForecastSource.items.length,
          aisleCount,
          source: shoppingForecastSource.source,
          confidence: shoppingForecastSource.confidence,
        },
      },
    ],
  };
}

interface CookingMealProfile {
  date: string;
  hasLinkedRecipe: boolean;
  prepMinutes: number;
  cookMinutes: number;
  isHighEffort: boolean;
  ingredients: Ingredient[];
}

function buildCookingMealProfile(userId: number, meal: MealPlan): CookingMealProfile {
  if (!meal.recipe_id) {
    return {
      date: meal.date,
      hasLinkedRecipe: false,
      prepMinutes: 0,
      cookMinutes: 0,
      isHighEffort: false,
      ingredients: [],
    };
  }

  const recipe = safely(() => getRecipeById(userId, meal.recipe_id!), null);
  const prepMinutes = recipe?.prep_time_min ?? 0;
  const cookMinutes = recipe?.cook_time_min ?? 0;
  const totalMinutes = prepMinutes + cookMinutes;

  return {
    date: meal.date,
    hasLinkedRecipe: Boolean(recipe),
    prepMinutes,
    cookMinutes,
    isHighEffort: prepMinutes >= 20 || totalMinutes >= 45,
    ingredients: recipe?.ingredients ?? [],
  };
}

function deriveShoppingForecastSource(
  shoppingItems: ShoppingItem[],
  mealProfiles: CookingMealProfile[],
  mealCount: number,
): {
  source: 'shopping_list' | 'recipe_ingredients' | 'meal_count_fallback';
  confidence: 'high' | 'medium' | 'low';
  items: Array<{ aisle: string }>;
} {
  if (shoppingItems.length > 0) {
    return {
      source: 'shopping_list',
      confidence: 'high',
      items: shoppingItems.map((item) => ({ aisle: item.aisle })),
    };
  }

  const ingredientItems = mealProfiles.flatMap((profile) =>
    profile.ingredients.map((ingredient) => ({
      aisle: classifyIngredientAisle(ingredient.name),
    })),
  );
  if (ingredientItems.length > 0) {
    return {
      source: 'recipe_ingredients',
      confidence: 'medium',
      items: ingredientItems,
    };
  }

  return {
    source: 'meal_count_fallback',
    confidence: mealCount > 0 ? 'low' : 'high',
    items: Array.from({ length: mealCount * 3 }, () => ({ aisle: 'other' })),
  };
}

function estimateShoppingSpendBrl(items: Array<{ aisle: string }>): number {
  const spendByAisle: Record<string, number> = {
    produce: 8,
    protein: 24,
    dairy: 10,
    bakery: 6,
    pantry: 5,
    frozen: 9,
    beverages: 6,
    household: 7,
    other: 6,
  };

  const total = items.reduce((sum, item) => {
    const aisle = normalizeShoppingAisle(item.aisle);
    return sum + (spendByAisle[aisle] ?? spendByAisle.other);
  }, 0);

  return roundTo(total, 2);
}

function normalizeShoppingAisle(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

export async function readContentMeshContext(opts: {
  userId: number;
  weekStart?: string;
}): Promise<ContentMeshContext> {
  if (!isValidTenantUserId(opts.userId)) {
    reportInvalidMeshScope('read_content_mesh_context', opts.userId, opts.weekStart);
    return createEmptyContentMeshContext(opts);
  }

  const window = resolveWeekWindow(opts.weekStart);

  const [filmingResult] = await Promise.allSettled([
    getFilmingRecommendation(opts.userId),
  ]);

  const filmingRecommendation = filmingResult.status === 'fulfilled' ? filmingResult.value : null;
  const unreadNotifications = safely(() => getUnreadNotifications(opts.userId, 10), []);
  const deskItems = safely(() => getContentDeskItems(opts.userId, 4), []);
  const monitoredPillars = safely(() => getActiveContentPillars(opts.userId), []);
  const recentSignals = safely(() => getRankedContentSignals(opts.userId, 6), []);
  const upcomingTopicCount = safely(() => getUpcomingTopicCount(opts.userId, 14), 0);
  const topics = safely(
    () => getTopics(opts.userId, {
      includeTerminal: false,
      limit: 100,
    }),
    [],
  );
  const scheduledTopics = safely(
    () => topics
      .filter((topic) => topic.scheduled_date != null)
      .filter((topic) => topic.scheduled_date! >= window.weekStart && topic.scheduled_date! <= window.weekEnd)
      .slice(0, 20)
      .map((topic) => ({
      id: topic.id,
      title: topic.title,
      scheduledDate: topic.scheduled_date ?? window.weekStart,
      status: topic.status,
    })),
    [],
  );
  const nextExecution = await safelyAsync(
    () => getNextContentExecutionHint(opts.userId, {
      topics,
      deskItems,
      rankedSignals: recentSignals,
      filmingRecommendation,
      pillars: monitoredPillars,
    }),
    null,
  );
  const voiceDnaEntries = safely(() => getVoiceDna(undefined, opts.userId), []);
  const knowledgeStats = safely(() => getKnowledgeStats(undefined, opts.userId), {
    categories: [],
    referenceChannels: 0,
  });

  const derivedSignals: MeshSignalDraft[] = [];
  const readyTopicCount = topics.filter((topic) => topic.status === 'ready').length;
  const draftingTopicCount = topics.filter((topic) => topic.status === 'drafting').length;
  if (upcomingTopicCount > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.content-context',
      signalType: 'publishing_commitment',
      meshPriority: 2,
      priority: 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        upcomingTopicCount,
        unreadContentNotifications: unreadNotifications.length,
        dates: [...new Set(scheduledTopics.map((topic) => topic.scheduledDate))],
        topics: scheduledTopics.slice(0, 8).map((topic) => ({
          id: topic.id,
          title: topic.title,
          date: topic.scheduledDate,
          status: topic.status,
        })),
        nextDate: scheduledTopics[0]?.scheduledDate ?? null,
        nextTopicTitle: scheduledTopics[0]?.title ?? null,
        readyTopicCount,
        draftingTopicCount,
        deskReadyCount: deskItems.length,
        nextExecutionMode: nextExecution?.mode ?? null,
        nextExecutionTitle: nextExecution?.title ?? null,
        topSignalType: recentSignals[0]?.type ?? null,
        topSignalTitle: recentSignals[0]?.title ?? null,
      },
    });
  }

  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    upcomingTopicCount,
    scheduledTopics,
    filmingRecommendation,
    unreadNotifications,
    deskItems,
    monitoredPillars,
    recentSignals,
    nextExecution,
    voiceDnaEntries,
    knowledgeStats,
    derivedSignals,
  };
}

export async function readSecretaryMeshContext(opts: {
  userId: number;
  weekStart?: string;
}): Promise<SecretaryMeshContext> {
  if (!isValidTenantUserId(opts.userId)) {
    reportInvalidMeshScope('read_secretary_mesh_context', opts.userId, opts.weekStart);
    return createEmptySecretaryMeshContext(opts);
  }

  const window = resolveWeekWindow(opts.weekStart);
  const [eventsResult, focusResult, mailPressureResult] = await Promise.allSettled([
    getEvents(window.start.toUTC().toISO()!, window.end.endOf('day').toUTC().toISO()!, opts.userId),
    getFocusBlockRecommendation(opts.userId, { horizonDays: 7 }),
    getUnreadMailSummaryForUser(opts.userId),
  ]);

  const events = eventsResult.status === 'fulfilled' ? eventsResult.value : [];
  const focusBlock = focusResult.status === 'fulfilled' ? focusResult.value : null;
  const mailPressure = mailPressureResult.status === 'fulfilled' ? mailPressureResult.value : null;
  const dueToday = safely(() => getTasksDueToday(opts.userId), []);
  const dueThisWeek = safely(() => getTasksDueThisWeek(opts.userId), []);
  const overdue = safely(() => getOverdueTasks(opts.userId), []);
  const pending = safely(() => getPendingTasks(opts.userId), []);
  const writableCalendar = safely(() => hasWritableCalendarForUser(opts.userId), false);

  const busyDates = summarizeBusyDates(events);
  const travelDates = extractTravelDates(events);
  const fragmentation = summarizeCalendarFragmentation(events);
  const criticalMeetings = summarizeMeetingCriticality(events);
  const portability = summarizeTaskPortability(pending);
  const deadlinePressure = summarizeDeadlinePressure({
    overdueCount: overdue.length,
    dueTodayCount: dueToday.length,
    dueThisWeekCount: dueThisWeek.length,
    pendingCount: pending.length,
    mailUnreadTotal: mailPressure?.totalUnread ?? 0,
  });
  const derivedSignals: MeshSignalDraft[] = [];

  if (busyDates.length > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'calendar_busy_blocks',
      meshPriority: 1,
      priority: 'urgent',
      expiresAt: endOfDayIso(window.end),
      payload: {
        dates: busyDates,
        totalEvents: events.length,
      },
    });
  }

  if (travelDates.length > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'travel_window',
      meshPriority: 1,
      priority: 'urgent',
      expiresAt: endOfDayIso(window.end),
      payload: {
        dates: travelDates,
      },
    });
  }

  derivedSignals.push({
    sourceAgent: 'mesh.secretary-context',
    signalType: 'inbox_pressure',
    meshPriority: deadlinePressure.level === 'high' ? 2 : 4,
    priority: deadlinePressure.level === 'high' ? 'urgent' : overdue.length > 0 ? 'normal' : 'background',
    expiresAt: endOfDayIso(window.start),
    payload: {
      overdueCount: overdue.length,
      dueTodayCount: dueToday.length,
      dueThisWeekCount: dueThisWeek.length,
      pendingCount: pending.length,
      mailUnreadTotal: mailPressure?.totalUnread ?? 0,
      mailProviders: mailPressure?.configuredProviders ?? [],
      outlookUnread: mailPressure?.outlookUnread ?? null,
      gmailUnread: mailPressure?.gmailUnread ?? null,
    },
  });

  if (fragmentation.fragmentedDates.length > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'calendar_fragmentation',
      meshPriority: 2,
      priority: 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        dates: fragmentation.fragmentedDates,
        fragmentedDayCount: fragmentation.fragmentedDates.length,
        maxEventsInDay: fragmentation.maxEventsInDay,
      },
    });
  }

  if (criticalMeetings.criticalEventCount > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'meeting_criticality',
      meshPriority: 2,
      priority: 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        criticalEventCount: criticalMeetings.criticalEventCount,
        dates: criticalMeetings.dates,
        examples: criticalMeetings.examples,
      },
    });
  }

  if (deadlinePressure.level !== 'low') {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'deadline_pressure',
      meshPriority: deadlinePressure.level === 'high' ? 1 : 2,
      priority: deadlinePressure.level === 'high' ? 'urgent' : 'normal',
      expiresAt: endOfDayIso(window.start),
      payload: deadlinePressure,
    });
  }

  if (portability.fixedCount > 0 || portability.portableCount > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'task_portability',
      meshPriority: 3,
      priority: 'background',
      expiresAt: endOfDayIso(window.start),
      payload: portability,
    });
  }

  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    events,
    focusBlock,
    dueToday,
    dueThisWeek,
    overdue,
    pending,
    writableCalendar,
    mailPressure,
    derivedSignals,
  };
}

export async function readFinanceMeshContext(opts: {
  userId: number;
  weekStart?: string;
}): Promise<FinanceMeshContext> {
  if (!isValidTenantUserId(opts.userId)) {
    reportInvalidMeshScope('read_finance_mesh_context', opts.userId, opts.weekStart);
    return createEmptyFinanceMeshContext(opts);
  }

  const window = resolveWeekWindow(opts.weekStart);
  const month = window.start.toFormat('yyyy-MM');
  const year = window.start.year;
  const monthlySummary = safely(() => getMonthlySummary(opts.userId, month), {
    month,
    totalIncome: 0,
    totalExpenses: 0,
    totalDeductions: 0,
    netIncome: 0,
    transactionCount: 0,
  });
  const preferredCurrency = getPreferredCurrencyForUser(opts.userId);
  const budgetView = safely(() => getMonthlyBudgetView(opts.userId, month), {
    month,
    basisCurrency: preferredCurrency,
    currencies: [preferredCurrency],
    integrity: 'no_income' as const,
    affordability: 'unknown' as const,
    incomeInBasisCurrency: 0,
    expensesInBasisCurrency: 0,
    currentRemainingInBasisCurrency: null,
    currentRemainingRatio: null,
    projectedExpensesInBasisCurrency: null,
    projectedRemainingInBasisCurrency: null,
    projectedRemainingRatio: null,
    recurringExpenseEstimate: 0,
    recurringExpenseCount: 0,
    recurringExpenses: [],
    notes: [],
  });
  const taxEvents = safely(() => getTaxEvents(opts.userId, { year, limit: 24 }), []);
  const annualSummary = safely(() => getAnnualTaxSummary(opts.userId, year), {
    year,
    totalGrossIncome: 0,
    totalDeductions: 0,
    totalInssDue: 0,
    totalTaxDue: 0,
    totalPaid: 0,
    totalPending: 0,
    effectiveAnnualRate: 0,
    monthsPaid: 0,
    monthsPending: 0,
    months: [],
  });
  const subscription = safely(() => getSubscriptionStatus(opts.userId), {
    plan: 'free',
    period: 'monthly',
    status: 'inactive',
    provider: 'none',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    isActive: false,
    isPro: false,
  });

  const remainingRatio = budgetView.projectedRemainingRatio ?? budgetView.currentRemainingRatio;
  const nearestPending = taxEvents.find((event) => String(event.status).toLowerCase() !== 'paid') ?? null;
  const renewalDueSoon = subscription.currentPeriodEnd
    ? DateTime.fromISO(subscription.currentPeriodEnd).diffNow('days').days <= 10
    : false;
  const budgetConstraints = remainingRatio != null
    ? deriveBudgetConstraints(remainingRatio, {
      renewalDueSoon,
      hasPendingTax: Boolean(nearestPending),
    })
    : null;
  const derivedSignals: MeshSignalDraft[] = [];

  if (budgetConstraints && remainingRatio != null) {
    derivedSignals.push({
      sourceAgent: 'mesh.finance-context',
      signalType: 'budget_remaining',
      meshPriority: remainingRatio <= 0.25 ? 2 : 3,
      priority: remainingRatio <= 0.25 ? 'urgent' : 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        month,
        remainingRatio: roundTo(remainingRatio, 2),
        currentRemainingRatio: budgetView.currentRemainingRatio,
        projectedRemainingRatio: budgetView.projectedRemainingRatio,
        totalIncome: monthlySummary.totalIncome,
        totalExpenses: monthlySummary.totalExpenses,
        totalDeductions: monthlySummary.totalDeductions,
        basisCurrency: budgetView.basisCurrency,
        integrity: budgetView.integrity,
        affordability: budgetView.affordability,
        recurringExpenseEstimate: budgetView.recurringExpenseEstimate,
        recurringExpenseCount: budgetView.recurringExpenseCount,
        budgetMode: budgetConstraints.budgetMode,
        groceryMode: budgetConstraints.groceryMode,
        trainingSpendMode: budgetConstraints.trainingSpendMode,
        contentSpendMode: budgetConstraints.contentSpendMode,
        supplementMode: budgetConstraints.supplementMode,
        subscriptionMode: budgetConstraints.subscriptionMode,
      },
    });
  } else if (budgetView.integrity === 'mixed_currency') {
    derivedSignals.push({
      sourceAgent: 'mesh.finance-context',
      signalType: 'expense_anomaly',
      meshPriority: 4,
      priority: 'background',
      expiresAt: endOfDayIso(window.end),
      payload: {
        month,
        reason: 'mixed_currency_budget',
        currencies: budgetView.currencies,
        notes: budgetView.notes,
      },
    });
  }

  if (nearestPending) {
    derivedSignals.push({
      sourceAgent: 'mesh.finance-context',
      signalType: 'tax_deadline',
      meshPriority: 1,
      priority: 'urgent',
      expiresAt: endOfDayIso(window.end),
      payload: {
        month: nearestPending.month,
        amountDue: nearestPending.tax_due,
        reminderDate: taxReminderDate(nearestPending.month),
      },
    });
  }

  if (renewalDueSoon && subscription.currentPeriodEnd) {
    derivedSignals.push({
      sourceAgent: 'mesh.finance-context',
      signalType: 'subscription_renewal_due',
      meshPriority: 4,
      priority: 'background',
      expiresAt: subscription.currentPeriodEnd,
      payload: {
        plan: subscription.plan,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
      },
    });
  }

  if (budgetView.integrity === 'reliable'
      && budgetView.incomeInBasisCurrency > 0
      && budgetView.projectedExpensesInBasisCurrency != null
      && budgetView.projectedExpensesInBasisCurrency > budgetView.incomeInBasisCurrency * 0.85) {
    derivedSignals.push({
      sourceAgent: 'mesh.finance-context',
      signalType: 'expense_anomaly',
      meshPriority: 4,
      priority: 'background',
      expiresAt: endOfDayIso(window.end),
      payload: {
        month,
        totalIncome: budgetView.incomeInBasisCurrency,
        totalExpenses: budgetView.projectedExpensesInBasisCurrency,
        ratio: roundTo(budgetView.projectedExpensesInBasisCurrency / budgetView.incomeInBasisCurrency, 2),
        basisCurrency: budgetView.basisCurrency,
      },
    });
  }

  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    month,
    monthlySummary,
    budgetView,
    taxEvents,
    annualSummary,
    subscription,
    derivedSignals,
  };
}

interface WeekWindow {
  start: DateTime;
  end: DateTime;
  weekStart: string;
  weekEnd: string;
}

interface ActivePlanWeekMatch {
  plan: TrainingPlan;
  week: TrainingWeek | null;
}

function deriveBudgetConstraints(
  remainingRatio: number,
  opts: { renewalDueSoon: boolean; hasPendingTax: boolean },
): {
  budgetMode: 'tight' | 'controlled' | 'normal';
  groceryMode: 'essentials_only' | 'cost_aware' | 'normal';
  trainingSpendMode: 'maintenance_only' | 'selective' | 'normal';
  contentSpendMode: 'lean' | 'selective' | 'normal';
  supplementMode: 'essentials_only' | 'pause_new' | 'normal';
  subscriptionMode: 'review_now' | 'confirm_value' | 'stable';
} {
  if (remainingRatio <= 0.15) {
    return {
      budgetMode: 'tight',
      groceryMode: 'essentials_only',
      trainingSpendMode: 'maintenance_only',
      contentSpendMode: 'lean',
      supplementMode: 'essentials_only',
      subscriptionMode: opts.renewalDueSoon || opts.hasPendingTax ? 'review_now' : 'confirm_value',
    };
  }

  if (remainingRatio <= 0.3) {
    return {
      budgetMode: 'controlled',
      groceryMode: 'cost_aware',
      trainingSpendMode: 'selective',
      contentSpendMode: 'selective',
      supplementMode: 'pause_new',
      subscriptionMode: opts.renewalDueSoon ? 'review_now' : 'confirm_value',
    };
  }

  return {
    budgetMode: 'normal',
    groceryMode: 'normal',
    trainingSpendMode: 'normal',
    contentSpendMode: 'normal',
    supplementMode: 'normal',
    subscriptionMode: opts.renewalDueSoon ? 'confirm_value' : 'stable',
  };
}

function resolveWeekWindow(weekStart?: string): WeekWindow {
  const zone = config.app.timezone || 'Europe/Lisbon';
  const base = weekStart
    ? DateTime.fromISO(weekStart, { zone }).startOf('day')
    : DateTime.now().setZone(zone).startOf('week');
  const start = (base.isValid ? base : DateTime.now().setZone(zone)).startOf('week');
  const end = start.plus({ days: 6 }).endOf('day');
  return {
    start,
    end,
    weekStart: start.toISODate()!,
    weekEnd: start.plus({ days: 6 }).toISODate()!,
  };
}

function weekIsoDates(start: DateTime): string[] {
  return Array.from({ length: 7 }, (_, index) => start.plus({ days: index }).toISODate()!);
}

function findActivePlanForWeek(userId: number, targetDate: DateTime): ActivePlanWeekMatch | null {
  const plans = getActivePlans(userId);
  for (const plan of plans) {
    const week = resolveTrainingWeekForDate(plan, targetDate);
    if (week) {
      return { plan, week };
    }
  }
  if (plans[0]) {
    return { plan: plans[0], week: resolveTrainingWeekForDate(plans[0], targetDate) };
  }
  return null;
}

function resolveTrainingWeekForDate(plan: TrainingPlan, targetDate: DateTime): TrainingWeek | null {
  const zone = config.app.timezone || 'Europe/Lisbon';
  const planStart = DateTime.fromISO(plan.start_date, { zone }).startOf('day');
  const diffDays = Math.floor(targetDate.startOf('day').diff(planStart, 'days').days);
  if (diffDays < 0) return null;
  const weekNumber = Math.floor(diffDays / 7) + 1;
  const weeks = getWeeksForPlan(plan.id);
  return weeks.find((week) => week.week_number === weekNumber) ?? null;
}

function sessionDateForWeek(session: TrainingSession, weekStart: DateTime): string {
  const normalized = session.day_of_week.trim().toLowerCase();
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const offset = weekdays.indexOf(normalized);
  return offset >= 0 ? weekStart.plus({ days: offset }).toISODate()! : weekStart.toISODate()!;
}

function inferTrainingLoad(session: TrainingSession): 'hard' | 'moderate' | 'light' {
  const title = `${session.title} ${session.session_type} ${session.intensity_text ?? ''}`.toLowerCase();
  if (/\b(interval|tempo|threshold|ftp|race|track|hill|long run|long ride|vo2)\b/.test(title)) {
    return 'hard';
  }
  if (/\b(strength|brick|endurance|steady|build|moderate)\b/.test(title)) {
    return 'moderate';
  }
  return 'light';
}

function deriveSessionImmovability(
  entry: { session: TrainingSession; date: string; load: 'hard' | 'moderate' | 'light' },
): { level: 'high' | 'medium'; reason: string } | null {
  if (entry.load === 'hard') {
    return {
      level: 'high',
      reason: 'Quality or high-cost session that should stay protected in the week.',
    };
  }
  if (entry.load === 'moderate') {
    return {
      level: 'medium',
      reason: 'Planned progression session that is movable only with care.',
    };
  }
  return null;
}

function deriveFuelingRequirements(
  entry: { session: TrainingSession; date: string; load: 'hard' | 'moderate' | 'light' },
): {
  supportLevel: 'elevated' | 'steady';
  carbFocus: 'high' | 'moderate';
  hydrationFocus: 'elevated' | 'steady';
  proteinRecovery: boolean;
  timing: string;
} | null {
  if (entry.load === 'hard') {
    return {
      supportLevel: 'elevated',
      carbFocus: 'high',
      hydrationFocus: 'elevated',
      proteinRecovery: true,
      timing: 'Protect both pre-session and post-session fueling on this day.',
    };
  }
  if (entry.load === 'moderate') {
    return {
      supportLevel: 'steady',
      carbFocus: 'moderate',
      hydrationFocus: 'steady',
      proteinRecovery: true,
      timing: 'Keep the day fed consistently, especially after the session.',
    };
  }
  return null;
}

function deriveTrainingContentCaptureOpportunity(opts: {
  nextSession: { session: TrainingSession; date: string; load: 'hard' | 'moderate' | 'light' };
  adherenceRate: number | null;
  recoveryState: 'critical' | 'strained' | 'primed' | 'stable';
  activeWeekFocus: string | null;
}): {
  angle: 'coach_adjustment' | 'progress_checkpoint' | 'block_focus';
  reason: string;
  meshPriority: MeshPriority;
  priority: SignalPriority;
} | null {
  const adherenceRate = typeof opts.adherenceRate === 'number' ? opts.adherenceRate : null;

  if ((opts.recoveryState === 'critical' || opts.recoveryState === 'strained') && opts.nextSession.load !== 'light') {
    return {
      angle: 'coach_adjustment',
      reason: 'Recovery is under pressure, so the next key session shows how the coach is adapting the week instead of forcing the original prescription.',
      meshPriority: 2,
      priority: 'normal',
    };
  }

  if (adherenceRate != null && adherenceRate >= 90 && opts.nextSession.load === 'hard') {
    return {
      angle: 'progress_checkpoint',
      reason: 'Adherence is high and the next hard session is a strong progress checkpoint worth explaining or capturing.',
      meshPriority: 3,
      priority: 'normal',
    };
  }

  if (opts.activeWeekFocus && opts.nextSession.load !== 'light') {
    return {
      angle: 'block_focus',
      reason: `The current ${String(opts.activeWeekFocus).toLowerCase()} block is anchored by this session, which makes it a useful coaching story moment.`,
      meshPriority: 4,
      priority: 'background',
    };
  }

  return null;
}

function nextScheduledSessionForWindow(
  scheduledSessions: Array<{ session: TrainingSession; date: string; load: 'hard' | 'moderate' | 'light' }>,
): { session: TrainingSession; date: string; load: 'hard' | 'moderate' | 'light' } | null {
  const today = DateTime.now().setZone(config.app.timezone || 'Europe/Lisbon').toISODate()!;
  return scheduledSessions
    .slice()
    .sort((lhs, rhs) => lhs.date.localeCompare(rhs.date))
    .find((entry) => entry.date >= today)
    ?? scheduledSessions
      .slice()
      .sort((lhs, rhs) => lhs.date.localeCompare(rhs.date))[0]
    ?? null;
}

function summarizeBusyDates(events: UnifiedCalendarEvent[]): string[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const date = String(event.start).slice(0, 10);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([date]) => date)
    .sort();
}

function extractTravelDates(events: UnifiedCalendarEvent[]): string[] {
  const regex = /\b(flight|airport|hotel|travel|trip|voo|aeroporto|hotel|viagem)\b/i;
  return uniqueStrings(events
    .filter((event) => regex.test(String(event.summary ?? '')))
    .map((event) => String(event.start).slice(0, 10)));
}

function summarizeCalendarFragmentation(events: UnifiedCalendarEvent[]): {
  fragmentedDates: string[];
  maxEventsInDay: number;
} {
  const counts = new Map<string, number>();
  for (const event of events) {
    const date = String(event.start).slice(0, 10);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const entries = [...counts.entries()];
  return {
    fragmentedDates: entries
      .filter(([, count]) => count >= 4)
      .map(([date]) => date)
      .sort(),
    maxEventsInDay: entries.reduce((max, [, count]) => Math.max(max, count), 0),
  };
}

function summarizeMeetingCriticality(events: UnifiedCalendarEvent[]): {
  criticalEventCount: number;
  dates: string[];
  examples: string[];
} {
  const regex = /\b(client|cliente|interview|entrevista|doctor|m[eé]dico|meeting|reuni[aã]o|call|sponsor|patroc[ií]nio|filming|shoot|flight|voo|deadline)\b/i;
  const critical = events.filter((event) => regex.test(String(event.summary ?? '')));
  return {
    criticalEventCount: critical.length,
    dates: uniqueStrings(critical.map((event) => String(event.start).slice(0, 10))),
    examples: critical
      .slice(0, 3)
      .map((event) => String(event.summary ?? '').trim())
      .filter(Boolean),
  };
}

function summarizeTaskPortability(tasks: NormalizedTask[]): {
  fixedCount: number;
  portableCount: number;
  portableRatio: number;
} {
  const fixedCount = tasks.filter((task) => Boolean(task.dueDate)).length;
  const portableCount = Math.max(0, tasks.length - fixedCount);
  const portableRatio = tasks.length > 0 ? roundTo(portableCount / tasks.length, 2) : 0;
  return { fixedCount, portableCount, portableRatio };
}

function summarizeDeadlinePressure(opts: {
  overdueCount: number;
  dueTodayCount: number;
  dueThisWeekCount: number;
  pendingCount: number;
  mailUnreadTotal: number;
}): {
  level: 'low' | 'elevated' | 'high';
  overdueCount: number;
  dueTodayCount: number;
  dueThisWeekCount: number;
  pendingCount: number;
  mailUnreadTotal: number;
} {
  const level = opts.overdueCount > 0
    || opts.dueTodayCount >= 3
    || opts.mailUnreadTotal >= 20
    ? 'high'
    : opts.dueTodayCount > 0 || opts.dueThisWeekCount >= 4 || opts.mailUnreadTotal >= 8
      ? 'elevated'
      : 'low';
  return {
    level,
    overdueCount: opts.overdueCount,
    dueTodayCount: opts.dueTodayCount,
    dueThisWeekCount: opts.dueThisWeekCount,
    pendingCount: opts.pendingCount,
    mailUnreadTotal: opts.mailUnreadTotal,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function endOfDayIso(date: DateTime): string {
  return date.endOf('day').toUTC().toISO()!;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function taxReminderDate(month: string): string {
  const parsed = DateTime.fromFormat(month, 'yyyy-MM', { zone: 'UTC' });
  if (!parsed.isValid) return `${month}-28`;
  return parsed.endOf('month').toISODate()!;
}

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function safelyAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
