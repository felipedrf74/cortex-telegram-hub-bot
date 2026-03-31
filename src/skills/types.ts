/**
 * Skill system types — defines the manifest schema and loaded skill structures.
 */

/** Tool definition matching Anthropic's tool schema. */
export interface SkillToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Command registration for the Telegram bot. */
export interface SkillCommand {
  command: string;
  description: string;
  handler: string;   // relative path to handler module within skill dir
}

/** Agent registration for the agent mesh. */
export interface SkillAgent {
  name: string;
  description: string;
  handler: string;   // relative path to agent module within skill dir
  schedule?: string;  // cron expression (optional)
}

/** Prompt file declaration for hot-reload. */
export interface SkillPrompt {
  name: string;
  file: string;   // relative path to .md file within skill dir
}

/**
 * manifest.json schema — every skill package must have this at its root.
 */
export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  hubVersion: string;       // semver range, e.g. ">=4.0.0"
  dependencies?: string[];  // names of other skills this one requires
  commands?: SkillCommand[];
  tools?: SkillToolDefinition[];
  agents?: SkillAgent[];
  prompts?: SkillPrompt[];
}

/** A fully resolved and loaded skill. */
export interface LoadedSkill {
  manifest: SkillManifest;
  directory: string;         // absolute path to the skill directory
  loadedAt: Date;
}

/** Result of a skill loading attempt. */
export interface SkillLoadResult {
  success: boolean;
  skill?: LoadedSkill;
  error?: string;
}
