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
import {
  ContentScriptJobEncryptionError,
  decryptContentScriptJobJson,
} from './content-script-job-encryption';

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
  const [inferenceFence, contentJobs] = await Promise.all([
    import('./skill-inference-account-lifecycle'),
    import('./content-script-job-account-lifecycle'),
  ]);
  let fenceToken: string;
  try {
    // The durable row blocks replacement inference throughout remote token
    // revocation; the in-process registry aborts requests already inside the
    // provider boundary. Failure to acquire this fence must fail the deletion
    // request instead of allowing erased telemetry to be recreated afterward.
    fenceToken = inferenceFence.beginSkillInferenceAccountDeletionFence(userId, getDb());
  } catch (err) {
    logger.error({ err, userId }, 'Unable to acquire the account-deletion inference fence');
    throw err;
  }
  const cancelUnfinishedScripts = (phase: 'before_revocation' | 'before_erasure') => {
    try {
      const cancelledScriptJobs = contentJobs.cancelContentScriptJobsForAccountDeletion(userId, getDb());
      if (cancelledScriptJobs > 0) {
        logger.info(
          { userId, cancelledScriptJobs, phase, event: 'account_deletion.content_jobs_cancelled' },
          'Active Content script jobs were fenced before account deletion',
        );
      }
    } catch (err) {
      // The durable inference fence remains authoritative for new provider
      // admission, and the immediate final erasure still removes owned rows.
      logger.warn({ err, userId, phase }, 'Unable to pre-cancel Content script jobs before account deletion');
    }
  };

  let deletionCompleted = false;
  try {
    cancelUnfinishedScripts('before_revocation');
    await inferenceFence.waitForSkillInferenceAccountAdmissionsToDrain(userId);

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
    } catch (revocationError) {
      // Article 17 erasure must not depend on a third party or an optional
      // predecessor credential table staying reachable. Individual provider
      // failures already degrade to typed outcomes; this catches schema probes.
      logger.warn(
        { err: revocationError, userId },
        'Third-party revocation phase failed before account deletion',
      );
    }
    // Close the revocation interval: a request accepted just before the durable
    // fence was observed may have created a script row after the first sweep.
    // This second sweep and the erasure transaction are synchronous, so no new
    // JavaScript admission can interleave between them in the one-backend
    // release topology.
    cancelUnfinishedScripts('before_erasure');
    const counts = deleteAllUserData(userId);
    deletionCompleted = true;
    return counts;
  } catch (err) {
    // Release the exact fence if transactional local erasure fails, allowing an
    // honest retry without reopening another deletion process's fence.
    logger.warn({ err, userId }, 'Account deletion failed before local erasure completed');
    throw err;
  } finally {
    if (!deletionCompleted) {
      try {
        inferenceFence.clearSkillInferenceAccountDeletionFence(userId, fenceToken, getDb());
      } catch (cleanupError) {
        // The row expires after 15 minutes, so a process/storage failure cannot
        // strand the account indefinitely even when cleanup is unavailable.
        logger.error({ err: cleanupError, userId }, 'Unable to release failed account-deletion inference fence');
      }
    }
  }
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
  skillInference: {
    runs: Array<Record<string, unknown>>;
    attempts: Array<Record<string, unknown>>;
    safetyIncidents: Array<Record<string, unknown>>;
  };
  sharedMemory: Array<{ key: string; value: string; updatedAt: string }>;
  finance: UserFinanceExport;
  oauthConnections: Array<{ provider: string; connectedAt: string }>;
  oauthConnectionHealth: Array<{
    provider: string;
    state: string;
    reasonCode: string;
    firstDetectedAt: string;
    lastDetectedAt: string;
  }>;
  settings: Array<{ key: string; value: string }>;
  notificationDeviceTokens: Array<{ environment: string; platform: string; appVersion: string | null; lastSeenAt: string; revokedAt: string | null }>;
  // Subject-access requests previously disclosed only the device tokens above
  // and skipped the notification store entirely — which is where the
  // personal data actually lives (event titles, task names, invoice
  // references in `body`/`sensitive_body`), plus the user's own preferences
  // and per-type mutes.
  notificationProfile: Array<Record<string, unknown>>;
  notificationCenterItems: Array<{
    itemId: string; sourceSkill: string; type: string; priority: string; status: string;
    title: string; body: string; sensitiveBody: string | null;
    createdAt: string; readAt: string | null; dismissedAt: string | null; snoozedUntil: string | null;
  }>;
  notificationDecisionLogs: Array<{
    decision: string; reason: string; priority: string; sourceSkill: string; type: string | null;
    scheduledFor: string | null; sentAt: string | null; openedAt: string | null;
    actionTaken: string | null; createdAt: string;
  }>;
  notificationTypeSuppressions: Array<{ sourceSkill: string; type: string; mode: string; until: string | null; createdAt: string }>;
  notificationEngagementEvents: Array<{ sourceSkill: string; type: string; eventType: string; actionId: string | null; createdAt: string }>;
  notificationPriorityShadow: Array<{ sourceSkill: string; type: string; declaredPriority: string; effectivePriority: string; actualDecision: string; score: number; tier: string; createdAt: string }>;
  // NH-0041: subject ACCESS covers the billing evidence that erasure
  // deliberately preserves (append-only ledger + Apple inbox metadata).
  billing: {
    aiCreditLots: Array<Record<string, unknown>>;
    aiCreditReservations: Array<Record<string, unknown>>;
    aiCreditCaptures: Array<Record<string, unknown>>;
    appleNotifications: Array<Record<string, unknown>>;
    // Erasure clears these two, so Article 15 access must also disclose them
    // (QA5 P2 dsar-export-omits-subscription-and-web-checkout-tables).
    subscriptions: Array<Record<string, unknown>>;
    webCheckouts: Array<Record<string, unknown>>;
  };
  deviceInference: {
    admissions: Array<Record<string, unknown>>;
    evidence: Array<Record<string, unknown>>;
  };
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
  trainingPlanCompatibility: {
    plans: Array<Record<string, unknown>>;
    weeks: Array<Record<string, unknown>>;
    sessions: Array<Record<string, unknown>>;
    completions: Array<Record<string, unknown>>;
  };
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
  warnings: Array<{
    code:
      | 'CONTENT_SCRIPT_JOB_KEY_VERSION_UNAVAILABLE'
      | 'CONTENT_SCRIPT_JOB_ENCRYPTION_KEY_UNAVAILABLE';
    table: 'content_script_jobs';
    recordId: string;
    unavailableFields: string[];
  }>;
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
 * a hard failure. The only exceptions are a retired historical script-job key
 * or an unavailable export key: the export returns all still-readable records
 * plus an explicit, field-level partial-archive warning. Corrupt ciphertext and
 * malformed envelopes remain hard failures because silently omitting them would
 * be misleading.
 */
export function exportContentWorkspaceData(
  userId: number,
  tenantId?: number,
): ContentWorkspaceExport {
  const db = getDb();
  const warnings: ContentWorkspaceExport['warnings'] = [];
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
      let records = db.prepare(
        `SELECT * FROM ${quoteSqlIdentifier(descriptor.table)} WHERE (${ownership.sql})${tenantClause}`,
      ).all(...params) as Array<Record<string, unknown>>;

      if (descriptor.table === 'content_script_jobs') {
        records = records.map((record) => exportContentScriptJobRecord(
          db,
          record,
          userId,
          warnings,
        ));
      }

      return {
        name: descriptor.table,
        ownershipColumns: [...descriptor.columns],
        records,
      };
    });

  return {
    schemaVersion: 'content-workspace-export-v1',
    tables,
    warnings,
  };
}

function exportContentScriptJobRecord(
  db: ReturnType<typeof getDb>,
  record: Record<string, unknown>,
  userId: number,
  warnings: ContentWorkspaceExport['warnings'],
): Record<string, unknown> {
  const jobId = typeof record.job_id === 'string' ? record.job_id : '';
  const exported = { ...record };
  const unavailableFields: string[] = [];
  const unavailableFieldsByCode = new Map<ContentWorkspaceExport['warnings'][number]['code'], string[]>();
  const decryptForExport = <T>(stored: string, field: string): T | null => {
    try {
      return decryptContentScriptJobJson<T>(stored, userId);
    } catch (error) {
      if (error instanceof ContentScriptJobEncryptionError
          && (error.code === 'CONTENT_SCRIPT_JOB_KEY_VERSION_UNAVAILABLE'
            || error.code === 'CONTENT_SCRIPT_JOB_ENCRYPTION_KEY_UNAVAILABLE')) {
        unavailableFields.push(field);
        const warningCode = error.code as ContentWorkspaceExport['warnings'][number]['code'];
        const fields = unavailableFieldsByCode.get(warningCode) ?? [];
        fields.push(field);
        unavailableFieldsByCode.set(warningCode, fields);
        return null;
      }
      throw error;
    }
  };
  const requestCiphertext = typeof record.request_json === 'string' ? record.request_json : '';
  const resultCiphertext = typeof record.result_json === 'string' ? record.result_json : '';
  exported.request = requestCiphertext
    ? decryptForExport<Record<string, unknown>>(requestCiphertext, 'request')
    : null;
  exported.result = resultCiphertext
    ? decryptForExport<Record<string, unknown>>(resultCiphertext, 'result')
    : null;
  const checkpointRows = jobId ? db.prepare(`
    SELECT section_index, section_key, state, word_budget, output_json,
           validation_json, route, model_digest, created_at, updated_at
      FROM content_script_job_checkpoints
     WHERE job_id = ?
     ORDER BY section_index
  `).all(jobId) as Array<Record<string, unknown>> : [];
  exported.checkpoints = checkpointRows.map((checkpoint) => ({
    sectionIndex: checkpoint.section_index,
    sectionKey: checkpoint.section_key,
    state: checkpoint.state,
    wordBudget: checkpoint.word_budget,
    output: typeof checkpoint.output_json === 'string'
      ? decryptForExport<unknown>(
        checkpoint.output_json,
        `checkpoints[${String(checkpoint.section_index)}].output`,
      )
      : null,
    validation: typeof checkpoint.validation_json === 'string'
      ? JSON.parse(checkpoint.validation_json)
      : null,
    route: checkpoint.route,
    modelDigest: checkpoint.model_digest,
    createdAt: checkpoint.created_at,
    updatedAt: checkpoint.updated_at,
  }));
  for (const field of [
    'request_json',
    'result_json',
    'lease_token',
    'lease_expires_at',
  ]) delete exported[field];
  if (unavailableFields.length > 0) {
    exported.decryptionStatus = unavailableFieldsByCode.has('CONTENT_SCRIPT_JOB_ENCRYPTION_KEY_UNAVAILABLE')
      ? 'partial_encryption_key_unavailable'
      : 'partial_historical_key_unavailable';
    exported.unavailableEncryptedFields = [...unavailableFields];
    for (const [code, fields] of unavailableFieldsByCode) {
      warnings.push({
        code,
        table: 'content_script_jobs',
        recordId: jobId,
        unavailableFields: [...fields],
      });
    }
  }
  return exported;
}

export function exportSkillInferenceData(
  userId: number,
  tenantId?: number,
): FullUserExport['skillInference'] {
  const db = getDb();
  const effectiveTenantId = typeof tenantId === 'number' ? tenantId : userId;
  const runs = db.prepare(`
    SELECT run_id AS runId, operation_id AS operationId, tenant_id AS tenantId,
           plan_id AS planId,
           skill_id AS skillId, task_type AS taskType, risk_class AS riskClass,
           execution_class AS executionClass, evaluation_mode AS evaluationMode,
           local_admission_requested AS localAdmissionRequested,
           profile_version AS profileVersion,
           status, final_route AS finalRoute, provider, model_id AS modelId,
           model_digest AS modelDigest, validation_status AS validationStatus,
           fallback_reason AS fallbackReason, input_tokens AS inputTokens,
           output_tokens AS outputTokens, queue_wait_ms AS queueWaitMs,
           first_token_ms AS firstTokenMs,
           generation_tokens_per_second AS generationTokensPerSecond,
           duration_ms AS durationMs, created_at AS createdAt,
           started_at AS startedAt, completed_at AS completedAt
      FROM skill_inference_runs
     WHERE tenant_id = ? AND user_id = ? ORDER BY created_at
  `).all(effectiveTenantId, userId) as FullUserExport['skillInference']['runs'];
  const attempts = db.prepare(`
    SELECT a.id AS attemptId, a.run_id AS runId,
           a.attempt_number AS attemptNumber, a.route, a.provider,
           a.model_id AS modelId, a.model_digest AS modelDigest,
           a.outcome, a.failure_reason AS failureReason,
           a.input_tokens AS inputTokens, a.output_tokens AS outputTokens,
           a.queue_wait_ms AS queueWaitMs, a.first_token_ms AS firstTokenMs,
           a.generation_tokens_per_second AS generationTokensPerSecond,
           a.duration_ms AS durationMs, a.created_at AS createdAt
      FROM skill_inference_attempts a
      JOIN skill_inference_runs r ON r.run_id = a.run_id
     WHERE r.tenant_id = ? AND r.user_id = ? ORDER BY a.id
  `).all(effectiveTenantId, userId) as FullUserExport['skillInference']['attempts'];
  const safetyIncidents = db.prepare(`
    SELECT id AS incidentId, environment, incident_code AS incidentCode,
           source, tenant_id AS tenantId, user_id AS userId,
           run_id AS runId, blocked, created_at AS createdAt
      FROM local_inference_safety_incidents
     WHERE tenant_id = ? AND user_id = ? ORDER BY created_at
  `).all(effectiveTenantId, userId) as FullUserExport['skillInference']['safetyIncidents'];
  return { runs, attempts, safetyIncidents };
}

const APPLE_INBOX_EXPORT_SCAN_CAP = 5_000;

/**
 * Inbox rows carry no user_id; a row belongs to the requesting user when its
 * decoded transaction id matches one of the user's own Apple lots. The JWS
 * payload is base64-decoded for matching only and is never exported.
 */
function exportAppleNotificationMetadataForUser(
  db: ReturnType<typeof getDb>,
  userId: number,
): Array<Record<string, unknown>> {
  const ownedIds = new Set(
    (safeAll(db,
      "SELECT provider_transaction_id AS id FROM ai_credit_lots WHERE user_id = ? AND provider = 'apple' AND provider_transaction_id IS NOT NULL",
      userId) as Array<{ id: string }>).map((row) => row.id),
  );
  if (ownedIds.size === 0) return [];
  const rows = safeAll(db,
    `SELECT notification_type AS notificationType, product_id AS productId, state,
            environment, received_at AS receivedAt, signed_payload AS signedPayload
       FROM apple_notification_inbox ORDER BY id DESC LIMIT ${APPLE_INBOX_EXPORT_SCAN_CAP}`) as Array<Record<string, unknown>>;
  const matched: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const ids = decodeAppleInboxTransactionIds(String(row.signedPayload ?? ''));
    if (!ids.some((id) => ownedIds.has(id))) continue;
    const { signedPayload: _omitted, ...metadata } = row;
    matched.push(metadata);
  }
  return matched;
}

function decodeAppleInboxTransactionIds(signedPayload: string): string[] {
  try {
    const outer = decodeJwsPayload(signedPayload);
    const innerJws = outer?.data?.signedTransactionInfo;
    if (typeof innerJws !== 'string') return [];
    const inner = decodeJwsPayload(innerJws);
    return [inner?.transactionId, inner?.originalTransactionId]
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

function decodeJwsPayload(jws: string): Record<string, any> | null {
  const parts = jws.split('.');
  if (parts.length !== 3) return null;
  return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
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
  const skillInference = exportSkillInferenceData(userId, userId);
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
  const oauthConnectionHealth = safeAll(db, `
    SELECT provider, state, reason_code AS reasonCode,
           first_detected_at AS firstDetectedAt,
           last_detected_at AS lastDetectedAt
    FROM user_oauth_connection_health
    WHERE user_id = ? AND tenant_id = ?
    ORDER BY provider
  `, userId, userId);

  // User settings from kv_store
  const settings = safeAll(db,
    "SELECT key, value FROM kv_store WHERE key LIKE ?", `config:${userId}:%`);
  const notificationDeviceTokens = safeAll(db,
    'SELECT environment, platform, app_version as appVersion, last_seen_at as lastSeenAt, revoked_at as revokedAt FROM notification_device_tokens WHERE user_id = ?', userId);
  const notificationProfile = safeAll(db,
    'SELECT * FROM notification_profiles WHERE user_id = ?', userId);
  const notificationCenterItems = safeAll(db,
    `SELECT item_id as itemId, source_skill as sourceSkill, type, priority, status,
            title, body, sensitive_body as sensitiveBody,
            created_at as createdAt, read_at as readAt, dismissed_at as dismissedAt,
            snoozed_until as snoozedUntil
       FROM notification_center_items WHERE user_id = ? ORDER BY created_at`, userId);
  const notificationDecisionLogs = safeAll(db,
    `SELECT logs.decision, logs.reason, logs.priority,
            logs.source_skill as sourceSkill, intents.type,
            logs.scheduled_for as scheduledFor, logs.sent_at as sentAt,
            logs.opened_at as openedAt, logs.action_taken as actionTaken,
            logs.created_at as createdAt
       FROM notification_decision_logs AS logs
       LEFT JOIN notification_intents AS intents
         ON intents.intent_id = logs.intent_id
        AND intents.user_id = logs.user_id
        AND intents.tenant_id = logs.tenant_id
      WHERE logs.user_id = ?
      ORDER BY logs.created_at`, userId);
  const notificationTypeSuppressions = safeAll(db,
    `SELECT source_skill as sourceSkill, type, mode, until, created_at as createdAt
       FROM decision_type_suppressions WHERE user_id = ?`, userId);
  const notificationEngagementEvents = safeAll(db,
    `SELECT source_skill as sourceSkill, type, event_type as eventType,
            action_id as actionId, created_at as createdAt
       FROM notification_engagement_events WHERE user_id = ? ORDER BY created_at`, userId);
  // Erasure already covered this table (accountDeletionTablesForDb walks
  // sqlite_master for user_id columns), but subject ACCESS did not: it holds
  // per-user scores and tiers, which is personal data the user may ask to see.
  const notificationPriorityShadow = safeAll(db,
    `SELECT source_skill as sourceSkill, type,
            declared_priority as declaredPriority, effective_priority as effectivePriority,
            actual_decision as actualDecision, score, tier, created_at as createdAt
       FROM notification_priority_shadow WHERE user_id = ? ORDER BY created_at`, userId);
  const garminSessions = safeAll(db,
    'SELECT last_refreshed_at as lastRefreshedAt, created_at as createdAt, updated_at as updatedAt FROM garmin_sessions WHERE user_id = ?', userId);
  // NH-0041 DSAR billing section. The ledger rows are the user's charge
  // evidence; the Apple inbox has no user_id column, so rows are matched by
  // decoding each stored transaction id against the user's own Apple lots
  // (metadata only — the signed payload itself is never exported).
  const aiCreditLots = safeAll(db,
    `SELECT lot_type as lotType, credits_granted as creditsGranted, granted_at as grantedAt,
            expires_at as expiresAt, source_kind as sourceKind, source_ref as sourceRef,
            provider, provider_transaction_id as providerTransactionId, status
       FROM ai_credit_lots WHERE user_id = ? ORDER BY id`, userId);
  const aiCreditReservations = safeAll(db,
    `SELECT operation_class as operationClass, credits, state, workload,
            reserved_at as reservedAt, settled_at as settledAt, capture_shortfall as captureShortfall
       FROM ai_credit_reservations WHERE user_id = ? ORDER BY id`, userId);
  const aiCreditCaptures = safeAll(db,
    `SELECT reservation_id as reservationId, lot_id as lotId, credits, created_at as createdAt
       FROM ai_credit_captures WHERE user_id = ? ORDER BY id`, userId);
  const appleNotifications = exportAppleNotificationMetadataForUser(db, userId);
  // Both tables are erased on deletion, so access must disclose them too.
  // Provider customer/subscription ids are the subject's own identifiers.
  const subscriptions = safeAll(db,
    `SELECT plan, period, status, provider,
            provider_subscription_id as providerSubscriptionId,
            provider_customer_id as providerCustomerId,
            current_period_start as currentPeriodStart,
            current_period_end as currentPeriodEnd,
            cancel_at_period_end as cancelAtPeriodEnd,
            created_at as createdAt, updated_at as updatedAt
       FROM subscriptions WHERE user_id = ? ORDER BY id`, userId);
  const webCheckouts = safeAll(db,
    `SELECT email, plan, currency, price_id as priceId, status,
            stripe_checkout_session_id as stripeCheckoutSessionId,
            stripe_customer_id as stripeCustomerId,
            stripe_subscription_id as stripeSubscriptionId,
            created_at as createdAt, updated_at as updatedAt
       FROM stripe_web_checkouts WHERE user_id = ? ORDER BY id`, userId);
  // Device execution stores no prompt or output. Subject access still
  // discloses the user's routing/admission metadata and device-runtime
  // evidence, including the one-way request digest and device identifier.
  const deviceInferenceAdmissions = safeAll(db, `
    SELECT id, tenant_scope AS tenantScope, device_id AS deviceId,
           operation_key AS operationKey, request_digest AS requestDigest,
           client_operation_id AS clientOperationId,
           policy_version AS policyVersion, reservation_id AS reservationId,
           state, issued_at AS issuedAt, expires_at AS expiresAt,
           settled_at AS settledAt
      FROM device_inference_admissions
     WHERE user_id = ?
     ORDER BY issued_at, id
  `, userId);
  const deviceInferenceEvidence = safeAll(db, `
    SELECT admission_id AS admissionId, tenant_scope AS tenantScope,
           device_id AS deviceId, operation_key AS operationKey,
           policy_version AS policyVersion, outcome,
           os_version AS osVersion, os_build AS osBuild,
           device_model AS deviceModel, locale,
           framework_available AS frameworkAvailable,
           availability_reason AS availabilityReason,
           duration_ms AS durationMs, created_at AS createdAt
      FROM device_inference_evidence
     WHERE user_id = ?
     ORDER BY created_at, id
  `, userId);
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
  // The released compatibility plan graph predates direct user ownership on
  // its child tables. Export those rows through the user-owned parent plan so
  // rich completion/skip health feedback is portable without crossing users.
  const trainingCompatibilityPlans = safeAll(db, `
    SELECT plans.*
      FROM fitness_training_plans AS plans
     WHERE plans.user_id = ?
     ORDER BY plans.id
  `, userId).map((row: Record<string, unknown>) => {
    const { preferences_json: preferencesJson, ...rest } = row;
    return { ...rest, preferences: parseExportJson(preferencesJson) };
  });
  const trainingCompatibilityWeeks = safeAll(db, `
    SELECT weeks.*
      FROM training_weeks AS weeks
      JOIN fitness_training_plans AS plans ON plans.id = weeks.plan_id
     WHERE plans.user_id = ?
     ORDER BY weeks.plan_id, weeks.week_number, weeks.id
  `, userId);
  const trainingCompatibilitySessions = safeAll(db, `
    SELECT sessions.*
      FROM training_sessions AS sessions
      JOIN fitness_training_plans AS plans ON plans.id = sessions.plan_id
     WHERE plans.user_id = ?
     ORDER BY sessions.plan_id, sessions.id
  `, userId).map((row: Record<string, unknown>) => {
    const { exercises_json: exercisesJson, ...rest } = row;
    return { ...rest, exercises: parseExportJson(exercisesJson) };
  });
  const trainingCompatibilityCompletions = safeAll(db, `
    SELECT completions.*
      FROM training_completions AS completions
      JOIN fitness_training_plans AS plans ON plans.id = completions.plan_id
     WHERE plans.user_id = ?
     ORDER BY completions.plan_id, completions.completed_at, completions.id
  `, userId).map((row: Record<string, unknown>) => {
    const {
      actual_exercises_json: actualExercisesJson,
      discomfort_flags_json: discomfortFlagsJson,
      discomfort_locations_json: discomfortLocationsJson,
      substitutions_used_json: substitutionsUsedJson,
      ...rest
    } = row;
    return {
      ...rest,
      actual_exercises: parseExportJson(actualExercisesJson),
      discomfort_flags: parseExportJson(discomfortFlagsJson),
      discomfort_locations: parseExportJson(discomfortLocationsJson),
      substitutions_used: parseExportJson(substitutionsUsedJson),
    };
  });
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
    skillInference,
    sharedMemory,
    finance,
    oauthConnections: oauthRows.map((c: any) => ({ provider: c.provider, connectedAt: c.created_at })),
    oauthConnectionHealth,
    settings: settings.map((s: any) => ({ key: s.key.replace(`config:${userId}:`, ''), value: s.value })),
    notificationDeviceTokens,
    notificationProfile,
    notificationCenterItems,
    notificationDecisionLogs,
    notificationTypeSuppressions,
    notificationEngagementEvents,
    notificationPriorityShadow,
    billing: {
      aiCreditLots,
      aiCreditReservations,
      aiCreditCaptures,
      appleNotifications,
      subscriptions,
      webCheckouts,
    },
    deviceInference: {
      admissions: deviceInferenceAdmissions,
      evidence: deviceInferenceEvidence,
    },
    garminSessions,
    agentSignals,
    encryptionMeta,
    legalConsents,
    secretaryAgendaItems,
    skillMemories,
    trainingFeedbackDecisions,
    secretarySourceSkillFeedback,
    trainingPlanCompatibility: {
      plans: trainingCompatibilityPlans,
      weeks: trainingCompatibilityWeeks,
      sessions: trainingCompatibilitySessions,
      completions: trainingCompatibilityCompletions,
    },
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
  // `training_weeks`, `training_sessions`, and `training_completions` have no
  // direct user_id. Their ownership is derived explicitly through
  // fitness_training_plans below for inventory, export, and erasure proof.
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
  { table: 'user_oauth_connection_health', column: 'user_id' },
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
  // Delete evidence before its admission parent. The evidence table is
  // immutable to UPDATE but intentionally deletable for Article 17/retention.
  { table: 'device_inference_evidence', column: 'user_id' },
  { table: 'device_inference_admissions', column: 'user_id' },
];

const ACCOUNT_DELETION_RETAINED_TABLES = new Set([
  'audit_trail',
  'local_inference_runtime_control',
  'local_inference_control_events',
  'local_inference_safety_incidents',
  '_migrations',
  // Hybrid AI credit ledger (plan §4): billing evidence is append-only and
  // under statutory retention, and the ledger's schema triggers abort DELETE
  // by design — enumerating these tables would abort and roll back the whole
  // erasure. Rows carry only internal numeric ids (no PII, which is erased
  // elsewhere in this transaction); the erasure/pseudonymization policy for
  // financial evidence is the NH-0035 owner+counsel decision.
  'ai_credit_lots',
  'ai_credit_reservations',
  'ai_credit_captures',
  // Apple notification evidence is likewise append-only (its DELETE trigger
  // would abort the erasure transaction) and is billing evidence under plan
  // §4. Note its `signed_payload` retains Apple-issued purchase identifiers
  // including appAccountToken, which the owner-held JWT secret can reverse to
  // this user id — reducing or pseudonymizing that payload after processing
  // is part of the NH-0035 owner+counsel decision.
  'apple_notification_inbox',
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

const TRAINING_COMPATIBILITY_CHILD_TABLES = [
  'training_weeks',
  'training_sessions',
  'training_completions',
] as const;

const LOCAL_INFERENCE_CASCADE_CHILD_TABLES = [
  {
    childTable: 'content_script_job_checkpoints',
    childForeignKey: 'job_id',
    parentTable: 'content_script_jobs',
    parentPrimaryKey: 'job_id',
    parentOwnerColumn: 'owner_user_id',
  },
  {
    childTable: 'skill_inference_attempts',
    childForeignKey: 'run_id',
    parentTable: 'skill_inference_runs',
    parentPrimaryKey: 'run_id',
    parentOwnerColumn: 'user_id',
  },
] as const;

function ownedLocalInferenceCascadeChildState(
  db: any,
  userId: number,
): {
  counts: Record<string, number>;
  parentIdsByChild: Map<string, Array<string | number>>;
} {
  const counts: Record<string, number> = {};
  const parentIdsByChild = new Map<string, Array<string | number>>();
  for (const relation of LOCAL_INFERENCE_CASCADE_CHILD_TABLES) {
    if (!tableExistsForDeletion(db, relation.parentTable)
        || !tableExistsForDeletion(db, relation.childTable)) continue;
    const parentIds = (db.prepare(`SELECT ${quoteSqlIdentifier(relation.parentPrimaryKey)} AS id
      FROM ${quoteSqlIdentifier(relation.parentTable)}
      WHERE ${quoteSqlIdentifier(relation.parentOwnerColumn)} = ?`)
      .all(userId) as Array<{ id: string | number }>).map((row) => row.id);
    parentIdsByChild.set(relation.childTable, parentIds);
    const row = db.prepare(`SELECT COUNT(*) AS count
      FROM ${quoteSqlIdentifier(relation.childTable)} AS child
      JOIN ${quoteSqlIdentifier(relation.parentTable)} AS parent
        ON parent.${quoteSqlIdentifier(relation.parentPrimaryKey)} = child.${quoteSqlIdentifier(relation.childForeignKey)}
      WHERE parent.${quoteSqlIdentifier(relation.parentOwnerColumn)} = ?`)
      .get(userId) as { count: number };
    counts[relation.childTable] = row.count;
  }
  return { counts, parentIdsByChild };
}

function assertLocalInferenceCascadeChildrenDeleted(
  db: any,
  parentIdsByChild: Map<string, Array<string | number>>,
): void {
  for (const relation of LOCAL_INFERENCE_CASCADE_CHILD_TABLES) {
    const parentIds = parentIdsByChild.get(relation.childTable) ?? [];
    if (parentIds.length === 0 || !tableExistsForDeletion(db, relation.childTable)) continue;
    // Keep verification below SQLite's host-parameter ceiling even for
    // long-lived accounts with many script jobs or inference runs.
    for (let offset = 0; offset < parentIds.length; offset += 500) {
      const batch = parentIds.slice(offset, offset + 500);
      const placeholders = batch.map(() => '?').join(', ');
      const remaining = db.prepare(`SELECT COUNT(*) AS count
        FROM ${quoteSqlIdentifier(relation.childTable)}
        WHERE ${quoteSqlIdentifier(relation.childForeignKey)} IN (${placeholders})`)
        .get(...batch) as { count: number };
      if (remaining.count !== 0) {
        throw new Error(`Account deletion left cascade-owned rows in ${relation.childTable}.`);
      }
    }
  }
}

function ownedTrainingCompatibilityPlanIds(db: any, userId: number): number[] {
  if (!tableExistsForDeletion(db, 'fitness_training_plans')) return [];
  return (db.prepare(`
    SELECT id FROM fitness_training_plans WHERE user_id = ? ORDER BY id
  `).all(userId) as Array<{ id: number }>).map((row) => row.id);
}

function countOwnedTrainingCompatibilityChildren(
  db: any,
  userId: number,
): Partial<Record<(typeof TRAINING_COMPATIBILITY_CHILD_TABLES)[number], number>> {
  if (!tableExistsForDeletion(db, 'fitness_training_plans')) return {};
  const counts: Partial<Record<(typeof TRAINING_COMPATIBILITY_CHILD_TABLES)[number], number>> = {};
  for (const table of TRAINING_COMPATIBILITY_CHILD_TABLES) {
    if (!tableExistsForDeletion(db, table)) continue;
    const row = db.prepare(`
      SELECT COUNT(*) AS count
        FROM ${quoteSqlIdentifier(table)} AS child
        JOIN fitness_training_plans AS plans ON plans.id = child.plan_id
       WHERE plans.user_id = ?
    `).get(userId) as { count: number };
    counts[table] = row.count;
  }
  return counts;
}

export interface AccountDeletionInventory {
  userId: number;
  generatedAt: string;
  deletableTables: Record<string, number>;
  retainedTables: Record<string, { reason: string }>;
}

/**
 * Current personal cache key families. `api_cache` predates ownership columns,
 * so Article 17 must use the bounded key grammar rather than a broad numeric
 * substring match (which could confuse user 1 with user 10).
 */
function accountOwnedApiCachePatterns(userId: number): string[] {
  const id = String(userId);
  return [
    `u:${id}:%`,
    `%:u:${id}:%`,
    `%:scope:${id}:%`,
    `coach-briefing:${id}`,
    `dashboard-readiness:${id}`,
    `training:keep-original:${id}:%`,
    `chat-cmd:%:${id}:%`,
    `dashboard:%:${id}:%`,
    `dashboard-home:%:${id}:%`,
    `readiness:%:${id}`,
    `training-home:%:${id}:%`,
    `training-summary:%:${id}`,
    `cardio-progression:%:${id}:%`,
    `strength-progression:%:${id}:%`,
    `training-activity-weekly:%:${id}`,
    `training-history:%:${id}:%`,
    `training-load-snapshot:%:${id}`,
    `unified-inbox:${id}:tenant:%`,
    `unified-inbox-unread:${id}:tenant:%`,
  ];
}

function accountOwnedApiCachePredicate(userId: number): { sql: string; params: string[] } {
  const params = accountOwnedApiCachePatterns(userId);
  return {
    sql: params.map(() => 'cache_key LIKE ?').join(' OR '),
    params,
  };
}

function countAccountOwnedApiCacheRows(db: any, userId: number): number {
  if (!tableExistsForDeletion(db, 'api_cache')) return 0;
  const ownership = accountOwnedApiCachePredicate(userId);
  const row = db.prepare(`SELECT COUNT(*) AS count FROM api_cache WHERE ${ownership.sql}`)
    .get(...ownership.params) as { count: number };
  return row.count;
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
  Object.assign(deletableTables, countOwnedTrainingCompatibilityChildren(db, userId));
  Object.assign(deletableTables, ownedLocalInferenceCascadeChildState(db, userId).counts);
  deletableTables.api_cache = countAccountOwnedApiCacheRows(db, userId);
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
      local_inference_runtime_control: {
        reason: 'Environment-wide operational state contains no subject prompt or generated content and cannot be deleted per account.',
      },
      local_inference_control_events: {
        reason: 'Environment-wide security and release-control evidence is retained independently of subject content; actor ids are operational audit attribution.',
      },
      local_inference_safety_incidents: {
        reason: 'Content-free critical safety evidence is retained after tenant, user, and run identifiers are irreversibly pseudonymized.',
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
    const compatibilityPlanIds = ownedTrainingCompatibilityPlanIds(db, userId);
    const compatibilityChildCounts = countOwnedTrainingCompatibilityChildren(db, userId);
    const localInferenceCascadeState = ownedLocalInferenceCascadeChildState(db, userId);
    const trainingErasureId = `training-erasure-${randomUUID()}`;
    const hasTrainingErasureGate = tableExistsForDeletion(db, 'training_revision_erasure_authorizations');
    if (hasTrainingErasureGate) {
      db.prepare(`
        INSERT INTO training_revision_erasure_authorizations (
          erasure_id, subject_user_id, reason, expires_at
        ) VALUES (?, ?, 'ACCOUNT_DELETION', datetime('now', '+5 minutes'))
      `).run(trainingErasureId, userId);
    }
    if (tableExistsForDeletion(db, 'local_inference_safety_incidents')) {
      // Preserve security evidence without retaining a subject identifier.
      // The row id produces a non-reversible unique marker, avoiding collisions
      // in the five-minute dedupe index when multiple deleted subjects shared
      // the same incident shape.
      const pseudonymized = db.prepare(`UPDATE local_inference_safety_incidents
        SET tenant_id = NULL, user_id = NULL, run_id = 'erased-subject:' || id
        WHERE tenant_id = ? OR user_id = ?`).run(userId, userId);
      counts.local_inference_safety_incidents_pseudonymized = pseudonymized.changes;
    }
    for (const { table, columns } of ownedTables) {
      const ownership = buildOwnershipPredicate(columns, userId);
      const result = db.prepare(
        `DELETE FROM ${quoteSqlIdentifier(table)} WHERE ${ownership.sql}`,
      ).run(...ownership.params);
      counts[table] = result.changes;
    }
    // The parent-plan deletion cascades through the compatibility graph. Keep
    // the pre-delete child counts in the legal erasure receipt instead of
    // pretending those tables were not part of the operation.
    Object.assign(counts, compatibilityChildCounts);
    Object.assign(counts, localInferenceCascadeState.counts);

    if (compatibilityPlanIds.length > 0) {
      const placeholders = compatibilityPlanIds.map(() => '?').join(', ');
      for (const table of TRAINING_COMPATIBILITY_CHILD_TABLES) {
        if (!tableExistsForDeletion(db, table)) continue;
        const remaining = db.prepare(`
          SELECT COUNT(*) AS count
            FROM ${quoteSqlIdentifier(table)}
           WHERE plan_id IN (${placeholders})
        `).get(...compatibilityPlanIds) as { count: number };
        if (remaining.count !== 0) {
          throw new Error(`Account deletion left compatibility Training rows in ${table}.`);
        }
      }
    }

    assertLocalInferenceCascadeChildrenDeleted(
      db,
      localInferenceCascadeState.parentIdsByChild,
    );

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

    if (tableExistsForDeletion(db, 'api_cache')) {
      const cacheOwnership = accountOwnedApiCachePredicate(userId);
      const cacheResult = db.prepare(`DELETE FROM api_cache WHERE ${cacheOwnership.sql}`)
        .run(...cacheOwnership.params);
      counts.api_cache = cacheResult.changes;
    } else {
      counts.api_cache = 0;
    }

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
    if (countAccountOwnedApiCacheRows(db, userId) !== 0) {
      throw new Error('Account deletion left user-owned API cache rows.');
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
