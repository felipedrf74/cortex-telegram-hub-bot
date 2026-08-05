import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TRAINING_MIGRATIONS = [
  '023_fitness_training_plans.sql',
  '081_training_agenda_event_ownership.sql',
  '082_training_session_identity_shape_hash.sql',
  '099_training_agenda_ownership_tenant_scope.sql',
  '140_training_tenant_id.sql',
  '199_drop_stale_training_agenda_unique_index.sql',
  '215_training_agenda_ownership_sync_metadata.sql',
] as const;

const migrationPath = (name: string) => path.resolve(__dirname, '../../migrations', name);

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
  getSecretaryAgendaItemById,
  markSecretaryAgendaProviderSyncSatisfied,
  submitSecretarySchedulingIntent,
  type SecretarySchedulingIntent,
} from '../../src/services/secretary-scheduling-arbitrator';

const USER_ID = 42;
const TENANT_ID = '42';
const PLAN_ID = 240;
const WEEK_ID = 241;
const EVENT_ID = 'google-training-reused';
const STABLE_KEY = 'plan:240|week:1|day:wednesday|type:running|slot:1';
const STABLE_SHAPE = 'stable-session-shape';

beforeEach(() => {
  testDb = new Database(':memory:');
  for (const migration of TRAINING_MIGRATIONS) {
    testDb.exec(fs.readFileSync(migrationPath(migration), 'utf8'));
  }
  testDb.exec(fs.readFileSync(migrationPath('083_secretary_agenda_ledger.sql'), 'utf8'));
  testDb.exec(fs.readFileSync(migrationPath('098_secretary_decision_explanation.sql'), 'utf8'));
  testDb.exec(fs.readFileSync(migrationPath('126_secretary_reasoning_trail.sql'), 'utf8'));
  testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
  testDb.exec(fs.readFileSync(migrationPath('220_secretary_agenda_provider_sync_failure_count.sql'), 'utf8'));
  testDb.exec(fs.readFileSync(migrationPath('224_secretary_agenda_sync_fingerprint.sql'), 'utf8'));
  testDb.exec(fs.readFileSync(migrationPath('276_training_secretary_feedback_durability.sql'), 'utf8'));
  testDb.exec(fs.readFileSync(migrationPath('278_secretary_agenda_provider_sync_claims.sql'), 'utf8'));
  testDb.exec(fs.readFileSync(migrationPath('280_secretary_agenda_arbitration_metadata.sql'), 'utf8'));
  testDb.exec(fs.readFileSync(migrationPath('281_secretary_provider_target_and_failure_disposition.sql'), 'utf8'));
  // Production mapping/preemption fences are part of the proof. A hand-made
  // subset can pass while migration 282 rejects the same transfer.
  testDb.exec(fs.readFileSync(migrationPath('282_secretary_agenda_preemption_state.sql'), 'utf8'));
});

afterEach(() => {
  testDb.close();
});

function insertPlan(planVersion: number): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans (
      id, user_id, tenant_id, name, sport, duration_weeks, status,
      start_date, end_date, plan_version
    ) VALUES (?, ?, ?, 'Training adoption', 'running', 4, 'active', '2026-05-04', '2026-05-31', ?)
  `).run(PLAN_ID, USER_ID, Number(TENANT_ID), planVersion);
  testDb.prepare(`
    INSERT INTO training_weeks (id, plan_id, week_number, focus, volume_sessions)
    VALUES (?, ?, 1, 'build', 3)
  `).run(WEEK_ID, PLAN_ID);
}

function insertSession(input: {
  sessionId: number;
  calendarEventId?: string | null;
  calendarSource?: 'google' | 'outlook' | null;
  identityKey?: string | null;
  shapeHash?: string | null;
}): void {
  testDb.prepare(`
    INSERT INTO training_sessions (
      id, week_id, plan_id, tenant_id, day_of_week, session_type, title,
      duration_minutes, calendar_event_id, calendar_source,
      session_identity_key, session_shape_hash
    ) VALUES (?, ?, ?, ?, 'Wednesday', 'running', 'Tempo run', 60, ?, ?, ?, ?)
  `).run(
    input.sessionId,
    WEEK_ID,
    PLAN_ID,
    Number(TENANT_ID),
    input.calendarEventId ?? null,
    input.calendarSource ?? null,
    input.identityKey ?? STABLE_KEY,
    input.shapeHash ?? STABLE_SHAPE,
  );
}

function insertOwnership(input: {
  planVersion: number;
  sessionId: number | null;
  userId?: number;
  tenantId?: number;
  identityKey?: string | null;
  shapeHash?: string | null;
  status?: 'active' | 'deleted' | 'orphaned';
}): void {
  testDb.prepare(`
    INSERT INTO training_agenda_event_ownership (
      plan_id, plan_version, session_id, user_id, tenant_id,
      calendar_event_id, calendar_source, status,
      session_identity_key, session_shape_hash
    ) VALUES (?, ?, ?, ?, ?, ?, 'google', ?, ?, ?)
  `).run(
    PLAN_ID,
    input.planVersion,
    input.sessionId,
    input.userId ?? USER_ID,
    input.tenantId ?? Number(TENANT_ID),
    EVENT_ID,
    input.status ?? 'active',
    input.identityKey ?? STABLE_KEY,
    input.shapeHash ?? STABLE_SHAPE,
  );
}

function trainingIntent(planVersion: number, sessionId: number, day: number): SecretarySchedulingIntent {
  return {
    intentId: `training:${PLAN_ID}:${planVersion}:${sessionId}`,
    sourceSkill: 'training',
    sourceAction: 'schedule_session',
    sourceEntityId: String(sessionId),
    sourceEntityType: 'training_session',
    ownerUserId: USER_ID,
    tenantId: TENANT_ID,
    providerTarget: 'google',
    title: 'Tempo run',
    requestedDurationMinutes: 60,
    preferredWindows: [{
      start: `2026-05-${String(day).padStart(2, '0')}T07:00:00.000Z`,
      end: `2026-05-${String(day).padStart(2, '0')}T08:00:00.000Z`,
    }],
    priority: 'high',
    flexibility: 'fixed',
  };
}

function transferOptions(now = '2026-05-01T09:00:00.000Z') {
  return {
    now,
    providerMappingTransfer: {
      providerEventId: EVENT_ID,
      providerSource: 'google' as const,
    },
  };
}

function seedMappedPriorVersion(): { agendaItemId: string; version: number } {
  const prior = submitSecretarySchedulingIntent(trainingIntent(1, 242, 5), {
    now: '2026-05-01T08:00:00.000Z',
  });
  markSecretaryAgendaProviderSyncSatisfied({
    agendaItemId: prior.agendaItem.agendaItemId,
    ownerUserId: USER_ID,
    tenantId: TENANT_ID,
    providerEventId: EVENT_ID,
    providerSource: 'google',
    now: '2026-05-01T08:05:00.000Z',
  });
  return {
    agendaItemId: prior.agendaItem.agendaItemId,
    version: prior.agendaItem.version,
  };
}

function seedPreemptionLock(
  prior: { agendaItemId: string; version: number },
  state: 'cleanup_pending' | 'terminal_failure',
): void {
  const priorRow = testDb.prepare(`
    SELECT source_intent_id AS sourceIntentId,
           source_shape_hash AS sourceShapeHash
      FROM secretary_agenda_items
     WHERE agenda_item_id = ? AND version = ?
  `).get(prior.agendaItemId, prior.version) as {
    sourceIntentId: string;
    sourceShapeHash: string;
  };
  const winnerAgendaItemId = 'preemption-proposed-winner';
  testDb.prepare(`
    INSERT INTO secretary_agenda_items (
      agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
      source_entity_id, source_entity_type, owner_user_id, tenant_id,
      lifecycle_state, provider_sync_state, provider_event_id, provider_source,
      version, title, start_at, end_at, duration_minutes, decision_action,
      decision_reason_codes_json, decision_explanation, source_shape_hash,
      scheduled_segments_json, cancellation_reason, superseded_by_agenda_item_id,
      created_at, updated_at, completed_at, source_created_at, source_updated_at,
      reasoning_trail_json, arbitration_score, arbitration_deadline_at,
      arbitration_flexibility, arbitration_policy_version, provider_target,
      provider_sync_failure_disposition, provider_sync_retry_after_at
    ) VALUES (
      ?, ?, 'training', 'schedule_session', 'schedule_this',
      '243', 'training_session', ?, ?,
      'proposed', 'not_synced', NULL, NULL,
      2, 'Preemption winner', '2026-05-05T09:00:00.000Z', '2026-05-05T10:00:00.000Z',
      60, 'scheduled', '["priority_preemption_applied"]', 'Pending exact cleanup', ?,
      '[]', 'priority_preemption_pending', NULL,
      '2026-05-01T08:10:00.000Z', '2026-05-01T08:10:00.000Z', NULL, NULL, NULL,
      NULL, 100, NULL, 'fixed', 'secretary-arbitration-rank-policy.v1', 'google',
      NULL, NULL
    )
  `).run(
    winnerAgendaItemId,
    priorRow.sourceIntentId,
    USER_ID,
    TENANT_ID,
    priorRow.sourceShapeHash,
  );
  testDb.prepare(`
    INSERT INTO secretary_agenda_preemption_operations (
      operation_id, owner_user_id, tenant_id, idempotency_key, request_hash,
      winner_agenda_item_id, winner_agenda_version, winner_source_skill,
      winner_source_intent_id, winner_source_shape_hash,
      winner_final_lifecycle_state, winner_provider_target,
      prior_winner_agenda_item_id, prior_winner_agenda_version,
      prior_winner_provider_source, prior_winner_provider_event_id,
      arbitration_policy_version, state, created_at, updated_at
    ) VALUES (
      'mapping-adoption-lock', ?, ?, 'mapping-adoption-lock', ?,
      ?, 2, 'training', ?, ?, 'scheduled', 'google',
      ?, ?, 'google', ?, 'secretary-arbitration-rank-policy.v1',
      'cleanup_pending', '2026-05-01T08:10:00.000Z', '2026-05-01T08:10:00.000Z'
    )
  `).run(
    USER_ID,
    TENANT_ID,
    'a'.repeat(64),
    winnerAgendaItemId,
    priorRow.sourceIntentId,
    priorRow.sourceShapeHash,
    prior.agendaItemId,
    prior.version,
    EVENT_ID,
  );
  if (state === 'terminal_failure') {
    testDb.prepare(`
      UPDATE secretary_agenda_preemption_operations
         SET state = 'terminal_failure',
             failure_disposition = 'terminal',
             failure_code = 'PROVIDER_TERMINAL',
             updated_at = '2026-05-01T08:11:00.000Z'
       WHERE operation_id = 'mapping-adoption-lock'
    `).run();
  }
}

describe('Secretary Training provider-mapping adoption', () => {
  it('adopts an exact legacy session link when no Secretary agenda row exists yet', () => {
    insertPlan(1);
    insertSession({ sessionId: 242, calendarEventId: EVENT_ID, calendarSource: 'google' });

    const adopted = submitSecretarySchedulingIntent(trainingIntent(1, 242, 7), transferOptions());

    expect(adopted.agendaItem).toMatchObject({
      providerEventId: EVENT_ID,
      providerSource: 'google',
      providerTarget: 'google',
      providerSyncState: 'not_synced',
    });
  });

  it('moves a prior-version mapping to a new session only through active identity-and-shape ownership', () => {
    insertPlan(1);
    insertSession({ sessionId: 242, calendarEventId: EVENT_ID, calendarSource: 'google' });
    insertOwnership({ planVersion: 1, sessionId: 242 });
    const prior = seedMappedPriorVersion();
    testDb.prepare('UPDATE fitness_training_plans SET plan_version = 2 WHERE id = ?').run(PLAN_ID);
    insertSession({ sessionId: 244 });

    const adopted = submitSecretarySchedulingIntent(trainingIntent(2, 244, 7), transferOptions());
    const previous = getSecretaryAgendaItemById({
      agendaItemId: prior.agendaItemId,
      ownerUserId: USER_ID,
      tenantId: TENANT_ID,
    });

    expect(previous).toMatchObject({
      lifecycleState: 'superseded',
      providerSyncState: 'deleted',
      providerEventId: null,
      providerSource: null,
    });
    expect(previous?.supersededByAgendaItemId).toBe(adopted.agendaItem.agendaItemId);
    expect(adopted.agendaItem).toMatchObject({
      providerEventId: EVENT_ID,
      providerSource: 'google',
      providerSyncState: 'not_synced',
    });
  });

  it.each([
    ['wrong-session ownership without matching identity', {
      sessionId: 999,
      identityKey: 'different-key',
      shapeHash: 'different-shape',
      status: 'active' as const,
    }],
    ['deleted ownership', {
      sessionId: 244,
      identityKey: STABLE_KEY,
      shapeHash: STABLE_SHAPE,
      status: 'deleted' as const,
    }],
    ['foreign-scope ownership', {
      sessionId: 244,
      userId: 99,
      tenantId: 99,
      identityKey: STABLE_KEY,
      shapeHash: STABLE_SHAPE,
      status: 'active' as const,
    }],
    ['same-version sideways identity collision', {
      planVersion: 2,
      sessionId: 999,
      identityKey: STABLE_KEY,
      shapeHash: STABLE_SHAPE,
      status: 'active' as const,
    }],
  ])('rejects %s as provider-mapping authority', (_label, ownership) => {
    insertPlan(2);
    insertSession({ sessionId: 244 });
    insertOwnership({ planVersion: 1, ...ownership });

    expect(() => submitSecretarySchedulingIntent(
      trainingIntent(2, 244, 7),
      transferOptions(),
    )).toThrow('SECRETARY_PROVIDER_MAPPING_TRANSFER_MISMATCH');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM secretary_agenda_items').get()).toEqual({ count: 0 });
  });

  it.each(['claim', 'recovery', 'preemption', 'terminal_preemption'] as const)(
    'refuses transfer while the prior exact mapping has unresolved %s work',
    (unsafeKind) => {
      insertPlan(1);
      insertSession({ sessionId: 242, calendarEventId: EVENT_ID, calendarSource: 'google' });
      insertOwnership({ planVersion: 1, sessionId: 242 });
      const prior = seedMappedPriorVersion();
      testDb.prepare('UPDATE fitness_training_plans SET plan_version = 2 WHERE id = ?').run(PLAN_ID);
      insertSession({ sessionId: 244 });

      if (unsafeKind === 'claim') {
        testDb.prepare(`
          INSERT INTO secretary_agenda_provider_sync_claims (
            owner_user_id, tenant_id, provider_source, source_skill, source_intent_id,
            agenda_item_id, agenda_version, desired_fingerprint,
            lease_token, lease_expires_at, heartbeat_at, attempt_count, created_at, updated_at
          ) SELECT owner_user_id, tenant_id, 'google', source_skill, source_intent_id,
                   agenda_item_id, version, 'mapping-adoption-fingerprint',
                   'mapping-adoption-lease', '2099-01-01T00:00:00.000Z',
                   '2026-05-01T08:10:00.000Z', 1,
                   '2026-05-01T08:10:00.000Z', '2026-05-01T08:10:00.000Z'
              FROM secretary_agenda_items
             WHERE agenda_item_id = ? AND version = ?
        `).run(prior.agendaItemId, prior.version);
      } else if (unsafeKind === 'recovery') {
        testDb.prepare(`
          INSERT INTO secretary_agenda_provider_effect_recovery (
            recovery_id, owner_user_id, tenant_id, provider_source,
            source_skill, source_intent_id, agenda_item_id, agenda_version,
            desired_fingerprint, provider_event_id, effect_kind, resolution_state,
            created_at, updated_at
          ) SELECT 'mapping-adoption-recovery', owner_user_id, tenant_id, 'google',
                   source_skill, source_intent_id, agenda_item_id, version,
                   'mapping-adoption-fingerprint', ?, 'update', 'pending',
                   '2026-05-01T08:10:00.000Z', '2026-05-01T08:10:00.000Z'
              FROM secretary_agenda_items
             WHERE agenda_item_id = ? AND version = ?
        `).run(EVENT_ID, prior.agendaItemId, prior.version);
      } else {
        const operationState = unsafeKind === 'terminal_preemption'
          ? 'terminal_failure'
          : 'cleanup_pending';
        seedPreemptionLock(prior, operationState);
      }

      expect(() => submitSecretarySchedulingIntent(
        trainingIntent(2, 244, 7),
        transferOptions(),
      )).toThrow('SECRETARY_PROVIDER_MAPPING_TRANSFER_BUSY');
      expect(getSecretaryAgendaItemById({
        agendaItemId: prior.agendaItemId,
        ownerUserId: USER_ID,
        tenantId: TENANT_ID,
      })).toMatchObject({
        lifecycleState: 'synced',
        providerSyncState: 'synced',
        providerEventId: EVENT_ID,
        providerSource: 'google',
      });
    },
  );
});
