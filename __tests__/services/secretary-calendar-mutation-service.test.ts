import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { withDatabaseForTest, withDatabaseForTestAsync } from '../../src/services/database';
import {
  executeSecretaryCalendarMutation,
  inspectSecretaryCalendarMutationReplay,
  SecretaryCalendarMutationError,
  type SecretaryCalendarMutationInput,
  type SecretaryCalendarMutationIo,
} from '../../src/services/secretary-calendar-mutation-service';
import {
  arbitrateSecretarySchedulingIntents,
  markSecretaryAgendaProviderSyncSatisfied,
} from '../../src/services/secretary-scheduling-arbitrator';
import {
  claimSecretaryCalendarMutation,
  releaseSecretaryCalendarMutationProcessingLease,
  updateSecretaryCalendarMutationReceipt,
} from '../../src/services/secretary-calendar-mutation-store';

const mockCreateDecisionIntent = vi.hoisted(() => vi.fn());
const mockInvalidateCalendarCaches = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/decision-center', () => ({
  createDecisionIntent: (...args: unknown[]) => mockCreateDecisionIntent(...args),
}));
vi.mock('../../src/services/cache-coherence-registry', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/cache-coherence-registry')>(
    '../../src/services/cache-coherence-registry',
  )),
  invalidateCalendarCaches: (...args: unknown[]) => mockInvalidateCalendarCaches(...args),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

const NOW = '2026-08-30T10:00:00.000Z';
const OLD_START = '2026-08-31T09:00:00.000Z';
const OLD_END = '2026-08-31T10:00:00.000Z';
const NEW_START = '2026-08-31T11:00:00.000Z';
const NEW_END = '2026-08-31T12:00:00.000Z';

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    source: 'google' as const,
    summary: 'Planning review',
    start: OLD_START,
    end: OLD_END,
    blocksTime: true,
    ...overrides,
  };
}

function updateCommand(overrides: Partial<SecretaryCalendarMutationInput> = {}): SecretaryCalendarMutationInput {
  return {
    userId: 42,
    tenantId: 42,
    idempotencyKey: 'calendar-mutation-1',
    operation: 'update',
    source: 'google',
    eventId: 'event-1',
    title: 'Planning review moved',
    start: NEW_START,
    end: NEW_END,
    timezone: 'Europe/Lisbon',
    channel: 'ios',
    nowIso: NOW,
    ...overrides,
  };
}

function readyIo(current = event()): SecretaryCalendarMutationIo & {
  getEventById: ReturnType<typeof vi.fn>;
  updateEvent: ReturnType<typeof vi.fn>;
  deleteEvent: ReturnType<typeof vi.fn>;
} {
  return {
    getEventById: vi.fn().mockResolvedValue(current),
    getEventsWithDiagnostics: vi.fn().mockResolvedValue({
      events: [],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
    }),
    updateEvent: vi.fn().mockResolvedValue(event({
      summary: 'Planning review moved',
      start: NEW_START,
      end: NEW_END,
    })),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
  };
}

function seedMappedAgenda(
  db: Database.Database,
  sourceSkill: 'secretary' | 'training' = 'secretary',
): string {
  return withDatabaseForTest(db, () => {
    const decision = arbitrateSecretarySchedulingIntents([{
      intentId: `${sourceSkill}:calendar-command:mapped-1`,
      sourceSkill,
      sourceAction: 'create_calendar_event',
      ownerUserId: 42,
      tenantId: 42,
      providerTarget: 'google',
      title: 'Planning review',
      requestedDurationMinutes: 60,
      preferredWindows: [{ start: OLD_START, end: OLD_END }],
      priority: 'normal',
      flexibility: 'flexible',
    }], { now: NOW }).decisions[0].agendaItem;
    const synced = markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: decision.agendaItemId,
      ownerUserId: 42,
      tenantId: 42,
      providerEventId: 'event-1',
      providerSource: 'google',
      now: NOW,
    });
    if (!synced) throw new Error('mapped agenda seed failed');
    return synced.agendaItemId;
  });
}

function seedLocalAgendaConflict(db: Database.Database): string {
  return withDatabaseForTest(db, () => arbitrateSecretarySchedulingIntents([{
    intentId: 'finance:local-calendar-conflict-1',
    sourceSkill: 'finance',
    sourceAction: 'protect_deadline_window',
    ownerUserId: 42,
    tenantId: 42,
    title: 'Tax filing deadline',
    requestedDurationMinutes: 60,
    preferredWindows: [{ start: NEW_START, end: NEW_END }],
    priority: 'urgent',
    flexibility: 'fixed',
  }], { now: NOW }).decisions[0].agendaItem.agendaItemId);
}

function seedProtectedRoutine(db: Database.Database): void {
  db.prepare(`
    INSERT INTO secretary_routine_profiles (
      user_id, tenant_id, version, working_windows_json,
      preferred_focus_windows_json, protected_routines_json,
      created_at, updated_at
    ) VALUES (?, ?, 1, '[]', '[]', ?, ?, ?)
  `).run(42, 42, JSON.stringify([{
    id: '22222222-2222-4222-8222-222222222222',
    weekdays: [1],
    start: '12:00',
    end: '13:00',
    label: 'Protected lunch',
    kind: 'meal',
  }]), NOW, NOW);
}

function mutationReceiptState(db: Database.Database, idempotencyKey: string): string | undefined {
  return (db.prepare(`
    SELECT state
      FROM secretary_calendar_mutation_receipts
     WHERE user_id = 42 AND tenant_id = '42' AND idempotency_key = ?
  `).get(idempotencyKey) as { state: string } | undefined)?.state;
}

function mutableIo(): SecretaryCalendarMutationIo & {
  getEventById: ReturnType<typeof vi.fn>;
  updateEvent: ReturnType<typeof vi.fn>;
  deleteEvent: ReturnType<typeof vi.fn>;
} {
  let current: ReturnType<typeof event> | null = event();
  return {
    getEventById: vi.fn(async () => current),
    getEventsWithDiagnostics: vi.fn().mockResolvedValue({
      events: [],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
    }),
    updateEvent: vi.fn(async (data: {
      new_title?: string;
      new_start?: string;
      new_end?: string;
      new_description?: string;
    }) => {
      current = event({
        summary: data.new_title ?? current?.summary,
        start: data.new_start ?? current?.start,
        end: data.new_end ?? current?.end,
        ...(data.new_description !== undefined ? { description: data.new_description } : {}),
      });
      return current;
    }),
    deleteEvent: vi.fn(async () => { current = null; }),
  };
}

describe.sequential('Secretary existing-calendar mutation service', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
    db.prepare(`
      INSERT INTO users (id, telegram_id, first_name, language, timezone, status, auth_provider)
      VALUES (42, 42, 'Mutation Tester', 'en-US', 'Europe/Lisbon', 'active', 'invite_code')
    `).run();
    mockCreateDecisionIntent.mockReset();
    mockCreateDecisionIntent.mockResolvedValue({
      item: { itemId: 'decision-1' },
      eligibility: { classification: 'decision', reasons: [] },
    });
    mockInvalidateCalendarCaches.mockReset();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it.each([
    ['non-integer user', { userId: Number.NaN }, 'INVALID_INPUT'],
    ['non-positive user', { userId: 0 }, 'INVALID_INPUT'],
    ['missing tenant', { tenantId: undefined }, 'TENANT_SCOPE_MISMATCH'],
    ['non-string key', { idempotencyKey: 42 }, 'INVALID_INPUT'],
    ['empty key', { idempotencyKey: ' ' }, 'INVALID_INPUT'],
    ['oversized key', { idempotencyKey: 'a'.repeat(500) }, 'INVALID_INPUT'],
    ['malformed key', { idempotencyKey: 'contains\u0000control' }, 'INVALID_INPUT'],
    ['unknown operation', { operation: 'move' }, 'INVALID_INPUT'],
    ['unknown provider', { source: 'apple' }, 'INVALID_INPUT'],
    ['non-string event id', { eventId: 42 }, 'INVALID_INPUT'],
    ['empty event id', { eventId: ' ' }, 'INVALID_INPUT'],
    ['oversized event id', { eventId: 'e'.repeat(2_000) }, 'INVALID_INPUT'],
    ['non-string timezone', { timezone: 42 }, 'INVALID_INPUT'],
    ['invalid timezone', { timezone: 'Mars/Olympus' }, 'INVALID_INPUT'],
    ['unknown channel', { channel: 'email' }, 'INVALID_INPUT'],
    ['non-string title', { title: 42 }, 'INVALID_INPUT'],
    ['blank title', { title: ' ' }, 'INVALID_INPUT'],
    ['oversized title', { title: 't'.repeat(2_000) }, 'INVALID_INPUT'],
    ['non-string description', { description: 42 }, 'INVALID_INPUT'],
    ['oversized description', { description: 'd'.repeat(20_000) }, 'INVALID_INPUT'],
    ['start without end', { end: undefined }, 'INVALID_INPUT'],
    ['end without start', { start: undefined }, 'INVALID_INPUT'],
    ['non-string start', { start: 42 }, 'INVALID_INPUT'],
    ['start missing time separator', { start: '2026-08-31' }, 'INVALID_INPUT'],
    ['end missing time separator', { end: '2026-08-31' }, 'INVALID_INPUT'],
    ['invalid start timestamp', { start: '2026-99-99T11:00:00Z' }, 'INVALID_INPUT'],
    ['invalid end timestamp', { end: '2026-99-99T12:00:00Z' }, 'INVALID_INPUT'],
    ['end before start', { end: '2026-08-31T10:00:00.000Z' }, 'INVALID_INPUT'],
    ['duration beyond one day', { end: '2026-09-02T12:00:00.000Z' }, 'INVALID_INPUT'],
    ['delete with title', { operation: 'delete', start: undefined, end: undefined }, 'INVALID_INPUT'],
    ['delete with description', {
      operation: 'delete', title: undefined, description: 'not accepted', start: undefined, end: undefined,
    }, 'INVALID_INPUT'],
    ['delete with range', { operation: 'delete', title: undefined }, 'INVALID_INPUT'],
    ['update without changes', {
      title: undefined, description: undefined, start: undefined, end: undefined,
    }, 'INVALID_INPUT'],
  ] as const)('rejects %s before provider I/O', async (_label, overrides, expectedCode) => {
    const io = readyIo();
    const command = { ...updateCommand(), ...overrides } as SecretaryCalendarMutationInput;

    expect(() => withDatabaseForTest(db, () => inspectSecretaryCalendarMutationReplay(command)))
      .toThrow(expect.objectContaining({ code: expectedCode }));
    expect(io.getEventById).not.toHaveBeenCalled();
    expect(io.updateEvent).not.toHaveBeenCalled();
    expect(io.deleteEvent).not.toHaveBeenCalled();
  });

  it('treats a valid command without a durable receipt as a replay miss', () => {
    expect(withDatabaseForTest(db, () => inspectSecretaryCalendarMutationReplay(
      updateCommand({ nowIso: 'not-an-instant' }),
    ))).toBeNull();
  });

  it('rejects scope mismatch before database or provider I/O', async () => {
    const forbiddenDb = new Proxy({} as Database.Database, {
      get() { throw new Error('database was touched'); },
    });
    const io = readyIo();
    await expect(withDatabaseForTestAsync(forbiddenDb, () => executeSecretaryCalendarMutation(
      updateCommand({ tenantId: 7 }),
      { calendarIo: io },
    ))).rejects.toMatchObject<Partial<SecretaryCalendarMutationError>>({
      code: 'TENANT_SCOPE_MISMATCH',
      status: 403,
    });
    expect(io.getEventById).not.toHaveBeenCalled();
    expect(io.updateEvent).not.toHaveBeenCalled();
  });

  it('leases a nonterminal mutation receipt to one process and permits recovery after release', () => {
    const claim = () => withDatabaseForTest(db, () => claimSecretaryCalendarMutation({
      userId: 42,
      tenantId: 42,
      idempotencyKey: 'calendar-mutation-concurrent-1',
      requestHash: 'b'.repeat(64),
      operation: 'update',
      providerSource: 'google',
      providerEventId: 'event-1',
      command: { operation: 'update', eventId: 'event-1' },
      nowIso: NOW,
      expiresAt: '2026-09-29T10:00:00.000Z',
    }));

    const first = claim();
    const concurrent = claim();
    expect(first).toMatchObject({ created: true, acquired: true });
    expect(concurrent).toMatchObject({ created: false, acquired: false, leaseToken: null });

    withDatabaseForTest(db, () => releaseSecretaryCalendarMutationProcessingLease({
      userId: 42,
      tenantId: 42,
      idempotencyKey: 'calendar-mutation-concurrent-1',
      leaseToken: first.leaseToken!,
    }));
    const conflicting = withDatabaseForTest(db, () => claimSecretaryCalendarMutation({
      userId: 42,
      tenantId: 42,
      idempotencyKey: 'calendar-mutation-concurrent-1',
      requestHash: 'c'.repeat(64),
      operation: 'update',
      providerSource: 'google',
      providerEventId: 'provider-event-1',
      command: { title: 'Different mutation' },
      nowIso: '2026-08-31T08:00:00.000Z',
      expiresAt: '2026-09-30T08:00:00.000Z',
    }));
    expect(conflicting).toMatchObject({ created: false, acquired: false, leaseToken: null });
    expect(claim()).toMatchObject({ created: false, acquired: true });
  });

  it('returns an explicit null-result probe for a nonterminal mutation receipt', async () => {
    const io = readyIo();
    vi.mocked(io.getEventsWithDiagnostics!).mockResolvedValueOnce({
      events: [],
      status: 'unavailable',
      warningCodes: ['CALENDAR_SOURCE_UNAVAILABLE'],
      warnings: ['Calendar source unavailable.'],
      sources: { configured: ['google'], fulfilled: [], failed: ['google'] },
    });

    await expect(withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand({ idempotencyKey: 'calendar-mutation-nonterminal-probe' }),
      { calendarIo: io, configuredSources: ['google'] },
    ))).rejects.toMatchObject<Partial<SecretaryCalendarMutationError>>({
      code: 'CALENDAR_CONFLICT_STATE_UNKNOWN',
    });

    expect(withDatabaseForTest(db, () => inspectSecretaryCalendarMutationReplay(
      updateCommand({ idempotencyKey: 'calendar-mutation-nonterminal-probe' }),
    ))).toEqual({ result: null });
  });

  it('fences a stale mutation writer after another worker acquires recovery', () => {
    const input = {
      userId: 42,
      tenantId: 42,
      idempotencyKey: 'calendar-mutation-stale-writer',
      requestHash: 'e'.repeat(64),
      operation: 'update' as const,
      providerSource: 'google' as const,
      providerEventId: 'event-1',
      command: { operation: 'update', eventId: 'event-1' },
      expiresAt: '2026-09-29T10:00:00.000Z',
    };
    const first = withDatabaseForTest(db, () => claimSecretaryCalendarMutation({
      ...input,
      nowIso: NOW,
    }));
    const recovered = withDatabaseForTest(db, () => claimSecretaryCalendarMutation({
      ...input,
      nowIso: '2026-08-30T10:06:00.000Z',
    }));

    expect(recovered).toMatchObject({ created: false, acquired: true });
    expect(() => withDatabaseForTest(db, () => updateSecretaryCalendarMutationReceipt({
      userId: 42,
      tenantId: 42,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      leaseToken: first.leaseToken!,
    }, {
      state: 'write_pending',
      updatedAt: '2026-08-30T10:06:01.000Z',
    }))).toThrow('SECRETARY_CALENDAR_MUTATION_RECEIPT_STALE');
  });

  it('writes once, verifies exact state, and replays the receipt', async () => {
    const io = readyIo();
    io.getEventById
      .mockResolvedValueOnce(event())
      .mockResolvedValueOnce(event({
        summary: 'Planning review moved',
        start: NEW_START,
        end: NEW_END,
        syncedSources: ['google', 'outlook'],
      }));
    mockInvalidateCalendarCaches.mockImplementationOnce(() => {
      expect(mutationReceiptState(db, 'calendar-mutation-1')).not.toBe('succeeded');
    });
    const first = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand(),
      { calendarIo: io },
    ));
    const replay = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand(),
      { calendarIo: io },
    ));
    expect(first).toMatchObject({ status: 'succeeded', replayed: false });
    expect(replay).toMatchObject({ status: 'succeeded', replayed: true });
    expect(first.event?.syncedSources).toEqual(['google', 'outlook']);
    expect(replay.event?.syncedSources).toEqual(['google', 'outlook']);
    expect(io.updateEvent).toHaveBeenCalledTimes(1);
    expect(mockInvalidateCalendarCaches).toHaveBeenCalledTimes(1);
    expect(mockInvalidateCalendarCaches).toHaveBeenCalledWith(42);
  });

  it('preserves supported provider metadata and restores a safe source fallback', async () => {
    const io = readyIo();
    io.getEventById
      .mockResolvedValueOnce(event())
      .mockResolvedValueOnce(event({
        summary: 'Planning review moved',
        start: NEW_START,
        end: NEW_END,
        syncedSources: ['unsupported-provider'],
        description: 'Agenda context',
        location: 'Studio 2',
        categories: ['Focus'],
        color: '#123456',
        isAllDay: false,
        timeZone: 'Europe/Lisbon',
      }));

    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand({ idempotencyKey: 'calendar-mutation-rich-readback' }),
      { calendarIo: io },
    ));

    expect(result.event).toMatchObject({
      syncedSources: ['google'],
      description: 'Agenda context',
      location: 'Studio 2',
      categories: ['Focus'],
      color: '#123456',
      isAllDay: false,
      timeZone: 'Europe/Lisbon',
    });
  });

  it('replays the same public mutation across transport and account-timezone changes', async () => {
    const io = readyIo();
    io.getEventById
      .mockResolvedValueOnce(event())
      .mockResolvedValueOnce(event({ summary: 'Planning review moved', start: NEW_START, end: NEW_END }));

    await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand({ channel: 'ios' }),
      { calendarIo: io },
    ));
    const replay = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand({ channel: 'chat', timezone: 'America/New_York' }),
      { calendarIo: io },
    ));

    expect(replay).toMatchObject({ status: 'succeeded', replayed: true });
    expect(io.updateEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects key reuse with different content before another provider read', async () => {
    const io = readyIo();
    io.getEventById
      .mockResolvedValueOnce(event())
      .mockResolvedValueOnce(event({ summary: 'Planning review moved', start: NEW_START, end: NEW_END }));
    await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand(),
      { calendarIo: io },
    ));
    await expect(withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand({ title: 'Different content' }),
      { calendarIo: io },
    ))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
    expect(io.getEventById).toHaveBeenCalledTimes(2);
  });

  it('withholds a move when any configured conflict source is unavailable', async () => {
    const io = readyIo();
    io.getEventsWithDiagnostics = vi.fn().mockResolvedValue({
      events: [],
      status: 'degraded',
      warningCodes: ['OUTLOOK_CALENDAR_UNAVAILABLE'],
      warnings: ['Outlook unavailable'],
      sources: { configured: ['google', 'outlook'], fulfilled: ['google'], failed: ['outlook'] },
    });
    await expect(withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand(),
      { calendarIo: io, configuredSources: ['google', 'outlook'] },
    ))).rejects.toMatchObject({ code: 'CALENDAR_CONFLICT_STATE_UNKNOWN', status: 409 });
    expect(io.updateEvent).not.toHaveBeenCalled();
    expect(mockInvalidateCalendarCaches).not.toHaveBeenCalled();
  });

  it('uses the original receipt timezone when a failed precheck is retried after a timezone change', async () => {
    const io = readyIo();
    io.getEventsWithDiagnostics = vi.fn()
      .mockResolvedValueOnce({
        events: [],
        status: 'unavailable',
        warningCodes: ['GOOGLE_CALENDAR_UNAVAILABLE'],
        warnings: ['Google unavailable'],
        sources: { configured: ['google'], fulfilled: [], failed: ['google'] },
      })
      .mockResolvedValueOnce({
        events: [event({ id: 'event-2', start: NEW_START, end: NEW_END })],
        status: 'ready',
        warningCodes: [],
        warnings: [],
        sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
      });

    await expect(withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand(),
      { calendarIo: io },
    ))).rejects.toMatchObject({ code: 'CALENDAR_CONFLICT_STATE_UNKNOWN' });

    await expect(withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand({ timezone: 'America/New_York' }),
      { calendarIo: io },
    ))).resolves.toMatchObject({ status: 'review_required' });

    expect(io.updateEvent).not.toHaveBeenCalled();
    expect(mockCreateDecisionIntent).toHaveBeenCalledWith(expect.objectContaining({
      decisionContext: expect.objectContaining({ timezone: 'Europe/Lisbon' }),
    }));
  });

  it('creates Decision Center review and does not write an overlapping move', async () => {
    const io = readyIo();
    io.getEventsWithDiagnostics = vi.fn().mockResolvedValue({
      events: [event({ id: 'event-2', start: NEW_START, end: NEW_END })],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
    });
    mockInvalidateCalendarCaches.mockImplementationOnce(() => {
      expect(mutationReceiptState(db, 'calendar-mutation-1')).not.toBe('review_required');
    });
    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand(),
      { calendarIo: io },
    ));
    expect(result).toMatchObject({ status: 'review_required', replayed: false });
    expect(mockCreateDecisionIntent).toHaveBeenCalledTimes(1);
    expect(io.updateEvent).not.toHaveBeenCalled();
    expect(mockInvalidateCalendarCaches).toHaveBeenCalledWith(42);
  });

  it('does not treat the richer merged provider copy of the target occurrence as a conflict', async () => {
    const providerUid = 'planning-review@example.com';
    const io = readyIo(event({
      providerUid,
      providerOccurrenceStart: OLD_START,
    }));
    io.getEventsWithDiagnostics = vi.fn().mockResolvedValue({
      events: [event({
        id: 'outlook-copy',
        source: 'outlook',
        providerUid,
        providerOccurrenceStart: OLD_START,
        syncedSources: ['outlook', 'google'],
        start: NEW_START,
        end: NEW_END,
      })],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google', 'outlook'], fulfilled: ['google', 'outlook'], failed: [] },
    });
    io.getEventById
      .mockResolvedValueOnce(event({ providerUid, providerOccurrenceStart: OLD_START }))
      .mockResolvedValueOnce(event({
        summary: 'Planning review moved',
        providerUid,
        providerOccurrenceStart: OLD_START,
        start: NEW_START,
        end: NEW_END,
      }));

    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand({ idempotencyKey: 'calendar-mutation-merged-self-copy' }),
      { calendarIo: io, configuredSources: ['google', 'outlook'] },
    ));

    expect(result).toMatchObject({ status: 'succeeded', replayed: false });
    expect(io.updateEvent).toHaveBeenCalledOnce();
    expect(mockCreateDecisionIntent).not.toHaveBeenCalled();
  });

  it('does not hide a different recurring occurrence that shares the target provider UID', async () => {
    const providerUid = 'planning-review-series@example.com';
    const io = readyIo(event({
      providerUid,
      providerOccurrenceStart: OLD_START,
    }));
    io.getEventsWithDiagnostics = vi.fn().mockResolvedValue({
      events: [event({
        id: 'outlook-other-occurrence',
        source: 'outlook',
        providerUid,
        providerOccurrenceStart: NEW_START,
        syncedSources: ['outlook', 'google'],
        start: NEW_START,
        end: NEW_END,
      })],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google', 'outlook'], fulfilled: ['google', 'outlook'], failed: [] },
    });

    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand({ idempotencyKey: 'calendar-mutation-other-occurrence' }),
      { calendarIo: io, configuredSources: ['google', 'outlook'] },
    ));

    expect(result).toMatchObject({ status: 'review_required', replayed: false });
    expect(io.updateEvent).not.toHaveBeenCalled();
    expect(mockCreateDecisionIntent).toHaveBeenCalledOnce();
  });

  it('withholds a move that overlaps an unsynchronized local agenda item', async () => {
    seedLocalAgendaConflict(db);
    const io = readyIo();

    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand({ idempotencyKey: 'calendar-mutation-local-agenda-conflict' }),
      { calendarIo: io },
    ));

    expect(result).toMatchObject({ status: 'review_required', replayed: false });
    expect(mockCreateDecisionIntent).toHaveBeenCalledOnce();
    expect(io.updateEvent).not.toHaveBeenCalled();
  });

  it('withholds a move that overlaps a protected routine', async () => {
    seedProtectedRoutine(db);
    const io = readyIo();

    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand({ idempotencyKey: 'calendar-mutation-protected-routine' }),
      { calendarIo: io },
    ));

    expect(result).toMatchObject({ status: 'review_required', replayed: false });
    expect(mockCreateDecisionIntent).toHaveBeenCalledOnce();
    expect(io.updateEvent).not.toHaveBeenCalled();
  });

  it('fails closed when local agenda or routine state cannot be read', async () => {
    db.exec('DROP TABLE secretary_routine_profiles');
    const io = readyIo();

    await expect(withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand({ idempotencyKey: 'calendar-mutation-local-state-unavailable' }),
      { calendarIo: io },
    ))).rejects.toMatchObject({
      code: 'CALENDAR_CONFLICT_STATE_UNKNOWN',
      status: 409,
      warningCodes: expect.arrayContaining(['SECRETARY_LOCAL_CALENDAR_STATE_UNAVAILABLE']),
    });

    expect(io.updateEvent).not.toHaveBeenCalled();
    expect(mockInvalidateCalendarCaches).not.toHaveBeenCalled();
  });

  it('treats an already-absent delete as successful without a provider write', async () => {
    const io = readyIo();
    io.getEventById.mockResolvedValue(null);
    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation({
      ...updateCommand(),
      operation: 'delete',
      idempotencyKey: 'calendar-delete-1',
      title: undefined,
      start: undefined,
      end: undefined,
    }, { calendarIo: io }));
    expect(result).toMatchObject({ status: 'succeeded', deleted: true });
    expect(io.deleteEvent).not.toHaveBeenCalled();
  });

  it('reconciles a mapped update through the agenda provider-sync state machine', async () => {
    const agendaItemId = seedMappedAgenda(db);
    const io = mutableIo();
    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand(),
      { calendarIo: io },
    ));
    const row = db.prepare(`
      SELECT title, start_at, end_at, lifecycle_state, provider_sync_state, provider_event_id
        FROM secretary_agenda_items
       WHERE agenda_item_id = ?
    `).get(agendaItemId) as Record<string, unknown>;
    expect(result).toMatchObject({ status: 'succeeded', replayed: false });
    expect(io.updateEvent).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({
      title: 'Planning review moved',
      start_at: NEW_START,
      end_at: NEW_END,
      lifecycle_state: 'synced',
      provider_sync_state: 'synced',
      provider_event_id: 'event-1',
    });
  });

  it('allows Secretary to move a Training-owned event without changing its workout shape', async () => {
    const agendaItemId = seedMappedAgenda(db, 'training');
    const io = mutableIo();
    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand({ title: undefined }),
      { calendarIo: io },
    ));
    const row = db.prepare(`
      SELECT title, start_at, end_at, lifecycle_state, provider_sync_state,
             decision_action, decision_reason_codes_json
        FROM secretary_agenda_items
       WHERE agenda_item_id = ?
    `).get(agendaItemId) as Record<string, unknown>;
    expect(result).toMatchObject({ status: 'succeeded', replayed: false });
    expect(row).toMatchObject({
      title: 'Planning review',
      start_at: NEW_START,
      end_at: NEW_END,
      lifecycle_state: 'synced',
      provider_sync_state: 'synced',
      decision_action: 'reflowed',
      decision_reason_codes_json: '["reflowed_to_available_window"]',
    });
    expect(db.prepare(`
      SELECT event_type FROM event_outbox
       WHERE entity_id = ? AND idempotency_key LIKE '%:calendar-mutation:%'
    `).get(agendaItemId)).toEqual({
      event_type: 'secretary.training_feedback.requested.v1',
    });
  });

  it('rejects title changes for Training-owned events before a provider write', async () => {
    seedMappedAgenda(db, 'training');
    const io = mutableIo();
    await expect(withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation(
      updateCommand(),
      { calendarIo: io },
    ))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      status: 422,
      warningCodes: ['CALENDAR_TITLE_SOURCE_OWNED'],
    });
    expect(io.updateEvent).not.toHaveBeenCalled();
    expect(mockInvalidateCalendarCaches).not.toHaveBeenCalled();
  });

  it('cancels and clears a mapped agenda row through provider-sync on delete', async () => {
    const agendaItemId = seedMappedAgenda(db, 'training');
    const io = mutableIo();
    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarMutation({
      ...updateCommand(),
      operation: 'delete',
      idempotencyKey: 'calendar-delete-mapped-1',
      title: undefined,
      start: undefined,
      end: undefined,
    }, { calendarIo: io }));
    const row = db.prepare(`
      SELECT lifecycle_state, provider_sync_state, provider_event_id, provider_source,
             decision_action, decision_reason_codes_json
        FROM secretary_agenda_items
       WHERE agenda_item_id = ?
    `).get(agendaItemId) as Record<string, unknown>;
    expect(result).toMatchObject({ status: 'succeeded', deleted: true });
    expect(io.deleteEvent).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({
      lifecycle_state: 'canceled',
      provider_sync_state: 'deleted',
      provider_event_id: null,
      provider_source: null,
      decision_action: 'unscheduled',
      decision_reason_codes_json: '["removed_from_calendar_by_user"]',
    });
    expect(db.prepare(`
      SELECT event_type FROM event_outbox
       WHERE entity_id = ? AND idempotency_key LIKE '%:calendar-mutation:%'
    `).get(agendaItemId)).toEqual({
      event_type: 'secretary.training_feedback.requested.v1',
    });
  });
});
