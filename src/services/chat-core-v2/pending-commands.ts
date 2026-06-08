// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { resolveChatTenantId } from '../chat-tenant-scope';
import type { AICommandEnvelope } from './types';

export interface PendingChatCoreV2Command {
  commandId: string;
  tenantId: number;
  userId: number;
  capabilityId: string;
  command: AICommandEnvelope<Record<string, unknown>>;
  normalizedText?: string;
  locale?: string | null;
  timezone?: string | null;
  conversationId?: string;
  messageId?: string;
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
}

export type ClaimPendingChatCoreV2CommandResult =
  | { status: 'claimed'; pending: PendingChatCoreV2Command }
  | { status: 'missing' | 'expired' | 'already_claimed' };

const pendingCommands = new Map<string, PendingChatCoreV2Command>();

function keyFor(commandId: string, userId: number, tenantId?: number): string {
  return `${resolveChatTenantId(userId, tenantId)}:${userId}:${commandId}`;
}

export function trackPendingChatCoreV2Command(input: {
  userId: number;
  tenantId?: number;
  capabilityId: string;
  command: AICommandEnvelope<Record<string, unknown>>;
  normalizedText?: string;
  locale?: string | null;
  timezone?: string | null;
  conversationId?: string;
  messageId?: string;
  now?: Date;
}): PendingChatCoreV2Command {
  const tenantId = resolveChatTenantId(input.userId, input.tenantId);
  const pending: PendingChatCoreV2Command = {
    commandId: input.command.commandId,
    tenantId,
    userId: input.userId,
    capabilityId: input.capabilityId,
    command: input.command,
    normalizedText: input.normalizedText,
    locale: input.locale,
    timezone: input.timezone,
    conversationId: input.conversationId,
    messageId: input.messageId,
    createdAt: (input.now ?? new Date()).toISOString(),
    expiresAt: input.command.expiresAt,
  };
  pendingCommands.set(keyFor(input.command.commandId, input.userId, tenantId), pending);
  return pending;
}

export function getPendingChatCoreV2Command(
  commandId: string,
  userId: number,
  tenantId?: number,
  now = new Date(),
): PendingChatCoreV2Command | null {
  const key = keyFor(commandId, userId, tenantId);
  const pending = pendingCommands.get(key);
  if (!pending) return null;
  if (Date.parse(pending.expiresAt) <= now.getTime()) {
    pendingCommands.delete(key);
    return null;
  }
  return pending;
}

export function claimPendingChatCoreV2Command(
  commandId: string,
  userId: number,
  tenantId?: number,
  now = new Date(),
): ClaimPendingChatCoreV2CommandResult {
  const key = keyFor(commandId, userId, tenantId);
  const pending = pendingCommands.get(key);
  if (!pending) return { status: 'missing' };
  if (Date.parse(pending.expiresAt) <= now.getTime()) {
    pendingCommands.delete(key);
    return { status: 'expired' };
  }
  if (pending.claimedAt) return { status: 'already_claimed' };
  pending.claimedAt = now.toISOString();
  pendingCommands.set(key, pending);
  return { status: 'claimed', pending };
}

export function clearPendingChatCoreV2Command(commandId: string, userId: number, tenantId?: number): boolean {
  return pendingCommands.delete(keyFor(commandId, userId, tenantId));
}

export function clearPendingChatCoreV2CommandsForScope(input: {
  userId: number;
  tenantId?: number;
  conversationId?: string | null;
}): number {
  const tenantId = resolveChatTenantId(input.userId, input.tenantId);
  let cleared = 0;
  for (const [key, pending] of pendingCommands.entries()) {
    if (pending.userId !== input.userId || pending.tenantId !== tenantId) continue;
    if (input.conversationId && pending.conversationId !== input.conversationId) continue;
    pendingCommands.delete(key);
    cleared++;
  }
  return cleared;
}

export function resetPendingChatCoreV2CommandsForTests(): void {
  pendingCommands.clear();
}
