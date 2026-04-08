// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Prompt File Validator — Phase 3 Slice D
 *
 * Walks `DEFAULT_SKILLS` from skill-config.ts and, for every sub-skill
 * that declares a `promptFile`, verifies that the file actually exists
 * on disk. Runs at bootstrap so a file rename or missing persona
 * prompt surfaces immediately instead of at the moment a user sends
 * a triathlon message and falls through to the generic prompt.
 *
 * Context: Phase 2 Slice A renamed `prompts/triathlon/cycle.md` to
 * `cycling.md` to align with the sport classifier's `cycling` enum
 * value, but the `promptFile` attribute in `skill-config.ts` wasn't
 * updated in lockstep. The sport classifier path caught it (because
 * its unit test dispatched through the classifier → prompt loader
 * chain) but a static check would have caught it earlier and with
 * a clearer error message.
 *
 * Design notes:
 *
 * 1. FAIL-SOFT. A missing prompt file logs an error and returns the
 *    structured result, but does NOT crash the process. The runtime
 *    fallback in `getDomainSystemPrompt` already handles this
 *    gracefully (falls back to the generic domain prompt). The
 *    validator's job is to make the error LOUD and CENTRALIZED, not
 *    to abort boot. A broken persona prompt shouldn't prevent the
 *    secretary domain from answering task questions.
 *
 * 2. NO FILE SYSTEM WRITES. This is a read-only check. It runs
 *    `fs.existsSync` against each declared path. Cheap enough to
 *    run every boot (microseconds per file).
 *
 * 3. CASE-SENSITIVE. On Linux prod, `cycle.md` and `Cycle.md` are
 *    different files; on macOS dev, they're the same. The validator
 *    uses `fs.readdirSync` on the directory and does an exact-match
 *    lookup against the basename, so a case mismatch fails on dev
 *    too — catching Linux-only bugs on a Mac before deploy.
 */

import fs from 'fs';
import path from 'path';
import { DEFAULT_SKILLS } from './skill-config';
import { logger } from '../utils/logger';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * A single declared-but-missing prompt file. `promptFile` is the
 * relative path as it appears in skill-config.ts — including the
 * `.md` extension. `expectedPath` is the absolute path where the
 * validator looked. `reason` narrows the failure cause so the
 * startup log tells you *why* it's missing.
 */
export interface MissingPromptFile {
  skill: string;
  subSkill: string;
  promptFile: string;
  expectedPath: string;
  reason: 'not_found' | 'case_mismatch';
}

export interface PromptValidationResult {
  valid: boolean;
  /** Total number of prompt files declared across all sub-skills. */
  checked: number;
  /** Files that were declared but could not be located. */
  missing: MissingPromptFile[];
}

// ─── Constants ──────────────────────────────────────────────────────

/**
 * Prompts live at `<repo>/prompts/*.md`. The validator resolves
 * relative `promptFile` attributes against this directory.
 *
 * `__dirname` at runtime resolves to `dist/skills/` (after compile)
 * or `src/skills/` (under ts-node). Both point back two levels to
 * get to the repo root, so `../../prompts` works in both modes.
 */
const PROMPTS_DIR = path.resolve(__dirname, '..', '..', 'prompts');

// ─── Main entry point ──────────────────────────────────────────────

/**
 * Walk every sub-skill in DEFAULT_SKILLS and verify its declared
 * `promptFile` exists on disk with the exact case specified.
 *
 * Usage:
 *   const result = validatePromptFiles();
 *   if (!result.valid) {
 *     // log / alert — but don't crash
 *   }
 *
 * Pure function, no side effects beyond fs.existsSync / readdirSync.
 * Caller decides how to react to a negative result.
 */
export function validatePromptFiles(): PromptValidationResult {
  const missing: MissingPromptFile[] = [];
  let checked = 0;

  // Cache directory listings to avoid readdirSync on every file check.
  // Most persona files live in the same folder (prompts/triathlon/),
  // so this saves N disk reads → 1.
  const dirListCache = new Map<string, Set<string>>();
  const getDirEntries = (dir: string): Set<string> => {
    const cached = dirListCache.get(dir);
    if (cached) return cached;
    try {
      const entries = fs.readdirSync(dir);
      const set = new Set(entries);
      dirListCache.set(dir, set);
      return set;
    } catch {
      // Directory doesn't exist at all — every file inside it is
      // missing by definition. Cache an empty set so we don't retry.
      const empty = new Set<string>();
      dirListCache.set(dir, empty);
      return empty;
    }
  };

  for (const [skillName, def] of Object.entries(DEFAULT_SKILLS)) {
    for (const sub of def.subSkills) {
      if (!sub.promptFile) continue;

      checked++;
      const expectedPath = path.join(PROMPTS_DIR, sub.promptFile);
      const parentDir = path.dirname(expectedPath);
      const baseName = path.basename(expectedPath);

      // Two-step check: exact-case lookup within readdir, not just
      // fs.existsSync. On macOS HFS+ / APFS (case-preserving but
      // case-insensitive), `fs.existsSync('cycle.md')` returns true
      // even when the file is actually `Cycle.md` — which would
      // then fail on Linux prod. Listing the directory and doing a
      // strict string match catches this on dev machines.
      const entries = getDirEntries(parentDir);
      if (!entries.has(baseName)) {
        // Not present with exact case. Check if a case-variant exists
        // to pick the correct `reason` for the error log.
        const caseInsensitiveHit = Array.from(entries).some(
          (e) => e.toLowerCase() === baseName.toLowerCase(),
        );
        missing.push({
          skill: skillName,
          subSkill: sub.name,
          promptFile: sub.promptFile,
          expectedPath,
          reason: caseInsensitiveHit ? 'case_mismatch' : 'not_found',
        });
      }
    }
  }

  return {
    valid: missing.length === 0,
    checked,
    missing,
  };
}

/**
 * Convenience: run validatePromptFiles at startup and write the
 * result to the logger. Returns the result so the caller can decide
 * what to do next (alert, continue, etc.). Fail-soft by design.
 *
 * Meant to be called once from `src/index.ts` during the bootstrap
 * phase, after the database is initialized (so the logger is set up)
 * and before any user traffic is accepted.
 */
export function runStartupPromptValidation(): PromptValidationResult {
  const result = validatePromptFiles();

  if (result.valid) {
    logger.info(
      { checked: result.checked },
      'Prompt file validation passed — all declared promptFile paths exist',
    );
    return result;
  }

  // Structured error log so Sentry / error_log can group on the
  // specific missing files rather than a generic "validation failed"
  // message.
  logger.error(
    {
      checked: result.checked,
      missingCount: result.missing.length,
      missing: result.missing.map((m) => ({
        skill: `${m.skill}.${m.subSkill}`,
        promptFile: m.promptFile,
        reason: m.reason,
        expectedPath: m.expectedPath,
      })),
    },
    `Prompt file validation failed — ${result.missing.length} declared persona prompt(s) missing from disk`,
  );

  // Log a second line per missing file so the console output is
  // scannable without expanding the structured log object.
  for (const m of result.missing) {
    const hint = m.reason === 'case_mismatch'
      ? ' (a case-variant of this file exists — check exact casing)'
      : '';
    logger.error(
      `  missing: ${m.skill}.${m.subSkill} → prompts/${m.promptFile}${hint}`,
    );
  }

  return result;
}
