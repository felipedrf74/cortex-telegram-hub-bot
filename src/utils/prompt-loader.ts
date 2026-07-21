// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Prompt Loader — reads .md prompt files from the prompts/ directory
 * with mtime-based caching so files are only re-read when changed on disk.
 */
import fs from 'fs';
import path from 'path';

const PROMPTS_DIR = path.resolve(__dirname, '..', '..', 'prompts');

/**
 * M11 perf hygiene: how long a cached prompt is served WITHOUT re-statting
 * the file. Prompt edits are picked up within this window at worst; the chat
 * /message hot path no longer pays a statSync per prompt per request.
 */
export const PROMPT_STAT_TTL_MS = 30_000;

interface CacheEntry {
  content: string;
  mtimeMs: number;
  /** Last time we fs.statSync'd this file (epoch ms). */
  lastStatMs: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Clears the content cache and TTL clocks so hot-reload tests observe file
 * edits instantly instead of waiting out PROMPT_STAT_TTL_MS.
 */
export function resetPromptLoaderForTests(): void {
  cache.clear();
}

/**
 * Returns the absolute path for a named prompt file.
 */
export function getPromptPath(name: string): string {
  return path.join(PROMPTS_DIR, `${name}.md`);
}

/**
 * Loads a prompt from prompts/<name>.md with TTL-throttled mtime caching.
 * Within PROMPT_STAT_TTL_MS of the last stat, cached content is returned
 * without touching the filesystem. After the TTL, the mtime is re-checked
 * and the file re-read only if it changed.
 */
export function loadPrompt(name: string): string {
  const now = Date.now();
  const cached = cache.get(name);

  if (cached && now - cached.lastStatMs < PROMPT_STAT_TTL_MS) {
    return cached.content;
  }

  const filePath = getPromptPath(name);
  const stat = fs.statSync(filePath);

  if (cached && cached.mtimeMs === stat.mtimeMs) {
    cached.lastStatMs = now;
    return cached.content;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  cache.set(name, { content, mtimeMs: stat.mtimeMs, lastStatMs: now });
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
 * Also invalidates the cache entry so the next loadPrompt re-reads immediately.
 *
 * Production guard (M11): prompt files are release artifacts in production —
 * runtime mutation is a warned no-op there. The only runtime caller is the
 * auto-research prompt updater (src/services/autoresearch.ts apply/rollback),
 * which keeps working in non-production environments.
 */
export function writePrompt(name: string, content: string): void {
  if (process.env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.warn(
      `[prompt-loader] writePrompt('${name}') ignored: prompt mutation is disabled in production`,
    );
    return;
  }
  const filePath = getPromptPath(name);
  fs.writeFileSync(filePath, content, 'utf-8');
  cache.delete(name);
}
