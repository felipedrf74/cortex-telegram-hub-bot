// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WP-19 — offline corpus-eval orchestration (the type-checked core the weekly
 * script and the WP-19-seed one-shot both call).
 *
 * Responsibilities:
 *   1. Merge the golden corpus (hand-authored / peer-reviewed fixtures, which
 *      legitimately carry text) with the DROP-TEXT shadow corpus
 *      (`loadShadowReplayCorpusItems`, which carries NO raw text — only labels +
 *      a salted token; see `shadow-corpus-loader.ts`).
 *   2. Run `evaluatePrepassRecallAtK` over the merged corpus. Golden items run
 *      the real selector on their (non-PII fixture) text; shadow items use their
 *      PRECOMPUTED candidate ids, so NO raw shadow text is ever needed at eval
 *      time.
 *   3. Bind the measured recall to a corpus CONTENT-HASH and persist it through
 *      WP-13's `upsertRecallAt8(value, { corpusContentHash })` — this WP is the
 *      SOLE writer that opens WP-13's `gateCanPromote` / WP-14's promotion path.
 *   4. Record an append-only run-history row in `chat_v2_gate_eval_runs`
 *      (migration 176) — SAFE SCALARS ONLY, no raw text, no labels persisted.
 *   5. Compute the honest GATE_PASS / GATE_FAIL verdict.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HONESTY — the synthetic seed CANNOT open the gate (§5.C, Issue 6)
 * ────────────────────────────────────────────────────────────────────────────
 * A run over ONLY the synthetic `CHAT_CORE_V2_GOLDEN_CORPUS_SEED` binds its
 * recall to the seed's content-hash (`getSyntheticSeedCorpusContentHash()`),
 * which WP-13's `gateCanPromote` REJECTS. So WP-19-seed writes the FIRST
 * persisted recall (resolving the inverted recall dependency so an executor can
 * reach the gate machinery), but that recall is synthetic-bound and therefore
 * can NEVER satisfy promotion. Only a recall measured over a non-synthetic REAL
 * corpus AND bound to a peer-review signoff hash opens the gate. The reviewed
 * corpus/signoff is a data/process step out of code scope, but the binding is
 * code-enforced: `runCorpusEval` surfaces `corpusIsSyntheticSeed` and
 * `corpusHasPeerReviewSignoff`, and the runner never pretends otherwise.
 *
 * Pure-ish: the only IO is reading shadow rows + the two DB writes (upsert +
 * run-history). No provider calls, no network.
 */

import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { getDb } from '../database';
import {
  CHAT_CORE_V2_PREPASS_RECALL_LANGUAGE_TARGETS,
  CHAT_CORE_V2_PREPASS_RECALL_LANGUAGES,
  evaluatePrepassRecallAtK,
  type PrepassRecallEvalItem,
  type PrepassRecallAtKResult,
} from './prepass-recall-eval';
import { selectPrepassCandidateCapabilities } from './prepass-candidate-selection';
import {
  upsertRecallAt8,
  buildPeerReviewedCorpusContentHash,
  computeChatCoreV2CorpusContentHash,
  getSyntheticSeedCorpusContentHash,
  CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET,
} from './gate-metrics-store';
import {
  loadShadowReplayCorpusItems,
  type ShadowReplayCorpusItem,
  type LoadShadowReplayCorpusOptions,
} from './shadow-corpus-loader';
import { CHAT_CORE_V2_GOLDEN_CORPUS_SEED } from './golden-corpus-seed';
import {
  validateGoldenCorpus,
  type ChatCoreV2GoldenCorpus,
  type ChatCoreV2GoldenCorpusIssue,
} from './golden-corpus';

export const CHAT_CORE_V2_CORPUS_EVAL_RUNNER_VERSION = 'chat_core_v2_corpus_eval_runner@1.0.0';

export type CorpusEvalType = 'weekly' | 'seed' | 'manual';

export interface RunCorpusEvalOptions {
  /** Which pipeline triggered the run (recorded in run history). Default 'manual'. */
  evalType?: CorpusEvalType;
  /** The golden corpus to merge. Defaults to the synthetic seed corpus. */
  goldenCorpus?: ChatCoreV2GoldenCorpus;
  /**
   * When false, the shadow corpus is NOT loaded — the eval runs over the golden
   * corpus only. WP-19-seed uses this so its recall binds to the pure seed hash
   * (which the gate rejects). Default true for the weekly run.
   */
  includeShadowCorpus?: boolean;
  /** Shadow loader options (window/limit/secret). hmacSecret is MANDATORY on a real DB. */
  shadow?: LoadShadowReplayCorpusOptions;
  /** recall@k k. Default 8 (the gate's k). */
  k?: number;
  /** Promotion recall@8 floor. Defaults to CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET (0.90). */
  gateTarget?: number;
  /** When false, skip persisting (upsert + run-history). Default true. */
  persist?: boolean;
  /** Override the run id (tests / determinism). Defaults to a content-derived id. */
  runId?: string;
  /** Override recorded-at (tests). Defaults to now (UTC). */
  recordedAt?: string;
  /**
   * Required before this run may report GATE_PASS or persist a promotion-capable
   * recall. The value is a 64-hex digest of the peer-review artifact/signoff,
   * not reviewer text. The persisted corpus binding becomes
   * `peer-reviewed:<corpusHash>:<signoffHash>`, still a safe scalar.
   */
  peerReviewSignoffHash?: string;
}

export interface CorpusEvalRunResult {
  version: string;
  evalType: CorpusEvalType;
  runId: string;
  k: number;
  recallAtK: number;
  gateTarget: number;
  /** total / golden / shadow item counts in the merged corpus. */
  corpusItemCount: number;
  goldenItemCount: number;
  shadowItemCount: number;
  /** Content-hash the recall is bound to (the value persisted with the recall). */
  corpusContentHash: string;
  /** TRUE when the corpus content-hash equals the REJECTED synthetic-seed hash. */
  corpusIsSyntheticSeed: boolean;
  /** Golden-corpus validation failures that make the corpus non-promotable. */
  corpusValidationIssues: ChatCoreV2GoldenCorpusIssue[];
  /** TRUE only when the golden corpus clears the real/shape/size validation floor. */
  corpusIsPromotionEligible: boolean;
  /** TRUE when this run carries an explicit peer-review signoff binding. */
  corpusHasPeerReviewSignoff: boolean;
  /** TRUE only when the peer-review signoff was accepted into the persisted binding. */
  corpusPeerReviewBindingAccepted: boolean;
  /** TRUE only when every required language bucket exists and meets its floor. */
  languageGatePass: boolean;
  /** Language buckets that are missing or below their per-language floor. */
  languageGateFailures: string[];
  /** Did this run call upsertRecallAt8 (persist)? */
  wrotePersistedRecall: boolean;
  /**
   * HONEST gate verdict: TRUE only when recall meets the target, the corpus is
   * NOT the synthetic seed, and the recall is bound to a peer-review signoff. A
   * synthetic-bound or unreviewed recall is ALWAYS GATE_FAIL regardless of its
   * numeric value.
   */
  gatePass: boolean;
  /** Human-readable explanation of the verdict. */
  notes: string;
  /** The underlying recall measurement (misses are labels-only, no shadow text). */
  recall: PrepassRecallAtKResult;
  recordedAt: string;
}

/**
 * Run the corpus eval. Merges golden + (optional) shadow corpus, scores
 * recall@k, binds it to a content-hash, persists via WP-13's upsert + the WP-19
 * run-history table, and returns the honest GATE_PASS/GATE_FAIL verdict.
 */
export function runCorpusEval(
  db: Database.Database = getDb(),
  options: RunCorpusEvalOptions = {},
): CorpusEvalRunResult {
  const evalType: CorpusEvalType = options.evalType ?? 'manual';
  const goldenCorpus = options.goldenCorpus ?? CHAT_CORE_V2_GOLDEN_CORPUS_SEED;
  const includeShadow = options.includeShadowCorpus ?? true;
  const k = Math.max(1, Math.trunc(options.k ?? 8));
  const gateTarget = options.gateTarget ?? CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET;
  const persist = options.persist ?? true;
  const recordedAt = options.recordedAt ?? new Date().toISOString();

  // ── Golden items: hand-authored fixtures. They legitimately carry text; the
  // real selector runs on that text. (Golden text is NOT user PII.) ──────────
  const goldenItems: PrepassRecallEvalItem[] = goldenCorpus.items.map((item) => ({
    message: item.message,
    expectedCapabilityIds: item.expectedCapabilityIds,
    language: item.language,
  }));

  // ── Shadow items: DROP-TEXT. Loaded with NO raw message — only labels + a
  // salted token + precomputed candidate ids. hmacSecret MANDATORY on a real DB
  // (the loader hard-fails otherwise). ──────────────────────────────────────
  const shadowItems: ShadowReplayCorpusItem[] = includeShadow
    ? loadShadowReplayCorpusItems(db, options.shadow ?? {}).items
    : [];

  // Unified precomputed-candidate producer keyed by a synthetic per-item key, so
  // NO raw shadow text is ever needed to score recall. Golden items get the real
  // selector's output; shadow items get their stored candidate ids.
  const candidateByKey = new Map<string, string[]>();
  const merged: PrepassRecallEvalItem[] = [];

  for (let i = 0; i < goldenItems.length; i += 1) {
    const key = `g:${i}`;
    candidateByKey.set(key, selectPrepassCandidateCapabilities({ message: goldenItems[i].message }).candidateCapabilityIds);
    merged.push({
      message: key,
      expectedCapabilityIds: goldenItems[i].expectedCapabilityIds,
      language: goldenItems[i].language,
    });
  }
  for (let i = 0; i < shadowItems.length; i += 1) {
    const key = `s:${i}`;
    candidateByKey.set(key, shadowItems[i].candidateCapabilityIds);
    merged.push({
      message: key,
      expectedCapabilityIds: shadowItems[i].expectedCapabilityIds,
      language: normalizeCorpusLanguage(shadowItems[i].locale),
    });
  }

  const recall = evaluatePrepassRecallAtK(
    merged,
    k,
    (key: string) => candidateByKey.get(key) ?? [],
  );

  // ── Content-hash: a pure-golden-seed run MUST bind to the synthetic-seed hash
  // so the gate rejects it. We hash over the SOURCE corpus shape: golden items
  // by {message, expectedCapabilityIds} (matching the seed-hash construction),
  // and shadow items by {token, expectedCapabilityIds, candidateCapabilityIds}
  // — NEVER raw shadow text (there is none). Binding candidates matters: recall
  // evidence must change when the selector output being scored changes. When
  // the run is golden-seed-only, the hash equals
  // getSyntheticSeedCorpusContentHash() exactly. ─────────────────────────────
  const rawCorpusContentHash = computeMergedCorpusContentHash(goldenCorpus, shadowItems);
  const corpusIsSyntheticSeed = rawCorpusContentHash === getSyntheticSeedCorpusContentHash();
  const corpusValidationIssues = validateGoldenCorpus(goldenCorpus);
  const corpusIsPromotionEligible = corpusValidationIssues.length === 0 && !corpusIsSyntheticSeed;
  const peerReviewSignoffHash = (options.peerReviewSignoffHash ?? '').trim();
  const corpusHasPeerReviewSignoff = /^[a-f0-9]{64}$/.test(peerReviewSignoffHash);
  const corpusPeerReviewBindingAccepted =
    corpusHasPeerReviewSignoff && corpusIsPromotionEligible;
  const corpusContentHash = corpusPeerReviewBindingAccepted
    ? buildPeerReviewedCorpusContentHash({
      corpusContentHash: rawCorpusContentHash,
      peerReviewSignoffHash,
    })
    : rawCorpusContentHash;

  // HONEST gate verdict: synthetic-bound or unreviewed recall is ALWAYS a fail.
  const recallMeetsTarget = recall.recallAtK >= gateTarget;
  const languageGateFailures = computeLanguageGateFailures(recall);
  const languageGatePass = languageGateFailures.length === 0;
  const gatePass = recallMeetsTarget && languageGatePass && corpusPeerReviewBindingAccepted;

  const runId = options.runId ?? deriveRunId(evalType, corpusContentHash, recordedAt);

  let wrotePersistedRecall = false;
  if (persist) {
    upsertRecallAt8(recall.recallAtK, {
      corpusContentHash,
      recordedAt,
      byLanguage: recall.byLanguage,
    }, db);
    recordEvalRun(db, {
      runId,
      evalType,
      recallAtK: recall.recallAtK,
      k,
      corpusItemCount: merged.length,
      shadowItemCount: shadowItems.length,
      goldenItemCount: goldenItems.length,
      corpusContentHash,
      corpusIsSyntheticSeed,
      wrotePersistedRecall: true,
      recordedAt,
    });
    wrotePersistedRecall = true;
  }

  return {
    version: CHAT_CORE_V2_CORPUS_EVAL_RUNNER_VERSION,
    evalType,
    runId,
    k,
    recallAtK: recall.recallAtK,
    gateTarget,
    corpusItemCount: merged.length,
    goldenItemCount: goldenItems.length,
    shadowItemCount: shadowItems.length,
    corpusContentHash,
    corpusIsSyntheticSeed,
    corpusValidationIssues,
    corpusIsPromotionEligible,
    corpusHasPeerReviewSignoff,
    corpusPeerReviewBindingAccepted,
    languageGatePass,
    languageGateFailures,
    wrotePersistedRecall,
    gatePass,
    notes: buildVerdictNotes({
      recallAtK: recall.recallAtK,
      gateTarget,
      corpusIsSyntheticSeed,
      corpusValidationIssues,
      corpusIsPromotionEligible,
      corpusHasPeerReviewSignoff,
      corpusPeerReviewBindingAccepted,
      languageGatePass,
      languageGateFailures,
      gatePass,
    }),
    recall,
    recordedAt,
  };
}

export interface ChatV2GateEvalRunRow {
  id: number;
  runId: string;
  evalType: CorpusEvalType;
  recallAtK: number;
  k: number;
  corpusItemCount: number;
  shadowItemCount: number;
  goldenItemCount: number;
  corpusContentHash: string;
  corpusIsSyntheticSeed: boolean;
  wrotePersistedRecall: boolean;
  recordedAt: string;
}

/** Idempotent DDL for the WP-19 run-history table (mirrors migration 176). */
export function ensureChatCoreV2GateEvalRunsTable(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_gate_eval_runs (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id                   TEXT NOT NULL UNIQUE,
      eval_type                TEXT NOT NULL CHECK (eval_type IN ('weekly', 'seed', 'manual')),
      recall_at_k              REAL NOT NULL,
      k                        INTEGER NOT NULL,
      corpus_item_count        INTEGER NOT NULL,
      shadow_item_count        INTEGER NOT NULL,
      golden_item_count        INTEGER NOT NULL,
      corpus_content_hash      TEXT NOT NULL,
      corpus_is_synthetic_seed INTEGER NOT NULL,
      wrote_persisted_recall   INTEGER NOT NULL,
      recorded_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_gate_eval_runs_recorded_at
      ON chat_v2_gate_eval_runs(recorded_at);
  `);
}

interface RecordEvalRunInput {
  runId: string;
  evalType: CorpusEvalType;
  recallAtK: number;
  k: number;
  corpusItemCount: number;
  shadowItemCount: number;
  goldenItemCount: number;
  corpusContentHash: string;
  corpusIsSyntheticSeed: boolean;
  wrotePersistedRecall: boolean;
  recordedAt: string;
}

function recordEvalRun(db: Database.Database, input: RecordEvalRunInput): void {
  ensureChatCoreV2GateEvalRunsTable(db);
  db.prepare(
    `INSERT INTO chat_v2_gate_eval_runs
       (run_id, eval_type, recall_at_k, k, corpus_item_count, shadow_item_count,
        golden_item_count, corpus_content_hash, corpus_is_synthetic_seed,
        wrote_persisted_recall, recorded_at)
     VALUES (@runId, @evalType, @recallAtK, @k, @corpusItemCount, @shadowItemCount,
        @goldenItemCount, @corpusContentHash, @corpusIsSyntheticSeed,
        @wrotePersistedRecall, @recordedAt)
     ON CONFLICT(run_id) DO UPDATE SET
        eval_type = excluded.eval_type,
        recall_at_k = excluded.recall_at_k,
        k = excluded.k,
        corpus_item_count = excluded.corpus_item_count,
        shadow_item_count = excluded.shadow_item_count,
        golden_item_count = excluded.golden_item_count,
        corpus_content_hash = excluded.corpus_content_hash,
        corpus_is_synthetic_seed = excluded.corpus_is_synthetic_seed,
        wrote_persisted_recall = excluded.wrote_persisted_recall,
        recorded_at = excluded.recorded_at`,
  ).run({
    runId: input.runId,
    evalType: input.evalType,
    recallAtK: input.recallAtK,
    k: input.k,
    corpusItemCount: input.corpusItemCount,
    shadowItemCount: input.shadowItemCount,
    goldenItemCount: input.goldenItemCount,
    corpusContentHash: input.corpusContentHash,
    corpusIsSyntheticSeed: input.corpusIsSyntheticSeed ? 1 : 0,
    wrotePersistedRecall: input.wrotePersistedRecall ? 1 : 0,
    recordedAt: input.recordedAt,
  });
}

/** Read recent run-history rows (newest first). Empty when no such table. */
export function listChatCoreV2GateEvalRuns(
  db: Database.Database = getDb(),
  limit = 50,
): ChatV2GateEvalRunRow[] {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  let rows: Record<string, unknown>[];
  try {
    rows = db
      .prepare(
        `SELECT id, run_id, eval_type, recall_at_k, k, corpus_item_count,
                shadow_item_count, golden_item_count, corpus_content_hash,
                corpus_is_synthetic_seed, wrote_persisted_recall, recorded_at
           FROM chat_v2_gate_eval_runs
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(safeLimit) as Record<string, unknown>[];
  } catch {
    return [];
  }
  return rows.map((row) => ({
    id: Number(row.id),
    runId: String(row.run_id),
    evalType: row.eval_type as CorpusEvalType,
    recallAtK: Number(row.recall_at_k),
    k: Number(row.k),
    corpusItemCount: Number(row.corpus_item_count),
    shadowItemCount: Number(row.shadow_item_count),
    goldenItemCount: Number(row.golden_item_count),
    corpusContentHash: String(row.corpus_content_hash),
    corpusIsSyntheticSeed: row.corpus_is_synthetic_seed === 1,
    wrotePersistedRecall: row.wrote_persisted_recall === 1,
    recordedAt: String(row.recorded_at),
  }));
}

/**
 * Content-hash over the SOURCE corpus shape. Golden items contribute
 * {message, expectedCapabilityIds} (matching the synthetic-seed hash so a
 * golden-only run binds to the rejected hash); shadow items contribute
 * {salted token, expectedCapabilityIds, candidateCapabilityIds} — NEVER raw
 * shadow text. Candidate ids are part of the evidence binding because changing
 * them changes the measured recall. When there are no shadow items, this equals
 * `computeChatCoreV2CorpusContentHash(goldenCorpus)` exactly.
 */
function computeMergedCorpusContentHash(
  goldenCorpus: ChatCoreV2GoldenCorpus,
  shadowItems: ShadowReplayCorpusItem[],
): string {
  if (shadowItems.length === 0) {
    return computeChatCoreV2CorpusContentHash(goldenCorpus);
  }
  const goldenHash = computeChatCoreV2CorpusContentHash(goldenCorpus);
  const shadowCanonical = shadowItems
    .map((item) => [
      item.messageToken,
      [...item.expectedCapabilityIds].sort().join(','),
      [...item.candidateCapabilityIds].sort().join(','),
    ].join('|'))
    .sort()
    .join(';');
  const shadowHash = createHash('sha256').update(shadowCanonical).digest('hex');
  return createHash('sha256').update(`merged:${goldenHash}:${shadowHash}`).digest('hex');
}

function deriveRunId(evalType: CorpusEvalType, corpusContentHash: string, recordedAt: string): string {
  const digest = createHash('sha256').update(`${evalType}:${corpusContentHash}:${recordedAt}`).digest('hex').slice(0, 16);
  return `chatv2-eval:${evalType}:${digest}`;
}

function buildVerdictNotes(input: {
  recallAtK: number;
  gateTarget: number;
  corpusIsSyntheticSeed: boolean;
  corpusValidationIssues: ChatCoreV2GoldenCorpusIssue[];
  corpusIsPromotionEligible: boolean;
  corpusHasPeerReviewSignoff: boolean;
  corpusPeerReviewBindingAccepted: boolean;
  languageGatePass: boolean;
  languageGateFailures: string[];
  gatePass: boolean;
}): string {
  if (input.gatePass) {
    return `GATE_PASS: recall@8 ${input.recallAtK.toFixed(4)} >= ${input.gateTarget} over a peer-reviewed NON-synthetic corpus.`;
  }
  if (input.corpusIsSyntheticSeed) {
    return (
      `GATE_FAIL: corpus is the SYNTHETIC seed (content-hash matches the rejected synthetic-seed hash). `
      + `recall@8 ${input.recallAtK.toFixed(4)} is recorded for audit but the synthetic seed can NEVER open the gate — `
      + `a peer-reviewed REAL corpus is required (data gate, out of code scope).`
    );
  }
  if (!input.corpusIsPromotionEligible) {
    return (
      `GATE_FAIL: recall@8 ${input.recallAtK.toFixed(4)} is recorded for audit, `
      + `but the corpus is not promotion-eligible (${input.corpusValidationIssues.join(', ') || 'validation_failed'}). `
      + 'The persisted recall remains bound to a non-promotion corpus hash even if a peer-review digest was supplied.'
    );
  }
  if (!input.corpusHasPeerReviewSignoff) {
    return (
      `GATE_FAIL: recall@8 ${input.recallAtK.toFixed(4)} is recorded for audit, `
      + 'but this corpus is not bound to a peer-review signoff. '
      + 'A peer-reviewed REAL corpus/signoff is required before promotion.'
    );
  }
  if (!input.corpusPeerReviewBindingAccepted) {
    return (
      `GATE_FAIL: recall@8 ${input.recallAtK.toFixed(4)} is recorded for audit, `
      + 'but the peer-review signoff was not accepted into a promotion-capable binding.'
    );
  }
  if (!input.languageGatePass) {
    return (
      `GATE_FAIL: recall@8 ${input.recallAtK.toFixed(4)} is recorded for audit, `
      + `but per-language recall floors are not met (${input.languageGateFailures.join(', ')}).`
    );
  }
  return `GATE_FAIL: recall@8 ${input.recallAtK.toFixed(4)} < ${input.gateTarget}.`;
}

function normalizeCorpusLanguage(value: string): PrepassRecallEvalItem['language'] {
  return value === 'en' || value === 'pt-BR' || value === 'pt-PT' || value === 'mixed'
    ? value
    : undefined;
}

function computeLanguageGateFailures(recall: PrepassRecallAtKResult): string[] {
  const failures: string[] = [];
  for (const language of CHAT_CORE_V2_PREPASS_RECALL_LANGUAGES) {
    const bucket = recall.byLanguage[language];
    const target = CHAT_CORE_V2_PREPASS_RECALL_LANGUAGE_TARGETS[language];
    if (!bucket || bucket.scored === 0) {
      failures.push(`${language}:missing`);
    } else if (bucket.recallAtK < target) {
      failures.push(`${language}:${bucket.recallAtK.toFixed(4)}<${target}`);
    }
  }
  return failures;
}
