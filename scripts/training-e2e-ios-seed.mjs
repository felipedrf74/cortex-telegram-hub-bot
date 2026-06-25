#!/usr/bin/env node
// Seed or clean up an active Training plan for isolated iOS simulator E2E.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const latestEnvPath = path.join(root, '.local/training-e2e/latest.env');
const mode = process.argv[2] || 'prepare';

function loadLatestEnv() {
  if (!fs.existsSync(latestEnvPath)) {
    throw new Error(`No Training E2E env file found at ${latestEnvPath}. Start one with scripts/training-e2e-up.sh`);
  }
  const env = {};
  const text = fs.readFileSync(latestEnvPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^export\s+([A-Z0-9_]+)='(.*)'$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

const env = loadLatestEnv();
const baseUrl = env.NEXUS_TRAINING_E2E_BASE_URL;
if (!baseUrl || baseUrl.includes(':8200')) {
  throw new Error(`Refusing non-isolated Training E2E backend URL: ${baseUrl}`);
}

const metadataPath = path.join(env.NEXUS_TRAINING_E2E_ROOT, 'metadata.json');
const authPath = env.NEXUS_TRAINING_E2E_AUTH_FILE;
const seedEvidencePath = path.join(env.NEXUS_TRAINING_E2E_ROOT, 'training-ios-seed-evidence.json');
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
const seedAttemptId = process.env.NEXUS_TRAINING_E2E_IOS_SEED_ATTEMPT_ID
  || `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

if (metadata.backendBaseUrl !== baseUrl) {
  throw new Error(`Backend URL mismatch: env=${baseUrl} metadata=${metadata.backendBaseUrl}`);
}
if (!String(metadata.dbPath || '').includes('/.local/training-e2e/')) {
  throw new Error(`Refusing non-isolated DB path: ${metadata.dbPath}`);
}

const userId = Number(auth.user?.id);
if (!Number.isInteger(userId) || userId <= 0) {
  throw new Error('Auth import file does not contain a valid user id');
}

async function api(method, routePath, body, expectedStatuses = [200]) {
  const res = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
      'X-Language': 'en-US',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!expectedStatuses.includes(res.status)) {
    throw new Error(`${method} ${routePath} returned ${res.status}: ${JSON.stringify(payload).slice(0, 1200)}`);
  }
  return { status: res.status, payload };
}

function withDb(write) {
  const db = new Database(metadata.dbPath);
  try {
    db.pragma('foreign_keys = ON');
    return write(db);
  } finally {
    db.close();
  }
}

function seedTrainingProfile() {
  withDb((db) => {
    db.prepare(`
      UPDATE users
         SET first_name = 'Training E2E',
             language = 'en-US',
             timezone = 'Europe/Lisbon',
             tier = 'max',
             status = 'active'
       WHERE id = ?
    `).run(userId);

    db.prepare(`
      INSERT INTO subscriptions (user_id, plan, period, status, provider, current_period_start, current_period_end)
      VALUES (?, 'max', 'monthly', 'active', 'founder', datetime('now'), '2099-01-01T00:00:00.000Z')
      ON CONFLICT(user_id) DO UPDATE SET
        plan = excluded.plan,
        status = excluded.status,
        provider = excluded.provider,
        current_period_end = excluded.current_period_end,
        updated_at = datetime('now')
    `).run(userId);

    const profiles = [
      ['fitness', {
        experience_level: 'Intermediate',
        weekly_frequency: '5 days',
        training_goals: ['Run durability', 'Strength consistency'],
        injuries: 'none',
        available_equipment: 'Full gym',
        preferred_training_days: ['Monday', 'Tuesday', 'Thursday', 'Saturday'],
        blocked_days: ['Friday'],
      }],
      ['triathlon-gym', {
        training_age: '3 years',
        current_split: 'Upper lower',
        primary_goal: 'Support running while building strength',
        squat_1rm_kg: 115,
        bench_1rm_kg: 82,
        deadlift_1rm_kg: 150,
        sessions_per_week: '2',
        preferred_training_days: ['Monday', 'Thursday'],
        blocked_days: ['Friday'],
        equipment_access: 'Full commercial gym',
      }],
      ['triathlon-running', {
        weekly_mileage_km: 32,
        longest_recent_run_km: 14,
        easy_pace_min_per_km: '5:45',
        target_race: '10K',
        target_race_date: null,
        preferred_workouts: ['Easy runs', 'Tempo', 'Long run'],
        injury_history: 'none',
        weekly_availability_days: '5',
        preferred_training_days: ['Tuesday', 'Thursday', 'Saturday', 'Sunday'],
        blocked_days: ['Friday'],
      }],
      ['triathlon-cycling', {
        current_weekly_hours: 3,
        ftp_watts: 245,
        longest_recent_ride_minutes: 95,
        preferred_training_days: ['Wednesday', 'Sunday'],
        blocked_days: ['Friday'],
        equipment_access: 'Road bike and indoor trainer',
      }],
      ['triathlon-swim', {
        current_weekly_swims: 1,
        longest_recent_swim_meters: 1800,
        pool_access_days: ['Tuesday', 'Thursday'],
        preferred_training_days: ['Tuesday'],
        blocked_days: ['Friday'],
        constraints: ['Pool access only on weekdays'],
      }],
    ];

    for (const [profileType, data] of profiles) {
      db.prepare(`
        INSERT INTO user_profiles (user_id, profile_type, data)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, profile_type) DO UPDATE SET
          data = excluded.data,
          updated_at = datetime('now')
      `).run(userId, profileType, JSON.stringify(data));
    }
  });
}

function markSeededPlanName(planId, planName) {
  withDb((db) => {
    db.prepare(`
      UPDATE fitness_training_plans
         SET name = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?
    `).run(planName, planId, userId);
  });
}

function pinFirstSeededSessionToToday(planId) {
  const today = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone: 'Europe/Lisbon',
  }).format(new Date());
  withDb((db) => {
    const row = db.prepare(`
      SELECT id
        FROM training_sessions
       WHERE plan_id = ?
         AND status = 'pending'
       ORDER BY id ASC
       LIMIT 1
    `).get(planId);
    if (!row?.id) return;
    db.prepare(`
      UPDATE training_sessions
         SET day_of_week = ?, updated_at = datetime('now')
       WHERE id = ?
    `).run(today, row.id);
  });
}

function readTrainingPlanRowCount(planId) {
  return withDb((db) => {
    const row = db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans WHERE id = ? AND user_id = ?')
      .get(planId, userId);
    return Number(row?.count ?? 0);
  });
}

function readTrainingSessionRowCount(planId) {
  return withDb((db) => {
    const row = db.prepare('SELECT COUNT(*) AS count FROM training_sessions WHERE plan_id = ?')
      .get(planId);
    return Number(row?.count ?? 0);
  });
}

async function prepare() {
  seedTrainingProfile();

  const runId = env.NEXUS_TRAINING_E2E_RUN_ID;
  const planName = `Training E2E Active Plan ${runId}`;
  const request = {
    objective: `Training E2E active plan ${runId}`,
    durationWeeks: 2,
    preferredTime: '07:00',
    preferredCardioTime: '07:00',
    preferredStrengthTime: '18:00',
    sessionsPerWeek: 5,
    runSessionsPerWeek: 3,
    strengthSessionsPerWeek: 2,
    startPolicy: 'today',
    longWorkoutDay: 'Saturday',
    goalMode: 'continuous',
    trainingPriority: 'hybrid',
    twoADayPreference: 'never',
    calendarSource: null,
    notes: `Isolated iOS Training E2E active-plan seed for ${runId}. Calendar writes stay fixture-safe unless live lane is explicitly running.`,
    idempotencyKey: `training-e2e-ios-seed-${runId}-${seedAttemptId}`,
  };

  const created = await api('POST', '/api/v1/training/plan/generate', request, [201, 200]);
  const planId = Number(created.payload?.data?.planId);
  if (!Number.isInteger(planId) || planId <= 0) {
    throw new Error(`Plan seed did not return a valid planId: ${JSON.stringify(created.payload).slice(0, 1200)}`);
  }
  if (readTrainingPlanRowCount(planId) !== 1) {
    throw new Error(`Seeded plan ${planId} was not persisted in the isolated database`);
  }
  markSeededPlanName(planId, planName);
  pinFirstSeededSessionToToday(planId);
  const persistedSessionCount = readTrainingSessionRowCount(planId);
  if (persistedSessionCount < 1) {
    throw new Error(`Seeded plan ${planId} did not persist any sessions for iOS assertions`);
  }

  const home = await api('GET', '/api/v1/training/home');
  const weeks = await api('GET', '/api/v1/training/plan/weeks');
  const evidence = {
    schemaVersion: 'training_ios_seed.v1',
    runId,
    seedAttemptId,
    backendBaseUrl: baseUrl,
    dbPath: metadata.dbPath,
    sqlite: metadata.sqlite ?? null,
    planId,
    planName,
    generatedAt: new Date().toISOString(),
    homeStatus: home.status,
    weekCount: Array.isArray(weeks.payload?.data?.weeks) ? weeks.payload.data.weeks.length : null,
    totalSessions: created.payload?.data?.totalSessions ?? null,
    persistedSessionCount,
    calendarSource: created.payload?.data?.calendarSource ?? null,
    fallbackTemplateUsed: created.payload?.data?.fallbackTemplateUsed === true,
  };
  fs.writeFileSync(seedEvidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, evidencePath: seedEvidencePath, ...evidence }, null, 2));
}

async function cleanup() {
  if (!fs.existsSync(seedEvidencePath)) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no_seed_evidence' }, null, 2));
    return;
  }
  const evidence = JSON.parse(fs.readFileSync(seedEvidencePath, 'utf8'));
  const planId = Number(evidence.planId);
  if (!Number.isInteger(planId) || planId <= 0) {
    throw new Error(`Seed evidence did not contain a valid planId: ${seedEvidencePath}`);
  }
  const cancel = await api('POST', '/api/v1/training/plan/cancel', { planId }, [200, 404, 409]);
  const cleanupEvidence = {
    ...evidence,
    cleanedAt: new Date().toISOString(),
    cleanupStatus: cancel.status,
    cleanupPayloadCode: cancel.payload?.error?.code ?? null,
  };
  fs.writeFileSync(seedEvidencePath, JSON.stringify(cleanupEvidence, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, evidencePath: seedEvidencePath, planId, cleanupStatus: cancel.status }, null, 2));
}

if (mode === 'prepare') {
  await prepare();
} else if (mode === 'cleanup') {
  await cleanup();
} else {
  throw new Error(`Unknown mode "${mode}". Use prepare or cleanup.`);
}
