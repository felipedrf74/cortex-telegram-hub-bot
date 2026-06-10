import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSubmitSecretarySchedulingIntent = vi.fn();
const mockPreviewSecretarySchedulingIntent = vi.fn();

vi.mock('../../src/services/secretary-scheduling-arbitrator', () => ({
  previewSecretarySchedulingIntent: (...args: unknown[]) => mockPreviewSecretarySchedulingIntent(...args),
  submitSecretarySchedulingIntent: (...args: unknown[]) => mockSubmitSecretarySchedulingIntent(...args),
}));

import {
  buildCookingMealPrepSchedulingIntent,
  previewCookingMealPrepSchedulingIntent,
  submitCookingMealPrepSchedulingIntent,
} from '../../src/services/cooking-secretary-integration';

describe('cooking-secretary-integration', () => {
  beforeEach(() => {
    mockSubmitSecretarySchedulingIntent.mockReset();
    mockPreviewSecretarySchedulingIntent.mockReset();
  });

  it('builds meal-prep scheduling intents owned by Secretary', () => {
    const intent = buildCookingMealPrepSchedulingIntent({
      userId: 42,
      tenantId: 42,
      week: '2026-W23',
      title: 'Meal prep',
      startIso: '2026-06-07T14:00:00Z',
      endIso: '2026-06-07T16:00:00Z',
      durationMinutes: 120,
      mealCount: 5,
      additionalBusyWindows: [],
    });

    expect(intent).toMatchObject({
      intentId: 'cooking:meal-prep:42:42:2026-W23:2026-06-07T14:00:00Z:120',
      sourceSkill: 'cooking',
      sourceAction: 'schedule_meal_prep',
      sourceEntityType: 'meal_prep_block',
      ownerUserId: 42,
      tenantId: 42,
      flexibility: 'fixed',
    });
  });

  it('requires callers to provide live calendar busy windows explicitly', () => {
    expect(() => submitCookingMealPrepSchedulingIntent({
      userId: 42,
      week: '2026-W23',
      title: 'Meal prep',
      startIso: '2026-06-07T14:00:00Z',
      endIso: '2026-06-07T16:00:00Z',
      durationMinutes: 120,
      mealCount: 5,
    })).toThrow('COOKING_SECRETARY_LIVE_BUSY_WINDOWS_REQUIRED');
  });

  it('fails closed when live calendar busy-window loading is degraded', () => {
    expect(() => previewCookingMealPrepSchedulingIntent({
      userId: 42,
      week: '2026-W23',
      title: 'Meal prep',
      startIso: '2026-06-07T14:00:00Z',
      endIso: '2026-06-07T16:00:00Z',
      durationMinutes: 120,
      mealCount: 5,
      additionalBusyWindows: [],
      liveBusyWindowsDegraded: true,
    })).toThrow('COOKING_SECRETARY_LIVE_BUSY_WINDOWS_DEGRADED');
    expect(mockPreviewSecretarySchedulingIntent).not.toHaveBeenCalled();
  });

  it('passes supplied busy windows through to Secretary', () => {
    mockSubmitSecretarySchedulingIntent.mockReturnValue({ status: 'scheduled' });
    const busy = [{ start: '2026-06-07T14:30:00Z', end: '2026-06-07T15:00:00Z', label: 'Calendar event' }];

    const decision = submitCookingMealPrepSchedulingIntent({
      userId: 42,
      week: '2026-W23',
      title: 'Meal prep',
      startIso: '2026-06-07T14:00:00Z',
      endIso: '2026-06-07T16:00:00Z',
      durationMinutes: 120,
      mealCount: 5,
      additionalBusyWindows: busy,
    });

    expect(decision).toEqual({ status: 'scheduled' });
    expect(mockSubmitSecretarySchedulingIntent).toHaveBeenCalledWith(expect.objectContaining({
      sourceSkill: 'cooking',
    }), { additionalBusyWindows: busy });
  });
});
