import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  filterAlreadyAppliedAddColumnStatements,
  stripWrappingTransactionStatements,
} from '../../src/services/migration-runner';

const migration = (name: string): string => readFileSync(
  resolve(__dirname, `../../migrations/${name}.sql`),
  'utf8',
);
const downMigration = (name: string): string => readFileSync(
  resolve(__dirname, `../../migrations/down/${name}.sql`),
  'utf8',
);

const baseSql = migration('083_secretary_agenda_ledger');
const feedbackSql = migration('126_secretary_reasoning_trail');
const claimsSql = migration('278_secretary_agenda_provider_sync_claims');
const rankSql = migration('280_secretary_agenda_arbitration_metadata');
const targetSql = migration('281_secretary_provider_target_and_failure_disposition');
const upSql = migration('282_secretary_agenda_preemption_state');
const downSql = downMigration('282_secretary_agenda_preemption_state');

const POLICY = 'secretary-arbitration-rank-policy.v1';
const NOW = '2026-08-05T08:00:00.000Z';
const FUTURE = '2099-08-05T08:15:00.000Z';
const REQUEST_HASH = 'a'.repeat(64);
const PROVIDER_IDENTITY_HASH = 'b'.repeat(64);

function createPre282Db(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(baseSql);
  db.exec(feedbackSql);
  db.exec(claimsSql);
  db.exec(rankSql);
  db.exec(targetSql);
  return db;
}

interface AgendaSeed {
  id: string;
  intentId: string;
  skill: 'training' | 'cooking' | 'finance' | 'content' | 'secretary';
  version: number;
  lifecycle?: string;
  syncState?: string;
  providerTarget?: 'google' | 'outlook' | null;
  providerSource?: 'google' | 'outlook' | null;
  providerEventId?: string | null;
  score?: number | null;
  deadlineAt?: string | null;
  flexibility?: 'fixed' | 'flexible' | 'compressible' | 'splittable' | null;
  startAt?: string | null;
  endAt?: string | null;
  cancellationReason?: string | null;
  supersededBy?: string | null;
  ownerUserId?: number;
  tenantId?: string;
}

function insertAgenda(db: Database.Database, seed: AgendaSeed): void {
  db.prepare(`
    INSERT INTO secretary_agenda_items (
      agenda_item_id, source_intent_id, source_skill, intent_action,
      owner_user_id, tenant_id, lifecycle_state, provider_sync_state,
      provider_event_id, provider_source, provider_target, version, title,
      start_at, end_at, decision_action, decision_reason_codes_json,
      source_shape_hash, cancellation_reason, superseded_by_agenda_item_id,
      arbitration_score, arbitration_deadline_at, arbitration_flexibility,
      arbitration_policy_version, created_at, updated_at
    ) VALUES (
      @id, @intentId, @skill, 'schedule_this', @ownerUserId, @tenantId,
      @lifecycle, @syncState, @providerEventId, @providerSource,
      @providerTarget, @version, @id, @startAt, @endAt, @decisionAction,
      '[]', @shapeHash, @cancellationReason, @supersededBy, @score,
      @deadlineAt, @flexibility, @policy, @now, @now
    )
  `).run({
    ...seed,
    ownerUserId: seed.ownerUserId ?? 42,
    tenantId: seed.tenantId ?? 'tenant-282',
    lifecycle: seed.lifecycle ?? 'scheduled',
    syncState: seed.syncState ?? 'not_synced',
    providerTarget: seed.providerTarget ?? null,
    providerSource: seed.providerSource ?? null,
    providerEventId: seed.providerEventId ?? null,
    score: seed.score ?? null,
    deadlineAt: seed.deadlineAt ?? null,
    flexibility: seed.flexibility ?? null,
    startAt: seed.startAt ?? null,
    endAt: seed.endAt ?? null,
    cancellationReason: seed.cancellationReason ?? null,
    supersededBy: seed.supersededBy ?? null,
    decisionAction: seed.lifecycle === 'unscheduled' ? 'unscheduled' : 'scheduled',
    shapeHash: `shape-${seed.id}`,
    policy: seed.score == null ? null : POLICY,
    now: NOW,
  });
}

function seedExactPreemptionGraph(
  db: Database.Database,
  options: { priorWinner?: boolean; winnerFlexibility?: 'fixed' | 'flexible' } = {},
): void {
  if (options.priorWinner) {
    insertAgenda(db, {
      id: 'winner-v1', intentId: 'winner-intent', skill: 'training', version: 1,
      lifecycle: 'synced', syncState: 'synced', providerTarget: 'google',
      providerSource: 'google', providerEventId: 'winner-existing-event',
      score: 100, flexibility: options.winnerFlexibility ?? 'flexible',
      startAt: '2026-08-06T10:00:00.000Z', endAt: '2026-08-06T11:00:00.000Z',
    });
  }
  insertAgenda(db, {
    id: options.priorWinner ? 'winner-v2' : 'winner-v1',
    intentId: 'winner-intent', skill: 'training',
    version: options.priorWinner ? 2 : 1,
    lifecycle: 'proposed', providerTarget: 'google', score: 100,
    flexibility: options.winnerFlexibility ?? 'flexible',
    startAt: '2026-08-06T10:00:00.000Z', endAt: '2026-08-06T11:00:00.000Z',
  });
  // Choice A: local truth stays active and mapped until exact provider delete
  // succeeds. The proposed vN+1 replacement has no provider ownership.
  insertAgenda(db, {
    id: 'loser-v1', intentId: 'loser-intent', skill: 'cooking', version: 1,
    lifecycle: 'synced', syncState: 'synced', providerTarget: 'google',
    providerSource: 'google', providerEventId: 'loser-provider-event',
    score: 40, deadlineAt: '2026-08-06T12:00:00.000Z', flexibility: 'flexible',
    startAt: '2026-08-06T10:15:00.000Z', endAt: '2026-08-06T10:45:00.000Z',
  });
  insertAgenda(db, {
    id: 'loser-v2', intentId: 'loser-intent', skill: 'cooking', version: 2,
    lifecycle: 'proposed', syncState: 'not_synced', providerTarget: 'google',
    score: 40, deadlineAt: '2026-08-06T12:00:00.000Z', flexibility: 'flexible',
    startAt: '2026-08-06T10:15:00.000Z', endAt: '2026-08-06T10:45:00.000Z',
    cancellationReason: 'priority_preemption_pending',
  });
}

function insertOperation(db: Database.Database, options: { priorWinner?: boolean; id?: string } = {}): void {
  const id = options.id ?? 'operation-1';
  db.prepare(`
    INSERT INTO secretary_agenda_preemption_operations (
      operation_id, owner_user_id, tenant_id, idempotency_key, request_hash,
      winner_agenda_item_id, winner_agenda_version, winner_source_skill,
      winner_source_intent_id, winner_source_shape_hash,
      winner_final_lifecycle_state, winner_provider_target,
      prior_winner_agenda_item_id, prior_winner_agenda_version,
      prior_winner_provider_source, prior_winner_provider_event_id,
      arbitration_policy_version, state, created_at, updated_at
    ) VALUES (
      @operationId, 42, 'tenant-282', @idempotencyKey, @requestHash,
      @winnerId, @winnerVersion, 'training', 'winner-intent', @winnerShapeHash,
      'scheduled', 'google', @priorWinnerId, @priorWinnerVersion,
      @priorWinnerProviderSource, @priorWinnerProviderEventId,
      @policy, 'cleanup_pending', @now, @now
    )
  `).run({
    operationId: id,
    idempotencyKey: `idempotency-${id}`,
    requestHash: options.id ? 'c'.repeat(64) : REQUEST_HASH,
    winnerId: options.priorWinner ? 'winner-v2' : 'winner-v1',
    winnerVersion: options.priorWinner ? 2 : 1,
    winnerShapeHash: options.priorWinner ? 'shape-winner-v2' : 'shape-winner-v1',
    priorWinnerId: options.priorWinner ? 'winner-v1' : null,
    priorWinnerVersion: options.priorWinner ? 1 : null,
    // Stronger guarantee: a prior winner is not a mapping transfer, but its
    // exact provider identity is frozen on the operation so later cleanup and
    // cancellation cannot target a different event.
    priorWinnerProviderSource: options.priorWinner ? 'google' : null,
    priorWinnerProviderEventId: options.priorWinner ? 'winner-existing-event' : null,
    policy: POLICY,
    now: NOW,
  });
}

function insertDependency(db: Database.Database, options: {
  operationId?: string;
  dependencyId?: string;
  eventId?: string;
} = {}): void {
  db.prepare(`
    INSERT INTO secretary_agenda_preemption_dependencies (
      dependency_id, operation_id, owner_user_id, tenant_id,
      loser_agenda_item_id, loser_agenda_version,
      loser_replacement_agenda_item_id, loser_replacement_version,
      loser_source_skill, loser_source_intent_id, loser_source_shape_hash,
      loser_arbitration_score, loser_arbitration_deadline_at,
      loser_arbitration_flexibility, loser_arbitration_policy_version,
      loser_provider_target, loser_provider_source, loser_provider_event_id,
      provider_identity_hash, state, created_at, updated_at
    ) VALUES (
      @dependencyId, @operationId, 42, 'tenant-282',
      'loser-v1', 1, 'loser-v2', 2, 'cooking', 'loser-intent',
      'shape-loser-v1', 40, '2026-08-06T12:00:00.000Z', 'flexible', @policy,
      'google', 'google', @eventId, @identityHash, 'pending', @now, @now
    )
  `).run({
    dependencyId: options.dependencyId ?? 'dependency-1',
    operationId: options.operationId ?? 'operation-1',
    eventId: options.eventId ?? 'loser-provider-event',
    identityHash: PROVIDER_IDENTITY_HASH,
    policy: POLICY,
    now: NOW,
  });
}

function claimDependency(db: Database.Database, token = 'edge-lease'): void {
  db.prepare(`
    UPDATE secretary_agenda_preemption_dependencies
       SET state = 'in_progress', attempt_count = attempt_count + 1,
           lease_token = ?, lease_expires_at = ?, heartbeat_at = ?,
           failure_disposition = NULL, failure_code = NULL,
           retry_after_at = NULL, updated_at = ?
     WHERE dependency_id = 'dependency-1'
  `).run(token, FUTURE, NOW, NOW);
}

function settleDependencyAndLocalTruth(db: Database.Database, token = 'edge-lease'): void {
  db.transaction(() => {
    db.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'superseded', provider_sync_state = 'deleted',
             provider_event_id = NULL, provider_source = NULL,
             cancellation_reason = 'priority_preempted',
             superseded_by_agenda_item_id = 'loser-v2', updated_at = ?
       WHERE agenda_item_id = 'loser-v1'
    `).run(NOW);
    db.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'unscheduled', provider_sync_state = 'deleted',
             decision_action = 'unscheduled',
             cancellation_reason = 'priority_preempted', updated_at = ?
       WHERE agenda_item_id = 'loser-v2'
    `).run(NOW);
    db.prepare(`
      UPDATE secretary_agenda_preemption_dependencies
         SET state = 'satisfied', lease_token = NULL, lease_expires_at = NULL,
             heartbeat_at = NULL, provider_deleted_at = ?, satisfied_at = ?,
             last_checked_at = ?,
             updated_at = ?
         WHERE dependency_id = 'dependency-1' AND state = 'in_progress'
         AND lease_token = ? AND datetime(lease_expires_at) > datetime(?)
    `).run(NOW, NOW, NOW, NOW, token, NOW);
  })();
}

function activateWinner(db: Database.Database, priorWinner = false): void {
  db.transaction(() => {
    if (priorWinner) {
      db.prepare(`
        UPDATE secretary_agenda_items
           SET lifecycle_state = 'superseded',
               superseded_by_agenda_item_id = 'winner-v2', updated_at = ?
         WHERE agenda_item_id = 'winner-v1'
      `).run(NOW);
    }
    db.prepare(`
      UPDATE secretary_agenda_items SET lifecycle_state = 'scheduled', updated_at = ?
       WHERE agenda_item_id = ?
    `).run(NOW, priorWinner ? 'winner-v2' : 'winner-v1');
    db.prepare(`
      UPDATE secretary_agenda_preemption_operations
         SET state = 'winner_ready', failure_disposition = NULL,
             failure_code = NULL, retry_after_at = NULL, updated_at = ?
       WHERE operation_id = 'operation-1'
    `).run(NOW);
  })();
}

describe('migration 282 Secretary agenda preemption state', () => {
  it('survives the canonical migration-runner trigger and ADD COLUMN transforms', () => {
    const db = createPre282Db();
    try {
      // The runner scans trigger END lines before filtering additive columns;
      // nested CASE expressions must not be mistaken for a transaction END.
      const transformed = filterAlreadyAppliedAddColumnStatements(
        db,
        stripWrappingTransactionStatements(upSql),
      );
      expect(() => db.exec(transformed)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('adds scoped operation/edge state machines, leases, and exact lookup indexes', () => {
    const db = createPre282Db();
    try {
      db.exec(upSql);
      const operationColumns = (db.pragma('table_info(secretary_agenda_preemption_operations)') as Array<{ name: string }>)
        .map(({ name }) => name);
      expect(operationColumns).toEqual(expect.arrayContaining([
        'operation_id', 'owner_user_id', 'tenant_id', 'idempotency_key', 'request_hash',
        'winner_agenda_item_id', 'winner_agenda_version', 'winner_source_skill',
        'winner_source_intent_id', 'winner_source_shape_hash',
        'winner_final_lifecycle_state', 'winner_provider_target',
        'prior_winner_agenda_item_id', 'prior_winner_agenda_version',
        'arbitration_policy_version', 'state', 'failure_disposition',
        'failure_code', 'retry_after_at', 'cancel_requested_at',
        'created_at', 'updated_at', 'completed_at',
      ]));
      const dependencyColumns = (db.pragma('table_info(secretary_agenda_preemption_dependencies)') as Array<{ name: string }>)
        .map(({ name }) => name);
      expect(dependencyColumns).toEqual(expect.arrayContaining([
        'dependency_id', 'operation_id', 'owner_user_id', 'tenant_id',
        'loser_agenda_item_id', 'loser_agenda_version',
        'loser_replacement_agenda_item_id', 'loser_replacement_version',
        'loser_source_skill', 'loser_source_intent_id', 'loser_source_shape_hash',
        'loser_arbitration_score', 'loser_arbitration_deadline_at',
        'loser_arbitration_flexibility', 'loser_arbitration_policy_version',
        'loser_provider_target', 'loser_provider_source', 'loser_provider_event_id',
        'provider_identity_hash', 'state', 'attempt_count', 'lease_token',
        'lease_expires_at', 'heartbeat_at', 'failure_disposition', 'failure_code',
        'retry_after_at', 'provider_deleted_at', 'satisfied_at', 'last_checked_at',
        'created_at', 'updated_at',
      ]));

      const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>;
      expect(indexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
        'idx_secretary_agenda_preemption_operation_request',
        'idx_secretary_agenda_preemption_operation_winner',
        'idx_secretary_agenda_preemption_operation_state',
        'idx_secretary_agenda_preemption_dependency_operation',
        'idx_secretary_agenda_preemption_dependency_cleanup',
        'idx_secretary_agenda_preemption_dependency_lease',
        'idx_secretary_agenda_preemption_dependency_unresolved_event',
      ]));
      const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as Array<{ name: string }>;
      expect(triggers.map(({ name }) => name)).toEqual(expect.arrayContaining([
        'trg_secretary_preemption_operation_insert_guard',
        'trg_secretary_preemption_operation_identity_immutable',
        'trg_secretary_preemption_operation_state_transition',
        'trg_secretary_preemption_operation_winner_ready',
        'trg_secretary_preemption_operation_completed',
        'trg_secretary_preemption_operation_canceled',
        'trg_secretary_preemption_dependency_insert_guard',
        'trg_secretary_preemption_dependency_identity_immutable',
        'trg_secretary_preemption_dependency_state_transition',
        'trg_secretary_preemption_dependency_lease_claim',
        'trg_secretary_preemption_dependency_lease_result',
        'trg_secretary_provider_target_row_immutable',
        'trg_secretary_provider_target_logical_insert',
        'trg_secretary_provider_target_logical_update',
        'trg_secretary_provider_source_target_insert',
        'trg_secretary_provider_source_target_update',
        'trg_secretary_preemption_provider_claim_insert_fence',
        'trg_secretary_preemption_provider_claim_update_fence',
        'trg_secretary_preemption_create_attempt_insert_fence',
        'trg_secretary_preemption_create_attempt_update_fence',
        'trg_secretary_preemption_winner_mapping_fence',
      ]));
    } finally {
      db.close();
    }
  });

  it('hardens provider targets across rows and logical versions while allowing matching repair', () => {
    const db = createPre282Db();
    try {
      db.exec(upSql);
      insertAgenda(db, {
        id: 'target-v1', intentId: 'target-intent', skill: 'finance', version: 1,
        providerTarget: 'google',
      });
      expect(() => db.prepare(`
        UPDATE secretary_agenda_items SET provider_target = 'outlook'
         WHERE agenda_item_id = 'target-v1'
      `).run()).toThrow(/SECRETARY_PROVIDER_TARGET_IMMUTABLE/);
      expect(() => insertAgenda(db, {
        id: 'target-v2-wrong', intentId: 'target-intent', skill: 'finance', version: 2,
        providerTarget: 'outlook',
      })).toThrow(/SECRETARY_PROVIDER_TARGET_IMMUTABLE/);

      insertAgenda(db, {
        id: 'target-v2', intentId: 'target-intent', skill: 'finance', version: 2,
      });
      db.prepare(`UPDATE secretary_agenda_items SET provider_target = 'google' WHERE agenda_item_id = 'target-v2'`).run();
      expect(() => db.prepare(`
        UPDATE secretary_agenda_items SET provider_source = 'outlook'
         WHERE agenda_item_id = 'target-v2'
      `).run()).toThrow(/SECRETARY_PROVIDER_SOURCE_TARGET_MISMATCH/);
      db.prepare(`UPDATE secretary_agenda_items SET provider_source = 'google' WHERE agenda_item_id = 'target-v2'`).run();
      db.prepare(`UPDATE secretary_agenda_items SET provider_source = NULL WHERE agenda_item_id = 'target-v2'`).run();

      insertAgenda(db, { id: 'repair-v1', intentId: 'repair-intent', skill: 'content', version: 1 });
      db.prepare(`UPDATE secretary_agenda_items SET provider_target = 'outlook' WHERE agenda_item_id = 'repair-v1'`).run();
      expect(db.prepare(`SELECT provider_target AS target FROM secretary_agenda_items WHERE agenda_item_id = 'repair-v1'`).get())
        .toEqual({ target: 'outlook' });

      insertAgenda(db, {
        id: 'clean-switch-v1', intentId: 'clean-switch-intent', skill: 'training', version: 1,
        lifecycle: 'superseded', syncState: 'deleted', providerTarget: 'google',
      });
      expect(() => insertAgenda(db, {
        id: 'clean-switch-v2', intentId: 'clean-switch-intent', skill: 'training', version: 2,
        lifecycle: 'scheduled', syncState: 'not_synced', providerTarget: 'outlook',
      })).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('backfills and collapses generic feedback by authoritative agenda version', () => {
    const db = createPre282Db();
    try {
      insertAgenda(db, { id: 'feedback-v1', intentId: 'feedback-intent', skill: 'cooking', version: 1 });
      insertAgenda(db, { id: 'feedback-v2', intentId: 'feedback-intent', skill: 'cooking', version: 2 });
      const insertFeedback = db.prepare(`
        INSERT INTO secretary_source_skill_feedback (
          user_id, tenant_id, target_skill, agenda_item_id, source_intent_id,
          feedback_type, status, updated_at
        ) VALUES (42, 'tenant-282', 'cooking', ?, 'feedback-intent', 'schedule', ?, ?)
      `);
      insertFeedback.run('feedback-v1', 'scheduled', '2026-08-05T12:00:00.000Z');
      insertFeedback.run('feedback-v2', 'unscheduled', '2026-08-05T09:00:00.000Z');
      db.exec(upSql);

      expect(db.prepare(`
        SELECT agenda_item_id AS agendaItemId, agenda_version AS agendaVersion, status
          FROM secretary_source_skill_feedback
         WHERE source_intent_id = 'feedback-intent'
      `).all()).toEqual([{ agendaItemId: 'feedback-v2', agendaVersion: 2, status: 'unscheduled' }]);
      expect(() => db.prepare(`
        INSERT INTO secretary_source_skill_feedback (
          user_id, tenant_id, target_skill, agenda_item_id, source_intent_id,
          feedback_type, status, agenda_version
        ) VALUES (42, 'tenant-282', 'cooking', 'feedback-v3',
          'feedback-intent', 'schedule', 'scheduled', 3)
      `).run()).toThrow(/UNIQUE constraint failed/);
      expect(() => db.prepare(`UPDATE secretary_source_skill_feedback SET agenda_version = 0`).run())
        .toThrow(/CHECK constraint failed/);
      const currentIndex = db.prepare(`
        SELECT name FROM pragma_index_info('idx_secretary_source_skill_feedback_current_intent') ORDER BY seqno
      `).all() as Array<{ name: string }>;
      expect(currentIndex.map(({ name }) => name)).toEqual([
        'user_id', 'tenant_id', 'target_skill', 'source_intent_id',
      ]);
    } finally {
      db.close();
    }
  });

  it('keeps the loser locally busy until exact delete settlement, then opens the winner fence', () => {
    const db = createPre282Db();
    try {
      db.exec(upSql);
      seedExactPreemptionGraph(db);
      insertOperation(db);
      expect(() => insertDependency(db, { eventId: 'wrong-provider-event' }))
        .toThrow(/SECRETARY_PREEMPTION_DEPENDENCY_SCOPE_MISMATCH/);
      insertDependency(db);

      expect(db.prepare(`
        SELECT lifecycle_state AS lifecycle, provider_event_id AS eventId
          FROM secretary_agenda_items WHERE agenda_item_id = 'loser-v1'
      `).get()).toEqual({ lifecycle: 'synced', eventId: 'loser-provider-event' });
      expect(() => activateWinner(db)).toThrow(/SECRETARY_PREEMPTION_DEPENDENCIES_PENDING/);

      // Mixed runtimes must not escape the pre-effect fence by presenting the
      // exact unresolved winner under a provider other than its pinned target.
      expect(() => db.prepare(`
        INSERT INTO secretary_agenda_provider_sync_claims (
          owner_user_id, tenant_id, provider_source, source_skill,
          source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
          lease_token, lease_expires_at, heartbeat_at, created_at, updated_at
        ) VALUES (
          42, 'tenant-282', 'outlook', 'training', 'winner-intent', 'winner-v1', 1,
          'wrong-provider-fingerprint', 'wrong-provider-lease', ?, ?, ?, ?
        )
      `).run(FUTURE, NOW, NOW, NOW)).toThrow(/SECRETARY_PREEMPTION_PROVIDER_DEPENDENCY_PENDING/);
      expect(() => db.prepare(`
        INSERT INTO secretary_agenda_provider_create_reconciliation (
          attempt_id, owner_user_id, tenant_id, provider_source, source_skill,
          source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
          resolution_state, first_observed_at, updated_at
        ) VALUES (
          'wrong-provider-attempt', 42, 'tenant-282', 'outlook', 'training',
          'winner-intent', 'winner-v1', 1, 'wrong-provider-fingerprint',
          'in_flight', ?, ?
        )
      `).run(NOW, NOW)).toThrow(/SECRETARY_PREEMPTION_PROVIDER_DEPENDENCY_PENDING/);

      db.prepare(`
        INSERT INTO secretary_agenda_provider_sync_claims (
          owner_user_id, tenant_id, provider_source, source_skill,
          source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
          lease_token, lease_expires_at, heartbeat_at, created_at, updated_at
        ) VALUES (
          42, 'tenant-282', 'outlook', 'training', 'other-intent', 'other-agenda', 1,
          'other-fingerprint', 'other-lease', ?, ?, ?, ?
        )
      `).run(FUTURE, NOW, NOW, NOW);
      expect(() => db.prepare(`
        UPDATE secretary_agenda_provider_sync_claims
           SET source_intent_id = 'winner-intent', agenda_item_id = 'winner-v1',
               desired_fingerprint = 'wrong-provider-fingerprint'
         WHERE lease_token = 'other-lease'
      `).run()).toThrow(/SECRETARY_PREEMPTION_PROVIDER_DEPENDENCY_PENDING/);

      db.prepare(`
        INSERT INTO secretary_agenda_provider_create_reconciliation (
          attempt_id, owner_user_id, tenant_id, provider_source, source_skill,
          source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
          resolution_state, first_observed_at, updated_at
        ) VALUES (
          'other-provider-attempt', 42, 'tenant-282', 'outlook', 'training',
          'other-intent', 'other-agenda', 1, 'other-fingerprint', 'in_flight', ?, ?
        )
      `).run(NOW, NOW);
      expect(() => db.prepare(`
        UPDATE secretary_agenda_provider_create_reconciliation
           SET source_intent_id = 'winner-intent', agenda_item_id = 'winner-v1',
               desired_fingerprint = 'wrong-provider-fingerprint'
         WHERE attempt_id = 'other-provider-attempt'
      `).run()).toThrow(/SECRETARY_PREEMPTION_PROVIDER_DEPENDENCY_PENDING/);

      const insertClaim = () => db.prepare(`
        INSERT INTO secretary_agenda_provider_sync_claims (
          owner_user_id, tenant_id, provider_source, source_skill,
          source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
          lease_token, lease_expires_at, heartbeat_at, created_at, updated_at
        ) VALUES (
          42, 'tenant-282', 'google', 'training', 'winner-intent', 'winner-v1', 1,
          'fingerprint', 'provider-lease', ?, ?, ?, ?
        )
      `).run(FUTURE, NOW, NOW, NOW);
      expect(insertClaim).toThrow(/SECRETARY_PREEMPTION_PROVIDER_DEPENDENCY_PENDING/);
      expect(() => db.prepare(`
        INSERT INTO secretary_agenda_provider_create_reconciliation (
          attempt_id, owner_user_id, tenant_id, provider_source, source_skill,
          source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
          resolution_state, first_observed_at, updated_at
        ) VALUES (
          'attempt-1', 42, 'tenant-282', 'google', 'training', 'winner-intent',
          'winner-v1', 1, 'fingerprint', 'in_flight', ?, ?
        )
      `).run(NOW, NOW)).toThrow(/SECRETARY_PREEMPTION_PROVIDER_DEPENDENCY_PENDING/);
      expect(() => db.prepare(`
        UPDATE secretary_agenda_items
           SET provider_event_id = 'winner-provider-event', provider_source = 'google',
               provider_sync_state = 'synced'
         WHERE agenda_item_id = 'winner-v1'
      `).run()).toThrow(/SECRETARY_PREEMPTION_PROVIDER_DEPENDENCY_PENDING/);

      claimDependency(db);
      expect(() => db.prepare(`
        UPDATE secretary_agenda_preemption_dependencies
           SET state = 'satisfied', lease_token = NULL, lease_expires_at = NULL,
               heartbeat_at = NULL, provider_deleted_at = ?, updated_at = ?
         WHERE dependency_id = 'dependency-1'
      `).run(NOW, NOW)).toThrow(/SECRETARY_PREEMPTION_LOCAL_SETTLEMENT_REQUIRED/);
      settleDependencyAndLocalTruth(db);
      activateWinner(db);

      expect(db.prepare(`
        SELECT lifecycle_state AS lifecycle, provider_sync_state AS syncState,
               provider_event_id AS eventId
          FROM secretary_agenda_items WHERE agenda_item_id = 'loser-v2'
      `).get()).toEqual({ lifecycle: 'unscheduled', syncState: 'deleted', eventId: null });

      insertClaim();
      db.prepare(`
        INSERT INTO secretary_agenda_provider_create_reconciliation (
          attempt_id, owner_user_id, tenant_id, provider_source, source_skill,
          source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
          resolution_state, first_observed_at, updated_at
        ) VALUES (
          'attempt-1', 42, 'tenant-282', 'google', 'training', 'winner-intent',
          'winner-v1', 1, 'fingerprint', 'in_flight', ?, ?
        )
      `).run(NOW, NOW);
      db.prepare(`
        UPDATE secretary_agenda_items
           SET provider_event_id = 'winner-provider-event', provider_source = 'google',
               provider_sync_state = 'synced', lifecycle_state = 'synced'
         WHERE agenda_item_id = 'winner-v1'
      `).run();
      db.prepare(`
        UPDATE secretary_agenda_preemption_operations
           SET state = 'completed', completed_at = ?, updated_at = ?
         WHERE operation_id = 'operation-1'
      `).run(NOW, NOW);

      expect(db.prepare(`
        SELECT state FROM secretary_agenda_preemption_operations WHERE operation_id = 'operation-1'
      `).get()).toEqual({ state: 'completed' });
      expect(db.prepare(`
        SELECT state, provider_deleted_at AS providerDeletedAt,
               satisfied_at AS satisfiedAt
          FROM secretary_agenda_preemption_dependencies WHERE dependency_id = 'dependency-1'
      `).get()).toEqual({ state: 'satisfied', providerDeletedAt: NOW, satisfiedAt: NOW });
    } finally {
      db.close();
    }
  });

  it('enforces exact edge leases and supports a prior winner without mapping transfer', () => {
    const db = createPre282Db();
    try {
      db.exec(upSql);
      seedExactPreemptionGraph(db, { priorWinner: true });
      insertOperation(db, { priorWinner: true });
      insertDependency(db);
      db.prepare(`
        UPDATE secretary_agenda_preemption_operations
           SET state = 'cleanup_blocked', failure_disposition = 'reconcile',
               failure_code = 'DELETE_OUTCOME_UNKNOWN', updated_at = ?
         WHERE operation_id = 'operation-1'
      `).run(NOW);
      claimDependency(db, 'prior-edge-lease');

      expect(() => db.prepare(`
        UPDATE secretary_agenda_preemption_dependencies
           SET state = 'retryable', lease_token = NULL, lease_expires_at = NULL,
               heartbeat_at = NULL, failure_disposition = 'retryable',
               failure_code = 'DELETE_TIMEOUT', updated_at = ?
         WHERE dependency_id = 'dependency-1' AND lease_token = 'wrong-lease'
      `).run(NOW).changes).not.toBe(1);
      settleDependencyAndLocalTruth(db, 'prior-edge-lease');

      expect(() => db.prepare(`
        UPDATE secretary_agenda_preemption_operations
           SET state = 'winner_ready', updated_at = ?
         WHERE operation_id = 'operation-1'
      `).run(NOW)).toThrow(/SECRETARY_PREEMPTION_PRIOR_WINNER_ACTIVE/);
      activateWinner(db, true);

      expect(db.prepare(`
        SELECT lifecycle_state AS lifecycle, provider_event_id AS eventId
          FROM secretary_agenda_items WHERE agenda_item_id = 'winner-v1'
      `).get()).toEqual({ lifecycle: 'superseded', eventId: 'winner-existing-event' });
      expect(db.prepare(`
        SELECT lifecycle_state AS lifecycle, provider_event_id AS eventId
          FROM secretary_agenda_items WHERE agenda_item_id = 'winner-v2'
      `).get()).toEqual({ lifecycle: 'scheduled', eventId: null });
    } finally {
      db.close();
    }
  });

  it('accepts fixed winners, the full rank tie-break, and a latest inactive prior version', () => {
    const db = createPre282Db();
    try {
      db.exec(upSql);
      seedExactPreemptionGraph(db, { winnerFlexibility: 'fixed' });
      insertOperation(db);

      // Equal scores remain preemptive when the winner has the earlier
      // normalized deadline; loser fixedness remains forbidden separately.
      db.prepare(`
        UPDATE secretary_agenda_items
           SET arbitration_score = 100,
               arbitration_deadline_at = '2026-08-06T13:00:00.000Z'
         WHERE agenda_item_id IN ('loser-v1', 'loser-v2')
      `).run();
      db.prepare(`
        UPDATE secretary_agenda_items
           SET arbitration_deadline_at = '2026-08-06T12:00:00.000Z'
         WHERE agenda_item_id = 'winner-v1'
      `).run();
      db.prepare(`
        UPDATE secretary_agenda_preemption_dependencies
           SET loser_arbitration_score = 100
         WHERE 0
      `).run();
      db.prepare(`
        INSERT INTO secretary_agenda_preemption_dependencies (
          dependency_id, operation_id, owner_user_id, tenant_id,
          loser_agenda_item_id, loser_agenda_version,
          loser_replacement_agenda_item_id, loser_replacement_version,
          loser_source_skill, loser_source_intent_id, loser_source_shape_hash,
          loser_arbitration_score, loser_arbitration_deadline_at,
          loser_arbitration_flexibility, loser_arbitration_policy_version,
          loser_provider_target, loser_provider_source, loser_provider_event_id,
          provider_identity_hash, state, created_at, updated_at
        ) VALUES (
          'dependency-tie', 'operation-1', 42, 'tenant-282',
          'loser-v1', 1, 'loser-v2', 2, 'cooking', 'loser-intent',
          'shape-loser-v1', 100, '2026-08-06T13:00:00.000Z', 'flexible', ?,
          'google', 'google', 'loser-provider-event', ?, 'pending', ?, ?
        )
      `).run(POLICY, PROVIDER_IDENTITY_HASH, NOW, NOW);

      insertAgenda(db, {
        id: 'inactive-prior-v1', intentId: 'inactive-prior-intent', skill: 'content', version: 1,
        lifecycle: 'canceled', providerTarget: 'google', score: 20, flexibility: 'flexible',
      });
      insertAgenda(db, {
        id: 'inactive-prior-v2', intentId: 'inactive-prior-intent', skill: 'content', version: 2,
        lifecycle: 'proposed', providerTarget: 'google', score: 90, flexibility: 'flexible',
      });
      expect(() => db.prepare(`
        INSERT INTO secretary_agenda_preemption_operations (
          operation_id, owner_user_id, tenant_id, idempotency_key, request_hash,
          winner_agenda_item_id, winner_agenda_version, winner_source_skill,
          winner_source_intent_id, winner_source_shape_hash,
          winner_final_lifecycle_state, winner_provider_target,
          arbitration_policy_version, state, created_at, updated_at
        ) VALUES (
          'inactive-prior-operation', 42, 'tenant-282', 'inactive-prior-key', ?,
          'inactive-prior-v2', 2, 'content', 'inactive-prior-intent',
          'shape-inactive-prior-v2', 'scheduled', 'google', ?,
          'cleanup_pending', ?, ?
        )
      `).run('d'.repeat(64), POLICY, NOW, NOW)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('normalizes ISO lease timestamps before accepting a cleanup claim', () => {
    const db = createPre282Db();
    try {
      db.exec(upSql);
      seedExactPreemptionGraph(db);
      insertOperation(db);
      insertDependency(db);
      const expiredIso = db.prepare(`
        SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute') AS value
      `).get() as { value: string };
      expect(() => db.prepare(`
        UPDATE secretary_agenda_preemption_dependencies
           SET state = 'in_progress', attempt_count = 1,
               lease_token = 'expired-lease', lease_expires_at = ?,
               heartbeat_at = ?, updated_at = ?
         WHERE dependency_id = 'dependency-1'
      `).run(expiredIso.value, NOW, NOW)).toThrow(/SECRETARY_PREEMPTION_LEASE_FENCE_VIOLATION/);
    } finally {
      db.close();
    }
  });

  it('treats cancellation as a request until cleanup and winner cancellation are durable', () => {
    const db = createPre282Db();
    try {
      db.exec(upSql);
      seedExactPreemptionGraph(db);
      insertOperation(db);
      insertDependency(db);
      expect(() => db.prepare(`
        UPDATE secretary_agenda_preemption_operations
           SET state = 'canceled', cancel_requested_at = ?, updated_at = ?
         WHERE operation_id = 'operation-1'
      `).run(NOW, NOW)).toThrow(/SECRETARY_PREEMPTION_CANCELLATION_PENDING/);

      claimDependency(db);
      settleDependencyAndLocalTruth(db);
      db.prepare(`
        UPDATE secretary_agenda_items
           SET lifecycle_state = 'canceled', cancellation_reason = 'preemption_canceled',
               updated_at = ?
         WHERE agenda_item_id = 'winner-v1'
      `).run(NOW);
      db.prepare(`
        UPDATE secretary_agenda_preemption_operations
           SET state = 'canceled', cancel_requested_at = ?, updated_at = ?
         WHERE operation_id = 'operation-1'
      `).run(NOW, NOW);
      expect(db.prepare(`
        SELECT state, cancel_requested_at AS cancelRequestedAt
          FROM secretary_agenda_preemption_operations WHERE operation_id = 'operation-1'
      `).get()).toEqual({ state: 'canceled', cancelRequestedAt: NOW });
    } finally {
      db.close();
    }
  });

  it('prevents two unresolved operations from owning the same exact provider identity', () => {
    const db = createPre282Db();
    try {
      db.exec(upSql);
      seedExactPreemptionGraph(db);
      insertOperation(db);
      insertDependency(db);

      insertAgenda(db, {
        id: 'winner-other', intentId: 'winner-other-intent', skill: 'finance', version: 1,
        lifecycle: 'proposed', providerTarget: 'google', score: 110, flexibility: 'flexible',
        startAt: '2026-08-06T10:00:00.000Z', endAt: '2026-08-06T11:00:00.000Z',
      });
      db.prepare(`
        INSERT INTO secretary_agenda_preemption_operations (
          operation_id, owner_user_id, tenant_id, idempotency_key, request_hash,
          winner_agenda_item_id, winner_agenda_version, winner_source_skill,
          winner_source_intent_id, winner_source_shape_hash,
          winner_final_lifecycle_state, winner_provider_target,
          arbitration_policy_version, state, created_at, updated_at
        ) VALUES (
          'operation-2', 42, 'tenant-282', 'idempotency-operation-2', ?,
          'winner-other', 1, 'finance', 'winner-other-intent', 'shape-winner-other',
          'scheduled', 'google', ?, 'cleanup_pending', ?, ?
        )
      `).run('c'.repeat(64), POLICY, NOW, NOW);
      expect(() => insertDependency(db, { operationId: 'operation-2', dependencyId: 'dependency-2' }))
        .toThrow(/UNIQUE constraint failed/);
    } finally {
      db.close();
    }
  });

  it('reverses its schema additions without removing agenda or feedback rows', () => {
    const db = createPre282Db();
    try {
      insertAgenda(db, { id: 'down-agenda', intentId: 'down-intent', skill: 'content', version: 1 });
      db.prepare(`
        INSERT INTO secretary_source_skill_feedback (
          user_id, tenant_id, target_skill, agenda_item_id, source_intent_id,
          feedback_type, status
        ) VALUES (42, 'tenant-282', 'content', 'down-agenda', 'down-intent',
          'content_schedule_confirmed', 'scheduled')
      `).run();
      db.exec(upSql);
      db.exec(downSql);

      expect(db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'secretary_agenda_preemption_%'
      `).all()).toEqual([]);
      expect((db.pragma('table_info(secretary_source_skill_feedback)') as Array<{ name: string }>)
        .map(({ name }) => name)).not.toContain('agenda_version');
      expect(db.prepare(`SELECT agenda_item_id AS id FROM secretary_agenda_items WHERE agenda_item_id = 'down-agenda'`).get())
        .toEqual({ id: 'down-agenda' });
      expect(db.prepare(`SELECT agenda_item_id AS id FROM secretary_source_skill_feedback WHERE source_intent_id = 'down-intent'`).get())
        .toEqual({ id: 'down-agenda' });

      // The down migration removes 282's hardening triggers, leaving migration
      // 281's additive provider_target column intact.
      db.prepare(`UPDATE secretary_agenda_items SET provider_target = 'google' WHERE agenda_item_id = 'down-agenda'`).run();
      db.prepare(`UPDATE secretary_agenda_items SET provider_target = 'outlook' WHERE agenda_item_id = 'down-agenda'`).run();
    } finally {
      db.close();
    }
  });
});
