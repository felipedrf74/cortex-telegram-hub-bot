// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express, { NextFunction, Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import { listUsers, setUserStatusById } from '../services/user-service';
import { logPortalAdminMutation } from './admin-audit';
import { requireOperatorTargetUser } from './admin-target-user';
import { sendPortalInternalError } from './http';
import {
  clearUserAiBudgetOverride,
  getActiveUserAiBudgetOverride,
  setUserAiBudgetOverride,
} from '../services/ai-budget-overrides';
import { getDailyQuotaStatus } from '../services/cost-guardrail';
import {
  createNexusPointsCheckoutSession,
  isStripeNexusPointsIdempotencyConflictError,
  isStripeNexusPointsConfigured,
} from '../services/stripe-nexus-points-service';
import { isNexusPointProductId, listNexusPointPackages } from '../services/nexus-points';
import { getPortalAuthContext } from '../api/secret-guards';
import { getEffectiveEntitlement } from '../services/entitlement';

const VALID_TIERS = new Set(['free', 'pro', 'max', 'owner']);
const STRIPE_NEXUS_POINTS_PORTAL_NOTE_MAX_LENGTH = 280;
const STRIPE_NEXUS_POINTS_PORTAL_BODY_LIMIT_BYTES = 8 * 1024;

function parsePositiveUserId(value: unknown): number | null {
  const userId = Number(value);
  return Number.isFinite(userId) && userId > 0 ? userId : null;
}

function nonNegNumOrUndef(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function hasOwn(obj: unknown, key: string): boolean {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

function sanitizePortalCheckoutNote(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, STRIPE_NEXUS_POINTS_PORTAL_NOTE_MAX_LENGTH);
}

function rejectOversizedPortalStripeCheckoutBody(req: Request, res: Response, next: NextFunction): void {
  const rawLength = req.headers['content-length'];
  const contentLength = Array.isArray(rawLength) ? Number(rawLength[0]) : Number(rawLength || 0);
  if (Number.isFinite(contentLength) && contentLength > STRIPE_NEXUS_POINTS_PORTAL_BODY_LIMIT_BYTES) {
    res.status(413).json({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
    return;
  }
  next();
}

export function registerPortalUserRoutes(app: express.Express): void {
  app.get('/api/users', (_req: Request, res: Response) => {
    try {
      res.json({ users: listUsers() });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/users/:userId/ai-budget', requirePortalAdminToken, requireOperatorTargetUser('userId'), (req: Request, res: Response) => {
    try {
      const userId = parsePositiveUserId(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }

      const quota = getDailyQuotaStatus(userId, { requestSource: 'interactive' });
      const override = getActiveUserAiBudgetOverride(userId);
      let recentDeferrals: Array<Record<string, unknown>> = [];
      try {
        recentDeferrals = getDb().prepare(`
          SELECT request_source AS requestSource,
                 job_name AS jobName,
                 base_category AS baseCategory,
                 run_id AS runId,
                 code,
                 budget_window AS window,
                 reset_at AS resetAt,
                 created_at AS createdAt
          FROM ai_budget_deferrals
          WHERE user_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 20
        `).all(userId) as Array<Record<string, unknown>>;
      } catch {
        // During an additive rollout an older DB may not have migration 226.
        recentDeferrals = [];
      }

      const entitlement = quota.entitlement;
      res.json({
        ok: true,
        userId,
        entitlement: {
          plan: quota.plan,
          source: entitlement?.source ?? 'error',
          status: entitlement?.status ?? 'none',
          aiAccessAllowed: quota.aiAccessAllowed,
          automationAllowed: quota.automationAllowed,
          nexusPointsAllowed: entitlement?.nexusPointsAllowed ?? false,
          blockReason: quota.blockReason,
          automationBlockReason: entitlement?.automationBlockReason ?? null,
          billingPeriodStart: entitlement?.billingPeriodStart ?? null,
          billingPeriodEnd: entitlement?.billingPeriodEnd ?? null,
        },
        effective: {
          dailyCostUsd: quota.capUsd,
          monthlyCostUsd: quota.monthlyCapUsd,
          automationDailyCostUsd: quota.automationDailyCapUsd,
          automationMonthlyCostUsd: quota.automationMonthlyCapUsd,
        },
        usage: {
          dailyCostUsd: quota.spentUsd,
          monthlyCostUsd: quota.monthlySpentUsd,
          dailyFraction: quota.dailyUsageFraction,
          monthlyFraction: quota.monthlyUsageFraction,
          dailyOverLimit: quota.dailyOver,
          monthlyOverLimit: quota.monthlyOver,
          automationDailyCostUsd: quota.automationSpentTodayUsd,
          automationMonthlyCostUsd: quota.automationSpentMonthlyUsd,
          automationDailyFraction: quota.automationDailyCapUsd > 0
            ? Math.min(quota.automationSpentTodayUsd / quota.automationDailyCapUsd, 1)
            : 0,
          automationMonthlyFraction: quota.automationMonthlyCapUsd > 0
            ? Math.min(quota.automationSpentMonthlyUsd / quota.automationMonthlyCapUsd, 1)
            : 0,
        },
        resets: {
          dailyAt: quota.dailyResetAt,
          monthlyAt: quota.monthlyResetAt,
          unblocksAt: quota.unblocksAt,
        },
        override,
        recentDeferrals,
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to load AI budget', 'Portal: user AI budget failed');
    }
  });

  app.get('/api/billing/nexus-points/packages', requirePortalAdminToken, (_req: Request, res: Response) => {
    res.json({
      ok: true,
      packages: listNexusPointPackages(),
      stripeEnabled: isStripeNexusPointsConfigured(),
    });
  });

  app.post('/api/users/:userId/billing/nexus-points/stripe-checkout', requirePortalAdminToken, requireOperatorTargetUser('userId'), rejectOversizedPortalStripeCheckoutBody, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
    try {
      if (!isStripeNexusPointsConfigured()) {
        res.status(503).json({ ok: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe Nexus Points checkout is not configured' } });
        return;
      }
      const userId = parsePositiveUserId(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }
      const packageId = String(req.body?.packageId ?? '').trim();
      if (!isNexusPointProductId(packageId)) {
        res.status(400).json({ ok: false, error: { code: 'BAD_PACKAGE', message: 'packageId must be a known Nexus Points package' } });
        return;
      }
      const note = sanitizePortalCheckoutNote(req.body?.note);
      if (!note) {
        res.status(400).json({ ok: false, error: { code: 'NOTE_REQUIRED', message: 'note is required for portal-created Stripe checkout sessions' } });
        return;
      }
      const entitlement = getEffectiveEntitlement(userId);
      if (!entitlement.nexusPointsAllowed) {
        res.status(403).json({
          ok: false,
          error: {
            code: 'AI_PLAN_REQUIRED',
            message: 'Nexus Points are available only with an active paid or founder entitlement.',
          },
        });
        return;
      }
      const auth = getPortalAuthContext(req);
      const actor = auth?.actorHint || auth?.matchedCredential || 'portal-admin';
      let session;
      try {
        session = await createNexusPointsCheckoutSession({
          userId,
          tenantId: userId,
          packageId,
          source: 'portal',
          note,
          actor,
        });
      } catch (err) {
        if (isStripeNexusPointsIdempotencyConflictError(err)) {
          res.status(409).json({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT', message: err.message } });
          return;
        }
        throw err;
      }
      logPortalAdminMutation(req, userId, 'billing.nexus_points.stripe_checkout', {
        packageId,
        note,
        sessionId: session.sessionId,
      });
      res.json({ ok: true, ...session });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to create Stripe Nexus Points checkout', 'Portal: Stripe Nexus Points checkout failed');
    }
  });

  app.post('/api/users/:userId/suspend', requirePortalAdminToken, requireOperatorTargetUser('userId'), (req: Request, res: Response) => {
    try {
      const userId = parsePositiveUserId(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }

      setUserStatusById(userId, 'suspended');
      logPortalAdminMutation(req, userId, 'user.status', { status: 'suspended' });
      res.json({ ok: true, message: 'User suspended' });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to suspend user', 'Portal: suspend user failed');
    }
  });

  app.post('/api/users/:userId/activate', requirePortalAdminToken, requireOperatorTargetUser('userId'), (req: Request, res: Response) => {
    try {
      const userId = parsePositiveUserId(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }

      setUserStatusById(userId, 'active');
      logPortalAdminMutation(req, userId, 'user.status', { status: 'active' });
      res.json({ ok: true, message: 'User activated' });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to activate user', 'Portal: activate user failed');
    }
  });

  app.put('/api/users/:userId/tier', requirePortalAdminToken, requireOperatorTargetUser('userId'), express.json(), (req: Request, res: Response) => {
    try {
      const userId = parsePositiveUserId(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }

      const tier = String(req.body?.tier ?? '').trim().toLowerCase();
      if (!VALID_TIERS.has(tier)) {
        res.status(400).json({ ok: false, message: 'tier must be free, pro, max, or owner' });
        return;
      }

      const db = getDb();
      db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(tier, userId);
      logPortalAdminMutation(req, userId, 'user.tier', { tier });
      res.json({ ok: true, message: `Tier set to ${tier}` });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to update user tier', 'Portal: user tier update failed');
    }
  });

  app.put('/api/users/:userId/limits', requirePortalAdminToken, requireOperatorTargetUser('userId'), express.json(), (req: Request, res: Response) => {
    try {
      const userId = parsePositiveUserId(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }

      const db = getDb();
      const {
        daily_message_limit,
        daily_token_limit,
        daily_cost_limit_usd,
        daily_ai_cost_limit_usd,
        monthly_ai_cost_limit_usd,
        daily_ai_cost_limit_expires_at,
        daily_ai_cost_limit_reason,
      } = req.body ?? {};
      const msgLimit = nonNegNumOrUndef(daily_message_limit);
      const tokenLimit = nonNegNumOrUndef(daily_token_limit);
      const costLimit = nonNegNumOrUndef(daily_cost_limit_usd);
      let aiCostLimit: number | null | undefined;
      let monthlyAiCostLimit: number | null | undefined;
      if (hasOwn(req.body, 'daily_ai_cost_limit_usd')) {
        if (daily_ai_cost_limit_usd === null) {
          aiCostLimit = null;
        } else {
          aiCostLimit = nonNegNumOrUndef(daily_ai_cost_limit_usd);
          if (aiCostLimit === undefined) {
            res.status(400).json({ ok: false, message: 'daily_ai_cost_limit_usd must be null or a non-negative number' });
            return;
          }
        }
      }
      if (hasOwn(req.body, 'monthly_ai_cost_limit_usd')) {
        if (monthly_ai_cost_limit_usd === null) {
          monthlyAiCostLimit = null;
        } else {
          monthlyAiCostLimit = nonNegNumOrUndef(monthly_ai_cost_limit_usd);
          if (monthlyAiCostLimit === undefined) {
            res.status(400).json({ ok: false, message: 'monthly_ai_cost_limit_usd must be null or a non-negative number' });
            return;
          }
        }
      }

      if (msgLimit !== undefined) db.prepare('UPDATE users SET daily_message_limit = ? WHERE id = ?').run(msgLimit, userId);
      if (tokenLimit !== undefined) db.prepare('UPDATE users SET daily_token_limit = ? WHERE id = ?').run(tokenLimit, userId);
      if (costLimit !== undefined) db.prepare('UPDATE users SET daily_cost_limit_usd = ? WHERE id = ?').run(costLimit, userId);
      if (aiCostLimit === null && (monthlyAiCostLimit === null || monthlyAiCostLimit === undefined)) {
        clearUserAiBudgetOverride(userId, 0);
      } else if (aiCostLimit !== undefined || monthlyAiCostLimit !== undefined) {
        const expiresAt = typeof daily_ai_cost_limit_expires_at === 'string' && daily_ai_cost_limit_expires_at.trim()
          ? daily_ai_cost_limit_expires_at.trim()
          : null;
        const reason = typeof daily_ai_cost_limit_reason === 'string' && daily_ai_cost_limit_reason.trim()
          ? daily_ai_cost_limit_reason.trim()
          : null;
        const activeOverride = getActiveUserAiBudgetOverride(userId);
        const quota = getDailyQuotaStatus(userId, { requestSource: 'interactive' });
        setUserAiBudgetOverride({
          userId,
          dailyCostUsd: aiCostLimit ?? activeOverride?.dailyCostUsd ?? quota.capUsd,
          monthlyCostUsd: monthlyAiCostLimit,
          expiresAt,
          reason,
          updatedBy: 0,
        });
      }

      logPortalAdminMutation(req, userId, 'user.limits', {
        daily_message_limit: msgLimit,
        daily_token_limit: tokenLimit,
        daily_cost_limit_usd: costLimit,
        daily_ai_cost_limit_usd: aiCostLimit,
        monthly_ai_cost_limit_usd: monthlyAiCostLimit,
      });
      res.json({ ok: true, message: 'Limits updated' });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to update user limits', 'Portal: user limits update failed');
    }
  });
}
