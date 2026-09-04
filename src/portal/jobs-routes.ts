// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Scheduled job control for the operator portal.
 *
 *   GET  /api/jobs                  every registered cron job: telemetry status,
 *                                   AgentJobManifest governance, next fire time,
 *                                   24h outcome counts, and the manual-run policy
 *   GET  /api/jobs/:name/history    recent job_history rows for one job
 *   POST /api/jobs/:name/run        admin, audited — fire the wrapped runner now
 *
 * Pause/resume is deliberately not a runtime toggle: job lifecycle is governed
 * by `config/agent-job-manifest.json` (`lifecycle: 'paused'`) and the owning
 * sub-skill (`setJobEnabledChecker`). The API surfaces both so the operator can
 * see why a job will not run; changing that is a reviewed config change.
 *
 * Manual-run policy is derived, not configured per job:
 *   deny     paused by manifest, or owning sub-skill disabled
 *   confirm  manifest `providerUsage: governed-provider-capable` (may spend AI budget)
 *   allow    everything else
 */

import type { Express, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { extractClientIp } from '../api/rate-limiter';
import { CronExpressionParser } from 'cron-parser';
import { config } from '../config';
import { getDb } from '../services/database';
import { loadAgentJobManifest, type AgentJobManifestEntry } from '../services/agent-job-manifest';
import { isPausedContentAgent } from '../services/content-agent-lifecycle';
import { requirePortalAdminToken } from '../api/secret-guards';
import { logger } from '../utils/logger';
import { logPortalAdminMutation } from './admin-audit';
import { sendPortalInternalError } from './http';
import { getJobMap, getJobStatuses, isJobEnabled, type JobStatus } from './telemetry';
import { isPortalActionRateLimited, PORTAL_ACTION_COOLDOWN_MS, recordPortalAction } from './actions';

export type ManualRunPolicy = 'allow' | 'confirm' | 'deny';

export interface PortalJobGovernance {
  policyOwner: string;
  jobVersion: string;
  providerUsage: AgentJobManifestEntry['providerUsage'];
  costPolicy: string;
  overlapPolicy: string;
  retryPolicy: string;
  notificationPolicy: string;
}

export interface PortalJobRecord {
  name: string;
  label: string;
  cronExpression: string;
  domain: JobStatus['domain'];
  lifecycle: 'active' | 'paused';
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastResult: JobStatus['lastResult'];
  lastDurationMs: number | null;
  lastError: string | null;
  nextRunAt: string | null;
  manual: { policy: ManualRunPolicy; reason: string | null };
  governance: PortalJobGovernance | null;
  stats24h: { runs: number; failed: number; avgDurationMs: number | null };
  cooldownRemainingMs: number;
  runnerAvailable: boolean;
}

const JOB_NAME_PATTERN = /^[A-Za-z0-9_:.-]{1,80}$/;
const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

function cooldownKey(name: string): string {
  return `job:${name}`;
}

function manifestById(): Map<string, AgentJobManifestEntry> {
  try {
    return new Map(loadAgentJobManifest().jobs.map((job) => [job.id, job]));
  } catch (err) {
    logger.warn({ err }, 'Portal jobs: agent job manifest unavailable');
    return new Map();
  }
}

export function resolveManualRunPolicy(input: {
  lifecycle: 'active' | 'paused';
  enabled: boolean;
  manifest: AgentJobManifestEntry | null;
}): { policy: ManualRunPolicy; reason: string | null } {
  if (input.lifecycle === 'paused') return { policy: 'deny', reason: 'paused by agent job manifest' };
  if (!input.enabled) return { policy: 'deny', reason: 'owning sub-skill disabled' };
  if (input.manifest?.providerUsage === 'governed-provider-capable') {
    return { policy: 'confirm', reason: 'may call governed AI providers' };
  }
  return { policy: 'allow', reason: null };
}

function nextRunAt(cronExpression: string, lifecycle: 'active' | 'paused'): string | null {
  if (lifecycle === 'paused') return null;
  try {
    return CronExpressionParser.parse(cronExpression, { tz: config.app.timezone }).next().toDate().toISOString();
  } catch {
    return null;
  }
}

interface Stats24hRow { job_name: string; runs: number; failed: number; avg_duration_ms: number | null }

function loadStats24h(): Map<string, PortalJobRecord['stats24h']> {
  const out = new Map<string, PortalJobRecord['stats24h']>();
  try {
    const rows = getDb().prepare(`
      SELECT job_name,
             COUNT(*) AS runs,
             SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END) AS failed,
             AVG(duration_ms) AS avg_duration_ms
      FROM job_history
      WHERE ts >= datetime('now', '-24 hours')
      GROUP BY job_name
    `).all() as Stats24hRow[];
    for (const row of rows) {
      out.set(row.job_name, {
        runs: Number(row.runs) || 0,
        failed: Number(row.failed) || 0,
        avgDurationMs: row.avg_duration_ms == null ? null : Math.round(Number(row.avg_duration_ms)),
      });
    }
  } catch (err) {
    logger.debug({ err }, 'Portal jobs: job_history stats unavailable');
  }
  return out;
}

function toGovernance(entry: AgentJobManifestEntry | null): PortalJobGovernance | null {
  if (!entry) return null;
  return {
    policyOwner: entry.policyOwner,
    jobVersion: entry.jobVersion,
    providerUsage: entry.providerUsage,
    costPolicy: entry.costPolicy,
    overlapPolicy: entry.overlapPolicy,
    retryPolicy: entry.retryPolicy,
    notificationPolicy: entry.notificationPolicy,
  };
}

function buildJobRecord(
  status: JobStatus,
  manifest: AgentJobManifestEntry | null,
  stats: Map<string, PortalJobRecord['stats24h']>,
  now: number,
): PortalJobRecord {
  const lifecycle: 'active' | 'paused' = manifest?.lifecycle === 'paused' || isPausedContentAgent(status.name) ? 'paused' : 'active';
  const enabled = isJobEnabled(status.name);
  const manual = resolveManualRunPolicy({ lifecycle, enabled, manifest });
  const runner = getJobMap().get(status.name)?.wrappedFn;
  const cooldownStart = isPortalActionRateLimited(cooldownKey(status.name)) ? now : null;
  return {
    name: status.name,
    label: status.label,
    cronExpression: status.cronExpression,
    domain: status.domain,
    lifecycle,
    enabled,
    running: status.lastResult === 'running',
    lastRunAt: status.lastRunAt,
    lastResult: status.lastResult,
    lastDurationMs: status.lastDurationMs,
    lastError: status.lastError,
    nextRunAt: nextRunAt(status.cronExpression, lifecycle),
    manual,
    governance: toGovernance(manifest),
    stats24h: stats.get(status.name) ?? { runs: 0, failed: 0, avgDurationMs: null },
    cooldownRemainingMs: cooldownStart == null ? 0 : PORTAL_ACTION_COOLDOWN_MS,
    runnerAvailable: typeof runner === 'function',
  };
}

export function listPortalJobs(now = Date.now()): PortalJobRecord[] {
  const manifest = manifestById();
  const stats = loadStats24h();
  return getJobStatuses()
    .map((status) => buildJobRecord(status, manifest.get(status.name) ?? null, stats, now))
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.label.localeCompare(b.label));
}

function parseHistoryLimit(raw: unknown): number {
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return HISTORY_DEFAULT_LIMIT;
  return Math.min(parsed, HISTORY_MAX_LIMIT);
}

function validName(raw: unknown): string | null {
  return typeof raw === 'string' && JOB_NAME_PATTERN.test(raw) ? raw : null;
}


function createJobsRateLimiter() {
  const configuredLimit = Number.parseInt(process.env.PORTAL_API_RATE_LIMIT ?? '', 10);
  return rateLimit({
    windowMs: 60 * 1000,
    limit: Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 180,
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(extractClientIp(req))}`,
    legacyHeaders: false,
    standardHeaders: false,
    handler: (_req, res, _next, options) => {
      res.setHeader('Retry-After', Math.max(1, Math.ceil(options.windowMs / 1000)));
      res.status(options.statusCode).json({ ok: false, message: 'Too many portal requests from this IP. Slow down.' });
    },
  });
}

export function registerPortalJobsRoutes(app: Express): void {
  const limiter = createJobsRateLimiter();
  app.get('/api/jobs', limiter, (_req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const jobs = listPortalJobs();
      res.json({
        ok: true,
        generatedAt: new Date().toISOString(),
        timezone: config.app.timezone,
        cooldownMs: PORTAL_ACTION_COOLDOWN_MS,
        jobs,
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to load jobs', 'Portal: jobs list failed');
    }
  });

  app.get('/api/jobs/:name/history', limiter, (req: Request, res: Response) => {
    try {
      const name = validName(req.params.name);
      if (!name || !getJobMap().has(name)) {
        res.status(404).json({ ok: false, message: 'unknown job' });
        return;
      }
      const limit = parseHistoryLimit(req.query.limit);
      const rows = getDb().prepare(`
        SELECT id, result, duration_ms AS durationMs, error_message AS errorMessage, ts
        FROM job_history
        WHERE job_name = ?
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(name, limit);
      res.json({ ok: true, job: name, history: rows });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to load job history', 'Portal: job history failed');
    }
  });

  app.post('/api/jobs/:name/run', limiter, requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const name = validName(req.params.name);
      const status = name ? getJobMap().get(name) : undefined;
      if (!name || !status) {
        res.status(404).json({ ok: false, message: 'unknown job' });
        return;
      }
      const manifest = manifestById().get(name) ?? null;
      const lifecycle: 'active' | 'paused' = manifest?.lifecycle === 'paused' || isPausedContentAgent(name) ? 'paused' : 'active';
      const manual = resolveManualRunPolicy({ lifecycle, enabled: isJobEnabled(name), manifest });
      if (manual.policy === 'deny') {
        res.status(403).json({ ok: false, message: `manual run denied: ${manual.reason}`, policy: manual });
        return;
      }
      const confirmed = req.body && typeof req.body === 'object' && (req.body as { confirm?: unknown }).confirm === true;
      if (manual.policy === 'confirm' && !confirmed) {
        res.status(400).json({ ok: false, message: `confirmation required: ${manual.reason}`, policy: manual });
        return;
      }
      if (status.lastResult === 'running') {
        res.status(409).json({ ok: false, message: 'job is already running' });
        return;
      }
      if (typeof status.wrappedFn !== 'function') {
        res.status(409).json({ ok: false, message: 'job runner is not available in this process' });
        return;
      }
      if (isPortalActionRateLimited(cooldownKey(name))) {
        res.status(429).json({ ok: false, message: `cooldown active (${Math.round(PORTAL_ACTION_COOLDOWN_MS / 1000)}s between manual runs)` });
        return;
      }
      recordPortalAction(cooldownKey(name));
      logPortalAdminMutation(req, 0, 'job.run', { job: name, policy: manual.policy, confirmed });
      // Fire-and-forget: the wrapper owns telemetry, leases, and failure notification.
      status.wrappedFn().catch((err: unknown) => {
        logger.error({ err, job: name }, 'Portal manual job run failed');
      });
      res.status(202).json({ ok: true, started: true, job: name, policy: manual.policy });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to start job', 'Portal: manual job run failed');
    }
  });
}
