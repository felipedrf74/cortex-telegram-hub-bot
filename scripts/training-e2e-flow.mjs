#!/usr/bin/env node
// Fixture-safe HTTP lifecycle smoke for the isolated Training E2E backend.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const latestEnvPath = path.join(root, '.local/training-e2e/latest.env');

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
const flowAttemptId = process.env.NEXUS_TRAINING_E2E_FLOW_ATTEMPT_ID
  || `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

const metadataPath = path.join(env.NEXUS_TRAINING_E2E_ROOT, 'metadata.json');
const authPath = env.NEXUS_TRAINING_E2E_AUTH_FILE;
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
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

function seedTrainingProfile() {
  const db = new Database(metadata.dbPath);
  try {
    db.pragma('foreign_keys = ON');
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

    db.prepare("DELETE FROM user_oauth_tokens WHERE user_id = ? AND provider IN ('google', 'outlook')").run(userId);
  } finally {
    db.close();
  }
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function flattenSessions(planWeeks) {
  const weeks = Array.isArray(planWeeks) ? planWeeks : [];
  return weeks.flatMap((week) => Array.isArray(week.sessions) ? week.sessions : []);
}

function readPersistedSessions(planId) {
  const db = new Database(metadata.dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT id, status, session_type AS sessionType, title, duration_minutes AS durationMinutes
        FROM training_sessions
       WHERE plan_id = ?
       ORDER BY id ASC
    `).all(planId);
  } finally {
    db.close();
  }
}

function readCompletionFeedbackRows(planId) {
  const db = new Database(metadata.dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT ts.id AS sessionId,
             ts.title AS title,
             ts.session_type AS sessionType,
             ts.duration_minutes AS plannedMinutes,
             tc.rpe_overall AS rpe,
             tc.pain_score AS painScore,
             tc.pain_location AS painLocation,
             tc.energy_level AS energyLevel,
             tc.soreness_level AS sorenessLevel,
             tc.completed_duration_sec AS completedDurationSec,
             tc.completed_distance_meters AS completedDistanceMeters,
             tc.notes AS notes
        FROM training_completions tc
        JOIN training_sessions ts ON ts.id = tc.session_id
       WHERE tc.plan_id = ?
       ORDER BY tc.id ASC
    `).all(planId);
  } finally {
    db.close();
  }
}

function readTrainingPlanRowCount(planId) {
  const db = new Database(metadata.dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans WHERE id = ?').get(planId);
    return Number(row?.count ?? 0);
  } finally {
    db.close();
  }
}

function sessionDurationMinutes(session, fallback = 45) {
  const candidates = [
    session?.durationMinutes,
    session?.duration_minutes,
    session?.estimatedDurationMinutes,
    session?.estimated_duration_minutes,
    session?.duration,
  ];
  for (const candidate of candidates) {
    const number = Number(candidate);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return fallback;
}

function keySessionRank(session) {
  const haystack = `${session?.sessionType ?? ''} ${session?.type ?? ''} ${session?.title ?? ''}`.toLowerCase();
  if (/(long|tempo|threshold|interval|race|brick|quality)/.test(haystack)) return 0;
  if (/(strength|lift|gym)/.test(haystack)) return 1;
  return 2;
}

async function completeSessionWithFeedback(session, feedback) {
  const completed = await api('POST', '/api/v1/training/complete', {
    sessionId: session.id,
    ...feedback,
  });
  assert(completed.payload?.data?.completed === true, `Complete did not report completed=true for session ${session.id}`);
  assert(completed.payload?.data?.noActiveSession !== true, `Complete resolved no active session for explicit session ${session.id}`);
  return completed;
}

async function skipTrainingSession(session) {
  const skipped = await api('POST', '/api/v1/training/skip', { sessionId: session.id });
  assert(skipped.payload?.data?.skipped === true, `Skip did not report skipped=true for session ${session.id}`);
  assert(skipped.payload?.data?.noActiveSession !== true, `Skip resolved no active session for explicit session ${session.id}`);
  return skipped;
}

seedTrainingProfile();

const evidence = {
  runId: env.NEXUS_TRAINING_E2E_RUN_ID,
  flowAttemptId,
  backendBaseUrl: baseUrl,
  dbPath: metadata.dbPath,
  sqlite: metadata.sqlite ?? null,
  gitCommit: metadata.git?.shortCommit,
  imageIds: metadata.images,
  steps: [],
};

const beforeHome = await api('GET', '/api/v1/training/home');
evidence.steps.push({
  step: 'no_plan_home',
  status: beforeHome.status,
  hasActivePlan: Boolean(beforeHome.payload?.data?.activePlan || beforeHome.payload?.data?.today?.session),
});

const planRequest = {
  objective: 'Hybrid running and strength consistency',
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
  notes: 'Fixture-safe Training E2E smoke: no live calendar writes.',
};

const preview = await api('POST', '/api/v1/training/plan/preview', planRequest);
assert(preview.payload?.data?.status === 'preview', 'Plan preview did not return preview status');
assert(!Array.isArray(preview.payload?.data?.blockers) || preview.payload.data.blockers.length === 0, 'Plan preview returned blockers');
assert(
  Array.isArray(preview.payload?.data?.trainingLearningPath?.weeklyPath)
    && preview.payload.data.trainingLearningPath.weeklyPath.length > 0,
  'Plan preview did not include a learning path',
);
assert(
  Array.isArray(preview.payload?.data?.phaseRoadmap)
    && preview.payload.data.phaseRoadmap.some((week) => typeof week.weeklyLearningFocus === 'string' && week.weeklyLearningFocus.length > 0),
  'Plan preview roadmap did not include weekly learning focus',
);
evidence.steps.push({
  step: 'plan_preview',
  totalSessions: preview.payload.data.totalSessions,
  lintStatus: preview.payload.data.planLint?.status,
  fallbackTemplateUsed: preview.payload.data.fallbackTemplateUsed,
  learningWeeks: preview.payload.data.trainingLearningPath.weeklyPath.length,
});

const created = await api('POST', '/api/v1/training/plan/generate', {
  ...planRequest,
  idempotencyKey: `training-e2e-flow-${env.NEXUS_TRAINING_E2E_RUN_ID}-${flowAttemptId}`,
}, [201]);
const planId = Number(created.payload?.data?.planId);
assert(Number.isInteger(planId) && planId > 0, 'Plan create did not return planId');
assert(created.payload?.data?.fallbackTemplateUsed !== true, 'Plan create used fallback template');
assert(Number(created.payload?.data?.eventsCreated ?? 0) === 0, 'Fixture-safe plan create unexpectedly created calendar events');
assert((created.payload?.data?.calendarSource ?? null) === null, 'Fixture-safe plan create reported a calendar source');
assert(readTrainingPlanRowCount(planId) === 1, 'Generated plan was not persisted in the isolated database');
evidence.steps.push({
  step: 'plan_generate',
  planId,
  totalSessions: created.payload.data.totalSessions,
  eventsCreated: created.payload.data.eventsCreated,
  calendarSource: created.payload.data.calendarSource ?? null,
  lintStatus: created.payload.data.planLint?.status,
});

const calendarSync = await api('POST', '/api/v1/training/plan/sync-calendar', { calendarSource: null }, [200, 409, 503]);
const calendarSyncRetry = await api('POST', '/api/v1/training/plan/sync-calendar', { calendarSource: null }, [200, 409, 503]);
assert(
  calendarSync.payload?.error?.code === 'TRAINING_CALENDAR_SYNC_DISABLED',
  `Fixture-safe calendar sync did not fail closed with TRAINING_CALENDAR_SYNC_DISABLED: ${calendarSync.payload?.error?.code ?? 'none'}`,
);
assert(
  calendarSyncRetry.payload?.error?.code === 'TRAINING_CALENDAR_SYNC_DISABLED',
  `Fixture-safe calendar sync retry did not fail closed with TRAINING_CALENDAR_SYNC_DISABLED: ${calendarSyncRetry.payload?.error?.code ?? 'none'}`,
);
evidence.steps.push({
  step: 'calendar_sync_provider_safe',
  status: calendarSync.status,
  retryStatus: calendarSyncRetry.status,
  code: calendarSync.payload?.error?.code ?? null,
  retryCode: calendarSyncRetry.payload?.error?.code ?? null,
  syncStatus: calendarSync.payload?.data?.status ?? null,
  retrySyncStatus: calendarSyncRetry.payload?.data?.status ?? null,
});

const planWeeks = await api('GET', '/api/v1/training/plan/weeks');
const sessionsFromPlan = flattenSessions(planWeeks.payload?.data?.weeks);
const persistedSessions = readPersistedSessions(planId);
assert(
  persistedSessions.length >= Math.min(6, Number(created.payload.data.totalSessions ?? 6)),
  'Generated plan sessions were not persisted in the isolated database',
);
let sessions = persistedSessions.length >= 6 ? persistedSessions : sessionsFromPlan;
assert(sessions.length >= 6, 'Expected at least six sessions for completion, feedback, skip, and reflow coverage');
const [normalSession, easySession, hardPartialSession] = sessions;
const skipSessions = sessions
  .slice(3)
  .sort((a, b) => keySessionRank(a) - keySessionRank(b))
  .slice(0, 3);
assert(skipSessions.length >= 3, 'Expected at least three remaining sessions for repeated skip coverage');
evidence.steps.push({
  step: 'plan_read_model',
  weekCount: Array.isArray(planWeeks.payload?.data?.weeks) ? planWeeks.payload.data.weeks.length : null,
  sessionCount: sessions.length,
});

const normalComplete = await completeSessionWithFeedback(normalSession, {
  rpe: 6,
  actualDurationMinutes: Math.max(20, Math.min(60, sessionDurationMinutes(normalSession))),
  fatigueLevel: 3,
  sorenessLevel: 2,
  technicalSuccessScore: 8,
  notes: 'Fixture-safe E2E normal completion feedback.',
});

const easyComplete = await completeSessionWithFeedback(easySession, {
  rpe: 3,
  actualDurationMinutes: Math.max(20, Math.min(75, sessionDurationMinutes(easySession))),
  fatigueLevel: 1,
  sorenessLevel: 0,
  energyLevel: 9,
  notes: 'Fixture-safe E2E easy feedback: session felt controlled.',
});

const hardPlannedMinutes = sessionDurationMinutes(hardPartialSession);
const hardPartialComplete = await completeSessionWithFeedback(hardPartialSession, {
  rpe: 9,
  actualDurationMinutes: Math.max(5, Math.floor(hardPlannedMinutes * 0.45)),
  fatigueLevel: 8,
  sorenessLevel: 8,
  painScore: 5,
  painLocation: 'left knee',
  missedReason: 'Stopped early because discomfort increased.',
  technicalSuccessScore: 4,
  externalTrainingDeclared: false,
  notes: 'Fixture-safe E2E hard partial feedback with pain signal.',
});

const skipResults = [];
for (const session of skipSessions) {
  skipResults.push(await skipTrainingSession(session));
}

const planWeeksAfterFeedback = await api('GET', '/api/v1/training/plan/weeks');
let sessionsAfterFeedback = flattenSessions(planWeeksAfterFeedback.payload?.data?.weeks);
if (sessionsAfterFeedback.length < sessions.length) sessionsAfterFeedback = readPersistedSessions(planId);
assert(
  [normalSession, easySession, hardPartialSession].every((completedSession) =>
    sessionsAfterFeedback.find((s) => String(s.id) === String(completedSession.id))?.status === 'completed'),
  'Completed session statuses not reflected in plan read model',
);
assert(
  skipSessions.every((skippedSession) =>
    sessionsAfterFeedback.find((s) => String(s.id) === String(skippedSession.id))?.status === 'skipped'),
  'Skipped session statuses not reflected in plan read model',
);

const completionFeedbackRows = readCompletionFeedbackRows(planId);
assert(completionFeedbackRows.length >= 3, 'Expected persisted completion feedback rows');
assert(
  completionFeedbackRows.some((row) => Number(row.rpe) === 3 && Number(row.energyLevel) === 9),
  'Persisted feedback missing easy completion signal',
);
assert(
  completionFeedbackRows.some((row) => Number(row.rpe) === 6 && Number(row.sorenessLevel) === 2),
  'Persisted feedback missing normal completion signal',
);
assert(
  completionFeedbackRows.some((row) =>
    Number(row.rpe) === 9
    && Number(row.painScore) === 5
    && typeof row.painLocation === 'string'
    && row.painLocation.toLowerCase().includes('knee')
    && Number(row.completedDurationSec) < hardPlannedMinutes * 60 * 0.72),
  'Persisted feedback missing hard partial pain signal',
);
evidence.steps.push({
  step: 'feedback_variants_and_repeated_skips',
  completedSessionIds: [normalSession.id, easySession.id, hardPartialSession.id],
  skippedSessionIds: skipSessions.map((session) => session.id),
  persistedFeedbackRows: completionFeedbackRows.length,
  weeklyAdherenceAfterNormal: normalComplete.payload?.data?.weeklyAdherence ?? null,
  weeklyAdherenceAfterEasy: easyComplete.payload?.data?.weeklyAdherence ?? null,
  weeklyAdherenceAfterHardPartial: hardPartialComplete.payload?.data?.weeklyAdherence ?? null,
  weeklyAdherenceAfterFinalSkip: skipResults.at(-1)?.payload?.data?.weeklyAdherence ?? null,
});

const [home, today, week, history, weeklyActivity, cardioProgression, strengthProgression, loadSnapshot] = await Promise.all([
  api('GET', '/api/v1/training/home'),
  api('GET', '/api/v1/training/today'),
  api('GET', '/api/v1/training/week'),
  api('GET', '/api/v1/training/history'),
  api('GET', '/api/v1/training/activity/weekly'),
  api('GET', '/api/v1/training/progression/cardio?sport=running&weeks=8'),
  api('GET', '/api/v1/training/progression/strength?weeks=8'),
  api('GET', '/api/v1/training/load-snapshot'),
]);

const historyItems = history.payload?.data?.items ?? [];
assert(Array.isArray(historyItems), 'History payload did not return items');
assert(historyItems.some((item) => item.status === 'completed'), 'History missing completed item');
assert(historyItems.some((item) => item.status === 'partial'), 'History missing partial item from shortened hard session');
assert(historyItems.some((item) => item.status === 'skipped'), 'History missing skipped item');
assert(historyItems.filter((item) => item.status === 'skipped').length >= 3, 'History missing repeated skip signals');
evidence.steps.push({
  step: 'read_models_after_feedback',
  homeStatus: home.status,
  todayStatus: today.status,
  weekStatus: week.status,
  historyItems: historyItems.length,
  partialHistoryItems: historyItems.filter((item) => item.status === 'partial').length,
  skippedHistoryItems: historyItems.filter((item) => item.status === 'skipped').length,
  weeklyActivityStatus: weeklyActivity.status,
  cardioProgressionStatus: cardioProgression.status,
  strengthProgressionStatus: strengthProgression.status,
  loadSnapshotStatus: loadSnapshot.status,
});

const reflow = await api('POST', `/api/v1/training/sessions/${sessions[0].id}/reflow-preview`, { calendarSource: null }, [200, 400, 409, 503]);
assert(
  reflow.payload?.error?.code === 'NO_CALENDAR',
  `Fixture-safe reflow preview did not fail closed with NO_CALENDAR: ${reflow.payload?.error?.code ?? 'none'}`,
);
evidence.steps.push({
  step: 'reflow_preview_provider_safe',
  status: reflow.status,
  code: reflow.payload?.error?.code ?? null,
});

const cancel = await api('POST', '/api/v1/training/plan/cancel', { planId });
const remainingPlanRows = readTrainingPlanRowCount(planId);
assert(cancel.payload?.data?.cancelled === true, 'Plan cancel did not report cancelled=true');
assert(remainingPlanRows === 0, 'Cancelled plan still exists in the isolated database');
const homeAfterCancel = await api('GET', '/api/v1/training/home');
assert(
  !homeAfterCancel.payload?.data?.activePlan,
  'Home read model still reports an active plan after cancellation',
);
evidence.steps.push({
  step: 'cancel_cleanup_and_no_plan_recovery',
  status: cancel.status,
  removedPlans: cancel.payload?.data?.removedPlans ?? null,
  removedSessions: cancel.payload?.data?.removedSessions ?? null,
  remainingPlanRows,
  hasActivePlanAfterCancel: Boolean(homeAfterCancel.payload?.data?.activePlan),
});

const evidencePath = path.join(env.NEXUS_TRAINING_E2E_ROOT, 'training-flow-evidence.json');
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({
  ok: true,
  runId: evidence.runId,
  backendBaseUrl: evidence.backendBaseUrl,
  gitCommit: evidence.gitCommit,
  planId,
  sessionsChecked: sessions.length,
  evidencePath,
}, null, 2));
