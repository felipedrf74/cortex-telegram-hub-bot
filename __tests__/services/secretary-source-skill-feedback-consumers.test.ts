// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wave 2 guard: Cooking / Finance / Content consume Secretary feedback.
 * Training has a specialized sink; these skills share the compact source
 * feedback table until richer skill-specific planners consume the hints.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATION_083 = path.resolve(__dirname, '../../migrations/083_secretary_agenda_ledger.sql');
const MIGRATION_098 = path.resolve(__dirname, '../../migrations/098_secretary_decision_explanation.sql');
const MIGRATION_126 = path.resolve(__dirname, '../../migrations/126_secretary_reasoning_trail.sql');

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
  submitSecretarySchedulingIntent,
  type SecretarySchedulingIntent,
} from '../../src/services/secretary-scheduling-arbitrator';
import {
  _resetSecretaryFeedbackBusForTests,
} from '../../src/services/secretary-feedback-bus';
import {
  _resetSecretarySourceSkillFeedbackConsumersForTests,
  consumeSecretarySourceSkillFeedbackEvent,
  listSecretarySourceSkillFeedback,
  recordSecretarySourceSkillFeedback,
  registerSecretarySourceSkillFeedbackConsumers,
  SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_TYPE,
  SECRETARY_SOURCE_SKILL_FEEDBACK_SCHEMA_VERSION,
} from '../../src/services/secretary-source-skill-feedback-consumers';
import {
  emitDomainEvent,
  ensureEventOutboxTables,
  processPendingEvents,
  type EventOutboxRecord,
} from '../../src/services/event-outbox';
import { defaultEventHandlers } from '../../src/services/event-backbone-worker';
import type { SecretarySourceSkillFeedback } from '../../src/services/secretary-scheduling-arbitrator';

const OWNER_USER_ID = 42;
const TENANT_ID = 'tenant-feedback-wave2';

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
  testDb.exec(fs.readFileSync(MIGRATION_098, 'utf8'));
  testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
  testDb.exec(fs.readFileSync(MIGRATION_126, 'utf8'));
  // Migration 282 owns this production schema. Keep this focused consumer
  // fixture independent from the arbitration tables that migration also adds.
  testDb.exec(`
    ALTER TABLE secretary_source_skill_feedback
      ADD COLUMN agenda_version INTEGER NOT NULL DEFAULT 1 CHECK (agenda_version > 0);
    CREATE UNIQUE INDEX idx_secretary_source_skill_feedback_current_intent
      ON secretary_source_skill_feedback(user_id, tenant_id, target_skill, source_intent_id);
  `);
  _resetSecretaryFeedbackBusForTests();
  _resetSecretarySourceSkillFeedbackConsumersForTests();
  registerSecretarySourceSkillFeedbackConsumers();
});

afterEach(() => {
  testDb.close();
  _resetSecretaryFeedbackBusForTests();
  _resetSecretarySourceSkillFeedbackConsumersForTests();
});

function intent(sourceSkill: 'cooking' | 'finance' | 'content', intentId: string): SecretarySchedulingIntent {
  return {
    intentId,
    sourceSkill,
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    title: `${sourceSkill} schedule block`,
    requestedDurationMinutes: 90,
    minimumDurationMinutes: 45,
    preferredWindows: [{ start: '2026-05-20T08:00:00.000Z', end: '2026-05-20T09:00:00.000Z' }],
    priority: sourceSkill === 'finance' ? 'high' : 'normal',
    flexibility: 'compressible',
  };
}

function feedback(overrides: Partial<SecretarySourceSkillFeedback> = {}): SecretarySourceSkillFeedback {
  return {
    sourceSkill: overrides.sourceSkill ?? 'cooking',
    sourceIntentId: overrides.sourceIntentId ?? 'durable-source-intent',
    agendaItemId: overrides.agendaItemId ?? 'durable-agenda-v1',
    ownerUserId: overrides.ownerUserId ?? OWNER_USER_ID,
    tenantId: overrides.tenantId ?? TENANT_ID,
    agendaVersion: overrides.agendaVersion ?? 1,
    status: overrides.status ?? 'scheduled',
    reasonCodes: overrides.reasonCodes ?? ['scheduled_in_available_window'],
    scheduledStart: overrides.scheduledStart ?? '2026-05-20T08:00:00.000Z',
    scheduledEnd: overrides.scheduledEnd ?? '2026-05-20T09:00:00.000Z',
    shouldRefreshSource: overrides.shouldRefreshSource ?? false,
    downstreamImplications: overrides.downstreamImplications ?? [],
  };
}

function insertAgendaRow(input: {
  agendaItemId: string;
  sourceIntentId: string;
  sourceSkill: 'secretary' | 'training' | 'cooking' | 'finance' | 'content';
  version: number;
  ownerUserId?: number;
  tenantId?: string;
  status?: 'scheduled' | 'reflowed' | 'compressed' | 'deferred' | 'unscheduled' | 'needs_more_context';
}): void {
  const status = input.status ?? 'scheduled';
  testDb.prepare(`
    INSERT INTO secretary_agenda_items (
      agenda_item_id, source_intent_id, source_skill, owner_user_id, tenant_id,
      lifecycle_state, provider_sync_state, version, title, start_at, end_at,
      duration_minutes, decision_action, decision_reason_codes_json,
      source_shape_hash, scheduled_segments_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'not_synced', ?, 'authoritative agenda row',
              '2026-05-20T08:00:00.000Z', '2026-05-20T09:00:00.000Z', 60,
              ?, '["scheduled_in_available_window"]', ?, '[]', ?, ?)
  `).run(
    input.agendaItemId,
    input.sourceIntentId,
    input.sourceSkill,
    input.ownerUserId ?? OWNER_USER_ID,
    input.tenantId ?? TENANT_ID,
    status === 'needs_more_context' ? 'proposed' : status,
    input.version,
    status,
    `shape-${input.agendaItemId}`,
    '2026-05-20T07:00:00.000Z',
    '2026-05-20T07:00:00.000Z',
  );
}

function durableEvent(input: {
  agendaItemId: string;
  version: number;
  agendaTenantId?: string;
  idempotencySuffix?: string;
}): EventOutboxRecord {
  ensureEventOutboxTables(testDb);
  return emitDomainEvent({
    tenantId: OWNER_USER_ID,
    userId: OWNER_USER_ID,
    sourceSkill: 'secretary',
    eventType: SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_TYPE,
    entityType: 'secretary_agenda_item',
    entityId: input.agendaItemId,
    entityVersion: input.version,
    schemaVersion: SECRETARY_SOURCE_SKILL_FEEDBACK_SCHEMA_VERSION,
    payload: {
      agendaTenantId: input.agendaTenantId ?? TENANT_ID,
      // The durable consumer must ignore these untrusted mirrors and re-read
      // the authoritative agenda row instead.
      targetSkill: 'finance',
      status: 'unscheduled',
    },
    privacyClassification: 'internal',
    idempotencyKey: `secretary.source_feedback.requested:${input.agendaItemId}:${input.version}:${input.idempotencySuffix ?? 'default'}`,
  }, testDb);
}

describe('Wave 2 Secretary source-skill feedback consumers', () => {
  it.each(['cooking', 'finance', 'content'] as const)('persists %s feedback with tenant scope and hints', (sourceSkill) => {
    const decision = submitSecretarySchedulingIntent(intent(sourceSkill, `${sourceSkill}-1`));
    expect(decision.status).toBe('compressed');

    // F23 stronger guarantee: the authoritative agenda version and its
    // generic feedback request commit atomically. The in-process bus remains
    // a latency optimization, not the only durability path.
    expect(testDb.prepare(`
      SELECT event_type AS eventType, entity_id AS entityId,
             entity_version AS entityVersion, schema_version AS schemaVersion,
             privacy_classification AS privacyClassification
        FROM event_outbox
       WHERE idempotency_key = ?
    `).get(`secretary.source_feedback.requested:${decision.agendaItem.agendaItemId}:${decision.agendaItem.version}`))
      .toEqual({
        eventType: SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_TYPE,
        entityId: decision.agendaItem.agendaItemId,
        entityVersion: decision.agendaItem.version,
        schemaVersion: SECRETARY_SOURCE_SKILL_FEEDBACK_SCHEMA_VERSION,
        privacyClassification: sourceSkill === 'finance'
          ? 'financial'
          : sourceSkill === 'content'
            ? 'private_content'
            : 'internal',
      });

    const records = listSecretarySourceSkillFeedback({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      sourceSkill,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      targetSkill: sourceSkill,
      agendaItemId: decision.agendaItem.agendaItemId,
      sourceIntentId: `${sourceSkill}-1`,
      status: 'compressed',
      shouldRefreshSource: true,
    });
    expect(records[0].hints).toContain('adapt_scope_to_available_time');
  });

  it('does not leak feedback across tenants', () => {
    submitSecretarySchedulingIntent(intent('content', 'content-private'));

    expect(listSecretarySourceSkillFeedback({
      userId: OWNER_USER_ID,
      tenantId: 'other-tenant',
      sourceSkill: 'content',
    })).toEqual([]);
  });

  it('rolls back a generic agenda version when its durable feedback request cannot commit', () => {
    ensureEventOutboxTables(testDb);
    testDb.exec(`
      CREATE TRIGGER fail_generic_feedback_outbox
      BEFORE INSERT ON event_outbox
      WHEN NEW.event_type = 'secretary.source_feedback.requested.v1'
      BEGIN
        SELECT RAISE(ABORT, 'injected generic feedback outbox failure');
      END;
    `);

    expect(() => submitSecretarySchedulingIntent(intent('content', 'content-outbox-rollback')))
      .toThrow(/injected generic feedback outbox failure/);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM secretary_agenda_items
       WHERE source_intent_id = 'content-outbox-rollback'
    `).get()).toEqual({ count: 0 });
  });

  it('dedupes repeated feedback for the same agenda item and source intent', () => {
    submitSecretarySchedulingIntent(intent('cooking', 'cooking-dedupe'));
    submitSecretarySchedulingIntent(intent('cooking', 'cooking-dedupe'));

    const records = listSecretarySourceSkillFeedback({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      sourceSkill: 'cooking',
    });
    expect(records).toHaveLength(1);
  });

  it('keeps one monotonic projection per source intent and neutralizes stale or equal-version delivery', () => {
    recordSecretarySourceSkillFeedback(feedback({
      agendaItemId: 'cooking-v2',
      sourceIntentId: 'cooking-monotonic',
      agendaVersion: 2,
      status: 'reflowed',
      reasonCodes: ['reflowed_to_available_window'],
      scheduledStart: '2026-05-21T10:00:00.000Z',
      scheduledEnd: '2026-05-21T11:00:00.000Z',
      shouldRefreshSource: true,
    }));
    testDb.prepare(`
      UPDATE secretary_source_skill_feedback
      SET updated_at = '2026-05-21T12:34:56.000Z'
      WHERE source_intent_id = 'cooking-monotonic'
    `).run();

    recordSecretarySourceSkillFeedback(feedback({
      agendaItemId: 'cooking-v1-stale',
      sourceIntentId: 'cooking-monotonic',
      agendaVersion: 1,
      status: 'unscheduled',
    }));
    recordSecretarySourceSkillFeedback(feedback({
      agendaItemId: 'cooking-v2-equal-replay',
      sourceIntentId: 'cooking-monotonic',
      agendaVersion: 2,
      status: 'compressed',
    }));

    expect(listSecretarySourceSkillFeedback({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      sourceSkill: 'cooking',
    })).toEqual([expect.objectContaining({
      agendaItemId: 'cooking-v2',
      sourceIntentId: 'cooking-monotonic',
      agendaVersion: 2,
      status: 'reflowed',
      scheduledStart: '2026-05-21T10:00:00.000Z',
      updatedAt: '2026-05-21T12:34:56.000Z',
    })]);
  });

  it('refreshes an equal-version projection only for the same agenda row', () => {
    recordSecretarySourceSkillFeedback(feedback({
      agendaItemId: 'content-user-move-v2',
      sourceIntentId: 'content-user-move',
      sourceSkill: 'content',
      agendaVersion: 2,
      status: 'scheduled',
    }));
    recordSecretarySourceSkillFeedback(feedback({
      agendaItemId: 'content-user-move-v2',
      sourceIntentId: 'content-user-move',
      sourceSkill: 'content',
      agendaVersion: 2,
      status: 'reflowed',
      reasonCodes: ['reflowed_to_available_window'],
      scheduledStart: '2026-05-21T15:00:00.000Z',
      scheduledEnd: '2026-05-21T16:00:00.000Z',
      shouldRefreshSource: true,
    }));

    expect(listSecretarySourceSkillFeedback({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      sourceSkill: 'content',
    })).toEqual([expect.objectContaining({
      agendaItemId: 'content-user-move-v2',
      agendaVersion: 2,
      status: 'reflowed',
      scheduledStart: '2026-05-21T15:00:00.000Z',
    })]);
  });

  it('routes the durable DB-only event and re-reads the exact authoritative agenda version', async () => {
    insertAgendaRow({
      agendaItemId: 'content-agenda-v3',
      sourceIntentId: 'content-durable',
      sourceSkill: 'content',
      version: 3,
      status: 'compressed',
    });
    durableEvent({ agendaItemId: 'content-agenda-v3', version: 3 });

    const result = await processPendingEvents(defaultEventHandlers, {
      limit: 10,
      lockOwner: 'source-feedback-durable-test',
      db: testDb,
    });

    expect(result).toEqual({ processed: 1, failed: 0, deadLetter: 0 });
    expect(listSecretarySourceSkillFeedback({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      sourceSkill: 'content',
    })).toEqual([expect.objectContaining({
      targetSkill: 'content',
      agendaItemId: 'content-agenda-v3',
      sourceIntentId: 'content-durable',
      agendaVersion: 3,
      status: 'compressed',
      shouldRefreshSource: true,
    })]);
  });

  it('keeps the newest exact agenda version under out-of-order durable delivery', () => {
    insertAgendaRow({
      agendaItemId: 'finance-agenda-v1',
      sourceIntentId: 'finance-out-of-order',
      sourceSkill: 'finance',
      version: 1,
      status: 'scheduled',
    });
    insertAgendaRow({
      agendaItemId: 'finance-agenda-v2',
      sourceIntentId: 'finance-out-of-order',
      sourceSkill: 'finance',
      version: 2,
      status: 'reflowed',
    });

    consumeSecretarySourceSkillFeedbackEvent(
      durableEvent({ agendaItemId: 'finance-agenda-v2', version: 2, idempotencySuffix: 'v2-first' }),
      testDb,
    );
    consumeSecretarySourceSkillFeedbackEvent(
      durableEvent({ agendaItemId: 'finance-agenda-v1', version: 1, idempotencySuffix: 'v1-late' }),
      testDb,
    );

    expect(listSecretarySourceSkillFeedback({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      sourceSkill: 'finance',
    })).toEqual([expect.objectContaining({
      agendaItemId: 'finance-agenda-v2',
      agendaVersion: 2,
      status: 'reflowed',
    })]);
  });

  it.each([
    ['event type', { eventType: 'secretary.wrong.v1' }, 'CONTRACT_MISMATCH'],
    ['event source', { sourceSkill: 'training' }, 'CONTRACT_MISMATCH'],
    ['entity type', { entityType: 'wrong_entity' }, 'CONTRACT_MISMATCH'],
    ['schema version', { schemaVersion: 'wrong-schema' }, 'CONTRACT_MISMATCH'],
    ['event version', { eventVersion: 2 }, 'CONTRACT_MISMATCH'],
    ['owner partition', { tenantId: OWNER_USER_ID + 1 }, 'SCOPE_MISMATCH'],
    ['entity version', { entityVersion: 0 }, 'VERSION_MISMATCH'],
  ] as const)('rejects a durable event with mismatched %s', (_label, override, expectedCode) => {
    insertAgendaRow({
      agendaItemId: `cooking-contract-${expectedCode}`,
      sourceIntentId: `cooking-contract-${expectedCode}`,
      sourceSkill: 'cooking',
      version: 1,
    });
    const event = durableEvent({
      agendaItemId: `cooking-contract-${expectedCode}`,
      version: 1,
      idempotencySuffix: String(_label),
    });

    expect(() => consumeSecretarySourceSkillFeedbackEvent({ ...event, ...override } as EventOutboxRecord, testDb))
      .toThrow(`SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_${expectedCode}`);
  });

  it('rejects a wrong exact tenant or an unsupported source skill', () => {
    insertAgendaRow({
      agendaItemId: 'cooking-wrong-tenant',
      sourceIntentId: 'cooking-wrong-tenant',
      sourceSkill: 'cooking',
      version: 1,
    });
    expect(() => consumeSecretarySourceSkillFeedbackEvent(
      durableEvent({ agendaItemId: 'cooking-wrong-tenant', version: 1, agendaTenantId: 'other-tenant' }),
      testDb,
    )).toThrow('SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_SCOPE_MISMATCH');

    insertAgendaRow({
      agendaItemId: 'training-not-generic',
      sourceIntentId: 'training-not-generic',
      sourceSkill: 'training',
      version: 1,
    });
    expect(() => consumeSecretarySourceSkillFeedbackEvent(
      durableEvent({ agendaItemId: 'training-not-generic', version: 1 }),
      testDb,
    )).toThrow('SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_SOURCE_SKILL_UNSUPPORTED');
  });
});
