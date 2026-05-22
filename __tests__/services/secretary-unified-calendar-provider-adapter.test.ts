import { beforeEach, describe, expect, it, vi } from 'vitest';

const unifiedCalendar = vi.hoisted(() => ({
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
}));

const googleCalendar = vi.hoisted(() => ({
  getEvents: vi.fn(),
}));

const outlookCalendar = vi.hoisted(() => ({
  getEvents: vi.fn(),
}));

const trainingPlans = vi.hoisted(() => ({
  getSessionById: vi.fn(),
}));

vi.mock('../../src/services/unified-calendar', () => unifiedCalendar);
vi.mock('../../src/services/google-calendar', () => googleCalendar);
vi.mock('../../src/services/outlook-calendar', () => outlookCalendar);
vi.mock('../../src/services/training-plans', () => trainingPlans);

import {
  buildSecretaryCalendarDescription,
  createUnifiedCalendarSecretaryProviderAdapter,
  extractSecretaryAgendaMarker,
} from '../../src/services/secretary-unified-calendar-provider-adapter';
import type { SecretaryProviderEventInput } from '../../src/services/secretary-agenda-provider-sync';

const input: SecretaryProviderEventInput = {
  agendaItemId: 'sec_agenda_123',
  sourceIntentId: 'intent_123',
  sourceSkill: 'training',
  sourceEntityId: 'session_123',
  sourceEntityType: 'training_session',
  ownerUserId: 42,
  tenantId: 'tenant-a',
  version: 3,
  title: 'Endurance ride',
  startAt: '2026-05-04T09:00:00.000Z',
  endAt: '2026-05-04T10:00:00.000Z',
  durationMinutes: 60,
  lifecycleState: 'scheduled',
  decisionReasonCodes: ['scheduled_in_available_window'],
  sourceShapeHash: 'abc123shapehash',
};

beforeEach(() => {
  vi.clearAllMocks();
  trainingPlans.getSessionById.mockReturnValue(null);
});

describe('secretary-unified-calendar-provider-adapter', () => {
  it('creates provider events with Secretary identity markers', async () => {
    unifiedCalendar.createEvent.mockResolvedValue({
      id: 'google_event_1',
      source: 'google',
      summary: 'Endurance ride',
      start: input.startAt,
      end: input.endAt,
      description: buildSecretaryCalendarDescription(input),
    });
    const adapter = createUnifiedCalendarSecretaryProviderAdapter('google');

    const event = await adapter.createEvent(input);

    expect(event).toMatchObject({
      eventId: 'google_event_1',
      source: 'google',
      agendaItemId: 'sec_agenda_123',
    });
    expect(unifiedCalendar.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Endurance ride',
      start: input.startAt,
      end: input.endAt,
      description: expect.stringContaining('NEXUS_SECRETARY_AGENDA_ITEM:sec_agenda_123'),
      categories: ['Nexus', 'Secretary', 'training'],
    }), 'google', 42);
  });

  it('puts Training session content before Secretary markers in provider descriptions', () => {
    trainingPlans.getSessionById.mockReturnValue({
      id: 970,
      description: [
        'WARM-UP:',
        '• 10 minutes easy jog',
        '',
        'MAIN WORKOUT:',
        'EXECUTION:',
        '• Effort: RPE 5-6',
        '',
        '[NEXUS_TRAINING_IDENTITY plan=39;version=1;session=970;key=x;shape=y]',
      ].join('\n'),
    });

    const description = buildSecretaryCalendarDescription({
      ...input,
      sourceIntentId: 'training:39:1:970',
      sourceEntityId: '970',
    });

    expect(description).toMatch(/^WARM-UP:/);
    expect(description).toContain('MAIN WORKOUT:');
    expect(description).toContain('NEXUS_SECRETARY_AGENDA_ITEM:sec_agenda_123');
    expect(description).not.toContain('NEXUS_TRAINING_IDENTITY');
  });

  it('updates and deletes by exact provider event ID', async () => {
    unifiedCalendar.updateEvent.mockResolvedValue({
      id: 'google_event_1',
      source: 'google',
      summary: 'Endurance ride',
      start: input.startAt,
      end: input.endAt,
      description: buildSecretaryCalendarDescription(input),
    });
    unifiedCalendar.deleteEvent.mockResolvedValue(undefined);
    const adapter = createUnifiedCalendarSecretaryProviderAdapter('google');

    await adapter.updateEvent('google_event_1', input);
    await adapter.deleteEvent('google_event_1', input);

    expect(unifiedCalendar.updateEvent).toHaveBeenCalledWith({
      event_id: 'google_event_1',
      new_title: 'Endurance ride',
      new_start: input.startAt,
      new_end: input.endAt,
      new_description: buildSecretaryCalendarDescription(input),
    }, 'google', 42);
    expect(unifiedCalendar.deleteEvent).toHaveBeenCalledWith('google_event_1', 'google', 42);
  });

  it('uses bounded read-back windows and marker matching for duplicate detection', async () => {
    googleCalendar.getEvents.mockResolvedValue([
      {
        id: 'google_event_1',
        summary: 'Endurance ride',
        start: input.startAt,
        end: input.endAt,
        description: buildSecretaryCalendarDescription(input),
      },
      {
        id: 'google_event_other',
        summary: 'Different event',
        start: input.startAt,
        end: input.endAt,
        description: 'NEXUS_SECRETARY_AGENDA_ITEM:other_agenda',
      },
    ]);
    const adapter = createUnifiedCalendarSecretaryProviderAdapter('google');

    const events = await adapter.findEventsByAgendaItemId!('sec_agenda_123', input);

    expect(events.map((event) => event.eventId)).toEqual(['google_event_1']);
    expect(googleCalendar.getEvents).toHaveBeenCalledWith(
      '2026-05-03T09:00:00.000Z',
      '2026-05-05T10:00:00.000Z',
      42,
    );
    expect(outlookCalendar.getEvents).not.toHaveBeenCalled();
  });

  it('extracts Secretary agenda markers conservatively', () => {
    expect(extractSecretaryAgendaMarker('hello\nNEXUS_SECRETARY_AGENDA_ITEM:sec_1\nbye')).toBe('sec_1');
    expect(extractSecretaryAgendaMarker('NEXUS_SECRETARY_SOURCE_INTENT:intent')).toBeNull();
    expect(extractSecretaryAgendaMarker(undefined)).toBeNull();
  });

  it('dedupes provider categories case-insensitively for Secretary-owned events', async () => {
    const secretaryInput = {
      ...input,
      sourceSkill: 'secretary',
    };
    unifiedCalendar.createEvent.mockResolvedValue({
      id: 'outlook_event_1',
      source: 'outlook',
      summary: 'Endurance ride',
      start: input.startAt,
      end: input.endAt,
      description: buildSecretaryCalendarDescription(secretaryInput),
    });
    const adapter = createUnifiedCalendarSecretaryProviderAdapter('outlook');

    await adapter.createEvent(secretaryInput);

    expect(unifiedCalendar.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      categories: ['Nexus', 'Secretary'],
    }), 'outlook', 42);
  });
});
