// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Rehearse (default) or apply the additive LEGACY_ACTIVE revision backfill.
 *
 * This script deliberately opens only the configured SQLite database. It does
 * not run migrations, boot workers, call providers, reschedule sessions or
 * mutate legacy Training rows. Apply mode requires an explicit confirmation.
 *
 * Examples:
 *   npx tsx scripts/training-plan-revision-v1-backfill.ts --tenant=9 --user=7
 *   npx tsx scripts/training-plan-revision-v1-backfill.ts --tenant=9 --user=7 --apply --confirm=LEGACY_ACTIVE --expected-digest=<dry-run-digest>
 */

import Database from 'better-sqlite3';
import { config } from '../src/config';
import { runLegacyActivePlanBackfill } from '../src/services/training-plan-revision-legacy-backfill';
import { assertTrainingProfileSnapshotEncryptionAvailable } from '../src/services/training-profile-snapshot-encryption';

const args = new Map(
  process.argv.slice(2).map((raw) => {
    const [key, ...rest] = raw.split('=');
    return [key, rest.join('=') || 'true'];
  }),
);
const apply = args.has('--apply');
if (apply) assertTrainingProfileSnapshotEncryptionAvailable(process.env);
if (apply && args.get('--confirm') !== 'LEGACY_ACTIVE') {
  throw new Error('Apply mode requires --confirm=LEGACY_ACTIVE');
}
const expectedDigest = args.get('--expected-digest');
if (apply && (!expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest))) {
  throw new Error('Apply mode requires --expected-digest=<64-character dry-run digest>');
}
const userId = optionalPositiveInt(args.get('--user'), '--user');
const tenantId = optionalPositiveInt(args.get('--tenant'), '--tenant');
if ((userId == null) !== (tenantId == null)) {
  throw new Error('--user and --tenant must be supplied together');
}
const planId = optionalPositiveInt(args.get('--plan'), '--plan');
const db = new Database(config.app.databasePath, apply ? undefined : { readonly: true });
try {
  const migration = db.prepare(`
    SELECT 1 FROM _migrations WHERE filename = '228_training_plan_revision_v1.sql'
  `).get();
  if (!migration) throw new Error('Migration 228 is not applied; refusing backfill rehearsal.');
  if (apply) db.pragma('foreign_keys = ON');
  const result = runLegacyActivePlanBackfill({
    mode: apply ? 'apply' : 'dry_run',
    ...(userId != null && tenantId != null ? { scope: { userId, tenantId } } : {}),
    ...(planId != null ? { planId } : {}),
    ...(apply ? { expectedDigest } : {}),
    db,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  db.close();
}

function optionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw == null) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is outside the safe integer range`);
  return value;
}
