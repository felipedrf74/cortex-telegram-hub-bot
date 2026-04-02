// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * defineAgents — fluent builder for autonomous agent definitions.
 *
 * Usage:
 *   const agents = defineAgents()
 *     .agent('daily-digest', 'Send daily recipe suggestions', handler, { schedule: '0 8 * * *' })
 *     .agent('ingredient-watcher', 'Watch for expiring ingredients', handler, { trigger: 'on_schedule' })
 *     .build();
 */

import type { AgentDefinition, AgentHandler, AgentTrigger } from './types';

export class AgentBuilder {
  private _agents: AgentDefinition[] = [];

  agent(
    name: string,
    description: string,
    handler: AgentHandler,
    options?: { schedule?: string; trigger?: AgentTrigger },
  ): this {
    this._agents.push({
      name,
      description,
      handler,
      schedule: options?.schedule,
      trigger: options?.trigger ?? (options?.schedule ? 'on_schedule' : 'manual'),
    });
    return this;
  }

  build(): AgentDefinition[] {
    return [...this._agents];
  }
}

export function defineAgents(): AgentBuilder {
  return new AgentBuilder();
}
