import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it, expect } from 'vitest';
import { resolveDocumentationInventory } from '../../scripts/lib/documentation-policy.mjs';

  it('resolves canonical documentation for regular files and file mirrors', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-documentation-mirror-'));
    const canonical = 'docs/agents/FIXTURE.md';
    const mirror = '.claude/skills/test-audit/SKILL.md';
    try {
      fs.mkdirSync(path.dirname(path.join(directory, canonical)), { recursive: true });
      fs.mkdirSync(path.dirname(path.join(directory, mirror)), { recursive: true });
      fs.writeFileSync(path.join(directory, canonical), '# Fixture\n');
      fs.symlinkSync(path.relative(path.dirname(path.join(directory, mirror)), path.join(directory, canonical)), path.join(directory, mirror));
      const policy = JSON.parse(fs.readFileSync('config/documentation-policy.json', 'utf8'));
      policy.exceptions = {};
      const result = resolveDocumentationInventory({ repoRoot: directory, files: [canonical, mirror], policy, asOf: '2026-09-05' });
      expect(result.issues).toEqual([]);
      expect(result.records.find((record) => record.path === canonical)).toMatchObject({ status: 'canonical', canonicalPath: canonical });
      expect(result.records.find((record) => record.path === mirror)).toMatchObject({ status: 'mirror', canonicalPath: canonical });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

