// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * /skills — list installed skills with status
 * /skill <name> — detail view for a single skill with sub-module list
 */

import type { Context } from 'grammy';
import { getAllSkillStatuses, getSkillStatus } from '../skills/skill-manager';
import type { SkillStatus, SubSkillStatus } from '../skills/skill-manager';
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

  return msg;
}

// ── Command handlers ─────────────────────────────────────────────

export async function handleSkillsList(ctx: Context): Promise<void> {
  const skills = getAllSkillStatuses();
  const msg = formatSkillsList(skills);
  await ctx.reply(msg, { parse_mode: 'HTML' });
}

export async function handleSkillDetail(ctx: Context): Promise<void> {
  const name = ctx.match?.toString().trim().toLowerCase();

  if (!name) {
    await ctx.reply(
      '<b>Usage:</b> <code>/skill name</code>\n\n' +
      'Use /skills to see all available skill names.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const skill = getSkillStatus(name as any);

  if (!skill) {
    await ctx.reply(
      `❌ Skill "<b>${escapeHtml(name)}</b>" not found.\n\n` +
      'Use /skills to see available skills.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const msg = formatSkillDetail(skill);
  await ctx.reply(msg, { parse_mode: 'HTML' });
}
