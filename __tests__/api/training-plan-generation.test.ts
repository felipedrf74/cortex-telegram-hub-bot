import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetProfile = vi.fn();
const mockGetMissingProfileFields = vi.fn();
const mockGetQuestionnaire = vi.fn();
const mockGetEvents = vi.fn();
const mockBuildTrainingEquipmentAdaptation = vi.fn();
const mockAdaptTrainingPlanToAvailableEquipment = vi.fn();
const mockBuildTrainingPlanCoordination = vi.fn();
const mockApplyTrainingPlanCoordination = vi.fn();
const mockBuildSharedDecisionContext = vi.fn();
const mockReadTrainingMeshContext = vi.fn();
const mockReadCookingMeshContext = vi.fn();
const mockReadFinanceMeshContext = vi.fn();
const mockReadContentMeshContext = vi.fn();
const mockReadSecretaryMeshContext = vi.fn();
const mockBuildCoachKernelTrainingPlan = vi.fn();
const mockBuildDeterministicTrainingPlan = vi.fn();
const mockFetchCurrentReadinessForPlan = vi.fn();
const mockPersistGeneratedTrainingPlan = vi.fn();
const mockCancelTrainingPlanForUser = vi.fn();
// Slice 4.D.2 — saga inspects post-cancellation state via these.
const mockGetActivePlans = vi.fn();
const mockFindOrphanedOwnerships = vi.fn();
const mockReconcileOrphanedTrainingAgendaEvents = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('../../src/services/onboarding', () => ({
  getProfile: (...args: unknown[]) => mockGetProfile(...args),
  getMissingProfileFields: (...args: unknown[]) => mockGetMissingProfileFields(...args),
  getQuestionnaire: (...args: unknown[]) => mockGetQuestionnaire(...args),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  // Identity-safety / test-isolation: vitest config has `singleFork: true`,
  // so a partial mock on this module leaks `undefined` exports to later
  // test files (e.g., `training-plan-calendar-sync.test.ts` re-mocks but
  // hits a stale module cache without these methods). Provide complete
  // no-op spies for the rest of the surface so the partial mock cannot
  // poison sibling tests.
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  getEventsWithDiagnostics: vi.fn(async () => ({ events: [], status: 'ready', warnings: [], warningCodes: [] })),
  isAnyCalendarConfigured: vi.fn(() => false),
  hasConnectedCalendarForUser: vi.fn(() => false),
  hasWritableCalendarForUser: vi.fn(() => false),
  getConfiguredSources: vi.fn(() => []),
  eventFingerprint: vi.fn(() => ''),
  deduplicateEvents: vi.fn((events: unknown[]) => events),
}));

vi.mock('../../src/services/training-plan-equipment-adaptation', () => ({
  buildTrainingEquipmentAdaptation: (...args: unknown[]) => mockBuildTrainingEquipmentAdaptation(...args),
  adaptTrainingPlanToAvailableEquipment: (...args: unknown[]) => mockAdaptTrainingPlanToAvailableEquipment(...args),
}));

vi.mock('../../src/services/training-plan-coordination', () => ({
  buildTrainingPlanCoordination: (...args: unknown[]) => mockBuildTrainingPlanCoordination(...args),
  applyTrainingPlanCoordination: (...args: unknown[]) => mockApplyTrainingPlanCoordination(...args),
}));

vi.mock('../../src/services/shared-decision-context', () => ({
  buildSharedDecisionContext: (...args: unknown[]) => mockBuildSharedDecisionContext(...args),
}));

vi.mock('../../src/services/cross-agent-learning', () => ({
  readTrainingMeshContext: (...args: unknown[]) => mockReadTrainingMeshContext(...args),
  readCookingMeshContext: (...args: unknown[]) => mockReadCookingMeshContext(...args),
  readFinanceMeshContext: (...args: unknown[]) => mockReadFinanceMeshContext(...args),
  readContentMeshContext: (...args: unknown[]) => mockReadContentMeshContext(...args),
  readSecretaryMeshContext: (...args: unknown[]) => mockReadSecretaryMeshContext(...args),
}));

vi.mock('../../src/services/training-coach-kernel-plan-generator', () => ({
  buildCoachKernelTrainingPlan: (...args: unknown[]) => mockBuildCoachKernelTrainingPlan(...args),
}));

vi.mock('../../src/api/routes/training-fallback-plan', () => ({
  buildDeterministicTrainingPlan: (...args: unknown[]) => mockBuildDeterministicTrainingPlan(...args),
}));

vi.mock('../../src/api/routes/training-read-models', () => ({
  fetchCurrentReadinessForPlan: (...args: unknown[]) => mockFetchCurrentReadinessForPlan(...args),
}));

vi.mock('../../src/api/routes/training-plan-persistence', () => ({
  persistGeneratedTrainingPlan: (...args: unknown[]) => mockPersistGeneratedTrainingPlan(...args),
}));

vi.mock('../../src/api/routes/training-plan-cancellation', () => ({
  cancelTrainingPlanForUser: (...args: unknown[]) => mockCancelTrainingPlanForUser(...args),
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlans: (...args: unknown[]) => mockGetActivePlans(...args),
}));

vi.mock('../../src/services/training-plan-lifecycle', () => ({
  findOrphanedOwnerships: (...args: unknown[]) => mockFindOrphanedOwnerships(...args),
}));

vi.mock('../../src/services/training-agenda-reconciliation', () => ({
  reconcileOrphanedTrainingAgendaEvents: (...args: unknown[]) => (
    mockReconcileOrphanedTrainingAgendaEvents(...args)
  ),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { generateTrainingPlanForUser } from '../../src/api/routes/training-plan-generation';

function makePlan(title = 'Coach Plan') {
  return {
    planName: title,
    sport: 'running',
    weeks: [
      {
        weekNumber: 1,
        focus: 'base',
        intensityPct: 70,
        sessions: [
          {
            dayOfWeek: 'Monday',
            sessionType: 'run',
            title: 'Easy Run',
            durationMinutes: 45,
            description: 'Easy aerobic run.',
          },
        ],
      },
    ],
  };
}

describe('generateTrainingPlanForUser', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockGetProfile.mockReset();
    mockGetMissingProfileFields.mockReset();
    mockGetQuestionnaire.mockReset();
    mockGetEvents.mockReset();
    mockBuildTrainingEquipmentAdaptation.mockReset();
    mockAdaptTrainingPlanToAvailableEquipment.mockReset();
    mockBuildTrainingPlanCoordination.mockReset();
    mockApplyTrainingPlanCoordination.mockReset();
    mockBuildSharedDecisionContext.mockReset();
    mockReadTrainingMeshContext.mockReset();
    mockReadCookingMeshContext.mockReset();
    mockReadFinanceMeshContext.mockReset();
    mockReadContentMeshContext.mockReset();
    mockReadSecretaryMeshContext.mockReset();
    mockBuildCoachKernelTrainingPlan.mockReset();
    mockBuildDeterministicTrainingPlan.mockReset();
    mockFetchCurrentReadinessForPlan.mockReset();
    mockPersistGeneratedTrainingPlan.mockReset();
    mockCancelTrainingPlanForUser.mockReset();
    mockGetActivePlans.mockReset();
    mockFindOrphanedOwnerships.mockReset();
    mockReconcileOrphanedTrainingAgendaEvents.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    // Slice 4.D.2 defaults — clean state, no orphans, no remaining plans.
    mockGetActivePlans.mockReturnValue([]);
    mockFindOrphanedOwnerships.mockReturnValue([]);
    mockReconcileOrphanedTrainingAgendaEvents.mockResolvedValue({
      attempted: 0,
      deleted: 0,
      failed: 0,
    });

    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') return { experienceLevel: 'Intermediate' };
      if (questionnaireId === 'triathlon-running') return { currentMileage: 35 };
      if (questionnaireId === 'triathlon-gym') return { equipment_access: 'Full gym' };
      return null;
    });
    mockGetMissingProfileFields.mockReturnValue([]);
    mockGetQuestionnaire.mockImplementation((id: string) => ({ id, title: id }));
    mockGetEvents.mockResolvedValue([]);
    mockBuildTrainingEquipmentAdaptation.mockReturnValue({ equipmentProfile: 'full_gym' });
    mockBuildTrainingPlanCoordination.mockReturnValue({ promptBlock: '- ok' });
    mockApplyTrainingPlanCoordination.mockImplementation((plan: unknown) => plan);
    mockAdaptTrainingPlanToAvailableEquipment.mockImplementation((plan: unknown) => plan);
    mockBuildSharedDecisionContext.mockResolvedValue('<shared>context</shared>');
    mockReadTrainingMeshContext.mockResolvedValue({ derivedSignals: [{ signalType: 'recovery_state' }] });
    mockReadCookingMeshContext.mockResolvedValue({ derivedSignals: [] });
    mockReadFinanceMeshContext.mockResolvedValue({ derivedSignals: [] });
    mockReadContentMeshContext.mockResolvedValue({ filmingRecommendation: null });
    mockReadSecretaryMeshContext.mockResolvedValue({ focusBlock: null });
    mockBuildCoachKernelTrainingPlan.mockReturnValue(makePlan());
    mockBuildDeterministicTrainingPlan.mockReturnValue(makePlan('Fallback Plan'));
    mockFetchCurrentReadinessForPlan.mockResolvedValue({ score: 76 });
    mockPersistGeneratedTrainingPlan.mockResolvedValue({
      planId: 9001,
      totalSessions: 4,
      eventsCreated: 3,
      weekSummaries: [{ weekNumber: 1, focus: 'base', sessionCount: 4 }],
    });
    mockCancelTrainingPlanForUser.mockResolvedValue({
      status: 'not_found',
      data: {
        cancelled: false,
        removedEvents: 0,
        removedSessions: 0,
        removedWeeks: 0,
        removedCompletions: 0,
        removedPlans: 0,
        totalSessions: 0,
        message: 'No active training plan to cancel.',
      },
    });
  });

  it('returns a missing-profile response before calling planning services', async () => {
    mockGetProfile.mockReturnValue(null);
    mockGetMissingProfileFields.mockReturnValue([{ key: 'fitness_goal' }]);

    const result = await generateTrainingPlanForUser({
      userId: 12,
      objective: 'Lisbon Marathon',
    });

    expect(result.status).toBe('needs_profile');
    expect(result.data).toMatchObject({
      needsProfile: true,
      missingFields: [{ key: 'fitness_goal' }],
    });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('treats an empty persisted onboarding wrapper as a missing profile', async () => {
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') {
        return {
          id: 1,
          user_id: 12,
          profile_type: 'fitness',
          data: {},
          created_at: '2026-05-03',
          updated_at: '2026-05-03',
        };
      }
      return null;
    });
    mockGetMissingProfileFields.mockReturnValue([{ key: 'experience_level' }]);

    const result = await generateTrainingPlanForUser({
      userId: 12,
      objective: 'General fitness',
    });

    expect(result.status).toBe('needs_profile');
    expect(mockBuildTrainingEquipmentAdaptation).not.toHaveBeenCalled();
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('unwraps persisted onboarding profile rows before planning and equipment adaptation', async () => {
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') {
        return {
          id: 1,
          user_id: 12,
          profile_type: 'fitness',
          data: {
            experience_level: 'Advanced (3+ years)',
            available_equipment: 'Full gym',
            training_goals: 'Strength, Endurance',
          },
          created_at: '2026-05-03',
          updated_at: '2026-05-03',
        };
      }
      if (questionnaireId === 'triathlon-gym') {
        return {
          id: 2,
          user_id: 12,
          profile_type: 'triathlon-gym',
          data: {
            training_age: '5+ years',
            equipment_access: 'Full commercial gym',
            primary_goal: 'Hypertrophy',
          },
          created_at: '2026-05-03',
          updated_at: '2026-05-03',
        };
      }
      if (questionnaireId === 'triathlon-running') {
        return {
          id: 3,
          user_id: 12,
          profile_type: 'triathlon-running',
          data: {
            weekly_mileage_km: '45',
            target_race: 'Marathon',
            target_race_date: '2026-10-18',
          },
          created_at: '2026-05-03',
          updated_at: '2026-05-03',
        };
      }
      return null;
    });

    await generateTrainingPlanForUser({
      userId: 12,
      objective: 'Lisbon Marathon',
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 5,
    });

    expect(mockBuildTrainingEquipmentAdaptation).toHaveBeenCalledWith({
      fitnessProfile: expect.objectContaining({
        available_equipment: 'Full gym',
      }),
      gymProfile: expect.objectContaining({
        equipment_access: 'Full commercial gym',
      }),
    });
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      fitnessProfile: expect.objectContaining({
        experience_level: 'Advanced (3+ years)',
      }),
      gymProfile: expect.objectContaining({
        training_age: '5+ years',
      }),
      runProfile: expect.objectContaining({
        weekly_mileage_km: '45',
      }),
    }));
    expect(mockBuildCoachKernelTrainingPlan.mock.calls[0][0].fitnessProfile).not.toHaveProperty('data');
    expect(mockBuildCoachKernelTrainingPlan.mock.calls[0][0].gymProfile).not.toHaveProperty('data');
    expect(mockBuildCoachKernelTrainingPlan.mock.calls[0][0].runProfile).not.toHaveProperty('data');
  });

  it('returns the objective-specific questionnaire requirement before planning', async () => {
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') return { experienceLevel: 'Intermediate' };
      return null;
    });
    mockGetQuestionnaire.mockImplementation((id: string) => ({ id, title: 'Running Profile' }));
    mockGetMissingProfileFields.mockImplementation((_userId: number, questionnaireId: string) => (
      questionnaireId === 'triathlon-running'
        ? [{ key: 'target_race_date' }]
        : []
    ));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      objective: 'Porto Marathon',
    });

    expect(result.status).toBe('needs_profile');
    expect(result.data).toMatchObject({
      needsProfile: true,
      requiredQuestionnaireId: 'triathlon-running',
      requiredQuestionnaireTitle: 'Running Profile',
      missingFields: [{ key: 'target_race_date' }],
    });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
  });

  it('builds a coordinated coach-kernel plan and returns the persisted response shape', async () => {
    mockGetEvents.mockResolvedValue([
      {
        start: '2026-04-20T09:00:00.000Z',
        end: '2026-04-20T10:00:00.000Z',
        subject: 'Fixed meeting',
      },
    ]);

    const result = await generateTrainingPlanForUser({
      userId: 12,
      objective: 'Lisbon Marathon',
      durationWeeks: 6,
      preferredTime: 'not-a-time',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      sessionsPerWeek: 9,
      strengthSessionsPerWeek: 3,
      longWorkoutDay: ' Sunday ',
      notes: '  keep knees happy  ',
    });

    expect(result.status).toBe('created');
    expect(result.data).toMatchObject({
      planId: 9001,
      planName: 'Coach Plan',
      sport: 'running',
      objective: 'Lisbon Marathon',
      durationWeeks: 6,
      totalSessions: 4,
      eventsCreated: 3,
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      fallbackTemplateUsed: false,
    });
    expect(String(result.data.message)).toContain('Plan created!');
    expect(mockGetEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 12);
    expect(mockBuildSharedDecisionContext).toHaveBeenCalledWith('triathlon', 12);
    expect(mockBuildTrainingPlanCoordination).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 3,
      longWorkoutDay: 'Sunday',
      sharedDecisionContext: '<shared>context</shared>',
      training: { derivedSignals: [{ signalType: 'recovery_state' }] },
    }));
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 3,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      longWorkoutDay: 'Sunday',
      notes: 'keep knees happy',
      currentReadiness: { score: 76 },
    }));
    expect(mockCancelTrainingPlanForUser).toHaveBeenCalledWith(12);

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.busyWindows).toEqual([
      expect.objectContaining({ title: 'Fixed meeting' }),
    ]);
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      sessionsPerWeek: 9,
      strengthSessionsPerWeek: 3,
      longWorkoutDay: ' Sunday ',
      notes: '  keep knees happy  ',
    });
  });

  it('persists the requested training calendar source for generation and follow-up sync', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      objective: 'Lisbon Marathon',
      calendarSource: 'google',
    });

    expect(result.status).toBe('created');
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.calendarSource).toBe('google');
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      trainingCalendarSource: 'google',
    });
  });

  it('falls back to the deterministic template when the coach kernel fails', async () => {
    mockBuildCoachKernelTrainingPlan.mockImplementation(() => {
      throw new Error('kernel unavailable');
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      objective: 'General running consistency',
      durationWeeks: 4,
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 1,
    });

    expect(result.status).toBe('created');
    expect(result.data.fallbackTemplateUsed).toBe(true);
    expect(String(result.data.message)).toContain('reliable fallback template');
    expect(mockBuildDeterministicTrainingPlan).toHaveBeenCalledWith(
      'General running consistency',
      4,
      expect.objectContaining({
        sessionsPerWeek: 5,
        strengthSessionsPerWeek: 1,
      }),
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 12, objective: 'General running consistency' }),
      expect.stringContaining('Coach-kernel training plan generation unavailable'),
    );
  });

  it('continues plan generation when calendar reads are unavailable', async () => {
    mockGetEvents.mockRejectedValue(new Error('calendar offline'));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      objective: 'Build consistency',
    });

    expect(result.status).toBe('created');
    expect(mockPersistGeneratedTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      busyWindows: [],
    }));
  });

  // training-expert-coach-knowledge-engine (2026-05-03):
  // P0-C — calendar fetch fail-safe. When `getEvents` errors we still
  // generate a plan (so a transient OAuth blip doesn't block the user)
  // but mark `calendarFetchDegraded: true` and emit an explicit
  // `calendar_fetch_degraded` warning so iOS can render a "review your
  // week before trusting it" banner. Historical bug: the silent empty
  // busyWindows scheduled sessions on top of meetings.
  it('marks the response as calendarFetchDegraded when getEvents throws', async () => {
    mockGetEvents.mockRejectedValue(new Error('OAuth token expired'));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      objective: 'Build consistency',
    });

    expect(result.status).toBe('created');
    expect((result as any).data.calendarFetchDegraded).toBe(true);
    expect((result as any).data.calendarFetchError).toBe('OAuth token expired');
    expect((result as any).data.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'calendar_fetch_degraded' }),
      ]),
    );
  });

  it('does NOT mark calendarFetchDegraded on a normal calendar read', async () => {
    mockGetEvents.mockResolvedValue([]);

    const result = await generateTrainingPlanForUser({
      userId: 12,
      objective: 'Build consistency',
    });

    expect(result.status).toBe('created');
    expect((result as any).data.calendarFetchDegraded).toBe(false);
    expect((result as any).data.calendarFetchError).toBeUndefined();
    // No `calendar_fetch_degraded` warning surface.
    const warnings = (result as any).data.warnings ?? [];
    const codes = warnings.map((w: any) => w.code);
    expect(codes).not.toContain('calendar_fetch_degraded');
  });

  it('preserves legacy zero-value session fallback semantics', async () => {
    await generateTrainingPlanForUser({
      userId: 12,
      objective: 'Build consistency',
      sessionsPerWeek: 0,
      strengthSessionsPerWeek: 0,
    });

    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 0,
    }));
  });

  it('respects the requested gym volume for English muscle-building goals', async () => {
    await generateTrainingPlanForUser({
      userId: 12,
      objective: 'Muscle Building',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
    });

    expect(mockBuildTrainingPlanCoordination).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
    }));
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Muscle Building',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
    }));
  });

  it('passes explicit five-day strength volume through the app-facing marathon generation route', async () => {
    await generateTrainingPlanForUser({
      userId: 12,
      objective: 'Lisbon Marathon',
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 5,
    });

    expect(mockBuildTrainingPlanCoordination).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 5,
    }));
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Lisbon Marathon',
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 5,
    }));

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 5,
    });
  });

  // ─── Slice 4.D.2 — pre-persist cancellation saga ─────────────────────

  describe('pre-persist cancellation saga (slice 4.D.2)', () => {
    it('aborts the persist with cancellation_failed when the cancellation throws AND the prior plan is still active', async () => {
      mockCancelTrainingPlanForUser.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
      mockGetActivePlans.mockReturnValue([{ id: 999, status: 'active' }]);

      const result = await generateTrainingPlanForUser({
        userId: 12,
        objective: 'Lisbon Marathon',
        sessionsPerWeek: 5,
        strengthSessionsPerWeek: 2,
      });

      expect(result.status).toBe('cancellation_failed');
      if (result.status === 'cancellation_failed') {
        expect(result.data.activePlansRemaining).toBe(1);
        expect(result.data.reason).toContain('SQLITE_BUSY');
        expect(String(result.data.message)).toContain('Could not finalize cancellation');
      }
      // Critical: persist must NOT run when the saga aborts.
      expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
      expect(mockLoggerError).toHaveBeenCalled();
    });

    it('proceeds with persist when cancellation throws but no active plans remain (post-delete throw)', async () => {
      mockCancelTrainingPlanForUser.mockRejectedValueOnce(new Error('Narrative cleanup failed'));
      mockGetActivePlans.mockReturnValue([]);

      const result = await generateTrainingPlanForUser({
        userId: 12,
        objective: 'Lisbon Marathon',
        sessionsPerWeek: 5,
        strengthSessionsPerWeek: 2,
      });

      expect(result.status).toBe('created');
      expect(mockPersistGeneratedTrainingPlan).toHaveBeenCalledTimes(1);
      // Should warn about post-delete throw, not error.
      expect(mockLoggerWarn).toHaveBeenCalled();
    });

    it('warns and continues when cancellation succeeds with orphaned external events', async () => {
      mockCancelTrainingPlanForUser.mockResolvedValueOnce({
        status: 'cancelled',
        data: {
          cancelled: true,
          planId: 99,
          removedEvents: 3,
          removedSessions: 10,
          removedWeeks: 4,
          removedCompletions: 0,
          removedPlans: 1,
          totalSessions: 10,
          message: 'Plan cancelled',
        },
      });
      mockFindOrphanedOwnerships.mockReturnValue([
        { id: 1, calendar_event_id: 'evt-orphan-1', calendar_source: 'google', status: 'active' },
        { id: 2, calendar_event_id: 'evt-orphan-2', calendar_source: 'outlook', status: 'active' },
      ]);

      const result = await generateTrainingPlanForUser({
        userId: 12,
        objective: 'Lisbon Marathon',
        sessionsPerWeek: 5,
        strengthSessionsPerWeek: 2,
      });

      expect(result.status).toBe('created');
      expect(mockPersistGeneratedTrainingPlan).toHaveBeenCalledTimes(1);
      // The saga should warn that reconciliation is queued.
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ orphanedEventCount: 2 }),
        expect.stringContaining('reconciliation queued'),
      );
    });

    it('continues silently when cancellation reports no active plan (first-time generation)', async () => {
      // Default mock from beforeEach already returns 'not_found'.
      const result = await generateTrainingPlanForUser({
        userId: 12,
        objective: 'Lisbon Marathon',
        sessionsPerWeek: 5,
        strengthSessionsPerWeek: 2,
      });

      expect(result.status).toBe('created');
      expect(mockPersistGeneratedTrainingPlan).toHaveBeenCalledTimes(1);
      // No saga warnings/errors for clean first-time generation.
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it('handles forbidden cancellation by warning and proceeding', async () => {
      mockCancelTrainingPlanForUser.mockResolvedValueOnce({ status: 'forbidden' });

      const result = await generateTrainingPlanForUser({
        userId: 12,
        objective: 'Lisbon Marathon',
        sessionsPerWeek: 5,
        strengthSessionsPerWeek: 2,
      });

      expect(result.status).toBe('created');
      expect(mockPersistGeneratedTrainingPlan).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 12 }),
        expect.stringContaining('not user-owned'),
      );
    });
  });
});
