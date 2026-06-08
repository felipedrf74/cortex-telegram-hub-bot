import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetEventsWithDiagnostics = vi.fn();

vi.mock('../../src/services/unified-calendar', () => ({
  getEventsWithDiagnostics: (...args: unknown[]) => mockGetEventsWithDiagnostics(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import { loadLiveCalendarBusyWindowsForSecretaryIntent } from '../../src/services/secretary-live-calendar-busy';
import type { SecretarySchedulingIntent } from '../../src/services/secretary-scheduling-arbitrator';

function intent(overrides: Partial<SecretarySchedulingIntent> = {}): SecretarySchedulingIntent {
  return {
    intentId: 'intent-live-busy-test',
    sourceSkill: 'content',
    sourceAction: 'schedule_content_block',
    ownerUserId: 42,
    tenantId: 42,
    title: 'Schedule work',
    action: 'find_time_for_this',
    requestedDurationMinutes: 60,
    preferredWindows: [{ start: '2026-06-01T09:00:00Z', end: '2026-06-01T12:00:00Z' }],
    priority: 'normal',
    flexibility: 'flexible',
    reason: 'test',
    createdAt: '2026-05-31T10:00:00Z',
    updatedAt: '2026-05-31T10:00:00Z',
    ...overrides,
  };
}

describe('secretary-live-calendar-busy', () => {
  beforeEach(() => {
    mockGetEventsWithDiagnostics.mockReset();
  });

  it('returns ledger-only windows without degradation when no provider is connected', async () => {
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [],
      status: 'unavailable',
      warningCodes: ['CALENDAR_INTEGRATION_MISSING'],
      warnings: ['No calendar integration is connected yet.'],
      sources: { configured: [], fulfilled: [], failed: [] },
    });

    const result = await loadLiveCalendarBusyWindowsForSecretaryIntent(intent());

    expect(result).toEqual({
      windows: [],
      degraded: false,
      providerConfigured: false,
      warningCodes: ['CALENDAR_INTEGRATION_MISSING'],
      warnings: ['No calendar integration is connected yet.'],
    });
    expect(mockGetEventsWithDiagnostics).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      42,
    );
  });

  it('marks the result degraded when configured providers fail', async () => {
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [],
      status: 'unavailable',
      warningCodes: ['GOOGLE_CALENDAR_UNAVAILABLE'],
      warnings: ['Google Calendar is unavailable right now.'],
      sources: { configured: ['google'], fulfilled: [], failed: ['google'] },
    });

    const result = await loadLiveCalendarBusyWindowsForSecretaryIntent(intent());

    expect(result.degraded).toBe(true);
    expect(result.providerConfigured).toBe(true);
    expect(result.warningCodes).toEqual(['GOOGLE_CALENDAR_UNAVAILABLE']);
    expect(result.windows).toEqual([]);
  });

  it('maps live provider events into Secretary busy windows', async () => {
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [{
        summary: 'Team sync',
        start: '2026-06-01T10:00:00+01:00',
        end: '2026-06-01T10:30:00+01:00',
        source: 'google',
      }],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
    });

    const result = await loadLiveCalendarBusyWindowsForSecretaryIntent(intent());

    expect(result).toMatchObject({
      degraded: false,
      providerConfigured: true,
      warningCodes: [],
      warnings: [],
      windows: [{
        start: '2026-06-01T09:00:00.000Z',
        end: '2026-06-01T09:30:00.000Z',
        label: 'Team sync',
      }],
    });
  });
});
