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

    expect(result.coordination.topPriority).toBe('Protect Track intervals as a high-immovability training block.');
    expect(result.coordination.executionOrder).toEqual([
      'Protect the key training window before moving meetings, errands, or filming onto the day.',
      'Lock meal or shopping coverage before the session so training support is not left to chance.',
      'Reserve a real publish/delivery slot so content ships deliberately instead of becoming leftover work.',
    ]);
    expect(result.coordination.watchouts).toEqual(
      expect.arrayContaining([
        'Recovery is strained — keep training conservative and easy to absorb.',
        'Training is the anchor, meals need closing before it, publishing still needs a real slot, and filming should only use whatever bandwidth remains after all three are protected.',
        'Same-priority conflict on 2026-04-15: publish vs shoot',
      ]),
    );
    expect(result.coordination.handoffs).toEqual([
      'Training depends on meal coverage landing before the key session.',
      'Content should follow the protected training and fueling commitments instead of displacing them.',
      'Keep the content execution path aligned with the current finance constraints for the week.',
    ]);
  });

  it('fails closed and records an anomaly when tenant scope is invalid', async () => {
    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    const result = await composeDailyBrief({ userId: 0, date: '2026-04-15', forceRefresh: true });

    expect(result.degraded).toBe(true);
    expect(result.date).toBe('2026-04-15');
    expect(result.day.date).toBe('2026-04-15');
    expect(result.day.headline).toContain('tenant scope is invalid');
    expect(result.coordination).toEqual({
      topPriority: null,
      executionOrder: [],
      watchouts: [],
      handoffs: [],
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
      },
    });

    const { composeDailyBrief } = await import('../../src/services/daily-brief-orchestrator');
    const result = await composeDailyBrief({ userId: 12, date: '2026-04-15' });

    expect(result.coordination.topPriority).toBe('cached');
    expect(mockComposeWeeklyPlan).not.toHaveBeenCalled();
  });
});
