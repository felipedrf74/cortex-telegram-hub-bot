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

const LOCAL_PLAN_INTEGER_FIELDS = [
  { body: 'localOperationsHourly', column: 'local_operations_hourly', maximum: 10_000 },
  { body: 'localOperationsDaily', column: 'local_operations_daily', maximum: 100_000 },
  { body: 'longformScriptsDaily', column: 'longform_scripts_daily', maximum: 1_000 },
  { body: 'activeContentJobs', column: 'active_content_jobs', maximum: 100 },
  { body: 'ordinaryContextTokens', column: 'ordinary_context_tokens', maximum: 16_384 },
  { body: 'contentContextTokens', column: 'content_context_tokens', maximum: 16_384 },
  { body: 'scriptSegmentOutputTokens', column: 'script_segment_output_tokens', maximum: 6_144 },
  { body: 'localQueueWeight', column: 'local_queue_weight', maximum: 10 },
] as const;

const LOCAL_PLAN_DECIMAL_FIELDS = [
  { body: 'localCloudFallbackRunUsd', column: 'local_cloud_fallback_run_usd', maximum: 100 },
  { body: 'localCloudFallbackDailyUsd', column: 'local_cloud_fallback_daily_usd', maximum: 1_000 },
] as const;

type LocalPlanBodyField = typeof LOCAL_PLAN_INTEGER_FIELDS[number]['body'];
type LocalPlanDecimalBodyField = typeof LOCAL_PLAN_DECIMAL_FIELDS[number]['body'];

interface PersistedLocalPlanLimits {
  local_operations_hourly: number;
  local_operations_daily: number;
  longform_scripts_daily: number;
  ordinary_context_tokens: number;
  content_context_tokens: number;
  script_segment_output_tokens: number;
  local_cloud_fallback_run_usd: number;
  local_cloud_fallback_daily_usd: number;
}

function parseLocalPlanFields(body: Record<string, unknown>): {
  values: Partial<Record<LocalPlanBodyField, number>>;
  error: string | null;
} {
  const values: Partial<Record<LocalPlanBodyField, number>> = {};
  for (const field of LOCAL_PLAN_INTEGER_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, field.body)) continue;
    const value = body[field.body];
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > field.maximum) {
      return {
        values: {},
        error: `${field.body} must be an integer from 0 to ${field.maximum}`,
      };
    }
    values[field.body] = Number(value);
  }
  return { values, error: null };
}

function parseLocalPlanDecimalFields(body: Record<string, unknown>): {
  values: Partial<Record<LocalPlanDecimalBodyField, number>>;
  error: string | null;
} {
  const values: Partial<Record<LocalPlanDecimalBodyField, number>> = {};
  for (const field of LOCAL_PLAN_DECIMAL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, field.body)) continue;
    const value = Number(body[field.body]);
    if (!Number.isFinite(value) || value < 0 || value > field.maximum) {
      return { values: {}, error: `${field.body} must be from 0 to ${field.maximum}` };
    }
    values[field.body] = value;
  }
  return { values, error: null };
}

function validateLocalPlanRelationships(
  current: PersistedLocalPlanLimits,
  integers: Partial<Record<LocalPlanBodyField, number>>,
  decimals: Partial<Record<LocalPlanDecimalBodyField, number>>,
): string | null {
  const hourly = integers.localOperationsHourly ?? current.local_operations_hourly;
  const daily = integers.localOperationsDaily ?? current.local_operations_daily;
  const scripts = integers.longformScriptsDaily ?? current.longform_scripts_daily;
  const ordinaryContext = integers.ordinaryContextTokens ?? current.ordinary_context_tokens;
  const contentContext = integers.contentContextTokens ?? current.content_context_tokens;
  const segmentOutput = integers.scriptSegmentOutputTokens ?? current.script_segment_output_tokens;
  const fallbackRun = decimals.localCloudFallbackRunUsd ?? current.local_cloud_fallback_run_usd;
  const fallbackDaily = decimals.localCloudFallbackDailyUsd ?? current.local_cloud_fallback_daily_usd;

  if (hourly > daily) return 'localOperationsHourly cannot exceed localOperationsDaily';
  if (scripts > daily) return 'longformScriptsDaily cannot exceed localOperationsDaily';
  if (ordinaryContext > contentContext) return 'ordinaryContextTokens cannot exceed contentContextTokens';
  if (segmentOutput > contentContext) return 'scriptSegmentOutputTokens cannot exceed contentContextTokens';
  if (fallbackRun > fallbackDaily) return 'localCloudFallbackRunUsd cannot exceed localCloudFallbackDailyUsd';
  return null;
}

export function registerPortalPlanRoutes(app: express.Express): void {
  app.get('/api/plans', requirePortalAdminToken, (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const rows = db.prepare(
        `SELECT plan_id, display_name, daily_cost_usd, monthly_cost_usd,
                daily_token_limit, daily_message_limit, allowed_skills_json,
                per_skill_caps_json, metadata_json, active, updated_at,
                local_operations_hourly, local_operations_daily,
                longform_scripts_daily, active_content_jobs,
                ordinary_context_tokens, content_context_tokens,
                script_segment_output_tokens, local_queue_weight,
                local_cloud_fallback_run_usd, local_cloud_fallback_daily_usd
         FROM plan_configs ORDER BY plan_id`,
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
        local_operations_hourly: number;
        local_operations_daily: number;
        longform_scripts_daily: number;
        active_content_jobs: number;
        ordinary_context_tokens: number;
        content_context_tokens: number;
        script_segment_output_tokens: number;
        local_queue_weight: number;
        local_cloud_fallback_run_usd: number;
        local_cloud_fallback_daily_usd: number;
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
          localOperationsHourly: row.local_operations_hourly,
          localOperationsDaily: row.local_operations_daily,
          longformScriptsDaily: row.longform_scripts_daily,
          activeContentJobs: row.active_content_jobs,
          ordinaryContextTokens: row.ordinary_context_tokens,
          contentContextTokens: row.content_context_tokens,
          scriptSegmentOutputTokens: row.script_segment_output_tokens,
          localQueueWeight: row.local_queue_weight,
          localCloudFallbackRunUsd: row.local_cloud_fallback_run_usd,
          localCloudFallbackDailyUsd: row.local_cloud_fallback_daily_usd,
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

      const body = (req.body ?? {}) as Record<string, unknown>;
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

      const hasDailyTokenLimit = Object.prototype.hasOwnProperty.call(body, 'dailyTokenLimit');
      const dailyTokenLimit = hasDailyTokenLimit
        ? parseNullableNonNegativeNumber(body.dailyTokenLimit)
        : undefined;
      if (hasDailyTokenLimit && dailyTokenLimit !== null && dailyTokenLimit !== undefined
        && (!Number.isFinite(dailyTokenLimit) || dailyTokenLimit < 0)) {
        res.status(400).json({ ok: false, message: 'dailyTokenLimit must be null or a non-negative number' });
        return;
      }

      const hasDailyMessageLimit = Object.prototype.hasOwnProperty.call(body, 'dailyMessageLimit');
      const dailyMessageLimit = hasDailyMessageLimit
        ? parseNullableNonNegativeNumber(body.dailyMessageLimit)
        : undefined;
      if (hasDailyMessageLimit && dailyMessageLimit !== null && dailyMessageLimit !== undefined
        && (!Number.isFinite(dailyMessageLimit) || dailyMessageLimit < 0)) {
        res.status(400).json({ ok: false, message: 'dailyMessageLimit must be null or a non-negative number' });
        return;
      }

      const allowedSkills = Array.isArray(body.allowedSkills)
        ? body.allowedSkills.filter((skill: unknown): skill is string => typeof skill === 'string')
        : null;
      const localPlan = parseLocalPlanFields(body);
      if (localPlan.error) {
        res.status(400).json({ ok: false, message: localPlan.error });
        return;
      }
      const localPlanDecimals = parseLocalPlanDecimalFields(body);
      if (localPlanDecimals.error) {
        res.status(400).json({ ok: false, message: localPlanDecimals.error });
        return;
      }
      if (planId === 'free'
          && (Object.values(localPlan.values).some((value) => value !== 0)
            || Object.values(localPlanDecimals.values).some((value) => value !== 0))) {
        res.status(400).json({ ok: false, message: 'Free local-model limits must remain zero' });
        return;
      }

      const db = getDb();
      const currentLocalPlan = db.prepare(`SELECT local_operations_hourly, local_operations_daily,
          longform_scripts_daily, ordinary_context_tokens, content_context_tokens,
          script_segment_output_tokens, local_cloud_fallback_run_usd,
          local_cloud_fallback_daily_usd
        FROM plan_configs WHERE plan_id = ?`).get(planId) as PersistedLocalPlanLimits | undefined;
      if (!currentLocalPlan) {
        res.status(404).json({ ok: false, message: 'Plan configuration was not found' });
        return;
      }
      const localRelationshipError = validateLocalPlanRelationships(
        currentLocalPlan,
        localPlan.values,
        localPlanDecimals.values,
      );
      if (localRelationshipError) {
        res.status(400).json({ ok: false, message: localRelationshipError });
        return;
      }
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
      for (const field of LOCAL_PLAN_INTEGER_FIELDS) {
        const value = localPlan.values[field.body];
        if (value === undefined) continue;
        sets.push(`${field.column} = ?`);
        values.push(value);
      }
      for (const field of LOCAL_PLAN_DECIMAL_FIELDS) {
        const value = localPlanDecimals.values[field.body];
        if (value === undefined) continue;
        sets.push(`${field.column} = ?`);
        values.push(value);
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
        ...localPlan.values,
        ...localPlanDecimals.values,
      });
      res.json({ ok: true });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to update plan configuration', 'Portal: update plan failed');
    }
  });
}
