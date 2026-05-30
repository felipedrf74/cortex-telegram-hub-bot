#!/usr/bin/env npx tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WP-19 — weekly OFFLINE corpus-eval pipeline + the WP-19-seed one-shot.
 *
 * This is a CI/offline pipeline, NOT the live request path. It:
 *   1. opens its OWN DB handle (via initDatabase(), which applies all migrations
 *      including 176), 2. merges the golden corpus + the DROP-TEXT shadow corpus
 *      (`loadShadowReplayCorpusItems` — NO raw text survives), 3. runs
 *      recall@8, 4. persists the recall via WP-13's `upsertRecallAt8(value,
 *      { corpusContentHash })` + records a WP-19 run-history row, 5. prints
 *      GATE_PASS / GATE_FAIL, and 6. EXITS NON-ZERO on GATE_FAIL. It closes its
 *      DB handle on the way out.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PRIVACY (BLOCKING — §5.F / OD-4)
 * ────────────────────────────────────────────────────────────────────────────
 * `CORPUS_EVAL_HMAC_SECRET` is MANDATORY whenever DATABASE_PATH points at a real
 * (non-:memory:) DB. This script hard-fails (exit 2) BEFORE touching the DB if
 * the secret is empty against a real DB; the loader additionally throws
 * (defense-in-depth). The shadow corpus is DROP-TEXT: no raw message text is
 * ever loaded, and only a tenant+user-SALTED HMAC token (never a global-unsalted
 * one) accompanies the capability labels — and even that token is NOT written to
 * the persisted artifact or the run-history table (only its count is).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HONESTY — WP-19-seed CANNOT open the gate
 * ────────────────────────────────────────────────────────────────────────────
 * `--seed` runs the eval over the SYNTHETIC seed corpus ONLY. That recall is
 * bound to the synthetic content-hash, which WP-13's `gateCanPromote` REJECTS,
 * so the seed run writes the FIRST persisted recall (resolving the inverted
 * recall dependency so an executor can reach the gate machinery) but does NOT
 * open the gate. Only a recall measured over a peer-reviewed REAL corpus opens
 * it — a data/process step out of code scope. The seed run therefore exits with
 * GATE_FAIL by design; pass `--allow-seed-fail` (or rely on the WP-19-seed
 * workflow's `continue-on-error`) so the seed run does not red-X CI.
 *
 * Usage:
 *   CORPUS_EVAL_HMAC_SECRET=… DATABASE_PATH=./data/bot.db \
 *     npx tsx scripts/eval/corpus-eval-weekly.ts --window-days=30 --limit=5000
 *
 *   # WP-19-seed (Phase-2 one-shot — synthetic, cannot open the gate):
 *   npx tsx scripts/eval/corpus-eval-weekly.ts --seed --allow-seed-fail
 */

import * as fs from 'fs';
import * as path from 'path';

import { config } from '../../src/config';
import { initDatabase, getDb, closeDatabase } from '../../src/services/database';
import { runCorpusEval } from '../../src/services/chat-core-v2/corpus-eval-runner';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value] as const;
  }),
);

const isSeed = args.get('seed') === 'true';
const allowSeedFail = args.get('allow-seed-fail') === 'true';
const windowDays = parsePositiveInt(args.get('window-days'), 30);
const limit = parsePositiveInt(args.get('limit'), 5000);
const k = parsePositiveInt(args.get('k'), 8);
const outDir = args.get('out-dir') || process.env.CORPUS_EVAL_OUT_DIR || 'reports/corpus-eval';

function main(): number {
  const hmacSecret = (process.env.CORPUS_EVAL_HMAC_SECRET ?? '').trim();
  const databasePath = config.app.databasePath;
  const isInMemory = databasePath === ':memory:';

  // BLOCKING privacy gate (§5.F): the secret is MANDATORY on a real DB, even for
  // the seed run (the seed run still opens the real DB to write the persisted
  // recall). Hard-fail BEFORE touching the DB so the error is unambiguous.
  if (!isInMemory && hmacSecret.length === 0) {
    console.error(
      JSON.stringify({
        result: 'CONFIG_FAIL',
        error: 'CORPUS_EVAL_HMAC_SECRET is MANDATORY when DATABASE_PATH points at a real (non-:memory:) DB (§5.F).',
        databasePath,
      }),
    );
    return 2;
  }

  initDatabase();
  try {
    const db = getDb();
    const result = runCorpusEval(db, {
      evalType: isSeed ? 'seed' : 'weekly',
      // WP-19-seed: synthetic seed ONLY (no shadow corpus), so the recall binds
      // to the rejected synthetic content-hash and CANNOT open the gate.
      includeShadowCorpus: !isSeed,
      shadow: { windowDays, limit, hmacSecret: hmacSecret || undefined },
      k,
    });

    const artifact = {
      schemaVersion: 'chat_core_v2_corpus_eval_artifact@1.0.0',
      createdAt: new Date().toISOString(),
      evalType: result.evalType,
      runId: result.runId,
      gate: result.gatePass ? 'GATE_PASS' : 'GATE_FAIL',
      k: result.k,
      recallAtK: result.recallAtK,
      gateTarget: result.gateTarget,
      corpusItemCount: result.corpusItemCount,
      goldenItemCount: result.goldenItemCount,
      shadowItemCount: result.shadowItemCount,
      corpusContentHash: result.corpusContentHash,
      corpusIsSyntheticSeed: result.corpusIsSyntheticSeed,
      wrotePersistedRecall: result.wrotePersistedRecall,
      notes: result.notes,
      // SAFE SCALARS ONLY in the recall summary — misses carry capability labels
      // (no shadow text; golden text is replaced with a synthetic per-item key).
      recallSummary: {
        total: result.recall.total,
        scored: result.recall.scored,
        hits: result.recall.hits,
        recallAtK: result.recall.recallAtK,
        missCount: result.recall.misses.length,
      },
    };

    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${artifact.createdAt.replace(/[:.]/g, '-')}-${result.evalType}.json`);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));

    console.log(JSON.stringify({ ...artifact, artifact: outPath }, null, 2));
    console.log(result.gatePass ? 'GATE_PASS' : 'GATE_FAIL');

    if (result.gatePass) return 0;
    // The synthetic seed run is EXPECTED to GATE_FAIL; --allow-seed-fail keeps
    // the WP-19-seed one-shot green while still recording the honest verdict.
    if (isSeed && allowSeedFail) {
      console.log('seed run GATE_FAIL is EXPECTED (synthetic seed cannot open the gate); exiting 0 per --allow-seed-fail.');
      return 0;
    }
    return 1;
  } finally {
    closeDatabase();
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

process.exitCode = main();
