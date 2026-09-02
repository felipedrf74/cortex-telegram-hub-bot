// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { isGoogleCalendarConfigured } from '../../google-calendar';
import { isOutlookCalendarConfigured } from '../../outlook-calendar';
import {
  deleteEvent,
  getEventById,
  getEventsForSources,
  getEventsWithDiagnostics,
  updateEvent,
  type CalendarSource,
  type UnifiedCalendarEvent,
} from '../../unified-calendar';
import {
  claimChatActionRunForExecution,
  reclaimChatActionRunForExecution,
  updateChatActionRun,
  type ChatActionRunStatus,
} from '../../chat-action-run-store';
import type { CalendarProviderDeps, ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import { markPendingChatActionNeedsUserFollowup } from '../../chat-action-state';
import { calendarSourceFromProvider, claimActionRunForStepExecution, reconciliationPendingResult, replayDuplicateClaimedActionRun, updateClaimedActionRun, withProviderReadBackTimeout, withProviderWriteTimeout } from '../../chat/executor/helpers';
import {
  executeSecretaryCalendarCommand,
  executeSecretaryCalendarMutation,
  inspectSecretaryCalendarCommandReplay,
  inspectSecretaryCalendarMutationReplay,
  SecretaryCalendarCommandError,
  SecretaryCalendarMutationError,
} from '../../secretary-calendar-command-service';

export async function executeCalendarCreateStep(
  step: ChatPlanStep,
  _plan: ChatActionPlan,
  input: ChatPlannerInput,
  calendar: CalendarProviderDeps,
  persistRuns: boolean,
  confirmed: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const provider = args.provider === 'outlook_calendar' ? 'outlook' : 'google';
  // The plan timestamp is stable logical metadata, but receipt leases need the
  // current execution attempt's clock so a later retry can recover a crashed
  // worker after the five-minute lease expires.
  const executionNowIso = input.nowIso ?? new Date().toISOString();
  if (!confirmed && Array.isArray(args.attendees) && args.attendees.length > 0) {
    return { step, status: 'needs_confirmation', error: 'attendees_require_confirmation' };
  }

  const commandInput = {
    userId: input.userId,
    tenantId: input.tenantId,
    idempotencyKey: step.idempotencyKey,
    source: provider as CalendarSource,
    // Preserve raw planner values so the shared command service remains the
    // single validator instead of accepting a malformed value after a local
    // String(...) coercion.
    title: args.title,
    start: args.startDateTime,
    end: args.endDateTime,
    timezone: input.timezone,
    attendees: confirmed && Array.isArray(args.attendees)
      ? args.attendees
      : [],
    location: typeof args.location === 'string' ? args.location : undefined,
    description: typeof args.notes === 'string' ? args.notes : undefined,
    recurrence: args.recurrence ?? undefined,
    channel: 'chat' as const,
    nowIso: executionNowIso,
  };
  let claim: ReturnType<typeof claimChatActionRunForExecution> | null = null;
  try {
    const replayProbe = inspectSecretaryCalendarCommandReplay(commandInput);
    // A nonterminal receipt may already represent a provider write whose
    // process stopped before read-back. Let the shared command service
    // reconcile that receipt even if the provider capability has since been
    // disconnected; only brand-new commands are blocked here.
    if (!replayProbe && provider === 'google' && !calendar.hasGoogle(input.userId)) {
      return { step, status: 'blocked', error: 'google_calendar_not_connected_for_write' };
    }
    if (!replayProbe && provider === 'outlook' && !calendar.hasOutlook(input.userId)) {
      return { step, status: 'blocked', error: 'outlook_calendar_not_connected_for_write' };
    }

    claim = persistRuns ? claimChatActionRunForExecution({
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      normalizedActionHash: step.idempotencyKey,
      provider: step.provider,
      actionType: step.action,
      risk: step.risk,
      request: step.args,
      nowIso: executionNowIso,
    }) : null;
    if (claim && !claim.acquired) {
      claim = reclaimChatActionRunForExecution({
        id: claim.row.id,
        retryableErrorMessages: [
          'CALENDAR_SYNC_PENDING',
          'CALENDAR_CONFLICT_STATE_UNKNOWN',
          'CALENDAR_DECISION_REVIEW_PENDING',
        ],
        nowIso: executionNowIso,
      }) ?? claim;
    }
    const duplicate = replayDuplicateClaimedActionRun(claim, step);
    if (duplicate) return duplicate;

    const command = replayProbe?.result ?? await executeSecretaryCalendarCommand(commandInput, {
      configuredSources: [
        ...(calendar.hasGoogle(input.userId) ? ['google' as const] : []),
        ...(calendar.hasOutlook(input.userId) ? ['outlook' as const] : []),
      ],
      calendarIo: {
        ...(calendar.getEventsWithDiagnostics ? {
          getEventsWithDiagnostics: (start: string, end: string, userId: number, options?: { sources?: CalendarSource[] }) =>
            withProviderReadBackTimeout(calendar.getEventsWithDiagnostics!(start, end, userId, options)),
        } : {}),
        getEventsForSources: (start, end, userId, sources) => withProviderReadBackTimeout(
          calendar.getEventsForSources(start, end, userId, sources),
        ),
        createEvent: (data, source, userId, options) => withProviderWriteTimeout((signal) =>
          calendar.createEvent(data, source, userId, { ...options, signal })),
      },
    });
    if (command.status === 'review_required') {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', {
        error: { message: 'calendar_conflict_requires_decision_review' },
      });
      return { step, status: 'blocked', error: 'calendar_conflict_requires_decision_review' };
    }
    const verified = command.event!;
    const result = { event: verified, providerObjectId: verified.id, verified: true, replayed: command.replayed };
    if (!updateClaimedActionRun(claim, 'verified_success', {
      result,
      providerObjectId: verified.id ?? null,
      verification: {
        verified: true,
        expected: step.verification.expectedFields,
        actual: { title: (verified as any).title || verified.summary, start: verified.start, end: verified.end, provider: verified.source },
      },
    })) return reconciliationPendingResult(step, 'verified_success');
    return { step, status: 'verified_success', result };
  } catch (err) {
    if (err instanceof SecretaryCalendarCommandError) {
      if (err.code === 'CALENDAR_PROVIDER_WRITE_FAILED') {
        if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err.code } });
        return { step, status: 'failed', error: 'provider_create_failed' };
      }
      if (err.code === 'CALENDAR_SYNC_PENDING') {
        if (claim) {
          updateChatActionRun(claim.row.id, 'partial_success', {
            error: { message: err.code },
            verification: { verified: false, reason: err.code },
          });
          markPendingChatActionNeedsUserFollowup({
            userId: input.userId,
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            skill: step.skill,
            action: step.action,
            nowIso: executionNowIso,
          });
        }
        return {
          step,
          status: 'partial_success',
          error: err.warningCodes.includes('CALENDAR_READBACK_MISMATCH')
            ? 'provider_read_back_mismatch'
            : 'provider_read_back_failed',
        };
      }
      if (claim) updateChatActionRun(claim.row.id, 'blocked', { error: { message: err.code } });
      return {
        step,
        status: 'blocked',
        error: err.code === 'CALENDAR_CONFLICT_STATE_UNKNOWN'
          ? 'calendar_conflict_state_unknown'
          : err.code === 'CALENDAR_DECISION_REVIEW_PENDING'
            ? 'calendar_conflict_review_pending'
            : err.code === 'TENANT_SCOPE_MISMATCH'
              ? 'tenant_scope_mismatch'
          : err.code === 'IDEMPOTENCY_KEY_REUSED'
            ? 'calendar_idempotency_key_reused'
            : 'calendar_command_invalid',
      };
    }
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
  const executionNowIso = input.nowIso ?? new Date().toISOString();
  if (!source) return { step, status: 'blocked', error: 'calendar_provider_required' };

  const eventId = typeof args.eventId === 'string' ? args.eventId.trim() : '';
  if (!eventId) return { step, status: 'blocked', error: 'calendar_event_id_required' };
  let claim: ReturnType<typeof claimChatActionRunForExecution> | null = null;
  try {
    const commandInput = {
      userId: input.userId,
      tenantId: input.tenantId,
      idempotencyKey: step.idempotencyKey,
      operation: 'update' as const,
      source,
      eventId,
      start: typeof args.startDateTime === 'string' ? args.startDateTime : typeof args.newStartDateTime === 'string' ? args.newStartDateTime : undefined,
      end: typeof args.endDateTime === 'string' ? args.endDateTime : typeof args.newEndDateTime === 'string' ? args.newEndDateTime : undefined,
      title: typeof args.title === 'string' ? args.title : typeof args.newTitle === 'string' ? args.newTitle : undefined,
      description: typeof args.notes === 'string' ? args.notes : typeof args.description === 'string' ? args.description : undefined,
      timezone: input.timezone,
      channel: 'chat' as const,
      nowIso: executionNowIso,
    };
    const replayProbe = inspectSecretaryCalendarMutationReplay(commandInput);
    if (!replayProbe && source === 'google' && !isGoogleCalendarConfigured(input.userId)) {
      return { step, status: 'blocked', error: 'google_calendar_not_connected_for_write' };
    }
    if (!replayProbe && source === 'outlook' && !isOutlookCalendarConfigured(input.userId)) {
      return { step, status: 'blocked', error: 'outlook_calendar_not_connected_for_write' };
    }

    claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
    if (claim && !claim.acquired) {
      claim = reclaimChatActionRunForExecution({
        id: claim.row.id,
        retryableErrorMessages: [
          'CALENDAR_SYNC_PENDING',
          'CALENDAR_CONFLICT_STATE_UNKNOWN',
          'CALENDAR_DECISION_REVIEW_PENDING',
        ],
        nowIso: executionNowIso,
      }) ?? claim;
    }
    const duplicate = replayDuplicateClaimedActionRun(claim, step);
    if (duplicate) return duplicate;

    const command = replayProbe?.result ?? await executeSecretaryCalendarMutation(
      commandInput,
      calendarMutationOptions(input.userId),
    );
    if (command.status === 'review_required') {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', {
        error: { message: 'calendar_conflict_requires_decision_review' },
      });
      return { step, status: 'blocked', error: 'calendar_conflict_requires_decision_review' };
    }
    const updated = command.event!;
    const result = { event: updated, verified: true, replayed: command.replayed };
    if (!updateClaimedActionRun(claim, 'verified_success', {
      result,
      providerObjectId: updated.id ?? eventId,
      verification: { verified: true, expected: step.verification.expectedFields },
    })) return reconciliationPendingResult(step, 'verified_success');
    return { step, status: 'verified_success', result };
  } catch (err) {
    if (err instanceof SecretaryCalendarMutationError) {
      const retryable = err.code === 'CALENDAR_SYNC_PENDING'
        || err.code === 'CALENDAR_CONFLICT_STATE_UNKNOWN'
        || err.code === 'CALENDAR_DECISION_REVIEW_PENDING';
      if (claim) updateChatActionRun(claim.row.id, retryable ? 'partial_success' : 'failed', {
        error: { message: err.code },
        verification: retryable ? { verified: false, reason: err.code } : undefined,
      });
      return {
        step,
        status: retryable ? 'partial_success' : 'failed',
        error: err.code.toLowerCase(),
      };
    }
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
  const executionNowIso = input.nowIso ?? new Date().toISOString();
  if (!source) return { step, status: 'blocked', error: 'calendar_provider_required' };
  const eventId = typeof args.eventId === 'string' ? args.eventId.trim() : '';
  if (!eventId) return { step, status: 'blocked', error: 'calendar_event_id_required' };
  let claim: ReturnType<typeof claimChatActionRunForExecution> | null = null;
  try {
    const commandInput = {
      userId: input.userId,
      tenantId: input.tenantId,
      idempotencyKey: step.idempotencyKey,
      operation: 'delete' as const,
      source,
      eventId,
      timezone: input.timezone,
      channel: 'chat' as const,
      nowIso: executionNowIso,
    };
    const replayProbe = inspectSecretaryCalendarMutationReplay(commandInput);
    if (!replayProbe && source === 'google' && !isGoogleCalendarConfigured(input.userId)) {
      return { step, status: 'blocked', error: 'google_calendar_not_connected_for_write' };
    }
    if (!replayProbe && source === 'outlook' && !isOutlookCalendarConfigured(input.userId)) {
      return { step, status: 'blocked', error: 'outlook_calendar_not_connected_for_write' };
    }

    claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
    if (claim && !claim.acquired) {
      claim = reclaimChatActionRunForExecution({
        id: claim.row.id,
        retryableErrorMessages: ['CALENDAR_SYNC_PENDING', 'CALENDAR_CONFLICT_STATE_UNKNOWN'],
        nowIso: executionNowIso,
      }) ?? claim;
    }
    const duplicate = replayDuplicateClaimedActionRun(claim, step);
    if (duplicate) return duplicate;

    const command = replayProbe?.result ?? await executeSecretaryCalendarMutation(
      commandInput,
      calendarMutationOptions(input.userId),
    );
    const result = { eventId, verified: command.deleted === true, replayed: command.replayed };
    if (!updateClaimedActionRun(claim, 'verified_success', {
      result,
      providerObjectId: eventId,
      verification: { verified: true, expected: { eventId, absent: true } },
    })) return reconciliationPendingResult(step, 'verified_success');
    return { step, status: 'verified_success', result };
  } catch (err) {
    if (err instanceof SecretaryCalendarMutationError) {
      const retryable = err.code === 'CALENDAR_SYNC_PENDING'
        || err.code === 'CALENDAR_CONFLICT_STATE_UNKNOWN';
      if (claim) updateChatActionRun(claim.row.id, retryable ? 'partial_success' : 'failed', {
        error: { message: err.code },
        verification: retryable ? { verified: false, reason: err.code } : undefined,
      });
      return {
        step,
        status: retryable ? 'partial_success' : 'failed',
        error: err.code.toLowerCase(),
      };
    }
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'provider_delete_failed' };
  }
}

function calendarMutationOptions(userId: number) {
  return {
    configuredSources: [
      ...(isGoogleCalendarConfigured(userId) ? ['google' as const] : []),
      ...(isOutlookCalendarConfigured(userId) ? ['outlook' as const] : []),
    ],
    calendarIo: {
      getEventById: (eventId: string, source: CalendarSource, scopedUserId: number) =>
        withProviderReadBackTimeout(getEventById(eventId, source, scopedUserId)),
      getEventsWithDiagnostics: (
        start: string,
        end: string,
        scopedUserId: number,
        options?: { sources?: CalendarSource[] },
      ) => withProviderReadBackTimeout(getEventsWithDiagnostics(start, end, scopedUserId, options)),
      updateEvent: (data: Parameters<typeof updateEvent>[0], source: CalendarSource, scopedUserId: number) =>
        withProviderWriteTimeout((signal) => updateEvent(data, source, scopedUserId, { signal })),
      deleteEvent: (eventId: string, source: CalendarSource, scopedUserId: number) =>
        withProviderWriteTimeout((signal) => deleteEvent(eventId, source, scopedUserId, { signal })),
    },
  };
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
