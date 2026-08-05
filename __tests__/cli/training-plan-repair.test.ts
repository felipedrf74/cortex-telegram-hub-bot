// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseTrainingPlanRepairArgs,
  runTrainingPlanRepairCli,
  TRAINING_PLAN_REPAIR_USAGE,
} from '../../src/cli/training-plan-repair';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

describe('training plan repair operator CLI (F5)', () => {
  const scratchDirectories: string[] = [];

  afterEach(() => {
    for (const directory of scratchDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('defaults to dry-run and accepts only a complete tenant/user scope', () => {
    expect(parseTrainingPlanRepairArgs([])).toEqual({ mode: 'dry_run', help: false });
    expect(parseTrainingPlanRepairArgs(['--tenant=9', '--user=7'])).toEqual({
      mode: 'dry_run', tenantId: 9, userId: 7, help: false,
    });
    expect(() => parseTrainingPlanRepairArgs(['--tenant=9']))
      .toThrow('--user and --tenant must be supplied together');
    expect(() => parseTrainingPlanRepairArgs(['--database=/tmp/other.db']))
      .toThrow('Unknown or malformed argument');
  });

  it('requires the exact confirmation, digest, and environment interlock for apply', async () => {
    expect(() => parseTrainingPlanRepairArgs(['--apply']))
      .toThrow('Apply mode requires --confirm=TRAINING_PLAN_REPAIR');
    expect(() => parseTrainingPlanRepairArgs([
      '--apply', '--confirm=TRAINING_PLAN_REPAIR', '--expected-digest=bad',
    ])).toThrow('64-character dry-run digest');
    expect(() => parseTrainingPlanRepairArgs(['--expected-digest=' + 'a'.repeat(64)]))
      .toThrow('--confirm and --expected-digest are valid only with --apply');

    await expect(runTrainingPlanRepairCli([
      '--apply',
      '--confirm=TRAINING_PLAN_REPAIR',
      `--expected-digest=${'a'.repeat(64)}`,
    ], {
      databasePath: '/does/not/matter.db',
      env: {},
      writeOutput: () => undefined,
    })).rejects.toThrow('TRAINING_PLAN_REPAIR_APPLY_ENABLED=true');
  });

  it('prints help without opening a database', async () => {
    let output = '';
    await expect(runTrainingPlanRepairCli(['--help'], {
      databasePath: '/missing/database.db',
      writeOutput: (value) => { output += value; },
    })).resolves.toBeUndefined();
    expect(output).toContain(TRAINING_PLAN_REPAIR_USAGE);
    expect(output).toContain('read-only dry-run');
  });

  it('pins apply to the dry-run digest and is a no-op on a second scan-pinned run', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'training-plan-repair-cli-'));
    scratchDirectories.push(directory);
    const databasePath = path.join(directory, 'training.db');
    const templateDb = createMigratedTestDatabase();
    fs.writeFileSync(databasePath, templateDb.serialize());
    templateDb.close();

    const setupDb = new Database(databasePath);
    setupDb.prepare(`
      INSERT INTO users (
        telegram_id, first_name, tier, status,
        daily_message_limit, daily_token_limit, daily_cost_limit_usd
      ) VALUES (707070, 'Repair CLI', 'pro', 'active', 200, 500000, 1)
    `).run();
    setupDb.prepare(`
      INSERT INTO training_plan_generation_idempotency_scoped (
        user_id, tenant_id, idempotency_key, request_hash, status,
        lease_expires_at, updated_at
      ) VALUES (1, 1, 'cli:stale', 'hash', 'in_progress',
        '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
    `).run();
    setupDb.close();

    const dryRun = await runTrainingPlanRepairCli(['--tenant=1', '--user=1'], {
      databasePath,
      env: {},
      writeOutput: () => undefined,
    });
    expect(dryRun).toMatchObject({ mode: 'dry_run', repaired: 0 });
    expect(dryRun?.findings.map((finding) => finding.kind))
      .toContain('stale_idempotency_claim');

    const applied = await runTrainingPlanRepairCli([
      '--tenant=1',
      '--user=1',
      '--apply',
      '--confirm=TRAINING_PLAN_REPAIR',
      `--expected-digest=${dryRun?.digest}`,
    ], {
      databasePath,
      env: { TRAINING_PLAN_REPAIR_APPLY_ENABLED: 'true' },
      writeOutput: () => undefined,
    });
    expect(applied).toMatchObject({ mode: 'apply', repaired: 1 });

    const secondDryRun = await runTrainingPlanRepairCli(['--tenant=1', '--user=1'], {
      databasePath,
      env: {},
      writeOutput: () => undefined,
    });
    const secondApply = await runTrainingPlanRepairCli([
      '--tenant=1',
      '--user=1',
      '--apply',
      '--confirm=TRAINING_PLAN_REPAIR',
      `--expected-digest=${secondDryRun?.digest}`,
    ], {
      databasePath,
      env: { TRAINING_PLAN_REPAIR_APPLY_ENABLED: 'true' },
      writeOutput: () => undefined,
    });
    expect(secondApply).toMatchObject({ mode: 'apply', repaired: 0, findings: [] });
  });

  it('routes ownership-proven orphan deletion through an injected provider boundary', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'training-plan-repair-provider-cli-'));
    scratchDirectories.push(directory);
    const databasePath = path.join(directory, 'training.db');
    const templateDb = createMigratedTestDatabase();
    fs.writeFileSync(databasePath, templateDb.serialize());
    templateDb.close();

    const setupDb = new Database(databasePath);
    setupDb.prepare(`
      INSERT INTO users (
        telegram_id, first_name, tier, status,
        daily_message_limit, daily_token_limit, daily_cost_limit_usd
      ) VALUES (808080, 'Repair Provider CLI', 'pro', 'active', 200, 500000, 1)
    `).run();
    const planId = Number(setupDb.prepare(`
      INSERT INTO fitness_training_plans (
        user_id, tenant_id, name, sport, duration_weeks,
        start_date, end_date, status
      ) VALUES (1, 1, 'Cancelled source', 'strength', 4,
        '2026-04-01', '2026-04-29', 'cancelled')
    `).run().lastInsertRowid);
    setupDb.prepare(`
      INSERT INTO training_agenda_event_ownership (
        plan_id, plan_version, session_id, user_id, tenant_id,
        calendar_event_id, calendar_source, status
      ) VALUES (?, 1, NULL, 1, 1, 'private-provider-id', 'google', 'orphaned')
    `).run(planId);
    setupDb.close();

    let dryRunOutput = '';
    const dryRun = await runTrainingPlanRepairCli(['--tenant=1', '--user=1'], {
      databasePath,
      env: {},
      writeOutput: (value) => { dryRunOutput += value; },
    });
    expect(dryRunOutput).not.toContain('private-provider-id');
    expect(dryRun?.findings).toContainEqual(expect.objectContaining({
      kind: 'orphaned_provider_event',
      repairable: true,
    }));

    const deleteOwnedProviderEvent = vi.fn().mockResolvedValue({ alreadyGone: false });
    const applied = await runTrainingPlanRepairCli([
      '--tenant=1',
      '--user=1',
      '--apply',
      '--confirm=TRAINING_PLAN_REPAIR',
      `--expected-digest=${dryRun?.digest}`,
    ], {
      databasePath,
      env: { TRAINING_PLAN_REPAIR_APPLY_ENABLED: 'true' },
      deleteOwnedProviderEvent,
      writeOutput: () => undefined,
    });
    expect(applied).toMatchObject({ mode: 'apply', repaired: 1 });
    expect(deleteOwnedProviderEvent).toHaveBeenCalledOnce();
    expect(deleteOwnedProviderEvent).toHaveBeenCalledWith(expect.objectContaining({
      planId,
      userId: 1,
      tenantId: 1,
      eventId: 'private-provider-id',
      source: 'google',
    }));

    const verifyDb = new Database(databasePath, { readonly: true });
    expect(verifyDb.prepare(`
      SELECT status FROM training_agenda_event_ownership WHERE plan_id = ?
    `).get(planId)).toEqual({ status: 'deleted' });
    verifyDb.close();
  });

  it('is exposed only as the compiled dry-run-default npm entry', () => {
    const packageJson = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', 'package.json'),
      'utf8',
    )) as { scripts: Record<string, string> };
    expect(packageJson.scripts['training:plan:repair'])
      .toBe('node dist/cli/training-plan-repair.js');
  });
});
