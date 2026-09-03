import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';
import { CONTENT_AGENT_LIFECYCLE_POLICY_VERSION } from '../../src/services/content-agent-lifecycle';

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
const mockGetUserTimezoneById = vi.fn(() => 'Europe/Lisbon');
const mockGetUserLanguageById = vi.fn(() => 'en');
let mockEffectivePlan: 'free' | 'pro' | 'max' | 'owner' = 'max';

let garminStatus = 'active';
let writtenSignals: Array<Record<string, unknown>> = [];
const mockReconcileGovernedSignalSet = vi.fn((input: {
  sourceAgent: string;
  userId: number;
  tenantId: number;
  keepSignalIds: readonly number[];
}) => {
  const keepSignalIds = new Set(input.keepSignalIds);
  let changes = 0;
  writtenSignals = writtenSignals.map((signal) => {
    if (signal.status === 'active'
      && signal.source_agent === input.sourceAgent
      && signal.user_id === input.userId
      && signal.tenant_id === input.tenantId
      && !keepSignalIds.has(Number(signal.id))) {
      changes += 1;
      return { ...signal, status: 'dismissed' };
    }
    return signal;
  });
  return changes;
});

vi.mock('../../src/config', () => ({
  config: {
    app: { timezone: 'Europe/Lisbon' },
  },
}));

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
  canConsumeConfirmedContentWorkSchedule: (schedule: {
    authority?: string;
    authorityStatus?: string;
    planStatus?: string;
    semantics?: string;
  } | null | undefined) => Boolean(
    schedule
    && schedule.authority === 'secretary'
    && (schedule.authorityStatus === 'current' || schedule.authorityStatus === 'partially_unavailable')
    && (schedule.planStatus === 'confirmed' || schedule.planStatus === 'partial')
    && schedule.semantics === 'private_work_session'
  ),
  createEmptyTrainingMeshContext: (userId: number, weekStart: string) => ({
    userId,
    weekStart,
    weekEnd: weekStart,
    activePlan: null,
    activeWeek: null,
    sessions: [],
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
        highAdherence: false,
        planDrift: false,
        otherSportRpeToday: 0,
      },
    },
    coachBriefing: null,
    adherence: null,
    derivedSignals: [],
  }),
  createEmptySecretaryMeshContext: (userId: number, weekStart: string) => ({
    userId,
    weekStart,
    weekEnd: weekStart,
    events: [],
    focusBlock: null,
    dueToday: [],
    dueThisWeek: [],
    overdue: [],
    pending: [],
    writableCalendar: false,
    derivedSignals: [],
  }),
}));

vi.mock('../../src/agents/editorial-coordinator-agent', () => ({
  buildEditorialCoordinationSignals: (...args: unknown[]) => mockBuildEditorialSignals(...args),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  isUserOverDailyCap: (...args: unknown[]) => mockIsUserOverDailyCap(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
  getUserTimezoneById: (...args: unknown[]) => mockGetUserTimezoneById(...args),
  getUserLanguageById: (...args: unknown[]) => mockGetUserLanguageById(...args),
}));

vi.mock('../../src/services/entitlement', () => ({
  getEffectiveEntitlement: vi.fn(() => ({ plan: mockEffectivePlan })),
  entitlementPlanToSkillTier: vi.fn((plan: string) => plan),
}));

vi.mock('../../src/services/skill-tiers', () => ({
  checkSkillAccess: vi.fn((user: { tier: string } | null, skill: string) => ({
    allowed: Boolean(user) && (user!.tier !== 'free' || skill === 'secretary'),
  })),
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
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  applyMigrationFileForTest: vi.fn(),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/intelligence-bus', () => ({
  runSignalWriteTransaction: (operation: () => unknown) => operation(),
  reconcileGovernedSignalSet: (...args: unknown[]) => mockReconcileGovernedSignalSet(
    args[0] as Parameters<typeof mockReconcileGovernedSignalSet>[0],
  ),
  readSignals: (_consumer: string, signalTypes: string[], limit: number, userId?: number, _maxAgeDays?: number, tenantId?: number) =>
    writtenSignals
      .filter((signal) =>
        signal.status === 'active'
        && signal.user_id === userId
        && (tenantId === undefined || signal.tenant_id === tenantId)
        && signalTypes.includes(String(signal.signal_type)))
      .slice(0, limit)
      .map((signal) => ({ ...signal })),
  writeGovernedSignal: (signal: Record<string, unknown>) => {
    const persist = (id: number) => writtenSignals.push({
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
    const id = writtenSignals.length + 1;
    persist(id);
    return id;
  },
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
  LOGGER_REDACTION_PATHS: [],
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
      sourceHealth: { status: 'ready', warningCodes: [], warnings: [] },
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
      sourceHealth: {
        calendar: { status: 'ready', warningCodes: [], warnings: [] },
        tasks: { status: 'ready', warningCodes: [], warnings: [] },
        mail: { status: 'ready', warningCodes: [], warnings: [] },
        focus: { status: 'ready', warningCodes: [], warnings: [] },
      },
    },
    cooking: {
      userId: 12,
      timezone: 'Europe/Lisbon',
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
      sourceHealth: {
        mealPlan: { status: 'ready', warningCodes: [] },
        shoppingList: { status: 'ready', warningCodes: [] },
        recipes: { status: 'ready', warningCodes: [] },
        focus: { status: 'ready', warningCodes: [] },
        safety: {
          status: 'ready',
          warningCodes: [],
          excludedMealCount: 0,
          excludedMealDates: [],
        },
      },
      availability: {
        busyDates: [],
        fragmentedDates: [],
        travelDates: [],
        focusDate: '2026-04-15',
      },
      calendar: {
        status: 'ready',
        warningCodes: [],
      },
      derivedSignals: [],
    },
    content: {
      userId: 12,
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      availability: 'available',
      unavailableSections: [],
      upcomingTopicCount: 2,
      deadlines: [],
      workSchedule: {
        authority: 'secretary',
        authorityStatus: 'current',
        planStatus: 'confirmed',
        semantics: 'private_work_session',
        confirmedBlocksComplete: true,
        confirmedBlocks: [
          {
            itemId: 41,
            title: 'Record the weekly piece',
            itemStatus: 'approved',
            outcome: 'Planned outcome: complete a recording session for "Record the weekly piece".',
            estimatedEffortMinutes: 120,
            dependency: null,
            approvalState: 'approved',
            nextAction: {
              action: 'prepare_scheduled_work',
              label: 'Prepare the confirmed recording block',
              reason: 'The item is approved and scheduled.',
            },
            date: '2026-04-15',
            startsAt: '2026-04-15T11:00:00.000Z',
            endsAt: '2026-04-15T13:00:00.000Z',
            workKind: 'record',
            state: 'provider_synced',
            authority: 'secretary',
            authorityStatus: 'current',
            semantics: 'private_work_session',
            contentChangedSinceScheduling: false,
          },
        ],
        attentionCount: 0,
      },
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
      sourceHealth: { status: 'ready', warningCodes: [], warnings: [] },
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
      budgetView: {
        month: '2026-04',
        basisCurrency: 'EUR',
        currencies: ['EUR'],
        integrity: 'reliable',
        affordability: 'comfortable',
        incomeInBasisCurrency: 1000,
        expensesInBasisCurrency: 600,
        currentRemainingInBasisCurrency: 400,
        currentRemainingRatio: 0.4,
        projectedExpensesInBasisCurrency: 600,
        projectedRemainingInBasisCurrency: 400,
        projectedRemainingRatio: 0.4,
        recurringExpenseEstimate: 0,
        recurringExpenseCount: 0,
        recurringExpenses: [],
        notes: [],
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
      sourceHealth: { status: 'ready', warningCodes: [], warnings: [] },
    },
  };
}

describe('weekly-plan-orchestrator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T08:00:00.000Z'));
    clearTenantScopeAnomaliesForTests();
    writtenSignals = [];
    mockReconcileGovernedSignalSet.mockClear();
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
    mockGetUserTimezoneById.mockReset();
    mockGetUserTimezoneById.mockReturnValue('Europe/Lisbon');

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
            itemId: 41,
            title: 'Record the weekly piece',
            date: '2026-04-15',
            blockStart: '2026-04-15T11:00:00.000Z',
            blockEnd: '2026-04-15T13:00:00.000Z',
            workKind: 'filming',
            sourceWorkKind: 'record',
            sourceState: 'provider_synced',
            providerAttention: false,
            planStatus: 'confirmed',
            scheduleAuthority: 'secretary',
            scheduleAuthorityStatus: 'current',
            semantics: 'private_work_session',
          },
        },
      ],
    });
    mockIsUserOverDailyCap.mockReturnValue({ over: false });
    mockGetUserById.mockReturnValue({ id: 12, tier: 'max', language: 'en-US', timezone: 'Europe/Lisbon' });
    mockEffectivePlan = 'max';
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
    mockEffectivePlan = 'free';

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
    await expect(composeWeeklyPlan({ userId: 0, weekStart: '2026-04-13', forceRefresh: true }))
      .rejects.toMatchObject({ code: 'INVALID_SCOPE' });
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

  it('rejects a supplied tenant mismatch before user or mesh reads', async () => {
    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    await expect(composeWeeklyPlan({
      userId: 12,
      tenantId: 34,
      weekStart: '2026-04-13',
      forceRefresh: true,
    })).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISMATCH' });

    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockReadSecretaryMeshContext).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()[0]).toMatchObject({
      operation: 'compose_weekly_plan_tenant_scope',
      reason: 'tenant_mismatch',
      userId: 12,
    });
  });

  it('passes one canonical user timezone to aggregate mesh projections', async () => {
    mockGetUserById.mockReturnValue({
      id: 12,
      tier: 'max',
      language: 'en-US',
      timezone: 'America/New_York',
    });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    await composeWeeklyPlan({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-11-02',
      forceRefresh: true,
    });

    for (const reader of [
      mockReadSecretaryMeshContext,
      mockReadCookingMeshContext,
      mockReadContentMeshContext,
      mockReadFinanceMeshContext,
    ]) {
      expect(reader).toHaveBeenCalledWith(expect.objectContaining({
        userId: 12,
        tenantId: 12,
        weekStart: '2026-11-02',
        timezone: 'America/New_York',
      }));
    }
  });
  it('does not persist or dismiss mesh signals in read-only weekly plan mode', async () => {
    const base = buildBaseContexts();
    base.finance.derivedSignals = [
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
    mockReadFinanceMeshContext.mockResolvedValueOnce(base.finance);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.days.length).toBeGreaterThan(0);
    expect(writtenSignals).toHaveLength(0);
    expect(mockReconcileGovernedSignalSet).not.toHaveBeenCalled();
  });

  it('keeps historical recompute signals in memory without publishing expired drafts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-27T12:00:00.000Z'));
    const base = buildBaseContexts();
    base.finance.derivedSignals = [{
      sourceAgent: 'mesh.finance-context',
      signalType: 'budget_remaining',
      meshPriority: 2,
      priority: 'urgent',
      expiresAt: '2026-04-19T22:59:59.999Z',
      payload: {
        month: '2026-04',
        remainingRatio: 0.2,
        budgetMode: 'controlled',
      },
    }];
    mockReadFinanceMeshContext.mockResolvedValueOnce(base.finance);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-13',
      forceRefresh: true,
      syncSignals: true,
    });

    expect(result.degraded).toBe(false);
    expect(writtenSignals).toHaveLength(0);
    expect(mockReconcileGovernedSignalSet).not.toHaveBeenCalled();
    expect(result.days[0]?.finance?.budgetNote).toContain('controlled');
  });

  it('uses tenant scope for synced mesh signals', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T08:00:00.000Z'));
    const base = buildBaseContexts();
    base.finance.derivedSignals = [
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
    mockReadFinanceMeshContext.mockResolvedValueOnce(base.finance);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    await composeWeeklyPlan({ userId: 12, tenantId: 12, weekStart: '2026-04-13', forceRefresh: true, syncSignals: true });

    expect(writtenSignals.length).toBeGreaterThan(0);
    expect(writtenSignals.every((signal) => signal.user_id === 12 && signal.tenant_id === 12)).toBe(true);
    expect(mockSetCache).toHaveBeenCalledWith(expect.stringContaining('plan:week:u:12:t:12:'), expect.anything(), 1800);
    expect(mockSetCache).toHaveBeenCalledWith(
      expect.stringContaining(`:content-policy:${CONTENT_AGENT_LIFECYCLE_POLICY_VERSION}`),
      expect.anything(),
      1800,
    );
  });

  it('keeps the weekly plan available but fails paid skill context closed when the user record is missing', async () => {
    mockGetUserById.mockReturnValue(null);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.gated.skills).toEqual(['cooking', 'content', 'finance']);
    expect(result.days).toHaveLength(7);
    expect(result.summary.sessionCount).toBeGreaterThanOrEqual(1);
  });

  it('ignores a stale paid users.tier when canonical entitlement is Free', async () => {
    mockGetUserById.mockReturnValue({ id: 12, tier: 'max' });
    mockEffectivePlan = 'free';

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.gated.skills).toEqual(['cooking', 'content', 'finance']);
  });

  it('blanks only creative copy without degrading deterministic planning when the user is over cap', async () => {
    mockIsUserOverDailyCap.mockReturnValue({ over: true });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(false);
    expect(result.creativeCopy).toEqual({ headline: '', note: '' });
    expect(result.warningCodes).toContain('AI_COPY_QUOTA_REACHED');
  });

  it('degrades safely when a mesh context reader fails instead of crashing the whole weekly plan', async () => {
    mockReadTrainingMeshContext.mockRejectedValueOnce(new Error('training mesh failed'));

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(true);
    expect(result.days).toHaveLength(7);
    expect(result.summary.activeConflictCount).toBeGreaterThanOrEqual(0);
    expect(result.days.some((day) => day.secretary.focusBlock != null)).toBe(true);
    const trainingDay = result.days.find((day) => day.date === '2026-04-15');
    expect(trainingDay?.training.decisions).toEqual([]);
    expect(trainingDay?.training.reason.length ?? 0).toBeGreaterThan(0);
  });

  it('preserves explicit projection read health instead of treating fallback data as ready', async () => {
    const base = buildBaseContexts();
    (base.training as any).sourceHealth = {
      status: 'degraded',
      warningCodes: ['TRAINING_STATE_DEGRADED'],
      warnings: ['Some Training planning state is unavailable.'],
    };
    (base.cooking as any).sourceHealth = {
      status: 'unavailable',
      warningCodes: ['COOKING_STATE_UNAVAILABLE'],
      warnings: ['Cooking planning state is unavailable.'],
    };
    (base.content as any).sourceHealth = {
      status: 'degraded',
      warningCodes: ['CONTENT_STATE_DEGRADED'],
      warnings: ['Some Content planning state is unavailable.'],
    };
    (base.finance as any).sourceHealth = {
      status: 'degraded',
      warningCodes: ['FINANCE_STATE_DEGRADED'],
      warnings: ['Some Finance planning state is unavailable.'],
    };
    mockReadTrainingMeshContext.mockResolvedValueOnce(base.training);
    mockReadCookingMeshContext.mockResolvedValueOnce(base.cooking);
    mockReadContentMeshContext.mockResolvedValueOnce(base.content);
    mockReadFinanceMeshContext.mockResolvedValueOnce(base.finance);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(true);
    expect(result.sourceHealth.training.status).toBe('degraded');
    expect(result.sourceHealth.cooking.status).toBe('unavailable');
    expect(result.sourceHealth.content.status).toBe('degraded');
    expect(result.sourceHealth.finance.status).toBe('degraded');
    expect(result.warningCodes).toEqual(expect.arrayContaining([
      'TRAINING_STATE_DEGRADED',
      'COOKING_STATE_UNAVAILABLE',
      'CONTENT_STATE_DEGRADED',
      'FINANCE_STATE_DEGRADED',
    ]));
    expect(result.creativeCopy.headline).toContain('confirmed commitments');
    expect(result.creativeCopy.note).not.toContain('align cleanly');
    expect(result.creativeCopy.note).not.toContain('constraints in mind');
  });

  it('normalizes Cooking per-source health without discarding sibling safety evidence', async () => {
    const base = buildBaseContexts();
    (base.cooking as any).sourceHealth = {
      mealPlan: { status: 'ready', warningCodes: [] },
      shoppingList: { status: 'ready', warningCodes: [] },
      recipes: { status: 'degraded', warningCodes: ['COOKING_RECIPE_READ_FAILED'] },
      focus: { status: 'ready', warningCodes: [] },
      safety: {
        status: 'ready',
        warningCodes: [],
        excludedMealCount: 0,
        excludedMealDates: [],
      },
    };
    (base.cooking as any).calendar = { status: 'ready', warningCodes: [] };
    mockReadCookingMeshContext.mockResolvedValueOnce(base.cooking);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(true);
    expect(result.sourceHealth.cooking).toMatchObject({
      status: 'degraded',
      warningCodes: ['COOKING_RECIPE_READ_FAILED'],
    });
  });

  it('does not claim calendar alignment when calendar source health is unavailable', async () => {
    const base = buildBaseContexts();
    base.secretary.sourceHealth.calendar = {
      status: 'unavailable',
      warningCodes: ['CALENDAR_STATE_UNAVAILABLE'],
      warnings: ['Calendar planning state is unavailable.'],
    };
    mockReadSecretaryMeshContext.mockResolvedValueOnce(base.secretary);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const renderedCopy = JSON.stringify({
      creativeCopy: result.creativeCopy,
      headlines: result.days.map((day) => day.headline),
    });

    expect(result.degraded).toBe(true);
    expect(result.sourceHealth.calendar.status).toBe('unavailable');
    expect(renderedCopy).not.toContain('calendar line up');
    expect(renderedCopy).not.toContain('align cleanly');
    expect(result.creativeCopy.note).toContain('not treated as clear');
  });

  it('fails sibling projections closed when their source-health contract is absent', async () => {
    const base = buildBaseContexts();
    delete (base.training as any).sourceHealth;
    delete (base.cooking as any).sourceHealth;
    delete (base.content as any).sourceHealth;
    delete (base.finance as any).sourceHealth;
    mockReadTrainingMeshContext.mockResolvedValueOnce(base.training);
    mockReadCookingMeshContext.mockResolvedValueOnce(base.cooking);
    mockReadContentMeshContext.mockResolvedValueOnce(base.content);
    mockReadFinanceMeshContext.mockResolvedValueOnce(base.finance);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(true);
    expect(result.sourceHealth.training).toEqual(expect.objectContaining({
      status: 'unavailable',
      warningCodes: ['TRAINING_STATE_UNKNOWN'],
    }));
    expect(result.sourceHealth.cooking.warningCodes).toEqual(['COOKING_STATE_UNKNOWN']);
    expect(result.sourceHealth.content.warningCodes).toEqual(['CONTENT_STATE_UNKNOWN']);
    expect(result.sourceHealth.finance.warningCodes).toEqual(['FINANCE_STATE_UNKNOWN']);
  });

  it('counts unsynced local agenda commitments without exposing ledger identity', async () => {
    const base = buildBaseContexts();
    base.secretary.events = [];
    (base.secretary as any).localAgendaItems = [{
      title: 'Client preparation block',
      startAt: '2026-04-15T09:00:00.000Z',
      endAt: '2026-04-15T10:00:00.000Z',
      providerEventId: null,
      providerSource: null,
    }];
    mockReadSecretaryMeshContext.mockResolvedValueOnce(base.secretary);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const day = result.days.find((entry) => entry.date === '2026-04-15');

    expect(day?.secretary.calendarEventCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('agendaItemId');
  });

  it('fails legacy cached plans closed when source-health metadata is absent', async () => {
    mockGetCached.mockReturnValueOnce({
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      generatedAt: '2026-04-13T07:00:00.000Z',
      variant: 'steady',
      degraded: false,
      gated: { skills: [] },
      garmin_stale: false,
      conflicts: [],
      creativeCopy: { headline: '', note: '' },
      summary: { sessionCount: 0, mealCount: 0, activeConflictCount: 0 },
      days: [],
    });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13' });

    expect(result.timezone).toBe('Europe/Lisbon');
    expect(result.degraded).toBe(true);
    expect(result.warningCodes).toContain('PLANNING_SOURCE_HEALTH_UNAVAILABLE');
    expect(result.sourceHealth.calendar.status).toBe('unavailable');
    expect(mockReadSecretaryMeshContext).not.toHaveBeenCalled();
  });

  it('separates internal cache identity by language and timezone', async () => {
    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', language: 'en-US' });
    mockGetUserById.mockReturnValueOnce({ id: 12, tier: 'max', language: 'pt-PT', timezone: 'America/New_York' });
    await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', language: 'pt-PT' });

    expect(mockGetCached).toHaveBeenCalledWith(expect.stringContaining(':tz:Europe/Lisbon:lang:en-US:'));
    expect(mockGetCached).toHaveBeenCalledWith(expect.stringContaining(':tz:America/New_York:lang:pt-PT:'));
  });

  it('keeps English, PT-BR, PT-PT, and adjacent week cache identities distinct', async () => {
    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', language: 'en-US' });
    await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', language: 'pt-BR' });
    await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', language: 'pt-PT' });
    await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-20', language: 'en-US' });

    const keys = mockGetCached.mock.calls.map(([key]) => String(key));
    expect(keys).toEqual(expect.arrayContaining([
      expect.stringContaining(':t:12:2026-04-13:tz:Europe/Lisbon:lang:en-US:'),
      expect.stringContaining(':t:12:2026-04-13:tz:Europe/Lisbon:lang:pt-BR:'),
      expect.stringContaining(':t:12:2026-04-13:tz:Europe/Lisbon:lang:pt-PT:'),
      expect.stringContaining(':t:12:2026-04-20:tz:Europe/Lisbon:lang:en-US:'),
    ]));
    expect(new Set(keys).size).toBe(4);
  });

  it('marks partial Content input as degraded and suppresses editorial recommendations from fallback empties', async () => {
    const contexts = buildBaseContexts();
    mockReadContentMeshContext.mockResolvedValueOnce({
      ...contexts.content,
      availability: 'partial',
      unavailableSections: ['content_desk', 'topics', 'next_execution'],
      deskItems: [],
      nextExecution: null,
    });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(true);
    expect(mockBuildEditorialSignals).not.toHaveBeenCalled();
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

  it('distinguishes ready Cooking days from verified empty Cooking days', async () => {
    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.days.find((day) => day.date === '2026-04-15')?.cooking).toEqual({
      status: 'ready',
      headline: '1 meal planned for this day.',
      warningCodes: [],
    });
    expect(result.days.find((day) => day.date === '2026-04-16')?.cooking).toEqual({
      status: 'empty',
      headline: 'No meals planned for this day.',
      warningCodes: [],
    });
  });

  it('marks a day degraded when current safety preferences withhold a saved meal', async () => {
    const base = buildBaseContexts();
    base.cooking.sourceHealth.safety = {
      status: 'degraded',
      warningCodes: [
        'COOKING_SAVED_MEAL_SAFETY_WITHHELD',
        'COOKING_SAVED_MEAL_ALLERGY_CONFLICT',
      ],
      excludedMealCount: 1,
      excludedMealDates: ['2026-04-15'],
    };
    mockReadCookingMeshContext.mockResolvedValueOnce(base.cooking);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(true);
    expect(result.days.find((day) => day.date === '2026-04-15')?.cooking).toEqual({
      status: 'degraded',
      headline: '1 verified-safe planned meal shown; 1 saved meal withheld because of current safety-preference conflicts.',
      warningCodes: [
        'COOKING_SAVED_MEAL_SAFETY_WITHHELD',
        'COOKING_SAVED_MEAL_ALLERGY_CONFLICT',
      ],
    });
  });

  it('marks Cooking unavailable when persisted meals cannot be checked against current safety preferences', async () => {
    const base = buildBaseContexts();
    base.cooking.meals = [];
    base.cooking.sourceHealth.safety = {
      status: 'unavailable',
      warningCodes: ['COOKING_SAFETY_PROFILE_UNAVAILABLE'],
      excludedMealCount: 1,
      excludedMealDates: ['2026-04-15'],
    };
    mockReadCookingMeshContext.mockResolvedValueOnce(base.cooking);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(true);
    expect(result.days.find((day) => day.date === '2026-04-15')?.cooking).toEqual({
      status: 'unavailable',
      headline: 'Cooking safety preferences are unavailable for this day; saved meals are withheld rather than assumed safe.',
      warningCodes: ['COOKING_SAFETY_PROFILE_UNAVAILABLE'],
    });
  });

  it('pins plan age and session dates to the persisted plan timezone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T00:30:00.000Z'));
    const base = buildBaseContexts();
    mockReadTrainingMeshContext.mockResolvedValueOnce({
      ...base.training,
      activePlan: {
        ...base.training.activePlan,
        start_date: '2026-03-30',
        preferences_json: JSON.stringify({ schedulingTimezone: 'America/Los_Angeles' }),
      },
      sessions: [{
        ...base.training.sessions[0],
        day_of_week: 'Sunday',
        title: 'Persisted-zone Sunday run',
      }],
    });

    // Lisbon has reached day 14 (push-eligible), while Los Angeles is still
    // on plan day 13. The immutable plan clock must keep the week conservative.
    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.variant).toBe('conservative');
    expect(result.days.find((day) => day.date === '2026-04-19')?.training.title)
      .toBe('Persisted-zone Sunday run');
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

  it('places the batch-cook day around a current sync-failed Content block, not unconfirmed filming recommendations', async () => {
    const base = buildBaseContexts();
    base.content.workSchedule.confirmedBlocks[0].state = 'sync_failed';
    base.content.workSchedule.attentionCount = 1;
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
    base.cooking.availability = {
      travelDates: ['2026-04-13'],
      busyDates: ['2026-04-14'],
      fragmentedDates: [],
      focusDate: '2026-04-17',
    };
    base.cooking.derivedSignals = [{
      sourceAgent: 'mesh.cooking-context',
      signalType: 'meal_execution_readiness',
      meshPriority: 2,
      priority: 'urgent',
      payload: {
        status: 'partial',
        prepPressureDates: ['2026-04-17'],
        highEffortMealCount: 1,
        totalPrepMinutes: 45,
        totalCookMinutes: 90,
        shoppingReady: false,
      },
    }];
    base.content.filmingRecommendation = {
      ...base.content.filmingRecommendation,
      date: '2026-04-18',
      blockStart: '2026-04-18T11:00:00.000Z',
      blockEnd: '2026-04-18T13:00:00.000Z',
    };
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

  it('uses the highest training load when multiple sessions share a batch-cook date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T08:00:00.000Z'));
    const base = buildBaseContexts();
    base.training.sessions = [
      {
        ...base.training.sessions[0],
        id: 102,
        day_of_week: 'Monday',
        title: 'Threshold intervals',
        intensity_text: 'Hard',
      },
      {
        ...base.training.sessions[0],
        id: 103,
        day_of_week: 'Monday',
        title: 'Recovery jog',
        intensity_text: 'Easy',
      },
    ];
    base.cooking.meals = [
      ...base.cooking.meals,
      { ...base.cooking.meals[0], id: 2, date: '2026-04-16', title: 'Second prep meal' },
      { ...base.cooking.meals[0], id: 3, date: '2026-04-17', title: 'Third prep meal' },
    ];
    base.cooking.availability = {
      travelDates: ['2026-04-15', '2026-04-16', '2026-04-17', '2026-04-18', '2026-04-19'],
      busyDates: ['2026-04-14'],
      fragmentedDates: [],
      focusDate: null,
    };
    base.cooking.derivedSignals = [{
      sourceAgent: 'mesh.cooking-context',
      signalType: 'meal_execution_readiness',
      meshPriority: 2,
      priority: 'urgent',
      payload: {
        status: 'partial',
        prepPressureDates: ['2026-04-17'],
        highEffortMealCount: 1,
        totalPrepMinutes: 45,
        totalCookMinutes: 90,
        shoppingReady: false,
      },
    }];
    base.content.filmingRecommendation = null;
    mockReadTrainingMeshContext.mockResolvedValueOnce(base.training);
    mockReadCookingMeshContext.mockResolvedValueOnce(base.cooking);
    mockReadContentMeshContext.mockResolvedValueOnce(base.content);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const batchDay = result.days.find((day) => day.meals.some((meal) => meal.title === 'Batch-cook window'));

    expect(batchDay?.date).toBe('2026-04-14');
  });

  it('never places a current-week batch-cook window on a past local date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T08:00:00.000Z'));
    const base = buildBaseContexts();
    base.cooking.meals = [
      ...base.cooking.meals,
      { ...base.cooking.meals[0], id: 2, date: '2026-04-16', title: 'Second prep meal' },
      { ...base.cooking.meals[0], id: 3, date: '2026-04-17', title: 'Third prep meal' },
    ];
    base.cooking.derivedSignals = [{
      sourceAgent: 'mesh.cooking-context',
      signalType: 'meal_execution_readiness',
      meshPriority: 2,
      priority: 'urgent',
      payload: {
        status: 'partial',
        prepPressureDates: ['2026-04-17'],
        highEffortMealCount: 1,
        totalPrepMinutes: 45,
        totalCookMinutes: 90,
        shoppingReady: false,
      },
    }];
    mockReadCookingMeshContext.mockResolvedValueOnce(base.cooking);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const batchDay = result.days.find((day) => day.meals.some((meal) => meal.title === 'Batch-cook window'));

    expect(batchDay?.date).toBeDefined();
    expect(batchDay!.date >= '2026-04-17').toBe(true);
  });

  it('degrades the week and suppresses batch-cook guidance when Cooking calendar evidence is unavailable', async () => {
    const base = buildBaseContexts();
    base.cooking.meals = [];
    base.cooking.calendar = {
      status: 'unavailable',
      warningCodes: ['COOKING_CALENDAR_READ_FAILED'],
    };
    base.cooking.derivedSignals = [{
      sourceAgent: 'mesh.cooking-context',
      signalType: 'meal_execution_readiness',
      meshPriority: 2,
      priority: 'urgent',
      payload: { status: 'at_risk', prepPressureDates: [] },
    }];
    mockReadCookingMeshContext.mockResolvedValueOnce(base.cooking);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(true);
    expect(result.days[0]?.cooking).toMatchObject({ status: 'degraded' });
    expect(result.days.flatMap((day) => day.meals).some((meal) => meal.title === 'Batch-cook window')).toBe(false);
  });

  it('keeps an unconfigured optional calendar healthy and still emits verified batch-cook guidance', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-14T08:00:00.000Z'));
    const base = buildBaseContexts();
    base.cooking.calendar = {
      status: 'not_configured',
      warningCodes: [],
    };
    base.cooking.derivedSignals = [{
      sourceAgent: 'mesh.cooking-context',
      signalType: 'meal_execution_readiness',
      meshPriority: 2,
      priority: 'urgent',
      payload: {
        status: 'partial',
        prepPressureDates: [],
        highEffortMealCount: 1,
        totalPrepMinutes: 45,
        totalCookMinutes: 60,
        shoppingReady: false,
      },
    }];
    mockReadCookingMeshContext.mockResolvedValueOnce(base.cooking);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(false);
    expect(result.days.find((day) => day.date === '2026-04-15')?.cooking).toMatchObject({ status: 'ready' });
    expect(result.days.flatMap((day) => day.meals).some((meal) => meal.title === 'Batch-cook window')).toBe(true);
  });

  it('marks Cooking unavailable instead of presenting a failed meal-plan read as empty', async () => {
    const base = buildBaseContexts();
    base.cooking.meals = [];
    base.cooking.sourceHealth.mealPlan = {
      status: 'unavailable',
      warningCodes: ['COOKING_MEAL_PLAN_READ_FAILED'],
    };
    mockReadCookingMeshContext.mockResolvedValueOnce(base.cooking);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(true);
    expect(result.days[0]?.meals).toEqual([]);
    expect(result.days[0]?.cooking).toEqual({
      status: 'unavailable',
      headline: 'Meal-plan data is unavailable for this day; an empty result is not assumed.',
      warningCodes: ['COOKING_MEAL_PLAN_READ_FAILED'],
    });
  });

  it('does not create a batch-cook window without real prep work', async () => {
    const base = buildBaseContexts();
    base.cooking.meals = [];
    base.cooking.derivedSignals = [{
      sourceAgent: 'mesh.cooking-context',
      signalType: 'meal_execution_readiness',
      meshPriority: 2,
      priority: 'urgent',
      payload: {
        status: 'at_risk',
        prepPressureDates: [],
        highEffortMealCount: 0,
        totalPrepMinutes: 0,
        totalCookMinutes: 0,
        shoppingReady: false,
      },
    }];
    mockReadCookingMeshContext.mockResolvedValueOnce(base.cooking);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.days.flatMap((day) => day.meals).some((meal) => meal.title === 'Batch-cook window')).toBe(false);
  });

  it('does not treat failed Secretary focus availability as a free batch-cook week', async () => {
    const base = buildBaseContexts();
    base.cooking.sourceHealth.focus = {
      status: 'unavailable',
      warningCodes: ['COOKING_FOCUS_READ_FAILED'],
    };
    base.cooking.meals = [
      ...base.cooking.meals,
      { ...base.cooking.meals[0], id: 2, date: '2026-04-16' },
      { ...base.cooking.meals[0], id: 3, date: '2026-04-17' },
    ];
    base.cooking.derivedSignals = [{
      sourceAgent: 'mesh.cooking-context',
      signalType: 'meal_execution_readiness',
      meshPriority: 2,
      priority: 'urgent',
      payload: {
        status: 'at_risk',
        prepPressureDates: ['2026-04-17'],
        highEffortMealCount: 1,
        totalPrepMinutes: 45,
        totalCookMinutes: 90,
        shoppingReady: false,
      },
    }];
    mockReadCookingMeshContext.mockResolvedValueOnce(base.cooking);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(true);
    expect(result.days.flatMap((day) => day.meals).some((meal) => meal.title === 'Batch-cook window')).toBe(false);
  });

  it('propagates one timezone and captured clock to Content and Finance planning reads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T00:30:00.000Z'));
    mockGetUserById.mockReturnValue({
      id: 12,
      tier: 'max',
      language: 'en-US',
      timezone: 'Pacific/Honolulu',
    });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, forceRefresh: true });

    expect(result.weekStart).toBe('2026-04-06');
    expect(mockReadCookingMeshContext).toHaveBeenCalledWith({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-06',
      timezone: 'Pacific/Honolulu',
    });
    expect(mockReadContentMeshContext).toHaveBeenCalledWith({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-06',
      timezone: 'Pacific/Honolulu',
      referenceNow: '2026-04-13T00:30:00.000Z',
    });
    expect(mockReadFinanceMeshContext).toHaveBeenCalledWith({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-06',
      timezone: 'Pacific/Honolulu',
      referenceNow: '2026-04-13T00:30:00.000Z',
    });
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
      'Honor the Secretary-confirmed private Content block; it reserves work time but does not imply publication.',
      'Keep the recommended focus block clean once the non-negotiables are sequenced.',
    ]);
    expect(wednesday?.secretary.tradeoffNote).toBe(
      'Training, meal coverage, and the Secretary-confirmed private Content block all need to remain visible; ask Secretary to reconcile any overlap.',
    );
    expect(wednesday?.secretary.decisions.map((decision) => decision.signalType)).toEqual(
      expect.arrayContaining(['session_immovability', 'fueling_gap_risk', 'shoot_day_locked']),
    );
  });

  it('keeps a Secretary-confirmed private Content block visible when finance conflicts and ignores sponsor commitment invention', async () => {
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

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const wednesday = result.days.find((day) => day.date === '2026-04-15');

    expect(wednesday?.finance?.taxNote).toContain('Tax deadline needs attention');
    expect(wednesday?.content?.title).toBe('Confirmed Content block needs review');
    expect(wednesday?.content?.status).toBe('scheduled');
    expect(wednesday?.content?.scheduleAuthorityStatus).toBe('current');
    expect(wednesday?.content?.scheduleSemantics).toBe('private_work_session');
    expect(wednesday?.content?.note).toContain('Secretary-confirmed private filming block');
    expect(wednesday?.content?.note).not.toContain('Sponsor deliverable needs a committed slot');
    expect(wednesday?.secretary.priorityNote).toContain('Secretary-confirmed Content block conflict');
    expect(wednesday?.secretary.tradeoffNote).toContain('ask Secretary to reconcile');
    expect(wednesday?.secretary.sequence).toContain('Keep the conflicting Secretary-confirmed Content block visible and ask Secretary to reconcile it; do not assume it moved.');
  });

  it('keeps a Content deadline advisory and ignores legacy publishing signals while preserving a confirmed private block', async () => {
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
    base.content.deadlines = [
      {
        itemId: 21,
        title: 'Race-week recap',
        date: '2026-04-15',
        deadlineAt: '2026-04-15T17:00:00.000Z',
        status: 'ready',
        semantics: 'target_date_not_publication',
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

    expect(wednesday?.content?.title).toBe('Confirmed Content work block');
    expect(wednesday?.content?.status).toBe('scheduled');
    expect(wednesday?.content?.planStatus).toBe('confirmed');
    expect(wednesday?.content?.note).toContain('advisory target date');
    expect(wednesday?.content?.note).not.toContain('publishing handoff');
    expect(result.contentPlan).toMatchObject({
      authority: 'secretary',
      planStatus: 'confirmed',
      confirmedBlockCount: 1,
      deadlineCount: 1,
    });
    expect(wednesday?.headline).toBe('Fueling needs attention so the day can support the planned session.');
    expect(wednesday?.secretary.priorityNote).toBe('Protect Track intervals as a high-immovability training block.');
    expect(wednesday?.secretary.sequence).toEqual([
      'Protect the key training window before moving meetings, errands, or filming onto the day.',
      'Lock meal or shopping coverage before the session so training support is not left to chance.',
      'Honor the Secretary-confirmed private Content block; it reserves work time but does not imply publication.',
      'Keep the recommended focus block clean once the non-negotiables are sequenced.',
    ]);
    expect(wednesday?.secretary.tradeoffNote).toBe(
      'Training, meal coverage, and the Secretary-confirmed private Content block all need to remain visible; ask Secretary to reconcile any overlap.',
    );
    expect(wednesday?.secretary.decisions.map((decision) => decision.signalType)).toEqual(
      expect.arrayContaining(['session_immovability', 'fueling_gap_risk', 'shoot_day_locked']),
    );
    expect(wednesday?.secretary.decisions.map((decision) => decision.signalType)).not.toContain('publishing_commitment');
  });

  it('preserves every same-day Secretary-confirmed private Content block in chronological order', async () => {
    const base = buildBaseContexts();
    base.content.workSchedule.confirmedBlocks.push({
      itemId: 42,
      title: 'Edit the weekly piece',
      date: '2026-04-15',
      startsAt: '2026-04-15T14:00:00.000Z',
      endsAt: '2026-04-15T15:30:00.000Z',
      workKind: 'edit',
      state: 'scheduled',
      authority: 'secretary',
      authorityStatus: 'current',
      semantics: 'private_work_session',
      contentChangedSinceScheduling: true,
    });
    mockReadContentMeshContext.mockResolvedValue(base.content);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const wednesday = result.days.find((day) => day.date === '2026-04-15');

    expect(wednesday?.content?.blockStart).toBe('2026-04-15T11:00:00.000Z');
    expect(wednesday?.content?.confirmedBlocks).toEqual([
      expect.objectContaining({
        itemId: 41,
        workKind: 'record',
        authorityStatus: 'current',
        confirmationStatus: 'confirmed',
        itemStatus: 'approved',
        outcome: 'Planned outcome: complete a recording session for "Record the weekly piece".',
        estimatedEffortMinutes: 120,
        approvalState: 'approved',
      }),
      expect.objectContaining({
        itemId: 42,
        workKind: 'edit',
        authorityStatus: 'current',
        confirmationStatus: 'confirmed',
        contentChangedSinceScheduling: true,
      }),
    ]);
    expect(wednesday?.content?.note).toContain('1 additional Secretary-confirmed private Content block');
    expect(result.contentPlan.confirmedBlockCount).toBe(2);
  });

  it('does not give a deadline-only day the confirmed status of a block on another day', async () => {
    const base = buildBaseContexts();
    base.content.deadlines = [{
      itemId: 88,
      title: 'Friday advisory target',
      date: '2026-04-17',
      deadlineAt: '2026-04-17T17:00:00.000Z',
      status: 'approved',
      semantics: 'target_date_not_publication',
    }];
    mockReadContentMeshContext.mockResolvedValue(base.content);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const friday = result.days.find((day) => day.date === '2026-04-17');

    expect(result.contentPlan.planStatus).toBe('confirmed');
    expect(friday?.content).toEqual(expect.objectContaining({
      status: 'advisory',
      planStatus: 'unplanned',
      scheduleSemantics: 'target_date_not_publication',
      blockStart: null,
      blockEnd: null,
    }));
  });

  it('keeps editorial content capture opportunities advisory until Secretary confirms a private block', async () => {
    const base = buildBaseContexts();
    base.content.filmingRecommendation = null;
    base.content.derivedSignals = [];
    base.content.workSchedule = {
      ...base.content.workSchedule,
      planStatus: 'unplanned',
      confirmedBlocks: [],
    };
    mockReadContentMeshContext.mockResolvedValue(base.content);
    mockBuildEditorialSignals.mockReturnValue({
      signals: [
        {
          sourceAgent: 'mesh.editorial-coordinator',
          signalType: 'content_capture_opportunity',
          meshPriority: 2,
          priority: 'urgent',
          payload: {
            date: '2026-04-15',
            title: 'Creators are debating carb myths again',
            angle: 'reaction_window',
            reason: 'Fast reaction window with enough context to move now.',
            planStatus: 'proposed',
            scheduleAuthority: 'secretary',
            scheduleAuthorityStatus: 'current',
            semantics: 'proposal_not_calendar_reservation',
            nextExecutionDateSemantics: 'recommended_work_date',
            nextExecutionCalendarConfirmed: false,
          },
        },
      ],
    });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const wednesday = result.days.find((day) => day.date === '2026-04-15');

    expect(wednesday?.content?.title).toBe('Reaction content proposal');
    expect(wednesday?.content?.status).toBe('advisory');
    expect(wednesday?.content?.planStatus).toBe('proposed');
    expect(wednesday?.content?.scheduleSemantics).toBe('proposal_not_calendar_reservation');
    expect(wednesday?.content?.note).toContain('Fast reaction window with enough context to move now.');
    expect(wednesday?.content?.note).toContain('not a protected block');
    expect(wednesday?.headline).toBe('A Content work proposal is available, but no private block is confirmed yet.');
    expect(wednesday?.secretary.priorityNote).toBe('Proposal: Fast reaction window with enough context to move now.');
    expect(wednesday?.secretary.sequence).toContain('Review a fast reaction-slot proposal while the context is still fresh.');
    expect(wednesday?.secretary.tradeoffNote).toBeNull();
    expect(wednesday?.secretary.decisions.map((decision) => decision.signalType)).toContain('content_capture_opportunity');
  });

  it('ignores shoot-day signals for non-filming Content work', async () => {
    const base = buildBaseContexts();
    base.content.filmingRecommendation = null;
    base.content.deadlines = [];
    base.content.workSchedule = {
      ...base.content.workSchedule,
      planStatus: 'confirmed',
      confirmedBlocks: [{
        itemId: 77,
        title: 'Edit the approved capture',
        date: '2026-04-15',
        startsAt: '2026-04-15T11:00:00.000Z',
        endsAt: '2026-04-15T13:00:00.000Z',
        workKind: 'edit',
        state: 'provider_synced',
        authority: 'secretary',
        authorityStatus: 'current',
        semantics: 'private_work_session',
        contentChangedSinceScheduling: false,
      }],
    };
    mockReadContentMeshContext.mockResolvedValue(base.content);
    mockBuildEditorialSignals.mockReturnValue({
      signals: [
        {
          sourceAgent: 'mesh.editorial-coordinator',
          signalType: 'shoot_day_locked',
          meshPriority: 3,
          priority: 'normal',
          payload: {
            itemId: 77,
            title: 'Edit the approved capture',
            date: '2026-04-15',
            blockStart: '2026-04-15T11:00:00.000Z',
            blockEnd: '2026-04-15T13:00:00.000Z',
            workKind: 'filming',
            sourceWorkKind: 'edit',
            sourceState: 'provider_synced',
            providerAttention: false,
            planStatus: 'confirmed',
            scheduleAuthority: 'secretary',
            scheduleAuthorityStatus: 'current',
            semantics: 'private_work_session',
          },
        },
      ],
    });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const wednesday = result.days.find((day) => day.date === '2026-04-15');

    expect(wednesday?.content).toEqual(expect.objectContaining({
      status: 'scheduled',
      scheduleSemantics: 'private_work_session',
    }));
    expect(wednesday?.secretary.decisions.map((decision) => decision.signalType)).not.toContain('shoot_day_locked');
  });

  it('keeps a current sync-failed filming block confirmed while surfacing provider attention', async () => {
    const base = buildBaseContexts();
    base.content.filmingRecommendation = null;
    base.content.workSchedule.confirmedBlocks[0].state = 'sync_failed';
    base.content.workSchedule.attentionCount = 1;
    mockReadContentMeshContext.mockResolvedValue(base.content);
    mockBuildEditorialSignals.mockReturnValue({
      signals: [
        {
          sourceAgent: 'mesh.editorial-coordinator',
          signalType: 'shoot_day_locked',
          meshPriority: 3,
          priority: 'normal',
          payload: {
            itemId: 41,
            title: 'Record the weekly piece',
            date: '2026-04-15',
            blockStart: '2026-04-15T11:00:00.000Z',
            blockEnd: '2026-04-15T13:00:00.000Z',
            workKind: 'filming',
            sourceWorkKind: 'record',
            sourceState: 'sync_failed',
            providerAttention: true,
            planStatus: 'confirmed',
            scheduleAuthority: 'secretary',
            scheduleAuthorityStatus: 'current',
            semantics: 'private_work_session',
          },
        },
      ],
    });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const wednesday = result.days.find((day) => day.date === '2026-04-15');

    expect(result.contentPlan).toMatchObject({
      planStatus: 'confirmed',
      confirmedBlockCount: 1,
      attentionCount: 1,
    });
    expect(wednesday?.content).toMatchObject({
      status: 'scheduled',
      planStatus: 'confirmed',
      title: 'Confirmed Content block needs provider attention',
      blockStart: '2026-04-15T11:00:00.000Z',
      blockEnd: '2026-04-15T13:00:00.000Z',
    });
    expect(wednesday?.content?.note).toContain('local Secretary block remains confirmed');
    expect(wednesday?.content?.note).not.toContain('publishing commitment');
    expect(wednesday?.secretary.decisions.map((decision) => decision.signalType)).toContain('shoot_day_locked');
  });

  it('places a trusted external deadline on its supplied zoned date without reserving time', async () => {
    const base = buildBaseContexts();
    base.content.filmingRecommendation = null;
    base.content.deadlines = [];
    base.content.workSchedule = {
      ...base.content.workSchedule,
      planStatus: 'unplanned',
      confirmedBlocks: [],
      attentionCount: 0,
    };
    mockReadContentMeshContext.mockResolvedValue(base.content);
    mockBuildEditorialSignals.mockReturnValue({
      signals: [{
        sourceAgent: 'mesh.editorial-coordinator',
        signalType: 'sponsor_deliverable_due',
        meshPriority: 1,
        priority: 'urgent',
        payload: {
          title: 'Partner review package',
          dueAt: '2026-04-16T00:30:00+02:00',
          status: 'factual_constraint',
          publicationAuthority: 'not_established',
          semantics: 'external_deadline_not_publication_authority',
        },
      }],
    });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const thursday = result.days.find((day) => day.date === '2026-04-16');

    expect(result.days.find((day) => day.date === '2026-04-15')?.content).toBeNull();
    expect(thursday?.content).toMatchObject({
      status: 'advisory',
      planStatus: 'unplanned',
      scheduleSemantics: 'target_date_not_publication',
      title: 'External Content deadline attention',
      blockStart: null,
      blockEnd: null,
    });
    expect(thursday?.content?.note).toContain('2026-04-16T00:30:00+02:00');
    expect(thursday?.content?.note).toContain('does not reserve calendar time or authorize publication');
    expect(thursday?.secretary.sequence).toContain(
      'Review the factual external Content deadline and decide the response; it does not reserve time or authorize publication.',
    );
  });

  it('does not place undated or untrusted sponsor constraints into a plan day', async () => {
    const base = buildBaseContexts();
    base.content.filmingRecommendation = null;
    base.content.deadlines = [];
    base.content.workSchedule = {
      ...base.content.workSchedule,
      planStatus: 'unplanned',
      confirmedBlocks: [],
      attentionCount: 0,
    };
    mockReadContentMeshContext.mockResolvedValue(base.content);
    mockBuildEditorialSignals.mockReturnValue({
      signals: [
        {
          sourceAgent: 'mesh.editorial-coordinator',
          signalType: 'sponsor_deliverable_due',
          meshPriority: 1,
          priority: 'urgent',
          payload: {
            title: 'Undated partner package',
            dueAt: null,
            status: 'factual_constraint',
            publicationAuthority: 'not_established',
            semantics: 'external_deadline_not_publication_authority',
          },
        },
        {
          sourceAgent: 'mesh.untrusted-producer',
          signalType: 'sponsor_deliverable_due',
          meshPriority: 1,
          priority: 'urgent',
          payload: {
            title: 'Untrusted deadline',
            dueAt: '2026-04-17T09:00:00Z',
            status: 'factual_constraint',
            publicationAuthority: 'not_established',
            semantics: 'external_deadline_not_publication_authority',
          },
        },
      ],
    });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.days.every((day) => day.content == null)).toBe(true);
    expect(result.days.flatMap((day) => day.secretary.decisions).map((decision) => decision.signalType))
      .not.toContain('sponsor_deliverable_due');
  });

  it('merges a same-day external deadline with a confirmed filming block without inventing publication authority', async () => {
    const base = buildBaseContexts();
    base.content.filmingRecommendation = null;
    mockReadContentMeshContext.mockResolvedValue(base.content);
    mockBuildEditorialSignals.mockReturnValue({
      signals: [
        {
          sourceAgent: 'mesh.editorial-coordinator',
          signalType: 'sponsor_deliverable_due',
          meshPriority: 1,
          priority: 'urgent',
          payload: {
            title: 'Partner review package',
            dueAt: '2026-04-15T17:00:00+01:00',
            status: 'factual_constraint',
            publicationAuthority: 'not_established',
            semantics: 'external_deadline_not_publication_authority',
          },
        },
        {
          sourceAgent: 'mesh.editorial-coordinator',
          signalType: 'shoot_day_locked',
          meshPriority: 3,
          priority: 'normal',
          payload: {
            itemId: 41,
            title: 'Record the weekly piece',
            date: '2026-04-15',
            blockStart: '2026-04-15T11:00:00.000Z',
            blockEnd: '2026-04-15T13:00:00.000Z',
            workKind: 'filming',
            sourceWorkKind: 'record',
            sourceState: 'provider_synced',
            providerAttention: false,
            planStatus: 'confirmed',
            scheduleAuthority: 'secretary',
            scheduleAuthorityStatus: 'current',
            semantics: 'private_work_session',
          },
        },
      ],
    });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const wednesday = result.days.find((day) => day.date === '2026-04-15');

    expect(result.conflicts).toEqual([]);
    expect(wednesday?.content).toMatchObject({
      status: 'scheduled',
      scheduleSemantics: 'private_work_session',
      blockStart: '2026-04-15T11:00:00.000Z',
      blockEnd: '2026-04-15T13:00:00.000Z',
    });
    expect(wednesday?.content?.note).toContain('sponsor deadline needs attention');
    expect(wednesday?.content?.note).toContain('only protected time');
    expect(wednesday?.content?.note).not.toContain('publishing commitment');
    expect(wednesday?.secretary.sequence).toContain(
      'Honor the Secretary-confirmed private filming block and separately address the external deadline; only the work block reserves time, and neither authorizes publication.',
    );
  });

  it('reports current authority with attention but zero blocks as unplanned rather than proposed or confirmed', async () => {
    const base = buildBaseContexts();
    base.content.filmingRecommendation = null;
    base.content.workSchedule = {
      ...base.content.workSchedule,
      planStatus: 'unplanned',
      confirmedBlocks: [],
      attentionCount: 1,
    };
    mockReadContentMeshContext.mockResolvedValue(base.content);
    mockBuildEditorialSignals.mockReturnValue({ signals: [] });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.contentPlan).toEqual({
      authority: 'secretary',
      authorityStatus: 'current',
      planStatus: 'unplanned',
      semantics: 'private_work_session',
      confirmedBlockCount: 0,
      confirmedBlocksComplete: true,
      attentionCount: 1,
      deadlineCount: 0,
    });
    expect(result.days.every((day) => day.content == null)).toBe(true);
  });

  it('propagates partial authority without discarding an individually confirmed private block', async () => {
    const base = buildBaseContexts();
    base.content.workSchedule = {
      ...base.content.workSchedule,
      authorityStatus: 'partially_unavailable',
      planStatus: 'partial',
      attentionCount: 1,
    };
    mockReadContentMeshContext.mockResolvedValue(base.content);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const wednesday = result.days.find((day) => day.date === '2026-04-15');

    expect(result.contentPlan).toMatchObject({
      authorityStatus: 'partially_unavailable',
      planStatus: 'partial',
      confirmedBlockCount: 1,
      attentionCount: 1,
    });
    expect(wednesday?.content).toMatchObject({
      status: 'scheduled',
      planStatus: 'partial',
      scheduleAuthority: 'secretary',
      scheduleAuthorityStatus: 'partially_unavailable',
      scheduleSemantics: 'private_work_session',
    });
    expect(wednesday?.content?.confirmedBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        authorityStatus: 'current',
        confirmationStatus: 'confirmed',
      }),
    ]));
  });

  it('does not schedule a stale embedded block when aggregate Content authority is unavailable', async () => {
    const base = buildBaseContexts();
    base.content.filmingRecommendation = null;
    base.content.deadlines = [];
    base.content.workSchedule = {
      ...base.content.workSchedule,
      authorityStatus: 'unavailable',
      planStatus: 'unavailable',
      confirmedBlocksComplete: false,
    };
    mockReadContentMeshContext.mockResolvedValue(base.content);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });
    const wednesday = result.days.find((day) => day.date === '2026-04-15');

    expect(result.contentPlan).toMatchObject({
      authorityStatus: 'unavailable',
      planStatus: 'unavailable',
    });
    expect(wednesday?.content).toBeNull();
  });

  it('propagates an unavailable Content plan when the mesh reader cannot establish schedule authority', async () => {
    mockReadContentMeshContext.mockRejectedValueOnce(new Error('content schedule unavailable'));

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({ userId: 12, weekStart: '2026-04-13', forceRefresh: true });

    expect(result.degraded).toBe(true);
    expect(result.contentPlan).toEqual({
      authority: 'secretary',
      authorityStatus: 'unavailable',
      planStatus: 'unavailable',
      semantics: 'private_work_session',
      confirmedBlockCount: 0,
      confirmedBlocksComplete: false,
      attentionCount: 0,
      deadlineCount: 0,
    });
  });

  it('retires superseded mesh signals so orchestration does not reason from stale copies', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T08:00:00.000Z'));
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
    await composeWeeklyPlan({ userId: 12, tenantId: 12, weekStart: '2026-04-13', forceRefresh: true, syncSignals: true });

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

    const refreshed = await composeWeeklyPlan({ userId: 12, tenantId: 12, weekStart: '2026-04-13', forceRefresh: true, syncSignals: true });
    const activeBudgetSignals = writtenSignals.filter((signal) =>
      signal.status === 'active'
      && signal.user_id === 12
      && signal.tenant_id === 12
      && signal.source_agent === 'mesh.finance-context'
      && signal.signal_type === 'budget_remaining',
    );

    expect(mockReconcileGovernedSignalSet).toHaveBeenCalledWith({
      sourceAgent: 'mesh.finance-context',
      userId: 12,
      tenantId: 12,
      keepSignalIds: [expect.any(Number)],
    });
    expect(activeBudgetSignals).toHaveLength(1);
    expect(activeBudgetSignals[0]?.payload).toMatchObject({
      month: '2026-04',
      remainingRatio: 0.08,
      budgetMode: 'tight',
    });
    expect(refreshed.days[0]?.finance?.budgetNote).toContain('Budget headroom is tight this week');
  });

  it('retires a producer previous signal set when its refreshed draft set is empty', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T08:00:00.000Z'));
    const first = buildBaseContexts();
    first.finance.derivedSignals = [{
      sourceAgent: 'mesh.finance-context',
      signalType: 'budget_remaining',
      meshPriority: 2,
      priority: 'urgent',
      payload: { month: '2026-04', remainingRatio: 0.22, budgetMode: 'controlled' },
    }];
    mockReadFinanceMeshContext.mockResolvedValueOnce(first.finance);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    await composeWeeklyPlan({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-13',
      forceRefresh: true,
      syncSignals: true,
    });

    const second = buildBaseContexts();
    second.finance.derivedSignals = [];
    mockReadFinanceMeshContext.mockResolvedValueOnce(second.finance);
    await composeWeeklyPlan({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-13',
      forceRefresh: true,
      syncSignals: true,
    });

    expect(mockReconcileGovernedSignalSet).toHaveBeenCalledWith({
      sourceAgent: 'mesh.finance-context',
      userId: 12,
      tenantId: 12,
      keepSignalIds: [],
    });
    expect(writtenSignals.filter((signal) =>
      signal.status === 'active'
      && signal.source_agent === 'mesh.finance-context'
      && signal.user_id === 12
      && signal.tenant_id === 12,
    )).toEqual([]);
  });

  it('preserves the last coherent producer set when that producer read degrades', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T08:00:00.000Z'));
    const first = buildBaseContexts();
    first.finance.derivedSignals = [{
      sourceAgent: 'mesh.finance-context',
      signalType: 'budget_remaining',
      meshPriority: 2,
      priority: 'urgent',
      payload: { month: '2026-04', remainingRatio: 0.22, budgetMode: 'controlled' },
    }];
    mockReadFinanceMeshContext.mockResolvedValueOnce(first.finance);

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    await composeWeeklyPlan({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-13',
      forceRefresh: true,
      syncSignals: true,
    });
    mockReconcileGovernedSignalSet.mockClear();
    mockReadFinanceMeshContext.mockRejectedValueOnce(new Error('finance unavailable'));

    const degraded = await composeWeeklyPlan({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-13',
      forceRefresh: true,
      syncSignals: true,
    });

    expect(degraded.degraded).toBe(true);
    expect(mockReconcileGovernedSignalSet.mock.calls.some(
      ([input]) => input.sourceAgent === 'mesh.finance-context',
    )).toBe(false);
    expect(writtenSignals.filter((signal) =>
      signal.status === 'active'
      && signal.source_agent === 'mesh.finance-context'
      && signal.user_id === 12
      && signal.tenant_id === 12,
    )).toHaveLength(1);
  });
  it('keeps current-window signal ownership when another week is recomputed', async () => {
    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    await composeWeeklyPlan({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-13',
      forceRefresh: true,
      syncSignals: true,
    });
    const currentIds = writtenSignals
      .filter((signal) => signal.status === 'active')
      .map((signal) => signal.id);
    mockReconcileGovernedSignalSet.mockClear();

    const otherWeek = await composeWeeklyPlan({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-20',
      forceRefresh: true,
      syncSignals: true,
    });

    expect(otherWeek.weekStart).toBe('2026-04-20');
    expect(writtenSignals.filter((signal) => signal.status === 'active').map((signal) => signal.id))
      .toEqual(currentIds);
    expect(mockReconcileGovernedSignalSet).not.toHaveBeenCalled();
  });

  it('keeps loaded safety directives when durable signal synchronization is unavailable', async () => {
    mockReconcileGovernedSignalSet.mockImplementationOnce(() => {
      throw new Error('signal store unavailable');
    });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    const result = await composeWeeklyPlan({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-13',
      forceRefresh: true,
      syncSignals: true,
    });

    expect(result.degraded).toBe(true);
    expect(result.days.some((day) => (
      day.secretary.decisions.some((decision) => decision.signalType === 'travel_window')
    ))).toBe(true);
  });

  it('retires a synced shoot-day signal when the confirmed filming block disappears', async () => {
    mockBuildEditorialSignals.mockReturnValueOnce({
      signals: [{
        sourceAgent: 'mesh.editorial-coordinator',
        signalType: 'shoot_day_locked',
        meshPriority: 2,
        priority: 'urgent',
        payload: { date: '2026-04-15', reason: 'Confirmed filming block.' },
      }],
    });

    const { composeWeeklyPlan } = await import('../../src/services/weekly-plan-orchestrator');
    await composeWeeklyPlan({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-13',
      forceRefresh: true,
      syncSignals: true,
    });
    expect(writtenSignals.some((signal) => (
      signal.status === 'active'
      && signal.source_agent === 'mesh.editorial-coordinator'
      && signal.signal_type === 'shoot_day_locked'
    ))).toBe(true);

    const cancelled = buildBaseContexts();
    cancelled.content.workSchedule = {
      authority: 'secretary',
      authorityStatus: 'current',
      planStatus: 'unplanned',
      semantics: 'private_work_session',
      confirmedBlocks: [],
      confirmedBlocksComplete: true,
      attentionCount: 0,
    };
    cancelled.content.filmingRecommendation = null;
    mockReadContentMeshContext.mockResolvedValueOnce(cancelled.content);
    mockBuildEditorialSignals.mockReturnValueOnce({ signals: [] });

    await composeWeeklyPlan({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-13',
      forceRefresh: true,
      syncSignals: true,
    });

    expect(writtenSignals.some((signal) => (
      signal.status === 'active'
      && signal.source_agent === 'mesh.editorial-coordinator'
      && signal.signal_type === 'shoot_day_locked'
    ))).toBe(false);
  });

});
