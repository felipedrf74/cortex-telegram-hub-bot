// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { claimChatActionRunForExecution, updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import { upsertPendingChatAction } from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import { buildContentAgencyPackage, getContentAgencyProject, handoffContentAgencyPackageToWorkspace, persistContentAgencyArtifact } from '../../content-agency';
import { createContentTopicCompatibility, getContentTopicCompatibility } from '../../content-topic-workspace-compat';
import { createContentSchedulePreview } from '../../content-workspace-scheduling';
import { claimActionRunForStepExecution, reconciliationPendingResult, updateClaimedActionRun } from '../../chat/executor/helpers';
import { getDb } from '../../database';
import {
  getContentWorkspaceItem,
  listContentArtifacts,
  type ContentWorkspaceItem,
  type ContentWorkspaceScope,
} from '../../content-workspace';
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
  const requestText = [input.text, typeof args.rawRequest === 'string' ? args.rawRequest : ''].join(' ');
  if (hasPublicationExecutionSemantics(requestText)) {
    return { step, status: 'blocked', error: 'content_publication_execution_not_supported' };
  }
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : null;
  const dateTime = typeof args.dateTime === 'string' && args.dateTime.trim() ? DateTime.fromISO(args.dateTime, { zone: input.timezone }) : null;
  if (!title || !dateTime?.isValid) return { step, status: 'blocked', error: 'content_schedule_requires_title_and_datetime' };
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim && !claim.acquired && claim.row.status === 'verified_pending') {
    return { step, status: 'verified_pending', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    const db = getDb();
    const scope = { tenantId: input.tenantId, userId: input.userId };
    const lookup = findScopedWorkspaceItem(db, scope, args, title);
    if (lookup.status === 'ambiguous') {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', { error: { reason: 'content_schedule_item_ambiguous', title } });
      return { step, status: 'blocked', error: 'content_schedule_item_ambiguous' };
    }
    const item = lookup.status === 'found'
      ? lookup.item
      : getContentWorkspaceItem(scope, createContentTopicCompatibility({
        scope,
        title,
        notes: typeof args.notes === 'string' ? args.notes : 'Created from Chat action.',
        status: 'planned',
        source: 'chat_action',
        idempotencyKey: childIdempotencyKey(step.idempotencyKey, 'item'),
      }, db).topic.workspace_item_id, db)!;
    const durationMinutes = Number.isSafeInteger(args.durationMinutes)
      ? Math.min(480, Math.max(15, Number(args.durationMinutes)))
      : 60;
    const start = dateTime.toUTC();
    const end = start.plus({ minutes: durationMinutes });
    const preview = createContentSchedulePreview({
      scope,
      itemId: item.id,
      artifactId: item.currentArtifactId ?? undefined,
      workKind: contentWorkKind(requestText),
      durationMinutes,
      preferredWindows: [{ start: start.toISO()!, end: end.toISO()! }],
      priority: 'normal',
      shareContentTitle: false,
      idempotencyKey: childIdempotencyKey(step.idempotencyKey, 'preview'),
      now: input.nowIso,
    }, db);
    const result = {
      workspaceItemId: item.id,
      preview: preview.value,
      persistence: 'content_workspace',
      verified: false,
      scheduleKind: 'private_work_preview',
      calendarEventCreated: false,
      publicationExecution: 'not_performed',
      confirmationRequired: true,
    };
    const status: ChatActionRunStatus = 'verified_pending';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: preview.value.previewKey,
      verification: {
        verified: false,
        reason: 'explicit_content_schedule_confirmation_required',
        expected: { itemId: item.id, requestedStart: start.toISO(), durationMinutes },
      },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'content_schedule_failed' };
  }
}

function contentWorkKind(requestText: string): 'write' | 'revise' | 'record' | 'edit' | 'review' {
  const folded = requestText.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(record|recording|film|filming|gravar|gravacao|graba|grabar|grabacion)\b/.test(folded)) return 'record';
  if (/\b(edit|editing|editar|edicao|edicion)\b/.test(folded)) return 'edit';
  if (/\b(revise|revision|rewrite|reescrever|revisar|reescritura)\b/.test(folded)) return 'revise';
  if (/\b(review|approve|rever|aprovar|revisar)\b/.test(folded)) return 'review';
  return 'write';
}

function childIdempotencyKey(parent: string, suffix: string): string {
  return `${parent.slice(0, Math.max(8, 199 - suffix.length))}:${suffix}`;
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
    const handoff = handoffContentAgencyPackageToWorkspace({
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

type ContentWorkspaceLookupResult =
  | { status: 'found'; item: ContentWorkspaceItem }
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
  if (targetStage === 'published') {
    return { step, status: 'blocked', error: 'content_publication_tracking_not_supported' };
  }
  if (targetStage === 'filmed' || targetStage === 'editing') {
    return { step, status: 'blocked', error: 'content_production_stage_not_modeled' };
  }

  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }

  try {
    const db = getDb();
    const scope = { tenantId: input.tenantId, userId: input.userId };
    const lookup = findScopedWorkspaceItem(db, scope, args, topicTitle);
    if (lookup.status === 'ambiguous') {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', { error: { reason: 'content_pipeline_item_ambiguous', topicTitle } });
      return { step, status: 'blocked', error: 'content_pipeline_item_ambiguous' };
    }
    if (lookup.status === 'not_found') {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', { error: { reason: 'content_pipeline_item_not_found', topicTitle } });
      return { step, status: 'blocked', error: 'content_pipeline_item_not_found' };
    }
    const item = lookup.item;
    const script = listContentArtifacts(scope, item.id, db)
      .filter((artifact) => artifact.artifactType === 'script' && artifact.currentRevision != null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!script?.currentRevision) {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', {
        error: { reason: 'content_pipeline_script_revision_required', workspaceItemId: item.id },
      });
      return { step, status: 'blocked', error: 'content_pipeline_script_revision_required' };
    }
    const currentStage = item.productionState === 'published'
      ? 'published'
      : item.artifactPhase === 'idea' || item.artifactPhase === 'brief' || item.artifactPhase === 'outline'
        ? 'idea'
        : 'scripted';
    const verified = targetStage === 'scripted';
    const result = {
      pipelineId: item.id,
      workspaceItemId: item.id,
      workspaceArtifactId: script.id,
      workspaceRevisionId: script.currentRevision.id,
      pipelineIdIsWorkspaceAlias: true,
      persistence: 'content_workspace',
      topicTitle: item.title,
      fromStage: currentStage,
      targetStage,
      stage: 'scripted',
      productionState: item.productionState,
      artifactPhase: item.artifactPhase,
      workflowVersion: item.workflowVersion,
      changed: false,
      verified,
    };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'blocked';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: String(item.id),
      verification: {
        verified,
        expected: { stage: targetStage, savedScriptRevision: true },
        actual: { stage: 'scripted', revisionId: script.currentRevision.id },
      },
      error: verified ? undefined : { reason: 'content_production_stage_not_modeled' },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'content_production_stage_not_modeled' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'content_pipeline_stage_transition_failed' };
  }
}

function findScopedWorkspaceItem(
  db: ReturnType<typeof getDb>,
  scope: ContentWorkspaceScope,
  args: Record<string, unknown>,
  topicTitle: string,
): ContentWorkspaceLookupResult {
  const workspaceItemId = parsePositiveId(args.workspaceItemId);
  if (workspaceItemId != null) {
    const explicit = getContentWorkspaceItem(scope, workspaceItemId, db);
    return explicit ? { status: 'found', item: explicit } : { status: 'not_found' };
  }
  const pipelineId = parsePositiveId(args.pipelineId);
  if (pipelineId != null) {
    const direct = getContentWorkspaceItem(scope, pipelineId, db);
    const binding = db.prepare(`
      SELECT item_id
        FROM content_workspace_ingress_bindings
       WHERE tenant_id = ?
         AND owner_user_id = ?
         AND source_kind = 'legacy_pipeline'
         AND source_id = ?
       LIMIT 1
    `).get(scope.tenantId, scope.userId, String(pipelineId)) as { item_id: number } | undefined;
    const migrated = binding ? getContentWorkspaceItem(scope, Number(binding.item_id), db) : null;
    if (direct && migrated && direct.id !== migrated.id) return { status: 'ambiguous' };
    const item = migrated ?? direct;
    return item ? { status: 'found', item } : { status: 'not_found' };
  }
  const exactRows = db.prepare(`
    SELECT id
      FROM content_domain_objects
     WHERE tenant_id = ?
       AND owner_user_id = ?
       AND visibility_scope = 'user_private'
       AND scope_status = 'active'
       AND deleted_at IS NULL
       AND object_type = 'content_item'
       AND LOWER(title) = LOWER(?)
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 2
  `).all(scope.tenantId, scope.userId, topicTitle) as Array<{ id: number }>;
  if (exactRows.length === 1) {
    const item = getContentWorkspaceItem(scope, Number(exactRows[0]!.id), db);
    return item ? { status: 'found', item } : { status: 'not_found' };
  }
  if (exactRows.length > 1) return { status: 'ambiguous' };

  const like = `%${escapeSqlLike(topicTitle.slice(0, 48))}%`;
  const fuzzyRows = db.prepare(`
    SELECT id
      FROM content_domain_objects
     WHERE tenant_id = ?
       AND owner_user_id = ?
       AND visibility_scope = 'user_private'
       AND scope_status = 'active'
       AND deleted_at IS NULL
       AND object_type = 'content_item'
       AND LOWER(title) LIKE LOWER(?) ESCAPE '\\'
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 2
  `).all(scope.tenantId, scope.userId, like) as Array<{ id: number }>;
  if (fuzzyRows.length === 1) {
    const item = getContentWorkspaceItem(scope, Number(fuzzyRows[0]!.id), db);
    return item ? { status: 'found', item } : { status: 'not_found' };
  }
  if (fuzzyRows.length > 1) return { status: 'ambiguous' };
  return { status: 'not_found' };
}

function parsePositiveId(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function hasPublicationExecutionSemantics(text: string): boolean {
  const folded = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const hasWorkNoun = /\b(content\s+work|filming|recording|writing|editing|shoot|session|work\s+block|gravacao|filmagem|escrita|edicao|sessao|bloco|rodaje|grabacion|escritura|edicion|sesion|bloque)\b/.test(folded);
  if (hasWorkNoun) return false;
  return /\b(publish|publicar|publica|post|postar|postea|upload|subir|queue|go\s+live)\b/.test(folded)
    || (/\b(schedule|agenda|agendar|programa|programar)\b/.test(folded)
      && /\b(content|conteudo|contenido|reel|video|post|script|roteiro|guion|publication|publicacao|publicacion)\b/.test(folded));
}
