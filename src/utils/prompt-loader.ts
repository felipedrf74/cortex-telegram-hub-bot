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
 * Writes content back to a prompt file (for mutations / auto-research updates).
 * Also invalidates the cache entry.
 */
export function writePrompt(name: string, content: string): void {
  const filePath = getPromptPath(name);
  fs.writeFileSync(filePath, content, 'utf-8');
  cache.delete(name);
}
