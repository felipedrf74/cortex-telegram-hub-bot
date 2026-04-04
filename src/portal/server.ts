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
  app.use(express.json());

  // ── iOS API (mounted first — separate JWT auth, not portal token) ────
  if (config.ios?.enabled) {
    const { createApiRouter } = require('../api/router');
    app.use('/api/v1', createApiRouter());
    logger.info('iOS API enabled on /api/v1');

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
      const { getUserLanguage } = require('../services/user-service');
      const { t } = require('../utils/i18n');
      const userId = parseInt(state, 10);
      const tokens = await exchangeCode('google', code, userId);
      storeTokens(userId, 'google', tokens);

      // Notify user via Telegram
      try {
        const lang = getUserLanguage(userId);
        const botRef = getBotRef();
        if (botRef) {
          await botRef.api.sendMessage(userId, t('oauth_connected', lang, { provider: 'Google' }));
        }
      } catch { /* notification is best-effort */ }

      res.send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>✅ Connected!</h1><p>Google account linked. You can close this window and return to Telegram.</p></body></html>');
    } catch (err) {
      logger.error({ err }, 'Google OAuth callback failed');
      res.status(500).send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>❌ Connection Failed</h1><p>Please try again with /connect google in Telegram.</p></body></html>');
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
      const { getUserLanguage } = require('../services/user-service');
      const { t } = require('../utils/i18n');
      const userId = parseInt(state, 10);
      const tokens = await exchangeCode('outlook', code, userId);
      storeTokens(userId, 'outlook', tokens);

      try {
        const lang = getUserLanguage(userId);
        const botRef = getBotRef();
        if (botRef) {
          await botRef.api.sendMessage(userId, t('oauth_connected', lang, { provider: 'Outlook' }));
        }
      } catch { /* notification is best-effort */ }

      res.send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>✅ Connected!</h1><p>Outlook account linked. You can close this window and return to Telegram.</p></body></html>');
    } catch (err) {
      logger.error({ err }, 'Outlook OAuth callback failed');
      res.status(500).send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>❌ Connection Failed</h1><p>Please try again with /connect outlook in Telegram.</p></body></html>');
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

  // ── Detailed health check (auth-protected via ?token=HEALTH_TOKEN) ──
  app.get('/health/detailed', (req: Request, res: Response) => {
    const healthToken = config.health.token;
    if (healthToken && req.query.token !== healthToken) {
      res.status(401).json({ error: 'Unauthorized — provide ?token=HEALTH_TOKEN' });
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
      // No token configured — allow (dev mode)
      return next();
    }
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${portalToken}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  // ── GET / — serve dashboard HTML ───────────────────────────────
  app.get('/', (_req: Request, res: Response) => {
    const htmlPath = path.join(__dirname, 'portal.html');
    if (!fs.existsSync(htmlPath)) {
      res.status(503).send('Dashboard not found — portal.html is missing');
      return;
    }
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    // Inject the portal token into the HTML so the browser doesn't need localStorage/prompt
    let html = fs.readFileSync(htmlPath, 'utf-8');
    if (portalToken) {
      html = html.replace(
        "localStorage.getItem('portal_token') || new URLSearchParams(location.search).get('token') || ''",
        `localStorage.getItem('portal_token') || new URLSearchParams(location.search).get('token') || '${portalToken}'`,
      );
    }
    res.type('html').send(html);
  });

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

  // GET /api/content-knowledge — extracted voice DNA from reference channels
  app.get('/api/content-knowledge', (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const knowledge = db.prepare(`
        SELECT category, synthesized_text, source_channels, updated_at
        FROM content_knowledge ORDER BY updated_at DESC
      `).all() as any[];
      res.json({
        ok: true,
        knowledge: knowledge.map(k => ({
          category: k.category,
          text: k.synthesized_text,
          sources: JSON.parse(k.source_channels || '[]'),
          updatedAt: k.updated_at,
        })),
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // GET /api/books — book library
  app.get('/api/books', (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const books = db.prepare(`
        SELECT id, title, author, core_thesis, pillar_mapping, key_frameworks,
               personal_notes, extraction_status, times_referenced, created_at
        FROM book_library ORDER BY times_referenced DESC, created_at DESC
      `).all();
      res.json({ ok: true, books });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // POST /api/override/sprint — toggle content sprint mode
  app.post('/api/override/sprint', (req: Request, res: Response) => {
    try {
      const db = getDb();
      const existing = db.prepare(
        "SELECT id FROM agent_signals WHERE signal_type = 'content_sprint_mode' AND status = 'active'"
      ).get() as any;

      if (existing) {
        dismissSignal(existing.id);
        res.json({ ok: true, sprint: false, message: 'Sprint mode disabled' });
      } else {
        writeSignal({
          source_agent: 'mission-control',
          signal_type: 'content_sprint_mode',
          payload: { enabled: true, activated_at: new Date().toISOString() },
          priority: 'urgent',
        });
        res.json({ ok: true, sprint: true, message: 'Sprint mode enabled' });
      }
      cachedSnapshot = null;
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

  app.post('/api/users/:telegramId/suspend', (req: Request, res: Response) => {
    try {
      const { setUserStatus } = require('../services/user-service');
      setUserStatus(Number(req.params.telegramId), 'suspended');
      res.json({ ok: true, message: 'User suspended' });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  app.post('/api/users/:telegramId/activate', (req: Request, res: Response) => {
    try {
      const { setUserStatus } = require('../services/user-service');
      setUserStatus(Number(req.params.telegramId), 'active');
      res.json({ ok: true, message: 'User activated' });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  app.put('/api/users/:telegramId/tier', express.json(), (req: Request, res: Response) => {
    try {
      const { setUserTier } = require('../services/user-service');
      setUserTier(Number(req.params.telegramId), req.body.tier);
      res.json({ ok: true, message: `Tier set to ${req.body.tier}` });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  app.put('/api/users/:telegramId/limits', express.json(), (req: Request, res: Response) => {
    try {
      const { setUserLimits } = require('../services/user-service');
      setUserLimits(Number(req.params.telegramId), req.body);
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

  // ── Per-User Skill Access API ──────────────────────────────────────

  app.get('/api/users/:telegramId/skills', (req: Request, res: Response) => {
    try {
      const { getUserSkillState } = require('../services/user-skill-access');
      const telegramId = parseInt(String(req.params.telegramId), 10);
      res.json({ skills: getUserSkillState(telegramId) });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  app.put('/api/users/:telegramId/skills', express.json(), (req: Request, res: Response) => {
    try {
      const { setSkillAccess, getUserSkillState } = require('../services/user-skill-access');
      const telegramId = parseInt(String(req.params.telegramId), 10);
      const { skill, subSkill, enabled, reason } = req.body;
      setSkillAccess(telegramId, skill, enabled, { subSkill: subSkill || undefined, reason });
      res.json({ ok: true, skills: getUserSkillState(telegramId) });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  app.post('/api/users/:telegramId/skills/reset', (req: Request, res: Response) => {
    try {
      const { resetUserSkillOverrides } = require('../services/user-skill-access');
      resetUserSkillOverrides(parseInt(String(req.params.telegramId), 10));
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

  // GET /api/users/:telegramId/data-summary — record counts per table (admin view)
  app.get('/api/users/:telegramId/data-summary', (req: Request, res: Response) => {
    try {
      const telegramId = parseInt(String(req.params.telegramId), 10);
      const { countUserFinanceData } = require('../services/user-data-export');
      const financeCounts = countUserFinanceData(telegramId);
      const db = getDb();

      const count = (table: string) => {
        try {
          return (db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE user_id = ?`).get(telegramId) as any)?.c ?? 0;
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
