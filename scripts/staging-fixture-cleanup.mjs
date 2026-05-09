#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { rmSync } from 'node:fs';
import {
  DEFAULT_FIXTURE_USER_ID,
  assertFixtureUserId,
  runRemoteNode,
  tokenCachePath,
} from './staging-fixture-seed.mjs';

export function buildRemoteCleanupScript({ userId }) {
  return String.raw`
const Database = require('better-sqlite3');
const db = new Database(process.env.DATABASE_PATH || process.env.DB_PATH || './data/bot.db');
const userId = ${JSON.stringify(userId)};

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function columnsFor(name) {
  if (!tableExists(name)) return new Set();
  return new Set(db.prepare('PRAGMA table_info(' + name + ')').all().map((row) => row.name));
}

function run(sql, ...params) {
  try { return db.prepare(sql).run(...params); } catch (_) { return { changes: 0 }; }
}

const before = {};
const after = {};
function countUserRows(table) {
  if (!tableExists(table)) return 0;
  const columns = columnsFor(table);
  if (columns.has('user_id')) return db.prepare('SELECT COUNT(*) AS count FROM ' + table + ' WHERE user_id = ?').get(userId).count;
  if (columns.has('tenant_id') || columns.has('owner_user_id')) {
    const clauses = [];
    if (columns.has('tenant_id')) clauses.push('tenant_id = ?');
    if (columns.has('owner_user_id')) clauses.push('owner_user_id = ?');
    return db.prepare('SELECT COUNT(*) AS count FROM ' + table + ' WHERE ' + clauses.join(' OR ')).get(...clauses.map(() => userId)).count;
  }
  return 0;
}

const tables = [
  'content_creator_profile',
  'content_scripts',
  'content_topics',
  'content_pipeline',
  'content_performance',
  'recipes',
  'meal_plans',
  'shopping_lists',
  'pantry_items',
  'finance_transactions',
  'finance_tax_events',
  'native_tasks',
  'native_task_lists',
  'ios_devices',
  'audit_trail',
  'agent_signals',
  'oauth_tokens',
  'user_oauth_tokens',
  'fitness_training_plans',
];

for (const table of tables) before[table] = countUserRows(table);

db.transaction(() => {
  const planIds = tableExists('fitness_training_plans')
    ? db.prepare('SELECT id FROM fitness_training_plans WHERE user_id = ?').all(userId).map((row) => row.id)
    : [];
  if (planIds.length > 0) {
    const placeholders = planIds.map(() => '?').join(',');
    run('DELETE FROM training_completions WHERE plan_id IN (' + placeholders + ')', ...planIds);
    run('DELETE FROM training_sessions WHERE plan_id IN (' + placeholders + ')', ...planIds);
    run('DELETE FROM training_weeks WHERE plan_id IN (' + placeholders + ')', ...planIds);
  }

  for (const table of tables) {
    if (!tableExists(table)) continue;
    const columns = columnsFor(table);
    if (columns.has('user_id')) run('DELETE FROM ' + table + ' WHERE user_id = ?', userId);
    if (columns.has('tenant_id')) run('DELETE FROM ' + table + ' WHERE tenant_id = ?', userId);
    if (columns.has('owner_user_id')) run('DELETE FROM ' + table + ' WHERE owner_user_id = ?', userId);
  }

  if (tableExists('api_cache')) run('DELETE FROM api_cache WHERE cache_key LIKE ?', '%' + userId + '%');
  if (tableExists('users')) run('DELETE FROM users WHERE id = ?', userId);
})();

for (const table of tables) after[table] = countUserRows(table);
const remainingUser = tableExists('users')
  ? db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(userId).count
  : 0;

process.stdout.write(JSON.stringify({
  ok: true,
  userId,
  before,
  after,
  remainingUser,
  cleanedAt: new Date().toISOString(),
}, null, 2));
`;
}

export function cleanupFixture(options = {}) {
  const userId = options.userId ?? DEFAULT_FIXTURE_USER_ID;
  assertFixtureUserId(userId);
  const raw = runRemoteNode(buildRemoteCleanupScript({ userId }), options);
  try {
    rmSync(tokenCachePath(userId), { force: true });
  } catch {}
  return JSON.parse(raw);
}
