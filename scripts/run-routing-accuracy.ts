#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 7 — routing accuracy replay over the labeled golden corpus.
 *
 * Deterministic by default: replays labeled routing_corpus_items through the
 * deterministic surfaces (classifier keywordMatch, shadow-route guess,
 * orchestrator analyze, M4 resolveIntent) and replays the LLM classify
 * surface ONLY from the routing_llm_classify_cache SQLite table keyed by
 * utterance HMAC. Outputs per-domain precision/recall per surface, a
 * calibration table, and a recommended clarify threshold.
 *
 * Flags:
 *   --db=<path>          SQLite database (default ./data/bot.db)
 *   --gate               Compare against the latest ACCEPTED snapshot and
 *                        exit 1 if any per-domain precision/recall drops
 *                        more than 2pts. Deterministic, zero LLM.
 *   --accept-snapshot    With --gate and explicit owner authorization, store
 *                        the current report as the accepted baseline.
 *   --refresh-llm[=N]    THE ONLY NETWORKED PATH. Performs a bounded
 *                        flash-lite classify pass (default 25 items) via the
 *                        existing classifier path for labeled items missing
 *                        cache rows, then stores results in the cache.
 *                        Never run in tests or CI.
 */

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
const gateMode = hasFlag('--gate');
const acceptSnapshot = hasFlag('--accept-snapshot');
const refreshLlm = hasFlag('--refresh-llm');
const refreshLimitRaw = readArg('--refresh-llm');
const refreshLimit = refreshLimitRaw ? Number.parseInt(refreshLimitRaw, 10) : 25;

async function main(): Promise<void> {
  const db = new Database(dbPath);
  try {
    const {
      acceptRoutingAccuracySnapshotAtomically,
      buildRoutingAccuracySnapshotCandidate,
      compareRoutingAccuracySnapshots,
      getLatestAcceptedAccuracySnapshot,
    } = await import('../src/services/routing-accuracy');
    const { ensureRoutingCorpusTables, listLabeledRoutingCorpusItems } = await import('../src/services/routing-corpus');
    ensureRoutingCorpusTables(db);

    if (refreshLlm) {
      if (gateMode) {
        // Gate runs must stay deterministic and LLM-free.
        console.error('--refresh-llm cannot be combined with --gate.');
        process.exitCode = 1;
        return;
      }
      await refreshLlmCache(db, listLabeledRoutingCorpusItems, Number.isFinite(refreshLimit) ? Math.max(refreshLimit, 1) : 25);
    }

    const snapshotCandidate = buildRoutingAccuracySnapshotCandidate({ db });
    const report = snapshotCandidate.report;
    const output: Record<string, unknown> = { schemaVersion: 'routing_accuracy_report.v1', dbPath, report };

    let gateResult: ReturnType<typeof compareRoutingAccuracySnapshots> | null = null;
    if (gateMode) {
      const accepted = getLatestAcceptedAccuracySnapshot(db);
      if (!accepted) {
        output.gate = { passed: true, skipped: true, reason: 'no_accepted_snapshot' };
      } else {
        gateResult = compareRoutingAccuracySnapshots(report, accepted);
        output.gate = gateResult;
        if (!gateResult.passed) process.exitCode = 1;
      }
    }

    if (acceptSnapshot) {
      try {
        const accepted = acceptRoutingAccuracySnapshotAtomically(snapshotCandidate, {
          gateMode,
          ownerAuthorized: process.env.NEXUS_RELEASE_OWNER_AUTHORIZED === '1',
        }, db);
        output.corpusIdentityDigest = accepted.corpusIdentityDigest;
        output.corpusReadiness = accepted.corpusReadiness;
        output.acceptedSnapshotId = accepted.snapshotId;
        output.gate = accepted.gate ?? {
          passed: true,
          skipped: true,
          reason: 'no_accepted_snapshot',
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(reason);
        output.acceptSnapshotRefused = reason;
        process.exitCode = 1;
      }
    }

    console.log(JSON.stringify(output, null, 2));
  } finally {
    db.close();
  }
}

type ListLabeledItems = typeof import('../src/services/routing-corpus')['listLabeledRoutingCorpusItems'];

/**
 * Bounded live flash-lite pass through the existing classifier path. This is
 * the ONLY networked code in the routing accuracy tooling; it is reachable
 * exclusively via the explicit --refresh-llm flag.
 */
async function refreshLlmCache(
  db: Database.Database,
  listLabeledRoutingCorpusItems: ListLabeledItems,
  limit: number,
): Promise<void> {
  console.error(`--refresh-llm: performing bounded live classify pass (max ${limit} items).`);
  // Lazy import so default (deterministic) runs never load the provider stack.
  const { classifyWithClaude } = await import('../src/router/classifier');
  const { config } = await import('../src/config');
  const missing = listLabeledRoutingCorpusItems(db).filter((item) => {
    if (!item.utteranceText) return false;
    const row = db.prepare('SELECT 1 FROM routing_llm_classify_cache WHERE utterance_hash = ?').get(item.utteranceHash);
    return row === undefined;
  }).slice(0, limit);

  const upsert = db.prepare(`
    INSERT INTO routing_llm_classify_cache (utterance_hash, domain, confidence, model)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(utterance_hash) DO UPDATE SET
      domain = excluded.domain,
      confidence = excluded.confidence,
      model = excluded.model,
      created_at = datetime('now')
  `);

  let refreshed = 0;
  for (const item of missing) {
    const result = await classifyWithClaude(item.utteranceText as string);
    upsert.run(item.utteranceHash, result.domain, result.confidence, config.gemini?.classifierModel ?? null);
    refreshed += 1;
  }
  console.error(`--refresh-llm: cached ${refreshed} classify results (${missing.length} candidates).`);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
