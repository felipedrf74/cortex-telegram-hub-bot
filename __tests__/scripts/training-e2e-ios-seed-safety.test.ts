import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(__dirname, '../..');
const temporaryRoots: string[] = [];

type RunPolicy = { mode: 'fresh' | 'resume'; qualifying: boolean };

type ScenarioContext = {
  backendBaseUrl: string;
  dbPath: string;
  metadata: Record<string, any>;
  runId: string;
  stateRoot: string;
};

type ScenarioOptions = {
  deleteDbBeforeRun?: boolean;
  fixtureLockDomain?: 'container' | 'host';
  mode?: 'cleanup-clarification' | 'verify-clarification';
  runPolicy?: RunPolicy;
  prepareDb?: (db: Database.Database) => void;
  evidence?: (context: ScenarioContext) => Record<string, any>;
  homeState?: string;
};

function canonicalJson(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
}

function digest(value: any): string {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex');
}

function initializeDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT UNIQUE,
        email_verified INTEGER,
        first_name TEXT,
        language TEXT,
        timezone TEXT,
        tier TEXT,
        status TEXT,
        auth_provider TEXT
      );
      CREATE TABLE subscriptions (
        user_id INTEGER PRIMARY KEY,
        plan TEXT,
        period TEXT,
        status TEXT,
        provider TEXT,
        current_period_start TEXT,
        current_period_end TEXT,
        updated_at TEXT
      );
      CREATE TABLE user_profiles (
        user_id INTEGER NOT NULL,
        profile_type TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT,
        UNIQUE(user_id, profile_type)
      );
      CREATE TABLE onboarding_sessions (user_id INTEGER);
      CREATE TABLE fitness_training_plans (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        name TEXT,
        goal TEXT,
        duration_weeks INTEGER,
        status TEXT,
        preferences_json TEXT
      );
      CREATE TABLE training_weeks (id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL);
      CREATE TABLE training_sessions (
        id INTEGER PRIMARY KEY,
        plan_id INTEGER NOT NULL,
        status TEXT,
        calendar_event_id TEXT,
        calendar_source TEXT
      );
      CREATE TABLE training_completions (id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL);
      CREATE TABLE training_agenda_event_ownership (
        user_id INTEGER,
        plan_id INTEGER NOT NULL,
        status TEXT
      );
      CREATE TABLE secretary_agenda_items (
        agenda_item_id TEXT PRIMARY KEY,
        source_intent_id TEXT NOT NULL,
        source_skill TEXT NOT NULL,
        source_entity_id TEXT,
        source_entity_type TEXT,
        owner_user_id INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL,
        provider_sync_state TEXT NOT NULL,
        provider_event_id TEXT
      );
      CREATE TABLE training_plan_generation_idempotency_scoped (
        user_id INTEGER,
        tenant_id INTEGER,
        idempotency_key TEXT,
        request_hash TEXT,
        status TEXT,
        response_json TEXT,
        status_code INTEGER,
        created_at TEXT
      );
    `);
    db.prepare(`
      INSERT INTO users (
        id, email, email_verified, first_name, language, timezone, tier, status, auth_provider
      ) VALUES (1, 'training-seed@example.test', 1, 'Seed', 'en-US', 'Europe/Lisbon', 'max', 'active', 'email')
    `).run();
  } finally {
    db.close();
  }
}

function backendProvenance(metadata: Record<string, any>): Record<string, any> {
  return {
    schemaVersion: metadata.schemaVersion,
    runId: metadata.runId,
    runPolicy: metadata.runPolicy,
    git: {
      commit: metadata.git.commit,
      baseCommit: metadata.git.baseCommit,
      dirtyTreeDiffSha256: metadata.git.dirtyTreeDiffSha256,
    },
    images: {
      backend: {
        name: metadata.images.backend.name,
        builtImageId: metadata.images.backend.builtImageId,
        actualContainerImageId: metadata.images.backend.actualContainerImageId,
      },
      contentEngine: {
        name: metadata.images.contentEngine.name,
        builtImageId: metadata.images.contentEngine.builtImageId,
        actualContainerImageId: metadata.images.contentEngine.actualContainerImageId,
      },
    },
  };
}

function clarificationEvidence(
  context: ScenarioContext,
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    schemaVersion: 'training_ios_clarification.v1',
    phase: 'prepared',
    runId: context.runId,
    seedAttemptId: 'seed-attempt-1',
    backendBaseUrl: context.backendBaseUrl,
    dbPath: context.dbPath,
    userId: 1,
    expectedTenantId: 1,
    backendProvenance: backendProvenance(context.metadata),
    baseline: { planIds: [] },
    ...overrides,
  };
}

async function runScenario(options: ScenarioOptions = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(sourceRoot, '.local/training-e2e-ios-seed-test-'));
  temporaryRoots.push(fixtureRoot);
  const scriptsRoot = path.join(fixtureRoot, 'scripts');
  const localRoot = path.join(fixtureRoot, '.local/training-e2e');
  const runId = 'seed-safety-run';
  const stateRoot = path.join(localRoot, runId);
  const dbPath = path.join(stateRoot, 'training-e2e.sqlite');
  const authPath = path.join(stateRoot, 'auth.json');
  fs.mkdirSync(scriptsRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  initializeDatabase(dbPath);
  if (options.prepareDb) {
    const db = new Database(dbPath);
    try {
      options.prepareDb(db);
    } finally {
      db.close();
    }
  }

  const backendBaseUrl = 'http://127.0.0.1:19273';

  const imageA = `sha256:${'a'.repeat(64)}`;
  const imageB = `sha256:${'b'.repeat(64)}`;
  const metadata = {
    schemaVersion: 'training_e2e_environment.v2',
    runId,
    backendBaseUrl,
    dbPath,
    runPolicy: options.runPolicy ?? { mode: 'fresh', qualifying: true },
    git: {
      commit: 'c'.repeat(40),
      baseCommit: 'd'.repeat(40),
      dirtyTreeDiffSha256: 'e'.repeat(64),
    },
    images: {
      backend: {
        name: `nexus-hub-node:training-e2e-${runId}`,
        builtImageId: imageA,
        actualContainerImageId: imageA,
      },
      contentEngine: {
        name: `nexus-hub-content-engine:training-e2e-${runId}`,
        builtImageId: imageB,
        actualContainerImageId: imageB,
      },
    },
    sqlite: {
      fixtureLockDomain: options.fixtureLockDomain ?? 'host',
    },
  };
  const context = { backendBaseUrl, dbPath, metadata, runId, stateRoot };
  fs.writeFileSync(path.join(stateRoot, 'metadata.json'), JSON.stringify(metadata));
  fs.writeFileSync(authPath, JSON.stringify({ accessToken: 'fixture-token', user: { id: 1, tenantId: 1 } }));
  fs.writeFileSync(path.join(localRoot, 'latest.env'), [
    `export NEXUS_TRAINING_E2E_ROOT='${stateRoot}'`,
    `export NEXUS_TRAINING_E2E_BASE_URL='${backendBaseUrl}'`,
    `export NEXUS_TRAINING_E2E_RUN_ID='${runId}'`,
    `export NEXUS_TRAINING_E2E_AUTH_FILE='${authPath}'`,
    '',
  ].join('\n'));
  if (options.evidence) {
    fs.writeFileSync(
      path.join(stateRoot, 'training-ios-clarification-evidence.json'),
      `${JSON.stringify(options.evidence(context), null, 2)}\n`,
    );
  }
  if (options.deleteDbBeforeRun) {
    fs.rmSync(dbPath);
  }
  const scriptPath = path.join(scriptsRoot, 'training-e2e-ios-seed.mjs');
  const fetchMockPath = path.join(fixtureRoot, 'fetch-mock.mjs');
  fs.copyFileSync(path.join(sourceRoot, 'scripts/training-e2e-ios-seed.mjs'), scriptPath);
  fs.writeFileSync(fetchMockPath, `
globalThis.fetch = async (input, init = {}) => {
  const route = new URL(String(input)).pathname;
  const method = String(init.method || 'GET').toUpperCase();
  let status = 200;
  let payload;
  if (method === 'GET' && route === '/api/v1/training/home') {
    payload = { data: { hero: { state: ${JSON.stringify(options.homeState ?? 'noPlan')} } } };
  } else if (method === 'POST' && route === '/api/v1/training/plan/cancel') {
    payload = { data: { cancelled: true } };
  } else {
    status = 404;
    payload = { error: { code: 'NOT_FOUND' } };
  }
  return { status, text: async () => JSON.stringify(payload) };
};
`);

  const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, options.mode ?? 'cleanup-clarification'], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(fetchMockPath).href}`,
        NEXUS_TRAINING_E2E_IOS_SEED_ATTEMPT_ID: 'seed-attempt-1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr, stdout }));
  });
  return { ...result, context };
}

function insertProviderVerificationFixture(db: Database.Database, includeLiveProviderMapping = true): void {
  const baselineFitness = { experienceLevel: 'Intermediate', available_equipment: 'unknown' };
  const answeredGym = {
    equipment_access: 'Full commercial gym',
    session_duration_minutes: '60',
  };
  const sentinelGym = {
    marker: 'scope-sentinel-seed-safety-run',
    equipment_access: 'SENTINEL MUST NOT CHANGE',
    session_duration_minutes: '179',
  };
  db.prepare('INSERT INTO users (id, email) VALUES (2, ?)').run('scope-sentinel@example.test');
  db.prepare('INSERT INTO user_profiles (user_id, profile_type, data) VALUES (?, ?, ?)')
    .run(1, 'fitness', JSON.stringify(baselineFitness));
  db.prepare('INSERT INTO user_profiles (user_id, profile_type, data) VALUES (?, ?, ?)')
    .run(1, 'triathlon-gym', JSON.stringify(answeredGym));
  db.prepare('INSERT INTO user_profiles (user_id, profile_type, data) VALUES (?, ?, ?)')
    .run(2, 'triathlon-gym', JSON.stringify(sentinelGym));

  const expectedRequest = {
    objective: 'Muscle Building',
    durationWeeks: 4,
    preferredTime: '12:00',
    preferredCardioTime: '07:00',
    preferredStrengthTime: '12:30',
    goalMode: 'continuous',
    trainingPriority: 'strength',
    sessionsPerWeek: 5,
    runSessionsPerWeek: 0,
    bikeSessionsPerWeek: 0,
    swimSessionsPerWeek: 0,
    strengthSessionsPerWeek: 5,
    longWorkoutDay: 'Saturday',
    twoADayPreference: 'auto',
    startPolicy: 'today',
    calendarSource: null,
    notes: null,
    raceDate: null,
    schedulingTimezone: 'Europe/Lisbon',
  };
  const preferences = {
    preferredTime: expectedRequest.preferredTime,
    preferredCardioTime: expectedRequest.preferredCardioTime,
    preferredStrengthTime: expectedRequest.preferredStrengthTime,
    goalMode: expectedRequest.goalMode,
    trainingPriority: expectedRequest.trainingPriority,
    requestedTargets: {
      sessionsPerWeek: expectedRequest.sessionsPerWeek,
      runSessionsPerWeek: expectedRequest.runSessionsPerWeek,
      bikeSessionsPerWeek: expectedRequest.bikeSessionsPerWeek,
      swimSessionsPerWeek: expectedRequest.swimSessionsPerWeek,
      strengthSessionsPerWeek: expectedRequest.strengthSessionsPerWeek,
    },
    longWorkoutDay: expectedRequest.longWorkoutDay,
    twoADayPreference: expectedRequest.twoADayPreference,
    startPolicy: expectedRequest.startPolicy,
    trainingCalendarSource: null,
    notes: null,
    raceDate: null,
    schedulingTimezone: expectedRequest.schedulingTimezone,
  };
  db.prepare(`
    INSERT INTO fitness_training_plans (
      id, user_id, tenant_id, name, goal, duration_weeks, status, preferences_json
    ) VALUES (42, 1, 1, 'Clarification Plan', ?, 4, 'active', ?)
  `).run(expectedRequest.objective, JSON.stringify(preferences));
  db.prepare(`
    INSERT INTO training_sessions (id, plan_id, status, calendar_event_id, calendar_source)
    VALUES (420, 42, 'pending', NULL, NULL)
  `).run();
  db.prepare(`
    INSERT INTO training_plan_generation_idempotency_scoped (
      user_id, tenant_id, idempotency_key, request_hash, status, response_json, status_code, created_at
    ) VALUES (1, 1, 'clarification-create', 'request-hash', 'succeeded', ?, 201, '2026-08-03T10:00:00.000Z')
  `).run(JSON.stringify({ data: { planId: 42 } }));
  if (includeLiveProviderMapping) {
    db.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_entity_id, source_entity_type,
        owner_user_id, tenant_id, lifecycle_state, provider_sync_state, provider_event_id
      ) VALUES (
        'agenda-420', 'training:42:1:420', 'training', '420', 'training_session',
        1, '1', 'synced', 'synced', 'provider-event-420'
      )
    `).run();
  }
}

function providerVerificationEvidence(context: ScenarioContext): Record<string, any> {
  const baselineFitness = { experienceLevel: 'Intermediate', available_equipment: 'unknown' };
  const baselineGym = { equipment_access: 'unknown' };
  const sentinelGym = {
    marker: 'scope-sentinel-seed-safety-run',
    equipment_access: 'SENTINEL MUST NOT CHANGE',
    session_duration_minutes: '179',
  };
  return clarificationEvidence(context, {
    phase: 'prepared',
    expectedAnswers: {
      equipmentAccess: 'Full commercial gym',
      sessionDurationMinutes: '60',
    },
    expectedRequest: {
      objective: 'Muscle Building',
      durationWeeks: 4,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      goalMode: 'continuous',
      trainingPriority: 'strength',
      sessionsPerWeek: 5,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 0,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 5,
      longWorkoutDay: 'Saturday',
      twoADayPreference: 'auto',
      startPolicy: 'today',
      calendarSource: null,
      notes: null,
      raceDate: null,
      schedulingTimezone: 'Europe/Lisbon',
    },
    sentinel: {
      userId: 2,
      email: 'scope-sentinel@example.test',
      data: sentinelGym,
      digest: digest(sentinelGym),
    },
    baseline: {
      targetProfiles: [
        { userId: 1, profileType: 'fitness', data: baselineFitness },
        { userId: 1, profileType: 'triathlon-gym', data: baselineGym },
      ],
      otherProfilesDigest: digest([]),
      otherProfileRowCount: 0,
      planIds: [],
      idempotencyKeys: [],
    },
  });
}

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe('Training E2E iOS clarification seed safety', () => {
  it('refuses direct host execution for a container-owned fixture lock domain before opening SQLite', async () => {
    const result = await runScenario({
      deleteDbBeforeRun: true,
      fixtureLockDomain: 'container',
      evidence: (context) => clarificationEvidence(context),
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/container|lock domain|host execution/i);
    expect(fs.existsSync(result.context.dbPath)).toBe(false);
  });

  it('accepts matching qualifying evidence and the canonical no-plan home state', async () => {
    const result = await runScenario({
      evidence: (context) => clarificationEvidence(context),
    });

    expect(result.code, result.stderr).toBe(0);
    const evidence = JSON.parse(fs.readFileSync(
      path.join(result.context.stateRoot, 'training-ios-clarification-evidence.json'),
      'utf8',
    ));
    expect(evidence).toMatchObject({
      phase: 'cleaned_without_verification',
      homeHeroState: 'noPlan',
      cleanupProof: { clean: true },
    });
  });

  it('rejects resumed, non-qualifying runtime metadata', async () => {
    const result = await runScenario({
      runPolicy: { mode: 'resume', qualifying: false },
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/fresh|qualifying|non-qualifying|resume/i);
  });

  it.each([
    ['tenant', (evidence: Record<string, any>) => ({ ...evidence, expectedTenantId: 99 })],
    ['backend URL', (evidence: Record<string, any>) => ({ ...evidence, backendBaseUrl: 'http://127.0.0.1:19999' })],
    ['backend provenance', (evidence: Record<string, any>) => ({
      ...evidence,
      backendProvenance: {
        ...evidence.backendProvenance,
        git: { ...evidence.backendProvenance.git, commit: 'f'.repeat(40) },
      },
    })],
  ])('rejects cleanup evidence with mismatched %s identity', async (_label, mutateEvidence) => {
    const result = await runScenario({
      evidence: (context) => mutateEvidence(clarificationEvidence(context)),
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/evidence|scope|tenant|backend|provenance/i);
  });

  it('requires the canonical Training home no-plan state after cleanup', async () => {
    const result = await runScenario({
      evidence: (context) => clarificationEvidence(context),
      homeState: 'activePlan',
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/home|no.?plan|active/i);
  });

  it('fails closed when the verified plan id belongs to the wrong tenant', async () => {
    const result = await runScenario({
      evidence: (context) => clarificationEvidence(context, {
        phase: 'verified',
        verification: { planId: 42 },
      }),
      prepareDb: (db) => {
        db.prepare(`
          INSERT INTO fitness_training_plans (id, user_id, tenant_id, status)
          VALUES (42, 1, 99, 'active')
        `).run();
      },
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/plan 42|tenant|scope/i);
  });

  it('uses the verified plan id to detect orphaned durable rows after the plan row is gone', async () => {
    const result = await runScenario({
      evidence: (context) => clarificationEvidence(context, {
        phase: 'verified',
        verification: { planId: 42 },
      }),
      prepareDb: (db) => {
        db.prepare('INSERT INTO training_weeks (id, plan_id) VALUES (420, 42)').run();
      },
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/durable|orphan|weekRows|plan 42/i);
  });

  it('rejects a fixture-safe verification when Secretary has a live provider mapping', async () => {
    const result = await runScenario({
      mode: 'verify-clarification',
      prepareDb: insertProviderVerificationFixture,
      evidence: providerVerificationEvidence,
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/provider|calendar|agenda/i);
  });

  it('records zero Secretary provider mappings for a fixture-safe verification', async () => {
    const result = await runScenario({
      mode: 'verify-clarification',
      prepareDb: (db) => insertProviderVerificationFixture(db, false),
      evidence: providerVerificationEvidence,
    });

    expect(result.code, result.stderr).toBe(0);
    const evidence = JSON.parse(fs.readFileSync(
      path.join(result.context.stateRoot, 'training-ios-clarification-evidence.json'),
      'utf8',
    ));
    expect(evidence).toMatchObject({
      phase: 'verified',
      verification: { secretaryLiveProviderMappingCount: 0 },
    });
  });
});
