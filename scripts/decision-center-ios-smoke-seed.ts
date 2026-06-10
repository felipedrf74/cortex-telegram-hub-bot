// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Decision Center iOS smoke seeder/assertion runner.
 *
 * This script is intentionally local-only. It registers one sandbox iOS user
 * through the real `/api/v1/auth/register` endpoint, writes the debug-auth JSON
 * consumed by `DebugAuthTokenImporter`, seeds real Decision Center rows in the
 * sandbox SQLite DB, and verifies the v1 iOS routes over HTTP.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { NotificationIntentInput } from '../src/services/notification-orchestrator';
import { CURRENT_LEGAL_DOCUMENTS } from '../src/services/legal-consent';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8200';
const DEFAULT_INVITE_CODE = 'LOCAL-DECISION-IOS-SMOKE';
const DEFAULT_INTERNAL_SECRET = 'local-decision-center-ios-smoke-internal-secret';
const DEFAULT_AUTH_FILE = '.local/decision-center-ios-smoke/local-ios-auth.json';
const DEFAULT_MANIFEST_FILE = '.local/decision-center-ios-smoke/manifest.json';
const DEFAULT_PUSH_FILE = '.local/decision-center-ios-smoke/decision-center-push.apns.json';
const DEFAULT_DB_PATH = 'data/decision-center-ios-smoke.db';
const SMOKE_PREFIX = 'local-ios:decision-center-smoke:';
const SMOKE_TITLE = 'Local smoke schedule conflict';
const BLOCKED_TITLE = 'Local smoke dependency blocked';
const HANDLED_TITLE = 'Local smoke handled by Nexus';

type AuthUser = {
  id: number;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  language?: string | null;
};

type AuthPayload = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUser;
};

type SmokeManifest = {
  generatedAt: string;
  baseUrl: string;
  dbPath: string;
  authFile: string;
  pushFile: string;
  userId: number;
  tenantId: number;
  decisions: {
    uiOpen: string;
    apiAction: string;
    blocked: string;
    blocker: string;
    expired: string;
  };
  titles: {
    uiOpen: string;
    blocked: string;
    handled: string;
  };
};

type CliOptions = {
  command: string;
  baseUrl: string;
  dbPath: string;
  authFile: string;
  manifestFile: string;
  pushFile: string;
  inviteCode: string;
  internalSecret: string;
};

type SeedDecisionInput = {
  userId: number;
  tenantId: number;
  title: string;
  body: string;
  relatedEntityId: string;
  dedupeKey: string;
  expiresAt: string;
  decisionDeadline: string;
  actionButtons: NotificationIntentInput['actionButtons'];
  context: NonNullable<NotificationIntentInput['decisionContext']>;
  status?: string;
};

const options = parseArgs(process.argv.slice(2));

void main(options).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[decision-center-ios-smoke] FAIL ${message}`);
  process.exit(1);
});

async function main(opts: CliOptions): Promise<void> {
  switch (opts.command) {
    case 'bootstrap-schema': {
      bootstrapSmokeSchema(opts.dbPath);
      console.log(`[decision-center-ios-smoke] bootstrapped smoke schema at ${opts.dbPath}`);
      return;
    }
    case 'seed': {
      const auth = await registerLocalIosUser(opts);
      await primeDecisionCenterSchema(opts, auth);
      const manifest = await seedDecisionCenter(opts, auth);
      writePushPayload(opts.pushFile, manifest, auth);
      console.log(`[decision-center-ios-smoke] seeded ${manifest.decisions.uiOpen} for user ${manifest.userId}`);
      return;
    }
    case 'assert-backend': {
      const manifest = readManifest(opts.manifestFile);
      const auth = readAuth(opts.authFile);
      await assertBackendRoutes(opts.baseUrl, manifest, auth);
      console.log('[decision-center-ios-smoke] backend API assertions passed');
      return;
    }
    case 'assert-ios-action': {
      const manifest = readManifest(opts.manifestFile);
      await assertIosActionLedger(opts.dbPath, manifest);
      console.log('[decision-center-ios-smoke] iOS action ledger assertions passed');
      return;
    }
    default:
      throw new Error(`unknown command: ${opts.command}`);
  }
}

function parseArgs(argv: string[]): CliOptions {
  const command = argv[0] ?? 'seed';
  const value = (name: string, fallback: string): string => {
    const direct = argv.find((arg) => arg.startsWith(`${name}=`));
    if (direct) return direct.slice(name.length + 1);
    const index = argv.indexOf(name);
    if (index >= 0 && argv[index + 1]) return argv[index + 1];
    return fallback;
  };
  return {
    command,
    baseUrl: trimTrailingSlash(value('--base-url', process.env.NEXUS_DECISION_CENTER_SMOKE_BASE_URL ?? DEFAULT_BASE_URL)),
    dbPath: path.resolve(value('--db', process.env.DATABASE_PATH ?? DEFAULT_DB_PATH)),
    authFile: path.resolve(value('--auth-file', process.env.NEXUS_LOCAL_AUTH_IMPORT_PATH ?? DEFAULT_AUTH_FILE)),
    manifestFile: path.resolve(value('--manifest-file', process.env.NEXUS_DECISION_CENTER_SMOKE_MANIFEST ?? DEFAULT_MANIFEST_FILE)),
    pushFile: path.resolve(value('--push-file', process.env.NEXUS_DECISION_CENTER_PUSH_PAYLOAD ?? DEFAULT_PUSH_FILE)),
    inviteCode: value('--invite-code', process.env.IOS_INVITE_CODE ?? DEFAULT_INVITE_CODE),
    internalSecret: value('--internal-secret', process.env.INTERNAL_API_SECRET ?? DEFAULT_INTERNAL_SECRET),
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

async function registerLocalIosUser(opts: CliOptions): Promise<AuthPayload> {
  const deviceId = `decision-center-ios-smoke-${process.env.USER ?? 'local'}`;
  const res = await fetch(`${opts.baseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId,
      deviceName: 'Decision Center iOS Smoke Simulator',
      inviteCode: opts.inviteCode,
      acceptedLegal: {
        accepted: true,
        termsVersion: CURRENT_LEGAL_DOCUMENTS.terms.version,
        privacyVersion: CURRENT_LEGAL_DOCUMENTS.privacy.version,
      },
    }),
  });
  const json = await readJson(res);
  const payload = unwrapData<AuthPayload>(json, '/api/v1/auth/register');
  if (!payload.accessToken || !payload.refreshToken || !payload.user?.id) {
    throw new Error('auth/register did not return the debug auth payload shape');
  }
  mkdirFor(opts.authFile);
  fs.writeFileSync(opts.authFile, JSON.stringify(payload, null, 2));
  return payload;
}

async function seedDecisionCenter(opts: CliOptions, auth: AuthPayload): Promise<SmokeManifest> {
  const db = new Database(opts.dbPath);
  db.pragma('busy_timeout = 5000');
  const userId = Number(auth.user.id);
  const tenantId = userId;
  try {
    assertSmokeSchemaReady(db);
    cleanupPreviousSmokeRows(db, userId, tenantId);

    const now = new Date();
    const start = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 45 * 60 * 1000);
    const recommended = new Date(start.getTime() + 90 * 60 * 1000);
    const recommendedEnd = new Date(recommended.getTime() + 45 * 60 * 1000);
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const deadline = new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString();

    const uiOpen = insertSeedDecision(db, {
      userId,
      tenantId,
      title: SMOKE_TITLE,
      body: 'Nexus found a concrete schedule conflict and needs one local smoke decision.',
      relatedEntityId: 'local-ios-secretary-conflict-ui',
      dedupeKey: `${SMOKE_PREFIX}ui-open`,
      expiresAt,
      decisionDeadline: deadline,
      actionButtons: [
        { id: 'dismiss', label: 'Clear decision', style: 'primary', mutating: true },
        { id: 'open_detail', label: 'Review details', style: 'secondary' },
      ],
      context: {
        entityTitle: SMOKE_TITLE,
        currentStartAt: start.toISOString(),
        currentEndAt: end.toISOString(),
        recommendedStartAt: recommended.toISOString(),
        recommendedEndAt: recommendedEnd.toISOString(),
        candidateSlots: [
          {
            startAt: recommended.toISOString(),
            endAt: recommendedEnd.toISOString(),
            label: 'Best smoke slot',
            classification: 'available',
          },
        ],
        reasonCodes: ['calendar_conflict', 'deadline_soon'],
        sourceState: 'conflict_detected',
        providerSyncState: 'synced',
        providerSyncUpdatedAt: now.toISOString(),
        deadlineAt: deadline,
      },
    });

    const apiAction = insertSeedDecision(db, {
      userId,
      tenantId,
      title: 'Local smoke API action decision',
      body: 'Backend preflight uses this separate row for idempotency assertions.',
      relatedEntityId: 'local-ios-secretary-conflict-api',
      dedupeKey: `${SMOKE_PREFIX}api-action`,
      expiresAt,
      decisionDeadline: deadline,
      actionButtons: [
        { id: 'dismiss', label: 'Dismiss API row', style: 'primary', mutating: true },
        { id: 'open_detail', label: 'Review details', style: 'secondary' },
      ],
      context: {
        entityTitle: 'Local smoke API action decision',
        currentStartAt: start.toISOString(),
        currentEndAt: end.toISOString(),
        recommendedStartAt: recommended.toISOString(),
        recommendedEndAt: recommendedEnd.toISOString(),
        candidateSlots: [{ startAt: recommended.toISOString(), endAt: recommendedEnd.toISOString(), label: 'API slot' }],
        reasonCodes: ['calendar_conflict'],
        sourceState: 'conflict_detected',
        providerSyncState: 'synced',
        providerSyncUpdatedAt: now.toISOString(),
        deadlineAt: deadline,
      },
    });

    const blocker = insertSeedDecision(db, {
      userId,
      tenantId,
      title: 'Local smoke dependency source',
      body: 'Resolve this prerequisite before the blocked smoke decision can proceed.',
      relatedEntityId: 'local-ios-secretary-conflict-blocker',
      dedupeKey: `${SMOKE_PREFIX}blocker`,
      expiresAt,
      decisionDeadline: deadline,
      actionButtons: [{ id: 'open_detail', label: 'Review dependency', style: 'primary' }],
      context: {
        entityTitle: 'Local smoke dependency source',
        currentStartAt: start.toISOString(),
        currentEndAt: end.toISOString(),
        recommendedStartAt: recommended.toISOString(),
        recommendedEndAt: recommendedEnd.toISOString(),
        candidateSlots: [{ startAt: recommended.toISOString(), endAt: recommendedEnd.toISOString(), label: 'Dependency slot' }],
        reasonCodes: ['calendar_conflict'],
        sourceState: 'conflict_detected',
        providerSyncState: 'synced',
        providerSyncUpdatedAt: now.toISOString(),
        deadlineAt: deadline,
      },
    });

    const blocked = insertSeedDecision(db, {
      userId,
      tenantId,
      title: BLOCKED_TITLE,
      body: 'This smoke decision is intentionally blocked by another local decision.',
      relatedEntityId: 'local-ios-secretary-conflict-blocked',
      dedupeKey: `${SMOKE_PREFIX}blocked`,
      expiresAt,
      decisionDeadline: deadline,
      actionButtons: [
        { id: 'open_detail', label: 'Review blocked dependency', style: 'primary' },
        { id: 'dismiss', label: 'Dismiss blocked row', style: 'secondary', mutating: true },
      ],
      context: {
        entityTitle: BLOCKED_TITLE,
        currentStartAt: start.toISOString(),
        currentEndAt: end.toISOString(),
        recommendedStartAt: recommended.toISOString(),
        recommendedEndAt: recommendedEnd.toISOString(),
        candidateSlots: [{ startAt: recommended.toISOString(), endAt: recommendedEnd.toISOString(), label: 'Blocked slot' }],
        reasonCodes: ['calendar_conflict', 'dependency_wait'],
        sourceState: 'conflict_detected',
        providerSyncState: 'synced',
        providerSyncUpdatedAt: now.toISOString(),
        deadlineAt: deadline,
      },
    });
    addDecisionDependencyRow(db, {
    decisionId: decisionIdFromItem(blocked),
    dependsOnDecisionId: decisionIdFromItem(blocker),
    userId,
    tenantId,
    relationship: 'blocks',
  });

    const expiredAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const expiredDeadline = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const expired = insertSeedDecision(db, {
      userId,
      tenantId,
      title: 'Local smoke expired decision',
      body: 'This row must never render in the active iOS Decision Center list.',
      relatedEntityId: 'local-ios-secretary-conflict-expired',
      dedupeKey: `${SMOKE_PREFIX}expired`,
      expiresAt: expiredAt,
      decisionDeadline: expiredDeadline,
      status: 'expired',
      actionButtons: [{ id: 'open_detail', label: 'Review expired row', style: 'primary' }],
      context: {
        entityTitle: 'Local smoke expired decision',
        currentStartAt: start.toISOString(),
        currentEndAt: end.toISOString(),
        recommendedStartAt: recommended.toISOString(),
        recommendedEndAt: recommendedEnd.toISOString(),
        candidateSlots: [{ startAt: recommended.toISOString(), endAt: recommendedEnd.toISOString(), label: 'Expired slot' }],
        reasonCodes: ['calendar_conflict'],
        sourceState: 'conflict_detected',
        providerSyncState: 'synced',
        providerSyncUpdatedAt: now.toISOString(),
        deadlineAt: expiredDeadline,
        internalOnly: true,
      },
    });
  db.prepare(`
    UPDATE notification_center_items
       SET created_at = ?
     WHERE item_id = ? AND user_id = ? AND tenant_id = ?
    `).run(new Date(now.getTime() + 60 * 1000).toISOString(), decisionIdFromItem(uiOpen), userId, tenantId);

    insertHandledByNexus(db, userId, tenantId);

    const manifest: SmokeManifest = {
    generatedAt: now.toISOString(),
    baseUrl: opts.baseUrl,
    dbPath: opts.dbPath,
    authFile: opts.authFile,
    pushFile: opts.pushFile,
    userId,
    tenantId,
    decisions: {
        uiOpen: decisionIdFromItem(uiOpen),
        apiAction: decisionIdFromItem(apiAction),
        blocked: decisionIdFromItem(blocked),
        blocker: decisionIdFromItem(blocker),
        expired: decisionIdFromItem(expired),
    },
    titles: {
      uiOpen: SMOKE_TITLE,
      blocked: BLOCKED_TITLE,
      handled: HANDLED_TITLE,
    },
  };
    mkdirFor(opts.manifestFile);
    fs.writeFileSync(opts.manifestFile, JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    db.close();
  }
}

function bootstrapSmokeSchema(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_intents (
        intent_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        source_skill TEXT NOT NULL,
        type TEXT NOT NULL,
        priority TEXT NOT NULL,
        related_entity_id TEXT,
        related_entity_type TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        sensitive_body TEXT,
        action_buttons_json TEXT NOT NULL DEFAULT '[]',
        deeplink TEXT,
        expires_at TEXT,
        quiet_hours_policy TEXT NOT NULL DEFAULT 'respect',
        dedupe_key TEXT,
        requires_user_action INTEGER NOT NULL DEFAULT 0,
        decision_deadline TEXT,
        delivery_policy TEXT NOT NULL DEFAULT 'auto',
        privacy_policy TEXT NOT NULL DEFAULT 'standard',
        decision_context_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS notification_center_items (
        item_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        decision_log_id TEXT,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        safe_body TEXT NOT NULL,
        sensitive_body TEXT,
        source_skill TEXT NOT NULL,
        type TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unread',
        deeplink TEXT,
        actions_json TEXT NOT NULL DEFAULT '[]',
        dedupe_key TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT,
        read_at TEXT,
        dismissed_at TEXT,
        actioned_at TEXT,
        superseded_by_item_id TEXT,
        snoozed_until TEXT,
        action_result_json TEXT
      );
      CREATE TABLE IF NOT EXISTS decision_action_executions (
        action_execution_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        executor_skill TEXT NOT NULL,
        status TEXT NOT NULL,
        expected_effect_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        failed_at TEXT,
        error_code TEXT,
        UNIQUE(decision_id, action_id, user_id, tenant_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS decision_dependencies (
        dependency_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        depends_on_decision_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        relationship TEXT NOT NULL DEFAULT 'blocks',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(decision_id, depends_on_decision_id, user_id, tenant_id, relationship)
      );
      CREATE TABLE IF NOT EXISTS handled_by_nexus_items (
        handled_item_id TEXT PRIMARY KEY,
        decision_id TEXT,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        source_skill TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        action_taken TEXT NOT NULL,
        why_brief TEXT NOT NULL,
        explanation_json TEXT,
        related_entities_json TEXT NOT NULL DEFAULT '[]',
        rollback_available INTEGER NOT NULL DEFAULT 0,
        changed_rule_option TEXT,
        privacy_classification TEXT NOT NULL DEFAULT 'standard',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS decision_lifecycle_events (
        event_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        event TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        action_id TEXT,
        reason TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS decision_outcome_ledger (
        outcome_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        source_skill TEXT NOT NULL,
        type TEXT NOT NULL,
        priority_score INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0,
        automation_eligibility TEXT NOT NULL DEFAULT 'never',
        action_shown TEXT,
        action_taken TEXT,
        accepted INTEGER NOT NULL DEFAULT 0,
        dismissed INTEGER NOT NULL DEFAULT 0,
        snoozed INTEGER NOT NULL DEFAULT 0,
        ignored INTEGER NOT NULL DEFAULT 0,
        asked_nexus INTEGER NOT NULL DEFAULT 0,
        manually_corrected INTEGER NOT NULL DEFAULT 0,
        undo_used INTEGER NOT NULL DEFAULT 0,
        time_to_action_ms INTEGER,
        action_succeeded INTEGER NOT NULL DEFAULT 0,
        partial_failure INTEGER NOT NULL DEFAULT 0,
        failed_reason TEXT,
        feature_snapshot_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    ensureBootstrapColumn(db, 'notification_intents', 'decision_context_json', 'TEXT');
    ensureBootstrapColumn(db, 'notification_center_items', 'sensitive_body', 'TEXT');
    ensureBootstrapColumn(db, 'notification_center_items', 'snoozed_until', 'TEXT');
    ensureBootstrapColumn(db, 'notification_center_items', 'action_result_json', 'TEXT');
    ensureBootstrapColumn(db, 'handled_by_nexus_items', 'explanation_json', 'TEXT');
  } finally {
    db.close();
  }
}

function ensureBootstrapColumn(db: Database.Database, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((candidate) => candidate.name === column)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
}

async function primeDecisionCenterSchema(opts: CliOptions, auth: AuthPayload): Promise<void> {
  const headers = { Authorization: `Bearer ${auth.accessToken}` };
  await getData<any>(`${opts.baseUrl}/api/v1/decisions/overview?limit=1&handledLimit=1`, headers);
}

function assertSmokeSchemaReady(db: Database.Database): void {
  const requiredColumns: Record<string, string[]> = {
    notification_intents: ['decision_context_json'],
    notification_center_items: ['sensitive_body', 'snoozed_until', 'action_result_json'],
    handled_by_nexus_items: ['explanation_json'],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const present = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    for (const column of columns) {
      if (!present.has(column)) {
        throw new Error(`Decision Center runtime did not prepare ${table}.${column}; schema priming failed`);
      }
    }
  }
}

function insertSeedDecision(db: Database.Database, input: SeedDecisionInput): { itemId: string; decisionId: string; id: string; intentId: string } {
  const intentId = `intent_${randomUUID()}`;
  const itemId = `nc_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const status = input.status ?? 'unread';
  const actionButtonsJson = JSON.stringify(input.actionButtons);
  const decisionContextJson = JSON.stringify({
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
    visibilityScope: 'user_private',
    ...input.context,
  });

  db.prepare(`
    INSERT INTO notification_intents (
      intent_id, user_id, tenant_id, source_skill, type, priority, related_entity_id, related_entity_type,
      title, body, sensitive_body, action_buttons_json, deeplink, expires_at, quiet_hours_policy,
      dedupe_key, requires_user_action, decision_deadline, delivery_policy, privacy_policy,
      decision_context_json, status, created_at
    ) VALUES (?, ?, ?, 'secretary', 'conflict_detected', 'time_sensitive', ?, 'secretary_agenda_item',
      ?, ?, NULL, ?, 'nexushub://decision-center', ?, 'allow_time_sensitive',
      ?, 1, ?, 'in_app_only', 'standard', ?, 'evaluated', ?)
  `).run(
    intentId,
    input.userId,
    input.tenantId,
    input.relatedEntityId,
    input.title,
    input.body,
    actionButtonsJson,
    input.expiresAt,
    input.dedupeKey,
    input.decisionDeadline,
    decisionContextJson,
    createdAt,
  );

  db.prepare(`
    INSERT INTO notification_center_items (
      item_id, intent_id, user_id, tenant_id, title, body, safe_body, sensitive_body,
      source_skill, type, priority, status, deeplink, actions_json, dedupe_key, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'secretary', 'conflict_detected',
      'time_sensitive', ?, 'nexushub://decision-center', ?, ?, ?, ?)
  `).run(
    itemId,
    intentId,
    input.userId,
    input.tenantId,
    input.title,
    input.body,
    input.body,
    status,
    actionButtonsJson,
    input.dedupeKey,
    input.expiresAt,
    createdAt,
  );

  return { itemId, decisionId: itemId, id: itemId, intentId };
}

async function createSeedDecision(
  opts: CliOptions,
  auth: AuthPayload,
  input: {
    userId: number;
    tenantId: number;
    title: string;
    body: string;
    relatedEntityId: string;
    dedupeKey: string;
    expiresAt: string;
    decisionDeadline: string;
    actionButtons: NotificationIntentInput['actionButtons'];
    context: NonNullable<NotificationIntentInput['decisionContext']>;
  },
): Promise<any> {
  const result = await postSeedDecisionIntent(opts, auth, input);
  if (!result.item) {
    throw new Error(`decision seed rejected for ${input.dedupeKey}: ${JSON.stringify({ eligibility: result.eligibility, intentStatus: result.intent?.status })}`);
  }
  return result.item;
}

async function createHiddenSeedDecision(
  db: Database.Database,
  opts: CliOptions,
  auth: AuthPayload,
  input: Parameters<typeof createSeedDecision>[2],
): Promise<any> {
  const result = await postSeedDecisionIntent(opts, auth, input);
  if (result.item) return result.item;
  try {
    return { itemId: findDecisionIdByDedupe(opts.dbPath, input.dedupeKey, input.userId, input.tenantId) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}: ${JSON.stringify({ eligibility: result.eligibility, intentStatus: result.intent?.status })}`);
  }
}

async function postSeedDecisionIntent(
  opts: CliOptions,
  auth: AuthPayload,
  input: Parameters<typeof createSeedDecision>[2],
): Promise<{ item: any | null; intent?: any; eligibility: any }> {
  return postData<{ item: any | null; intent?: any; eligibility: any }>(
    `${opts.baseUrl}/api/v1/decisions/intents`,
    {
      Authorization: `Bearer ${auth.accessToken}`,
      'x-internal-secret': opts.internalSecret,
    },
    {
    intentId: `intent_${randomUUID()}`,
    userId: input.userId,
    tenantId: input.tenantId,
    sourceSkill: 'secretary',
    type: 'conflict_detected',
    priority: 'time_sensitive',
    relatedEntityId: input.relatedEntityId,
    relatedEntityType: 'secretary_agenda_item',
    title: input.title,
    body: input.body,
    sensitiveBody: null,
    actionButtons: input.actionButtons,
    deeplink: 'nexushub://decision-center',
    expiresAt: input.expiresAt,
    quietHoursPolicy: 'allow_time_sensitive',
    dedupeKey: input.dedupeKey,
    requiresUserAction: true,
    decisionDeadline: input.decisionDeadline,
    deliveryPolicy: 'in_app_only',
    privacyPolicy: 'standard',
    visibilityScope: 'user_private',
    decisionContext: {
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      visibilityScope: 'user_private',
      ...input.context,
    },
    },
  );
}

function decisionIdFromItem(item: any): string {
  const decisionId = item?.itemId ?? item?.decisionId ?? item?.id;
  if (typeof decisionId !== 'string' || !decisionId.trim()) {
    throw new Error(`Decision Center seed item did not include a usable id: ${JSON.stringify(item)}`);
  }
  return decisionId;
}

function findDecisionIdByDedupe(dbPath: string, dedupeKey: string, userId: number, tenantId: number): string {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  try {
    const row = db.prepare(`
      SELECT item_id AS itemId
        FROM notification_center_items
       WHERE dedupe_key = ? AND user_id = ? AND tenant_id = ?
       ORDER BY created_at DESC
       LIMIT 1
    `).get(dedupeKey, userId, tenantId) as { itemId: string } | undefined;
    if (!row?.itemId) {
      throw new Error(`hidden Decision Center seed row was not persisted for ${dedupeKey}`);
    }
    return row.itemId;
  } finally {
    db.close();
  }
}

function addDecisionDependencyRow(
  db: Database.Database,
  input: {
    decisionId: string;
    dependsOnDecisionId: string;
    userId: number;
    tenantId: number;
    relationship: string;
  },
): void {
  db.prepare(`
    INSERT OR IGNORE INTO decision_dependencies (
      dependency_id, decision_id, depends_on_decision_id, user_id, tenant_id, relationship
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    `dep_${randomUUID()}`,
    input.decisionId,
    input.dependsOnDecisionId,
    input.userId,
    input.tenantId,
    input.relationship,
  );
}

function cleanupPreviousSmokeRows(db: any, userId: number, tenantId: number): void {
  void userId;
  void tenantId;

  const smokeDedupeKeys = [
    `${SMOKE_PREFIX}ui-open`,
    `${SMOKE_PREFIX}api-action`,
    `${SMOKE_PREFIX}blocker`,
    `${SMOKE_PREFIX}blocked`,
    `${SMOKE_PREFIX}expired`,
  ];
  const itemIds = new Set<string>();
  const intentIds = new Set<string>();
  const collectCenterByDedupe = db.prepare(`
    SELECT item_id AS itemId, intent_id AS intentId
      FROM notification_center_items
     WHERE dedupe_key = ?
  `);
  const collectIntentByDedupe = db.prepare(`
    SELECT intent_id AS intentId
      FROM notification_intents
     WHERE dedupe_key = ?
  `);
  const collectIntentByEntity = db.prepare(`
    SELECT intent_id AS intentId
      FROM notification_intents
     WHERE related_entity_id LIKE 'local-ios-secretary-conflict-%'
  `);
  const collectLog = db.prepare(`
    SELECT intent_id AS intentId
      FROM notification_decision_logs
     WHERE dedupe_key = ?
  `);
  for (const dedupeKey of smokeDedupeKeys) {
    for (const row of collectCenterByDedupe.all(dedupeKey) as Array<{ itemId: string | null; intentId: string | null }>) {
      if (row.itemId) itemIds.add(row.itemId);
      if (row.intentId) intentIds.add(row.intentId);
    }
    for (const row of collectIntentByDedupe.all(dedupeKey) as Array<{ intentId: string | null }>) {
      if (row.intentId) intentIds.add(row.intentId);
    }
    for (const row of collectLog.all(dedupeKey) as Array<{ intentId: string | null }>) {
      if (row.intentId) intentIds.add(row.intentId);
    }
  }
  for (const row of collectIntentByEntity.all() as Array<{ intentId: string | null }>) {
    if (row.intentId) intentIds.add(row.intentId);
  }

  const runForEach = (sql: string, values: Iterable<string>): void => {
    const statement = db.prepare(sql);
    for (const value of values) statement.run(value);
  };
  const dependencyDelete = db.prepare(`
    DELETE FROM decision_dependencies
     WHERE decision_id = ? OR depends_on_decision_id = ?
  `);
  for (const value of itemIds) dependencyDelete.run(value, value);

  runForEach('DELETE FROM decision_action_executions WHERE decision_id = ?', itemIds);
  runForEach('DELETE FROM decision_lifecycle_events WHERE decision_id = ?', itemIds);
  runForEach('DELETE FROM decision_outcome_ledger WHERE decision_id = ?', itemIds);
  runForEach('DELETE FROM handled_by_nexus_items WHERE decision_id = ?', itemIds);
  runForEach('DELETE FROM notification_center_items WHERE item_id = ?', itemIds);
  runForEach('DELETE FROM notification_decision_logs WHERE intent_id = ?', intentIds);
  runForEach('DELETE FROM notification_delivery_attempts WHERE intent_id = ?', intentIds);
  runForEach('DELETE FROM notification_intents WHERE intent_id = ?', intentIds);

  const deleteCenterByDedupe = db.prepare('DELETE FROM notification_center_items WHERE dedupe_key = ?');
  const deleteLogByDedupe = db.prepare('DELETE FROM notification_decision_logs WHERE dedupe_key = ?');
  const deleteIntentByDedupe = db.prepare('DELETE FROM notification_intents WHERE dedupe_key = ?');
  for (const dedupeKey of smokeDedupeKeys) {
    deleteCenterByDedupe.run(dedupeKey);
    deleteLogByDedupe.run(dedupeKey);
    deleteIntentByDedupe.run(dedupeKey);
  }
  db.prepare(`
    DELETE FROM notification_intents
     WHERE related_entity_id LIKE 'local-ios-secretary-conflict-%'
  `).run();
  db.prepare(`
    DELETE FROM handled_by_nexus_items
     WHERE handled_item_id LIKE 'hbn_local_ios_smoke_%'
        OR decision_id = 'dc_ios_smoke_handled_by_nexus'
  `).run();

  const countRemainingIntents = db.prepare(`
    SELECT COUNT(*) AS count
      FROM notification_intents
     WHERE dedupe_key = ?
        OR related_entity_id LIKE 'local-ios-secretary-conflict-%'
  `);
  const countRemainingCenterItems = db.prepare('SELECT COUNT(*) AS count FROM notification_center_items WHERE dedupe_key = ?');
  const remaining = smokeDedupeKeys.reduce((sum, dedupeKey) => {
    const intentRow = countRemainingIntents.get(dedupeKey) as { count: number };
    const centerRow = countRemainingCenterItems.get(dedupeKey) as { count: number };
    return sum + Number(intentRow.count) + Number(centerRow.count);
  }, 0);
  if (remaining > 0) {
    throw new Error(`failed to cleanup ${remaining} previous Decision Center smoke rows`);
  }
}

function insertHandledByNexus(db: any, userId: number, tenantId: number): void {
  db.prepare(`
    INSERT INTO handled_by_nexus_items (
      handled_item_id, decision_id, user_id, tenant_id, source_skill, title, summary,
      action_taken, why_brief, explanation_json, related_entities_json, rollback_available,
      changed_rule_option, privacy_classification, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    `hbn_local_ios_smoke_${randomUUID()}`,
    'dc_ios_smoke_handled_by_nexus',
    userId,
    tenantId,
    'secretary',
    HANDLED_TITLE,
    'Nexus handled the local smoke cleanup after verifying the dependency state.',
    'auto_smoke_cleanup',
    'Handled locally by the smoke seed so iOS can render the handled section.',
    JSON.stringify({
      result: 'Local smoke cleanup verified.',
      verification: 'Seeded handled history row belongs to the same user and tenant.',
    }),
    JSON.stringify([{ type: 'secretary_agenda_item', id: 'local-ios-handled-item' }]),
    0,
    null,
    'standard',
  );
}

function writePushPayload(pushFile: string, manifest: SmokeManifest, auth: AuthPayload): void {
  const payload = {
    aps: {
      alert: {
        title: 'Decision needs review',
        body: SMOKE_TITLE,
      },
      category: 'DECISION_CENTER',
      'thread-id': 'decision-center',
      sound: 'default',
    },
    decisionId: manifest.decisions.uiOpen,
    userId: manifest.userId,
    tenantId: manifest.tenantId,
    notificationUserId: manifest.userId,
    deeplink: `nexushub://decision-center?decisionId=${encodeURIComponent(manifest.decisions.uiOpen)}`,
    smokeAuthUserId: auth.user.id,
  };
  mkdirFor(pushFile);
  fs.writeFileSync(pushFile, JSON.stringify(payload, null, 2));
}

async function assertBackendRoutes(baseUrl: string, manifest: SmokeManifest, auth: AuthPayload): Promise<void> {
  const headers = { Authorization: `Bearer ${auth.accessToken}` };
  const overview = await getData<any>(`${baseUrl}/api/v1/decisions/overview?limit=80&handledLimit=10`, headers);
  const overviewItems = arrayAt(overview.items, 'overview.items');
  assertIncludesDecision(overviewItems, manifest.decisions.uiOpen, 'overview');
  assertIncludesDecision(overviewItems, manifest.decisions.blocked, 'overview');
  assertExcludesDecision(overviewItems, manifest.decisions.expired, 'overview');
  const overviewHandled = Array.isArray(overview.handled)
    ? overview.handled
    : overview.handled?.items ?? overview.handledItems ?? [];
  if (!arrayAt(overviewHandled, 'overview.handled').some((item: any) => item.title === HANDLED_TITLE)) {
    throw new Error('overview did not include the seeded handled-by-Nexus item');
  }

  const summary = await getData<any>(`${baseUrl}/api/v1/decisions/summary?limit=3`, headers);
  if (Number(summary.openCount ?? 0) < 2) throw new Error('summary did not report open Decision Center rows');
  if (!arrayAt(summary.previewItems, 'summary.previewItems').some((item: any) => item.decisionId === manifest.decisions.uiOpen || item.itemId === manifest.decisions.uiOpen)) {
    throw new Error('summary preview did not include the seeded open decision');
  }

  const handled = await getData<any>(`${baseUrl}/api/v1/decisions/handled?limit=10`, headers);
  if (!arrayAt(handled.items, 'handled.items').some((item: any) => item.title === HANDLED_TITLE)) {
    throw new Error('handled endpoint did not return the seeded handled row');
  }

  const detail = await getData<any>(`${baseUrl}/api/v1/decisions/${manifest.decisions.uiOpen}`, headers);
  const item = detail.item ?? detail;
  if (item.decisionId !== manifest.decisions.uiOpen && item.itemId !== manifest.decisions.uiOpen) {
    throw new Error('detail endpoint did not return the seeded open decision');
  }
  if (JSON.stringify(item).includes('decision-detail-source-trace')) {
    throw new Error('detail payload leaked a raw source trace marker');
  }

  const idempotencyKey = `backend-preflight-${manifest.decisions.apiAction}`;
  const firstAction = await postData<any>(`${baseUrl}/api/v1/decisions/${manifest.decisions.apiAction}/actions`, headers, {
    actionId: 'dismiss',
    idempotencyKey,
    payload: { reason: 'already_handled' },
  });
  if (firstAction.status !== 'succeeded') {
    throw new Error(`expected first backend action to succeed, got ${firstAction.status}`);
  }
  const replay = await postData<any>(`${baseUrl}/api/v1/decisions/${manifest.decisions.apiAction}/actions`, headers, {
    actionId: 'dismiss',
    idempotencyKey,
    payload: { reason: 'already_handled' },
  });
  if (replay.status !== 'idempotent' || replay.idempotent !== true) {
    throw new Error('backend action replay did not return the idempotent result');
  }
}

async function assertIosActionLedger(dbPath: string, manifest: SmokeManifest): Promise<void> {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  try {
    const executions = db.prepare(`
      SELECT action_id AS actionId, idempotency_key AS idempotencyKey, status
        FROM decision_action_executions
       WHERE decision_id = ? AND user_id = ? AND tenant_id = ?
       ORDER BY created_at DESC
    `).all(manifest.decisions.uiOpen, manifest.userId, manifest.tenantId) as Array<{ actionId: string; idempotencyKey: string; status: string }>;
    const dismissExecutions = executions.filter((row) => row.actionId === 'dismiss');
    if (dismissExecutions.length !== 1) {
      throw new Error(`expected exactly one iOS dismiss execution, found ${dismissExecutions.length}`);
    }
    if (dismissExecutions[0].status !== 'succeeded') {
      throw new Error(`expected iOS dismiss execution succeeded, got ${dismissExecutions[0].status}`);
    }
    if (!dismissExecutions[0].idempotencyKey) {
      throw new Error('iOS dismiss execution did not persist an idempotency key');
    }
    const statusRow = db.prepare(`
      SELECT status
        FROM notification_center_items
       WHERE item_id = ? AND user_id = ? AND tenant_id = ?
    `).get(manifest.decisions.uiOpen, manifest.userId, manifest.tenantId) as { status: string } | undefined;
    if (statusRow?.status !== 'dismissed') {
      throw new Error(`expected iOS decision status dismissed, got ${statusRow?.status ?? 'missing'}`);
    }
  } finally {
    db.close();
  }
}

async function getData<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers });
  return unwrapData<T>(await readJson(res), url);
}

async function postData<T>(url: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return unwrapData<T>(await readJson(res), url);
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${res.url} returned non-JSON status ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`${res.url} returned ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function unwrapData<T>(json: unknown, label: string): T {
  if (!json || typeof json !== 'object') throw new Error(`${label} returned a non-object envelope`);
  const envelope = json as { ok?: unknown; data?: unknown };
  if (envelope.ok !== true) throw new Error(`${label} returned ok:false envelope: ${JSON.stringify(json)}`);
  return envelope.data as T;
}

function arrayAt(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) throw new Error(`${label} was not an array`);
  return value;
}

function assertIncludesDecision(items: any[], decisionId: string, label: string): void {
  if (!items.some((item) => item.decisionId === decisionId || item.itemId === decisionId || item.id === decisionId)) {
    throw new Error(`${label} did not include decision ${decisionId}; saw ${summarizeDecisionIds(items)}`);
  }
}

function assertExcludesDecision(items: any[], decisionId: string, label: string): void {
  if (items.some((item) => item.decisionId === decisionId || item.itemId === decisionId || item.id === decisionId)) {
    throw new Error(`${label} included hidden decision ${decisionId}`);
  }
}

function summarizeDecisionIds(items: any[]): string {
  return JSON.stringify(items.slice(0, 12).map((item) => ({
    decisionId: item.decisionId ?? item.itemId ?? item.id ?? null,
    title: item.title ?? item.safePreviewTitle ?? item.primaryActionLabel ?? null,
    status: item.status ?? item.effectiveStatus ?? null,
  })));
}

function readAuth(authFile: string): AuthPayload {
  return JSON.parse(fs.readFileSync(authFile, 'utf8')) as AuthPayload;
}

function readManifest(manifestFile: string): SmokeManifest {
  return JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as SmokeManifest;
}

function mkdirFor(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
