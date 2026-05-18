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
    vi.clearAllMocks();
    delete process.env.TRAINING_ENGINE_ENABLED;
    delete process.env.TRAINING_ENGINE_DISABLED;
    delete process.env.TRAINING_CALENDAR_WRITES_ENABLED;
    delete process.env.TRAINING_CALENDAR_WRITES_DISABLED;
    delete process.env.TRAINING_CALENDAR_SYNC_ENABLED;
    delete process.env.TRAINING_CALENDAR_SYNC_DISABLED;
    mocks.getEvents.mockResolvedValue([]);
    mocks.getPlanById.mockReset();
    mocks.getSessionById.mockReset();
    mocks.updateEvent.mockResolvedValue({ id: 'evt-updated', source: 'google' });
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
    mocks.isConnected.mockImplementation((_userId: number, provider: string) => provider === 'outlook');
    mocks.getPlanById.mockReturnValue({
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
        start: '2026-04-20T17:00:00.000Z',
        end: '2026-04-20T18:00:00.000Z',
      },
    ]);

    const result = await previewTrainingSessionReflow(42, 100, 'outlook', 42);

    expect(result.status).toBe('preview');
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

  it('does not update local session state when reflow provider write fails', async () => {
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
      expect(result.data.message).toContain('left at its current time');
    }
    expect(mocks.updateEvent).toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.recordCalendarOwnership).not.toHaveBeenCalled();
  });

  it('returns no_active_plan when the user has no plan', async () => {
    mocks.getActivePlan.mockReturnValue(null);

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('no_active_plan');
    expect(mocks.createEvent).not.toHaveBeenCalled();
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

  it('uses Outlook by default when both Google and Outlook are connected', async () => {
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

    expect(mocks.createEvent).toHaveBeenCalledWith(
      expect.any(Object),
      'outlook',
      42,
      expect.objectContaining({ tenantId: 42 }),
    );
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(100, 'evt-outlook', 'outlook');
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

    await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(mocks.createEvent).toHaveBeenCalledWith(
      expect.any(Object),
      'outlook',
      42,
      expect.objectContaining({ tenantId: 42 }),
    );
    expect(mocks.createEvent.mock.calls[0][0]).toMatchObject({
      start: '2026-04-20T11:00:00.000Z',
      end: '2026-04-20T11:40:00.000Z',
    });
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(100, 'evt-new-outlook', 'outlook');
    expect(mocks.deleteEvent).toHaveBeenCalledWith('evt-old-google', 'google', 42);
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

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
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

  it('retries Google rate-limit writes before reporting sync failure', async () => {
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

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsFailed).toBe(0);
      expect(result.data.message).toBe('1 session added to your calendar.');
    }
    expect(mocks.createEvent).toHaveBeenCalledTimes(2);
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(1700, 'evt-retry', 'google');
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

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsFailed).toBe(0);
    }
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(219, 'evt-repaired-time', 'google');
    expect(mocks.deleteEvent).toHaveBeenCalledWith('evt-old-time', 'google', 42);
    expect(mocks.markCalendarOwnershipDeleted).toHaveBeenCalledWith({
      eventId: 'evt-old-time',
      source: 'google',
      reason: 'training_sync_replaced_stale_event',
      status: 'deleted',
      userId: 42,
      planId: 29,
    });
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

  it('does not create events for inactive schedule-state sessions', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 33,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 330, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 3301, day_of_week: 'Monday', session_type: 'gym', title: 'Unscheduled Lift', duration_minutes: 40, description: '', status: 'unscheduled', calendar_event_id: null },
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

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsFailed).toBe(1);
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

    const result = await syncTrainingPlanCalendar(42, now, undefined, 42);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
    }
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(231, 'new-shape-lift', 'google');
    expect(mocks.deleteEvent).toHaveBeenCalledWith('old-shape-lift', 'google', 42);
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
    expect(mocks.isTrainingCalendarEventUnclaimed).toHaveBeenCalledWith('claimed-recovery-run', 'google');
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

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsFailed).toBe(1);
      expect(result.data.message).toBe('1 of 2 sessions added to your calendar; 1 could not be created.');
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
