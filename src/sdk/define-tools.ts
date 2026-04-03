// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * defineTools — fluent builder for tool definitions.
 *
 * Usage:
 *   const tools = defineTools()
 *     .tool('add_recipe', 'Add a new recipe', { name: { type: 'string', description: 'Recipe name' } }, handler)
 *     .tool('delete_recipe', 'Delete a recipe', { id: { type: 'number', description: 'Recipe ID' } }, handler)
 *     .build();
 */

import type { ToolDefinition, ToolParameter, ToolHandler } from './types';

export class ToolBuilder {
  private _tools: ToolDefinition[] = [];

  tool(
    name: string,
    description: string,
    parameters: Record<string, ToolParameter>,
    handler: ToolHandler,
    required?: string[],
  ): this {
    this._tools.push({ name, description, parameters, handler, required });
    return this;
  }

  build(): ToolDefinition[] {
    return [...this._tools];
  }
}

export function defineTools(): ToolBuilder {
  return new ToolBuilder();
}
