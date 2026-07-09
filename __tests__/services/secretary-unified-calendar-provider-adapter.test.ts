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
  getPlanById: vi.fn(),
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
import { appendTrainingIdentityMarker, parseTrainingIdentityMarker } from '../../src/services/training-session-identity';
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
  trainingPlans.getPlanById.mockReturnValue(null);
});

describe('secretary-unified-calendar-provider-adapter', () => {
  it('creates provider events with user-facing descriptions instead of Secretary identity markers', async () => {
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
      description: expect.not.stringContaining('NEXUS_SECRETARY_'),
      categories: ['Nexus', 'Secretary', 'training'],
    }), 'google', 42);
  });

  it('puts Training session content in provider descriptions without internal markers', () => {
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

    expect(description).toContain('Endurance ride');
    expect(description).toContain('Duration: 60 min');
    expect(description).toContain('WARM-UP:');
    expect(description).toContain('MAIN WORKOUT:');
    expect(description).toContain('Source: Nexus Hub training plan.');
    expect(description).not.toContain('NEXUS_SECRETARY_');
    expect(description).not.toContain('NEXUS_TRAINING_IDENTITY');
  });

  it('falls back to useful Training event body when the session row is unavailable', () => {
    trainingPlans.getSessionById.mockReturnValue(null);

    const description = buildSecretaryCalendarDescription({
      ...input,
      title: '🏃 Recovery Run (40min)',
      durationMinutes: 40,
      sourceIntentId: 'training:39:1:970',
      sourceEntityId: '970',
    });

    expect(description).toContain('🏃 Recovery Run (40min)');
    expect(description).toContain('Duration: 40 min');
    expect(description).toContain('Source: Nexus Hub training plan.');
    expect(description).not.toContain('NEXUS_SECRETARY_');
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
        description: [
          'Legacy training details',
          'NEXUS_SECRETARY_AGENDA_ITEM:sec_agenda_123',
          'NEXUS_SECRETARY_SOURCE_INTENT:intent_123',
        ].join('\n'),
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

  it('recognizes Training-created calendar events without creating a Secretary duplicate', async () => {
    const trainingInput: SecretaryProviderEventInput = {
      ...input,
      sourceIntentId: 'training:39:3:970',
      sourceEntityId: '970',
      title: 'Lower Body Strength B',
      startAt: '2026-05-04T18:00:00.000Z',
      endAt: '2026-05-04T18:40:00.000Z',
      durationMinutes: 40,
    };
    trainingPlans.getSessionById.mockReturnValue({
      id: 970,
      session_type: 'gym',
      duration_minutes: 40,
      description: 'Lower work',
    });
    googleCalendar.getEvents.mockResolvedValue([
      {
        id: 'google_training_direct',
        summary: '💪 Lower Body Strength B (40min)',
        start: trainingInput.startAt,
        end: trainingInput.endAt,
        description: appendTrainingIdentityMarker('Lower work', {
          planId: 39,
          planVersion: 3,
          sessionId: 970,
          sessionIdentityKey: 'plan:39|week:1|day:monday|type:gym|slot:1',
          sessionShapeHash: 'training-shape-970',
        }),
      },
    ]);
    const adapter = createUnifiedCalendarSecretaryProviderAdapter('google');

    const events = await adapter.findEventsByAgendaItemId!('sec_agenda_123', trainingInput);

    expect(events.map((event) => event.eventId)).toEqual(['google_training_direct']);
    expect(events[0]).toMatchObject({
      agendaItemId: 'sec_agenda_123',
      title: '💪 Lower Body Strength B (40min)',
    });
  });

  it('formats Training provider writes like direct Training calendar sync titles', async () => {
    const trainingInput: SecretaryProviderEventInput = {
      ...input,
      sourceIntentId: 'training:39:3:970',
      sourceEntityId: '970',
      title: 'Lower Body Strength B',
      startAt: '2026-05-04T18:00:00.000Z',
      endAt: '2026-05-04T18:40:00.000Z',
      durationMinutes: 40,
    };
    trainingPlans.getSessionById.mockReturnValue({
      id: 970,
      session_type: 'gym',
      duration_minutes: 40,
      description: 'Lower work',
    });
    unifiedCalendar.createEvent.mockResolvedValue({
      id: 'outlook_training',
      source: 'outlook',
      summary: '💪 Lower Body Strength B (40min)',
      start: trainingInput.startAt,
      end: trainingInput.endAt,
      description: buildSecretaryCalendarDescription(trainingInput),
    });
    const adapter = createUnifiedCalendarSecretaryProviderAdapter('outlook');

    await adapter.createEvent(trainingInput);

    expect(unifiedCalendar.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: '💪 Lower Body Strength B (40min)',
      start: trainingInput.startAt,
      end: trainingInput.endAt,
    }), 'outlook', 42);
  });

  it('re-appends the Training identity marker on provider writes so adoption never destroys Training ownership', async () => {
    const trainingInput: SecretaryProviderEventInput = {
      ...input,
      sourceIntentId: 'training:39:3:970',
      sourceEntityId: '970',
      title: 'Lower Body Strength B',
      durationMinutes: 40,
    };
    trainingPlans.getSessionById.mockReturnValue({
      id: 970,
      plan_id: 39,
      session_type: 'gym',
      duration_minutes: 40,
      description: 'Lower work',
      session_identity_key: 'plan:39|week:1|day:monday|type:gym|slot:1',
      session_shape_hash: 'training-shape-970',
    });
    unifiedCalendar.updateEvent.mockResolvedValue({
      id: 'google_training_direct',
      source: 'google',
      summary: '💪 Lower Body Strength B (40min)',
      start: trainingInput.startAt,
      end: trainingInput.endAt,
      description: 'rewritten',
    });
    const adapter = createUnifiedCalendarSecretaryProviderAdapter('google');

    await adapter.updateEvent('google_training_direct', trainingInput);

    const pushed = unifiedCalendar.updateEvent.mock.calls[0][0];
    expect(pushed.new_title).toBe('💪 Lower Body Strength B (40min)');
    expect(parseTrainingIdentityMarker(pushed.new_description)).toMatchObject({
      planId: 39,
      planVersion: 3,
      sessionId: 970,
      sessionIdentityKey: 'plan:39|week:1|day:monday|type:gym|slot:1',
      sessionShapeHash: 'training-shape-970',
    });
    // The user-facing body builder itself stays marker-free (Bug #3 contract);
    // the marker is a provider-write concern only.
    expect(buildSecretaryCalendarDescription(trainingInput)).not.toContain('NEXUS_TRAINING_IDENTITY');
  });

  it('marks Training identity matches as trainingOwned so canonical selection never deletes them', async () => {
    const trainingInput: SecretaryProviderEventInput = {
      ...input,
      sourceIntentId: 'training:39:3:970',
      sourceEntityId: '970',
      title: 'Lower Body Strength B',
      durationMinutes: 40,
    };
    trainingPlans.getSessionById.mockReturnValue({
      id: 970,
      plan_id: 39,
      session_type: 'gym',
      duration_minutes: 40,
      description: 'Lower work',
    });
    googleCalendar.getEvents.mockResolvedValue([
      {
        id: 'google_training_direct',
        summary: '💪 Lower Body Strength B (40min)',
        start: trainingInput.startAt,
        end: trainingInput.endAt,
        description: appendTrainingIdentityMarker('Lower work', {
          planId: 39,
          planVersion: 3,
          sessionId: 970,
          sessionIdentityKey: 'k',
          sessionShapeHash: 's',
        }),
      },
      {
        id: 'google_secretary_copy',
        summary: 'Lower Body Strength B',
        start: trainingInput.startAt,
        end: trainingInput.endAt,
        description: 'Plain Secretary copy without markers',
      },
    ]);
    const adapter = createUnifiedCalendarSecretaryProviderAdapter('google');

    const events = await adapter.findEventsByAgendaItemId!('sec_agenda_123', trainingInput);

    expect(events.map((event) => [event.eventId, event.trainingOwned === true])).toEqual([
      ['google_training_direct', true],
      ['google_secretary_copy', false],
    ]);
  });

  it('matches Training events on Outlook despite HTML bodies and timezone-shifted readback instants', async () => {
    const trainingInput: SecretaryProviderEventInput = {
      ...input,
      sourceIntentId: 'training:39:3:970',
      sourceEntityId: '970',
      title: 'Lower Body Strength B',
      startAt: '2026-07-06T18:00:00.000Z',
      endAt: '2026-07-06T18:40:00.000Z',
      durationMinutes: 40,
    };
    trainingPlans.getSessionById.mockReturnValue({
      id: 970,
      plan_id: 39,
      session_type: 'gym',
      duration_minutes: 40,
    });
    outlookCalendar.getEvents.mockResolvedValue([
      {
        id: 'outlook_training_direct',
        summary: '💪 Lower Body Strength B (40min)',
        // Graph returned zone-naive local times: parsed instants are offset
        // from the UTC agenda slot, so instant equality cannot be required.
        start: '2026-07-06T19:00:00.0000000',
        end: '2026-07-06T19:40:00.0000000',
        description: '<html><body>Lower work<br>[NEXUS_TRAINING_IDENTITY plan=39;version=3;session=970;key=k;shape=s]</body></html>',
      },
    ]);
    const adapter = createUnifiedCalendarSecretaryProviderAdapter('outlook');

    const events = await adapter.findEventsByAgendaItemId!('sec_agenda_123', trainingInput);

    expect(events.map((event) => event.eventId)).toEqual(['outlook_training_direct']);
    expect(events[0].trainingOwned).toBe(true);
  });

  it('rejects Training marker matches from a different plan and tolerates non-training intent ids', async () => {
    trainingPlans.getSessionById.mockReturnValue({
      id: 970,
      plan_id: 39,
      session_type: 'gym',
      duration_minutes: 40,
    });
    const otherPlanEvent = {
      id: 'google_other_plan',
      summary: 'Different Session',
      start: input.startAt,
      end: input.endAt,
      description: appendTrainingIdentityMarker('Old plan work', {
        planId: 41,
        planVersion: 1,
        sessionId: 970,
        sessionIdentityKey: 'k',
        sessionShapeHash: 's',
      }),
    };
    googleCalendar.getEvents.mockResolvedValue([otherPlanEvent]);
    const adapter = createUnifiedCalendarSecretaryProviderAdapter('google');

    const withIntent = await adapter.findEventsByAgendaItemId!('sec_agenda_123', {
      ...input,
      sourceIntentId: 'training:39:3:970',
      sourceEntityId: '970',
      title: 'Lower Body Strength B',
    });
    expect(withIntent).toEqual([]);

    // Without a parseable training intent the plan cross-check is skipped and
    // the sessionId match stands (session ids are globally unique).
    const withoutIntent = await adapter.findEventsByAgendaItemId!('sec_agenda_123', {
      ...input,
      sourceIntentId: 'intent_123',
      sourceEntityId: '970',
      title: 'Lower Body Strength B',
    });
    expect(withoutIntent.map((event) => event.eventId)).toEqual(['google_other_plan']);
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

  // 2026-05-25 Bug #3 — body hydration without visible sync metadata
  // ------------------------------------------------------------
  // Pre-fix the body for a training session with empty
  // `description` would collapse to a 6-line metadata footer, with
  // no workout content visible to the user. These tests pin the
  // new contract: body is always workout content and source context,
  // never NEXUS_SECRETARY_* metadata visible in the provider event.

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

    expect(description).toContain('Endurance ride');
    expect(description).toContain('Duration: 60 min');
    expect(description).toContain('Build Block — Aerobic Base');
    expect(description).toContain('Back Squat');
    expect(description).toContain('Source: Nexus Hub training plan.');
    expect(description).not.toContain('NEXUS_SECRETARY_');
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

    expect(description).toContain('Endurance ride');
    expect(description).toContain('Duration: 60 min');
    expect(description).toContain('Strength + Core Support · RPE 7 · 40 min');
    expect(description).toContain('Source: Nexus Hub training plan.');
    expect(description).not.toContain('NEXUS_SECRETARY_');
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

    expect(description).toContain('Endurance ride');
    expect(description).toContain('Quick mobility');
    expect(description).not.toMatch(/Quick mobility · ·/);
    expect(description).not.toMatch(/^ · /);
    expect(description).not.toContain('NEXUS_SECRETARY_');
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

    expect(description).toContain('Endurance ride');
    expect(description).toContain('Recovery Spin · Z1 · 30 min');
    expect(description).toContain('Source: Nexus Hub training plan.');
    expect(description).not.toContain('NEXUS_SECRETARY_');
  });

  it('R-2026-05-25 Bug #3 — emits useful fallback body when session row is missing', () => {
    trainingPlans.getSessionById.mockReturnValue(null);

    const description = buildSecretaryCalendarDescription({
      ...input,
      sourceIntentId: 'training:39:1:999',
      sourceEntityId: '999',
    });

    expect(description).toContain('Endurance ride');
    expect(description).toContain('Duration: 60 min');
    expect(description).toContain('Source: Nexus Hub training plan.');
    expect(description).not.toContain('NEXUS_SECRETARY_');
  });

  it('R-2026-05-25 Bug #3 — new user-facing description no longer carries a Secretary marker', () => {
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

    expect(newShape).not.toContain('NEXUS_SECRETARY_');
    expect(extractSecretaryAgendaMarker(newShape)).toBeNull();
  });
});
