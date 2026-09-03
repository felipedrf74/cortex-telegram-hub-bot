import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveSecretaryPlanningContext = vi.hoisted(() => vi.fn());
const mockComposeWeeklyPlan = vi.hoisted(() => vi.fn());
const mockBuildSecretaryDaySnapshot = vi.hoisted(() => vi.fn());
const mockComposeDailyBrief = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/secretary-planning-context', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/secretary-planning-context')>(
    '../../src/services/secretary-planning-context',
  )),
  resolveSecretaryPlanningContext: (...args: unknown[]) => mockResolveSecretaryPlanningContext(...args),
  planLanguageLocale: (language: string) => language,
}));

vi.mock('../../src/services/weekly-plan-orchestrator', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/weekly-plan-orchestrator')>(
    '../../src/services/weekly-plan-orchestrator',
  )),
  composeWeeklyPlan: (...args: unknown[]) => mockComposeWeeklyPlan(...args),
}));

vi.mock('../../src/services/secretary-planning-snapshot', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/secretary-planning-snapshot')>(
    '../../src/services/secretary-planning-snapshot',
  )),
  buildSecretaryDaySnapshot: (...args: unknown[]) => mockBuildSecretaryDaySnapshot(...args),
}));

vi.mock('../../src/services/daily-brief-orchestrator', () => ({
  composeDailyBrief: (...args: unknown[]) => mockComposeDailyBrief(...args),
}));

import {
  composeSecretaryScheduledPlanningSnapshot,
  projectSecretaryScheduledReport,
} from '../../src/services/secretary-scheduled-report';

const sourceHealth = {
  calendar: { status: 'ready', warningCodes: [], warnings: [] },
  tasks: { status: 'ready', warningCodes: [], warnings: [] },
  mail: { status: 'ready', warningCodes: [], warnings: [] },
  focus: { status: 'ready', warningCodes: [], warnings: [] },
  training: { status: 'ready', warningCodes: [], warnings: [] },
  cooking: { status: 'ready', warningCodes: [], warnings: [] },
  content: { status: 'ready', warningCodes: [], warnings: [] },
  finance: { status: 'ready', warningCodes: [], warnings: [] },
} as const;

const dailySourceHealth = {
  ...sourceHealth,
  decision_center: {
    status: 'unavailable',
    warningCodes: ['DECISION_CENTER_UNAVAILABLE'],
    warnings: ['Decision Center state is unavailable.'],
  },
} as const;

function fixtures(language: 'en-US' | 'pt-BR' | 'pt-PT' = 'en-US') {
  const context = {
    userId: 77,
    tenantId: 77,
    timezone: 'Pacific/Kiritimati',
    language,
    targetDate: '2026-08-31',
    weekStart: '2026-08-31',
    weekEnd: '2026-09-06',
    user: { id: 77 },
    warningCodes: [],
    warnings: [],
  } as any;
  const day = {
    date: '2026-08-31',
    weekday: 'Monday',
    headline: 'Calendar confirmation is still required.',
    training: {
      title: 'Rest', type: 'rest', status: 'rest', durationMinutes: null,
      intensity: null, reason: 'Recovery day', decisions: [],
    },
    meals: [],
    content: null,
    secretary: {
      focusBlock: null, pendingTasks: 2, overdueTasks: 1, travel: false,
      busy: false, priorityNote: null, sequence: [], tradeoffNote: null, decisions: [],
    },
    finance: null,
  } as any;
  const week = {
    weekStart: '2026-08-31',
    weekEnd: '2026-09-06',
    generatedAt: '2026-08-30T12:00:00.000Z',
    timezone: 'Pacific/Kiritimati',
    warningCodes: [],
    warnings: [],
    sourceHealth,
    variant: 'steady',
    degraded: true,
    gated: { skills: [] },
    garmin_stale: false,
    conflicts: [],
    creativeCopy: { headline: '', note: '' },
    summary: { sessionCount: 0, mealCount: 0, activeConflictCount: 0 },
    days: [day],
  } as any;
  const today = {
    context,
    week,
    date: context.targetDate,
    day,
    conflicts: [],
    timezone: context.timezone,
    warningCodes: week.warningCodes,
    warnings: week.warnings,
    sourceHealth,
  } as any;
  const daily = {
    date: context.targetDate,
    generatedAt: week.generatedAt,
    timezone: context.timezone,
    warningCodes: ['DECISION_CENTER_UNAVAILABLE'],
    warnings: ['Decision Center state is unavailable.'],
    sourceHealth: dailySourceHealth,
    degraded: true,
    gated: week.gated,
    garmin_stale: false,
    conflicts: [],
    creativeCopy: week.creativeCopy,
    day,
    coordination: { confidence: 'low' },
  } as any;
  return { context, week, today, daily };
}

describe('Secretary scheduled report snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves one canonical context, composes one week, and derives today from that exact week', async () => {
    const { context, week, today, daily } = fixtures();
    mockResolveSecretaryPlanningContext.mockReturnValue(context);
    mockComposeWeeklyPlan.mockResolvedValue(week);
    mockBuildSecretaryDaySnapshot.mockReturnValue(today);
    mockComposeDailyBrief.mockResolvedValue(daily);

    const result = await composeSecretaryScheduledPlanningSnapshot({
      userId: 77,
      tenantId: 77,
      localDate: '2026-08-31',
    });

    expect(mockResolveSecretaryPlanningContext).toHaveBeenCalledOnce();
    expect(mockResolveSecretaryPlanningContext).toHaveBeenCalledWith({
      userId: 77,
      tenantId: 77,
      date: '2026-08-31',
    });
    expect(mockComposeWeeklyPlan).toHaveBeenCalledOnce();
    expect(mockComposeWeeklyPlan).toHaveBeenCalledWith({
      userId: 77,
      tenantId: 77,
      weekStart: '2026-08-31',
      language: 'en-US',
      context,
      forceRefresh: true,
      cacheMode: 'bypass',
    });
    expect(mockBuildSecretaryDaySnapshot).toHaveBeenCalledOnce();
    const dayInput = mockBuildSecretaryDaySnapshot.mock.calls[0]?.[0];
    expect(dayInput.context).toBe(context);
    expect(dayInput.week).toBe(week);
    expect(mockComposeDailyBrief).toHaveBeenCalledOnce();
    expect(mockComposeDailyBrief).toHaveBeenCalledWith({
      userId: 77,
      tenantId: 77,
      date: '2026-08-31',
      language: 'en-US',
      context,
      weekPlan: week,
      daySnapshot: today,
      forceRefresh: true,
      cacheMode: 'bypass',
    });
    expect(result).toEqual({ context, week, today, daily });
  });

  it('projects every report from the same timezone-aware snapshot without hiding source failure', () => {
    const snapshot = fixtures();

    const morning = projectSecretaryScheduledReport(snapshot, 'morning_briefing');
    const evening = projectSecretaryScheduledReport(snapshot, 'evening_summary');
    const weekly = projectSecretaryScheduledReport(snapshot, 'weekly_review');

    expect(morning.title).toBe('☀️ Monday, August 31');
    expect(morning.summary).toBe('Decision Center state is unavailable.');
    expect(evening.summary).toBe(morning.summary);
    expect(weekly.summary).toBe('2026-08-31 – 2026-09-06');
    for (const report of [morning, evening]) {
      expect(report.documentJson).toMatchObject({
        timezone: 'Pacific/Kiritimati',
        localDate: '2026-08-31',
        weekStart: '2026-08-31',
        weekEnd: '2026-09-06',
        warningCodes: ['DECISION_CENTER_UNAVAILABLE'],
        warnings: ['Decision Center state is unavailable.'],
        sourceHealth: { decision_center: { status: 'unavailable' } },
        degraded: true,
      });
      expect(JSON.stringify(report.documentJson)).not.toContain('"events":0');
      expect(JSON.stringify(report.documentJson)).not.toContain('"userId":77');
    }
    expect(morning.documentJson.planningSnapshot).toBe(snapshot.daily);
    expect(evening.documentJson.planningSnapshot).toBe(snapshot.daily);
    expect(weekly.documentJson).toMatchObject({
      warningCodes: [],
      warnings: [],
      sourceHealth: { calendar: { status: 'ready' } },
    });
    expect(weekly.documentJson.planningSnapshot).toBe(snapshot.week);
  });

  it('localizes deterministic report copy for Brazilian and European Portuguese', () => {
    for (const [language, eveningTitle, fallback] of [
      ['pt-BR', 'Resumo do fim do dia', 'Planejamento de 2026-08-31'],
      ['pt-PT', 'Resumo do final do dia', 'Planeamento de 2026-08-31'],
    ] as const) {
      const snapshot = fixtures(language);
      snapshot.daily.sourceHealth = sourceHealth as any;
      snapshot.daily.day.headline = '';

      expect(projectSecretaryScheduledReport(snapshot, 'weekly_review').title)
        .toBe('📊 Resumo da semana');
      const evening = projectSecretaryScheduledReport(snapshot, 'evening_summary');
      expect(evening.title).toBe(eveningTitle);
      expect(evening.summary).toBe(fallback);
    }
  });
});
