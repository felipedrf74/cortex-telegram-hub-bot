// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';

export function trainingRoutes(): Router {
  const router = Router();

  /** GET /api/v1/training/today */
  router.get('/today', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      let session: any = null;
      let plan: any = null;

      // Try training plans service first
      try {
        const tp = require('../../services/training-plans');
        const activePlan = tp.getActivePlan(userId);
        if (activePlan) {
          plan = { name: activePlan.name, weekNumber: activePlan.currentWeek || 1, phase: activePlan.phase || null };
          const sessions = tp.getSessionsForWeek(userId);
          session = sessions?.find((s: any) => s.isToday) || null;
        }
      } catch { /* training plans not available */ }

      // Fallback: look for training events in today's calendar
      if (!session) {
        try {
          const today = new Date();
          const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
          const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);

          let calEvents: any[] = [];
          try {
            const { getEvents } = require('../../services/outlook-calendar');
            const events = await getEvents(startOfDay.toISOString(), endOfDay.toISOString());
            if (Array.isArray(events)) calEvents.push(...events);
          } catch {}
          try {
            const { getEvents } = require('../../services/google-calendar');
            const events = await getEvents(startOfDay.toISOString(), endOfDay.toISOString());
            if (Array.isArray(events)) calEvents.push(...events);
          } catch {}

          // Find training-like events
          const trainingKeywords = ['run', 'gym', 'swim', 'bike', 'cycle', 'training', 'workout', 'strength', 'hiit', 'yoga'];
          const trainingEvent = calEvents.find((e: any) => {
            const title = (e.subject || e.summary || e.title || '').toLowerCase();
            return trainingKeywords.some(kw => title.includes(kw));
          });

          if (trainingEvent) {
            const title = trainingEvent.subject || trainingEvent.summary || trainingEvent.title;
            const startRaw = trainingEvent.start?.dateTime || trainingEvent.start;
            const endRaw = trainingEvent.end?.dateTime || trainingEvent.end;
            let duration: number | null = null;
            try {
              const s = new Date(startRaw); const e = new Date(endRaw);
              duration = Math.round((e.getTime() - s.getTime()) / 60000);
            } catch {}
            const timeMatch = String(startRaw).match(/T(\d{2}:\d{2})/);
            session = {
              id: trainingEvent.id, type: title,
              time: timeMatch ? timeMatch[1] : null, duration, status: 'planned',
              notes: null, exercises: null,
            };
          }
        } catch {}
      }

      if (session) {
        session = {
          id: session.id || null, type: session.type || session.name || 'Workout',
          time: session.time || null, duration: session.duration || null,
          status: session.status || 'planned', notes: session.notes || null,
          exercises: session.exercises || null,
        };
      }

      res.json({ session, plan });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/today failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** GET /api/v1/training/week */
  router.get('/week', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      let weekNumber = 0;
      let sessions: any[] = [];
      let adherence = 0;

      try {
        const tp = require('../../services/training-plans');
        const plan = tp.getActivePlan(userId);
        if (plan) {
          weekNumber = plan.currentWeek || 1;
          const weekSessions = tp.getSessionsForWeek(userId);
          if (Array.isArray(weekSessions) && weekSessions.length > 0) {
            sessions = weekSessions.map((s: any) => ({
              day: s.day || s.dayOfWeek, type: s.type || s.name,
              time: s.time || null, status: s.status || 'planned',
            }));
          }
          const adh = tp.getWeeklyAdherence?.(userId);
          adherence = typeof adh === 'number' ? adh : adh?.adherenceRate || 0;
        }
      } catch {}

      // Fallback: build week from calendar if no training plan
      if (sessions.length === 0) {
        try {
          const today = new Date();
          const dayOfWeek = today.getDay(); // 0=Sun
          const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
          const monday = new Date(today); monday.setDate(today.getDate() + mondayOffset); monday.setHours(0,0,0,0);
          const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6); sunday.setHours(23,59,59,999);

          let calEvents: any[] = [];
          try {
            const { getEvents } = require('../../services/outlook-calendar');
            const events = await getEvents(monday.toISOString(), sunday.toISOString());
            if (Array.isArray(events)) calEvents.push(...events);
          } catch {}

          const trainingKeywords = ['run', 'gym', 'swim', 'bike', 'cycle', 'training', 'workout', 'strength', 'hiit', 'yoga'];
          const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

          // Group training events by day
          const dayMap = new Map<number, any>();
          for (const e of calEvents) {
            const title = (e.subject || e.summary || e.title || '').toLowerCase();
            if (!trainingKeywords.some(kw => title.includes(kw))) continue;
            const startRaw = e.start?.dateTime || e.start;
            const d = new Date(startRaw);
            const dayIdx = d.getDay();
            if (!dayMap.has(dayIdx)) {
              const timeMatch = String(startRaw).match(/T(\d{2}:\d{2})/);
              const isPast = d < today;
              dayMap.set(dayIdx, {
                day: dayNames[dayIdx],
                type: e.subject || e.summary || e.title || 'Workout',
                time: timeMatch ? timeMatch[1] : null,
                status: isPast ? 'completed' : 'planned',
              });
            }
          }

          // Fill all 7 days
          for (let i = 1; i <= 7; i++) {
            const dayIdx = i % 7; // Mon=1 ... Sun=0
            if (dayMap.has(dayIdx)) {
              sessions.push(dayMap.get(dayIdx));
            } else {
              sessions.push({ day: dayNames[dayIdx], type: 'Rest', time: null, status: 'rest' });
            }
          }

          const completed = sessions.filter(s => s.status === 'completed').length;
          const total = sessions.filter(s => s.status !== 'rest').length;
          adherence = total > 0 ? completed / total : 0;
        } catch {}
      }

      const completedCount = sessions.filter((s: any) => s.status === 'completed').length;

      res.json({
        weekNumber,
        sessions,
        adherence: typeof adherence === 'number' ? adherence : 0,
        completedCount,
        totalCount: sessions.filter((s: any) => s.status !== 'rest').length,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/week failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** GET /api/v1/training/readiness */
  router.get('/readiness', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      let score = 0;
      let factors: any = {};
      let recommendation: string | null = null;

      try {
        const { calculateReadiness } = require('../../services/readiness-scorer');
        const readiness = await calculateReadiness(userId);
        score = readiness?.score || 0;

        // Extract factors — handle various response shapes
        factors = {
          sleepScore: readiness?.sleepScore || readiness?.factors?.sleepScore || null,
          hrvStatus: readiness?.hrvStatus || readiness?.factors?.hrvStatus || null,
          bodyBattery: readiness?.bodyBattery || readiness?.factors?.bodyBattery || null,
          trainingLoad: readiness?.trainingLoad || readiness?.factors?.trainingLoad || null,
          restingHeartRate: readiness?.restingHeartRate || readiness?.factors?.restingHeartRate || null,
          stressLevel: readiness?.stressLevel || readiness?.factors?.stressLevel || null,
        };

        // Convert internal recommendation codes to human-readable text
        const rawRec = readiness?.recommendation || readiness?.action || '';
        recommendation = humanizeRecommendation(rawRec, score);
      } catch { /* readiness not available */ }

      // Try to get body battery directly from Garmin if not in readiness
      if (!factors.bodyBattery) {
        try {
          const garmin = require('../../services/garmin');
          const today = new Date().toISOString().slice(0, 10);
          const bb = await garmin.getBodyBattery?.(today);
          // Normalize: Garmin may return {current, morningPeak, score} or a number
          if (typeof bb === 'number') factors.bodyBattery = bb;
          else if (bb?.current !== undefined) factors.bodyBattery = bb.current;
          else if (bb?.charged !== undefined) factors.bodyBattery = bb.charged;
          else if (bb?.score !== undefined) factors.bodyBattery = bb.score;
        } catch {}
      }

      res.json({ score, factors, recommendation });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/readiness failed');
      res.json({ score: 0, factors: {}, recommendation: null });
    }
  });

  /** GET /api/v1/training/coach */
  router.get('/coach', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const { generateCoachBriefing } = require('../../services/garmin-coach');
      const briefing = await generateCoachBriefing(userId);

      res.json({
        briefing: briefing?.text || briefing?.briefing || 'No coach briefing available.',
        recommendations: briefing?.recommendations || [],
        garminData: briefing?.garminData || null,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/coach failed');
      res.json({ briefing: 'Coach briefing unavailable.', recommendations: [], garminData: null });
    }
  });

  /** POST /api/v1/training/complete */
  router.post('/complete', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { sessionId, notes, rpe } = req.body;

    try {
      const { completeSession, getWeeklyAdherence } = require('../../services/training-plans');
      await completeSession(userId, sessionId, { notes, rpe });
      const adherence = getWeeklyAdherence ? getWeeklyAdherence(userId) : null;
      const adherenceRate = typeof adherence === 'number' ? adherence : adherence?.adherenceRate || null;

      res.json({ completed: true, weeklyAdherence: adherenceRate });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/complete failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** POST /api/v1/training/coach/apply */
  router.post('/coach/apply', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { recommendationIds } = req.body;

    try {
      const { applyCoachRecommendations } = require('../../services/garmin-coach');
      const applied = await applyCoachRecommendations(userId, recommendationIds);
      res.json({ applied: applied?.count || 0, message: `Calendar updated with ${applied?.count || 0} recommendation(s).` });
    } catch {
      res.json({ applied: 0, message: 'Coach recommendations noted.' });
    }
  });

  return router;
}

/** Convert internal recommendation codes to user-friendly text */
function humanizeRecommendation(code: string, score: number): string {
  if (!code || code === 'null') {
    if (score >= 80) return 'Great recovery! Go hard today.';
    if (score >= 60) return 'Decent recovery. Train at moderate intensity.';
    if (score >= 40) return 'Recovery is below optimal. Consider a lighter session.';
    return 'Poor recovery. Rest or very light activity recommended.';
  }

  const codeMap: Record<string, string> = {
    'full_send': 'Excellent recovery — go all out today!',
    'normal': 'Good to train at normal intensity.',
    'reduce_10pct': 'Slightly fatigued — reduce intensity by ~10%.',
    'reduce_25pct': 'Below baseline — reduce volume by ~25% or swap for easy session.',
    'reduce_50pct': 'Significantly fatigued — halve the planned volume.',
    'rest': 'Your body needs rest today. Skip the workout.',
    'deload': 'Consider a deload — light movement only.',
  };

  return codeMap[code] || code.replace(/_/g, ' ');
}
