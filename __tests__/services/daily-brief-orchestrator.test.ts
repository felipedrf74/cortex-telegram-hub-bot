import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';
import { CONTENT_AGENT_LIFECYCLE_POLICY_VERSION } from '../../src/services/content-agent-lifecycle';

const mockGetCached = vi.fn(() => null);
const mockSetCache = vi.fn();
const mockComposeWeeklyPlan = vi.fn();
const mockGetDecisionOverview = vi.fn(() => ({
  items: [],
  handled: [],
  partial: { items: true, handled: true, summary: true },
}));
const mockGetUserById = vi.fn();

vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
}));

vi.mock('../../src/services/weekly-plan-orchestrator', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/weekly-plan-orchestrator')>(
    '../../src/services/weekly-plan-orchestrator',
  )),
  CONTENT_PLAN_PROJECTION_VERSION: 'content-plan.v4',
  composeWeeklyPlan: (...args: unknown[]) => mockComposeWeeklyPlan(...args),
}));

vi.mock('../../src/services/decision-center', () => ({
  getDecisionOverview: (...args: unknown[]) => mockGetDecisionOverview(...args),
}));

vi.mock('../../src/services/user-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/user-service')>(
    '../../src/services/user-service',
  )),
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
}));

function minimalWeekWithCalendarStatus(status: 'ready' | 'unavailable') {
  const ready = { status: 'ready', warningCodes: [], warnings: [] };
  return {
    weekStart: '2026-04-13',
    weekEnd: '2026-04-19',
    generatedAt: '2026-04-15T08:00:00.000Z',
    timezone: 'Europe/Lisbon',
    warningCodes: status === 'ready' ? [] : ['CALENDAR_STATE_UNAVAILABLE'],
    warnings: status === 'ready' ? [] : ['Calendar state is unavailable.'],
    sourceHealth: {
      calendar: status === 'ready'
        ? ready
        : { status: 'unavailable', warningCodes: ['CALENDAR_STATE_UNAVAILABLE'], warnings: ['Calendar state is unavailable.'] },
      tasks: ready,
      mail: ready,
      focus: status === 'ready'
        ? ready
        : { status: 'unavailable', warningCodes: ['FOCUS_BLOCKED_BY_CALENDAR_STATE'], warnings: ['Focus-window state is unavailable.'] },
      training: ready,
      cooking: ready,
      content: ready,
      finance: ready,
    },
    degraded: status !== 'ready',
    gated: { skills: [] },
    garmin_stale: false,
    creativeCopy: { headline: '', note: '' },
    conflicts: [],
    days: [{
      date: '2026-04-15',
      weekday: 'Wednesday',
      headline: 'A calm operational day.',
      training: { title: 'Rest', type: 'rest', status: 'rest', durationMinutes: null, intensity: null, reason: 'No session planned.', decisions: [] },
      meals: [],
      content: null,
      secretary: {
        focusBlock: null,
        pendingTasks: 0,
        overdueTasks: 0,
        travel: false,
        busy: false,
        writableCalendar: false,
        priorityNote: null,
        sequence: [],
        tradeoffNote: null,
        decisions: [],
      },
      finance: null,
    }],
  };
}

describe('daily-brief-orchestrator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    clearTenantScopeAnomaliesForTests();
    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockComposeWeeklyPlan.mockReset();
    mockGetDecisionOverview.mockReset();
    mockGetUserById.mockReset();
    mockGetDecisionOverview.mockReturnValue({
      items: [],
      handled: [],
      partial: { items: true, handled: true, summary: true },
    });
    mockGetUserById.mockReturnValue({
      id: 12,
      tier: 'max',
      language: 'en-US',
      timezone: 'Europe/Lisbon',
    });
  });

  it('builds event-driven coordination from the selected day', async () => {
    mockComposeWeeklyPlan.mockResolvedValue({
      degraded: false,
      gated: { skills: [] },
      garmin_stale: false,
      creativeCopy: { headline: 'Balanced week', note: 'Stay steady.' },
      contentPlan: {
        authority: 'secretary',
        authorityStatus: 'partially_unavailable',
        planStatus: 'partial',
        semantics: 'private_work_session',
        confirmedBlockCount: 1,
        confirmedBlocksComplete: true,
        attentionCount: 1,
        deadlineCount: 1,
      },
      conflicts: [
        {
          id: '2026-04-15:primary-commitment:2',
          date: '2026-04-15',
          target: 'primary-commitment',
          signalIds: [1, 2],
          signalTypes: ['shoot_day_locked', 'tax_deadline'],
          meshPriority: 2,
          message: 'A confirmed private Content work block overlaps another fixed commitment.',
        },
      ],
      days: [
        {
          date: '2026-04-15',
          weekday: 'Wednesday',
          headline: 'Fueling needs attention so the day can support the planned session.',
          training: {
            title: 'Track intervals',
            type: 'run',
            status: 'adjusted',
            durationMinutes: 60,
            intensity: 'Hard',
            reason: 'Recovery is strained — keep training conservative and easy to absorb.',
            decisions: [],
          },
          meals: [
            {
              mealType: 'guidance',
              title: 'Fueling coverage missing',
              note: 'Add a simple staple carb + protein option you already buy so fueling stays cheap and reliable.',
              decisions: [],
            },
          ],
          cooking: {
            status: 'degraded',
            headline: '1 saved meal withheld because it conflicts with current safety preferences.',
            warningCodes: ['COOKING_SAVED_MEAL_ALLERGY_CONFLICT'],
          },
          content: {
            status: 'scheduled',
            planStatus: 'partial',
            scheduleAuthority: 'secretary',
            scheduleAuthorityStatus: 'partially_unavailable',
            scheduleSemantics: 'private_work_session',
            title: 'Confirmed Content block needs provider attention',
            note: 'Use this Secretary-confirmed private session for the recorded Content work. Provider sync needs attention, but the local block remains confirmed; it is not a publication commitment.',
            blockStart: '2026-04-15T11:00:00.000Z',
            blockEnd: '2026-04-15T13:00:00.000Z',
            confirmedBlocks: [{
              itemId: 41,
              title: 'Record the weekly piece',
              authorityStatus: 'current',
              confirmationStatus: 'confirmed',
              itemStatus: 'approved',
              outcome: 'Record the approved weekly piece.',
              estimatedEffortMinutes: 120,
              dependency: null,
              approvalState: 'approved',
              nextAction: { action: 'none', label: 'No further action', reason: 'The block is ready.' },
              startsAt: '2026-04-15T11:00:00.000Z',
              endsAt: '2026-04-15T13:00:00.000Z',
              workKind: 'record',
              state: 'sync_failed',
              contentChangedSinceScheduling: false,
            }],
            decisions: [],
          },
          secretary: {
            focusBlock: {
              start: '2026-04-15T09:00:00.000Z',
              end: '2026-04-15T10:30:00.000Z',
              note: 'Best focus block of the week.',
            },
            pendingTasks: 4,
            overdueTasks: 1,
            travel: false,
            busy: false,
            priorityNote: 'Protect Track intervals as a high-immovability training block.',
            sequence: [
              'Protect the key training window before moving meetings, errands, or filming onto the day.',
              'Lock meal or shopping coverage before the session so training support is not left to chance.',
              'Use the confirmed private Content block only for its recorded work purpose.',
            ],
            tradeoffNote: 'Training is the anchor, meals need closing before it, and the confirmed private Content block must not be treated as a publication reservation.',
            decisions: [],
          },
          finance: {
            budgetNote: 'Budget mode is controlled; grocery mode is cost_aware; training spend mode is selective; content spend mode is selective.',
            taxNote: null,
            subscriptionNote: null,
            decisions: [],
          },
        },
      ],
    });

    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    const result = await composeDailyBrief({ userId: 12, date: '2026-04-15', forceRefresh: true });

    expect(result.day.cooking).toEqual({
      status: 'degraded',
      headline: '1 saved meal withheld because it conflicts with current safety preferences.',
      warningCodes: ['COOKING_SAVED_MEAL_ALLERGY_CONFLICT'],
    });
    expect(result.coordination.topPriority).toBe('Keep the day light and recoverable.');
    expect(result.coordination.executionOrder).toEqual(
      expect.arrayContaining([
        'Keep the day light and recoverable.',
        'Review the Content-block conflict at 12:00–14:00.',
      ]),
    );
    expect(result.coordination.executionOrder.length).toBeLessThanOrEqual(3);
    expect(result.coordination.suggestedMoves.length).toBeLessThanOrEqual(2);
    expect(result.coordination.dayOrchestration.posture).toBe('recovery_protected_day');
    expect(result.coordination.weekOrchestration.posture).toBe('consistency');
    expect(result.coordination.nextBestAction?.kind).toBe('lighten_day');
    expect(result.coordination.blockers.map((blocker) => blocker.kind)).toEqual(
      expect.arrayContaining(['task_pressure', 'deadline_collision']),
    );
    expect(result.coordination.watchouts).toEqual(
      expect.arrayContaining([
        'There are 1 overdue tasks, 0 due today, and 0 unread emails in play.',
        'A confirmed private Content work block overlaps another fixed commitment.',
      ]),
    );
    expect(result.coordination.handoffs).toEqual(
      expect.arrayContaining([
        'Training is pulling the day toward less friction and less load.',
        'Content has a confirmed private session for its recorded work; this does not imply publication.',
        'The aligned meal helps keep training and schedule more executable.',
      ]),
    );
    expect(result.contentPlan).toEqual(expect.objectContaining({
      authority: 'secretary',
      authorityStatus: 'partially_unavailable',
      planStatus: 'partial',
      confirmedBlockCount: 1,
      attentionCount: 1,
    }));
    expect(result.day.content?.note).toContain('Provider sync needs attention, but the local block remains confirmed');
    expect(result.coordination.protectedBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'content' }),
    ]));
    expect(mockSetCache).toHaveBeenCalledWith(
      expect.stringContaining(`:content-policy:${CONTENT_AGENT_LIFECYCLE_POLICY_VERSION}`),
      expect.anything(),
      1800,
    );
    expect(JSON.stringify(result.coordination)).not.toMatch(/\b(ship|shipping|publish|publishing)\b/i);
  });

  it('reads Secretary Today decision signals with the exact authenticated tenant scope', async () => {
    mockComposeWeeklyPlan.mockResolvedValue({
      degraded: false,
      gated: { skills: [] },
      garmin_stale: false,
      creativeCopy: { headline: 'Quiet day', note: 'Stay steady.' },
      contentPlan: {
        authority: 'secretary',
        authorityStatus: 'current',
        planStatus: 'unplanned',
        semantics: 'private_work_session',
        confirmedBlockCount: 0,
        confirmedBlocksComplete: true,
        attentionCount: 0,
        deadlineCount: 0,
      },
      conflicts: [],
      days: [
        {
          date: '2026-04-15',
          weekday: 'Wednesday',
          headline: 'A calm operational day.',
          training: {
            title: 'Rest',
            type: 'rest',
            status: 'rest',
            durationMinutes: null,
            intensity: null,
            reason: 'No session planned.',
            decisions: [],
          },
          meals: [],
          content: null,
          secretary: {
            focusBlock: null,
            pendingTasks: 0,
            overdueTasks: 0,
            travel: false,
            busy: false,
            priorityNote: null,
            sequence: [],
            tradeoffNote: null,
            decisions: [],
          },
          finance: null,
        },
      ],
    });

    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    await composeDailyBrief({ userId: 12, tenantId: 12, date: '2026-04-15', forceRefresh: true });

    expect(mockComposeWeeklyPlan).toHaveBeenCalledWith(expect.objectContaining({
      userId: 12,
      tenantId: 12,
    }));
    expect(mockGetDecisionOverview).toHaveBeenCalledWith(12, 12, {
      limit: 30,
      handledLimit: 10,
    });
  });

  it('uses the user timezone for an implicit today and propagates it to the weekly plan', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T00:30:00.000Z'));
    mockGetUserById.mockReturnValue({
      id: 12,
      tier: 'max',
      language: 'en-US',
      timezone: 'Pacific/Honolulu',
    });
    mockComposeWeeklyPlan.mockResolvedValue({
      degraded: false,
      gated: { skills: [] },
      garmin_stale: false,
      creativeCopy: { headline: '', note: '' },
      conflicts: [],
      days: [],
    });

    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    const result = await composeDailyBrief({ userId: 12, tenantId: 12, forceRefresh: true });

    expect(result.date).toBe('2026-04-12');
    expect(mockComposeWeeklyPlan).toHaveBeenCalledWith(expect.objectContaining({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-06',
      context: expect.objectContaining({ timezone: 'Pacific/Honolulu' }),
    }));
  });

  it('rejects a tenant mismatch before user, week, or Decision Center reads', async () => {
    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    await expect(composeDailyBrief({
      userId: 12,
      tenantId: 34,
      date: '2026-04-15',
      forceRefresh: true,
    })).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISMATCH' });

    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
    expect(mockGetDecisionOverview).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()[0]).toMatchObject({
      operation: 'compose_daily_brief_tenant_scope',
      reason: 'tenant_mismatch',
    });
  });

  it('never reports agenda or conflict checks as clear when calendar state is unavailable', async () => {
    mockComposeWeeklyPlan.mockResolvedValueOnce(minimalWeekWithCalendarStatus('unavailable'));
    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    const result = await composeDailyBrief({
      userId: 12,
      tenantId: 12,
      date: '2026-04-15',
      language: 'en-US',
      forceRefresh: true,
    });

    expect(result.coordination.secretaryToday.checked.map((entry) => entry.id))
      .not.toEqual(expect.arrayContaining(['agenda-sync', 'conflict-scan']));
    expect(result.coordination.secretaryToday.waitingOnSource.map((entry) => entry.id))
      .toContain('source-health-calendar');
    expect(result.coordination.dayOrchestration.title).toBe('Today’s plan needs calendar confirmation.');
    expect(result.coordination.dayOrchestration.mainThing).toBeNull();
  });

  it('marks Decision Center degraded when its overview is only partially available', async () => {
    mockComposeWeeklyPlan.mockResolvedValueOnce(minimalWeekWithCalendarStatus('ready'));
    mockGetDecisionOverview.mockReturnValueOnce({
      items: [],
      handled: [],
      partial: { items: false, handled: true, summary: false },
    });

    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    const result = await composeDailyBrief({
      userId: 12,
      tenantId: 12,
      date: '2026-04-15',
      language: 'en-US',
      forceRefresh: true,
    });

    expect(result.degraded).toBe(true);
    expect(result.sourceHealth.decision_center).toMatchObject({
      status: 'degraded',
      warningCodes: ['DECISION_CENTER_PARTIAL'],
    });
  });

  it('derives today from a supplied weekly snapshot without a second weekly composition', async () => {
    const weekPlan = minimalWeekWithCalendarStatus('ready') as any;
    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    const result = await composeDailyBrief({
      userId: 12,
      tenantId: 12,
      date: '2026-04-15',
      language: 'en-US',
      weekPlan,
      forceRefresh: true,
    });

    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
    expect(result.generatedAt).toBe(weekPlan.generatedAt);
    expect(result.day).toBe(weekPlan.days[0]);
  });

  it('rejects a mismatched supplied day snapshot instead of degrading it', async () => {
    const weekPlan = minimalWeekWithCalendarStatus('ready') as any;
    const context = {
      userId: 12,
      tenantId: 12,
      timezone: 'Europe/Lisbon',
      language: 'en-US',
      targetDate: '2026-04-15',
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
      user: { id: 12 },
      warningCodes: [],
      warnings: [],
    } as any;
    const daySnapshot = {
      context: { ...context, userId: 34, tenantId: 34 },
      week: weekPlan,
      date: context.targetDate,
      day: weekPlan.days[0],
      conflicts: [],
      timezone: context.timezone,
      warningCodes: [],
      warnings: [],
      sourceHealth: weekPlan.sourceHealth,
    } as any;

    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    await expect(composeDailyBrief({
      userId: 12,
      tenantId: 12,
      date: context.targetDate,
      language: context.language,
      context,
      weekPlan,
      daySnapshot,
      forceRefresh: true,
    })).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISMATCH' });

    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
    expect(mockGetDecisionOverview).not.toHaveBeenCalled();
  });

  it('rejects an invalid user scope before composition and records an anomaly', async () => {
    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    await expect(composeDailyBrief({
      userId: 0,
      date: '2026-04-15',
      language: 'pt-PT',
      forceRefresh: true,
    })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()[0]).toMatchObject({
      layer: 'orchestration',
      operation: 'compose_daily_brief',
      reason: 'invalid_user_scope',
      userId: 0,
      details: { date: '2026-04-15' },
    });
  });

  it('returns cached daily briefs without recomputing the weekly plan', async () => {
    mockGetCached.mockReturnValue({
      date: '2026-04-15',
      generatedAt: '2026-04-15T08:00:00.000Z',
      degraded: false,
      gated: { skills: [] },
      garmin_stale: false,
      conflicts: [],
      creativeCopy: { headline: '', note: '' },
      contentPlan: {
        authority: 'secretary',
        authorityStatus: 'current',
        planStatus: 'unplanned',
        semantics: 'private_work_session',
        confirmedBlockCount: 0,
        confirmedBlocksComplete: true,
        attentionCount: 0,
        deadlineCount: 0,
      },
      day: { date: '2026-04-15' },
      coordination: {
        topPriority: 'cached',
        executionOrder: [],
        watchouts: [],
        handoffs: [],
        confidence: 'low',
        dayOrchestration: {
          posture: 'stable_day',
          title: 'Daily orchestration unavailable.',
          summary: 'No reliable scheduling posture could be built for this request.',
          confidence: 'low',
          mainThing: null,
          reasons: [],
          affectedSkills: ['secretary'],
        },
        weekOrchestration: {
          posture: 'stable',
          title: 'Weekly orchestration unavailable.',
          summary: 'No reliable weekly posture could be built for this request.',
          confidence: 'low',
          reasons: [],
          affectedSkills: ['secretary'],
        },
        nextBestAction: null,
        blockers: [],
        suggestedMoves: [],
        protectedBlocks: [],
        risks: [],
        crossSkillImpacts: [],
      },
    });

    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    const result = await composeDailyBrief({ userId: 12, date: '2026-04-15' });

    expect(result.coordination.topPriority).toBe('cached');
    expect(result.timezone).toBe('Europe/Lisbon');
    expect(result.degraded).toBe(true);
    expect(result.warningCodes).toContain('PLANNING_SOURCE_HEALTH_UNAVAILABLE');
    expect(result.sourceHealth.calendar.status).toBe('unavailable');
    expect(result.sourceHealth.decision_center.status).toBe('unavailable');
    expect(mockGetCached).toHaveBeenCalledWith(
      expect.stringContaining(`:content-policy:${CONTENT_AGENT_LIFECYCLE_POLICY_VERSION}`),
    );
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
  });

  it('treats a caller-supplied canonical week as authoritative over the Today cache', async () => {
    mockGetCached.mockReturnValue({
      day: { date: '2026-04-15', headline: 'Stale cached day.' },
    });
    const suppliedWeek = minimalWeekWithCalendarStatus('ready');
    suppliedWeek.days[0].headline = 'Fresh day from the supplied canonical week.';

    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    const result = await composeDailyBrief({
      userId: 12,
      date: '2026-04-15',
      weekPlan: suppliedWeek,
    });

    expect(mockGetCached).not.toHaveBeenCalled();
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
    expect(result.day).toBe(suppliedWeek.days[0]);
    expect(result.day.headline).toBe('Fresh day from the supplied canonical week.');
  });

  it('keeps English, PT-BR, PT-PT, and adjacent date cache identities distinct', async () => {
    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    const weekPlan = minimalWeekWithCalendarStatus('ready') as NonNullable<
      Parameters<typeof composeDailyBrief>[0]['weekPlan']
    >;
    mockComposeWeeklyPlan.mockResolvedValue(weekPlan);
    await composeDailyBrief({ userId: 12, date: '2026-04-15', language: 'en-US' });
    await composeDailyBrief({ userId: 12, date: '2026-04-15', language: 'pt-BR' });
    await composeDailyBrief({ userId: 12, date: '2026-04-15', language: 'pt-PT' });
    await composeDailyBrief({ userId: 12, date: '2026-04-16', language: 'en-US' });

    const keys = mockGetCached.mock.calls.map(([key]) => String(key));
    expect(keys).toEqual(expect.arrayContaining([
      expect.stringContaining(':t:12:2026-04-15:tz:Europe/Lisbon:lang:en-US'),
      expect.stringContaining(':t:12:2026-04-15:tz:Europe/Lisbon:lang:pt-BR'),
      expect.stringContaining(':t:12:2026-04-15:tz:Europe/Lisbon:lang:pt-PT'),
      expect.stringContaining(':t:12:2026-04-16:tz:Europe/Lisbon:lang:en-US'),
    ]));
    expect(new Set(keys).size).toBe(4);
  });

  it('returns a degraded runtime fallback when weekly-plan composition fails', async () => {
    mockComposeWeeklyPlan.mockRejectedValueOnce(new Error('weekly compose failed'));

    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    const result = await composeDailyBrief({
      userId: 12,
      date: '2026-04-15',
      language: 'pt-PT',
      forceRefresh: true,
    });

    expect(result.degraded).toBe(true);
    expect(result.contentPlan.planStatus).toBe('unavailable');
    expect(result.date).toBe('2026-04-15');
    expect(result.day.date).toBe('2026-04-15');
    expect(result.day.headline).toContain('temporariamente indisponível');
    expect(result.coordination.dayOrchestration.title).toBe('Orquestração diária temporariamente indisponível.');
    expect(result.coordination.weekOrchestration.title).toBe('Orquestração semanal temporariamente indisponível.');
  });

  it('keeps the requested target date when the weekly plan does not include that day', async () => {
    mockComposeWeeklyPlan.mockResolvedValue({
      degraded: false,
      gated: { skills: [] },
      garmin_stale: false,
      creativeCopy: { headline: 'Balanced week', note: 'Stay steady.' },
      contentPlan: {
        authority: 'secretary',
        authorityStatus: 'partially_unavailable',
        planStatus: 'partial',
        semantics: 'private_work_session',
        confirmedBlockCount: 0,
        confirmedBlocksComplete: true,
        attentionCount: 1,
        deadlineCount: 0,
      },
      conflicts: [],
      days: [
        {
          date: '2026-04-14',
          weekday: 'Tuesday',
          headline: 'Carry on.',
          training: {
            title: 'Easy run',
            type: 'run',
            status: 'planned',
            durationMinutes: 40,
            intensity: 'Easy',
            reason: 'Normal day.',
            decisions: [],
          },
          meals: [],
          content: null,
          secretary: {
            focusBlock: null,
            pendingTasks: 0,
            overdueTasks: 0,
            travel: false,
            busy: false,
            priorityNote: null,
            sequence: [],
            tradeoffNote: null,
            decisions: [],
          },
          finance: null,
        },
      ],
    });

    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    const result = await composeDailyBrief({
      userId: 12,
      date: '2026-04-15',
      language: 'en-US',
      forceRefresh: true,
    });

    expect(result.date).toBe('2026-04-15');
    expect(result.day.date).toBe('2026-04-15');
    expect(result.day.weekday).toBe('Wednesday');
    expect(result.degraded).toBe(true);
    expect(result.contentPlan).toMatchObject({
      authorityStatus: 'partially_unavailable',
      planStatus: 'partial',
    });
    expect(result.coordination.dayOrchestration.title).toBe('Daily orchestration temporarily unavailable.');
  });
});
