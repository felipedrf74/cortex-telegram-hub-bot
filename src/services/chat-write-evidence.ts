// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from './database';
import { countUnsafeChatShadowRawFields } from './chat-shadow-gate-readiness';
import {
  evaluateChatWriteReadiness,
  type ChatWriteReadinessInput,
  type ChatWriteReadinessPhase,
  type ChatWriteReadinessResult,
  type ChatWriteReadinessSample,
  type ChatWriteRiskClass,
  type ChatWriteVerificationStatus,
} from './chat-write-readiness';
import { logger } from '../utils/logger';

export type ChatV2WriteEvidenceSource = 'runtime_route' | 'local_sandbox_seed';

export interface ChatV2WriteEvidenceInput {
  tenantId: number;
  userId: number;
  requestId: string;
  sampleKey: string;
  evidenceSource?: ChatV2WriteEvidenceSource;
  phase: ChatWriteReadinessPhase;
  riskClass: ChatWriteRiskClass;
  previewValid: boolean;
  diffRequired: boolean;
  visibleDiffPresent: boolean;
  executed: boolean;
  validatedBeforeExecution: boolean;
  successClaimed: boolean;
  verificationStatus: ChatWriteVerificationStatus;
  escalatedPerPolicy: boolean;
  idempotencyPassed: boolean;
  retryCancelPassed: boolean;
  safeMetadata?: Record<string, unknown>;
}

type ChatV2WriteEvidenceRow = {
  evidence_source: ChatV2WriteEvidenceSource;
  phase: ChatWriteReadinessPhase;
  tenant_id: number;
  user_id: number;
  request_id: string;
  sample_hmac: string;
  risk_class: ChatWriteRiskClass;
  preview_valid: number;
  diff_required: number;
  visible_diff_present: number;
  executed: number;
  validated_before_execution: number;
  success_claimed: number;
  verification_status: ChatWriteVerificationStatus;
  escalated_per_policy: number;
  idempotency_passed: number;
  retry_cancel_passed: number;
  raw_field_audit_count: number;
  safe_metadata_json: string;
};

const FALLBACK_TEST_HMAC_SECRET = 'test-chat-v2-write-evidence-secret';
const DEFAULT_READINESS_EVIDENCE_SOURCES: ChatV2WriteEvidenceSource[] = ['runtime_route'];

export function isChatV2WriteEvidenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthy(env.CHAT_V2_WRITE_EVIDENCE_ENABLED)
    || env.CHAT_V2_WRITE_EVIDENCE_MODE === 'evidence'
    || env.CHAT_V2_COMPLETION_MODE === 'on';
}

export function recordChatV2WriteEvidence(input: ChatV2WriteEvidenceInput): void {
  if (!isChatV2WriteEvidenceEnabled()) return;
  const safeMetadata = {
    schemaVersion: 'chat_v2_write_evidence_safe_metadata.v1',
    phase: input.phase,
    riskClass: input.riskClass,
    ...(input.safeMetadata ?? {}),
  };
  const rawFieldAuditCount = countUnsafeChatShadowRawFields(safeMetadata);
  insertChatV2WriteEvidenceRow({
    evidence_source: input.evidenceSource ?? 'runtime_route',
    phase: input.phase,
    tenant_id: input.tenantId,
    user_id: input.userId,
    request_id: input.requestId,
    sample_hmac: hmacToken(
      'write',
      `${input.tenantId}:${input.userId}:${input.requestId}:${input.phase}:${input.sampleKey}`,
    ),
    risk_class: input.riskClass,
    preview_valid: boolInt(input.previewValid),
    diff_required: boolInt(input.diffRequired),
    visible_diff_present: boolInt(input.visibleDiffPresent),
    executed: boolInt(input.executed),
    validated_before_execution: boolInt(input.validatedBeforeExecution),
    success_claimed: boolInt(input.successClaimed),
    verification_status: input.verificationStatus,
    escalated_per_policy: boolInt(input.escalatedPerPolicy),
    idempotency_passed: boolInt(input.idempotencyPassed),
    retry_cancel_passed: boolInt(input.retryCancelPassed),
    raw_field_audit_count: rawFieldAuditCount,
    safe_metadata_json: JSON.stringify(safeMetadata),
  });
}

export function safeRecordChatV2WriteEvidence(input: ChatV2WriteEvidenceInput): void {
  try {
    recordChatV2WriteEvidence(input);
  } catch (err) {
    logger.warn(
      { err, requestId: input.requestId, tenantId: input.tenantId, userId: input.userId, phase: input.phase },
      'ChatV2 write evidence recording failed',
    );
  }
}

export function loadChatV2WriteReadinessInput(
  phase: ChatWriteReadinessPhase,
  limit = 500,
  sources: readonly ChatV2WriteEvidenceSource[] = DEFAULT_READINESS_EVIDENCE_SOURCES,
): ChatWriteReadinessInput {
  const sourceFilter = buildEvidenceSourceFilter(sources);
  const rows = getDb().prepare(`
    SELECT sample_hmac, risk_class, preview_valid, diff_required, visible_diff_present,
           executed, validated_before_execution, success_claimed, verification_status,
           escalated_per_policy, idempotency_passed, retry_cancel_passed
    FROM chat_v2_write_evidence
    WHERE phase = ?
      AND evidence_source IN (${sourceFilter.placeholders})
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(phase, ...sourceFilter.values, Math.max(1, Math.floor(limit))) as Array<{
    sample_hmac: string;
    risk_class: string;
    preview_valid: number;
    diff_required: number;
    visible_diff_present: number;
    executed: number;
    validated_before_execution: number;
    success_claimed: number;
    verification_status: string;
    escalated_per_policy: number;
    idempotency_passed: number;
    retry_cancel_passed: number;
  }>;

  return {
    phase,
    samples: rows
      .map((row): ChatWriteReadinessSample | null => {
        const riskClass = asRiskClass(row.risk_class);
        const verificationStatus = asVerificationStatus(row.verification_status);
        if (!riskClass || !verificationStatus) return null;
        return {
          sampleId: row.sample_hmac,
          riskClass,
          previewValid: row.preview_valid === 1,
          diffRequired: row.diff_required === 1,
          visibleDiffPresent: row.visible_diff_present === 1,
          executed: row.executed === 1,
          validatedBeforeExecution: row.validated_before_execution === 1,
          successClaimed: row.success_claimed === 1,
          verificationStatus,
          escalatedPerPolicy: row.escalated_per_policy === 1,
          idempotencyPassed: row.idempotency_passed === 1,
          retryCancelPassed: row.retry_cancel_passed === 1,
        };
      })
      .filter((sample): sample is ChatWriteReadinessSample => sample != null),
  };
}

export function evaluateRecordedChatV2WriteReadiness(
  phase: ChatWriteReadinessPhase,
  limit = 500,
  sources: readonly ChatV2WriteEvidenceSource[] = DEFAULT_READINESS_EVIDENCE_SOURCES,
): ChatWriteReadinessResult {
  return evaluateChatWriteReadiness(loadChatV2WriteReadinessInput(phase, limit, sources));
}

function insertChatV2WriteEvidenceRow(row: ChatV2WriteEvidenceRow): void {
  getDb().prepare(`
    INSERT INTO chat_v2_write_evidence (
      evidence_source, phase, tenant_id, user_id, request_id, sample_hmac,
      sample_identifier_kind, risk_class, preview_valid, diff_required,
      visible_diff_present, executed, validated_before_execution, success_claimed,
      verification_status, escalated_per_policy, idempotency_passed, retry_cancel_passed,
      raw_field_audit_count, safe_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'hmac', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.evidence_source,
    row.phase,
    row.tenant_id,
    row.user_id,
    row.request_id,
    row.sample_hmac,
    row.risk_class,
    row.preview_valid,
    row.diff_required,
    row.visible_diff_present,
    row.executed,
    row.validated_before_execution,
    row.success_claimed,
    row.verification_status,
    row.escalated_per_policy,
    row.idempotency_passed,
    row.retry_cancel_passed,
    row.raw_field_audit_count,
    row.safe_metadata_json,
  );
}

function buildEvidenceSourceFilter(sources: readonly ChatV2WriteEvidenceSource[]): {
  placeholders: string;
  values: ChatV2WriteEvidenceSource[];
} {
  const values = [...new Set(sources.length > 0 ? sources : DEFAULT_READINESS_EVIDENCE_SOURCES)]
    .filter((source): source is ChatV2WriteEvidenceSource =>
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
  throw new Error('CHAT_V2_EVIDENCE_HMAC_SECRET is required when ChatV2 write evidence recording is enabled');
}

function asRiskClass(value: unknown): ChatWriteRiskClass | null {
  return value === 'A' || value === 'B' || value === 'C' ? value : null;
}

function asVerificationStatus(value: unknown): ChatWriteVerificationStatus | null {
  return value === 'verified'
    || value === 'partial'
    || value === 'failed'
    || value === 'indeterminate'
    || value === 'not_required'
    ? value
    : null;
}

function boolInt(value: boolean): number {
  return value ? 1 : 0;
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}
