// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { execFile as execFileCallback, type ExecFileOptions } from 'child_process';
import path from 'path';
import { logger } from '../utils/logger';
import { captureError } from './error-monitor';
import { recordOperatorAlert } from './operator-alerts';

export interface GarminTenantIsolationDryRunResult {
  ok: boolean;
  mode: 'dry-run' | 'delete' | string;
  matchedCount: number;
  matchedRows?: Array<{ userId: number; reasons?: string[]; sources?: string[] }>;
  remainingCount?: number;
  ranAt?: string;
  note?: string;
}

export interface GarminTenantIsolationWatcherResult {
  ok: boolean;
  matchedCount: number;
  alerted: boolean;
  dryRun: GarminTenantIsolationDryRunResult | null;
  error?: string;
}

type CleanupScriptRunner = (
  file: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface GarminTenantIsolationWatcherOptions {
  nodePath?: string;
  scriptPath?: string;
  cwd?: string;
  runCleanupScript?: CleanupScriptRunner;
}

const DEFAULT_SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/cleanup-tainted-garmin-sessions.mjs');

function defaultCleanupScriptRunner(
  file: string,
  args: string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCallback(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function parseDryRun(stdout: string): GarminTenantIsolationDryRunResult {
  const parsed = JSON.parse(stdout) as Partial<GarminTenantIsolationDryRunResult>;
  return {
    ok: Boolean(parsed.ok),
    mode: String(parsed.mode ?? 'unknown'),
    matchedCount: Number(parsed.matchedCount ?? 0),
    matchedRows: Array.isArray(parsed.matchedRows) ? parsed.matchedRows : [],
    remainingCount: typeof parsed.remainingCount === 'number' ? parsed.remainingCount : undefined,
    ranAt: parsed.ranAt,
    note: parsed.note,
  };
}

function summarizeRows(rows: GarminTenantIsolationDryRunResult['matchedRows']): Array<Record<string, unknown>> {
  return (rows ?? []).slice(0, 20).map((row) => ({
    userId: row.userId,
    reasons: row.reasons ?? [],
    sources: row.sources ?? [],
  }));
}

export async function runGarminTenantIsolationWatcher(
  options: GarminTenantIsolationWatcherOptions = {},
): Promise<GarminTenantIsolationWatcherResult> {
  const nodePath = options.nodePath ?? process.execPath;
  const scriptPath = options.scriptPath ?? DEFAULT_SCRIPT_PATH;
  const cwd = options.cwd ?? process.cwd();
  const runCleanupScript = options.runCleanupScript ?? defaultCleanupScriptRunner;

  try {
    const { stdout, stderr } = await runCleanupScript(nodePath, [scriptPath], {
      cwd,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    if (stderr.trim()) {
      logger.warn({ stderr: stderr.slice(0, 500) }, 'Garmin tenant isolation watcher dry-run emitted stderr');
    }

    const dryRun = parseDryRun(stdout);
    if (dryRun.mode !== 'dry-run') {
      throw new Error(`cleanup script returned unexpected mode ${dryRun.mode}`);
    }

    if (dryRun.matchedCount > 0) {
      const matchedRows = summarizeRows(dryRun.matchedRows);
      captureError({
        level: 'warning',
        source: 'job',
        message: `Garmin tenant isolation watcher found ${dryRun.matchedCount} tainted row(s)`,
        context: {
          matchedCount: dryRun.matchedCount,
          remainingCount: dryRun.remainingCount,
          matchedRows,
        },
      }, false);
      const alert = recordOperatorAlert({
        severity: 'warning',
        source: 'garmin_tenant_isolation_watcher',
        dedupeKey: 'garmin:tenant-isolation:tainted-sessions',
        title: 'Garmin tenant isolation watcher found tainted sessions',
        detail: `Dry-run matched ${dryRun.matchedCount} non-owner Garmin session/token row(s). Do not run cleanup --yes until source-side isolation is verified.`,
        metadata: {
          matchedCount: dryRun.matchedCount,
          remainingCount: dryRun.remainingCount,
          matchedRows,
        },
        owner: 'ops',
        suspectedArea: 'garmin_session_store',
        userImpact: 'A non-owner account may be associated with owner Garmin token material until cleanup runs.',
        runbookUrl: 'docs/archive/2026-05/p0-garmin-tenant-leak-and-applehealth-cascade/closeout.md',
      });
      logger.warn({ matchedCount: dryRun.matchedCount, alertOk: alert.ok }, 'Garmin tenant isolation watcher detected tainted rows');
      return { ok: dryRun.ok, matchedCount: dryRun.matchedCount, alerted: alert.ok, dryRun };
    }

    logger.info({ matchedCount: 0 }, 'Garmin tenant isolation watcher clean');
    return { ok: dryRun.ok, matchedCount: 0, alerted: false, dryRun };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captureError({
      level: 'warning',
      source: 'job',
      message: `Garmin tenant isolation watcher dry-run failed: ${message}`,
      context: { scriptPath },
    }, false);
    const alert = recordOperatorAlert({
      severity: 'warning',
      source: 'garmin_tenant_isolation_watcher',
      dedupeKey: 'garmin:tenant-isolation:dry-run-failed',
      title: 'Garmin tenant isolation watcher dry-run failed',
      detail: message,
      owner: 'ops',
      suspectedArea: 'garmin_session_store',
      userImpact: 'Operators may temporarily lose daily evidence that Garmin tenant-isolation cleanup remains clean.',
      runbookUrl: 'docs/archive/2026-05/p0-garmin-tenant-leak-and-applehealth-cascade/closeout.md',
    });
    logger.warn({ err, alertOk: alert.ok }, 'Garmin tenant isolation watcher failed');
    return { ok: false, matchedCount: 0, alerted: alert.ok, dryRun: null, error: message };
  }
}
