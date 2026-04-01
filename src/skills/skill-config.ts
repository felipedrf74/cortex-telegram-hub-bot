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

import type { DefaultDomainName } from '../domains/types';

// ── Types ────────────────────────────────────────────────────────

export interface SubSkillDefinition {
  name: string;
  description: string;
  tools: string[];                  // tool names from TOOLS array in anthropic.ts
  enabledByDefault: boolean;
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
  routing: SkillRouteConfig;
}

// ── Default Skill Definitions ────────────────────────────────────

const SECRETARY_SKILL: SkillDefinition = {
  name: 'secretary',
  description: 'Personal assistant — tasks, calendar, email, reminders, notes',
  version: '1.0.0',
  routing: {
    patternRoutes: [
      /^\/(sec|agenda|schedule|todo|todos|done|undone|remind|email|week|day|plan|review|move|cancel)\b/i,
      /^\/(lists|tasks|newtask|newlist|deletelist|deletetask|due|priority|search|todosummary|digest|digesttime)\b/i,
      /^\/(overdue|duetoday|dueweek|movetask|alltasks|completed|edittask|notetask|addstep|steps)\b/i,
    ],
    keywordRoute: /\b(tasks?|to-?dos?|remind(?:ers?)?|(?:my\s+)?calendar|schedule|meetings?|appointments?|(?:my\s+)?emails?|inbox|overdue|due\s+(?:today|tomorrow|this\s+week)|planning|digest|unread|mark\s+(?:as\s+)?(?:done|complete)|pending|priority|deadline|tarefas?|lembretes?|agend(?:a|ar)|reuni[oõ]es?|compromissos?|e-?mails?|caixa\s+de\s+entrada|atrasad[ao]s?|pra\s+hoje|pendentes?|prioridade|prazo)\b/i,
    classificationHint: {
      label: 'secretary',
      description: 'scheduling, calendar, appointments, to-do lists, reminders, email, time management, weekly planning, daily overview, general life coordination, invoices, general requests',
      examples: ['what meetings do I have?', 'remind me at 3pm', 'check my email'],
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
    },
    {
      name: 'calendar',
      description: 'Calendar event management (Google + Outlook)',
      enabledByDefault: true,
      tools: [
        'get_calendar_events', 'create_calendar_event',
        'update_calendar_event', 'delete_calendar_event',
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
    },
    {
      name: 'reminders',
      description: 'Time-based reminders',
      enabledByDefault: true,
      tools: ['set_reminder'],
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
  ],
};

const TRIATHLON_SKILL: SkillDefinition = {
  name: 'triathlon',
  description: 'Triathlon coaching — training plans, calendar, Garmin integration',
  version: '1.0.0',
  routing: {
    patternRoutes: [
      /^\/(train|gym|run|bike|checkin|meal|macros|deload|pain|running|cycling)\b/i,
    ],
    keywordRoute: /\b(workout|gym(?:\s+session)?|running\s+plan|cycling\s+plan|sets?\s*[x×]\s*\d|protein|carnivore|training(?:\s+plan)?|macros|deload|squat|deadlift|bench\s+press|heart\s+rate|RPE|RIR|tempo\s+run|intervals?|FTP|soreness|recovery\s+day|muscle|hypertrophy|endurance|coach\s*(?:report|briefing|rec)|lower\s+body|upper\s+body|treino|corrida|pedal(?:ada)?|muscula[çc][aã]o|prote[ií]na|dieta\s+carn[ií]vora|agachamento|supino|levantamento\s+terra|frequ[eê]ncia\s+card[ií]aca|dor\s+muscular|recupera[çc][aã]o|s[eé]ries?\s*[x×]\s*\d|academia)\b/i,
    classificationHint: {
      label: 'triathlon',
      description: 'gym workouts, running, cycling, training plans, nutrition, carnivore diet, recovery, soreness, performance, body composition, supplements, electrolytes',
      examples: ['plan my workout', 'how much protein should I eat?', 'running intervals tomorrow'],
    },
  },
  subSkills: [
    {
      name: 'calendar',
      description: 'Calendar event management for training schedule',
      enabledByDefault: true,
      tools: [
        'get_calendar_events', 'create_calendar_event',
        'update_calendar_event', 'delete_calendar_event',
      ],
    },
    {
      name: 'reminders',
      description: 'Training reminders',
      enabledByDefault: true,
      tools: ['set_reminder'],
    },
    {
      name: 'notes',
      description: 'Training notes and search',
      enabledByDefault: true,
      tools: ['save_note', 'search_notes'],
    },
    {
      name: 'shared-memory',
      description: 'Cross-domain shared facts (race dates, training state)',
      enabledByDefault: true,
      tools: ['shared_memory_set', 'shared_memory_remove'],
    },
  ],
};

const CONTENT_SKILL: SkillDefinition = {
  name: 'content',
  description: 'Content creation — YouTube, Reels, scripts, research',
  version: '1.0.0',
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
      description: 'Content ideas and research notes',
      enabledByDefault: true,
      tools: ['save_note', 'search_notes'],
    },
    {
      name: 'shared-memory',
      description: 'Cross-domain shared facts (filming days, content calendar)',
      enabledByDefault: true,
      tools: ['shared_memory_set', 'shared_memory_remove'],
    },
  ],
};

// ── Exports ──────────────────────────────────────────────────────

/** The three built-in skill definitions, keyed by default domain name. */
export const DEFAULT_SKILLS: Record<DefaultDomainName, SkillDefinition> = {
  secretary: SECRETARY_SKILL,
  triathlon: TRIATHLON_SKILL,
  content: CONTENT_SKILL,
};

// ── Runtime Skill Registry ──────────────────────────────────────
//
// Starts with the three defaults but accepts dynamically registered
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
