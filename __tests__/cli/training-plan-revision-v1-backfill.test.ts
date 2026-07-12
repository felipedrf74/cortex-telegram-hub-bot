// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseTrainingPlanRevisionBackfillArgs,
  runTrainingPlanRevisionBackfillCli,
  TRAINING_PLAN_REVISION_BACKFILL_USAGE,
} from '../../src/cli/training-plan-revision-v1-backfill';
import { runMigrationsForTest } from '../../src/services/database';

describe('training plan revision v1 compiled backfill CLI', () => {
  const scratchDirectories: string[] = [];

  afterEach(() => {
    for (const directory of scratchDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('defaults to a scoped read-only dry-run and accepts an optional plan', () => {
    expect(parseTrainingPlanRevisionBackfillArgs([
      '--tenant=9', '--user=7', '--plan=11',
    ])).toEqual({
      mode: 'dry_run', tenantId: 9, userId: 7, planId: 11, help: false,
    });
  });

  it('rejects partial scope, unknown options and apply metadata on a dry-run', () => {
    expect(() => parseTrainingPlanRevisionBackfillArgs(['--tenant=9']))
      .toThrow('--user and --tenant must be supplied together');
    expect(() => parseTrainingPlanRevisionBackfillArgs(['--database=/tmp/other.db']))
      .toThrow('Unknown or malformed argument');
    expect(() => parseTrainingPlanRevisionBackfillArgs(['--confirm=LEGACY_ACTIVE']))
      .toThrow('--confirm and --expected-digest are valid only with --apply');
  });

  it('fails closed unless apply carries the exact confirmation and dry-run digest', () => {
    expect(() => parseTrainingPlanRevisionBackfillArgs(['--apply']))
      .toThrow('Apply mode requires --confirm=LEGACY_ACTIVE');
    expect(() => parseTrainingPlanRevisionBackfillArgs([
      '--apply', '--confirm=LEGACY_ACTIVE', '--expected-digest=bad',
    ])).toThrow('64-character dry-run digest');

    const options = parseTrainingPlanRevisionBackfillArgs([
      '--apply',
      '--confirm=LEGACY_ACTIVE',
      `--expected-digest=${'a'.repeat(64)}`,
    ]);
    expect(() => runTrainingPlanRevisionBackfillCli([
      '--apply',
      '--confirm=LEGACY_ACTIVE',
      `--expected-digest=${'a'.repeat(64)}`,
    ], {
      databasePath: '/does/not/matter.db',
      env: {},
      writeOutput: () => undefined,
    })).toThrow('TRAINING_PLAN_REVISION_V1_BACKFILL_APPLY_ENABLED=true');
    expect(options.mode).toBe('apply');
  });

  it('prints help without opening a database', () => {
    let output = '';
    const result = runTrainingPlanRevisionBackfillCli(['--help'], {
      databasePath: '/missing/database.db',
      writeOutput: (value) => { output += value; },
    });
    expect(result).toBeUndefined();
    expect(output).toContain(TRAINING_PLAN_REVISION_BACKFILL_USAGE);
    expect(output).toContain('read-only dry-run');
  });

  it('runs against a file database read-only and leaves revision tables unchanged', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'training-revision-backfill-cli-'));
    scratchDirectories.push(directory);
    const databasePath = path.join(directory, 'training.db');
    const setupDb = new Database(databasePath);
    runMigrationsForTest(setupDb);
    setupDb.prepare(`
      INSERT INTO fitness_training_plans (
        user_id, tenant_id, name, sport, goal, duration_weeks, status,
        start_date, end_date, preferences_json
      ) VALUES (7, 9, 'Existing active plan', 'strength', 'General fitness', 4, 'active',
        '2026-07-01', '2026-07-28', '{}')
    `).run();
    setupDb.close();

    let output = '';
    const result = runTrainingPlanRevisionBackfillCli(['--tenant=9', '--user=7'], {
      databasePath,
      env: {},
      writeOutput: (value) => { output += value; },
    });
    expect(result).toMatchObject({ mode: 'dry_run', total: 1, wouldApply: 1, applied: 0 });
    expect(JSON.parse(output)).toMatchObject({ mode: 'dry_run', total: 1, wouldApply: 1 });

    const verifyDb = new Database(databasePath, { readonly: true });
    expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get())
      .toEqual({ count: 0 });
    expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM training_active_plan_references').get())
      .toEqual({ count: 0 });
    expect(verifyDb.prepare("SELECT COUNT(*) AS count FROM fitness_training_plans WHERE status = 'active'").get())
      .toEqual({ count: 1 });
    verifyDb.close();
  });
});
