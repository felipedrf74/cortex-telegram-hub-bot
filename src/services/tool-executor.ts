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
import * as trainingSignals from './training-signals';
import * as onboarding from './onboarding';
import { logger } from '../utils/logger';

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
        return setReminder(userId ?? 0, {
          message: input.message,
          remind_at: input.remind_at,
          recurring: input.recurring,
        });

      // ── Note tools ──
      case 'save_note':
        return saveNote(userId ?? 0, {
          content: input.content,
          domain: input.domain,
          tags: input.tags,
        });

      case 'search_notes':
        return searchNotes(userId ?? 0, {
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
        const entry = setSharedMemory(userId ?? 0, input.key, input.value, 'secretary', input.expires_at);
        return { success: true, key: entry.key, value: entry.value };
      }

      case 'shared_memory_remove': {
        const removed = removeSharedMemory(userId ?? 0, input.key);
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
        const plan = trainingPlans.createPlan({
          user_id: input.user_id || 0,
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
        const plan = input.plan_id
          ? trainingPlans.getPlanById(input.plan_id)
          : trainingPlans.getActivePlan(input.user_id || 0);
        if (!plan) return { error: 'No training plan found' };

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
        const linked = trainingPlans.linkSessionToCalendar(
          input.session_id, input.calendar_event_id, input.calendar_source,
        );
        return { success: linked, session_id: input.session_id };
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
      case 'finance_annual_summary': {
        const uid = userId ?? 0;
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
