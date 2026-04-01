/**
 * Tests for src/skills/skill-config.ts
 *
 * Validates the declarative skill/sub-skill/tool mapping:
 * - All domains have skill definitions
 * - Sub-skills reference valid tool names
 * - No duplicate tool names within a skill
 * - Helper functions work correctly
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SKILLS,
  getSkillDefinition,
  getAllToolNames,
  getSubSkillNames,
} from '../../src/skills/skill-config';
import type { SkillDefinition, SubSkillDefinition } from '../../src/skills/skill-config';
import { TOOLS } from '../../src/services/anthropic';

// ═══════════════════════════════════════════════════════════════════
// STRUCTURE TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillConfig — structure', () => {
  it('defines skills for all three domains', () => {
    expect(DEFAULT_SKILLS).toHaveProperty('secretary');
    expect(DEFAULT_SKILLS).toHaveProperty('triathlon');
    expect(DEFAULT_SKILLS).toHaveProperty('content');
  });

  it('each skill has required fields', () => {
    for (const [domain, skill] of Object.entries(DEFAULT_SKILLS)) {
      expect(skill.name).toBe(domain);
      expect(skill.description).toBeTruthy();
      expect(skill.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(skill.subSkills.length).toBeGreaterThan(0);
    }
  });

  it('each sub-skill has required fields', () => {
    for (const skill of Object.values(DEFAULT_SKILLS)) {
      for (const sub of skill.subSkills) {
        expect(sub.name).toBeTruthy();
        expect(sub.description).toBeTruthy();
        // Sub-skills must have either tools or cronJobs (briefings has only crons)
        expect(sub.tools.length + (sub.cronJobs?.length ?? 0)).toBeGreaterThan(0);
        expect(typeof sub.enabledByDefault).toBe('boolean');
      }
    }
  });

  it('sub-skill names are unique within each skill', () => {
    for (const skill of Object.values(DEFAULT_SKILLS)) {
      const names = skill.subSkills.map(s => s.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('tool names are unique within each skill', () => {
    for (const skill of Object.values(DEFAULT_SKILLS)) {
      const tools = skill.subSkills.flatMap(s => s.tools);
      const dupes = tools.filter((t, i) => tools.indexOf(t) !== i);
      expect(dupes).toEqual([]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// TOOL COVERAGE TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillConfig — tool coverage', () => {
  const allDefinedToolNames = TOOLS.map(t => t.name);

  it('every tool in TOOLS is mapped to at least one sub-skill', () => {
    const mappedTools = getAllToolNames();
    for (const toolName of allDefinedToolNames) {
      expect(mappedTools).toContain(toolName);
    }
  });

  it('every sub-skill tool reference exists in TOOLS', () => {
    const toolSet = new Set(allDefinedToolNames);
    for (const skill of Object.values(DEFAULT_SKILLS)) {
      for (const sub of skill.subSkills) {
        for (const tool of sub.tools) {
          expect(toolSet.has(tool)).toBe(true);
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// DOMAIN-SPECIFIC TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillConfig — secretary skill', () => {
  const sec = DEFAULT_SKILLS.secretary;

  it('has task, calendar, email, reminders, notes, shared-memory sub-skills', () => {
    const subNames = sec.subSkills.map(s => s.name);
    expect(subNames).toContain('tasks');
    expect(subNames).toContain('calendar');
    expect(subNames).toContain('email');
    expect(subNames).toContain('reminders');
    expect(subNames).toContain('notes');
    expect(subNames).toContain('shared-memory');
  });

  it('tasks sub-skill has all ms_todo tools', () => {
    const tasksSub = sec.subSkills.find(s => s.name === 'tasks')!;
    const todoTools = TOOLS.filter(t => t.name.startsWith('ms_todo_'));
    expect(tasksSub.tools.length).toBe(todoTools.length);
  });

  it('email sub-skill has all outlook email tools', () => {
    const emailSub = sec.subSkills.find(s => s.name === 'email')!;
    expect(emailSub.tools).toContain('search_outlook_emails');
    expect(emailSub.tools).toContain('send_outlook_email');
    expect(emailSub.tools).toContain('get_outlook_unread');
  });

  it('all sub-skills enabled by default', () => {
    for (const sub of sec.subSkills) {
      expect(sub.enabledByDefault).toBe(true);
    }
  });
});

describe('SkillConfig — triathlon skill', () => {
  const tri = DEFAULT_SKILLS.triathlon;

  it('has calendar, reminders, notes, shared-memory sub-skills', () => {
    const subNames = tri.subSkills.map(s => s.name);
    expect(subNames).toContain('calendar');
    expect(subNames).toContain('reminders');
    expect(subNames).toContain('notes');
    expect(subNames).toContain('shared-memory');
  });

  it('does NOT have tasks or email sub-skills', () => {
    const subNames = tri.subSkills.map(s => s.name);
    expect(subNames).not.toContain('tasks');
    expect(subNames).not.toContain('email');
  });
});

describe('SkillConfig — content skill', () => {
  const cnt = DEFAULT_SKILLS.content;

  it('has notes and shared-memory sub-skills', () => {
    const subNames = cnt.subSkills.map(s => s.name);
    expect(subNames).toContain('notes');
    expect(subNames).toContain('shared-memory');
  });

  it('has the fewest sub-skills', () => {
    expect(cnt.subSkills.length).toBeLessThanOrEqual(DEFAULT_SKILLS.triathlon.subSkills.length);
    expect(cnt.subSkills.length).toBeLessThanOrEqual(DEFAULT_SKILLS.secretary.subSkills.length);
  });
});

// ═══════════════════════════════════════════════════════════════════
// HELPER FUNCTION TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillConfig — getSkillDefinition()', () => {
  it('returns the correct skill for each domain', () => {
    expect(getSkillDefinition('secretary').name).toBe('secretary');
    expect(getSkillDefinition('triathlon').name).toBe('triathlon');
    expect(getSkillDefinition('content').name).toBe('content');
  });
});

describe('SkillConfig — getAllToolNames()', () => {
  it('returns a non-empty array of unique tool names', () => {
    const tools = getAllToolNames();
    expect(tools.length).toBeGreaterThan(0);
    expect(new Set(tools).size).toBe(tools.length);
  });
});

describe('SkillConfig — getSubSkillNames()', () => {
  it('returns sub-skill names for secretary', () => {
    const names = getSubSkillNames('secretary');
    expect(names).toContain('tasks');
    expect(names).toContain('email');
  });

  it('returns sub-skill names for content', () => {
    const names = getSubSkillNames('content');
    expect(names).toContain('notes');
    expect(names.length).toBe(2);
  });
});
