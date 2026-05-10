// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { readGarminWatcherState, run } from '../../scripts/check-garmin-watcher-state.mjs';

const tempDirs = [];

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-watcher-state-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'bot.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      level TEXT NOT NULL DEFAULT 'error',
      source TEXT NOT NULL DEFAULT 'unknown',
      message TEXT NOT NULL,
      stack TEXT,
      context TEXT,
      alerted INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE operator_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      severity TEXT NOT NULL,
      source TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      metadata_json TEXT,
      occurrence_count INTEGER NOT NULL DEFAULT 1
    );
  `);
  return { db, dbPath };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('check-garmin-watcher-state script', () => {
  it('reports zero counts when the watcher has no recent warnings or open alerts', () => {
    const { db } = makeDb();

    expect(readGarminWatcherState(db)).toEqual({
      recentErrorLogCount: 0,
      openAlertCount: 0,
      mostRecentRun: null,
      mostRecentMatchedCount: 0,
    });
  });

  it('summarizes recent watcher warnings and open operator alerts', () => {
    const { db, dbPath } = makeDb();
    db.prepare(`
      INSERT INTO error_log (ts, level, source, message, context)
      VALUES (?, 'warning', 'job', ?, ?)
    `).run(
      '2026-05-10 06:45:01',
      'Garmin tenant isolation watcher found 3 tainted row(s)',
      JSON.stringify({ matchedCount: 3, remainingCount: 3 }),
    );
    db.prepare(`
      INSERT INTO operator_alerts (source, severity, dedupe_key, title, status)
      VALUES ('garmin_tenant_isolation_watcher', 'warning', 'garmin:tenant-isolation:tainted-sessions', 'Garmin warning', 'open')
    `).run();
    db.close();

    expect(run(['--db', dbPath])).toEqual({
      recentErrorLogCount: 1,
      openAlertCount: 1,
      mostRecentRun: '2026-05-10 06:45:01',
      mostRecentMatchedCount: 3,
    });
  });
});
