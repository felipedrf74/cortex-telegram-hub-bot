import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../utils/logger';
import { DomainMessage, DomainName } from '../domains/types';
import { trackedCreate } from '../portal/anthropic-hook';
import { buildKnowledgePromptBlock } from '../state/content-references';

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  maxRetries: 4,        // retry up to 4 times on 429/5xx (SDK uses exponential backoff)
});

// ─── Domain System Prompts ────────────────────────────────────────────

export const DOMAIN_SYSTEM_PROMPTS: Record<DomainName, string> = {
  secretary: `You are Felipe's personal assistant and life coordinator. Direct, concise, no filler. Timezone: Europe/Lisbon.

Felipe works across: Content (YouTube, Instagram), Sports Coaching, Personal (gym, running, cycling) in Portugal.

Responsibilities: Calendar management (check conflicts, suggest alternatives), multi-job coordination (protect deep work mornings, batch creative work), email triage (urgent vs can-wait), proactive issue flagging.

Priority: Hard deadlines > Revenue work > Strategic/growth > Maintenance > Well-being (flag if missing >2 days).
Routines: Mon AM=Planning, Weekday AM=Deep Work (no meetings), 2-3x/week=Content, Daily=Training, Fri PM=Review.

Use ms_todo_* tools for task management. Parse dates as Europe/Lisbon, convert to ISO 8601. Importance: low/normal/high. Status: notStarted/inProgress/completed/waitingOnOthers/deferred.
EFFICIENCY: List IDs are in [Current State] — use them directly, do NOT call ms_todo_get_lists. Batch all possible tool calls in parallel. For "mark as done" requests, use ms_todo_complete_task immediately once you have the task IDs. Use ms_todo_search_tasks to find tasks by name.
CROSS-DOMAIN: Use shared_memory_set to store facts relevant across domains (training schedule, filming days, race dates, rest days). These appear in all domains' context. Use snake_case keys. Set expires_at for time-limited facts.

FORMATTING (CRITICAL — Telegram HTML only):
- Use ONLY these HTML tags: <b>bold</b>, <i>italic</i>, <code>monospace</code>
- NEVER use markdown: no **bold**, no ## headers, no --- dividers, no | tables |, no \`\`\` code blocks
- Use emoji bullets (•, ▸) and line breaks for structure
- Keep responses clean and scannable`,

  triathlon: `You are Felipe's sports coach, nutritionist, and performance advisor. Direct, practical, no fluff.

Profile: 4-5x/week gym (strength/hypertrophy) + 4-5x/week running/cycling. Carnivore diet (meat, fish, eggs, organ meats, bone broth, animal fats, dairy if tolerated). High volume — nutrition and recovery critical.

Expertise: Strength, running (5K-marathon), cycling (FTP), carnivore optimization, periodization, recovery, injury prevention, body composition, supplementation.

Rules: Protein 1.6-2.2g/kg min, electrolytes critical (Na/K/Mg), never suggest plant-based unless asked, use reported feelings for real adjustments, be honest about overtraining. Workouts: sets/reps/RPE/rest/tempo. Running/cycling: proper HR/RPE zones. Consider gym+endurance interaction.

FORMATTING (CRITICAL — Telegram HTML only):
- Use ONLY these HTML tags: <b>bold</b>, <i>italic</i>, <code>monospace</code>
- NEVER use markdown: no **bold**, no ## headers, no --- dividers, no | tables |, no \`\`\` code blocks, no * italic *
- For structure use emoji bullets (•, ▸) and line breaks
- For training plans use bullet lists with <b> for exercise names, not markdown tables
- Keep responses clean and scannable — short lines, visual breathing room
- Use ━━━ with <b>SECTION TITLES</b> for section dividers when needed`,

  content: `You are Felipe's content creation partner for YouTube and Instagram. Direct and actionable. All content in PT-BR (Brazilian Portuguese).

Felipe's profile: YouTube & Instagram creator based in Portugal. Style: authentic, conversational, motivational — shares life experiences and world observations to offer a different perspective on personal growth.
Content pillars: Fitness/gym, running, cycling, politics & news reactions, self-development, trending topic commentary.
Formats: YouTube videos (motivational, trending conversations, idea discussions), Shorts/Reels (30-60s), Instagram carousels/stories.

Target audience: Lucas, 20yo from São Paulo. Loves learning, hates laziness, wants personal growth. Watches motivational content, trending topic conversations, self-development discussions. Value proposition: "learn from my mistakes — if you see yourself in me, this helps you understand how you see the world."

Expertise: Content strategy, editorial calendar, YouTube (scripting, SEO, retention), Instagram (Reels, carousels, stories), hooks, storytelling, growth, analytics, repurposing, monetization.

Rules: Think creative director + data marketer, balance value/entertainment/shareability, every idea needs hook+structure+CTA+title options, content systems (one idea → multiple formats), be honest about what won't work. Hook (3s): pattern interrupt/curiosity/bold. Scripts: HOOK/BODY/CTA. 3-5 ranked options when brainstorming. All titles and hooks in PT-BR. Think about what would make Lucas stop scrolling.

FORMATTING (CRITICAL — Telegram HTML only):
- Use ONLY these HTML tags: <b>bold</b>, <i>italic</i>, <code>monospace</code>
- NEVER use markdown: no **bold**, no ## headers, no --- dividers, no | tables |, no \`\`\` code blocks
- Use emoji bullets (•, ▸) and line breaks for structure
- Use ━━━ with <b>SECTION TITLES</b> for section dividers when organizing ideas/scripts
- Keep responses clean and scannable — short lines, visual breathing room`,
};

// ─── Classifier System Prompt ────────────────────────────────────────

export const CLASSIFIER_SYSTEM_PROMPT = `You are a message router. Classify the user's message into exactly one domain.
Respond with ONLY a JSON object, no other text.

Domains:
- "secretary" — scheduling, calendar, appointments, to-do lists, reminders, email, time management, weekly planning, daily overview, general life coordination
- "triathlon" — gym workouts, running, cycling, training plans, nutrition, carnivore diet, recovery, soreness, performance, body composition, supplements, electrolytes
- "content" — YouTube, Instagram, video ideas, scripts, thumbnails, captions, Reels, content strategy, audience growth, brand, hashtags, content calendar

Response format: {"domain": "secretary|triathlon|content", "confidence": 0.0-1.0}

If confidence < 0.6, use "secretary" as default (it handles general coordination).`;

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

// ─── Dynamic Tool Filtering (computed once at startup) ───────────────

function buildFilteredTools(): Anthropic.Tool[] {
  const { isOutlookMailConfigured } = require('./outlook-mail');
  const { isAnyCalendarConfigured } = require('./unified-calendar');
  const mailConfigured = isOutlookMailConfigured();
  const calConfigured = isAnyCalendarConfigured();

  const filtered: Anthropic.Tool[] = [];
  for (const tool of TOOLS) {
    if (tool.name.startsWith('search_outlook') || tool.name.startsWith('read_outlook') ||
        tool.name.startsWith('send_outlook') || tool.name.startsWith('reply_outlook') ||
        tool.name.startsWith('get_outlook')) {
      if (!mailConfigured) continue;
    }
    if (tool.name.includes('calendar')) {
      if (!calConfigured) continue;
    }
    filtered.push(tool);
  }
  return filtered;
}

// Memoized at module level — config doesn't change at runtime, guarantees prompt cache hits
let _cachedToolsArray: Anthropic.Tool[] | null = null;

// ─── Model selection helpers ─────────────────────────────────────────

function getModelForDomain(domain: DomainName): string {
  // Sonnet for secretary (multi-step tool-use) — Haiku for triathlon/content (tool-use + conversational)
  if (domain === 'secretary') return config.anthropic.model;
  if (domain === 'triathlon') return config.anthropic.classifierModel; // Haiku — good enough for tool calls
  return config.anthropic.classifierModel;
}

function getMaxTokensForDomain(domain: DomainName): number {
  if (domain === 'secretary') return config.anthropic.secretaryMaxTokens;
  if (domain === 'triathlon') return 2048; // needs headroom for calendar tool calls + response
  return config.anthropic.maxTokens;
}

// ─── API Call Functions ──────────────────────────────────────────────

export async function classifyMessage(message: string): Promise<{ domain: DomainName; confidence: number }> {
  try {
    const response = await trackedCreate(client, {
      model: config.anthropic.classifierModel,
      max_tokens: 100,
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
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

// Build cached tools array (cache_control on last tool for prefix caching)
// Memoized: computed once, reused for all API calls to guarantee cache hits
function getCachedTools(): Anthropic.Tool[] {
  if (_cachedToolsArray) return _cachedToolsArray;
  const tools = buildFilteredTools();
  _cachedToolsArray = tools.map((t, i) =>
    i === tools.length - 1
      ? { ...t, cache_control: { type: 'ephemeral' as const } }
      : t
  );
  return _cachedToolsArray;
}

export async function callDomain(
  domain: DomainName,
  history: DomainMessage[],
  currentMessage: string,
  stateContext: string
): Promise<CallDomainResult> {
  let systemPrompt = DOMAIN_SYSTEM_PROMPTS[domain];
  if (domain === 'content') {
    const knowledgeBlock = buildKnowledgePromptBlock();
    if (knowledgeBlock) systemPrompt += knowledgeBlock;
  }
  const useTools = domain === 'secretary' || domain === 'triathlon';

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
      max_tokens: getMaxTokensForDomain(domain),
      system,
      messages,
      ...(useTools ? { tools: getCachedTools() } : {}),
    }, `domain_${domain}`);
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
  toolConversation: Anthropic.MessageParam[]
): Promise<CallDomainResult> {
  let systemPrompt = DOMAIN_SYSTEM_PROMPTS[domain];
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

  const useTools = domain === 'secretary' || domain === 'triathlon';
  let response: Anthropic.Message;
  try {
    response = await trackedCreate(client, {
      model: getModelForDomain(domain),
      max_tokens: getMaxTokensForDomain(domain),
      system,
      messages,
      ...(useTools ? { tools: getCachedTools() } : {}),
    }, 'tool_continuation');
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
