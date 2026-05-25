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

  // 2026-05-25 Bug #3 (Stage 1) — body hydration + visual divider
  // ------------------------------------------------------------
  // Pre-fix the body for a training session with empty
  // `description` would collapse to a 6-line metadata footer, with
  // no workout content visible to the user. These tests pin the
  // new contract: body is always workout content first, divider,
  // then markers — never markers alone when the session row exists.

  it('R-2026-05-25 Bug #3 — falls back to description_json when description is empty', () => {
    const sections = {
      header: { planName: 'Build Block', phase: 'Aerobic Base' },
      badge: { emoji: '💪', eyebrow: 'Monday', title: 'Strength + Core' },
      execution: [
        { label: 'Effort', value: 'RPE 7' },
        { label: 'Duration', value: '40 min' },
      ],
      exercises: [
        { name: 'Back Squat', sets: 4, reps: 6 },
        { name: 'Plank', sets: 3, durationSeconds: 60 },
      ],
    };
    trainingPlans.getSessionById.mockReturnValue({
      id: 970,
      description: null,
      description_json: JSON.stringify(sections),
      title: 'Strength + Core Support (40min)',
      intensity_text: 'RPE 7',
      duration_minutes: 40,
    });

    const description = buildSecretaryCalendarDescription({
      ...input,
      sourceIntentId: 'training:39:1:970',
      sourceEntityId: '970',
    });

    // The rendered text should appear before the metadata divider.
    expect(description.startsWith('Build Block — Aerobic Base')).toBe(true);
    expect(description).toContain('Back Squat');
    // Marker line is still present (extractSecretaryAgendaMarker
    // depends on it) but BELOW the divider.
    expect(description).toContain('────────────');
    expect(description).toContain('NEXUS_SECRETARY_AGENDA_ITEM:sec_agenda_123');
    expect(description.indexOf('Back Squat')).toBeLessThan(description.indexOf('────────────'));
    expect(description.indexOf('────────────')).toBeLessThan(description.indexOf('NEXUS_SECRETARY_AGENDA_ITEM'));
  });

  it('R-2026-05-25 Bug #3 — falls back to title+intensity+duration when description AND description_json are both empty', () => {
    trainingPlans.getSessionById.mockReturnValue({
      id: 971,
      description: null,
      description_json: null,
      title: 'Strength + Core Support',
      intensity_text: 'RPE 7',
      duration_minutes: 40,
    });

    const description = buildSecretaryCalendarDescription({
      ...input,
      sourceIntentId: 'training:39:1:971',
      sourceEntityId: '971',
    });

    // Minimal fallback uses ` · ` as the separator so it's visually
    // distinct from the metadata footer.
    expect(description).toMatch(/^Strength \+ Core Support · RPE 7 · 40 min/);
    expect(description).toContain('────────────');
    expect(description).toContain('NEXUS_SECRETARY_AGENDA_ITEM:sec_agenda_123');
  });

  it('R-2026-05-25 Bug #3 — fallback omits missing fields cleanly (no orphan separators)', () => {
    trainingPlans.getSessionById.mockReturnValue({
      id: 972,
      description: null,
      description_json: null,
      title: 'Quick mobility',
      intensity_text: null,
      duration_minutes: null,
    });

    const description = buildSecretaryCalendarDescription({
      ...input,
      sourceIntentId: 'training:39:1:972',
      sourceEntityId: '972',
    });

    expect(description).toMatch(/^Quick mobility\n/);
    expect(description).not.toMatch(/Quick mobility · ·/);
    expect(description).not.toMatch(/^ · /);
  });

  it('R-2026-05-25 Bug #3 — gracefully handles malformed description_json (logs + falls through to fallback)', () => {
    trainingPlans.getSessionById.mockReturnValue({
      id: 973,
      description: null,
      description_json: '{not-json',
      title: 'Recovery Spin',
      intensity_text: 'Z1',
      duration_minutes: 30,
    });

    const description = buildSecretaryCalendarDescription({
      ...input,
      sourceIntentId: 'training:39:1:973',
      sourceEntityId: '973',
    });

    expect(description).toMatch(/^Recovery Spin · Z1 · 30 min/);
    expect(description).toContain('NEXUS_SECRETARY_AGENDA_ITEM:sec_agenda_123');
  });

  it('R-2026-05-25 Bug #3 — emits markers-only body when session row is missing', () => {
    trainingPlans.getSessionById.mockReturnValue(null);

    const description = buildSecretaryCalendarDescription({
      ...input,
      sourceIntentId: 'training:39:1:999',
      sourceEntityId: '999',
    });

    // No source body → no divider, just the footer (back-compat with
    // the legacy shape for non-training-session inputs).
    expect(description.startsWith('NEXUS_SECRETARY_AGENDA_ITEM:sec_agenda_123')).toBe(true);
    expect(description).not.toContain('────────────');
  });

  it('R-2026-05-25 Bug #3 — extractSecretaryAgendaMarker still resolves agenda items written with the new divider shape', () => {
    trainingPlans.getSessionById.mockReturnValue({
      id: 974,
      description: 'Tempo run · 5 km @ Z3',
      description_json: null,
      title: 'Tempo run',
      intensity_text: 'Z3',
      duration_minutes: 30,
    });

    const newShape = buildSecretaryCalendarDescription({
      ...input,
      sourceIntentId: 'training:39:1:974',
      sourceEntityId: '974',
    });

    expect(extractSecretaryAgendaMarker(newShape)).toBe('sec_agenda_123');
  });
});
