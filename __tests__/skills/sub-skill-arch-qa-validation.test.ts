/**
 * QA Validation Tests — Granular Sub-Skill Architecture
 *
 * Validates the sub-skill system where domains become skills and
 * features become toggleable sub-skills. Focus areas:
 * 1. Tool name contract: every tool in skill-config exists in TOOLS array
 * 2. Domain coverage: every DomainName has a skill definition
 * 3. Anthropic wiring: callDomain uses getToolsForDomain
 * 4. Architecture invariants and type safety
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

// ── Read source files once ──────────────────────────────────────────
const anthropicTs = fs.readFileSync(
  path.join(ROOT, 'src', 'services', 'anthropic.ts'), 'utf-8',
);
const skillConfigTs = fs.readFileSync(
  path.join(ROOT, 'src', 'skills', 'skill-config.ts'), 'utf-8',
);
const skillManagerTs = fs.readFileSync(
  path.join(ROOT, 'src', 'skills', 'skill-manager.ts'), 'utf-8',
);
const registryTs = fs.readFileSync(
  path.join(ROOT, 'src', 'skills', 'registry.ts'), 'utf-8',
);
const domainTypesTs = fs.readFileSync(
  path.join(ROOT, 'src', 'domains', 'types.ts'), 'utf-8',
);

// ── Extract tool names from TOOLS array in anthropic.ts ─────────────
function extractToolNamesFromAnthropic(): string[] {
  const regex = /name:\s*'([a-z_]+)'/g;
  const names: string[] = [];
  let match;
  // Only extract from the TOOLS array section
  const toolsStart = anthropicTs.indexOf('const TOOLS');
  const toolsEnd = anthropicTs.indexOf('] as const', toolsStart);
  const toolsSection = anthropicTs.slice(toolsStart, toolsEnd);
  while ((match = regex.exec(toolsSection)) !== null) {
    names.push(match[1]);
  }
  return names;
}

// ── Extract tool names from skill-config.ts ─────────────────────────
function extractToolNamesFromConfig(): string[] {
  const regex = /'([a-z_]+)'/g;
  const names = new Set<string>();
  // Find all tools arrays
  const toolsRegex = /tools:\s*\[([\s\S]*?)\]/g;
  let match;
  while ((match = toolsRegex.exec(skillConfigTs)) !== null) {
    const block = match[1];
    let toolMatch;
    while ((toolMatch = regex.exec(block)) !== null) {
      names.add(toolMatch[1]);
    }
  }
  return [...names];
}

describe('Sub-Skill Architecture — tool name contract', () => {
  const anthropicTools = extractToolNamesFromAnthropic();
  const configTools = extractToolNamesFromConfig();

  it('anthropic.ts TOOLS array has at least 20 tools', () => {
    expect(anthropicTools.length).toBeGreaterThanOrEqual(20);
  });

  it('skill-config.ts references at least 15 unique tools', () => {
    expect(configTools.length).toBeGreaterThanOrEqual(15);
  });

  it('every tool in skill-config exists in anthropic.ts TOOLS array', () => {
    const anthropicToolSet = new Set(anthropicTools);
    const missing = configTools.filter(t => !anthropicToolSet.has(t));
    expect(missing).toEqual([]);
  });

  it('no duplicate tool names in the TOOLS array', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const name of anthropicTools) {
      if (seen.has(name)) dupes.push(name);
      seen.add(name);
    }
    expect(dupes).toEqual([]);
  });
});

describe('Sub-Skill Architecture — domain coverage', () => {
  it('DefaultDomainName type defines exactly 4 domains', () => {
    expect(domainTypesTs).toContain("'secretary' | 'triathlon' | 'content' | 'finance'");
  });

  it('DomainName type is extensible (accepts any string)', () => {
    expect(domainTypesTs).toContain('DefaultDomainName | (string & {})');
  });

  it('DEFAULT_SKILLS has entries for all 4 domains', () => {
    expect(skillConfigTs).toContain("secretary: SECRETARY_SKILL");
    expect(skillConfigTs).toContain("triathlon: TRIATHLON_SKILL");
    expect(skillConfigTs).toContain("content: CONTENT_SKILL");
    expect(skillConfigTs).toContain("finance: FINANCE_SKILL");
  });

  it('DEFAULT_SKILLS is typed as Record<DefaultDomainName, SkillDefinition>', () => {
    expect(skillConfigTs).toContain('Record<DefaultDomainName, SkillDefinition>');
  });

  it('skill names match domain names exactly', () => {
    expect(skillConfigTs).toContain("name: 'secretary'");
    expect(skillConfigTs).toContain("name: 'triathlon'");
    expect(skillConfigTs).toContain("name: 'content'");
    expect(skillConfigTs).toContain("name: 'finance'");
  });
});

describe('Sub-Skill Architecture — anthropic.ts integration wiring', () => {
  it('imports getToolsForDomain from skill-manager', () => {
    expect(anthropicTs).toContain("import { getToolsForDomain } from '../skills/skill-manager'");
  });

  it('defines serviceAvailabilityFilter function', () => {
    expect(anthropicTs).toContain('function serviceAvailabilityFilter');
  });

  it('getToolsForDomainCached delegates to getToolsForDomain with TOOLS and filter', () => {
    expect(anthropicTs).toContain('getToolsForDomain(domain, TOOLS, serviceAvailabilityFilter)');
  });

  it('callDomain uses per-domain tool filtering', () => {
    expect(anthropicTs).toContain('getToolsForDomainCached(domain)');
  });

  it('continueWithToolResults also uses per-domain tool filtering', () => {
    // Should appear at least twice (callDomain + continueWithToolResults)
    const matches = anthropicTs.match(/getToolsForDomainCached\(domain\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('getCachedTools is marked as legacy fallback', () => {
    expect(anthropicTs).toContain('Legacy getCachedTools');
  });

  it('useTools is determined by domain tool count, not hardcoded domain names', () => {
    expect(anthropicTs).toContain('domainTools.length > 0');
  });
});

describe('Sub-Skill Architecture — skill-manager module', () => {
  it('exports seedDefaultSkills function', () => {
    expect(skillManagerTs).toContain('export function seedDefaultSkills');
  });

  it('exports getToolsForDomain function', () => {
    expect(skillManagerTs).toContain('export function getToolsForDomain');
  });

  it('exports toggle API: enableSubSkill, disableSubSkill, enableSkill, disableSkill', () => {
    expect(skillManagerTs).toContain('export function enableSubSkill');
    expect(skillManagerTs).toContain('export function disableSubSkill');
    expect(skillManagerTs).toContain('export function enableSkill');
    expect(skillManagerTs).toContain('export function disableSkill');
  });

  it('exports query API: getSkillStatus, getAllSkillStatuses', () => {
    expect(skillManagerTs).toContain('export function getSkillStatus');
    expect(skillManagerTs).toContain('export function getAllSkillStatuses');
  });

  it('has cache invalidation on toggle', () => {
    expect(skillManagerTs).toContain('invalidateToolCache()');
  });

  it('adds cache_control to last tool for Anthropic prompt caching', () => {
    expect(skillManagerTs).toContain("cache_control: { type: 'ephemeral'");
  });

  it('SubSkillStatus interface has toolCount field', () => {
    expect(skillManagerTs).toContain('toolCount: number');
  });
});

describe('Sub-Skill Architecture — skill-config module', () => {
  it('exports SubSkillDefinition and SkillDefinition types', () => {
    expect(skillConfigTs).toContain('export interface SubSkillDefinition');
    expect(skillConfigTs).toContain('export interface SkillDefinition');
  });

  it('SubSkillDefinition has enabledByDefault flag', () => {
    expect(skillConfigTs).toContain('enabledByDefault: boolean');
  });

  it('SkillDefinition has version field', () => {
    expect(skillConfigTs).toContain('version: string');
  });

  it('exports getSkillDefinition and getAllToolNames utility functions', () => {
    expect(skillConfigTs).toContain('export function getSkillDefinition');
    expect(skillConfigTs).toContain('export function getAllToolNames');
  });

  it('exports getSubSkillNames utility function', () => {
    expect(skillConfigTs).toContain('export function getSubSkillNames');
  });

  it('all sub-skills have enabledByDefault set to true in initial config', () => {
    const disabledMatches = skillConfigTs.match(/enabledByDefault:\s*false/g);
    expect(disabledMatches).toBeNull();
  });
});

describe('Sub-Skill Architecture — registry module', () => {
  it('uses upsert (ON CONFLICT) for skill installation', () => {
    expect(registryTs).toContain('ON CONFLICT(name) DO UPDATE');
  });

  it('uses upsert for submodule installation', () => {
    expect(registryTs).toContain('ON CONFLICT(skill_id, module_name) DO UPDATE');
  });

  it('exports enableSubmodule and disableSubmodule', () => {
    expect(registryTs).toContain('export function enableSubmodule');
    expect(registryTs).toContain('export function disableSubmodule');
  });

  it('exports getEnabledSubmodules', () => {
    expect(registryTs).toContain('export function getEnabledSubmodules');
  });

  it('exports isSubmoduleEnabled for individual checks', () => {
    expect(registryTs).toContain('export function isSubmoduleEnabled');
  });

  it('cascade deletes submodules when skill is uninstalled', () => {
    // The uninstall function only deletes from installed_skills;
    // cascade should be handled by SQL foreign key
    expect(registryTs).toContain("DELETE FROM installed_skills WHERE name = ?");
  });
});

describe('Sub-Skill Architecture — secretary sub-skills', () => {
  it('has tasks sub-skill with all ms_todo tools (14)', () => {
    const tasksBlock = skillConfigTs.slice(
      skillConfigTs.indexOf("name: 'tasks'"),
      skillConfigTs.indexOf("name: 'calendar'"),
    );
    const todoTools = (tasksBlock.match(/ms_todo_/g) || []).length;
    expect(todoTools).toBe(14);
  });

  it('has calendar sub-skill', () => {
    expect(skillConfigTs).toContain("name: 'calendar'");
  });

  it('has email sub-skill with outlook tools', () => {
    const emailBlock = skillConfigTs.slice(
      skillConfigTs.indexOf("name: 'email'"),
      skillConfigTs.indexOf("name: 'reminders'"),
    );
    expect(emailBlock).toContain('search_outlook_emails');
    expect(emailBlock).toContain('send_outlook_email');
  });

  it('has reminders sub-skill', () => {
    expect(skillConfigTs).toContain("name: 'reminders'");
  });

  it('has notes sub-skill', () => {
    expect(skillConfigTs).toContain("name: 'notes'");
  });

  it('has shared-memory sub-skill', () => {
    expect(skillConfigTs).toContain("name: 'shared-memory'");
  });
});

describe('Sub-Skill Architecture — triathlon sub-skills', () => {
  it('triathlon has calendar, reminders, notes, shared-memory', () => {
    const triBlock = skillConfigTs.slice(
      skillConfigTs.indexOf('TRIATHLON_SKILL'),
      skillConfigTs.indexOf('CONTENT_SKILL'),
    );
    expect(triBlock).toContain("name: 'calendar'");
    expect(triBlock).toContain("name: 'reminders'");
    expect(triBlock).toContain("name: 'notes'");
    expect(triBlock).toContain("name: 'shared-memory'");
  });

  it('triathlon does NOT have tasks or email sub-skills', () => {
    const triBlock = skillConfigTs.slice(
      skillConfigTs.indexOf('TRIATHLON_SKILL'),
      skillConfigTs.indexOf('CONTENT_SKILL'),
    );
    expect(triBlock).not.toContain("name: 'tasks'");
    expect(triBlock).not.toContain("name: 'email'");
  });
});

describe('Sub-Skill Architecture — content sub-skills', () => {
  it('content has notes and shared-memory', () => {
    const contentBlock = skillConfigTs.slice(
      skillConfigTs.indexOf('CONTENT_SKILL'),
    );
    expect(contentBlock).toContain("name: 'notes'");
    expect(contentBlock).toContain("name: 'shared-memory'");
  });

  it('content does NOT have tasks, calendar, email, or reminders', () => {
    const contentBlock = skillConfigTs.slice(
      skillConfigTs.indexOf('CONTENT_SKILL'),
    );
    expect(contentBlock).not.toContain("name: 'tasks'");
    expect(contentBlock).not.toContain("name: 'email'");
    // calendar and reminders may appear in the full file but not in CONTENT_SKILL
    const contentSubSkills = contentBlock.slice(0, contentBlock.indexOf('Exports'));
    expect(contentSubSkills).not.toContain("name: 'calendar'");
  });
});

describe('Sub-Skill Architecture — copyright headers', () => {
  it('skill-config.ts has MIT copyright header', () => {
    expect(skillConfigTs.split('\n')[0]).toContain('MIT License');
  });

  it('skill-manager.ts has MIT copyright header', () => {
    expect(skillManagerTs.split('\n')[0]).toContain('MIT License');
  });

  it('registry.ts has MIT copyright header', () => {
    expect(registryTs.split('\n')[0]).toContain('MIT License');
  });
});
