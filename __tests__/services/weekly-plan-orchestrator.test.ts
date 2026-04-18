import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

const mockGetCached = vi.fn(() => null);
const mockSetCache = vi.fn();
const mockReadTrainingMeshContext = vi.fn();
const mockReadCookingMeshContext = vi.fn();
const mockReadContentMeshContext = vi.fn();
const mockReadSecretaryMeshContext = vi.fn();
const mockReadFinanceMeshContext = vi.fn();
const mockBuildEditorialSignals = vi.fn(() => ({ signals: [] }));
const mockIsUserOverDailyCap = vi.fn(() => ({ over: false }));
const mockGetUserById = vi.fn();
const mockGetWeeksForPlan = vi.fn();
const mockGetWeeklyAdherence = vi.fn();

let garminStatus = 'active';
let writtenSignals: Array<Record<string, unknown>> = [];
const mockDismissSignal = vi.fn((signalId: number) => {
  writtenSignals = writtenSignals.map((signal) =>
    signal.id === signalId
      ? { ...signal, status: 'dismissed' }
      : signal,
  );
});

vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
}));

vi.mock('../../src/services/cross-agent-learning', () => ({
  readTrainingMeshContext: (...args: unknown[]) => mockReadTrainingMeshContext(...args),
  readCookingMeshContext: (...args: unknown[]) => mockReadCookingMeshContext(...args),
  readContentMeshContext: (...args: unknown[]) => mockReadContentMeshContext(...args),
  readSecretaryMeshContext: (...args: unknown[]) => mockReadSecretaryMeshContext(...args),
  readFinanceMeshContext: (...args: unknown[]) => mockReadFinanceMeshContext(...args),
}));

vi.mock('../../src/agents/editorial-coordinator-agent', () => ({
  buildEditorialCoordinationSignals: (...args: unknown[]) => mockBuildEditorialSignals(...args),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  isUserOverDailyCap: (...args: unknown[]) => mockIsUserOverDailyCap(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
}));

vi.mock('../../src/services/training-plans', () => ({
  getWeeksForPlan: (...args: unknown[]) => mockGetWeeksForPlan(...args),
  getWeeklyAdherence: (...args: unknown[]) => mockGetWeeklyAdherence(...args),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: () => sql.includes('garmin_user_tokens')
        ? { status: garminStatus }
        : undefined,
    }),
  }),
}));

vi.mock('../../src/services/intelligence-bus', () => ({
  readSignals: (_consumer: string, signalTypes: string[], _limit: number, userId?: number) =>
    writtenSignals
      .filter((signal) =>
        signal.status === 'active'
        && signal.user_id === userId
        && signalTypes.includes(String(signal.signal_type)))
      .map((signal) => ({ ...signal })),
  writeSignal: (signal: Record<string, unknown>) => {
    const id = writtenSignals.length + 1;
    writtenSignals.push({
      id,
      ...signal,
      created_at: '2026-04-14T08:00:00.000Z',
      expires_at: signal.expires_at ?? '2026-04-20T23:59:59.000Z',
      consumed_by: [],
      status: 'active',
      confidence: 1,
      pillar_tag: null,
      format_tag: null,
      evidence_count: 1,
    });
    return id;
  },
  dismissSignal: (...args: unknown[]) => mockDismissSignal(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

function buildBaseContexts() {
  return {
    training: {
      userId: 12,
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      activePlan: {
        id: 1,
        user_id: 12,
        name: 'Build block',
        sport: 'running',
        goal: 'Half marathon',
        duration_weeks: 12,
        periodization: 'build',
        status: 'active',
        start_date: '2026-03-15',
        end_date: '2026-06-15',
        preferences_json: null,
        created_at: '2026-03-15T00:00:00.000Z',
        updated_at: '2026-03-15T00:00:00.000Z',
      },
      activeWeek: {
        id: 10,
        plan_id: 1,
        week_number: 5,
        focus: 'Threshold',
        intensity_pct: 85,
        volume_sessions: 4,
        notes: null,
        auto_adjusted: 0,
        adjustment_reason: null,
        created_at: '2026-04-13T00:00:00.000Z',
      },
      sessions: [
        {
          id: 101,
          week_id: 10,
          plan_id: 1,
          day_of_week: 'Wednesday',
          session_type: 'run',
          title: 'Track intervals',
          description: 'VO2 work',
          exercises_json: null,
          duration_minutes: 60,
          intensity_text: 'Hard',
          calendar_event_id: null,
          calendar_source: null,
          status: 'pending',
          created_at: '2026-04-13T00:00:00.000Z',
          updated_at: '2026-04-13T00:00:00.000Z',
        },
      ],
      trainingContext: {
        signals: [],
        flags: {
          lowSleep: false,
          lowHrv: false,
          lowReadiness: false,
          highLegLoad: false,
          highShoulderLoad: false,
          raceThisWeek: false,
          lowAdherence: false,
          highAdherence: true,
          planDrift: false,
          otherSportRpeToday: 0,
        },
      },
      coachBriefing: null,
      adherence: {
        planId: 1,
        weekNumber: 5,
        totalSessions: 4,
        completedSessions: 4,
        skippedSessions: 0,
        pendingSessions: 0,
        adherenceRate: 100,
        avgRpe: 7.5,
        avgEnergy: 8,
        avgSoreness: 3,
      },
      derivedSignals: [],
    },
    secretary: {
      userId: 12,
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      events: [],
      focusBlock: {
        start: '2026-04-15T09:00:00.000Z',
        end: '2026-04-15T10:30:00.000Z',
        date: '2026-04-15',
        confidence: 'high',
        reason: 'Best focus block of the week.',
        reasons: ['Calendar is light', 'Readiness is good'],
        focusWindow: 'peak',
        readinessScore: 78,
        trainingLoad: 'moderate',
        calendarLoad: 'light',
        trainingCoordination: {
          status: 'already_protected',
          sessionDate: '2026-04-16',
          sessionTitle: 'Tempo ride',
          sessionLoad: 'hard',
        },
      },
      dueToday: [],
      dueThisWeek: [],
      overdue: [],
      pending: [],
      writableCalendar: true,
      derivedSignals: [
        {
          sourceAgent: 'mesh.secretary-context',
          signalType: 'travel_window',
          meshPriority: 1,
          priority: 'urgent',
          payload: { dates: ['2026-04-14'] },
        },
      ],
    },
    cooking: {
      userId: 12,
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      meals: [
        {
          id: 1,
          user_id: 12,
          date: '2026-04-15',
          meal_type: 'dinner',
          recipe_id: null,
          title: 'High-protein bowl',
          notes: null,
          created_at: '2026-04-13T00:00:00.000Z',
        },
      ],
      shoppingList: null,
      derivedSignals: [],
    },
    content: {
      userId: 12,
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      upcomingTopicCount: 2,
      filmingRecommendation: {
        date: '2026-04-15',
        confidence: 'high',
        reason: 'Recovery and calendar line up for filming.',
        reasons: ['Good readiness', 'No hard session'],
        readinessScore: 80,
        trainingLoad: 'light',
        calendarLoad: 'light',
        blockStart: '2026-04-15T11:00:00.000Z',
        blockEnd: '2026-04-15T13:00:00.000Z',
        calendarReservationAvailable: true,
        calendarReservationMessage: null,
      },
      unreadNotifications: [],
      voiceDnaEntries: [],
      knowledgeStats: { categories: [], referenceChannels: 0 },
      derivedSignals: [],
    },
    finance: {
      userId: 12,
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      month: '2026-04',
      monthlySummary: {
        month: '2026-04',
        totalIncome: 1000,
        totalExpenses: 600,
        totalDeductions: 0,
        netIncome: 400,
        transactionCount: 8,
      },
      taxEvents: [],
      annualSummary: {
        year: 2026,
        totalGrossIncome: 1000,
        totalDeductions: 0,
        totalInssDue: 0,
        totalTaxDue: 0,
        totalPaid: 0,
        totalPending: 0,
        effectiveAnnualRate: 0,
        monthsPaid: 0,
        monthsPending: 0,
        months: [],
      },
      subscription: {
        plan: 'max',
        period: 'monthly',
        status: 'active',
        provider: 'stripe',
        currentPeriodEnd: '2026-04-25T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        isActive: true,
        isPro: true,
      },
      derivedSignals: [],
    },
  };
}

describe('weekly-plan-orchestrator', () => {
  beforeEach(() => {
    clearTenantScopeAnomaliesForTests();
    writtenSignals = [];
    mockDismissSignal.mockClear();
    garminStatus = 'active';
    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockReadTrainingMeshContext.mockReset();
    mockReadCookingMeshContext.mockReset();
    mockReadContentMeshContext.mockReset();
    mockReadSecretaryMeshContext.mockReset();
    mockReadFinanceMeshContext.mockReset();
    mockBuildEditorialSignals.mockReset();
    mockIsUserOverDailyCap.mockReset();
    mockGetUserById.mockReset();
    mockGetWeeksForPlan.mockReset();
    mockGetWeeklyAdherence.mockReset();

    const base = buildBaseContexts();
    mockReadTrainingMeshContext.mockResolvedValue(base.training);
    mockReadSecretaryMeshContext.mockResolvedValue(base.secretary);
    mockReadCookingMeshContext.mockResolvedValue(base.cooking);
    mockReadContentMeshContext.mockResolvedValue(base.content);
    mockReadFinanceMeshContext.mockResolvedValue(base.finance);
    mockBuildEditorialSignals.mockReturnValue({
      signals: [
        {
          sourceAgent: 'mesh.editorial-coordinator',
          signalType: 'shoot_day_locked',
          meshPriority: 3,
          priority: 'normal',
          payload: {
            date: '2026-04-15',
            blockStart: '2026-04-15T11:00:00.000Z',
            blockEnd: '2026-04-15T13:00:00.000Z',
            reservationAvailable: true,
          },
        },
      ],
    });
    mockIsUserOverDailyCap.mockReturnValue({ over: false });
    mockGetUserById.mockReturnValue({ id: 12, tier: 'max' });
    mockGetWeeksForPlan.mockReturnValue([
      { id: 7, week_number: 2 },
      { id: 8, week_number: 3 },
      { id: 9, week_number: 4 },
      { id: 10, week_number: 5 },
    ]);
    mockGetWeeklyAdherence.mockReturnValue({
      adherenceRate: 100,
    });
  });

  it('returns only training and secretary while gating other skills for free users', async () => {
    mockGetUserById.mockReturnValue({ id: 12, tier: 'free' });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.gated.skills).toEqual(['cooking', 'content', 'finance']);
    expect(mockReadCookingMeshContext).not.toHaveBeenCalled();
    expect(mockReadContentMeshContext).not.toHaveBeenCalled();
    expect(mockReadFinanceMeshContext).not.toHaveBeenCalled();
    expect(result.days[0].content?.status).toBe('gated');
    expect(result.days[0].finance?.budgetNote).toContain('Upgrade');
  });

  it('fails closed and records an anomaly when tenant scope is invalid', async () => {
    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 0, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(true);
    expect(result.days).toHaveLength(7);
    expect(result.summary).toEqual({
      sessionCount: 0,
      mealCount: 0,
      activeConflictCount: 0,
    });
    expect(result.days[0].headline).toContain('tenant scope is invalid');
    expect(mockReadTrainingMeshContext).not.toHaveBeenCalled();
    expect(mockReadSecretaryMeshContext).not.toHaveBeenCalled();
    expect(mockReadCookingMeshContext).not.toHaveBeenCalled();
    expect(mockReadContentMeshContext).not.toHaveBeenCalled();
    expect(mockReadFinanceMeshContext).not.toHaveBeenCalled();
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()[0]).toMatchObject({
      layer: 'orchestration',
      operation: 'compose_weekly_plan',
      reason: 'invalid_user_scope',
      userId: 0,
      details: { weekStart: '2026-04-13' },
    });
  });

  it('keeps the weekly plan available when the user record is missing', async () => {
    mockGetUserById.mockReturnValue(null);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.gated.skills).toEqual([]);
    expect(result.days).toHaveLength(7);
    expect(result.summary.sessionCount).toBeGreaterThanOrEqual(1);
  });

  it('marks the plan degraded and blanks creative copy when the user is over cap', async () => {
    mockIsUserOverDailyCap.mockReturnValue({ over: true });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(true);
    expect(result.creativeCopy).toEqual({ headline: '', note: '' });
  });

  it('returns garmin_stale and falls back to conservative mode when Garmin needs reauth', async () => {
    garminStatus = 'needs_reauth';

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.garmin_stale).toBe(true);
    expect(result.variant).toBe('conservative');
    expect(result.days.some((day) =>
      day.secretary.decisions.some((decision) => decision.signalType === 'travel_window'))).toBe(true);
  });

  it('turns recovery and session prescription signals into training decisions', async () => {
    const base = buildBaseContexts();
    base.training.derivedSignals = [
      {
        sourceAgent: 'mesh.training-context',
        signalType: 'recovery_state',
        meshPriority: 2,
        priority: 'urgent',
        payload: {
          date: '2026-04-15',
          state: 'strained',
          lowSleep: true,
          lowHrv: false,
          lowReadiness: false,
          sourceSignalIds: [9001],
        },
      },
      {
        sourceAgent: 'mesh.training-context',
        signalType: 'session_prescription',
        meshPriority: 3,
        priority: 'normal',
        payload: {
          date: '2026-04-15',
          title: 'Track intervals',
          sessionType: 'run',
          durationMinutes: 60,
          intensity: 'Hard',
        },
      },
    ];
    mockReadTrainingMeshContext.mockResolvedValue(base.training);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const wednesday = result.days.find((day) => day.date === '2026-04-15');

    expect(wednesday?.training.status).toBe('adjusted');
    expect(wednesday?.training.reason).toContain('Recovery is strained');
    expect(wednesday?.training.decisions.map((decision) => decision.signalType)).toEqual(
      expect.arrayContaining(['recovery_state', 'session_prescription']),
    );
  });

  it('surfaces fueling gaps, batch-cook guidance, and tight-budget direction in the plan', async () => {
    const base = buildBaseContexts();
    base.cooking.meals = [];
    base.cooking.derivedSignals = [
      {
        sourceAgent: 'mesh.cooking-context',
        signalType: 'fueling_support_status',
        meshPriority: 2,
        priority: 'urgent',
        payload: {
          status: 'at_risk',
          trainingDatesMissingMeals: ['2026-04-15'],
          hardDatesMissingMeals: ['2026-04-15'],
        },
      },
      {
        sourceAgent: 'mesh.cooking-context',
        signalType: 'meal_execution_readiness',
        meshPriority: 2,
        priority: 'urgent',
        payload: {
          status: 'at_risk',
        },
      },
    ];
    base.finance.derivedSignals = [
      {
        sourceAgent: 'mesh.finance-context',
        signalType: 'budget_remaining',
        meshPriority: 2,
        priority: 'urgent',
        payload: {
          month: '2026-04',
          remainingRatio: 0.18,
          totalIncome: 1000,
          totalExpenses: 820,
          totalDeductions: 0,
          budgetMode: 'controlled',
          groceryMode: 'cost_aware',
          trainingSpendMode: 'selective',
          contentSpendMode: 'selective',
          supplementMode: 'pause_new',
          subscriptionMode: 'review_now',
        },
      },
    ];
    mockReadCookingMeshContext.mockResolvedValue(base.cooking);
    mockReadFinanceMeshContext.mockResolvedValue(base.finance);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const monday = result.days.find((day) => day.date === '2026-04-13');
    const wednesday = result.days.find((day) => day.date === '2026-04-15');

    expect(monday?.finance?.budgetNote).toContain('Budget is controlled this week');
    expect(wednesday?.finance?.budgetNote).toContain('Budget mode is controlled; grocery mode is cost_aware; training spend mode is selective; content spend mode is selective.');
    expect(wednesday?.headline).toContain('Fueling needs attention');
    expect(wednesday?.meals.some((meal) => meal.title === 'Fueling coverage missing')).toBe(true);
    expect(wednesday?.meals.find((meal) => meal.title === 'Fueling coverage missing')?.note).toContain('staple carb + protein option you already buy');
  });

  it('places the batch-cook day around secretary and content pressure, not just around training sessions', async () => {
    const base = buildBaseContexts();
    base.cooking.meals = [];
    base.secretary.focusBlock = {
      ...base.secretary.focusBlock,
      date: '2026-04-17',
      start: '2026-04-17T09:00:00.000Z',
      end: '2026-04-17T10:30:00.000Z',
    };
    base.secretary.derivedSignals = [
      {
        sourceAgent: 'mesh.secretary-context',
        signalType: 'travel_window',
        meshPriority: 1,
        priority: 'urgent',
        payload: { dates: ['2026-04-13'] },
      },
      {
        sourceAgent: 'mesh.secretary-context',
        signalType: 'calendar_busy_blocks',
        meshPriority: 1,
        priority: 'urgent',
        payload: { dates: ['2026-04-14'], totalEvents: 5 },
      },
    ];
    base.content.filmingRecommendation = {
      ...base.content.filmingRecommendation,
      date: '2026-04-18',
      blockStart: '2026-04-18T11:00:00.000Z',
      blockEnd: '2026-04-18T13:00:00.000Z',
    };
    mockReadSecretaryMeshContext.mockResolvedValue(base.secretary);
    mockReadContentMeshContext.mockResolvedValue(base.content);
    mockReadCookingMeshContext.mockResolvedValue(base.cooking);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    const thursday = result.days.find((day) => day.date === '2026-04-16');
    const monday = result.days.find((day) => day.date === '2026-04-13');
    const tuesday = result.days.find((day) => day.date === '2026-04-14');
    const friday = result.days.find((day) => day.date === '2026-04-17');
    const saturday = result.days.find((day) => day.date === '2026-04-18');

    expect(thursday?.meals.some((meal) => meal.title === 'Batch-cook window')).toBe(true);
    expect(monday?.meals.some((meal) => meal.title === 'Batch-cook window')).toBe(false);
    expect(tuesday?.meals.some((meal) => meal.title === 'Batch-cook window')).toBe(false);
    expect(friday?.meals.some((meal) => meal.title === 'Batch-cook window')).toBe(false);
    expect(saturday?.meals.some((meal) => meal.title === 'Batch-cook window')).toBe(false);
  });

  it('gives secretary explicit sequencing guidance when training, meals, and content compete on the same day', async () => {
    const base = buildBaseContexts();
    base.cooking.meals = [];
    base.training.derivedSignals = [
      {
        sourceAgent: 'mesh.training-context',
        signalType: 'session_prescription',
        meshPriority: 3,
        priority: 'normal',
        payload: {
          date: '2026-04-15',
          title: 'Track intervals',
          sessionType: 'run',
          durationMinutes: 60,
          intensity: 'Hard',
        },
      },
      {
        sourceAgent: 'mesh.training-context',
        signalType: 'session_immovability',
        meshPriority: 2,
        priority: 'urgent',
        payload: {
          date: '2026-04-15',
          title: 'Track intervals',
          level: 'high',
        },
      },
    ];
    mockReadTrainingMeshContext.mockResolvedValue(base.training);
    mockReadCookingMeshContext.mockResolvedValue(base.cooking);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const wednesday = result.days.find((day) => day.date === '2026-04-15');

    expect(wednesday?.secretary.priorityNote).toBe('Protect Track intervals as a high-immovability training block.');
    expect(wednesday?.secretary.sequence).toEqual([
      'Protect the key training window before moving meetings, errands, or filming onto the day.',
      'Lock meal or shopping coverage before the session so training support is not left to chance.',
      'Use the filming or sponsor block only after training and core obligations are protected.',
      'Keep the recommended focus block clean once the non-negotiables are sequenced.',
    ]);
    expect(wednesday?.secretary.tradeoffNote).toBe(
      'Training is the anchor, meals need closing before it, and content should only use whatever bandwidth remains after both are protected.',
    );
    expect(wednesday?.secretary.decisions.map((decision) => decision.signalType)).toEqual(
      expect.arrayContaining(['session_immovability', 'fueling_gap_risk', 'shoot_day_locked']),
    );
  });

  it('keeps shadowed content commitments visible when finance wins the first protected slot', async () => {
    const base = buildBaseContexts();
    base.finance.derivedSignals = [
      {
        sourceAgent: 'mesh.finance-context',
        signalType: 'tax_deadline',
        meshPriority: 1,
        priority: 'urgent',
        payload: {
          reminderDate: '2026-04-15',
          month: '2026-04',
        },
      },
    ];
    base.content.derivedSignals = [
      {
        sourceAgent: 'mesh.content-context',
        signalType: 'sponsor_deliverable_due',
        meshPriority: 1,
        priority: 'urgent',
        payload: {
          campaign: 'Spring sponsor post',
        },
      },
    ];
    mockReadFinanceMeshContext.mockResolvedValue(base.finance);
    mockReadContentMeshContext.mockResolvedValue(base.content);
    mockBuildEditorialSignals.mockReturnValue({ signals: [] });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const wednesday = result.days.find((day) => day.date === '2026-04-15');

    expect(wednesday?.finance?.taxNote).toContain('Tax deadline needs attention');
    expect(wednesday?.content?.title).toBe('Content commitment deferred');
    expect(wednesday?.content?.note).toContain('Sponsor deliverable needs a committed slot');
    expect(wednesday?.secretary.priorityNote).toContain('Finance/admin needs the first protected slot');
    expect(wednesday?.secretary.tradeoffNote).toContain('content is still a real obligation');
    expect(wednesday?.secretary.sequence).toContain('Keep the deferred content commitment visible as the next protected block once the higher-priority work is done.');
  });

  it('turns scheduled publishing into a real content execution block for secretary sequencing', async () => {
    const base = buildBaseContexts();
    base.cooking.meals = [];
    base.training.derivedSignals = [
      {
        sourceAgent: 'mesh.training-context',
        signalType: 'session_immovability',
        meshPriority: 2,
        priority: 'urgent',
        payload: {
          date: '2026-04-15',
          title: 'Track intervals',
          level: 'high',
        },
      },
    ];
    base.content.derivedSignals = [
      {
        sourceAgent: 'mesh.content-context',
        signalType: 'publishing_commitment',
        meshPriority: 2,
        priority: 'normal',
        payload: {
          upcomingTopicCount: 2,
          dates: ['2026-04-15'],
          topics: [
            { id: 21, title: 'Race-week recap', date: '2026-04-15', status: 'ready' },
          ],
          nextDate: '2026-04-15',
          nextTopicTitle: 'Race-week recap',
        },
      },
    ];
    mockReadTrainingMeshContext.mockResolvedValue(base.training);
    mockReadCookingMeshContext.mockResolvedValue(base.cooking);
    mockReadContentMeshContext.mockResolvedValue(base.content);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const wednesday = result.days.find((day) => day.date === '2026-04-15');

    expect(wednesday?.content?.title).toBe('Capture + publishing day');
    expect(wednesday?.headline).toBe('Fueling needs attention so the day can support the planned session.');
    expect(wednesday?.secretary.priorityNote).toBe('Protect Track intervals as a high-immovability training block.');
    expect(wednesday?.secretary.sequence).toEqual([
      'Protect the key training window before moving meetings, errands, or filming onto the day.',
      'Lock meal or shopping coverage before the session so training support is not left to chance.',
      'Reserve a real publish/delivery slot so content ships deliberately instead of becoming leftover work.',
      'Use the filming or sponsor block only after the publish/delivery commitment is protected.',
      'Keep the recommended focus block clean once the non-negotiables are sequenced.',
    ]);
    expect(wednesday?.secretary.tradeoffNote).toBe(
      'Training is the anchor, meals need closing before it, publishing still needs a real slot, and filming should only use whatever bandwidth remains after all three are protected.',
    );
    expect(wednesday?.secretary.decisions.map((decision) => decision.signalType)).toEqual(
      expect.arrayContaining(['session_immovability', 'fueling_gap_risk', 'publishing_commitment', 'shoot_day_locked']),
    );
  });

  it('retires superseded mesh signals so orchestration does not reason from stale copies', async () => {
    const first = buildBaseContexts();
    first.finance.derivedSignals = [
      {
        sourceAgent: 'mesh.finance-context',
        signalType: 'budget_remaining',
        meshPriority: 2,
        priority: 'urgent',
        payload: {
          month: '2026-04',
          remainingRatio: 0.22,
          budgetMode: 'controlled',
        },
      },
    ];
    mockReadFinanceMeshContext.mockResolvedValueOnce(first.finance);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    const second = buildBaseContexts();
    second.finance.derivedSignals = [
      {
        sourceAgent: 'mesh.finance-context',
        signalType: 'budget_remaining',
        meshPriority: 2,
        priority: 'urgent',
        payload: {
          month: '2026-04',
          remainingRatio: 0.08,
          budgetMode: 'tight',
        },
      },
    ];
    mockReadFinanceMeshContext.mockResolvedValueOnce(second.finance);

    const refreshed = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const activeBudgetSignals = writtenSignals.filter((signal) =>
      signal.status === 'active'
      && signal.user_id === 12
      && signal.source_agent === 'mesh.finance-context'
      && signal.signal_type === 'budget_remaining',
    );

    expect(mockDismissSignal).toHaveBeenCalledTimes(1);
    expect(activeBudgetSignals).toHaveLength(1);
    expect(activeBudgetSignals[0]?.payload).toMatchObject({
      month: '2026-04',
      remainingRatio: 0.08,
      budgetMode: 'tight',
    });
    expect(refreshed.days[0]?.finance?.budgetNote).toContain('Budget headroom is tight this week');
  });
});
