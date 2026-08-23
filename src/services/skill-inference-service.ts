// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import { getDb } from './database';
import { getEffectiveEntitlement } from './entitlement';
import { isFreeTierLocalOnlyBindingEnabled, isLocalOnlyBoundPlan } from './free-tier-inference-binding';
import { ensureActiveProvider } from './provider-registry';
import { getLocalModelManifest } from './ollama-model-policy';
import { runWithApiUsageAttribution, type AiRequestSource } from './api-usage-attribution';
import {
  getSkillInferenceProfile,
  profileAllowsRisk,
  type SkillInferenceExecutionClass,
  type SkillInferenceRiskClass,
  type SkillInferenceSkill,
} from './skill-inference-profiles';
import type { AiBudgetRequest } from './cost-guardrail';
import { getLocalInferenceRuntimeControl } from './local-inference-runtime-control';
import { localPrimaryInferenceConfig } from './local-primary-config';
import {
  LocalInferenceCapacityError,
  localInferenceScheduler,
} from './local-inference-scheduler';
import { LocalLLMError } from './local-llm-error';
import { validateStructuredOutputValue } from './structured-output-schema';
import { recordCriticalLocalInferenceSafetyIncident } from './local-inference-safety-incidents';
import { isLocalInferenceUserEnrolled } from './local-inference-enrollment';
import {
  buildLocalPrimaryShadowCategory,
  LOCAL_PRIMARY_SHADOW_JOB_NAME,
} from './local-inference-vocabulary';
import {
  isLocalFairUseExemptFailureReason,
  LOCAL_FAIR_USE_EXEMPT_FAILURE_REASONS,
  localInferenceFailureReason,
} from './local-inference-failure-taxonomy';
import {
  assertSkillInferenceNotCancelled as assertInferenceNotCancelled,
  isSkillInferenceAccountDeletionFenced,
  runWithSkillInferenceAccountAdmission,
  SkillInferencePolicyError,
} from './skill-inference-account-lifecycle';
import type { StructuredGenerationBatchControl } from './ai-provider';
export {
  beginSkillInferenceAccountDeletionFence,
  clearSkillInferenceAccountDeletionFence,
  isSkillInferenceAccountDeletionError,
  isSkillInferenceAccountDeletionFenced,
  runWithSkillInferenceAccountAdmission,
  SkillInferencePolicyError,
  waitForSkillInferenceAccountAdmissionsToDrain,
} from './skill-inference-account-lifecycle';
export { LOCAL_FAIR_USE_EXEMPT_FAILURE_REASONS } from './local-inference-failure-taxonomy';
export { isLocalInferenceUserEnrolled } from './local-inference-enrollment';
export {
  getLocalInferenceRuntimeControl,
  setLocalInferenceRuntimeControl,
  type LocalInferenceMode,
  type LocalInferenceRuntimeControlView,
} from './local-inference-runtime-control';

export interface SkillInferenceRequest {
  tenantId: number;
  userId: number;
  skillId: SkillInferenceSkill;
  taskType: string;
  riskClass: SkillInferenceRiskClass;
  executionClass: SkillInferenceExecutionClass;
  operationId: string;
  runId?: string;
  prompt: string;
  applicationGuidance?: string;
  schemaId: string;
  outputSchema?: unknown;
  requestedOutputTokens?: number;
  temperature?: number;
  containsPrivateData: boolean;
  allowCloudEscalation: boolean;
  redactionRequired?: boolean;
  /** Addendum C: delivery class for script-job stages — selects the bound
   * cloud tier at the reasoning gate when escalation is permitted. */
  scriptDeliveryMode?: 'standard' | 'scheduled' | 'priority';
  /** Server-owned destination constraint for owner-approved cloud exports. */
  requiredCloudProvider?: 'openai';
  /** Durable caller-owned state required when the selected transport is Batch. */
  durableBatch?: StructuredGenerationBatchControl;
  requestSource: AiRequestSource;
  budgetRequest: AiBudgetRequest;
  cloudBudgetBoundary: <T>(request: AiBudgetRequest, providerCall: () => Promise<T>) => Promise<T>;
  abortSignal?: AbortSignal;
  deadlineMs?: number;
}

export interface SkillInferenceResult {
  text: string;
  parsed?: unknown;
  provider: string;
  route: 'local' | 'cloud';
  model?: string;
  modelDigest?: string;
  fallbackReason?: string;
  runId: string;
  operationId: string;
  validationStatus: 'valid' | 'not_requested';
  queueWaitMs: number;
  firstTokenMs?: number;
  throughputTokensPerSecond?: number;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  durationMs: number;
}

function normalizeSkillInferenceBoundaryError(error: unknown): unknown {
  if (error instanceof LocalInferenceCapacityError) {
    return new SkillInferencePolicyError(error.code, error.message, 503);
  }
  if (error instanceof LocalLLMError) {
    return Object.assign(new SkillInferencePolicyError(
      error.kind,
      error.message,
      error.status,
      { ...error.meta, localLlmKind: error.kind, retryable: error.retryable },
    ), { cause: error });
  }
  return error;
}

interface PlanLocalPolicy {
  hourly: number;
  daily: number;
  contextTokens: number;
  outputTokens: number;
  queueWeight: number;
  cloudFallbackRunUsd: number;
  cloudFallbackDailyUsd: number;
}

interface PersistedPlanLocalPolicy {
  local_operations_hourly: number;
  local_operations_daily: number;
  ordinary_context_tokens: number;
  content_context_tokens: number;
  script_segment_output_tokens: number;
  local_queue_weight: number;
  local_cloud_fallback_run_usd: number;
  local_cloud_fallback_daily_usd: number;
}

const localFairUseFailurePlaceholders = LOCAL_FAIR_USE_EXEMPT_FAILURE_REASONS
  .map(() => '?')
  .join(', ');

function compiledPlanPolicy(plan: string, content: boolean): PlanLocalPolicy {
  if (plan === 'owner') return {
    hourly: 1000,
    daily: 10000,
    contextTokens: 16384,
    outputTokens: content ? 6144 : 4096,
    queueWeight: 4,
    cloudFallbackRunUsd: 2,
    cloudFallbackDailyUsd: 10,
  };
  if (plan === 'max') return { hourly: 40, daily: 200, contextTokens: content ? 16384 : 12288, outputTokens: content ? 6144 : 4096, queueWeight: 2, cloudFallbackRunUsd: 0.25, cloudFallbackDailyUsd: 0.60 };
  if (plan === 'pro') return { hourly: 20, daily: 100, contextTokens: content ? 12288 : 8192, outputTokens: content ? 5120 : 4096, queueWeight: 1, cloudFallbackRunUsd: 0.15, cloudFallbackDailyUsd: 0.40 };
  // Plan §1 row 1 / §2: with the free-tier local-only binding active, free
  // and beta accounts get the Free local policy (5 daily local operations
  // matching the daily credit cap, zero cloud budget). Migration 289 persists
  // the same values in plan_configs; this compiled fallback keeps the lane
  // usable if that row is missing or corrupt. Binding OFF keeps the
  // historical no-local-operations policy.
  if ((plan === 'free' || plan === 'beta') && isFreeTierLocalOnlyBindingEnabled()) {
    return { hourly: 5, daily: 5, contextTokens: 4096, outputTokens: 2048, queueWeight: 1, cloudFallbackRunUsd: 0, cloudFallbackDailyUsd: 0 };
  }
  return { hourly: 0, daily: 0, contextTokens: 0, outputTokens: 0, queueWeight: 0, cloudFallbackRunUsd: 0, cloudFallbackDailyUsd: 0 };
}

function isBoundedPlanInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function isBoundedPlanDecimal(value: unknown, maximum: number): value is number {
  return Number.isFinite(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function isValidPersistedPlanPolicy(row: PersistedPlanLocalPolicy): boolean {
  if (!isBoundedPlanInteger(row.local_operations_hourly, 10_000)
      || !isBoundedPlanInteger(row.local_operations_daily, 100_000)
      || !isBoundedPlanInteger(row.ordinary_context_tokens, 16_384)
      || !isBoundedPlanInteger(row.content_context_tokens, 16_384)
      || !isBoundedPlanInteger(row.script_segment_output_tokens, 6_144)
      || !isBoundedPlanInteger(row.local_queue_weight, 10)
      || !isBoundedPlanDecimal(row.local_cloud_fallback_run_usd, 100)
      || !isBoundedPlanDecimal(row.local_cloud_fallback_daily_usd, 1_000)) {
    return false;
  }
  return row.local_operations_hourly <= row.local_operations_daily
    && row.ordinary_context_tokens <= row.content_context_tokens
    && row.script_segment_output_tokens <= row.content_context_tokens
    && row.local_cloud_fallback_run_usd <= row.local_cloud_fallback_daily_usd;
}

function readPlanPolicy(userId: number, content: boolean, db: Database.Database): PlanLocalPolicy {
  const plan = getEffectiveEntitlement(userId).plan;
  const fallback = compiledPlanPolicy(plan, content);
  try {
    const row = db.prepare(`
      SELECT local_operations_hourly, local_operations_daily,
             ordinary_context_tokens, content_context_tokens,
             script_segment_output_tokens, local_queue_weight,
             local_cloud_fallback_run_usd, local_cloud_fallback_daily_usd
      FROM plan_configs
      WHERE plan_id = ? AND active = 1
    `).get(plan) as PersistedPlanLocalPolicy | undefined;
    // Portal writes validate these bounds, but runtime readers must also defend
    // against predecessor/manual/corrupt rows. Falling back to compiled limits
    // preserves availability without allowing persisted data to enlarge policy.
    if (!row || !isValidPersistedPlanPolicy(row)) return fallback;
    return {
      hourly: row.local_operations_hourly,
      daily: row.local_operations_daily,
      contextTokens: content ? row.content_context_tokens : row.ordinary_context_tokens,
      outputTokens: content ? row.script_segment_output_tokens : Math.min(4096, row.script_segment_output_tokens),
      queueWeight: row.local_queue_weight,
      cloudFallbackRunUsd: row.local_cloud_fallback_run_usd,
      cloudFallbackDailyUsd: row.local_cloud_fallback_daily_usd,
    };
  } catch {
    return fallback;
  }
}

export function getSkillInferenceCloudFallbackCostCaps(
  userId: number,
  db: Database.Database = getDb(),
): { perRunUsd: number; perDayUsd: number } {
  const policy = readPlanPolicy(userId, false, db);
  return {
    perRunUsd: policy.cloudFallbackRunUsd,
    perDayUsd: policy.cloudFallbackDailyUsd,
  };
}

function minimumPositiveCap(configured: number | undefined, planCap: number): number {
  if (!Number.isFinite(planCap) || planCap <= 0) return 0;
  return Number.isFinite(configured) && Number(configured) > 0
    ? Math.min(Number(configured), planCap)
    : planCap;
}

function assertLocalFairUse(
  db: Database.Database,
  request: SkillInferenceRequest,
  policy: PlanLocalPolicy,
): void {
  if (policy.hourly <= 0 || policy.daily <= 0) {
    throw new SkillInferencePolicyError('LOCAL_PLAN_REQUIRED', 'This plan does not include model-backed local operations.', 403);
  }
  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour') THEN operation_id END) AS hourly,
      COUNT(DISTINCT CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') THEN operation_id END) AS daily
    FROM skill_inference_runs
    WHERE tenant_id = ? AND user_id = ? AND local_admission_requested = 1
      AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
      AND NOT (
        status = 'failed'
        AND fallback_reason IN (${localFairUseFailurePlaceholders})
      )
  `).get(
    request.tenantId,
    request.userId,
    ...LOCAL_FAIR_USE_EXEMPT_FAILURE_REASONS,
  ) as { hourly: number; daily: number };
  const sameOperation = db.prepare(`
    SELECT 1 AS present FROM skill_inference_runs
    WHERE tenant_id = ? AND user_id = ? AND operation_id = ?
      AND local_admission_requested = 1
      AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
      AND NOT (
        status = 'failed'
        AND fallback_reason IN (${localFairUseFailurePlaceholders})
      )
    LIMIT 1
  `).get(
    request.tenantId,
    request.userId,
    request.operationId,
    ...LOCAL_FAIR_USE_EXEMPT_FAILURE_REASONS,
  ) as { present: number } | undefined;
  if (!sameOperation && (row.hourly >= policy.hourly || row.daily >= policy.daily)) {
    throw new SkillInferencePolicyError('LOCAL_FAIR_USE_REACHED', 'Local model fair-use limit reached.', 429, {
      hourlyLimit: policy.hourly,
      dailyLimit: policy.daily,
    });
  }
}

function insertRun(db: Database.Database, input: {
  request: SkillInferenceRequest;
  runId: string;
  contextTokens: number;
  outputTokens: number;
  profileVersion: string;
  planId: string;
  localAdmissionRequested: boolean;
  evaluationMode: 'production' | 'shadow';
}): void {
  db.prepare(`
    INSERT INTO skill_inference_runs (
      run_id, operation_id, tenant_id, user_id, plan_id, skill_id, task_type,
      risk_class, execution_class, evaluation_mode, local_admission_requested, profile_version, status, schema_id,
      context_limit_tokens, output_limit_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?, ?, ?)
  `).run(
    input.runId,
    input.request.operationId,
    input.request.tenantId,
    input.request.userId,
    input.planId,
    input.request.skillId,
    input.request.taskType,
    input.request.riskClass,
    input.request.executionClass,
    input.evaluationMode,
    input.localAdmissionRequested ? 1 : 0,
    input.profileVersion,
    input.request.schemaId,
    input.contextTokens,
    input.outputTokens,
  );
}

function completeRun(db: Database.Database, input: {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  result?: SkillInferenceResult;
  fallbackReason?: string;
  finalRouteOverride?: 'local' | 'cloud' | 'none';
}): void {
  const result = input.result;
  const failureReason = result?.fallbackReason ?? input.fallbackReason ?? null;
  const validationStatus = result?.validationStatus
    ?? (failureReason && /(invalid_json|schema.*invalid)/i.test(failureReason) ? 'invalid' : null);
  db.prepare(`
    UPDATE skill_inference_runs
       SET status = ?, final_route = ?, provider = ?, model_id = ?, model_digest = ?,
           validation_status = ?, fallback_reason = ?, queue_wait_ms = ?, first_token_ms = ?,
           generation_tokens_per_second = ?, input_tokens = ?, output_tokens = ?,
           duration_ms = ?, completed_at = ?, updated_at = ?
     WHERE run_id = ?
  `).run(
    input.status,
    input.finalRouteOverride ?? result?.route ?? 'none',
    result?.provider ?? null,
    result?.model ?? null,
    result?.modelDigest ?? null,
    validationStatus,
    failureReason,
    result?.queueWaitMs ?? null,
    result?.firstTokenMs ?? null,
    result?.throughputTokensPerSecond ?? null,
    result?.inputTokens ?? null,
    result?.outputTokens ?? null,
    result?.durationMs ?? null,
    new Date().toISOString(),
    new Date().toISOString(),
    input.runId,
  );
}

function normalizedAttemptProvider(provider: string, route: 'local' | 'cloud'): string {
  return provider.trim().slice(0, 160) || (route === 'local' ? 'ollama' : 'cloud-gate');
}

function insertAttempt(db: Database.Database, input: {
  runId: string;
  attemptNumber: number;
  route: 'local' | 'cloud';
  provider: string;
  model?: string;
  modelDigest?: string;
  outcome: 'success' | 'failure' | 'cancelled';
  failureReason?: string;
  queueWaitMs?: number;
  firstTokenMs?: number;
  throughput?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
}): void {
  db.prepare(`
    INSERT INTO skill_inference_attempts (
      run_id, attempt_number, route, provider, model_id, model_digest,
      outcome, failure_reason, queue_wait_ms, first_token_ms,
      generation_tokens_per_second, input_tokens, output_tokens, duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.runId, input.attemptNumber, input.route,
    normalizedAttemptProvider(input.provider, input.route),
    input.model ?? null, input.modelDigest ?? null, input.outcome,
    input.failureReason ?? null, input.queueWaitMs ?? null,
    input.firstTokenMs ?? null, input.throughput ?? null,
    input.inputTokens ?? null, input.outputTokens ?? null, input.durationMs,
  );
}

function safeFailureReason(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown; kind?: unknown }).code
      ?? (error as { kind?: unknown }).kind;
    if (typeof code === 'string' && code) return code.slice(0, 160);
  }
  return error instanceof Error ? error.name.slice(0, 160) : 'unknown_failure';
}

function safeDetachedFailureEvidence(error: unknown): {
  failureReason: string;
  constraint?: string;
} {
  const evidence: { failureReason: string; constraint?: string } = {
    failureReason: safeFailureReason(error),
  };
  if (error instanceof Error) {
    const match = /^(?:NOT NULL|CHECK|UNIQUE) constraint failed: ([a-z0-9_.]+)$/iu.exec(error.message);
    if (match) evidence.constraint = match[1];
  }
  return evidence;
}

export function getLatestSkillInferenceOperationRunId(input: {
  operationId: string;
  tenantId: number;
  userId: number;
}, db: Database.Database = getDb()): string | null {
  const row = db.prepare(`SELECT run_id FROM skill_inference_runs
    WHERE operation_id = ? AND tenant_id = ? AND user_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(input.operationId, input.tenantId, input.userId) as { run_id: string } | undefined;
  return row?.run_id ?? null;
}

export type SkillInferenceExternalCloudFallbackEligibility =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'run_missing' | 'scope_mismatch' | 'not_failed' | 'cancelled' | 'already_completed'
        | 'free_tier_local_only'
        | 'account_deletion_in_progress';
    };

function isExternalFallbackCancellationReason(reason: string | null): boolean {
  if (!reason) return false;
  return reason === 'ACCOUNT_DELETION_IN_PROGRESS'
    || /(?:^|_)(?:abort(?:ed)?|cancel(?:ed|led)?|disconnected)(?:$|_)/iu.test(reason);
}

/**
 * Read-only admission check for a cloud attempt owned by an outer
 * orchestrator. Only a persisted, failed run is eligible: this makes the
 * attempt ledger mandatory and prevents a post-delivery call from reaching a
 * provider before the recorder can reject it.
 */
export function getSkillInferenceExternalCloudFallbackEligibility(input: {
  runId: string;
  tenantId: number;
  userId: number;
}, db: Database.Database = getDb()): SkillInferenceExternalCloudFallbackEligibility {
  if (isSkillInferenceAccountDeletionFenced(input.userId, db)) {
    return { allowed: false, reason: 'account_deletion_in_progress' };
  }
  // Plan §1 row 1: locally-bound accounts never take the external cloud
  // fallback; the orchestrator surfaces the retryable capacity response.
  if (isFreeTierLocalOnlyBindingEnabled()
      && isLocalOnlyBoundPlan(getEffectiveEntitlement(input.userId).plan)) {
    return { allowed: false, reason: 'free_tier_local_only' };
  }
  const run = db.prepare(`SELECT status, final_route, fallback_reason FROM skill_inference_runs
    WHERE run_id = ? AND tenant_id = ? AND user_id = ?`)
    .get(input.runId, input.tenantId, input.userId) as {
      status: string;
      final_route: string | null;
      fallback_reason: string | null;
    } | undefined;
  if (!run) {
    const differentlyScopedRun = db.prepare(`SELECT 1 AS present FROM skill_inference_runs
      WHERE run_id = ? LIMIT 1`).get(input.runId) as { present: number } | undefined;
    return differentlyScopedRun
      ? { allowed: false, reason: 'scope_mismatch' }
      : { allowed: false, reason: 'run_missing' };
  }
  if (run.status === 'cancelled' || isExternalFallbackCancellationReason(run.fallback_reason)) {
    return { allowed: false, reason: 'cancelled' };
  }
  if (run.status === 'completed' || run.final_route === 'local' || run.final_route === 'cloud') {
    return { allowed: false, reason: 'already_completed' };
  }
  if (run.status !== 'failed') return { allowed: false, reason: 'not_failed' };
  return { allowed: true };
}

/**
 * Attach a privacy-reduced cloud fallback performed by an outer orchestrator
 * to the local attempt that triggered it. The outer call is allowed to send a
 * different, server-built packet; SkillInferenceService never reuses the raw
 * private prompt for this transition.
 */
export function recordSkillInferenceExternalCloudAttempt(input: {
  runId: string;
  tenantId: number;
  userId: number;
  outcome: 'success' | 'failure' | 'cancelled';
  provider: string;
  model?: string;
  fallbackReason: string;
  durationMs: number;
  firstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}, db: Database.Database = getDb()): void {
  const provider = normalizedAttemptProvider(input.provider, 'cloud');
  const outcome = db.transaction(():
    | 'recorded'
    | 'forbidden_after_delivery'
    | 'scope_mismatch'
    | 'run_missing'
    | 'invalid_state' => {
    const run = db.prepare(`SELECT status, final_route, fallback_reason FROM skill_inference_runs
      WHERE run_id = ? AND tenant_id = ? AND user_id = ?`)
      .get(input.runId, input.tenantId, input.userId) as {
        status: string;
        final_route: string | null;
        fallback_reason: string | null;
      } | undefined;
    if (!run) {
      const differentlyScopedRun = db.prepare(`SELECT 1 AS present FROM skill_inference_runs
        WHERE run_id = ? LIMIT 1`).get(input.runId) as { present: number } | undefined;
      return differentlyScopedRun ? 'scope_mismatch' : 'run_missing';
    }
    if (isExternalFallbackCancellationReason(run.fallback_reason)) return 'invalid_state';
    if (run.status === 'completed' || run.final_route === 'local' || run.final_route === 'cloud') {
      return 'forbidden_after_delivery';
    }
    // The read-only eligibility check happens before the provider call, but a
    // cancellation/retry may race that call. Re-check under an IMMEDIATE
    // transaction and never append cloud evidence to a running, admitted, or
    // cancelled run.
    if (run.status !== 'failed') return 'invalid_state';
    const next = (db.prepare(`SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
      FROM skill_inference_attempts WHERE run_id = ?`)
      .get(input.runId) as { attempt_number: number }).attempt_number;
    insertAttempt(db, {
      runId: input.runId,
      attemptNumber: next,
      route: 'cloud',
      provider,
      model: input.model,
      outcome: input.outcome,
      failureReason: input.outcome === 'success' ? undefined : input.fallbackReason,
      firstTokenMs: input.firstTokenMs,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      durationMs: Math.max(0, Math.floor(input.durationMs)),
    });
    if (input.outcome === 'success') {
      const timestamp = new Date().toISOString();
      db.prepare(`UPDATE skill_inference_runs
        SET status = 'completed', final_route = 'cloud', provider = ?, model_id = ?,
            model_digest = NULL, generation_tokens_per_second = NULL,
            fallback_reason = ?, first_token_ms = COALESCE(?, first_token_ms),
            input_tokens = COALESCE(?, input_tokens), output_tokens = COALESCE(?, output_tokens),
            duration_ms = COALESCE(duration_ms, 0) + ?, completed_at = ?, updated_at = ?
        WHERE run_id = ? AND tenant_id = ? AND user_id = ? AND status = 'failed'`)
        .run(
          provider,
          input.model ?? null,
          input.fallbackReason,
          input.firstTokenMs ?? null,
          input.inputTokens ?? null,
          input.outputTokens ?? null,
          Math.max(0, Math.floor(input.durationMs)),
          timestamp,
          timestamp,
          input.runId,
          input.tenantId,
          input.userId,
        );
    } else if (input.outcome === 'cancelled') {
      const timestamp = new Date().toISOString();
      db.prepare(`UPDATE skill_inference_runs
        SET status = 'cancelled', final_route = 'none', fallback_reason = ?,
            duration_ms = COALESCE(duration_ms, 0) + ?, completed_at = ?, updated_at = ?
        WHERE run_id = ? AND tenant_id = ? AND user_id = ? AND status = 'failed'`)
        .run(
          input.fallbackReason,
          Math.max(0, Math.floor(input.durationMs)),
          timestamp,
          timestamp,
          input.runId,
          input.tenantId,
          input.userId,
        );
    }
    return 'recorded';
  }).immediate();
  if (outcome === 'scope_mismatch') {
    try {
      recordCriticalLocalInferenceSafetyIncident({
        code: 'tenant_isolation_escape',
        source: 'recordSkillInferenceExternalCloudAttempt',
        tenantId: input.tenantId,
        userId: input.userId,
        runId: input.runId,
        blocked: true,
      }, db);
    } catch {
      // The incident service has already tripped the process-local OFF latch.
      // Preserve the authenticated caller contract instead of exposing a raw
      // storage failure.
    }
    throw new SkillInferencePolicyError(
      'INFERENCE_SCOPE_INVALID',
      'The inference run does not belong to this authenticated scope.',
      403,
    );
  }
  if (outcome === 'forbidden_after_delivery') {
    try {
      recordCriticalLocalInferenceSafetyIncident({
        code: 'post_delivery_fallback_attempt',
        source: 'recordSkillInferenceExternalCloudAttempt',
        tenantId: input.tenantId,
        userId: input.userId,
        runId: input.runId,
        blocked: true,
      }, db);
    } catch {
      // The incident service has already tripped the process-local OFF latch.
    }
    throw new SkillInferencePolicyError(
      'POST_DELIVERY_CLOUD_FALLBACK_FORBIDDEN',
      'Cloud fallback is forbidden after a local result has been delivered.',
      409,
    );
  }
  if (outcome === 'run_missing') {
    throw new SkillInferencePolicyError(
      'INFERENCE_RUN_NOT_FOUND',
      'The inference run no longer exists.',
      404,
    );
  }
  if (outcome === 'invalid_state') {
    throw new SkillInferencePolicyError(
      'EXTERNAL_CLOUD_FALLBACK_STATE_INVALID',
      'Cloud fallback can only be attached to a persisted failed inference run.',
      409,
    );
  }
}

export function rejectSkillInferenceApplicationResult(input: {
  runId: string;
  tenantId: number;
  userId: number;
  reason: string;
}, db: Database.Database = getDb()): void {
  const timestamp = new Date().toISOString();
  db.prepare(`UPDATE skill_inference_runs
    SET status = 'failed', final_route = 'none', validation_status = 'invalid',
        fallback_reason = ?, completed_at = ?, updated_at = ?
    WHERE run_id = ? AND tenant_id = ? AND user_id = ? AND status = 'completed'
      AND final_route IN ('local', 'cloud')`)
    .run(
      input.reason.trim().slice(0, 160) || 'application_validation_failed',
      timestamp,
      timestamp,
      input.runId,
      input.tenantId,
      input.userId,
    );
}

/**
 * Reject every completed local stage that contributed to one user-visible
 * operation. Chat may perform a bounded repair under a second run id; if the
 * final composed answer fails an application validator, neither stage is a
 * successful delivered outcome for quality or pricing evidence.
 */
export function rejectSkillInferenceApplicationOperationResults(input: {
  operationId: string;
  tenantId: number;
  userId: number;
  reason: string;
}, db: Database.Database = getDb()): void {
  const timestamp = new Date().toISOString();
  db.prepare(`UPDATE skill_inference_runs
    SET status = 'failed', final_route = 'none', validation_status = 'invalid',
        fallback_reason = ?, completed_at = ?, updated_at = ?
    WHERE operation_id = ? AND tenant_id = ? AND user_id = ? AND status = 'completed'
      AND final_route IN ('local', 'cloud')`)
    .run(
      input.reason.trim().slice(0, 160) || 'application_validation_failed',
      timestamp,
      timestamp,
      input.operationId,
      input.tenantId,
      input.userId,
    );
}

export async function executeSkillInference(
  request: SkillInferenceRequest,
  db: Database.Database = getDb(),
): Promise<SkillInferenceResult> {
  return executeSkillInferenceWithAccountFence(request, db, 'production');
}

function markCompletedInferenceResultUndelivered(input: {
  runId: string;
  tenantId: number;
  userId: number;
  error: unknown;
}, db: Database.Database): void {
  const failureReason = localInferenceFailureReason(input.error) ?? 'INFERENCE_CANCELLED';
  const status = isLocalFairUseExemptFailureReason(failureReason) ? 'failed' : 'cancelled';
  const timestamp = new Date().toISOString();
  db.prepare(`UPDATE skill_inference_runs
    SET status = ?, final_route = 'none', fallback_reason = ?,
        completed_at = ?, updated_at = ?
    WHERE run_id = ? AND tenant_id = ? AND user_id = ? AND status = 'completed'`)
    .run(
      status,
      failureReason.slice(0, 160),
      timestamp,
      timestamp,
      input.runId,
      input.tenantId,
      input.userId,
    );
}

async function executeSkillInferenceWithAccountFence(
  request: SkillInferenceRequest,
  db: Database.Database,
  evaluationMode: 'production' | 'shadow',
): Promise<SkillInferenceResult> {
  let completedResult: SkillInferenceResult | undefined;
  try {
    return await runWithSkillInferenceAccountAdmission({
      userId: request.userId,
      abortSignal: request.abortSignal,
    }, async (abortSignal) => {
      completedResult = await executeSkillInferenceInternal({
        ...request,
        abortSignal,
      }, db, evaluationMode);
      return completedResult;
    }, db);
  } catch (error) {
    // Cancellation can arrive in the narrow hand-off between the provider run
    // being durably completed and the account-admission wrapper returning it.
    // Keep the provider attempt for diagnostics, but never count an answer that
    // could not cross the application boundary as a successful operation.
    if (completedResult) {
      markCompletedInferenceResultUndelivered({
        runId: completedResult.runId,
        tenantId: request.tenantId,
        userId: request.userId,
        error,
      }, db);
    }
    throw error;
  }
}

async function executeSkillInferenceInternal(
  request: SkillInferenceRequest,
  db: Database.Database,
  evaluationMode: 'production' | 'shadow',
): Promise<SkillInferenceResult> {
  if (!Number.isSafeInteger(request.userId) || request.userId <= 0
      || !Number.isSafeInteger(request.tenantId) || request.tenantId <= 0) {
    throw new SkillInferencePolicyError('INFERENCE_SCOPE_INVALID', 'A valid authenticated tenant/user scope is required.', 403);
  }
  if (request.containsPrivateData && request.allowCloudEscalation) {
    throw new SkillInferencePolicyError(
      'PRIVATE_CLOUD_ESCALATION_CLAIM_REQUIRED',
      'Private local-primary payloads cannot use the generic cloud fallback boundary.',
      403,
    );
  }
  const profile = getSkillInferenceProfile(request.skillId);
  if (profile.memoryScope !== 'server_compiled_tenant_request'
      || profile.toolPolicy !== 'none'
      || profile.toolAllowlist.length !== 0
      || !profile.validatorIds.includes('non_empty_output')
      || !profile.validatorIds.includes('server_owned_schema')
      || profile.fallbackPolicy.publicCloudEscalation !== 'explicit_authorization'
      || profile.fallbackPolicy.privateCloudEscalation !== 'forbidden') {
    throw new SkillInferencePolicyError(
      'INFERENCE_PROFILE_INVALID',
      'The selected specialist profile does not satisfy the output-only inference boundary.',
      503,
    );
  }
  if (!profile.allowedExecutionClasses.includes(request.executionClass)) {
    throw new SkillInferencePolicyError('INFERENCE_EXECUTION_CLASS_GUARDED', 'This skill workload is not eligible for local-primary execution.', 409);
  }
  if (!profile.allowedSchemaIds.includes(request.schemaId)) {
    throw new SkillInferencePolicyError('INFERENCE_SCHEMA_NOT_ALLOWED', 'The requested output schema is not allowed for this skill.', 400);
  }
  if ((request.schemaId === 'text' && request.outputSchema !== undefined)
      || (request.schemaId !== 'text' && request.outputSchema === undefined)) {
    throw new SkillInferencePolicyError(
      'INFERENCE_SCHEMA_CONTRACT_INVALID',
      'Structured schema identifiers require a server-owned output schema, while text output must not supply one.',
      400,
    );
  }
  const taskType = request.taskType.trim().slice(0, 160);
  const prompt = request.prompt.trim();
  const operationId = request.operationId.trim().slice(0, 160);
  if (!taskType || !prompt || !operationId || prompt.length > 300_000) {
    throw new SkillInferencePolicyError('INFERENCE_REQUEST_INVALID', 'Inference task, operation, and prompt are required.', 400);
  }

  const entitlement = getEffectiveEntitlement(request.userId);
  // Plan §1 row 1: while the binding is active, free/beta accounts are
  // admitted for LOCAL-ONLY execution even though general (cloud-capable)
  // model access stays denied. Cloud spend paths keep reading
  // aiAccessAllowed, which remains false for these plans.
  const freeTierLocalBinding = isFreeTierLocalOnlyBindingEnabled()
    && isLocalOnlyBoundPlan(entitlement.plan);
  if (!entitlement.aiAccessAllowed && !freeTierLocalBinding) {
    throw new SkillInferencePolicyError('LOCAL_PLAN_REQUIRED', 'This plan does not include model-backed operations.', 403);
  }
  const policy = readPlanPolicy(request.userId, profile.contextPolicy === 'content', db);
  const control = getLocalInferenceRuntimeControl(db);
  const localEligible = profileAllowsRisk(profile, request.riskClass)
    && request.executionClass !== 'action_proposal';
  const enrolled = control.mode === 'active'
    || (control.mode === 'canary' && isLocalInferenceUserEnrolled(request.userId, control.rolloutPercent));
  const routingRequestsLocal = localEligible && (
    evaluationMode === 'shadow' ? control.mode === 'shadow' : enrolled
  );
  let activeModelContextTokens: number | null = null;
  let productionEnvelopeContextTokens: number | null = null;
  let localManifestLoadFailed = false;
  if (routingRequestsLocal) {
    try {
      // Load one fresh signed contract and derive both limits from it. If the
      // asset disappears between the runtime-control read and this admission,
      // keep the application cloud-capable and persist a failed local-primary
      // run instead of throwing before the attempt ledger exists.
      const manifest = getLocalModelManifest({ fresh: true });
      const activeModel = manifest.models.find((model) => model.id === manifest.activeModelId);
      if (!activeModel) throw new Error('Signed local-model manifest has no active model');
      activeModelContextTokens = activeModel.maxContextTokens;
      productionEnvelopeContextTokens = manifest.productionEnvelope.maxContextTokens;
    } catch {
      localManifestLoadFailed = true;
      activeModelContextTokens = null;
      productionEnvelopeContextTokens = null;
    }
  }
  const localRouteAvailable = routingRequestsLocal
    && activeModelContextTokens !== null
    && productionEnvelopeContextTokens !== null;
  const directCloudFallbackReason = !localRouteAvailable && localEligible
    ? localManifestLoadFailed
      ? 'model_manifest_unavailable'
      : control.mode === 'off' && isLocalFairUseExemptFailureReason(control.reason)
        ? control.reason
        : undefined
    : undefined;
  const rawRequestedOutputTokens = request.requestedOutputTokens ?? policy.outputTokens;
  if (!Number.isSafeInteger(rawRequestedOutputTokens) || rawRequestedOutputTokens <= 0) {
    throw new SkillInferencePolicyError(
      'INFERENCE_REQUEST_INVALID',
      'A positive integer output-token limit is required.',
      400,
    );
  }
  const requestedOutputTokens = Math.min(
    rawRequestedOutputTokens,
    policy.outputTokens,
    profile.maximumOutputTokens,
    localPrimaryInferenceConfig.maxOutputTokens,
  );
  const contextCeiling = Math.min(
    policy.contextTokens,
    activeModelContextTokens ?? localPrimaryInferenceConfig.maxContextTokens,
    productionEnvelopeContextTokens ?? localPrimaryInferenceConfig.maxContextTokens,
  );
  const estimatedInputTokens = Math.ceil([
    profile.systemPolicy,
    request.applicationGuidance ?? '',
    prompt,
  ].join('\n\n').length / 3);
  const availableOutputTokens = contextCeiling - estimatedInputTokens - 128;
  if (availableOutputTokens < Math.min(requestedOutputTokens, 256)) {
    throw new SkillInferencePolicyError(
      'INFERENCE_CONTEXT_LIMIT_EXCEEDED',
      'The compiled inference context exceeds this plan and model limit.',
      400,
      { contextLimitTokens: contextCeiling },
    );
  }
  const outputTokens = Math.min(requestedOutputTokens, availableOutputTokens);
  const contextTokens = Math.min(
    contextCeiling,
    Math.max(1_024, estimatedInputTokens + outputTokens + 128),
  );
  if (contextTokens <= 0 || outputTokens <= 0) {
    throw new SkillInferencePolicyError('LOCAL_PLAN_REQUIRED', 'This plan does not include model-backed local operations.', 403);
  }

  // Shadow evaluation is detached from the user-visible answer and must not
  // consume, or later count toward, the user's operation fair-use allowance.
  // Local attempt telemetry still proves that the shadow model ran.
  const localAdmissionRequested = evaluationMode === 'production' && localRouteAvailable;
  const runId = request.runId?.trim().slice(0, 160) || crypto.randomUUID();
  const normalizedRequest: SkillInferenceRequest = {
    ...request,
    taskType,
    operationId,
  };
  const startedAt = Date.now();
  db.transaction(() => {
    if (localAdmissionRequested) assertLocalFairUse(db, normalizedRequest, policy);
    insertRun(db, {
      request: normalizedRequest,
      runId,
      contextTokens,
      outputTokens,
      profileVersion: profile.version,
      planId: entitlement.plan,
      localAdmissionRequested,
      evaluationMode,
    });
    const timestamp = new Date().toISOString();
    db.prepare(`UPDATE skill_inference_runs SET status = 'running', started_at = ?, updated_at = ? WHERE run_id = ?`)
      .run(timestamp, timestamp, runId);
  }).immediate();

  if (evaluationMode === 'production' && freeTierLocalBinding && !localRouteAvailable) {
    // Never cloud for locally-bound plans: a missing local route is a
    // retryable capacity response, not an escalation opportunity.
    completeRun(db, { runId, status: 'failed', fallbackReason: 'FREE_TIER_LOCAL_CAPACITY' });
    throw new SkillInferencePolicyError(
      'FREE_TIER_LOCAL_CAPACITY',
      'Free-plan AI runs on Nexus local capacity only. Please retry shortly.',
      503,
    );
  }
  if (evaluationMode === 'production'
      && request.containsPrivateData
      && !localRouteAvailable
      && request.allowCloudEscalation !== true) {
    completeRun(db, { runId, status: 'failed', fallbackReason: 'PRIVATE_LOCAL_ROUTE_UNAVAILABLE' });
    throw new SkillInferencePolicyError(
      'PRIVATE_LOCAL_ROUTE_UNAVAILABLE',
      'This private workload is local-only and local routing is not currently available.',
      503,
    );
  }
  if (evaluationMode === 'production'
      && !request.containsPrivateData
      && !localRouteAvailable
      && request.allowCloudEscalation !== true) {
    completeRun(db, { runId, status: 'failed', fallbackReason: 'CLOUD_ESCALATION_NOT_AUTHORIZED' });
    throw new SkillInferencePolicyError(
      'CLOUD_ESCALATION_NOT_AUTHORIZED',
      'Local routing is unavailable and this workload is not authorized to use cloud inference.',
      503,
    );
  }

  const provider = ensureActiveProvider();
  if (!provider) {
    completeRun(db, { runId, status: 'failed', fallbackReason: 'provider_router_unavailable' });
    throw new SkillInferencePolicyError('INFERENCE_PROVIDER_UNAVAILABLE', 'Inference provider routing is unavailable.', 503);
  }
  const cloudFallbackBoundary = <T>(providerCall: () => Promise<T>) => {
    assertInferenceNotCancelled(request.abortSignal);
    const cloudBudgetRequest: AiBudgetRequest = {
      ...request.budgetRequest,
      // The inference run—not a caller-supplied operation identifier—is the
      // durable unit that joins provider spend to fallback attempt telemetry.
      runId,
      hardRunCostLimitUsd: minimumPositiveCap(
        request.budgetRequest.hardRunCostLimitUsd,
        policy.cloudFallbackRunUsd,
      ),
      hardLocalFallbackDailyCostLimitUsd: minimumPositiveCap(
        request.budgetRequest.hardLocalFallbackDailyCostLimitUsd,
        policy.cloudFallbackDailyUsd,
      ),
    };
    return request.cloudBudgetBoundary(cloudBudgetRequest, () => {
      assertInferenceNotCancelled(request.abortSignal);
      return providerCall();
    });
  };
  const dispatch = async (
    localAdmission: 'force_cloud' | 'local_only',
    promptOverride = prompt,
    applicationGuidanceOverride = request.applicationGuidance,
  ) => {
    assertInferenceNotCancelled(request.abortSignal);
    const result = await runWithApiUsageAttribution({
      requestSource: request.requestSource,
      baseCategory: evaluationMode === 'shadow'
        ? buildLocalPrimaryShadowCategory(request.budgetRequest.baseCategory)
        : request.budgetRequest.baseCategory,
      jobName: evaluationMode === 'shadow'
        ? LOCAL_PRIMARY_SHADOW_JOB_NAME
        : request.budgetRequest.jobName ?? null,
      runId,
    }, () => provider.dispatchLocalReasoning({
      workloadRole: 'skill_inference',
      prompt: promptOverride,
      systemContext: [profile.systemPolicy, applicationGuidanceOverride?.trim() || ''].filter(Boolean).join('\n\n'),
      userId: request.userId,
      tenantId: request.tenantId,
      allowCloudEscalation: freeTierLocalBinding ? false : request.allowCloudEscalation,
      containsPrivateData: request.containsPrivateData,
      redactionRequired: request.redactionRequired,
      ...(request.scriptDeliveryMode !== undefined
        ? { scriptDeliveryMode: request.scriptDeliveryMode }
        : {}),
      ...(request.requiredCloudProvider !== undefined
        ? { requiredCloudProvider: request.requiredCloudProvider }
        : {}),
      ...(request.durableBatch !== undefined
        ? { durableBatch: request.durableBatch }
        : {}),
      outputSchema: request.outputSchema,
      numCtx: contextTokens,
      numPredict: outputTokens,
      temperature: request.temperature,
      timeoutMs: Math.max(1_000, request.deadlineMs ?? (request.executionClass === 'interactive' ? 45_000 : 300_000)),
      abortSignal: request.abortSignal,
      localAdmission,
      cloudFallbackBoundary,
    })) as {
      text?: unknown;
      parsed?: unknown;
      stopReason?: unknown;
      providerMetadata?: Record<string, unknown>;
    };
    if (typeof result?.text !== 'string' || !result.text.trim()) {
      throw new SkillInferencePolicyError('INFERENCE_EMPTY_OUTPUT', 'Inference provider returned no output.', 502);
    }
    return result;
  };

  const executeAndMap = async (input: {
    admission: 'force_cloud' | 'local_only';
    attemptNumber: number;
    fallbackReason?: string;
    promptOverride?: string;
    applicationGuidanceOverride?: string;
    scheduleLocal?: boolean;
  }): Promise<SkillInferenceResult> => {
    const invocationStarted = Date.now();
    let queueWaitMs = 0;
    const expectedRoute = input.admission === 'local_only' ? 'local' : 'cloud';
    try {
      let raw;
      if (input.scheduleLocal) {
        const scheduled = await localInferenceScheduler.schedule({
          // Detached shadow evidence must not inherit owner/Max priority or
          // queue ahead of an interactive user-visible generation.
          weight: evaluationMode === 'shadow' ? 1 : policy.queueWeight,
          executionClass: evaluationMode === 'shadow'
            ? 'background'
            : request.executionClass === 'background' ? 'background' : 'interactive',
          deadlineMs: request.deadlineMs ?? 30_000,
          abortSignal: request.abortSignal,
          run: () => {
            const currentControl = getLocalInferenceRuntimeControl(db);
            const stillAdmitted = currentControl.mode === 'active'
              || (currentControl.mode === 'canary'
                && isLocalInferenceUserEnrolled(request.userId, currentControl.rolloutPercent))
              || (control.mode === 'shadow' && currentControl.mode === 'shadow');
            if (!stillAdmitted) {
              throw new LocalInferenceCapacityError(
                'LOCAL_CAPACITY_BUSY',
                'Local inference routing was disabled before provider admission.',
              );
            }
            return dispatch(
              input.admission,
              input.promptOverride,
              input.applicationGuidanceOverride,
            );
          },
        });
        raw = scheduled.value;
        queueWaitMs = scheduled.queueWaitMs;
      } else {
        raw = await dispatch(
          input.admission,
          input.promptOverride,
          input.applicationGuidanceOverride,
        );
      }
      const metadata = raw.providerMetadata ?? {};
      const providerName = typeof metadata.providerUsed === 'string' && metadata.providerUsed.trim()
        ? metadata.providerUsed.trim().slice(0, 160)
        : (expectedRoute === 'local' ? 'ollama' : 'cloud-gate');
      const route = providerName === 'ollama' ? 'local' : 'cloud';
      if (request.outputSchema !== undefined) {
        const validation = validateStructuredOutputValue(raw.parsed, request.outputSchema);
        if (!validation.valid) {
          throw new SkillInferencePolicyError(
            'INFERENCE_SCHEMA_VALUE_INVALID',
            'Inference output did not match the server-owned schema.',
            502,
            { reason: validation.reason },
          );
        }
      }
      const result: SkillInferenceResult = {
        text: raw.text as string,
        ...(raw.parsed !== undefined ? { parsed: raw.parsed } : {}),
        provider: providerName,
        route,
        ...(typeof metadata.modelUsed === 'string' ? { model: metadata.modelUsed } : {}),
        ...(typeof metadata.modelDigest === 'string' ? { modelDigest: metadata.modelDigest } : {}),
        ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
        runId,
        operationId,
        validationStatus: request.outputSchema === undefined ? 'not_requested' : 'valid',
        queueWaitMs,
        ...(typeof metadata.firstTokenMs === 'number' ? { firstTokenMs: metadata.firstTokenMs } : {}),
        ...(typeof metadata.generationTokensPerSec === 'number'
          ? { throughputTokensPerSecond: metadata.generationTokensPerSec }
          : {}),
        ...(typeof metadata.inputTokens === 'number' ? { inputTokens: metadata.inputTokens } : {}),
        ...(typeof metadata.outputTokens === 'number' ? { outputTokens: metadata.outputTokens } : {}),
        ...(typeof raw.stopReason === 'string' ? { stopReason: raw.stopReason } : {}),
        durationMs: Date.now() - invocationStarted,
      };
      insertAttempt(db, {
        runId,
        attemptNumber: input.attemptNumber,
        route: route === 'local' ? 'local' : 'cloud',
        provider: providerName,
        model: result.model,
        modelDigest: result.modelDigest,
        outcome: 'success',
        queueWaitMs,
        firstTokenMs: result.firstTokenMs,
        throughput: result.throughputTokensPerSecond,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
      });
      return result;
    } catch (error) {
      const signalFailureReason = localInferenceFailureReason(request.abortSignal?.reason);
      const infrastructureAbortReason = isLocalFairUseExemptFailureReason(signalFailureReason)
        ? signalFailureReason
        : null;
      try {
        insertAttempt(db, {
          runId,
          attemptNumber: input.attemptNumber,
          route: expectedRoute,
          provider: expectedRoute === 'local' ? 'ollama' : 'cloud-gate',
          outcome: request.abortSignal?.aborted && !infrastructureAbortReason ? 'cancelled' : 'failure',
          failureReason: infrastructureAbortReason ?? safeFailureReason(error),
          queueWaitMs,
          durationMs: Date.now() - invocationStarted,
        });
      } catch { /* the provider/policy failure remains authoritative */ }
      throw error;
    }
  };

  try {
    let result: SkillInferenceResult | undefined;
    if (evaluationMode === 'shadow') {
      if (!localRouteAvailable) {
        throw new SkillInferencePolicyError(
          'LOCAL_SHADOW_NOT_ADMITTED',
          'Local shadow evaluation is not currently admitted.',
          409,
        );
      }
      result = await executeAndMap({
        admission: 'local_only',
        attemptNumber: 1,
        scheduleLocal: true,
      });
    } else if (localRouteAvailable) {
      let localFailure: unknown;
      try {
        result = await executeAndMap({
          admission: 'local_only',
          attemptNumber: 1,
          scheduleLocal: true,
        });
      } catch (error) {
        localFailure = error;
        if (request.abortSignal?.aborted) throw error;
        const reason = safeFailureReason(error);
        const repairable = profile.fallbackPolicy.maximumLocalSchemaRepairs > 0
          && request.outputSchema !== undefined
          && (reason === 'invalid_json' || reason === 'INFERENCE_SCHEMA_VALUE_INVALID');
        if (repairable) {
          try {
            result = await executeAndMap({
              admission: 'local_only',
              attemptNumber: 2,
              scheduleLocal: true,
              applicationGuidanceOverride: [
                request.applicationGuidance?.trim() || '',
                'REPAIR: The previous response failed the JSON schema. Return one complete JSON value only; include every required field and no commentary.',
              ].filter(Boolean).join('\n\n'),
            });
            localFailure = undefined;
          } catch (repairError) {
            localFailure = repairError;
            if (request.abortSignal?.aborted) throw repairError;
          }
        }
        if (localFailure !== undefined) {
          // Locally-bound plans surface the local failure as-is: a failed
          // local attempt is never an authorization to spend cloud.
          if (!request.allowCloudEscalation || freeTierLocalBinding) throw localFailure;
          result = await executeAndMap({
            admission: 'force_cloud',
            attemptNumber: repairable ? 3 : 2,
            fallbackReason: safeFailureReason(localFailure),
          });
        }
      }
    } else {
      // Reaching this branch means local routing is unavailable or the risk
      // profile is cloud-guarded. The explicit authorization check above must
      // remain the only way into a forced cloud dispatch.
      result = await executeAndMap({
        admission: 'force_cloud',
        attemptNumber: 1,
        ...(directCloudFallbackReason ? { fallbackReason: directCloudFallbackReason } : {}),
      });
    }
    if (!result) {
      throw new SkillInferencePolicyError(
        'INFERENCE_RESULT_UNAVAILABLE',
        'Inference completed without a deliverable result.',
        502,
      );
    }
    result.durationMs = Date.now() - startedAt;
    completeRun(db, {
      runId,
      status: 'completed',
      result,
      ...(evaluationMode === 'shadow' ? { finalRouteOverride: 'none' as const } : {}),
    });
    return result;
  } catch (error) {
    const surfacedError = normalizeSkillInferenceBoundaryError(error);
    const signalFailureReason = localInferenceFailureReason(request.abortSignal?.reason);
    const infrastructureAbortReason = isLocalFairUseExemptFailureReason(signalFailureReason)
      ? signalFailureReason
      : null;
    const failureReason = infrastructureAbortReason ?? safeFailureReason(surfacedError);
    const cancelled = request.abortSignal?.aborted === true && !infrastructureAbortReason;
    completeRun(db, {
      runId,
      status: cancelled ? 'cancelled' : 'failed',
      fallbackReason: failureReason,
    });
    throw surfacedError;
  }
}

/**
 * Launch a local-only comparison without delaying or changing the live cloud
 * owner. Private content stays on-host; no cloud budget boundary can be
 * reached. Shadow runs are tagged separately in both inference and api_usage
 * ledgers and never consume user fair use.
 */
export function scheduleSkillInferenceShadowAttempt(
  request: SkillInferenceRequest,
  db: Database.Database = getDb(),
): void {
  const shadowRunId = `${request.runId?.trim() || crypto.randomUUID()}:shadow`.slice(0, 160);
  void executeSkillInferenceWithAccountFence({
    ...request,
    runId: shadowRunId,
    allowCloudEscalation: false,
    budgetRequest: {
      ...request.budgetRequest,
      jobName: LOCAL_PRIMARY_SHADOW_JOB_NAME,
    },
    cloudBudgetBoundary: async () => {
      throw new SkillInferencePolicyError(
        'LOCAL_SHADOW_CLOUD_FORBIDDEN',
        'Shadow evaluation is local-only.',
        409,
      );
    },
  }, db, 'shadow').catch((error) => {
    // Failures after admission are retained by the run/attempt ledger. A
    // pre-ledger policy or schema failure still needs safe operator evidence;
    // record only its normalized code/name, never prompt or model output.
    logger.warn(
      safeDetachedFailureEvidence(error),
      'Detached local-primary shadow attempt failed',
    );
    // The live response remains with its old owner.
  });
}
