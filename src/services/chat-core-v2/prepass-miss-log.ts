// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHmac } from 'crypto';

export const CHAT_CORE_V2_PREPASS_RECALL_FAILURE_SCHEMA_VERSION = 'prepass_recall_failure@1.0.0';

export interface BuildPrepassRecallFailureInput {
  hmacSecret: string;
  tenantId: string;
  userId: string;
  message: string;
  locale: string;
  candidateCapabilityIds: string[];
  finalCapabilityId?: string;
  reasonCodes: string[];
  metadata?: Record<string, string | number | boolean | null | undefined>;
  createdAt?: string;
}

export type PrepassRecallFailureSafeMetadataValue = number | boolean | null;

export interface PrepassRecallFailureRecord {
  schemaVersion: typeof CHAT_CORE_V2_PREPASS_RECALL_FAILURE_SCHEMA_VERSION;
  messageHash: string;
  tenantHash: string;
  userHash: string;
  locale: string;
  candidateCapabilityIds: string[];
  finalCapabilityId?: string;
  reasonCodes: string[];
  metadata: Record<string, PrepassRecallFailureSafeMetadataValue>;
  createdAt: string;
}

export function buildPrepassRecallFailureRecord(input: BuildPrepassRecallFailureInput): PrepassRecallFailureRecord {
  return {
    schemaVersion: CHAT_CORE_V2_PREPASS_RECALL_FAILURE_SCHEMA_VERSION,
    messageHash: hmacHex(input.hmacSecret, `${input.tenantId}:${input.userId}:${input.message}`),
    tenantHash: hmacHex(input.hmacSecret, input.tenantId),
    userHash: hmacHex(input.hmacSecret, `${input.tenantId}:${input.userId}`),
    locale: input.locale.trim() || 'unknown',
    candidateCapabilityIds: normalizeList(input.candidateCapabilityIds),
    finalCapabilityId: input.finalCapabilityId?.trim() || undefined,
    reasonCodes: normalizeList(input.reasonCodes),
    metadata: sanitizeSafeMetadata(input.metadata ?? {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function normalizeList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sanitizeSafeMetadata(
  metadata: Record<string, string | number | boolean | null | undefined>,
): Record<string, PrepassRecallFailureSafeMetadataValue> {
  const out: Record<string, PrepassRecallFailureSafeMetadataValue> = {};
  for (const key of Object.keys(metadata).sort()) {
    const value = metadata[key];
    if (value === undefined) continue;
    if (isSensitiveMetadataKey(key)) continue;
    if (typeof value === 'string') continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out;
}

function isSensitiveMetadataKey(key: string): boolean {
  return /(?:message|prompt|raw|content|email|phone|token|secret|context|name|title|description|notes?)/i.test(key);
}
