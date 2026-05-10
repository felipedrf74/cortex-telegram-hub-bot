#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
require('dotenv').config({ quiet: true });
const Database = require('better-sqlite3');

const WATCHER_SOURCE = 'garmin_tenant_isolation_watcher';
const WATCHER_MESSAGE_PREFIX = 'Garmin tenant isolation%';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function defaultDbPath() {
  return path.resolve(String(process.env.DATABASE_PATH || process.env.DB_PATH || './data/bot.db'));
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function parseContext(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function matchedCountFrom(row) {
  const context = parseContext(row?.context);
  const direct = Number(context.matchedCount);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const fromMessage = String(row?.message ?? '').match(/found\s+(\d+)\s+tainted/i);
  if (fromMessage) return Number(fromMessage[1]);
  return 0;
}

export function readGarminWatcherState(db) {
  const sinceExpr = "datetime('now', '-24 hours')";
  const errorLogRows = tableExists(db, 'error_log')
    ? db.prepare(`
        SELECT id, ts, level, source, message, context
        FROM error_log
        WHERE source = 'job'
          AND message LIKE ?
          AND ts >= ${sinceExpr}
        ORDER BY ts DESC, id DESC
      `).all(WATCHER_MESSAGE_PREFIX)
    : [];

  const openAlerts = tableExists(db, 'operator_alerts')
    ? db.prepare(`
        SELECT id, created_at, last_seen_at, source, status, metadata_json
        FROM operator_alerts
        WHERE source = ?
          AND status = 'open'
        ORDER BY last_seen_at DESC, id DESC
      `).all(WATCHER_SOURCE)
    : [];

  const latestError = errorLogRows[0];
  return {
    recentErrorLogCount: errorLogRows.length,
    openAlertCount: openAlerts.length,
    mostRecentRun: latestError?.ts ?? null,
    mostRecentMatchedCount: latestError ? matchedCountFrom(latestError) : 0,
  };
}

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const dbPath = path.resolve(String(args.db || defaultDbPath()));
  const db = new Database(dbPath, { readonly: true });
  try {
    return readGarminWatcherState(db);
  } finally {
    db.close();
  }
}

function isDirectRun() {
  return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

if (isDirectRun()) {
  process.stdout.write(JSON.stringify(run(), null, 2));
  process.stdout.write('\n');
}

