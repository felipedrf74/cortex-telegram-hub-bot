// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { saveNote, searchNotes } from '../state/notes';
import { setReminder } from '../state/reminders';
import { setSharedMemory, removeSharedMemory } from '../state/shared-memory';
import * as unifiedCal from './unified-calendar';
import * as outlookMail from './outlook-mail';
import * as msTodo from './microsoft-todo';
import * as financeTracker from './finance-tracker';
import * as cookingChef from './cooking-chef';
import { logger } from '../utils/logger';

export async function executeToolCall(
  toolName: string,
  input: Record<string, any>,
  userId?: number,
): Promise<any> {
  logger.info({ tool: toolName, input }, 'Executing tool call');

  try {
    switch (toolName) {
      // ── Microsoft To Do tools ──
      case 'ms_todo_get_lists':
        if (!msTodo.isOutlookTodoConfigured()) {
          return { error: 'Microsoft To Do is not configured. Set Outlook credentials and ensure Tasks.ReadWrite permission.' };
        }
        return await msTodo.getLists();

      case 'ms_todo_create_list':
        if (!msTodo.isOutlookTodoConfigured()) {
          return { error: 'Microsoft To Do is not configured.' };
        }
        return await msTodo.createList(input.name);

      case 'ms_todo_delete_list':
        if (!msTodo.isOutlookTodoConfigured()) {
          return { error: 'Microsoft To Do is not configured.' };
        }
        return await msTodo.deleteList(input.list_id);

      case 'ms_todo_get_tasks':
        if (!msTodo.isOutlookTodoConfigured()) {
          return { error: 'Microsoft To Do is not configured.' };
        }
        return await msTodo.getTasks(input.list_id, input.list_name, {
          status: input.status,
        });

      case 'ms_todo_create_task': {
        if (!msTodo.isOutlookTodoConfigured()) {
          return { error: 'Microsoft To Do is not configured.' };
        }
        const createRes = await msTodo.createTask(input.list_id, input.list_name, {
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
        if (!msTodo.isOutlookTodoConfigured()) {
          return { error: 'Microsoft To Do is not configured.' };
        }
        if (!input.task_id) {
          return { success: false, error: 'Missing task_id — cannot update a task without its ID.' };
        }
        const updateRes = await msTodo.updateTask(input.list_id, input.task_id, {
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
        if (!msTodo.isOutlookTodoConfigured()) {
          return { error: 'Microsoft To Do is not configured.' };
        }
        if (!input.task_id) {
          return { success: false, error: 'Missing task_id — cannot complete a task without its ID.' };
        }
        const completeRes = await msTodo.completeTask(input.list_id, input.task_id, input.list_name);
        // Slim response: only return success + title (save tokens in tool conversation)
        return completeRes.success
          ? { success: true, title: completeRes.data?.title || 'done' }
          : { success: false, error: completeRes.error };
      }

      case 'ms_todo_uncomplete_task': {
        if (!msTodo.isOutlookTodoConfigured()) {
          return { error: 'Microsoft To Do is not configured.' };
        }
        if (!input.task_id) {
          return { success: false, error: 'Missing task_id — cannot uncomplete a task without its ID.' };
        }
        const uncompleteRes = await msTodo.uncompleteTask(input.list_id, input.task_id, input.list_name);
        return uncompleteRes.success
          ? { success: true, title: uncompleteRes.data?.title || 'reopened' }
          : { success: false, error: uncompleteRes.error };
      }

      case 'ms_todo_delete_task': {
        if (!msTodo.isOutlookTodoConfigured()) {
          return { error: 'Microsoft To Do is not configured.' };
        }
        if (!input.task_id) {
          return { success: false, error: 'Missing task_id — cannot delete a task without its ID.' };
        }
        const deleteRes = await msTodo.deleteTask(input.list_id, input.task_id);
        return deleteRes.success
          ? { success: true }
          : { success: false, error: deleteRes.error };
      }

      case 'ms_todo_search_tasks':
        if (!msTodo.isOutlookTodoConfigured()) {
          return { error: 'Microsoft To Do is not configured.' };
        }
        return await msTodo.searchTasks(input.query);

      case 'ms_todo_get_due_tasks':
        if (!msTodo.isOutlookTodoConfigured()) {
          return { error: 'Microsoft To Do is not configured.' };
        }
        return await msTodo.getTasksDueInRange(input.start_date, input.end_date);

      case 'ms_todo_move_task':
        if (!msTodo.isOutlookTodoConfigured()) {
          return { error: 'Microsoft To Do is not configured.' };
        }
        return await msTodo.moveTask(input.list_id, input.task_id, input.target_list_id, input.target_list_name);

      case 'ms_todo_get_checklist':
        if (!msTodo.isOutlookTodoConfigured()) {
          return { error: 'Microsoft To Do is not configured.' };
        }
        return await msTodo.getChecklistItems(input.list_id, input.task_id);

      case 'ms_todo_add_checklist_item':
        if (!msTodo.isOutlookTodoConfigured()) {
          return { error: 'Microsoft To Do is not configured.' };
        }
        return await msTodo.addChecklistItem(input.list_id, input.task_id, input.title);

      // ── Calendar tools (unified: Google + Outlook) ──
      case 'get_calendar_events':
        if (!unifiedCal.isAnyCalendarConfigured()) {
          return { error: 'No calendar is configured. Set Google or Outlook credentials.' };
        }
        return await unifiedCal.getEvents(input.start_date, input.end_date);

      case 'create_calendar_event':
        if (!unifiedCal.isAnyCalendarConfigured()) {
          return { error: 'No calendar is configured.' };
        }
        return await unifiedCal.createEvent({
          title: input.title,
          start: input.start,
          end: input.end,
          description: input.description,
          categories: input.categories,
        }, input.calendar_source);

      case 'update_calendar_event': {
        if (!unifiedCal.isAnyCalendarConfigured()) {
          return { error: 'No calendar is configured.' };
        }
        const updateSource = input.calendar_source || detectCalendarSource(input.event_id);
        return await unifiedCal.updateEvent({
          event_id: input.event_id,
          new_start: input.new_start,
          new_end: input.new_end,
          new_title: input.new_title,
        }, updateSource);
      }

      case 'delete_calendar_event': {
        if (!unifiedCal.isAnyCalendarConfigured()) {
          return { error: 'No calendar is configured.' };
        }
        const deleteSource = input.calendar_source || detectCalendarSource(input.event_id);
        await unifiedCal.deleteEvent(input.event_id, deleteSource);
        return { success: true, message: 'Event deleted' };
      }

      // ── Reminder tools ──
      case 'set_reminder':
        return setReminder({
          message: input.message,
          remind_at: input.remind_at,
          recurring: input.recurring,
        });

      // ── Note tools ──
      case 'save_note':
        return saveNote({
          content: input.content,
          domain: input.domain,
          tags: input.tags,
        });

      case 'search_notes':
        return searchNotes({
          query: input.query,
          domain: input.domain,
          tag: input.tag,
        });

      // ── Outlook Email tools ──
      case 'search_outlook_emails':
        if (!outlookMail.isOutlookMailConfigured()) {
          return { error: 'Outlook is not configured. Set OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, and OUTLOOK_REFRESH_TOKEN.' };
        }
        return await outlookMail.searchEmails(input.query, input.max_results || 10);

      case 'read_outlook_email':
        if (!outlookMail.isOutlookMailConfigured()) {
          return { error: 'Outlook is not configured.' };
        }
        return await outlookMail.readEmail(input.message_id);

      case 'send_outlook_email':
        if (!outlookMail.isOutlookMailConfigured()) {
          return { error: 'Outlook is not configured.' };
        }
        await outlookMail.sendEmail({
          to: input.to,
          subject: input.subject,
          body: input.body,
          cc: input.cc,
        });
        return { success: true, message: `Email sent to ${input.to}` };

      case 'reply_outlook_email':
        if (!outlookMail.isOutlookMailConfigured()) {
          return { error: 'Outlook is not configured.' };
        }
        await outlookMail.replyToEmail({
          messageId: input.message_id,
          body: input.body,
        });
        return { success: true, message: 'Reply sent' };

      case 'get_outlook_unread': {
        if (!outlookMail.isOutlookMailConfigured()) {
          return { error: 'Outlook is not configured.' };
        }
        const { count: unreadCount, emails: unreadEmails } = await outlookMail.getUnreadEmails(input.max_results || 10);
        return { unread_count: unreadCount, recent_unread: unreadEmails };
      }

      // ── Shared memory tools (cross-domain context) ──
      case 'shared_memory_set': {
        const entry = setSharedMemory(input.key, input.value, 'secretary', input.expires_at);
        return { success: true, key: entry.key, value: entry.value };
      }

      case 'shared_memory_remove': {
        const removed = removeSharedMemory(input.key);
        return { success: removed, key: input.key };
      }

      // ── Finance tools ──
      case 'finance_add_transaction': {
        const uid = userId ?? 0;
        const tx = financeTracker.addTransaction(uid, input.date, input.category, input.amount, {
          subcategory: input.subcategory, description: input.description,
        });
        return { success: true, id: tx.id, date: tx.date, category: tx.category, amount: tx.amount };
      }
      case 'finance_get_transactions': {
        const uid = userId ?? 0;
        return financeTracker.getTransactions(uid, {
          startDate: input.start_date, endDate: input.end_date,
          category: input.category, limit: input.limit,
        });
      }
      case 'finance_delete_transaction': {
        const uid = userId ?? 0;
        const deleted = financeTracker.deleteTransaction(uid, input.transaction_id);
        return deleted ? { success: true } : { error: 'Transaction not found or unauthorized' };
      }
      case 'finance_monthly_summary': {
        const uid = userId ?? 0;
        return financeTracker.getMonthlySummary(uid, input.month);
      }
      case 'finance_calculate_tax': {
        const uid = userId ?? 0;
        const taxEvent = financeTracker.calculateAndStoreTax(uid, input.month);
        const breakdown = financeTracker.calculateMonthlyTax(taxEvent.gross_income, taxEvent.deductions);
        return { ...taxEvent, effectiveRate: breakdown.effectiveRate, bracket: breakdown.bracket };
      }
      case 'finance_get_tax_events': {
        const uid = userId ?? 0;
        return financeTracker.getTaxEvents(uid, { year: input.year, limit: input.limit });
      }
      case 'finance_mark_tax_paid': {
        const uid = userId ?? 0;
        const marked = financeTracker.markTaxPaid(uid, input.month);
        return marked ? { success: true, month: input.month, status: 'paid' } : { error: 'Tax event not found' };
      }

      // ── Cooking tools ──
      case 'cooking_add_recipe': {
        const uid = userId ?? 0;
        const recipe = cookingChef.addRecipe(uid, input.title, input.ingredients, {
          instructions: input.instructions, prepTime: input.prep_time_min,
          cookTime: input.cook_time_min, servings: input.servings, tags: input.tags,
        });
        return { success: true, id: recipe.id, title: recipe.title };
      }
      case 'cooking_get_recipes': {
        const uid = userId ?? 0;
        return cookingChef.getRecipes(uid, { tags: input.tags, search: input.search, limit: input.limit });
      }
      case 'cooking_delete_recipe': {
        const uid = userId ?? 0;
        return cookingChef.deleteRecipe(uid, input.recipe_id) ? { success: true } : { error: 'Recipe not found' };
      }
      case 'cooking_set_meal': {
        const uid = userId ?? 0;
        const meal = cookingChef.setMealPlan(uid, input.date, input.meal_type, input.title, {
          recipeId: input.recipe_id, notes: input.notes,
        });
        return { success: true, date: meal.date, meal_type: meal.meal_type, title: meal.title };
      }
      case 'cooking_get_meal_plan': {
        const uid = userId ?? 0;
        return cookingChef.getMealPlan(uid, input.start_date, input.end_date);
      }
      case 'cooking_delete_meal': {
        const uid = userId ?? 0;
        return cookingChef.deleteMealPlan(uid, input.date, input.meal_type) ? { success: true } : { error: 'Meal not found' };
      }
      case 'cooking_generate_shopping_list': {
        const uid = userId ?? 0;
        return cookingChef.generateShoppingList(uid, input.week_start);
      }
      case 'cooking_get_shopping_list': {
        const uid = userId ?? 0;
        const list = cookingChef.getShoppingList(uid, input.week_start);
        return list || { items: [], status: 'not_found' };
      }

      default:
        logger.warn({ tool: toolName }, 'Unknown tool called');
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error({ err, tool: toolName }, 'Tool execution failed');
    return { error: `Tool execution failed: ${(err as Error).message}` };
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
