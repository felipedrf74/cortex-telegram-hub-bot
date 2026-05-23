// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { invalidateCalendarCaches } from '../../cache-coherence-registry';
import { isGoogleCalendarConfigured } from '../../google-calendar';
import { isOutlookCalendarConfigured } from '../../outlook-calendar';
import { updateEvent, deleteEvent, getEventsForSources, type CalendarSource, type UnifiedCalendarEvent } from '../../unified-calendar';
import { claimChatActionRunForExecution, updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import type { CalendarProviderDeps, ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import { markPendingChatActionNeedsUserFollowup } from '../../chat-action-state';
import { calendarSourceFromProvider, claimActionRunForStepExecution, reconciliationPendingResult, replayDuplicateClaimedActionRun, updateClaimedActionRun, withProviderReadBackTimeout, withProviderWriteTimeout } from '../../chat/executor/helpers';

export async function executeCalendarCreateStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  calendar: CalendarProviderDeps,
  persistRuns: boolean,
  confirmed: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const provider = args.provider === 'outlook_calendar' ? 'outlook' : 'google';
  if (provider === 'google' && !calendar.hasGoogle(input.userId)) {
    return { step, status: 'blocked', error: 'google_calendar_not_connected_for_write' };
  }
  if (provider === 'outlook' && !calendar.hasOutlook(input.userId)) {
    return { step, status: 'blocked', error: 'outlook_calendar_not_connected_for_write' };
  }
  if (!confirmed && Array.isArray(args.attendees) && args.attendees.length > 0) {
    return { step, status: 'needs_confirmation', error: 'attendees_require_confirmation' };
  }

  const claim = persistRuns
    ? claimChatActionRunForExecution({
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      normalizedActionHash: step.idempotencyKey,
      provider: step.provider,
      actionType: step.action,
      risk: step.risk,
      request: step.args,
      nowIso: plan.createdAt,
    })
    : null;
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;

  const conflicts = await withProviderReadBackTimeout(
    calendar.getEventsForSources(args.startDateTime, args.endDateTime, input.userId, [provider as CalendarSource]),
  )
    .catch(() => [] as UnifiedCalendarEvent[]);
  if (!confirmed && conflicts.some((event) => overlaps(args.startDateTime, args.endDateTime, event.start, event.end))) {
    return { step, status: 'needs_confirmation', error: 'calendar_conflict_requires_confirmation' };
  }

  try {
    const created = await withProviderWriteTimeout((signal) => calendar.createEvent({
      title: String(args.title),
      start: String(args.startDateTime),
      end: String(args.endDateTime),
      attendees: confirmed && Array.isArray(args.attendees)
        ? args.attendees.filter((attendee: unknown): attendee is string => typeof attendee === 'string')
        : [],
      location: typeof args.location === 'string' ? args.location : undefined,
      description: typeof args.notes === 'string' ? args.notes : undefined,
      recurrence: args.recurrence ?? undefined,
    }, provider as CalendarSource, input.userId, { signal }));
    if (claim) updateChatActionRun(claim.row.id, 'verifying', { result: created, providerObjectId: created.id ?? null });
    let readBack: UnifiedCalendarEvent[];
    try {
      readBack = await withProviderReadBackTimeout(
        calendar.getEventsForSources(args.startDateTime, args.endDateTime, input.userId, [provider as CalendarSource]),
      );
    } catch (readBackErr) {
      if (claim) {
        const accepted = updateClaimedActionRun(claim, 'partial_success', {
          providerObjectId: created.id ?? null,
          verification: {
            verified: false,
            reason: readBackErr instanceof Error ? readBackErr.message : 'provider_read_back_failed',
          },
        });
        if (!accepted) return reconciliationPendingResult(step, 'partial_success');
        markPendingChatActionNeedsUserFollowup({
          userId: input.userId,
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          skill: step.skill,
          action: step.action,
          nowIso: plan.createdAt,
        });
      }
      invalidateCalendarCaches(input.userId);
      return { step, status: 'partial_success', result: { created, verified: false }, error: 'provider_read_back_failed' };
    }
    const verified = readBack.find((event) => calendarEventMatches(event, {
      title: String(args.title),
      start: String(args.startDateTime),
      end: String(args.endDateTime),
      source: provider as CalendarSource,
      id: created.id,
    }));
    if (!verified) {
      if (claim) {
        const accepted = updateClaimedActionRun(claim, 'partial_success', {
        providerObjectId: created.id ?? null,
        verification: { verified: false, reason: 'provider_read_back_mismatch' },
        });
        if (!accepted) return reconciliationPendingResult(step, 'partial_success');
        markPendingChatActionNeedsUserFollowup({
          userId: input.userId,
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          skill: step.skill,
          action: step.action,
          nowIso: plan.createdAt,
        });
      }
      return { step, status: 'partial_success', result: { created, verified: false }, error: 'provider_read_back_mismatch' };
    }
    invalidateCalendarCaches(input.userId);
    const result = { event: verified, providerObjectId: created.id, verified: true };
    if (!updateClaimedActionRun(claim, 'verified_success', {
      result,
      providerObjectId: created.id ?? verified.id ?? null,
      verification: {
        verified: true,
        expected: step.verification.expectedFields,
        actual: { title: (verified as any).title || verified.summary, start: verified.start, end: verified.end, provider: verified.source },
      },
    })) return reconciliationPendingResult(step, 'verified_success');
    return { step, status: 'verified_success', result };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'provider_create_failed' };
  }
}

export async function executeCalendarUpdateStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const source = calendarSourceFromProvider(args.provider ?? step.provider);
  if (!source) return { step, status: 'blocked', error: 'calendar_provider_required' };
  if (source === 'google' && !isGoogleCalendarConfigured(input.userId)) return { step, status: 'blocked', error: 'google_calendar_not_connected_for_write' };
  if (source === 'outlook' && !isOutlookCalendarConfigured(input.userId)) return { step, status: 'blocked', error: 'outlook_calendar_not_connected_for_write' };

  const eventId = typeof args.eventId === 'string' ? args.eventId.trim() : '';
  if (!eventId) return { step, status: 'blocked', error: 'calendar_event_id_required' };
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    const updatePayload = {
      event_id: eventId,
      new_start: typeof args.startDateTime === 'string' ? args.startDateTime : typeof args.newStartDateTime === 'string' ? args.newStartDateTime : undefined,
      new_end: typeof args.endDateTime === 'string' ? args.endDateTime : typeof args.newEndDateTime === 'string' ? args.newEndDateTime : undefined,
      new_title: typeof args.title === 'string' ? args.title : typeof args.newTitle === 'string' ? args.newTitle : undefined,
      new_description: typeof args.notes === 'string' ? args.notes : typeof args.description === 'string' ? args.description : undefined,
    };
    const updated = await withProviderWriteTimeout((signal) => updateEvent(updatePayload, source, input.userId, { signal }));
    if (claim) updateChatActionRun(claim.row.id, 'verifying', { result: updated, providerObjectId: updated.id ?? eventId });
    const readStart = updatePayload.new_start || updated.start;
    const readEnd = updatePayload.new_end || updated.end;
    let readBack: UnifiedCalendarEvent[] = [];
    if (readStart && readEnd) {
      try {
        readBack = await withProviderReadBackTimeout(getEventsForSources(readStart, readEnd, input.userId, [source]));
      } catch (readBackErr) {
        if (!updateClaimedActionRun(claim, 'partial_success', {
          result: { event: updated, verified: false },
          providerObjectId: updated.id ?? eventId,
          verification: { verified: false, reason: readBackErr instanceof Error ? readBackErr.message : 'provider_read_back_failed' },
        })) return reconciliationPendingResult(step, 'partial_success');
        invalidateCalendarCaches(input.userId);
        return { step, status: 'partial_success', result: { event: updated, verified: false }, error: 'provider_read_back_failed' };
      }
    }
    const verified = readBack.some((event) => event.id === (updated.id ?? eventId));
    const result = { event: updated, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: updated.id ?? eventId,
      verification: { verified, expected: step.verification.expectedFields },
    })) return reconciliationPendingResult(step, status);
    invalidateCalendarCaches(input.userId);
    return { step, status, result, error: verified ? undefined : 'provider_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'provider_update_failed' };
  }
}

export async function executeCalendarDeleteStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const source = calendarSourceFromProvider(args.provider ?? step.provider);
  if (!source) return { step, status: 'blocked', error: 'calendar_provider_required' };
  const eventId = typeof args.eventId === 'string' ? args.eventId.trim() : '';
  if (!eventId) return { step, status: 'blocked', error: 'calendar_event_id_required' };
  const readStart = typeof args.startDateTime === 'string' ? args.startDateTime : null;
  const readEnd = typeof args.endDateTime === 'string' ? args.endDateTime : null;
  if (!readStart || !readEnd) return { step, status: 'blocked', error: 'calendar_delete_requires_read_back_window' };

  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    await withProviderWriteTimeout((signal) => deleteEvent(eventId, source, input.userId, { signal }));
    if (claim) updateChatActionRun(claim.row.id, 'verifying', { providerObjectId: eventId });
    let readBack: UnifiedCalendarEvent[];
    try {
      readBack = await withProviderReadBackTimeout(getEventsForSources(readStart, readEnd, input.userId, [source]));
    } catch (readBackErr) {
      if (!updateClaimedActionRun(claim, 'partial_success', {
        result: { eventId, verified: false },
        providerObjectId: eventId,
        verification: { verified: false, reason: readBackErr instanceof Error ? readBackErr.message : 'provider_read_back_failed' },
      })) return reconciliationPendingResult(step, 'partial_success');
      invalidateCalendarCaches(input.userId);
      return { step, status: 'partial_success', result: { eventId, verified: false }, error: 'provider_read_back_failed' };
    }
    const verified = !readBack.some((event) => event.id === eventId);
    const result = { eventId, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: eventId,
      verification: { verified, expected: { eventId, absentInWindow: { start: readStart, end: readEnd } } },
    })) return reconciliationPendingResult(step, status);
    invalidateCalendarCaches(input.userId);
    return { step, status, result, error: verified ? undefined : 'provider_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'provider_delete_failed' };
  }
}

export async function executeCalendarReadOnlyStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
  calendar: CalendarProviderDeps,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const source = calendarSourceFromProvider(args.provider ?? step.provider);
  const sources = source ? [source] : (['google', 'outlook'] as CalendarSource[]);
  const day = typeof args.date === 'string'
    ? DateTime.fromISO(args.date, { zone: input.timezone })
    : DateTime.fromISO(input.nowIso ?? new Date().toISOString()).setZone(input.timezone);
  const start = typeof args.startDateTime === 'string' ? args.startDateTime : day.startOf('day').toISO();
  const end = typeof args.endDateTime === 'string' ? args.endDateTime : day.endOf('day').toISO();
  if (!start || !end) return { step, status: 'blocked', error: 'calendar_window_required' };
  try {
    const events = await calendar.getEventsForSources(start, end, input.userId, sources);
    return { step, status: 'verified_success', result: { start, end, events, conflictCount: events.length } };
  } catch {
    return { step, status: 'failed', error: 'calendar_read_failed' };
  }
}

export function overlaps(startA: string, endA: string, startB: string, endB: string): boolean {
  const a1 = DateTime.fromISO(startA).toMillis();
  const a2 = DateTime.fromISO(endA).toMillis();
  const b1 = DateTime.fromISO(startB).toMillis();
  const b2 = DateTime.fromISO(endB).toMillis();
  return Number.isFinite(a1) && Number.isFinite(a2) && Number.isFinite(b1) && Number.isFinite(b2) && a1 < b2 && b1 < a2;
}

export function calendarEventMatches(event: UnifiedCalendarEvent, expected: { title: string; start: string; end: string; source: CalendarSource; id?: string }): boolean {
  const title = String((event as any).title || event.summary || '').trim().toLowerCase();
  const expectedTitle = expected.title.trim().toLowerCase();
  if (event.source !== expected.source) return false;
  if (expected.id && event.id === expected.id) return true;
  return title === expectedTitle
    && Math.abs(DateTime.fromISO(event.start).toMillis() - DateTime.fromISO(expected.start).toMillis()) < 60_000
    && Math.abs(DateTime.fromISO(event.end).toMillis() - DateTime.fromISO(expected.end).toMillis()) < 60_000;
}
