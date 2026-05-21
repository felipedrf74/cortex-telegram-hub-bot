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
import {
  getSecretaryAgendaItemById,
  type ReasoningTrailNode,
  type SecretaryAgendaItem,
} from './secretary-scheduling-arbitrator';
import {
  getMealPlan,
  setMealPlan,
} from './cooking-chef';
import {
  getTaxEvents,
  markTaxPaid,
} from './finance-tracker';
import {
  clearPendingChatConfirmation,
  getPendingChatConfirmation,
} from './chat-pending-confirmations';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { logger } from '../utils/logger';
import { isDecisionStreakV1Enabled } from './runtime-flags';
import {
  buildDecisionActionTruthTableEntry,
  isDecisionActionExecutable,
  type DecisionActionTruthTableEntry,
} from './decision-center-action-truth-table';
import {
  adviseSecretaryDecision,
  buildDecisionLogicV2,
  formatDecisionWindow,
  rankDecision,
  type AutomationEligibility,
  type DecisionFrontendActionState,
  type DecisionFrontendDisplayMode,
  type DecisionLogicContext,
  type DecisionLogicV2,
  type DecisionQualityGateResult,
  type SecretaryAvailableSlot,
  type DecisionVisibilityScope,
  type DecisionWhatWillChange,
  type DecisionWhy,
} from './decision-center-logic-v2';

export type DecisionClassification = 'decision' | 'notification' | 'task' | 'insight' | 'ignore';
export type DecisionUrgency = 'urgent' | 'today' | 'this_week' | 'optional';
export type DecisionActionStatus = 'succeeded' | 'failed' | 'blocked' | 'idempotent';

export const DECISION_OUTCOME_LEDGER_RETENTION_POLICY = Object.freeze({
  rawOutcomeRetentionDays: 180,
  aggregateRetentionDays: 730,
  adminReportingScope: 'aggregate_only',
  privateTextPolicy: 'never_store_raw_private_text',
});

export interface DecisionOutcomeMetrics {
  userId: number;
  tenantId: number;
  totalOutcomes: number;
  decisionQualityScore: number | null;
  decisionSpecificityScore: number | null;
  decisionActionabilityScore: number | null;
  acceptedCount: number;
  dismissedCount: number;
  snoozedCount: number;
  askedNexusCount: number;
  explanationOpenCount: number;
  genericBlockedCount: number;
  undoUsedCount: number;
  primaryActionCount: number;
  failedActionCount: number;
  partialFailureCount: number;
  autoHandledCount: number;
  averageTimeToActionMs: number | null;
  primaryActionRate: number;
  dismissRate: number;
  snoozeRate: number;
  explanationOpenRate: number;
  genericBlockedRate: number;
  failedActionRate: number;
  partialFailureRate: number;
  bySourceSkill: Record<string, number>;
}

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
  timingLabel: string | null;
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
  problemStatement: string;
  recommendation: string;
  expectedEffect: string;
  impactIfIgnored: string;
  impactLevel: 'low' | 'medium' | 'high';
  primaryActionLabel: string;
  secondaryActionLabels: string[];
  urgencyReason: string;
  why: DecisionWhy;
  actionPreview: DecisionWhatWillChange[];
  whatWillChange: DecisionWhatWillChange[];
  alternatives: DecisionAlternativeOption[];
  automationEligibility: AutomationEligibility;
  autopilotPolicy: string;
  readBackVerifier: string | null;
  handledByNexus: boolean;
  handledAt: string | null;
  outcomeSummary: string | null;
  failureReason: string | null;
  retryActions: NotificationActionButton[];
  notificationEligibility: string;
  apnsInterruptionLevel: 'passive' | 'active' | 'time-sensitive';
  collapseKey: string | null;
  badgeContribution: boolean;
  quality: DecisionQualityGateResult;
  relatedEntities: Array<{ type: string; id: string }>;
  relatedEntitiesSafe: Array<{ type: string; label: string }>;
  sourceTraceSummary: string;
  sourceTrace: DecisionSourceTrace;
  dependencyGraphSummary: string | null;
  actionTruthTableEntry: DecisionActionTruthTableEntry | null;
  askNexusContext: DecisionAskNexusContext;
  deadlineAt: string | null;
  expiresAt: string | null;
  confidence: number;
  analysis: DecisionAnalysisBundle;
  riskLevel: 'low' | 'medium' | 'high';
  groupKey: string;
  sectionKey: DecisionTimelineSectionKey;
  displayMode: DecisionFrontendDisplayMode;
  frontendActionState: DecisionFrontendActionState;
  privacyClassification: NotificationPrivacyPolicy;
  visibilityScope: 'user_private' | 'tenant_shared' | 'tenant_admin' | 'system_admin';
  createdAt: string;
  updatedAt: string;
  snoozedUntil: string | null;
  actions: NotificationActionButton[];
  dependsOnDecisionIds: string[];
  blockedByDecisionIds: string[];
  rollbackAvailable: boolean;
  rollbackActionId: string | null;
}

export interface DecisionAnalysisBundle {
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  sourceFreshness: 'live' | 'fresh' | 'stale' | 'unknown';
  freshnessLabel: string;
  whyNow: string;
  expectedOutcome: string;
  costOfDelay: string;
  tradeoffs: string[];
  uncertainty: string[];
  rollbackConfidence: 'high' | 'medium' | 'low' | 'none';
}

export type DecisionTimelineSectionKey = 'urgent' | 'today' | 'tomorrow' | 'this_week' | 'waiting_on_systems' | 'handled' | 'history';

export interface DecisionAlternativeOption {
  id: string;
  label: string;
  rank: 'best' | 'good' | 'not_recommended';
  reason: string;
  actionId: string | null;
  available: boolean;
  source: 'recipe' | 'system_default';
}

export interface DecisionSourceTrace {
  originatingSkill: NotificationSourceSkill;
  originatingSignal: NotificationIntentType;
  sourceEntityIds: string[];
  sourceTimestamp: string;
  enrichmentService: string;
  orchestrator: string;
  executor: string | null;
  verifier: string | null;
  relatedStateReadModels: string[];
  confidenceSource: string;
  dataFreshness: 'live' | 'cached' | 'unknown';
  /**
   * C2 workstream: ordered reasoning breadcrumbs from the Secretary
   * scheduling arbitrator. Only populated for `secretary_agenda_item`
   * related entities; empty for non-secretary decisions. iOS Codable
   * decoder treats this as optional.
   *
   * Privacy: nodes carry ONLY enum codes + ISO slot strings + numeric
   * weights. Never user copy. Pinned by W-E privacy test.
   */
  reasoningTrail?: ReasoningTrailNode[];
}

export interface DecisionAskNexusContext {
  decisionId: string;
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  prompt: string;
}

export interface DecisionSummary {
  openCount: number;
  urgentCount: number;
  todayCount: number;
  handledTodayCount: number;
  topDecisionTitle: string | null;
  topDecisionSourceSkill: NotificationSourceSkill | null;
  topDecisionUrgency: DecisionUrgency | null;
  topDecisionWhy: string | null;
  topSuggestion: DecisionCenterTopSuggestion | null;
  ctaLabel: string;
  previewItems: DecisionApiItem[];
  badgeCount: number;
  gamification: DecisionGamificationSummary | null;
}

export interface DecisionCenterTopSuggestion {
  decisionId: string;
  title: string;
  actionLabel: string | null;
  whyNow: string;
  expectedOutcome: string;
  riskIfIgnored: string;
  sourceSkill: NotificationSourceSkill;
  urgency: DecisionUrgency;
}

export interface DecisionCenterOverview {
  count: number;
  openCount: number;
  handledCount: number;
  staleCount: number;
  supersededCount: number;
  generatedAt: string;
  summary: DecisionSummary;
  topSuggestion: DecisionCenterTopSuggestion | null;
  partial: {
    items: boolean;
    handled: boolean;
    summary: boolean;
  };
  items: DecisionApiItem[];
  handled: HandledByNexusItem[];
}

export interface DecisionGamificationSummary {
  currentStreakDays: number;
  bestStreakDays: number;
  last14Days: Array<{
    date: string;
    cleared: boolean;
    reachedZeroAt: string | null;
  }>;
  decisionsLeft: number;
  hoursLeftToday: number;
  atRisk: boolean;
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

export interface HandledByNexusItem {
  itemId: string;
  userId: number;
  tenantId: number;
  sourceSkill: NotificationSourceSkill;
  title: string;
  summary: string;
  actionTaken: string;
  whyBrief: string;
  relatedEntities: Array<{ type: string; id: string }>;
  rollbackAvailable: boolean;
  changedRuleOption: string | null;
  createdAt: string;
  privacyClassification: NotificationPrivacyPolicy;
}

interface DecisionRecord extends NotificationCenterItem {
  relatedEntityId: string | null;
  relatedEntityType: string | null;
  decisionContext: DecisionLogicContext | null;
  requiresUserAction: boolean;
  decisionDeadline: string | null;
  privacyPolicy: NotificationPrivacyPolicy;
  deliveryPolicy: string | null;
  snoozedUntil: string | null;
  actionedAt: string | null;
  decisionLogActionTaken: string | null;
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
  'undo_reflow',
]);
const CONTENT_APPROVAL_ACTION_IDS = new Set(['approve_script', 'request_rewrite']);
const SECRETARY_REFLOW_ACTION_IDS = new Set(['accept_reflow', 'choose_another_time']);

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
    CREATE TABLE IF NOT EXISTS decision_dependencies (
      dependency_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      depends_on_decision_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      relationship TEXT NOT NULL DEFAULT 'blocks',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(decision_id, depends_on_decision_id, user_id, tenant_id, relationship)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_dependencies_scope
      ON decision_dependencies(user_id, tenant_id, decision_id, relationship);
    CREATE INDEX IF NOT EXISTS idx_decision_dependencies_blocker
      ON decision_dependencies(user_id, tenant_id, depends_on_decision_id, relationship);
    CREATE TABLE IF NOT EXISTS handled_by_nexus_items (
      handled_item_id TEXT PRIMARY KEY,
      decision_id TEXT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      action_taken TEXT NOT NULL,
      why_brief TEXT NOT NULL,
      related_entities_json TEXT NOT NULL DEFAULT '[]',
      rollback_available INTEGER NOT NULL DEFAULT 0,
      changed_rule_option TEXT,
      privacy_classification TEXT NOT NULL DEFAULT 'standard',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_handled_by_nexus_scope_created
      ON handled_by_nexus_items(user_id, tenant_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS decision_outcome_ledger (
      outcome_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      type TEXT NOT NULL,
      priority_score INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      automation_eligibility TEXT NOT NULL DEFAULT 'never',
      action_shown TEXT,
      action_taken TEXT,
      accepted INTEGER NOT NULL DEFAULT 0,
      dismissed INTEGER NOT NULL DEFAULT 0,
      snoozed INTEGER NOT NULL DEFAULT 0,
      ignored INTEGER NOT NULL DEFAULT 0,
      asked_nexus INTEGER NOT NULL DEFAULT 0,
      manually_corrected INTEGER NOT NULL DEFAULT 0,
      undo_used INTEGER NOT NULL DEFAULT 0,
      time_to_action_ms INTEGER,
      action_succeeded INTEGER NOT NULL DEFAULT 0,
      partial_failure INTEGER NOT NULL DEFAULT 0,
      failed_reason TEXT,
      feature_snapshot_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decision_outcome_scope_created
      ON decision_outcome_ledger(user_id, tenant_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS decision_quality_gate_events (
      event_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      source_skill TEXT NOT NULL,
      type TEXT NOT NULL,
      quality_status TEXT NOT NULL,
      quality_score INTEGER NOT NULL DEFAULT 0,
      missing_fields_json TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL,
      generic_blocked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decision_quality_gate_scope_created
      ON decision_quality_gate_events(user_id, tenant_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS decision_queue_daily_rollups (
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      timezone TEXT NOT NULL,
      reached_zero_at TEXT,
      final_open_count INTEGER NOT NULL DEFAULT 0,
      best_observed_open_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id, local_date)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_queue_daily_rollups_scope_date
      ON decision_queue_daily_rollups(user_id, tenant_id, local_date DESC);
  `);
}

export function evaluateDecisionEligibility(input: DecisionEligibilityPolicyInput): DecisionEligibilityResult {
  const reasons: string[] = [];
  const requiresUserAction = input.requiresUserAction === true;
  const urgency = urgencyForPriority(input.priority);

  if (NON_DECISION_TYPES.has(input.type) && !requiresUserAction) {
    reasons.push(`${input.type} is routine notification/insight, not a user decision`);
    if ((input.actionButtons ?? []).some((action) => action.id !== 'open_detail')) {
      reasons.push('notification action buttons do not imply a user decision without explicit requiresUserAction');
    }
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

  const quality = decisionLogicForIntentInput(input).quality;
  if (!quality.safeToShowUser) {
    recordDecisionQualityGateEvent(input, quality);
    return {
      item: null,
      eligibility: {
        ...eligibility,
        reasons: [...eligibility.reasons, `quality_gate:${quality.status}:${quality.missingFields.join(',')}`],
        apnsEligible: false,
      },
    };
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
  } else if (opts.status === 'all') {
    clauses.push("items.status NOT IN ('expired')");
  } else {
    clauses.push("items.status IN ('unread', 'read', 'failed', 'snoozed')");
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
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json
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
    .filter((item) => !supersedeIfSourceStateStale(item))
    .filter((item) => decisionLogicForRecord(item).quality.safeToShowUser)
    .filter((item) => !isSnoozedUntilFuture(item))
    .filter((item) => !opts.urgency || urgencyForPriority(item.priority, item.decisionDeadline, item.expiresAt) === opts.urgency)
    .map(formatDecisionItemForApi);
}

export function getDecisionItem(decisionId: string, userId: number, tenantId = userId): DecisionApiItem | null {
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (!record || !isDecisionRecord(record)) return null;
  if (supersedeIfSourceStateStale(record)) {
    const refreshed = getDecisionRecord(decisionId, userId, tenantId);
    return refreshed ? formatDecisionItemForApi(refreshed) : null;
  }
  return formatDecisionItemForApi(record);
}

export function findDecisionByRelatedEntity(
  userId: number,
  tenantId: number,
  relatedEntityType: string,
  relatedEntityId: string,
): DecisionApiItem | null {
  assertScope(userId, tenantId, 'find_decision_by_related_entity', { relatedEntityType, relatedEntityId });
  ensureDecisionCenterTables();
  const row = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
     WHERE items.user_id = ?
       AND items.tenant_id = ?
       AND intents.related_entity_type = ?
       AND intents.related_entity_id = ?
       AND items.status IN ('unread', 'read', 'failed', 'snoozed')
     ORDER BY items.created_at DESC
     LIMIT 1
  `).get(userId, tenantId, relatedEntityType, relatedEntityId) as any;
  if (!row) return null;
  const record = mapDecisionRecord(row);
  return isDecisionRecord(record) ? formatDecisionItemForApi(record) : null;
}

export function getDecisionSummary(userId: number, tenantId = userId, limit = 3): DecisionSummary {
  const items = listDecisionItems(userId, tenantId, { status: 'all', limit: 80 });
  const handled = listHandledByNexusItems(userId, tenantId, 25);
  return buildDecisionSummaryFromSections(userId, tenantId, items, handled, limit);
}

function buildDecisionSummaryFromSections(
  userId: number,
  tenantId: number,
  items: DecisionApiItem[],
  handled: HandledByNexusItem[],
  limit = 3,
): DecisionSummary {
  const activeItems = items.filter((item) => ['unread', 'read', 'snoozed', 'failed', 'open'].includes(item.status));
  const openItems = activeItems.filter((item) => item.status !== 'snoozed' || !item.snoozedUntil);
  const urgentCount = openItems.filter((item) => item.urgency === 'urgent').length;
  const todayCount = openItems.filter((item) => item.urgency === 'urgent' || item.urgency === 'today').length;
  const top = openItems[0] ?? null;
  const locale = userDecisionContextDefaults(userId).locale;
  const timezone = userDecisionContextDefaults(userId).timezone ?? 'UTC';
  const handledTodayCount = handled
    .filter((item) => isTimestampInLocalDay(item.createdAt, timezone, DateTime.utc()))
    .length;
  const gamification = isDecisionStreakV1Enabled(process.env, { userId, tenantId })
    ? updateAndReadDecisionGamification(userId, tenantId, openItems.length)
    : null;
  return {
    openCount: openItems.length,
    urgentCount,
    todayCount,
    handledTodayCount,
    topDecisionTitle: top?.safePreviewTitle ?? null,
    topDecisionSourceSkill: top?.sourceSkill ?? null,
    topDecisionUrgency: top?.urgency ?? null,
    topDecisionWhy: top?.whySummary ?? top?.analysis?.whyNow ?? null,
    topSuggestion: top ? topSuggestionForItem(top) : null,
    ctaLabel: ctaLabelForSummary(openItems.length, urgentCount, top, locale),
    previewItems: openItems.slice(0, Math.min(Math.max(limit, 0), 3)),
    badgeCount: todayCount,
    gamification,
  };
}

function emptyDecisionSummary(userId: number): DecisionSummary {
  const locale = userDecisionContextDefaults(userId).locale;
  return {
    openCount: 0,
    urgentCount: 0,
    todayCount: 0,
    handledTodayCount: 0,
    topDecisionTitle: null,
    topDecisionSourceSkill: null,
    topDecisionUrgency: null,
    topDecisionWhy: null,
    topSuggestion: null,
    ctaLabel: ctaLabelForSummary(0, 0, null, locale),
    previewItems: [],
    badgeCount: 0,
    gamification: null,
  };
}

function shouldRethrowDecisionOverviewError(err: unknown): boolean {
  return err instanceof DecisionActionError;
}

function logDecisionOverviewSectionFailure(section: 'items' | 'handled' | 'summary', err: unknown, userId: number, tenantId: number): void {
  logger.warn({ err, userId, tenantId, section }, 'Decision Center overview section failed');
}

function openDecisionItemsForOverview(items: DecisionApiItem[]): DecisionApiItem[] {
  return items.filter((item) => ['unread', 'read', 'snoozed', 'failed', 'open'].includes(item.status));
}

export function getDecisionOverview(
  userId: number,
  tenantId = userId,
  opts: { limit?: number; handledLimit?: number } = {},
): DecisionCenterOverview {
  const limit = Math.min(Math.max(opts.limit ?? 80, 0), 100);
  const handledLimit = Math.min(Math.max(opts.handledLimit ?? 10, 0), 25);
  const itemReadLimit = Math.max(limit, 80);
  const handledReadLimit = Math.max(handledLimit, 25);
  let allItems: DecisionApiItem[] = [];
  let handledForSummary: HandledByNexusItem[] = [];
  let itemsAvailable = true;
  let handledAvailable = true;
  let summaryAvailable = true;

  try {
    allItems = listDecisionItems(userId, tenantId, { status: 'all', limit: itemReadLimit });
  } catch (err) {
    if (shouldRethrowDecisionOverviewError(err)) throw err;
    itemsAvailable = false;
    summaryAvailable = false;
    logDecisionOverviewSectionFailure('items', err, userId, tenantId);
  }

  try {
    handledForSummary = listHandledByNexusItems(userId, tenantId, handledReadLimit);
  } catch (err) {
    if (shouldRethrowDecisionOverviewError(err)) throw err;
    handledAvailable = false;
    summaryAvailable = false;
    logDecisionOverviewSectionFailure('handled', err, userId, tenantId);
  }

  const allOpenItems = openDecisionItemsForOverview(allItems);
  const items = itemsAvailable ? allOpenItems.slice(0, limit) : [];
  const handled = handledAvailable ? handledForSummary.slice(0, handledLimit) : [];
  let summary = emptyDecisionSummary(userId);
  if (summaryAvailable) {
    try {
      summary = buildDecisionSummaryFromSections(userId, tenantId, allItems, handledForSummary, 3);
    } catch (err) {
      if (shouldRethrowDecisionOverviewError(err)) throw err;
      summaryAvailable = false;
      logDecisionOverviewSectionFailure('summary', err, userId, tenantId);
    }
  }
  const staleCount = allOpenItems.filter((item) => item.analysis.sourceFreshness === 'stale' || item.sourceTrace?.dataFreshness === 'cached').length;
  const supersededCount = allItems.filter((item) => ['superseded', 'dismissed', 'actioned'].includes(item.status)).length;
  const topSuggestion = summary.topSuggestion ?? (allOpenItems[0] ? topSuggestionForItem(allOpenItems[0]) : null);
  return {
    count: items.length,
    openCount: allOpenItems.filter((item) => ['unread', 'read', 'failed', 'open'].includes(item.status)).length,
    handledCount: handled.length,
    staleCount,
    supersededCount,
    generatedAt: DateTime.utc().toISO()!,
    summary,
    topSuggestion,
    partial: {
      items: itemsAvailable,
      handled: handledAvailable,
      summary: summaryAvailable,
    },
    items,
    handled,
  };
}

export function buildDecisionCenterReportDocument(userId: number, tenantId = userId): Record<string, unknown> {
  const overview = getDecisionOverview(userId, tenantId, { limit: 20, handledLimit: 10 });
  return {
    type: 'decision_briefing',
    generatedAt: overview.generatedAt,
    summary: {
      openCount: overview.openCount,
      urgentCount: overview.summary.urgentCount,
      handledCount: overview.handledCount,
      staleCount: overview.staleCount,
      supersededCount: overview.supersededCount,
      ctaLabel: overview.summary.ctaLabel,
    },
    topSuggestion: overview.topSuggestion,
    openDecisions: overview.items.slice(0, 8).map((item) => ({
      decisionId: item.decisionId,
      title: item.safePreviewTitle || item.title,
      whyNow: item.analysis.whyNow,
      expectedOutcome: item.analysis.expectedOutcome,
      costOfDelay: item.analysis.costOfDelay,
      confidenceLabel: item.analysis.confidenceLabel,
      sourceFreshness: item.analysis.sourceFreshness,
      actionLabel: item.recommendedActionLabel,
      urgency: item.urgency,
      sourceSkill: item.sourceSkill,
    })),
    handledByNexus: overview.handled.slice(0, 8).map((item) => ({
      itemId: item.itemId,
      title: item.title,
      summary: item.summary,
      actionTaken: item.actionTaken,
      whyBrief: item.whyBrief,
      rollbackAvailable: item.rollbackAvailable,
    })),
    unresolvedRisk: overview.topSuggestion?.riskIfIgnored ?? null,
  };
}

export function countOpenUrgentDecisionsForUser(userId: number, tenantId = userId): number {
  return getDecisionSummary(userId, tenantId).badgeCount;
}

function updateAndReadDecisionGamification(userId: number, tenantId: number, openCount: number): DecisionGamificationSummary {
  ensureDecisionCenterTables();
  const defaults = userDecisionContextDefaults(userId);
  const timezone = defaults.timezone || 'UTC';
  const now = DateTime.now().setZone(timezone);
  const today = now.toISODate()!;
  const reachedZeroAt = openCount === 0 ? now.toUTC().toISO()! : null;
  getDb().prepare(`
    INSERT INTO decision_queue_daily_rollups (
      user_id, tenant_id, local_date, timezone, reached_zero_at,
      final_open_count, best_observed_open_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(user_id, tenant_id, local_date) DO UPDATE SET
      timezone = excluded.timezone,
      reached_zero_at = COALESCE(decision_queue_daily_rollups.reached_zero_at, excluded.reached_zero_at),
      final_open_count = excluded.final_open_count,
      best_observed_open_count = MIN(decision_queue_daily_rollups.best_observed_open_count, excluded.best_observed_open_count),
      updated_at = datetime('now')
  `).run(userId, tenantId, today, timezone, reachedZeroAt, openCount, openCount);

  const since = now.minus({ days: 13 }).toISODate()!;
  const rows = getDb().prepare(`
    SELECT local_date, reached_zero_at
      FROM decision_queue_daily_rollups
     WHERE user_id = ? AND tenant_id = ? AND local_date >= ?
     ORDER BY local_date ASC
  `).all(userId, tenantId, since) as Array<{ local_date: string; reached_zero_at: string | null }>;
  const rowByDate = new Map(rows.map((row) => [row.local_date, row]));
  const last14Days = Array.from({ length: 14 }, (_, idx) => {
    const date = now.minus({ days: 13 - idx }).toISODate()!;
    const row = rowByDate.get(date);
    return {
      date,
      cleared: !!row?.reached_zero_at,
      reachedZeroAt: row?.reached_zero_at ?? null,
    };
  });
  const allRows = getDb().prepare(`
    SELECT local_date, reached_zero_at
      FROM decision_queue_daily_rollups
     WHERE user_id = ? AND tenant_id = ?
     ORDER BY local_date ASC
  `).all(userId, tenantId) as Array<{ local_date: string; reached_zero_at: string | null }>;
  const clearedByDate = new Map<string, boolean>();
  for (const row of allRows) {
    clearedByDate.set(row.local_date, !!row.reached_zero_at);
  }
  // Phase 17 hostile-QA fix (2026-05-18): walk back over the full clearedByDate
  // index, not a fixed 14-day window. The previous code silently capped
  // currentStreakDays at 14 because last14Days has exactly 14 entries —
  // a user with a 30-day clear streak saw 14 forever. Cap at 365 days as
  // a safety bound; a streak longer than a year would re-engage the cap
  // intentionally.
  let currentStreakDays = 0;
  for (let i = 0; i < 365; i += 1) {
    const date = now.minus({ days: i }).toISODate();
    if (date && clearedByDate.get(date) === true) {
      currentStreakDays += 1;
    } else {
      break;
    }
  }
  // Phase 17 hostile-QA fix (2026-05-18): treat missing rollup rows as
  // streak breaks. The previous loop iterated only existing rows, so a
  // user who skipped the app for a week then cleared decisions appeared
  // to have a contiguous streak across the gap. Walk a contiguous date
  // range from the earliest row through today.
  let bestStreakDays = 0;
  if (allRows.length > 0) {
    const startDate = DateTime.fromISO(allRows[0].local_date, { zone: timezone }).startOf('day');
    const endDate = now.startOf('day');
    let cursor = startDate;
    let running = 0;
    while (cursor <= endDate) {
      const dateKey = cursor.toISODate()!;
      if (clearedByDate.get(dateKey) === true) {
        running += 1;
        if (running > bestStreakDays) bestStreakDays = running;
      } else {
        running = 0;
      }
      cursor = cursor.plus({ days: 1 });
    }
  }
  const hoursLeftToday = Math.max(0, Math.round(now.endOf('day').diff(now, 'hours').hours * 10) / 10);
  return {
    currentStreakDays,
    bestStreakDays,
    last14Days,
    decisionsLeft: openCount,
    hoursLeftToday,
    atRisk: openCount > 0 && hoursLeftToday <= 4,
  };
}

export function listHandledByNexusItems(userId: number, tenantId = userId, limit = 25): HandledByNexusItem[] {
  assertScope(userId, tenantId, 'list_handled_by_nexus_items', { limit });
  ensureDecisionCenterTables();
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const explicitRows = getDb().prepare(`
    SELECT *
      FROM handled_by_nexus_items
     WHERE user_id = ?
       AND tenant_id = ?
     ORDER BY created_at DESC
     LIMIT ?
  `).all(userId, tenantId, boundedLimit) as any[];
  const explicitDecisionIds = new Set(
    explicitRows
      .map((row) => typeof row.decision_id === 'string' ? row.decision_id : null)
      .filter((value): value is string => !!value),
  );
  const explicitItems = explicitRows.map(mapHandledByNexusItem);

  const actionedRows = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json,
           logs.action_taken AS decision_log_action_taken
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
      LEFT JOIN notification_decision_logs logs ON logs.decision_log_id = items.decision_log_id
     WHERE items.user_id = ?
       AND items.tenant_id = ?
       AND items.status = 'actioned'
     ORDER BY COALESCE(items.actioned_at, items.created_at) DESC
     LIMIT ?
  `).all(userId, tenantId, boundedLimit) as any[];
  const actionedItems = actionedRows
    .map(mapDecisionRecord)
    .filter((record) => !explicitDecisionIds.has(record.itemId))
    .map(mapActionedDecisionToHandledItem);

  return [...explicitItems, ...actionedItems]
    .sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt))
    .slice(0, boundedLimit);
}

export function addDecisionDependency(input: {
  decisionId: string;
  dependsOnDecisionId: string;
  userId: number;
  tenantId?: number;
  relationship?: 'blocks' | 'supersedes' | 'caused_by' | 'related';
}): void {
  const tenantId = input.tenantId ?? input.userId;
  assertScope(input.userId, tenantId, 'add_decision_dependency', {
    decisionId: input.decisionId,
    dependsOnDecisionId: input.dependsOnDecisionId,
  });
  ensureDecisionCenterTables();
  const current = getDecisionRecord(input.decisionId, input.userId, tenantId);
  const blocker = getDecisionRecord(input.dependsOnDecisionId, input.userId, tenantId);
  if (!current || !blocker) {
    throw new DecisionActionError('DECISION_NOT_FOUND', 'Dependency decisions must both belong to the authenticated scope', 404);
  }
  getDb().prepare(`
    INSERT OR IGNORE INTO decision_dependencies (
      dependency_id, decision_id, depends_on_decision_id, user_id, tenant_id, relationship
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    `dep_${randomUUID()}`,
    input.decisionId,
    input.dependsOnDecisionId,
    input.userId,
    tenantId,
    input.relationship ?? 'blocks',
  );
}

export function listDecisionDependencies(decisionId: string, userId: number, tenantId = userId): Array<{
  decisionId: string;
  dependsOnDecisionId: string;
  relationship: string;
  blockerStatus: string | null;
}> {
  assertScope(userId, tenantId, 'list_decision_dependencies', { decisionId });
  ensureDecisionCenterTables();
  const rows = getDb().prepare(`
    SELECT deps.decision_id,
           deps.depends_on_decision_id,
           deps.relationship,
           blocker.status AS blocker_status
      FROM decision_dependencies deps
      LEFT JOIN notification_center_items blocker
        ON blocker.item_id = deps.depends_on_decision_id
       AND blocker.user_id = deps.user_id
       AND blocker.tenant_id = deps.tenant_id
     WHERE deps.decision_id = ?
       AND deps.user_id = ?
       AND deps.tenant_id = ?
     ORDER BY deps.created_at ASC
  `).all(decisionId, userId, tenantId) as Array<{
    decision_id: string;
    depends_on_decision_id: string;
    relationship: string;
    blocker_status: string | null;
  }>;
  return rows.map((row) => ({
    decisionId: row.decision_id,
    dependsOnDecisionId: row.depends_on_decision_id,
    relationship: row.relationship,
    blockerStatus: row.blocker_status,
  }));
}

export function runDecisionSourceStateSupersessionJob(opts: { userId?: number; tenantId?: number } = {}): {
  scannedCount: number;
  supersededCount: number;
  reasons: Record<string, number>;
} {
  ensureDecisionCenterTables();
  const clauses = ["items.status IN ('unread', 'read', 'failed', 'snoozed')"];
  const params: unknown[] = [];
  if (opts.userId != null) {
    clauses.push('items.user_id = ?');
    params.push(opts.userId);
  }
  if (opts.tenantId != null) {
    clauses.push('items.tenant_id = ?');
    params.push(opts.tenantId);
  }
  const rows = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
     WHERE ${clauses.join(' AND ')}
  `).all(...params) as any[];

  const reasons: Record<string, number> = {};
  let supersededCount = 0;
  for (const row of rows) {
    const record = mapDecisionRecord(row);
    const reason = sourceStateSupersessionReason(record);
    if (!reason) continue;
    supersedeDecision(record, reason);
    supersededCount += 1;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }

  if (supersededCount > 0) {
    logger.info({ supersededCount, reasons }, 'Decision Center source-state supersession job closed stale decisions');
  }
  return { scannedCount: rows.length, supersededCount, reasons };
}

export function getDecisionOutcomeMetrics(userId: number, tenantId = userId): DecisionOutcomeMetrics {
  assertScope(userId, tenantId, 'get_decision_outcome_metrics');
  ensureDecisionCenterTables();
  const outcomeRows = getDb().prepare(`
    SELECT
      source_skill AS sourceSkill,
      confidence,
      automation_eligibility AS automationEligibility,
      action_shown AS actionShown,
      action_taken AS actionTaken,
      accepted,
      dismissed,
      snoozed,
      asked_nexus AS askedNexus,
      undo_used AS undoUsed,
      time_to_action_ms AS timeToActionMs,
      action_succeeded AS actionSucceeded,
      partial_failure AS partialFailure,
      feature_snapshot_json AS featureSnapshotJson
    FROM decision_outcome_ledger
    WHERE user_id = ? AND tenant_id = ?
  `).all(userId, tenantId) as Array<{
    sourceSkill: string;
    confidence: number;
    automationEligibility: string;
    actionShown: string | null;
    actionTaken: string | null;
    accepted: number;
    dismissed: number;
    snoozed: number;
    askedNexus: number;
    undoUsed: number;
    timeToActionMs: number | null;
    actionSucceeded: number;
    partialFailure: number;
    featureSnapshotJson: string;
  }>;
  const gateTotals = getDb().prepare(`
    SELECT
      COUNT(*) AS totalQualityGateEvents,
      COALESCE(SUM(generic_blocked), 0) AS genericBlockedCount
    FROM decision_quality_gate_events
    WHERE user_id = ? AND tenant_id = ?
  `).get(userId, tenantId) as { totalQualityGateEvents: number; genericBlockedCount: number };
  const bySourceRows = getDb().prepare(`
    SELECT source_skill AS sourceSkill, COUNT(*) AS count
    FROM decision_outcome_ledger
    WHERE user_id = ? AND tenant_id = ?
    GROUP BY source_skill
  `).all(userId, tenantId) as Array<{ sourceSkill: string; count: number }>;
  const totalOutcomes = outcomeRows.length;
  const acceptedCount = outcomeRows.filter((row) => !!row.accepted).length;
  const dismissedCount = outcomeRows.filter((row) => !!row.dismissed).length;
  const snoozedCount = outcomeRows.filter((row) => !!row.snoozed).length;
  const askedNexusCount = outcomeRows.filter((row) => !!row.askedNexus).length;
  const undoUsedCount = outcomeRows.filter((row) => !!row.undoUsed).length;
  const primaryActionCount = outcomeRows.filter((row) => !!row.actionTaken).length;
  const failedActionCount = outcomeRows.filter((row) => row.actionSucceeded === 0 && !!row.actionTaken).length;
  const partialFailureCount = outcomeRows.filter((row) => !!row.partialFailure).length;
  const autoHandledCount = outcomeRows.filter((row) => row.actionTaken === 'superseded' || row.actionTaken === 'auto_dismiss_stale_decision').length;
  const timeToActionValues = outcomeRows
    .map((row) => row.timeToActionMs)
    .filter((value): value is number => typeof value === 'number');
  const average = (values: number[]): number | null => {
    if (values.length === 0) return null;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  };
  const qualityScores = outcomeRows
    .map((row) => Number((safeParseJson(row.featureSnapshotJson, {}) as Record<string, unknown>).qualityScore))
    .filter((value) => Number.isFinite(value));
  const specificityScores = outcomeRows.map((row) => {
    const snapshot = safeParseJson(row.featureSnapshotJson, {}) as Record<string, unknown>;
    let score = 20;
    if (typeof snapshot.sourceSkill === 'string') score += 20;
    if (typeof snapshot.decisionType === 'string') score += 20;
    if (typeof snapshot.riskLevel === 'string') score += 15;
    if (typeof snapshot.deadlineDistance === 'string' && snapshot.deadlineDistance !== 'none') score += 15;
    if (Number(snapshot.relatedEntitiesCount ?? 0) > 0) score += 10;
    return Math.min(score, 100);
  });
  const actionabilityScores = outcomeRows.map((row) => {
    let score = row.actionShown ? 65 : 25;
    if (row.actionTaken) score += 20;
    if (row.automationEligibility && row.automationEligibility !== 'never') score += 10;
    if (row.actionSucceeded === 1 || row.partialFailure === 1) score += 5;
    return Math.min(score, 100);
  });
  const rate = (count: number): number => totalOutcomes > 0 ? Number((count / totalOutcomes).toFixed(4)) : 0;
  const bySourceSkill: Record<string, number> = {};
  for (const row of bySourceRows) {
    bySourceSkill[row.sourceSkill] = Number(row.count ?? 0);
  }
  const totalDecisionQualityAttempts = totalOutcomes + Number(gateTotals.totalQualityGateEvents ?? 0);
  const genericBlockedCount = Number(gateTotals.genericBlockedCount ?? 0);
  return {
    userId,
    tenantId,
    totalOutcomes,
    decisionQualityScore: average(qualityScores),
    decisionSpecificityScore: average(specificityScores),
    decisionActionabilityScore: average(actionabilityScores),
    acceptedCount,
    dismissedCount,
    snoozedCount,
    askedNexusCount,
    explanationOpenCount: askedNexusCount,
    genericBlockedCount,
    undoUsedCount,
    primaryActionCount,
    failedActionCount,
    partialFailureCount,
    autoHandledCount,
    averageTimeToActionMs: average(timeToActionValues),
    primaryActionRate: rate(primaryActionCount),
    dismissRate: rate(dismissedCount),
    snoozeRate: rate(snoozedCount),
    explanationOpenRate: rate(askedNexusCount),
    genericBlockedRate: totalDecisionQualityAttempts > 0 ? Number((genericBlockedCount / totalDecisionQualityAttempts).toFixed(4)) : 0,
    failedActionRate: rate(failedActionCount),
    partialFailureRate: rate(partialFailureCount),
    bySourceSkill,
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
  const supersededReason = supersedeIfSourceStateStale(record);
  if (supersededReason) {
    throw new DecisionActionError(
      'DECISION_SUPERSEDED',
      'Decision was superseded because the source item is no longer actionable.',
      409,
      { reason: supersededReason },
    );
  }
  const availableActions = actionsForRecord(record);
  if (!availableActions.some((action) => action.id === actionId)) {
    throw new DecisionActionError('DECISION_ACTION_NOT_ALLOWED', 'That action is not available for this decision', 400);
  }
  const idempotencyKey = opts.idempotencyKey?.trim();
  if (!idempotencyKey) {
    throw new DecisionActionError('IDEMPOTENCY_KEY_REQUIRED', 'Decision actions require an idempotency key', 400);
  }
  const existing = getExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
  if (existing && existing.status === 'succeeded') {
    return idempotentActionResult(decisionId, actionId, userId, tenantId, existing);
  }
  if (existing && existing.status === 'started') {
    return waitForExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
  }
  if (existing && existing.status === 'failed') {
    throw new DecisionActionError(existing.error_code || 'DECISION_ACTION_FAILED', 'Prior decision action attempt failed', 409, safeParseJson(existing.result_json, {}));
  }
  guardActionable(record, actionId);
  guardDecisionDependencies(record, actionId);

  const action = availableActions.find((candidate) => candidate.id === actionId)!;
  const claimed = claimExecution(record, actionId, idempotencyKey, executorSkillForAction(actionId, record));
  if (!claimed.isNew) {
    if (claimed.execution.status === 'succeeded') {
      return idempotentActionResult(decisionId, actionId, userId, tenantId, claimed.execution);
    }
    if (claimed.execution.status === 'started') {
      return waitForExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
    }
    throw new DecisionActionError(claimed.execution.error_code || 'DECISION_ACTION_FAILED', 'Prior decision action attempt failed', 409, safeParseJson(claimed.execution.result_json, {}));
  }

  try {
    const execution = await executeDecisionAction(record, action, userId, tenantId, opts.payload ?? {});
    markExecutionSucceeded(claimed.execution.action_execution_id, execution.expectedEffect, execution.actualEffect);
    const updated = getDecisionItem(decisionId, userId, tenantId);
    if (!updated) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision missing after action execution', 500);
    recordVerifiedDecisionAction(record, action, actionId, execution);
    recordDecisionOutcome(record, {
      actionShown: action.id,
      actionTaken: actionId,
      accepted: action.style === 'primary',
      actionSucceeded: true,
      timeToActionMs: timeToActionMs(record),
    });
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
      : new DecisionActionError('DECISION_ACTION_FAILED', 'Decision action failed verification', 500, {
          originalCode: err && typeof err === 'object' && 'code' in err ? String((err as any).code) : 'UNKNOWN',
          originalErrorLogged: true,
        });
    logger.error(
      { err, decisionId, actionId, userId, tenantId },
      'Decision action failed',
    );
    markExecutionFailed(claimed.execution.action_execution_id, error.code, error.details);
    markDecisionFailed(record, actionId, error.code);
    recordDecisionOutcome(record, {
      actionShown: actionId,
      actionTaken: actionId,
      actionSucceeded: false,
      failedReason: error.code,
      partialFailure: error.code === 'DECISION_READBACK_MISMATCH',
      timeToActionMs: timeToActionMs(record),
    });
    throw error;
  }
}

export function snoozeDecision(decisionId: string, userId: number, tenantId = userId, minutes = 60): DecisionApiItem {
  assertScope(userId, tenantId, 'snooze_decision', { decisionId });
  ensureDecisionCenterTables();
  const until = DateTime.utc().plus({ minutes: Math.min(Math.max(minutes, 5), 10_080) }).toISO();
  const update = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'snoozed', snoozed_until = ?, read_at = COALESCE(read_at, datetime('now'))
     WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND status IN ('unread', 'read', 'failed', 'snoozed')
  `).run(until, decisionId, userId, tenantId);
  assertDecisionScopedUpdateApplied(update, 'snooze_decision', { decisionId, userId, tenantId });
  const item = getDecisionItem(decisionId, userId, tenantId);
  if (!item) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after snooze', 404);
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (record) {
    recordDecisionOutcome(record, {
      actionShown: 'snooze',
      actionTaken: 'snooze',
      snoozed: true,
      actionSucceeded: true,
      timeToActionMs: timeToActionMs(record),
    });
  }
  return item;
}

export function dismissDecision(decisionId: string, userId: number, tenantId = userId): DecisionApiItem {
  const item = dismissNotificationCenterItem(decisionId, userId, tenantId);
  if (!item) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
  const decision = getDecisionItem(decisionId, userId, tenantId);
  if (!decision) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after dismiss', 404);
  const record = getDecisionRecord(decisionId, userId, tenantId);
  if (record) {
    recordDecisionOutcome(record, {
      actionShown: 'dismiss',
      actionTaken: 'dismiss',
      dismissed: true,
      actionSucceeded: true,
      timeToActionMs: timeToActionMs(record),
    });
  }
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

function assertDecisionScopedUpdateApplied(
  result: { changes: number },
  operation: string,
  details: Record<string, unknown>,
): void {
  if (result.changes > 0) return;
  throw new DecisionActionError(
    'DECISION_READBACK_MISMATCH',
    'Decision scoped update did not affect any rows',
    409,
    { operation, ...details },
  );
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
  const logic = decisionLogicForRecord(item);
  const ranked = rankDecision(decisionLogicInputForRecord(item), logic, logic.quality);
  if (ranked.priorityScore > 0) return ranked.priorityScore;
  const urgencyScore = item.priority === 'critical' ? 100 : item.priority === 'time_sensitive' ? 90 : item.priority === 'active' ? 70 : 35;
  const deadline = item.decisionDeadline ?? item.expiresAt;
  const deadlineBoost = deadline && Date.parse(deadline) - Date.now() <= 24 * 3_600_000 ? 10 : 0;
  return urgencyScore + deadlineBoost;
}

function formatDecisionItemForApi(item: DecisionRecord): DecisionApiItem {
  const logic = decisionLogicForRecord(item);
  const safeTitle = logic.safePreviewTitle || safeTitleForItem(item);
  const actions = actionsForRecord(item);
  const dependencies = dependencyStateForRecord(item);
  const action = recommendedAction(actions);
  const urgency = urgencyForPriority(item.priority, item.decisionDeadline, item.expiresAt);
  const outcome = outcomeSummaryForRecord(item, logic);
  const riskLevel = riskLevelForItem(item);
  const sectionKey = sectionKeyForRecord(item, urgency, logic);
  const rollback = rollbackContractForRecord(item);
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
    timingLabel: timingLabelForRecord(item, urgency),
    priorityScore: priorityScoreFor(item),
    title: logic.title,
    summary: logic.problemStatement,
    safePreviewTitle: safeTitle,
    safePreviewBody: logic.safePreviewBody || item.safeBody,
    recommendedActionLabel: logic.primaryActionLabel || (action?.label ?? null),
    recommendedAction: action,
    alternativeActions: actions.filter((candidate) => candidate.id !== action?.id),
    whySummary: logic.whySummary,
    whyDetails: whyDetailsForItem(item, logic),
    problemStatement: logic.problemStatement,
    recommendation: logic.recommendation,
    expectedEffect: logic.expectedEffect,
    impactIfIgnored: logic.impactIfIgnored,
    impactLevel: riskLevel,
    primaryActionLabel: logic.primaryActionLabel,
    secondaryActionLabels: logic.secondaryActionLabels,
    urgencyReason: logic.urgencyReason,
    why: logic.why,
    actionPreview: logic.whatWillChange,
    whatWillChange: logic.whatWillChange,
    alternatives: alternativesForRecord(item, logic, actions),
    automationEligibility: logic.automationEligibility,
    autopilotPolicy: logic.autopilotPolicy,
    readBackVerifier: logic.readBackVerifier,
    handledByNexus: false,
    handledAt: null,
    outcomeSummary: outcome.outcomeSummary,
    failureReason: outcome.failureReason,
    retryActions: outcome.retryActions,
    notificationEligibility: logic.notificationEligibility,
    apnsInterruptionLevel: logic.apnsInterruptionLevel,
    collapseKey: logic.collapseKey,
    badgeContribution: logic.badgeContribution,
    quality: logic.quality,
    relatedEntities: item.relatedEntityId && item.relatedEntityType
      ? [{ type: item.relatedEntityType, id: item.relatedEntityId }]
      : [],
    relatedEntitiesSafe: relatedEntitiesSafeForRecord(item, logic),
    sourceTraceSummary: sourceTraceSummaryForRecord(item, logic),
    sourceTrace: sourceTraceForRecord(item, logic),
    dependencyGraphSummary: dependencyGraphSummaryForRecord(dependencies, userDecisionContextDefaults(item.userId).locale),
    actionTruthTableEntry: action ? actionTruthTableEntryForRecord(item, action, logic, rollback) : null,
    askNexusContext: askNexusContextForRecord(item, logic),
    deadlineAt: item.decisionDeadline,
    expiresAt: item.expiresAt,
    confidence: logic.confidence,
    analysis: analysisForRecord(item, logic),
    riskLevel,
    groupKey: groupKeyForRecord(item),
    sectionKey,
    displayMode: displayModeForRecord(item, logic),
    frontendActionState: frontendActionStateForRecord(item, logic, dependencies, action),
    privacyClassification: item.privacyPolicy,
    visibilityScope: visibilityScopeForItem(item),
    createdAt: item.createdAt,
    updatedAt: item.createdAt,
    snoozedUntil: item.snoozedUntil,
    actions,
    dependsOnDecisionIds: dependencies.dependsOnDecisionIds,
    blockedByDecisionIds: dependencies.blockedByDecisionIds,
    rollbackAvailable: rollback.available,
    rollbackActionId: rollback.actionId,
  };
}

function displayModeForRecord(item: DecisionRecord, logic: DecisionLogicV2): DecisionFrontendDisplayMode {
  if (!logic.quality.safeToShowUser) return 'details_unavailable';
  if (item.status === 'failed') return 'failed';
  if (item.status === 'actioned') return 'handled';
  if (item.status === 'superseded' || item.status === 'dismissed') return 'handled';
  if (item.type === 'sync_failure') return 'waiting_on_system';
  return 'needs_input';
}

function frontendActionStateForRecord(
  item: DecisionRecord,
  logic: DecisionLogicV2,
  dependencies: { blockedByDecisionIds: string[] },
  action: NotificationActionButton | null = recommendedAction(actionsForRecord(item)),
): DecisionFrontendActionState {
  if (!logic.quality.safeForFrontendAction) return 'disabled_missing_details';
  if (!action || !isDecisionActionExecutable(action.id)) return 'disabled_missing_details';
  if (item.status === 'expired') return 'disabled_expired';
  if (item.status === 'superseded' || item.status === 'dismissed' || item.status === 'actioned') return 'disabled_superseded';
  if (dependencies.blockedByDecisionIds.length > 0) return 'disabled_missing_details';
  return 'enabled';
}

function safeTitleForItem(item: DecisionRecord): string {
  if (item.privacyPolicy === 'financial' || item.sourceSkill === 'finance') return 'Finance decision';
  if (item.privacyPolicy === 'health' || item.sourceSkill === 'training') return item.type === 'decision_required' ? 'Training decision' : 'Training update';
  if (item.privacyPolicy === 'private_content' || item.sourceSkill === 'content') return 'Content review';
  if (item.privacyPolicy === 'sensitive') return sourceLabel(item.sourceSkill);
  return item.title;
}

function whyDetailsForItem(item: DecisionRecord, logic: DecisionLogicV2): Array<{ label: string; value: string }> {
  const details = [
    { label: 'Source', value: sourceLabel(item.sourceSkill) },
    { label: 'Recommendation', value: logic.recommendation },
    { label: 'Expected effect', value: logic.expectedEffect },
    { label: 'Rule', value: logic.why.rules[0] ?? 'Decision Center only shows items that require user judgment or approval.' },
  ];
  for (const fact of logic.why.facts.slice(0, 3)) {
    details.push({ label: 'Fact', value: fact });
  }
  for (const tradeoff of logic.why.tradeoffs.slice(0, 2)) {
    details.push({ label: 'Tradeoff', value: tradeoff });
  }
  if (item.decisionDeadline) {
    details.push({ label: 'Deadline', value: item.decisionDeadline });
  }
  if (item.privacyPolicy !== 'public') {
    details.push({ label: 'Privacy', value: 'Home and notifications use a safe preview; details require authenticated access.' });
  }
  return details;
}

function timingLabelForRecord(item: DecisionRecord, urgency: DecisionUrgency): string | null {
  const timestamp = item.decisionDeadline ?? item.expiresAt ?? null;
  if (!timestamp) {
    if (urgency === 'urgent') return 'Urgent';
    if (urgency === 'today') return 'Today';
    if (urgency === 'this_week') return 'This week';
    return null;
  }
  const parsed = DateTime.fromISO(timestamp, { zone: 'utc' });
  if (!parsed.isValid) return urgency === 'urgent' ? 'Urgent' : null;
  const now = DateTime.utc();
  if (parsed.hasSame(now, 'day')) return 'Today';
  if (parsed.hasSame(now.plus({ days: 1 }), 'day')) return 'Tomorrow';
  if (parsed <= now.plus({ days: 7 })) return 'This week';
  return parsed.toFormat('LLL d');
}

function sectionKeyForRecord(item: DecisionRecord, urgency: DecisionUrgency, logic: DecisionLogicV2): DecisionTimelineSectionKey {
  const displayMode = displayModeForRecord(item, logic);
  if (displayMode === 'waiting_on_system') return 'waiting_on_systems';
  if (displayMode === 'handled' || item.status === 'actioned' || item.status === 'superseded' || item.status === 'dismissed') return 'handled';
  if (urgency === 'urgent') return 'urgent';
  const timestamp = item.decisionDeadline ?? item.expiresAt ?? null;
  if (timestamp) {
    const parsed = DateTime.fromISO(timestamp, { zone: 'utc' });
    if (parsed.isValid) {
      const now = DateTime.utc();
      if (parsed.hasSame(now, 'day')) return 'today';
      if (parsed.hasSame(now.plus({ days: 1 }), 'day')) return 'tomorrow';
      if (parsed <= now.plus({ days: 7 })) return 'this_week';
    }
  }
  if (urgency === 'today') return 'today';
  return 'this_week';
}

function groupKeyForRecord(item: DecisionRecord): string {
  if (item.relatedEntityType && item.relatedEntityId) return `${item.sourceSkill}:${item.relatedEntityType}:${item.relatedEntityId}`;
  return `${item.sourceSkill}:${item.type}:${item.dedupeKey ?? item.itemId}`;
}

function alternativesForRecord(
  item: DecisionRecord,
  logic: DecisionLogicV2,
  actions: NotificationActionButton[],
): DecisionAlternativeOption[] {
  const alternatives: DecisionAlternativeOption[] = [];
  const primary = recommendedAction(actions);
  if (primary) {
    alternatives.push({
      id: `${item.itemId}:recommended`,
      label: logic.primaryActionLabel || primary.label,
      rank: 'best',
      reason: logic.whySummary,
      actionId: primary.id,
      available: frontendActionStateForRecord(item, logic, dependencyStateForRecord(item), primary) === 'enabled',
      source: 'recipe',
    });
  }
  for (const action of actions.filter((candidate) => candidate.id !== primary?.id && candidate.id !== 'open_detail')) {
    alternatives.push({
      id: `${item.itemId}:${action.id}`,
      label: action.label,
      rank: action.style === 'destructive' ? 'not_recommended' : 'good',
      reason: action.style === 'destructive'
        ? 'This option changes or rejects the recommendation, so Nexus keeps it explicit.'
        : 'Available as a lower-friction alternative if the recommendation does not fit.',
      actionId: action.id,
      available: frontendActionStateForRecord(item, logic, dependencyStateForRecord(item), action) === 'enabled',
      source: 'recipe',
    });
  }
  if (!alternatives.some((option) => option.actionId === 'snooze')) {
    alternatives.push({
      id: `${item.itemId}:snooze`,
      label: 'Snooze',
      rank: 'good',
      reason: 'Use this if the decision is real but not worth interrupting this window.',
      actionId: 'snooze',
      available: item.status === 'unread' || item.status === 'read' || item.status === 'failed',
      source: 'system_default',
    });
  }
  if (!alternatives.some((option) => option.actionId === 'dismiss')) {
    alternatives.push({
      id: `${item.itemId}:dismiss`,
      label: 'Dismiss',
      rank: 'not_recommended',
      reason: 'Dismiss only when the recommendation no longer matters; Nexus records that outcome for future ranking.',
      actionId: 'dismiss',
      available: item.status === 'unread' || item.status === 'read' || item.status === 'failed',
      source: 'system_default',
    });
  }
  return alternatives.slice(0, 5);
}

function relatedEntitiesSafeForRecord(item: DecisionRecord, logic: DecisionLogicV2): Array<{ type: string; label: string }> {
  if (!item.relatedEntityType || !item.relatedEntityId) {
    return logic.relatedEntityReason ? [{ type: 'reason', label: logic.relatedEntityReason }] : [];
  }
  const sensitive = item.privacyPolicy === 'financial' || item.privacyPolicy === 'sensitive';
  return [{
    type: item.relatedEntityType,
    label: sensitive ? `${sourceLabel(item.sourceSkill)} item` : `${sourceLabel(item.sourceSkill)} ${item.relatedEntityType.replace(/_/g, ' ')}`,
  }];
}

function sourceTraceSummaryForRecord(item: DecisionRecord, logic: DecisionLogicV2): string {
  const entity = item.relatedEntityType ? item.relatedEntityType.replace(/_/g, ' ') : 'source state';
  const verifier = logic.readBackVerifier ?? 'non-mutating decision';
  return `${sourceLabel(item.sourceSkill)} ${entity} -> Decision Center v2 -> ${verifier}`;
}

function sourceTraceForRecord(item: DecisionRecord, logic: DecisionLogicV2): DecisionSourceTrace {
  const sourceEntityIds = item.relatedEntityType && item.relatedEntityId
    ? [`${item.relatedEntityType}:${item.relatedEntityId}`]
    : [];
  // C2: when the decision is anchored on a Secretary agenda item, surface
  // its persisted reasoning trail. Use the same owner-scoped read used by
  // `decisionContextForRecord` so cross-tenant leaks are impossible
  // (lookup tuple = agendaItemId + ownerUserId + tenantId).
  const reasoningTrail = reasoningTrailForRecord(item);
  return {
    originatingSkill: item.sourceSkill,
    originatingSignal: item.type,
    sourceEntityIds,
    sourceTimestamp: item.createdAt,
    enrichmentService: 'decision-center-logic-v2',
    orchestrator: item.sourceSkill === 'secretary' || item.type === 'conflict_detected'
      ? 'secretary-decision-advisor'
      : 'decision-center-facade',
    executor: actionsForRecord(item).length > 0 ? executorSkillForAction(actionsForRecord(item)[0].id, item) : null,
    verifier: logic.readBackVerifier,
    relatedStateReadModels: relatedStateReadModelsForRecord(item),
    confidenceSource: logic.confidence >= 0.8 ? 'structured-state-and-readback' : 'partial-structured-state',
    dataFreshness: item.status === 'snoozed' ? 'cached' : 'live',
    ...(reasoningTrail && reasoningTrail.length > 0 ? { reasoningTrail } : {}),
  };
}

function analysisForRecord(item: DecisionRecord, logic: DecisionLogicV2): DecisionAnalysisBundle {
  const context = decisionContextForRecord(item);
  const sourceFreshness = sourceFreshnessForRecord(item, context);
  const confidenceLabel = logic.confidence >= 0.8 ? 'high' : logic.confidence >= 0.6 ? 'medium' : 'low';
  const rollbackConfidence = !rollbackContractForRecord(item).available
    ? 'none'
    : logic.readBackVerifier
      ? 'high'
      : logic.confidence >= 0.7
        ? 'medium'
        : 'low';
  return {
    confidence: logic.confidence,
    confidenceLabel,
    sourceFreshness,
    freshnessLabel: freshnessLabel(sourceFreshness, context),
    whyNow: logic.urgencyReason || logic.whySummary,
    expectedOutcome: logic.expectedEffect,
    costOfDelay: logic.impactIfIgnored,
    tradeoffs: logic.why.tradeoffs.slice(0, 3),
    uncertainty: logic.why.uncertainty.slice(0, 3),
    rollbackConfidence,
  };
}

function sourceFreshnessForRecord(item: DecisionRecord, context: DecisionLogicContext): DecisionAnalysisBundle['sourceFreshness'] {
  if (item.status === 'snoozed') return 'stale';
  const state = String(context.providerSyncState ?? '').toLowerCase();
  if (state && state !== 'synced' && state !== 'deleted') {
    const updatedAt = Date.parse(String(context.providerSyncUpdatedAt ?? ''));
    if (!Number.isFinite(updatedAt)) return 'unknown';
    const ageMinutes = (Date.now() - updatedAt) / 60_000;
    return ageMinutes > 15 ? 'stale' : 'fresh';
  }
  if (context.providerSyncUpdatedAt) {
    const updatedAt = Date.parse(String(context.providerSyncUpdatedAt));
    if (!Number.isFinite(updatedAt)) return 'unknown';
    return (Date.now() - updatedAt) / 60_000 <= 15 ? 'fresh' : 'live';
  }
  return item.relatedEntityId ? 'live' : 'unknown';
}

function freshnessLabel(freshness: DecisionAnalysisBundle['sourceFreshness'], context: DecisionLogicContext): string {
  switch (freshness) {
    case 'live':
      return 'Live read model';
    case 'fresh':
      return context.providerSyncUpdatedAt ? `Fresh as of ${context.providerSyncUpdatedAt}` : 'Fresh provider state';
    case 'stale':
      return context.providerSyncUpdatedAt ? `Provider state may be stale since ${context.providerSyncUpdatedAt}` : 'Stale state; refresh before acting';
    case 'unknown':
    default:
      return 'Freshness unknown';
  }
}

function topSuggestionForItem(item: DecisionApiItem): DecisionCenterTopSuggestion {
  return {
    decisionId: item.decisionId,
    title: item.safePreviewTitle || item.title,
    actionLabel: item.recommendedActionLabel ?? item.primaryActionLabel ?? null,
    whyNow: item.analysis?.whyNow ?? item.whySummary ?? item.urgencyReason,
    expectedOutcome: item.analysis?.expectedOutcome ?? item.expectedEffect,
    riskIfIgnored: item.analysis?.costOfDelay ?? item.impactIfIgnored,
    sourceSkill: item.sourceSkill,
    urgency: item.urgency,
  };
}

/**
 * Read the persisted Secretary reasoning trail for a decision record.
 *
 * Returns `null` when:
 * - the record isn't anchored on a `secretary_agenda_item`, OR
 * - the agenda item is missing / doesn't match the owner+tenant scope, OR
 * - the persisted column is empty (e.g. legacy rows from before W-E).
 *
 * The owner+tenant scope is enforced by `getSecretaryAgendaItemById` itself,
 * so a cross-tenant decisionId cannot leak another user's trail.
 */
function reasoningTrailForRecord(item: DecisionRecord): ReasoningTrailNode[] | null {
  if (item.relatedEntityType !== 'secretary_agenda_item' || !item.relatedEntityId) return null;
  const agenda = getSecretaryAgendaItemById({
    agendaItemId: item.relatedEntityId,
    ownerUserId: item.userId,
    tenantId: item.tenantId,
  });
  if (!agenda) return null;
  return agenda.reasoningTrail.length > 0 ? agenda.reasoningTrail : null;
}

function relatedStateReadModelsForRecord(item: DecisionRecord): string[] {
  const models = ['notification_center_items', 'notification_intents'];
  if (item.sourceSkill === 'secretary') models.push('secretary_agenda_items');
  if (item.sourceSkill === 'content') models.push('content_workflow_objects');
  if (item.sourceSkill === 'cooking') models.push('cooking_meal_plans');
  if (item.sourceSkill === 'finance') models.push('finance_tax_events');
  return models;
}

function dependencyGraphSummaryForRecord(
  dependencies: { dependsOnDecisionIds: string[]; blockedByDecisionIds: string[] },
  locale?: string | null,
): string | null {
  const pt = String(locale ?? '').toLowerCase().startsWith('pt');
  if (dependencies.blockedByDecisionIds.length > 0) {
    if (pt) {
      const count = dependencies.blockedByDecisionIds.length;
      return `Bloqueado por ${count} decisão${count === 1 ? '' : 'ões'} por resolver.`;
    }
    return `Blocked by ${dependencies.blockedByDecisionIds.length} unresolved decision${dependencies.blockedByDecisionIds.length === 1 ? '' : 's'}.`;
  }
  if (dependencies.dependsOnDecisionIds.length > 0) {
    if (pt) {
      const count = dependencies.dependsOnDecisionIds.length;
      return `Relacionado com ${count} decisão${count === 1 ? '' : 'ões'} anterior${count === 1 ? '' : 'es'}.`;
    }
    return `Related to ${dependencies.dependsOnDecisionIds.length} upstream decision${dependencies.dependsOnDecisionIds.length === 1 ? '' : 's'}.`;
  }
  return null;
}

function actionTruthTableEntryForRecord(
  item: DecisionRecord,
  action: NotificationActionButton,
  logic: DecisionLogicV2,
  rollback: { available: boolean },
): DecisionActionTruthTableEntry {
  return buildDecisionActionTruthTableEntry({
    actionId: action.id,
    sourceSkill: item.sourceSkill,
    expectedEffect: logic.expectedEffect,
    readBackVerifier: logic.readBackVerifier,
    outcomeSummary: outcomeSummaryForRecord({ ...item, status: 'actioned' }, logic).outcomeSummary,
    rollbackAvailable: rollback.available,
    notificationCanAct: logic.notificationEligibility === 'visible' && logic.quality.safeForAPNs,
    riskIfIgnored: logic.riskIfIgnored,
    priority: item.priority,
  });
}

function askNexusContextForRecord(item: DecisionRecord, logic: DecisionLogicV2): DecisionAskNexusContext {
  return {
    decisionId: item.itemId,
    sourceSkill: item.sourceSkill,
    type: item.type,
    prompt: `Explain this ${sourceLabel(item.sourceSkill)} decision, the recommendation, and what changes if I approve: ${logic.safePreviewTitle || logic.title}`,
  };
}

function decisionLogicForIntentInput(input: NotificationIntentInput): DecisionLogicV2 {
  return buildDecisionLogicV2({
    sourceSkill: input.sourceSkill,
    type: input.type,
    priority: input.priority,
    title: input.title,
    body: input.body,
    safeBody: input.body,
    actions: input.actionButtons ?? [],
    relatedEntityType: input.relatedEntityType ?? null,
    relatedEntityId: input.relatedEntityId == null ? null : String(input.relatedEntityId),
    deadlineAt: input.decisionDeadline ?? null,
    expiresAt: input.expiresAt ?? null,
    privacyClassification: input.privacyPolicy ?? privacyPolicyForSource(input.sourceSkill),
    visibilityScope: visibilityScopeForIntentInput(input),
    context: decisionContextForIntentInput(input),
  });
}

function decisionLogicForRecord(record: DecisionRecord): DecisionLogicV2 {
  return buildDecisionLogicV2(decisionLogicInputForRecord(record));
}

function decisionLogicInputForRecord(record: DecisionRecord): Parameters<typeof buildDecisionLogicV2>[0] {
  return {
    sourceSkill: record.sourceSkill,
    type: record.type,
    priority: record.priority,
    title: record.title,
    body: record.body,
    safeBody: record.safeBody,
    actions: actionsForRecord(record),
    relatedEntityType: record.relatedEntityType,
    relatedEntityId: record.relatedEntityId,
    deadlineAt: record.decisionDeadline,
    expiresAt: record.expiresAt,
    privacyClassification: record.privacyPolicy,
    visibilityScope: visibilityScopeForItem(record),
    context: decisionContextForRecord(record),
  };
}

function decisionContextForIntentInput(input: NotificationIntentInput): DecisionLogicContext {
  const suppliedRaw = input.decisionContext ?? null;
  const supplied = withUserDecisionContextDefaults(input.userId, suppliedRaw);
  const relatedEntityType = input.relatedEntityType ?? null;
  if (input.sourceSkill === 'secretary' && relatedEntityType === 'secretary_agenda_item' && input.relatedEntityId != null) {
    const tenantId = input.tenantId ?? input.userId;
    const agenda = getSecretaryAgendaItemById({
      agendaItemId: String(input.relatedEntityId),
      ownerUserId: input.userId,
      tenantId,
    });
    if (agenda) return secretaryAgendaDecisionContext(agenda, supplied);
  }
  if (hasDecisionContextPayload(suppliedRaw)) return supplied;
  if (input.sourceSkill === 'training' && /race date/i.test(`${input.title} ${input.body}`)) {
    return withUserDecisionContextDefaults(input.userId, { explicitNoRelatedEntityReason: 'training profile is the affected entity' });
  }
  return supplied;
}

function decisionContextForRecord(record: DecisionRecord): DecisionLogicContext {
  const hasStoredContext = hasDecisionContextPayload(record.decisionContext);
  const storedContext = withUserDecisionContextDefaults(record.userId, record.decisionContext);
  if (record.sourceSkill === 'secretary' && record.relatedEntityType === 'secretary_agenda_item' && record.relatedEntityId) {
    const agenda = getSecretaryAgendaItemById({
      agendaItemId: record.relatedEntityId,
      ownerUserId: record.userId,
      tenantId: record.tenantId,
    });
    if (agenda) return secretaryAgendaDecisionContext(agenda, storedContext);
    if (hasStoredContext) return storedContext;
    return withUserDecisionContextDefaults(record.userId, { explicitNoRelatedEntityReason: 'secretary agenda item is missing' });
  }
  if (hasStoredContext) return storedContext;
  if (record.sourceSkill === 'content') {
    const contentObjectId = contentWorkflowObjectIdForDecision(record);
    if (contentObjectId) {
      const object = getContentWorkflowObject(record.userId, contentObjectId, record.tenantId);
      if (object) return withUserDecisionContextDefaults(record.userId, { entityTitle: object.title, sourceState: object.approvalState });
    }
  }
  if (record.sourceSkill === 'training' && /race date/i.test(`${record.title} ${record.body} ${record.dedupeKey ?? ''}`)) {
    return withUserDecisionContextDefaults(record.userId, { explicitNoRelatedEntityReason: 'training profile is the affected entity' });
  }
  if (record.type === 'sync_failure') {
    return withUserDecisionContextDefaults(record.userId, { providerName: sourceLabel(record.sourceSkill), explicitNoRelatedEntityReason: 'sync failure is scoped to provider state' });
  }
  return storedContext;
}

function secretaryAgendaDecisionContext(agenda: SecretaryAgendaItem, supplied?: DecisionLogicContext | null): DecisionLogicContext {
  const candidateSlots = secretaryCandidateSlots(agenda, supplied);
  const currentStartAt = supplied?.currentStartAt ?? agenda.startAt ?? null;
  const currentEndAt = supplied?.currentEndAt ?? agenda.endAt ?? null;
  const advice = adviseSecretaryDecision({
    title: agenda.title,
    currentStartAt,
    currentEndAt,
    availableSlots: candidateSlots,
    reasonCodes: supplied?.reasonCodes ?? agenda.decisionReasonCodes,
    timezone: supplied?.timezone,
    locale: supplied?.locale,
  });
  return {
    ...(supplied ?? {}),
    entityTitle: agenda.title,
    currentStartAt,
    currentEndAt,
    recommendedStartAt: advice.recommendedStartAt,
    recommendedEndAt: advice.recommendedEndAt,
    candidateSlots,
    reasonCodes: supplied?.reasonCodes ?? agenda.decisionReasonCodes,
    sourceState: supplied?.sourceState ?? agenda.lifecycleState,
    providerSyncState: agenda.providerSyncState,
    providerSyncUpdatedAt: agenda.updatedAt,
  };
}

function withUserDecisionContextDefaults(userId: number, context?: DecisionLogicContext | null): DecisionLogicContext {
  const merged: DecisionLogicContext = { ...(context ?? {}) };
  const defaults = userDecisionContextDefaults(userId);
  if (!merged.timezone && defaults.timezone) merged.timezone = defaults.timezone;
  if (!merged.locale && defaults.locale) merged.locale = defaults.locale;
  return merged;
}

function hasDecisionContextPayload(context?: DecisionLogicContext | null): boolean {
  if (!context || typeof context !== 'object') return false;
  return Object.keys(context).some((key) => key !== 'timezone' && key !== 'locale');
}

function userDecisionContextDefaults(userId: number): Pick<DecisionLogicContext, 'timezone' | 'locale'> {
  if (!Number.isFinite(userId) || userId <= 0) return {};
  try {
    const row = getDb().prepare('SELECT language, timezone FROM users WHERE id = ?').get(userId) as {
      language?: string | null;
      timezone?: string | null;
    } | undefined;
    const timezone = validateDecisionTimezone(row?.timezone);
    const locale = validateDecisionLocale(row?.language);
    return {
      ...(timezone ? { timezone } : {}),
      ...(locale ? { locale } : {}),
    };
  } catch {
    return {};
  }
}

function validateDecisionTimezone(timezone?: string | null): string | undefined {
  if (typeof timezone !== 'string' || !timezone.trim()) return undefined;
  const trimmed = timezone.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch {
    return undefined;
  }
}

function validateDecisionLocale(locale?: string | null): string | undefined {
  if (typeof locale !== 'string' || !locale.trim()) return undefined;
  const trimmed = locale.trim();
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([trimmed])[0] ?? undefined;
  } catch {
    return undefined;
  }
}

function secretaryCandidateSlots(
  agenda: SecretaryAgendaItem,
  supplied?: DecisionLogicContext | null,
): SecretaryAvailableSlot[] {
  const slots: SecretaryAvailableSlot[] = [];
  const addSlot = (
    startAt?: string | null,
    endAt?: string | null,
    label?: string | null,
    metadata?: Partial<SecretaryAvailableSlot> | null,
  ) => {
    if (!startAt || !endAt) return;
    if (!Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt)) || Date.parse(startAt) >= Date.parse(endAt)) return;
    if (slots.some((slot) => Date.parse(slot.startAt) === Date.parse(startAt) && Date.parse(slot.endAt) === Date.parse(endAt))) return;
    slots.push({
      ...(metadata ?? {}),
      startAt,
      endAt,
      label: label ?? metadata?.label ?? undefined,
    });
  };

  for (const slot of supplied?.candidateSlots ?? []) {
    addSlot(slot.startAt, slot.endAt, slot.label ?? 'Candidate slot', slot);
  }
  addSlot(supplied?.recommendedStartAt, supplied?.recommendedEndAt, 'Recommended slot');
  for (const segment of agenda.scheduledSegments ?? []) {
    addSlot(segment.start, segment.end, segment.label ?? 'Secretary candidate');
  }
  addSlot(agenda.startAt, agenda.endAt, 'Proposed slot');
  return slots;
}

function outcomeSummaryForRecord(record: DecisionRecord, logic: DecisionLogicV2): {
  outcomeSummary: string | null;
  failureReason: string | null;
  retryActions: NotificationActionButton[];
} {
  if (!record.actionResult) return { outcomeSummary: null, failureReason: null, retryActions: [] };
  const actionId = typeof record.actionResult.actionId === 'string' ? record.actionResult.actionId : null;
  const errorCode = typeof record.actionResult.errorCode === 'string' ? record.actionResult.errorCode : null;
  if (record.status === 'failed' || errorCode) {
    return {
      outcomeSummary: 'Action failed. You can retry.',
      failureReason: errorCode ?? 'Decision action failed.',
      retryActions: actionsForRecord(record).filter((action) => action.style === 'primary' || action.id !== 'open_detail'),
    };
  }
  if (record.status === 'actioned') {
    if (record.sourceSkill === 'secretary') {
      const startAt = typeof record.actionResult.startAt === 'string' ? record.actionResult.startAt : null;
      const endAt = typeof record.actionResult.endAt === 'string' ? record.actionResult.endAt : null;
      const context = decisionContextForRecord(record);
      const window = formatDecisionWindow(startAt, endAt, context.timezone, context.locale) ?? 'the proposed window';
      return { outcomeSummary: `Done — Secretary applied ${window} and verified the agenda item.`, failureReason: null, retryActions: [] };
    }
    if (record.sourceSkill === 'content') {
      const state = typeof record.actionResult.approvalState === 'string' ? record.actionResult.approvalState : 'updated';
      return { outcomeSummary: `Done — content workflow is ${state}.`, failureReason: null, retryActions: [] };
    }
    return { outcomeSummary: `Done — ${logic.expectedEffect}`, failureReason: null, retryActions: [] };
  }
  return { outcomeSummary: null, failureReason: null, retryActions: [] };
}

function privacyPolicyForSource(sourceSkill: NotificationSourceSkill): NotificationPrivacyPolicy {
  if (sourceSkill === 'finance') return 'financial';
  if (sourceSkill === 'training') return 'health';
  if (sourceSkill === 'content') return 'private_content';
  if (sourceSkill === 'security') return 'sensitive';
  return 'standard';
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
  return visibilityScopeFromContext(item.decisionContext) ?? 'user_private';
}

function visibilityScopeForIntentInput(input: NotificationIntentInput): DecisionVisibilityScope {
  const candidate = input.visibilityScope ?? input.decisionContext?.visibilityScope;
  return normalizeVisibilityScope(candidate) ?? 'user_private';
}

function visibilityScopeFromContext(context: DecisionLogicContext | null | undefined): DecisionVisibilityScope | null {
  return normalizeVisibilityScope(context?.visibilityScope);
}

function normalizeVisibilityScope(value: unknown): DecisionVisibilityScope | null {
  return value === 'user_private'
    || value === 'tenant_shared'
    || value === 'tenant_admin'
    || value === 'system_admin'
    ? value
    : null;
}

function ctaLabelForSummary(openCount: number, urgentCount: number, top: DecisionApiItem | null, locale?: string | null): string {
  const pt = isPortugueseLocale(locale);
  if (openCount === 0) return pt ? 'Tudo certo' : 'All Clear';
  if (urgentCount > 0) return pt ? 'Decisão urgente' : 'Urgent Decision';
  if (top?.type === 'conflict_detected') return pt ? 'Conflito de agenda' : 'Schedule Conflict';
  if (openCount === 1) return pt ? '1 decisão' : '1 Decision';
  return pt ? `${openCount} decisões` : `${openCount} Decisions`;
}

function isPortugueseLocale(locale?: string | null): boolean {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('pt');
}

function getDecisionRecord(decisionId: string, userId: number, tenantId = userId): DecisionRecord | null {
  assertScope(userId, tenantId, 'get_decision_record', { decisionId });
  ensureDecisionCenterTables();
  const row = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json
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
    decisionContext: safeParseJson(row.decision_context_json, null),
    requiresUserAction: !!row.requires_user_action,
    decisionDeadline: row.decision_deadline,
    privacyPolicy: row.privacy_policy ?? 'standard',
    deliveryPolicy: row.delivery_policy,
    snoozedUntil: row.snoozed_until ?? null,
    actionedAt: row.actioned_at ?? null,
    decisionLogActionTaken: row.decision_log_action_taken ?? null,
    actionResult: row.action_result_json ? safeParseJson(row.action_result_json, null) : null,
  };
}

function isSnoozedUntilFuture(item: DecisionRecord): boolean {
  if (item.status !== 'snoozed' || !item.snoozedUntil) return false;
  const untilMs = Date.parse(item.snoozedUntil);
  return Number.isFinite(untilMs) && untilMs > Date.now();
}

function actionsForRecord(record: DecisionRecord): NotificationActionButton[] {
  const actions = [...record.actions];
  const rollback = rollbackContractForRecord(record);
  if (
    rollback.available
    && rollback.actionId
    && !actions.some((action) => action.id === rollback.actionId)
  ) {
    actions.unshift({
      id: rollback.actionId,
      label: 'Undo reflow',
      style: 'secondary',
    });
  }
  return actions;
}

function rollbackContractForRecord(record: DecisionRecord): { available: boolean; actionId: string | null } {
  const actionId = typeof record.actionResult?.rollbackActionId === 'string'
    ? record.actionResult.rollbackActionId
    : null;
  return {
    available: record.status === 'actioned' && record.actionResult?.rollbackAvailable === true && !!actionId,
    actionId,
  };
}

function dependencyStateForRecord(record: DecisionRecord): { dependsOnDecisionIds: string[]; blockedByDecisionIds: string[] } {
  const dependencies = listDecisionDependencies(record.itemId, record.userId, record.tenantId);
  const unresolved = new Set(['unread', 'read', 'failed', 'snoozed']);
  return {
    dependsOnDecisionIds: dependencies.map((dependency) => dependency.dependsOnDecisionId),
    blockedByDecisionIds: dependencies
      .filter((dependency) => dependency.relationship === 'blocks' && dependency.blockerStatus && unresolved.has(dependency.blockerStatus))
      .map((dependency) => dependency.dependsOnDecisionId),
  };
}

function guardActionable(record: DecisionRecord, actionId: string): void {
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
    const expire = getDb().prepare(`
      UPDATE notification_center_items SET status = 'expired'
      WHERE item_id = ? AND user_id = ? AND tenant_id = ?
    `).run(record.itemId, record.userId, record.tenantId);
    assertDecisionScopedUpdateApplied(expire, 'expire_decision', {
      decisionId: record.itemId,
      userId: record.userId,
      tenantId: record.tenantId,
    });
    throw new DecisionActionError('DECISION_EXPIRED', 'Decision expired and can no longer be actioned', 409);
  }
  if (record.status === 'expired') throw new DecisionActionError('DECISION_EXPIRED', 'Decision expired and can no longer be actioned', 409);
  if (record.status === 'superseded') throw new DecisionActionError('DECISION_SUPERSEDED', 'Decision was superseded by newer state', 409);
  if (record.status === 'dismissed') throw new DecisionActionError('DECISION_DISMISSED', 'Decision was dismissed', 409);
  if (record.status === 'actioned' && rollbackContractForRecord(record).actionId !== actionId) {
    throw new DecisionActionError('DECISION_ALREADY_ACTIONED', 'Decision was already actioned', 409);
  }
}

function guardDecisionDependencies(record: DecisionRecord, actionId: string): void {
  if (actionId === 'open_detail' || actionId === 'dismiss' || actionId === 'snooze' || actionId === 'not_now' || actionId === 'undo_reflow') {
    return;
  }
  const blockedByDecisionIds = dependencyStateForRecord(record).blockedByDecisionIds;
  if (blockedByDecisionIds.length === 0) return;
  throw new DecisionActionError('DECISION_DEPENDENCY_BLOCKED', 'Resolve the blocking decision before running this action.', 409, {
    blockedByDecisionIds,
  });
}

function getExistingExecution(decisionId: string, actionId: string, userId: number, tenantId: number, idempotencyKey: string): any | null {
  return getDb().prepare(`
    SELECT * FROM decision_action_executions
     WHERE decision_id = ? AND action_id = ? AND user_id = ? AND tenant_id = ? AND idempotency_key = ?
     LIMIT 1
  `).get(decisionId, actionId, userId, tenantId, idempotencyKey) as any ?? null;
}

function claimExecution(record: DecisionRecord, actionId: string, idempotencyKey: string, executorSkill: string): { isNew: boolean; execution: any } {
  const db = getDb();
  return db.transaction(() => {
    const existing = getExistingExecution(record.itemId, actionId, record.userId, record.tenantId, idempotencyKey);
    if (existing) return { isNew: false, execution: existing };

    const executionId = `dae_${randomUUID()}`;
    const insert = db.prepare(`
      INSERT OR IGNORE INTO decision_action_executions (
        action_execution_id, decision_id, action_id, user_id, tenant_id, idempotency_key,
        executor_skill, status, expected_effect_json, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', '{}', '{}')
    `).run(executionId, record.itemId, actionId, record.userId, record.tenantId, idempotencyKey, executorSkill);

    const execution = getExistingExecution(record.itemId, actionId, record.userId, record.tenantId, idempotencyKey);
    if (!execution) {
      throw new DecisionActionError('DECISION_ACTION_FAILED', 'Decision action execution could not be claimed', 500);
    }
    return { isNew: insert.changes === 1, execution };
  })();
}

function idempotentActionResult(
  decisionId: string,
  actionId: string,
  userId: number,
  tenantId: number,
  execution: any,
): DecisionActionResult {
  const current = getDecisionItem(decisionId, userId, tenantId);
  if (!current) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found after idempotent action', 404);
  return {
    actionId,
    status: 'idempotent',
    idempotent: true,
    item: current,
    verification: {
      readBackOk: true,
      expectedEffect: safeParseJson(execution.expected_effect_json, {}),
      actualEffect: safeParseJson(execution.result_json, {}),
      message: 'Duplicate action returned the original verified result.',
    },
  };
}

async function waitForExistingExecution(
  decisionId: string,
  actionId: string,
  userId: number,
  tenantId: number,
  idempotencyKey: string,
): Promise<DecisionActionResult> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const execution = getExistingExecution(decisionId, actionId, userId, tenantId, idempotencyKey);
    if (!execution || execution.status === 'started') continue;
    if (execution.status === 'succeeded') {
      return idempotentActionResult(decisionId, actionId, userId, tenantId, execution);
    }
    throw new DecisionActionError(execution.error_code || 'DECISION_ACTION_FAILED', 'Prior decision action attempt failed', 409, safeParseJson(execution.result_json, {}));
  }

  throw new DecisionActionError('DECISION_ACTION_IN_PROGRESS', 'Decision action is already in progress', 409);
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
    markNotificationCenterItemRead(record.itemId, userId, tenantId);
    return verifiedStatusEffect(record, 'read', 'Decision was marked viewed.');
  }

  if (action.id === 'dismiss' || action.id === 'reject_reflow' || action.id === 'not_now') {
    dismissNotificationCenterItem(record.itemId, userId, tenantId);
    markDecisionAction(record.decisionLogId, action.id);
    return verifiedStatusEffect(record, 'dismissed', 'Decision was declined/dismissed.');
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

  if (action.id === 'accept_reflow' || action.id === 'choose_another_time') {
    return executeSecretaryAgendaDecision(record, action.id, userId, tenantId, payload);
  }

  if (action.id === 'undo_reflow') {
    return executeSecretaryReflowRollback(record, userId, tenantId);
  }

  if (action.id === 'mark_paid') {
    return executeFinancePaymentDecision(record, userId, tenantId, payload);
  }

  if (action.id === 'add_meal') {
    return executeCookingMealDecision(record, userId, tenantId, payload);
  }

  if (action.id === 'option_a' || action.id === 'option_b') {
    return executeChatClarificationDecision(record, action.id, userId, tenantId);
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

function verifiedStatusEffect(record: DecisionRecord, expected: string, message: string): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  const actual = getDecisionRecord(record.itemId, record.userId, record.tenantId)?.status ?? null;
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

function executeSecretaryAgendaDecision(
  record: DecisionRecord,
  actionId: string,
  userId: number,
  tenantId: number,
  payload: Record<string, unknown>,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'secretary' || record.relatedEntityType !== 'secretary_agenda_item' || !record.relatedEntityId) {
    throw new DecisionActionError(
      'UNSUPPORTED_DECISION_EXECUTOR',
      'Secretary reflow actions require a persisted Secretary agenda item before Nexus can run them.',
      409,
      { relatedEntityType: record.relatedEntityType },
    );
  }

  const agenda = getSecretaryAgendaItemById({ agendaItemId: record.relatedEntityId, ownerUserId: userId, tenantId });
  if (!agenda) {
    throw new DecisionActionError('DECISION_RELATED_ENTITY_NOT_FOUND', 'Secretary agenda item was not found for this user.', 404);
  }

  const rollback = secretaryAgendaRollbackSnapshot(agenda);
  const updates = buildSecretaryAgendaUpdates(actionId, agenda, payload);
  const agendaUpdate = getDb().prepare(`
    UPDATE secretary_agenda_items
       SET lifecycle_state = ?,
           decision_action = ?,
           decision_reason_codes_json = ?,
           decision_explanation = ?,
           start_at = COALESCE(?, start_at),
           end_at = COALESCE(?, end_at),
           scheduled_segments_json = ?,
           updated_at = datetime('now')
     WHERE agenda_item_id = ?
       AND owner_user_id = ?
       AND tenant_id = ?
  `).run(
    updates.lifecycleState,
    updates.decisionAction,
    JSON.stringify(updates.reasonCodes),
    updates.explanation,
    updates.startAt,
    updates.endAt,
    JSON.stringify(updates.startAt && updates.endAt ? [{ start: updates.startAt, end: updates.endAt, label: 'Decision Center choice' }] : agenda.scheduledSegments),
    agenda.agendaItemId,
    userId,
    String(tenantId),
  );
  assertDecisionScopedUpdateApplied(agendaUpdate, 'secretary_agenda_decision_update', {
    agendaItemId: agenda.agendaItemId,
    userId,
    tenantId,
  });

  const verified = getSecretaryAgendaItemById({ agendaItemId: agenda.agendaItemId, ownerUserId: userId, tenantId });
  const readBackOk = verified?.lifecycleState === updates.lifecycleState
    && verified.decisionAction === updates.decisionAction
    && (!updates.startAt || verified.startAt === updates.startAt)
    && (!updates.endAt || verified.endAt === updates.endAt);
  if (!readBackOk) {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Secretary reflow read-back verification failed', 409, {
      expectedLifecycleState: updates.lifecycleState,
      actualLifecycleState: verified?.lifecycleState ?? null,
      expectedDecisionAction: updates.decisionAction,
      actualDecisionAction: verified?.decisionAction ?? null,
    });
  }

  return markDecisionActioned(record, actionId, {
    secretaryAgendaItemId: agenda.agendaItemId,
    lifecycleState: verified!.lifecycleState,
    decisionAction: verified!.decisionAction,
    startAt: verified!.startAt,
    endAt: verified!.endAt,
    rollbackAvailable: true,
    rollbackActionId: 'undo_reflow',
    rollback,
  }, 'Secretary agenda decision was applied.');
}

function executeSecretaryReflowRollback(
  record: DecisionRecord,
  userId: number,
  tenantId: number,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  const rollback = record.actionResult?.rollback;
  if (!rollback || typeof rollback !== 'object' || Array.isArray(rollback)) {
    throw new DecisionActionError('DECISION_ROLLBACK_UNAVAILABLE', 'This decision does not have a reversible Secretary reflow.', 409);
  }
  const snapshot = rollback as Record<string, unknown>;
  if (snapshot.type !== 'secretary_agenda_item' || typeof snapshot.agendaItemId !== 'string') {
    throw new DecisionActionError('DECISION_ROLLBACK_UNAVAILABLE', 'This rollback contract is not valid for Secretary reflow.', 409);
  }
  if (snapshot.agendaItemId !== record.relatedEntityId) {
    throw new DecisionActionError('DECISION_ROLLBACK_UNAVAILABLE', 'Rollback target no longer matches the decision related entity.', 409);
  }
  const previous = snapshot.previous;
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    throw new DecisionActionError('DECISION_ROLLBACK_UNAVAILABLE', 'Rollback is missing the prior Secretary state.', 409);
  }
  const prior = previous as Record<string, unknown>;
  const agendaUpdate = getDb().prepare(`
    UPDATE secretary_agenda_items
       SET lifecycle_state = ?,
           decision_action = ?,
           decision_reason_codes_json = ?,
           decision_explanation = ?,
           start_at = ?,
           end_at = ?,
           scheduled_segments_json = ?,
           updated_at = datetime('now')
     WHERE agenda_item_id = ?
       AND owner_user_id = ?
       AND tenant_id = ?
  `).run(
    stringOrDefault(prior.lifecycleState, 'proposed'),
    stringOrNull(prior.decisionAction),
    JSON.stringify(Array.isArray(prior.reasonCodes) ? prior.reasonCodes : []),
    stringOrNull(prior.explanation),
    stringOrNull(prior.startAt),
    stringOrNull(prior.endAt),
    JSON.stringify(Array.isArray(prior.scheduledSegments) ? prior.scheduledSegments : []),
    snapshot.agendaItemId,
    userId,
    String(tenantId),
  );
  assertDecisionScopedUpdateApplied(agendaUpdate, 'secretary_reflow_rollback_agenda_update', {
    agendaItemId: snapshot.agendaItemId,
    userId,
    tenantId,
  });

  const verified = getSecretaryAgendaItemById({ agendaItemId: snapshot.agendaItemId, ownerUserId: userId, tenantId });
  const expectedLifecycleState = stringOrDefault(prior.lifecycleState, 'proposed');
  if (!verified || verified.lifecycleState !== expectedLifecycleState) {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Secretary rollback read-back verification failed', 409, {
      expectedLifecycleState,
      actualLifecycleState: verified?.lifecycleState ?? null,
    });
  }

  const decisionUpdate = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'read', action_result_json = ?
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
  `).run(JSON.stringify({
    actionId: 'undo_reflow',
    rollbackApplied: true,
    secretaryAgendaItemId: snapshot.agendaItemId,
    lifecycleState: verified.lifecycleState,
    decisionAction: verified.decisionAction,
  }), record.itemId, userId, tenantId);
  assertDecisionScopedUpdateApplied(decisionUpdate, 'secretary_reflow_rollback_decision_update', {
    decisionId: record.itemId,
    userId,
    tenantId,
  });
  markDecisionAction(record.decisionLogId, 'undo_reflow');

  return {
    readBackOk: true,
    expectedEffect: { secretaryAgendaLifecycleState: expectedLifecycleState, decisionStatus: 'read' },
    actualEffect: {
      secretaryAgendaItemId: snapshot.agendaItemId,
      lifecycleState: verified.lifecycleState,
      decisionAction: verified.decisionAction,
      decisionStatus: 'read',
    },
    message: 'Secretary reflow was undone and the decision was reopened.',
  };
}

function secretaryAgendaRollbackSnapshot(agenda: SecretaryAgendaItem): Record<string, unknown> {
  return {
    type: 'secretary_agenda_item',
    agendaItemId: agenda.agendaItemId,
    previous: {
      lifecycleState: agenda.lifecycleState,
      decisionAction: agenda.decisionAction,
      reasonCodes: agenda.decisionReasonCodes,
      explanation: agenda.decisionExplanation,
      startAt: agenda.startAt,
      endAt: agenda.endAt,
      scheduledSegments: agenda.scheduledSegments,
    },
  };
}

function buildSecretaryAgendaUpdates(
  actionId: string,
  agenda: SecretaryAgendaItem,
  payload: Record<string, unknown>,
): {
  lifecycleState: string;
  decisionAction: string;
  reasonCodes: string[];
  explanation: string;
  startAt: string | null;
  endAt: string | null;
} {
  if (actionId === 'choose_another_time') {
    const startAt = typeof payload.startAt === 'string' ? payload.startAt : null;
    const endAt = typeof payload.endAt === 'string' ? payload.endAt : null;
    if (!startAt || !endAt || Date.parse(startAt) >= Date.parse(endAt)) {
      throw new DecisionActionError('DECISION_ACTION_PAYLOAD_REQUIRED', 'Choosing another time requires valid startAt and endAt values.', 400);
    }
    return {
      lifecycleState: 'reflowed',
      decisionAction: 'reflowed',
      reasonCodes: ['decision_center_user_selected_alternative_time'],
      explanation: 'User selected an alternate time in Decision Center.',
      startAt,
      endAt,
    };
  }

  if (!agenda.startAt || !agenda.endAt) {
    throw new DecisionActionError('DECISION_ACTION_PAYLOAD_REQUIRED', 'Accepting reflow requires a Secretary agenda item with a proposed time.', 400);
  }
  return {
    lifecycleState: 'reflowed',
    decisionAction: 'reflowed',
    reasonCodes: ['decision_center_user_accepted_reflow'],
    explanation: 'User accepted Secretary reflow in Decision Center.',
    startAt: null,
    endAt: null,
  };
}

function executeFinancePaymentDecision(
  record: DecisionRecord,
  userId: number,
  tenantId: number,
  payload: Record<string, unknown>,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'finance') {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Finance payment action can only run for Finance decisions.', 409);
  }
  const month = typeof payload.month === 'string'
    ? payload.month
    : record.relatedEntityType === 'finance_tax_event'
      ? record.relatedEntityId
      : null;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new DecisionActionError('DECISION_ACTION_PAYLOAD_REQUIRED', 'Finance payment decisions require a YYYY-MM tax event month.', 400);
  }

  if (!markTaxPaid(userId, month, { tenantId })) {
    throw new DecisionActionError('DECISION_RELATED_ENTITY_NOT_FOUND', 'Finance tax event was not found for this user.', 404);
  }
  const year = Number(month.slice(0, 4));
  const verified = getTaxEvents(userId, { year, tenantId }).find((event) => event.month === month);
  if (verified?.status !== 'paid') {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Finance payment read-back verification failed', 409, {
      expectedStatus: 'paid',
      actualStatus: verified?.status ?? null,
    });
  }

  return markDecisionActioned(record, 'mark_paid', {
    financeTaxMonth: month,
    paymentStatus: verified.status,
    paidAt: verified.paid_at,
  }, 'Finance payment was confirmed.');
}

function executeCookingMealDecision(
  record: DecisionRecord,
  userId: number,
  tenantId: number,
  payload: Record<string, unknown>,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  if (record.sourceSkill !== 'cooking') {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Cooking meal action can only run for Cooking decisions.', 409);
  }
  const date = typeof payload.date === 'string' ? payload.date : null;
  const mealType = typeof payload.mealType === 'string' ? payload.mealType : typeof payload.meal_type === 'string' ? payload.meal_type : null;
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !mealType || !title) {
    throw new DecisionActionError('DECISION_ACTION_PAYLOAD_REQUIRED', 'Cooking decisions require date, mealType, and title before Nexus can update the meal plan.', 400);
  }

  const meal = setMealPlan(userId, date, mealType, title, {
    tenantId,
    notes: typeof payload.notes === 'string' ? payload.notes : 'Added from Decision Center',
  });
  const verified = getMealPlan(userId, date, date, tenantId).find((candidate) => candidate.id === meal.id);
  if (!verified || verified.title !== title || verified.meal_type !== mealType) {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Cooking meal read-back verification failed', 409, {
      expectedTitle: title,
      actualTitle: verified?.title ?? null,
    });
  }

  return markDecisionActioned(record, 'add_meal', {
    mealPlanId: verified.id,
    date: verified.date,
    mealType: verified.meal_type,
    title: verified.title,
  }, 'Cooking meal plan was updated.');
}

function executeChatClarificationDecision(
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
  if (record.sourceSkill !== 'chat') {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Chat clarification action can only run for Chat decisions.', 409);
  }
  const pending = getPendingChatConfirmation(userId, tenantId);
  if (!pending || (record.relatedEntityId && pending.id !== record.relatedEntityId)) {
    throw new DecisionActionError('DECISION_RELATED_ENTITY_NOT_FOUND', 'Chat clarification was not found or already expired.', 404);
  }
  clearPendingChatConfirmation(userId, tenantId);
  if (getPendingChatConfirmation(userId, tenantId)) {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Chat clarification read-back verification failed', 409);
  }

  return markDecisionActioned(record, actionId, {
    chatConfirmationId: pending.id,
    selectedOption: actionId,
    involvedSkills: pending.involvedSkills,
  }, 'Chat clarification was recorded.');
}

function markDecisionActioned(
  record: DecisionRecord,
  actionId: string,
  actualEffect: Record<string, unknown>,
  message: string,
): {
  readBackOk: boolean;
  expectedEffect: Record<string, unknown>;
  actualEffect: Record<string, unknown>;
  message: string;
} {
  const decisionUpdate = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'actioned', actioned_at = datetime('now'), action_result_json = ?
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
  `).run(JSON.stringify({ actionId, ...actualEffect }), record.itemId, record.userId, record.tenantId);
  assertDecisionScopedUpdateApplied(decisionUpdate, 'mark_decision_actioned', {
    decisionId: record.itemId,
    userId: record.userId,
    tenantId: record.tenantId,
    actionId,
  });
  markDecisionAction(record.decisionLogId, actionId);
  const actualStatus = getDecisionRecord(record.itemId, record.userId, record.tenantId)?.status ?? null;
  if (actualStatus !== 'actioned') {
    throw new DecisionActionError('DECISION_READBACK_MISMATCH', 'Decision status read-back verification failed', 409, {
      expectedStatus: 'actioned',
      actualStatus,
    });
  }
  return {
    readBackOk: true,
    expectedEffect: { decisionStatus: 'actioned' },
    actualEffect: { decisionStatus: actualStatus, ...actualEffect },
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
  if (record.sourceSkill !== 'content') {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Content approval decision is missing a content object.', 409);
  }
  const contentObjectId = contentWorkflowObjectIdForDecision(record);
  if (!contentObjectId) {
    throw new DecisionActionError('UNSUPPORTED_DECISION_EXECUTOR', 'Content approval decision is missing a content object.', 409);
  }
  const object = getContentWorkflowObject(userId, contentObjectId, tenantId);
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

  const decisionUpdate = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'actioned', actioned_at = datetime('now'), action_result_json = ?
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
  `).run(JSON.stringify({ contentObjectId: object.id, approvalState: verified?.approvalState }), record.itemId, userId, tenantId);
  assertDecisionScopedUpdateApplied(decisionUpdate, 'content_approval_decision_update', {
    decisionId: record.itemId,
    userId,
    tenantId,
    actionId,
  });
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
  const decisionUpdate = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'failed', action_result_json = ?
     WHERE item_id = ? AND user_id = ? AND tenant_id = ? AND status IN ('unread', 'read', 'failed')
  `).run(JSON.stringify({ actionId, errorCode }), record.itemId, record.userId, record.tenantId);
  assertDecisionScopedUpdateApplied(decisionUpdate, 'mark_decision_failed', {
    decisionId: record.itemId,
    userId: record.userId,
    tenantId: record.tenantId,
    actionId,
    errorCode,
  });
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

function sourceStateSupersessionReason(record: DecisionRecord): string | null {
  if (record.sourceSkill === 'content' && recordHasAction(record, CONTENT_APPROVAL_ACTION_IDS)) {
    const contentObjectId = contentWorkflowObjectIdForDecision(record);
    if (!contentObjectId) return 'content_object_missing';
    const object = getContentWorkflowObject(record.userId, contentObjectId, record.tenantId);
    if (!object) return 'content_object_missing';
    if (object.approvalState === 'approved' || object.approvalState === 'rejected') {
      return 'content_approval_resolved_elsewhere';
    }
  }
  if (record.sourceSkill === 'secretary' && recordHasAction(record, SECRETARY_REFLOW_ACTION_IDS)) {
    if (record.relatedEntityType !== 'secretary_agenda_item' || !record.relatedEntityId) {
      return 'secretary_reflow_missing_agenda_item';
    }
    const agenda = getSecretaryAgendaItemById({
      agendaItemId: record.relatedEntityId,
      ownerUserId: record.userId,
      tenantId: record.tenantId,
    });
    if (!agenda) return 'secretary_agenda_missing';
    if (['reflowed', 'scheduled', 'completed', 'canceled', 'superseded'].includes(agenda.lifecycleState)) {
      return 'calendar_conflict_resolved_elsewhere';
    }
  }
  if (record.sourceSkill === 'training') {
    if (record.relatedEntityType === 'training_plan' && tableExists('fitness_training_plans')) {
      const plan = getDb().prepare(`
        SELECT status, updated_at FROM fitness_training_plans
         WHERE id = ? AND user_id = ?
         LIMIT 1
      `).get(record.relatedEntityId, record.userId) as { status?: string; updated_at?: string } | undefined;
      if (!plan) return 'training_plan_missing';
      if (plan.status && ['superseded', 'cancelled', 'canceled', 'completed'].includes(plan.status)) {
        return 'training_plan_changed_elsewhere';
      }
      if (plan.updated_at && Date.parse(plan.updated_at) > Date.parse(record.createdAt)) {
        return 'training_plan_changed_elsewhere';
      }
    }
    if (record.relatedEntityType === 'training_profile' && trainingRaceDatePresent(record.userId)) {
      return 'training_race_date_added_elsewhere';
    }
    if (/race date/i.test(`${record.title} ${record.body} ${record.dedupeKey ?? ''}`) && trainingRaceDatePresent(record.userId)) {
      return 'training_race_date_added_elsewhere';
    }
  }
  return null;
}

function supersedeIfSourceStateStale(record: DecisionRecord): string | null {
  if (!['unread', 'read', 'failed', 'snoozed'].includes(record.status)) return null;
  const reason = sourceStateSupersessionReason(record);
  if (!reason) return null;
  supersedeDecision(record, reason);
  return reason;
}

function supersedeDecision(record: DecisionRecord, reason: string): void {
  const decisionUpdate = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'superseded',
           action_result_json = ?
     WHERE item_id = ?
       AND user_id = ?
       AND tenant_id = ?
       AND status IN ('unread', 'read', 'failed', 'snoozed')
  `).run(JSON.stringify({ supersededReason: reason, supersededAt: DateTime.utc().toISO() }), record.itemId, record.userId, record.tenantId);
  assertDecisionScopedUpdateApplied(decisionUpdate, 'supersede_decision', {
    decisionId: record.itemId,
    userId: record.userId,
    tenantId: record.tenantId,
    reason,
  });
  if (record.decisionLogId) {
    getDb().prepare(`
      UPDATE notification_decision_logs
         SET action_taken = COALESCE(action_taken, 'superseded')
       WHERE decision_log_id = ?
    `).run(record.decisionLogId);
  }
  recordHandledByNexus(record, {
    actionTaken: 'auto_dismiss_stale_decision',
    summary: 'Nexus hid an outdated decision after the source state changed.',
    whyBrief: reason,
    rollbackAvailable: false,
  });
  recordDecisionOutcome(record, {
    actionShown: 'auto_dismiss_stale_decision',
    actionTaken: 'superseded',
    actionSucceeded: true,
    timeToActionMs: timeToActionMs(record),
  });
}

function recordHandledByNexus(record: DecisionRecord, input: {
  actionTaken: string;
  summary: string;
  whyBrief: string;
  rollbackAvailable: boolean;
  changedRuleOption?: string | null;
}): void {
  ensureDecisionCenterTables();
  const logic = decisionLogicForRecord(record);
  getDb().prepare(`
    INSERT INTO handled_by_nexus_items (
      handled_item_id, decision_id, user_id, tenant_id, source_skill, title, summary,
      action_taken, why_brief, related_entities_json, rollback_available, changed_rule_option,
      privacy_classification
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `hbn_${randomUUID()}`,
    record.itemId,
    record.userId,
    record.tenantId,
    record.sourceSkill,
    logic.safePreviewTitle,
    input.summary,
    input.actionTaken,
    input.whyBrief,
    JSON.stringify(record.relatedEntityId && record.relatedEntityType ? [{ type: record.relatedEntityType, id: record.relatedEntityId }] : []),
    input.rollbackAvailable ? 1 : 0,
    input.changedRuleOption ?? null,
    record.privacyPolicy,
  );
}

function recordVerifiedDecisionAction(
  record: DecisionRecord,
  action: NotificationActionButton,
  actionId: string,
  execution: {
    actualEffect: Record<string, unknown>;
    message: string;
  },
): void {
  if (!MUTATING_ACTIONS.has(actionId)) return;
  try {
    recordHandledByNexus(record, {
      actionTaken: actionId,
      summary: execution.message || `${action.label} completed.`,
      whyBrief: 'Nexus applied the approved action and verified the resulting state.',
      rollbackAvailable: execution.actualEffect.rollbackAvailable === true,
      changedRuleOption: stringOrNull(execution.actualEffect.changedRuleOption),
    });
  } catch (err) {
    logger.warn({ err, decisionId: record.itemId, actionId, userId: record.userId, tenantId: record.tenantId }, 'Decision handled history write failed');
  }
}

function mapActionedDecisionToHandledItem(record: DecisionRecord): HandledByNexusItem {
  const logic = decisionLogicForRecord(record);
  const actionTaken = record.decisionLogActionTaken
    ?? stringOrNull(record.actionResult?.actionId)
    ?? 'completed';
  const actionLabel = record.actions.find((action) => action.id === actionTaken)?.label ?? humanizeActionId(actionTaken);
  const outcome = outcomeSummaryForRecord({ ...record, status: 'actioned' }, logic);
  const rollback = rollbackContractForRecord({ ...record, status: 'actioned' });
  return {
    itemId: `actioned_${record.itemId}`,
    userId: record.userId,
    tenantId: record.tenantId,
    sourceSkill: record.sourceSkill,
    title: logic.safePreviewTitle,
    summary: outcome.outcomeSummary ?? `Nexus completed: ${actionLabel}.`,
    actionTaken,
    whyBrief: 'Nexus completed the requested action and read-back verified the result.',
    relatedEntities: record.relatedEntityId && record.relatedEntityType
      ? [{ type: record.relatedEntityType, id: record.relatedEntityId }]
      : [],
    rollbackAvailable: rollback.available,
    changedRuleOption: null,
    createdAt: record.actionedAt ?? record.createdAt,
    privacyClassification: record.privacyPolicy,
  };
}

function humanizeActionId(actionId: string): string {
  return actionId
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Completed';
}

function recordDecisionOutcome(record: DecisionRecord, input: {
  actionShown?: string | null;
  actionTaken?: string | null;
  accepted?: boolean;
  dismissed?: boolean;
  snoozed?: boolean;
  ignored?: boolean;
  askedNexus?: boolean;
  manuallyCorrected?: boolean;
  undoUsed?: boolean;
  timeToActionMs?: number | null;
  actionSucceeded?: boolean;
  partialFailure?: boolean;
  failedReason?: string | null;
}): void {
  ensureDecisionCenterTables();
  const logic = decisionLogicForRecord(record);
  const featureSnapshot = {
    urgency: urgencyForPriority(record.priority, record.decisionDeadline, record.expiresAt),
    deadlineDistance: deadlineDistanceBucket(record.decisionDeadline ?? record.expiresAt),
    riskLevel: logic.riskIfIgnored,
    confidence: logic.confidence,
    sourceSkill: record.sourceSkill,
    decisionType: record.type,
    privacyClassification: record.privacyPolicy,
    relatedEntitiesCount: record.relatedEntityId ? 1 : 0,
    optional: record.priority === 'passive',
    qualityScore: logic.quality.qualityScore,
  };
  getDb().prepare(`
    INSERT INTO decision_outcome_ledger (
      outcome_id, decision_id, user_id, tenant_id, source_skill, type, priority_score,
      confidence, automation_eligibility, action_shown, action_taken, accepted, dismissed,
      snoozed, ignored, asked_nexus, manually_corrected, undo_used, time_to_action_ms,
      action_succeeded, partial_failure, failed_reason, feature_snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `dol_${randomUUID()}`,
    record.itemId,
    record.userId,
    record.tenantId,
    record.sourceSkill,
    record.type,
    priorityScoreFor(record),
    logic.confidence,
    logic.automationEligibility,
    input.actionShown ?? null,
    input.actionTaken ?? null,
    input.accepted ? 1 : 0,
    input.dismissed ? 1 : 0,
    input.snoozed ? 1 : 0,
    input.ignored ? 1 : 0,
    input.askedNexus ? 1 : 0,
    input.manuallyCorrected ? 1 : 0,
    input.undoUsed ? 1 : 0,
    input.timeToActionMs ?? null,
    input.actionSucceeded ? 1 : 0,
    input.partialFailure ? 1 : 0,
    input.failedReason ?? null,
    JSON.stringify(featureSnapshot),
  );
}

function recordDecisionQualityGateEvent(input: NotificationIntentInput, quality: DecisionQualityGateResult): void {
  ensureDecisionCenterTables();
  const genericBlocked = quality.status === 'blocked'
    || quality.status === 'needs_enrichment'
    || quality.reason.toLowerCase().includes('generic')
    || quality.missingFields.some((field) => field.toLowerCase().includes('concrete'));
  getDb().prepare(`
    INSERT INTO decision_quality_gate_events (
      event_id, user_id, tenant_id, source_skill, type, quality_status,
      quality_score, missing_fields_json, reason, generic_blocked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `dqg_${randomUUID()}`,
    input.userId,
    input.tenantId ?? input.userId,
    input.sourceSkill,
    input.type,
    quality.status,
    quality.qualityScore,
    JSON.stringify(quality.missingFields),
    quality.reason,
    genericBlocked ? 1 : 0,
  );
}

function mapHandledByNexusItem(row: any): HandledByNexusItem {
  return {
    itemId: row.handled_item_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    sourceSkill: row.source_skill,
    title: row.title,
    summary: row.summary,
    actionTaken: row.action_taken,
    whyBrief: row.why_brief,
    relatedEntities: safeParseJson(row.related_entities_json, []),
    rollbackAvailable: !!row.rollback_available,
    changedRuleOption: row.changed_rule_option,
    createdAt: row.created_at,
    privacyClassification: row.privacy_classification,
  };
}

function parseDecisionTimestamp(value: string): DateTime {
  const trimmed = value.trim();
  if (!trimmed) return DateTime.invalid('empty decision timestamp');
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const iso = hasExplicitZone ? normalized : `${normalized}Z`;
  const parsed = DateTime.fromISO(iso, { setZone: true });
  if (parsed.isValid) return parsed.toUTC();
  return DateTime.fromSQL(trimmed, { zone: 'utc' });
}

function timestampMillis(value: string): number {
  const parsed = parseDecisionTimestamp(value);
  return parsed.isValid ? parsed.toMillis() : 0;
}

function isTimestampInLocalDay(value: string, timezone: string, now: DateTime): boolean {
  const zone = validateDecisionTimezone(timezone) ?? 'UTC';
  const parsed = parseDecisionTimestamp(value);
  if (!parsed.isValid) return false;
  return parsed.setZone(zone).hasSame(now.setZone(zone), 'day');
}

function timeToActionMs(record: DecisionRecord): number | null {
  const createdMs = Date.parse(record.createdAt);
  if (!Number.isFinite(createdMs)) return null;
  return Math.max(0, Date.now() - createdMs);
}

function deadlineDistanceBucket(deadline: string | null): string {
  if (!deadline) return 'none';
  const delta = Date.parse(deadline) - Date.now();
  if (!Number.isFinite(delta)) return 'unknown';
  if (delta <= 3_600_000) return 'within_1h';
  if (delta <= 24 * 3_600_000) return 'within_24h';
  if (delta <= 7 * 24 * 3_600_000) return 'within_week';
  return 'later';
}

function trainingRaceDatePresent(userId: number): boolean {
  if (!tableExists('user_profiles')) return false;
  const rows = getDb().prepare(`
    SELECT data
      FROM user_profiles
     WHERE user_id = ?
       AND profile_type IN ('fitness', 'training', 'triathlon-running')
  `).all(userId) as Array<{ data: string }>;
  for (const row of rows) {
    const data = safeParseJson<Record<string, unknown>>(row.data, {});
    const targetRaceDate = data.target_race_date ?? data.race_date;
    if (typeof targetRaceDate === 'string' && /\d{4}-\d{2}-\d{2}/.test(targetRaceDate)) return true;
  }
  return false;
}

function tableExists(table: string): boolean {
  const row = getDb().prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'table' AND name = ?
     LIMIT 1
  `).get(table) as { name: string } | undefined;
  return !!row;
}

function recordHasAction(record: DecisionRecord, actionIds: Set<string>): boolean {
  return record.actions.some((action) => actionIds.has(action.id));
}

function contentWorkflowObjectIdForDecision(record: DecisionRecord): string | null {
  if (record.relatedEntityType === 'content_workflow_object' && record.relatedEntityId) {
    return record.relatedEntityId;
  }
  if (record.relatedEntityType !== 'content_notification' || !record.relatedEntityId || !tableExists('content_notifications')) {
    return null;
  }
  const row = getDb().prepare(`
    SELECT data
      FROM content_notifications
     WHERE id = ?
       AND user_id = ?
     LIMIT 1
  `).get(record.relatedEntityId, record.userId) as { data?: string } | undefined;
  const data = safeParseJson<Record<string, unknown>>(row?.data, {});
  return firstWorkflowObjectId(data);
}

function firstWorkflowObjectId(data: Record<string, unknown>): string | null {
  for (const key of ['contentObjectId', 'workflowObjectId', 'objectId', 'draftId', 'ideaId']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function executorSkillForAction(actionId: string, record: DecisionRecord): string {
  if (actionId === 'approve_script' || actionId === 'request_rewrite') return 'content';
  if (record.type === 'conflict_detected' || actionId.includes('reflow')) return 'secretary';
  return record.sourceSkill;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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
