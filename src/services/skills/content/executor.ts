// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { claimChatActionRunForExecution, updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import { upsertPendingChatAction } from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import { addTopic, getTopicById } from '../../content-scheduler';
import { buildContentAgencyPackage, ensureContentAgencyTables, getContentAgencyProject, handoffContentAgencyPackageToPipeline, persistContentAgencyArtifact } from '../../content-agency';
import { claimActionRunForStepExecution, reconciliationPendingResult, updateClaimedActionRun } from '../../chat/executor/helpers';
import { getDb } from '../../database';
import { invalidateContentDerivedCaches } from '../../cache-coherence-registry';
import { normalizeContentPipelineTransitionStage, type ContentPipelineTransitionStage } from './pipeline-stage';
import { missingContentAgencySlots } from './helpers';

export function executeContentAgencyStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const claim = persistRuns ? claimChatActionRunForExecution({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    normalizedActionHash: step.idempotencyKey,
    provider: 'nexus',
    actionType: step.action,
    risk: step.risk,
    request: step.args,
    nowIso: plan.createdAt,
  }) : null;
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim && !claim.acquired && claim.row.status === 'verified_pending') {
    return { step, status: 'verified_pending', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    const missing = missingContentAgencySlots(step.action, args);
    if (missing.length > 0) {
      const result = persistRuns
        ? upsertContentPendingAction(step, plan, input, args, missing)
        : {
          pendingActionId: null,
          missingSlots: missing,
          collectedSlots: args,
          openSurface: 'script_studio',
          verified: false,
        };
      if (!updateClaimedActionRun(claim, 'verified_pending', {
        result,
        providerObjectId: result.pendingActionId ? String(result.pendingActionId) : undefined,
        verification: { verified: false, reason: 'content_spec_input_required', pendingActionId: result.pendingActionId },
      })) return reconciliationPendingResult(step, 'verified_pending');
      return { step, status: 'verified_pending', result };
    }
    const isRewrite = step.action === 'content_rewrite';
    const sourceText = typeof args.sourceText === 'string' && args.sourceText.trim()
      ? args.sourceText.trim()
      : null;
    const pkg = buildContentAgencyPackage({
      userId: input.userId,
      tenantId: input.tenantId,
      transcript: isRewrite ? sourceText ?? input.text : null,
      requestedOutput: isRewrite ? 'rewrite' : step.action === 'content_script_create' ? 'script' : 'brief',
      brief: {
        userId: input.userId,
        tenantId: input.tenantId,
        goal: String(args.goal || args.objective || args.topic || (isRewrite ? 'Rewrite user supplied content' : 'Create content from chat request')),
        objective: String(args.objective || args.topic || (isRewrite ? 'Rewrite the supplied content while preserving the user intent.' : input.text)),
        audience: typeof args.audience === 'string' ? args.audience : null,
        platform: typeof args.platform === 'string' ? args.platform : 'generic',
        format: typeof args.format === 'string' ? args.format : null,
        notes: input.text,
      },
    });
    persistContentAgencyArtifact('package', pkg);
    const readBack = getContentAgencyProject({ userId: input.userId, tenantId: input.tenantId, id: pkg.id });
    const verified = readBack?.kind === 'package' && readBack.artifact?.id === pkg.id;
    const result = {
      packageId: pkg.id,
      brief: pkg.brief,
      firstScript: pkg.scriptVariants[0] ?? null,
      quality: pkg.quality,
      verified,
      sourceTextPreserved: isRewrite && sourceText ? !pkg.transcriptStudy.warnings.includes('transcript_missing') : undefined,
    };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: pkg.id,
      verification: { verified, expected: { packageId: pkg.id } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'content_agency_package_failed' };
  }
}

export function executeContentScheduleWorkStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : null;
  const dateTime = typeof args.dateTime === 'string' && args.dateTime.trim() ? DateTime.fromISO(args.dateTime, { zone: input.timezone }) : null;
  if (!title || !dateTime?.isValid) return { step, status: 'blocked', error: 'content_schedule_requires_title_and_datetime' };
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    const topic = addTopic(input.userId, title, {
      notes: typeof args.notes === 'string' ? args.notes : 'Created from Chat action.',
      scheduledDate: dateTime.toISODate(),
      scheduledAt: dateTime.toISO(),
      status: 'planned',
      tenantId: input.tenantId,
    });
    const readBack = getTopicById(input.userId, topic.id);
    const verified = Boolean(readBack && readBack.title === title && readBack.scheduled_date === dateTime.toISODate());
    const result = { topic: readBack ?? topic, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: String(topic.id),
      verification: { verified, expected: { title, date: dateTime.toISODate() } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'content_schedule_failed' };
  }
}

function upsertContentPendingAction(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  args: Record<string, unknown>,
  missing: string[],
): {
  pendingActionId: string;
  missingSlots: string[];
  collectedSlots: Record<string, unknown>;
  openSurface: 'script_studio';
  verified: false;
} {
  const pending = upsertPendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'content',
    action: step.action,
    collectedSlots: args,
    missingSlots: missing,
    riskClass: 'R1',
    locale: input.locale || plan.locale,
    timezone: input.timezone,
    originatingSurface: input.channel,
    nowIso: plan.createdAt,
  });
  return {
    pendingActionId: pending.id,
    missingSlots: missing,
    collectedSlots: args,
    openSurface: 'script_studio',
    verified: false,
  };
}

export function executeContentPipelineHandoffStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const packageId = typeof (step.args as any).packageId === 'string' ? String((step.args as any).packageId).trim() : '';
  if (!packageId) return { step, status: 'blocked', error: 'content_pipeline_package_id_required' };
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    const handoff = handoffContentAgencyPackageToPipeline({
      userId: input.userId,
      tenantId: input.tenantId,
      packageId,
    });
    const verified = handoff.status === 'created' || handoff.status === 'already_exists';
    const status: ChatActionRunStatus = verified ? 'verified_success' : handoff.status === 'blocked' ? 'blocked' : 'failed';
    if (!updateClaimedActionRun(claim, status, {
      result: handoff,
      providerObjectId: handoff.pipelineId != null ? String(handoff.pipelineId) : packageId,
      verification: { verified, expected: { packageId }, actual: { status: handoff.status, pipelineId: handoff.pipelineId } },
      error: verified ? undefined : { reason: handoff.blockers[0] ?? handoff.status },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result: handoff, error: verified ? undefined : handoff.blockers[0] ?? 'content_pipeline_handoff_failed' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'content_pipeline_handoff_failed' };
  }
}

type ContentPipelineRow = {
  id: number;
  topic_title: string;
  stage: string;
  stage_history?: string | null;
  published_url?: string | null;
  published_at?: string | null;
  youtube_video_id?: string | null;
};

type ContentPipelineLookupResult =
  | { status: 'found'; row: ContentPipelineRow }
  | { status: 'not_found' }
  | { status: 'ambiguous' };

export function executeContentPipelineStageTransitionStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as Record<string, unknown>;
  const topicTitle = typeof args.topicTitle === 'string' && args.topicTitle.trim() ? args.topicTitle.trim() : null;
  const targetStage = normalizeContentPipelineTransitionStage(args.targetStage);
  if (!topicTitle || !targetStage) return { step, status: 'blocked', error: 'content_pipeline_stage_requires_topic_and_stage' };

  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }

  try {
    const db = getDb();
    ensureContentAgencyTables(db);
    const lookup = findScopedPipelineRow(db, input, args, topicTitle);
    if (lookup.status === 'ambiguous') {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', { error: { reason: 'content_pipeline_item_ambiguous', topicTitle } });
      return { step, status: 'blocked', error: 'content_pipeline_item_ambiguous' };
    }
    if (lookup.status === 'not_found') {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', { error: { reason: 'content_pipeline_item_not_found', topicTitle } });
      return { step, status: 'blocked', error: 'content_pipeline_item_not_found' };
    }
    const row = lookup.row;

    const nowIso = plan.createdAt || new Date().toISOString();
    const currentStage = String(row.stage || 'unknown');
    const history = parsePipelineHistory(row.stage_history);
    const youtubeUrl = typeof args.youtubeUrl === 'string' && args.youtubeUrl.trim() ? args.youtubeUrl.trim() : null;
    const youtubeVideoId = youtubeUrl ? extractYouTubeVideoId(youtubeUrl) : null;
    history.push({ from: currentStage, to: targetStage, at: nowIso, source: 'chat_action' });

    const sets = ['stage = ?', 'stage_history = ?', "updated_at = datetime('now')"];
    const params: unknown[] = [targetStage, JSON.stringify(history)];
    if (targetStage === 'published') {
      sets.push('published_at = COALESCE(published_at, ?)');
      params.push(nowIso);
      if (youtubeUrl) {
        sets.push('published_url = ?');
        params.push(youtubeUrl);
      }
      if (youtubeVideoId) {
        sets.push('youtube_video_id = COALESCE(?, youtube_video_id)');
        params.push(youtubeVideoId);
      }
    }
    params.push(row.id, input.userId, input.tenantId);

    const update = db.prepare(`
      UPDATE content_pipeline
         SET ${sets.join(', ')}
       WHERE id = ?
         AND user_id = ?
         AND tenant_id = ?
         AND COALESCE(scope_status, 'active') = 'active'
    `).run(...params);
    if (update.changes < 1) {
      if (claim) updateChatActionRun(claim.row.id, 'partial_success', { error: { reason: 'content_pipeline_stage_update_conflict', pipelineId: row.id } });
      return { step, status: 'partial_success', error: 'content_pipeline_stage_update_conflict' };
    }

    invalidateContentDerivedCaches(input.userId);
    const readBack = readScopedPipelineRow(db, input, row.id);
    const verified = readBack?.stage === targetStage;
    const result = {
      pipelineId: row.id,
      topicTitle: readBack?.topic_title ?? row.topic_title,
      fromStage: currentStage,
      targetStage,
      stage: readBack?.stage ?? targetStage,
      youtubeUrl: readBack?.published_url ?? youtubeUrl,
      verified,
    };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: String(row.id),
      verification: { verified, expected: { stage: targetStage }, actual: { stage: readBack?.stage ?? null } },
      error: verified ? undefined : { reason: 'local_read_back_mismatch' },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'content_pipeline_stage_transition_failed' };
  }
}

function findScopedPipelineRow(
  db: ReturnType<typeof getDb>,
  input: ChatPlannerInput,
  args: Record<string, unknown>,
  topicTitle: string,
): ContentPipelineLookupResult {
  const pipelineId = parsePositiveId(args.pipelineId);
  if (pipelineId != null) {
    const row = readScopedPipelineRow(db, input, pipelineId);
    return row ? { status: 'found', row } : { status: 'not_found' };
  }
  const exactRows = db.prepare(`
    SELECT id, topic_title, stage, stage_history, published_url, published_at, youtube_video_id
      FROM content_pipeline
     WHERE user_id = ?
       AND tenant_id = ?
       AND COALESCE(scope_status, 'active') = 'active'
       AND LOWER(topic_title) = LOWER(?)
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 2
  `).all(input.userId, input.tenantId, topicTitle) as ContentPipelineRow[];
  if (exactRows.length === 1) return { status: 'found', row: exactRows[0]! };
  if (exactRows.length > 1) return { status: 'ambiguous' };

  const like = `%${escapeSqlLike(topicTitle.slice(0, 48))}%`;
  const fuzzyRows = db.prepare(`
    SELECT id, topic_title, stage, stage_history, published_url, published_at, youtube_video_id
      FROM content_pipeline
     WHERE user_id = ?
       AND tenant_id = ?
       AND COALESCE(scope_status, 'active') = 'active'
       AND LOWER(topic_title) LIKE LOWER(?) ESCAPE '\\'
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 2
  `).all(input.userId, input.tenantId, like) as ContentPipelineRow[];
  if (fuzzyRows.length === 1) return { status: 'found', row: fuzzyRows[0]! };
  if (fuzzyRows.length > 1) return { status: 'ambiguous' };
  return { status: 'not_found' };
}

function readScopedPipelineRow(
  db: ReturnType<typeof getDb>,
  input: ChatPlannerInput,
  pipelineId: number,
): ContentPipelineRow | null {
  const row = db.prepare(`
    SELECT id, topic_title, stage, stage_history, published_url, published_at, youtube_video_id
      FROM content_pipeline
     WHERE id = ?
       AND user_id = ?
       AND tenant_id = ?
       AND COALESCE(scope_status, 'active') = 'active'
     LIMIT 1
  `).get(pipelineId, input.userId, input.tenantId) as ContentPipelineRow | undefined;
  return row ?? null;
}

function parsePositiveId(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parsePipelineHistory(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry === 'object') : [];
  } catch {
    return [];
  }
}

function extractYouTubeVideoId(url: string): string | null {
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match?.[1] ?? null;
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
