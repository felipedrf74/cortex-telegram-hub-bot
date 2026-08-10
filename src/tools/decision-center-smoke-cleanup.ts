// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import dotenv from 'dotenv';
import { cleanupDecisionCenterSmokeItems } from '../services/decision-center';
import { closeDatabase } from '../services/database';
import { initDatabase } from '../services/database-bootstrap';

export const DECISION_CENTER_SMOKE_CLEANUP_LARGE_THRESHOLD = 50;

export interface DecisionCenterSmokeCleanupPrerequisiteInput {
  env: NodeJS.ProcessEnv;
  dryRun: boolean;
  confirm: boolean;
  previewInspected?: number;
  acknowledgeLargeCleanup?: boolean;
}

export interface DecisionCenterSmokeCleanupPrerequisiteResult {
  ok: boolean;
  missing: string[];
}

export function evaluateDecisionCenterSmokeCleanupPrerequisites(
  input: DecisionCenterSmokeCleanupPrerequisiteInput,
): DecisionCenterSmokeCleanupPrerequisiteResult {
  const missing: string[] = [];
  if (input.dryRun === input.confirm) {
    missing.push('exactly one of --dry-run or --confirm');
  }
  if (input.env.DECISION_CENTER_NOTIFICATION_SMOKE !== '1') {
    missing.push('DECISION_CENTER_NOTIFICATION_SMOKE=1');
  }
  if (
    input.confirm
    && (input.previewInspected ?? 0) > DECISION_CENTER_SMOKE_CLEANUP_LARGE_THRESHOLD
    && input.acknowledgeLargeCleanup !== true
  ) {
    missing.push('--acknowledge-large-cleanup');
  }
  return { ok: missing.length === 0, missing };
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parsePositiveInt(name: string): number {
  const raw = argValue(name);
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function printHelp(): void {
  console.log(`
Decision Center smoke cleanup

Usage:
  node dist/tools/decision-center-smoke-cleanup.js --user <id> --tenant <id> --dry-run --json
  DECISION_CENTER_NOTIFICATION_SMOKE=1 node dist/tools/decision-center-smoke-cleanup.js --user <id> --tenant <id> --confirm --json

Safety:
  --dry-run or --confirm is required.
  DECISION_CENTER_NOTIFICATION_SMOKE=1 is required for --confirm.
  If the scoped match count is above ${DECISION_CENTER_SMOKE_CLEANUP_LARGE_THRESHOLD}, --acknowledge-large-cleanup is required.
`);
}

async function run(): Promise<void> {
  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp();
    return;
  }
  dotenv.config({ path: argValue('--env-file') ?? process.env.DECISION_CENTER_NOTIFICATION_SMOKE_ENV_FILE ?? '.env', override: false });
  const dryRun = hasFlag('--dry-run');
  const confirm = hasFlag('--confirm');
  const json = hasFlag('--json');
  const initialGate = evaluateDecisionCenterSmokeCleanupPrerequisites({ env: process.env, dryRun, confirm });
  if (!initialGate.ok) {
    throw new Error(initialGate.missing.join('; '));
  }
  const userId = parsePositiveInt('--user');
  const tenantId = parsePositiveInt('--tenant');

  initDatabase();
  try {
    const preview = cleanupDecisionCenterSmokeItems({ userId, tenantId, dryRun: true });
    const confirmGate = evaluateDecisionCenterSmokeCleanupPrerequisites({
      env: process.env,
      dryRun,
      confirm,
      previewInspected: preview.inspected,
      acknowledgeLargeCleanup: hasFlag('--acknowledge-large-cleanup'),
    });
    if (!confirmGate.ok) {
      throw new Error(`Scoped cleanup matched ${preview.inspected} rows; pass --acknowledge-large-cleanup to proceed`);
    }
    const result = dryRun
      ? preview
      : cleanupDecisionCenterSmokeItems({ userId, tenantId, dryRun: false, limit: preview.inspected || 1 });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`inspected=${result.inspected} expired=${result.expired} dryRun=${result.dryRun}`);
      console.log(`countsByStatus=${JSON.stringify(result.countsByStatus)}`);
      console.log(`countsByVisibilityScope=${JSON.stringify(result.countsByVisibilityScope)}`);
    }
  } finally {
    closeDatabase();
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
