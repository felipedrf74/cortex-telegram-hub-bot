// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response, Request } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, sendInternalError } from '../response-helpers';
import {
  answerStep,
  getAllQuestionnaires,
  getPendingOnboardings,
  getProfile,
  getQuestionnaire,
  upsertProfileField,
  getMissingProfileFields,
  startOrResume,
  getActiveSession,
  isSyntheticSkippedOnboardingAnswer,
  OnboardingStepMismatchError,
} from '../../services/onboarding';
import { invalidateOnboardingDerivedCaches } from '../../services/cache-coherence-registry';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import { localizeOnboardingQuestionnaire } from '../../services/onboarding-localization';
import { normalizeSupportedLang, type Lang } from '../../utils/i18n';

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
function requestLanguage(req: Pick<Request, 'header'>): Lang {
  return normalizeSupportedLang(req.header?.('x-language'), 'en-US');
}

function questionnaireStepPayload(step: any, index: number) {
  return {
    index,
    field: step.key,
    question: step.prompt,
    type: step.type,
    options: step.options || null,
    optionLabels: step.optionLabels || null,
    min: step.min ?? null,
    max: step.max ?? null,
  };
}

function buildAthleteProfileDetail(userId: number, language: Lang) {
  const profiles = ATHLETE_PROFILE_TYPES.map((profileType) => {
    const definition = getQuestionnaire(profileType);
    if (!definition) return null;
    const questionnaire = localizeOnboardingQuestionnaire(definition, language);
    const profile = getProfile(userId, profileType);
    const data = profile?.data ?? {};

    const fields = questionnaire.steps.map((step) => {
      const answered = Object.prototype.hasOwnProperty.call(data, step.key)
        && !isSyntheticSkippedOnboardingAnswer(data[step.key]);
      return {
        key: step.key,
        prompt: step.prompt,
        type: step.type,
        options: normalizeProfileFieldOptions(step.options),
        optionLabels: normalizeProfileFieldOptions(step.optionLabels),
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
        const localized = localizeOnboardingQuestionnaire(def, requestLanguage(req));
        return {
          id: qId,
          title: localized.title || qId,
          description: localized.description || null,
          stepCount: def.steps?.length || 0,
          currentStep: 0,
          status: 'pending',
        };
      }).filter(Boolean);

      sendSuccess(res, { questionnaires });
    } catch (err: any) {
      logger.error(
        { event: 'onboarding', action: 'pending', outcome: 'degraded', err, userId },
        'iOS onboarding/pending failed',
      );
      sendSuccess(res, {
        questionnaires: [],
        status: 'degraded',
        warningCodes: ['ONBOARDING_PENDING_UNAVAILABLE'],
        warnings: ['Unable to load pending onboarding right now.'],
      });
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
      logger.error(
        { event: 'onboarding', action: 'profile', outcome: 'degraded', err, userId },
        'iOS profile fetch failed',
      );
      sendSuccess(res, {
        profiles: [],
        status: 'degraded',
        warningCodes: ['ONBOARDING_PROFILE_UNAVAILABLE'],
        warnings: ['Unable to load onboarding profiles right now.'],
      });
    }
  });

  /** GET /api/v1/onboarding/:questionnaireId */
  router.get('/:questionnaireId', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { questionnaireId } = req.params;

    try {
      const definition = getQuestionnaire(questionnaireId);

      if (!definition) {
        sendError(res, 'NOT_FOUND', 'Questionnaire not found', 404);
        return;
      }

      // Current iOS flow fetches the questionnaire first and only then
      // starts sending answers. Starting/resuming here keeps that flow
      // responsive without requiring a client-side `/start` call first.
      const session = startOrResume(userId, questionnaireId);
      const questionnaire = localizeOnboardingQuestionnaire(definition, requestLanguage(req));

      sendSuccess(res, {
        id: questionnaireId,
        title: questionnaire.title,
        steps: questionnaire.steps.map(questionnaireStepPayload),
        currentStep: session?.current_step || 0,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS onboarding questionnaire fetch failed');
      sendInternalError(res, 'Unable to load questionnaire right now.');
    }
  });

  /** POST /api/v1/onboarding/:questionnaireId/start */
  router.post('/:questionnaireId/start', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { questionnaireId } = req.params;

    try {
      const definition = getQuestionnaire(questionnaireId);
      if (!definition) {
        sendError(res, 'NOT_FOUND', 'Questionnaire not found', 404);
        return;
      }

      logger.info(
        { event: 'onboarding', action: 'start', outcome: 'requested', userId, questionnaireId, hasRequestBody: Boolean(req.body && Object.keys(req.body).length > 0) },
        'iOS onboarding start requested',
      );

      const session = startOrResume(userId, questionnaireId);
      const questionnaire = localizeOnboardingQuestionnaire(definition, requestLanguage(req));
      const payload = {
        id: questionnaireId,
        title: questionnaire.title,
        steps: questionnaire.steps.map(questionnaireStepPayload),
        currentStep: session.current_step,
      };

      logger.info(
        {
          event: 'onboarding',
          action: 'start',
          outcome: 'success',
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
      sendInternalError(res, 'Unable to start questionnaire right now.');
    }
  });

  /** POST /api/v1/onboarding/:questionnaireId/answer */
  router.post('/:questionnaireId/answer', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { questionnaireId } = req.params;
    const { stepIndex, answer, skip } = req.body;

    if (stepIndex === undefined || (skip !== true && answer === undefined)) {
      sendError(res, 'BAD_REQUEST', 'stepIndex and answer are required unless skip is true');
      return;
    }
    if (skip !== undefined && typeof skip !== 'boolean') {
      sendError(res, 'BAD_REQUEST', 'skip must be a boolean');
      return;
    }

    // Beta gap 3 (2026-04-24): treat `stepIndex` as optimistic-concurrency
    // control. The service layer uses it to suppress duplicate writes
    // on client retry and to surface a 409 if the client tries to skip
    // ahead. Before this, a flaky-network retry could advance the
    // server twice — writing the same answer to two different question
    // keys because the server silently re-derived the step from the
    // session row.
    const expectedStepIndex = typeof stepIndex === 'number'
      ? stepIndex
      : Number.parseInt(String(stepIndex), 10);

    try {
      const result = answerStep(userId, questionnaireId, answer, {
        expectedStepIndex: Number.isFinite(expectedStepIndex) ? expectedStepIndex : undefined,
        skip: skip === true,
      });
      if (!result.idempotentReplay) {
        invalidateOnboardingDerivedCaches(userId, questionnaireId);
      }

      const definition = getQuestionnaire(questionnaireId);
      const questionnaire = definition
        ? localizeOnboardingQuestionnaire(definition, requestLanguage(req))
        : null;
      const totalSteps = questionnaire?.steps?.length || 1;
      const advancedStep = result.session.current_step;
      const nextStep = questionnaire?.steps[advancedStep] ?? null;

      sendSuccess(res, {
        nextStep: nextStep ? questionnaireStepPayload(nextStep, advancedStep) : null,
        isComplete: !nextStep,
        progress: Math.min(1, advancedStep / totalSteps),
        currentStep: advancedStep,
        idempotentReplay: result.idempotentReplay === true,
        skipped: result.skipped === true,
      });
    } catch (err: any) {
      if (err instanceof OnboardingStepMismatchError) {
        logger.info(
          {
            userId,
            questionnaireId,
            clientStep: err.expectedStepIndex,
            serverStep: err.currentStepIndex,
          },
          'iOS onboarding answer rejected: step mismatch',
        );
        sendError(
          res,
          'STEP_MISMATCH',
          'Client step index is ahead of the server. Resync with GET /onboarding/:id/status.',
          409,
          { currentStep: err.currentStepIndex, clientStep: err.expectedStepIndex },
        );
        return;
      }
      logger.error({ err }, 'iOS onboarding answer failed');
      sendInternalError(res, 'Unable to save onboarding progress right now.');
    }
  });

  /**
   * GET /api/v1/onboarding/:questionnaireId/status
   *
   * Beta gap 3 (2026-04-24): read-only companion to GET /:questionnaireId,
   * which implicitly creates a session. iOS uses this on session restore
   * and after background wake to reconcile the client's cached step with
   * the server's view WITHOUT writing anything. Returns a typed state:
   *
   *   not_started — no session, no profile. iOS can safely start fresh.
   *   in_progress — active session. Returns currentStep for resume.
   *   completed   — profile row present. No further answers needed.
   *   unknown     — questionnaire id is not defined on this server.
   *
   * This is the preferred endpoint for "do I need to show the
   * onboarding wizard at launch?" — using GET /:questionnaireId (which
   * mutates) for that check races with other clients and can silently
   * wipe an in-progress session if misused.
   */
  router.get('/:questionnaireId/status', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { questionnaireId } = req.params;

    try {
      const questionnaire = getQuestionnaire(questionnaireId);
      if (!questionnaire) {
        sendSuccess(res, {
          questionnaireId,
          state: 'unknown' as const,
        });
        return;
      }

      const totalSteps = questionnaire.steps.length;
      const profile = getProfile(userId, questionnaireId);
      const session = getActiveSession(userId, questionnaireId);

      if (session) {
        sendSuccess(res, {
          questionnaireId,
          state: 'in_progress' as const,
          currentStep: session.current_step,
          totalSteps,
          answeredKeys: Object.keys(session.answers),
          hasProfile: Boolean(profile),
        });
        return;
      }

      if (profile) {
        sendSuccess(res, {
          questionnaireId,
          state: 'completed' as const,
          currentStep: totalSteps,
          totalSteps,
          profileUpdatedAt: profile.updated_at,
        });
        return;
      }

      sendSuccess(res, {
        questionnaireId,
        state: 'not_started' as const,
        currentStep: 0,
        totalSteps,
      });
    } catch (err: any) {
      logger.error({ err, userId, questionnaireId }, 'iOS onboarding status lookup failed');
      sendInternalError(res, 'Unable to load onboarding status right now.');
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
      const payload = buildAthleteProfileDetail(userId, requestLanguage(req));
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS onboarding/profile/detail failed');
      sendInternalError(res, 'Unable to load athlete profile right now.');
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
      invalidateOnboardingDerivedCaches(userId, profileType);
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
      sendInternalError(res, 'Unable to update the athlete profile right now.');
    }
  });

  return router;
}
