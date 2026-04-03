// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../utils/logger';
import { DomainMessage, DomainName } from '../domains/types';
import { trackedCreate } from '../portal/anthropic-hook';
import { buildKnowledgePromptBlock } from '../state/content-references';
import { loadPrompt } from '../utils/prompt-loader';

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  maxRetries: 4,        // retry up to 4 times on 429/5xx (SDK uses exponential backoff)
});

// ─── Domain System Prompts (loaded from prompts/*.md) ─────────────────

export function getDomainSystemPrompt(domain: DomainName): string {
  return loadPrompt(domain);
}

// Backwards-compatible alias — kept for any external imports
export const DOMAIN_SYSTEM_PROMPTS: Record<DomainName, string> = new Proxy(
  {} as Record<DomainName, string>,
  { get: (_target, prop: string) => loadPrompt(prop) },
);

// ─── Classifier System Prompt (loaded from prompts/classifier.md) ────

export function getClassifierSystemPrompt(): string {
  return loadPrompt('classifier');
}

// ─── Tool Definitions ────────────────────────────────────────────────

export const TOOLS: Anthropic.Tool[] = [
  // ── Task tools (core — list IDs come from state context, no need for get_lists) ──
  {
    name: 'ms_todo_get_tasks', description: 'Get tasks from a list with optional status filter',
    input_schema: { type: 'object' as const, properties: {
      list_id: { type: 'string' }, list_name: { type: 'string' },
      status: { type: 'string', enum: ['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred'] },
    }, required: ['list_id', 'list_name'] },
  },
  {
    name: 'ms_todo_create_task', description: 'Create a task in a list',
    input_schema: { type: 'object' as const, properties: {
      list_id: { type: 'string' }, list_name: { type: 'string' }, title: { type: 'string' },
      body: { type: 'string' }, importance: { type: 'string', enum: ['low', 'normal', 'high'] },
      due_date_time: { type: 'string', description: 'ISO 8601' }, reminder_date_time: { type: 'string', description: 'ISO 8601' },
    }, required: ['list_id', 'list_name', 'title'] },
  },
  {
    name: 'ms_todo_update_task', description: 'Update a task (title, body, importance, due date, reminder, status)',
    input_schema: { type: 'object' as const, properties: {
      list_id: { type: 'string' }, task_id: { type: 'string' },
      title: { type: 'string' }, body: { type: 'string' },
      importance: { type: 'string', enum: ['low', 'normal', 'high'] },
      status: { type: 'string', enum: ['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred'] },
      due_date_time: { type: 'string', description: 'ISO 8601 or null' }, reminder_date_time: { type: 'string', description: 'ISO 8601 or null' },
    }, required: ['list_id', 'task_id'] },
  },
  { name: 'ms_todo_complete_task', description: 'Complete a task', input_schema: { type: 'object' as const, properties: { list_id: { type: 'string' }, task_id: { type: 'string' } }, required: ['list_id', 'task_id'] } },
  { name: 'ms_todo_uncomplete_task', description: 'Reopen a completed task', input_schema: { type: 'object' as const, properties: { list_id: { type: 'string' }, task_id: { type: 'string' } }, required: ['list_id', 'task_id'] } },
  { name: 'ms_todo_delete_task', description: 'Delete a task', input_schema: { type: 'object' as const, properties: { list_id: { type: 'string' }, task_id: { type: 'string' } }, required: ['list_id', 'task_id'] } },
  { name: 'ms_todo_search_tasks', description: 'Search tasks by keyword across all lists', input_schema: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'ms_todo_get_due_tasks', description: 'Get tasks due in a date range', input_schema: { type: 'object' as const, properties: { start_date: { type: 'string', description: 'ISO 8601' }, end_date: { type: 'string', description: 'ISO 8601' } }, required: ['start_date', 'end_date'] } },
  { name: 'ms_todo_move_task', description: 'Move a task to a different list (creates copy, deletes original)', input_schema: { type: 'object' as const, properties: { list_id: { type: 'string' }, task_id: { type: 'string' }, target_list_id: { type: 'string' }, target_list_name: { type: 'string' } }, required: ['list_id', 'task_id', 'target_list_id', 'target_list_name'] } },
  { name: 'ms_todo_get_checklist', description: 'Get checklist items (subtasks/steps) of a task', input_schema: { type: 'object' as const, properties: { list_id: { type: 'string' }, task_id: { type: 'string' } }, required: ['list_id', 'task_id'] } },
  { name: 'ms_todo_add_checklist_item', description: 'Add a checklist item (step) to a task', input_schema: { type: 'object' as const, properties: { list_id: { type: 'string' }, task_id: { type: 'string' }, title: { type: 'string' } }, required: ['list_id', 'task_id', 'title'] } },
  { name: 'ms_todo_get_lists', description: 'Get all task lists with their IDs', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'ms_todo_create_list', description: 'Create a new task list', input_schema: { type: 'object' as const, properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'ms_todo_delete_list', description: 'Delete a task list', input_schema: { type: 'object' as const, properties: { list_id: { type: 'string' } }, required: ['list_id'] } },
  // ── Calendar tools ──
  { name: 'get_calendar_events', description: 'Get calendar events for a date range', input_schema: { type: 'object' as const, properties: { start_date: { type: 'string', description: 'ISO 8601' }, end_date: { type: 'string', description: 'ISO 8601' } }, required: ['start_date', 'end_date'] } },
  { name: 'create_calendar_event', description: 'Create a calendar event', input_schema: { type: 'object' as const, properties: { title: { type: 'string' }, start: { type: 'string', description: 'ISO 8601' }, end: { type: 'string', description: 'ISO 8601' }, description: { type: 'string' }, categories: { type: 'array', items: { type: 'string' }, description: 'Outlook categories e.g. ["Blue Category"]' } }, required: ['title', 'start', 'end'] } },
  { name: 'update_calendar_event', description: 'Update an EXISTING calendar event (title, time). Use this to modify events — never create duplicates.', input_schema: { type: 'object' as const, properties: { event_id: { type: 'string' }, new_start: { type: 'string', description: 'ISO 8601' }, new_end: { type: 'string', description: 'ISO 8601' }, new_title: { type: 'string' }, calendar_source: { type: 'string', description: '"outlook" or "google"' } }, required: ['event_id'] } },
  { name: 'delete_calendar_event', description: 'Delete an EXISTING calendar event (for cancellations/rest days).', input_schema: { type: 'object' as const, properties: { event_id: { type: 'string' }, calendar_source: { type: 'string', description: '"outlook" or "google"' } }, required: ['event_id'] } },
  // ── Reminder & notes tools ──
  { name: 'set_reminder', description: 'Set a reminder', input_schema: { type: 'object' as const, properties: { message: { type: 'string' }, remind_at: { type: 'string', description: 'ISO 8601' }, recurring: { type: 'string', description: 'null/daily/weekly/monthly/cron' } }, required: ['message', 'remind_at'] } },
  { name: 'save_note', description: 'Save a note', input_schema: { type: 'object' as const, properties: { content: { type: 'string' }, domain: { type: 'string' }, tags: { type: 'string' } }, required: ['content'] } },
  { name: 'search_notes', description: 'Search notes', input_schema: { type: 'object' as const, properties: { query: { type: 'string' }, domain: { type: 'string' }, tag: { type: 'string' } } } },
  // ── Email tools ──
  { name: 'search_outlook_emails', description: 'Search emails by keyword', input_schema: { type: 'object' as const, properties: { query: { type: 'string' }, max_results: { type: 'number' } }, required: ['query'] } },
  { name: 'read_outlook_email', description: 'Read an email by ID', input_schema: { type: 'object' as const, properties: { message_id: { type: 'string' } }, required: ['message_id'] } },
  { name: 'send_outlook_email', description: 'Send an email', input_schema: { type: 'object' as const, properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, cc: { type: 'string' } }, required: ['to', 'subject', 'body'] } },
  { name: 'reply_outlook_email', description: 'Reply to an email', input_schema: { type: 'object' as const, properties: { message_id: { type: 'string' }, body: { type: 'string' } }, required: ['message_id', 'body'] } },
  { name: 'get_outlook_unread', description: 'Get unread emails', input_schema: { type: 'object' as const, properties: { max_results: { type: 'number' } } } },
  // ── Shared memory tools (cross-domain context) ──
  { name: 'shared_memory_set', description: 'Store a cross-domain fact visible to all domains (e.g. "marathon_date: March 15"). Use for info relevant across secretary/triathlon/content.', input_schema: { type: 'object' as const, properties: { key: { type: 'string', description: 'Short snake_case identifier' }, value: { type: 'string' }, expires_at: { type: 'string', description: 'Optional ISO 8601 expiry' } }, required: ['key', 'value'] } },
  { name: 'shared_memory_remove', description: 'Remove a cross-domain fact by key', input_schema: { type: 'object' as const, properties: { key: { type: 'string' } }, required: ['key'] } },
  // ── Training Plan tools ──
  {
    name: 'create_training_plan', description: 'Create a new periodized training plan with weeks and sessions. Creates the plan shell — then add weeks and sessions.',
    input_schema: { type: 'object' as const, properties: {
      name: { type: 'string', description: 'Plan name e.g. "12-Week Strength Base"' },
      sport: { type: 'string', description: 'strength, running, cycling, triathlon, or hybrid' },
      goal: { type: 'string', description: 'Training goal e.g. "Build strength base for marathon"' },
      duration_weeks: { type: 'number', description: 'Number of weeks' },
      periodization: { type: 'string', description: 'linear, undulating, or block' },
      start_date: { type: 'string', description: 'ISO 8601 date' },
      end_date: { type: 'string', description: 'ISO 8601 date' },
      preferences_json: { type: 'string', description: 'JSON with available_days, equipment, injuries, etc.' },
    }, required: ['name', 'sport', 'duration_weeks', 'start_date', 'end_date'] },
  },
  {
    name: 'add_training_week', description: 'Add a training week (microcycle) to an existing plan',
    input_schema: { type: 'object' as const, properties: {
      plan_id: { type: 'number' },
      week_number: { type: 'number' },
      focus: { type: 'string', description: 'strength, hypertrophy, endurance, power, deload, recovery' },
      intensity_pct: { type: 'number', description: 'Intensity percentage 0-110 (60 for deload)' },
      volume_sessions: { type: 'number', description: 'Target sessions this week' },
      notes: { type: 'string' },
    }, required: ['plan_id', 'week_number'] },
  },
  {
    name: 'add_training_session', description: 'Add a training session to a week. After adding, optionally create a calendar blocker with create_calendar_event and link it.',
    input_schema: { type: 'object' as const, properties: {
      week_id: { type: 'number' },
      plan_id: { type: 'number' },
      day_of_week: { type: 'string', description: 'Monday, Tuesday, etc.' },
      session_type: { type: 'string', description: 'strength, running, cycling, swim, recovery, mobility' },
      title: { type: 'string', description: 'Session title e.g. "Upper Body Push"' },
      description: { type: 'string' },
      exercises_json: { type: 'string', description: 'JSON array: [{name, sets, reps, weight, rpe, rest_sec, tempo}]' },
      duration_minutes: { type: 'number' },
      intensity_text: { type: 'string', description: 'e.g. "RPE 7", "Zone 2", "80% 1RM"' },
    }, required: ['week_id', 'plan_id', 'day_of_week', 'session_type', 'title'] },
  },
  {
    name: 'get_training_plan', description: 'Get the active training plan with current week sessions and adherence stats',
    input_schema: { type: 'object' as const, properties: {
      plan_id: { type: 'number', description: 'Specific plan ID, or omit for active plan' },
    } },
  },
  {
    name: 'log_training_completion', description: 'Log a completed training session with actual performance data',
    input_schema: { type: 'object' as const, properties: {
      session_id: { type: 'number' },
      rpe_overall: { type: 'number', description: '1-10 RPE' },
      duration_minutes: { type: 'number' },
      energy_level: { type: 'number', description: '1-10' },
      soreness_level: { type: 'number', description: '1-10' },
      actual_exercises_json: { type: 'string', description: 'JSON of what was actually done' },
      notes: { type: 'string' },
    }, required: ['session_id'] },
  },
  {
    name: 'update_training_session', description: 'Update a training session (exercises, intensity, status)',
    input_schema: { type: 'object' as const, properties: {
      session_id: { type: 'number' },
      title: { type: 'string' },
      exercises_json: { type: 'string' },
      duration_minutes: { type: 'number' },
      intensity_text: { type: 'string' },
      description: { type: 'string' },
      status: { type: 'string', description: 'pending, completed, skipped, moved' },
    }, required: ['session_id'] },
  },
  {
    name: 'link_session_calendar', description: 'Link a training session to an existing calendar event (after creating the calendar blocker)',
    input_schema: { type: 'object' as const, properties: {
      session_id: { type: 'number' },
      calendar_event_id: { type: 'string' },
      calendar_source: { type: 'string', description: '"outlook" or "google"' },
    }, required: ['session_id', 'calendar_event_id', 'calendar_source'] },
  },
  // ── Finance tools ──
  {
    name: 'finance_add_transaction', description: 'Log a financial transaction (income, expense, or deduction)',
    input_schema: { type: 'object' as const, properties: {
      date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      category: { type: 'string', enum: ['income', 'expense', 'deduction'], description: 'Transaction type' },
      amount: { type: 'number', description: 'Amount in BRL (always positive)' },
      subcategory: { type: 'string', description: 'e.g. freelance, rent, software, health, education' },
      description: { type: 'string', description: 'Brief description of the transaction' },
    }, required: ['date', 'category', 'amount'] },
  },
  {
    name: 'finance_get_transactions', description: 'Get financial transactions with optional filters',
    input_schema: { type: 'object' as const, properties: {
      start_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      end_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      category: { type: 'string', enum: ['income', 'expense', 'deduction'] },
      limit: { type: 'number', description: 'Max results (default 50)' },
    } },
  },
  {
    name: 'finance_delete_transaction', description: 'Delete a transaction by ID',
    input_schema: { type: 'object' as const, properties: {
      transaction_id: { type: 'number', description: 'Transaction ID to delete' },
    }, required: ['transaction_id'] },
  },
  {
    name: 'finance_monthly_summary', description: 'Get monthly financial summary (income, expenses, deductions, net)',
    input_schema: { type: 'object' as const, properties: {
      month: { type: 'string', description: 'Month in YYYY-MM format' },
    }, required: ['month'] },
  },
  {
    name: 'finance_calculate_tax', description: 'Calculate Carnê-Leão / DARF tax for a month using IRPF progressive table',
    input_schema: { type: 'object' as const, properties: {
      month: { type: 'string', description: 'Month in YYYY-MM format. Uses stored transactions for income/deductions.' },
    }, required: ['month'] },
  },
  {
    name: 'finance_get_tax_events', description: 'Get tax calculation history',
    input_schema: { type: 'object' as const, properties: {
      year: { type: 'number', description: 'Filter by year (e.g. 2024)' },
      limit: { type: 'number', description: 'Max results (default 12)' },
    } },
  },
  {
    name: 'finance_mark_tax_paid', description: 'Mark a monthly DARF as paid',
    input_schema: { type: 'object' as const, properties: {
      month: { type: 'string', description: 'Month in YYYY-MM format' },
    }, required: ['month'] },
  },
  {
    name: 'finance_annual_summary', description: 'Get annual tax summary for IRPF declaration — totals for income, INSS, deductions, tax, payment status',
    input_schema: { type: 'object' as const, properties: {
      year: { type: 'number', description: 'Year (e.g. 2024)' },
    }, required: ['year'] },
  },
  // ── Cooking tools ──
  {
    name: 'cooking_add_recipe', description: 'Save a recipe with structured ingredients',
    input_schema: { type: 'object' as const, properties: {
      title: { type: 'string' },
      ingredients: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, quantity: { type: 'string' }, unit: { type: 'string' } }, required: ['name', 'quantity', 'unit'] } },
      instructions: { type: 'string' },
      prep_time_min: { type: 'number' },
      cook_time_min: { type: 'number' },
      servings: { type: 'number' },
      tags: { type: 'string', description: 'Comma-separated tags e.g. carnivore,quick,high-protein' },
    }, required: ['title', 'ingredients'] },
  },
  {
    name: 'cooking_get_recipes', description: 'Search saved recipes by tags or ingredient keywords',
    input_schema: { type: 'object' as const, properties: {
      tags: { type: 'string', description: 'Filter by tag' },
      search: { type: 'string', description: 'Search title or ingredients' },
      limit: { type: 'number' },
    } },
  },
  {
    name: 'cooking_delete_recipe', description: 'Delete a saved recipe',
    input_schema: { type: 'object' as const, properties: {
      recipe_id: { type: 'number' },
    }, required: ['recipe_id'] },
  },
  {
    name: 'cooking_set_meal', description: 'Plan a meal for a specific date and meal type',
    input_schema: { type: 'object' as const, properties: {
      date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
      title: { type: 'string', description: 'Meal description' },
      recipe_id: { type: 'number', description: 'Optional link to saved recipe' },
      notes: { type: 'string' },
    }, required: ['date', 'meal_type', 'title'] },
  },
  {
    name: 'cooking_get_meal_plan', description: 'Get meal plan for a date range',
    input_schema: { type: 'object' as const, properties: {
      start_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      end_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
    }, required: ['start_date', 'end_date'] },
  },
  {
    name: 'cooking_delete_meal', description: 'Remove a planned meal',
    input_schema: { type: 'object' as const, properties: {
      date: { type: 'string' },
      meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
    }, required: ['date', 'meal_type'] },
  },
  {
    name: 'cooking_generate_shopping_list', description: 'Generate shopping list from meal plan for a week',
    input_schema: { type: 'object' as const, properties: {
      week_start: { type: 'string', description: 'ISO date YYYY-MM-DD (Monday of the week)' },
    }, required: ['week_start'] },
  },
  {
    name: 'cooking_get_shopping_list', description: 'Get existing shopping list for a week',
    input_schema: { type: 'object' as const, properties: {
      week_start: { type: 'string', description: 'ISO date YYYY-MM-DD' },
    }, required: ['week_start'] },
  },
];

// ─── Unified Image Classification & Extraction (uses Haiku — cheap vision) ──

export interface ExtractedCalendarEvent {
  title: string;
  start: string;   // ISO 8601 "YYYY-MM-DDTHH:MM:SS"
  end: string;
  description?: string;
}

export interface ImageInvoiceResult {
  type: 'invoice';
  confidence: number;
  documentDate: string | null;
  documentDateRaw: string | null;
  vendor: string | null;
  totalAmount: string | null;
  invoiceNumber: string | null;
}

export interface ImageCalendarResult {
  type: 'calendar';
  events: ExtractedCalendarEvent[];
}

export interface ImageTaskResult {
  type: 'task';
  title: string;
  subtasks: string[];
  listHint?: string;
}

export type ImageClassificationResult = ImageInvoiceResult | ImageCalendarResult | ImageTaskResult;

/**
 * Unified image classifier: determines whether the image is an invoice, calendar, or task list,
 * and extracts the relevant structured data in a single Haiku vision call.
 */
export async function classifyAndExtractImage(
  imageBase64: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
  caption?: string
): Promise<ImageClassificationResult> {
  const today = new Date().toISOString().split('T')[0];
  const currentYear = new Date().getFullYear();
  const tz = config.app.timezone || 'Europe/Lisbon';

  const prompt = caption
    ? `The user sent this image with caption: "${caption}"\n\nClassify and extract the content.`
    : `Classify and extract the content of this image.`;

  const response = await trackedCreate(client, {
    model: config.anthropic.classifierModel, // Haiku — cheap vision
    max_tokens: 4096,
    system: `You classify images into exactly ONE of three categories and extract structured data. Return ONLY valid JSON.

CATEGORY 1 — INVOICE / RECEIPT:
Indicators: nota fiscal, recibo, fatura, comprovante de pagamento, NF-e, NFS-e, receipt, invoice, bill, payment proof, ticket de compra, cupom fiscal, line items with prices, tax totals, business letterhead with amounts.
Return:
{"type":"invoice","confidence":0.95,"documentDate":"YYYY-MM-DD","documentDateRaw":"as shown","vendor":"business name","totalAmount":"€ 45,90","invoiceNumber":"NF-12345"}
- confidence: 0.0-1.0. Set high (>0.8) for clear invoices, low for uncertain.
- Use null for any field not found.
- For dates: look for "Data:", "Emissão:", "Date:", etc. Convert to ISO 8601.
- For amounts: look for "Total:", "Valor:", "Total a pagar:", "Amount:".

CATEGORY 2 — CALENDAR / SCHEDULE / TIMETABLE:
Indicators: dates with time ranges (09:00-10:30), weekday headers (Mon/Tue/Wed, Seg/Ter/Qua), agenda grids, weekly/monthly views, class schedules, shift schedules, appointment lists with specific times, timetables.
Return:
{"type":"calendar","events":[{"title":"Meeting","start":"YYYY-MM-DDTHH:MM:SS","end":"YYYY-MM-DDTHH:MM:SS","description":"optional"}]}
- Today is ${today}. Timezone: ${tz}. Current year: ${currentYear}.
- Use 24h format, ISO 8601, NO timezone suffix (system handles tz).
- If no end time, assume 1h duration.
- If all-day event, use 00:00:00 to 23:59:59.
- IMPORTANT: If the dates shown in the image are in the past (before today), shift ALL events forward to the NEXT occurrence of the same weekday. For example, if the image shows Monday March 23 but today is March 29, map it to Monday March 30.
- If week shown already passed this year, assume next year.
- Keep titles concise (max 60 chars). Skip description unless essential.
- OMIT Lunch events. Focus on meetings and work events.

CATEGORY 3 — TASK LIST / CHECKLIST:
Indicators: action items, to-dos, bullet points, checklists, shopping lists, numbered steps, reminders without specific time slots.
Return:
{"type":"task","title":"main task","subtasks":["item1","item2"],"listHint":"optional list name from caption"}
- If no subtasks, return empty array.
- If caption mentions a list name, include as listHint.

NOT a document: personal photos, selfies, food photos, memes, screenshots of chat messages → return {"type":"task","title":"Photo","subtasks":[]}.

When uncertain between calendar and task, prefer "task".`,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: prompt },
      ],
    }],
  }, 'classify_image');

  const stopReason = response.stop_reason;

  let text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(text);
    // Backwards compat: if no type field, treat as task
    if (!parsed.type) {
      return { type: 'task', title: parsed.title || '', subtasks: parsed.subtasks || [], listHint: parsed.listHint };
    }
    logger.info({ imageType: parsed.type, eventCount: parsed.events?.length, confidence: parsed.confidence }, 'Image classified');
    return parsed as ImageClassificationResult;
  } catch (err) {
    // If the model was cut off by max_tokens, try to repair truncated calendar JSON
    if (stopReason === 'max_tokens' && text.includes('"type"') && text.includes('"calendar"')) {
      const repaired = repairTruncatedCalendarJson(text);
      if (repaired) {
        logger.info({ eventCount: repaired.events.length }, 'Repaired truncated calendar JSON');
        return repaired;
      }
    }
    logger.warn({ err, stopReason, textLength: text.length }, 'Failed to parse image classification JSON, defaulting to task');
    return { type: 'task', title: text.slice(0, 100), subtasks: [] };
  }
}

/**
 * Attempt to repair a truncated calendar JSON response.
 * When max_tokens cuts off the output, we get a valid JSON prefix like:
 *   {"type":"calendar","events":[{...},{...},{...
 * We find the last complete event object and close the array/object.
 */
function repairTruncatedCalendarJson(text: string): ImageCalendarResult | null {
  try {
    // Find all complete event objects: match balanced { ... } inside the events array
    const eventsStart = text.indexOf('"events"');
    if (eventsStart === -1) return null;

    const arrayStart = text.indexOf('[', eventsStart);
    if (arrayStart === -1) return null;

    // Collect complete event objects by finding matching braces
    const events: ExtractedCalendarEvent[] = [];
    let depth = 0;
    let objStart = -1;

    for (let i = arrayStart + 1; i < text.length; i++) {
      if (text[i] === '{') {
        if (depth === 0) objStart = i;
        depth++;
      } else if (text[i] === '}') {
        depth--;
        if (depth === 0 && objStart !== -1) {
          try {
            const eventObj = JSON.parse(text.substring(objStart, i + 1));
            if (eventObj.title && eventObj.start && eventObj.end) {
              events.push(eventObj);
            }
          } catch {
            // Incomplete event object, skip
          }
          objStart = -1;
        }
      }
    }

    return events.length > 0 ? { type: 'calendar', events } : null;
  } catch {
    return null;
  }
}

// ─── Dynamic Tool Filtering ─────────────────────────────────────────

import { getToolsForDomain } from '../skills/skill-manager';

/** Service availability filter — removes tools for unconfigured services. */
function serviceAvailabilityFilter(tool: Anthropic.Tool): boolean {
  const { isOutlookMailConfigured } = require('./outlook-mail');
  const { isAnyCalendarConfigured } = require('./unified-calendar');

  if (tool.name.startsWith('search_outlook') || tool.name.startsWith('read_outlook') ||
      tool.name.startsWith('send_outlook') || tool.name.startsWith('reply_outlook') ||
      tool.name.startsWith('get_outlook')) {
    return isOutlookMailConfigured();
  }
  if (tool.name.includes('calendar')) {
    return isAnyCalendarConfigured();
  }
  return true;
}

/** Get per-domain filtered tools (sub-skill aware + service availability). */
function getToolsForDomainCached(domain: DomainName): Anthropic.Tool[] {
  return getToolsForDomain(domain, TOOLS, serviceAvailabilityFilter);
}

// Legacy fallback: global filtered tools for any code still using getCachedTools
let _cachedToolsArray: Anthropic.Tool[] | null = null;

// ─── Model selection helpers ─────────────────────────────────────────

function getModelForDomain(domain: DomainName): string {
  // Check for domain-specific override first
  try {
    const { getDomainModelOverride } = require('./model-config');
    const override = getDomainModelOverride('anthropic', domain);
    if (override) return override;
  } catch { /* model-config not loaded yet */ }

  // Tier-based routing: Sonnet for secretary, Haiku for everything else
  if (domain === 'secretary') return config.anthropic.model;
  return config.anthropic.classifierModel;
}

function getMaxTokensForDomain(domain: DomainName): number {
  if (domain === 'secretary') return config.anthropic.secretaryMaxTokens;
  if (domain === 'triathlon') return 2048; // needs headroom for calendar tool calls + response
  return config.anthropic.maxTokens;
}

// ─── API Call Functions ──────────────────────────────────────────────

export async function classifyMessage(
  message: string,
  activeConversationContext?: { domain: DomainName; lastAssistantMessage: string } | null,
): Promise<{ domain: DomainName; confidence: number }> {
  try {
    // Build the classifier input — include active conversation context if available
    let classifierInput = message;
    if (activeConversationContext) {
      classifierInput = `[ACTIVE CONVERSATION — domain: "${activeConversationContext.domain}"]
Last assistant message: "${activeConversationContext.lastAssistantMessage.substring(0, 300)}"

[NEW USER MESSAGE]
${message}`;
    }

    const response = await trackedCreate(client, {
      model: config.anthropic.classifierModel,
      max_tokens: 100,
      system: getClassifierSystemPrompt(),
      messages: [{ role: 'user', content: classifierInput }],
    }, 'classify_message');

    let text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    // Strip markdown code fences (Haiku sometimes wraps JSON)
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    const parsed = JSON.parse(text);
    const domain = parsed.domain as DomainName;
    const confidence = parsed.confidence as number;

    if (confidence < 0.6) return { domain: 'secretary', confidence };
    return { domain, confidence };
  } catch (err) {
    logger.error({ err }, 'Classification failed, defaulting to secretary');
    return { domain: 'secretary', confidence: 0 };
  }
}

export interface CallDomainResult {
  text: string;
  toolCalls: Anthropic.ToolUseBlock[];
  stopReason: string;
}

// Legacy getCachedTools — kept for backwards compatibility, delegates to secretary domain
function getCachedTools(): Anthropic.Tool[] {
  if (_cachedToolsArray) return _cachedToolsArray;
  _cachedToolsArray = getToolsForDomainCached('secretary');
  return _cachedToolsArray;
}

export async function callDomain(
  domain: DomainName,
  history: DomainMessage[],
  currentMessage: string,
  stateContext: string,
  maxTokensOverride?: number,
  userId?: number,
): Promise<CallDomainResult> {
  let systemPrompt = getDomainSystemPrompt(domain);
  if (domain === 'content') {
    const knowledgeBlock = buildKnowledgePromptBlock();
    if (knowledgeBlock) systemPrompt += knowledgeBlock;
  }
  // Per-domain tool filtering via sub-skill system
  const domainTools = getToolsForDomainCached(domain);
  const useTools = domainTools.length > 0;

  // Prompt caching: static system prompt cached, dynamic state in user message
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  // State context prepended to user message (keeps system prompt cacheable)
  const contextPrefix = stateContext ? `[Current State]\n${stateContext}\n\n` : '';
  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: `${contextPrefix}${currentMessage}` },
  ];

  let response: Anthropic.Message;
  try {
    response = await trackedCreate(client, {
      model: getModelForDomain(domain),
      max_tokens: maxTokensOverride || getMaxTokensForDomain(domain),
      system,
      messages,
      ...(useTools ? { tools: domainTools } : {}),
    }, `domain_${domain}`, { userId, isUserMessage: true });
  } catch (err) {
    logger.error({ err, domain }, 'Anthropic API call failed in callDomain');
    throw err;
  }

  const textBlocks = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text);

  const toolCalls = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

  return {
    text: textBlocks.join('\n'),
    toolCalls,
    stopReason: response.stop_reason || 'end_turn',
  };
}

export async function continueWithToolResults(
  domain: DomainName,
  history: DomainMessage[],
  currentMessage: string,
  stateContext: string,
  toolConversation: Anthropic.MessageParam[],
  userId?: number,
): Promise<CallDomainResult> {
  let systemPrompt = getDomainSystemPrompt(domain);
  if (domain === 'content') {
    const knowledgeBlock = buildKnowledgePromptBlock();
    if (knowledgeBlock) systemPrompt += knowledgeBlock;
  }

  // Same caching strategy: static system cached, state in user message
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  const contextPrefix = stateContext ? `[Current State]\n${stateContext}\n\n` : '';
  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: `${contextPrefix}${currentMessage}` },
    ...toolConversation,
  ];

  const domainTools = getToolsForDomainCached(domain);
  const useTools = domainTools.length > 0;
  let response: Anthropic.Message;
  try {
    response = await trackedCreate(client, {
      model: getModelForDomain(domain),
      max_tokens: getMaxTokensForDomain(domain),
      system,
      messages,
      ...(useTools ? { tools: domainTools } : {}),
    }, 'tool_continuation', { userId });
  } catch (err) {
    logger.error({ err, domain }, 'Anthropic API call failed in continueWithToolResults');
    throw err;
  }

  const textBlocks = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text);

  const toolCalls = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

  return {
    text: textBlocks.join('\n'),
    toolCalls,
    stopReason: response.stop_reason || 'end_turn',
  };
}
