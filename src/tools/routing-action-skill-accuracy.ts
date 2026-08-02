// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Installed, provider-free Phase 7 action-skill accuracy gate.
 *
 * The source-checkout wrapper delegates to this module; release automation
 * invokes its compiled dist/tools output. It opens the database read-only and
 * deliberately has no cache-refresh or snapshot-mutation implementation.
 */

import Database from 'better-sqlite3';

function readArg(args: string[], name: string): string | undefined {
  const exactIndex = args.indexOf(name);
  if (exactIndex !== -1) return args[exactIndex + 1] ?? '';
  const match = args.find((arg) => arg.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function hasFlag(args: string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function refuseMutationFlag(name: '--refresh-llm' | '--accept-snapshot'): never {
  throw new Error(`${name} is not supported: routing action-skill accuracy is cache-only`);
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

export async function runRoutingActionSkillAccuracyCli(
  args: string[] = process.argv.slice(2),
): Promise<number> {
  if (hasFlag(args, '--refresh-llm')) refuseMutationFlag('--refresh-llm');
  if (hasFlag(args, '--accept-snapshot')) refuseMutationFlag('--accept-snapshot');

  const dbPath = readArg(args, '--db') || process.env.DATABASE_PATH || './data/bot.db';
  const generatedAt = parseGeneratedAt(readArg(args, '--generated-at'));
  const gateMode = hasFlag(args, '--gate');
  if (gateMode && generatedAt === undefined) {
    throw new Error('--gate requires an explicit canonical --generated-at timestamp');
  }
  const runtimeSha = readArg(args, '--runtime-sha') ?? '';
  const artifactDigest = readArg(args, '--artifact-digest') ?? '';
  if (!/^[a-f0-9]{40}$/.test(runtimeSha)) {
    throw new Error('--runtime-sha must be a full lowercase deployed Git SHA');
  }
  if (!/^[a-f0-9]{64}$/.test(artifactDigest)) {
    throw new Error('--artifact-digest must be a full lowercase deployed artifact SHA-256');
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const { withStandaloneToolDatabaseAsync } = await import(
      '../services/standalone-tool-database'
    );
    return await withStandaloneToolDatabaseAsync(db, async () => {
      const { config } = await import('../config');
      const { runRoutingActionSkillAccuracy } = await import(
        '../services/routing-action-skill-accuracy'
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
      process.stdout.write(`${JSON.stringify({
        schemaVersion: 'routing_action_skill_accuracy_report.v1',
        dbPath,
        report,
      }, null, 2)}\n`);
      return gateMode && !report.gate.passed ? 1 : 0;
    });
  } finally {
    db.close();
  }
}

if (require.main === module) {
  void runRoutingActionSkillAccuracyCli()
    .then((status) => { process.exitCode = status; })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
