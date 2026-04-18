// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Skill Loader — manifest validation, dependency resolution, and filesystem loading.
 *
 * Responsibilities:
 * 1. Validate manifest.json before installation
 * 2. Resolve inter-skill dependencies (topological order)
 * 3. Detect circular dependencies
 * 4. Load skill manifest from filesystem
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import type {
  SkillManifest,
  ManifestValidationResult,
  ManifestValidationError,
  DependencyNode,
  DependencyResolutionResult,
} from './types';

// ── Manifest Validation ───────────────────────────────────────────

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Validate a skill manifest. Returns errors for each invalid field. */
export function validateManifest(manifest: unknown): ManifestValidationResult {
  const errors: ManifestValidationError[] = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: [{ field: 'manifest', message: 'Manifest must be a non-null object' }] };
  }

  const m = manifest as Record<string, unknown>;

  // Required: name
  if (typeof m.name !== 'string' || m.name.length === 0) {
    errors.push({ field: 'name', message: 'name is required and must be a non-empty string' });
  } else if (!NAME_RE.test(m.name)) {
    errors.push({ field: 'name', message: 'name must be lowercase alphanumeric with hyphens, starting with a letter' });
  }

  // Required: version
  if (typeof m.version !== 'string' || m.version.length === 0) {
    errors.push({ field: 'version', message: 'version is required and must be a non-empty string' });
  } else if (!SEMVER_RE.test(m.version)) {
    errors.push({ field: 'version', message: 'version must follow semver format (e.g., 1.0.0)' });
  }

  // Optional: description
  if (m.description !== undefined && typeof m.description !== 'string') {
    errors.push({ field: 'description', message: 'description must be a string' });
  }

  // Optional: author
  if (m.author !== undefined && typeof m.author !== 'string') {
    errors.push({ field: 'author', message: 'author must be a string' });
  }

  // Optional: domain
  if (m.domain !== undefined && typeof m.domain !== 'string') {
    errors.push({ field: 'domain', message: 'domain must be a string' });
  }

  // Optional: dependencies
  if (m.dependencies !== undefined) {
    if (!Array.isArray(m.dependencies)) {
      errors.push({ field: 'dependencies', message: 'dependencies must be an array of strings' });
    } else {
      for (let i = 0; i < m.dependencies.length; i++) {
        if (typeof m.dependencies[i] !== 'string') {
          errors.push({ field: `dependencies[${i}]`, message: 'each dependency must be a string' });
        }
      }
    }
  }

  const declaredSubmodules = m.submodules ?? m.subSkills;

  if (m.manifestVersion !== undefined && typeof m.manifestVersion !== 'number') {
    errors.push({ field: 'manifestVersion', message: 'manifestVersion must be a number' });
  }

  // Optional: submodules / subSkills
  if (declaredSubmodules !== undefined) {
    if (!Array.isArray(declaredSubmodules)) {
      errors.push({ field: 'submodules', message: 'submodules/subSkills must be an array' });
    } else {
      const names = new Set<string>();
      for (let i = 0; i < declaredSubmodules.length; i++) {
        const sub = declaredSubmodules[i];
        if (!sub || typeof sub !== 'object') {
          errors.push({ field: `submodules[${i}]`, message: 'each submodule must be an object' });
          continue;
        }
        if (typeof sub.module_name !== 'string' || sub.module_name.length === 0) {
          errors.push({ field: `submodules[${i}].module_name`, message: 'module_name is required' });
        } else if (names.has(sub.module_name)) {
          errors.push({ field: `submodules[${i}].module_name`, message: `duplicate submodule name: ${sub.module_name}` });
        } else {
          names.add(sub.module_name);
        }

        // Validate submodule dependencies reference existing submodule names
        if (sub.dependencies !== undefined) {
          if (!Array.isArray(sub.dependencies)) {
            errors.push({ field: `submodules[${i}].dependencies`, message: 'submodule dependencies must be an array' });
          }
        }
      }

      // Second pass: validate submodule dependency references
      if (Array.isArray(declaredSubmodules)) {
        for (let i = 0; i < declaredSubmodules.length; i++) {
          const sub = declaredSubmodules[i];
          if (sub && Array.isArray(sub.dependencies)) {
            for (const dep of sub.dependencies) {
              if (!names.has(dep)) {
                errors.push({
                  field: `submodules[${i}].dependencies`,
                  message: `submodule "${sub.module_name}" depends on unknown submodule "${dep}"`,
                });
              }
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Dependency Resolution ─────────────────────────────────────────

/**
 * Resolve installation order for a set of skills using topological sort (Kahn's algorithm).
 * Detects missing dependencies and circular dependency chains.
 */
export function resolveDependencies(
  nodes: DependencyNode[],
  available: Set<string>,
): DependencyResolutionResult {
  const missing: string[] = [];
  const order: string[] = [];

  // Build adjacency + in-degree maps
  const nodeMap = new Map<string, DependencyNode>();
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>(); // dependency → dependents

  for (const node of nodes) {
    nodeMap.set(node.name, node);
    inDegree.set(node.name, 0);
    adjList.set(node.name, []);
  }

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      if (!nodeMap.has(dep) && !available.has(dep)) {
        missing.push(dep);
        continue;
      }
      if (nodeMap.has(dep)) {
        adjList.get(dep)!.push(node.name);
        inDegree.set(node.name, (inDegree.get(node.name) || 0) + 1);
      }
      // If dep is in `available`, it's already installed — no edge needed
    }
  }

  if (missing.length > 0) {
    return { resolved: false, order: [], missing: [...new Set(missing)], circular: [] };
  }

  // Kahn's BFS
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const dependent of adjList.get(current) || []) {
      const newDegree = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  // Detect circular dependencies
  const circular: string[][] = [];
  if (order.length < nodes.length) {
    const remaining = nodes
      .filter(n => !order.includes(n.name))
      .map(n => n.name);
    circular.push(remaining);
    return { resolved: false, order: [], missing: [], circular };
  }

  return { resolved: true, order, missing: [], circular: [] };
}

// ── Filesystem Loading ────────────────────────────────────────────

/**
 * Load and validate a skill manifest from a directory.
 * Expects `<skillDir>/manifest.json`.
 */
export function loadManifest(skillDir: string): SkillManifest {
  const manifestPath = path.join(skillDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const raw = fs.readFileSync(manifestPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in manifest: ${manifestPath}`);
  }

  const result = validateManifest(parsed);
  if (!result.valid) {
    const msgs = result.errors.map(e => `${e.field}: ${e.message}`).join('; ');
    throw new Error(`Invalid manifest in ${skillDir}: ${msgs}`);
  }

  logger.info({ skill: (parsed as SkillManifest).name }, 'Manifest loaded');
  const manifest = parsed as SkillManifest;
  if (!manifest.submodules && manifest.subSkills) {
    manifest.submodules = manifest.subSkills;
  }
  return manifest;
}
