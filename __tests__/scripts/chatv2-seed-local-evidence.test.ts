import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
} from '../../src/services/chat-v2-completion-evidence';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-local-evidence-seed-'));
  dbPath = path.join(tempDir, 'seed.db');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('chatv2-seed-local-evidence CLI', () => {
  it('binds every seeded completion row to the current effective response-locale evidence', () => {
    execFileSync(process.execPath, [
      '--import',
      'tsx',
      'scripts/chatv2-seed-local-evidence.ts',
      '--write',
      '--replace',
      '--rows=50',
      `--db=${dbPath}`,
    ], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(`
        SELECT locale, safe_metadata_json
        FROM chat_v2_completion_evidence
        ORDER BY id
      `).all() as Array<{ locale: string; safe_metadata_json: string }>;
      expect(rows).toHaveLength(100);
      for (const row of rows) {
        const metadata = JSON.parse(row.safe_metadata_json) as {
          responseLocaleEvidence?: {
            version?: string;
            effectiveLocale?: string;
          };
        };
        expect(metadata.responseLocaleEvidence?.version).toBe(
          CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
        );
        expect(['en', 'pt-BR', 'pt-PT']).toContain(
          metadata.responseLocaleEvidence?.effectiveLocale,
        );
        if (row.locale !== 'mixed') {
          expect(metadata.responseLocaleEvidence?.effectiveLocale).toBe(row.locale);
        }
      }
    } finally {
      db.close();
    }
  });
});
