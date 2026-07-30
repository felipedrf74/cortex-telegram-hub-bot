#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 14 — offline routing-confidence calibration. ZERO LLM calls.
 *
 * Replays the labeled routing corpus through the routing surfaces via
 * routing-accuracy's replay machinery and emits
 * config/routing-calibration.json:
 *
 *   - per surface+branch empirical precision (orchestrator resolveConfidence
 *     branches grouped by their stated confidence; LLM classify surface
 *     replayed ONLY from the routing_llm_classify_cache table)
 *   - intent-resolver rawScore buckets → empirical precision
 *   - clarify epsilon (policy constant) + actionable floor (reuses
 *     routing-accuracy's recommendClarifyThreshold math)
 *
 * Corpus mode fails closed when the database is missing or has no labeled
 * rows. The documented BOOTSTRAP table is emitted only with explicit
 * --bootstrap authorization. Provenance is embedded:
 * {source: 'bootstrap'|'corpus', corpusSize, generatedAt}.
 *
 * Flags:
 *   --db=<path>     SQLite database (default ./data/bot.db)
 *   --out=<path>    Output path (default ./config/routing-calibration.json)
 *   --generated-at=<canonical ISO>
 *                   Required for corpus-mode output so a reviewed timestamp
 *                   can be reused and the tracked artifact is reproducible
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
const generatedAtRaw = readArg('--generated-at');

function parseGeneratedAt(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)
    || Number.isNaN(Date.parse(raw))
    || new Date(raw).toISOString() !== raw
  ) {
    throw new Error(
      '--generated-at must be a canonical UTC ISO timestamp with milliseconds',
    );
  }
  return raw;
}

async function main(): Promise<void> {
  const {
    BOOTSTRAP_ROUTING_CALIBRATION,
    buildCorpusRoutingCalibration,
    deriveClassifierFloorCalibration,
    getRoutingCalibration,
  } = await import('../src/services/intent-resolution/confidence');
  const generatedAt = parseGeneratedAt(generatedAtRaw);
  if (!forceBootstrap && !fs.existsSync(dbPath)) {
    throw new Error(
      'Routing corpus database does not exist; use --bootstrap only for explicit bootstrap emission',
    );
  }

  // Bootstrap emissions keep the PINNED provenance.generatedAt from the
  // BOOTSTRAP constants so the emitted file is byte-for-byte reproducible
  // (the golden test compares the generated file against the constants,
  // timestamp included). Corpus-mode emissions stamp the real run time.
  let table = BOOTSTRAP_ROUTING_CALIBRATION;
  let labeledCount = 0;
  let llmCoveredCount = 0;
  let classifierFloorCalibrated = false;
  let baselineProvenance = BOOTSTRAP_ROUTING_CALIBRATION.provenance;

  if (!forceBootstrap) {
    const db = new Database(dbPath);
    try {
      const { withStandaloneToolDatabaseAsync } = await import('../src/services/standalone-tool-database');
      await withStandaloneToolDatabaseAsync(db, async () => {
        const { ensureRoutingCorpusTables, listLabeledRoutingCorpusItems } = await import('../src/services/routing-corpus');
        const { predictRoutingSurfaces } = await import('../src/services/routing-accuracy');
        const { resolveIntentAgainst } = await import('../src/services/intent-resolution/intent-resolver');
        const { getCompiledIntentVocabulary } = await import('../src/services/intent-resolution/vocabulary');
        ensureRoutingCorpusTables(db);
        const items = listLabeledRoutingCorpusItems(db).filter((item) => item.labelDomain !== null);
        labeledCount = items.length;
        if (labeledCount === 0) {
          throw new Error(
            'Routing corpus database has no labeled items; use --bootstrap only for explicit bootstrap emission',
          );
        }
        if (!generatedAt) {
          throw new Error(
            'Corpus-mode calibration requires --generated-at=<canonical UTC ISO timestamp>',
          );
        }
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
        const baseline = getRoutingCalibration();
        baselineProvenance = baseline.provenance;
        llmCoveredCount = llmClassifier.length;
        const classifierFloor = deriveClassifierFloorCalibration({
          observations: llmClassifier,
          corpusSize: labeledCount,
          baselineFloor: baseline.classifier.lowConfidenceFloor,
        });
        classifierFloorCalibrated = classifierFloor.calibrated;
        table = buildCorpusRoutingCalibration({
          orchestrator,
          resolver,
          llmClassifier,
          corpusSize: labeledCount,
          generatedAt,
          // Group branches by the table that was active during this replay.
          baseline,
        });
      });
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
    llmCoverage: {
      covered: llmCoveredCount,
      total: labeledCount,
      complete: labeledCount > 0 && llmCoveredCount === labeledCount,
      classifierFloorCalibrated,
    },
    baselineProvenance,
    table,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
