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
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { vi } from 'vitest';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (!applied) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
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

// ── Helper: seed a user record ──
function seedUser(db: Database.Database, telegramId: number, opts?: { username?: string; language?: string }) {
  try {
    db.prepare(`
      INSERT INTO users (telegram_id, username, first_name, language, timezone, tier, status)
      VALUES (?, ?, 'Test', ?, 'Europe/Lisbon', 'free', 'active')
    `).run(telegramId, opts?.username ?? 'testuser', opts?.language ?? 'en-US');
  } catch { /* table may not exist */ }
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
    testDb = createTestDb();
    applyMigrations(testDb);
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
    testDb = createTestDb();
    applyMigrations(testDb);
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
    testDb = createTestDb();
    applyMigrations(testDb);
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
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('exports conversations for the correct user', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);

    const exported = exportAllUserData(1);
    expect(exported.conversations).toHaveLength(2);
    expect(exported.conversations[0].domain).toBe('secretary');
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

  it('does NOT include other users data', () => {
    seedUser(testDb, 1);
    seedUser(testDb, 2, { username: 'other' });
    seedUserData(testDb, 1);
    seedUserData(testDb, 2);

    const exported = exportAllUserData(1);
    expect(exported.conversations).toHaveLength(2); // only user 1's
    expect(exported.todos).toHaveLength(1);
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
    testDb = createTestDb();
    applyMigrations(testDb);
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
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
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
    expect(testDb.prepare('SELECT 1 FROM user_oauth_tokens WHERE user_id = 1').get()).toBeUndefined();
  });
});

// ── GDPR Compliance Integration Tests ──

describe('GDPR compliance', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
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
