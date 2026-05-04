// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Admin write surface for the Content portal — POST/PUT/DELETE routes.
//
// The content-dashboard.ts file (949 LOC, GET-only) returns the read
// view. THIS file adds the mutation endpoints that make the portal a
// control center instead of a read-only dashboard.
//
// Auth: this router applies the shared portal scoped-token middleware.
// Read routes can use a portal read or full-access token; mutating routes
// require a portal write or full-access token.
//
// Mount: /api/v1/admin/content (sibling to /api/v1/admin/content-dashboard)

import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { getDb } from '../../services/database';
import { sendInternalError as sendApiInternalError } from '../response-helpers';
import { requirePortalTokenByMethod } from '../secret-guards';
import {
  contentDirectScopePredicate,
  contentScopePredicate,
  contentScopeForInsert,
  contentScopeParams,
  ensureContentTenantScopeColumns,
} from '../../services/content-tenant-scope';
import {
  listContentOutputProvenance,
  listContentSourceOutputLinks,
} from '../../services/content-reference-provenance';
import {
  assessContentNovelty,
  buildContentNoveltyConstraintLines,
  listContentReuseHistory,
  listContentReuseLineage,
  recordContentNoveltyCandidate,
} from '../../services/content-novelty-reuse';
// CONTENT-UI-O3: portal performance dashboard
import { getContentPerformanceAggregate } from '../../state/content-performance-aggregate';
// CONTENT-UI-O4: portal canonical lifecycle alias
import { summarizeCanonicalLifecycle } from '../../state/content-lifecycle';

function sendSuccess(res: Response, data: Record<string, unknown> = {}): void {
  res.json({ ok: true, ...data });
}

function sendError(res: Response, code: string, message: string, status = 400): void {
  res.status(status).json({ ok: false, error: { code, message } });
}

function sendInternalError(res: Response, message: string): void {
  sendApiInternalError(res, message);
}

function parsePositiveInt(value: unknown): number | undefined {
  if (Array.isArray(value)) value = value[0];
  if (value == null || value === '') return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function firstValue(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function resolvePortalContentScope(req: Request, res: Response, required = false): {
  scoped: boolean;
  userId: number;
  tenantId: number;
} | null {
  const userId = parsePositiveInt(firstValue(
    req.body?.userId,
    req.body?.ownerUserId,
    req.query.userId,
    req.query.ownerUserId,
    req.headers['x-nexus-user-id'],
    req.headers['x-nexus-owner-user-id'],
  ));
  const rawTenant = parsePositiveInt(firstValue(
    req.body?.tenantId,
    req.query.tenantId,
    req.headers['x-nexus-tenant-id'],
  ));

  if (!userId) {
    if (required) {
      sendError(res, 'BAD_REQUEST', 'userId is required for tenant-scoped Content portal writes');
      return null;
    }
    return { scoped: false, userId: 0, tenantId: 0 };
  }

  return {
    scoped: true,
    userId,
    tenantId: rawTenant ?? userId,
  };
}

function normalizeString(value: unknown, max = 512): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function normalizeStringList(value: unknown, maxItems = 25): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeString(typeof item === 'number' ? String(item) : item, 256))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
}

function parseBoolean(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
  if (typeof value === 'number') return value === 1;
  return false;
}

function parseLimit(value: unknown, fallback = 50, max = 100): number {
  const parsed = parsePositiveInt(value);
  return Math.min(Math.max(parsed ?? fallback, 1), max);
}

function buildPortalHistoricalComparisonHints(decision: ReturnType<typeof assessContentNovelty>): string[] {
  const hints = buildContentNoveltyConstraintLines(decision);
  if (decision.status === 'duplicate' || decision.status === 'near_duplicate') {
    hints.push('Portal action: request a new angle before approval or scheduling.');
  }
  if (decision.status === 'allowed_reuse' || decision.status === 'series_related') {
    hints.push('Portal action: show reuse lineage and preserve source/provenance in the derived artifact.');
  }
  if (decision.reviewWarnings.length > 0) {
    hints.push('Portal action: require human review before tenant-shared publishing or scheduling.');
  }
  return hints;
}

// ─── Route factory ──────────────────────────────────────────────────

export function contentAdminWriteRoutes(): Router {
  const router = Router();
  router.use(requirePortalTokenByMethod);

  // ═══════════════════════════════════════════════════════════════════
  // LINKS — Tenant-scoped reference links for portal power-console work
  // ═══════════════════════════════════════════════════════════════════

  /** GET /links?userId=&tenantId= — list scoped reference links */
  router.get('/links', (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    try {
      const rows = getDb().prepare(`
        SELECT id, title, url, author_source, extraction_status, trust_level,
               quality_score, confidence_score, broken_status, stale_status,
               topic_tags_json, updated_at
          FROM content_reference_registry
         WHERE reference_type = 'link'
           AND ${contentDirectScopePredicate()}
         ORDER BY updated_at DESC, id DESC
         LIMIT 100
      `).all(...contentScopeParams(scope.userId, scope.tenantId));
      sendSuccess(res, { links: rows, scope });
    } catch (err: any) {
      logger.error({ err }, 'Portal: list content links failed');
      sendInternalError(res, 'Failed to list links');
    }
  });

  /** POST /links — upsert a tenant-scoped reference link */
  router.post('/links', (req: Request, res: Response) => {
    const scopeTarget = resolvePortalContentScope(req, res, true);
    if (!scopeTarget) return;
    const title = normalizeString(req.body?.title);
    const url = normalizeString(req.body?.url, 2048);
    if (!title || !url) return sendError(res, 'BAD_REQUEST', 'title and url are required');

    try {
      const db = getDb();
      const scope = contentScopeForInsert(scopeTarget.userId, scopeTarget.tenantId, 'user_private', 'active');
      const result = db.prepare(`
        INSERT INTO content_reference_registry (
          tenant_id, owner_user_id, visibility_scope, scope_status, reference_type,
          source_table, source_pk, source_identifier, title, url, author_source,
          extraction_status, freshness_score, trust_level, quality_score, confidence_score,
          topic_tags_json, related_output_ids_json, broken_status, stale_status,
          source_summary, source_snippets_json, source_metadata_json,
          created_by, updated_by, audit_metadata_json
        )
        VALUES (?, ?, ?, ?, 'link', 'content_reference_links', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, '[]', ?, ?, ?, ?)
        ON CONFLICT(tenant_id, owner_user_id, reference_type, source_identifier) DO UPDATE SET
          title = excluded.title,
          url = excluded.url,
          author_source = excluded.author_source,
          extraction_status = excluded.extraction_status,
          trust_level = excluded.trust_level,
          quality_score = excluded.quality_score,
          confidence_score = excluded.confidence_score,
          topic_tags_json = excluded.topic_tags_json,
          broken_status = excluded.broken_status,
          stale_status = excluded.stale_status,
          source_summary = excluded.source_summary,
          source_metadata_json = excluded.source_metadata_json,
          updated_by = excluded.updated_by,
          updated_at = datetime('now')
      `).run(
        scope.tenantId,
        scope.ownerUserId,
        scope.visibilityScope,
        scope.scopeStatus,
        url,
        title,
        url,
        normalizeString(req.body?.authorSource) ?? null,
        normalizeString(req.body?.extractionStatus, 64) ?? 'pending_review',
        Number(req.body?.freshnessScore ?? 0.7),
        normalizeString(req.body?.trustLevel, 64) ?? 'unverified',
        Number(req.body?.qualityScore ?? 0.5),
        Number(req.body?.confidenceScore ?? 0.5),
        JSON.stringify(Array.isArray(req.body?.topicTags) ? req.body.topicTags.slice(0, 20) : []),
        normalizeString(req.body?.brokenStatus, 64) ?? 'unknown',
        normalizeString(req.body?.staleStatus, 64) ?? 'unknown',
        normalizeString(req.body?.sourceSummary, 2000) ?? null,
        JSON.stringify(req.body?.sourceMetadata && typeof req.body.sourceMetadata === 'object' ? req.body.sourceMetadata : {}),
        scope.createdBy,
        scope.updatedBy,
        scope.auditMetadataJson,
      );
      sendSuccess(res, { id: result.lastInsertRowid, scope: scopeTarget, created: true });
    } catch (err: any) {
      logger.error({ err }, 'Portal: upsert content link failed');
      sendInternalError(res, 'Failed to upsert link');
    }
  });

  /** DELETE /links/:id?userId=&tenantId= — delete one scoped reference link */
  router.delete('/links/:id', (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid link id');
    try {
      const info = getDb().prepare(`
        DELETE FROM content_reference_registry
         WHERE id = ?
           AND reference_type = 'link'
           AND ${contentDirectScopePredicate()}
      `).run(id, ...contentScopeParams(scope.userId, scope.tenantId));
      if (info.changes === 0) return sendError(res, 'NOT_FOUND', 'Link not found in requested scope', 404);
      sendSuccess(res, { removed: true, scope });
    } catch (err: any) {
      logger.error({ err }, 'Portal: delete content link failed');
      sendInternalError(res, 'Failed to delete link');
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // PROVENANCE / REUSE — Portal-grade review contracts
  // ═══════════════════════════════════════════════════════════════════

  /** GET /provenance?userId=&tenantId=&objectType=&objectId= — inspect scoped output provenance */
  router.get('/provenance', (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    const outputObjectType = normalizeString(firstValue(req.query.outputObjectType, req.query.objectType), 80) ?? undefined;
    const outputId = normalizeString(firstValue(req.query.outputId, req.query.objectId), 160) ?? undefined;
    const limit = parseLimit(req.query.limit, outputObjectType && outputId ? 10 : 50, 100);
    try {
      const provenance = listContentOutputProvenance({
        userId: scope.userId,
        tenantId: scope.tenantId,
        outputObjectType,
        outputId,
        limit,
      });
      sendSuccess(res, { provenance, scope });
    } catch (err: any) {
      logger.error({ err }, 'Portal: list content provenance failed');
      sendInternalError(res, 'Failed to list provenance');
    }
  });

  /** GET /provenance/review-pack?userId=&tenantId=&objectType=&objectId= — deep portal panel payload */
  router.get('/provenance/review-pack', (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    const outputObjectType = normalizeString(firstValue(req.query.outputObjectType, req.query.objectType), 80);
    const outputId = normalizeString(firstValue(req.query.outputId, req.query.objectId), 160);
    if (!outputObjectType || !outputId) {
      return sendError(res, 'BAD_REQUEST', 'objectType and objectId are required for provenance review packs');
    }
    try {
      const provenance = listContentOutputProvenance({
        userId: scope.userId,
        tenantId: scope.tenantId,
        outputObjectType,
        outputId,
        limit: 10,
      });
      const sourceLinks = listContentSourceOutputLinks({
        userId: scope.userId,
        tenantId: scope.tenantId,
        outputObjectType,
        outputId,
        limit: 100,
      });
      const reuseLineage = listContentReuseLineage({
        userId: scope.userId,
        tenantId: scope.tenantId,
        contentId: outputId,
        limit: 50,
      });
      sendSuccess(res, {
        reviewPack: {
          objectType: outputObjectType,
          objectId: outputId,
          provenance,
          sourceLinks,
          reuseLineage,
          requiresHumanReview: provenance.some((item) => item.reviewRequired)
            || provenance.some((item) => item.groundingStatus !== 'grounded')
            || reuseLineage.some((item) => item.reasonCodes.length > 0),
        },
        scope,
      });
    } catch (err: any) {
      logger.error({ err }, 'Portal: build content provenance review pack failed');
      sendInternalError(res, 'Failed to build provenance review pack');
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // PERFORMANCE — Tenant-scoped Content Performance aggregate (CONTENT-UI-O3)
  // ═══════════════════════════════════════════════════════════════════

  /** GET /performance?userId=&tenantId= — read aggregate performance metrics */
  router.get('/performance', (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    try {
      const aggregate = getContentPerformanceAggregate(scope.userId, scope.tenantId);
      sendSuccess(res, { performance: aggregate, scope });
    } catch (err: any) {
      logger.error({ err }, 'Portal: get content performance aggregate failed');
      sendInternalError(res, 'Failed to read performance aggregate');
    }
  });

  /** GET /lifecycle?userId=&tenantId= — canonical 12-bucket lifecycle (CONTENT-UI-O4) */
  router.get('/lifecycle', (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    try {
      const lifecycle = summarizeCanonicalLifecycle(scope.userId, scope.tenantId);
      sendSuccess(res, { lifecycle, scope });
    } catch (err: any) {
      logger.error({ err }, 'Portal: get content canonical lifecycle failed');
      sendInternalError(res, 'Failed to read canonical lifecycle');
    }
  });

  /** GET /reuse-history?userId=&tenantId=&objectId= — inspect scoped repurpose lineage */
  router.get('/reuse-history', (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    const objectId = normalizeString(firstValue(req.query.objectId, req.query.contentId, req.query.originalContentId), 160) ?? undefined;
    const limit = parseLimit(req.query.limit, 50, 100);
    try {
      const reuseHistory = objectId
        ? listContentReuseLineage({ userId: scope.userId, tenantId: scope.tenantId, contentId: objectId, limit })
        : listContentReuseHistory({ userId: scope.userId, tenantId: scope.tenantId, limit });
      sendSuccess(res, { reuseHistory, scope });
    } catch (err: any) {
      logger.error({ err }, 'Portal: list content reuse history failed');
      sendInternalError(res, 'Failed to list reuse history');
    }
  });

  /** POST /historical-comparison — compare a candidate against scoped history without provider calls */
  router.post('/historical-comparison', (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    const artifactType = normalizeString(req.body?.artifactType, 80) ?? 'idea';
    const title = normalizeString(req.body?.title, 512);
    const body = normalizeString(req.body?.body, 6000);
    const hook = normalizeString(req.body?.hook, 512);
    const caption = normalizeString(req.body?.caption, 2000);
    const topic = normalizeString(req.body?.topic, 512);
    const angle = normalizeString(req.body?.angle, 512);
    if (![title, body, hook, caption, topic, angle].some(Boolean)) {
      return sendError(res, 'BAD_REQUEST', 'At least one candidate field is required: title, body, hook, caption, topic, or angle');
    }

    try {
      const candidate = {
        userId: scope.userId,
        tenantId: scope.tenantId,
        visibilityScope: normalizeString(req.body?.visibilityScope, 64) as any,
        candidateId: normalizeString(req.body?.candidateId, 160) ?? undefined,
        artifactType,
        title,
        body,
        hook,
        caption,
        topic,
        angle,
        platformId: normalizeString(req.body?.platformId, 80),
        formatId: normalizeString(req.body?.formatId, 80),
        audience: normalizeString(req.body?.audience, 512),
        contentPillar: normalizeString(req.body?.contentPillar, 512),
        referenceIds: normalizeStringList(req.body?.referenceIds, 50),
        sourceRadarSignalId: normalizeString(req.body?.sourceRadarSignalId, 160),
        seriesId: normalizeString(req.body?.seriesId, 160),
        reuseIntent: normalizeString(req.body?.reuseIntent, 80),
        originalContentId: normalizeString(req.body?.originalContentId, 160),
        transformationType: normalizeString(req.body?.transformationType, 80),
        allowStrategicReuse: parseBoolean(req.body?.allowStrategicReuse),
        lifecycleState: normalizeString(req.body?.lifecycleState, 64) ?? 'portal_review',
        createdBy: scope.userId,
        metadata: {
          source: 'portal_historical_comparison',
          recordCandidate: parseBoolean(req.body?.recordCandidate),
        },
      };
      const decision = assessContentNovelty(candidate);
      const recordedCandidate = parseBoolean(req.body?.recordCandidate)
        ? recordContentNoveltyCandidate(candidate, decision)
        : null;
      sendSuccess(res, {
        comparison: {
          candidate: {
            artifactType,
            title,
            topic,
            hook,
            platformId: candidate.platformId,
            formatId: candidate.formatId,
            reuseIntent: candidate.reuseIntent,
            originalContentId: candidate.originalContentId,
          },
          decision,
          constraintLines: buildContentNoveltyConstraintLines(decision),
          portalHints: buildPortalHistoricalComparisonHints(decision),
          recordedCandidate,
        },
        scope,
      });
    } catch (err: any) {
      logger.error({ err }, 'Portal: historical content comparison failed');
      sendInternalError(res, 'Failed to compare candidate against historical content');
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // CHANNELS — YouTube reference channels
  // ═══════════════════════════════════════════════════════════════════

  /** POST /channels — add a new channel and start analysis */
  router.post('/channels', async (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    const { url, addedVia } = req.body;
    if (!url || typeof url !== 'string') {
      return sendError(res, 'BAD_REQUEST', 'url is required');
    }
    try {
      const { addAndAnalyzeChannel } = await import('../../services/channel-learner');
      const result = await addAndAnalyzeChannel(url.trim(), addedVia || 'portal', scope.userId, scope.tenantId);
      sendSuccess(res, {
        channel: { id: result.channel.id, name: result.channel.channel_name },
        analysis: {
          success: result.analysis.success,
          patternsFound: result.analysis.patternsFound,
          videosAnalyzed: result.analysis.videosAnalyzed,
          error: result.analysis.error,
        },
      });
    } catch (err: any) {
      logger.error({ err }, 'Portal: add channel failed');
      sendInternalError(res, 'Failed to add channel');
    }
  });

  /** DELETE /channels/:id — remove a channel */
  router.delete('/channels/:id', (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid channel id');
    try {
      const db = getDb();
      ensureContentTenantScopeColumns(db);
      db.prepare(`
        DELETE FROM content_patterns
         WHERE channel_id = ?
           AND ${contentScopePredicate()}
      `).run(id, ...contentScopeParams(scope.userId, scope.tenantId));
      const info = db.prepare(`
        DELETE FROM content_ref_channels
         WHERE id = ?
           AND ${contentScopePredicate()}
      `).run(id, ...contentScopeParams(scope.userId, scope.tenantId));
      if (info.changes === 0) return sendError(res, 'NOT_FOUND', 'Channel not found in requested scope', 404);
      sendSuccess(res, { removed: true, scope });
    } catch (err: any) {
      logger.error({ err }, 'Portal: remove channel failed');
      sendInternalError(res, 'Failed to remove channel');
    }
  });

  /** POST /channels/:id/reanalyze — trigger re-analysis of one channel */
  router.post('/channels/:id/reanalyze', async (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid channel id');
    try {
      const db = getDb();
      ensureContentTenantScopeColumns(db);
      const channel = db.prepare(`
        SELECT id FROM content_ref_channels
         WHERE id = ?
           AND ${contentScopePredicate()}
      `).get(id, ...contentScopeParams(scope.userId, scope.tenantId));
      if (!channel) return sendError(res, 'NOT_FOUND', 'Channel not found in requested scope', 404);
      const { analyzeChannel } = await import('../../services/channel-learner');
      const result = await analyzeChannel(id);
      sendSuccess(res, { analysis: result });
    } catch (err: any) {
      logger.error({ err }, 'Portal: reanalyze channel failed');
      sendInternalError(res, 'Failed to reanalyze');
    }
  });

  /** POST /channels/relearn — trigger full processAllChannels (on-demand) */
  router.post('/channels/relearn', async (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    if (scope.tenantId !== scope.userId) {
      return sendError(
        res,
        'UNSUPPORTED_SCOPE',
        'Scoped channel relearn currently supports user-default tenant only; use per-channel reanalyze for tenant-specific channels',
        409,
      );
    }
    try {
      const { processAllChannelScopes } = await import('../../services/channel-learner');
      const { processAllChannels } = await import('../../services/channel-learner');
      const result = scope.userId > 0
        ? await processAllChannels(true, scope.userId)
        : await processAllChannelScopes(true); // force=true skips stale threshold
      sendSuccess(res, { result });
    } catch (err: any) {
      logger.error({ err }, 'Portal: channel relearn failed');
      sendInternalError(res, 'Failed to run channel relearn');
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // BOOKS — Book library management
  // ═══════════════════════════════════════════════════════════════════

  /** POST /books — add a book and start extraction */
  router.post('/books', async (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    const { title, author } = req.body;
    if (!title || !author) {
      return sendError(res, 'BAD_REQUEST', 'title and author are required');
    }
    try {
      const { handleAddBookFromPortal } = await import('../../commands/books');
      const result = await handleAddBookFromPortal(title.trim(), author.trim(), scope);
      if (result.ok) {
        sendSuccess(res, { message: result.message, scope });
      } else {
        sendError(res, 'EXTRACTION_FAILED', result.message, 500);
      }
    } catch (err: any) {
      logger.error({ err }, 'Portal: add book failed');
      sendInternalError(res, 'Failed to add book');
    }
  });

  /** DELETE /books/:id — remove a book from the library */
  router.delete('/books/:id', (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid book id');
    try {
      const db = getDb();
      ensureContentTenantScopeColumns(db);
      const info = db.prepare(`
        DELETE FROM book_library
         WHERE id = ?
           AND ${contentScopePredicate()}
      `).run(id, ...contentScopeParams(scope.userId, scope.tenantId));
      if (info.changes === 0) return sendError(res, 'NOT_FOUND', 'Book not found in requested scope', 404);
      sendSuccess(res, { removed: true, scope });
    } catch (err: any) {
      logger.error({ err }, 'Portal: delete book failed');
      sendInternalError(res, 'Failed to delete book');
    }
  });

  /** POST /books/:id/retry — retry a failed book extraction */
  router.post('/books/:id/retry', async (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid book id');
    try {
      const db = getDb();
      ensureContentTenantScopeColumns(db);
      const book = db.prepare(`
        SELECT title, author FROM book_library
         WHERE id = ?
           AND ${contentScopePredicate()}
      `).get(id, ...contentScopeParams(scope.userId, scope.tenantId)) as
        { title: string; author: string } | undefined;
      if (!book) return sendError(res, 'NOT_FOUND', 'Book not found in requested scope', 404);

      // Reset to pending then re-extract
      db.prepare(`
        UPDATE book_library
           SET extraction_status = 'pending',
               updated_at = datetime('now')
         WHERE id = ?
           AND ${contentScopePredicate()}
      `).run(id, ...contentScopeParams(scope.userId, scope.tenantId));
      const { handleAddBookFromPortal } = await import('../../commands/books');
      const result = await handleAddBookFromPortal(book.title, book.author, scope);
      sendSuccess(res, { retried: true, message: result.message, scope });
    } catch (err: any) {
      logger.error({ err }, 'Portal: retry book extraction failed');
      sendInternalError(res, 'Failed to retry extraction');
    }
  });

  /** PATCH /books/:id/notes — update personal notes for a book */
  router.patch('/books/:id/notes', (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid book id');
    const { notes } = req.body;
    if (notes === undefined) return sendError(res, 'BAD_REQUEST', 'notes field is required');
    try {
      const db = getDb();
      ensureContentTenantScopeColumns(db);
      const info = db.prepare(`
        UPDATE book_library
           SET personal_notes = ?,
               updated_at = datetime('now')
         WHERE id = ?
           AND ${contentScopePredicate()}
      `).run(typeof notes === 'string' ? notes : JSON.stringify(notes), id, ...contentScopeParams(scope.userId, scope.tenantId));
      if (info.changes === 0) return sendError(res, 'NOT_FOUND', 'Book not found in requested scope', 404);
      sendSuccess(res, { updated: true, scope });
    } catch (err: any) {
      logger.error({ err }, 'Portal: update book notes failed');
      sendInternalError(res, 'Failed to update notes');
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // PILLARS — Reaction Radar topic configuration
  // ═══════════════════════════════════════════════════════════════════

  /** GET /pillars — list all pillars (convenience endpoint) */
  router.get('/pillars', (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const rows = db.prepare('SELECT * FROM config_pillars ORDER BY name ASC').all();
      // Parse keywords JSON for each row
      const pillars = (rows as any[]).map((r) => ({
        ...r,
        keywords: JSON.parse(r.keywords || '[]'),
      }));
      sendSuccess(res, { pillars });
    } catch (err: any) {
      logger.error({ err }, 'Portal: list pillars failed');
      sendInternalError(res, 'Failed to list pillars');
    }
  });

  /** POST /pillars — add a new pillar */
  router.post('/pillars', (req: Request, res: Response) => {
    const { name, keywords, weight, language, userId } = req.body;
    if (!name || !keywords || !Array.isArray(keywords)) {
      return sendError(res, 'BAD_REQUEST', 'name (string) and keywords (string[]) are required');
    }
    try {
      const db = getDb();
      const info = db.prepare(`
        INSERT INTO config_pillars (name, keywords, weight, language, user_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        name.trim().toLowerCase(),
        JSON.stringify(keywords),
        weight ?? 1.0,
        language ?? 'pt-BR',
        userId ?? 0,
      );
      sendSuccess(res, { id: info.lastInsertRowid });
    } catch (err: any) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return sendError(res, 'DUPLICATE', `Pillar "${name}" already exists for this user`);
      }
      logger.error({ err }, 'Portal: add pillar failed');
      sendInternalError(res, 'Failed to add pillar');
    }
  });

  /** PATCH /pillars/:id — update a pillar's keywords or weight */
  router.patch('/pillars/:id', (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid pillar id');
    try {
      const db = getDb();
      const sets: string[] = ["updated_at = datetime('now')"];
      const params: unknown[] = [];

      if (req.body.name !== undefined) { sets.push('name = ?'); params.push(req.body.name.trim().toLowerCase()); }
      if (req.body.keywords !== undefined) { sets.push('keywords = ?'); params.push(JSON.stringify(req.body.keywords)); }
      if (req.body.weight !== undefined) { sets.push('weight = ?'); params.push(req.body.weight); }
      if (req.body.language !== undefined) { sets.push('language = ?'); params.push(req.body.language); }
      if (req.body.enabled !== undefined) { sets.push('enabled = ?'); params.push(req.body.enabled ? 1 : 0); }

      if (sets.length === 1) return sendError(res, 'BAD_REQUEST', 'No fields to update');

      params.push(id);
      const info = db.prepare(`UPDATE config_pillars SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      if (info.changes === 0) return sendError(res, 'NOT_FOUND', 'Pillar not found', 404);
      sendSuccess(res, { updated: true });
    } catch (err: any) {
      logger.error({ err }, 'Portal: update pillar failed');
      sendInternalError(res, 'Failed to update pillar');
    }
  });

  /** DELETE /pillars/:id — remove a pillar */
  router.delete('/pillars/:id', (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid pillar id');
    try {
      const db = getDb();
      const info = db.prepare('DELETE FROM config_pillars WHERE id = ?').run(id);
      if (info.changes === 0) return sendError(res, 'NOT_FOUND', 'Pillar not found', 404);
      sendSuccess(res, { removed: true });
    } catch (err: any) {
      logger.error({ err }, 'Portal: delete pillar failed');
      sendInternalError(res, 'Failed to delete pillar');
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // VOICE DNA — Channel DNA / voice pattern management
  // ═══════════════════════════════════════════════════════════════════

  /** POST /voice-dna — manually add or overwrite a voice DNA pattern */
  router.post('/voice-dna', (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    const { category, label, payload } = req.body;
    if (!category || !payload) {
      return sendError(res, 'BAD_REQUEST', 'category and payload are required');
    }
    try {
      const { upsertKnowledge } = require('../../state/content-references');
      const normalizedPayload = typeof payload === 'string' ? payload.trim() : JSON.stringify(payload);
      if (!normalizedPayload) return sendError(res, 'BAD_REQUEST', 'payload must be non-empty');
      upsertKnowledge(category, normalizedPayload, label ? [String(label)] : [], scope.userId, scope.tenantId);
      sendSuccess(res, { upserted: true, scope });
    } catch (err: any) {
      logger.error({ err }, 'Portal: upsert voice DNA failed');
      sendInternalError(res, 'Failed to upsert voice DNA');
    }
  });

  /** PATCH /voice-dna/:id — edit an existing voice DNA entry's payload */
  router.patch('/voice-dna/:id', (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid voice DNA id');
    const { payload, category } = req.body;
    if (!payload && !category) return sendError(res, 'BAD_REQUEST', 'payload or category required');
    try {
      const db = getDb();
      ensureContentTenantScopeColumns(db);
      const sets: string[] = ["updated_at = datetime('now')"];
      const params: unknown[] = [];
      if (payload) { sets.push('synthesized_text = ?'); params.push(typeof payload === 'string' ? payload : JSON.stringify(payload)); }
      if (category) { sets.push('category = ?'); params.push(String(category)); }
      params.push(id, ...contentScopeParams(scope.userId, scope.tenantId));
      const info = db.prepare(`
        UPDATE content_knowledge
           SET ${sets.join(', ')}
         WHERE id = ?
           AND ${contentScopePredicate()}
      `).run(...params);
      if (info.changes === 0) return sendError(res, 'NOT_FOUND', 'Voice DNA entry not found in requested scope', 404);
      sendSuccess(res, { updated: true, scope });
    } catch (err: any) {
      logger.error({ err }, 'Portal: update voice DNA failed');
      sendInternalError(res, 'Failed to update voice DNA');
    }
  });

  /** POST /voice-dna/synthesize — trigger on-demand voice synthesis */
  router.post('/voice-dna/synthesize', async (req: Request, res: Response) => {
    const scope = resolvePortalContentScope(req, res, true);
    if (!scope) return;
    return sendError(
      res,
      'UNSUPPORTED_SCOPE',
      'Tenant-scoped portal voice synthesis is disabled until the voice evolution agent accepts explicit tenant/user scope',
      409,
    );
  });

  return router;
}
