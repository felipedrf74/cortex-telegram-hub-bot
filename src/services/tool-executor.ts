// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { saveNote, searchNotes } from '../state/notes';
import { setReminder } from '../state/reminders';
import { setSharedMemory, removeSharedMemory } from '../state/shared-memory';
import * as unifiedCal from './unified-calendar';
import * as outlookMail from './outlook-mail';
import * as msTodo from './microsoft-todo';
import * as trainingPlans from './training-plans';
// R5 P2 fix — tool-executor's log_training_completion case lacked
// outbox parity with the REST /complete route. Add the same
// runOutboxTransaction emission so chat/tool-origin completions
// publish the same `training.feedback.recorded` event stream that
// REST completions do.
import { runOutboxTransaction } from './event-outbox';
import { computeV2IdempotencyHashHex } from '../api/routes/training-completion-v2-hash';
import * as financeTracker from './finance-tracker';
import * as cookingChef from './cooking-chef';
import * as cookingPreferences from './cooking-preferences';
import * as trainingSignals from './training-signals';
import * as onboarding from './onboarding';
import { invalidateCalendarCaches } from './cache-coherence-registry';
import { invalidateCookingDerivedCaches } from './cache-coherence-registry';
import { invalidateFinanceDerivedCaches } from './cache-coherence-registry';
import { invalidateOnboardingDerivedCaches } from './cache-coherence-registry';
import { getTaskProviderForUser } from './task-store/task-router';
import { resolvePreferredCaptureList, resolveTaskCreationList } from './task-store/task-list-resolution';
import { isSingleWritePathEnabled } from './task-store/single-write-path';
import {
  addOfflineTaskChecklistItem,
  createOfflineFirstTask,
  createOfflineFirstTaskList,
  deleteOfflineFirstTaskList,
  moveOfflineFirstTask,
  recordLocalTaskMutation,
  resolveOfflineCaptureListName,
  resolveOfflineNexusTaskId,
  resolveOfflineTaskListRef,
  updateOfflineFirstTask,
} from './task-store/offline-first-task-service';
import { getUserTimezoneById, resolveCanonicalUserId } from './user-service';
import { logger } from '../utils/logger';
import { resolveChatTenantId } from './chat-tenant-scope';
import {
  authorizeChatToolCall,
  formatToolAuthorizationFailure,
  getCurrentChatToolAuthorizationContext,
} from './chat-tool-authorization';
import { sanitizeForPromptInterpolation } from '../utils/prompt-sanitizer';
import {
  assertLegacySessionMutationAllowed,
} from './training-plan-revision-legacy-guard';
import { TrainingPlanRevisionError } from './training-plan-revision-errors';
import { captureChatContentIdea } from './content-workspace-chat-capture';

// ─── Phase 3 Slice A — profile field whitelist ───────────────────
//
// save_athlete_profile_field accepts a `profile_type` from the LLM,
// which could hallucinate a value. Gate it against the known set of
// triathlon-umbrella profiles so a stray call to e.g. "diet" or
// "homeschool" during a triathlon conversation can't write the wrong
// table. The tool is declared in the TOOLS list as triathlon-scoped,
// but tool filtering is best-effort; this is the authoritative check.
const ALLOWED_PROFILE_TYPES = new Set([
  'fitness',
  'triathlon-gym',
  'triathlon-running',
  'triathlon-cycling',
  'triathlon-swim',
]);

export const DISPATCHABLE_TOOL_NAMES = [
  'ms_todo_get_lists',
  'ms_todo_create_list',
  'ms_todo_delete_list',
  'ms_todo_get_tasks',
  'ms_todo_create_task',
  'ms_todo_update_task',
  'ms_todo_complete_task',
  'ms_todo_uncomplete_task',
  'ms_todo_delete_task',
  'ms_todo_search_tasks',
  'ms_todo_get_due_tasks',
  'ms_todo_move_task',
  'ms_todo_get_checklist',
  'ms_todo_add_checklist_item',
  'get_calendar_events',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'set_reminder',
  'save_note',
  'search_notes',
  'search_outlook_emails',
  'read_outlook_email',
  'send_outlook_email',
  'reply_outlook_email',
  'get_outlook_unread',
  'shared_memory_set',
  'shared_memory_remove',
  'save_athlete_profile_field',
  'create_training_plan',
  'add_training_week',
  'add_training_session',
  'get_training_plan',
  'log_training_completion',
  'update_training_session',
  'link_session_calendar',
  'finance_add_transaction',
  'finance_get_transactions',
  'finance_delete_transaction',
  'finance_monthly_summary',
  'finance_calculate_tax',
  'finance_get_tax_events',
  'finance_mark_tax_paid',
  'finance_annual_summary',
  'cooking_add_recipe',
  'cooking_get_recipes',
  'cooking_delete_recipe',
  'cooking_upsert_pantry_item',
  'cooking_get_pantry',
  'cooking_delete_pantry_item',
  'cooking_set_preference',
  'cooking_get_preferences',
  'cooking_set_meal',
  'cooking_get_meal_plan',
  'cooking_delete_meal',
  'cooking_generate_shopping_list',
  'cooking_get_shopping_list',
] as const;

export const ALLOWED_TOOLS: ReadonlySet<string> = new Set(DISPATCHABLE_TOOL_NAMES);

function assertToolAllowlistIsConsistent(): void {
  for (const toolName of DISPATCHABLE_TOOL_NAMES) {
    if (!ALLOWED_TOOLS.has(toolName)) {
      throw new Error(`Tool allowlist missing dispatch case: ${toolName}`);
    }
  }
}

assertToolAllowlistIsConsistent();

// ─── Phase 1 Slice B helpers ─────────────────────────────────────────

/**
 * Map a training plan sport string to the canonical sport enum used by
 * training-signals.ts. Accepts variations ("bike"→"cycling", "strength"→"gym").
 * Returns null if the sport is unknown (signal publishing is skipped).
 */
function normalizeSport(sport: string): 'gym' | 'running' | 'cycling' | 'swim' | null {
  const s = sport.toLowerCase().trim();
  if (['gym', 'strength', 'lifting', 'weight', 'weights', 'musculacao', 'musculação'].includes(s)) return 'gym';
  if (['run', 'running', 'corrida'].includes(s)) return 'running';
  if (['bike', 'biking', 'cycle', 'cycling', 'ciclismo', 'pedal'].includes(s)) return 'cycling';
  if (['swim', 'swimming', 'natacao', 'natação'].includes(s)) return 'swim';
  return null;
}

/**
 * Detect whether a gym session is leg-heavy by inspecting title + exercises.
 * Used to decide if we publish `high_leg_load` in addition to the generic
 * session load signal.
 */
function isLegHeavySession(title: string, exercisesJson: string | null): boolean {
  const haystack = `${title} ${exercisesJson ?? ''}`.toLowerCase();
  const legPatterns = [
    'squat', 'deadlift', 'lunge', 'leg press', 'leg curl', 'leg extension',
    'rdl', 'romanian', 'hip thrust', 'split squat', 'bulgarian', 'hack squat',
    'front squat', 'back squat', 'sumo',
    // pt-BR
    'agachamento', 'levantamento terra', 'afundo', 'leg day', 'lower body', 'inferior',
  ];
  return legPatterns.some((p) => haystack.includes(p));
}

/**
 * Detect whether a gym session is shoulder-heavy — triggers `high_shoulder_load`
 * for the swim coach.
 */
function isShoulderHeavySession(title: string, exercisesJson: string | null): boolean {
  const haystack = `${title} ${exercisesJson ?? ''}`.toLowerCase();
  const shoulderPatterns = [
    'overhead press', 'ohp', 'military press', 'shoulder press', 'push press',
    'lateral raise', 'front raise', 'upright row', 'arnold press',
    'desenvolvimento', 'elevação lateral', 'elevacao lateral',
    'pull up', 'pullup', 'chin up', 'lat pull', 'rows', 'barra fixa',
  ];
  return shoulderPatterns.some((p) => haystack.includes(p));
}

function normalizeAttendeeEmails(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = raw
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  return cleaned.length > 0 ? [...new Set(cleaned)] : undefined;
}

function escapeToolResultXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function wrapToolResultContent(text: string): string {
  const sanitized = JSON.parse(sanitizeForPromptInterpolation(text)) as string;
  return `<untrusted_tool_result>${escapeToolResultXml(sanitized)}</untrusted_tool_result>`;
}

const UNTRUSTED_TOOL_RESULT_FIELDS = new Set([
  'title',
  'displayName',
  'name',
  'subject',
  'body',
  'snippet',
  'bodyPreview',
  'description',
  'summary',
  'content',
  'message',
  'location',
]);

function wrapUntrustedToolResult<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => wrapUntrustedToolResult(item)) as T;
  }
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof fieldValue === 'string' && UNTRUSTED_TOOL_RESULT_FIELDS.has(key)) {
      output[key] = wrapToolResultContent(fieldValue);
    } else {
      output[key] = wrapUntrustedToolResult(fieldValue);
    }
  }
  return output as T;
}

function coerceUserRef(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const parsed = parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function resolveTenantToolUserId(
  contextUserId?: number,
  explicitInputUserId?: unknown,
): number | null {
  const contextCandidate = coerceUserRef(contextUserId);
  const explicitCandidate = coerceUserRef(explicitInputUserId);
  const contextCanonical = contextCandidate ? resolveCanonicalUserId(contextCandidate) : null;
  const explicitCanonical = explicitCandidate ? resolveCanonicalUserId(explicitCandidate) : null;
  if (contextCanonical && explicitCanonical && contextCanonical !== explicitCanonical) {
    return null;
  }
  return contextCanonical ?? explicitCanonical ?? null;
}

function hasExplicitToolUserMismatch(contextUserId?: number, explicitInputUserId?: unknown): boolean {
  const contextCandidate = coerceUserRef(contextUserId);
  const explicitCandidate = coerceUserRef(explicitInputUserId);
  if (!contextCandidate || !explicitCandidate) return false;
  const contextCanonical = resolveCanonicalUserId(contextCandidate);
  const explicitCanonical = resolveCanonicalUserId(explicitCandidate);
  return Boolean(contextCanonical && explicitCanonical && contextCanonical !== explicitCanonical);
}

function requireTenantToolUserId(
  toolName: string,
  contextUserId?: number,
  explicitInputUserId?: unknown,
  contextTenantId?: number,
): { ok: true; userId: number; tenantId: number } | { ok: false; error: string } {
  if (hasExplicitToolUserMismatch(contextUserId, explicitInputUserId)) {
    return { ok: false, error: `${toolName} cannot run for a different user than the authenticated chat user` };
  }
  const resolved = resolveTenantToolUserId(contextUserId, explicitInputUserId);
  if (!resolved) {
    return { ok: false, error: `${toolName} requires an authenticated user context` };
  }
  return { ok: true, userId: resolved, tenantId: resolveChatTenantId(resolved, contextTenantId) };
}

function requireOwnedTrainingPlanForTool(
  toolName: string,
  planId: unknown,
  contextUserId?: number,
  contextTenantId?: number,
): { ok: true; userId: number; tenantId: number; plan: trainingPlans.TrainingPlan } | { ok: false; error: string } {
  const scope = requireTenantToolUserId(toolName, contextUserId, undefined, contextTenantId);
  if (!scope.ok) return scope;
  const numericPlanId = typeof planId === 'number' ? planId : Number(planId);
  if (!Number.isFinite(numericPlanId) || numericPlanId <= 0) {
    return { ok: false, error: `${toolName} requires a valid plan_id` };
  }
  const plan = trainingPlans.getPlanById(numericPlanId);
  const planTenantId = typeof plan?.tenant_id === 'number' && plan.tenant_id > 0 ? plan.tenant_id : plan?.user_id;
  if (!plan || plan.user_id !== scope.userId || planTenantId !== scope.tenantId) {
    return { ok: false, error: `${toolName} cannot access that training plan for the authenticated user` };
  }
  return { ...scope, plan };
}

function requireOwnedTrainingSessionForTool(
  toolName: string,
  sessionId: unknown,
  contextUserId?: number,
  contextTenantId?: number,
): { ok: true; userId: number; tenantId: number; session: trainingPlans.TrainingSession; plan: trainingPlans.TrainingPlan } | { ok: false; error: string } {
  const scope = requireTenantToolUserId(toolName, contextUserId, undefined, contextTenantId);
  if (!scope.ok) return scope;
  const numericSessionId = typeof sessionId === 'number' ? sessionId : Number(sessionId);
  if (!Number.isFinite(numericSessionId) || numericSessionId <= 0) {
    return { ok: false, error: `${toolName} requires a valid session_id` };
  }
  const session = trainingPlans.getSessionById(numericSessionId);
  if (!session) {
    return { ok: false, error: `${toolName} cannot access that training session for the authenticated user` };
  }
  const plan = trainingPlans.getPlanById(session.plan_id);
  const planTenantId = typeof plan?.tenant_id === 'number' && plan.tenant_id > 0 ? plan.tenant_id : plan?.user_id;
  if (!plan || plan.user_id !== scope.userId || planTenantId !== scope.tenantId) {
    return { ok: false, error: `${toolName} cannot access that training session for the authenticated user` };
  }
  return { ...scope, session, plan };
}

function disabledRawTrainingWriterResult(toolName: string): {
  success: false;
  code: 'TRAINING_RAW_WRITER_DISABLED';
  error: string;
  handoff: 'training_plan_builder';
} {
  return {
    success: false,
    code: 'TRAINING_RAW_WRITER_DISABLED',
    error: `${toolName} cannot write Training plan projections directly. `
      + 'Open the reviewed training plan builder so the athlete can preview and confirm the complete plan.',
    handoff: 'training_plan_builder',
  };
}

function cookingToolValidationFailure(code: string, error: string): {
  success: false;
  code: string;
  error: string;
} {
  return { success: false, code, error };
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isOptionalBoundedInteger(value: unknown, maximum: number): boolean {
  return value === undefined || (isPositiveSafeInteger(value) && value <= maximum);
}

function isOptionalConfidence(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

export async function executeToolCall(
  toolName: string,
  input: Record<string, any>,
  userId?: number,
  tenantId?: number,
): Promise<any> {
  logger.info({ tool: toolName, inputKeys: Object.keys(input ?? {}) }, 'Executing tool call');

  try {
    if (!ALLOWED_TOOLS.has(toolName)) {
      logger.warn({ tool: toolName, userId, tenantId }, 'Tool call blocked by dispatch allowlist');
      return {
        success: false,
        error: `Tool "${toolName}" is not registered for execution`,
        code: 'TOOL_NOT_ALLOWED',
      };
    }

    const authorization = authorizeChatToolCall(toolName, input, userId, tenantId);
    if (!authorization.allowed) {
      logger.warn(
        { tool: toolName, userId, tenantId, code: authorization.code, toolRisk: authorization.toolRisk },
        'Tool call blocked by chat authorization guard',
      );
      return formatToolAuthorizationFailure(authorization);
    }

    const getTaskProviderContext = () => {
      const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
      if (!scope.ok) return scope;
      return {
        ok: true as const,
        userId: scope.userId,
        tenantId: scope.tenantId,
        provider: getTaskProviderForUser(scope.userId),
      };
    };

    switch (toolName) {
      // ── Task tools (per-user routed; M5: writes flow through the ledger) ──
      case 'ms_todo_get_lists': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        return await taskCtx.provider.getLists();
      }

      case 'ms_todo_create_list': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        return isSingleWritePathEnabled()
          ? ledgerCreateTaskListTool(taskCtx, input)
          : legacyProviderCreateTaskListTool(taskCtx, input);
      }

      case 'ms_todo_delete_list': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        return isSingleWritePathEnabled()
          ? ledgerDeleteTaskListTool(taskCtx, input)
          : legacyProviderDeleteTaskListTool(taskCtx, input);
      }

      case 'ms_todo_get_tasks': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        const tasks = await taskCtx.provider.getTasks(input.list_id, input.list_name, {
          status: input.status,
        });
        return wrapUntrustedToolResult(tasks);
      }

      case 'ms_todo_create_task': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        return isSingleWritePathEnabled()
          ? ledgerCreateTaskTool(taskCtx, input)
          : legacyProviderCreateTaskTool(taskCtx, input);
      }

      case 'ms_todo_update_task': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (!input.task_id) {
          return { success: false, error: 'Missing task_id — cannot update a task without its ID.' };
        }
        return isSingleWritePathEnabled()
          ? ledgerUpdateTaskTool(taskCtx, input)
          : legacyProviderUpdateTaskTool(taskCtx, input);
      }

      case 'ms_todo_complete_task': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (!input.task_id) {
          return { success: false, error: 'Missing task_id — cannot complete a task without its ID.' };
        }
        return isSingleWritePathEnabled()
          ? ledgerTaskStatusTool(taskCtx, input, 'task.complete')
          : legacyProviderCompleteTaskTool(taskCtx, input);
      }

      case 'ms_todo_uncomplete_task': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (!input.task_id) {
          return { success: false, error: 'Missing task_id — cannot uncomplete a task without its ID.' };
        }
        if (isSingleWritePathEnabled()) {
          return ledgerTaskStatusTool(taskCtx, input, 'task.reopen');
        }
        if (typeof taskCtx.provider.uncompleteTask !== 'function') {
          return { error: 'The active task provider does not support reopening completed tasks.' };
        }
        return legacyProviderUncompleteTaskTool(taskCtx, input);
      }

      case 'ms_todo_delete_task': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (!input.task_id) {
          return { success: false, error: 'Missing task_id — cannot delete a task without its ID.' };
        }
        return isSingleWritePathEnabled()
          ? ledgerTaskStatusTool(taskCtx, input, 'task.delete')
          : legacyProviderDeleteTaskTool(taskCtx, input);
      }

      case 'ms_todo_search_tasks': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (typeof taskCtx.provider.searchTasks === 'function') {
          return wrapUntrustedToolResult(await taskCtx.provider.searchTasks(input.query));
        }
        return { error: 'The active task provider does not support task search.' };
      }

      case 'ms_todo_get_due_tasks': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (typeof taskCtx.provider.getTasksDueInRange === 'function') {
          return wrapUntrustedToolResult(await taskCtx.provider.getTasksDueInRange(input.start_date, input.end_date));
        }
        return { error: 'The active task provider does not support due-date range lookups.' };
      }

      case 'ms_todo_move_task': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (isSingleWritePathEnabled()) {
          return ledgerMoveTaskTool(taskCtx, input);
        }
        if (typeof taskCtx.provider.moveTask !== 'function') {
          return { error: 'The active task provider does not support moving tasks between lists.' };
        }
        return legacyProviderMoveTaskTool(taskCtx, input);
      }

      case 'ms_todo_get_checklist': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (typeof taskCtx.provider.getChecklistItems !== 'function') {
          return { error: 'The active task provider does not support checklist items.' };
        }
        return wrapUntrustedToolResult(await taskCtx.provider.getChecklistItems(input.list_id, input.task_id));
      }

      case 'ms_todo_add_checklist_item': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (isSingleWritePathEnabled()) {
          return ledgerAddChecklistItemTool(taskCtx, input);
        }
        if (typeof taskCtx.provider.addChecklistItem !== 'function') {
          return { error: 'The active task provider does not support checklist items.' };
        }
        return legacyProviderAddChecklistItemTool(taskCtx, input);
      }

      // ── Calendar tools (unified: Google + Outlook) ──
      case 'get_calendar_events':
        if (userId != null
          ? !unifiedCal.hasConnectedCalendarForUser(userId)
          : !unifiedCal.isAnyCalendarConfigured()) {
          return { error: 'No calendar is configured. Set Google or Outlook credentials.' };
        }
        return wrapUntrustedToolResult(await unifiedCal.getEvents(input.start_date, input.end_date, userId));

      case 'create_calendar_event':
        if (userId != null
          ? !unifiedCal.hasWritableCalendarForUser(userId)
          : !unifiedCal.isAnyCalendarConfigured()) {
          return { error: 'No calendar is configured.' };
        }
        const createdEvent = await unifiedCal.createEvent({
          title: input.title,
          start: input.start,
          end: input.end,
          description: input.description,
          categories: input.categories,
          attendees: normalizeAttendeeEmails(input.attendees),
          location: typeof input.location === 'string' ? input.location.trim() || undefined : undefined,
          recurrence: input.recurrence,
        }, input.calendar_source, userId);
        invalidateCalendarCaches(userId);
        return createdEvent;

      case 'update_calendar_event': {
        if (userId != null
          ? !unifiedCal.hasWritableCalendarForUser(userId)
          : !unifiedCal.isAnyCalendarConfigured()) {
          return { error: 'No calendar is configured.' };
        }
        const updateSource = input.calendar_source || detectCalendarSource(input.event_id);
        const updatedEvent = await unifiedCal.updateEvent({
          event_id: input.event_id,
          new_start: input.new_start,
          new_end: input.new_end,
          new_title: input.new_title,
        }, updateSource, userId);
        invalidateCalendarCaches(userId);
        return updatedEvent;
      }

      case 'delete_calendar_event': {
        if (userId != null
          ? !unifiedCal.hasWritableCalendarForUser(userId)
          : !unifiedCal.isAnyCalendarConfigured()) {
          return { error: 'No calendar is configured.' };
        }
        const deleteSource = input.calendar_source || detectCalendarSource(input.event_id);
        await unifiedCal.deleteEvent(input.event_id, deleteSource, userId);
        invalidateCalendarCaches(userId);
        return { success: true, message: 'Event deleted' };
      }

      // ── Reminder tools ──
      case 'set_reminder': {
        if (input.__trustedDirectToolWrite !== true) {
          return {
            success: false,
            code: 'ACTION_CONFIRMATION_REQUIRED',
            error: 'set_reminder must be routed through the chat action planner before mutating reminders',
            confirmation_required: true,
          };
        }
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        return setReminder(scope.userId, {
          message: input.message,
          remind_at: input.remind_at,
          recurring: input.recurring,
          timezone: typeof input.timezone === 'string' ? input.timezone : getUserTimezoneById(scope.userId),
        }, {
          tenantId: scope.tenantId,
          timezone: typeof input.timezone === 'string' ? input.timezone : getUserTimezoneById(scope.userId),
        });
      }

      // ── Note tools ──
      case 'save_note': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        if (typeof input.domain === 'string' && input.domain.trim().toLowerCase() === 'content_idea') {
          const consentReceipt = getCurrentChatToolAuthorizationContext()?.contentIdeaCaptureConsent;
          if (!consentReceipt) {
            return {
              success: false,
              code: 'ACTION_CONFIRMATION_REQUIRED',
              error: 'Content idea capture requires an explicit current-turn save request',
              confirmation_required: true,
            };
          }
          const captured = captureChatContentIdea({
            scope: { tenantId: scope.tenantId, userId: scope.userId },
            content: input.content,
            title: input.title,
            consentReceipt,
          });
          return {
            success: true,
            destination: 'content_workspace',
            item_id: captured.item.id,
            title: captured.item.title,
            status: captured.item.productionState,
            next_action: captured.item.nextAction.action,
            replayed: captured.replayed,
          };
        }
        return saveNote(scope.userId, {
          content: input.content,
          domain: input.domain,
          tags: input.tags,
        });
      }

      case 'search_notes': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        return searchNotes(scope.userId, {
          query: input.query,
          domain: input.domain,
          tag: input.tag,
        });
      }

      // ── Outlook Email tools ──
      case 'search_outlook_emails':
        if (userId != null
          ? !outlookMail.isOutlookMailConfiguredForUser(userId)
          : !outlookMail.isOutlookMailConfigured()) {
          return { error: 'Outlook is not configured. Set OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, and OUTLOOK_REFRESH_TOKEN.' };
        }
        return wrapUntrustedToolResult(userId != null
          ? await outlookMail.searchEmailsForUser(userId, input.query, input.max_results || 10)
          : await outlookMail.searchEmails(input.query, input.max_results || 10));

      case 'read_outlook_email':
        if (userId != null
          ? !outlookMail.isOutlookMailConfiguredForUser(userId)
          : !outlookMail.isOutlookMailConfigured()) {
          return { error: 'Outlook is not configured.' };
        }
        return wrapUntrustedToolResult(userId != null
          ? await outlookMail.readEmailForUser(userId, input.message_id)
          : await outlookMail.readEmail(input.message_id));

      case 'send_outlook_email':
        if (userId != null
          ? !outlookMail.isOutlookMailConfiguredForUser(userId)
          : !outlookMail.isOutlookMailConfigured()) {
          return { error: 'Outlook is not configured.' };
        }
        if (userId != null) {
          await outlookMail.sendEmailForUser(userId, {
            to: input.to,
            subject: input.subject,
            body: input.body,
            cc: input.cc,
          });
        } else {
          await outlookMail.sendEmail({
            to: input.to,
            subject: input.subject,
            body: input.body,
            cc: input.cc,
          });
        }
        return { success: true, message: `Email sent to ${input.to}` };

      case 'reply_outlook_email':
        if (userId != null
          ? !outlookMail.isOutlookMailConfiguredForUser(userId)
          : !outlookMail.isOutlookMailConfigured()) {
          return { error: 'Outlook is not configured.' };
        }
        if (userId != null) {
          await outlookMail.replyToEmailForUser(userId, {
            messageId: input.message_id,
            body: input.body,
          });
        } else {
          await outlookMail.replyToEmail({
            messageId: input.message_id,
            body: input.body,
          });
        }
        return { success: true, message: 'Reply sent' };

      case 'get_outlook_unread': {
        if (userId != null
          ? !outlookMail.isOutlookMailConfiguredForUser(userId)
          : !outlookMail.isOutlookMailConfigured()) {
          return { error: 'Outlook is not configured.' };
        }
        if (userId != null) {
          const { count: unreadCount, emails: unreadEmails } = await outlookMail.getUnreadEmailsForUser(userId, input.max_results || 10);
          return { unread_count: unreadCount, recent_unread: wrapUntrustedToolResult(unreadEmails) };
        }
        const { count: unreadCount, emails: unreadEmails } = await outlookMail.getUnreadEmails(input.max_results || 10);
        return { unread_count: unreadCount, recent_unread: wrapUntrustedToolResult(unreadEmails) };
      }

      // ── Shared memory tools (cross-domain context) ──
      case 'shared_memory_set': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const entry = setSharedMemory(scope.userId, input.key, input.value, 'secretary', input.expires_at, scope.tenantId);
        return { success: true, key: entry.key, value: entry.value };
      }

      case 'shared_memory_remove': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const removed = removeSharedMemory(scope.userId, input.key, scope.tenantId);
        return { success: removed, key: input.key };
      }

      // ── Phase 3 Slice A — Chat-triggered onboarding ──
      case 'save_athlete_profile_field': {
        if (!userId) {
          return { error: 'save_athlete_profile_field requires a user_id (authenticated context)' };
        }
        const profileType = String(input.profile_type ?? '');
        const fieldKey = String(input.field_key ?? '');
        const value = String(input.value ?? '');

        if (!ALLOWED_PROFILE_TYPES.has(profileType)) {
          return {
            error: `profile_type "${profileType}" is not in the triathlon profile set. Allowed: ${Array.from(ALLOWED_PROFILE_TYPES).join(', ')}`,
          };
        }
        if (!fieldKey || !value) {
          return { error: 'field_key and value are required' };
        }

        // Validate the field key actually belongs to the questionnaire
        // so a typo or hallucinated key doesn't write garbage into the
        // profile's data blob.
        const questionnaire = onboarding.getQuestionnaire(profileType);
        if (!questionnaire) {
          return { error: `Questionnaire ${profileType} not defined` };
        }
        const step = questionnaire.steps.find((s) => s.key === fieldKey);
        if (!step) {
          return {
            error: `field_key "${fieldKey}" is not a step in questionnaire "${profileType}"`,
            allowed_fields: questionnaire.steps.map((s) => s.key),
          };
        }

        // If the step has a format regex (e.g. running pace "6:00"),
        // surface a validation error back to the coach so it can ask
        // again rather than persisting an invalid answer.
        if (step.validation && !step.validation.test(value)) {
          return {
            error: `value "${value}" does not match the expected format for ${fieldKey}`,
            expected: step.prompt,
          };
        }

        onboarding.upsertProfileField(userId, profileType, fieldKey, value);
        invalidateOnboardingDerivedCaches(userId, profileType);

        // Report what's still pending so the coach knows when to stop
        // asking. The coach can use this to thank the user and segue
        // back to the original request once the list is empty.
        const remaining = onboarding.getMissingProfileFields(userId, profileType);
        return {
          success: true,
          profile_type: profileType,
          saved_field: fieldKey,
          remaining_fields: remaining.map((s) => s.key),
          profile_complete: remaining.length === 0,
        };
      }

      // ── Training Plan tools ──
      //
      // F13 (Phase 1A-3): `create_training_plan` no longer writes a plan row.
      //
      // It used to call `trainingPlans.createPlan` directly, which inserts
      // with `status` defaulting to `'active'` and no unique constraint on
      // active plans. A single model turn could therefore create an empty
      // shell plan that immediately became "the active plan" — `getActivePlan`
      // orders by `created_at DESC` — hiding the user's real plan from Home,
      // /today, /week and the calendar. It also bypassed the coach kernel,
      // volume enforcement, the plan linter, the spec/readiness gate, the
      // safety guardrails and the cancellation saga, and produced a row with
      // `source_revision_id = NULL` that later blocks revision enrollment
      // with TRAINING_EXISTING_ACTIVE_PLAN_NOT_REPLACEABLE_IN_M1.
      //
      // The enrollment-scoped `assertLegacyPlanGenerationAllowed` guard did
      // not help: `shouldGuard` returns false for non-enrolled scopes, so in
      // default mode it was a no-op.
      //
      // Plan creation has a reviewed path — preview → confirm via the plan
      // builder — and chat already hands off to it (`training_plan_create`
      // returns `verified_pending` with `openSurface: 'training_plan_builder'`).
      // This tool now returns that handoff instead of writing. The released
      // REST route `/api/v1/training/plan/generate` is untouched; raw model
      // writers and the compatibility API are separate concerns.
      case 'create_training_plan': {
        const scope = requireTenantToolUserId(toolName, userId, input.user_id, tenantId);
        if (!scope.ok) return { error: scope.error };
        logger.warn(
          { userId: scope.userId, tenantId: scope.tenantId, toolName },
          'Model attempted direct training plan creation; returning plan-builder handoff instead of writing a row',
        );
        return disabledRawTrainingWriterResult(toolName);
      }

      case 'add_training_week': {
        const scope = requireOwnedTrainingPlanForTool(toolName, input.plan_id, userId, tenantId);
        if (!scope.ok) return { error: scope.error };
        logger.warn(
          { userId: scope.userId, tenantId: scope.tenantId, planId: scope.plan.id, toolName },
          'Model attempted direct Training week mutation; returning plan-builder handoff without writing',
        );
        return disabledRawTrainingWriterResult(toolName);
      }

      case 'add_training_session': {
        const scope = requireOwnedTrainingPlanForTool(toolName, input.plan_id, userId, tenantId);
        if (!scope.ok) return { error: scope.error };
        logger.warn(
          { userId: scope.userId, tenantId: scope.tenantId, planId: scope.plan.id, toolName },
          'Model attempted direct Training session creation; returning plan-builder handoff without writing',
        );
        return disabledRawTrainingWriterResult(toolName);
      }

      case 'get_training_plan': {
        const scope = requireTenantToolUserId(toolName, userId, input.user_id, tenantId);
        if (!scope.ok) return { error: scope.error };
        const plan = input.plan_id
          ? trainingPlans.getPlanById(input.plan_id)
          : trainingPlans.getActivePlan(scope.userId, scope.tenantId);
        if (!plan) return { error: 'No training plan found' };
        const planTenantId = typeof plan.tenant_id === 'number' && plan.tenant_id > 0 ? plan.tenant_id : plan.user_id;
        if (plan.user_id !== scope.userId || planTenantId !== scope.tenantId) {
          return { error: 'No training plan found for the authenticated user' };
        }

        const currentWeek = trainingPlans.getCurrentWeek(plan.id);
        const weeks = trainingPlans.getWeeksForPlan(plan.id);
        const sessions = currentWeek ? trainingPlans.getSessionsForWeek(currentWeek.id) : [];
        const adherence = currentWeek ? trainingPlans.getWeeklyAdherence(plan.id, currentWeek.id) : null;

        return {
          plan: { id: plan.id, name: plan.name, sport: plan.sport, goal: plan.goal, status: plan.status, start_date: plan.start_date, end_date: plan.end_date, duration_weeks: plan.duration_weeks, periodization: plan.periodization },
          total_weeks: weeks.length,
          current_week: currentWeek ? { id: currentWeek.id, number: currentWeek.week_number, focus: currentWeek.focus, intensity_pct: currentWeek.intensity_pct, auto_adjusted: !!currentWeek.auto_adjusted, adjustment_reason: currentWeek.adjustment_reason } : null,
          sessions: sessions.map(s => ({ id: s.id, day: s.day_of_week, type: s.session_type, title: s.title, status: s.status, intensity: s.intensity_text, duration_min: s.duration_minutes, has_calendar: !!s.calendar_event_id })),
          adherence,
        };
      }

      case 'log_training_completion': {
        const scope = requireOwnedTrainingSessionForTool(toolName, input.session_id, userId, tenantId);
        if (!scope.ok) return { error: scope.error };
        const session = trainingPlans.getSessionById(input.session_id);
        if (!session) return { error: `Session ${input.session_id} not found` };

        // Completion is operational progress, not a rewrite of immutable
        // revision content. Keep the dedicated completion contract available
        // for revision-owned projections so it records feedback and emits the
        // canonical outbox event. The generic update tool remains blocked,
        // including status-only "completed" writes, because it would bypass
        // that completion contract.

        // R3 P2 fix — forward V2 fields (rir / pain / technical
        // success / missed reason / external-training-declared /
        // completed sets/reps/load/duration/distance) from the tool
        // input when supplied.
        //
        // R4 P2 fix — Codex caught that the tool path only checked
        // `typeof v === 'number'`, which accepts NaN and Infinity.
        // The REST path now rejects those + enforces per-field
        // ranges; the tool path must reach parity so chat-side
        // ingestion can't bypass validation. We *reject* the tool
        // call on out-of-range inputs (return error) rather than
        // silently dropping the bad field — a model that hallucinates
        // a malformed payload should learn from the error response,
        // not have part of its payload silently ignored.
        const v2ToolErrors: string[] = [];
        const checkFiniteRange = (
          name: string,
          v: unknown,
          min: number,
          max: number,
        ): number | undefined => {
          if (v === undefined || v === null) return undefined;
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            v2ToolErrors.push(`${name} must be a finite number`);
            return undefined;
          }
          if (v < min || v > max) {
            v2ToolErrors.push(`${name} must be between ${min} and ${max} (got ${v})`);
            return undefined;
          }
          return v;
        };
        const checkString = (
          name: string,
          v: unknown,
          maxLen: number,
        ): string | undefined => {
          if (v === undefined || v === null) return undefined;
          if (typeof v !== 'string') {
            v2ToolErrors.push(`${name} must be a string`);
            return undefined;
          }
          if (v.length > maxLen) {
            v2ToolErrors.push(`${name} must be ≤ ${maxLen} characters`);
            return undefined;
          }
          return v;
        };
        // R6 P3 fix — match the REST validator's boolean check so
        // wrong-typed `external_training_declared` payloads fail
        // loudly instead of silently coercing to `false` via
        // `=== true`. REST returns 400 BAD_INPUT for the same
        // mismatch (training.ts checkBoolean).
        //
        // R7 P2/P3 fix — Codex caught that explicit `null` was
        // treated as omitted (silently coerced to false). The R7
        // contract is reject-on-non-boolean including null. Only
        // `undefined` (key absent) is treated as omitted; explicit
        // `null` now produces a validation error matching the
        // hardened REST helper.
        const checkBoolean = (name: string, v: unknown): boolean | undefined => {
          if (v === undefined) return undefined;
          if (typeof v !== 'boolean') {
            v2ToolErrors.push(`${name} must be a boolean`);
            return undefined;
          }
          return v;
        };
        const v2Rir = checkFiniteRange('rir', input.rir, 0, 10);
        const v2PainScore = checkFiniteRange('pain_score', input.pain_score, 0, 10);
        const v2PainLocation = checkString('pain_location', input.pain_location, 256);
        const v2TechSuccess = checkFiniteRange('technical_success_score', input.technical_success_score, 0, 10);
        const v2MissedReason = checkString('missed_reason', input.missed_reason, 256);
        const v2ExternalDeclared = checkBoolean('external_training_declared', input.external_training_declared);
        const v2CompletedDur = checkFiniteRange('completed_duration_sec', input.completed_duration_sec, 0, 24 * 3600);
        const v2CompletedDist = checkFiniteRange('completed_distance_meters', input.completed_distance_meters, 0, 500_000);
        const v2SetsJson = checkString('completed_sets_json', input.completed_sets_json, 8 * 1024);
        const v2RepsJson = checkString('completed_reps_json', input.completed_reps_json, 8 * 1024);
        const v2LoadJson = checkString('completed_load_json', input.completed_load_json, 8 * 1024);
        if (v2ToolErrors.length > 0) {
          return { error: `Invalid V2 completion fields: ${v2ToolErrors.join('; ')}` };
        }
        // R5 P2 fix — wrap the logCompletion call in the outbox
        // transaction so chat/tool-origin completions publish the
        // SAME `training.feedback.recorded` event the REST /complete
        // route does. Without this, downstream consumers (analytics,
        // sibling-skill signal bus, etc.) silently miss every
        // tool-origin completion. The idempotency key uses the same
        // canonical V2 hash so a chat-origin + REST-origin completion
        // for the same session within the dedup window collapses
        // correctly.
        // R6 P1 fix — Codex caught a user-data-loss bug here. The
        // prior version assigned `completion = logCompletion(...)`
        // inside the runOutboxTransaction closure, BEFORE emit. If
        // emit threw, Better-SQLite3 rolled back the transaction
        // (event-backbone.test.ts pins this behavior) — but the
        // outer JS variable was already truthy, so the catch
        // skipped the fallback write and we returned `success: true`
        // with a `completion_id` pointing at a row that no longer
        // existed. The athlete's completion was lost.
        //
        // The new shape:
        //   1. The transaction callback RETURNS the row. The outer
        //      variable is assigned ONLY from runOutboxTransaction's
        //      return value, which is reached only after commit.
        //   2. The catch block also explicitly resets `completion =
        //      undefined` as belt-and-braces against any future
        //      regression that re-introduces the closure-assignment
        //      pattern.
        //   3. The fallback write inside the catch becomes the
        //      authoritative re-attempt on rollback.
        let completion: ReturnType<typeof trainingPlans.logCompletion> | undefined;
        try {
          completion = runOutboxTransaction((emitDomainEvent) => {
            const row = trainingPlans.logCompletion({
              session_id: input.session_id,
              plan_id: session.plan_id,
              rpe_overall: input.rpe_overall,
              duration_minutes: input.duration_minutes,
              energy_level: input.energy_level,
              soreness_level: input.soreness_level,
              actual_exercises_json: input.actual_exercises_json,
              notes: input.notes,
              rir: v2Rir,
              pain_score: v2PainScore,
              pain_location: v2PainLocation,
              technical_success_score: v2TechSuccess,
              missed_reason: v2MissedReason,
              external_training_declared: v2ExternalDeclared === true,
              completed_duration_sec: v2CompletedDur,
              completed_distance_meters: v2CompletedDist,
              completed_sets_json: v2SetsJson,
              completed_reps_json: v2RepsJson,
              completed_load_json: v2LoadJson,
            });
            const v2HashHex = computeV2IdempotencyHashHex({
              notes: typeof input.notes === 'string' ? input.notes : null,
              rpe: typeof input.rpe_overall === 'number' && Number.isFinite(input.rpe_overall)
                ? input.rpe_overall
                : null,
              rir: v2Rir ?? null,
              painScore: v2PainScore ?? null,
              painLocation: v2PainLocation ?? null,
              technicalSuccessScore: v2TechSuccess ?? null,
              missedReason: v2MissedReason ?? null,
              externalTrainingDeclared: v2ExternalDeclared === true,
              completedDurationSec: v2CompletedDur ?? null,
              completedDistanceMeters: v2CompletedDist ?? null,
              completedSetsJson: v2SetsJson ?? null,
              completedRepsJson: v2RepsJson ?? null,
              completedLoadJson: v2LoadJson ?? null,
            });
            const v2Summary = {
              hasRir: v2Rir != null,
              hasPainScore: v2PainScore != null,
              hasPainLocation: typeof v2PainLocation === 'string' && v2PainLocation.length > 0,
              hasTechnicalSuccessScore: v2TechSuccess != null,
              hasMissedReason: typeof v2MissedReason === 'string' && v2MissedReason.length > 0,
              externalTrainingDeclared: v2ExternalDeclared === true,
              hasCompletedDurationSec: v2CompletedDur != null,
              hasCompletedDistanceMeters: v2CompletedDist != null,
              hasCompletedSetsJson: typeof v2SetsJson === 'string' && v2SetsJson.length > 0,
              hasCompletedRepsJson: typeof v2RepsJson === 'string' && v2RepsJson.length > 0,
              hasCompletedLoadJson: typeof v2LoadJson === 'string' && v2LoadJson.length > 0,
            };
            const hasNotes = typeof input.notes === 'string' && input.notes.length > 0;
            const rpeForKey = typeof input.rpe_overall === 'number' && Number.isFinite(input.rpe_overall)
              ? input.rpe_overall : null;
            // tenantId may be null/undefined for non-tenanted callers;
            // the REST path always carries one, so we mirror that with
            // a deterministic fallback that still keys per-user.
            const effectiveTenantId = typeof tenantId === 'number' && Number.isFinite(tenantId) ? tenantId : (userId ?? 0);
            const effectiveUserId = typeof userId === 'number' && Number.isFinite(userId) ? userId : 0;
            emitDomainEvent({
              tenantId: effectiveTenantId,
              userId: effectiveUserId,
              sourceSkill: 'training',
              eventType: 'training.feedback.recorded',
              entityType: 'training_session',
              entityId: input.session_id,
              payload: {
                summary: {
                  status: 'completed',
                  origin: 'tool',
                  hasNotes,
                  hasRpe: rpeForKey != null,
                  v2: v2Summary,
                },
                action: 'updated',
              },
              privacyClassification: 'health',
              idempotencyKey: `training.feedback.recorded:${effectiveUserId}:${input.session_id}:completed:v2-${v2HashHex}`,
            });
            // R6 P1 — return the row so the OUTER assignment only
            // happens once the transaction successfully commits.
            return row;
          });
        } catch (err) {
          logger.warn({ err, sessionId: input.session_id }, 'tool log_training_completion: outbox transaction failed (rolled back); falling back to non-transactional write');
          // R6 P1 — defensive reset. If a future change re-introduces
          // the closure-assignment pattern, this guarantees we still
          // re-attempt the write rather than silently report success
          // on a rolled-back row.
          completion = undefined;
          // Fallback to a non-transactional write so the user's
          // logged completion still persists. The event publish is
          // lost (the outbox row is the only canonical record of
          // event delivery), but the athlete's data isn't.
          if (!completion) {
            completion = trainingPlans.logCompletion({
              session_id: input.session_id,
              plan_id: session.plan_id,
              rpe_overall: input.rpe_overall,
              duration_minutes: input.duration_minutes,
              energy_level: input.energy_level,
              soreness_level: input.soreness_level,
              actual_exercises_json: input.actual_exercises_json,
              notes: input.notes,
              rir: v2Rir,
              pain_score: v2PainScore,
              pain_location: v2PainLocation,
              technical_success_score: v2TechSuccess,
              missed_reason: v2MissedReason,
              external_training_declared: v2ExternalDeclared === true,
              completed_duration_sec: v2CompletedDur,
              completed_distance_meters: v2CompletedDist,
              completed_sets_json: v2SetsJson,
              completed_reps_json: v2RepsJson,
              completed_load_json: v2LoadJson,
            });
          }
        }

        // ─── Phase 1 Slice B — Signal A publishing ───
        // Publish a per-user load marker so sibling sport coaches can
        // downgrade tomorrow's prescription. Also fire high_leg_load /
        // high_shoulder_load when thresholds are met.
        //
        // We deliberately keep this inside a try/catch and log — signal
        // publishing is fire-and-forget and must never fail the user's
        // log-completion request.
        try {
          if (userId != null && userId > 0) {
            const plan = trainingPlans.getPlanById(session.plan_id);
            const sport = plan ? normalizeSport(plan.sport) : null;
            const rpe = typeof input.rpe_overall === 'number' ? input.rpe_overall : 0;

            if (sport && rpe > 0) {
              trainingSignals.publishSessionLoad({
                userId: scope.userId,
                tenantId: scope.tenantId,
                sport,
                rpe,
                duration_min: input.duration_minutes,
                notes: input.notes,
              });

              if (sport === 'gym' && rpe >= 8) {
                if (isLegHeavySession(session.title, input.actual_exercises_json ?? session.exercises_json)) {
                  trainingSignals.publishHighLegLoad({
                    userId: scope.userId,
                    tenantId: scope.tenantId,
                    source: 'gym',
                    rpe,
                    details: { notes: session.title },
                  });
                }
                if (isShoulderHeavySession(session.title, input.actual_exercises_json ?? session.exercises_json)) {
                  trainingSignals.publishHighShoulderLoad({
                    userId: scope.userId,
                    tenantId: scope.tenantId,
                    rpe,
                    details: { notes: session.title },
                  });
                }
              }

              // Running sessions at high RPE with meaningful distance also
              // stress the legs — publish high_leg_load so gym coach and
              // cycling coach reduce lower-body volume tomorrow.
              if (sport === 'running' && rpe >= 8) {
                trainingSignals.publishHighLegLoad({
                  userId: scope.userId,
                  tenantId: scope.tenantId,
                  source: 'running',
                  rpe,
                  details: { mileage: undefined, notes: session.title },
                });
              }
            }
          }
        } catch (err) {
          // R8 P2-9 — tag with a stable errorId so SRE dashboards
          // can count sustained signal-bus failures separately from
          // other warn lines. The id mirrors the established
          // module.action_failed convention used elsewhere
          // (e.g. coach_plan_policy.parse_failed,
          // week_reflow.transaction_rolled_back).
          logger.warn(
            {
              err,
              sessionId: input.session_id,
              errorId: 'training_signals.publish_failed',
            },
            'training_signals.publish_failed: signal-bus publish failed after log_training_completion (fire-and-forget; user-visible completion is unaffected)',
          );
        }

        // After both try and catch fallbacks, `completion` is
        // guaranteed defined — the catch path runs logCompletion
        // synchronously if the transaction failed before assignment.
        if (!completion) {
          // Defensive — should be unreachable. If reached, surface
          // an explicit error rather than a confusing `.id` of
          // undefined.
          return { error: 'log_training_completion: failed to persist completion' };
        }
        return { success: true, completion_id: completion.id, session_title: session.title };
      }

      case 'update_training_session': {
        const scope = requireOwnedTrainingSessionForTool(toolName, input.session_id, userId, tenantId);
        if (!scope.ok) return { error: scope.error };
        logger.warn(
          { userId: scope.userId, tenantId: scope.tenantId, sessionId: scope.session.id, toolName },
          'Model attempted direct Training session update; returning plan-builder handoff without writing',
        );
        return disabledRawTrainingWriterResult(toolName);
      }

      case 'link_session_calendar': {
        const scope = requireOwnedTrainingSessionForTool(toolName, input.session_id, userId, tenantId);
        if (!scope.ok) return { error: scope.error };
        logger.warn(
          { userId: scope.userId, tenantId: scope.tenantId, sessionId: scope.session.id, toolName },
          'Legacy Training calendar link tool invoked; returning governed calendar-sync handoff without writing',
        );
        return {
          success: false,
          code: 'TRAINING_CALENDAR_LINK_COMPATIBILITY_ONLY',
          error: 'Direct calendar linkage is retired. Use the governed Training calendar preview, confirmation, and sync flow.',
          session_id: scope.session.id,
          handoff: {
            preview: `/api/v1/training/sessions/${scope.session.id}/reflow-preview`,
            confirm: `/api/v1/training/sessions/${scope.session.id}/reflow-confirm`,
            sync: '/api/v1/training/plan/sync-calendar',
          },
        };
      }

      // ── Finance tools ──
      case 'finance_add_transaction': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        const tx = financeTracker.addTransaction(uid, input.date, input.category, input.amount, {
          subcategory: input.subcategory,
          description: input.description,
          currency: input.currency,
          tenantId,
        });
        invalidateFinanceDerivedCaches(uid);
        return {
          success: true,
          id: tx.id,
          date: tx.date,
          category: tx.category,
          amount: tx.amount,
          currency: tx.currency,
        };
      }
      case 'finance_get_transactions': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        return financeTracker.getTransactions(uid, {
          startDate: input.start_date, endDate: input.end_date,
          category: input.category, limit: input.limit, tenantId,
        });
      }
      case 'finance_delete_transaction': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        const deleted = financeTracker.deleteTransaction(uid, input.transaction_id, { tenantId });
        if (deleted) invalidateFinanceDerivedCaches(uid);
        return deleted ? { success: true } : { error: 'Transaction not found or unauthorized' };
      }
      case 'finance_monthly_summary': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        return financeTracker.getMonthlySummary(uid, input.month, { tenantId });
      }
      case 'finance_calculate_tax': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        const taxEvent = financeTracker.calculateAndStoreTax(uid, input.month, { tenantId });
        const breakdown = financeTracker.calculatePortugueseMonthlyTax(taxEvent.gross_income, taxEvent.deductions);
        invalidateFinanceDerivedCaches(uid);
        return { ...taxEvent, effectiveRate: breakdown.effectiveRate, bracket: breakdown.bracket };
      }
      case 'finance_get_tax_events': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        return financeTracker.getTaxEvents(uid, { year: input.year, limit: input.limit, tenantId });
      }
      case 'finance_mark_tax_paid': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        const marked = financeTracker.markTaxPaid(uid, input.month, { tenantId });
        if (marked) invalidateFinanceDerivedCaches(uid);
        return marked ? { success: true, month: input.month, status: 'paid' } : { error: 'Tax event not found' };
      }
      case 'finance_annual_summary': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        const summary = financeTracker.getAnnualTaxSummary(uid, input.year, { tenantId });
        return {
          year: summary.year,
          totalGrossIncome: summary.totalGrossIncome,
          totalDeductions: summary.totalDeductions,
          totalInssDue: summary.totalInssDue,
          totalTaxDue: summary.totalTaxDue,
          totalPaid: summary.totalPaid,
          totalPending: summary.totalPending,
          effectiveAnnualRate: summary.effectiveAnnualRate,
          monthsPaid: summary.monthsPaid,
          monthsPending: summary.monthsPending,
        };
      }

      // ── Cooking tools ──
      case 'cooking_add_recipe': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        const recipe = cookingChef.addRecipe(uid, input.title, input.ingredients, {
          instructions: input.instructions, prepTime: input.prep_time_min,
          cookTime: input.cook_time_min, servings: input.servings, tags: input.tags,
          tenantId: scope.tenantId,
        });
        invalidateCookingDerivedCaches(uid);
        return { success: true, id: recipe.id, title: recipe.title };
      }
      case 'cooking_get_recipes': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        if (!isOptionalBoundedInteger(input.limit, 100)) {
          return cookingToolValidationFailure(
            'COOKING_RECIPE_INVALID_LIMIT',
            'limit must be an integer between 1 and 100',
          );
        }
        const uid = scope.userId;
        return cookingChef.getRecipes(uid, {
          tags: input.tags,
          search: input.search,
          limit: input.limit,
          tenantId: scope.tenantId,
        });
      }
      case 'cooking_delete_recipe': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        if (!isPositiveSafeInteger(input.recipe_id)) {
          return cookingToolValidationFailure(
            'COOKING_RECIPE_INVALID_ID',
            'recipe_id must be a positive integer',
          );
        }
        const uid = scope.userId;
        const deleted = cookingChef.deleteRecipe(uid, input.recipe_id, scope.tenantId);
        if (deleted) invalidateCookingDerivedCaches(uid);
        return deleted ? { success: true } : { error: 'Recipe not found' };
      }
      case 'cooking_upsert_pantry_item': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        if (!isOptionalConfidence(input.confidence)) {
          return cookingToolValidationFailure(
            'COOKING_PANTRY_INVALID_CONFIDENCE',
            'confidence must be a number between 0 and 1',
          );
        }
        const uid = scope.userId;
        const item = cookingChef.upsertPantryItem(uid, {
          name: input.name,
          quantity: input.quantity,
          unit: input.unit,
          category: input.category,
          expiresAt: input.expires_at,
          freshnessStatus: input.freshness_status,
          availabilityStatus: input.availability_status,
          source: input.source,
          confidence: input.confidence,
          notes: input.notes,
        }, scope.tenantId);
        invalidateCookingDerivedCaches(uid);
        return { success: true, id: item.id, name: item.name, freshness_status: item.freshness_status };
      }
      case 'cooking_get_pantry': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        if (!isOptionalBoundedInteger(input.limit, 250)) {
          return cookingToolValidationFailure(
            'COOKING_PANTRY_INVALID_LIMIT',
            'limit must be an integer between 1 and 250',
          );
        }
        const uid = scope.userId;
        return cookingChef.getPantryItems(uid, {
          tenantId: scope.tenantId,
          search: input.search,
          category: input.category,
          includeExpired: input.include_expired,
          limit: input.limit,
        });
      }
      case 'cooking_delete_pantry_item': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        if (!isPositiveSafeInteger(input.item_id)) {
          return cookingToolValidationFailure(
            'COOKING_PANTRY_INVALID_ID',
            'item_id must be a positive integer',
          );
        }
        const uid = scope.userId;
        const deleted = cookingChef.deletePantryItem(uid, input.item_id, scope.tenantId);
        if (deleted) invalidateCookingDerivedCaches(uid);
        return deleted ? { success: true } : { error: 'Pantry item not found' };
      }
      case 'cooking_set_preference': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        if (!isOptionalConfidence(input.confidence)) {
          return cookingToolValidationFailure(
            'COOKING_PREFERENCE_INVALID_CONFIDENCE',
            'confidence must be a number between 0 and 1',
          );
        }
        const uid = scope.userId;
        try {
          const memory = cookingPreferences.setCookingPreferenceMemory(uid, {
            kind: input.kind,
            value: input.value,
            source: input.source,
            correction: input.correction,
            confidence: input.confidence,
            expiresAt: input.expires_at,
          }, scope.tenantId);
          invalidateCookingDerivedCaches(uid);
          return {
            success: true,
            memory_id: memory.memoryId,
            memory_key: memory.memoryKey,
            freshness_status: memory.freshnessStatus,
          };
        } catch (err) {
          const inputError = cookingToolInputError(err);
          if (inputError) return inputError;
          return { error: 'Invalid cooking preference' };
        }
      }
      case 'cooking_get_preferences': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        return cookingPreferences.buildCookingPreferenceReadModel(uid, scope.tenantId);
      }
      case 'cooking_set_meal': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        const meal = cookingChef.setMealPlan(uid, input.date, input.meal_type, input.title, {
          recipeId: input.recipe_id, notes: input.notes, tenantId: scope.tenantId,
        });
        invalidateCookingDerivedCaches(uid);
        return {
          success: true,
          date: meal.date,
          meal_type: meal.meal_type,
          title: meal.title,
          ...(meal.issues?.length ? { issues: meal.issues } : {}),
        };
      }
      case 'cooking_get_meal_plan': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        return cookingChef.getMealPlan(uid, input.start_date, input.end_date, scope.tenantId);
      }
      case 'cooking_delete_meal': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        const deleted = cookingChef.deleteMealPlan(uid, input.date, input.meal_type, scope.tenantId);
        if (deleted) invalidateCookingDerivedCaches(uid);
        return deleted ? { success: true } : { error: 'Meal not found' };
      }
      case 'cooking_generate_shopping_list': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        const list = cookingChef.generateShoppingList(uid, input.week_start, scope.tenantId);
        invalidateCookingDerivedCaches(uid);
        return list;
      }
      case 'cooking_get_shopping_list': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        const list = cookingChef.getShoppingList(uid, input.week_start, scope.tenantId);
        return list || { items: [], status: 'not_found' };
      }

      default:
        logger.warn({ tool: toolName }, 'Unknown tool called');
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error({ err, tool: toolName }, 'Tool execution failed');
    if (err instanceof TrainingPlanRevisionError) {
      return { success: false, error: err.message, code: err.code };
    }
    if (err instanceof cookingChef.CookingRecipeDeleteConflictError) {
      return {
        success: false,
        error: 'Recipe is used by an active meal plan',
        code: 'COOKING_RECIPE_IN_USE',
      };
    }
    const cookingInputError = cookingToolInputError(err);
    if (cookingInputError) return cookingInputError;
    return { error: 'Tool execution failed' };
  }
}

function cookingToolInputError(err: unknown): { success: false; error: string; code: string } | null {
  const message = err instanceof Error ? err.message : '';
  const code = message.split(':', 1)[0] ?? '';
  if (!code.startsWith('COOKING_RECIPE_INVALID')
      && !code.startsWith('COOKING_MEAL_PLAN_INVALID')
      && !code.startsWith('COOKING_PREFERENCE_INVALID')
      && !code.startsWith('COOKING_SUBSTITUTION_INVALID')
      && code !== 'COOKING_SUBSTITUTION_NOOP'
      && code !== 'COOKING_SAFETY_BLOCKED'
      && code !== 'COOKING_MEAL_PLAN_RECIPE_NOT_FOUND'
      && code !== 'COOKING_SHOPPING_LIST_INVALID_WEEK_START'
      && code !== 'COOKING_SHOPPING_LIST_INVALID_WEEK_DATE'
      && !code.startsWith('COOKING_PANTRY_INVALID')) {
    return null;
  }
  const error = code === 'COOKING_MEAL_PLAN_RECIPE_NOT_FOUND'
    ? 'recipe_id must reference an active recipe in the current tenant scope'
    : code === 'COOKING_SAFETY_BLOCKED'
      ? 'Cooking item conflicts with a saved cooking safety preference'
      : code === 'COOKING_SHOPPING_LIST_INVALID_WEEK_START'
        ? 'week_start must be a valid Monday in YYYY-MM-DD format'
        : code === 'COOKING_SHOPPING_LIST_INVALID_WEEK_DATE'
          ? 'week_start must be a valid YYYY-MM-DD date'
        : code === 'COOKING_PANTRY_INVALID_EXPIRY'
          ? 'expires_at must be a valid YYYY-MM-DD date'
          : message;
  return { success: false, error, code };
}

/**
 * Detect calendar source from event ID format.
 * Google Calendar IDs are short alphanumeric strings.
 * Outlook event IDs are long base64-like strings starting with AAMk...
 */
function detectCalendarSource(eventId: string): unifiedCal.CalendarSource {
  if (eventId && eventId.startsWith('AAMk')) {
    return 'outlook';
  }
  return 'google';
}

// ─── M5 single write path: task tool write helpers ──────────────────────────
//
// Ledger helpers write to the offline-first ledger
// (offline-first-task-service) so chat-created work is instantly visible in
// the Tasks tab and provider sync happens asynchronously via the mutation
// worker (NEX-08/NEX-09/NEX-10). Ids returned from ledger helpers are NEXUS
// task ids — the REST read model and follow-up chat actions speak nexus ids;
// provider ids only exist after the async push.
//
// The legacy* helpers preserve the pre-M5 direct-provider behavior and are
// reachable only with TASK_SINGLE_WRITE_PATH=0 (operational revert lever);
// they are removed after the staging soak.

type TaskToolScope = { userId: number; tenantId: number; provider: any };

function taskToolError(err: unknown): { success: false; error: string } {
  const message = err instanceof Error ? err.message : String(err || 'task_write_failed');
  return { success: false, error: message };
}

function ledgerCreateTaskTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  try {
    // Note: input.reminder_date_time is intentionally not mapped — the ledger
    // schema (and the offline REST create contract) has no reminder field and
    // the provider projection would drop it anyway. The legacy flag-off path
    // still forwards it for parity with pre-M5 behavior.
    const created = createOfflineFirstTask(taskCtx.tenantId, taskCtx.userId, {
      title: input.title,
      body: input.body,
      importance: input.importance,
      dueDateTime: input.due_date_time,
      listName: resolveOfflineCaptureListName(taskCtx.tenantId, taskCtx.userId, input.list_name),
    });
    return {
      success: true,
      id: created.task.id,
      title: created.task.title,
      syncState: created.task.syncState,
    };
  } catch (err) {
    return taskToolError(err);
  }
}

function ledgerUpdateTaskTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  try {
    const nexusTaskId = resolveOfflineNexusTaskId(taskCtx.tenantId, taskCtx.userId, String(input.task_id));
    if (!nexusTaskId) return { success: false, error: 'Task not found in the local task store.' };
    const patch: Record<string, unknown> = { taskId: nexusTaskId };
    if (input.title !== undefined) patch.title = input.title;
    if (input.body !== undefined) patch.body = input.body;
    if (input.importance !== undefined) patch.importance = input.importance;
    if (input.status !== undefined) patch.status = input.status;
    if (input.due_date_time !== undefined) patch.dueDateTime = input.due_date_time;
    const updated = updateOfflineFirstTask(taskCtx.tenantId, taskCtx.userId, patch as any);
    return { success: true, title: updated.task.title || 'updated' };
  } catch (err) {
    return taskToolError(err);
  }
}

function ledgerTaskStatusTool(
  taskCtx: TaskToolScope,
  input: Record<string, any>,
  operation: 'task.complete' | 'task.reopen' | 'task.delete',
) {
  try {
    const nexusTaskId = resolveOfflineNexusTaskId(taskCtx.tenantId, taskCtx.userId, String(input.task_id));
    if (!nexusTaskId) return { success: false, error: 'Task not found in the local task store.' };
    const result = recordLocalTaskMutation(taskCtx.tenantId, taskCtx.userId, {
      taskId: nexusTaskId,
      operation,
      patch: { source: 'chat_tool' },
    });
    if (operation === 'task.delete') return { success: true };
    return {
      success: true,
      title: result.task.title || (operation === 'task.complete' ? 'done' : 'reopened'),
    };
  } catch (err) {
    return taskToolError(err);
  }
}

function ledgerMoveTaskTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  try {
    const nexusTaskId = resolveOfflineNexusTaskId(taskCtx.tenantId, taskCtx.userId, String(input.task_id));
    if (!nexusTaskId) return { success: false, error: 'Task not found in the local task store.' };
    const targetList = resolveOfflineTaskListRef(
      taskCtx.tenantId,
      taskCtx.userId,
      input.target_list_id,
      input.target_list_name,
    );
    if (!targetList) return { success: false, error: 'Target list not found in the local task store.' };
    const moved = moveOfflineFirstTask(taskCtx.tenantId, taskCtx.userId, {
      taskId: nexusTaskId,
      targetListId: targetList.id,
    });
    return {
      success: true,
      data: { id: moved.task.id, listId: targetList.id, listName: targetList.name },
    };
  } catch (err) {
    return taskToolError(err);
  }
}

function ledgerAddChecklistItemTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  try {
    const nexusTaskId = resolveOfflineNexusTaskId(taskCtx.tenantId, taskCtx.userId, String(input.task_id));
    if (!nexusTaskId) return { success: false, error: 'Task not found in the local task store.' };
    const added = addOfflineTaskChecklistItem(taskCtx.tenantId, taskCtx.userId, {
      taskId: nexusTaskId,
      displayName: input.title,
    });
    return { success: true, data: added.item };
  } catch (err) {
    return taskToolError(err);
  }
}

function ledgerCreateTaskListTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  try {
    const created = createOfflineFirstTaskList(taskCtx.tenantId, taskCtx.userId, { name: input.name });
    return { success: true, data: { id: created.list.id, displayName: created.list.name } };
  } catch (err) {
    return taskToolError(err);
  }
}

function ledgerDeleteTaskListTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  try {
    deleteOfflineFirstTaskList(taskCtx.tenantId, taskCtx.userId, { listId: String(input.list_id) });
    return { success: true, data: undefined };
  } catch (err) {
    return taskToolError(err);
  }
}

// ── Legacy direct-provider task tool paths (TASK_SINGLE_WRITE_PATH=0) ──

async function legacyProviderCreateTaskListTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  return taskCtx.provider.createList(input.name);
}

async function legacyProviderDeleteTaskListTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  if (typeof taskCtx.provider.deleteList !== 'function') {
    return { error: 'The active task provider does not support deleting lists.' };
  }
  return taskCtx.provider.deleteList(input.list_id);
}

async function legacyProviderCreateTaskTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  // Auto-resolve default list when AI doesn't specify one
  let listId = input.list_id;
  let listName = input.list_name || 'Inbox';
  if (!listId) {
    try {
      const resolvedList = await resolveTaskCreationList(taskCtx.provider, input.list_name);
      if (resolvedList) {
        listId = resolvedList.id;
        listName = resolvedList.displayName || resolvedList.name || listName;
      } else {
        const defaultList = await resolvePreferredCaptureList(taskCtx.provider);
        if (defaultList) {
          listId = defaultList.id;
          listName = defaultList.displayName || defaultList.name || listName;
        }
      }
    } catch { /* use whatever the provider defaults to */ }
  }
  const createRes = await taskCtx.provider.createTask(listId, listName, {
    title: input.title,
    body: input.body,
    importance: input.importance,
    dueDateTime: input.due_date_time,
    reminderDateTime: input.reminder_date_time,
  });
  return createRes.success
    ? { success: true, id: createRes.data?.id, title: createRes.data?.title }
    : { success: false, error: createRes.error };
}

async function legacyProviderUpdateTaskTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  const updateRes = await taskCtx.provider.updateTask(input.list_id, input.task_id, {
    title: input.title,
    body: input.body,
    importance: input.importance,
    status: input.status,
    dueDateTime: input.due_date_time,
    reminderDateTime: input.reminder_date_time,
  }, input.list_name);
  return updateRes.success
    ? { success: true, title: updateRes.data?.title || 'updated' }
    : { success: false, error: updateRes.error };
}

async function legacyProviderCompleteTaskTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  const completeRes = await taskCtx.provider.completeTask(input.list_id, input.task_id, input.list_name);
  return completeRes.success
    ? { success: true, title: completeRes.data?.title || 'done' }
    : { success: false, error: completeRes.error };
}

async function legacyProviderUncompleteTaskTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  const uncompleteRes = await taskCtx.provider.uncompleteTask(input.list_id, input.task_id, input.list_name);
  return uncompleteRes.success
    ? { success: true, title: uncompleteRes.data?.title || 'reopened' }
    : { success: false, error: uncompleteRes.error };
}

async function legacyProviderDeleteTaskTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  const deleteRes = await taskCtx.provider.deleteTask(input.list_id, input.task_id);
  return deleteRes.success
    ? { success: true }
    : { success: false, error: deleteRes.error };
}

async function legacyProviderMoveTaskTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  return taskCtx.provider.moveTask(input.list_id, input.task_id, input.target_list_id, input.target_list_name);
}

async function legacyProviderAddChecklistItemTool(taskCtx: TaskToolScope, input: Record<string, any>) {
  return taskCtx.provider.addChecklistItem(input.list_id, input.task_id, input.title);
}
