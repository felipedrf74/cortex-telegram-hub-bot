/**
 * SkillLoader — dynamically loads skill packages from the skills/ directory.
 *
 * Each skill is a directory containing a manifest.json that declares:
 * - hubVersion compatibility (semver range)
 * - dependencies on other skills
 * - commands, tools, agents, and prompts to register
 *
 * Prompts use mtime-based hot-reload (same pattern as prompt-loader.ts).
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import type {
  SkillManifest,
  LoadedSkill,
  SkillLoadResult,
  SkillPrompt,
} from './types';

// ── Module state ───────────────────────────────────────────────────
const loadedSkills = new Map<string, LoadedSkill>();

interface PromptCacheEntry {
  content: string;
  mtimeMs: number;
}
const promptCache = new Map<string, PromptCacheEntry>();

let skillsDir: string | null = null;

// ── Public API ─────────────────────────────────────────────────────

/**
 * Initializes the skill loader. Scans the skills directory, validates
 * manifests, resolves dependency order, and loads all valid skills.
 *
 * @param baseDir - Optional override for skills directory (useful for testing).
 *                  Defaults to <project-root>/skills/
 * @returns Array of load results for each discovered skill.
 */
export function initSkillLoader(baseDir?: string): SkillLoadResult[] {
  skillsDir = baseDir ?? path.resolve(__dirname, '..', '..', 'skills');

  if (!fs.existsSync(skillsDir)) {
    logger.info({ skillsDir }, 'Skills directory not found — no skills to load');
    return [];
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  if (dirs.length === 0) {
    logger.info('No skill packages found');
    return [];
  }

  // Phase 1: Read and validate all manifests
  const manifests = new Map<string, { manifest: SkillManifest; dir: string }>();
  const results: SkillLoadResult[] = [];

  for (const dir of dirs) {
    const fullDir = path.join(skillsDir, dir);
    const result = readManifest(fullDir);
    if (!result.success || !result.manifest) {
      results.push({ success: false, error: result.error });
      continue;
    }
    manifests.set(result.manifest.name, { manifest: result.manifest, dir: fullDir });
  }

  // Phase 2: Resolve dependency order (topological sort)
  const sortResult = resolveDependencyOrder(manifests);
  if (!sortResult.success) {
    results.push({ success: false, error: sortResult.error });
    return results;
  }

  // Phase 3: Load skills in dependency order
  const hubVersion = getHubVersion();

  for (const name of sortResult.order!) {
    const entry = manifests.get(name)!;
    const loadResult = loadSkill(entry.manifest, entry.dir, hubVersion);
    results.push(loadResult);
  }

  logger.info(
    { loaded: loadedSkills.size, total: dirs.length },
    'Skill loading complete'
  );
  return results;
}

/** Returns all currently loaded skills. */
export function getLoadedSkills(): ReadonlyMap<string, LoadedSkill> {
  return loadedSkills;
}

/** Returns a specific loaded skill by name, or undefined. */
export function getSkill(name: string): LoadedSkill | undefined {
  return loadedSkills.get(name);
}

/**
 * Loads a prompt from a skill with mtime-based hot-reload.
 * Returns the file content, re-reading only when the file changes on disk.
 */
export function loadSkillPrompt(skillName: string, promptName: string): string | null {
  const skill = loadedSkills.get(skillName);
  if (!skill) return null;

  const promptDef = skill.manifest.prompts?.find((p) => p.name === promptName);
  if (!promptDef) return null;

  const filePath = path.join(skill.directory, promptDef.file);
  return readPromptWithCache(filePath, `${skillName}:${promptName}`);
}

/** Unloads all skills and clears caches. Useful for testing and shutdown. */
export function unloadAllSkills(): void {
  loadedSkills.clear();
  promptCache.clear();
  skillsDir = null;
}

// ── Internal helpers ───────────────────────────────────────────────

interface ManifestReadResult {
  success: boolean;
  manifest?: SkillManifest;
  error?: string;
}

function readManifest(dir: string): ManifestReadResult {
  const manifestPath = path.join(dir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    const err = `No manifest.json in ${path.basename(dir)}`;
    logger.warn({ dir }, err);
    return { success: false, error: err };
  }

  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const validation = validateManifest(parsed, dir);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    return { success: true, manifest: parsed as SkillManifest };
  } catch (err: unknown) {
    const message = `Failed to parse manifest.json in ${path.basename(dir)}: ${(err as Error).message}`;
    logger.error({ dir, err }, message);
    return { success: false, error: message };
  }
}

interface ValidationResult {
  valid: boolean;
  error?: string;
}

function validateManifest(obj: unknown, dir: string): ValidationResult {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, error: `Invalid manifest in ${path.basename(dir)}: not an object` };
  }

  const m = obj as Record<string, unknown>;
  const dirName = path.basename(dir);

  // Required string fields
  for (const field of ['name', 'version', 'description', 'hubVersion']) {
    if (typeof m[field] !== 'string' || (m[field] as string).trim() === '') {
      return { valid: false, error: `Manifest in ${dirName} missing required field: ${field}` };
    }
  }

  // Optional arrays
  if (m.dependencies !== undefined && !Array.isArray(m.dependencies)) {
    return { valid: false, error: `Manifest in ${dirName}: dependencies must be an array` };
  }

  if (m.commands !== undefined && !Array.isArray(m.commands)) {
    return { valid: false, error: `Manifest in ${dirName}: commands must be an array` };
  }

  if (m.tools !== undefined && !Array.isArray(m.tools)) {
    return { valid: false, error: `Manifest in ${dirName}: tools must be an array` };
  }

  if (m.agents !== undefined && !Array.isArray(m.agents)) {
    return { valid: false, error: `Manifest in ${dirName}: agents must be an array` };
  }

  if (m.prompts !== undefined) {
    if (!Array.isArray(m.prompts)) {
      return { valid: false, error: `Manifest in ${dirName}: prompts must be an array` };
    }
    // Validate prompt files exist
    for (const p of m.prompts as SkillPrompt[]) {
      if (!p.name || !p.file) {
        return { valid: false, error: `Manifest in ${dirName}: prompt entries require name and file` };
      }
      const promptPath = path.join(dir, p.file);
      if (!fs.existsSync(promptPath)) {
        return { valid: false, error: `Manifest in ${dirName}: prompt file not found: ${p.file}` };
      }
    }
  }

  return { valid: true };
}

/** Reads the hub version from package.json. */
function getHubVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Checks if the current hub version satisfies the skill's hubVersion range.
 * Supports: exact ("4.4.1"), gte (">=4.0.0"), caret ("^4.0.0"), wildcard ("*").
 */
export function isVersionCompatible(hubVersion: string, requiredRange: string): boolean {
  const range = requiredRange.trim();

  if (range === '*') return true;

  const [hubMajor, hubMinor, hubPatch] = parseVersion(hubVersion);

  if (range.startsWith('>=')) {
    const [rMajor, rMinor, rPatch] = parseVersion(range.slice(2));
    return compareVersions([hubMajor, hubMinor, hubPatch], [rMajor, rMinor, rPatch]) >= 0;
  }

  if (range.startsWith('^')) {
    const [rMajor, rMinor, rPatch] = parseVersion(range.slice(1));
    if (hubMajor !== rMajor) return false;
    return compareVersions([hubMajor, hubMinor, hubPatch], [rMajor, rMinor, rPatch]) >= 0;
  }

  // Exact match
  const [rMajor, rMinor, rPatch] = parseVersion(range);
  return hubMajor === rMajor && hubMinor === rMinor && hubPatch === rPatch;
}

function parseVersion(v: string): [number, number, number] {
  const parts = v.replace(/^[^\d]*/, '').split('.').map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

interface SortResult {
  success: boolean;
  order?: string[];
  error?: string;
}

/**
 * Topological sort of skills by dependency graph.
 * Detects circular dependencies and missing dependencies.
 */
function resolveDependencyOrder(
  manifests: Map<string, { manifest: SkillManifest; dir: string }>
): SortResult {
  const names = new Set(manifests.keys());
  const visited = new Set<string>();
  const visiting = new Set<string>();  // cycle detection
  const order: string[] = [];

  function visit(name: string): string | null {
    if (visited.has(name)) return null;
    if (visiting.has(name)) return `Circular dependency detected involving: ${name}`;

    const entry = manifests.get(name);
    if (!entry) return `Missing dependency: ${name}`;

    visiting.add(name);

    for (const dep of entry.manifest.dependencies ?? []) {
      if (!names.has(dep)) {
        return `Skill "${name}" depends on "${dep}" which is not installed`;
      }
      const err = visit(dep);
      if (err) return err;
    }

    visiting.delete(name);
    visited.add(name);
    order.push(name);
    return null;
  }

  for (const name of names) {
    const err = visit(name);
    if (err) {
      logger.error({ error: err }, 'Dependency resolution failed');
      return { success: false, error: err };
    }
  }

  return { success: true, order };
}

function loadSkill(
  manifest: SkillManifest,
  dir: string,
  hubVersion: string
): SkillLoadResult {
  // Check version compatibility
  if (!isVersionCompatible(hubVersion, manifest.hubVersion)) {
    const err = `Skill "${manifest.name}" requires hub ${manifest.hubVersion}, current is ${hubVersion}`;
    logger.warn({ skill: manifest.name, required: manifest.hubVersion, current: hubVersion }, err);
    return { success: false, error: err };
  }

  // Check all dependencies are loaded
  for (const dep of manifest.dependencies ?? []) {
    if (!loadedSkills.has(dep)) {
      const err = `Skill "${manifest.name}" depends on "${dep}" which failed to load`;
      logger.warn({ skill: manifest.name, dependency: dep }, err);
      return { success: false, error: err };
    }
  }

  // Pre-warm prompt cache for any declared prompts
  for (const prompt of manifest.prompts ?? []) {
    const filePath = path.join(dir, prompt.file);
    readPromptWithCache(filePath, `${manifest.name}:${prompt.name}`);
  }

  const loaded: LoadedSkill = {
    manifest,
    directory: dir,
    loadedAt: new Date(),
  };

  loadedSkills.set(manifest.name, loaded);
  logger.info(
    { skill: manifest.name, version: manifest.version,
      commands: manifest.commands?.length ?? 0,
      tools: manifest.tools?.length ?? 0,
      agents: manifest.agents?.length ?? 0,
      prompts: manifest.prompts?.length ?? 0 },
    'Skill loaded'
  );

  return { success: true, skill: loaded };
}

function readPromptWithCache(filePath: string, cacheKey: string): string {
  try {
    const stat = fs.statSync(filePath);
    const cached = promptCache.get(cacheKey);

    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.content;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    promptCache.set(cacheKey, { content, mtimeMs: stat.mtimeMs });
    return content;
  } catch (err: unknown) {
    logger.error({ filePath, err }, 'Failed to read skill prompt');
    return '';
  }
}
