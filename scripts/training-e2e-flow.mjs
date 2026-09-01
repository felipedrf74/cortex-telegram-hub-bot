#!/usr/bin/env node
// Fixture-safe HTTP lifecycle smoke for the isolated Training E2E backend.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { assertResolvedTrainingE2EPath } from './lib/training-e2e-contract.mjs';
import { waitForTrainingE2EProfilesVisible } from './lib/training-e2e-profile-visibility.mjs';
import { assertTrainingE2ERunFreshness } from './lib/training-e2e-run-freshness.mjs';

// fileURLToPath, NOT URL.pathname — the canonical checkout lives under a
// directory with a space ("Custom Connectors"), which URL.pathname leaves
// percent-encoded so every fs call misses.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inContainer = process.env.NEXUS_TRAINING_E2E_IN_CONTAINER === '1';
const latestEnvPath = path.join(root, '.local/training-e2e/latest.env');

function loadLatestEnv() {
  if (inContainer) return { ...process.env };
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
const apiBaseUrl = inContainer ? env.NEXUS_TRAINING_E2E_API_BASE_URL : baseUrl;
if (!baseUrl || !apiBaseUrl || (!inContainer && baseUrl.includes(':8200'))) {
  throw new Error(`Refusing non-isolated Training E2E backend URL: ${baseUrl}`);
}
const flowAttemptId = process.env.NEXUS_TRAINING_E2E_FLOW_ATTEMPT_ID
  || `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

const trainingE2EStateRoot = inContainer ? root : path.resolve(root, '.local/training-e2e');
const stateDir = assertResolvedTrainingE2EPath(
  trainingE2EStateRoot,
  env.NEXUS_TRAINING_E2E_ROOT,
  'state directory',
);
const metadataPath = path.join(stateDir, 'metadata.json');
const authPath = assertResolvedTrainingE2EPath(
  trainingE2EStateRoot,
  env.NEXUS_TRAINING_E2E_AUTH_FILE,
  'auth file',
);
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
if (metadata.runId !== env.NEXUS_TRAINING_E2E_RUN_ID) {
  throw new Error(`Training E2E run mismatch: env=${env.NEXUS_TRAINING_E2E_RUN_ID} metadata=${metadata.runId}`);
}
if (metadata.backendBaseUrl !== baseUrl) {
  throw new Error(`Backend URL mismatch: env=${baseUrl} metadata=${metadata.backendBaseUrl}`);
}
if (!inContainer && !env.NEXUS_TRAINING_E2E_GIT_DIR) {
  throw new Error('Training E2E Git directory is missing from the run environment');
}
function recordedBackendProvenance() {
  return {
    schemaVersion: 'training_e2e_backend_provenance.v1',
    environmentSchemaVersion: metadata.schemaVersion,
    verifiedAt: new Date().toISOString(),
    git: structuredClone(metadata.git),
    images: structuredClone(metadata.images),
  };
}
let backendProvenance = inContainer
  ? recordedBackendProvenance()
  : assertTrainingE2ERunFreshness({
      metadata,
      repoRoot: root,
      gitDir: env.NEXUS_TRAINING_E2E_GIT_DIR,
    });
const databasePath = inContainer
  ? assertResolvedTrainingE2EPath(trainingE2EStateRoot, path.join(stateDir, 'data', 'training-e2e.db'), 'database')
  : assertResolvedTrainingE2EPath(trainingE2EStateRoot, metadata.dbPath, 'database');

const userId = Number(auth.user?.id);
if (!Number.isInteger(userId) || userId <= 0) {
  throw new Error('Auth import file does not contain a valid user id');
}
const tenantId = Number(auth.user?.tenantId ?? userId);
if (!Number.isInteger(tenantId) || tenantId <= 0) {
  throw new Error('Auth import file does not contain a valid tenant id');
}

const fixtureState = {
  travelWindowId: null,
  coachReportId: null,
};

function seedTrainingProfile() {
  const db = new Database(databasePath);
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
    return profiles.map(([profileType, data]) => ({ profileType, data }));
  } finally {
    db.close();
  }
}

async function api(method, routePath, body, expectedStatuses = [200], extraHeaders = {}) {
  const res = await fetch(`${apiBaseUrl}${routePath}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
      'X-Language': 'en-US',
      ...extraHeaders,
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
  const db = new Database(databasePath, { readonly: true });
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
  const db = new Database(databasePath, { readonly: true });
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
             tc.completion_state AS completionState,
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
  const db = new Database(databasePath, { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans WHERE id = ?').get(planId);
    return Number(row?.count ?? 0);
  } finally {
    db.close();
  }
}

function readFirstRunPersistenceCounts() {
  const db = new Database(databasePath, { readonly: true });
  try {
    const planIds = `SELECT id FROM fitness_training_plans WHERE user_id = ?`;
    return {
      plans: Number(db.prepare(`SELECT COUNT(*) AS count FROM fitness_training_plans WHERE user_id = ?`).get(userId)?.count ?? 0),
      weeks: Number(db.prepare(`SELECT COUNT(*) AS count FROM training_weeks WHERE plan_id IN (${planIds})`).get(userId)?.count ?? 0),
      sessions: Number(db.prepare(`SELECT COUNT(*) AS count FROM training_sessions WHERE plan_id IN (${planIds})`).get(userId)?.count ?? 0),
      outbox: Number(db.prepare(`SELECT COUNT(*) AS count FROM event_outbox WHERE user_id = ? AND tenant_id = ?`).get(userId, tenantId)?.count ?? 0),
    };
  } finally {
    db.close();
  }
}

function deleteTrainingProfilesForFirstRun() {
  const db = new Database(databasePath);
  try {
    db.prepare('DELETE FROM user_profiles WHERE user_id = ?').run(userId);
    db.prepare("DELETE FROM api_cache WHERE cache_key LIKE 'training-home:' || ? || ':' || ? || ':%'").run(tenantId, userId);
  } finally {
    db.close();
  }
}

function readPlanActivation(planId) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.prepare(`
      SELECT id, status, start_date AS startDate
        FROM fitness_training_plans
       WHERE id = ? AND user_id = ?
    `).get(planId, userId) ?? null;
  } finally {
    db.close();
  }
}

function readActiveProjectionForRevision(revisionId) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.prepare(`
      SELECT refs.projection_plan_id AS planId,
             refs.pointer_version AS pointerVersion,
             plans.status,
             plans.start_date AS startDate,
             (SELECT COUNT(*) FROM training_weeks WHERE plan_id = refs.projection_plan_id) AS weekCount,
             (SELECT COUNT(*) FROM training_sessions WHERE plan_id = refs.projection_plan_id) AS sessionCount
        FROM training_active_plan_references refs
        JOIN fitness_training_plans plans
          ON plans.id = refs.projection_plan_id
         AND plans.user_id = refs.user_id
         AND plans.tenant_id = refs.tenant_id
       WHERE refs.active_revision_id = ?
         AND refs.user_id = ?
         AND refs.tenant_id = ?
       LIMIT 1
    `).get(revisionId, userId, tenantId) ?? null;
  } finally {
    db.close();
  }
}

function readPlanAgendaInvariant(planId, planWeeksPayload) {
  const db = new Database(databasePath, { readonly: true });
  try {
    const persistedSessionCount = Number(db.prepare(
      'SELECT COUNT(*) AS count FROM training_sessions WHERE plan_id = ?',
    ).get(planId)?.count ?? 0);
    const readModelSessionCount = flattenSessions(planWeeksPayload?.data?.weeks).length;
    const secretaryAgendaRows = Number(db.prepare(`
      SELECT COUNT(*) AS count
        FROM secretary_agenda_items
       WHERE owner_user_id = ?
         AND tenant_id = ?
         AND source_skill = 'training'
         AND source_entity_type = 'training_session'
         AND source_entity_id IN (
           SELECT CAST(id AS TEXT) FROM training_sessions WHERE plan_id = ?
         )
    `).get(userId, String(tenantId), planId)?.count ?? 0);
    return {
      persistedSessionCount,
      readModelSessionCount,
      secretaryAgendaRows,
      matches: persistedSessionCount > 0
        && persistedSessionCount === readModelSessionCount
        && secretaryAgendaRows === 0,
    };
  } finally {
    db.close();
  }
}

function readProviderIsolation(planId) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return {
      oauthRows: Number(db.prepare(
        "SELECT COUNT(*) AS count FROM user_oauth_tokens WHERE user_id = ? AND provider IN ('google', 'outlook')",
      ).get(userId)?.count ?? 0),
      eventMappings: Number(db.prepare(
        'SELECT COUNT(*) AS count FROM training_sessions WHERE plan_id = ? AND calendar_event_id IS NOT NULL',
      ).get(planId)?.count ?? 0),
      ownershipRows: Number(db.prepare(`
        SELECT COUNT(*) AS count
          FROM training_agenda_event_ownership
         WHERE plan_id = ? AND user_id = ? AND tenant_id = ?
      `).get(planId, userId, String(tenantId))?.count ?? 0),
    };
  } finally {
    db.close();
  }
}

function findStrengthReflowCandidate(planId) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.prepare(`
      SELECT w.id AS weekId,
             w.week_number AS weekNumber,
             p.start_date AS planStartDate,
             s.id AS sessionId,
             s.intensity_text AS intensityText,
             s.schedule_reason_code AS scheduleReasonCode,
             s.status AS status
        FROM fitness_training_plans p
        JOIN training_weeks w ON w.plan_id = p.id
        JOIN training_sessions s ON s.week_id = w.id AND s.plan_id = p.id
       WHERE p.id = ?
         AND p.user_id = ?
         AND s.status IN ('pending', 'scheduled', 'reflowed', 'compressed', 'capped')
         AND (
           lower(s.session_type) LIKE '%strength%'
           OR lower(s.session_type) LIKE '%gym%'
           OR lower(s.session_type) LIKE '%lift%'
         )
       ORDER BY w.week_number ASC, s.id ASC
       LIMIT 1
    `).get(planId, userId) ?? null;
  } finally {
    db.close();
  }
}

function readSessionReflowState(planId, sessionId) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.prepare(`
      SELECT id, intensity_text AS intensityText, schedule_reason_code AS scheduleReasonCode, status
        FROM training_sessions
       WHERE id = ? AND plan_id = ?
    `).get(sessionId, planId) ?? null;
  } finally {
    db.close();
  }
}

function trainingWeekDateRange(planStartDate, weekNumber) {
  const startMs = Date.parse(`${planStartDate}T00:00:00.000Z`) + Math.max(0, Number(weekNumber) - 1) * 7 * 86400000;
  return {
    startDate: new Date(startMs).toISOString().slice(0, 10),
    endDate: new Date(startMs + 6 * 86400000).toISOString().slice(0, 10),
  };
}

async function seedStaleReadiness() {
  const today = new Date().toISOString().slice(0, 10);
  const synced = await api('POST', '/api/v1/health-data/sync', {
    date: today,
    hrvMs: 60,
    totalSleepMinutes: 480,
    deepSleepMinutes: 90,
    remSleepMinutes: 120,
    restingHeartRate: 52,
  });
  assert(Number(synced.payload?.typesUpserted ?? 0) >= 4, 'Apple Health fixture sync did not persist all readiness factors');
  const db = new Database(databasePath);
  const staleAt = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  try {
    db.prepare(`
      UPDATE apple_health_data
         SET created_at = ?
       WHERE user_id = ? AND date = ? AND source_name = 'ios_app'
    `).run(staleAt, userId, today);
    db.prepare('DELETE FROM api_cache WHERE cache_key = ?').run(`readiness:${tenantId}:${userId}`);
    db.prepare('DELETE FROM api_cache WHERE cache_key = ?').run(`coach-briefing:${tenantId}:${userId}`);
    db.prepare("DELETE FROM api_cache WHERE cache_key LIKE 'training-home:' || ? || ':' || ? || ':%'").run(tenantId, userId);
    return { staleAt };
  } finally {
    db.close();
  }
}

function seedDegradedCoach() {
  const db = new Database(databasePath);
  try {
    const report = db.prepare(`
      INSERT INTO report_documents_scoped
        (tenant_id, user_id, type, title, summary, document_json, source_job)
      VALUES (?, ?, 'coach_briefing', 'Fixture degraded coach read',
              'Some fixture inputs were unavailable.', ?, 'training_e2e_fixture')
    `).run(tenantId, userId, JSON.stringify({
      message: 'Some fixture inputs were unavailable.',
      recommendations: [],
      errors: ['fixture_dependency_unavailable'],
    }));
    fixtureState.coachReportId = Number(report.lastInsertRowid);
  } finally {
    db.close();
  }
}

function cleanupTrainingE2EFixtures() {
  const db = new Database(databasePath);
  try {
    if (fixtureState.travelWindowId !== null) {
      db.prepare('DELETE FROM travel_windows WHERE id = ? AND user_id = ? AND tenant_id = ?')
        .run(fixtureState.travelWindowId, userId, tenantId);
    }
    db.prepare("DELETE FROM apple_health_data WHERE user_id = ? AND source_name IN ('training_e2e', 'ios_app')").run(userId);
    if (fixtureState.coachReportId !== null) {
      db.prepare("DELETE FROM report_documents_scoped WHERE id = ? AND tenant_id = ? AND user_id = ? AND source_job = 'training_e2e_fixture'")
        .run(fixtureState.coachReportId, tenantId, userId);
    }
    db.prepare('DELETE FROM api_cache WHERE cache_key = ?').run(`readiness:${tenantId}:${userId}`);
    db.prepare('DELETE FROM api_cache WHERE cache_key = ?').run(`coach-briefing:${tenantId}:${userId}`);
    db.prepare("DELETE FROM api_cache WHERE cache_key LIKE 'training-home:' || ? || ':' || ? || ':%'").run(tenantId, userId);
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
  const expectedState = feedback.completionState ?? feedback.status ?? 'completed';
  const completed = await api('POST', '/api/v1/training/complete', {
    sessionId: session.id,
    ...feedback,
  });
  assert(
    completed.payload?.data?.completionState === expectedState,
    `Complete returned ${completed.payload?.data?.completionState ?? 'no state'} instead of ${expectedState} for session ${session.id}`,
  );
  assert(
    completed.payload?.data?.completed === (expectedState === 'completed'),
    `Complete returned an inconsistent completed flag for ${expectedState} session ${session.id}`,
  );
  assert(completed.payload?.data?.noActiveSession !== true, `Complete resolved no active session for explicit session ${session.id}`);
  return completed;
}

async function skipTrainingSession(session) {
  const skipped = await api('POST', '/api/v1/training/skip', { sessionId: session.id });
  assert(skipped.payload?.data?.skipped === true, `Skip did not report skipped=true for session ${session.id}`);
  assert(skipped.payload?.data?.noActiveSession !== true, `Skip resolved no active session for explicit session ${session.id}`);
  return skipped;
}

const evidence = {
  schemaVersion: 'training_e2e_flow.v2',
  runId: metadata.runId,
  flowAttemptId,
  baseUrl,
  backendBaseUrl: baseUrl,
  backendProvenance,
  dbPath: metadata.dbPath,
  sqlite: metadata.sqlite ?? null,
  gitCommit: metadata.git?.shortCommit,
  imageIds: metadata.images,
  steps: [],
};

const revisionCandidateRequest = {
  planMode: 'continuous',
  goal: 'general_fitness',
  discipline: 'strength',
  horizonWeeks: 4,
  profile: {
    experienceLevel: 'novice',
    sessionsPerWeek: 3,
    sessionDurationMinutes: 45,
    availableDays: ['monday', 'wednesday', 'friday'],
    equipmentIds: [],
    location: 'home',
    preferences: ['Fixture-safe Training E2E: no live calendar writes.'],
  },
};

let cleanupPlanId = null;
async function runFlow() {
let primaryError = null;
try {
deleteTrainingProfilesForFirstRun();
const firstRunBefore = readFirstRunPersistenceCounts();
assert(
  Object.values(firstRunBefore).every((count) => count === 0),
  `First-run fixture was not empty before candidate validation: ${JSON.stringify(firstRunBefore)}`,
);
const firstRunCandidate = await api(
  'POST',
  '/api/v1/training/plan/candidates',
  { planMode: 'continuous' },
  [400],
  { 'Idempotency-Key': `training-e2e-first-run-${env.NEXUS_TRAINING_E2E_RUN_ID}-${flowAttemptId}` },
);
const firstRunAfter = readFirstRunPersistenceCounts();
assert(
  firstRunCandidate.payload?.error?.code === 'TRAINING_REVISION_PROFILE_REQUIRED',
  `First-run candidate returned ${firstRunCandidate.payload?.error?.code ?? 'no error'} instead of TRAINING_REVISION_PROFILE_REQUIRED`,
);
assert(
  Object.values(firstRunAfter).every((count) => count === 0),
  `First-run candidate validation persisted plan state: ${JSON.stringify(firstRunAfter)}`,
);
evidence.steps.push({
  step: 'first_run_profile_blocker',
  status: 'pass',
  errorCode: firstRunCandidate.payload.error.code,
  persistenceBefore: firstRunBefore,
  persistenceAfter: firstRunAfter,
});

const seededTrainingProfiles = seedTrainingProfile();
await waitForTrainingE2EProfilesVisible({
  api,
  expectedProfiles: seededTrainingProfiles,
});

const beforeHome = await api('GET', '/api/v1/training/home');
const hasActivePlanBefore = Boolean(beforeHome.payload?.data?.activePlan || beforeHome.payload?.data?.today?.session);
assert(!hasActivePlanBefore, 'Fresh Training E2E home unexpectedly reported an active plan');
evidence.steps.push({
  step: 'no_plan_home',
  status: 'pass',
  httpStatus: beforeHome.status,
  hasActivePlan: hasActivePlanBefore,
});

const candidate = await api(
  'POST',
  '/api/v1/training/plan/candidates',
  revisionCandidateRequest,
  [201],
  { 'Idempotency-Key': `training-e2e-candidate-${env.NEXUS_TRAINING_E2E_RUN_ID}-${flowAttemptId}` },
);
const candidateRevision = candidate.payload?.data?.candidateSet?.candidates?.[0];
assert(typeof candidateRevision?.revisionId === 'string', 'Plan candidate did not return revisionId');
assert(typeof candidateRevision?.decisionId === 'string', 'Plan candidate did not return Decision Center id');
assert(candidateRevision?.lifecycleState === 'PENDING_REVIEW', 'Plan candidate was not pending review');
assert(candidateRevision?.approvalState === 'PENDING', 'Plan candidate was not pending approval');

const candidateDecision = await api(
  'GET',
  `/api/v1/decisions/${encodeURIComponent(candidateRevision.decisionId)}`,
);
const candidateDecisionItem = candidateDecision.payload?.data?.item;
assert(Number.isSafeInteger(candidateDecisionItem?.recordVersion), 'Plan candidate decision record version is missing');
assert(typeof candidateDecisionItem?.contextVersion === 'string', 'Plan candidate decision context version is missing');
const candidateApproval = await api(
  'POST',
  `/api/v1/decisions/${encodeURIComponent(candidateRevision.decisionId)}/review`,
  {
    outcome: 'approve',
    idempotencyKey: `training-e2e-candidate-review-${env.NEXUS_TRAINING_E2E_RUN_ID}-${flowAttemptId}`,
    expectedVersion: candidateDecisionItem.recordVersion,
    strongConfirmationText: 'CONFIRM',
  },
);
const approvedCandidateDecisionItem = candidateApproval.payload?.data?.item;
assert(approvedCandidateDecisionItem?.decisionState === 'approved', 'Decision Center did not strongly approve the plan candidate');
assert(Number.isSafeInteger(approvedCandidateDecisionItem?.recordVersion), 'Approved plan candidate record version is missing');
assert(typeof approvedCandidateDecisionItem?.contextVersion === 'string', 'Approved plan candidate context version is missing');
const candidateActivation = await api(
  'POST',
  `/api/v1/decisions/${encodeURIComponent(candidateRevision.decisionId)}/actions`,
  {
    actionId: 'activate_training_plan_revision',
    idempotencyKey: `training-e2e-candidate-activate-${env.NEXUS_TRAINING_E2E_RUN_ID}-${flowAttemptId}`,
    expectedVersion: approvedCandidateDecisionItem.recordVersion,
    contextVersion: approvedCandidateDecisionItem.contextVersion,
  },
);
assert(candidateActivation.payload?.data?.status === 'succeeded', 'Decision Center did not activate the plan candidate');
const activeProjection = readActiveProjectionForRevision(candidateRevision.revisionId);
const planId = Number(activeProjection?.planId);
assert(Number.isInteger(planId) && planId > 0, 'Plan candidate activation did not persist a canonical planId');
cleanupPlanId = planId;
assert(readTrainingPlanRowCount(planId) === 1, 'Activated candidate plan was not persisted in the isolated database');
const activatedPlan = readPlanActivation(planId);
assert(activatedPlan?.status === 'active', `Candidate plan was not activated: ${activatedPlan?.status ?? 'missing'}`);
assert(Number(activeProjection?.sessionCount ?? 0) >= 6, 'Candidate activation did not persist enough sessions for the E2E flow');
evidence.steps.push({
  step: 'plan_candidate_review_activate',
  status: 'pass',
  planId,
  revisionId: candidateRevision.revisionId,
  decisionId: candidateRevision.decisionId,
  persistedStatus: activatedPlan.status,
  weekCount: activeProjection.weekCount,
  totalSessions: activeProjection.sessionCount,
  pointerVersion: activeProjection.pointerVersion,
  activationStatus: candidateActivation.payload.data.status,
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
  status: 'pass',
  httpStatus: calendarSync.status,
  retryStatus: calendarSyncRetry.status,
  code: calendarSync.payload?.error?.code ?? null,
  retryCode: calendarSyncRetry.payload?.error?.code ?? null,
  syncStatus: calendarSync.payload?.data?.status ?? null,
  retrySyncStatus: calendarSyncRetry.payload?.data?.status ?? null,
});

const planWeeks = await api('GET', '/api/v1/training/plan/weeks');
const sessionsFromPlan = flattenSessions(planWeeks.payload?.data?.weeks);
const persistedSessions = readPersistedSessions(planId);
const planAgenda = readPlanAgendaInvariant(planId, planWeeks.payload);
assert(
  planAgenda.matches,
  `Plan/read-model/agenda invariant failed: ${JSON.stringify(planAgenda)}`,
);
const isolationBeforeReflow = readProviderIsolation(planId);
assert(
  Object.values(isolationBeforeReflow).every((count) => count === 0),
  `Fixture-safe plan acquired provider state: ${JSON.stringify(isolationBeforeReflow)}`,
);
assert(
  persistedSessions.length >= Math.min(6, Number(activeProjection.sessionCount ?? 6)),
  'Activated candidate sessions were not persisted in the isolated database',
);
let sessions = persistedSessions.length >= 6 ? persistedSessions : sessionsFromPlan;
assert(sessions.length >= 6, 'Expected at least six sessions for completion, feedback, skip, and reflow coverage');
evidence.steps.push({
  step: 'plan_read_model',
  status: 'pass',
  weekCount: Array.isArray(planWeeks.payload?.data?.weeks) ? planWeeks.payload.data.weeks.length : null,
  sessionCount: sessions.length,
  planAgenda,
});

const reflowCandidate = findStrengthReflowCandidate(planId);
const observedStrengthSessions = persistedSessions
  .filter((session) => /(strength|gym|lift)/i.test(String(session.sessionType ?? '')))
  .map((session) => ({
    id: session.id,
    status: session.status,
    sessionType: session.sessionType,
  }));
assert(
  reflowCandidate,
  `Expected an actionable strength session for a real fixture-backed reflow; observed=${JSON.stringify(observedStrengthSessions)}`,
);
const reflowDates = trainingWeekDateRange(reflowCandidate.planStartDate, reflowCandidate.weekNumber);
const travelWindow = await api('POST', '/api/v1/training/week/travel', {
  ...reflowDates,
  idempotencyKey: `training-e2e-travel-${env.NEXUS_TRAINING_E2E_RUN_ID}-${flowAttemptId}`,
  equipmentProfile: 'hotel_only',
  timeZoneShiftHours: 4,
  sleepDisruptionExpected: true,
  availableSessionDurationMinutes: 35,
  notes: `Fixture-only reflow trigger ${flowAttemptId}`,
}, [201]);
fixtureState.travelWindowId = Number(travelWindow.payload?.data?.window?.id);
assert(
  Number.isInteger(fixtureState.travelWindowId) && fixtureState.travelWindowId > 0,
  'Travel fixture did not return an id',
);

const reflowPreview = await api('POST', `/api/v1/training/week/${reflowCandidate.weekId}/reflow`, {
  planId,
  mode: 'preview',
  trigger: 'fixture_travel_reflow',
});
assert(reflowPreview.payload?.data?.outcome === 'preview', 'Fixture reflow preview did not return preview outcome');
assert(reflowPreview.payload?.data?.proposalId === null, 'Fixture reflow preview created a proposal');
assert(reflowPreview.payload?.data?.adaptationId === null, 'Fixture reflow preview created an adaptation');
assert(
  Array.isArray(reflowPreview.payload?.data?.scenario?.modifiers)
    && reflowPreview.payload.data.scenario.modifiers.includes('travel_adjustment'),
  'Fixture reflow preview did not classify the travel adjustment',
);
assert(
  Array.isArray(reflowPreview.payload?.data?.actions)
    && reflowPreview.payload.data.actions.some((action) =>
      action?.type === 'downgrade_intensity'
      && String(action?.sessionId) === String(reflowCandidate.sessionId)
      && action?.targetCeiling === 'tempo'
      && action?.reasonCode === 'travel_equipment_limited'),
  'Fixture reflow preview did not produce the expected strength downgrade action',
);

// Seed the stale HealthKit rows before the real reflow mutation. The apply
// path owns canonical Training cache invalidation, so this proves that an
// already memoized readiness snapshot is evicted in the backend process
// before the later read rather than bypassing production cache semantics.
const staleFixture = await seedStaleReadiness();
const reflowIdempotencyKey = `training-e2e-reflow-${env.NEXUS_TRAINING_E2E_RUN_ID}-${flowAttemptId}`;
const reflowApply = await api('POST', `/api/v1/training/week/${reflowCandidate.weekId}/reflow`, {
  planId,
  mode: 'apply',
  trigger: 'fixture_travel_reflow',
  previewId: reflowPreview.payload.data.previewId,
  idempotencyKey: reflowIdempotencyKey,
}, [202]);
assert(reflowApply.payload?.data?.outcome === 'proposal_created', 'Fixture reflow did not create a proposal');
assert(reflowApply.payload?.data?.adaptationId === null, 'Fixture proposal mutated the plan before approval');
assert(typeof reflowApply.payload?.data?.proposalId === 'string', 'Fixture reflow proposal id is missing');
assert(typeof reflowApply.payload?.data?.decisionId === 'string', 'Fixture reflow Decision Center id is missing');
const reflowStateBeforeApproval = readSessionReflowState(planId, reflowCandidate.sessionId);
const decisionId = reflowApply.payload.data.decisionId;
const decision = await api('GET', `/api/v1/decisions/${encodeURIComponent(decisionId)}`);
const decisionItem = decision.payload?.data?.item;
assert(Number.isSafeInteger(decisionItem?.recordVersion), 'Fixture reflow decision record version is missing');
assert(typeof decisionItem?.contextVersion === 'string', 'Fixture reflow decision context version is missing');
const approval = await api('POST', `/api/v1/decisions/${encodeURIComponent(decisionId)}/review`, {
  outcome: 'approve',
  idempotencyKey: `training-e2e-reflow-review-${env.NEXUS_TRAINING_E2E_RUN_ID}-${flowAttemptId}`,
  expectedVersion: decisionItem.recordVersion,
  strongConfirmationText: 'CONFIRM',
});
const approvedDecisionItem = approval.payload?.data?.item;
assert(approvedDecisionItem?.decisionState === 'approved', 'Decision Center did not record strong approval for fixture reflow');
assert(Number.isSafeInteger(approvedDecisionItem?.recordVersion), 'Approved fixture reflow record version is missing');
assert(typeof approvedDecisionItem?.contextVersion === 'string', 'Approved fixture reflow context version is missing');
const activation = await api('POST', `/api/v1/decisions/${encodeURIComponent(decisionId)}/actions`, {
  actionId: 'activate_training_coach_v2_proposal',
  idempotencyKey: `training-e2e-reflow-approval-${env.NEXUS_TRAINING_E2E_RUN_ID}-${flowAttemptId}`,
  expectedVersion: approvedDecisionItem.recordVersion,
  contextVersion: approvedDecisionItem.contextVersion,
});
assert(activation.payload?.data?.status === 'succeeded', 'Decision Center did not activate the fixture reflow');
const reflowReplay = await api('POST', `/api/v1/training/week/${reflowCandidate.weekId}/reflow`, {
  planId,
  mode: 'apply',
  trigger: 'fixture_travel_reflow',
  previewId: reflowPreview.payload.data.previewId,
  idempotencyKey: reflowIdempotencyKey,
});
assert(reflowReplay.payload?.data?.outcome === 'replayed', 'Fixture reflow replay was not idempotent');
assert(reflowReplay.payload?.data?.proposalId === reflowApply.payload.data.proposalId, 'Fixture reflow replay changed proposal identity');
const reflowReadback = readSessionReflowState(planId, reflowCandidate.sessionId);
const candidateActionReasonCodes = reflowPreview.payload.data.actions
  .filter((action) => String(action?.sessionId) === String(reflowCandidate.sessionId))
  .map((action) => action?.reasonCode)
  .filter((reasonCode) => typeof reasonCode === 'string' && reasonCode.length > 0);
assert(
  reflowReadback?.intensityText !== reflowStateBeforeApproval?.intensityText,
  `Fixture typed reflow did not change intensity from ${reflowStateBeforeApproval?.intensityText ?? 'missing'}`,
);
assert(
  candidateActionReasonCodes.includes(reflowReadback?.scheduleReasonCode),
  `Fixture reflow rationale ${reflowReadback?.scheduleReasonCode ?? 'missing'} was not one of the executed action reasons: ${candidateActionReasonCodes.join(', ')}`,
);
const isolationAfterReflow = readProviderIsolation(planId);
assert(
  Object.values(isolationAfterReflow).every((count) => count === 0),
  `Fixture reflow acquired provider state: ${JSON.stringify(isolationAfterReflow)}`,
);
evidence.steps.push({
  step: 'proposal_first_fixture_reflow_activation',
  status: 'pass',
  travelWindowId: fixtureState.travelWindowId,
  weekId: reflowCandidate.weekId,
  sessionId: reflowCandidate.sessionId,
  previewActionCount: reflowPreview.payload.data.actions.length,
  proposalId: reflowApply.payload.data.proposalId,
  decisionId,
  activationStatus: activation.payload.data.status,
  replayOutcome: reflowReplay.payload.data.outcome,
  readback: reflowReadback,
  candidateActionReasonCodes,
  providerIsolation: isolationAfterReflow,
});

// Reflow may change canonical duration and intensity. Resolve the mutation
// targets again from durable state so feedback percentages are based on the
// plan the athlete actually sees, not the pre-reflow DTO retained above.
const refreshedSessions = readPersistedSessions(planId);
const actionableSessions = refreshedSessions.filter((session) =>
  ['pending', 'scheduled', 'reflowed'].includes(String(session.status).toLowerCase()));
const normalSession = actionableSessions[0];
const easySession = actionableSessions[1];
const hardPartialSession = actionableSessions[2];
const skipSessions = actionableSessions
  .slice(3)
  .sort((a, b) => keySessionRank(a) - keySessionRank(b))
  .slice(0, 3);
assert(
  normalSession && easySession && hardPartialSession && skipSessions.length >= 3,
  `Post-reflow durable state has only ${actionableSessions.length} actionable completion/skip targets`,
);

seedDegradedCoach();
const [staleReadiness, degradedHome] = await Promise.all([
  api('GET', '/api/v1/training/readiness'),
  api('GET', '/api/v1/training/home'),
]);
const readinessDataAsOfMs = Date.parse(staleReadiness.payload?.data?.dataAsOf ?? '');
assert(staleReadiness.payload?.data?.source === 'apple_health', 'Stale readiness did not use the Apple Health fixture');
assert(Number(staleReadiness.payload?.data?.score ?? 0) > 0, 'Stale readiness did not return a measured score');
assert(
  Number.isFinite(readinessDataAsOfMs) && Date.now() - readinessDataAsOfMs > 36 * 3600 * 1000,
  `Stale readiness dataAsOf was not older than 36h: ${staleReadiness.payload?.data?.dataAsOf ?? 'missing'}`,
);
assert(degradedHome.payload?.data?.meta?.isStale === true, 'Degraded Home did not mark meta.isStale');
assert(degradedHome.payload?.data?.meta?.isFallback === true, 'Degraded Home did not mark meta.isFallback');
assert(
  Array.isArray(degradedHome.payload?.data?.meta?.reasonCodes)
    && degradedHome.payload.data.meta.reasonCodes.includes('COACH_STALE'),
  'Degraded Home did not include COACH_STALE',
);
assert(degradedHome.payload?.data?.coachReview?.state === 'degraded', 'Degraded Home did not render degraded coach review');
evidence.steps.push({
  step: 'stale_readiness_degraded',
  status: 'pass',
  staleAt: staleFixture.staleAt,
  readinessSource: staleReadiness.payload.data.source,
  readinessDataAsOf: staleReadiness.payload.data.dataAsOf,
  homeReasonCodes: degradedHome.payload.data.meta.reasonCodes,
  coachReviewState: degradedHome.payload.data.coachReview.state,
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
  // F18's released envelope carries the disposition explicitly. Duration is
  // still asserted below, but the durable state must not depend on a client
  // and server deriving the same threshold from differently shaped DTOs.
  completionState: 'partial',
  status: 'partial',
  rpe: 9,
  actualDurationMinutes: Math.max(5, Math.floor(hardPlannedMinutes * 0.45)),
  fatigueLevel: 8,
  sorenessLevel: 8,
  painScore: 5,
  painLocation: 'left knee',
  missedReason: 'Stopped early because discomfort increased.',
  durationFeedback: 'too_short',
  discomfortFlag: true,
  discomfortFlags: ['pain'],
  discomfortLocations: ['left_knee'],
  discomfortDetails: 'Stopped when left-knee discomfort increased.',
  feltTooHard: true,
  feltTooShort: true,
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
  [normalSession, easySession].every((completedSession) =>
    sessionsAfterFeedback.find((s) => String(s.id) === String(completedSession.id))?.status === 'completed')
    && sessionsAfterFeedback.find((s) => String(s.id) === String(hardPartialSession.id))?.status === 'partial',
  'Completed/partial session dispositions not reflected in plan read model',
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
    && row.completionState === 'partial'
    && Number(row.painScore) === 5
    && typeof row.painLocation === 'string'
    && row.painLocation.toLowerCase().includes('knee')
    && Number(row.completedDurationSec) < hardPlannedMinutes * 60 * 0.72),
  'Persisted feedback missing hard partial pain signal',
);
evidence.steps.push({
  step: 'feedback_variants_and_repeated_skips',
  status: 'pass',
  completedSessionIds: [normalSession.id, easySession.id],
  partialSessionIds: [hardPartialSession.id],
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
  step: 'today_plan_progress_read_models',
  status: 'pass',
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

const reflow = await api('POST', `/api/v1/training/sessions/${sessions[0].id}/reflow-preview`, { calendarSource: null }, [409]);
assert(
  reflow.payload?.error?.code === 'TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED',
  `Revision-owned legacy reflow preview returned ${reflow.payload?.error?.code ?? 'none'} instead of TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED`,
);
evidence.steps.push({
  step: 'revision_owned_legacy_reflow_guard',
  status: 'pass',
  httpStatus: reflow.status,
  errorCode: reflow.payload?.error?.code ?? null,
});

const cancel = await api('POST', '/api/v1/training/plan/cancel', { planId }, [409]);
const remainingPlanRows = readTrainingPlanRowCount(planId);
assert(
  cancel.payload?.error?.code === 'TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED',
  `Revision-owned cancel returned ${cancel.payload?.error?.code ?? 'no error'} instead of TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED`,
);
assert(remainingPlanRows === 1, 'Revision-owned cancel mutated the active plan');
cleanupPlanId = null;
const homeAfterCancel = await api('GET', '/api/v1/training/home');
evidence.steps.push({
  step: 'revision_owned_legacy_cancel_guard',
  status: 'pass',
  httpStatus: cancel.status,
  errorCode: cancel.payload.error.code,
  remainingPlanRows,
  homeReadStatus: homeAfterCancel.status,
  hasActionableHomeSessionAfterBlockedCancel: Boolean(
    homeAfterCancel.payload?.data?.activePlan || homeAfterCancel.payload?.data?.today?.session,
  ),
});

// The lifecycle can be long enough for a worktree edit, container recreation,
// or mutable image-tag replacement to occur after startup. Re-resolve every
// mutable identity immediately before publishing evidence consumed by the
// persona/quality stage.
backendProvenance = inContainer
  ? recordedBackendProvenance()
  : assertTrainingE2ERunFreshness({
      metadata,
      repoRoot: root,
      gitDir: env.NEXUS_TRAINING_E2E_GIT_DIR,
    });
evidence.backendProvenance = backendProvenance;
const evidencePath = path.join(stateDir, 'training-flow-evidence.json');
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
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  const cleanupErrors = [];
  try {
    cleanupTrainingE2EFixtures();
  } catch (error) {
    cleanupErrors.push(`fixture cleanup: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (cleanupPlanId !== null) {
    try {
      if (readTrainingPlanRowCount(cleanupPlanId) > 0) {
        const cleanup = await api('POST', '/api/v1/training/plan/cancel', { planId: cleanupPlanId }, [200, 404, 409]);
        const revisionGuarded = cleanup.status === 409
          && cleanup.payload?.error?.code === 'TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED';
        if (cleanup.status !== 404 && cleanup.payload?.data?.cancelled !== true && !revisionGuarded) {
          cleanupErrors.push(`plan ${cleanupPlanId} cleanup did not report cancelled=true`);
        }
      }
    } catch (error) {
      cleanupErrors.push(`plan ${cleanupPlanId} cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (cleanupErrors.length > 0) {
    if (primaryError) {
      console.error(`Training E2E cleanup also failed: ${cleanupErrors.join('; ')}`);
    } else {
      throw new Error(`Training E2E cleanup failed: ${cleanupErrors.join('; ')}`);
    }
  }
}
}

await runFlow();
