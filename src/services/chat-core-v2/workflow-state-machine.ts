// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { VerificationMode, WorkflowStatus } from './types';

export const CHAT_CORE_V2_WORKFLOW_STATE_MACHINE_VERSION = 'chat_core_v2_workflow_state_machine@1.0.0';

export type ChatCoreV2WorkflowEvent =
  | 'preview_created'
  | 'user_confirmation_requested'
  | 'user_confirmed'
  | 'human_review_requested'
  | 'human_review_approved'
  | 'queued'
  | 'started'
  | 'external_wait_started'
  | 'external_wait_resolved'
  | 'verification_started'
  | 'verification_succeeded'
  | 'partially_completed'
  | 'failed'
  | 'retry_scheduled'
  | 'retry_started'
  | 'cancelled'
  | 'expired'
  | 'timed_out';

export type WorkflowTransitionRejectionReason =
  | 'terminal_state'
  | 'unsupported_transition'
  | 'human_review_required'
  | 'verification_required';

export interface WorkflowTransitionPolicy {
  requiresHumanReview?: boolean;
  verificationMode?: VerificationMode;
}

export interface WorkflowTransitionVerdict {
  allowed: boolean;
  stateMachineVersion: string;
  from: WorkflowStatus;
  event: ChatCoreV2WorkflowEvent;
  to?: WorkflowStatus;
  reason?: WorkflowTransitionRejectionReason;
}

const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowStatus> = new Set([
  'completed',
  'partially_completed',
  'failed',
  'timed_out',
  'cancelled',
  'expired',
]);

const BASE_TRANSITIONS: Record<WorkflowStatus, Partial<Record<ChatCoreV2WorkflowEvent, WorkflowStatus>>> = {
  draft: {
    preview_created: 'previewed',
    human_review_requested: 'awaiting_human_review',
    cancelled: 'cancelled',
    expired: 'expired',
  },
  previewed: {
    user_confirmation_requested: 'awaiting_user_confirmation',
    user_confirmed: 'queued',
    human_review_requested: 'awaiting_human_review',
    cancelled: 'cancelled',
    expired: 'expired',
  },
  awaiting_user_confirmation: {
    user_confirmed: 'queued',
    human_review_requested: 'awaiting_human_review',
    cancelled: 'cancelled',
    expired: 'expired',
    timed_out: 'timed_out',
  },
  awaiting_human_review: {
    human_review_approved: 'queued',
    cancelled: 'cancelled',
    expired: 'expired',
    timed_out: 'timed_out',
    failed: 'failed',
  },
  queued: {
    started: 'running',
    cancelled: 'cancelled',
    expired: 'expired',
    timed_out: 'timed_out',
  },
  running: {
    external_wait_started: 'waiting_external_provider',
    verification_started: 'verification_pending',
    verification_succeeded: 'completed',
    partially_completed: 'partially_completed',
    retry_scheduled: 'retrying',
    failed: 'failed',
    timed_out: 'timed_out',
    cancelled: 'cancelled',
  },
  retrying: {
    retry_started: 'running',
    failed: 'failed',
    timed_out: 'timed_out',
    cancelled: 'cancelled',
  },
  waiting_external_provider: {
    external_wait_resolved: 'running',
    verification_started: 'verification_pending',
    retry_scheduled: 'retrying',
    failed: 'failed',
    timed_out: 'timed_out',
    cancelled: 'cancelled',
  },
  verification_pending: {
    verification_succeeded: 'completed',
    partially_completed: 'partially_completed',
    retry_scheduled: 'retrying',
    failed: 'failed',
    timed_out: 'timed_out',
    cancelled: 'cancelled',
  },
  completed: {},
  partially_completed: {},
  failed: {},
  timed_out: {},
  cancelled: {},
  expired: {},
};

export function evaluateWorkflowTransition(
  from: WorkflowStatus,
  event: ChatCoreV2WorkflowEvent,
  policy: WorkflowTransitionPolicy = {},
): WorkflowTransitionVerdict {
  if (TERMINAL_WORKFLOW_STATUSES.has(from)) {
    return rejected(from, event, 'terminal_state');
  }

  if (policy.requiresHumanReview && event === 'user_confirmed') {
    return rejected(from, event, 'human_review_required');
  }

  const to = BASE_TRANSITIONS[from]?.[event];
  if (!to) {
    return rejected(from, event, 'unsupported_transition');
  }

  if (to === 'completed' && policy.verificationMode && policy.verificationMode !== 'not_verifiable') {
    if (from !== 'verification_pending') {
      return rejected(from, event, 'verification_required');
    }
  }

  return {
    allowed: true,
    stateMachineVersion: CHAT_CORE_V2_WORKFLOW_STATE_MACHINE_VERSION,
    from,
    event,
    to,
  };
}

export function applyWorkflowTransition(
  from: WorkflowStatus,
  event: ChatCoreV2WorkflowEvent,
  policy: WorkflowTransitionPolicy = {},
): WorkflowStatus {
  const verdict = evaluateWorkflowTransition(from, event, policy);
  if (!verdict.allowed || !verdict.to) {
    throw new Error(`Unsupported Chat Core v2 workflow transition: ${from} -> ${event}`);
  }
  return verdict.to;
}

export function listAllowedWorkflowEvents(
  from: WorkflowStatus,
  policy: WorkflowTransitionPolicy = {},
): ChatCoreV2WorkflowEvent[] {
  return (Object.keys(BASE_TRANSITIONS[from] ?? {}) as ChatCoreV2WorkflowEvent[])
    .filter((event) => evaluateWorkflowTransition(from, event, policy).allowed);
}

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return TERMINAL_WORKFLOW_STATUSES.has(status);
}

function rejected(
  from: WorkflowStatus,
  event: ChatCoreV2WorkflowEvent,
  reason: WorkflowTransitionRejectionReason,
): WorkflowTransitionVerdict {
  return {
    allowed: false,
    stateMachineVersion: CHAT_CORE_V2_WORKFLOW_STATE_MACHINE_VERSION,
    from,
    event,
    reason,
  };
}
