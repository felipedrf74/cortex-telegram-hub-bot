/**
 * Skill manifest and loader types.
 *
 * SkillManifest = what a skill declares (the "package.json").
 * InstalledSkill / SkillSubmodule = what the DB stores (see domains/types.ts).
 */

// ── Manifest ──────────────────────────────────────────────────────

export interface SkillManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  domain?: string;
  dependencies?: string[];              // names of skills this skill requires
  submodules?: SubmoduleDeclaration[];
  requiredApiKeys?: string[];
  config?: Record<string, unknown>;
}

export interface SubmoduleDeclaration {
  module_name: string;
  version?: string;
  enabled_by_default?: boolean;
  dependencies?: string[];              // names of other submodules within the same skill
  config?: Record<string, unknown>;
}

// ── Validation ────────────────────────────────────────────────────

export interface ManifestValidationError {
  field: string;
  message: string;
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: ManifestValidationError[];
}

// ── Dependency Resolution ─────────────────────────────────────────

export interface DependencyNode {
  name: string;
  dependencies: string[];
}

export interface DependencyResolutionResult {
  resolved: boolean;
  order: string[];            // topological install order
  missing: string[];          // dependencies not found
  circular: string[][];       // circular dependency chains
}
