// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Destructive-action confirmation flow paired with Decision Center.
//
// This is NOT a duplicate of `chat_pending_actions` (the DB-backed typed
// action-lifecycle table from migration 131). The two stores serve distinct
// concerns:
//
//   chat-pending-confirmations (in-memory, this file)
//     Tracks free-form destructive-action confirmations that pair with a
//     Decision Center entry via the `chat_confirmation` related-entity. Used
//     when the planner emits a destructive-action plan and the engine needs
//     to surface a "Did you really mean to delete X?" decision card. Entry
//     stores actionSummary (free text), involvedSkills, reasonCodes — not
//     typed action data. When the user accepts via the
//     `isAcceptCurrentDecisionShortcut` shortcut, the pending is retrieved
//     and the destructive action is executed.
//
//   chat_pending_actions (DB-backed, chat-action-state.ts)
//     Tracks typed action lifecycle for an action awaiting input,
//     confirmation, or execution. Tied to a specific skill/action with
//     concrete slot data. Powers the iOS pending-action REST handoff.
//
// The architecture audit at 2026-05-15 initially flagged this file as a
// DELETE CANDIDATE assuming it duplicated chat_pending_actions. Caller
// inspection (chat-message-routes.ts + decision-center.ts) showed the
// semantics are distinct: this file is a Decision-Center coupling, not a
// typed action lifecycle. Reclassified as KEEP after that inspection.

import type { NexusSkillId } from './chat-skill-orchestrator';
import type { ChatConfirmedDestructiveTarget } from './chat-tool-authorization';
import { resolveChatTenantId } from './chat-tenant-scope';
import { hashChatConfirmationToken } from './chat-confirmation-token';

export interface PendingChatConfirmation {
  id: string;
  tenantId: number;
  userId: number;
  intentClass?: string;
  summary?: Record<string, unknown>;
  actionSummary: string;
  involvedSkills: NexusSkillId[];
  reasonCodes: string[];
  // ADV-3: typed targets the staged confirmation covers. When present, an
  // accepted confirmation authorizes exactly these destructive calls; when
  // absent, acceptance collapses to a single untyped grant.
  confirmedTargets?: ChatConfirmedDestructiveTarget[];
  sourceMessageId?: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface TrackPendingChatConfirmationInput {
  userId: number;
  tenantId?: number;
  actionSummary: string;
  involvedSkills: NexusSkillId[];
  reasonCodes: string[];
  intentClass?: string;
  summary?: Record<string, unknown>;
  confirmedTargets?: ChatConfirmedDestructiveTarget[];
  sourceMessageId?: string | null;
  ttlMs?: number;
  now?: Date;
}

const DEFAULT_PENDING_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const pendingConfirmations = new Map<string, PendingChatConfirmation>();
const completedConfirmations = new Map<string, CompletedChatConfirmation>();

export interface CompletedChatConfirmation {
  tokenHash: string;
  tenantId: number;
  userId: number;
  expiresAt: string;
  statusCode: number;
  responseBody: unknown;
  completedAt: string;
}

function keyFor(userId: number, tenantId?: number): string {
  return `${resolveChatTenantId(userId, tenantId)}:${userId}`;
}

function sanitizeActionSummary(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 220);
}

const MAX_CONFIRMED_TARGETS = 10;

function sanitizeConfirmedTargets(
  targets: ChatConfirmedDestructiveTarget[] | undefined,
): ChatConfirmedDestructiveTarget[] | undefined {
  if (!targets) return undefined;
  return targets.slice(0, MAX_CONFIRMED_TARGETS).map((target) => ({
    tool: typeof target.tool === 'string' && target.tool.trim() ? target.tool.trim() : undefined,
    targetId: typeof target.targetId === 'string' && target.targetId.trim()
      ? target.targetId.trim().slice(0, 200)
      : undefined,
  }));
}

export function trackPendingChatConfirmation(input: TrackPendingChatConfirmationInput): PendingChatConfirmation {
  const now = input.now ?? new Date();
  const tenantId = resolveChatTenantId(input.userId, input.tenantId);
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_PENDING_CONFIRMATION_TTL_MS));
  const id = `pending-${tenantId}-${input.userId}-${now.getTime()}`;
  const pending: PendingChatConfirmation = {
    id,
    tenantId,
    userId: input.userId,
    intentClass: input.intentClass,
    summary: input.summary,
    actionSummary: sanitizeActionSummary(input.actionSummary),
    involvedSkills: [...new Set(input.involvedSkills)],
    reasonCodes: [...new Set(input.reasonCodes)],
    confirmedTargets: sanitizeConfirmedTargets(input.confirmedTargets),
    sourceMessageId: input.sourceMessageId ?? null,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  pendingConfirmations.set(keyFor(input.userId, tenantId), pending);
  return pending;
}

export function getPendingChatConfirmation(userId: number, tenantId?: number, now = new Date()): PendingChatConfirmation | null {
  const pending = pendingConfirmations.get(keyFor(userId, tenantId));
  if (!pending) return null;
  if (new Date(pending.expiresAt).getTime() <= now.getTime()) {
    pendingConfirmations.delete(keyFor(userId, tenantId));
    return null;
  }
  return pending;
}

export function clearPendingChatConfirmation(userId: number, tenantId?: number): boolean {
  return pendingConfirmations.delete(keyFor(userId, tenantId));
}

export function rememberCompletedChatConfirmation(input: {
  confirmationToken: string;
  userId: number;
  tenantId?: number;
  expiresAt: string;
  statusCode: number;
  responseBody: unknown;
  now?: Date;
}): CompletedChatConfirmation {
  const tenantId = resolveChatTenantId(input.userId, input.tenantId);
  const completed: CompletedChatConfirmation = {
    tokenHash: hashChatConfirmationToken(input.confirmationToken),
    tenantId,
    userId: input.userId,
    expiresAt: input.expiresAt,
    statusCode: input.statusCode,
    responseBody: input.responseBody,
    completedAt: (input.now ?? new Date()).toISOString(),
  };
  completedConfirmations.set(completed.tokenHash, completed);
  return completed;
}

export function getCompletedChatConfirmation(
  confirmationToken: string,
  userId: number,
  tenantId?: number,
  now = new Date(),
): CompletedChatConfirmation | null {
  const completed = completedConfirmations.get(hashChatConfirmationToken(confirmationToken));
  if (!completed) return null;
  if (completed.userId !== userId || completed.tenantId !== resolveChatTenantId(userId, tenantId)) return null;
  if (new Date(completed.expiresAt).getTime() <= now.getTime()) {
    completedConfirmations.delete(completed.tokenHash);
    return null;
  }
  return completed;
}

export function resetPendingChatConfirmationsForTests(): void {
  pendingConfirmations.clear();
  completedConfirmations.clear();
}
