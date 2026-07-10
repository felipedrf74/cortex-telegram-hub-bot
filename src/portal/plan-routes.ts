// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express, { Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import type { BillingPlan } from '../services/plan-quotas';
import {
  setPlanAllowedSkillsOverride,
  setPlanDailyCostCapOverride,
  setPlanMonthlyCostCapOverride,
} from '../services/plan-quotas';
import { logger } from '../utils/logger';
import { logPortalAdminMutation } from './admin-audit';
import { sendPortalInternalError } from './http';
import { safeJsonArray, safeJsonObject } from './validation';

const VALID_PLAN_IDS = new Set(['free', 'pro', 'max', 'owner']);

type PortalPlanId = Extract<BillingPlan, 'free' | 'pro' | 'max' | 'owner'>;

function parsePortalPlanId(value: unknown): PortalPlanId | null {
  const planId = String(value ?? '').trim().toLowerCase();
  return VALID_PLAN_IDS.has(planId) ? planId as PortalPlanId : null;
}

function parseNullableNonNegativeNumber(value: unknown): number | null {
  if (value == null) return null;
  return Number(value);
}

export function registerPortalPlanRoutes(app: express.Express): void {
  app.get('/api/plans', requirePortalAdminToken, (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const rows = db.prepare(
        'SELECT plan_id, display_name, daily_cost_usd, monthly_cost_usd, daily_token_limit, daily_message_limit, allowed_skills_json, per_skill_caps_json, metadata_json, active, updated_at FROM plan_configs ORDER BY plan_id',
      ).all() as Array<{
        plan_id: string;
        display_name: string;
        daily_cost_usd: number;
        monthly_cost_usd: number;
        daily_token_limit: number | null;
        daily_message_limit: number | null;
        allowed_skills_json: string;
        per_skill_caps_json: string;
        metadata_json: string;
        active: number;
        updated_at: string;
      }>;

      res.json({
        plans: rows.map((row) => ({
          planId: row.plan_id,
          displayName: row.display_name,
          dailyCostUsd: row.plan_id === 'free' || row.plan_id === 'beta'
            ? 0
            : row.daily_cost_usd,
          monthlyCostUsd: row.plan_id === 'free' || row.plan_id === 'beta'
            ? 0
            : row.monthly_cost_usd,
          dailyTokenLimit: row.daily_token_limit,
          dailyMessageLimit: row.daily_message_limit,
          allowedSkills: safeJsonArray(row.allowed_skills_json),
          perSkillCaps: safeJsonObject(row.per_skill_caps_json),
          metadata: safeJsonObject(row.metadata_json),
          active: row.active === 1,
          updatedAt: row.updated_at,
        })),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to load plan configuration', 'Portal: list plans failed');
    }
  });

  app.put('/api/plans/:planId', requirePortalAdminToken, express.json(), (req: Request, res: Response) => {
    try {
      const planId = parsePortalPlanId(req.params.planId);
      if (!planId) {
        res.status(400).json({ ok: false, message: 'planId must be free, pro, max, or owner' });
        return;
      }

      const body = req.body ?? {};
      const dailyCostUsd = Number(body.dailyCostUsd);
      if (!Number.isFinite(dailyCostUsd) || dailyCostUsd < 0) {
        res.status(400).json({ ok: false, message: 'dailyCostUsd must be a non-negative number' });
        return;
      }

      const monthlyCostUsd = body.monthlyCostUsd == null ? undefined : Number(body.monthlyCostUsd);
      if (monthlyCostUsd !== undefined && (!Number.isFinite(monthlyCostUsd) || monthlyCostUsd < 0)) {
        res.status(400).json({ ok: false, message: 'monthlyCostUsd must be a non-negative number' });
        return;
      }
      if (planId === 'free' && (dailyCostUsd !== 0 || (monthlyCostUsd !== undefined && monthlyCostUsd !== 0))) {
        res.status(400).json({ ok: false, message: 'Free model-backed daily and monthly limits must remain zero' });
        return;
      }

      const dailyTokenLimit = parseNullableNonNegativeNumber(body.dailyTokenLimit);
      if (dailyTokenLimit !== null && (!Number.isFinite(dailyTokenLimit) || dailyTokenLimit < 0)) {
        res.status(400).json({ ok: false, message: 'dailyTokenLimit must be null or a non-negative number' });
        return;
      }

      const dailyMessageLimit = parseNullableNonNegativeNumber(body.dailyMessageLimit);
      if (dailyMessageLimit !== null && (!Number.isFinite(dailyMessageLimit) || dailyMessageLimit < 0)) {
        res.status(400).json({ ok: false, message: 'dailyMessageLimit must be null or a non-negative number' });
        return;
      }

      const allowedSkills = Array.isArray(body.allowedSkills)
        ? body.allowedSkills.filter((skill: unknown): skill is string => typeof skill === 'string')
        : null;

      const db = getDb();
      const sets: string[] = ['daily_cost_usd = ?'];
      const values: unknown[] = [dailyCostUsd];
      if (monthlyCostUsd !== undefined) {
        sets.push('monthly_cost_usd = ?');
        values.push(monthlyCostUsd);
      }
      if (dailyTokenLimit !== undefined) {
        sets.push('daily_token_limit = ?');
        values.push(dailyTokenLimit);
      }
      if (dailyMessageLimit !== undefined) {
        sets.push('daily_message_limit = ?');
        values.push(dailyMessageLimit);
      }
      if (allowedSkills) {
        sets.push('allowed_skills_json = ?');
        values.push(JSON.stringify(allowedSkills));
      }
      sets.push("updated_at = datetime('now')");
      values.push(planId);
      db.prepare(`UPDATE plan_configs SET ${sets.join(', ')} WHERE plan_id = ?`).run(...values);

      try {
        setPlanDailyCostCapOverride(planId, dailyCostUsd);
        if (monthlyCostUsd !== undefined) setPlanMonthlyCostCapOverride(planId, monthlyCostUsd);
        if (allowedSkills) {
          setPlanAllowedSkillsOverride(planId, allowedSkills);
        }
      } catch (err) {
        logger.warn({ err, planId }, 'plan-quotas override apply failed');
      }

      logPortalAdminMutation(req, 0, 'plan_config.update', {
        planId,
        dailyCostUsd,
        monthlyCostUsd,
        dailyTokenLimit,
        dailyMessageLimit,
        allowedSkills: allowedSkills ?? undefined,
      });
      res.json({ ok: true });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to update plan configuration', 'Portal: update plan failed');
    }
  });
}
