// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Eval Criteria Registry — defines evaluation targets, criteria, and test inputs
 * for the autoresearch prompt optimization system.
 */

export interface EvalCriterion {
  id: string;
  question: string;
  weight: number;
}

export interface TestInput {
  id: string;
  userMessage: string;
  stateContext?: string;
  description: string;
}

export interface EvalTarget {
  id: string;
  promptFile: string;
  description: string;
  criteria: EvalCriterion[];
  testInputs: TestInput[];
  model: string;
  scorerModel: string;
  maxTokens: number;
}

// ─── Target Definitions ──────────────────────────────────────────────

const targets: EvalTarget[] = [
  // ── 1. Secretary ───────────────────────────────────────────────────
  {
    id: 'secretary',
    promptFile: 'secretary',
    description: 'Personal assistant — calendar, tasks, email triage',
    model: 'claude-sonnet-4-6',
    scorerModel: 'claude-haiku-4-5-20251001',
    maxTokens: 2048,
    criteria: [
      { id: 'tool_efficiency', question: 'Does the response use the minimum number of tool calls needed (no redundant calls)?', weight: 2 },
      { id: 'template_format', question: 'Does the response use clean HTML formatting (no markdown, proper <b>/<i>/<code> tags)?', weight: 1 },
      { id: 'parallel_tools', question: 'When multiple independent tool calls are needed, does the response issue them in parallel (single turn) rather than sequentially?', weight: 2 },
      { id: 'timezone', question: 'Are all dates and times correctly interpreted in Europe/Lisbon timezone with proper ISO 8601 format?', weight: 1.5 },
      { id: 'html_only', question: 'Is the response free of markdown syntax (* ** ``` #) and uses only HTML tags?', weight: 1 },
    ],
    testInputs: [
      {
        id: 'sec_reschedule',
        userMessage: 'Move my 3pm meeting tomorrow to Friday at the same time',
        stateContext: `Today: 2026-03-25 (Wednesday). Timezone: Europe/Lisbon.\nCalendar events tomorrow:\n- 09:00-10:00 Deep Work (outlook, id: evt_001)\n- 15:00-16:00 Client Call (outlook, id: evt_002)\n- 18:00-19:00 Gym (google, id: evt_003)\nTask lists: Tasks (id: list_001), Shopping (id: list_002)`,
        description: 'Reschedule a calendar event — should use update_calendar_event with correct event_id and new dates',
      },
      {
        id: 'sec_create_task',
        userMessage: 'Add a task to buy groceries due this Saturday, high priority',
        stateContext: `Today: 2026-03-25 (Wednesday). Timezone: Europe/Lisbon.\nTask lists: Tasks (id: list_001), Shopping (id: list_002), Work (id: list_003)`,
        description: 'Create a task — should pick appropriate list and set due date + importance',
      },
      {
        id: 'sec_multi_action',
        userMessage: 'What do I have tomorrow and what tasks are due this week?',
        stateContext: `Today: 2026-03-25 (Wednesday). Timezone: Europe/Lisbon.\nTask lists: Tasks (id: list_001), Shopping (id: list_002)`,
        description: 'Multi-action query — should issue get_calendar_events AND ms_todo_get_due_tasks in parallel',
      },
      {
        id: 'sec_email_triage',
        userMessage: 'Check my unread emails and summarize the important ones',
        stateContext: `Today: 2026-03-25 (Wednesday). Timezone: Europe/Lisbon.\nEmail: Outlook configured, 12 unread.`,
        description: 'Email triage — should call get_outlook_unread and prioritize',
      },
    ],
  },

  // ── 2. Content Creator ─────────────────────────────────────────────
  {
    id: 'content',
    promptFile: 'content',
    description: 'Content creation partner — YouTube/Instagram, PT-BR',
    model: 'claude-haiku-4-5-20251001',
    scorerModel: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
    criteria: [
      { id: 'pt_br', question: 'Is the entire response written in PT-BR (Brazilian Portuguese), not European Portuguese or English?', weight: 2 },
      { id: 'hook_first', question: 'Does the content start with a strong hook in the first line (attention-grabbing opening for the first 3 seconds)?', weight: 1.5 },
      { id: 'worldview', question: 'Does the content reflect the creator\'s worldview (conservative, libertarian, faith-based, anti-state) without contradicting it?', weight: 2 },
      { id: 'html_only', question: 'Is the response free of markdown syntax (* ** ``` #) and uses only HTML tags for formatting?', weight: 1 },
    ],
    testInputs: [
      {
        id: 'cnt_reel_idea',
        userMessage: 'Cria um roteiro de Reel sobre disciplina nos treinos',
        description: 'Reel script about training discipline — should be PT-BR with strong hook',
      },
      {
        id: 'cnt_yt_outline',
        userMessage: 'Outline para vídeo YouTube sobre liberdade econômica vs estado regulador',
        description: 'YouTube outline about economic freedom — should reflect libertarian worldview',
      },
      {
        id: 'cnt_carousel',
        userMessage: 'Cria um carrossel de 5 slides sobre por que a maioria desiste dos objetivos',
        description: 'Instagram carousel about quitting goals — should be motivational and PT-BR',
      },
      {
        id: 'cnt_stories',
        userMessage: 'Sequência de stories sobre a minha rotina matinal de 5am',
        description: 'Stories sequence about morning routine — should be authentic and engaging',
      },
    ],
  },

  // ── 3. Triathlon Coach ─────────────────────────────────────────────
  {
    id: 'triathlon',
    promptFile: 'triathlon',
    description: 'Training coach — Garmin data, calendar management',
    model: 'claude-haiku-4-5-20251001',
    scorerModel: 'claude-haiku-4-5-20251001',
    maxTokens: 2048,
    criteria: [
      { id: 'correct_action', question: 'Does the response use the correct tool for the requested action (create/update/delete calendar event)?', weight: 2 },
      { id: 'calendar_source', question: 'When modifying events, does it correctly include the calendar_source parameter (outlook or google)?', weight: 1.5 },
      { id: 'garmin_data', question: 'Does the response reference Garmin activity data from the state context when available and relevant?', weight: 1.5 },
      { id: 'html_only', question: 'Is the response free of markdown syntax (* ** ``` #) and uses only HTML tags?', weight: 1 },
    ],
    testInputs: [
      {
        id: 'tri_reschedule',
        userMessage: 'Move my long run from Saturday to Sunday morning at 7am',
        stateContext: `Today: 2026-03-25 (Wednesday). Timezone: Europe/Lisbon.\nCalendar this week:\n- Sat 08:00-10:00 Long Run 18km (google, id: gevt_010)\n- Sun 10:00-11:00 Church (outlook, id: evt_020)\nGarmin last 7 days: Mon 5km easy (32:10), Wed 8km tempo (38:45), rest days: Tue, Thu`,
        description: 'Reschedule training — should use update_calendar_event with google source and check for conflicts',
      },
      {
        id: 'tri_coach_advice',
        userMessage: 'My legs feel heavy after yesterday. Should I do the interval session today or rest?',
        stateContext: `Today: 2026-03-25 (Wednesday). Timezone: Europe/Lisbon.\nGarmin yesterday: 12km hilly run, avg HR 162, max HR 178, training load: high.\nGarmin today planned: Interval 6x800m (google, id: gevt_011)\nWeekly load: 38km so far (target 50km).\nSleep: 6h12m, HRV: 42 (below avg 55).`,
        description: 'Coach advice based on Garmin data — should reference HRV, training load, and sleep data',
      },
    ],
  },

  // ── 4. Classifier ──────────────────────────────────────────────────
  {
    id: 'classifier',
    promptFile: 'classifier',
    description: 'Message domain classifier — routes to secretary/triathlon/content',
    model: 'claude-haiku-4-5-20251001',
    scorerModel: 'claude-haiku-4-5-20251001',
    maxTokens: 100,
    criteria: [
      { id: 'correct_domain', question: 'Does the JSON response contain the correct "domain" field matching the expected routing?', weight: 3 },
      { id: 'valid_json', question: 'Is the response valid JSON with exactly the fields "domain" and "confidence" (no extra text, no markdown fences)?', weight: 2 },
      { id: 'pt_br_equivalence', question: 'Would the same message in Portuguese produce the same domain classification?', weight: 1 },
    ],
    testInputs: [
      { id: 'cls_meeting', userMessage: 'Move my 3pm meeting to Friday', description: 'Should route to secretary' },
      { id: 'cls_training', userMessage: 'How was my run yesterday according to Garmin?', description: 'Should route to triathlon' },
      { id: 'cls_content', userMessage: 'Cria um roteiro de Reel sobre disciplina', description: 'Should route to content' },
      { id: 'cls_task', userMessage: 'Add buy milk to my shopping list', description: 'Should route to secretary' },
      { id: 'cls_coach', userMessage: 'My legs are sore, should I skip intervals today?', description: 'Should route to triathlon' },
      { id: 'cls_video', userMessage: 'Dá ideias de thumbnail para o vídeo sobre impostos', description: 'Should route to content' },
      { id: 'cls_email', userMessage: 'Check my unread emails', description: 'Should route to secretary' },
      { id: 'cls_ptbr', userMessage: 'O que tenho amanhã no calendário?', description: 'PT-BR query — should route to secretary' },
    ],
  },

  // ── 5. Topic Generation ────────────────────────────────────────────
  {
    id: 'topic_gen',
    promptFile: 'topic-generation',
    description: 'Content topic generator — produces structured topic candidates',
    model: 'claude-haiku-4-5-20251001',
    scorerModel: 'claude-haiku-4-5-20251001',
    maxTokens: 2048,
    criteria: [
      { id: 'complete_fields', question: 'Does each topic have ALL required fields: title, angle, format, hookIdea, whyNow, pillar?', weight: 2 },
      { id: 'angle_diversity', question: 'Are the topics diverse in angle and content pillar (not all the same theme)?', weight: 1.5 },
      { id: 'timely_whynow', question: 'Is the whyNow field specific and timely (references current events, trends, or seasons) rather than generic?', weight: 1.5 },
      { id: 'specific_hook', question: 'Is the hookIdea specific and actionable (a concrete opening line or visual), not vague?', weight: 1 },
    ],
    testInputs: [
      {
        id: 'tg_reels',
        userMessage: 'Generate 5 reel topic candidates for this week',
        description: 'Reel topics — should produce 5 diverse, complete topic objects',
      },
      {
        id: 'tg_youtube',
        userMessage: 'Generate 3 YouTube video topic candidates about economics and freedom',
        description: 'YouTube topics about economics — should reflect libertarian worldview',
      },
      {
        id: 'tg_trending',
        userMessage: 'Generate topics reacting to trending news this week',
        description: 'Trending reaction topics — whyNow should reference actual current events',
      },
    ],
  },

  // ── 6. Channel Learner ─────────────────────────────────────────────
  {
    id: 'channel_learner',
    promptFile: 'channel-learner',
    description: 'YouTube channel pattern analyzer — extracts content patterns',
    model: 'claude-haiku-4-5-20251001',
    scorerModel: 'claude-haiku-4-5-20251001',
    maxTokens: 4096,
    criteria: [
      { id: 'all_categories', question: 'Does the analysis cover all 9 pattern categories: hook_style, title_pattern, content_structure, editing_style, storytelling, cta_pattern, audience_engagement, visual_branding, monetization?', weight: 2 },
      { id: 'specific_patterns', question: 'Are the extracted patterns specific and actionable (with examples from the videos), not generic advice?', weight: 2 },
      { id: 'valid_json', question: 'Is the output valid JSON that can be parsed without errors?', weight: 1.5 },
    ],
    testInputs: [
      {
        id: 'cl_analyze',
        userMessage: `Analyze these videos:\n1. "COMO EU MUDEI MINHA VIDA EM 6 MESES" - 245K views, 12K likes, 890 comments, 15:32\n2. "5 MENTIRAS que te contaram sobre DINHEIRO" - 180K views, 9K likes, 650 comments, 12:45\n3. "Reagi ao PIOR conselho financeiro da internet" - 320K views, 18K likes, 1.2K comments, 18:20\n4. "Minha rotina das 5AM (a verdade)" - 150K views, 8K likes, 420 comments, 10:15\n5. "Por que saí do Brasil e NÃO voltaria" - 500K views, 25K likes, 3K comments, 22:10`,
        description: 'Channel analysis — should extract specific patterns across all 9 categories',
      },
    ],
  },
];

// ─── Exports ─────────────────────────────────────────────────────────

const targetMap = new Map(targets.map(t => [t.id, t]));

export function getEvalTarget(id: string): EvalTarget | undefined {
  return targetMap.get(id);
}

export function getAllTargets(): EvalTarget[] {
  return [...targets];
}
