// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { claimChatActionRunForExecution, updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import { upsertPendingChatAction } from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import {
  CONTENT_AGENCY_PACKAGE_GENERATOR_CONTRACT_VERSION,
  ContentAgencyIntegrityError,
  ContentAgencyPackageVersionError,
  ContentAgencyValidationError,
  buildContentAgencyBrief,
  buildContentAgencyPackage,
  getContentAgencyPackage,
  handoffContentAgencyPackageToWorkspace,
  persistContentAgencyPackageBundle,
  type ContentAgencyBriefInput,
  type ContentAgencyPackageInput,
} from '../../content-agency';
import { createContentTopicCompatibility, getContentTopicCompatibility } from '../../content-topic-workspace-compat';
import { createContentSchedulePreview } from '../../content-workspace-scheduling';
import {
  claimActionRunForStepExecution,
  reconciliationPendingResult,
  replayDuplicateClaimedActionRun,
  updateClaimedActionRun,
} from '../../chat/executor/helpers';
import { getDb } from '../../database';
import {
  getContentWorkspaceItem,
  listContentArtifacts,
  type ContentWorkspaceItem,
  type ContentWorkspaceScope,
} from '../../content-workspace';
import { normalizeContentPipelineTransitionStage } from './pipeline-stage';
import { missingContentAgencySlots } from './helpers';
import { invalidateContentDerivedCaches } from '../../cache-coherence-registry';

export function executeContentAgencyStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const rawArgs: unknown = step.args;
  const claim = persistRuns ? claimChatActionRunForExecution({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    normalizedActionHash: step.idempotencyKey,
    provider: 'nexus',
    actionType: step.action,
    risk: step.risk,
    request: rawArgs,
    nowIso: plan.createdAt,
  }) : null;
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim && !claim.acquired && claim.row.status === 'verified_pending') {
    return { step, status: 'verified_pending', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim && !claim.acquired) {
    const replay = replayDuplicateClaimedActionRun(claim, step);
    if (replay) return replay;
  }
  try {
    const args = requireContentAgencyExecutorRecord(rawArgs, 'args');
    const directMissing = missingContentAgencySlots(step.action, args);
    if (step.action === 'content_rewrite' && directMissing.length > 0) {
      const result = { missingSlots: directMissing, verified: false };
      if (!updateClaimedActionRun(claim, 'blocked', {
        result,
        verification: { verified: false, reason: 'content_rewrite_input_required' },
        error: { reason: 'content_rewrite_input_required', missingSlots: directMissing },
      })) return reconciliationPendingResult(step, 'blocked');
      return { step, status: 'blocked', result, error: 'content_rewrite_input_required' };
    }
    const prepared = preparePrivateContentAgencyRequest(step, args, input);
    const pkg = buildContentAgencyPackage(prepared.packageInput, {
      generatorContractVersion: CONTENT_AGENCY_PACKAGE_GENERATOR_CONTRACT_VERSION,
    });
    const missing = missingContentAgencySlots(step.action, prepared.slotArgs);
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
        providerObjectId: result.pendingActionId || undefined,
        verification: { verified: false, reason: 'content_spec_input_required', pendingActionId: result.pendingActionId },
      })) return reconciliationPendingResult(step, 'verified_pending');
      return { step, status: 'verified_pending', result };
    }
    persistContentAgencyPackageBundle(pkg);
    const readBack = getContentAgencyPackage({ userId: input.userId, tenantId: input.tenantId, id: pkg.id });
    const verified = readBack?.id === pkg.id
      && readBack.contentHash === pkg.contentHash
      && readBack.generatorContractVersion === CONTENT_AGENCY_PACKAGE_GENERATOR_CONTRACT_VERSION;
    const result = {
      packageId: pkg.id,
      brief: pkg.brief,
      firstScript: pkg.scriptVariants[0] ?? null,
      quality: pkg.quality,
      verified,
      sourceTextPreserved: prepared.sourceText
        ? !pkg.transcriptStudy.warnings.includes('transcript_missing')
        : undefined,
    };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: pkg.id,
      verification: { verified, expected: { packageId: pkg.id } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result };
  } catch (err) {
    const failure = contentAgencyExecutorFailure(err);
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: failure.audit });
    return { step, status: 'failed', error: failure.publicCode };
  }
}

interface PreparedContentAgencyRequest {
  packageInput: ContentAgencyPackageInput;
  slotArgs: Record<string, unknown>;
  sourceText: string | null;
}

function preparePrivateContentAgencyRequest(
  step: ChatPlanStep,
  args: Record<string, unknown>,
  input: ChatPlannerInput,
): PreparedContentAgencyRequest {
  const scopedArgs = bindPrivateContentAgencyExecutorScope(args, input, 'args');
  const nestedBrief = bindPrivateContentAgencyExecutorScope(scopedArgs.brief, input, 'args.brief');

  // Validate both accepted shapes independently so malformed fields cannot be
  // hidden by a valid value in the other shape during the compatibility merge.
  buildContentAgencyBrief(scopedArgs as unknown as ContentAgencyBriefInput);
  if (scopedArgs.brief !== undefined && scopedArgs.brief !== null) {
    buildContentAgencyBrief(nestedBrief as unknown as ContentAgencyBriefInput);
  }

  if (scopedArgs.generatorContractVersion !== undefined
    && scopedArgs.generatorContractVersion !== CONTENT_AGENCY_PACKAGE_GENERATOR_CONTRACT_VERSION) {
    throw new ContentAgencyValidationError(
      `args.generatorContractVersion must be ${CONTENT_AGENCY_PACKAGE_GENERATOR_CONTRACT_VERSION}.`,
      'args.generatorContractVersion',
    );
  }

  const isRewrite = step.action === 'content_rewrite';
  const requestedOutput = isRewrite
    ? 'rewrite'
    : step.action === 'content_script_create'
      ? 'script'
      : 'brief';
  if (scopedArgs.requestedOutput !== undefined
    && scopedArgs.requestedOutput !== null
    && scopedArgs.requestedOutput !== requestedOutput) {
    throw new ContentAgencyValidationError(
      `args.requestedOutput must be ${requestedOutput} for ${step.action}.`,
      'args.requestedOutput',
    );
  }

  const goal = firstContentAgencyText([
    { value: scopedArgs.goal, field: 'args.goal' },
    { value: nestedBrief.goal, field: 'args.brief.goal' },
    { value: scopedArgs.objective, field: 'args.objective' },
    { value: nestedBrief.objective, field: 'args.brief.objective' },
    { value: scopedArgs.topic, field: 'args.topic' },
  ], isRewrite ? 'Rewrite user supplied content' : 'Create content from chat request');
  const objective = firstContentAgencyText([
    { value: scopedArgs.objective, field: 'args.objective' },
    { value: nestedBrief.objective, field: 'args.brief.objective' },
    { value: scopedArgs.topic, field: 'args.topic' },
    { value: scopedArgs.goal, field: 'args.goal' },
    { value: nestedBrief.goal, field: 'args.brief.goal' },
  ], isRewrite
    ? 'Rewrite the supplied content while preserving the user intent.'
    : input.text);
  const explicitSourceText = isRewrite
    ? firstOptionalContentAgencyText([
      { value: scopedArgs.sourceText, field: 'args.sourceText' },
    ])
    : null;
  const sourceText = isRewrite ? explicitSourceText : null;
  const transcript = isRewrite
    ? sourceText
    : preferredContentAgencyValue(scopedArgs, nestedBrief, 'transcript');
  const platform = preferredContentAgencyValue(scopedArgs, nestedBrief, 'platform');
  const brief: ContentAgencyBriefInput = {
    ...nestedBrief,
    userId: input.userId,
    tenantId: input.tenantId,
    visibilityScope: 'user_private',
    goal,
    objective,
    audience: preferredContentAgencyValue(scopedArgs, nestedBrief, 'audience') as string | null | undefined,
    offer: preferredContentAgencyValue(scopedArgs, nestedBrief, 'offer') as string | null | undefined,
    platform: platform as string | null | undefined,
    format: preferredContentAgencyValue(scopedArgs, nestedBrief, 'format') as string | null | undefined,
    constraints: preferredContentAgencyValue(scopedArgs, nestedBrief, 'constraints') as string[] | null | undefined,
    currentMetrics: preferredContentAgencyValue(scopedArgs, nestedBrief, 'currentMetrics') as Record<string, unknown> | null | undefined,
    brandVoice: preferredContentAgencyValue(scopedArgs, nestedBrief, 'brandVoice') as string | null | undefined,
    notes: (preferredContentAgencyValue(scopedArgs, nestedBrief, 'notes') ?? input.text) as string | null | undefined,
  };
  const packageInput: ContentAgencyPackageInput = {
    userId: input.userId,
    tenantId: input.tenantId,
    brief,
    competitors: scopedArgs.competitors as ContentAgencyPackageInput['competitors'],
    transcript: transcript as string | null | undefined,
    brandedContent: scopedArgs.brandedContent as boolean | null | undefined,
    references: scopedArgs.references as string[] | null | undefined,
    requestedOutput,
  };

  return {
    packageInput,
    slotArgs: {
      ...args,
      goal,
      objective,
      topic: firstOptionalContentAgencyText([
        { value: scopedArgs.topic, field: 'args.topic' },
        { value: goal, field: 'args.goal' },
      ]),
      platform,
    },
    sourceText: isRewrite && explicitSourceText ? explicitSourceText : null,
  };
}

function requireContentAgencyExecutorRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContentAgencyValidationError(`${field} must be an object.`, field);
  }
  return value as Record<string, unknown>;
}

function bindPrivateContentAgencyExecutorScope(
  value: unknown,
  input: ChatPlannerInput,
  field: string,
): Record<string, unknown> {
  const candidate = value === undefined || value === null
    ? {}
    : requireContentAgencyExecutorRecord(value, field);
  if (candidate.userId !== undefined && candidate.userId !== input.userId) {
    throw new ContentAgencyValidationError(
      `${field}.userId must match the authenticated user.`,
      `${field}.userId`,
    );
  }
  if (candidate.tenantId !== undefined && candidate.tenantId !== input.tenantId) {
    throw new ContentAgencyValidationError(
      `${field}.tenantId must match the authenticated tenant.`,
      `${field}.tenantId`,
    );
  }
  if (candidate.visibilityScope !== undefined && candidate.visibilityScope !== 'user_private') {
    throw new ContentAgencyValidationError(
      `${field}.visibilityScope must be user_private for chat Content Agency execution.`,
      `${field}.visibilityScope`,
    );
  }
  return {
    ...candidate,
    userId: input.userId,
    tenantId: input.tenantId,
    visibilityScope: 'user_private',
  };
}

function preferredContentAgencyValue(
  args: Record<string, unknown>,
  nestedBrief: Record<string, unknown>,
  field: string,
): unknown {
  return args[field] !== undefined ? args[field] : nestedBrief[field];
}

function firstContentAgencyText(
  candidates: Array<{ value: unknown; field: string }>,
  fallback: string,
): string {
  return firstOptionalContentAgencyText(candidates) ?? fallback;
}

function firstOptionalContentAgencyText(
  candidates: Array<{ value: unknown; field: string }>,
): string | null {
  for (const candidate of candidates) {
    if (candidate.value === undefined || candidate.value === null) continue;
    if (typeof candidate.value !== 'string') {
      throw new ContentAgencyValidationError(`${candidate.field} must be a string.`, candidate.field);
    }
    const normalized = candidate.value.trim();
    if (normalized) return normalized;
  }
  return null;
}

function contentAgencyExecutorFailure(error: unknown): {
  publicCode: string;
  audit: Record<string, string>;
} {
  if (error instanceof ContentAgencyValidationError) {
    return {
      publicCode: error.code,
      audit: { code: error.code, field: error.field },
    };
  }
  if (error instanceof ContentAgencyIntegrityError || error instanceof ContentAgencyPackageVersionError) {
    return {
      publicCode: error.code,
      audit: { code: error.code },
    };
  }
  return {
    publicCode: 'content_agency_package_failed',
    audit: safeContentExecutorAuditError(error, 'CONTENT_AGENCY_INTERNAL_ERROR'),
  };
}

function safeContentExecutorAuditError(
  error: unknown,
  fallbackCode = 'CONTENT_EXECUTOR_INTERNAL_ERROR',
): Record<string, string> {
  const candidate = error as { name?: unknown; code?: unknown } | null;
  return {
    code: safeContentAgencyErrorToken(candidate?.code, fallbackCode),
    errorName: safeContentAgencyErrorToken(candidate?.name, typeof error),
  };
}

function safeContentAgencyErrorToken(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value)
    ? value
    : fallback;
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
    let itemCreated = false;
    const item = lookup.status === 'found'
      ? lookup.item
      : (() => {
          const topicMutation = createContentTopicCompatibility({
            scope,
            title,
            notes: typeof args.notes === 'string' ? args.notes : 'Created from Chat action.',
            status: 'planned',
            source: 'chat_action',
            idempotencyKey: childIdempotencyKey(step.idempotencyKey, 'item'),
          }, db);
          itemCreated = topicMutation.created && !topicMutation.replayed;
          return getContentWorkspaceItem(scope, topicMutation.topic.workspace_item_id, db)!;
        })();
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
    if (itemCreated || preview.changed) {
      invalidateContentDerivedCaches(input.userId);
    }
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
    if (claim) updateChatActionRun(claim.row.id, 'failed', {
      error: safeContentExecutorAuditError(err, 'CONTENT_SCHEDULE_INTERNAL_ERROR'),
    });
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
    if (handoff.changed) invalidateContentDerivedCaches(input.userId);
    const status: ChatActionRunStatus = verified ? 'verified_success' : handoff.status === 'blocked' ? 'blocked' : 'failed';
    if (!updateClaimedActionRun(claim, status, {
      result: handoff,
      providerObjectId: handoff.pipelineId != null ? String(handoff.pipelineId) : packageId,
      verification: { verified, expected: { packageId }, actual: { status: handoff.status, pipelineId: handoff.pipelineId } },
      error: verified ? undefined : { reason: handoff.blockers[0] ?? handoff.status },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result: handoff, error: verified ? undefined : handoff.blockers[0] ?? 'content_pipeline_handoff_failed' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', {
      error: safeContentExecutorAuditError(err, 'CONTENT_PIPELINE_HANDOFF_INTERNAL_ERROR'),
    });
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
  const requestedStage = typeof args.targetStage === 'string' ? args.targetStage.trim().toLowerCase() : null;
  if (requestedStage === 'published') {
    return { step, status: 'blocked', error: 'content_publication_tracking_not_supported' };
  }
  if (requestedStage === 'filmed' || requestedStage === 'editing') {
    return { step, status: 'blocked', error: 'content_production_stage_not_modeled' };
  }
  const targetStage = normalizeContentPipelineTransitionStage(args.targetStage);
  if (!topicTitle || !targetStage) return { step, status: 'blocked', error: 'content_pipeline_stage_requires_topic_and_stage' };

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
    const verified = true;
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
    const status: ChatActionRunStatus = 'verified_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: String(item.id),
      verification: {
        verified,
        expected: { stage: targetStage, savedScriptRevision: true },
        actual: { stage: 'scripted', revisionId: script.currentRevision.id },
      },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', {
      error: safeContentExecutorAuditError(err, 'CONTENT_PIPELINE_STAGE_INTERNAL_ERROR'),
    });
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
