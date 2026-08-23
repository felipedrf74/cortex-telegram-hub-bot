// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { execFile } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { captureError } from './error-monitor';

type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export interface Pm2ProcessHealth {
  name: string;
  pmId: number | null;
  status: string;
  restartCount: number;
  unstableRestarts: number;
  uptimeMs: number | null;
  lastCrashReason: string | null;
}

export interface Pm2SupervisorHealth {
  available: boolean;
  processes: Pm2ProcessHealth[];
  error?: string;
}

interface RawPm2Process {
  name?: unknown;
  pm_id?: unknown;
  pm2_env?: {
    status?: unknown;
    restart_time?: unknown;
    unstable_restarts?: unknown;
    pm_uptime?: unknown;
    exit_code?: unknown;
    prev_restart_delay?: unknown;
  };
}

const DEFAULT_PM2_BIN = process.env.PM2_BIN || join(homedir(), '.npm-global/bin/pm2');
const PM2_PROBE_TIMEOUT_MS = 2_000;
const CRASH_LOOP_RESTART_THRESHOLD = 10;
const ALERT_COOLDOWN_MS = 15 * 60_000;
const lastAlertAtByProcess = new Map<string, number>();

function toFiniteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePm2Process(raw: RawPm2Process, nowMs: number): Pm2ProcessHealth {
  const env = raw.pm2_env ?? {};
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'unknown';
  const status = typeof env.status === 'string' && env.status.trim() ? env.status : 'unknown';
  const restartCount = Math.max(0, toFiniteNumber(env.restart_time));
  const unstableRestarts = Math.max(0, toFiniteNumber(env.unstable_restarts));
  const pmUptime = toFiniteNumber(env.pm_uptime, 0);
  const exitCode = env.exit_code;
  const restartDelay = env.prev_restart_delay;

  return {
    name,
    pmId: Number.isInteger(raw.pm_id) ? raw.pm_id as number : null,
    status,
    restartCount,
    unstableRestarts,
    uptimeMs: pmUptime > 0 ? Math.max(0, nowMs - pmUptime) : null,
    lastCrashReason: exitCode != null && String(exitCode) !== '0'
      ? `exit_code=${String(exitCode)}${restartDelay != null ? ` restart_delay=${String(restartDelay)}` : ''}`
      : null,
  };
}

function execPm2(
  execFileImpl: ExecFileLike,
  pm2Bin: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileImpl(pm2Bin, ['jlist'], {
      timeout: PM2_PROBE_TIMEOUT_MS,
      env: { ...process.env, PM2_HOME: process.env.PM2_HOME },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function getPm2SupervisorHealth(options: {
  execFileImpl?: ExecFileLike;
  pm2Bin?: string;
  nowMs?: number;
} = {}): Promise<Pm2SupervisorHealth> {
  const execFileImpl = options.execFileImpl ?? execFile as unknown as ExecFileLike;
  const pm2Bin = options.pm2Bin ?? DEFAULT_PM2_BIN;
  const nowMs = options.nowMs ?? Date.now();

  try {
    const stdout = await execPm2(execFileImpl, pm2Bin);
    const parsed = JSON.parse(stdout) as RawPm2Process[];
    if (!Array.isArray(parsed)) {
      return { available: false, processes: [], error: 'pm2 jlist returned a non-array payload' };
    }
    return {
      available: true,
      processes: parsed.map((entry) => normalizePm2Process(entry, nowMs)),
    };
  } catch (error) {
    return {
      available: false,
      processes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function shouldAlert(process: Pm2ProcessHealth, nowMs: number): boolean {
  if (process.status === 'online' && process.restartCount < CRASH_LOOP_RESTART_THRESHOLD && process.unstableRestarts === 0) {
    return false;
  }

  const key = `${process.name}:${process.status}:${process.restartCount}:${process.unstableRestarts}`;
  const lastAlertAt = lastAlertAtByProcess.get(key) ?? 0;
  if (lastAlertAt > 0 && nowMs - lastAlertAt < ALERT_COOLDOWN_MS) return false;
  lastAlertAtByProcess.set(key, nowMs);
  return true;
}

export function recordPm2SupervisorAlerts(
  health: Pm2SupervisorHealth,
  nowMs = Date.now(),
): number {
  if (!health.available) return 0;

  let alertCount = 0;
  for (const process of health.processes) {
    if (!shouldAlert(process, nowMs)) continue;
    alertCount++;
    captureError({
      level: process.status === 'online' ? 'warning' : 'error',
      source: 'process',
      message: `PM2 supervisor attention required: ${process.name} status=${process.status} restarts=${process.restartCount} unstable=${process.unstableRestarts}`,
      context: {
        process: process.name,
        pmId: process.pmId,
        status: process.status,
        restartCount: process.restartCount,
        unstableRestarts: process.unstableRestarts,
        uptimeMs: process.uptimeMs,
        lastCrashReason: process.lastCrashReason,
      },
    });
  }
  return alertCount;
}

export function resetPm2HealthAlertStateForTests(): void {
  lastAlertAtByProcess.clear();
}
