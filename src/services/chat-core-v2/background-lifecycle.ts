// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

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
