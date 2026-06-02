// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildChatCloudAllowlistPacket,
  buildChatCloudAllowlistPacketSample,
  countRawPrivateCloudFields,
  validateChatCloudAllowlistPacket,
} from '../../src/services/chat-cloud-allowlist-packet';
import { evaluateChatCloudAllowlistReadiness } from '../../src/services/chat-cloud-allowlist-readiness';

describe('chat-cloud-allowlist-packet', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CHAT_V2_CLOUD_ALLOWLIST_HMAC_SECRET', 'test-cloud-packet-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds packet-only cloud context with HMAC identifiers and no raw private fields', () => {
    const result = buildChatCloudAllowlistPacket({
      intent: 'answer',
      domain: 'cooking',
      capabilityId: 'cooking.recipe_answer',
      locale: 'pt-BR',
      complexityScore: 0.72,
      escalationReason: 'local_queue_saturation',
      entityRefs: [{ kind: 'recipe', stableId: 'private-recipe-id-123' }],
      evidenceRefs: [{ kind: 'turn', stableId: 'raw phrase that must not appear' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected allowlist packet');
    expect(JSON.stringify(result.packet)).not.toContain('private-recipe-id-123');
    expect(JSON.stringify(result.packet)).not.toContain('raw phrase that must not appear');
    expect(result.packet.anonymizedEntityIds).toEqual([expect.stringMatching(/^hmac:entity:[a-f0-9]{64}$/)]);
    expect(result.packet.evidenceFingerprints).toEqual([expect.stringMatching(/^hmac:evidence:[a-f0-9]{64}$/)]);
    expect(countRawPrivateCloudFields(result.packet)).toBe(0);

    const sample = buildChatCloudAllowlistPacketSample({
      sampleId: 'sample-cloud',
      result,
      sentToCloud: true,
    });
    expect(sample).toMatchObject({
      sentToCloud: true,
      rawPrivateFieldCount: 0,
      denied: false,
      hmacEntityIdCount: 1,
      nonHmacEntityIdCount: 0,
      hmacEvidenceFingerprintCount: 1,
      nonHmacEvidenceFingerprintCount: 0,
    });
  });

  it('denies cloud packets when required facts are never-cloud or safe context is empty', () => {
    expect(buildChatCloudAllowlistPacket({
      intent: 'answer',
      domain: 'finance_education',
      capabilityId: 'finance.education',
      locale: 'en',
      complexityScore: 0.4,
      escalationReason: 'local_queue_saturation',
      evidenceRefs: [{ kind: 'policy', stableId: 'public-policy' }],
      requiredFactsNeverCloud: true,
    })).toEqual({ ok: false, denialReason: 'required_fact_never_cloud' });

    expect(buildChatCloudAllowlistPacket({
      intent: 'answer',
      domain: 'content',
      capabilityId: 'content.idea',
      locale: 'en',
      complexityScore: 0.4,
      escalationReason: 'local_queue_saturation',
    })).toEqual({ ok: false, denialReason: 'insufficient_safe_context_for_cloud' });
  });

  it('feeds readiness gates with observable denial reasons and HMAC-only sent packets', () => {
    const allowed = buildChatCloudAllowlistPacket({
      intent: 'answer',
      domain: 'general',
      capabilityId: 'general.help',
      locale: 'en',
      complexityScore: 0.2,
      escalationReason: 'local_queue_saturation',
      evidenceRefs: [{ kind: 'policy', stableId: 'public-help' }],
    });
    const denied = buildChatCloudAllowlistPacket({
      intent: 'answer',
      domain: 'calendar',
      capabilityId: 'secretary.calendar',
      locale: 'en',
      complexityScore: 0.8,
      escalationReason: 'local_queue_saturation',
      evidenceRefs: [{ kind: 'calendar', stableId: 'private-event' }],
    });

    const result = evaluateChatCloudAllowlistReadiness({
      totalTurns: 100,
      cloudTurns: 1,
      packetSamples: [
        buildChatCloudAllowlistPacketSample({ sampleId: 'sent', result: allowed, sentToCloud: true }),
        buildChatCloudAllowlistPacketSample({ sampleId: 'denied', result: denied, sentToCloud: false }),
      ],
    });

    expect(result.passed).toBe(true);
  });

  it('rejects unknown enum-like cloud packet values instead of normalizing arbitrary text', () => {
    expect(buildChatCloudAllowlistPacket({
      intent: 'send_raw_context' as any,
      domain: 'general',
      capabilityId: 'general.help',
      locale: 'en',
      complexityScore: 0.2,
      escalationReason: 'local_queue_saturation',
      evidenceRefs: [{ kind: 'policy', stableId: 'public-help' }],
    })).toEqual({ ok: false, denialReason: 'insufficient_safe_context_for_cloud' });

    expect(buildChatCloudAllowlistPacket({
      intent: 'answer',
      domain: 'general',
      capabilityId: 'general.help',
      locale: 'en',
      complexityScore: 0.2,
      escalationReason: 'send recent turns to cloud',
      evidenceRefs: [{ kind: 'policy', stableId: 'public-help' }],
    })).toEqual({ ok: false, denialReason: 'insufficient_safe_context_for_cloud' });

    const valid = buildChatCloudAllowlistPacket({
      intent: 'answer',
      domain: 'general',
      capabilityId: 'general.help',
      locale: 'en',
      complexityScore: 0.2,
      escalationReason: 'local_queue_saturation',
      evidenceRefs: [{ kind: 'policy', stableId: 'public-help' }],
    });
    if (!valid.ok) throw new Error('expected allowlist packet');

    expect(validateChatCloudAllowlistPacket({
      ...valid.packet,
      escalationReason: 'send_recent_turns_to_cloud' as any,
    })).toBe(false);
    expect(validateChatCloudAllowlistPacket({
      ...valid.packet,
      rawMessage: 'raw private turn',
    } as any)).toBe(false);
    expect(countRawPrivateCloudFields({
      ...valid.packet,
      intent: 'send raw context to cloud' as any,
    })).toBeGreaterThan(0);
  });

  it('treats malformed non-string HMAC arrays as unsafe without throwing', () => {
    const valid = buildChatCloudAllowlistPacket({
      intent: 'answer',
      domain: 'general',
      capabilityId: 'general.help',
      locale: 'en',
      complexityScore: 0.2,
      escalationReason: 'local_queue_saturation',
      evidenceRefs: [{ kind: 'policy', stableId: 'public-help' }],
    });
    if (!valid.ok) throw new Error('expected allowlist packet');

    const malformed = {
      ...valid.packet,
      anonymizedEntityIds: [42],
    };

    expect(validateChatCloudAllowlistPacket(malformed)).toBe(false);
    expect(() => countRawPrivateCloudFields(malformed)).not.toThrow();
    expect(countRawPrivateCloudFields(malformed)).toBeGreaterThan(0);
  });
});
