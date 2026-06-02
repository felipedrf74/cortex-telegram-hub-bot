// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WP-13 — persisted gate-metrics store + the composed, HONEST Phase 2→3
 * promotion gate.
 *
 * WP-13 is the SOLE owner of `chat_v2_gate_metrics` (migration 174) and of this
 * module. It owns the keyed `recall_at_8_latest` config row + the
 * `chat_v2_gate_check_log`, and exports `upsertRecallAt8()` /
 * `getLatestRecallAt8()`. WP-19 (migration 176) adds a SEPARATE
 * `chat_v2_gate_eval_runs` table and CALLS `upsertRecallAt8()` from here; WP-19
 * does NOT modify this module or `chat_v2_gate_metrics` (§5.C).
 *
 * HONESTY (§5.C, Issue 6 — the load-bearing invariant of this WP):
 *   `getLatestRecallAt8()` returns `null` today because nothing has written a
 *   persisted recall yet — WP-19-seed is the first writer, and it has not run.
 *   `gateCanPromote` is therefore FALSE by construction until WP-19-seed runs.
 *   This is the DOCUMENTED, EXPECTED state, not a defect. We never fake a pass.
 *
 * Synthetic-seed rejection: a persisted recall is BOUND to the content-hash of
 * the corpus it was measured over. The hash of the synthetic
 * `CHAT_CORE_V2_GOLDEN_CORPUS_SEED` is explicitly REJECTED, so the synthetic
 * baseline (currently recall@8 ≈ 0.9772 over the seed) can never satisfy the
 * gate even if it were persisted. A non-synthetic corpus hash alone is also not
 * enough: the persisted binding must be `peer-reviewed:<corpusHash>:<signoffHash>`
 * before recall may count toward promotion. The signoff hash is a safe scalar
 * digest of the peer-review artifact, not reviewer text.
 *
 * No cycle: this module imports the read-only base
 * `evaluateChatCoreV2ShadowGateReadiness` from `shadow-gate-readiness.ts`, which
 * imports nothing from here — a one-directional dependency.
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { getDb } from '../database';
import {
  evaluateChatCoreV2ShadowGateReadiness,
  type ChatCoreV2ShadowGateReadiness,
  type ChatCoreV2ShadowGateThresholds,
  DEFAULT_CHAT_CORE_V2_SHADOW_GATE_THRESHOLDS,
} from './shadow-gate-readiness';
import { CHAT_CORE_V2_GOLDEN_CORPUS_SEED } from './golden-corpus-seed';
import {
  CHAT_CORE_V2_PREPASS_RECALL_LANGUAGE_TARGETS,
  CHAT_CORE_V2_PREPASS_RECALL_LANGUAGES,
  type PrepassRecallLanguageBucket,
} from './prepass-recall-eval';

export const CHAT_CORE_V2_GATE_METRICS_STORE_VERSION = 'chat_core_v2_gate_metrics_store@1.0.0';

/** Keyed metric for the single latest persisted prepass recall@8. */
export const RECALL_AT_8_METRIC_KEY = 'recall_at_8_latest';
export const RECALL_AT_8_LANGUAGE_METRIC_KEY_PREFIX = `${RECALL_AT_8_METRIC_KEY}:language:`;

/**
 * The Phase 2→3 promotion recall@8 floor (B4 / WP-13 §4.1: recall@8 ≥ 0.90).
 * This is the SINGLE promotion authority; WP-14's separate 0.80 startup floor
 * is only a minimum-viable-boot check, not the promotion gate.
 */
export const CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET = 0.9;
export const PEER_REVIEWED_CORPUS_HASH_PREFIX = 'peer-reviewed:';

let _syntheticSeedHashCache: string | null = null;

/**
 * Deterministic content-hash of the synthetic `CHAT_CORE_V2_GOLDEN_CORPUS_SEED`.
 * A persisted recall bound to THIS hash is rejected by the gate (the synthetic
 * baseline can never promote). Hashes only the recall-relevant signal — each
 * item's message + ground-truth capability ids — so the digest is stable
 * regardless of unrelated metadata churn.
 */
export function computeChatCoreV2CorpusContentHash(
  corpus: { items: Array<{ message: string; expectedCapabilityIds: string[] }> },
): string {
  const canonical = corpus.items.map((item) => ({
    message: item.message,
    expectedCapabilityIds: [...item.expectedCapabilityIds].sort(),
  }));
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

/** The rejected synthetic-seed content-hash (memoized). */
export function getSyntheticSeedCorpusContentHash(): string {
  if (_syntheticSeedHashCache === null) {
    _syntheticSeedHashCache = computeChatCoreV2CorpusContentHash(CHAT_CORE_V2_GOLDEN_CORPUS_SEED);
  }
  return _syntheticSeedHashCache;
}

export function buildPeerReviewedCorpusContentHash(input: {
  corpusContentHash: string;
  peerReviewSignoffHash: string;
}): string {
  const corpusContentHash = input.corpusContentHash.trim();
  const peerReviewSignoffHash = input.peerReviewSignoffHash.trim();
  if (!/^[a-f0-9]{64}$/.test(corpusContentHash)) {
    throw new Error('buildPeerReviewedCorpusContentHash: corpusContentHash must be a 64-hex digest');
  }
  if (!/^[a-f0-9]{64}$/.test(peerReviewSignoffHash)) {
    throw new Error('buildPeerReviewedCorpusContentHash: peerReviewSignoffHash must be a 64-hex digest');
  }
  return `${PEER_REVIEWED_CORPUS_HASH_PREFIX}${corpusContentHash}:${peerReviewSignoffHash}`;
}

export function isPeerReviewedCorpusContentHash(value: string | null | undefined): boolean {
  return parsePeerReviewedCorpusContentHash(value) !== null;
}

export function rawCorpusContentHashFromGateBinding(value: string | null | undefined): string | null {
  const parsed = parsePeerReviewedCorpusContentHash(value);
  if (parsed) return parsed.corpusContentHash;
  const normalized = (value ?? '').trim();
  return normalized.length > 0 ? normalized : null;
}

function parsePeerReviewedCorpusContentHash(value: string | null | undefined): {
  corpusContentHash: string;
  peerReviewSignoffHash: string;
} | null {
  const normalized = (value ?? '').trim();
  if (!normalized.startsWith(PEER_REVIEWED_CORPUS_HASH_PREFIX)) return null;
  const rest = normalized.slice(PEER_REVIEWED_CORPUS_HASH_PREFIX.length);
  const [corpusContentHash, peerReviewSignoffHash, extra] = rest.split(':');
  if (extra !== undefined) return null;
  if (!/^[a-f0-9]{64}$/.test(corpusContentHash ?? '')) return null;
  if (!/^[a-f0-9]{64}$/.test(peerReviewSignoffHash ?? '')) return null;
  return {
    corpusContentHash,
    peerReviewSignoffHash,
  };
}

/** Idempotent DDL for the WP-13 gate tables (mirrors migration 174). */
export function ensureChatCoreV2GateMetricsTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_gate_metrics (
      metric_key          TEXT PRIMARY KEY,
      metric_value        REAL NOT NULL,
      corpus_content_hash TEXT,
      recorded_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_v2_gate_check_log (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      gate_can_promote         INTEGER NOT NULL,
      meets_min_rows           INTEGER NOT NULL,
      meets_schema_validity    INTEGER NOT NULL,
      meets_safe_shape         INTEGER NOT NULL,
      recall_at_8              REAL,
      recall_meets_target      INTEGER NOT NULL,
      recall_is_synthetic_hash INTEGER NOT NULL,
      shadow_row_count         INTEGER NOT NULL,
      checked_at               TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_gate_check_log_checked_at
      ON chat_v2_gate_check_log(checked_at);
  `);
}

export interface UpsertRecallAt8Options {
  /**
   * Content-hash of the corpus the recall was measured over. A recall bound to
   * the synthetic seed's hash is persisted (for audit) but can NEVER open the
   * gate. Omit only for tests that do not exercise the synthetic-rejection path.
   */
  corpusContentHash?: string | null;
  /** Override the recorded-at timestamp (tests). Defaults to now (UTC). */
  recordedAt?: string;
  /** Per-language recall buckets. Required for a promotion-capable recall. */
  byLanguage?: Partial<Record<string, Pick<PrepassRecallLanguageBucket, 'recallAtK'>>>;
}

export interface PersistedRecallAt8 {
  metricKey: string;
  recallAt8: number;
  corpusContentHash: string | null;
  recordedAt: string;
  updatedAt: string;
}

export type PersistedRecallAt8ByLanguage = Partial<Record<string, PersistedRecallAt8>>;

/**
 * Persist (upsert) the single latest prepass recall@8. WP-19-seed is the FIRST
 * caller; until it runs, no row exists and the gate stays honestly false.
 *
 * Keyed-config upsert: there is exactly one `recall_at_8_latest` row; a new
 * measurement replaces it (and refreshes `updated_at`). Per-run history is
 * WP-19's separate concern, not this row's.
 */
export function upsertRecallAt8(
  value: number,
  options: UpsertRecallAt8Options = {},
  db: Database.Database = getDb(),
): PersistedRecallAt8 {
  if (!Number.isFinite(value)) {
    throw new TypeError('upsertRecallAt8: value must be a finite number');
  }
  ensureChatCoreV2GateMetricsTables(db);

  const corpusContentHash = options.corpusContentHash ?? null;
  const recordedAt = options.recordedAt ?? new Date().toISOString();

  db.prepare(
    `INSERT INTO chat_v2_gate_metrics (metric_key, metric_value, corpus_content_hash, recorded_at, updated_at)
       VALUES (@metricKey, @metricValue, @corpusContentHash, @recordedAt, @recordedAt)
     ON CONFLICT(metric_key) DO UPDATE SET
       metric_value = excluded.metric_value,
       corpus_content_hash = excluded.corpus_content_hash,
       recorded_at = excluded.recorded_at,
       updated_at = excluded.updated_at`,
  ).run({
    metricKey: RECALL_AT_8_METRIC_KEY,
    metricValue: value,
    corpusContentHash,
    recordedAt,
  });

  db.prepare(`DELETE FROM chat_v2_gate_metrics WHERE metric_key LIKE ?`)
    .run(`${RECALL_AT_8_LANGUAGE_METRIC_KEY_PREFIX}%`);
  for (const [language, bucket] of Object.entries(options.byLanguage ?? {})) {
    if (!bucket || !Number.isFinite(bucket.recallAtK)) continue;
    db.prepare(
      `INSERT INTO chat_v2_gate_metrics (metric_key, metric_value, corpus_content_hash, recorded_at, updated_at)
         VALUES (@metricKey, @metricValue, @corpusContentHash, @recordedAt, @recordedAt)
       ON CONFLICT(metric_key) DO UPDATE SET
         metric_value = excluded.metric_value,
         corpus_content_hash = excluded.corpus_content_hash,
         recorded_at = excluded.recorded_at,
         updated_at = excluded.updated_at`,
    ).run({
      metricKey: `${RECALL_AT_8_LANGUAGE_METRIC_KEY_PREFIX}${language}`,
      metricValue: bucket.recallAtK,
      corpusContentHash,
      recordedAt,
    });
  }

  return getLatestRecallAt8(db) as PersistedRecallAt8;
}

/**
 * Read the single latest persisted recall@8, or `null` when none has been
 * written (the honest default state until WP-19-seed runs). Returns `null`
 * gracefully when the table does not exist yet, rather than throwing.
 */
export function getLatestRecallAt8(db: Database.Database = getDb()): PersistedRecallAt8 | null {
  let row: GateMetricRow | undefined;
  try {
    row = db
      .prepare(
        'SELECT metric_key, metric_value, corpus_content_hash, recorded_at, updated_at FROM chat_v2_gate_metrics WHERE metric_key = ?',
      )
      .get(RECALL_AT_8_METRIC_KEY) as GateMetricRow | undefined;
  } catch {
    // No such table yet (migration 174 not applied / fresh in-memory db) — honest empty state.
    return null;
  }
  if (!row) return null;
  return {
    metricKey: row.metric_key,
    recallAt8: row.metric_value,
    corpusContentHash: row.corpus_content_hash ?? null,
    recordedAt: row.recorded_at,
    updatedAt: row.updated_at,
  };
}

export function getLatestRecallAt8ByLanguage(db: Database.Database = getDb()): PersistedRecallAt8ByLanguage {
  let rows: GateMetricRow[];
  try {
    rows = db
      .prepare(
        'SELECT metric_key, metric_value, corpus_content_hash, recorded_at, updated_at FROM chat_v2_gate_metrics WHERE metric_key LIKE ?',
      )
      .all(`${RECALL_AT_8_LANGUAGE_METRIC_KEY_PREFIX}%`) as GateMetricRow[];
  } catch {
    return {};
  }
  const result: PersistedRecallAt8ByLanguage = {};
  for (const row of rows) {
    const language = row.metric_key.slice(RECALL_AT_8_LANGUAGE_METRIC_KEY_PREFIX.length);
    result[language] = {
      metricKey: row.metric_key,
      recallAt8: row.metric_value,
      corpusContentHash: row.corpus_content_hash ?? null,
      recordedAt: row.recorded_at,
      updatedAt: row.updated_at,
    };
  }
  return result;
}

interface GateMetricRow {
  metric_key: string;
  metric_value: number;
  corpus_content_hash: string | null;
  recorded_at: string;
  updated_at: string;
}

export interface ChatCoreV2GateReadinessReport {
  version: string;
  /** The read-only shadow readiness base (rows / schema / safe-shape). */
  shadow: ChatCoreV2ShadowGateReadiness;
  /** The persisted recall@8, or null when none has been written yet. */
  persistedRecallAt8: number | null;
  /** Content-hash the persisted recall was measured over (null when none / unbound). */
  recallCorpusContentHash: string | null;
  /** Promotion recall@8 floor (0.90). */
  recallTarget: number;
  /** Whether a persisted recall EXISTS and meets the target floor. */
  recallMeetsTarget: boolean;
  /** Per-language persisted recall buckets, keyed by corpus language. */
  persistedRecallAt8ByLanguage: PersistedRecallAt8ByLanguage;
  /** The required per-language recall floors. */
  recallLanguageTargets: Readonly<Record<string, number>>;
  /** Whether every required language bucket exists, shares the corpus binding, and meets its floor. */
  recallMeetsLanguageTargets: boolean;
  /** Safe scalar language-gate failure reasons. */
  recallLanguageFailures: string[];
  /** Whether the persisted recall is bound to the REJECTED synthetic-seed hash. */
  recallBoundToSyntheticSeed: boolean;
  /** Whether the persisted recall hash carries an explicit peer-review signoff binding. */
  recallPeerReviewedCorpus: boolean;
  /**
   * TRUE only when ALL hold: shadow readiness met (rows + schema + safe-shape)
   * AND a persisted recall exists and meets the target AND that recall is
   * explicitly peer-review-bound AND NOT bound to the synthetic-seed
   * content-hash. FALSE by construction today (no persisted recall yet —
   * WP-19-seed).
   */
  gateCanPromote: boolean;
  /** Honest, human-readable explanation of the current gate state. */
  notes: string;
}

export interface MeasureChatCoreV2ShadowGateReadinessOptions {
  thresholds?: ChatCoreV2ShadowGateThresholds;
  /** Promotion recall@8 floor. Defaults to CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET (0.90). */
  recallTarget?: number;
}

/**
 * Compose the read-only shadow readiness base with the PERSISTED recall to
 * produce the full, honest Phase 2→3 gate report.
 */
export function measureChatCoreV2ShadowGateReadiness(
  db: Database.Database = getDb(),
  options: MeasureChatCoreV2ShadowGateReadinessOptions = {},
): ChatCoreV2GateReadinessReport {
  const thresholds = options.thresholds ?? DEFAULT_CHAT_CORE_V2_SHADOW_GATE_THRESHOLDS;
  const recallTarget = options.recallTarget ?? CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET;

  const shadow = evaluateChatCoreV2ShadowGateReadiness(db, thresholds);
  const persisted = getLatestRecallAt8(db);
  const persistedByLanguage = getLatestRecallAt8ByLanguage(db);

  const persistedRecallAt8 = persisted ? persisted.recallAt8 : null;
  const recallCorpusContentHash = persisted ? persisted.corpusContentHash : null;
  const rawRecallCorpusContentHash = rawCorpusContentHashFromGateBinding(recallCorpusContentHash);
  const recallPeerReviewedCorpus = isPeerReviewedCorpusContentHash(recallCorpusContentHash);

  const recallBoundToSyntheticSeed =
    rawRecallCorpusContentHash !== null
    && rawRecallCorpusContentHash === getSyntheticSeedCorpusContentHash();

  // A recall opens the gate only if it EXISTS, meets the target, is bound to an
  // explicit peer-review signoff, AND is NOT bound to the synthetic seed. A
  // synthetic-bound or unreviewed recall is treated as not meeting the promotion
  // gate for serving purposes.
  const recallMeetsTarget =
    persistedRecallAt8 !== null
    && persistedRecallAt8 >= recallTarget
    && recallPeerReviewedCorpus
    && !recallBoundToSyntheticSeed;
  const recallLanguageFailures = computePersistedLanguageFailures({
    persisted,
    byLanguage: persistedByLanguage,
  });
  const recallMeetsLanguageTargets = recallLanguageFailures.length === 0;

  const shadowReadinessMet =
    shadow.meetsMinRows && shadow.meetsSchemaValidity && shadow.meetsSafeShape;

  const gateCanPromote = shadowReadinessMet && recallMeetsTarget && recallMeetsLanguageTargets;

  return {
    version: CHAT_CORE_V2_GATE_METRICS_STORE_VERSION,
    shadow,
    persistedRecallAt8,
    recallCorpusContentHash,
    recallTarget,
    recallMeetsTarget,
    persistedRecallAt8ByLanguage: persistedByLanguage,
    recallLanguageTargets: CHAT_CORE_V2_PREPASS_RECALL_LANGUAGE_TARGETS,
    recallMeetsLanguageTargets,
    recallLanguageFailures,
    recallBoundToSyntheticSeed,
    recallPeerReviewedCorpus,
    gateCanPromote,
    notes: buildGateNotes({
      shadowReadinessMet,
      persistedRecallAt8,
      recallTarget,
      recallBoundToSyntheticSeed,
      recallPeerReviewedCorpus,
      recallMeetsLanguageTargets,
      recallLanguageFailures,
      gateCanPromote,
    }),
  };
}

/**
 * Convenience boolean form of the composed gate. TRUE only when the full report
 * says the gate may open. FALSE by construction until WP-19-seed persists a
 * real (non-synthetic, ≥ target) recall.
 */
export function gateCanPromote(
  db: Database.Database = getDb(),
  options: MeasureChatCoreV2ShadowGateReadinessOptions = {},
): boolean {
  return measureChatCoreV2ShadowGateReadiness(db, options).gateCanPromote;
}

export interface ChatCoreV2GateCheckLogRow {
  id: number;
  gateCanPromote: boolean;
  meetsMinRows: boolean;
  meetsSchemaValidity: boolean;
  meetsSafeShape: boolean;
  recallAt8: number | null;
  recallMeetsTarget: boolean;
  recallIsSyntheticHash: boolean;
  shadowRowCount: number;
  checkedAt: string;
}

/**
 * Write one automated gate-check audit row (the hourly cron's output) and
 * return the composed report it was derived from. SAFE SCALARS ONLY — no PII.
 */
export function recordChatCoreV2GateCheck(
  db: Database.Database = getDb(),
  options: MeasureChatCoreV2ShadowGateReadinessOptions = {},
): { report: ChatCoreV2GateReadinessReport; logRowId: number } {
  ensureChatCoreV2GateMetricsTables(db);
  const report = measureChatCoreV2ShadowGateReadiness(db, options);
  const info = db
    .prepare(
      `INSERT INTO chat_v2_gate_check_log
        (gate_can_promote, meets_min_rows, meets_schema_validity, meets_safe_shape,
         recall_at_8, recall_meets_target, recall_is_synthetic_hash, shadow_row_count)
       VALUES (@gateCanPromote, @meetsMinRows, @meetsSchemaValidity, @meetsSafeShape,
         @recallAt8, @recallMeetsTarget, @recallIsSyntheticHash, @shadowRowCount)`,
    )
    .run({
      gateCanPromote: report.gateCanPromote ? 1 : 0,
      meetsMinRows: report.shadow.meetsMinRows ? 1 : 0,
      meetsSchemaValidity: report.shadow.meetsSchemaValidity ? 1 : 0,
      meetsSafeShape: report.shadow.meetsSafeShape ? 1 : 0,
      recallAt8: report.persistedRecallAt8,
      recallMeetsTarget: report.recallMeetsTarget ? 1 : 0,
      recallIsSyntheticHash: report.recallBoundToSyntheticSeed ? 1 : 0,
      shadowRowCount: report.shadow.rowCount,
    });
  return { report, logRowId: Number(info.lastInsertRowid) };
}

/** Read recent gate-check log rows (newest first). Empty when no such table. */
export function listChatCoreV2GateCheckLog(
  db: Database.Database = getDb(),
  limit = 50,
): ChatCoreV2GateCheckLogRow[] {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  let rows: GateCheckLogDbRow[];
  try {
    rows = db
      .prepare(
        `SELECT id, gate_can_promote, meets_min_rows, meets_schema_validity, meets_safe_shape,
                recall_at_8, recall_meets_target, recall_is_synthetic_hash, shadow_row_count, checked_at
         FROM chat_v2_gate_check_log
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(safeLimit) as GateCheckLogDbRow[];
  } catch {
    return [];
  }
  return rows.map((row) => ({
    id: row.id,
    gateCanPromote: row.gate_can_promote === 1,
    meetsMinRows: row.meets_min_rows === 1,
    meetsSchemaValidity: row.meets_schema_validity === 1,
    meetsSafeShape: row.meets_safe_shape === 1,
    recallAt8: row.recall_at_8 ?? null,
    recallMeetsTarget: row.recall_meets_target === 1,
    recallIsSyntheticHash: row.recall_is_synthetic_hash === 1,
    shadowRowCount: row.shadow_row_count,
    checkedAt: row.checked_at,
  }));
}

interface GateCheckLogDbRow {
  id: number;
  gate_can_promote: number;
  meets_min_rows: number;
  meets_schema_validity: number;
  meets_safe_shape: number;
  recall_at_8: number | null;
  recall_meets_target: number;
  recall_is_synthetic_hash: number;
  shadow_row_count: number;
  checked_at: string;
}

function buildGateNotes(input: {
  shadowReadinessMet: boolean;
  persistedRecallAt8: number | null;
  recallTarget: number;
  recallBoundToSyntheticSeed: boolean;
  recallPeerReviewedCorpus: boolean;
  recallMeetsLanguageTargets: boolean;
  recallLanguageFailures: string[];
  gateCanPromote: boolean;
}): string {
  if (input.gateCanPromote) {
    return `gateCanPromote=true: shadow readiness met AND persisted recall@8 ${input.persistedRecallAt8?.toFixed(4)} >= ${input.recallTarget} over a peer-reviewed non-synthetic corpus`;
  }
  const reasons: string[] = [];
  if (!input.shadowReadinessMet) reasons.push('shadow readiness (rows/schema/safe-shape) NOT met');
  if (input.persistedRecallAt8 === null) {
    reasons.push('no persisted recall@8 yet (expected until WP-19-seed runs — this is the honest default, not a defect)');
  } else if (input.recallBoundToSyntheticSeed) {
    reasons.push('persisted recall is bound to the REJECTED synthetic-seed corpus hash (a synthetic baseline can never promote)');
  } else if (!input.recallPeerReviewedCorpus) {
    reasons.push('persisted recall is not bound to a peer-reviewed corpus signoff');
  } else if (!input.recallMeetsLanguageTargets) {
    reasons.push(`per-language recall floors NOT met (${input.recallLanguageFailures.join(', ')})`);
  } else if (input.persistedRecallAt8 < input.recallTarget) {
    reasons.push(`persisted recall@8 ${input.persistedRecallAt8.toFixed(4)} < ${input.recallTarget}`);
  }
  return `gateCanPromote=false: ${reasons.join('; ')}`;
}

function computePersistedLanguageFailures(input: {
  persisted: PersistedRecallAt8 | null;
  byLanguage: PersistedRecallAt8ByLanguage;
}): string[] {
  const failures: string[] = [];
  for (const language of CHAT_CORE_V2_PREPASS_RECALL_LANGUAGES) {
    const target = CHAT_CORE_V2_PREPASS_RECALL_LANGUAGE_TARGETS[language];
    const bucket = input.byLanguage[language];
    if (!bucket) {
      failures.push(`${language}:missing`);
      continue;
    }
    if (input.persisted?.corpusContentHash && bucket.corpusContentHash !== input.persisted.corpusContentHash) {
      failures.push(`${language}:corpus_hash_mismatch`);
      continue;
    }
    if (bucket.recallAt8 < target) {
      failures.push(`${language}:${bucket.recallAt8.toFixed(4)}<${target}`);
    }
  }
  return failures;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}
