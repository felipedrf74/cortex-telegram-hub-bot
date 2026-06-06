import { describe, expect, it } from 'vitest';

import { buildLocalChatCloudAllowlistPacket } from '../../src/services/chat-core-v2/cloud-allowlist-answer-packet';

const SAFE_ENV = {
  CHAT_CORE_V2_CLOUD_ALLOWLIST_PACKET_PRODUCER_ENABLED: 'true',
  CHAT_CORE_V2_CLOUD_ALLOWLIST_BUDGET_AVAILABLE: 'true',
  CHAT_CORE_V2_CLOUD_ALLOWLIST_HMAC_SECRET: 'test-cloud-allowlist-secret',
};

describe('ChatCoreV2 cloud allowlist answer packet producer', () => {
  it('is disabled by default', () => {
    expect(buildLocalChatCloudAllowlistPacket({
      normalizedText: 'Dá-me um próximo passo pequeno para hoje.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-default-disabled',
      locale: 'pt-BR',
      env: {},
    })).toEqual({ ok: false, denialReason: 'cloud_provider_disabled' });
  });

  it('builds a HMAC-only packet for safe generic answer categories', () => {
    const result = buildLocalChatCloudAllowlistPacket({
      normalizedText: 'Dá-me um próximo passo pequeno para hoje.',
      userId: 42,
      tenantId: 84,
      requestId: 'req-safe-public',
      locale: 'pt-BR',
      env: SAFE_ENV,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected positive allowlist packet');
    expect(result.packet).toEqual(expect.objectContaining({
      intent: 'answer',
      capabilityId: 'chat.general_next_step',
      domain: 'content',
      locale: 'pt-BR',
      escalationReason: 'cloud_allowlist_candidate',
    }));
    expect(result.packet.hmacEntityIds[0]?.scopedEntityId).toMatch(/^hmac:turn:[a-f0-9]{32}$/);
    expect(result.packet.evidenceFingerprints[0]).toMatch(/^hmac:evidence:local_chat_safe_answer_profile:[a-f0-9]{32}$/);
    expect(JSON.stringify(result.packet)).not.toContain('Dá-me');
    expect(JSON.stringify(result.packet)).not.toContain('próximo passo');
    expect(JSON.stringify(result.packet)).not.toContain('req-safe-public');
  });

  it('denies private or app-state requests instead of summarizing them', () => {
    const result = buildLocalChatCloudAllowlistPacket({
      normalizedText: 'O que tenho na agenda hoje e marca a tarefa comprar suplementos como feita?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-private-app-state',
      locale: 'pt-BR',
      env: SAFE_ENV,
    });

    expect(result).toEqual({ ok: false, denialReason: 'insufficient_safe_context_for_cloud' });
  });

  it('requires an explicit HMAC secret and budget flag', () => {
    expect(buildLocalChatCloudAllowlistPacket({
      normalizedText: 'How do I improve focus?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-no-secret',
      locale: 'en',
      env: {
        CHAT_CORE_V2_CLOUD_ALLOWLIST_PACKET_PRODUCER_ENABLED: 'true',
        CHAT_CORE_V2_CLOUD_ALLOWLIST_BUDGET_AVAILABLE: 'true',
      },
    })).toEqual({ ok: false, denialReason: 'insufficient_safe_context_for_cloud' });

    expect(buildLocalChatCloudAllowlistPacket({
      normalizedText: 'How do I improve focus?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-no-budget',
      locale: 'en',
      env: {
        CHAT_CORE_V2_CLOUD_ALLOWLIST_PACKET_PRODUCER_ENABLED: 'true',
        CHAT_CORE_V2_CLOUD_ALLOWLIST_HMAC_SECRET: 'test-cloud-allowlist-secret',
      },
    })).toEqual({ ok: false, denialReason: 'cloud_budget_exceeded' });
  });

  it('denies sensitive personal/medical/legal-distress topics instead of cloud-escalating them', () => {
    // These slip past the generic advice buckets (next step / focus / strategy)
    // but must fail closed to local: per the deny-when-uncertain doctrine,
    // sensitive personal topics are never cloud-escalation candidates.
    const sensitiveCases = [
      'What is the next step after my cancer diagnosis?',
      'Tips for talking to my therapist about my anxiety',
      'How to focus despite my divorce',
      'preciso de um proximo passo depois do meu diagnostico de depressao',
    ];
    for (const normalizedText of sensitiveCases) {
      expect(buildLocalChatCloudAllowlistPacket({
        normalizedText,
        userId: 42,
        tenantId: 84,
        requestId: 'req-sensitive',
        locale: 'en',
        env: SAFE_ENV,
      })).toEqual({ ok: false, denialReason: 'insufficient_safe_context_for_cloud' });
    }
  });
});
