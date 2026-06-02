// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from './database';
import {
  countUnsafeChatShadowRawFields,
} from './chat-shadow-gate-readiness';
import {
  evaluateChatDeterministicReadReadiness,
  type ChatDeterministicReadReadinessInput,
  type ChatDeterministicReadReadinessResult,
  type ChatDeterministicReadSample,
  type ChatDeterministicReadSurface,
  type ChatTokenZeroSurfaceSample,
} from './chat-deterministic-read-readiness';
import type { NexusAnswerContract } from './chat-answer-contract';
import { logger } from '../utils/logger';

export type ChatV2DeterministicReadEvidenceKind = 'deterministic_read' | 'token_zero_surface';
export type ChatV2DeterministicReadEvidenceSource = 'runtime_route' | 'local_sandbox_seed';

export interface ChatV2DeterministicReadEnvelopeLike {
  id?: unknown;
  text?: unknown;
  domain?: unknown;
  routeMethod?: unknown;
  metadata?: unknown;
}

export interface ChatV2DeterministicReadEvidenceInput {
  tenantId: number;
  userId: number;
  requestId: string;
  normalizedMessage: string;
  response: ChatV2DeterministicReadEnvelopeLike;
  evidenceSource?: ChatV2DeterministicReadEvidenceSource;
  tokenZeroSurface?: ChatDeterministicReadSurface;
  tokenZeroPreserved?: boolean;
  tenantUserIsolationPassed?: boolean;
}

type ChatV2DeterministicReadEvidenceRow = {
  evidence_kind: ChatV2DeterministicReadEvidenceKind;
  evidence_source: ChatV2DeterministicReadEvidenceSource;
  tenant_id: number;
  user_id: number;
  request_id: string;
  sample_hmac: string;
  read_kind: string;
  token_zero_surface: ChatDeterministicReadSurface | null;
  response_contract_valid: number;
  tenant_user_isolation_passed: number;
  token_zero_preserved: number | null;
  raw_field_audit_count: number;
  safe_metadata_json: string;
};

const FALLBACK_TEST_HMAC_SECRET = 'test-chat-v2-deterministic-read-evidence-secret';
const DEFAULT_READINESS_EVIDENCE_SOURCES: ChatV2DeterministicReadEvidenceSource[] = ['runtime_route'];

export function isChatV2DeterministicReadEvidenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthy(env.CHAT_V2_DETERMINISTIC_READ_EVIDENCE_ENABLED)
    || env.CHAT_V2_DETERMINISTIC_READ_MODE === 'evidence'
    || env.CHAT_V2_COMPLETION_MODE === 'on';
}

export function recordChatV2DeterministicReadEvidence(input: ChatV2DeterministicReadEvidenceInput): void {
  if (!isChatV2DeterministicReadEvidenceEnabled()) return;

  const response = input.response;
  if (!response || typeof response !== 'object') return;
  if (typeof response.text !== 'string' || !response.text.trim()) return;

  const metadata = asRecord(response.metadata);
  const contract = asNexusAnswerContract(metadata?.chatReasoning);
  const responseContractValid = isResponseContractValid(contract);
  const readKind = deriveReadKind({
    normalizedMessage: input.normalizedMessage,
    response,
    contract,
  });
  const sampleHmac = hmacToken(
    input.tokenZeroSurface ? 'token-zero-read' : 'deterministic-read',
    `${input.tenantId}:${input.userId}:${input.requestId}:${input.normalizedMessage}:${input.tokenZeroSurface ?? readKind}`,
  );
  const safeMetadata = buildSafeMetadata({
    response,
    contract,
    readKind,
    tokenZeroSurface: input.tokenZeroSurface ?? null,
  });
  const rawFieldAuditCount = countUnsafeChatShadowRawFields(safeMetadata);
  const tenantUserIsolationPassed = input.tenantUserIsolationPassed !== false;
  const source = input.evidenceSource ?? 'runtime_route';

  insertChatV2DeterministicReadEvidenceRow({
    evidence_kind: 'deterministic_read',
    evidence_source: source,
    tenant_id: input.tenantId,
    user_id: input.userId,
    request_id: input.requestId,
    sample_hmac: sampleHmac,
    read_kind: readKind,
    token_zero_surface: null,
    response_contract_valid: responseContractValid ? 1 : 0,
    tenant_user_isolation_passed: tenantUserIsolationPassed ? 1 : 0,
    token_zero_preserved: null,
    raw_field_audit_count: rawFieldAuditCount,
    safe_metadata_json: JSON.stringify(safeMetadata),
  });

  if (input.tokenZeroSurface) {
    insertChatV2DeterministicReadEvidenceRow({
      evidence_kind: 'token_zero_surface',
      evidence_source: source,
      tenant_id: input.tenantId,
      user_id: input.userId,
      request_id: input.requestId,
      sample_hmac: sampleHmac,
      read_kind: readKind,
      token_zero_surface: input.tokenZeroSurface,
      response_contract_valid: responseContractValid ? 1 : 0,
      tenant_user_isolation_passed: tenantUserIsolationPassed ? 1 : 0,
      token_zero_preserved: input.tokenZeroPreserved === false ? 0 : 1,
      raw_field_audit_count: rawFieldAuditCount,
      safe_metadata_json: JSON.stringify(safeMetadata),
    });
  }
}

export function safeRecordChatV2DeterministicReadEvidence(input: ChatV2DeterministicReadEvidenceInput): void {
  try {
    recordChatV2DeterministicReadEvidence(input);
  } catch (err) {
    logger.warn(
      { err, requestId: input.requestId, tenantId: input.tenantId, userId: input.userId },
      'ChatV2 deterministic read evidence recording failed',
    );
  }
}

export function loadChatV2DeterministicReadEvaluationInput(
  limit = 500,
  sources: readonly ChatV2DeterministicReadEvidenceSource[] = DEFAULT_READINESS_EVIDENCE_SOURCES,
): ChatDeterministicReadReadinessInput {
  const sourceFilter = buildEvidenceSourceFilter(sources);
  const rows = getDb().prepare(`
    SELECT evidence_kind, sample_hmac, token_zero_surface, response_contract_valid,
           tenant_user_isolation_passed, token_zero_preserved
    FROM chat_v2_deterministic_read_evidence
    WHERE evidence_source IN (${sourceFilter.placeholders})
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(...sourceFilter.values, Math.max(1, Math.floor(limit))) as Array<{
    evidence_kind: string;
    sample_hmac: string;
    token_zero_surface: string | null;
    response_contract_valid: number;
    tenant_user_isolation_passed: number;
    token_zero_preserved: number | null;
  }>;

  return {
    readSamples: rows
      .filter((row) => row.evidence_kind === 'deterministic_read')
      .map((row): ChatDeterministicReadSample => ({
        sampleId: row.sample_hmac,
        responseContractValid: row.response_contract_valid === 1,
        tenantUserIsolationPassed: row.tenant_user_isolation_passed === 1,
      })),
    tokenZeroSamples: rows
      .filter((row) => row.evidence_kind === 'token_zero_surface')
      .map((row): ChatTokenZeroSurfaceSample | null => {
        const surface = asTokenZeroSurface(row.token_zero_surface);
        if (!surface) return null;
        return {
          sampleId: row.sample_hmac,
          surface,
          preserved: row.token_zero_preserved === 1,
        };
      })
      .filter((sample): sample is ChatTokenZeroSurfaceSample => sample != null),
  };
}

export function evaluateRecordedChatV2DeterministicReadReadiness(
  limit = 500,
  sources: readonly ChatV2DeterministicReadEvidenceSource[] = DEFAULT_READINESS_EVIDENCE_SOURCES,
): ChatDeterministicReadReadinessResult {
  return evaluateChatDeterministicReadReadiness(
    loadChatV2DeterministicReadEvaluationInput(limit, sources),
  );
}

function insertChatV2DeterministicReadEvidenceRow(row: ChatV2DeterministicReadEvidenceRow): void {
  getDb().prepare(`
    INSERT INTO chat_v2_deterministic_read_evidence (
      evidence_kind, evidence_source, tenant_id, user_id, request_id, sample_hmac,
      sample_identifier_kind, read_kind, token_zero_surface, response_contract_valid,
      tenant_user_isolation_passed, token_zero_preserved, raw_field_audit_count,
      safe_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'hmac', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.evidence_kind,
    row.evidence_source,
    row.tenant_id,
    row.user_id,
    row.request_id,
    row.sample_hmac,
    row.read_kind,
    row.token_zero_surface,
    row.response_contract_valid,
    row.tenant_user_isolation_passed,
    row.token_zero_preserved,
    row.raw_field_audit_count,
    row.safe_metadata_json,
  );
}

function buildEvidenceSourceFilter(sources: readonly ChatV2DeterministicReadEvidenceSource[]): {
  placeholders: string;
  values: ChatV2DeterministicReadEvidenceSource[];
} {
  const values = [...new Set(sources.length > 0 ? sources : DEFAULT_READINESS_EVIDENCE_SOURCES)]
    .filter((source): source is ChatV2DeterministicReadEvidenceSource =>
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
  throw new Error('CHAT_V2_EVIDENCE_HMAC_SECRET is required when ChatV2 deterministic read evidence recording is enabled');
}

function deriveReadKind(input: {
  normalizedMessage: string;
  response: ChatV2DeterministicReadEnvelopeLike;
  contract: NexusAnswerContract | null;
}): string {
  const text = input.normalizedMessage.trim().toLowerCase();
  const intent = input.contract?.intent?.toLowerCase() ?? '';
  const owner = input.contract?.ownerSkill ?? stringOrNull(input.response.domain) ?? 'chat';
  const routeMethod = (stringOrNull(input.response.routeMethod) ?? input.contract?.routeMethod ?? '').toLowerCase();

  if (/^\/(today|day)\b/.test(text) || /today|daily|agenda_summary/.test(intent)) return 'today';
  if (/^\/week\b/.test(text) || /calendar|agenda/.test(intent) || owner === 'secretary') return 'calendar';
  if (/^\/(tasks|todo|todos|duetoday|due_today|overdue|dueweek|due_week|alltasks|all_tasks|todosummary|todo_summary)\b/.test(text)
    || /task|todo/.test(intent)
    || owner === 'tasks') return 'tasks';
  if (/training|treino/.test(text) || owner === 'training') return 'training_today';
  if (/changed|mudou|alterou|what changed|o que mudou/.test(text)) return 'what_changed';
  if (/identity|authenticated-identity/.test(routeMethod)) return 'identity';
  return routeMethod || `${owner}.read`;
}

function buildSafeMetadata(input: {
  response: ChatV2DeterministicReadEnvelopeLike;
  contract: NexusAnswerContract | null;
  readKind: string;
  tokenZeroSurface: ChatDeterministicReadSurface | null;
}): Record<string, unknown> {
  return {
    schemaVersion: 'chat_v2_deterministic_read_evidence_safe_metadata.v1',
    responseIdHash: stringOrNull(input.response.id)
      ? hmacToken('response', stringOrNull(input.response.id)!)
      : null,
    domain: stringOrNull(input.response.domain),
    routeMethod: stringOrNull(input.response.routeMethod) ?? input.contract?.routeMethod ?? null,
    readKind: input.readKind,
    tokenZeroSurface: input.tokenZeroSurface,
    contract: input.contract ? {
      intent: input.contract.intent,
      ownerSkill: input.contract.ownerSkill,
      routeKind: input.contract.routeKind,
      actionability: input.contract.actionability,
      verificationStatus: input.contract.verificationStatus,
      expectedResponseShape: input.contract.expectedResponseShape,
      fallbackType: input.contract.fallback.fallbackType,
      language: input.contract.language,
    } : null,
  };
}

function isResponseContractValid(contract: NexusAnswerContract | null): boolean {
  return contract?.version === 'nexus_answer_contract.v1'
    && typeof contract.intent === 'string'
    && typeof contract.ownerSkill === 'string'
    && typeof contract.routeMethod === 'string'
    && contract.actionability === 'answer_only'
    && contract.verificationStatus === 'not_required';
}

function asNexusAnswerContract(value: unknown): NexusAnswerContract | null {
  const record = asRecord(value);
  if (!record || record.version !== 'nexus_answer_contract.v1') return null;
  return record as unknown as NexusAnswerContract;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function asTokenZeroSurface(value: unknown): ChatDeterministicReadSurface | null {
  return value === 'slash' || value === 'button' || value === 'api' ? value : null;
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}
