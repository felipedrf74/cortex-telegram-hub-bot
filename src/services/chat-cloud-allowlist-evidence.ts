// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from './database';
import { countUnsafeChatShadowRawFields } from './chat-shadow-gate-readiness';
import {
  evaluateChatCloudAllowlistReadiness,
  type ChatCloudAllowlistPacketSample,
  type ChatCloudAllowlistReadinessInput,
  type ChatCloudAllowlistReadinessResult,
} from './chat-cloud-allowlist-readiness';
import { logger } from '../utils/logger';

export type ChatV2CloudAllowlistEvidenceSource = 'runtime_route' | 'local_sandbox_seed';

export interface ChatV2CloudAllowlistEvidenceInput {
  tenantId: number;
  userId: number;
  requestId: string;
  sampleKey: string;
  evidenceSource?: ChatV2CloudAllowlistEvidenceSource;
  sentToCloud: boolean;
  rawPrivateFieldCount: number;
  denied: boolean;
  denialReason?: string;
  denialReasonObservable: boolean;
  hmacEntityIdCount?: number;
  nonHmacEntityIdCount?: number;
  hmacEvidenceFingerprintCount?: number;
  nonHmacEvidenceFingerprintCount?: number;
  safeMetadata?: Record<string, unknown>;
}

type ChatV2CloudAllowlistEvidenceRow = {
  evidence_source: ChatV2CloudAllowlistEvidenceSource;
  tenant_id: number;
  user_id: number;
  request_id: string;
  sample_hmac: string;
  sent_to_cloud: number;
  raw_private_field_count: number;
  denied: number;
  denial_reason: string | null;
  denial_reason_observable: number;
  hmac_entity_id_count: number;
  non_hmac_entity_id_count: number;
  hmac_evidence_fingerprint_count: number;
  non_hmac_evidence_fingerprint_count: number;
  safe_metadata_json: string;
};

const FALLBACK_TEST_HMAC_SECRET = 'test-chat-v2-cloud-allowlist-evidence-secret';
const DEFAULT_READINESS_EVIDENCE_SOURCES: ChatV2CloudAllowlistEvidenceSource[] = ['runtime_route'];

export function isChatV2CloudAllowlistEvidenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthy(env.CHAT_V2_CLOUD_ALLOWLIST_EVIDENCE_ENABLED)
    || env.CHAT_V2_CLOUD_ALLOWLIST_EVIDENCE_MODE === 'evidence'
    || env.CHAT_V2_COMPLETION_MODE === 'on';
}

export function recordChatV2CloudAllowlistEvidence(input: ChatV2CloudAllowlistEvidenceInput): void {
  if (!isChatV2CloudAllowlistEvidenceEnabled()) return;
  const safeMetadata = {
    schemaVersion: 'chat_v2_cloud_allowlist_evidence_safe_metadata.v1',
    sentToCloud: input.sentToCloud,
    denied: input.denied,
    denialReason: input.denialReason ?? null,
    ...(input.safeMetadata ?? {}),
  };
  const rawFieldAuditCount = countUnsafeChatShadowRawFields(safeMetadata);
  insertChatV2CloudAllowlistEvidenceRow({
    evidence_source: input.evidenceSource ?? 'runtime_route',
    tenant_id: input.tenantId,
    user_id: input.userId,
    request_id: input.requestId,
    sample_hmac: hmacToken(
      'cloud-allowlist',
      `${input.tenantId}:${input.userId}:${input.requestId}:${input.sampleKey}`,
    ),
    sent_to_cloud: boolInt(input.sentToCloud),
    raw_private_field_count: Math.max(0, input.rawPrivateFieldCount, rawFieldAuditCount),
    denied: boolInt(input.denied),
    denial_reason: normalizeReason(input.denialReason),
    denial_reason_observable: boolInt(input.denialReasonObservable),
    hmac_entity_id_count: Math.max(0, Math.floor(input.hmacEntityIdCount ?? 0)),
    non_hmac_entity_id_count: Math.max(0, Math.floor(input.nonHmacEntityIdCount ?? 0)),
    hmac_evidence_fingerprint_count: Math.max(0, Math.floor(input.hmacEvidenceFingerprintCount ?? 0)),
    non_hmac_evidence_fingerprint_count: Math.max(0, Math.floor(input.nonHmacEvidenceFingerprintCount ?? 0)),
    safe_metadata_json: JSON.stringify(safeMetadata),
  });
}

export function safeRecordChatV2CloudAllowlistEvidence(input: ChatV2CloudAllowlistEvidenceInput): void {
  try {
    recordChatV2CloudAllowlistEvidence(input);
  } catch (err) {
    logger.warn(
      { err, requestId: input.requestId, tenantId: input.tenantId, userId: input.userId },
      'ChatV2 cloud allowlist evidence recording failed',
    );
  }
}

export function loadChatV2CloudAllowlistReadinessInput(
  limit = 500,
  sources: readonly ChatV2CloudAllowlistEvidenceSource[] = DEFAULT_READINESS_EVIDENCE_SOURCES,
): ChatCloudAllowlistReadinessInput {
  const sourceFilter = buildEvidenceSourceFilter(sources);
  const rows = getDb().prepare(`
    SELECT sample_hmac, sent_to_cloud, raw_private_field_count, denied, denial_reason,
           denial_reason_observable, hmac_entity_id_count, non_hmac_entity_id_count,
           hmac_evidence_fingerprint_count, non_hmac_evidence_fingerprint_count
    FROM chat_v2_cloud_allowlist_evidence
    WHERE evidence_source IN (${sourceFilter.placeholders})
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(...sourceFilter.values, Math.max(1, Math.floor(limit))) as Array<{
    sample_hmac: string;
    sent_to_cloud: number;
    raw_private_field_count: number;
    denied: number;
    denial_reason: string | null;
    denial_reason_observable: number;
    hmac_entity_id_count: number;
    non_hmac_entity_id_count: number;
    hmac_evidence_fingerprint_count: number;
    non_hmac_evidence_fingerprint_count: number;
  }>;

  const packetSamples: ChatCloudAllowlistPacketSample[] = rows.map((row) => ({
    sampleId: row.sample_hmac,
    sentToCloud: row.sent_to_cloud === 1,
    rawPrivateFieldCount: Math.max(0, Number(row.raw_private_field_count || 0)),
    denied: row.denied === 1,
    denialReason: row.denial_reason ?? undefined,
    denialReasonObservable: row.denial_reason_observable === 1,
    hmacEntityIdCount: Math.max(0, Number(row.hmac_entity_id_count || 0)),
    nonHmacEntityIdCount: Math.max(0, Number(row.non_hmac_entity_id_count || 0)),
    hmacEvidenceFingerprintCount: Math.max(0, Number(row.hmac_evidence_fingerprint_count || 0)),
    nonHmacEvidenceFingerprintCount: Math.max(0, Number(row.non_hmac_evidence_fingerprint_count || 0)),
  }));
  return {
    totalTurns: rows.length,
    cloudTurns: rows.filter((row) => row.sent_to_cloud === 1).length,
    packetSamples,
  };
}

export function evaluateRecordedChatV2CloudAllowlistReadiness(
  limit = 500,
  sources: readonly ChatV2CloudAllowlistEvidenceSource[] = DEFAULT_READINESS_EVIDENCE_SOURCES,
): ChatCloudAllowlistReadinessResult {
  return evaluateChatCloudAllowlistReadiness(loadChatV2CloudAllowlistReadinessInput(limit, sources));
}

function insertChatV2CloudAllowlistEvidenceRow(row: ChatV2CloudAllowlistEvidenceRow): void {
  getDb().prepare(`
    INSERT INTO chat_v2_cloud_allowlist_evidence (
      evidence_source, tenant_id, user_id, request_id, sample_hmac,
      sample_identifier_kind, sent_to_cloud, raw_private_field_count, denied,
      denial_reason, denial_reason_observable, hmac_entity_id_count,
      non_hmac_entity_id_count, hmac_evidence_fingerprint_count,
      non_hmac_evidence_fingerprint_count, safe_metadata_json
    ) VALUES (?, ?, ?, ?, ?, 'hmac', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.evidence_source,
    row.tenant_id,
    row.user_id,
    row.request_id,
    row.sample_hmac,
    row.sent_to_cloud,
    row.raw_private_field_count,
    row.denied,
    row.denial_reason,
    row.denial_reason_observable,
    row.hmac_entity_id_count,
    row.non_hmac_entity_id_count,
    row.hmac_evidence_fingerprint_count,
    row.non_hmac_evidence_fingerprint_count,
    row.safe_metadata_json,
  );
}

function buildEvidenceSourceFilter(sources: readonly ChatV2CloudAllowlistEvidenceSource[]): {
  placeholders: string;
  values: ChatV2CloudAllowlistEvidenceSource[];
} {
  const values = [...new Set(sources.length > 0 ? sources : DEFAULT_READINESS_EVIDENCE_SOURCES)]
    .filter((source): source is ChatV2CloudAllowlistEvidenceSource =>
      source === 'runtime_route' || source === 'local_sandbox_seed',
    );
  const safeValues = values.length > 0 ? values : DEFAULT_READINESS_EVIDENCE_SOURCES;
  return {
    placeholders: safeValues.map(() => '?').join(', '),
    values: safeValues,
  };
}

function hmacToken(kind: string, value: string): string {
  return `hmac:${kind}:${crypto.createHmac('sha256', resolveEvidenceHmacSecret()).update(value).digest('hex')}`;
}

function resolveEvidenceHmacSecret(): string {
  const configured = process.env.CHAT_V2_EVIDENCE_HMAC_SECRET || process.env.IOS_API_JWT_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'test') return FALLBACK_TEST_HMAC_SECRET;
  throw new Error('CHAT_V2_EVIDENCE_HMAC_SECRET is required when ChatV2 cloud allowlist evidence recording is enabled');
}

function normalizeReason(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 96) : null;
}

function boolInt(value: boolean): number {
  return value ? 1 : 0;
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}
