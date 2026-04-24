// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getCached, setCache } from '../../services/cache-store';
import { getLatestByType } from '../../services/report-document-store';
import { setLastCoachState } from '../../domains/domain-handler';
import type { CoachRecommendation } from '../../services/garmin-coach';
import type { CoachRecommendationInput } from '../../services/training-home-view-state';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';

export const COACH_BRIEFING_TTL = 6 * 3600;

export interface CoachBriefingSnapshot {
  briefing: string;
  recommendations: CoachRecommendationInput[];
  garminData: {
    sleepScore: number | null;
    bodyBattery: number | null;
    steps: number | null;
    activeMinutes: number | null;
  } | null;
  degraded?: boolean;
  warnings?: unknown[];
  cachedAt?: string;
  restoredFromReport?: boolean;
  cachedOnlyMiss?: boolean;
  [key: string]: unknown;
}

export function normalizeCoachRecommendation(rec: Record<string, unknown>): CoachRecommendationInput {
  return {
    action: typeof rec.action === 'string' ? rec.action : 'KEEP',
    eventId: typeof rec.eventId === 'string' ? rec.eventId : null,
    source: rec.source === 'google' ? 'google' : 'outlook',
    originalTitle: typeof rec.originalTitle === 'string' ? rec.originalTitle : '',
    newTitle: typeof rec.newTitle === 'string' ? rec.newTitle : null,
    newStart: typeof rec.newStart === 'string' ? rec.newStart : null,
    newEnd: typeof rec.newEnd === 'string' ? rec.newEnd : null,
    summary: typeof rec.summary === 'string' ? rec.summary : null,
    reason: typeof rec.reason === 'string'
      ? rec.reason
      : (typeof rec.summary === 'string' ? rec.summary : ''),
  };
}

export function restoreCoachBriefingFromLatestReport(
  userId: number,
  ttlSeconds = COACH_BRIEFING_TTL,
): CoachBriefingSnapshot | null {
  if (!isValidTenantUserId(userId)) {
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation: 'restore_coach_briefing_from_report',
      reason: 'invalid_user_scope',
      userId,
      details: { reportType: 'coach_briefing' },
    });
    return null;
  }

  try {
    const report = getLatestByType(userId, 'coach_briefing');
    if (!report?.documentJson) return null;

    const createdAtMs = Date.parse(report.createdAt || '');
    if (Number.isNaN(createdAtMs)) return null;

    if (Date.now() - createdAtMs > ttlSeconds * 1000) return null;

    const documentJson = report.documentJson as Record<string, any>;
    const readiness = documentJson.readiness as Record<string, any> | null | undefined;
    const bodyBattery = readiness?.factors?.bodyBattery?.score;

    return {
      briefing: documentJson.message || report.summary || 'Coach briefing available.',
      recommendations: Array.isArray(documentJson.recommendations)
        ? documentJson.recommendations.map((rec) => normalizeCoachRecommendation(rec as Record<string, unknown>))
        : [],
      garminData: readiness
        ? {
            sleepScore: readiness.factors?.sleep?.score ?? null,
            bodyBattery: typeof bodyBattery === 'number' ? bodyBattery : null,
            steps: null,
            activeMinutes: null,
          }
        : null,
      degraded: Array.isArray(documentJson.errors) && documentJson.errors.length > 0,
      warnings: Array.isArray(documentJson.errors) ? documentJson.errors : [],
      cachedAt: report.createdAt,
      restoredFromReport: true,
    };
  } catch {
    return null;
  }
}

export function syncCoachStateForUser(
  userId: number,
  payload: Record<string, unknown>,
): CoachBriefingSnapshot {
  const normalizedRecommendations = Array.isArray(payload.recommendations)
    ? payload.recommendations.map((rec) => normalizeCoachRecommendation(rec as Record<string, unknown>))
    : [];
  const persistedRecommendations: CoachRecommendation[] = normalizedRecommendations.flatMap((rec) =>
    rec.eventId
      ? [{
          action: rec.action as CoachRecommendation['action'],
          eventId: rec.eventId,
          source: rec.source as CoachRecommendation['source'],
          originalTitle: rec.originalTitle ?? '',
          newTitle: rec.newTitle ?? null,
          newStart: rec.newStart ?? null,
          newEnd: rec.newEnd ?? null,
          summary: rec.summary ?? '',
          reason: rec.reason ?? '',
        }]
      : [],
  );
  const briefing = typeof payload.briefing === 'string' && payload.briefing.trim().length > 0
    ? payload.briefing.trim()
    : 'Coach briefing available.';

  setLastCoachState(userId, persistedRecommendations, briefing.slice(0, 500));

  return {
    ...payload,
    briefing,
    garminData: (payload.garminData as CoachBriefingSnapshot['garminData']) ?? null,
    recommendations: normalizedRecommendations,
  } as CoachBriefingSnapshot;
}

export function getCoachBriefingSnapshot(
  userId: number,
  ttlSeconds = COACH_BRIEFING_TTL,
): CoachBriefingSnapshot | null {
  const cacheKey = `coach-briefing:${userId}`;
  const cached = getCached<Record<string, unknown>>(cacheKey);
  if (cached) {
    return syncCoachStateForUser(userId, cached);
  }

  const restored = restoreCoachBriefingFromLatestReport(userId, ttlSeconds);
  if (!restored) return null;

  const payload = syncCoachStateForUser(userId, restored);
  setCache(cacheKey, payload, ttlSeconds);
  return payload;
}
