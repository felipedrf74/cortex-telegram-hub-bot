#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 14 — offline routing-confidence calibration. ZERO LLM calls.
 *
 * Replays the labeled routing corpus (when present) through the routing
 * surfaces via routing-accuracy's replay machinery and emits
 * config/routing-calibration.json:
 *
 *   - per surface+branch empirical precision (orchestrator resolveConfidence
 *     branches grouped by their stated confidence; LLM classify surface
 *     replayed ONLY from the routing_llm_classify_cache table)
 *   - intent-resolver rawScore buckets → empirical precision
 *   - clarify epsilon (policy constant) + actionable floor (reuses
 *     routing-accuracy's recommendClarifyThreshold math)
 *
 * With NO labeled corpus (today's state) it emits the documented BOOTSTRAP
 * table, which reproduces the current hardcoded constants EXACTLY — runtime
 * behavior is unchanged until Felipe labels the corpus and regenerates.
 * Provenance is embedded: {source: 'bootstrap'|'corpus', corpusSize,
 * generatedAt}.
 *
 * Flags:
 *   --db=<path>     SQLite database (default ./data/bot.db)
 *   --out=<path>    Output path (default ./config/routing-calibration.json)
 *   --bootstrap     Force the bootstrap table even when labels exist
 *   --dry-run       Print the table without writing the file
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', override: false, quiet: true });

function readArg(name: string): string | undefined {
  const match = process.argv.find((arg) => arg === name || arg.startsWith(`${name}=`));
  if (!match) return undefined;
  return match === name ? '' : match.slice(name.length + 1);
}

function hasFlag(name: string): boolean {
  return process.argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

const dbPath = readArg('--db') || process.env.DATABASE_PATH || './data/bot.db';
const outPath = readArg('--out') || './config/routing-calibration.json';
const forceBootstrap = hasFlag('--bootstrap');
const dryRun = hasFlag('--dry-run');

async function main(): Promise<void> {
  const {
    BOOTSTRAP_ROUTING_CALIBRATION,
    buildCorpusRoutingCalibration,
    getRoutingCalibration,
  } = await import('../src/services/intent-resolution/confidence');
  const generatedAt = new Date().toISOString();

  // Bootstrap emissions keep the PINNED provenance.generatedAt from the
  // BOOTSTRAP constants so the emitted file is byte-for-byte reproducible
  // (the golden test compares the generated file against the constants,
  // timestamp included). Corpus-mode emissions stamp the real run time.
  let table = BOOTSTRAP_ROUTING_CALIBRATION;
  let labeledCount = 0;

  if (!forceBootstrap && fs.existsSync(dbPath)) {
    const db = new Database(dbPath);
    try {
      const { ensureRoutingCorpusTables, listLabeledRoutingCorpusItems } = await import('../src/services/routing-corpus');
      const { predictRoutingSurfaces } = await import('../src/services/routing-accuracy');
      const { resolveIntentAgainst } = await import('../src/services/intent-resolution/intent-resolver');
      const { getCompiledIntentVocabulary } = await import('../src/services/intent-resolution/vocabulary');
      ensureRoutingCorpusTables(db);
      const items = listLabeledRoutingCorpusItems(db).filter((item) => item.labelDomain !== null);
      labeledCount = items.length;
      if (labeledCount > 0) {
        const vocabulary = getCompiledIntentVocabulary();
        const orchestrator: Array<{ statedConfidence: number; correct: boolean }> = [];
        const llmClassifier: Array<{ statedConfidence: number; correct: boolean }> = [];
        const resolver: Array<{ rawScore: number; correct: boolean }> = [];
        for (const item of items) {
          const label = item.labelDomain as string;
          const predictions = predictRoutingSurfaces(item, { db, vocabulary });
          for (const prediction of predictions) {
            if (!prediction.covered || typeof prediction.confidence !== 'number') continue;
            if (prediction.surface === 'orchestrator_analyze') {
              orchestrator.push({ statedConfidence: prediction.confidence, correct: prediction.domain === label });
            } else if (prediction.surface === 'llm_classify_cache') {
              llmClassifier.push({ statedConfidence: prediction.confidence, correct: prediction.domain === label });
            }
          }
          const topCandidate = resolveIntentAgainst(vocabulary, item.utteranceText ?? '')[0];
          resolver.push({
            rawScore: topCandidate?.rawScore ?? 0,
            correct: (topCandidate?.domain ?? 'none') === label,
          });
        }
        table = buildCorpusRoutingCalibration({
          orchestrator,
          resolver,
          llmClassifier,
          corpusSize: labeledCount,
          generatedAt,
          // Group branches by the table that was active during this replay.
          baseline: getRoutingCalibration(),
        });
      }
    } finally {
      db.close();
    }
  }

  const resolvedOut = path.resolve(process.cwd(), outPath);
  if (!dryRun) {
    fs.writeFileSync(resolvedOut, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify({
    schemaVersion: 'routing_calibration_run.v1',
    dbPath,
    outPath: resolvedOut,
    dryRun,
    mode: table.provenance.source,
    labeledCorpusItems: labeledCount,
    table,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
