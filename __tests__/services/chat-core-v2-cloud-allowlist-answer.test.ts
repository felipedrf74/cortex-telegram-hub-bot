import { describe, expect, it, vi } from 'vitest';

import {
  buildCloudAllowlistAnswerPrompt,
  dispatchCloudAllowlistAnswer,
} from '../../src/services/chat-core-v2/cloud-allowlist-answer';
import type { CloudAllowlistPacket } from '../../src/services/chat-core-v2/cloud-allowlist-packet';

const SAFE_PACKET: CloudAllowlistPacket = {
  schemaVersion: 'cloud_allowlist_packet@1.0.0',
  intent: 'answer',
  capabilityId: 'chat.general_answer',
  domain: 'content',
  hmacEntityIds: [{ entityType: 'task', scopedEntityId: 'hmac:task:abc123abc123abc123abc123abc123ab' }],
  evidenceFingerprints: ['evidence:general-focus'],
  locale: 'pt-BR',
  complexityScore: 0.2,
  escalationReason: 'cloud_allowlist_candidate',
};

describe('ChatCoreV2 cloud allowlist answer dispatcher', () => {
  it('builds a packet-only cloud prompt without raw source identifiers', () => {
    const prompt = buildCloudAllowlistAnswerPrompt(SAFE_PACKET);

    expect(prompt).toContain('"schemaVersion":"cloud_allowlist_packet@1.0.0"');
    expect(prompt).toContain('Answer ONLY from this positive allowlist packet');
    expect(prompt).toContain('hmac:task:abc123abc123abc123abc123abc123ab');
    expect(prompt).not.toContain('raw-task-123');
    expect(prompt).not.toContain('Dá-me uma próxima ação pequena');
  });

  it('sends only the allowlist packet prompt to the selected cloud provider', async () => {
    const callDomain = vi.fn(async () => ({
      text: 'Preciso de mais contexto seguro para responder bem.',
      providerMetadata: { tokenCount: 12 },
    }));
    const provider = { name: 'gemini', callDomain } as never;
    const selectProvider = vi.fn(async () => ({
      rejected: false as const,
      provider,
      model: 'gemini-2.5-pro',
      privacyAction: 'sent_raw' as const,
    }));

    const result = await dispatchCloudAllowlistAnswer(SAFE_PACKET, {
      userId: 42,
      tenantId: 84,
      requestId: 'req-cloud',
      selectProvider,
    });

    expect(selectProvider).toHaveBeenCalledWith(expect.objectContaining({
      containsPrivateData: false,
      allowCloudEscalation: true,
      prompt: expect.stringContaining('"evidenceFingerprints":["evidence:general-focus"]'),
    }));
    expect(callDomain).toHaveBeenCalledWith(
      'content',
      [],
      expect.stringContaining('"capabilityId":"chat.general_answer"'),
      '',
      expect.objectContaining({
        modelOverride: 'gemini-2.5-pro',
        containsPrivateData: false,
        allowCloudEscalation: true,
        userId: 42,
        tenantId: 84,
      }),
    );
    expect(callDomain.mock.calls[0][2]).not.toContain('Dá-me uma próxima ação pequena');
    expect(result).toEqual({
      text: 'Preciso de mais contexto seguro para responder bem.',
      providerMetadata: expect.objectContaining({
        tokenCount: 12,
        providerUsed: 'gemini',
        modelUsed: 'gemini-2.5-pro',
        fallbackUsed: true,
        fallbackReason: 'local_queue_saturation',
        cloudAllowlistPrivacyAction: 'packet_only',
        requestId: 'req-cloud',
      }),
    });
    expect(result.providerMetadata).not.toHaveProperty('privacyAction');
  });

  it('removes provider privacyAction labels on the packet-only path', async () => {
    const callDomain = vi.fn(async () => ({
      text: 'Safe packet answer.',
      providerMetadata: {
        providerUsed: 'gemini',
        modelUsed: 'gemini-2.5-pro',
        fallbackUsed: false,
        privacyAction: 'sent_raw' as const,
      },
    }));
    const provider = { name: 'gemini', callDomain } as never;

    const result = await dispatchCloudAllowlistAnswer(SAFE_PACKET, {
      selectProvider: async () => ({
        rejected: false,
        provider,
        model: 'gemini-2.5-pro',
        privacyAction: 'sent_raw',
      }),
    });

    expect(result.providerMetadata).toEqual(expect.objectContaining({
      cloudAllowlistPrivacyAction: 'packet_only',
      fallbackReason: 'local_queue_saturation',
    }));
    expect(result.providerMetadata).not.toHaveProperty('privacyAction');
  });

  it('fails closed when the approved cloud reasoning gate rejects the packet prompt', async () => {
    await expect(dispatchCloudAllowlistAnswer(SAFE_PACKET, {
      selectProvider: async () => ({
        rejected: true,
        reason: 'disabled',
        warning: 'cloud_reasoning_fallback_disabled',
      }),
    })).rejects.toThrow('cloud_allowlist_answer_rejected:disabled:cloud_reasoning_fallback_disabled');
  });

  it('fails closed before provider selection when a caller supplies a malformed raw-looking packet', async () => {
    const selectProvider = vi.fn();
    await expect(dispatchCloudAllowlistAnswer({
      ...SAFE_PACKET,
      evidenceFingerprints: ['raw private calendar note for tomorrow'],
    }, { selectProvider })).rejects.toThrow('cloud_allowlist_answer_rejected:invalid_packet');

    expect(selectProvider).not.toHaveBeenCalled();
  });

  it('does not select or call a cloud provider after request cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const selectProvider = vi.fn();

    await expect(dispatchCloudAllowlistAnswer(SAFE_PACKET, {
      abortSignal: controller.signal,
      selectProvider,
    })).rejects.toMatchObject({
      name: 'AbortError',
      code: 'CHAT_REQUEST_CANCELLED',
    });

    expect(selectProvider).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after provider selection and before the paid call', async () => {
    const controller = new AbortController();
    const callDomain = vi.fn();
    const provider = { name: 'gemini', callDomain } as never;

    await expect(dispatchCloudAllowlistAnswer(SAFE_PACKET, {
      abortSignal: controller.signal,
      selectProvider: async () => {
        controller.abort();
        return {
          rejected: false,
          provider,
          model: 'gemini-2.5-pro',
          privacyAction: 'sent_raw',
        };
      },
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(callDomain).not.toHaveBeenCalled();
  });
});
