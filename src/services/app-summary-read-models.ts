// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * App-facing summary read models.
 *
 * These are deliberately small and rebuildable. They let iOS/portal read a
 * bounded, privacy-safe snapshot without triggering model/provider/calendar
 * work on simple screen loads.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { ensureEventOutboxTables, getEventSequenceBounds } from './event-outbox';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';

export type SummaryType = 'home' | 'week' | 'training' | 'content' | 'notifications';

export interface AppSummaryReadModel {
  summaryId: string;
  tenantId: number;
  userId: number;
  summaryType: SummaryType;
  payload: Record<string, unknown>;
  version: number;
  sourceEventSequence: number | null;
  isStale: boolean;
  createdAt: string;
  updatedAt: string;
}

export function ensureAppSummaryTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_summary_read_models (
      summary_id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      summary_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      source_event_sequence INTEGER,
      is_stale INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, user_id, summary_type)
    );
    CREATE INDEX IF NOT EXISTS idx_app_summary_scope_type
      ON app_summary_read_models(tenant_id, user_id, summary_type, updated_at);
  `);
}

export function projectSummaryReadModelsForUser(input: {
  tenantId: number;
  userId: number;
  summaryTypes?: SummaryType[];
  db?: Database.Database;
}): AppSummaryReadModel[] {
  const db = input.db ?? getDb();
  assertSummaryScope(input.userId, input.tenantId, 'project_summary_read_models');
  ensureAppSummaryTables(db);
  ensureEventOutboxTables(db);
  const types = input.summaryTypes ?? ['home', 'week', 'training', 'content', 'notifications'];
  const maxSequence = getEventSequenceBounds(db).max;
  return types.map((type) => upsertSummary({
    tenantId: input.tenantId,
    userId: input.userId,
    summaryType: type,
    payload: buildSummaryPayload(type, input.userId, input.tenantId, db),
    sourceEventSequence: maxSequence,
    db,
  }));
}

export function getAppSummary(input: {
  tenantId: number;
  userId: number;
  summaryType: SummaryType;
  rebuildIfMissing?: boolean;
  db?: Database.Database;
}): AppSummaryReadModel {
  const db = input.db ?? getDb();
  assertSummaryScope(input.userId, input.tenantId, 'get_app_summary', { summaryType: input.summaryType });
  ensureAppSummaryTables(db);
  const row = db.prepare(`
    SELECT * FROM app_summary_read_models
    WHERE tenant_id = ? AND user_id = ? AND summary_type = ?
  `).get(input.tenantId, input.userId, input.summaryType) as any | undefined;
  if (row && !row.is_stale) return mapSummary(row);
  if (input.rebuildIfMissing === false) {
    return emptySummary(input.tenantId, input.userId, input.summaryType);
  }
  return projectSummaryReadModelsForUser({
    tenantId: input.tenantId,
    userId: input.userId,
    summaryTypes: [input.summaryType],
    db,
  })[0];
}

export function markSummaryStale(input: {
  tenantId: number;
  userId: number;
  summaryType?: SummaryType;
  db?: Database.Database;
}): number {
  const db = input.db ?? getDb();
  ensureAppSummaryTables(db);
  if (input.summaryType) {
    return db.prepare(`
      UPDATE app_summary_read_models
      SET is_stale = 1
      WHERE tenant_id = ? AND user_id = ? AND summary_type = ?
    `).run(input.tenantId, input.userId, input.summaryType).changes;
  }
  return db.prepare(`
    UPDATE app_summary_read_models
    SET is_stale = 1
    WHERE tenant_id = ? AND user_id = ?
  `).run(input.tenantId, input.userId).changes;
}

function upsertSummary(input: {
  tenantId: number;
  userId: number;
  summaryType: SummaryType;
  payload: Record<string, unknown>;
  sourceEventSequence: number | null;
  db: Database.Database;
}): AppSummaryReadModel {
  const existing = input.db.prepare(`
    SELECT summary_id, version FROM app_summary_read_models
    WHERE tenant_id = ? AND user_id = ? AND summary_type = ?
  `).get(input.tenantId, input.userId, input.summaryType) as { summary_id: string; version: number } | undefined;

  const summaryId = existing?.summary_id ?? randomUUID();
  input.db.prepare(`
    INSERT INTO app_summary_read_models (
      summary_id, tenant_id, user_id, summary_type, payload_json, version,
      source_event_sequence, is_stale, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(tenant_id, user_id, summary_type) DO UPDATE SET
      payload_json = excluded.payload_json,
      version = app_summary_read_models.version + 1,
      source_event_sequence = excluded.source_event_sequence,
      is_stale = 0,
      updated_at = datetime('now')
  `).run(
    summaryId,
    input.tenantId,
    input.userId,
    input.summaryType,
    JSON.stringify(input.payload),
    existing ? existing.version + 1 : 1,
    input.sourceEventSequence,
  );

  return mapSummary(input.db.prepare(`
    SELECT * FROM app_summary_read_models
    WHERE tenant_id = ? AND user_id = ? AND summary_type = ?
  `).get(input.tenantId, input.userId, input.summaryType) as any);
}

function buildSummaryPayload(type: SummaryType, userId: number, tenantId: number, db: Database.Database): Record<string, unknown> {
  const generatedAt = new Date().toISOString();
  const training = buildTrainingSummary(userId, tenantId, db);
  const content = buildContentSummary(userId, tenantId, db);
  const notifications = buildNotificationSummary(userId, tenantId, db);
  const cooking = buildCookingSummary(userId, tenantId, db);
  const finance = buildFinanceSummary(userId, tenantId, db);
  const agenda = buildAgendaSummary(userId, tenantId, db);

  if (type === 'home') {
    return {
      kind: 'home',
      generatedAt,
      nextAgendaItem: agenda.nextAgendaItem,
      pendingDecisionsCount: notifications.needsDecisionCount,
      nextTrainingSummary: training.nextSession,
      contentPendingCount: content.pendingCount,
      cookingTodaySummary: cooking.todaySummary,
      financeReminderCount: finance.reminderCount,
      notificationUnreadCount: notifications.unreadCount,
      degraded: false,
    };
  }
  if (type === 'week') {
    return {
      kind: 'week',
      generatedAt,
      agendaOverview: agenda,
      trainingSessionsSummary: training.week,
      contentScheduledSummary: content.scheduledThisWeek,
      cookingMealPlanSummary: cooking.weekSummary,
      financeReminders: finance,
      conflictsCount: notifications.conflictsCount,
    };
  }
  if (type === 'training') {
    return { kind: 'training', generatedAt, ...training };
  }
  if (type === 'content') {
    return { kind: 'content', generatedAt, ...content };
  }
  return { kind: 'notifications', generatedAt, ...notifications };
}

function buildTrainingSummary(userId: number, tenantId: number, db: Database.Database): Record<string, unknown> {
  const activePlan = tableExists(db, 'fitness_training_plans')
    ? db.prepare('SELECT id, name, sport, goal, status FROM fitness_training_plans WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1').get(userId, 'active') as any | undefined
    : undefined;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const nextSession = activePlan && tableExists(db, 'training_sessions')
    ? db.prepare(`
        SELECT id, title, session_type, duration_minutes, status
        FROM training_sessions
        WHERE plan_id = ? AND status IN ('pending', 'moved')
        ORDER BY id ASC
        LIMIT 1
      `).get(activePlan.id) as any | undefined
    : undefined;
  const weekCount = activePlan && tableExists(db, 'training_sessions')
    ? countRows(db, 'training_sessions', 'plan_id = ? AND status IN (\'pending\', \'moved\', \'completed\', \'skipped\')', [activePlan.id])
    : 0;
  const warningsCount = activePlan ? countRows(db, 'notification_center_items', "user_id = ? AND tenant_id = ? AND source_skill = ? AND status = ? AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))", [userId, tenantId, 'training', 'unread']) : 0;
  return {
    activePlanId: activePlan?.id ?? null,
    currentBlock: activePlan?.name ?? null,
    goalMode: activePlan?.goal ?? activePlan?.sport ?? null,
    nextSession: nextSession ? safeTrainingSession(nextSession) : null,
    todayName: today,
    week: { totalSessions: weekCount },
    planWarningsCount: warningsCount,
    calendarSyncState: 'not_synced',
  };
}

function buildContentSummary(userId: number, tenantId: number, db: Database.Database): Record<string, unknown> {
  const pendingTopics = countScopedRows(db, 'content_topics', userId, tenantId, 'status IN (\'planned\', \'drafting\', \'ready\')');
  const scheduledThisWeek = countScopedRows(db, 'content_topics', userId, tenantId, 'scheduled_date >= date(\'now\') AND scheduled_date < date(\'now\', \'+7 days\')');
  const scriptsInProgress = countScopedRows(db, 'content_scripts', userId, tenantId, 'status IS NOT NULL');
  const profileRows = countRows(db, 'content_creator_profile', 'user_id = ? AND tenant_id = ? AND scope_status = ?', [userId, tenantId, 'active']);
  return {
    profileCompleteness: profileRows > 0 ? 'configured' : 'not_started',
    ideasNeedingReview: pendingTopics,
    scriptsInProgress,
    scheduledThisWeek,
    radarOpportunitiesCount: countScopedRows(db, 'content_radar_signals', userId, tenantId, 'status = ?', ['active'], 'owner_user_id'),
    pendingCount: pendingTopics + scriptsInProgress,
  };
}

function buildNotificationSummary(userId: number, tenantId: number, db: Database.Database): Record<string, unknown> {
  // A1: a notification whose hard deadline has passed must not count as unread/pending,
  // even before the decision_expiry sweep flips its status. Same predicate as the
  // findActiveDuplicate guard in notification-orchestrator.
  const notExpired = "(expires_at IS NULL OR datetime(expires_at) > datetime('now'))";
  return {
    unreadCount: countRows(db, 'notification_center_items', `user_id = ? AND tenant_id = ? AND status = ? AND ${notExpired}`, [userId, tenantId, 'unread']),
    needsDecisionCount: countRows(db, 'notification_center_items', `user_id = ? AND tenant_id = ? AND type = ? AND status = ? AND ${notExpired}`, [userId, tenantId, 'decision_required', 'unread']),
    conflictsCount: countRows(db, 'notification_center_items', `user_id = ? AND tenant_id = ? AND type = ? AND status = ? AND ${notExpired}`, [userId, tenantId, 'conflict_detected', 'unread']),
    approvalsCount: countRows(db, 'notification_center_items', `user_id = ? AND tenant_id = ? AND type = ? AND status = ? AND ${notExpired}`, [userId, tenantId, 'approval_required', 'unread']),
    remindersCount: countRows(db, 'notification_center_items', `user_id = ? AND tenant_id = ? AND type = ? AND status = ? AND ${notExpired}`, [userId, tenantId, 'reminder', 'unread']),
  };
}

function buildCookingSummary(userId: number, tenantId: number, db: Database.Database): Record<string, unknown> {
  const todayMeals = countScopedRows(db, 'meal_plans', userId, tenantId, 'date = date(\'now\')');
  const weekMeals = countScopedRows(db, 'meal_plans', userId, tenantId, 'date >= date(\'now\') AND date < date(\'now\', \'+7 days\')');
  return {
    todaySummary: todayMeals > 0 ? `${todayMeals} meals planned today` : 'No meals planned today',
    weekSummary: { plannedMeals: weekMeals },
  };
}

function buildFinanceSummary(userId: number, tenantId: number, db: Database.Database): Record<string, unknown> {
  const pendingTax = countScopedRows(db, 'finance_tax_events', userId, tenantId, 'status IN (\'pending\', \'overdue\')');
  return { reminderCount: pendingTax, pendingTaxEvents: pendingTax };
}

function buildAgendaSummary(userId: number, tenantId: number, db: Database.Database): Record<string, unknown> {
  if (!tableExists(db, 'secretary_agenda_items')) {
    return { nextAgendaItem: null, scheduledCount: 0 };
  }
  const next = db.prepare(`
    SELECT agenda_item_id, source_skill, lifecycle_state, title, start_at
    FROM secretary_agenda_items
    WHERE owner_user_id = ?
      AND tenant_id = ?
      AND lifecycle_state IN ('scheduled', 'synced', 'proposed')
      AND (start_at IS NULL OR start_at >= datetime('now'))
    ORDER BY start_at ASC
    LIMIT 1
  `).get(userId, tenantId) as any | undefined;
  return {
    nextAgendaItem: next ? {
      id: next.agenda_item_id,
      sourceSkill: next.source_skill,
      state: next.lifecycle_state,
      title: next.title ? 'Agenda item' : null,
      startAt: next.start_at ?? null,
    } : null,
    scheduledCount: countRows(db, 'secretary_agenda_items', 'owner_user_id = ? AND tenant_id = ?', [userId, tenantId]),
  };
}

function countScopedRows(
  db: Database.Database,
  table: string,
  userId: number,
  tenantId: number,
  whereSql: string,
  params: unknown[] = [],
  preferredUserColumn = 'user_id',
): number {
  if (!tableExists(db, table)) return 0;
  const userColumn = columnExists(db, table, preferredUserColumn)
    ? preferredUserColumn
    : columnExists(db, table, 'owner_user_id')
      ? 'owner_user_id'
      : 'user_id';
  if (!columnExists(db, table, userColumn)) return 0;
  const scopeParts = [`${userColumn} = ?`];
  const scopeParams: unknown[] = [userId];
  if (columnExists(db, table, 'tenant_id')) {
    scopeParts.push('tenant_id = ?');
    scopeParams.push(tenantId);
  }
  const combinedWhere = `${scopeParts.join(' AND ')}${whereSql ? ` AND ${whereSql}` : ''}`;
  return countRows(db, table, combinedWhere, [...scopeParams, ...params]);
}

function countRows(db: Database.Database, table: string, whereSql: string, params: unknown[]): number {
  if (!tableExists(db, table)) return 0;
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${whereSql}`).get(...params) as { count: number };
    return Number(row.count ?? 0);
  } catch {
    return 0;
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { 1?: number } | undefined;
  return Boolean(row);
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((row) => row.name === column);
  } catch {
    return false;
  }
}

function safeTrainingSession(row: any): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title ? 'Training session' : null,
    type: row.session_type ?? null,
    durationMinutes: row.duration_minutes ?? null,
    status: row.status ?? null,
  };
}

function assertSummaryScope(userId: number, tenantId: number, operation: string, details?: Record<string, unknown>): void {
  if (isValidTenantUserId(userId) && isValidTenantUserId(tenantId)) return;
  recordTenantScopeAnomaly({
    layer: 'delivery',
    operation,
    reason: 'invalid_user_scope',
    userId: typeof userId === 'number' ? userId : null,
    details,
  });
  throw new Error('valid userId and tenantId required');
}

function emptySummary(tenantId: number, userId: number, summaryType: SummaryType): AppSummaryReadModel {
  const now = new Date().toISOString();
  return {
    summaryId: 'missing',
    tenantId,
    userId,
    summaryType,
    payload: { kind: summaryType, generatedAt: now, degraded: true },
    version: 0,
    sourceEventSequence: null,
    isStale: true,
    createdAt: now,
    updatedAt: now,
  };
}

function mapSummary(row: any): AppSummaryReadModel {
  return {
    summaryId: row.summary_id,
    tenantId: Number(row.tenant_id),
    userId: Number(row.user_id),
    summaryType: row.summary_type,
    payload: parseObject(row.payload_json),
    version: Number(row.version ?? 1),
    sourceEventSequence: row.source_event_sequence == null ? null : Number(row.source_event_sequence),
    isStale: Boolean(row.is_stale),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
