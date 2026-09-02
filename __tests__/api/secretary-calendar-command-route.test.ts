import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockExecuteSecretaryCalendarCommand = vi.hoisted(() => vi.fn());
const mockInspectSecretaryCalendarCommandReplay = vi.hoisted(() => vi.fn(() => null));
const mockExecuteSecretaryCalendarMutation = vi.hoisted(() => vi.fn());
const mockInspectSecretaryCalendarMutationReplay = vi.hoisted(() => vi.fn(() => null));
const mockNoteLegacySecretaryCalendarMutationWithoutKey = vi.hoisted(() => vi.fn());
const mockHasWritableCalendarForUser = vi.hoisted(() => vi.fn(() => true));
const mockGetEventsForSources = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockUpdateEvent = vi.hoisted(() => vi.fn());
const mockDeleteEvent = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/secretary-calendar-command-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/secretary-calendar-command-service')>();
  return {
    ...actual,
    executeSecretaryCalendarCommand: (...args: unknown[]) => mockExecuteSecretaryCalendarCommand(...args),
    inspectSecretaryCalendarCommandReplay: (...args: unknown[]) => mockInspectSecretaryCalendarCommandReplay(...args),
    executeSecretaryCalendarMutation: (...args: unknown[]) => mockExecuteSecretaryCalendarMutation(...args),
    inspectSecretaryCalendarMutationReplay: (...args: unknown[]) =>
      mockInspectSecretaryCalendarMutationReplay(...args),
    noteLegacySecretaryCalendarMutationWithoutKey: (...args: unknown[]) =>
      mockNoteLegacySecretaryCalendarMutationWithoutKey(...args),
  };
});

vi.mock('../../src/services/unified-calendar', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/unified-calendar')>(
    '../../src/services/unified-calendar',
  )),
  getEventsWithDiagnostics: vi.fn(),
  getEvents: (...args: unknown[]) => mockGetEventsForSources(...args),
  getEventsForSources: (...args: unknown[]) => mockGetEventsForSources(...args),
  createEvent: vi.fn(),
  updateEvent: (...args: unknown[]) => mockUpdateEvent(...args),
  deleteEvent: (...args: unknown[]) => mockDeleteEvent(...args),
  isAnyCalendarConfigured: vi.fn(() => true),
  hasConnectedCalendarForUser: vi.fn(() => true),
  hasWritableCalendarForUser: (...args: unknown[]) => mockHasWritableCalendarForUser(...args),
}));

vi.mock('../../src/services/runtime-flags', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/runtime-flags')>(
    '../../src/services/runtime-flags',
  )),
  isHomeFocusPillV1Enabled: vi.fn(() => true),
}));

vi.mock('../../src/services/cache-store', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/cache-store')>(
    '../../src/services/cache-store',
  )),
  getCachedSWR: vi.fn(() => null),
  setCacheSWR: vi.fn(),
  clearCache: vi.fn(),
  clearCacheByPrefix: vi.fn(),
}));

vi.mock('../../src/services/focus-planner', () => ({
  getFocusBlockRecommendation: vi.fn(),
}));

vi.mock('../../src/services/training-calendar-scope', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/training-calendar-scope')>(
    '../../src/services/training-calendar-scope',
  )),
  filterCalendarEventsForTrainingScope: vi.fn((events) => events),
}));

vi.mock('../../src/services/health-sleep-agenda', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/health-sleep-agenda')>(
    '../../src/services/health-sleep-agenda',
  )),
  getAppleHealthSleepAgendaEvents: vi.fn(() => []),
}));

vi.mock('../../src/services/user-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/user-service')>(
    '../../src/services/user-service',
  )),
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
}));

vi.mock('../../src/config', () => ({
  config: { app: { timezone: 'Europe/Lisbon' }, garmin: { tokenPath: '/tmp' } },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { calendarRoutes } from '../../src/api/routes/calendar';
import {
  getSecretaryCalendarCommandMetrics,
  resetSecretaryCalendarCommandMetricsForTests,
} from '../../src/services/secretary-calendar-command-service';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
  setHeader(name: string, value: string): MockRes;
  end(): MockRes;
}

function response(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
    setHeader() { return res; },
    end() { return res; },
  };
  return res;
}

async function postEvent(
  idempotencyKey?: string,
  bodyOverrides: Record<string, unknown> = {},
  tenantId = 42,
): Promise<MockRes> {
  const req = {
    method: 'POST',
    url: '/events',
    originalUrl: '/events',
    baseUrl: '',
    path: '/events',
    query: {},
    params: {},
    headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    header(name: string) {
      return (this.headers as Record<string, string>)[name.toLowerCase()];
    },
    body: {
      title: 'Planning review',
      start: '2026-08-31T09:00:00.000Z',
      end: '2026-08-31T10:00:00.000Z',
      source: 'google',
      description: 'Review the launch plan.',
      location: 'Studio A',
      attendees: ['first@example.com', 'invalid address'],
      categories: ['meeting'],
      recurrence: { frequency: 'weekly', interval: 1 },
      ...bodyOverrides,
    },
    userId: 42,
    tenantId,
  } as unknown as Request;
  const res = response();
  await new Promise<void>((resolve, reject) => {
    calendarRoutes().handle(req, res as any, (error: unknown) => {
      if (error) reject(error);
      else resolve();
    });
    setImmediate(resolve);
  });
  return res;
}

async function postFocusBlock(
  idempotencyKey?: string,
  tenantId = 42,
  bodyOverrides: Record<string, unknown> = {},
): Promise<MockRes> {
  const req = {
    method: 'POST',
    url: '/focus-blocks',
    originalUrl: '/focus-blocks',
    baseUrl: '',
    path: '/focus-blocks',
    query: {},
    params: {},
    headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    header(name: string) {
      return (this.headers as Record<string, string>)[name.toLowerCase()];
    },
    body: {
      mode: 'focus',
      start: '2026-08-31T09:00:00.000Z',
      durationMinutes: 60,
      source: 'google',
      ...bodyOverrides,
    },
    userId: 42,
    tenantId,
  } as unknown as Request;
  const res = response();
  await new Promise<void>((resolve, reject) => {
    calendarRoutes().handle(req, res as any, (error: unknown) => {
      if (error) reject(error);
      else resolve();
    });
    setImmediate(resolve);
  });
  return res;
}

async function mutateExistingEvent(
  method: 'PATCH' | 'DELETE',
  idempotencyKey?: string,
  tenantId = 42,
): Promise<MockRes> {
  const req = {
    method,
    url: '/events/provider-event-1',
    originalUrl: '/events/provider-event-1',
    baseUrl: '',
    path: '/events/provider-event-1',
    query: {},
    params: { eventId: 'provider-event-1' },
    headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    header(name: string) {
      return (this.headers as Record<string, string>)[name.toLowerCase()];
    },
    body: method === 'PATCH'
      ? {
          source: 'google',
          title: 'Planning review moved',
          start: '2026-08-31T11:00:00.000Z',
          end: '2026-08-31T12:00:00.000Z',
        }
      : { source: 'google' },
    userId: 42,
    tenantId,
  } as unknown as Request;
  const res = response();
  await new Promise<void>((resolve, reject) => {
    calendarRoutes().handle(req, res as any, (error: unknown) => {
      if (error) reject(error);
      else resolve();
    });
    setImmediate(resolve);
  });
  return res;
}

describe('Secretary calendar command REST wiring', () => {
  beforeEach(() => {
    mockExecuteSecretaryCalendarCommand.mockReset();
    mockExecuteSecretaryCalendarMutation.mockReset();
    mockInspectSecretaryCalendarMutationReplay.mockReset();
    mockInspectSecretaryCalendarMutationReplay.mockReturnValue(null);
    mockNoteLegacySecretaryCalendarMutationWithoutKey.mockReset();
    mockInspectSecretaryCalendarCommandReplay.mockReset();
    mockInspectSecretaryCalendarCommandReplay.mockReturnValue(null);
    mockHasWritableCalendarForUser.mockReset();
    mockHasWritableCalendarForUser.mockReturnValue(true);
    mockGetEventsForSources.mockReset();
    mockGetEventsForSources.mockResolvedValue([]);
    mockUpdateEvent.mockReset();
    mockDeleteEvent.mockReset();
    mockExecuteSecretaryCalendarCommand.mockResolvedValue({
      status: 'succeeded',
      replayed: false,
      warningCodes: [],
      event: {
        id: 'provider-event-1',
        source: 'google',
        syncedSources: ['google'],
        summary: 'Planning review',
        start: '2026-08-31T09:00:00.000Z',
        end: '2026-08-31T10:00:00.000Z',
        location: 'Studio A',
      },
    });
    mockExecuteSecretaryCalendarMutation.mockResolvedValue({
      status: 'succeeded',
      replayed: false,
      warningCodes: [],
      event: {
        id: 'provider-event-1',
        source: 'google',
        summary: 'Planning review moved',
        start: '2026-08-31T11:00:00.000Z',
        end: '2026-08-31T12:00:00.000Z',
      },
      deleted: true,
    });
    resetSecretaryCalendarCommandMetricsForTests();
  });

  it('passes the persisted Idempotency-Key and full provider payload to the shared command service', async () => {
    const res = await postEvent('ios-stable-retry-key');

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ replayed: false, event: { id: 'provider-event-1' } });
    expect(mockExecuteSecretaryCalendarCommand).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      tenantId: 42,
      idempotencyKey: 'ios-stable-retry-key',
      source: 'google',
      timezone: 'Europe/Lisbon',
      description: expect.stringMatching(/^Review the launch plan\.[\s\S]*Nexus category: meeting$/),
      location: 'Studio A',
      // The route must not silently discard malformed values. The shared
      // command service owns one validation policy for REST, iOS, and chat.
      attendees: ['first@example.com', 'invalid address'],
      categories: ['meeting'],
      recurrence: { frequency: 'weekly', interval: 1 },
      channel: 'ios',
    }));
    expect(getSecretaryCalendarCommandMetrics()).toEqual({ legacyMissingKeyCount: 0 });
  });

  it('rejects an explicitly unsupported provider instead of silently falling back', async () => {
    const res = await postEvent('ios-invalid-provider', { source: 'apple' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION');
    expect(mockExecuteSecretaryCalendarCommand).not.toHaveBeenCalled();
    expect(mockInspectSecretaryCalendarCommandReplay).not.toHaveBeenCalled();
  });

  it('keeps the one-release missing-key path observable through its deprecation metric', async () => {
    const res = await postEvent();

    expect(res.statusCode).toBe(200);
    expect(mockExecuteSecretaryCalendarCommand).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^legacy-[0-9a-f-]{36}$/),
    }));
    expect(getSecretaryCalendarCommandMetrics()).toEqual({ legacyMissingKeyCount: 1 });
  });

  it('lets the shared service replay a terminal receipt after the provider disconnects', async () => {
    mockHasWritableCalendarForUser.mockReturnValue(false);
    mockInspectSecretaryCalendarCommandReplay.mockReturnValueOnce({
      source: 'google',
      result: {
        status: 'succeeded',
        replayed: true,
        warningCodes: [],
        event: {
          id: 'provider-event-1',
          source: 'google',
          syncedSources: ['google'],
          summary: 'Planning review',
          start: '2026-08-31T09:00:00.000Z',
          end: '2026-08-31T10:00:00.000Z',
        },
      },
    });

    const res = await postEvent('ios-terminal-replay-after-disconnect');

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ replayed: true, event: { id: 'provider-event-1' } });
    expect(mockInspectSecretaryCalendarCommandReplay).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      tenantId: 42,
      idempotencyKey: 'ios-terminal-replay-after-disconnect',
      source: 'google',
    }));
    expect(mockHasWritableCalendarForUser).not.toHaveBeenCalled();
    expect(mockExecuteSecretaryCalendarCommand).not.toHaveBeenCalled();
  });

  it('lets the shared service recover a nonterminal receipt after the provider disconnects', async () => {
    mockHasWritableCalendarForUser.mockReturnValue(false);
    mockInspectSecretaryCalendarCommandReplay.mockReturnValueOnce({
      source: 'google',
      result: null,
    });

    const res = await postEvent('ios-nonterminal-recovery-after-disconnect');

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ replayed: false, event: { id: 'provider-event-1' } });
    expect(mockHasWritableCalendarForUser).not.toHaveBeenCalled();
    expect(mockExecuteSecretaryCalendarCommand).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'ios-nonterminal-recovery-after-disconnect',
      source: 'google',
    }));
  });

  it('routes focus-block creation through the same durable command service', async () => {
    const res = await postFocusBlock('ios-focus-stable-retry-key');

    expect(res.statusCode).toBe(201);
    expect(mockExecuteSecretaryCalendarCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'ios-focus-stable-retry-key',
        title: 'Focus time',
        start: '2026-08-31T09:00:00.000Z',
        end: '2026-08-31T10:00:00.000Z',
        categories: ['focus'],
        source: 'google',
        channel: 'ios',
      }),
      expect.objectContaining({ additionalConflicts: [] }),
    );
  });

  it('requires keyed focus retries to carry an explicit stable start', async () => {
    const res = await postFocusBlock('ios-focus-stable-retry-key', 42, { start: undefined });

    expect(res.statusCode).toBe(400);
    expect(res.body.error?.code).toBe('INVALID_INPUT');
    expect(mockInspectSecretaryCalendarCommandReplay).not.toHaveBeenCalled();
    expect(mockExecuteSecretaryCalendarCommand).not.toHaveBeenCalled();
  });

  it('routes keyed update and delete through the durable existing-event command service', async () => {
    const updated = await mutateExistingEvent('PATCH', 'ios-update-stable-key');
    const deleted = await mutateExistingEvent('DELETE', 'ios-delete-stable-key');

    expect(updated.statusCode).toBe(200);
    expect(updated.body.data).toMatchObject({ replayed: false, event: { id: 'provider-event-1' } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body.data).toMatchObject({ replayed: false, deleted: true });
    expect(mockExecuteSecretaryCalendarMutation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      operation: 'update',
      idempotencyKey: 'ios-update-stable-key',
      userId: 42,
      tenantId: 42,
      source: 'google',
      eventId: 'provider-event-1',
      timezone: 'Europe/Lisbon',
      channel: 'ios',
    }));
    expect(mockExecuteSecretaryCalendarMutation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operation: 'delete',
      idempotencyKey: 'ios-delete-stable-key',
      eventId: 'provider-event-1',
    }));
    expect(mockNoteLegacySecretaryCalendarMutationWithoutKey).not.toHaveBeenCalled();
  });

  it('keeps missing-key update and delete inside the deterministic mutation service', async () => {
    const updated = await mutateExistingEvent('PATCH');
    const deleted = await mutateExistingEvent('DELETE');

    expect(updated.statusCode).toBe(200);
    expect(deleted.statusCode).toBe(200);
    expect(mockExecuteSecretaryCalendarMutation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      operation: 'update',
      idempotencyKey: expect.stringMatching(/^legacy-[0-9a-f-]{36}$/),
      userId: 42,
      tenantId: 42,
      channel: 'ios',
    }));
    expect(mockExecuteSecretaryCalendarMutation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operation: 'delete',
      idempotencyKey: expect.stringMatching(/^legacy-[0-9a-f-]{36}$/),
      userId: 42,
      tenantId: 42,
      channel: 'ios',
    }));
    expect(mockNoteLegacySecretaryCalendarMutationWithoutKey).toHaveBeenNthCalledWith(1, 'update');
    expect(mockNoteLegacySecretaryCalendarMutationWithoutKey).toHaveBeenNthCalledWith(2, 'delete');
    expect(mockUpdateEvent).not.toHaveBeenCalled();
    expect(mockDeleteEvent).not.toHaveBeenCalled();
  });

  it('rejects mismatched tenant scope before command, conflict, or legacy provider I/O', async () => {
    const created = await postEvent('scope-create-key', {}, 99);
    const focused = await postFocusBlock('scope-focus-key', 99);
    const updated = await mutateExistingEvent('PATCH', 'scope-update-key', 99);
    const legacyDeleted = await mutateExistingEvent('DELETE', undefined, 99);

    for (const result of [created, focused, updated, legacyDeleted]) {
      expect(result.statusCode).toBe(403);
      expect(result.body.error?.code).toBe('TENANT_SCOPE_MISMATCH');
    }
    expect(mockInspectSecretaryCalendarCommandReplay).not.toHaveBeenCalled();
    expect(mockExecuteSecretaryCalendarCommand).not.toHaveBeenCalled();
    expect(mockExecuteSecretaryCalendarMutation).not.toHaveBeenCalled();
    expect(mockGetEventsForSources).not.toHaveBeenCalled();
    expect(mockUpdateEvent).not.toHaveBeenCalled();
    expect(mockDeleteEvent).not.toHaveBeenCalled();
    expect(mockHasWritableCalendarForUser).not.toHaveBeenCalled();
    expect(mockNoteLegacySecretaryCalendarMutationWithoutKey).not.toHaveBeenCalled();
  });

  it('replays a focus-block receipt without another conflict or provider read', async () => {
    mockHasWritableCalendarForUser.mockReturnValue(false);
    mockInspectSecretaryCalendarCommandReplay.mockReturnValueOnce({
      source: 'google',
      result: {
        status: 'succeeded',
        replayed: true,
        warningCodes: [],
        event: {
          id: 'provider-focus-1',
          source: 'google',
          summary: 'Focus time',
          start: '2026-08-31T09:00:00.000Z',
          end: '2026-08-31T10:00:00.000Z',
        },
      },
    });

    const res = await postFocusBlock('ios-focus-terminal-replay');

    expect(res.statusCode).toBe(201);
    expect(res.body.data).toMatchObject({ replayed: true, event: { id: 'provider-focus-1' } });
    expect(mockGetEventsForSources).not.toHaveBeenCalled();
    expect(mockHasWritableCalendarForUser).not.toHaveBeenCalled();
    expect(mockExecuteSecretaryCalendarCommand).not.toHaveBeenCalled();
  });

  it('resumes a nonterminal focus receipt without requiring a current provider capability probe', async () => {
    mockHasWritableCalendarForUser.mockReturnValue(false);
    mockInspectSecretaryCalendarCommandReplay.mockReturnValueOnce({
      source: 'google',
      result: null,
    });

    const res = await postFocusBlock('ios-focus-nonterminal-recovery');

    expect(res.statusCode).toBe(201);
    expect(res.body.data).toMatchObject({ replayed: false, event: { id: 'provider-event-1' } });
    expect(mockHasWritableCalendarForUser).not.toHaveBeenCalled();
    expect(mockGetEventsForSources).not.toHaveBeenCalled();
    expect(mockExecuteSecretaryCalendarCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'ios-focus-nonterminal-recovery',
        source: 'google',
      }),
      expect.any(Object),
    );
  });

  it.each(['PATCH', 'DELETE'] as const)(
    'resumes a nonterminal %s mutation receipt without requiring a current provider capability probe',
    async (method) => {
      mockHasWritableCalendarForUser.mockReturnValue(false);
      mockInspectSecretaryCalendarMutationReplay.mockReturnValueOnce({ result: null });
      if (method === 'DELETE') {
        mockExecuteSecretaryCalendarMutation.mockResolvedValueOnce({
          status: 'succeeded',
          replayed: false,
          warningCodes: [],
          deleted: true,
        });
      }

      const res = await mutateExistingEvent(method, `ios-${method.toLowerCase()}-nonterminal-recovery`);

      expect(res.statusCode).toBe(200);
      expect(mockHasWritableCalendarForUser).not.toHaveBeenCalled();
      expect(mockExecuteSecretaryCalendarMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: `ios-${method.toLowerCase()}-nonterminal-recovery`,
          operation: method === 'PATCH' ? 'update' : 'delete',
          source: 'google',
        }),
      );
    },
  );
});
