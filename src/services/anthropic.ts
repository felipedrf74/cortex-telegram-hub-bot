import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../utils/logger';
import { DomainMessage, DomainName } from '../domains/types';

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
EFFICIENCY: List IDs are in [Current State] — use them directly, do NOT call ms_todo_get_lists. Batch all possible tool calls in parallel. For "mark as done" requests, use ms_todo_complete_task immediately once you have the task IDs. Use ms_todo_search_tasks to find tasks by name.`,

  triathlon: `You are Felipe's sports coach, nutritionist, and performance advisor. Direct, practical, no fluff.

Profile: 4-5x/week gym (strength/hypertrophy) + 4-5x/week running/cycling. Carnivore diet (meat, fish, eggs, organ meats, bone broth, animal fats, dairy if tolerated). High volume — nutrition and recovery critical.

Expertise: Strength, running (5K-marathon), cycling (FTP), carnivore optimization, periodization, recovery, injury prevention, body composition, supplementation.

Rules: Protein 1.6-2.2g/kg min, electrolytes critical (Na/K/Mg), never suggest plant-based unless asked, use reported feelings for real adjustments, be honest about overtraining. Workouts: sets/reps/RPE/rest/tempo. Running/cycling: proper HR/RPE zones. Consider gym+endurance interaction. Use tables for plans.`,

  content: `You are Felipe's content creation partner for YouTube and Instagram. Direct and actionable. All content in PT-BR (Brazilian Portuguese).

Felipe's profile: YouTube & Instagram creator based in Portugal. Style: authentic, conversational, motivational — shares life experiences and world observations to offer a different perspective on personal growth.
Content pillars: Fitness/gym, running, cycling, politics & news reactions, self-development, trending topic commentary.
Formats: YouTube videos (motivational, trending conversations, idea discussions), Shorts/Reels (30-60s), Instagram carousels/stories.

Target audience: Lucas, 20yo from São Paulo. Loves learning, hates laziness, wants personal growth. Watches motivational content, trending topic conversations, self-development discussions. Value proposition: "learn from my mistakes — if you see yourself in me, this helps you understand how you see the world."

Expertise: Content strategy, editorial calendar, YouTube (scripting, SEO, retention), Instagram (Reels, carousels, stories), hooks, storytelling, growth, analytics, repurposing, monetization.

Rules: Think creative director + data marketer, balance value/entertainment/shareability, every idea needs hook+structure+CTA+title options, content systems (one idea → multiple formats), be honest about what won't work. Hook (3s): pattern interrupt/curiosity/bold. Scripts: HOOK/BODY/CTA. 3-5 ranked options when brainstorming. All titles and hooks in PT-BR. Think about what would make Lucas stop scrolling.`,
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
  // ── Calendar tools ──
  { name: 'get_calendar_events', description: 'Get calendar events for a date range', input_schema: { type: 'object' as const, properties: { start_date: { type: 'string', description: 'ISO 8601' }, end_date: { type: 'string', description: 'ISO 8601' } }, required: ['start_date', 'end_date'] } },
  { name: 'create_calendar_event', description: 'Create a calendar event', input_schema: { type: 'object' as const, properties: { title: { type: 'string' }, start: { type: 'string', description: 'ISO 8601' }, end: { type: 'string', description: 'ISO 8601' }, description: { type: 'string' } }, required: ['title', 'start', 'end'] } },
  { name: 'update_calendar_event', description: 'Update a calendar event', input_schema: { type: 'object' as const, properties: { event_id: { type: 'string' }, new_start: { type: 'string' }, new_end: { type: 'string' }, new_title: { type: 'string' } }, required: ['event_id'] } },
  { name: 'delete_calendar_event', description: 'Delete a calendar event', input_schema: { type: 'object' as const, properties: { event_id: { type: 'string' } }, required: ['event_id'] } },
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
];

// ─── Image Extraction (uses Haiku — cheap vision) ────────────────────

export async function extractImageContent(
  imageBase64: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
  caption?: string
): Promise<{ title: string; subtasks: string[]; listHint?: string }> {
  const prompt = caption
    ? `The user sent this image with caption: "${caption}"\n\nExtract a task title and any subtasks/items visible in the image. If the caption mentions a list name, include it as listHint.`
    : `Extract a task title and any subtasks/items visible in this image.`;

  const response = await client.messages.create({
    model: config.anthropic.classifierModel, // Haiku — 3x cheaper than Sonnet
    max_tokens: 512,
    system: `You extract task information from images. Return ONLY valid JSON: {"title": "main task", "subtasks": ["item1", "item2"], "listHint": "optional list name from caption"}. If no subtasks are visible, return an empty array. Keep titles concise.`,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  let text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return JSON.parse(text);
  } catch {
    // Fallback: use the raw text as title
    return { title: text.slice(0, 100), subtasks: [] };
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
  // Sonnet for secretary (multi-step tool-use) — Haiku for conversational domains
  return domain === 'secretary' ? config.anthropic.model : config.anthropic.classifierModel;
}

function getMaxTokensForDomain(domain: DomainName): number {
  return domain === 'secretary' ? config.anthropic.secretaryMaxTokens : config.anthropic.maxTokens;
}

// ─── API Call Functions ──────────────────────────────────────────────

export async function classifyMessage(message: string): Promise<{ domain: DomainName; confidence: number }> {
  try {
    const response = await client.messages.create({
      model: config.anthropic.classifierModel,
      max_tokens: 100,
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
    });

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
  const systemPrompt = DOMAIN_SYSTEM_PROMPTS[domain];
  const useTools = domain === 'secretary';

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

  const response = await client.messages.create({
    model: getModelForDomain(domain),
    max_tokens: getMaxTokensForDomain(domain),
    system,
    messages,
    ...(useTools ? { tools: getCachedTools() } : {}),
  });

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
  const systemPrompt = DOMAIN_SYSTEM_PROMPTS[domain];

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

  const useTools = domain === 'secretary';
  const response = await client.messages.create({
    model: getModelForDomain(domain),
    max_tokens: getMaxTokensForDomain(domain),
    system,
    messages,
    ...(useTools ? { tools: getCachedTools() } : {}),
  });

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
