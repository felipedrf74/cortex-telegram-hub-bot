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

  it('keeps real other-provider meetings in the busy set when Training writes elsewhere', async () => {
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [{
        id: 'google-client-meeting-1',
        summary: 'Google client meeting',
        start: '2026-06-01T10:00:00Z',
        end: '2026-06-01T11:00:00Z',
        source: 'google',
      }],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google', 'outlook'], fulfilled: ['google', 'outlook'], failed: [] },
    });

    const result = await loadLiveCalendarBusyWindowsForSecretaryIntent(intent({
      sourceSkill: 'training',
      softPreferences: { calendarProvider: 'outlook' },
    }));

    expect(mockGetEventsWithDiagnostics).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      42,
    );
    expect(result.windows).toEqual([{
      start: '2026-06-01T10:00:00.000Z',
      end: '2026-06-01T11:00:00.000Z',
      label: 'Google client meeting',
      providerIdentity: {
        providerEventId: 'google-client-meeting-1',
        providerSource: 'google',
        ownerUserId: 42,
        tenantId: '42',
        agendaItemId: null,
        trainingIdentity: null,
      },
    }]);
  });

  it('keeps Training-owned events hard-visible with exact provider and marker identity', async () => {
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [
        {
          id: 'google-training-1',
          summary: 'Upper Body Strength',
          start: '2026-06-01T09:00:00Z',
          end: '2026-06-01T09:45:00Z',
          source: 'google',
          description: 'Workout\n\n[NEXUS_TRAINING_IDENTITY plan=1;version=2;session=3;key=abc;shape=def]',
        },
        {
          id: 'outlook-training-legacy-1',
          summary: 'Lower Body Strength',
          start: '2026-06-01T10:00:00Z',
          end: '2026-06-01T10:45:00Z',
          source: 'outlook',
          description: [
            'Workout',
            'NEXUS_SECRETARY_SOURCE_SKILL:training',
            'NEXUS_SECRETARY_SOURCE_INTENT:training:1:2:4',
          ].join('\n'),
        },
      ],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google', 'outlook'], fulfilled: ['google', 'outlook'], failed: [] },
    });

    const result = await loadLiveCalendarBusyWindowsForSecretaryIntent(intent({
      sourceSkill: 'training',
      softPreferences: { calendarProvider: 'outlook' },
    }));

    // Stronger guarantee: owned-looking events are no longer dropped by the
    // fetch layer. The planner may disregard one only after an exact durable
    // agenda mapping and strict marker match; legacy source lines stay hard.
    expect(result.windows).toEqual([
      {
        start: '2026-06-01T09:00:00.000Z',
        end: '2026-06-01T09:45:00.000Z',
        label: 'Upper Body Strength',
        providerIdentity: {
          providerEventId: 'google-training-1',
          providerSource: 'google',
          ownerUserId: 42,
          tenantId: '42',
          agendaItemId: null,
          trainingIdentity: {
            planId: 1,
            planVersion: 2,
            sessionId: 3,
            sessionIdentityKey: 'abc',
            sessionShapeHash: 'def',
          },
        },
      },
      {
        start: '2026-06-01T10:00:00.000Z',
        end: '2026-06-01T10:45:00.000Z',
        label: 'Lower Body Strength',
        providerIdentity: {
          providerEventId: 'outlook-training-legacy-1',
          providerSource: 'outlook',
          ownerUserId: 42,
          tenantId: '42',
          agendaItemId: null,
          trainingIdentity: null,
        },
      },
    ]);
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
        id: 'google-team-sync-1',
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
        providerIdentity: {
          providerEventId: 'google-team-sync-1',
          providerSource: 'google',
          ownerUserId: 42,
          tenantId: '42',
          agendaItemId: null,
          trainingIdentity: null,
        },
      }],
    });
  });

  it('preserves an exact Secretary agenda marker without exposing it as display text', async () => {
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [{
        id: 'outlook-secretary-marked-1',
        summary: 'Meal prep',
        start: '2026-06-01T10:00:00Z',
        end: '2026-06-01T11:00:00Z',
        source: 'outlook',
        description: '<p>Source: Nexus Hub secretary.</p><p>NEXUS_SECRETARY_AGENDA_ITEM:sec_agenda_abc</p>',
      }],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['outlook'], fulfilled: ['outlook'], failed: [] },
    });

    const result = await loadLiveCalendarBusyWindowsForSecretaryIntent(intent());

    expect(result.windows).toEqual([{
      start: '2026-06-01T10:00:00.000Z',
      end: '2026-06-01T11:00:00.000Z',
      label: 'Meal prep',
      providerIdentity: {
        providerEventId: 'outlook-secretary-marked-1',
        providerSource: 'outlook',
        ownerUserId: 42,
        tenantId: '42',
        agendaItemId: 'sec_agenda_abc',
        trainingIdentity: null,
      },
    }]);
    expect(JSON.stringify(result.windows)).not.toContain('NEXUS_SECRETARY_AGENDA_ITEM');
  });

  it('keeps ambiguous markers and events without provider ids hard-unidentified', async () => {
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [
        {
          id: 'google-ambiguous-marker',
          summary: 'Ambiguous owned-looking event',
          start: '2026-06-01T10:00:00Z',
          end: '2026-06-01T11:00:00Z',
          source: 'google',
          description: [
            'NEXUS_SECRETARY_AGENDA_ITEM:sec_first',
            'NEXUS_SECRETARY_AGENDA_ITEM:sec_second',
            '[NEXUS_TRAINING_IDENTITY plan=1;version=1;session=1;key=a;shape=b]',
            '[NEXUS_TRAINING_IDENTITY plan=1;version=1;session=2;key=c;shape=d]',
          ].join('\n'),
        },
        {
          id: '',
          summary: 'Provider event without durable id',
          start: '2026-06-01T11:00:00Z',
          end: '2026-06-01T12:00:00Z',
          source: 'outlook',
        },
      ],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google', 'outlook'], fulfilled: ['google', 'outlook'], failed: [] },
    });

    const result = await loadLiveCalendarBusyWindowsForSecretaryIntent(intent());

    expect(result.windows).toEqual([
      {
        start: '2026-06-01T10:00:00.000Z',
        end: '2026-06-01T11:00:00.000Z',
        label: 'Ambiguous owned-looking event',
        providerIdentity: {
          providerEventId: 'google-ambiguous-marker',
          providerSource: 'google',
          ownerUserId: 42,
          tenantId: '42',
          agendaItemId: null,
          trainingIdentity: null,
        },
      },
      {
        start: '2026-06-01T11:00:00.000Z',
        end: '2026-06-01T12:00:00.000Z',
        label: 'Provider event without durable id',
      },
    ]);
  });
});
