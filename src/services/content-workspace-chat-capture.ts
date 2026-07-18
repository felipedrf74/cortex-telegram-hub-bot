// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import {
  ContentWorkspaceError,
  createContentArtifact,
  createContentWorkspaceItem,
  getContentArtifact,
  getContentWorkspaceItem,
  type ContentArtifact,
  type ContentWorkspaceItem,
  type ContentWorkspaceScope,
} from './content-workspace';
import {
  deriveCapturedIdeaTitle,
  validateContentIdeaCaptureConsent,
  type ContentIdeaCaptureConsentReceipt,
} from './content-workspace-chat-consent';

export interface ChatContentIdeaCaptureResult {
  item: ContentWorkspaceItem;
  artifact: ContentArtifact;
  replayed: boolean;
  created: boolean;
}

/**
 * Canonical ingress for an explicitly requested chat/Telegram idea capture.
 * The user-authored thought is stored as user content; chat is provenance,
 * not an AI author. Identical retries converge on one private item/artifact.
 */
export function captureChatContentIdea(input: {
  scope: ContentWorkspaceScope;
  content: unknown;
  title?: unknown;
  consentReceipt: ContentIdeaCaptureConsentReceipt;
}, db: Database.Database = getDb()): ChatContentIdeaCaptureResult {
  const content = boundedText(input.content, 'content', 20_000);
  const title = input.title == null
    ? deriveCapturedIdeaTitle(content)
    : boundedText(input.title, 'title', 240);
  const consent = validateContentIdeaCaptureConsent(input.consentReceipt, {
    tenantId: input.scope.tenantId,
    userId: input.scope.userId,
    content,
    title,
  });
  if (!consent.ok) {
    throw new ContentWorkspaceError(
      'CONTENT_CAPTURE_CONSENT_REQUIRED',
      'Content idea capture requires a current explicit user-request receipt.',
      403,
      { reason: consent.code },
    );
  }
  const identity = createHash('sha256')
    .update(JSON.stringify({
      tenantId: input.scope.tenantId,
      userId: input.scope.userId,
      title,
      content,
      source: 'chat_explicit_content_idea_capture',
    }))
    .digest('hex');

  return db.transaction(() => {
    const itemMutation = createContentWorkspaceItem({
      scope: input.scope,
      itemType: 'content_item',
      title,
      summary: content,
      idempotencyKey: `chat-idea-item:${identity}`,
    }, db);
    const existingArtifact = getCapturedIdeaArtifact(
      input.scope,
      itemMutation.value.id,
      `chat-idea-artifact:${identity}`,
      db,
    );
    if (existingArtifact) {
      return {
        item: itemMutation.value,
        artifact: existingArtifact,
        replayed: true,
        created: false,
      };
    }

    const artifactMutation = createContentArtifact({
      scope: input.scope,
      itemId: itemMutation.value.id,
      expectedWorkflowVersion: itemMutation.value.workflowVersion,
      artifactType: 'idea_note',
      title: 'Captured idea',
      initialContent: { format: 'plain_text', text: content },
      changeSummary: 'Captured from an explicit chat request',
      actorType: 'user',
      actorId: String(input.scope.userId),
      provenance: {
        source: 'chat_explicit_content_idea_capture',
        consent: 'explicit_user_request',
        consentReceiptHash: consent.receipt.argumentsHash,
        sourceMessageId: consent.receipt.sourceMessageId,
        importedInstructionsTrusted: false,
      },
      idempotencyKey: `chat-idea-artifact:${identity}`,
    }, db);
    const item = getContentWorkspaceItem(input.scope, itemMutation.value.id, db);
    if (!item) {
      throw new ContentWorkspaceError(
        'CONTENT_WORKSPACE_INTEGRITY_FAILED',
        'Captured Content idea could not be read back.',
        500,
      );
    }
    return {
      item,
      artifact: artifactMutation.value,
      replayed: itemMutation.replayed || artifactMutation.replayed,
      created: artifactMutation.created,
    };
  }).immediate();
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw new ContentWorkspaceError(
      'CONTENT_VALIDATION_FAILED',
      `${field} is required.`,
      400,
      { field },
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) {
    throw new ContentWorkspaceError(
      'CONTENT_VALIDATION_FAILED',
      `${field} must contain 1 to ${max} characters.`,
      400,
      { field },
    );
  }
  return normalized;
}

function getCapturedIdeaArtifact(
  scope: ContentWorkspaceScope,
  itemId: number,
  idempotencyKey: string,
  db: Database.Database,
): ContentArtifact | null {
  const receipt = db.prepare(`
    SELECT resource_id
      FROM content_mutation_receipts
     WHERE tenant_id = ?
       AND owner_user_id = ?
       AND operation = ?
       AND idempotency_key = ?
       AND resource_type = 'artifact'
     LIMIT 1
  `).get(
    scope.tenantId,
    scope.userId,
    `create_artifact:${itemId}`,
    idempotencyKey,
  ) as { resource_id: string } | undefined;
  if (!receipt) return null;
  const artifactId = Number(receipt.resource_id);
  const artifact = Number.isSafeInteger(artifactId) && artifactId > 0
    ? getContentArtifact(scope, artifactId, db)
    : null;
  if (!artifact || artifact.itemId !== itemId || artifact.artifactType !== 'idea_note') {
    throw new ContentWorkspaceError(
      'CONTENT_WORKSPACE_INTEGRITY_FAILED',
      'The captured Content idea receipt no longer resolves to its original artifact.',
      500,
      { itemId },
    );
  }
  return artifact;
}
