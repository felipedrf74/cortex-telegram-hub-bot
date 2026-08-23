// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEN_SCRIPT_ACCEPTANCE_SCENARIOS } from '../../scripts/content-ten-script-acceptance.mjs';

describe('ten-script hybrid-plan acceptance inventory', () => {
  it('pins the global 4/3/3 delivery and 5/5 language budget with one production smoke', () => {
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS).toHaveLength(10);
    expect(new Set(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.map((row) => row.id)).size).toBe(10);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.deliveryMode === 'standard')).toHaveLength(4);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.deliveryMode === 'scheduled')).toHaveLength(3);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.deliveryMode === 'priority')).toHaveLength(3);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.language === 'en')).toHaveLength(5);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.language === 'pt-BR')).toHaveLength(5);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.phase === 'pre-release')).toHaveLength(9);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.phase === 'production-smoke')).toHaveLength(1);
  });

  it('keeps every case on the complete fifteen-minute structured contract', () => {
    for (const row of TEN_SCRIPT_ACCEPTANCE_SCENARIOS) {
      expect(row.topic.length).toBeGreaterThan(40);
      expect(row.topic).not.toMatch(/https?:\/\//u);
      expect(['en', 'pt-BR']).toContain(row.language);
    }
  });

  it('creates and re-reads an immutable private state file without submitting work', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-ten-script-'));
    const state = join(directory, 'state.json');
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const output = execFileSync(process.execPath, [
          'scripts/content-ten-script-acceptance.mjs',
          '--phase', 'status', '--state', state,
        ], { encoding: 'utf8' });
        expect(JSON.parse(output)).toMatchObject({
          inventoryCount: 10,
          submitted: 0,
          acceptancePass: false,
        });
      }
      expect(statSync(state).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(state, 'utf8')).scenarios).toHaveLength(10);
      chmodSync(state, 0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
