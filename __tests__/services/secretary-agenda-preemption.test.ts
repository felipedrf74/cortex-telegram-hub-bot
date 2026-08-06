// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

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
import { persistSecretaryPreemptionGraph } from '../../src/services/secretary-agenda-preemption';
import { markSecretaryPreemptionWinnerProviderFailed } from '../../src/services/secretary-agenda-preemption-worker';
import {
  markCompletedSecretaryAgendaItems,
  syncSecretaryAgendaItemToProvider,
  syncSecretaryAgendaItemsToProvider,
  type SecretaryAgendaProviderAdapter,
  type SecretaryProviderEvent,
  type SecretaryProviderEventInput,
} from '../../src/services/secretary-agenda-provider-sync';
import { listEventsForScope } from '../../src/services/event-outbox';
import {
  consumeSecretarySourceSkillFeedbackEvent,
  listSecretarySourceSkillFeedback,
} from '../../src/services/secretary-source-skill-feedback-consumers';

const OWNER_USER_ID = 42;
const TENANT_ID = 'tenant-preemption';
const SLOT = {
  start: '2026-08-10T08:00:00.000Z',
  end: '2026-08-10T09:00:00.000Z',
};
const SECOND_SLOT = {
  start: '2026-08-10T10:00:00.000Z',
  end: '2026-08-10T11:00:00.000Z',
};

function migration(numberAndName: string): string {
  return fs.readFileSync(path.resolve(__dirname, `../../migrations/${numberAndName}.sql`), 'utf8');
}

function applySchema(db: Database.Database): void {
  db.exec(migration('083_secretary_agenda_ledger'));
  db.exec(migration('098_secretary_decision_explanation'));
  db.exec(migration('126_secretary_reasoning_trail'));
  db.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
  db.exec(migration('220_secretary_agenda_provider_sync_failure_count'));
  db.exec(migration('224_secretary_agenda_sync_fingerprint'));
  db.exec(migration('276_training_secretary_feedback_durability'));
  db.exec(migration('278_secretary_agenda_provider_sync_claims'));
  db.exec(migration('280_secretary_agenda_arbitration_metadata'));
  db.exec(migration('281_secretary_provider_target_and_failure_disposition'));
  db.exec(migration('282_secretary_agenda_preemption_state'));
}

function contentLoser(intentId = 'content-low'): SecretarySchedulingIntent {
  return {
    intentId,
    sourceSkill: 'content',
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    providerTarget: 'google',
    title: 'Content focus block',
    requestedDurationMinutes: 60,
    preferredWindows: [SLOT],
    priority: 'low',
    flexibility: 'flexible',
  };
}

function secretaryWinner(intentId = 'secretary-urgent'): SecretarySchedulingIntent {
  return {
    intentId,
    sourceSkill: 'secretary',
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    providerTarget: 'google',
    title: 'Urgent protected block',
    requestedDurationMinutes: 60,
    preferredWindows: [SLOT],
    priority: 'urgent',
    flexibility: 'flexible',
  };
}

function exactLiveWindow(
  agendaItemId: string,
  providerEventId = 'google-content-low',
  window = SLOT,
): SecretaryTimeWindow {
  return {
    ...window,
    providerIdentity: {
      providerEventId,
      providerSource: 'google',
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      agendaItemId,
      trainingIdentity: null,
    },
  };
}

function seedSyncedLoser(): ReturnType<typeof submitSecretarySchedulingIntent> {
  const loser = submitSecretarySchedulingIntent(contentLoser());
  markSecretaryAgendaProviderSyncSatisfied({
    agendaItemId: loser.agendaItem.agendaItemId,
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    providerEventId: 'google-content-low',
    providerSource: 'google',
    now: '2026-08-09T08:00:00.000Z',
  });
  return loser;
}

class ExactPreemptionProvider implements SecretaryAgendaProviderAdapter {
  source = 'google' as const;
  events = new Map<string, SecretaryProviderEvent>();
  createInputs: SecretaryProviderEventInput[] = [];
  exactReadEventIds: string[] = [];
  deletedEventIds: string[] = [];
  deleteFailure: unknown | null = null;
  deleteThenThrow = false;
  private sequence = 1;

  async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
    this.createInputs.push(input);
    const event = {
      eventId: `google-winner-${this.sequence++}`,
      source: this.source,
      agendaItemId: input.agendaItemId,
      version: input.version,
    } satisfies SecretaryProviderEvent;
    this.events.set(event.eventId, event);
    return event;
  }

  async updateEvent(eventId: string, input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
    const event = {
      eventId,
      source: this.source,
      agendaItemId: input.agendaItemId,
      version: input.version,
    } satisfies SecretaryProviderEvent;
    this.events.set(eventId, event);
    return event;
  }

  async deleteEvent(eventId: string): Promise<void> {
    this.deletedEventIds.push(eventId);
    if (this.deleteThenThrow) this.events.delete(eventId);
    if (this.deleteFailure) throw this.deleteFailure;
    this.events.delete(eventId);
  }

  async getEvent(eventId: string) {
    this.exactReadEventIds.push(eventId);
    const event = this.events.get(eventId);
    return event ? { status: 'found' as const, event } : { status: 'not_found' as const };
  }

  async findEventsByAgendaItemId(agendaItemId: string): Promise<SecretaryProviderEvent[]> {
    return [...this.events.values()].filter((event) => event.agendaItemId === agendaItemId);
  }

  seedLoser(
    agendaItemId: string,
    markerAgendaItemId = agendaItemId,
    eventId = 'google-content-low',
  ): void {
    this.events.set(eventId, {
      eventId,
      source: this.source,
      agendaItemId: markerAgendaItemId,
      version: 1,
    });
  }
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
});

afterEach(() => {
  testDb.close();
});

describe('Secretary cross-skill preemption Stage 2', () => {
  it('atomically records a proposed winner, monotonic loser replacement, exact cleanup edge, and graph event', () => {
    const loser = seedSyncedLoser();

    const winner = submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });

    // Stronger Stage 2 guarantee: submit records a durable two-phase graph;
    // neither the old loser mapping nor any provider is mutated before Stage 3.
    expect(winner).toMatchObject({
      status: 'scheduled',
      selectedSlot: SLOT,
      agendaItem: { lifecycleState: 'proposed', providerTarget: 'google', version: 1 },
    });
    expect(winner.reasonCodes).toContain('priority_preemption_applied');

    expect(getSecretaryAgendaItemById({
      agendaItemId: loser.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({
      lifecycleState: 'synced',
      providerEventId: 'google-content-low',
      providerSource: 'google',
      version: 1,
    });

    const replacement = testDb.prepare(`
      SELECT lifecycle_state AS lifecycleState, provider_event_id AS providerEventId,
             provider_source AS providerSource, version, decision_action AS decisionAction
        FROM secretary_agenda_items
       WHERE source_skill = 'content' AND source_intent_id = 'content-low' AND version = 2
    `).get();
    expect(replacement).toEqual({
      lifecycleState: 'proposed',
      providerEventId: null,
      providerSource: null,
      version: 2,
      decisionAction: 'unscheduled',
    });

    expect(testDb.prepare(`
      SELECT state, winner_agenda_item_id AS winnerAgendaItemId,
             winner_agenda_version AS winnerAgendaVersion
        FROM secretary_agenda_preemption_operations
    `).get()).toEqual({
      state: 'cleanup_pending',
      winnerAgendaItemId: winner.agendaItem.agendaItemId,
      winnerAgendaVersion: 1,
    });
    expect(testDb.prepare(`
      SELECT state, loser_agenda_item_id AS loserAgendaItemId,
             loser_agenda_version AS loserAgendaVersion,
             loser_replacement_version AS loserReplacementVersion,
             loser_provider_event_id AS loserProviderEventId
        FROM secretary_agenda_preemption_dependencies
    `).get()).toEqual({
      state: 'pending',
      loserAgendaItemId: loser.agendaItem.agendaItemId,
      loserAgendaVersion: 1,
      loserReplacementVersion: 2,
      loserProviderEventId: 'google-content-low',
    });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'secretary.arbitration.committed.v1'
    `).get()).toEqual({ count: 1 });
  });

  it('replays the same deterministic graph without creating v2 winner or v3 loser rows', () => {
    const loser = seedSyncedLoser();
    const options = { additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)] };
    const first = submitSecretarySchedulingIntent(secretaryWinner(), options);
    const replay = submitSecretarySchedulingIntent(secretaryWinner(), options);

    expect(replay.agendaItem.agendaItemId).toBe(first.agendaItem.agendaItemId);
    expect(testDb.prepare(`SELECT COUNT(*) AS count FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ count: 1 });
    expect(testDb.prepare(`SELECT COUNT(*) AS count FROM secretary_agenda_preemption_dependencies`).get())
      .toEqual({ count: 1 });
    expect(testDb.prepare(`SELECT MAX(version) AS version FROM secretary_agenda_items WHERE source_intent_id = 'content-low'`).get())
      .toEqual({ version: 2 });
    expect(testDb.prepare(`SELECT MAX(version) AS version FROM secretary_agenda_items WHERE source_intent_id = 'secretary-urgent'`).get())
      .toEqual({ version: 1 });
  });

  it('rejects a changed winner request while its exact cleanup graph is unresolved', () => {
    const loser = seedSyncedLoser();
    const options = { additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)] };
    submitSecretarySchedulingIntent(secretaryWinner(), options);

    expect(() => submitSecretarySchedulingIntent({
      ...secretaryWinner(),
      title: 'Changed urgent protected block',
    }, options)).toThrow(/SECRETARY_PREEMPTION_IDEMPOTENCY_CONFLICT/);
    expect(testDb.prepare(`SELECT COUNT(*) AS count FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ count: 1 });
  });

  it('transactionally rejects a fresh graph after a terminal winner failure', async () => {
    const firstLoser = seedSyncedLoser();
    const secondLoser = submitSecretarySchedulingIntent({
      ...contentLoser('content-second'),
      preferredWindows: [SECOND_SLOT],
    });
    markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: secondLoser.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'google-content-second',
      providerSource: 'google',
      now: '2026-08-09T08:00:00.000Z',
    });
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(firstLoser.agendaItem.agendaItemId);
    const firstWinner = submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(firstLoser.agendaItem.agendaItemId)],
    });
    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    markSecretaryPreemptionWinnerProviderFailed({
      agendaItemId: firstWinner.agendaItem.agendaItemId,
      agendaVersion: firstWinner.agendaItem.version,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      disposition: 'terminal',
      failureCode: 'CREATE_VALIDATION_REFUSED',
      retryAfterAt: null,
      nowIso: '2026-08-10T08:01:00.000Z',
    });
    const persisted = testDb.prepare(`
      SELECT source_shape_hash AS sourceShapeHash,
             arbitration_score AS score,
             arbitration_deadline_at AS deadlineAt,
             arbitration_flexibility AS flexibility,
             arbitration_policy_version AS policyVersion
        FROM secretary_agenda_items
       WHERE agenda_item_id = ? AND version = ?
    `).get(firstWinner.agendaItem.agendaItemId, firstWinner.agendaItem.version) as {
      sourceShapeHash: string;
      score: number;
      deadlineAt: string | null;
      flexibility: 'fixed' | 'flexible' | 'compressible' | 'splittable';
      policyVersion: string;
    };

    // This direct call models the TOCTOU window between the public preflight
    // and the immediate persistence transaction. Terminal state must be
    // re-checked inside the transaction itself.
    expect(() => persistSecretaryPreemptionGraph({
      winner: {
        ownerUserId: OWNER_USER_ID,
        tenantId: TENANT_ID,
        sourceSkill: 'secretary',
        sourceIntentId: 'secretary-urgent',
        sourceAction: null,
        intentAction: 'schedule_this',
        sourceEntityId: null,
        sourceEntityType: null,
        providerTarget: 'google',
        title: 'Urgent protected block',
        startAt: SECOND_SLOT.start,
        endAt: SECOND_SLOT.end,
        durationMinutes: 60,
        decisionAction: 'scheduled',
        decisionReasonCodes: ['priority_preemption_candidate'],
        decisionExplanation: 'Higher-ranked exact preemption.',
        sourceShapeHash: persisted.sourceShapeHash,
        scheduledSegments: [SECOND_SLOT],
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        reasoningTrail: [],
        rank: {
          score: persisted.score,
          deadlineAt: persisted.deadlineAt,
          flexibility: persisted.flexibility,
          policyVersion: persisted.policyVersion,
          tieBreakerIntentId: 'secretary-urgent',
        },
      },
      losers: [{
        agendaItemId: secondLoser.agendaItem.agendaItemId,
        providerSource: 'google',
        providerEventId: 'google-content-second',
      }],
      nowIso: '2026-08-10T08:02:00.000Z',
    })).toThrow(/SECRETARY_PREEMPTION_IDEMPOTENCY_CONFLICT/);
    expect(testDb.prepare(`SELECT COUNT(*) AS count FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ count: 1 });
  });

  it('rolls the entire graph back when the atomic outbox write fails', () => {
    const loser = seedSyncedLoser();
    testDb.exec(`
      CREATE TRIGGER fail_preemption_graph_event
      BEFORE INSERT ON event_outbox
      WHEN NEW.event_type = 'secretary.arbitration.committed.v1'
      BEGIN
        SELECT RAISE(ABORT, 'injected preemption outbox failure');
      END;
    `);

    expect(() => submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    })).toThrow(/injected preemption outbox failure/);

    expect(testDb.prepare(`SELECT COUNT(*) AS count FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ count: 0 });
    expect(testDb.prepare(`SELECT COUNT(*) AS count FROM secretary_agenda_preemption_dependencies`).get())
      .toEqual({ count: 0 });
    expect(testDb.prepare(`SELECT COUNT(*) AS count FROM secretary_agenda_items WHERE source_intent_id = 'secretary-urgent'`).get())
      .toEqual({ count: 0 });
    expect(testDb.prepare(`SELECT MAX(version) AS version FROM secretary_agenda_items WHERE source_intent_id = 'content-low'`).get())
      .toEqual({ version: 1 });
  });

  it('keeps submit hard-busy when the winner has no durable provider target', () => {
    const loser = seedSyncedLoser();
    const winnerIntent = secretaryWinner();
    delete winnerIntent.providerTarget;

    const result = submitSecretarySchedulingIntent(winnerIntent, {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });

    expect(result.status).toBe('unscheduled');
    expect(result.selectedSlot).toBeNull();
    expect(testDb.prepare(`SELECT COUNT(*) AS count FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ count: 0 });
  });
});

describe('Secretary cross-skill preemption Stage 3', () => {
  it('blocks a generic preemption drain from deleting a Training loser while its calendar switch is disabled', async () => {
    const loser = submitSecretarySchedulingIntent({
      ...contentLoser('training:701:1:702'),
      sourceSkill: 'training',
      sourceEntityId: '702',
      sourceEntityType: 'training_session',
      title: 'Training recovery run',
    });
    markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: loser.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'google-training-kill-switch',
      providerSource: 'google',
    });
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(
      loser.agendaItem.agendaItemId,
      loser.agendaItem.agendaItemId,
      'google-training-kill-switch',
    );
    submitSecretarySchedulingIntent(secretaryWinner('secretary-over-training-disabled'), {
      additionalBusyWindows: [{
        ...SLOT,
        providerIdentity: {
          providerEventId: 'google-training-kill-switch',
          providerSource: 'google',
          ownerUserId: OWNER_USER_ID,
          tenantId: TENANT_ID,
          agendaItemId: loser.agendaItem.agendaItemId,
          trainingIdentity: {
            planId: 701,
            planVersion: 1,
            sessionId: 702,
            sessionIdentityKey: null,
            sessionShapeHash: null,
          },
        },
      }],
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM secretary_agenda_preemption_dependencies').get())
      .toEqual({ count: 1 });
    const prior = process.env.TRAINING_CALENDAR_WRITES_DISABLED;
    process.env.TRAINING_CALENDAR_WRITES_DISABLED = 'true';
    try {
      const results = await syncSecretaryAgendaItemsToProvider({
        ownerUserId: OWNER_USER_ID,
        tenantId: TENANT_ID,
      }, provider, { maxItems: 2, retryBudget: 0 });

      expect(provider.exactReadEventIds).toEqual(['google-training-kill-switch']);
      expect(provider.deletedEventIds).toEqual([]);
      expect(results).toContainEqual(expect.objectContaining({
        action: 'failed',
        reasonCode: 'priority_preemption_delete_retryable',
      }));
      expect(testDb.prepare(`
        SELECT state, failure_disposition AS failureDisposition,
               failure_code AS failureCode
          FROM secretary_agenda_preemption_dependencies
      `).get()).toEqual({
        state: 'retryable',
        failureDisposition: 'retryable',
        failureCode: 'TRAINING_CALENDAR_WRITES_DISABLED',
      });
    } finally {
      if (prior == null) delete process.env.TRAINING_CALENDAR_WRITES_DISABLED;
      else process.env.TRAINING_CALENDAR_WRITES_DISABLED = prior;
    }
  });

  it('blocks a direct winner sync before cleanup without making a provider call', async () => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    const winner = submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });

    const result = await syncSecretaryAgendaItemToProvider({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider);

    expect(result).toMatchObject({
      action: 'skipped',
      reasonCode: 'priority_preemption_dependencies_pending',
    });
    expect(provider.createInputs).toEqual([]);
    expect(provider.deletedEventIds).toEqual([]);
  });

  it('lets a scoped batch drain only its winner graph and sync that winner in one bounded call budget', async () => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    const winner = submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });

    const results = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, {
      agendaItemId: winner.agendaItem.agendaItemId,
      maxItems: 4,
      retryBudget: 0,
    });

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ agendaItemId: loser.agendaItem.agendaItemId, action: 'deleted' }),
      expect.objectContaining({ agendaItemId: winner.agendaItem.agendaItemId, action: 'created' }),
    ]));
    expect(provider.deletedEventIds).toEqual(['google-content-low']);
    expect(provider.exactReadEventIds).toEqual(['google-content-low']);
    expect(provider.createInputs).toHaveLength(1);
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ state: 'completed' });
  });

  it('deletes only the exact loser edge, finalizes loser v2, then makes the winner provider-eligible', async () => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    const winner = submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });

    const cleanup = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });

    expect(provider.deletedEventIds).toEqual(['google-content-low']);
    expect(provider.createInputs).toEqual([]);
    expect(cleanup).toContainEqual(expect.objectContaining({
      agendaItemId: loser.agendaItem.agendaItemId,
      action: 'deleted',
      reasonCode: 'priority_preemption_dependency_satisfied',
    }));
    expect(getSecretaryAgendaItemById({
      agendaItemId: loser.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({
      lifecycleState: 'superseded',
      providerSyncState: 'deleted',
      providerEventId: null,
      providerSource: null,
    });
    expect(testDb.prepare(`
      SELECT lifecycle_state AS lifecycleState, provider_sync_state AS providerSyncState
        FROM secretary_agenda_items
       WHERE source_skill = 'content' AND source_intent_id = 'content-low' AND version = 2
    `).get()).toEqual({ lifecycleState: 'unscheduled', providerSyncState: 'deleted' });
    expect(getSecretaryAgendaItemById({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({ lifecycleState: 'scheduled', providerSyncState: 'not_synced' });
    expect(testDb.prepare(`
      SELECT state FROM secretary_agenda_preemption_operations
    `).get()).toEqual({ state: 'winner_ready' });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'secretary.source_feedback.requested.v1'
         AND entity_version = 2
    `).get()).toEqual({ count: 1 });

    const winnerSync = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    expect(winnerSync).toContainEqual(expect.objectContaining({
      agendaItemId: winner.agendaItem.agendaItemId,
      action: 'created',
    }));
    expect(provider.createInputs).toHaveLength(1);
    expect(testDb.prepare(`
      SELECT state, completed_at IS NOT NULL AS completed
        FROM secretary_agenda_preemption_operations
    `).get()).toEqual({ state: 'completed', completed: 1 });
  });

  it('keeps an existing winner mapping on vN until cleanup, then deletes it without transferring ownership to vN+1', async () => {
    const priorSlot = {
      start: '2026-08-10T06:00:00.000Z',
      end: '2026-08-10T07:00:00.000Z',
    };
    const prior = submitSecretarySchedulingIntent({
      ...secretaryWinner(),
      preferredWindows: [priorSlot],
    });
    markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: prior.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'google-prior-winner',
      providerSource: 'google',
    });
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(prior.agendaItem.agendaItemId, prior.agendaItem.agendaItemId, 'google-prior-winner');
    provider.seedLoser(loser.agendaItem.agendaItemId);
    const winner = submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });
    expect(winner.agendaItem.version).toBe(2);

    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    expect(getSecretaryAgendaItemById({
      agendaItemId: prior.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({
      lifecycleState: 'superseded',
      providerEventId: 'google-prior-winner',
      providerSource: 'google',
    });
    expect(getSecretaryAgendaItemById({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({ providerEventId: null, providerSource: null, providerSyncState: 'not_synced' });

    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 3, retryBudget: 0 });
    expect(provider.deletedEventIds).toEqual(expect.arrayContaining([
      'google-content-low',
      'google-prior-winner',
    ]));
    expect(provider.createInputs).toHaveLength(1);
    expect(provider.createInputs[0].agendaItemId).toBe(winner.agendaItem.agendaItemId);
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ state: 'completed' });
  });

  it('fails closed without deleting when provider readback does not carry the exact loser marker', async () => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId, 'different-agenda-item');
    const winner = submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });

    const results = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });

    expect(provider.deletedEventIds).toEqual([]);
    expect(results).toContainEqual(expect.objectContaining({
      action: 'failed',
      reasonCode: 'priority_preemption_provider_identity_mismatch',
    }));
    expect(testDb.prepare(`
      SELECT state, failure_disposition AS failureDisposition
        FROM secretary_agenda_preemption_dependencies
    `).get()).toEqual({ state: 'terminal', failureDisposition: 'terminal' });
    expect(testDb.prepare(`
      SELECT state FROM secretary_agenda_preemption_operations
    `).get()).toEqual({ state: 'terminal_failure' });
    expect(getSecretaryAgendaItemById({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({
      // Stronger guarantee: a terminal dependency cannot leave a proposed
      // winner looking actionable to source read models.
      lifecycleState: 'unscheduled',
      providerSyncState: 'not_synced',
      decisionAction: 'unscheduled',
      decisionReasonCodes: ['priority_preemption_dependency_terminal_failure'],
      cancellationReason: 'priority_preemption_dependency_terminal_failure',
    });
    expect(testDb.prepare(`
      SELECT lifecycle_state AS lifecycleState,
             provider_sync_state AS providerSyncState,
             decision_action AS decisionAction,
             decision_reason_codes_json AS reasonCodes
        FROM secretary_agenda_items
       WHERE source_skill = 'content' AND source_intent_id = 'content-low' AND version = 2
    `).get()).toEqual({
      lifecycleState: 'unscheduled',
      providerSyncState: 'deleted',
      decisionAction: 'unscheduled',
      reasonCodes: '["priority_preemption_dependency_terminal_failure"]',
    });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'secretary.source_feedback.requested.v1'
         AND entity_id = (
           SELECT agenda_item_id FROM secretary_agenda_items
            WHERE source_skill = 'content' AND source_intent_id = 'content-low' AND version = 2
         )
         AND entity_version = 2
    `).get()).toEqual({ count: 1 });
    // A terminal exact-edge failure is a manual-reconciliation lock. Neither
    // side may be replayed into a fresh graph that could bypass the failed edge.
    expect(() => submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    })).toThrow(/SECRETARY_PREEMPTION_IDEMPOTENCY_CONFLICT/);
    expect(() => submitSecretarySchedulingIntent(contentLoser()))
      .toThrow(/SECRETARY_PREEMPTION_IDEMPOTENCY_CONFLICT/);
    await expect(syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 })).rejects.toMatchObject({
      code: 'SECRETARY_PROVIDER_SYNC_DEAD_LETTER_BACKLOG',
      deadLetterCount: 1,
    });
  });

  it('atomically terminalizes a provider-refused Training winner and emits its durable feedback once', async () => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    const winner = submitSecretarySchedulingIntent({
      ...secretaryWinner('training:901:1:902'),
      sourceSkill: 'training',
      sourceEntityId: '902',
      sourceEntityType: 'training_session',
      title: 'Urgent Training winner',
    }, {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });
    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'failed_sync', provider_sync_state = 'create_failed'
       WHERE agenda_item_id = ? AND version = ?
    `).run(winner.agendaItem.agendaItemId, winner.agendaItem.version);
    testDb.exec(`
      CREATE TRIGGER fail_terminal_training_winner_feedback
      BEFORE INSERT ON event_outbox
      WHEN NEW.event_type = 'secretary.training_feedback.requested.v1'
        AND NEW.entity_id = '${winner.agendaItem.agendaItemId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected terminal winner feedback failure');
      END;
    `);

    expect(() => markSecretaryPreemptionWinnerProviderFailed({
      agendaItemId: winner.agendaItem.agendaItemId,
      agendaVersion: winner.agendaItem.version,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      disposition: 'terminal',
      failureCode: 'CREATE_VALIDATION_REFUSED',
      retryAfterAt: null,
      nowIso: '2026-08-10T08:02:00.000Z',
    })).toThrow('injected terminal winner feedback failure');
    expect(testDb.prepare('SELECT state FROM secretary_agenda_preemption_operations').get())
      .toEqual({ state: 'winner_ready' });
    expect(getSecretaryAgendaItemById({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({ lifecycleState: 'failed_sync', decisionAction: 'scheduled' });

    testDb.exec('DROP TRIGGER fail_terminal_training_winner_feedback');
    markSecretaryPreemptionWinnerProviderFailed({
      agendaItemId: winner.agendaItem.agendaItemId,
      agendaVersion: winner.agendaItem.version,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      disposition: 'terminal',
      failureCode: 'CREATE_VALIDATION_REFUSED',
      retryAfterAt: null,
      nowIso: '2026-08-10T08:03:00.000Z',
    });

    expect(testDb.prepare('SELECT state FROM secretary_agenda_preemption_operations').get())
      .toEqual({ state: 'terminal_failure' });
    expect(getSecretaryAgendaItemById({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({
      lifecycleState: 'unscheduled',
      providerSyncState: 'create_failed',
      decisionAction: 'unscheduled',
      decisionReasonCodes: ['preemption_winner_provider_terminal_failure'],
      cancellationReason: 'preemption_winner_provider_terminal_failure',
    });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'secretary.training_feedback.requested.v1'
         AND entity_id = ? AND entity_version = ?
    `).get(winner.agendaItem.agendaItemId, winner.agendaItem.version)).toEqual({ count: 1 });
  });

  it('projects a provider-terminal Cooking winner through the generic monotonic feedback sink', async () => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    const winner = submitSecretarySchedulingIntent({
      ...secretaryWinner('cooking-provider-terminal-winner'),
      sourceSkill: 'cooking',
      sourceEntityId: 'meal-prep-provider-terminal',
      sourceEntityType: 'meal_prep',
      title: 'Cooking provider terminal winner',
    }, {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });
    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'failed_sync', provider_sync_state = 'create_failed'
       WHERE agenda_item_id = ? AND version = ?
    `).run(winner.agendaItem.agendaItemId, winner.agendaItem.version);

    markSecretaryPreemptionWinnerProviderFailed({
      agendaItemId: winner.agendaItem.agendaItemId,
      agendaVersion: winner.agendaItem.version,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      disposition: 'terminal',
      failureCode: 'CREATE_VALIDATION_REFUSED',
      retryAfterAt: null,
      nowIso: '2026-08-10T08:04:00.000Z',
    });

    const event = listEventsForScope({
      tenantId: OWNER_USER_ID,
      userId: OWNER_USER_ID,
      limit: 100,
    }, testDb).find((candidate) => (
      candidate.eventType === 'secretary.source_feedback.requested.v1'
      && candidate.entityId === winner.agendaItem.agendaItemId
      && candidate.entityVersion === winner.agendaItem.version
    ));
    expect(event).toBeDefined();
    consumeSecretarySourceSkillFeedbackEvent(event!, testDb);
    // Equal-version replay is neutralized by the sink's monotonic upsert.
    consumeSecretarySourceSkillFeedbackEvent(event!, testDb);

    expect(listSecretarySourceSkillFeedback({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      sourceSkill: 'cooking',
    })).toEqual([expect.objectContaining({
      agendaItemId: winner.agendaItem.agendaItemId,
      sourceIntentId: 'cooking-provider-terminal-winner',
      agendaVersion: winner.agendaItem.version,
      status: 'unscheduled',
      reasonCodes: ['preemption_winner_provider_terminal_failure'],
      shouldRefreshSource: true,
    })]);
  });

  it('rolls back the entire two-feedback terminal dependency transition when the second outbox write fails', async () => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId, 'foreign-provider-marker');
    const winner = submitSecretarySchedulingIntent({
      ...secretaryWinner('cooking-terminal-edge-winner'),
      sourceSkill: 'cooking',
      sourceEntityId: 'meal-prep-terminal-edge',
      sourceEntityType: 'meal_prep',
      title: 'Cooking terminal edge winner',
    }, {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });
    testDb.exec(`
      CREATE TRIGGER fail_second_terminal_edge_feedback
      BEFORE INSERT ON event_outbox
      WHEN NEW.event_type = 'secretary.source_feedback.requested.v1'
        AND NEW.entity_id = '${winner.agendaItem.agendaItemId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected second terminal edge feedback failure');
      END;
    `);

    const failed = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    expect(failed).toContainEqual(expect.objectContaining({
      action: 'failed',
      reasonCode: 'priority_preemption_worker_failed',
    }));
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_dependencies`).get())
      .toEqual({ state: 'retryable' });
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ state: 'cleanup_blocked' });
    expect(getSecretaryAgendaItemById({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({ lifecycleState: 'proposed', providerSyncState: 'not_synced' });
    expect(testDb.prepare(`
      SELECT lifecycle_state AS lifecycleState, provider_sync_state AS providerSyncState
        FROM secretary_agenda_items
       WHERE source_skill = 'content' AND source_intent_id = 'content-low' AND version = 2
    `).get()).toEqual({ lifecycleState: 'proposed', providerSyncState: 'not_synced' });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'secretary.source_feedback.requested.v1'
         AND entity_id IN (
           ?,
           (SELECT agenda_item_id FROM secretary_agenda_items
             WHERE source_skill = 'content' AND source_intent_id = 'content-low' AND version = 2)
         )
    `).get(winner.agendaItem.agendaItemId)).toEqual({ count: 0 });

    testDb.exec('DROP TRIGGER fail_second_terminal_edge_feedback');
    testDb.prepare('UPDATE secretary_agenda_preemption_dependencies SET retry_after_at = NULL').run();
    const terminal = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    expect(terminal).toContainEqual(expect.objectContaining({
      reasonCode: 'priority_preemption_provider_identity_mismatch',
    }));
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_dependencies`).get())
      .toEqual({ state: 'terminal' });
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ state: 'terminal_failure' });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'secretary.source_feedback.requested.v1'
         AND entity_id IN (
           ?,
           (SELECT agenda_item_id FROM secretary_agenda_items
             WHERE source_skill = 'content' AND source_intent_id = 'content-low' AND version = 2)
         )
    `).get(winner.agendaItem.agendaItemId)).toEqual({ count: 2 });
  });

  it('atomically terminalizes every generic version when the first edge in a multi-edge graph fails', async () => {
    const firstWindow = {
      start: '2026-08-10T08:00:00.000Z',
      end: '2026-08-10T08:30:00.000Z',
    };
    const secondWindow = {
      start: '2026-08-10T08:30:00.000Z',
      end: '2026-08-10T09:00:00.000Z',
    };
    const first = submitSecretarySchedulingIntent({
      ...contentLoser('content-terminal-half'),
      requestedDurationMinutes: 30,
      preferredWindows: [firstWindow],
    });
    markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: first.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'google-content-terminal-half',
      providerSource: 'google',
    });
    const second = submitSecretarySchedulingIntent({
      ...contentLoser('cooking-terminal-half'),
      sourceSkill: 'cooking',
      title: 'Cooking terminal half',
      requestedDurationMinutes: 30,
      preferredWindows: [secondWindow],
    });
    markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: second.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'google-cooking-terminal-half',
      providerSource: 'google',
    });
    const winner = submitSecretarySchedulingIntent({
      ...secretaryWinner('finance-terminal-multi-edge'),
      sourceSkill: 'finance',
      sourceEntityId: 'finance-terminal-multi-edge',
      sourceEntityType: 'finance_focus',
      title: 'Finance terminal multi-edge winner',
    }, {
      additionalBusyWindows: [
        exactLiveWindow(first.agendaItem.agendaItemId, 'google-content-terminal-half', firstWindow),
        exactLiveWindow(second.agendaItem.agendaItemId, 'google-cooking-terminal-half', secondWindow),
      ],
    });
    const dependencies = testDb.prepare(`
      SELECT dependency_id AS dependencyId,
             loser_agenda_item_id AS loserAgendaItemId,
             loser_replacement_agenda_item_id AS replacementAgendaItemId,
             loser_replacement_version AS replacementVersion,
             loser_provider_event_id AS providerEventId
        FROM secretary_agenda_preemption_dependencies
       ORDER BY datetime(created_at), dependency_id
    `).all() as Array<{
      dependencyId: string;
      loserAgendaItemId: string;
      replacementAgendaItemId: string;
      replacementVersion: number;
      providerEventId: string;
    }>;
    expect(dependencies).toHaveLength(2);
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(
      dependencies[0].loserAgendaItemId,
      'foreign-provider-marker',
      dependencies[0].providerEventId,
    );
    provider.seedLoser(
      dependencies[1].loserAgendaItemId,
      dependencies[1].loserAgendaItemId,
      dependencies[1].providerEventId,
    );
    testDb.exec(`
      CREATE TRIGGER fail_last_sibling_terminal_feedback
      BEFORE INSERT ON event_outbox
      WHEN NEW.event_type = 'secretary.source_feedback.requested.v1'
        AND NEW.entity_id = '${dependencies[1].replacementAgendaItemId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected last sibling terminal feedback failure');
      END;
    `);

    const rolledBack = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    expect(rolledBack).toContainEqual(expect.objectContaining({
      action: 'failed',
      reasonCode: 'priority_preemption_worker_failed',
    }));
    expect(testDb.prepare(`
      SELECT state FROM secretary_agenda_preemption_operations
    `).get()).toEqual({ state: 'cleanup_blocked' });
    expect(testDb.prepare(`
      SELECT state FROM secretary_agenda_preemption_dependencies
       WHERE dependency_id = ?
    `).get(dependencies[0].dependencyId)).toEqual({ state: 'retryable' });
    expect(testDb.prepare(`
      SELECT state FROM secretary_agenda_preemption_dependencies
       WHERE dependency_id = ?
    `).get(dependencies[1].dependencyId)).toEqual({ state: 'pending' });
    const rolledBackTruth = testDb.prepare(`
      SELECT agenda_item_id AS agendaItemId, lifecycle_state AS lifecycleState,
             provider_sync_state AS providerSyncState
        FROM secretary_agenda_items
       WHERE agenda_item_id IN (?, ?, ?)
       ORDER BY agenda_item_id, version
    `).all(
      dependencies[0].replacementAgendaItemId,
      dependencies[1].replacementAgendaItemId,
      winner.agendaItem.agendaItemId,
    ) as Array<{ agendaItemId: string; lifecycleState: string; providerSyncState: string }>;
    expect(rolledBackTruth).toHaveLength(3);
    expect(new Set(rolledBackTruth.map((row) => row.agendaItemId))).toEqual(new Set([
      dependencies[0].replacementAgendaItemId,
      dependencies[1].replacementAgendaItemId,
      winner.agendaItem.agendaItemId,
    ]));
    expect(rolledBackTruth.every((row) => (
      row.lifecycleState === 'proposed' && row.providerSyncState === 'not_synced'
    ))).toBe(true);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'secretary.source_feedback.requested.v1'
         AND entity_id IN (?, ?, ?)
    `).get(
      dependencies[0].replacementAgendaItemId,
      dependencies[1].replacementAgendaItemId,
      winner.agendaItem.agendaItemId,
    )).toEqual({ count: 0 });

    testDb.exec('DROP TRIGGER fail_last_sibling_terminal_feedback');
    testDb.prepare(`
      UPDATE secretary_agenda_preemption_dependencies SET retry_after_at = NULL
    `).run();
    const terminal = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    expect(terminal).toContainEqual(expect.objectContaining({
      action: 'failed',
      reasonCode: 'priority_preemption_provider_identity_mismatch',
    }));
    expect(testDb.prepare(`
      SELECT state, failure_disposition AS failureDisposition,
             failure_code AS failureCode
        FROM secretary_agenda_preemption_dependencies
       ORDER BY datetime(created_at), dependency_id
    `).all()).toEqual([
      { state: 'terminal', failureDisposition: 'terminal', failureCode: 'PROVIDER_IDENTITY_MISMATCH' },
      { state: 'terminal', failureDisposition: 'terminal', failureCode: 'PROVIDER_IDENTITY_MISMATCH' },
    ]);
    expect(testDb.prepare(`
      SELECT state FROM secretary_agenda_preemption_operations
    `).get()).toEqual({ state: 'terminal_failure' });
    expect(testDb.prepare(`
      SELECT agenda_item_id AS agendaItemId, version, lifecycle_state AS lifecycleState,
             provider_sync_state AS providerSyncState, decision_action AS decisionAction,
             decision_reason_codes_json AS reasonCodes,
             cancellation_reason AS cancellationReason
        FROM secretary_agenda_items
       WHERE agenda_item_id IN (?, ?, ?)
       ORDER BY agenda_item_id, version
    `).all(
      dependencies[0].replacementAgendaItemId,
      dependencies[1].replacementAgendaItemId,
      winner.agendaItem.agendaItemId,
    )).toEqual(expect.arrayContaining([
      {
        agendaItemId: dependencies[0].replacementAgendaItemId,
        version: dependencies[0].replacementVersion,
        lifecycleState: 'unscheduled',
        providerSyncState: 'deleted',
        decisionAction: 'unscheduled',
        reasonCodes: '["priority_preemption_dependency_terminal_failure"]',
        cancellationReason: 'priority_preemption_dependency_terminal_failure',
      },
      {
        agendaItemId: dependencies[1].replacementAgendaItemId,
        version: dependencies[1].replacementVersion,
        lifecycleState: 'unscheduled',
        providerSyncState: 'deleted',
        decisionAction: 'unscheduled',
        reasonCodes: '["priority_preemption_dependency_terminal_failure"]',
        cancellationReason: 'priority_preemption_dependency_terminal_failure',
      },
      {
        agendaItemId: winner.agendaItem.agendaItemId,
        version: winner.agendaItem.version,
        lifecycleState: 'unscheduled',
        providerSyncState: 'not_synced',
        decisionAction: 'unscheduled',
        reasonCodes: '["priority_preemption_dependency_terminal_failure"]',
        cancellationReason: 'priority_preemption_dependency_terminal_failure',
      },
    ]));
    const expectedFeedbackKeys = [
      ...dependencies.map((dependency) => (
        `secretary.source_feedback.requested:${dependency.replacementAgendaItemId}:${dependency.replacementVersion}`
      )),
      `secretary.source_feedback.requested:${winner.agendaItem.agendaItemId}:${winner.agendaItem.version}`,
    ].sort();
    const readFeedbackKeys = () => (testDb.prepare(`
      SELECT idempotency_key AS idempotencyKey
        FROM event_outbox
       WHERE event_type = 'secretary.source_feedback.requested.v1'
         AND entity_id IN (?, ?, ?)
       ORDER BY idempotency_key
    `).all(
      dependencies[0].replacementAgendaItemId,
      dependencies[1].replacementAgendaItemId,
      winner.agendaItem.agendaItemId,
    ) as Array<{ idempotencyKey: string }>).map((row) => row.idempotencyKey);
    expect(readFeedbackKeys()).toEqual(expectedFeedbackKeys);

    await expect(syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 })).rejects.toMatchObject({
      code: 'SECRETARY_PROVIDER_SYNC_DEAD_LETTER_BACKLOG',
    });
    expect(readFeedbackKeys()).toEqual(expectedFeedbackKeys);
  });

  it('keeps the winner proposed until every loser in a multi-edge graph is satisfied', async () => {
    const firstWindow = {
      start: '2026-08-10T08:00:00.000Z',
      end: '2026-08-10T08:30:00.000Z',
    };
    const secondWindow = {
      start: '2026-08-10T08:30:00.000Z',
      end: '2026-08-10T09:00:00.000Z',
    };
    const first = submitSecretarySchedulingIntent({
      ...contentLoser('content-half'),
      requestedDurationMinutes: 30,
      preferredWindows: [firstWindow],
    });
    markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: first.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'google-content-half',
      providerSource: 'google',
    });
    const second = submitSecretarySchedulingIntent({
      ...contentLoser('cooking-half'),
      sourceSkill: 'cooking',
      title: 'Cooking prep block',
      requestedDurationMinutes: 30,
      preferredWindows: [secondWindow],
    });
    markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: second.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'google-cooking-half',
      providerSource: 'google',
    });
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(first.agendaItem.agendaItemId, first.agendaItem.agendaItemId, 'google-content-half');
    provider.seedLoser(second.agendaItem.agendaItemId, second.agendaItem.agendaItemId, 'google-cooking-half');
    const winner = submitSecretarySchedulingIntent(secretaryWinner('secretary-multi-edge'), {
      additionalBusyWindows: [
        exactLiveWindow(first.agendaItem.agendaItemId, 'google-content-half', firstWindow),
        exactLiveWindow(second.agendaItem.agendaItemId, 'google-cooking-half', secondWindow),
      ],
    });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM secretary_agenda_preemption_dependencies
    `).get()).toEqual({ count: 2 });

    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM secretary_agenda_preemption_dependencies WHERE state = 'satisfied'
    `).get()).toEqual({ count: 1 });
    expect(getSecretaryAgendaItemById({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })?.lifecycleState).toBe('proposed');

    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    expect(new Set(provider.deletedEventIds)).toEqual(new Set([
      'google-content-half',
      'google-cooking-half',
    ]));
    expect(getSecretaryAgendaItemById({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })?.lifecycleState).toBe('scheduled');
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'secretary.source_feedback.requested.v1' AND entity_version = 2
    `).get()).toEqual({ count: 2 });
  });

  it('reconciles an unknown delete outcome before satisfying the edge and never deletes twice', async () => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    provider.deleteThenThrow = true;
    provider.deleteFailure = Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' });
    submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });

    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    expect(testDb.prepare(`
      SELECT state, failure_disposition AS failureDisposition
        FROM secretary_agenda_preemption_dependencies
    `).get()).toEqual({ state: 'reconcile', failureDisposition: 'reconcile' });

    testDb.prepare(`
      UPDATE secretary_agenda_preemption_dependencies SET retry_after_at = NULL
    `).run();
    provider.deleteFailure = null;
    provider.deleteThenThrow = false;
    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });

    expect(provider.deletedEventIds).toEqual(['google-content-low']);
    expect(testDb.prepare(`
      SELECT state FROM secretary_agenda_preemption_dependencies
    `).get()).toEqual({ state: 'satisfied' });
  });

  it.each([
    'UND_ERR_SOCKET',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNREFUSED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ])('classifies ambiguous delete transport %s as reconcile, never terminal', async (code) => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    provider.deleteThenThrow = true;
    provider.deleteFailure = Object.assign(new Error('ambiguous provider delete outcome'), { code });
    submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });

    const results = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });

    expect(results).toContainEqual(expect.objectContaining({
      action: 'failed',
      reasonCode: 'priority_preemption_delete_reconciliation_required',
    }));
    expect(testDb.prepare(`
      SELECT state, failure_disposition AS failureDisposition
        FROM secretary_agenda_preemption_dependencies
    `).get()).toEqual({ state: 'reconcile', failureDisposition: 'reconcile' });
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ state: 'cleanup_blocked' });
  });

  it.each([
    { status: 408, expectedState: 'reconcile', expectedReason: 'priority_preemption_delete_reconciliation_required' },
    { status: 409, expectedState: 'reconcile', expectedReason: 'priority_preemption_delete_reconciliation_required' },
    { status: 418, expectedState: 'reconcile', expectedReason: 'priority_preemption_delete_reconciliation_required' },
    { status: 425, expectedState: 'retryable', expectedReason: 'priority_preemption_delete_retryable' },
  ])('does not terminalize ambiguous HTTP delete status $status', async ({ status, expectedState, expectedReason }) => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    provider.deleteThenThrow = true;
    provider.deleteFailure = Object.assign(new Error('ambiguous HTTP delete outcome'), { status });
    submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });

    const results = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });

    expect(results).toContainEqual(expect.objectContaining({ reasonCode: expectedReason }));
    expect(testDb.prepare(`
      SELECT state, failure_disposition AS failureDisposition
        FROM secretary_agenda_preemption_dependencies
    `).get()).toEqual({ state: expectedState, failureDisposition: expectedState });
  });

  it('recovers after a post-delete feedback write rollback without deleting the provider event twice', async () => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });
    testDb.exec(`
      CREATE TRIGGER fail_preemption_feedback_once
      BEFORE INSERT ON event_outbox
      WHEN NEW.event_type = 'secretary.source_feedback.requested.v1'
        AND NEW.entity_version = 2
      BEGIN
        SELECT RAISE(ABORT, 'injected finalization feedback failure');
      END;
    `);

    const failed = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    expect(failed).toContainEqual(expect.objectContaining({
      action: 'failed',
      reasonCode: 'priority_preemption_worker_failed',
    }));
    expect(provider.deletedEventIds).toEqual(['google-content-low']);
    expect(getSecretaryAgendaItemById({
      agendaItemId: loser.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({ lifecycleState: 'synced', providerEventId: 'google-content-low' });
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_dependencies`).get())
      .toEqual({ state: 'retryable' });

    testDb.exec('DROP TRIGGER fail_preemption_feedback_once');
    testDb.prepare(`UPDATE secretary_agenda_preemption_dependencies SET retry_after_at = NULL`).run();
    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    expect(provider.deletedEventIds).toEqual(['google-content-low']);
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_dependencies`).get())
      .toEqual({ state: 'satisfied' });
  });

  it('records cancellation as a request, finishes exact cleanup, and never restores the loser', async () => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    const winner = submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });

    cancelSecretaryAgendaItem({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'user_canceled',
    });
    expect(testDb.prepare(`
      SELECT state, cancel_requested_at IS NOT NULL AS cancelRequested
        FROM secretary_agenda_preemption_operations
    `).get()).toEqual({ state: 'cleanup_pending', cancelRequested: 1 });

    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });

    expect(testDb.prepare(`
      SELECT state FROM secretary_agenda_preemption_operations
    `).get()).toEqual({ state: 'canceled' });
    expect(getSecretaryAgendaItemById({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({ lifecycleState: 'canceled', providerSyncState: 'not_synced' });
    expect(getSecretaryAgendaItemById({
      agendaItemId: loser.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({ lifecycleState: 'superseded', providerSyncState: 'deleted' });
  });

  it('atomically emits canceled-winner source feedback or rolls finalization back', async () => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    const winner = submitSecretarySchedulingIntent({
      ...secretaryWinner('cooking-canceled-winner'),
      sourceSkill: 'cooking',
      title: 'Canceled meal preparation winner',
    }, {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });
    cancelSecretaryAgendaItem({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'user_canceled_before_provider_success',
    });
    testDb.exec(`
      CREATE TRIGGER fail_canceled_winner_feedback
      BEFORE INSERT ON event_outbox
      WHEN NEW.event_type = 'secretary.source_feedback.requested.v1'
        AND NEW.entity_id = (
          SELECT winner_agenda_item_id
            FROM secretary_agenda_preemption_operations
           LIMIT 1
        )
      BEGIN
        SELECT RAISE(ABORT, 'injected canceled winner feedback failure');
      END;
    `);

    const failed = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });

    expect(failed).toContainEqual(expect.objectContaining({
      action: 'failed',
      reasonCode: 'priority_preemption_worker_failed',
    }));
    expect(testDb.prepare(`
      SELECT state FROM secretary_agenda_preemption_operations
    `).get()).not.toEqual({ state: 'canceled' });
    expect(getSecretaryAgendaItemById({
      agendaItemId: loser.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({ providerEventId: 'google-content-low', providerSyncState: 'synced' });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'secretary.source_feedback.requested.v1'
         AND entity_id = ? AND entity_version = ?
    `).get(winner.agendaItem.agendaItemId, winner.agendaItem.version)).toEqual({ count: 0 });

    testDb.exec('DROP TRIGGER fail_canceled_winner_feedback');
    testDb.prepare(`UPDATE secretary_agenda_preemption_dependencies SET retry_after_at = NULL`).run();
    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });

    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ state: 'canceled' });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'secretary.source_feedback.requested.v1'
         AND entity_id = ? AND entity_version = ?
    `).get(winner.agendaItem.agendaItemId, winner.agendaItem.version)).toEqual({ count: 1 });
  });

  it('terminalizes cancellation after cleanup and never lets a winner_ready row reach the provider', async () => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    const winner = submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });
    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ state: 'winner_ready' });

    cancelSecretaryAgendaItem({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'user_canceled_after_cleanup',
    });
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ state: 'canceled' });
    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    expect(provider.createInputs).toEqual([]);
  });

  it('keeps cancellation cleanup-only when create is accepted then times out in flight', async () => {
    const loser = seedSyncedLoser();
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    class AcceptedThenTimedOutProvider extends ExactPreemptionProvider {
      override async createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        await super.createEvent(input);
        markCreateStarted();
        await createGate;
        throw Object.assign(new Error('accepted then timed out'), { code: 'ETIMEDOUT' });
      }
    }
    const provider = new AcceptedThenTimedOutProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    const winner = submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });
    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });

    const inFlight = syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 3, retryBudget: 0 });
    await createStarted;
    cancelSecretaryAgendaItem({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'user_canceled_during_provider_create',
    });
    releaseCreate();
    await inFlight;

    expect(testDb.prepare(`
      SELECT state, cancel_requested_at IS NOT NULL AS cancelRequested
        FROM secretary_agenda_preemption_operations
    `).get()).toEqual({ state: 'winner_reconcile', cancelRequested: 1 });
    expect(testDb.prepare(`
      SELECT resolution_state AS resolutionState
        FROM secretary_agenda_provider_create_reconciliation
    `).get()).toEqual({ resolutionState: 'unknown' });

    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 4, retryBudget: 0 });

    expect(provider.createInputs).toHaveLength(1);
    expect(provider.deletedEventIds).toContain('google-winner-1');
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ state: 'canceled' });
    expect(testDb.prepare(`
      SELECT resolution_state AS resolutionState
        FROM secretary_agenda_provider_create_reconciliation
    `).get()).toEqual({ resolutionState: 'deleted' });
    expect(getSecretaryAgendaItemById({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({
      lifecycleState: 'canceled',
      providerEventId: null,
      providerSource: null,
      providerSyncState: 'deleted',
    });
  });

  it('keeps cancellation pending when an adopted event update loses its fence after the provider accepts it', async () => {
    const loser = seedSyncedLoser();
    let markUpdateStarted!: () => void;
    const updateStarted = new Promise<void>((resolve) => { markUpdateStarted = resolve; });
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    class AcceptedUpdateProvider extends ExactPreemptionProvider {
      override async updateEvent(eventId: string, input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent> {
        const updated = await super.updateEvent(eventId, input);
        markUpdateStarted();
        await updateGate;
        return updated;
      }
    }
    const provider = new AcceptedUpdateProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    const winner = submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });
    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    provider.seedLoser(
      winner.agendaItem.agendaItemId,
      winner.agendaItem.agendaItemId,
      'google-existing-winner',
    );

    const inFlight = syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 4, retryBudget: 0 });
    await updateStarted;
    cancelSecretaryAgendaItem({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'user_canceled_during_provider_adopt',
    });
    releaseUpdate();
    await expect(inFlight).rejects.toThrow(/SECRETARY_PROVIDER_SYNC_LEASE_LOST/);

    // Stronger guarantee: update/adopt effects get the same durable post-call
    // recovery fence as creates. Cancellation cannot terminalize while the
    // known provider id may carry the canceled winner marker.
    expect(testDb.prepare(`
      SELECT state, cancel_requested_at IS NOT NULL AS cancelRequested
        FROM secretary_agenda_preemption_operations
    `).get()).toEqual({ state: 'winner_ready', cancelRequested: 1 });
    expect(testDb.prepare(`
      SELECT effect_kind AS effectKind, resolution_state AS resolutionState,
             provider_event_id AS providerEventId
        FROM secretary_agenda_provider_effect_recovery
       WHERE agenda_item_id = ? AND agenda_version = ?
    `).get(winner.agendaItem.agendaItemId, winner.agendaItem.version)).toEqual({
      effectKind: 'adopt',
      resolutionState: 'pending',
      providerEventId: 'google-existing-winner',
    });

    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 4, retryBudget: 0 });
    expect(provider.deletedEventIds).toContain('google-existing-winner');
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ state: 'canceled' });
    expect(testDb.prepare(`
      SELECT resolution_state AS resolutionState
        FROM secretary_agenda_provider_effect_recovery
       WHERE provider_event_id = 'google-existing-winner'
    `).get()).toEqual({ resolutionState: 'deleted' });
  });

  it('does not terminalize replacement cancellation until the exact prior-winner mapping is cleaned', async () => {
    const prior = submitSecretarySchedulingIntent({
      ...secretaryWinner(),
      preferredWindows: [SECOND_SLOT],
    });
    markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: prior.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'google-prior-winner',
      providerSource: 'google',
      now: '2026-08-09T08:00:00.000Z',
    });
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    provider.seedLoser(prior.agendaItem.agendaItemId, prior.agendaItem.agendaItemId, 'google-prior-winner');
    const replacement = submitSecretarySchedulingIntent(secretaryWinner(), {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });

    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ state: 'winner_ready' });
    expect(getSecretaryAgendaItemById({
      agendaItemId: prior.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({
      lifecycleState: 'superseded',
      providerEventId: 'google-prior-winner',
      providerSource: 'google',
    });

    cancelSecretaryAgendaItem({
      agendaItemId: replacement.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      reason: 'user_canceled_replacement_after_cleanup',
    });

    // Stronger guarantee: the operation freezes the prior provider identity,
    // and cancellation stays non-terminal until that exact older row is
    // claimable in cleanup-only mode despite the newer agenda version.
    expect(testDb.prepare(`
      SELECT state, cancel_requested_at IS NOT NULL AS cancelRequested,
             prior_winner_provider_source AS priorSource,
             prior_winner_provider_event_id AS priorEventId
        FROM secretary_agenda_preemption_operations
    `).get()).toEqual({
      state: 'winner_ready',
      cancelRequested: 1,
      priorSource: 'google',
      priorEventId: 'google-prior-winner',
    });

    const cancellationCleanup = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 4, retryBudget: 0 });
    expect(cancellationCleanup).toContainEqual(expect.objectContaining({
      agendaItemId: prior.agendaItem.agendaItemId,
      action: 'deleted',
    }));
    expect(provider.deletedEventIds).toEqual(expect.arrayContaining([
      'google-content-low',
      'google-prior-winner',
    ]));
    expect(getSecretaryAgendaItemById({
      agendaItemId: prior.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({
      lifecycleState: 'superseded',
      providerSyncState: 'deleted',
      providerEventId: null,
      providerSource: null,
    });
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ state: 'canceled' });
  });

  it('expires an unsynced winner_ready row explicitly instead of silently completing it', async () => {
    const loser = seedSyncedLoser();
    const provider = new ExactPreemptionProvider();
    provider.seedLoser(loser.agendaItem.agendaItemId);
    const winner = submitSecretarySchedulingIntent({
      ...secretaryWinner('cooking-expiring-winner'),
      sourceSkill: 'cooking',
      title: 'Urgent meal preparation',
    }, {
      additionalBusyWindows: [exactLiveWindow(loser.agendaItem.agendaItemId)],
    });
    await syncSecretaryAgendaItemsToProvider({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    }, provider, { maxItems: 2, retryBudget: 0 });

    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ state: 'winner_ready' });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'secretary.source_feedback.requested.v1'
         AND entity_id = ? AND entity_version = 1
    `).get(winner.agendaItem.agendaItemId)).toEqual({ count: 0 });

    markCompletedSecretaryAgendaItems(new Date('2026-08-10T09:05:00.000Z'));

    expect(getSecretaryAgendaItemById({
      agendaItemId: winner.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({
      lifecycleState: 'canceled',
      providerSyncState: 'not_synced',
      cancellationReason: 'preemption_winner_expired_before_provider_sync',
    });
    expect(testDb.prepare(`SELECT state FROM secretary_agenda_preemption_operations`).get())
      .toEqual({ state: 'canceled' });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'secretary.source_feedback.requested.v1'
         AND entity_id = ? AND entity_version = 1
    `).get(winner.agendaItem.agendaItemId)).toEqual({ count: 1 });
  });
});
