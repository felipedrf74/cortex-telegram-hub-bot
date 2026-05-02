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

  // ── 7. Script Quality ────────────────────────────────────────────
  //
  // Evaluates generated scripts across 7 dimensions: voice fit,
  // hook strength, title usefulness, source grounding, format
  // compliance, signal usefulness, and overall quality.
  //
  // This target tests the canonical script pipeline (getScript via
  // the content-engine Python backend) and evaluates the structured
  // output, not presentation formatting.
  {
    id: 'script_quality',
    promptFile: 'content',
    description: 'Script generation quality — voice, hooks, titles, sources, format compliance',
    model: 'claude-haiku-4-5-20251001',
    scorerModel: 'claude-haiku-4-5-20251001',
    maxTokens: 4096,
    criteria: [
      {
        id: 'voice_fit',
        question: 'Does the script sound like the authenticated creator\'s actual saved Voice DNA (conversational, in their stored brand voice — not robotic, not formal, not generic motivational)? Does it use the user\'s saved language register naturally?',
        weight: 3,
      },
      {
        id: 'hook_strength',
        question: 'Does the opening hook (first 3 seconds) use a pattern interrupt, bold claim, or curiosity gap that would stop someone scrolling? Is it specific (not generic like "Hoje vamos falar sobre...")?',
        weight: 2.5,
      },
      {
        id: 'title_usefulness',
        question: 'Are the title options (3-5) SEO-friendly, curiosity-driven, and specific to the topic? Do they avoid clickbait that doesn\'t deliver?',
        weight: 1.5,
      },
      {
        id: 'source_grounding',
        question: 'Are factual claims tagged with [VERIFIED: source] or [NEEDS VERIFICATION]? Is there a FONTES VERIFICADAS section? Are FACTS separated from TAKES?',
        weight: 2,
      },
      {
        id: 'format_compliance',
        question: 'Does the script include [SFX:name], [EDIT:technique], [SHOW ON SCREEN: ...], and [PAUSE] markers at appropriate density? Does it follow HOOK / BODY / CTA structure?',
        weight: 2,
      },
      {
        id: 'signal_usefulness',
        question: 'If intelligence bus signals were injected (voice patterns, hook effectiveness, pillar performance), does the script reflect them? If no signals, is the content still strong standalone?',
        weight: 1,
      },
      {
        id: 'overall_quality',
        question: 'Would this script produce a video that the authenticated creator\'s saved target audience (per stored creator profile) would watch to completion and share? Is it engaging, not just informative?',
        weight: 2.5,
      },
    ],
    testInputs: [
      {
        id: 'sq_tech_build',
        userMessage: 'Write a script about building an AI bot that manages your entire life',
        description: 'Tech/build script — should be hands-on, authentic, show real code/demo moments',
      },
      {
        id: 'sq_reaction',
        userMessage: 'Write a reaction script to a viral clip of a politician saying taxes are good',
        description: 'Reaction script — should reflect libertarian worldview, have bold take, use SFX markers',
      },
      {
        id: 'sq_reel_training',
        userMessage: 'Write a 30-second Reel script about waking up at 5am to train',
        description: 'Short-form training script — should be punchy, personal, high energy in 30s',
      },
      {
        id: 'sq_economics',
        userMessage: 'Write a YouTube script about why inflation is theft, using Austrian Economics framework',
        description: 'Economics script — MUST separate facts from takes, cite sources, reflect worldview',
      },
      {
        id: 'sq_evergreen',
        userMessage: 'Write a script about 5 habits that changed my life as an entrepreneur',
        description: 'Evergreen listicle — should feel personal (not generic), match the authenticated creator\'s saved brand voice',
      },
    ],
  },

  // ── 8. Hook Quality ─────────────────────────────────────────────
  //
  // Focused evaluation of hook generation quality. Tests whether
  // generated hooks are strong enough to stop scrolling in the
  // first 3 seconds across different content pillars.
  {
    id: 'hook_quality',
    promptFile: 'content',
    description: 'Hook generation quality — specificity, pattern interrupts, scroll-stopping power',
    model: 'claude-haiku-4-5-20251001',
    scorerModel: 'claude-haiku-4-5-20251001',
    maxTokens: 512,
    criteria: [
      {
        id: 'specificity',
        question: 'Is the hook specific to this topic (not a generic template like "Você não vai acreditar..." that could apply to anything)?',
        weight: 3,
      },
      {
        id: 'scroll_stop',
        question: 'Would this hook make someone stop scrolling on Instagram/YouTube in the first 3 seconds? Does it create urgency, curiosity, or controversy?',
        weight: 3,
      },
      {
        id: 'pt_br_natural',
        question: 'Does the hook sound like natural PT-BR speech (not translated English, not formal Portuguese)?',
        weight: 2,
      },
      {
        id: 'brand_voice',
        question: 'Does the hook sound like the authenticated creator\'s saved brand voice — matching the tone and stylistic constraints in their creator profile — not like a generic content creator?',
        weight: 2,
      },
    ],
    testInputs: [
      {
        id: 'hq_tech',
        userMessage: 'Generate 5 hooks for a video about building an AI personal assistant',
        description: 'Tech hooks — should reference building/coding, not just hype',
      },
      {
        id: 'hq_politics',
        userMessage: 'Generate 5 hooks for a video about why minimum wage hurts the poor',
        description: 'Politics hooks — should be bold, libertarian framing, not neutral',
      },
      {
        id: 'hq_training',
        userMessage: 'Generate 5 hooks for a Reel about training at 5am in winter',
        description: 'Training hooks — should be personal, visceral, not motivational-poster energy',
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

/** Get all target IDs for the autoresearch rotation. */
export function getTargetIds(): string[] {
  return targets.map(t => t.id);
}
