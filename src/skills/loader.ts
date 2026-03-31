// ─── SkillLoader — Dynamic Skill Package Loader ────────────────────────
//
// Discovers skill packages from the skills/ directory, validates manifests,
// resolves dependencies, and manages the skill lifecycle (install → enable →
// disable → uninstall). Provides prompt hot-reload per skill.

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import type {
  NexusSkill,
  SkillManifest,
  SkillConfig,
  SkillToolDefinition,
  PatternRoute,
  KeywordRoute,
  ClassificationHint,
} from './types';

// ─── Hub Version (from package.json) ──────────────────────────────────

const HUB_VERSION: string = (() => {
  const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
})();

// ─── Semver Utilities ─────────────────────────────────────────────────

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** Parses a version string like "4.4.1" into its components */
export function parseSemVer(version: string): SemVer | null {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/** Compares two semver versions: -1 if a < b, 0 if equal, 1 if a > b */
function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Checks if `version` satisfies a semver range string.
 * Supports: >=X.Y.Z, <=X.Y.Z, >X.Y.Z, <X.Y.Z, =X.Y.Z, X.Y.Z (exact)
 * Multiple constraints separated by spaces are ANDed.
 * Example: ">=4.0.0 <5.0.0"
 */
export function satisfiesSemVer(version: string, range: string): boolean {
  const ver = parseSemVer(version);
  if (!ver) return false;

  const constraints = range.trim().split(/\s+/);
  for (const constraint of constraints) {
    const match = constraint.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+.*)$/);
    if (!match) return false;

    const operator = match[1] || '=';
    const target = parseSemVer(match[2]);
    if (!target) return false;

    const cmp = compareSemVer(ver, target);
    switch (operator) {
      case '>=': if (cmp < 0) return false; break;
      case '<=': if (cmp > 0) return false; break;
      case '>':  if (cmp <= 0) return false; break;
      case '<':  if (cmp >= 0) return false; break;
      case '=':  if (cmp !== 0) return false; break;
    }
  }
  return true;
}

// ─── Dependency Resolution (Topological Sort) ─────────────────────────

export interface DependencyError {
  skillId: string;
  missingDeps: string[];
}

export interface CycleError {
  cycle: string[];
}

export type ResolveResult =
  | { ok: true; order: string[] }
  | { ok: false; reason: 'missing'; errors: DependencyError[] }
  | { ok: false; reason: 'cycle'; error: CycleError };

/**
 * Resolves load order for skills using Kahn's algorithm (topological sort).
 * Returns an ordered list of skill IDs or an error describing missing
 * dependencies or cycles.
 */
export function resolveDependencies(
  manifests: Map<string, SkillManifest>,
): ResolveResult {
  // Check for missing dependencies first
  const missingErrors: DependencyError[] = [];
  for (const [id, manifest] of manifests) {
    const deps = manifest.dependencies ?? [];
    const missing = deps.filter((dep) => !manifests.has(dep));
    if (missing.length > 0) {
      missingErrors.push({ skillId: id, missingDeps: missing });
    }
  }
  if (missingErrors.length > 0) {
    return { ok: false, reason: 'missing', errors: missingErrors };
  }

  // Kahn's algorithm
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>(); // dep → dependents

  for (const id of manifests.keys()) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const [id, manifest] of manifests) {
    const deps = manifest.dependencies ?? [];
    inDegree.set(id, deps.length);
    for (const dep of deps) {
      adjacency.get(dep)!.push(id);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const dependent of adjacency.get(current)!) {
      const newDegree = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  if (order.length !== manifests.size) {
    // Find cycle: remaining nodes with non-zero in-degree
    const cycle = [...inDegree.entries()]
      .filter(([, degree]) => degree > 0)
      .map(([id]) => id);
    return { ok: false, reason: 'cycle', error: { cycle } };
  }

  return { ok: true, order };
}

// ─── Prompt Hot-Reload (per skill) ────────────────────────────────────

interface PromptCacheEntry {
  content: string;
  mtimeMs: number;
}

const skillPromptCache = new Map<string, PromptCacheEntry>();

/**
 * Loads a prompt file from a skill's directory with mtime-based caching.
 * Returns null if the file doesn't exist.
 */
export function loadSkillPrompt(
  skillDir: string,
  promptName: string,
): string | null {
  const filePath = path.join(skillDir, 'prompts', `${promptName}.md`);
  const cacheKey = filePath;

  try {
    const stat = fs.statSync(filePath);
    const cached = skillPromptCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.content;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    skillPromptCache.set(cacheKey, { content, mtimeMs: stat.mtimeMs });
    return content;
  } catch {
    return null;
  }
}

/** Clears the prompt cache for a specific skill directory */
export function clearSkillPromptCache(skillDir: string): void {
  const prefix = path.join(skillDir, 'prompts');
  for (const key of skillPromptCache.keys()) {
    if (key.startsWith(prefix)) {
      skillPromptCache.delete(key);
    }
  }
}

// ─── Manifest Validation ──────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

const REQUIRED_MANIFEST_FIELDS = [
  'id', 'name', 'version', 'author', 'license',
  'description', 'hubVersion', 'platforms', 'category', 'tier',
] as const;

/** Validates a manifest.json has all required fields and correct types */
export function validateManifest(
  raw: Record<string, unknown>,
): { ok: true; manifest: SkillManifest } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  // Check required fields exist
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (raw[field] === undefined || raw[field] === null) {
      errors.push({ field, message: `missing required field "${field}"` });
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Type checks
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    errors.push({ field: 'id', message: 'must be a non-empty string' });
  }
  if (typeof raw.version !== 'string' || !parseSemVer(raw.version as string)) {
    errors.push({ field: 'version', message: 'must be a valid semver string' });
  }
  if (typeof raw.hubVersion !== 'string') {
    errors.push({ field: 'hubVersion', message: 'must be a string' });
  }
  if (!Array.isArray(raw.platforms)) {
    errors.push({ field: 'platforms', message: 'must be an array' });
  }
  if (raw.dependencies !== undefined && !Array.isArray(raw.dependencies)) {
    errors.push({ field: 'dependencies', message: 'must be an array if present' });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, manifest: raw as unknown as SkillManifest };
}

// ─── SkillLoader ──────────────────────────────────────────────────────

/** Internal state for a loaded skill */
interface LoadedSkill {
  skill: NexusSkill;
  manifest: SkillManifest;
  config: SkillConfig;
  directory: string;
  enabled: boolean;
}

export class SkillLoader {
  private skills = new Map<string, LoadedSkill>();
  private readonly skillsDir: string;
  private readonly hubVersion: string;

  constructor(skillsDir: string, hubVersion?: string) {
    this.skillsDir = skillsDir;
    this.hubVersion = hubVersion ?? HUB_VERSION;
  }

  // ── Discovery & Loading ─────────────────────────────────────────────

  /**
   * Scans the skills directory, validates manifests, resolves dependencies,
   * and loads all valid skill packages in dependency order.
   */
  async loadAll(): Promise<{
    loaded: string[];
    skipped: Array<{ id: string; reason: string }>;
  }> {
    const loaded: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    // Step 1: Discover and validate manifests
    const discovered = this.discoverManifests();
    const validManifests = new Map<string, { manifest: SkillManifest; dir: string }>();

    for (const { manifest, directory, errors } of discovered) {
      if (errors) {
        const id = (manifest as unknown as Record<string, unknown>)?.id as string || directory;
        skipped.push({
          id,
          reason: `invalid manifest: ${errors.map((e) => e.message).join(', ')}`,
        });
        continue;
      }

      // Validate hub version compatibility
      if (!satisfiesSemVer(this.hubVersion, manifest!.hubVersion)) {
        skipped.push({
          id: manifest!.id,
          reason: `incompatible hubVersion: requires ${manifest!.hubVersion}, hub is ${this.hubVersion}`,
        });
        continue;
      }

      validManifests.set(manifest!.id, { manifest: manifest!, dir: directory });
    }

    // Step 2: Resolve dependency order
    const manifestMap = new Map(
      [...validManifests.entries()].map(([id, v]) => [id, v.manifest]),
    );
    const depResult = resolveDependencies(manifestMap);

    if (!depResult.ok) {
      if (depResult.reason === 'missing') {
        for (const err of depResult.errors) {
          skipped.push({
            id: err.skillId,
            reason: `missing dependencies: ${err.missingDeps.join(', ')}`,
          });
          validManifests.delete(err.skillId);
        }
        // Re-resolve without the broken skills
        const remainingManifests = new Map(
          [...validManifests.entries()].map(([id, v]) => [id, v.manifest]),
        );
        const retry = resolveDependencies(remainingManifests);
        if (retry.ok) {
          for (const id of retry.order) {
            const entry = validManifests.get(id)!;
            const result = await this.loadSkill(entry.dir, entry.manifest);
            if (result.ok) {
              loaded.push(id);
            } else {
              skipped.push({ id, reason: result.reason });
            }
          }
        } else {
          logger.error({ result: retry }, 'Skill dependency resolution failed after removing broken skills');
        }
      } else {
        // Cycle detected — skip all skills involved in cycle
        for (const id of depResult.error.cycle) {
          skipped.push({ id, reason: `circular dependency detected` });
        }
        // Load skills not in the cycle
        const cycleSet = new Set(depResult.error.cycle);
        for (const [id, entry] of validManifests) {
          if (!cycleSet.has(id)) {
            const result = await this.loadSkill(entry.dir, entry.manifest);
            if (result.ok) {
              loaded.push(id);
            } else {
              skipped.push({ id, reason: result.reason });
            }
          }
        }
      }
    } else {
      // Happy path: load in dependency order
      for (const id of depResult.order) {
        const entry = validManifests.get(id)!;
        const result = await this.loadSkill(entry.dir, entry.manifest);
        if (result.ok) {
          loaded.push(id);
        } else {
          skipped.push({ id, reason: result.reason });
        }
      }
    }

    logger.info({ loaded: loaded.length, skipped: skipped.length }, 'Skill loading complete');
    return { loaded, skipped };
  }

  /** Scans skillsDir for directories containing manifest.json */
  private discoverManifests(): Array<{
    manifest?: SkillManifest;
    directory: string;
    errors?: ValidationError[];
  }> {
    const results: Array<{
      manifest?: SkillManifest;
      directory: string;
      errors?: ValidationError[];
    }> = [];

    if (!fs.existsSync(this.skillsDir)) {
      logger.info({ skillsDir: this.skillsDir }, 'Skills directory does not exist, creating it');
      fs.mkdirSync(this.skillsDir, { recursive: true });
      return results;
    }

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dir = path.join(this.skillsDir, entry.name);
      const manifestPath = path.join(dir, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        logger.debug({ dir }, 'Skipping directory without manifest.json');
        continue;
      }

      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const validation = validateManifest(raw);
        if (validation.ok) {
          results.push({ manifest: validation.manifest, directory: dir });
        } else {
          results.push({
            manifest: raw,
            directory: dir,
            errors: validation.errors,
          });
        }
      } catch (err) {
        results.push({
          directory: dir,
          errors: [{ field: 'manifest.json', message: `failed to parse: ${(err as Error).message}` }],
        });
      }
    }

    return results;
  }

  /** Loads a single skill module from its directory */
  private async loadSkill(
    directory: string,
    manifest: SkillManifest,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const indexPath = path.join(directory, 'index.js');
      if (!fs.existsSync(indexPath)) {
        return { ok: false, reason: `missing entry point: index.js` };
      }

      // Dynamic require — skill must export a NexusSkill or a factory function
      const skillModule = require(indexPath);
      const skill: NexusSkill =
        typeof skillModule === 'function'
          ? skillModule()
          : typeof skillModule.default === 'function'
            ? skillModule.default()
            : skillModule.default ?? skillModule;

      // Verify the skill implements the NexusSkill interface (duck typing)
      if (typeof skill.handle !== 'function' || typeof skill.install !== 'function') {
        return { ok: false, reason: 'module does not implement NexusSkill interface' };
      }

      const config: SkillConfig = {
        skillId: manifest.id,
        enabled: false,
        enabledSubModules: (manifest.subModules ?? [])
          .filter((sm) => sm.default)
          .map((sm) => sm.id),
        envVars: {},
        preferences: {},
      };

      this.skills.set(manifest.id, {
        skill,
        manifest,
        config,
        directory,
        enabled: false,
      });

      logger.info({ skillId: manifest.id, version: manifest.version }, 'Skill loaded');
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `load error: ${(err as Error).message}` };
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Installs and enables a loaded skill */
  async enableSkill(skillId: string): Promise<void> {
    const entry = this.skills.get(skillId);
    if (!entry) throw new Error(`Skill not found: ${skillId}`);
    if (entry.enabled) return;

    // Ensure dependencies are enabled first
    const deps = entry.manifest.dependencies ?? [];
    for (const depId of deps) {
      const dep = this.skills.get(depId);
      if (!dep || !dep.enabled) {
        throw new Error(`Cannot enable "${skillId}": dependency "${depId}" is not enabled`);
      }
    }

    await entry.skill.install();
    await entry.skill.enable();
    entry.enabled = true;
    entry.config.enabled = true;
    logger.info({ skillId }, 'Skill enabled');
  }

  /** Disables a skill (does not uninstall) */
  async disableSkill(skillId: string): Promise<void> {
    const entry = this.skills.get(skillId);
    if (!entry) throw new Error(`Skill not found: ${skillId}`);
    if (!entry.enabled) return;

    // Ensure no other enabled skills depend on this one
    for (const [id, other] of this.skills) {
      if (id === skillId) continue;
      if (other.enabled && (other.manifest.dependencies ?? []).includes(skillId)) {
        throw new Error(`Cannot disable "${skillId}": skill "${id}" depends on it`);
      }
    }

    await entry.skill.disable();
    entry.enabled = false;
    entry.config.enabled = false;
    logger.info({ skillId }, 'Skill disabled');
  }

  /** Uninstalls a skill completely (removes from registry) */
  async uninstallSkill(skillId: string): Promise<void> {
    const entry = this.skills.get(skillId);
    if (!entry) throw new Error(`Skill not found: ${skillId}`);

    if (entry.enabled) {
      await this.disableSkill(skillId);
    }

    await entry.skill.uninstall();
    clearSkillPromptCache(entry.directory);
    this.skills.delete(skillId);
    logger.info({ skillId }, 'Skill uninstalled');
  }

  // ── Registration Queries ────────────────────────────────────────────

  /** Returns all pattern routes from enabled skills */
  getAllPatternRoutes(): Array<{ skillId: string; routes: PatternRoute[] }> {
    const result: Array<{ skillId: string; routes: PatternRoute[] }> = [];
    for (const [id, entry] of this.skills) {
      if (!entry.enabled) continue;
      const routes = entry.skill.getPatternRoutes();
      if (routes.length > 0) {
        result.push({ skillId: id, routes });
      }
    }
    return result;
  }

  /** Returns all keyword routes from enabled skills */
  getAllKeywordRoutes(): Array<{ skillId: string; routes: KeywordRoute[] }> {
    const result: Array<{ skillId: string; routes: KeywordRoute[] }> = [];
    for (const [id, entry] of this.skills) {
      if (!entry.enabled) continue;
      const routes = entry.skill.getKeywordRoutes();
      if (routes.length > 0) {
        result.push({ skillId: id, routes });
      }
    }
    return result;
  }

  /** Returns all classification hints from enabled skills */
  getAllClassificationHints(): Array<{ skillId: string; hint: ClassificationHint }> {
    const result: Array<{ skillId: string; hint: ClassificationHint }> = [];
    for (const [id, entry] of this.skills) {
      if (!entry.enabled) continue;
      result.push({ skillId: id, hint: entry.skill.getClassificationHints() });
    }
    return result;
  }

  /** Returns all tool definitions from enabled skills */
  getAllTools(): SkillToolDefinition[] {
    const tools: SkillToolDefinition[] = [];
    for (const entry of this.skills.values()) {
      if (!entry.enabled) continue;
      tools.push(...entry.skill.getTools());
    }
    return tools;
  }

  /** Executes a tool call, routing to the correct skill by tool name prefix */
  async executeTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ skillId: string; result: unknown } | null> {
    for (const [id, entry] of this.skills) {
      if (!entry.enabled) continue;
      const skillTools = entry.skill.getTools();
      if (skillTools.some((t) => t.name === toolName)) {
        const result = await entry.skill.executeTool(toolName, input);
        return { skillId: id, result };
      }
    }
    return null;
  }

  // ── Skill Access ────────────────────────────────────────────────────

  /** Gets a loaded skill by ID */
  getSkill(skillId: string): NexusSkill | undefined {
    return this.skills.get(skillId)?.skill;
  }

  /** Gets a loaded skill's manifest */
  getManifest(skillId: string): SkillManifest | undefined {
    return this.skills.get(skillId)?.manifest;
  }

  /** Gets a loaded skill's config */
  getConfig(skillId: string): SkillConfig | undefined {
    return this.skills.get(skillId)?.config;
  }

  /** Returns IDs of all loaded skills */
  getLoadedSkillIds(): string[] {
    return [...this.skills.keys()];
  }

  /** Returns IDs of all enabled skills */
  getEnabledSkillIds(): string[] {
    return [...this.skills.entries()]
      .filter(([, entry]) => entry.enabled)
      .map(([id]) => id);
  }

  /** Gets the directory path for a loaded skill */
  getSkillDirectory(skillId: string): string | undefined {
    return this.skills.get(skillId)?.directory;
  }

  /** Loads a prompt from a skill's prompts/ directory with hot-reload */
  getSkillPrompt(skillId: string, promptName: string): string | null {
    const entry = this.skills.get(skillId);
    if (!entry) return null;
    return loadSkillPrompt(entry.directory, promptName);
  }

  /** Returns the hub version this loader validates against */
  getHubVersion(): string {
    return this.hubVersion;
  }

  /** Returns the number of loaded skills */
  get size(): number {
    return this.skills.size;
  }
}
