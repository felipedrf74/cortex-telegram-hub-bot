// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * @nexushub/skill-sdk — Public types for skill developers.
 *
 * These types define the surface area of a NexusHub skill.
 * Third-party developers use these to build skills that integrate
 * with the NexusHub platform.
 */

// ── Tool Definition ─────────────────────────────────────────────

export interface ToolParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  required?: string[];
  handler: ToolHandler;
}

export type ToolHandler = (params: Record<string, unknown>) => Promise<string> | string;

// ── Command Definition ──────────────────────────────────────────

export interface CommandDefinition {
  name: string;                       // e.g. "recipe" → user types /recipe
  description: string;
  aliases?: string[];                 // e.g. ["cook", "meal"]
  handler: CommandHandler;
}

export type CommandHandler = (args: string, ctx: CommandContext) => Promise<string> | string;

export interface CommandContext {
  userId: number;
  chatId: number;
  reply: (text: string) => Promise<void>;
}

// ── Agent Definition ────────────────────────────────────────────

export interface AgentDefinition {
  name: string;
  description: string;
  schedule?: string;                  // cron expression, e.g. "0 9 * * *"
  trigger?: AgentTrigger;
  handler: AgentHandler;
}

export type AgentTrigger = 'on_message' | 'on_tool_result' | 'on_schedule' | 'manual';

export type AgentHandler = (ctx: AgentContext) => Promise<string | void>;

export interface AgentContext {
  skillName: string;
  agentName: string;
  trigger: AgentTrigger;
  data?: Record<string, unknown>;
}

// ── Routing ─────────────────────────────────────────────────────

export interface SkillRouting {
  commands?: string[];                // slash commands e.g. ["/recipe", "/cook"]
  keywords?: string[];                // NL keywords e.g. ["recipes", "cooking"]
  classificationHint?: {
    description: string;              // what this skill handles
    examples: string[];               // example user messages
  };
}

// ── Sub-module ──────────────────────────────────────────────────

export interface SubmoduleConfig {
  name: string;
  description: string;
  tools: string[];                    // tool names defined in this skill
  enabledByDefault?: boolean;         // default: true
  dependencies?: string[];            // other submodule names within this skill
}

// ── Skill Manifest (SDK-friendly) ───────────────────────────────

export interface SkillConfig {
  name: string;
  version: string;
  description: string;
  author?: string;
  dependencies?: string[];            // other skill names required
  requiredApiKeys?: string[];
}

// ── Built Skill (output of createSkill) ─────────────────────────

export interface NexusSkill {
  config: SkillConfig;
  tools: ToolDefinition[];
  commands: CommandDefinition[];
  agents: AgentDefinition[];
  submodules: SubmoduleConfig[];
  routing: SkillRouting;
}

// ── Validation ──────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}
