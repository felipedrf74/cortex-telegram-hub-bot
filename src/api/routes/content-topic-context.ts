// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../../services/database';
import type { ScriptTopicContext } from '../../services/content-engine';
import { resolveContentWorkspaceIdentifier } from '../../services/content-workspace-read-models';
import {
  CONTENT_SCRIPT_MAX_ANGLE_TAG_CHARS,
  CONTENT_SCRIPT_MAX_HOOK_IDEA_CHARS,
  CONTENT_SCRIPT_MAX_NICHE_CHARS,
  CONTENT_SCRIPT_MAX_WHY_NOW_CHARS,
} from './content-script-utils';

const CONTENT_SCRIPT_MAX_SOURCE_JOB_CHARS = 120;

export function parseOptionalPositiveId(value: unknown): number | null {
  if (Number.isSafeInteger(value) && Number(value) > 0) return Number(value);
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseOptionalText(value: unknown, maxChars = 1_000): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxChars ? normalized : null;
}

export function resolveScriptTopicContext(
  userId: number,
  raw: Record<string, unknown>,
  db: ReturnType<typeof getDb> = getDb(),
  tenantId?: number | null,
): ScriptTopicContext | null {
  const context: ScriptTopicContext = {};
  const expectedTenantId = tenantId != null && Number.isSafeInteger(tenantId) && tenantId > 0 ? Number(tenantId) : null;

  const workspaceItemId = parseOptionalPositiveId(raw.workspaceItemId);
  const pipelineId = parseOptionalPositiveId(raw.pipelineId);
  const topicFeedbackId = parseOptionalPositiveId(raw.topicFeedbackId);
  const ideaId = parseOptionalPositiveId(raw.ideaId);
  let topicFeedbackAuthorized = false;
  let ideaAuthorized = false;

  // Prefer the canonical workspace identifier. `pipelineId` remains an
  // explicit compatibility alias and resolves through the canonical binding
  // read model before any context is returned.
  const requestedWorkspaceIdentifier = workspaceItemId ?? pipelineId;
  if (requestedWorkspaceIdentifier != null) {
    const scope = { tenantId: expectedTenantId ?? userId, userId };
    const resolved = resolveContentWorkspaceIdentifier(scope, requestedWorkspaceIdentifier, db);
    if (resolved) {
      const row = db.prepare(`
        SELECT item.id AS workspace_item_id,
               revision.content_format,
               revision.structured_content_json
          FROM content_domain_objects item
          LEFT JOIN content_artifacts artifact
            ON artifact.id = item.current_artifact_id
           AND artifact.tenant_id = item.tenant_id
           AND artifact.owner_user_id = item.owner_user_id
           AND artifact.scope_status = 'active'
          LEFT JOIN content_revisions revision
            ON revision.id = artifact.current_revision_id
           AND revision.tenant_id = artifact.tenant_id
           AND revision.owner_user_id = artifact.owner_user_id
           AND revision.artifact_id = artifact.id
         WHERE item.id = ?
           AND item.tenant_id = ?
           AND item.owner_user_id = ?
           AND item.visibility_scope = 'user_private'
           AND item.scope_status = 'active'
           AND item.deleted_at IS NULL
           AND item.object_type = 'content_item'
         LIMIT 1
      `).get(resolved.itemId, scope.tenantId, scope.userId) as {
        workspace_item_id: number;
        content_format: string | null;
        structured_content_json: string | null;
      } | undefined;
      if (row) {
        context.pipelineId = Number(row.workspace_item_id);
        const agency = parseAgencyContext(row.content_format, row.structured_content_json);
        context.hookIdea = agency.hookIdea ?? context.hookIdea;
        context.angleTag = agency.angleTag ?? context.angleTag;
        context.sourceJob = agency.sourceJob ?? context.sourceJob;
      }
    }
  }

  if (topicFeedbackId != null) {
    const row = db.prepare(`
      SELECT id, niche, hook_idea, why_now, angle_tag, source_job
      FROM content_topic_feedback
      WHERE id = ? AND user_id = ?
        AND COALESCE(tenant_id, user_id) = ?
        AND COALESCE(owner_user_id, user_id) = ?
        AND COALESCE(visibility_scope, 'user_private') = 'user_private'
        AND COALESCE(scope_status, 'active') = 'active'
      LIMIT 1
    `).get(topicFeedbackId, userId, expectedTenantId ?? userId, userId) as any;

    if (row) {
      topicFeedbackAuthorized = true;
      context.topicFeedbackId = row.id;
      context.niche = parseOptionalText(row.niche, CONTENT_SCRIPT_MAX_NICHE_CHARS) ?? context.niche;
      context.hookIdea = parseOptionalText(row.hook_idea, CONTENT_SCRIPT_MAX_HOOK_IDEA_CHARS) ?? context.hookIdea;
      context.whyNow = parseOptionalText(row.why_now, CONTENT_SCRIPT_MAX_WHY_NOW_CHARS) ?? context.whyNow;
      context.angleTag = parseOptionalText(row.angle_tag, CONTENT_SCRIPT_MAX_ANGLE_TAG_CHARS) ?? context.angleTag;
      context.sourceJob = parseOptionalText(row.source_job, CONTENT_SCRIPT_MAX_SOURCE_JOB_CHARS) ?? context.sourceJob;
    }
  }

  if (ideaId != null) {
    const row = db.prepare(`
      SELECT id, niche, hook_idea, why_now, angle_tag, source
      FROM saved_ideas
      WHERE id = ? AND user_id = ?
        AND COALESCE(tenant_id, user_id) = ?
        AND COALESCE(owner_user_id, user_id) = ?
        AND COALESCE(visibility_scope, 'user_private') = 'user_private'
        AND COALESCE(scope_status, 'active') = 'active'
      LIMIT 1
    `).get(ideaId, userId, expectedTenantId ?? userId, userId) as any;

    if (row) {
      ideaAuthorized = true;
      context.ideaId = row.id;
      context.niche = parseOptionalText(row.niche, CONTENT_SCRIPT_MAX_NICHE_CHARS) ?? context.niche;
      context.hookIdea = parseOptionalText(row.hook_idea, CONTENT_SCRIPT_MAX_HOOK_IDEA_CHARS) ?? context.hookIdea;
      context.whyNow = parseOptionalText(row.why_now, CONTENT_SCRIPT_MAX_WHY_NOW_CHARS) ?? context.whyNow;
      context.angleTag = parseOptionalText(row.angle_tag, CONTENT_SCRIPT_MAX_ANGLE_TAG_CHARS) ?? context.angleTag;
      context.sourceJob = parseOptionalText(row.source, CONTENT_SCRIPT_MAX_SOURCE_JOB_CHARS) ?? context.sourceJob;
    }
  }

  const explicitNiche = parseOptionalText(raw.niche, CONTENT_SCRIPT_MAX_NICHE_CHARS);
  const explicitHookIdea = parseOptionalText(raw.hookIdea, CONTENT_SCRIPT_MAX_HOOK_IDEA_CHARS);
  const explicitWhyNow = parseOptionalText(raw.whyNow, CONTENT_SCRIPT_MAX_WHY_NOW_CHARS);
  const explicitAngleTag = parseOptionalText(raw.angleTag, CONTENT_SCRIPT_MAX_ANGLE_TAG_CHARS);

  // The canonical item ID was already set above. A legacy pipeline ID is an
  // input compatibility alias only and must not escape as current truth.
  if (topicFeedbackId != null && topicFeedbackAuthorized) context.topicFeedbackId = topicFeedbackId;
  if (ideaId != null && ideaAuthorized) context.ideaId = ideaId;
  if (explicitNiche) context.niche = explicitNiche;
  if (explicitHookIdea) context.hookIdea = explicitHookIdea;
  if (explicitWhyNow) context.whyNow = explicitWhyNow;
  if (explicitAngleTag) context.angleTag = explicitAngleTag;

  return Object.values(context).some((value) => value != null && value !== '')
    ? context
    : null;
}

function parseAgencyContext(
  contentFormat: string | null,
  structuredJson: string | null,
): Pick<ScriptTopicContext, 'hookIdea' | 'angleTag' | 'sourceJob'> {
  if (contentFormat !== 'structured_json' || !structuredJson) return {};
  try {
    const document = JSON.parse(structuredJson) as Record<string, unknown>;
    if (document.schemaVersion !== 'content-agency-workspace-handoff-v1') return {};
    const hooks = Array.isArray(document.hooks) ? document.hooks : [];
    const firstHook = hooks[0] && typeof hooks[0] === 'object'
      ? parseOptionalText(
        (hooks[0] as Record<string, unknown>).hook,
        CONTENT_SCRIPT_MAX_HOOK_IDEA_CHARS,
      )
      : null;
    const positioning = document.positioning && typeof document.positioning === 'object'
      ? document.positioning as Record<string, unknown>
      : null;
    return {
      hookIdea: firstHook ?? undefined,
      angleTag: parseOptionalText(positioning?.category, CONTENT_SCRIPT_MAX_ANGLE_TAG_CHARS) ?? undefined,
      sourceJob: 'content_agency',
    };
  } catch {
    return {};
  }
}
