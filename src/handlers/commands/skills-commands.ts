// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Skills command handlers — extracted from bot.ts.
 *
 * Registers: /skills, /skill
 */

import { Bot } from 'grammy';
import { handleSkillsList, handleSkillCommand } from '../../commands/skills';

export function registerSkillCommands(bot: Bot): void {
  bot.command('skills', async (ctx) => {
    await handleSkillsList(ctx);
  });

  bot.command('skill', async (ctx) => {
    await handleSkillCommand(ctx);
  });
}
