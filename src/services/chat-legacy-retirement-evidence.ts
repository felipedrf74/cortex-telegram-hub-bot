// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from './database';
import { countUnsafeChatShadowRawFields } from './chat-shadow-gate-readiness';
import {
  evaluateChatLegacyRetirementReadiness,
  type ChatLegacyRetirementReadinessInput,
  type ChatLegacyRetirementReadinessResult,
  type ChatLegacyRouteExitSample,
} from './chat-legacy-retirement-readiness';
import { logger } from '../utils/logger';

export type ChatV2LegacyRetirementEvidenceSource = 'runtime_route' | 'local_sandbox_seed';
export type ChatV2LegacyRetirementEvidenceKind = 'route_exit' | 'fallback_rate' | 'verify_run';

export interface ChatV2LegacyRouteExitEvidenceInput {
  evidenceSource?: ChatV2LegacyRetirementEvidenceSource;
  requestId: string;
  routeId: string;
  replaced: boolean;
  tested: boolean;
  shadowParityRate: number;
  sampleCount: number;
  safeMetadata?: Record<string, unknown>;
}

export interface ChatV2LegacyFallbackRateEvidenceInput {
  evidenceSource?: ChatV2LegacyRetirementEvidenceSource;
  requestId: string;
  legacyFallbackRate24h: number;
  safeMetadata?: Record<string, unknown>;
}

export interface ChatV2LegacyVerifyRunEvidenceInput {
  evidenceSource?: ChatV2LegacyRetirementEvidenceSource;
  requestId: string;
  fullVerifyClean: boolean;
  safeMetadata?: Record<string, unknown>;
}

type ChatV2LegacyRetirementEvidenceRow = {
  evidence_source: ChatV2LegacyRetirementEvidenceSource;
  evidence_kind: ChatV2LegacyRetirementEvidenceKind;
  request_id: string;
  sample_hmac: string;
  route_id: string | null;
  replaced: number | null;
  tested: number | null;
  shadow_parity_rate: number | null;
  route_sample_count: number | null;
  legacy_fallback_rate_24h: number | null;
  full_verify_clean: number | null;
  raw_field_audit_count: number;
  safe_metadata_json: string;
};

const FALLBACK_TEST_HMAC_SECRET = 'test-chat-v2-legacy-retirement-evidence-secret';
const DEFAULT_READINESS_EVIDENCE_SOURCES: ChatV2LegacyRetirementEvidenceSource[] = ['runtime_route'];

export function isChatV2LegacyRetirementEvidenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthy(env.CHAT_V2_LEGACY_RETIREMENT_EVIDENCE_ENABLED)
    || env.CHAT_V2_LEGACY_RETIREMENT_EVIDENCE_MODE === 'evidence'
    || env.CHAT_V2_COMPLETION_MODE === 'on';
}

export function recordChatV2LegacyRouteExitEvidence(input: ChatV2LegacyRouteExitEvidenceInput): void {
  if (!isChatV2LegacyRetirementEvidenceEnabled()) return;
  const safeMetadata = buildSafeMetadata('route_exit', input.safeMetadata);
  insertChatV2LegacyRetirementEvidenceRow({
    evidence_source: input.evidenceSource ?? 'runtime_route',
    evidence_kind: 'route_exit',
    request_id: input.requestId,
    sample_hmac: hmacToken('legacy-route', `${input.requestId}:${input.routeId}`),
    route_id: input.routeId,
    replaced: boolInt(input.replaced),
    tested: boolInt(input.tested),
    shadow_parity_rate: clamp01(input.shadowParityRate),
    route_sample_count: Math.max(0, Math.floor(input.sampleCount)),
    legacy_fallback_rate_24h: null,
    full_verify_clean: null,
    raw_field_audit_count: countUnsafeChatShadowRawFields(safeMetadata),
    safe_metadata_json: JSON.stringify(safeMetadata),
  });
}

export function recordChatV2LegacyFallbackRateEvidence(input: ChatV2LegacyFallbackRateEvidenceInput): void {
  if (!isChatV2LegacyRetirementEvidenceEnabled()) return;
  const safeMetadata = buildSafeMetadata('fallback_rate', input.safeMetadata);
  insertChatV2LegacyRetirementEvidenceRow({
    evidence_source: input.evidenceSource ?? 'runtime_route',
    evidence_kind: 'fallback_rate',
    request_id: input.requestId,
    sample_hmac: hmacToken('legacy-fallback-rate', input.requestId),
    route_id: null,
    replaced: null,
    tested: null,
    shadow_parity_rate: null,
    route_sample_count: null,
    legacy_fallback_rate_24h: Math.max(0, input.legacyFallbackRate24h),
    full_verify_clean: null,
    raw_field_audit_count: countUnsafeChatShadowRawFields(safeMetadata),
    safe_metadata_json: JSON.stringify(safeMetadata),
  });
}

export function recordChatV2LegacyVerifyRunEvidence(input: ChatV2LegacyVerifyRunEvidenceInput): void {
  if (!isChatV2LegacyRetirementEvidenceEnabled()) return;
  const safeMetadata = buildSafeMetadata('verify_run', input.safeMetadata);
  insertChatV2LegacyRetirementEvidenceRow({
    evidence_source: input.evidenceSource ?? 'runtime_route',
    evidence_kind: 'verify_run',
    request_id: input.requestId,
    sample_hmac: hmacToken('legacy-verify-run', input.requestId),
    route_id: null,
    replaced: null,
    tested: null,
    shadow_parity_rate: null,
    route_sample_count: null,
    legacy_fallback_rate_24h: null,
    full_verify_clean: boolInt(input.fullVerifyClean),
    raw_field_audit_count: countUnsafeChatShadowRawFields(safeMetadata),
    safe_metadata_json: JSON.stringify(safeMetadata),
  });
}

export function safeRecordChatV2LegacyRouteExitEvidence(input: ChatV2LegacyRouteExitEvidenceInput): void {
  try {
    recordChatV2LegacyRouteExitEvidence(input);
  } catch (err) {
    logger.warn({ err, routeId: input.routeId }, 'ChatV2 legacy route-exit evidence recording failed');
  }
}

export function loadChatV2LegacyRetirementReadinessInput(
  limit = 500,
  sources: readonly ChatV2LegacyRetirementEvidenceSource[] = DEFAULT_READINESS_EVIDENCE_SOURCES,
): ChatLegacyRetirementReadinessInput {
  const sourceFilter = buildEvidenceSourceFilter(sources);
  const rows = getDb().prepare(`
    SELECT evidence_kind, route_id, replaced, tested, shadow_parity_rate,
           route_sample_count, legacy_fallback_rate_24h, full_verify_clean,
           safe_metadata_json
    FROM chat_v2_legacy_retirement_evidence
    WHERE evidence_source IN (${sourceFilter.placeholders})
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(...sourceFilter.values, Math.max(1, Math.floor(limit))) as Array<{
    evidence_kind: string;
    route_id: string | null;
    replaced: number | null;
    tested: number | null;
    shadow_parity_rate: number | null;
    route_sample_count: number | null;
    legacy_fallback_rate_24h: number | null;
    full_verify_clean: number | null;
    safe_metadata_json: string | null;
  }>;

  const routeSamples = latestRouteSamples(rows);
  const fallbackRate = rows.find((row) => row.evidence_kind === 'fallback_rate')?.legacy_fallback_rate_24h;
  const verifyClean = rows.find((row) => row.evidence_kind === 'verify_run')?.full_verify_clean;
  return {
    routeSamples,
    legacyFallbackRate24h: typeof fallbackRate === 'number' ? fallbackRate : Number.NaN,
    fullVerifyClean: verifyClean === 1,
  };
}

export function evaluateRecordedChatV2LegacyRetirementReadiness(
  limit = 500,
  sources: readonly ChatV2LegacyRetirementEvidenceSource[] = DEFAULT_READINESS_EVIDENCE_SOURCES,
): ChatLegacyRetirementReadinessResult {
  return evaluateChatLegacyRetirementReadiness(
    loadChatV2LegacyRetirementReadinessInput(limit, sources),
  );
}

function insertChatV2LegacyRetirementEvidenceRow(row: ChatV2LegacyRetirementEvidenceRow): void {
  getDb().prepare(`
    INSERT INTO chat_v2_legacy_retirement_evidence (
      evidence_source, evidence_kind, request_id, sample_hmac, sample_identifier_kind,
      route_id, replaced, tested, shadow_parity_rate, route_sample_count,
      legacy_fallback_rate_24h, full_verify_clean, raw_field_audit_count,
      safe_metadata_json
    ) VALUES (?, ?, ?, ?, 'hmac', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.evidence_source,
    row.evidence_kind,
    row.request_id,
    row.sample_hmac,
    row.route_id,
    row.replaced,
    row.tested,
    row.shadow_parity_rate,
    row.route_sample_count,
    row.legacy_fallback_rate_24h,
    row.full_verify_clean,
    row.raw_field_audit_count,
    row.safe_metadata_json,
  );
}

function latestRouteSamples(rows: Array<{
  evidence_kind: string;
  route_id: string | null;
  replaced: number | null;
  tested: number | null;
  shadow_parity_rate: number | null;
  route_sample_count: number | null;
  safe_metadata_json?: string | null;
}>): ChatLegacyRouteExitSample[] {
  const rowsByRoute = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.evidence_kind !== 'route_exit' || !row.route_id) continue;
    const existing = rowsByRoute.get(row.route_id) ?? [];
    existing.push(row);
    rowsByRoute.set(row.route_id, existing);
  }
  return [...rowsByRoute.entries()].map(([routeId, routeRows]) => {
    const selected = routeRows.find((row) => !isInventoryOnlyRouteExitRow(row.safe_metadata_json)) ?? routeRows[0]!;
    const metadata = parseSafeMetadata(selected.safe_metadata_json);
    return {
      routeId,
      replaced: selected.replaced === 1,
      tested: selected.tested === 1,
      shadowParityRate: typeof selected.shadow_parity_rate === 'number' ? selected.shadow_parity_rate : 0,
      sampleCount: typeof selected.route_sample_count === 'number' ? selected.route_sample_count : 0,
      evaluator: typeof metadata.evaluator === 'string' ? metadata.evaluator : undefined,
      peerReviewSignoffHash: typeof metadata.peerReviewSignoffHash === 'string'
        ? metadata.peerReviewSignoffHash
        : undefined,
      safetyRegressionCount: typeof metadata.safetyRegressionCount === 'number'
        && Number.isInteger(metadata.safetyRegressionCount)
        ? metadata.safetyRegressionCount
        : undefined,
      qualityRegressionCount: typeof metadata.qualityRegressionCount === 'number'
        && Number.isInteger(metadata.qualityRegressionCount)
        ? metadata.qualityRegressionCount
        : undefined,
      degradedNotComparableCount: typeof metadata.degradedNotComparableCount === 'number'
        && Number.isInteger(metadata.degradedNotComparableCount)
        ? metadata.degradedNotComparableCount
        : undefined,
    };
  });
}

function isInventoryOnlyRouteExitRow(safeMetadataJson?: string | null): boolean {
  return parseSafeMetadata(safeMetadataJson).status === 'inventory_only_not_retired';
}

function parseSafeMetadata(safeMetadataJson?: string | null): Record<string, unknown> {
  if (!safeMetadataJson) return {};
  try {
    const parsed = JSON.parse(safeMetadataJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function buildEvidenceSourceFilter(sources: readonly ChatV2LegacyRetirementEvidenceSource[]): {
  placeholders: string;
  values: ChatV2LegacyRetirementEvidenceSource[];
} {
  const values = [...new Set(sources.length > 0 ? sources : DEFAULT_READINESS_EVIDENCE_SOURCES)]
    .filter((source): source is ChatV2LegacyRetirementEvidenceSource =>
      source === 'runtime_route' || source === 'local_sandbox_seed',
    );
  const safeValues = values.length > 0 ? values : DEFAULT_READINESS_EVIDENCE_SOURCES;
  return {
    placeholders: safeValues.map(() => '?').join(', '),
    values: safeValues,
  };
}

function buildSafeMetadata(kind: ChatV2LegacyRetirementEvidenceKind, metadata?: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 'chat_v2_legacy_retirement_evidence_safe_metadata.v1',
    evidenceKind: kind,
    ...(metadata ?? {}),
  };
}

function hmacToken(kind: string, value: string): string {
  return `hmac:${kind}:${crypto.createHmac('sha256', resolveEvidenceHmacSecret()).update(value).digest('hex')}`;
}

function resolveEvidenceHmacSecret(): string {
  const configured = process.env.CHAT_V2_EVIDENCE_HMAC_SECRET || process.env.IOS_API_JWT_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'test') return FALLBACK_TEST_HMAC_SECRET;
  throw new Error('CHAT_V2_EVIDENCE_HMAC_SECRET is required when ChatV2 legacy retirement evidence recording is enabled');
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function boolInt(value: boolean): number {
  return value ? 1 : 0;
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}
