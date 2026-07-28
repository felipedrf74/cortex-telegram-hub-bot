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
export const DEFAULT_FELIPE_VOLUME_CALENDAR_EVENT_COUNT = 100;
export const MAX_FIXTURE_CALENDAR_EVENT_COUNT = 250;

export function assertFixtureUserId(userId) {
  if (!Number.isInteger(userId) || userId < FIXTURE_USER_ID_MIN || userId > FIXTURE_USER_ID_MAX) {
    const err = new Error(`Synthetic user id must be in ${FIXTURE_USER_ID_MIN}-${FIXTURE_USER_ID_MAX}`);
    err.exitCode = 2;
    throw err;
  }
}

export function normalizeFixtureCalendarEventCount(value) {
  if (value == null || value === false) return 0;
  if (value === true) return DEFAULT_FELIPE_VOLUME_CALENDAR_EVENT_COUNT;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > MAX_FIXTURE_CALENDAR_EVENT_COUNT) {
    const err = new Error(`Fixture calendar event count must be an integer between 0 and ${MAX_FIXTURE_CALENDAR_EVENT_COUNT}`);
    err.exitCode = 2;
    throw err;
  }
  return count;
}

export function tokenCachePath(userId) {
  return join(tmpdir(), `staging-fixture-token-${userId}.json`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildRemoteNodeCommand(stagingPath, {
  nodeBin = '/usr/bin/node',
} = {}) {
  if (typeof nodeBin !== 'string' || !nodeBin.startsWith('/')) {
    throw new TypeError('Remote Node binary must be an absolute path');
  }
  const remoteScript = [
    'set -eo pipefail',
    `staging_root=${shellQuote(stagingPath)}`,
    'case "$staging_root" in /*) ;; *) echo "staging root must be absolute" >&2; exit 64 ;; esac',
    '[ "$staging_root" != / ] && [ -d "$staging_root" ] && [ ! -L "$staging_root" ]',
    'staging_root="$(readlink -f -- "$staging_root")"',
    '[ -d "$staging_root/releases" ] && [ ! -L "$staging_root/releases" ]',
    '[ -f "$staging_root/.env" ] && [ ! -L "$staging_root/.env" ]',
    '[ -d "$staging_root/data" ] && [ ! -L "$staging_root/data" ]',
    '[ -f "$staging_root/data/bot.db" ] && [ ! -L "$staging_root/data/bot.db" ]',
    '[ -L "$staging_root/current" ]',
    'staging_release="$(readlink -f -- "$staging_root/current")"',
    'case "$staging_release" in "$staging_root"/releases/*) ;; *) echo "staging current selector escapes releases" >&2; exit 1 ;; esac',
    '[ -d "$staging_release" ] && [ ! -L "$staging_release" ]',
    '[ -d "$staging_release/dist" ] && [ ! -L "$staging_release/dist" ]',
    '[ -d "$staging_release/node_modules" ] && [ ! -L "$staging_release/node_modules" ]',
    '[ -d "$staging_release/scripts" ] && [ ! -L "$staging_release/scripts" ]',
    '[ -L "$staging_release/.env" ]',
    '[ "$(readlink -f -- "$staging_release/.env")" = "$staging_root/.env" ]',
    '[ -L "$staging_release/data" ]',
    '[ "$(readlink -f -- "$staging_release/data")" = "$staging_root/data" ]',
    'cd "$staging_release"',
    'set -a',
    '. "$staging_root/.env"',
    'set +a',
    'export DATABASE_PATH="$staging_root/data/bot.db"',
    'export DB_PATH="$staging_root/data/bot.db"',
    'export NODE_PATH="$staging_release/node_modules"',
    'node_status=0',
    `${shellQuote(nodeBin)} || node_status=$?`,
    'selector_after="$(readlink -f -- "$staging_root/current")"',
    'if [ "$selector_after" != "$staging_release" ]; then',
    '  echo "staging current selector changed during fixture operation" >&2',
    '  exit 74',
    'fi',
    'exit "$node_status"',
  ].join('\n');

  return `/bin/bash -c ${shellQuote(remoteScript)}`;
}

export function runRemoteNode(script, {
  server = process.env.DEPLOY_SERVER || 'dominguez@serverdominguez',
  stagingPath = process.env.STAGING_PATH || '/home/dominguez/telegram-hub-bot-staging',
} = {}) {
  const command = buildRemoteNodeCommand(stagingPath);

  return execFileSync('ssh', [server, command], {
    input: script,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

export function buildRemoteSeedScript({ userId, deviceId, tier = 'max', seedAppleHealth = false, calendarEventCount = 0 }) {
  const normalizedCalendarEventCount = normalizeFixtureCalendarEventCount(calendarEventCount);
  return `
const Database = require('better-sqlite3');
const db = new Database(process.env.DATABASE_PATH || process.env.DB_PATH || './data/bot.db');
const { signIosJwt } = require('./dist/services/ios-jwt');

const userId = ${JSON.stringify(userId)};
const deviceId = ${JSON.stringify(deviceId)};
const tier = ${JSON.stringify(tier)};
const seedAppleHealth = ${JSON.stringify(seedAppleHealth)};
const calendarEventCount = ${JSON.stringify(normalizedCalendarEventCount)};
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

function ensureFixtureCalendarTable() {
  db.exec(\`
    CREATE TABLE IF NOT EXISTS staging_fixture_calendar_events (
      event_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      description TEXT,
      location TEXT,
      categories_json TEXT,
      color TEXT,
      is_all_day INTEGER DEFAULT 0,
      fixture_tag TEXT NOT NULL DEFAULT 'staging-fixture-harness',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_staging_fixture_calendar_user_time
      ON staging_fixture_calendar_events(user_id, start_at, end_at);
  \`);
}

function seedFixtureCalendarEvents(targetUserId, count) {
  ensureFixtureCalendarTable();
  db.prepare('DELETE FROM staging_fixture_calendar_events WHERE user_id = ?').run(targetUserId);
  if (count <= 0) return;

  const base = new Date(now);
  base.setUTCHours(7, 0, 0, 0);
  const insertEvent = db.prepare(\`
    INSERT INTO staging_fixture_calendar_events (
      event_id, user_id, title, start_at, end_at, description, location,
      categories_json, color, is_all_day, fixture_tag, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  \`);
  for (let index = 0; index < count; index += 1) {
    const dayOffset = index % 3;
    const slot = Math.floor(index / 3);
    const start = new Date(base.getTime() + dayOffset * 86400000 + slot * 20 * 60000);
    const end = new Date(start.getTime() + 15 * 60000);
    insertEvent.run(
      'staging-fixture-cal-' + targetUserId + '-' + String(index + 1).padStart(3, '0'),
      targetUserId,
      'Fixture calendar volume event ' + String(index + 1).padStart(3, '0'),
      start.toISOString(),
      end.toISOString(),
      'Synthetic staging fixture event for dashboard Felipe-volume route timing.',
      index % 5 === 0 ? 'Fixture Studio' : null,
      JSON.stringify(['staging-fixture', index % 2 === 0 ? 'work' : 'personal']),
      index % 2 === 0 ? '#3498DB' : '#F97316',
      0,
      'staging-fixture-harness',
      now.toISOString(),
    );
  }
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
    'apple_health_data',
    'garmin_sessions',
    'garmin_user_tokens',
    'native_tasks',
    'native_task_lists',
    'ios_devices',
    'audit_trail',
    'agent_signals',
    'oauth_tokens',
    'user_oauth_tokens',
    'fitness_training_plans',
  ].forEach(delUser);

  if (tableExists('staging_fixture_calendar_events')) {
    run('DELETE FROM staging_fixture_calendar_events WHERE user_id = ?', targetUserId);
  }

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
    tier,
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
    tenant_id: userId,
    owner_user_id: userId,
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
    tenant_id: userId,
    owner_user_id: userId,
    date: today,
    meal_type: 'dinner',
    title: 'Fixture Lentil Soup',
    notes: 'Seeded by staging fixture harness',
    created_at: now.toISOString(),
  });
  insert('shopping_lists', {
    user_id: userId,
    tenant_id: userId,
    owner_user_id: userId,
    week_start: today,
    items: JSON.stringify([{ name: 'lentils', quantity: '1 cup', checked: false }]),
    status: 'active',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });

  insert('finance_transactions', {
    user_id: userId,
    tenant_id: userId,
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

  if (seedAppleHealth) {
    const dateDaysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
    for (let day = 1; day <= 7; day += 1) {
      insert('apple_health_data', {
        user_id: userId,
        data_type: 'hrv',
        date: dateDaysAgo(day),
        data_json: JSON.stringify({ value: 61 + day }),
        source_name: 'staging-fixture-harness',
        created_at: now.toISOString(),
      });
      insert('apple_health_data', {
        user_id: userId,
        data_type: 'resting_heart_rate',
        date: dateDaysAgo(day),
        data_json: JSON.stringify({ value: 55 + (day % 2) }),
        source_name: 'staging-fixture-harness',
        created_at: now.toISOString(),
      });
    }
    [
      ['hrv', { value: 74 }],
      ['sleep', { totalSleepSeconds: 28800, deepSleepSeconds: 5400, remSleepSeconds: 6000 }],
      ['resting_heart_rate', { value: 53 }],
      ['daily_summary', { activeCalories: 320, exerciseMinutes: 35, steps: 7200 }],
      ['steps', { count: 7200 }],
      ['calories', { kcal: 320 }],
      ['exercise_minutes', { minutes: 35 }],
    ].forEach(([dataType, payload]) => {
      insert('apple_health_data', {
        user_id: userId,
        data_type: dataType,
        date: today,
        data_json: JSON.stringify(payload),
        source_name: 'staging-fixture-harness',
        created_at: now.toISOString(),
      });
    });
  }

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

  seedFixtureCalendarEvents(userId, calendarEventCount);
})();

const token = signIosJwt({
  userId,
  deviceId,
  staging_fixture: true,
  fixture: 'staging-fixture-harness',
}, { expiresIn: '30d' });

const counts = {};
for (const table of ['users', 'subscriptions', 'ios_devices', 'native_task_lists', 'native_tasks', 'recipes', 'finance_transactions', 'apple_health_data', 'content_topics', 'content_scripts', 'fitness_training_plans', 'staging_fixture_calendar_events']) {
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
  const raw = runRemoteNode(buildRemoteSeedScript({
    userId,
    deviceId,
    tier: options.tier ?? 'max',
    seedAppleHealth: options.seedAppleHealth === true,
    calendarEventCount: options.calendarEventCount ?? 0,
  }), options);
  const result = JSON.parse(raw);
  writeFileSync(tokenCachePath(userId), JSON.stringify({
    userId,
    deviceId,
    token: result.token,
    createdAt: new Date().toISOString(),
  }, null, 2));
  return result;
}
