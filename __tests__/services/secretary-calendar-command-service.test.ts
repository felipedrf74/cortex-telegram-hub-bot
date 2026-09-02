import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { withDatabaseForTest, withDatabaseForTestAsync } from '../../src/services/database';
import {
  executeSecretaryCalendarCommand,
  getSecretaryCalendarCommandMetrics,
  inspectSecretaryCalendarCommandReplay,
  resetSecretaryCalendarCommandMetricsForTests,
  resolveSecretaryCalendarIdempotencyKey,
  SECRETARY_CALENDAR_COMMAND_LIMITS,
  SecretaryCalendarCommandError,
  type SecretaryCalendarCommandCalendarIo,
  type SecretaryCalendarCommandInput,
} from '../../src/services/secretary-calendar-command-service';
import type {
  SecretaryAgendaProviderAdapter,
  SecretaryProviderEventInput,
} from '../../src/services/secretary-agenda-provider-sync';
import {
  claimSecretaryCalendarCommand,
  getSecretaryCalendarCommandPayloadForAgendaItem,
  pruneExpiredSecretaryCalendarCommandReceipts,
  releaseSecretaryCalendarCommandProcessingLease,
  updateSecretaryCalendarCommandReceipt,
} from '../../src/services/secretary-calendar-command-store';

const mockCreateDecisionIntent = vi.hoisted(() => vi.fn());
const mockInvalidateCalendarCaches = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/decision-center', () => ({
  createDecisionIntent: (...args: unknown[]) => mockCreateDecisionIntent(...args),
}));

vi.mock('../../src/services/cache-coherence-registry', () => ({
  invalidateCalendarCaches: (...args: unknown[]) => mockInvalidateCalendarCaches(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

const NOW = '2026-08-30T10:00:00.000Z';
const START = '2026-08-31T09:00:00.000Z';
const END = '2026-08-31T10:00:00.000Z';

function command(overrides: Partial<SecretaryCalendarCommandInput> = {}): SecretaryCalendarCommandInput {
  return {
    userId: 42,
    tenantId: 42,
    idempotencyKey: 'calendar-command-0001',
    source: 'google',
    title: 'Planning review',
    start: START,
    end: END,
    timezone: 'Europe/Lisbon',
    description: 'Review the launch plan.',
    location: 'Studio A',
    attendees: ['second@example.com', 'first@example.com'],
    categories: ['meeting'],
    channel: 'ios',
    nowIso: NOW,
    ...overrides,
  };
}

function readyCalendarIo(events: any[] = []): SecretaryCalendarCommandCalendarIo {
  return {
    getEventsForSources: vi.fn().mockResolvedValue(events),
    createEvent: vi.fn(),
  };
}

function providerReadbackEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'google-provider-event-1',
    source: 'google' as const,
    summary: 'Planning review',
    start: START,
    end: END,
    description: 'Review the launch plan.',
    location: 'Studio A',
    ...overrides,
  };
}

function providerAdapter(): SecretaryAgendaProviderAdapter & {
  createEvent: ReturnType<typeof vi.fn>;
} {
  return {
    source: 'google',
    createEvent: vi.fn(async (input: SecretaryProviderEventInput) => ({
      eventId: 'google-provider-event-1',
      source: 'google' as const,
      agendaItemId: input.agendaItemId,
      title: input.title,
      startAt: input.startAt,
      endAt: input.endAt,
      version: input.version,
    })),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn(),
  };
}

function seedUser(db: Database.Database): void {
  db.prepare(`
    INSERT INTO users (id, telegram_id, first_name, language, timezone, status, auth_provider)
    VALUES (42, 42, 'Calendar Tester', 'en-US', 'Europe/Lisbon', 'active', 'invite_code')
  `).run();
}

function seedProtectedRoutine(
  db: Database.Database,
  input: { start: string; end: string; label?: string },
): void {
  db.prepare(`
    INSERT INTO secretary_routine_profiles (
      user_id, tenant_id, version, working_windows_json,
      preferred_focus_windows_json, protected_routines_json,
      created_at, updated_at
    ) VALUES (?, ?, 1, '[]', '[]', ?, ?, ?)
  `).run(42, 42, JSON.stringify([{
    id: '11111111-1111-4111-8111-111111111111',
    weekdays: [1],
    start: input.start,
    end: input.end,
    label: input.label ?? 'Protected recovery',
    kind: 'recovery',
  }]), NOW, NOW);
}

function receipt(db: Database.Database, key: string): any {
  return db.prepare(`
    SELECT state, agenda_item_id, decision_item_id, response_json
      FROM secretary_calendar_command_receipts
     WHERE user_id = 42 AND tenant_id = '42' AND idempotency_key = ?
  `).get(key);
}

describe.sequential('Secretary calendar command service', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
    seedUser(db);
    resetSecretaryCalendarCommandMetricsForTests();
    mockInvalidateCalendarCaches.mockReset();
    mockCreateDecisionIntent.mockReset();
    mockCreateDecisionIntent.mockResolvedValue({
      item: { itemId: 'decision-calendar-overlap' },
      eligibility: { classification: 'decision', reasons: [] },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
    vi.restoreAllMocks();
  });

  it('rejects a tenant mismatch before receipt or provider I/O', async () => {
    const forbiddenDb = new Proxy({} as Database.Database, {
      get() {
        throw new Error('database was touched');
      },
    });
    const calendarIo = readyCalendarIo();
    const adapter = providerAdapter();

    await expect(withDatabaseForTestAsync(forbiddenDb, () => executeSecretaryCalendarCommand(
      command({ tenantId: 7 }),
      { calendarIo, providerAdapter: adapter },
    ))).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
      code: 'TENANT_SCOPE_MISMATCH',
      status: 403,
    });
    expect(calendarIo.getEventsForSources).not.toHaveBeenCalled();
    expect(adapter.createEvent).not.toHaveBeenCalled();
  });

  it('rejects a replay-probe tenant mismatch before its first receipt read', () => {
    const forbiddenDb = new Proxy({} as Database.Database, {
      get() {
        throw new Error('database was touched');
      },
    });
    const { source: _source, ...probe } = command({ tenantId: 7 });

    expect(() => withDatabaseForTest(forbiddenDb, () =>
      inspectSecretaryCalendarCommandReplay(probe))).toThrowError(expect.objectContaining({
      code: 'TENANT_SCOPE_MISMATCH',
      status: 403,
    }));
  });

  it('leases a nonterminal receipt to one process and permits recovery after release', () => {
    const claim = () => withDatabaseForTest(db, () => claimSecretaryCalendarCommand({
      userId: 42,
      tenantId: 42,
      idempotencyKey: 'calendar-command-concurrent-1',
      requestHash: 'a'.repeat(64),
      providerSource: 'google',
      command: {
        title: 'Planning review',
        start: START,
        end: END,
        timezone: 'Europe/Lisbon',
        channel: 'ios',
      },
      nowIso: NOW,
      expiresAt: '2026-09-29T10:00:00.000Z',
    }));

    const first = claim();
    const concurrent = claim();
    expect(first).toMatchObject({ created: true, acquired: true });
    expect(concurrent).toMatchObject({ created: false, acquired: false, leaseToken: null });

    withDatabaseForTest(db, () => releaseSecretaryCalendarCommandProcessingLease({
      userId: 42,
      tenantId: 42,
      idempotencyKey: 'calendar-command-concurrent-1',
      leaseToken: first.leaseToken!,
    }));
    const conflicting = withDatabaseForTest(db, () => claimSecretaryCalendarCommand({
      userId: 42,
      tenantId: 42,
      idempotencyKey: 'calendar-command-concurrent-1',
      requestHash: 'c'.repeat(64),
      providerSource: 'google',
      command: {
        title: 'Different command',
        start: '2026-08-31T09:00:00.000Z',
        end: '2026-08-31T10:00:00.000Z',
        timezone: 'Europe/Lisbon',
        channel: 'rest',
      },
      nowIso: '2026-08-31T08:00:00.000Z',
      expiresAt: '2026-09-30T08:00:00.000Z',
    }));
    expect(conflicting).toMatchObject({ created: false, acquired: false, leaseToken: null });
    expect(claim()).toMatchObject({ created: false, acquired: true });
  });

  it('fences a stale receipt writer after another worker acquires recovery', () => {
    const input = {
      userId: 42,
      tenantId: 42,
      idempotencyKey: 'calendar-command-stale-writer',
      requestHash: 'd'.repeat(64),
      providerSource: 'google' as const,
      command: {
        title: 'Planning review',
        start: START,
        end: END,
        timezone: 'Europe/Lisbon',
        channel: 'ios' as const,
      },
      expiresAt: '2026-09-29T10:00:00.000Z',
    };
    const first = withDatabaseForTest(db, () => claimSecretaryCalendarCommand({
      ...input,
      nowIso: NOW,
    }));
    const recovered = withDatabaseForTest(db, () => claimSecretaryCalendarCommand({
      ...input,
      nowIso: '2026-08-30T10:06:00.000Z',
    }));

    expect(recovered).toMatchObject({ created: false, acquired: true });
    expect(() => withDatabaseForTest(db, () => updateSecretaryCalendarCommandReceipt({
      userId: 42,
      tenantId: 42,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      leaseToken: first.leaseToken!,
    }, {
      state: 'sync_pending',
      updatedAt: '2026-08-30T10:06:01.000Z',
    }))).toThrow('SECRETARY_CALENDAR_COMMAND_RECEIPT_STALE');
  });

  it('rejects oversized durable fields before receipt or provider I/O', async () => {
    const forbiddenDb = new Proxy({} as Database.Database, {
      get() {
        throw new Error('database was touched');
      },
    });
    const calendarIo = readyCalendarIo();
    const adapter = providerAdapter();

    await expect(withDatabaseForTestAsync(forbiddenDb, () => executeSecretaryCalendarCommand(
      command({
        description: 'x'.repeat(SECRETARY_CALENDAR_COMMAND_LIMITS.descriptionCharacters + 1),
      }),
      { calendarIo, providerAdapter: adapter },
    ))).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
      code: 'INVALID_INPUT',
      status: 400,
    });
    expect(calendarIo.getEventsForSources).not.toHaveBeenCalled();
    expect(adapter.createEvent).not.toHaveBeenCalled();
  });

  it('rejects malformed attendee and idempotency input before receipt or provider I/O', async () => {
    const forbiddenDb = new Proxy({} as Database.Database, {
      get() {
        throw new Error('database was touched');
      },
    });
    const calendarIo = readyCalendarIo();
    const adapter = providerAdapter();

    await expect(withDatabaseForTestAsync(forbiddenDb, () => executeSecretaryCalendarCommand(
      command({ attendees: ['not-an-email'] }),
      { calendarIo, providerAdapter: adapter },
    ))).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
      code: 'INVALID_INPUT',
      status: 400,
    });
    await expect(withDatabaseForTestAsync(forbiddenDb, () => executeSecretaryCalendarCommand(
      command({ idempotencyKey: 'bad\nkey' }),
      { calendarIo, providerAdapter: adapter },
    ))).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
      code: 'INVALID_INPUT',
      status: 400,
    });

    expect(calendarIo.getEventsForSources).not.toHaveBeenCalled();
    expect(adapter.createEvent).not.toHaveBeenCalled();
  });

  it('rejects malformed optional field types and unsupported categories before receipt or provider I/O', async () => {
    const forbiddenDb = new Proxy({} as Database.Database, {
      get() {
        throw new Error('database was touched');
      },
    });
    const calendarIo = readyCalendarIo();
    const adapter = providerAdapter();
    const malformed = [
      command({ description: 42 as unknown as string }),
      command({ location: { room: 'A' } as unknown as string }),
      command({ attendees: 'first@example.com' as unknown as string[] }),
      command({ categories: ['provider-private-category'] }),
      command({ start: '2026-08-31' }),
    ];

    for (const input of malformed) {
      await expect(withDatabaseForTestAsync(forbiddenDb, () => executeSecretaryCalendarCommand(
        input,
        { calendarIo, providerAdapter: adapter },
      ))).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
        code: 'INVALID_INPUT',
        status: 400,
      });
    }
    expect(calendarIo.getEventsForSources).not.toHaveBeenCalled();
    expect(adapter.createEvent).not.toHaveBeenCalled();
  });

  it('routes caller-specific read-only commitments into the same Decision Center review', async () => {
    const calendarIo = readyCalendarIo([]);
    const adapter = providerAdapter();

    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarCommand(
      command({ idempotencyKey: 'calendar-command-local-focus-conflict' }),
      {
        calendarIo,
        providerAdapter: adapter,
        additionalConflicts: [{
          id: 'sleep-window-1',
          title: 'Protected recovery',
          start: START,
          end: END,
          sourceLabel: 'apple_health',
        }],
      },
    ));

    expect(result).toMatchObject({ status: 'review_required', replayed: false });
    expect(mockCreateDecisionIntent).toHaveBeenCalledOnce();
    expect(adapter.createEvent).not.toHaveBeenCalled();
    expect(receipt(db, 'calendar-command-local-focus-conflict')).toMatchObject({
      state: 'review_required',
      decision_item_id: 'decision-calendar-overlap',
    });
  });

  it('routes an overlapping protected routine into review without a provider write', async () => {
    seedProtectedRoutine(db, { start: '10:00', end: '11:00' });
    const calendarIo = readyCalendarIo([]);
    const adapter = providerAdapter();

    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarCommand(
      command({ idempotencyKey: 'calendar-command-protected-routine' }),
      { calendarIo, providerAdapter: adapter },
    ));

    expect(result).toMatchObject({ status: 'review_required', replayed: false });
    expect(mockCreateDecisionIntent).toHaveBeenCalledWith(expect.objectContaining({
      decisionContext: expect.objectContaining({
        conflictComparisons: expect.arrayContaining([
          expect.objectContaining({
            action: expect.objectContaining({ intent: 'preserve_confirmed_calendar_commitment' }),
          }),
        ]),
      }),
    }));
    expect(adapter.createEvent).not.toHaveBeenCalled();
  });

  it('fails closed when local agenda or routine state cannot be read', async () => {
    db.exec('DROP TABLE secretary_routine_profiles');
    const calendarIo = readyCalendarIo([]);
    const adapter = providerAdapter();

    await expect(withDatabaseForTestAsync(db, () => executeSecretaryCalendarCommand(
      command({ idempotencyKey: 'calendar-command-local-state-unavailable' }),
      { calendarIo, providerAdapter: adapter },
    ))).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
      code: 'CALENDAR_CONFLICT_STATE_UNKNOWN',
      status: 409,
      warningCodes: expect.arrayContaining(['SECRETARY_LOCAL_CALENDAR_STATE_UNAVAILABLE']),
    });

    expect(adapter.createEvent).not.toHaveBeenCalled();
    expect(receipt(db, 'calendar-command-local-state-unavailable')).toMatchObject({
      state: 'conflict_unknown',
    });
  });

  it('bounds recurrence depth and aggregate durable bytes before receipt claim', async () => {
    const forbiddenDb = new Proxy({} as Database.Database, {
      get() {
        throw new Error('database was touched');
      },
    });
    const calendarIo = readyCalendarIo();
    const adapter = providerAdapter();
    const tooDeep = { level1: { level2: { level3: { level4: { level5: { level6: true } } } } } };

    await expect(withDatabaseForTestAsync(forbiddenDb, () => executeSecretaryCalendarCommand(
      command({ recurrence: tooDeep }),
      { calendarIo, providerAdapter: adapter },
    ))).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
      code: 'INVALID_INPUT',
      status: 400,
    });

    await expect(withDatabaseForTestAsync(forbiddenDb, () => executeSecretaryCalendarCommand(
      command({
        description: 'd'.repeat(SECRETARY_CALENDAR_COMMAND_LIMITS.descriptionCharacters),
        location: 'l'.repeat(SECRETARY_CALENDAR_COMMAND_LIMITS.locationCharacters),
        attendees: Array.from(
          { length: SECRETARY_CALENDAR_COMMAND_LIMITS.attendees },
          (_, index) => `${String(index).padStart(3, '0')}-${'a'.repeat(300)}@example.com`,
        ),
      }),
      { calendarIo, providerAdapter: adapter },
    ))).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
      code: 'INVALID_INPUT',
      status: 400,
    });
    expect(calendarIo.getEventsForSources).not.toHaveBeenCalled();
    expect(adapter.createEvent).not.toHaveBeenCalled();
  });

  it('persists the local agenda and replays the same public body across an account-timezone change', async () => {
    const calendarIo = readyCalendarIo();
    vi.mocked(calendarIo.getEventsForSources)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([providerReadbackEvent()]);
    const adapter = providerAdapter();
    const input = command();
    mockInvalidateCalendarCaches.mockImplementationOnce(() => {
      expect(receipt(db, input.idempotencyKey)?.state).not.toBe('succeeded');
    });

    const [first, replay] = await withDatabaseForTestAsync(db, async () => {
      const created = await executeSecretaryCalendarCommand(input, { calendarIo, providerAdapter: adapter });
      const repeated = await executeSecretaryCalendarCommand(
        { ...input, timezone: 'America/New_York' },
        { calendarIo, providerAdapter: adapter },
      );
      return [created, repeated] as const;
    });

    expect(first).toMatchObject({
      status: 'succeeded',
      replayed: false,
      event: {
        id: 'google-provider-event-1',
        source: 'google',
        syncedSources: ['google'],
      },
    });
    expect(replay).toMatchObject({ status: 'succeeded', replayed: true });
    expect(adapter.createEvent).toHaveBeenCalledTimes(1);
    expect(calendarIo.getEventsForSources).toHaveBeenCalledTimes(2);
    expect(mockInvalidateCalendarCaches).toHaveBeenCalledTimes(1);
    expect(mockInvalidateCalendarCaches).toHaveBeenCalledWith(42);
    expect(adapter.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Review the launch plan.',
      location: 'Studio A',
      attendees: ['first@example.com', 'second@example.com'],
      categories: ['meeting'],
    }));
    expect(receipt(db, input.idempotencyKey)).toMatchObject({
      state: 'succeeded',
      agenda_item_id: expect.any(String),
    });
    expect(db.prepare(`
      SELECT lifecycle_state, provider_sync_state, provider_event_id, provider_source
        FROM secretary_agenda_items
       WHERE agenda_item_id = ?
    `).get(receipt(db, input.idempotencyKey).agenda_item_id)).toEqual({
      lifecycle_state: 'synced',
      provider_sync_state: 'synced',
      provider_event_id: 'google-provider-event-1',
      provider_source: 'google',
    });
  });

  it('stores and replays the provider-authoritative create readback', async () => {
    const calendarIo = readyCalendarIo();
    const adapter = providerAdapter();
    adapter.getEvent = vi.fn(async (_eventId, providerInput) => ({
      status: 'found' as const,
      event: {
        eventId: 'google-provider-event-1',
        source: 'google' as const,
        agendaItemId: providerInput!.agendaItemId,
        title: 'Planning review (provider normalized)',
        startAt: '2026-08-31T09:00:30.000Z',
        endAt: '2026-08-31T10:00:30.000Z',
        version: providerInput!.version,
      },
    }));
    const input = command({ idempotencyKey: 'calendar-provider-authoritative-readback' });

    const [created, replay] = await withDatabaseForTestAsync(db, async () => {
      const first = await executeSecretaryCalendarCommand(input, { calendarIo, providerAdapter: adapter });
      return [first, await executeSecretaryCalendarCommand(input, { calendarIo, providerAdapter: adapter })] as const;
    });

    expect(created).toMatchObject({
      status: 'succeeded',
      replayed: false,
      event: {
        id: 'google-provider-event-1',
        summary: 'Planning review (provider normalized)',
        start: '2026-08-31T09:00:30.000Z',
        end: '2026-08-31T10:00:30.000Z',
      },
    });
    expect(replay).toMatchObject({
      replayed: true,
      event: { summary: 'Planning review (provider normalized)' },
    });
    expect(adapter.getEvent).toHaveBeenCalledTimes(1);
    expect(adapter.createEvent).toHaveBeenCalledTimes(1);
  });

  it('replays an unexpired terminal receipt without provider I/O and adopts its stored source', async () => {
    const calendarIo = readyCalendarIo();
    vi.mocked(calendarIo.getEventsForSources)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([providerReadbackEvent()]);
    const adapter = providerAdapter();
    const input = command({ idempotencyKey: 'calendar-command-replay-probe' });

    const replay = await withDatabaseForTestAsync(db, async () => {
      await executeSecretaryCalendarCommand(input, { calendarIo, providerAdapter: adapter });
      const { source: _source, ...probe } = input;
      return inspectSecretaryCalendarCommandReplay(probe);
    });

    expect(replay).toMatchObject({
      source: 'google',
      result: {
        status: 'succeeded',
        replayed: true,
        event: { id: 'google-provider-event-1', source: 'google' },
      },
    });
    expect(adapter.createEvent).toHaveBeenCalledTimes(1);
    expect(calendarIo.getEventsForSources).toHaveBeenCalledTimes(2);
  });

  it('keeps replay-probe key/body validation and receipt expiry fail-closed', async () => {
    const calendarIo = readyCalendarIo();
    vi.mocked(calendarIo.getEventsForSources)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([providerReadbackEvent()]);
    const adapter = providerAdapter();
    const input = command({ idempotencyKey: 'calendar-command-replay-validation' });

    await withDatabaseForTestAsync(db, async () => {
      await executeSecretaryCalendarCommand(input, { calendarIo, providerAdapter: adapter });
      const { source: _source, ...probe } = input;
      expect(() => inspectSecretaryCalendarCommandReplay({
        ...probe,
        title: 'Different content',
      })).toThrowError(expect.objectContaining({
        code: 'IDEMPOTENCY_KEY_REUSED',
        status: 409,
      }));

      db.prepare(`
        UPDATE secretary_calendar_command_receipts
           SET expires_at = '2026-08-29T00:00:00.000Z'
         WHERE user_id = 42 AND tenant_id = '42' AND idempotency_key = ?
      `).run(input.idempotencyKey);
      expect(inspectSecretaryCalendarCommandReplay(probe)).toBeNull();
    });

    expect(adapter.createEvent).toHaveBeenCalledTimes(1);
    expect(calendarIo.getEventsForSources).toHaveBeenCalledTimes(2);
  });

  it('uses the durable item lease to fence concurrent exact-key provider writes', async () => {
    const calendarIo = readyCalendarIo();
    vi.mocked(calendarIo.getEventsForSources)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([providerReadbackEvent()]);
    const adapter = providerAdapter();
    let announceProviderCall!: () => void;
    let releaseProviderCall!: () => void;
    const providerCallStarted = new Promise<void>((resolve) => { announceProviderCall = resolve; });
    const providerCallRelease = new Promise<void>((resolve) => { releaseProviderCall = resolve; });
    adapter.createEvent.mockImplementation(async (input: SecretaryProviderEventInput) => {
      announceProviderCall();
      await providerCallRelease;
      return {
        eventId: 'google-provider-event-1',
        source: 'google' as const,
        agendaItemId: input.agendaItemId,
        title: input.title,
        startAt: input.startAt,
        endAt: input.endAt,
        version: input.version,
      };
    });

    await withDatabaseForTestAsync(db, async () => {
      const first = executeSecretaryCalendarCommand(command(), { calendarIo, providerAdapter: adapter });
      await providerCallStarted;

      await expect(executeSecretaryCalendarCommand(command(), {
        calendarIo,
        providerAdapter: adapter,
      })).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
        code: 'CALENDAR_SYNC_PENDING',
        status: 409,
        warningCodes: expect.arrayContaining(['CALENDAR_COMMAND_LEASE_HELD']),
      });

      expect(adapter.createEvent).toHaveBeenCalledTimes(1);
      releaseProviderCall();
      await expect(first).resolves.toMatchObject({ status: 'succeeded', replayed: false });
    });

    expect(adapter.createEvent).toHaveBeenCalledTimes(1);
  });

  it('retains the agenda provider payload after the 30-day replay receipt expires', async () => {
    const calendarIo = readyCalendarIo();
    vi.mocked(calendarIo.getEventsForSources)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([providerReadbackEvent()]);
    const adapter = providerAdapter();

    await withDatabaseForTestAsync(db, async () => {
      await executeSecretaryCalendarCommand(command({
        idempotencyKey: 'calendar-command-payload-retention',
        recurrence: { frequency: 'weekly', interval: 1 },
      }), { calendarIo, providerAdapter: adapter });
      const stored = receipt(db, 'calendar-command-payload-retention');
      db.prepare(`
        UPDATE secretary_calendar_command_receipts
           SET expires_at = '2026-08-01T00:00:00.000Z'
         WHERE idempotency_key = 'calendar-command-payload-retention'
      `).run();

      expect(pruneExpiredSecretaryCalendarCommandReceipts({ nowIso: NOW }))
        .toEqual({ deleted: 1, remaining: 0 });
      expect(receipt(db, 'calendar-command-payload-retention')).toBeUndefined();
      expect(getSecretaryCalendarCommandPayloadForAgendaItem(stored.agenda_item_id)).toMatchObject({
        description: 'Review the launch plan.',
        location: 'Studio A',
        attendees: ['first@example.com', 'second@example.com'],
        categories: ['meeting'],
        recurrence: { frequency: 'weekly', interval: 1 },
      });
    });
  });

  it('passes attendees, location, categories, recurrence, and the agenda marker through injected route/chat I/O', async () => {
    const calendarIo = readyCalendarIo();
    vi.mocked(calendarIo.getEventsForSources)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([providerReadbackEvent()]);
    vi.mocked(calendarIo.createEvent).mockResolvedValue(providerReadbackEvent());

    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarCommand(command({
      idempotencyKey: 'calendar-command-injected-payload',
      recurrence: { frequency: 'weekly', interval: 1 },
    }), { calendarIo }));

    expect(result).toMatchObject({ status: 'succeeded', replayed: false });
    expect(calendarIo.createEvent).toHaveBeenCalledTimes(1);
    expect(calendarIo.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Planning review',
        description: expect.stringMatching(/Review the launch plan\.[\s\S]*NEXUS_SECRETARY_AGENDA_ITEM:/),
        location: 'Studio A',
        attendees: ['first@example.com', 'second@example.com'],
        categories: ['meeting'],
        recurrence: { frequency: 'weekly', interval: 1 },
      }),
      'google',
      42,
      { tenantId: 42 },
    );
  });

  it('does not verify an older provider event that only matches the created title and time', async () => {
    vi.stubEnv('SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES', '0');
    const calendarIo = readyCalendarIo();
    const staleDuplicate = providerReadbackEvent({ id: 'google-provider-event-older' });
    const exactCreated = providerReadbackEvent({ id: 'google-provider-event-created' });
    vi.mocked(calendarIo.getEventsForSources)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([staleDuplicate])
      .mockResolvedValueOnce([staleDuplicate, exactCreated]);
    vi.mocked(calendarIo.createEvent).mockResolvedValue(exactCreated);
    const input = command({ idempotencyKey: 'calendar-command-exact-provider-id' });

    await withDatabaseForTestAsync(db, async () => {
      await expect(executeSecretaryCalendarCommand(input, { calendarIo }))
        .rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
          code: 'CALENDAR_SYNC_PENDING',
          warningCodes: expect.arrayContaining(['CALENDAR_READBACK_MISMATCH']),
        });
      expect(receipt(db, input.idempotencyKey)).toMatchObject({ state: 'sync_pending' });

      await expect(executeSecretaryCalendarCommand(input, { calendarIo }))
        .resolves.toMatchObject({
          status: 'succeeded',
          event: { id: 'google-provider-event-created' },
        });
    });

    expect(calendarIo.createEvent).toHaveBeenCalledTimes(1);
  });

  it('recovers a provider-success readback ambiguity without a second write after verification becomes stale', async () => {
    vi.stubEnv('SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES', '0');
    const calendarIo = readyCalendarIo();
    vi.mocked(calendarIo.getEventsForSources)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([providerReadbackEvent()]);
    vi.mocked(calendarIo.createEvent).mockResolvedValue(providerReadbackEvent());
    const input = command({ idempotencyKey: 'calendar-command-readback-recovery' });

    await withDatabaseForTestAsync(db, async () => {
      await expect(executeSecretaryCalendarCommand(input, { calendarIo }))
        .rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
          code: 'CALENDAR_SYNC_PENDING',
          warningCodes: expect.arrayContaining(['CALENDAR_READBACK_MISMATCH']),
        });
      await expect(executeSecretaryCalendarCommand(input, { calendarIo }))
        .resolves.toMatchObject({ status: 'succeeded', replayed: false });
    });

    expect(calendarIo.createEvent).toHaveBeenCalledTimes(1);
    expect(receipt(db, input.idempotencyKey)).toMatchObject({ state: 'succeeded' });
  });

  it('retains the provider payload while its agenda item can still require reconciliation after receipt expiry', async () => {
    const calendarIo = readyCalendarIo();
    vi.mocked(calendarIo.getEventsForSources)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([providerReadbackEvent()]);
    const adapter = providerAdapter();
    const key = 'calendar-command-payload-retention';

    const agendaItemId = await withDatabaseForTestAsync(db, async () => {
      await executeSecretaryCalendarCommand(command({
        idempotencyKey: key,
        recurrence: { frequency: 'weekly', interval: 1 },
      }), { calendarIo, providerAdapter: adapter });
      const row = receipt(db, key);
      db.prepare(`
        UPDATE secretary_calendar_command_receipts
           SET expires_at = '2026-08-01T00:00:00.000Z'
         WHERE user_id = 42 AND tenant_id = '42' AND idempotency_key = ?
      `).run(key);
      pruneExpiredSecretaryCalendarCommandReceipts({ nowIso: '2026-09-01T00:00:00.000Z' });
      return row.agenda_item_id as string;
    });

    await expect(withDatabaseForTestAsync(db, async () =>
      getSecretaryCalendarCommandPayloadForAgendaItem(agendaItemId))).resolves.toMatchObject({
      description: 'Review the launch plan.',
      location: 'Studio A',
      attendees: ['first@example.com', 'second@example.com'],
      categories: ['meeting'],
      recurrence: { frequency: 'weekly', interval: 1 },
    });
  });

  it('treats changed content as an independent command when an old replay key has expired', async () => {
    const nextStart = '2026-10-01T11:00:00.000Z';
    const nextEnd = '2026-10-01T12:00:00.000Z';
    const calendarIo = readyCalendarIo();
    vi.mocked(calendarIo.getEventsForSources)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([providerReadbackEvent()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([providerReadbackEvent({
        id: 'google-provider-event-2',
        summary: 'Independent follow-up',
        start: nextStart,
        end: nextEnd,
      })]);
    const adapter = providerAdapter();
    adapter.createEvent
      .mockImplementationOnce(async (input: SecretaryProviderEventInput) => ({
        eventId: 'google-provider-event-1',
        source: 'google' as const,
        agendaItemId: input.agendaItemId,
        title: input.title,
        startAt: input.startAt,
        endAt: input.endAt,
        version: input.version,
      }))
      .mockImplementationOnce(async (input: SecretaryProviderEventInput) => ({
        eventId: 'google-provider-event-2',
        source: 'google' as const,
        agendaItemId: input.agendaItemId,
        title: input.title,
        startAt: input.startAt,
        endAt: input.endAt,
        version: input.version,
      }));
    const key = 'calendar-command-expired-key-reuse';

    await withDatabaseForTestAsync(db, async () => {
      await executeSecretaryCalendarCommand(command({ idempotencyKey: key }), {
        calendarIo,
        providerAdapter: adapter,
      });
      db.prepare(`
        UPDATE secretary_calendar_command_receipts
           SET expires_at = '2026-09-01T00:00:00.000Z'
         WHERE user_id = 42 AND tenant_id = '42' AND idempotency_key = ?
      `).run(key);
      expect(pruneExpiredSecretaryCalendarCommandReceipts({
        nowIso: '2026-09-30T10:00:00.000Z',
      })).toEqual({ deleted: 1, remaining: 0 });

      await executeSecretaryCalendarCommand(command({
        idempotencyKey: key,
        title: 'Independent follow-up',
        start: nextStart,
        end: nextEnd,
        nowIso: '2026-09-30T10:00:00.000Z',
      }), { calendarIo, providerAdapter: adapter });
    });

    expect(adapter.createEvent).toHaveBeenCalledTimes(2);
    const rows = db.prepare(`
      SELECT source_intent_id, lifecycle_state, provider_sync_state,
             provider_event_id, superseded_by_agenda_item_id
        FROM secretary_agenda_items
       WHERE owner_user_id = 42 AND tenant_id = '42'
       ORDER BY created_at, agenda_item_id
    `).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.source_intent_id)).size).toBe(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        lifecycle_state: 'synced',
        provider_sync_state: 'synced',
        provider_event_id: 'google-provider-event-1',
        superseded_by_agenda_item_id: null,
      }),
      expect.objectContaining({
        lifecycle_state: 'synced',
        provider_sync_state: 'synced',
        provider_event_id: 'google-provider-event-2',
        superseded_by_agenda_item_id: null,
      }),
    ]));
  });

  it('returns 409 for reuse of a key with different content without a second read or write', async () => {
    const calendarIo = readyCalendarIo();
    vi.mocked(calendarIo.getEventsForSources)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([providerReadbackEvent()]);
    const adapter = providerAdapter();
    const input = command();

    await withDatabaseForTestAsync(db, async () => {
      await executeSecretaryCalendarCommand(input, { calendarIo, providerAdapter: adapter });
      await expect(executeSecretaryCalendarCommand(
        { ...input, title: 'Different content' },
        { calendarIo, providerAdapter: adapter },
      )).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
        code: 'IDEMPOTENCY_KEY_REUSED',
        status: 409,
      });
    });

    expect(calendarIo.getEventsForSources).toHaveBeenCalledTimes(2);
    expect(adapter.createEvent).toHaveBeenCalledTimes(1);
  });

  it('fails closed when conflict state is unknown and performs no agenda or provider write', async () => {
    const calendarIo = readyCalendarIo();
    vi.mocked(calendarIo.getEventsForSources).mockRejectedValueOnce(new Error('provider unavailable'));
    const adapter = providerAdapter();

    await withDatabaseForTestAsync(db, async () => {
      await expect(executeSecretaryCalendarCommand(command(), {
        calendarIo,
        providerAdapter: adapter,
      })).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
        code: 'CALENDAR_CONFLICT_STATE_UNKNOWN',
        status: 409,
      });
    });

    expect(adapter.createEvent).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_agenda_items').get()).toEqual({ count: 0 });
    expect(receipt(db, 'calendar-command-0001')).toMatchObject({ state: 'conflict_unknown' });
  });

  it('resumes a nonterminal retry with the receipt timezone after account timezone changes', async () => {
    const calendarIo = readyCalendarIo();
    vi.mocked(calendarIo.getEventsForSources)
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce([providerReadbackEvent({ id: 'existing-conflict' })]);
    const adapter = providerAdapter();

    await withDatabaseForTestAsync(db, async () => {
      await expect(executeSecretaryCalendarCommand(command(), {
        calendarIo,
        providerAdapter: adapter,
      })).rejects.toMatchObject({ code: 'CALENDAR_CONFLICT_STATE_UNKNOWN' });

      await expect(executeSecretaryCalendarCommand(
        command({ timezone: 'America/New_York' }),
        { calendarIo, providerAdapter: adapter },
      )).resolves.toMatchObject({ status: 'review_required' });
    });

    expect(adapter.createEvent).not.toHaveBeenCalled();
    expect(mockCreateDecisionIntent).toHaveBeenCalledWith(expect.objectContaining({
      decisionContext: expect.objectContaining({ timezone: 'Europe/Lisbon' }),
    }));
  });

  it('fails closed when one configured provider is degraded instead of treating a partial read as all-clear', async () => {
    const getEventsWithDiagnostics = vi.fn().mockResolvedValue({
      events: [],
      status: 'degraded',
      warningCodes: ['OUTLOOK_CALENDAR_UNAVAILABLE'],
      warnings: ['Outlook Calendar is unavailable right now.'],
      sources: { configured: ['google', 'outlook'], fulfilled: ['google'], failed: ['outlook'] },
    });
    const calendarIo: SecretaryCalendarCommandCalendarIo = {
      getEventsWithDiagnostics,
      getEventsForSources: vi.fn(),
      createEvent: vi.fn(),
    };
    const adapter = providerAdapter();

    await withDatabaseForTestAsync(db, async () => {
      await expect(executeSecretaryCalendarCommand(command(), {
        calendarIo,
        configuredSources: ['google', 'outlook'],
        providerAdapter: adapter,
      })).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
        code: 'CALENDAR_CONFLICT_STATE_UNKNOWN',
        status: 409,
        warningCodes: expect.arrayContaining([
          'CALENDAR_CONFLICT_STATE_UNKNOWN',
          'OUTLOOK_CALENDAR_UNAVAILABLE',
        ]),
      });
    });

    expect(getEventsWithDiagnostics).toHaveBeenCalledWith(
      START,
      END,
      42,
      { sources: ['google', 'outlook'] },
    );
    expect(adapter.createEvent).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_agenda_items').get()).toEqual({ count: 0 });
  });

  it('probes legacy calendar adapters per provider so a partial multi-provider read cannot look ready', async () => {
    const getEventsForSources = vi.fn(async (
      _start: string,
      _end: string,
      _userId: number,
      sources: Array<'google' | 'outlook'>,
    ) => {
      if (sources[0] === 'outlook') throw new Error('outlook temporarily unavailable');
      return [];
    });
    const calendarIo: SecretaryCalendarCommandCalendarIo = {
      getEventsForSources,
      createEvent: vi.fn(),
    };
    const adapter = providerAdapter();

    await withDatabaseForTestAsync(db, async () => {
      await expect(executeSecretaryCalendarCommand(command(), {
        calendarIo,
        configuredSources: ['google', 'outlook'],
        providerAdapter: adapter,
      })).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
        code: 'CALENDAR_CONFLICT_STATE_UNKNOWN',
        status: 409,
        warningCodes: expect.arrayContaining([
          'CALENDAR_CONFLICT_STATE_UNKNOWN',
          'OUTLOOK_CALENDAR_UNAVAILABLE',
        ]),
      });
    });

    expect(getEventsForSources).toHaveBeenCalledTimes(2);
    expect(getEventsForSources).toHaveBeenNthCalledWith(1, START, END, 42, ['google']);
    expect(getEventsForSources).toHaveBeenNthCalledWith(2, START, END, 42, ['outlook']);
    expect(calendarIo.createEvent).not.toHaveBeenCalled();
    expect(adapter.createEvent).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_agenda_items').get()).toEqual({ count: 0 });
  });

  it('deduplicates stable-UID copies returned by legacy per-provider conflict reads', async () => {
    const providerUid = 'shared-planning-review@example.com';
    const getEventsForSources = vi.fn(async (
      _start: string,
      _end: string,
      _userId: number,
      sources: Array<'google' | 'outlook'>,
    ) => [providerReadbackEvent({
      id: `${sources[0]}-copy`,
      source: sources[0],
      providerUid,
      organizer: 'owner@example.com',
    })]);
    const calendarIo: SecretaryCalendarCommandCalendarIo = {
      getEventsForSources,
      createEvent: vi.fn(),
    };
    const adapter = providerAdapter();

    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarCommand(
      command({ idempotencyKey: 'calendar-command-legacy-provider-dedup' }),
      { calendarIo, configuredSources: ['google', 'outlook'], providerAdapter: adapter },
    ));

    expect(result).toMatchObject({ status: 'review_required', replayed: false });
    expect(getEventsForSources).toHaveBeenCalledTimes(2);
    const decisionInput = mockCreateDecisionIntent.mock.calls[0]?.[0] as {
      decisionContext?: { conflictComparisons?: unknown[] };
    };
    expect(decisionInput.decisionContext?.conflictComparisons).toHaveLength(1);
    expect(adapter.createEvent).not.toHaveBeenCalled();
  });

  it('does not resume a pre-write receipt against a target missing from the authoritative provider inventory', async () => {
    const calendarIo = readyCalendarIo();
    const adapter = providerAdapter();

    await withDatabaseForTestAsync(db, async () => {
      await expect(executeSecretaryCalendarCommand(command(), {
        calendarIo,
        configuredSources: ['outlook'],
        providerAdapter: adapter,
      })).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
        code: 'CALENDAR_CONFLICT_STATE_UNKNOWN',
        status: 409,
        warningCodes: expect.arrayContaining([
          'CALENDAR_CONFLICT_STATE_UNKNOWN',
          'CALENDAR_TARGET_SOURCE_NOT_CONFIGURED',
        ]),
      });
    });

    expect(calendarIo.getEventsForSources).not.toHaveBeenCalled();
    expect(adapter.createEvent).not.toHaveBeenCalled();
    expect(receipt(db, 'calendar-command-0001')).toMatchObject({ state: 'conflict_unknown' });
  });

  it('fails closed when diagnostics silently omit one requested provider despite reporting ready', async () => {
    const getEventsWithDiagnostics = vi.fn().mockResolvedValue({
      events: [],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
    });
    const calendarIo: SecretaryCalendarCommandCalendarIo = {
      getEventsWithDiagnostics,
      getEventsForSources: vi.fn(),
      createEvent: vi.fn(),
    };
    const adapter = providerAdapter();

    await withDatabaseForTestAsync(db, async () => {
      await expect(executeSecretaryCalendarCommand(command(), {
        calendarIo,
        configuredSources: ['google', 'outlook'],
        providerAdapter: adapter,
      })).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
        code: 'CALENDAR_CONFLICT_STATE_UNKNOWN',
        status: 409,
      });
    });

    expect(adapter.createEvent).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_agenda_items').get()).toEqual({ count: 0 });
  });

  it('routes an overlap to durable Decision review without writing the provider', async () => {
    const calendarIo = readyCalendarIo([{
      id: 'existing-event',
      source: 'google',
      summary: 'Existing commitment',
      start: START,
      end: END,
      blocksTime: true,
    }]);
    const adapter = providerAdapter();
    mockInvalidateCalendarCaches.mockImplementationOnce(() => {
      expect(receipt(db, 'calendar-command-overlap')?.state).not.toBe('review_required');
    });

    const result = await withDatabaseForTestAsync(db, () => executeSecretaryCalendarCommand(
      command({ idempotencyKey: 'calendar-command-overlap' }),
      { calendarIo, providerAdapter: adapter },
    ));

    expect(result).toMatchObject({
      status: 'review_required',
      replayed: false,
      warningCodes: ['CALENDAR_CONFLICT_REVIEW_REQUIRED'],
    });
    expect(adapter.createEvent).not.toHaveBeenCalled();
    expect(mockCreateDecisionIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      tenantId: 42,
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      relatedEntityType: 'secretary_agenda_item',
      decisionContext: expect.objectContaining({
        reasonCodes: expect.arrayContaining(['calendar_time_overlap', 'provider_write_withheld']),
      }),
    }));
    expect(receipt(db, 'calendar-command-overlap')).toMatchObject({
      state: 'review_required',
      agenda_item_id: expect.any(String),
      decision_item_id: expect.any(String),
    });
    expect(mockInvalidateCalendarCaches).toHaveBeenCalledOnce();
    expect(mockInvalidateCalendarCaches).toHaveBeenCalledWith(42);
  });

  it('does not claim review_required when Decision Center persistence fails', async () => {
    const calendarIo = readyCalendarIo([{
      id: 'existing-event',
      source: 'google',
      summary: 'Existing commitment',
      start: START,
      end: END,
      blocksTime: true,
    }]);
    const adapter = providerAdapter();
    mockCreateDecisionIntent.mockRejectedValueOnce(new Error('decision store unavailable'));

    await withDatabaseForTestAsync(db, async () => {
      await expect(executeSecretaryCalendarCommand(
        command({ idempotencyKey: 'calendar-command-review-pending' }),
        { calendarIo, providerAdapter: adapter },
      )).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
        code: 'CALENDAR_DECISION_REVIEW_PENDING',
        status: 503,
      });
    });

    expect(adapter.createEvent).not.toHaveBeenCalled();
    expect(receipt(db, 'calendar-command-review-pending')).toMatchObject({
      state: 'prechecking',
      decision_item_id: null,
    });
    expect(mockInvalidateCalendarCaches).not.toHaveBeenCalled();
  });

  it('does not treat a rejected-candidate cooldown as an open Decision review', async () => {
    const calendarIo = readyCalendarIo([{
      id: 'existing-event',
      source: 'google',
      summary: 'Existing commitment',
      start: START,
      end: END,
      blocksTime: true,
    }]);
    const adapter = providerAdapter();
    mockCreateDecisionIntent.mockResolvedValueOnce({
      item: null,
      eligibility: { classification: 'decision', reasons: ['candidate_rejection_cooldown'] },
    });

    await withDatabaseForTestAsync(db, async () => {
      await expect(executeSecretaryCalendarCommand(
        command({ idempotencyKey: 'calendar-command-review-cooldown' }),
        { calendarIo, providerAdapter: adapter },
      )).rejects.toMatchObject<Partial<SecretaryCalendarCommandError>>({
        code: 'CALENDAR_DECISION_REVIEW_PENDING',
        status: 503,
      });
    });

    expect(adapter.createEvent).not.toHaveBeenCalled();
    expect(receipt(db, 'calendar-command-review-cooldown')).toMatchObject({
      state: 'prechecking',
      decision_item_id: null,
    });
    expect(mockInvalidateCalendarCaches).not.toHaveBeenCalled();
  });

  it('records use of the temporary missing-key compatibility path', () => {
    expect(getSecretaryCalendarCommandMetrics()).toEqual({ legacyMissingKeyCount: 0 });

    const resolved = resolveSecretaryCalendarIdempotencyKey(undefined);

    expect(resolved.legacyMissingKey).toBe(true);
    expect(resolved.idempotencyKey).toMatch(/^legacy-[0-9a-f-]{36}$/);
    expect(getSecretaryCalendarCommandMetrics()).toEqual({ legacyMissingKeyCount: 1 });
  });
});
