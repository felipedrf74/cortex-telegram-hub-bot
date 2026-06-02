// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export const NEXUS_CHAT_CLOUD_ALLOWLIST_READINESS_VERSION = 'nexus_chat_cloud_allowlist_readiness.v1';

export interface ChatCloudAllowlistThresholds {
  maxCloudUsageShare: number;
  requireZeroRawPrivateFields: boolean;
  requireObservableDenialReasons: boolean;
  requireHmacOnlyCloudIdentifiers: boolean;
}

export const DEFAULT_CHAT_CLOUD_ALLOWLIST_THRESHOLDS: ChatCloudAllowlistThresholds = {
  maxCloudUsageShare: 0.02,
  requireZeroRawPrivateFields: true,
  requireObservableDenialReasons: true,
  requireHmacOnlyCloudIdentifiers: true,
};

export interface ChatCloudAllowlistPacketSample {
  sampleId: string;
  sentToCloud: boolean;
  rawPrivateFieldCount: number;
  denied: boolean;
  denialReason?: string;
  denialReasonObservable: boolean;
  hmacEntityIdCount?: number;
  nonHmacEntityIdCount?: number;
  hmacEvidenceFingerprintCount?: number;
  nonHmacEvidenceFingerprintCount?: number;
}

export interface ChatCloudAllowlistReadinessInput {
  totalTurns: number;
  cloudTurns: number;
  packetSamples: ChatCloudAllowlistPacketSample[];
  thresholds?: Partial<ChatCloudAllowlistThresholds>;
}

export interface ChatCloudAllowlistIdentifierAuditInput {
  entityIds?: string[];
  evidenceFingerprints?: string[];
}

export interface ChatCloudAllowlistIdentifierAudit {
  hmacEntityIdCount: number;
  nonHmacEntityIdCount: number;
  hmacEvidenceFingerprintCount: number;
  nonHmacEvidenceFingerprintCount: number;
}

export type ChatCloudAllowlistGateId =
  | 'cloud_usage_share'
  | 'zero_raw_private_cloud_fields'
  | 'cloud_denial_reasons_observable'
  | 'cloud_hmac_only_identifiers';

export interface ChatCloudAllowlistGateResult {
  gateId: ChatCloudAllowlistGateId;
  passed: boolean;
  sampleCount: number;
  observed: number;
  threshold: number;
  reasonCode?: string;
}

export interface ChatCloudAllowlistReadinessResult {
  version: typeof NEXUS_CHAT_CLOUD_ALLOWLIST_READINESS_VERSION;
  passed: boolean;
  gates: ChatCloudAllowlistGateResult[];
}

export function evaluateChatCloudAllowlistReadiness(
  input: ChatCloudAllowlistReadinessInput,
): ChatCloudAllowlistReadinessResult {
  const thresholds = { ...DEFAULT_CHAT_CLOUD_ALLOWLIST_THRESHOLDS, ...(input.thresholds ?? {}) };
  const gates = [
    evaluateCloudUsage(input, thresholds),
    evaluateRawPrivateFields(input.packetSamples, thresholds),
    evaluateDenialReasons(input.packetSamples, thresholds),
    evaluateHmacOnlyIdentifiers(input.packetSamples, thresholds),
  ];
  return {
    version: NEXUS_CHAT_CLOUD_ALLOWLIST_READINESS_VERSION,
    passed: gates.every((gate) => gate.passed),
    gates,
  };
}

export function auditChatCloudAllowlistIdentifiers(
  input: ChatCloudAllowlistIdentifierAuditInput,
): ChatCloudAllowlistIdentifierAudit {
  const entityIds = input.entityIds ?? [];
  const evidenceFingerprints = input.evidenceFingerprints ?? [];
  return {
    hmacEntityIdCount: entityIds.filter(isCloudAllowlistHmacToken).length,
    nonHmacEntityIdCount: entityIds.filter((id) => !isCloudAllowlistHmacToken(id)).length,
    hmacEvidenceFingerprintCount: evidenceFingerprints.filter(isCloudAllowlistHmacToken).length,
    nonHmacEvidenceFingerprintCount: evidenceFingerprints.filter((fingerprint) =>
      !isCloudAllowlistHmacToken(fingerprint),
    ).length,
  };
}

export function isCloudAllowlistHmacToken(value: string): boolean {
  return /^hmac:[a-z0-9_-]+:[a-f0-9]{64}$/i.test(value.trim());
}

function evaluateCloudUsage(
  input: ChatCloudAllowlistReadinessInput,
  thresholds: ChatCloudAllowlistThresholds,
): ChatCloudAllowlistGateResult {
  const observed = input.totalTurns > 0 ? input.cloudTurns / input.totalTurns : 0;
  return {
    gateId: 'cloud_usage_share',
    passed: input.totalTurns > 0 && observed <= thresholds.maxCloudUsageShare,
    sampleCount: input.totalTurns,
    observed,
    threshold: thresholds.maxCloudUsageShare,
    reasonCode: input.totalTurns > 0 ? undefined : 'missing_turn_usage_samples',
  };
}

function evaluateRawPrivateFields(
  samples: ChatCloudAllowlistPacketSample[],
  thresholds: ChatCloudAllowlistThresholds,
): ChatCloudAllowlistGateResult {
  const auditedPackets = samples.filter((sample) => !sample.denied);
  const rawPrivateFieldCount = auditedPackets.reduce((sum, sample) => sum + Math.max(0, sample.rawPrivateFieldCount), 0);
  return {
    gateId: 'zero_raw_private_cloud_fields',
    passed: auditedPackets.length > 0 && (!thresholds.requireZeroRawPrivateFields || rawPrivateFieldCount === 0),
    sampleCount: auditedPackets.length,
    observed: rawPrivateFieldCount,
    threshold: 0,
    reasonCode: auditedPackets.length > 0 ? undefined : 'missing_cloud_packet_audit_samples',
  };
}

function evaluateDenialReasons(
  samples: ChatCloudAllowlistPacketSample[],
  thresholds: ChatCloudAllowlistThresholds,
): ChatCloudAllowlistGateResult {
  const denied = samples.filter((sample) => sample.denied);
  const missing = denied.filter((sample) => !sample.denialReason || !sample.denialReasonObservable).length;
  return {
    gateId: 'cloud_denial_reasons_observable',
    passed: denied.length > 0 && (!thresholds.requireObservableDenialReasons || missing === 0),
    sampleCount: denied.length,
    observed: missing,
    threshold: 0,
    reasonCode: denied.length > 0 ? undefined : 'missing_cloud_denial_samples',
  };
}

function evaluateHmacOnlyIdentifiers(
  samples: ChatCloudAllowlistPacketSample[],
  thresholds: ChatCloudAllowlistThresholds,
): ChatCloudAllowlistGateResult {
  const auditedPackets = samples.filter((sample) => !sample.denied);
  const nonHmacCount = auditedPackets.reduce((sum, sample) =>
    sum
    + Math.max(0, sample.nonHmacEntityIdCount ?? 0)
    + Math.max(0, sample.nonHmacEvidenceFingerprintCount ?? 0), 0);
  const hmacCount = auditedPackets.reduce((sum, sample) =>
    sum
    + Math.max(0, sample.hmacEntityIdCount ?? 0)
    + Math.max(0, sample.hmacEvidenceFingerprintCount ?? 0), 0);
  return {
    gateId: 'cloud_hmac_only_identifiers',
    passed: auditedPackets.length > 0
      && (!thresholds.requireHmacOnlyCloudIdentifiers || (hmacCount > 0 && nonHmacCount === 0)),
    sampleCount: auditedPackets.length,
    observed: nonHmacCount,
    threshold: 0,
    reasonCode: auditedPackets.length > 0 ? undefined : 'missing_cloud_identifier_audit_samples',
  };
}
