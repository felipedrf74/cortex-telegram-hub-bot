import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

const mockGetCached = vi.fn(() => null);
const mockSetCache = vi.fn();
const mockComposeWeeklyPlan = vi.fn();

vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
}));

vi.mock('../../src/services/weekly-plan-orchestrator', () => ({
  composeWeeklyPlan: (...args: unknown[]) => mockComposeWeeklyPlan(...args),
}));

describe('daily-brief-orchestrator', () => {
  beforeEach(() => {
    clearTenantScopeAnomaliesForTests();
    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockComposeWeeklyPlan.mockReset();
  });

  it('builds event-driven coordination from the selected day', async () => {
    mockComposeWeeklyPlan.mockResolvedValue({
      degraded: false,
      gated: { skills: [] },
      garmin_stale: false,
      creativeCopy: { headline: 'Balanced week', note: 'Stay steady.' },
      conflicts: [
        {
          id: '2026-04-15:primary-commitment:2',
          date: '2026-04-15',
          target: 'primary-commitment',
          signalIds: [1, 2],
          signalTypes: ['publishing_commitment', 'shoot_day_locked'],
          meshPriority: 2,
          message: 'Same-priority conflict on 2026-04-15: publish vs shoot',
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
          content: {
            status: 'scheduled',
            title: 'Capture + publishing day',
            note: 'Publishing is due for Race-week recap. Use the filming block as the capture pass, then finish the publishing handoff the same day.',
            blockStart: '2026-04-15T11:00:00.000Z',
            blockEnd: '2026-04-15T13:00:00.000Z',
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
              'Reserve a real publish/delivery slot so content ships deliberately instead of becoming leftover work.',
            ],
            tradeoffNote: 'Training is the anchor, meals need closing before it, publishing still needs a real slot, and filming should only use whatever bandwidth remains after all three are protected.',
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

    expect(result.coordination.topPriority).toBe('Keep the day light and recoverable.');
    expect(result.coordination.executionOrder).toEqual(
      expect.arrayContaining([
        'Keep the day light and recoverable.',
        'Batch overdue work into one short block.',
        'Use 12:00–14:00 to ship.',
        'Protect the key training window before moving meetings, errands, or filming onto the day.',
        'Lock meal or shopping coverage before the session so training support is not left to chance.',
      ]),
    );
    expect(result.coordination.dayOrchestration.posture).toBe('recovery_protected_day');
    expect(result.coordination.weekOrchestration.posture).toBe('consistency');
    expect(result.coordination.nextBestAction?.kind).toBe('lighten_day');
    expect(result.coordination.blockers.map((blocker) => blocker.kind)).toEqual(
      expect.arrayContaining(['task_pressure', 'deadline_collision']),
    );
    expect(result.coordination.watchouts).toEqual(
      expect.arrayContaining([
        'There are 1 overdue tasks, 0 due today, and 0 unread emails in play.',
        'Same-priority conflict on 2026-04-15: publish vs shoot',
      ]),
    );
    expect(result.coordination.handoffs).toEqual(
      expect.arrayContaining([
        'Training is pulling the day toward less friction and less load.',
        'Content has a good window, but it needs shipping, not more prep.',
        'The aligned meal helps keep training and schedule more executable.',
      ]),
    );
  });

  it('fails closed in Portuguese and records an anomaly when tenant scope is invalid', async () => {
    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    const result = await composeDailyBrief({
      userId: 0,
      date: '2026-04-15',
      language: 'pt-PT',
      forceRefresh: true,
    });

    expect(result.degraded).toBe(true);
    expect(result.date).toBe('2026-04-15');
    expect(result.day.date).toBe('2026-04-15');
    expect(result.day.weekday.toLowerCase()).toContain('quarta');
    expect(result.day.headline).toContain('contexto desta conta não é válido');
    expect(result.coordination).toEqual({
      topPriority: null,
      executionOrder: [],
      watchouts: [],
      handoffs: [],
      confidence: 'low',
      dayOrchestration: {
        posture: 'stable_day',
        title: 'Orquestração diária indisponível.',
        summary: 'Não foi possível montar uma postura de agenda fiável para este pedido.',
        confidence: 'low',
        mainThing: null,
        reasons: [],
        affectedSkills: ['secretary'],
      },
      secretaryToday: {
        title: 'Secretary hoje',
        summary: 'A orquestração diária ainda não tem estado operacional fiável para mostrar.',
        checked: [],
        handled: [],
        needsUser: [],
        waitingOnSource: [],
        nextBestMove: null,
        counts: {
          checked: 0,
          handled: 0,
          needsUser: 0,
          waitingOnSource: 0,
        },
      },
      weekOrchestration: {
        posture: 'stable',
        title: 'Orquestração semanal indisponível.',
        summary: 'Não foi possível montar uma postura semanal fiável para este pedido.',
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
    });
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()[0]).toMatchObject({
      layer: 'orchestration',
      operation: 'compose_daily_brief',
      reason: 'invalid_user_scope',
      userId: 0,
      details: { date: '2026-04-15' },
    });
  });

  it('fails closed in English when no Portuguese language bucket is requested', async () => {
    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    const result = await composeDailyBrief({
      userId: 0,
      date: '2026-04-15',
      language: 'en-US',
      forceRefresh: true,
    });

    expect(result.degraded).toBe(true);
    expect(result.day.weekday).toBe('Wednesday');
    expect(result.day.headline).toContain('tenant scope is invalid');
    expect(result.coordination.dayOrchestration.title).toBe('Daily orchestration unavailable.');
    expect(result.coordination.weekOrchestration.title).toBe('Weekly orchestration unavailable.');
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
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
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
    expect(result.coordination.dayOrchestration.title).toBe('Daily orchestration temporarily unavailable.');
  });
});
