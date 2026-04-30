// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { saveNote, searchNotes } from '../state/notes';
import { setReminder } from '../state/reminders';
import { setSharedMemory, removeSharedMemory } from '../state/shared-memory';
import * as unifiedCal from './unified-calendar';
import * as outlookMail from './outlook-mail';
import * as msTodo from './microsoft-todo';
import * as trainingPlans from './training-plans';
import * as financeTracker from './finance-tracker';
import * as cookingChef from './cooking-chef';
import * as cookingPreferences from './cooking-preferences';
import * as trainingSignals from './training-signals';
import * as onboarding from './onboarding';
import { invalidateCalendarCaches } from './calendar-cache-invalidator';
import { invalidateCookingDerivedCaches } from './cooking-cache-invalidator';
import { invalidateFinanceDerivedCaches } from './finance-cache-invalidator';
import { invalidateOnboardingDerivedCaches } from './onboarding-cache-invalidator';
import { getTaskProviderForUser } from './task-store/task-router';
import { resolvePreferredCaptureList, resolveTaskCreationList } from './task-store/task-list-resolution';
import { resolveCanonicalUserId } from './user-service';
import { logger } from '../utils/logger';
import { resolveChatTenantId } from './chat-tenant-scope';
import { authorizeChatToolCall, formatToolAuthorizationFailure } from './chat-tool-authorization';

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
  if (!plan || plan.user_id !== scope.userId) {
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
  if (!plan || plan.user_id !== scope.userId) {
    return { ok: false, error: `${toolName} cannot access that training session for the authenticated user` };
  }
  return { ...scope, session, plan };
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
        provider: getTaskProviderForUser(scope.userId),
      };
    };

    switch (toolName) {
      // ── Task tools (per-user routed) ──
      case 'ms_todo_get_lists': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        return await taskCtx.provider.getLists();
      }

      case 'ms_todo_create_list': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        return await taskCtx.provider.createList(input.name);
      }

      case 'ms_todo_delete_list': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (typeof taskCtx.provider.deleteList !== 'function') {
          return { error: 'The active task provider does not support deleting lists.' };
        }
        return await taskCtx.provider.deleteList(input.list_id);
      }

      case 'ms_todo_get_tasks': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        return await taskCtx.provider.getTasks(input.list_id, input.list_name, {
          status: input.status,
        });
      }

      case 'ms_todo_create_task': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
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

      case 'ms_todo_update_task': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (!input.task_id) {
          return { success: false, error: 'Missing task_id — cannot update a task without its ID.' };
        }
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

      case 'ms_todo_complete_task': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (!input.task_id) {
          return { success: false, error: 'Missing task_id — cannot complete a task without its ID.' };
        }
        const completeRes = await taskCtx.provider.completeTask(input.list_id, input.task_id, input.list_name);
        return completeRes.success
          ? { success: true, title: completeRes.data?.title || 'done' }
          : { success: false, error: completeRes.error };
      }

      case 'ms_todo_uncomplete_task': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (!input.task_id) {
          return { success: false, error: 'Missing task_id — cannot uncomplete a task without its ID.' };
        }
        if (typeof taskCtx.provider.uncompleteTask !== 'function') {
          return { error: 'The active task provider does not support reopening completed tasks.' };
        }
        const uncompleteRes = await taskCtx.provider.uncompleteTask(input.list_id, input.task_id, input.list_name);
        return uncompleteRes.success
          ? { success: true, title: uncompleteRes.data?.title || 'reopened' }
          : { success: false, error: uncompleteRes.error };
      }

      case 'ms_todo_delete_task': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (!input.task_id) {
          return { success: false, error: 'Missing task_id — cannot delete a task without its ID.' };
        }
        const deleteRes = await taskCtx.provider.deleteTask(input.list_id, input.task_id);
        return deleteRes.success
          ? { success: true }
          : { success: false, error: deleteRes.error };
      }

      case 'ms_todo_search_tasks': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (typeof taskCtx.provider.searchTasks === 'function') {
          return await taskCtx.provider.searchTasks(input.query);
        }
        return { error: 'The active task provider does not support task search.' };
      }

      case 'ms_todo_get_due_tasks': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (typeof taskCtx.provider.getTasksDueInRange === 'function') {
          return await taskCtx.provider.getTasksDueInRange(input.start_date, input.end_date);
        }
        return { error: 'The active task provider does not support due-date range lookups.' };
      }

      case 'ms_todo_move_task': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (typeof taskCtx.provider.moveTask !== 'function') {
          return { error: 'The active task provider does not support moving tasks between lists.' };
        }
        return await taskCtx.provider.moveTask(input.list_id, input.task_id, input.target_list_id, input.target_list_name);
      }

      case 'ms_todo_get_checklist': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (typeof taskCtx.provider.getChecklistItems !== 'function') {
          return { error: 'The active task provider does not support checklist items.' };
        }
        return await taskCtx.provider.getChecklistItems(input.list_id, input.task_id);
      }

      case 'ms_todo_add_checklist_item': {
        const taskCtx = getTaskProviderContext();
        if (!taskCtx.ok) return { error: taskCtx.error };
        if (typeof taskCtx.provider.addChecklistItem !== 'function') {
          return { error: 'The active task provider does not support checklist items.' };
        }
        return await taskCtx.provider.addChecklistItem(input.list_id, input.task_id, input.title);
      }

      // ── Calendar tools (unified: Google + Outlook) ──
      case 'get_calendar_events':
        if (userId != null
          ? !unifiedCal.hasConnectedCalendarForUser(userId)
          : !unifiedCal.isAnyCalendarConfigured()) {
          return { error: 'No calendar is configured. Set Google or Outlook credentials.' };
        }
        return await unifiedCal.getEvents(input.start_date, input.end_date, userId);

      case 'create_calendar_event':
        if (userId != null
          ? !unifiedCal.hasConnectedCalendarForUser(userId)
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
          ? !unifiedCal.hasConnectedCalendarForUser(userId)
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
          ? !unifiedCal.hasConnectedCalendarForUser(userId)
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
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        return setReminder(scope.userId, {
          message: input.message,
          remind_at: input.remind_at,
          recurring: input.recurring,
        });
      }

      // ── Note tools ──
      case 'save_note': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
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
        return userId != null
          ? await outlookMail.searchEmailsForUser(userId, input.query, input.max_results || 10)
          : await outlookMail.searchEmails(input.query, input.max_results || 10);

      case 'read_outlook_email':
        if (userId != null
          ? !outlookMail.isOutlookMailConfiguredForUser(userId)
          : !outlookMail.isOutlookMailConfigured()) {
          return { error: 'Outlook is not configured.' };
        }
        return userId != null
          ? await outlookMail.readEmailForUser(userId, input.message_id)
          : await outlookMail.readEmail(input.message_id);

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
          return { unread_count: unreadCount, recent_unread: unreadEmails };
        }
        const { count: unreadCount, emails: unreadEmails } = await outlookMail.getUnreadEmails(input.max_results || 10);
        return { unread_count: unreadCount, recent_unread: unreadEmails };
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
      case 'create_training_plan': {
        const scope = requireTenantToolUserId(toolName, userId, input.user_id, tenantId);
        if (!scope.ok) return { error: scope.error };
        const plan = trainingPlans.createPlan({
          user_id: scope.userId,
          name: input.name,
          sport: input.sport,
          goal: input.goal,
          duration_weeks: input.duration_weeks,
          periodization: input.periodization,
          start_date: input.start_date,
          end_date: input.end_date,
          preferences_json: input.preferences_json,
        });
        return { success: true, plan_id: plan.id, name: plan.name, status: plan.status };
      }

      case 'add_training_week': {
        const scope = requireOwnedTrainingPlanForTool(toolName, input.plan_id, userId, tenantId);
        if (!scope.ok) return { error: scope.error };
        const week = trainingPlans.createWeek({
          plan_id: input.plan_id,
          week_number: input.week_number,
          focus: input.focus,
          intensity_pct: input.intensity_pct,
          volume_sessions: input.volume_sessions,
          notes: input.notes,
        });
        return { success: true, week_id: week.id, week_number: week.week_number };
      }

      case 'add_training_session': {
        const scope = requireOwnedTrainingPlanForTool(toolName, input.plan_id, userId, tenantId);
        if (!scope.ok) return { error: scope.error };
        const weekId = typeof input.week_id === 'number' ? input.week_id : Number(input.week_id);
        const weekBelongsToPlan = trainingPlans.getWeeksForPlan(scope.plan.id).some((week) => week.id === weekId);
        if (!weekBelongsToPlan) {
          return { error: 'add_training_session cannot write to a week outside the authenticated user plan' };
        }
        const session = trainingPlans.createSession({
          week_id: input.week_id,
          plan_id: input.plan_id,
          day_of_week: input.day_of_week,
          session_type: input.session_type,
          title: input.title,
          description: input.description,
          exercises_json: input.exercises_json,
          duration_minutes: input.duration_minutes,
          intensity_text: input.intensity_text,
        });
        return { success: true, session_id: session.id, title: session.title, day: session.day_of_week };
      }

      case 'get_training_plan': {
        const scope = requireTenantToolUserId(toolName, userId, input.user_id, tenantId);
        if (!scope.ok) return { error: scope.error };
        const plan = input.plan_id
          ? trainingPlans.getPlanById(input.plan_id)
          : trainingPlans.getActivePlan(scope.userId);
        if (!plan) return { error: 'No training plan found' };
        if (plan.user_id !== scope.userId) {
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

        const completion = trainingPlans.logCompletion({
          session_id: input.session_id,
          plan_id: session.plan_id,
          rpe_overall: input.rpe_overall,
          duration_minutes: input.duration_minutes,
          energy_level: input.energy_level,
          soreness_level: input.soreness_level,
          actual_exercises_json: input.actual_exercises_json,
          notes: input.notes,
        });

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
                userId,
                sport,
                rpe,
                duration_min: input.duration_minutes,
                notes: input.notes,
              });

              if (sport === 'gym' && rpe >= 8) {
                if (isLegHeavySession(session.title, input.actual_exercises_json ?? session.exercises_json)) {
                  trainingSignals.publishHighLegLoad({
                    userId,
                    source: 'gym',
                    rpe,
                    details: { notes: session.title },
                  });
                }
                if (isShoulderHeavySession(session.title, input.actual_exercises_json ?? session.exercises_json)) {
                  trainingSignals.publishHighShoulderLoad({
                    userId,
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
                  userId,
                  source: 'running',
                  rpe,
                  details: { mileage: undefined, notes: session.title },
                });
              }
            }
          }
        } catch (err) {
          logger.warn({ err, sessionId: input.session_id }, 'training-signals publish failed after log_training_completion');
        }

        return { success: true, completion_id: completion.id, session_title: session.title };
      }

      case 'update_training_session': {
        const scope = requireOwnedTrainingSessionForTool(toolName, input.session_id, userId, tenantId);
        if (!scope.ok) return { error: scope.error };
        const updated = trainingPlans.updateSession(input.session_id, {
          title: input.title,
          exercises_json: input.exercises_json,
          duration_minutes: input.duration_minutes,
          intensity_text: input.intensity_text,
          description: input.description,
          status: input.status,
        });
        return { success: updated, session_id: input.session_id };
      }

      case 'link_session_calendar': {
        const scope = requireOwnedTrainingSessionForTool(toolName, input.session_id, userId, tenantId);
        if (!scope.ok) return { error: scope.error };
        const linked = trainingPlans.linkSessionToCalendar(
          input.session_id, input.calendar_event_id, input.calendar_source,
        );
        return { success: linked, session_id: input.session_id };
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
          category: input.category, limit: input.limit,
        });
      }
      case 'finance_delete_transaction': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        const deleted = financeTracker.deleteTransaction(uid, input.transaction_id);
        if (deleted) invalidateFinanceDerivedCaches(uid);
        return deleted ? { success: true } : { error: 'Transaction not found or unauthorized' };
      }
      case 'finance_monthly_summary': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        return financeTracker.getMonthlySummary(uid, input.month);
      }
      case 'finance_calculate_tax': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        const taxEvent = financeTracker.calculateAndStoreTax(uid, input.month);
        const breakdown = financeTracker.calculateMonthlyTax(taxEvent.gross_income, taxEvent.deductions);
        invalidateFinanceDerivedCaches(uid);
        return { ...taxEvent, effectiveRate: breakdown.effectiveRate, bracket: breakdown.bracket };
      }
      case 'finance_get_tax_events': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        return financeTracker.getTaxEvents(uid, { year: input.year, limit: input.limit });
      }
      case 'finance_mark_tax_paid': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        const marked = financeTracker.markTaxPaid(uid, input.month);
        if (marked) invalidateFinanceDerivedCaches(uid);
        return marked ? { success: true, month: input.month, status: 'paid' } : { error: 'Tax event not found' };
      }
      case 'finance_annual_summary': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
        const uid = scope.userId;
        const summary = financeTracker.getAnnualTaxSummary(uid, input.year);
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
        return { success: true, id: recipe.id, title: recipe.title };
      }
      case 'cooking_get_recipes': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
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
        const uid = scope.userId;
        return cookingChef.deleteRecipe(uid, input.recipe_id, scope.tenantId) ? { success: true } : { error: 'Recipe not found' };
      }
      case 'cooking_upsert_pantry_item': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
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
        const uid = scope.userId;
        const deleted = cookingChef.deletePantryItem(uid, input.item_id, scope.tenantId);
        if (deleted) invalidateCookingDerivedCaches(uid);
        return deleted ? { success: true } : { error: 'Pantry item not found' };
      }
      case 'cooking_set_preference': {
        const scope = requireTenantToolUserId(toolName, userId, undefined, tenantId);
        if (!scope.ok) return { error: scope.error };
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
          const message = err instanceof Error ? err.message : 'Invalid cooking preference';
          return { error: message };
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
        return { success: true, date: meal.date, meal_type: meal.meal_type, title: meal.title };
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
    return { error: 'Tool execution failed' };
  }
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
