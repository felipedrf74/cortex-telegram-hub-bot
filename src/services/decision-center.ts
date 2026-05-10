// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Decision Center facade.
 *
 * Notification Orchestrator remains the durable substrate for intents,
 * in-app items, preferences, device tokens, and APNs delivery attempts.
 * This module is the stricter Decision Center layer: it filters intent noise
 * down to true decisions, exposes fast Home summaries, and executes actions
 * only when a deterministic backend verifier can prove the expected effect.
 */

import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { getDb } from './database';
import {
  buildSkillNotificationFixtureIntent,
  createNotificationIntent,
  dismissNotificationCenterItem,
  ensureNotificationTables,
  getOrCreateNotificationProfile,
  markNotificationCenterItemRead,
  updateNotificationProfile,
  type NotificationActionButton,
  type NotificationCenterItem,
  type NotificationIntentInput,
  type NotificationIntentType,
  type NotificationPriority,
  type NotificationPrivacyPolicy,
  type NotificationSourceSkill,
} from './notification-orchestrator';
import {
  decideContentApproval,
  getContentWorkflowObject,
} from './content-editorial-workflow';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { logger } from '../utils/logger';

export type DecisionClassification = 'decision' | 'notification' | 'task' | 'insight' | 'ignore';
export type DecisionUrgency = 'urgent' | 'today' | 'this_week' | 'optional';
export type DecisionActionStatus = 'succeeded' | 'failed' | 'blocked' | 'idempotent';

export interface DecisionEligibilityPolicyInput {
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  priority: NotificationPriority;
  requiresUserAction?: boolean;
  actionButtons?: NotificationActionButton[];
  deliveryPolicy?: string | null;
}

export interface DecisionEligibilityResult {
  classification: DecisionClassification;
  reasons: string[];
  apnsEligible: boolean;
  urgency: DecisionUrgency;
}

export interface DecisionApiItem {
  decisionId: string;
  itemId: string;
  id: string;
  intentId: string;
  decisionLogId: string | null;
  userId: number;
  tenantId: number;
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  status: string;
  urgency: DecisionUrgency;
  priorityScore: number;
  title: string;
  summary: string;
  safePreviewTitle: string;
  safePreviewBody: string;
  recommendedActionLabel: string | null;
  recommendedAction: NotificationActionButton | null;
  alternativeActions: NotificationActionButton[];
  whySummary: string;
  whyDetails: Array<{ label: string; value: string }>;
  relatedEntities: Array<{ type: string; id: string }>;
  deadlineAt: string | null;
  expiresAt: string | null;
  confidence: number;
  riskLevel: 'low' | 'medium' | 'high';
  privacyClassification: NotificationPrivacyPolicy;
  visibilityScope: 'user_private' | 'tenant_shared' | 'tenant_admin' | 'system_admin';
  createdAt: string;
  updatedAt: string;
  snoozedUntil: string | null;
  actions: NotificationActionButton[];
}

export interface DecisionSummary {
  openCount: number;
  urgentCount: number;
  todayCount: number;
  topDecisionTitle: string | null;
  topDecisionSourceSkill: NotificationSourceSkill | null;
  topDecisionUrgency: DecisionUrgency | null;
  ctaLabel: string;
  previewItems: DecisionApiItem[];
  badgeCount: number;
}

export interface DecisionActionResult {
  actionId: string;
  status: DecisionActionStatus;
  idempotent: boolean;
  item: DecisionApiItem;
  verification: {
    readBackOk: boolean;
    expectedEffect: Record<string, unknown>;
    actualEffect: Record<string, unknown>;
    message: string;
  };
}

interface DecisionRecord extends NotificationCenterItem {
  relatedEntityId: string | null;
  relatedEntityType: string | null;
  requiresUserAction: boolean;
  decisionDeadline: string | null;
  privacyPolicy: NotificationPrivacyPolicy;
  deliveryPolicy: string | null;
  snoozedUntil: string | null;
  actionResult: Record<string, unknown> | null;
}

const DECISION_TYPES = new Set<NotificationIntentType>([
  'decision_required',
  'conflict_detected',
  'reflow_suggestion',
  'approval_required',
  'sync_failure',
  'security_account',
]);

const NON_DECISION_TYPES = new Set<NotificationIntentType>([
  'reminder',
  'missed_item',
  'daily_digest',
  'weekly_review',
  'insight',
]);

const MUTATING_ACTIONS = new Set([
  'approve_script',
  'request_rewrite',
  'accept_reflow',
  'choose_another_time',
  'retry',
  'option_a',
  'option_b',
  'mark_paid',
  'add_meal',
]);

export function ensureDecisionCenterTables(): void {
  ensureNotificationTables();

  const db = getDb();
  ensureColumn('notification_center_items', 'snoozed_until', 'TEXT');
  ensureColumn('notification_center_items', 'action_result_json', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_action_executions (
      action_execution_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      executor_skill TEXT NOT NULL,
      status TEXT NOT NULL,
      expected_effect_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      failed_at TEXT,
      error_code TEXT,
      UNIQUE(decision_id, action_id, user_id, tenant_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_action_scope
      ON decision_action_executions(user_id, tenant_id, decision_id, action_id);
    CREATE INDEX IF NOT EXISTS idx_notification_center_decision_home
      ON notification_center_items(user_id, tenant_id, status, priority, created_at);
  `);
}

export function evaluateDecisionEligibility(input: DecisionEligibilityPolicyInput): DecisionEligibilityResult {
  const reasons: string[] = [];
  const requiresUserAction = !!input.requiresUserAction || (input.actionButtons ?? []).some((action) => action.id !== 'open_detail');
  const urgency = urgencyForPriority(input.priority);

  if (NON_DECISION_TYPES.has(input.type) && !requiresUserAction) {
    reasons.push(`${input.type} is routine notification/insight, not a user decision`);
    return { classification: input.type === 'insight' ? 'insight' : 'notification', reasons, apnsEligible: false, urgency };
  }

  if (input.type === 'schedule_changed' && !requiresUserAction) {
    reasons.push('schedule_changed without a required choice is a notification');
    return { classification: 'notification', reasons, apnsEligible: false, urgency };
  }

  if (DECISION_TYPES.has(input.type) || requiresUserAction) {
    reasons.push('requires judgment, approval, correction, or meaningful choice');
    return {
      classification: 'decision',
      reasons,
      apnsEligible: isVisiblePushEligible(input.priority, input.type, requiresUserAction),
      urgency,
    };
  }

  reasons.push('no user action required');
  return { classification: 'ignore', reasons, apnsEligible: false, urgency };
}

export async function createDecisionIntent(input: NotificationIntentInput): Promise<{ item: DecisionApiItem | null; eligibility: DecisionEligibilityResult }> {
  assertScope(input.userId, input.tenantId ?? input.userId, 'create_decision_intent', { sourceSkill: input.sourceSkill, type: input.type });
  const eligibility = evaluateDecisionEligibility({
    sourceSkill: input.sourceSkill,
    type: input.type,
    priority: input.priority,
    requiresUserAction: input.requiresUserAction,
    actionButtons: input.actionButtons,
    deliveryPolicy: input.deliveryPolicy,
  });
  if (eligibility.classification !== 'decision') {
    return { item: null, eligibility };
  }

  const result = await createNotificationIntent({
    ...input,
    requiresUserAction: true,
    deliveryPolicy: input.deliveryPolicy ?? (eligibility.apnsEligible ? 'auto' : 'in_app_only'),
  });
  const item = result.item ? getDecisionItem(result.item.itemId, input.userId, input.tenantId ?? input.userId) : null;
  return { item, eligibility };
}

export function buildSkillDecisionFixtureIntent(
  sourceSkill: NotificationSourceSkill,
  userId: number,
  overrides: Partial<NotificationIntentInput> = {},
): NotificationIntentInput {
  const base = buildSkillNotificationFixtureIntent(sourceSkill, userId, overrides);
  if (sourceSkill === 'training') {
    return {
      ...base,
      type: 'decision_required',
      title: 'Training plan needs race date',
      body: 'Add a race date or switch to continuous training before the next plan update.',
      actionButtons: [
        { id: 'open_detail', label: 'Review', style: 'primary' },
      ],
      requiresUserAction: true,
      dedupeKey: overrides.dedupeKey ?? `training:missing-race-date:${userId}:demo`,
      ...overrides,
    };
  }
  return {
    ...base,
    requiresUserAction: overrides.requiresUserAction ?? true,
    ...overrides,
  };
}

export function listDecisionItems(
  userId: number,
  tenantId = userId,
  opts: { status?: string; sourceSkill?: NotificationSourceSkill; type?: NotificationIntentType; urgency?: DecisionUrgency; limit?: number } = {},
): DecisionApiItem[] {
  assertScope(userId, tenantId, 'list_decision_items', opts);
  ensureDecisionCenterTables();
  const clauses = ['items.user_id = ?', 'items.tenant_id = ?'];
  const params: unknown[] = [userId, tenantId];
  if (opts.status && opts.status !== 'all') {
    clauses.push('items.status = ?');
    params.push(opts.status);
  } else {
    clauses.push("items.status NOT IN ('expired')");
  }
  if (opts.sourceSkill) {
    clauses.push('items.source_skill = ?');
    params.push(opts.sourceSkill);
  }
  if (opts.type) {
    clauses.push('items.type = ?');
    params.push(opts.type);
  }
  params.push(Math.min(Math.max(opts.limit ?? 80, 1), 200));

  const rows = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY
       CASE items.priority WHEN 'critical' THEN 0 WHEN 'time_sensitive' THEN 1 WHEN 'active' THEN 2 ELSE 3 END,
       COALESCE(intents.decision_deadline, items.expires_at, items.created_at) ASC,
       items.created_at DESC
     LIMIT ?
  `).all(...params) as any[];

  return rows
    .map(mapDecisionRecord)
    .filter((item) => isDecisionRecord(item))
    .filter((item) => !isSnoozedUntilFuture(item))
    .filter((item) => !opts.urgency || urgencyForPriority(item.priority, item.decisionDeadline, item.expiresAt) === opts.urgency)
    .map(formatDecisionItemForApi);
}

export function getDecisionItem(decisionId: string, userId: number, tenantId = userId): DecisionApiItem | null {
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (!record || !isDecisionRecord(record)) return null;
  return formatDecisionItemForApi(record);
}

export function getDecisionSummary(userId: number, tenantId = userId, limit = 3): DecisionSummary {
  const items = listDecisionItems(userId, tenantId, { status: 'all', limit: 80 })
    .filter((item) => ['unread', 'read', 'snoozed', 'failed'].includes(item.status));
  const openItems = items.filter((item) => item.status !== 'snoozed' || !item.snoozedUntil);
  const urgentCount = openItems.filter((item) => item.urgency === 'urgent').length;
  const todayCount = openItems.filter((item) => item.urgency === 'urgent' || item.urgency === 'today').length;
  const top = openItems[0] ?? null;
  return {
    openCount: openItems.length,
    urgentCount,
    todayCount,
    topDecisionTitle: top?.safePreviewTitle ?? null,
    topDecisionSourceSkill: top?.sourceSkill ?? null,
    topDecisionUrgency: top?.urgency ?? null,
    ctaLabel: ctaLabelForSummary(openItems.length, urgentCount, top),
    previewItems: openItems.slice(0, Math.min(Math.max(limit, 0), 3)),
    badgeCount: todayCount,
  };
}

export async function performDecisionAction(
  decisionId: string,
  actionId: string,
  userId: number,
  tenantId = userId,
  opts: { idempotencyKey?: string; payload?: Record<string, unknown> } = {},
): Promise<DecisionActionResult> {
  assertScope(userId, tenantId, 'perform_decision_action', { decisionId, actionId });
  ensureDecisionCenterTables();
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (!record || !isDecisionRecord(record)) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found for authenticated user', 404);
  if (!record.actions.some((action) => action.id === actionId)) {
    throw new DecisionActionError('DECISION_ACTION_NOT_ALLOWED', 'That action is not available for this decision', 400);
  }
  const idempotencyKey = opts.idempotencyKey || `${decisionId}:${actionId}:${userId}:${tenantId}`;
  const existing = getExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
  if (existing && existing.status === 'succeeded') {
    const current = getDecisionItem(decisionId, userId, tenantId);
    if (!current) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after idempotent action', 404);
    return {
      actionId,
      status: 'idempotent',
      idempotent: true,
      item: current,
      verification: {
        readBackOk: true,
        expectedEffect: safeParseJson(existing.expected_effect_json, {}),
        actualEffect: safeParseJson(existing.result_json, {}),
        message: 'Duplicate action returned the original verified result.',
      },
    };
  }
  guardActionable(record);

  const action = record.actions.find((candidate) => candidate.id === actionId)!;
  const executionId = existing?.action_execution_id ?? `dae_${randomUUID()}`;
  if (!existing) {
    insertExecution(executionId, record, actionId, idempotencyKey, executorSkillForAction(actionId, record));
  }

  try {
    const execution = await executeDecisionAction(record, action, userId, tenantId, opts.payload ?? {});
    markExecutionSucceeded(executionId, execution.expectedEffect, execution.actualEffect);
    const updated = getDecisionItem(decisionId, userId, tenantId);
    if (!updated) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision missing after action execution', 500);
    return {
      actionId,
      status: 'succeeded',
      idempotent: false,
      item: updated,
      verification: {
        readBackOk: execution.readBackOk,
        expectedEffect: execution.expectedEffect,
        actualEffect: execution.actualEffect,
        message: execution.message,
      },
    };
  } catch (err) {
    const error = err instanceof DecisionActionError
      ? err
      : new DecisionActionError('DECISION_ACTION_FAILED', 'Decision action failed verification', 500);
    markExecutionFailed(executionId, error.code, error.details);
    markDecisionFailed(record, actionId, error.code);
    throw error;
  }
}

export function snoozeDecision(decisionId: string, userId: number, tenantId = userId, minutes = 60): DecisionApiItem {
  assertScope(userId, tenantId, 'snooze_decision', { decisionId });
  ensureDecisionCenterTables();
  const until = DateTime.utc().plus({ minutes: Math.min(Math.max(minutes, 5), 10_080) }).toISO();
  getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'snoozed', snoozed_until = ?, read_at = COALESCE(read_at, datetime('now'))
     WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND status IN ('unread', 'read', 'failed', 'snoozed')
  `).run(until, decisionId, userId, tenantId);
  const item = getDecisionItem(decisionId, userId, tenantId);
  if (!item) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after snooze', 404);
  return item;
}

export function dismissDecision(decisionId: string, userId: number, tenantId = userId): DecisionApiItem {
  const item = dismissNotificationCenterItem(decisionId, userId, tenantId);
  if (!item) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
  const decision = getDecisionItem(decisionId, userId, tenantId);
  if (!decision) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after dismiss', 404);
  return decision;
}

export function markDecisionViewed(decisionId: string, userId: number, tenantId = userId): DecisionApiItem {
  const item = markNotificationCenterItemRead(decisionId, userId, tenantId);
  if (!item) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
  const decision = getDecisionItem(decisionId, userId, tenantId);
  if (!decision) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after viewed', 404);
  return decision;
}

export function getDecisionPreferences(userId: number, tenantId = userId): Record<string, unknown> {
  return {
    profile: getOrCreateNotificationProfile(userId, tenantId),
    decisionPreferences: {
      homePreviewMode: 'urgent_and_today',
      autoHideResolved: true,
      askBeforeScheduleChanges: true,
      askBeforeContentPublishing: true,
      askBeforeTrainingReflow: true,
      pushEnabled: getOrCreateNotificationProfile(userId, tenantId).pushEnabled,
      urgentDecisionPushEnabled: getOrCreateNotificationProfile(userId, tenantId).allowTimeSensitive,
      timeSensitiveAllowed: getOrCreateNotificationProfile(userId, tenantId).allowTimeSensitive,
      backgroundRefreshPushEnabled: getOrCreateNotificationProfile(userId, tenantId).pushEnabled,
    },
  };
}

export function updateDecisionPreferences(userId: number, tenantId: number, patch: Record<string, unknown>): Record<string, unknown> {
  const profile = updateNotificationProfile(userId, tenantId, patch);
  return { profile };
}

export class DecisionActionError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DecisionActionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function ensureColumn(table: string, column: string, ddl: string): void {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function isDecisionRecord(item: DecisionRecord): boolean {
  const eligibility = evaluateDecisionEligibility({
    sourceSkill: item.sourceSkill,
    type: item.type,
    priority: item.priority,
    requiresUserAction: item.requiresUserAction,
    actionButtons: item.actions,
    deliveryPolicy: item.deliveryPolicy,
  });
  return eligibility.classification === 'decision';
}

function urgencyForPriority(priority: NotificationPriority, deadlineAt?: string | null, expiresAt?: string | null): DecisionUrgency {
  if (priority === 'critical' || priority === 'time_sensitive') return 'urgent';
  const deadline = deadlineAt ?? expiresAt;
  if (deadline) {
    const ms = Date.parse(deadline);
    if (Number.isFinite(ms) && ms - Date.now() <= 24 * 3_600_000) return 'today';
  }
  if (priority === 'active') return 'today';
  return 'optional';
}

function isVisiblePushEligible(priority: NotificationPriority, type: NotificationIntentType, requiresUserAction: boolean): boolean {
  if (!requiresUserAction) return false;
  if (priority === 'passive') return false;
  return type === 'conflict_detected'
    || type === 'approval_required'
    || type === 'sync_failure'
    || type === 'security_account'
    || priority === 'time_sensitive'
    || priority === 'critical';
}

function priorityScoreFor(item: DecisionRecord): number {
  const urgencyScore = item.priority === 'critical' ? 100 : item.priority === 'time_sensitive' ? 90 : item.priority === 'active' ? 70 : 35;
  const deadline = item.decisionDeadline ?? item.expiresAt;
  const deadlineBoost = deadline && Date.parse(deadline) - Date.now() <= 24 * 3_600_000 ? 10 : 0;
  return urgencyScore + deadlineBoost;
}

function formatDecisionItemForApi(item: DecisionRecord): DecisionApiItem {
  const safeTitle = safeTitleForItem(item);
  const action = recommendedAction(item.actions);
  const urgency = urgencyForPriority(item.priority, item.decisionDeadline, item.expiresAt);
  return {
    decisionId: item.itemId,
    itemId: item.itemId,
    id: item.itemId,
    intentId: item.intentId,
    decisionLogId: item.decisionLogId,
    userId: item.userId,
    tenantId: item.tenantId,
    sourceSkill: item.sourceSkill,
    type: item.type,
    status: item.status,
    urgency,
    priorityScore: priorityScoreFor(item),
    title: item.title,
    summary: item.safeBody,
    safePreviewTitle: safeTitle,
    safePreviewBody: item.safeBody,
    recommendedActionLabel: action?.label ?? null,
    recommendedAction: action,
    alternativeActions: item.actions.filter((candidate) => candidate.id !== action?.id),
    whySummary: whySummaryForItem(item),
    whyDetails: whyDetailsForItem(item),
    relatedEntities: item.relatedEntityId && item.relatedEntityType
      ? [{ type: item.relatedEntityType, id: item.relatedEntityId }]
      : [],
    deadlineAt: item.decisionDeadline,
    expiresAt: item.expiresAt,
    confidence: confidenceForItem(item),
    riskLevel: riskLevelForItem(item),
    privacyClassification: item.privacyPolicy,
    visibilityScope: visibilityScopeForItem(item),
    createdAt: item.createdAt,
    updatedAt: item.createdAt,
    snoozedUntil: item.snoozedUntil,
    actions: item.actions,
  };
}

function safeTitleForItem(item: DecisionRecord): string {
  if (item.privacyPolicy === 'financial' || item.sourceSkill === 'finance') return 'Finance decision';
  if (item.privacyPolicy === 'health' || item.sourceSkill === 'training') return item.type === 'decision_required' ? 'Training decision' : 'Training update';
  if (item.privacyPolicy === 'private_content' || item.sourceSkill === 'content') return 'Content review';
  if (item.privacyPolicy === 'sensitive') return sourceLabel(item.sourceSkill);
  return item.title;
}

function whySummaryForItem(item: DecisionRecord): string {
  switch (item.type) {
    case 'conflict_detected':
      return 'Nexus found a schedule or capacity conflict that needs your choice.';
    case 'approval_required':
      return 'This item is paused until you approve or request a change.';
    case 'reflow_suggestion':
      return 'Secretary found a safer way to fit the work into your schedule.';
    case 'sync_failure':
      return 'A provider sync could not complete and needs a retry or review.';
    case 'security_account':
      return 'Account activity requires timely review.';
    case 'decision_required':
      return 'Nexus needs your judgment before it can continue.';
    default:
      return 'This item needs a decision before Nexus acts.';
  }
}

function whyDetailsForItem(item: DecisionRecord): Array<{ label: string; value: string }> {
  const details = [
    { label: 'Source', value: sourceLabel(item.sourceSkill) },
    { label: 'Rule', value: 'Decision Center only shows items that require user judgment or approval.' },
  ];
  if (item.decisionDeadline) {
    details.push({ label: 'Deadline', value: item.decisionDeadline });
  }
  if (item.privacyPolicy !== 'public') {
    details.push({ label: 'Privacy', value: 'Home and notifications use a safe preview; details require authenticated access.' });
  }
  return details;
}

function sourceLabel(source: NotificationSourceSkill): string {
  switch (source) {
    case 'secretary': return 'Secretary';
    case 'training': return 'Training';
    case 'content': return 'Content';
    case 'cooking': return 'Cooking';
    case 'finance': return 'Finance';
    case 'chat': return 'Chat';
    case 'system': return 'System';
    case 'security': return 'Security';
  }
}

function recommendedAction(actions: NotificationActionButton[]): NotificationActionButton | null {
  return actions.find((action) => action.style === 'primary')
    ?? actions.find((action) => action.id !== 'open_detail')
    ?? actions[0]
    ?? null;
}

function confidenceForItem(item: DecisionRecord): number {
  if (item.type === 'decision_required') return 0.72;
  if (item.type === 'conflict_detected' || item.type === 'approval_required') return 0.86;
  if (item.type === 'sync_failure') return 0.8;
  return 0.75;
}

function riskLevelForItem(item: DecisionRecord): 'low' | 'medium' | 'high' {
  if (item.priority === 'critical' || item.priority === 'time_sensitive') return 'high';
  if (item.type === 'approval_required' || item.type === 'sync_failure') return 'medium';
  return 'low';
}

function visibilityScopeForItem(item: DecisionRecord): DecisionApiItem['visibilityScope'] {
  if (item.sourceSkill === 'system' || item.sourceSkill === 'security') return 'user_private';
  return 'user_private';
}

function ctaLabelForSummary(openCount: number, urgentCount: number, top: DecisionApiItem | null): string {
  if (openCount === 0) return 'All Clear';
  if (urgentCount > 0) return 'Urgent Decision';
  if (top?.type === 'conflict_detected') return 'Schedule Conflict';
  if (openCount === 1) return '1 Decision';
  return `${openCount} Decisions`;
}

function getDecisionRecord(decisionId: string, userId: number, tenantId = userId): DecisionRecord | null {
  assertScope(userId, tenantId, 'get_decision_record', { decisionId });
  ensureDecisionCenterTables();
  const row = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
     WHERE items.item_id = ? AND items.user_id = ? AND items.tenant_id = ?
     LIMIT 1
  `).get(decisionId, userId, tenantId) as any;
  return row ? mapDecisionRecord(row) : null;
}

function mapDecisionRecord(row: any): DecisionRecord {
  return {
    itemId: row.item_id,
    intentId: row.intent_id,
    decisionLogId: row.decision_log_id ?? null,
    userId: row.user_id,
    tenantId: row.tenant_id,
    title: row.title,
    body: row.body,
    safeBody: row.safe_body,
    sensitiveBody: row.sensitive_body ?? null,
    sourceSkill: row.source_skill,
    type: row.type,
    priority: row.priority,
    status: row.status,
    deeplink: row.deeplink,
    actions: safeParseJson(row.actions_json, []),
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    relatedEntityId: row.related_entity_id,
    relatedEntityType: row.related_entity_type,
    requiresUserAction: !!row.requires_user_action,
    decisionDeadline: row.decision_deadline,
    privacyPolicy: row.privacy_policy ?? 'standard',
    deliveryPolicy: row.delivery_policy,
    snoozedUntil: row.snoozed_until ?? null,
    actionResult: row.action_result_json ? safeParseJson(row.action_result_json, null) : null,
  };
}

function isSnoozedUntilFuture(item: DecisionRecord): boolean {
  if (item.status !== 'snoozed' || !item.snoozedUntil) return false;
  const untilMs = Date.parse(item.snoozedUntil);
  return Number.isFinite(untilMs) && untilMs > Date.now();
}

function guardActionable(record: DecisionRecord): void {
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
    getDb().prepare(`
      UPDATE notification_center_items SET status = 'expired'
      WHERE item_id = ? AND user_id = ? AND tenant_id = ?
    `).run(record.itemId, record.userId, record.tenantId);
    throw new DecisionActionError('DECISION_EXPIRED', 'Decision expired and can no longer be actioned', 409);
  }
  if (record.status === 'expired') throw new DecisionActionError('DECISION_EXPIRED', 'Decision expired and can no longer be actioned', 409);
  if (record.status === 'superseded') throw new DecisionActionError('DECISION_SUPERSEDED', 'Decision was superseded by newer state', 409);
  if (record.status === 'dismissed') throw new DecisionActionError('DECISION_DISMISSED', 'Decision was dismissed', 409);
  if (record.status === 'actioned') throw new DecisionActionError('DECISION_ALREADY_ACTIONED', 'Decision was already actioned', 409);
}

function getExistingExecution(decisionId: string, actionId: string, userId: number, tenantId: number, idempotencyKey: string): any | null {
  return getDb().prepare(`
    SELECT * FROM decision_action_executions
     WHERE decision_id = ? AND action_id = ? AND user_id = ? AND tenant_id = ? AND idempotency_key = ?
     LIMIT 1
  `).get(decisionId, actionId, userId, tenantId, idempotencyKey) as any ?? null;
}

function insertExecution(executionId: string, record: DecisionRecord, actionId: string, idempotencyKey: string, executorSkill: string): void {
  getDb().prepare(`
    INSERT INTO decision_action_executions (
      action_execution_id, decision_id, action_id, user_id, tenant_id, idempotency_key,
      executor_skill, status, expected_effect_json, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', '{}', '{}')
  `).run(executionId, record.itemId, actionId, record.userId, record.tenantId, idempotencyKey, executorSkill);
}

async function executeDecisionAction(
  record: DecisionRecord,
  action: NotificationActionButton,
  userId: number,
  tenantId: number,
  payload: Record<string, unknown>,
): Promise<{
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
}> {
  if (action.id === 'open_detail') {
    const item = markNotificationCenterItemRead(record.itemId, userId, tenantId);
    return verifiedStatusEffect('read', item?.status ?? null, 'Decision was marked viewed.');
  }

  if (action.id === 'dismiss' || action.id === 'reject_reflow' || action.id === 'not_now') {
    const item = dismissNotificationCenterItem(record.itemId, userId, tenantId);
    markDecisionAction(record.decisionLogId, action.id);
    return verifiedStatusEffect('dismissed', item?.status ?? null, 'Decision was declined/dismissed.');
  }

  if (action.id === 'snooze') {
    const item = snoozeDecision(record.itemId, userId, tenantId, Number(payload.minutes ?? 60));
    markDecisionAction(record.decisionLogId, action.id);
    return {
      readBackOk: item.status === 'snoozed',
      expectedEffect: { decisionStatus: 'snoozed' },
      actualEffect: { decisionStatus: item.status, snoozedUntil: item.snoozedUntil },
      message: 'Decision was snoozed.',
    };
  }

  if (action.id === 'approve_script' || action.id === 'request_rewrite') {
    return executeContentApprovalDecision(record, action.id, userId, tenantId);
  }

  if (MUTATING_ACTIONS.has(action.id)) {
    throw new DecisionActionError(
      'UNSUPPORTED_DECISION_EXECUTOR',
      'This decision action needs a deterministic executor before Nexus can run it.',
      409,
      { actionId: action.id, sourceSkill: record.sourceSkill, relatedEntityType: record.relatedEntityType },
    );
  }

  throw new DecisionActionError('UNSUPPORTED_DECISION_ACTION', 'This decision action is not supported yet.', 409, { actionId: action.id });
}

function verifiedStatusEffect(expected: string, actual: string | null, message: string): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  const readBackOk = actual === expected;
  if (!readBackOk) {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Decision action read-back verification failed', 409, {
      expectedStatus: expected,
      actualStatus: actual,
    });
  }
  return {
    readBackOk,
    expectedEffect: { decisionStatus: expected },
    actualEffect: { decisionStatus: actual },
    message,
  };
}

function executeContentApprovalDecision(
  record: DecisionRecord,
  actionId: string,
  userId: number,
  tenantId: number,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'content' || !record.relatedEntityId) {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Content approval decision is missing a content object.', 409);
  }
  const object = getContentWorkflowObject(userId, record.relatedEntityId, tenantId);
  if (!object) {
    throw new DecisionActionError('DECISION_RELATED_ENTITY_NOT_FOUND', 'Content object was not found for this user.', 404);
  }
  const decision = actionId === 'approve_script' ? 'approved' : 'rejected';
  const result = decideContentApproval({
    userId,
    tenantId,
    objectId: object.id,
    decision,
    reason: actionId === 'request_rewrite' ? 'Requested changes from Decision Center' : null,
    metadata: { source: 'decision_center', decisionId: record.itemId, actionId },
  });
  if (!result.ok || !result.object) {
    throw new DecisionActionError('DECISION_ACTION_FAILED', 'Content approval could not be applied.', 409, { status: result.status });
  }

  const verified = getContentWorkflowObject(userId, object.id, tenantId);
  const expectedApprovalState = decision;
  const readBackOk = verified?.approvalState === expectedApprovalState;
  if (!readBackOk) {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Content approval read-back verification failed', 409, {
      expectedApprovalState,
      actualApprovalState: verified?.approvalState ?? null,
    });
  }

  getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'actioned', actioned_at = datetime('now'), action_result_json = ?
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
  `).run(JSON.stringify({ contentObjectId: object.id, approvalState: verified?.approvalState }), record.itemId, userId, tenantId);
  markDecisionAction(record.decisionLogId, actionId);
  return {
    readBackOk,
    expectedEffect: { contentApprovalState: expectedApprovalState },
    actualEffect: { contentObjectId: object.id, contentApprovalState: verified?.approvalState },
    message: decision === 'approved' ? 'Content was approved.' : 'Changes were requested.',
  };
}

function markExecutionSucceeded(executionId: string, expectedEffect: Record<string, unknown>, actualEffect: Record<string, unknown>): void {
  getDb().prepare(`
    UPDATE decision_action_executions
       SET status = 'succeeded',
           expected_effect_json = ?,
           result_json = ?,
           completed_at = datetime('now')
     WHERE action_execution_id = ?
  `).run(JSON.stringify(expectedEffect), JSON.stringify(actualEffect), executionId);
}

function markExecutionFailed(executionId: string, errorCode: string, details?: Record<string, unknown>): void {
  getDb().prepare(`
    UPDATE decision_action_executions
       SET status = 'failed',
           error_code = ?,
           result_json = ?,
           failed_at = datetime('now')
     WHERE action_execution_id = ?
  `).run(errorCode, JSON.stringify(details ?? {}), executionId);
}

function markDecisionFailed(record: DecisionRecord, actionId: string, errorCode: string): void {
  getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'failed', action_result_json = ?
     WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND status IN ('unread', 'read', 'failed')
  `).run(JSON.stringify({ actionId, errorCode }), record.itemId, record.userId, record.tenantId);
  logger.warn({ decisionId: record.itemId, userId: record.userId, tenantId: record.tenantId, actionId, errorCode }, 'Decision action failed without closing decision as actioned');
}

function markDecisionAction(decisionLogId: string | null, actionId: string): void {
  if (!decisionLogId) return;
  getDb().prepare(`
    UPDATE notification_decision_logs
       SET action_taken = ?, opened_at = COALESCE(opened_at, datetime('now'))
     WHERE decision_log_id = ?
  `).run(actionId, decisionLogId);
}

function executorSkillForAction(actionId: string, record: DecisionRecord): string {
  if (actionId === 'approve_script' || actionId === 'request_rewrite') return 'content';
  if (record.type === 'conflict_detected' || actionId.includes('reflow')) return 'secretary';
  return record.sourceSkill;
}

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function assertScope(userId: number, tenantId: number, operation: string, details?: Record<string, unknown>): void {
  if (isValidTenantUserId(userId) && isValidTenantUserId(tenantId)) return;
  recordTenantScopeAnomaly({
    layer: 'orchestration',
    operation,
    reason: 'invalid_user_scope',
    userId: isValidTenantUserId(userId) ? userId : null,
    details,
  });
  throw new DecisionActionError('INVALID_SCOPE', 'Invalid user or tenant scope', 401);
}
