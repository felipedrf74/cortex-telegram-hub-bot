// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Release identity for the running process.
 *
 * Answers "what exactly is running here?" without SSH or git on the host:
 *   - build identity from `dist/release-stamp.json`, written at build time by
 *     `scripts/write-release-stamp.mjs` (deterministic per commit so the
 *     release artifact digest stays stable);
 *   - migration state by diffing `migrations/*.sql` against `_migrations`;
 *   - the portal admin exposure mode and which optional ops integrations are
 *     configured (booleans only — never values).
 *
 * Consumed by `GET /api/release` (portal), `/health` and `/health/detailed`.
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { getDb } from './database';
import { getPortalAdminExposureMode, type PortalAdminExposureMode } from '../portal/security';
import { isEnabled as isSentryEnabled } from './error-tracker';
import { isAnthropicRuntimeEnabled } from './runtime-flags';
import { readDeployedReleaseIdentity } from './release-runtime-identity';

export interface ReleaseStamp {
  stampVersion: number;
  version: string | null;
  gitSha: string | null;
  gitShortSha: string | null;
  branch: string | null;
  commitTime: string | null;
  dirty: boolean | null;
  migrationCount: number | null;
}

export interface MigrationStatus {
  applied: number;
  available: number;
  latestApplied: string | null;
  pending: string[];
  /** Applied rows whose file is no longer on disk (renamed/removed). */
  unknownApplied: string[];
}

export interface ReleaseInfo {
  version: string;
  /** Container release identity (NEXUS_RELEASE_SHA / ARTIFACT_SHA256 / ROLE) when the poller deployed this process. */
  runtimeSha: string | null;
  artifactDigest: string | null;
  releaseRole: 'staging' | 'production' | null;
  gitSha: string | null;
  gitShortSha: string | null;
  branch: string | null;
  commitTime: string | null;
  dirty: boolean | null;
  stampPresent: boolean;
  /** Stamp file mtime — the moment the build landed on this host. */
  deployedAt: string | null;
  bootedAt: string;
  uptimeSeconds: number;
  node: string;
  platform: string;
  pid: number;
  env: string;
  migrations: MigrationStatus;
  adminExposureMode: PortalAdminExposureMode;
  betaHardened: boolean;
  integrations: {
    sentry: boolean;
    operatorAlertWebhook: boolean;
    iosApi: boolean;
    anthropic: boolean;
    ollama: boolean;
  };
  db: {
    sizeBytes: number | null;
    walBytes: number | null;
  };
  memoryMb: {
    rss: number;
    heapUsed: number;
  };
}

export interface ReleaseInfoOptions {
  startedAt: number;
  stampPath?: string;
  migrationsDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

/** `dist/release-stamp.json` sits one level above `dist/services/`. */
export function resolveReleaseStampPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RELEASE_STAMP_PATH || path.resolve(__dirname, '../release-stamp.json');
}

export function resolveMigrationsDir(): string {
  return path.resolve(__dirname, '../../migrations');
}

export function readReleaseStamp(stampPath: string): { stamp: ReleaseStamp; mtime: Date } | null {
  try {
    const raw = fs.readFileSync(stampPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ReleaseStamp>;
    const stat = fs.statSync(stampPath);
    return {
      stamp: {
        stampVersion: Number(parsed.stampVersion ?? 0),
        version: typeof parsed.version === 'string' ? parsed.version : null,
        gitSha: typeof parsed.gitSha === 'string' ? parsed.gitSha : null,
        gitShortSha: typeof parsed.gitShortSha === 'string' ? parsed.gitShortSha : null,
        branch: typeof parsed.branch === 'string' ? parsed.branch : null,
        commitTime: typeof parsed.commitTime === 'string' ? parsed.commitTime : null,
        dirty: typeof parsed.dirty === 'boolean' ? parsed.dirty : null,
        migrationCount: typeof parsed.migrationCount === 'number' ? parsed.migrationCount : null,
      },
      mtime: stat.mtime,
    };
  } catch {
    return null;
  }
}

function packageVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function getMigrationStatus(migrationsDir: string = resolveMigrationsDir()): MigrationStatus {
  let available: string[] = [];
  try {
    available = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    available = [];
  }

  let applied: string[] = [];
  try {
    applied = (getDb().prepare('SELECT filename FROM _migrations ORDER BY filename ASC').all() as { filename: string }[])
      .map((row) => row.filename);
  } catch {
    applied = [];
  }

  const appliedSet = new Set(applied);
  const availableSet = new Set(available);
  return {
    applied: applied.length,
    available: available.length,
    latestApplied: applied.length > 0 ? applied[applied.length - 1] : null,
    pending: available.filter((file) => !appliedSet.has(file)),
    unknownApplied: applied.filter((file) => !availableSet.has(file)),
  };
}

function databaseFootprint(): ReleaseInfo['db'] {
  let sizeBytes: number | null = null;
  let walBytes: number | null = null;
  try {
    const db = getDb();
    const pageCount = Number(db.pragma('page_count', { simple: true }));
    const pageSize = Number(db.pragma('page_size', { simple: true }));
    if (Number.isFinite(pageCount) && Number.isFinite(pageSize)) sizeBytes = pageCount * pageSize;
  } catch {
    sizeBytes = null;
  }
  try {
    const dbPath = config.app?.databasePath;
    if (dbPath && dbPath !== ':memory:') {
      walBytes = fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0;
    }
  } catch {
    walBytes = null;
  }
  return { sizeBytes, walBytes };
}

export function getReleaseInfo(options: ReleaseInfoOptions): ReleaseInfo {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const stampRead = readReleaseStamp(options.stampPath ?? resolveReleaseStampPath(env));
  const stamp = stampRead?.stamp ?? null;
  const deployed = readDeployedReleaseIdentity(env);
  const mem = process.memoryUsage();
  // The container release plan is authoritative for what is running; the
  // build stamp fills in branch/commit detail and covers non-container hosts.
  const gitSha = deployed?.runtimeSha ?? stamp?.gitSha ?? null;

  return {
    version: stamp?.version || packageVersion(),
    runtimeSha: deployed?.runtimeSha ?? null,
    artifactDigest: deployed?.artifactDigest ?? null,
    releaseRole: deployed?.role ?? null,
    gitSha,
    gitShortSha: gitSha ? gitSha.slice(0, 8) : null,
    branch: stamp?.branch ?? null,
    commitTime: stamp?.commitTime ?? null,
    dirty: stamp?.dirty ?? null,
    stampPresent: Boolean(stamp),
    deployedAt: stampRead ? stampRead.mtime.toISOString() : null,
    bootedAt: new Date(options.startedAt).toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((now - options.startedAt) / 1000)),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    pid: process.pid,
    env: env.NODE_ENV || 'development',
    migrations: getMigrationStatus(options.migrationsDir),
    adminExposureMode: getPortalAdminExposureMode(config.portal),
    betaHardened: Boolean(config.portal?.betaHardened),
    integrations: {
      sentry: safeBool(() => isSentryEnabled()),
      operatorAlertWebhook: Boolean(env.OPERATOR_ALERT_WEBHOOK_URL),
      iosApi: Boolean(config.ios?.enabled),
      anthropic: safeBool(() => isAnthropicRuntimeEnabled(env)),
      ollama: Boolean(config.ollama?.enabled),
    },
    db: databaseFootprint(),
    memoryMb: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    },
  };
}

function safeBool(read: () => boolean): boolean {
  try {
    return Boolean(read());
  } catch {
    return false;
  }
}
