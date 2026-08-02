// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const source = path.join(root, 'src/tools/routing-action-skill-accuracy.ts');

describe('installed routing action-skill accuracy tool', () => {
  it('is a compiled, cache-only release CLI with no refresh surface', () => {
    const raw = fs.readFileSync(source, 'utf8');

    expect(raw).toContain('readonly: true');
    expect(raw).toContain("'--refresh-llm'");
    expect(raw).toContain("'--accept-snapshot'");
    expect(raw).toContain('runRoutingActionSkillAccuracy');
    expect(raw).not.toContain('classifyWithClaude');
    expect(raw).not.toContain('generateContent');
  });

  it('refuses provider or snapshot mutation flags before opening a database', () => {
    for (const flag of ['--refresh-llm', '--accept-snapshot']) {
      const result = spawnSync(process.execPath, [
        '--import',
        'tsx',
        source,
        '--db=/definitely/not/a/database.sqlite',
        flag,
      ], { cwd: root, encoding: 'utf8' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${flag} is not supported`);
      expect(result.stderr).toContain('cache-only');
      expect(result.stderr).not.toContain('database not found');
    }
  });
});
