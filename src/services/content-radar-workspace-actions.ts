// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import {
  recordRadarFeedback,
  type ContentRadarFeedbackRecord,
} from '../state/content-radar-feedback';
import {
  CONTENT_WORKSPACE_SCHEMA_VERSION,
  ContentWorkspaceError,
  createContentArtifact,
  createContentWorkspaceItem,
  getContentArtifact,
  getContentWorkspaceItem,
  type ContentArtifact,
  type ContentWorkspaceItem,
  type ContentWorkspaceScope,
} from './content-workspace';

export const CONTENT_RADAR_WORKSPACE_ACTION_SCHEMA_VERSION = 'content-radar-workspace-action-v1';

export type ContentRadarWorkspaceAction = 'save' | 'create_brief';

export interface ContentRadarBriefDraft {
  objective?: string;
  audience?: string;
  platform?: string;
  format?: string;
  angle?: string;
  sourceMaterial?: string[];
  mainPoints?: string[];
  claims?: string[];
  cta?: string;
  constraints?: string;
  deadline?: string;
  approvalOwner?: string;
}

interface NormalizedContentRadarBrief extends Record<string, unknown> {
  schemaVersion: 'content-brief-v1';
  objective: string;
  audience: string;
  platform: string;
  format: string;
  angle: string;
  sourceMaterial: string[];
  mainPoints: string[];
  claims: string[];
  cta: string;
  constraints: string;
  deadline: string;
  approvalOwner: string;
}

export interface RecordContentRadarWorkspaceActionInput {
  scope: ContentWorkspaceScope;
  signalId: string;
  action: ContentRadarWorkspaceAction;
  signalTopic: string;
  signalSummary?: string | null;
  reason?: string | null;
  brief?: ContentRadarBriefDraft | null;
}

export interface ContentRadarWorkspaceActionResult {
  schemaVersion: typeof CONTENT_RADAR_WORKSPACE_ACTION_SCHEMA_VERSION;
  workspaceSchemaVersion: typeof CONTENT_WORKSPACE_SCHEMA_VERSION;
  feedback: ContentRadarFeedbackRecord;
  workspace: {
    item: ContentWorkspaceItem;
    artifact: ContentArtifact;
    revisionId: number;
  };
  mutation: {
    replayed: boolean;
  };
}

/**
 * Materialize a user-selected radar signal and its ranking feedback in one
 * transaction. A committed response can be lost safely: replaying the same
 * scoped signal/action returns the original canonical item/artifact/revision.
 */
export function recordContentRadarWorkspaceAction(
  input: RecordContentRadarWorkspaceActionInput,
  db: Database.Database = getDb(),
): ContentRadarWorkspaceActionResult {
  const scope = normalizeScope(input.scope);
  const signalId = requiredText(input.signalId, 'signalId', 120);
  const action = normalizeAction(input.action);
  const signalTopic = requiredText(input.signalTopic, 'signalTopic', 240);
  const signalSummary = optionalText(input.signalSummary, 'signalSummary', 2_000);
  const reason = optionalText(input.reason, 'reason', 600);
  const brief = action === 'create_brief'
    ? normalizeBrief(input.brief, signalTopic, signalSummary)
    : null;
  const briefSnapshotHash = brief ? digest(brief) : null;
  const identity = digest({ source: 'reaction_radar', signalId, action });

  return db.transaction((): ContentRadarWorkspaceActionResult => {
    const feedback = recordRadarFeedback(scope.userId, scope.tenantId, {
      signalId,
      action,
      reason,
      signalTopic,
      signalSummary,
    }, db);

    const existing = findMaterializedRadarAction(scope, signalId, action, db);
    if (existing) {
      return buildResult(feedback, existing.item, existing.artifact, true);
    }

    const itemMutation = createContentWorkspaceItem({
      scope,
      itemType: 'content_item',
      title: signalTopic,
      summary: signalSummary,
      platformId: brief?.platform || null,
      formatId: brief?.format || null,
      idempotencyKey: `radar-workspace-item:${identity}`,
    }, db);

    const artifactMutation = createContentArtifact({
      scope,
      itemId: itemMutation.value.id,
      expectedWorkflowVersion: itemMutation.value.workflowVersion,
      artifactType: action === 'create_brief' ? 'brief' : 'idea_note',
      title: signalTopic,
      platformId: brief?.platform || null,
      formatId: brief?.format || null,
      metadata: {
        radarActionSchemaVersion: CONTENT_RADAR_WORKSPACE_ACTION_SCHEMA_VERSION,
        captureOrigin: 'reaction_radar',
        radarSignalId: signalId,
        radarAction: action,
        radarFeedbackId: feedback.id,
        briefSnapshot: brief,
        briefSnapshotHash,
      },
      initialContent: action === 'create_brief'
        ? { format: 'markdown', text: renderBriefMarkdown(signalTopic, brief!) }
        : {
            format: 'plain_text',
            text: signalSummary ? `${signalTopic}\n\n${signalSummary}` : signalTopic,
          },
      changeSummary: action === 'create_brief'
        ? 'Created a brief from a user-selected radar signal'
        : 'Saved a user-selected radar signal as an idea',
      actorType: 'user',
      actorId: String(scope.userId),
      provenance: {
        radarActionSchemaVersion: CONTENT_RADAR_WORKSPACE_ACTION_SCHEMA_VERSION,
        captureOrigin: 'reaction_radar',
        radarSignalId: signalId,
        radarAction: action,
        radarFeedbackId: feedback.id,
        briefSnapshotHash,
      },
      idempotencyKey: `radar-workspace-artifact:${identity}`,
    }, db);

    const item = getContentWorkspaceItem(scope, itemMutation.value.id, db);
    if (!item || artifactMutation.value.currentRevisionId == null) {
      throw new ContentWorkspaceError(
        'CONTENT_RADAR_WORKSPACE_INTEGRITY_FAILED',
        'The radar action was not readable from the canonical Content workspace.',
        500,
      );
    }
    return buildResult(
      feedback,
      item,
      artifactMutation.value,
      itemMutation.replayed || artifactMutation.replayed,
    );
  }).immediate();
}

function findMaterializedRadarAction(
  scope: ContentWorkspaceScope,
  signalId: string,
  action: ContentRadarWorkspaceAction,
  db: Database.Database,
): { item: ContentWorkspaceItem; artifact: ContentArtifact } | null {
  const row = db.prepare(`
    SELECT artifact.id AS artifact_id,
           item.id AS item_id,
           artifact.scope_status AS artifact_scope_status,
           item.scope_status AS item_scope_status,
           item.deleted_at
      FROM content_artifacts AS artifact
      JOIN content_domain_objects AS item
        ON item.id = artifact.item_id
       AND item.tenant_id = artifact.tenant_id
       AND item.owner_user_id = artifact.owner_user_id
     WHERE artifact.tenant_id = ?
       AND artifact.owner_user_id = ?
       AND artifact.visibility_scope = 'user_private'
       AND item.visibility_scope = 'user_private'
       AND json_extract(artifact.metadata_json, '$.radarActionSchemaVersion') = ?
       AND json_extract(artifact.metadata_json, '$.radarSignalId') = ?
       AND json_extract(artifact.metadata_json, '$.radarAction') = ?
     ORDER BY artifact.id ASC
     LIMIT 1
  `).get(
    scope.tenantId,
    scope.userId,
    CONTENT_RADAR_WORKSPACE_ACTION_SCHEMA_VERSION,
    signalId,
    action,
  ) as {
    artifact_id: number;
    item_id: number;
    artifact_scope_status: string;
    item_scope_status: string;
    deleted_at: string | null;
  } | undefined;
  if (!row) return null;
  if (row.item_scope_status === 'deleted' || row.deleted_at != null) {
    throw new ContentWorkspaceError(
      'CONTENT_RADAR_ITEM_IN_TRASH',
      'This radar signal is already saved in Trash. Restore that item instead of creating a duplicate.',
      409,
      {
        itemId: Number(row.item_id),
        recovery: 'restore_deleted_workspace_item',
      },
    );
  }
  if (row.item_scope_status !== 'active' || row.artifact_scope_status !== 'active') {
    throw new ContentWorkspaceError(
      'CONTENT_RADAR_WORKSPACE_INTEGRITY_FAILED',
      'The prior radar action is not active. Existing content was preserved for recovery.',
      409,
      { itemId: Number(row.item_id), recovery: 'reload_workspace_item' },
    );
  }
  const item = getContentWorkspaceItem(scope, Number(row.item_id), db);
  const artifact = getContentArtifact(scope, Number(row.artifact_id), db);
  if (!item || !artifact || artifact.itemId !== item.id || artifact.currentRevisionId == null) {
    throw new ContentWorkspaceError(
      'CONTENT_RADAR_WORKSPACE_INTEGRITY_FAILED',
      'The prior radar action is incomplete. Existing content was preserved for recovery.',
      500,
    );
  }
  return { item, artifact };
}

function buildResult(
  feedback: ContentRadarFeedbackRecord,
  item: ContentWorkspaceItem,
  artifact: ContentArtifact,
  replayed: boolean,
): ContentRadarWorkspaceActionResult {
  if (artifact.currentRevisionId == null) {
    throw new ContentWorkspaceError(
      'CONTENT_RADAR_WORKSPACE_INTEGRITY_FAILED',
      'The radar workspace artifact has no current revision.',
      500,
    );
  }
  return {
    schemaVersion: CONTENT_RADAR_WORKSPACE_ACTION_SCHEMA_VERSION,
    workspaceSchemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
    feedback,
    workspace: {
      item,
      artifact,
      revisionId: artifact.currentRevisionId,
    },
    mutation: { replayed },
  };
}

function normalizeScope(scope: ContentWorkspaceScope): ContentWorkspaceScope {
  if (!Number.isSafeInteger(scope?.tenantId) || scope.tenantId <= 0) {
    throw validationError('tenantId', 'tenantId must be a positive integer.');
  }
  if (!Number.isSafeInteger(scope?.userId) || scope.userId <= 0) {
    throw validationError('userId', 'userId must be a positive integer.');
  }
  return { tenantId: scope.tenantId, userId: scope.userId };
}

function normalizeAction(action: unknown): ContentRadarWorkspaceAction {
  if (action !== 'save' && action !== 'create_brief') {
    throw validationError('action', 'action must be save or create_brief.');
  }
  return action;
}

function normalizeBrief(
  value: ContentRadarBriefDraft | null | undefined,
  signalTopic: string,
  signalSummary: string | null,
): NormalizedContentRadarBrief {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
    throw validationError('brief', 'brief must be an object.');
  }
  const brief = value ?? {};
  return {
    schemaVersion: 'content-brief-v1',
    objective: optionalText(brief.objective, 'brief.objective', 2_000) ?? '',
    audience: optionalText(brief.audience, 'brief.audience', 1_000) ?? '',
    platform: optionalText(brief.platform, 'brief.platform', 120) ?? '',
    format: optionalText(brief.format, 'brief.format', 120) ?? '',
    angle: optionalText(brief.angle, 'brief.angle', 2_000) ?? signalTopic,
    sourceMaterial: optionalTextList(brief.sourceMaterial, 'brief.sourceMaterial', 50, 2_000),
    mainPoints: brief.mainPoints === undefined && signalSummary
      ? [signalSummary]
      : optionalTextList(brief.mainPoints, 'brief.mainPoints', 50, 2_000),
    claims: optionalTextList(brief.claims, 'brief.claims', 50, 2_000),
    cta: optionalText(brief.cta, 'brief.cta', 2_000) ?? '',
    constraints: optionalText(brief.constraints, 'brief.constraints', 4_000) ?? '',
    deadline: optionalText(brief.deadline, 'brief.deadline', 240) ?? '',
    approvalOwner: optionalText(brief.approvalOwner, 'brief.approvalOwner', 240) ?? '',
  };
}

function renderBriefMarkdown(title: string, brief: NormalizedContentRadarBrief): string {
  const value = (text: string): string => text || '_Not set_';
  const list = (items: string[]): string => items.length > 0
    ? items.map((item) => `- ${item}`).join('\n')
    : '_Not set_';
  return [
    `# ${title}`,
    '',
    '## Objective', value(brief.objective),
    '',
    '## Audience', value(brief.audience),
    '',
    '## Platform', value(brief.platform),
    '',
    '## Format', value(brief.format),
    '',
    '## Angle', value(brief.angle),
    '',
    '## Source material', list(brief.sourceMaterial),
    '',
    '## Main points', list(brief.mainPoints),
    '',
    '## Claims to verify', list(brief.claims),
    '',
    '## Call to action', value(brief.cta),
    '',
    '## Constraints', value(brief.constraints),
    '',
    '## Deadline', value(brief.deadline),
    '',
    '## Approval owner', value(brief.approvalOwner),
    '',
  ].join('\n');
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const normalized = optionalText(value, field, maxLength);
  if (!normalized) throw validationError(field, `${field} is required.`);
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw validationError(field, `${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw validationError(field, `${field} must be at most ${maxLength} characters.`);
  }
  return normalized;
}

function optionalTextList(
  value: unknown,
  field: string,
  maxItems: number,
  maxItemLength: number,
): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw validationError(field, `${field} must contain at most ${maxItems} strings.`);
  }
  return value.map((entry, index) => requiredText(entry, `${field}[${index}]`, maxItemLength));
}

function validationError(field: string, message: string): ContentWorkspaceError {
  return new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', message, 400, { field });
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
