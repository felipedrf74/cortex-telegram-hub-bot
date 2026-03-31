// ─── Nexus Hub Skill System — Type Definitions ────────────────────────

// ─── Routing Types ─────────────────────────────────────────────────────

/** A regex or command pattern that routes messages directly to a skill */
export interface PatternRoute {
  /** Regex pattern to match against incoming messages */
  pattern: RegExp;
  /** Optional description for documentation/debugging */
  description?: string;
}

/** A keyword-based route for natural language matching */
export interface KeywordRoute {
  /** Regex pattern matching natural language keywords */
  pattern: RegExp;
  /** Optional description for documentation/debugging */
  description?: string;
}

/** Hints provided to the AI classifier for tier-3 routing */
export interface ClassificationHint {
  /** Short label the classifier uses to identify this skill */
  label: string;
  /** Description of what this skill handles, used as classifier context */
  description: string;
  /** Example messages that should route to this skill */
  examples: string[];
}

// ─── Tool Types ────────────────────────────────────────────────────────

/** A tool definition that a skill exposes to the AI model */
export interface SkillToolDefinition {
  /** Unique tool name (namespaced by skill, e.g. "tri_log_workout") */
  name: string;
  /** Human-readable description shown to the AI model */
  description: string;
  /** JSON Schema for the tool's input parameters */
  inputSchema: Record<string, unknown>;
}

// ─── Response Types ────────────────────────────────────────────────────

/** Response returned by a skill's handle() method */
export interface SkillResponse {
  /** The text response to send back to the user */
  text: string;
  /** ID of the skill that produced this response */
  skillId: string;
  /** Names of tools invoked during handling (for telemetry) */
  toolsUsed?: string[];
}

// ─── Sub-Module Manifest ───────────────────────────────────────────────

/** Describes a toggleable feature within a skill */
export interface SubModuleManifest {
  /** Unique sub-module identifier within the skill (e.g. "garmin-sync") */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this sub-module adds to the skill */
  description: string;
  /** Whether this sub-module is enabled by default on install */
  default: boolean;
  /** Environment variables required for this sub-module to function */
  requiredEnvVars?: string[];
  /** IDs of other sub-modules within the same skill that must be enabled first */
  dependencies?: string[];
}

// ─── Skill Manifest ────────────────────────────────────────────────────

/** Marketplace category for skill discovery */
export type SkillCategory =
  | 'productivity'
  | 'fitness'
  | 'content'
  | 'finance'
  | 'developer'
  | 'lifestyle'
  | 'education'
  | 'other';

/** Distribution tier determining review process and revenue model */
export type SkillTier = 'official' | 'community' | 'private';

/** Pricing model for marketplace distribution */
export interface SkillPricing {
  /** Pricing model type */
  model: 'free' | 'subscription' | 'one-time';
  /** Price in cents (0 for free skills) */
  priceInCents?: number;
  /** Billing period for subscription model */
  billingPeriod?: 'monthly' | 'yearly';
}

/** Complete metadata describing a skill package */
export interface SkillManifest {
  /** Unique skill identifier (e.g. "nexus-triathlon") */
  id: string;
  /** Human-readable skill name */
  name: string;
  /** Semantic version (e.g. "1.2.0") */
  version: string;
  /** Skill author or organization */
  author: string;
  /** SPDX license identifier (e.g. "MIT") */
  license: string;
  /** Short description shown in marketplace */
  description: string;
  /** Required Hub Core semver range (e.g. ">=1.0.0 <2.0.0") */
  hubVersion: string;
  /** Supported messaging platforms */
  platforms: string[];
  /** IDs of other skills this skill depends on */
  dependencies?: string[];
  /** Sub-module definitions for this skill */
  subModules?: SubModuleManifest[];
  /** Marketplace category */
  category: SkillCategory;
  /** Searchable tags for marketplace discovery */
  tags?: string[];
  /** Distribution tier */
  tier: SkillTier;
  /** Pricing configuration (defaults to free) */
  pricing?: SkillPricing;
}

// ─── Skill Config ──────────────────────────────────────────────────────

/** User-configurable settings for an installed skill */
export interface SkillConfig {
  /** The skill this config belongs to */
  skillId: string;
  /** Whether the skill is currently enabled */
  enabled: boolean;
  /** IDs of enabled sub-modules */
  enabledSubModules: string[];
  /** User-provided environment variables / API keys for this skill */
  envVars: Record<string, string>;
  /** Arbitrary user preferences (skill-defined schema) */
  preferences: Record<string, unknown>;
}

// ─── NexusSkill Interface ──────────────────────────────────────────────

/** Context passed to a skill's handle() method */
export interface SkillHandleContext {
  /** The user's Telegram (or platform) ID */
  userId: number;
  /** The raw message text */
  message: string;
  /** Conversation history for this skill */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Current state context (date, todos, etc.) */
  stateContext: string;
  /** The skill's current configuration */
  config: SkillConfig;
}

/**
 * The core interface every Nexus Hub skill must implement.
 *
 * A skill is a self-contained domain of intelligence — the equivalent of
 * an app on a phone. The Hub Core calls these lifecycle and routing methods
 * to integrate the skill into the bot runtime.
 */
export interface NexusSkill {
  /** The skill's manifest metadata */
  readonly manifest: SkillManifest;

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Called once when the skill is first installed.
   * Use for database migrations, initial data seeding, etc.
   */
  install(): Promise<void>;

  /**
   * Called when the skill is enabled (after install or after being disabled).
   * Use for registering cron jobs, starting background tasks, etc.
   */
  enable(): Promise<void>;

  /**
   * Called when the skill is disabled (but not uninstalled).
   * Use for unregistering cron jobs, pausing background tasks, etc.
   */
  disable(): Promise<void>;

  /**
   * Called when the skill is permanently removed.
   * Use for dropping database tables, cleaning up files, etc.
   */
  uninstall(): Promise<void>;

  // ── Routing ────────────────────────────────────────────────────────

  /**
   * Returns regex/command patterns for tier-1 routing.
   * These are checked first (zero cost, exact match).
   */
  getPatternRoutes(): PatternRoute[];

  /**
   * Returns keyword patterns for tier-2 routing.
   * These are checked second (zero cost, NL keyword match).
   */
  getKeywordRoutes(): KeywordRoute[];

  /**
   * Returns hints for the tier-3 AI classifier.
   * Used when pattern and keyword matching both fail.
   */
  getClassificationHints(): ClassificationHint;

  // ── Handling ───────────────────────────────────────────────────────

  /**
   * Main message handler — receives a routed message and returns a response.
   * This is where the skill's AI logic lives.
   */
  handle(ctx: SkillHandleContext): Promise<SkillResponse>;

  // ── Tools ──────────────────────────────────────────────────────────

  /**
   * Returns tool definitions this skill exposes to the AI model.
   * Tools are namespaced by skill ID to avoid collisions.
   */
  getTools(): SkillToolDefinition[];

  /**
   * Executes a tool call by name with the given input.
   * Called by the Hub Core's tool executor when the AI invokes a skill tool.
   */
  executeTool(toolName: string, input: Record<string, unknown>): Promise<unknown>;

  // ── Sub-Modules ────────────────────────────────────────────────────

  /**
   * Returns the manifest entries for all sub-modules in this skill.
   */
  getSubModules(): SubModuleManifest[];

  /**
   * Enables a sub-module by ID.
   * The Hub Core calls this after validating dependencies and env vars.
   */
  enableSubModule(subModuleId: string): Promise<void>;

  /**
   * Disables a sub-module by ID.
   * The Hub Core calls this after checking no other sub-modules depend on it.
   */
  disableSubModule(subModuleId: string): Promise<void>;
}
