// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Per-user data export and deletion service — GDPR compliance.
 *
 * - exportUserFinanceData: finance-only export (legacy, used by full export)
 * - exportAllUserData: Article 20 — data portability (ALL tables)
 * - deleteAllUserData: Article 17 — right to erasure (ALL tables, transactional)
 * - countUserFinanceData: quick audit for finance records
 */

import { getDb } from './database';
import { getTransactions, getTaxEvents, getAnnualTaxSummary } from './finance-tracker';
import type { Transaction, TaxEvent, AnnualTaxSummary } from './finance-tracker';
import { getTokens, type OAuthProvider } from './oauth-store';
import { clearGarminSession } from './garmin-session-store';
import { logger } from '../utils/logger';

// ── Finance Export (existing) ───────────────────────────────────────

export interface UserFinanceExport {
  exportedAt: string;
  userId: number;
  transactions: Transaction[];
  taxEvents: TaxEvent[];
  annualSummaries: AnnualTaxSummary[];
}

export function exportUserFinanceData(userId: number): UserFinanceExport {
  const transactions = getTransactions(userId, { limit: 100000 });
  const taxEvents = getTaxEvents(userId, { limit: 100000 });

  const years = new Set<number>();
  for (const tx of transactions) {
    years.add(parseInt(tx.date.substring(0, 4), 10));
  }
  for (const te of taxEvents) {
    years.add(parseInt(te.month.substring(0, 4), 10));
  }

  const annualSummaries: AnnualTaxSummary[] = [];
  for (const year of Array.from(years).sort()) {
    annualSummaries.push(getAnnualTaxSummary(userId, year));
  }

  return {
    exportedAt: new Date().toISOString(),
    userId,
    transactions,
    taxEvents,
    annualSummaries,
  };
}

export function deleteUserFinanceData(userId: number): { transactionsDeleted: number; taxEventsDeleted: number } {
  const db = getDb();
  const txResult = db.prepare('DELETE FROM finance_transactions WHERE user_id = ?').run(userId);
  const taxResult = db.prepare('DELETE FROM finance_tax_events WHERE user_id = ?').run(userId);
  const metaResult = db.prepare('DELETE FROM user_encryption_meta WHERE user_id = ?').run(userId);

  return {
    transactionsDeleted: txResult.changes,
    taxEventsDeleted: taxResult.changes + metaResult.changes,
  };
}

type OAuthRevocationResult = {
  provider: string;
  attempted: boolean;
  status: 'revoked' | 'already_revoked' | 'failed' | 'local_only';
  statusCode?: number;
};

type RevocableProvider = OAuthProvider | 'garmin';

async function postFormRevocation(url: string, body: URLSearchParams): Promise<{ statusCode: number; ok: boolean }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return { statusCode: response.status, ok: response.ok || (response.status >= 400 && response.status < 500) };
}

async function revokeOneThirdPartyProvider(userId: number, provider: RevocableProvider): Promise<OAuthRevocationResult> {
  if (provider === 'garmin') {
    // The Garmin integration in this codebase has no stable public revoke
    // endpoint; remove the durable local session and record that this
    // provider is local-only.
    clearGarminSession(userId);
    return { provider, attempted: true, status: 'local_only' };
  }

  const tokens = getTokens(userId, provider);
  if (!tokens) {
    return { provider, attempted: false, status: 'local_only' };
  }

  try {
    if (provider === 'google') {
      const token = tokens.refreshToken || tokens.accessToken;
      const result = await postFormRevocation('https://oauth2.googleapis.com/revoke', new URLSearchParams({ token }));
      return {
        provider,
        attempted: true,
        status: result.ok ? (result.statusCode >= 400 ? 'already_revoked' : 'revoked') : 'failed',
        statusCode: result.statusCode,
      };
    }

    if (provider === 'outlook') {
      const tenantId = process.env.OUTLOOK_TENANT_ID || 'common';
      const token = tokens.refreshToken || tokens.accessToken;
      const result = await postFormRevocation(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout`,
        new URLSearchParams({ token }),
      );
      return {
        provider,
        attempted: true,
        status: result.ok ? (result.statusCode >= 400 ? 'already_revoked' : 'revoked') : 'failed',
        statusCode: result.statusCode,
      };
    }

    return { provider, attempted: false, status: 'local_only' };
  } catch (err) {
    logger.warn({ err, userId, provider }, 'OAuth revocation failed');
    return { provider, attempted: true, status: 'failed' };
  }
}

export async function revokeThirdPartyOAuthTokenForProvider(
  userId: number,
  provider: RevocableProvider,
): Promise<OAuthRevocationResult> {
  return revokeOneThirdPartyProvider(userId, provider);
}

/**
 * Best-effort third-party credential revocation before local erasure.
 *
 * 4xx responses are treated as already-revoked/invalid-token success because
 * the provider no longer accepts the credential. Network/5xx failures are
 * logged and tolerated so Article 17 local deletion can still proceed.
 */
export async function revokeThirdPartyOAuthTokensForUser(userId: number): Promise<OAuthRevocationResult[]> {
  const db = getDb();
  const rows = safeAll(db, 'SELECT provider FROM user_oauth_tokens WHERE user_id = ?', userId) as Array<{ provider: OAuthProvider }>;
  const results: OAuthRevocationResult[] = [];

  for (const row of rows) {
    results.push(await revokeOneThirdPartyProvider(userId, row.provider));
  }

  const garminSession = safeGet(db, 'SELECT user_id FROM garmin_sessions WHERE user_id = ?', userId);
  if (garminSession) {
    results.push(await revokeOneThirdPartyProvider(userId, 'garmin'));
  }

  return results;
}

export async function deleteAllUserDataForAccountDeletion(userId: number): Promise<Record<string, number>> {
  await revokeThirdPartyOAuthTokensForUser(userId);
  return deleteAllUserData(userId);
}

export function countUserFinanceData(userId: number): { transactions: number; taxEvents: number } {
  const db = getDb();
  const txCount = db.prepare('SELECT COUNT(*) as cnt FROM finance_transactions WHERE user_id = ?').get(userId) as { cnt: number };
  const taxCount = db.prepare('SELECT COUNT(*) as cnt FROM finance_tax_events WHERE user_id = ?').get(userId) as { cnt: number };
  return {
    transactions: txCount.cnt,
    taxEvents: taxCount.cnt,
  };
}

// ── Full User Export (GDPR Article 20 — data portability) ───────────

export interface FullUserExport {
  exportedAt: string;
  userId: number;
  user: {
    username: string | null;
    firstName: string | null;
    language: string;
    timezone: string;
    tier: string;
    createdAt: string;
  } | null;
  conversations: Array<{ domain: string; role: string; content: string; createdAt: string }>;
  todos: Array<{ title: string; description: string | null; status: string; priority: string; dueDate: string | null; createdAt: string }>;
  reminders: Array<{ message: string; remindAt: string; status: string; createdAt: string }>;
  notes: Array<{ content: string; domain: string; createdAt: string }>;
  savedIdeas: Array<{ content: string; createdAt: string }>;
  sharedMemory: Array<{ key: string; value: string; updatedAt: string }>;
  finance: UserFinanceExport;
  oauthConnections: Array<{ provider: string; connectedAt: string }>;
  settings: Array<{ key: string; value: string }>;
  notificationDeviceTokens: Array<{ environment: string; platform: string; appVersion: string | null; lastSeenAt: string; revokedAt: string | null }>;
  garminSessions: Array<{ lastRefreshedAt: string | null; createdAt: string; updatedAt: string }>;
  agentSignals: Array<{ sourceAgent: string; signalType: string; status: string; createdAt: string }>;
  encryptionMeta: Array<{ keyVersion: number; encryptedAt: string; updatedAt: string }>;
  legalConsents: Array<{ documentKey: string; documentVersion: string; documentUrl: string; acceptedAt: string; source: string }>;
  secretaryAgendaItems: Array<{
    agendaItemId: string;
    sourceSkill: string;
    title: string;
    lifecycleState: string;
    startAt: string | null;
    endAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  skillMemories: Array<{
    memoryId: string;
    skillId: string;
    memoryType: string;
    scope: string;
    memoryKey: string;
    memoryValue: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
  trainingFeedbackDecisions: Array<{
    sourceSkill: string;
    agendaItemId: string;
    sourceIntentId: string;
    feedbackType: string;
    status: string;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  secretarySourceSkillFeedback: Array<{
    targetSkill: string;
    agendaItemId: string;
    sourceIntentId: string;
    feedbackType: string;
    status: string;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}

export function exportAllUserData(userId: number): FullUserExport {
  const db = getDb();

  // User profile
  const user = safeGet(db, 'SELECT username, first_name, language, timezone, tier, created_at FROM users WHERE telegram_id = ?', userId);

  // Conversations
  const conversations = safeAll(db,
    "SELECT domain, role, content, created_at as createdAt FROM conversations WHERE tenant_id = ? AND user_id = ? AND scope_status = 'active' ORDER BY created_at",
    userId,
    userId);

  // Todos
  const todos = safeAll(db,
    'SELECT title, description, status, priority, due_date as dueDate, created_at as createdAt FROM todos WHERE user_id = ? ORDER BY created_at', userId);

  // Reminders
  const reminders = safeAll(db,
    'SELECT message, remind_at as remindAt, status, created_at as createdAt FROM reminders WHERE user_id = ? ORDER BY created_at', userId);

  // Notes
  const notes = safeAll(db,
    'SELECT content, domain, created_at as createdAt FROM notes WHERE user_id = ? ORDER BY created_at', userId);

  // Saved Ideas
  const savedIdeas = safeAll(db,
    'SELECT content, created_at as createdAt FROM saved_ideas WHERE user_id = ? ORDER BY created_at', userId);

  // Shared Memory
  const sharedMemory = safeAll(db,
    "SELECT key, value, updated_at as updatedAt FROM shared_memory WHERE tenant_id = ? AND user_id = ? AND scope_status = 'active' ORDER BY key",
    userId,
    userId);

  // Finance (uses existing decrypting export)
  const finance = exportUserFinanceData(userId);

  // OAuth connections (metadata only — NO tokens for security)
  const oauthRows = safeAll(db,
    'SELECT provider, created_at FROM user_oauth_tokens WHERE user_id = ?', userId);

  // User settings from kv_store
  const settings = safeAll(db,
    "SELECT key, value FROM kv_store WHERE key LIKE ?", `config:${userId}:%`);
  const notificationDeviceTokens = safeAll(db,
    'SELECT environment, platform, app_version as appVersion, last_seen_at as lastSeenAt, revoked_at as revokedAt FROM notification_device_tokens WHERE user_id = ?', userId);
  const garminSessions = safeAll(db,
    'SELECT last_refreshed_at as lastRefreshedAt, created_at as createdAt, updated_at as updatedAt FROM garmin_sessions WHERE user_id = ?', userId);
  const agentSignals = safeAll(db,
    'SELECT source_agent as sourceAgent, signal_type as signalType, status, created_at as createdAt FROM agent_signals WHERE user_id = ? ORDER BY created_at', userId);
  const encryptionMeta = safeAll(db,
    'SELECT key_version as keyVersion, encrypted_at as encryptedAt, updated_at as updatedAt FROM user_encryption_meta WHERE user_id = ?', userId);
  const legalConsents = safeAll(db,
    'SELECT document_key as documentKey, document_version as documentVersion, document_url as documentUrl, accepted_at as acceptedAt, source FROM user_legal_consents WHERE user_id = ? ORDER BY accepted_at', userId);
  const secretaryAgendaItems = safeAll(db, `
    SELECT agenda_item_id as agendaItemId,
           source_skill as sourceSkill,
           title,
           lifecycle_state as lifecycleState,
           start_at as startAt,
           end_at as endAt,
           created_at as createdAt,
           updated_at as updatedAt
    FROM secretary_agenda_items
    WHERE owner_user_id = ?
    ORDER BY created_at
  `, userId);
  const skillMemories = safeAll(db, `
    SELECT memory_id as memoryId,
           skill_id as skillId,
           memory_type as memoryType,
           scope,
           memory_key as memoryKey,
           memory_value as memoryValue,
           status,
           created_at as createdAt,
           updated_at as updatedAt
    FROM skill_memories
    WHERE user_id = ?
    ORDER BY updated_at
  `, userId);
  const trainingFeedbackDecisions = safeAll(db, `
    SELECT source_skill as sourceSkill,
           agenda_item_id as agendaItemId,
           source_intent_id as sourceIntentId,
           feedback_type as feedbackType,
           status,
           scheduled_start as scheduledStart,
           scheduled_end as scheduledEnd,
           created_at as createdAt,
           updated_at as updatedAt
    FROM training_feedback_decisions
    WHERE user_id = ?
    ORDER BY created_at
  `, userId);
  const secretarySourceSkillFeedback = safeAll(db, `
    SELECT target_skill as targetSkill,
           agenda_item_id as agendaItemId,
           source_intent_id as sourceIntentId,
           feedback_type as feedbackType,
           status,
           scheduled_start as scheduledStart,
           scheduled_end as scheduledEnd,
           created_at as createdAt,
           updated_at as updatedAt
    FROM secretary_source_skill_feedback
    WHERE user_id = ?
    ORDER BY created_at
  `, userId);

  return {
    exportedAt: new Date().toISOString(),
    userId,
    user: user ? {
      username: user.username,
      firstName: user.first_name,
      language: user.language,
      timezone: user.timezone,
      tier: user.tier,
      createdAt: user.created_at,
    } : null,
    conversations,
    todos,
    reminders,
    notes,
    savedIdeas,
    sharedMemory,
    finance,
    oauthConnections: oauthRows.map((c: any) => ({ provider: c.provider, connectedAt: c.created_at })),
    settings: settings.map((s: any) => ({ key: s.key.replace(`config:${userId}:`, ''), value: s.value })),
    notificationDeviceTokens,
    garminSessions,
    agentSignals,
    encryptionMeta,
    legalConsents,
    secretaryAgendaItems,
    skillMemories,
    trainingFeedbackDecisions,
    secretarySourceSkillFeedback,
  };
}

// ── Full User Deletion (GDPR Article 17 — right to erasure) ────────

export const ACCOUNT_DELETION_TABLES: Array<{ table: string; column: string }> = [
  { table: 'messages', column: 'user_id' },
  { table: 'conversations', column: 'user_id' },
  { table: 'todos', column: 'user_id' },
  { table: 'native_tasks', column: 'user_id' },
  { table: 'native_task_lists', column: 'user_id' },
  { table: 'reminders', column: 'user_id' },
  { table: 'secretary_agenda_items', column: 'owner_user_id' },
  { table: 'skill_memories', column: 'user_id' },
  { table: 'training_feedback_decisions', column: 'user_id' },
  { table: 'secretary_source_skill_feedback', column: 'user_id' },
  { table: 'notes', column: 'user_id' },
  { table: 'saved_ideas', column: 'user_id' },
  { table: 'shared_memory', column: 'user_id' },
  { table: 'apple_health_data', column: 'user_id' },
  { table: 'readiness_scores', column: 'user_id' },
  { table: 'training_completions', column: 'user_id' },
  {
    table: 'fitness_training_plans',
    column: 'user_id',
  },
  { table: 'finance_transactions', column: 'user_id' },
  { table: 'finance_tax_events', column: 'user_id' },
  { table: 'invoice_filings', column: 'user_id' },
  { table: 'user_encryption_meta', column: 'user_id' },
  { table: 'onboarding_sessions', column: 'user_id' },
  { table: 'user_profiles', column: 'user_id' },
  { table: 'ios_devices', column: 'user_id' },
  { table: 'notification_device_tokens', column: 'user_id' },
  { table: 'garmin_sessions', column: 'user_id' },
  { table: 'garmin_user_tokens', column: 'user_id' },
  { table: 'agent_signals', column: 'user_id' },
  { table: 'user_oauth_tokens', column: 'user_id' },
  { table: 'oauth_ios_nonce_sessions', column: 'user_id' },
  { table: 'user_skill_overrides', column: 'user_id' },
  { table: 'api_usage', column: 'user_id' },
  { table: 'chat_action_runs', column: 'user_id' },
  { table: 'chat_pending_actions', column: 'user_id' },
  { table: 'chat_action_telemetry', column: 'user_id' },
  { table: 'user_legal_consents', column: 'user_id' },
  { table: 'report_documents', column: 'user_id' },
  { table: 'push_preferences', column: 'user_id' },
  { table: 'content_notifications', column: 'user_id' },
  { table: 'content_scripts', column: 'user_id' },
  { table: 'content_performance', column: 'user_id' },
  { table: 'content_learned_patterns', column: 'user_id' },
  { table: 'content_pipeline', column: 'user_id' },
  { table: 'content_topic_feedback', column: 'user_id' },
  { table: 'content_topics', column: 'user_id' },
  { table: 'content_knowledge', column: 'user_id' },
  { table: 'content_ref_channels', column: 'user_id' },
  { table: 'book_library', column: 'user_id' },
  { table: 'subscriptions', column: 'user_id' },
  { table: 'stripe_web_checkouts', column: 'user_id' },
];

const ACCOUNT_DELETION_RETAINED_TABLES = new Set([
  'audit_trail',
  '_migrations',
]);

function accountDeletionTablesForDb(db: any): Array<{ table: string; column: string }> {
  const tables: Array<{ table: string; column: string }> = [];
  const seen = new Set<string>();
  const add = (entry: { table: string; column: string }) => {
    const key = `${entry.table}.${entry.column}`;
    if (seen.has(key)) return;
    seen.add(key);
    tables.push(entry);
  };

  for (const entry of ACCOUNT_DELETION_TABLES) add(entry);

  try {
    const rows = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
    `).all() as Array<{ name: string }>;
    for (const row of rows) {
      if (!row?.name || row.name === 'users' || ACCOUNT_DELETION_RETAINED_TABLES.has(row.name)) continue;
      const columns = db.prepare(`PRAGMA table_info(${row.name})`).all() as Array<{ name: string }>;
      if (columns.some((column) => column.name === 'user_id')) {
        add({ table: row.name, column: 'user_id' });
      }
    }
  } catch {
    // Keep the seeded list usable even if schema introspection fails.
  }

  return tables;
}

export interface AccountDeletionInventory {
  userId: number;
  generatedAt: string;
  deletableTables: Record<string, number>;
  retainedTables: Record<string, { reason: string }>;
}

export function getAccountDeletionInventoryForUser(userId: number): AccountDeletionInventory {
  const db = getDb();
  const deletableTables: Record<string, number> = {};
  for (const { table, column } of accountDeletionTablesForDb(db)) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(userId) as { count: number };
      deletableTables[table] = row.count;
    } catch {
      deletableTables[table] = 0;
    }
  }
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM kv_store WHERE key LIKE ?').get(`config:${userId}:%`) as { count: number };
    deletableTables.kv_store_settings = row.count;
  } catch {
    deletableTables.kv_store_settings = 0;
  }
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ? OR telegram_id = ?').get(userId, userId) as { count: number };
    deletableTables.users = row.count;
  } catch {
    deletableTables.users = 0;
  }

  return {
    userId,
    generatedAt: new Date().toISOString(),
    deletableTables,
    retainedTables: {
      audit_trail: {
        reason: 'Retained as legal proof of export, consent, and deletion events under GDPR Article 17(3)(e).',
      },
    },
  };
}

/**
 * Delete ALL data for a user across all tables. Runs in a single transaction.
 * The audit_trail table is NOT touched — legal requirement (Article 17(3)(e)).
 * Returns counts of deleted records per table.
 */
export function deleteAllUserData(userId: number): Record<string, number> {
  const db = getDb();
  const counts: Record<string, number> = {};

  const deleteAll = db.transaction(() => {
    for (const { table, column } of accountDeletionTablesForDb(db)) {
      try {
        const result = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(userId);
        counts[table] = result.changes;
      } catch {
        counts[table] = 0; // table may not exist
      }
    }

    // KV store per-user settings
    try {
      const kvResult = db.prepare("DELETE FROM kv_store WHERE key LIKE ?").run(`config:${userId}:%`);
      counts['kv_store_settings'] = kvResult.changes;
    } catch {
      counts['kv_store_settings'] = 0;
    }

    // Delete user record last
    try {
      const userResult = db.prepare('DELETE FROM users WHERE id = ? OR telegram_id = ?').run(userId, userId);
      counts['users'] = userResult.changes;
    } catch {
      counts['users'] = 0;
    }
  });

  deleteAll();

  return counts;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Safe query that returns null instead of throwing if the table doesn't exist. */
function safeGet(db: any, sql: string, ...params: any[]): any {
  try {
    return db.prepare(sql).get(...params) ?? null;
  } catch {
    return null;
  }
}

/** Safe query that returns [] instead of throwing if the table doesn't exist. */
function safeAll(db: any, sql: string, ...params: any[]): any[] {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}
