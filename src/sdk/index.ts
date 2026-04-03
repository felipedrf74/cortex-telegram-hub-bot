// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * @nexushub/skill-sdk — NexusHub Skill Development Kit
 *
 * Build custom skills for the NexusHub platform.
 *
 * Quick start:
 *   import { createSkill, defineTools, defineCommands } from '@nexushub/skill-sdk';
 *
 *   const tools = defineTools()
 *     .tool('greet', 'Say hello', { name: { type: 'string', description: 'Name' } }, async (p) => `Hello ${p.name}!`)
 *     .build();
 *
 *   const skill = createSkill({ name: 'hello-world', version: '1.0.0', description: 'A greeting skill' })
 *     .tools(tools)
 *     .routing({ keywords: ['hello', 'greet'] })
 *     .build();
 */

// Builder functions
export { createSkill, SkillBuilder } from './create-skill';
export { defineTools, ToolBuilder } from './define-tools';
export { defineCommands, CommandBuilder } from './define-commands';
export { defineAgents, AgentBuilder } from './define-agents';

// Types
export type {
  // Skill
  SkillConfig,
  NexusSkill,

  // Tools
  ToolDefinition,
  ToolParameter,
  ToolHandler,

  // Commands
  CommandDefinition,
  CommandHandler,
  CommandContext,

  // Agents
  AgentDefinition,
  AgentHandler,
  AgentTrigger,
  AgentContext,

  // Routing
  SkillRouting,

  // Submodules
  SubmoduleConfig,

  // Validation
  ValidationResult,
  ValidationError,
} from './types';
