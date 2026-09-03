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
import {
  degradedPlanSource,
  readyPlanSource,
  unavailablePlanSource,
} from '../secretary-planning-context';
import type { ContentMeshContext, MeshSignalDraft } from './types';
import { endOfDayIso, reportInvalidMeshScope, resolveWeekWindow, safely, safelyAsync } from './mesh-common';

export function createEmptyContentMeshContext(opts: {
  userId: number;
  weekStart?: string;
  timezone?: string;
  referenceNow?: string;
}): ContentMeshContext {
  const window = resolveWeekWindow(opts.weekStart, opts.timezone, opts.referenceNow);
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
    sourceHealth: unavailablePlanSource(
      'CONTENT_STATE_UNAVAILABLE',
      'Content planning state is unavailable.',
    ),
    derivedSignals: [],
  };
}
export async function readContentMeshContext(opts: {
  userId: number;
  tenantId?: number;
  weekStart?: string;
  timezone?: string;
  /** One request-captured UTC instant for implicit week resolution. */
  referenceNow?: string;
}): Promise<ContentMeshContext> {
  if (!isValidTenantUserId(opts.userId)) {
    reportInvalidMeshScope('read_content_mesh_context', opts.userId, opts.weekStart);
    return createEmptyContentMeshContext(opts);
  }

  const window = resolveWeekWindow(opts.weekStart, opts.timezone, opts.referenceNow);
  const readFailures = new Set<string>();
  const recordReadFailure = (source: string) => () => { readFailures.add(source); };

  const [filmingResult] = await Promise.allSettled([
    getFilmingRecommendation(opts.userId, undefined, opts.tenantId, opts.timezone),
  ]);

  if (filmingResult.status === 'rejected') readFailures.add('filming');
  const filmingRecommendation = filmingResult.status === 'fulfilled' ? filmingResult.value : null;
  const tenantId = opts.tenantId ?? opts.userId;
  const unreadNotifications = safely(
    () => getUnreadNotifications(opts.userId, 10, tenantId),
    [],
    recordReadFailure('notifications'),
  );
  const deskItems = safely(
    () => getContentDeskItems(opts.userId, 4, tenantId),
    [],
    recordReadFailure('desk'),
  );
  const monitoredPillars = safely(
    () => getActiveContentPillars(opts.userId, tenantId),
    [],
    recordReadFailure('pillars'),
  );
  const recentSignals = safely(
    () => getRankedContentSignals(opts.userId, 6, opts.tenantId),
    [],
    recordReadFailure('signals'),
  );
  const upcomingTopicCount = safely(
    () => getUpcomingTopicCount(opts.userId, 14, tenantId),
    0,
    recordReadFailure('upcoming_topics'),
  );
  const topics = safely(
    () => getTopics(opts.userId, {
      includeTerminal: false,
      limit: 100,
      tenantId,
    }),
    [],
    recordReadFailure('topics'),
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
    recordReadFailure('topic_projection'),
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
    recordReadFailure('next_execution'),
  );
  const voiceDnaEntries = safely(
    () => getVoiceDna(undefined, opts.userId, opts.tenantId),
    [],
    recordReadFailure('voice_dna'),
  );
  const knowledgeStats = safely(() => getKnowledgeStats(undefined, opts.userId, opts.tenantId), {
    categories: [],
    referenceChannels: 0,
  }, recordReadFailure('knowledge'));

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
    sourceHealth: [
      'filming',
      'notifications',
      'desk',
      'pillars',
      'signals',
      'upcoming_topics',
      'topics',
      'voice_dna',
      'knowledge',
    ].every((source) => readFailures.has(source))
      ? unavailablePlanSource(
          'CONTENT_STATE_UNAVAILABLE',
          'Content planning state is unavailable.',
        )
      : readFailures.size > 0
        ? degradedPlanSource(
            'CONTENT_STATE_DEGRADED',
            'Some Content planning state is unavailable.',
          )
        : readyPlanSource(),
    derivedSignals,
  };
}
