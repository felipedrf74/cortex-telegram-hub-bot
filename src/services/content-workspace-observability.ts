// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from './database';

/**
 * Durable, privacy-bounded observability for the canonical Content workspace.
 *
 * Only closed enum taxonomies and aggregate numbers cross this boundary. The
 * durable schema deliberately has no identity, timestamps, free-form metadata,
 * user content, prompts, URLs, hashes, or provider responses. Persistence is
 * best effort and can never change the result of a user operation.
 */
export const CONTENT_WORKSPACE_OBSERVABILITY_SCHEMA_VERSION = 'content-workspace-observability.v6';

export const CONTENT_WORKSPACE_OPERATIONS = [
  'item_create',
  'item_update',
  'item_transition',
  'item_delete',
  'item_restore',
  'artifact_create',
  'revision_save',
  'revision_restore',
  'source_register',
  'source_assess',
  'lineage_record',
  'generation',
  'agent_job_create',
  'agent_job_run',
  'agent_job_cancel',
  'agent_job_retry',
  'proposal_create',
  'proposal_accept',
  'proposal_reject',
  'schedule_preview',
  'schedule_confirm',
  'schedule_cancel',
  'rollout_gate',
] as const;
export type ContentWorkspaceOperation = typeof CONTENT_WORKSPACE_OPERATIONS[number];

export const CONTENT_WORKSPACE_OUTCOMES = [
  'success',
  'replayed',
  'no_change',
  'conflict',
  'blocked',
  'failure',
  'accepted',
  'rejected',
] as const;
export type ContentWorkspaceOutcome = typeof CONTENT_WORKSPACE_OUTCOMES[number];

export const CONTENT_WORKSPACE_REASONS = [
  'base_revision_conflict',
  'workflow_version_conflict',
  'idempotency_key_reused',
  'lineage_immutable',
  'claim_safety_block',
  'output_safety_block',
  'output_size_block',
  'proposal_stale',
  'agent_job_active',
  'agent_base_stale',
  'agent_lease_conflict',
  'agent_package_block',
  'agent_package_integrity',
  'agent_review_incomplete',
  'validation_rejected',
  'not_found',
  'budget_denied',
  'provider_failure',
  'internal_failure',
  'schedule_preview_stale',
  'schedule_slot_changed',
  'schedule_provider_failure',
  'schedule_cancellation_failure',
  'rollout_write_disabled',
] as const;
export type ContentWorkspaceReason = typeof CONTENT_WORKSPACE_REASONS[number];

export const CONTENT_WORKSPACE_SURFACES = ['service', 'agent', 'background_job'] as const;
export type ContentWorkspaceSurface = typeof CONTENT_WORKSPACE_SURFACES[number];

export const CONTENT_WORKSPACE_PRODUCT_SIGNALS = [
  'idea_captured',
  'project_created',
  'revision_saved',
  'revision_restored',
  'content_approved',
  // These are internal workflow/work-plan counters. Neither is evidence that
  // an external platform accepted or published content.
  'internal_scheduled_state_or_confirmed_work_block',
  'internal_workflow_published_state',
  'script_generated',
  'platform_variant_generated',
  'proposal_accepted',
  'proposal_rejected',
  // Temporary compatibility counters. Removal requires a zero counter delta
  // across two supported release windows; no route, user, or content identity
  // is retained.
  'legacy_pipeline_compatibility_read',
  'legacy_ideas_compatibility_read',
  'legacy_pipeline_compatibility_mutation',
  'legacy_topics_compatibility_read',
  'legacy_topics_compatibility_mutation',
  'legacy_editorial_compatibility_read',
  'legacy_editorial_compatibility_mutation',
] as const;
export type ContentWorkspaceProductSignal = typeof CONTENT_WORKSPACE_PRODUCT_SIGNALS[number];

type StoredContentWorkspaceProductSignal = Exclude<
  ContentWorkspaceProductSignal,
  'internal_scheduled_state_or_confirmed_work_block' | 'internal_workflow_published_state'
> | 'content_scheduled' | 'content_published';

function storedProductSignal(signal: ContentWorkspaceProductSignal): StoredContentWorkspaceProductSignal {
  if (signal === 'internal_scheduled_state_or_confirmed_work_block') return 'content_scheduled';
  if (signal === 'internal_workflow_published_state') return 'content_published';
  return signal;
}

function publicProductSignal(signal: string): ContentWorkspaceProductSignal | null {
  if (signal === 'content_scheduled') return 'internal_scheduled_state_or_confirmed_work_block';
  if (signal === 'content_published') return 'internal_workflow_published_state';
  return isMember(CONTENT_WORKSPACE_PRODUCT_SIGNALS, signal) ? signal : null;
}

export const CONTENT_WORKSPACE_QUALITY_SIGNALS = [
  'lineage_recorded_clear',
  'unsupported_claim_warning',
  'claim_safety_blocked',
  'generation_output_blocked',
  'generation_quality_warning',
  'factuality_warning',
  'brand_voice_warning',
  'platform_fit_warning',
] as const;
export type ContentWorkspaceQualitySignal = typeof CONTENT_WORKSPACE_QUALITY_SIGNALS[number];

const RELIABILITY_COUNTER_NAMES = [
  'workspace_operation_total',
  'workspace_operation_failure_total',
  'item_create_success_total',
  'revision_save_success_total',
  'revision_save_no_change_total',
  'revision_restore_success_total',
  'mutation_conflict_total',
  'autosave_conflict_total',
  'idempotent_replay_total',
  'lineage_record_success_total',
  'lineage_policy_block_total',
  'generation_success_total',
  'generation_failure_total',
  'generation_blocked_total',
  'proposal_created_total',
  'proposal_accepted_total',
  'proposal_rejected_total',
  'proposal_conflict_total',
  'schedule_preview_success_total',
  'schedule_confirm_success_total',
  'schedule_cancel_success_total',
  'schedule_failure_total',
  'schedule_conflict_total',
] as const;
type ReliabilityCounter = typeof RELIABILITY_COUNTER_NAMES[number];

const DURATION_BUCKETS = [
  'lt_50_ms',
  'lt_250_ms',
  'lt_1000_ms',
  'lt_5000_ms',
  'lt_30000_ms',
  'gte_30000_ms',
] as const;
type DurationBucket = typeof DURATION_BUCKETS[number];

interface TimerAggregate {
  count: number;
  totalMs: number;
  minMs: number | null;
  maxMs: number | null;
  buckets: Record<DurationBucket, number>;
}

interface InternalOperationalEvent {
  timestamp: string;
  operation: ContentWorkspaceOperation;
  outcome: ContentWorkspaceOutcome;
  surface: ContentWorkspaceSurface;
  reason?: ContentWorkspaceReason;
  durationBucket?: DurationBucket;
}

interface AggregateState {
  reliability: Record<ReliabilityCounter, number>;
  outcomesByOperation: Record<ContentWorkspaceOperation, Record<ContentWorkspaceOutcome, number>>;
  timers: Record<ContentWorkspaceOperation, TimerAggregate>;
  reasons: Record<ContentWorkspaceReason, number>;
  product: Record<ContentWorkspaceProductSignal, number>;
  quality: Record<ContentWorkspaceQualitySignal, number>;
}

export interface ContentWorkspaceObservabilitySnapshot extends AggregateState {
  schemaVersion: typeof CONTENT_WORKSPACE_OBSERVABILITY_SCHEMA_VERSION;
  privacy: {
    taxonomy: 'closed_taxonomy_only';
    operational: 'bounded_identity_free';
    product: 'aggregate_only';
    quality: 'aggregate_only';
    rawContentLogged: false;
    scopeIdentifiersLogged: false;
    contentFingerprintsLogged: false;
    operationalEventRingExposed: false;
  };
  storage: {
    mode: 'durable' | 'durable_with_pending' | 'process_fallback';
    durableStore: 'sqlite_aggregate';
    durableAvailable: boolean;
    includesHistoricalTotals: boolean;
    pendingWrite: boolean;
    bestEffortWrites: true;
    userOperationFailurePropagation: false;
  };
  publicationTracking: {
    status: 'unavailable';
    publicationEvidence: false;
    reasonCode: 'EXTERNAL_PUBLICATION_RECEIPTS_UNAVAILABLE';
    internalWorkflowStateMetric: 'internal_workflow_published_state';
  };
}

const MAX_EVENTS = 200;
const MAX_DURATION_MS = 10 * 60 * 1_000;
const MAX_METRIC = Number.MAX_SAFE_INTEGER;
let processAggregate = emptyAggregate();
let pendingAggregate = emptyAggregate();
let pendingDirty = false;
let scheduledFlush: NodeJS.Immediate | null = null;
let operationalEvents: InternalOperationalEvent[] = [];

export function recordContentWorkspaceOperationalOutcome(input: {
  operation: ContentWorkspaceOperation;
  outcome: ContentWorkspaceOutcome;
  surface?: ContentWorkspaceSurface;
  reason?: ContentWorkspaceReason;
  durationMs?: number;
}): void {
  try {
    if (!CONTENT_WORKSPACE_OPERATIONS.includes(input.operation)) return;
    if (!CONTENT_WORKSPACE_OUTCOMES.includes(input.outcome)) return;
    if (input.reason && !CONTENT_WORKSPACE_REASONS.includes(input.reason)) return;
    const surface = input.surface ?? 'service';
    if (!CONTENT_WORKSPACE_SURFACES.includes(surface)) return;
    const durationMs = normalizeDuration(input.durationMs);
    recordOperationalAggregate(processAggregate, input.operation, input.outcome, input.reason, durationMs);
    recordOperationalAggregate(pendingAggregate, input.operation, input.outcome, input.reason, durationMs);
    pendingDirty = true;
    const durationBucket = durationMs == null ? undefined : durationBucketFor(durationMs);
    operationalEvents.unshift({
      timestamp: new Date().toISOString(),
      operation: input.operation,
      outcome: input.outcome,
      surface,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(durationBucket ? { durationBucket } : {}),
    });
    if (operationalEvents.length > MAX_EVENTS) operationalEvents.length = MAX_EVENTS;
    schedulePendingFlush();
  } catch {
    // Metrics are strictly non-critical and never fail a user operation.
  }
}

export function startContentWorkspaceObservation(
  operation: ContentWorkspaceOperation,
  surface: ContentWorkspaceSurface = 'service',
): {
  complete: (outcome: ContentWorkspaceOutcome, reason?: ContentWorkspaceReason) => void;
  completeFromError: (error: unknown) => void;
} {
  const startedAt = Date.now();
  let completed = false;
  const finish = (outcome: ContentWorkspaceOutcome, reason?: ContentWorkspaceReason): void => {
    if (completed) return;
    completed = true;
    recordContentWorkspaceOperationalOutcome({
      operation,
      outcome,
      surface,
      reason,
      durationMs: Date.now() - startedAt,
    });
  };
  return {
    complete: finish,
    completeFromError: (error: unknown) => {
      const classified = classifyContentWorkspaceOperationalError(error);
      finish(classified.outcome, classified.reason);
    },
  };
}

export function classifyContentWorkspaceOperationalError(error: unknown): {
  outcome: Extract<ContentWorkspaceOutcome, 'conflict' | 'blocked' | 'failure'>;
  reason: ContentWorkspaceReason;
} {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = typeof record.code === 'string' ? record.code.toUpperCase() : '';
  const status = typeof record.status === 'number'
    ? record.status
    : typeof record.statusCode === 'number'
      ? record.statusCode
      : undefined;

  const exact: Record<string, { outcome: 'conflict' | 'blocked' | 'failure'; reason: ContentWorkspaceReason }> = {
    CONTENT_WORKSPACE_WRITE_DISABLED: { outcome: 'blocked', reason: 'rollout_write_disabled' },
    CONTENT_REVISION_CONFLICT: { outcome: 'conflict', reason: 'base_revision_conflict' },
    CONTENT_WORKFLOW_VERSION_CONFLICT: { outcome: 'conflict', reason: 'workflow_version_conflict' },
    CONTENT_IDEMPOTENCY_KEY_REUSED: { outcome: 'conflict', reason: 'idempotency_key_reused' },
    CONTENT_REVISION_LINEAGE_IMMUTABLE: { outcome: 'conflict', reason: 'lineage_immutable' },
    CONTENT_CLAIM_SAFETY_BLOCKED: { outcome: 'blocked', reason: 'claim_safety_block' },
    CONTENT_SCRIPT_OUTPUT_BLOCKED: { outcome: 'blocked', reason: 'output_safety_block' },
    CONTENT_SCRIPT_OUTPUT_TOO_LARGE: { outcome: 'blocked', reason: 'output_size_block' },
    CONTENT_AGENT_PROPOSAL_STALE: { outcome: 'conflict', reason: 'proposal_stale' },
    CONTENT_AGENT_JOB_ACTIVE: { outcome: 'conflict', reason: 'agent_job_active' },
    CONTENT_AGENT_JOB_BASE_STALE: { outcome: 'conflict', reason: 'agent_base_stale' },
    CONTENT_AGENT_JOB_LEASE_LOST: { outcome: 'conflict', reason: 'agent_lease_conflict' },
    CONTENT_AGENT_JOB_CLAIM_CONFLICT: { outcome: 'conflict', reason: 'agent_lease_conflict' },
    CONTENT_AGENT_PACKAGE_BLOCKED: { outcome: 'blocked', reason: 'agent_package_block' },
    CONTENT_AGENT_PACKAGE_CHANGED: { outcome: 'conflict', reason: 'agent_package_integrity' },
    CONTENT_AGENT_PACKAGE_INTEGRITY_FAILED: { outcome: 'blocked', reason: 'agent_package_integrity' },
    CONTENT_AGENT_PACKAGE_VERSION_UNSUPPORTED: { outcome: 'blocked', reason: 'agent_package_integrity' },
    CONTENT_AGENT_OUTPUT_TOO_LARGE: { outcome: 'blocked', reason: 'output_size_block' },
    CONTENT_AGENT_JOB_REVIEW_INCOMPLETE: { outcome: 'conflict', reason: 'agent_review_incomplete' },
    CONTENT_LINEAGE_REVIEW_REQUIRED: { outcome: 'blocked', reason: 'claim_safety_block' },
    CONTENT_SCHEDULE_PREVIEW_STALE: { outcome: 'conflict', reason: 'schedule_preview_stale' },
    CONTENT_SCHEDULE_ITEM_MISSING: { outcome: 'conflict', reason: 'schedule_preview_stale' },
    CONTENT_SCHEDULE_STATE_CHANGED: { outcome: 'conflict', reason: 'schedule_preview_stale' },
    CONTENT_SCHEDULE_WORKFLOW_CHANGED: { outcome: 'conflict', reason: 'schedule_preview_stale' },
    CONTENT_SCHEDULE_ARTIFACT_CHANGED: { outcome: 'conflict', reason: 'schedule_preview_stale' },
    CONTENT_SCHEDULE_REVISION_CHANGED: { outcome: 'conflict', reason: 'schedule_preview_stale' },
    CONTENT_SCHEDULE_PREVIEW_EXPIRED: { outcome: 'conflict', reason: 'schedule_preview_stale' },
    CONTENT_SCHEDULE_STALE: { outcome: 'conflict', reason: 'schedule_preview_stale' },
    CONTENT_SCHEDULE_SLOT_CHANGED: { outcome: 'conflict', reason: 'schedule_slot_changed' },
    CONTENT_SCHEDULE_SLOT_UNAVAILABLE: { outcome: 'conflict', reason: 'schedule_slot_changed' },
    CONTENT_SCHEDULE_PREVIEW_FAILED: { outcome: 'failure', reason: 'schedule_provider_failure' },
    CONTENT_SCHEDULE_CONFIRMATION_FAILED: { outcome: 'failure', reason: 'schedule_provider_failure' },
    CONTENT_SCHEDULE_AUTHORITY_UNAVAILABLE: { outcome: 'failure', reason: 'schedule_provider_failure' },
    CONTENT_SCHEDULE_PROVIDER_SYNC_FAILED: { outcome: 'failure', reason: 'schedule_provider_failure' },
    CONTENT_SCHEDULE_WRITE_FAILED: { outcome: 'failure', reason: 'schedule_provider_failure' },
    CONTENT_SCHEDULE_RECOVERY_REQUIRED: { outcome: 'failure', reason: 'schedule_provider_failure' },
    CONTENT_SECRETARY_SUBMIT_FAILED: { outcome: 'failure', reason: 'schedule_provider_failure' },
    CONTENT_SECRETARY_CONFIRMATION_MISMATCH: { outcome: 'conflict', reason: 'schedule_slot_changed' },
    CONTENT_SCHEDULE_CANCELLATION_FAILED: { outcome: 'failure', reason: 'schedule_cancellation_failure' },
    CONTENT_SCHEDULE_CLEANUP_PENDING: { outcome: 'conflict', reason: 'schedule_cancellation_failure' },
  };
  if (exact[code]) return exact[code];
  if (code.includes('BUDGET') || code.includes('PLAN_REQUIRED') || code.includes('RATE_LIMIT')) {
    return { outcome: 'blocked', reason: 'budget_denied' };
  }
  if (code.includes('VALIDATION') || status === 400 || status === 422) {
    return { outcome: 'blocked', reason: 'validation_rejected' };
  }
  if (code.includes('NOT_FOUND') || status === 404) {
    return { outcome: 'failure', reason: 'not_found' };
  }
  if (code.includes('PROVIDER') || code.includes('MODEL') || code.includes('UPSTREAM')) {
    return { outcome: 'failure', reason: 'provider_failure' };
  }
  return { outcome: 'failure', reason: 'internal_failure' };
}

export function recordContentWorkspaceProductSignal(signal: ContentWorkspaceProductSignal): void {
  try {
    if (!CONTENT_WORKSPACE_PRODUCT_SIGNALS.includes(signal)) return;
    processAggregate.product[signal] = saturatingAdd(processAggregate.product[signal], 1);
    pendingAggregate.product[signal] = saturatingAdd(pendingAggregate.product[signal], 1);
    pendingDirty = true;
    schedulePendingFlush();
  } catch {
    // Best effort only.
  }
}

export function recordContentWorkspaceQualitySignal(signal: ContentWorkspaceQualitySignal): void {
  try {
    if (!CONTENT_WORKSPACE_QUALITY_SIGNALS.includes(signal)) return;
    processAggregate.quality[signal] = saturatingAdd(processAggregate.quality[signal], 1);
    pendingAggregate.quality[signal] = saturatingAdd(pendingAggregate.quality[signal], 1);
    pendingDirty = true;
    schedulePendingFlush();
  } catch {
    // Best effort only.
  }
}

/** Aggregate-only and safe for an authenticated operations surface. */
export function getContentWorkspaceObservabilitySnapshot(): ContentWorkspaceObservabilitySnapshot {
  flushPendingToDurable();
  try {
    const durable = readDurableAggregate(getDb());
    const aggregate = pendingDirty ? mergeAggregates(durable, pendingAggregate) : durable;
    return cloneSnapshot(snapshotFromAggregate(aggregate, {
      mode: pendingDirty ? 'durable_with_pending' : 'durable',
      durableAvailable: true,
      includesHistoricalTotals: true,
      pendingWrite: pendingDirty,
    }));
  } catch {
    return cloneSnapshot(snapshotFromAggregate(processAggregate, {
      mode: 'process_fallback',
      durableAvailable: false,
      includesHistoricalTotals: false,
      pendingWrite: pendingDirty,
    }));
  }
}

/** Process-internal diagnostics; exported only for privacy negative controls. */
export function _getContentWorkspaceOperationalEventsForTests(): readonly InternalOperationalEvent[] {
  return JSON.parse(JSON.stringify(operationalEvents)) as InternalOperationalEvent[];
}

export function _flushContentWorkspaceObservabilityForTests(): boolean {
  if (scheduledFlush) {
    clearImmediate(scheduledFlush);
    scheduledFlush = null;
  }
  return flushPendingToDurable();
}

/** Reset process memory only. Durable historical counters are never erased. */
export function _resetContentWorkspaceObservabilityForTests(): void {
  if (scheduledFlush) clearImmediate(scheduledFlush);
  scheduledFlush = null;
  processAggregate = emptyAggregate();
  pendingAggregate = emptyAggregate();
  pendingDirty = false;
  operationalEvents = [];
}

function recordOperationalAggregate(
  aggregate: AggregateState,
  operation: ContentWorkspaceOperation,
  outcome: ContentWorkspaceOutcome,
  reason: ContentWorkspaceReason | undefined,
  durationMs: number | null,
): void {
  incrementReliability(aggregate, 'workspace_operation_total');
  aggregate.outcomesByOperation[operation][outcome] = saturatingAdd(
    aggregate.outcomesByOperation[operation][outcome],
    1,
  );
  if (reason) aggregate.reasons[reason] = saturatingAdd(aggregate.reasons[reason], 1);

  if (outcome === 'failure') incrementReliability(aggregate, 'workspace_operation_failure_total');
  if (outcome === 'replayed') incrementReliability(aggregate, 'idempotent_replay_total');
  if (outcome === 'conflict') incrementReliability(aggregate, 'mutation_conflict_total');
  if (operation === 'revision_save' && outcome === 'success') incrementReliability(aggregate, 'revision_save_success_total');
  if (operation === 'revision_save' && outcome === 'no_change') incrementReliability(aggregate, 'revision_save_no_change_total');
  if (operation === 'revision_restore' && outcome === 'success') incrementReliability(aggregate, 'revision_restore_success_total');
  if (operation === 'item_create' && outcome === 'success') incrementReliability(aggregate, 'item_create_success_total');
  if (operation === 'lineage_record' && outcome === 'success') incrementReliability(aggregate, 'lineage_record_success_total');
  if (reason === 'claim_safety_block') incrementReliability(aggregate, 'lineage_policy_block_total');
  if (operation === 'revision_save' && reason === 'base_revision_conflict') incrementReliability(aggregate, 'autosave_conflict_total');
  if (operation === 'generation' && outcome === 'success') incrementReliability(aggregate, 'generation_success_total');
  if (operation === 'generation' && outcome === 'failure') incrementReliability(aggregate, 'generation_failure_total');
  if (operation === 'generation' && outcome === 'blocked') incrementReliability(aggregate, 'generation_blocked_total');
  if (operation === 'proposal_create' && outcome === 'success') incrementReliability(aggregate, 'proposal_created_total');
  if (operation === 'proposal_accept' && outcome === 'accepted') incrementReliability(aggregate, 'proposal_accepted_total');
  if (operation === 'proposal_reject' && outcome === 'rejected') incrementReliability(aggregate, 'proposal_rejected_total');
  if (operation === 'proposal_accept' && outcome === 'conflict') incrementReliability(aggregate, 'proposal_conflict_total');
  if (operation === 'schedule_preview' && outcome === 'success') incrementReliability(aggregate, 'schedule_preview_success_total');
  if (operation === 'schedule_confirm' && outcome === 'success') incrementReliability(aggregate, 'schedule_confirm_success_total');
  if (operation === 'schedule_cancel' && outcome === 'success') incrementReliability(aggregate, 'schedule_cancel_success_total');
  if (operation.startsWith('schedule_') && outcome === 'failure') incrementReliability(aggregate, 'schedule_failure_total');
  if (operation.startsWith('schedule_') && outcome === 'conflict') incrementReliability(aggregate, 'schedule_conflict_total');
  if (durationMs != null) recordDuration(aggregate.timers[operation], durationMs);
}

function schedulePendingFlush(): void {
  if (scheduledFlush) return;
  scheduledFlush = setImmediate(() => {
    scheduledFlush = null;
    flushPendingToDurable();
  });
  scheduledFlush.unref?.();
}

function flushPendingToDurable(): boolean {
  if (!pendingDirty) return true;
  const delta = pendingAggregate;
  try {
    const db = getDb();
    db.transaction(() => persistAggregateDelta(db, delta)).immediate();
    pendingAggregate = emptyAggregate();
    pendingDirty = false;
    return true;
  } catch {
    return false;
  }
}

function persistAggregateDelta(db: Database.Database, delta: AggregateState): void {
  const upsertCounter = db.prepare(`
    INSERT INTO content_workspace_reliability_metrics (counter_name, metric_value)
    VALUES (?, ?)
    ON CONFLICT(counter_name) DO UPDATE SET
      metric_value = MIN(9007199254740991,
        content_workspace_reliability_metrics.metric_value + excluded.metric_value)
  `);
  for (const counter of RELIABILITY_COUNTER_NAMES) {
    if (delta.reliability[counter] > 0) upsertCounter.run(counter, delta.reliability[counter]);
  }

  const upsertOperation = db.prepare(`
    INSERT INTO content_workspace_operation_metrics (
      operation, success_count, replayed_count, no_change_count, conflict_count,
      blocked_count, failure_count, accepted_count, rejected_count,
      timer_count, timer_total_ms, timer_min_ms, timer_max_ms,
      bucket_lt_50_ms, bucket_lt_250_ms, bucket_lt_1000_ms,
      bucket_lt_5000_ms, bucket_lt_30000_ms, bucket_gte_30000_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(operation) DO UPDATE SET
      success_count = MIN(9007199254740991, success_count + excluded.success_count),
      replayed_count = MIN(9007199254740991, replayed_count + excluded.replayed_count),
      no_change_count = MIN(9007199254740991, no_change_count + excluded.no_change_count),
      conflict_count = MIN(9007199254740991, conflict_count + excluded.conflict_count),
      blocked_count = MIN(9007199254740991, blocked_count + excluded.blocked_count),
      failure_count = MIN(9007199254740991, failure_count + excluded.failure_count),
      accepted_count = MIN(9007199254740991, accepted_count + excluded.accepted_count),
      rejected_count = MIN(9007199254740991, rejected_count + excluded.rejected_count),
      timer_min_ms = CASE
        WHEN excluded.timer_count = 0 THEN timer_min_ms
        WHEN timer_count = 0 THEN excluded.timer_min_ms
        ELSE MIN(timer_min_ms, excluded.timer_min_ms)
      END,
      timer_max_ms = CASE
        WHEN excluded.timer_count = 0 THEN timer_max_ms
        WHEN timer_count = 0 THEN excluded.timer_max_ms
        ELSE MAX(timer_max_ms, excluded.timer_max_ms)
      END,
      timer_count = MIN(9007199254740991, timer_count + excluded.timer_count),
      timer_total_ms = MIN(9007199254740991, timer_total_ms + excluded.timer_total_ms),
      bucket_lt_50_ms = MIN(9007199254740991, bucket_lt_50_ms + excluded.bucket_lt_50_ms),
      bucket_lt_250_ms = MIN(9007199254740991, bucket_lt_250_ms + excluded.bucket_lt_250_ms),
      bucket_lt_1000_ms = MIN(9007199254740991, bucket_lt_1000_ms + excluded.bucket_lt_1000_ms),
      bucket_lt_5000_ms = MIN(9007199254740991, bucket_lt_5000_ms + excluded.bucket_lt_5000_ms),
      bucket_lt_30000_ms = MIN(9007199254740991, bucket_lt_30000_ms + excluded.bucket_lt_30000_ms),
      bucket_gte_30000_ms = MIN(9007199254740991, bucket_gte_30000_ms + excluded.bucket_gte_30000_ms)
  `);
  for (const operation of CONTENT_WORKSPACE_OPERATIONS) {
    const outcomes = delta.outcomesByOperation[operation];
    const timer = delta.timers[operation];
    if (!hasOperationDelta(outcomes, timer)) continue;
    upsertOperation.run(
      operation,
      outcomes.success,
      outcomes.replayed,
      outcomes.no_change,
      outcomes.conflict,
      outcomes.blocked,
      outcomes.failure,
      outcomes.accepted,
      outcomes.rejected,
      timer.count,
      timer.totalMs,
      timer.minMs,
      timer.maxMs,
      timer.buckets.lt_50_ms,
      timer.buckets.lt_250_ms,
      timer.buckets.lt_1000_ms,
      timer.buckets.lt_5000_ms,
      timer.buckets.lt_30000_ms,
      timer.buckets.gte_30000_ms,
    );
  }

  persistNamedMetrics(db, 'content_workspace_reason_metrics', 'reason', delta.reasons, CONTENT_WORKSPACE_REASONS);
  persistProductMetrics(db, delta.product);
  persistNamedMetrics(db, 'content_workspace_quality_metrics', 'signal', delta.quality, CONTENT_WORKSPACE_QUALITY_SIGNALS);
}

function persistNamedMetrics<T extends string>(
  db: Database.Database,
  table: string,
  keyColumn: string,
  values: Record<T, number>,
  keys: readonly T[],
): void {
  const statement = db.prepare(`
    INSERT INTO ${table} (${keyColumn}, metric_value)
    VALUES (?, ?)
    ON CONFLICT(${keyColumn}) DO UPDATE SET
      metric_value = MIN(9007199254740991, ${table}.metric_value + excluded.metric_value)
  `);
  for (const key of keys) {
    if (values[key] > 0) statement.run(key, values[key]);
  }
}

function persistProductMetrics(
  db: Database.Database,
  values: Record<ContentWorkspaceProductSignal, number>,
): void {
  const statement = db.prepare(`
    INSERT INTO content_workspace_product_metrics (signal, metric_value)
    VALUES (?, ?)
    ON CONFLICT(signal) DO UPDATE SET
      metric_value = MIN(9007199254740991,
        content_workspace_product_metrics.metric_value + excluded.metric_value)
  `);
  for (const signal of CONTENT_WORKSPACE_PRODUCT_SIGNALS) {
    if (values[signal] > 0) statement.run(storedProductSignal(signal), values[signal]);
  }
}

function readDurableAggregate(db: Database.Database): AggregateState {
  const aggregate = emptyAggregate();
  for (const row of db.prepare(`
    SELECT counter_name, metric_value FROM content_workspace_reliability_metrics
  `).all() as Array<{ counter_name: string; metric_value: number }>) {
    if (isMember(RELIABILITY_COUNTER_NAMES, row.counter_name)) {
      aggregate.reliability[row.counter_name] = safeMetric(row.metric_value);
    }
  }
  for (const row of db.prepare('SELECT * FROM content_workspace_operation_metrics').all() as Array<Record<string, unknown>>) {
    const operation = String(row.operation ?? '');
    if (!isMember(CONTENT_WORKSPACE_OPERATIONS, operation)) continue;
    aggregate.outcomesByOperation[operation] = {
      success: safeMetric(row.success_count),
      replayed: safeMetric(row.replayed_count),
      no_change: safeMetric(row.no_change_count),
      conflict: safeMetric(row.conflict_count),
      blocked: safeMetric(row.blocked_count),
      failure: safeMetric(row.failure_count),
      accepted: safeMetric(row.accepted_count),
      rejected: safeMetric(row.rejected_count),
    };
    aggregate.timers[operation] = {
      count: safeMetric(row.timer_count),
      totalMs: safeMetric(row.timer_total_ms),
      minMs: safeNullableMetric(row.timer_min_ms),
      maxMs: safeNullableMetric(row.timer_max_ms),
      buckets: {
        lt_50_ms: safeMetric(row.bucket_lt_50_ms),
        lt_250_ms: safeMetric(row.bucket_lt_250_ms),
        lt_1000_ms: safeMetric(row.bucket_lt_1000_ms),
        lt_5000_ms: safeMetric(row.bucket_lt_5000_ms),
        lt_30000_ms: safeMetric(row.bucket_lt_30000_ms),
        gte_30000_ms: safeMetric(row.bucket_gte_30000_ms),
      },
    };
  }
  readNamedMetrics(db, 'content_workspace_reason_metrics', 'reason', CONTENT_WORKSPACE_REASONS, aggregate.reasons);
  readProductMetrics(db, aggregate.product);
  readNamedMetrics(db, 'content_workspace_quality_metrics', 'signal', CONTENT_WORKSPACE_QUALITY_SIGNALS, aggregate.quality);
  return aggregate;
}

function readNamedMetrics<T extends string>(
  db: Database.Database,
  table: string,
  keyColumn: string,
  keys: readonly T[],
  target: Record<T, number>,
): void {
  const rows = db.prepare(`SELECT ${keyColumn} AS metric_key, metric_value FROM ${table}`).all() as Array<{
    metric_key: string;
    metric_value: number;
  }>;
  for (const row of rows) {
    if (isMember(keys, row.metric_key)) target[row.metric_key] = safeMetric(row.metric_value);
  }
}

function readProductMetrics(
  db: Database.Database,
  target: Record<ContentWorkspaceProductSignal, number>,
): void {
  const rows = db.prepare(`
    SELECT signal, metric_value FROM content_workspace_product_metrics
  `).all() as Array<{ signal: string; metric_value: number }>;
  for (const row of rows) {
    const signal = publicProductSignal(row.signal);
    if (signal) target[signal] = safeMetric(row.metric_value);
  }
}

function emptyAggregate(): AggregateState {
  return {
    reliability: Object.fromEntries(RELIABILITY_COUNTER_NAMES.map((name) => [name, 0])) as Record<ReliabilityCounter, number>,
    outcomesByOperation: Object.fromEntries(CONTENT_WORKSPACE_OPERATIONS.map((operation) => [
      operation,
      Object.fromEntries(CONTENT_WORKSPACE_OUTCOMES.map((outcome) => [outcome, 0])),
    ])) as Record<ContentWorkspaceOperation, Record<ContentWorkspaceOutcome, number>>,
    timers: Object.fromEntries(CONTENT_WORKSPACE_OPERATIONS.map((operation) => [operation, emptyTimer()])) as Record<ContentWorkspaceOperation, TimerAggregate>,
    reasons: Object.fromEntries(CONTENT_WORKSPACE_REASONS.map((reason) => [reason, 0])) as Record<ContentWorkspaceReason, number>,
    product: Object.fromEntries(CONTENT_WORKSPACE_PRODUCT_SIGNALS.map((signal) => [signal, 0])) as Record<ContentWorkspaceProductSignal, number>,
    quality: Object.fromEntries(CONTENT_WORKSPACE_QUALITY_SIGNALS.map((signal) => [signal, 0])) as Record<ContentWorkspaceQualitySignal, number>,
  };
}

function snapshotFromAggregate(
  aggregate: AggregateState,
  storage: Pick<ContentWorkspaceObservabilitySnapshot['storage'],
    'mode' | 'durableAvailable' | 'includesHistoricalTotals' | 'pendingWrite'>,
): ContentWorkspaceObservabilitySnapshot {
  return {
    schemaVersion: CONTENT_WORKSPACE_OBSERVABILITY_SCHEMA_VERSION,
    privacy: {
      taxonomy: 'closed_taxonomy_only',
      operational: 'bounded_identity_free',
      product: 'aggregate_only',
      quality: 'aggregate_only',
      rawContentLogged: false,
      scopeIdentifiersLogged: false,
      contentFingerprintsLogged: false,
      operationalEventRingExposed: false,
    },
    storage: {
      ...storage,
      durableStore: 'sqlite_aggregate',
      bestEffortWrites: true,
      userOperationFailurePropagation: false,
    },
    publicationTracking: {
      status: 'unavailable',
      publicationEvidence: false,
      reasonCode: 'EXTERNAL_PUBLICATION_RECEIPTS_UNAVAILABLE',
      internalWorkflowStateMetric: 'internal_workflow_published_state',
    },
    ...aggregate,
  };
}

function mergeAggregates(left: AggregateState, right: AggregateState): AggregateState {
  const merged = cloneAggregate(left);
  for (const counter of RELIABILITY_COUNTER_NAMES) {
    merged.reliability[counter] = saturatingAdd(merged.reliability[counter], right.reliability[counter]);
  }
  for (const operation of CONTENT_WORKSPACE_OPERATIONS) {
    for (const outcome of CONTENT_WORKSPACE_OUTCOMES) {
      merged.outcomesByOperation[operation][outcome] = saturatingAdd(
        merged.outcomesByOperation[operation][outcome],
        right.outcomesByOperation[operation][outcome],
      );
    }
    mergeTimer(merged.timers[operation], right.timers[operation]);
  }
  for (const reason of CONTENT_WORKSPACE_REASONS) {
    merged.reasons[reason] = saturatingAdd(merged.reasons[reason], right.reasons[reason]);
  }
  for (const signal of CONTENT_WORKSPACE_PRODUCT_SIGNALS) {
    merged.product[signal] = saturatingAdd(merged.product[signal], right.product[signal]);
  }
  for (const signal of CONTENT_WORKSPACE_QUALITY_SIGNALS) {
    merged.quality[signal] = saturatingAdd(merged.quality[signal], right.quality[signal]);
  }
  return merged;
}

function mergeTimer(target: TimerAggregate, delta: TimerAggregate): void {
  target.count = saturatingAdd(target.count, delta.count);
  target.totalMs = saturatingAdd(target.totalMs, delta.totalMs);
  if (delta.minMs != null) target.minMs = target.minMs == null ? delta.minMs : Math.min(target.minMs, delta.minMs);
  if (delta.maxMs != null) target.maxMs = target.maxMs == null ? delta.maxMs : Math.max(target.maxMs, delta.maxMs);
  for (const bucket of DURATION_BUCKETS) {
    target.buckets[bucket] = saturatingAdd(target.buckets[bucket], delta.buckets[bucket]);
  }
}

function recordDuration(timer: TimerAggregate, durationMs: number): void {
  timer.count = saturatingAdd(timer.count, 1);
  timer.totalMs = saturatingAdd(timer.totalMs, durationMs);
  timer.minMs = timer.minMs == null ? durationMs : Math.min(timer.minMs, durationMs);
  timer.maxMs = timer.maxMs == null ? durationMs : Math.max(timer.maxMs, durationMs);
  const bucket = durationBucketFor(durationMs);
  timer.buckets[bucket] = saturatingAdd(timer.buckets[bucket], 1);
}

function emptyTimer(): TimerAggregate {
  return {
    count: 0,
    totalMs: 0,
    minMs: null,
    maxMs: null,
    buckets: Object.fromEntries(DURATION_BUCKETS.map((bucket) => [bucket, 0])) as Record<DurationBucket, number>,
  };
}

function hasOperationDelta(
  outcomes: Record<ContentWorkspaceOutcome, number>,
  timer: TimerAggregate,
): boolean {
  return timer.count > 0 || CONTENT_WORKSPACE_OUTCOMES.some((outcome) => outcomes[outcome] > 0);
}

function incrementReliability(aggregate: AggregateState, counter: ReliabilityCounter): void {
  aggregate.reliability[counter] = saturatingAdd(aggregate.reliability[counter], 1);
}

function durationBucketFor(durationMs: number): DurationBucket {
  if (durationMs < 50) return 'lt_50_ms';
  if (durationMs < 250) return 'lt_250_ms';
  if (durationMs < 1_000) return 'lt_1000_ms';
  if (durationMs < 5_000) return 'lt_5000_ms';
  if (durationMs < 30_000) return 'lt_30000_ms';
  return 'gte_30000_ms';
}

function normalizeDuration(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.min(MAX_DURATION_MS, Math.round(value));
}

function saturatingAdd(left: number, right: number): number {
  if (left >= MAX_METRIC || right >= MAX_METRIC - left) return MAX_METRIC;
  return left + right;
}

function safeMetric(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return 0;
  return Math.min(MAX_METRIC, numeric);
}

function safeNullableMetric(value: unknown): number | null {
  return value == null ? null : safeMetric(value);
}

function isMember<T extends string>(values: readonly T[], value: string): value is T {
  return values.includes(value as T);
}

function cloneAggregate(value: AggregateState): AggregateState {
  return JSON.parse(JSON.stringify(value)) as AggregateState;
}

function cloneSnapshot(value: ContentWorkspaceObservabilitySnapshot): ContentWorkspaceObservabilitySnapshot {
  return JSON.parse(JSON.stringify(value)) as ContentWorkspaceObservabilitySnapshot;
}
