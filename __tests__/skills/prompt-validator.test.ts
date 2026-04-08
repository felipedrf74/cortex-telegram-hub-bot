/**
 * Phase 3 Slice D — Prompt file validator tests
 *
 * Two layers:
 *
 *   1. REAL-WORLD SMOKE: runs validatePromptFiles() against the
 *      actual prompts/ directory and DEFAULT_SKILLS. This is the
 *      primary regression catcher — if someone renames a persona
 *      file without updating skill-config.ts (or vice versa), this
 *      test flips red on CI before the broken config reaches prod.
 *
 *   2. SYNTHETIC: uses a temporary directory + mocked DEFAULT_SKILLS
 *      to exercise the failure paths (missing file, case mismatch,
 *      sub-skills without promptFile) in isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ─── Layer 1: real-world smoke ───────────────────────────────────────

describe('prompt-validator — real DEFAULT_SKILLS + real prompts/', () => {
  it('every declared promptFile exists on disk', async () => {
    const { validatePromptFiles } = await import('../../src/skills/prompt-validator');
    const result = validatePromptFiles();
    // If this fails, the error message includes the exact file path
    // that's missing — check either skill-config.ts or prompts/ for
    // the rename.
    if (!result.valid) {
      // eslint-disable-next-line no-console
      console.error('Missing prompt files:', result.missing);
    }
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('checked count > 0 (something is actually being validated)', async () => {
    const { validatePromptFiles } = await import('../../src/skills/prompt-validator');
    const result = validatePromptFiles();
    // Phase 1 Slice A introduced 4 sport persona sub-skills with
    // promptFile attributes. If the checked count drops to zero,
    // something stripped the fields and the test would pass vacuously.
    expect(result.checked).toBeGreaterThanOrEqual(4);
  });

  it('triathlon sport sub-skills are all represented in checked set', async () => {
    const { validatePromptFiles } = await import('../../src/skills/prompt-validator');
    const { DEFAULT_SKILLS } = await import('../../src/skills/skill-config');

    const triathlonSubsWithPrompt = DEFAULT_SKILLS.triathlon.subSkills.filter(
      (s: any) => !!s.promptFile,
    );
    const result = validatePromptFiles();
    // The validator's `checked` count must be at least the number
    // of triathlon sub-skills that declare a promptFile (plus any
    // other domains that add them in the future).
    expect(result.checked).toBeGreaterThanOrEqual(triathlonSubsWithPrompt.length);
  });
});

// ─── Layer 2: synthetic failure-path tests ──────────────────────────

/**
 * Create a temporary prompts directory and seed it with the given
 * files. Returns a cleanup function so each test can isolate its
 * fixture without leaking to the repo-level prompts/.
 */
function makeTempPromptsDir(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-validator-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
  }
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Internal reimplementation of validatePromptFiles that takes an
 * explicit promptsDir + skillsMap. Mirrors the production signature
 * but avoids module-level imports so each test can drive the inputs
 * deterministically. The production function uses the real
 * PROMPTS_DIR constant and DEFAULT_SKILLS import — we don't want to
 * globally mock either of those for one unit test.
 *
 * Kept in-test (not exported from the main module) because it's a
 * testing device, not production behavior.
 */
function validateWith(
  promptsDir: string,
  skills: Record<string, { subSkills: Array<{ name: string; promptFile?: string }> }>,
): {
  valid: boolean;
  checked: number;
  missing: Array<{ skill: string; subSkill: string; promptFile: string; reason: string }>;
} {
  const missing: Array<{ skill: string; subSkill: string; promptFile: string; reason: string }> = [];
  let checked = 0;

  const dirListCache = new Map<string, Set<string>>();
  const getDirEntries = (dir: string): Set<string> => {
    const cached = dirListCache.get(dir);
    if (cached) return cached;
    try {
      const entries = new Set(fs.readdirSync(dir));
      dirListCache.set(dir, entries);
      return entries;
    } catch {
      const empty = new Set<string>();
      dirListCache.set(dir, empty);
      return empty;
    }
  };

  for (const [skillName, def] of Object.entries(skills)) {
    for (const sub of def.subSkills) {
      if (!sub.promptFile) continue;
      checked++;
      const expectedPath = path.join(promptsDir, sub.promptFile);
      const parentDir = path.dirname(expectedPath);
      const baseName = path.basename(expectedPath);
      const entries = getDirEntries(parentDir);
      if (!entries.has(baseName)) {
        const caseInsensitiveHit = Array.from(entries).some(
          (e) => e.toLowerCase() === baseName.toLowerCase(),
        );
        missing.push({
          skill: skillName,
          subSkill: sub.name,
          promptFile: sub.promptFile,
          reason: caseInsensitiveHit ? 'case_mismatch' : 'not_found',
        });
      }
    }
  }

  return { valid: missing.length === 0, checked, missing };
}

describe('prompt-validator — synthetic failure paths', () => {
  let tempDir: string;
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('reports not_found when a declared file is absent', () => {
    const fixture = makeTempPromptsDir({
      'triathlon/gym.md': 'gym coach prompt',
      'triathlon/running.md': 'running coach prompt',
      // swim.md and cycling.md deliberately missing
    });
    tempDir = fixture.dir;
    cleanup = fixture.cleanup;

    const result = validateWith(tempDir, {
      triathlon: {
        subSkills: [
          { name: 'gym', promptFile: 'triathlon/gym.md' },
          { name: 'running', promptFile: 'triathlon/running.md' },
          { name: 'swim', promptFile: 'triathlon/swim.md' },
          { name: 'cycle', promptFile: 'triathlon/cycling.md' },
        ],
      },
    });

    expect(result.valid).toBe(false);
    expect(result.checked).toBe(4);
    expect(result.missing).toHaveLength(2);

    const missingFiles = result.missing.map((m) => m.promptFile).sort();
    expect(missingFiles).toEqual(['triathlon/cycling.md', 'triathlon/swim.md']);
    for (const m of result.missing) {
      expect(m.reason).toBe('not_found');
    }
  });

  it('reports case_mismatch when only a case-variant exists', () => {
    const fixture = makeTempPromptsDir({
      // Real file is lowercase
      'triathlon/gym.md': 'gym coach prompt',
    });
    tempDir = fixture.dir;
    cleanup = fixture.cleanup;

    // Config declares an UPPERCASE variant — case mismatch
    const result = validateWith(tempDir, {
      triathlon: {
        subSkills: [
          { name: 'gym', promptFile: 'triathlon/GYM.md' },
        ],
      },
    });

    expect(result.valid).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].reason).toBe('case_mismatch');
    expect(result.missing[0].promptFile).toBe('triathlon/GYM.md');
  });

  it('reproduces the cycle.md → cycling.md regression', () => {
    // Recreate the exact Phase 2 Slice A bug: the file was renamed
    // from cycle.md to cycling.md, but if skill-config.ts still
    // pointed at the old name, the validator should catch it.
    const fixture = makeTempPromptsDir({
      'triathlon/cycling.md': 'cycling coach prompt',
    });
    tempDir = fixture.dir;
    cleanup = fixture.cleanup;

    const result = validateWith(tempDir, {
      triathlon: {
        subSkills: [
          { name: 'cycle', promptFile: 'triathlon/cycle.md' },
        ],
      },
    });

    expect(result.valid).toBe(false);
    expect(result.missing[0].promptFile).toBe('triathlon/cycle.md');
    expect(result.missing[0].reason).toBe('not_found');
  });

  it('skips sub-skills without a promptFile attribute', () => {
    const fixture = makeTempPromptsDir({
      'triathlon/gym.md': 'gym coach prompt',
    });
    tempDir = fixture.dir;
    cleanup = fixture.cleanup;

    const result = validateWith(tempDir, {
      triathlon: {
        subSkills: [
          { name: 'gym', promptFile: 'triathlon/gym.md' },
          { name: 'calendar' }, // no promptFile — should not be checked
          { name: 'shared-memory' }, // no promptFile
        ],
      },
    });

    expect(result.valid).toBe(true);
    // Only 1 file actually checked — the other two were skipped
    expect(result.checked).toBe(1);
    expect(result.missing).toHaveLength(0);
  });

  it('returns valid:true + checked:0 for skills with no persona prompts at all', () => {
    const fixture = makeTempPromptsDir({});
    tempDir = fixture.dir;
    cleanup = fixture.cleanup;

    const result = validateWith(tempDir, {
      secretary: {
        subSkills: [
          { name: 'tasks' },
          { name: 'calendar' },
        ],
      },
    });

    expect(result.valid).toBe(true);
    expect(result.checked).toBe(0);
    expect(result.missing).toHaveLength(0);
  });

  it('reports multiple missing files across multiple domains', () => {
    const fixture = makeTempPromptsDir({
      'triathlon/gym.md': 'present',
    });
    tempDir = fixture.dir;
    cleanup = fixture.cleanup;

    const result = validateWith(tempDir, {
      triathlon: {
        subSkills: [
          { name: 'gym', promptFile: 'triathlon/gym.md' },
          { name: 'running', promptFile: 'triathlon/running.md' }, // missing
        ],
      },
      cooking: {
        subSkills: [
          { name: 'italian', promptFile: 'cooking/italian.md' }, // missing — entire cooking/ dir absent
        ],
      },
    });

    expect(result.valid).toBe(false);
    expect(result.checked).toBe(3);
    expect(result.missing).toHaveLength(2);

    const skills = new Set(result.missing.map((m) => m.skill));
    expect(skills.has('triathlon')).toBe(true);
    expect(skills.has('cooking')).toBe(true);
  });

  it('does not throw when the whole prompts directory is missing', () => {
    // Don't create a directory — use a path that definitely doesn't exist
    const nonExistent = path.join(os.tmpdir(), `nonexistent-${Date.now()}`);

    const result = validateWith(nonExistent, {
      triathlon: {
        subSkills: [
          { name: 'gym', promptFile: 'triathlon/gym.md' },
        ],
      },
    });

    // Should report the file as missing, not throw
    expect(result.valid).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].reason).toBe('not_found');
  });
});

// ─── runStartupPromptValidation behavior ────────────────────────────

describe('runStartupPromptValidation', () => {
  it('returns a valid result on a healthy codebase', async () => {
    const { runStartupPromptValidation } = await import('../../src/skills/prompt-validator');
    const result = runStartupPromptValidation();
    expect(result.valid).toBe(true);
  });

  it('result shape matches PromptValidationResult interface', async () => {
    const { runStartupPromptValidation } = await import('../../src/skills/prompt-validator');
    const result = runStartupPromptValidation();
    expect(typeof result.valid).toBe('boolean');
    expect(typeof result.checked).toBe('number');
    expect(Array.isArray(result.missing)).toBe(true);
  });
});
