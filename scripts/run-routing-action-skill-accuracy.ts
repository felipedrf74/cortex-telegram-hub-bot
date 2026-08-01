#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Phase 7 — offline action-skill accuracy replay for the manifest classifier.
 *
 * This command is deliberately narrower than run-routing-accuracy.ts:
 * it reads the dedicated, evidence-bound action-skill prediction cache and
 * compares those predictions with the 300 owner-labeled corpus rows. It never
 * calls a provider, refreshes either routing cache, or writes an accepted
 * snapshot.
 *
 * Flags:
 *   --db=<path>          Sanitized routing-only SQLite database
 *                       (default DATABASE_PATH, then ./data/bot.db).
 *   --generated-at=<canonical ISO>
 *                       Optional reproducible report timestamp.
 *   --runtime-sha=<sha>  Exact 40-character deployed runtime Git SHA.
 *   --artifact-digest=<sha256>
 *                       Exact 64-character deployed artifact digest.
 *   --gate               Exit 1 unless all 300 rows are covered and exact
 *                       release-bound action-skill agreement is at least 95%;
 *                       requires --generated-at.
 *
 * Explicitly unsupported:
 *   --refresh-llm       Provider-backed population is a separate, bounded,
 *                       owner-authorized operation and is not implemented by
 *                       this cache-only evaluator.
 *   --accept-snapshot   This evaluator has no snapshot or ratchet mutation.
 */

import Database from 'better-sqlite3';
import dotenv from 'dotenv';

function readArg(name: string): string | undefined {
  const exactIndex = process.argv.indexOf(name);
  if (exactIndex !== -1) return process.argv[exactIndex + 1] ?? '';
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function hasFlag(name: string): boolean {
  return process.argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function refuseMutationFlag(name: '--refresh-llm' | '--accept-snapshot'): never {
  throw new Error(
    `${name} is not supported: routing action-skill accuracy is cache-only and read-only`,
  );
}

function parseGeneratedAt(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)
    || Number.isNaN(Date.parse(raw))
    || new Date(raw).toISOString() !== raw
  ) {
    throw new Error('--generated-at must be a canonical UTC ISO timestamp with milliseconds');
  }
  return raw;
}

async function main(): Promise<void> {
  // Refuse mutation-shaped flags before reading configuration or opening a
  // database, so this command can never become an accidental provider path.
  if (hasFlag('--refresh-llm')) refuseMutationFlag('--refresh-llm');
  if (hasFlag('--accept-snapshot')) refuseMutationFlag('--accept-snapshot');

  dotenv.config({ quiet: true });
  dotenv.config({ path: '.env.local', override: false, quiet: true });

  const dbPath = readArg('--db') || process.env.DATABASE_PATH || './data/bot.db';
  const generatedAt = parseGeneratedAt(readArg('--generated-at'));
  const gateMode = hasFlag('--gate');
  if (gateMode && generatedAt === undefined) {
    throw new Error('--gate requires an explicit canonical --generated-at timestamp');
  }
  const runtimeSha = readArg('--runtime-sha') ?? '';
  const artifactDigest = readArg('--artifact-digest') ?? '';
  if (!/^[a-f0-9]{40}$/.test(runtimeSha)) {
    throw new Error('--runtime-sha must be a full lowercase deployed Git SHA');
  }
  if (!/^[a-f0-9]{64}$/.test(artifactDigest)) {
    throw new Error('--artifact-digest must be a full lowercase deployed artifact SHA-256');
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const { withStandaloneToolDatabaseAsync } = await import('../src/services/standalone-tool-database');
    await withStandaloneToolDatabaseAsync(db, async () => {
      const { config } = await import('../src/config');
      const { runRoutingActionSkillAccuracy } = await import(
        '../src/services/routing-action-skill-accuracy'
      );
      const report = runRoutingActionSkillAccuracy({
        db,
        runtimeSha,
        artifactDigest,
        provider: 'gemini',
        model: config.gemini.classifierModel,
        usageCategory: 'gemini_classify',
        generatedAt,
      });
      const output = {
        schemaVersion: 'routing_action_skill_accuracy_report.v1',
        dbPath,
        report,
      };
      console.log(JSON.stringify(output, null, 2));
      if (gateMode && !report.gate.passed) process.exitCode = 1;
    });
  } finally {
    db.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
