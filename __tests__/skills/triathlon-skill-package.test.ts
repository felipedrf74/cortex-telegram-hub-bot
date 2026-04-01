/**
 * Triathlon Skill Package Tests
 *
 * Validates the granular sub-skill migration for the triathlon domain.
 * Sub-skills: garmin-sync, coach-briefing, training-plans, nutrition-diet,
 * body-composition, running, cycling, swimming, recovery-sleep.
 *
 * Each sub-skill owns its tools and cron jobs. Disabled = unregistered.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SKILLS,
  getSubSkillNames,
  getCronJobOwner,
} from '../../src/skills/skill-config';
import type { SubSkillDefinition } from '../../src/skills/skill-config';
import fs from 'fs';
import path from 'path';

const tri = DEFAULT_SKILLS.triathlon;
const subNames = tri.subSkills.map(s => s.name);
const findSub = (name: string): SubSkillDefinition =>
  tri.subSkills.find(s => s.name === name)!;

// ═══════════════════════════════════════════════════════════════════
// STRUCTURE — 9 granular sub-skills
// ═══════════════════════════════════════════════════════════════════

describe('Triathlon Skill — granular sub-skill structure', () => {
  it('has exactly 9 sub-skills', () => {
    expect(tri.subSkills.length).toBe(9);
  });

  it('contains all 9 required sub-skills', () => {
    const required = [
      'garmin-sync', 'coach-briefing', 'training-plans',
      'nutrition-diet', 'body-composition', 'running',
      'cycling', 'swimming', 'recovery-sleep',
    ];
    for (const name of required) {
      expect(subNames).toContain(name);
    }
  });

  it('does NOT contain legacy generic sub-skills', () => {
    // These were the old sub-skills before granular migration
    expect(subNames).not.toContain('calendar');
    expect(subNames).not.toContain('reminders');
    expect(subNames).not.toContain('notes');
    expect(subNames).not.toContain('shared-memory');
  });

  it('is version 2.0.0', () => {
    expect(tri.version).toBe('2.0.0');
  });

  it('getSubSkillNames returns all 9 names', () => {
    const names = getSubSkillNames('triathlon');
    expect(names.length).toBe(9);
    expect(names).toContain('garmin-sync');
    expect(names).toContain('recovery-sleep');
  });
});

// ═══════════════════════════════════════════════════════════════════
// ENABLED/DISABLED — matches task spec
// ═══════════════════════════════════════════════════════════════════

describe('Triathlon Skill — enabled/disabled defaults', () => {
  const enabledSubSkills = [
    'garmin-sync', 'coach-briefing', 'training-plans',
    'running', 'recovery-sleep',
  ];
  const disabledSubSkills = [
    'nutrition-diet', 'body-composition', 'cycling', 'swimming',
  ];

  it('garmin-sync, coach-briefing, training-plans, running, recovery-sleep are ON', () => {
    for (const name of enabledSubSkills) {
      const sub = findSub(name);
      expect(sub, `${name} should exist`).toBeDefined();
      expect(sub.enabledByDefault, `${name} should be enabled`).toBe(true);
    }
  });

  it('nutrition-diet, body-composition, cycling, swimming are OFF', () => {
    for (const name of disabledSubSkills) {
      const sub = findSub(name);
      expect(sub, `${name} should exist`).toBeDefined();
      expect(sub.enabledByDefault, `${name} should be disabled`).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// CRON JOB MAPPING — Garmin + training plan jobs now gated
// ═══════════════════════════════════════════════════════════════════

describe('Triathlon Skill — cron job ownership', () => {
  it('garmin-sync owns garmin_keepalive cron job', () => {
    const sub = findSub('garmin-sync');
    expect(sub.cronJobs).toContain('garmin_keepalive');

    const owner = getCronJobOwner('garmin_keepalive');
    expect(owner).toEqual({ domain: 'triathlon', subSkill: 'garmin-sync' });
  });

  it('coach-briefing owns garmin_coach cron job', () => {
    const sub = findSub('coach-briefing');
    expect(sub.cronJobs).toContain('garmin_coach');

    const owner = getCronJobOwner('garmin_coach');
    expect(owner).toEqual({ domain: 'triathlon', subSkill: 'coach-briefing' });
  });

  it('training-plans owns training_plan_adjust cron job', () => {
    const sub = findSub('training-plans');
    expect(sub.cronJobs).toContain('training_plan_adjust');

    const owner = getCronJobOwner('training_plan_adjust');
    expect(owner).toEqual({ domain: 'triathlon', subSkill: 'training-plans' });
  });
});

// ═══════════════════════════════════════════════════════════════════
// TOOL MAPPING — training-plans owns all current tools
// ═══════════════════════════════════════════════════════════════════

describe('Triathlon Skill — tool distribution', () => {
  it('training-plans has all training + calendar + utility tools', () => {
    const sub = findSub('training-plans');
    // Training-specific tools
    expect(sub.tools).toContain('create_training_plan');
    expect(sub.tools).toContain('add_training_week');
    expect(sub.tools).toContain('add_training_session');
    expect(sub.tools).toContain('get_training_plan');
    expect(sub.tools).toContain('log_training_completion');
    expect(sub.tools).toContain('update_training_session');
    expect(sub.tools).toContain('link_session_calendar');
    // Calendar tools (scheduling workouts)
    expect(sub.tools).toContain('get_calendar_events');
    expect(sub.tools).toContain('create_calendar_event');
    expect(sub.tools).toContain('update_calendar_event');
    expect(sub.tools).toContain('delete_calendar_event');
    // Utility tools
    expect(sub.tools).toContain('set_reminder');
    expect(sub.tools).toContain('save_note');
    expect(sub.tools).toContain('search_notes');
    expect(sub.tools).toContain('shared_memory_set');
    expect(sub.tools).toContain('shared_memory_remove');
  });

  it('sport-discipline sub-skills have no tools (future feature flags)', () => {
    for (const name of ['running', 'cycling', 'swimming']) {
      const sub = findSub(name);
      expect(sub.tools).toEqual([]);
    }
  });

  it('garmin-sync and coach-briefing have no tools (cron-only)', () => {
    expect(findSub('garmin-sync').tools).toEqual([]);
    expect(findSub('coach-briefing').tools).toEqual([]);
  });

  it('nutrition-diet, body-composition, recovery-sleep have no tools (placeholders)', () => {
    expect(findSub('nutrition-diet').tools).toEqual([]);
    expect(findSub('body-composition').tools).toEqual([]);
    expect(findSub('recovery-sleep').tools).toEqual([]);
  });

  it('tool names are unique within triathlon skill (no duplicates)', () => {
    const allTools = tri.subSkills.flatMap(s => s.tools);
    const dupes = allTools.filter((t, i) => allTools.indexOf(t) !== i);
    expect(dupes).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MANIFEST — JSON package file
// ═══════════════════════════════════════════════════════════════════

describe('Triathlon Skill — manifest.json', () => {
  const manifestPath = path.join(__dirname, '..', '..', 'src', 'skills', 'triathlon', 'manifest.json');

  it('manifest file exists at src/skills/triathlon/manifest.json', () => {
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  it('manifest has valid JSON with manifestVersion 2', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.name).toBe('triathlon');
    expect(manifest.domain).toBe('triathlon');
    expect(manifest.version).toBe('2.0.0');
  });

  it('manifest has 9 sub-skills matching skill-config', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.subSkills.length).toBe(9);
    const manifestSubNames = manifest.subSkills.map((s: { module_name: string }) => s.module_name);
    for (const name of subNames) {
      expect(manifestSubNames).toContain(name);
    }
  });
});
