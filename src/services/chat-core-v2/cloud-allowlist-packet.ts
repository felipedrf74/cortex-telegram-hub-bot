// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHmac } from 'crypto';

import type { ChatTurnPlanMicroIntent, ChatTurnPlanMicroEscalationReason } from './plan-schema';
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

export function buildCloudAllowlistPacket(input: BuildCloudAllowlistPacketInput): CloudAllowlistPacketResult {
  if (!input.enabled) return { ok: false, denialReason: 'cloud_provider_disabled' };
  if (!input.budgetAvailable) return { ok: false, denialReason: 'cloud_budget_exceeded' };
  if (input.domainDisallowsCloud) return { ok: false, denialReason: 'domain_disallows_cloud' };
  if (input.requiredFactNeverCloud) return { ok: false, denialReason: 'required_fact_never_cloud' };

  const evidenceFingerprints = normalizeFingerprints(input.evidenceFingerprints ?? []);
  const hmacEntityIds = (input.entityRefs ?? []).map((ref) => ({
    entityType: ref.entityType,
    scopedEntityId: hmacTenantScopedEntityId({
      tenantId: input.tenantId,
      hmacSecret: input.hmacSecret,
      entityType: ref.entityType,
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

function normalizeFingerprints(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}
