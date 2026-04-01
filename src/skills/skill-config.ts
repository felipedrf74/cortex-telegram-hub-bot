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

import type { DomainName } from '../domains/types';

// ── Types ────────────────────────────────────────────────────────

export interface SubSkillDefinition {
  name: string;
  description: string;
  tools: string[];                  // tool names from TOOLS array in anthropic.ts
  enabledByDefault: boolean;
}

export interface SkillDefinition {
  name: string;                     // matches DomainName
  description: string;
  version: string;
  subSkills: SubSkillDefinition[];
}

// ── Default Skill Definitions ────────────────────────────────────

const SECRETARY_SKILL: SkillDefinition = {
  name: 'secretary',
  description: 'Personal assistant — tasks, calendar, email, reminders, notes',
  version: '1.0.0',
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

/** All default skill definitions, keyed by domain name. */
export const DEFAULT_SKILLS: Record<DomainName, SkillDefinition> = {
  secretary: SECRETARY_SKILL,
  triathlon: TRIATHLON_SKILL,
  content: CONTENT_SKILL,
};

/** Get the skill definition for a domain. */
export function getSkillDefinition(domain: DomainName): SkillDefinition {
  return DEFAULT_SKILLS[domain];
}

/** Get all tool names that a sub-skill provides across all domains. */
export function getAllToolNames(): string[] {
  const tools = new Set<string>();
  for (const skill of Object.values(DEFAULT_SKILLS)) {
    for (const sub of skill.subSkills) {
      for (const tool of sub.tools) {
        tools.add(tool);
      }
    }
  }
  return [...tools];
}

/** Get all sub-skill names for a domain. */
export function getSubSkillNames(domain: DomainName): string[] {
  return DEFAULT_SKILLS[domain].subSkills.map(s => s.name);
}
