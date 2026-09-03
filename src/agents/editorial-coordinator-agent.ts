// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { canConsumeConfirmedContentWorkSchedule } from '../services/cross-agent-learning';
import type { MeshSignalDraft, ContentMeshContext, SecretaryMeshContext, TrainingMeshContext } from '../services/cross-agent-learning';

export interface EditorialCoordinationResult {
  signals: MeshSignalDraft[];
}

function sponsorDueEvidence(
  notification: ContentMeshContext['unreadNotifications'][number],
): { dueAt: string | null } | null {
  const text = `${notification.title} ${notification.body}`.toLowerCase();
  const association = `${text} ${JSON.stringify(notification.data ?? {})}`.toLowerCase();
  if (!/\b(sponsor|brand(?:\s+deal)?|deliverable|patrocínio|parceria)\b/.test(association)) return null;

  const dueAt = [
    notification.data?.dueAt,
    notification.data?.due_at,
    notification.data?.dueDate,
    notification.data?.due_date,
    notification.data?.deadlineAt,
    notification.data?.deadline_at,
  ].map((value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    const parsed = DateTime.fromISO(trimmed, { setZone: true });
    // Preserve a validated ISO value verbatim so an explicit source zone is
    // not shifted. Reject malformed/impossible dates instead of normalizing
    // them into a different factual deadline.
    return parsed.isValid && Number.isFinite(parsed.toMillis()) ? trimmed : null;
  }).find((value): value is string => value != null) ?? null;
  const hasExplicitDueLanguage = /\b(due|deadline|overdue|prazo|vence|vencimento)\b|\bentrega\s+(?:até|em)\b/i.test(text);
  return dueAt || hasExplicitDueLanguage ? { dueAt } : null;
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
        planStatus: 'proposed',
        scheduleAuthority: 'secretary',
        scheduleAuthorityStatus: content.workSchedule?.authorityStatus ?? 'unavailable',
        semantics: 'proposal_not_calendar_reservation',
        confidence: recommendation.confidence,
        reason: recommendation.reason,
        reasons: recommendation.reasons,
        trainingLoad: recommendation.trainingLoad,
        calendarLoad: recommendation.calendarLoad,
        nextExecutionMode: nextExecution?.mode ?? null,
        nextExecutionTitle: nextExecution?.title ?? null,
        nextExecutionDateSemantics: nextExecution?.dateSemantics ?? 'none',
        nextExecutionCalendarConfirmed: nextExecution?.calendarConfirmed ?? false,
        sourceSignalType: topSignal?.type ?? null,
        sourceSignalTitle: topSignal?.title ?? null,
      },
    });

  }

  const confirmedSchedule = canConsumeConfirmedContentWorkSchedule(content.workSchedule)
    ? content.workSchedule
    : null;
  for (const block of confirmedSchedule?.confirmedBlocks ?? []) {
    // `shoot_day_locked` is a filming-specific coordination signal. Other
    // Secretary-confirmed Content work (writing, editing, review, etc.) remains
    // protected through the canonical workSchedule block, not this signal.
    if (
      block.workKind !== 'record'
      || block.authority !== 'secretary'
      || block.authorityStatus !== 'current'
      || block.semantics !== 'private_work_session'
      || (
        block.state !== 'scheduled'
        && block.state !== 'provider_synced'
        && block.state !== 'sync_failed'
      )
    ) continue;
    signals.push({
      sourceAgent: 'mesh.editorial-coordinator',
      signalType: 'shoot_day_locked',
      meshPriority: 3,
      priority: 'normal',
      expiresAt: block.endsAt,
      payload: {
        itemId: block.itemId,
        title: block.title,
        date: block.date,
        blockStart: block.startsAt,
        blockEnd: block.endsAt,
        workKind: 'filming',
        sourceWorkKind: block.workKind,
        planStatus: 'confirmed',
        scheduleAuthority: block.authority,
        scheduleAuthorityStatus: block.authorityStatus,
        semantics: block.semantics,
        sourceState: block.state,
        providerAttention: block.state === 'sync_failed',
        contentChangedSinceScheduling: block.contentChangedSinceScheduling,
      },
    });
  }

  const sponsorNotification = content.unreadNotifications
    .map((notification) => ({ notification, due: sponsorDueEvidence(notification) }))
    .find((candidate) => candidate.due != null);

  if (sponsorNotification) {
    signals.push({
      sourceAgent: 'mesh.editorial-coordinator',
      signalType: 'sponsor_deliverable_due',
      meshPriority: 1,
      priority: 'urgent',
      payload: {
        notificationId: sponsorNotification.notification.id,
        title: sponsorNotification.notification.title,
        dueAt: sponsorNotification.due?.dueAt ?? null,
        status: 'factual_constraint',
        publicationAuthority: 'not_established',
        semantics: 'external_deadline_not_publication_authority',
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
        planStatus: 'proposed',
        scheduleAuthority: 'secretary',
        scheduleAuthorityStatus: content.workSchedule?.authorityStatus ?? 'unavailable',
        semantics: 'proposal_not_calendar_reservation',
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
        nextExecutionDateSemantics: nextExecution.dateSemantics,
        nextExecutionCalendarConfirmed: nextExecution.calendarConfirmed,
        derivedFromFocusBlock: true,
      },
    });
  }

  return { signals };
}
