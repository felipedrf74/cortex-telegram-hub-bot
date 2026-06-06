#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('dotenv').config({ quiet: true });
const Database = require('better-sqlite3');

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

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function resolveOwnerUserId(db) {
  const explicit = Number(process.env.OWNER_USER_ID || '');
  if (Number.isInteger(explicit) && explicit > 0) return explicit;

  const ownerTelegramId = Number(process.env.OWNER_TELEGRAM_ID || '');
  if (Number.isInteger(ownerTelegramId) && ownerTelegramId > 0 && tableExists(db, 'users')) {
    const row = db.prepare('SELECT id FROM users WHERE telegram_id = ? LIMIT 1').get(ownerTelegramId);
    if (row?.id) return Number(row.id);
  }

  if (tableExists(db, 'users')) {
    const row = db.prepare("SELECT id FROM users WHERE tier = 'owner' ORDER BY id ASC LIMIT 1").get();
    if (row?.id) return Number(row.id);
  }
  return null;
}

function findTaintedRows(db, ownerUserId) {
  if (!tableExists(db, 'user_oauth_tokens')) return [];
  const ownerRows = db.prepare(`
    SELECT access_token, refresh_token
    FROM user_oauth_tokens
    WHERE user_id = ? AND provider = 'google'
  `).all(ownerUserId);
  if (ownerRows.length === 0) return [];

  const ownerMaterials = new Set();
  for (const row of ownerRows) {
    if (row.access_token) ownerMaterials.add(String(row.access_token));
    if (row.refresh_token) ownerMaterials.add(String(row.refresh_token));
  }
  if (ownerMaterials.size === 0) return [];

  const rows = db.prepare(`
    SELECT id, user_id, provider, updated_at, scopes, access_token, refresh_token
    FROM user_oauth_tokens
    WHERE provider = 'google' AND user_id != ?
  `).all(ownerUserId);

  return rows
    .filter((row) => ownerMaterials.has(String(row.access_token)) || ownerMaterials.has(String(row.refresh_token)))
    .map((row) => ({
      rowId: Number(row.id),
      userId: Number(row.user_id),
      provider: row.provider,
      updatedAt: row.updated_at,
      scopes: row.scopes,
      reason: 'non-owner Google OAuth token material matches owner token material',
    }))
    .sort((a, b) => a.userId - b.userId || a.rowId - b.rowId);
}

function cleanup(db, rows, dryRun) {
  if (dryRun || rows.length === 0) return { deletedOAuthRows: 0 };
  const ids = rows.map((row) => row.rowId);
  const tx = db.transaction(() => {
    let deletedOAuthRows = 0;
    for (const id of ids) {
      deletedOAuthRows += db.prepare("DELETE FROM user_oauth_tokens WHERE id = ? AND provider = 'google'").run(id).changes;
    }
    return { deletedOAuthRows };
  });
  return tx();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args.yes !== true;
  const dbPath = path.resolve(String(args.db || process.env.DATABASE_PATH || process.env.DB_PATH || './data/bot.db'));
  const db = new Database(dbPath);
  const ownerUserId = resolveOwnerUserId(db);

  if (!ownerUserId) {
    process.stderr.write('Unable to resolve owner user id from OWNER_USER_ID, OWNER_TELEGRAM_ID, or owner-tier users row.\n');
    process.exit(2);
  }

  const matchedRows = findTaintedRows(db, ownerUserId);
  const deletion = cleanup(db, matchedRows, dryRun);
  const remainingRows = findTaintedRows(db, ownerUserId);

  process.stdout.write(JSON.stringify({
    ok: dryRun || remainingRows.length === 0,
    mode: dryRun ? 'dry-run' : 'delete',
    dbPath,
    ownerUserId,
    matchedCount: matchedRows.length,
    matchedRows: matchedRows.map(({ rowId, userId, provider, updatedAt, scopes, reason }) => ({
      rowId,
      userId,
      provider,
      updatedAt,
      scopes,
      reason,
    })),
    deletion,
    remainingCount: remainingRows.length,
    ranAt: new Date().toISOString(),
    note: dryRun ? 'Dry run only. Re-run with --yes to delete matched rows.' : 'Deleted matched Google OAuth rows.',
  }, null, 2));
  process.stdout.write('\n');
}

main();

