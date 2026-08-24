import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

// Trust marked these personal identifiers P0 REDACT for the public tip of
// tree. The needles are assembled at runtime so this tracked file can never
// satisfy the acceptance grep it enforces.
const FORBIDDEN_NEEDLES: readonly string[] = [
  ['Server', 'Dominguez'].join(''),
  ['server', 'dominguez'].join(''),
  ['/home/', 'dominguez'].join(''),
  ['5HWHU', '9M2SM'].join(''),
  ['502b7720', 'ce21', '4a3a', 'bced', 'bf176ed4a127'].join('-'),
  ['/Users/', 'felipe', 'dominguez'].join(''),
];

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('Trust redaction source pins', () => {
  it('keeps personal hostnames, home paths, and App Store example IDs out of tracked files', () => {
    const pattern = FORBIDDEN_NEEDLES.map(escapeRegExp).join('|');
    // Mirrors the Trust acceptance command: LICENSE attribution is the only
    // sanctioned occurrence, so everything else tracked must stay clean.
    const grep = spawnSync(
      'git',
      ['grep', '-nE', pattern, '--', ':!LICENSE*'],
      { cwd: root, encoding: 'utf8' },
    );
    if (grep.status !== 0 && grep.status !== 1) {
      throw new Error(`git grep failed (${grep.status}): ${grep.stderr}`);
    }
    expect(grep.stdout, `redacted identifiers reappeared in tracked files:\n${grep.stdout}`).toBe('');
    expect(grep.status).toBe(1);
  });

  it('keeps .env.example App Store Server API credentials as empty placeholders', () => {
    const envExample = read('.env.example');
    expect(envExample).toMatch(/^APP_STORE_SERVER_API_ISSUER_ID=$/m);
    expect(envExample).toMatch(/^APP_STORE_SERVER_API_KEY_ID=$/m);
  });

  it('keeps the PM2 ecosystem configs free of machine-specific fallbacks', () => {
    for (const config of ['ecosystem.release.config.js', 'ecosystem.staging.config.js']) {
      expect(read(config)).toContain("throw new Error('NEXUS_RELEASE_BASE_DIR is required')");
    }
  });
});
