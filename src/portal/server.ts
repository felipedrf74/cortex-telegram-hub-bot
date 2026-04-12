// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Nexus Hub Status Portal — Express server.
 *
 * Runs inside the same Node.js process as the Grammy bot.
 * Provides:
 *   GET  /              → serves the single-page dashboard (portal.html)
 *   GET  /api/snapshot  → full JSON payload for the dashboard (cached 3s)
 *   POST /api/action/:name → quick actions (refresh garmin, trigger reports, etc.)
 *
 * Auth: Bearer token from PORTAL_TOKEN env var on all /api/* routes.
 */
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Bot } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { runWithContext, generateRequestId } from '../utils/request-context';
import { getDb } from '../services/database';
import {
  getRecentEvents,
  getJobStatuses,
  getBotRef,
  isBotPollingActive,
  getLastMessageAt,
  getGarminRefreshStatus,
  isRestarting,
  setIsRestarting,
  setBotPollingActive,
  pushEvent,
} from './telemetry';
import { clearAllConversations } from '../state/conversation';
import { isGarminConfigured, keepAlive as garminKeepAlive } from '../services/garmin';
import { isMicrosoftConfigured } from '../services/microsoft-auth';
import { isInvoiceFilingConfigured } from '../services/invoice-filer';
import { isGoogleCalendarConfigured } from '../services/google-calendar';
import { isGmailConfigured } from '../services/google-gmail';
import { isGoogleDriveEnabled } from '../services/google-drive';
import { isOutlookCalendarConfigured } from '../services/outlook-calendar';
import { isOutlookMailConfigured } from '../services/outlook-mail';
import { isOutlookTodoConfigured } from '../services/microsoft-todo';
import { getPendingCount as getInvoiceQueuePending } from '../services/invoice-queue';
import { sendDailyBriefing } from '../services/scheduler';
import { generateCoachBriefing } from '../services/garmin-coach';
import { runContentDiscovery } from '../services/content-discovery';
import {
  getAllChannels as getRefChannels,
  removeChannel as removeRefChannel,
  getAllKnowledge,
} from '../state/content-references';
import { addAndAnalyzeChannel, synthesizeKnowledge as reSynthesizeKnowledge } from '../services/channel-learner';
import { escapeHtml, splitMessage } from '../utils/telegram-formatter';
import {
  getActiveSignalCount, getSignalLog, getAgentStats, dismissSignal, writeSignal,
} from '../services/intelligence-bus';
import { getPipelineStats } from '../agents/pipeline-agent';
import { runSEOAgent } from '../agents/seo-agent';
import { runReactionRadar } from '../agents/reaction-radar-agent';
import { runPerformanceAgent } from '../agents/performance-agent';
import { runVoiceEvolutionAgent } from '../agents/voice-evolution-agent';
import { runPipelineAgent } from '../agents/pipeline-agent';
import { CronExpressionParser } from 'cron-parser';
import {
  getAllSkillStatuses, enableSkill, disableSkill,
  enableSubSkill, disableSubSkill,
} from '../skills/skill-manager';
import type { DomainName } from '../domains/types';
import { getErrorTrends } from '../services/error-monitor';
import {
  verifySignature, receiveWebhookEvent, getSubscriptions, registerSubscription,
  removeSubscription, getWebhookStats, getRecentEvents as getRecentWebhookEvents,
  replayEvent, expireSubscriptions,
  type WebhookProvider,
} from '../services/webhook-registry';

// ─── Types ──────────────────────────────────────────────────────────

interface SnapshotResponse {
  version: string;
  generatedAt: string;
  uptime: { seconds: number; human: string };
  bot: {
    polling: boolean;
    restarting: boolean;
    lastMessageAt: string | null;
  };
  integrations: {
    name: string;
    configured: boolean;
    status?: string;
    lastCheck?: string;
    group?: string;
    tokenHealth?: 'valid' | 'expired' | 'warning' | 'not_configured';
    lastApiCall?: string | null;
  }[];
  jobs: ReturnType<typeof getJobStatuses>;
  jobHistory: Record<string, { result: string; ts: string }[]>;
  nextRuns: { label: string; cronExpression: string; nextFireAt: string; humanDelta: string; domain: string }[];
  apiUsage: {
    today: { calls: number; cost: number; tokens: number };
    last7d: { calls: number; cost: number; tokens: number };
    last30d: { calls: number; cost: number; tokens: number };
    byCategory: { category: string; calls: number; cost: number }[];
  };
  recentEvents: ReturnType<typeof getRecentEvents>;
  invoices: {
    thisMonth: number;
    lastMonth: number;
    recentFilings: { vendor: string; date: string; amount: string | null; status: string }[];
  };
  emailLog: {
    todaySent: number;
    todayFailed: number;
    recentEmails: { recipient: string; subject: string; status: string; source: string | null; ts: string; error_message: string | null }[];
  };
  healthSummary: {
    jobsOk: number;
    jobsTotal: number;
    emailsSentToday: number;
    apiCostToday: number;
    invoicesThisMonth: number;
    invoiceQueuePending: number;
  };
  calendarData: {
    days: string[];  // ISO date strings for the 7-day range
    jobs: {
      name: string;
      label: string;
      cronExpression: string;
      domain: string;
      runs: { day: string; hour: number; result: string; ts: string; durationMs: number | null }[];
      scheduled: { day: string; hour: number }[];
    }[];
  };
  contentReferences: {
    channels: { id: number; url: string; name: string | null; status: string; videosAnalyzed: number; lastAnalyzed: string | null; error: string | null }[];
    knowledgeCategories: number;
  };
  transcriptStats: { transcripts: number; studies: number };
  trainingPlans: {
    activePlans: number;
    totalCompletedSessions: number;
    currentWeekAdherence: number;
    currentPlanName: string | null;
  } | null;
  domainStatus: {
    domain: string;
    label: string;
    active: boolean;
    messagesToday: number;
    totalMessages: number;
    lastMessageAt: string | null;
    details: Record<string, string | number | boolean>;
  }[];
  skillStatus: {
    name: string;
    description: string;
    enabled: boolean;
    subSkills: {
      name: string;
      description: string;
      enabled: boolean;
      toolCount: number;
    }[];
  }[];
  usageMetering: {
    today: { messageCount: number; totalTokens: number; apiCalls: number; costUsd: number };
    byUser: { userId: number; messageCount: number; totalTokens: number; apiCalls: number; costUsd: number }[];
  };
  adapters?: { name: string; status: string; lastMessage?: string; lastMessageAt?: string | null; configured: boolean }[];
  apiLatency?: { route: string; count: number; p50: number; p95: number; p99: number; errorRate: number }[];
}

// ─── Snapshot Cache ─────────────────────────────────────────────────

let cachedSnapshot: { data: SnapshotResponse; at: number } | null = null;
const CACHE_TTL_MS = 3_000;

// ─── Rate Limiter (per-action, 30s cooldown) ────────────────────────

const VALID_ACTIONS = new Set([
  'refresh-garmin', 'trigger-briefing', 'trigger-coach', 'trigger-content',
  'clear-history', 'test-ssh', 'test-graph', 'restart-polling',
  'resynthesize-knowledge',
  'run-performance-agent', 'run-voice-evolution', 'run-reaction-radar',
  'run-seo-agent', 'run-pipeline-agent',
]);

const actionCooldowns = new Map<string, number>();
const ACTION_COOLDOWN_MS = 30_000;

function isRateLimited(action: string): boolean {
  const last = actionCooldowns.get(action) ?? 0;
  return Date.now() - last < ACTION_COOLDOWN_MS;
}

function recordAction(action: string): void {
  actionCooldowns.set(action, Date.now());
}

// ─── Uptime Helper ──────────────────────────────────────────────────

const startedAt = Date.now();

function humanUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

function humanDelta(seconds: number): string {
  if (seconds < 60) return 'in <1m';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

// ─── Prepared Statements (lazily cached) ─────────────────────────────

import type BetterSqlite3 from 'better-sqlite3';

let _stmts: Record<string, BetterSqlite3.Statement> | null = null;

function getStmts(): Record<string, BetterSqlite3.Statement> {
  if (_stmts) return _stmts;
  const db = getDb();
  _stmts = {
    todayUsage: db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost,
             COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM api_usage WHERE ts >= date('now')`),
    weekUsage: db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost,
             COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM api_usage WHERE ts >= date('now', '-7 days')`),
    monthUsage: db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost,
             COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM api_usage WHERE ts >= date('now', '-30 days')`),
    byCategory: db.prepare(`
      SELECT category, COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost
      FROM api_usage WHERE ts >= date('now', '-7 days')
      GROUP BY category ORDER BY cost DESC`),
    thisMonthInvoices: db.prepare(`
      SELECT COUNT(*) as c FROM invoice_filings
      WHERE document_date >= date('now', 'start of month') AND status = 'filed'`),
    lastMonthInvoices: db.prepare(`
      SELECT COUNT(*) as c FROM invoice_filings
      WHERE document_date >= date('now', 'start of month', '-1 month')
        AND document_date < date('now', 'start of month')
        AND status = 'filed'`),
    recentFilings: db.prepare(`
      SELECT vendor, document_date, amount, status
      FROM invoice_filings ORDER BY created_at DESC LIMIT 10`),
    emailTodaySent: db.prepare(`
      SELECT COUNT(*) as c FROM email_log WHERE ts >= date('now') AND status = 'sent'`),
    emailTodayFailed: db.prepare(`
      SELECT COUNT(*) as c FROM email_log WHERE ts >= date('now') AND status = 'failed'`),
    recentEmailLog: db.prepare(`
      SELECT recipient, subject, status, source, ts, error_message
      FROM email_log ORDER BY ts DESC LIMIT 20`),
    jobHistoryRecent: db.prepare(`
      SELECT job_name, result, ts
      FROM job_history ORDER BY ts DESC LIMIT 200`),
    lastSuccessForJob: db.prepare(`
      SELECT ts FROM job_history
      WHERE job_name = ? AND result = 'success'
      ORDER BY ts DESC LIMIT 1`),
    lastFailureForJob: db.prepare(`
      SELECT ts FROM job_history
      WHERE job_name = ? AND result = 'failed'
      ORDER BY ts DESC LIMIT 1`),
    jobHistory7d: db.prepare(`
      SELECT job_name, result, ts, duration_ms
      FROM job_history WHERE ts >= date('now', '-7 days')
      ORDER BY ts ASC`),
    jobHistoryMonth: db.prepare(`
      SELECT job_name, result, ts, duration_ms
      FROM job_history WHERE ts >= date('now', '-45 days')
      ORDER BY ts ASC`),
    domainMessagesToday: db.prepare(`
      SELECT domain, COUNT(*) as count
      FROM conversations WHERE created_at >= date('now')
      GROUP BY domain`),
    domainMessagesTotal: db.prepare(`
      SELECT domain, COUNT(*) as count, MAX(created_at) as last_at
      FROM conversations
      GROUP BY domain`),
  };
  return _stmts;
}

// ─── Snapshot Builder ───────────────────────────────────────────────

function buildSnapshot(): SnapshotResponse {
  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
  const garminStatus = getGarminRefreshStatus();

  // ── Integration status list ────────────────────────────────────
  // Helper: get last successful API call time for a job name (proxy for integration health)
  function lastJobSuccess(jobName: string): string | null {
    try {
      const row = getStmts().lastSuccessForJob.get(jobName) as { ts: string } | undefined;
      return row?.ts ?? null;
    } catch { return null; }
  }
  function lastJobFailure(jobName: string): string | null {
    try {
      const row = getStmts().lastFailureForJob.get(jobName) as { ts: string } | undefined;
      return row?.ts ?? null;
    } catch { return null; }
  }

  // Determine token health based on configured + recent job success/failure
  function inferTokenHealth(
    configured: boolean,
    lastSuccess: string | null,
    lastFailure: string | null,
  ): 'valid' | 'expired' | 'warning' | 'not_configured' {
    if (!configured) return 'not_configured';
    if (!lastSuccess && !lastFailure) return 'valid'; // configured but never ran — assume valid
    const successTs = lastSuccess ? new Date(lastSuccess).getTime() : 0;
    const failureTs = lastFailure ? new Date(lastFailure).getTime() : 0;
    if (failureTs > successTs) {
      // More recent failure than success → likely expired
      const hoursSinceFailure = (Date.now() - failureTs) / 3_600_000;
      return hoursSinceFailure < 24 ? 'expired' : 'warning';
    }
    // Last run was successful — check staleness
    const hoursSinceSuccess = (Date.now() - successTs) / 3_600_000;
    if (hoursSinceSuccess > 48) return 'warning';
    return 'valid';
  }

  // Google integrations
  const googleCalConfigured = isGoogleCalendarConfigured();
  const gmailConfigured = isGmailConfigured();
  const gdriveConfigured = isGoogleDriveEnabled();
  const googleLastSuccess = lastJobSuccess('daily_briefing'); // briefing uses Google Calendar
  const googleLastFailure = lastJobFailure('daily_briefing');

  // Microsoft integrations
  const msConfigured = isMicrosoftConfigured();
  const outlookCalConfigured = isOutlookCalendarConfigured();
  const outlookMailConfigured = isOutlookMailConfigured();
  const outlookTodoConfigured = isOutlookTodoConfigured();
  const msLastSuccess = lastJobSuccess('conflict_detection'); // uses Outlook Calendar
  const msLastFailure = lastJobFailure('conflict_detection');

  // Garmin
  const garminConfigured = isGarminConfigured();
  const garminLastSuccess = lastJobSuccess('garmin_keepalive');
  const garminLastFailure = lastJobFailure('garmin_keepalive');

  const integrations: SnapshotResponse['integrations'] = [
    {
      name: 'Telegram Bot',
      group: 'system',
      configured: true,
      status: isBotPollingActive() ? 'polling' : isRestarting() ? 'restarting' : 'stopped',
      tokenHealth: 'valid',
    },
    {
      name: 'Google Calendar',
      group: 'google',
      configured: googleCalConfigured,
      status: googleCalConfigured ? 'configured' : 'not configured',
      tokenHealth: inferTokenHealth(googleCalConfigured, googleLastSuccess, googleLastFailure),
      lastApiCall: googleLastSuccess,
    },
    {
      name: 'Google Drive',
      group: 'google',
      configured: gdriveConfigured,
      status: gdriveConfigured ? 'configured' : 'not configured',
      tokenHealth: inferTokenHealth(gdriveConfigured, googleLastSuccess, googleLastFailure),
      lastApiCall: googleLastSuccess,
    },
    {
      name: 'Gmail',
      group: 'google',
      configured: gmailConfigured,
      status: gmailConfigured ? 'configured' : 'not configured',
      tokenHealth: inferTokenHealth(gmailConfigured, googleLastSuccess, googleLastFailure),
      lastApiCall: googleLastSuccess,
    },
    {
      name: 'Outlook Calendar',
      group: 'microsoft',
      configured: outlookCalConfigured,
      status: outlookCalConfigured ? 'configured' : 'not configured',
      tokenHealth: inferTokenHealth(outlookCalConfigured, msLastSuccess, msLastFailure),
      lastApiCall: msLastSuccess,
    },
    {
      name: 'Outlook Mail',
      group: 'microsoft',
      configured: outlookMailConfigured,
      status: outlookMailConfigured ? 'configured' : 'not configured',
      tokenHealth: inferTokenHealth(outlookMailConfigured, msLastSuccess, msLastFailure),
      lastApiCall: msLastSuccess,
    },
    {
      name: 'Microsoft To Do',
      group: 'microsoft',
      configured: outlookTodoConfigured,
      status: outlookTodoConfigured ? 'configured' : 'not configured',
      tokenHealth: inferTokenHealth(outlookTodoConfigured, msLastSuccess, msLastFailure),
      lastApiCall: msLastSuccess,
    },
    {
      name: 'Garmin Connect',
      group: 'garmin',
      configured: garminConfigured,
      status: garminStatus.at
        ? `last refresh: ${garminStatus.ok ? '✓' : '✗'} at ${garminStatus.at}`
        : garminConfigured ? 'awaiting first refresh' : 'not configured',
      lastCheck: garminStatus.at ?? undefined,
      tokenHealth: inferTokenHealth(garminConfigured, garminLastSuccess, garminLastFailure),
      lastApiCall: garminLastSuccess,
    },
    {
      name: 'Invoice Filing (SSH)',
      group: 'system',
      configured: isInvoiceFilingConfigured(),
      status: isInvoiceFilingConfigured() ? 'configured' : 'not configured',
      tokenHealth: isInvoiceFilingConfigured() ? 'valid' : 'not_configured',
    },
    {
      name: 'Anthropic API',
      group: 'system',
      configured: true,
      status: 'active',
      tokenHealth: 'valid',
    },
  ];

  // ── API usage from SQLite ──────────────────────────────────────
  let apiUsage: SnapshotResponse['apiUsage'];
  try {
    const stmts = getStmts();
    const todayRow = stmts.todayUsage.get() as any;
    const week = stmts.weekUsage.get() as any;
    const month = stmts.monthUsage.get() as any;
    const byCategory = stmts.byCategory.all() as any[];

    apiUsage = {
      today: { calls: todayRow.calls, cost: todayRow.cost, tokens: todayRow.tokens },
      last7d: { calls: week.calls, cost: week.cost, tokens: week.tokens },
      last30d: { calls: month.calls, cost: month.cost, tokens: month.tokens },
      byCategory,
    };
  } catch (err) {
    logger.warn({ err }, 'Portal: failed to query api_usage');
    apiUsage = {
      today: { calls: 0, cost: 0, tokens: 0 },
      last7d: { calls: 0, cost: 0, tokens: 0 },
      last30d: { calls: 0, cost: 0, tokens: 0 },
      byCategory: [],
    };
  }

  // ── Invoice filings from SQLite ────────────────────────────────
  let invoices: SnapshotResponse['invoices'];
  try {
    const stmts = getStmts();
    const thisMonth = stmts.thisMonthInvoices.get() as any;
    const lastMonth = stmts.lastMonthInvoices.get() as any;
    const recent = stmts.recentFilings.all() as any[];

    invoices = {
      thisMonth: thisMonth.c,
      lastMonth: lastMonth.c,
      recentFilings: recent.map((r: any) => ({
        vendor: r.vendor,
        date: r.document_date ?? 'unknown',
        amount: r.amount,
        status: r.status,
      })),
    };
  } catch (err) {
    logger.warn({ err }, 'Portal: failed to query invoice_filings');
    invoices = { thisMonth: 0, lastMonth: 0, recentFilings: [] };
  }

  // ── Email log from SQLite ───────────────────────────────────────
  let emailLog: SnapshotResponse['emailLog'];
  try {
    const stmts = getStmts();
    const sent = stmts.emailTodaySent.get() as any;
    const failed = stmts.emailTodayFailed.get() as any;
    const recent = stmts.recentEmailLog.all() as any[];
    emailLog = {
      todaySent: sent.c,
      todayFailed: failed.c,
      recentEmails: recent.map((r: any) => ({
        recipient: r.recipient,
        subject: r.subject,
        status: r.status,
        source: r.source,
        ts: r.ts,
        error_message: r.error_message,
      })),
    };
  } catch {
    emailLog = { todaySent: 0, todayFailed: 0, recentEmails: [] };
  }

  // ── Job history (last 10 runs per job for sparklines) ──────────
  let jobHistory: Record<string, { result: string; ts: string }[]> = {};
  try {
    const stmts = getStmts();
    const rows = stmts.jobHistoryRecent.all() as any[];
    const grouped: Record<string, { result: string; ts: string }[]> = {};
    for (const r of rows) {
      if (!grouped[r.job_name]) grouped[r.job_name] = [];
      if (grouped[r.job_name].length < 10) {
        grouped[r.job_name].push({ result: r.result, ts: r.ts });
      }
    }
    jobHistory = grouped;
  } catch {
    jobHistory = {};
  }

  // ── Next runs (computed from cron expressions) ─────────────────
  const jobs = getJobStatuses();
  const nextRuns: SnapshotResponse['nextRuns'] = [];
  const tz = config.app.timezone;
  for (const job of jobs) {
    try {
      const interval = CronExpressionParser.parse(job.cronExpression, { tz });
      const next = interval.next().toDate();
      const deltaSec = Math.floor((next.getTime() - Date.now()) / 1000);
      nextRuns.push({
        label: job.label,
        cronExpression: job.cronExpression,
        nextFireAt: next.toISOString(),
        humanDelta: humanDelta(deltaSec),
        domain: job.domain,
      });
    } catch {
      // skip unparseable expressions
    }
  }
  nextRuns.sort((a, b) => new Date(a.nextFireAt).getTime() - new Date(b.nextFireAt).getTime());

  // ── Health summary ─────────────────────────────────────────────
  const jobsWithRuns = jobs.filter(j => j.lastResult !== 'never');
  const healthSummary: SnapshotResponse['healthSummary'] = {
    jobsOk: jobsWithRuns.filter(j => j.lastResult === 'success').length,
    jobsTotal: jobsWithRuns.length,
    emailsSentToday: emailLog.todaySent,
    apiCostToday: apiUsage.today.cost,
    invoicesThisMonth: invoices.thisMonth,
    invoiceQueuePending: getInvoiceQueuePending(),
  };

  // ── Calendar data (monthly view) ──────────────────────────────────
  const calendarDays: string[] = [];
  for (let i = 45; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    calendarDays.push(d.toISOString().slice(0, 10));
  }

  let calendarJobs: SnapshotResponse['calendarData']['jobs'] = [];
  try {
    const stmts = getStmts();
    const historyRows = stmts.jobHistoryMonth.all() as any[];

    for (const job of jobs) {
      const runs = historyRows
        .filter(r => r.job_name === job.name)
        .map(r => ({
          day: r.ts.slice(0, 10),
          hour: parseInt(r.ts.slice(11, 13), 10),
          result: r.result as string,
          ts: r.ts as string,
          durationMs: r.duration_ms as number | null,
        }));

      // Compute future scheduled fire times for the next 45 days (covers month view navigation)
      const scheduled: { day: string; hour: number }[] = [];
      try {
        const interval = CronExpressionParser.parse(job.cronExpression, { tz });
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + 45);
        // Only include jobs that fire at most a few times per day to avoid flooding the calendar
        const isHighFreq = job.cronExpression.startsWith('*') || job.cronExpression.startsWith('*/5') || job.cronExpression.startsWith('*/15') || job.cronExpression.startsWith('*/30');
        if (!isHighFreq) {
          let next = interval.next().toDate();
          let safety = 0;
          while (next.getTime() <= endDate.getTime() && safety < 200) {
            scheduled.push({
              day: next.toISOString().slice(0, 10),
              hour: next.getHours(),
            });
            next = interval.next().toDate();
            safety++;
          }
        }
      } catch {
        // skip unparseable
      }

      calendarJobs.push({
        name: job.name,
        label: job.label,
        cronExpression: job.cronExpression,
        domain: job.domain,
        runs,
        scheduled,
      });
    }
  } catch {
    calendarJobs = [];
  }

  // ── Content reference channels ─────────────────────────────
  let contentReferences: { channels: any[]; knowledgeCategories: number } = {
    channels: [],
    knowledgeCategories: 0,
  };
  try {
    contentReferences = {
      channels: getRefChannels().map((ch) => ({
        id: ch.id,
        url: ch.channel_url,
        name: ch.channel_name,
        status: ch.status,
        videosAnalyzed: ch.video_count_analyzed,
        lastAnalyzed: ch.last_analyzed_at,
        error: ch.error_message,
      })),
      knowledgeCategories: getAllKnowledge().length,
    };
  } catch { /* table may not exist yet */ }

  // ── Transcript stats ──────────────────────────────────────
  const transcriptStats = (() => {
    try {
      const db = getDb();
      const total = db.prepare('SELECT COUNT(*) as c FROM video_transcripts').get() as { c: number };
      const studies = db.prepare('SELECT COUNT(*) as c FROM video_studies').get() as { c: number };
      return { transcripts: total.c, studies: studies.c };
    } catch { return { transcripts: 0, studies: 0 }; }
  })();

  // ── Domain handler status ───────────────────────────────────────
  let domainStatus: SnapshotResponse['domainStatus'] = [];
  try {
    const stmts = getStmts();
    const todayRows = stmts.domainMessagesToday.all() as { domain: string; count: number }[];
    const totalRows = stmts.domainMessagesTotal.all() as { domain: string; count: number; last_at: string | null }[];

    const todayMap: Record<string, number> = {};
    for (const r of todayRows) todayMap[r.domain] = r.count;

    const totalMap: Record<string, { count: number; lastAt: string | null }> = {};
    for (const r of totalRows) totalMap[r.domain] = { count: r.count, lastAt: r.last_at };

    // Active agent count from intelligence bus
    let activeAgentCount = 0;
    let totalSignals = 0;
    try {
      const agentStats = getAgentStats();
      activeAgentCount = agentStats.filter((a: any) => a.last_status === 'success').length;
      totalSignals = getActiveSignalCount();
    } catch { /* ignore — table may not exist */ }

    const garminConnected = isGarminConfigured();
    const graphConfigured = isMicrosoftConfigured();

    domainStatus = [
      {
        domain: 'secretary',
        label: 'Secretary',
        active: true,
        messagesToday: todayMap['secretary'] || 0,
        totalMessages: totalMap['secretary']?.count || 0,
        lastMessageAt: totalMap['secretary']?.lastAt || null,
        details: {
          graphConnected: graphConfigured,
          garminConnected,
        },
      },
      {
        domain: 'triathlon',
        label: 'Triathlon',
        active: true,
        messagesToday: todayMap['triathlon'] || 0,
        totalMessages: totalMap['triathlon']?.count || 0,
        lastMessageAt: totalMap['triathlon']?.lastAt || null,
        details: {
          garminConnected,
        },
      },
      {
        domain: 'content',
        label: 'Content Creator',
        active: true,
        messagesToday: todayMap['content'] || 0,
        totalMessages: totalMap['content']?.count || 0,
        lastMessageAt: totalMap['content']?.lastAt || null,
        details: {
          activeAgents: activeAgentCount,
          activeSignals: totalSignals,
        },
      },
      {
        domain: 'finance',
        label: 'Finance Tracker',
        active: true,
        messagesToday: todayMap['finance'] || 0,
        totalMessages: totalMap['finance']?.count || 0,
        lastMessageAt: totalMap['finance']?.lastAt || null,
        details: {},
      },
      {
        domain: 'cooking',
        label: 'Cooking Chef',
        active: true,
        messagesToday: todayMap['cooking'] || 0,
        totalMessages: totalMap['cooking']?.count || 0,
        lastMessageAt: totalMap['cooking']?.lastAt || null,
        details: {},
      },
    ];
  } catch (err) {
    logger.warn({ err }, 'Portal: failed to query domain status');
  }

  // ── Training plan stats ──────────────────────────────────────────
  let trainingPlans: { activePlans: number; totalCompletedSessions: number; currentWeekAdherence: number; currentPlanName: string | null } | null = null;
  try {
    const { getPlanStats } = require('../services/training-plans');
    const userId = config.telegram.allowedUserIds[0];
    if (userId) {
      trainingPlans = getPlanStats(userId);
    }
  } catch { /* table may not exist yet */ }

  // ── Usage metering stats ──────────────────────────────────────────
  let usageMetering: SnapshotResponse['usageMetering'] = {
    today: { messageCount: 0, totalTokens: 0, apiCalls: 0, costUsd: 0 },
    byUser: [],
  };
  try {
    const { getGlobalDailyUsage, getDailyUsage } = require('../services/usage-metering');
    const global = getGlobalDailyUsage();
    usageMetering.today = {
      messageCount: global.messageCount,
      totalTokens: global.totalTokens,
      apiCalls: global.apiCalls,
      costUsd: global.costUsd,
    };
    // Per-user breakdown for allowed users
    for (const uid of config.telegram.allowedUserIds) {
      const u = getDailyUsage(uid);
      if (u.apiCalls > 0) {
        usageMetering.byUser.push({
          userId: uid,
          messageCount: u.messageCount,
          totalTokens: u.totalTokens,
          apiCalls: u.apiCalls,
          costUsd: u.costUsd,
        });
      }
    }
  } catch { /* table may not exist yet */ }

  // Read version from package.json
  let pkgVersion = 'unknown';
  try {
    const pkg = require('../../package.json');
    pkgVersion = pkg.version;
  } catch { /* fallback */ }

  return {
    version: pkgVersion,
    generatedAt: new Date().toISOString(),
    uptime: { seconds: uptimeSec, human: humanUptime(uptimeSec) },
    bot: {
      polling: isBotPollingActive(),
      restarting: isRestarting(),
      lastMessageAt: getLastMessageAt(),
    },
    integrations,
    jobs,
    jobHistory,
    nextRuns,
    apiUsage,
    recentEvents: getRecentEvents(),
    invoices,
    emailLog,
    healthSummary,
    calendarData: { days: calendarDays, jobs: calendarJobs },
    contentReferences,
    transcriptStats,
    domainStatus,
    skillStatus: getAllSkillStatuses(),
    trainingPlans,
    usageMetering,
    apiLatency: (() => {
      try {
        const { getLatencySummary } = require('../api/request-timer');
        return getLatencySummary();
      } catch { return []; }
    })(),
  };
}

function buildAdapterStatus(): SnapshotResponse['adapters'] {
  const polling = isBotPollingActive();
  const lastMsg = getLastMessageAt();

  // Determine Telegram status based on polling and recency of last message
  let telegramStatus: 'connected' | 'idle' | 'error' = 'error';
  if (polling) {
    if (lastMsg) {
      const ageMs = Date.now() - new Date(lastMsg).getTime();
      telegramStatus = ageMs < 3_600_000 ? 'connected' : 'idle';
    } else {
      telegramStatus = 'idle'; // polling but no messages yet
    }
  }

  return [
    {
      name: 'Telegram',
      status: telegramStatus,
      configured: true,
      lastMessageAt: lastMsg,
    },
    {
      name: 'WhatsApp',
      status: 'planned',
      configured: false,
      lastMessageAt: null,
    },
  ];
}

// ─── Quick Actions ──────────────────────────────────────────────────

async function handleAction(
  name: string,
  bot: Bot,
): Promise<{ ok: boolean; message: string }> {
  switch (name) {
    // 1. Refresh Garmin session
    case 'refresh-garmin': {
      if (!isGarminConfigured()) return { ok: false, message: 'Garmin not configured' };
      const ok = await garminKeepAlive();
      pushEvent({ ts: new Date().toISOString(), type: 'auth', summary: `Manual Garmin refresh: ${ok ? 'success' : 'failed'}` });
      return { ok, message: ok ? 'Garmin session refreshed' : 'Garmin refresh failed' };
    }

    // 2. Trigger morning briefing
    case 'trigger-briefing': {
      await sendDailyBriefing(bot);
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Manual morning briefing sent' });
      return { ok: true, message: 'Morning briefing sent to Telegram' };
    }

    // 3. Trigger coach report
    case 'trigger-coach': {
      if (!isGarminConfigured()) return { ok: false, message: 'Garmin not configured' };
      const result = await generateCoachBriefing();
      const chunks = splitMessage(result.message);
      for (const userId of config.telegram.allowedUserIds) {
        for (const chunk of chunks) {
          await bot.api.sendMessage(userId, chunk, { parse_mode: 'HTML' });
        }
      }
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Manual coach report sent' });
      return { ok: true, message: 'Coach report sent to Telegram' };
    }

    // 4. Trigger content discovery
    case 'trigger-content': {
      const discovery = await runContentDiscovery();
      let msg = `🎬 <b>Daily Content Ideas Ready</b>\n\n`;
      if (discovery.ideas.length > 0) {
        for (let i = 0; i < discovery.ideas.length; i++) {
          msg += `${i + 1}. ${escapeHtml(discovery.ideas[i])}\n`;
        }
      } else {
        msg += `Ideas generated but couldn't parse titles — check the file.\n`;
      }
      msg += `\n📁 <code>${escapeHtml(discovery.filePath)}</code>`;
      msg += `\n🔍 ${discovery.searchCount} web searches used`;
      for (const userId of config.telegram.allowedUserIds) {
        await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
      }
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Manual content discovery sent' });
      return { ok: true, message: `Content discovery complete — ${discovery.ideas.length} ideas` };
    }

    // 5. Clear conversation history
    case 'clear-history': {
      clearAllConversations(0); // Clears default/owner user's conversations
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Conversation history cleared' });
      return { ok: true, message: 'All conversation history cleared' };
    }

    // 6. Test SSH connection (invoice filing)
    case 'test-ssh': {
      if (!isInvoiceFilingConfigured()) return { ok: false, message: 'Invoice filing not configured' };
      const { execFileSync } = await import('child_process');
      const sshArgs = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
      if (config.invoices.sshKeyPath) sshArgs.push('-i', config.invoices.sshKeyPath);
      if (config.invoices.sshPort !== '22') sshArgs.push('-p', config.invoices.sshPort);
      sshArgs.push(`${config.invoices.sshUser}@${config.invoices.sshHost}`, 'echo ok');
      try {
        execFileSync('ssh', sshArgs, { timeout: 15_000, stdio: 'pipe' });
        pushEvent({ ts: new Date().toISOString(), type: 'auth', summary: 'SSH test: success' });
        return { ok: true, message: 'SSH connection successful' };
      } catch (err: any) {
        pushEvent({ ts: new Date().toISOString(), type: 'error', summary: `SSH test: failed — ${(err?.message ?? '').slice(0, 60)}` });
        return { ok: false, message: `SSH failed: ${err?.message ?? 'unknown error'}` };
      }
    }

    // 7. Test Microsoft Graph token
    case 'test-graph': {
      if (!isMicrosoftConfigured()) return { ok: false, message: 'Microsoft Graph not configured' };
      try {
        const { getGraphClient } = await import('../services/microsoft-auth');
        const me = await getGraphClient().api('/me').select('displayName').get();
        pushEvent({ ts: new Date().toISOString(), type: 'auth', summary: `Graph test: OK (${me.displayName})` });
        return { ok: true, message: `Graph token valid — signed in as ${me.displayName}` };
      } catch (err: any) {
        pushEvent({ ts: new Date().toISOString(), type: 'error', summary: `Graph test: failed — ${(err?.message ?? '').slice(0, 60)}` });
        return { ok: false, message: `Graph failed: ${err?.message ?? 'unknown error'}` };
      }
    }

    // 8. Restart bot polling (safe: stop → wait → start with retry)
    case 'restart-polling': {
      if (isRestarting()) return { ok: false, message: 'Already restarting — please wait' };
      const botRef = getBotRef();
      if (!botRef) return { ok: false, message: 'Bot reference not available' };

      // Run async restart in background — respond immediately
      setIsRestarting(true);
      setImmediate(async () => {
        try {
          logger.info('Portal: stopping bot polling for restart...');
          botRef.stop();
          setBotPollingActive(false);
          pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Bot polling stopped for restart' });

          // Wait for Telegram to release the polling lock
          await new Promise((r) => setTimeout(r, 5_000));

          // Retry loop (up to 3 attempts, 15s apart)
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              logger.info({ attempt }, 'Portal: restarting bot polling...');
              await botRef.start({
                onStart: () => {
                  logger.info('Portal: bot polling restarted successfully');
                  setBotPollingActive(true);
                  setIsRestarting(false); // Clear BEFORE start() blocks indefinitely
                  pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Bot polling restarted successfully' });
                },
              });
              break; // start() blocks while polling — only reaches here after stop()
            } catch (err: any) {
              const is409 = err?.error_code === 409 || err?.message?.includes('409');
              if (is409 && attempt < 3) {
                logger.warn({ attempt }, 'Portal restart: 409 conflict, retrying...');
                await new Promise((r) => setTimeout(r, 15_000));
                continue;
              }
              throw err;
            }
          }
        } catch (err) {
          logger.error({ err }, 'Portal: bot restart failed');
          pushEvent({ ts: new Date().toISOString(), type: 'error', summary: `Bot restart failed: ${(err as Error)?.message?.slice(0, 60)}` });
        } finally {
          setIsRestarting(false);
        }
      });

      return { ok: true, message: 'Bot restart initiated — polling will resume in ~5s' };
    }

    case 'resynthesize-knowledge': {
      await reSynthesizeKnowledge();
      pushEvent({ ts: new Date().toISOString(), type: 'job', summary: 'Manual knowledge re-synthesis' });
      return { ok: true, message: 'Content knowledge re-synthesized from all active channels' };
    }

    // ── Content Agent Mesh Actions ───────────────────────────────
    case 'run-performance-agent': {
      await runPerformanceAgent();
      return { ok: true, message: 'Performance Agent completed' };
    }
    case 'run-voice-evolution': {
      await runVoiceEvolutionAgent();
      return { ok: true, message: 'Voice Evolution Agent completed' };
    }
    case 'run-reaction-radar': {
      await runReactionRadar();
      return { ok: true, message: 'Reaction Radar completed' };
    }
    case 'run-seo-agent': {
      await runSEOAgent();
      return { ok: true, message: 'SEO Agent completed' };
    }
    case 'run-pipeline-agent': {
      await runPipelineAgent();
      return { ok: true, message: 'Pipeline Agent completed' };
    }

    default:
      return { ok: false, message: `Unknown action: ${name}` };
  }
}

// ─── Express App Factory ────────────────────────────────────────────

export function createPortalServer(bot: Bot): http.Server {
  const app = express();

  // ── Request logging + tracing middleware (audit QW-15 + Quarter) ───
  // Wraps every HTTP request in two layers:
  //   1. A request-context (Quarter: distributed tracing) so all log
  //      calls during the request automatically include reqId/src/userId.
  //      If the upstream sent us an X-Request-Id header, we honor it
  //      (this is what makes "follow a single request through the bot
  //      → portal → content-engine" possible). Otherwise we generate a
  //      fresh ID and echo it back in the response so the client can
  //      reference it in bug reports.
  //   2. A structured pino log on res.finish with method, path, status,
  //      duration, and userId. The reqId is added automatically by the
  //      logger mixin so we don't have to thread it manually.
  //
  // We hook res.on('finish') instead of wrapping res.end to keep the
  // middleware non-invasive. The auth middleware (further down the chain)
  // populates req.userId before res.send happens, so by the time finish
  // fires we can read it from the modified request object.
  //
  // Why not pino-http? pino-http is a separate package and the project's
  // CLAUDE.md says "no third-party HTTP libs". A 30-line bespoke middleware
  // does the same job here.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incomingId = req.header('x-request-id');
    const requestId = incomingId || generateRequestId();
    // Echo the ID back so the client can quote it in bug reports.
    res.setHeader('x-request-id', requestId);

    runWithContext({ requestId, source: 'http' }, () => {
      const start = process.hrtime.bigint();
      const path = req.path;
      res.on('finish', () => {
        const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
        const userId = (req as any).userId as number | undefined;
        const isHealthOrSnapshot = path === '/health' || path === '/api/snapshot';
        // Skip noisy health-check polling at info level — log them at debug
        // so they're visible if you crank up LOG_LEVEL but don't fill the
        // normal log stream. The portal dashboard polls /api/snapshot every
        // 5 seconds.
        const logLevel = isHealthOrSnapshot ? 'debug' : 'info';
        logger[logLevel](
          {
            method: req.method,
            path,
            status: res.statusCode,
            durationMs,
            userId,
            ip: req.ip || req.socket?.remoteAddress,
          },
          'http',
        );
      });
      next();
    });
  });

  // ── Webhook router (TASK-16b + Month 2: Telegram webhooks) ─────────
  // Mounted BEFORE express.json() because the Todoist webhook needs the
  // raw bytes for HMAC verification. The router uses its own scoped
  // express.raw() parser and JSON.parses the body manually after verifying.
  //
  // The Telegram webhook handler (mounted ONLY when config.telegram.webhookUrl
  // is set) uses its OWN scoped express.json() inside the route definition,
  // so it works fine even though the global express.json() runs later.
  // Passing `bot` here gives the router access to grammy's webhookCallback.
  try {
    const { createWebhookRouter } = require('../api/routes/webhooks');
    app.use('/webhooks', createWebhookRouter(bot));
  } catch (err) {
    logger.warn({ err }, 'Webhook router failed to mount (non-fatal)');
  }

  // ── Waitlist router (landing page public form) ─────────────────────
  // Mounted at root /waitlist so it bypasses the portal token auth on /api.
  // The router has its own scoped express.json() parser and rate limiter.
  try {
    const { createWaitlistRouter } = require('../api/routes/waitlist');
    app.use('/waitlist', createWaitlistRouter());
  } catch (err) {
    logger.warn({ err }, 'Waitlist router failed to mount (non-fatal)');
  }

  app.use(express.json());

  // ── AI provider routing (must initialize BEFORE any AI call) ─────────
  //
  // Two responsibilities:
  //   1. initDomainRouting() loads the feature flags (gemini routing on/off,
  //      include-secretary, per-domain set) from env + kv_store
  //   2. createRoutingProvider() instantiates the actual TaskRoutingProvider
  //      and stores it in the module-level _activeProvider singleton that
  //      domain-handler.ts looks up via getActiveProvider()
  //
  // Without #2, getActiveProvider() returns null and every domain call falls
  // through to the direct-Anthropic fallback path — which is what was
  // happening before this fix. The dashboard would show "0 Gemini calls" no
  // matter what the routing config said.
  //
  // This block runs unconditionally (NOT inside the iOS-gated block below)
  // because the Telegram bot also routes through the same AI providers and
  // needs the routing system regardless of whether iOS is enabled.
  try {
    const { initDomainRouting } = require('../services/domain-provider-router');
    initDomainRouting();
    const { createRoutingProvider, getActiveProvider } = require('../services/provider-registry');
    createRoutingProvider();
    const active = getActiveProvider();
    if (active) {
      const { getDomainProviderConfig } = require('../services/domain-provider-router');
      const cfg = getDomainProviderConfig();
      logger.info(
        {
          activeProvider: active.name || 'TaskRoutingProvider',
          domains: cfg.map((d: { domain: string; provider: string }) => `${d.domain}→${d.provider}`).join(', '),
        },
        '✅ AI provider routing active',
      );
    } else {
      logger.warn('createRoutingProvider() returned null — all AI calls will fall back to direct Anthropic');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to initialize AI provider routing — falling back to direct Anthropic on every call');
  }

  // ── iOS API (mounted first — separate JWT auth, not portal token) ────
  if (config.ios?.enabled) {
    // Initialize SQLite-backed cache store (survives restarts)
    try {
      const { initCacheStore, clearExpired } = require('../services/cache-store');
      initCacheStore();
      setInterval(clearExpired, 60 * 60 * 1000);
    } catch (err) {
      logger.error({ err }, 'Failed to initialize cache store');
    }

    const { createApiRouter } = require('../api/router');
    app.use('/api/v1', createApiRouter());
    logger.info('iOS API enabled on /api/v1');

    // Warm ALL caches on startup so first app open is instant
    try {
      const { warmTaskCache } = require('../api/routes/tasks');
      const { warmDashboardCache } = require('../api/routes/dashboard');
      const userId = config.telegram.allowedUserIds[0];

      // Stagger startup warming: dashboard first (slowest), then tasks
      setTimeout(() => warmDashboardCache(userId).catch(() => {}), 3000);
      setTimeout(() => warmTaskCache().catch(() => {}), 5000);

      // Periodic refresh: dashboard every 3 min, tasks every 2 min
      setInterval(() => warmDashboardCache(userId).catch(() => {}), 3 * 60 * 1000);
      setInterval(() => warmTaskCache().catch(() => {}), 2 * 60 * 1000);
    } catch (err) {
      logger.debug({ err }, 'Cache warming setup failed (non-critical)');
    }

    // Ensure ios_devices table exists
    try {
      const db = getDb();
      db.exec(`
        CREATE TABLE IF NOT EXISTS ios_devices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          device_id TEXT NOT NULL UNIQUE,
          device_name TEXT,
          push_token TEXT,
          refresh_token TEXT NOT NULL,
          last_active_at TEXT DEFAULT (datetime('now')),
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
    } catch (err) {
      logger.error({ err }, 'Failed to create ios_devices table');
    }
  }

  // ── Health check endpoint (no auth — for uptime monitors) ──────
  // ── OAuth Callback Routes (no auth — public redirect targets) ──────

  app.get('/oauth/google/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    if (!code || !state) {
      res.status(400).send('Missing code or state parameter');
      return;
    }
    try {
      const { exchangeCode } = require('../services/oauth-flow');
      const { storeTokens } = require('../services/oauth-store');
      const { isIOSState, parseIOSState, consumeNonce } = require('../api/routes/oauth-initiate');

      // Detect iOS-origin flow (state = "ios:{userId}:{nonce}")
      let userId: number;
      const isIOS = isIOSState(state);

      if (isIOS) {
        const parsed = parseIOSState(state);
        if (!parsed) { res.status(400).send('Invalid state'); return; }
        const nonceData = consumeNonce(parsed.nonce);
        if (!nonceData || nonceData.userId !== parsed.userId) {
          res.status(403).send('Invalid or expired nonce');
          return;
        }
        userId = parsed.userId;
      } else {
        userId = parseInt(state, 10);
      }

      const tokens = await exchangeCode('google', code, userId);
      storeTokens(userId, 'google', tokens);

      try {
        const { resetGoogleClients } = require('../services/google-auth');
        resetGoogleClients();
      } catch { /* non-critical */ }

      if (isIOS) {
        // iOS: redirect to custom URL scheme so ASWebAuthenticationSession catches it
        res.redirect(`me.nexushub.app://oauth/google?status=success`);
      } else {
        // Telegram portal: notify user + show HTML
        try {
          const { getUserLanguage } = require('../services/user-service');
          const { t } = require('../utils/i18n');
          const lang = getUserLanguage(userId);
          const botRef = getBotRef();
          if (botRef) {
            await botRef.api.sendMessage(userId, t('oauth_connected', lang, { provider: 'Google' }));
          }
        } catch { /* notification is best-effort */ }
        res.send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>✅ Connected!</h1><p>Google account linked. You can close this window and return to Telegram.</p></body></html>');
      }
    } catch (err) {
      logger.error({ err }, 'Google OAuth callback failed');
      if (state.startsWith('ios:')) {
        res.redirect(`me.nexushub.app://oauth/google?status=error&message=${encodeURIComponent('Connection failed')}`);
      } else {
        res.status(500).send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>❌ Connection Failed</h1><p>Please try again with /connect google in Telegram.</p></body></html>');
      }
    }
  });

  app.get('/oauth/outlook/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    if (!code || !state) {
      res.status(400).send('Missing code or state parameter');
      return;
    }
    try {
      const { exchangeCode } = require('../services/oauth-flow');
      const { storeTokens } = require('../services/oauth-store');
      const { isIOSState, parseIOSState, consumeNonce } = require('../api/routes/oauth-initiate');

      let userId: number;
      const isIOS = isIOSState(state);

      if (isIOS) {
        const parsed = parseIOSState(state);
        if (!parsed) { res.status(400).send('Invalid state'); return; }
        const nonceData = consumeNonce(parsed.nonce);
        if (!nonceData || nonceData.userId !== parsed.userId) {
          res.status(403).send('Invalid or expired nonce');
          return;
        }
        userId = parsed.userId;
      } else {
        userId = parseInt(state, 10);
      }

      const tokens = await exchangeCode('outlook', code, userId);
      storeTokens(userId, 'outlook', tokens);

      try {
        const { resetMicrosoftClients } = require('../services/microsoft-auth');
        resetMicrosoftClients();
      } catch { /* non-critical */ }

      if (isIOS) {
        res.redirect(`me.nexushub.app://oauth/outlook?status=success`);
      } else {
        try {
          const { getUserLanguage } = require('../services/user-service');
          const { t } = require('../utils/i18n');
          const lang = getUserLanguage(userId);
          const botRef = getBotRef();
          if (botRef) {
            await botRef.api.sendMessage(userId, t('oauth_connected', lang, { provider: 'Outlook' }));
          }
        } catch { /* notification is best-effort */ }
        res.send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>✅ Connected!</h1><p>Outlook account linked. You can close this window and return to Telegram.</p></body></html>');
      }
    } catch (err) {
      logger.error({ err }, 'Outlook OAuth callback failed');
      if (state.startsWith('ios:')) {
        res.redirect(`me.nexushub.app://oauth/outlook?status=error&message=${encodeURIComponent('Connection failed')}`);
      } else {
        res.status(500).send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>❌ Connection Failed</h1><p>Please try again with /connect outlook in Telegram.</p></body></html>');
      }
    }
  });

  // ── Strava OAuth Callback ──────────────────────────────────────────

  app.get('/oauth/strava/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    if (!code || !state) {
      res.status(400).send('Missing code or state parameter');
      return;
    }
    try {
      const { exchangeCode } = require('../services/oauth-flow');
      const { storeTokens } = require('../services/oauth-store');
      const { getUserLanguage } = require('../services/user-service');
      const { t } = require('../utils/i18n');
      const userId = parseInt(state, 10);
      const tokens = await exchangeCode('strava', code, userId);
      storeTokens(userId, 'strava', tokens);

      try {
        const lang = getUserLanguage(userId);
        const botRef = getBotRef();
        if (botRef) {
          await botRef.api.sendMessage(userId, t('oauth_connected', lang, { provider: 'Strava' }));
        }
      } catch { /* notification is best-effort */ }

      res.send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>✅ Connected!</h1><p>Strava account linked. You can close this window and return to Telegram.</p></body></html>');
    } catch (err) {
      logger.error({ err }, 'Strava OAuth callback failed');
      res.status(500).send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>❌ Connection Failed</h1><p>Please try again with /connect strava in Telegram.</p></body></html>');
    }
  });

  // ── Whoop OAuth Callback ───────────────────────────────────────────

  app.get('/oauth/whoop/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    if (!code || !state) {
      res.status(400).send('Missing code or state parameter');
      return;
    }
    try {
      const { exchangeCode } = require('../services/oauth-flow');
      const { storeTokens } = require('../services/oauth-store');
      const { getUserLanguage } = require('../services/user-service');
      const { t } = require('../utils/i18n');
      const userId = parseInt(state, 10);
      const tokens = await exchangeCode('whoop', code, userId);
      storeTokens(userId, 'whoop', tokens);

      try {
        const lang = getUserLanguage(userId);
        const botRef = getBotRef();
        if (botRef) {
          await botRef.api.sendMessage(userId, t('oauth_connected', lang, { provider: 'Whoop' }));
        }
      } catch { /* notification is best-effort */ }

      res.send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>✅ Connected!</h1><p>Whoop account linked. You can close this window and return to Telegram.</p></body></html>');
    } catch (err) {
      logger.error({ err }, 'Whoop OAuth callback failed');
      res.status(500).send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>❌ Connection Failed</h1><p>Please try again with /connect whoop in Telegram.</p></body></html>');
    }
  });

  // ── Fitbit OAuth Callback ──────────────────────────────────────────

  app.get('/oauth/fitbit/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    if (!code || !state) {
      res.status(400).send('Missing code or state parameter');
      return;
    }
    try {
      const { exchangeCode } = require('../services/oauth-flow');
      const { storeTokens } = require('../services/oauth-store');
      const { getUserLanguage } = require('../services/user-service');
      const { t } = require('../utils/i18n');
      const userId = parseInt(state, 10);
      const tokens = await exchangeCode('fitbit', code, userId);
      storeTokens(userId, 'fitbit', tokens);

      try {
        const lang = getUserLanguage(userId);
        const botRef = getBotRef();
        if (botRef) {
          await botRef.api.sendMessage(userId, t('oauth_connected', lang, { provider: 'Fitbit' }));
        }
      } catch { /* notification is best-effort */ }

      res.send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>✅ Connected!</h1><p>Fitbit account linked. You can close this window and return to Telegram.</p></body></html>');
    } catch (err) {
      logger.error({ err }, 'Fitbit OAuth callback failed');
      res.status(500).send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>❌ Connection Failed</h1><p>Please try again with /connect fitbit in Telegram.</p></body></html>');
    }
  });

  // ── Todoist OAuth Callback (TASK-16b) ──────────────────────────────

  app.get('/oauth/todoist/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    if (!code || !state) {
      res.status(400).send('Missing code or state parameter');
      return;
    }
    try {
      const { exchangeCode } = require('../services/oauth-flow');
      const { storeTokens } = require('../services/oauth-store');
      const { getUserLanguage } = require('../services/user-service');
      const { t } = require('../utils/i18n');
      const userId = parseInt(state, 10);
      const tokens = await exchangeCode('todoist', code, userId);
      storeTokens(userId, 'todoist', tokens);

      // Trigger an immediate first sync so the user sees their tasks instantly,
      // not after waiting up to 15 minutes for the cron tick. Detached so the
      // OAuth callback HTML response goes out without waiting for the sync.
      try {
        const { syncProvider } = require('../services/task-store/sync-engine');
        syncProvider(userId, 'todoist').catch((err: any) =>
          logger.warn({ err, userId }, 'Initial Todoist sync failed (non-fatal)'),
        );
      } catch { /* sync engine optional */ }

      try {
        const lang = getUserLanguage(userId);
        const botRef = getBotRef();
        if (botRef) {
          await botRef.api.sendMessage(userId, t('oauth_connected', lang, { provider: 'Todoist' }));
        }
      } catch { /* notification is best-effort */ }

      res.send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>✅ Connected!</h1><p>Todoist account linked. Your first sync is starting now — return to Telegram.</p></body></html>');
    } catch (err) {
      logger.error({ err }, 'Todoist OAuth callback failed');
      res.status(500).send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>❌ Connection Failed</h1><p>Please try again with /connect todoist in Telegram.</p></body></html>');
    }
  });

  // ── Notion OAuth Callback (TASK-16b) ───────────────────────────────

  app.get('/oauth/notion/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    if (!code || !state) {
      res.status(400).send('Missing code or state parameter');
      return;
    }
    try {
      const { exchangeCode } = require('../services/oauth-flow');
      const { storeTokens } = require('../services/oauth-store');
      const { getUserLanguage } = require('../services/user-service');
      const { t } = require('../utils/i18n');
      const userId = parseInt(state, 10);
      const tokens = await exchangeCode('notion', code, userId);
      storeTokens(userId, 'notion', tokens);

      // Notion needs a per-database mapping setup before sync works. We don't
      // trigger a sync here — the user must run the database mapping flow
      // first (see /connect command for the prompt). The bot's followup
      // message tells them what to do next.
      try {
        const lang = getUserLanguage(userId);
        const botRef = getBotRef();
        if (botRef) {
          await botRef.api.sendMessage(userId, t('oauth_connected', lang, { provider: 'Notion' }));
          await botRef.api.sendMessage(
            userId,
            '📋 <b>Next step:</b> Send me the URL of the Notion database you want to sync as your task list.\n\n' +
            'Example: <code>https://notion.so/workspace/Tasks-abc123def456</code>',
            { parse_mode: 'HTML' },
          );
        }
      } catch { /* notification is best-effort */ }

      res.send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>✅ Connected!</h1><p>Notion account linked. Return to Telegram and send your database URL to finish setup.</p></body></html>');
    } catch (err) {
      logger.error({ err }, 'Notion OAuth callback failed');
      res.status(500).send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>❌ Connection Failed</h1><p>Please try again with /connect notion in Telegram.</p></body></html>');
    }
  });

  // ── Health Check ──────────────────────────────────────────────────

  app.get('/health', (_req: Request, res: Response) => {
    const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
    let dbOk = false;
    try {
      const d = getDb();
      const row = d.prepare('SELECT 1 as ok').get() as any;
      dbOk = row?.ok === 1;
    } catch { /* db not ready */ }

    const mem = process.memoryUsage();
    const status = isBotPollingActive() && dbOk ? 'healthy' : 'degraded';

    res.status(status === 'healthy' ? 200 : 503).json({
      status,
      uptime: uptimeSec,
      uptimeHuman: humanUptime(uptimeSec),
      bot: {
        polling: isBotPollingActive(),
        restarting: isRestarting(),
        lastMessageAt: getLastMessageAt(),
      },
      database: dbOk ? 'connected' : 'disconnected',
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        external: Math.round(mem.external / 1024 / 1024),
      },
      timestamp: new Date().toISOString(),
    });
  });

  // ── Detailed health check (auth-protected via Authorization header) ──
  app.get('/health/detailed', (req: Request, res: Response) => {
    const healthToken = config.health.token;
    const auth = req.headers.authorization;
    if (healthToken && (!auth || auth !== `Bearer ${healthToken}`)) {
      res.status(401).json({ error: 'Unauthorized — provide Authorization: Bearer <HEALTH_TOKEN>' });
      return;
    }

    const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);

    // Database check
    let dbOk = false;
    try {
      const d = getDb();
      const row = d.prepare('SELECT 1 as ok').get() as any;
      dbOk = row?.ok === 1;
    } catch { /* db not ready */ }

    // Memory
    const mem = process.memoryUsage();

    // Cron job statuses
    const jobs = getJobStatuses().map(j => ({
      name: j.name,
      label: j.label,
      cronExpression: j.cronExpression,
      domain: j.domain,
      lastRunAt: j.lastRunAt,
      lastResult: j.lastResult,
      lastDurationMs: j.lastDurationMs,
      lastError: j.lastError,
    }));

    // Error count from recent events (in-memory ring buffer)
    const recentEvents = getRecentEvents();
    const errorCount = recentEvents.filter(e => e.type === 'error').length;
    const errorsLast1h = recentEvents.filter(e => {
      if (e.type !== 'error') return false;
      const ageMs = Date.now() - new Date(e.ts).getTime();
      return ageMs < 3_600_000;
    }).length;

    // Integration health (lightweight version of buildSnapshot integrations)
    let integrationHealth: { name: string; status: string; configured: boolean; tokenHealth: string }[] = [];
    try {
      const snap = buildSnapshot();
      integrationHealth = snap.integrations.map(i => ({
        name: i.name,
        status: i.status ?? 'unknown',
        configured: i.configured,
        tokenHealth: i.tokenHealth ?? 'unknown',
      }));
    } catch { /* snapshot build may fail during startup */ }

    // Provider circuit breaker + metrics
    let providerHealth: Record<string, unknown> = {};
    try {
      const { getActiveProvider } = require('../services/provider-registry');
      const activeProvider = getActiveProvider();
      if (activeProvider) {
        providerHealth = activeProvider.getProviderHealth();
      }
    } catch { /* provider not initialized yet */ }

    const status = isBotPollingActive() && dbOk ? 'healthy' : 'degraded';

    res.status(status === 'healthy' ? 200 : 503).json({
      status,
      uptime: uptimeSec,
      uptimeHuman: humanUptime(uptimeSec),
      bot: {
        polling: isBotPollingActive(),
        restarting: isRestarting(),
        lastMessageAt: getLastMessageAt(),
      },
      database: dbOk ? 'connected' : 'disconnected',
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        external: Math.round(mem.external / 1024 / 1024),
      },
      crons: jobs,
      integrations: integrationHealth,
      providers: providerHealth,
      errors: {
        total: errorCount,
        lastHour: errorsLast1h,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // ── Auth middleware for /api/* ──────────────────────────────────
  const portalToken = config.portal.token;

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    // Skip portal auth for iOS API routes — they use their own JWT middleware
    if (req.path.startsWith('/v1/') || req.path.startsWith('/v1')) {
      return next();
    }
    if (!portalToken) {
      // No token configured — only allow from localhost/private IPs.
      // Blocks access from tunnels (ngrok, cloudflared) and public networks.
      const ip = req.ip || req.socket.remoteAddress || '';
      const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.');
      if (isLocal) return next();
      // Not localhost + no token = reject
      res.status(401).json({ error: 'PORTAL_TOKEN not set. Set it in .env for non-local access.' });
      return;
    }
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${portalToken}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  // ── GET / — serve the admin dashboard ────────────────────────
  //
  // The backend's root URL belongs to the admin portal. Two reasons:
  //   1. The PUBLIC marketing landing lives on Cloudflare Pages
  //      (nexushub.me CNAME → nexushub-landing.pages.dev), served from
  //      the edge CDN — it never even hits this backend.
  //   2. The only humans hitting this backend's root are the admin
  //      (Felipe) via Tailscale on serverdominguez:8200 or via the
  //      Cloudflare Tunnel at api.nexushub.me. Both want admin tools.
  //
  // The /admin path is preserved as a backwards-compatible alias.
  // For previewing landing.html locally during development, use
  // /landing-preview (defined below).

  // ── GET /landing-preview — serve landing.html for local development ──
  //
  // Use this to preview landing.html changes before deploying to
  // Cloudflare Pages via `wrangler pages deploy`. The actual public
  // landing is served from Cloudflare Pages, NOT this route.
  app.get('/landing-preview', (_req: Request, res: Response) => {
    const landingPath = path.join(__dirname, 'landing.html');
    if (fs.existsSync(landingPath)) {
      // No edge caching on the preview — devs always want the latest
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.type('html').send(fs.readFileSync(landingPath, 'utf-8'));
      return;
    }
    res.status(503).send('Landing preview not found — run `npm run build` to copy landing.html into dist/');
  });

  // ── GET /admin — serve the admin dashboard HTML ───────────────
  //
  // New canonical location for the ops dashboard. Unauthenticated requests
  // still load the HTML (which is useless without the portal token), then
  // the inline JS reads the token from localStorage / URL param / injected
  // server string. All /api/* calls from the dashboard go through the
  // portal-token middleware above.
  const serveAdminDashboard = (_req: Request, res: Response): void => {
    const htmlPath = path.join(__dirname, 'portal.html');
    if (!fs.existsSync(htmlPath)) {
      res.status(503).send('Dashboard not found — portal.html is missing');
      return;
    }
    // Security headers
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'");

    // NEVER inject the portal token into HTML — users must authenticate
    // via a prompt or localStorage (set manually by the admin).
    // Removes: URL param token, hardcoded injection, XSS→admin escalation.
    const html = fs.readFileSync(htmlPath, 'utf-8');
    res.type('html').send(html);
  };
  // Root and the legacy /portal alias both serve the admin dashboard.
  // /admin is the canonical name; / is the convenience root for
  // serverdominguez:8200 / api.nexushub.me where Felipe lives.
  app.get('/', serveAdminDashboard);
  app.get('/admin', serveAdminDashboard);
  app.get('/portal', serveAdminDashboard);

  // ── GET /api/snapshot — full dashboard payload ─────────────────
  app.get('/api/snapshot', (_req: Request, res: Response) => {
    try {
      const now = Date.now();
      if (cachedSnapshot && now - cachedSnapshot.at < CACHE_TTL_MS) {
        res.json(cachedSnapshot.data);
        return;
      }
      const data = buildSnapshot();
      cachedSnapshot = { data, at: now };
      res.json(data);
    } catch (err) {
      logger.error({ err }, 'Portal: snapshot failed');
      res.status(500).json({ error: 'Failed to build snapshot' });
    }
  });

  // ── GET /api/usage/summary — KPIs for the redesigned admin dashboard ──
  // Aggregates "active users" and "cost / messages / tokens" for today, this
  // week, and this month in a single query. Used by the Dashboard section's
  // KPI strip — kept separate from /api/snapshot so it can be polled at a
  // higher frequency without rebuilding the entire snapshot.
  app.get('/api/usage/summary', (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const safeGet = (sql: string): any => {
        try { return db.prepare(sql).get(); }
        catch { return null; }
      };

      // Active users / cost / messages / tokens — three windows.
      const today = safeGet(`
        SELECT
          COUNT(DISTINCT user_id) as activeUsers,
          COUNT(*) as messages,
          COALESCE(SUM(cost_usd), 0) as cost,
          COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
        FROM api_usage
        WHERE ts >= date('now')
      `) || { activeUsers: 0, messages: 0, cost: 0, tokens: 0 };

      const week = safeGet(`
        SELECT
          COUNT(DISTINCT user_id) as activeUsers,
          COUNT(*) as messages,
          COALESCE(SUM(cost_usd), 0) as cost,
          COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
        FROM api_usage
        WHERE ts >= date('now', '-7 days')
      `) || { activeUsers: 0, messages: 0, cost: 0, tokens: 0 };

      const month = safeGet(`
        SELECT
          COUNT(DISTINCT user_id) as activeUsers,
          COUNT(*) as messages,
          COALESCE(SUM(cost_usd), 0) as cost,
          COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
        FROM api_usage
        WHERE ts >= date('now', '-30 days')
      `) || { activeUsers: 0, messages: 0, cost: 0, tokens: 0 };

      // 7-day cost sparkline (one number per day, oldest first).
      const sparkline: number[] = [];
      try {
        const rows = db.prepare(`
          SELECT date(ts) as day, COALESCE(SUM(cost_usd), 0) as cost
          FROM api_usage
          WHERE ts >= date('now', '-7 days')
          GROUP BY day
          ORDER BY day ASC
        `).all() as Array<{ day: string; cost: number }>;
        // Pad to 7 days even if some are missing.
        const byDay = new Map(rows.map((r) => [r.day, r.cost]));
        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const key = d.toISOString().slice(0, 10);
          sparkline.push(byDay.get(key) ?? 0);
        }
      } catch { /* api_usage may not have data yet */ }

      // Total registered users (independent of usage window).
      let totalUsers = 0;
      try {
        const row = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number } | undefined;
        totalUsers = row?.c ?? 0;
      } catch { /* users table may not exist in dev */ }

      res.json({
        ok: true,
        totalUsers,
        today,
        week,
        month,
        sparkline,
      });
    } catch (err) {
      logger.error({ err }, 'Portal: usage/summary failed');
      res.status(500).json({ ok: false, error: 'Failed to build usage summary' });
    }
  });

  // ── GET /api/skills — all skill statuses with sub-skill toggles ──
  app.get('/api/skills', (_req: Request, res: Response) => {
    try {
      res.json(getAllSkillStatuses());
    } catch (err) {
      logger.error({ err }, 'Portal: skills status failed');
      res.status(500).json({ error: 'Failed to get skill statuses' });
    }
  });

  // ── POST /api/skills/toggle — toggle a sub-skill on/off ──────
  app.post('/api/skills/toggle', (req: Request, res: Response) => {
    const { domain, subSkill, enabled } = req.body;
    if (!domain || !subSkill || typeof enabled !== 'boolean') {
      res.status(400).json({ ok: false, message: 'Required: domain, subSkill, enabled (boolean)' });
      return;
    }
    try {
      const result = enabled
        ? enableSubSkill(domain as DomainName, subSkill)
        : disableSubSkill(domain as DomainName, subSkill);
      // Invalidate snapshot cache so next fetch reflects the toggle
      cachedSnapshot = null;
      res.json({ ok: result, domain, subSkill, enabled });
    } catch (err) {
      logger.error({ err }, 'Portal: skill toggle failed');
      res.status(500).json({ ok: false, message: 'Toggle failed' });
    }
  });

  // ── POST /api/channels — add a reference channel ───────────
  app.post('/api/channels', async (req: Request, res: Response) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.includes('youtube.com')) {
      res.status(400).json({ ok: false, message: 'Invalid YouTube URL' });
      return;
    }
    try {
      const result = await addAndAnalyzeChannel(url, 'portal');
      cachedSnapshot = null;
      res.json({
        ok: result.analysis.success,
        channel: {
          id: result.channel.id,
          name: result.channel.channel_name,
          url: result.channel.channel_url,
          status: result.channel.status,
        },
        analysis: {
          summary: result.analysis.summary,
          patternsFound: result.analysis.patternsFound,
          videosAnalyzed: result.analysis.videosAnalyzed,
          error: result.analysis.error,
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // ── DELETE /api/channels/:id — remove a reference channel ──
  app.delete('/api/channels/:id', async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ ok: false, message: 'Invalid channel ID' });
      return;
    }
    try {
      removeRefChannel(id);
      await reSynthesizeKnowledge();
      cachedSnapshot = null;
      res.json({ ok: true, message: 'Channel removed and knowledge re-synthesized' });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // ── POST /api/action/:name — quick actions ─────────────────────
  app.post('/api/action/:name', async (req: Request, res: Response) => {
    const name = String(req.params.name);

    if (!VALID_ACTIONS.has(name)) {
      res.status(400).json({ ok: false, message: `Unknown action: ${name}` });
      return;
    }

    if (isRateLimited(name)) {
      res.status(429).json({ ok: false, message: 'Too many requests — wait 30s' });
      return;
    }

    try {
      const result = await handleAction(name, bot);
      recordAction(name);
      // Invalidate snapshot cache so next poll reflects the change
      cachedSnapshot = null;

      // Audit P0-10: every admin action is a privileged operation (refresh
      // tokens, trigger jobs, mutate state). Logged with the owner user as
      // both subject and actor since the portal token holder is the owner.
      try {
        const { logAudit } = require('../services/audit-trail');
        const ownerId = config.telegram.allowedUserIds[0] ?? 0;
        logAudit({
          userId: ownerId,
          actorId: ownerId,
          action: 'access',
          resource: `portal.action.${name}`,
          ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
        });
      } catch { /* audit-trail not available — non-critical */ }

      res.json(result);
    } catch (err) {
      logger.error({ err, action: name }, 'Portal: action failed');
      res.status(500).json({ ok: false, message: `Action failed: ${(err as Error)?.message ?? 'unknown'}` });
    }
  });

  // ── Mission Control API ──────────────────────────────────────────

  // GET /api/agents — all agent states
  app.get('/api/agents', (_req: Request, res: Response) => {
    try {
      const stats = getAgentStats();
      res.json({ ok: true, agents: stats });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/signals — active intelligence bus signals
  app.get('/api/signals', (req: Request, res: Response) => {
    try {
      const limit = parseInt(String(req.query.limit) || '50', 10);
      const typeFilter = req.query.type ? String(req.query.type) : undefined;
      let signals = getSignalLog(Math.min(limit, 200));
      if (typeFilter) {
        signals = signals.filter(s => s.signal_type === typeFilter);
      }
      res.json({ ok: true, signals, activeCount: getActiveSignalCount() });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // POST /api/signals/:id/dismiss — dismiss a signal
  app.post('/api/signals/:id/dismiss', (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) { res.status(400).json({ ok: false, message: 'Invalid ID' }); return; }
      dismissSignal(id);
      cachedSnapshot = null;
      res.json({ ok: true, message: 'Signal dismissed' });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/pipeline — pipeline status
  app.get('/api/pipeline', (_req: Request, res: Response) => {
    try {
      const stats = getPipelineStats();
      res.json({ ok: true, ...stats });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/pipeline/metrics — operational pipeline metrics
  //
  // Conversion rates, stage velocity, stale inventory, format distribution,
  // weekly throughput. Powers the portal Pipeline Health dashboard card.
  app.get('/api/pipeline/metrics', (_req: Request, res: Response) => {
    try {
      const { getPipelineOperationalMetrics } = require('../agents/pipeline-agent');
      const metrics = getPipelineOperationalMetrics();
      res.json({ ok: true, ...metrics });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/signals/ranked — ranked signals for portal signal inspector
  //
  // Returns signals ordered by relevanceScore (confidence × freshness × priority).
  // Query params: ?types=hook_effectiveness,pillar_performance&pillar=tech&limit=20
  app.get('/api/signals/ranked', (_req: Request, res: Response) => {
    try {
      const { readRankedSignals } = require('../services/intelligence-bus');
      const types = ((_req.query.types as string) || '').split(',').filter(Boolean);
      if (types.length === 0) {
        // Default: all content-intelligence signal types
        types.push(
          'hook_effectiveness', 'pillar_performance', 'retention_pattern',
          'voice_pattern', 'content_formula', 'keyword_opportunity',
        );
      }
      const ranked = readRankedSignals('portal-inspector', types, {
        limit: parseInt(String(_req.query.limit || '20'), 10),
        pillar: (_req.query.pillar as string) || undefined,
        format: (_req.query.format as string) || undefined,
        minConfidence: parseFloat(String(_req.query.minConfidence || '0.1')),
      });
      res.json({
        ok: true,
        count: ranked.length,
        signals: ranked.map((s: any) => ({
          id: s.id,
          type: s.signal_type,
          source: s.source_agent,
          confidence: s.confidence,
          relevanceScore: s.relevanceScore,
          ageHours: s.ageHours,
          priority: s.priority,
          pillar: s.pillar_tag,
          format: s.format_tag,
          evidenceCount: s.evidence_count,
          payload: s.payload,
          createdAt: s.created_at,
        })),
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/notifications — admin view of all content notifications
  app.get('/api/notifications', (_req: Request, res: Response) => {
    try {
      const { getAllNotifications } = require('../services/content-notification-store');
      const limit = parseInt(String(_req.query.limit || '100'), 10);
      const notifications = getAllNotifications(limit);
      res.json({
        ok: true,
        count: notifications.length,
        notifications: notifications.map((n: any) => ({
          id: n.id,
          userId: n.userId,
          type: n.type,
          title: n.title,
          body: n.body,
          status: n.status,
          pushSent: n.pushSent,
          createdAt: n.createdAt,
        })),
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/reports — admin view of all durable report documents
  app.get('/api/reports', (_req: Request, res: Response) => {
    try {
      const { getAllReports } = require('../services/report-document-store');
      const limit = parseInt(String(_req.query.limit || '50'), 10);
      const reports = getAllReports(limit);
      res.json({
        ok: true,
        count: reports.length,
        reports: reports.map((r: any) => ({
          id: r.id,
          userId: r.userId,
          type: r.type,
          title: r.title,
          summary: r.summary,
          status: r.status,
          sourceJob: r.sourceJob,
          createdAt: r.createdAt,
        })),
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // POST /api/books — add and extract a book
  app.post('/api/books', async (req: Request, res: Response) => {
    try {
      const { title, author } = req.body || {};
      if (!title || !author) {
        res.status(400).json({ ok: false, message: 'title and author are required' });
        return;
      }
      const { handleAddBookFromPortal } = await import('../commands/books');
      const result = await handleAddBookFromPortal(title, author);
      cachedSnapshot = null;
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/content-knowledge — voice DNA (canonical service)
  app.get('/api/content-knowledge', (_req: Request, res: Response) => {
    try {
      const { getVoiceDna } = require('../services/content-dashboard-service');
      const voiceDna = getVoiceDna();
      res.json({
        ok: true,
        knowledge: voiceDna.map((k: any) => ({
          category: k.category,
          label: k.label,
          text: k.text,
          sources: k.sources,
          updatedAt: k.updatedAt,
        })),
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/books — book library (canonical service)
  app.get('/api/books', (_req: Request, res: Response) => {
    try {
      const { getBooks } = require('../services/content-dashboard-service');
      const books = getBooks(50);
      res.json({ ok: true, ...books });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // POST /api/override/sprint — toggle content sprint mode (canonical service)
  app.post('/api/override/sprint', (_req: Request, res: Response) => {
    try {
      const { toggleSprintMode } = require('../services/content-dashboard-service');
      const result = toggleSprintMode();
      cachedSnapshot = null;
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // ── Error Monitoring API ──────────────────────────────────────────

  // GET /api/errors — error trends and recent errors
  app.get('/api/errors', (_req: Request, res: Response) => {
    try {
      const trends = getErrorTrends();
      res.json({ ok: true, ...trends });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/error-distribution — categorized agent error breakdown
  app.get('/api/error-distribution', (_req: Request, res: Response) => {
    try {
      const { getErrorDistribution } = require('../services/error-categorizer');
      const distribution = getErrorDistribution(7);
      res.json({ ok: true, distribution });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/provider-health — circuit breaker states + metrics
  app.get('/api/provider-health', (_req: Request, res: Response) => {
    try {
      const { getActiveProvider } = require('../services/provider-registry');
      const active = getActiveProvider();
      res.json({ providers: active ? active.getProviderHealth() : {} });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/domain-routing — domain→provider mapping for portal display
  //
  // Returns the live routing state: which provider is currently selected for
  // each domain, the fallback, the default (what the code would say if no
  // overrides), the include-secretary flag, and the active model name. The
  // portal's Domain Routing card calls this on load and after every toggle.
  app.get('/api/domain-routing', (_req: Request, res: Response) => {
    try {
      const {
        getDomainProviderConfig,
        isGeminiRoutingEnabled,
        isGeminiIncludeSecretaryEnabled,
      } = require('../services/domain-provider-router');
      const { getEffectiveDomainModel } = require('../services/model-config');
      const { isGeminiProviderConfigured } = require('../services/gemini-provider');
      const domains = getDomainProviderConfig();
      // Enrich each row with the actual model name the provider would use
      const enriched = domains.map((d: { domain: string; provider: string }) => ({
        ...d,
        model: (() => {
          try { return getEffectiveDomainModel?.(d.provider, d.domain) || 'default'; }
          catch { return 'default'; }
        })(),
      }));
      res.json({
        domains: enriched,
        geminiRoutingEnabled: isGeminiRoutingEnabled(),
        geminiIncludeSecretary: isGeminiIncludeSecretaryEnabled(),
        geminiConfigured: (() => { try { return isGeminiProviderConfigured(); } catch { return false; } })(),
      });
    } catch (err) {
      res.json({
        domains: [],
        geminiRoutingEnabled: false,
        geminiIncludeSecretary: false,
        geminiConfigured: false,
      });
    }
  });

  // POST /api/domain-routing/toggle — toggle Gemini routing at runtime
  //
  // Body accepts any subset of:
  //   { enabled: boolean }                — master Gemini routing on/off
  //   { includeSecretary: boolean }        — also route secretary through Gemini
  //   { domains: string[] }                — narrow the per-domain set
  //
  // After mutating any flag, clears the TaskRoutingProvider's cached
  // domain→pair map so the next request picks up the new config without a
  // pm2 restart.
  app.post('/api/domain-routing/toggle', express.json(), (req: Request, res: Response) => {
    try {
      const { enabled, includeSecretary, domains: geminiDomains } = req.body;
      const VALID_DOMAINS = new Set(['secretary', 'triathlon', 'content', 'finance', 'cooking']);
      const router = require('../services/domain-provider-router');

      if (typeof enabled === 'boolean') {
        router.setGeminiRoutingEnabled(enabled);
      }
      if (typeof includeSecretary === 'boolean') {
        router.setGeminiIncludeSecretary(includeSecretary);
      }
      if (Array.isArray(geminiDomains)) {
        // Validate: only accept known domain names
        const validated = geminiDomains.filter((d: unknown) => typeof d === 'string' && VALID_DOMAINS.has(d));
        router.setGeminiDomains(validated);
      }

      // Always clear the cached provider pairs so any flag change takes effect immediately
      try {
        const { getActiveProvider } = require('../services/provider-registry');
        const active = getActiveProvider();
        if (active && typeof (active as { clearDomainPairCache?: () => void }).clearDomainPairCache === 'function') {
          (active as { clearDomainPairCache: () => void }).clearDomainPairCache();
        }
      } catch {}

      res.json({
        ok: true,
        config: router.getDomainProviderConfig(),
        geminiRoutingEnabled: router.isGeminiRoutingEnabled(),
        geminiIncludeSecretary: router.isGeminiIncludeSecretaryEnabled(),
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/spend-by-provider — per-provider daily cost breakdown
  app.get('/api/spend-by-provider', (_req: Request, res: Response) => {
    try {
      const { getSpendByProvider } = require('../services/cost-guardrail');
      res.json(getSpendByProvider());
    } catch {
      res.json({ anthropic: 0, openai: 0, gemini: 0 });
    }
  });

  // GET /api/secretary-metrics — TASK-17 4-layer optimization stats
  //
  // Returns a snapshot of the in-memory metrics from secretary-fastpath.ts
  // (Layer 1) plus a count of registered fastpath patterns. The portal's
  // Secretary Optimization card polls this on the same 30s timer as the
  // rest of the AI section. Counters reset on pm2 restart — this is
  // operational telemetry, not a billing record.
  //
  // Hit-rate interpretation guide:
  //   - >50% : excellent — most secretary traffic is zero-token
  //   - 30-50%: healthy — patterns covering common queries
  //   - <30% : pattern dictionary likely missing common phrasings;
  //            consider adding patterns for whatever the AI is handling
  //            most often (check the cost-by-skill table for hints)
  app.get('/api/secretary-metrics', (_req: Request, res: Response) => {
    try {
      const { getFastpathMetrics, getFastpathPatterns } = require('../services/secretary-fastpath');
      const metrics = getFastpathMetrics();
      res.json({
        ok: true,
        fastpath: {
          totalAttempts: metrics.totalAttempts,
          totalHits: metrics.totalHits,
          hitRate: metrics.hitRate,
          avgLatencyMs: metrics.avgLatencyMs,
          hitsByPattern: metrics.hitsByPattern,
          registeredPatterns: getFastpathPatterns(),
        },
      });
    } catch (err) {
      res.json({
        ok: false,
        message: (err as Error).message,
        fastpath: {
          totalAttempts: 0,
          totalHits: 0,
          hitRate: 0,
          avgLatencyMs: 0,
          hitsByPattern: {},
          registeredPatterns: [],
        },
      });
    }
  });

  // GET /api/model-config — current model state for all providers
  app.get('/api/model-config', (_req: Request, res: Response) => {
    try {
      const { getAllModelStates, MODEL_OPTIONS } = require('../services/model-config');
      res.json({ states: getAllModelStates(), options: MODEL_OPTIONS });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // PUT /api/model-config — update a model for a provider+role
  app.put('/api/model-config', express.json(), (req: Request, res: Response) => {
    try {
      const { provider, role, model } = req.body;
      const validProviders = ['anthropic', 'openai', 'gemini'];
      const validRoles = ['chat', 'classifier', 'secretary', 'triathlon', 'content', 'finance', 'cooking'];
      if (!validProviders.includes(provider) || !validRoles.includes(role) || !model) {
        res.status(400).json({ error: 'Invalid provider, role, or model' });
        return;
      }
      const { setActiveModel } = require('../services/model-config');
      setActiveModel(provider, role, model);
      res.json({ ok: true, provider, role, model, message: 'Model updated. Active immediately — no restart needed.' });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // DELETE /api/model-config — reset a model to default
  app.delete('/api/model-config', express.json(), (req: Request, res: Response) => {
    try {
      const { provider, role } = req.body;
      if (!provider || !role) {
        res.status(400).json({ error: 'provider and role required' });
        return;
      }
      const { clearModelOverride, getAllModelStates } = require('../services/model-config');
      clearModelOverride(provider, role);
      res.json({ ok: true, states: getAllModelStates() });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // ── User Management API ────────────────────────────────────────────

  app.get('/api/users', (_req: Request, res: Response) => {
    try {
      const { listUsers } = require('../services/user-service');
      res.json({ users: listUsers() });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // User management routes — use users.id (canonical), not telegram_id.
  // Legacy :telegramId routes kept as aliases for backward compat.
  app.post('/api/users/:userId/suspend', (req: Request, res: Response) => {
    try {
      const { setUserStatusById } = require('../services/user-service');
      setUserStatusById(Number(req.params.userId), 'suspended');
      res.json({ ok: true, message: 'User suspended' });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  app.post('/api/users/:userId/activate', (req: Request, res: Response) => {
    try {
      const { setUserStatusById } = require('../services/user-service');
      setUserStatusById(Number(req.params.userId), 'active');
      res.json({ ok: true, message: 'User activated' });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // User management: canonical users.id routes (v4.14+)
  app.put('/api/users/:userId/tier', express.json(), (req: Request, res: Response) => {
    try {
      const db = getDb();
      const userId = Number(req.params.userId);
      db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(req.body.tier, userId);
      res.json({ ok: true, message: `Tier set to ${req.body.tier}` });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  app.put('/api/users/:userId/limits', express.json(), (req: Request, res: Response) => {
    try {
      const db = getDb();
      const userId = Number(req.params.userId);
      const { daily_message_limit, daily_token_limit, daily_cost_limit_usd } = req.body;
      if (daily_message_limit !== undefined) db.prepare('UPDATE users SET daily_message_limit = ? WHERE id = ?').run(daily_message_limit, userId);
      if (daily_token_limit !== undefined) db.prepare('UPDATE users SET daily_token_limit = ? WHERE id = ?').run(daily_token_limit, userId);
      if (daily_cost_limit_usd !== undefined) db.prepare('UPDATE users SET daily_cost_limit_usd = ? WHERE id = ?').run(daily_cost_limit_usd, userId);
      res.json({ ok: true, message: 'Limits updated' });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // ── Invite Code API ───────────────────────────────────────────────

  app.get('/api/invite-codes', (_req: Request, res: Response) => {
    try {
      const { listInviteCodes } = require('../services/user-service');
      res.json({ codes: listInviteCodes() });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  app.post('/api/invite-codes', express.json(), (req: Request, res: Response) => {
    try {
      const { createInviteCode } = require('../services/user-service');
      const code = createInviteCode(0, req.body.maxUses ?? 1, req.body.expiresInDays);

      // Store skill preset if provided
      if (req.body.skillPreset) {
        try {
          const { getDb } = require('../services/database');
          const db = getDb();
          db.prepare('UPDATE invite_codes SET skill_preset = ? WHERE code = ?')
            .run(JSON.stringify(req.body.skillPreset), code);
        } catch { /* skill_preset column may not exist yet */ }
      }
      res.json({ ok: true, code });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  app.delete('/api/invite-codes/:code', (req: Request, res: Response) => {
    try {
      const { deleteInviteCode } = require('../services/user-service');
      deleteInviteCode(req.params.code);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // ── Waitlist admin API (portal-token authed) ───────────────────────
  //
  // These are the ADMIN endpoints for the landing page waitlist. The PUBLIC
  // endpoints (POST /waitlist and GET /waitlist/stats) live at the root in
  // api/routes/waitlist.ts and bypass the portal token gate so the landing
  // page form can call them without credentials. Admin endpoints are routed
  // through /api/* which inherits the portal-token middleware.
  //
  // Admin flow:
  //   1. GET  /api/waitlist           → list pending + approved signups
  //   2. POST /api/waitlist/:id/approve → generate an invite code, link it
  //                                        to the waitlist row, return the
  //                                        code (admin emails it manually)
  //   3. POST /api/waitlist/:id/reject  → mark as rejected (soft delete)
  //   4. POST /api/waitlist/:id/invited → mark as "invite email sent"
  //                                        (optional bookkeeping step)

  app.get('/api/waitlist', (req: Request, res: Response) => {
    try {
      const db = getDb();
      const status = typeof req.query.status === 'string' ? req.query.status : null;
      const intent = typeof req.query.intent === 'string' ? req.query.intent : null;
      const limit = Math.min(parseInt((req.query.limit as string) || '200', 10), 1000);

      const where: string[] = [];
      const args: unknown[] = [];
      if (status) { where.push('status = ?'); args.push(status); }
      if (intent) { where.push('intent = ?'); args.push(intent); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const rows = db.prepare(
        `SELECT id, email, intent, source, use_case, status, invite_code, founder_slot,
                utm_source, utm_medium, utm_campaign, created_at, approved_at, notes
         FROM waitlist ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      ).all(...args, limit) as any[];

      // Also return the counter so the admin view can show "47/100 founders"
      const { countFounderSlots } = require('../api/routes/waitlist');
      const founderCount = countFounderSlots();

      const totals = db.prepare(
        `SELECT
           SUM(CASE WHEN intent = 'founder' THEN 1 ELSE 0 END) AS founder_total,
           SUM(CASE WHEN intent = 'general' THEN 1 ELSE 0 END) AS general_total,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_total,
           SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_total,
           SUM(CASE WHEN status = 'invited' THEN 1 ELSE 0 END) AS invited_total,
           SUM(CASE WHEN status = 'signed_up' THEN 1 ELSE 0 END) AS signed_up_total
         FROM waitlist`,
      ).get() as any;

      res.json({
        ok: true,
        entries: rows,
        counters: {
          founder: founderCount,
          totals,
        },
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/waitlist failed');
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  /**
   * Approve a waitlist entry and mint them an invite code.
   *
   * Generates a single-use invite code via the existing `user-service.createInviteCode`
   * (reusing TASK-15a's invite infrastructure), links it to the waitlist row,
   * and returns the code so the admin can paste it into a welcome email.
   *
   * Founder-intent entries get an invite code tagged with the `founder` skill
   * preset so their account lands on the founder tier on first login.
   */
  app.post('/api/waitlist/:id/approve', express.json(), (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const db = getDb();

      const row = db.prepare('SELECT * FROM waitlist WHERE id = ?').get(id) as any;
      if (!row) {
        res.status(404).json({ ok: false, error: 'Waitlist entry not found' });
        return;
      }
      if (row.status !== 'pending' && !req.body?.force) {
        res.status(400).json({
          ok: false,
          error: `Already ${row.status}. Pass {"force": true} to re-approve.`,
        });
        return;
      }

      const { createInviteCode } = require('../services/user-service');
      const expiresInDays = typeof req.body?.expiresInDays === 'number'
        ? req.body.expiresInDays
        : 30;
      const code = createInviteCode(0, 1, expiresInDays);

      // Tag founder-intent invites with a skill preset so downstream code can
      // unlock founder-tier benefits on redeem. Non-fatal if the column is
      // missing (old DB schemas).
      if (row.intent === 'founder') {
        try {
          db.prepare('UPDATE invite_codes SET skill_preset = ? WHERE code = ?')
            .run(JSON.stringify({ tier: 'founder', founderSlot: row.founder_slot }), code);
        } catch { /* skill_preset column may not exist yet */ }
      }

      db.prepare(
        `UPDATE waitlist SET
           status = 'approved',
           invite_code = ?,
           approved_at = datetime('now')
         WHERE id = ?`,
      ).run(code, id);

      res.json({ ok: true, code, email: row.email, intent: row.intent });
    } catch (err) {
      logger.error({ err }, 'POST /api/waitlist/:id/approve failed');
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  /** Mark a waitlist entry as rejected (soft delete — keeps the row for audit). */
  app.post('/api/waitlist/:id/reject', express.json(), (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const notes = typeof req.body?.notes === 'string' ? req.body.notes : null;
      const db = getDb();
      db.prepare(
        "UPDATE waitlist SET status = 'rejected', notes = COALESCE(?, notes) WHERE id = ?",
      ).run(notes, id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  /** Mark a waitlist entry as "invite email sent" (bookkeeping). */
  app.post('/api/waitlist/:id/invited', (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const db = getDb();
      db.prepare("UPDATE waitlist SET status = 'invited' WHERE id = ?").run(id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // ── Per-User Skill Access API ──────────────────────────────────────

  // Skills routes: now accept canonical users.id (v4.14+)
  app.get('/api/users/:userId/skills', (req: Request, res: Response) => {
    try {
      const { getUserSkillState } = require('../services/user-skill-access');
      const userId = parseInt(String(req.params.userId), 10);
      res.json({ skills: getUserSkillState(userId) });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  app.put('/api/users/:userId/skills', express.json(), (req: Request, res: Response) => {
    try {
      const { setSkillAccess, getUserSkillState } = require('../services/user-skill-access');
      const userId = parseInt(String(req.params.userId), 10);
      const { skill, subSkill, enabled, reason } = req.body;
      setSkillAccess(userId, skill, enabled, { subSkill: subSkill || undefined, reason });
      res.json({ ok: true, skills: getUserSkillState(userId) });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  app.post('/api/users/:userId/skills/reset', (req: Request, res: Response) => {
    try {
      const { resetUserSkillOverrides } = require('../services/user-skill-access');
      resetUserSkillOverrides(parseInt(String(req.params.userId), 10));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/audit-trail — recent audit events (admin only)
  app.get('/api/audit-trail', (_req: Request, res: Response) => {
    try {
      const userId = _req.query.userId ? parseInt(_req.query.userId as string, 10) : undefined;
      const limit = Math.min(parseInt(_req.query.limit as string || '50', 10), 500);
      const { getAuditTrail } = require('../services/audit-trail');
      const db = getDb();

      const rows = userId
        ? db.prepare('SELECT * FROM audit_trail WHERE user_id = ? ORDER BY ts DESC LIMIT ?').all(userId, limit)
        : db.prepare('SELECT * FROM audit_trail ORDER BY ts DESC LIMIT ?').all(limit);

      res.json({ entries: rows });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/users/:userId/data-summary — record counts per table (admin view)
  app.get('/api/users/:userId/data-summary', (req: Request, res: Response) => {
    try {
      const userId = parseInt(String(req.params.userId), 10);
      const { countUserFinanceData } = require('../services/user-data-export');
      const financeCounts = countUserFinanceData(userId);
      const db = getDb();

      const count = (table: string) => {
        try {
          return (db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE user_id = ?`).get(userId) as any)?.c ?? 0;
        } catch { return 0; }
      };

      res.json({
        conversations: count('conversations'),
        todos: count('todos'),
        reminders: count('reminders'),
        notes: count('notes'),
        sharedMemory: count('shared_memory'),
        savedIdeas: count('saved_ideas'),
        financeTransactions: financeCounts.transactions,
        financeTaxEvents: financeCounts.taxEvents,
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/settings — current settings for portal display
  app.get('/api/settings', (_req: Request, res: Response) => {
    try {
      const { getConfigProvider, DatabaseConfigProvider } = require('../services/config-provider');
      const provider = getConfigProvider();
      if (provider instanceof DatabaseConfigProvider) {
        res.json({ settings: provider.getAllSettings() });
      } else {
        res.json({ settings: [], message: 'DatabaseConfigProvider not active' });
      }
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // PUT /api/settings — update a setting
  app.put('/api/settings', express.json(), (req: Request, res: Response) => {
    try {
      const { id, value } = req.body;
      if (!id || value === undefined) {
        res.status(400).json({ error: 'id and value required' });
        return;
      }
      const { getConfigProvider, DatabaseConfigProvider } = require('../services/config-provider');
      const provider = getConfigProvider();
      if (!(provider instanceof DatabaseConfigProvider)) {
        res.status(503).json({ error: 'DatabaseConfigProvider not active' });
        return;
      }
      provider.setSetting(id, value);
      res.json({ ok: true, id, value, message: 'Setting updated. Active immediately.' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /api/settings — reset a setting to default
  app.delete('/api/settings', express.json(), (req: Request, res: Response) => {
    try {
      const { id } = req.body;
      if (!id) {
        res.status(400).json({ error: 'id required' });
        return;
      }
      const { getConfigProvider, DatabaseConfigProvider } = require('../services/config-provider');
      const provider = getConfigProvider();
      if (!(provider instanceof DatabaseConfigProvider)) {
        res.status(503).json({ error: 'DatabaseConfigProvider not active' });
        return;
      }
      provider.clearSetting(id);
      res.json({ ok: true, settings: provider.getAllSettings() });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/quality-scores — agent quality scoring data
  app.get('/api/quality-scores', (_req: Request, res: Response) => {
    try {
      const { getQualityByAgent } = require('../services/quality-scorer');
      const byAgent = getQualityByAgent(30);
      res.json({ ok: true, byAgent });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/task-metrics — task execution cost and duration data
  app.get('/api/task-metrics', (_req: Request, res: Response) => {
    try {
      const { getTaskExecutionSummary, getRecentExecutions } = require('../services/task-metrics');
      const summary = getTaskExecutionSummary(7);
      const recent = getRecentExecutions(20);
      res.json({ ok: true, summary, recent });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  /**
   * GET /api/cost-by-domain
   *
   * Aggregates api_usage by the `category` column (which is the domain/skill
   * name set by each provider's logging path: 'secretary', 'triathlon', 'content',
   * 'finance', 'cooking', 'classify', etc). Returns per-domain spend for the
   * requested window so the portal can show which skill is costing the most.
   *
   * Quarter: Per-endpoint cost dashboard. The SQL grouping is now three-way
   * — (category, provider, model) — because within a single provider we run
   * Sonnet for some domains and Haiku for others with VERY different per-call
   * costs (Sonnet is ~5× Haiku). A single "domain_secretary / anthropic" row
   * hid whether we were on the expensive tier or not. The `model` dimension
   * makes that immediately visible and lets the operator spot migration
   * opportunities (e.g. "domain_secretary still on sonnet, move to haiku").
   *
   * p95DurationMs is computed in JavaScript from the raw duration_ms values
   * loaded for the window — SQLite doesn't have percentile_cont and the
   * table is small (~20 rows/day) so there's no perf concern. The p95 vs
   * avg gap is the signal for "long-tail slow calls" that avg alone hides.
   *
   * dailySeries returns a per-day rollup for the whole window so the portal
   * can render a cost-over-time sparkline without a second round trip.
   */
  app.get('/api/cost-by-domain', (req: Request, res: Response) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days as string || '7', 10), 1), 90);
      const db = getDb();

      // Raw rows for the window — we need per-row duration_ms to compute p95
      // in JS. Cheap because the table is tiny (~20 rows/day) and the ts
      // index makes the range filter fast.
      const rawRows = db.prepare(`
        SELECT
          COALESCE(category, 'unknown') AS category,
          COALESCE(provider, 'anthropic') AS provider,
          COALESCE(model, 'unknown') AS model,
          input_tokens,
          output_tokens,
          cost_usd,
          duration_ms,
          ts
        FROM api_usage
        WHERE ts >= date('now', '-' || ? || ' days')
      `).all(days) as import('./cost-breakdown').ApiUsageRow[];

      // All aggregation + percentile logic lives in cost-breakdown.ts so it
      // can be unit-tested without mocking better-sqlite3.
      const { computeCostBreakdown } = require('./cost-breakdown') as typeof import('./cost-breakdown');
      const breakdown = computeCostBreakdown(rawRows, days);

      res.json({ ok: true, ...breakdown });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  /**
   * GET /api/provider-stats
   *
   * Fallback source for the dashboard "Provider Status" card. Reads directly
   * from api_usage (which is always populated) and merges in circuit-breaker
   * state from the in-memory TaskRoutingProvider when available.
   *
   * The older /api/provider-health endpoint only returns data for providers
   * that have been called through TaskRoutingProvider's executeWithFallback
   * wrapper — which means non-routing callers (direct anthropic-hook calls)
   * don't show up there. This endpoint always has data as long as anything
   * has been logged to api_usage.
   */
  app.get('/api/provider-stats', (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const todayRows = db.prepare(`
        SELECT COALESCE(provider, 'anthropic') AS provider,
               COUNT(*) AS calls,
               COALESCE(SUM(cost_usd), 0) AS cost,
               COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
               MAX(ts) AS lastCallAt
        FROM api_usage
        WHERE ts >= date('now')
        GROUP BY provider
      `).all() as Array<{ provider: string; calls: number; cost: number; tokens: number; lastCallAt: string }>;

      const weekRows = db.prepare(`
        SELECT COALESCE(provider, 'anthropic') AS provider,
               COUNT(*) AS calls,
               COALESCE(SUM(cost_usd), 0) AS cost
        FROM api_usage
        WHERE ts >= date('now', '-7 days')
        GROUP BY provider
      `).all() as Array<{ provider: string; calls: number; cost: number }>;

      // Merge with in-memory circuit-breaker state (if available)
      let circuits: Record<string, { state: string; failures: number }> = {};
      try {
        const { getActiveProvider } = require('../services/provider-registry');
        const active = getActiveProvider();
        if (active && typeof active.getAllCircuitStates === 'function') {
          circuits = active.getAllCircuitStates();
        }
      } catch { /* no active routing provider — use defaults */ }

      const knownProviders = new Set<string>(['anthropic', 'openai', 'gemini']);
      for (const r of todayRows) knownProviders.add(r.provider);
      for (const r of weekRows) knownProviders.add(r.provider);
      for (const p of Object.keys(circuits)) knownProviders.add(p);

      const providers = Array.from(knownProviders).map(name => {
        const today = todayRows.find(r => r.provider === name);
        const week = weekRows.find(r => r.provider === name);
        const circuit = circuits[name] || { state: 'CLOSED', failures: 0 };
        return {
          name,
          today: {
            calls: today?.calls || 0,
            cost: today?.cost || 0,
            tokens: today?.tokens || 0,
            lastCallAt: today?.lastCallAt || null,
          },
          week: {
            calls: week?.calls || 0,
            cost: week?.cost || 0,
          },
          circuit,
        };
      }).sort((a, b) => (b.today.cost + b.week.cost) - (a.today.cost + a.week.cost));

      res.json({ ok: true, providers });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // ── Skill Management API ─────────────────────────────────────────

  // GET /api/skills — list all skills with sub-skill status
  app.get('/api/skills', (_req: Request, res: Response) => {
    try {
      const skills = getAllSkillStatuses();
      res.json({ ok: true, skills });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // POST /api/skills/:name/enable — enable an entire skill
  app.post('/api/skills/:name/enable', (req: Request, res: Response) => {
    try {
      const name = req.params.name as DomainName;
      const result = enableSkill(name);
      if (!result) {
        res.status(404).json({ ok: false, message: `Skill "${name}" not found` });
        return;
      }
      cachedSnapshot = null;
      res.json({ ok: true, message: `Skill "${name}" enabled` });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // POST /api/skills/:name/disable — disable an entire skill
  app.post('/api/skills/:name/disable', (req: Request, res: Response) => {
    try {
      const name = req.params.name as DomainName;
      const result = disableSkill(name);
      if (!result) {
        res.status(404).json({ ok: false, message: `Skill "${name}" not found` });
        return;
      }
      cachedSnapshot = null;
      res.json({ ok: true, message: `Skill "${name}" disabled` });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // POST /api/skills/:name/subskills/:sub/enable — enable a sub-skill
  app.post('/api/skills/:name/subskills/:sub/enable', (req: Request, res: Response) => {
    try {
      const name = req.params.name as DomainName;
      const sub = String(req.params.sub);
      const result = enableSubSkill(name, sub);
      if (!result) {
        res.status(404).json({ ok: false, message: `Sub-skill "${sub}" not found in "${name}"` });
        return;
      }
      cachedSnapshot = null;
      res.json({ ok: true, message: `Sub-skill "${sub}" enabled` });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // POST /api/skills/:name/subskills/:sub/disable — disable a sub-skill
  app.post('/api/skills/:name/subskills/:sub/disable', (req: Request, res: Response) => {
    try {
      const name = req.params.name as DomainName;
      const sub = String(req.params.sub);
      const result = disableSubSkill(name, sub);
      if (!result) {
        res.status(404).json({ ok: false, message: `Sub-skill "${sub}" not found in "${name}"` });
        return;
      }
      cachedSnapshot = null;
      res.json({ ok: true, message: `Sub-skill "${sub}" disabled` });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // ── WhatsApp Webhook Routes ───────────────────────────────────────
  // These MUST come before the universal /api/webhooks/:provider route

  // GET /api/webhooks/whatsapp — Meta webhook verification
  app.get('/api/webhooks/whatsapp', (req: Request, res: Response) => {
    const verifyToken = config.whatsapp?.verifyToken;

    // Reject if WhatsApp is not configured or verify token is not set
    if (!config.whatsapp?.enabled || !verifyToken) {
      res.status(403).send('Forbidden');
      return;
    }

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && typeof token === 'string') {
      // Timing-safe comparison to prevent token oracle attacks
      const tokenBuf = Buffer.from(token);
      const expectedBuf = Buffer.from(verifyToken);
      if (tokenBuf.length === expectedBuf.length &&
          crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
        logger.info('WhatsApp webhook verified');
        res.status(200).send(challenge);
        return;
      }
    }

    logger.warn({ mode }, 'WhatsApp webhook verification failed');
    res.status(403).send('Forbidden');
  });

  // POST /api/webhooks/whatsapp — Incoming WhatsApp messages
  app.post('/api/webhooks/whatsapp',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req: Request, res: Response) => {
    // HMAC signature verification (when WHATSAPP_APP_SECRET is configured)
    const appSecret = config.whatsapp?.appSecret;
    if (appSecret) {
      const sig = req.headers['x-hub-signature-256'] as string | undefined;
      if (!sig) {
        res.status(403).send('Forbidden');
        return;
      }
      const expected = 'sha256=' + crypto
        .createHmac('sha256', appSecret)
        .update(req.body as Buffer)
        .digest('hex');
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        logger.warn('WhatsApp webhook HMAC verification failed');
        res.status(403).send('Forbidden');
        return;
      }
    }

    // Respond 200 immediately after verification (WhatsApp retries on non-200)
    res.status(200).send('OK');

    let body: any;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body)
        : Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf-8'))
        : req.body;
    } catch { return; }
    if (body?.object !== 'whatsapp_business_account') return;

    const entries = body.entry ?? [];
    for (const entry of entries) {
      const changes = entry.changes ?? [];
      for (const change of changes) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const messages = value?.messages ?? [];
        const contacts = value?.contacts ?? [];

        for (const msg of messages) {
          const senderPhone = msg.from;
          const senderName = contacts.find((c: { wa_id: string; profile?: { name?: string } }) =>
            c.wa_id === senderPhone)?.profile?.name ?? 'Unknown';

          pushEvent({
            ts: new Date().toISOString(),
            type: 'message',
            summary: `WhatsApp from ${senderName}: ${(msg.text?.body ?? msg.type).slice(0, 60)}`,
            detail: JSON.stringify(msg),
            domain: 'whatsapp',
          });

          logger.info({
            from: senderPhone,
            name: senderName,
            type: msg.type,
            msgId: msg.id,
          }, 'WhatsApp incoming message');

          // TODO: Route incoming WhatsApp messages to bot domains
        }

        // Handle status updates (sent, delivered, read)
        const statuses = value?.statuses ?? [];
        for (const status of statuses) {
          logger.debug({
            msgId: status.id,
            status: status.status,
            recipientId: status.recipient_id,
          }, 'WhatsApp message status update');
        }
      }
    }
  });

  // ── Webhook Infrastructure API ──────────────────────────────────────

  // POST /api/webhooks/:provider — universal webhook receiver
  // Uses raw body parsing for HMAC signature verification
  app.post('/api/webhooks/:provider',
    express.raw({ type: '*/*', limit: config.webhooks.maxPayloadBytes }),
    async (req: Request, res: Response) => {
      const provider = req.params.provider as WebhookProvider;

      // Google webhook verification challenge (sync validation)
      if (req.headers['x-goog-resource-state'] === 'sync') {
        res.status(200).send('OK');
        return;
      }

      // Microsoft Graph validation token (subscription verification)
      const validationToken = req.query.validationToken;
      if (validationToken && typeof validationToken === 'string') {
        res.type('text/plain').status(200).send(validationToken);
        return;
      }

      // Find matching subscription
      const subs = getSubscriptions({ provider, status: 'active' });
      const sub = subs.length > 0 ? subs[0] : null;

      // Verify signature if subscription has a secret
      if (sub?.secret) {
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body));
        const valid = verifySignature(
          provider,
          rawBody,
          req.headers as Record<string, string | string[] | undefined>,
          sub.secret,
        );
        if (!valid) {
          logger.warn({ provider }, 'Webhook signature verification failed');
          res.status(401).json({ ok: false, message: 'Invalid signature' });
          return;
        }
      }

      try {
        // Parse payload
        let payload: Record<string, unknown>;
        if (Buffer.isBuffer(req.body)) {
          try {
            payload = JSON.parse(req.body.toString('utf-8'));
          } catch {
            payload = { raw: req.body.toString('utf-8') };
          }
        } else if (typeof req.body === 'object') {
          payload = req.body as Record<string, unknown>;
        } else {
          payload = { raw: String(req.body) };
        }

        // Extract event type from provider-specific headers/payload
        const eventType = extractEventType(provider, req.headers, payload);

        // Extract idempotency key from provider-specific fields
        const idempotencyKey = extractIdempotencyKey(provider, req.headers, payload);

        const eventId = await receiveWebhookEvent({
          provider,
          event_type: eventType,
          payload,
          headers: flattenHeaders(req.headers),
          idempotency_key: idempotencyKey,
          subscription_id: sub?.id,
        });

        res.status(200).json({ ok: true, eventId });
      } catch (err) {
        logger.error({ err, provider }, 'Webhook processing failed');
        res.status(500).json({ ok: false, message: 'Processing failed' });
      }
    });

  // GET /api/webhooks/stats — webhook infrastructure health
  app.get('/api/webhooks/stats', (_req: Request, res: Response) => {
    try {
      const stats = getWebhookStats();
      res.json({ ok: true, ...stats });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/webhooks/subscriptions — list all subscriptions
  app.get('/api/webhooks/subscriptions', (req: Request, res: Response) => {
    try {
      const provider = req.query.provider as WebhookProvider | undefined;
      const subs = getSubscriptions(provider ? { provider } : undefined);
      res.json({ ok: true, subscriptions: subs });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // POST /api/webhooks/subscriptions — register a new subscription
  app.post('/api/webhooks/subscriptions', (req: Request, res: Response) => {
    const { provider, event_types, secret, external_id, metadata, expires_at } = req.body || {};
    if (!provider) {
      res.status(400).json({ ok: false, message: 'provider is required' });
      return;
    }
    try {
      const id = registerSubscription({
        provider,
        event_types,
        endpoint_path: `/api/webhooks/${provider}`,
        secret: secret || config.webhooks.secret || undefined,
        external_id,
        metadata,
        expires_at,
      });
      if (id < 0) {
        res.status(500).json({ ok: false, message: 'Failed to register subscription' });
        return;
      }
      cachedSnapshot = null;
      res.json({ ok: true, id, endpoint: `/api/webhooks/${provider}` });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // DELETE /api/webhooks/subscriptions/:id — remove a subscription
  app.delete('/api/webhooks/subscriptions/:id', (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ ok: false, message: 'Invalid subscription ID' });
      return;
    }
    try {
      const removed = removeSubscription(id);
      if (!removed) {
        res.status(404).json({ ok: false, message: 'Subscription not found' });
        return;
      }
      cachedSnapshot = null;
      res.json({ ok: true, message: 'Subscription removed' });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/webhooks/events — recent webhook events
  app.get('/api/webhooks/events', (req: Request, res: Response) => {
    try {
      const provider = req.query.provider as string | undefined;
      const status = req.query.status as string | undefined;
      const limit = parseInt(String(req.query.limit || '50'), 10);
      const events = getRecentWebhookEvents({
        provider: provider || undefined,
        status: status as any || undefined,
        limit: Math.min(limit, 200),
      });
      res.json({ ok: true, events });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // POST /api/webhooks/events/:id/replay — replay a failed event
  app.post('/api/webhooks/events/:id/replay', async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ ok: false, message: 'Invalid event ID' });
      return;
    }
    try {
      const success = await replayEvent(id);
      res.json({ ok: success, message: success ? 'Event replayed successfully' : 'Replay failed' });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // ── Start HTTP server ──────────────────────────────────────────
  const server = http.createServer(app);
  const bind = config.portal.bind;
  const port = config.portal.port;

  // Expire stale webhook subscriptions on server start
  try { expireSubscriptions(); } catch { /* non-critical */ }

  // Handle listen errors gracefully — EADDRINUSE should NOT crash the bot
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error({ port, bind }, `Portal port ${port} already in use — portal disabled but bot continues`);
    } else {
      logger.error({ err, port, bind }, 'Portal server error');
    }
  });

  // Attach WebSocket server for iOS streaming
  if (config.ios?.enabled) {
    try {
      const { attachWebSocket } = require('../api/websocket');
      attachWebSocket(server);
    } catch (err) {
      logger.error({ err }, 'Failed to attach WebSocket server');
    }
  }

  server.listen(port, bind, () => {
    logger.info({ port, bind }, `Nexus Hub Status Portal running at http://${bind}:${port}`);
    if (!portalToken && bind !== '127.0.0.1' && bind !== 'localhost') {
      logger.warn('Portal is listening on a non-loopback address without PORTAL_TOKEN — API is unauthenticated!');
    }
    if (!config.health.token && bind !== '127.0.0.1' && bind !== 'localhost') {
      logger.warn('HEALTH_TOKEN is not set — /health/detailed is publicly accessible!');
    }
  });

  return server;
}

// ─── Webhook Helpers ───────────────────────────────────────────────

/** Extract event type from provider-specific headers/payload. */
function extractEventType(
  provider: string,
  headers: Record<string, string | string[] | undefined>,
  payload: Record<string, unknown>,
): string {
  switch (provider) {
    case 'google_calendar':
    case 'google_gmail':
      return (headers['x-goog-resource-state'] as string) || 'update';
    case 'outlook_calendar':
    case 'outlook_mail':
    case 'outlook_todo':
      return (payload.changeType as string) || 'updated';
    case 'garmin':
      return (payload.activityType as string) || 'activity';
    case 'strava':
      return (payload.aspect_type as string) || (payload.object_type as string) || 'activity';
    case 'github': {
      const ghEvent = headers['x-github-event'];
      return (typeof ghEvent === 'string' ? ghEvent : 'push');
    }
    default:
      return (payload.event_type as string) || (payload.type as string) || 'unknown';
  }
}

/** Extract idempotency key from provider-specific fields. */
function extractIdempotencyKey(
  provider: string,
  headers: Record<string, string | string[] | undefined>,
  payload: Record<string, unknown>,
): string | undefined {
  switch (provider) {
    case 'google_calendar':
    case 'google_gmail':
      return headers['x-goog-message-number'] as string | undefined;
    case 'outlook_calendar':
    case 'outlook_mail':
    case 'outlook_todo':
      return payload.subscriptionId as string | undefined;
    case 'github':
      return headers['x-github-delivery'] as string | undefined;
    case 'strava':
      return payload.event_time ? String(payload.event_time) : undefined;
    default:
      return payload.id ? String(payload.id) : undefined;
  }
}

/** Flatten Express headers into a simple string record (for storage). */
function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return result;
}
