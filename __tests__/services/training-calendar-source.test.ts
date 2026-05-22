import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isConnected: vi.fn(),
  resolveCalendarWritePreference: vi.fn(),
}));

vi.mock('../../src/services/oauth-store', () => ({
  isConnected: (...args: unknown[]) => mocks.isConnected(...args),
}));

vi.mock('../../src/services/provider-preferences', () => ({
  resolveCalendarWritePreference: (...args: unknown[]) => mocks.resolveCalendarWritePreference(...args),
}));

import {
  resolveTrainingCalendarSource,
  validateRequestedTrainingCalendarSource,
} from '../../src/services/training-calendar-source';

describe('training-calendar-source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED;
    delete process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED;
    delete process.env.TRAINING_CALENDAR_WRITES_ENABLED;
    delete process.env.TRAINING_CALENDAR_WRITES_DISABLED;
    delete process.env.TRAINING_CALENDAR_SYNC_ENABLED;
    delete process.env.TRAINING_CALENDAR_SYNC_DISABLED;

    mocks.resolveCalendarWritePreference.mockReturnValue({ requested: 'auto', source: null });
    mocks.isConnected.mockImplementation((_userId: number, source: string) => (
      source === 'google' || source === 'outlook'
    ));
  });

  it('rejects requested Outlook sync while the Training Outlook gate is disabled', () => {
    const result = validateRequestedTrainingCalendarSource(42, 'outlook');

    expect(result).toMatchObject({
      ok: false,
      code: 'CALENDAR_SOURCE_DISABLED',
      status: 503,
    });
  });

  it('resolves Google in auto mode when Outlook is connected but gated', () => {
    mocks.resolveCalendarWritePreference.mockReturnValue({ requested: 'auto', source: 'outlook' });

    const source = resolveTrainingCalendarSource({ userId: 42, tenantId: 42 });

    expect(source).toBe('google');
  });

  it('resolves Outlook only after the explicit Training Outlook gate is enabled', () => {
    process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED = 'true';

    const source = resolveTrainingCalendarSource({ userId: 42, tenantId: 42 });

    expect(source).toBe('outlook');
  });

  it('does not silently switch an Outlook-pinned plan to Google while Outlook is gated', () => {
    const source = resolveTrainingCalendarSource({
      userId: 42,
      tenantId: 42,
      planPreferencesJson: JSON.stringify({ trainingCalendarSource: 'outlook' }),
    });

    expect(source).toBeUndefined();
  });

  it('does not silently switch an explicit Outlook provider preference to Google while Outlook is gated', () => {
    mocks.resolveCalendarWritePreference.mockReturnValue({ requested: 'outlook', source: 'outlook' });

    const source = resolveTrainingCalendarSource({ userId: 42, tenantId: 42 });

    expect(source).toBeUndefined();
  });
});
