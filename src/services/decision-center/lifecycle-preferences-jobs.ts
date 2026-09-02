// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Physically extracted Decision Center lifecycle preferences jobs implementation.
 * Keep persistence, authorization, and projection behavior in its owning module.
 */

import { createHash, randomUUID } from 'node:crypto';

import { DateTime } from 'luxon';

import { getDb } from '../database';

import { emitDomainEvent } from '../event-outbox';

import { incrementTrainingGenerationCounter } from '../training-generation-observability';

import { trainingOperationLockPublicError } from '../training-operation-locks';

import {
  buildSkillNotificationFixtureIntent,
  createNotificationIntent,
  getNotificationProfileIfExists,
  getOrCreateNotificationProfile,
  getNotificationReliabilityDashboard,
  listNotificationCenterItems,
  markNotificationCenterItemRead,
  updateNotificationProfile,
  NotificationProposalCommitError,
  type NotificationActionButton,
  type NotificationCenterItem,
  type NotificationEvaluationResult,
  type NotificationIntentInput,
  type NotificationIntentType,
  type NotificationPriority,
  type NotificationPrivacyPolicy,
  type NotificationProfile,
  type NotificationSourceSkill,
} from '../notification-orchestrator';

import { listNotificationApnsActionExposures } from '../notification-contracts';

import {
  decideContentWorkspaceReview as decideContentApproval,
  getContentDecisionWorkspaceObject as getContentWorkflowObject,
} from '../content-workspace-decision-adapter';

import {
  getSecretaryAgendaItemById,
  type ReasoningTrailNode,
  type SecretaryAgendaItem,
} from '../secretary-scheduling-arbitrator';

import { secretaryAgendaStateRevision } from '../secretary-agenda-state-revision';

import {
  getMealPlan,
  setMealPlan,
} from '../cooking-chef';

import {
  getTaxEvents,
  markTaxPaid,
} from '../finance-tracker';

import { listTasksForUser } from '../task-store/task-service';

import { priorityToImportance } from '../task-store/task-priority';

import type { NormalizedTask } from '../task-store/types';

import {
  clearPendingChatConfirmation,
  getPendingChatConfirmation,
} from '../chat-pending-confirmations';

import { isValidTenantUserId, recordTenantScopeAnomaly } from '../tenant-scope-observability';

import { logger } from '../../utils/logger';

import { normalizeSupportedLang } from '../../utils/i18n';

import { getDecisionConflictPolicyV1Mode, isDecisionCenterCommandBusEnabled, isDecisionCenterFatigueCapsEnabled, isDecisionCenterGuidanceSkillEnabled, isDecisionCenterGuidanceV1Enabled, isDecisionChoiceOptionsEnabled, isDecisionConflictPolicyV1Enabled, isDecisionEvidenceFreshnessGateEnabled, isDecisionFeedbackSuppressionEnabled, isDecisionFlowV1EnforceEnabled, isDecisionHumanReviewGateEnabled, isDecisionLowRiskAutoResolutionEnabled, isDecisionReconnectAffordanceEnabled, isDecisionRefreshEnabled, isDecisionRollbackSnapshotProtectionEnabled, isDecisionSemanticDedupEnabled, isDecisionSemanticSupersedeEnabled, isDecisionSkillCardsEnabled, isDecisionStreakV1Enabled, isDecisionTypeSuppressionEnabled, isTrainingDecisionFlowV1EnforceEnabled } from '../runtime-flags';

import { buildDecisionConflictSummary, type ConflictEvaluation, type DecisionConflictSummary } from '../decision-conflict-evaluator';

import {
  buildNormalizedDecisionAction,
  logicalActionAttemptHash,
  normalizeDecisionAction,
  type NormalizedDecisionAction,
} from '../decision-action-contract';

import { isLowRiskAutoReflowEligible, revalidateNormalizedDecisionAction } from '../decision-preexecution-revalidator';

import { directOwnedContentObjectForDecision } from '../decision-command-effects';

import {
  contentWorkflowStateRevision,
  cookingMealSlotStateRevision,
  financeTaxEventStateRevision,
} from '../decision-domain-state-revision';

import { decisionRelationshipSemantics, type DecisionRelationshipKind, type DecisionRelationshipType } from '../decision-relationship-types';

import { buildDecisionDedupKey, classifyDecisionDedup } from '../decision-center-semantic-dedup';

import type { SecretaryTodaySummaryModel } from '../secretary-orchestrator';

import { secretaryTodayLabels } from '../secretary-today-copy';

import {
  buildDecisionActionTruthTableEntry,
  isDecisionActionAllowedFromApns,
  isDecisionActionExecutable,
  type DecisionActionTruthTableEntry,
} from '../decision-center-action-truth-table';

import {
  getLearningCase,
  learningReviewApprovalReferenceForExecution,
  recordLearningCaseReviewApproval,
} from '../product-learning';

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
  type SecretaryDecisionAdvice,
  type DecisionVisibilityScope,
  type DecisionWhatWillChange,
  type DecisionWhy,
} from '../decision-center-logic-v2';

import { resolveDecisionDeferUntil } from './defer-time';

import { ensureDecisionCenterTables } from './repository-readiness';

import {
  createDecisionCenterEngineSelector,
  resolveDecisionCenterRewriteMode,
} from './engine-selector';

import {
  evaluateDecisionApnsActionPolicy,
  type DecisionApnsActionPolicyDecision,
  type DecisionApnsExactFetchResult,
} from './apns-action-policy';

import { findDecisionExecutor, hasDecisionExecutor } from './execution-registry';

import { invalidatePlanningAfterVerifiedDecisionSourceMutation } from './planning-cache-invalidation';

import {
  createDecisionMutationCommand,
  type DecisionMutationApproval,
  type DecisionMutationChannel,
  type DecisionMutationCommand,
} from './contracts';

import {
  DECISION_RANK_SNAPSHOT_UNIVERSE_FINGERPRINT,
  materializeDecisionRankSnapshot,
} from './rank-snapshot-service';

import type { DecisionRankSnapshot } from './rank-snapshot-repository';

import {
  DECISION_RANKING_POLICY,
  DECISION_RANKING_VERSION,
  rankDecisionPriority,
  type DecisionPrioritySnapshot,
  type DecisionPriorityTier,
  type DecisionRankingInputs,
} from './ranking-policy';

import {
  actionOutcomeFromRecord,
  applyDecisionFatigueCaps,
  computeActionEffectiveStatus,
  computeActionability,
  computeConfidenceExplanation,
  computeDecisionKind,
  computeEffectiveStatus,
  gateActionabilityForHumanReview,
  gateActionabilityForStaleEvidence,
  isDecisionItemPolicyFloored,
  isHumanReviewQueueAvailable,
  legacyStatusToLifecycle,
  type DecisionFatiguePolicy,
} from './projection-policy';

import { executeDecisionMutationWithReceipt } from './command-receipts';

import {
  DecisionActionError,
  actionsForRecord,
  decisionContextVersion,
  expireTrainingPlanRevisionForDecision,
  guardDecisionLifecycleMutation,
  rollbackContractForRecord,
  sourceStateSupersessionReason,
} from './command-service';
import {
  analysisForRecord,
  decisionLogicForRecord,
  decisionRefreshSupportedForScope,
  executionSummaryForRecord,
  finalizeDecisionExplanation,
  getDecisionItem,
  getDecisionRecord,
  handledDecisionExplanation,
  listDecisionItems,
  mapDecisionRecord,
  materializeDecisionRankSnapshotForScope,
  normalizeDecisionExplanation,
  outcomeSummaryForRecord,
  recommendedAction,
  sourceLabel,
  userDecisionContextDefaults,
  visibilityScopeFromContext,
} from './read-projection-ranking-service';
import {
  DECISION_OUTCOME_LEDGER_RETENTION_POLICY,
  DECISION_TYPES,
  MUTATING_ACTIONS,
  appNowIso,
  assertDecisionScopedUpdateApplied,
  assertScope,
  deadlineDistanceBucket,
  decisionFlowV1EnforcedForRecord,
  decisionHandledHistoryStats,
  isDecisionRecord,
  materializeDecisionPriorityScore,
  priorityScoreFor,
  safeParseJson,
  stringOrNull,
  timeToActionMs,
  urgencyForPriority,
} from './repository';
import {
  DecisionActiveBreakdowns,
  DecisionApiItem,
  DecisionCenterSmokeCleanupResult,
  DecisionExpirySweepResult,
  DecisionExplanation,
  DecisionFeedbackSignal,
  DecisionHandledHistoryBackfillResult,
  DecisionLedgerRetentionPruneResult,
  DecisionLifecycleEvent,
  DecisionLifecycleEventRow,
  DecisionMetricsDailyRow,
  DecisionMetricsLocalDayWindow,
  DecisionOutcomeMetrics,
  DecisionRankSnapshotBackfillResult,
  DecisionRecord,
  DecisionReleaseGateStatus,
  DecisionTypeSuppression,
  DecisionTypeSuppressionMode,
  HandledByNexusItem,
} from './types';



export function runDecisionHandledHistoryBackfillJob(input: {
  userId?: number;
  tenantId?: number;
  limit?: number;
} = {}): DecisionHandledHistoryBackfillResult {
  ensureDecisionCenterTables();
  if (input.tenantId !== undefined && input.userId === undefined) {
    throw new Error('Decision handled-history backfill requires userId when tenantId is scoped.');
  }
  const tenantId = input.userId !== undefined ? input.tenantId ?? input.userId : undefined;
  if (input.userId !== undefined && tenantId !== undefined) {
    assertScope(input.userId, tenantId, 'decision_handled_history_backfill', { limit: input.limit });
  }
  const boundedLimit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const scopeClause = input.userId !== undefined && tenantId !== undefined
    ? 'AND items.user_id = ? AND items.tenant_id = ?'
    : '';
  const params: Array<number | string> = [];
  if (input.userId !== undefined && tenantId !== undefined) {
    params.push(input.userId, tenantId);
  }
  params.push(boundedLimit);
  const rows = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json,
           intents.context_version,
           logs.action_taken AS decision_log_action_taken
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
      LEFT JOIN notification_decision_logs logs ON logs.decision_log_id = items.decision_log_id
      LEFT JOIN handled_by_nexus_items handled
        ON handled.decision_id = items.item_id
       AND handled.user_id = items.user_id
       AND handled.tenant_id = items.tenant_id
     WHERE items.status = 'actioned'
       AND handled.handled_item_id IS NULL
       ${scopeClause}
     ORDER BY COALESCE(items.actioned_at, items.created_at) DESC
     LIMIT ?
  `).all(...params) as any[];

  decisionHandledHistoryStats.backfillRuns += 1;
  const result: DecisionHandledHistoryBackfillResult = {
    inspected: rows.length,
    backfilled: 0,
    skipped: 0,
    failed: 0,
  };
  const existsStmt = getDb().prepare(`
    SELECT handled_item_id
      FROM handled_by_nexus_items
     WHERE decision_id = ?
       AND user_id = ?
       AND tenant_id = ?
     LIMIT 1
  `);
  for (const row of rows) {
    try {
      const record = mapDecisionRecord(row);
      const existing = existsStmt.get(record.itemId, record.userId, record.tenantId);
      if (existing) {
        result.skipped += 1;
        continue;
      }
      const item = mapActionedDecisionToHandledItem(record);
      recordHandledByNexus(record, {
        actionTaken: item.actionTaken,
        summary: item.summary,
        whyBrief: item.whyBrief,
        explanation: item.explanation,
        rollbackAvailable: item.rollbackAvailable,
        changedRuleOption: item.changedRuleOption,
        createdAt: item.createdAt,
      });
      result.backfilled += 1;
      decisionHandledHistoryStats.backfilled += 1;
    } catch (err) {
      result.failed += 1;
      decisionHandledHistoryStats.backfillFailures += 1;
      logger.error({
        err,
        decisionId: typeof row.item_id === 'string' ? row.item_id : null,
        userId: row.user_id,
        tenantId: row.tenant_id,
      }, 'Decision handled history backfill failed');
    }
  }
  return result;
}



export function cleanupDecisionCenterSmokeItems(input: {
  userId: number;
  tenantId?: number;
  dryRun: boolean;
  limit?: number;
}): DecisionCenterSmokeCleanupResult {
  const tenantId = input.tenantId ?? input.userId;
  assertScope(input.userId, tenantId, 'decision_center_smoke_cleanup', { dryRun: input.dryRun, limit: input.limit });
  return runDecisionCenterSmokeCleanup({
    userId: input.userId,
    tenantId,
    dryRun: input.dryRun,
    limit: input.limit,
  });
}



export function runDecisionCenterSmokeCleanupJob(input: {
  olderThanHours?: number;
  limit?: number;
} = {}): DecisionCenterSmokeCleanupResult {
  const olderThanHours = Math.max(input.olderThanHours ?? 24, 1);
  const cutoff = DateTime.utc().minus({ hours: olderThanHours }).toISO()!;
  return runDecisionCenterSmokeCleanup({
    dryRun: false,
    limit: input.limit,
    olderThanIso: cutoff,
  });
}



export function runDecisionCenterSmokeCleanup(input: {
  userId?: number;
  tenantId?: number;
  dryRun: boolean;
  limit?: number;
  olderThanIso?: string;
}): DecisionCenterSmokeCleanupResult {
  ensureDecisionCenterTables();
  const boundedLimit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const clauses = [
    "items.status != 'expired'",
    `(
      items.dedupe_key LIKE 'smoke:decision-center:%'
      OR intents.dedupe_key LIKE 'smoke:decision-center:%'
      OR intents.related_entity_type = 'decision_center_smoke'
      OR lower(items.title) LIKE '%[smoke]%'
      OR lower(items.body) LIKE '%[smoke]%'
      OR lower(intents.title) LIKE '%[smoke]%'
      OR lower(intents.body) LIKE '%[smoke]%'
      OR intents.decision_context_json LIKE '%"smoke":true%'
      OR intents.decision_context_json LIKE '%"internalOnly":true%'
    )`,
  ];
  const params: Array<string | number> = [];
  if (input.userId !== undefined && input.tenantId !== undefined) {
    clauses.push('items.user_id = ?', 'items.tenant_id = ?');
    params.push(input.userId, input.tenantId);
  }
  if (input.olderThanIso) {
    clauses.push('items.created_at <= ?');
    params.push(input.olderThanIso);
  }
  params.push(boundedLimit);
  const rows = getDb().prepare(`
    SELECT items.item_id,
           items.user_id,
           items.tenant_id,
           items.status,
           intents.decision_context_json
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY items.created_at ASC
     LIMIT ?
  `).all(...params) as Array<{ item_id: string; user_id: number; tenant_id: number; status: string; decision_context_json: string | null }>;
  const countsByStatus: Record<string, number> = {};
  const countsByVisibilityScope: Record<string, number> = {};
  for (const row of rows) {
    countsByStatus[row.status] = (countsByStatus[row.status] ?? 0) + 1;
    const context = safeParseJson(row.decision_context_json, {}) as DecisionLogicContext;
    const scope = visibilityScopeFromContext(context) ?? 'unknown';
    countsByVisibilityScope[scope] = (countsByVisibilityScope[scope] ?? 0) + 1;
  }
  if (input.dryRun || rows.length === 0) {
    return { inspected: rows.length, expired: 0, dryRun: input.dryRun, countsByStatus, countsByVisibilityScope };
  }
    const update = getDb().prepare(`
      UPDATE notification_center_items
       SET status = 'expired', decision_state = 'expired',
           record_version = record_version + 1, updated_at = datetime('now')
     WHERE item_id = ?
  `);
  const txn = getDb().transaction((ids: string[]) => {
    for (const id of ids) update.run(id);
  });
  txn(rows.map((row) => row.item_id));
  for (const scope of uniqueDecisionScopes(rows)) {
    materializeDecisionRankSnapshotForScope(scope.userId, scope.tenantId);
  }
  return { inspected: rows.length, expired: rows.length, dryRun: false, countsByStatus, countsByVisibilityScope };
}



export function uniqueDecisionScopes(
  rows: readonly { user_id: number; tenant_id: number }[],
): Array<{ userId: number; tenantId: number }> {
  const scopes = new Map<string, { userId: number; tenantId: number }>();
  for (const row of rows) {
    scopes.set(`${row.tenant_id}:${row.user_id}`, { userId: row.user_id, tenantId: row.tenant_id });
  }
  return [...scopes.values()];
}



/**
 * Statuses that can still surface a decision to the user and therefore must be
 * expired once their deadline passes. Matches the authoritative active set used
 * by listDecisionItems(); 'open' is intentionally excluded (it is not a member
 * of NotificationCenterStatus and never matches a real row).
 */
export const DECISION_EXPIRY_ACTIVE_STATUSES = ['unread', 'read', 'failed', 'snoozed'] as const;



/**
 * Proactively expire decisions whose hard deadline (expires_at) has passed.
 *
 * Decision lists already hide expired items in-memory (isDecisionExpired), so
 * this sweep is hygiene: it flips lingering active rows to 'expired' so DB
 * state, counts, and dedup lookups stay accurate instead of waiting for the
 * reactive flip in guardActionable() when a user taps an already-dead decision.
 *
 * Batched (LIMIT per pass, capped pass count) so a large backlog never runs as
 * a single long transaction. The comparison uses SQLite datetime() on both
 * sides so it is robust to ISO-with-Z vs 'YYYY-MM-DD HH:MM:SS' storage formats.
 * expires_at is expected to carry an explicit zone (the codebase convention,
 * matching the findActiveDuplicate guard in notification-orchestrator); a naive
 * timestamp is read as UTC by datetime(), so writers should store ISO-with-Z.
 */
export function runDecisionExpiryJob(input: { batchSize?: number; maxBatches?: number } = {}): DecisionExpirySweepResult {
  ensureDecisionCenterTables();
  const start = Date.now();
  const batchSize = Math.min(Math.max(input.batchSize ?? 500, 1), 1000);
  const maxBatches = Math.min(Math.max(input.maxBatches ?? 20, 1), 200);
  const db = getDb();
  const statuses = [...DECISION_EXPIRY_ACTIVE_STATUSES];
  const placeholders = statuses.map(() => '?').join(', ');
  const selectExpired = db.prepare(`
    SELECT item_id, user_id, tenant_id
       FROM notification_center_items
     WHERE status IN (${placeholders})
       AND expires_at IS NOT NULL
       AND datetime(expires_at) <= datetime(?)
     ORDER BY expires_at ASC
     LIMIT ?
  `);
  const countExpired = db.prepare(`
    SELECT COUNT(*) AS n
      FROM notification_center_items
     WHERE status IN (${placeholders})
       AND expires_at IS NOT NULL
       AND datetime(expires_at) <= datetime(?)
  `);
  const update = db.prepare("UPDATE notification_center_items SET status = 'expired', decision_state = 'expired', record_version = record_version + 1, updated_at = datetime('now') WHERE item_id = ?");
  const expireBatch = db.transaction((rows: Array<{ item_id: string; user_id: number; tenant_id: number }>) => {
    for (const row of rows) {
      update.run(row.item_id);
      expireTrainingPlanRevisionForDecision(db, row.item_id, row.user_id, row.tenant_id);
    }
  });

  let expired = 0;
  let batches = 0;
  const affectedScopes = new Map<string, { userId: number; tenantId: number }>();
  while (batches < maxBatches) {
    const rows = selectExpired.all(...statuses, appNowIso(), batchSize) as Array<{ item_id: string; user_id: number; tenant_id: number }>;
    if (rows.length === 0) break;
    const ignoredRecords = rows.flatMap((row) => {
      const record = getDecisionRecord(row.item_id, row.user_id, row.tenant_id);
      if (!record) return [];
      const interacted = db.prepare(`
        SELECT 1 FROM decision_lifecycle_events
         WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
           AND event IN ('viewed', 'detail_opened', 'approved', 'rejected', 'deferred',
                         'snoozed', 'dismissed', 'action_started', 'action_succeeded')
         LIMIT 1
      `).get(row.item_id, row.user_id, row.tenant_id);
      return interacted ? [] : [record];
    });
    expireBatch(rows);
    for (const row of rows) {
      affectedScopes.set(`${row.tenant_id}:${row.user_id}`, { userId: row.user_id, tenantId: row.tenant_id });
      resolveDecisionConflictAudit(row.item_id, row.user_id, row.tenant_id, 'expired');
      emitDecisionLifecycleEvent({ decisionId: row.item_id, userId: row.user_id, tenantId: row.tenant_id, event: 'expired', toStatus: 'expired' });
    }
    for (const record of ignoredRecords) {
      recordDecisionOutcome(record, {
        actionShown: recommendedAction(actionsForRecord(record))?.id ?? null,
        ignored: true,
        timeToActionMs: timeToActionMs(record),
      });
    }
    emitUnblockedDependentsForBlockers(
      rows.map((row) => ({ decisionId: row.item_id, userId: row.user_id, tenantId: row.tenant_id })),
      'blocker_expired',
    );
    expired += rows.length;
    batches += 1;
    if (rows.length < batchSize) break;
  }

  for (const scope of affectedScopes.values()) {
    materializeDecisionRankSnapshotForScope(scope.userId, scope.tenantId);
  }

  const remaining = (countExpired.get(...statuses, appNowIso()) as { n: number }).n;
  return { inspected: expired, expired, remaining, batches, durationMs: Date.now() - start };
}



/**
 * Enforce the declared retention horizon for the Decision Center's write-heavy raw telemetry tables by
 * age-pruning rows older than DECISION_OUTCOME_LEDGER_RETENTION_POLICY.rawOutcomeRetentionDays. Without
 * this the policy is only declarative: outcome, quality-gate, conflict-evaluation, and terminal
 * exclusivity rows grow
 * unbounded and getDecisionOutcomeMetrics materializes an ever-larger per-user partition on the request
 * path (the very scan that gates the T14 dashboard at scale).
 *
 * GLOBAL (tenant-agnostic) age-based prune. Batched (LIMIT per pass, capped pass count) so a large
 * backlog never runs as one long transaction. Portable batched DELETE: select a batch of primary keys
 * matching the age predicate, then delete that batch in a transaction (SQLite has no DELETE ... LIMIT by
 * default). The created_at predicate rides the existing (user_id, tenant_id, created_at) indexes; the
 * datetime() comparison is robust to ISO-with-Z vs space-separated storage formats. Table + PK names
 * are compile-time literals (not input), so the dynamic SQL carries no injection surface.
 *
 * These raw tables intentionally share rawOutcomeRetentionDays (same class of raw event; the 730-day
 * aggregateRetentionDays tier is for derived rollups, not these). No VACUUM/ANALYZE is run — a frequent
 * cron must not take SQLite's whole-DB write lock, and freed pages are reused by the steady stream of
 * new inserts, so disk stays flat in steady state without reclaiming on each pass.
 */
export function runDecisionLedgerRetentionPruneJob(
  input: { retentionDays?: number; batchSize?: number; maxBatches?: number } = {},
): DecisionLedgerRetentionPruneResult {
  ensureDecisionCenterTables();
  const start = Date.now();
  const retentionDays = Math.max(input.retentionDays ?? DECISION_OUTCOME_LEDGER_RETENTION_POLICY.rawOutcomeRetentionDays, 1);
  const batchSize = Math.min(Math.max(input.batchSize ?? 500, 1), 1000);
  const maxBatches = Math.min(Math.max(input.maxBatches ?? 50, 1), 500);
  const db = getDb();
  const cutoff = `-${Math.floor(retentionDays)} days`;

  const pruneTable = (
    table: string,
    pkColumn: string,
    extraPredicate = '1 = 1',
  ): { pruned: number; remaining: number; batches: number } => {
    const selectOld = db.prepare(`
      SELECT ${pkColumn} AS id FROM ${table}
       WHERE datetime(created_at) < datetime('now', ?) AND ${extraPredicate}
       ORDER BY created_at ASC
       LIMIT ?
    `);
    const del = db.prepare(`DELETE FROM ${table} WHERE ${pkColumn} = ?`);
    const delBatch = db.transaction((ids: string[]) => {
      for (const id of ids) del.run(id);
    });
    let pruned = 0;
    let batches = 0;
    while (batches < maxBatches) {
      const rows = selectOld.all(cutoff, batchSize) as Array<{ id: string }>;
      if (rows.length === 0) break;
      delBatch(rows.map((row) => row.id));
      pruned += rows.length;
      batches += 1;
      if (rows.length < batchSize) break;
    }
    const remaining = (db.prepare(`
      SELECT COUNT(*) AS n FROM ${table}
       WHERE datetime(created_at) < datetime('now', ?) AND ${extraPredicate}
    `).get(cutoff) as { n: number }).n;
    return { pruned, remaining, batches };
  };

  const outcome = pruneTable('decision_outcome_ledger', 'outcome_id');
  const gate = pruneTable('decision_quality_gate_events', 'event_id');
  const conflicts = pruneTable('decision_conflict_evaluations', 'conflict_evaluation_id');
  // Recovery-held claims (`started` and `partially_failed`) remain durable so
  // retry/reconciliation can never reopen a duplicate side effect.
  const exclusivity = pruneTable(
    'decision_exclusivity_claims',
    'rowid',
    "status IN ('failed', 'expired', 'succeeded')",
  );
  const pruneExpiredRankSnapshots = (): { pruned: number; remaining: number; batches: number } => {
    const selectExpired = db.prepare(`
      SELECT snapshot_id AS id
        FROM decision_center_rank_snapshots
       WHERE datetime(expires_at) <= datetime('now')
       ORDER BY expires_at ASC
       LIMIT ?
    `);
    const deleteEntries = db.prepare(`
      DELETE FROM decision_center_rank_snapshot_entries WHERE snapshot_id = ?
    `);
    const deleteSnapshot = db.prepare(`
      DELETE FROM decision_center_rank_snapshots WHERE snapshot_id = ?
    `);
    const deleteBatch = db.transaction((ids: string[]) => {
      for (const id of ids) {
        deleteEntries.run(id);
        deleteSnapshot.run(id);
      }
    });
    let pruned = 0;
    let batches = 0;
    while (batches < maxBatches) {
      const rows = selectExpired.all(batchSize) as Array<{ id: string }>;
      if (rows.length === 0) break;
      deleteBatch(rows.map((row) => row.id));
      pruned += rows.length;
      batches += 1;
      if (rows.length < batchSize) break;
    }
    const remaining = (db.prepare(`
      SELECT COUNT(*) AS n
        FROM decision_center_rank_snapshots
       WHERE datetime(expires_at) <= datetime('now')
    `).get() as { n: number }).n;
    return { pruned, remaining, batches };
  };
  const rankSnapshots = pruneExpiredRankSnapshots();
  return {
    outcomeLedgerPruned: outcome.pruned,
    qualityGateEventsPruned: gate.pruned,
    conflictEvaluationsPruned: conflicts.pruned,
    terminalExclusivityClaimsPruned: exclusivity.pruned,
    rankSnapshotsPruned: rankSnapshots.pruned,
    outcomeLedgerRemaining: outcome.remaining,
    qualityGateEventsRemaining: gate.remaining,
    conflictEvaluationsRemaining: conflicts.remaining,
    terminalExclusivityClaimsRemaining: exclusivity.remaining,
    rankSnapshotsRemaining: rankSnapshots.remaining,
    batches: outcome.batches + gate.batches + conflicts.batches + exclusivity.batches + rankSnapshots.batches,
    durationMs: Date.now() - start,
  };
}



/**
 * Record a typed dependency edge from `decisionId` to `dependsOnDecisionId`. With the canonical
 * `blocks` relationship the target (`dependsOnDecisionId`) blocks `decisionId`: while the target is
 * unresolved, `decisionId` is reported in `blockedByDecisionIds` and its mutating actions are refused.
 *
 * Directionality matters and only `blocks` prevents action. `blocked_by` is a DISPLAY-ONLY inverse
 * label (kind `inverse_blocked`, blocksAction=false) — writing a `blocked_by` edge blocks NOTHING; to
 * actually block `decisionId`, store a forward `blocks` edge to its blocker as above, never a lone
 * `blocked_by` on the decision itself. Every other type (conflicts_with / duplicate_of / related* /
 * supersedes / caused_by / ...) is advisory (see decisionRelationshipSemantics).
 */
export function addDecisionDependency(input: {
  decisionId: string;
  dependsOnDecisionId: string;
  userId: number;
  tenantId?: number;
  relationship?: DecisionRelationshipType;
  /** Internal proposal assembly owns one final atomic snapshot for the whole transaction. */
  materializeSnapshot?: boolean;
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
  if (input.materializeSnapshot !== false) {
    materializeDecisionRankSnapshotForScope(input.userId, tenantId);
  }
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
  if (opts.userId != null || opts.tenantId != null) {
    const scopedUserId = opts.userId ?? opts.tenantId!;
    assertScope(scopedUserId, opts.tenantId ?? scopedUserId, 'decision_source_state_supersession_job', {});
  }
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
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json,
           intents.context_version
      FROM notification_center_items items
      JOIN notification_intents intents
        ON intents.intent_id = items.intent_id
       AND intents.user_id = items.user_id
       AND intents.tenant_id = items.tenant_id
     WHERE ${clauses.join(' AND ')}
  `).all(...params) as any[];

  const reasons: Record<string, number> = {};
  let supersededCount = 0;
  const affectedScopes = new Map<string, { userId: number; tenantId: number }>();
  for (const row of rows) {
    const record = mapDecisionRecord(row);
    const reason = sourceStateSupersessionReason(record);
    if (!reason) continue;
    supersedeDecision(record, reason);
    affectedScopes.set(`${record.tenantId}:${record.userId}`, { userId: record.userId, tenantId: record.tenantId });
    supersededCount += 1;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }

  if (supersededCount > 0) {
    logger.info({ supersededCount, reasons }, 'Decision Center source-state supersession job closed stale decisions');
  }
  for (const scope of affectedScopes.values()) {
    materializeDecisionRankSnapshotForScope(scope.userId, scope.tenantId);
  }
  return { scannedCount: rows.length, supersededCount, reasons };
}



/**
 * Materialize immutable v2 list universes for pre-rewrite scopes. The query
 * selects only scopes without a current policy-version snapshot, so bounded
 * runs advance instead of repeatedly inspecting the same early users.
 * Per-scope failures are explicit and never prevent healthy scopes in the
 * same scheduler tick from receiving a snapshot.
 */
export function runDecisionRankSnapshotBackfillJob(input: {
  userId?: number;
  tenantId?: number;
  limit?: number;
} = {}): DecisionRankSnapshotBackfillResult {
  ensureDecisionCenterTables();
  if (input.userId != null || input.tenantId != null) {
    const scopedUserId = input.userId ?? input.tenantId!;
    assertScope(scopedUserId, input.tenantId ?? scopedUserId, 'decision_rank_snapshot_backfill', {});
  }
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 100), 1), 500);
  const clauses = [
    'items.user_id > 0',
    'items.tenant_id > 0',
    `NOT EXISTS (
      SELECT 1
        FROM decision_center_rank_snapshots snapshots
       WHERE snapshots.user_id = items.user_id
         AND snapshots.tenant_id = items.tenant_id
         AND snapshots.ranking_version = ?
         AND snapshots.filter_fingerprint = ?
         AND datetime(snapshots.expires_at) > datetime('now')
    )`,
  ];
  const params: unknown[] = [
    DECISION_RANKING_VERSION,
    DECISION_RANK_SNAPSHOT_UNIVERSE_FINGERPRINT,
  ];
  if (input.userId != null) {
    clauses.push('items.user_id = ?');
    params.push(input.userId);
  }
  if (input.tenantId != null) {
    clauses.push('items.tenant_id = ?');
    params.push(input.tenantId);
  }
  params.push(limit);
  const scopes = getDb().prepare(`
    SELECT items.user_id AS userId, items.tenant_id AS tenantId
      FROM notification_center_items items
     WHERE ${clauses.join(' AND ')}
     GROUP BY items.user_id, items.tenant_id
     ORDER BY items.tenant_id ASC, items.user_id ASC
     LIMIT ?
  `).all(...params) as Array<{ userId: number; tenantId: number }>;

  const failures: DecisionRankSnapshotBackfillResult['failures'] = [];
  let materializedScopes = 0;
  for (const scope of scopes) {
    try {
      materializeDecisionRankSnapshotForScope(scope.userId, scope.tenantId);
      materializedScopes += 1;
    } catch (error) {
      const rawName = error instanceof Error ? error.name : typeof error;
      const errorName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rawName) ? rawName : 'UnknownError';
      failures.push({ ...scope, errorName });
      logger.warn({ ...scope, errorName }, 'Decision rank snapshot backfill failed for scope');
    }
  }
  return {
    inspectedScopes: scopes.length,
    materializedScopes,
    failedScopes: failures.length,
    failures,
  };
}



export function supersedeDecisionSourceStateForEntity(input: {
  userId: number;
  tenantId?: number;
  sourceSkill: NotificationSourceSkill;
  relatedEntityType: string;
  relatedEntityId: string;
}): {
  scannedCount: number;
  supersededCount: number;
  reasons: Record<string, number>;
} {
  const tenantId = input.tenantId ?? input.userId;
  assertScope(input.userId, tenantId, 'supersede_decision_source_state_for_entity', {
    sourceSkill: input.sourceSkill,
    relatedEntityType: input.relatedEntityType,
    relatedEntityId: input.relatedEntityId,
  });
  ensureDecisionCenterTables();
  const rows = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json,
           intents.context_version
      FROM notification_center_items items
      JOIN notification_intents intents ON intents.intent_id = items.intent_id
     WHERE items.user_id = ?
       AND items.tenant_id = ?
       AND items.source_skill = ?
       AND intents.related_entity_type = ?
       AND intents.related_entity_id = ?
       AND items.status IN ('unread', 'read', 'failed', 'snoozed')
  `).all(input.userId, tenantId, input.sourceSkill, input.relatedEntityType, input.relatedEntityId) as any[];

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
    logger.info({
      userId: input.userId,
      tenantId,
      sourceSkill: input.sourceSkill,
      relatedEntityType: input.relatedEntityType,
      relatedEntityId: input.relatedEntityId,
      supersededCount,
      reasons,
    }, 'Decision Center targeted source-state supersession closed stale decisions');
    materializeDecisionRankSnapshotForScope(input.userId, tenantId);
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
  const gateStatusRows = getDb().prepare(`
    SELECT quality_status AS status, COUNT(*) AS count
    FROM decision_quality_gate_events
    WHERE user_id = ? AND tenant_id = ?
    GROUP BY quality_status
  `).all(userId, tenantId) as Array<{ status: string; count: number }>;
  const qualityGateByStatus: Record<string, number> = {};
  for (const row of gateStatusRows) qualityGateByStatus[row.status] = Number(row.count ?? 0);
  const bySourceRows = getDb().prepare(`
    SELECT source_skill AS sourceSkill, COUNT(*) AS count
    FROM decision_outcome_ledger
    WHERE user_id = ? AND tenant_id = ?
    GROUP BY source_skill
  `).all(userId, tenantId) as Array<{ sourceSkill: string; count: number }>;
  const totalOutcomes = outcomeRows.length;
  const acceptedCount = outcomeRows.filter((row) => !!row.accepted).length;
  const dismissedCount = outcomeRows.filter((row) => !!row.dismissed).length;
  const isDeferredOutcome = (row: { snoozed: number; actionTaken: string | null }): boolean => {
    return !!row.snoozed || row.actionTaken === 'snooze';
  };
  const snoozedCount = outcomeRows.filter((row) => !!row.snoozed).length;
  const deferredCount = outcomeRows.filter(isDeferredOutcome).length;
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
  const bySourceSkillOutcome: DecisionOutcomeMetrics['bySourceSkillOutcome'] = {};
  for (const row of outcomeRows) {
    const bucket = bySourceSkillOutcome[row.sourceSkill] ?? {
      total: 0,
      accepted: 0,
      dismissed: 0,
      deferred: 0,
    };
    bucket.total += 1;
    if (row.accepted) bucket.accepted += 1;
    if (row.dismissed) bucket.dismissed += 1;
    if (isDeferredOutcome(row)) bucket.deferred += 1;
    bySourceSkillOutcome[row.sourceSkill] = bucket;
  }
  // C4: every quality-gate evaluation (pass and fail) is recorded, so the gate-event
  // count is the true denominator for the rejection rate (no double-counting outcomes).
  const totalDecisionQualityAttempts = Number(gateTotals.totalQualityGateEvents ?? 0);
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
    deferredCount,
    snoozedCount,
    askedNexusCount,
    explanationOpenCount: askedNexusCount,
    genericBlockedCount,
    totalQualityGateEvents: Number(gateTotals.totalQualityGateEvents ?? 0),
    qualityGateByStatus,
    undoUsedCount,
    primaryActionCount,
    failedActionCount,
    partialFailureCount,
    autoHandledCount,
    averageTimeToActionMs: average(timeToActionValues),
    primaryActionRate: rate(primaryActionCount),
    dismissRate: rate(dismissedCount),
    deferRate: rate(deferredCount),
    snoozeRate: rate(snoozedCount),
    explanationOpenRate: rate(askedNexusCount),
    genericBlockedRate: totalDecisionQualityAttempts > 0 ? Number((genericBlockedCount / totalDecisionQualityAttempts).toFixed(4)) : 0,
    failedActionRate: rate(failedActionCount),
    partialFailureRate: rate(partialFailureCount),
    bySourceSkill,
    bySourceSkillOutcome,
  };
}



export function getDecisionPreferences(userId: number, tenantId = userId): Record<string, unknown> {
  assertScope(userId, tenantId, 'get_decision_preferences');
  ensureDecisionCenterTables();
  const profile = getNotificationProfileIfExists(userId, tenantId) ?? defaultDecisionNotificationProfile(userId, tenantId);
  const flow = getDb().prepare(`
    SELECT allow_low_risk_auto_reflow AS allowLowRiskAutoReflow
      FROM decision_flow_preferences
     WHERE user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(userId, tenantId) as { allowLowRiskAutoReflow: number } | undefined;
  return {
    profile,
    decisionPreferences: {
      homePreviewMode: 'urgent_and_today',
      autoHideResolved: true,
      askBeforeScheduleChanges: true,
      askBeforeContentPublishing: true,
      askBeforeTrainingReflow: true,
      pushEnabled: profile.pushEnabled,
      urgentDecisionPushEnabled: profile.allowTimeSensitive,
      timeSensitiveAllowed: profile.allowTimeSensitive,
      backgroundRefreshPushEnabled: profile.pushEnabled,
      allowLowRiskAutoReflow: flow?.allowLowRiskAutoReflow === 1,
    },
  };
}



export function defaultDecisionNotificationProfile(userId: number, tenantId: number): NotificationProfile {
  const now = appNowIso();
  return {
    userId,
    tenantId,
    quietHours: { start: '22:00', end: '07:00' },
    timezone: userDecisionContextDefaults(userId).timezone || 'UTC',
    pushEnabled: true,
    // Promotional consent defaults OFF even in the read-side fallback, so a
    // missing profile row can never be read as marketing consent.
    marketingPushEnabled: false,
    localEnabled: true,
    emailEnabled: false,
    portalEnabled: true,
    inAppEnabled: true,
    skillPreferences: {
      secretary: true,
      training: true,
      content: true,
      cooking: true,
      finance: true,
      chat: true,
      system: true,
      security: true,
    },
    defaultReminderMinutes: 30,
    workoutReminderMinutes: 60,
    contentReminderMinutes: 120,
    financeReminderDays: 1,
    allowTimeSensitive: true,
    allowCritical: false,
    digestPassiveItems: true,
    dailyDigestTime: '08:30',
    weeklyReviewDay: 1,
    weeklyReviewTime: '09:00',
    morningBriefingTime: null,
    coachBriefingTime: null,
    endOfDayTime: null,
    weeklyReviewReportDay: null,
    weeklyReviewReportTime: null,
    doNotNotifyRules: [],
    updatedAt: now,
    createdAt: now,
  };
}



export function updateDecisionPreferences(userId: number, tenantId: number, patch: Record<string, unknown>): Record<string, unknown> {
  assertScope(userId, tenantId, 'update_decision_preferences');
  ensureDecisionCenterTables();
  const { allowLowRiskAutoReflow, ...profilePatch } = patch;
  if (allowLowRiskAutoReflow !== undefined && typeof allowLowRiskAutoReflow !== 'boolean') {
    throw new DecisionActionError('VALIDATION', 'allowLowRiskAutoReflow must be a boolean', 400);
  }
  if (typeof allowLowRiskAutoReflow === 'boolean') {
    getDb().prepare(`
      INSERT INTO decision_flow_preferences
        (user_id, tenant_id, allow_low_risk_auto_reflow, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, tenant_id) DO UPDATE SET
        allow_low_risk_auto_reflow = excluded.allow_low_risk_auto_reflow,
        updated_at = excluded.updated_at
    `).run(userId, tenantId, allowLowRiskAutoReflow ? 1 : 0);
  }
  if (Object.keys(profilePatch).length > 0) updateNotificationProfile(userId, tenantId, profilePatch);
  else getOrCreateNotificationProfile(userId, tenantId);
  const preferences = getDecisionPreferences(userId, tenantId);
  materializeDecisionRankSnapshotForScope(userId, tenantId);
  return preferences;
}



export let decisionLifecycleEventWriteFailures = 0;



/** Returns how many lifecycle-event writes have been swallowed (observability for the kill-switch path). */
export function getDecisionLifecycleEventWriteFailures(): number {
  return decisionLifecycleEventWriteFailures;
}



/** Initial proposal lifecycle entry is part of proposal commit, not telemetry. */
export function persistDecisionCreatedLifecycleEventStrict(
  decisionId: string,
  userId: number,
  tenantId: number,
  toStatus: string,
): void {
  if (resolveDecisionCenterRewriteMode(process.env) === 'legacy'
      && process.env.DECISION_LIFECYCLE_EVENTS_ENABLED === '0') return;
  getDb().prepare(`
    INSERT INTO decision_lifecycle_events
      (event_id, decision_id, user_id, tenant_id, event, to_status, action_id, reason, metadata_json)
    VALUES (?, ?, ?, ?, 'created', ?, NULL, NULL, '{}')
  `).run(`dle_${randomUUID()}`, decisionId, userId, tenantId, toStatus);
}



/**
 * Append a lifecycle event. Fire-and-forget: guarded by a kill-switch
 * (DECISION_LIFECYCLE_EVENTS_ENABLED=0) and a try/catch so a write failure can NEVER break the
 * user action it accompanies (mirrors the recordVerifiedDecisionAction write-failure pattern).
 */
export function emitDecisionLifecycleEvent(input: {
  decisionId: string;
  userId: number;
  tenantId: number;
  event: DecisionLifecycleEvent;
  toStatus?: string | null;
  actionId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}): void {
  if (process.env.DECISION_LIFECYCLE_EVENTS_ENABLED === '0') return;
  try {
    getDb().prepare(`
      INSERT INTO decision_lifecycle_events
        (event_id, decision_id, user_id, tenant_id, event, to_status, action_id, reason, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `dle_${randomUUID()}`,
      input.decisionId,
      input.userId,
      input.tenantId,
      input.event,
      input.toStatus ?? null,
      input.actionId ?? null,
      input.reason ?? null,
      JSON.stringify(input.metadata ?? {}),
    );
  } catch (err) {
    decisionLifecycleEventWriteFailures += 1;
    logger.warn({ err, decisionId: input.decisionId, event: input.event }, 'Decision lifecycle event write failed (non-fatal)');
  }
}



export function emitUnblockedDependentsForBlockers(
  blockers: Array<{ decisionId: string; userId: number; tenantId: number }>,
  reason: string,
): void {
  if (process.env.DECISION_LIFECYCLE_EVENTS_ENABLED === '0' || blockers.length === 0) return;
  try {
    const db = getDb();
    const blockerIds = [...new Set(blockers.map((blocker) => blocker.decisionId))];
    const placeholders = blockerIds.map(() => '?').join(', ');
    const activeStatuses = [...DECISION_EXPIRY_ACTIVE_STATUSES];
    const activePlaceholders = activeStatuses.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT deps.decision_id,
             deps.depends_on_decision_id,
             deps.user_id,
             deps.tenant_id,
             dependent.status AS dependent_status
        FROM decision_dependencies deps
        JOIN notification_center_items dependent
          ON dependent.item_id = deps.decision_id
         AND dependent.user_id = deps.user_id
         AND dependent.tenant_id = deps.tenant_id
       WHERE deps.depends_on_decision_id IN (${placeholders})
         AND deps.relationship = 'blocks'
         AND dependent.status IN (${activePlaceholders})
    `).all(...blockerIds, ...activeStatuses) as Array<{
      decision_id: string;
      depends_on_decision_id: string;
      user_id: number;
      tenant_id: number;
      dependent_status: string;
    }>;
    const grouped = new Map<string, {
      decisionId: string;
      userId: number;
      tenantId: number;
      blockerDecisionIds: Set<string>;
      status: string;
    }>();
    for (const row of rows) {
      const key = `${row.user_id}:${row.tenant_id}:${row.decision_id}`;
      let group = grouped.get(key);
      if (!group) {
        group = {
          decisionId: row.decision_id,
          userId: row.user_id,
          tenantId: row.tenant_id,
          blockerDecisionIds: new Set(),
          status: row.dependent_status,
        };
        grouped.set(key, group);
      }
      group.blockerDecisionIds.add(row.depends_on_decision_id);
    }
    const unresolved = db.prepare(`
      SELECT COUNT(*) AS n
        FROM decision_dependencies deps
        JOIN notification_center_items blocker
          ON blocker.item_id = deps.depends_on_decision_id
         AND blocker.user_id = deps.user_id
         AND blocker.tenant_id = deps.tenant_id
       WHERE deps.decision_id = ?
         AND deps.user_id = ?
         AND deps.tenant_id = ?
         AND deps.relationship = 'blocks'
         AND blocker.status IN (${activePlaceholders})
    `);
    for (const group of grouped.values()) {
      const remaining = unresolved.get(group.decisionId, group.userId, group.tenantId, ...activeStatuses) as { n: number };
      if ((remaining?.n ?? 0) > 0) continue;
      emitDecisionLifecycleEvent({
        decisionId: group.decisionId,
        userId: group.userId,
        tenantId: group.tenantId,
        event: 'unblocked',
        toStatus: group.status,
        reason,
        metadata: {
          blockerDecisionIds: [...group.blockerDecisionIds].sort(),
        },
      });
    }
  } catch (err) {
    decisionLifecycleEventWriteFailures += 1;
    logger.warn({ err, reason }, 'Decision dependency unblocked lifecycle check failed (non-fatal)');
  }
}



export function shouldEmitSurfaced(record: DecisionRecord): boolean {
  return ['unread', 'read', 'failed', 'snoozed'].includes(record.status);
}



export function recordDecisionExposure(record: DecisionRecord, item: DecisionApiItem): void {
  emitDecisionSurfacedIfFirst(record);
  emitDecisionActionPreviewedForVisibleActions(record, item);
}



export function recordDecisionItemExposures(items: DecisionApiItem[]): void {
  for (const item of items) {
    const record = getDecisionRecord(item.decisionId, item.userId, item.tenantId);
    if (!record || !isDecisionRecord(record)) continue;
    materializeDecisionPriorityScore(record, item.priorityScore);
    recordDecisionExposure(record, item);
  }
}



/**
 * Explicit write-side exposure recorder used by clients when a card actually
 * becomes visible. Decision Center GET routes intentionally remain pure.
 * Unknown, expired, filtered, or cross-scope IDs are ignored and never reveal
 * whether another tenant owns a row.
 */
export function recordDecisionItemExposuresByIds(
  decisionIds: string[],
  userId: number,
  tenantId = userId,
): { recordedCount: number } {
  assertScope(userId, tenantId, 'record_decision_item_exposures');
  const uniqueIds = [...new Set(decisionIds.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
  const items = uniqueIds
    .map((decisionId) => getDecisionItem(decisionId, userId, tenantId, { recordExposure: false }))
    .filter((item): item is DecisionApiItem => item !== null);
  recordDecisionItemExposures(items);
  return { recordedCount: items.length };
}



export function emitDecisionSurfacedIfFirst(record: DecisionRecord): void {
  if (!shouldEmitSurfaced(record)) return;
  if (process.env.DECISION_LIFECYCLE_EVENTS_ENABLED === '0') return;
  try {
    const existing = getDb().prepare(`
      SELECT 1
        FROM decision_lifecycle_events
       WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND event = 'surfaced'
       LIMIT 1
    `).get(record.itemId, record.userId, record.tenantId);
    if (existing) return;
    emitDecisionLifecycleEvent({
      decisionId: record.itemId,
      userId: record.userId,
      tenantId: record.tenantId,
      event: 'surfaced',
      toStatus: record.status,
    });
  } catch (err) {
    decisionLifecycleEventWriteFailures += 1;
    logger.warn({ err, decisionId: record.itemId }, 'Decision surfaced lifecycle check failed (non-fatal)');
  }
}



export function previewableActionIdsForItem(item: DecisionApiItem): string[] {
  const enabled = new Set(
    (item.actionEffectiveStatuses ?? [])
      .filter((status) => status.effective === 'enabled')
      .map((status) => status.actionId),
  );
  const candidates = [
    item.recommendedAction?.id,
    ...item.alternativeActions.map((action) => action.id),
  ];
  return [...new Set(candidates.filter((actionId): actionId is string => !!actionId && enabled.has(actionId)))];
}



export function emitDecisionActionPreviewedForVisibleActions(record: DecisionRecord, item: DecisionApiItem): void {
  if (!shouldEmitSurfaced(record)) return;
  for (const actionId of previewableActionIdsForItem(item)) {
    emitDecisionActionPreviewedIfFirst(record, actionId);
  }
}



export function emitDecisionActionPreviewedIfFirst(record: DecisionRecord, actionId: string): void {
  if (process.env.DECISION_LIFECYCLE_EVENTS_ENABLED === '0') return;
  try {
    const existing = getDb().prepare(`
      SELECT 1
        FROM decision_lifecycle_events
       WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND event = 'action_previewed' AND action_id = ?
       LIMIT 1
    `).get(record.itemId, record.userId, record.tenantId, actionId);
    if (existing) return;
    emitDecisionLifecycleEvent({
      decisionId: record.itemId,
      userId: record.userId,
      tenantId: record.tenantId,
      event: 'action_previewed',
      actionId,
      toStatus: record.status,
    });
  } catch (err) {
    decisionLifecycleEventWriteFailures += 1;
    logger.warn({ err, decisionId: record.itemId, actionId }, 'Decision action-preview lifecycle check failed (non-fatal)');
  }
}



/** Read the ordered lifecycle event stream for a decision (tests + observability). */
export function getDecisionLifecycleEvents(decisionId: string, userId: number, tenantId = userId): DecisionLifecycleEventRow[] {
  assertScope(userId, tenantId, 'decision_lifecycle_events', { decisionId });
  ensureDecisionCenterTables();
  return getDb().prepare(`
    SELECT event, to_status AS toStatus, action_id AS actionId, reason,
           metadata_json AS metadataJson, created_at AS createdAt
      FROM decision_lifecycle_events
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
     ORDER BY rowid ASC
  `).all(decisionId, userId, tenantId).map((row: any) => ({
    event: row.event,
    toStatus: row.toStatus ?? null,
    actionId: row.actionId ?? null,
    reason: row.reason ?? null,
    createdAt: row.createdAt,
    metadata: safeParseJson(row.metadataJson, {}),
  })) as DecisionLifecycleEventRow[];
}



export function getDecisionAuditHistory(decisionId: string, userId: number, tenantId = userId): {
  events: DecisionLifecycleEventRow[];
  conflicts: Array<Record<string, unknown>>;
  executions: Array<Record<string, unknown>>;
} {
  assertScope(userId, tenantId, 'decision_audit_history', { decisionId });
  ensureDecisionCenterTables();
  const exists = getDb().prepare(`
    SELECT 1 FROM notification_center_items
     WHERE item_id = ? AND user_id = ? AND tenant_id = ? LIMIT 1
  `).get(decisionId, userId, tenantId);
  if (!exists) throw new DecisionActionError('DECISION_NOT_FOUND', 'Decision not found', 404);
  const conflicts = getDb().prepare(`
    SELECT policy_version AS policyVersion, context_version AS contextVersion,
           disposition, hard_conflict_count AS hardConflictCount,
           soft_conflict_count AS softConflictCount, reason_codes_json AS reasonCodesJson,
           related_decision_ids_json AS relatedDecisionIdsJson,
           precedence_trace_json AS precedenceTraceJson, winner_decision_id AS winnerDecisionId,
           resolution, automatically_resolved AS automaticallyResolved,
           created_at AS createdAt, resolved_at AS resolvedAt
      FROM decision_conflict_evaluations
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
     ORDER BY created_at ASC
  `).all(decisionId, userId, tenantId).map((row: any) => ({
    policyVersion: row.policyVersion,
    contextVersion: row.contextVersion,
    disposition: row.disposition,
    hardConflictCount: row.hardConflictCount,
    softConflictCount: row.softConflictCount,
    reasonCodes: safeParseJson(row.reasonCodesJson, []),
    relatedDecisionIds: safeParseJson(row.relatedDecisionIdsJson, []),
    precedenceTrace: safeParseJson(row.precedenceTraceJson, []),
    winnerDecisionId: row.winnerDecisionId ?? null,
    resolution: row.resolution ?? null,
    automaticallyResolved: !!row.automaticallyResolved,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? null,
  }));
  const executions = getDb().prepare(`
    SELECT action_execution_id AS attemptId, action_id AS actionId, status,
           effect_results_json AS effectResultsJson, recovery_json AS recoveryJson,
           error_code AS errorCode, created_at AS createdAt,
           completed_at AS completedAt, failed_at AS failedAt
      FROM decision_action_executions
     WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
     ORDER BY created_at ASC
  `).all(decisionId, userId, tenantId).map((row: any) => ({
    attemptId: row.attemptId,
    actionId: row.actionId,
    status: row.status,
    effectResults: safeParseJson(row.effectResultsJson, []),
    recovery: safeParseJson(row.recoveryJson, {}),
    errorCode: row.errorCode ?? null,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? null,
    failedAt: row.failedAt ?? null,
  }));
  return { events: getDecisionLifecycleEvents(decisionId, userId, tenantId), conflicts, executions };
}



export function resolveDecisionConflictAudit(
  decisionId: string,
  userId: number,
  tenantId: number,
  resolution: string,
  automaticallyResolved = false,
  options: { strict?: boolean } = {},
): void {
  try {
    getDb().prepare(`
      UPDATE decision_conflict_evaluations
         SET resolution = ?, automatically_resolved = CASE WHEN ? THEN 1 ELSE automatically_resolved END,
             resolved_at = COALESCE(resolved_at, datetime('now'))
       WHERE decision_id = ? AND user_id = ? AND tenant_id = ? AND resolved_at IS NULL
    `).run(resolution, automaticallyResolved ? 1 : 0, decisionId, userId, tenantId);
    logger.info({ event: 'decision.conflict_resolved', decisionId, resolution, automaticallyResolved }, 'Decision conflict resolved');
  } catch (err) {
    logger.warn({ err, decisionId, resolution }, 'Decision conflict resolution audit failed');
    if (options.strict) throw err;
  }
}



export function recordDecisionConflictEvaluation(
  record: Pick<DecisionRecord, 'itemId' | 'userId' | 'tenantId'>,
  conflict: ConflictEvaluation,
): void {
  try {
    const relatedDecisionIds = [...new Set(conflict.findings
      .map((finding) => finding.conflictingDecisionId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0))].sort();
    getDb().prepare(`
      INSERT INTO decision_conflict_evaluations (
        conflict_evaluation_id, decision_id, user_id, tenant_id, policy_version,
        context_version, disposition, hard_conflict_count, soft_conflict_count,
        reason_codes_json, related_decision_ids_json, precedence_trace_json,
        winner_decision_id, automatically_resolved
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `dce_${randomUUID()}`,
      record.itemId,
      record.userId,
      record.tenantId,
      conflict.policyVersion,
      conflict.contextVersion,
      conflict.disposition,
      conflict.findings.filter((finding) => finding.severity === 'hard').length,
      conflict.findings.filter((finding) => finding.severity === 'soft').length,
      JSON.stringify([...new Set(conflict.reasonCodes)].sort()),
      JSON.stringify(relatedDecisionIds),
      JSON.stringify(conflict.precedenceTrace ?? []),
      conflict.winnerDecisionId ?? null,
      conflict.autoResolved ? 1 : 0,
    );
    logger.info({
      event: 'decision.conflict_evaluated',
      decisionId: record.itemId,
      userId: record.userId,
      tenantId: record.tenantId,
      disposition: conflict.disposition,
      hardConflictCount: conflict.findings.filter((finding) => finding.severity === 'hard').length,
      softConflictCount: conflict.findings.filter((finding) => finding.severity === 'soft').length,
    }, 'Decision conflict evaluation recorded');
  } catch (err) {
    logger.warn({ err, decisionId: record.itemId }, 'Decision conflict evaluation audit failed');
  }
}



/**
 * Aggregate one local calendar day's lifecycle and quality-gate events into
 * tenant-total rows. UTC bounds are derived from the IANA timezone, so 23/25
 * hour DST days and cross-midnight users are counted correctly.
 */
export function runDecisionMetricsRollupJob(input: {
  date?: string;
  userId?: number;
  tenantId?: number;
  timezone?: string;
  now?: Date;
} = {}): { date: string; tenants: number } {
  ensureDecisionCenterTables();
  const db = getDb();
  const scoped = input.userId != null || input.tenantId != null;
  if (scoped && (input.userId == null || input.tenantId == null)) {
    throw new DecisionActionError('INVALID_SCOPE', 'Metrics rollup requires both userId and tenantId.', 400);
  }
  if (scoped) assertScope(input.userId!, input.tenantId!, 'decision_metrics_rollup');
  const timezone = input.timezone
    ?? (input.userId != null ? userDecisionContextDefaults(input.userId).timezone : null)
    ?? 'UTC';
  const window = decisionMetricsLocalDayWindow({ date: input.date, timezone, now: input.now });
  const scopeClause = scoped ? ' AND user_id = ? AND tenant_id = ?' : '';
  const scopeParams = scoped ? [input.userId!, input.tenantId!] : [];
  const eventRows = db.prepare(`
    SELECT tenant_id AS tenantId, event, COUNT(*) AS n
      FROM decision_lifecycle_events
     WHERE datetime(created_at) >= datetime(?)
       AND datetime(created_at) < datetime(?)
       ${scopeClause}
     GROUP BY tenant_id, event
  `).all(window.startUtc, window.endUtc, ...scopeParams) as Array<{ tenantId: number; event: string; n: number }>;
  const gateRows = db.prepare(`
    SELECT tenant_id AS tenantId, COUNT(*) AS n
      FROM decision_quality_gate_events
     WHERE datetime(created_at) >= datetime(?)
       AND datetime(created_at) < datetime(?)
       AND generic_blocked = 1
       ${scopeClause}
     GROUP BY tenant_id
  `).all(window.startUtc, window.endUtc, ...scopeParams) as Array<{ tenantId: number; n: number }>;

  const byTenant = new Map<number, Record<string, number>>();
  const bucket = (tenantId: number): Record<string, number> => {
    let row = byTenant.get(tenantId);
    if (!row) { row = {}; byTenant.set(tenantId, row); }
    return row;
  };
  if (scoped) bucket(input.tenantId!);
  for (const row of eventRows) bucket(row.tenantId)[row.event] = row.n;
  for (const row of gateRows) bucket(row.tenantId).gate_blocked = row.n;

  // The legacy aggregate table has no user_id column. Keep tenant aggregates
  // on the historical `*` key, but namespace a scoped rollup by user so two
  // accounts in one tenant cannot overwrite each other's local calendar day.
  // The additive migration replaces this compatibility encoding with an
  // explicit user_id after the required Cooking rebase.
  const storageSourceSkill = scoped ? `@user:${input.userId}:*` : '*';
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO decision_metrics_daily
      (metric_date, tenant_id, source_skill, created_count, surfaced_count, viewed_count,
       dismissed_count, snoozed_count, action_succeeded_count, action_failed_count,
       expired_count, gate_blocked_count, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const writeAll = db.transaction(() => {
    for (const [tenantId, c] of byTenant) {
      upsert.run(
        window.localDate, tenantId, storageSourceSkill,
        c.created ?? 0, c.surfaced ?? 0, c.viewed ?? 0, c.dismissed ?? 0, c.snoozed ?? 0,
        c.action_succeeded ?? 0, c.action_failed ?? 0, c.expired ?? 0, c.gate_blocked ?? 0,
      );
    }
  });
  writeAll();
  return { date: window.localDate, tenants: byTenant.size };
}



export function decisionMetricsLocalDayWindow(input: {
  date?: string;
  timezone: string;
  now?: Date;
}): DecisionMetricsLocalDayWindow {
  const timezone = input.timezone?.trim();
  if (!timezone || !DateTime.now().setZone(timezone).isValid) {
    throw new DecisionActionError('VALIDATION', 'Metrics timezone must be a valid IANA timezone.', 400);
  }
  if (input.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new DecisionActionError('VALIDATION', 'Metrics date must use YYYY-MM-DD.', 400);
  }
  const base = input.date
    ? DateTime.fromISO(input.date, { zone: timezone })
    : DateTime.fromJSDate(input.now ?? new Date(), { zone: timezone });
  if (!base.isValid || (input.date != null && base.toISODate() !== input.date)) {
    throw new DecisionActionError('VALIDATION', 'Metrics date is invalid.', 400);
  }
  const start = base.startOf('day');
  const end = start.plus({ days: 1 });
  return Object.freeze({
    localDate: start.toISODate()!,
    timezone,
    startUtc: start.toUTC().toISO()!,
    endUtc: end.toUTC().toISO()!,
  });
}



/** Read one tenant's pre-aggregated local-day row. */
export function getDecisionMetricsDaily(tenantId: number, opts: {
  date?: string;
  userId?: number;
  timezone?: string;
  now?: Date;
} = {}): DecisionMetricsDailyRow | null {
  ensureDecisionCenterTables();
  const timezone = opts.timezone
    ?? (opts.userId != null ? userDecisionContextDefaults(opts.userId).timezone : null)
    ?? 'UTC';
  const date = decisionMetricsLocalDayWindow({ date: opts.date, timezone, now: opts.now }).localDate;
  const storageSourceSkill = opts.userId != null ? `@user:${opts.userId}:*` : '*';
  const row = getDb().prepare(`
    SELECT metric_date AS metricDate, tenant_id AS tenantId, source_skill AS sourceSkill,
           created_count AS createdCount, surfaced_count AS surfacedCount, viewed_count AS viewedCount,
           dismissed_count AS dismissedCount, snoozed_count AS snoozedCount,
           action_succeeded_count AS actionSucceededCount, action_failed_count AS actionFailedCount,
           expired_count AS expiredCount, gate_blocked_count AS gateBlockedCount, computed_at AS computedAt
      FROM decision_metrics_daily
     WHERE metric_date = ? AND tenant_id = ? AND source_skill = ?
  `).get(date, tenantId, storageSourceSkill) as DecisionMetricsDailyRow | undefined;
  return row ? { ...row, sourceSkill: '*' } : null;
}



/**
 * Release-gate invariants for the Decision Center (per the plan's "expired-visible = 0 /
 * unimplemented-primary-CTA = 0"). expiredButVisible measures sweep health (SQL sees unswept rows
 * the in-memory list filter hides); unimplementedActionableCtas is a tripwire — computeActionability
 * downgrades not-implemented primaries to read_only, so this is 0 unless that invariant regresses.
 */
export function getDecisionReleaseGateStatus(
  userId: number,
  tenantId = userId,
  badgeBaseline: { expectedBadgeCount?: number; canonicalUnreadCount?: number } = {},
): DecisionReleaseGateStatus {
  assertScope(userId, tenantId, 'decision_release_gate_status', {});
  ensureDecisionCenterTables();
  const expiredButVisible = (getDb().prepare(`
    SELECT COUNT(*) AS n
      FROM notification_center_items
     WHERE user_id = ? AND tenant_id = ?
       AND status IN ('unread', 'read', 'failed', 'snoozed')
       AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime(?)
  `).get(userId, tenantId, appNowIso()) as { n: number }).n;

  const items = listDecisionItems(userId, tenantId, { status: 'all', limit: 200, recordExposure: false });
  const unimplementedActionableCtas = items.filter((item) => {
    const actionable = item.actionability != null && !['read_only', 'blocked', 'unavailable'].includes(item.actionability);
    const primary = item.recommendedAction;
    return Boolean(actionable && primary && !isDecisionActionExecutable(primary.id));
  }).length;
  // The client badge represents the unified inbox, while Decision Center can
  // synchronously count only its own notification_center_items. A caller that
  // has already built the unified inbox summary may supply that contract-
  // aligned baseline; otherwise badge health is deliberately not evaluated by
  // this synchronous gate. The notifications reliability HTTP route remains
  // the authoritative unified-badge check.
  const hasContractAlignedBadgeBaseline = Number.isInteger(badgeBaseline.expectedBadgeCount);
  const notificationReliability = getNotificationReliabilityDashboard(
    userId,
    tenantId,
    hasContractAlignedBadgeBaseline ? badgeBaseline : {},
  );
  const unsupportedNotificationActions = notificationReliability.quality.unsupportedActionBlockedCount;
  const deadDeeplinks = notificationReliability.quality.deadDeeplinkCount;
  const badgeDrift = hasContractAlignedBadgeBaseline
    ? notificationReliability.badge.drift
    : null;
  const genericMutatingActionSuccesses = notificationReliability.quality.genericMutatingActionSuccessCount;
  const apnsMutatingActionsExposed = listNotificationApnsActionExposures()
    .filter((entry) => !isDecisionActionAllowedFromApns(entry.actionId))
    .length;
  const staleSourceVisibleInInbox = countStaleSourceVisibleInInbox(userId, tenantId);
  const deliveryAttemptHealth = getDb().prepare(`
    SELECT
      SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS unreconciled,
      SUM(CASE WHEN status = 'failed' AND error_code = 'apns_delivery_outcome_unknown' THEN 1 ELSE 0 END) AS outcome_unknown
      FROM notification_delivery_attempts
     WHERE user_id = ? AND tenant_id = ?
  `).get(userId, tenantId) as { unreconciled: number | null; outcome_unknown: number | null };
  const unreconciledDeliveryAttempts = deliveryAttemptHealth.unreconciled ?? 0;
  const deliveryOutcomeUnknownAttempts = deliveryAttemptHealth.outcome_unknown ?? 0;

  return {
    expiredButVisible,
    unimplementedActionableCtas,
    unsupportedNotificationActions,
    deadDeeplinks,
    badgeDrift,
    genericMutatingActionSuccesses,
    apnsMutatingActionsExposed,
    staleSourceVisibleInInbox,
    unreconciledDeliveryAttempts,
    deliveryOutcomeUnknownAttempts,
    pass: expiredButVisible === 0
      && unimplementedActionableCtas === 0
      && unsupportedNotificationActions === 0
      && deadDeeplinks === 0
      && (badgeDrift == null || badgeDrift === 0)
      && genericMutatingActionSuccesses === 0
      && apnsMutatingActionsExposed === 0
      && staleSourceVisibleInInbox === 0
      && unreconciledDeliveryAttempts === 0
      && deliveryOutcomeUnknownAttempts === 0,
  };
}



export function countStaleSourceVisibleInInbox(userId: number, tenantId: number): number {
  const visibleDecisionIds = listNotificationCenterItems(userId, tenantId, { status: 'all', limit: 200 })
    .filter((item) => DECISION_TYPES.has(item.type))
    .map((item) => item.itemId);
  if (visibleDecisionIds.length === 0) return 0;
  const placeholders = visibleDecisionIds.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT items.*, intents.related_entity_id, intents.related_entity_type, intents.requires_user_action,
           intents.decision_deadline, intents.privacy_policy, intents.delivery_policy, intents.decision_context_json,
           intents.context_version
      FROM notification_center_items items
      JOIN notification_intents intents
        ON intents.intent_id = items.intent_id
       AND intents.user_id = items.user_id
       AND intents.tenant_id = items.tenant_id
     WHERE items.user_id = ?
       AND items.tenant_id = ?
       AND items.item_id IN (${placeholders})
       AND items.status IN ('unread', 'read', 'failed', 'snoozed')
       AND COALESCE(intents.requires_user_action, items.requires_user_action) = 1
  `).all(userId, tenantId, ...visibleDecisionIds) as any[];
  return rows.filter((row) => {
    const record = mapDecisionRecord(row);
    const logic = decisionLogicForRecord(record);
    return analysisForRecord(record, logic).sourceFreshness === 'stale';
  }).length;
}



/**
 * One bounded GROUP BY over the active partition for the admin dashboard. `active` is the SAME status+expiry
 * PREFILTER the read paths start from (status in the active set AND not past expires_at) — so the count is
 * an upper bound on the active partition, not the fully-surfaced set (which additionally drops rows hidden
 * by quality/visibility logic). byType is the persisted `type` column (NotificationIntentType) — NOT the computed
 * DecisionKind (which would require formatting every row), so the field is honestly named byType. Admin +
 * flag-gated + low-frequency, so the single GROUP BY on the indexed partition is acceptable.
 */
export function getDecisionActiveBreakdowns(userId: number, tenantId = userId): DecisionActiveBreakdowns {
  assertScope(userId, tenantId, 'decision_active_breakdowns', {});
  ensureDecisionCenterTables();
  const rows = getDb().prepare(`
    SELECT source_skill AS domain, type, status, COUNT(*) AS n
      FROM notification_center_items
     WHERE user_id = ? AND tenant_id = ?
       AND status IN ('unread', 'read', 'failed', 'snoozed')
       AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
     GROUP BY source_skill, type, status
  `).all(userId, tenantId, appNowIso()) as Array<{ domain: string; type: string; status: string; n: number }>;
  const byDomain: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    total += row.n;
    byDomain[row.domain] = (byDomain[row.domain] ?? 0) + row.n;
    byType[row.type] = (byType[row.type] ?? 0) + row.n;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + row.n;
  }
  return { total, byDomain, byType, byStatus };
}



/**
 * C3 — mute a (sourceSkill, type) recipe: permanently (dont_show_type) or until a timestamp (snooze_type).
 * Re-suppressing the same type replaces the prior mode (PK is user+tenant+skill+type). Scoped write.
 */
export function suppressDecisionType(
  userId: number,
  tenantId: number,
  sourceSkill: string,
  type: string,
  mode: DecisionTypeSuppressionMode,
  until: string | null = null,
  recipe: string | null = null,
): void {
  assertScope(userId, tenantId, 'suppress_decision_type', { sourceSkill, type, mode, recipe });
  // A snooze with no `until` would persist a row that listActiveDecisionTypeSuppressionKeys can never
  // activate (it requires `until > now`) — a silent no-op. Reject it so the caller's intent can't be dropped.
  if (mode === 'snooze_type' && !until) {
    throw new DecisionActionError('VALIDATION', 'snooze_type suppression requires a non-null until timestamp', 400);
  }
  ensureDecisionCenterTables();
  const normalizedRecipe = normalizeDecisionRecipe(recipe);
  if (normalizedRecipe) {
    getDb().prepare(`
      INSERT OR REPLACE INTO decision_recipe_suppressions (user_id, tenant_id, source_skill, type, recipe, mode, until, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(userId, tenantId, sourceSkill, type, normalizedRecipe, mode, mode === 'snooze_type' ? until : null);
    materializeDecisionRankSnapshotForScope(userId, tenantId);
    return;
  }
  getDb().prepare(`
    INSERT OR REPLACE INTO decision_type_suppressions (user_id, tenant_id, source_skill, type, mode, until, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(userId, tenantId, sourceSkill, type, mode, mode === 'snooze_type' ? until : null);
  materializeDecisionRankSnapshotForScope(userId, tenantId);
}



/** C3 — remove a (sourceSkill, type) suppression. */
export function unsuppressDecisionType(userId: number, tenantId: number, sourceSkill: string, type: string, recipe: string | null = null): void {
  assertScope(userId, tenantId, 'unsuppress_decision_type', { sourceSkill, type, recipe });
  ensureDecisionCenterTables();
  const normalizedRecipe = normalizeDecisionRecipe(recipe);
  if (normalizedRecipe) {
    getDb().prepare(`
      DELETE FROM decision_recipe_suppressions
      WHERE user_id = ? AND tenant_id = ? AND source_skill = ? AND type = ? AND recipe = ?
    `).run(userId, tenantId, sourceSkill, type, normalizedRecipe);
    materializeDecisionRankSnapshotForScope(userId, tenantId);
    return;
  }
  getDb().prepare(`DELETE FROM decision_type_suppressions WHERE user_id = ? AND tenant_id = ? AND source_skill = ? AND type = ?`)
    .run(userId, tenantId, sourceSkill, type);
  materializeDecisionRankSnapshotForScope(userId, tenantId);
}



/** C3 — all suppression rows for the user (for the preferences GET; includes lapsed snoozes so the client can show state). */
export function listDecisionTypeSuppressions(userId: number, tenantId = userId): DecisionTypeSuppression[] {
  assertScope(userId, tenantId, 'list_decision_type_suppressions', {});
  ensureDecisionCenterTables();
  const broad = getDb().prepare(`
    SELECT source_skill AS sourceSkill, type, NULL AS recipe, mode, until, created_at AS createdAt
      FROM decision_type_suppressions WHERE user_id = ? AND tenant_id = ?
  `).all(userId, tenantId) as DecisionTypeSuppression[];
  const recipeRows = getDb().prepare(`
    SELECT source_skill AS sourceSkill, type, recipe, mode, until, created_at AS createdAt
      FROM decision_recipe_suppressions WHERE user_id = ? AND tenant_id = ?
  `).all(userId, tenantId) as DecisionTypeSuppression[];
  const recipes = recipeRows.map((row) => ({
    ...row,
    recipe: displayDecisionRecipe(row.sourceSkill, row.recipe),
  }));
  return [...broad, ...recipes].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}



/** ACTIVE suppression keys (`${sourceSkill}:${type}`): dont_show_type always; snooze_type only while until > now. */
export function listActiveDecisionTypeSuppressionKeys(userId: number, tenantId: number): { broad: Set<string>; recipes: Set<string> } {
  const broadRows = getDb().prepare(`
    SELECT source_skill AS sourceSkill, type
     FROM decision_type_suppressions
     WHERE user_id = ? AND tenant_id = ?
       AND (mode = 'dont_show_type' OR (mode = 'snooze_type' AND until IS NOT NULL AND datetime(until) > datetime(?)))
  `).all(userId, tenantId, appNowIso()) as Array<{ sourceSkill: string; type: string }>;
  const recipeRows = getDb().prepare(`
    SELECT source_skill AS sourceSkill, type, recipe
      FROM decision_recipe_suppressions
     WHERE user_id = ? AND tenant_id = ?
       AND (mode = 'dont_show_type' OR (mode = 'snooze_type' AND until IS NOT NULL AND datetime(until) > datetime(?)))
  `).all(userId, tenantId, appNowIso()) as Array<{ sourceSkill: string; type: string; recipe: string }>;
  return {
    broad: new Set(broadRows.map((row) => `${row.sourceSkill}:${row.type}`)),
    recipes: new Set(recipeRows
      .map((row) => {
        const recipe = normalizeDecisionRecipe(row.recipe);
        return recipe ? `${row.sourceSkill}:${row.type}:${recipe}` : null;
      })
      .filter((key): key is string => !!key)),
  };
}



/**
 * C3 read-path filter (USER-FACING list + overview ONLY). Drops decisions whose (sourceSkill, type) the user
 * has actively suppressed — EXCEPT policy-floored decisions, which are never suppressible (mirrors the C5/B3
 * floor discipline). Flag-gated; OFF or no-suppressions returns the input unchanged. Read-only. NEVER applied
 * to integrity/admin reads (release gate, dashboard breakdowns, summary counts) so those stay accurate.
 */
export function applyDecisionTypeSuppression(items: DecisionApiItem[], userId: number, tenantId: number): DecisionApiItem[] {
  let filtered = items;
  if (isDecisionTypeSuppressionEnabled(process.env, { userId, tenantId })) {
    let suppressed: { broad: Set<string>; recipes: Set<string> };
    try {
      suppressed = listActiveDecisionTypeSuppressionKeys(userId, tenantId);
    } catch (err) {
      // A missing policy read means we cannot prove that low-risk cards are
      // permitted by the user's suppression policy. Fail closed for those
      // cards, while retaining the safety floor for critical decisions.
      logger.warn({ err, userId, tenantId }, 'decision type-suppression read failed; retaining policy-floored items only');
      return items.filter(isDecisionItemPolicyFloored);
    }
    if (suppressed.broad.size > 0 || suppressed.recipes.size > 0) {
      filtered = filtered.filter((item) => {
        if (isDecisionItemPolicyFloored(item)) return true;
        const broadKey = `${item.sourceSkill}:${item.type}`;
        if (suppressed.broad.has(broadKey)) return false;
        const recipe = recipeForDecisionItem(item);
        return !recipe || !suppressed.recipes.has(`${broadKey}:${recipe}`);
      });
    }
  }
  if (!isDecisionFeedbackSuppressionEnabled(process.env, { userId, tenantId })) return filtered;
  const noisyTypes = feedbackSuppressedTypeKeys(userId, tenantId);
  if (noisyTypes === null) return filtered.filter(isDecisionItemPolicyFloored);
  if (noisyTypes.size === 0) return filtered;
  return filtered.filter((item) => isDecisionItemPolicyFloored(item) || !noisyTypes.has(`${item.sourceSkill}:${item.type}`));
}



export function feedbackSuppressedTypeKeys(userId: number, tenantId: number): Set<string> | null {
  try {
    return new Set(
      getDecisionFeedbackSignals(userId, tenantId, { sinceDays: 14 })
        .filter((signal) => signal.type && signal.surfaced >= 5 && (
          signal.dontShowTypeCount >= 2
          || (signal.dismissed >= 4 && signal.dismissRate >= 0.8)
          || (signal.snoozed >= 4 && signal.snoozed / Math.max(1, signal.surfaced) >= 0.8)
        ))
        .map((signal) => `${signal.sourceSkill}:${signal.type}`),
    );
  } catch (err) {
    logger.warn({ err, userId, tenantId }, 'decision feedback suppression read failed; retaining policy-floored items only');
    return null;
  }
}



export function normalizeDecisionRecipe(recipe: string | null | undefined): string | null {
  if (typeof recipe !== 'string') return null;
  const normalized = recipe.trim();
  if (!normalized) return null;
  const sourceSkill = normalized.split(':', 1)[0];
  const sourcePrefix = `${sourceSkill}:`;
  return isDecisionSourceSkillPrefix(sourceSkill) && normalized.startsWith(sourcePrefix)
    ? normalized.slice(sourcePrefix.length).slice(0, 160)
    : normalized.slice(0, 160);
}



export function displayDecisionRecipe(sourceSkill: string, recipe: string | null): string | null {
  if (!recipe) return null;
  const normalized = recipe.trim();
  if (!normalized) return null;
  const sourcePrefix = `${sourceSkill}:`;
  return normalized.startsWith(sourcePrefix) ? normalized.slice(0, 160) : `${sourcePrefix}${normalized}`.slice(0, 160);
}



export function recipeForDecisionItem(item: DecisionApiItem): string | null {
  const group = item.groupKey?.trim();
  if (!group) return null;
  const prefix = `${item.sourceSkill}:`;
  return group.startsWith(prefix) ? group.slice(prefix.length).slice(0, 160) : group.slice(0, 160);
}



export function isDecisionSourceSkillPrefix(value: string): value is NotificationSourceSkill {
  return value === 'secretary'
    || value === 'training'
    || value === 'content'
    || value === 'cooking'
    || value === 'finance'
    || value === 'chat'
    || value === 'system'
    || value === 'security';
}



/**
 * Aggregate the lifecycle event stream (incl. C3a dismiss reasons) into per-source-skill feedback
 * signals (C3b). READ-ONLY substrate for a future calibration/suppression pass — it does NOT alter
 * ranking yet (bounded suppression is a deliberate follow-up; floored categories stay exempt). Joins
 * events to notification_center_items for the source_skill dimension.
 *
 * Scope: per-user read, filtered by (user_id, tenant_id) and rides idx_decision_lifecycle_events_
 * scope_created — bounded by the caller's own event count, never a hot-table-wide scan. The JOIN
 * carries a redundant (user_id, tenant_id) guard as defense-in-depth so a future per-tenant item_id
 * scheme can never bleed another tenant's source_skill in.
 *
 * `opts.sinceDays` bounds the window so the signal can decay (a year-old dismissal must not weigh
 * like today's); omitted => all-time. The window uses the SQLite clock (`datetime('now')`), which
 * is NOT affected by vi.setSystemTime — tests pin determinism by back/forward-dating event rows
 * directly rather than moving the JS clock.
 *
 * `dontShowTypeCount` deliberately re-surfaces the 'dont_show_type' tally that also appears in
 * `topDismissReasons`; it is the single strongest suppression signal and callers act on it directly
 * without scanning the reason breakdown.
 */
export function getDecisionFeedbackSignals(
  userId: number,
  tenantId = userId,
  opts: { sinceDays?: number } = {},
): DecisionFeedbackSignal[] {
  assertScope(userId, tenantId, 'decision_feedback_signals', {});
  ensureDecisionCenterTables();
  const db = getDb();
  const windowClause =
    typeof opts.sinceDays === 'number' && opts.sinceDays > 0 ? `AND e.created_at >= datetime('now', ?)` : '';
  const windowArg: string[] = windowClause ? [`-${Math.floor(opts.sinceDays as number)} days`] : [];
  const eventRows = db.prepare(`
    SELECT i.source_skill AS sourceSkill, i.type AS type, e.event AS event, COUNT(*) AS n
      FROM decision_lifecycle_events e
      JOIN notification_center_items i
        ON i.item_id = e.decision_id AND i.user_id = e.user_id AND i.tenant_id = e.tenant_id
     WHERE e.user_id = ? AND e.tenant_id = ? ${windowClause}
     GROUP BY i.source_skill, i.type, e.event
  `).all(userId, tenantId, ...windowArg) as Array<{ sourceSkill: string; type: string; event: string; n: number }>;
  const reasonRows = db.prepare(`
    SELECT i.source_skill AS sourceSkill, i.type AS type, e.reason AS reason, COUNT(*) AS n
      FROM decision_lifecycle_events e
      JOIN notification_center_items i
        ON i.item_id = e.decision_id AND i.user_id = e.user_id AND i.tenant_id = e.tenant_id
     WHERE e.user_id = ? AND e.tenant_id = ? AND e.event = 'dismissed' AND e.reason IS NOT NULL ${windowClause}
     GROUP BY i.source_skill, i.type, e.reason
  `).all(userId, tenantId, ...windowArg) as Array<{ sourceSkill: string; type: string; reason: string; n: number }>;

  const buckets = new Map<string, { sourceSkill: string; type: string; events: Record<string, number>; reasons: Array<{ reason: string; count: number }> }>();
  const bucket = (skill: string, type: string): { sourceSkill: string; type: string; events: Record<string, number>; reasons: Array<{ reason: string; count: number }> } => {
    const key = `${skill}:${type}`;
    let b = buckets.get(key);
    if (!b) { b = { sourceSkill: skill, type, events: {}, reasons: [] }; buckets.set(key, b); }
    return b;
  };
  for (const row of eventRows) bucket(row.sourceSkill, row.type).events[row.event] = row.n;
  for (const row of reasonRows) bucket(row.sourceSkill, row.type).reasons.push({ reason: row.reason, count: row.n });

  return [...buckets.values()]
    .map((b) => {
      const surfaced = b.events.surfaced ?? b.events.created ?? 0;
      const dismissed = b.events.dismissed ?? 0;
      return {
        sourceSkill: b.sourceSkill,
        type: b.type,
        surfaced,
        dismissed,
        snoozed: b.events.snoozed ?? 0,
        actionSucceeded: b.events.action_succeeded ?? 0,
        // Guard the zero-denominator case (matches the file's blessed rate() convention at :~1714):
        // a skill with dismissed>0 but surfaced=0 (lifecycle tracking enabled after creation, or
        // post-retention pruning) must report 0, never the raw count — a rate > 1.0 would mis-fire a
        // future "suppress if rate > 0.8" consumer on a skill that has no recorded surfacing at all.
        dismissRate: surfaced === 0 ? 0 : Number((dismissed / surfaced).toFixed(4)),
        dontShowTypeCount: b.reasons.find((r) => r.reason === 'dont_show_type')?.count ?? 0,
        topDismissReasons: [...b.reasons].sort((a, c) => c.count - a.count).slice(0, 3),
      };
    })
    .sort((a, c) => c.dismissed - a.dismissed);
}



export function supersedeDecision(record: DecisionRecord, reason: string): void {
  guardDecisionLifecycleMutation(record, 'supersede');
  const decisionUpdate = getDb().prepare(`
    UPDATE notification_center_items
       SET status = 'superseded',
           decision_state = 'superseded',
           action_result_json = ?,
           record_version = record_version + 1,
           updated_at = datetime('now')
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
  emitDecisionLifecycleEvent({ decisionId: record.itemId, userId: record.userId, tenantId: record.tenantId, event: 'superseded', reason });
  if (record.decisionLogId) {
    getDb().prepare(`
      UPDATE notification_decision_logs
         SET action_taken = COALESCE(action_taken, 'superseded')
       WHERE decision_log_id = ?
    `).run(record.decisionLogId);
  }
  const logic = decisionLogicForRecord(record);
  const explanation = finalizeDecisionExplanation(record, handledDecisionExplanation(record, logic, {
    actionId: 'auto_dismiss_stale_decision',
    actualEffect: { supersededReason: reason },
    message: reason,
  }));
  recordHandledByNexus(record, {
    actionTaken: 'auto_dismiss_stale_decision',
    summary: explanation.result,
    whyBrief: explanation.verification,
    explanation,
    rollbackAvailable: false,
  });
  recordDecisionOutcome(record, {
    actionShown: 'auto_dismiss_stale_decision',
    actionTaken: 'superseded',
    actionSucceeded: true,
    timeToActionMs: timeToActionMs(record),
  });
}



export function recordHandledByNexus(record: DecisionRecord, input: {
  actionTaken: string;
  summary: string;
  whyBrief: string;
  explanation?: DecisionExplanation | null;
  rollbackAvailable: boolean;
  changedRuleOption?: string | null;
  createdAt?: string | null;
}): void {
  ensureDecisionCenterTables();
  const logic = decisionLogicForRecord(record);
  const explanation = input.explanation ?? finalizeDecisionExplanation(record, handledDecisionExplanation(record, logic, {
    actionId: input.actionTaken,
    actualEffect: record.actionResult ?? {},
    message: input.summary,
  }));
  getDb().prepare(`
    INSERT INTO handled_by_nexus_items (
      handled_item_id, decision_id, user_id, tenant_id, source_skill, title, summary,
      action_taken, why_brief, explanation_json, related_entities_json, rollback_available, changed_rule_option,
      privacy_classification, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
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
    explanation ? JSON.stringify(explanation) : null,
    JSON.stringify(record.relatedEntityId && record.relatedEntityType ? [{ type: record.relatedEntityType, id: record.relatedEntityId }] : []),
    input.rollbackAvailable ? 1 : 0,
    input.changedRuleOption ?? null,
    record.privacyPolicy,
    input.createdAt ?? null,
  );
}



export function recordVerifiedDecisionAction(
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
    const logic = decisionLogicForRecord(record);
    const explanation = finalizeDecisionExplanation(record, handledDecisionExplanation(record, logic, {
      actionId,
      actualEffect: execution.actualEffect,
      message: execution.message,
    }));
    recordHandledByNexus(record, {
      actionTaken: actionId,
      summary: explanation.result,
      whyBrief: explanation.verification,
      explanation,
      rollbackAvailable: execution.actualEffect.rollbackAvailable === true,
      changedRuleOption: stringOrNull(execution.actualEffect.changedRuleOption),
    });
  } catch (err) {
    decisionHandledHistoryStats.writeFailures += 1;
    logger.error({ err, decisionId: record.itemId, actionId, userId: record.userId, tenantId: record.tenantId }, 'Decision handled history write failed');
  }
}



export function mapActionedDecisionToHandledItem(record: DecisionRecord): HandledByNexusItem {
  const logic = decisionLogicForRecord(record);
  const actionTaken = record.decisionLogActionTaken
    ?? stringOrNull(record.actionResult?.actionId)
    ?? 'completed';
  const actionLabel = record.actions.find((action) => action.id === actionTaken)?.label ?? humanizeActionId(actionTaken);
  const outcome = outcomeSummaryForRecord({ ...record, status: 'actioned' }, logic);
  const rollback = rollbackContractForRecord({ ...record, status: 'actioned' });
  const explanation = finalizeDecisionExplanation(record, handledDecisionExplanation(record, logic, {
    actionId: actionTaken,
    actualEffect: record.actionResult ?? {},
    message: outcome.outcomeSummary,
  }));
  return withHandledRollbackAction({
    itemId: `actioned_${record.itemId}`,
    decisionId: record.itemId,
    userId: record.userId,
    tenantId: record.tenantId,
    sourceSkill: record.sourceSkill,
    title: logic.safePreviewTitle,
    summary: explanation.result || outcome.outcomeSummary || `${sourceLabel(record.sourceSkill)} completed ${actionLabel}.`,
    actionTaken,
    explanation,
    whyBrief: explanation.verification,
    relatedEntities: record.relatedEntityId && record.relatedEntityType
      ? [{ type: record.relatedEntityType, id: record.relatedEntityId }]
      : [],
    rollbackAvailable: rollback.available,
    changedRuleOption: null,
    createdAt: record.actionedAt ?? record.createdAt,
    privacyClassification: record.privacyPolicy,
  }, record);
}



export function withHandledRollbackAction(item: HandledByNexusItem, record: DecisionRecord): HandledByNexusItem {
  const rollback = rollbackContractForRecord(record);
  const execution = executionSummaryForRecord(record);
  const reconciliationAvailable = execution.status === 'partially_failed'
    && (decisionRefreshSupportedForScope(record.userId, record.tenantId)
      || decisionFlowV1EnforcedForRecord(record));
  if (!rollback.available || !rollback.actionId) {
    return {
      ...item,
      rollbackAvailable: false,
      execution,
      ...(reconciliationAvailable ? { reconciliationAvailable: true } : {}),
    };
  }
  return {
    ...item,
    rollbackAvailable: true,
    execution,
    ...(reconciliationAvailable ? { reconciliationAvailable: true } : {}),
    rollbackAction: {
      actionId: rollback.actionId,
      recordVersion: record.recordVersion,
      contextVersion: decisionContextVersion(record),
    },
  };
}



export function humanizeActionId(actionId: string): string {
  return actionId
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Completed';
}



export function recordDecisionOutcome(record: DecisionRecord, input: {
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



export function recordDecisionQualityGateEvent(input: NotificationIntentInput, quality: DecisionQualityGateResult): void {
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



export function mapHandledByNexusItem(row: any): HandledByNexusItem {
  return {
    itemId: row.handled_item_id,
    decisionId: row.decision_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    sourceSkill: row.source_skill,
    title: row.title,
    summary: row.summary,
    explanation: normalizeDecisionExplanation(safeParseJson(row.explanation_json, null)),
    actionTaken: row.action_taken,
    whyBrief: row.why_brief,
    relatedEntities: safeParseJson(row.related_entities_json, []),
    rollbackAvailable: !!row.rollback_available,
    changedRuleOption: row.changed_rule_option,
    createdAt: row.created_at,
    privacyClassification: row.privacy_classification,
  };
}



export interface UpdateDecisionPreferencesCommandInput {
  readonly userId: number;
  readonly tenantId: number;
  readonly patch: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly channel: DecisionMutationChannel;
  readonly requestedAt?: string;
}



/**
 * Replay-safe preference mutation shared by REST, portal, and future command
 * surfaces. The exact preference readback and command receipt commit with the
 * profile/flow writes in one database transaction.
 */
export function updateDecisionPreferencesViaCommand(
  input: UpdateDecisionPreferencesCommandInput,
): { preferences: Record<string, unknown>; idempotent: boolean } {
  const requestedAt = input.requestedAt ?? new Date().toISOString();
  const keyHash = createHash('sha256').update(input.idempotencyKey).digest('hex');
  const resourceId = `decision-preferences:${input.tenantId}:${input.userId}`;
  const command = createDecisionMutationCommand({
    commandId: `preferences:${keyHash}`,
    decisionId: resourceId,
    operation: 'update_preferences',
    actionId: 'update_preferences',
    scope: { userId: input.userId, tenantId: input.tenantId },
    channel: input.channel,
    idempotencyKey: input.idempotencyKey,
    recordVersion: null,
    contextVersion: null,
    approval: { requiredLevel: 'none', evidence: null },
    execution: {
      executorId: 'decision-center.update_preferences',
      strategy: 'synchronous',
      riskLevel: 'low',
      reversible: true,
      supportsIdempotency: true,
    },
    readback: {
      verifierId: 'decision-center.preferences.exact',
      entityType: 'decision_center_preferences',
      entityId: resourceId,
      mode: 'exact',
      expectedState: input.patch,
    },
    payload: input.patch,
    requestedAt,
  });
  const receipt = executeDecisionMutationWithReceipt(command, () => (
    updateDecisionPreferences(input.userId, input.tenantId, { ...input.patch })
  ));
  return {
    preferences: receipt.result,
    idempotent: receipt.idempotent,
  };
}
