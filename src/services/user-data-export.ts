// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Per-user data export and deletion service — GDPR compliance.
 *
 * - exportUserFinanceData: finance-only export (legacy, used by full export)
 * - exportAllUserData: Article 20 — data portability (ALL tables)
 * - deleteAllUserData: Article 17 — right to erasure (ALL tables, transactional)
 * - countUserFinanceData: quick audit for finance records
 */

import { getDb } from './database';
import { getTransactions, getTaxEvents, getAnnualTaxSummary } from './finance-tracker';
import type { Transaction, TaxEvent, AnnualTaxSummary } from './finance-tracker';
import { getTokens, type OAuthProvider } from './oauth-store';
import { clearGarminSession } from './garmin-session-store';
import {
  appleSignInIdentityExistsForUser,
  revokeAppleSignInTokenForUser,
} from './apple-token-revocation';
import { logger } from '../utils/logger';
import { randomUUID } from 'node:crypto';
import { decryptTrainingProfileSnapshot } from './training-profile-snapshot-encryption';

// ── Finance Export (existing) ───────────────────────────────────────

export interface UserFinanceExport {
  exportedAt: string;
  userId: number;
  transactions: Transaction[];
  taxEvents: TaxEvent[];
  annualSummaries: AnnualTaxSummary[];
}

export function exportUserFinanceData(userId: number): UserFinanceExport {
  const transactions = getTransactions(userId, { limit: 100000 });
  const taxEvents = getTaxEvents(userId, { limit: 100000 });

  const years = new Set<number>();
  for (const tx of transactions) {
    years.add(parseInt(tx.date.substring(0, 4), 10));
  }
  for (const te of taxEvents) {
    years.add(parseInt(te.month.substring(0, 4), 10));
  }

  const annualSummaries: AnnualTaxSummary[] = [];
  for (const year of Array.from(years).sort()) {
    annualSummaries.push(getAnnualTaxSummary(userId, year));
  }

  return {
    exportedAt: new Date().toISOString(),
    userId,
    transactions,
    taxEvents,
    annualSummaries,
  };
}

export function deleteUserFinanceData(userId: number): { transactionsDeleted: number; taxEventsDeleted: number } {
  const db = getDb();
  const txResult = db.prepare('DELETE FROM finance_transactions WHERE user_id = ?').run(userId);
  const taxResult = db.prepare('DELETE FROM finance_tax_events WHERE user_id = ?').run(userId);
  const metaResult = db.prepare('DELETE FROM user_encryption_meta WHERE user_id = ?').run(userId);

  return {
    transactionsDeleted: txResult.changes,
    taxEventsDeleted: taxResult.changes + metaResult.changes,
  };
}

type OAuthRevocationResult = {
  provider: string;
  attempted: boolean;
  status: 'revoked' | 'already_revoked' | 'failed' | 'local_only';
  statusCode?: number;
};

type RevocableProvider = OAuthProvider | 'garmin' | 'apple';

/**
 * A provider that stops answering must not stall Article 17 erasure. Without
 * a signal a hung endpoint holds the deletion request open until the HTTP
 * layer gives up, which surfaces to the client as a failed deletion.
 */
const THIRD_PARTY_REVOCATION_TIMEOUT_MS = 5000;

async function postFormRevocation(url: string, body: URLSearchParams): Promise<{ statusCode: number; ok: boolean }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(THIRD_PARTY_REVOCATION_TIMEOUT_MS),
  });
  return { statusCode: response.status, ok: response.ok || (response.status >= 400 && response.status < 500) };
}

/**
 * Every branch runs inside the error boundary — including the local session
 * and token reads — so no revocation path can escape as an exception and turn
 * account deletion into an HTTP 500.
 */
async function revokeOneThirdPartyProvider(userId: number, provider: RevocableProvider): Promise<OAuthRevocationResult> {
  try {
    if (provider === 'garmin') {
      // The Garmin integration in this codebase has no stable public revoke
      // endpoint; remove the durable local session and record that this
      // provider is local-only.
      clearGarminSession(userId);
      return { provider, attempted: true, status: 'local_only' };
    }

    if (provider === 'apple') {
      // App Store Review Guideline 5.1.1(v). Degrades to local_only when the
      // client never sent an authorization code or the Apple revocation env
      // vars are unset — see src/services/apple-token-revocation.ts.
      const outcome = await revokeAppleSignInTokenForUser(userId);
      return { provider, ...outcome };
    }

    const tokens = getTokens(userId, provider);
    if (!tokens) {
      return { provider, attempted: false, status: 'local_only' };
    }

    if (provider === 'google') {
      const token = tokens.refreshToken || tokens.accessToken;
      const result = await postFormRevocation('https://oauth2.googleapis.com/revoke', new URLSearchParams({ token }));
      return {
        provider,
        attempted: true,
        status: result.ok ? (result.statusCode >= 400 ? 'already_revoked' : 'revoked') : 'failed',
        statusCode: result.statusCode,
      };
    }

    if (provider === 'outlook') {
      const tenantId = process.env.OUTLOOK_TENANT_ID || 'common';
      const token = tokens.refreshToken || tokens.accessToken;
      const result = await postFormRevocation(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout`,
        new URLSearchParams({ token }),
      );
      return {
        provider,
        attempted: true,
        status: result.ok ? (result.statusCode >= 400 ? 'already_revoked' : 'revoked') : 'failed',
        statusCode: result.statusCode,
      };
    }

    return { provider, attempted: false, status: 'local_only' };
  } catch (err) {
    logger.warn({ err, userId, provider }, 'OAuth revocation failed');
    return { provider, attempted: true, status: 'failed' };
  }
}

export async function revokeThirdPartyOAuthTokenForProvider(
  userId: number,
  provider: RevocableProvider,
): Promise<OAuthRevocationResult> {
  return revokeOneThirdPartyProvider(userId, provider);
}

/**
 * Best-effort third-party credential revocation before local erasure.
 *
 * 4xx responses are treated as already-revoked/invalid-token success because
 * the provider no longer accepts the credential. Network/5xx failures are
 * logged and tolerated so Article 17 local deletion can still proceed.
 */
export async function revokeThirdPartyOAuthTokensForUser(userId: number): Promise<OAuthRevocationResult[]> {
  const db = getDb();
  const rows = tableExistsForDeletion(db, 'user_oauth_tokens')
    ? db.prepare('SELECT provider FROM user_oauth_tokens WHERE user_id = ?').all(userId) as Array<{ provider: OAuthProvider }>
    : [];
  const results: OAuthRevocationResult[] = [];

  for (const row of rows) {
    results.push(await revokeOneThirdPartyProvider(userId, row.provider));
  }

  const garminSession = tableExistsForDeletion(db, 'garmin_sessions')
    ? db.prepare('SELECT user_id FROM garmin_sessions WHERE user_id = ?').get(userId)
    : null;
  if (garminSession) {
    results.push(await revokeOneThirdPartyProvider(userId, 'garmin'));
  }

  // Apple is not an entry in `user_oauth_tokens` — Sign in with Apple has its
  // own encrypted refresh-token store — so it is probed explicitly. Apple
  // users with no captured authorization code still get an explicit
  // `local_only` record rather than being silently omitted.
  if (appleSignInIdentityExistsForUser(userId)) {
    results.push(await revokeOneThirdPartyProvider(userId, 'apple'));
  }

  return results;
}

export async function deleteAllUserDataForAccountDeletion(userId: number): Promise<Record<string, number>> {
  try {
    // The per-provider outcomes are the ONLY evidence that revocation ran:
    // the credentials are erased microseconds later, and the Apple call in
    // particular cannot be exercised against the live endpoint from a test.
    // `provider`, `attempted`, `status`, and `statusCode` carry no secrets.
    const revocations = await revokeThirdPartyOAuthTokensForUser(userId);
    logger.info(
      { userId, revocations, event: 'account_deletion.revocation' },
      'Third-party revocation completed before account deletion',
    );
  } catch (err) {
    // Article 17 erasure must not depend on a third party staying reachable.
    // Per-provider failures already degrade to a recorded outcome inside
    // `revokeOneThirdPartyProvider`; this boundary covers the surrounding
    // schema probes so a deletion can never 500 on the revocation phase.
    logger.warn({ err, userId }, 'Third-party revocation phase failed before account deletion');
  }
  return deleteAllUserData(userId);
}

export function countUserFinanceData(userId: number): { transactions: number; taxEvents: number } {
  const db = getDb();
  const txCount = db.prepare('SELECT COUNT(*) as cnt FROM finance_transactions WHERE user_id = ?').get(userId) as { cnt: number };
  const taxCount = db.prepare('SELECT COUNT(*) as cnt FROM finance_tax_events WHERE user_id = ?').get(userId) as { cnt: number };
  return {
    transactions: txCount.cnt,
    taxEvents: taxCount.cnt,
  };
}

// ── Full User Export (GDPR Article 20 — data portability) ───────────

export interface FullUserExport {
  exportedAt: string;
  userId: number;
  user: {
    username: string | null;
    firstName: string | null;
    language: string;
    timezone: string;
    tier: string;
    createdAt: string;
  } | null;
  conversations: Array<{ domain: string; role: string; content: string; createdAt: string }>;
  todos: Array<{ title: string; description: string | null; status: string; priority: string; dueDate: string | null; createdAt: string }>;
  reminders: Array<{ message: string; remindAt: string; status: string; createdAt: string }>;
  notes: Array<{ content: string; domain: string; createdAt: string }>;
  savedIdeas: Array<{ title: string; content: string; createdAt: string }>;
  contentWorkspace: ContentWorkspaceExport;
  sharedMemory: Array<{ key: string; value: string; updatedAt: string }>;
  finance: UserFinanceExport;
  oauthConnections: Array<{ provider: string; connectedAt: string }>;
  settings: Array<{ key: string; value: string }>;
  notificationDeviceTokens: Array<{ environment: string; platform: string; appVersion: string | null; lastSeenAt: string; revokedAt: string | null }>;
  garminSessions: Array<{ lastRefreshedAt: string | null; createdAt: string; updatedAt: string }>;
  agentSignals: Array<{ sourceAgent: string; signalType: string; status: string; createdAt: string }>;
  encryptionMeta: Array<{ keyVersion: number; encryptedAt: string; updatedAt: string }>;
  legalConsents: Array<{ documentKey: string; documentVersion: string; documentUrl: string; acceptedAt: string; source: string }>;
  secretaryAgendaItems: Array<{
    agendaItemId: string;
    sourceSkill: string;
    title: string;
    lifecycleState: string;
    startAt: string | null;
    endAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  skillMemories: Array<{
    memoryId: string;
    skillId: string;
    memoryType: string;
    scope: string;
    memoryKey: string;
    memoryValue: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
  trainingFeedbackDecisions: Array<{
    sourceSkill: string;
    agendaItemId: string;
    sourceIntentId: string;
    feedbackType: string;
    status: string;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  secretarySourceSkillFeedback: Array<{
    targetSkill: string;
    agendaItemId: string;
    sourceIntentId: string;
    feedbackType: string;
    status: string;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  productLearningCases: Array<Record<string, unknown>>;
  productLearningCaseTransitions: Array<Record<string, unknown>>;
  productLearningCaseReviewApprovals: Array<Record<string, unknown>>;
  trainingPlanRevisionV1: {
    capacitySnapshots: Array<Record<string, unknown>>;
    profileSnapshots: Array<Record<string, unknown>>;
    planFamilies: Array<Record<string, unknown>>;
    planRevisions: Array<Record<string, unknown>>;
    approvalReceipts: Array<Record<string, unknown>>;
    currentContexts: Array<Record<string, unknown>>;
    activeReferences: Array<Record<string, unknown>>;
    operations: Array<Record<string, unknown>>;
    adaptationPreviews: Array<Record<string, unknown>>;
    adaptationProposals: Array<Record<string, unknown>>;
    adaptationLifecycle: Array<Record<string, unknown>>;
  };
}

export type ContentWorkspaceExportTable = {
  name: string;
  ownershipColumns: Array<'user_id' | 'owner_user_id'>;
  records: Array<Record<string, unknown>>;
};

export interface ContentWorkspaceExport {
  schemaVersion: 'content-workspace-export-v1';
  tables: ContentWorkspaceExportTable[];
}

const LEGACY_CONTENT_EXPORT_TABLES = new Set([
  'book_library',
  'config_pillars',
  'saved_ideas',
  'video_studies',
  'video_transcripts',
]);

function isContentExportTable(table: string): boolean {
  return table.startsWith('content_') || LEGACY_CONTENT_EXPORT_TABLES.has(table);
}

/**
 * Export every schema-present, directly user-owned Content table.
 *
 * This intentionally discovers current ownership columns instead of relying on
 * a hand-maintained list. A Content table that exists but cannot be queried is
 * a hard failure: returning a successful, incomplete privacy archive would be
 * less truthful than asking the caller to retry.
 */
export function exportContentWorkspaceData(
  userId: number,
  tenantId?: number,
): ContentWorkspaceExport {
  const db = getDb();
  const tables = accountDeletionTablesForDb(db)
    .filter(({ table }) => isContentExportTable(table))
    .sort((left, right) => left.table.localeCompare(right.table))
    .map((descriptor): ContentWorkspaceExportTable => {
      const ownership = buildOwnershipPredicate(descriptor.columns, userId);
      const tenantClause = descriptor.hasTenantId && typeof tenantId === 'number'
        ? ` AND (${quoteSqlIdentifier('tenant_id')} = ? OR ${quoteSqlIdentifier('tenant_id')} IS NULL)`
        : '';
      const params = descriptor.hasTenantId && typeof tenantId === 'number'
        ? [...ownership.params, tenantId]
        : ownership.params;
      const records = db.prepare(
        `SELECT * FROM ${quoteSqlIdentifier(descriptor.table)} WHERE (${ownership.sql})${tenantClause}`,
      ).all(...params) as Array<Record<string, unknown>>;

      return {
        name: descriptor.table,
        ownershipColumns: [...descriptor.columns],
        records,
      };
    });

  return {
    schemaVersion: 'content-workspace-export-v1',
    tables,
  };
}

export function exportAllUserData(userId: number): FullUserExport {
  const db = getDb();

  // User profile
  const user = safeGet(db, 'SELECT username, first_name, language, timezone, tier, created_at FROM users WHERE telegram_id = ?', userId);

  // Conversations
  const conversations = safeAll(db,
    "SELECT domain, role, content, created_at as createdAt FROM conversations WHERE tenant_id = ? AND user_id = ? AND scope_status = 'active' ORDER BY created_at",
    userId,
    userId);

  // Todos
  const todos = safeAll(db,
    'SELECT title, description, status, priority, due_date as dueDate, created_at as createdAt FROM todos WHERE user_id = ? ORDER BY created_at', userId);

  // Reminders
  const reminders = safeAll(db,
    'SELECT message, remind_at as remindAt, status, created_at as createdAt FROM reminders WHERE user_id = ? ORDER BY created_at', userId);

  // Notes
  const notes = safeAll(db,
    'SELECT content, domain, created_at as createdAt FROM notes WHERE user_id = ? ORDER BY created_at', userId);

  // Content export is account-wide here because this service has no
  // authenticated tenant context. Tenant-scoped HTTP exports pass tenantId
  // explicitly at the route boundary.
  const contentWorkspace = exportContentWorkspaceData(userId);
  const savedIdeas = (contentWorkspace.tables.find(({ name }) => name === 'saved_ideas')?.records ?? [])
    .map((row) => ({
      title: String(row.title ?? ''),
      content: String(row.title ?? ''),
      createdAt: String(row.created_at ?? ''),
    }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  // Shared Memory
  const sharedMemory = safeAll(db,
    "SELECT key, value, updated_at as updatedAt FROM shared_memory WHERE tenant_id = ? AND user_id = ? AND scope_status = 'active' ORDER BY key",
    userId,
    userId);

  // Finance (uses existing decrypting export)
  const finance = exportUserFinanceData(userId);

  // OAuth connections (metadata only — NO tokens for security)
  const oauthRows = safeAll(db,
    'SELECT provider, created_at FROM user_oauth_tokens WHERE user_id = ?', userId);

  // User settings from kv_store
  const settings = safeAll(db,
    "SELECT key, value FROM kv_store WHERE key LIKE ?", `config:${userId}:%`);
  const notificationDeviceTokens = safeAll(db,
    'SELECT environment, platform, app_version as appVersion, last_seen_at as lastSeenAt, revoked_at as revokedAt FROM notification_device_tokens WHERE user_id = ?', userId);
  const garminSessions = safeAll(db,
    'SELECT last_refreshed_at as lastRefreshedAt, created_at as createdAt, updated_at as updatedAt FROM garmin_sessions WHERE user_id = ?', userId);
  const agentSignals = safeAll(db,
    'SELECT source_agent as sourceAgent, signal_type as signalType, status, created_at as createdAt FROM agent_signals WHERE user_id = ? ORDER BY created_at', userId);
  const encryptionMeta = safeAll(db,
    'SELECT key_version as keyVersion, encrypted_at as encryptedAt, updated_at as updatedAt FROM user_encryption_meta WHERE user_id = ?', userId);
  const legalConsents = safeAll(db,
    'SELECT document_key as documentKey, document_version as documentVersion, document_url as documentUrl, accepted_at as acceptedAt, source FROM user_legal_consents WHERE user_id = ? ORDER BY accepted_at', userId);
  const secretaryAgendaItems = safeAll(db, `
    SELECT agenda_item_id as agendaItemId,
           source_skill as sourceSkill,
           title,
           lifecycle_state as lifecycleState,
           start_at as startAt,
           end_at as endAt,
           created_at as createdAt,
           updated_at as updatedAt
    FROM secretary_agenda_items
    WHERE owner_user_id = ?
    ORDER BY created_at
  `, userId);
  const skillMemories = safeAll(db, `
    SELECT memory_id as memoryId,
           skill_id as skillId,
           memory_type as memoryType,
           scope,
           memory_key as memoryKey,
           memory_value as memoryValue,
           status,
           created_at as createdAt,
           updated_at as updatedAt
    FROM skill_memories
    WHERE user_id = ?
    ORDER BY updated_at
  `, userId);
  const trainingFeedbackDecisions = safeAll(db, `
    SELECT source_skill as sourceSkill,
           agenda_item_id as agendaItemId,
           source_intent_id as sourceIntentId,
           feedback_type as feedbackType,
           status,
           scheduled_start as scheduledStart,
           scheduled_end as scheduledEnd,
           created_at as createdAt,
           updated_at as updatedAt
    FROM training_feedback_decisions
    WHERE user_id = ?
    ORDER BY created_at
  `, userId);
  const secretarySourceSkillFeedback = safeAll(db, `
    SELECT target_skill as targetSkill,
           agenda_item_id as agendaItemId,
           source_intent_id as sourceIntentId,
           feedback_type as feedbackType,
           status,
           scheduled_start as scheduledStart,
           scheduled_end as scheduledEnd,
           created_at as createdAt,
           updated_at as updatedAt
    FROM secretary_source_skill_feedback
    WHERE user_id = ?
    ORDER BY created_at
  `, userId);
  const trainingCapacitySnapshots = safeAll(db, `
    SELECT snapshot_id AS snapshotId, tenant_id AS tenantId,
           schema_version AS schemaVersion, context_version AS contextVersion,
           idempotency_key AS idempotencyKey, request_hash AS requestHash,
           profile_source_version AS profileSourceVersion,
           calendar_event_set_hash AS calendarEventSetHash,
           provider_sources_json AS providerSources,
           provider_status AS providerStatus,
           plan_start_date AS planStartDate, plan_end_date AS planEndDate,
           horizon_weeks AS horizonWeeks,
           range_start_at AS rangeStartAt, range_end_at AS rangeEndAt,
           profile_windows_json AS profileWindows,
           capacity_windows_json AS capacityWindows,
           conflict_count AS conflictCount,
           observed_at AS observedAt, expires_at AS expiresAt,
           created_at AS createdAt
      FROM training_m4_capacity_snapshots
     WHERE user_id = ?
     ORDER BY tenant_id, observed_at, snapshot_id
  `, userId).map((row: Record<string, unknown>) => ({
    ...row,
    providerSources: parseExportJson(row.providerSources),
    profileWindows: parseExportJson(row.profileWindows),
    capacityWindows: parseExportJson(row.capacityWindows),
  }));
  const rawTrainingSnapshots = safeAll(db, `
    SELECT snapshot_id AS snapshotId, tenant_id AS tenantId,
           snapshot_sequence AS snapshotSequence, schema_version AS schemaVersion,
           content_hash AS contentHash, encrypted_snapshot_body AS encryptedSnapshotBody,
           snapshot_body_key_version AS keyVersion, observed_at AS observedAt,
           captured_at AS capturedAt, created_at AS createdAt
      FROM training_profile_snapshots
     WHERE user_id = ?
     ORDER BY tenant_id, snapshot_sequence
  `, userId) as Array<Record<string, any>>;
  const trainingProfileSnapshots = rawTrainingSnapshots.map((row) => {
    const { encryptedSnapshotBody, ...metadata } = row;
    return {
      ...metadata,
      snapshotBody: decryptTrainingProfileSnapshot({
        encryptedBody: encryptedSnapshotBody,
        keyVersion: row.keyVersion,
        userId,
      }),
    };
  });
  const trainingPlanFamilies = safeAll(db, `
    SELECT family_id AS familyId, tenant_id AS tenantId, family_key AS familyKey,
           plan_mode AS planMode, discipline, origin, legacy_plan_id AS legacyPlanId,
           created_at AS createdAt, updated_at AS updatedAt
      FROM training_plan_families WHERE user_id = ?
     ORDER BY tenant_id, created_at, family_id
  `, userId);
  const rawTrainingRevisions = safeAll(db, `
    SELECT revision_id AS revisionId, tenant_id AS tenantId, family_id AS familyId,
           revision_sequence AS revisionSequence, parent_revision_id AS parentRevisionId,
           profile_snapshot_id AS profileSnapshotId, origin,
           lifecycle_state AS lifecycleState, approval_state AS approvalState,
           decision_id AS decisionId, creation_context_version AS creationContextVersion,
           policy_version AS policyVersion, catalog_version AS catalogVersion,
           catalog_source_hash AS catalogSourceHash,
           capability_registry_version AS capabilityRegistryVersion,
           document_schema_version AS documentSchemaVersion,
           revision_document_json AS revisionDocumentJson, content_hash AS contentHash,
           quality_report_json AS qualityReportJson, created_at AS createdAt,
           review_requested_at AS reviewRequestedAt, activated_at AS activatedAt,
           superseded_at AS supersededAt, expired_at AS expiredAt
      FROM training_plan_revisions WHERE user_id = ?
     ORDER BY tenant_id, family_id, revision_sequence
  `, userId) as Array<Record<string, any>>;
  const trainingPlanRevisions = rawTrainingRevisions.map((row) => {
    const { revisionDocumentJson, qualityReportJson, ...metadata } = row;
    return {
      ...metadata,
      revisionDocument: parseExportJson(revisionDocumentJson),
      qualityReport: parseExportJson(qualityReportJson),
    };
  });
  const trainingApprovalReceipts = safeAll(db, `
    SELECT approval_id AS approvalId, tenant_id AS tenantId, family_id AS familyId,
           revision_id AS revisionId, decision_id AS decisionId,
           decision_record_version AS decisionRecordVersion,
           action_execution_id AS actionExecutionId,
           approved_content_hash AS approvedContentHash,
           approved_context_version AS approvedContextVersion,
           actor_type AS actorType, approval_source AS approvalSource,
           approved_at AS approvedAt, created_at AS createdAt
      FROM training_plan_revision_approvals WHERE user_id = ?
     ORDER BY tenant_id, approved_at, approval_id
  `, userId);
  const trainingCurrentContexts = safeAll(db, `
    SELECT tenant_id AS tenantId, family_id AS familyId,
           current_revision_id AS currentRevisionId,
           current_profile_snapshot_id AS currentProfileSnapshotId,
           current_context_version AS currentContextVersion,
           base_context_version AS baseContextVersion,
           profile_source_version AS profileSourceVersion,
           calendar_source_version AS calendarSourceVersion,
           conflict_source_version AS conflictSourceVersion,
           pointer_version AS pointerVersion, created_at AS createdAt, updated_at AS updatedAt
      FROM training_plan_current_contexts WHERE user_id = ?
     ORDER BY tenant_id, family_id
  `, userId);
  const trainingActiveReferences = safeAll(db, `
    SELECT tenant_id AS tenantId, family_id AS familyId,
           active_revision_id AS activeRevisionId, projection_plan_id AS projectionPlanId,
           pointer_version AS pointerVersion, created_at AS createdAt, updated_at AS updatedAt
      FROM training_active_plan_references WHERE user_id = ?
     ORDER BY tenant_id, family_id
  `, userId);
  const rawTrainingOperations = safeAll(db, `
    SELECT operation_id AS operationId, tenant_id AS tenantId,
           operation_type AS operationType, idempotency_key AS idempotencyKey,
           request_hash AS requestHash, status, result_family_id AS resultFamilyId,
           result_revision_id AS resultRevisionId, result_decision_id AS resultDecisionId,
           response_json AS responseJson, attempt_count AS attemptCount,
           last_error_code AS lastErrorCode, created_at AS createdAt,
           updated_at AS updatedAt, completed_at AS completedAt
      FROM training_plan_revision_operations WHERE user_id = ?
     ORDER BY tenant_id, created_at, operation_id
  `, userId) as Array<Record<string, any>>;
  const trainingOperations = rawTrainingOperations.map((row) => {
    const { responseJson, ...metadata } = row;
    return { ...metadata, response: responseJson == null ? null : parseExportJson(responseJson) };
  });
  const trainingAdaptationPreviews = safeAll(db, `
    SELECT adaptation_id AS adaptationId, tenant_id AS tenantId, family_id AS familyId,
           source_revision_id AS sourceRevisionId, event_id AS eventId,
           trigger_kind AS triggerKind, scope, target_json AS target,
           explicit_input_json AS explicitInput, options_json AS options,
           preview_hash AS previewHash, request_hash AS requestHash,
           expected_source_content_hash AS expectedSourceContentHash,
           expected_context_version AS expectedContextVersion,
           expected_active_pointer_version AS expectedActivePointerVersion,
           policy_version AS policyVersion, expires_at AS expiresAt, created_at AS createdAt
      FROM training_adaptation_previews WHERE user_id = ?
     ORDER BY tenant_id, created_at, adaptation_id
  `, userId).map((row: Record<string, unknown>) => ({
    ...row,
    target: parseExportJson(row.target),
    explicitInput: parseExportJson(row.explicitInput),
    options: parseExportJson(row.options),
  }));
  const trainingAdaptationProposals = safeAll(db, `
    SELECT proposal_id AS proposalId, adaptation_id AS adaptationId, tenant_id AS tenantId,
           family_id AS familyId, source_revision_id AS sourceRevisionId,
           proposed_revision_id AS proposedRevisionId, decision_id AS decisionId,
           scope, trigger_kind AS triggerKind, option_kind AS optionKind,
           selected_option_id AS selectedOptionId, option_hash AS optionHash,
           current_state_json AS currentState, proposed_state_json AS proposedState,
           differences_json AS differences, evidence_json AS evidence, rationale,
           expected_benefit AS expectedBenefit, possible_downside AS possibleDownside,
           reversibility, future_session_effect AS futureSessionEffect, status,
           expires_at AS expiresAt, created_at AS createdAt, review_requested_at AS reviewRequestedAt,
           deferred_at AS deferredAt, activated_at AS activatedAt, rejected_at AS rejectedAt,
           expired_at AS expiredAt, superseded_at AS supersededAt
      FROM training_adaptation_proposals WHERE user_id = ?
     ORDER BY tenant_id, created_at, proposal_id
  `, userId).map((row: Record<string, unknown>) => ({
    ...row,
    currentState: parseExportJson(row.currentState),
    proposedState: parseExportJson(row.proposedState),
    differences: parseExportJson(row.differences),
    evidence: parseExportJson(row.evidence),
  }));
  const trainingAdaptationLifecycle = safeAll(db, `
    SELECT event_id AS eventId, proposal_id AS proposalId, tenant_id AS tenantId,
           event_type AS eventType, reason_code AS reasonCode,
           metadata_json AS metadata, created_at AS createdAt
      FROM training_adaptation_lifecycle_events WHERE user_id = ?
     ORDER BY tenant_id, created_at, event_id
  `, userId).map((row: Record<string, unknown>) => ({
    ...row,
    metadata: parseExportJson(row.metadata),
  }));
  const productLearningCases = safeAll(db, `
    SELECT case_id AS caseId, tenant_id AS tenantId, user_id AS userId, owner, lifecycle,
           privacy_class AS privacyClass, redacted_input_json AS redactedInput,
           expected_contract_json AS expectedContract,
           evidence_references_json AS evidenceReferences,
           producer_version AS producerVersion, confidence,
           observed_at AS observedAt, reviewed_at AS reviewedAt,
           reviewed_by AS reviewedBy,
           review_approval_reference AS reviewApprovalReference,
           expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt
      FROM product_learning_cases WHERE user_id = ?
     ORDER BY tenant_id, observed_at, case_id
  `, userId).map((row: Record<string, unknown>) => ({
    ...row,
    redactedInput: parseExportJson(row.redactedInput),
    expectedContract: parseExportJson(row.expectedContract),
    evidenceReferences: parseExportJson(row.evidenceReferences),
  }));
  const productLearningCaseTransitions = safeAll(db, `
    SELECT transition_id AS transitionId, tenant_id AS tenantId, user_id AS userId,
           case_id AS caseId, from_lifecycle AS fromLifecycle,
           to_lifecycle AS toLifecycle, actor,
           approval_reference AS approvalReference,
           transitioned_at AS transitionedAt
      FROM product_learning_case_transitions WHERE user_id = ?
     ORDER BY tenant_id, transitioned_at, transition_id
  `, userId);
  const productLearningCaseReviewApprovals = safeAll(db, `
    SELECT approval_reference AS approvalReference, tenant_id AS tenantId, user_id AS userId,
           case_id AS caseId, action_execution_id AS actionExecutionId,
           decision_id AS decisionId, action_id AS actionId,
           reviewed_by AS reviewedBy, reviewed_at AS reviewedAt,
           created_at AS createdAt
      FROM product_learning_case_review_approvals WHERE user_id = ?
     ORDER BY tenant_id, reviewed_at, approval_reference
  `, userId);

  return {
    exportedAt: new Date().toISOString(),
    userId,
    user: user ? {
      username: user.username,
      firstName: user.first_name,
      language: user.language,
      timezone: user.timezone,
      tier: user.tier,
      createdAt: user.created_at,
    } : null,
    conversations,
    todos,
    reminders,
    notes,
    savedIdeas,
    contentWorkspace,
    sharedMemory,
    finance,
    oauthConnections: oauthRows.map((c: any) => ({ provider: c.provider, connectedAt: c.created_at })),
    settings: settings.map((s: any) => ({ key: s.key.replace(`config:${userId}:`, ''), value: s.value })),
    notificationDeviceTokens,
    garminSessions,
    agentSignals,
    encryptionMeta,
    legalConsents,
    secretaryAgendaItems,
    skillMemories,
    trainingFeedbackDecisions,
    secretarySourceSkillFeedback,
    productLearningCases,
    productLearningCaseTransitions,
    productLearningCaseReviewApprovals,
    trainingPlanRevisionV1: {
      capacitySnapshots: trainingCapacitySnapshots,
      profileSnapshots: trainingProfileSnapshots,
      planFamilies: trainingPlanFamilies,
      planRevisions: trainingPlanRevisions,
      approvalReceipts: trainingApprovalReceipts,
      currentContexts: trainingCurrentContexts,
      activeReferences: trainingActiveReferences,
      operations: trainingOperations,
      adaptationPreviews: trainingAdaptationPreviews,
      adaptationProposals: trainingAdaptationProposals,
      adaptationLifecycle: trainingAdaptationLifecycle,
    },
  };
}

function parseExportJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null;
  try { return JSON.parse(raw); } catch { return raw; }
}

// ── Full User Deletion (GDPR Article 17 — right to erasure) ────────

export const ACCOUNT_DELETION_TABLES: Array<{ table: string; column: string }> = [
  { table: 'messages', column: 'user_id' },
  { table: 'conversations', column: 'user_id' },
  { table: 'todos', column: 'user_id' },
  { table: 'native_tasks', column: 'user_id' },
  { table: 'native_task_lists', column: 'user_id' },
  { table: 'reminders', column: 'user_id' },
  { table: 'secretary_agenda_items', column: 'owner_user_id' },
  { table: 'skill_memories', column: 'user_id' },
  { table: 'training_feedback_decisions', column: 'user_id' },
  { table: 'secretary_source_skill_feedback', column: 'user_id' },
  { table: 'notes', column: 'user_id' },
  { table: 'saved_ideas', column: 'user_id' },
  { table: 'shared_memory', column: 'user_id' },
  { table: 'apple_health_data', column: 'user_id' },
  { table: 'readiness_scores', column: 'user_id' },
  { table: 'training_completions', column: 'user_id' },
  { table: 'training_m4_capacity_prune_authorizations', column: 'user_id' },
  { table: 'training_m4_capacity_snapshots', column: 'user_id' },
  { table: 'product_learning_case_review_approvals', column: 'user_id' },
  { table: 'product_learning_case_transitions', column: 'user_id' },
  { table: 'product_learning_cases', column: 'user_id' },
  {
    table: 'fitness_training_plans',
    column: 'user_id',
  },
  { table: 'finance_transactions', column: 'user_id' },
  { table: 'finance_tax_events', column: 'user_id' },
  { table: 'invoice_filings', column: 'user_id' },
  { table: 'user_encryption_meta', column: 'user_id' },
  { table: 'onboarding_sessions', column: 'user_id' },
  { table: 'user_profiles', column: 'user_id' },
  { table: 'ios_devices', column: 'user_id' },
  { table: 'notification_device_tokens', column: 'user_id' },
  { table: 'garmin_sessions', column: 'user_id' },
  { table: 'garmin_user_tokens', column: 'user_id' },
  { table: 'agent_signals', column: 'user_id' },
  { table: 'user_oauth_tokens', column: 'user_id' },
  { table: 'apple_sign_in_refresh_tokens', column: 'user_id' },
  { table: 'oauth_ios_nonce_sessions', column: 'user_id' },
  { table: 'user_skill_overrides', column: 'user_id' },
  { table: 'api_usage', column: 'user_id' },
  { table: 'chat_action_runs', column: 'user_id' },
  { table: 'chat_pending_actions', column: 'user_id' },
  { table: 'chat_action_telemetry', column: 'user_id' },
  { table: 'user_legal_consents', column: 'user_id' },
  { table: 'report_documents', column: 'user_id' },
  { table: 'push_preferences', column: 'user_id' },
  { table: 'content_notifications', column: 'user_id' },
  { table: 'content_scripts', column: 'user_id' },
  { table: 'content_performance', column: 'user_id' },
  { table: 'content_learned_patterns', column: 'user_id' },
  { table: 'content_pipeline', column: 'user_id' },
  { table: 'content_topic_feedback', column: 'user_id' },
  { table: 'content_topics', column: 'user_id' },
  { table: 'content_knowledge', column: 'user_id' },
  { table: 'content_ref_channels', column: 'user_id' },
  { table: 'book_library', column: 'user_id' },
  { table: 'subscriptions', column: 'user_id' },
  { table: 'stripe_web_checkouts', column: 'user_id' },
];

const ACCOUNT_DELETION_RETAINED_TABLES = new Set([
  'audit_trail',
  '_migrations',
]);

type AccountOwnershipColumn = 'user_id' | 'owner_user_id';

type AccountDeletionTableDescriptor = {
  table: string;
  columns: AccountOwnershipColumn[];
  hasTenantId: boolean;
};

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function buildOwnershipPredicate(
  columns: readonly AccountOwnershipColumn[],
  userId: number,
): { sql: string; params: number[] } {
  if (columns.length === 0) {
    throw new Error('Account data lifecycle table has no ownership column.');
  }
  const hasCanonicalOwner = columns.includes('owner_user_id');
  const hasLegacyOwner = columns.includes('user_id');
  if (hasCanonicalOwner && hasLegacyOwner) {
    return {
      sql: `${quoteSqlIdentifier('owner_user_id')} = ? OR (${quoteSqlIdentifier('owner_user_id')} IS NULL AND ${quoteSqlIdentifier('user_id')} = ?)`,
      params: [userId, userId],
    };
  }
  const ownerColumn: AccountOwnershipColumn = hasCanonicalOwner ? 'owner_user_id' : 'user_id';
  return {
    sql: `${quoteSqlIdentifier(ownerColumn)} = ?`,
    params: [userId],
  };
}

/**
 * Discover every directly user-owned table in the current schema.
 *
 * Both legacy `user_id` and canonical `owner_user_id` are discovered. When
 * both exist, the canonical owner wins and `user_id` is used only for rows
 * that have not yet been backfilled. Introspection is deliberately fail-closed
 * because a static fallback can never prove that a newer privacy-sensitive
 * table was covered.
 */
function accountDeletionTablesForDb(db: any): AccountDeletionTableDescriptor[] {
  const rows = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
  `).all() as Array<{ name: string }>;

  const descriptors = new Map<string, AccountDeletionTableDescriptor>();
  for (const row of rows) {
    if (!row?.name || row.name === 'users' || ACCOUNT_DELETION_RETAINED_TABLES.has(row.name)) continue;
    const schemaColumns = db.prepare(`PRAGMA table_info(${quoteSqlIdentifier(row.name)})`).all() as Array<{ name: string }>;
    const names = new Set(schemaColumns.map((column) => column.name));
    const columns: AccountOwnershipColumn[] = [];
    if (names.has('user_id')) columns.push('user_id');
    if (names.has('owner_user_id')) columns.push('owner_user_id');
    if (columns.length === 0) continue;
    descriptors.set(row.name, {
      table: row.name,
      columns,
      hasTenantId: names.has('tenant_id'),
    });
  }

  const ordered: AccountDeletionTableDescriptor[] = [];
  const added = new Set<string>();
  for (const { table } of ACCOUNT_DELETION_TABLES) {
    const descriptor = descriptors.get(table);
    if (!descriptor || added.has(table)) continue;
    ordered.push(descriptor);
    added.add(table);
  }
  for (const row of rows) {
    const descriptor = descriptors.get(row.name);
    if (!descriptor || added.has(row.name)) continue;
    ordered.push(descriptor);
    added.add(row.name);
  }

  return ordered;
}

export interface AccountDeletionInventory {
  userId: number;
  generatedAt: string;
  deletableTables: Record<string, number>;
  retainedTables: Record<string, { reason: string }>;
}

export function getAccountDeletionInventoryForUser(userId: number): AccountDeletionInventory {
  const db = getDb();
  const deletableTables: Record<string, number> = {};
  for (const { table, columns } of accountDeletionTablesForDb(db)) {
    const ownership = buildOwnershipPredicate(columns, userId);
    const row = db.prepare(
      `SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(table)} WHERE ${ownership.sql}`,
    ).get(...ownership.params) as { count: number };
    deletableTables[table] = row.count;
  }
  const kvRow = db.prepare('SELECT COUNT(*) AS count FROM kv_store WHERE key LIKE ?')
    .get(`config:${userId}:%`) as { count: number };
  deletableTables.kv_store_settings = kvRow.count;
  const userRow = db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ? OR telegram_id = ?')
    .get(userId, userId) as { count: number };
  deletableTables.users = userRow.count;

  return {
    userId,
    generatedAt: new Date().toISOString(),
    deletableTables,
    retainedTables: {
      audit_trail: {
        reason: 'Retained as legal proof of export, consent, and deletion events under GDPR Article 17(3)(e).',
      },
    },
  };
}

/**
 * Delete ALL data for a user across all tables. Runs in a single transaction.
 * The audit_trail table is NOT touched — legal requirement (Article 17(3)(e)).
 * Returns counts of deleted records per table.
 */
export function deleteAllUserData(userId: number): Record<string, number> {
  const db = getDb();
  const counts: Record<string, number> = {};
  const ownedTables = accountDeletionTablesForDb(db);

  const deleteAll = db.transaction(() => {
    const trainingErasureId = `training-erasure-${randomUUID()}`;
    const hasTrainingErasureGate = tableExistsForDeletion(db, 'training_revision_erasure_authorizations');
    if (hasTrainingErasureGate) {
      db.prepare(`
        INSERT INTO training_revision_erasure_authorizations (
          erasure_id, subject_user_id, reason, expires_at
        ) VALUES (?, ?, 'ACCOUNT_DELETION', datetime('now', '+5 minutes'))
      `).run(trainingErasureId, userId);
    }
    for (const { table, columns } of ownedTables) {
      const ownership = buildOwnershipPredicate(columns, userId);
      const result = db.prepare(
        `DELETE FROM ${quoteSqlIdentifier(table)} WHERE ${ownership.sql}`,
      ).run(...ownership.params);
      counts[table] = result.changes;
    }

    if (hasTrainingErasureGate) {
      const remaining = [
        'training_profile_snapshots',
        'training_plan_families',
        'training_plan_revisions',
        'training_plan_revision_approvals',
        'training_plan_current_contexts',
        'training_active_plan_references',
        'training_plan_revision_operations',
        'training_adaptation_previews',
        'training_adaptation_proposals',
        'training_adaptation_lifecycle_events',
        'training_m4_capacity_prune_authorizations',
        'training_m4_capacity_snapshots',
        'product_learning_case_review_approvals',
        'product_learning_case_transitions',
        'product_learning_cases',
      ].filter((table) => tableExistsForDeletion(db, table)).reduce((total, table) => {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(userId) as { count: number };
        return total + row.count;
      }, 0);
      if (remaining !== 0) {
        throw new Error('Account deletion could not erase immutable Training revision data.');
      }
      db.prepare('DELETE FROM training_revision_erasure_authorizations WHERE erasure_id = ?')
        .run(trainingErasureId);
    }

    // KV store per-user settings
    const kvResult = db.prepare("DELETE FROM kv_store WHERE key LIKE ?").run(`config:${userId}:%`);
    counts['kv_store_settings'] = kvResult.changes;

    // Delete user record last
    const userResult = db.prepare('DELETE FROM users WHERE id = ? OR telegram_id = ?').run(userId, userId);
    counts['users'] = userResult.changes;

    for (const { table, columns } of ownedTables) {
      const ownership = buildOwnershipPredicate(columns, userId);
      const row = db.prepare(
        `SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(table)} WHERE ${ownership.sql}`,
      ).get(...ownership.params) as { count: number };
      if (row.count !== 0) {
        throw new Error(`Account deletion left user-owned rows in ${table}.`);
      }
    }
    const remainingSettings = db.prepare('SELECT COUNT(*) AS count FROM kv_store WHERE key LIKE ?')
      .get(`config:${userId}:%`) as { count: number };
    if (remainingSettings.count !== 0) {
      throw new Error('Account deletion left user-owned settings rows.');
    }
    const remainingUsers = db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ? OR telegram_id = ?')
      .get(userId, userId) as { count: number };
    if (remainingUsers.count !== 0) {
      throw new Error('Account deletion left the user record in place.');
    }
  });

  deleteAll();

  return counts;
}

function tableExistsForDeletion(db: any, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Safe query that returns null instead of throwing if the table doesn't exist. */
function safeGet(db: any, sql: string, ...params: any[]): any {
  try {
    return db.prepare(sql).get(...params) ?? null;
  } catch {
    return null;
  }
}

/** Safe query that returns [] instead of throwing if the table doesn't exist. */
function safeAll(db: any, sql: string, ...params: any[]): any[] {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}
