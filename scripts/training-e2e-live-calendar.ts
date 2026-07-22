#!/usr/bin/env -S npx tsx
// Live sandbox Google/Outlook lifecycle validation for isolated Training E2E.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

type Provider = 'google' | 'outlook';

type EnvMap = Record<string, string>;
type DatabaseModule = typeof import('../src/services/database');
type OAuthStoreModule = typeof import('../src/services/oauth-store');
type UnifiedCalendarModule = typeof import('../src/services/unified-calendar');

type LinkedSession = {
  id: number;
  title: string;
  duration_minutes: number | null;
  calendar_event_id: string;
  calendar_source: Provider;
  updated_at: string | null;
};

const root = path.resolve(__dirname, '..');
const latestEnvPath = path.join(root, '.local/training-e2e/latest.env');

function loadLatestEnv(): EnvMap {
  if (!fs.existsSync(latestEnvPath)) {
    throw new Error(`No Training E2E env file found at ${latestEnvPath}. Start one with scripts/training-e2e-up.sh`);
  }
  const env: EnvMap = {};
  const text = fs.readFileSync(latestEnvPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^export\s+([A-Z0-9_]+)='(.*)'$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

const e2eEnv = loadLatestEnv();
const metadataPath = path.join(e2eEnv.NEXUS_TRAINING_E2E_ROOT, 'metadata.json');
const authPath = e2eEnv.NEXUS_TRAINING_E2E_AUTH_FILE;
const evidencePath = path.join(e2eEnv.NEXUS_TRAINING_E2E_ROOT, 'training-live-calendar-evidence.json');
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
const baseUrl = e2eEnv.NEXUS_TRAINING_E2E_BASE_URL;
const runId = e2eEnv.NEXUS_TRAINING_E2E_RUN_ID;
const runMarker = `Nexus Training E2E Run: ${runId}`;
const userId = Number(auth.user?.id);
const providers = parseProviders(process.env.NEXUS_TRAINING_E2E_LIVE_CALENDAR_PROVIDERS || e2eEnv.NEXUS_TRAINING_E2E_LIVE_CALENDAR_PROVIDERS);

if (!baseUrl || baseUrl.includes(':8200')) {
  throw new Error(`Refusing non-isolated Training E2E backend URL: ${baseUrl}`);
}
if (metadata.backendBaseUrl !== baseUrl) {
  throw new Error(`Backend URL mismatch: env=${baseUrl} metadata=${metadata.backendBaseUrl}`);
}
if (!String(metadata.dbPath || '').includes('/.local/training-e2e/')) {
  throw new Error(`Refusing non-isolated DB path: ${metadata.dbPath}`);
}
if (metadata.liveCalendar?.enabled !== true || e2eEnv.NEXUS_TRAINING_E2E_LIVE_CALENDAR !== '1') {
  throw new Error('Live calendar lane requires a backend started with NEXUS_TRAINING_E2E_LIVE_CALENDAR=1.');
}
if (!Number.isInteger(userId) || userId <= 0) {
  throw new Error('Auth import file does not contain a valid user id');
}

let db: ReturnType<DatabaseModule['getDb']>;
let oauthStore: OAuthStoreModule;
let unifiedCalendar: UnifiedCalendarModule;

const evidence: {
  schemaVersion: string;
  runId: string;
  backendBaseUrl: string;
  dbPath: string;
  providers: Provider[];
  startedAt: string;
  finishedAt?: string;
  steps: Array<Record<string, unknown>>;
  cleanupFailures: Array<Record<string, unknown>>;
  failure?: Record<string, unknown>;
} = {
  schemaVersion: 'training_live_calendar_e2e.v1',
  runId,
  backendBaseUrl: baseUrl,
  dbPath: metadata.dbPath,
  providers,
  startedAt: new Date().toISOString(),
  steps: [],
  cleanupFailures: [],
};

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  assertLiveCalendarPrerequisites(providers);
  configureRuntimeEnvironment();

  const database = await import('../src/services/database');
  database.initDatabase();
  const { getDb, closeDatabase } = database;
  oauthStore = await import('../src/services/oauth-store');
  unifiedCalendar = await import('../src/services/unified-calendar');
  db = getDb();

  try {
    seedTrainingProfile();
    for (const provider of providers) {
      await runProviderLifecycle(provider);
    }
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({
      ok: true,
      runId,
      providers,
      evidencePath,
      cleanupFailures: evidence.cleanupFailures.length,
    }, null, 2));
  } catch (err) {
    evidence.finishedAt = new Date().toISOString();
    evidence.failure = {
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : typeof err,
    };
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    throw err;
  } finally {
    closeDatabase();
  }
}

function parseProviders(raw: string | undefined): Provider[] {
  const providers = (raw || 'google,outlook')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(providers)].filter((provider): provider is Provider =>
    provider === 'google' || provider === 'outlook',
  );
  if (unique.length === 0) throw new Error('No live calendar providers selected. Use google,outlook.');
  return unique;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Live Training calendar E2E requires ${name}.`);
  return value;
}

function assertSandboxLabel(name: string): void {
  const value = requireEnv(name);
  if (/prod|production|primary|personal/i.test(value)) {
    throw new Error(`${name} appears to identify a production/personal calendar target: ${value}`);
  }
  if (!/(sandbox|e2e|qa|test|staging|nonprod)/i.test(value)) {
    throw new Error(`${name} must visibly identify a sandbox/test/e2e/staging/nonprod account: ${value}`);
  }
}

function assertLiveCalendarPrerequisites(selectedProviders: Provider[]): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Live Training calendar E2E refuses NODE_ENV=production.');
  }
  if (process.env.NEXUS_TRAINING_E2E_LIVE_CALENDAR_ACK !== 'sandbox-non-prod-calendar') {
    throw new Error('Set NEXUS_TRAINING_E2E_LIVE_CALENDAR_ACK=sandbox-non-prod-calendar to run live sandbox calendar writes.');
  }
  requireEnv('OAUTH_ENCRYPTION_KEY');
  if (selectedProviders.includes('google')) {
    requireEnv('GOOGLE_CLIENT_ID');
    requireEnv('GOOGLE_CLIENT_SECRET');
    requireEnv('NEXUS_TRAINING_E2E_GOOGLE_REFRESH_TOKEN');
    assertSandboxLabel('NEXUS_TRAINING_E2E_GOOGLE_ACCOUNT_LABEL');
  }
  if (selectedProviders.includes('outlook')) {
    requireEnv('OUTLOOK_CLIENT_ID');
    requireEnv('OUTLOOK_CLIENT_SECRET');
    requireEnv('OUTLOOK_TENANT_ID');
    requireEnv('NEXUS_TRAINING_E2E_OUTLOOK_REFRESH_TOKEN');
    assertSandboxLabel('NEXUS_TRAINING_E2E_OUTLOOK_ACCOUNT_LABEL');
  }
}

function configureRuntimeEnvironment(): void {
  process.env.NODE_ENV = 'development';
  process.env.ENV = 'development';
  process.env.STAGING = 'false';
  process.env.PAYWALL_ENABLED = 'false';
  process.env.DATABASE_PATH = metadata.dbPath;
  process.env.IOS_API_ENABLED = 'true';
  process.env.IOS_API_JWT_SECRET = process.env.NEXUS_TRAINING_E2E_IOS_API_JWT_SECRET
    || 'nexus-training-e2e-ios-jwt-secret-2026-06-strong-48-byte';
  process.env.TRAINING_CALENDAR_WRITES_ENABLED = 'true';
  process.env.TRAINING_CALENDAR_SYNC_ENABLED = 'true';
  process.env.GOOGLE_REFRESH_TOKEN = '';
  process.env.OUTLOOK_REFRESH_TOKEN = '';
  process.env.FINANCE_ENCRYPTION_ENABLED = process.env.FINANCE_ENCRYPTION_ENABLED || 'false';
  process.env.OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID || '100000001';
  process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'nexus-training-e2e-internal-secret';
  process.env.CONTENT_ENGINE_ENABLED = 'false';
}

function providerRefreshToken(provider: Provider): string {
  return provider === 'google'
    ? requireEnv('NEXUS_TRAINING_E2E_GOOGLE_REFRESH_TOKEN')
    : requireEnv('NEXUS_TRAINING_E2E_OUTLOOK_REFRESH_TOKEN');
}

function providerScopes(provider: Provider): string[] {
  return provider === 'google'
    ? ['https://www.googleapis.com/auth/calendar']
    : ['Calendars.ReadWrite', 'User.Read', 'offline_access'];
}

function seedProviderToken(provider: Provider): void {
  oauthStore.storeTokens(userId, provider, {
    accessToken: '',
    refreshToken: providerRefreshToken(provider),
    tokenType: 'Bearer',
    expiresAt: null,
    scopes: providerScopes(provider),
  });
}

function seedTrainingProfile(): void {
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

  const profiles: Array<[string, Record<string, unknown>]> = [
    ['fitness', {
      experience_level: 'Intermediate',
      weekly_frequency: '4 days',
      training_goals: ['Strength consistency', 'Endurance durability'],
      injuries: 'none',
      available_equipment: 'Full gym',
      preferred_training_days: ['Monday', 'Wednesday', 'Thursday', 'Saturday'],
      blocked_days: ['Friday'],
    }],
    ['triathlon-gym', {
      training_age: '3 years',
      current_split: 'Upper lower',
      primary_goal: 'Support hybrid training',
      squat_1rm_kg: 115,
      bench_1rm_kg: 82,
      deadlift_1rm_kg: 150,
      sessions_per_week: '2',
      preferred_training_days: ['Monday', 'Thursday'],
      blocked_days: ['Friday'],
      equipment_access: 'Full commercial gym',
    }],
    ['triathlon-running', {
      weekly_mileage_km: 30,
      longest_recent_run_km: 12,
      easy_pace_min_per_km: '5:45',
      target_race: '10K',
      preferred_workouts: ['Easy runs', 'Tempo'],
      injury_history: 'none',
      weekly_availability_days: '4',
      preferred_training_days: ['Wednesday', 'Saturday'],
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
}

async function api(method: string, routePath: string, body?: unknown, expectedStatuses = [200]) {
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
  let payload: any;
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

async function runProviderLifecycle(provider: Provider): Promise<void> {
  seedProviderToken(provider);
  evidence.steps.push({ provider, step: 'seed_provider_token', scopes: providerScopes(provider) });

  const planId = await createTrainingPlan(provider);
  try {
    const linked = readLinkedSessions(planId, provider);
    assert(linked.length >= 2, `${provider} plan expected at least two linked calendar sessions; found ${linked.length}`);
    await markEventsWithRunMarker(provider, linked);
    const markerEvents = await readProviderEventsByRunMarker(provider);
    assert(markerEvents.length === linked.length, `${provider} run marker count ${markerEvents.length} did not match linked sessions ${linked.length}`);
    evidence.steps.push({
      provider,
      step: 'provider_events_created',
      planId,
      linkedSessions: linked.length,
      markerEvents: markerEvents.length,
      eventHashes: linked.map((session) => hashId(session.calendar_event_id)),
    });

    await verifyIdempotentSync(provider, planId);
    await verifyExternalMoveRepair(provider, planId);
    await verifyExternalDeleteRepair(provider, planId);
  } finally {
    seedProviderToken(provider);
    await cleanupPlanAndProviderEvents(provider, planId);
  }
}

async function createTrainingPlan(provider: Provider): Promise<number> {
  const request = {
    objective: `Live sandbox calendar ${provider} lifecycle ${runId}`,
    durationWeeks: 1,
    preferredTime: '09:00',
    preferredCardioTime: '08:00',
    preferredStrengthTime: '18:00',
    sessionsPerWeek: 3,
    runSessionsPerWeek: 1,
    strengthSessionsPerWeek: 2,
    startPolicy: 'today',
    longWorkoutDay: 'Saturday',
    goalMode: 'continuous',
    trainingPriority: 'hybrid',
    twoADayPreference: 'never',
    calendarSource: provider,
    notes: `Live sandbox Training calendar lifecycle E2E. ${runMarker}. Provider ${provider}.`,
    idempotencyKey: `training-e2e-live-calendar-${runId}-${provider}`,
  };
  const created = await api('POST', '/api/v1/training/plan/generate', request, [201, 200]);
  const planId = Number(created.payload?.data?.planId);
  assert(Number.isInteger(planId) && planId > 0, `${provider} plan creation did not return a valid planId`);
  assert(created.payload?.data?.fallbackTemplateUsed !== true, `${provider} plan used fallback template`);
  evidence.steps.push({
    provider,
    step: 'plan_created',
    planId,
    eventsCreated: created.payload?.data?.eventsCreated ?? null,
    totalSessions: created.payload?.data?.totalSessions ?? null,
    calendarSource: created.payload?.data?.calendarSource ?? null,
  });
  return planId;
}

function readLinkedSessions(planId: number, provider: Provider): LinkedSession[] {
  return db.prepare(`
    SELECT id, title, duration_minutes, calendar_event_id, calendar_source, updated_at
      FROM training_sessions
     WHERE plan_id = ?
       AND calendar_source = ?
       AND calendar_event_id IS NOT NULL
     ORDER BY id ASC
  `).all(planId, provider) as LinkedSession[];
}

function readActiveOwnershipCount(planId: number, provider: Provider): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
      FROM training_agenda_event_ownership
     WHERE plan_id = ?
       AND calendar_source = ?
       AND status = 'active'
  `).get(planId, provider) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

async function providerEvents(provider: Provider) {
  const start = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString();
  return unifiedCalendar.getEventsForSources(start, end, userId, [provider]);
}

async function readProviderEventsByRunMarker(provider: Provider) {
  const events = await providerEvents(provider);
  return events.filter((event) => String(event.description || '').includes(runMarker));
}

async function markEventsWithRunMarker(provider: Provider, linked: LinkedSession[]): Promise<void> {
  const events = await providerEvents(provider);
  const byId = new Map(events.map((event) => [String(event.id), event]));
  for (const session of linked) {
    const event = byId.get(String(session.calendar_event_id));
    assert(event, `${provider} linked event ${hashId(session.calendar_event_id)} was not visible on provider read-back`);
    const currentDescription = String(event.description || '');
    const nextDescription = currentDescription.includes(runMarker)
      ? currentDescription
      : `${currentDescription.trim()}\n\n${runMarker}\nProvider: ${provider}`.trim();
    await unifiedCalendar.updateEvent({
      event_id: session.calendar_event_id,
      new_description: nextDescription,
    }, provider, userId);
  }
}

async function verifyIdempotentSync(provider: Provider, planId: number): Promise<void> {
  const beforeOwnership = readActiveOwnershipCount(planId, provider);
  const beforeLinked = readLinkedSessions(planId, provider);
  const sync = await api('POST', '/api/v1/training/plan/sync-calendar', { calendarSource: provider });
  const afterOwnership = readActiveOwnershipCount(planId, provider);
  const afterLinked = readLinkedSessions(planId, provider);
  assert(afterOwnership === beforeOwnership, `${provider} idempotent sync changed active ownership count ${beforeOwnership} -> ${afterOwnership}`);
  assert(afterLinked.length === beforeLinked.length, `${provider} idempotent sync changed linked session count ${beforeLinked.length} -> ${afterLinked.length}`);
  evidence.steps.push({
    provider,
    step: 'sync_idempotent',
    status: sync.status,
    activeOwnershipBefore: beforeOwnership,
    activeOwnershipAfter: afterOwnership,
    linkedSessions: afterLinked.length,
  });
}

async function verifyExternalMoveRepair(provider: Provider, planId: number): Promise<void> {
  const linked = readLinkedSessions(planId, provider);
  const target = linked[0];
  assert(target, `${provider} has no linked event to move externally`);
  const events = await providerEvents(provider);
  const event = events.find((candidate) => candidate.id === target.calendar_event_id);
  assert(event, `${provider} external move target is missing on provider read-back`);
  const originalStartMs = Date.parse(event.start);
  const originalEndMs = Date.parse(event.end);
  assert(Number.isFinite(originalStartMs) && Number.isFinite(originalEndMs), `${provider} external move target has invalid times`);
  const movedStart = new Date(originalStartMs + 20 * 60_000).toISOString();
  const movedEnd = new Date(originalEndMs + 20 * 60_000).toISOString();
  await unifiedCalendar.updateEvent({
    event_id: target.calendar_event_id,
    new_start: movedStart,
    new_end: movedEnd,
  }, provider, userId);

  const sync = await api('POST', '/api/v1/training/plan/sync-calendar', { calendarSource: provider });
  const afterLinked = readLinkedSessions(planId, provider);
  const repaired = afterLinked.find((session) => session.id === target.id);
  assert(repaired?.calendar_event_id, `${provider} moved event repair left session unlinked`);
  await markEventsWithRunMarker(provider, afterLinked);
  evidence.steps.push({
    provider,
    step: 'external_move_repaired',
    status: sync.status,
    sessionId: target.id,
    originalEventHash: hashId(target.calendar_event_id),
    repairedEventHash: hashId(repaired.calendar_event_id),
  });
}

async function verifyExternalDeleteRepair(provider: Provider, planId: number): Promise<void> {
  const linked = readLinkedSessions(planId, provider);
  const target = linked[1] || linked[0];
  assert(target, `${provider} has no linked event to delete externally`);
  await unifiedCalendar.deleteEvent(target.calendar_event_id, provider, userId);
  ageSessionCalendarLink(target.id);

  const weeks = await api('GET', '/api/v1/training/plan/weeks');
  const readModelSession = flattenWeekSessions(weeks.payload?.data?.weeks)
    .find((session: any) => String(session.id) === String(target.id));
  assert(
    readModelSession?.calendarSyncState === 'repair_needed'
      || readModelSession?.legacyCalendarSyncState === 'unsynced'
      || readModelSession?.calendarEventId == null,
    `${provider} external delete did not surface repair-needed/unsynced state before repair`,
  );

  const sync = await api('POST', '/api/v1/training/plan/sync-calendar', { calendarSource: provider });
  const afterLinked = readLinkedSessions(planId, provider);
  const repaired = afterLinked.find((session) => session.id === target.id);
  assert(repaired?.calendar_event_id, `${provider} external delete repair left session unlinked`);
  assert(repaired.calendar_event_id !== target.calendar_event_id, `${provider} external delete repair reused the deleted event id`);
  await markEventsWithRunMarker(provider, afterLinked);
  evidence.steps.push({
    provider,
    step: 'external_delete_repaired',
    status: sync.status,
    sessionId: target.id,
    deletedEventHash: hashId(target.calendar_event_id),
    repairedEventHash: hashId(repaired.calendar_event_id),
    readModelStateBeforeRepair: readModelSession?.calendarSyncState ?? readModelSession?.legacyCalendarSyncState ?? null,
  });
}

function ageSessionCalendarLink(sessionId: number): void {
  db.prepare(`
    UPDATE training_sessions
       SET updated_at = datetime('now', '-45 minutes')
     WHERE id = ?
  `).run(sessionId);
}

async function cleanupPlanAndProviderEvents(provider: Provider, planId: number): Promise<void> {
  const beforeMarkerEvents = await readProviderEventsByRunMarker(provider);
  const cancel = await api('POST', '/api/v1/training/plan/cancel', { planId }, [200, 404, 409]);
  const afterMarkerEvents = await readProviderEventsByRunMarker(provider);
  for (const event of afterMarkerEvents) {
    try {
      await unifiedCalendar.deleteEvent(event.id, provider, userId);
    } catch (err) {
      evidence.cleanupFailures.push({
        provider,
        eventHash: hashId(event.id),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const leftovers = await readProviderEventsByRunMarker(provider);
  assert(leftovers.length === 0, `${provider} cleanup left ${leftovers.length} run-marked provider events`);
  evidence.steps.push({
    provider,
    step: 'cancel_cleanup_verified',
    planId,
    cancelStatus: cancel.status,
    runMarkedEventsBeforeCancel: beforeMarkerEvents.length,
    runMarkedEventsAfterCancel: afterMarkerEvents.length,
    leftovers: leftovers.length,
  });
}

function flattenWeekSessions(weeks: unknown): any[] {
  return Array.isArray(weeks)
    ? weeks.flatMap((week: any) => Array.isArray(week?.sessions) ? week.sessions : [])
    : [];
}

function hashId(value: unknown): string {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
