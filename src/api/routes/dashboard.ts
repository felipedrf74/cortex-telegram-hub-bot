// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { isBotPollingActive, getLastMessageAt } from '../../portal/telemetry';

export function dashboardRoutes(): Router {
  const router = Router();

  /**
   * GET /api/v1/dashboard
   * Aggregated dashboard data — single call for the home screen.
   */
  router.get('/', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;

    try {
      // Parallel fetch — each wrapped in try/catch for partial failure resilience
      const [calendar, tasks, training, content] = await Promise.all([
        fetchCalendar().catch(() => null),
        fetchTasks(userId).catch(() => null),
        fetchTraining(userId).catch(() => null),
        fetchContent().catch(() => null),
      ]);

      // Time-aware greeting
      const now = new Date();
      const hour = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: config.app.timezone }), 10);
      const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

      const startTime = (global as any).__startTime;
      const uptimeMs = startTime ? Date.now() - startTime : 0;
      const uptimeStr = uptimeMs > 86400000
        ? `${Math.floor(uptimeMs / 86400000)}d ${Math.floor((uptimeMs % 86400000) / 3600000)}h`
        : `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`;

      res.json({
        greeting: `${greeting}, Felipe`,
        date: now.toISOString().slice(0, 10),
        dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long', timeZone: config.app.timezone }),
        calendar,
        tasks,
        training,
        content,
        system: {
          version: process.env.npm_package_version || '4.8.11',
          uptime: uptimeStr,
          botStatus: isBotPollingActive() ? 'online' : 'offline',
          lastMessageAt: getLastMessageAt(),
        },
      });
    } catch (err: any) {
      logger.error({ err, platform: 'ios' }, 'Dashboard aggregation failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  return router;
}

// ── Data fetchers (each is independently failable) ──

async function fetchCalendar() {
  try {
    const today = new Date();
    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);

    const events: any[] = [];

    // Outlook Calendar
    try {
      const { getEvents } = require('../../services/outlook-calendar');
      const outlookEvents = await getEvents(startOfDay.toISOString(), endOfDay.toISOString());
      if (Array.isArray(outlookEvents)) {
        events.push(...outlookEvents.map((e: any) => ({
          id: e.id, title: e.subject || e.title || 'Untitled',
          start: e.start?.dateTime || e.start, end: e.end?.dateTime || e.end,
          source: 'outlook', category: e.categories?.[0] || null, color: null,
        })));
      }
    } catch { /* Outlook not configured */ }

    // Google Calendar
    try {
      const { getEvents } = require('../../services/google-calendar');
      const googleEvents = await getEvents(startOfDay.toISOString(), endOfDay.toISOString());
      if (Array.isArray(googleEvents)) {
        events.push(...googleEvents.map((e: any) => ({
          id: e.id, title: e.summary || e.title || 'Untitled',
          start: e.start?.dateTime || e.start, end: e.end?.dateTime || e.end,
          source: 'google', category: null, color: null,
        })));
      }
    } catch { /* Google not configured */ }

    return { today: events, upcoming: [] };
  } catch {
    return { today: [], upcoming: [] };
  }
}

async function fetchTasks(userId: number) {
  try {
    const todo = require('../../services/microsoft-todo');
    const allTasks = await todo.getAllPendingTasks();
    const tasks = allTasks?.data || allTasks || [];
    const now = new Date();

    const overdue = tasks.filter((t: any) => t.dueDateTime && new Date(t.dueDateTime.dateTime || t.dueDateTime) < now).length;
    const dueToday = tasks.filter((t: any) => {
      if (!t.dueDateTime) return false;
      const due = new Date(t.dueDateTime.dateTime || t.dueDateTime);
      return due.toDateString() === now.toDateString();
    }).length;

    const topTasks = tasks.slice(0, 5).map((t: any) => ({
      id: t.id, title: t.title, body: t.body?.content || null,
      importance: t.importance || 'normal', status: t.status || 'notStarted',
      dueDateTime: t.dueDateTime?.dateTime || t.dueDateTime || null,
      listId: null, listName: null, checklistItems: null, createdDateTime: t.createdDateTime || null,
    }));

    return { overdue, dueToday, totalPending: tasks.length, topTasks };
  } catch {
    return { overdue: 0, dueToday: 0, totalPending: 0, topTasks: [] };
  }
}

async function fetchTraining(userId: number) {
  try {
    const { getActivePlan, getSessionsForWeek } = require('../../services/training-plans');
    const plan = getActivePlan(userId);
    const sessions = plan ? getSessionsForWeek(userId) : null;
    const todaySession = sessions?.find((s: any) => s.isToday) || null;

    let readinessScore = null;
    let bodyBattery = null;
    try {
      const { calculateReadiness } = require('../../services/readiness-scorer');
      const readiness = await calculateReadiness(userId);
      readinessScore = readiness?.score || null;
      bodyBattery = readiness?.bodyBattery || null;
    } catch { /* Garmin not available */ }

    return {
      todaySession: todaySession ? {
        type: todaySession.type || todaySession.name,
        time: todaySession.time, duration: todaySession.duration, status: todaySession.status || 'planned',
      } : null,
      weeklyAdherence: sessions ? sessions.filter((s: any) => s.status === 'completed').length / sessions.length : null,
      readinessScore,
      bodyBattery,
    };
  } catch {
    return { todaySession: null, weeklyAdherence: null, readinessScore: null, bodyBattery: null };
  }
}

async function fetchContent() {
  try {
    const db = require('../../services/database').getDb();
    const counts = db.prepare(`
      SELECT stage, COUNT(*) as count FROM content_ideas
      WHERE status != 'archived'
      GROUP BY stage
    `).all() as { stage: string; count: number }[];

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
