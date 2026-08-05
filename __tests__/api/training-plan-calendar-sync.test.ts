import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getActivePlan: vi.fn(),
  getPlanById: vi.fn(),
  getSessionById: vi.fn(),
  getWeeksForPlan: vi.fn(),
  getSessionsForWeek: vi.fn(),
  linkSessionToCalendar: vi.fn(),
  updateSession: vi.fn(),
  updatePlanPreferences: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  getEvents: vi.fn(),
  isConnected: vi.fn(),
  isTrainingCalendarEventUnclaimed: vi.fn(),
  getPlanVersion: vi.fn(),
  findExistingOwnership: vi.fn(),
  findReusableOwnershipBySessionIdentity: vi.fn(),
  recordCalendarOwnership: vi.fn(),
  markCalendarOwnershipDeleted: vi.fn(),
  previewSecretarySchedulingIntent: vi.fn(),
  submitSecretarySchedulingIntent: vi.fn(),
  markSecretaryAgendaProviderSyncSatisfied: vi.fn(),
  markSecretaryAgendaProviderCleanupRequired: vi.fn(),
  syncTrainingSecretaryCalendarHandoff: vi.fn(),
  cleanupTrainingSecretaryCalendarHandoff: vi.fn(),
  commitTrainingCalendarSessionMapping: vi.fn(),
  retireTrainingCalendarSessionMapping: vi.fn(),
  loadLiveCalendarBusyWindows: vi.fn(),
  getUserTimezoneById: vi.fn(),
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlan: mocks.getActivePlan,
  getPlanById: mocks.getPlanById,
  getSessionById: mocks.getSessionById,
  getWeeksForPlan: mocks.getWeeksForPlan,
  getSessionsForWeek: mocks.getSessionsForWeek,
  linkSessionToCalendar: mocks.linkSessionToCalendar,
  updateSession: mocks.updateSession,
  updatePlanPreferences: mocks.updatePlanPreferences,
}));

vi.mock('../../src/services/unified-calendar', () => ({
  createEvent: mocks.createEvent,
  updateEvent: mocks.updateEvent,
  deleteEvent: mocks.deleteEvent,
  getEventsForSources: mocks.getEvents,
}));

vi.mock('../../src/services/oauth-store', () => ({
  isConnected: mocks.isConnected,
}));

vi.mock('../../src/services/training-calendar-scope', () => ({
  isTrainingCalendarEventUnclaimed: mocks.isTrainingCalendarEventUnclaimed,
}));

vi.mock('../../src/services/training-plan-lifecycle', () => ({
  getPlanVersion: mocks.getPlanVersion,
  findExistingOwnership: mocks.findExistingOwnership,
  findReusableOwnershipBySessionIdentity: mocks.findReusableOwnershipBySessionIdentity,
  recordCalendarOwnership: mocks.recordCalendarOwnership,
  markCalendarOwnershipDeleted: mocks.markCalendarOwnershipDeleted,
}));

vi.mock('../../src/services/secretary-scheduling-arbitrator', () => ({
  previewSecretarySchedulingIntent: (...args: unknown[]) => mocks.previewSecretarySchedulingIntent(...args),
  submitSecretarySchedulingIntent: (...args: unknown[]) => mocks.submitSecretarySchedulingIntent(...args),
  markSecretaryAgendaProviderSyncSatisfied: (...args: unknown[]) => mocks.markSecretaryAgendaProviderSyncSatisfied(...args),
  markSecretaryAgendaProviderCleanupRequired: (...args: unknown[]) => mocks.markSecretaryAgendaProviderCleanupRequired(...args),
}));

vi.mock('../../src/services/secretary-live-calendar-busy', () => ({
  loadLiveCalendarBusyWindowsForSecretaryIntent: (...args: unknown[]) => mocks.loadLiveCalendarBusyWindows(...args),
}));

vi.mock('../../src/services/training-secretary-calendar-handoff', () => ({
  syncTrainingSecretaryCalendarHandoff: (...args: unknown[]) =>
    mocks.syncTrainingSecretaryCalendarHandoff(...args),
  cleanupTrainingSecretaryCalendarHandoff: (...args: unknown[]) =>
    mocks.cleanupTrainingSecretaryCalendarHandoff(...args),
}));

vi.mock('../../src/services/training-calendar-link-commit', () => ({
  commitTrainingCalendarSessionMapping: (...args: unknown[]) =>
    mocks.commitTrainingCalendarSessionMapping(...args),
  retireTrainingCalendarSessionMapping: (...args: unknown[]) =>
    mocks.retireTrainingCalendarSessionMapping(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserTimezoneById: (...args: unknown[]) => mocks.getUserTimezoneById(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    debug: mocks.loggerDebug,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  confirmTrainingSessionReflow,
  previewTrainingSessionReflow,
  syncTrainingPlanCalendar,
} from '../../src/api/routes/training-plan-calendar-sync';
import {
  appendTrainingIdentityMarker,
  buildTrainingSessionIdentityKey,
  computeTrainingSessionShapeHash,
} from '../../src/services/training-session-identity';

function identityFor(planId: number, session: {
  day_of_week: string;
  session_type: string;
  title: string;
  duration_minutes: number;
  intensity_text?: string | null;
  exercises_json?: string | null;
  description_json?: string | null;
}, ordinal = 1): { key: string; shape: string } {
  return {
    key: buildTrainingSessionIdentityKey({
      planId,
      weekNumber: 1,
      dayOfWeek: session.day_of_week,
      sessionType: session.session_type,
      ordinal,
    }),
    shape: computeTrainingSessionShapeHash({
      sessionType: session.session_type,
      title: session.title,
      durationMinutes: session.duration_minutes,
      intensityText: session.intensity_text || null,
      exercises: session.exercises_json || [],
      descriptionSections: session.description_json || null,
    }),
  };
}

function markerDescription(planId: number, planVersion: number, sessionId: number, session: {
  day_of_week: string;
  session_type: string;
  title: string;
  duration_minutes: number;
}, ordinal = 1): string {
  const identity = identityFor(planId, session, ordinal);
  return appendTrainingIdentityMarker('Training session', {
    planId,
    planVersion,
    sessionId,
    sessionIdentityKey: identity.key,
    sessionShapeHash: identity.shape,
  });
}

describe('training-plan-calendar-sync', () => {
  // Pin "now" inside the plan window so future-day filtering is
  // deterministic. plan.start_date = 2026-04-20 (Monday), now = same day.
  const now = new Date('2026-04-20T05:00:00.000Z');

  beforeEach(() => {
    // Reset one-shot implementations as well as call history. Several tests
    // deliberately stop before a provider effect; an unconsumed once-value
    // must never leak into the next independently scoped scenario.
    vi.resetAllMocks();
    delete process.env.TRAINING_ENGINE_ENABLED;
    delete process.env.TRAINING_ENGINE_DISABLED;
    delete process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED;
    delete process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED;
    delete process.env.TRAINING_CALENDAR_WRITES_ENABLED;
    delete process.env.TRAINING_CALENDAR_WRITES_DISABLED;
    delete process.env.TRAINING_CALENDAR_SYNC_ENABLED;
    delete process.env.TRAINING_CALENDAR_SYNC_DISABLED;
    mocks.getEvents.mockResolvedValue([]);
    mocks.getPlanById.mockReset();
    mocks.getSessionById.mockReset();
    mocks.createEvent.mockImplementation(async (_payload: unknown, source: string) => ({
      id: `evt-${source}`,
      source,
    }));
    mocks.updateEvent.mockImplementation(async (payload: { event_id: string }, source: string) => ({
      id: payload.event_id,
      source,
    }));
    mocks.linkSessionToCalendar.mockReturnValue(true);
    mocks.updateSession.mockReturnValue(true);
    mocks.updatePlanPreferences.mockReturnValue(true);
    mocks.deleteEvent.mockResolvedValue(undefined);
    mocks.isConnected.mockImplementation((_userId: number, provider: string) => provider === 'google');
    mocks.isTrainingCalendarEventUnclaimed.mockReturnValue(true);
    mocks.getPlanVersion.mockReturnValue(3);
    mocks.findExistingOwnership.mockReturnValue(null);
    mocks.findReusableOwnershipBySessionIdentity.mockReturnValue(null);
    mocks.recordCalendarOwnership.mockReturnValue({ ok: true, created: true, ownershipId: 99 });
    mocks.markCalendarOwnershipDeleted.mockReturnValue({ ok: true, rowsAffected: 1 });
    mocks.getUserTimezoneById.mockReturnValue('Europe/Lisbon');
    mocks.syncTrainingSecretaryCalendarHandoff.mockReset();
    mocks.cleanupTrainingSecretaryCalendarHandoff.mockReset();
    mocks.commitTrainingCalendarSessionMapping.mockReset();
    mocks.retireTrainingCalendarSessionMapping.mockReset();
    mocks.commitTrainingCalendarSessionMapping.mockImplementation((input: any) => {
      const linked = mocks.linkSessionToCalendar(input.sessionId, input.eventId, input.source);
      if (!linked) throw new Error('TRAINING_CALENDAR_SESSION_LINK_FAILED');
      if (input.sessionPatch && !mocks.updateSession(input.sessionId, input.sessionPatch)) {
        throw new Error('TRAINING_CALENDAR_SESSION_STATE_UPDATE_FAILED');
      }
      const ownership = mocks.recordCalendarOwnership(input.ownership);
      if (!ownership.ok) throw new Error('TRAINING_CALENDAR_OWNERSHIP_RECORD_FAILED');
      return ownership;
    });
    mocks.retireTrainingCalendarSessionMapping.mockImplementation((input: any) => {
      const ownership = mocks.markCalendarOwnershipDeleted({
        eventId: input.eventId,
        source: input.source,
        reason: input.reason,
        tenantId: input.tenantId,
        userId: input.userId,
        planId: input.planId,
        ownershipId: input.ownershipId,
      });
      if (!ownership.ok || ownership.rowsAffected !== 1) {
        throw new Error('TRAINING_CALENDAR_OWNERSHIP_DELETE_FENCE_FAILED');
      }
      if (!input.allowAlreadyUnlinked) {
        const unlinked = mocks.updateSession(input.sessionId, {
          calendar_event_id: null,
          calendar_source: null,
        });
        if (!unlinked) throw new Error('TRAINING_CALENDAR_SESSION_UNLINK_FENCE_FAILED');
      }
      return { ownershipRowsAffected: 1, sessionUnlinked: !input.allowAlreadyUnlinked };
    });
    mocks.cleanupTrainingSecretaryCalendarHandoff.mockImplementation(async (input: any) => {
      try {
        await mocks.deleteEvent(input.providerEventId, input.providerSource, input.ownerUserId);
        return {
          outcome: 'cleanup_complete',
          agendaItemId: `legacy-${input.sourceIntentId}`,
          providerEventId: null,
          providerSource: null,
          startAt: null,
          endAt: null,
          reasonCode: 'provider_event_deleted',
          retryable: false,
          agendaItem: null,
          syncResults: [],
        };
      } catch {
        return {
          outcome: 'pending',
          agendaItemId: `legacy-${input.sourceIntentId}`,
          providerEventId: input.providerEventId,
          providerSource: input.providerSource,
          startAt: null,
          endAt: null,
          reasonCode: 'provider_delete_failed',
          retryable: true,
          agendaItem: null,
          syncResults: [],
        };
      }
    });
    mocks.syncTrainingSecretaryCalendarHandoff.mockImplementation(async (input: any) => {
      const decision = mocks.submitSecretarySchedulingIntent.mock.results.at(-1)?.value as any;
      if (decision?.agendaItem?.lifecycleState === 'proposed') {
        return {
          outcome: 'pending',
          agendaItemId: input.agendaItemId,
          providerEventId: null,
          providerSource: null,
          startAt: null,
          endAt: null,
          reasonCode: 'priority_preemption_dependencies_pending',
          retryable: true,
          agendaItem: decision.agendaItem,
          syncResults: [],
        };
      }
      if (decision?.agendaItem?.lifecycleState === 'canceled'
          || decision?.agendaItem?.providerFailureDisposition === 'terminal') {
        return {
          outcome: 'terminal',
          agendaItemId: input.agendaItemId,
          providerEventId: null,
          providerSource: null,
          startAt: null,
          endAt: null,
          reasonCode: 'priority_preemption_terminal_failure',
          retryable: false,
          agendaItem: decision.agendaItem,
          syncResults: [],
        };
      }
      const cleanupCalls = mocks.markSecretaryAgendaProviderCleanupRequired.mock.calls
        .map((call: any[]) => call[0]);
      const cleanup = [...cleanupCalls]
        .reverse()
        .find((call: any) => call?.agendaItemId === input.agendaItemId);
      if (cleanup?.providerEventId) {
        try {
          await mocks.deleteEvent(cleanup.providerEventId, cleanup.providerSource, input.ownerUserId);
          return {
            outcome: 'cleanup_complete',
            agendaItemId: input.agendaItemId,
            providerEventId: null,
            providerSource: null,
            startAt: null,
            endAt: null,
            reasonCode: 'provider_event_deleted',
            retryable: false,
            agendaItem: null,
            syncResults: [],
          };
        } catch {
          return {
            outcome: 'pending',
            agendaItemId: input.agendaItemId,
            providerEventId: cleanup.providerEventId,
            providerSource: cleanup.providerSource,
            startAt: null,
            endAt: null,
            reasonCode: 'provider_delete_failed',
            retryable: true,
            agendaItem: null,
            syncResults: [],
          };
        }
      }
      const projection = input.trainingProjection;
      if (projection?.existingProviderEventId) {
        const updated = await mocks.updateEvent({
          event_id: projection.existingProviderEventId,
          new_title: projection.title,
          new_start: projection.startAt,
          new_end: projection.endAt,
          new_description: projection.description,
        }, input.providerSource, input.ownerUserId, {});
        return {
          outcome: 'ready',
          agendaItemId: input.agendaItemId,
          providerEventId: updated?.id ?? projection.existingProviderEventId,
          providerSource: updated?.source ?? input.providerSource,
          startAt: projection.startAt,
          endAt: projection.endAt,
          reasonCode: 'provider_event_updated',
          retryable: false,
          agendaItem: null,
          syncResults: [],
        };
      }
      const created = await mocks.createEvent({
        title: projection.title,
        start: projection.startAt,
        end: projection.endAt,
        description: projection.description,
      }, input.providerSource, input.ownerUserId, { tenantId: input.tenantId });
      return {
        outcome: 'ready',
        agendaItemId: input.agendaItemId,
        providerEventId: created.id,
        providerSource: created.source,
        startAt: projection.startAt,
        endAt: projection.endAt,
        reasonCode: 'provider_event_created',
        retryable: false,
        agendaItem: null,
        syncResults: [],
      };
    });
    mocks.previewSecretarySchedulingIntent.mockImplementation((intent: any) => ({
      status: 'scheduled',
      reasonCodes: ['scheduled_in_available_window'],
      recommendedSlot: intent.preferredWindows[0],
      alternatives: [],
      confidence: 'high',
      wouldReflow: false,
      wouldCompress: false,
      reasoningTrail: [],
      noPersist: true,
    }));
    mocks.loadLiveCalendarBusyWindows.mockResolvedValue({
      windows: [],
      degraded: false,
      providerConfigured: true,
      warningCodes: [],
      warnings: [],
    });
    mocks.submitSecretarySchedulingIntent.mockImplementation((intent: any) => ({
      status: 'scheduled',
      reasonCodes: ['scheduled_in_available_window'],
      selectedSlot: intent.preferredWindows[0],
      agendaItem: {
        agendaItemId: `sec-${intent.sourceEntityId}`,
        sourceIntentId: intent.intentId,
        lifecycleState: 'scheduled',
      },
      explanation: 'scheduled by Secretary',
      alternativeSlots: [],
      conflicts: [],
      downstreamImplications: [],
      confidence: 'high',
      feedback: {
        sourceSkill: 'training',
        sourceIntentId: intent.intentId,
        agendaItemId: `sec-${intent.sourceEntityId}`,
        status: 'scheduled',
        reasonCodes: ['scheduled_in_available_window'],
        scheduledStart: intent.preferredWindows[0].start,
        scheduledEnd: intent.preferredWindows[0].end,
        shouldRefreshSource: false,
        downstreamImplications: [],
      },
    }));
  });

  it('previews a conflict reflow destination before mutating the session or provider', async () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED = 'true';
    mocks.isConnected.mockImplementation((_userId: number, provider: string) => provider === 'outlook');
    mocks.getPlanById.mockReturnValue({
      id: 7,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({
        preferredTime: '12:00',
        preferredCardioTime: '07:00',
        preferredStrengthTime: '18:00',
      }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 70, week_number: 1 }]);
    mocks.getSessionById.mockReturnValue({
      id: 100,
      week_id: 70,
      plan_id: 7,
      day_of_week: 'Monday',
      session_type: 'gym',
      title: 'Strength + Core',
      duration_minutes: 40,
      description: 'Lifting day.',
      status: 'scheduled',
      calendar_event_id: null,
      calendar_source: null,
      session_identity_key: null,
      session_shape_hash: null,
      intensity_text: null,
      exercises_json: null,
      description_json: null,
    });
    mocks.getEvents.mockResolvedValue([
      {
        id: 'busy-outlook',
        source: 'outlook',
        summary: 'Focus block',
        start: '2026-04-20T17:30:00.000Z',
        end: '2026-04-20T18:30:00.000Z',
      },
    ]);

    const result = await previewTrainingSessionReflow(42, 100, 'outlook', 42);

    expect(result.status).toBe('preview');
    expect(mocks.loadLiveCalendarBusyWindows).toHaveBeenCalledWith(expect.objectContaining({
      sourceSkill: 'training',
      softPreferences: { calendarProvider: 'outlook' },
      minimumDurationMinutes: 30,
    }));
    if (result.status === 'preview') {
      expect(result.data.provider).toBe('outlook');
      expect(result.data.current.start).toBeTruthy();
      expect(result.data.proposed.start).not.toBe(result.data.current.start);
      expect(result.data.proposed.start).toBeTruthy();
      expect(result.data.whyThisSlot).toContain('before Nexus changes');
    }
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.updateEvent).not.toHaveBeenCalled();
  });

  it('returns calendar_degraded when live calendar availability cannot be checked for reflow preview', async () => {
    mocks.getPlanById.mockReturnValue({
      id: 7,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredTime: '12:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 70, week_number: 1 }]);
    mocks.getSessionById.mockReturnValue({
      id: 100,
      week_id: 70,
      plan_id: 7,
      day_of_week: 'Monday',
      session_type: 'run',
      title: 'Base Run',
      duration_minutes: 45,
      description: 'Easy aerobic run.',
      status: 'scheduled',
      calendar_event_id: null,
      calendar_source: null,
      session_identity_key: null,
      session_shape_hash: null,
      intensity_text: null,
      exercises_json: null,
      description_json: null,
    });
    mocks.loadLiveCalendarBusyWindows.mockResolvedValueOnce({
      windows: [],
      degraded: true,
      providerConfigured: true,
      warningCodes: ['GOOGLE_CALENDAR_UNAVAILABLE'],
      warnings: ['Google Calendar is unavailable right now.'],
    });

    const result = await previewTrainingSessionReflow(42, 100, 'google', 42);

    expect(result.status).toBe('calendar_degraded');
    if (result.status === 'calendar_degraded') {
      expect(result.data).toMatchObject({
        provider: 'google',
        sessionId: 100,
        reason: 'TRAINING_SECRETARY_LIVE_BUSY_WINDOWS_DEGRADED',
        warningCodes: ['GOOGLE_CALENDAR_UNAVAILABLE'],
      });
    }
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.updateEvent).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it('returns the same not-found preview result for foreign and missing sessions', async () => {
    mocks.getSessionById.mockReturnValue({ id: 100, week_id: 70, plan_id: 7 });
    mocks.getPlanById.mockReturnValue({ id: 7, user_id: 99, tenant_id: 42, start_date: '2026-04-20T00:00:00.000Z' });

    const foreign = await previewTrainingSessionReflow(42, 100, 'google', 42);

    vi.clearAllMocks();
    mocks.getSessionById.mockReturnValue(null);

    const missing = await previewTrainingSessionReflow(42, 100, 'google', 42);

    expect(foreign).toEqual(missing);
    expect(foreign).toEqual({
      status: 'not_found',
      data: {
        message: 'Training session not found.',
        sessionId: 100,
      },
    });
  });

  it('returns the same not-found confirm result for foreign and missing sessions', async () => {
    mocks.getSessionById.mockReturnValue({ id: 101, week_id: 71, plan_id: 8 });
    mocks.getPlanById.mockReturnValue({ id: 8, user_id: 99, tenant_id: 42, start_date: '2026-04-20T00:00:00.000Z' });

    const foreign = await confirmTrainingSessionReflow({
      userId: 42,
      tenantId: 42,
      sessionId: 101,
      requestedCalendarSource: 'google',
    });

    vi.clearAllMocks();
    mocks.getSessionById.mockReturnValue(null);

    const missing = await confirmTrainingSessionReflow({
      userId: 42,
      tenantId: 42,
      sessionId: 101,
      requestedCalendarSource: 'google',
    });

    expect(foreign).toEqual(missing);
    expect(foreign).toEqual({
      status: 'not_found',
      data: {
        message: 'Training session not found.',
        sessionId: 101,
      },
    });
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it('returns not-found for same-user reflow preview and confirm in another tenant', async () => {
    mocks.getSessionById.mockReturnValue({ id: 101, week_id: 71, plan_id: 8 });
    mocks.getPlanById.mockReturnValue({ id: 8, user_id: 42, tenant_id: 99, start_date: '2026-04-20T00:00:00.000Z' });

    const preview = await previewTrainingSessionReflow(42, 101, 'google', 42);
    const confirm = await confirmTrainingSessionReflow({
      userId: 42,
      tenantId: 42,
      sessionId: 101,
      requestedCalendarSource: 'google',
    });

    expect(preview).toEqual({
      status: 'not_found',
      data: {
        message: 'Training session not found.',
        sessionId: 101,
      },
    });
    expect(confirm).toEqual(preview);
    expect(mocks.previewSecretarySchedulingIntent).not.toHaveBeenCalled();
    expect(mocks.submitSecretarySchedulingIntent).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it('does not preview a reflow destination in the past for today sessions', async () => {
    vi.useFakeTimers({ now: new Date('2026-04-20T20:55:00.000Z') });
    try {
      mocks.isConnected.mockImplementation((_userId: number, provider: string) => provider === 'google');
      mocks.getPlanById.mockReturnValue({
        id: 77,
        user_id: 42,
        tenant_id: 4200,
        start_date: '2026-04-20T00:00:00.000Z',
        preferences_json: JSON.stringify({
          preferredTime: '07:00',
          preferredCardioTime: '07:00',
          preferredStrengthTime: '18:00',
        }),
      });
      mocks.getWeeksForPlan.mockReturnValue([{ id: 770, week_number: 1 }]);
      mocks.getSessionById.mockReturnValue({
        id: 7701,
        week_id: 770,
        plan_id: 77,
        day_of_week: 'Monday',
        session_type: 'run',
        title: 'Recovery Run',
        duration_minutes: 15,
        description: '',
        status: 'unscheduled',
        calendar_event_id: null,
        calendar_source: null,
        session_identity_key: null,
        session_shape_hash: null,
        intensity_text: null,
        exercises_json: null,
        description_json: null,
      });
      mocks.getEvents.mockResolvedValue([]);

      const result = await previewTrainingSessionReflow(42, 7701, 'google', 4200);

      expect(result.status).toBe('preview');
      if (result.status === 'preview') {
        expect(Date.parse(result.data.proposed.start)).toBeGreaterThanOrEqual(Date.parse('2026-04-20T20:55:00.000Z'));
        expect(result.data.proposed.start).not.toBe('2026-04-20T06:00:00.000Z');
      }
      expect(mocks.previewSecretarySchedulingIntent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ now: '2026-04-20T20:55:00.000Z' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not update local session state when reflow provider write fails', async () => {
    vi.useFakeTimers({ now: new Date('2026-04-20T05:00:00.000Z') });
    try {
    mocks.isConnected.mockImplementation((_userId: number, provider: string) => provider === 'google');
    mocks.getPlanById.mockReturnValue({
      id: 7,
      user_id: 42,
      tenant_id: 700,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({
        preferredTime: '12:00',
        preferredCardioTime: '07:00',
        preferredStrengthTime: '18:00',
      }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 70, week_number: 1 }]);
    mocks.getSessionById.mockReturnValue({
      id: 100,
      week_id: 70,
      plan_id: 7,
      day_of_week: 'Monday',
      session_type: 'gym',
      title: 'Strength + Core',
      duration_minutes: 40,
      description: 'Lifting day.',
      status: 'scheduled',
      calendar_event_id: 'evt-existing',
      calendar_source: 'google',
      session_identity_key: null,
      session_shape_hash: null,
      intensity_text: null,
      exercises_json: null,
      description_json: null,
    });
    mocks.updateEvent.mockRejectedValueOnce(new Error('google unavailable'));

    const result = await confirmTrainingSessionReflow({
      userId: 42,
      tenantId: 700,
      sessionId: 100,
      requestedCalendarSource: 'google',
      proposedStartAt: '2026-04-20T18:30:00.000Z',
      proposedEndAt: '2026-04-20T19:10:00.000Z',
    });

    expect(result.status).toBe('partial_failure');
    if (result.status === 'partial_failure') {
      expect(result.data.verified).toBe(false);
      expect(result.data.retryable).toBe(true);
      // Stronger guarantee: an unknown provider outcome cannot claim that the
      // remote event stayed at its prior time.
      expect(result.data.message).toContain('No local success was recorded');
    }
    expect(mocks.updateEvent).toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.recordCalendarOwnership).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not update the provider directly while a reflow preemption winner is still proposed', async () => {
    vi.useFakeTimers({ now: new Date('2026-04-20T05:00:00.000Z') });
    try {
      mocks.isConnected.mockImplementation((_userId: number, provider: string) => provider === 'google');
      mocks.getPlanById.mockReturnValue({
        id: 7,
        user_id: 42,
        tenant_id: 700,
        start_date: '2026-04-20T00:00:00.000Z',
        preferences_json: JSON.stringify({
          preferredTime: '12:00',
          preferredCardioTime: '07:00',
          preferredStrengthTime: '18:00',
        }),
      });
      mocks.getWeeksForPlan.mockReturnValue([{ id: 70, week_number: 1 }]);
      mocks.getSessionById.mockReturnValue({
        id: 100,
        week_id: 70,
        plan_id: 7,
        day_of_week: 'Monday',
        session_type: 'gym',
        title: 'Protected Strength',
        duration_minutes: 40,
        description: 'Do not bypass the exact loser cleanup fence.',
        status: 'scheduled',
        calendar_event_id: 'evt-existing',
        calendar_source: 'google',
        session_identity_key: 'training:100',
        session_shape_hash: 'shape:100',
        intensity_text: null,
        exercises_json: null,
        description_json: null,
      });
      mocks.getEvents.mockResolvedValueOnce([{
        id: 'evt-existing',
        source: 'google',
        title: 'Protected Strength',
        start: '2026-04-20T18:00:00.000Z',
        end: '2026-04-20T18:40:00.000Z',
      }]);
      mocks.submitSecretarySchedulingIntent.mockImplementation((intent: any) => ({
        status: 'scheduled',
        reasonCodes: ['priority_preemption_applied'],
        selectedSlot: intent.preferredWindows[0],
        agendaItem: {
          agendaItemId: 'sec-preemptive-reflow',
          sourceIntentId: intent.intentId,
          lifecycleState: 'proposed',
          providerSyncState: 'not_synced',
        },
        explanation: 'exact loser cleanup is pending',
        alternativeSlots: [],
        conflicts: [],
        downstreamImplications: [],
        confidence: 'high',
        feedback: null,
      }));

      await confirmTrainingSessionReflow({
        userId: 42,
        tenantId: 700,
        sessionId: 100,
        requestedCalendarSource: 'google',
        proposedStartAt: '2026-04-20T18:30:00.000Z',
        proposedEndAt: '2026-04-20T19:10:00.000Z',
      });

      // Stronger guarantee: reflow must enter the same durable Secretary
      // claim/dependency engine as creation before any provider mutation.
      expect(mocks.submitSecretarySchedulingIntent).toHaveBeenCalledTimes(1);
      expect(mocks.createEvent).not.toHaveBeenCalled();
      expect(mocks.updateEvent).not.toHaveBeenCalled();
      expect(mocks.deleteEvent).not.toHaveBeenCalled();
      expect(mocks.updateSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns no_active_plan when the user has no plan', async () => {
    mocks.getActivePlan.mockReturnValue(null);

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('no_active_plan');
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it('returns no_calendar and performs no writes when a linked provider was disconnected', async () => {
    mocks.isConnected.mockReturnValue(false);
    mocks.getActivePlan.mockReturnValue({
      id: 47,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ trainingCalendarSource: 'google' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 470, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      {
        id: 471,
        day_of_week: 'Monday',
        session_type: 'run',
        title: 'Easy Run',
        duration_minutes: 40,
        description: 'Easy aerobic work.',
        status: 'pending',
        calendar_event_id: 'evt-revoked-google',
        calendar_source: 'google',
      },
    ]);

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('no_calendar');
    if (result.status === 'no_calendar') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsAttempted).toBe(1);
      expect(result.data.sessionsAlreadySynced).toBe(0);
      expect(result.data.message).toContain('Reconnect');
    }
    expect(mocks.getEvents).not.toHaveBeenCalled();
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.updateEvent).not.toHaveBeenCalled();
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalled();
    expect(mocks.recordCalendarOwnership).not.toHaveBeenCalled();
  });

  it('creates calendar events for unsynced future sessions and links each one', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 7,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({
        preferredTime: '12:00',
        preferredCardioTime: '07:00',
        preferredStrengthTime: '18:00',
      }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 70, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      // Monday today — should sync. Strength → 18:00.
      { id: 100, day_of_week: 'Monday', session_type: 'gym', title: 'Strength + Core', duration_minutes: 40, description: 'Lifting day.', status: 'pending', calendar_event_id: null },
      // Wednesday +2 — should sync. Run → 07:00.
      { id: 101, day_of_week: 'Wednesday', session_type: 'run', title: 'Tempo Run', duration_minutes: 35, description: 'Threshold.', status: 'pending', calendar_event_id: null },
      // Sunday → rest, skipped entirely.
      { id: 102, day_of_week: 'Sunday', session_type: 'rest', title: 'Rest', duration_minutes: 0, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.createEvent
      .mockResolvedValueOnce({ id: 'evt-mon', source: 'google' })
      .mockResolvedValueOnce({ id: 'evt-wed', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(2);
      expect(result.data.sessionsAttempted).toBe(2);
      expect(result.data.sessionsAlreadySynced).toBe(0);
      expect(result.data.sessionsFailed).toBe(0);
      // Healthy sync must not carry a degraded signal.
      expect(result.data.degraded).toBe(false);
      expect(result.data.warnings).toBeUndefined();
      expect(result.data.message).toBe('2 sessions added to your calendar.');
      expect(result.data.sessionResults).toEqual([
        expect.objectContaining({
          sessionId: 100,
          provider: 'google',
          eventId: 'evt-mon',
          status: 'created',
          reason: 'provider_event_created',
          retryable: false,
        }),
        expect.objectContaining({
          sessionId: 101,
          provider: 'google',
          eventId: 'evt-wed',
          status: 'created',
          reason: 'provider_event_created',
          retryable: false,
        }),
      ]);
    }
    expect(mocks.createEvent).toHaveBeenCalledTimes(2);
    expect(mocks.createEvent).toHaveBeenCalledWith(
      expect.any(Object),
      'google',
      42,
      expect.objectContaining({ tenantId: 42 }),
    );
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(100, 'evt-mon', 'google');
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(101, 'evt-wed', 'google');
    expect(mocks.syncTrainingSecretaryCalendarHandoff).toHaveBeenCalledTimes(2);
    // Stronger guarantee: Secretary alone mutates its durable provider map.
    expect(mocks.markSecretaryAgendaProviderSyncSatisfied).not.toHaveBeenCalled();
    expect(mocks.recordCalendarOwnership).toHaveBeenCalledWith(expect.objectContaining({
      planId: 7,
      planVersion: 3,
      sessionId: 100,
      userId: 42,
      eventId: 'evt-mon',
      source: 'google',
    }));
    expect(mocks.recordCalendarOwnership).toHaveBeenCalledWith(expect.objectContaining({
      planId: 7,
      planVersion: 3,
      sessionId: 101,
      userId: 42,
      eventId: 'evt-wed',
      source: 'google',
    }));
    // Strength title prefix uses the dumbbell emoji + duration suffix.
    const monPayload = mocks.createEvent.mock.calls[0][0];
    expect(monPayload.title).toBe('💪 Strength + Core (40min)');
    // Run title uses the runner emoji.
    const wedPayload = mocks.createEvent.mock.calls[1][0];
    expect(wedPayload.title).toBe('🏃 Tempo Run (35min)');
  });

  it('makes zero provider mutations when synchronous sync persists a proposed preemption winner', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 7,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredCardioTime: '07:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 70, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([{
      id: 100,
      day_of_week: 'Monday',
      session_type: 'run',
      title: 'Protected Run',
      duration_minutes: 40,
      description: 'Do not bypass the loser-delete fence.',
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    }]);
    mocks.submitSecretarySchedulingIntent.mockImplementation((intent: any) => ({
      status: 'scheduled',
      reasonCodes: ['priority_preemption_applied'],
      selectedSlot: intent.preferredWindows[0],
      agendaItem: {
        agendaItemId: 'sec-preemptive-route',
        sourceIntentId: intent.intentId,
        lifecycleState: 'proposed',
        providerSyncState: 'not_synced',
      },
      explanation: 'exact loser cleanup pending',
      alternativeSlots: [],
      conflicts: [],
      downstreamImplications: [],
      confidence: 'high',
      feedback: null,
    }));

    await syncTrainingPlanCalendar(42, now, 'google', 42);

    // A persisted Secretary decision is not provider authority. The exact
    // claim/dependency engine is the only writer allowed to cross this fence.
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.updateEvent).not.toHaveBeenCalled();
    expect(mocks.deleteEvent).not.toHaveBeenCalled();
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalled();
  });

  it('uses the persisted plan timezone for Secretary and provider calendar slots', async () => {
    const schedulingTimezone = 'America/Los_Angeles';
    const syncNow = new Date('2026-03-09T12:00:00.000Z');
    // Simulate travel after creation: the current account zone has changed,
    // but this existing plan must retain its persisted creation-zone schedule.
    mocks.getUserTimezoneById.mockReturnValueOnce('Asia/Tokyo');
    mocks.getActivePlan.mockReturnValue({
      id: 8,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-03-09',
      preferences_json: JSON.stringify({
        preferredTime: '12:00',
        preferredCardioTime: '07:00',
        preferredStrengthTime: '18:00',
        schedulingTimezone,
      }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 80, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([{
      id: 801,
      day_of_week: 'Monday',
      session_type: 'run',
      title: 'DST Recovery Run',
      duration_minutes: 45,
      description: 'Easy aerobic work.',
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    }]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-la-run', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, syncNow, undefined, 42);

    // Stronger guarantee: the immutable creation-zone wall time is threaded
    // through Secretary and the provider even if the user later travels.
    expect(result.status).toBe('synced');
    expect(mocks.getUserTimezoneById).toHaveBeenCalledWith(42);
    expect(mocks.submitSecretarySchedulingIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredWindows: [expect.objectContaining({
          start: '2026-03-09T14:00:00.000Z',
          end: '2026-03-09T14:45:00.000Z',
        })],
      }),
      expect.objectContaining({ now: syncNow.toISOString() }),
    );
    expect(mocks.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        start: '2026-03-09T14:00:00.000Z',
        end: '2026-03-09T14:45:00.000Z',
      }),
      'google',
      42,
      expect.objectContaining({ tenantId: 42 }),
    );
  });

  it('rolls back session linkage and leaves Secretary cleanup retryable when ownership recording fails', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 17,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredTime: '12:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 170, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 1701, day_of_week: 'Monday', session_type: 'run', title: 'Recovery Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-created-unowned', source: 'google' });
    mocks.commitTrainingCalendarSessionMapping.mockImplementationOnce(() => {
      throw new Error('TRAINING_CALENDAR_OWNERSHIP_RECORD_FAILED');
    });
    mocks.deleteEvent.mockRejectedValueOnce(new Error('delete failed'));

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('partial_failure');
    if (result.status === 'partial_failure') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsFailed).toBe(1);
      expect(result.data.sessionResults).toEqual([
        expect.objectContaining({
          sessionId: 1701,
          provider: 'google',
          eventId: 'evt-created-unowned',
          status: 'failed',
          reason: 'training_calendar_ownership_record_failed',
          retryable: true,
        }),
      ]);
    }
    // Stronger guarantee: the local mapping helper is atomic, so the route
    // never observes or compensates a partially written session link.
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalledWith(1701, expect.objectContaining({ status: 'unscheduled' }));
    expect(mocks.deleteEvent).toHaveBeenCalledWith('evt-created-unowned', 'google', 42);
    expect(mocks.markSecretaryAgendaProviderCleanupRequired).toHaveBeenCalledWith({
      agendaItemId: 'sec-1701',
      ownerUserId: 42,
      tenantId: 42,
      providerEventId: 'evt-created-unowned',
      providerSource: 'google',
      providerSyncState: 'delete_failed',
      lifecycleState: 'unscheduled',
      reason: 'training_provider_ownership_record_failed',
      clearProviderMapping: false,
      now: now.toISOString(),
    });
    expect(mocks.markSecretaryAgendaProviderSyncSatisfied).not.toHaveBeenCalled();
  });

  it('clears the agenda provider mapping when the rollback delete succeeds after ownership recording fails', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 17,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredTime: '12:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 170, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 1702, day_of_week: 'Monday', session_type: 'run', title: 'Recovery Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-rolled-back', source: 'google' });
    mocks.commitTrainingCalendarSessionMapping.mockImplementationOnce(() => {
      throw new Error('TRAINING_CALENDAR_OWNERSHIP_RECORD_FAILED');
    });
    mocks.deleteEvent.mockResolvedValueOnce(undefined);

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('partial_failure');
    if (result.status === 'partial_failure') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsFailed).toBe(1);
      expect(result.data.sessionResults?.[0]).toMatchObject({
        sessionId: 1702,
        status: 'failed',
        reason: 'training_calendar_ownership_record_failed',
        retryable: true,
        eventId: null,
      });
    }
    expect(mocks.deleteEvent).toHaveBeenCalledWith('evt-rolled-back', 'google', 42);
    expect(mocks.markSecretaryAgendaProviderCleanupRequired).toHaveBeenCalledWith({
      agendaItemId: 'sec-1702',
      ownerUserId: 42,
      tenantId: 42,
      providerEventId: 'evt-rolled-back',
      providerSource: 'google',
      providerSyncState: 'delete_failed',
      lifecycleState: 'unscheduled',
      reason: 'training_provider_ownership_record_failed',
      clearProviderMapping: false,
      now: now.toISOString(),
    });
    expect(mocks.syncTrainingSecretaryCalendarHandoff).toHaveBeenCalledWith(expect.objectContaining({
      agendaItemId: 'sec-1702',
      providerSource: 'google',
    }));
    expect(mocks.markSecretaryAgendaProviderSyncSatisfied).not.toHaveBeenCalled();
  });

  it('fails the session without creating an event when the Secretary decision has no agenda item', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 17,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredTime: '12:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 170, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 1703, day_of_week: 'Monday', session_type: 'run', title: 'Recovery Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.submitSecretarySchedulingIntent.mockImplementationOnce((intent: any) => ({
      status: 'scheduled',
      reasonCodes: ['scheduled_in_available_window'],
      selectedSlot: intent.preferredWindows[0],
      agendaItem: undefined,
      explanation: 'scheduled by Secretary',
      alternativeSlots: [],
      conflicts: [],
      downstreamImplications: [],
      confidence: 'high',
    }));

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('partial_failure');
    if (result.status === 'partial_failure') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsFailed).toBe(1);
      expect(result.data.sessionResults?.[0]).toMatchObject({
        sessionId: 1703,
        status: 'failed',
        reason: 'secretary_agenda_item_missing',
        retryable: true,
      });
    }
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.markSecretaryAgendaProviderSyncSatisfied).not.toHaveBeenCalled();
    expect(mocks.markSecretaryAgendaProviderCleanupRequired).not.toHaveBeenCalled();
  });

  it('marks provider-read failures as degraded instead of returning plain success copy', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 27,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ trainingCalendarSource: 'google' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 270, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 2701, day_of_week: 'Monday', session_type: 'run', title: 'Linked Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: 'evt-existing', calendar_source: 'google' },
    ]);
    mocks.getEvents.mockRejectedValue(new Error('provider read failed'));

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsAlreadySynced).toBe(1);
      expect(result.data.degraded).toBe(true);
      expect(result.data.warnings).toContain('calendar_provider_read_unavailable');
      expect(result.data.sessionResults?.[0]).toMatchObject({
        sessionId: 2701,
        status: 'already_synced',
        reason: 'provider_read_unavailable_existing_link_preserved',
        retryable: true,
      });
    }
    expect(mocks.markSecretaryAgendaProviderSyncSatisfied).not.toHaveBeenCalled();
  });

  it('carries the degraded flag on the main return path when the provider read fails but creation proceeds', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 27,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ trainingCalendarSource: 'google', preferredTime: '12:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 270, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 2702, day_of_week: 'Wednesday', session_type: 'run', title: 'Tempo Run', duration_minutes: 35, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.getEvents.mockRejectedValue(new Error('provider read failed'));
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-degraded-create', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.degraded).toBe(true);
      expect(result.data.warnings).toContain('calendar_provider_read_unavailable');
    }
  });

  it('does not perform a marker-only cross-provider cleanup read', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 27,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ trainingCalendarSource: 'google', preferredTime: '12:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 270, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 2703, day_of_week: 'Wednesday', session_type: 'run', title: 'Tempo Run', duration_minutes: 35, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.getEvents.mockImplementation((_start: string, _end: string, _userId: number, sources: string[]) =>
      sources?.[0] === 'google' ? Promise.resolve([]) : Promise.reject(new Error('outlook read down')));
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-cleanup-degraded', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.degraded).toBe(false);
      expect(result.data.warnings).toBeUndefined();
    }
    // Stronger guarantee: one bounded selected-provider read is the only
    // discovery pass; marker text alone never authorizes cross-provider delete.
    expect(mocks.getEvents).toHaveBeenCalledTimes(1);
    expect(mocks.getEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 42, ['google']);
  });

  it('does not create a calendar event when Secretary returns a stale past slot during sync', async () => {
    const lateNow = new Date('2026-04-20T20:55:00.000Z');
    mocks.getActivePlan.mockReturnValue({
      id: 7,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({
        preferredTime: '07:00',
        preferredCardioTime: '07:00',
        preferredStrengthTime: '18:00',
      }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 70, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      {
        id: 100,
        day_of_week: 'Wednesday',
        session_type: 'run',
        title: 'Recovery Run',
        duration_minutes: 15,
        description: 'Easy.',
        status: 'pending',
        calendar_event_id: null,
      },
    ]);
    mocks.submitSecretarySchedulingIntent.mockImplementation((intent: any) => ({
      status: 'scheduled',
      reasonCodes: ['scheduled_in_available_window'],
      selectedSlot: {
        start: '2026-04-20T06:00:00.000Z',
        end: '2026-04-20T06:15:00.000Z',
      },
      agendaItem: {
        agendaItemId: `sec-${intent.sourceEntityId}`,
        sourceIntentId: intent.intentId,
        lifecycleState: 'scheduled',
      },
      explanation: 'scheduled by Secretary',
      alternativeSlots: [],
      conflicts: [],
      downstreamImplications: [],
      confidence: 'high',
      feedback: {
        sourceSkill: 'training',
        sourceIntentId: intent.intentId,
        agendaItemId: `sec-${intent.sourceEntityId}`,
        status: 'scheduled',
        reasonCodes: ['scheduled_in_available_window'],
        scheduledStart: '2026-04-20T06:00:00.000Z',
        scheduledEnd: '2026-04-20T06:15:00.000Z',
        shouldRefreshSource: false,
        downstreamImplications: [],
      },
    }));

    const result = await syncTrainingPlanCalendar(42, lateNow, undefined, 42);

    expect(result.status).toBe('partial_failure');
    if (result.status === 'partial_failure') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsFailed).toBe(1);
      expect(result.data.sessionResults).toEqual([
        expect.objectContaining({
          sessionId: 100,
          status: 'failed',
          reason: 'secretary_no_confirmed_slot',
          retryable: true,
          eventId: null,
        }),
      ]);
    }
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalled();
    expect(mocks.updateSession).toHaveBeenCalledWith(100, {
      status: 'unscheduled',
      calendar_event_id: null,
      calendar_source: null,
    });
  });

  it('uses Outlook by default when both Google and Outlook are connected', async () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED = 'true';
    mocks.isConnected.mockImplementation((_userId: number, provider: string) => (
      provider === 'google' || provider === 'outlook'
    ));
    mocks.getActivePlan.mockReturnValue({
      id: 7,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 70, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 100, day_of_week: 'Monday', session_type: 'run', title: 'Easy Run', duration_minutes: 40, description: 'Easy.', status: 'pending', calendar_event_id: null, calendar_source: null },
    ]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-outlook', source: 'outlook' });

    await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(mocks.loadLiveCalendarBusyWindows).toHaveBeenCalledWith(expect.objectContaining({
      sourceSkill: 'training',
      softPreferences: { calendarProvider: 'outlook' },
      minimumDurationMinutes: 30,
    }));
    expect(mocks.submitSecretarySchedulingIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSkill: 'training',
        softPreferences: { calendarProvider: 'outlook' },
        minimumDurationMinutes: 30,
      }),
      expect.any(Object),
    );
    expect(mocks.createEvent).toHaveBeenCalledWith(
      expect.any(Object),
      'outlook',
      42,
      expect.objectContaining({ tenantId: 42 }),
    );
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(100, 'evt-outlook', 'outlook');
  });

  it('does not delete an unowned marker-matched event on the non-selected provider', async () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED = 'true';
    mocks.isConnected.mockImplementation((_userId: number, provider: string) => (
      provider === 'google' || provider === 'outlook'
    ));
    const session = {
      id: 100,
      day_of_week: 'Monday',
      session_type: 'run',
      title: 'Easy Run',
      duration_minutes: 40,
      description: 'Easy.',
      status: 'scheduled',
      calendar_event_id: 'evt-outlook-canonical',
      calendar_source: 'outlook',
    };
    mocks.getActivePlan.mockReturnValue({
      id: 7,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ trainingCalendarSource: 'outlook' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 70, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([session]);
    mocks.getEvents.mockImplementation(async (_start: string, _end: string, _userId: number, sources: string[]) => {
      if (sources.includes('outlook')) {
        return [{
          id: 'evt-outlook-canonical',
          source: 'outlook',
          summary: '🏃 Easy Run (40min)',
          start: '2026-04-20T07:00:00.000Z',
          end: '2026-04-20T07:40:00.000Z',
          description: markerDescription(7, 3, 100, session),
        }];
      }
      return [{
        id: 'evt-google-duplicate',
        source: 'google',
        summary: '🏃 Easy Run (40min)',
        start: '2026-04-20T07:00:00.000Z',
        end: '2026-04-20T07:40:00.000Z',
        description: markerDescription(7, 3, 100, session),
      }];
    });

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsAlreadySynced).toBe(1);
    }
    expect(mocks.createEvent).not.toHaveBeenCalled();
    // Stronger guarantee: marker/title similarity is discovery evidence, not
    // deletion authority. No exact ownership means no secondary read/delete.
    expect(mocks.getEvents).toHaveBeenCalledTimes(1);
    expect(mocks.deleteEvent).not.toHaveBeenCalled();
    expect(mocks.markCalendarOwnershipDeleted).not.toHaveBeenCalled();
  });

  it('deletes stale old-provider links when syncing a session to the resolved provider', async () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED = 'true';
    mocks.isConnected.mockImplementation((_userId: number, provider: string) => (
      provider === 'google' || provider === 'outlook'
    ));
    mocks.getActivePlan.mockReturnValue({
      id: 71,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 710, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      {
        id: 7101,
        day_of_week: 'Monday',
        session_type: 'run',
        title: 'Easy Run',
        duration_minutes: 40,
        description: '',
        status: 'pending',
        calendar_event_id: 'evt-google-stale',
        calendar_source: 'google',
      },
    ]);
    mocks.getEvents.mockResolvedValue([]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-outlook-new', source: 'outlook' });
    mocks.findExistingOwnership.mockReturnValue({
      id: 71001,
      plan_id: 71,
      plan_version: 3,
      session_id: 7101,
      tenant_id: 42,
      user_id: 42,
      calendar_event_id: 'evt-google-stale',
      calendar_source: 'google',
      status: 'active',
    });

    const result = await syncTrainingPlanCalendar(42, now, 'outlook', 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsFailed).toBe(0);
    }
    expect(mocks.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: '🏃 Easy Run (40min)' }),
      'outlook',
      42,
      expect.objectContaining({ tenantId: 42 }),
    );
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(7101, 'evt-outlook-new', 'outlook');
    expect(mocks.deleteEvent).toHaveBeenCalledWith('evt-google-stale', 'google', 42);
    expect(mocks.retireTrainingCalendarSessionMapping).toHaveBeenCalledWith(expect.objectContaining({
      ownershipId: 71001,
      eventId: 'evt-google-stale',
      source: 'google',
      reason: 'training_sync_replaced_stale_event',
    }));
  });

  it('R-2026-05-25 — uses Google by default when Outlook kill switch is set (pre-fix this gated by absence of opt-in flag)', async () => {
    // 2026-05-25 fix — Outlook is now ON by default for Training.
    // Pre-fix, the absence of TRAINING_CALENDAR_OUTLOOK_ENABLED was the
    // gate; now the kill switch TRAINING_CALENDAR_OUTLOOK_DISABLED=1 is
    // the explicit way to force Google-only behavior. Same observable
    // outcome, opposite default.
    const priorDisabled = process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED;
    process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED = '1';
    try {
      mocks.isConnected.mockImplementation((_userId: number, provider: string) => (
        provider === 'google' || provider === 'outlook'
      ));
      mocks.getActivePlan.mockReturnValue({
        id: 7,
        user_id: 42,
        start_date: '2026-04-20T00:00:00.000Z',
        preferences_json: null,
      });
      mocks.getWeeksForPlan.mockReturnValue([{ id: 70, week_number: 1 }]);
      mocks.getSessionsForWeek.mockReturnValue([
        { id: 100, day_of_week: 'Monday', session_type: 'run', title: 'Easy Run', duration_minutes: 40, description: 'Easy.', status: 'pending', calendar_event_id: null, calendar_source: null },
      ]);
      mocks.createEvent.mockResolvedValueOnce({ id: 'evt-google', source: 'google' });

      await syncTrainingPlanCalendar(42, now, undefined, 42);

      expect(mocks.createEvent).toHaveBeenCalledWith(
        expect.any(Object),
        'google',
        42,
        expect.objectContaining({ tenantId: 42 }),
      );
      expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(100, 'evt-google', 'google');
    } finally {
      if (priorDisabled === undefined) delete process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED;
      else process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED = priorDisabled;
    }
  });

  it('uses the requested connected provider and stores it as the plan preference', async () => {
    mocks.isConnected.mockImplementation((_userId: number, provider: string) => (
      provider === 'google' || provider === 'outlook'
    ));
    mocks.getActivePlan.mockReturnValue({
      id: 7,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredTime: '12:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 70, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 100, day_of_week: 'Monday', session_type: 'run', title: 'Easy Run', duration_minutes: 40, description: 'Easy.', status: 'pending', calendar_event_id: null, calendar_source: null },
    ]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-google', source: 'google' });

    await syncTrainingPlanCalendar(42, now, 'google', 42);

    expect(mocks.createEvent).toHaveBeenCalledWith(
      expect.any(Object),
      'google',
      42,
      expect.objectContaining({ tenantId: 42 }),
    );
    expect(mocks.updatePlanPreferences).toHaveBeenCalledWith(
      7,
      JSON.stringify({ preferredTime: '12:00', trainingCalendarSource: 'google' }),
    );
  });

  it('does not relink a stale event from the non-selected provider when repairing sync', async () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED = 'true';
    mocks.isConnected.mockImplementation((_userId: number, provider: string) => (
      provider === 'google' || provider === 'outlook'
    ));
    const session = {
      id: 100,
      day_of_week: 'Monday',
      session_type: 'run',
      title: 'Easy Run',
      duration_minutes: 40,
      description: 'Easy.',
      status: 'pending',
      calendar_event_id: 'evt-old-google',
      calendar_source: 'google',
    };
    mocks.getActivePlan.mockReturnValue({
      id: 7,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ trainingCalendarSource: 'outlook' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 70, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([session]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'evt-old-google',
        source: 'google',
        summary: '🏃 Easy Run (40min)',
        start: '2026-04-20T12:00:00.000Z',
        end: '2026-04-20T12:40:00.000Z',
        description: markerDescription(7, 3, 100, session),
      },
    ]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-new-outlook', source: 'outlook' });
    mocks.findExistingOwnership.mockReturnValue({
      id: 7001,
      plan_id: 7,
      plan_version: 3,
      session_id: 100,
      tenant_id: 42,
      user_id: 42,
      calendar_event_id: 'evt-old-google',
      calendar_source: 'google',
      status: 'active',
    });

    await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(mocks.createEvent).toHaveBeenCalledWith(
      expect.any(Object),
      'outlook',
      42,
      expect.objectContaining({ tenantId: 42 }),
    );
    const createdPayload = mocks.createEvent.mock.calls[0][0];
    expect(createdPayload.start).toMatch(/^2026-04-20T/);
    expect(createdPayload.end).toMatch(/^2026-04-20T/);
    expect(
      new Date(createdPayload.end).getTime() - new Date(createdPayload.start).getTime(),
    ).toBe(40 * 60_000);
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(100, 'evt-new-outlook', 'outlook');
    expect(mocks.deleteEvent).toHaveBeenCalledWith('evt-old-google', 'google', 42);
    expect(mocks.retireTrainingCalendarSessionMapping).toHaveBeenCalledWith(expect.objectContaining({
      ownershipId: 7001,
      eventId: 'evt-old-google',
      source: 'google',
    }));
  });

  it('previews then submits Secretary scheduling intent before creating a legacy calendar event and uses the selected slot', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 44,
      user_id: 12,
      tenant_id: 1200,
      start_date: '2026-05-04T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredTime: '07:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 4401, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([{
      id: 321,
      day_of_week: 'Monday',
      session_type: 'run',
      title: 'Tempo Run',
      duration_minutes: 45,
      intensity_text: 'moderate',
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
      description: 'Tempo details',
      exercises_json: '[]',
      description_json: null,
    }]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-tempo', source: 'google' });
    mocks.getPlanVersion.mockReturnValue(2);
    mocks.previewSecretarySchedulingIntent.mockImplementationOnce((intent: any) => ({
      status: 'scheduled',
      reasonCodes: ['scheduled_in_available_window'],
      recommendedSlot: {
        start: '2026-05-04T13:00:00.000Z',
        end: '2026-05-04T13:45:00.000Z',
        label: 'secretary-adjusted-slot',
        hard: true,
      },
      alternatives: [],
      confidence: 'high',
      wouldReflow: false,
      wouldCompress: false,
      reasoningTrail: [],
      noPersist: true,
    }));
    mocks.submitSecretarySchedulingIntent.mockImplementationOnce((intent: any) => ({
      status: 'scheduled',
      reasonCodes: ['scheduled_in_available_window'],
      selectedSlot: {
        start: '2026-05-04T13:00:00.000Z',
        end: '2026-05-04T13:45:00.000Z',
        label: 'secretary-adjusted-slot',
        hard: true,
      },
      agendaItem: {
        agendaItemId: `sec-${intent.sourceEntityId}`,
        sourceIntentId: intent.intentId,
        lifecycleState: 'scheduled',
      },
      explanation: 'scheduled by Secretary',
      alternativeSlots: [],
      conflicts: [],
      downstreamImplications: [],
      confidence: 'high',
      feedback: {
        sourceSkill: 'training',
        sourceIntentId: intent.intentId,
        agendaItemId: `sec-${intent.sourceEntityId}`,
        status: 'scheduled',
        reasonCodes: ['scheduled_in_available_window'],
        scheduledStart: '2026-05-04T13:00:00.000Z',
        scheduledEnd: '2026-05-04T13:45:00.000Z',
        shouldRefreshSource: false,
        downstreamImplications: [],
      },
    }));

    const result = await syncTrainingPlanCalendar(12, new Date('2026-05-01T00:00:00.000Z'), undefined, 12);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsFailed).toBe(0);
    }
    expect(mocks.previewSecretarySchedulingIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: 'training:44:2:321',
        sourceSkill: 'training',
        sourceAction: 'sync_training_session_calendar',
        sourceEntityId: 321,
        sourceEntityType: 'training_session',
        ownerUserId: 12,
        tenantId: 1200,
        preferredWindows: [expect.objectContaining({ hard: true })],
      }),
      expect.objectContaining({ now: '2026-05-01T00:00:00.000Z' }),
    );
    expect(mocks.submitSecretarySchedulingIntent).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: 'training:44:2:321' }),
      expect.objectContaining({ now: '2026-05-01T00:00:00.000Z' }),
    );
    expect(mocks.previewSecretarySchedulingIntent.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.submitSecretarySchedulingIntent.mock.invocationCallOrder[0]);
    expect(mocks.submitSecretarySchedulingIntent.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createEvent.mock.invocationCallOrder[0]);
    expect(mocks.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '🏃 Tempo Run (45min)',
        start: '2026-05-04T13:00:00.000Z',
        end: '2026-05-04T13:45:00.000Z',
        description: expect.stringContaining('[NEXUS_TRAINING_IDENTITY'),
      }),
      'google',
      12,
      expect.objectContaining({ tenantId: 1200 }),
    );
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(321, 'evt-tempo', 'google');
  });

  it('leaves a legacy sync session unscheduled when Secretary rejects the slot', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 45,
      user_id: 12,
      start_date: '2026-05-04T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredTime: '07:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 4501, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([{
      id: 421,
      day_of_week: 'Monday',
      session_type: 'run',
      title: 'No Slot Run',
      duration_minutes: 45,
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
      description: '',
    }]);
    mocks.previewSecretarySchedulingIntent.mockReturnValueOnce({
      status: 'unscheduled',
      reasonCodes: ['no_valid_slot'],
      recommendedSlot: null,
      alternatives: [],
      confidence: 'medium',
      wouldReflow: false,
      wouldCompress: false,
      reasoningTrail: [],
      noPersist: true,
    });

    const result = await syncTrainingPlanCalendar(12, new Date('2026-05-01T00:00:00.000Z'), undefined, 12);

    expect(result.status).toBe('partial_failure');
    if (result.status === 'partial_failure') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsFailed).toBe(1);
    }
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.submitSecretarySchedulingIntent).not.toHaveBeenCalled();
    expect(mocks.updateSession).toHaveBeenCalledWith(421, {
      status: 'unscheduled',
      calendar_event_id: null,
      calendar_source: null,
    });
  });

  it('preserves a rate-limit failure for Secretary/queue retry without a route-level second create', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 17,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 170, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 1700, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 40, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.createEvent
      .mockRejectedValueOnce({
        response: {
          status: 403,
          data: {
            error: {
              code: 403,
              message: 'Rate Limit Exceeded',
              errors: [{ reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' }],
            },
          },
        },
      })
      .mockResolvedValueOnce({ id: 'evt-retry', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('partial_failure');
    if (result.status === 'partial_failure') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsFailed).toBe(1);
      expect(result.data.sessionResults?.[0]).toMatchObject({
        sessionId: 1700,
        reason: 'provider_event_create_failed',
        retryable: true,
        eventId: null,
      });
    }
    // Stronger guarantee: the route does not replay an uncertain create;
    // Secretary/queue recovery owns the retry disposition.
    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalled();
  });

  it('keeps sessions with a verified calendar_event_id idempotent on retry', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 8,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 80, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 200, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 45, description: '', status: 'pending', calendar_event_id: 'evt-existing', calendar_source: 'google' },
      { id: 201, day_of_week: 'Wednesday', session_type: 'run', title: 'Easy', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'evt-existing',
        source: 'google',
        summary: '💪 Lift (45min)',
        start: '2026-04-20T12:00:00.000Z',
        end: '2026-04-20T12:45:00.000Z',
      },
    ]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-new', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsAlreadySynced).toBe(1);
    }
    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(201, 'evt-new', 'google');
  });

  it('repairs stale calendar_event_id links when the provider no longer returns the event', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 19,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 190, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 209, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 45, description: '', status: 'pending', calendar_event_id: 'evt-stale', calendar_source: 'google' },
    ]);
    mocks.getEvents.mockResolvedValue([]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-repaired', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsAlreadySynced).toBe(0);
      expect(result.data.sessionsAttempted).toBe(1);
    }
    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(209, 'evt-repaired', 'google');
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 209, calendarEventId: 'evt-stale', reason: 'missing_linked_event' }),
      'syncTrainingPlanCalendar: repairing stale training calendar link',
    );
  });

  it('preserves fresh calendar_event_id links when provider read-back has not caught up yet', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 119,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 1190, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      {
        id: 1209,
        day_of_week: 'Monday',
        session_type: 'gym',
        title: 'Lift',
        duration_minutes: 45,
        description: '',
        status: 'pending',
        calendar_event_id: 'evt-fresh-google',
        calendar_source: 'google',
        updated_at: now.toISOString(),
      },
    ]);
    mocks.getEvents.mockResolvedValue([]);

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('partial_failure');
    if (result.status === 'partial_failure') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsAlreadySynced).toBe(0);
      expect(result.data.sessionsFailed).toBe(1);
      expect(result.data.degraded).toBe(true);
      expect(result.data.warnings).toContain('provider_read_missing_recent_link_unverified');
      expect(result.data.sessionResults?.[0]).toEqual(expect.objectContaining({
        sessionId: 1209,
        eventId: 'evt-fresh-google',
        reason: 'provider_read_missing_recent_link_unverified',
        retryable: true,
      }));
    }
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 1209,
        calendarEventId: 'evt-fresh-google',
        reason: 'missing_recent_link_preserved',
      }),
      'syncTrainingPlanCalendar: preserving fresh calendar link while provider read catches up',
    );
  });

  it('marks sessions when live calendar capacity shifts them away from the preferred time', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 129,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({
        preferredTime: '12:00',
        preferredCardioTime: '07:00',
        preferredStrengthTime: '12:00',
      }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 1290, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      {
        id: 1309,
        day_of_week: 'Monday',
        session_type: 'gym',
        title: 'Lift',
        duration_minutes: 45,
        description: '',
        status: 'pending',
        calendar_event_id: null,
        calendar_source: null,
        preferred_time_unavailable: 0,
      },
    ]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'busy-noon',
        source: 'google',
        summary: 'Busy',
        start: '2026-04-20T11:00:00.000Z',
        end: '2026-04-20T12:00:00.000Z',
      },
    ]);
    mocks.createEvent.mockImplementationOnce(async (payload: any) => ({
      id: 'evt-shifted',
      source: 'google',
      start: payload.start,
      end: payload.end,
    }));

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(1309, 'evt-shifted', 'google');
    expect(mocks.updateSession).toHaveBeenCalledWith(1309, { preferred_time_unavailable: 1 });
  });

  it('precisely deletes a mismatched stale linked event after creating the replacement', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 29,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 290, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 219, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 45, description: '', status: 'pending', calendar_event_id: 'evt-old-time', calendar_source: 'google' },
    ]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'evt-old-time',
        source: 'google',
        summary: '💪 Lift (45min)',
        start: '2026-04-20T08:00:00.000Z',
        end: '2026-04-20T08:20:00.000Z',
      },
    ]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-repaired-time', source: 'google' });
    mocks.findExistingOwnership.mockReturnValue({
      id: 29001,
      plan_id: 29,
      plan_version: 3,
      session_id: 219,
      tenant_id: 42,
      user_id: 42,
      calendar_event_id: 'evt-old-time',
      calendar_source: 'google',
      status: 'active',
    });

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsFailed).toBe(0);
    }
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(219, 'evt-repaired-time', 'google');
    expect(mocks.deleteEvent).toHaveBeenCalledWith('evt-old-time', 'google', 42);
    expect(mocks.retireTrainingCalendarSessionMapping).toHaveBeenCalledWith(expect.objectContaining({
      ownershipId: 29001,
      eventId: 'evt-old-time',
      source: 'google',
      reason: 'training_sync_replaced_stale_event',
      userId: 42,
      tenantId: 42,
      planId: 29,
    }));
  });

  it('links matching orphan calendar events instead of creating duplicates', async () => {
    const session = { id: 208, day_of_week: 'Monday', session_type: 'run', title: 'Recovery Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null };
    mocks.getActivePlan.mockReturnValue({
      id: 18,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({
        preferredTime: '12:00',
        preferredCardioTime: '07:00',
        preferredStrengthTime: '18:00',
      }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 180, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      session,
    ]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'orphan-recovery-run',
        source: 'google',
        summary: '🏃 Recovery Run (30min)',
        start: '2026-04-20T07:00:00.000Z',
        end: '2026-04-20T07:30:00.000Z',
        description: markerDescription(18, 3, 208, session),
      },
    ]);

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsLinked).toBe(1);
      expect(result.data.sessionsFailed).toBe(0);
      expect(result.data.message).toBe('1 existing session was linked to your calendar.');
    }
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(208, 'orphan-recovery-run', 'google');
    expect(mocks.recordCalendarOwnership).toHaveBeenCalledWith(expect.objectContaining({
      planId: 18,
      planVersion: 3,
      sessionId: 208,
      userId: 42,
      eventId: 'orphan-recovery-run',
      source: 'google',
    }));
  });

  it('does not claim same-title/date events without a Nexus identity marker', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 118,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 1180, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 1208, day_of_week: 'Monday', session_type: 'run', title: 'Recovery Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'legacy-title-only-run',
        source: 'google',
        summary: '🏃 Recovery Run (30min)',
        start: '2026-04-20T07:00:00.000Z',
        end: '2026-04-20T07:30:00.000Z',
      },
    ]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'new-identity-run', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsLinked).toBe(0);
    }
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(1208, 'new-identity-run', 'google');
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalledWith(1208, 'legacy-title-only-run', 'google');
  });

  it('re-links a session from active ownership without creating a duplicate event', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 21,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 2100, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 211, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 40, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.findExistingOwnership.mockReturnValue({
      id: 990,
      plan_id: 21,
      plan_version: 3,
      session_id: 211,
      user_id: 42,
      calendar_event_id: 'owned-lift',
      calendar_source: 'google',
      status: 'active',
      created_at: '2026-04-20T00:00:00Z',
      deleted_at: null,
      delete_reason: null,
    });
    mocks.getEvents.mockResolvedValue([
      {
        id: 'owned-lift',
        source: 'google',
        summary: '💪 Lift (40min)',
        start: '2026-04-20T12:00:00.000Z',
        end: '2026-04-20T12:40:00.000Z',
      },
    ]);

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsLinked).toBe(1);
      expect(result.data.message).toBe('1 existing session was linked to your calendar.');
    }
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(211, 'owned-lift', 'google');
  });

  it('reuses a prior-version same-shape event and updates its time instead of duplicating it', async () => {
    const session = {
      id: 221,
      day_of_week: 'Wednesday',
      session_type: 'gym',
      title: 'Lift',
      duration_minutes: 40,
      description: '',
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    };
    const identity = identityFor(22, session);
    mocks.getActivePlan.mockReturnValue({
      id: 22,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredStrengthTime: '18:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 2200, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([session]);
    mocks.findReusableOwnershipBySessionIdentity.mockReturnValue({
      id: 991,
      plan_id: 22,
      plan_version: 2,
      session_id: 121,
      user_id: 42,
      calendar_event_id: 'prior-version-lift',
      calendar_source: 'google',
      session_identity_key: identity.key,
      session_shape_hash: identity.shape,
      status: 'active',
      created_at: '2026-04-20T00:00:00Z',
      deleted_at: null,
      delete_reason: null,
    });
    mocks.getEvents.mockResolvedValue([
      {
        id: 'prior-version-lift',
        source: 'google',
        summary: '💪 Lift (40min)',
        start: '2026-04-20T12:00:00.000Z',
        end: '2026-04-20T12:40:00.000Z',
        description: markerDescription(22, 2, 121, session),
      },
    ]);

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsLinked).toBe(1);
    }
    expect(mocks.updateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: 'prior-version-lift',
        new_start: expect.stringContaining('2026-04-22T'),
        new_end: expect.stringContaining('2026-04-22T'),
        new_description: expect.stringContaining('version=3'),
      }),
      'google',
      42,
      expect.any(Object),
    );
    expect(mocks.updateEvent.mock.calls[0][0].new_description).toContain('session=221');
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(221, 'prior-version-lift', 'google');
    expect(mocks.recordCalendarOwnership).toHaveBeenCalledWith(expect.objectContaining({
      planId: 22,
      planVersion: 3,
      sessionId: 221,
      eventId: 'prior-version-lift',
      sessionIdentityKey: identity.key,
      sessionShapeHash: identity.shape,
    }));
  });

  it.each([
    { outcome: 'terminal' as const, retryable: false, reasonCode: 'provider_refused_existing_update' },
    { outcome: 'pending' as const, retryable: true, reasonCode: 'provider_existing_update_pending' },
  ])('preserves a $outcome existing-event Secretary handoff disposition', async ({ outcome, retryable, reasonCode }) => {
    const session = {
      id: 226,
      day_of_week: 'Wednesday',
      session_type: 'gym',
      title: 'Lift',
      duration_minutes: 40,
      description: '',
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    };
    const identity = identityFor(26, session);
    mocks.getActivePlan.mockReturnValue({
      id: 26,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredStrengthTime: '18:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 2600, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([session]);
    mocks.findReusableOwnershipBySessionIdentity.mockReturnValue({
      id: 996,
      plan_id: 26,
      plan_version: 3,
      session_id: 226,
      tenant_id: 42,
      user_id: 42,
      calendar_event_id: 'existing-handoff-event',
      calendar_source: 'google',
      session_identity_key: identity.key,
      session_shape_hash: identity.shape,
      status: 'active',
      created_at: '2026-04-20T00:00:00Z',
      deleted_at: null,
      delete_reason: null,
    });
    mocks.getEvents.mockResolvedValue([{
      id: 'existing-handoff-event',
      source: 'google',
      summary: '💪 Lift (40min)',
      start: '2026-04-22T17:00:00.000Z',
      end: '2026-04-22T17:40:00.000Z',
      description: markerDescription(26, 3, 226, session),
    }]);
    mocks.syncTrainingSecretaryCalendarHandoff.mockResolvedValue({
      outcome,
      agendaItemId: 'sec-existing-handoff',
      providerEventId: 'existing-handoff-event',
      providerSource: 'google',
      startAt: null,
      endAt: null,
      reasonCode,
      retryable,
      agendaItem: null,
      syncResults: [],
    });

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('partial_failure');
    if (result.status === 'partial_failure') {
      expect(result.data.sessionResults).toEqual([
        expect.objectContaining({
          sessionId: 226,
          status: 'failed',
          reason: reasonCode,
          retryable,
          eventId: 'existing-handoff-event',
        }),
      ]);
    }
    expect(mocks.syncTrainingSecretaryCalendarHandoff).toHaveBeenCalledTimes(1);
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.commitTrainingCalendarSessionMapping).not.toHaveBeenCalled();
  });

  it('adopts a prior-version no-agenda mapping before switching its reusable ownership to another provider', async () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED = 'true';
    mocks.isConnected.mockReturnValue(true);
    const session = {
      id: 231,
      day_of_week: 'Wednesday',
      session_type: 'gym',
      title: 'Lift',
      duration_minutes: 40,
      description: '',
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    };
    const identity = identityFor(23, session);
    mocks.getActivePlan.mockReturnValue({
      id: 23,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredStrengthTime: '18:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 2300, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([session]);
    mocks.findReusableOwnershipBySessionIdentity.mockReturnValue({
      id: 992,
      plan_id: 23,
      plan_version: 2,
      session_id: 131,
      tenant_id: 42,
      user_id: 42,
      calendar_event_id: 'prior-version-google',
      calendar_source: 'google',
      session_identity_key: identity.key,
      session_shape_hash: identity.shape,
      status: 'active',
      created_at: '2026-04-20T00:00:00Z',
      deleted_at: null,
      delete_reason: null,
    });
    mocks.cleanupTrainingSecretaryCalendarHandoff.mockResolvedValueOnce({
      outcome: 'pending',
      agendaItemId: '',
      providerEventId: 'prior-version-google',
      providerSource: 'google',
      startAt: null,
      endAt: null,
      reasonCode: 'secretary_stale_provider_mapping_authority_missing',
      retryable: true,
      agendaItem: null,
      syncResults: [],
    });
    mocks.createEvent.mockResolvedValue({ id: 'current-version-outlook', source: 'outlook' });

    const result = await syncTrainingPlanCalendar(42, now, 'outlook', 42);

    expect(result.status).toBe('synced');
    expect(mocks.cleanupTrainingSecretaryCalendarHandoff).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sourceIntentId: 'training:23:2:131',
        providerEventId: 'prior-version-google',
        providerSource: 'google',
      }),
    );
    expect(mocks.submitSecretarySchedulingIntent).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: 'training:23:3:231', providerTarget: 'google' }),
      expect.objectContaining({
        providerMappingTransfer: {
          providerEventId: 'prior-version-google',
          providerSource: 'google',
        },
      }),
    );
    expect(mocks.cleanupTrainingSecretaryCalendarHandoff).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sourceIntentId: 'training:23:3:231' }),
    );
    expect(mocks.deleteEvent).toHaveBeenCalledTimes(1);
    expect(mocks.deleteEvent).toHaveBeenCalledWith('prior-version-google', 'google', 42);
    expect(mocks.markCalendarOwnershipDeleted).toHaveBeenCalledWith(expect.objectContaining({
      ownershipId: 992,
      eventId: 'prior-version-google',
      source: 'google',
    }));
    expect(mocks.createEvent).toHaveBeenCalledWith(
      expect.any(Object),
      'outlook',
      42,
      expect.objectContaining({ tenantId: 42 }),
    );
    expect(mocks.recordCalendarOwnership).toHaveBeenCalledWith(expect.objectContaining({
      planId: 23,
      planVersion: 3,
      sessionId: 231,
      eventId: 'current-version-outlook',
      source: 'outlook',
    }));
  });

  it('retries a current-link provider switch after target create failure without cleaning the old provider twice', async () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED = 'true';
    mocks.isConnected.mockReturnValue(true);
    const session: any = {
      id: 241,
      day_of_week: 'Wednesday',
      session_type: 'gym',
      title: 'Lift',
      duration_minutes: 40,
      description: '',
      status: 'scheduled',
      calendar_event_id: 'current-google-old',
      calendar_source: 'google',
    };
    const identity = identityFor(24, session);
    mocks.getActivePlan.mockReturnValue({
      id: 24,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredStrengthTime: '18:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 2400, week_number: 1 }]);
    mocks.getSessionsForWeek.mockImplementation(() => [session]);
    const exactOwnership = {
      id: 993,
      plan_id: 24,
      plan_version: 3,
      session_id: 241,
      tenant_id: 42,
      user_id: 42,
      calendar_event_id: 'current-google-old',
      calendar_source: 'google',
      session_identity_key: identity.key,
      session_shape_hash: identity.shape,
      status: 'active',
      created_at: '2026-04-20T00:00:00Z',
      deleted_at: null,
      delete_reason: null,
    };
    mocks.findExistingOwnership
      .mockReturnValueOnce(exactOwnership)
      .mockReturnValue(null);
    mocks.updateSession.mockImplementation((_sessionId: number, patch: Record<string, unknown>) => {
      Object.assign(session, patch);
      return true;
    });
    mocks.linkSessionToCalendar.mockImplementation((_sessionId: number, eventId: string, source: string) => {
      session.calendar_event_id = eventId;
      session.calendar_source = source;
      return true;
    });
    mocks.createEvent
      .mockRejectedValueOnce(new Error('outlook create temporarily unavailable'))
      .mockResolvedValue({ id: 'current-outlook-new', source: 'outlook' });

    const first = await syncTrainingPlanCalendar(42, now, 'outlook', 42);
    expect(first.status).toBe('partial_failure');
    expect(session).toMatchObject({ calendar_event_id: null, calendar_source: null });
    expect(mocks.cleanupTrainingSecretaryCalendarHandoff).toHaveBeenCalledTimes(1);
    expect(mocks.deleteEvent).toHaveBeenCalledTimes(1);
    expect(mocks.retireTrainingCalendarSessionMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        ownershipId: 993,
        eventId: 'current-google-old',
        source: 'google',
        allowAlreadyUnlinked: false,
      }),
    );

    const second = await syncTrainingPlanCalendar(42, now, 'outlook', 42);
    expect(second.status).toBe('synced');
    expect(mocks.cleanupTrainingSecretaryCalendarHandoff).toHaveBeenCalledTimes(1);
    expect(mocks.deleteEvent).toHaveBeenCalledTimes(1);
    expect(mocks.createEvent).toHaveBeenCalledTimes(2);
    expect(session).toMatchObject({
      calendar_event_id: 'current-outlook-new',
      calendar_source: 'outlook',
    });
    expect(JSON.stringify(second)).not.toContain('authority_missing');
  });

  it('refuses provider cleanup before exact local ownership authority is resolved', async () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED = 'true';
    mocks.isConnected.mockReturnValue(true);
    mocks.getActivePlan.mockReturnValue({
      id: 25,
      user_id: 42,
      tenant_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 2500, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([{
      id: 251,
      day_of_week: 'Wednesday',
      session_type: 'run',
      title: 'Tempo Run',
      duration_minutes: 45,
      description: '',
      status: 'scheduled',
      calendar_event_id: 'unowned-google-event',
      calendar_source: 'google',
    }]);
    mocks.findExistingOwnership.mockReturnValue(null);

    const result = await syncTrainingPlanCalendar(42, now, 'outlook', 42);

    expect(result.status).toBe('partial_failure');
    if (result.status === 'partial_failure') {
      expect(result.data.sessionResults).toEqual([
        expect.objectContaining({
          sessionId: 251,
          status: 'failed',
          reason: 'training_calendar_ownership_delete_fence_failed',
          retryable: true,
          eventId: 'unowned-google-event',
        }),
      ]);
    }
    // Stronger guarantee: provider deletion is forbidden until the exact
    // active local ownership row has been resolved and fenced.
    expect(mocks.cleanupTrainingSecretaryCalendarHandoff).not.toHaveBeenCalled();
    expect(mocks.deleteEvent).not.toHaveBeenCalled();
    expect(mocks.retireTrainingCalendarSessionMapping).not.toHaveBeenCalled();
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it('does not create events for future unscheduled sessions during ordinary sync', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 33,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 330, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 3301, day_of_week: 'Monday', session_type: 'gym', title: 'Unscheduled Lift', duration_minutes: 40, description: '', status: 'unscheduled', calendar_event_id: null },
    ]);

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.sessionsAttempted).toBe(0);
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsFailed).toBe(0);
      expect(result.data.message).toBe('No future sessions left to sync.');
    }
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalledWith(3301, expect.anything(), expect.anything());
    expect(mocks.updateSession).not.toHaveBeenCalledWith(3301, { status: 'scheduled' });
  });

  it('does not create events for inactive deferred schedule-state sessions', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 33,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 330, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 3302, day_of_week: 'Wednesday', session_type: 'run', title: 'Deferred Run', duration_minutes: 35, description: '', status: 'deferred', calendar_event_id: null },
    ]);

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.sessionsAttempted).toBe(0);
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.message).toBe('No future sessions left to sync.');
    }
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it('marks a future session unscheduled instead of creating a fallback event when the day is fully booked', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 34,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ preferredStrengthTime: '12:00' }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 340, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 3401, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 40, description: '', status: 'pending', calendar_event_id: null },
    ]);
    const blockStart = new Date('2026-04-20T00:00:00.000Z');
    const blockEnd = new Date('2026-04-21T00:00:00.000Z');
    mocks.getEvents.mockResolvedValue([
      {
        id: 'busy-all-day',
        source: 'google',
        summary: 'Busy day',
        start: blockStart.toISOString(),
        end: blockEnd.toISOString(),
      },
    ]);

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('partial_failure');
    if (result.status === 'partial_failure') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsFailed).toBe(1);
      expect(result.data.sessionResults?.[0]).toMatchObject({
        sessionId: 3401,
        reason: 'no_available_slot',
        retryable: true,
      });
    }
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.updateSession).toHaveBeenCalledWith(3401, expect.objectContaining({
      status: 'unscheduled',
      calendar_event_id: null,
      calendar_source: null,
    }));
  });

  it('replaces a linked event when the session identity matches but shape changed', async () => {
    const oldSession = { day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 40 };
    mocks.getActivePlan.mockReturnValue({
      id: 23,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 2300, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      {
        id: 231,
        day_of_week: 'Monday',
        session_type: 'gym',
        title: 'Lift',
        duration_minutes: 55,
        description: '',
        status: 'pending',
        calendar_event_id: 'old-shape-lift',
        calendar_source: 'google',
      },
    ]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'old-shape-lift',
        source: 'google',
        summary: '💪 Lift (40min)',
        start: '2026-04-20T12:00:00.000Z',
        end: '2026-04-20T12:40:00.000Z',
        description: markerDescription(23, 2, 131, oldSession),
      },
    ]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'new-shape-lift', source: 'google' });
    mocks.findExistingOwnership.mockReturnValue({
      id: 23001,
      plan_id: 23,
      plan_version: 3,
      session_id: 231,
      tenant_id: 42,
      user_id: 42,
      calendar_event_id: 'old-shape-lift',
      calendar_source: 'google',
      status: 'active',
    });

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
    }
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(231, 'new-shape-lift', 'google');
    expect(mocks.deleteEvent).toHaveBeenCalledWith('old-shape-lift', 'google', 42);
    expect(mocks.retireTrainingCalendarSessionMapping).toHaveBeenCalledWith(expect.objectContaining({
      ownershipId: 23001,
      eventId: 'old-shape-lift',
      source: 'google',
    }));
  });

  it('does not claim a matching training event already linked to another plan', async () => {
    const session = { id: 210, day_of_week: 'Monday', session_type: 'run', title: 'Recovery Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null };
    mocks.getActivePlan.mockReturnValue({
      id: 20,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 2000, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      session,
    ]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'claimed-recovery-run',
        source: 'google',
        summary: '🏃 Recovery Run (30min)',
        start: '2026-04-20T12:00:00.000Z',
        end: '2026-04-20T12:30:00.000Z',
        description: markerDescription(20, 3, 210, session),
      },
    ]);
    mocks.isTrainingCalendarEventUnclaimed.mockReturnValue(false);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-new-run', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsLinked).toBe(0);
    }
    expect(mocks.isTrainingCalendarEventUnclaimed).toHaveBeenCalledWith('claimed-recovery-run', 'google', 42);
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(210, 'evt-new-run', 'google');
  });

  it('does not touch past, completed, or skipped sessions', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 9,
      user_id: 42,
      start_date: '2026-04-13T00:00:00.000Z', // started a week ago
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([
      { id: 90, week_number: 1 },
      { id: 91, week_number: 2 },
    ]);
    mocks.getSessionsForWeek
      .mockReturnValueOnce([
        // Week 1 (last week) — past date, must be skipped.
        { id: 300, day_of_week: 'Monday', session_type: 'gym', title: 'Past Lift', duration_minutes: 45, description: '', status: 'pending', calendar_event_id: null },
      ])
      .mockReturnValueOnce([
        // Week 2 — Wednesday is future. But this one is `completed`,
        // so we don't put a calendar event on a closed-out session.
        { id: 301, day_of_week: 'Wednesday', session_type: 'run', title: 'Done Run', duration_minutes: 30, description: '', status: 'completed', calendar_event_id: null },
        // Week 2 — Friday is future + still pending → should sync.
        { id: 302, day_of_week: 'Friday', session_type: 'run', title: 'Future Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null },
        // Week 2 — Saturday `skipped`, ignore.
        { id: 303, day_of_week: 'Saturday', session_type: 'gym', title: 'Skipped Lift', duration_minutes: 45, description: '', status: 'skipped', calendar_event_id: null },
      ]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-fri', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsAttempted).toBe(1);
    }
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(302, 'evt-fri', 'google');
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalledWith(300, expect.anything(), expect.anything());
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalledWith(301, expect.anything(), expect.anything());
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalledWith(303, expect.anything(), expect.anything());
  });

  it('returns no_calendar when every createEvent throws "No calendar provider is connected"', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 10,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 100, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 400, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 40, description: '', status: 'pending', calendar_event_id: null },
      { id: 401, day_of_week: 'Wednesday', session_type: 'run', title: 'Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.createEvent.mockRejectedValue(new Error('No calendar provider is connected'));

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('no_calendar');
    if (result.status === 'no_calendar') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsAttempted).toBe(2);
      expect(result.data.message).toContain('Reconnect');
    }
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalled();
  });

  it('reports a partial-failure message when only some sessions sync', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 11,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 110, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 500, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 40, description: '', status: 'pending', calendar_event_id: null },
      { id: 501, day_of_week: 'Wednesday', session_type: 'run', title: 'Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.createEvent
      .mockResolvedValueOnce({ id: 'evt-mon', source: 'google' })
      .mockRejectedValueOnce(new Error('rate-limited'));

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('partial_failure');
    if (result.status === 'partial_failure') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsFailed).toBe(1);
      expect(result.data.message).toBe('1 session was synced; 1 session needs retry.');
    }
  });

  it('still tries to create events when getEvents (busy-window fetch) throws', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 12,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 120, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 600, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 40, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.getEvents.mockRejectedValue(new Error('calendar listing unavailable'));
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
    }
    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
  });
});
