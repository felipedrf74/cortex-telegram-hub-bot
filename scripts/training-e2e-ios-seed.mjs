#!/usr/bin/env node
// Seed or clean up an active Training plan for isolated iOS simulator E2E.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

// fileURLToPath, NOT URL.pathname — the canonical checkout lives under a
// directory with a space ("Custom Connectors"), which URL.pathname leaves
// percent-encoded so every fs call misses.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const latestEnvPath = path.join(root, '.local/training-e2e/latest.env');
const mode = process.argv[2] || 'prepare';
const inContainer = process.env.NEXUS_TRAINING_E2E_IN_CONTAINER === '1';

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

const env = inContainer ? process.env : loadLatestEnv();
const baseUrl = env.NEXUS_TRAINING_E2E_BASE_URL;
if (!baseUrl || baseUrl.includes(':8200')) {
  throw new Error(`Refusing non-isolated Training E2E backend URL: ${baseUrl}`);
}
const apiBaseUrl = inContainer
  ? env.NEXUS_TRAINING_E2E_API_BASE_URL
  : baseUrl;
if (!apiBaseUrl || (inContainer && apiBaseUrl !== 'http://127.0.0.1:8200')) {
  throw new Error(`Invalid Training E2E seed API URL for this lock domain: ${apiBaseUrl}`);
}

const metadataPath = path.join(env.NEXUS_TRAINING_E2E_ROOT, 'metadata.json');
const authPath = env.NEXUS_TRAINING_E2E_AUTH_FILE;
const seedEvidencePath = path.join(env.NEXUS_TRAINING_E2E_ROOT, 'training-ios-seed-evidence.json');
const clarificationEvidencePath = path.join(
  env.NEXUS_TRAINING_E2E_ROOT,
  'training-ios-clarification-evidence.json',
);
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
if (metadata.sqlite?.fixtureLockDomain === 'container' && !inContainer) {
  throw new Error('Refusing host execution: this Training E2E fixture lock domain belongs to the backend container');
}
if (inContainer && metadata.sqlite?.fixtureLockDomain !== 'container') {
  throw new Error(`Container seed requires fixtureLockDomain=container; received ${metadata.sqlite?.fixtureLockDomain ?? 'missing'}`);
}
const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
const runtimeDbPath = inContainer
  ? path.join(env.NEXUS_TRAINING_E2E_ROOT, 'data', 'training-e2e.db')
  : metadata.dbPath;
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
const tenantId = Number(auth.user?.tenantId ?? userId);
if (!Number.isInteger(tenantId) || tenantId <= 0) {
  throw new Error('Auth import file does not contain a valid tenant id');
}

function readBackendProvenance() {
  const provenance = {
    schemaVersion: metadata.schemaVersion,
    runId: metadata.runId,
    runPolicy: {
      mode: metadata.runPolicy?.mode ?? null,
      qualifying: metadata.runPolicy?.qualifying === true,
    },
    git: {
      commit: metadata.git?.commit ?? null,
      baseCommit: metadata.git?.baseCommit ?? null,
      dirtyTreeDiffSha256: metadata.git?.dirtyTreeDiffSha256 ?? null,
    },
    images: {
      backend: {
        name: metadata.images?.backend?.name ?? null,
        builtImageId: metadata.images?.backend?.builtImageId ?? null,
        actualContainerImageId: metadata.images?.backend?.actualContainerImageId ?? null,
      },
      contentEngine: {
        name: metadata.images?.contentEngine?.name ?? null,
        builtImageId: metadata.images?.contentEngine?.builtImageId ?? null,
        actualContainerImageId: metadata.images?.contentEngine?.actualContainerImageId ?? null,
      },
    },
  };
  const sha40 = /^[a-f0-9]{40}$/i;
  const sha64 = /^(?:sha256:)?[a-f0-9]{64}$/i;
  if (provenance.schemaVersion !== 'training_e2e_environment.v2'
      || provenance.runId !== env.NEXUS_TRAINING_E2E_RUN_ID
      || provenance.runPolicy.mode !== 'fresh'
      || provenance.runPolicy.qualifying !== true
      || !sha40.test(String(provenance.git.commit ?? ''))
      || !sha40.test(String(provenance.git.baseCommit ?? ''))
      || !sha64.test(String(provenance.git.dirtyTreeDiffSha256 ?? ''))) {
    throw new Error('Clarification seed requires a fresh, qualifying run with exact v2 backend source provenance');
  }
  const expectedImageNames = {
    backend: `nexus-hub-node:training-e2e-${provenance.runId}`,
    contentEngine: `nexus-hub-content-engine:training-e2e-${provenance.runId}`,
  };
  for (const [label, image] of Object.entries(provenance.images)) {
    if (image.name !== expectedImageNames[label]
        || !sha64.test(String(image.builtImageId ?? ''))
        || image.builtImageId !== image.actualContainerImageId) {
      throw new Error(`Clarification seed ${label} image provenance is incomplete or mismatched`);
    }
  }
  return provenance;
}

const backendProvenance = readBackendProvenance();

async function api(method, routePath, body, expectedStatuses = [200]) {
  const res = await fetch(`${apiBaseUrl}${routePath}`, {
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
  const db = new Database(runtimeDbPath);
  try {
    db.pragma('foreign_keys = ON');
    return write(db);
  } finally {
    db.close();
  }
}

function seedTrainingProfile({ omitPlanClarifications = false } = {}) {
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
        experience_level: 'Intermediate (1-3 years)',
        weekly_frequency: '4-5 days',
        training_goals: 'Endurance, Strength',
        injuries: 'none',
        // Keep the required Fitness questionnaire key present. In the
        // clarification lane both profile candidates must remain unresolved;
        // otherwise this fallback value would silently suppress the equipment
        // blocker before the canonical gym answer is written.
        available_equipment: omitPlanClarifications ? 'unknown' : 'Full gym',
        preferred_training_days: 'Monday, Tuesday, Thursday, Saturday',
        blocked_days: 'Friday',
      }],
      ['triathlon-gym', {
        training_age: '1-3 years',
        current_split: 'Upper/Lower',
        primary_goal: 'Support other sports',
        squat_1rm_kg: '115',
        bench_1rm_kg: '82',
        deadlift_1rm_kg: '150',
        sessions_per_week: '5+',
        preferred_training_days: 'Monday, Tuesday, Thursday, Saturday',
        blocked_days: 'Friday',
        ...(omitPlanClarifications ? {
          // Key presence keeps the required gym questionnaire complete while
          // the sentinel value deliberately resolves to an unknown equipment
          // profile. The server must then authorize replacing it with one of
          // the canonical choices through the clarification PATCH route.
          equipment_access: 'unknown',
        } : {
          equipment_access: 'Full commercial gym',
          session_duration_minutes: '60',
        }),
      }],
      ['triathlon-running', {
        weekly_mileage_km: '32',
        longest_recent_run_km: '14',
        easy_pace_min_per_km: '5:45',
        target_race: 'None — general fitness',
        target_race_date: 'none',
        preferred_workouts: 'Easy runs, Tempo, Long runs',
        injury_history: 'none',
        weekly_availability_days: '5',
        preferred_training_days: 'Tuesday, Thursday, Saturday, Sunday',
        blocked_days: 'Friday',
      }],
      ['triathlon-cycling', {
        ftp_watts: '245',
        weekly_hours: '3-6 hours',
        primary_discipline: 'Road',
        target_event: 'None',
        power_meter: 'Indoor only (smart trainer)',
        terrain_preference: 'Mixed',
        weekly_availability_days: '3',
        preferred_training_days: 'Wednesday, Saturday, Sunday',
        blocked_days: 'Friday',
      }],
      ['triathlon-swim', {
        experience: 'Fitness swimmer',
        primary_stroke: 'Freestyle',
        time_400m_freestyle_min: '8:00',
        pool_access: '25m indoor',
        goal: 'Fitness',
        sessions_per_week: '2',
        preferred_training_days: 'Tuesday, Thursday',
        blocked_days: 'Friday',
        equipment_access: 'Pull buoy, Fins, Kickboard',
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

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
}

function digest(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(value)))
    .digest('hex');
}

function parseJsonObject(raw, context) {
  let value;
  try {
    value = JSON.parse(String(raw ?? '{}'));
  } catch {
    throw new Error(`${context} is not valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value;
}

function readProfiles(db, scopedUserId) {
  return db.prepare(`
    SELECT user_id, profile_type, data
      FROM user_profiles
     WHERE user_id = ?
     ORDER BY profile_type ASC
  `).all(scopedUserId).map((row) => ({
    userId: Number(row.user_id),
    profileType: String(row.profile_type),
    data: parseJsonObject(row.data, `profile ${row.user_id}/${row.profile_type}`),
  }));
}

function readOtherProfiles(db, excludedUserIds) {
  const excluded = new Set(excludedUserIds.map(Number));
  return db.prepare(`
    SELECT user_id, profile_type, data
      FROM user_profiles
     ORDER BY user_id ASC, profile_type ASC
  `).all().filter((row) => !excluded.has(Number(row.user_id))).map((row) => ({
    userId: Number(row.user_id),
    profileType: String(row.profile_type),
    data: parseJsonObject(row.data, `profile ${row.user_id}/${row.profile_type}`),
  }));
}

function profileData(profiles, profileType) {
  return profiles.find((profile) => profile.profileType === profileType)?.data ?? null;
}

function seedScopeSentinel(runId) {
  return withDb((db) => {
    const email = `training-e2e-scope-sentinel-${runId}@invalid.example`;
    db.prepare(`
      INSERT INTO users (
        email, email_verified, first_name, language, timezone, tier, status, auth_provider
      ) VALUES (?, 1, 'Training E2E Scope Sentinel', 'en-US', 'Europe/Lisbon', 'free', 'active', 'email')
      ON CONFLICT(email) DO UPDATE SET first_name = excluded.first_name
    `).run(email);
    const sentinel = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    const sentinelUserId = Number(sentinel?.id);
    if (!Number.isInteger(sentinelUserId) || sentinelUserId <= 0 || sentinelUserId === userId) {
      throw new Error(`Unable to create an isolated scope sentinel for ${runId}`);
    }
    const data = {
      marker: `scope-sentinel-${runId}`,
      equipment_access: 'SENTINEL MUST NOT CHANGE',
      session_duration_minutes: '179',
    };
    db.prepare(`
      INSERT INTO user_profiles (user_id, profile_type, data)
      VALUES (?, 'triathlon-gym', ?)
      ON CONFLICT(user_id, profile_type) DO UPDATE SET
        data = excluded.data,
        updated_at = datetime('now')
    `).run(sentinelUserId, JSON.stringify(data));
    return { userId: sentinelUserId, email, data, digest: digest(data) };
  });
}

function readClarificationBaseline(sentinel) {
  return withDb((db) => {
    const targetProfiles = readProfiles(db, userId);
    const otherProfiles = readOtherProfiles(db, [userId, sentinel.userId]);
    const activePlans = db.prepare(`
      SELECT id FROM fitness_training_plans
       WHERE user_id = ? AND status = 'active'
       ORDER BY id ASC
    `).all(userId).map((row) => Number(row.id));
    if (activePlans.length > 0) {
      throw new Error(`Clarification seed requires no active plan; found ${activePlans.join(', ')}`);
    }
    return {
      targetProfiles,
      targetProfilesDigest: digest(targetProfiles),
      // Never persist other users' profile values in test evidence. The
      // digest and row count are sufficient to prove that the journey did
      // not mutate any profile outside the authenticated fixture scope.
      otherProfilesDigest: digest(otherProfiles),
      otherProfileRowCount: otherProfiles.length,
      planIds: db.prepare(`
        SELECT id FROM fitness_training_plans WHERE user_id = ? ORDER BY id ASC
      `).all(userId).map((row) => Number(row.id)),
      idempotencyKeys: db.prepare(`
        SELECT idempotency_key
          FROM training_plan_generation_idempotency_scoped
         WHERE user_id = ?
         ORDER BY idempotency_key ASC
      `).all(userId).map((row) => String(row.idempotency_key)),
      ownershipCount: Number(db.prepare(`
        SELECT COUNT(*) AS count
          FROM training_agenda_event_ownership
         WHERE user_id = ?
      `).get(userId)?.count ?? 0),
    };
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

async function prepareClarification() {
  const runId = env.NEXUS_TRAINING_E2E_RUN_ID;
  seedTrainingProfile({ omitPlanClarifications: true });
  const sentinel = seedScopeSentinel(runId);
  const baseline = readClarificationBaseline(sentinel);
  const gymProfile = profileData(baseline.targetProfiles, 'triathlon-gym');
  const fitnessProfile = profileData(baseline.targetProfiles, 'fitness');
  if (!gymProfile || !fitnessProfile) {
    throw new Error('Clarification seed did not persist the required fitness and gym profiles');
  }
  if (gymProfile.equipment_access !== 'unknown') {
    throw new Error('Clarification seed must start from the explicit unknown gym-equipment sentinel');
  }
  if (Object.hasOwn(gymProfile, 'session_duration_minutes')) {
    throw new Error('Clarification seed unexpectedly contains triathlon-gym.session_duration_minutes');
  }
  if (fitnessProfile.available_equipment !== 'unknown') {
    throw new Error('Clarification seed must keep the Fitness equipment key present but unresolved');
  }

  const previewRequest = {
    objective: 'Muscle Building',
    durationWeeks: 4,
    preferredTime: '12:00',
    preferredCardioTime: '07:00',
    preferredStrengthTime: '12:30',
    sessionsPerWeek: 5,
    runSessionsPerWeek: 0,
    bikeSessionsPerWeek: 0,
    swimSessionsPerWeek: 0,
    strengthSessionsPerWeek: 5,
    longWorkoutDay: 'Saturday',
    twoADayPreference: 'auto',
    goalMode: 'continuous',
    trainingPriority: 'strength',
    startPolicy: 'today',
    calendarSource: null,
  };
  const seededPreview = await api('POST', '/api/v1/training/plan/preview', previewRequest, [200]);
  const clarificationIds = Array.isArray(seededPreview.payload?.data?.clarificationIssues)
    ? seededPreview.payload.data.clarificationIssues.map((issue) => String(issue?.id ?? '')).filter(Boolean)
    : [];
  if (seededPreview.payload?.data?.status !== 'needs_clarification'
      || !clarificationIds.includes('equipment_clarification')
      || !clarificationIds.includes('session_duration_clarification')) {
    throw new Error(
      `Clarification seed did not reach the typed two-blocker contract: ${JSON.stringify({
        status: seededPreview.payload?.data?.status ?? null,
        clarificationIds,
      })}`,
    );
  }
  const afterPreflightProfiles = withDb((db) => readProfiles(db, userId));
  if (digest(afterPreflightProfiles) !== baseline.targetProfilesDigest) {
    throw new Error('Clarification preview mutated canonical profile state before the user answered');
  }

  const evidence = {
    schemaVersion: 'training_ios_clarification.v1',
    phase: 'prepared',
    runId,
    seedAttemptId,
    backendBaseUrl: baseUrl,
    dbPath: metadata.dbPath,
    sqlite: metadata.sqlite ?? null,
    userId,
    expectedTenantId: tenantId,
    backendProvenance,
    preparedAt: new Date().toISOString(),
    expectedAnswers: {
      equipmentAccess: 'Full commercial gym',
      sessionDurationMinutes: '60',
    },
    expectedRequest: {
      ...previewRequest,
      notes: null,
      raceDate: null,
      schedulingTimezone: 'Europe/Lisbon',
    },
    preflight: {
      httpStatus: seededPreview.status,
      status: seededPreview.payload.data.status,
      clarificationIds,
      profileStateUnchanged: true,
    },
    sentinel,
    baseline: {
      ...baseline,
    },
  };
  fs.writeFileSync(clarificationEvidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({
    ok: true,
    evidencePath: clarificationEvidencePath,
    schemaVersion: evidence.schemaVersion,
    phase: evidence.phase,
    runId,
    userId,
    sentinelUserId: sentinel.userId,
  }, null, 2));
}

function assertDeepEqual(actual, expected, message) {
  if (digest(actual) !== digest(expected)) {
    throw new Error(`${message}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  }
}

function assertClarificationEvidenceIdentity(evidence, operation) {
  if (evidence.schemaVersion !== 'training_ios_clarification.v1'
      || evidence.runId !== env.NEXUS_TRAINING_E2E_RUN_ID
      || Number(evidence.userId) !== userId
      || Number(evidence.expectedTenantId) !== tenantId
      || evidence.backendBaseUrl !== baseUrl
      || evidence.dbPath !== metadata.dbPath
      || digest(evidence.backendProvenance) !== digest(backendProvenance)) {
    throw new Error(
      `Refusing clarification ${operation}: evidence does not match the active qualifying backend/auth scope`,
    );
  }
}

function readLiveSecretaryProviderMappingCount(db, planIds, sessionIds) {
  if (planIds.length === 0) return 0;
  const intentClauses = planIds.map(() => 'source_intent_id LIKE ?');
  const params = planIds.map((planId) => `training:${planId}:%`);
  if (sessionIds.length > 0) {
    intentClauses.push(
      `(source_entity_type = 'training_session' AND source_entity_id IN (${sessionIds.map(() => '?').join(', ')}))`,
    );
    params.push(...sessionIds.map(String));
  }
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
      FROM secretary_agenda_items
     WHERE source_skill = 'training'
       AND (${intentClauses.join(' OR ')})
       AND provider_event_id IS NOT NULL
       AND provider_event_id != ''
       AND COALESCE(provider_sync_state, '') != 'deleted'
  `).get(...params)?.count ?? 0);
}

async function verifyClarification() {
  if (!fs.existsSync(clarificationEvidencePath)) {
    throw new Error(`No clarification seed evidence found at ${clarificationEvidencePath}`);
  }
  const evidence = JSON.parse(fs.readFileSync(clarificationEvidencePath, 'utf8'));
  assertClarificationEvidenceIdentity(evidence, 'verification');

  const verification = withDb((db) => {
    const targetProfiles = readProfiles(db, userId);
    const baselineProfiles = evidence.baseline?.targetProfiles ?? [];
    const expectedProfiles = baselineProfiles.map((profile) => {
      if (profile.profileType !== 'triathlon-gym') return profile;
      return {
        ...profile,
        data: {
          ...profile.data,
          equipment_access: evidence.expectedAnswers.equipmentAccess,
          session_duration_minutes: evidence.expectedAnswers.sessionDurationMinutes,
        },
      };
    });
    assertDeepEqual(
      targetProfiles,
      expectedProfiles,
      'Canonical clarification writes changed fields outside the two server-authorized targets',
    );

    const sentinelProfiles = readProfiles(db, Number(evidence.sentinel.userId));
    const sentinelGym = profileData(sentinelProfiles, 'triathlon-gym');
    if (digest(sentinelGym) !== evidence.sentinel.digest) {
      throw new Error('Clarification writes escaped the authenticated account and changed the scope sentinel');
    }
    const otherProfiles = readOtherProfiles(db, [userId, Number(evidence.sentinel.userId)]);
    if (digest(otherProfiles) !== evidence.baseline.otherProfilesDigest) {
      throw new Error('Clarification journey changed a profile outside the authenticated/sentinel scopes');
    }
    if (otherProfiles.length !== Number(evidence.baseline.otherProfileRowCount)) {
      throw new Error('Clarification journey changed the number of profiles outside the authenticated/sentinel scopes');
    }

    const baselinePlanIds = new Set((evidence.baseline.planIds ?? []).map(Number));
    const createdPlans = db.prepare(`
      SELECT id, user_id, tenant_id, name, goal, duration_weeks, status, preferences_json
        FROM fitness_training_plans
       WHERE user_id = ?
       ORDER BY id ASC
    `).all(userId).filter((row) => !baselinePlanIds.has(Number(row.id)));
    if (createdPlans.length !== 1) {
      throw new Error(`Accepted create must persist exactly one plan; found ${createdPlans.length}`);
    }
    const plan = createdPlans[0];
    if (Number(plan.user_id) !== userId || Number(plan.tenant_id) !== Number(evidence.expectedTenantId)) {
      throw new Error(`Created plan escaped its user/tenant scope: ${JSON.stringify(plan)}`);
    }
    if (String(plan.status) !== 'active' || String(plan.goal) !== evidence.expectedRequest.objective) {
      throw new Error(`Created plan does not match the reviewed objective/state: ${JSON.stringify(plan)}`);
    }
    const preferences = parseJsonObject(plan.preferences_json, `plan ${plan.id} preferences_json`);
    const requestedTargets = preferences.requestedTargets ?? {};
    const requestAssertions = {
      objective: String(plan.goal),
      durationWeeks: Number(plan.duration_weeks),
      preferredTime: preferences.preferredTime ?? null,
      preferredCardioTime: preferences.preferredCardioTime ?? null,
      preferredStrengthTime: preferences.preferredStrengthTime ?? null,
      goalMode: preferences.goalMode ?? null,
      trainingPriority: preferences.trainingPriority ?? null,
      sessionsPerWeek: Number(requestedTargets.sessionsPerWeek),
      runSessionsPerWeek: Number(requestedTargets.runSessionsPerWeek),
      bikeSessionsPerWeek: Number(requestedTargets.bikeSessionsPerWeek),
      swimSessionsPerWeek: Number(requestedTargets.swimSessionsPerWeek),
      strengthSessionsPerWeek: Number(requestedTargets.strengthSessionsPerWeek),
      longWorkoutDay: preferences.longWorkoutDay ?? null,
      twoADayPreference: preferences.twoADayPreference ?? null,
      startPolicy: preferences.startPolicy ?? null,
      calendarSource: preferences.trainingCalendarSource ?? null,
      notes: preferences.notes ?? null,
      raceDate: preferences.raceDate ?? null,
      schedulingTimezone: preferences.schedulingTimezone ?? null,
    };
    assertDeepEqual(
      requestAssertions,
      evidence.expectedRequest,
      'Created plan diverged from the request that entered clarification/re-preview',
    );

    const baselineKeys = new Set(evidence.baseline.idempotencyKeys ?? []);
    const idempotencyRows = db.prepare(`
      SELECT user_id, tenant_id, idempotency_key, request_hash, status, response_json, status_code
        FROM training_plan_generation_idempotency_scoped
       WHERE user_id = ?
       ORDER BY created_at ASC, idempotency_key ASC
    `).all(userId).filter((row) => !baselineKeys.has(String(row.idempotency_key)));
    if (idempotencyRows.length !== 1) {
      throw new Error(`Accepted create must use exactly one idempotency mutation; found ${idempotencyRows.length}`);
    }
    const idempotency = idempotencyRows[0];
    const idempotencyResponse = parseJsonObject(idempotency.response_json, 'generation idempotency response');
    const responsePlanId = Number(idempotencyResponse?.planId ?? idempotencyResponse?.data?.planId);
    if (Number(idempotency.user_id) !== userId
        || Number(idempotency.tenant_id) !== Number(evidence.expectedTenantId)
        || String(idempotency.status) !== 'succeeded'
        || !String(idempotency.request_hash ?? '').trim()
        || responsePlanId !== Number(plan.id)) {
      throw new Error(`Generation idempotency proof is incomplete: ${JSON.stringify(idempotency)}`);
    }

    const providerOwnershipCount = Number(db.prepare(`
      SELECT COUNT(*) AS count
        FROM training_agenda_event_ownership
       WHERE user_id = ? AND plan_id = ?
    `).get(userId, plan.id)?.count ?? 0);
    const planSessionRows = db.prepare(`
      SELECT id, calendar_event_id, calendar_source
        FROM training_sessions
       WHERE plan_id = ?
    `).all(plan.id);
    const providerLinkedSessionCount = planSessionRows.filter(
      (session) => session.calendar_event_id !== null || session.calendar_source !== null,
    ).length;
    const secretaryLiveProviderMappingCount = readLiveSecretaryProviderMappingCount(
      db,
      [Number(plan.id)],
      planSessionRows.map((session) => Number(session.id)),
    );
    if (providerOwnershipCount !== 0
        || providerLinkedSessionCount !== 0
        || secretaryLiveProviderMappingCount !== 0) {
      throw new Error(
        `Fixture-safe journey created provider/calendar state: ownership=${providerOwnershipCount} linkedSessions=${providerLinkedSessionCount} secretaryMappings=${secretaryLiveProviderMappingCount}`,
      );
    }

    return {
      planId: Number(plan.id),
      planName: String(plan.name),
      idempotencyKey: String(idempotency.idempotency_key),
      requestHash: String(idempotency.request_hash),
      statusCode: Number(idempotency.status_code),
      providerOwnershipCount,
      providerLinkedSessionCount,
      secretaryLiveProviderMappingCount,
      targetProfilesDigest: digest(targetProfiles),
      sentinelDigest: digest(sentinelGym),
      otherProfilesDigest: digest(otherProfiles),
      requestAssertions,
    };
  });

  const verifiedEvidence = {
    ...evidence,
    phase: 'verified',
    verifiedAt: new Date().toISOString(),
    verification,
  };
  fs.writeFileSync(clarificationEvidencePath, JSON.stringify(verifiedEvidence, null, 2) + '\n');
  console.log(JSON.stringify({
    ok: true,
    evidencePath: clarificationEvidencePath,
    phase: verifiedEvidence.phase,
    planId: verification.planId,
    providerOwnershipCount: verification.providerOwnershipCount,
    providerLinkedSessionCount: verification.providerLinkedSessionCount,
    secretaryLiveProviderMappingCount: verification.secretaryLiveProviderMappingCount,
  }, null, 2));
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

function readClarificationCleanupPlanGraph(evidence) {
  const baselinePlanIds = new Set(
    (evidence.baseline?.planIds ?? [])
      .map(Number)
      .filter((planId) => Number.isInteger(planId) && planId > 0),
  );
  const rawVerifiedPlanId = evidence.verification?.planId;
  const hasVerifiedPlanId = rawVerifiedPlanId !== undefined && rawVerifiedPlanId !== null;
  const verifiedPlanId = Number(rawVerifiedPlanId);
  if (hasVerifiedPlanId && (!Number.isInteger(verifiedPlanId) || verifiedPlanId <= 0)) {
    throw new Error('Clarification cleanup evidence contains an invalid verified plan id');
  }
  if (String(evidence.phase ?? '').startsWith('verified') && !hasVerifiedPlanId) {
    throw new Error('Clarification cleanup requires the verified plan id recorded in evidence');
  }

  return withDb((db) => {
    const observedPlanRows = db.prepare(`
      SELECT id, user_id, tenant_id
        FROM fitness_training_plans
       WHERE user_id = ?
       ORDER BY id ASC
    `).all(userId).filter((row) => !baselinePlanIds.has(Number(row.id)));

    if (!hasVerifiedPlanId) {
      if (observedPlanRows.length > 0) {
        throw new Error(
          'Clarification cleanup found a non-baseline plan without a verified evidence plan id; refusing ambiguous deletion',
        );
      }
      return { planIds: [], cancelPlanIds: [], sessionIds: [] };
    }
    if (baselinePlanIds.has(verifiedPlanId)) {
      throw new Error(`Clarification cleanup verified plan ${verifiedPlanId} overlaps the preserved baseline`);
    }

    const anchoredPlan = db.prepare(`
      SELECT id, user_id, tenant_id
        FROM fitness_training_plans
       WHERE id = ?
    `).get(verifiedPlanId);
    if (anchoredPlan
        && (Number(anchoredPlan.user_id) !== userId || Number(anchoredPlan.tenant_id) !== tenantId)) {
      throw new Error(`Clarification cleanup verified plan ${verifiedPlanId} escaped its user/tenant scope`);
    }
    const unexpectedPlanIds = observedPlanRows
      .map((row) => Number(row.id))
      .filter((planId) => planId !== verifiedPlanId);
    if (unexpectedPlanIds.length > 0) {
      throw new Error(
        `Clarification cleanup found non-baseline plans outside verified plan ${verifiedPlanId}: ${unexpectedPlanIds.join(', ')}`,
      );
    }

    const sessionIds = db.prepare(`
      SELECT id FROM training_sessions WHERE plan_id = ? ORDER BY id ASC
    `).all(verifiedPlanId).map((row) => Number(row.id));
    return {
      // Always retain the evidence anchor for post-cancel proof. If the plan
      // row disappeared early, this still detects orphan weeks, sessions,
      // completions, agenda mappings, and ownership rows keyed to its id.
      planIds: [verifiedPlanId],
      cancelPlanIds: anchoredPlan ? [verifiedPlanId] : [],
      sessionIds,
    };
  });
}

function readClarificationCleanupProof(planIds, sessionIds) {
  return withDb((db) => {
    const count = (sql, ...params) => Number(db.prepare(sql).get(...params)?.count ?? 0);
    if (planIds.length === 0) {
      return {
        clean: true,
        planRows: 0,
        weekRows: 0,
        sessionRows: 0,
        completionRows: 0,
        activeAgendaRows: 0,
        liveAgendaProviderRows: 0,
        activeOwnershipRows: 0,
      };
    }
    const planPlaceholders = planIds.map(() => '?').join(', ');
    const planPatterns = planIds.map(() => 'source_intent_id LIKE ?').join(' OR ');
    const intentPatterns = planIds.map((planId) => `training:${planId}:%`);
    let sessionEntityClause = '';
    const agendaParams = [...intentPatterns];
    if (sessionIds.length > 0) {
      sessionEntityClause = ` OR (source_entity_type = 'training_session' AND source_entity_id IN (${sessionIds.map(() => '?').join(', ')}))`;
      agendaParams.push(...sessionIds.map(String));
    }
    const agendaScope = `
      source_skill = 'training'
      AND ((${planPatterns})${sessionEntityClause})
    `;
    const proof = {
      planRows: count(
        `SELECT COUNT(*) AS count FROM fitness_training_plans WHERE id IN (${planPlaceholders})`,
        ...planIds,
      ),
      weekRows: count(
        `SELECT COUNT(*) AS count FROM training_weeks WHERE plan_id IN (${planPlaceholders})`,
        ...planIds,
      ),
      sessionRows: count(
        `SELECT COUNT(*) AS count FROM training_sessions WHERE plan_id IN (${planPlaceholders})`,
        ...planIds,
      ),
      completionRows: count(
        `SELECT COUNT(*) AS count FROM training_completions WHERE plan_id IN (${planPlaceholders})`,
        ...planIds,
      ),
      activeAgendaRows: count(
        `SELECT COUNT(*) AS count FROM secretary_agenda_items WHERE ${agendaScope}
          AND lifecycle_state NOT IN ('canceled', 'completed', 'superseded')`,
        ...agendaParams,
      ),
      liveAgendaProviderRows: readLiveSecretaryProviderMappingCount(db, planIds, sessionIds),
      activeOwnershipRows: count(
        `SELECT COUNT(*) AS count
           FROM training_agenda_event_ownership
          WHERE plan_id IN (${planPlaceholders})
            AND status = 'active'`,
        ...planIds,
      ),
    };
    return {
      ...proof,
      clean: Object.values(proof).every((value) => value === 0),
    };
  });
}

async function cleanupClarification() {
  if (!fs.existsSync(clarificationEvidencePath)) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no_clarification_evidence' }, null, 2));
    return;
  }
  const evidence = JSON.parse(fs.readFileSync(clarificationEvidencePath, 'utf8'));
  assertClarificationEvidenceIdentity(evidence, 'cleanup');
  const createdPlanGraph = readClarificationCleanupPlanGraph(evidence);
  const cleanupStatuses = [];
  for (const planId of createdPlanGraph.cancelPlanIds) {
    const cancel = await api('POST', '/api/v1/training/plan/cancel', { planId }, [200, 404, 409]);
    if (cancel.status !== 200 || cancel.payload?.data?.cancelled !== true) {
      throw new Error(
        `Clarification cleanup did not confirm cancellation for plan ${planId}: status=${cancel.status}`,
      );
    }
    cleanupStatuses.push({
      planId,
      status: cancel.status,
      code: cancel.payload?.error?.code ?? null,
    });
  }
  const cleanupProof = readClarificationCleanupProof(
    createdPlanGraph.planIds,
    createdPlanGraph.sessionIds,
  );
  if (!cleanupProof.clean) {
    throw new Error(`Clarification cleanup left durable state: ${JSON.stringify(cleanupProof)}`);
  }
  const homeAfterCleanup = await api('GET', '/api/v1/training/home');
  const homeHeroState = homeAfterCleanup.payload?.data?.hero?.state;
  if (homeHeroState !== 'noPlan') {
    throw new Error(
      `Training home did not return the canonical no-plan state after clarification cleanup: ${String(homeHeroState ?? 'missing')}`,
    );
  }

  // Put the target back into the same incomplete-profile posture so a kept
  // isolated backend can rerun this journey without silently bypassing the
  // clarification. This database is run-scoped and fixture-only.
  seedTrainingProfile({ omitPlanClarifications: true });
  withDb((db) => {
    const sentinelUserId = Number(evidence.sentinel?.userId);
    const sentinelEmail = String(evidence.sentinel?.email ?? '');
    if (Number.isInteger(sentinelUserId) && sentinelUserId > 0 && sentinelUserId !== userId) {
      const row = db.prepare('SELECT email FROM users WHERE id = ?').get(sentinelUserId);
      if (String(row?.email ?? '') !== sentinelEmail) {
        throw new Error(`Refusing to delete mismatched scope sentinel user ${sentinelUserId}`);
      }
      db.prepare('DELETE FROM user_profiles WHERE user_id = ?').run(sentinelUserId);
      db.prepare('DELETE FROM onboarding_sessions WHERE user_id = ?').run(sentinelUserId);
      db.prepare('DELETE FROM subscriptions WHERE user_id = ?').run(sentinelUserId);
      db.prepare('DELETE FROM users WHERE id = ? AND email = ?').run(sentinelUserId, sentinelEmail);
    }
  });

  const cleanupEvidence = {
    ...evidence,
    phase: evidence.phase === 'verified' ? 'verified_and_cleaned' : 'cleaned_without_verification',
    cleanedAt: new Date().toISOString(),
    cleanupStatuses,
    cleanupProof,
    homeHeroState,
  };
  fs.writeFileSync(clarificationEvidencePath, JSON.stringify(cleanupEvidence, null, 2) + '\n');
  console.log(JSON.stringify({
    ok: true,
    evidencePath: clarificationEvidencePath,
    phase: cleanupEvidence.phase,
    cleanedPlanIds: createdPlanGraph.cancelPlanIds,
    proofPlanIds: createdPlanGraph.planIds,
    cleanupProof,
  }, null, 2));
}

if (mode === 'prepare') {
  await prepare();
} else if (mode === 'cleanup') {
  await cleanup();
} else if (mode === 'prepare-clarification') {
  await prepareClarification();
} else if (mode === 'verify-clarification') {
  await verifyClarification();
} else if (mode === 'cleanup-clarification') {
  await cleanupClarification();
} else {
  throw new Error(
    `Unknown mode "${mode}". Use prepare, cleanup, prepare-clarification, verify-clarification, or cleanup-clarification.`,
  );
}
