// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M18 — durable continuation for a checkpointed legacy tool-loop timeout.
 *
 * We never attempt to resume an open provider tool_use conversation in a
 * different process. The foreground promise may finish after the HTTP timeout;
 * when it does, its result is attached to this durable job and the worker uses
 * it without another model call. The job is deliberately not runnable while
 * that promise is outstanding. A definitive rejection (or the durable
 * deadline) produces an honest partial-failure notification: it never starts a
 * second model/provider turn and therefore never repeats checkpointed work.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DomainName } from '../domains/types';
import { enqueueJob, type JobHandler, type JobRecord } from './background-job-queue';
import { getDb } from './database';
import { sendPushNotification, type SendResult } from './apns-sender';
import { rememberChatActiveDomain } from '../api/routes/chat-message-context';
import type { ChatDomainExecutionResult } from '../api/routes/chat-message-execution';
import { createChatLatencyTracker } from './chat-answer-contract';
import { finalizeChatAnswerMetadata } from '../api/routes/chat-message-finalizer';
import { storeChatMessage } from './chat-history-store';
import { logger } from '../utils/logger';
import { normalizeSupportedLang } from '../utils/i18n';
import { detectResponseLanguage } from './chat-language-detector';

export const CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE = 'chat_legacy_timeout_continuation';
const CONTINUATION_SCHEMA_VERSION = 2;
const CONTINUATION_TTL_MS = 15 * 60 * 1000;

type ChatLegacyTimeoutTerminalSource =
  | 'late_foreground_result'
  | 'foreground_failed'
  | 'foreground_abandoned';

type ChatLegacyTimeoutApnsState =
  | 'sending'
  | 'retryable'
  | 'delivered'
  | 'terminal_no_delivery'
  | 'indeterminate';

export type ChatLegacyTimeoutApnsOutcome =
  | 'sent'
  | 'partial_sent_no_retry'
  | 'no_targets'
  | 'skipped'
  | 'permanent_failure'
  | 'indeterminate_send_exception'
  | 'indeterminate_stale_attempt';

export interface ChatLegacyTimeoutContinuationRef {
  jobId: string;
  notificationPolicy: 'apns';
}

interface ChatLegacyTimeoutContinuationPayload {
  schemaVersion: number;
  sourceRunId: string;
  sourceMessageId: string;
  sourceText: string;
  domain: DomainName;
  locale: string | null;
  completedTools: string[];
  foregroundState: 'running' | 'succeeded' | 'failed';
  recoveryPolicy: 'late_result_or_fail_honestly';
  notificationPolicy: 'apns';
  destructiveResumePolicy: 'reconfirm';
  expiresAt: string;
  lateResult?: {
    text: string;
    domain: DomainName;
    capturedAt: string;
  };
  foregroundFailure?: {
    code: 'foreground_rejected';
    capturedAt: string;
  };
  delivery?: {
    terminalSource?: ChatLegacyTimeoutTerminalSource;
    terminalClaimedAt?: string;
    ownerToken?: string;
    ownerLeaseKey?: string;
    messageStoredAt?: string;
    apnsState?: ChatLegacyTimeoutApnsState;
    apnsAttemptToken?: string;
    apnsAttemptedAt?: string;
    apnsDeliveredAt?: string;
    apnsTerminalAt?: string;
    apnsOutcome?: ChatLegacyTimeoutApnsOutcome;
  };
}

export interface EnqueueChatLegacyTimeoutContinuationInput {
  tenantId: number;
  userId: number;
  sourceRunId: string;
  sourceMessageId: string;
  sourceText: string;
  domain: DomainName;
  locale?: string | null;
  completedTools: string[];
  now?: Date;
}

function sqliteDateTime(value: Date): string {
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

function cleanCompletedTools(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean))]
    .slice(0, 100);
}

export function enqueueChatLegacyTimeoutContinuation(
  input: EnqueueChatLegacyTimeoutContinuationInput,
): ChatLegacyTimeoutContinuationRef {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + CONTINUATION_TTL_MS).toISOString();
  const payload: ChatLegacyTimeoutContinuationPayload = {
    schemaVersion: CONTINUATION_SCHEMA_VERSION,
    sourceRunId: input.sourceRunId,
    sourceMessageId: input.sourceMessageId,
    sourceText: input.sourceText,
    domain: input.domain,
    locale: input.locale ?? null,
    completedTools: cleanCompletedTools(input.completedTools),
    foregroundState: 'running',
    recoveryPolicy: 'late_result_or_fail_honestly',
    notificationPolicy: 'apns',
    destructiveResumePolicy: 'reconfirm',
    expiresAt,
  };
  const job = enqueueJob({
    tenantId: input.tenantId,
    userId: input.userId,
    jobType: CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
    payload: payload as unknown as Record<string, unknown>,
    priority: 35,
    maxAttempts: 2,
    // A late success/failure attachment moves this forward to `now`. Until
    // then it cannot be claimed, so an outstanding detached provider promise
    // can never race a second provider turn.
    notBefore: sqliteDateTime(new Date(now.getTime() + CONTINUATION_TTL_MS)),
    idempotencyKey: `${CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE}:${input.sourceRunId}`,
    correlationId: input.sourceRunId,
  });
  return { jobId: job.jobId, notificationPolicy: 'apns' };
}

function parsePayload(value: unknown): ChatLegacyTimeoutContinuationPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (payload.schemaVersion !== CONTINUATION_SCHEMA_VERSION
      || typeof payload.sourceRunId !== 'string'
      || typeof payload.sourceMessageId !== 'string'
      || typeof payload.sourceText !== 'string'
      || typeof payload.domain !== 'string'
      || typeof payload.expiresAt !== 'string'
      || !['running', 'succeeded', 'failed'].includes(String(payload.foregroundState))
      || payload.recoveryPolicy !== 'late_result_or_fail_honestly'
      || payload.destructiveResumePolicy !== 'reconfirm') {
    return null;
  }
  const late = payload.lateResult && typeof payload.lateResult === 'object' && !Array.isArray(payload.lateResult)
    ? payload.lateResult as Record<string, unknown>
    : null;
  const failure = payload.foregroundFailure && typeof payload.foregroundFailure === 'object' && !Array.isArray(payload.foregroundFailure)
    ? payload.foregroundFailure as Record<string, unknown>
    : null;
  const rawDelivery = payload.delivery && typeof payload.delivery === 'object' && !Array.isArray(payload.delivery)
    ? payload.delivery as Record<string, unknown>
    : null;
  const terminalSource = rawDelivery && [
    'late_foreground_result',
    'foreground_failed',
    'foreground_abandoned',
  ].includes(String(rawDelivery.terminalSource))
    ? rawDelivery.terminalSource as ChatLegacyTimeoutTerminalSource
    : undefined;
  const apnsState = rawDelivery && [
    'sending',
    'retryable',
    'delivered',
    'terminal_no_delivery',
    'indeterminate',
  ].includes(String(rawDelivery.apnsState))
    ? rawDelivery.apnsState as ChatLegacyTimeoutApnsState
    : undefined;
  const apnsOutcome = rawDelivery && [
    'sent',
    'partial_sent_no_retry',
    'no_targets',
    'skipped',
    'permanent_failure',
    'indeterminate_send_exception',
    'indeterminate_stale_attempt',
  ].includes(String(rawDelivery.apnsOutcome))
    ? rawDelivery.apnsOutcome as ChatLegacyTimeoutApnsOutcome
    : undefined;
  return {
    schemaVersion: CONTINUATION_SCHEMA_VERSION,
    sourceRunId: payload.sourceRunId,
    sourceMessageId: payload.sourceMessageId,
    sourceText: payload.sourceText,
    domain: payload.domain as DomainName,
    locale: typeof payload.locale === 'string' ? payload.locale : null,
    completedTools: Array.isArray(payload.completedTools)
      ? cleanCompletedTools(payload.completedTools.filter((value): value is string => typeof value === 'string'))
      : [],
    foregroundState: payload.foregroundState as ChatLegacyTimeoutContinuationPayload['foregroundState'],
    recoveryPolicy: 'late_result_or_fail_honestly',
    notificationPolicy: 'apns',
    destructiveResumePolicy: 'reconfirm',
    expiresAt: payload.expiresAt,
    ...(late && typeof late.text === 'string' && typeof late.domain === 'string' && typeof late.capturedAt === 'string'
      ? {
        lateResult: {
          text: late.text,
          domain: late.domain as DomainName,
          capturedAt: late.capturedAt,
        },
      }
      : {}),
    ...(failure?.code === 'foreground_rejected' && typeof failure.capturedAt === 'string'
      ? {
        foregroundFailure: {
          code: 'foreground_rejected' as const,
          capturedAt: failure.capturedAt,
        },
      }
      : {}),
    ...(rawDelivery
      ? {
        delivery: {
          ...(terminalSource ? { terminalSource } : {}),
          ...(typeof rawDelivery.terminalClaimedAt === 'string' ? { terminalClaimedAt: rawDelivery.terminalClaimedAt } : {}),
          ...(typeof rawDelivery.ownerToken === 'string' ? { ownerToken: rawDelivery.ownerToken } : {}),
          ...(typeof rawDelivery.ownerLeaseKey === 'string' ? { ownerLeaseKey: rawDelivery.ownerLeaseKey } : {}),
          ...(typeof rawDelivery.messageStoredAt === 'string' ? { messageStoredAt: rawDelivery.messageStoredAt } : {}),
          ...(apnsState ? { apnsState } : {}),
          ...(typeof rawDelivery.apnsAttemptToken === 'string' ? { apnsAttemptToken: rawDelivery.apnsAttemptToken } : {}),
          ...(typeof rawDelivery.apnsAttemptedAt === 'string' ? { apnsAttemptedAt: rawDelivery.apnsAttemptedAt } : {}),
          ...(typeof rawDelivery.apnsDeliveredAt === 'string' ? { apnsDeliveredAt: rawDelivery.apnsDeliveredAt } : {}),
          ...(typeof rawDelivery.apnsTerminalAt === 'string' ? { apnsTerminalAt: rawDelivery.apnsTerminalAt } : {}),
          ...(apnsOutcome ? { apnsOutcome } : {}),
        },
      }
      : {}),
  };
}

/**
 * Attach a result produced by the original foreground promise after its HTTP
 * timeout. The update is scoped by job, tenant, user, type, and source run; a
 * late result can never cross tenants or replace a terminal/cancelled job.
 * `processing` is included intentionally: a success that wins the SQLite
 * transaction race at the deadline must still be consumed by that lease.
 */
export function attachLateChatLegacyTimeoutResult(input: {
  jobId: string;
  tenantId: number;
  userId: number;
  sourceRunId: string;
  result: ChatDomainExecutionResult;
  now?: Date;
}): boolean {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT payload_json
      FROM background_jobs
      WHERE job_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND job_type = ?
        AND correlation_id = ?
        AND status IN ('pending', 'failed', 'processing')
      LIMIT 1
    `).get(
      input.jobId,
      input.tenantId,
      input.userId,
      CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      input.sourceRunId,
    ) as { payload_json?: string } | undefined;
    if (!row?.payload_json) return false;
    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      raw = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    const payload = parsePayload(raw);
    if (!payload
        || payload.sourceRunId !== input.sourceRunId
        || payload.foregroundState !== 'running'
        || payload.delivery?.terminalSource) return false;
    raw.foregroundState = 'succeeded';
    raw.lateResult = {
      text: input.result.text,
      domain: input.result.domain,
      capturedAt: (input.now ?? new Date()).toISOString(),
    };
    const updated = db.prepare(`
      UPDATE background_jobs
      SET payload_json = ?, not_before = ?
      WHERE job_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND job_type = ?
        AND correlation_id = ?
        AND status IN ('pending', 'failed', 'processing')
    `).run(
      JSON.stringify(raw),
      sqliteDateTime(input.now ?? new Date()),
      input.jobId,
      input.tenantId,
      input.userId,
      CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      input.sourceRunId,
    );
    return Number(updated.changes ?? 0) === 1;
  })();
}

/**
 * Persist a definitive rejection from the original detached promise. Error
 * text is intentionally not retained: provider responses can contain secrets
 * or user data, and the worker only needs the terminal state to fail honestly.
 */
export function markChatLegacyTimeoutForegroundFailure(input: {
  jobId: string;
  tenantId: number;
  userId: number;
  sourceRunId: string;
  error?: unknown;
  now?: Date;
}): boolean {
  void input.error;
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT payload_json
      FROM background_jobs
      WHERE job_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND job_type = ?
        AND correlation_id = ?
        AND status IN ('pending', 'failed', 'processing')
      LIMIT 1
    `).get(
      input.jobId,
      input.tenantId,
      input.userId,
      CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      input.sourceRunId,
    ) as { payload_json?: string } | undefined;
    if (!row?.payload_json) return false;
    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      raw = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    const payload = parsePayload(raw);
    if (!payload
        || payload.sourceRunId !== input.sourceRunId
        || payload.foregroundState !== 'running'
        || payload.delivery?.terminalSource) return false;
    const now = input.now ?? new Date();
    raw.foregroundState = 'failed';
    raw.foregroundFailure = {
      code: 'foreground_rejected',
      capturedAt: now.toISOString(),
    };
    const updated = db.prepare(`
      UPDATE background_jobs
      SET payload_json = ?, not_before = ?
      WHERE job_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND job_type = ?
        AND correlation_id = ?
        AND status IN ('pending', 'failed', 'processing')
    `).run(
      JSON.stringify(raw),
      sqliteDateTime(now),
      input.jobId,
      input.tenantId,
      input.userId,
      CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      input.sourceRunId,
    );
    return Number(updated.changes ?? 0) === 1;
  })();
}

function continuationMessageId(job: JobRecord, sourceRunId: string): string {
  const digest = createHash('sha256')
    .update(`${job.tenantId}:${job.userId ?? 0}:${sourceRunId}`)
    .digest('hex')
    .slice(0, 32);
  return `msg-timeout-${digest}`;
}

function isApnsTerminalState(state: ChatLegacyTimeoutApnsState | undefined): boolean {
  return state === 'delivered' || state === 'terminal_no_delivery' || state === 'indeterminate';
}

function jobDeliveryLeaseKey(job: JobRecord): string {
  return [
    job.status,
    job.attempts,
    job.lockOwner ?? 'unleased',
    job.lockedAt ?? job.startedAt ?? job.createdAt,
  ].join(':');
}

interface TerminalPayloadClaim {
  payload: ChatLegacyTimeoutContinuationPayload;
  ownerToken: string | null;
}

function claimTerminalPayload(job: JobRecord, now: Date, requestedOwnerToken: string): TerminalPayloadClaim {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT payload_json, status, attempts, locked_at, lock_owner, started_at, created_at
      FROM background_jobs
      WHERE job_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND job_type = ?
        AND correlation_id = ?
        AND status IN ('pending', 'failed', 'processing')
      LIMIT 1
    `).get(
      job.jobId,
      job.tenantId,
      job.userId,
      CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      job.correlationId,
    ) as {
      payload_json?: string;
      status: JobRecord['status'];
      attempts: number;
      locked_at: string | null;
      lock_owner: string | null;
      started_at: string | null;
      created_at: string;
    } | undefined;
    if (!row?.payload_json) throw new Error('chat_legacy_timeout_continuation_scope_invalid');
    if (row.status !== job.status
        || Number(row.attempts) !== job.attempts
        || row.locked_at !== job.lockedAt
        || row.lock_owner !== job.lockOwner) {
      throw new Error('chat_legacy_timeout_continuation_delivery_fence_lost');
    }
    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('chat_legacy_timeout_continuation_payload_invalid');
      }
      raw = parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof Error && err.message === 'chat_legacy_timeout_continuation_payload_invalid') throw err;
      throw new Error('chat_legacy_timeout_continuation_payload_invalid');
    }
    const payload = parsePayload(raw);
    if (!payload || payload.sourceRunId !== job.correlationId) {
      throw new Error('chat_legacy_timeout_continuation_payload_invalid');
    }
    let terminalSource = payload.delivery?.terminalSource;
    if (!terminalSource) {
      const deadline = Date.parse(payload.expiresAt);
      if (!Number.isFinite(deadline)) throw new Error('chat_legacy_timeout_continuation_payload_invalid');
      if (payload.foregroundState === 'succeeded' && payload.lateResult) {
        terminalSource = 'late_foreground_result';
      } else if (payload.foregroundState === 'failed' && payload.foregroundFailure) {
        terminalSource = 'foreground_failed';
      } else if (payload.foregroundState === 'running' && now.getTime() >= deadline) {
        terminalSource = 'foreground_abandoned';
      } else if (payload.foregroundState === 'running') {
        throw new Error('chat_legacy_timeout_continuation_foreground_still_running');
      } else {
        throw new Error('chat_legacy_timeout_continuation_payload_invalid');
      }
    }

    const rawDelivery = raw.delivery && typeof raw.delivery === 'object' && !Array.isArray(raw.delivery)
      ? raw.delivery as Record<string, unknown>
      : {};
    rawDelivery.terminalSource = terminalSource;
    rawDelivery.terminalClaimedAt ??= now.toISOString();
    const deliveryComplete = typeof rawDelivery.messageStoredAt === 'string'
      && isApnsTerminalState(payload.delivery?.apnsState);
    if (deliveryComplete) {
      const completed = parsePayload({ ...raw, delivery: rawDelivery });
      if (!completed) throw new Error('chat_legacy_timeout_continuation_payload_invalid');
      return { payload: completed, ownerToken: null };
    }

    const leaseKey = jobDeliveryLeaseKey(job);
    const existingOwnerToken = typeof rawDelivery.ownerToken === 'string' ? rawDelivery.ownerToken : null;
    const existingLeaseKey = typeof rawDelivery.ownerLeaseKey === 'string' ? rawDelivery.ownerLeaseKey : null;
    if (existingOwnerToken && existingLeaseKey === leaseKey) {
      throw new Error('chat_legacy_timeout_continuation_delivery_already_claimed');
    }
    if (existingOwnerToken
        && existingLeaseKey !== leaseKey
        && rawDelivery.apnsState === 'sending') {
      // The previous lease may have crossed the external APNs boundary. A
      // recovery worker must never send the same notification again because
      // APNs offers no durable exactly-once idempotency key. The message is
      // already durable; record the push as indeterminate and fail closed.
      rawDelivery.apnsState = 'indeterminate';
      rawDelivery.apnsOutcome = 'indeterminate_stale_attempt';
      rawDelivery.apnsTerminalAt = now.toISOString();
    }
    rawDelivery.ownerToken = requestedOwnerToken;
    rawDelivery.ownerLeaseKey = leaseKey;
    raw.delivery = rawDelivery;
    const updated = db.prepare(`
      UPDATE background_jobs
      SET payload_json = ?
      WHERE job_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND job_type = ?
        AND correlation_id = ?
        AND status IN ('pending', 'failed', 'processing')
    `).run(
      JSON.stringify(raw),
      job.jobId,
      job.tenantId,
      job.userId,
      CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      job.correlationId,
    );
    if (Number(updated.changes ?? 0) !== 1) {
      throw new Error('chat_legacy_timeout_continuation_scope_invalid');
    }
    const claimed = parsePayload(raw);
    if (!claimed) throw new Error('chat_legacy_timeout_continuation_payload_invalid');
    return { payload: claimed, ownerToken: requestedOwnerToken };
  })();
}

function persistMessageUnderDeliveryFence(input: {
  job: JobRecord;
  sourceRunId: string;
  ownerToken: string;
  now: Date;
  persist: () => void;
}): boolean {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT payload_json
      FROM background_jobs
      WHERE job_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND job_type = ?
        AND correlation_id = ?
        AND status IN ('pending', 'failed', 'processing')
      LIMIT 1
    `).get(
      input.job.jobId,
      input.job.tenantId,
      input.job.userId,
      CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      input.sourceRunId,
    ) as { payload_json?: string } | undefined;
    if (!row?.payload_json) return false;
    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      raw = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    const payload = parsePayload(raw);
    if (!payload?.delivery?.terminalSource
        || payload.delivery.ownerToken !== input.ownerToken) {
      throw new Error('chat_legacy_timeout_continuation_delivery_fence_lost');
    }
    if (payload.delivery.messageStoredAt) return false;
    // `storeChatMessage` shares this SQLite connection. Keeping the message
    // insert and durable progress marker in one transaction closes the
    // check/insert crash window and makes stale-lease recovery idempotent.
    input.persist();
    const rawDelivery = raw.delivery as Record<string, unknown>;
    rawDelivery.messageStoredAt = input.now.toISOString();
    raw.delivery = rawDelivery;
    const updated = db.prepare(`
      UPDATE background_jobs
      SET payload_json = ?
      WHERE job_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND job_type = ?
        AND correlation_id = ?
        AND status IN ('pending', 'failed', 'processing')
    `).run(
      JSON.stringify(raw),
      input.job.jobId,
      input.job.tenantId,
      input.job.userId,
      CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      input.sourceRunId,
    );
    if (Number(updated.changes ?? 0) !== 1) {
      throw new Error('chat_legacy_timeout_continuation_delivery_fence_lost');
    }
    return true;
  })();
}

type ApnsAttemptClaim =
  | { kind: 'send'; attemptToken: string }
  | { kind: 'terminal'; state: ChatLegacyTimeoutApnsState; outcome: ChatLegacyTimeoutApnsOutcome };

function claimApnsAttempt(input: {
  job: JobRecord;
  sourceRunId: string;
  ownerToken: string | null;
  now: Date;
}): ApnsAttemptClaim {
  const db = getDb();
  return db.transaction((): ApnsAttemptClaim => {
    const row = db.prepare(`
      SELECT payload_json
      FROM background_jobs
      WHERE job_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND job_type = ?
        AND correlation_id = ?
        AND status IN ('pending', 'failed', 'processing')
      LIMIT 1
    `).get(
      input.job.jobId,
      input.job.tenantId,
      input.job.userId,
      CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      input.sourceRunId,
    ) as { payload_json?: string } | undefined;
    if (!row?.payload_json) throw new Error('chat_legacy_timeout_continuation_scope_invalid');
    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('chat_legacy_timeout_continuation_payload_invalid');
      }
      raw = parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof Error && err.message === 'chat_legacy_timeout_continuation_payload_invalid') throw err;
      throw new Error('chat_legacy_timeout_continuation_payload_invalid');
    }
    const payload = parsePayload(raw);
    const state = payload?.delivery?.apnsState;
    if (!payload?.delivery?.terminalSource || !payload.delivery.messageStoredAt) {
      throw new Error('chat_legacy_timeout_continuation_delivery_state_failed');
    }
    if (isApnsTerminalState(state)) {
      return {
        kind: 'terminal',
        state: state as ChatLegacyTimeoutApnsState,
        outcome: payload.delivery.apnsOutcome ?? 'no_targets',
      };
    }
    if (!input.ownerToken || payload.delivery.ownerToken !== input.ownerToken) {
      throw new Error('chat_legacy_timeout_continuation_delivery_fence_lost');
    }
    if (state === 'sending') {
      throw new Error('chat_legacy_timeout_continuation_apns_attempt_in_progress');
    }
    const attemptToken = randomUUID();
    const rawDelivery = raw.delivery as Record<string, unknown>;
    rawDelivery.apnsState = 'sending';
    rawDelivery.apnsAttemptToken = attemptToken;
    rawDelivery.apnsAttemptedAt = input.now.toISOString();
    raw.delivery = rawDelivery;
    const updated = db.prepare(`
      UPDATE background_jobs
      SET payload_json = ?
      WHERE job_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND job_type = ?
        AND correlation_id = ?
        AND status IN ('pending', 'failed', 'processing')
    `).run(
      JSON.stringify(raw),
      input.job.jobId,
      input.job.tenantId,
      input.job.userId,
      CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      input.sourceRunId,
    );
    if (Number(updated.changes ?? 0) !== 1) {
      throw new Error('chat_legacy_timeout_continuation_delivery_fence_lost');
    }
    return { kind: 'send', attemptToken };
  })();
}

function recordApnsAttemptResult(input: {
  job: JobRecord;
  sourceRunId: string;
  ownerToken: string;
  attemptToken: string;
  now: Date;
  result: SendResult;
}): { state: ChatLegacyTimeoutApnsState; outcome?: ChatLegacyTimeoutApnsOutcome } {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT payload_json
      FROM background_jobs
      WHERE job_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND job_type = ?
        AND correlation_id = ?
        AND status IN ('pending', 'failed', 'processing', 'completed')
      LIMIT 1
    `).get(
      input.job.jobId,
      input.job.tenantId,
      input.job.userId,
      CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      input.sourceRunId,
    ) as { payload_json?: string } | undefined;
    if (!row?.payload_json) throw new Error('chat_legacy_timeout_continuation_delivery_fence_lost');
    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('chat_legacy_timeout_continuation_payload_invalid');
      }
      raw = parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof Error && err.message === 'chat_legacy_timeout_continuation_payload_invalid') throw err;
      throw new Error('chat_legacy_timeout_continuation_payload_invalid');
    }
    const payload = parsePayload(raw);
    if (payload?.delivery?.apnsState && isApnsTerminalState(payload.delivery.apnsState)) {
      return {
        state: payload.delivery.apnsState,
        outcome: payload.delivery.apnsOutcome ?? 'no_targets',
      };
    }
    if (!payload?.delivery?.terminalSource
        || payload.delivery.ownerToken !== input.ownerToken
        || payload.delivery.apnsState !== 'sending'
        || payload.delivery.apnsAttemptToken !== input.attemptToken) {
      throw new Error('chat_legacy_timeout_continuation_delivery_fence_lost');
    }
    const rawDelivery = raw.delivery as Record<string, unknown>;
    let state: ChatLegacyTimeoutApnsState;
    let outcome: ChatLegacyTimeoutApnsOutcome | undefined;
    if (input.result.sent > 0) {
      // Per-token APNs fan-out has no batch idempotency key. Once any device
      // accepted the notification, retrying the batch could duplicate that
      // device, so mixed accepted/transient results are terminal partial
      // success and the durable chat message remains the source of truth.
      state = 'delivered';
      outcome = input.result.retriable > 0
        || input.result.failed > 0
        || input.result.skipped > 0
        || input.result.unregistered.length > 0
        ? 'partial_sent_no_retry'
        : 'sent';
      rawDelivery.apnsDeliveredAt = input.now.toISOString();
      rawDelivery.apnsTerminalAt = input.now.toISOString();
    } else if (input.result.retriable > 0) {
      state = 'retryable';
      delete rawDelivery.apnsDeliveredAt;
      delete rawDelivery.apnsTerminalAt;
      delete rawDelivery.apnsOutcome;
    } else {
      state = 'terminal_no_delivery';
      outcome = input.result.skipped > 0
        ? 'skipped'
        : input.result.failed > 0 || input.result.unregistered.length > 0
          ? 'permanent_failure'
          : 'no_targets';
      rawDelivery.apnsTerminalAt = input.now.toISOString();
    }
    rawDelivery.apnsState = state;
    if (outcome) rawDelivery.apnsOutcome = outcome;
    delete rawDelivery.apnsAttemptToken;
    raw.delivery = rawDelivery;
    const updated = db.prepare(`
      UPDATE background_jobs
      SET payload_json = ?
      WHERE job_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND job_type = ?
        AND correlation_id = ?
        AND status IN ('pending', 'failed', 'processing')
    `).run(
      JSON.stringify(raw),
      input.job.jobId,
      input.job.tenantId,
      input.job.userId,
      CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      input.sourceRunId,
    );
    if (Number(updated.changes ?? 0) !== 1) {
      throw new Error('chat_legacy_timeout_continuation_delivery_fence_lost');
    }
    return { state, outcome };
  })();
}

function markApnsAttemptIndeterminate(input: {
  job: JobRecord;
  sourceRunId: string;
  ownerToken: string;
  attemptToken: string;
  now: Date;
}): ChatLegacyTimeoutApnsOutcome {
  const db = getDb();
  return db.transaction((): ChatLegacyTimeoutApnsOutcome => {
    const row = db.prepare(`
      SELECT payload_json
      FROM background_jobs
      WHERE job_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND job_type = ?
        AND correlation_id = ?
        AND status IN ('pending', 'failed', 'processing', 'completed')
      LIMIT 1
    `).get(
      input.job.jobId,
      input.job.tenantId,
      input.job.userId,
      CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      input.sourceRunId,
    ) as { payload_json?: string } | undefined;
    if (!row?.payload_json) throw new Error('chat_legacy_timeout_continuation_delivery_fence_lost');
    const raw = JSON.parse(row.payload_json) as Record<string, unknown>;
    const payload = parsePayload(raw);
    if (payload?.delivery?.apnsState && isApnsTerminalState(payload.delivery.apnsState)) {
      return payload.delivery.apnsOutcome ?? 'no_targets';
    }
    if (!payload?.delivery?.terminalSource
        || payload.delivery.ownerToken !== input.ownerToken
        || payload.delivery.apnsState !== 'sending'
        || payload.delivery.apnsAttemptToken !== input.attemptToken) {
      throw new Error('chat_legacy_timeout_continuation_delivery_fence_lost');
    }
    const rawDelivery = raw.delivery as Record<string, unknown>;
    rawDelivery.apnsState = 'indeterminate';
    rawDelivery.apnsOutcome = 'indeterminate_send_exception';
    rawDelivery.apnsTerminalAt = input.now.toISOString();
    delete rawDelivery.apnsAttemptToken;
    raw.delivery = rawDelivery;
    const updated = db.prepare(`
      UPDATE background_jobs
      SET payload_json = ?
      WHERE job_id = ?
        AND tenant_id = ?
        AND user_id = ?
        AND job_type = ?
        AND correlation_id = ?
        AND status IN ('pending', 'failed', 'processing')
    `).run(
      JSON.stringify(raw),
      input.job.jobId,
      input.job.tenantId,
      input.job.userId,
      CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      input.sourceRunId,
    );
    if (Number(updated.changes ?? 0) !== 1) {
      throw new Error('chat_legacy_timeout_continuation_delivery_fence_lost');
    }
    return 'indeterminate_send_exception';
  })();
}

function buildHonestContinuationFailureText(
  locale: string | null,
  completedTools: string[],
): string {
  const completed = cleanCompletedTools(completedTools)
    .map((tool) => tool.replace(/_/g, ' '))
    .join(', ');
  const completedClause = completed || 'the completed steps';
  const normalized = String(locale ?? '').toLowerCase();
  if (normalized.startsWith('pt')) {
    return `Não consegui concluir a continuação em segundo plano com segurança. Preservei o trabalho já concluído (${completedClause}) e não o repeti. Pede-me para continuar; qualquer alteração exigirá nova confirmação.`;
  }
  return `I could not finish the background continuation safely. I preserved the completed work (${completedClause}) and did not repeat it. Ask me to continue; any change will require confirmation.`;
}

function shouldSuppressRetiredLocaleLateResult(
  locale: string | null,
  text: string,
): boolean {
  if (!/^es(?:[-_]|$)/i.test(String(locale ?? '').trim())) return false;
  // Unknown includes short acknowledgements such as "Listo". For a retired
  // locale, fail closed unless the saved text is confidently English.
  return detectResponseLanguage(text).language !== 'en';
}

function retiredLocaleLateResultFallbackText(): string {
  return 'The background request finished, but I could not safely present its saved result in English. I preserved the result and did not run the request again. Open the original turn and ask for an English summary if needed.';
}

function buildPrivacySafePushBody(
  locale: string | null,
  source: ChatLegacyTimeoutTerminalSource,
): string {
  const normalized = String(locale ?? '').toLowerCase();
  if (normalized.startsWith('pt')) {
    return source === 'late_foreground_result'
      ? 'Abre o Nexus para ver a resposta concluída.'
      : 'Abre o Nexus para rever o estado do pedido.';
  }
  return source === 'late_foreground_result'
    ? 'Open Nexus to view the completed answer.'
    : 'Open Nexus to review the request status.';
}

export interface ProcessChatLegacyTimeoutContinuationResult {
  source: ChatLegacyTimeoutTerminalSource;
  messageId: string;
  apnsPushed: boolean;
  apnsAlreadyDelivered: boolean;
  apnsOutcome: ChatLegacyTimeoutApnsOutcome;
}

export async function processChatLegacyTimeoutContinuationJob(
  job: JobRecord,
  opts: { now?: Date; pushNotification?: typeof sendPushNotification } = {},
): Promise<ProcessChatLegacyTimeoutContinuationResult> {
  if (job.jobType !== CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE || !job.userId) {
    throw new Error('chat_legacy_timeout_continuation_scope_invalid');
  }
  const userId = job.userId;
  const now = opts.now ?? new Date();
  const terminalClaim = claimTerminalPayload(job, now, randomUUID());
  const payload = terminalClaim.payload;
  const source = payload.delivery?.terminalSource;
  if (!source) throw new Error('chat_legacy_timeout_continuation_payload_invalid');
  // Background jobs can survive a locale-retirement deploy. Keep their stored
  // payload byte-compatible while projecting the effective response locale at
  // the consumer boundary.
  const responseLocale = normalizeSupportedLang(payload.locale, 'en-US');
  const lateResultLocaleFallback = source === 'late_foreground_result'
    && Boolean(payload.lateResult)
    && shouldSuppressRetiredLocaleLateResult(payload.locale, payload.lateResult?.text ?? '');
  const result: ChatDomainExecutionResult = source === 'late_foreground_result' && payload.lateResult
    ? {
      text: lateResultLocaleFallback
        ? retiredLocaleLateResultFallbackText()
        : payload.lateResult.text,
      domain: payload.lateResult.domain,
    }
    : {
      text: buildHonestContinuationFailureText(responseLocale, payload.completedTools),
      domain: payload.domain,
    };
  const tracker = createChatLatencyTracker(now.getTime());
  const finalized = finalizeChatAnswerMetadata({
    normalizedText: payload.sourceText,
    responseText: result.text,
    userId,
    tenantId: job.tenantId,
    chatRequestId: `${payload.sourceRunId}:background`,
    routeMethod: 'legacy-timeout-background',
    domain: result.domain || payload.domain,
    confidence: 1,
    tracker,
    latencyTier: 'tier4_long_running',
    route: {
      domain: result.domain || payload.domain,
      method: 'ai',
      confidence: 1,
      strippedMessage: payload.sourceText,
    },
    locale: responseLocale,
    existingMetadata: {
      type: 'chat_timeout_background_continuation',
      sourceRunId: payload.sourceRunId,
      source,
      completedTools: payload.completedTools,
      recoveryPolicy: payload.recoveryPolicy,
      destructiveResumePolicy: 'reconfirm',
      ...(lateResultLocaleFallback ? {
        lateResultLocaleFallback: {
          applied: true,
          effectiveLocale: responseLocale,
          reason: 'retired_spanish_response',
        },
      } : {}),
    },
    verificationStatus: 'not_required',
    stageFamily: 'legacy_timeout_background',
    requestStartedAt: now.getTime(),
  });
  const messageId = continuationMessageId(job, payload.sourceRunId);
  if (!payload.delivery?.messageStoredAt) {
    if (!terminalClaim.ownerToken) throw new Error('chat_legacy_timeout_continuation_delivery_fence_lost');
    persistMessageUnderDeliveryFence({
      job,
      sourceRunId: payload.sourceRunId,
      ownerToken: terminalClaim.ownerToken,
      now,
      persist: () => {
        storeChatMessage({
          tenantId: job.tenantId,
          userId,
          messageId,
          role: 'assistant',
          text: finalized.text,
          domain: result.domain || payload.domain,
          routeMethod: 'legacy-timeout-background',
          confidence: 1,
          buttons: null,
          metadata: finalized.metadata,
          timestamp: now.toISOString(),
          lifecycleState: 'completed',
          completedAt: now.toISOString(),
          retryOfMessageId: payload.sourceMessageId,
          requestId: payload.sourceRunId,
        });
        rememberChatActiveDomain(userId, result.domain || payload.domain, now.getTime(), job.tenantId, {
          conversationId: payload.sourceRunId,
          lastAssistantMessageId: messageId,
          anchorEntityIds: [],
        });
      },
    });
  }

  const apnsAlreadyDelivered = payload.delivery?.apnsState === 'delivered';
  const apnsClaim: ApnsAttemptClaim = payload.delivery?.apnsState
    && isApnsTerminalState(payload.delivery.apnsState)
    ? {
      kind: 'terminal',
      state: payload.delivery.apnsState,
      outcome: payload.delivery.apnsOutcome ?? 'no_targets',
    }
    : claimApnsAttempt({
      job,
      sourceRunId: payload.sourceRunId,
      ownerToken: terminalClaim.ownerToken,
      now,
    });
  let pushResult: SendResult = { sent: 0, failed: 0, skipped: 0, retriable: 0, unregistered: [] };
  let apnsOutcome: ChatLegacyTimeoutApnsOutcome;
  if (apnsClaim.kind === 'terminal') {
    apnsOutcome = apnsClaim.outcome;
  } else {
    let concurrentTerminalOutcome: ChatLegacyTimeoutApnsOutcome | null = null;
    try {
      pushResult = await (opts.pushNotification ?? sendPushNotification)(userId, {
        title: lateResultLocaleFallback
          ? 'Background result needs review'
          : source === 'late_foreground_result'
            ? 'Your answer is ready'
            : 'Background continuation stopped',
        // Lock-screen/banner copy must never contain the provider answer,
        // calendar/mail/finance contents, tool names, or raw failure details.
        body: lateResultLocaleFallback
          ? 'Open Nexus to review the request status.'
          : buildPrivacySafePushBody(responseLocale, source),
        collapseId: `${CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE}:${payload.sourceRunId}`,
        threadId: payload.sourceRunId,
        category: CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      });
    } catch {
      if (!terminalClaim.ownerToken) throw new Error('chat_legacy_timeout_continuation_delivery_fence_lost');
      concurrentTerminalOutcome = markApnsAttemptIndeterminate({
        job,
        sourceRunId: payload.sourceRunId,
        ownerToken: terminalClaim.ownerToken,
        attemptToken: apnsClaim.attemptToken,
        now,
      });
      if (concurrentTerminalOutcome === 'indeterminate_send_exception') {
        throw new Error('chat_legacy_timeout_continuation_apns_indeterminate');
      }
    }
    if (concurrentTerminalOutcome) {
      apnsOutcome = concurrentTerminalOutcome;
    } else {
      if (!terminalClaim.ownerToken) throw new Error('chat_legacy_timeout_continuation_delivery_fence_lost');
      const recorded = recordApnsAttemptResult({
        job,
        sourceRunId: payload.sourceRunId,
        ownerToken: terminalClaim.ownerToken,
        attemptToken: apnsClaim.attemptToken,
        now,
        result: pushResult,
      });
      if (recorded.state === 'retryable') {
        throw new Error('chat_legacy_timeout_continuation_apns_retryable');
      }
      apnsOutcome = recorded.outcome ?? 'no_targets';
    }
  }
  logger.info({
    scope: CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
    jobId: job.jobId,
    sourceRunId: payload.sourceRunId,
    source,
    messageId,
    apnsSent: pushResult.sent,
    apnsFailed: pushResult.failed,
    apnsRetriable: pushResult.retriable,
    apnsSkipped: pushResult.skipped,
    apnsOutcome,
  }, 'chat_legacy_timeout_continuation_completed');
  return {
    source,
    messageId,
    apnsPushed: pushResult.sent > 0,
    apnsAlreadyDelivered,
    apnsOutcome,
  };
}

export const chatLegacyTimeoutContinuationJobHandler: JobHandler = {
  jobType: CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
  idempotent: true,
  async handle(job): Promise<void> {
    await processChatLegacyTimeoutContinuationJob(job);
  },
};

export function cancelChatLegacyTimeoutContinuationsForScope(input: {
  tenantId: number;
  userId: number;
}): number {
  const result = getDb().prepare(`
    UPDATE background_jobs
    SET status = 'canceled',
        completed_at = datetime('now'),
        locked_at = NULL,
        lock_owner = NULL
    WHERE tenant_id = ?
      AND user_id = ?
      AND job_type = ?
      AND status IN ('pending', 'failed', 'processing', 'dead_letter')
  `).run(input.tenantId, input.userId, CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE);
  return Number(result.changes ?? 0);
}
