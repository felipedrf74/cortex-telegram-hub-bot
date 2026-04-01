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
  cronJobs?: string[];              // cron job IDs owned by this sub-skill
  depends?: string[];               // sub-skill names that must be enabled first
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
  description: 'Personal assistant — tasks, calendar, email, reminders, notes, briefings',
  version: '2.0.0',
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
      cronJobs: ['end_of_day', 'shared_list'],
    },
    {
      name: 'calendar',
      description: 'Calendar event management (Google + Outlook)',
      enabledByDefault: true,
      tools: [
        'get_calendar_events', 'create_calendar_event',
        'update_calendar_event', 'delete_calendar_event',
      ],
      cronJobs: ['conflict_detection'],
    },
    {
      name: 'email',
      description: 'Outlook email read/send/reply',
      enabledByDefault: true,
      tools: [
        'search_outlook_emails', 'read_outlook_email',
        'send_outlook_email', 'reply_outlook_email', 'get_outlook_unread',
      ],
      cronJobs: ['fossa_email'],
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
      cronJobs: ['daily_briefing', 'weekly_review'],
    },
  ],
};

const TRIATHLON_SKILL: SkillDefinition = {
  name: 'triathlon',
  description: 'Triathlon coaching — training plans, Garmin sync, sport disciplines, recovery',
  version: '2.0.0',
  subSkills: [
    {
      name: 'garmin-sync',
      description: 'Garmin Connect session keep-alive and data pipeline',
      enabledByDefault: true,
      tools: [],
      cronJobs: ['garmin_keepalive'],
    },
    {
      name: 'coach-briefing',
      description: 'Daily AI coach analysis from Garmin data (depends on garmin-sync)',
      enabledByDefault: true,
      tools: [],
      cronJobs: ['garmin_coach'],
      depends: ['garmin-sync'],
    },
    {
      name: 'training-plans',
      description: 'AI-generated periodized training plans with auto-adjustment',
      enabledByDefault: true,
      tools: [
        'create_training_plan', 'add_training_week', 'add_training_session',
        'get_training_plan', 'log_training_completion', 'update_training_session',
        'link_session_calendar',
        'get_calendar_events', 'create_calendar_event',
        'update_calendar_event', 'delete_calendar_event',
        'set_reminder', 'save_note', 'search_notes',
        'shared_memory_set', 'shared_memory_remove',
      ],
      cronJobs: ['training_plan_adjust'],
    },
    {
      name: 'nutrition-diet',
      description: 'Carnivore diet tracking, macros, and meal planning',
      enabledByDefault: false,
      tools: [],
    },
    {
      name: 'body-composition',
      description: 'Body weight, body fat, and measurement tracking',
      enabledByDefault: false,
      tools: [],
    },
    {
      name: 'running',
      description: 'Running plans, pace zones, race preparation (5K–marathon)',
      enabledByDefault: true,
      tools: [],
    },
    {
      name: 'cycling',
      description: 'Cycling FTP tracking, interval sessions, and ride analysis',
      enabledByDefault: false,
      tools: [],
    },
    {
      name: 'swimming',
      description: 'Swim drills, technique tracking, and pool/open-water plans',
      enabledByDefault: false,
      tools: [],
    },
    {
      name: 'recovery-sleep',
      description: 'Sleep quality, HRV trends, and recovery recommendations',
      enabledByDefault: true,
      tools: [],
    },
  ],
};

const CONTENT_SKILL: SkillDefinition = {
  name: 'content',
  description: 'Content creation — YouTube, Reels, scripts, research, autonomous agents',
  version: '2.0.0',
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
    {
      name: 'research-pipeline',
      description: 'Channel re-learning and reference channel analysis',
      enabledByDefault: true,
      tools: [],
      cronJobs: ['channel_relearn'],
    },
    {
      name: 'script-generator',
      description: 'AI script generation from approved topics',
      enabledByDefault: true,
      tools: [],
    },
    {
      name: 'seo-tracker',
      description: 'YouTube keyword rank tracking and opportunity detection',
      enabledByDefault: true,
      tools: [],
      cronJobs: ['seo_agent'],
    },
    {
      name: 'reaction-radar',
      description: 'Monitors trending content and reference channels for reaction opportunities',
      enabledByDefault: true,
      tools: [],
      cronJobs: ['reaction_radar'],
    },
    {
      name: 'voice-evolution',
      description: 'Compares AI scripts vs actual transcripts to learn voice patterns',
      enabledByDefault: true,
      tools: [],
      cronJobs: ['voice_evolution'],
    },
    {
      name: 'performance-intel',
      description: 'Analyzes YouTube channel performance by pillar and format',
      enabledByDefault: true,
      tools: [],
      cronJobs: ['performance_agent'],
    },
    {
      name: 'pipeline-tracker',
      description: 'Monitors content pipeline stages and detects bottlenecks',
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
      name: 'meme-scout',
      description: 'Discovers meme-worthy content for social engagement (experimental)',
      enabledByDefault: false,
      tools: [],
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

/** Find which domain+sub-skill owns a given cron job ID. Returns null if not mapped. */
export function getCronJobOwner(jobId: string): { domain: DomainName; subSkill: string } | null {
  for (const [domain, skill] of Object.entries(DEFAULT_SKILLS)) {
    for (const sub of skill.subSkills) {
      if (sub.cronJobs?.includes(jobId)) {
        return { domain: domain as DomainName, subSkill: sub.name };
      }
    }
  }
  return null;
}

/** Get the dependencies for a sub-skill. Returns empty array if none. */
export function getSubSkillDependencies(domain: DomainName, subSkillName: string): string[] {
  const skill = DEFAULT_SKILLS[domain];
  const sub = skill.subSkills.find(s => s.name === subSkillName);
  return sub?.depends ?? [];
}

/** Get sub-skills that depend on the given sub-skill (reverse dependencies). */
export function getSubSkillDependents(domain: DomainName, subSkillName: string): string[] {
  const skill = DEFAULT_SKILLS[domain];
  return skill.subSkills
    .filter(s => s.depends?.includes(subSkillName))
    .map(s => s.name);
}

/** Get all cron job IDs owned by sub-skills across all domains. */
export function getAllCronJobMappings(): Map<string, { domain: DomainName; subSkill: string }> {
  const map = new Map<string, { domain: DomainName; subSkill: string }>();
  for (const [domain, skill] of Object.entries(DEFAULT_SKILLS)) {
    for (const sub of skill.subSkills) {
      for (const jobId of sub.cronJobs ?? []) {
        map.set(jobId, { domain: domain as DomainName, subSkill: sub.name });
      }
    }
  }
  return map;
}
