// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * defineCommands — fluent builder for slash command definitions.
 *
 * Usage:
 *   const commands = defineCommands()
 *     .command('recipe', 'Search or add recipes', handler)
 *     .command('mealplan', 'Show weekly meal plan', handler, { aliases: ['meal', 'meals'] })
 *     .build();
 */

import type { CommandDefinition, CommandHandler } from './types';

export class CommandBuilder {
  private _commands: CommandDefinition[] = [];

  command(
    name: string,
    description: string,
    handler: CommandHandler,
    options?: { aliases?: string[] },
  ): this {
    this._commands.push({
      name,
      description,
      handler,
      aliases: options?.aliases,
    });
    return this;
  }

  build(): CommandDefinition[] {
    return [...this._commands];
  }
}

export function defineCommands(): CommandBuilder {
  return new CommandBuilder();
}
