#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_FIXTURE_USER_ID = 1_000_001;
export const FIXTURE_USER_ID_MIN = 1_000_000;
export const FIXTURE_USER_ID_MAX = 1_099_999;
export const DEFAULT_FIXTURE_DEVICE_ID = 'staging-fixture-device';

export function assertFixtureUserId(userId) {
  if (!Number.isInteger(userId) || userId < FIXTURE_USER_ID_MIN || userId > FIXTURE_USER_ID_MAX) {
    const err = new Error(`Synthetic user id must be in ${FIXTURE_USER_ID_MIN}-${FIXTURE_USER_ID_MAX}`);
    err.exitCode = 2;
    throw err;
  }
}

export function tokenCachePath(userId) {
  return join(tmpdir(), `staging-fixture-token-${userId}.json`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function runRemoteNode(script, {
  server = process.env.DEPLOY_SERVER || 'dominguez@serverdominguez',
  stagingPath = process.env.STAGING_PATH || '/home/dominguez/telegram-hub-bot-staging',
} = {}) {
  const command = [
    'set -e',
    `cd ${shellQuote(stagingPath)}`,
    'set -a',
    '. ./.env',
    'set +a',
    'node',
  ].join(' && ');

  return execFileSync('ssh', [server, command], {
    input: script,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

export function buildRemoteSeedScript({ userId, deviceId }) {
  return String.raw`
const Database = require('better-sqlite3');
const db = new Database(process.env.DATABASE_PATH || process.env.DB_PATH || './data/bot.db');
const { signIosJwt } = require('./dist/services/ios-jwt');

const userId = ${JSON.stringify(userId)};
const deviceId = ${JSON.stringify(deviceId)};
const now = new Date();
const today = now.toISOString().slice(0, 10);
const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
const weekEnd = new Date(now.getTime() + 6 * 86400000).toISOString().slice(0, 10);

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function columnsFor(name) {
  if (!tableExists(name)) return new Set();
  return new Set(db.prepare('PRAGMA table_info(' + name + ')').all().map((row) => row.name));
}

function insert(table, values, mode = 'INSERT OR REPLACE') {
  const columns = columnsFor(table);
  if (columns.size === 0) return null;
  const entries = Object.entries(values).filter(([column]) => columns.has(column));
  if (entries.length === 0) return null;
  const names = entries.map(([column]) => column);
  const placeholders = names.map(() => '?').join(', ');
  const sql = mode + ' INTO ' + table + ' (' + names.join(', ') + ') VALUES (' + placeholders + ')';
  return db.prepare(sql).run(...entries.map(([, value]) => value));
}

function deleteUserData(targetUserId) {
  const run = (sql, ...params) => {
    try { db.prepare(sql).run(...params); } catch (_) {}
  };
  const delUser = (table) => {
    if (tableExists(table) && columnsFor(table).has('user_id')) run('DELETE FROM ' + table + ' WHERE user_id = ?', targetUserId);
  };

  const planIds = tableExists('fitness_training_plans')
    ? db.prepare('SELECT id FROM fitness_training_plans WHERE user_id = ?').all(targetUserId).map((row) => row.id)
    : [];
  if (planIds.length > 0) {
    const placeholders = planIds.map(() => '?').join(',');
    run('DELETE FROM training_completions WHERE plan_id IN (' + placeholders + ')', ...planIds);
    run('DELETE FROM training_sessions WHERE plan_id IN (' + placeholders + ')', ...planIds);
    run('DELETE FROM training_weeks WHERE plan_id IN (' + placeholders + ')', ...planIds);
  }

  [
    'subscriptions',
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
  ].forEach(delUser);

  if (tableExists('content_creator_profile')) {
    run('DELETE FROM content_creator_profile WHERE tenant_id = ? OR owner_user_id = ?', targetUserId, targetUserId);
  }
  if (tableExists('api_cache')) {
    run('DELETE FROM api_cache WHERE cache_key LIKE ?', '%' + targetUserId + '%');
  }
  if (tableExists('users')) {
    run('DELETE FROM users WHERE id = ?', targetUserId);
  }
}

db.transaction(() => {
  deleteUserData(userId);

  insert('users', {
    id: userId,
    telegram_id: 900000000 + userId,
    email: 'staging-fixture-' + userId + '@nexushub.test',
    email_verified: 1,
    username: 'staging_fixture_' + userId,
    first_name: 'Staging',
    last_name: 'Fixture',
    language: 'en-US',
    timezone: 'America/New_York',
    tier: 'max',
    status: 'active',
    auth_provider: 'email',
    daily_message_limit: 500,
    daily_token_limit: 1000000,
    daily_cost_limit_usd: 25,
    created_at: now.toISOString(),
    last_active_at: now.toISOString(),
  });

  insert('ios_devices', {
    user_id: userId,
    device_id: deviceId,
    device_name: 'Staging Fixture Harness',
    refresh_token: 'staging-fixture-refresh-' + userId,
    refresh_token_hash: 'staging-fixture-refresh-hash-' + userId,
    last_active_at: now.toISOString(),
    created_at: now.toISOString(),
  }, 'INSERT OR IGNORE');

  insert('subscriptions', {
    user_id: userId,
    plan: 'max',
    period: 'monthly',
    status: 'trialing',
    provider: 'staging_fixture',
    provider_subscription_id: 'staging-fixture-sub-' + userId,
    provider_customer_id: 'staging-fixture-customer-' + userId,
    current_period_start: now.toISOString(),
    current_period_end: new Date(now.getTime() + 30 * 86400000).toISOString(),
    cancel_at_period_end: 0,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });

  insert('content_creator_profile', {
    user_id: userId,
    tenant_id: userId,
    owner_user_id: userId,
    visibility_scope: 'user_private',
    lifecycle_state: 'active',
    scope_status: 'active',
    created_by: userId,
    updated_by: userId,
    audit_metadata_json: JSON.stringify({ source: 'staging-fixture-harness' }),
    pillars_json: JSON.stringify(['knitting']),
    niches_json: JSON.stringify(['knitting tutorials']),
    audience: '25-45 women learning practical knitting',
    platforms_json: JSON.stringify(['youtube', 'instagram']),
    voice_rules_json: JSON.stringify(['Clear, warm, practical']),
    preferred_formats_json: JSON.stringify(['short-form', 'tutorial']),
    disliked_topics_json: JSON.stringify([]),
    banned_topics_json: JSON.stringify([]),
    trusted_sources_json: JSON.stringify(['staging fixture']),
    disliked_sources_json: JSON.stringify([]),
    content_goals_json: JSON.stringify(['teach repeatable knitting skills']),
    language_preference: 'en-US',
    voice_examples_json: JSON.stringify(['A calm, practical knitting walkthrough.']),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });

  insert('native_task_lists', {
    user_id: userId,
    name: 'Fixture Inbox',
    is_default: 1,
    color: '#2F80ED',
    position: 0,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }, 'INSERT OR IGNORE');
  insert('native_task_lists', {
    user_id: userId,
    name: 'Fixture Studio',
    is_default: 0,
    color: '#27AE60',
    position: 1,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }, 'INSERT OR IGNORE');
  const inbox = tableExists('native_task_lists')
    ? db.prepare('SELECT id FROM native_task_lists WHERE user_id = ? AND name = ?').get(userId, 'Fixture Inbox')
    : null;
  const studio = tableExists('native_task_lists')
    ? db.prepare('SELECT id FROM native_task_lists WHERE user_id = ? AND name = ?').get(userId, 'Fixture Studio')
    : null;
  if (inbox?.id) {
    insert('native_tasks', {
      user_id: userId,
      list_id: inbox.id,
      title: 'Review staging fixture harness report',
      body: 'Synthetic task seeded for route-pipeline probes.',
      importance: 'high',
      status: 'notStarted',
      due_date_time: tomorrow + 'T15:00:00.000Z',
      tags: JSON.stringify(['staging-fixture']),
      position: 0,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }, 'INSERT');
  }
  if (studio?.id) {
    insert('native_tasks', {
      user_id: userId,
      list_id: studio.id,
      title: 'Draft knitting tutorial outline',
      body: 'Fixture task for content/dashboard surfaces.',
      importance: 'normal',
      status: 'inProgress',
      due_date_time: weekEnd + 'T18:00:00.000Z',
      tags: JSON.stringify(['knitting', 'content']),
      position: 1,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }, 'INSERT');
  }

  insert('recipes', {
    user_id: userId,
    title: 'Fixture Lentil Soup',
    ingredients: JSON.stringify([{ name: 'lentils', quantity: '1', unit: 'cup' }]),
    instructions: 'Simmer lentils with vegetables until tender.',
    prep_time_min: 10,
    cook_time_min: 30,
    servings: 4,
    tags: 'fixture,vegetarian',
    source: 'staging-fixture-harness',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }, 'INSERT');
  insert('meal_plans', {
    user_id: userId,
    date: today,
    meal_type: 'dinner',
    title: 'Fixture Lentil Soup',
    notes: 'Seeded by staging fixture harness',
    created_at: now.toISOString(),
  });
  insert('shopping_lists', {
    user_id: userId,
    week_start: today,
    items: JSON.stringify([{ name: 'lentils', quantity: '1 cup', checked: false }]),
    status: 'active',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });

  insert('finance_transactions', {
    user_id: userId,
    date: today,
    category: 'expense',
    subcategory: 'materials',
    amount: 42.5,
    currency: 'USD',
    description: 'Fixture yarn purchase',
    receipt_ref: 'staging-fixture',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }, 'INSERT');

  insert('content_topics', {
    user_id: userId,
    tenant_id: userId,
    owner_user_id: userId,
    visibility_scope: 'user_private',
    lifecycle_state: 'active',
    scope_status: 'active',
    created_by: userId,
    updated_by: userId,
    title: 'How to fix dropped stitches',
    notes: 'Fixture topic for content route probes.',
    scheduled_date: tomorrow,
    scheduled_at: tomorrow + 'T14:00:00.000Z',
    status: 'planned',
    editorial_state: 'idea',
    approval_state: 'not_required',
    review_required: 0,
    review_reason_codes_json: JSON.stringify([]),
    source_ids_json: JSON.stringify([]),
    ontology_metadata_json: JSON.stringify({ source: 'staging-fixture-harness' }),
    audit_metadata_json: JSON.stringify({ source: 'staging-fixture-harness' }),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }, 'INSERT');
  insert('content_scripts', {
    user_id: userId,
    tenant_id: userId,
    owner_user_id: userId,
    visibility_scope: 'user_private',
    lifecycle_state: 'active',
    scope_status: 'active',
    created_by: userId,
    updated_by: userId,
    topic: 'How to fix dropped stitches',
    format: 'short-form',
    script_text: 'Here is a simple way to recover a dropped stitch without panic.',
    hook: 'Dropped a stitch? Pause before you pull.',
    title_options: JSON.stringify(['Fix dropped stitches fast']),
    sources_used: JSON.stringify(['staging-fixture']),
    estimated_duration: '45s',
    niche: 'knitting',
    generation_duration_ms: 1,
    editorial_state: 'drafted',
    approval_state: 'review_required',
    review_required: 1,
    review_reason_codes_json: JSON.stringify(['fixture']),
    audit_metadata_json: JSON.stringify({ source: 'staging-fixture-harness' }),
    created_at: now.toISOString(),
  }, 'INSERT');

  const planInfo = insert('fitness_training_plans', {
    user_id: userId,
    name: 'Fixture Mobility Base',
    sport: 'strength',
    goal: 'General health during staging probes',
    duration_weeks: 1,
    periodization: 'linear',
    status: 'active',
    start_date: today,
    end_date: weekEnd,
    preferences_json: JSON.stringify({ available_days: ['Monday', 'Wednesday'], equipment: ['bands'] }),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }, 'INSERT');
  const planId = planInfo?.lastInsertRowid;
  if (planId) {
    const weekInfo = insert('training_weeks', {
      plan_id: Number(planId),
      week_number: 1,
      focus: 'mobility',
      intensity_pct: 70,
      volume_sessions: 2,
      notes: 'Seeded by staging fixture harness',
      auto_adjusted: 0,
      created_at: now.toISOString(),
    }, 'INSERT');
    const weekId = weekInfo?.lastInsertRowid;
    if (weekId) {
      insert('training_sessions', {
        week_id: Number(weekId),
        plan_id: Number(planId),
        day_of_week: 'Monday',
        session_type: 'mobility',
        title: 'Fixture Mobility Reset',
        description: 'Low-intensity movement fixture.',
        exercises_json: JSON.stringify([{ name: 'band pull-aparts', sets: 2, reps: 12 }]),
        duration_minutes: 25,
        intensity_text: 'Easy',
        status: 'pending',
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      }, 'INSERT');
    }
  }

  if (tableExists('api_cache')) {
    db.prepare('DELETE FROM api_cache WHERE cache_key LIKE ?').run('%' + userId + '%');
  }
})();

const token = signIosJwt({
  userId,
  deviceId,
  staging_fixture: true,
  fixture: 'staging-fixture-harness',
}, { expiresIn: '30d' });

const counts = {};
for (const table of ['users', 'subscriptions', 'ios_devices', 'native_task_lists', 'native_tasks', 'recipes', 'finance_transactions', 'content_topics', 'content_scripts', 'fitness_training_plans']) {
  if (!tableExists(table)) continue;
  const hasUserId = columnsFor(table).has('user_id');
  const count = hasUserId
    ? db.prepare('SELECT COUNT(*) AS count FROM ' + table + ' WHERE user_id = ?').get(userId).count
    : db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count;
  counts[table] = count;
}

process.stdout.write(JSON.stringify({
  ok: true,
  userId,
  deviceId,
  token,
  seededAt: now.toISOString(),
  counts,
}, null, 2));
`;
}

export function seedFixture(options = {}) {
  const userId = options.userId ?? DEFAULT_FIXTURE_USER_ID;
  assertFixtureUserId(userId);
  const deviceId = options.deviceId ?? `${DEFAULT_FIXTURE_DEVICE_ID}-${userId}`;
  const raw = runRemoteNode(buildRemoteSeedScript({ userId, deviceId }), options);
  const result = JSON.parse(raw);
  writeFileSync(tokenCachePath(userId), JSON.stringify({
    userId,
    deviceId,
    token: result.token,
    createdAt: new Date().toISOString(),
  }, null, 2));
  return result;
}
