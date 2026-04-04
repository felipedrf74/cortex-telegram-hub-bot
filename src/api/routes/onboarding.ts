// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';

export function onboardingRoutes(): Router {
  const router = Router();

  /** GET /api/v1/onboarding/pending */
  router.get('/pending', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    try {
      const onboarding = require('../../services/onboarding');
      const pending = onboarding.getPendingQuestionnaires(userId);

      res.json({
        questionnaires: (pending || []).map((q: any) => ({
          id: q.id, title: q.title, description: q.description || null,
          stepCount: q.steps?.length || 0, currentStep: q.currentStep || 0,
          status: q.status || 'pending',
        })),
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS onboarding/pending failed');
      res.json({ questionnaires: [] });
    }
  });

  /** GET /api/v1/onboarding/:questionnaireId */
  router.get('/:questionnaireId', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { questionnaireId } = req.params;

    try {
      const onboarding = require('../../services/onboarding');
      const questionnaire = onboarding.getQuestionnaire(questionnaireId);
      const session = onboarding.getSession(userId, questionnaireId);

      if (!questionnaire) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Questionnaire not found' } });
        return;
      }

      res.json({
        id: questionnaireId,
        title: questionnaire.title,
        steps: questionnaire.steps.map((s: any, i: number) => ({
          index: i, field: s.field, question: s.question, type: s.type,
          options: s.options || null, min: s.min ?? null, max: s.max ?? null,
        })),
        currentStep: session?.current_step || 0,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS onboarding questionnaire fetch failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** POST /api/v1/onboarding/:questionnaireId/answer */
  router.post('/:questionnaireId/answer', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { questionnaireId } = req.params;
    const { stepIndex, answer } = req.body;

    if (stepIndex === undefined || answer === undefined) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'stepIndex and answer are required' },
      });
      return;
    }

    try {
      const onboarding = require('../../services/onboarding');
      const result = onboarding.answerStep(userId, questionnaireId, answer);

      const questionnaire = onboarding.getQuestionnaire(questionnaireId);
      const totalSteps = questionnaire?.steps?.length || 1;

      res.json({
        nextStep: result.nextStep ? {
          index: result.nextStep.index ?? (stepIndex + 1),
          field: result.nextStep.field,
          question: result.nextStep.question,
          type: result.nextStep.type,
          options: result.nextStep.options || null,
          min: result.nextStep.min ?? null,
          max: result.nextStep.max ?? null,
        } : null,
        isComplete: !result.nextStep,
        progress: (stepIndex + 1) / totalSteps,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS onboarding answer failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** GET /api/v1/profile */
  router.get('/profile', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    try {
      const onboarding = require('../../services/onboarding');
      const allQuestionnaires = onboarding.getAllQuestionnaires?.() || [];
      const profiles = allQuestionnaires
        .map((q: any) => {
          const profile = onboarding.getProfile(userId, q.id);
          if (!profile) return null;
          return {
            type: q.id, data: profile.data || {},
            completedAt: profile.completed_at || null,
          };
        })
        .filter(Boolean);

      res.json({ profiles });
    } catch (err: any) {
      logger.error({ err }, 'iOS profile fetch failed');
      res.json({ profiles: [] });
    }
  });

  return router;
}
