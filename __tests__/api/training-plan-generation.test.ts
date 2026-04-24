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
const mockLoggerWarn = vi.fn();

vi.mock('../../src/services/onboarding', () => ({
  getProfile: (...args: unknown[]) => mockGetProfile(...args),
  getMissingProfileFields: (...args: unknown[]) => mockGetMissingProfileFields(...args),
  getQuestionnaire: (...args: unknown[]) => mockGetQuestionnaire(...args),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
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

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: vi.fn(),
    error: vi.fn(),
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
    mockLoggerWarn.mockReset();

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
});
