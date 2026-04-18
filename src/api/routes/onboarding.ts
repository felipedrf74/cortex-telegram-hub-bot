// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError } from '../response-helpers';
import {
  answerStep,
  getAllQuestionnaires,
  getPendingOnboardings,
  getProfile,
  getQuestionnaire,
  upsertProfileField,
  getMissingProfileFields,
  startOrResume,
} from '../../services/onboarding';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';

// ─── Phase 3 Slice C — Profile detail helpers ────────────────────
//
// The set of profiles the iOS AthleteProfileView surfaces. Keeps it
// scoped to training — diet and homeschool live elsewhere and don't
// belong in the athlete profile screen.
const ATHLETE_PROFILE_TYPES = [
  'fitness',
  'triathlon-gym',
  'triathlon-running',
  'triathlon-cycling',
  'triathlon-swim',
] as const;

type AthleteProfileType = (typeof ATHLETE_PROFILE_TYPES)[number];

const ATHLETE_PROFILE_SET = new Set<string>(ATHLETE_PROFILE_TYPES);

function normalizeProfileFieldValue(value: unknown): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => normalizeProfileFieldValue(item))
      .filter((item): item is string => Boolean(item));
    return normalized.length > 0 ? normalized.join(', ') : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function normalizeProfileFieldOptions(options: unknown): string[] | null {
  if (!Array.isArray(options)) return null;
  const normalized = options
    .map((option) => normalizeProfileFieldValue(option))
    .filter((option): option is string => Boolean(option));
  return normalized.length > 0 ? normalized : null;
}

/**
 * Build the full detail response for the athlete profile screen.
 * For each profile: title, description, every field with its current
 * value (or null if unanswered) and its schema metadata so the iOS
 * edit sheet can render a type-appropriate input.
 */
function buildAthleteProfileDetail(userId: number) {
  const profiles = ATHLETE_PROFILE_TYPES.map((profileType) => {
    const questionnaire = getQuestionnaire(profileType);
    if (!questionnaire) return null;
    const profile = getProfile(userId, profileType);
    const data = profile?.data ?? {};

    const fields = questionnaire.steps.map((step) => {
      const answered = Object.prototype.hasOwnProperty.call(data, step.key);
      return {
        key: step.key,
        prompt: step.prompt,
        type: step.type,
        options: normalizeProfileFieldOptions(step.options),
        value: answered ? normalizeProfileFieldValue(data[step.key]) : null,
        answered,
      };
    });

    const completedFieldCount = fields.filter((f) => f.answered).length;
    const totalFieldCount = fields.length;

    return {
      type: profileType,
      title: questionnaire.title,
      description: questionnaire.description,
      fields,
      completedFieldCount,
      totalFieldCount,
      isComplete: completedFieldCount === totalFieldCount,
      updatedAt: profile?.updated_at ?? null,
    };
  }).filter((p): p is NonNullable<typeof p> => p !== null);

  const totalAnswered = profiles.reduce((sum, p) => sum + p.completedFieldCount, 0);
  const totalFields = profiles.reduce((sum, p) => sum + p.totalFieldCount, 0);

  return {
    profiles,
    summary: {
      totalAnswered,
      totalFields,
      allComplete: totalAnswered === totalFields && totalFields > 0,
    },
  };
}

export function onboardingRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'onboarding_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /** GET /api/v1/onboarding/pending */
  router.get('/pending', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    try {
      // getPendingOnboardings returns questionnaire IDs (strings),
      // not full objects. Resolve each to its definition.
      const pendingIds: string[] = getPendingOnboardings(userId) || [];
      const questionnaires = pendingIds.map((qId: string) => {
        const def = getQuestionnaire(qId);
        if (!def) return null;
        return {
          id: qId,
          title: def.title || qId,
          description: def.description || null,
          stepCount: def.steps?.length || 0,
          currentStep: 0,
          status: 'pending',
        };
      }).filter(Boolean);

      sendSuccess(res, { questionnaires });
    } catch (err: any) {
      logger.error({ err }, 'iOS onboarding/pending failed');
      sendSuccess(res, { questionnaires: [] });
    }
  });

  /** GET /api/v1/onboarding/:questionnaireId */
  router.get('/:questionnaireId', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { questionnaireId } = req.params;

    try {
      const questionnaire = getQuestionnaire(questionnaireId);

      if (!questionnaire) {
        sendError(res, 'NOT_FOUND', 'Questionnaire not found', 404);
        return;
      }

      // Current iOS flow fetches the questionnaire first and only then
      // starts sending answers. Starting/resuming here keeps that flow
      // responsive without requiring a client-side `/start` call first.
      const session = startOrResume(userId, questionnaireId);

      sendSuccess(res, {
        id: questionnaireId,
        title: questionnaire.title,
        steps: questionnaire.steps.map((s: any, i: number) => ({
          index: i,
          field: s.key,          // questionnaire uses 'key' not 'field'
          question: s.prompt,    // questionnaire uses 'prompt' not 'question'
          type: s.type,
          options: s.options || null,
          min: s.min ?? null,
          max: s.max ?? null,
        })),
        currentStep: session?.current_step || 0,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS onboarding questionnaire fetch failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch questionnaire', 500);
    }
  });

  /** POST /api/v1/onboarding/:questionnaireId/start */
  router.post('/:questionnaireId/start', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { questionnaireId } = req.params;

    try {
      const questionnaire = getQuestionnaire(questionnaireId);
      if (!questionnaire) {
        sendError(res, 'NOT_FOUND', 'Questionnaire not found', 404);
        return;
      }

      logger.info(
        { userId, questionnaireId, requestBody: req.body ?? null },
        'iOS onboarding start requested',
      );

      const session = startOrResume(userId, questionnaireId);
      const payload = {
        id: questionnaireId,
        title: questionnaire.title,
        steps: questionnaire.steps.map((s: any, i: number) => ({
          index: i,
          field: s.key,
          question: s.prompt,
          type: s.type,
          options: s.options || null,
          min: s.min ?? null,
          max: s.max ?? null,
        })),
        currentStep: session.current_step,
      };

      logger.info(
        {
          userId,
          questionnaireId,
          currentStep: payload.currentStep,
          stepCount: payload.steps.length,
        },
        'iOS onboarding start response ready',
      );

      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err, userId, questionnaireId }, 'iOS onboarding start failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to start questionnaire', 500);
    }
  });

  /** POST /api/v1/onboarding/:questionnaireId/answer */
  router.post('/:questionnaireId/answer', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { questionnaireId } = req.params;
    const { stepIndex, answer } = req.body;

    if (stepIndex === undefined || answer === undefined) {
      sendError(res, 'BAD_REQUEST', 'stepIndex and answer are required');
      return;
    }

    try {
      const result = answerStep(userId, questionnaireId, answer);

      const questionnaire = getQuestionnaire(questionnaireId);
      const totalSteps = questionnaire?.steps?.length || 1;

      sendSuccess(res, {
        nextStep: result.nextStep ? {
          index: stepIndex + 1,
          field: result.nextStep.key,       // questionnaire uses 'key' not 'field'
          question: result.nextStep.prompt,  // questionnaire uses 'prompt' not 'question'
          type: result.nextStep.type,
          options: result.nextStep.options || null,
          min: null,
          max: null,
        } : null,
        isComplete: !result.nextStep,
        progress: (stepIndex + 1) / totalSteps,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS onboarding answer failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to record answer', 500);
    }
  });

  /** GET /api/v1/onboarding/profile */
  router.get('/profile', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    try {
      const allQuestionnaires = getAllQuestionnaires() || [];
      const profiles = allQuestionnaires
        .map((q: any) => {
          const profile = getProfile(userId, q.id);
          if (!profile) return null;
          return {
            type: q.id, data: profile.data || {},
            completedAt: profile.updated_at || null,
          };
        })
        .filter(Boolean);

      sendSuccess(res, { profiles });
    } catch (err: any) {
      logger.error({ err }, 'iOS profile fetch failed');
      sendSuccess(res, { profiles: [] });
    }
  });

  /**
   * GET /api/v1/onboarding/profile/detail
   *
   * Phase 3 Slice C — full athlete profile view for iOS. Returns ALL
   * triathlon-umbrella profiles (fitness + 4 sport profiles) with:
   *   - title, description from the questionnaire
   *   - every field's schema metadata (prompt, type, options)
   *   - every field's current value (or null if unanswered)
   *   - per-profile progress (answered/total/isComplete)
   *   - a summary block with the user's overall progress
   *
   * The existing /profile endpoint only returns COMPLETED profiles —
   * it's for /pending triage. This endpoint is the read path for the
   * iOS profile view where the user wants to see what they answered
   * AND what they haven't, so they can tap in and fill the gaps.
   */
  router.get('/profile/detail', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    try {
      const payload = buildAthleteProfileDetail(userId);
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS onboarding/profile/detail failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to load profile detail', 500);
    }
  });

  /**
   * PATCH /api/v1/onboarding/profile/:type/field
   *
   * Phase 3 Slice C — edit a single athlete profile field without
   * going through the sequential questionnaire flow. Used by the iOS
   * profile view's inline edit sheet. Write path mirrors the chat
   * onboarding tool (`save_athlete_profile_field`) — same upsert,
   * same validation, same response shape.
   *
   * URL: /profile/:type/field
   * Body: { fieldKey: string, value: string }
   *
   * 400 on:
   *   - profile type not in the triathlon umbrella
   *   - field key not defined in the questionnaire
   *   - value fails the step's regex validation (e.g. pace "6:00")
   *   - missing body fields
   * 404 on:
   *   - profile type valid but questionnaire not found (shouldn't happen)
   */
  router.patch('/profile/:type/field', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const profileType = String(req.params.type ?? '');
    const { fieldKey, value } = (req.body ?? {}) as { fieldKey?: unknown; value?: unknown };

    // Whitelist the profile type — prevents PATCHing into `diet`
    // or `homeschool` via this route.
    if (!ATHLETE_PROFILE_SET.has(profileType)) {
      sendError(
        res,
        'BAD_REQUEST',
        `profile type "${profileType}" is not an athlete profile`,
        400,
      );
      return;
    }

    if (typeof fieldKey !== 'string' || fieldKey.length === 0) {
      sendError(res, 'BAD_REQUEST', 'fieldKey (string) is required');
      return;
    }
    if (typeof value !== 'string') {
      sendError(res, 'BAD_REQUEST', 'value (string) is required');
      return;
    }

    const questionnaire = getQuestionnaire(profileType);
    if (!questionnaire) {
      sendError(res, 'NOT_FOUND', `Questionnaire ${profileType} not defined`, 404);
      return;
    }

    const step = questionnaire.steps.find((s) => s.key === fieldKey);
    if (!step) {
      sendError(
        res,
        'BAD_REQUEST',
        `fieldKey "${fieldKey}" is not a step in questionnaire "${profileType}"`,
        400,
      );
      return;
    }

    // Enforce the step's format regex (e.g. pace "mm:ss") so the
    // PATCH path has the same correctness guarantees as the chat
    // tool-call path.
    if (step.validation && !step.validation.test(value)) {
      sendError(
        res,
        'BAD_REQUEST',
        `value "${value}" does not match the expected format for ${fieldKey}`,
        400,
      );
      return;
    }

    try {
      upsertProfileField(userId, profileType, fieldKey, value);
      const remaining = getMissingProfileFields(userId, profileType);
      sendSuccess(res, {
        profileType,
        fieldKey,
        value,
        remainingFields: remaining.map((s) => s.key),
        profileComplete: remaining.length === 0,
      });
    } catch (err: any) {
      logger.error({ err, userId, profileType, fieldKey }, 'PATCH profile field failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to update profile field', 500);
    }
  });

  return router;
}
