// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { formatSignalDigest, localizeKnowledgeCategoryLabel, localizeVoiceEntryLabel, summarizeContentJobStatus, summarizeOptimizationStatus, truncateText } from './content-home-route-utils';
import type { Lang } from '../../utils/i18n';
import type { AgentSignal } from '../../services/intelligence-bus';
import { filterActiveContentAgentSignals } from '../../services/content-agent-lifecycle';

type JobStatus = {
  lastRunAt?: string | null;
  lastResult?: 'success' | 'failed' | 'running' | 'never' | null;
};

type VoiceEntry = {
  category: string;
  label: string;
  text: string;
  sources: string[];
  version: number;
  updatedAt: string;
};

type KnowledgeStats = {
  referenceChannels: number;
  categories: Array<{
    category: string;
    sources: number;
    updatedAt: string;
  }>;
};

type FilmingRecommendation = {
  date: string;
  confidence: string;
  reason: string;
} | null;

type MonitoredPillar = {
  name: string;
  keywordCount?: number;
};

type DeskItem = Record<string, any>;

const PAUSED_OPTIMIZATION_AGENT_STATE = Object.freeze({
  performanceLifecycle: 'paused' as const,
  performanceLastRunAt: null,
  performanceLastStatus: 'paused' as const,
  seoLifecycle: 'paused' as const,
  seoLastRunAt: null,
  seoLastStatus: 'paused' as const,
});

const PAUSED_REACTION_RADAR_STATE = Object.freeze({
  reactionRadarLifecycle: 'paused' as const,
  cadenceHours: null,
  lastRunAt: null,
  lastStatus: 'paused' as const,
});

export type ContentPerformanceSummary = {
  count: number;
  avgViews: number;
  avgRetention: number;
  totalLikes: number;
  totalComments: number;
  totalSubsGained: number;
  topEntry: {
    id: number;
    title: string | null;
    views: number;
    retentionPct: number;
    likes: number;
    comments: number;
    subsGained: number;
    loggedAt: string;
  } | null;
  recentEntries: Array<{
    id: number;
    title: string | null;
    views: number;
    retentionPct: number;
    likes: number;
    comments: number;
    subsGained: number;
    loggedAt: string;
  }>;
};

export function buildContentIntelligenceSummary(params: {
  language: Lang;
  autoresearchJob?: JobStatus | null;
  discoverySignals: AgentSignal[];
  optimizationSignals: AgentSignal[];
  performanceSummary?: ContentPerformanceSummary | null;
  voiceEntries: VoiceEntry[];
  knowledgeStats: KnowledgeStats;
}) {
  const { language, autoresearchJob, discoverySignals, optimizationSignals, performanceSummary, voiceEntries, knowledgeStats } = params;
  const activeDiscoverySignals = filterActiveContentAgentSignals(discoverySignals);
  const latestVoiceUpdate = voiceEntries
    .map((entry) => entry.updatedAt)
    .sort((a, b) => b.localeCompare(a))[0] ?? null;
  const sourceCount = new Set(
    voiceEntries.flatMap((entry) => entry.sources).filter((source) => source && source.trim().length > 0),
  ).size;

  return {
    discovery: {
      status: summarizeContentJobStatus(undefined, activeDiscoverySignals.length),
      activeCount: activeDiscoverySignals.length,
      ...PAUSED_REACTION_RADAR_STATE,
    },
    script: {
      status: voiceEntries.length > 0 ? 'ready' : knowledgeStats.referenceChannels > 0 ? 'warming_up' : 'needs_setup',
      voicePatternCount: voiceEntries.length,
      referenceChannelCount: knowledgeStats.referenceChannels,
      sourceCount,
      hasBrandVoice: voiceEntries.some((entry) => entry.category === 'brand_voice' || entry.category === 'voice_summary'),
      lastUpdatedAt: latestVoiceUpdate,
    },
    optimization: {
      status: summarizeOptimizationStatus(undefined, autoresearchJob?.lastResult ?? undefined, optimizationSignals.length),
      cadence: 'weekly',
      activeInsightCount: optimizationSignals.length,
      ...PAUSED_OPTIMIZATION_AGENT_STATE,
      autoresearchLastRunAt: autoresearchJob?.lastRunAt ?? null,
      autoresearchLastStatus: autoresearchJob?.lastResult ?? 'never',
      performanceSummary: performanceSummary ?? emptyPerformanceSummary(),
    },
    schedule: {
      status: 'ready',
      statusSemantics: 'feature_availability_not_calendar_authority',
      calendarAuthority: 'not_included',
    },
    localized: language.startsWith('pt')
      ? {
          discoveryLabel: 'Discovery',
          scriptLabel: 'Script',
          scheduleLabel: 'Schedule',
          optimizationLabel: 'Optimization',
        }
      : null,
  };
}

export function buildContentIntelligenceDetail(params: {
  language: Lang;
  autoresearchJob?: JobStatus | null;
  discoverySignals: AgentSignal[];
  optimizationSignals: AgentSignal[];
  performanceSummary?: ContentPerformanceSummary | null;
  voiceEntries: VoiceEntry[];
  knowledgeStats: KnowledgeStats;
  filmingRecommendation: FilmingRecommendation;
  preferredTopics: string[];
  monitoredPillars: MonitoredPillar[];
  deskItems: DeskItem[];
}) {
  const {
    language,
    autoresearchJob,
    discoverySignals,
    optimizationSignals,
    performanceSummary,
    voiceEntries,
    knowledgeStats,
    filmingRecommendation,
    preferredTopics,
    monitoredPillars,
    deskItems,
  } = params;
  const activeDiscoverySignals = filterActiveContentAgentSignals(discoverySignals);
  const latestVoiceUpdate = voiceEntries
    .map((entry) => entry.updatedAt)
    .sort((a, b) => b.localeCompare(a))[0] ?? null;
  const sourceCount = new Set(
    voiceEntries.flatMap((entry) => entry.sources).filter((source) => source && source.trim().length > 0),
  ).size;

  return {
    discovery: {
      status: summarizeContentJobStatus(undefined, activeDiscoverySignals.length),
      activeCount: activeDiscoverySignals.length,
      ...PAUSED_REACTION_RADAR_STATE,
      deskReadyCount: deskItems.length,
      deskItems,
      preferredTopics,
      monitoredPillars,
      recentSignals: activeDiscoverySignals.map((signal) => formatSignalDigest(signal, language)),
    },
    script: {
      status: voiceEntries.length > 0 ? 'ready' : knowledgeStats.referenceChannels > 0 ? 'warming_up' : 'needs_setup',
      voicePatternCount: voiceEntries.length,
      referenceChannelCount: knowledgeStats.referenceChannels,
      sourceCount,
      hasBrandVoice: voiceEntries.some((entry) => entry.category === 'brand_voice' || entry.category === 'voice_summary'),
      lastUpdatedAt: latestVoiceUpdate,
      entries: voiceEntries.slice(0, 6).map((entry) => ({
        category: entry.category,
        label: localizeVoiceEntryLabel(entry.label, language),
        excerpt: truncateText(entry.text, 200),
        sourceCount: entry.sources.length,
        sources: entry.sources,
        version: entry.version,
        updatedAt: entry.updatedAt,
      })),
      knowledgeCategories: knowledgeStats.categories.map((entry) => ({
        category: entry.category,
        label: localizeKnowledgeCategoryLabel(entry.category, voiceEntries, language),
        sourceCount: entry.sources,
        updatedAt: entry.updatedAt,
      })),
    },
    schedule: {
      status: filmingRecommendation ? 'ready' : 'warming_up',
      statusSemantics: 'recommendation_availability_not_calendar_authority',
      calendarAuthority: 'not_included',
      recommendationSemantics: 'proposal_not_calendar_reservation',
      filmingRecommendation,
    },
    optimization: {
      status: summarizeOptimizationStatus(undefined, autoresearchJob?.lastResult ?? undefined, optimizationSignals.length),
      cadence: 'weekly',
      activeInsightCount: optimizationSignals.length,
      ...PAUSED_OPTIMIZATION_AGENT_STATE,
      autoresearchLastRunAt: autoresearchJob?.lastRunAt ?? null,
      autoresearchLastStatus: autoresearchJob?.lastResult ?? 'never',
      performanceSummary: performanceSummary ?? emptyPerformanceSummary(),
      recentSignals: optimizationSignals.map((signal) => formatSignalDigest(signal, language)),
    },
  };
}

function emptyPerformanceSummary(): ContentPerformanceSummary {
  return {
    count: 0,
    avgViews: 0,
    avgRetention: 0,
    totalLikes: 0,
    totalComments: 0,
    totalSubsGained: 0,
    topEntry: null,
    recentEntries: [],
  };
}
