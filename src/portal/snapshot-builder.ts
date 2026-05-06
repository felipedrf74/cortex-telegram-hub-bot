// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { CronExpressionParser } from 'cron-parser';
import { config } from '../config';
import { getDb } from '../services/database';
import { isGarminConfigured } from '../services/garmin';
import { isGoogleCalendarConfigured } from '../services/google-calendar';
import { isGmailConfigured } from '../services/google-gmail';
import { isGoogleDriveEnabled } from '../services/google-drive';
import { getPendingCount as getInvoiceQueuePending } from '../services/invoice-queue';
import { isInvoiceFilingConfigured } from '../services/invoice-filer';
import { getActiveSignalCount, getAgentStats } from '../services/intelligence-bus';
import { isMicrosoftConfigured } from '../services/microsoft-auth';
import { isOutlookCalendarConfigured } from '../services/outlook-calendar';
import { isOutlookMailConfigured } from '../services/outlook-mail';
import { isOutlookTodoConfigured } from '../services/microsoft-todo';
import { getRuntimeStatus } from '../services/runtime-status';
import { getOwnerBootstrapTarget } from '../services/user-service';
import { getAllSkillStatuses } from '../skills/skill-manager';
import {
  createContentReferencesAdminContext,
  getSystemChannels as getRefChannels,
  getSystemKnowledge,
} from '../state/content-references';
import { logger } from '../utils/logger';
import { humanDelta, humanUptime } from './formatters';
import { getPortalSnapshotStatements as getStmts } from './snapshot-statements';
import {
  getGarminRefreshStatus,
  getJobStatuses,
  getLastMessageAt,
  getRecentEvents,
  isBotPollingActive,
  isRestarting,
} from './telemetry';

// ─── Types ──────────────────────────────────────────────────────────

export interface PortalSnapshotResponse {
  version: string;
  generatedAt: string;
  uptime: { seconds: number; human: string };
  server: {
    status: 'online' | 'offline';
    database: 'connected' | 'disconnected';
  };
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

export function getPortalTrainingStatsUserId(): number | null {
  return getOwnerBootstrapTarget()?.tenantId ?? null;
}

export function getPortalUsageMeteringUserIds(): number[] {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT id FROM users WHERE status = 'active'"
    ).all() as { id: number }[];
    if (rows.length > 0) return rows.map((row) => row.id);
  } catch {
    // users table may not exist yet
  }

  const ownerTarget = getOwnerBootstrapTarget();
  return ownerTarget ? [ownerTarget.tenantId] : [];
}

// ─── Snapshot Builder ───────────────────────────────────────────────

export function buildPortalSnapshot(startedAt: number): PortalSnapshotResponse {
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

  const integrations: PortalSnapshotResponse['integrations'] = [
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
  let apiUsage: PortalSnapshotResponse['apiUsage'];
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
  let invoices: PortalSnapshotResponse['invoices'];
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
  let emailLog: PortalSnapshotResponse['emailLog'];
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
  const nextRuns: PortalSnapshotResponse['nextRuns'] = [];
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
  const healthSummary: PortalSnapshotResponse['healthSummary'] = {
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

  let calendarJobs: PortalSnapshotResponse['calendarData']['jobs'] = [];
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
      channels: getRefChannels(createContentReferencesAdminContext('portal snapshot content reference summary')).map((ch) => ({
        id: ch.id,
        url: ch.channel_url,
        name: ch.channel_name,
        status: ch.status,
        videosAnalyzed: ch.video_count_analyzed,
        lastAnalyzed: ch.last_analyzed_at,
        error: ch.error_message,
      })),
      knowledgeCategories: getSystemKnowledge(createContentReferencesAdminContext('portal snapshot content reference summary')).length,
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
  let domainStatus: PortalSnapshotResponse['domainStatus'] = [];
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
    const userId = getPortalTrainingStatsUserId();
    if (userId) {
      trainingPlans = getPlanStats(userId);
    }
  } catch { /* table may not exist yet */ }

  // ── Usage metering stats ──────────────────────────────────────────
  let usageMetering: PortalSnapshotResponse['usageMetering'] = {
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
    // Per-user breakdown for active canonical tenants
    for (const uid of getPortalUsageMeteringUserIds()) {
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
  const runtime = getRuntimeStatus();

  return {
    version: pkgVersion,
    generatedAt: new Date().toISOString(),
    uptime: { seconds: uptimeSec, human: humanUptime(uptimeSec) },
    server: {
      status: runtime.serviceStatus,
      database: runtime.databaseStatus,
    },
    bot: {
      polling: runtime.botPolling,
      restarting: runtime.botRestarting,
      lastMessageAt: runtime.lastMessageAt,
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

export function buildPortalAdapterStatus(): PortalSnapshotResponse['adapters'] {
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
