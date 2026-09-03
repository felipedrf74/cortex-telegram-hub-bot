// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import {
  sendAiBudgetError,
  sendError,
  sendInternalError,
  sendSuccess,
} from '../response-helpers';
import type { Lang } from '../../utils/i18n';
import { logger } from '../../utils/logger';
import { assertTenantScope, TenantScopeError } from '../../services/tenant-scope';
import {
  ContentCreativeProposalError,
  generateContentCreativeProposal,
  type ContentCreativeOperation,
  type ContentCreativeProposalInput,
} from '../../services/content-creative-proposals';
import {
  ForwardedContentPolicyError,
  ForwardedLocalInferenceError,
} from '../../services/content-engine-error-contract';
import { ContentOutputLanguageMismatchError } from '../../services/content-output-language';
import {
  isSkillInferenceAccountDeletionError,
  runWithSkillInferenceAccountAdmission,
} from '../../services/skill-inference-service';
import { isProviderRequestCancellation } from '../../services/ai-provider';
import { bindContentRequestCancellation } from './content-request-cancellation';
import { buildGenerationMeta } from './content-generation-meta';
import { safeContentLogErrorFields } from '../../services/content-log-safety';

type ResolveContentLanguage = (req: Pick<AuthenticatedRequest, 'header'>, userId: number) => Lang;
type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

const CREATIVE_FORMATS = ['YouTube', 'Short', 'Reel', 'Carousel'] as const;
const TITLE_PLATFORMS = ['YouTube', 'Instagram'] as const;
const REPURPOSE_FORMATS = ['YouTube', 'Short', 'Reel', 'Carousel', 'Podcast', 'Article', 'Newsletter'] as const;

export function registerContentCreativeRoutes(
  router: Router,
  resolveContentLanguage: ResolveContentLanguage,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  for (const operation of ['hooks', 'titles', 'thumbnail', 'caption', 'repurpose'] as const) {
    router.post(`/creative/${operation}`, (req, res) => handleCreativeProposalRoute(
      operation,
      req,
      res,
      resolveContentLanguage,
      ensureValidContentRouteScope,
    ));
  }
}

async function handleCreativeProposalRoute(
  operation: ContentCreativeOperation,
  req: Request,
  res: Response,
  resolveContentLanguage: ResolveContentLanguage,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): Promise<void> {
  const authenticated = req as unknown as AuthenticatedRequest;
  if (!ensureValidContentRouteScope(res, authenticated.userId, `content_creative_${operation}`)) return;
  let scope: { tenantId: number; userId: number };
  try {
    scope = assertTenantScope(authenticated, `content_creative_${operation}`);
  } catch (error) {
    if (error instanceof TenantScopeError) {
      sendError(res, error.code, error.message, error.status);
      return;
    }
    throw error;
  }

  const startMs = Date.now();
  const requestLanguage = resolveContentLanguage(authenticated, scope.userId);
  const requestCancellation = bindContentRequestCancellation(req, res, `content_creative_${operation}`);
  try {
    const parsed = parseCreativeProposalInput(
      operation,
      req.body,
      scope,
      requestLanguage,
      requestCancellation.signal,
    );
    const result = await runWithSkillInferenceAccountAdmission({
      userId: scope.userId,
      abortSignal: requestCancellation.signal,
    }, async (abortSignal) => generateContentCreativeProposal({ ...parsed, abortSignal }));
    if (requestCancellation.signal.aborted) return;
    sendSuccess(res, {
      ...result,
      generation: buildGenerationMeta({
        mode: operation === 'repurpose' ? 'quick' : 'draft',
        startMs,
        provider: 'content-engine',
        providerSemantics: 'service_boundary',
        researchUsed: result.research.sourceContextUsed,
      }),
    });
  } catch (error) {
    if (requestCancellation.signal.aborted || isProviderRequestCancellation(error)) return;
    if (error instanceof ContentCreativeProposalError) {
      if (error.status === 503) res.setHeader('Retry-After', '60');
      sendError(res, error.code, error.message, error.status, error.details);
      return;
    }
    if (error instanceof ContentOutputLanguageMismatchError) {
      sendError(
        res,
        'CONTENT_CREATIVE_LOCALE_MISMATCH',
        requestLanguage === 'pt-BR'
          ? 'A proposta gerada foi retida porque não respeitou o idioma solicitado.'
          : requestLanguage === 'pt-PT'
            ? 'A proposta gerada foi retida porque não respeitou o idioma pedido.'
            : 'The generated proposal was withheld because it did not match the requested language.',
        502,
        { retryable: true },
      );
      return;
    }
    if (error instanceof ForwardedContentPolicyError
        || error instanceof ForwardedLocalInferenceError) {
      if (error.status === 429 || error.status === 503) res.setHeader('Retry-After', '60');
      sendError(res, error.code, error.publicMessage, error.status, error.details);
      return;
    }
    if (sendAiBudgetError(res, error)) return;
    if (isSkillInferenceAccountDeletionError(error)) {
      sendError(
        res,
        'ACCOUNT_DELETION_IN_PROGRESS',
        'No new Content proposal can start while this account is being deleted.',
        409,
      );
      return;
    }
    const candidate = error as { status?: unknown };
    logger.error({
      ...safeContentLogErrorFields(error),
      errorStatus: typeof candidate?.status === 'number' ? candidate.status : undefined,
      operation,
      userId: scope.userId,
      tenantId: scope.tenantId,
    }, 'Content creative proposal failed');
    sendInternalError(res, 'Content proposal generation is temporarily unavailable.', {
      code: 'CONTENT_CREATIVE_UNAVAILABLE',
      status: 503,
      details: { retryable: true },
    });
  } finally {
    requestCancellation.cleanup();
  }
}

export function parseCreativeProposalInput(
  operation: ContentCreativeOperation,
  value: unknown,
  scope: { tenantId: number; userId: number },
  language: Lang,
  abortSignal?: AbortSignal,
): ContentCreativeProposalInput {
  if (!isRecord(value)) {
    throw validationError('Request body must be an object.');
  }
  const body = value;
  if (Object.prototype.hasOwnProperty.call(body, 'sourceSummary')
      || Object.prototype.hasOwnProperty.call(body, 'source_summary')) {
    throw validationError('sourceSummary is server-authored and cannot be supplied by clients.');
  }
  const sourcePackageId = optionalArtifactId(body.sourcePackageId);
  const niche = optionalBoundedText(body.niche, 'niche', 160) ?? 'general';
  const shared = {
    operation,
    ...scope,
    language,
    niche,
    sourcePackageId,
    abortSignal,
  } as const;

  if (operation === 'thumbnail') {
    const title = requiredBoundedText(body.title, 'title', 2_000);
    const topic = optionalBoundedText(body.topic, 'topic', 2_000) ?? title;
    if (title.length + topic.length > 2_800) {
      throw validationError('thumbnail title and topic must be at most 2800 characters combined.');
    }
    return {
      ...shared,
      title,
      topic,
    };
  }

  const topic = requiredBoundedText(body.topic, 'topic', 2_000);
  if (operation === 'hooks') {
    return {
      ...shared,
      topic,
      count: optionalInteger(body.count, 'count', 1, 8) ?? 8,
      format: optionalEnum(body.format, 'format', CREATIVE_FORMATS) ?? 'YouTube',
    };
  }
  if (operation === 'titles') {
    return {
      ...shared,
      topic,
      count: optionalInteger(body.count, 'count', 1, 10) ?? 10,
      platform: optionalEnum(body.platform, 'platform', TITLE_PLATFORMS) ?? 'YouTube',
    };
  }
  if (operation === 'repurpose') {
    return {
      ...shared,
      topic,
      sourceContent: requiredBoundedText(
        body.sourceContent,
        'sourceContent',
        5_000,
        { allowFormattingWhitespace: true },
      ),
      originalFormat: optionalEnum(
        body.originalFormat,
        'originalFormat',
        REPURPOSE_FORMATS,
      ) ?? 'YouTube',
    };
  }
  return { ...shared, topic };
}

function requiredBoundedText(
  value: unknown,
  field: string,
  maxChars: number,
  options: { allowFormattingWhitespace?: boolean } = {},
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw validationError(`${field} must be a non-empty string.`);
  }
  const normalized = value.trim();
  const controlPattern = options.allowFormattingWhitespace
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u
    : /[\u0000-\u001F\u007F-\u009F]/u;
  if (controlPattern.test(normalized)) {
    throw validationError(`${field} contains unsupported control characters.`);
  }
  if (normalized.length > maxChars) {
    throw validationError(`${field} must be at most ${maxChars} characters.`);
  }
  return normalized;
}

function optionalBoundedText(value: unknown, field: string, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredBoundedText(value, field, maxChars);
}

function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw validationError(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw validationError(`${field} must be one of: ${values.join(', ')}.`);
  }
  return value as T;
}

function optionalArtifactId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.trim())) {
    throw validationError('sourcePackageId must be a valid Content artifact identifier.');
  }
  return value.trim();
}

function validationError(message: string): ContentCreativeProposalError {
  return new ContentCreativeProposalError('VALIDATION', message, 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
