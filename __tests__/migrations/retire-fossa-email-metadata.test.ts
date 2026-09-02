import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const emailLogSql = readFileSync(
  resolve(__dirname, '../../migrations/008_email_log.sql'),
  'utf8',
);
const upSql = readFileSync(
  resolve(__dirname, '../../migrations/310_retire_fossa_email_metadata.sql'),
  'utf8',
);
const downSql = readFileSync(
  resolve(__dirname, '../../migrations/down/310_retire_fossa_email_metadata.sql'),
  'utf8',
);

describe('migration 310 retired Fossa email metadata', () => {
  it('redacts retired automation PII while preserving history and unrelated rows', () => {
    const db = new Database(':memory:');
    try {
      db.exec(emailLogSql);
      db.prepare(`
        INSERT INTO email_log (recipient, subject, status, error_message, source, ts)
        VALUES (?, ?, 'failed', ?, 'fossa_email', '2026-08-01 08:00:00')
      `).run('private@example.com', 'Private daily agenda', 'Provider included private details');
      db.prepare(`
        INSERT INTO email_log (recipient, subject, status, source, ts)
        VALUES ('other@example.com', 'Manual note', 'sent', 'manual', '2026-08-01 09:00:00')
      `).run();

      db.exec(upSql);
      expect(db.prepare('SELECT * FROM email_log WHERE id = 1').get()).toMatchObject({
        id: 1,
        recipient: '[redacted]',
        subject: 'Retired Secretary automation',
        status: 'failed',
        error_message: null,
        source: 'retired_secretary_automation',
        ts: '2026-08-01 08:00:00',
      });
      expect(db.prepare('SELECT * FROM email_log WHERE id = 2').get()).toMatchObject({
        recipient: 'other@example.com',
        subject: 'Manual note',
        source: 'manual',
      });
      expect(() => db.exec(downSql)).not.toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM email_log').get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });
});
