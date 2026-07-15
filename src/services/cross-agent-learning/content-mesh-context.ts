// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Deterministic Content mesh adapter. */

import { getUnreadNotifications } from '../content-notification-store';
import { getFilmingRecommendation, getTopics, getUpcomingTopicCount } from '../content-scheduler';
import { getKnowledgeStats, getVoiceDna } from '../content-dashboard-service';
import {
  getActiveContentPillars,
  getContentDeskItems,
  getNextContentExecutionHint,
  getRankedContentSignals,
} from '../content-intelligence';
import { isValidTenantUserId } from '../tenant-scope-observability';
import type { ContentMeshContext, MeshSignalDraft } from './types';
import { endOfDayIso, reportInvalidMeshScope, resolveWeekWindow, safely, safelyAsync } from './mesh-common';

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
export async function readContentMeshContext(opts: {
  userId: number;
  tenantId?: number;
  weekStart?: string;
}): Promise<ContentMeshContext> {
  if (!isValidTenantUserId(opts.userId)) {
    reportInvalidMeshScope('read_content_mesh_context', opts.userId, opts.weekStart);
    return createEmptyContentMeshContext(opts);
  }

  const window = resolveWeekWindow(opts.weekStart);

  const [filmingResult] = await Promise.allSettled([
    getFilmingRecommendation(opts.userId, undefined, opts.tenantId),
  ]);

  const filmingRecommendation = filmingResult.status === 'fulfilled' ? filmingResult.value : null;
  const unreadNotifications = safely(() => getUnreadNotifications(opts.userId, 10), []);
  const deskItems = safely(() => getContentDeskItems(opts.userId, 4), []);
  const monitoredPillars = safely(() => getActiveContentPillars(opts.userId), []);
  const recentSignals = safely(() => getRankedContentSignals(opts.userId, 6, opts.tenantId), []);
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
      tenantId: opts.tenantId,
      topics,
      deskItems,
      rankedSignals: recentSignals,
      filmingRecommendation,
      pillars: monitoredPillars,
    }),
    null,
  );
  const voiceDnaEntries = safely(() => getVoiceDna(undefined, opts.userId, opts.tenantId), []);
  const knowledgeStats = safely(() => getKnowledgeStats(undefined, opts.userId, opts.tenantId), {
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
