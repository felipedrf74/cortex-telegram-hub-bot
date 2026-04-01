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

// ─── Types ──────────────────────────────────────────────────────────

interface SnapshotResponse {
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

  return {
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
  };
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
      clearAllConversations();
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

  // ── Auth middleware for /api/* ──────────────────────────────────
  const portalToken = config.portal.token;

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
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
    res.sendFile(htmlPath);
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

  // ── Start HTTP server ──────────────────────────────────────────
  const server = http.createServer(app);
  const bind = config.portal.bind;
  const port = config.portal.port;

  server.listen(port, bind, () => {
    logger.info({ port, bind }, `Nexus Hub Status Portal running at http://${bind}:${port}`);
    if (!portalToken && bind !== '127.0.0.1' && bind !== 'localhost') {
      logger.warn('Portal is listening on a non-loopback address without PORTAL_TOKEN — API is unauthenticated!');
    }
  });

  return server;
}
