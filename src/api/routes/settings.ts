// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { sendSuccess, sendError, sendInternalError } from '../response-helpers';
import { getRuntimeStatus } from '../../services/runtime-status';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { setUserLanguage } from '../../services/user-service';
import { getDb } from '../../services/database';
import { getPushPreferences, setPushPreference } from '../../services/report-document-store';
import { registerNotificationDeviceToken } from '../../services/notification-orchestrator';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';
import { deleteAllUserDataForAccountDeletion } from '../../services/user-data-export';
import { logAudit } from '../../services/audit-trail';

function normalizeLanguageInput(language: unknown): 'pt-BR' | 'pt-PT' | 'en-US' | null {
  if (typeof language !== 'string') return null;
  const normalized = language.trim().toLowerCase();
  if (!normalized) return null;
  // Phase 16 batch 80 (2026-05-16): settings endpoint only accepts the three
  // fully-translated app languages. `normalizeLangHeader` now also returns
  // 'es-ES' for `Accept-Language: es-*` on the chat surface, but the user
  // settings page does not yet expose Spanish as a selectable preference.
  if (!normalized.startsWith('pt') && !normalized.startsWith('en')) return null;
  const result = normalizeLangHeader(language);
  if (result === 'pt-BR' || result === 'pt-PT' || result === 'en-US') return result;
  return null;
}

export function settingsRoutes(): Router {
  const router = Router();

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
      logger.error({ err }, 'iOS settings status failed');
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
      logger.error({ err }, 'iOS set language failed');
      sendInternalError(res, 'Unable to save language right now.');
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
      logger.error({ err }, 'iOS push-token update failed');
      sendInternalError(res, 'Unable to update the push token right now.');
    }
  });

  /** DELETE /api/v1/settings/push-token */
  router.delete('/push-token', async (req, res: Response) => {
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
      logger.error({ err }, 'iOS push-token revoke failed');
      sendInternalError(res, 'Unable to revoke the push token right now.');
    }
  });

  /** POST /api/v1/settings/export — GDPR data export (Article 15: right of access) */
  router.post('/export', async (req, res: Response) => {
    const { userId, tenantId = userId } = req as AuthenticatedRequest;
    if (!ensureValidSettingsUserScope(res, userId, 'settings_route_export')) return;
    try {
      const db = getDb();

      // Collect ALL user data — every table that stores user-owned content.
      // This list must stay in sync with the DELETE /account table list.
      const userData: Record<string, any> = {};

      // Helper: safe query that returns [] if table doesn't exist, and surfaces
      // real export gaps instead of silently returning an incomplete archive.
      const exportErrors: string[] = [];
      const safeAll = (sql: string, ...params: any[]) => {
        try {
          return db.prepare(sql).all(...params);
        } catch (err) {
          const table = /\bFROM\s+([a-zA-Z0-9_]+)/i.exec(sql)?.[1] ?? 'unknown';
          exportErrors.push(table);
          logger.error(
            { err, table, sql: sql.slice(0, 80) },
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

      // ── Content (learning store) ──
      userData.contentScripts = safeAll('SELECT * FROM content_scripts WHERE user_id = ? ORDER BY created_at DESC', userId);
      userData.contentPerformance = safeAll('SELECT * FROM content_performance WHERE user_id = ? ORDER BY logged_at DESC', userId);
      userData.contentLearnedPatterns = safeAll('SELECT * FROM content_learned_patterns WHERE user_id = ?', userId);
      userData.contentPipeline = safeAll('SELECT * FROM content_pipeline WHERE user_id = ? ORDER BY created_at DESC', userId);
      userData.contentTopicFeedback = safeAll('SELECT * FROM content_topic_feedback WHERE user_id = ? ORDER BY created_at DESC', userId);
      userData.contentTopics = safeAll('SELECT * FROM content_topics WHERE user_id = ? ORDER BY created_at DESC', userId);
      userData.contentKnowledge = safeAll('SELECT * FROM content_knowledge WHERE user_id = ?', userId);
      userData.contentRefChannels = safeAll('SELECT * FROM content_ref_channels WHERE user_id = ?', userId);
      userData.bookLibrary = safeAll('SELECT * FROM book_library WHERE user_id = ?', userId);

      // ── Reports & notifications ──
      userData.reportDocuments = safeAll('SELECT * FROM report_documents WHERE user_id = ? ORDER BY created_at DESC', userId);
      userData.pushPreferences = safeAll('SELECT * FROM push_preferences WHERE user_id = ?', userId);
      userData.contentNotifications = safeAll('SELECT * FROM content_notifications WHERE user_id = ? ORDER BY created_at DESC', userId);

      // ── Tasks & reminders ──
      userData.nativeTasks = safeAll('SELECT * FROM native_tasks WHERE user_id = ?', userId);
      userData.nativeTaskLists = safeAll('SELECT * FROM native_task_lists WHERE user_id = ?', userId);
      userData.reminders = safeAll('SELECT * FROM reminders WHERE user_id = ?', userId);

      // ── Health & training ──
      userData.appleHealthData = safeAll('SELECT * FROM apple_health_data WHERE user_id = ? ORDER BY date DESC LIMIT 365', userId);
      userData.readinessScores = safeAll('SELECT * FROM readiness_scores WHERE user_id = ? ORDER BY date DESC LIMIT 365', userId);
      userData.trainingCompletions = safeAll('SELECT * FROM training_completions WHERE user_id = ?', userId);
      userData.fitnessTrainingPlans = safeAll('SELECT * FROM fitness_training_plans WHERE user_id = ?', userId);

      // ── Finance ──
      userData.financeTransactions = safeAll('SELECT * FROM finance_transactions WHERE user_id = ? ORDER BY date DESC', userId);
      userData.invoiceFilings = safeAll('SELECT * FROM invoice_filings WHERE user_id = ? ORDER BY created_at DESC', userId);

      // ── Subscription ──
      userData.subscriptions = safeAll('SELECT * FROM subscriptions WHERE user_id = ?', userId);

      // ── OAuth tokens (redacted) ──
      userData.oauthConnections = safeAll(
        'SELECT provider, created_at FROM user_oauth_tokens WHERE user_id = ?', userId
      );

      userData.exportedAt = new Date().toISOString();
      userData.userId = userId;
      if (exportErrors.length > 0) {
        userData._exportErrors = [...new Set(exportErrors)];
      }
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
        details: { tableCounts, exportErrors: [...new Set(exportErrors)] },
        ipAddress: req.ip,
      });

      sendSuccess(res, userData);
    } catch (err: any) {
      logger.error({ err }, 'iOS data export failed');
      sendInternalError(res, 'Unable to export account data right now.');
    }
  });

  /** DELETE /api/v1/settings/account — GDPR account deletion */
  router.delete('/account', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidSettingsUserScope(res, userId, 'settings_route_delete_account')) return;
    try {
      const tableCounts = await deleteAllUserDataForAccountDeletion(userId);
      logAudit({
        userId,
        actorId: userId,
        action: 'delete',
        resource: 'account',
        details: { tableCounts },
        ipAddress: req.ip,
      });

      logger.info({ userId, platform: 'ios' }, 'Account deleted (GDPR Article 17)');
      sendSuccess(res, { deleted: true, message: 'All data has been permanently deleted.' });
    } catch (err: any) {
      logger.error({ err }, 'iOS account deletion failed');
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
      logger.error({ err }, 'iOS push preferences load failed');
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
      logger.error({ err }, 'iOS push preferences save failed');
      sendInternalError(res, 'Unable to save push preferences right now.');
    }
  };
  router.put('/push-preferences', pushPrefHandler);
  router.post('/push-preferences', pushPrefHandler);

  return router;
}
