// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * /skills — list installed skills with status
 * /skill <name> — detail view for a single skill with sub-module list
 * /skill <name> enable|disable — toggle a whole skill
 * /skill <name> modules — list sub-modules
 * /skill <name> module <sub> enable|disable — toggle a sub-module
 */

import type { Context } from 'grammy';
import {
  getAllSkillStatuses, getSkillStatus,
  enableSkill, disableSkill,
  enableSubSkill, disableSubSkill,
} from '../skills/skill-manager';
import type { SkillStatus, SubSkillStatus } from '../skills/skill-manager';
import {
  getSubSkillDependencies, getSubSkillDependents,
  getSkillDefinition,
} from '../skills/skill-config';
import { isSubmoduleEnabled } from '../skills/registry';
import { escapeHtml } from '../utils/telegram-formatter';

// ── Skill icons (one per built-in domain) ────────────────────────

const SKILL_ICONS: Record<string, string> = {
  secretary: '📋',
  triathlon: '🏋️',
  content: '📹',
  finance: '💰',
  cooking: '🍳',
};

function skillIcon(name: string): string {
  return SKILL_ICONS[name] || '🧩';
}

// ── Formatters (exported for testing) ────────────────────────────

export function formatSkillsList(skills: SkillStatus[]): string {
  if (skills.length === 0) {
    return (
      '<b>🧩 No skills installed</b>\n\n' +
      'Skills are modular capabilities that power your assistant.\n' +
      'Check back after setup — default skills are installed on first boot.'
    );
  }

  let msg = `<b>🧩 Installed Skills (${skills.length})</b>\n\n`;

  for (const skill of skills) {
    const toggle = skill.enabled ? '✅' : '❌';
    const icon = skillIcon(skill.name);
    const enabledSubs = skill.subSkills.filter(s => s.enabled).length;
    const totalSubs = skill.subSkills.length;
    const totalTools = skill.subSkills.reduce((sum, s) => sum + s.toolCount, 0);

    msg += `${toggle} ${icon} <b>${escapeHtml(skill.name)}</b>`;
    msg += ` — ${escapeHtml(skill.description)}\n`;
    msg += `     Modules: ${enabledSubs}/${totalSubs} active · ${totalTools} tools\n\n`;
  }

  msg += '<i>Use</i> <code>/skill name</code> <i>for detail view</i>';
  return msg;
}

export function formatSkillDetail(skill: SkillStatus): string {
  const toggle = skill.enabled ? '✅ Enabled' : '❌ Disabled';
  const icon = skillIcon(skill.name);

  let msg = `${icon} <b>${escapeHtml(skill.name)}</b> — ${toggle}\n`;
  msg += `<i>${escapeHtml(skill.description)}</i>\n\n`;

  if (skill.subSkills.length === 0) {
    msg += 'No sub-modules configured.\n';
    return msg;
  }

  msg += `<b>Sub-modules (${skill.subSkills.length})</b>\n`;
  for (const sub of skill.subSkills) {
    const subToggle = sub.enabled ? '✅' : '❌';
    msg += `${subToggle} <b>${escapeHtml(sub.name)}</b> — ${escapeHtml(sub.description)}`;
    msg += ` (${sub.toolCount} tools)\n`;
  }

  msg += '\n<i>Commands:</i>\n';
  msg += `<code>/skill ${escapeHtml(skill.name)} enable</code> · <code>disable</code>\n`;
  msg += `<code>/skill ${escapeHtml(skill.name)} modules</code>\n`;
  msg += `<code>/skill ${escapeHtml(skill.name)} module &lt;name&gt; enable</code> · <code>disable</code>`;

  return msg;
}

export function formatModulesList(skill: SkillStatus): string {
  const icon = skillIcon(skill.name);
  let msg = `${icon} <b>${escapeHtml(skill.name)}</b> — Sub-modules\n\n`;

  if (skill.subSkills.length === 0) {
    msg += 'No sub-modules configured.\n';
    return msg;
  }

  for (const sub of skill.subSkills) {
    const subToggle = sub.enabled ? '✅' : '❌';
    const deps = getSubSkillDependencies(skill.name, sub.name);
    msg += `${subToggle} <b>${escapeHtml(sub.name)}</b> — ${escapeHtml(sub.description)}`;
    msg += ` (${sub.toolCount} tools)`;
    if (deps.length > 0) {
      msg += `\n     Requires: ${deps.map(d => escapeHtml(d)).join(', ')}`;
    }
    msg += '\n';
  }

  msg += `\n<i>Toggle:</i> <code>/skill ${escapeHtml(skill.name)} module &lt;name&gt; enable|disable</code>`;
  return msg;
}

export function formatToggleResult(
  target: string,
  action: 'enabled' | 'disabled',
  isModule: boolean,
  parentSkill?: string,
): string {
  const icon = action === 'enabled' ? '✅' : '❌';
  const type = isModule ? 'Module' : 'Skill';
  let msg = `${icon} ${type} <b>${escapeHtml(target)}</b> ${action}`;
  if (isModule && parentSkill) {
    msg += ` in <b>${escapeHtml(parentSkill)}</b>`;
  }
  return msg;
}

// ── Dependency validation ────────────────────────────────────────

export interface DependencyCheckResult {
  ok: boolean;
  missing?: string[];      // for enable: deps that aren't enabled
  dependents?: string[];   // for disable: modules that depend on this one
}

export function checkEnableDependencies(
  skillName: string,
  moduleName: string,
): DependencyCheckResult {
  const deps = getSubSkillDependencies(skillName, moduleName);
  if (deps.length === 0) return { ok: true };

  const missing = deps.filter(dep => !isSubmoduleEnabled(skillName, dep));
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true };
}

export function checkDisableDependents(
  skillName: string,
  moduleName: string,
): DependencyCheckResult {
  const dependents = getSubSkillDependents(skillName, moduleName);
  if (dependents.length === 0) return { ok: true };

  const activeDependents = dependents.filter(dep => isSubmoduleEnabled(skillName, dep));
  if (activeDependents.length > 0) return { ok: false, dependents: activeDependents };
  return { ok: true };
}

export function formatDependencyError(
  action: 'enable' | 'disable',
  moduleName: string,
  check: DependencyCheckResult,
): string {
  if (action === 'enable' && check.missing?.length) {
    return (
      `⚠️ Cannot enable <b>${escapeHtml(moduleName)}</b> — ` +
      `requires: ${check.missing.map(d => `<b>${escapeHtml(d)}</b>`).join(', ')}\n\n` +
      '<i>Enable the required modules first.</i>'
    );
  }
  if (action === 'disable' && check.dependents?.length) {
    return (
      `⚠️ Cannot disable <b>${escapeHtml(moduleName)}</b> — ` +
      `depended on by: ${check.dependents.map(d => `<b>${escapeHtml(d)}</b>`).join(', ')}\n\n` +
      '<i>Disable the dependent modules first.</i>'
    );
  }
  return '';
}

// ── Command handlers ─────────────────────────────────────────────

export async function handleSkillsList(ctx: Context): Promise<void> {
  const skills = getAllSkillStatuses();
  const msg = formatSkillsList(skills);
  await ctx.reply(msg, { parse_mode: 'HTML' });
}

/** Parse /skill arguments into structured parts. */
export function parseSkillArgs(raw: string): {
  skillName: string;
  action?: string;
  subName?: string;
  subAction?: string;
} {
  const parts = raw.trim().toLowerCase().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return { skillName: '' };

  const skillName = parts[0];
  const action = parts[1]; // enable | disable | modules | module

  if (action === 'module' && parts.length >= 3) {
    return {
      skillName,
      action: 'module',
      subName: parts[2],
      subAction: parts[3], // enable | disable
    };
  }

  return { skillName, action };
}

export async function handleSkillCommand(ctx: Context): Promise<void> {
  const raw = ctx.match?.toString().trim() ?? '';
  const { skillName, action, subName, subAction } = parseSkillArgs(raw);

  if (!skillName) {
    await ctx.reply(
      '<b>Usage:</b>\n' +
      '<code>/skill name</code> — detail view\n' +
      '<code>/skill name enable|disable</code> — toggle skill\n' +
      '<code>/skill name modules</code> — list sub-modules\n' +
      '<code>/skill name module sub enable|disable</code> — toggle sub-module\n\n' +
      'Use /skills to see all available skill names.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Check if the skill definition exists — getSkillStatus always returns an object,
  // so we check the definition registry to detect unknown skill names.
  const def = getSkillDefinition(skillName);
  if (!def) {
    await ctx.reply(
      `❌ Skill "<b>${escapeHtml(skillName)}</b>" not found.\n\n` +
      'Use /skills to see available skills.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const skill = getSkillStatus(skillName as any);

  // /skill <name> — detail view (no action)
  if (!action) {
    const msg = formatSkillDetail(skill);
    await ctx.reply(msg, { parse_mode: 'HTML' });
    return;
  }

  // /skill <name> enable
  if (action === 'enable') {
    const result = enableSkill(skillName as any);
    const msg = result
      ? formatToggleResult(skillName, 'enabled', false)
      : `⚠️ Could not enable <b>${escapeHtml(skillName)}</b> — it may already be enabled.`;
    await ctx.reply(msg, { parse_mode: 'HTML' });
    return;
  }

  // /skill <name> disable
  if (action === 'disable') {
    const result = disableSkill(skillName as any);
    const msg = result
      ? formatToggleResult(skillName, 'disabled', false)
      : `⚠️ Could not disable <b>${escapeHtml(skillName)}</b> — it may already be disabled.`;
    await ctx.reply(msg, { parse_mode: 'HTML' });
    return;
  }

  // /skill <name> modules
  if (action === 'modules') {
    const msg = formatModulesList(skill);
    await ctx.reply(msg, { parse_mode: 'HTML' });
    return;
  }

  // /skill <name> module <sub> enable|disable
  if (action === 'module') {
    if (!subName) {
      await ctx.reply(
        '<b>Usage:</b> <code>/skill ' + escapeHtml(skillName) + ' module &lt;name&gt; enable|disable</code>\n\n' +
        `Use <code>/skill ${escapeHtml(skillName)} modules</code> to see available sub-modules.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Verify the sub-module exists in the skill definition
    const def = getSkillDefinition(skillName);
    const subExists = def?.subSkills.some(s => s.name === subName);
    if (!subExists) {
      await ctx.reply(
        `❌ Module "<b>${escapeHtml(subName)}</b>" not found in <b>${escapeHtml(skillName)}</b>.\n\n` +
        `Use <code>/skill ${escapeHtml(skillName)} modules</code> to see available sub-modules.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (subAction === 'enable') {
      // Check dependencies before enabling
      const depCheck = checkEnableDependencies(skillName, subName);
      if (!depCheck.ok) {
        await ctx.reply(formatDependencyError('enable', subName, depCheck), { parse_mode: 'HTML' });
        return;
      }
      const result = enableSubSkill(skillName as any, subName);
      const msg = result
        ? formatToggleResult(subName, 'enabled', true, skillName)
        : `⚠️ Could not enable module <b>${escapeHtml(subName)}</b>.`;
      await ctx.reply(msg, { parse_mode: 'HTML' });
      return;
    }

    if (subAction === 'disable') {
      // Check dependents before disabling
      const depCheck = checkDisableDependents(skillName, subName);
      if (!depCheck.ok) {
        await ctx.reply(formatDependencyError('disable', subName, depCheck), { parse_mode: 'HTML' });
        return;
      }
      const result = disableSubSkill(skillName as any, subName);
      const msg = result
        ? formatToggleResult(subName, 'disabled', true, skillName)
        : `⚠️ Could not disable module <b>${escapeHtml(subName)}</b>.`;
      await ctx.reply(msg, { parse_mode: 'HTML' });
      return;
    }

    // Invalid sub-action
    await ctx.reply(
      `<b>Usage:</b> <code>/skill ${escapeHtml(skillName)} module ${escapeHtml(subName)} enable|disable</code>`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Unknown action
  await ctx.reply(
    `❌ Unknown action "<b>${escapeHtml(action)}</b>".\n\n` +
    'Valid actions: <code>enable</code>, <code>disable</code>, <code>modules</code>, <code>module &lt;name&gt; enable|disable</code>',
    { parse_mode: 'HTML' },
  );
}
