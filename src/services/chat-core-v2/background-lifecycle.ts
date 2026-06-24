// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { enqueueJob, type JobRecord } from '../background-job-queue';
import { isValidTenantUserId } from '../tenant-scope-observability';
import {
  isChatCoreV2MasterKillSwitchOff,
  resolveChatCoreV2ActivationConfig,
} from './activation-flags';
import { isExecutableCommandType } from './command-executor';
import type { AICommandEnvelope } from './types';

export type ChatCoreV2BackgroundJobState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'abandoned'
  | 'superseded'
  | 'expired'
  | 'failed';

export type ChatCoreV2BackgroundJobType =
  | 'planner_escalation'
  | 'composer'
  | 'critic'
  | 'script_generation'
  | 'plan_repair';

export interface ChatCoreV2BackgroundJob {
  jobId: string;
  turnId: string;
  tenantId: string;
  userId: string;
  contextHash: string;
  jobType: ChatCoreV2BackgroundJobType;
  state: ChatCoreV2BackgroundJobState;
  startedAt: string;
  expiresAt: string;
  abortToken: string;
  notificationPolicy: 'apns' | 'silent';
  resumeDeepLink: string;
}

const VALID_TRANSITIONS: Record<ChatCoreV2BackgroundJobState, ReadonlySet<ChatCoreV2BackgroundJobState>> = {
  pending: new Set(['running', 'cancelled', 'superseded', 'expired', 'failed']),
  running: new Set(['completed', 'cancelled', 'abandoned', 'superseded', 'expired', 'failed']),
  completed: new Set(),
  cancelled: new Set(),
  abandoned: new Set(),
  superseded: new Set(),
  expired: new Set(),
  failed: new Set(),
};

export function canTransitionBackgroundJob(
  from: ChatCoreV2BackgroundJobState,
  to: ChatCoreV2BackgroundJobState,
): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

export function backgroundJobRequiresAbortSignal(state: ChatCoreV2BackgroundJobState): boolean {
  return state === 'cancelled' || state === 'superseded' || state === 'expired';
}

// ─── WP-15: background write-command enqueue ────────────────────────────────

/**
 * The single SQLite job-queue jobType used for background-executed chat write
 * commands. The generic `background_jobs` queue is keyed by a free-form string
 * jobType; the worker (event-backbone-worker) registers a handler for exactly
 * this jobType.
 */
export const CHAT_CORE_V2_BACKGROUND_COMMAND_JOB_TYPE = 'chat_core_v2_background_command';

/**
 * The chat-command lifecycle jobTypes that are allowed to be enqueued for
 * background WRITE execution. `'critic'` is a valid `ChatCoreV2BackgroundJobType`
 * (so the type system will NOT reject it), but the critic is an internal
 * reasoning stage, not an executable write command — §5.E requires a HAND-WRITTEN
 * runtime guard that restricts the chat-command jobType to exactly
 * `{planner_escalation, composer}` and rejects everything else (including
 * `'critic'`) at runtime.
 */
const ALLOWED_BACKGROUND_COMMAND_JOB_TYPES: ReadonlySet<ChatCoreV2BackgroundJobType> = new Set([
  'planner_escalation',
  'composer',
]);

/**
 * Runtime guard (§5.E). Returns true only for the two executable chat-command
 * jobTypes. `'critic'` (and `script_generation`/`plan_repair`) are rejected here
 * even though the TS type would accept them.
 */
export function isExecutableBackgroundCommandJobType(
  jobType: ChatCoreV2BackgroundJobType,
): boolean {
  return ALLOWED_BACKGROUND_COMMAND_JOB_TYPES.has(jobType);
}

export type ChatCoreV2BackgroundCommandEnqueueRefusal =
  | 'write_execution_disabled'
  | 'mode_not_canary_or_on'
  | 'tenant_kill_switch'
  | 'invalid_job_type'
  | 'unexecutable_command_type'
  | 'invalid_tenant_scope';

export class ChatCoreV2BackgroundCommandEnqueueError extends Error {
  readonly refusal: ChatCoreV2BackgroundCommandEnqueueRefusal;
  constructor(refusal: ChatCoreV2BackgroundCommandEnqueueRefusal) {
    super(`chat_core_v2_background_command_enqueue_refused:${refusal}`);
    this.name = 'ChatCoreV2BackgroundCommandEnqueueError';
    this.refusal = refusal;
  }
}

/**
 * The JSON-serializable payload persisted on the `background_jobs` row for a
 * queued chat write command. Everything the worker needs to reconstruct and
 * execute the command lives here. `tenantId`/`userId` are carried as STRING to
 * match `ChatCoreV2BackgroundJob` (§5.E crossing 1) and the command envelope's
 * own string ids; the worker converts them to NUMBER at the executor boundary.
 */
export interface ChatCoreV2BackgroundCommandJobPayload {
  jobType: ChatCoreV2BackgroundJobType;
  capabilityId: string;
  /** String ids (background-lifecycle / command-envelope convention). */
  tenantId: string;
  userId: string;
  turnId: string;
  contextHash: string;
  notificationPolicy: 'apns' | 'silent';
  resumeDeepLink: string;
  expiresAt: string;
  locale: string | null;
  /** The full, JSON-serializable command envelope. */
  command: AICommandEnvelope<Record<string, unknown>>;
}

/**
 * Pure, default-off predicate the live route consults BEFORE attempting to
 * background-queue a resolved write command. Returns true only when ALL enqueue
 * preconditions hold for this tenant — write execution enabled, mode in
 * {canary,on}, and NOT per-tenant killed. With the default env (write execution
 * off) this is always false, so the route never reaches the queue path and the
 * existing synchronous behavior is unchanged (chat-routes 101 stay green).
 *
 * This is intentionally conservative: it only governs WHETHER the route is even
 * allowed to consider backgrounding. `enqueueBackgroundChatCommand` re-checks the
 * same kill-switch and is the authoritative gate (it throws if anything is off).
 */
export function shouldBackgroundQueueChatCoreV2Command(input: {
  tenantId: number;
  jobType: ChatCoreV2BackgroundJobType;
  env?: Record<string, string | undefined>;
}): boolean {
  const env = input.env ?? process.env;
  if (!resolveChatCoreV2ActivationConfig(env).allowWriteExecution) return false;
  const mode = resolveChatCoreV2ActivationConfig(env).mode;
  if (mode !== 'canary' && mode !== 'on') return false;
  if (isChatCoreV2MasterKillSwitchOff(env, String(input.tenantId))) return false;
  return isExecutableBackgroundCommandJobType(input.jobType);
}

export interface EnqueueBackgroundChatCommandInput {
  /** Tenant id as a NUMBER (the live route's authenticated scope). */
  tenantId: number;
  /** User id as a NUMBER (the live route's authenticated scope). */
  userId: number;
  jobType: ChatCoreV2BackgroundJobType;
  capabilityId: string;
  command: AICommandEnvelope<Record<string, unknown>>;
  turnId: string;
  notificationPolicy?: 'apns' | 'silent';
  resumeDeepLink?: string;
  locale?: string | null;
  env?: Record<string, string | undefined>;
  db?: Database.Database;
}

/**
 * Enqueue a chat write command for background execution (WP-15).
 *
 * DEFAULT-OFF KILL SWITCH — refuses (throws) unless ALL of:
 *   (a) `CHAT_CORE_V2_ALLOW_WRITE_EXECUTION` is true (via
 *       `resolveChatCoreV2ActivationConfig(env).allowWriteExecution`); AND
 *   (b) the orchestrator mode is in `{canary, on}`; AND
 *   (c) NOT `isChatCoreV2MasterKillSwitchOff(env, String(tenantId))` — so a WP-07
 *       per-tenant auto-revert override flip (force off/shadow for THIS tenant)
 *       actually STOPS enqueue for that tenant without a restart.
 *
 * With the default env (write execution off) this is fully INERT: the function
 * throws before touching the queue, so nothing is enqueued.
 *
 * §5.E TYPE BOUNDARY — crossing 2 (enqueueJob): `JobInput.tenantId` is NUMBER and
 * `userId` is number|null, positive-integer validated. We pass the validated
 * NUMBER ids here and persist the STRING ids in the payload (matching the
 * `ChatCoreV2BackgroundJob` convention) for the worker to convert back.
 *
 * §5.E jobType runtime guard — rejects `'critic'` (and any non-executable
 * jobType) at runtime even though the TS type accepts it.
 */
export function enqueueBackgroundChatCommand(
  input: EnqueueBackgroundChatCommandInput,
): JobRecord {
  const env = input.env ?? process.env;

  // ── Kill switch (default-off + per-tenant). Order matters only for the
  // refusal reason; any one failing condition refuses the enqueue. ──
  if (!resolveChatCoreV2ActivationConfig(env).allowWriteExecution) {
    throw new ChatCoreV2BackgroundCommandEnqueueError('write_execution_disabled');
  }
  const mode = resolveChatCoreV2ActivationConfig(env).mode;
  if (mode !== 'canary' && mode !== 'on') {
    throw new ChatCoreV2BackgroundCommandEnqueueError('mode_not_canary_or_on');
  }
  // §5.E crossing: the master kill-switch Map is keyed by STRING tenantId.
  if (isChatCoreV2MasterKillSwitchOff(env, String(input.tenantId))) {
    throw new ChatCoreV2BackgroundCommandEnqueueError('tenant_kill_switch');
  }

  // ── jobType runtime guard (§5.E): reject 'critic' et al. ──
  if (!isExecutableBackgroundCommandJobType(input.jobType)) {
    throw new ChatCoreV2BackgroundCommandEnqueueError('invalid_job_type');
  }

  // ── Only the four sync write command types may be enqueued. ──
  if (!isExecutableCommandType(input.command.commandType)) {
    throw new ChatCoreV2BackgroundCommandEnqueueError('unexecutable_command_type');
  }

  // ── Scope validation (positive-int) before we hand NUMBER ids to enqueueJob. ──
  if (!isValidTenantUserId(input.tenantId) || !isValidTenantUserId(input.userId)) {
    throw new ChatCoreV2BackgroundCommandEnqueueError('invalid_tenant_scope');
  }

  const notificationPolicy = input.notificationPolicy ?? 'apns';
  const payload: ChatCoreV2BackgroundCommandJobPayload = {
    jobType: input.jobType,
    capabilityId: input.capabilityId,
    // §5.E crossing 1: ChatCoreV2BackgroundJob ids are STRING — store explicitly.
    tenantId: String(input.tenantId),
    userId: String(input.userId),
    turnId: input.turnId,
    contextHash: input.command.basedOn.contextHash,
    notificationPolicy,
    resumeDeepLink: input.resumeDeepLink ?? `nexus://chat/turn/${input.turnId}`,
    expiresAt: input.command.expiresAt,
    locale: input.locale ?? null,
    command: input.command,
  };

  // §5.E crossing 2: enqueueJob/JobInput ids are NUMBER (positive-int validated
  // inside enqueueJob via isValidTenantUserId). Pass explicit NUMBER ids.
  return enqueueJob(
    {
      tenantId: Number(input.tenantId),
      userId: Number(input.userId),
      jobType: CHAT_CORE_V2_BACKGROUND_COMMAND_JOB_TYPE,
      payload: payload as unknown as Record<string, unknown>,
      priority: 40,
      idempotencyKey: `chat_core_v2_command:${input.command.commandId}`,
      correlationId: input.turnId,
    },
    input.db,
  );
}
