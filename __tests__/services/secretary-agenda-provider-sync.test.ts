import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATION_083 = path.resolve(
  __dirname,
  '../../migrations/083_secretary_agenda_ledger.sql',
);
const MIGRATION_098 = path.resolve(
  __dirname,
  '../../migrations/098_secretary_decision_explanation.sql',
);
const MIGRATION_220 = path.resolve(
  __dirname,
  '../../migrations/220_secretary_agenda_provider_sync_failure_count.sql',
);
const MIGRATION_224 = path.resolve(
  __dirname,
  '../../migrations/224_secretary_agenda_sync_fingerprint.sql',
);

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
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
  markSecretaryAgendaProviderSyncSatisfied,
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
  testDb.exec(fs.readFileSync(MIGRATION_098, 'utf8'));
  testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
  testDb.exec(fs.readFileSync(MIGRATION_220, 'utf8'));
  testDb.exec(fs.readFileSync(MIGRATION_224, 'utf8'));
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
  findAgendaItemIds: string[] = [];
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
    this.findAgendaItemIds.push(agendaItemId);
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

  it('fails loudly when provider mapping update misses the scoped agenda row', async () => {
    class DeletingProvider extends MockSecretaryProvider {
      async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        const event = await super.createEvent(input);
        testDb.prepare('DELETE FROM secretary_agenda_items WHERE agenda_item_id = ?').run(input.agendaItemId);
        return event;
      }
    }
    const provider = new DeletingProvider();
    const decision = submitSecretarySchedulingIntent(intent());

    await expect(syncOne(decision.agendaItem.agendaItemId, provider))
      .rejects.toThrow(/SECRETARY_PROVIDER_MAPPING_UPDATE_MISSED/);
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

  it('does not reactivate a canceled agenda item when a stale provider sync write finishes after cancellation', async () => {
    class CancelDuringUpdateProvider extends MockSecretaryProvider {
      async updateEvent(eventId: string, input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        const event = await super.updateEvent(eventId, input);
        cancelSecretaryAgendaItem({
          agendaItemId: input.agendaItemId,
          ownerUserId: input.ownerUserId,
          tenantId: input.tenantId,
          reason: 'training_plan_canceled',
          now: '2026-05-01T10:30:00.000Z',
        });
        return event;
      }
    }

    const provider = new CancelDuringUpdateProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'cancel-race-session',
      sourceEntityId: 'session-cancel-race',
    }));
    const created = await syncOne(decision.agendaItem.agendaItemId, provider);
    testDb.prepare(`
      UPDATE secretary_agenda_items
      SET lifecycle_state = 'reflowed',
          provider_sync_state = 'not_synced',
          title = ?,
          updated_at = ?
      WHERE agenda_item_id = ?
    `).run(
      'Bike endurance session moved before cancel',
      '2026-05-01T10:15:00.000Z',
      decision.agendaItem.agendaItemId,
    );

    const staleSync = await syncOne(decision.agendaItem.agendaItemId, provider);
    const afterStaleSync = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(staleSync.action).toBe('updated');
    expect(afterStaleSync?.lifecycleState).toBe('canceled');
    expect(afterStaleSync?.cancellationReason).toBe('training_plan_canceled');
    expect(afterStaleSync?.providerSyncState).toBe('synced');

    const cleanup = await syncOne(decision.agendaItem.agendaItemId, provider);
    const afterCleanup = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(cleanup.action).toBe('deleted');
    expect(provider.deletedEventIds).toContain(created.providerEventId);
    expect(afterCleanup?.lifecycleState).toBe('canceled');
    expect(afterCleanup?.providerSyncState).toBe('deleted');
    expect(afterCleanup?.providerEventId).toBeNull();
    expect(afterCleanup?.providerSource).toBeNull();
  });

  it('terminalizes cleaned-up rows and excludes them from later bulk syncs', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'bulk-canceled-cleanup',
      sourceEntityId: 'session-bulk-canceled',
    }));
    const created = await syncOne(decision.agendaItem.agendaItemId, provider);
    cancelSecretaryAgendaItem({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'training_plan_canceled',
      now: '2026-05-01T10:00:00.000Z',
    });

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
      agendaItemId: decision.agendaItem.agendaItemId,
      action: 'deleted',
      providerSyncState: 'deleted',
    });
    expect(provider.deletedEventIds).toContain(created.providerEventId);
    expect(stored?.lifecycleState).toBe('canceled');
    expect(stored?.providerSyncState).toBe('deleted');
    expect(stored?.providerEventId).toBeNull();
    expect(stored?.providerSource).toBeNull();

    provider.findAgendaItemIds = [];
    const repeated = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: true,
    }, provider);

    expect(repeated).toHaveLength(0);
    expect(provider.findAgendaItemIds).toEqual([]);
    expect(provider.createAttempts).toBe(1);
  });

  it('treats terminal deleted cleanup rows without provider IDs as no-op syncs', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'terminal-cleanup-no-provider',
      sourceEntityId: 'session-terminal-cleanup',
    }));
    testDb.prepare(`
      UPDATE secretary_agenda_items
      SET lifecycle_state = 'unscheduled',
          provider_sync_state = 'deleted',
          provider_event_id = NULL,
          provider_source = NULL,
          cancellation_reason = 'training_provider_ownership_record_failed',
          updated_at = '2026-05-01T10:00:00.000Z'
      WHERE agenda_item_id = ?
    `).run(decision.agendaItem.agendaItemId);

    const batch = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: true,
    }, provider);
    const direct = await syncOne(decision.agendaItem.agendaItemId, provider);

    expect(batch).toHaveLength(0);
    expect(direct).toMatchObject({
      agendaItemId: decision.agendaItem.agendaItemId,
      action: 'skipped',
      providerSyncState: 'deleted',
      providerEventId: null,
      reasonCode: 'terminal_cleanup_no_provider_event',
    });
    expect(provider.createAttempts).toBe(0);
    expect(provider.createInputs).toHaveLength(0);
    expect(provider.deletedEventIds).toEqual([]);
  });

  it('converges legacy deleted cleanup rows that still have provider IDs without deleting again', async () => {
    const provider = new MockSecretaryProvider();
    const legacyProviderEventId = 'google_evt_legacy_deleted';
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'legacy-half-deleted-cleanup',
      sourceEntityId: 'session-legacy-half-deleted',
    }));
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'canceled',
             provider_sync_state = 'deleted',
             provider_event_id = ?,
             provider_source = 'google',
             cancellation_reason = 'training_plan_canceled',
             updated_at = '2026-05-01T10:00:00.000Z'
       WHERE agenda_item_id = ?
    `).run(legacyProviderEventId, decision.agendaItem.agendaItemId);

    const cleanup = await syncOne(decision.agendaItem.agendaItemId, provider);
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    const repeated = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: true,
    }, provider);

    expect(cleanup).toMatchObject({
      action: 'skipped',
      providerEventId: null,
      providerSyncState: 'deleted',
      reasonCode: 'no_provider_event_to_delete',
    });
    expect(stored?.lifecycleState).toBe('canceled');
    expect(stored?.providerSyncState).toBe('deleted');
    expect(stored?.providerEventId).toBeNull();
    expect(stored?.providerSource).toBeNull();
    expect(provider.deletedEventIds).toEqual([]);
    expect(repeated).toHaveLength(0);
  });

  it('treats provider 410 Gone during cleanup as already deleted', async () => {
    class GoneOnDeleteProvider extends MockSecretaryProvider {
      async deleteEvent(eventId: string): Promise<void> {
        this.deletedEventIds.push(eventId);
        this.events.delete(eventId);
        throw { status: 410, reason: 'deleted', message: 'Resource has been deleted' };
      }
    }

    const provider = new GoneOnDeleteProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'bulk-canceled-gone-cleanup',
      sourceEntityId: 'session-bulk-canceled-gone',
    }));
    const created = await syncOne(decision.agendaItem.agendaItemId, provider);
    cancelSecretaryAgendaItem({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'training_plan_canceled',
      now: '2026-05-01T10:00:00.000Z',
    });

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
      agendaItemId: decision.agendaItem.agendaItemId,
      action: 'deleted',
      providerSyncState: 'deleted',
      reasonCode: 'provider_event_deleted',
    });
    expect(provider.deletedEventIds).toContain(created.providerEventId);
    expect(stored?.lifecycleState).toBe('canceled');
    expect(stored?.providerSyncState).toBe('deleted');
    expect(stored?.providerEventId).toBeNull();
    expect(stored?.providerSource).toBeNull();
  });

  it('treats provider not-found during null-input cleanup as already deleted', async () => {
    class GoneOnNullInputDeleteProvider extends MockSecretaryProvider {
      deleteInputs: Array<SecretaryProviderEventInput | null> = [];

      async deleteEvent(eventId: string, input: SecretaryProviderEventInput | null): Promise<void> {
        this.deletedEventIds.push(eventId);
        this.deleteInputs.push(input);
        throw { code: 'event_not_found', message: 'calendar event not found' };
      }
    }

    const provider = new GoneOnNullInputDeleteProvider();
    const legacyProviderEventId = 'google_evt_unscheduled_gone';
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'unscheduled-null-input-gone',
      sourceEntityId: 'session-unscheduled-null-input',
    }));
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'unscheduled',
             provider_sync_state = 'synced',
             provider_event_id = ?,
             provider_source = 'google',
             start_at = NULL,
             end_at = NULL,
             duration_minutes = NULL,
             cancellation_reason = 'training_session_unscheduled',
             updated_at = '2026-05-01T10:00:00.000Z'
       WHERE agenda_item_id = ?
    `).run(legacyProviderEventId, decision.agendaItem.agendaItemId);

    const cleanup = await syncOne(decision.agendaItem.agendaItemId, provider);
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(cleanup).toMatchObject({
      action: 'deleted',
      providerEventId: null,
      providerSyncState: 'deleted',
      reasonCode: 'provider_event_deleted',
    });
    expect(provider.deletedEventIds).toEqual([legacyProviderEventId]);
    expect(provider.deleteInputs).toEqual([null]);
    expect(stored?.lifecycleState).toBe('unscheduled');
    expect(stored?.providerSyncState).toBe('deleted');
    expect(stored?.providerEventId).toBeNull();
    expect(stored?.providerSource).toBeNull();
  });

  it('keeps delete_failed rows provider-backed so cleanup retries the delete', async () => {
    class FailingDeleteProvider extends MockSecretaryProvider {
      async deleteEvent(eventId: string): Promise<void> {
        this.deletedEventIds.push(eventId);
        throw new Error('simulated transient provider delete failure');
      }
    }

    const provider = new FailingDeleteProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'delete-failed-retry',
      sourceEntityId: 'session-delete-failed-retry',
    }));
    const created = await syncOne(decision.agendaItem.agendaItemId, provider);
    cancelSecretaryAgendaItem({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'training_plan_canceled',
      now: '2026-05-01T10:00:00.000Z',
    });

    const failed = await syncOne(decision.agendaItem.agendaItemId, provider);
    const afterFailure = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    const retried = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { retryBudget: 0 });

    expect(failed).toMatchObject({
      action: 'failed',
      providerEventId: created.providerEventId,
      providerSyncState: 'delete_failed',
      reasonCode: 'provider_delete_failed',
    });
    expect(afterFailure?.providerEventId).toBe(created.providerEventId);
    expect(afterFailure?.providerSource).toBe('google');
    expect(afterFailure?.lifecycleState).toBe('canceled');
    expect(afterFailure?.providerSyncState).toBe('delete_failed');
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({
      action: 'failed',
      providerEventId: created.providerEventId,
      providerSyncState: 'delete_failed',
    });
    expect(provider.deletedEventIds).toEqual([created.providerEventId, created.providerEventId]);
    expect(provider.createAttempts).toBe(1);
    expect(provider.createInputs).toHaveLength(1);
  });

  it('dead-letters cleanup after the consecutive delete-failure threshold and stops retrying', async () => {
    class FailingDeleteProvider extends MockSecretaryProvider {
      async deleteEvent(eventId: string): Promise<void> {
        this.deletedEventIds.push(eventId);
        throw new Error('simulated permanent provider delete failure');
      }
    }

    const provider = new FailingDeleteProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'delete-failed-dead-letter',
      sourceEntityId: 'session-delete-failed-dead-letter',
    }));
    await syncOne(decision.agendaItem.agendaItemId, provider);
    cancelSecretaryAgendaItem({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'training_plan_canceled',
      now: '2026-05-01T10:00:00.000Z',
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failed = await syncOne(decision.agendaItem.agendaItemId, provider);
      expect(failed).toMatchObject({ action: 'failed', providerSyncState: 'delete_failed' });
      const row = getSecretaryAgendaItemById({
        agendaItemId: decision.agendaItem.agendaItemId,
        ownerUserId: OWNER_USER_ID,
        tenantId: TENANT_ID,
      });
      expect(row?.providerSyncFailureCount).toBe(attempt);
    }

    const deleteAttemptsBeforeDeadLetter = provider.deletedEventIds.length;
    const skipped = await syncOne(decision.agendaItem.agendaItemId, provider);
    expect(skipped).toMatchObject({
      action: 'skipped',
      providerSyncState: 'delete_failed',
      reasonCode: 'provider_sync_dead_letter',
    });
    // No further provider calls once dead-lettered.
    expect(provider.deletedEventIds).toHaveLength(deleteAttemptsBeforeDeadLetter);

    // The row stays truthful: still delete_failed, still provider-backed,
    // so a manual counter reset can resume cleanup.
    const row = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    expect(row?.providerSyncState).toBe('delete_failed');
    expect(row?.providerEventId).not.toBeNull();
    expect(row?.providerSyncFailureCount).toBe(5);
  });

  it('resets the failure count once a provider delete finally succeeds', async () => {
    class FlakyDeleteProvider extends MockSecretaryProvider {
      deleteFailuresRemaining = 2;
      async deleteEvent(eventId: string): Promise<void> {
        this.deletedEventIds.push(eventId);
        if (this.deleteFailuresRemaining > 0) {
          this.deleteFailuresRemaining -= 1;
          throw new Error('simulated transient provider delete failure');
        }
        this.events.delete(eventId);
      }
    }

    const provider = new FlakyDeleteProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'delete-failed-recovers',
      sourceEntityId: 'session-delete-failed-recovers',
    }));
    await syncOne(decision.agendaItem.agendaItemId, provider);
    cancelSecretaryAgendaItem({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'training_plan_canceled',
      now: '2026-05-01T10:00:00.000Z',
    });

    await syncOne(decision.agendaItem.agendaItemId, provider);
    await syncOne(decision.agendaItem.agendaItemId, provider);
    const recovered = await syncOne(decision.agendaItem.agendaItemId, provider);
    expect(recovered).toMatchObject({ action: 'deleted', providerSyncState: 'deleted' });

    const row = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    expect(row?.providerSyncFailureCount).toBe(0);
    expect(row?.providerEventId).toBeNull();
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
        tenant_id INTEGER,
        message TEXT NOT NULL,
        remind_at TEXT NOT NULL,
        recurring TEXT,
        agenda_item_id TEXT,
        timezone TEXT,
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

    // Healing runs on the re-verification pass (migration 224): unchanged
    // synced items skip provider round-trips inside the verification window,
    // so expire the window to trigger the full pass that detects drift.
    testDb.prepare(
      'UPDATE secretary_agenda_items SET last_synced_verified_at = ? WHERE agenda_item_id = ?',
    ).run(new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), decision.agendaItem.agendaItemId);

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

  it('does not resurrect a deleted provider event when the backing Training session is unscheduled', async () => {
    testDb.exec(`
      CREATE TABLE fitness_training_plans (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE training_sessions (
        id INTEGER PRIMARY KEY,
        plan_id INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO fitness_training_plans (id, user_id, tenant_id, status)
      VALUES (9001, ${OWNER_USER_ID}, '${TENANT_ID}', 'active');
      INSERT INTO training_sessions (id, plan_id, status)
      VALUES (501, 9001, 'scheduled');
    `);
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'unscheduled-training-session',
      sourceEntityId: '501',
      sourceEntityType: 'training_session',
    }));
    const first = await syncOne(decision.agendaItem.agendaItemId, provider);
    provider.removeExternally(first.providerEventId!);
    testDb.prepare(`
      UPDATE training_sessions
         SET status = 'unscheduled'
       WHERE id = 501
    `).run();
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'failed_sync',
             provider_sync_state = 'readback_failed',
             updated_at = ?
       WHERE agenda_item_id = ?
    `).run(
      '2026-06-07T18:00:00.000Z',
      decision.agendaItem.agendaItemId,
    );

    const cleanup = await syncOne(decision.agendaItem.agendaItemId, provider);
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(cleanup.action).toBe('deleted');
    expect(cleanup.providerSyncState).toBe('deleted');
    expect(cleanup.reasonCode).toBe('provider_event_deleted');
    expect(provider.createAttempts).toBe(1);
    expect(provider.createInputs).toHaveLength(1);
    expect(provider.deletedEventIds).toContain(first.providerEventId);
    expect(stored?.lifecycleState).toBe('unscheduled');
    expect(stored?.providerSyncState).toBe('deleted');
    expect(stored?.cancellationReason).toBe('training_session_unscheduled');
    expect(stored?.providerSyncState).not.toBe('synced');
  });

  it('treats cancellation-reasoned active rows as cleanup rows instead of recreating deleted provider events', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'leaked-training-cancel',
      sourceEntityId: 'session-leaked-cancel',
    }));
    const first = await syncOne(decision.agendaItem.agendaItemId, provider);
    provider.removeExternally(first.providerEventId!);
    testDb.prepare(`
      UPDATE secretary_agenda_items
      SET lifecycle_state = 'synced',
          provider_sync_state = 'synced',
          cancellation_reason = 'training_plan_canceled',
          updated_at = ?
      WHERE agenda_item_id = ?
    `).run(
      '2026-06-07T18:00:00.000Z',
      decision.agendaItem.agendaItemId,
    );

    const cleanup = await syncOne(decision.agendaItem.agendaItemId, provider);
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(cleanup.action).toBe('deleted');
    expect(cleanup.reasonCode).toBe('provider_event_deleted');
    expect(provider.createInputs).toHaveLength(1);
    expect(provider.deletedEventIds).toContain(first.providerEventId);
    expect(stored?.lifecycleState).toBe('canceled');
    expect(stored?.providerSyncState).toBe('deleted');
    expect(stored?.providerEventId).toBeNull();
    expect(stored?.providerSource).toBeNull();
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

    // Healing runs on the re-verification pass (migration 224): unchanged
    // synced items skip provider round-trips inside the verification window,
    // so expire the window to trigger the full pass that detects drift.
    testDb.prepare(
      'UPDATE secretary_agenda_items SET last_synced_verified_at = ? WHERE agenda_item_id = ?',
    ).run(new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), decision.agendaItem.agendaItemId);

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

describe('provider-sync fingerprint short-circuit (migration 224)', () => {
  const OLD_ENV = process.env.SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES;

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES;
    else process.env.SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES = OLD_ENV;
  });

  it('skips all provider round-trips for an unchanged synced item', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent());
    await syncOne(decision.agendaItem.agendaItemId, provider);
    const findCallsAfterFirst = provider.findAgendaItemIds.length;

    const second = await syncOne(decision.agendaItem.agendaItemId, provider);

    expect(second).toMatchObject({
      action: 'skipped',
      providerSyncState: 'synced',
      reasonCode: 'unchanged_since_last_sync',
    });
    // No readback, no duplicate-window scan, no update PATCH on the second pass.
    expect(provider.findAgendaItemIds.length).toBe(findCallsAfterFirst);
    expect(provider.updateInputs).toHaveLength(0);
    expect(provider.createInputs).toHaveLength(1);
  });

  it('short-circuits after Training marks the provider sync satisfied (markSatisfied handshake)', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent());

    // Training created the provider event directly and recorded ownership.
    markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'training_direct_evt_1',
      providerSource: 'google',
    });

    const result = await syncOne(decision.agendaItem.agendaItemId, provider);

    // The arbitrator-recorded fingerprint must byte-match the sync engine's
    // computation or every Training session reverts to per-tick round-trips.
    expect(result).toMatchObject({
      action: 'skipped',
      providerSyncState: 'synced',
      reasonCode: 'unchanged_since_last_sync',
    });
    expect(provider.createInputs).toHaveLength(0);
    expect(provider.updateInputs).toHaveLength(0);
    expect(provider.findAgendaItemIds).toHaveLength(0);
  });

  it('keeps the trainingOwned event as canonical and deletes the Secretary copy instead', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent());
    const agendaItemId = decision.agendaItem.agendaItemId;
    // Legacy duplicate state: the agenda row points at the Secretary copy
    // while the Training-created, marker-bearing event coexists.
    const secretaryCopy = provider.seedEvent(providerInputFor(agendaItemId), 'zzz_secretary_copy');
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET provider_event_id = ?,
             provider_source = 'google',
             provider_sync_state = 'synced'
       WHERE agenda_item_id = ?
    `).run(secretaryCopy.eventId, agendaItemId);
    const trainingEvent: SecretaryProviderEvent = {
      eventId: 'aaa_training_direct',
      source: 'google',
      agendaItemId,
      title: '💪 Bike endurance session (60min)',
      startAt: decision.agendaItem.startAt!,
      endAt: decision.agendaItem.endAt!,
      trainingOwned: true,
    };
    provider.events.set(trainingEvent.eventId, trainingEvent);

    const result = await syncOne(agendaItemId, provider);

    // Pre-fix, canonical selection preferred the stored provider_event_id
    // (the Secretary copy) and DELETED the Training-linked event from the
    // user's calendar. trainingOwned must outrank the stored id.
    expect(result.action).toBe('attached');
    expect(result.providerEventId).toBe('aaa_training_direct');
    expect(provider.deletedEventIds).toEqual([secretaryCopy.eventId]);
    const stored = getSecretaryAgendaItemById({
      agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    expect(stored?.providerEventId).toBe('aaa_training_direct');
  });

  it('re-syncs when the scheduled slot changes', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent());
    await syncOne(decision.agendaItem.agendaItemId, provider);

    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET start_at = '2026-05-04T10:00:00.000Z', end_at = '2026-05-04T11:00:00.000Z'
       WHERE agenda_item_id = ?
    `).run(decision.agendaItem.agendaItemId);

    const second = await syncOne(decision.agendaItem.agendaItemId, provider);
    expect(second.action).toBe('updated');
    expect(provider.updateInputs).toHaveLength(1);
  });

  it('re-verifies against the provider after the verification window elapses', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent());
    await syncOne(decision.agendaItem.agendaItemId, provider);

    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    testDb.prepare(`
      UPDATE secretary_agenda_items SET last_synced_verified_at = ? WHERE agenda_item_id = ?
    `).run(sevenHoursAgo, decision.agendaItem.agendaItemId);

    const second = await syncOne(decision.agendaItem.agendaItemId, provider);
    expect(second.action).toBe('updated');
    // A full pass heals externally-drifted events and refreshes the window.
    const verifiedAt = testDb.prepare(
      'SELECT last_synced_verified_at AS v FROM secretary_agenda_items WHERE agenda_item_id = ?',
    ).get(decision.agendaItem.agendaItemId) as { v: string };
    expect(Date.parse(verifiedAt.v)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES=0 disables the short-circuit', async () => {
    process.env.SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES = '0';
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent());
    await syncOne(decision.agendaItem.agendaItemId, provider);

    const second = await syncOne(decision.agendaItem.agendaItemId, provider);
    expect(second.action).toBe('updated');
    expect(provider.updateInputs).toHaveLength(1);
  });

  it('heals an externally deleted provider event on the stale-window pass', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent());
    const first = await syncOne(decision.agendaItem.agendaItemId, provider);
    provider.removeExternally(first.providerEventId!);

    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    testDb.prepare(`
      UPDATE secretary_agenda_items SET last_synced_verified_at = ? WHERE agenda_item_id = ?
    `).run(sevenHoursAgo, decision.agendaItem.agendaItemId);

    const second = await syncOne(decision.agendaItem.agendaItemId, provider);
    expect(second.action).toBe('recreated');
    expect(second.reasonCode).toBe('missing_provider_event_recreated');
  });
});
