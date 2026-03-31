/**
 * QA Validation Tests — Cortex → Nexus Hub Rename
 *
 * Validates that the Cortex → Nexus Hub rename was applied
 * consistently across the codebase by the flex agent.
 * Focuses on:
 *   1. Source files use "Nexus Hub" not standalone "Cortex"
 *   2. Prompts use "Nexus Hub"
 *   3. Documentation references updated
 *   4. Portal HTML uses "Nexus Hub"
 *   5. Allowed exceptions: Google Drive folder name, historical references
 *
 * QA agent: agent/qa
 * Validating: refactor(brand): rename Cortex → Nexus Hub
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
}

function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.join(ROOT, relativePath));
}

// ═══════════════════════════════════════════════════════════════════
// 1. SOURCE FILES — "Nexus Hub" branding
// ═══════════════════════════════════════════════════════════════════

describe('QA: Cortex → Nexus Hub rename — source files', () => {
  it('portal/server.ts references "Nexus Hub"', () => {
    const content = readFile('src/portal/server.ts');
    expect(content).toContain('Nexus Hub');
    // Should NOT contain standalone "Cortex" as project name
    // (but may reference it historically like "formerly Cortex")
    const lines = content.split('\n');
    const cortexLines = lines.filter(l =>
      l.includes('Cortex') && !l.includes('formerly') && !l.includes('Cortex IDEAS')
    );
    expect(cortexLines).toEqual([]);
  });

  it('portal/telemetry.ts references "Nexus Hub"', () => {
    const content = readFile('src/portal/telemetry.ts');
    expect(content).toContain('Nexus Hub');
  });

  it('bot.ts references "Nexus Hub"', () => {
    if (fileExists('src/bot.ts')) {
      const content = readFile('src/bot.ts');
      expect(content).toContain('Nexus Hub');
    }
  });

  it('google-drive.ts keeps "Cortex IDEAS" (external folder name)', () => {
    if (fileExists('src/services/google-drive.ts')) {
      const content = readFile('src/services/google-drive.ts');
      // This is an external Google Drive folder — should NOT be renamed
      expect(content).toContain('Cortex IDEAS');
    }
  });

  it('no source files reference standalone "Cortex" as project name', () => {
    const srcDir = path.join(ROOT, 'src');
    const tsFiles = findFiles(srcDir, '.ts');

    const violations: string[] = [];
    for (const file of tsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip: "Cortex IDEAS" (Google Drive), "formerly Cortex", comments referencing history
        if (
          line.includes('Cortex IDEAS') ||
          line.includes('formerly Cortex') ||
          line.includes('formerly') ||
          line.includes('cortex-telegram')  // repo name in URLs
        ) continue;

        // Check for standalone "Cortex" that looks like it refers to the project
        if (/\bCortex\b/.test(line) && !line.includes('Cortex IDEAS')) {
          violations.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. PROMPTS — branding consistency
// ═══════════════════════════════════════════════════════════════════

describe('QA: Cortex → Nexus Hub rename — prompts', () => {
  it('no prompts reference standalone "Cortex"', () => {
    const promptsDir = path.join(ROOT, 'prompts');
    if (!fs.existsSync(promptsDir)) return;

    const mdFiles = findFiles(promptsDir, '.md');
    const violations: string[] = [];

    for (const file of mdFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/\bCortex\b/.test(lines[i]) && !lines[i].includes('formerly')) {
          violations.push(`${path.relative(ROOT, file)}:${i + 1}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('at least some prompts reference "Nexus Hub"', () => {
    const promptsDir = path.join(ROOT, 'prompts');
    if (!fs.existsSync(promptsDir)) return;

    const mdFiles = findFiles(promptsDir, '.md');
    let found = false;

    for (const file of mdFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('Nexus Hub')) {
        found = true;
        break;
      }
    }

    expect(found).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. DOCUMENTATION — updated references
// ═══════════════════════════════════════════════════════════════════

describe('QA: Cortex → Nexus Hub rename — documentation', () => {
  it('CHANGELOG.md uses "Nexus Hub" in header', () => {
    const content = readFile('CHANGELOG.md');
    expect(content).toContain('Nexus Hub');
  });

  it('CHANGELOG.md properly notes "(formerly Cortex)"', () => {
    const content = readFile('CHANGELOG.md');
    expect(content).toContain('formerly Cortex');
  });

  it('DOCUMENTATION.md uses "Nexus Hub"', () => {
    if (fileExists('DOCUMENTATION.md')) {
      const content = readFile('DOCUMENTATION.md');
      expect(content).toContain('Nexus Hub');
    }
  });

  it('nexushub-adaptation-guide.md exists (renamed from cortex-adaptation-guide)', () => {
    expect(fileExists('knowledge/skills/nexushub-adaptation-guide.md')).toBe(true);
    // The old cortex-adaptation-guide.md should no longer exist
    expect(fileExists('knowledge/skills/cortex-adaptation-guide.md')).toBe(false);
    expect(fileExists('docs/cortex-adaptation-guide.md')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. PORTAL HTML — UI branding
// ═══════════════════════════════════════════════════════════════════

describe('QA: Cortex → Nexus Hub rename — portal HTML', () => {
  it('portal.html references "Nexus Hub"', () => {
    if (fileExists('src/portal/portal.html')) {
      const content = readFile('src/portal/portal.html');
      expect(content).toContain('Nexus Hub');
      // No standalone Cortex references in UI
      const cortexRefs = content.match(/\bCortex\b/g) || [];
      const allowedRefs = content.match(/formerly Cortex/g) || [];
      expect(cortexRefs.length).toBeLessThanOrEqual(allowedRefs.length);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. CONTENT ENGINE — Python files
// ═══════════════════════════════════════════════════════════════════

describe('QA: Cortex → Nexus Hub rename — content engine', () => {
  it('main.py uses "Nexus Hub" in app title', () => {
    if (fileExists('content-engine/main.py')) {
      const content = readFile('content-engine/main.py');
      expect(content).toContain('Nexus Hub');
    }
  });
});

// ── Helper ────────────────────────────────────────────────────────

function findFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules, .git, data
      if (['node_modules', '.git', 'data', 'dist'].includes(entry.name)) continue;
      results.push(...findFiles(fullPath, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(fullPath);
    }
  }
  return results;
}
