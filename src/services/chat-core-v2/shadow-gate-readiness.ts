// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Read-only Phase 2 shadow-gate readiness measurement.
 *
 * The shadow route hook already persists redacted, HMAC-only plan/route
 * metadata into `chat_v2_replay_bundles` (see `trace-recorder.ts` /
 * `model-run-audit.ts`); this module does NOT add a parallel store. It only
 * reads the existing shadow bundles and reports, honestly and measurably,
 * whether the documented Phase 2 shadow gate is met:
 *
 *   - >= 50 shadow rows
 *   - schema validity >= 99%
 *   - zero raw message strings in shadow rows (structural HMAC-shape check)
 *   - recall@8 on a peer-reviewed labeled corpus
 *
 * recall@8 cannot be derived from shadow rows alone (it needs labeled ground
 * truth), so `gateMet` is never reported true from this report — evidence must
 * stay honest that the gate remains open until recall@8 is separately
 * validated. Default-safe: pure read, no mutation, no provider calls.
 */

import Database from 'better-sqlite3';
import { getDb } from '../database';
import { ensureChatCoreV2AuditTables } from './model-run-audit';

export const CHAT_CORE_V2_SHADOW_GATE_READINESS_VERSION = 'chat_core_v2_shadow_gate_readiness@1.0.0';

const SHADOW_BUNDLE_ID_LIKE = 'chatv2-shadow-replay:%';
const HMAC_HEX_64 = /^[a-f0-9]{64}$/;

export interface ChatCoreV2ShadowGateThresholds {
  minRows: number;
  minSchemaValidPct: number;
  /** Minimum planner schema-compliance samples required before schema can pass. */
  minSchemaComplianceSamples?: number;
  maxSafeShapeViolations: number;
}

export const DEFAULT_CHAT_CORE_V2_SHADOW_GATE_THRESHOLDS: ChatCoreV2ShadowGateThresholds = {
  minRows: 50,
  minSchemaValidPct: 0.99,
  maxSafeShapeViolations: 0,
};

export interface ChatCoreV2ShadowGateReadiness {
  version: string;
  rowCount: number;
  /** Planner schema-compliance samples recorded by the shadow planner path. */
  schemaSampleCount: number;
  schemaValidCount: number;
  schemaInvalidCount: number;
  schemaValidPct: number;
  /** Replay bundle shape is diagnostic; planner compliance owns Phase 2 schema readiness. */
  replayBundleSchemaValidCount: number;
  replayBundleSchemaValidPct: number;
  safeShapeViolationCount: number;
  thresholds: ChatCoreV2ShadowGateThresholds;
  meetsMinRows: boolean;
  meetsSchemaValidity: boolean;
  meetsReplayBundleSchemaValidity: boolean;
  meetsSafeShape: boolean;
  /** recall@8 requires a peer-reviewed labeled corpus; not derivable here. */
  recallAt8: 'requires_labeled_corpus';
  /**
   * Always false from this report alone: the full gate also requires recall@8
   * on a labeled corpus. Use it to keep evidence honest, not to claim Phase 2.
   */
  gateMet: false;
  notes: string;
}

export function evaluateChatCoreV2ShadowGateReadiness(
  db: Database.Database = getDb(),
  thresholds: ChatCoreV2ShadowGateThresholds = DEFAULT_CHAT_CORE_V2_SHADOW_GATE_THRESHOLDS,
): ChatCoreV2ShadowGateReadiness {
  ensureChatCoreV2AuditTables(db);
  const rows = db
    .prepare('SELECT redacted_bundle_json FROM chat_v2_replay_bundles WHERE replay_bundle_id LIKE ?')
    .all(SHADOW_BUNDLE_ID_LIKE) as Array<{ redacted_bundle_json: string }>;

  const normalizedThresholds = normalizeThresholds(thresholds);

  let replayBundleSchemaValidCount = 0;
  let safeShapeViolationCount = 0;
  for (const row of rows) {
    const parsed = safeParse(row.redacted_bundle_json);
    if (isValidShadowBundleSchema(parsed)) replayBundleSchemaValidCount += 1;
    if (!hasSafeHashedShape(parsed)) safeShapeViolationCount += 1;
  }

  const rowCount = rows.length;
  const replayBundleSchemaValidPct = rowCount === 0 ? 0 : replayBundleSchemaValidCount / rowCount;
  const plannerCompliance = readPlannerSchemaCompliance(db);
  const schemaSampleCount = plannerCompliance.pass + plannerCompliance.fail;
  const schemaValidCount = plannerCompliance.pass;
  const schemaInvalidCount = plannerCompliance.fail;
  const schemaValidPct = schemaSampleCount === 0 ? 0 : schemaValidCount / schemaSampleCount;
  const meetsMinRows = rowCount >= normalizedThresholds.minRows;
  const meetsSchemaValidity =
    schemaSampleCount >= normalizedThresholds.minSchemaComplianceSamples
    && schemaValidPct >= normalizedThresholds.minSchemaValidPct;
  const meetsReplayBundleSchemaValidity =
    rowCount > 0 && replayBundleSchemaValidPct >= normalizedThresholds.minSchemaValidPct;
  const meetsSafeShape = safeShapeViolationCount <= normalizedThresholds.maxSafeShapeViolations;

  return {
    version: CHAT_CORE_V2_SHADOW_GATE_READINESS_VERSION,
    rowCount,
    schemaSampleCount,
    schemaValidCount,
    schemaInvalidCount,
    schemaValidPct,
    replayBundleSchemaValidCount,
    replayBundleSchemaValidPct,
    safeShapeViolationCount,
    thresholds: normalizedThresholds,
    meetsMinRows,
    meetsSchemaValidity,
    meetsReplayBundleSchemaValidity,
    meetsSafeShape,
    recallAt8: 'requires_labeled_corpus',
    gateMet: false,
    notes: buildNotes({
      rowCount,
      schemaSampleCount,
      schemaValidPct,
      replayBundleSchemaValidPct,
      safeShapeViolationCount,
      meetsMinRows,
      meetsSchemaValidity,
      meetsSafeShape,
      thresholds: normalizedThresholds,
    }),
  };
}

function normalizeThresholds(thresholds: ChatCoreV2ShadowGateThresholds): Required<ChatCoreV2ShadowGateThresholds> {
  return {
    ...thresholds,
    minSchemaComplianceSamples: thresholds.minSchemaComplianceSamples ?? thresholds.minRows,
  };
}

function readPlannerSchemaCompliance(db: Database.Database): { pass: number; fail: number } {
  try {
    const row = db
      .prepare(
        `SELECT
           COALESCE(SUM(pass_count), 0) AS pass,
           COALESCE(SUM(fail_count), 0) AS fail
         FROM chat_v2_schema_compliance_counter`,
      )
      .get() as { pass: number; fail: number } | undefined;
    return {
      pass: Number(row?.pass ?? 0) || 0,
      fail: Number(row?.fail ?? 0) || 0,
    };
  } catch {
    return { pass: 0, fail: 0 };
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isValidShadowBundleSchema(bundle: unknown): boolean {
  if (!bundle || typeof bundle !== 'object') return false;
  const record = bundle as Record<string, unknown>;
  const response = record.response as Record<string, unknown> | undefined;
  const contextPack = record.contextPack as Record<string, unknown> | undefined;
  return Boolean(
    response
    && typeof response === 'object'
    && response.type === 'chat_core_v2_shadow_plan'
    && response.wouldExecute === false
    && typeof response.routeMethod === 'string'
    && (response.routeMethod as string).length > 0
    && contextPack
    && typeof contextPack === 'object'
    && typeof contextPack.hashVersion === 'string',
  );
}

/**
 * Structural privacy check (defense-in-depth alongside the write-time
 * redaction + the no-raw-storage tests): a clean shadow row must carry a
 * 64-hex HMAC `messageHash` (proving the message was hashed, not stored) and
 * must expose no raw message/preview field.
 */
function hasSafeHashedShape(bundle: unknown): boolean {
  if (!bundle || typeof bundle !== 'object') return false;
  const record = bundle as Record<string, unknown>;
  const contextPack = record.contextPack as Record<string, unknown> | undefined;
  const response = record.response as Record<string, unknown> | undefined;
  if (!contextPack || typeof contextPack !== 'object') return false;
  if (!response || typeof response !== 'object') return false;
  if (typeof contextPack.messageHash !== 'string' || !HMAC_HEX_64.test(contextPack.messageHash)) return false;
  if (!isAllowlistedShadowContextPack(contextPack)) return false;
  if (!isAllowlistedShadowResponse(response)) return false;
  return true;
}

const ALLOWED_CONTEXT_PACK_KEYS = new Set([
  'shadowRouteHookVersion',
  'hashVersion',
  'messageHash',
  'messageLength',
  'attachmentsCount',
  'clientMessageHash',
  'userMessageHash',
  'locale',
  'timezone',
  'guessedIntent',
  'guessedDomains',
  'guessedCapabilities',
  // Milestone 4: additive resolver-vs-surface divergence telemetry. Structured
  // identifiers/counters only — validated by isSafeRoutingDivergence below.
  'routingDivergence',
]);

const ALLOWED_RESPONSE_KEYS = new Set([
  'type',
  'shadowReplayVersion',
  'routeHookVersion',
  'orchestratorVersion',
  'mode',
  'liveBehavior',
  'routeMethod',
  'reasoningTier',
  'selectedCapabilityIds',
  'toolSchemaSetVersion',
  'toolCount',
  'budgetOk',
  'fallbackAllowed',
  'wouldCallModel',
  'wouldExecute',
]);

function isAllowlistedShadowContextPack(contextPack: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(contextPack)) {
    if (value === undefined) continue;
    if (!ALLOWED_CONTEXT_PACK_KEYS.has(key)) return false;
    if (key === 'routingDivergence') {
      if (!isSafeRoutingDivergence(value)) return false;
      continue;
    }
    if (!isSafeShadowScalarOrArray(key, value)) return false;
  }
  return true;
}

/**
 * Milestone 4: strict shape check for the additive routingDivergence field.
 * Only enum-safe identifier strings (same charset as every other shadow
 * field — no whitespace, so raw message text can never pass), finite numbers,
 * booleans, and null are allowed, under a fixed nested key allowlist.
 */
const ALLOWED_ROUTING_DIVERGENCE_KEYS = new Set([
  'divergenceVersion',
  'resolverVersion',
  'topCandidate',
  'candidateCount',
  'surfaces',
  'agreement',
]);
const ALLOWED_ROUTING_DIVERGENCE_TOP_KEYS = new Set([
  'capabilityId',
  'domain',
  'skill',
  'rawScore',
  'matchedEvidenceCount',
]);
const ALLOWED_ROUTING_DIVERGENCE_SURFACE_KEYS = new Set([
  'classifierKeywordDomain',
  'orchestratorPrimaryDomain',
  'registryActionSkills',
  'shadowRouteIntent',
  'shadowRouteDomains',
]);
const ALLOWED_ROUTING_DIVERGENCE_AGREEMENT_KEYS = new Set([
  'classifierKeyword',
  'orchestratorPrimary',
  'registrySubset',
  'shadowRoute',
]);

function isSafeRoutingDivergence(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const safeLeaf = (key: string, leaf: unknown): boolean =>
    leaf === null || isSafeShadowScalarOrArray(key, leaf);
  const safeSection = (section: unknown, allowedKeys: Set<string>, allowNull: boolean): boolean => {
    if (section === null) return allowNull;
    if (!section || typeof section !== 'object' || Array.isArray(section)) return false;
    return Object.entries(section as Record<string, unknown>).every(
      ([key, leaf]) => leaf === undefined || (allowedKeys.has(key) && safeLeaf(key, leaf)),
    );
  };
  for (const [key, leaf] of Object.entries(record)) {
    if (leaf === undefined) continue;
    if (!ALLOWED_ROUTING_DIVERGENCE_KEYS.has(key)) return false;
    if (key === 'topCandidate') {
      if (!safeSection(leaf, ALLOWED_ROUTING_DIVERGENCE_TOP_KEYS, true)) return false;
    } else if (key === 'surfaces') {
      if (!safeSection(leaf, ALLOWED_ROUTING_DIVERGENCE_SURFACE_KEYS, false)) return false;
    } else if (key === 'agreement') {
      if (!safeSection(leaf, ALLOWED_ROUTING_DIVERGENCE_AGREEMENT_KEYS, false)) return false;
    } else if (!safeLeaf(key, leaf)) {
      return false;
    }
  }
  return true;
}

function isAllowlistedShadowResponse(response: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(response)) {
    if (value === undefined) continue;
    if (!ALLOWED_RESPONSE_KEYS.has(key)) return false;
    if (!isSafeShadowScalarOrArray(key, value)) return false;
  }
  return true;
}

function isSafeShadowScalarOrArray(key: string, value: unknown): boolean {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return isSafeShadowString(key, value);
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'string' && isSafeShadowString(`${key}[]`, item));
  }
  return false;
}

function isSafeShadowString(key: string, value: string): boolean {
  if (key === 'messageHash' || key.endsWith('MessageHash')) return HMAC_HEX_64.test(value);
  if (key === 'timezone') return /^[A-Za-z0-9_./+-]{1,64}$/.test(value);
  if (key === 'locale') return /^(?:[a-z]{2}(?:-[A-Z]{2})?|mixed|unknown)$/.test(value);
  // Versions, route methods, domains, capabilities, and enum-like fields only.
  return /^[a-zA-Z0-9@._:-]{1,128}$/.test(value);
}

function buildNotes(input: {
  rowCount: number;
  schemaSampleCount: number;
  schemaValidPct: number;
  replayBundleSchemaValidPct: number;
  safeShapeViolationCount: number;
  meetsMinRows: boolean;
  meetsSchemaValidity: boolean;
  meetsSafeShape: boolean;
  thresholds: Required<ChatCoreV2ShadowGateThresholds>;
}): string {
  const parts: string[] = [
    `${input.rowCount} shadow rows (need >= ${input.thresholds.minRows})`,
    `planner schema valid ${(input.schemaValidPct * 100).toFixed(1)}% over ${input.schemaSampleCount} samples `
      + `(need >= ${(input.thresholds.minSchemaValidPct * 100).toFixed(0)}% over >= ${input.thresholds.minSchemaComplianceSamples} samples)`,
    `replay bundle schema valid ${(input.replayBundleSchemaValidPct * 100).toFixed(1)}% (diagnostic only)`,
    `${input.safeShapeViolationCount} safe-shape violations (need <= ${input.thresholds.maxSafeShapeViolations})`,
  ];
  if (!input.meetsMinRows || !input.meetsSchemaValidity || !input.meetsSafeShape) {
    parts.push('Phase 2 shadow gate NOT met');
  } else {
    parts.push('row/schema/shape thresholds met; gate still blocked on recall@8 over a peer-reviewed labeled corpus');
  }
  return parts.join('; ');
}
