// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Deterministic Content mesh adapter. */

import { DateTime } from 'luxon';
import { getUnreadNotifications } from '../content-notification-store';
import { getFilmingRecommendation, getTopics, getUpcomingTopicCount } from '../content-scheduler';
import { getKnowledgeStats, getVoiceDna } from '../content-dashboard-service';
import {
  getActiveContentPillars,
  getContentDeskItems,
  getNextContentExecutionHint,
  getRankedContentSignals,
} from '../content-intelligence';
import {
  getContentCalendar,
  type ContentCalendarReadModel,
} from '../content-workspace-scheduling';
import { isValidTenantUserId } from '../tenant-scope-observability';
import { getUserTimezoneById } from '../user-service';
import { safeContentLogErrorFields } from '../content-log-safety';
import {
  degradedPlanSource,
  readyPlanSource,
  unavailablePlanSource,
} from '../secretary-planning-context';
import { logger } from '../../utils/logger';
import type { ContentMeshContext, ContentMeshUnavailableSection, MeshSignalDraft } from './types';
import { reportInvalidMeshScope, resolveWeekWindow, safely } from './mesh-common';

const ALL_CONTENT_MESH_SECTIONS: readonly ContentMeshUnavailableSection[] = [
  'timezone',
  'filming_recommendation',
  'notifications',
  'content_desk',
  'pillars',
  'signals',
  'topic_count',
  'topics',
  'calendar',
  'next_execution',
  'voice_dna',
  'knowledge_stats',
];

const CONTENT_EXECUTION_INPUT_SECTIONS: readonly ContentMeshUnavailableSection[] = [
  'filming_recommendation',
  'content_desk',
  'pillars',
  'signals',
  'topics',
];

function unavailableWorkSchedule(): ContentMeshContext['workSchedule'] {
  return {
    authority: 'secretary',
    authorityStatus: 'unavailable',
    planStatus: 'unavailable',
    semantics: 'private_work_session',
    confirmedBlocks: [],
    confirmedBlocksComplete: false,
    attentionCount: 0,
  };
}

function calendarEntryDate(value: string, timezone: string | null): string {
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid
    ? parsed.setZone(timezone ?? 'UTC').toISODate()!
    : value.slice(0, 10);
}

function scheduledEffortMinutes(startsAt: string, endsAt: string): number {
  const start = DateTime.fromISO(startsAt, { setZone: true });
  const end = DateTime.fromISO(endsAt, { setZone: true });
  if (!start.isValid || !end.isValid) return 0;
  return Math.max(0, Math.round(end.diff(start, 'minutes').minutes));
}

function contentApprovalState(status: string): ContentMeshContext['workSchedule']['confirmedBlocks'][number]['approvalState'] {
  if (status === 'review') return 'required';
  if (status === 'approved') return 'approved';
  if (status === 'rejected') return 'rejected';
  return 'not_required';
}

function plannedContentWorkBlockOutcome(
  workKind: ContentMeshContext['workSchedule']['confirmedBlocks'][number]['workKind'],
  title: string,
): string {
  const result: Record<typeof workKind, string> = {
    write: 'a writing pass',
    revise: 'a revision pass',
    record: 'a recording session',
    edit: 'an editing pass',
    review: 'a review pass',
    publish_prep: 'an internal publication-preparation pass',
  };
  return `Planned outcome: complete ${result[workKind]} for "${title}".`;
}

export function createEmptyContentMeshContext(opts: {
  userId: number;
  weekStart?: string;
  timezone?: string;
  referenceNow?: string;
}): ContentMeshContext {
  const timezone = opts.timezone ?? safely<string | null>(() => getUserTimezoneById(opts.userId), null);
  const window = resolveWeekWindow(opts.weekStart, timezone, opts.referenceNow);
  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    availability: 'unavailable',
    unavailableSections: [...ALL_CONTENT_MESH_SECTIONS],
    upcomingTopicCount: 0,
    deadlines: [],
    workSchedule: unavailableWorkSchedule(),
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
  if (!isValidTenantUserId(opts.userId) || !isValidTenantUserId(opts.tenantId)) {
    reportInvalidMeshScope('read_content_mesh_context', opts.userId, opts.weekStart);
    return createEmptyContentMeshContext(opts);
  }

  const unavailableSections = new Set<ContentMeshUnavailableSection>();
  const markUnavailable = (section: ContentMeshUnavailableSection, error?: unknown): void => {
    unavailableSections.add(section);
    if (error !== undefined) {
      logger.warn(
        {
          ...safeContentLogErrorFields(error),
          userId: opts.userId,
          tenantId: opts.tenantId,
          section,
        },
        'Content mesh input unavailable',
      );
    }
  };
  const readSync = <T>(
    section: ContentMeshUnavailableSection,
    reader: () => T,
    fallback: T,
  ): T => {
    try {
      return reader();
    } catch (error) {
      markUnavailable(section, error);
      return fallback;
    }
  };
  const readAsync = async <T>(
    section: ContentMeshUnavailableSection,
    reader: () => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    try {
      return await reader();
    } catch (error) {
      markUnavailable(section, error);
      return fallback;
    }
  };

  const timezone = opts.timezone
    ?? readSync<string | null>('timezone', () => getUserTimezoneById(opts.userId), null);
  const window = resolveWeekWindow(opts.weekStart, timezone, opts.referenceNow);
  const tenantId = opts.tenantId;
  const filmingPromise = readAsync(
    'filming_recommendation',
    () => getFilmingRecommendation(opts.userId, undefined, opts.tenantId, timezone ?? undefined),
    null,
  );
  const unreadNotifications = readSync('notifications', () => getUnreadNotifications(opts.userId, 10, tenantId), []);
  const deskItems = readSync('content_desk', () => getContentDeskItems(opts.userId, 4, tenantId), []);
  const monitoredPillars = readSync('pillars', () => getActiveContentPillars(opts.userId, tenantId), []);
  const recentSignals = readSync('signals', () => getRankedContentSignals(opts.userId, 6, opts.tenantId), []);
  const upcomingTopicCount = readSync('topic_count', () => getUpcomingTopicCount(opts.userId, 14, tenantId), 0);
  const topics = readSync(
    'topics',
    () => getTopics(opts.userId, {
      includeTerminal: false,
      limit: 100,
      tenantId,
    }),
    [],
  );
  const calendar = readSync<ContentCalendarReadModel | null>(
    'calendar',
    () => getContentCalendar({
      scope: { tenantId, userId: opts.userId },
      from: window.start.startOf('day').toUTC().toISO()!,
      to: window.start.plus({ days: 7 }).startOf('day').toUTC().toISO()!,
      limit: 500,
    }),
    null,
  );
  const filmingRecommendation = await filmingPromise;
  if (calendar?.hasMore || calendar?.scheduleAuthority.status !== 'current') {
    markUnavailable('calendar');
  }
  const deadlines: ContentMeshContext['deadlines'] = calendar?.entries.flatMap((entry) => (
    entry.kind === 'deadline'
      ? [{
        itemId: entry.item.id,
        title: entry.item.title,
        date: calendarEntryDate(entry.startsAt, window.start.zoneName),
        deadlineAt: entry.startsAt,
        status: entry.item.status,
        semantics: 'target_date_not_publication' as const,
      }]
      : []
  )) ?? [];
  const confirmedBlocks: ContentMeshContext['workSchedule']['confirmedBlocks'] = calendar?.entries.flatMap((entry) => (
    entry.kind === 'work_block'
      && entry.schedule.authority === 'secretary'
      && entry.schedule.authorityStatus === 'current'
      && (
        entry.schedule.state === 'scheduled'
        || entry.schedule.state === 'provider_synced'
        || entry.schedule.state === 'sync_failed'
      )
      ? [{
        itemId: entry.item.id,
        title: entry.item.title,
        itemStatus: entry.item.status,
        outcome: plannedContentWorkBlockOutcome(entry.workKind, entry.item.title),
        estimatedEffortMinutes: scheduledEffortMinutes(entry.startsAt, entry.endsAt),
        // The bounded calendar contract has no prerequisite field. Do not
        // relabel the item's future next action as a dependency.
        dependency: null,
        approvalState: contentApprovalState(entry.item.status),
        nextAction: entry.item.nextAction,
        date: calendarEntryDate(entry.startsAt, window.start.zoneName),
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        workKind: entry.workKind,
        state: entry.schedule.state,
        authority: 'secretary' as const,
        authorityStatus: 'current' as const,
        semantics: 'private_work_session' as const,
        contentChangedSinceScheduling: entry.schedule.contentChangedSinceScheduling,
      }]
      : []
  )) ?? [];
  const attentionCount = calendar?.entries.filter((entry) => (
    entry.kind === 'work_block' && entry.schedule.recoverable
  )).length ?? 0;
  const workSchedule: ContentMeshContext['workSchedule'] = calendar == null
    ? unavailableWorkSchedule()
    : {
      authority: 'secretary',
      authorityStatus: calendar.hasMore
        ? 'partially_unavailable'
        : calendar.scheduleAuthority.status,
      planStatus: calendar.hasMore
        ? 'partial'
        : calendar.scheduleAuthority.status === 'partially_unavailable'
          ? 'partial'
          : confirmedBlocks.length > 0
            ? 'confirmed'
            : filmingRecommendation != null
              ? 'proposed'
              : 'unplanned',
      semantics: 'private_work_session',
      confirmedBlocks,
      confirmedBlocksComplete: !calendar.hasMore,
      attentionCount,
    };
  const nextExecutionDependenciesAvailable = CONTENT_EXECUTION_INPUT_SECTIONS.every(
    (section) => !unavailableSections.has(section),
  );
  let nextExecution: ContentMeshContext['nextExecution'] = null;
  if (nextExecutionDependenciesAvailable) {
    nextExecution = await readAsync(
      'next_execution',
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
  } else {
    markUnavailable('next_execution');
  }
  const voiceDnaEntries = readSync('voice_dna', () => getVoiceDna(undefined, opts.userId, opts.tenantId, { strict: true }), []);
  const knowledgeStats = readSync('knowledge_stats', () => getKnowledgeStats(undefined, opts.userId, opts.tenantId, { strict: true }), {
    categories: [],
    referenceChannels: 0,
  });

  // Deadlines and private work blocks remain typed fields on the mesh context.
  // They are intentionally not collapsed into a "publishing commitment" signal:
  // a target date is advisory, while only a current Secretary-confirmed block
  // carries scheduling authority.
  const derivedSignals: MeshSignalDraft[] = [];
  const unavailableSectionList = ALL_CONTENT_MESH_SECTIONS.filter((section) => unavailableSections.has(section));
  const availability: ContentMeshContext['availability'] = unavailableSectionList.length === 0
    ? 'available'
    : unavailableSectionList.length === ALL_CONTENT_MESH_SECTIONS.length
      ? 'unavailable'
      : 'partial';
  const sourceHealth = availability === 'available'
    ? readyPlanSource()
    : availability === 'unavailable'
      ? unavailablePlanSource(
          'CONTENT_STATE_UNAVAILABLE',
          'Content planning state is unavailable.',
        )
      : degradedPlanSource(
          'CONTENT_STATE_DEGRADED',
          'Some Content planning state is unavailable.',
        );

  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    availability,
    unavailableSections: unavailableSectionList,
    upcomingTopicCount,
    deadlines,
    workSchedule,
    filmingRecommendation,
    unreadNotifications,
    deskItems,
    monitoredPillars,
    recentSignals,
    nextExecution,
    voiceDnaEntries,
    knowledgeStats,
    sourceHealth,
    derivedSignals,
  };
}
