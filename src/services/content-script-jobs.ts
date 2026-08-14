// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import { getDb } from './database';
import { getEffectiveEntitlement } from './entitlement';
import {
  type ScriptResponse as EngineScriptResponse,
} from './content-engine';
import { getUserLanguageById } from './user-service';
import { getAllKnowledge } from '../state/content-references';
import {
  buildScriptSuccessResponse,
  buildUserVoiceMemory,
  resolveScriptGenerationMode,
  resolveScriptRenderMode,
  resolveScriptStyle,
  resolveScriptTargetLanguage,
} from '../api/routes/content-script-route-utils';
import { normalizeScriptFormat, resolveScriptDurationPreset } from '../api/routes/content-script-utils';
import {
  assertContentOutputLanguageFields,
  ContentOutputLanguageMismatchError,
} from './content-output-language';
import {
  decryptContentScriptJobJson,
  encryptContentScriptJobJson,
} from './content-script-job-encryption';
import { getLocalInferenceRuntimeControl } from './local-inference-runtime-control';
import { localInferenceScheduler } from './local-inference-scheduler';
import { localPrimaryInferenceConfig } from './local-primary-config';
import { getLocalModelManifest } from './ollama-model-policy';
import {
  executeSkillInference,
  isSkillInferenceAccountDeletionFenced,
  isLocalInferenceUserEnrolled,
  rejectSkillInferenceApplicationResult,
  SkillInferencePolicyError,
  type SkillInferenceResult,
} from './skill-inference-service';
import {
  createContentScriptInfrastructureAbort,
  isLocalFairUseExemptFailureReason,
  localInferenceFailureReason,
} from './local-inference-failure-taxonomy';
import {
  isLongFormScriptDuration,
  LONG_FORM_SCRIPT_THRESHOLD_SECONDS,
} from './local-inference-vocabulary';
import { activeContentScriptJobLeases as controllers } from './content-script-job-account-lifecycle';
export { cancelContentScriptJobsForAccountDeletion } from './content-script-job-account-lifecycle';

export const CONTENT_SCRIPT_JOB_SCHEMA_VERSION = 'nexus-content-script-job-v1';
const LEASE_MS = 15 * 60 * 1000;
const STALE_HEARTBEAT_MS = 3 * 60 * 1000;
const MAX_CONTENT_SCRIPT_GENERATION_ATTEMPTS = 2;
const MAX_CONSECUTIVE_INFRASTRUCTURE_REQUEUES = 3;
const MAX_FINAL_REPAIR_PASSES = 1;
const INFRASTRUCTURE_REQUEUE_BACKOFF_MS = [15_000, 60_000] as const;

// Recovery causes belong to one lease generation. Keying by the token keeps a
// stale worker's teardown from changing or deleting the replacement worker's
// controller state.
const recoverableAbortCodes = new Map<string, string>();
// Creation and retry can occur concurrently. Coalesce their asynchronous
// recovery kicks per database so every new job enters the same durable
// weighted selector instead of starting an exact job directly.
const pendingRecoveryDatabases = new WeakSet<Database.Database>();
let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let stopSchedulerIdleListener: (() => void) | null = null;
let contentScriptJobShutdownStarted = false;

function requestContentScriptJobRecovery(db: Database.Database): void {
  if (contentScriptJobShutdownStarted || pendingRecoveryDatabases.has(db)) return;
  pendingRecoveryDatabases.add(db);
  setImmediate(() => {
    pendingRecoveryDatabases.delete(db);
    if (contentScriptJobShutdownStarted) return;
    try {
      recoverContentScriptJobs(db);
    } catch (error) {
      logger.warn({
        errorName: error instanceof Error ? error.name : typeof error,
      }, 'Content script on-demand recovery failed');
    }
  });
}

export type ContentScriptJobStatus =
  | 'queued' | 'running' | 'waiting_capacity' | 'completed' | 'failed' | 'cancelled';

export interface ContentScriptJobRequest {
  topic: string;
  niche: string;
  format: 'YouTube' | 'Reel';
  mode: 'draft' | 'quick' | 'standard' | 'deep';
  language: string;
  renderMode: 'structured' | 'chat';
  scriptStyle: 'detailed' | 'bullets';
  maxDurationMinutes: number;
  targetDurationSeconds: number;
  forceRefresh: boolean;
  pinnedManifestVersion: string;
  pinnedModelId: string;
  pinnedModelTag: string;
  pinnedModelDigest: string;
  /** Encrypted immutable snapshots captured when the authenticated job is created. */
  pinnedCreatorVoice: string | null;
  pinnedSources: Array<{
    title: string;
    url: string;
    source_type: string;
    relevance_note: string;
  }>;
}

export interface ContentScriptJobView {
  schemaVersion: typeof CONTENT_SCRIPT_JOB_SCHEMA_VERSION;
  jobId: string;
  status: ContentScriptJobStatus;
  stage: string;
  progress: number;
  warnings: string[];
  route: string | null;
  modelDigest: string | null;
  result?: Record<string, unknown>;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  statusUrl: string;
}

interface JobRow {
  job_id: string;
  tenant_id: number;
  owner_user_id: number;
  idempotency_key: string;
  request_hash: string;
  operation_id: string;
  request_json: string;
  target_duration_seconds: number;
  status: ContentScriptJobStatus;
  stage: string;
  progress_percent: number;
  warning_codes_json: string;
  result_json: string | null;
  route: string | null;
  model_digest: string | null;
  attempt_count: number;
  infrastructure_requeue_count: number;
  final_repair_count: number;
  next_attempt_at: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  fair_use_admitted_at: string;
  created_at: string;
  updated_at: string;
}

interface ScriptOutlineSection {
  key: string;
  title: string;
  instructions: string;
  wordBudget: number;
}

interface ScriptOutline {
  hook: string;
  titleOptions: string[];
  sections: ScriptOutlineSection[];
  inferenceRunIds: string[];
}

interface ValidatedSection {
  index: number;
  key: string;
  title: string;
  text: string;
  wordBudget: number;
  modelDigest: string | null;
  inferenceRunIds: string[];
}

export class ContentScriptJobError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'ContentScriptJobError';
  }
}

class ContentScriptFinalValidationError extends ContentScriptJobError {
  constructor(readonly warningCodes: string[]) {
    super(
      'LOCAL_SCRIPT_FINAL_VALIDATION_FAILED',
      'The assembled local script requires review before publication.',
      422,
    );
    this.name = 'ContentScriptFinalValidationError';
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`;
}

type ContentScriptPublicRequest = Omit<
  ContentScriptJobRequest,
  | 'pinnedManifestVersion'
  | 'pinnedModelId'
  | 'pinnedModelTag'
  | 'pinnedModelDigest'
  | 'pinnedCreatorVoice'
  | 'pinnedSources'
>;

function normalizeRequest(input: Record<string, unknown>, userId: number): ContentScriptPublicRequest {
  const topic = typeof input.topic === 'string' ? input.topic.trim() : '';
  if (!topic || topic.length > 2_000) {
    throw new ContentScriptJobError('VALIDATION', 'topic is required and must be at most 2,000 characters');
  }
  const format = normalizeScriptFormat(input.format);
  if (!format) throw new ContentScriptJobError('VALIDATION', 'format must be YouTube or Reel');
  const duration = resolveScriptDurationPreset(format, input.maxDurationMinutes, input.targetDurationSeconds);
  if ('error' in duration) throw new ContentScriptJobError('VALIDATION', duration.error);
  return {
    topic,
    niche: typeof input.niche === 'string' && input.niche.trim() ? input.niche.trim().slice(0, 160) : 'general',
    format,
    mode: resolveScriptGenerationMode(input.mode),
    language: resolveScriptTargetLanguage(input.language, userId, getUserLanguageById),
    renderMode: resolveScriptRenderMode(input.renderMode),
    scriptStyle: resolveScriptStyle(input.scriptStyle ?? input.style),
    maxDurationMinutes: duration.maxDurationMinutes,
    targetDurationSeconds: duration.targetDurationSeconds,
    forceRefresh: input.forceRefresh === true,
  };
}

function hashablePublicRequest(
  input: Record<string, unknown>,
  request: ContentScriptPublicRequest,
): Record<string, unknown> {
  const { language, ...languageIndependentRequest } = request;
  const explicitLanguage = typeof input.language === 'string' && input.language.trim().length > 0;
  return {
    ...languageIndependentRequest,
    languageIntent: explicitLanguage
      ? { source: 'explicit', value: language }
      : { source: 'profile_default' },
  };
}

function pinnedSources(input: Record<string, unknown>): ContentScriptJobRequest['pinnedSources'] {
  const candidates = Array.isArray(input.sources)
    ? input.sources
    : Array.isArray(input.sourceContext)
      ? input.sourceContext
      : [];
  const output: ContentScriptJobRequest['pinnedSources'] = [];
  for (const candidate of candidates.slice(0, 20)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const row = candidate as Record<string, unknown>;
    const title = typeof row.title === 'string' ? row.title.trim().slice(0, 500) : '';
    const url = typeof row.url === 'string' ? row.url.trim().slice(0, 2_000) : '';
    const sourceType = typeof row.source_type === 'string'
      ? row.source_type.trim().slice(0, 120)
      : typeof row.sourceType === 'string'
        ? row.sourceType.trim().slice(0, 120)
        : 'user_supplied';
    const relevance = typeof row.relevance_note === 'string'
      ? row.relevance_note.trim().slice(0, 1_500)
      : typeof row.relevanceNote === 'string'
        ? row.relevanceNote.trim().slice(0, 1_500)
        : '';
    if (!title && !relevance) continue;
    if (url && !/^https?:\/\//i.test(url)) continue;
    output.push({
      title: title || 'User-supplied source',
      url,
      source_type: sourceType || 'user_supplied',
      relevance_note: relevance,
    });
  }
  return output;
}

function requireScope(tenantId: number, userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0
      || !Number.isSafeInteger(tenantId) || tenantId <= 0
      || tenantId !== userId) {
    throw new ContentScriptJobError('CONTENT_TENANT_SCOPE_MISMATCH', 'A matching tenant/user scope is required.', 403);
  }
}

function readRow(db: Database.Database, tenantId: number, userId: number, jobId: string): JobRow | null {
  return (db.prepare(`SELECT * FROM content_script_jobs
    WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ?`)
    .get(jobId, tenantId, userId) as JobRow | undefined) ?? null;
}

function mapJob(row: JobRow): ContentScriptJobView {
  const warnings = JSON.parse(row.warning_codes_json) as string[];
  const result = row.status === 'completed' && row.result_json
    ? decryptContentScriptJobJson<Record<string, unknown>>(row.result_json, row.owner_user_id)
    : undefined;
  return {
    schemaVersion: CONTENT_SCRIPT_JOB_SCHEMA_VERSION,
    jobId: row.job_id,
    status: row.status,
    stage: row.stage,
    progress: row.progress_percent,
    warnings,
    route: row.route,
    modelDigest: row.model_digest,
    ...(result ? { result } : {}),
    ...(row.last_error_code ? { errorCode: row.last_error_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statusUrl: `/api/v1/content/script-jobs/${encodeURIComponent(row.job_id)}`,
  };
}

function planLimits(db: Database.Database, userId: number): { active: number; daily: number; plan: string } {
  const entitlement = getEffectiveEntitlement(userId);
  if (!entitlement.aiAccessAllowed) {
    throw new ContentScriptJobError('AI_PLAN_REQUIRED', 'Long-form script jobs require an active paid plan.', 403);
  }
  const fallback = entitlement.plan === 'max' ? { active: 2, daily: 20, plan: entitlement.plan }
    : entitlement.plan === 'owner' ? { active: 20, daily: 1000, plan: entitlement.plan }
      : { active: 1, daily: 6, plan: entitlement.plan };
  const row = db.prepare(`SELECT active_content_jobs, longform_scripts_daily
    FROM plan_configs WHERE plan_id = ? AND active = 1`)
    .get(entitlement.plan) as { active_content_jobs: number; longform_scripts_daily: number } | undefined;
  if (!row
      || !Number.isSafeInteger(row.active_content_jobs)
      || row.active_content_jobs < 0
      || row.active_content_jobs > 100
      || !Number.isSafeInteger(row.longform_scripts_daily)
      || row.longform_scripts_daily < 0
      || row.longform_scripts_daily > 1_000) {
    return fallback;
  }
  return {
    active: row.active_content_jobs,
    daily: row.longform_scripts_daily,
    plan: entitlement.plan,
  };
}

function compiledQueueWeight(plan: string): number {
  if (plan === 'owner') return 4;
  if (plan === 'max') return 2;
  return 1;
}

function effectiveQueueWeight(plan: string, persisted: unknown): number {
  return Number.isSafeInteger(persisted) && Number(persisted) >= 0 && Number(persisted) <= 10
    ? Number(persisted)
    : compiledQueueWeight(plan);
}

function assertJobsEnabled(): void {
  if (contentScriptJobShutdownStarted) {
    throw new ContentScriptJobError(
      'CONTENT_SCRIPT_JOBS_SHUTTING_DOWN',
      'Background script jobs are temporarily unavailable while the service is shutting down.',
      503,
    );
  }
  if (!localPrimaryInferenceConfig.scriptJobsEnabled) {
    throw new ContentScriptJobError('CONTENT_SCRIPT_JOBS_DISABLED', 'Background script jobs are not enabled.', 409);
  }
  if (!localPrimaryInferenceConfig.contentProxyEnabled) {
    throw new ContentScriptJobError(
      'LOCAL_PRIMARY_CONTENT_PROXY_REQUIRED',
      'Background script jobs require the local-only Content proxy boundary.',
      409,
    );
  }
  // Fail before any durable write or provider call if encryption is absent.
  encryptContentScriptJobJson({ preflight: true }, 1);
}

function assertRuntimeAdmitsJob(db: Database.Database, userId: number): void {
  const control = getLocalInferenceRuntimeControl(db);
  const admitted = control.mode === 'active'
    || (control.mode === 'canary'
      && isLocalInferenceUserEnrolled(userId, control.rolloutPercent));
  if (!admitted) {
    throw new ContentScriptJobError(
      'LOCAL_INFERENCE_NOT_ADMITTING',
      'Local Content generation is not currently admitting new jobs.',
      503,
    );
  }
}

export function createContentScriptJob(input: {
  tenantId: number;
  userId: number;
  idempotencyKey: string;
  request: Record<string, unknown>;
}, db: Database.Database = getDb()): { job: ContentScriptJobView; replayed: boolean } {
  requireScope(input.tenantId, input.userId);
  if (isSkillInferenceAccountDeletionFenced(input.userId, db)) {
    throw new ContentScriptJobError(
      'ACCOUNT_DELETION_IN_PROGRESS',
      'No new Content job can start while this account is being deleted.',
      409,
    );
  }
  const idempotencyKey = input.idempotencyKey.trim().slice(0, 200);
  if (!idempotencyKey) throw new ContentScriptJobError('IDEMPOTENCY_KEY_REQUIRED', 'An idempotency key is required.', 400);
  const publicRequest = normalizeRequest(input.request, input.userId);
  const sourceSnapshot = pinnedSources(input.request);
  const requestHash = crypto.createHash('sha256')
    .update(stableJson({
      ...hashablePublicRequest(input.request, publicRequest),
      pinnedSources: sourceSnapshot,
    }))
    .digest('hex');
  const existing = db.prepare(`SELECT * FROM content_script_jobs
    WHERE tenant_id = ? AND owner_user_id = ? AND idempotency_key = ?`)
    .get(input.tenantId, input.userId, idempotencyKey) as JobRow | undefined;
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new ContentScriptJobError('IDEMPOTENCY_CONFLICT', 'This idempotency key belongs to another script request.', 409);
    }
    return { job: mapJob(existing), replayed: true };
  }
  // Runtime OFF stops new admission, but it must not break an exact replay of
  // an operation accepted before the control changed.
  assertJobsEnabled();
  assertRuntimeAdmitsJob(db, input.userId);
  const manifest = getLocalModelManifest({ fresh: true });
  const activeModel = manifest.models.find((model) => model.id === manifest.activeModelId)!;
  if (!activeModel.digest || activeModel.evidenceStatus !== 'verified') {
    throw new ContentScriptJobError(
      'CONTENT_SCRIPT_MODEL_NOT_PINNED',
      'Long-form jobs require a verified digest-pinned active local model.',
      503,
    );
  }
  const request: ContentScriptJobRequest = {
    ...publicRequest,
    pinnedManifestVersion: manifest.manifestVersion,
    pinnedModelId: activeModel.id,
    pinnedModelTag: activeModel.ollamaTag,
    pinnedModelDigest: activeModel.digest,
    pinnedCreatorVoice: (buildUserVoiceMemory(input.userId, getAllKnowledge) ?? '').slice(0, 8_000) || null,
    pinnedSources: sourceSnapshot,
  };
  const persisted = db.transaction((): { row: JobRow; replayed: boolean } => {
    // Recheck idempotency under the same write lock as limits and insertion.
    const concurrentExisting = db.prepare(`SELECT * FROM content_script_jobs
      WHERE tenant_id = ? AND owner_user_id = ? AND idempotency_key = ?`)
      .get(input.tenantId, input.userId, idempotencyKey) as JobRow | undefined;
    if (concurrentExisting) {
      if (concurrentExisting.request_hash !== requestHash) {
        throw new ContentScriptJobError('IDEMPOTENCY_CONFLICT', 'This idempotency key belongs to another script request.', 409);
      }
      return { row: concurrentExisting, replayed: true };
    }

    const limits = planLimits(db, input.userId);
    const active = (db.prepare(`SELECT COUNT(*) AS count FROM content_script_jobs
      WHERE tenant_id = ? AND owner_user_id = ?
        AND status IN ('queued', 'running', 'waiting_capacity')`)
      .get(input.tenantId, input.userId) as { count: number }).count;
    if (active >= limits.active) {
      throw new ContentScriptJobError('CONTENT_SCRIPT_ACTIVE_LIMIT', 'Active script-job limit reached.', 429);
    }
    if (isLongFormScriptDuration(request.targetDurationSeconds)) {
      const daily = (db.prepare(`SELECT COUNT(*) AS count FROM content_script_jobs
        WHERE tenant_id = ? AND owner_user_id = ?
          AND target_duration_seconds > ?
          AND fair_use_admitted_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`)
        .get(input.tenantId, input.userId, LONG_FORM_SCRIPT_THRESHOLD_SECONDS) as { count: number }).count;
      if (daily >= limits.daily) {
        throw new ContentScriptJobError('CONTENT_SCRIPT_DAILY_LIMIT', 'Daily long-form script-job limit reached.', 429);
      }
    }

    const jobId = `script_job_${crypto.randomUUID()}`;
    const inserted = db.prepare(`INSERT INTO content_script_jobs (
      job_id, tenant_id, owner_user_id, plan_id, idempotency_key, request_hash,
      operation_id, request_json, target_duration_seconds,
      status, stage, progress_percent, model_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 0, ?)
    ON CONFLICT(tenant_id, owner_user_id, idempotency_key) DO NOTHING`)
      .run(
        jobId,
        input.tenantId,
        input.userId,
        limits.plan,
        idempotencyKey,
        requestHash,
        `content-script:${jobId}`,
        encryptContentScriptJobJson(request, input.userId),
        request.targetDurationSeconds,
        activeModel.digest,
      );
    if (inserted.changes !== 1) {
      const winner = db.prepare(`SELECT * FROM content_script_jobs
        WHERE tenant_id = ? AND owner_user_id = ? AND idempotency_key = ?`)
        .get(input.tenantId, input.userId, idempotencyKey) as JobRow | undefined;
      if (!winner) {
        throw new ContentScriptJobError('IDEMPOTENCY_RACE_UNRESOLVED', 'The idempotent script request could not be resolved.', 503);
      }
      if (winner.request_hash !== requestHash) {
        throw new ContentScriptJobError('IDEMPOTENCY_CONFLICT', 'This idempotency key belongs to another script request.', 409);
      }
      return { row: winner, replayed: true };
    }
    return {
      row: readRow(db, input.tenantId, input.userId, jobId)!,
      replayed: false,
    };
  }).immediate();
  if (!persisted.replayed) {
    requestContentScriptJobRecovery(db);
  }
  return { job: mapJob(persisted.row), replayed: persisted.replayed };
}

export function getContentScriptJob(
  tenantId: number,
  userId: number,
  jobId: string,
  db: Database.Database = getDb(),
): ContentScriptJobView | null {
  requireScope(tenantId, userId);
  const row = readRow(db, tenantId, userId, jobId.trim());
  return row ? mapJob(row) : null;
}

function updateProgress(db: Database.Database, jobId: string, token: string, stage: string, progress: number): void {
  const now = new Date();
  const result = db.prepare(`UPDATE content_script_jobs
    SET stage = ?, progress_percent = MAX(progress_percent, ?), lease_expires_at = ?, updated_at = ?
    WHERE job_id = ? AND status = 'running' AND lease_token = ?
      AND cancellation_requested_at IS NULL AND lease_expires_at > ?`)
    .run(
      stage,
      progress,
      new Date(now.getTime() + LEASE_MS).toISOString(),
      now.toISOString(),
      jobId,
      token,
      now.toISOString(),
    );
  if (result.changes !== 1) throw new ContentScriptJobError('CONTENT_SCRIPT_JOB_LEASE_LOST', 'Script job lease was lost.', 409);
}

function checkpointDerivedProgress(db: Database.Database, jobId: string): number {
  const checkpointState = db.prepare(`SELECT
      MAX(CASE WHEN section_index = 0 AND section_key = 'outline' AND state = 'validated' THEN 1 ELSE 0 END) AS has_outline,
      MAX(CASE WHEN section_index = 0 AND section_key = 'outline' AND state = 'validated'
        THEN CAST(json_extract(validation_json, '$.sectionCount') AS INTEGER) ELSE 0 END) AS total_sections,
      COUNT(CASE WHEN section_index > 0 AND section_key LIKE 'section_%' AND state = 'validated' THEN 1 END) AS validated_sections
    FROM content_script_job_checkpoints WHERE job_id = ?`)
    .get(jobId) as { has_outline: number; total_sections: number; validated_sections: number };
  if (!checkpointState.has_outline) return 0;
  const validatedSections = Math.max(0, checkpointState.validated_sections);
  const totalSections = Math.max(1, checkpointState.total_sections || validatedSections || 1);
  if (validatedSections === 0) return 18;
  return Math.min(80, 25 + Math.floor(((validatedSections - 1) / totalSections) * 60));
}

interface InfrastructureRequeueResult {
  job: ContentScriptJobView;
  terminal: boolean;
}

/**
 * Refund one generation attempt for an infrastructure-only interruption while
 * bounding consecutive automatic retries. A validated checkpoint resets the
 * counter in the same transaction that stores the checkpoint.
 */
function requeueInfrastructureFailure(
  db: Database.Database,
  jobId: string,
  leaseToken: string,
  causeCode: string,
  options: { leaseExpiredBefore?: string; heartbeatStaleBefore?: string } = {},
): InfrastructureRequeueResult | null {
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM content_script_jobs
      WHERE job_id = ? AND status = 'running' AND lease_token = ?
        AND cancellation_requested_at IS NULL
        AND (? IS NULL OR lease_expires_at <= ? OR updated_at <= ?)`)
      .get(
        jobId,
        leaseToken,
        options.leaseExpiredBefore ?? null,
        options.leaseExpiredBefore ?? null,
        options.heartbeatStaleBefore ?? null,
      ) as JobRow | undefined;
    if (!row) return null;

    const nextCount = row.infrastructure_requeue_count + 1;
    const terminal = nextCount >= MAX_CONSECUTIVE_INFRASTRUCTURE_REQUEUES;
    const timestamp = new Date().toISOString();
    const nextAttemptAt = terminal
      ? null
      : new Date(
        Date.now() + INFRASTRUCTURE_REQUEUE_BACKOFF_MS[nextCount - 1]!,
      ).toISOString();
    const finalCode = terminal
      ? 'CONTENT_SCRIPT_INFRASTRUCTURE_RETRY_EXHAUSTED'
      : causeCode;
    const warningCodes = terminal
      ? JSON.stringify(['content_script_infrastructure_retry_exhausted', causeCode])
      : row.warning_codes_json;

    if (terminal) {
      db.prepare(`UPDATE content_script_job_checkpoints
        SET state = 'invalid', updated_at = ?
        WHERE job_id = ? AND state = 'generating'`)
        .run(timestamp, jobId);
    }
    const changed = db.prepare(`UPDATE content_script_jobs
      SET status = ?, stage = ?, last_error_code = ?, warning_codes_json = ?,
          lease_token = NULL, lease_expires_at = NULL,
          progress_percent = MAX(progress_percent, ?),
          attempt_count = MAX(attempt_count - 1, 0),
          infrastructure_requeue_count = ?, next_attempt_at = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running' AND lease_token = ?
        AND cancellation_requested_at IS NULL`)
      .run(
        terminal ? 'failed' : 'waiting_capacity',
        terminal ? 'failed' : 'waiting_capacity',
        finalCode,
        warningCodes,
        checkpointDerivedProgress(db, jobId),
        nextCount,
        nextAttemptAt,
        timestamp,
        jobId,
        leaseToken,
      );
    if (changed.changes !== 1) return null;
    const updated = db.prepare('SELECT * FROM content_script_jobs WHERE job_id = ?')
      .get(jobId) as JobRow;
    return { job: mapJob(updated), terminal };
  }).immediate();
}

function claimFinalRepairPass(
  db: Database.Database,
  row: JobRow,
  leaseToken: string,
): boolean {
  return db.transaction(() => {
    assertOwnedUnexpiredLease(db, row.job_id, leaseToken);
    const claimed = db.prepare(`UPDATE content_script_jobs
      SET final_repair_count = final_repair_count + 1, updated_at = ?
      WHERE job_id = ? AND status = 'running' AND lease_token = ?
        AND final_repair_count < ?`)
      .run(new Date().toISOString(), row.job_id, leaseToken, MAX_FINAL_REPAIR_PASSES);
    if (claimed.changes === 1) return true;
    const current = db.prepare(`SELECT final_repair_count FROM content_script_jobs
      WHERE job_id = ? AND status = 'running' AND lease_token = ?`)
      .get(row.job_id, leaseToken) as { final_repair_count: number } | undefined;
    if (current && current.final_repair_count >= MAX_FINAL_REPAIR_PASSES) return false;
    throw new ContentScriptJobError(
      'CONTENT_SCRIPT_JOB_LEASE_LOST',
      'Script job lease was lost while reserving the bounded final repair.',
      409,
    );
  }).immediate();
}

function heartbeatLease(db: Database.Database, jobId: string, token: string): boolean {
  const now = new Date();
  return db.prepare(`UPDATE content_script_jobs
    SET lease_expires_at = ?, updated_at = ?
    WHERE job_id = ? AND status = 'running' AND lease_token = ?
      AND cancellation_requested_at IS NULL AND lease_expires_at > ?`)
    .run(
      new Date(now.getTime() + LEASE_MS).toISOString(),
      now.toISOString(),
      jobId,
      token,
      now.toISOString(),
    ).changes === 1;
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function validateResult(request: ContentScriptJobRequest, result: EngineScriptResponse): string[] {
  assertContentOutputLanguageFields(
    request.language,
    deliveredModelFields(result),
    'content-script-job',
  );
  if (!result.script?.trim()) throw new ContentScriptJobError('CONTENT_SCRIPT_EMPTY', 'The generated script was empty.', 422);
  const warnings: string[] = [];
  if (result.degraded === true || result.cache_status === 'fallback') warnings.push('provider_degraded');
  if (request.targetDurationSeconds === 900) {
    const words = wordCount(result.script);
    if (words < 1900 || words > 2400) warnings.push('fifteen_minute_word_count_out_of_range');
  }
  const allowedUrls = new Set(request.pinnedSources.map((source) => source.url).filter(Boolean));
  const deliveredArtifactText = deliveredModelFields(result).join('\n');
  if (containsUnsupportedSourceUrl(deliveredArtifactText, allowedUrls)) {
    warnings.push('unsupported_source_url');
  }
  return warnings;
}

/**
 * Return only fields authored by the model and delivered to the user. Source
 * metadata is an immutable request echo, so validating it as generated output
 * would let a user's own title, note, or URL make every repair fail.
 */
function deliveredModelFields(result: EngineScriptResponse): string[] {
  return [
    result.script,
    result.hook,
    ...(result.title_options ?? []),
    result.caption ?? '',
    result.cta ?? '',
    ...(result.hashtags ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function containsUnsupportedSourceUrl(
  value: string,
  allowedUrls: ReadonlySet<string>,
): boolean {
  const urls = value.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  return urls.some((url) => !urlMatchesAllowedSource(url, allowedUrls));
}

function urlMatchesAllowedSource(
  rawCandidate: string,
  allowedUrls: ReadonlySet<string>,
): boolean {
  let candidate = rawCandidate;
  while (candidate.length > 0) {
    // Check before removing prose/markup punctuation: commas and closing
    // parentheses are valid URL characters and may be part of the pinned URL.
    if (allowedUrls.has(candidate)) return true;
    const trailing = candidate.at(-1);
    if (!trailing || !/[.,;:!?\])}*_~]/u.test(trailing)) break;
    // Remove one character at a time so every intermediate candidate is
    // checked. A greedy strip would remove a valid URL's final `)` or `,`
    // together with the sentence punctuation that follows it.
    candidate = candidate.slice(0, -1);
  }
  return false;
}

function outlineContainsUnsupportedSourceUrl(
  request: ContentScriptJobRequest,
  outline: ScriptOutline,
): boolean {
  const allowedUrls = new Set(request.pinnedSources.map((source) => source.url).filter(Boolean));
  return containsUnsupportedSourceUrl([
    outline.hook,
    ...outline.titleOptions,
    ...outline.sections.flatMap((section) => [section.title, section.instructions]),
  ].join('\n'), allowedUrls);
}

function invalidateSectionsForFinalRepair(
  db: Database.Database,
  row: JobRow,
  leaseToken: string,
  request: ContentScriptJobRequest,
  sections: ValidatedSection[],
  warningCodes: string[],
  forceAll = false,
  rejectionReason = 'content_script_final_validation_failed',
): number {
  const invalidIndexes = new Set<number>();
  if (!forceAll && warningCodes.includes('unsupported_source_url')) {
    const allowedUrls = new Set(request.pinnedSources.map((source) => source.url).filter(Boolean));
    for (const section of sections) {
      if (containsUnsupportedSourceUrl(`${section.title}\n${section.text}`, allowedUrls)) {
        invalidIndexes.add(section.index);
      }
    }
  }
  if (forceAll
      || warningCodes.some((code) => code !== 'unsupported_source_url')
      || invalidIndexes.size === 0) {
    sections.forEach((section) => invalidIndexes.add(section.index));
  }
  const validation = JSON.stringify({
    valid: false,
    finalValidationWarnings: [...new Set(warningCodes)],
  });
  const updatedAt = new Date().toISOString();
  const rejectedSections: ValidatedSection[] = [];
  const changed = db.transaction(() => {
    assertOwnedUnexpiredLease(db, row.job_id, leaseToken);
    const invalidate = db.prepare(`UPDATE content_script_job_checkpoints
      SET state = 'invalid', validation_json = ?, updated_at = ?
      WHERE job_id = ? AND section_index = ? AND state = 'validated'
        AND EXISTS (
          SELECT 1 FROM content_script_jobs
          WHERE job_id = ? AND status = 'running' AND lease_token = ?
            AND cancellation_requested_at IS NULL AND lease_expires_at > ?
        )`);
    let changed = 0;
    for (const sectionIndex of invalidIndexes) {
      const invalidated = invalidate.run(
        validation,
        updatedAt,
        row.job_id,
        sectionIndex,
        row.job_id,
        leaseToken,
        updatedAt,
      ).changes;
      changed += invalidated;
      if (invalidated === 1) {
        const section = sections.find((candidate) => candidate.index === sectionIndex);
        if (section) rejectedSections.push(section);
      }
    }
    return changed;
  }).immediate();
  for (const section of rejectedSections) {
    rejectInferenceRunIds(db, row, section.inferenceRunIds, rejectionReason);
  }
  return changed;
}

function rejectInferenceRunIds(
  db: Database.Database,
  row: JobRow,
  runIds: readonly string[],
  reason: string,
): void {
  for (const runId of new Set(runIds.filter((value) => typeof value === 'string' && value.trim()))) {
    rejectSkillInferenceApplicationResult({
      runId,
      tenantId: row.tenant_id,
      userId: row.owner_user_id,
      reason,
    }, db);
  }
}

function checkpointFinalRepairWarnings(
  db: Database.Database,
  jobId: string,
  sectionIndex: number,
): string[] {
  const checkpoint = db.prepare(`SELECT validation_json
    FROM content_script_job_checkpoints
    WHERE job_id = ? AND section_index = ? AND state IN ('invalid', 'generating')`)
    .get(jobId, sectionIndex) as { validation_json: string | null } | undefined;
  if (!checkpoint?.validation_json) return [];
  try {
    const parsed = JSON.parse(checkpoint.validation_json) as { finalValidationWarnings?: unknown };
    return Array.isArray(parsed.finalValidationWarnings)
      ? parsed.finalValidationWarnings.filter((code): code is string => typeof code === 'string')
      : [];
  } catch {
    return [];
  }
}

function invalidateOutlineForFinalRepair(
  db: Database.Database,
  row: JobRow,
  leaseToken: string,
  outline: ScriptOutline,
  warningCodes: string[],
): void {
  const updatedAt = new Date().toISOString();
  const changed = db.prepare(`UPDATE content_script_job_checkpoints
    SET state = 'invalid', validation_json = ?, updated_at = ?
    WHERE job_id = ? AND section_index = 0 AND state = 'validated'
      AND EXISTS (
        SELECT 1 FROM content_script_jobs
        WHERE job_id = ? AND status = 'running' AND lease_token = ?
          AND cancellation_requested_at IS NULL AND lease_expires_at > ?
      )`).run(
    JSON.stringify({ valid: false, finalValidationWarnings: warningCodes }),
    updatedAt,
    row.job_id,
    row.job_id,
    leaseToken,
    updatedAt,
  );
  if (changed.changes !== 1) {
    throw new ContentScriptJobError('CONTENT_SCRIPT_JOB_LEASE_LOST', 'Script job lease was lost.', 409);
  }
  rejectInferenceRunIds(
    db,
    row,
    outline.inferenceRunIds,
    'content_script_outline_final_validation_failed',
  );
}

function targetScriptWords(request: ContentScriptJobRequest): number {
  const minimum = request.format === 'Reel' ? 30 : 120;
  return Math.max(minimum, Math.min(2_400, Math.round((request.targetDurationSeconds / 60) * 140)));
}

function targetSectionCount(request: ContentScriptJobRequest): number {
  if (request.format === 'Reel') return request.targetDurationSeconds <= 30 ? 1 : 2;
  if (request.targetDurationSeconds <= 180) return 4;
  if (request.targetDurationSeconds <= 480) return 6;
  return 8;
}

function assertPinnedModelIsActive(request: ContentScriptJobRequest): void {
  const manifest = getLocalModelManifest({ fresh: true });
  const active = manifest.models.find((model) => model.id === manifest.activeModelId)!;
  if (manifest.manifestVersion !== request.pinnedManifestVersion
      || active.id !== request.pinnedModelId
      || active.ollamaTag !== request.pinnedModelTag
      || active.digest !== request.pinnedModelDigest) {
    throw new ContentScriptJobError(
      'CONTENT_SCRIPT_PINNED_MODEL_UNAVAILABLE',
      'The model pinned to this script job is no longer the active signed model.',
      409,
    );
  }
}

function outlineSchema(sectionCount: number): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['hook', 'titleOptions', 'sections'],
    properties: {
      hook: { type: 'string' },
      titleOptions: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } },
      sections: {
        type: 'array',
        minItems: sectionCount,
        maxItems: sectionCount,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'title', 'instructions'],
          properties: {
            key: { type: 'string' },
            title: { type: 'string' },
            instructions: { type: 'string' },
          },
        },
      },
    },
  };
}

async function runLocalStage(
  db: Database.Database,
  row: JobRow,
  request: ContentScriptJobRequest,
  signal: AbortSignal,
  input: {
    taskType: string;
    prompt: string;
    schemaId: 'generic_json' | 'text';
    outputSchema?: Record<string, unknown>;
    requestedOutputTokens: number;
  },
): Promise<SkillInferenceResult> {
  assertPinnedModelIsActive(request);
  const result = await executeSkillInference({
    tenantId: row.tenant_id,
    userId: row.owner_user_id,
    skillId: 'content',
    taskType: input.taskType,
    riskClass: 'low',
    executionClass: 'background',
    operationId: row.operation_id,
    prompt: input.prompt,
    applicationGuidance: `Write in ${request.language}. This is one private, local-only stage of a resumable Content script job.`,
    schemaId: input.schemaId,
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    requestedOutputTokens: input.requestedOutputTokens,
    temperature: input.schemaId === 'generic_json' ? 0.2 : 0.65,
    containsPrivateData: true,
    allowCloudEscalation: false,
    redactionRequired: true,
    requestSource: 'automation',
    budgetRequest: {
      userId: row.owner_user_id,
      requestSource: 'automation',
      baseCategory: `content_script_job_${input.taskType}`,
      jobName: 'content_script_job_local_stage',
      runId: row.operation_id,
    },
    cloudBudgetBoundary: async () => {
      throw new SkillInferencePolicyError(
        'CONTENT_SCRIPT_JOB_CLOUD_ESCALATION_NOT_AUTHORIZED',
        'Private script jobs require explicit cloud-escalation authority.',
        403,
      );
    },
    abortSignal: signal,
    deadlineMs: 5 * 60 * 1000,
  }, db);
  if (result.model !== request.pinnedModelTag
      || result.modelDigest !== request.pinnedModelDigest) {
    rejectSkillInferenceApplicationResult({
      runId: result.runId,
      tenantId: row.tenant_id,
      userId: row.owner_user_id,
      reason: 'content_script_pinned_model_mismatch',
    }, db);
    throw new ContentScriptJobError(
      'CONTENT_SCRIPT_PINNED_MODEL_MISMATCH',
      'A script stage did not execute on the model digest pinned to the job.',
      502,
    );
  }
  return result;
}

function assertOwnedUnexpiredLease(
  db: Database.Database,
  jobId: string,
  leaseToken: string,
): void {
  const lease = db.prepare(`SELECT 1 AS owned FROM content_script_jobs
    WHERE job_id = ? AND status = 'running' AND lease_token = ?
      AND cancellation_requested_at IS NULL AND lease_expires_at > ?`)
    .get(jobId, leaseToken, new Date().toISOString()) as { owned: number } | undefined;
  if (!lease) throw new ContentScriptJobError('CONTENT_SCRIPT_JOB_LEASE_LOST', 'Script job lease was lost.', 409);
}

function persistCheckpoint(
  db: Database.Database,
  row: JobRow,
  leaseToken: string,
  checkpoint: {
    sectionIndex: number;
    sectionKey: string;
    wordBudget: number;
    output: unknown;
    validation: Record<string, unknown>;
    modelDigest: string | null;
  },
): void {
  db.transaction(() => {
    assertOwnedUnexpiredLease(db, row.job_id, leaseToken);
    db.prepare(`INSERT INTO content_script_job_checkpoints (
    job_id, section_index, section_key, state, word_budget,
    output_json, validation_json, route, model_digest
    ) VALUES (?, ?, ?, 'validated', ?, ?, ?, 'local', ?)
    ON CONFLICT(job_id, section_index) DO UPDATE SET
      section_key = excluded.section_key, state = excluded.state,
      word_budget = excluded.word_budget, output_json = excluded.output_json,
      validation_json = excluded.validation_json, route = excluded.route,
      model_digest = excluded.model_digest, updated_at = excluded.updated_at`)
      .run(
      row.job_id,
      checkpoint.sectionIndex,
      checkpoint.sectionKey,
      checkpoint.wordBudget,
      encryptContentScriptJobJson(checkpoint.output, row.owner_user_id),
      JSON.stringify(checkpoint.validation),
      checkpoint.modelDigest,
    );
    db.prepare(`UPDATE content_script_jobs
      SET infrastructure_requeue_count = 0, next_attempt_at = NULL
      WHERE job_id = ? AND status = 'running' AND lease_token = ?`)
      .run(row.job_id, leaseToken);
  }).immediate();
}

function persistGeneratedCheckpoint(
  db: Database.Database,
  row: JobRow,
  leaseToken: string,
  checkpoint: {
    sectionIndex: number;
    sectionKey: string;
    wordBudget: number;
    output: unknown;
    validation: Record<string, unknown>;
    modelDigest: string | null;
  },
  inferenceRunIds: readonly string[],
): void {
  try {
    persistCheckpoint(db, row, leaseToken, checkpoint);
  } catch (error) {
    const failureReason = localInferenceFailureReason(error)
      ?.toLowerCase()
      .replace(/[^a-z0-9_]+/gu, '_')
      .slice(0, 96) || 'unknown';
    for (const runId of new Set(inferenceRunIds.filter(Boolean))) {
      rejectSkillInferenceApplicationResult({
        runId,
        tenantId: row.tenant_id,
        userId: row.owner_user_id,
        reason: `content_script_checkpoint_not_committed_${failureReason}`,
      }, db);
    }
    throw error;
  }
}

type ContentScriptCheckpointState = 'planned' | 'generating' | 'invalid' | 'cancelled';

function beginCheckpoint(
  db: Database.Database,
  row: JobRow,
  leaseToken: string,
  checkpoint: { sectionIndex: number; sectionKey: string; wordBudget: number },
): void {
  db.transaction(() => {
    assertOwnedUnexpiredLease(db, row.job_id, leaseToken);
    db.prepare(`INSERT INTO content_script_job_checkpoints (
      job_id, section_index, section_key, state, word_budget
    ) VALUES (?, ?, ?, 'generating', ?)
    ON CONFLICT(job_id, section_index) DO UPDATE SET
      section_key = excluded.section_key,
      state = CASE
        WHEN content_script_job_checkpoints.state = 'validated' THEN 'validated'
        ELSE 'generating'
      END,
      word_budget = excluded.word_budget,
      updated_at = excluded.updated_at`)
      .run(row.job_id, checkpoint.sectionIndex, checkpoint.sectionKey, checkpoint.wordBudget);
  }).immediate();
}

function planSectionCheckpoints(
  db: Database.Database,
  row: JobRow,
  leaseToken: string,
  outline: ScriptOutline,
): void {
  db.transaction(() => {
    assertOwnedUnexpiredLease(db, row.job_id, leaseToken);
    const insert = db.prepare(`INSERT OR IGNORE INTO content_script_job_checkpoints (
      job_id, section_index, section_key, state, word_budget
    ) VALUES (?, ?, ?, 'planned', ?)`);
    outline.sections.forEach((section, index) => {
      insert.run(row.job_id, index + 1, section.key, section.wordBudget);
    });
  }).immediate();
}

function settleInFlightCheckpoint(
  db: Database.Database,
  jobId: string,
  leaseToken: string,
  state: Extract<ContentScriptCheckpointState, 'invalid' | 'cancelled'>,
): void {
  try {
    if (state === 'cancelled') {
      // API cancellation settles the in-flight checkpoint in the same
      // transaction that still owns the lease token. The exiting worker must
      // never perform an unfenced post-cancel checkpoint mutation.
      return;
    }
    db.prepare(`UPDATE content_script_job_checkpoints
      SET state = 'invalid', updated_at = ?
      WHERE job_id = ? AND state = 'generating'
        AND EXISTS (
          SELECT 1 FROM content_script_jobs
          WHERE job_id = ? AND status = 'running' AND lease_token = ?
        )`)
      .run(new Date().toISOString(), jobId, jobId, leaseToken);
  } catch (error) {
    logger.warn({
      jobId,
      state,
      errorName: error instanceof Error ? error.name : typeof error,
    }, 'Content script checkpoint lifecycle update failed');
  }
}

function distributeWordBudgets(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  return Array.from({ length: count }, (_, index) => base + (index < total % count ? 1 : 0));
}

function parseOutline(value: unknown, request: ContentScriptJobRequest): ScriptOutline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContentScriptJobError('CONTENT_SCRIPT_OUTLINE_INVALID', 'The local outline was invalid.', 422);
  }
  const record = value as Record<string, unknown>;
  const expectedCount = targetSectionCount(request);
  if (typeof record.hook !== 'string' || !record.hook.trim()
      || !Array.isArray(record.titleOptions) || record.titleOptions.length < 3
      || record.titleOptions.some((item) => typeof item !== 'string' || !item.trim())
      || !Array.isArray(record.sections) || record.sections.length !== expectedCount) {
    throw new ContentScriptJobError('CONTENT_SCRIPT_OUTLINE_INVALID', 'The local outline was invalid.', 422);
  }
  const normalizedSections = record.sections.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ContentScriptJobError('CONTENT_SCRIPT_OUTLINE_INVALID', 'The local outline was invalid.', 422);
    }
    const section = item as Record<string, unknown>;
    if (typeof section.title !== 'string' || !section.title.trim()
        || typeof section.instructions !== 'string' || !section.instructions.trim()) {
      throw new ContentScriptJobError('CONTENT_SCRIPT_OUTLINE_INVALID', 'The local outline was invalid.', 422);
    }
    return {
      title: section.title.trim().slice(0, 200),
      instructions: section.instructions.trim().slice(0, 1_000),
    };
  });
  // Section titles are delivered inside `result.script`, so reserve their
  // words before distributing prose budgets. Without this subtraction a
  // nominal 2,100-word body systematically overshoots its assembled target.
  const titleWords = normalizedSections.reduce((total, section) => total + wordCount(section.title), 0);
  const bodyWordTarget = Math.max(expectedCount * 5, targetScriptWords(request) - titleWords);
  const budgets = distributeWordBudgets(bodyWordTarget, expectedCount);
  const sections = normalizedSections.map((section, index) => ({
    key: `section_${index + 1}`,
    ...section,
    wordBudget: budgets[index],
  }));
  return {
    hook: record.hook.trim().slice(0, 1_000),
    titleOptions: (record.titleOptions as string[]).slice(0, 5).map((item) => item.trim().slice(0, 300)),
    sections,
    inferenceRunIds: [],
  };
}

function readOutlineCheckpoint(
  db: Database.Database,
  row: JobRow,
): ScriptOutline | null {
  const checkpoint = db.prepare(`SELECT output_json
    FROM content_script_job_checkpoints
    WHERE job_id = ? AND section_index = 0
      AND section_key = 'outline' AND state = 'validated' AND route = 'local'`)
    .get(row.job_id) as { output_json: string } | undefined;
  if (!checkpoint) return null;
  const outline = decryptContentScriptJobJson<ScriptOutline>(checkpoint.output_json, row.owner_user_id);
  return {
    ...outline,
    inferenceRunIds: Array.isArray(outline.inferenceRunIds)
      ? outline.inferenceRunIds.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

function readValidatedSections(db: Database.Database, row: JobRow): Map<number, ValidatedSection> {
  const checkpoints = db.prepare(`SELECT section_index, output_json
    FROM content_script_job_checkpoints
    WHERE job_id = ? AND section_index > 0 AND state = 'validated' AND route = 'local'
    ORDER BY section_index`).all(row.job_id) as Array<{ section_index: number; output_json: string }>;
  return new Map(checkpoints.map((checkpoint) => {
    const section = decryptContentScriptJobJson<ValidatedSection>(checkpoint.output_json, row.owner_user_id);
    return [checkpoint.section_index, {
      ...section,
      inferenceRunIds: Array.isArray(section.inferenceRunIds)
        ? section.inferenceRunIds.filter((value): value is string => typeof value === 'string')
        : [],
    }] as const;
  }));
}

function parsedJson(result: SkillInferenceResult): unknown {
  if (result.parsed !== undefined) return result.parsed;
  try {
    return JSON.parse(result.text);
  } catch {
    throw new ContentScriptJobError('CONTENT_SCRIPT_OUTLINE_INVALID', 'The local outline was invalid.', 422);
  }
}

const TRUNCATED_STOP_REASONS = new Set(['length', 'LENGTH', 'max_tokens', 'MAX_TOKENS']);

function stageWasTruncated(result: SkillInferenceResult): boolean {
  return typeof result.stopReason === 'string' && TRUNCATED_STOP_REASONS.has(result.stopReason);
}

function completeProsePrefix(value: string): string {
  const text = value.trim();
  let lastBoundary = -1;
  const boundaries = /[.!?](?:["')\]]+)?(?=\s|$)/gu;
  for (const match of text.matchAll(boundaries)) {
    lastBoundary = (match.index ?? -1) + match[0].length;
  }
  return lastBoundary > 0 ? text.slice(0, lastBoundary).trim() : '';
}

function completeSectionPrefix(value: string, style: 'detailed' | 'bullets'): string {
  if (style === 'detailed') return completeProsePrefix(value);
  const text = value.trim();
  const lastLineBreak = text.lastIndexOf('\n');
  return lastLineBreak > 0 ? text.slice(0, lastLineBreak).trim() : '';
}

async function generateOutline(
  db: Database.Database,
  row: JobRow,
  request: ContentScriptJobRequest,
  signal: AbortSignal,
): Promise<{ outline: ScriptOutline; modelDigest: string | null }> {
  const finalRepairWarnings = checkpointFinalRepairWarnings(db, row.job_id, 0);
  const sectionCount = targetSectionCount(request);
  const totalWords = targetScriptWords(request);
  const prompt = JSON.stringify({
    task: 'Create a production-ready long-form script outline.',
    topic: request.topic,
    niche: request.niche,
    format: request.format,
    language: request.language,
    style: request.scriptStyle,
    targetWords: totalWords,
    exactSectionCount: sectionCount,
    creatorVoice: request.pinnedCreatorVoice || undefined,
    sourceContext: request.pinnedSources.length > 0 ? request.pinnedSources : undefined,
    finalRepairWarnings: finalRepairWarnings.length > 0 ? finalRepairWarnings : undefined,
    requirements: [
      'Return one JSON object matching the schema.',
      'Use exactly the requested number of sections.',
      'Give each section a stable key, concise title, and concrete writing instructions.',
      'Do not claim current facts or sources that were not supplied.',
      ...(finalRepairWarnings.includes('fifteen_minute_word_count_out_of_range')
        ? ['FINAL REPAIR: Keep every section title under eight words so headings do not push the assembled script beyond 2,400 words.']
        : []),
      ...(finalRepairWarnings.includes('unsupported_source_url')
        ? [request.pinnedSources.length > 0
          ? 'FINAL REPAIR: Include a URL only when it exactly matches one of the supplied source URLs.'
          : 'FINAL REPAIR: Do not include any URL because no source URL was supplied.']
        : []),
      ...(finalRepairWarnings.includes('content_script_output_language_mismatch')
        ? [`FINAL REPAIR: Rewrite the complete outline in ${request.language}; do not preserve text in another language.`]
        : []),
      ...(finalRepairWarnings.includes('content_script_output_safety_blocked')
        ? ['FINAL REPAIR: Replace the unsafe framing at outline level with safe, useful guidance before drafting sections.']
        : []),
    ],
  });
  let lastInvalid: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runLocalStage(db, row, request, signal, {
      taskType: attempt === 0
        ? finalRepairWarnings.length > 0 ? 'script_outline_final_repair' : 'script_outline'
        : 'script_outline_repair',
      prompt: attempt === 0 ? prompt : `${prompt}\nThe previous outline failed semantic validation. Return a corrected JSON object only.`,
      schemaId: 'generic_json',
      outputSchema: outlineSchema(sectionCount),
      requestedOutputTokens: 2_048,
    });
    try {
      if (stageWasTruncated(result)) {
        throw new ContentScriptJobError('CONTENT_SCRIPT_OUTLINE_TRUNCATED', 'The local outline reached its output boundary.', 422);
      }
      return {
        outline: {
          ...parseOutline(parsedJson(result), request),
          inferenceRunIds: [result.runId],
        },
        modelDigest: result.modelDigest ?? null,
      };
    } catch (error) {
      rejectSkillInferenceApplicationResult({
        runId: result.runId,
        tenantId: row.tenant_id,
        userId: row.owner_user_id,
        reason: 'content_script_outline_semantic_invalid',
      }, db);
      lastInvalid = error;
    }
  }
  throw lastInvalid;
}

function validSectionText(
  text: string,
  wordBudget: number,
  style: 'detailed' | 'bullets',
): boolean {
  const words = wordCount(text);
  if (words < Math.max(5, Math.floor(wordBudget * 0.92))
      || words > Math.ceil(wordBudget * 1.08)) return false;
  if (style === 'detailed') return completeProsePrefix(text).length === text.trim().length;
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.length >= 3 && lines.every((line) => /^(?:[-*•]|\d+[.)])\s+\S/u.test(line));
}

async function generateSection(
  db: Database.Database,
  row: JobRow,
  request: ContentScriptJobRequest,
  outline: ScriptOutline,
  section: ScriptOutlineSection,
  index: number,
  prior: ValidatedSection[],
  signal: AbortSignal,
): Promise<ValidatedSection> {
  const finalRepairWarnings = checkpointFinalRepairWarnings(db, row.job_id, index + 1);
  const continuity = prior.length > 0
    ? prior[prior.length - 1].text.slice(-1_500)
    : '';
  const basePrompt = JSON.stringify({
    task: request.scriptStyle === 'bullets'
      ? 'Write exactly one section of concise bullet-point speaking notes.'
      : 'Write exactly one section of a longer spoken script.',
    topic: request.topic,
    language: request.language,
    format: request.format,
    style: request.scriptStyle,
    overallHook: outline.hook,
    sectionNumber: index + 1,
    totalSections: outline.sections.length,
    sectionTitle: section.title,
    sectionInstructions: section.instructions,
    targetWords: section.wordBudget,
    previousSectionEnding: continuity || undefined,
    creatorVoice: request.pinnedCreatorVoice || undefined,
    sourceContext: request.pinnedSources.length > 0 ? request.pinnedSources : undefined,
    finalRepairWarnings: finalRepairWarnings.length > 0 ? finalRepairWarnings : undefined,
    requirements: [
      request.scriptStyle === 'bullets'
        ? 'Return at least three complete bullet lines; begin every non-empty line with -, *, •, or a numbered marker.'
        : 'Return only spoken script prose for this section and finish every sentence.',
      'Stay within 8 percent of the target word count.',
      'Do not repeat earlier material or add markdown fences.',
      'Do not invent sources or claim access to current information.',
      ...(finalRepairWarnings.includes('unsupported_source_url')
        ? [request.pinnedSources.length > 0
          ? 'FINAL REPAIR: Include a URL only when it exactly matches one of the supplied source URLs.'
          : 'FINAL REPAIR: Do not include any URL because no source URL was supplied.']
        : []),
      ...(finalRepairWarnings.includes('fifteen_minute_word_count_out_of_range')
        ? ['FINAL REPAIR: Follow the section word budget exactly so the assembled script stays within 1,900-2,400 words.']
        : []),
      ...(finalRepairWarnings.includes('content_script_output_safety_blocked')
        ? ['FINAL REPAIR: Remove unsafe instructions, harmful claims, and policy-sensitive material; preserve only useful safe guidance.']
        : []),
      ...(finalRepairWarnings.includes('content_script_output_language_mismatch')
        ? [`FINAL REPAIR: Use only ${request.language} and return one complete, validation-ready section.`]
        : []),
      ...(finalRepairWarnings.includes('final_validation_exception')
        ? ['FINAL REPAIR: Rewrite this section as complete, non-empty, validation-ready output that satisfies every structure and word-budget requirement.']
        : []),
    ],
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runLocalStage(db, row, request, signal, {
      taskType: attempt === 0
        ? finalRepairWarnings.length > 0 ? 'script_section_final_repair' : 'script_section'
        : 'script_section_repair',
      prompt: attempt === 0
        ? basePrompt
        : `${basePrompt}\nThe prior draft missed the word-count or completeness requirement. Rewrite this section completely.`,
      schemaId: 'text',
      requestedOutputTokens: Math.min(6_144, Math.max(1_024, section.wordBudget * 3)),
    });
    let text = result.text.trim();
    let modelDigest = result.modelDigest ?? null;
    let continuationComplete = !stageWasTruncated(result);
    const stageResults = [result];
    if (!continuationComplete) {
      const prefix = completeSectionPrefix(text, request.scriptStyle);
      const prefixWords = wordCount(prefix);
      const maximumWords = Math.ceil(section.wordBudget * 1.08);
      if (prefixWords >= 20 && prefixWords < maximumWords) {
        const remainingWords = Math.max(20, section.wordBudget - prefixWords);
        const continuation = await runLocalStage(db, row, request, signal, {
          taskType: 'script_section_continuation',
          prompt: JSON.stringify({
            task: 'Continue one truncated script section from its last complete sentence.',
            topic: request.topic,
            language: request.language,
            sectionTitle: section.title,
            sectionInstructions: section.instructions,
            exactPrefixEnding: prefix.slice(-1_500),
            targetAdditionalWords: remainingWords,
            style: request.scriptStyle,
            creatorVoice: request.pinnedCreatorVoice || undefined,
            sourceContext: request.pinnedSources.length > 0 ? request.pinnedSources : undefined,
            requirements: [
              request.scriptStyle === 'bullets'
                ? 'Return only new complete bullet lines; never repeat the supplied prefix and begin every line with a bullet marker.'
                : 'Return only the new continuation prose; never repeat the supplied prefix.',
              request.scriptStyle === 'bullets'
                ? 'Finish with a complete bullet line and no markdown fence.'
                : 'Finish the section with a complete sentence and no markdown fence.',
              'Do not invent sources or current facts.',
            ],
          }),
          schemaId: 'text',
          requestedOutputTokens: Math.min(6_144, Math.max(512, remainingWords * 3)),
        });
        text = `${prefix}\n\n${continuation.text.trim()}`.trim();
        modelDigest = continuation.modelDigest ?? modelDigest;
        continuationComplete = !stageWasTruncated(continuation);
        stageResults.push(continuation);
      }
    }
    if (continuationComplete && validSectionText(text, section.wordBudget, request.scriptStyle)) {
      return {
        index: index + 1,
        key: section.key,
        title: section.title,
        text,
        wordBudget: section.wordBudget,
        modelDigest,
        inferenceRunIds: stageResults.map((stageResult) => stageResult.runId),
      };
    }
    for (const stageResult of stageResults) {
      rejectSkillInferenceApplicationResult({
        runId: stageResult.runId,
        tenantId: row.tenant_id,
        userId: row.owner_user_id,
        reason: 'content_script_section_semantic_invalid',
      }, db);
    }
  }
  throw new ContentScriptJobError(
    'CONTENT_SCRIPT_SECTION_INVALID',
    `Section ${index + 1} failed bounded local validation.`,
    422,
  );
}

function assembleScriptResult(
  request: ContentScriptJobRequest,
  outline: ScriptOutline,
  sections: ValidatedSection[],
  startedAt: number,
): EngineScriptResponse {
  return {
    topic: request.topic,
    script: sections.map((section) => `${section.title}\n\n${section.text}`).join('\n\n'),
    hook: outline.hook,
    title_options: outline.titleOptions,
    sources_used: request.pinnedSources,
    estimated_duration: `${Math.max(1, Math.round(request.targetDurationSeconds / 60))} minutes`,
    duration_ms: Date.now() - startedAt,
    generation_mode: request.mode,
    cache_status: 'miss',
  };
}

async function regenerateEntireDraftForFinalRepair(
  db: Database.Database,
  row: JobRow,
  leaseToken: string,
  request: ContentScriptJobRequest,
  currentOutline: ScriptOutline,
  sections: ValidatedSection[],
  warningCodes: string[],
  signal: AbortSignal,
  rejectionReason = 'content_script_final_validation_failed',
): Promise<{ outline: ScriptOutline; modelDigest: string | null }> {
  invalidateSectionsForFinalRepair(
    db,
    row,
    leaseToken,
    request,
    sections,
    warningCodes,
    true,
    rejectionReason,
  );
  invalidateOutlineForFinalRepair(
    db,
    row,
    leaseToken,
    currentOutline,
    warningCodes,
  );
  beginCheckpoint(db, row, leaseToken, {
    sectionIndex: 0,
    sectionKey: 'outline',
    wordBudget: targetScriptWords(request),
  });
  const regenerated = await generateOutline(db, row, request, signal);
  persistGeneratedCheckpoint(db, row, leaseToken, {
    sectionIndex: 0,
    sectionKey: 'outline',
    wordBudget: targetScriptWords(request),
    output: regenerated.outline,
    validation: { valid: true, sectionCount: regenerated.outline.sections.length },
    modelDigest: regenerated.modelDigest,
  }, regenerated.outline.inferenceRunIds);
  planSectionCheckpoints(db, row, leaseToken, regenerated.outline);
  return regenerated;
}

export async function runContentScriptJob(
  jobId: string,
  db: Database.Database = getDb(),
): Promise<ContentScriptJobView | null> {
  assertJobsEnabled();
  const runtimeControl = getLocalInferenceRuntimeControl(db);
  const queuedOwner = db.prepare(`SELECT owner_user_id FROM content_script_jobs WHERE job_id = ?`)
    .get(jobId) as { owner_user_id: number } | undefined;
  const runtimeAdmitted = runtimeControl.mode === 'active'
    || (runtimeControl.mode === 'canary'
      && queuedOwner !== undefined
      && isLocalInferenceUserEnrolled(queuedOwner.owner_user_id, runtimeControl.rolloutPercent));
  if (!runtimeAdmitted) {
    const durableProgress = checkpointDerivedProgress(db, jobId);
    db.prepare(`UPDATE content_script_jobs
      SET status = 'waiting_capacity', stage = 'waiting_capacity',
          progress_percent = MAX(progress_percent, ?), updated_at = ?
      WHERE job_id = ? AND status = 'queued'`)
      .run(durableProgress, new Date().toISOString(), jobId);
    const waiting = db.prepare('SELECT * FROM content_script_jobs WHERE job_id = ?').get(jobId) as JobRow | undefined;
    return waiting ? mapJob(waiting) : null;
  }
  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  const checkpointState = db.prepare(`SELECT
      MAX(CASE WHEN section_index = 0 AND section_key = 'outline' AND state = 'validated' THEN 1 ELSE 0 END) AS has_outline,
      COUNT(CASE WHEN section_index > 0 AND state = 'validated' THEN 1 END) AS validated_sections
    FROM content_script_job_checkpoints WHERE job_id = ?`)
    .get(jobId) as { has_outline: number; validated_sections: number };
  const claimedStage = checkpointState.has_outline ? 'resume_checkpoint' : 'outline';
  const claimedProgress = checkpointState.has_outline ? checkpointDerivedProgress(db, jobId) : 0;
  const claim = db.prepare(`UPDATE content_script_jobs
    SET status = 'running', stage = ?, progress_percent = MAX(progress_percent, ?),
        lease_token = ?, lease_expires_at = ?, attempt_count = attempt_count + 1,
        started_at = COALESCE(started_at, ?), last_error_code = NULL,
        next_attempt_at = NULL, updated_at = ?
    WHERE job_id = ? AND status IN ('queued', 'waiting_capacity')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`)
    .run(
      claimedStage,
      claimedProgress,
      token,
      new Date(now.getTime() + LEASE_MS).toISOString(),
      now.toISOString(),
      now.toISOString(),
      jobId,
      now.toISOString(),
    );
  if (claim.changes !== 1) return null;
  const row = db.prepare('SELECT * FROM content_script_jobs WHERE job_id = ?').get(jobId) as JobRow;
  const controller = new AbortController();
  controllers.set(jobId, { leaseToken: token, controller });
  const heartbeat = setInterval(() => {
    try {
      if (!heartbeatLease(db, jobId, token)) {
        recoverableAbortCodes.set(token, 'CONTENT_SCRIPT_JOB_LEASE_LOST');
        controller.abort(createContentScriptInfrastructureAbort('CONTENT_SCRIPT_JOB_LEASE_LOST'));
      }
    } catch (error) {
      logger.warn({ jobId, errorName: error instanceof Error ? error.name : typeof error }, 'Content script lease heartbeat failed');
      recoverableAbortCodes.set(token, 'CONTENT_SCRIPT_HEARTBEAT_FAILED');
      controller.abort(createContentScriptInfrastructureAbort('CONTENT_SCRIPT_HEARTBEAT_FAILED'));
    }
  }, 60_000);
  heartbeat.unref?.();
  try {
    const storedRequest = decryptContentScriptJobJson<ContentScriptJobRequest>(
      row.request_json,
      row.owner_user_id,
    );
    const request: ContentScriptJobRequest = {
      ...storedRequest,
      pinnedCreatorVoice: typeof storedRequest.pinnedCreatorVoice === 'string'
        ? storedRequest.pinnedCreatorVoice.slice(0, 8_000)
        : null,
      pinnedSources: Array.isArray(storedRequest.pinnedSources) ? storedRequest.pinnedSources : [],
    };
    assertPinnedModelIsActive(request);
    let outline = readOutlineCheckpoint(db, row);
    let modelDigest: string | null = request.pinnedModelDigest;
    if (!outline) {
      updateProgress(db, jobId, token, 'outline', 0);
      beginCheckpoint(db, row, token, {
        sectionIndex: 0,
        sectionKey: 'outline',
        wordBudget: targetScriptWords(request),
      });
      const generated = await generateOutline(db, row, request, controller.signal);
      outline = generated.outline;
      modelDigest = generated.modelDigest;
      persistGeneratedCheckpoint(db, row, token, {
        sectionIndex: 0,
        sectionKey: 'outline',
        wordBudget: targetScriptWords(request),
        output: outline,
        validation: { valid: true, sectionCount: outline.sections.length },
        modelDigest,
      }, outline.inferenceRunIds);
      updateProgress(db, jobId, token, 'outline_validation', 18);
    } else {
      updateProgress(db, jobId, token, 'resume_checkpoint', checkpointDerivedProgress(db, jobId));
    }
    planSectionCheckpoints(db, row, token, outline);

    let sections: ValidatedSection[] = [];
    let result!: EngineScriptResponse;
    let warnings: string[] = [];
    let publicResult!: ReturnType<typeof buildScriptSuccessResponse>;
    let finalRepairPass = row.final_repair_count;
    while (true) {
      const validated = readValidatedSections(db, row);
      sections = [];
      for (let index = 0; index < outline.sections.length; index += 1) {
        if (controller.signal.aborted) {
          throw Object.assign(new Error('script_job_cancelled'), { code: 'SCRIPT_JOB_CANCELLED' });
        }
        const existing = validated.get(index + 1);
        if (existing) {
          sections.push(existing);
          modelDigest = existing.modelDigest ?? modelDigest;
          continue;
        }
        const progressStart = 20 + Math.floor((index / outline.sections.length) * 60);
        updateProgress(
          db,
          jobId,
          token,
          `section_${index + 1}_generation`,
          checkpointDerivedProgress(db, jobId),
        );
        beginCheckpoint(db, row, token, {
          sectionIndex: index + 1,
          sectionKey: outline.sections[index].key,
          wordBudget: outline.sections[index].wordBudget,
        });
        const generated = await generateSection(
          db, row, request, outline, outline.sections[index], index, sections, controller.signal,
        );
        persistGeneratedCheckpoint(db, row, token, {
          sectionIndex: index + 1,
          sectionKey: generated.key,
          wordBudget: generated.wordBudget,
          output: generated,
          validation: { valid: true, wordCount: wordCount(generated.text) },
          modelDigest: generated.modelDigest,
        }, generated.inferenceRunIds);
        updateProgress(db, jobId, token, `section_${index + 1}_validation`, progressStart + 5);
        sections.push(generated);
        modelDigest = generated.modelDigest ?? modelDigest;
      }

      updateProgress(db, jobId, token, 'assembly', 85);
      result = assembleScriptResult(request, outline, sections, now.getTime());
      try {
        warnings = validateResult(request, result);
      } catch (error) {
        const validationWarning = error instanceof ContentOutputLanguageMismatchError
          ? 'content_script_output_language_mismatch'
          : 'final_validation_exception';
        if (finalRepairPass < MAX_FINAL_REPAIR_PASSES
            && claimFinalRepairPass(db, row, token)) {
          finalRepairPass += 1;
          if (validationWarning === 'content_script_output_language_mismatch') {
            const regenerated = await regenerateEntireDraftForFinalRepair(
              db,
              row,
              token,
              request,
              outline,
              sections,
              [validationWarning],
              controller.signal,
              validationWarning,
            );
            outline = regenerated.outline;
            modelDigest = regenerated.modelDigest ?? modelDigest;
          } else {
            invalidateSectionsForFinalRepair(
              db, row, token, request, sections, [validationWarning],
            );
          }
          continue;
        }
        invalidateSectionsForFinalRepair(
          db,
          row,
          token,
          request,
          sections,
          [validationWarning],
          validationWarning === 'content_script_output_language_mismatch',
          validationWarning,
        );
        if (validationWarning === 'content_script_output_language_mismatch') {
          invalidateOutlineForFinalRepair(
            db,
            row,
            token,
            outline,
            [validationWarning],
          );
        }
        throw error;
      }
      if (warnings.length > 0) {
        const reviewableAfterRepair = finalRepairPass > 0
          && warnings.every((code) => code === 'fifteen_minute_word_count_out_of_range');
        if (!reviewableAfterRepair) {
          const repairOutline = warnings.includes('fifteen_minute_word_count_out_of_range')
            || (warnings.includes('unsupported_source_url')
              && outlineContainsUnsupportedSourceUrl(request, outline));
          if (finalRepairPass < MAX_FINAL_REPAIR_PASSES
              && claimFinalRepairPass(db, row, token)) {
            finalRepairPass += 1;
            if (repairOutline) {
              const regenerated = await regenerateEntireDraftForFinalRepair(
                db,
                row,
                token,
                request,
                outline,
                sections,
                warnings,
                controller.signal,
              );
              outline = regenerated.outline;
              modelDigest = regenerated.modelDigest ?? modelDigest;
            } else {
              invalidateSectionsForFinalRepair(
                db, row, token, request, sections, warnings,
              );
            }
            continue;
          }
          invalidateSectionsForFinalRepair(
            db,
            row,
            token,
            request,
            sections,
            warnings,
            repairOutline,
          );
          if (repairOutline) invalidateOutlineForFinalRepair(db, row, token, outline, warnings);
          throw new ContentScriptFinalValidationError(warnings);
        }
      }
      try {
        publicResult = buildScriptSuccessResponse({
          result,
          language: request.language,
          sourceMetadataIsRequestEcho: true,
          format: request.format,
          renderMode: request.renderMode,
          scriptStyle: request.scriptStyle,
          requestedMode: request.mode,
          generationMode: request.mode,
          startMs: now.getTime(),
          cacheHit: result.cache_status === 'hit',
        });
      } catch (error) {
        const languageMismatch = error instanceof ContentOutputLanguageMismatchError;
        const validationWarning = languageMismatch
          ? 'content_script_output_language_mismatch'
          : 'final_public_response_validation_exception';
        if (languageMismatch
            && finalRepairPass < MAX_FINAL_REPAIR_PASSES
            && claimFinalRepairPass(db, row, token)) {
          finalRepairPass += 1;
          const regenerated = await regenerateEntireDraftForFinalRepair(
            db,
            row,
            token,
            request,
            outline,
            sections,
            [validationWarning],
            controller.signal,
            validationWarning,
          );
          outline = regenerated.outline;
          modelDigest = regenerated.modelDigest ?? modelDigest;
          continue;
        }
        invalidateSectionsForFinalRepair(
          db,
          row,
          token,
          request,
          sections,
          [validationWarning],
          languageMismatch,
          validationWarning,
        );
        if (languageMismatch) {
          invalidateOutlineForFinalRepair(db, row, token, outline, [validationWarning]);
        }
        throw error;
      }
      if (publicResult.scriptSafety.blocked) {
        const safetyWarnings = ['content_script_output_safety_blocked'];
        if (finalRepairPass < MAX_FINAL_REPAIR_PASSES
            && claimFinalRepairPass(db, row, token)) {
          finalRepairPass += 1;
          const regenerated = await regenerateEntireDraftForFinalRepair(
            db,
            row,
            token,
            request,
            outline,
            sections,
            safetyWarnings,
            controller.signal,
            'content_script_output_safety_blocked',
          );
          outline = regenerated.outline;
          modelDigest = regenerated.modelDigest ?? modelDigest;
          continue;
        }
        invalidateSectionsForFinalRepair(
          db,
          row,
          token,
          request,
          sections,
          safetyWarnings,
          true,
          'content_script_output_safety_blocked',
        );
        invalidateOutlineForFinalRepair(
          db,
          row,
          token,
          outline,
          safetyWarnings,
        );
        throw new ContentScriptJobError(
          'CONTENT_SCRIPT_OUTPUT_BLOCKED',
          'The generated script failed the output safety gate.',
          422,
        );
      }
      break;
    }
    updateProgress(db, jobId, token, 'final_validation', 95);
    const completedAt = new Date().toISOString();
    const completed = db.prepare(`UPDATE content_script_jobs
      SET status = 'completed', stage = 'completed', progress_percent = 100,
          warning_codes_json = ?, result_json = ?, route = ?, model_digest = ?,
          lease_token = NULL, lease_expires_at = NULL,
          infrastructure_requeue_count = 0, next_attempt_at = NULL,
          completed_at = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running' AND lease_token = ?
        AND cancellation_requested_at IS NULL AND lease_expires_at > ?`)
      .run(
        JSON.stringify(warnings),
        encryptContentScriptJobJson(publicResult, row.owner_user_id),
        'local',
        modelDigest,
        completedAt,
        completedAt,
        jobId,
        token,
        completedAt,
      );
    if (completed.changes !== 1) {
      const current = db.prepare(`SELECT status, cancellation_requested_at FROM content_script_jobs
        WHERE job_id = ?`).get(jobId) as {
          status: ContentScriptJobStatus;
          cancellation_requested_at: string | null;
        } | undefined;
      if (current?.status === 'completed') {
        return mapJob(db.prepare('SELECT * FROM content_script_jobs WHERE job_id = ?').get(jobId) as JobRow);
      }
      if (current?.status === 'cancelled' || current?.cancellation_requested_at) {
        throw Object.assign(new Error('script_job_cancelled'), { code: 'SCRIPT_JOB_CANCELLED' });
      }
      recoverableAbortCodes.set(token, 'CONTENT_SCRIPT_JOB_LEASE_LOST');
      throw new ContentScriptJobError(
        'CONTENT_SCRIPT_JOB_LEASE_LOST',
        'Script job lease expired before the completion checkpoint could commit.',
        409,
      );
    }
    return mapJob(db.prepare('SELECT * FROM content_script_jobs WHERE job_id = ?').get(jobId) as JobRow);
  } catch (error) {
    const failureReason = localInferenceFailureReason(error);
    const code = failureReason
      ? failureReason.slice(0, 160)
      : error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? String((error as { code: string }).code).slice(0, 160)
      : error instanceof Error ? error.name.slice(0, 160) : 'CONTENT_SCRIPT_JOB_FAILED';
    const timestamp = new Date().toISOString();
    if (failureReason !== 'ACCOUNT_DELETION_IN_PROGRESS'
        && isLocalFairUseExemptFailureReason(failureReason)) {
      const requeued = requeueInfrastructureFailure(db, jobId, token, code);
      if (requeued) return requeued.job;
      throw error;
    }
    const recoverableAbortCode = recoverableAbortCodes.get(token);
    const current = db.prepare(`SELECT status, cancellation_requested_at FROM content_script_jobs
      WHERE job_id = ?`).get(jobId) as {
        status: string;
        cancellation_requested_at: string | null;
    } | undefined;
    if (recoverableAbortCode && current?.status === 'running' && !current.cancellation_requested_at) {
      const requeued = requeueInfrastructureFailure(
        db,
        jobId,
        token,
        recoverableAbortCode,
      );
      if (requeued) return requeued.job;
      throw error;
    }
    const explicitlyCancelled = current?.status === 'cancelled' || Boolean(current?.cancellation_requested_at);
    const status = explicitlyCancelled || code === 'SCRIPT_JOB_CANCELLED' ? 'cancelled' : 'failed';
    settleInFlightCheckpoint(db, jobId, token, status === 'cancelled' ? 'cancelled' : 'invalid');
    const warningCodes = error instanceof ContentScriptFinalValidationError
      ? error.warningCodes
      : [];
    db.prepare(`UPDATE content_script_jobs
      SET status = ?, stage = ?, last_error_code = ?, lease_token = NULL,
          lease_expires_at = NULL,
          warning_codes_json = ?,
          cancellation_requested_at = CASE WHEN ? = 'cancelled' THEN COALESCE(cancellation_requested_at, ?) ELSE cancellation_requested_at END,
          updated_at = ?
      WHERE job_id = ? AND status = 'running' AND lease_token = ?`)
      .run(status, status, code, JSON.stringify(warningCodes), status, timestamp, timestamp, jobId, token);
    logger.warn({ jobId, code, status }, 'Content script job stopped');
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (controllers.get(jobId)?.leaseToken === token) controllers.delete(jobId);
    recoverableAbortCodes.delete(token);
    // The scheduler becomes idle after each stage while this durable worker
    // still owns its controller, so that callback correctly refuses to start a
    // second job. Trigger once more after releasing the worker. A stopped loop
    // (shutdown) deliberately suppresses this handoff.
    if (recoveryTimer) {
      setImmediate(() => {
        try {
          recoverContentScriptJobs(db);
        } catch (recoveryError) {
          logger.warn({
            jobId,
            errorName: recoveryError instanceof Error ? recoveryError.name : typeof recoveryError,
          }, 'Content script post-worker recovery failed');
        }
      });
    }
  }
}

export function cancelContentScriptJob(input: {
  tenantId: number; userId: number; jobId: string;
}, db: Database.Database = getDb()): ContentScriptJobView {
  requireScope(input.tenantId, input.userId);
  const timestamp = new Date().toISOString();
  const changed = db.transaction((): number => {
    const row = readRow(db, input.tenantId, input.userId, input.jobId);
    if (!row) throw new ContentScriptJobError('CONTENT_SCRIPT_JOB_NOT_FOUND', 'Script job not found.', 404);
    if (!['queued', 'running', 'waiting_capacity'].includes(row.status)) return 0;
    if (row.status === 'running' && row.lease_token) {
      db.prepare(`UPDATE content_script_job_checkpoints
        SET state = 'cancelled', updated_at = ?
        WHERE job_id = ? AND state = 'generating'
          AND EXISTS (
            SELECT 1 FROM content_script_jobs
            WHERE job_id = ? AND status = 'running' AND lease_token = ?
          )`).run(timestamp, input.jobId, input.jobId, row.lease_token);
    }
    return db.prepare(`UPDATE content_script_jobs
      SET status = 'cancelled', stage = 'cancelled',
          cancellation_requested_at = COALESCE(cancellation_requested_at, ?),
          lease_token = NULL, lease_expires_at = NULL,
          next_attempt_at = NULL, updated_at = ?
      WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ?
        AND status = ? AND (lease_token IS ? OR lease_token = ?)`)
      .run(
        timestamp,
        timestamp,
        input.jobId,
        input.tenantId,
        input.userId,
        row.status,
        row.lease_token,
        row.lease_token,
      ).changes;
  }).immediate();
  if (changed > 0) {
    controllers.get(input.jobId)?.controller.abort(Object.assign(new Error('script_job_cancelled'), {
      name: 'AbortError',
      code: 'SCRIPT_JOB_CANCELLED',
    }));
  }
  return mapJob(readRow(db, input.tenantId, input.userId, input.jobId)!);
}

export function retryContentScriptJob(input: {
  tenantId: number; userId: number; jobId: string;
}, db: Database.Database = getDb()): ContentScriptJobView {
  requireScope(input.tenantId, input.userId);
  if (isSkillInferenceAccountDeletionFenced(input.userId, db)) {
    throw new ContentScriptJobError(
      'ACCOUNT_DELETION_IN_PROGRESS',
      'No Content job can be retried while this account is being deleted.',
      409,
    );
  }
  const existing = readRow(db, input.tenantId, input.userId, input.jobId);
  if (!existing) throw new ContentScriptJobError('CONTENT_SCRIPT_JOB_NOT_FOUND', 'Script job not found.', 404);
  if (existing.status === 'queued' || existing.status === 'running' || existing.status === 'waiting_capacity') {
    // Retry is idempotent for an already-active operation even if new local
    // admission has since been disabled.
    return mapJob(existing);
  }
  assertJobsEnabled();
  assertRuntimeAdmitsJob(db, input.userId);
  const retried = db.transaction((): { row: JobRow; changed: boolean } => {
    const row = readRow(db, input.tenantId, input.userId, input.jobId);
    if (!row) throw new ContentScriptJobError('CONTENT_SCRIPT_JOB_NOT_FOUND', 'Script job not found.', 404);
    if (row.status === 'queued' || row.status === 'running' || row.status === 'waiting_capacity') {
      return { row, changed: false };
    }
    if (row.status !== 'failed' && row.status !== 'cancelled') {
      throw new ContentScriptJobError('CONTENT_SCRIPT_JOB_NOT_RETRYABLE', 'Only failed or cancelled jobs can be retried.', 409);
    }
    if (row.attempt_count >= MAX_CONTENT_SCRIPT_GENERATION_ATTEMPTS) {
      throw new ContentScriptJobError(
        'CONTENT_SCRIPT_JOB_RETRY_LIMIT',
        'This script job exhausted its bounded generation attempts.',
        409,
      );
    }

    // A retry keeps the same durable operation and active-slot semantics, but a
    // job created outside the rolling day cannot bypass today's long-form
    // allowance. Moving this operation's admission timestamp makes it count
    // once in the current window without charging internal stage retries.
    const limits = planLimits(db, input.userId);
    const active = (db.prepare(`SELECT COUNT(*) AS count FROM content_script_jobs
      WHERE tenant_id = ? AND owner_user_id = ? AND job_id <> ?
        AND status IN ('queued', 'running', 'waiting_capacity')`)
      .get(input.tenantId, input.userId, input.jobId) as { count: number }).count;
    if (active >= limits.active) {
      throw new ContentScriptJobError('CONTENT_SCRIPT_ACTIVE_LIMIT', 'Active script-job limit reached.', 429);
    }
    if (isLongFormScriptDuration(row.target_duration_seconds)) {
      const daily = (db.prepare(`SELECT COUNT(*) AS count FROM content_script_jobs
        WHERE tenant_id = ? AND owner_user_id = ? AND job_id <> ?
          AND target_duration_seconds > ?
          AND fair_use_admitted_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`)
        .get(
          input.tenantId,
          input.userId,
          input.jobId,
          LONG_FORM_SCRIPT_THRESHOLD_SECONDS,
        ) as { count: number }).count;
      if (daily >= limits.daily) {
        throw new ContentScriptJobError('CONTENT_SCRIPT_DAILY_LIMIT', 'Daily long-form script-job limit reached.', 429);
      }
    }

    const durableProgress = checkpointDerivedProgress(db, input.jobId);
    const timestamp = new Date().toISOString();
    const changed = db.prepare(`UPDATE content_script_jobs
      SET status = 'queued', stage = 'queued', progress_percent = MAX(progress_percent, ?),
          cancellation_requested_at = NULL, last_error_code = NULL,
          warning_codes_json = '[]', completed_at = NULL,
          infrastructure_requeue_count = 0, final_repair_count = 0,
          next_attempt_at = NULL,
          fair_use_admitted_at = ?, updated_at = ?
      WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ?
        AND status IN ('failed', 'cancelled')`)
      .run(durableProgress, timestamp, timestamp, input.jobId, input.tenantId, input.userId);
    if (changed.changes !== 1) {
      throw new ContentScriptJobError('CONTENT_SCRIPT_JOB_RETRY_RACE', 'The script job changed while retrying.', 409);
    }
    return { row: readRow(db, input.tenantId, input.userId, input.jobId)!, changed: true };
  }).immediate();
  if (!retried.changed) return mapJob(retried.row);
  requestContentScriptJobRecovery(db);
  return mapJob(retried.row);
}

export function recoverContentScriptJobs(
  db: Database.Database = getDb(),
  options: { schedule?: (jobId: string) => void } = {},
): number {
  if (contentScriptJobShutdownStarted) return 0;
  if (!localPrimaryInferenceConfig.scriptJobsEnabled || !localPrimaryInferenceConfig.contentProxyEnabled) return 0;
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const staleHeartbeatCutoff = new Date(nowDate.getTime() - STALE_HEARTBEAT_MS).toISOString();
  const expired = db.prepare(`SELECT job_id, lease_token,
      CASE WHEN lease_expires_at <= ?
        THEN 'recovered_expired_lease'
        ELSE 'recovered_stale_heartbeat' END AS recovery_code
    FROM content_script_jobs
    WHERE status = 'running'
      AND (lease_expires_at <= ? OR updated_at <= ?)`)
    .all(now, now, staleHeartbeatCutoff) as Array<{
      job_id: string;
      lease_token: string;
      recovery_code: string;
    }>;
  let recovered = 0;
  const recoveredActiveLeases: Array<{ token: string; controller: AbortController }> = [];
  for (const row of expired) {
    const result = requeueInfrastructureFailure(
      db,
      row.job_id,
      row.lease_token,
      row.recovery_code,
      { leaseExpiredBefore: now, heartbeatStaleBefore: staleHeartbeatCutoff },
    );
    if (!result) continue;
    recovered += 1;
    const activeLease = controllers.get(row.job_id);
    if (activeLease?.leaseToken === row.lease_token) {
      recoveredActiveLeases.push({ token: activeLease.leaseToken, controller: activeLease.controller });
    }
  }
  for (const activeLease of recoveredActiveLeases) {
    recoverableAbortCodes.set(activeLease.token, 'CONTENT_SCRIPT_JOB_LEASE_LOST');
    activeLease.controller.abort(createContentScriptInfrastructureAbort('CONTENT_SCRIPT_JOB_LEASE_LOST'));
  }
  const control = getLocalInferenceRuntimeControl(db);
  if (control.mode !== 'active' && control.mode !== 'canary') return recovered;
  if (controllers.size > 0) return recovered;
  const capacity = localInferenceScheduler.snapshot();
  if (capacity.activeCount > 0 || capacity.queuedCount > 0) return recovered;
  const rows = db.prepare(`SELECT j.job_id, j.owner_user_id, j.plan_id,
      p.local_queue_weight AS persisted_queue_weight
    FROM content_script_jobs j
    LEFT JOIN plan_configs p ON p.plan_id = j.plan_id AND p.active = 1
    WHERE j.status IN ('queued', 'waiting_capacity')
      AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?)
    ORDER BY j.updated_at ASC, j.created_at ASC`)
    .iterate(now) as IterableIterator<{
      job_id: string;
      owner_user_id: number;
      plan_id: string;
      persisted_queue_weight: number | null;
    }>;
  const eligibleRows: Array<{ job_id: string; owner_user_id: number; queue_weight: number }> = [];
  for (const row of rows) {
    if (control.mode === 'active'
        || isLocalInferenceUserEnrolled(row.owner_user_id, control.rolloutPercent)) {
      eligibleRows.push({
        job_id: row.job_id,
        owner_user_id: row.owner_user_id,
        queue_weight: effectiveQueueWeight(row.plan_id, row.persisted_queue_weight),
      });
    }
  }
  const highPriority = eligibleRows.filter((row) => row.queue_weight >= 2);
  const normalPriority = eligibleRows.filter((row) => row.queue_weight < 2);
  let next: (typeof eligibleRows)[number] | undefined;
  if (highPriority.length === 0) {
    next = normalPriority[0];
  } else if (normalPriority.length === 0) {
    next = highPriority[0];
  } else {
    // Derive the burst from durable started jobs so restarts cannot reset Max
    // priority into starvation. Two consecutive weight>=2 jobs are followed
    // by one normal-weight job whenever both classes are waiting.
    const recentWeights = (db.prepare(`SELECT j.plan_id,
        p.local_queue_weight AS persisted_queue_weight
      FROM content_script_jobs j
      LEFT JOIN plan_configs p ON p.plan_id = j.plan_id AND p.active = 1
      WHERE j.started_at IS NOT NULL
      ORDER BY j.started_at DESC, j.created_at DESC
      LIMIT 2`).all() as Array<{ plan_id: string; persisted_queue_weight: number | null }>)
      .map((row) => ({
        queue_weight: effectiveQueueWeight(row.plan_id, row.persisted_queue_weight),
      }));
    const firstNormal = recentWeights.findIndex((row) => row.queue_weight < 2);
    const consecutiveHigh = firstNormal === -1 ? recentWeights.length : firstNormal;
    next = consecutiveHigh >= 2 ? normalPriority[0] : highPriority[0];
  }
  if (next) {
    const nextJobId = next.job_id;
    const schedule = options.schedule
      ?? ((scheduledJobId: string) => {
        setImmediate(() => { void runContentScriptJob(scheduledJobId, db).catch(() => undefined); });
      });
    schedule(nextJobId);
  }
  return recovered;
}

export function startContentScriptJobRecoveryLoop(
  db?: Database.Database,
  options: { schedule?: (jobId: string) => void } = {},
): void {
  if (recoveryTimer || !localPrimaryInferenceConfig.scriptJobsEnabled) return;
  // An enabled worker is a production promise: fail startup before touching
  // queued encrypted jobs when its local-only routing or key material is
  // incomplete. Request-time validation alone is too late for recovery work.
  assertJobsEnabled();
  const runtimeDb = db ?? getDb();
  recoverContentScriptJobs(runtimeDb, options);
  stopSchedulerIdleListener = localInferenceScheduler.onIdle(() => {
    try {
      recoverContentScriptJobs(runtimeDb, options);
    } catch (error) {
      logger.warn({
        errorName: error instanceof Error ? error.name : typeof error,
      }, 'Content script job idle-capacity recovery failed');
    }
  });
  recoveryTimer = setInterval(() => {
    try {
      recoverContentScriptJobs(runtimeDb, options);
    } catch (error) {
      logger.warn({ errorName: error instanceof Error ? error.name : typeof error }, 'Content script job recovery failed');
    }
  }, 60_000);
  recoveryTimer.unref?.();
}

/** Fence new and already-scheduled worker admission before shutdown storage work begins. */
export function beginContentScriptJobShutdown(): void {
  contentScriptJobShutdownStarted = true;
}

/** Test isolation only; a production process never resumes after shutdown begins. */
export function resetContentScriptJobShutdownForTests(): void {
  contentScriptJobShutdownStarted = false;
}

/** Requeue this process's active leases before the database is closed. */
export function stopContentScriptJobRecoveryLoop(db: Database.Database = getDb()): number {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
  stopSchedulerIdleListener?.();
  stopSchedulerIdleListener = null;
  const activeLeases = [...controllers.entries()];
  if (activeLeases.length === 0) return 0;
  let requeued = 0;
  try {
    for (const [jobId, activeLease] of activeLeases) {
      recoverableAbortCodes.set(activeLease.leaseToken, 'CONTENT_SCRIPT_SHUTDOWN_REQUEUE');
      try {
        const result = requeueInfrastructureFailure(
          db,
          jobId,
          activeLease.leaseToken,
          'CONTENT_SCRIPT_SHUTDOWN_REQUEUE',
        );
        if (result) requeued += 1;
      } catch (error) {
        logger.error({
          jobId,
          errorName: error instanceof Error ? error.name : typeof error,
        }, 'Unable to durably settle an active Content script job during shutdown');
      }
    }
  } finally {
    // Provider work must still be interrupted if the database is already
    // unavailable. Lease fencing or process exit prevents a late commit.
    for (const [, activeLease] of activeLeases) {
      recoverableAbortCodes.set(activeLease.leaseToken, 'CONTENT_SCRIPT_SHUTDOWN_REQUEUE');
      activeLease.controller.abort(createContentScriptInfrastructureAbort('CONTENT_SCRIPT_SHUTDOWN_REQUEUE'));
    }
  }
  return requeued;
}

/** Give aborted workers a bounded window to observe fencing before DB close. */
export async function waitForContentScriptJobWorkersToStop(timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (controllers.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return controllers.size;
}
