// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHmac } from 'crypto';

import {
  CHAT_TURN_PLAN_MICRO_DOMAIN_VALUES,
  CHAT_TURN_PLAN_MICRO_ESCALATION_REASON_VALUES,
  CHAT_TURN_PLAN_MICRO_INTENT_VALUES,
  type ChatTurnPlanMicroIntent,
  type ChatTurnPlanMicroEscalationReason,
} from './plan-schema';
import type { ChatCoreV2Domain } from './types';

export const CLOUD_ALLOWLIST_PACKET_SCHEMA_VERSION = 'cloud_allowlist_packet@1.0.0';

export type CloudAllowlistDenialReason =
  | 'required_fact_never_cloud'
  | 'insufficient_safe_context_for_cloud'
  | 'cloud_provider_disabled'
  | 'cloud_budget_exceeded'
  | 'domain_disallows_cloud';

export interface CloudAllowlistEntityRefInput {
  entityType: string;
  entityId: string;
}

export interface CloudAllowlistEntityRef {
  entityType: string;
  scopedEntityId: string;
}

export interface CloudAllowlistPacket {
  schemaVersion: typeof CLOUD_ALLOWLIST_PACKET_SCHEMA_VERSION;
  intent: ChatTurnPlanMicroIntent;
  capabilityId: string;
  domain: ChatCoreV2Domain;
  hmacEntityIds: CloudAllowlistEntityRef[];
  evidenceFingerprints: string[];
  locale: string;
  complexityScore: number;
  escalationReason: ChatTurnPlanMicroEscalationReason;
}

export type CloudAllowlistPacketResult =
  | { ok: true; packet: CloudAllowlistPacket }
  | { ok: false; denialReason: CloudAllowlistDenialReason };

export interface BuildCloudAllowlistPacketInput {
  enabled: boolean;
  budgetAvailable: boolean;
  domainDisallowsCloud?: boolean;
  requiredFactNeverCloud?: boolean;
  tenantId: string;
  hmacSecret: string;
  intent: ChatTurnPlanMicroIntent;
  capabilityId: string;
  domain: ChatCoreV2Domain;
  entityRefs?: CloudAllowlistEntityRefInput[];
  evidenceFingerprints?: string[];
  locale: string;
  complexityScore: number;
  escalationReason: ChatTurnPlanMicroEscalationReason;
}

const CLOUD_ALLOWLIST_PACKET_KEYS = new Set([
  'schemaVersion',
  'intent',
  'capabilityId',
  'domain',
  'hmacEntityIds',
  'evidenceFingerprints',
  'locale',
  'complexityScore',
  'escalationReason',
]);

const CLOUD_ALLOWLIST_ENTITY_REF_KEYS = new Set([
  'entityType',
  'scopedEntityId',
]);

export function buildCloudAllowlistPacket(input: BuildCloudAllowlistPacketInput): CloudAllowlistPacketResult {
  if (!input.enabled) return { ok: false, denialReason: 'cloud_provider_disabled' };
  if (!input.budgetAvailable) return { ok: false, denialReason: 'cloud_budget_exceeded' };
  if (input.domainDisallowsCloud) return { ok: false, denialReason: 'domain_disallows_cloud' };
  if (input.requiredFactNeverCloud) return { ok: false, denialReason: 'required_fact_never_cloud' };
  if (input.hmacSecret.trim().length === 0) {
    return { ok: false, denialReason: 'insufficient_safe_context_for_cloud' };
  }

  const evidenceFingerprints = normalizeFingerprints(input.evidenceFingerprints ?? []);
  const safeEntityRefs = (input.entityRefs ?? []).filter(isSafeEntityRefInput);
  const hmacEntityIds = safeEntityRefs.map((ref) => ({
    entityType: ref.entityType.trim(),
    scopedEntityId: hmacTenantScopedEntityId({
      tenantId: input.tenantId,
      hmacSecret: input.hmacSecret,
      entityType: ref.entityType.trim(),
      entityId: ref.entityId,
    }),
  }));

  if (evidenceFingerprints.length === 0 && hmacEntityIds.length === 0) {
    return { ok: false, denialReason: 'insufficient_safe_context_for_cloud' };
  }

  return {
    ok: true,
    packet: {
      schemaVersion: CLOUD_ALLOWLIST_PACKET_SCHEMA_VERSION,
      intent: input.intent,
      capabilityId: input.capabilityId,
      domain: input.domain,
      hmacEntityIds,
      evidenceFingerprints,
      locale: input.locale,
      complexityScore: clampUnit(input.complexityScore),
      escalationReason: input.escalationReason,
    },
  };
}

export function validateCloudAllowlistPacket(packet: unknown): packet is CloudAllowlistPacket {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return false;
  if (!hasOnlyKeys(packet as Record<string, unknown>, CLOUD_ALLOWLIST_PACKET_KEYS)) return false;
  const record = packet as CloudAllowlistPacket;
  if (record.schemaVersion !== CLOUD_ALLOWLIST_PACKET_SCHEMA_VERSION) return false;
  if (!isAllowedIntent(record.intent)) return false;
  if (!isAllowedDomain(record.domain)) return false;
  if (!isAllowedEscalationReason(record.escalationReason)) return false;
  if (!isSafeIdentifier(record.capabilityId)) return false;
  if (!isSafeLocale(record.locale)) return false;
  if (!Number.isFinite(record.complexityScore) || record.complexityScore < 0 || record.complexityScore > 1) {
    return false;
  }
  if (!Array.isArray(record.hmacEntityIds) || !record.hmacEntityIds.every((ref) =>
    ref
    && typeof ref === 'object'
    && !Array.isArray(ref)
    && hasOnlyKeys(ref as unknown as Record<string, unknown>, CLOUD_ALLOWLIST_ENTITY_REF_KEYS)
    && isSafeIdentifier((ref as CloudAllowlistEntityRef).entityType)
    && /^hmac:[a-z][a-z0-9_]{0,63}:[a-f0-9]{32}$/.test((ref as CloudAllowlistEntityRef).scopedEntityId)
  )) {
    return false;
  }
  if (!Array.isArray(record.evidenceFingerprints) || !record.evidenceFingerprints.every(isSafeEvidenceFingerprint)) {
    return false;
  }
  return record.hmacEntityIds.length > 0 || record.evidenceFingerprints.length > 0;
}

export function hmacTenantScopedEntityId(input: {
  tenantId: string;
  hmacSecret: string;
  entityType: string;
  entityId: string;
}): string {
  const digest = createHmac('sha256', input.hmacSecret)
    .update(`${input.tenantId}:${input.entityType}:${input.entityId}`)
    .digest('hex')
    .slice(0, 32);
  return `hmac:${input.entityType}:${digest}`;
}

export function hmacTenantScopedEvidenceFingerprint(input: {
  tenantId: string;
  hmacSecret: string;
  sourceType: string;
  sourceValue: string;
}): string {
  const digest = createHmac('sha256', input.hmacSecret)
    .update(`${input.tenantId}:evidence:${input.sourceType}:${input.sourceValue}`)
    .digest('hex')
    .slice(0, 32);
  return `hmac:evidence:${input.sourceType}:${digest}`;
}

function normalizeFingerprints(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(isSafeEvidenceFingerprint))];
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function isSafeEntityRefInput(ref: CloudAllowlistEntityRefInput): boolean {
  return isSafeIdentifier(ref.entityType) && String(ref.entityId ?? '').trim().length > 0;
}

function isSafeIdentifier(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}(?:[._][a-z0-9_]{1,64})*$/.test(value.trim());
}

function isSafeLocale(value: string): boolean {
  return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(value.trim());
}

function isSafeEvidenceFingerprint(value: string): boolean {
  const normalized = value.trim();
  return (
    /^hmac:evidence:[a-z][a-z0-9_-]{0,63}:[a-f0-9]{32}$/.test(normalized)
    || /^evidence:[a-z][a-z0-9_.:-]{0,95}$/.test(normalized)
  );
}

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function isAllowedIntent(value: unknown): value is ChatTurnPlanMicroIntent {
  return typeof value === 'string' && (CHAT_TURN_PLAN_MICRO_INTENT_VALUES as readonly string[]).includes(value);
}

function isAllowedDomain(value: unknown): value is ChatCoreV2Domain {
  return typeof value === 'string' && (CHAT_TURN_PLAN_MICRO_DOMAIN_VALUES as readonly string[]).includes(value);
}

function isAllowedEscalationReason(value: unknown): value is ChatTurnPlanMicroEscalationReason {
  return typeof value === 'string' && (CHAT_TURN_PLAN_MICRO_ESCALATION_REASON_VALUES as readonly string[]).includes(value);
}
