// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WP-15 — background write-command worker handler.
 *
 * Processes the `chat_core_v2_background_command` jobs enqueued by
 * `enqueueBackgroundChatCommand`. On each job:
 *   1. Reconstruct the queued command envelope + capabilityId.
 *   2. STALE-ENVELOPE check: if the envelope has expired, SKIP execution and
 *      mark the lifecycle COMPLETED (not failed) — a stale job is a no-op, not a
 *      failure (§5.E / WP-15 acceptance).
 *   3. Re-validate `isExecutableCommandType` (defence in depth; the enqueue side
 *      already rejected unexecutable types).
 *   4. When the job is the 35B escalation path, resolve the keep-alive residency
 *      via `resolveKeepAliveForRole('escalation_35b')` (=300) — the only path
 *      that exercises the 5m residency (closes B8).
 *   5. Execute via `executeChatCoreV2Command` (§5.E crossing 3: ids are NUMBER).
 *   6. Record a command event using ONLY migration-159 enum values
 *      (execution => `execution_completed`/`verified`; failure =>
 *      `command_failed`/`failed`; stale skip => `stale_rejected`/`stale`) (§5.E
 *      crossing 4: recordChatV2CommandEvent ids are STRING).
 *   7. Transition the in-memory lifecycle via `canTransitionBackgroundJob`.
 *   8. Push APNs when `notificationPolicy === 'apns'` (collapseId = commandId).
 *
 * The handler THROWS on execution failure so the SQLite queue's bounded-retry +
 * dead-letter machinery (markJobFailed) takes over. A stale skip resolves
 * cleanly (no throw) so the queue marks it completed.
 */

import type { JobHandler, JobRecord } from '../background-job-queue';
import { sendPushNotification } from '../apns-sender';
import { logger } from '../../utils/logger';
import {
  canTransitionBackgroundJob,
  isExecutableBackgroundCommandJobType,
  CHAT_CORE_V2_BACKGROUND_COMMAND_JOB_TYPE,
  type ChatCoreV2BackgroundCommandJobPayload,
  type ChatCoreV2BackgroundJobState,
} from './background-lifecycle';
import {
  executeChatCoreV2Command,
  isExecutableCommandType,
} from './command-executor';
import { recordChatV2CommandEvent } from './command-events';
import { resolveKeepAliveForRole } from './model-residency-policy';
import type { AICommandEnvelope, ChatCoreV2Domain } from './types';

export interface ProcessBackgroundChatCommandResult {
  outcome: 'verified' | 'failed' | 'stale_completed';
  status: string;
  finalState: ChatCoreV2BackgroundJobState;
  apnsPushed: boolean;
  /** The resolved keep-alive seconds when the 35B escalation path ran. */
  escalationKeepAliveSeconds?: number;
}

/**
 * Pure transition resolver used by both the worker and tests: given the starting
 * state and the execution outcome, compute the next lifecycle state, validating
 * the edge through `canTransitionBackgroundJob`.
 */
export function resolveBackgroundCommandTransition(
  from: ChatCoreV2BackgroundJobState,
  to: ChatCoreV2BackgroundJobState,
): ChatCoreV2BackgroundJobState {
  return canTransitionBackgroundJob(from, to) ? to : from;
}

function coercePayload(raw: Record<string, unknown>): ChatCoreV2BackgroundCommandJobPayload | null {
  const command = raw.command as AICommandEnvelope<Record<string, unknown>> | undefined;
  if (!command || typeof command !== 'object') return null;
  if (typeof raw.capabilityId !== 'string' || !raw.capabilityId) return null;
  if (typeof raw.tenantId !== 'string' || typeof raw.userId !== 'string') return null;
  return {
    jobType: raw.jobType as ChatCoreV2BackgroundCommandJobPayload['jobType'],
    capabilityId: raw.capabilityId,
    tenantId: raw.tenantId,
    userId: raw.userId,
    turnId: typeof raw.turnId === 'string' ? raw.turnId : command.basedOn.contextHash,
    contextHash: typeof raw.contextHash === 'string' ? raw.contextHash : command.basedOn.contextHash,
    notificationPolicy: raw.notificationPolicy === 'silent' ? 'silent' : 'apns',
    resumeDeepLink: typeof raw.resumeDeepLink === 'string' ? raw.resumeDeepLink : '',
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : command.expiresAt,
    locale: typeof raw.locale === 'string' ? raw.locale : null,
    command,
  };
}

function isStaleEnvelope(expiresAt: string, now: Date): boolean {
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed <= now.getTime();
}

/**
 * Execute one queued background chat write command. Returns a structured result
 * for tests; THROWS on execution failure so the queue retries / dead-letters.
 */
export async function processBackgroundChatCommandJob(
  job: JobRecord,
  opts: { now?: Date; pushNotification?: typeof sendPushNotification } = {},
): Promise<ProcessBackgroundChatCommandResult> {
  const now = opts.now ?? new Date();
  const push = opts.pushNotification ?? sendPushNotification;
  const payload = coercePayload(job.payload);
  if (!payload) {
    throw new Error('chat_core_v2_background_command_payload_invalid');
  }

  // jobType runtime guard (§5.E) — defence in depth; the enqueue side already
  // rejected 'critic' et al.
  if (!isExecutableBackgroundCommandJobType(payload.jobType)) {
    throw new Error(`chat_core_v2_background_command_invalid_job_type:${payload.jobType}`);
  }

  const command = payload.command;
  const domain = command.domain as ChatCoreV2Domain;

  // §5.E crossing 4: recordChatV2CommandEvent ids are STRING. The command
  // envelope already carries STRING ids, and the payload stores STRING ids; use
  // them directly (explicit, no number leakage).
  const tenantIdStr = String(payload.tenantId);
  const userIdStr = String(payload.userId);

  // ── STALE-ENVELOPE check: skip + mark COMPLETED (not failed). ──
  if (isStaleEnvelope(payload.expiresAt, now)) {
    recordChatV2CommandEvent({
      commandEventId: `${command.commandId}:background_stale_rejected`,
      turnId: payload.turnId,
      commandId: command.commandId,
      tenantId: tenantIdStr,
      userId: userIdStr,
      domain,
      commandType: command.commandType,
      // migration-159 valid event_name + status.
      eventName: 'stale_rejected',
      status: 'stale',
      origin: command.origin,
      capabilityId: payload.capabilityId,
      idempotencyKey: command.idempotencyKey,
      reason: 'background_command_envelope_stale',
      redactedSummary: `${command.commandType} stale_rejected`,
      metadata: { jobId: job.jobId, jobType: payload.jobType },
      createdAt: now.toISOString(),
    });
    // The lifecycle state machine has no pending→completed edge (completion is a
    // running-state terminal). A stale envelope is terminally EXPIRED (a valid
    // pending→expired edge), while the QUEUE row is marked completed (no retry,
    // no failure) by the queue's markJobCompleted — a stale job is a clean no-op,
    // not a failure (§5.E "skip + mark completed, not failed").
    const finalState = resolveBackgroundCommandTransition('pending', 'expired');
    logger.info(
      { scope: 'chat_core_v2_background_command', jobId: job.jobId, commandId: command.commandId, outcome: 'stale_completed', finalState },
      'chat_core_v2_background_command_stale_skipped',
    );
    return { outcome: 'stale_completed', status: 'stale', finalState, apnsPushed: false };
  }

  // ── Re-validate the command type is executable (defence in depth). ──
  if (!isExecutableCommandType(command.commandType)) {
    throw new Error(`chat_core_v2_background_command_unexecutable:${command.commandType}`);
  }

  // ── 35B escalation residency (§5.E closes B8). The planner_escalation jobType
  // is the only path that runs the 35B model in the background; assert its 5m
  // (=300) keep-alive residency here. composer stays on the 3B/foreground model
  // and does not pin the 35B residency. ──
  let escalationKeepAliveSeconds: number | undefined;
  if (payload.jobType === 'planner_escalation') {
    escalationKeepAliveSeconds = resolveKeepAliveForRole('escalation_35b');
  }

  // §5.E crossing 3: executeChatCoreV2Command ids are NUMBER. Convert the STRING
  // payload ids back to NUMBER explicitly at this boundary.
  const execution = await executeChatCoreV2Command({
    command,
    capabilityId: payload.capabilityId,
    userId: Number(payload.userId),
    tenantId: Number(payload.tenantId),
    locale: payload.locale,
    now,
  });

  // ── Record a command event using ONLY migration-159 enum values. ──
  const succeeded = execution.ok && execution.status === 'verified';
  recordChatV2CommandEvent({
    commandEventId: `${command.commandId}:background_${succeeded ? 'execution_completed' : 'command_failed'}`,
    turnId: payload.turnId,
    commandId: command.commandId,
    tenantId: tenantIdStr,
    userId: userIdStr,
    domain,
    commandType: command.commandType,
    // migration-159 valid event_name + status.
    eventName: succeeded ? 'execution_completed' : 'command_failed',
    status: succeeded ? 'verified' : 'failed',
    origin: command.origin,
    capabilityId: payload.capabilityId,
    idempotencyKey: command.idempotencyKey,
    reason: succeeded ? undefined : (execution.reason ?? 'execution_failed'),
    redactedSummary: `${command.commandType} background_${succeeded ? 'execution_completed' : 'command_failed'}`,
    metadata: {
      jobId: job.jobId,
      jobType: payload.jobType,
      executorStatus: execution.status,
      ...(escalationKeepAliveSeconds !== undefined ? { escalationKeepAliveSeconds } : {}),
    },
    createdAt: now.toISOString(),
  });

  const finalState = resolveBackgroundCommandTransition('running', succeeded ? 'completed' : 'failed');

  // ── APNs delivery (only when policy === 'apns'). The collapseId dedupes
  // repeated deliveries for the same command (APNs dedup, WP-15 risks). ──
  let apnsPushed = false;
  if (payload.notificationPolicy === 'apns') {
    apnsPushed = true;
    const body = typeof execution.response?.text === 'string' && execution.response.text.trim()
      ? execution.response.text.trim().slice(0, 150)
      : (succeeded ? 'Your request finished.' : 'I could not finish your request.');
    await push(Number(payload.userId), {
      title: succeeded ? 'Done' : 'Action needs attention',
      body,
      collapseId: `chat_core_v2_command:${command.commandId}`,
      threadId: payload.turnId,
      category: 'chat_core_v2_command',
    });
  }

  if (!succeeded) {
    // Throw AFTER recording the failure event + (optional) APNs so the queue's
    // retry/dead-letter path engages on a genuine execution failure.
    throw new Error(`chat_core_v2_background_command_failed:${execution.reason ?? execution.status}`);
  }

  logger.info(
    {
      scope: 'chat_core_v2_background_command',
      jobId: job.jobId,
      commandId: command.commandId,
      outcome: 'verified',
      apnsPushed,
      escalationKeepAliveSeconds,
    },
    'chat_core_v2_background_command_executed',
  );
  return {
    outcome: 'verified',
    status: execution.status,
    finalState,
    apnsPushed,
    escalationKeepAliveSeconds,
  };
}

/**
 * The JobHandler registered with the event-backbone worker. Validates the
 * jobType matches before processing.
 */
export const chatCoreV2BackgroundCommandJobHandler: JobHandler = {
  jobType: CHAT_CORE_V2_BACKGROUND_COMMAND_JOB_TYPE,
  idempotent: true,
  async handle(job: JobRecord): Promise<void> {
    await processBackgroundChatCommandJob(job);
  },
};
