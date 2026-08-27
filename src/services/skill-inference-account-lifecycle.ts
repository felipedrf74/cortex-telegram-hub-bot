// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import {
  isLocalFairUseExemptFailureReason,
  localInferenceFailureReason,
} from './local-inference-failure-taxonomy';

export class SkillInferencePolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SkillInferencePolicyError';
  }
}

export function isSkillInferenceAccountDeletionError(error: unknown): boolean {
  return localInferenceFailureReason(error) === 'ACCOUNT_DELETION_IN_PROGRESS';
}

const ACCOUNT_DELETION_FENCE_TTL_MS = 15 * 60 * 1_000;
const ACCOUNT_DELETION_DRAIN_TIMEOUT_MS = 30_000;
const SKILL_INFERENCE_RUNTIME_INSTANCE_ID = crypto.randomUUID();
const activeAccountInferenceControllers = new Map<number, Set<AbortController>>();
const activeAccountDeletionFenceTokens = new Map<number, string>();

function accountDeletionAbortReason(): Error & { code: 'ACCOUNT_DELETION_IN_PROGRESS' } {
  return Object.assign(new Error('account_deletion_in_progress'), {
    name: 'AbortError',
    code: 'ACCOUNT_DELETION_IN_PROGRESS' as const,
  });
}

export function isSkillInferenceAccountDeletionFenced(
  userId: number,
  db: Database.Database = getDb(),
): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0) return true;
  const row = db.prepare(`SELECT 1 AS present
    FROM local_inference_account_deletion_fences
    WHERE user_id = ? AND expires_at > ?`)
    .get(userId, Date.now()) as { present: number } | undefined;
  return row?.present === 1;
}

/**
 * Acquire the durable account-erasure fence and abort every admitted model
 * operation owned by the user in this backend process.
 */
export function beginSkillInferenceAccountDeletionFence(
  userId: number,
  db: Database.Database = getDb(),
): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new SkillInferencePolicyError(
      'INFERENCE_SCOPE_INVALID',
      'A valid account owner is required for the deletion fence.',
      403,
    );
  }
  const now = Date.now();
  if (activeAccountDeletionFenceTokens.has(userId)) {
    throw new SkillInferencePolicyError(
      'ACCOUNT_DELETION_IN_PROGRESS',
      'Account deletion is already in progress.',
      409,
    );
  }
  const token = db.transaction(() => {
    const existing = db.prepare(`SELECT fence_token, runtime_instance_id, expires_at
      FROM local_inference_account_deletion_fences WHERE user_id = ?`)
      .get(userId) as {
        fence_token: string;
        runtime_instance_id: string;
        expires_at: number;
      } | undefined;
    if (existing && existing.expires_at > now) {
      // A failed deletion that already crossed an external-cleanup boundary
      // retains its exact fence. Only the same live runtime may resume that
      // token, and the in-memory owner check above prevents overlap.
      if (existing.runtime_instance_id !== SKILL_INFERENCE_RUNTIME_INSTANCE_ID) {
        throw new SkillInferencePolicyError(
          'ACCOUNT_DELETION_IN_PROGRESS',
          'Account deletion is already in progress.',
          409,
        );
      }
      const resumed = db.prepare(`UPDATE local_inference_account_deletion_fences
        SET expires_at = ?
        WHERE user_id = ? AND fence_token = ? AND runtime_instance_id = ?
          AND expires_at > ?`)
        .run(
          now + ACCOUNT_DELETION_FENCE_TTL_MS,
          userId,
          existing.fence_token,
          SKILL_INFERENCE_RUNTIME_INSTANCE_ID,
          now,
        ).changes;
      if (resumed !== 1) {
        throw new SkillInferencePolicyError(
          'ACCOUNT_DELETION_IN_PROGRESS',
          'Account deletion fence ownership changed during resume.',
          409,
        );
      }
      return existing.fence_token;
    }

    const nextToken = crypto.randomUUID();
    db.prepare(`INSERT INTO local_inference_account_deletion_fences (
        user_id, fence_token, runtime_instance_id, expires_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        fence_token = excluded.fence_token,
        runtime_instance_id = excluded.runtime_instance_id,
        expires_at = excluded.expires_at,
        created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE local_inference_account_deletion_fences.expires_at <= ?`)
      .run(
        userId,
        nextToken,
        SKILL_INFERENCE_RUNTIME_INSTANCE_ID,
        now + ACCOUNT_DELETION_FENCE_TTL_MS,
        now,
      );
    const acquired = db.prepare(`SELECT fence_token, runtime_instance_id
      FROM local_inference_account_deletion_fences WHERE user_id = ?`)
      .get(userId) as { fence_token: string; runtime_instance_id: string } | undefined;
    if (acquired?.fence_token !== nextToken
        || acquired.runtime_instance_id !== SKILL_INFERENCE_RUNTIME_INSTANCE_ID) {
      throw new SkillInferencePolicyError(
        'ACCOUNT_DELETION_IN_PROGRESS',
        'Account deletion is already in progress.',
        409,
      );
    }
    return nextToken;
  }).immediate();
  activeAccountDeletionFenceTokens.set(userId, token);

  for (const controller of activeAccountInferenceControllers.get(userId) ?? []) {
    if (!controller.signal.aborted) controller.abort(accountDeletionAbortReason());
  }
  return token;
}

export function clearSkillInferenceAccountDeletionFence(
  userId: number,
  fenceToken: string,
  db: Database.Database = getDb(),
): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !fenceToken) return false;
  try {
    return db.prepare(`DELETE FROM local_inference_account_deletion_fences
      WHERE user_id = ? AND fence_token = ?`).run(userId, fenceToken).changes === 1;
  } finally {
    if (activeAccountDeletionFenceTokens.get(userId) === fenceToken) {
      activeAccountDeletionFenceTokens.delete(userId);
    }
  }
}

/**
 * Keep the exact durable fence after external cleanup has begun, but release
 * this request's in-process ownership so a later request in the same runtime
 * can resume it. A foreign runtime must wait for proven lease expiry.
 */
export function retainSkillInferenceAccountDeletionFenceForRetry(
  userId: number,
  fenceToken: string,
  db: Database.Database = getDb(),
): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !fenceToken) return false;
  const now = Date.now();
  try {
    return db.prepare(`UPDATE local_inference_account_deletion_fences
      SET expires_at = ?
      WHERE user_id = ? AND fence_token = ? AND runtime_instance_id = ?
        AND expires_at > ?`)
      .run(
        now + ACCOUNT_DELETION_FENCE_TTL_MS,
        userId,
        fenceToken,
        SKILL_INFERENCE_RUNTIME_INSTANCE_ID,
        now,
      ).changes === 1;
  } finally {
    if (activeAccountDeletionFenceTokens.get(userId) === fenceToken) {
      activeAccountDeletionFenceTokens.delete(userId);
    }
  }
}

/** Release only process-local ownership after the durable row was erased. */
export function releaseSkillInferenceAccountDeletionFenceOwnership(
  userId: number,
  fenceToken: string,
): boolean {
  if (activeAccountDeletionFenceTokens.get(userId) !== fenceToken) return false;
  activeAccountDeletionFenceTokens.delete(userId);
  return true;
}

/**
 * Extend only the exact still-live fence owned by this deletion process. An
 * expired fence is never resurrected because another process may already have
 * admitted work during that interval.
 */
export function renewSkillInferenceAccountDeletionFence(
  userId: number,
  fenceToken: string,
  db: Database.Database = getDb(),
): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !fenceToken) return false;
  const now = Date.now();
  return db.prepare(`UPDATE local_inference_account_deletion_fences
    SET expires_at = ?
    WHERE user_id = ? AND fence_token = ? AND runtime_instance_id = ?
      AND expires_at > ?`)
    .run(
      now + ACCOUNT_DELETION_FENCE_TTL_MS,
      userId,
      fenceToken,
      SKILL_INFERENCE_RUNTIME_INSTANCE_ID,
      now,
    ).changes === 1;
}

function registerAccountInferenceController(
  userId: number,
  callerSignal: AbortSignal | undefined,
  db: Database.Database,
): { signal: AbortSignal; release: () => void } {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new SkillInferencePolicyError(
      'INFERENCE_SCOPE_INVALID',
      'A valid authenticated tenant/user scope is required.',
      403,
    );
  }
  const assertAccountStillActive = (): void => {
    const account = db.prepare('SELECT status FROM users WHERE id = ? LIMIT 1')
      .get(userId) as { status: string } | undefined;
    if (!account || account.status !== 'active') {
      throw new SkillInferencePolicyError(
        'ACCOUNT_DELETION_IN_PROGRESS',
        'No new model work can start for an unavailable account.',
        409,
      );
    }
  };
  assertAccountStillActive();
  if (isSkillInferenceAccountDeletionFenced(userId, db)) {
    throw new SkillInferencePolicyError(
      'ACCOUNT_DELETION_IN_PROGRESS',
      'No new model work can start while this account is being deleted.',
      409,
    );
  }

  const controller = new AbortController();
  const userControllers = activeAccountInferenceControllers.get(userId) ?? new Set<AbortController>();
  userControllers.add(controller);
  activeAccountInferenceControllers.set(userId, userControllers);
  const release = (): void => {
    userControllers.delete(controller);
    if (userControllers.size === 0) activeAccountInferenceControllers.delete(userId);
  };

  try {
    assertAccountStillActive();
  } catch (error) {
    controller.abort(accountDeletionAbortReason());
    release();
    throw error;
  }
  if (isSkillInferenceAccountDeletionFenced(userId, db)) {
    controller.abort(accountDeletionAbortReason());
    release();
    throw new SkillInferencePolicyError(
      'ACCOUNT_DELETION_IN_PROGRESS',
      'No new model work can start while this account is being deleted.',
      409,
    );
  }
  return {
    signal: callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal,
    release,
  };
}

export function assertSkillInferenceNotCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = localInferenceFailureReason(signal.reason);
  if (isLocalFairUseExemptFailureReason(reason) && signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw Object.assign(new SkillInferencePolicyError(
    'INFERENCE_CANCELLED',
    'The inference request was cancelled.',
    499,
  ), { name: 'AbortError' });
}

export async function runWithSkillInferenceAccountAdmission<T>(
  input: { userId: number; abortSignal?: AbortSignal },
  operation: (abortSignal: AbortSignal) => Promise<T>,
  db: Database.Database = getDb(),
): Promise<T> {
  const registration = registerAccountInferenceController(input.userId, input.abortSignal, db);
  try {
    assertSkillInferenceNotCancelled(registration.signal);
    const result = await operation(registration.signal);
    assertSkillInferenceNotCancelled(registration.signal);
    return result;
  } finally {
    registration.release();
  }
}

export async function waitForSkillInferenceAccountAdmissionsToDrain(
  userId: number,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new SkillInferencePolicyError(
      'INFERENCE_SCOPE_INVALID',
      'A valid authenticated account owner is required.',
      403,
    );
  }
  const timeoutMs = Math.max(0, Math.min(
    options.timeoutMs ?? ACCOUNT_DELETION_DRAIN_TIMEOUT_MS,
    ACCOUNT_DELETION_FENCE_TTL_MS,
  ));
  const pollIntervalMs = Math.max(1, Math.min(options.pollIntervalMs ?? 25, 250));
  const deadline = Date.now() + timeoutMs;
  while ((activeAccountInferenceControllers.get(userId)?.size ?? 0) > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new SkillInferencePolicyError(
        'ACCOUNT_DELETION_INFERENCE_DRAIN_TIMEOUT',
        'Active model work did not stop before account deletion.',
        503,
        { retryable: true },
      );
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(pollIntervalMs, remaining));
      timer.unref?.();
    });
  }
}
