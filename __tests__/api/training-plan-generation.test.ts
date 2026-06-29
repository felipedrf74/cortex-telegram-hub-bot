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
const mockFinalizeGeneratedTrainingPlanForPersistence = vi.fn();
const mockLintGeneratedTrainingPlanPreflight = vi.fn();
const mockPersistGeneratedTrainingPlan = vi.fn();
const mockCancelTrainingPlanForUser = vi.fn();
// Slice 4.D.2 — saga inspects post-cancellation state via these.
const mockGetActivePlans = vi.fn();
const mockFindOrphanedOwnerships = vi.fn();
const mockReconcileOrphanedTrainingAgendaEvents = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
const mockIsConnected = vi.fn();
const mockGetLatestHealthSignal = vi.fn();

vi.mock('../../src/services/onboarding', () => ({
  getProfile: (...args: unknown[]) => mockGetProfile(...args),
  getMissingProfileFields: (...args: unknown[]) => mockGetMissingProfileFields(...args),
  getQuestionnaire: (...args: unknown[]) => mockGetQuestionnaire(...args),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  getEventsForSources: (...args: unknown[]) => mockGetEvents(...args),
  // Identity-safety / test-isolation: vitest config has `singleFork: true`,
  // so a partial mock on this module leaks `undefined` exports to later
  // test files (e.g., `training-plan-calendar-sync.test.ts` re-mocks but
  // hits a stale module cache without these methods). Provide complete
  // no-op spies for the rest of the surface so the partial mock cannot
  // poison sibling tests.
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  getEventsWithDiagnostics: vi.fn(async () => ({
    events: [],
    status: 'ready',
    warnings: [],
    warningCodes: [],
    sources: { configured: [], fulfilled: [], failed: [] },
  })),
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
  normalizeTrainingPlanDurationWeeks: (raw: unknown, fallback = 4) => {
    const resolved = Number(raw);
    const candidate = Number.isFinite(resolved) && resolved > 0 ? Math.round(resolved) : fallback;
    return Math.max(1, Math.min(52, candidate));
  },
}));

vi.mock('../../src/api/routes/training-fallback-plan', () => ({
  buildDeterministicTrainingPlan: (...args: unknown[]) => mockBuildDeterministicTrainingPlan(...args),
}));

vi.mock('../../src/api/routes/training-read-models', () => ({
  fetchCurrentReadinessForPlan: (...args: unknown[]) => mockFetchCurrentReadinessForPlan(...args),
}));

vi.mock('../../src/api/routes/training-plan-persistence', () => ({
  finalizeGeneratedTrainingPlanForPersistence: (...args: unknown[]) => (
    mockFinalizeGeneratedTrainingPlanForPersistence(...args)
  ),
  lintGeneratedTrainingPlanPreflight: (...args: unknown[]) => (
    mockLintGeneratedTrainingPlanPreflight(...args)
  ),
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

vi.mock('../../src/services/oauth-store', () => ({
  isConnected: (...args: unknown[]) => mockIsConnected(...args),
}));

vi.mock('../../src/services/health-signals', () => ({
  getLatestHealthSignal: (...args: unknown[]) => mockGetLatestHealthSignal(...args),
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
  LOGGER_REDACTION_PATHS: [],
}));

import {
  TRAINING_PLAN_GENERATOR_POLICY_VERSION,
  clampTrainingPlanDurationWeeksToRaceDate,
  generateTrainingPlanForUser,
  resolveTrainingPlanStartDate,
} from '../../src/api/routes/training-plan-generation';
import { config } from '../../src/config';

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

function makePlanFromKernelInput(input: any, title = 'Coach Plan') {
  const priority = String(input?.trainingPriority ?? '').toLowerCase();
  const objective = String(input?.objective ?? '').toLowerCase();
  const sport = priority === 'strength' || /muscle|strength|gym/i.test(objective)
    ? 'gym'
    : priority === 'cycling'
      ? 'cycling'
      : priority === 'swimming'
        ? 'swimming'
        : priority === 'triathlon' || priority === 'hybrid'
          ? 'hybrid'
          : 'running';
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const sessions: any[] = [];
  let dayIndex = 0;
  const requested = (value: unknown): number => (
    typeof value === 'number' && value > 0 ? Math.round(value) : 0
  );
  const addSessions = (count: number, sessionType: string, sessionTitle: string) => {
    for (let index = 0; index < count; index += 1) {
      sessions.push({
        dayOfWeek: days[dayIndex % days.length],
        sessionType,
        title: `${sessionTitle} ${index + 1}`,
        durationMinutes: sessionType === 'swim' ? 35 : 45,
        description: `${sessionTitle} scheduled from test kernel input.`,
        exercises: sessionType === 'gym' ? [{ name: 'Squat' }] : [],
      });
      dayIndex += 1;
    }
  };

  const sessionsPerWeek = requested(input?.sessionsPerWeek) || 5;
  const runCount = requested(input?.runSessionsPerWeek)
    || (sport === 'running' ? sessionsPerWeek : 0);
  const bikeCount = requested(input?.bikeSessionsPerWeek)
    || (priority === 'cycling' ? sessionsPerWeek : 0)
    || (priority === 'triathlon' ? 1 : 0);
  const swimCount = requested(input?.swimSessionsPerWeek)
    || (priority === 'swimming' ? sessionsPerWeek : 0)
    || (priority === 'triathlon' ? 1 : 0);
  const strengthCount = requested(input?.strengthSessionsPerWeek);
  const strengthFallback = sport === 'gym' && strengthCount === 0 ? sessionsPerWeek : 0;

  addSessions(runCount, 'run', 'Run');
  addSessions(bikeCount, 'ride', 'Ride');
  addSessions(swimCount, 'swim', 'Swim');
  addSessions(strengthCount || strengthFallback, 'gym', 'Strength');

  return {
    planName: title,
    sport,
    weeks: [
      {
        weekNumber: 1,
        focus: 'base',
        intensityPct: 70,
        sessions,
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
    mockFinalizeGeneratedTrainingPlanForPersistence.mockReset();
    mockLintGeneratedTrainingPlanPreflight.mockReset();
    mockPersistGeneratedTrainingPlan.mockReset();
    mockCancelTrainingPlanForUser.mockReset();
    mockGetActivePlans.mockReset();
    mockFindOrphanedOwnerships.mockReset();
    mockReconcileOrphanedTrainingAgendaEvents.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    mockIsConnected.mockReset();
    mockGetLatestHealthSignal.mockReset();
    mockGetLatestHealthSignal.mockReturnValue(null);
    config.coaching.trainingSafetyGuardrailsEnabled = false;
    config.coaching.coachKernelEquipmentAuthorityEnabled = false;
    mockIsConnected.mockReturnValue(true);
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
    mockBuildCoachKernelTrainingPlan.mockImplementation((input: any) => makePlanFromKernelInput(input));
    mockBuildDeterministicTrainingPlan.mockReturnValue(makePlan('Fallback Plan'));
    mockFetchCurrentReadinessForPlan.mockResolvedValue({ score: 76 });
    mockFinalizeGeneratedTrainingPlanForPersistence.mockImplementation((input: unknown) => input);
    mockLintGeneratedTrainingPlanPreflight.mockReturnValue({
      status: 'pass',
      blockers: [],
      warnings: [],
      suggestedFixes: [],
    });
    mockPersistGeneratedTrainingPlan.mockResolvedValue({
      planId: 9001,
      totalSessions: 4,
      eventsCreated: 3,
      sessionsLinked: 3,
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
    mockGetQuestionnaire.mockImplementation((id: string) =>
      id === 'fitness' ? { id, title: 'Fitness Profile' } : { id, title: id });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
    });

    expect(result.status).toBe('needs_profile');
    // RERUN-2 finding 3: the fitness gate must carry the questionnaire
    // id + title just like the objective gate below it — a null id
    // suppressed the iOS routing CTA for empty-profile users.
    expect(result.data).toMatchObject({
      needsProfile: true,
      requiredQuestionnaireId: 'fitness',
      requiredQuestionnaireTitle: 'Fitness Profile',
      missingFields: [{ key: 'fitness_goal' }],
    });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('asks for clarification before saving high-frequency strength plans with unknown equipment', async () => {
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') return { experienceLevel: 'Intermediate' };
      if (questionnaireId === 'triathlon-gym') return {};
      return null;
    });
    mockBuildTrainingEquipmentAdaptation.mockReturnValue({
      equipmentProfile: 'unknown',
      canonicalProfile: { items: [] },
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Build muscle with a 5-day gym plan',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
    });

    expect(result.status).toBe('needs_clarification');
    if (result.status === 'needs_clarification') {
      expect(result.data.clarificationIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'equipment_clarification', severity: 'blocker' }),
          expect.objectContaining({ id: 'session_duration_clarification', severity: 'blocker' }),
        ]),
      );
      expect(result.data.suggestedQuestions.join(' ')).toMatch(/equipment/i);
    }
    expect(mockCancelTrainingPlanForUser).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'training_plan_spec.needs_clarification',
        clarificationIds: expect.arrayContaining(['equipment_clarification']),
      }),
      expect.stringContaining('needs clarification'),
    );
  });

  it('falls back to the questionnaire id when the fitness definition has no title', async () => {
    mockGetProfile.mockReturnValue(null);
    mockGetMissingProfileFields.mockReturnValue([{ key: 'fitness_goal' }]);
    mockGetQuestionnaire.mockReturnValue(undefined);

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
    });

    expect(result.status).toBe('needs_profile');
    expect(result.data).toMatchObject({
      needsProfile: true,
      requiredQuestionnaireId: 'fitness',
      requiredQuestionnaireTitle: 'fitness',
    });
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
      tenantId: 12,
      objective: 'General fitness',
    });

    expect(result.status).toBe('needs_profile');
    expect(result.data).toMatchObject({
      needsProfile: true,
      requiredQuestionnaireId: 'fitness',
      requiredQuestionnaireTitle: 'fitness',
    });
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
      tenantId: 12,
      objective: 'Lisbon Marathon',
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 5,
    });

    expect(mockBuildTrainingEquipmentAdaptation).toHaveBeenCalledWith(expect.objectContaining({
      fitnessProfile: expect.objectContaining({
        available_equipment: 'Full gym',
      }),
      gymProfile: expect.objectContaining({
        equipment_access: 'Full commercial gym',
      }),
    }));
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
        ? [{ key: 'weekly_mileage_km' }]
        : []
    ));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Porto Marathon',
    });

    expect(result.status).toBe('needs_profile');
    expect(result.data).toMatchObject({
      needsProfile: true,
      requiredQuestionnaireId: 'triathlon-running',
      requiredQuestionnaireTitle: 'Running Profile',
      missingFields: [{ key: 'weekly_mileage_km' }],
    });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
  });

  it('builds a coordinated coach-kernel plan and returns the persisted response shape', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-04-15T06:00:00.000Z'));
    mockGetEvents.mockResolvedValue([
      {
        start: '2026-04-20T09:00:00.000Z',
        end: '2026-04-20T10:00:00.000Z',
        subject: 'Fixed meeting',
      },
    ]);

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      durationWeeks: 6,
      preferredTime: 'not-a-time',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      sessionsPerWeek: 7,
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
      resolvedStartDate: '2026-04-20',
      totalSessions: 4,
      eventsCreated: 3,
      calendarSync: expect.objectContaining({
        eventsCreated: 3,
        sessionsLinked: 3,
        sessionsFailed: 1,
        unscheduled: 1,
        status: 'partial',
      }),
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      fallbackTemplateUsed: false,
    });
    expect(String(result.data.message)).toContain('Plan created!');
    expect(mockGetEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 12, ['outlook']);
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
      startDate: '2026-04-20',
    }));
    expect(mockCancelTrainingPlanForUser).toHaveBeenCalledWith(12, undefined, { tenantId: 12 });

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.busyWindows).toEqual([
      expect.objectContaining({ title: 'Fixed meeting' }),
    ]);
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 3,
      longWorkoutDay: ' Sunday ',
      notes: '  keep knees happy  ',
      startPolicy: 'next_full_week',
    });
  });

  it('reports strength targets from the final scheduled plan when requested strength exceeds the day budget', async () => {
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      ...makePlan('Strength Plan'),
      sport: 'gym',
      weeks: [{ weekNumber: 1, focus: 'base', intensityPct: 70, sessions: [] }],
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Muscle Building',
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 5,
      trainingPriority: 'strength',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 5,
    }));
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 5,
      trainingPriority: 'strength',
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 5,
    });
  });

  it('derives reported strength targets from the final explicit run-plus-strength schedule', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Running with strength support',
      sessionsPerWeek: 5,
      runSessionsPerWeek: 2,
      strengthSessionsPerWeek: 5,
      trainingPriority: 'running',
    });

    expect(result.status).toBe('created');
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 5,
      runSessionsPerWeek: 2,
      strengthSessionsPerWeek: 5,
      trainingPriority: 'running',
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 5,
      runSessionsPerWeek: 2,
      strengthSessionsPerWeek: 5,
    });
  });

  it('derives triathlon zero bike and swim floors from the final scheduled plan', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Olympic triathlon',
      sessionsPerWeek: 6,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 0,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 1,
      trainingPriority: 'triathlon',
    });

    expect(result.status).toBe('created');
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 6,
      runSessionsPerWeek: 3,
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 1,
      strengthSessionsPerWeek: 1,
      trainingPriority: 'triathlon',
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 6,
      runSessionsPerWeek: 3,
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 1,
      strengthSessionsPerWeek: 1,
    });
  });

  it('derives weekly targets from finalized week-two counts when week one is unscheduled', async () => {
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      planName: 'Midweek Finalized Plan',
      sport: 'running',
      weeks: [
        {
          weekNumber: 1,
          focus: 'start-week',
          intensityPct: 65,
          sessions: [
            { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Run 1', durationMinutes: 45 },
            { dayOfWeek: 'Thursday', sessionType: 'run', title: 'Run 2', durationMinutes: 45 },
            { dayOfWeek: 'Friday', sessionType: 'gym', title: 'Strength 1', durationMinutes: 45, exercises: [{ name: 'Squat' }] },
            { dayOfWeek: 'Saturday', sessionType: 'gym', title: 'Strength 2', durationMinutes: 45, exercises: [{ name: 'Hinge' }] },
          ],
        },
        {
          weekNumber: 2,
          focus: 'steady-state',
          intensityPct: 70,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'run', title: 'Run 1', durationMinutes: 45 },
            { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Run 2', durationMinutes: 45 },
            { dayOfWeek: 'Saturday', sessionType: 'run', title: 'Run 3', durationMinutes: 60 },
            { dayOfWeek: 'Friday', sessionType: 'gym', title: 'Strength', durationMinutes: 45, exercises: [{ name: 'Squat' }] },
          ],
        },
      ],
    });
    mockFinalizeGeneratedTrainingPlanForPersistence.mockImplementation((input: any) => ({
      ...input,
      planData: {
        ...input.planData,
        weeks: input.planData.weeks.map((week: any) => (
          week.weekNumber === 1
            ? {
                ...week,
                sessions: week.sessions.map((session: any) => ({
                  ...session,
                  scheduleState: 'unscheduled',
                })),
              }
            : week
        )),
      },
    }));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Running after a mid-week start',
      startDate: '2026-04-29',
      sessionsPerWeek: 5,
      runSessionsPerWeek: 3,
      strengthSessionsPerWeek: 1,
      trainingPriority: 'running',
    });

    expect(result.status).toBe('created');
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.planData.weeks[0].sessions.every((session: any) => session.scheduleState === 'unscheduled')).toBe(true);
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 5,
      runSessionsPerWeek: 3,
      strengthSessionsPerWeek: 1,
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 5,
      runSessionsPerWeek: 3,
      strengthSessionsPerWeek: 1,
    });
  });

  it('reports a reduced modality target when finalization unschedules that modality in every week', async () => {
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      planName: 'Triathlon Finalized Plan',
      sport: 'hybrid',
      weeks: [1, 2].map((weekNumber) => ({
        weekNumber,
        focus: 'base',
        intensityPct: 70,
        sessions: [
          { dayOfWeek: 'Monday', sessionType: 'run', title: `Run ${weekNumber}`, durationMinutes: 45 },
          { dayOfWeek: 'Wednesday', sessionType: 'ride', title: `Ride ${weekNumber}`, durationMinutes: 60 },
          { dayOfWeek: 'Thursday', sessionType: 'swim', title: `Swim ${weekNumber}`, durationMinutes: 35 },
          { dayOfWeek: 'Friday', sessionType: 'gym', title: `Strength ${weekNumber}`, durationMinutes: 45, exercises: [{ name: 'Split Squat' }] },
        ],
      })),
    });
    mockFinalizeGeneratedTrainingPlanForPersistence.mockImplementation((input: any) => ({
      ...input,
      planData: {
        ...input.planData,
        weeks: input.planData.weeks.map((week: any) => ({
          ...week,
          sessions: week.sessions.map((session: any) => (
            session.sessionType === 'swim'
              ? { ...session, scheduleState: 'unscheduled' }
              : session
          )),
        })),
      },
    }));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Olympic triathlon',
      sessionsPerWeek: 6,
      runSessionsPerWeek: 1,
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
      trainingPriority: 'triathlon',
    });

    expect(result.status).toBe('created');
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 1,
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 1,
    });
  });

  it('pauses generated sessions before persistence when structured safety guardrail blocks training', async () => {
    config.coaching.trainingSafetyGuardrailsEnabled = true;
    mockGetLatestHealthSignal.mockReturnValue({
      id: 1,
      user_id: 12,
      tenant_id: 12,
      date: '2026-04-18',
      pain_score: null,
      pain_location: null,
      illness_symptoms_json: JSON.stringify(['chest_pain']),
      injury_status: null,
      menstrual_status: null,
      energy_availability_risk: null,
      source: 'structured_intake',
      consent_scope: 'illness',
      created_at: '2026-04-18T10:00:00.000Z',
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'General fitness',
    });

    expect(result.status).toBe('created');
    expect(mockGetLatestHealthSignal).toHaveBeenCalledWith(12, 12, expect.any(String), { maxAgeDays: 14 });
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.planData.weeks[0].sessions[0]).toMatchObject({
      sessionType: 'rest',
      title: 'Safety pause',
      durationMinutes: 0,
      scheduleState: 'deferred',
    });
    expect(persistInput.planData.weeks[0].sessions[0].scheduleReason).toMatch(/consult a qualified healthcare professional/i);
    expect(result.data).toMatchObject({
      trainingSafety: {
        status: 'blocked',
        reasonCode: 'medical_referral',
      },
    });
    expect(result.data.warnings).toContainEqual(expect.objectContaining({
      code: 'safety_guardrail_blocked',
    }));
  });

  it('continues generation when the bounded safety lookup returns no fresh health signal', async () => {
    config.coaching.trainingSafetyGuardrailsEnabled = true;
    mockGetLatestHealthSignal.mockReturnValue(null);

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'General fitness',
    });

    expect(result.status).toBe('created');
    expect(mockGetLatestHealthSignal).toHaveBeenCalledWith(12, 12, expect.any(String), { maxAgeDays: 14 });
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.planData.weeks[0].sessions[0]).toMatchObject({
      sessionType: 'run',
      durationMinutes: 45,
    });
    expect(persistInput.planData.weeks[0].sessions[0].title).toMatch(/run/i);
    expect(result.data.trainingSafety).toBeNull();
  });

  it('skips route-level equipment mutation when coach-kernel equipment authority is enabled', async () => {
    config.coaching.coachKernelEquipmentAuthorityEnabled = true;
    const equipmentDecisionReason = {
      code: 'equipment_conservative_default',
      text: 'I used bodyweight-safe options because your available equipment is unknown.',
      severity: 'notice',
      affectedEntity: { type: 'week' },
      sourceConstraint: { type: 'equipment', label: 'unknown equipment' },
      evidence: ['equipment_missing'],
    };
    mockBuildTrainingEquipmentAdaptation.mockReturnValue({
      equipmentProfile: 'bodyweight',
      summary: 'Bodyweight-safe default',
      promptBlock: '- bodyweight safe',
      authority: 'coach_kernel',
      canonicalProfile: {
        profileId: 'equipment-vocabulary-v1:unknown_conservative',
        bucket: 'bodyweight',
        items: ['bodyweight', 'floor_space', 'mobility_mat'],
        confidence: 'unknown',
        source: 'default',
        matchedAliases: [],
        summary: 'Bodyweight-safe default',
        decisionReasons: [equipmentDecisionReason],
      },
      decisionReasons: [equipmentDecisionReason],
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'General fitness',
    });

    expect(result.status).toBe('created');
    expect(mockBuildTrainingEquipmentAdaptation).toHaveBeenCalledWith(expect.objectContaining({
      conservativeUnknown: true,
    }));
    expect(mockAdaptTrainingPlanToAvailableEquipment).not.toHaveBeenCalled();
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.equipmentProfile).toBe('bodyweight');
    expect(persistInput.planData.decisionReasons).toContainEqual(expect.objectContaining({
      code: 'equipment_conservative_default',
    }));
    expect(result.data.decisionReasons).toContainEqual(expect.objectContaining({
      code: 'equipment_conservative_default',
    }));
  });

  it('resolves default plan starts to the next full training week unless today is requested', () => {
    expect(resolveTrainingPlanStartDate(new Date('2026-04-17T10:00:00.000Z'), 'next_full_week')).toBe('2026-04-20');
    expect(resolveTrainingPlanStartDate(new Date('2026-04-17T10:00:00.000Z'), 'today')).toBe('2026-04-17');
    expect(resolveTrainingPlanStartDate(new Date('2026-04-20T10:00:00.000Z'), 'next_full_week')).toBe('2026-04-20');
    expect(resolveTrainingPlanStartDate(new Date('2026-06-15T08:00:00.000Z'), 'today')).toBe('2026-06-15');
    expect(resolveTrainingPlanStartDate(new Date('2026-06-14T20:56:00.000Z'), 'today')).toBe('2026-06-15');
  });

  it('passes Monday June 15 2026 through as the plan start when iOS asks for today', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-06-15T08:00:00.000Z'));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Muscle Building',
      startPolicy: 'today',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      startDate: '2026-06-15',
    }));
  });

  it('rolls Sunday June 14 2026 today requests to Monday to avoid an empty first week', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-06-14T20:56:00.000Z'));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Muscle Building',
      startPolicy: 'today',
      sessionsPerWeek: 5,
      runSessionsPerWeek: 0,
      strengthSessionsPerWeek: 5,
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      startDate: '2026-06-15',
      sessionsPerWeek: 5,
      runSessionsPerWeek: 0,
      strengthSessionsPerWeek: 5,
    }));
  });

  it('honors the internal planner clock override for staging smoke runs', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Muscle Building',
      startPolicy: 'today',
      plannerNow: '2026-06-15T08:00:00+01:00',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      startDate: '2026-06-15',
    }));
  });

  // Rerun-4 R3: iOS derives the week count from "today" while the
  // engine anchors at next Monday, so a 16-week marathon request made
  // mid-week overshot the race by days and lint-blocked the wizard.
  // The clamp mirrors the linter (planDays <= daysThroughRace, race
  // day inclusive) so a clamped duration always passes it.
  it('clamps the requested duration to the largest whole-week count ending by race day', () => {
    // Exact rerun-4 repro: Mon 2026-06-15 → race Fri 2026-10-02 is a
    // 110-day window; 16 weeks (112 days) overshoots, 15 weeks fits.
    expect(clampTrainingPlanDurationWeeksToRaceDate({
      requestedDurationWeeks: 16,
      startDateIso: '2026-06-15',
      raceDateIso: '2026-10-02',
    })).toBe(15);
    // Already-fitting requests are untouched.
    expect(clampTrainingPlanDurationWeeksToRaceDate({
      requestedDurationWeeks: 15,
      startDateIso: '2026-06-15',
      raceDateIso: '2026-10-02',
    })).toBe(15);
    expect(clampTrainingPlanDurationWeeksToRaceDate({
      requestedDurationWeeks: 8,
      startDateIso: '2026-06-15',
      raceDateIso: '2026-10-02',
    })).toBe(8);
    // No race date / malformed / race-before-start / sub-week windows
    // pass through unchanged and stay with the linter.
    expect(clampTrainingPlanDurationWeeksToRaceDate({
      requestedDurationWeeks: 16,
      startDateIso: '2026-06-15',
      raceDateIso: null,
    })).toBe(16);
    expect(clampTrainingPlanDurationWeeksToRaceDate({
      requestedDurationWeeks: 16,
      startDateIso: '2026-06-15',
      raceDateIso: 'not-a-date',
    })).toBe(16);
    expect(clampTrainingPlanDurationWeeksToRaceDate({
      requestedDurationWeeks: 16,
      startDateIso: '2026-06-15',
      raceDateIso: '2026-06-01',
    })).toBe(16);
    expect(clampTrainingPlanDurationWeeksToRaceDate({
      requestedDurationWeeks: 16,
      startDateIso: '2026-06-15',
      raceDateIso: '2026-06-18',
    })).toBe(16);
  });

  it('generates an event-based plan with the clamped duration instead of lint-blocking (rerun-4 R3)', async () => {
    vi.useFakeTimers();
    // Friday 2026-06-12 in Europe/Lisbon → start resolves to Monday 2026-06-15.
    vi.setSystemTime(new Date('2026-06-12T10:00:00.000Z'));
    try {
      const result = await generateTrainingPlanForUser({
        userId: 12,
        tenantId: 12,
        objective: 'Marathon',
        goalMode: 'event_based',
        raceDate: '2026-10-02',
        durationWeeks: 16,
      });

      expect(result.status).toBe('created');
      expect(result.durationWeeks).toBe(15);
      expect(result.data.resolvedStartDate).toBe('2026-06-15');
      const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
      expect(persistInput.durationWeeks).toBe(15);
      expect(persistInput.endDate).toBe('2026-09-28');
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists the requested training calendar source for generation and follow-up sync', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
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

  it('returns a non-mutating preview using the selected calendar source', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      calendarSource: 'outlook',
      previewOnly: true,
    });

    expect(result.status).toBe('preview');
    if (result.status === 'preview') {
      expect(result.data).toMatchObject({
        status: 'preview',
        calendarSource: 'outlook',
        phaseRoadmap: [
          expect.objectContaining({
            weekNumber: 1,
            phase: 'base',
          }),
        ],
      });
      expect(result.data.totalSessions).toBeGreaterThan(0);
      expect(result.data.phaseRoadmap[0].sessionCount).toBeGreaterThan(0);
      expect(result.data.trainingLearningPath?.weeklyPath[0]?.phaseGoal).toBeTruthy();
      expect(result.data.phaseRoadmap[0].weeklyLearningFocus).toBeTruthy();
    }
    expect(mockGetEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 12, ['outlook']);
    expect(mockCancelTrainingPlanForUser).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('does not synthesize run volume for pure strength preview requests', async () => {
    mockBuildTrainingEquipmentAdaptation.mockReturnValue({
      equipmentProfile: 'dumbbells',
      canonicalProfile: { items: ['dumbbells'] },
    });
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      planName: 'Dumbbell Strength',
      sport: 'gym',
      weeks: [1, 2, 3, 4].map((weekNumber) => ({
        weekNumber,
        focus: weekNumber === 4 ? 'deload' : 'base',
        intensityPct: weekNumber === 4 ? 55 : 70,
        sessions: [],
      })),
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Beginner strength plan, dumbbells only',
      durationWeeks: 4,
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 3,
      previewOnly: true,
      calendarSource: null,
    });

    expect(result.status).toBe('preview');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Beginner strength plan, dumbbells only',
      sessionsPerWeek: 3,
      runSessionsPerWeek: undefined,
      strengthSessionsPerWeek: 3,
    }));
    if (result.status === 'preview') {
      expect(result.data.weeklyTargets).toMatchObject({
        sessionsPerWeek: 3,
        runSessionsPerWeek: null,
        strengthSessionsPerWeek: 3,
      });
      expect(result.data.totalSessions).toBe(12);
      expect(result.data.phaseRoadmap).toHaveLength(4);
      expect(result.data.phaseRoadmap.every((week) => week.sessionCount === 3)).toBe(true);
      expect(result.data.trainingLearningPath?.measurableOutcomes).toEqual(expect.arrayContaining([
        'Session completion and skip rate',
        'Post-session RPE, soreness, and pain feedback',
      ]));
      expect(result.data.blockers).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'progression_model_integrity' }),
      ]));
    }
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('passes cycling and swim profile modules into generation and preflight context', async () => {
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') return { experienceLevel: 'Intermediate' };
      if (questionnaireId === 'triathlon-gym') return { equipment_access: 'Full gym' };
      if (questionnaireId === 'triathlon-running') return { weekly_mileage_km: 28, easy_pace_min_per_km: '5:45' };
      if (questionnaireId === 'triathlon-cycling') {
        return {
          ftp_watts: 235,
          weekly_hours: '3-6 hours',
          target_event: 'Triathlon bike leg',
          preferred_training_days: ['Saturday'],
          blocked_days: ['Friday'],
        };
      }
      if (questionnaireId === 'triathlon-swim') {
        return {
          pool_access: 'Yes',
          sessions_per_week: '2',
          primary_stroke: 'Freestyle',
          preferred_training_days: ['Wednesday'],
          blocked_days: ['Sunday'],
        };
      }
      return null;
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Sprint triathlon plan',
      durationWeeks: 4,
      bikeSessionsPerWeek: 2,
      swimSessionsPerWeek: 2,
      previewOnly: true,
      calendarSource: null,
    });

    expect(result.status).toBe('preview');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      runProfile: expect.objectContaining({
        ftp_watts: 235,
        cycling_weekly_hours: '3-6 hours',
        pool_access: 'Yes',
        swim_sessions_per_week: '2',
        preferred_training_days: ['Saturday', 'Wednesday'],
        blocked_days: ['Friday', 'Sunday'],
      }),
    }));
    expect(mockLintGeneratedTrainingPlanPreflight).toHaveBeenCalledWith(expect.objectContaining({
      athleteProfiles: expect.objectContaining({
        cyclingProfile: expect.objectContaining({ ftp_watts: 235 }),
        swimProfile: expect.objectContaining({ pool_access: 'Yes' }),
      }),
    }));
  });

  it('blocks deterministic fallback persistence when the coach kernel fails', async () => {
    mockBuildCoachKernelTrainingPlan.mockImplementation(() => {
      throw new Error('kernel unavailable');
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'General running consistency',
      durationWeeks: 4,
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 1,
    });

    expect(result.status).toBe('plan_quality_blocked');
    expect(result.data.fallbackTemplateUsed).toBe(true);
    expect(String(result.data.message)).toContain('did not save it');
    expect(result.data.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'fallback_requires_review' }),
    ]));
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
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('continues plan generation when calendar reads are unavailable', async () => {
    mockGetEvents.mockRejectedValue(new Error('calendar offline'));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
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
      tenantId: 12,
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

  it('blocks failed plan-linter preflight before cancellation or persistence', async () => {
    mockLintGeneratedTrainingPlanPreflight.mockReturnValueOnce({
      status: 'fail',
      blockers: [
        {
          ruleId: 'equipment_compatibility',
          severity: 'blocker',
          message: 'Barbell work is incompatible with a bodyweight-only profile.',
          affectedSessions: [{ weekNumber: 1, dayOfWeek: 'monday', title: 'Lower Body Strength' }],
        },
      ],
      warnings: [],
      suggestedFixes: [
        {
          findingRuleId: 'equipment_compatibility',
          action: 'Substitute barbell work for bodyweight variants.',
        },
      ],
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Build consistency',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
    });

    expect(result.status).toBe('plan_quality_blocked');
    if (result.status === 'plan_quality_blocked') {
      expect(result.data.planLint.status).toBe('fail');
      expect(result.data.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'lint_blocker_equipment_compatibility',
            message: 'Barbell work is incompatible with a bodyweight-only profile.',
          }),
        ]),
      );
      expect(result.data.message).toContain('blocked this plan before saving');
    }
    expect(mockCancelTrainingPlanForUser).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'training_plan_quality_gate.blocked_pre_persist',
        blockerRuleIds: ['equipment_compatibility'],
      }),
      expect.stringContaining('blocked plan before cancellation/persistence'),
    );
  });

  it('blocks event-based race-style plans when the race date is missing', async () => {
    mockLintGeneratedTrainingPlanPreflight.mockImplementationOnce((input: any) => {
      expect(input).toMatchObject({
        objective: 'Lisbon Marathon',
        goalMode: 'event_based',
        raceDate: null,
        isRaceSpecific: true,
      });
      return {
        status: 'fail',
        blockers: [
          {
            ruleId: 'race_specific_plan_requires_race_date',
            severity: 'blocker',
            message: 'Event-based plans need a race date.',
            affectedSessions: [],
          },
        ],
        warnings: [],
        suggestedFixes: [],
      };
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      goalMode: 'event_based',
      raceDate: null,
    });

    expect(result.status).toBe('plan_quality_blocked');
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('allows continuous marathon-style planning without forcing an event day', async () => {
    mockLintGeneratedTrainingPlanPreflight.mockImplementationOnce((input: any) => {
      expect(input).toMatchObject({
        objective: 'Lisbon Marathon',
        goalMode: 'continuous',
        raceDate: null,
        isRaceSpecific: false,
      });
      return {
        status: 'pass',
        blockers: [],
        warnings: [],
        suggestedFixes: [],
      };
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      goalMode: 'continuous',
      raceDate: null,
    });

    expect(result.status).toBe('created');
    expect(mockPersistGeneratedTrainingPlan).toHaveBeenCalledTimes(1);
  });

  it('does NOT mark calendarFetchDegraded on a normal calendar read', async () => {
    mockGetEvents.mockResolvedValue([]);

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
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
      tenantId: 12,
      objective: 'Build consistency',
      sessionsPerWeek: 0,
      strengthSessionsPerWeek: 0,
    });

    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 0,
    }));
  });

  it('normalizes fractional and out-of-range frequency inputs before planning', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Olympic triathlon',
      durationWeeks: 4.4,
      sessionsPerWeek: 4.5,
      runSessionsPerWeek: 2.4,
      bikeSessionsPerWeek: 99,
      swimSessionsPerWeek: 1.6,
      strengthSessionsPerWeek: 1.2,
      trainingPriority: 'triathlon',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      durationWeeks: 4,
      sessionsPerWeek: 5,
      runSessionsPerWeek: 2,
      bikeSessionsPerWeek: 7,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
    }));
    expect((result as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 5,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 7,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
    });
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 5,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 7,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
    });
  });

  it('bounds durationWeeks and records the generator policy version', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Build consistency',
      durationWeeks: 999,
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      durationWeeks: 52,
    }));
    expect((result as any).data.durationWeeks).toBe(52);
    expect((result as any).data.generatorPolicyVersion).toBe(TRAINING_PLAN_GENERATOR_POLICY_VERSION);
    expect((result as any).data.generationVersionPins).toMatchObject({
      selectorPolicyVersion: 'selector-policy-v2',
      equipmentVocabularyVersion: 'equipment-vocabulary-v1',
      generationPipelineVersion: 'training-generation-pipeline-v1',
    });

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      generatorPolicyVersion: TRAINING_PLAN_GENERATOR_POLICY_VERSION,
      generationVersionPins: expect.objectContaining({
        selectorPolicyVersion: 'selector-policy-v2',
      }),
    });
  });

  it('respects the requested gym volume for English muscle-building goals', async () => {
    await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
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
      tenantId: 12,
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

  it('derives omitted gym-only strength targets from the selected weekly structure', async () => {
    await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Muscle Building',
      sessionsPerWeek: 5,
      trainingPriority: 'strength',
    });

    expect(mockBuildTrainingPlanCoordination).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
    }));
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Muscle Building',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
      trainingPriority: 'strength',
    }));

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
      trainingPriority: 'strength',
    });
  });

  it('does not widen non-gym strength priority into a fake gym-only target', async () => {
    await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'General fitness',
      sessionsPerWeek: 5,
      trainingPriority: 'strength',
    });

    expect(mockBuildTrainingPlanCoordination).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
    }));
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'General fitness',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      trainingPriority: 'strength',
    }));

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      trainingPriority: 'strength',
    });
  });

  it('persists the effective gym strength target when explicit zero is expanded downstream', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Muscle Building',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 0,
    });

    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Muscle Building',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 0,
    }));
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
    });
  });

  it('passes explicit bike and swim targets through the app-facing triathlon route', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Olympic triathlon',
      sessionsPerWeek: 7,
      runSessionsPerWeek: 4,
      bikeSessionsPerWeek: 3,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 2,
      trainingPriority: 'triathlon',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Olympic triathlon',
      sessionsPerWeek: 7,
      runSessionsPerWeek: 4,
      bikeSessionsPerWeek: 3,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 2,
      trainingPriority: 'triathlon',
    }));

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      runSessionsPerWeek: 4,
      bikeSessionsPerWeek: 3,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 2,
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      runSessionsPerWeek: 4,
      bikeSessionsPerWeek: 3,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 2,
    });
  });

  it('round-trips app-facing weekly targets for every selected training priority', async () => {
    const cases = [
      {
        objective: 'Lisbon Marathon',
        trainingPriority: 'running',
        sessionsPerWeek: 6,
        runSessionsPerWeek: 5,
        bikeSessionsPerWeek: 0,
        swimSessionsPerWeek: 0,
        strengthSessionsPerWeek: 1,
      },
      {
        objective: 'Cycling gran fondo',
        trainingPriority: 'cycling',
        sessionsPerWeek: 5,
        runSessionsPerWeek: 0,
        bikeSessionsPerWeek: 4,
        swimSessionsPerWeek: 0,
        strengthSessionsPerWeek: 1,
      },
      {
        objective: 'Open-water swimming',
        trainingPriority: 'swimming',
        sessionsPerWeek: 5,
        runSessionsPerWeek: 0,
        bikeSessionsPerWeek: 0,
        swimSessionsPerWeek: 4,
        strengthSessionsPerWeek: 1,
      },
      {
        objective: 'Sprint triathlon',
        trainingPriority: 'triathlon',
        sessionsPerWeek: 6,
        runSessionsPerWeek: 2,
        bikeSessionsPerWeek: 2,
        swimSessionsPerWeek: 2,
        strengthSessionsPerWeek: 1,
      },
      {
        objective: 'General fitness',
        trainingPriority: 'hybrid',
        sessionsPerWeek: 5,
        runSessionsPerWeek: 2,
        bikeSessionsPerWeek: 1,
        swimSessionsPerWeek: 0,
        strengthSessionsPerWeek: 2,
      },
      {
        objective: 'Muscle Building',
        trainingPriority: 'strength',
        sessionsPerWeek: 5,
        runSessionsPerWeek: 0,
        bikeSessionsPerWeek: 0,
        swimSessionsPerWeek: 0,
        strengthSessionsPerWeek: 5,
      },
    ] as const;

    for (const planCase of cases) {
      const result = await generateTrainingPlanForUser({
        userId: 12,
        tenantId: 12,
        objective: planCase.objective,
        sessionsPerWeek: planCase.sessionsPerWeek,
        runSessionsPerWeek: planCase.runSessionsPerWeek,
        bikeSessionsPerWeek: planCase.bikeSessionsPerWeek,
        swimSessionsPerWeek: planCase.swimSessionsPerWeek,
        strengthSessionsPerWeek: planCase.strengthSessionsPerWeek,
        trainingPriority: planCase.trainingPriority,
      });

      expect(result.status).toBe('created');
      const lastKernelCall = mockBuildCoachKernelTrainingPlan.mock.calls[
        mockBuildCoachKernelTrainingPlan.mock.calls.length - 1
      ]?.[0];
      expect(lastKernelCall).toMatchObject({
        sessionsPerWeek: planCase.sessionsPerWeek,
        runSessionsPerWeek: planCase.runSessionsPerWeek,
        bikeSessionsPerWeek: planCase.bikeSessionsPerWeek,
        swimSessionsPerWeek: planCase.swimSessionsPerWeek,
        strengthSessionsPerWeek: planCase.strengthSessionsPerWeek,
        trainingPriority: planCase.trainingPriority,
      });

      const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[
        mockPersistGeneratedTrainingPlan.mock.calls.length - 1
      ]?.[0];
      expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
        sessionsPerWeek: planCase.sessionsPerWeek,
        runSessionsPerWeek: planCase.runSessionsPerWeek,
        bikeSessionsPerWeek: planCase.bikeSessionsPerWeek,
        swimSessionsPerWeek: planCase.swimSessionsPerWeek,
        strengthSessionsPerWeek: planCase.strengthSessionsPerWeek,
        trainingPriority: planCase.trainingPriority,
      });
      expect((result as any).data.weeklyTargets).toMatchObject({
        sessionsPerWeek: planCase.sessionsPerWeek,
        runSessionsPerWeek: planCase.runSessionsPerWeek,
        bikeSessionsPerWeek: planCase.bikeSessionsPerWeek,
        swimSessionsPerWeek: planCase.swimSessionsPerWeek,
        strengthSessionsPerWeek: planCase.strengthSessionsPerWeek,
      });
    }
  });

  it('forwards explicit goal mode, priority, and race date from the app request', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 5,
      goalMode: 'event_based',
      trainingPriority: 'running',
      raceDate: '2026-10-18',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Lisbon Marathon',
      goalMode: 'event_based',
      trainingPriority: 'running',
      raceDate: '2026-10-18',
      runProfile: expect.objectContaining({
        currentMileage: 35,
        target_race_date: '2026-10-18',
        target_race: 'Lisbon Marathon',
      }),
    }));

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.raceDate).toBe('2026-10-18');
    expect(persistInput.athleteProfiles.runProfile).toEqual(expect.objectContaining({
      target_race_date: '2026-10-18',
    }));
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      goalMode: 'event_based',
      trainingPriority: 'running',
      raceDate: '2026-10-18',
    });
    expect((result as any).data).toMatchObject({
      goalMode: 'event_based',
      trainingPriority: 'running',
      raceDate: '2026-10-18',
    });
  });

  it('drops unsupported goal mode and priority before planning', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'General running consistency',
      goalMode: 'race',
      trainingPriority: 'bodybuilding',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      goalMode: null,
      trainingPriority: null,
      raceDate: null,
      runProfile: { currentMileage: 35 },
    }));

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.raceDate).toBeNull();
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      goalMode: null,
      trainingPriority: null,
      raceDate: null,
    });
  });

  it('blocks impossible race dates before planning', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      raceDate: '2026-02-30',
    });

    expect(result.status).toBe('needs_profile');
    expect((result as any).data.validationError).toMatchObject({
      code: 'INVALID_RACE_DATE',
      field: 'raceDate',
    });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  // ─── Slice 4.D.2 — pre-persist cancellation saga ─────────────────────

  describe('pre-persist cancellation saga (slice 4.D.2)', () => {
    it('aborts the persist with cancellation_failed when the cancellation throws AND the prior plan is still active', async () => {
      mockCancelTrainingPlanForUser.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
      mockGetActivePlans.mockReturnValue([{ id: 999, status: 'active' }]);

      const result = await generateTrainingPlanForUser({
        userId: 12,
        tenantId: 34,
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
      expect(mockGetActivePlans).toHaveBeenCalledWith(12, 34);
    });

    it('proceeds with persist when cancellation throws but no active plans remain (post-delete throw)', async () => {
      mockCancelTrainingPlanForUser.mockRejectedValueOnce(new Error('Narrative cleanup failed'));
      mockGetActivePlans.mockReturnValue([]);

      const result = await generateTrainingPlanForUser({
        userId: 12,
        tenantId: 12,
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
        tenantId: 12,
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
        tenantId: 12,
        objective: 'Lisbon Marathon',
        sessionsPerWeek: 5,
        strengthSessionsPerWeek: 2,
      });

      expect(result.status).toBe('created');
      expect(mockPersistGeneratedTrainingPlan).toHaveBeenCalledTimes(1);
      // No saga warnings/errors for clean first-time generation.
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

  });
});
