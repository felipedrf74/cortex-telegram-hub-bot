// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import {
  auditChatCloudAllowlistIdentifiers,
  type ChatCloudAllowlistPacketSample,
} from './chat-cloud-allowlist-readiness';

export const NEXUS_CHAT_CLOUD_ALLOWLIST_PACKET_VERSION = 'nexus_chat_cloud_allowlist_packet.v1';

export type ChatCloudAllowlistDenialReason =
  | 'required_fact_never_cloud'
  | 'insufficient_safe_context_for_cloud'
  | 'cloud_provider_disabled'
  | 'cloud_budget_exceeded'
  | 'domain_disallows_cloud';

export type ChatCloudAllowlistDomain =
  | 'general'
  | 'training'
  | 'cooking'
  | 'content'
  | 'finance_education';

export type ChatCloudAllowlistIntent = ChatCloudAllowlistPacket['intent'];

export type ChatCloudAllowlistEscalationReason =
  | 'local_queue_saturation'
  | 'queue_fallback_candidate'
  | 'cloud_allowlist_candidate';

export interface ChatCloudAllowlistEntityRef {
  kind: string;
  stableId: string;
}

export interface ChatCloudAllowlistEvidenceRef {
  kind: string;
  stableId: string;
}

export interface ChatCloudAllowlistPacket {
  schemaVersion: typeof NEXUS_CHAT_CLOUD_ALLOWLIST_PACKET_VERSION;
  intent: 'answer' | 'read' | 'clarify' | 'unsupported';
  domain: ChatCloudAllowlistDomain;
  capabilityId: string;
  anonymizedEntityIds: string[];
  evidenceFingerprints: string[];
  locale: string;
  complexityScore: number;
  escalationReason: ChatCloudAllowlistEscalationReason;
}

export type ChatCloudAllowlistPacketBuildResult =
  | { ok: true; packet: ChatCloudAllowlistPacket }
  | { ok: false; denialReason: ChatCloudAllowlistDenialReason };

export interface ChatCloudAllowlistPacketInput {
  intent: ChatCloudAllowlistPacket['intent'];
  domain: ChatCloudAllowlistDomain | string;
  capabilityId: string;
  locale: string;
  complexityScore: number;
  escalationReason: string;
  entityRefs?: ChatCloudAllowlistEntityRef[];
  evidenceRefs?: ChatCloudAllowlistEvidenceRef[];
  requiredFactsNeverCloud?: boolean;
  cloudProviderEnabled?: boolean;
  cloudBudgetAvailable?: boolean;
  domainAllowsCloud?: boolean;
}

const TEST_CLOUD_ALLOWLIST_HMAC_SECRET = 'test-chat-v2-cloud-allowlist-packet-secret';
const SAFE_CLOUD_DOMAINS = new Set<ChatCloudAllowlistDomain>([
  'general',
  'training',
  'cooking',
  'content',
  'finance_education',
]);
const SAFE_CLOUD_INTENTS = new Set<ChatCloudAllowlistIntent>([
  'answer',
  'read',
  'clarify',
  'unsupported',
]);
const SAFE_CLOUD_ESCALATION_REASONS = new Set<ChatCloudAllowlistEscalationReason>([
  'local_queue_saturation',
  'queue_fallback_candidate',
  'cloud_allowlist_candidate',
]);
const CHAT_CLOUD_ALLOWLIST_PACKET_KEYS = new Set([
  'schemaVersion',
  'intent',
  'domain',
  'capabilityId',
  'anonymizedEntityIds',
  'evidenceFingerprints',
  'locale',
  'complexityScore',
  'escalationReason',
]);

export function buildChatCloudAllowlistPacket(
  input: ChatCloudAllowlistPacketInput,
): ChatCloudAllowlistPacketBuildResult {
  if (input.cloudProviderEnabled === false) {
    return { ok: false, denialReason: 'cloud_provider_disabled' };
  }
  if (input.cloudBudgetAvailable === false) {
    return { ok: false, denialReason: 'cloud_budget_exceeded' };
  }
  if (input.requiredFactsNeverCloud) {
    return { ok: false, denialReason: 'required_fact_never_cloud' };
  }
  const intent = normalizeCloudAllowlistIntent(input.intent);
  if (!intent) {
    return { ok: false, denialReason: 'insufficient_safe_context_for_cloud' };
  }
  const domain = normalizeCloudAllowlistDomain(input.domain);
  if (!domain || input.domainAllowsCloud === false) {
    return { ok: false, denialReason: 'domain_disallows_cloud' };
  }
  const capabilityId = safeToken(input.capabilityId);
  const escalationReason = normalizeCloudAllowlistEscalationReason(input.escalationReason);
  const entityIds = (input.entityRefs ?? []).map((ref) => hmacCloudToken('entity', `${ref.kind}:${ref.stableId}`));
  const evidenceFingerprints = (input.evidenceRefs ?? []).map((ref) =>
    hmacCloudToken('evidence', `${ref.kind}:${ref.stableId}`),
  );
  if (!capabilityId || !escalationReason || (entityIds.length === 0 && evidenceFingerprints.length === 0)) {
    return { ok: false, denialReason: 'insufficient_safe_context_for_cloud' };
  }
  return {
    ok: true,
    packet: {
      schemaVersion: NEXUS_CHAT_CLOUD_ALLOWLIST_PACKET_VERSION,
      intent,
      domain,
      capabilityId,
      anonymizedEntityIds: entityIds,
      evidenceFingerprints,
      locale: normalizeLocale(input.locale),
      complexityScore: clamp01(input.complexityScore),
      escalationReason,
    },
  };
}

export function validateChatCloudAllowlistPacket(packet: unknown): packet is ChatCloudAllowlistPacket {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return false;
  if (!Object.keys(packet as Record<string, unknown>).every((key) => CHAT_CLOUD_ALLOWLIST_PACKET_KEYS.has(key))) {
    return false;
  }
  const record = packet as ChatCloudAllowlistPacket;
  if (record.schemaVersion !== NEXUS_CHAT_CLOUD_ALLOWLIST_PACKET_VERSION) return false;
  if (!normalizeCloudAllowlistIntent(record.intent)) return false;
  if (!normalizeCloudAllowlistDomain(record.domain)) return false;
  if (safeToken(record.capabilityId) !== record.capabilityId) return false;
  if (normalizeLocale(record.locale) !== record.locale) return false;
  if (!Number.isFinite(record.complexityScore) || record.complexityScore < 0 || record.complexityScore > 1) {
    return false;
  }
  if (!normalizeCloudAllowlistEscalationReason(record.escalationReason)) return false;
  if (!Array.isArray(record.anonymizedEntityIds) || !record.anonymizedEntityIds.every(isCloudHmacToken)) return false;
  if (!Array.isArray(record.evidenceFingerprints) || !record.evidenceFingerprints.every(isCloudHmacToken)) return false;
  return record.anonymizedEntityIds.length > 0 || record.evidenceFingerprints.length > 0;
}

export function buildChatCloudAllowlistPacketSample(input: {
  sampleId: string;
  result: ChatCloudAllowlistPacketBuildResult;
  sentToCloud: boolean;
}): ChatCloudAllowlistPacketSample {
  if (!input.result.ok) {
    return {
      sampleId: input.sampleId,
      sentToCloud: false,
      rawPrivateFieldCount: 0,
      denied: true,
      denialReason: input.result.denialReason,
      denialReasonObservable: true,
      hmacEntityIdCount: 0,
      nonHmacEntityIdCount: 0,
      hmacEvidenceFingerprintCount: 0,
      nonHmacEvidenceFingerprintCount: 0,
    };
  }
  const audit = auditChatCloudAllowlistIdentifiers({
    entityIds: input.result.packet.anonymizedEntityIds,
    evidenceFingerprints: input.result.packet.evidenceFingerprints,
  });
  return {
    sampleId: input.sampleId,
    sentToCloud: input.sentToCloud,
    rawPrivateFieldCount: countRawPrivateCloudFields(input.result.packet),
    denied: false,
    denialReasonObservable: true,
    ...audit,
  };
}

export function countRawPrivateCloudFields(packet: ChatCloudAllowlistPacket): number {
  return (validateChatCloudAllowlistPacket(packet) ? 0 : 1) + countUnsafePacketStrings(packet, []);
}

function normalizeCloudAllowlistIntent(value: string): ChatCloudAllowlistIntent | null {
  const normalized = value.trim().toLowerCase();
  return SAFE_CLOUD_INTENTS.has(normalized as ChatCloudAllowlistIntent)
    ? normalized as ChatCloudAllowlistIntent
    : null;
}

function normalizeCloudAllowlistDomain(value: string): ChatCloudAllowlistDomain | null {
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_');
  return SAFE_CLOUD_DOMAINS.has(normalized as ChatCloudAllowlistDomain)
    ? normalized as ChatCloudAllowlistDomain
    : null;
}

function normalizeCloudAllowlistEscalationReason(value: string): ChatCloudAllowlistEscalationReason | null {
  const normalized = value.trim().toLowerCase();
  return SAFE_CLOUD_ESCALATION_REASONS.has(normalized as ChatCloudAllowlistEscalationReason)
    ? normalized as ChatCloudAllowlistEscalationReason
    : null;
}

function normalizeLocale(value: string): string {
  const raw = value.trim();
  if (/^pt[-_]?br$/i.test(raw)) return 'pt-BR';
  if (/^pt[-_]?pt$/i.test(raw)) return 'pt-PT';
  if (/^pt\b/i.test(raw)) return 'pt-BR';
  if (/^en\b/i.test(raw)) return 'en';
  if (/^es\b/i.test(raw)) return 'es';
  return 'en';
}

function safeToken(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').replace(/_+/g, '_');
  const trimmed = normalized.replace(/^_+|_+$/g, '');
  return trimmed.length > 0 && trimmed.length <= 96 ? trimmed : null;
}

function hmacCloudToken(kind: string, value: string): string {
  return `hmac:${kind}:${crypto.createHmac('sha256', resolveCloudAllowlistHmacSecret()).update(value).digest('hex')}`;
}

function isCloudHmacToken(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^hmac:[a-z0-9_-]+:[a-f0-9]{64}$/i.test(value.trim());
}

function resolveCloudAllowlistHmacSecret(): string {
  const configured = process.env.CHAT_V2_CLOUD_ALLOWLIST_HMAC_SECRET
    || process.env.CHAT_V2_EVIDENCE_HMAC_SECRET
    || process.env.IOS_API_JWT_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'test') return TEST_CLOUD_ALLOWLIST_HMAC_SECRET;
  throw new Error('CHAT_V2_CLOUD_ALLOWLIST_HMAC_SECRET is required to build cloud allowlist packets');
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function countUnsafePacketStrings(value: unknown, path: string[]): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, child, index) => sum + countUnsafePacketStrings(child, [...path, String(index)]), 0);
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).reduce((sum, [key, child]) =>
      sum + countUnsafePacketStrings(child, [...path, key]), 0);
  }
  if (typeof value !== 'string') return 0;
  const key = path[path.length - 1] ?? '';
  if (/^(schemaVersion|intent|domain|capabilityId|locale|escalationReason)$/i.test(key)) return 0;
  if (/^(anonymizedEntityIds|evidenceFingerprints|\d+)$/i.test(key)) {
    return /^hmac:[a-z0-9_-]+:[a-f0-9]{64}$/i.test(value.trim()) ? 0 : 1;
  }
  return 1;
}
