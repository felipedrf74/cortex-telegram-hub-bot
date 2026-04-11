// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { isBotPollingActive, getLastMessageAt } from '../../portal/telemetry';
import { getCached, setCache } from '../../services/cache-store';
import { apiSuccess, sendError } from '../response-helpers';

export function dashboardRoutes(): Router {
  const router = Router();

  /**
   * GET /api/v1/dashboard
   * Aggregated dashboard — single call for the home screen.
   * Supports ETag/If-None-Match for polling efficiency.
   * All external calls are parallel via Promise.allSettled (never sequential).
   */
  router.get('/', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;

    try {
      // Check SQLite cache first (survives restarts, instant response)
      const dashboardCacheKey = `dashboard:${userId}`;
      const cachedDashboard = getCached<any>(dashboardCacheKey);
      if (cachedDashboard) {
        // The ETag is computed over the wrapped envelope, so iOS clients
        // get a stable hash that includes the timestamp/cached flags.
        const envelope = apiSuccess(cachedDashboard, { cached: true });
        const envelopeJson = JSON.stringify({ ...envelope, timestamp: undefined }); // hash is content-only
        const etag = `"${crypto.createHash('md5').update(envelopeJson).digest('hex')}"`;
        if (req.headers['if-none-match'] === etag) {
          res.status(304).end();
          return;
        }
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, max-age=30');
        res.json(envelope);
        return;
      }

      // Cache miss — fetch all data in parallel
      const [calendarResult, tasksResult, trainingResult, contentResult] = await Promise.allSettled([
        fetchCalendar(),
        fetchTasks(),
        fetchTraining(userId),
        fetchContent(userId),
      ]);

      const calendar = calendarResult.status === 'fulfilled' ? calendarResult.value : { today: [], upcoming: [] };
      const tasks = tasksResult.status === 'fulfilled' ? tasksResult.value : { overdue: 0, dueToday: 0, totalPending: 0, topTasks: [] };
      const training = trainingResult.status === 'fulfilled' ? trainingResult.value : { todaySession: null, weeklyAdherence: null, readinessScore: null, bodyBattery: null };
      const content = contentResult.status === 'fulfilled' ? contentResult.value : { pipelineCount: { ideas: 0, scripted: 0, filmed: 0, editing: 0, published: 0 }, nextDeadline: null };

      // Time-aware greeting with per-user display name
      const now = new Date();
      const hour = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: config.app.timezone }), 10);
      const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

      // Look up the user's first name — falls back to empty string
      // so the greeting is "Good afternoon" instead of "Good afternoon, undefined"
      let displayName = '';
      try {
        const { getUserById } = require('../../services/user-service');
        const user = getUserById(userId);
        displayName = user?.first_name || user?.username || '';
      } catch { /* user-service not available */ }

      const startTime = (global as any).__startTime;
      const uptimeMs = startTime ? Date.now() - startTime : 0;
      const uptimeStr = uptimeMs > 86400000
        ? `${Math.floor(uptimeMs / 86400000)}d ${Math.floor((uptimeMs % 86400000) / 3600000)}h`
        : `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`;

      const dashboard = {
        greeting: displayName ? `${greeting}, ${displayName}` : greeting,
        date: now.toISOString().slice(0, 10),
        dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long', timeZone: config.app.timezone }),
        calendar,
        tasks,
        training,
        content,
        system: {
          version: getAppVersion(),
          uptime: uptimeStr,
          botStatus: isBotPollingActive() ? 'online' : 'offline',
          lastMessageAt: getLastMessageAt(),
        },
      };

      // Cache the raw dashboard data (unwrapped) so warmDashboardCache and
      // the cache hit path can both use it without double-wrapping.
      setCache(dashboardCacheKey, dashboard, 180);

      const envelope = apiSuccess(dashboard);
      // ETag support — skip full response if nothing changed
      const envelopeJson = JSON.stringify({ ...envelope, timestamp: undefined });
      const etag = `"${crypto.createHash('md5').update(envelopeJson).digest('hex')}"`;

      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }

      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, max-age=30');
      res.json(envelope);
    } catch (err: any) {
      logger.error({ err, platform: 'ios' }, 'Dashboard aggregation failed');
      sendError(res, 'INTERNAL', err?.message || 'Dashboard aggregation failed', 500);
    }
  });

  return router;
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractTime(dateInput: any): string {
  if (!dateInput) return '';
  const raw = typeof dateInput === 'string' ? dateInput : dateInput.dateTime || dateInput.date || String(dateInput);
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.app.timezone });
    }
  } catch {}
  const match = raw.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : '';
}

function extractTitle(e: any): string {
  return e.subject || e.summary || e.title || e.displayName || e.name || '(No title)';
}

/**
 * Pre-warm dashboard cache in background so first load is instant.
 * Called on startup and periodically.
 */
export async function warmDashboardCache(userId: number): Promise<void> {
  const cacheKey = `dashboard:${userId}`;
  if (getCached(cacheKey)) return; // Already cached

  try {
    const [calendarResult, tasksResult, trainingResult, contentResult] = await Promise.allSettled([
      fetchCalendar(), fetchTasks(), fetchTraining(userId), fetchContent(userId),
    ]);

    const now = new Date();
    const hour = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: config.app.timezone }), 10);
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    let warmDisplayName = '';
    try {
      const { getUserById } = require('../../services/user-service');
      const user = getUserById(userId);
      warmDisplayName = user?.first_name || user?.username || '';
    } catch { /* */ }

    const response = {
      greeting: warmDisplayName ? `${greeting}, ${warmDisplayName}` : greeting,
      date: now.toISOString().slice(0, 10),
      dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long', timeZone: config.app.timezone }),
      calendar: calendarResult.status === 'fulfilled' ? calendarResult.value : { today: [], upcoming: [] },
      tasks: tasksResult.status === 'fulfilled' ? tasksResult.value : { overdue: 0, dueToday: 0, totalPending: 0, topTasks: [] },
      training: trainingResult.status === 'fulfilled' ? trainingResult.value : { todaySession: null, weeklyAdherence: null, readinessScore: null, bodyBattery: null },
      content: contentResult.status === 'fulfilled' ? contentResult.value : { pipelineCount: { ideas: 0, scripted: 0, filmed: 0, editing: 0, published: 0 }, nextDeadline: null },
      system: { version: getAppVersion(), uptime: '0h 0m', botStatus: 'online', lastMessageAt: null },
    };

    setCache(cacheKey, response, 180);
    logger.debug('Dashboard cache warmed');
  } catch (err) {
    logger.debug({ err }, 'Dashboard cache warming failed (non-critical)');
  }
}

/** Read version from package.json (works with PM2, not just npm start) */
function getAppVersion(): string {
  try {
    const pkg = require('../../../package.json');
    return pkg.version || '0.0.0';
  } catch {
    return process.env.npm_package_version || '0.0.0';
  }
}

function normalizeBodyBattery(bb: any): number | null {
  if (bb === null || bb === undefined) return null;
  if (typeof bb === 'number') return Math.round(bb);
  if (typeof bb === 'object') {
    const val = bb.current !== undefined ? bb.current
      : bb.charged !== undefined ? bb.charged
      : bb.score !== undefined ? bb.score
      : null;
    return val !== null && val !== undefined ? Math.round(Number(val)) : null;
  }
  return null;
}

function mapCalendarEvent(e: any, source: string) {
  return {
    id: e.id,
    title: extractTitle(e),
    start: extractTime(e.start),
    end: extractTime(e.end),
    source,
    category: e.categories?.[0] || null,
    color: null,
  };
}

// ── Data Fetchers (all independently failable) ──────────────────────

async function fetchCalendar() {
  const today = new Date();
  const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);
  const start = startOfDay.toISOString();
  const end = endOfDay.toISOString();

  // PARALLEL fetch of Outlook + Google Calendar (never sequential)
  const [outlookResult, googleResult] = await Promise.allSettled([
    (async () => {
      const { getEvents } = require('../../services/outlook-calendar');
      const events = await getEvents(start, end);
      return Array.isArray(events) ? events.map((e: any) => mapCalendarEvent(e, 'outlook')) : [];
    })(),
    (async () => {
      const { getEvents } = require('../../services/google-calendar');
      const events = await getEvents(start, end);
      return Array.isArray(events) ? events.map((e: any) => mapCalendarEvent(e, 'google')) : [];
    })(),
  ]);

  const outlookEvents = outlookResult.status === 'fulfilled' ? outlookResult.value : [];
  const googleEvents = googleResult.status === 'fulfilled' ? googleResult.value : [];

  const allEvents = [...outlookEvents, ...googleEvents].sort((a, b) => a.start.localeCompare(b.start));
  return { today: allEvents, upcoming: [] };
}

async function fetchTasks() {
  const todo = require('../../services/microsoft-todo');
  const allTasksResult = await todo.getAllPendingTasks();
  const tasks = allTasksResult?.data || allTasksResult || [];
  if (!Array.isArray(tasks)) return { overdue: 0, dueToday: 0, totalPending: 0, topTasks: [] };

  const now = new Date();
  // MS Graph stores due dates as T23:00:00 UTC for the "previous" day in European TZ.
  // Example: "due April 7" = "2026-04-06T23:00:00" in UTC = April 7 in Lisbon.
  // To compare correctly, use the DATE PORTION ONLY (first 10 chars of ISO string).
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: config.app.timezone }); // "2026-04-06"

  function getDueDateStr(t: any): string | null {
    const raw = t.dueDateTime?.dateTime || t.dueDateTime;
    if (!raw) return null;
    // MS Graph: "2026-04-06T23:00:00.0000000" → add 1 hour to get Lisbon date
    const d = new Date(raw);
    return d.toLocaleDateString('en-CA', { timeZone: config.app.timezone }); // "2026-04-07"
  }

  const overdue = tasks.filter((t: any) => {
    const dueStr = getDueDateStr(t);
    return dueStr && dueStr < todayStr;
  }).length;

  const dueToday = tasks.filter((t: any) => {
    const dueStr = getDueDateStr(t);
    return dueStr === todayStr;
  }).length;

  const topTasks = tasks.slice(0, 5).map((t: any) => ({
    id: t.id, title: t.title, body: t.body?.content || null,
    importance: t.importance || 'normal', status: t.status || 'notStarted',
    dueDateTime: t.dueDateTime?.dateTime || t.dueDateTime || null,
    listId: t.listId || null, listName: t.listName || null,
    checklistItems: null, createdDateTime: t.createdDateTime || null,
  }));

  return { overdue, dueToday, totalPending: tasks.length, topTasks };
}

async function fetchTraining(userId: number) {
  let readinessScore: number | null = null;
  let bodyBattery: number | null = null;

  // Garmin is a singleton service (username/password, not OAuth per-user).
  // Only the owner (Garmin-connected user) gets Garmin-backed readiness.
  // Other users get Apple Health data or neutral defaults.
  const { config: appConfig } = require('../../config');
  const isGarminUser = appConfig.telegram.allowedUserIds.includes(userId);

  const cachedReadiness = getCached<{ score: number; bodyBattery: number | null }>(`readiness:${userId}`);
  if (cachedReadiness) {
    readinessScore = cachedReadiness.score;
    bodyBattery = cachedReadiness.bodyBattery;
  } else {
    try {
      if (isGarminUser) {
        // Owner: full Garmin-backed readiness
        const { calculateReadiness } = require('../../services/readiness-scorer');
        const readiness = await calculateReadiness(userId);
        readinessScore = readiness?.score || null;
        bodyBattery = normalizeBodyBattery(readiness?.bodyBattery || readiness?.factors?.bodyBattery);

        if (bodyBattery === null) {
          try {
            const garmin = require('../../services/garmin');
            const todayStr = new Date().toISOString().slice(0, 10);
            const bb = await garmin.getBodyBattery?.(todayStr);
            bodyBattery = normalizeBodyBattery(bb);
          } catch {}
        }
      } else {
        // Non-owner: try Apple Health data, otherwise neutral defaults
        try {
          const db = require('../../services/database').getDb();
          const healthRow = db.prepare(
            "SELECT data_json FROM apple_health_data WHERE user_id = ? AND date = ? AND data_type = 'daily_snapshot'"
          ).get(userId, new Date().toISOString().slice(0, 10)) as any;
          if (healthRow?.data_json) {
            const health = JSON.parse(healthRow.data_json);
            readinessScore = health.readinessScore || null;
            bodyBattery = health.bodyBattery || null;
          }
        } catch {}
        // Fallback: neutral score for users without any wearable data
        if (readinessScore === null) readinessScore = null;
      }

      setCache(`readiness:${userId}`, { score: readinessScore, bodyBattery }, 1800);
    } catch {}
  }

  // Get today's training — first try training plans, then calendar fallback
  let todaySession: any = null;
  try {
    const { getActivePlan, getSessionsForWeek } = require('../../services/training-plans');
    const plan = getActivePlan(userId);
    const sessions = plan ? getSessionsForWeek(userId) : null;
    todaySession = sessions?.find((s: any) => s.isToday) || null;
  } catch {}

  // Calendar fallback
  if (!todaySession) {
    try {
      const today = new Date();
      const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);
      const { getEvents } = require('../../services/outlook-calendar');
      const events = await getEvents(startOfDay.toISOString(), endOfDay.toISOString());
      const keywords = ['run', 'gym', 'swim', 'bike', 'cycle', 'training', 'workout', 'strength'];
      const trainingEvent = (events || []).find((e: any) => {
        const title = (e.subject || e.summary || e.title || '').toLowerCase();
        return keywords.some(kw => title.includes(kw));
      });
      if (trainingEvent) {
        const title = trainingEvent.subject || trainingEvent.summary || trainingEvent.title;
        const startRaw = trainingEvent.start?.dateTime || trainingEvent.start;
        const timeMatch = String(startRaw).match(/T(\d{2}:\d{2})/);
        todaySession = { type: title, time: timeMatch ? timeMatch[1] : null, duration: null, status: 'planned' };
      }
    } catch {}
  }

  return {
    todaySession: todaySession ? {
      type: todaySession.type || todaySession.name,
      time: todaySession.time, duration: todaySession.duration, status: todaySession.status || 'planned',
    } : null,
    weeklyAdherence: null,
    readinessScore,
    bodyBattery,
  };
}

async function fetchContent(userId?: number) {
  try {
    const db = require('../../services/database').getDb();
    const counts = userId
      ? db.prepare(`SELECT stage, COUNT(*) as count FROM content_ideas WHERE status != 'archived' AND user_id = ? GROUP BY stage`).all(userId) as { stage: string; count: number }[]
      : db.prepare(`SELECT stage, COUNT(*) as count FROM content_ideas WHERE status != 'archived' GROUP BY stage`).all() as { stage: string; count: number }[];

    const pipelineCount = { ideas: 0, scripted: 0, filmed: 0, editing: 0, published: 0 };
    for (const row of counts) {
      const key = row.stage as keyof typeof pipelineCount;
      if (key in pipelineCount) pipelineCount[key] = row.count;
    }
    return { pipelineCount, nextDeadline: null };
  } catch {
    return { pipelineCount: { ideas: 0, scripted: 0, filmed: 0, editing: 0, published: 0 }, nextDeadline: null };
  }
}
