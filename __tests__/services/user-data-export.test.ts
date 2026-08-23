/**
 * Tests for src/services/user-data-export.ts
 *
 * Validates:
 * - Per-user finance data export (with encryption round-trip)
 * - Per-user data deletion (right to erasure)
 * - Data isolation between users in export
 * - Record counting
 * - Full GDPR export across ALL tables
 * - Full GDPR delete across ALL tables
 * - Audit trail integration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { createMigratedDatabaseWithLegacySavedIdeas } from '../helpers/legacy-saved-ideas-fixture';
import Database from 'better-sqlite3';
import { vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONTENT_TOPICS_WORKSPACE_EXIT_UP = readFileSync(
  resolve(process.cwd(), 'migrations/247_content_topics_workspace_exit.sql'),
  'utf8',
);

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    financeEncryption: {
      enabled: true,
      masterKey: 'test-export-master-key-for-tests!',
    },
    // Sign in with Apple revocation starts UNCONFIGURED, which is production
    // truth today. Tests that need the configured path opt in explicitly via
    // configureAppleRevocationCredentials().
    appleSignIn: { teamId: '', keyId: '', privateKey: '', clientId: 'me.nexushub.app' },
  },
}));

import { addTransaction, calculateAndStoreTax, markTaxPaid } from '../../src/services/finance-tracker';
import {
  exportUserFinanceData, deleteUserFinanceData, countUserFinanceData,
  exportAllUserData, deleteAllUserData, deleteAllUserDataForAccountDeletion,
  getAccountDeletionInventoryForUser,
  revokeThirdPartyOAuthTokensForUser,
} from '../../src/services/user-data-export';
import { logAudit, getAuditTrail } from '../../src/services/audit-trail';
import { config } from '../../src/config';
import { encryptValue } from '../../src/utils/encryption';
import { encryptTrainingProfileSnapshot } from '../../src/services/training-profile-snapshot-encryption';
import { createContentArtifact, createContentWorkspaceItem } from '../../src/services/content-workspace';
import { recordContentPerformanceOutcome } from '../../src/services/content-performance-lineage';

function seedCanonicalContentItem(input: {
  tenantId: number;
  userId: number;
  title: string;
}): number {
  return createContentWorkspaceItem({
    scope: { tenantId: input.tenantId, userId: input.userId },
    itemType: 'content_item',
    title: input.title,
    idempotencyKey: `export-fixture:${input.tenantId}:${input.userId}:${input.title}`,
  }, testDb).value.id;
}

function replaceTestDatabaseWithLegacySavedIdeas(
  seed: (database: Database.Database) => void,
): void {
  testDb.close();
  testDb = createMigratedDatabaseWithLegacySavedIdeas(seed);
}

function seedCanonicalPerformanceTarget(input: {
  tenantId: number;
  userId: number;
  suffix: string;
}): { itemId: number; artifactId: number; revisionId: number } {
  const scope = { tenantId: input.tenantId, userId: input.userId };
  const item = createContentWorkspaceItem({
    scope,
    itemType: 'content_item',
    title: `Performance ${input.suffix}`,
    idempotencyKey: `performance-export-item-${input.suffix}-001`,
  }, testDb).value;
  const artifact = createContentArtifact({
    scope,
    itemId: item.id,
    expectedWorkflowVersion: item.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'markdown', text: `Script ${input.suffix}` },
    idempotencyKey: `performance-export-artifact-${input.suffix}-001`,
  }, testDb).value;
  return {
    itemId: item.id,
    artifactId: artifact.id,
    revisionId: artifact.currentRevisionId!,
  };
}

const EXPORT_MASTER_KEY = 'test-export-master-key-for-tests!';
const APPLE_TEST_P8_PEM = createSignInWithAppleTestKey();

function createSignInWithAppleTestKey(): string {
  const { privateKey } = require('node:crypto').generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function configureAppleRevocationCredentials(): void {
  config.appleSignIn.teamId = 'TEAM123456';
  config.appleSignIn.keyId = 'KEY7890123';
  config.appleSignIn.privateKey = APPLE_TEST_P8_PEM;
}

function clearAppleRevocationCredentials(): void {
  config.appleSignIn.teamId = '';
  config.appleSignIn.keyId = '';
  config.appleSignIn.privateKey = '';
}

/** Mark a seeded user as having signed in with Apple. */
function markUserAsAppleSignIn(db: Database.Database, telegramId: number): void {
  db.prepare('UPDATE users SET apple_user_id = ? WHERE telegram_id = ?')
    .run(`apple-sub-${telegramId}`, telegramId);
}

/** Seed the encrypted Apple refresh token that makes remote revocation possible. */
function seedAppleRefreshToken(
  db: Database.Database,
  userId: number,
  refreshToken = 'apple-refresh-secret',
): void {
  db.prepare(`
    INSERT INTO apple_sign_in_refresh_tokens (user_id, apple_user_id, client_id, encrypted_refresh_token)
    VALUES (?, ?, 'me.nexushub.app', ?)
  `).run(userId, `apple-sub-${userId}`, encryptValue(refreshToken, EXPORT_MASTER_KEY, userId));
}

// ── Helper: seed a user record ──
function seedUser(db: Database.Database, telegramId: number, opts?: { username?: string; language?: string }) {
  try {
    db.prepare(`
      INSERT INTO users (telegram_id, username, first_name, language, timezone, tier, status)
      VALUES (?, ?, 'Test', ?, 'Europe/Lisbon', 'free', 'active')
    `).run(telegramId, opts?.username ?? 'testuser', opts?.language ?? 'en-US');
  } catch { /* table may not exist */ }
}

function seedTrainingM4CapacitySnapshot(
  db: Database.Database,
  input: { userId: number; snapshotId: string; conflictCount?: number },
): void {
  db.prepare(`
    INSERT INTO training_m4_capacity_snapshots (
      snapshot_id, tenant_id, user_id, schema_version, context_version,
      idempotency_key, request_hash, profile_source_version,
      calendar_event_set_hash, provider_sources_json, provider_status,
      plan_start_date, plan_end_date, horizon_weeks,
      range_start_at, range_end_at, profile_windows_json,
      capacity_windows_json, conflict_count, observed_at, expires_at
    ) VALUES (
      ?, ?, ?, 'training-m4-capacity-snapshot.v1', ?,
      ?, ?, ?, ?, '["google"]', 'ready',
      '2026-08-03', '2026-08-30', 4,
      '2026-08-03T00:00:00.000Z', '2026-08-31T00:00:00.000Z',
      '[{"day":"monday","start":"06:00","end":"08:00"}]',
      '[{"day":"monday","start":"06:00","end":"07:30"}]',
      ?, '2026-07-14T09:00:00.000Z', '2026-07-14T09:05:00.000Z'
    )
  `).run(
    input.snapshotId,
    input.userId,
    input.userId,
    `m4_capacity_context_${input.snapshotId}`,
    `refresh-${input.snapshotId}`,
    '1'.repeat(64),
    `m4_profile_source_${input.userId}_${input.snapshotId}`,
    '2'.repeat(64),
    input.conflictCount ?? 1,
  );
}

// ── Helper: seed data across multiple tables ──
function seedUserData(db: Database.Database, userId: number) {
  try {
    db.prepare(`
      INSERT INTO conversations (tenant_id, user_id, visibility_scope, scope_status, created_by, domain, role, content)
      VALUES (?, ?, 'user_private', 'active', ?, ?, ?, ?)
    `).run(userId, userId, userId, 'secretary', 'user', 'Hello bot');
    db.prepare(`
      INSERT INTO conversations (tenant_id, user_id, visibility_scope, scope_status, created_by, domain, role, content)
      VALUES (?, ?, 'user_private', 'active', ?, ?, ?, ?)
    `).run(userId, userId, userId, 'secretary', 'assistant', 'Hi there!');
  } catch { /* table may not exist */ }

  try {
    db.prepare('INSERT INTO todos (user_id, title, status, priority) VALUES (?, ?, ?, ?)')
      .run(userId, 'Buy groceries', 'pending', 'normal');
  } catch { /* table may not exist */ }

  try {
    db.prepare('INSERT INTO reminders (user_id, message, remind_at, status) VALUES (?, ?, ?, ?)')
      .run(userId, 'Call doctor', '2026-04-05T14:00:00', 'active');
  } catch { /* table may not exist */ }

  try {
    db.prepare('INSERT INTO notes (user_id, content, domain) VALUES (?, ?, ?)')
      .run(userId, 'Meeting notes', 'secretary');
  } catch { /* table may not exist */ }

  try {
    db.prepare(`
      INSERT INTO shared_memory (tenant_id, user_id, visibility_scope, scope_status, created_by, key, value, source_domain)
      VALUES (?, ?, 'user_private', 'active', ?, ?, ?, ?)
    `).run(userId, userId, userId, `preference_${userId}`, 'dark mode', 'secretary');
  } catch { /* table may not exist */ }
}

// ── Finance Export Tests (existing) ──

describe('User finance data export', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => { testDb.close(); });

  it('exports all transactions and tax events for a user', () => {
    addTransaction(1, '2024-06-01', 'income', 8000, { description: 'Freelance work' });
    addTransaction(1, '2024-06-10', 'expense', 200);
    calculateAndStoreTax(1, '2024-06');

    const exported = exportUserFinanceData(1);
    expect(exported.userId).toBe(1);
    expect(exported.transactions).toHaveLength(2);
    expect(exported.taxEvents).toHaveLength(1);
    expect(exported.annualSummaries).toHaveLength(1);
    expect(exported.exportedAt).toBeTruthy();
  });

  it('isolates export data between users', () => {
    addTransaction(1, '2024-06-01', 'income', 10000);
    addTransaction(2, '2024-06-01', 'income', 5000);
    calculateAndStoreTax(1, '2024-06');
    calculateAndStoreTax(2, '2024-06');

    const export1 = exportUserFinanceData(1);
    const export2 = exportUserFinanceData(2);

    expect(export1.transactions).toHaveLength(1);
    expect(export2.transactions).toHaveLength(1);
    expect(export1.transactions[0].amount).toBe(10000);
    expect(export2.transactions[0].amount).toBe(5000);
  });

  it('returns decrypted values in export', () => {
    addTransaction(1, '2024-06-01', 'income', 12345.67, { description: 'Encrypted payment' });

    const exported = exportUserFinanceData(1);
    expect(exported.transactions[0].amount).toBe(12345.67);
    expect(exported.transactions[0].description).toBe('Encrypted payment');
  });

  it('exports empty data for user with no records', () => {
    const exported = exportUserFinanceData(999);
    expect(exported.transactions).toHaveLength(0);
    expect(exported.taxEvents).toHaveLength(0);
    expect(exported.annualSummaries).toHaveLength(0);
  });
});

describe('User finance data deletion', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => { testDb.close(); });

  it('deletes all financial data for a user', () => {
    addTransaction(1, '2024-06-01', 'income', 8000);
    addTransaction(1, '2024-06-10', 'expense', 200);
    calculateAndStoreTax(1, '2024-06');

    const result = deleteUserFinanceData(1);
    expect(result.transactionsDeleted).toBe(2);
    expect(result.taxEventsDeleted).toBeGreaterThanOrEqual(1);

    const counts = countUserFinanceData(1);
    expect(counts.transactions).toBe(0);
    expect(counts.taxEvents).toBe(0);
  });

  it('does not affect other users when deleting', () => {
    addTransaction(1, '2024-06-01', 'income', 8000);
    addTransaction(2, '2024-06-01', 'income', 5000);

    deleteUserFinanceData(1);

    const counts1 = countUserFinanceData(1);
    const counts2 = countUserFinanceData(2);
    expect(counts1.transactions).toBe(0);
    expect(counts2.transactions).toBe(1);
  });

  it('returns zeros when deleting user with no data', () => {
    const result = deleteUserFinanceData(999);
    expect(result.transactionsDeleted).toBe(0);
    expect(result.taxEventsDeleted).toBe(0);
  });
});

describe('countUserFinanceData', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => { testDb.close(); });

  it('counts transactions and tax events', () => {
    addTransaction(1, '2024-06-01', 'income', 8000);
    addTransaction(1, '2024-06-10', 'expense', 200);
    calculateAndStoreTax(1, '2024-06');

    const counts = countUserFinanceData(1);
    expect(counts.transactions).toBe(2);
    expect(counts.taxEvents).toBe(1);
  });

  it('returns zeros for user with no data', () => {
    const counts = countUserFinanceData(999);
    expect(counts.transactions).toBe(0);
    expect(counts.taxEvents).toBe(0);
  });
});

// ── Full Export Tests (GDPR Article 20) ──

describe('exportAllUserData', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => { testDb.close(); });

  it('exports conversations for the correct user', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);

    const exported = exportAllUserData(1);
    expect(exported.conversations).toHaveLength(2);
    expect(exported.conversations[0].domain).toBe('secretary');
  });

  it('includes the billing evidence in subject access: ledger rows and matched Apple inbox metadata (NH-0041)', () => {
    seedUser(testDb, 1);
    seedUser(testDb, 2);
    testDb.prepare(`
      INSERT INTO ai_credit_lots (user_id, lot_type, credits_granted, granted_at, expires_at,
                                  source_kind, source_ref, provider, provider_transaction_id)
      VALUES (1, 'purchased', 100, '2026-08-01T00:00:00.000Z', NULL,
              'provider_purchase', 'apple:tx-mine', 'apple', 'tx-mine')
    `).run();
    testDb.prepare(`
      INSERT INTO ai_credit_lots (user_id, lot_type, credits_granted, granted_at, expires_at,
                                  source_kind, source_ref, provider, provider_transaction_id)
      VALUES (2, 'purchased', 250, '2026-08-01T00:00:00.000Z', NULL,
              'provider_purchase', 'apple:tx-other', 'apple', 'tx-other')
    `).run();
    testDb.prepare(`
      INSERT INTO ai_credit_reservations (user_id, operation_class, credits, state, tenant_scope,
                                          workload, request_hash, client_operation_id, reserved_at, reserved_day)
      VALUES (1, 'standard', 1, 'captured', 'tenant-1', 'chat', 'h1', 'op1', '2026-08-02T00:00:00.000Z', '2026-08-02')
    `).run();

    const jwsPayload = (inner) => {
      const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
      const innerJws = ['h', enc(inner), 's'].join('.');
      return ['h', enc({ data: { signedTransactionInfo: innerJws } }), 's'].join('.');
    };
    const insertInbox = testDb.prepare(`
      INSERT INTO apple_notification_inbox (notification_uuid, notification_type, environment, state,
                                            signed_payload, product_id, received_at)
      VALUES (?, ?, 'Production', 'processed', ?, ?, '2026-08-01T01:00:00.000Z')
    `);
    insertInbox.run('uuid-mine', 'ONE_TIME_CHARGE', jwsPayload({ transactionId: 'tx-mine' }), 'me.nexushub.pack100');
    insertInbox.run('uuid-other', 'ONE_TIME_CHARGE', jwsPayload({ transactionId: 'tx-other' }), 'me.nexushub.pack100');

    const exported = exportAllUserData(1);
    expect(exported.billing.aiCreditLots).toHaveLength(1);
    expect(exported.billing.aiCreditLots[0]).toMatchObject({ providerTransactionId: 'tx-mine' });
    expect(exported.billing.aiCreditReservations).toHaveLength(1);
    expect(exported.billing.appleNotifications).toHaveLength(1);
    expect(exported.billing.appleNotifications[0]).toMatchObject({
      notificationType: 'ONE_TIME_CHARGE',
      productId: 'me.nexushub.pack100',
    });
    // Metadata only: the signed payload itself is never exported.
    expect(exported.billing.appleNotifications[0]).not.toHaveProperty('signedPayload');

    const other = exportAllUserData(2);
    expect(other.billing.aiCreditLots).toHaveLength(1);
    expect(other.billing.aiCreditLots[0]).toMatchObject({ providerTransactionId: 'tx-other' });
    expect(other.billing.appleNotifications).toHaveLength(1);
  });

  it('exports and erases scoped device-inference metadata without prompt or output fields', () => {
    seedUser(testDb, 1);
    seedUser(testDb, 2);
    const reservation = testDb.prepare(`
      INSERT INTO ai_credit_reservations (
        user_id, operation_class, credits, state, tenant_scope,
        workload, request_hash, client_operation_id, reserved_at, reserved_day
      ) VALUES (?, 'standard', 1, 'reserved', ?, 'device_standard_response', ?, ?,
                '2026-08-23T12:00:00.000Z', '2026-08-23')
    `);
    const mineReservation = Number(reservation.run(1, '1', 'a'.repeat(64), 'device-op-1').lastInsertRowid);
    const otherReservation = Number(reservation.run(2, '2', 'b'.repeat(64), 'device-op-2').lastInsertRowid);
    const admission = testDb.prepare(`
      INSERT INTO device_inference_admissions (
        id, tenant_scope, user_id, device_id, operation_key, request_digest,
        client_operation_id, policy_version, reservation_id, state, issued_at, expires_at
      ) VALUES (?, ?, ?, ?, 'standard_response', ?, ?, 'apple-foundation-models.v1', ?,
                'issued', '2026-08-23T12:00:00.000Z', '2026-08-23T12:10:00.000Z')
    `);
    admission.run('admission-mine', '1', 1, 'device-mine', 'a'.repeat(64), 'device-op-1', mineReservation);
    admission.run('admission-other', '2', 2, 'device-other', 'b'.repeat(64), 'device-op-2', otherReservation);
    const evidence = testDb.prepare(`
      INSERT INTO device_inference_evidence (
        admission_id, tenant_scope, user_id, device_id, operation_key, policy_version,
        outcome, os_version, os_build, device_model, locale, framework_available,
        availability_reason, duration_ms
      ) VALUES (?, ?, ?, ?, 'standard_response', 'apple-foundation-models.v1',
                'completed', 'iOS 27.0', '24A1', ?, 'pt-BR', 1, 'available', 321)
    `);
    evidence.run('admission-mine', '1', 1, 'device-mine', 'iPad14,3');
    evidence.run('admission-other', '2', 2, 'device-other', 'iPhone18,1');

    const exported = exportAllUserData(1);
    expect(exported.deviceInference.admissions).toEqual([
      expect.objectContaining({ id: 'admission-mine', deviceId: 'device-mine' }),
    ]);
    expect(exported.deviceInference.evidence).toEqual([
      expect.objectContaining({ admissionId: 'admission-mine', deviceModel: 'iPad14,3' }),
    ]);
    expect(JSON.stringify(exported.deviceInference)).not.toMatch(/\b(prompt|output)\b/i);

    const counts = deleteAllUserData(1);
    expect(counts.device_inference_evidence).toBe(1);
    expect(counts.device_inference_admissions).toBe(1);
    expect(exportAllUserData(1).deviceInference).toEqual({ admissions: [], evidence: [] });
    expect(exportAllUserData(2).deviceInference.admissions).toHaveLength(1);
    expect(exportAllUserData(2).deviceInference.evidence).toHaveLength(1);
  });

  it('exports only safe, scoped OAuth connection-health metadata', () => {
    seedUser(testDb, 1);
    seedUser(testDb, 2);
    const insert = testDb.prepare(`
      INSERT INTO user_oauth_connection_health (
        user_id, tenant_id, provider, state, reason_code
      ) VALUES (?, ?, ?, 'auth_rejected', ?)
    `);
    insert.run(1, 1, 'google', 'invalid_grant');
    insert.run(2, 2, 'outlook', 'token_expired');

    const exported = exportAllUserData(1);

    expect(exported.oauthConnectionHealth).toEqual([
      expect.objectContaining({
        provider: 'google',
        state: 'auth_rejected',
        reasonCode: 'invalid_grant',
      }),
    ]);
    expect(JSON.stringify(exported.oauthConnectionHealth)).not.toContain('token');
    expect(JSON.stringify(exported.oauthConnectionHealth)).not.toContain('provider response');

    const counts = deleteAllUserData(1);
    expect(counts.user_oauth_connection_health).toBe(1);
    expect(testDb.prepare(`
      SELECT user_id, provider FROM user_oauth_connection_health
      ORDER BY user_id
    `).all()).toEqual([{ user_id: 2, provider: 'outlook' }]);
  });

  it('exports notification decision logs with type from the matching scoped intent', () => {
    testDb.prepare(`
      INSERT INTO notification_intents (
        intent_id, user_id, tenant_id, source_skill, type, priority, title, body
      ) VALUES
        ('intent-export-owner', 1, 1, 'secretary', 'reminder', 'active',
         'Owner reminder', 'Owner body'),
        ('intent-export-other', 2, 2, 'security', 'security_account', 'time_sensitive',
         'Other security alert', 'Other body')
    `).run();
    testDb.prepare(`
      INSERT INTO notification_decision_logs (
        decision_log_id, intent_id, user_id, tenant_id, source_skill,
        decision, priority, reason, created_at
      ) VALUES
        ('log-export-owner', 'intent-export-owner', 1, 1, 'secretary',
         'sent_push', 'active', 'pushable', '2026-08-01T10:00:00.000Z'),
        ('log-export-scope-mismatch', 'intent-export-other', 1, 1, 'secretary',
         'in_app_only', 'active', 'policy_blocked', '2026-08-01T10:01:00.000Z'),
        ('log-export-other', 'intent-export-other', 2, 2, 'security',
         'sent_push', 'time_sensitive', 'pushable', '2026-08-01T10:02:00.000Z')
    `).run();

    const exported = exportAllUserData(1);

    expect(exported.notificationDecisionLogs).toEqual([
      expect.objectContaining({
        decision: 'sent_push',
        sourceSkill: 'secretary',
        type: 'reminder',
      }),
      expect.objectContaining({
        decision: 'in_app_only',
        sourceSkill: 'secretary',
        type: null,
      }),
    ]);
    expect(JSON.stringify(exported.notificationDecisionLogs)).not.toContain('security_account');
  });

  it('exports todos, reminders, notes, shared memory', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);

    const exported = exportAllUserData(1);
    expect(exported.todos).toHaveLength(1);
    expect(exported.todos[0].title).toBe('Buy groceries');
    expect(exported.reminders).toHaveLength(1);
    expect(exported.reminders[0].message).toBe('Call doctor');
    expect(exported.notes).toHaveLength(1);
    expect(exported.notes[0].content).toBe('Meeting notes');
    expect(exported.sharedMemory).toHaveLength(1);
    expect(exported.sharedMemory[0].key).toContain('preference');
  });

  it('exports saved ideas from the real title column while preserving the legacy content alias', () => {
    replaceTestDatabaseWithLegacySavedIdeas((database) => {
      database.prepare(`
        INSERT INTO saved_ideas (
          title, source_date, user_id, tenant_id, owner_user_id,
          visibility_scope, scope_status, created_by, updated_by
        ) VALUES (
          'A durable idea', '2026-07-17', 1, 1, 1,
          'user_private', 'active', 1, 1
        )
      `).run();
    });

    const exported = exportAllUserData(1);

    expect(exported.savedIdeas).toEqual([
      expect.objectContaining({
        title: 'A durable idea',
        content: 'A durable idea',
      }),
    ]);
  });

  it('treats canonical owner_user_id as authoritative when legacy user_id conflicts', () => {
    replaceTestDatabaseWithLegacySavedIdeas((database) => {
      seedUser(database, 1);
      seedUser(database, 2, { username: 'canonical-owner' });
      database.prepare(`
        INSERT INTO saved_ideas (
          title, source_date, user_id, tenant_id, owner_user_id,
          visibility_scope, scope_status, created_by, updated_by
        ) VALUES (
          'Canonical owner two only', '2026-07-17', 1, 2, 2,
          'user_private', 'active', 2, 2
        )
      `).run();
    });

    expect(exportAllUserData(1).savedIdeas).toEqual([]);
    expect(getAccountDeletionInventoryForUser(1).deletableTables.saved_ideas).toBe(0);
    expect(exportAllUserData(2).savedIdeas).toEqual([
      expect.objectContaining({ title: 'Canonical owner two only' }),
    ]);

    deleteAllUserData(1);
    expect(testDb.prepare('SELECT title FROM saved_ideas WHERE owner_user_id = 2').get())
      .toMatchObject({ title: 'Canonical owner two only' });
  });

  it('exports previously omitted Content workspace groups with strict owner and tenant scope', () => {
    seedCanonicalContentItem({ tenantId: 1, userId: 1, title: 'User one idea' });
    seedCanonicalContentItem({ tenantId: 2, userId: 2, title: 'User two idea' });
    testDb.prepare(`
      INSERT INTO content_reference_registry (
        tenant_id, owner_user_id, reference_type, source_identifier,
        title, created_by, updated_by
      ) VALUES
        (1, 1, 'url', 'https://example.test/user-one', 'User one source', 1, 1),
        (2, 2, 'url', 'https://example.test/user-two', 'User two source', 2, 2)
    `).run();
    testDb.prepare(`
      INSERT INTO content_agency_packages (
        agency_id, user_id, tenant_id, payload_json
      ) VALUES
        ('agency-user-one', 1, 1, '{"topic":"user one"}'),
        ('agency-user-two', 2, 2, '{"topic":"user two"}')
    `).run();

    const workspace = exportAllUserData(1).contentWorkspace;
    const records = (name: string) => workspace.tables.find((table) => table.name === name)?.records;

    expect(workspace.schemaVersion).toBe('content-workspace-export-v1');
    expect(records('content_domain_objects')).toEqual([
      expect.objectContaining({ title: 'User one idea', owner_user_id: 1, tenant_id: 1 }),
    ]);
    expect(records('content_reference_registry')).toEqual([
      expect.objectContaining({ title: 'User one source', owner_user_id: 1, tenant_id: 1 }),
    ]);
    expect(records('content_agency_packages')).toEqual([
      expect.objectContaining({ agency_id: 'agency-user-one', user_id: 1, tenant_id: 1 }),
    ]);
    expect(JSON.stringify(workspace)).not.toContain('User two');
    expect(JSON.stringify(workspace)).not.toContain('agency-user-two');
  });

  it('exports all canonically owned Content tenants when no authenticated tenant boundary is supplied', () => {
    seedCanonicalContentItem({ tenantId: 44, userId: 1, title: 'Tenant 44 account export' });
    seedCanonicalContentItem({ tenantId: 55, userId: 1, title: 'Tenant 55 account export' });
    seedCanonicalContentItem({ tenantId: 55, userId: 2, title: 'Another owner' });

    const workspace = exportAllUserData(1).contentWorkspace;
    const records = workspace.tables.find((table) => table.name === 'content_domain_objects')?.records;

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Tenant 44 account export', tenant_id: 44, owner_user_id: 1 }),
      expect.objectContaining({ title: 'Tenant 55 account export', tenant_id: 55, owner_user_id: 1 }),
    ]));
    expect(JSON.stringify(records)).not.toContain('Another owner');
  });

  it('exports canonical performance outcome lineage without crossing owner scope', () => {
    const owner = seedCanonicalPerformanceTarget({ tenantId: 1, userId: 1, suffix: 'export-owner' });
    const other = seedCanonicalPerformanceTarget({ tenantId: 2, userId: 2, suffix: 'export-other' });
    recordContentPerformanceOutcome({
      scope: { tenantId: 1, userId: 1 },
      ...owner,
      idempotencyKey: 'performance-export-owner-001',
      views: 100,
      retentionPct: 40,
    }, testDb);
    recordContentPerformanceOutcome({
      scope: { tenantId: 2, userId: 2 },
      ...other,
      idempotencyKey: 'performance-export-other-001',
      views: 200,
      retentionPct: 50,
    }, testDb);

    const workspace = exportAllUserData(1).contentWorkspace;
    const outcomes = workspace.tables.find(({ name }) => name === 'content_performance')?.records ?? [];
    const links = workspace.tables.find(({ name }) => name === 'content_performance_workspace_links')?.records ?? [];

    expect(outcomes).toEqual([expect.objectContaining({ tenant_id: 1, owner_user_id: 1, pipeline_id: null })]);
    expect(links).toEqual([expect.objectContaining({
      tenant_id: 1,
      owner_user_id: 1,
      item_id: owner.itemId,
      artifact_id: owner.artifactId,
      revision_id: owner.revisionId,
      origin: 'canonical_api',
    })]);
    expect(JSON.stringify(workspace)).not.toContain('performance-export-other-001');
    expect(JSON.stringify(links)).not.toContain(`"item_id":${other.itemId}`);
  });

  it('fails instead of returning a successful partial Content workspace export', () => {
    const originalPrepare = testDb.prepare.bind(testDb);
    const prepareSpy = vi.spyOn(testDb, 'prepare');
    prepareSpy.mockImplementation(((sql: string) => {
      if (sql.includes('SELECT * FROM "content_domain_objects"')) {
        throw new Error('injected Content export failure');
      }
      return originalPrepare(sql);
    }) as any);

    try {
      expect(() => exportAllUserData(1)).toThrow('injected Content export failure');
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('exports finance data with decrypted amounts', () => {
    seedUser(testDb, 1);
    addTransaction(1, '2024-06-01', 'income', 9999.99);

    const exported = exportAllUserData(1);
    expect(exported.finance.transactions).toHaveLength(1);
    expect(exported.finance.transactions[0].amount).toBe(9999.99);
  });

  it('exports user profile data', () => {
    seedUser(testDb, 1, { username: 'felipe', language: 'pt-BR' });

    const exported = exportAllUserData(1);
    expect(exported.user).not.toBeNull();
    expect(exported.user!.username).toBe('felipe');
    expect(exported.user!.language).toBe('pt-BR');
  });

  it('exports Secretary source-skill feedback and Training feedback decisions', () => {
    seedUser(testDb, 1);
    testDb.prepare(`
      INSERT INTO training_feedback_decisions (
        user_id, tenant_id, source_skill, agenda_item_id, source_intent_id,
        feedback_type, status, scheduled_start, scheduled_end
      )
      VALUES (1, '1', 'secretary', 'agenda-training-1', 'training-intent-1',
              'schedule_feedback', 'scheduled', '2026-06-01T09:00:00Z', '2026-06-01T10:00:00Z')
    `).run();
    testDb.prepare(`
      INSERT INTO secretary_source_skill_feedback (
        user_id, tenant_id, target_skill, agenda_item_id, source_intent_id,
        feedback_type, status, scheduled_start, scheduled_end
      )
      VALUES (1, '1', 'cooking', 'agenda-cooking-1', 'cooking-intent-1',
              'schedule_feedback', 'reflowed', '2026-06-02T18:00:00Z', '2026-06-02T19:00:00Z')
    `).run();

    const exported = exportAllUserData(1);

    expect(exported.trainingFeedbackDecisions).toEqual([
      expect.objectContaining({
        sourceSkill: 'secretary',
        agendaItemId: 'agenda-training-1',
        sourceIntentId: 'training-intent-1',
        feedbackType: 'schedule_feedback',
        status: 'scheduled',
      }),
    ]);
    expect(exported.secretarySourceSkillFeedback).toEqual([
      expect.objectContaining({
        targetSkill: 'cooking',
        agendaItemId: 'agenda-cooking-1',
        sourceIntentId: 'cooking-intent-1',
        feedbackType: 'schedule_feedback',
        status: 'reflowed',
      }),
    ]);
  });

  it('exports Secretary agenda items and skill memories as first-class export fields', () => {
    seedUser(testDb, 1);
    testDb.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        owner_user_id, tenant_id, lifecycle_state, provider_sync_state, title,
        start_at, end_at, decision_action, source_shape_hash, created_at, updated_at
      )
      VALUES (
        'agenda-export-1', 'intent-export-1', 'training', 'schedule_workout', 'schedule_this',
        1, '1', 'scheduled', 'not_synced', 'Exported workout',
        '2026-06-01T09:00:00Z', '2026-06-01T10:00:00Z', 'schedule', 'shape-export-1',
        '2026-05-31T10:00:00Z', '2026-05-31T10:00:00Z'
      )
    `).run();
    testDb.prepare(`
      INSERT INTO skill_memories (
        memory_id, tenant_id, user_id, skill_id, memory_type, scope,
        memory_key, memory_value, source
      )
      VALUES (
        'memory-export-1', 1, 1, 'secretary', 'schedule_preference', 'user_private',
        'preferred_focus_time', 'mornings', 'test'
      )
    `).run();

    const exported = exportAllUserData(1);

    expect(exported.secretaryAgendaItems).toEqual([
      expect.objectContaining({
        agendaItemId: 'agenda-export-1',
        sourceSkill: 'training',
        title: 'Exported workout',
        lifecycleState: 'scheduled',
      }),
    ]);
    expect(exported.skillMemories).toEqual([
      expect.objectContaining({
        memoryId: 'memory-export-1',
        skillId: 'secretary',
        memoryType: 'schedule_preference',
        memoryKey: 'preferred_focus_time',
        memoryValue: 'mornings',
      }),
    ]);
  });

  it('exports the complete Training plan revision graph with decrypted snapshot content', () => {
    const previousKey = process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY;
    process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY = 'training-export-dedicated-key-000000000001';
    try {
      const encrypted = encryptTrainingProfileSnapshot({
        userId: 1,
        body: {
          profileKind: 'legacy', request: null,
          legacySource: { planId: 10, planVersion: 1, adaptationRevision: 0, sourceHash: 'a'.repeat(64) },
          catalogVersion: 'legacy-unversioned', catalogSourceHash: 'a'.repeat(64),
          policyVersion: 'legacy-preservation.v1',
          consentContext: { optionalPermissionsUsed: [] }, missingInputs: ['profile'],
        },
      });
      testDb.prepare(`
        INSERT INTO training_profile_snapshots (
          snapshot_id, tenant_id, user_id, snapshot_sequence, schema_version,
          content_hash, encrypted_snapshot_body, snapshot_body_key_version,
          display_factor_index_json, normalized_goals_json, normalized_constraints_json,
          factor_evidence_json, source_versions_json, consent_context_json,
          missing_inputs_json, observed_at, captured_at
        ) VALUES (
          'snapshot-export', 1, 1, 1, 'legacy-training-profile-snapshot.v1',
          ?, ?, ?, '[]', '{}', '{}', '[]', '{}', '{}', '["profile"]',
          datetime('now'), datetime('now')
        )
      `).run('b'.repeat(64), encrypted.encryptedBody, encrypted.keyVersion);
      testDb.prepare(`
        INSERT INTO training_plan_families (
          family_id, tenant_id, user_id, family_key, plan_mode, discipline, origin
        ) VALUES ('family-export', 1, 1, 'legacy:10', 'continuous', 'strength', 'LEGACY_BACKFILL')
      `).run();
      testDb.prepare(`
        INSERT INTO training_plan_revisions (
          revision_id, tenant_id, user_id, family_id, revision_sequence,
          profile_snapshot_id, origin, lifecycle_state, approval_state,
          creation_context_version, policy_version, catalog_version,
          catalog_source_hash, capability_registry_version, document_schema_version,
          revision_document_json, content_hash, quality_report_json
        ) VALUES (
          'revision-export', 1, 1, 'family-export', 1, 'snapshot-export',
          'LEGACY_BACKFILL', 'LEGACY_ACTIVE', 'APPROVED', 'context-export',
          'legacy-preservation.v1', 'legacy-unversioned', ?,
          'training-workout-capabilities.v1', 'legacy-training-plan-revision.v1',
          '{"title":"Exported plan"}', ?, '{"status":"LEGACY_COMPATIBILITY"}'
        )
      `).run('a'.repeat(64), 'c'.repeat(64));
      testDb.prepare(`
        INSERT INTO training_plan_current_contexts (
          tenant_id, user_id, family_id, current_revision_id,
          current_profile_snapshot_id, current_context_version, base_context_version,
          profile_source_version, calendar_source_version, conflict_source_version
        ) VALUES (
          1, 1, 'family-export', 'revision-export', 'snapshot-export', 'context-export',
          'base-context-export', 'profile_export', 'calendar_export', 'conflict_export'
        )
      `).run();
      testDb.prepare(`
        INSERT INTO training_plan_revision_operations (
          operation_id, tenant_id, user_id, operation_type, idempotency_key,
          request_hash, status, result_family_id, result_revision_id, response_json
        ) VALUES (
          'operation-export', 1, 1, 'CREATE_CANDIDATE', 'export-key', ?, 'SUCCEEDED',
          'family-export', 'revision-export', '{"result":"ok"}'
        )
      `).run('d'.repeat(64));
      seedTrainingM4CapacitySnapshot(testDb, {
        userId: 1,
        snapshotId: 'capacity-export',
      });

      const graph = exportAllUserData(1).trainingPlanRevisionV1;
      expect(graph.capacitySnapshots).toEqual([
        expect.objectContaining({
          snapshotId: 'capacity-export',
          providerSources: ['google'],
          profileWindows: [{ day: 'monday', start: '06:00', end: '08:00' }],
          capacityWindows: [{ day: 'monday', start: '06:00', end: '07:30' }],
          conflictCount: 1,
        }),
      ]);
      expect(graph.profileSnapshots).toEqual([
        expect.objectContaining({ snapshotId: 'snapshot-export', snapshotBody: expect.objectContaining({ profileKind: 'legacy' }) }),
      ]);
      expect(graph.planFamilies).toEqual([expect.objectContaining({ familyId: 'family-export' })]);
      expect(graph.planRevisions).toEqual([
        expect.objectContaining({ revisionId: 'revision-export', revisionDocument: { title: 'Exported plan' } }),
      ]);
      expect(graph.currentContexts).toEqual([expect.objectContaining({ currentRevisionId: 'revision-export' })]);
      expect(graph.operations).toEqual([expect.objectContaining({ operationId: 'operation-export', response: { result: 'ok' } })]);
    } finally {
      if (previousKey === undefined) delete process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY;
      else process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY = previousKey;
    }
  });

  it('does NOT include other users data', () => {
    seedUser(testDb, 1);
    seedUser(testDb, 2, { username: 'other' });
    seedUserData(testDb, 1);
    seedUserData(testDb, 2);
    seedTrainingM4CapacitySnapshot(testDb, { userId: 1, snapshotId: 'capacity-user-1' });
    seedTrainingM4CapacitySnapshot(testDb, { userId: 2, snapshotId: 'capacity-user-2' });

    const exported = exportAllUserData(1);
    expect(exported.conversations).toHaveLength(2); // only user 1's
    expect(exported.todos).toHaveLength(1);
    expect(exported.trainingPlanRevisionV1.capacitySnapshots).toEqual([
      expect.objectContaining({ snapshotId: 'capacity-user-1', tenantId: 1 }),
    ]);
  });

  it('exports and explicitly inventories rich compatibility-plan completions by plan ownership', () => {
    seedUser(testDb, 1);
    seedUser(testDb, 2, { username: 'other' });
    const insertPlan = testDb.prepare(`
      INSERT INTO fitness_training_plans (
        id, user_id, name, sport, goal, duration_weeks, periodization,
        status, start_date, end_date, preferences_json
      ) VALUES (?, ?, ?, 'running', 'Finish safely', 4, 'linear',
                'active', '2026-08-01', '2026-08-28', ?)
    `);
    insertPlan.run(9101, 1, 'Owner plan', JSON.stringify({ schedulingTimezone: 'Europe/Lisbon' }));
    insertPlan.run(9201, 2, 'Other plan', JSON.stringify({ schedulingTimezone: 'America/New_York' }));
    testDb.prepare(`
      INSERT INTO training_weeks (id, plan_id, week_number, focus)
      VALUES (9111, 9101, 1, 'base'), (9211, 9201, 1, 'base')
    `).run();
    testDb.prepare(`
      INSERT INTO training_sessions (
        id, week_id, plan_id, day_of_week, session_type, title, status
      ) VALUES
        (9121, 9111, 9101, 'Monday', 'running', 'Owner run', 'completed'),
        (9221, 9211, 9201, 'Tuesday', 'running', 'Other run', 'completed')
    `).run();
    const insertCompletion = testDb.prepare(`
      INSERT INTO training_completions (
        id, session_id, plan_id, completed_at, actual_exercises_json,
        rpe_overall, duration_minutes, energy_level, soreness_level, notes,
        completion_state, readiness_level, difficulty_feedback,
        duration_feedback, discomfort_flag, discomfort_flags_json,
        discomfort_locations_json, discomfort_details,
        substitutions_used_json, felt_too_hard, felt_too_easy,
        felt_too_long, felt_too_short, modality, session_role
      ) VALUES (
        ?, ?, ?, '2026-08-02T08:00:00.000Z', ?, 8, 47, 6, 4, ?,
        'partial', 5, 'hard', 'too_long', 1, ?, ?, ?, ?, 1, 0, 1, 0,
        'run', 'quality'
      )
    `);
    insertCompletion.run(
      9131,
      9121,
      9101,
      JSON.stringify([{ name: 'Tempo intervals', completed: 4 }]),
      'Owner private feedback',
      JSON.stringify(['pain']),
      JSON.stringify(['left_knee']),
      'Stopped before the final interval',
      JSON.stringify(['walk_recovery']),
    );
    insertCompletion.run(
      9231,
      9221,
      9201,
      JSON.stringify([{ name: 'Other private workout', completed: 3 }]),
      'Other private feedback',
      JSON.stringify(['fatigue']),
      JSON.stringify(['right_ankle']),
      'Other private detail',
      JSON.stringify(['bike']),
    );

    const exported = exportAllUserData(1);

    // F18 privacy guarantee: compatibility rows have no direct user_id on
    // children, so ownership must be derived through the parent plan.
    expect(exported.trainingPlanCompatibility.completions).toEqual([
      expect.objectContaining({
        id: 9131,
        completion_state: 'partial',
        notes: 'Owner private feedback',
        discomfort_locations: ['left_knee'],
        substitutions_used: ['walk_recovery'],
      }),
    ]);
    expect(JSON.stringify(exported.trainingPlanCompatibility)).not.toContain('Other private');

    const inventory = getAccountDeletionInventoryForUser(1);
    expect(inventory.deletableTables.training_completions).toBe(1);

    const counts = deleteAllUserData(1);
    expect(counts.training_completions).toBe(1);
    expect(testDb.prepare('SELECT id FROM training_completions ORDER BY id').all())
      .toEqual([{ id: 9231 }]);
  });

  it('handles missing tables gracefully', () => {
    // Just export with no data seeded — should not throw
    const exported = exportAllUserData(999);
    expect(exported.user).toBeNull();
    expect(exported.conversations).toHaveLength(0);
    expect(exported.todos).toHaveLength(0);
    expect(exported.savedIdeas).toHaveLength(0);
  });

  it('includes exportedAt timestamp and userId', () => {
    const exported = exportAllUserData(42);
    expect(exported.userId).toBe(42);
    expect(exported.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── Full Delete Tests (GDPR Article 17) ──

describe('deleteAllUserData', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => { testDb.close(); });

  it('deletes from ALL tables', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);
    addTransaction(1, '2024-06-01', 'income', 5000);

    const counts = deleteAllUserData(1);

    expect(counts['conversations']).toBe(2);
    expect(counts['todos']).toBe(1);
    expect(counts['reminders']).toBe(1);
    expect(counts['notes']).toBe(1);
    expect(counts['shared_memory']).toBe(1);
    expect(counts['finance_transactions']).toBe(1);
    expect(counts['users']).toBe(1);
  });

  it('inventories and erases every current user-keyed API cache family without prefix collisions', () => {
    seedUser(testDb, 1);
    seedUser(testDb, 2, { username: 'other' });
    const insert = testDb.prepare(`
      INSERT INTO api_cache (cache_key, value_json, expires_at)
      VALUES (?, ?, '2099-01-01T00:00:00.000Z')
    `);
    const ownerKeys = [
      'u:1:wearable:summary:2026-08-10',
      'plan:week:u:1:t:17:2026-08-10',
      'script-v8:private-topic:scope:1:tenant:17',
      'coach-briefing:1',
      'dashboard-readiness:1',
      'training:keep-original:1:2026-08-10',
      'chat-cmd:17:1:en-US:show-my-day',
      'dashboard:17:1:en-US',
      'dashboard-home:17:1:en-US',
      'readiness:17:1',
      'training-home:17:1:en-US',
      'training-summary:17:1',
      'cardio-progression:17:1:running:8',
      'strength-progression:17:1:8',
      'training-activity-weekly:17:1',
      'training-history:17:1:all:25',
      'training-load-snapshot:17:1',
      'unified-inbox:1:tenant:17:20',
      'unified-inbox-unread:1:tenant:17',
    ];
    const retainedKeys = [
      'u:10:dashboard',
      'dashboard:1:2:en-US',
      'script-v8:other-topic:scope:10:tenant:17',
      'global:duration:1:value',
    ];
    for (const key of ownerKeys) insert.run(key, JSON.stringify({ private: key }));
    for (const key of retainedKeys) insert.run(key, JSON.stringify({ retained: key }));

    const inventory = getAccountDeletionInventoryForUser(1);
    expect(inventory.deletableTables.api_cache).toBe(ownerKeys.length);

    const counts = deleteAllUserData(1);

    expect(counts.api_cache).toBe(ownerKeys.length);
    expect(testDb.prepare('SELECT cache_key FROM api_cache ORDER BY cache_key').all())
      .toEqual(retainedKeys.sort().map((cache_key) => ({ cache_key })));
  });

  it('discovers and erases receipt AI execution rows by user across tenant scopes', () => {
    testDb.prepare(`
      INSERT INTO receipt_ai_transfer_executions (
        tenant_id, user_id, consent_receipt_key_hash,
        transfer_binding_hash, status
      ) VALUES (?, ?, ?, ?, 'in_progress')
    `).run(901, 1, 'a'.repeat(64), 'b'.repeat(64));
    testDb.prepare(`
      INSERT INTO receipt_ai_transfer_executions (
        tenant_id, user_id, consent_receipt_key_hash,
        transfer_binding_hash, status
      ) VALUES (?, ?, ?, ?, 'in_progress')
    `).run(901, 2, 'c'.repeat(64), 'd'.repeat(64));

    const inventory = getAccountDeletionInventoryForUser(1);
    expect(inventory.deletableTables.receipt_ai_transfer_executions).toBe(1);

    const counts = deleteAllUserData(1);
    expect(counts.receipt_ai_transfer_executions).toBe(1);
    expect(testDb.prepare(`
      SELECT tenant_id AS tenantId, user_id AS userId
        FROM receipt_ai_transfer_executions
    `).all()).toEqual([{ tenantId: 901, userId: 2 }]);
  });

  it('erases a migrated legacy topic through the scoped legal-erasure gate', () => {
    testDb.close();
    testDb = createMigratedTestDatabase({ stopBefore: '247_content_topics_workspace_exit.sql' });
    seedUser(testDb, 1);
    testDb.prepare(`
      INSERT INTO content_topics (
        user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
        scope_status, created_by, updated_by, title, notes, status,
        audit_metadata_json
      ) VALUES (1, 1, 1, 'user_private', 'planned', 'active', 1, 1,
        'Erase this migrated idea', 'Private content', 'planned', '{}')
    `).run();
    testDb.exec(CONTENT_TOPICS_WORKSPACE_EXIT_UP);

    const counts = deleteAllUserData(1);

    expect(counts.content_topics).toBe(1);
    expect(counts.content_domain_objects).toBe(1);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_topics WHERE user_id = 1').get())
      .toEqual({ count: 0 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_topic_workspace_links WHERE owner_user_id = 1').get())
      .toEqual({ count: 0 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM training_revision_erasure_authorizations WHERE subject_user_id = 1').get())
      .toEqual({ count: 0 });
  });

  it('inventories and deletes owner_user_id-only Content tables without affecting another owner', () => {
    seedUser(testDb, 1);
    seedUser(testDb, 2, { username: 'other' });
    testDb.prepare(`
      INSERT INTO content_pillars (
        tenant_id, owner_user_id, pillar_key, name, created_by, updated_by
      ) VALUES
        (1, 1, 'owner-one', 'Owner one pillar', 1, 1),
        (2, 2, 'owner-two', 'Owner two pillar', 2, 2)
    `).run();
    seedCanonicalContentItem({ tenantId: 1, userId: 1, title: 'Owner one script' });
    seedCanonicalContentItem({ tenantId: 2, userId: 2, title: 'Owner two script' });

    const inventory = getAccountDeletionInventoryForUser(1);
    expect(inventory.deletableTables.content_pillars).toBe(1);
    expect(inventory.deletableTables.content_domain_objects).toBe(1);

    const counts = deleteAllUserData(1);
    expect(counts.content_pillars).toBe(1);
    expect(counts.content_domain_objects).toBe(1);
    expect(testDb.prepare('SELECT name FROM content_pillars WHERE owner_user_id = 2').get())
      .toMatchObject({ name: 'Owner two pillar' });
    expect(testDb.prepare('SELECT title FROM content_domain_objects WHERE owner_user_id = 2').get())
      .toMatchObject({ title: 'Owner two script' });
  });

  it('erases canonical performance outcomes, links, and receipts while preserving another owner', () => {
    seedUser(testDb, 1);
    seedUser(testDb, 2, { username: 'other' });
    const owner = seedCanonicalPerformanceTarget({ tenantId: 1, userId: 1, suffix: 'erase-owner' });
    const other = seedCanonicalPerformanceTarget({ tenantId: 2, userId: 2, suffix: 'erase-other' });
    const ownerOutcome = recordContentPerformanceOutcome({
      scope: { tenantId: 1, userId: 1 },
      ...owner,
      idempotencyKey: 'performance-erase-owner-001',
      views: 100,
      retentionPct: 40,
    }, testDb).value;
    const otherOutcome = recordContentPerformanceOutcome({
      scope: { tenantId: 2, userId: 2 },
      ...other,
      idempotencyKey: 'performance-erase-other-001',
      views: 200,
      retentionPct: 50,
    }, testDb).value;

    const inventory = getAccountDeletionInventoryForUser(1);
    expect(inventory.deletableTables.content_performance).toBe(1);
    expect(inventory.deletableTables.content_performance_workspace_links).toBe(1);
    expect(inventory.deletableTables.content_mutation_receipts).toBeGreaterThanOrEqual(1);

    deleteAllUserData(1);

    expect(testDb.prepare('SELECT id FROM content_performance WHERE id = ?').get(ownerOutcome.id)).toBeUndefined();
    expect(testDb.prepare('SELECT id FROM content_performance_workspace_links WHERE performance_id = ?').get(ownerOutcome.id)).toBeUndefined();
    expect(testDb.prepare(`
      SELECT id FROM content_mutation_receipts
       WHERE owner_user_id = 1 AND operation = 'record_content_performance'
    `).get()).toBeUndefined();
    expect(testDb.prepare('SELECT id FROM content_performance WHERE id = ?').get(otherOutcome.id)).toBeTruthy();
    expect(testDb.prepare('SELECT id FROM content_performance_workspace_links WHERE performance_id = ?').get(otherOutcome.id)).toBeTruthy();
  });

  it('fails the deletion inventory instead of converting a count query failure to zero', () => {
    seedCanonicalContentItem({ tenantId: 1, userId: 1, title: 'Must not be hidden' });
    const originalPrepare = testDb.prepare.bind(testDb);
    const prepareSpy = vi.spyOn(testDb, 'prepare');
    prepareSpy.mockImplementation(((sql: string) => {
      if (sql.includes('SELECT COUNT(*) AS count FROM "content_domain_objects"')) {
        throw new Error('injected inventory failure');
      }
      return originalPrepare(sql);
    }) as any);

    try {
      expect(() => getAccountDeletionInventoryForUser(1)).toThrow('injected inventory failure');
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('rolls back all account erasure work when a Content delete statement fails', () => {
    replaceTestDatabaseWithLegacySavedIdeas((database) => {
      seedUser(database, 1);
      database.prepare(`
        INSERT INTO saved_ideas (
          title, source_date, user_id, tenant_id, owner_user_id,
          visibility_scope, scope_status, created_by, updated_by
        ) VALUES (
          'Must survive rollback', '2026-07-17', 1, 1, 1,
          'user_private', 'active', 1, 1
        )
      `).run();
    });
    seedCanonicalContentItem({ tenantId: 1, userId: 1, title: 'Delete should fail' });
    testDb.exec(`
      CREATE TRIGGER fail_content_domain_object_delete
      BEFORE DELETE ON content_domain_objects
      WHEN OLD.owner_user_id = 1
      BEGIN
        SELECT RAISE(ABORT, 'injected Content deletion failure');
      END
    `);

    expect(() => deleteAllUserData(1)).toThrow('injected Content deletion failure');
    expect(testDb.prepare('SELECT id FROM users WHERE telegram_id = 1').get()).toBeTruthy();
    expect(testDb.prepare('SELECT title FROM saved_ideas WHERE user_id = 1').get())
      .toMatchObject({ title: 'Must survive rollback' });
    expect(testDb.prepare(`
      SELECT title
        FROM content_domain_objects
       WHERE owner_user_id = 1
         AND title = 'Delete should fail'
    `).get())
      .toMatchObject({ title: 'Delete should fail' });
  });

  it('runs in a transaction — other users unaffected', () => {
    seedUser(testDb, 1);
    seedUser(testDb, 2, { username: 'other' });
    seedUserData(testDb, 1);
    seedUserData(testDb, 2);

    deleteAllUserData(1);

    // User 2's data should be intact
    const convos = testDb.prepare('SELECT COUNT(*) as c FROM conversations WHERE user_id = 2').get() as any;
    expect(convos.c).toBe(2);
    const user2 = testDb.prepare('SELECT 1 FROM users WHERE telegram_id = 2').get();
    expect(user2).toBeTruthy();
  });

  it('deletes the user record last', () => {
    seedUser(testDb, 1);
    const counts = deleteAllUserData(1);
    expect(counts['users']).toBe(1);

    const user = testDb.prepare('SELECT 1 FROM users WHERE telegram_id = 1').get();
    expect(user).toBeUndefined();
  });

  it('does NOT delete audit trail entries', () => {
    seedUser(testDb, 1);
    logAudit({ userId: 1, actorId: 1, action: 'export', resource: 'all' });

    deleteAllUserData(1);

    const auditRows = testDb.prepare('SELECT * FROM audit_trail WHERE user_id = 1').all();
    expect(auditRows).toHaveLength(1);
  });

  it('authorizes and verifies erasure of immutable Training revision data', () => {
    seedUser(testDb, 1);
    testDb.prepare(`
      INSERT INTO training_profile_snapshots (
        snapshot_id, tenant_id, user_id, snapshot_sequence, schema_version,
        content_hash, encrypted_snapshot_body, snapshot_body_key_version,
        display_factor_index_json, normalized_goals_json, normalized_constraints_json,
        factor_evidence_json, source_versions_json, consent_context_json,
        missing_inputs_json, observed_at, captured_at
      ) VALUES (
        'snapshot-gdpr', 1, 1, 1, 'training-profile-snapshot.v1',
        ?, 'encrypted-private-profile', 'training-profile-snapshot-aes256gcm.v1',
        '[]', '{}', '{}', '[]', '{}', '{}', '[]', datetime('now'), datetime('now')
      )
    `).run('a'.repeat(64));
    testDb.prepare(`
      INSERT INTO training_plan_families (
        family_id, tenant_id, user_id, family_key, plan_mode, discipline, origin
      ) VALUES ('family-gdpr', 1, 1, 'continuous:general_fitness', 'continuous', 'strength', 'GENERATED')
    `).run();
    testDb.prepare(`
      INSERT INTO training_plan_revisions (
        revision_id, tenant_id, user_id, family_id, revision_sequence,
        profile_snapshot_id, origin, lifecycle_state, approval_state, decision_id,
        creation_context_version, policy_version, catalog_version, catalog_source_hash,
        capability_registry_version, document_schema_version, revision_document_json,
        content_hash, quality_report_json
      ) VALUES (
        'revision-gdpr', 1, 1, 'family-gdpr', 1, 'snapshot-gdpr', 'GENERATED',
        'ACTIVE', 'APPROVED', 'decision-gdpr', 'context-gdpr', 'policy-gdpr',
        'catalog-gdpr', ?, 'training-workout-capabilities.v1',
        'training-plan-revision.v1', '{}', ?, '{}'
      )
    `).run('b'.repeat(64), 'c'.repeat(64));
    testDb.prepare(`
      INSERT INTO training_plan_revision_approvals (
        approval_id, tenant_id, user_id, family_id, revision_id, decision_id,
        decision_record_version, action_execution_id, approved_content_hash,
        approved_context_version, actor_type, approval_source, approved_at
      ) VALUES (
        'approval-gdpr', 1, 1, 'family-gdpr', 'revision-gdpr', 'decision-gdpr',
        2, 'execution-gdpr', ?, 'context-gdpr', 'user', 'DECISION_CENTER', datetime('now')
      )
    `).run('c'.repeat(64));
    testDb.prepare(`
      INSERT INTO training_plan_current_contexts (
        tenant_id, user_id, family_id, current_revision_id,
        current_profile_snapshot_id, current_context_version, base_context_version,
        profile_source_version, calendar_source_version, conflict_source_version,
        pointer_version
      ) VALUES (
        1, 1, 'family-gdpr', 'revision-gdpr', 'snapshot-gdpr', 'context-gdpr',
        'base-context-gdpr', 'profile_gdpr', 'calendar_gdpr', 'conflict_gdpr', 1
      )
    `).run();
    testDb.prepare(`
      INSERT INTO training_active_plan_references (
        tenant_id, user_id, family_id, active_revision_id, pointer_version
      ) VALUES (1, 1, 'family-gdpr', 'revision-gdpr', 1)
    `).run();
    seedTrainingM4CapacitySnapshot(testDb, {
      userId: 1,
      snapshotId: 'capacity-gdpr',
    });
    expect(() => testDb.prepare("DELETE FROM training_plan_revisions WHERE revision_id = 'revision-gdpr'").run())
      .toThrow(/immutable records/i);
    expect(() => testDb.prepare("DELETE FROM training_m4_capacity_snapshots WHERE snapshot_id = 'capacity-gdpr'").run())
      .toThrow(/immutable/i);
    testDb.prepare(`
      INSERT INTO training_m4_capacity_prune_authorizations (
        authorization_id, tenant_id, user_id, prune_before_at, expires_at
      ) VALUES ('capacity-prune-gdpr', 1, 1, datetime('now'), datetime('now', '+1 minute'))
    `).run();

    const counts = deleteAllUserData(1);
    expect(counts.training_m4_capacity_snapshots).toBe(1);
    expect(counts.training_m4_capacity_prune_authorizations).toBe(1);

    for (const table of [
      'training_profile_snapshots',
      'training_plan_families',
      'training_plan_revisions',
      'training_plan_revision_approvals',
      'training_plan_current_contexts',
      'training_active_plan_references',
      'training_m4_capacity_prune_authorizations',
      'training_m4_capacity_snapshots',
    ]) {
      expect(testDb.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = 1`).get())
        .toEqual({ count: 0 });
    }
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM training_revision_erasure_authorizations').get())
      .toEqual({ count: 0 });
  });

  it('deletes Wave 1 notification, Garmin, agent-signal, encryption, and config rows while retaining audit trail', () => {
    seedUser(testDb, 1);
    logAudit({ userId: 1, actorId: 1, action: 'export', resource: 'all' });

    testDb.prepare(`
      INSERT INTO notification_device_tokens (
        token_id, user_id, tenant_id, platform, token_hash, token_suffix, environment
      )
      VALUES ('dt_delete', 1, 1, 'ios', 'hash', 'suffix', 'sandbox')
    `).run();
    testDb.prepare(`
      INSERT INTO garmin_sessions (user_id, oauth1_token_json, oauth2_token_json)
      VALUES (1, '{}', '{}')
    `).run();
    testDb.prepare(`
      INSERT INTO agent_signals (source_agent, signal_type, payload, priority, expires_at, user_id, tenant_id)
      VALUES ('test', 'gdpr', '{}', 'normal', datetime('now', '+1 day'), 1, 1)
    `).run();
    testDb.prepare(`
      INSERT INTO user_encryption_meta (user_id, key_version)
      VALUES (1, 1)
    `).run();
    testDb.prepare(`
      INSERT INTO kv_store (key, value)
      VALUES ('config:1:timezone', '"UTC"')
    `).run();

    const counts = deleteAllUserData(1);

    expect(counts.notification_device_tokens).toBe(1);
    expect(counts.garmin_sessions).toBe(1);
    expect(counts.agent_signals).toBe(1);
    expect(counts.user_encryption_meta).toBe(1);
    expect(counts.kv_store_settings).toBe(1);
    expect(testDb.prepare('SELECT COUNT(*) as c FROM audit_trail WHERE user_id = 1').get()).toMatchObject({ c: 1 });
  });

  it('deletes Secretary source-skill feedback and Training feedback decisions', () => {
    seedUser(testDb, 1);
    testDb.prepare(`
      INSERT INTO training_feedback_decisions (
        user_id, tenant_id, source_skill, agenda_item_id, source_intent_id,
        feedback_type, status
      )
      VALUES (1, '1', 'secretary', 'agenda-training-delete', 'training-intent-delete',
              'schedule_feedback', 'scheduled')
    `).run();
    testDb.prepare(`
      INSERT INTO secretary_source_skill_feedback (
        user_id, tenant_id, target_skill, agenda_item_id, source_intent_id,
        feedback_type, status
      )
      VALUES (1, '1', 'finance', 'agenda-finance-delete', 'finance-intent-delete',
              'schedule_feedback', 'scheduled')
    `).run();

    const inventory = getAccountDeletionInventoryForUser(1);
    expect(inventory.deletableTables.training_feedback_decisions).toBe(1);
    expect(inventory.deletableTables.secretary_source_skill_feedback).toBe(1);

    const counts = deleteAllUserData(1);
    expect(counts.training_feedback_decisions).toBe(1);
    expect(counts.secretary_source_skill_feedback).toBe(1);
    expect(testDb.prepare('SELECT COUNT(*) as c FROM training_feedback_decisions WHERE user_id = 1').get()).toMatchObject({ c: 0 });
    expect(testDb.prepare('SELECT COUNT(*) as c FROM secretary_source_skill_feedback WHERE user_id = 1').get()).toMatchObject({ c: 0 });
  });

  it('deletes Secretary agenda items and skill memories through static account deletion coverage', () => {
    seedUser(testDb, 1);
    testDb.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        owner_user_id, tenant_id, lifecycle_state, provider_sync_state, title,
        decision_action, source_shape_hash, created_at, updated_at
      )
      VALUES (
        'agenda-delete-1', 'intent-delete-1', 'content', 'schedule_content', 'schedule_this',
        1, '1', 'scheduled', 'not_synced', 'Delete agenda',
        'schedule', 'shape-delete-1', '2026-05-31T10:00:00Z', '2026-05-31T10:00:00Z'
      )
    `).run();
    testDb.prepare(`
      INSERT INTO skill_memories (
        memory_id, tenant_id, user_id, skill_id, memory_type, scope,
        memory_key, memory_value, source
      )
      VALUES (
        'memory-delete-1', 1, 1, 'cooking', 'cooking_preference', 'user_private',
        'allergy', 'shellfish', 'test'
      )
    `).run();

    const inventory = getAccountDeletionInventoryForUser(1);
    expect(inventory.deletableTables.secretary_agenda_items).toBe(1);
    expect(inventory.deletableTables.skill_memories).toBe(1);

    const counts = deleteAllUserData(1);
    expect(counts.secretary_agenda_items).toBe(1);
    expect(counts.skill_memories).toBe(1);
    expect(testDb.prepare('SELECT COUNT(*) as c FROM secretary_agenda_items WHERE owner_user_id = 1').get()).toMatchObject({ c: 0 });
    expect(testDb.prepare('SELECT COUNT(*) as c FROM skill_memories WHERE user_id = 1').get()).toMatchObject({ c: 0 });
  });

  it('includes legal consent receipts in the deletion inventory and delete counts', () => {
    seedUser(testDb, 1);
    logAudit({ userId: 1, actorId: 1, action: 'export', resource: 'all' });
    testDb.prepare(`
      INSERT INTO user_legal_consents (
        user_id, document_key, document_version, document_url,
        locale, source, accepted_at
      ) VALUES
        (1, 'terms', '2026-06-05', 'https://nexushub.me/termos', 'en-US', 'ios_register', datetime('now')),
        (1, 'privacy', '2026-06-05', 'https://nexushub.me/privacidade', 'en-US', 'ios_register', datetime('now'))
    `).run();

    const inventory = getAccountDeletionInventoryForUser(1);
    expect(inventory.deletableTables.user_legal_consents).toBe(2);
    expect(inventory.retainedTables.audit_trail.reason).toContain('legal proof');

    const counts = deleteAllUserData(1);
    expect(counts.user_legal_consents).toBe(2);
    expect(testDb.prepare('SELECT COUNT(*) as c FROM user_legal_consents WHERE user_id = 1').get()).toMatchObject({ c: 0 });
    expect(testDb.prepare('SELECT COUNT(*) as c FROM audit_trail WHERE user_id = 1').get()).toMatchObject({ c: 1 });
  });

  it('deletes exported app tables and dynamically discovered future user-owned tables', () => {
    seedUser(testDb, 1);
    seedUser(testDb, 2, { username: 'other' });
    logAudit({ userId: 1, actorId: 1, action: 'export', resource: 'all' });

    testDb.prepare(`
      INSERT INTO apple_health_data (user_id, data_type, date, data_json, source_name)
      VALUES (1, 'hrv', '2026-06-05', '{"value":72}', 'ios_app')
    `).run();
    const listId = Number(testDb.prepare(`
      INSERT INTO native_task_lists (user_id, name, is_default)
      VALUES (1, 'Account deletion QA', 1)
    `).run().lastInsertRowid);
    testDb.prepare(`
      INSERT INTO native_tasks (user_id, list_id, title)
      VALUES (1, ?, 'Delete me')
    `).run(listId);
    testDb.prepare(`
      INSERT INTO messages (user_id, message_uuid, role, text)
      VALUES (1, 'msg-delete-1', 'user', 'delete me')
    `).run();
    testDb.prepare(`
      INSERT INTO subscriptions (user_id, plan, period, status, provider, provider_subscription_id)
      VALUES (1, 'pro', 'monthly', 'active', 'apple', '2000000123456789')
    `).run();
    testDb.exec(`
      CREATE TABLE future_user_private_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        payload TEXT NOT NULL
      )
    `);
    testDb.prepare('INSERT INTO future_user_private_rows (user_id, payload) VALUES (1, ?), (2, ?)')
      .run('delete', 'keep');

    const inventory = getAccountDeletionInventoryForUser(1);
    expect(inventory.deletableTables.apple_health_data).toBe(1);
    expect(inventory.deletableTables.native_tasks).toBe(1);
    expect(inventory.deletableTables.messages).toBe(1);
    expect(inventory.deletableTables.subscriptions).toBe(1);
    expect(inventory.deletableTables.future_user_private_rows).toBe(1);

    const counts = deleteAllUserData(1);
    expect(counts.apple_health_data).toBe(1);
    expect(counts.native_tasks).toBe(1);
    expect(counts.native_task_lists).toBe(1);
    expect(counts.messages).toBe(1);
    expect(counts.subscriptions).toBe(1);
    expect(counts.future_user_private_rows).toBe(1);

    expect(testDb.prepare('SELECT COUNT(*) as c FROM future_user_private_rows WHERE user_id = 2').get()).toMatchObject({ c: 1 });
    expect(testDb.prepare('SELECT COUNT(*) as c FROM audit_trail WHERE user_id = 1').get()).toMatchObject({ c: 1 });
  });

  it('returns correct counts per table', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);

    const counts = deleteAllUserData(1);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(typeof counts['conversations']).toBe('number');
    expect(typeof counts['users']).toBe('number');
  });

  it('returns zeros when deleting user with no data', () => {
    const counts = deleteAllUserData(999);
    expect(counts['conversations']).toBe(0);
    expect(counts['users']).toBe(0);
  });
});

describe('account deletion OAuth revocation', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    clearAppleRevocationCredentials();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearAppleRevocationCredentials();
    testDb.close();
  });

  it('best-effort revokes Google and Microsoft credentials before local deletion and removes Garmin locally', async () => {
    seedUser(testDb, 1);
    testDb.prepare(`
      INSERT INTO user_oauth_tokens (user_id, provider, access_token, refresh_token, token_type, scopes)
      VALUES
        (1, 'google', 'google-access', 'google-refresh', 'Bearer', '[]'),
        (1, 'outlook', 'outlook-access', 'outlook-refresh', 'Bearer', '[]')
    `).run();
    testDb.prepare(`
      INSERT INTO garmin_sessions (user_id, oauth1_token_json, oauth2_token_json)
      VALUES (1, '{}', '{}')
    `).run();
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const revocations = await revokeThirdPartyOAuthTokensForUser(1);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('google-refresh');
    expect(String(fetchMock.mock.calls[1][0])).toContain('login.microsoftonline.com');
    expect(String(fetchMock.mock.calls[1][1]?.body)).toContain('outlook-refresh');
    expect(revocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'google', status: 'revoked' }),
      expect.objectContaining({ provider: 'outlook', status: 'revoked' }),
      expect.objectContaining({ provider: 'garmin', status: 'local_only' }),
    ]));
    expect(testDb.prepare('SELECT 1 FROM garmin_sessions WHERE user_id = 1').get()).toBeUndefined();
  });

  it('account deletion calls revocation before erasing local OAuth rows', async () => {
    seedUser(testDb, 1);
    testDb.prepare(`
      INSERT INTO user_oauth_tokens (user_id, provider, access_token, refresh_token, token_type, scopes)
      VALUES (1, 'google', 'google-access', 'google-refresh', 'Bearer', '[]')
    `).run();
    const fetchMock = vi.fn(async () => new Response('', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const counts = await deleteAllUserDataForAccountDeletion(1);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(counts.user_oauth_tokens).toBe(1);
    expect(counts.local_inference_account_deletion_fences).toBe(1);
    expect(testDb.prepare('SELECT 1 FROM user_oauth_tokens WHERE user_id = 1').get()).toBeUndefined();
    expect(testDb.prepare(`SELECT 1 FROM local_inference_account_deletion_fences
      WHERE user_id = 1`).get()).toBeUndefined();
  });

  it('erases the account cleanly while retaining append-only credit-ledger evidence', async () => {
    seedUser(testDb, 1);
    testDb.prepare(`
      INSERT INTO ai_credit_lots (
        user_id, lot_type, credits_granted, granted_at, expires_at,
        source_kind, source_ref, provider, provider_transaction_id
      ) VALUES (1, 'purchased', 100, '2026-08-18T10:00:00.000Z', NULL,
                'provider_purchase', 'apple:txn-erase', 'apple', 'txn-erase')
    `).run();
    testDb.prepare(`
      INSERT INTO ai_credit_reservations (
        user_id, operation_class, credits, tenant_scope, workload,
        request_hash, client_operation_id, reserved_at, reserved_day
      ) VALUES (1, 'standard', 1, 'tenant-1', 'chat', 'hash-erase', 'op-erase',
                '2026-08-18T10:00:00.000Z', '2026-08-18')
    `).run();

    const counts = await deleteAllUserDataForAccountDeletion(1);

    expect(counts.users).toBe(1);
    expect(testDb.prepare('SELECT 1 FROM users WHERE telegram_id = 1').get()).toBeUndefined();
    // Billing evidence is retained under statutory retention (plan §4); the
    // append-only triggers would otherwise abort and roll back the whole
    // erasure. The full financial-evidence policy is NH-0035.
    expect(testDb.prepare('SELECT COUNT(*) AS c FROM ai_credit_lots WHERE user_id = 1').get()).toEqual({ c: 1 });
    expect(testDb.prepare('SELECT COUNT(*) AS c FROM ai_credit_reservations WHERE user_id = 1').get()).toEqual({ c: 1 });
    expect(counts).not.toHaveProperty('ai_credit_lots');
  });

  it('bounds every third-party revocation with an abort signal', async () => {
    seedUser(testDb, 1);
    testDb.prepare(`
      INSERT INTO user_oauth_tokens (user_id, provider, access_token, refresh_token, token_type, scopes)
      VALUES (1, 'google', 'google-access', 'google-refresh', 'Bearer', '[]')
    `).run();
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await revokeThirdPartyOAuthTokensForUser(1);

    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('completes deletion when a third-party revocation endpoint hangs and aborts', async () => {
    seedUser(testDb, 1);
    testDb.prepare(`
      INSERT INTO user_oauth_tokens (user_id, provider, access_token, refresh_token, token_type, scopes)
      VALUES (1, 'google', 'google-access', 'google-refresh', 'Bearer', '[]')
    `).run();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }));

    const counts = await deleteAllUserDataForAccountDeletion(1);

    expect(counts.user_oauth_tokens).toBe(1);
    expect(counts.users).toBe(1);
    expect(testDb.prepare('SELECT 1 FROM users WHERE telegram_id = 1').get()).toBeUndefined();
  });

  it('releases only its account-inference fence when transactional erasure fails', async () => {
    seedUser(testDb, 1);
    testDb.exec(`CREATE TRIGGER test_block_account_delete
      BEFORE DELETE ON users
      WHEN OLD.telegram_id = 1
      BEGIN
        SELECT RAISE(ABORT, 'injected account deletion failure');
      END;`);

    await expect(deleteAllUserDataForAccountDeletion(1))
      .rejects.toThrow('injected account deletion failure');

    expect(testDb.prepare(`SELECT 1 FROM local_inference_account_deletion_fences
      WHERE user_id = 1`).get()).toBeUndefined();
    expect(testDb.prepare('SELECT 1 FROM users WHERE telegram_id = 1').get()).toBeDefined();
  });
});

// ── Sign in with Apple revocation (Guideline 5.1.1(v)) ──

describe('account deletion Apple token revocation', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    clearAppleRevocationCredentials();
    seedUser(testDb, 1);
    markUserAsAppleSignIn(testDb, 1);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearAppleRevocationCredentials();
    testDb.close();
  });

  it('revokes the Apple token remotely BEFORE erasing the local credential', async () => {
    seedAppleRefreshToken(testDb, 1);
    configureAppleRevocationCredentials();
    let credentialPresentAtRevokeTime: boolean | null = null;
    const fetchMock = vi.fn(async () => {
      credentialPresentAtRevokeTime = !!testDb
        .prepare('SELECT 1 FROM apple_sign_in_refresh_tokens WHERE user_id = 1').get();
      return new Response('', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const counts = await deleteAllUserDataForAccountDeletion(1);

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://appleid.apple.com/auth/revoke');
    expect(String((fetchMock.mock.calls[0][1] as RequestInit).body)).toContain('apple-refresh-secret');
    expect(credentialPresentAtRevokeTime).toBe(true);
    expect(counts.apple_sign_in_refresh_tokens).toBe(1);
    expect(testDb.prepare('SELECT 1 FROM apple_sign_in_refresh_tokens WHERE user_id = 1').get()).toBeUndefined();
    expect(testDb.prepare('SELECT 1 FROM users WHERE telegram_id = 1').get()).toBeUndefined();
  });

  it('inventories the Apple credential as user-owned deletable data', () => {
    seedAppleRefreshToken(testDb, 1);

    expect(getAccountDeletionInventoryForUser(1).deletableTables.apple_sign_in_refresh_tokens).toBe(1);
  });

  it('reports apple as local_only when the Apple revocation env vars are unset', async () => {
    seedAppleRefreshToken(testDb, 1);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const revocations = await revokeThirdPartyOAuthTokensForUser(1);

    expect(revocations).toEqual([
      expect.objectContaining({ provider: 'apple', attempted: false, status: 'local_only' }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still deletes the account when the Apple revocation env vars are unset', async () => {
    seedAppleRefreshToken(testDb, 1);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const counts = await deleteAllUserDataForAccountDeletion(1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(counts.apple_sign_in_refresh_tokens).toBe(1);
    expect(counts.users).toBe(1);
  });

  it('records apple as local_only for an Apple user whose client never sent an authorization code', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    configureAppleRevocationCredentials();

    const revocations = await revokeThirdPartyOAuthTokensForUser(1);

    expect(revocations).toEqual([
      expect.objectContaining({ provider: 'apple', attempted: false, status: 'local_only' }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still deletes the account when Apple rejects or drops the revocation call', async () => {
    seedAppleRefreshToken(testDb, 1);
    configureAppleRevocationCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('appleid unreachable'); }));

    const revocations = await revokeThirdPartyOAuthTokensForUser(1);
    expect(revocations).toEqual([
      expect.objectContaining({ provider: 'apple', attempted: true, status: 'failed' }),
    ]);

    const counts = await deleteAllUserDataForAccountDeletion(1);
    expect(counts.apple_sign_in_refresh_tokens).toBe(1);
    expect(counts.users).toBe(1);
    expect(testDb.prepare('SELECT 1 FROM users WHERE telegram_id = 1').get()).toBeUndefined();
  });

  // Apple returns HTTP 400 for BOTH "this token is no longer accepted" and
  // "your client credentials are wrong". Reporting the second as success would
  // make the most likely first-deploy misconfiguration invisible, which is the
  // one thing the un-testable live call cannot afford.
  it('reports a misconfigured Apple client as failed, not already_revoked', async () => {
    seedAppleRefreshToken(testDb, 1);
    configureAppleRevocationCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"error":"invalid_client"}',
      { status: 400 },
    )));

    await expect(revokeThirdPartyOAuthTokensForUser(1)).resolves.toEqual([
      expect.objectContaining({ provider: 'apple', attempted: true, status: 'failed', statusCode: 400 }),
    ]);
  });

  it('still reports a token Apple no longer accepts as already_revoked', async () => {
    seedAppleRefreshToken(testDb, 1);
    configureAppleRevocationCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"error":"invalid_grant"}',
      { status: 400 },
    )));

    await expect(revokeThirdPartyOAuthTokensForUser(1)).resolves.toEqual([
      expect.objectContaining({ provider: 'apple', attempted: true, status: 'already_revoked', statusCode: 400 }),
    ]);
  });

  it('still deletes the account when the Apple revocation call times out', async () => {
    seedAppleRefreshToken(testDb, 1);
    configureAppleRevocationCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }));

    const counts = await deleteAllUserDataForAccountDeletion(1);

    expect(counts.apple_sign_in_refresh_tokens).toBe(1);
    expect(testDb.prepare('SELECT 1 FROM apple_sign_in_refresh_tokens WHERE user_id = 1').get()).toBeUndefined();
    expect(testDb.prepare('SELECT 1 FROM users WHERE telegram_id = 1').get()).toBeUndefined();
  });

  it('leaves non-Apple users out of the Apple revocation path entirely', async () => {
    testDb.prepare('UPDATE users SET apple_user_id = NULL WHERE telegram_id = 1').run();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(revokeThirdPartyOAuthTokensForUser(1)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── GDPR Compliance Integration Tests ──

describe('GDPR compliance', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => { testDb.close(); });

  it('export + delete covers every table with user_id', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);
    addTransaction(1, '2024-06-01', 'income', 5000);
    testDb.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        owner_user_id, tenant_id, lifecycle_state, provider_sync_state, title,
        start_at, end_at, decision_action, source_shape_hash, created_at, updated_at
      )
      VALUES (
        'agenda-gdpr-1', 'intent-gdpr-1', 'secretary', 'focus_block', 'schedule_this',
        1, '1', 'scheduled', 'not_synced', 'GDPR focus block',
        '2026-06-01T09:00:00Z', '2026-06-01T10:00:00Z', 'scheduled', 'shape-gdpr-1',
        '2026-05-31T10:00:00Z', '2026-05-31T10:00:00Z'
      )
    `).run();
    testDb.prepare(`
      INSERT INTO skill_memories (
        memory_id, tenant_id, user_id, skill_id, memory_type, scope,
        memory_key, memory_value, source
      )
      VALUES (
        'memory-gdpr-1', 1, 1, 'secretary', 'user_preference', 'user_private',
        'preferred_focus_time', 'morning', 'test'
      )
    `).run();

    // Export first
    const exported = exportAllUserData(1);
    expect(exported.conversations.length).toBeGreaterThan(0);
    expect(exported.todos.length).toBeGreaterThan(0);
    expect(exported.finance.transactions.length).toBeGreaterThan(0);
    expect(exported.secretaryAgendaItems).toEqual([
      expect.objectContaining({ agendaItemId: 'agenda-gdpr-1', title: 'GDPR focus block' }),
    ]);
    expect(exported.skillMemories).toEqual([
      expect.objectContaining({ memoryId: 'memory-gdpr-1', memoryKey: 'preferred_focus_time' }),
    ]);

    // Delete
    const counts = deleteAllUserData(1);
    expect(counts['conversations']).toBeGreaterThan(0);
    expect(counts['finance_transactions']).toBeGreaterThan(0);
    expect(counts['secretary_agenda_items']).toBe(1);
    expect(counts['skill_memories']).toBe(1);

    // Verify empty after deletion
    const afterExport = exportAllUserData(1);
    expect(afterExport.conversations).toHaveLength(0);
    expect(afterExport.todos).toHaveLength(0);
    expect(afterExport.finance.transactions).toHaveLength(0);
    expect(afterExport.secretaryAgendaItems).toHaveLength(0);
    expect(afterExport.skillMemories).toHaveLength(0);
  });

  it('audit trail entry is created for export operations', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);

    const data = exportAllUserData(1);
    logAudit({
      userId: 1,
      actorId: 1,
      action: 'export',
      resource: 'all',
      details: { conversations: data.conversations.length },
    });

    const trail = getAuditTrail(1);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe('export');
  });

  it('audit trail entry is created for delete operations', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);

    const counts = deleteAllUserData(1);
    logAudit({ userId: 1, actorId: 1, action: 'delete', resource: 'all', details: counts });

    const trail = getAuditTrail(1);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe('delete');
  });

  it('audit trail survives user deletion', () => {
    seedUser(testDb, 1);
    logAudit({ userId: 1, actorId: 1, action: 'export', resource: 'all' });

    // Delete the user completely
    deleteAllUserData(1);

    // Audit trail should still be there
    const trail = getAuditTrail(1);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe('export');
  });
});
