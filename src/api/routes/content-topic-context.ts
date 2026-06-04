// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../../services/database';
import type { ScriptTopicContext } from '../../services/content-engine';
import { parseOptionalPositiveInt } from './content-script-utils';

export function parseOptionalPositiveId(value: unknown): number | null {
  const parsed = parseOptionalPositiveInt(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

export function parseOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function resolveScriptTopicContext(
  userId: number,
  raw: Record<string, unknown>,
  db: ReturnType<typeof getDb> = getDb(),
  tenantId?: number | null,
): ScriptTopicContext | null {
  const context: ScriptTopicContext = {};
  const expectedTenantId = tenantId != null && Number.isFinite(tenantId) && tenantId > 0 ? Number(tenantId) : null;

  const pipelineId = parseOptionalPositiveId(raw.pipelineId);
  const topicFeedbackId = parseOptionalPositiveId(raw.topicFeedbackId);
  const ideaId = parseOptionalPositiveId(raw.ideaId);
  let pipelineAuthorized = false;
  let topicFeedbackAuthorized = false;
  let ideaAuthorized = false;

  if (pipelineId != null) {
    try {
      const row = db.prepare(`
        SELECT p.id AS pipeline_id,
               p.user_id AS pipeline_user_id,
               p.tenant_id AS pipeline_tenant_id,
               p.owner_user_id AS pipeline_owner_user_id,
               p.niche AS pipeline_niche,
               tf.id AS topic_feedback_id,
               tf.niche AS feedback_niche,
               tf.hook_idea,
               tf.why_now,
               tf.angle_tag,
               tf.source_job
        FROM content_pipeline p
        LEFT JOIN content_topic_feedback tf ON tf.id = p.topic_feedback_id
        WHERE p.id = ?
        LIMIT 1
      `).get(pipelineId) as any;

      if (row && row.pipeline_user_id === userId
        && (row.pipeline_owner_user_id == null || Number(row.pipeline_owner_user_id) === userId)
        && (expectedTenantId == null || row.pipeline_tenant_id == null || Number(row.pipeline_tenant_id) === expectedTenantId)) {
        pipelineAuthorized = true;
        context.pipelineId = row.pipeline_id;
        context.topicFeedbackId = row.topic_feedback_id ?? context.topicFeedbackId;
        context.niche = row.feedback_niche || row.pipeline_niche || context.niche;
        context.hookIdea = row.hook_idea || context.hookIdea;
        context.whyNow = row.why_now || context.whyNow;
        context.angleTag = row.angle_tag || context.angleTag;
        context.sourceJob = row.source_job || context.sourceJob;
      }
    } catch {
      // Older isolated tests may not expose every content_pipeline column yet.
    }
  }

  if (topicFeedbackId != null) {
    const row = db.prepare(`
      SELECT id, niche, hook_idea, why_now, angle_tag, source_job
      FROM content_topic_feedback
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `).get(topicFeedbackId, userId) as any;

    if (row) {
      topicFeedbackAuthorized = true;
      context.topicFeedbackId = row.id;
      context.niche = row.niche || context.niche;
      context.hookIdea = row.hook_idea || context.hookIdea;
      context.whyNow = row.why_now || context.whyNow;
      context.angleTag = row.angle_tag || context.angleTag;
      context.sourceJob = row.source_job || context.sourceJob;
    }
  }

  if (ideaId != null) {
    const row = db.prepare(`
      SELECT id, niche, hook_idea, why_now, angle_tag, source
      FROM saved_ideas
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `).get(ideaId, userId) as any;

    if (row) {
      ideaAuthorized = true;
      context.ideaId = row.id;
      context.niche = row.niche || context.niche;
      context.hookIdea = row.hook_idea || context.hookIdea;
      context.whyNow = row.why_now || context.whyNow;
      context.angleTag = row.angle_tag || context.angleTag;
      context.sourceJob = row.source || context.sourceJob;
    }
  }

  const explicitNiche = parseOptionalText(raw.niche);
  const explicitHookIdea = parseOptionalText(raw.hookIdea);
  const explicitWhyNow = parseOptionalText(raw.whyNow);
  const explicitAngleTag = parseOptionalText(raw.angleTag);

  if (pipelineId != null && pipelineAuthorized) context.pipelineId = pipelineId;
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
