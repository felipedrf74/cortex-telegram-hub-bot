// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { formatSignalDigest, localizeKnowledgeCategoryLabel, localizeVoiceEntryLabel, summarizeContentJobStatus, summarizeOptimizationStatus, truncateText } from './content-home-route-utils';
import type { Lang } from '../../utils/i18n';
import type { AgentSignal } from '../../services/intelligence-bus';

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

export function buildContentIntelligenceSummary(params: {
  language: Lang;
  reactionJob?: JobStatus | null;
  performanceJob?: JobStatus | null;
  autoresearchJob?: JobStatus | null;
  discoverySignals: AgentSignal[];
  optimizationSignals: AgentSignal[];
  voiceEntries: VoiceEntry[];
  knowledgeStats: KnowledgeStats;
}) {
  const { language, reactionJob, performanceJob, autoresearchJob, discoverySignals, optimizationSignals, voiceEntries, knowledgeStats } = params;
  const latestVoiceUpdate = voiceEntries
    .map((entry) => entry.updatedAt)
    .sort((a, b) => b.localeCompare(a))[0] ?? null;
  const sourceCount = new Set(
    voiceEntries.flatMap((entry) => entry.sources).filter((source) => source && source.trim().length > 0),
  ).size;

  return {
    discovery: {
      status: summarizeContentJobStatus(reactionJob?.lastResult ?? undefined, discoverySignals.length),
      cadenceHours: 4,
      activeCount: discoverySignals.length,
      lastRunAt: reactionJob?.lastRunAt ?? null,
      lastStatus: reactionJob?.lastResult ?? 'never',
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
      status: summarizeOptimizationStatus(performanceJob?.lastResult ?? undefined, autoresearchJob?.lastResult ?? undefined, optimizationSignals.length),
      cadence: 'weekly',
      activeInsightCount: optimizationSignals.length,
      performanceLastRunAt: performanceJob?.lastRunAt ?? null,
      performanceLastStatus: performanceJob?.lastResult ?? 'never',
      autoresearchLastRunAt: autoresearchJob?.lastRunAt ?? null,
      autoresearchLastStatus: autoresearchJob?.lastResult ?? 'never',
    },
    schedule: {
      status: 'ready',
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
  reactionJob?: JobStatus | null;
  performanceJob?: JobStatus | null;
  autoresearchJob?: JobStatus | null;
  discoverySignals: AgentSignal[];
  optimizationSignals: AgentSignal[];
  voiceEntries: VoiceEntry[];
  knowledgeStats: KnowledgeStats;
  filmingRecommendation: FilmingRecommendation;
  preferredTopics: string[];
  monitoredPillars: MonitoredPillar[];
  deskItems: DeskItem[];
}) {
  const {
    language,
    reactionJob,
    performanceJob,
    autoresearchJob,
    discoverySignals,
    optimizationSignals,
    voiceEntries,
    knowledgeStats,
    filmingRecommendation,
    preferredTopics,
    monitoredPillars,
    deskItems,
  } = params;
  const latestVoiceUpdate = voiceEntries
    .map((entry) => entry.updatedAt)
    .sort((a, b) => b.localeCompare(a))[0] ?? null;
  const sourceCount = new Set(
    voiceEntries.flatMap((entry) => entry.sources).filter((source) => source && source.trim().length > 0),
  ).size;

  return {
    discovery: {
      status: summarizeContentJobStatus(reactionJob?.lastResult ?? undefined, discoverySignals.length),
      cadenceHours: 4,
      activeCount: discoverySignals.length,
      lastRunAt: reactionJob?.lastRunAt ?? null,
      lastStatus: reactionJob?.lastResult ?? 'never',
      deskReadyCount: deskItems.length,
      deskItems,
      preferredTopics,
      monitoredPillars,
      recentSignals: discoverySignals.map((signal) => formatSignalDigest(signal, language)),
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
      filmingRecommendation,
    },
    optimization: {
      status: summarizeOptimizationStatus(performanceJob?.lastResult ?? undefined, autoresearchJob?.lastResult ?? undefined, optimizationSignals.length),
      cadence: 'weekly',
      activeInsightCount: optimizationSignals.length,
      performanceLastRunAt: performanceJob?.lastRunAt ?? null,
      performanceLastStatus: performanceJob?.lastResult ?? 'never',
      autoresearchLastRunAt: autoresearchJob?.lastRunAt ?? null,
      autoresearchLastStatus: autoresearchJob?.lastResult ?? 'never',
      recentSignals: optimizationSignals.map((signal) => formatSignalDigest(signal, language)),
    },
  };
}
