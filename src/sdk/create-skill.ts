// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * createSkill — main entry point for building a NexusHub skill.
 *
 * Usage:
 *   const skill = createSkill({
 *     name: 'my-skill',
 *     version: '1.0.0',
 *     description: 'My awesome skill',
 *   })
 *     .tools(myTools)
 *     .commands(myCommands)
 *     .agents(myAgents)
 *     .submodules([
 *       { name: 'core', description: 'Core features', tools: ['my_tool'], enabledByDefault: true },
 *     ])
 *     .routing({ commands: ['/myskill'], keywords: ['my skill'], classificationHint: { ... } })
 *     .build();
 */

import type {
  SkillConfig, NexusSkill, ToolDefinition, CommandDefinition,
  AgentDefinition, SubmoduleConfig, SkillRouting,
  ValidationResult, ValidationError,
} from './types';

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export class SkillBuilder {
  private _config: SkillConfig;
  private _tools: ToolDefinition[] = [];
  private _commands: CommandDefinition[] = [];
  private _agents: AgentDefinition[] = [];
  private _submodules: SubmoduleConfig[] = [];
  private _routing: SkillRouting = {};

  constructor(config: SkillConfig) {
    this._config = config;
  }

  tools(tools: ToolDefinition[]): this {
    this._tools = tools;
    return this;
  }

  commands(commands: CommandDefinition[]): this {
    this._commands = commands;
    return this;
  }

  agents(agents: AgentDefinition[]): this {
    this._agents = agents;
    return this;
  }

  submodules(submodules: SubmoduleConfig[]): this {
    this._submodules = submodules;
    return this;
  }

  routing(routing: SkillRouting): this {
    this._routing = routing;
    return this;
  }

  /** Validate the skill configuration without building. */
  validate(): ValidationResult {
    const errors: ValidationError[] = [];

    // Config validation
    if (!this._config.name || !NAME_RE.test(this._config.name)) {
      errors.push({ field: 'name', message: 'name must be lowercase alphanumeric with hyphens, starting with a letter' });
    }
    if (!this._config.version || !SEMVER_RE.test(this._config.version)) {
      errors.push({ field: 'version', message: 'version must follow semver format (e.g., 1.0.0)' });
    }
    if (!this._config.description) {
      errors.push({ field: 'description', message: 'description is required' });
    }

    // Tool name uniqueness
    const toolNames = new Set<string>();
    for (const tool of this._tools) {
      if (!tool.name) {
        errors.push({ field: 'tools', message: 'each tool must have a name' });
      } else if (toolNames.has(tool.name)) {
        errors.push({ field: 'tools', message: `duplicate tool name: ${tool.name}` });
      } else {
        toolNames.add(tool.name);
      }
      if (!tool.handler) {
        errors.push({ field: `tools.${tool.name}`, message: 'handler is required' });
      }
    }

    // Command name uniqueness
    const commandNames = new Set<string>();
    for (const cmd of this._commands) {
      if (!cmd.name) {
        errors.push({ field: 'commands', message: 'each command must have a name' });
      } else if (commandNames.has(cmd.name)) {
        errors.push({ field: 'commands', message: `duplicate command name: ${cmd.name}` });
      } else {
        commandNames.add(cmd.name);
      }
    }

    // Submodule validation
    const subNames = new Set<string>();
    for (const sub of this._submodules) {
      if (!sub.name) {
        errors.push({ field: 'submodules', message: 'each submodule must have a name' });
      } else if (subNames.has(sub.name)) {
        errors.push({ field: 'submodules', message: `duplicate submodule name: ${sub.name}` });
      } else {
        subNames.add(sub.name);
      }

      // Verify tools referenced in submodules actually exist
      for (const toolName of sub.tools) {
        if (!toolNames.has(toolName)) {
          errors.push({
            field: `submodules.${sub.name}.tools`,
            message: `references unknown tool: ${toolName}`,
          });
        }
      }

      // Verify submodule dependencies reference existing submodules
      if (sub.dependencies) {
        for (const dep of sub.dependencies) {
          if (!subNames.has(dep) && !this._submodules.some(s => s.name === dep)) {
            errors.push({
              field: `submodules.${sub.name}.dependencies`,
              message: `depends on unknown submodule: ${dep}`,
            });
          }
        }
      }
    }

    // Agent validation
    const agentNames = new Set<string>();
    for (const agent of this._agents) {
      if (!agent.name) {
        errors.push({ field: 'agents', message: 'each agent must have a name' });
      } else if (agentNames.has(agent.name)) {
        errors.push({ field: 'agents', message: `duplicate agent name: ${agent.name}` });
      } else {
        agentNames.add(agent.name);
      }
      if (agent.trigger === 'on_schedule' && !agent.schedule) {
        errors.push({
          field: `agents.${agent.name}`,
          message: 'scheduled agents must have a cron expression in schedule',
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /** Build and validate the skill. Throws if validation fails. */
  build(): NexusSkill {
    const result = this.validate();
    if (!result.valid) {
      const msgs = result.errors.map(e => `${e.field}: ${e.message}`).join('\n  ');
      throw new Error(`Invalid skill configuration:\n  ${msgs}`);
    }

    return {
      config: { ...this._config },
      tools: [...this._tools],
      commands: [...this._commands],
      agents: [...this._agents],
      submodules: this._submodules.map(s => ({
        ...s,
        enabledByDefault: s.enabledByDefault ?? true,
      })),
      routing: { ...this._routing },
    };
  }
}

/** Create a new NexusHub skill. Returns a SkillBuilder for chained configuration. */
export function createSkill(config: SkillConfig): SkillBuilder {
  return new SkillBuilder(config);
}
