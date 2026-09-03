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
    description: 'Content creation partner — profile-bound identity, language, and channel guidance',
    model: 'claude-haiku-4-5-20251001',
    scorerModel: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
    criteria: [
      { id: 'profile_language', question: 'Does every user-facing field follow the authenticated creator language in Current State, without substituting another locale or language variant?', weight: 2 },
      { id: 'hook_first', question: 'Does the content start with a topic-specific opening suited to the requested format and saved voice, without forcing controversy or clickbait?', weight: 1.5 },
      { id: 'identity_fidelity', question: 'Does the response stay within the supplied creator pillars, audience, voice rules, and factual context without inventing a worldview, biography, personal experience, or founder persona?', weight: 2 },
      { id: 'html_only', question: 'Is the response free of markdown syntax (* ** ``` #) and uses only HTML tags for formatting?', weight: 1 },
    ],
    testInputs: [
      {
        id: 'cnt_reel_idea',
        userMessage: 'Create a Reel script about growing herbs on a small balcony.',
        stateContext: 'Authenticated creator profile: language=en-US; pillars=[urban gardening]; audience=apartment beginners; voice_rules=[warm, practical, evidence-aware]; no personal biography or worldview is provided.',
        description: 'English gardening Reel — should honor the supplied profile without invented experience',
      },
      {
        id: 'cnt_yt_outline',
        userMessage: 'Cria um outline para um vídeo de YouTube sobre como fotografar melhor com luz natural.',
        stateContext: 'Authenticated creator profile: language=pt-PT; pillars=[fotografia]; audience=fotógrafos iniciantes; voice_rules=[claro, calmo, sem exageros]; no personal biography or worldview is provided.',
        description: 'European Portuguese photography outline — should preserve locale and saved voice',
      },
      {
        id: 'cnt_carousel',
        userMessage: 'Crie um carrossel de 5 slides sobre cuidados básicos com cerâmica artesanal.',
        stateContext: 'Authenticated creator profile: language=pt-BR; pillars=[cerâmica artesanal]; audience=pessoas começando no hobby; voice_rules=[acolhedor, específico, sem sensacionalismo]; no personal biography or worldview is provided.',
        description: 'Brazilian Portuguese craft carousel — should stay specific and profile-bound',
      },
      {
        id: 'cnt_stories',
        userMessage: 'Create a sequence of stories explaining one useful weekly planning ritual.',
        stateContext: 'Authenticated creator profile: language=en-US; pillars=[team productivity]; audience=small creative teams; voice_rules=[concise, candid, non-prescriptive]; no personal routine or biography is provided.',
        description: 'Productivity stories — should avoid fabricating a first-person routine',
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
      { id: 'complete_fields', question: 'Does each topic match the live topic-generation contract with non-empty title, niche, whyNow, hookIdea, angle_tag, and time_sensitivity, plus pillar_emoji set to an empty string until an explicit typed emoji mapping exists?', weight: 2 },
      { id: 'authorized_identity', question: 'Does every niche exactly match an allowed pillar or niche in Current State, with no invented creator interests, worldview, demographic, or personal history?', weight: 2 },
      { id: 'angle_diversity', question: 'Are the topics diverse in angle and content pillar (not all the same theme)?', weight: 1.5 },
      { id: 'timely_whynow', question: 'Is the whyNow field specific and timely (references current events, trends, or seasons) rather than generic?', weight: 1.5 },
      { id: 'specific_hook', question: 'Is the hookIdea specific and actionable (a concrete opening line or visual), not vague?', weight: 1 },
    ],
    testInputs: [
      {
        id: 'tg_reels',
        userMessage: 'Generate 5 Reel topic candidates for this week.',
        stateContext: 'Authenticated creator profile: language=en-US; allowedPillarsOrNiches=[urban gardening, home composting]; audience=apartment beginners; no worldview or biography is provided.',
        description: 'Gardening Reels — should produce 5 complete candidates using only authorized categories',
      },
      {
        id: 'tg_youtube',
        userMessage: 'Generate 3 YouTube video topic candidates for the saved creator profile.',
        stateContext: 'Authenticated creator profile: language=en-US; allowedPillarsOrNiches=[product education, customer research]; audience=early-stage product teams; no worldview or biography is provided.',
        description: 'Product education topics — should use only the supplied profile',
      },
      {
        id: 'tg_trending',
        userMessage: 'Generate topics reacting to relevant news this week.',
        stateContext: 'Authenticated creator profile: language=en-US; allowedPillarsOrNiches=[independent cinema]; audience=film students; voice_rules=[curious, evidence-aware, non-inflammatory]; no worldview or biography is provided.',
        description: 'Film reaction topics — whyNow should be current without forced controversy',
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
      { id: 'all_categories', question: 'Does the analysis cover all 9 live pattern categories: hook_style, title_pattern, content_structure, editing_style, storytelling, cta_pattern, audience_engagement, visual_style, and brand_voice?', weight: 2 },
      { id: 'specific_patterns', question: 'Are the extracted patterns specific and actionable (with examples from the videos), not generic advice?', weight: 2 },
      { id: 'valid_json', question: 'Is the output valid JSON that can be parsed without errors?', weight: 1.5 },
    ],
    testInputs: [
      {
        id: 'cl_analyze',
        userMessage: `Analyze these videos:\n1. "Build a Window Herb Garden in One Afternoon" - 245K views, 12K likes, 890 comments, 15:32\n2. "Five Composting Mistakes in Small Apartments" - 180K views, 9K likes, 650 comments, 12:45\n3. "Testing Three Low-Cost Grow Lights" - 320K views, 18K likes, 1.2K comments, 18:20\n4. "A Month of Balcony Tomatoes: What Worked" - 150K views, 8K likes, 420 comments, 10:15\n5. "The Soil Mix Experiment: Results After 90 Days" - 500K views, 25K likes, 3K comments, 22:10`,
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
        question: 'Does the opening use a topic-specific, creator-authorized attention device that fits the saved voice, without requiring a bold claim, controversy, or fabricated experience?',
        weight: 2.5,
      },
      {
        id: 'title_usefulness',
        question: 'Are the title options (3-5) SEO-friendly, curiosity-driven, and specific to the topic? Do they avoid clickbait that doesn\'t deliver?',
        weight: 1.5,
      },
      {
        id: 'source_grounding',
        question: 'Are factual claims bound to exact supplied source identifiers or marked unverified, with facts separated from creator-authorized interpretation and no invented citations?',
        weight: 2,
      },
      {
        id: 'format_compliance',
        question: 'Does the script follow the requested format and use production markers only where the saved format and voice call for them, without forcing SFX, editing gimmicks, or a CTA?',
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
        userMessage: 'Write a script explaining how to build a reliable indoor seed-starting setup.',
        stateContext: 'Authenticated creator profile: language=en-US; pillars=[urban gardening]; audience=apartment beginners; voice_rules=[practical, evidence-aware, no hype]; personal experience is not provided.',
        description: 'Practical explainer — should be useful without inventing first-person experience',
      },
      {
        id: 'sq_reaction',
        userMessage: 'Write a reaction script to a viral clip claiming houseplants remove every indoor pollutant.',
        stateContext: 'Authenticated creator profile: language=en-US; pillars=[indoor plants]; audience=curious renters; voice_rules=[measured, source-led, friendly]; supplied stance=correct unsupported claims without attacking the speaker.',
        description: 'Evidence-led reaction — should honor the supplied stance without forced provocation',
      },
      {
        id: 'sq_reel_training',
        userMessage: 'Write a 30-second Reel script about choosing paper for watercolor layering.',
        stateContext: 'Authenticated creator profile: language=en-US; pillars=[watercolor]; audience=beginner artists; voice_rules=[gentle, visual, specific]; personal experience is not provided.',
        description: 'Short-form art script — should fit 30 seconds without fabricated biography',
      },
      {
        id: 'sq_economics',
        userMessage: 'Write a YouTube script explaining why grocery supply chains create seasonal price changes.',
        stateContext: 'Authenticated creator profile: language=en-US; pillars=[consumer education]; audience=general adults; voice_rules=[neutral, source-led, plain language]; no political or economic worldview is provided.',
        description: 'Consumer explainer — must separate sourced facts from interpretation',
      },
      {
        id: 'sq_evergreen',
        userMessage: 'Write a script about five ways small teams can document recurring decisions.',
        stateContext: 'Authenticated creator profile: language=en-US; pillars=[team operations]; audience=small creative teams; voice_rules=[concise, candid, non-prescriptive]; personal biography is not provided.',
        description: 'Evergreen team-operations list — should match saved voice without personal claims',
      },
    ],
  },

  // ── 8. Hook Quality ─────────────────────────────────────────────
  //
  // Focused evaluation of hook generation quality. Tests whether
  // generated openings are specific, supportable, and worth testing across
  // different content pillars without assuming a universal timing window.
  {
    id: 'hook_quality',
    promptFile: 'content',
    description: 'Opening-variant quality — specificity, evidence fit, and a reviewable attention hypothesis',
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
        question: 'Is this a topic-specific opening hypothesis worth testing, while avoiding unsupported urgency, controversy, clickbait, or guaranteed attention claims?',
        weight: 3,
      },
      {
        id: 'profile_language',
        question: 'Does the hook use the exact language and locale supplied in Current State, with natural phrasing for that locale?',
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
        userMessage: 'Generate 5 hooks for a video about restoring a wooden chair.',
        stateContext: 'Authenticated creator profile: language=en-US; pillars=[furniture restoration]; voice_rules=[patient, concrete, no hype]; personal experience is not provided.',
        description: 'Restoration hooks — should be concrete and profile-bound',
      },
      {
        id: 'hq_science',
        userMessage: 'Generate 5 hooks for a video comparing two common home air-quality sensors.',
        stateContext: 'Authenticated creator profile: language=en-US; pillars=[home science]; voice_rules=[measured, evidence-aware, avoid absolute claims]; no worldview is provided.',
        description: 'Science hooks — should create curiosity without overstating evidence',
      },
      {
        id: 'hq_craft',
        userMessage: 'Gera 5 ganchos para um Reel sobre como evitar bolhas no esmalte de cerâmica.',
        stateContext: 'Authenticated creator profile: language=pt-PT; pillars=[cerâmica]; voice_rules=[claro, acolhedor, específico]; personal experience is not provided.',
        description: 'European Portuguese craft hooks — should preserve locale and avoid generic hype',
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
