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
  finalizeGeneratedTrainingPlanForPersistence: (input: unknown) => input,
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
    mockBuildCoachKernelTrainingPlan.mockReturnValue(makePlan());
    mockBuildDeterministicTrainingPlan.mockReturnValue(makePlan('Fallback Plan'));
    mockFetchCurrentReadinessForPlan.mockResolvedValue({ score: 76 });
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
        ? [{ key: 'target_race_date' }]
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
      missingFields: [{ key: 'target_race_date' }],
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
      sessionsPerWeek: 9,
      strengthSessionsPerWeek: 3,
      longWorkoutDay: ' Sunday ',
      notes: '  keep knees happy  ',
      startPolicy: 'next_full_week',
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
      title: 'Easy Run',
      durationMinutes: 45,
    });
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
    }
    expect(mockGetEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 12, ['outlook']);
    expect(mockCancelTrainingPlanForUser).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('falls back to the deterministic template when the coach kernel fails', async () => {
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
      runSessionsPerWeek: 2,
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
