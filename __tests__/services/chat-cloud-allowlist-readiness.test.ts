// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  auditChatCloudAllowlistIdentifiers,
  evaluateChatCloudAllowlistReadiness,
  isCloudAllowlistHmacToken,
  type ChatCloudAllowlistGateId,
} from '../../src/services/chat-cloud-allowlist-readiness';

describe('evaluateChatCloudAllowlistReadiness', () => {
  it('passes when cloud usage is low, packets are raw-free, and denials are observable', () => {
    const result = evaluateChatCloudAllowlistReadiness({
      totalTurns: 1_000,
      cloudTurns: 0,
      packetSamples: [
        {
          sampleId: 'audited-safe',
          sentToCloud: false,
          rawPrivateFieldCount: 0,
          denied: false,
          denialReasonObservable: false,
          hmacEntityIdCount: 1,
          nonHmacEntityIdCount: 0,
          hmacEvidenceFingerprintCount: 1,
          nonHmacEvidenceFingerprintCount: 0,
        },
        {
          sampleId: 'denied-safe',
          sentToCloud: false,
          rawPrivateFieldCount: 0,
          denied: true,
          denialReason: 'required_fact_never_cloud',
          denialReasonObservable: true,
        },
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.gates.map((gate) => [gate.gateId, gate.passed])).toEqual([
      ['cloud_usage_share', true],
      ['zero_raw_private_cloud_fields', true],
      ['cloud_denial_reasons_observable', true],
      ['cloud_hmac_only_identifiers', true],
    ]);
  });

  it('fails when cloud usage exceeds the two-percent default cap', () => {
    const result = evaluateChatCloudAllowlistReadiness({
      totalTurns: 100,
      cloudTurns: 3,
      packetSamples: safePackets(),
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'cloud_usage_share')).toMatchObject({
      passed: false,
      observed: 0.03,
      threshold: 0.02,
    });
  });

  it('fails when any audited cloud-bound packet has raw private fields', () => {
    const result = evaluateChatCloudAllowlistReadiness({
      totalTurns: 1_000,
      cloudTurns: 0,
      packetSamples: [
        ...safePackets(),
        {
          sampleId: 'audited-raw',
          sentToCloud: false,
          rawPrivateFieldCount: 1,
          denied: false,
          denialReasonObservable: false,
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'zero_raw_private_cloud_fields')).toMatchObject({
      passed: false,
      observed: 1,
      threshold: 0,
    });
  });

  it('fails when cloud denials do not carry observable reason codes', () => {
    const result = evaluateChatCloudAllowlistReadiness({
      totalTurns: 1_000,
      cloudTurns: 0,
      packetSamples: [
        {
          sampleId: 'audited-safe',
          sentToCloud: false,
          rawPrivateFieldCount: 0,
          denied: false,
          denialReasonObservable: false,
          hmacEntityIdCount: 1,
          nonHmacEntityIdCount: 0,
          hmacEvidenceFingerprintCount: 1,
          nonHmacEvidenceFingerprintCount: 0,
        },
        {
          sampleId: 'denied-missing-reason',
          sentToCloud: false,
          rawPrivateFieldCount: 0,
          denied: true,
          denialReasonObservable: false,
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'cloud_denial_reasons_observable')).toMatchObject({
      passed: false,
      observed: 1,
      threshold: 0,
    });
  });

  it('fails when an audited cloud-bound packet carries non-HMAC identifiers or fingerprints', () => {
    const result = evaluateChatCloudAllowlistReadiness({
      totalTurns: 1_000,
      cloudTurns: 0,
      packetSamples: [
        ...safePackets(),
        {
          sampleId: 'audited-non-hmac',
          sentToCloud: false,
          rawPrivateFieldCount: 0,
          denied: false,
          denialReasonObservable: false,
          hmacEntityIdCount: 1,
          nonHmacEntityIdCount: 1,
          hmacEvidenceFingerprintCount: 0,
          nonHmacEvidenceFingerprintCount: 1,
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'cloud_hmac_only_identifiers')).toMatchObject({
      passed: false,
      observed: 2,
      threshold: 0,
    });
  });

  it('audits packet identifiers as HMAC-only before cloud-readiness evidence is trusted', () => {
    const hmacEntity = 'hmac:entity:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const hmacEvidence = 'hmac:evidence:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

    expect(isCloudAllowlistHmacToken(hmacEntity)).toBe(true);
    expect(isCloudAllowlistHmacToken('evidence:general-focus')).toBe(false);

    expect(auditChatCloudAllowlistIdentifiers({
      entityIds: [hmacEntity, 'raw-task-123'],
      evidenceFingerprints: [hmacEvidence, 'customer note about my calendar'],
    })).toEqual({
      hmacEntityIdCount: 1,
      nonHmacEntityIdCount: 1,
      hmacEvidenceFingerprintCount: 1,
      nonHmacEvidenceFingerprintCount: 1,
    });
  });

  it('fails closed when there are no packet audit samples', () => {
    const result = evaluateChatCloudAllowlistReadiness({
      totalTurns: 1_000,
      cloudTurns: 0,
      packetSamples: [],
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'zero_raw_private_cloud_fields')).toMatchObject({
      reasonCode: 'missing_cloud_packet_audit_samples',
    });
    expect(gate(result, 'cloud_denial_reasons_observable')).toMatchObject({
      reasonCode: 'missing_cloud_denial_samples',
    });
    expect(gate(result, 'cloud_hmac_only_identifiers')).toMatchObject({
      reasonCode: 'missing_cloud_identifier_audit_samples',
    });
  });
});

function safePackets() {
  return [
    {
      sampleId: 'audited-safe',
      sentToCloud: false,
      rawPrivateFieldCount: 0,
      denied: false,
      denialReasonObservable: false,
      hmacEntityIdCount: 1,
      nonHmacEntityIdCount: 0,
      hmacEvidenceFingerprintCount: 1,
      nonHmacEvidenceFingerprintCount: 0,
    },
    {
      sampleId: 'denied-safe',
      sentToCloud: false,
      rawPrivateFieldCount: 0,
      denied: true,
      denialReason: 'domain_disallows_cloud',
      denialReasonObservable: true,
    },
  ];
}

function gate(
  result: ReturnType<typeof evaluateChatCloudAllowlistReadiness>,
  gateId: ChatCloudAllowlistGateId,
) {
  const found = result.gates.find((item) => item.gateId === gateId);
  expect(found).toBeDefined();
  return found!;
}
