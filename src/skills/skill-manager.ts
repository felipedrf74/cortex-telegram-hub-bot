// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Skill Manager — runtime orchestration for the sub-skill system.
 *
 * Responsibilities:
 * 1. Seed default skills + submodules into DB on startup
 * 2. Build per-domain tool arrays filtered by enabled sub-skills
 * 3. Invalidate caches when sub-skills are toggled
 * 4. Provide a clean API for the portal toggle UI
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { DomainName } from '../domains/types';
import { DEFAULT_SKILLS, getSkillDefinition } from './skill-config';
import type { SkillDefinition } from './skill-config';
import * as registry from './registry';
import { logger } from '../utils/logger';

// ── Cache ────────────────────────────────────────────────────────

interface ToolCache {
  tools: Anthropic.Tool[];
  generation: number;
}

let _cacheGeneration = 0;
const _domainToolCache = new Map<DomainName, ToolCache>();

/** Invalidate all cached tool arrays (call after any sub-skill toggle). */
export function invalidateToolCache(): void {
  _cacheGeneration++;
}

// ── Seeding ──────────────────────────────────────────────────────

/**
 * Seed all default skills and their submodules into the database.
 * Safe to call on every startup — uses upsert, won't overwrite user toggles.
 *
 * Strategy: install skill if missing, add submodules if missing.
 * Existing enabled/disabled state is preserved.
 */
export function seedDefaultSkills(): void {
  for (const skill of Object.values(DEFAULT_SKILLS)) {
    seedSkill(skill);
  }
  logger.info('Default skills seeded');
}

function seedSkill(def: SkillDefinition): void {
  const existing = registry.getByName(def.name);

  if (!existing) {
    // First install — create skill + all submodules with default enabled state
    registry.install({
      name: def.name,
      description: def.description,
      version: def.version,
      domain: def.name,
      submodules: def.subSkills.map(sub => ({
        module_name: sub.name,
        version: def.version,
        config: { enabledByDefault: sub.enabledByDefault },
      })),
    });

    // Set enabled state per submodule default
    for (const sub of def.subSkills) {
      if (!sub.enabledByDefault) {
        registry.disableSubmodule(def.name, sub.name);
      }
    }
    return;
  }

  // Skill exists — ensure any NEW submodules are added (don't touch existing ones)
  const existingSubs = registry.getSubmodules(existing.id);
  const existingSubNames = new Set(existingSubs.map(s => s.module_name));

  for (const sub of def.subSkills) {
    if (!existingSubNames.has(sub.name)) {
      // New submodule added in a code update — install it
      registry.install({
        name: def.name,
        description: def.description,
        version: def.version,
        domain: def.name,
        submodules: [{ module_name: sub.name, version: def.version }],
      });
      if (!sub.enabledByDefault) {
        registry.disableSubmodule(def.name, sub.name);
      }
      logger.info({ skill: def.name, submodule: sub.name }, 'New submodule added');
    }
  }
}

// ── Tool Filtering ───────────────────────────────────────────────

/**
 * Get the filtered tool array for a domain, based on its enabled sub-skills.
 * Results are cached per-domain and invalidated on any toggle.
 *
 * @param domain - The domain to get tools for
 * @param allTools - The full TOOLS array from anthropic.ts
 * @param serviceFilter - Optional function to further filter by service availability
 */
export function getToolsForDomain(
  domain: DomainName,
  allTools: Anthropic.Tool[],
  serviceFilter?: (tool: Anthropic.Tool) => boolean,
): Anthropic.Tool[] {
  // Check cache
  const cached = _domainToolCache.get(domain);
  if (cached && cached.generation === _cacheGeneration) {
    return cached.tools;
  }

  // Build the set of allowed tool names for this domain
  const allowedTools = getEnabledToolNames(domain);

  // Filter the full tool array
  let tools = allTools.filter(t => allowedTools.has(t.name));

  // Apply service availability filter (e.g., skip email tools if Outlook not configured)
  if (serviceFilter) {
    tools = tools.filter(serviceFilter);
  }

  // Add cache_control to the last tool for Anthropic prompt caching
  const cachedTools = tools.map((t, i) =>
    i === tools.length - 1
      ? { ...t, cache_control: { type: 'ephemeral' as const } }
      : t
  );

  _domainToolCache.set(domain, { tools: cachedTools, generation: _cacheGeneration });
  return cachedTools;
}

/**
 * Get the set of tool names enabled for a domain based on its sub-skills.
 * Checks both the skill-level enabled flag and individual submodule enabled flags.
 */
function getEnabledToolNames(domain: DomainName): Set<string> {
  const skillDef = getSkillDefinition(domain);
  const skill = registry.getByName(domain);

  // If skill not in DB or disabled, return empty set (no tools)
  if (!skill || skill.enabled !== 1) {
    return new Set();
  }

  const enabledSubNames = new Set(registry.getEnabledSubmodules(domain));
  const toolNames = new Set<string>();

  for (const sub of skillDef.subSkills) {
    if (enabledSubNames.has(sub.name)) {
      for (const tool of sub.tools) {
        toolNames.add(tool);
      }
    }
  }

  return toolNames;
}

// ── Toggle API (for portal UI) ───────────────────────────────────

/** Enable a sub-skill for a domain. Invalidates tool cache. */
export function enableSubSkill(domain: DomainName, subSkillName: string): boolean {
  const result = registry.enableSubmodule(domain, subSkillName);
  if (result) invalidateToolCache();
  return result;
}

/** Disable a sub-skill for a domain. Invalidates tool cache. */
export function disableSubSkill(domain: DomainName, subSkillName: string): boolean {
  const result = registry.disableSubmodule(domain, subSkillName);
  if (result) invalidateToolCache();
  return result;
}

/** Enable an entire skill (domain). Invalidates tool cache. */
export function enableSkill(domain: DomainName): boolean {
  const result = registry.enable(domain);
  if (result) invalidateToolCache();
  return result;
}

/** Disable an entire skill (domain). Invalidates tool cache. */
export function disableSkill(domain: DomainName): boolean {
  const result = registry.disable(domain);
  if (result) invalidateToolCache();
  return result;
}

// ── Query API ────────────────────────────────────────────────────

export interface SubSkillStatus {
  name: string;
  description: string;
  enabled: boolean;
  toolCount: number;
}

export interface SkillStatus {
  name: string;
  description: string;
  enabled: boolean;
  subSkills: SubSkillStatus[];
}

/** Get the full status of a skill and its sub-skills. */
export function getSkillStatus(domain: DomainName): SkillStatus {
  const def = getSkillDefinition(domain);
  const skill = registry.getByName(domain);
  const enabledSubs = new Set(registry.getEnabledSubmodules(domain));

  return {
    name: def.name,
    description: def.description,
    enabled: skill?.enabled === 1,
    subSkills: def.subSkills.map(sub => ({
      name: sub.name,
      description: sub.description,
      enabled: enabledSubs.has(sub.name),
      toolCount: sub.tools.length,
    })),
  };
}

/** Get status of all skills. */
export function getAllSkillStatuses(): SkillStatus[] {
  return (Object.keys(DEFAULT_SKILLS) as DomainName[]).map(getSkillStatus);
}
