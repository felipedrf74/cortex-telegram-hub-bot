// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Compiled operator entrypoint for the Phase 1B calendar-sync backfill.
 *
 * Dry-run is the default and opens the configured database read-only. Apply
 * is guarded by an environment interlock, an exact confirmation phrase, and
 * the digest from a prior dry-run. Apply only writes outbox rows (emit or
 * replay) — provider work always happens in the
 * training_plan_calendar_sync worker, which re-validates the plan first.
 */

import Database from 'better-sqlite3';
import { config } from '../config';
import {
  runTrainingPlanCalendarSyncBackfill,
  type TrainingPlanCalendarSyncBackfillResult,
} from '../services/training-plan-calendar-sync-backfill';

const APPLY_CONFIRMATION = 'CALENDAR_SYNC';
const APPLY_INTERLOCK = 'TRAINING_PLAN_CALENDAR_SYNC_BACKFILL_APPLY_ENABLED';
const MIGRATION_FILENAME = '255_training_session_schedule_truth_reconciliation.sql';

export const TRAINING_PLAN_CALENDAR_SYNC_BACKFILL_USAGE = `Training plan calendar-sync backfill (Phase 1B)

Usage:
  npm run training:calendar-sync:backfill -- [--tenant=N --user=N] [--plan=N]

Default behavior is a read-only dry-run. Apply additionally requires:
  ${APPLY_INTERLOCK}=true
  --apply
  --confirm=${APPLY_CONFIRMATION}
  --expected-digest=<64-character digest from the matching dry-run>

The command never runs migrations, starts workers, or calls providers; it only
emits or replays training.plan_calendar_sync.requested.v1 outbox events that
the dedicated worker drains under its own active-plan validation.`;

export interface TrainingPlanCalendarSyncBackfillCliOptions {
  mode: 'dry_run' | 'apply';
  tenantId?: number;
  userId?: number;
  planId?: number;
  expectedDigest?: string;
  help: boolean;
}

export interface TrainingPlanCalendarSyncBackfillCliDependencies {
  databasePath?: string;
  env?: NodeJS.ProcessEnv;
  writeOutput?: (value: string) => void;
}

export function parseTrainingPlanCalendarSyncBackfillArgs(
  argv: readonly string[],
): TrainingPlanCalendarSyncBackfillCliOptions {
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
    const match = raw.match(/^--(tenant|user|plan|confirm|expected-digest)=(.+)$/);
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
  const planId = optionalPositiveInt(values.get('plan'), '--plan');
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
    ...(planId != null ? { planId } : {}),
    ...(expectedDigest != null ? { expectedDigest } : {}),
    help: false,
  };
}

export function runTrainingPlanCalendarSyncBackfillCli(
  argv: readonly string[],
  dependencies: TrainingPlanCalendarSyncBackfillCliDependencies = {},
): TrainingPlanCalendarSyncBackfillResult | undefined {
  const options = parseTrainingPlanCalendarSyncBackfillArgs(argv);
  const writeOutput = dependencies.writeOutput ?? ((value: string) => process.stdout.write(value));
  if (options.help) {
    writeOutput(`${TRAINING_PLAN_CALENDAR_SYNC_BACKFILL_USAGE}\n`);
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
    const result = runTrainingPlanCalendarSyncBackfill({
      mode: options.mode,
      ...(options.userId != null && options.tenantId != null
        ? { scope: { userId: options.userId, tenantId: options.tenantId } }
        : {}),
      ...(options.planId != null ? { planId: options.planId } : {}),
      ...(apply ? { expectedDigest: options.expectedDigest } : {}),
      db,
    });
    writeOutput(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    db.close();
  }
}

function assertMigrationApplied(db: Database.Database): void {
  let applied = false;
  try {
    applied = !!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(MIGRATION_FILENAME);
  } catch {
    // Present the same fail-closed operator message when the migration ledger
    // itself is absent or unreadable; do not leak the configured database path.
  }
  if (!applied) {
    throw new Error(`Migration ${MIGRATION_FILENAME} is not applied; refusing backfill rehearsal.`);
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
  try {
    runTrainingPlanCalendarSyncBackfillCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown backfill failure';
    process.stderr.write(`Training calendar-sync backfill refused: ${message}\n`);
    process.exitCode = 1;
  }
}
