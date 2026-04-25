// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { acquireCostLock, buildQuotaExceededMessage, isUserOverDailyCap } from '../../services/cost-guardrail';
import { getUserLanguage } from '../../services/user-service';
import { logger } from '../../utils/logger';
import type { Lang } from '../../utils/i18n';
import {
  invalidScriptFormatMessage,
  normalizeScriptFormat,
  resolveScriptDurationPreset,
} from './content-script-utils';
import {
  buildScriptSuccessResponse,
  buildUserVoiceMemory,
  resolveScriptGenerationMode,
  resolveScriptRenderMode,
  resolveScriptStyle,
  resolveScriptTargetLanguage,
} from './content-script-route-utils';
import { resolveScriptTopicContext } from './content-topic-context';
import { getAllKnowledge } from '../../state/content-references';
import { getScript } from '../../services/content-engine';

type ResolveContentLanguage = (req: Pick<AuthenticatedRequest, 'header'>, userId: number) => Lang;
type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

export function registerContentScriptRoutes(
  router: Router,
  resolveContentLanguage: ResolveContentLanguage,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  /**
   * POST /api/v1/content/script — generate a structured script
   *
   * Uses the canonical script pipeline: content-engine Python backend
   * with deep research → Claude Sonnet → structured ScriptResponse.
   *
   * Body: {
   *   topic: string (required),
   *   niche?: string (default "general"),
   *   format?: "YouTube" | "Reel" (default "YouTube"),
   *   maxDurationMinutes?: number (default 8, range 1-30)
   * }
   *
   * Returns structured script data — iOS renders natively.
   *
   * NOTE: AI-using endpoint — script generation is a CONTENT GENERATION
   * operation, not a data lookup, so token cost is justified.
   */
  router.post('/script', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_script_generate')) return;

    const requestLanguage = resolveContentLanguage(req as AuthenticatedRequest, userId);
    const {
      topic,
      niche,
      format,
      maxDurationMinutes,
      targetDurationSeconds,
      mode,
      language,
      renderMode,
      scriptStyle,
      style,
    } = req.body;

    if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
      sendError(res, 'VALIDATION', 'topic is required', 400);
      return;
    }

    const normalizedFormat = normalizeScriptFormat(format);
    if (!normalizedFormat) {
      sendError(res, 'VALIDATION', invalidScriptFormatMessage(requestLanguage), 400);
      return;
    }

    const durationPreset = resolveScriptDurationPreset(
      normalizedFormat,
      maxDurationMinutes,
      targetDurationSeconds,
    );
    if ('error' in durationPreset) {
      sendError(res, 'VALIDATION', durationPreset.error, 400);
      return;
    }

    const genMode = resolveScriptGenerationMode(mode);
    const targetRenderMode = resolveScriptRenderMode(renderMode);
    const targetScriptStyle = resolveScriptStyle(scriptStyle ?? style);
    const startMs = Date.now();

    // TOCTOU-safe cost window — serialize check + AI + api_usage row
    // per user. See acquireCostLock docs in services/cost-guardrail.ts.
    const releaseCostLock = await acquireCostLock(userId);
    try {
      const quota = isUserOverDailyCap(userId);
      if (quota.over) {
        sendError(
          res,
          'QUOTA_EXCEEDED',
          buildQuotaExceededMessage(quota),
          402,
          { plan: quota.plan, resetAt: quota.resetAt },
        );
        return;
      }

      // CONT-M4: load the user's Voice DNA memory from content_knowledge
      // and pass it to the script engine so scripts reflect tone, structure,
      // phrases, and creator preferences instead of only topic research.
      let voiceMemory: string | null = null;
      try {
        voiceMemory = buildUserVoiceMemory(userId, getAllKnowledge);
      } catch { /* non-critical — generate without voice if DB fails */ }

      const scriptTopicContext = resolveScriptTopicContext(userId, req.body || {});
      const targetLanguage = resolveScriptTargetLanguage(language, userId, getUserLanguage);

      const result = await getScript(
        topic.trim(),
        scriptTopicContext?.niche || niche || 'general',
        durationPreset.maxDurationMinutes,
        normalizedFormat,
        genMode,
        voiceMemory,
        targetLanguage,
        targetRenderMode,
        userId,
        durationPreset.targetDurationSeconds,
        scriptTopicContext,
        targetScriptStyle,
      );
      const elapsedMs = Date.now() - startMs;
      const cacheHit = elapsedMs < 500;

      sendSuccess(res, buildScriptSuccessResponse({
        result,
        format: normalizedFormat,
        renderMode: targetRenderMode,
        scriptStyle: targetScriptStyle,
        generationMode: genMode,
        startMs,
        cacheHit,
      }));
    } catch (err: any) {
      logger.error({ err, topic }, 'iOS content/script failed');
      sendInternalError(res, 'Script generation failed');
    } finally {
      releaseCostLock();
    }
  }));
}
