// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Router, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { logger } from '../../utils/logger';
import {
  assessContentWorkspaceSource,
  ContentWorkspaceLineageError,
  getContentRevisionLineage,
  recordContentRevisionLineage,
  registerContentWorkspaceSource,
} from '../../services/content-workspace-lineage';
import {
  CONTENT_WORKSPACE_SCHEMA_VERSION,
  ContentWorkspaceError,
  attachContentTag,
  createContentArtifact,
  createContentItemRelationship,
  createContentTag,
  createContentWorkspaceItem,
  detachContentTag,
  duplicateContentWorkspaceItem,
  getContentArtifact,
  getContentWorkspaceItemDetail,
  getContentWorkspaceItem,
  listDeletedContentWorkspaceItems,
  listContentTags,
  queryContentRevisions,
  queryContentWorkspaceItems,
  removeContentItemRelationship,
  reorderContentItemRelationship,
  restoreDeletedContentWorkspaceItem,
  restoreContentRevision,
  saveContentRevision,
  softDeleteContentWorkspaceItem,
  transitionContentWorkspaceItem,
  updateContentWorkspaceItem,
  type ContentArtifactPhase,
  type ContentArtifactType,
  type ContentProductionState,
  type ContentRelationshipType,
  type ContentRevisionContent,
  type ContentWorkspaceItemType,
  type ContentWorkspaceCopyMode,
  type ContentWorkspaceSort,
  type ContentWorkspaceScope,
} from '../../services/content-workspace';
import { ContentWorkspaceWriteDisabledError } from '../../services/content-workspace-capabilities';
import {
  saveGeneratedScriptRevisionToWorkspace,
  saveGeneratedScriptToWorkspace,
} from '../../services/content-workspace-capture';
import {
  ensureContentWorkspaceReviewDecision,
  unavailableContentWorkspaceReviewDecision,
} from '../../services/content-workspace-decision-projection';
import { getContentWorkspaceTodaySummary } from '../../services/content-workspace-read-models';
import { getUserTimezoneById } from '../../services/user-service';

type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

export function registerContentWorkspaceRoutes(
  router: Router,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  /** POST /api/v1/content/workspace/generated-scripts — agent-attributed canonical capture */
  router.post('/workspace/generated-scripts', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_generated_script_capture');
    if (!scope) return;
    try {
      const result = saveGeneratedScriptToWorkspace({
        scope,
        topic: req.body?.topic,
        format: req.body?.format,
        scriptText: req.body?.scriptText,
        platformId: req.body?.platformId,
        hook: req.body?.hook,
        titleOptions: req.body?.titleOptions,
        sourcesUsed: req.body?.sourcesUsed,
        claimsUsed: req.body?.claimsUsed,
        hashtags: req.body?.hashtags,
        caption: req.body?.caption,
        cta: req.body?.cta,
        estimatedDuration: req.body?.estimatedDuration,
        niche: req.body?.niche,
        generationDurationMs: req.body?.generationDurationMs,
        sourcePackageId: req.body?.sourcePackageId,
        actorType: 'agent',
        actorId: 'ios-content-script-generation',
        idempotencyKey: readIdempotencyKey(req),
        targetItemId: req.body?.targetItemId,
        expectedWorkflowVersion: req.body?.expectedWorkflowVersion,
        captureOrigin: 'script_generation',
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        captureSchemaVersion: result.schemaVersion,
        item: result.item,
        artifact: result.artifact,
        // `revision` is the immutable mutation receipt; `artifact` and
        // `currentRevision` are the authoritative live read model. They may
        // intentionally differ when a successful request is replayed later.
        revision: result.revision,
        currentRevision: result.artifact.currentRevision,
        mutation: { replayed: result.replayed, created: !result.replayed },
      }, { status: result.replayed ? 200 : 201 });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace generated script capture failed');
    }
  });

  /** POST /api/v1/content/workspace/artifacts/:artifactId/generated-revisions — accepted AI edit */
  router.post('/workspace/artifacts/:artifactId/generated-revisions', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_generated_revision_capture', {
      artifactId: req.params.artifactId,
    });
    if (!scope) return;
    try {
      const result = saveGeneratedScriptRevisionToWorkspace({
        scope,
        artifactId: Number(req.params.artifactId),
        baseRevision: req.body?.baseRevision,
        scriptText: req.body?.scriptText,
        sourcesUsed: req.body?.sourcesUsed,
        claimsUsed: req.body?.claimsUsed,
        changeSummary: req.body?.changeSummary,
        actorId: 'ios-content-script-generation',
        idempotencyKey: readIdempotencyKey(req),
        captureOrigin: 'approved_variant',
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        captureSchemaVersion: result.schemaVersion,
        revision: result.revision,
        item: result.item,
        artifact: result.artifact,
        currentRevision: result.artifact.currentRevision,
        mutation: { replayed: result.replayed, created: result.created },
      }, { status: result.created ? 201 : 200 });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace generated revision capture failed');
    }
  });

  /** GET /api/v1/content/workspace/items — canonical Content library read model */
  router.get('/workspace/items', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_items_list');
    if (!scope) return;
    try {
      const page = queryContentWorkspaceItems({
        scope,
        itemType: queryString(req.query.itemType, 'itemType') as ContentWorkspaceItemType | undefined,
        productionState: queryString(req.query.productionState, 'productionState') as ContentProductionState | undefined,
        artifactPhase: queryString(req.query.artifactPhase, 'artifactPhase') as ContentArtifactPhase | undefined,
        priority: queryInteger(req.query.priority, 'priority'),
        favorite: queryBoolean(req.query.favorite, 'favorite'),
        platformId: queryString(req.query.platformId, 'platformId'),
        formatId: queryString(req.query.formatId, 'formatId'),
        tag: queryString(req.query.tag, 'tag'),
        projectId: queryInteger(req.query.projectId, 'projectId'),
        search: queryString(req.query.search, 'search'),
        includeArchived: queryBoolean(req.query.includeArchived, 'includeArchived'),
        sort: queryString(req.query.sort, 'sort') as ContentWorkspaceSort | undefined,
        cursor: queryString(req.query.cursor, 'cursor'),
        limit: queryInteger(req.query.limit, 'limit'),
      });
      sendSuccess(res, { schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION, ...page });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace list failed');
    }
  });

  /** Complete dashboard counts; bounded library pages are never totals. */
  router.get('/workspace/today-summary', (req, res: Response) => {
    const scope = resolveRouteScope(
      req as unknown as AuthenticatedRequest,
      res,
      ensureValidContentRouteScope,
      'content_workspace_today_summary',
    );
    if (!scope) return;
    try {
      sendSuccess(res, getContentWorkspaceTodaySummary(
        scope,
        undefined,
        new Date(),
        getUserTimezoneById(scope.userId),
      ));
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace Today summary failed');
    }
  });

  /** GET /api/v1/content/workspace/trash — recoverable tombstones after interrupted deletes */
  router.get('/workspace/trash', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_trash_list');
    if (!scope) return;
    try {
      const page = listDeletedContentWorkspaceItems({
        scope,
        cursor: queryString(req.query.cursor, 'cursor'),
        limit: queryInteger(req.query.limit, 'limit'),
      });
      sendSuccess(res, { schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION, ...page });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace trash list failed');
    }
  });

  /** PATCH /api/v1/content/workspace/items/:itemId — CAS-protected library metadata edit */
  router.patch('/workspace/items/:itemId', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_item_update', {
      itemId: req.params.itemId,
    });
    if (!scope) return;
    try {
      const result = updateContentWorkspaceItem({
        scope,
        itemId: Number(req.params.itemId),
        expectedWorkflowVersion: req.body?.expectedWorkflowVersion,
        title: req.body?.title,
        summary: req.body?.summary,
        priority: req.body?.priority,
        deadlineAt: req.body?.deadlineAt,
        favorite: req.body?.favorite,
        platformId: req.body?.platformId,
        formatId: req.body?.formatId,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        item: result.value,
        mutation: { replayed: result.replayed, changed: result.changed },
      });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace item update failed');
    }
  });

  /** DELETE /api/v1/content/workspace/items/:itemId — recoverable tombstone; never hard-deletes */
  router.delete('/workspace/items/:itemId', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_item_soft_delete', {
      itemId: req.params.itemId,
    });
    if (!scope) return;
    try {
      const result = softDeleteContentWorkspaceItem({
        scope,
        itemId: Number(req.params.itemId),
        expectedWorkflowVersion: req.body?.expectedWorkflowVersion,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        deletion: result.value,
        deletionCurrent: result.deletionCurrent,
        item: result.item,
        mutation: { replayed: result.replayed, changed: result.changed },
      });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace item soft delete failed');
    }
  });

  /** POST /api/v1/content/workspace/items/:itemId/restore — CAS-protected tombstone recovery */
  router.post('/workspace/items/:itemId/restore', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_item_restore', {
      itemId: req.params.itemId,
    });
    if (!scope) return;
    try {
      const result = restoreDeletedContentWorkspaceItem({
        scope,
        itemId: Number(req.params.itemId),
        expectedWorkflowVersion: req.body?.expectedWorkflowVersion,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        item: result.value,
        mutation: { replayed: result.replayed, changed: result.changed },
      });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace item restore failed');
    }
  });

  /** GET /api/v1/content/workspace/tags — scoped tag vocabulary */
  router.get('/workspace/tags', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_tags_list');
    if (!scope) return;
    try {
      sendSuccess(res, { schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION, tags: listContentTags(scope) });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace tags list failed');
    }
  });

  /** POST /api/v1/content/workspace/tags — normalized, scoped, idempotent tag creation */
  router.post('/workspace/tags', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_tag_create');
    if (!scope) return;
    try {
      const result = createContentTag({
        scope,
        name: req.body?.name,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        tag: result.value,
        mutation: { replayed: result.replayed, created: result.created },
      }, { status: result.created ? 201 : 200 });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace tag create failed');
    }
  });

  /** POST /api/v1/content/workspace/items/:itemId/tags — attach without duplicates */
  router.post('/workspace/items/:itemId/tags', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_tag_attach', {
      itemId: req.params.itemId,
    });
    if (!scope) return;
    try {
      const result = attachContentTag({
        scope,
        itemId: Number(req.params.itemId),
        tagId: req.body?.tagId,
        expectedWorkflowVersion: req.body?.expectedWorkflowVersion,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        item: result.value,
        mutation: { replayed: result.replayed, changed: result.changed },
      });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace tag attach failed');
    }
  });

  /** DELETE /api/v1/content/workspace/items/:itemId/tags/:tagId — idempotent scoped detach */
  router.delete('/workspace/items/:itemId/tags/:tagId', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_tag_detach', {
      itemId: req.params.itemId,
      tagId: req.params.tagId,
    });
    if (!scope) return;
    try {
      const result = detachContentTag({
        scope,
        itemId: Number(req.params.itemId),
        tagId: Number(req.params.tagId),
        expectedWorkflowVersion: req.body?.expectedWorkflowVersion,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        item: result.value,
        mutation: { replayed: result.replayed, changed: result.changed },
      });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace tag detach failed');
    }
  });

  /** POST /api/v1/content/workspace/items — idempotently capture an item or create a project */
  router.post('/workspace/items', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_item_create');
    if (!scope) return;
    try {
      const result = createContentWorkspaceItem({
        scope,
        itemType: req.body?.itemType as ContentWorkspaceItemType,
        title: req.body?.title,
        summary: req.body?.summary,
        platformId: req.body?.platformId,
        formatId: req.body?.formatId,
        priority: req.body?.priority,
        deadlineAt: req.body?.deadlineAt,
        favorite: req.body?.favorite,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        item: result.value,
        mutation: { replayed: result.replayed, created: result.created },
      }, { status: result.created ? 201 : 200 });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace item create failed');
    }
  });

  /** GET /api/v1/content/workspace/items/:itemId — item, artifacts, current revisions, and relationships */
  router.get('/workspace/items/:itemId', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_item_read', {
      itemId: req.params.itemId,
    });
    if (!scope) return;
    try {
      const item = getContentWorkspaceItemDetail(scope, Number(req.params.itemId));
      if (!item) {
        sendError(res, 'CONTENT_ITEM_NOT_FOUND', 'Content item not found.', 404);
        return;
      }
      sendSuccess(res, { schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION, item });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace item read failed');
    }
  });

  /** POST /api/v1/content/workspace/items/:itemId/copies — atomic duplicate/remix snapshot */
  router.post('/workspace/items/:itemId/copies', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_item_copy', {
      itemId: req.params.itemId,
    });
    if (!scope) return;
    try {
      const result = duplicateContentWorkspaceItem({
        scope,
        sourceItemId: Number(req.params.itemId),
        expectedWorkflowVersion: req.body?.expectedWorkflowVersion,
        mode: req.body?.mode as ContentWorkspaceCopyMode,
        title: req.body?.title,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        copy: result.value,
        mutation: { replayed: result.replayed, created: result.created },
      }, { status: result.created ? 201 : 200 });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace item copy failed');
    }
  });

  /** POST /api/v1/content/workspace/items/:itemId/state — version-checked lifecycle transition */
  router.post('/workspace/items/:itemId/state', asyncHandler(async (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_item_transition', {
      itemId: req.params.itemId,
    });
    if (!scope) return;
    try {
      const result = transitionContentWorkspaceItem({
        scope,
        itemId: Number(req.params.itemId),
        targetState: req.body?.targetState as ContentProductionState,
        expectedWorkflowVersion: req.body?.expectedWorkflowVersion,
        idempotencyKey: readIdempotencyKey(req),
      });
      let decisionProjection;
      if (result.value.productionState === 'review') {
        try {
          decisionProjection = await ensureContentWorkspaceReviewDecision(scope, result.value.id);
        } catch (projectionError) {
          logger.error({
            operation: 'content_workspace_review_decision_project_after_transition',
            itemId: result.value.id,
            workflowVersion: result.value.workflowVersion,
            errorName: projectionError instanceof Error ? projectionError.name : typeof projectionError,
          }, 'Content entered review but Decision Center projection failed');
          decisionProjection = unavailableContentWorkspaceReviewDecision(
            result.value.id,
            result.value.workflowVersion,
          );
        }
      }
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        item: result.value,
        mutation: {
          replayed: result.replayed,
          changed: !result.replayed && result.value.workflowVersion > Number(req.body?.expectedWorkflowVersion),
        },
        ...(decisionProjection ? { decisionProjection } : {}),
      });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace state transition failed');
    }
  }));

  /** POST /api/v1/content/workspace/items/:itemId/artifacts — create an artifact and optional first revision */
  router.post('/workspace/items/:itemId/artifacts', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_artifact_create', {
      itemId: req.params.itemId,
    });
    if (!scope) return;
    try {
      const result = createContentArtifact({
        scope,
        itemId: Number(req.params.itemId),
        expectedWorkflowVersion: req.body?.expectedWorkflowVersion,
        artifactType: req.body?.artifactType as ContentArtifactType,
        title: req.body?.title,
        platformId: req.body?.platformId,
        formatId: req.body?.formatId,
        metadata: req.body?.metadata,
        initialContent: req.body?.initialContent as ContentRevisionContent | undefined,
        changeSummary: req.body?.changeSummary,
        actorType: 'user',
        actorId: String(scope.userId),
        provenance: { source: 'authenticated_user_api' },
        sourceArtifactId: req.body?.sourceArtifactId,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        artifact: result.value,
        item: requireMutationParentItem(scope, result.value.itemId),
        mutation: { replayed: result.replayed, created: result.created },
      }, { status: result.created ? 201 : 200 });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace artifact create failed');
    }
  });

  /** GET /api/v1/content/workspace/artifacts/:artifactId/revisions — immutable revision history */
  router.get('/workspace/artifacts/:artifactId/revisions', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_revisions_list', {
      artifactId: req.params.artifactId,
    });
    if (!scope) return;
    try {
      const page = queryContentRevisions(scope, Number(req.params.artifactId), {
        cursor: queryString(req.query.cursor, 'cursor'),
        limit: queryInteger(req.query.limit, 'limit'),
      });
      sendSuccess(res, { schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION, ...page });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace revision list failed');
    }
  });

  /** POST /api/v1/content/workspace/artifacts/:artifactId/revisions — CAS save */
  // The parent API router applies auth and per-user rate limiting before mounting /content.
  // codeql[js/missing-rate-limiting]
  router.post('/workspace/artifacts/:artifactId/revisions', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_revision_save', {
      artifactId: req.params.artifactId,
    });
    if (!scope) return;
    try {
      const result = saveContentRevision({
        scope,
        artifactId: Number(req.params.artifactId),
        baseRevision: req.body?.baseRevision,
        content: req.body?.content as ContentRevisionContent,
        changeSummary: req.body?.changeSummary,
        changeReason: req.body?.changeReason,
        actorType: 'user',
        actorId: String(scope.userId),
        provenance: { source: 'authenticated_user_api' },
        idempotencyKey: readIdempotencyKey(req),
      });
      const authoritative = requireAuthoritativeArtifactContext(scope, result.value.artifactId);
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        revision: result.value,
        item: authoritative.item,
        artifact: authoritative.artifact,
        currentRevision: authoritative.artifact.currentRevision,
        mutation: { replayed: result.replayed, created: result.created },
      }, { status: result.created && !result.replayed ? 201 : 200 });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace revision save failed');
    }
  });

  /** POST /api/v1/content/workspace/artifacts/:artifactId/revisions/:revisionId/restore — restore as a new revision */
  // The parent API router applies auth and per-user rate limiting before mounting /content.
  // codeql[js/missing-rate-limiting]
  router.post('/workspace/artifacts/:artifactId/revisions/:revisionId/restore', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_revision_restore', {
      artifactId: req.params.artifactId,
      revisionId: req.params.revisionId,
    });
    if (!scope) return;
    try {
      const result = restoreContentRevision({
        scope,
        artifactId: Number(req.params.artifactId),
        sourceRevisionId: Number(req.params.revisionId),
        baseRevision: req.body?.baseRevision,
        changeSummary: req.body?.changeSummary,
        actorId: String(scope.userId),
        idempotencyKey: readIdempotencyKey(req),
      });
      const authoritative = requireAuthoritativeArtifactContext(scope, result.value.artifactId);
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        revision: result.value,
        item: authoritative.item,
        artifact: authoritative.artifact,
        currentRevision: authoritative.artifact.currentRevision,
        mutation: { replayed: result.replayed, created: result.created },
      }, { status: result.created && !result.replayed ? 201 : 200 });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace revision restore failed');
    }
  });

  /** POST /api/v1/content/workspace/sources — register private untrusted evidence */
  router.post('/workspace/sources', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_source_create');
    if (!scope) return;
    try {
      const result = registerContentWorkspaceSource({
        scope,
        referenceType: req.body?.referenceType,
        title: req.body?.title,
        url: req.body?.url,
        summary: req.body?.summary,
        sourceIdentifier: req.body?.sourceIdentifier,
        metadata: req.body?.metadata,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        source: result.source,
        mutation: { replayed: result.replayed, created: result.created },
      }, { status: result.created ? 201 : 200 });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace source registration failed');
    }
  });

  /** POST /api/v1/content/workspace/sources/:referenceId/assessment — staged source review */
  router.post('/workspace/sources/:referenceId/assessment', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_source_assess', {
      referenceId: req.params.referenceId,
    });
    if (!scope) return;
    try {
      const result = assessContentWorkspaceSource({
        scope,
        referenceId: req.params.referenceId,
        assessment: req.body?.assessment,
        summary: req.body?.summary,
        expectedUpdatedAt: req.body?.expectedUpdatedAt,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        assessmentSchemaVersion: result.schemaVersion,
        source: result.source,
        mutation: { replayed: result.replayed, changed: result.changed },
      });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace source assessment failed');
    }
  });

  /** GET /api/v1/content/workspace/revisions/:revisionId/lineage — immutable source and claim snapshot */
  router.get('/workspace/revisions/:revisionId/lineage', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_revision_lineage_read', {
      revisionId: req.params.revisionId,
    });
    if (!scope) return;
    try {
      const lineage = getContentRevisionLineage(scope, Number(req.params.revisionId));
      sendSuccess(res, { schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION, lineage });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace revision lineage read failed');
    }
  });

  /** POST /api/v1/content/workspace/revisions/:revisionId/lineage — record once, never rewrite */
  router.post('/workspace/revisions/:revisionId/lineage', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_revision_lineage_record', {
      revisionId: req.params.revisionId,
    });
    if (!scope) return;
    try {
      const result = recordContentRevisionLineage({
        scope,
        revisionId: Number(req.params.revisionId),
        referenceIds: req.body?.referenceIds,
        claims: req.body?.claims,
        idempotencyKey: readIdempotencyKey(req),
      });
      const artifact = getContentArtifact(scope, result.lineage.artifactId);
      const item = artifact ? getContentWorkspaceItem(scope, artifact.itemId) : null;
      if (!item) {
        throw new ContentWorkspaceLineageError(
          'CONTENT_LINEAGE_ITEM_READBACK_FAILED',
          'The lineage snapshot was saved but its authoritative workspace item could not be read.',
          500,
        );
      }
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        lineage: result.lineage,
        item,
        mutation: { replayed: result.replayed, created: result.created },
      }, { status: result.created && !result.replayed ? 201 : 200 });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace revision lineage record failed');
    }
  });

  /** POST /api/v1/content/workspace/relationships — connect projects, derivatives, variants, and remixes */
  router.post('/workspace/relationships', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_relationship_create');
    if (!scope) return;
    try {
      const result = createContentItemRelationship({
        scope,
        fromItemId: req.body?.fromItemId,
        toItemId: req.body?.toItemId,
        relationshipType: req.body?.relationshipType as ContentRelationshipType,
        position: req.body?.position,
        metadata: req.body?.metadata,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        relationship: result.value,
        mutation: { replayed: result.replayed, created: result.created },
      }, { status: result.created ? 201 : 200 });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace relationship create failed');
    }
  });

  /** PATCH /api/v1/content/workspace/relationships/:relationshipId/position — CAS-protected group reorder */
  router.patch('/workspace/relationships/:relationshipId/position', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_relationship_reorder', {
      relationshipId: req.params.relationshipId,
    });
    if (!scope) return;
    try {
      const result = reorderContentItemRelationship({
        scope,
        relationshipId: Number(req.params.relationshipId),
        expectedFromWorkflowVersion: req.body?.expectedFromWorkflowVersion,
        position: req.body?.position,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        relationship: result.value,
        fromItem: getContentWorkspaceItem(scope, result.value.fromItemId),
        mutation: { replayed: result.replayed, changed: result.changed },
      });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace relationship reorder failed');
    }
  });

  /** DELETE /api/v1/content/workspace/relationships/:relationshipId — scoped idempotent unlink */
  router.delete('/workspace/relationships/:relationshipId', (req, res: Response) => {
    const scope = resolveRouteScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_workspace_relationship_remove', {
      relationshipId: req.params.relationshipId,
    });
    if (!scope) return;
    try {
      const result = removeContentItemRelationship({
        scope,
        relationshipId: Number(req.params.relationshipId),
        expectedFromWorkflowVersion: req.body?.expectedFromWorkflowVersion,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        removal: result.value,
        fromItem: getContentWorkspaceItem(scope, result.value.fromItemId),
        mutation: { replayed: result.replayed, changed: result.changed },
      });
    } catch (error) {
      sendWorkspaceError(res, error, scope, 'content workspace relationship removal failed');
    }
  });
}

function resolveRouteScope(
  req: AuthenticatedRequest,
  res: Response,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
  operation: string,
  details?: Record<string, unknown>,
): ContentWorkspaceScope | null {
  if (!ensureValidContentRouteScope(res, req.userId, operation, details)) return null;
  if (!Number.isInteger(req.tenantId) || Number(req.tenantId) <= 0) {
    sendError(res, 'CONTENT_TENANT_SCOPE_REQUIRED', 'A valid tenant scope is required.', 401);
    return null;
  }
  if (Number(req.tenantId) !== req.userId) {
    sendError(res, 'CONTENT_TENANT_SCOPE_MISMATCH', 'The active tenant does not match the authenticated session.', 403);
    return null;
  }
  return { tenantId: Number(req.tenantId), userId: req.userId };
}

function requireMutationParentItem(scope: ContentWorkspaceScope, itemId: number) {
  const item = getContentWorkspaceItem(scope, itemId);
  if (!item) {
    throw new ContentWorkspaceError(
      'CONTENT_WORKSPACE_WRITE_FAILED',
      'The updated Content item was not readable after the mutation.',
      500,
    );
  }
  return item;
}

function requireAuthoritativeArtifactContext(scope: ContentWorkspaceScope, artifactId: number) {
  const artifact = getContentArtifact(scope, artifactId);
  if (!artifact || artifact.currentRevision == null || artifact.currentRevisionId == null) {
    throw new ContentWorkspaceError(
      'CONTENT_WORKSPACE_WRITE_FAILED',
      'The authoritative Content artifact revision was not readable after the mutation.',
      500,
    );
  }
  return {
    artifact,
    item: requireMutationParentItem(scope, artifact.itemId),
  };
}

function readIdempotencyKey(req: { body?: any; header(name: string): string | undefined }): string {
  if (typeof req.body?.idempotencyKey === 'string') return req.body.idempotencyKey;
  return req.header('x-idempotency-key') ?? '';
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} must be a string.`, 400, { field });
  }
  return value.trim().length > 0 ? value.trim() : undefined;
}

function queryInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} must be a positive integer.`, 400, { field });
  }
  return Number(value);
}

function queryBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} must be true or false.`, 400, { field });
}

function sendWorkspaceError(
  res: Response,
  error: unknown,
  scope: ContentWorkspaceScope,
  logMessage: string,
): void {
  if (error instanceof ContentWorkspaceWriteDisabledError) {
    sendError(res, error.code, error.message, error.status, error.details);
    return;
  }
  if (error instanceof ContentWorkspaceError) {
    sendError(res, error.code, error.message, error.status, error.details);
    return;
  }
  if (error instanceof ContentWorkspaceLineageError) {
    sendError(res, error.code, error.message, error.status, error.details);
    return;
  }
  logger.error({ err: error, tenantId: scope.tenantId, userId: scope.userId }, logMessage);
  sendInternalError(res, 'Content workspace is temporarily unavailable.');
}
