// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';

import { getChatCoreV2Capability } from './capability-registry';
import type {
  AuditSensitivity,
  ChatCoreV2Domain,
  ChatCoreV2ReadContextPack,
  ChatCoreV2ReadModelResult,
  ExecutionPreconditions,
  ReadModelFreshness,
  ReadModelFreshnessStatus,
} from './types';

export const CHAT_CORE_V2_READ_MODEL_SCHEMA_VERSION = 'chat_core_v2_read_model@1.0.0';
export const CHAT_CORE_V2_READ_CONTEXT_PACK_SCHEMA_VERSION = 'chat_core_v2_read_context_pack@1.0.0';

export interface BuildChatCoreV2ReadModelResultInput<TData> {
  capabilityId: string;
  domain: ChatCoreV2Domain;
  data: TData;
  sourceEntityIds?: string[];
  sourceVersions?: Record<string, string>;
  generatedAt?: string;
  maxSourceAgeSeconds?: number;
  sensitivity?: AuditSensitivity;
  summary?: string;
  locale?: string;
  now?: Date;
}

const SENSITIVITY_RANK: Record<AuditSensitivity, number> = {
  normal: 0,
  personal: 1,
  health_adjacent: 2,
  financial: 3,
  credential_adjacent: 4,
};

export function buildChatCoreV2ReadModelResult<TData>(
  input: BuildChatCoreV2ReadModelResultInput<TData>,
): ChatCoreV2ReadModelResult<TData> {
  const capability = getChatCoreV2Capability(input.capabilityId);
  if (!capability) {
    throw new Error(`Unknown Chat Core v2 capability: ${input.capabilityId}`);
  }
  if (capability.domain !== input.domain) {
    throw new Error(`Read model domain mismatch for ${input.capabilityId}: expected ${capability.domain}`);
  }
  if (!capability.routeMethods.includes('deterministic_read')) {
    throw new Error(`Capability ${input.capabilityId} is not a deterministic read model capability`);
  }
  if (capability.support.read !== 'supported') {
    throw new Error(`Capability ${input.capabilityId} does not support read models`);
  }

  const sourceVersions = normalizeSourceVersions(input.sourceVersions ?? {});
  const sourceEntityIds = uniqueNonEmpty([
    ...(input.sourceEntityIds ?? []),
    ...Object.keys(sourceVersions),
  ]);
  const freshness = buildReadModelFreshness({
    generatedAt: input.generatedAt,
    maxSourceAgeSeconds: input.maxSourceAgeSeconds,
    now: input.now,
  });

  return {
    schemaVersion: CHAT_CORE_V2_READ_MODEL_SCHEMA_VERSION,
    capabilityId: input.capabilityId,
    domain: input.domain,
    data: input.data,
    sourceEntityIds,
    sourceVersions,
    freshness,
    sensitivity: input.sensitivity ?? capability.sensitivity,
    summary: input.summary,
    locale: input.locale,
  };
}

export function buildReadModelFreshness(input: {
  generatedAt?: string;
  maxSourceAgeSeconds?: number;
  now?: Date;
} = {}): ReadModelFreshness {
  const now = input.now ?? new Date();
  const generatedAt = input.generatedAt ?? now.toISOString();
  const maxSourceAgeSeconds = normalizeMaxSourceAge(input.maxSourceAgeSeconds);
  return {
    generatedAt,
    maxSourceAgeSeconds,
    status: classifyReadModelFreshness(generatedAt, maxSourceAgeSeconds, now),
  };
}

export function classifyReadModelFreshness(
  generatedAt: string,
  maxSourceAgeSeconds?: number,
  now = new Date(),
): ReadModelFreshnessStatus {
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) return 'unknown';
  if (maxSourceAgeSeconds === undefined) return 'fresh';

  const ageSeconds = Math.max(0, Math.floor((now.getTime() - generatedAtMs) / 1000));
  if (ageSeconds > maxSourceAgeSeconds) return 'stale';
  return ageSeconds <= 5 ? 'live' : 'fresh';
}

export function isReadModelFreshEnough(
  result: Pick<ChatCoreV2ReadModelResult, 'freshness'>,
): boolean {
  return result.freshness.status === 'live' || result.freshness.status === 'fresh';
}

export function buildReadModelExecutionPreconditions(
  resultOrResults: ChatCoreV2ReadModelResult | ChatCoreV2ReadModelResult[],
): ExecutionPreconditions {
  const results = Array.isArray(resultOrResults) ? resultOrResults : [resultOrResults];
  return {
    requiredEntityVersions: mergeSourceVersions(results),
    invariants: [],
  };
}

export function buildChatCoreV2ReadContextPack(
  results: ChatCoreV2ReadModelResult[],
  input: { generatedAt?: string; now?: Date } = {},
): ChatCoreV2ReadContextPack {
  const normalizedResults = [...results].sort(compareReadModelResults);
  const sourceVersions = mergeSourceVersions(normalizedResults);
  const sourceEntityIds = uniqueNonEmpty([
    ...normalizedResults.flatMap((result) => result.sourceEntityIds),
    ...Object.keys(sourceVersions),
  ]);
  const domains = uniqueDomains(normalizedResults.map((result) => result.domain));
  const sensitivity = highestSensitivity(normalizedResults.map((result) => result.sensitivity));
  const generatedAt = input.generatedAt ?? (input.now ?? new Date()).toISOString();
  const contextHash = hashReadContext({
    schemaVersion: CHAT_CORE_V2_READ_CONTEXT_PACK_SCHEMA_VERSION,
    results: normalizedResults.map((result) => ({
      schemaVersion: result.schemaVersion,
      capabilityId: result.capabilityId,
      domain: result.domain,
      data: result.data,
      sourceEntityIds: result.sourceEntityIds,
      sourceVersions: result.sourceVersions,
      sensitivity: result.sensitivity,
      summary: result.summary,
      locale: result.locale,
    })),
  });

  return {
    schemaVersion: CHAT_CORE_V2_READ_CONTEXT_PACK_SCHEMA_VERSION,
    results: normalizedResults,
    domains,
    sourceEntityIds,
    sourceVersions,
    sensitivity,
    generatedAt,
    contextHash,
  };
}

function compareReadModelResults(a: ChatCoreV2ReadModelResult, b: ChatCoreV2ReadModelResult): number {
  return `${a.domain}:${a.capabilityId}`.localeCompare(`${b.domain}:${b.capabilityId}`);
}

function mergeSourceVersions(results: ChatCoreV2ReadModelResult[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const result of results) {
    for (const [entityId, version] of Object.entries(result.sourceVersions)) {
      if (merged[entityId] !== undefined && merged[entityId] !== version) {
        throw new Error(`Conflicting source version for ${entityId}`);
      }
      merged[entityId] = version;
    }
  }
  return merged;
}

function normalizeSourceVersions(input: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = key.trim();
    const normalizedValue = value.trim();
    if (!normalizedKey || !normalizedValue) continue;
    output[normalizedKey] = normalizedValue;
  }
  return output;
}

function normalizeMaxSourceAge(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('maxSourceAgeSeconds must be a non-negative finite number');
  }
  return Math.floor(value);
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function uniqueDomains(values: ChatCoreV2Domain[]): ChatCoreV2Domain[] {
  return [...new Set(values)];
}

function highestSensitivity(values: AuditSensitivity[]): AuditSensitivity {
  let highest: AuditSensitivity = 'normal';
  for (const value of values) {
    if (SENSITIVITY_RANK[value] > SENSITIVITY_RANK[highest]) highest = value;
  }
  return highest;
}

function hashReadContext(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}
