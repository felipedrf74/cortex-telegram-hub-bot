// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Declarative skill/sub-skill configuration.
 *
 * Each domain maps to a top-level skill. Each skill contains sub-skills
 * that group related tools. Sub-skills can be independently toggled,
 * controlling which tools are available to a domain at runtime.
 *
 * This is the single source of truth for the domain→sub-skill→tool mapping.
 */

import type { DomainName, DefaultDomainName } from '../domains/types';
import { CAPABILITY_SKILL_METADATA } from '../generated/capability-skill-metadata';

// ── Types ────────────────────────────────────────────────────────

/** Minimum user tier required to access a skill or sub-skill. */
export type SkillTier = 'free' | 'pro' | 'max' | 'owner';

/** Ordinal rank: higher = more privileged. Used for tier gate comparison. */
export const TIER_RANK: Record<SkillTier, number> = { free: 0, pro: 1, max: 2, owner: 3 };

/** Coaching personas — each sport gets its own prompt file. */
export type CoachPersona =
  | 'strength'      // triathlon.gym
  | 'endurance_run' // triathlon.running
  | 'cycling'       // triathlon.cycle
  | 'swim';         // triathlon.swim

export interface SubSkillDefinition {
  name: string;
  description: string;
  tools: string[];                  // tool names from TOOLS array in anthropic.ts
  enabledByDefault: boolean;
  cronJobs?: string[];              // cron job IDs owned by this sub-skill
  dependencies?: string[];          // names of other sub-skills this depends on
  requiredTier?: SkillTier;         // minimum user tier to access (default: inherits from parent skill)
  promptFile?: string;              // relative path under prompts/ for per-sub-skill coach persona
  coachPersona?: CoachPersona;      // which coaching persona this sub-skill represents
}

export interface ClassificationHint {
  label: string;                    // short label e.g. "secretary"
  description: string;              // what this domain handles
  examples: string[];               // example messages for the classifier
}

export interface SkillRouteConfig {
  patternRoutes: RegExp[];          // command patterns e.g. /^\/(todo|agenda)\b/i
  keywordRoute: RegExp | null;      // NL keyword pattern (single combined regex per skill)
  classificationHint: ClassificationHint;
}

export interface SkillDefinition {
  name: string;                     // matches DomainName
  description: string;
  version: string;
  subSkills: SubSkillDefinition[];
  routing: SkillRouteConfig;        // route configuration for message classification
  requiredTier?: SkillTier;         // minimum user tier to access this parent skill (default: 'pro')
}

// ── Default Skill Definitions ────────────────────────────────────

const SECRETARY_SKILL: SkillDefinition = {
  ...CAPABILITY_SKILL_METADATA.secretary,
  description: 'Personal assistant — tasks, calendar, email, reminders, notes, briefings',
  routing: {
    patternRoutes: [
      /^\/(sec|agenda|schedule|todo|todos|done|undone|remind|email|week|day|plan|review|move|cancel)\b/i,
      /^\/(lists|tasks|newtask|newlist|deletelist|deletetask|due|priority|search|todosummary|digest|digesttime)\b/i,
      /^\/(overdue|duetoday|dueweek|movetask|alltasks|completed|edittask|notetask|addstep|steps)\b/i,
    ],
    keywordRoute: /\b(tasks?|to-?dos?|remind(?:ers?)?|(?:my\s+)?calendar|schedule|meetings?|appointments?|(?:my\s+)?emails?|inbox|overdue|due\s+(?:today|tomorrow|this\s+week)|planning|digest|unread|mark\s+(?:as\s+)?(?:done|complete)|pending|priority|deadline|tarefas?|lembretes?|agend(?:a|ar)|reuni[oõ]es?|compromissos?|e-?mails?|caixa\s+de\s+entrada|atrasad[ao]s?|pra\s+hoje|pendentes?|prioridade|prazo)\b/i,
    classificationHint: {
      label: 'secretary',
      description: 'scheduling, calendar, appointments, to-do lists, reminders, email, time management, weekly planning, daily overview, operational follow-through for finance/content asks, invoices, general life coordination',
      examples: ['what meetings do I have?', 'remind me to pay my tax estimate tomorrow', 'schedule a filming block for Thursday'],
    },
  },
  subSkills: [
    {
      name: 'tasks',
      description: 'Microsoft To Do task management',
      enabledByDefault: true,
      tools: [
        'ms_todo_get_tasks', 'ms_todo_create_task', 'ms_todo_update_task',
        'ms_todo_complete_task', 'ms_todo_uncomplete_task', 'ms_todo_delete_task',
        'ms_todo_search_tasks', 'ms_todo_get_due_tasks', 'ms_todo_move_task',
        'ms_todo_get_checklist', 'ms_todo_add_checklist_item',
        'ms_todo_get_lists', 'ms_todo_create_list', 'ms_todo_delete_list',
      ],
      cronJobs: ['shared_list'],
    },
    {
      name: 'calendar',
      description: 'Calendar event management (Google + Outlook)',
      enabledByDefault: true,
      tools: [
        'get_calendar_events', 'create_calendar_event',
        'update_calendar_event', 'delete_calendar_event',
      ],
      cronJobs: [
        'conflict_detection',
        'secretary_agenda_sync',
        'travel_window_notify',
        'commitment_start_reminder',
      ],
    },
    {
      name: 'email',
      description: 'Outlook email read/send/reply',
      enabledByDefault: true,
      tools: [
        'search_outlook_emails', 'read_outlook_email',
        'send_outlook_email', 'reply_outlook_email', 'get_outlook_unread',
      ],
      cronJobs: [],
    },
    {
      name: 'reminders',
      description: 'Time-based reminders',
      enabledByDefault: true,
      tools: ['set_reminder'],
      cronJobs: ['reminders'],
    },
    {
      name: 'notes',
      description: 'Note saving and search',
      enabledByDefault: true,
      tools: ['save_note', 'search_notes'],
    },
    {
      name: 'shared-memory',
      description: 'Cross-domain shared facts',
      enabledByDefault: true,
      tools: ['shared_memory_set', 'shared_memory_remove'],
    },
    {
      name: 'briefings',
      description: 'Morning briefing, weekly review, and daily digest',
      enabledByDefault: true,
      tools: [],
      cronJobs: ['daily_briefing', 'weekly_review', 'end_of_day'],
    },
  ],
};

/**
 * Build the reviewed Training-plan capability contract on demand.
 *
 * Keeping this small definition behind a builder lets policy tests exercise
 * the exact runtime action set after mutation activation; a top-level object
 * literal is initialized before Vitest can attribute static mutants.
 */
export function buildTrainingPlansSubSkillDefinition(): SubSkillDefinition {
  return {
    name: 'training-plans',
    description: 'Reviewed Training plan handoff, readback, completion, and calendar linkage used by all sport sub-skills',
    enabledByDefault: true,
    requiredTier: 'pro',
    tools: [
      'create_training_plan', 'get_training_plan', 'log_training_completion',
    ],
    cronJobs: ['training_plan_adjust'],
  };
}

const TRIATHLON_SKILL: SkillDefinition = {
  ...CAPABILITY_SKILL_METADATA.triathlon,
  description: 'Multisport coaching — gym, running, cycling, swimming, nutrition, recovery',
  routing: {
    patternRoutes: [
      /^\/(train|gym|run|bike|cycle|cycling|swim|checkin|meal|macros|deload|pain|running|recovery)\b/i,
    ],
    keywordRoute: /\b(workout|gym(?:\s+session)?|running\s+plan|cycling\s+plan|swim(?:ming)?\s+(?:plan|set)?|pool|open\s+water|sets?\s*[x×]\s*\d|training(?:\s+plan)?|deload|squat|deadlift|bench\s+press|heart\s+rate|RPE|RIR|tempo\s+run|intervals?|FTP|soreness|recovery\s+day|muscle|hypertrophy|endurance|coach\s*(?:report|briefing|rec)|lower\s+body|upper\s+body|freestyle|backstroke|breaststroke|butterfly|CSS|pace\s+per\s+100m?|treino|corrida|pedal(?:ada)?|nat[aã]o|piscina|muscula[çc][aã]o|agachamento|supino|levantamento\s+terra|frequ[eê]ncia\s+card[ií]aca|dor\s+muscular|recupera[çc][aã]o|s[eé]ries?\s*[x×]\s*\d|academia)\b/i,
    classificationHint: {
      label: 'triathlon',
      description: 'gym workouts, running, cycling, swimming, training plans, recovery, fatigue, performance, body composition, macro targets, supplements, electrolytes, coaching decisions',
      examples: [
        'plan my workout',
        'set my protein target for this block',
        'running intervals tomorrow',
        'swim set for today',
        'FTP test this week',
      ],
    },
  },
  subSkills: [
    // ── Sport sub-skills — coaching PERSONAS, not tool bundles ──
    //
    // Each sport sub-skill is a thin persona shell: it owns the prompt
    // file (gym.md / running.md / ...) and declares which capability
    // sub-skills it needs via `dependencies`. Enabling a sport sub-skill
    // cascades to enabling the shared `training-plans` + `calendar` +
    // `shared-memory` capability modules, which actually expose the tools.
    // This prevents the same tool from appearing in multiple sub-skills'
    // `tools` arrays — there is exactly one owner for each tool.
    {
      name: 'gym',
      description: 'Strength coach — powerlifting, hypertrophy, general fitness. Specialized persona for lifting-focused users.',
      enabledByDefault: true,
      requiredTier: 'pro',
      coachPersona: 'strength',
      promptFile: 'triathlon/gym.md',
      tools: [],
      dependencies: ['training-plans', 'calendar', 'shared-memory'],
    },
    {
      name: 'running',
      description: 'Endurance running coach — 5k/10k/half/marathon periodization, pace work, injury-aware progression.',
      enabledByDefault: true,
      requiredTier: 'pro',
      coachPersona: 'endurance_run',
      promptFile: 'triathlon/running.md',
      tools: [],
      dependencies: ['training-plans', 'calendar', 'shared-memory'],
    },
    {
      name: 'cycle',
      description: 'Cycling coach — FTP-based zone training, road/gravel/trainer workouts, event preparation.',
      enabledByDefault: true,
      requiredTier: 'pro',
      coachPersona: 'cycling',
      promptFile: 'triathlon/cycling.md',
      tools: [],
      dependencies: ['training-plans', 'calendar', 'shared-memory'],
    },
    {
      name: 'swim',
      description: 'Swim coach — stroke technique, CSS/threshold pace work, pool and open water.',
      enabledByDefault: true,
      requiredTier: 'pro',
      coachPersona: 'swim',
      promptFile: 'triathlon/swim.md',
      tools: [],
      dependencies: ['training-plans', 'calendar', 'shared-memory'],
    },

    // ── Shared capability sub-skills — cross-sport plumbing ──
    buildTrainingPlansSubSkillDefinition(),
    {
      name: 'calendar',
      description: 'Calendar event management for training schedule',
      enabledByDefault: true,
      requiredTier: 'pro',
      tools: [
        'get_calendar_events', 'create_calendar_event',
        'update_calendar_event', 'delete_calendar_event',
      ],
    },
    {
      name: 'reminders',
      description: 'Training reminders',
      enabledByDefault: true,
      requiredTier: 'pro',
      tools: ['set_reminder'],
    },
    {
      name: 'notes',
      description: 'Training notes and search',
      enabledByDefault: true,
      requiredTier: 'pro',
      tools: ['save_note', 'search_notes'],
    },
    {
      name: 'shared-memory',
      description: 'Cross-domain shared facts (race dates, training state) plus chat-triggered athlete profile onboarding',
      enabledByDefault: true,
      requiredTier: 'pro',
      // Phase 3 Slice A: save_athlete_profile_field lives here because
      // every sport persona needs to persist profile answers during
      // chat-triggered onboarding, and they already depend on
      // shared-memory. Piggybacking on this module means no extra
      // dependency edges in the sport sub-skills.
      tools: ['shared_memory_set', 'shared_memory_remove', 'save_athlete_profile_field'],
    },
    {
      name: 'recovery',
      description: 'Shared recovery protocols, deload logic, soreness tracking',
      enabledByDefault: true,
      requiredTier: 'pro',
      tools: [],
      dependencies: ['shared-memory'],
    },
  ],
};

const CONTENT_SKILL: SkillDefinition = {
  ...CAPABILITY_SKILL_METADATA.content,
  description: 'Content workspace with user-controlled ideas, briefs, outlines, scripts, revisions, sources, specialist proposals, and schedules',
  routing: {
    patternRoutes: [
      /^\/(content|video|reel|script|caption|thumbnail|trend|ideas|discover|deepsearch|sources|hotnews)\b/i,
      /^\/(trending|reaction|hooks|genscript|titles|genthumbnail|gencaption)\b/i,
      /^\/(competitor|gaps|seo|repurpose|feedback|report)\b/i,
    ],
    keywordRoute: /\b(youtube|instagram|reels?|thumbnail|video\s+(?:idea|script)|content\s+(?:strategy|calendar|idea)|caption|hashtag|subscribers?|audience|viral|hook|CTA|engagement|v[ií]deo|roteiro|legenda|inscritos|miniatura|conte[uú]do|id[eé]ia\s+de\s+(?:v[ií]deo|conte[uú]do)|calend[aá]rio\s+(?:de\s+)?conte[uú]do|engajamento)\b/i,
    classificationHint: {
      label: 'content',
      description: 'YouTube, Instagram, video ideas, scripts, thumbnails, captions, Reels, content strategy, audience growth, brand, hashtags, content calendar',
      examples: ['I need a video idea', 'write a script about AI', 'thumbnail concept for my reel'],
    },
  },
  subSkills: [
    {
      name: 'notes',
      description: 'Explicit Content idea capture and private research-note search',
      enabledByDefault: true,
      tools: ['save_note', 'search_notes'],
    },
    {
      name: 'shared-memory',
      description: 'Explicitly approved shared facts such as filming constraints and calendar preferences',
      enabledByDefault: true,
      tools: ['shared_memory_set', 'shared_memory_remove'],
    },
    {
      name: 'research-pipeline',
      description: 'Channel re-learning and reference channel analysis',
      enabledByDefault: true,
      tools: [],
      cronJobs: ['channel_relearn'],
    },
    {
      name: 'script-generator',
      description: 'Canonical brief-to-outline-to-script generation with immutable capture and safe revision',
      enabledByDefault: true,
      tools: [],
    },
    {
      name: 'seo-tracker',
      description: 'Paused until keyword ranks and emitted signals have tenant-user scoped storage',
      enabledByDefault: false,
      tools: [],
      cronJobs: ['seo_agent'],
    },
    {
      name: 'reaction-radar',
      description: 'Paused until reaction discovery, preferences, and emitted opportunities are tenant-user scoped',
      enabledByDefault: false,
      tools: [],
      cronJobs: ['reaction_radar'],
    },
    {
      name: 'voice-evolution',
      description: 'Learns observed voice edits from canonical agent-draft to creator-revision pairs',
      enabledByDefault: true,
      tools: [],
      cronJobs: ['voice_evolution'],
    },
    {
      name: 'performance-intel',
      description: 'Paused until channel-performance signals have tenant-user scoped storage',
      enabledByDefault: false,
      tools: [],
      cronJobs: ['performance_agent'],
    },
    {
      name: 'pipeline-tracker',
      description: 'Monitors canonical Content workspace status and legacy compatibility bottlenecks',
      enabledByDefault: true,
      tools: [],
      cronJobs: ['pipeline_agent'],
    },
    {
      name: 'topic-scheduler',
      description: 'Automated topic generation for Reels and YouTube videos',
      enabledByDefault: true,
      tools: [],
      cronJobs: ['tuesday_reels', 'thursday_youtube', 'friday_weekly'],
    },
    {
      name: 'creator-agency',
      description: 'Structured strategy packages and approval-gated specialist proposals with provenance',
      enabledByDefault: true,
      tools: [],
    },
    {
      name: 'meme-scout',
      description: 'Discovers meme-worthy content for social engagement (experimental)',
      enabledByDefault: false,
      tools: [],
    },
  ],
};

const FINANCE_SKILL: SkillDefinition = {
  ...CAPABILITY_SKILL_METADATA.finance,
  description: 'Personal finance — expense tracking, Portugal IRS / IVA tax estimates',
  routing: {
    patternRoutes: [
      /^\/(finance|budget|expense|tax|darf|receipt|invoice)\b/i,
    ],
    keywordRoute: /\b(despesas?|gastos?|or[çc]amento|imposto|carn[eê]-le[aã]o|DARF|receita\s+federal|nota\s+fiscal|budget|expenses?|tax(?:es)?|income\s+tax|financial|freelancer?\s+tax|dedu[çc][aã]o|faturamento|NF(?:-?e)?)\b/i,
    classificationHint: {
      label: 'finance',
      description: 'expenses, budgets, Portugal income tax, IVA, withholding, freelancer taxes, receipts, financial planning, deductions',
      examples: ['log an expense of €50', 'calculate my tax this month', 'show my budget'],
    },
  },
  subSkills: [
    {
      name: 'expenses',
      description: 'Expense and income tracking',
      enabledByDefault: true,
      tools: ['finance_add_transaction', 'finance_get_transactions', 'finance_delete_transaction', 'finance_monthly_summary'],
    },
    {
      name: 'tax',
      description: 'Portugal IRS / IVA tax estimates and annual summary',
      enabledByDefault: true,
      tools: ['finance_calculate_tax', 'finance_get_tax_events', 'finance_mark_tax_paid', 'finance_annual_summary'],
    },
    {
      name: 'notes',
      description: 'Financial notes and records',
      enabledByDefault: true,
      tools: ['save_note', 'search_notes'],
    },
    {
      name: 'shared-memory',
      description: 'Cross-domain shared facts (income targets, tax deadlines)',
      enabledByDefault: true,
      tools: ['shared_memory_set', 'shared_memory_remove'],
    },
  ],
};

const COOKING_SKILL: SkillDefinition = {
  ...CAPABILITY_SKILL_METADATA.cooking,
  description: 'Tenant-safe recipes, dated meal-plan slots, saved-plan shopping lists, pantry and preference memory, and context-aware cooking guidance',
  routing: {
    patternRoutes: [
      /^\/(cook|recipe|meal|mealplan|shopping|ingredients?)\b/i,
    ],
    keywordRoute: /\b(recipes?|cooking|meal\s+(?:plan|prep|ideas?)|shopping\s+list|ingredients?|cozinhar|receitas?|refei[çc][aã]o|lista\s+de\s+compras|cardápio|preparo|plano\s+alimentar|alimenta[çc][aã]o\s+p[oó]s-?treino)\b/i,
    classificationHint: {
      label: 'cooking',
      description: 'recipes, meal planning, cooking, shopping lists, ingredient search, meal prep, menus, snacks, food execution around training',
      examples: ['find me a recipe with chicken', 'plan my meals for the week', 'what should I eat before a hard workout?'],
    },
  },
  subSkills: [
    {
      name: 'recipes',
      description: 'Structured recipe library: create, search, and delete saved recipes',
      enabledByDefault: true,
      tools: ['cooking_add_recipe', 'cooking_get_recipes', 'cooking_delete_recipe'],
    },
    {
      name: 'meal-planning',
      description: 'Read and edit dated meal-plan slots',
      enabledByDefault: true,
      tools: ['cooking_set_meal', 'cooking_get_meal_plan', 'cooking_delete_meal'],
    },
    {
      name: 'shopping',
      description: 'Generate and read shopping lists from saved meal-plan slots',
      enabledByDefault: true,
      tools: ['cooking_generate_shopping_list', 'cooking_get_shopping_list'],
    },
    {
      name: 'pantry',
      description: 'Tenant-scoped pantry item management with freshness metadata',
      enabledByDefault: true,
      tools: ['cooking_upsert_pantry_item', 'cooking_get_pantry', 'cooking_delete_pantry_item'],
    },
    {
      name: 'preferences',
      description: 'User-private allergies, restrictions, prep, budget, and correction memory',
      enabledByDefault: true,
      tools: ['cooking_set_preference', 'cooking_get_preferences'],
    },
    {
      name: 'notes',
      description: 'Explicit Cooking note capture and private note search',
      enabledByDefault: true,
      tools: ['save_note', 'search_notes'],
    },
    {
      name: 'shared-memory',
      description: 'Explicitly approved shared dietary facts and cooking constraints',
      enabledByDefault: true,
      tools: ['shared_memory_set', 'shared_memory_remove'],
    },
  ],
};

// ── Platform skills (system-level surfaces, promoted from chat-action layer) ─
//
// Promoted 2026-05-15 per the Skill Interaction Catalog audit §4 (orphan-skill
// promotion). These three skills were already first-class in `ChatActionSkill`
// (chat/registry/types.ts) but were not surfaced as user-facing skills in the
// catalog. They have empty `tools: []` arrays because their action surface is
// owned by the chat-action registry (executor strings dispatched server-side),
// not by the legacy Anthropic tool-call surface. Each sub-skill maps to a
// concern area that may eventually expose Anthropic tools as the platform
// matures.

const CONNECTIONS_SKILL: SkillDefinition = {
  ...CAPABILITY_SKILL_METADATA.connections,
  description: 'Provider integrations — Google, Microsoft, Apple, Garmin, Health — OAuth state, sync health, reconnection guidance',
  routing: {
    patternRoutes: [
      /^\/(connections?|integrations?|sync|reconnect|providers?)\b/i,
    ],
    keywordRoute: /\b(connection|conex[aã]o|conex[oõ]es|integration|integra[cç][aã]o|provider|provedor|reconnect|reconectar|sync|sincroniza(?:r|[cç][aã]o)|google|outlook|microsoft|apple|garmin|healthkit|health(?:\s+app)?|sa[uú]de|reauth(?:enticate)?|reautent(?:icar|ica[cç][aã]o)?|token\s+(?:expired|expirou)|disconnect(?:ed)?|desconect(?:ado|ada))\b/i,
    classificationHint: {
      label: 'connections',
      description: 'provider integration health and management: OAuth status, reconnection guidance, sync errors, token expiry, Google/Outlook/Microsoft/Apple/Garmin/Health account state',
      examples: [
        'Is Google Calendar still connected?',
        'My Outlook sync failed, what should I do?',
        'Reconectar a conta da Garmin',
      ],
    },
  },
  subSkills: [
    {
      name: 'oauth-state',
      description: 'OAuth token health and refresh state for connected providers (Google, Microsoft, Apple, Garmin, Health)',
      enabledByDefault: true,
      tools: [],
    },
    {
      name: 'sync-health',
      description: 'Provider sync status — Google Calendar, Outlook Mail, Garmin activities, HealthKit, etc.',
      enabledByDefault: true,
      tools: [],
    },
    {
      name: 'reconnection-guidance',
      description: 'Guided reconnect flow when a provider auth breaks (token revoked, scope changed, password rotated)',
      enabledByDefault: true,
      tools: [],
    },
  ],
};

const NOTIFICATIONS_SKILL: SkillDefinition = {
  ...CAPABILITY_SKILL_METADATA.notifications,
  description: 'Push notifications — APNs token management, delivery, per-channel preferences, notification intents',
  routing: {
    patternRoutes: [
      /^\/(notif(?:ication)?s?|alerts?|push|quiet)\b/i,
    ],
    keywordRoute: /\b(notification|notifica[cç][aã]o|notifica[cç][oõ]es|alerta|alert|push|notify|notificar|silenciar|mute|quiet\s+hours?|do\s+not\s+disturb|n[aã]o\s+perturbar|preferences?|prefer[eê]ncias)\b/i,
    classificationHint: {
      label: 'notifications',
      description: 'push notification management: APNs status, delivery checks, quiet hours, per-channel preferences, notification intents and triggers',
      examples: [
        'Are my notifications working?',
        'Mute training notifications during work hours',
        'Por que recebi essa notificação?',
      ],
    },
  },
  subSkills: [
    {
      name: 'apns-orchestration',
      description: 'APNs token management and safe delivery — device token registration, delivery state, token-expiry handling',
      enabledByDefault: true,
      tools: [],
    },
    {
      name: 'preferences',
      description: 'Per-channel notification preferences — quiet hours, mute lists, frequency caps',
      enabledByDefault: true,
      tools: [],
    },
    {
      name: 'intents',
      description: 'Notification intent system — declarative "when to fire" rules for training reminders, calendar alerts, decision-center prompts, etc.',
      enabledByDefault: true,
      tools: [],
    },
  ],
};

const DECISION_CENTER_SKILL: SkillDefinition = {
  ...CAPABILITY_SKILL_METADATA.decision_center,
  description: 'Decision Center — choices, dismissals, snoozes, follow-ups for high-stakes decisions surfaced by other skills',
  routing: {
    patternRoutes: [
      /^\/(decis(?:ion)?s?|choices?|snooze|dismiss(?:ed)?|followup)\b/i,
    ],
    keywordRoute: /\b(decision|decis[aã]o|decis[oõ]es|escolha|escolhas|choose|escolher|dismiss(?:ed)?|dispensar|descartar|snooze|adiar|adiamento|follow.?up|acompanhamento|pending\s+(?:decision|escolha)|decis[aã]o\s+pendente)\b/i,
    classificationHint: {
      label: 'decision_center',
      description: 'decision orchestration: review pending high-stakes choices, snooze for later, dismiss, schedule follow-ups',
      examples: [
        'What decisions need my input?',
        'Snooze that decision for tomorrow',
        'Tenho decisões pendentes?',
      ],
    },
  },
  subSkills: [
    {
      name: 'choice-flow',
      description: 'Present pending decision options and capture user choice with confirmation',
      enabledByDefault: true,
      tools: [],
    },
    {
      name: 'dismissals',
      description: 'Track dismissed decisions and prevent re-prompting',
      enabledByDefault: true,
      tools: [],
    },
    {
      name: 'snoozes',
      description: 'Snooze decisions with a TTL — they re-surface after the snooze expires',
      enabledByDefault: true,
      tools: [],
    },
    {
      name: 'follow-ups',
      description: 'Schedule a follow-up reminder for decisions that need revisiting',
      enabledByDefault: true,
      tools: [],
    },
  ],
};

// ── Exports ──────────────────────────────────────────────────────

/** The built-in skill definitions, keyed by default domain name. */
export const DEFAULT_SKILLS: Record<DefaultDomainName, SkillDefinition> = {
  secretary: SECRETARY_SKILL,
  triathlon: TRIATHLON_SKILL,
  content: CONTENT_SKILL,
  finance: FINANCE_SKILL,
  cooking: COOKING_SKILL,
  connections: CONNECTIONS_SKILL,
  notifications: NOTIFICATIONS_SKILL,
  decision_center: DECISION_CENTER_SKILL,
};

// ── Runtime Skill Registry ──────────────────────────────────────
//
// Starts with the built-in defaults but accepts dynamically registered
// skills at runtime (e.g. plugins, user-defined domains).

const _skillRegistry = new Map<string, SkillDefinition>(
  Object.entries(DEFAULT_SKILLS) as [string, SkillDefinition][],
);

/**
 * Register a new skill definition at runtime.
 * Overwrites any existing skill with the same name.
 */
export function registerSkill(def: SkillDefinition): void {
  _skillRegistry.set(def.name, def);
}

/**
 * Unregister a skill by name. Returns true if the skill was removed.
 * Cannot unregister default skills — use disable instead.
 */
export function unregisterSkill(name: string): boolean {
  if (name in DEFAULT_SKILLS) return false;
  return _skillRegistry.delete(name);
}

/** Get the skill definition for a domain. Returns undefined for unknown skills. */
export function getSkillDefinition(domain: string): SkillDefinition | undefined {
  return _skillRegistry.get(domain);
}

/** Get all registered skill definitions (defaults + dynamic). */
export function getAllSkillDefinitions(): SkillDefinition[] {
  return [..._skillRegistry.values()];
}

/** Get all tool names that a sub-skill provides across all registered skills. */
export function getAllToolNames(): string[] {
  const tools = new Set<string>();
  for (const skill of _skillRegistry.values()) {
    for (const sub of skill.subSkills) {
      for (const tool of sub.tools) {
        tools.add(tool);
      }
    }
  }
  return [...tools];
}

/** Get all sub-skill names for a domain. Returns empty array for unknown skills. */
export function getSubSkillNames(domain: string): string[] {
  const def = _skillRegistry.get(domain);
  return def ? def.subSkills.map(s => s.name) : [];
}

/** Get the dependencies of a sub-skill. Returns empty array if none or not found. */
export function getSubSkillDependencies(domain: string, subSkillName: string): string[] {
  const def = _skillRegistry.get(domain);
  if (!def) return [];
  const sub = def.subSkills.find(s => s.name === subSkillName);
  return sub?.dependencies ?? [];
}

/** Get sub-skills that depend on a given sub-skill (reverse lookup). */
export function getSubSkillDependents(domain: string, subSkillName: string): string[] {
  const def = _skillRegistry.get(domain);
  if (!def) return [];
  return def.subSkills
    .filter(s => s.dependencies?.includes(subSkillName))
    .map(s => s.name);
}

// ── Dynamic Route Accessors ─────────────────────────────────────

export interface PatternRoute {
  domain: string;
  patterns: RegExp[];
}

export interface KeywordRoute {
  domain: string;
  pattern: RegExp;
  priority: number;   // lower = higher priority (checked first)
}

/**
 * Get all pattern routes from registered skills.
 * @param enabledSkills Optional set of enabled skill names — if provided, only returns routes for those skills.
 */
export function getPatternRoutes(enabledSkills?: Set<string>): PatternRoute[] {
  const skills = [..._skillRegistry.values()];
  return skills
    .filter(s => !enabledSkills || enabledSkills.has(s.name))
    .filter(s => s.routing.patternRoutes.length > 0)
    .map(s => ({ domain: s.name, patterns: s.routing.patternRoutes }));
}

/**
 * Get all keyword routes from registered skills, ordered by priority.
 * Non-secretary domains get higher priority (checked first for specificity).
 * @param enabledSkills Optional set of enabled skill names.
 */
export function getKeywordRoutes(enabledSkills?: Set<string>): KeywordRoute[] {
  const skills = [..._skillRegistry.values()];
  return skills
    .filter(s => !enabledSkills || enabledSkills.has(s.name))
    .filter(s => s.routing.keywordRoute !== null)
    .map(s => ({
      domain: s.name,
      pattern: s.routing.keywordRoute!,
      priority: s.name === 'secretary' ? 99 : 0,  // secretary last (broadest match)
    }))
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Get classification hints for the Haiku classifier prompt.
 * @param enabledSkills Optional set of enabled skill names.
 */
export function getClassificationHints(enabledSkills?: Set<string>): ClassificationHint[] {
  const skills = [..._skillRegistry.values()];
  return skills
    .filter(s => !enabledSkills || enabledSkills.has(s.name))
    .map(s => s.routing.classificationHint);
}

/** Get all registered skill/domain names (defaults + dynamic). */
export function getRegisteredDomainNames(): string[] {
  return [..._skillRegistry.keys()];
}

/** Reset registry to defaults only (for testing). */
export function _resetRegistry(): void {
  _skillRegistry.clear();
  for (const [name, def] of Object.entries(DEFAULT_SKILLS)) {
    _skillRegistry.set(name, def);
  }
}

/** Find which domain+sub-skill owns a given cron job ID. Returns null if not mapped. */
export function getCronJobOwner(jobId: string): { domain: DomainName; subSkill: string } | null {
  let owner: { domain: DomainName; subSkill: string } | null = null;
  for (const [domain, skill] of _skillRegistry.entries()) {
    for (const sub of skill.subSkills) {
      if (sub.cronJobs?.includes(jobId)) {
        const candidate = { domain: domain as DomainName, subSkill: sub.name };
        if (owner) {
          throw new Error(
            `Duplicate cron job ownership for ${jobId}: ${owner.domain}.${owner.subSkill} and ${candidate.domain}.${candidate.subSkill}`,
          );
        }
        owner = candidate;
      }
    }
  }
  return owner;
}

/** Get all cron job IDs owned by sub-skills across all domains. */
export function getAllCronJobMappings(): Map<string, { domain: DomainName; subSkill: string }> {
  const map = new Map<string, { domain: DomainName; subSkill: string }>();
  for (const [domain, skill] of _skillRegistry.entries()) {
    for (const sub of skill.subSkills) {
      for (const jobId of sub.cronJobs ?? []) {
        const owner = { domain: domain as DomainName, subSkill: sub.name };
        const existing = map.get(jobId);
        if (existing) {
          throw new Error(
            `Duplicate cron job ownership for ${jobId}: ${existing.domain}.${existing.subSkill} and ${owner.domain}.${owner.subSkill}`,
          );
        }
        map.set(jobId, owner);
      }
    }
  }
  return map;
}
