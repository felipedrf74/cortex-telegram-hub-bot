/**
 * Tests for src/skills/skill-config.ts
 *
 * Validates the declarative skill/sub-skill/tool mapping:
 * - All domains have skill definitions
 * - Sub-skills reference valid tool names
 * - No duplicate tool names within a skill
 * - Helper functions work correctly
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_SKILLS,
  getSkillDefinition,
  getAllToolNames,
  getSubSkillNames,
  registerSkill,
  unregisterSkill,
  getAllSkillDefinitions,
  getRegisteredDomainNames,
  getPatternRoutes,
  getKeywordRoutes,
  getClassificationHints,
  _resetRegistry,
} from '../../src/skills/skill-config';
import type { SkillDefinition, SubSkillDefinition } from '../../src/skills/skill-config';
import { TOOLS } from '../../src/services/anthropic';

// ═══════════════════════════════════════════════════════════════════
// STRUCTURE TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillConfig — structure', () => {
  it('defines skills for all four domains', () => {
    expect(DEFAULT_SKILLS).toHaveProperty('secretary');
    expect(DEFAULT_SKILLS).toHaveProperty('triathlon');
    expect(DEFAULT_SKILLS).toHaveProperty('content');
    expect(DEFAULT_SKILLS).toHaveProperty('finance');
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
        expect(sub.tools.length).toBeGreaterThan(0);
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
    expect(cnt.subSkills.length).toBeLessThanOrEqual(DEFAULT_SKILLS.finance.subSkills.length);
  });
});

// ═══════════════════════════════════════════════════════════════════
// HELPER FUNCTION TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillConfig — getSkillDefinition()', () => {
  it('returns the correct skill for each domain', () => {
    expect(getSkillDefinition('secretary')!.name).toBe('secretary');
    expect(getSkillDefinition('triathlon')!.name).toBe('triathlon');
    expect(getSkillDefinition('content')!.name).toBe('content');
    expect(getSkillDefinition('finance')!.name).toBe('finance');
  });

  it('returns undefined for unknown skills', () => {
    expect(getSkillDefinition('nonexistent')).toBeUndefined();
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

  it('returns empty array for unknown skills', () => {
    expect(getSubSkillNames('nonexistent')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// DYNAMIC SKILL REGISTRATION TESTS
// ═══════════════════════════════════════════════════════════════════

const ACCOUNTING_SKILL: SkillDefinition = {
  name: 'accounting',
  description: 'Corporate accounting — ledgers, reconciliation, audits',
  version: '1.0.0',
  routing: {
    patternRoutes: [/^\/(ledger|reconcile|audit)\b/i],
    keywordRoute: /\b(ledgers?|reconciliation|audits?|accounting|bookkeeping)\b/i,
    classificationHint: {
      label: 'accounting',
      description: 'ledgers, reconciliation, audits, bookkeeping',
      examples: ['reconcile the ledger', 'run an audit'],
    },
  },
  subSkills: [
    {
      name: 'ledgers',
      description: 'Ledger management',
      enabledByDefault: true,
      tools: ['create_ledger', 'get_ledgers'],
    },
    {
      name: 'audits',
      description: 'Audit tracking',
      enabledByDefault: true,
      tools: ['run_audit', 'get_audits'],
    },
  ],
};

describe('SkillConfig — dynamic skill registration', () => {
  afterEach(() => {
    _resetRegistry();
  });

  it('registerSkill adds a new skill to the registry', () => {
    registerSkill(ACCOUNTING_SKILL);
    expect(getSkillDefinition('accounting')).toBeDefined();
    expect(getSkillDefinition('accounting')!.name).toBe('accounting');
  });

  it('registered skill appears in getRegisteredDomainNames', () => {
    registerSkill(ACCOUNTING_SKILL);
    const names = getRegisteredDomainNames();
    expect(names).toContain('accounting');
    expect(names).toHaveLength(5);
  });

  it('registered skill appears in getAllSkillDefinitions', () => {
    registerSkill(ACCOUNTING_SKILL);
    const defs = getAllSkillDefinitions();
    expect(defs).toHaveLength(5);
    expect(defs.map(d => d.name)).toContain('accounting');
  });

  it('registered skill appears in getPatternRoutes', () => {
    registerSkill(ACCOUNTING_SKILL);
    const routes = getPatternRoutes();
    expect(routes).toHaveLength(5);
    const accounting = routes.find(r => r.domain === 'accounting')!;
    expect(accounting.patterns[0].test('/ledger check')).toBe(true);
  });

  it('registered skill appears in getKeywordRoutes', () => {
    registerSkill(ACCOUNTING_SKILL);
    const routes = getKeywordRoutes();
    expect(routes).toHaveLength(5);
    const accounting = routes.find(r => r.domain === 'accounting')!;
    expect(accounting.pattern.test('reconcile the ledger')).toBe(true);
    expect(accounting.priority).toBe(0); // non-secretary = high priority
  });

  it('registered skill appears in getClassificationHints', () => {
    registerSkill(ACCOUNTING_SKILL);
    const hints = getClassificationHints();
    expect(hints).toHaveLength(5);
    expect(hints.map(h => h.label)).toContain('accounting');
  });

  it('registered skill tools appear in getAllToolNames', () => {
    registerSkill(ACCOUNTING_SKILL);
    const tools = getAllToolNames();
    expect(tools).toContain('create_ledger');
    expect(tools).toContain('run_audit');
  });

  it('registered skill sub-skills appear in getSubSkillNames', () => {
    registerSkill(ACCOUNTING_SKILL);
    const names = getSubSkillNames('accounting');
    expect(names).toEqual(['ledgers', 'audits']);
  });

  it('enabledSkills filter works with dynamic skills', () => {
    registerSkill(ACCOUNTING_SKILL);
    const routes = getPatternRoutes(new Set(['accounting', 'secretary']));
    expect(routes).toHaveLength(2);
    expect(routes.map(r => r.domain)).toContain('accounting');
    expect(routes.map(r => r.domain)).toContain('secretary');
  });

  it('unregisterSkill removes a dynamic skill', () => {
    registerSkill(ACCOUNTING_SKILL);
    expect(getSkillDefinition('accounting')).toBeDefined();

    const removed = unregisterSkill('accounting');
    expect(removed).toBe(true);
    expect(getSkillDefinition('accounting')).toBeUndefined();
    expect(getRegisteredDomainNames()).toHaveLength(4);
  });

  it('unregisterSkill returns false for default skills', () => {
    expect(unregisterSkill('secretary')).toBe(false);
    expect(getSkillDefinition('secretary')).toBeDefined();
  });

  it('unregisterSkill returns false for unknown skills', () => {
    expect(unregisterSkill('nonexistent')).toBe(false);
  });

  it('registerSkill can overwrite an existing dynamic skill', () => {
    registerSkill(ACCOUNTING_SKILL);
    const updated = { ...ACCOUNTING_SKILL, version: '2.0.0' };
    registerSkill(updated);
    expect(getSkillDefinition('accounting')!.version).toBe('2.0.0');
  });

  it('_resetRegistry restores defaults only', () => {
    registerSkill(ACCOUNTING_SKILL);
    expect(getRegisteredDomainNames()).toHaveLength(5);
    _resetRegistry();
    expect(getRegisteredDomainNames()).toHaveLength(4);
    expect(getSkillDefinition('accounting')).toBeUndefined();
    expect(getSkillDefinition('secretary')).toBeDefined();
  });

  it('defaults are preserved after registering dynamic skills', () => {
    registerSkill(ACCOUNTING_SKILL);
    expect(getSkillDefinition('secretary')!.name).toBe('secretary');
    expect(getSkillDefinition('triathlon')!.name).toBe('triathlon');
    expect(getSkillDefinition('content')!.name).toBe('content');
    expect(getSkillDefinition('finance')!.name).toBe('finance');
  });
});
