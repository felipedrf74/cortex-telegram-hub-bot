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
const MIGRATION_278 = path.resolve(
  __dirname,
  '../../migrations/278_secretary_agenda_provider_sync_claims.sql',
);
const MIGRATION_281 = path.resolve(
  __dirname,
  '../../migrations/281_secretary_provider_target_and_failure_disposition.sql',
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
  applyMigrationFileForTest: vi.fn(),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
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
  listPendingSecretaryAgendaProviderScopes,
  markCompletedSecretaryAgendaItems,
  syncSecretaryAgendaItemsToProvider,
  syncSecretaryAgendaItemToProvider,
  type SecretaryAgendaProviderAdapter,
  type SecretaryProviderEvent,
  type SecretaryProviderEventInput,
} from '../../src/services/secretary-agenda-provider-sync';
import * as secretaryAgendaProviderSyncModule from '../../src/services/secretary-agenda-provider-sync';
import * as secretaryUnifiedCalendarAdapterModule from '../../src/services/secretary-unified-calendar-provider-adapter';
import { cleanupTrainingSecretaryCalendarHandoff } from '../../src/services/training-secretary-calendar-handoff';
import { getActiveReminders, setReminder } from '../../src/state/reminders';
import { logger } from '../../src/utils/logger';
import { ensureEventOutboxTables } from '../../src/services/event-outbox';

const TENANT_ID = 'tenant-calendar-lifecycle';
const OWNER_USER_ID = 74;

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
  testDb.exec(fs.readFileSync(MIGRATION_098, 'utf8'));
  testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
  testDb.exec(fs.readFileSync(MIGRATION_220, 'utf8'));
  testDb.exec(fs.readFileSync(MIGRATION_224, 'utf8'));
  testDb.exec(fs.readFileSync(MIGRATION_278, 'utf8'));
  testDb.exec(fs.readFileSync(MIGRATION_281, 'utf8'));
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
      // Fixture models a known-no-effect validation refusal. Ambiguous
      // transport/server failures use explicit ETIMEDOUT/ECONNRESET/5xx tests
      // and must enter read-only reconciliation instead of auto-retrying.
      throw Object.assign(new Error('simulated provider create failure'), {
        code: 'PROVIDER_VALIDATION_FAILED',
      });
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

  async getEvent(eventId: string) {
    const event = this.events.get(eventId);
    return event ? { status: 'found' as const, event } : { status: 'not_found' as const };
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
    providerTarget: 'google',
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
  it('enforces Training calendar kill switches at the generic effect boundary without blocking reads or other skills', async () => {
    const training = submitSecretarySchedulingIntent(intent({
      intentId: 'training-effect-kill-switch',
    }));
    const cooking = submitSecretarySchedulingIntent(intent({
      intentId: 'cooking-effect-kill-switch-control',
      sourceSkill: 'cooking',
      sourceEntityId: 'meal-prep-1',
      sourceEntityType: 'meal_prep',
    }));
    const provider = new MockSecretaryProvider();
    const prior = process.env.TRAINING_CALENDAR_WRITES_DISABLED;
    process.env.TRAINING_CALENDAR_WRITES_DISABLED = 'true';
    try {
      const blocked = await syncOne(training.agendaItem.agendaItemId, provider);

      expect(blocked).toMatchObject({
        action: 'failed',
        providerEventId: null,
        reasonCode: 'training_calendar_writes_disabled',
      });
      // Discovery/exact reconciliation remains available, but the wrapped
      // adapter refuses the mutation before it reaches the provider.
      expect(provider.findAgendaItemIds).toContain(training.agendaItem.agendaItemId);
      expect(provider.createAttempts).toBe(0);
      expect(provider.updateInputs).toHaveLength(0);
      expect(provider.deletedEventIds).toHaveLength(0);
      expect(testDb.prepare(`
        SELECT resolution_state AS resolutionState
          FROM secretary_agenda_provider_create_reconciliation
         WHERE agenda_item_id = ?
      `).get(training.agendaItem.agendaItemId)).toEqual({ resolutionState: 'no_effect' });
      expect(testDb.prepare(`
        SELECT COUNT(*) AS count
          FROM secretary_agenda_provider_effect_recovery
         WHERE agenda_item_id = ? AND resolution_state = 'pending'
      `).get(training.agendaItem.agendaItemId)).toEqual({ count: 0 });

      const unaffected = await syncOne(cooking.agendaItem.agendaItemId, provider);
      expect(unaffected.action).toBe('created');
      expect(provider.createAttempts).toBe(1);
    } finally {
      if (prior == null) delete process.env.TRAINING_CALENDAR_WRITES_DISABLED;
      else process.env.TRAINING_CALENDAR_WRITES_DISABLED = prior;
    }
  });

  it('blocks queued Training updates and resolves the pre-effect recovery as no_effect', async () => {
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'training-update-kill-switch',
    }));
    const provider = new MockSecretaryProvider();
    const created = await syncOne(decision.agendaItem.agendaItemId, provider);
    expect(created.action).toBe('created');
    const priorDisabled = process.env.TRAINING_CALENDAR_WRITES_DISABLED;
    const priorInterval = process.env.SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES;
    process.env.TRAINING_CALENDAR_WRITES_DISABLED = 'true';
    process.env.SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES = '0';
    try {
      const blocked = await syncOne(decision.agendaItem.agendaItemId, provider);

      expect(blocked).toMatchObject({
        action: 'failed',
        providerSyncState: 'update_failed',
        reasonCode: 'training_calendar_writes_disabled',
      });
      expect(provider.updateInputs).toHaveLength(0);
      expect(testDb.prepare(`
        SELECT resolution_state AS resolutionState
          FROM secretary_agenda_provider_effect_recovery
         WHERE agenda_item_id = ? AND effect_kind = 'update'
         ORDER BY created_at DESC LIMIT 1
      `).get(decision.agendaItem.agendaItemId)).toEqual({ resolutionState: 'no_effect' });
      expect(testDb.prepare(`
        SELECT COUNT(*) AS count
          FROM secretary_agenda_provider_effect_recovery
         WHERE agenda_item_id = ? AND resolution_state = 'pending'
      `).get(decision.agendaItem.agendaItemId)).toEqual({ count: 0 });
    } finally {
      if (priorDisabled == null) delete process.env.TRAINING_CALENDAR_WRITES_DISABLED;
      else process.env.TRAINING_CALENDAR_WRITES_DISABLED = priorDisabled;
      if (priorInterval == null) delete process.env.SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES;
      else process.env.SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES = priorInterval;
    }
  });

  it('blocks queued Training deletes while preserving the exact durable mapping for retry', async () => {
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'training-delete-kill-switch',
    }));
    const provider = new MockSecretaryProvider();
    const created = await syncOne(decision.agendaItem.agendaItemId, provider);
    expect(created.action).toBe('created');
    cancelSecretaryAgendaItem({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'kill_switch_delete_test',
    });
    const prior = process.env.TRAINING_CALENDAR_WRITES_DISABLED;
    process.env.TRAINING_CALENDAR_WRITES_DISABLED = 'true';
    try {
      const blocked = await syncOne(decision.agendaItem.agendaItemId, provider);

      expect(blocked).toMatchObject({ action: 'failed', providerSyncState: 'delete_failed' });
      expect(provider.deletedEventIds).toHaveLength(0);
      expect(getSecretaryAgendaItemById({
        agendaItemId: decision.agendaItem.agendaItemId,
        ownerUserId: OWNER_USER_ID,
        tenantId: TENANT_ID,
      })).toMatchObject({
        providerEventId: created.providerEventId,
        providerSource: 'google',
        providerSyncState: 'delete_failed',
      });
    } finally {
      if (prior == null) delete process.env.TRAINING_CALENDAR_WRITES_DISABLED;
      else process.env.TRAINING_CALENDAR_WRITES_DISABLED = prior;
    }
  });

  it('enumerates and executes only the exact durable owner, tenant, and provider target', async () => {
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'exact-provider-target-scope',
      tenantId: 'tenant-provider-target-exact',
      providerTarget: 'google',
    }));
    const google = new MockSecretaryProvider();
    const outlookCalls = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      find: vi.fn(async () => []),
    };
    const outlook: SecretaryAgendaProviderAdapter = {
      source: 'outlook',
      createEvent: outlookCalls.create,
      updateEvent: outlookCalls.update,
      deleteEvent: outlookCalls.delete,
      findEventsByAgendaItemId: outlookCalls.find,
    };

    expect(listPendingSecretaryAgendaProviderScopes()).toContainEqual({
      ownerUserId: OWNER_USER_ID,
      tenantId: 'tenant-provider-target-exact',
      providerSource: 'google',
    });
    await expect(syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: 'tenant-provider-target-exact',
      includeInactive: false,
    }, outlook, { maxItems: 4, retryBudget: 0 })).resolves.toEqual([]);
    const synced = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: 'tenant-provider-target-exact',
      includeInactive: false,
    }, google, { maxItems: 4, retryBudget: 0 });

    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({
      agendaItemId: decision.agendaItem.agendaItemId,
      action: 'created',
      providerSource: 'google',
    });
    expect(google.createInputs).toHaveLength(1);
    expect(outlookCalls.create).not.toHaveBeenCalled();
    expect(outlookCalls.update).not.toHaveBeenCalled();
    expect(outlookCalls.delete).not.toHaveBeenCalled();
    expect(outlookCalls.find).not.toHaveBeenCalled();
  });

  it('compensates a create when the durable provider target changes before success CAS', async () => {
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'provider-target-success-cas',
      providerTarget: 'google',
    }));
    class TargetRaceProvider extends MockSecretaryProvider {
      override async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        const event = await super.createEvent(input);
        testDb.prepare(`
          UPDATE secretary_agenda_items
             SET provider_target = 'outlook'
           WHERE agenda_item_id = ?
        `).run(input.agendaItemId);
        return event;
      }
    }
    const provider = new TargetRaceProvider();

    await expect(syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { agendaItemId: decision.agendaItem.agendaItemId, maxItems: 6, retryBudget: 0 }))
      .rejects.toThrow('SECRETARY_PROVIDER_SYNC_LEASE_LOST');

    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    // Stronger guarantee: a stale provider claim can neither publish a
    // mapping nor leave its known create alive after the target CAS fails.
    expect(stored).toMatchObject({
      providerTarget: 'outlook',
      providerEventId: null,
      providerSource: null,
      providerSyncState: 'not_synced',
    });
    expect(provider.events.size).toBe(0);
    expect(provider.deletedEventIds).toHaveLength(1);
  });

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

  it('claims each agenda version before provider work so overlapping bulk workers do not duplicate it', async () => {
    let releaseCreate!: () => void;
    let reportCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => { reportCreateStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseCreate = resolve; });
    class BlockingProvider extends MockSecretaryProvider {
      override async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        reportCreateStarted();
        await release;
        return super.createEvent(input);
      }
    }

    submitSecretarySchedulingIntent(intent({
      intentId: 'overlapping-provider-sync-claim',
      sourceEntityId: 'session-overlapping-provider-sync-claim',
    }));
    const firstProvider = new BlockingProvider();
    const first = syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    // Total-call budget: marker discovery + create require two adapter slots.
    }, firstProvider, { maxItems: 2, leaseDurationMs: 5_000 });
    await createStarted;

    const secondProvider = new MockSecretaryProvider();
    const second = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, secondProvider, { maxItems: 2, leaseDurationMs: 5_000 });

    releaseCreate();
    const firstResult = await first;
    expect(second).toEqual([]);
    expect(secondProvider.createAttempts).toBe(0);
    expect(firstResult).toHaveLength(1);
  });

  it('claims only the requested agenda item for a synchronous skill-owned create boundary', async () => {
    const first = submitSecretarySchedulingIntent(intent({
      intentId: 'unrelated-provider-sync-backlog',
      sourceEntityId: 'session-unrelated-provider-sync-backlog',
      preferredWindows: [
        timeWindow('2026-05-04T07:00:00.000Z', '2026-05-04T08:00:00.000Z', 'early'),
      ],
    }));
    const requested = submitSecretarySchedulingIntent(intent({
      intentId: 'requested-provider-sync-item',
      sourceEntityId: 'session-requested-provider-sync-item',
      preferredWindows: [
        timeWindow('2026-05-04T12:00:00.000Z', '2026-05-04T13:00:00.000Z', 'lunch'),
      ],
    }));
    const provider = new MockSecretaryProvider();

    const results = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, {
      agendaItemId: requested.agendaItem.agendaItemId,
      // Marker discovery + create require two provider-call slots.
      maxItems: 2,
      retryBudget: 0,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      agendaItemId: requested.agendaItem.agendaItemId,
      action: 'created',
      providerSyncState: 'synced',
    });
    expect(provider.createInputs.map((input) => input.agendaItemId)).toEqual([
      requested.agendaItem.agendaItemId,
    ]);
    expect(getSecretaryAgendaItemById({
      agendaItemId: first.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })?.providerEventId).toBeNull();
  });

  it('persists Cooking mapping and its completion event in one transaction', async () => {
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'cooking-provider-completion',
      sourceSkill: 'cooking',
      sourceEntityId: '2026-08-03',
      sourceEntityType: 'meal_prep_block',
    }));
    const provider = new MockSecretaryProvider();

    const results = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 4, retryBudget: 0 });

    expect(results[0]).toMatchObject({ action: 'created', providerSyncState: 'synced' });
    const completion = testDb.prepare(`
      SELECT entity_id, entity_version, payload_json, status
        FROM event_outbox
       WHERE event_type = 'cooking.meal_prep_provider_sync.completed.v1'
    `).get() as { entity_id: string; entity_version: number; payload_json: string; status: string };
    expect(completion).toMatchObject({
      entity_id: decision.agendaItem.agendaItemId,
      entity_version: decision.agendaItem.version,
      status: 'pending',
    });
    expect(JSON.parse(completion.payload_json)).toEqual({ agendaTenantId: TENANT_ID });
  });

  it('rolls back Cooking mapping and compensates create when completion outbox persistence fails', async () => {
    ensureEventOutboxTables(testDb);
    testDb.exec(`
      CREATE TRIGGER fail_cooking_provider_completion_event
      BEFORE INSERT ON event_outbox
      WHEN NEW.event_type = 'cooking.meal_prep_provider_sync.completed.v1'
      BEGIN
        SELECT RAISE(ABORT, 'injected Cooking completion outbox failure');
      END;
    `);
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'cooking-provider-completion-rollback',
      sourceSkill: 'cooking',
      sourceEntityId: '2026-08-10',
      sourceEntityType: 'meal_prep_block',
    }));
    const provider = new MockSecretaryProvider();

    const results = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 6, retryBudget: 0 });
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(results[0]).toMatchObject({
      action: 'failed',
      reasonCode: 'provider_mapping_failed_create_compensated',
    });
    expect(stored?.providerEventId).toBeNull();
    expect(provider.events.size).toBe(0);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'cooking.meal_prep_provider_sync.completed.v1'
    `).get()).toEqual({ count: 0 });
  });

  it('renews a live provider-sync claim while a slow adapter call is in flight', async () => {
    let reportCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => { reportCreateStarted = resolve; });
    class SlowProvider extends MockSecretaryProvider {
      override async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        reportCreateStarted();
        await new Promise((resolve) => setTimeout(resolve, 120));
        return super.createEvent(input);
      }
    }

    submitSecretarySchedulingIntent(intent({
      intentId: 'provider-sync-heartbeat',
      sourceEntityId: 'session-provider-sync-heartbeat',
    }));
    const first = syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    // Total-call budget: marker discovery + create require two adapter slots.
    }, new SlowProvider(), { maxItems: 2, leaseDurationMs: 60, heartbeatIntervalMs: 15 });
    await createStarted;
    await new Promise((resolve) => setTimeout(resolve, 80));

    const competingProvider = new MockSecretaryProvider();
    const competing = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, competingProvider, { maxItems: 2, leaseDurationMs: 60, heartbeatIntervalMs: 15 });

    const firstResult = await first;
    expect(competing).toEqual([]);
    expect(competingProvider.createAttempts).toBe(0);
    expect(firstResult).toHaveLength(1);
  });

  it('heartbeats queued claims while an earlier provider effect is blocked', async () => {
    let releaseFirstCreate!: () => void;
    let reportFirstCreateStarted!: () => void;
    const firstCreateStarted = new Promise<void>((resolve) => { reportFirstCreateStarted = resolve; });
    const releaseFirst = new Promise<void>((resolve) => { releaseFirstCreate = resolve; });
    class FirstCreateBlockingProvider extends MockSecretaryProvider {
      override async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        if (this.createAttempts === 0) {
          reportFirstCreateStarted();
          await releaseFirst;
        }
        return super.createEvent(input);
      }
    }

    submitSecretarySchedulingIntent(intent({
      intentId: 'provider-sync-queued-heartbeat-1',
      sourceEntityId: 'session-provider-sync-queued-heartbeat-1',
    }));
    submitSecretarySchedulingIntent(intent({
      intentId: 'provider-sync-queued-heartbeat-2',
      sourceEntityId: 'session-provider-sync-queued-heartbeat-2',
      preferredWindows: [timeWindow(
        '2026-05-04T13:00:00.000Z',
        '2026-05-04T15:00:00.000Z',
        'afternoon',
      )],
    }));

    const firstProvider = new FirstCreateBlockingProvider();
    const first = syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    // Two rows each require marker discovery + create: four total calls.
    }, firstProvider, { maxItems: 4, leaseDurationMs: 60, heartbeatIntervalMs: 15 });
    await firstCreateStarted;
    await new Promise((resolve) => setTimeout(resolve, 80));

    const competingProvider = new MockSecretaryProvider();
    const competing = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, competingProvider, { maxItems: 4, leaseDurationMs: 60, heartbeatIntervalMs: 15 });

    releaseFirstCreate();
    const firstResult = await first;
    expect(competing).toEqual([]);
    expect(competingProvider.createAttempts).toBe(0);
    expect(firstResult).toHaveLength(2);
    expect(firstProvider.createAttempts).toBe(2);
  });

  it('fences a stale worker after lease theft so its provider result cannot overwrite the new owner', async () => {
    let releaseFirst!: () => void;
    let reportFirstEffect!: () => void;
    const firstEffect = new Promise<void>((resolve) => { reportFirstEffect = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    class EffectThenBlockProvider extends MockSecretaryProvider {
      override async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        const event = await super.createEvent(input);
        reportFirstEffect();
        await release;
        return event;
      }
    }

    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'provider-sync-lease-theft',
      sourceEntityId: 'session-provider-sync-lease-theft',
    }));
    const staleWorker = syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, new EffectThenBlockProvider(), {
      // Total-call budget: marker discovery + create require two slots.
      maxItems: 2,
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 60_000,
    });
    await firstEffect;
    const expired = testDb.prepare(`
      UPDATE secretary_agenda_provider_sync_claims
         SET lease_expires_at = '2000-01-01T00:00:00.000Z'
       WHERE agenda_item_id = ? AND provider_source = 'google'
    `).run(decision.agendaItem.agendaItemId);

    const newOwnerProvider = new MockSecretaryProvider();
    const newOwner = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, newOwnerProvider, { maxItems: 2, leaseDurationMs: 60_000 });
    expect(newOwner).toHaveLength(1);
    const authoritativeProviderEventId = newOwner[0].providerEventId;

    releaseFirst();
    const staleOutcome = await staleWorker.then(
      () => ({ kind: 'resolved' as const, error: null }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    expect(expired.changes).toBe(1);
    expect(staleOutcome.kind).toBe('rejected');
    expect(String(staleOutcome.error)).toMatch(/SECRETARY_PROVIDER_SYNC_LEASE_LOST/);
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    expect(stored?.providerEventId).toBe(authoritativeProviderEventId);
  });

  it('applies the total adapter-call cap across discovery and writes', async () => {
    class CountEveryCallProvider implements SecretaryAgendaProviderAdapter {
      source = 'google' as const;
      calls = 0;
      async findEventsByAgendaItemId(): Promise<SecretaryProviderEvent[]> {
        this.calls += 1;
        return [];
      }
      async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        this.calls += 1;
        return { eventId: `bounded_${this.calls}`, source: this.source, agendaItemId: input.agendaItemId };
      }
      async updateEvent(eventId: string, input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        this.calls += 1;
        return { eventId, source: this.source, agendaItemId: input.agendaItemId };
      }
      async getEvent() {
        this.calls += 1;
        return { status: 'not_found' as const };
      }
      async deleteEvent(): Promise<void> { this.calls += 1; }
    }
    for (let index = 0; index < 55; index += 1) {
      const startMs = Date.parse('2026-05-04T00:00:00.000Z') + index * 2 * 60 * 60_000;
      submitSecretarySchedulingIntent(intent({
        intentId: `bounded-provider-sync-${index}`,
        sourceEntityId: `session-bounded-provider-sync-${index}`,
        // Every fixture is independently schedulable, so each claimed row
        // reaches exactly one provider effect and proves the cap is applied
        // by the query rather than after side effects.
        preferredWindows: [timeWindow(
          new Date(startMs).toISOString(),
          new Date(startMs + 60 * 60_000).toISOString(),
        )],
      }));
    }
    const provider = new CountEveryCallProvider();

    const results = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 50 });

    // Discovery and create each consume one slot. The stronger guarantee now
    // keeps the 25 completed rows plus one explicit deferred outcome, rather
    // than silently dropping the first claim that cannot start under the cap.
    expect(results).toHaveLength(26);
    expect(results.at(-1)).toMatchObject({
      action: 'failed',
      reasonCode: 'provider_call_budget_deferred',
    });
    expect(provider.calls).toBe(50);
  });

  it('serializes a live claim across versions of the same logical intent', async () => {
    let releaseCreate!: () => void;
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => { reportStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseCreate = resolve; });
    class BlockingProvider extends MockSecretaryProvider {
      override async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        reportStarted();
        await release;
        return super.createEvent(input);
      }
    }
    const first = submitSecretarySchedulingIntent(intent({ intentId: 'logical-live-claim' }));
    const firstRun = syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, new BlockingProvider(), { maxItems: 50, leaseDurationMs: 60_000 });
    await started;

    const second = submitSecretarySchedulingIntent(intent({
      intentId: 'logical-live-claim',
      title: 'New authoritative shape',
      preferredWindows: [timeWindow('2026-05-05T09:00:00.000Z', '2026-05-05T11:00:00.000Z')],
    }));
    const competingProvider = new MockSecretaryProvider();
    const competing = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, competingProvider, { maxItems: 50, leaseDurationMs: 60_000 });

    expect(second.agendaItem.version).toBe(first.agendaItem.version + 1);
    expect(competing).toEqual([]);
    expect(competingProvider.createAttempts).toBe(0);
    releaseCreate();
    await expect(firstRun).rejects.toThrow('SECRETARY_PROVIDER_SYNC_LEASE_LOST');
  });

  it('persists an attempt-scoped in-flight fence before the provider create starts', async () => {
    let releaseCreate!: () => void;
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => { reportStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseCreate = resolve; });
    class BlockingProvider extends MockSecretaryProvider {
      override async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        reportStarted();
        await release;
        return super.createEvent(input);
      }
    }
    const decision = submitSecretarySchedulingIntent(intent({ intentId: 'pre-effect-create-attempt' }));
    const pending = syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, new BlockingProvider(), { maxItems: 2, retryBudget: 0 });
    await started;

    // Stronger guarantee: a process can die at any instruction after the
    // provider accepts the request and the replacement worker must still see
    // a durable no-create fence for this exact external attempt.
    const preEffect = testDb.prepare(`
      SELECT attempt_id, agenda_item_id, resolution_state
        FROM secretary_agenda_provider_create_reconciliation
       WHERE owner_user_id = ? AND tenant_id = ? AND provider_source = 'google'
         AND source_skill = 'training' AND source_intent_id = ?
    `).get(OWNER_USER_ID, TENANT_ID, 'pre-effect-create-attempt') as {
      attempt_id?: string;
      agenda_item_id?: string;
      resolution_state?: string;
    } | undefined;
    expect(preEffect).toMatchObject({
      agenda_item_id: decision.agendaItem.agendaItemId,
      resolution_state: 'in_flight',
    });
    expect(preEffect?.attempt_id).toBeTruthy();

    releaseCreate();
    await expect(pending).resolves.toHaveLength(1);
  });

  it('does not call the provider when the pre-effect attempt fence cannot be persisted', async () => {
    testDb.exec(`
      CREATE TRIGGER test_fail_pre_effect_attempt_insert
      BEFORE INSERT ON secretary_agenda_provider_create_reconciliation
      BEGIN
        SELECT RAISE(FAIL, 'injected pre-effect attempt failure');
      END;
    `);
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'pre-effect-attempt-insert-failure',
    }));

    const outcome = await syncOne(decision.agendaItem.agendaItemId, provider);

    // Stronger guarantee: local durability is a prerequisite for the
    // external create, so an unavailable ledger cannot leak an orphan event.
    expect(outcome).toMatchObject({ action: 'failed', providerSyncState: 'create_failed' });
    expect(provider.createAttempts).toBe(0);
    expect(provider.events.size).toBe(0);
  });

  it('atomically rejects a pre-effect attempt insert after the claim is stolen', async () => {
    const provider = new MockSecretaryProvider();
    submitSecretarySchedulingIntent(intent({ intentId: 'pre-effect-stolen-claim' }));
    const nativePrepare = testDb.prepare.bind(testDb);
    let interceptedAttemptInsert = false;
    const prepareSpy = vi.spyOn(testDb, 'prepare').mockImplementation(((sql: string) => {
      const statement = nativePrepare(sql);
      if (
        interceptedAttemptInsert
        || !sql.includes('INSERT INTO secretary_agenda_provider_create_reconciliation')
      ) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === 'run') {
            return (...params: unknown[]) => {
              interceptedAttemptInsert = true;
              nativePrepare(`
                UPDATE secretary_agenda_provider_sync_claims
                   SET lease_token = 'replacement-owner-token',
                       lease_expires_at = '2099-01-01T00:00:00.000Z'
                 WHERE source_intent_id = 'pre-effect-stolen-claim'
              `).run();
              return Reflect.apply(target.run, target, params);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof testDb.prepare);

    try {
      await expect(syncSecretaryAgendaItemsToProvider({
        ownerUserId: OWNER_USER_ID,
        tenantId: TENANT_ID,
        includeInactive: false,
      }, provider, { maxItems: 4, retryBudget: 0 })).rejects.toThrow(
        'SECRETARY_PROVIDER_SYNC_LEASE_LOST',
      );
    } finally {
      prepareSpy.mockRestore();
    }

    // Stronger guarantee: claim ownership is checked by the same SQLite
    // statement that establishes the durable pre-effect fence. A stale
    // worker cannot create after a replacement has acquired the logical row.
    expect(interceptedAttemptInsert).toBe(true);
    expect(provider.createAttempts).toBe(0);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM secretary_agenda_provider_create_reconciliation
       WHERE source_intent_id = ?
    `).get('pre-effect-stolen-claim')).toEqual({ count: 0 });
  });

  it('keeps the pre-effect fence when the exact-id recovery handoff insert fails', async () => {
    class HiddenProvider extends MockSecretaryProvider {
      override async findEventsByAgendaItemId(agendaItemId: string): Promise<SecretaryProviderEvent[]> {
        this.findAgendaItemIds.push(agendaItemId);
        return [];
      }
    }
    testDb.exec(`
      CREATE TRIGGER test_fail_known_create_recovery_insert
      BEFORE INSERT ON secretary_agenda_provider_effect_recovery
      BEGIN
        SELECT RAISE(FAIL, 'injected exact-id handoff failure');
      END;
    `);
    const provider = new HiddenProvider();
    submitSecretarySchedulingIntent(intent({ intentId: 'known-handoff-insert-failure' }));

    const first = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 4, retryBudget: 0 });
    const second = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 4, retryBudget: 0 });

    expect(first[0]).toMatchObject({
      action: 'failed',
      providerSyncState: 'readback_failed',
      reasonCode: 'provider_create_reconciliation_required',
    });
    expect(second[0]).toMatchObject({ reasonCode: 'provider_create_reconciliation_required' });
    expect(provider.createAttempts).toBe(1);
    const fence = testDb.prepare(`
      SELECT resolution_state
        FROM secretary_agenda_provider_create_reconciliation
       WHERE source_intent_id = ?
    `).get('known-handoff-insert-failure') as { resolution_state?: string } | undefined;
    expect(fence?.resolution_state).toBe('in_flight');
  });

  it('keeps recovery ids independent when two tenant calendars return the same provider-local id', () => {
    const insert = testDb.prepare(`
      INSERT INTO secretary_agenda_provider_effect_recovery (
        recovery_id, owner_user_id, tenant_id, provider_source, source_skill,
        source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
        provider_event_id, effect_kind, resolution_state, created_at, updated_at
      ) VALUES (?, ?, ?, 'outlook', 'training', ?, ?, 1, ?, ?, 'create', 'pending', ?, ?)
    `);
    const nowIso = '2026-08-03T09:00:00.000Z';
    insert.run('recovery-tenant-a', 101, 'tenant-a', 'intent-a', 'agenda-a', 'fp-a', 'mailbox-local-id', nowIso, nowIso);

    expect(() => insert.run(
      'recovery-tenant-b',
      202,
      'tenant-b',
      'intent-b',
      'agenda-b',
      'fp-b',
      'mailbox-local-id',
      nowIso,
      nowIso,
    )).not.toThrow();
    const rows = testDb.prepare(`
      SELECT owner_user_id, tenant_id
        FROM secretary_agenda_provider_effect_recovery
       WHERE provider_source = 'outlook' AND provider_event_id = 'mailbox-local-id'
       ORDER BY owner_user_id
    `).all();
    expect(rows).toEqual([
      { owner_user_id: 101, tenant_id: 'tenant-a' },
      { owner_user_id: 202, tenant_id: 'tenant-b' },
    ]);
  });

  it('retains every mixed-version ambiguous attempt and stays read-only until every marker is visible', async () => {
    class SelectivelyHiddenProvider extends MockSecretaryProvider {
      hiddenAgendaItemIds = new Set<string>();
      override async findEventsByAgendaItemId(agendaItemId: string): Promise<SecretaryProviderEvent[]> {
        this.findAgendaItemIds.push(agendaItemId);
        if (this.hiddenAgendaItemIds.has(agendaItemId)) return [];
        return [...this.events.values()].filter((event) => event.agendaItemId === agendaItemId);
      }
    }
    const first = submitSecretarySchedulingIntent(intent({ intentId: 'multi-attempt-reconciliation' }));
    const second = submitSecretarySchedulingIntent(intent({
      intentId: 'multi-attempt-reconciliation',
      title: 'Authoritative v2 attempt',
      preferredWindows: [timeWindow('2026-05-07T09:00:00.000Z', '2026-05-07T11:00:00.000Z')],
    }));
    const nowIso = '2026-08-03T09:00:00.000Z';
    const insertAttempt = testDb.prepare(`
      INSERT INTO secretary_agenda_provider_create_reconciliation (
        attempt_id, owner_user_id, tenant_id, provider_source, source_skill,
        source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
        provider_event_id, resolution_state, first_observed_at,
        last_checked_at, resolved_at, updated_at
      ) VALUES (?, ?, ?, 'google', 'training', ?, ?, ?, ?, NULL, 'unknown', ?, NULL, NULL, ?)
    `);
    insertAttempt.run(
      'attempt-v1', OWNER_USER_ID, TENANT_ID, 'multi-attempt-reconciliation',
      first.agendaItem.agendaItemId, first.agendaItem.version, 'fp-v1', nowIso, nowIso,
    );
    insertAttempt.run(
      'attempt-v2', OWNER_USER_ID, TENANT_ID, 'multi-attempt-reconciliation',
      second.agendaItem.agendaItemId, second.agendaItem.version, 'fp-v2', nowIso, nowIso,
    );
    const provider = new SelectivelyHiddenProvider();
    provider.seedEvent(providerInputFor(first.agendaItem.agendaItemId), 'event-v1');
    provider.seedEvent(providerInputFor(second.agendaItem.agendaItemId), 'event-v2');
    provider.hiddenAgendaItemIds.add(first.agendaItem.agendaItemId);

    const hidden = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 10, retryBudget: 0 });
    expect(hidden[0]).toMatchObject({
      action: 'failed',
      reasonCode: 'provider_create_reconciliation_required',
    });
    expect(provider.createAttempts).toBe(0);
    expect(provider.updateInputs).toHaveLength(0);
    expect(provider.deletedEventIds).toEqual([]);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM secretary_agenda_provider_create_reconciliation
       WHERE source_intent_id = ? AND resolution_state IN ('in_flight', 'unknown', 'known')
    `).get('multi-attempt-reconciliation')).toEqual({ count: 2 });

    provider.hiddenAgendaItemIds.clear();
    const reconciled = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 10, retryBudget: 0 });
    expect(reconciled[0]).toMatchObject({ action: 'attached', providerSyncState: 'synced' });
    expect(provider.createAttempts).toBe(0);
    expect(provider.events.size).toBe(1);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM secretary_agenda_provider_create_reconciliation
       WHERE source_intent_id = ? AND resolution_state IN ('in_flight', 'unknown', 'known')
    `).get('multi-attempt-reconciliation')).toEqual({ count: 0 });
  });

  it('recovers after duplicate deletion succeeds but the atomic mapping write fails', async () => {
    const first = submitSecretarySchedulingIntent(intent({ intentId: 'dedupe-mapping-failure' }));
    const second = submitSecretarySchedulingIntent(intent({
      intentId: 'dedupe-mapping-failure',
      title: 'Authoritative v2 after failed mapping',
      preferredWindows: [timeWindow('2026-05-08T09:00:00.000Z', '2026-05-08T11:00:00.000Z')],
    }));
    const nowIso = '2026-08-03T09:00:00.000Z';
    const insertAttempt = testDb.prepare(`
      INSERT INTO secretary_agenda_provider_create_reconciliation (
        attempt_id, owner_user_id, tenant_id, provider_source, source_skill,
        source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
        provider_event_id, resolution_state, first_observed_at,
        last_checked_at, resolved_at, updated_at
      ) VALUES (?, ?, ?, 'google', 'training', ?, ?, ?, ?, NULL, 'unknown', ?, NULL, NULL, ?)
    `);
    insertAttempt.run(
      'dedupe-failure-v1', OWNER_USER_ID, TENANT_ID, 'dedupe-mapping-failure',
      first.agendaItem.agendaItemId, first.agendaItem.version, 'fp-v1', nowIso, nowIso,
    );
    insertAttempt.run(
      'dedupe-failure-v2', OWNER_USER_ID, TENANT_ID, 'dedupe-mapping-failure',
      second.agendaItem.agendaItemId, second.agendaItem.version, 'fp-v2', nowIso, nowIso,
    );
    const provider = new MockSecretaryProvider();
    provider.seedEvent(providerInputFor(first.agendaItem.agendaItemId), 'dedupe-event-v1');
    provider.seedEvent(providerInputFor(second.agendaItem.agendaItemId), 'dedupe-event-v2');
    testDb.exec(`
      CREATE TRIGGER test_fail_reconciled_mapping_write
      BEFORE UPDATE OF provider_sync_state ON secretary_agenda_items
      WHEN NEW.source_intent_id = 'dedupe-mapping-failure'
       AND NEW.provider_sync_state = 'synced'
      BEGIN
        SELECT RAISE(FAIL, 'injected reconciled mapping failure');
      END;
    `);

    await expect(syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 10, retryBudget: 0 })).rejects.toThrow(
      'injected reconciled mapping failure',
    );
    expect(provider.events.has('dedupe-event-v1')).toBe(false);
    expect(provider.events.has('dedupe-event-v2')).toBe(true);
    expect(provider.createAttempts).toBe(0);
    expect(testDb.prepare(`
      SELECT attempt_id, provider_event_id
        FROM secretary_agenda_provider_create_reconciliation
       WHERE source_intent_id = ?
       ORDER BY attempt_id
    `).all('dedupe-mapping-failure')).toEqual([
      { attempt_id: 'dedupe-failure-v1', provider_event_id: 'dedupe-event-v1' },
      { attempt_id: 'dedupe-failure-v2', provider_event_id: 'dedupe-event-v2' },
    ]);

    testDb.exec('DROP TRIGGER test_fail_reconciled_mapping_write');
    const recovered = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 10, retryBudget: 0 });

    // Stronger guarantee: exact IDs observed before mutation survive a local
    // commit failure, so retry can idempotently finish without another create.
    expect(recovered[0]).toMatchObject({
      action: 'attached',
      providerEventId: 'dedupe-event-v2',
      providerSyncState: 'synced',
    });
    expect(provider.events.size).toBe(1);
    expect(provider.createAttempts).toBe(0);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM secretary_agenda_provider_create_reconciliation
       WHERE source_intent_id = ? AND resolution_state IN ('in_flight', 'unknown', 'known')
    `).get('dedupe-mapping-failure')).toEqual({ count: 0 });
  });

  it('keeps a canceled unknown create eligible and deletes its observed provider event', async () => {
    class InsertThenTimeoutProvider extends MockSecretaryProvider {
      override async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        await super.createEvent(input);
        throw Object.assign(new Error('timeout after accepted create'), { code: 'ETIMEDOUT' });
      }
    }
    const provider = new InsertThenTimeoutProvider();
    const decision = submitSecretarySchedulingIntent(intent({ intentId: 'cancel-ambiguous-create' }));
    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 4, retryBudget: 0 });
    expect(provider.events.size).toBe(1);
    cancelSecretaryAgendaItem({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'user canceled ambiguous event',
      now: '2026-08-03T09:05:00.000Z',
    });

    const cleanup = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 4, retryBudget: 0 });
    expect(cleanup[0]).toMatchObject({ action: 'deleted', providerSyncState: 'deleted' });
    expect(provider.events.size).toBe(0);
    expect(testDb.prepare(`
      SELECT resolution_state
        FROM secretary_agenda_provider_create_reconciliation
       WHERE source_intent_id = ?
    `).get('cancel-ambiguous-create')).toEqual({ resolution_state: 'deleted' });
  });

  it('keeps a canceled hidden unknown create eligible without issuing another create', async () => {
    class HiddenInsertThenTimeoutProvider extends MockSecretaryProvider {
      override async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        await super.createEvent(input);
        throw Object.assign(new Error('timeout after accepted hidden create'), { code: 'ETIMEDOUT' });
      }
      override async findEventsByAgendaItemId(agendaItemId: string): Promise<SecretaryProviderEvent[]> {
        this.findAgendaItemIds.push(agendaItemId);
        return [];
      }
    }
    const provider = new HiddenInsertThenTimeoutProvider();
    const decision = submitSecretarySchedulingIntent(intent({ intentId: 'cancel-hidden-ambiguous-create' }));
    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 4, retryBudget: 0 });
    cancelSecretaryAgendaItem({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'user canceled hidden ambiguous event',
      now: '2026-08-03T09:05:00.000Z',
    });

    for (let tick = 0; tick < 2; tick += 1) {
      const cleanup = await syncSecretaryAgendaItemsToProvider({
        ownerUserId: OWNER_USER_ID,
        tenantId: TENANT_ID,
        includeInactive: false,
      }, provider, { maxItems: 4, retryBudget: 0 });
      expect(cleanup[0]).toMatchObject({
        action: 'failed',
        reasonCode: 'provider_create_reconciliation_required',
      });
    }

    // Stronger guarantee: terminal local lifecycle never hides unresolved
    // external ambiguity, and eventual-consistency readback never auto-creates.
    expect(provider.createAttempts).toBe(1);
    expect(provider.events.size).toBe(1);
    expect(testDb.prepare(`
      SELECT lifecycle_state, resolution_state
        FROM secretary_agenda_items AS agenda
        JOIN secretary_agenda_provider_create_reconciliation AS attempt
          ON attempt.source_intent_id = agenda.source_intent_id
       WHERE agenda.agenda_item_id = ?
    `).get(decision.agendaItem.agendaItemId)).toEqual({
      lifecycle_state: 'canceled',
      resolution_state: 'unknown',
    });
  });

  it('returns the last truthful failure when a retry consumes the final call-budget slot', async () => {
    let failingAgendaItemId = '';
    class CountedProvider extends MockSecretaryProvider {
      calls = 0;
      override async findEventsByAgendaItemId(agendaItemId: string): Promise<SecretaryProviderEvent[]> {
        this.calls += 1;
        return super.findEventsByAgendaItemId(agendaItemId);
      }
      override async getEvent(eventId: string) {
        this.calls += 1;
        return super.getEvent(eventId);
      }
      override async updateEvent(eventId: string, input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        this.calls += 1;
        return super.updateEvent(eventId, input);
      }
      override async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        this.calls += 1;
        if (input.agendaItemId === failingAgendaItemId) {
          this.createAttempts += 1;
          throw Object.assign(new Error('known no-effect refusal'), { code: 'PROVIDER_VALIDATION_FAILED' });
        }
        return super.createEvent(input);
      }
    }
    const existing = submitSecretarySchedulingIntent(intent({
      intentId: 'budget-existing-three-calls',
      preferredWindows: [timeWindow('2026-05-01T09:00:00.000Z', '2026-05-01T11:00:00.000Z')],
    }));
    const failing = submitSecretarySchedulingIntent(intent({
      intentId: 'budget-last-truthful-failure',
      preferredWindows: [timeWindow('2026-05-02T09:00:00.000Z', '2026-05-02T11:00:00.000Z')],
    }));
    failingAgendaItemId = failing.agendaItem.agendaItemId;
    const provider = new CountedProvider();
    const existingEvent = provider.seedEvent(providerInputFor(existing.agendaItem.agendaItemId), 'existing-budget-event');
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET provider_event_id = ?, provider_source = 'google', provider_sync_state = 'synced',
             lifecycle_state = 'synced', last_synced_verified_at = '2000-01-01T00:00:00.000Z'
       WHERE agenda_item_id = ?
    `).run(existingEvent.eventId, existing.agendaItem.agendaItemId);

    const results = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 6, retryBudget: 2, baseBackoffMs: 0 });
    // Stronger guarantee: explicit provider validation refusal is terminal,
    // so the sync engine preserves the first truthful failure without
    // spending a sixth provider call on a guaranteed duplicate refusal.
    expect(provider.calls).toBe(5);
    expect(provider.createAttempts).toBe(1);
    expect(results.some((entry) => (
      entry.agendaItemId === failingAgendaItemId && entry.action === 'failed'
    ))).toBe(true);
  });

  it('defers a poisoned over-budget row and continues later claims without exceeding the cap', async () => {
    let poisonedAgendaItemId = '';
    class PoisonedProvider implements SecretaryAgendaProviderAdapter {
      source = 'google' as const;
      calls = 0;
      createdAgendaItemIds: string[] = [];
      async findEventsByAgendaItemId(agendaItemId: string): Promise<SecretaryProviderEvent[]> {
        this.calls += 1;
        if (agendaItemId !== poisonedAgendaItemId) return [];
        return Array.from({ length: 50 }, (_, index) => ({
          eventId: `poison-${index.toString().padStart(2, '0')}`,
          source: this.source,
          agendaItemId,
        }));
      }
      async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        this.calls += 1;
        this.createdAgendaItemIds.push(input.agendaItemId);
        return { eventId: `created-${input.agendaItemId}`, source: this.source, agendaItemId: input.agendaItemId };
      }
      async updateEvent(eventId: string, input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        this.calls += 1;
        return { eventId, source: this.source, agendaItemId: input.agendaItemId };
      }
      async deleteEvent(): Promise<void> { this.calls += 1; }
    }
    const poisoned = submitSecretarySchedulingIntent(intent({
      intentId: 'poisoned-provider-row',
      preferredWindows: [timeWindow('2026-05-01T09:00:00.000Z', '2026-05-01T11:00:00.000Z')],
    }));
    const healthy = submitSecretarySchedulingIntent(intent({
      intentId: 'healthy-after-poisoned-row',
      preferredWindows: [timeWindow('2026-05-02T09:00:00.000Z', '2026-05-02T11:00:00.000Z')],
    }));
    poisonedAgendaItemId = poisoned.agendaItem.agendaItemId;
    const provider = new PoisonedProvider();

    const results = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 50, retryBudget: 0 });
    expect(provider.calls).toBeLessThanOrEqual(50);
    expect(results).toContainEqual(expect.objectContaining({
      agendaItemId: poisoned.agendaItem.agendaItemId,
      action: 'failed',
      reasonCode: 'provider_call_budget_deferred',
    }));
    expect(provider.createdAgendaItemIds).toContain(healthy.agendaItem.agendaItemId);
  });

  it('compensates a stale known-success create after logical authority moves', async () => {
    let releaseFirst!: () => void;
    let reportEffect!: () => void;
    const effect = new Promise<void>((resolve) => { reportEffect = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    class EffectThenBlockProvider extends MockSecretaryProvider {
      override async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        const created = await super.createEvent(input);
        if (input.version === 1) {
          reportEffect();
          await release;
        }
        return created;
      }
    }
    const provider = new EffectThenBlockProvider();
    const first = submitSecretarySchedulingIntent(intent({ intentId: 'logical-stale-create' }));
    const stale = syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 50, leaseDurationMs: 60_000, heartbeatIntervalMs: 60_000 });
    await effect;
    const second = submitSecretarySchedulingIntent(intent({
      intentId: 'logical-stale-create',
      title: 'Authoritative v2',
      preferredWindows: [timeWindow('2026-05-06T09:00:00.000Z', '2026-05-06T11:00:00.000Z')],
    }));
    testDb.prepare(`
      UPDATE secretary_agenda_provider_sync_claims
         SET lease_expires_at = '2000-01-01T00:00:00.000Z'
       WHERE owner_user_id = ? AND tenant_id = ? AND provider_source = 'google'
    `).run(OWNER_USER_ID, TENANT_ID);
    const current = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 50, leaseDurationMs: 60_000 });
    expect(current.some((entry) => entry.agendaItemId === second.agendaItem.agendaItemId)).toBe(true);

    releaseFirst();
    await expect(stale).rejects.toThrow('SECRETARY_PROVIDER_SYNC_LEASE_LOST');
    const stored = getSecretaryAgendaItemById({
      agendaItemId: second.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    expect(provider.events.size).toBe(1);
    expect([...provider.events.keys()]).toEqual([stored?.providerEventId]);
    expect([...provider.events.values()][0]?.version).toBe(2);
  });

  it('durably records and compensates a known create when the mapping transaction fails', async () => {
    testDb.exec(`
      CREATE TABLE test_provider_mapping_fault (enabled INTEGER NOT NULL);
      INSERT INTO test_provider_mapping_fault VALUES (1);
      CREATE TRIGGER test_fail_provider_mapping
      BEFORE UPDATE OF provider_sync_state ON secretary_agenda_items
      WHEN NEW.provider_sync_state = 'synced'
       AND (SELECT enabled FROM test_provider_mapping_fault LIMIT 1) = 1
      BEGIN
        SELECT RAISE(FAIL, 'injected provider mapping failure');
      END;
    `);
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({ intentId: 'known-create-db-failure' }));

    const first = await syncOne(decision.agendaItem.agendaItemId, provider);
    const recovery = testDb.prepare(`
      SELECT provider_event_id, resolution_state
        FROM secretary_agenda_provider_effect_recovery
       WHERE source_intent_id = ? AND provider_source = 'google'
    `).get('known-create-db-failure') as { provider_event_id: string; resolution_state: string };

    expect(first.action).toBe('failed');
    expect(recovery.provider_event_id).toBeTruthy();
    expect(['pending', 'deleted']).toContain(recovery.resolution_state);
    expect(provider.events.size).toBe(recovery.resolution_state === 'deleted' ? 0 : 1);
    testDb.prepare('UPDATE test_provider_mapping_fault SET enabled = 0').run();
    await syncOne(decision.agendaItem.agendaItemId, provider);
    expect(provider.events.size).toBe(1);
  });

  it('writes the provider mapping and synced fingerprint atomically', async () => {
    testDb.exec(`
      CREATE TRIGGER test_require_atomic_provider_fingerprint
      BEFORE UPDATE OF provider_sync_state ON secretary_agenda_items
      WHEN NEW.provider_sync_state = 'synced'
       AND (NEW.last_synced_fingerprint IS NULL OR NEW.last_synced_verified_at IS NULL)
      BEGIN
        SELECT RAISE(FAIL, 'mapping without fingerprint');
      END;
    `);
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({ intentId: 'atomic-provider-success' }));
    const synced = await syncOne(decision.agendaItem.agendaItemId, provider);
    expect(synced.action).toBe('created');
  });

  it('fences the mapping write when desired shape changes after its pre-write assertion', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({ intentId: 'shape-race-at-write' }));
    const originalPrepare = testDb.prepare.bind(testDb);
    let pendingClaimAssertions = 0;
    const prepareSpy = vi.spyOn(testDb, 'prepare').mockImplementation(((sql: string) => {
      const statement = originalPrepare(sql);
      if (
        sql.includes('FROM secretary_agenda_provider_sync_claims AS claim')
        && sql.includes('JOIN secretary_agenda_items AS agenda')
      ) {
        const originalGet = statement.get.bind(statement);
        (statement as any).get = (...params: unknown[]) => {
          const value = originalGet(...params as any[]);
          const pending = originalPrepare(`
            SELECT COUNT(*) AS count
              FROM secretary_agenda_provider_effect_recovery
             WHERE resolution_state = 'pending'
          `).get() as { count: number };
          if (pending.count > 0) {
            pendingClaimAssertions += 1;
            // First pending assertion is createProviderEventWithRecovery's
            // post-effect check. Mutate immediately after mark-success's own
            // pre-write check so only the UPDATE's in-statement fingerprint
            // fence can stop the stale local mapping.
            if (pendingClaimAssertions === 2) {
              originalPrepare(`
                UPDATE secretary_agenda_items
                   SET source_shape_hash = 'shape_changed_between_assert_and_write'
                 WHERE agenda_item_id = ?
              `).run(decision.agendaItem.agendaItemId);
            }
          }
          return value;
        };
      }
      return statement;
    }) as any);

    try {
      await expect(syncSecretaryAgendaItemsToProvider({
        ownerUserId: OWNER_USER_ID,
        tenantId: TENANT_ID,
        includeInactive: false,
      }, provider, { maxItems: 50 })).rejects.toThrow('SECRETARY_PROVIDER_SYNC_LEASE_LOST');
      expect(provider.events.size).toBe(0);
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('paginates past a failed first batch so newer eligible rows cannot starve', async () => {
    class AlwaysFailCreateProvider extends MockSecretaryProvider {
      override async createEvent(): Promise<SecretaryProviderEvent> {
        this.createAttempts += 1;
        throw Object.assign(new Error('simulated known-no-effect refusal'), {
          code: 'PROVIDER_VALIDATION_FAILED',
        });
      }
    }
    const agendaItemIds: string[] = [];
    for (let index = 0; index < 55; index += 1) {
      const startMs = Date.parse('2026-06-01T00:00:00.000Z') + index * 2 * 60 * 60_000;
      const decision = submitSecretarySchedulingIntent(intent({
        intentId: `provider-pagination-${index}`,
        sourceEntityId: `session-provider-pagination-${index}`,
        preferredWindows: [timeWindow(
          new Date(startMs).toISOString(),
          new Date(startMs + 60 * 60_000).toISOString(),
        )],
      }));
      agendaItemIds.push(decision.agendaItem.agendaItemId);
    }

    const first = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, new AlwaysFailCreateProvider(), { maxItems: 50, retryBudget: 0 });
    // A failed create still consumes discovery + create. The stronger budget
    // contract preserves 25 truthful failures plus the next claim's explicit
    // deferred result instead of dropping it at the boundary.
    expect(first).toHaveLength(26);
    expect(first.every((entry) => entry.action === 'failed')).toBe(true);

    const recoveredProvider = new MockSecretaryProvider();
    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, recoveredProvider, { maxItems: 50, retryBudget: 0 });

    // Stronger pagination guarantee: rows never attempted are prioritized
    // ahead of a failed page, while failed rows still rotate by updated_at.
    const recoveredIds = new Set(recoveredProvider.createInputs.map((input) => input.agendaItemId));
    expect(agendaItemIds.slice(25, 50).every((agendaItemId) => recoveredIds.has(agendaItemId))).toBe(true);
  });

  it('publishes backlog, attempt, outcome, and dead-letter metrics for each bounded batch', async () => {
    const provider = new MockSecretaryProvider();
    submitSecretarySchedulingIntent(intent({
      intentId: 'provider-sync-metrics',
      sourceEntityId: 'session-provider-sync-metrics',
    }));
    const resetMetrics = (secretaryAgendaProviderSyncModule as any)
      ._resetSecretaryAgendaProviderSyncMetricsForTests;
    const getMetrics = (secretaryAgendaProviderSyncModule as any)
      .getSecretaryAgendaProviderSyncMetricsSnapshot;
    expect(resetMetrics).toBeTypeOf('function');
    expect(getMetrics).toBeTypeOf('function');
    resetMetrics();

    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 50 });
    const metrics = getMetrics();

    expect(metrics).toMatchObject({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      deadLetter: 0,
    });
    expect(metrics.backlogOldestAgeMs).toBeGreaterThanOrEqual(0);
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

  it('fails a bulk scope truthfully when cleanup dead-letter backlog remains', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'bulk-dead-letter-truth',
      sourceEntityId: 'session-bulk-dead-letter-truth',
    }));
    const created = await syncOne(decision.agendaItem.agendaItemId, provider);
    cancelSecretaryAgendaItem({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'training_plan_canceled',
      now: '2026-05-01T10:00:00.000Z',
    });
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET provider_sync_state = 'delete_failed',
             provider_sync_failure_count = 5
       WHERE agenda_item_id = ?
    `).run(decision.agendaItem.agendaItemId);
    const deleteCallsBeforeBulk = provider.deletedEventIds.length;
    const resetMetrics = (secretaryAgendaProviderSyncModule as any)
      ._resetSecretaryAgendaProviderSyncMetricsForTests;
    const getMetrics = (secretaryAgendaProviderSyncModule as any)
      .getSecretaryAgendaProviderSyncMetricsSnapshot;
    resetMetrics();

    await expect(syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider)).rejects.toMatchObject({
      code: 'SECRETARY_PROVIDER_SYNC_DEAD_LETTER_BACKLOG',
      deadLetterCount: 1,
    });

    expect(provider.deletedEventIds).toHaveLength(deleteCallsBeforeBulk);
    expect(getMetrics()).toMatchObject({ deadLetter: 1, attempted: 0 });
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    expect(stored?.providerEventId).toBe(created.providerEventId);
    expect(stored?.providerSyncState).toBe('delete_failed');
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

  it('does not recreate after a timeout with an unknown provider outcome and attaches on marker readback', async () => {
    class InsertThenTimeoutProvider extends MockSecretaryProvider {
      override async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        const created = await super.createEvent(input);
        throw Object.assign(new Error('socket timed out after send'), {
          code: 'ETIMEDOUT',
          createdEventId: created.eventId,
        });
      }
    }
    const provider = new InsertThenTimeoutProvider();
    const decision = submitSecretarySchedulingIntent(intent({ intentId: 'unknown-create-visible' }));

    const first = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 50, retryBudget: 2, baseBackoffMs: 0 });
    expect(first[0]).toMatchObject({
      action: 'failed',
      providerSyncState: 'readback_failed',
      reasonCode: 'provider_create_reconciliation_required',
    });
    expect(provider.createAttempts).toBe(1);

    const second = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 50, retryBudget: 2, baseBackoffMs: 0 });
    expect(second[0]).toMatchObject({ action: 'attached', providerSyncState: 'synced' });
    expect(provider.createAttempts).toBe(1);
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    expect(provider.events.size).toBe(1);
    expect(stored?.providerEventId).toBe([...provider.events.keys()][0]);
  });

  it('keeps an unresolved unknown create read-only across hidden readback ticks', async () => {
    class HiddenInsertThenResetProvider extends MockSecretaryProvider {
      hideMarkers = true;
      override async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        await super.createEvent(input);
        throw Object.assign(new Error('connection reset after send'), { code: 'ECONNRESET' });
      }
      override async findEventsByAgendaItemId(agendaItemId: string): Promise<SecretaryProviderEvent[]> {
        this.findAgendaItemIds.push(agendaItemId);
        return this.hideMarkers ? [] : super.findEventsByAgendaItemId(agendaItemId);
      }
    }
    const provider = new HiddenInsertThenResetProvider();
    submitSecretarySchedulingIntent(intent({ intentId: 'unknown-create-hidden' }));

    for (let tick = 0; tick < 3; tick += 1) {
      const results = await syncSecretaryAgendaItemsToProvider({
        ownerUserId: OWNER_USER_ID,
        tenantId: TENANT_ID,
        includeInactive: false,
      }, provider, { maxItems: 50, retryBudget: 2, baseBackoffMs: 0 });
      expect(results[0]).toMatchObject({
        providerSyncState: 'readback_failed',
        reasonCode: 'provider_create_reconciliation_required',
      });
    }
    expect(provider.createAttempts).toBe(1);
    expect(provider.events.size).toBe(1);
  });

  it('bulk sync uses an explicit retry budget and honors Retry-After for transient failures', async () => {
    const provider = new MockSecretaryProvider();
    provider.createFailuresRemaining = 1;
    provider.createFailureFactory = () => ({
      // HTTP 429 is a known-no-effect refusal: unlike a timeout/reset or a
      // 5xx-after-send, retrying cannot duplicate an accepted create.
      // Microsoft Graph errors surface `statusCode`, not `status`.
      statusCode: 429,
      response: {
        status: 429,
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

  it('treats an Outlook statusCode 400 create refusal as terminal known-no-effect', async () => {
    const provider = new MockSecretaryProvider();
    provider.createFailuresRemaining = 2;
    provider.createFailureFactory = () => Object.assign(new Error('invalid Graph request'), {
      statusCode: 400,
      code: 'ErrorInvalidRequest',
    });
    submitSecretarySchedulingIntent(intent({
      intentId: 'outlook-terminal-create-refusal',
      sourceEntityId: 'session-outlook-terminal-create-refusal',
    }));

    const first = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 10, retryBudget: 2, baseBackoffMs: 0 });
    const second = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    }, provider, { maxItems: 10, retryBudget: 2, baseBackoffMs: 0 });

    expect(first[0]).toMatchObject({
      action: 'failed',
      providerSyncState: 'create_failed',
      reasonCode: 'provider_create_terminal_rejection',
    });
    expect(second).toEqual([]);
    expect(provider.createAttempts).toBe(1);
    expect(testDb.prepare(`
      SELECT resolution_state
        FROM secretary_agenda_provider_create_reconciliation
       WHERE source_intent_id = ?
    `).get('outlook-terminal-create-refusal')).toEqual({ resolution_state: 'no_effect' });
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

  it('fails closed for a foreign-tenant Training session id when ownership tables exist', async () => {
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
      VALUES (9101, ${OWNER_USER_ID}, 'foreign-tenant', 'active');
      INSERT INTO training_sessions (id, plan_id, status)
      VALUES (777, 9101, 'unscheduled');
    `);
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'foreign-tenant-session-id',
      sourceEntityId: '777',
      sourceEntityType: 'training_session',
    }));
    const created = await syncOne(decision.agendaItem.agendaItemId, provider);
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'failed_sync',
             provider_sync_state = 'readback_failed',
             last_synced_verified_at = '2000-01-01T00:00:00.000Z'
       WHERE agenda_item_id = ?
    `).run(decision.agendaItem.agendaItemId);

    const repaired = await syncOne(decision.agendaItem.agendaItemId, provider);
    expect(repaired.action).toBe('updated');
    expect(provider.deletedEventIds).not.toContain(created.providerEventId);
    expect(provider.events.has(created.providerEventId!)).toBe(true);
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

  it('skips provider writes for an unchanged synced item without duplicates', async () => {
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
    // Stronger durability guarantee: a fresh fingerprint makes zero provider
    // calls, including marker scans. Drift repair resumes after the bounded
    // verification window instead of spending quota every cron tick.
    expect(provider.findAgendaItemIds.length).toBe(findCallsAfterFirst);
    expect(provider.updateInputs).toHaveLength(0);
    expect(provider.createInputs).toHaveLength(1);
  });

  it('defers duplicate discovery until the fresh fingerprint window expires', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'fresh-duplicate-repair',
      sourceEntityId: 'session-fresh-duplicate',
    }));
    const first = await syncOne(decision.agendaItem.agendaItemId, provider);
    const input = providerInputFor(decision.agendaItem.agendaItemId);
    provider.seedEvent(input, 'google_evt_duplicate_fresh_a');
    provider.seedEvent(input, 'google_evt_duplicate_fresh_b');

    const findCallsBeforeFreshPass = provider.findAgendaItemIds.length;
    const skipped = await syncOne(decision.agendaItem.agendaItemId, provider);

    expect(skipped.action).toBe('skipped');
    expect(skipped.reasonCode).toBe('unchanged_since_last_sync');
    expect(skipped.providerEventId).toBe(first.providerEventId);
    expect(provider.findAgendaItemIds).toHaveLength(findCallsBeforeFreshPass);
    expect(provider.deletedEventIds).toEqual([]);
    expect(provider.updateInputs).toHaveLength(0);
    expect([...provider.events.values()].filter((event) => event.agendaItemId === decision.agendaItem.agendaItemId)).toHaveLength(3);
  });

  it('defers external-deletion readback until the fresh fingerprint window expires', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'fresh-external-delete-repair',
      sourceEntityId: 'session-fresh-external-delete',
    }));
    const first = await syncOne(decision.agendaItem.agendaItemId, provider);
    provider.removeExternally(first.providerEventId!);

    const findCallsBeforeFreshPass = provider.findAgendaItemIds.length;
    const skipped = await syncOne(decision.agendaItem.agendaItemId, provider);

    expect(skipped.action).toBe('skipped');
    expect(skipped.reasonCode).toBe('unchanged_since_last_sync');
    expect(skipped.providerEventId).toBe(first.providerEventId);
    expect(provider.findAgendaItemIds).toHaveLength(findCallsBeforeFreshPass);
    expect(provider.createInputs).toHaveLength(1);
  });

  it('defers stale-id marker reattachment until the fresh fingerprint window expires', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'fresh-single-reattach',
      sourceEntityId: 'session-fresh-single-reattach',
    }));
    const first = await syncOne(decision.agendaItem.agendaItemId, provider);
    const input = providerInputFor(decision.agendaItem.agendaItemId);
    provider.removeExternally(first.providerEventId!);
    provider.seedEvent(input, 'google_evt_survivor');

    const findCallsBeforeFreshPass = provider.findAgendaItemIds.length;
    const skipped = await syncOne(decision.agendaItem.agendaItemId, provider);
    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(skipped.action).toBe('skipped');
    expect(skipped.reasonCode).toBe('unchanged_since_last_sync');
    expect(provider.findAgendaItemIds).toHaveLength(findCallsBeforeFreshPass);
    expect(stored?.providerEventId).toBe(first.providerEventId);
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
    provider.seedEvent(providerInputFor(decision.agendaItem.agendaItemId), 'training_direct_evt_1');

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
    expect(provider.findAgendaItemIds).toEqual([]);
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

  it('retains an exact deleted-id tombstone so cleanup replay never deletes the provider event twice', async () => {
    const provider = new MockSecretaryProvider();
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'training-provider-switch-tombstone',
    }));
    const created = await syncOne(decision.agendaItem.agendaItemId, provider);
    const providerEventId = created.providerEventId!;
    const adapterSpy = vi.spyOn(
      secretaryUnifiedCalendarAdapterModule,
      'createUnifiedCalendarSecretaryProviderAdapter',
    ).mockReturnValue(provider);
    try {
      const input = {
        sourceIntentId: decision.agendaItem.sourceIntentId,
        ownerUserId: OWNER_USER_ID,
        tenantId: TENANT_ID,
        providerEventId,
        providerSource: 'google' as const,
        reason: 'training_provider_switch',
        nowIso: '2026-08-05T10:00:00.000Z',
      };
      const first = await cleanupTrainingSecretaryCalendarHandoff(input);
      expect(first).toMatchObject({
        outcome: 'cleanup_complete',
        agendaItemId: decision.agendaItem.agendaItemId,
        providerEventId,
        providerSource: 'google',
        reasonCode: 'secretary_provider_cleanup_tombstone_ready',
        retryable: false,
      });
      expect(provider.deletedEventIds).toEqual([providerEventId]);
      expect(getSecretaryAgendaItemById({
        agendaItemId: decision.agendaItem.agendaItemId,
        ownerUserId: OWNER_USER_ID,
        tenantId: TENANT_ID,
      })).toMatchObject({
        providerEventId,
        providerSource: 'google',
        providerSyncState: 'deleted',
        lifecycleState: 'superseded',
      });

      const replay = await cleanupTrainingSecretaryCalendarHandoff(input);
      expect(replay).toMatchObject({
        outcome: 'cleanup_complete',
        providerEventId,
        providerSource: 'google',
        reasonCode: 'secretary_provider_cleanup_tombstone_ready',
      });
      // Stronger guarantee: once provider delete is known complete, replay is
      // local-only until the route atomically clears the tombstone + ownership.
      expect(provider.deletedEventIds).toEqual([providerEventId]);
    } finally {
      adapterSpy.mockRestore();
    }
  });
});
