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
  const nextExecution = content.nextExecution;
  const topSignal = content.recentSignals[0] ?? null;
  const canUseFocusBlock = Boolean(secretary.focusBlock) && training.trainingContext.flags.lowReadiness === false;

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
        nextExecutionMode: nextExecution?.mode ?? null,
        nextExecutionTitle: nextExecution?.title ?? null,
        sourceSignalType: topSignal?.type ?? null,
        sourceSignalTitle: topSignal?.title ?? null,
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

  if (!recommendation && canUseFocusBlock && nextExecution && nextExecution.mode !== 'discovery') {
    signals.push({
      sourceAgent: 'mesh.editorial-coordinator',
      signalType: 'content_capture_opportunity',
      meshPriority: nextExecution.mode === 'reaction_window' ? 2 : 4,
      priority: nextExecution.confidence === 'high'
        ? 'normal'
        : nextExecution.mode === 'reaction_window'
          ? 'urgent'
          : 'background',
      expiresAt: secretary.focusBlock!.end,
      payload: {
        date: secretary.focusBlock!.date,
        confidence: nextExecution.confidence,
        title: nextExecution.title,
        angle: nextExecution.mode,
        reason: nextExecution.summary,
        reasons: [
          nextExecution.summary,
          secretary.focusBlock!.reason,
          ...secretary.focusBlock!.reasons,
        ],
        sourceSignalType: topSignal?.type ?? nextExecution.sourceType,
        sourceSignalTitle: topSignal?.title ?? nextExecution.title,
        derivedFromFocusBlock: true,
      },
    });
  }

  if (
    !recommendation
    && canUseFocusBlock
    && nextExecution?.mode === 'reaction_window'
  ) {
    signals.push({
      sourceAgent: 'mesh.editorial-coordinator',
      signalType: 'shoot_day_locked',
      meshPriority: 2,
      priority: 'urgent',
      expiresAt: secretary.focusBlock!.end,
      payload: {
        date: secretary.focusBlock!.date,
        blockStart: secretary.focusBlock!.start,
        blockEnd: secretary.focusBlock!.end,
        reservationAvailable: false,
        kind: 'reaction_window',
        title: nextExecution.title,
        reason: nextExecution.summary,
      },
    });
  }

  return { signals };
}
