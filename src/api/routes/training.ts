// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';

export function trainingRoutes(): Router {
  const router = Router();

  /** GET /api/v1/training/today */
  router.get('/today', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const { getActivePlan, getSessionsForWeek } = require('../../services/training-plans');
      const plan = getActivePlan(userId);
      const sessions = plan ? getSessionsForWeek(userId) : null;
      const todaySession = sessions?.find((s: any) => s.isToday) || null;

      res.json({
        session: todaySession ? {
          id: todaySession.id || null, type: todaySession.type || todaySession.name,
          time: todaySession.time || null, duration: todaySession.duration || null,
          status: todaySession.status || 'planned', notes: todaySession.notes || null,
          exercises: todaySession.exercises || null,
        } : null,
        plan: plan ? {
          name: plan.name, weekNumber: plan.currentWeek || 1, phase: plan.phase || null,
        } : null,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/today failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** GET /api/v1/training/week */
  router.get('/week', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const { getActivePlan, getSessionsForWeek, getWeeklyAdherence } = require('../../services/training-plans');
      const plan = getActivePlan(userId);
      const sessions = plan ? getSessionsForWeek(userId) : [];
      const adherence = getWeeklyAdherence ? getWeeklyAdherence(userId) : 0;

      const formatted = (sessions || []).map((s: any) => ({
        day: s.day || s.dayOfWeek, type: s.type || s.name,
        time: s.time || null, status: s.status || 'planned',
      }));

      const completedCount = formatted.filter((s: any) => s.status === 'completed').length;

      res.json({
        weekNumber: plan?.currentWeek || 1,
        sessions: formatted,
        adherence: adherence || (formatted.length > 0 ? completedCount / formatted.length : 0),
        completedCount,
        totalCount: formatted.length,
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
      const { calculateReadiness } = require('../../services/readiness-scorer');
      const readiness = await calculateReadiness(userId);

      res.json({
        score: readiness?.score || 0,
        factors: {
          sleepScore: readiness?.sleepScore || null,
          hrvStatus: readiness?.hrvStatus || null,
          bodyBattery: readiness?.bodyBattery || null,
          trainingLoad: readiness?.trainingLoad || null,
          restingHeartRate: readiness?.restingHeartRate || null,
          stressLevel: readiness?.stressLevel || null,
        },
        recommendation: readiness?.recommendation || null,
      });
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

      res.json({ completed: true, weeklyAdherence: adherence });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/complete failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** POST /api/v1/training/coach/apply — apply coach recommendations */
  router.post('/coach/apply', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { recommendationIds } = req.body; // array of IDs or "all"

    try {
      // Coach recommendations modify calendar events
      const { applyCoachRecommendations } = require('../../services/garmin-coach');
      const applied = await applyCoachRecommendations(userId, recommendationIds);

      res.json({
        applied: applied?.count || 0,
        message: `Calendar updated with ${applied?.count || 0} coach recommendation(s).`,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/coach/apply failed');
      // Graceful fallback — may not be implemented in garmin-coach yet
      res.json({ applied: 0, message: 'Coach recommendations noted. Calendar update not available yet.' });
    }
  });

  return router;
}
