import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATION_083 = path.resolve(
  __dirname,
  '../../migrations/083_secretary_agenda_ledger.sql',
);

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
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

import {
  cancelSecretaryAgendaItem,
  getSecretaryAgendaItemById,
  submitSecretarySchedulingIntent,
  type SecretarySchedulingIntent,
  type SecretaryTimeWindow,
} from '../../src/services/secretary-scheduling-arbitrator';
import {
  markCompletedSecretaryAgendaItems,
  syncSecretaryAgendaItemsToProvider,
  syncSecretaryAgendaItemToProvider,
  type SecretaryAgendaProviderAdapter,
  type SecretaryProviderEvent,
  type SecretaryProviderEventInput,
} from '../../src/services/secretary-agenda-provider-sync';
import { getActiveReminders, setReminder } from '../../src/state/reminders';
import { logger } from '../../src/utils/logger';

const TENANT_ID = 'tenant-calendar-lifecycle';
const OWNER_USER_ID = 74;

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
});

afterEach(() => {
  testDb.close();
});

class MockSecretaryProvider implements SecretaryAgendaProviderAdapter {
  source = 'google' as const;
  events = new Map<string, SecretaryProviderEvent>();
  createInputs: SecretaryProviderEventInput[] = [];
  updateInputs: Array<{ eventId: string; input: SecretaryProviderEventInput }> = [];
  deletedEventIds: string[] = [];
  createFailuresRemaining = 0;
  createAttempts = 0;
  createFailureFactory: (() => unknown) | null = null;
  private sequence = 1;

  async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
    this.createAttempts += 1;
    if (this.createFailuresRemaining > 0) {
      this.createFailuresRemaining -= 1;
      if (this.createFailureFactory) throw this.createFailureFactory();
      throw new Error('simulated provider create failure');
    }
    this.createInputs.push(input);
    const event = this.toEvent(`google_evt_${this.sequence++}`, input);
    this.events.set(event.eventId, event);
    return event;
  }

  async updateEvent(eventId: string, input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
    this.updateInputs.push({ eventId, input });
    const event = this.toEvent(eventId, input);
    this.events.set(eventId, event);
    return event;
  }

  async deleteEvent(eventId: string): Promise<void> {
    this.deletedEventIds.push(eventId);
    this.events.delete(eventId);
  }

  async getEvent(eventId: string): Promise<SecretaryProviderEvent | null> {
    return this.events.get(eventId) ?? null;
  }

  async findEventsByAgendaItemId(agendaItemId: string): Promise<SecretaryProviderEvent[]> {
    return [...this.events.values()].filter((event) => event.agendaItemId === agendaItemId);
  }

  seedEvent(input: SecretaryProviderEventInput, eventId: string): SecretaryProviderEvent {
    const event = this.toEvent(eventId, input);
    this.events.set(event.eventId, event);
    return event;
  }

  removeExternally(eventId: string): void {
    this.events.delete(eventId);
  }

  private toEvent(eventId: string, input: SecretaryProviderEventInput): SecretaryProviderEvent {
    return {
      eventId,
      source: this.source,
      agendaItemId: input.agendaItemId,
      title: input.title,
      startAt: input.startAt,
      endAt: input.endAt,
      version: input.version,
    };
  }
}

function timeWindow(start: string, end: string, label?: string): SecretaryTimeWindow {
  return { start, end, label };
}

function intent(overrides: Partial<SecretarySchedulingIntent> = {}): SecretarySchedulingIntent {
  return {
    intentId: 'training-session-1',
    sourceSkill: 'training',
    sourceAction: 'schedule_session',
    sourceEntityId: 'session-1',
    sourceEntityType: 'training_session',
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    title: 'Bike endurance session',
    requestedDurationMinutes: 60,
    preferredWindows: [
      timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T11:00:00.000Z', 'morning'),
    ],
    priority: 'high',
    flexibility: 'fixed',
    ...overrides,
  };
}

function providerInputFor(agendaItemId: string): SecretaryProviderEventInput {
  const row = getSecretaryAgendaItemById({
    agendaItemId,
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
  });
  if (!row?.startAt || !row.endAt) throw new Error('agenda item not found or unscheduled');
  return {
    agendaItemId: row.agendaItemId,
    sourceIntentId: row.sourceIntentId,
    sourceSkill: row.sourceSkill,
    sourceEntityId: row.sourceEntityId,
    sourceEntityType: row.sourceEntityType,
    ownerUserId: row.ownerUserId,
    tenantId: row.tenantId,
    version: row.version,
    title: row.title,
    startAt: row.startAt,
    endAt: row.endAt,
    durationMinutes: row.durationMinutes,
    lifecycleState: row.lifecycleState,
    decisionReasonCodes: row.decisionReasonCodes,
    sourceShapeHash: row.sourceShapeHash,
  };
}

async function syncOne(agendaItemId: string, provider = new MockSecretaryProvider()) {
  return syncSecretaryAgendaItemToProvider({
    agendaItemId,
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
  }, provider);
}

describe('secretary-agenda-provider-sync', () => {
  it('creates a provider event for a scheduled agenda item and stores stable mapping', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent());

    const result = await syncOne(decision.agendaItem.agendaItemId, provider);
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(result).toMatchObject({
      action: 'created',
      providerSyncState: 'synced',
      providerSource: 'google',
      reasonCode: 'provider_event_created',
    });
    expect(provider.createInputs).toHaveLength(1);
    expect(provider.createInputs[0]).toMatchObject({
      agendaItemId: decision.agendaItem.agendaItemId,
      sourceIntentId: 'training-session-1',
      sourceSkill: 'training',
      version: 1,
    });
    expect(stored?.providerEventId).toBe(result.providerEventId);
    expect(stored?.providerSource).toBe('google');
    expect(stored?.providerSyncState).toBe('synced');
    expect(stored?.lifecycleState).toBe('synced');
    expect(stored?.sourceShapeHash).toHaveLength(32);
  });

  it('updates and moves an existing provider event by exact event ID', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent());
    const created = await syncOne(decision.agendaItem.agendaItemId, provider);

    testDb.prepare(`
      UPDATE secretary_agenda_items
      SET lifecycle_state = 'reflowed',
          provider_sync_state = 'not_synced',
          start_at = ?,
          end_at = ?,
          title = ?,
          updated_at = ?
      WHERE agenda_item_id = ?
    `).run(
      '2026-05-04T10:00:00.000Z',
      '2026-05-04T11:00:00.000Z',
      'Bike endurance session moved',
      '2026-05-01T09:00:00.000Z',
      decision.agendaItem.agendaItemId,
    );

    const updated = await syncOne(decision.agendaItem.agendaItemId, provider);

    expect(updated.action).toBe('updated');
    expect(provider.updateInputs).toHaveLength(1);
    expect(provider.updateInputs[0]).toMatchObject({
      eventId: created.providerEventId,
      input: {
        startAt: '2026-05-04T10:00:00.000Z',
        endAt: '2026-05-04T11:00:00.000Z',
        title: 'Bike endurance session moved',
      },
    });
    expect(provider.deletedEventIds).toEqual([]);
  });

  it('cancels by precise provider event ID without broad date-range deletion', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent());
    const created = await syncOne(decision.agendaItem.agendaItemId, provider);

    cancelSecretaryAgendaItem({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'user canceled',
      now: '2026-05-01T10:00:00.000Z',
    });

    const canceled = await syncOne(decision.agendaItem.agendaItemId, provider);
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(canceled.action).toBe('deleted');
    expect(provider.deletedEventIds).toEqual([created.providerEventId]);
    expect(provider.createInputs).toHaveLength(1);
    expect(stored?.lifecycleState).toBe('canceled');
    expect(stored?.providerSyncState).toBe('deleted');
  });

  it('replaces a regenerated agenda item by deleting the superseded provider event and creating the new version', async () => {
    const provider = new MockSecretaryProvider();
    const first = submitSecretarySchedulingIntent(intent({
      intentId: 'regenerate-session',
      sourceEntityId: 'session-regenerate',
    }));
    const firstSync = await syncOne(first.agendaItem.agendaItemId, provider);

    const replacement = submitSecretarySchedulingIntent(intent({
      intentId: 'regenerate-session',
      sourceEntityId: 'session-regenerate',
      title: 'Bike endurance session regenerated',
      preferredWindows: [
        timeWindow('2026-05-04T13:00:00.000Z', '2026-05-04T15:00:00.000Z', 'afternoon'),
      ],
    }));

    const results = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: true,
    }, provider);
    const firstStored = getSecretaryAgendaItemById({
      agendaItemId: first.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    const replacementStored = getSecretaryAgendaItemById({
      agendaItemId: replacement.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(firstStored?.lifecycleState).toBe('superseded');
    expect(provider.deletedEventIds).toContain(firstSync.providerEventId);
    expect(results.some((result) => result.agendaItemId === replacement.agendaItem.agendaItemId && result.action === 'created')).toBe(true);
    expect(replacementStored?.version).toBe(2);
    expect(replacementStored?.providerSyncState).toBe('synced');
    expect(replacementStored?.providerEventId).not.toBe(firstSync.providerEventId);
  });

  it('attaches a pre-existing provider event on retry instead of creating a duplicate', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'retry-partial-success',
      sourceEntityId: 'session-partial',
    }));
    const input = providerInputFor(decision.agendaItem.agendaItemId);
    provider.seedEvent(input, 'google_evt_partial_success');

    const result = await syncOne(decision.agendaItem.agendaItemId, provider);

    expect(result.action).toBe('attached');
    expect(result.providerEventId).toBe('google_evt_partial_success');
    expect(provider.createInputs).toHaveLength(0);
    expect(provider.updateInputs.map((call) => call.eventId)).toEqual(['google_evt_partial_success']);
  });

  it('records create failure and retries safely on the same agenda item', async () => {
    const provider = new MockSecretaryProvider();
    provider.createFailuresRemaining = 1;
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'retry-after-create-failure',
      sourceEntityId: 'session-create-failure',
    }));

    const failed = await syncOne(decision.agendaItem.agendaItemId, provider);
    const retried = await syncOne(decision.agendaItem.agendaItemId, provider);
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(failed).toMatchObject({
      action: 'failed',
      providerSyncState: 'create_failed',
    });
    expect(retried.action).toBe('created');
    expect(provider.createInputs).toHaveLength(1);
    expect(stored?.providerSyncState).toBe('synced');
    expect(stored?.lifecycleState).toBe('synced');
  });

  it('bulk sync uses an explicit retry budget and honors Retry-After for transient failures', async () => {
    const provider = new MockSecretaryProvider();
    provider.createFailuresRemaining = 1;
    provider.createFailureFactory = () => ({
      response: {
        headers: {
          'retry-after': '0',
        },
      },
    });
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'bulk-retry-after',
      sourceEntityId: 'session-bulk-retry',
    }));

    const results = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider);
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: 'created',
      providerSyncState: 'synced',
    });
    expect(provider.createAttempts).toBe(2);
    expect(provider.createInputs).toHaveLength(1);
    expect(stored?.providerSyncState).toBe('synced');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        agendaItemId: decision.agendaItem.agendaItemId,
        providerSource: 'google',
        retryBudget: 2,
        delayMs: 0,
      }),
      'Secretary agenda provider sync retrying after transient failure',
    );
  });

  it('marks provider sync failures as failed_sync and keeps them retryable', async () => {
    const provider = new MockSecretaryProvider();
    provider.createFailuresRemaining = 1;
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'failed-sync-lifecycle',
      sourceEntityId: 'session-failed-sync',
    }));

    const failed = await syncOne(decision.agendaItem.agendaItemId, provider);
    const afterFailure = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(failed.providerSyncState).toBe('create_failed');
    expect(afterFailure?.lifecycleState).toBe('failed_sync');

    const retried = await syncOne(decision.agendaItem.agendaItemId, provider);
    const afterRetry = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    expect(retried.action).toBe('created');
    expect(afterRetry?.lifecycleState).toBe('synced');
  });

  it('marks ended agenda items completed without deleting provider history', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'completed-lifecycle',
      sourceEntityId: 'session-completed',
      preferredWindows: [
        timeWindow('2026-05-02T09:00:00.000Z', '2026-05-02T11:00:00.000Z', 'morning'),
      ],
    }));
    const created = await syncOne(decision.agendaItem.agendaItemId, provider);

    const changed = markCompletedSecretaryAgendaItems(new Date('2026-05-03T00:00:00.000Z'));
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(changed).toBeGreaterThanOrEqual(1);
    expect(stored?.lifecycleState).toBe('completed');
    expect(provider.events.has(created.providerEventId!)).toBe(true);
  });

  it('cancels agenda-linked reminders when an agenda item is canceled', () => {
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL,
        remind_at TEXT NOT NULL,
        recurring TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'reminder-cancel',
      sourceEntityId: 'session-reminder',
    }));
    setReminder(OWNER_USER_ID, {
      message: 'Prep for bike session',
      remind_at: '2026-05-04T08:30:00.000Z',
      agenda_item_id: decision.agendaItem.agendaItemId,
    });

    expect(getActiveReminders(OWNER_USER_ID)).toHaveLength(1);
    cancelSecretaryAgendaItem({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'user canceled',
      now: '2026-05-01T10:00:00.000Z',
    });

    expect(getActiveReminders(OWNER_USER_ID)).toHaveLength(0);
  });

  it('recreates an active agenda item when its provider event was externally deleted', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'externally-deleted',
      sourceEntityId: 'session-external-delete',
    }));
    const first = await syncOne(decision.agendaItem.agendaItemId, provider);
    provider.removeExternally(first.providerEventId!);

    const repaired = await syncOne(decision.agendaItem.agendaItemId, provider);
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(repaired.action).toBe('recreated');
    expect(repaired.providerEventId).not.toBe(first.providerEventId);
    expect(stored?.providerSyncState).toBe('synced');
    expect(stored?.providerEventId).toBe(repaired.providerEventId);
  });

  it('repairs stale duplicate provider events for the same agenda item', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'duplicate-repair',
      sourceEntityId: 'session-duplicate',
    }));
    const first = await syncOne(decision.agendaItem.agendaItemId, provider);
    const input = providerInputFor(decision.agendaItem.agendaItemId);
    provider.seedEvent(input, 'google_evt_duplicate_b');
    provider.seedEvent(input, 'google_evt_duplicate_a');

    const repaired = await syncOne(decision.agendaItem.agendaItemId, provider);

    expect(repaired.action).toBe('updated');
    expect(repaired.providerEventId).toBe(first.providerEventId);
    expect(repaired.deletedDuplicateEventIds.sort()).toEqual([
      'google_evt_duplicate_a',
      'google_evt_duplicate_b',
    ]);
    expect(provider.deletedEventIds).toEqual(expect.arrayContaining([
      'google_evt_duplicate_a',
      'google_evt_duplicate_b',
    ]));
    expect([...provider.events.values()].filter((event) => event.agendaItemId === decision.agendaItem.agendaItemId)).toHaveLength(1);
  });

  it('keeps provider mappings scoped by owner and tenant', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'scope-safe-sync',
      sourceEntityId: 'session-scope',
    }));

    await expect(syncSecretaryAgendaItemToProvider({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID + 1,
      tenantId: TENANT_ID,
    }, provider)).rejects.toThrow('Secretary agenda item not found');
    await expect(syncSecretaryAgendaItemToProvider({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: 'other-tenant',
    }, provider)).rejects.toThrow('Secretary agenda item not found');
  });
});
