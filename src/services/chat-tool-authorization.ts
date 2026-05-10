// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { AsyncLocalStorage } from 'async_hooks';
import { resolveChatTenantId } from './chat-tenant-scope';

export interface ChatToolAuthorizationContext {
  userId: number;
  tenantId: number;
  confirmedDestructiveAction: boolean;
  confirmationSource: 'explicit_current_turn' | 'pending_confirmation' | 'none';
}

export interface ChatToolAuthorizationResult {
  allowed: boolean;
  code?: 'AUTH_REQUIRED' | 'TENANT_SCOPE_MISMATCH' | 'CONFIRMATION_REQUIRED';
  message?: string;
  confirmationRequired?: boolean;
  toolRisk?: ChatToolRisk;
}

export type ChatToolRisk = 'read' | 'write' | 'destructive' | 'external_send';

const storage = new AsyncLocalStorage<ChatToolAuthorizationContext>();

const DESTRUCTIVE_TOOLS = new Set([
  'ms_todo_delete_list',
  'ms_todo_delete_task',
  'delete_calendar_event',
  'send_outlook_email',
  'reply_outlook_email',
  'shared_memory_remove',
  'shared_memory_set',
  'finance_delete_transaction',
  'finance_mark_tax_paid',
  'cooking_delete_recipe',
  'cooking_delete_meal',
  'cooking_delete_pantry_item',
]);

const WRITE_TOOLS = new Set([
  'ms_todo_create_list',
  'ms_todo_create_task',
  'ms_todo_update_task',
  'ms_todo_complete_task',
  'ms_todo_uncomplete_task',
  'ms_todo_move_task',
  'ms_todo_add_checklist_item',
  'create_calendar_event',
  'update_calendar_event',
  'set_reminder',
  'save_note',
  'save_athlete_profile_field',
  'create_training_plan',
  'add_training_week',
  'add_training_session',
  'log_training_completion',
  'update_training_session',
  'link_session_calendar',
  'finance_add_transaction',
  'finance_calculate_tax',
  'cooking_add_recipe',
  'cooking_upsert_pantry_item',
  'cooking_set_preference',
  'cooking_set_meal',
  'cooking_generate_shopping_list',
]);

export function runWithChatToolAuthorization<T>(
  context: ChatToolAuthorizationContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return storage.run(context, fn);
}

export function getCurrentChatToolAuthorizationContext(): ChatToolAuthorizationContext | undefined {
  return storage.getStore();
}

export function getChatToolRisk(toolName: string): ChatToolRisk {
  if (toolName === 'send_outlook_email' || toolName === 'reply_outlook_email') return 'external_send';
  if (DESTRUCTIVE_TOOLS.has(toolName)) return 'destructive';
  if (WRITE_TOOLS.has(toolName)) return 'write';
  return 'read';
}

export function authorizeChatToolCall(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  userId?: number,
  tenantId?: number,
): ChatToolAuthorizationResult {
  const risk = getChatToolRisk(toolName);
  const current = getCurrentChatToolAuthorizationContext();

  if (!current) {
    return {
      allowed: false,
      code: 'AUTH_REQUIRED',
      message: `${toolName} requires authenticated chat authorization context`,
      toolRisk: risk,
    };
  }

  const requestedTenantId = typeof input?.tenantId === 'number'
    ? input.tenantId
    : typeof input?.tenant_id === 'number'
      ? input.tenant_id
      : null;
  const requestedUserId = typeof input?.userId === 'number'
    ? input.userId
    : typeof input?.user_id === 'number'
      ? input.user_id
      : typeof input?.ownerUserId === 'number'
        ? input.ownerUserId
        : typeof input?.owner_user_id === 'number'
          ? input.owner_user_id
          : null;

  if (!userId || userId !== current.userId) {
    return {
      allowed: false,
      code: 'AUTH_REQUIRED',
      message: `${toolName} requires the authenticated chat user context`,
      toolRisk: risk,
    };
  }

  const scopedTenantId = resolveChatTenantId(userId, tenantId);
  if (scopedTenantId !== current.tenantId) {
    return {
      allowed: false,
      code: 'TENANT_SCOPE_MISMATCH',
      message: `${toolName} cannot run outside the active chat tenant`,
      toolRisk: risk,
    };
  }

  if (requestedTenantId != null && requestedTenantId !== current.tenantId) {
    return {
      allowed: false,
      code: 'TENANT_SCOPE_MISMATCH',
      message: `${toolName} requested a tenant outside the active chat tenant`,
      toolRisk: risk,
    };
  }

  if (requestedUserId != null && requestedUserId !== current.userId) {
    return {
      allowed: false,
      code: 'AUTH_REQUIRED',
      message: `${toolName} requested a user outside the authenticated chat user`,
      toolRisk: risk,
    };
  }

  if ((risk === 'destructive' || risk === 'external_send') && !current.confirmedDestructiveAction) {
    return {
      allowed: false,
      code: 'CONFIRMATION_REQUIRED',
      message: `${toolName} requires explicit confirmation before it can run`,
      confirmationRequired: true,
      toolRisk: risk,
    };
  }

  return { allowed: true, toolRisk: risk };
}

export function formatToolAuthorizationFailure(result: ChatToolAuthorizationResult): Record<string, unknown> {
  return {
    success: false,
    error: result.message ?? 'Tool call was not authorized',
    code: result.code ?? 'TOOL_NOT_AUTHORIZED',
    confirmation_required: Boolean(result.confirmationRequired),
    tool_risk: result.toolRisk ?? 'read',
  };
}
