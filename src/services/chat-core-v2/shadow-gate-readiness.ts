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
  schemaValidCount: number;
  schemaValidPct: number;
  safeShapeViolationCount: number;
  thresholds: ChatCoreV2ShadowGateThresholds;
  meetsMinRows: boolean;
  meetsSchemaValidity: boolean;
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

  let schemaValidCount = 0;
  let safeShapeViolationCount = 0;
  for (const row of rows) {
    const parsed = safeParse(row.redacted_bundle_json);
    if (isValidShadowBundleSchema(parsed)) schemaValidCount += 1;
    if (!hasSafeHashedShape(parsed)) safeShapeViolationCount += 1;
  }

  const rowCount = rows.length;
  const schemaValidPct = rowCount === 0 ? 0 : schemaValidCount / rowCount;
  const meetsMinRows = rowCount >= thresholds.minRows;
  const meetsSchemaValidity = rowCount > 0 && schemaValidPct >= thresholds.minSchemaValidPct;
  const meetsSafeShape = safeShapeViolationCount <= thresholds.maxSafeShapeViolations;

  return {
    version: CHAT_CORE_V2_SHADOW_GATE_READINESS_VERSION,
    rowCount,
    schemaValidCount,
    schemaValidPct,
    safeShapeViolationCount,
    thresholds,
    meetsMinRows,
    meetsSchemaValidity,
    meetsSafeShape,
    recallAt8: 'requires_labeled_corpus',
    gateMet: false,
    notes: buildNotes({ rowCount, schemaValidPct, safeShapeViolationCount, meetsMinRows, meetsSchemaValidity, meetsSafeShape, thresholds }),
  };
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
  const contextPack = (bundle as Record<string, unknown>).contextPack as Record<string, unknown> | undefined;
  if (!contextPack || typeof contextPack !== 'object') return false;
  if (typeof contextPack.messageHash !== 'string' || !HMAC_HEX_64.test(contextPack.messageHash)) return false;
  if (typeof contextPack.message === 'string' || typeof contextPack.messagePreview === 'string') return false;
  return true;
}

function buildNotes(input: {
  rowCount: number;
  schemaValidPct: number;
  safeShapeViolationCount: number;
  meetsMinRows: boolean;
  meetsSchemaValidity: boolean;
  meetsSafeShape: boolean;
  thresholds: ChatCoreV2ShadowGateThresholds;
}): string {
  const parts: string[] = [
    `${input.rowCount} shadow rows (need >= ${input.thresholds.minRows})`,
    `schema valid ${(input.schemaValidPct * 100).toFixed(1)}% (need >= ${(input.thresholds.minSchemaValidPct * 100).toFixed(0)}%)`,
    `${input.safeShapeViolationCount} safe-shape violations (need <= ${input.thresholds.maxSafeShapeViolations})`,
  ];
  if (!input.meetsMinRows || !input.meetsSchemaValidity || !input.meetsSafeShape) {
    parts.push('Phase 2 shadow gate NOT met');
  } else {
    parts.push('row/schema/shape thresholds met; gate still blocked on recall@8 over a peer-reviewed labeled corpus');
  }
  return parts.join('; ');
}
