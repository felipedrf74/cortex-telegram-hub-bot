// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { AsyncLocalStorage } from 'async_hooks';
import { resolveChatTenantId } from './chat-tenant-scope';
import {
  validateContentIdeaCaptureConsent,
  type ContentIdeaCaptureConsentReceipt,
} from './content-workspace-chat-consent';

// ADV-3: a confirmation is a bounded grant, not a turn-wide blank check. Each
// entry authorizes ONE destructive/external-send call; `tool`/`targetId`
// narrow which call may claim it. When the confirming surface cannot type the
// target (free-text "yes"), the context omits the list and the confirmation
// collapses to a single untyped grant.
export interface ChatConfirmedDestructiveTarget {
  tool?: string;
  targetId?: string;
}

export interface ChatToolAuthorizationContext {
  userId: number;
  tenantId: number;
  confirmedDestructiveAction: boolean;
  confirmationSource: 'explicit_current_turn' | 'pending_confirmation' | 'none';
  // undefined/null = one untyped single-use grant; [] = confirmation covered
  // no destructive work, so every destructive call re-confirms.
  confirmedDestructiveTargets?: ChatConfirmedDestructiveTarget[] | null;
  requireConfirmationForWrites?: boolean;
  contentIdeaCaptureConsent?: ContentIdeaCaptureConsentReceipt | null;
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

// Grant consumption is keyed on the context object itself, so it lives and
// dies with the turn that created the context. Consumption happens at
// authorize time, before execution: a destructive call that later fails has
// still spent its grant, and a retry must re-confirm (conservative on purpose
// — destructive retries should never be silently replayable).
const consumedGrantIndexes = new WeakMap<ChatToolAuthorizationContext, Set<number>>();

const UNTYPED_SINGLE_GRANT: ChatConfirmedDestructiveTarget[] = [{}];

// Targeted grants match ONLY the tool's schema-declared target field(s)
// (see the tool input_schema definitions in anthropic.ts). Matching against
// arbitrary id-like input keys would let a model smuggle the confirmed id in
// a decoy field while pointing the real target field elsewhere. Fail-closed:
// a targeted grant never matches a tool without a mapping here, and the
// per-target test suite asserts every destructive/external-send tool has one.
export const CONFIRMED_TARGET_FIELDS: Record<string, readonly string[]> = {
  ms_todo_delete_list: ['list_id'],
  ms_todo_delete_task: ['task_id'],
  delete_calendar_event: ['event_id'],
  shared_memory_remove: ['key'],
  shared_memory_set: ['key'],
  finance_delete_transaction: ['transaction_id'],
  finance_mark_tax_paid: ['month'],
  cooking_delete_recipe: ['recipe_id'],
  cooking_delete_meal: ['date', 'meal_type'],
  cooking_delete_pantry_item: ['item_id'],
  send_outlook_email: ['to'],
  reply_outlook_email: ['message_id'],
};

function extractTargetIdCandidates(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
): string[] {
  const targetId = buildConfirmedDestructiveTargetId(toolName, input);
  return targetId ? [targetId] : [];
}

export function buildConfirmedDestructiveTargetId(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
): string | null {
  const fields = CONFIRMED_TARGET_FIELDS[toolName];
  if (!fields || !input) return null;
  const values: string[] = [];
  for (const field of fields) {
    const value = input[field];
    if (typeof value === 'string' && value.trim()) values.push(value.trim());
    else if (typeof value === 'number' && Number.isFinite(value)) values.push(String(value));
    else return null;
  }
  if (values.length === 1) return values[0] ?? null;
  return fields.map((field, index) => `${field}=${encodeURIComponent(values[index] ?? '')}`).join('&');
}

function consumeConfirmedDestructiveGrant(
  context: ChatToolAuthorizationContext,
  toolName: string,
  input: Record<string, unknown> | null | undefined,
): boolean {
  const grants = context.confirmedDestructiveTargets ?? UNTYPED_SINGLE_GRANT;
  if (grants.length === 0) return false;
  let consumed = consumedGrantIndexes.get(context);
  if (!consumed) {
    consumed = new Set<number>();
    consumedGrantIndexes.set(context, consumed);
  }
  const candidates = extractTargetIdCandidates(toolName, input);
  for (let i = 0; i < grants.length; i += 1) {
    if (consumed.has(i)) continue;
    const grant = grants[i];
    if (grant.tool != null && grant.tool !== toolName) continue;
    if (grant.targetId != null && !candidates.includes(String(grant.targetId))) continue;
    consumed.add(i);
    return true;
  }
  return false;
}

const EXTERNAL_SEND_TOOLS = new Set([
  'send_outlook_email',
  'reply_outlook_email',
]);

const DESTRUCTIVE_TOOLS = new Set([
  'ms_todo_delete_list',
  'ms_todo_delete_task',
  'delete_calendar_event',
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

const READ_TOOLS = new Set([
  'ms_todo_get_lists',
  'ms_todo_get_tasks',
  'ms_todo_search_tasks',
  'ms_todo_get_due_tasks',
  'ms_todo_get_checklist',
  'get_calendar_events',
  'search_notes',
  'search_outlook_emails',
  'read_outlook_email',
  'get_outlook_unread',
  'get_training_plan',
  'finance_get_transactions',
  'finance_monthly_summary',
  'finance_get_tax_events',
  'finance_annual_summary',
  'cooking_get_recipes',
  'cooking_get_pantry',
  'cooking_get_preferences',
  'cooking_get_meal_plan',
  'cooking_get_shopping_list',
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

export function isChatToolRiskClassified(toolName: string): boolean {
  return EXTERNAL_SEND_TOOLS.has(toolName)
    || DESTRUCTIVE_TOOLS.has(toolName)
    || WRITE_TOOLS.has(toolName)
    || READ_TOOLS.has(toolName);
}

export function getChatToolRisk(toolName: string): ChatToolRisk {
  if (EXTERNAL_SEND_TOOLS.has(toolName)) return 'external_send';
  if (DESTRUCTIVE_TOOLS.has(toolName)) return 'destructive';
  if (WRITE_TOOLS.has(toolName)) return 'write';
  if (READ_TOOLS.has(toolName)) return 'read';
  // New tool names require confirmation until they are explicitly classified.
  return 'write';
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

  if (toolName === 'save_note'
    && typeof input?.domain === 'string'
    && input.domain.trim().toLowerCase() === 'content_idea') {
    const consent = validateContentIdeaCaptureConsent(current.contentIdeaCaptureConsent, {
      tenantId: current.tenantId,
      userId: current.userId,
      content: input.content,
      title: input.title,
    });
    if (!consent.ok) {
      return {
        allowed: false,
        code: 'CONFIRMATION_REQUIRED',
        message: 'Content idea capture requires an explicit current-turn save request matching the captured content',
        confirmationRequired: true,
        toolRisk: risk,
      };
    }
  }

  const requiresConfirmation = risk === 'destructive'
    || risk === 'external_send'
    || (risk === 'write' && current.requireConfirmationForWrites === true);
  if (requiresConfirmation && !current.confirmedDestructiveAction) {
    return {
      allowed: false,
      code: 'CONFIRMATION_REQUIRED',
      message: `${toolName} requires explicit confirmation before it can run`,
      confirmationRequired: true,
      toolRisk: risk,
    };
  }

  // ADV-3: confirmed destructive/external-send calls must each claim a grant.
  // Plain writes stay under the boolean — they are reversible and a confirmed
  // turn may legitimately perform several of them.
  if (risk === 'destructive' || risk === 'external_send') {
    if (!consumeConfirmedDestructiveGrant(current, toolName, input)) {
      return {
        allowed: false,
        code: 'CONFIRMATION_REQUIRED',
        message: `${toolName} requires its own explicit confirmation for this target`,
        confirmationRequired: true,
        toolRisk: risk,
      };
    }
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
