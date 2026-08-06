// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Compiled operator entrypoint for deterministic Training compatibility repair.
 *
 * Dry-run is the default and opens the configured database read-only. Apply is
 * guarded by a dedicated environment interlock, an exact confirmation phrase,
 * and the digest from the matching dry-run. This command never calls a model,
 * worker, or migration runner. It may delete a calendar event only when an
 * orphaned ownership row supplies the exact tenant/user/plan/provider proof;
 * ambiguous active-plan findings remain report-only.
 */

import Database from 'better-sqlite3';
import { config } from '../config';
import {
  runTrainingPlanRepair,
  type OwnedTrainingProviderEventDeletion,
  type TrainingPlanRepairResult,
} from '../services/training-plan-repair';
import { deleteTrainingCalendarEventWithRetry } from '../services/training-calendar-provider-retry';

const APPLY_CONFIRMATION = 'TRAINING_PLAN_REPAIR';
const APPLY_INTERLOCK = 'TRAINING_PLAN_REPAIR_APPLY_ENABLED';
const MIGRATION_FILENAME = '273_training_plan_generation_idempotency_lease.sql';

export const TRAINING_PLAN_REPAIR_USAGE = `Training plan compatibility repair (F5)

Usage:
  npm run training:plan:repair -- [--tenant=N --user=N]

Default behavior is a read-only dry-run. Apply additionally requires:
  ${APPLY_INTERLOCK}=true
  --apply
  --confirm=${APPLY_CONFIRMATION}
  --expected-digest=<64-character digest from the matching dry-run>

The command never runs migrations, starts workers, generates coaching content,
or guesses between ambiguous active plans. Apply may delete only provider
events proven by an orphaned Training ownership row; the local row is marked
deleted only after the precise provider delete succeeds or is already gone.`;

export interface TrainingPlanRepairCliOptions {
  mode: 'dry_run' | 'apply';
  tenantId?: number;
  userId?: number;
  expectedDigest?: string;
  help: boolean;
}

export interface TrainingPlanRepairCliDependencies {
  databasePath?: string;
  env?: NodeJS.ProcessEnv;
  writeOutput?: (value: string) => void;
  deleteOwnedProviderEvent?: (
    input: OwnedTrainingProviderEventDeletion,
  ) => Promise<{ alreadyGone?: boolean } | void>;
}

export function parseTrainingPlanRepairArgs(
  argv: readonly string[],
): TrainingPlanRepairCliOptions {
  const values = new Map<string, string>();
  let apply = false;
  let help = false;

  for (const raw of argv) {
    if (raw === '--apply') {
      if (apply) throw new Error('--apply may be supplied only once');
      apply = true;
      continue;
    }
    if (raw === '--help' || raw === '-h') {
      if (help) throw new Error('--help may be supplied only once');
      help = true;
      continue;
    }
    const match = raw.match(/^--(tenant|user|confirm|expected-digest)=(.+)$/);
    if (!match) throw new Error(`Unknown or malformed argument: ${raw}`);
    const [, key, value] = match;
    if (values.has(key)) throw new Error(`--${key} may be supplied only once`);
    values.set(key, value);
  }

  if (help) {
    if (argv.length !== 1) throw new Error('--help cannot be combined with other arguments');
    return { mode: 'dry_run', help: true };
  }

  const userId = optionalPositiveInt(values.get('user'), '--user');
  const tenantId = optionalPositiveInt(values.get('tenant'), '--tenant');
  if ((userId == null) !== (tenantId == null)) {
    throw new Error('--user and --tenant must be supplied together');
  }
  const confirmation = values.get('confirm');
  const expectedDigest = values.get('expected-digest');

  if (!apply && (confirmation != null || expectedDigest != null)) {
    throw new Error('--confirm and --expected-digest are valid only with --apply');
  }
  if (apply && confirmation !== APPLY_CONFIRMATION) {
    throw new Error(`Apply mode requires --confirm=${APPLY_CONFIRMATION}`);
  }
  if (apply && (!expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest))) {
    throw new Error('Apply mode requires --expected-digest=<64-character dry-run digest>');
  }

  return {
    mode: apply ? 'apply' : 'dry_run',
    ...(tenantId != null && userId != null ? { tenantId, userId } : {}),
    ...(expectedDigest != null ? { expectedDigest } : {}),
    help: false,
  };
}

export async function runTrainingPlanRepairCli(
  argv: readonly string[],
  dependencies: TrainingPlanRepairCliDependencies = {},
): Promise<TrainingPlanRepairResult | undefined> {
  const options = parseTrainingPlanRepairArgs(argv);
  const writeOutput = dependencies.writeOutput ?? ((value: string) => process.stdout.write(value));
  if (options.help) {
    writeOutput(`${TRAINING_PLAN_REPAIR_USAGE}\n`);
    return undefined;
  }

  const env = dependencies.env ?? process.env;
  const apply = options.mode === 'apply';
  if (apply && env[APPLY_INTERLOCK] !== 'true') {
    throw new Error(`Apply mode requires ${APPLY_INTERLOCK}=true`);
  }

  const databasePath = dependencies.databasePath ?? config.app.databasePath;
  const db = new Database(databasePath, {
    readonly: !apply,
    fileMustExist: true,
  });
  try {
    assertMigrationApplied(db);
    if (apply) db.pragma('foreign_keys = ON');
    const scope = options.userId != null && options.tenantId != null
      ? { userId: options.userId, tenantId: options.tenantId }
      : undefined;
    const result = options.mode === 'apply'
      ? await runTrainingPlanRepair(db, {
        mode: 'apply',
        expectedDigest: options.expectedDigest!,
        ...(scope ? { scope } : {}),
      }, {
        deleteOwnedProviderEvent: dependencies.deleteOwnedProviderEvent
          ?? deleteOwnedProviderEvent,
      })
      : await runTrainingPlanRepair(db, {
        mode: 'dry_run',
        ...(scope ? { scope } : {}),
      });
    writeOutput(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    db.close();
  }
}

async function deleteOwnedProviderEvent(
  input: OwnedTrainingProviderEventDeletion,
): Promise<{ alreadyGone: boolean }> {
  const result = await deleteTrainingCalendarEventWithRetry(
    input.eventId,
    input.source,
    input.userId,
    {
      userId: input.userId,
      tenantId: input.tenantId,
      planId: input.planId,
      ownershipId: input.ownershipId,
      eventId: input.eventId,
      source: input.source,
    },
  );
  return { alreadyGone: result.alreadyGone };
}

function assertMigrationApplied(db: Database.Database): void {
  let applied = false;
  try {
    applied = !!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(MIGRATION_FILENAME);
  } catch {
    // Fail closed with one operator-safe message whether the ledger is absent
    // or unreadable; never include the configured database path.
  }
  if (!applied) {
    throw new Error(`Migration ${MIGRATION_FILENAME} is not applied; refusing repair rehearsal.`);
  }
}

function optionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw == null) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is outside the safe integer range`);
  return value;
}

if (require.main === module) {
  runTrainingPlanRepairCli(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : 'Unknown Training plan repair failure';
    process.stderr.write(`Training plan repair refused: ${message}\n`);
    process.exitCode = 1;
  });
}
