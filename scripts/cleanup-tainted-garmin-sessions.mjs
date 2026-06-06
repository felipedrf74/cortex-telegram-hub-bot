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

function redactEmail(email) {
  if (!email || !String(email).includes('@')) return null;
  const [local, domain] = String(email).split('@');
  return `${local.slice(0, 2)}***@${domain}`;
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

function findTaintedRows(db, ownerUserId, ownerEmail) {
  const tainted = new Map();
  const add = (userId, reason, source) => {
    if (!userId || userId === ownerUserId) return;
    const existing = tainted.get(userId) ?? { userId, reasons: [], sources: [] };
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    if (!existing.sources.includes(source)) existing.sources.push(source);
    tainted.set(userId, existing);
  };

  if (tableExists(db, 'garmin_user_tokens') && ownerEmail) {
    const rows = db.prepare(`
      SELECT user_id, garmin_email, status
      FROM garmin_user_tokens
      WHERE user_id != ? AND lower(COALESCE(garmin_email, '')) = lower(?)
    `).all(ownerUserId, ownerEmail);
    for (const row of rows) {
      add(Number(row.user_id), 'non-owner Garmin connection email matches owner GARMIN_EMAIL', 'garmin_user_tokens');
    }
  }

  if (tableExists(db, 'garmin_sessions')) {
    const ownerSession = db.prepare(`
      SELECT oauth1_token_json, oauth2_token_json
      FROM garmin_sessions
      WHERE user_id = ?
    `).get(ownerUserId);
    if (ownerSession?.oauth1_token_json && ownerSession?.oauth2_token_json) {
      const rows = db.prepare(`
        SELECT user_id
        FROM garmin_sessions
        WHERE user_id != ?
          AND oauth1_token_json = ?
          AND oauth2_token_json = ?
      `).all(ownerUserId, ownerSession.oauth1_token_json, ownerSession.oauth2_token_json);
      for (const row of rows) {
        add(Number(row.user_id), 'non-owner Garmin session tokens match owner token material', 'garmin_sessions');
      }
    }
  }

  return [...tainted.values()].sort((a, b) => a.userId - b.userId);
}

function cleanup(db, taintedRows, dryRun) {
  const userIds = taintedRows.map(row => row.userId);
  const result = {
    deletedGarminSessions: 0,
    deletedGarminUserTokens: 0,
  };
  if (dryRun || userIds.length === 0) return result;

  const tx = db.transaction(() => {
    for (const userId of userIds) {
      if (tableExists(db, 'garmin_sessions')) {
        result.deletedGarminSessions += db.prepare('DELETE FROM garmin_sessions WHERE user_id = ?').run(userId).changes;
      }
      if (tableExists(db, 'garmin_user_tokens')) {
        result.deletedGarminUserTokens += db.prepare('DELETE FROM garmin_user_tokens WHERE user_id = ?').run(userId).changes;
      }
    }
  });
  tx();
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args.yes !== true;
  const dbPath = path.resolve(String(args.db || process.env.DATABASE_PATH || process.env.DB_PATH || './data/bot.db'));
  const db = new Database(dbPath);
  const ownerUserId = resolveOwnerUserId(db);
  const ownerEmail = process.env.GARMIN_EMAIL || '';

  if (!ownerUserId) {
    process.stderr.write('Unable to resolve owner user id from OWNER_USER_ID, OWNER_TELEGRAM_ID, or owner-tier users row.\n');
    process.exit(2);
  }

  const taintedRows = findTaintedRows(db, ownerUserId, ownerEmail);
  const deletion = cleanup(db, taintedRows, dryRun);
  const remaining = findTaintedRows(db, ownerUserId, ownerEmail);

  process.stdout.write(JSON.stringify({
    ok: dryRun || remaining.length === 0,
    mode: dryRun ? 'dry-run' : 'delete',
    dbPath,
    ownerUserId,
    ownerGarminEmail: redactEmail(ownerEmail),
    matchedRows: taintedRows,
    matchedCount: taintedRows.length,
    deletion,
    remainingCount: remaining.length,
    ranAt: new Date().toISOString(),
    note: dryRun ? 'Dry run only. Re-run with --yes to delete matched rows.' : 'Deleted matched Garmin session/token rows.',
  }, null, 2));
  process.stdout.write('\n');
}

main();
