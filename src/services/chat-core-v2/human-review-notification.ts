// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Chat Core v2 — write-risk human-review enqueue + operator notification (WP-10,
 * the notification half of B6).
 *
 * A Class-C write (restricted finance / training plan rewrite) is blocked at the
 * action gateway (no execute envelope) and routed into the human-review queue.
 * This module is the consumer-facing seam: it enqueues the review through the
 * REAL `enqueueChatV2HumanReview` store export with a DETERMINISTIC reviewId
 * (`hvr:${commandId}`, ON CONFLICT upsert), and — on a successful, newly-enqueued
 * (non-ON-CONFLICT-noop) review — fires an operator notification EXACTLY ONCE.
 *
 * "A write-blocking governance event must push, not wait to be polled." The
 * notification mirrors the WP-07 auto-revert pager pattern exactly:
 *   - `CHAT_CORE_V2_PAGER_WEBHOOK_URL`, https-only, 5s AbortController timeout,
 *   - fully NON-FATAL (absent / non-https / non-2xx / network error / timeout
 *     never throws out of this function),
 *   - carries ONLY `redacted_summary` / `domain` / `reason` / `reviewId` — NO
 *     payload PII, no raw message text, no raw tenant/user id.
 *
 * DEDUP: keyed on `reviewId`. A given review is notified at most once per process
 * even across enqueue retries, and the notification only fires when the row was
 * NEWLY inserted (not when the upsert hit an existing row).
 */

import Database from 'better-sqlite3';

import { logger } from '../../utils/logger';
import { getDb } from '../database';
import {
  enqueueChatV2HumanReview,
  getChatV2HumanReviewById,
  type ChatV2HumanReviewRecord,
} from './human-review-queue';
import type {
  AuditSensitivity,
  ChatCoreV2Domain,
  ChatV2HumanReviewRequest,
  HumanReviewReason,
} from './types';

export const CHAT_CORE_V2_HUMAN_REVIEW_NOTIFIER_VERSION = 'chat_core_v2_human_review_notifier@1.0.0';

/**
 * Module-scoped dedup set, keyed on reviewId. Guarantees the operator
 * notification fires AT MOST ONCE per reviewId per process, independent of the
 * store's ON-CONFLICT upsert. Wiped via the test reset below.
 */
const _notifiedReviewIds = new Set<string>();

/** Test-only: clear the notification dedup set (use in beforeEach/afterEach). */
export function _resetChatV2HumanReviewNotificationDedupForTests(): void {
  _notifiedReviewIds.clear();
}

export interface EnqueueChatV2HumanReviewForWriteRiskInput {
  /** Stable command id — the deterministic reviewId is `hvr:${commandId}`. */
  commandId: string;
  turnId: string;
  tenantId: string;
  userId: string;
  domain: ChatCoreV2Domain;
  reason: HumanReviewReason;
  sensitivity: AuditSensitivity;
  /**
   * REDACTED summary only — derived from `commandType + commandId`, NEVER from the
   * raw payload. Callers must not pass user message text or payload fields.
   */
  redactedSummary: string;
  requestedAt: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface EnqueueChatV2HumanReviewForWriteRiskResult {
  reviewId: string;
  record: ChatV2HumanReviewRecord;
  /** True iff this enqueue INSERTED a new row (not an ON-CONFLICT upsert no-op). */
  newlyEnqueued: boolean;
  /** True iff an operator notification was dispatched for this call. */
  notified: boolean;
}

/**
 * Deterministic reviewId for a command. ON CONFLICT upsert keys on this id, so a
 * retried enqueue of the same command targets the same row.
 */
export function chatV2HumanReviewIdForCommand(commandId: string): string {
  return `hvr:${commandId}`;
}

/**
 * Enqueue a write-risk human review (deterministic id, upsert) and fire the
 * operator notification EXACTLY ONCE on a newly-enqueued (non-noop) review.
 * Never throws on a notification transport failure.
 */
export async function enqueueChatV2HumanReviewForWriteRisk(
  input: EnqueueChatV2HumanReviewForWriteRiskInput,
  options: { db?: Database.Database; env?: NodeJS.ProcessEnv } = {},
): Promise<EnqueueChatV2HumanReviewForWriteRiskResult> {
  const db = options.db ?? getDb();
  const env = options.env ?? process.env;
  const reviewId = chatV2HumanReviewIdForCommand(input.commandId);

  // Detect newly-enqueued vs upsert-noop: a pre-existing row means the ON CONFLICT
  // branch fired (a noop for notification purposes). This read is scoped to the
  // same db handle the enqueue uses.
  const existing = getChatV2HumanReviewById(reviewId, db);
  const newlyEnqueued = existing === null;

  const request: ChatV2HumanReviewRequest = {
    reviewId,
    turnId: input.turnId,
    commandId: input.commandId,
    tenantId: input.tenantId,
    userId: input.userId,
    domain: input.domain,
    reason: input.reason,
    status: 'pending',
    sensitivity: input.sensitivity,
    // REDACTED summary only — no payload PII.
    redactedSummary: input.redactedSummary,
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
    metadata: input.metadata,
  };
  const record = enqueueChatV2HumanReview(request, db);

  // Fire the operator notification EXACTLY ONCE, only for a NEWLY-enqueued review
  // that has not already been notified in this process.
  let notified = false;
  if (newlyEnqueued && !_notifiedReviewIds.has(reviewId)) {
    _notifiedReviewIds.add(reviewId);
    notified = true;
    await notifyOperatorOfHumanReview(
      {
        reviewId: record.reviewId,
        domain: record.domain,
        reason: record.reason,
        redactedSummary: record.redactedSummary,
      },
      env,
    );
  }

  return { reviewId, record, newlyEnqueued, notified };
}

/**
 * The redacted, PII-free notification payload. By construction it carries ONLY
 * the four allowlisted fields — reviewId, domain, reason, redactedSummary.
 */
export interface ChatV2HumanReviewOperatorNotification {
  reviewId: string;
  domain: ChatCoreV2Domain;
  reason: HumanReviewReason;
  redactedSummary: string;
}

/**
 * Fire a single operator notification via `CHAT_CORE_V2_PAGER_WEBHOOK_URL`.
 * NON-FATAL by contract (mirrors the WP-07 auto-revert pager): returns without
 * throwing on an absent / non-https URL, a non-2xx response, a network error, or
 * a 5s `AbortController` timeout. The body carries ONLY the four allowlisted,
 * redacted fields — never raw tenant/user id, raw message text, or payload PII.
 */
export async function notifyOperatorOfHumanReview(
  notification: ChatV2HumanReviewOperatorNotification,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const rawUrl = String(env.CHAT_CORE_V2_PAGER_WEBHOOK_URL ?? '').trim();
    if (!rawUrl) return; // absent — non-fatal no-op.

    // https-only guard: refuse to notify over a non-https endpoint.
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return;
    }
    if (parsed.protocol !== 'https:') return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    try {
      const res = await fetch(rawUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'chat_core_v2_human_review_enqueued',
          version: CHAT_CORE_V2_HUMAN_REVIEW_NOTIFIER_VERSION,
          // ONLY the four allowlisted, redacted fields. No payload PII.
          reviewId: notification.reviewId,
          domain: notification.domain,
          reason: notification.reason,
          redactedSummary: notification.redactedSummary,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn(
          {
            event: 'chat_core_v2_human_review_notify_non_2xx',
            reviewId: notification.reviewId,
            status: res.status,
          },
          'Chat Core v2 human-review operator notification returned non-2xx (non-fatal)',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // AbortError / network error / anything else — non-fatal.
    logger.warn(
      {
        event: 'chat_core_v2_human_review_notify_failed',
        reviewId: notification.reviewId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Chat Core v2 human-review operator notification failed (non-fatal)',
    );
  }
}
