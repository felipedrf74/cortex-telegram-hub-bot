// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Prompt Loader — reads .md prompt files from the prompts/ directory
 * with mtime-based caching so files are only re-read when changed on disk.
 */
import fs from 'fs';
import path from 'path';

const PROMPTS_DIR = path.resolve(__dirname, '..', '..', 'prompts');

interface CacheEntry {
  content: string;
  mtimeMs: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Returns the absolute path for a named prompt file.
 */
export function getPromptPath(name: string): string {
  return path.join(PROMPTS_DIR, `${name}.md`);
}

/**
 * Loads a prompt from prompts/<name>.md with mtime-based caching.
 * Re-reads the file only when its modification time changes.
 */
export function loadPrompt(name: string): string {
  const filePath = getPromptPath(name);
  const stat = fs.statSync(filePath);
  const cached = cache.get(name);

  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.content;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  cache.set(name, { content, mtimeMs: stat.mtimeMs });
  return content;
}

/**
 * Loads a prompt and replaces {{KEY}} template markers with provided values.
 * Markers not present in `vars` are replaced with an empty string.
 */
export function loadPromptWithVars(name: string, vars: Record<string, string>): string {
  let content = loadPrompt(name);
  for (const [key, value] of Object.entries(vars)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  // Remove any remaining unreplaced markers (clean up unused optionals)
  content = content.replace(/\{\{[A-Z_]+\}\}\n?/g, '');
  return content;
}

/**
 * Load the canonical creator-config.md and return its content.
 * This is the SINGLE source of truth for creator identity, voice,
 * worldview, SFX/EDIT library, content accuracy rules, and output format.
 *
 * Content prompts (content.md, topic-generation.md) reference this via
 * the {{CREATOR_CONFIG}} placeholder.
 */
export function loadCreatorConfig(): string {
  return loadPrompt('creator-config');
}

/**
 * Load a prompt with automatic creator config injection.
 * If the prompt contains {{CREATOR_CONFIG}}, it is replaced with the
 * canonical creator-config.md content. Additional vars are applied
 * after config injection.
 */
export function loadPromptWithConfig(
  name: string,
  vars: Record<string, string> = {},
): string {
  const allVars = { ...vars };
  // Auto-inject creator config if not already provided
  if (!allVars.CREATOR_CONFIG) {
    try {
      allVars.CREATOR_CONFIG = loadCreatorConfig();
    } catch {
      // creator-config.md might not exist in test environments
    }
  }
  return loadPromptWithVars(name, allVars);
}

/**
 * Writes content back to a prompt file (for mutations / auto-research updates).
 * Also invalidates the cache entry.
 */
export function writePrompt(name: string, content: string): void {
  const filePath = getPromptPath(name);
  fs.writeFileSync(filePath, content, 'utf-8');
  cache.delete(name);
}
