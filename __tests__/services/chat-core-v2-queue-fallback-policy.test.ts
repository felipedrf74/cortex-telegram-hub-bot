import { describe, expect, it } from 'vitest';

import {
  evaluateChatCoreV2QueueFallback,
  resolveChatCoreV2QueueFallbackPolicy,
} from '../../src/services/chat-core-v2/queue-fallback-policy';

const ACTIVATION_CLOUD_ON = { allowCloudFallback: true };
const ACTIVATION_CLOUD_OFF = { allowCloudFallback: false };

const SAFE_CLOUD_PACKET = {
  ok: true as const,
  packet: {
    schemaVersion: 'cloud_allowlist_packet@1.0.0' as const,
    intent: 'answer' as const,
    capabilityId: 'chat.general_answer',
    domain: 'content' as const,
    hmacEntityIds: [],
    evidenceFingerprints: ['evidence:abc123'],
    locale: 'pt-BR',
    complexityScore: 0.2,
    escalationReason: 'cloud_allowlist_candidate' as const,
  },
};

describe('ChatCoreV2 queue fallback policy', () => {
  it('defaults off so local queue pressure waits for local instead of silently using cloud', () => {
    expect(resolveChatCoreV2QueueFallbackPolicy({})).toEqual({
      mode: 'off',
      cloudAfterQueuedCount: 1,
      cloudAfterWaitMs: 5000,
    });

    expect(evaluateChatCoreV2QueueFallback({
      activation: ACTIVATION_CLOUD_ON,
      queue: { activeCount: 1, queuedCount: 2, maxConcurrency: 1 },
      cloudPacket: SAFE_CLOUD_PACKET,
    })).toEqual({
      kind: 'wait_for_local',
      reasonCode: 'queue_fallback_disabled',
    });
  });

  it('uses local immediately when a slot is available', () => {
    expect(evaluateChatCoreV2QueueFallback({
      activation: ACTIVATION_CLOUD_ON,
      queue: { activeCount: 0, queuedCount: 0, maxConcurrency: 1 },
      policy: { mode: 'cloud_allowlist', cloudAfterQueuedCount: 1, cloudAfterWaitMs: 5000 },
      cloudPacket: SAFE_CLOUD_PACKET,
    })).toEqual({
      kind: 'use_local_now',
      reasonCode: 'local_slot_available',
    });
  });

  it('does not cloud-escalate below the queue threshold', () => {
    expect(evaluateChatCoreV2QueueFallback({
      activation: ACTIVATION_CLOUD_ON,
      queue: { activeCount: 1, queuedCount: 0, maxConcurrency: 1, estimatedWaitMs: 1000 },
      policy: { mode: 'cloud_allowlist', cloudAfterQueuedCount: 2, cloudAfterWaitMs: 5000 },
      cloudPacket: SAFE_CLOUD_PACKET,
    })).toEqual({
      kind: 'wait_for_local',
      reasonCode: 'queue_below_threshold',
    });
  });

  it('treats estimated queue wait as pressure even when queued count is below threshold', () => {
    expect(evaluateChatCoreV2QueueFallback({
      activation: ACTIVATION_CLOUD_ON,
      queue: { activeCount: 1, queuedCount: 0, maxConcurrency: 1, estimatedWaitMs: 6000 },
      policy: { mode: 'fail_visible', cloudAfterQueuedCount: 5, cloudAfterWaitMs: 5000 },
      cloudPacket: SAFE_CLOUD_PACKET,
    })).toEqual({
      kind: 'fail_visible',
      reasonCode: 'fail_visible_configured',
    });
  });

  it('uses cloud only when activation permits cloud and the packet is positive-allowlist safe', () => {
    expect(evaluateChatCoreV2QueueFallback({
      activation: ACTIVATION_CLOUD_ON,
      queue: { activeCount: 1, queuedCount: 1, maxConcurrency: 1 },
      policy: { mode: 'cloud_allowlist', cloudAfterQueuedCount: 1, cloudAfterWaitMs: 5000 },
      cloudPacket: SAFE_CLOUD_PACKET,
    })).toEqual({
      kind: 'use_cloud_allowlist',
      reasonCode: 'cloud_allowlist_packet_safe',
    });
  });

  it('refuses cloud escalation when the master activation cloud flag is off', () => {
    expect(evaluateChatCoreV2QueueFallback({
      activation: ACTIVATION_CLOUD_OFF,
      queue: { activeCount: 1, queuedCount: 1, maxConcurrency: 1 },
      policy: { mode: 'cloud_allowlist', cloudAfterQueuedCount: 1, cloudAfterWaitMs: 5000 },
      cloudPacket: SAFE_CLOUD_PACKET,
    })).toEqual({
      kind: 'wait_for_local',
      reasonCode: 'cloud_fallback_disabled',
    });
  });

  it('starts background instead of widening cloud context when the allowlist packet is denied', () => {
    expect(evaluateChatCoreV2QueueFallback({
      activation: ACTIVATION_CLOUD_ON,
      queue: { activeCount: 1, queuedCount: 1, maxConcurrency: 1 },
      policy: { mode: 'cloud_allowlist', cloudAfterQueuedCount: 1, cloudAfterWaitMs: 5000 },
      requestAllowsBackground: true,
      cloudPacket: { ok: false, denialReason: 'required_fact_never_cloud' },
    })).toEqual({
      kind: 'start_background',
      reasonCode: 'cloud_allowlist_denied',
      cloudDenialReason: 'required_fact_never_cloud',
    });
  });

  it('waits for local when cloud packet is denied and background is unavailable', () => {
    expect(evaluateChatCoreV2QueueFallback({
      activation: ACTIVATION_CLOUD_ON,
      queue: { activeCount: 1, queuedCount: 1, maxConcurrency: 1 },
      policy: { mode: 'cloud_allowlist', cloudAfterQueuedCount: 1, cloudAfterWaitMs: 5000 },
      requestAllowsBackground: false,
      cloudPacket: { ok: false, denialReason: 'insufficient_safe_context_for_cloud' },
    })).toEqual({
      kind: 'wait_for_local',
      reasonCode: 'cloud_allowlist_denied',
      cloudDenialReason: 'insufficient_safe_context_for_cloud',
    });
  });

  it('fails closed when cloud allowlist mode is configured but the caller omits a packet', () => {
    expect(evaluateChatCoreV2QueueFallback({
      activation: ACTIVATION_CLOUD_ON,
      queue: { activeCount: 1, queuedCount: 1, maxConcurrency: 1 },
      policy: { mode: 'cloud_allowlist', cloudAfterQueuedCount: 1, cloudAfterWaitMs: 5000 },
      requestAllowsBackground: false,
      cloudPacket: null,
    })).toEqual({
      kind: 'wait_for_local',
      reasonCode: 'cloud_allowlist_denied',
      cloudDenialReason: undefined,
    });
  });

  it('supports explicit background-only and visible-fail modes for queue pressure', () => {
    expect(evaluateChatCoreV2QueueFallback({
      activation: ACTIVATION_CLOUD_ON,
      queue: { activeCount: 1, queuedCount: 3, maxConcurrency: 1 },
      policy: { mode: 'background', cloudAfterQueuedCount: 1, cloudAfterWaitMs: 5000 },
      requestAllowsBackground: true,
    })).toEqual({
      kind: 'start_background',
      reasonCode: 'background_allowed',
    });

    expect(evaluateChatCoreV2QueueFallback({
      activation: ACTIVATION_CLOUD_ON,
      queue: { activeCount: 1, queuedCount: 3, maxConcurrency: 1 },
      policy: { mode: 'fail_visible', cloudAfterQueuedCount: 1, cloudAfterWaitMs: 5000 },
      requestAllowsBackground: true,
    })).toEqual({
      kind: 'fail_visible',
      reasonCode: 'fail_visible_configured',
    });
  });

  it('waits for local when background mode is configured but the request cannot run in background', () => {
    expect(evaluateChatCoreV2QueueFallback({
      activation: ACTIVATION_CLOUD_ON,
      queue: { activeCount: 1, queuedCount: 3, maxConcurrency: 1 },
      policy: { mode: 'background', cloudAfterQueuedCount: 1, cloudAfterWaitMs: 5000 },
      requestAllowsBackground: false,
    })).toEqual({
      kind: 'wait_for_local',
      reasonCode: 'background_not_allowed',
    });
  });
});
