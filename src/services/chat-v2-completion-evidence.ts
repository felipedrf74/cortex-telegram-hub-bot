// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from './database';
import {
  buildChatShadowSampleEvidenceHash,
  countUnsafeChatShadowRawFields,
  evaluateChatShadowGateReadiness,
  type ChatShadowGateReadinessResult,
  type ChatShadowGateSample,
  type NexusChatShadowLanguage,
} from './chat-shadow-gate-readiness';
import {
  evaluateChatAnswerCanaryExit,
  type ChatAnswerCanaryEvaluationInput,
  type ChatAnswerCanaryExitResult,
} from './chat-answer-canary-exit';
import type { NexusAnswerCompositionMode } from './chat-final-answer-composer';
import type { NexusAnswerContract, NexusChatActionability, NexusChatLanguage, NexusChatRouteKind } from './chat-answer-contract';
import { detectChatResponseQualityIssues } from './chat-response-quality-gate';
import {
  buildChatCloudAllowlistPacket,
  buildChatCloudAllowlistPacketSample,
  type ChatCloudAllowlistDomain,
  type ChatCloudAllowlistPacket,
} from './chat-cloud-allowlist-packet';
import { safeRecordChatV2CloudAllowlistEvidence } from './chat-cloud-allowlist-evidence';
import { logger } from '../utils/logger';

export type ChatV2CompletionEvidenceKind = 'shadow' | 'answer_canary';
export type ChatV2CompletionEvidenceSource = 'runtime_route' | 'local_sandbox_seed';

export interface ChatV2ResponseEnvelopeLike {
  id?: unknown;
  text?: unknown;
  domain?: unknown;
  routeMethod?: unknown;
  confidence?: unknown;
  metadata?: unknown;
}

export interface ChatV2CompletionEvidenceInput {
  tenantId: number;
  userId: number;
  requestId: string;
  normalizedMessage: string;
  evidenceSource?: ChatV2CompletionEvidenceSource;
  userLanguage?: string | null;
  response: ChatV2ResponseEnvelopeLike;
  firstProgressMs?: number | null;
  unsupportedClaimProbe?: boolean;
}

type ChatV2CompletionEvidenceRow = {
  evidence_kind: ChatV2CompletionEvidenceKind;
  evidence_source: ChatV2CompletionEvidenceSource;
  tenant_id: number;
  user_id: number;
  request_id: string;
  message_hmac: string;
  locale: string;
  candidate_capabilities_json: string;
  final_capability_id: string | null;
  schema_valid_after_repair: number;
  candidate_evidence_hash: string;
  route_owner: string;
  route_method: string | null;
  response_contract_valid: number;
  answer_accepted: number | null;
  unsupported_claim_caught: number | null;
  first_progress_ms: number | null;
  leaked_raw_private_field: number;
  composition_mode: NexusAnswerCompositionMode | null;
  raw_field_audit_count: number;
  safe_metadata_json: string;
};

const FALLBACK_TEST_HMAC_SECRET = 'test-chat-v2-completion-evidence-secret';
const DEFAULT_READINESS_EVIDENCE_SOURCES: ChatV2CompletionEvidenceSource[] = ['runtime_route'];

export function isChatV2ShadowEvidenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthy(env.CHAT_V2_SHADOW_EVIDENCE_ENABLED)
    || env.CHAT_V2_COMPLETION_MODE === 'shadow'
    || env.CHAT_V2_COMPLETION_MODE === 'canary'
    || env.CHAT_V2_COMPLETION_MODE === 'on';
}

export function isChatV2AnswerCanaryEvidenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthy(env.CHAT_V2_ANSWER_CANARY_EVIDENCE_ENABLED)
    || env.CHAT_V2_COMPLETION_MODE === 'canary'
    || env.CHAT_V2_COMPLETION_MODE === 'on';
}

export function recordChatV2CompletionEvidence(input: ChatV2CompletionEvidenceInput): void {
  const kinds: ChatV2CompletionEvidenceKind[] = [];
  if (isChatV2ShadowEvidenceEnabled() && input.unsupportedClaimProbe !== true) kinds.push('shadow');
  if (isChatV2AnswerCanaryEvidenceEnabled()) kinds.push('answer_canary');
  if (kinds.length === 0) return;

  const response = input.response;
  if (!response || typeof response !== 'object') return;
  if (typeof response.text !== 'string' || !response.text.trim()) return;

  const metadata = asRecord(response.metadata);
  const contract = asNexusAnswerContract(metadata?.chatReasoning);
  const composition = asRecord(metadata?.finalAnswerComposition);
  const routeMethod = stringOrNull(response.routeMethod) ?? stringOrNull(contract?.routeMethod);
  const finalCapabilityId = deriveFinalCapabilityId(contract, response);
  const candidateCapabilities = deriveCandidateCapabilities({ contract, response, metadata, finalCapabilityId });
  const language = normalizeEvidenceLanguage(input.userLanguage, contract?.language);
  const messageHmac = hmacToken('message', `${input.tenantId}:${input.userId}:${input.normalizedMessage}`);
  const shadowSample = bindShadowEvidenceHash({
    sampleId: messageHmac,
    language,
    candidateCapabilities,
    finalCapabilityId: finalCapabilityId ?? undefined,
    schemaValidAfterRepair: isSchemaValidAfterRepair(contract, composition),
    messageIdentifierKind: 'hmac',
    storedRawMessageText: false,
    unsafeRawFieldCount: 0,
  });
  const safeMetadata = buildSafeMetadata({
    contract,
    response,
    metadata,
    composition,
    candidateCapabilities,
    unsupportedClaimProbe: input.unsupportedClaimProbe === true,
  });
  const rawFieldAuditCount = countUnsafeChatShadowRawFields(safeMetadata);
  const routeOwner = stringOrNull(contract?.ownerSkill)
    ?? stringOrNull(response.domain)
    ?? 'chat';
  const firstProgressMs = input.unsupportedClaimProbe === true
    ? null
    : Number.isFinite(input.firstProgressMs ?? NaN)
    ? Math.max(0, Math.floor(input.firstProgressMs!))
    : null;
  const responseContractValid = isResponseContractValid(contract);
  const compositionMode = input.unsupportedClaimProbe === true ? null : asCompositionMode(composition?.mode);
  const qualityIssues = contract ? detectChatResponseQualityIssues(response.text, contract) : [];
  const recordedQualityIssues = parseStringArray(asRecord(metadata?.responseQuality)?.issues);
  const hasUnsupportedClaimIssue = qualityIssues.some((issue) =>
        issue === 'unsupported_specific_state_claim'
        || issue === 'state_claim_without_grounding'
        || issue === 'unverified_success_claim',
      ) || recordedQualityIssues.some((issue) =>
        issue === 'unsupported_specific_state_claim'
        || issue === 'state_claim_without_grounding'
        || issue === 'unverified_success_claim',
      );
  const unsupportedClaimCaught = hasUnsupportedClaimIssue ? 1 : null;

  maybeRecordCloudAllowlistPacketEvidence({
    input,
    contract,
    finalCapabilityId,
    routeMethod,
  });

  for (const kind of kinds) {
    insertChatV2CompletionEvidenceRow({
      evidence_kind: kind,
      evidence_source: input.evidenceSource ?? 'runtime_route',
      tenant_id: input.tenantId,
      user_id: input.userId,
      request_id: input.requestId,
      message_hmac: messageHmac,
      locale: language,
      candidate_capabilities_json: JSON.stringify(candidateCapabilities),
      final_capability_id: finalCapabilityId,
      schema_valid_after_repair: shadowSample.schemaValidAfterRepair ? 1 : 0,
      candidate_evidence_hash: shadowSample.candidateEvidenceHash!,
      route_owner: routeOwner,
      route_method: routeMethod,
      response_contract_valid: responseContractValid ? 1 : 0,
      answer_accepted: null,
      unsupported_claim_caught: unsupportedClaimCaught,
      first_progress_ms: firstProgressMs,
      leaked_raw_private_field: rawFieldAuditCount > 0 ? 1 : 0,
      composition_mode: compositionMode,
      raw_field_audit_count: rawFieldAuditCount,
      safe_metadata_json: JSON.stringify(safeMetadata),
    });
  }
}

function maybeRecordCloudAllowlistPacketEvidence(input: {
  input: ChatV2CompletionEvidenceInput;
  contract: NexusAnswerContract | null;
  finalCapabilityId: string | null;
  routeMethod: string | null;
}): void {
  if (input.input.unsupportedClaimProbe === true) return;
  const contract = input.contract;
  const domain = mapContractToCloudAllowlistDomain(contract);
  const safeForCloud = isContractSafeForCloudAllowlist(contract, domain);
  const capabilityId = input.finalCapabilityId
    ?? contract?.intent
    ?? input.routeMethod
    ?? 'chat.answer';
  const result = buildChatCloudAllowlistPacket({
    intent: mapContractToCloudIntent(contract?.actionability, contract?.routeKind),
    domain: domain ?? 'general',
    capabilityId,
    locale: input.input.userLanguage ?? contract?.language ?? 'en',
    complexityScore: contract ? Math.max(0.05, Math.min(1, 1 - contract.confidence)) : 1,
    escalationReason: 'queue_fallback_candidate',
    entityRefs: [{ kind: 'turn', stableId: input.input.requestId }],
    evidenceRefs: [{ kind: 'capability', stableId: capabilityId }],
    cloudProviderEnabled: true,
    cloudBudgetAvailable: true,
    domainAllowsCloud: safeForCloud,
    requiredFactsNeverCloud: contract != null && !safeForCloud,
  });
  const packetSample = buildChatCloudAllowlistPacketSample({
    sampleId: input.input.requestId,
    result,
    // This recorder audits packet production only. Actual cloud dispatch is
    // recorded by the packet-only fallback path when that rollout is enabled.
    sentToCloud: false,
  });
  safeRecordChatV2CloudAllowlistEvidence({
    tenantId: input.input.tenantId,
    userId: input.input.userId,
    requestId: input.input.requestId,
    sampleKey: `${packetSample.denied ? 'denied' : 'packet'}:${capabilityId}`,
    sentToCloud: packetSample.sentToCloud,
    rawPrivateFieldCount: packetSample.rawPrivateFieldCount,
    denied: packetSample.denied,
    denialReason: packetSample.denialReason,
    denialReasonObservable: packetSample.denialReasonObservable,
    hmacEntityIdCount: packetSample.hmacEntityIdCount,
    nonHmacEntityIdCount: packetSample.nonHmacEntityIdCount,
    hmacEvidenceFingerprintCount: packetSample.hmacEvidenceFingerprintCount,
    nonHmacEvidenceFingerprintCount: packetSample.nonHmacEvidenceFingerprintCount,
    safeMetadata: {
      routeMethod: input.routeMethod,
      capabilityId,
      packetIntent: result.ok ? result.packet.intent : null,
      packetDomain: result.ok ? result.packet.domain : domain,
      cloudPacketAuditOnly: true,
    },
  });
}

function mapContractToCloudAllowlistDomain(contract: NexusAnswerContract | null): ChatCloudAllowlistDomain | null {
  if (!contract) return null;
  if (contract.ownerSkill === 'chat') return 'general';
  if (contract.ownerSkill === 'training') return 'training';
  if (contract.ownerSkill === 'cooking') return 'cooking';
  if (contract.ownerSkill === 'content') return 'content';
  if (contract.ownerSkill === 'finance' && contract.actionability === 'answer_only') return 'finance_education';
  return null;
}

function mapContractToCloudIntent(
  actionability: NexusChatActionability | undefined,
  routeKind: NexusChatRouteKind | undefined,
): ChatCloudAllowlistPacket['intent'] {
  if (actionability === 'clarify' || routeKind === 'clarification') return 'clarify';
  if (actionability === 'blocked' || actionability === 'degraded') return 'unsupported';
  if (routeKind === 'local_read') return 'read';
  return 'answer';
}

function isContractSafeForCloudAllowlist(
  contract: NexusAnswerContract | null,
  domain: ChatCloudAllowlistDomain | null,
): boolean {
  if (!contract || !domain) return false;
  if (contract.actionability !== 'answer_only') return false;
  if (contract.verificationStatus !== 'not_required') return false;
  if (contract.routeKind === 'action' || contract.routeKind === 'local_read') return false;
  if (contract.groundingRequirement !== 'none') return false;
  if (contract.missingFacts.length > 0) return false;
  if (contract.riskLevel === 'high') return false;
  return true;
}

export function safeRecordChatV2CompletionEvidence(input: ChatV2CompletionEvidenceInput): void {
  try {
    recordChatV2CompletionEvidence(input);
  } catch (err) {
    logger.warn(
      { err, requestId: input.requestId, tenantId: input.tenantId, userId: input.userId },
      'ChatV2 completion evidence recording failed',
    );
  }
}

export function loadChatV2ShadowGateSamples(
  limit = 500,
  sources: readonly ChatV2CompletionEvidenceSource[] = DEFAULT_READINESS_EVIDENCE_SOURCES,
): ChatShadowGateSample[] {
  const sourceFilter = buildEvidenceSourceFilter(sources);
  const rows = getDb().prepare(`
    SELECT message_hmac, locale, candidate_capabilities_json, final_capability_id,
           schema_valid_after_repair, message_identifier_kind, candidate_evidence_hash,
           raw_field_audit_count
    FROM chat_v2_completion_evidence
    WHERE evidence_kind = 'shadow'
      AND evidence_source IN (${sourceFilter.placeholders})
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(...sourceFilter.values, Math.max(1, Math.floor(limit))) as Array<{
    message_hmac: string;
    locale: string;
    candidate_capabilities_json: string;
    final_capability_id: string | null;
    schema_valid_after_repair: number;
    message_identifier_kind: string;
    candidate_evidence_hash: string;
    raw_field_audit_count: number;
  }>;

  return rows.map((row) => ({
    sampleId: row.message_hmac,
    language: normalizeEvidenceLanguage(row.locale, undefined),
    candidateCapabilities: parseStringArray(row.candidate_capabilities_json),
    finalCapabilityId: row.final_capability_id ?? undefined,
    schemaValidAfterRepair: row.schema_valid_after_repair === 1,
    messageIdentifierKind: row.message_identifier_kind === 'hmac' ? 'hmac' : 'raw',
    storedRawMessageText: false,
    unsafeRawFieldCount: Math.max(0, Number(row.raw_field_audit_count || 0)),
    candidateEvidenceHash: row.candidate_evidence_hash,
  }));
}

export function evaluateRecordedChatV2ShadowGateReadiness(
  limit = 500,
  sources: readonly ChatV2CompletionEvidenceSource[] = DEFAULT_READINESS_EVIDENCE_SOURCES,
): ChatShadowGateReadinessResult {
  return evaluateChatShadowGateReadiness({ samples: loadChatV2ShadowGateSamples(limit, sources) });
}

export function loadChatV2AnswerCanaryEvaluationInput(
  limit = 500,
  sources: readonly ChatV2CompletionEvidenceSource[] = DEFAULT_READINESS_EVIDENCE_SOURCES,
): ChatAnswerCanaryEvaluationInput {
  const sourceFilter = buildEvidenceSourceFilter(sources);
  const rows = getDb().prepare(`
    SELECT message_hmac, locale, answer_accepted, unsupported_claim_caught,
           first_progress_ms, leaked_raw_private_field, composition_mode
    FROM chat_v2_completion_evidence
    WHERE evidence_kind = 'answer_canary'
      AND evidence_source IN (${sourceFilter.placeholders})
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(...sourceFilter.values, Math.max(1, Math.floor(limit))) as Array<{
    message_hmac: string;
    locale: string;
    answer_accepted: number | null;
    unsupported_claim_caught: number | null;
    first_progress_ms: number | null;
    leaked_raw_private_field: number;
    composition_mode: string | null;
  }>;

  return {
    acceptanceSamples: rows
      .filter((row) => row.answer_accepted != null)
      .map((row) => ({
        sampleId: row.message_hmac,
        language: normalizeEvidenceLanguage(row.locale, undefined),
        accepted: row.answer_accepted === 1,
      })),
    unsupportedClaimSamples: rows
      .filter((row) => row.unsupported_claim_caught != null)
      .map((row) => ({
        sampleId: row.message_hmac,
        caughtByDeterministicCritic: row.unsupported_claim_caught === 1,
      })),
    progressSamples: rows
      .filter((row) => row.first_progress_ms != null)
      .map((row) => ({
        sampleId: row.message_hmac,
        firstProgressMs: Math.max(0, Number(row.first_progress_ms)),
      })),
    privacySamples: rows.map((row) => ({
      sampleId: row.message_hmac,
      leakedRawPrivateField: row.leaked_raw_private_field === 1,
    })),
    compositionSamples: rows
      .map((row) => ({ sampleId: row.message_hmac, mode: asCompositionMode(row.composition_mode) }))
      .filter((sample): sample is { sampleId: string; mode: NexusAnswerCompositionMode } => sample.mode != null),
  };
}

export function evaluateRecordedChatV2AnswerCanaryExit(
  limit = 500,
  sources: readonly ChatV2CompletionEvidenceSource[] = DEFAULT_READINESS_EVIDENCE_SOURCES,
): ChatAnswerCanaryExitResult {
  return evaluateChatAnswerCanaryExit(loadChatV2AnswerCanaryEvaluationInput(limit, sources));
}

function insertChatV2CompletionEvidenceRow(row: ChatV2CompletionEvidenceRow): void {
  getDb().prepare(`
    INSERT INTO chat_v2_completion_evidence (
      evidence_kind, evidence_source, tenant_id, user_id, request_id, message_hmac,
      message_identifier_kind, locale, candidate_capabilities_json,
      final_capability_id, schema_valid_after_repair, candidate_evidence_hash,
      route_owner, route_method, response_contract_valid, answer_accepted,
      unsupported_claim_caught, first_progress_ms, leaked_raw_private_field,
      composition_mode, raw_field_audit_count, safe_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'hmac', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.evidence_kind,
    row.evidence_source,
    row.tenant_id,
    row.user_id,
    row.request_id,
    row.message_hmac,
    row.locale,
    row.candidate_capabilities_json,
    row.final_capability_id,
    row.schema_valid_after_repair,
    row.candidate_evidence_hash,
    row.route_owner,
    row.route_method,
    row.response_contract_valid,
    row.answer_accepted,
    row.unsupported_claim_caught,
    row.first_progress_ms,
    row.leaked_raw_private_field,
    row.composition_mode,
    row.raw_field_audit_count,
    row.safe_metadata_json,
  );
}

function buildEvidenceSourceFilter(sources: readonly ChatV2CompletionEvidenceSource[]): {
  placeholders: string;
  values: ChatV2CompletionEvidenceSource[];
} {
  const values = [...new Set(sources.length > 0 ? sources : DEFAULT_READINESS_EVIDENCE_SOURCES)]
    .filter((source): source is ChatV2CompletionEvidenceSource =>
      source === 'runtime_route' || source === 'local_sandbox_seed',
    );
  const safeValues = values.length > 0 ? values : DEFAULT_READINESS_EVIDENCE_SOURCES;
  return {
    placeholders: safeValues.map(() => '?').join(', '),
    values: safeValues,
  };
}

function bindShadowEvidenceHash(sample: ChatShadowGateSample): ChatShadowGateSample {
  return {
    ...sample,
    candidateEvidenceHash: buildChatShadowSampleEvidenceHash(sample),
  };
}

function hmacToken(kind: string, value: string): string {
  return `hmac:${kind}:${crypto.createHmac('sha256', resolveEvidenceHmacSecret()).update(value).digest('hex')}`;
}

function resolveEvidenceHmacSecret(): string {
  const configured = process.env.CHAT_V2_EVIDENCE_HMAC_SECRET || process.env.IOS_API_JWT_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'test') return FALLBACK_TEST_HMAC_SECRET;
  throw new Error('CHAT_V2_EVIDENCE_HMAC_SECRET is required when ChatV2 evidence recording is enabled');
}

function deriveCandidateCapabilities(input: {
  contract: NexusAnswerContract | null;
  response: ChatV2ResponseEnvelopeLike;
  metadata: Record<string, unknown> | null;
  finalCapabilityId: string | null;
}): string[] {
  const candidates = new Set<string>();
  if (input.finalCapabilityId) candidates.add(input.finalCapabilityId);
  const contract = input.contract;
  if (contract?.intent) candidates.add(contract.intent);
  if (contract?.ownerSkill && contract.routeKind) candidates.add(`${contract.ownerSkill}.${contract.routeKind}`);
  if (contract?.ownerSkill && contract.expectedResponseShape) candidates.add(`${contract.ownerSkill}.${contract.expectedResponseShape}`);
  const routeMethod = stringOrNull(input.response.routeMethod) ?? stringOrNull(contract?.routeMethod);
  if (routeMethod) candidates.add(`route.${routeMethod}`);
  const domain = stringOrNull(input.response.domain);
  if (domain) candidates.add(`domain.${domain}`);
  const chatTurnContract = asRecord(input.metadata?.chatTurnContract);
  const skill = stringOrNull(chatTurnContract?.skill);
  if (skill) candidates.add(`${skill}.turn_contract`);
  const involvedSkills = parseStringArray(asRecord(input.metadata?.responseSufficiency)?.involvedSkills);
  for (const involved of involvedSkills) candidates.add(`${involved}.involved`);
  candidates.add('general.help');
  return [...candidates].filter(Boolean).slice(0, 8);
}

function deriveFinalCapabilityId(
  contract: NexusAnswerContract | null,
  response: ChatV2ResponseEnvelopeLike,
): string | null {
  if (contract?.intent && contract.intent !== 'general_chat') return contract.intent;
  if (contract?.ownerSkill && contract.routeKind) return `${contract.ownerSkill}.${contract.routeKind}`;
  const domain = stringOrNull(response.domain);
  const routeMethod = stringOrNull(response.routeMethod);
  if (domain && routeMethod) return `${domain}.${routeMethod}`;
  return domain ? `${domain}.answer` : null;
}

function isSchemaValidAfterRepair(
  contract: NexusAnswerContract | null,
  composition: Record<string, unknown> | null,
): boolean {
  if (!isResponseContractValid(contract)) return false;
  if (composition && composition.ok === false) return false;
  return true;
}

function isResponseContractValid(contract: NexusAnswerContract | null): boolean {
  return contract?.version === 'nexus_answer_contract.v1'
    && typeof contract.intent === 'string'
    && typeof contract.ownerSkill === 'string'
    && typeof contract.routeMethod === 'string';
}

function buildSafeMetadata(input: {
  contract: NexusAnswerContract | null;
  response: ChatV2ResponseEnvelopeLike;
  metadata: Record<string, unknown> | null;
  composition: Record<string, unknown> | null;
  candidateCapabilities: string[];
  unsupportedClaimProbe: boolean;
}): Record<string, unknown> {
  const contract = input.contract;
  return {
    schemaVersion: 'chat_v2_completion_evidence_safe_metadata.v1',
    responseIdHash: stringOrNull(input.response.id)
      ? hmacToken('response', stringOrNull(input.response.id)!)
      : null,
    domain: stringOrNull(input.response.domain),
    routeMethod: stringOrNull(input.response.routeMethod) ?? stringOrNull(contract?.routeMethod),
    metadataType: stringOrNull(input.metadata?.type),
    contract: contract ? {
      intent: contract.intent,
      ownerSkill: contract.ownerSkill,
      routeKind: contract.routeKind,
      actionability: contract.actionability,
      verificationStatus: contract.verificationStatus,
      fallbackType: contract.fallback.fallbackType,
      language: contract.language,
    } : null,
    composition: input.composition ? {
      ok: input.composition.ok === true,
      mode: stringOrNull(input.composition.mode),
      version: stringOrNull(input.composition.version),
    } : null,
    unsupportedClaimProbe: input.unsupportedClaimProbe,
    candidateCapabilities: input.candidateCapabilities,
  };
}

function normalizeEvidenceLanguage(
  userLanguage: string | null | undefined,
  contractLanguage: NexusChatLanguage | undefined,
): NexusChatShadowLanguage {
  const raw = String(userLanguage || contractLanguage || '').trim();
  if (/^pt[-_]?br$/i.test(raw)) return 'pt-BR';
  if (/^pt[-_]?pt$/i.test(raw)) return 'pt-PT';
  if (/^pt\b/i.test(raw)) return 'pt-BR';
  if (/^en\b/i.test(raw)) return 'en';
  if (/mixed/i.test(raw)) return 'mixed';
  return contractLanguage === 'pt' ? 'pt-BR' : contractLanguage ?? 'en';
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

function parseStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      return parseStringArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function asCompositionMode(value: unknown): NexusAnswerCompositionMode | null {
  return value === 'templated'
    || value === 'model_constrained'
    || value === 'background_model'
    || value === 'cloud_allowlist'
    ? value
    : null;
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}
