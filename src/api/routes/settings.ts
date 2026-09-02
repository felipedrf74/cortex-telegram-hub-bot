// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response, type Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { sendSuccess, sendError, sendInternalError } from '../response-helpers';
import { getRuntimeStatus } from '../../services/runtime-status';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { setUserLanguage } from '../../services/user-service';
import { IANAZone } from 'luxon';
import { getDb } from '../../services/database';
import { getPushPreferences, setPushPreference } from '../../services/report-document-store';
import { registerNotificationDeviceToken } from '../../services/notification-orchestrator';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';
import {
  deleteAllUserDataForAccountDeletion,
  exportContentWorkspaceData,
  exportUserInvoiceData,
  exportSkillInferenceData,
  getAccountDeletionInventoryForUser,
} from '../../services/user-data-export';
import { logAudit } from '../../services/audit-trail';
import {
  getProviderPreferences,
  normalizePrimaryCalendarProvider,
  normalizePrimaryMailProvider,
  setProviderPreferences,
} from '../../services/provider-preferences';
import {
  getSecretaryRoutineProfile,
  putSecretaryRoutineProfile,
  SecretaryRoutineProfileError,
  synchronizeCanonicalUserTimezone,
} from '../../services/secretary-routine-profile';
import { invalidatePlanningCaches } from '../../services/cache-coherence-registry';

function normalizeLanguageInput(language: unknown): 'pt-BR' | 'pt-PT' | 'en-US' | null {
  if (typeof language !== 'string') return null;
  const normalized = language.trim().toLowerCase();
  if (!normalized) return null;
  // Settings accepts only the translated product languages. Legacy Spanish
  // locale signals are handled as an English compatibility fallback at chat
  // request boundaries, but cannot be persisted as a preference.
  if (!normalized.startsWith('pt') && !normalized.startsWith('en')) return null;
  const result = normalizeLangHeader(language);
  if (result === 'pt-BR' || result === 'pt-PT' || result === 'en-US') return result;
  return null;
}

function parseExportJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function sendSecretaryRoutineProfileError(res: Response, error: unknown): boolean {
  if (!(error instanceof SecretaryRoutineProfileError)) return false;
  sendError(res, error.code, error.message, error.status, error.details);
  return true;
}

export function settingsRoutes(): Router {
  const router = Router();
  const pushTokenRevokeRateLimitMiddleware = rateLimit({
    windowMs: 60 * 1000,
    limit: config.ios?.rateLimit ?? 60,
    keyGenerator: (req: Request) => {
      const userId = (req as AuthenticatedRequest).userId;
      if (typeof userId === 'number' && userId > 0) return `user:${userId}`;
      return `ip:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || '0.0.0.0')}`;
    },
    // The parent API router still owns the normal per-user rate-limit
    // headers. This narrower limiter makes the database-mutating revoke
    // handler independently safe when the settings router is mounted or
    // tested on its own.
    legacyHeaders: false,
    standardHeaders: false,
    handler: (_req, res, _next, options) => {
      const retryAfter = Math.ceil(options.windowMs / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.status(options.statusCode).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.', retryAfter },
      });
    },
  });

  function ensureValidSettingsUserScope(
    res: Response,
    userId: number | undefined,
    operation: string,
    details?: Record<string, unknown>,
  ): userId is number {
    if (isValidTenantUserId(userId)) return true;
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation,
      reason: 'invalid_user_scope',
      userId: typeof userId === 'number' ? userId : null,
      details,
    });
    sendError(res, 'UNAUTHORIZED', 'Invalid authenticated user scope', 401);
    return false;
  }

  /** GET /api/v1/settings/status */
  router.get('/status', async (_req, res: Response) => {
    try {
      const startTime = (global as any).__startTime;
      const uptimeMs = startTime ? Date.now() - startTime : 0;
      const uptimeStr = uptimeMs > 86400000
        ? `${Math.floor(uptimeMs / 86400000)}d ${Math.floor((uptimeMs % 86400000) / 3600000)}h`
        : `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`;
      const runtime = getRuntimeStatus();

      sendSuccess(res, {
        version: (() => { try { return require('../../../package.json').version; } catch { return '0.0.0'; } })(),
        uptime: uptimeStr,
        serviceStatus: runtime.serviceStatus,
        botStatus: runtime.botStatus,
        databaseStatus: runtime.databaseStatus,
        lastMessageAt: runtime.lastMessageAt,
      });
    } catch (err: any) {
      logger.error({ errorName: safeErrorName(err) }, 'iOS settings status failed');
      sendInternalError(res, 'Unable to load runtime status right now.');
    }
  });

  /**
   * GET /api/v1/settings/connections
   * DEPRECATED — redirects to /api/v1/connections (per-user OAuth).
   * Previously leaked server-level integration state to all users.
   */
  router.get('/connections', async (req, res: Response) => {
    // Redirect to the per-user connections endpoint
    const { userId } = req as any;
    if (!ensureValidSettingsUserScope(res, userId, 'settings_route_connections')) return;
    try {
      const { isConnected, getConnectedProviders } = require('../../services/oauth-store');
      const providers = getConnectedProviders?.(userId) || [];
      const connections = providers.map((p: any) => ({
        name: p.provider,
        status: 'connected',
        lastSync: p.created_at || null,
      }));
      sendSuccess(res, { connections });
    } catch {
      sendSuccess(res, { connections: [] });
    }
  });

  /** GET /api/v1/settings/provider-preferences */
  router.get('/provider-preferences', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    if (!ensureValidSettingsUserScope(res, userId, 'settings_route_provider_preferences_get')) return;
    try {
      sendSuccess(res, getProviderPreferences(userId, tenantId));
    } catch (err: any) {
      logger.error({ errorName: safeErrorName(err), userId, tenantId }, 'iOS provider preferences load failed');
      sendInternalError(res, 'Unable to load provider preferences right now.');
    }
  });

  /** PATCH /api/v1/settings/provider-preferences */
  router.patch('/provider-preferences', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    if (!ensureValidSettingsUserScope(res, userId, 'settings_route_provider_preferences_patch')) return;
    const mail = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'primaryMailProvider')
      ? normalizePrimaryMailProvider(req.body?.primaryMailProvider)
      : undefined;
    const calendar = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'primaryCalendarProvider')
      ? normalizePrimaryCalendarProvider(req.body?.primaryCalendarProvider)
      : undefined;

    if (mail === null) {
      sendError(res, 'VALIDATION', 'primaryMailProvider must be auto, gmail, or outlook', 400);
      return;
    }
    if (calendar === null) {
      sendError(res, 'VALIDATION', 'primaryCalendarProvider must be auto, google, or outlook', 400);
      return;
    }

    try {
      const preferences = setProviderPreferences(userId, tenantId, {
        ...(mail ? { primaryMailProvider: mail } : {}),
        ...(calendar ? { primaryCalendarProvider: calendar } : {}),
      });
      logAudit({
        userId,
        actorId: userId,
        action: 'access',
        resource: 'settings.provider_preferences',
        details: {
          primaryMailProvider: preferences.primaryMailProvider,
          primaryCalendarProvider: preferences.primaryCalendarProvider,
          warningCodes: preferences.warningCodes,
        },
      });
      sendSuccess(res, preferences);
    } catch (err: any) {
      logger.error({ errorName: safeErrorName(err), userId, tenantId }, 'iOS provider preferences update failed');
      sendInternalError(res, 'Unable to save provider preferences right now.');
    }
  });

  /** POST /api/v1/settings/language */
  router.post('/language', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidSettingsUserScope(res, userId, 'settings_route_language')) return;
    const { language } = req.body;
    const normalizedLanguage = normalizeLanguageInput(language);

    if (!normalizedLanguage) {
      sendError(res, 'BAD_REQUEST', 'language must be pt-BR, pt-PT, pt, or en/en-US');
      return;
    }

    try {
      setUserLanguage(userId, normalizedLanguage);
      sendSuccess(res, { language: normalizedLanguage });
    } catch (err: any) {
      logger.error({ errorName: safeErrorName(err) }, 'iOS set language failed');
      sendInternalError(res, 'Unable to save language right now.');
    }
  });

  /**
   * POST /api/v1/settings/timezone — F11 prerequisite (Phase 3).
   *
   * The canonical `users.timezone` write path. The column predates migration
   * 271; that migration documented the missing writer that left Training on
   * the process-global config zone. Only real IANA identifiers are accepted:
   * fixed offsets ("UTC+3") shift with DST and would silently corrupt
   * schedule anchoring, which is the exact defect class F11 exists to fix.
   */
  router.post('/timezone', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    if (!ensureValidSettingsUserScope(res, userId, 'settings_route_timezone')) return;
    const timezone = typeof req.body?.timezone === 'string' ? req.body.timezone.trim() : '';

    if (!timezone || !IANAZone.isValidZone(timezone)) {
      sendError(res, 'BAD_REQUEST', 'timezone must be a valid IANA zone identifier (e.g. Europe/Lisbon)');
      return;
    }

    try {
      // Auth middleware supplies tenantId. The fallback keeps direct route
      // harnesses compatible; the shared writer still enforces equality
      // before resolving the database or executing SQL.
      const result = synchronizeCanonicalUserTimezone(
        { userId, tenantId: tenantId ?? userId },
        timezone,
      );
      if (result.changed) invalidatePlanningCaches(userId);
      sendSuccess(res, { timezone: result.timezone });
    } catch (err: any) {
      if (sendSecretaryRoutineProfileError(res, err)) return;
      logger.error({ errorName: safeErrorName(err) }, 'iOS set timezone failed');
      sendInternalError(res, 'Unable to save timezone right now.');
    }
  });

  /** GET /api/v1/settings/secretary-routine */
  router.get('/secretary-routine', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    if (!ensureValidSettingsUserScope(res, userId, 'settings_route_secretary_routine_get')) return;
    try {
      sendSuccess(res, getSecretaryRoutineProfile({ userId, tenantId }));
    } catch (err: any) {
      if (sendSecretaryRoutineProfileError(res, err)) return;
      logger.error(
        { errorName: safeErrorName(err), userId, tenantId },
        'iOS Secretary routine profile load failed',
      );
      sendInternalError(res, 'Unable to load the Secretary routine profile right now.');
    }
  });

  /** PUT /api/v1/settings/secretary-routine */
  router.put('/secretary-routine', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    if (!ensureValidSettingsUserScope(res, userId, 'settings_route_secretary_routine_put')) return;
    const headerIdempotencyKey = req.header('x-idempotency-key');
    try {
      const result = putSecretaryRoutineProfile(
        { userId, tenantId },
        req.body,
        headerIdempotencyKey,
      );
      if (result.changed) invalidatePlanningCaches(userId);
      sendSuccess(res, result.profile);
    } catch (err: any) {
      if (sendSecretaryRoutineProfileError(res, err)) return;
      logger.error(
        { errorName: safeErrorName(err), userId, tenantId },
        'iOS Secretary routine profile save failed',
      );
      sendInternalError(res, 'Unable to save the Secretary routine profile right now.');
    }
  });

  /** POST /api/v1/settings/push-token */
  router.post('/push-token', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    if (!ensureValidSettingsUserScope(res, userId, 'settings_route_push_token')) return;
    const deviceId = (req as AuthenticatedRequest).deviceId;
    const { token, environment, appVersion } = req.body;

    try {
      if (typeof token !== 'string' || token.trim().length === 0) {
        sendError(res, 'VALIDATION', 'token is required', 400);
        return;
      }
      registerNotificationDeviceToken({
        userId,
        tenantId,
        token: token.trim(),
        deviceId,
        environment: environment === 'production' ? 'production' : 'sandbox',
        appVersion: typeof appVersion === 'string' ? appVersion : null,
      });
      sendSuccess(res, { updated: true });
    } catch (err: any) {
      logger.error({ errorName: safeErrorName(err) }, 'iOS push-token update failed');
      sendInternalError(res, 'Unable to update the push token right now.');
    }
  });

  /** DELETE /api/v1/settings/push-token */
  router.delete('/push-token', pushTokenRevokeRateLimitMiddleware, async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidSettingsUserScope(res, userId, 'settings_route_delete_push_token')) return;
    const deviceId = (req as AuthenticatedRequest).deviceId;

    try {
      const db = getDb();
      db.prepare(`
        UPDATE ios_devices
        SET push_token = NULL, last_active_at = datetime('now')
        WHERE user_id = ? AND device_id = ?
      `).run(userId, deviceId);
      try {
        db.prepare(`
          UPDATE notification_device_tokens
          SET revoked_at = COALESCE(revoked_at, datetime('now'))
          WHERE user_id = ? AND revoked_at IS NULL
        `).run(userId);
      } catch {
        // notification_device_tokens may not exist on older local test DBs.
      }
      res.status(204).send();
    } catch (err: any) {
      logger.error({ errorName: safeErrorName(err) }, 'iOS push-token revoke failed');
      sendInternalError(res, 'Unable to revoke the push token right now.');
    }
  });

  /** POST /api/v1/settings/export — GDPR data export (Article 15: right of access) */
  router.post('/export', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    if (!ensureValidSettingsUserScope(res, userId, 'settings_route_export')) return;
    try {
      const db = getDb();

      // Collect ALL user data — every table that stores user-owned content.
      // This list must stay in sync with the DELETE /account table list.
      const userData: Record<string, any> = {};

      // Helper: collect query failures and fail the export as a whole below.
      // A successful-but-partial privacy archive is not a truthful export.
      const exportErrors: string[] = [];
      const safeAll = (sql: string, ...params: any[]) => {
        try {
          return db.prepare(sql).all(...params);
        } catch (err) {
          const table = /\bFROM\s+([a-zA-Z0-9_]+)/i.exec(sql)?.[1] ?? 'unknown';
          exportErrors.push(table);
          logger.error(
            { errorName: safeErrorName(err), table },
            'GDPR export query failed',
          );
          return [];
        }
      };

      // ── Core data ──
      userData.messages = safeAll(
        'SELECT * FROM messages WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 10000',
        tenantId,
        userId,
      );
      userData.devices = safeAll('SELECT device_id, device_name, created_at, last_active_at FROM ios_devices WHERE user_id = ?', userId);

      // ── Profiles ──
      try {
        const onboarding = require('../../services/onboarding');
        const allQ = onboarding.getAllQuestionnaires?.() || [];
        userData.profiles = allQ.map((q: any) => onboarding.getProfile(userId, q.id)).filter(Boolean);
      } catch { userData.profiles = []; }
      userData.secretaryRoutineProfile = safeAll(`
        SELECT 'configured' AS status,
               profile.version,
               user.timezone,
               profile.working_windows_json AS workingWindows,
               profile.preferred_focus_windows_json AS preferredFocusWindows,
               profile.protected_routines_json AS protectedRoutines,
               profile.created_at AS createdAt,
               profile.updated_at AS updatedAt
          FROM secretary_routine_profiles profile
          JOIN users user ON user.id = profile.user_id
         WHERE profile.user_id = ? AND profile.tenant_id = ?
      `, userId, tenantId).map((row: any) => ({
        ...row,
        workingWindows: parseExportJson(row.workingWindows),
        preferredFocusWindows: parseExportJson(row.preferredFocusWindows),
        protectedRoutines: parseExportJson(row.protectedRoutines),
      }));
      userData.secretaryRoutineIdempotencyReceipts = safeAll(`
        SELECT idempotency_key AS idempotencyKey,
               response_json AS response,
               created_at AS createdAt,
               expires_at AS expiresAt
          FROM secretary_routine_idempotency_receipts
         WHERE user_id = ? AND tenant_id = ?
         ORDER BY created_at
      `, userId, tenantId).map((row: any) => ({
        ...row,
        response: parseExportJson(row.response),
      }));
      userData.secretaryCalendarCommandReceipts = safeAll(`
        SELECT idempotency_key AS idempotencyKey,
               provider_source AS providerSource,
               command_json AS command,
               state,
               response_json AS response,
               created_at AS createdAt,
               updated_at AS updatedAt,
               expires_at AS expiresAt
          FROM secretary_calendar_command_receipts
         WHERE user_id = ? AND tenant_id = ?
         ORDER BY created_at
      `, userId, String(tenantId)).map((row: any) => ({
        ...row,
        command: parseExportJson(row.command),
        response: parseExportJson(row.response),
      }));
      userData.secretaryCalendarCommandPayloads = safeAll(`
        SELECT agenda_item_id AS agendaItemId,
               command_json AS command,
               created_at AS createdAt,
               updated_at AS updatedAt
          FROM secretary_calendar_command_payloads
         WHERE user_id = ? AND tenant_id = ?
         ORDER BY created_at
      `, userId, String(tenantId)).map((row: any) => ({
        ...row,
        command: parseExportJson(row.command),
      }));
      userData.secretaryCalendarMutationReceipts = safeAll(`
        SELECT idempotency_key AS idempotencyKey,
               operation,
               provider_source AS providerSource,
               command_json AS command,
               state,
               response_json AS response,
               created_at AS createdAt,
               updated_at AS updatedAt,
               expires_at AS expiresAt
          FROM secretary_calendar_mutation_receipts
         WHERE user_id = ? AND tenant_id = ?
         ORDER BY created_at
      `, userId, String(tenantId)).map((row: any) => ({
        ...row,
        command: parseExportJson(row.command),
        response: parseExportJson(row.response),
      }));
      userData.reportDocumentDispatchReceipts = safeAll(`
        SELECT report_type AS reportType,
               dispatch_key AS dispatchKey,
               report_document_id AS reportDocumentId,
               created_at AS createdAt
          FROM report_document_dispatch_receipts
         WHERE user_id = ? AND tenant_id = ?
         ORDER BY created_at, report_document_id
      `, userId, tenantId);
      userData.scheduledReportCompletionReceipts = safeAll(`
        SELECT job_id AS jobId,
               report_job AS reportJob,
               local_date AS localDate,
               attempts,
               completed_at AS completedAt,
               created_at AS createdAt
          FROM scheduled_report_completion_receipts
         WHERE user_id = ? AND tenant_id = ?
         ORDER BY local_date, report_job
      `, userId, tenantId);
      userData.planningRecomputeReceipts = safeAll(`
        SELECT idempotency_key_hash AS idempotencyKeyHash,
               request_fingerprint AS requestFingerprint,
               status,
               snapshot_id AS snapshotId,
               response_json AS response,
               last_error_code AS lastErrorCode,
               created_at AS createdAt,
               updated_at AS updatedAt
          FROM planning_recompute_receipts
         WHERE user_id = ? AND tenant_id = ?
         ORDER BY created_at
      `, userId, tenantId).map((row: any) => ({
        ...row,
        response: parseExportJson(row.response),
      }));
      // Report leases share a system table. Secretary report scopes encode the
      // authenticated tenant and user, so export only matching report:* rows
      // and never disclose the live lease owner, token, or expiry.
      userData.reportScheduleExecutionState = safeAll(`
        SELECT job_name AS jobName,
               scope_key AS scopeKey,
               last_started_at AS lastStartedAt,
               last_completed_at AS lastCompletedAt,
               last_succeeded_at AS lastSucceededAt,
               last_result AS lastResult,
               updated_at AS updatedAt
          FROM scheduled_job_execution_state
         WHERE job_name LIKE 'report:%'
           AND scope_key LIKE ?
         ORDER BY job_name, scope_key
      `, `tenant:${tenantId}:user:${userId}:local-date:%`);

      // ── Content workspace ──
      // The canonical export discovers every schema-present Content table with
      // user_id and/or owner_user_id. The legacy arrays remain additive aliases
      // for existing consumers, but are sourced from the same scoped archive.
      const contentWorkspace = exportContentWorkspaceData(userId, tenantId);
      const contentRecords = (
        table: string,
        descendingField?: string,
      ): Array<Record<string, unknown>> => {
        const records = [...(contentWorkspace.tables.find((entry) => entry.name === table)?.records ?? [])];
        if (!descendingField) return records;
        return records.sort((left, right) => String(right[descendingField] ?? '')
          .localeCompare(String(left[descendingField] ?? '')));
      };
      userData.contentWorkspace = contentWorkspace;
      if (contentWorkspace.warnings.length > 0) {
        userData.degraded = true;
        userData.warnings = contentWorkspace.warnings;
      }
      userData.skillInference = exportSkillInferenceData(userId, tenantId);
      userData.contentScripts = contentRecords('content_scripts', 'created_at');
      userData.contentPerformance = contentRecords('content_performance', 'logged_at');
      userData.contentLearnedPatterns = contentRecords('content_learned_patterns');
      userData.contentPipeline = contentRecords('content_pipeline', 'created_at');
      userData.contentTopicFeedback = contentRecords('content_topic_feedback', 'created_at');
      userData.contentTopics = contentRecords('content_topics', 'created_at');
      userData.contentKnowledge = contentRecords('content_knowledge');
      userData.contentRefChannels = contentRecords('content_ref_channels');
      userData.bookLibrary = contentRecords('book_library');
      userData.savedIdeas = contentRecords('saved_ideas');

      // ── Reports & notifications ──
      userData.reportDocuments = safeAll(
        'SELECT * FROM report_documents_scoped WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC',
        tenantId,
        userId,
      );
      userData.pushPreferences = safeAll('SELECT * FROM push_preferences WHERE user_id = ?', userId);
      userData.contentNotifications = contentRecords('content_notifications', 'created_at');

      // ── Tasks & reminders ──
      userData.nativeTasks = safeAll('SELECT * FROM native_tasks WHERE user_id = ?', userId);
      userData.nativeTaskLists = safeAll('SELECT * FROM native_task_lists WHERE user_id = ?', userId);
      userData.reminders = safeAll('SELECT * FROM reminders WHERE user_id = ?', userId);

      // ── Health & training ──
      userData.appleHealthData = safeAll('SELECT * FROM apple_health_data WHERE user_id = ? ORDER BY date DESC LIMIT 365', userId);
      userData.readinessScores = safeAll('SELECT * FROM readiness_scores WHERE user_id = ? ORDER BY date DESC LIMIT 365', userId);
      userData.trainingCompletions = safeAll(`
        SELECT completion.*
        FROM training_completions completion
        INNER JOIN fitness_training_plans plan ON plan.id = completion.plan_id
        WHERE (plan.tenant_id = ? OR plan.tenant_id IS NULL) AND plan.user_id = ?
        ORDER BY completion.completed_at DESC
      `, tenantId, userId);
      userData.fitnessTrainingPlans = safeAll('SELECT * FROM fitness_training_plans WHERE user_id = ?', userId);
      userData.productLearningCases = safeAll(`
        SELECT case_id AS caseId, tenant_id AS tenantId, user_id AS userId,
               owner, lifecycle, privacy_class AS privacyClass,
               redacted_input_json AS redactedInput,
               expected_contract_json AS expectedContract,
               evidence_references_json AS evidenceReferences,
               producer_version AS producerVersion, confidence,
               observed_at AS observedAt, reviewed_at AS reviewedAt,
               reviewed_by AS reviewedBy,
               review_approval_reference AS reviewApprovalReference,
               expires_at AS expiresAt
          FROM product_learning_cases
         WHERE tenant_id = ? AND user_id = ?
         ORDER BY observed_at, case_id
      `, tenantId, userId).map((row: any) => ({
        ...row,
        redactedInput: parseExportJson(row.redactedInput),
        expectedContract: parseExportJson(row.expectedContract),
        evidenceReferences: parseExportJson(row.evidenceReferences),
      }));
      userData.productLearningCaseTransitions = safeAll(`
        SELECT transition_id AS transitionId, tenant_id AS tenantId,
               user_id AS userId, case_id AS caseId,
               from_lifecycle AS fromLifecycle, to_lifecycle AS toLifecycle,
               actor, approval_reference AS approvalReference,
               transitioned_at AS transitionedAt
          FROM product_learning_case_transitions
         WHERE tenant_id = ? AND user_id = ?
         ORDER BY transitioned_at, transition_id
      `, tenantId, userId);
      userData.productLearningCaseReviewApprovals = safeAll(`
        SELECT approval_reference AS approvalReference, tenant_id AS tenantId,
               user_id AS userId, case_id AS caseId,
               action_execution_id AS actionExecutionId,
               decision_id AS decisionId, action_id AS actionId,
               reviewed_by AS reviewedBy, reviewed_at AS reviewedAt,
               created_at AS createdAt
          FROM product_learning_case_review_approvals
         WHERE tenant_id = ? AND user_id = ?
         ORDER BY reviewed_at, approval_reference
      `, tenantId, userId);

      // ── Finance ──
      userData.financeTransactions = safeAll('SELECT * FROM finance_transactions WHERE user_id = ? ORDER BY date DESC', userId);
      userData.invoices = exportUserInvoiceData(userId, { failClosed: true });
      // Additive legacy alias retained without exposing raw storage locators.
      userData.invoiceFilings = userData.invoices.filings;

      // ── Subscription ──
      userData.subscriptions = safeAll('SELECT * FROM subscriptions WHERE user_id = ?', userId);

      // ── OAuth tokens (redacted) ──
      userData.oauthConnections = safeAll(
        'SELECT provider, created_at FROM user_oauth_tokens WHERE user_id = ?', userId
      );

      if (exportErrors.length > 0) {
        throw new Error(`GDPR export incomplete for tables: ${[...new Set(exportErrors)].sort().join(', ')}`);
      }
      userData.exportedAt = new Date().toISOString();
      userData.userId = userId;
      userData._systemNotes = {
        sharedSeedData: 'Tables content_ref_channels, book_library, content_knowledge, and content_learned_patterns may contain explicit system-owned rows (owner_scope=system) that serve as shared reference data (e.g., default books, seed channels). These rows are not user-generated and are excluded from this export.',
      };

      const tableCounts = Object.fromEntries(
        Object.entries(userData)
          .filter(([, value]) => Array.isArray(value))
          .map(([key, value]) => [key, (value as unknown[]).length]),
      );
      logAudit({
        userId,
        tenantId,
        actorId: userId,
        action: 'export',
        resource: 'account',
        details: {
          tableCounts,
          contentWorkspaceTableCounts: Object.fromEntries(
            contentWorkspace.tables.map((table) => [table.name, table.records.length]),
          ),
          exportErrors: [],
          exportWarnings: contentWorkspace.warnings.map((warning) => warning.code),
        },
        ipAddress: req.ip,
      });

      sendSuccess(res, userData);
    } catch (err: any) {
      logger.error({ errorName: safeErrorName(err) }, 'iOS data export failed');
      sendInternalError(res, 'Unable to export account data right now.');
    }
  });

  /** DELETE /api/v1/settings/account — GDPR account deletion */
  router.delete('/account', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidSettingsUserScope(res, userId, 'settings_route_delete_account')) return;
    try {
      const deletionInventory = getAccountDeletionInventoryForUser(userId);
      const tableCounts = await deleteAllUserDataForAccountDeletion(userId);
      logAudit({
        userId,
        actorId: userId,
        action: 'delete',
        resource: 'account',
        details: { tableCounts, deletionInventory },
        ipAddress: req.ip,
      });

      logger.info({ userId, platform: 'ios' }, 'Account deleted (GDPR Article 17)');
      // `deleted` and `message` are unchanged for existing clients. The
      // notice is additive: deleting the account destroys the local
      // `subscriptions` row but does NOT cancel a store-managed
      // subscription, which keeps billing until the user cancels it in the
      // store. The code lets a client localize; the message is the fallback
      // for clients that don't.
      sendSuccess(res, {
        deleted: true,
        message: 'All data has been permanently deleted.',
        subscriptionNotice: {
          code: 'STORE_SUBSCRIPTION_NOT_CANCELLED',
          message: 'Deleting your account does not cancel a subscription purchased through the App Store. '
            + 'Cancel it in Settings > your Apple Account > Subscriptions to stop future billing.',
          managementUrl: 'https://apps.apple.com/account/subscriptions',
        },
      });
    } catch (err: any) {
      if (err?.code === 'ACCOUNT_DELETION_IN_PROGRESS') {
        sendError(
          res,
          'ACCOUNT_DELETION_IN_PROGRESS',
          'Account deletion is already in progress.',
          409,
        );
        return;
      }
      if (err?.code === 'ACCOUNT_DELETION_INFERENCE_DRAIN_TIMEOUT') {
        sendError(
          res,
          'ACCOUNT_DELETION_INFERENCE_DRAIN_TIMEOUT',
          'Active model work is still stopping. Retry account deletion shortly.',
          503,
          { retryable: true },
        );
        return;
      }
      logger.error({ errorName: safeErrorName(err) }, 'iOS account deletion failed');
      sendInternalError(res, 'Unable to delete the account right now.');
    }
  });

  // ── Push Preferences (server-enforced) ───────────────────────────

  /**
   * GET /api/v1/settings/push-preferences
   *
   * Get all push notification category preferences for the user.
   * Returns default-enabled for categories without explicit preference.
   */
  router.get('/push-preferences', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthenticatedRequest;
      if (!ensureValidSettingsUserScope(res, userId, 'settings_route_get_push_preferences')) return;
      const prefs = getPushPreferences(userId);
      sendSuccess(res, { preferences: prefs });
    } catch (err: any) {
      logger.error({ errorName: safeErrorName(err) }, 'iOS push preferences load failed');
      sendInternalError(res, 'Unable to load push preferences right now.');
    }
  });

  /**
   * PUT|POST /api/v1/settings/push-preferences
   *
   * Toggle a push notification category for the user.
   * Body: { category: string, enabled: boolean }
   */
  // Accept both PUT (REST convention) and POST (iOS NexusHTTPClient compat)
  const pushPrefHandler = async (req: any, res: Response) => {
    try {
      const { userId } = req as unknown as AuthenticatedRequest;
      if (!ensureValidSettingsUserScope(res, userId, 'settings_route_set_push_preferences')) return;
      const { category, enabled } = req.body || {};

      if (!category || typeof enabled !== 'boolean') {
        sendError(res, 'VALIDATION', 'category (string) and enabled (boolean) are required', 400);
        return;
      }

      setPushPreference(userId, category, enabled);
      sendSuccess(res, { category, enabled });
    } catch (err: any) {
      logger.error({ errorName: safeErrorName(err) }, 'iOS push preferences save failed');
      sendInternalError(res, 'Unable to save push preferences right now.');
    }
  };
  router.put('/push-preferences', pushPrefHandler);
  router.post('/push-preferences', pushPrefHandler);

  return router;
}
