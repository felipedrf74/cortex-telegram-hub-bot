// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2ActivationConfig } from './activation-flags';
import type { CloudAllowlistDenialReason, CloudAllowlistPacketResult } from './cloud-allowlist-packet';

export type ChatCoreV2QueueFallbackMode =
  | 'off'
  | 'cloud_allowlist'
  | 'background'
  | 'fail_visible';

export type ChatCoreV2QueueFallbackDecisionKind =
  | 'use_local_now'
  | 'wait_for_local'
  | 'use_cloud_allowlist'
  | 'start_background'
  | 'fail_visible';

export interface ChatCoreV2LocalQueueSnapshot {
  activeCount: number;
  queuedCount: number;
  maxConcurrency: number;
  estimatedWaitMs?: number;
}

export interface ChatCoreV2QueueFallbackPolicy {
  mode: ChatCoreV2QueueFallbackMode;
  cloudAfterQueuedCount: number;
  cloudAfterWaitMs: number;
}

export interface ChatCoreV2QueueFallbackDecision {
  kind: ChatCoreV2QueueFallbackDecisionKind;
  reasonCode:
    | 'local_slot_available'
    | 'queue_below_threshold'
    | 'queue_fallback_disabled'
    | 'cloud_fallback_disabled'
    | 'cloud_allowlist_packet_safe'
    | 'cloud_allowlist_denied'
    | 'background_allowed'
    | 'background_not_allowed'
    | 'fail_visible_configured';
  cloudDenialReason?: CloudAllowlistDenialReason;
}

type EnvLike = Record<string, string | undefined>;

export function resolveChatCoreV2QueueFallbackPolicy(
  env: EnvLike = process.env,
): ChatCoreV2QueueFallbackPolicy {
  return {
    mode: parseMode(env.CHAT_CORE_V2_QUEUE_FALLBACK_MODE),
    cloudAfterQueuedCount: parseNonNegativeInt(env.CHAT_CORE_V2_QUEUE_CLOUD_AFTER_QUEUED_COUNT, 1),
    cloudAfterWaitMs: parsePositiveInt(env.CHAT_CORE_V2_QUEUE_CLOUD_AFTER_WAIT_MS, 5_000),
  };
}

export function evaluateChatCoreV2QueueFallback(input: {
  activation: Pick<ChatCoreV2ActivationConfig, 'allowCloudFallback'>;
  queue: ChatCoreV2LocalQueueSnapshot;
  policy?: ChatCoreV2QueueFallbackPolicy;
  cloudPacket?: CloudAllowlistPacketResult | null;
  requestAllowsBackground?: boolean;
}): ChatCoreV2QueueFallbackDecision {
  if (input.queue.activeCount < input.queue.maxConcurrency && input.queue.queuedCount === 0) {
    return { kind: 'use_local_now', reasonCode: 'local_slot_available' };
  }

  const policy = input.policy ?? resolveChatCoreV2QueueFallbackPolicy();
  const queuePressure =
    input.queue.queuedCount >= policy.cloudAfterQueuedCount
    || (input.queue.estimatedWaitMs ?? 0) >= policy.cloudAfterWaitMs;

  if (!queuePressure) {
    return { kind: 'wait_for_local', reasonCode: 'queue_below_threshold' };
  }

  if (policy.mode === 'off') {
    return { kind: 'wait_for_local', reasonCode: 'queue_fallback_disabled' };
  }

  if (policy.mode === 'background') {
    return backgroundDecision(input.requestAllowsBackground);
  }

  if (policy.mode === 'fail_visible') {
    return { kind: 'fail_visible', reasonCode: 'fail_visible_configured' };
  }

  if (!input.activation.allowCloudFallback) {
    return { kind: 'wait_for_local', reasonCode: 'cloud_fallback_disabled' };
  }

  if (input.cloudPacket?.ok) {
    return { kind: 'use_cloud_allowlist', reasonCode: 'cloud_allowlist_packet_safe' };
  }

  if (input.requestAllowsBackground) {
    return {
      kind: 'start_background',
      reasonCode: 'cloud_allowlist_denied',
      cloudDenialReason: input.cloudPacket?.ok === false ? input.cloudPacket.denialReason : undefined,
    };
  }

  return {
    kind: 'wait_for_local',
    reasonCode: 'cloud_allowlist_denied',
    cloudDenialReason: input.cloudPacket?.ok === false ? input.cloudPacket.denialReason : undefined,
  };
}

function backgroundDecision(requestAllowsBackground: boolean | undefined): ChatCoreV2QueueFallbackDecision {
  if (requestAllowsBackground) {
    return { kind: 'start_background', reasonCode: 'background_allowed' };
  }
  return { kind: 'wait_for_local', reasonCode: 'background_not_allowed' };
}

function parseMode(raw: string | undefined): ChatCoreV2QueueFallbackMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'cloud_allowlist' || value === 'background' || value === 'fail_visible') return value;
  return 'off';
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
