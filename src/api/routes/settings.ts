// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { sendSuccess, sendError } from '../response-helpers';
import { getRuntimeStatus } from '../../services/runtime-status';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { setUserLanguage } from '../../services/user-service';

function normalizeLanguageInput(language: unknown): 'pt-BR' | 'pt-PT' | 'en-US' | null {
  if (typeof language !== 'string') return null;
  const normalized = language.trim().toLowerCase();
  if (!normalized) return null;
  if (!normalized.startsWith('pt') && !normalized.startsWith('en')) return null;
  return normalizeLangHeader(language);
}

export function settingsRoutes(): Router {
  const router = Router();

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
      sendError(res, 'INTERNAL', err?.message || 'Status fetch failed', 500);
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
    return;

    // Dead code below — kept for reference, never reached
    try {
      const connections: { name: string; status: string; lastSync: string | null }[] = [];
      try {
        const { isOutlookTodoConfigured } = require('../../services/microsoft-todo');
        connections.push({
          name: 'Microsoft To Do',
          status: isOutlookTodoConfigured() ? 'connected' : 'disconnected',
          lastSync: null,
        });
      } catch { connections.push({ name: 'Microsoft To Do', status: 'unavailable', lastSync: null }); }

      try {
        const { isGarminConfigured } = require('../../services/garmin');
        connections.push({
          name: 'Garmin Connect',
          status: isGarminConfigured() ? 'connected' : 'disconnected',
          lastSync: null,
        });
      } catch { connections.push({ name: 'Garmin Connect', status: 'unavailable', lastSync: null }); }

      sendSuccess(res, { connections });
    } catch (err: any) {
      sendError(res, 'INTERNAL', err?.message || 'Connections fetch failed', 500);
    }
  });

  /** POST /api/v1/settings/language */
  router.post('/language', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
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
      sendError(res, 'INTERNAL', err?.message || 'Failed to set language', 500);
    }
  });

  /** POST /api/v1/settings/push-token */
  router.post('/push-token', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const deviceId = (req as AuthenticatedRequest).deviceId;
    const { token } = req.body;

    try {
      const db = require('../../services/database').getDb();
      db.prepare('UPDATE ios_devices SET push_token = ? WHERE user_id = ? AND device_id = ?')
        .run(token, userId, deviceId);
      sendSuccess(res, { updated: true });
    } catch (err: any) {
      logger.error({ err }, 'iOS push-token update failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to update push token', 500);
    }
  });

  /** POST /api/v1/settings/export — GDPR data export (Article 15: right of access) */
  router.post('/export', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const db = require('../../services/database').getDb();

      // Collect ALL user data — every table that stores user-owned content.
      // This list must stay in sync with the DELETE /account table list.
      const userData: Record<string, any> = {};

      // Helper: safe query that returns [] if table doesn't exist
      const safeAll = (sql: string, ...params: any[]) => {
        try { return db.prepare(sql).all(...params); } catch { return []; }
      };

      // ── Core data ──
      userData.messages = safeAll('SELECT * FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 10000', userId);
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
      userData._systemNotes = {
        sharedSeedData: 'Tables content_ref_channels, book_library, content_knowledge, and content_learned_patterns may contain system-owned rows (user_id=0) that serve as shared reference data (e.g., default books, seed channels). These rows are not user-generated and are excluded from this export.',
      };

      sendSuccess(res, userData);
    } catch (err: any) {
      logger.error({ err }, 'iOS data export failed');
      sendError(res, 'INTERNAL', err?.message || 'Data export failed', 500);
    }
  });

  /** DELETE /api/v1/settings/account — GDPR account deletion */
  router.delete('/account', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const db = require('../../services/database').getDb();

      // Delete ALL user data from every user-facing table.
      // This list must stay in sync with migrations that add user_id columns.
      // Last audited: April 2026 (added content learning store + reports tables).
      const tables = [
        // ── Core ──
        'ios_devices', 'messages', 'onboarding_sessions', 'user_profiles',
        'conversations', 'todos', 'notes', 'reminders', 'shared_memory',
        // ── Content (learning store + pipeline) ──
        'saved_ideas', 'content_topic_feedback', 'content_ref_channels',
        'content_knowledge', 'content_patterns', 'content_research_briefs',
        'content_scripts', 'content_performance', 'content_learned_patterns',
        'content_pipeline', 'content_topics', 'content_notifications',
        'book_library', 'video_transcripts', 'video_studies',
        // ── Reports & notifications ──
        'report_documents', 'push_preferences',
        // ── Finance ──
        'invoice_filings', 'invoice_vendors', 'invoice_queue',
        'finance_transactions', 'finance_tax_events',
        // ── Cooking ──
        'recipes', 'meal_plans', 'shopping_lists',
        // ── Training & health ──
        'fitness_training_plans', 'training_completions',
        'native_tasks', 'native_task_lists',
        'apple_health_data', 'readiness_scores',
        // ── Integrations ──
        'webhook_subscriptions', 'webhook_events',
        'user_oauth_tokens', 'garmin_user_tokens',
        // ── Auth & billing ──
        'email_verification_codes', 'subscriptions',
        // ── Telemetry (user-scoped) ──
        'api_usage', 'audit_trail', 'client_errors',
        'user_skill_overrides',
      ];
      for (const table of tables) {
        try {
          db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
        } catch { /* table may not exist or no user_id column */ }
      }
      // Also delete the user row itself
      try { db.prepare('DELETE FROM users WHERE id = ?').run(userId); } catch {}

      logger.info({ userId, platform: 'ios' }, 'Account deleted (GDPR Article 17)');
      sendSuccess(res, { deleted: true, message: 'All data has been permanently deleted.' });
    } catch (err: any) {
      logger.error({ err }, 'iOS account deletion failed');
      sendError(res, 'INTERNAL', err?.message || 'Account deletion failed', 500);
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
      const { getPushPreferences } = require('../../services/report-document-store');
      const prefs = getPushPreferences(userId);
      sendSuccess(res, { preferences: prefs });
    } catch (err: any) {
      sendError(res, 'INTERNAL', err?.message || 'Failed to load preferences', 500);
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
      const { category, enabled } = req.body || {};

      if (!category || typeof enabled !== 'boolean') {
        sendError(res, 'VALIDATION', 'category (string) and enabled (boolean) are required', 400);
        return;
      }

      const { setPushPreference } = require('../../services/report-document-store');
      setPushPreference(userId, category, enabled);
      sendSuccess(res, { category, enabled });
    } catch (err: any) {
      sendError(res, 'INTERNAL', err?.message || 'Failed to save preference', 500);
    }
  };
  router.put('/push-preferences', pushPrefHandler);
  router.post('/push-preferences', pushPrefHandler);

  return router;
}
