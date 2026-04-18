// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { MeshSignalDraft, ContentMeshContext, SecretaryMeshContext, TrainingMeshContext } from '../services/cross-agent-learning';

export interface EditorialCoordinationResult {
  signals: MeshSignalDraft[];
}

export function buildEditorialCoordinationSignals(opts: {
  content: ContentMeshContext;
  secretary: SecretaryMeshContext;
  training: TrainingMeshContext;
}): EditorialCoordinationResult {
  const { content, secretary, training } = opts;
  const signals: MeshSignalDraft[] = [];
  const recommendation = content.filmingRecommendation;

  if (recommendation) {
    signals.push({
      sourceAgent: 'mesh.editorial-coordinator',
      signalType: 'content_capture_opportunity',
      meshPriority: 4,
      priority: recommendation.confidence === 'high' ? 'normal' : 'background',
      expiresAt: recommendation.blockEnd ?? undefined,
      payload: {
        date: recommendation.date,
        confidence: recommendation.confidence,
        reason: recommendation.reason,
        reasons: recommendation.reasons,
        trainingLoad: recommendation.trainingLoad,
        calendarLoad: recommendation.calendarLoad,
      },
    });

    if (recommendation.calendarReservationAvailable && recommendation.blockStart && recommendation.blockEnd) {
      signals.push({
        sourceAgent: 'mesh.editorial-coordinator',
        signalType: 'shoot_day_locked',
        meshPriority: 3,
        priority: 'normal',
        expiresAt: recommendation.blockEnd,
        payload: {
          date: recommendation.date,
          blockStart: recommendation.blockStart,
          blockEnd: recommendation.blockEnd,
          reservationAvailable: recommendation.calendarReservationAvailable,
        },
      });
    }
  }

  const sponsorNotification = content.unreadNotifications.find((notification) => {
    const haystack = `${notification.title} ${notification.body} ${JSON.stringify(notification.data ?? {})}`.toLowerCase();
    return /\b(sponsor|brand deal|deliverable|patrocínio|parceria)\b/.test(haystack);
  });

  if (sponsorNotification) {
    signals.push({
      sourceAgent: 'mesh.editorial-coordinator',
      signalType: 'sponsor_deliverable_due',
      meshPriority: 1,
      priority: 'urgent',
      expiresAt: sponsorNotification.createdAt,
      payload: {
        notificationId: sponsorNotification.id,
        title: sponsorNotification.title,
      },
    });
  }

  if (!recommendation && secretary.focusBlock && training.trainingContext.flags.lowReadiness === false) {
    signals.push({
      sourceAgent: 'mesh.editorial-coordinator',
      signalType: 'content_capture_opportunity',
      meshPriority: 4,
      priority: 'background',
      expiresAt: secretary.focusBlock.end,
      payload: {
        date: secretary.focusBlock.date,
        confidence: secretary.focusBlock.confidence,
        reason: secretary.focusBlock.reason,
        reasons: secretary.focusBlock.reasons,
        derivedFromFocusBlock: true,
      },
    });
  }

  return { signals };
}
