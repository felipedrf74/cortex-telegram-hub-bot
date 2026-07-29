#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 7 — golden routing corpus export.
 *
 * Offline candidate export into routing_corpus_items ('pending'):
 *   a. classify-shadow disagreement rows (text recovered via HMAC match);
 *   b. online-eval sampler captures (text recovered via turn_id → messages);
 *   c. supported English + Portuguese eval fixture prompts (synthetic);
 *   d. recent chat-history turns whose routed domain matched no registry
 *      skill vocabulary for the utterance.
 *
 * No LLM calls, no network. Requires CLASSIFY_SHADOW_HASH_SECRET so corpus
 * hashes stay correlatable with classify_shadow_runs.
 *
 * Usage:
 *   npx tsx scripts/build-routing-corpus.ts [--db=./data/bot.db] [--history-limit=2000]
 */

import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { buildRoutingCorpus } from '../src/services/routing-corpus';

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', override: false, quiet: true });

function readArg(name: string): string | undefined {
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

const dbPath = readArg('--db') ?? process.env.DATABASE_PATH ?? './data/bot.db';
const historyLimitRaw = readArg('--history-limit');
const historyLimit = historyLimitRaw ? Number.parseInt(historyLimitRaw, 10) : undefined;
const secret = process.env.CLASSIFY_SHADOW_HASH_SECRET ?? '';

if (!secret) {
  console.error(
    'Missing CLASSIFY_SHADOW_HASH_SECRET. The corpus reuses the classify-shadow '
    + 'HMAC scheme; refusing to build with an empty secret.',
  );
  process.exitCode = 1;
} else {
  const db = new Database(dbPath);
  try {
    const summary = buildRoutingCorpus({
      db,
      secret,
      historyLimit: Number.isFinite(historyLimit) ? historyLimit : undefined,
    });
    console.log(JSON.stringify({ schemaVersion: 'routing_corpus_build.v1', dbPath, ...summary }, null, 2));
  } finally {
    db.close();
  }
}
