// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express, { type Express, type Request, type Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { sendPortalInternalError } from './http';
import { resolveModelPricing } from '../services/model-pricing';

const VALID_DOMAINS = new Set(['secretary', 'triathlon', 'content', 'finance', 'cooking']);
const VALID_MODEL_PROVIDERS = new Set(['anthropic', 'openai', 'gemini']);
const VALID_MODEL_ROLES = new Set(['chat', 'classifier', 'secretary', 'triathlon', 'content', 'finance', 'cooking']);

interface DomainProviderConfigRow {
  domain: string;
  provider: string;
  [key: string]: unknown;
}

interface DomainProviderRouter {
  getDomainProviderConfig: () => DomainProviderConfigRow[];
  isGeminiRoutingEnabled: () => boolean;
  isGeminiIncludeSecretaryEnabled: () => boolean;
  setGeminiRoutingEnabled: (enabled: boolean) => void;
  setGeminiIncludeSecretary: (enabled: boolean) => void;
  setGeminiDomains: (domains: string[]) => void;
}

interface ModelConfigService {
  MODEL_OPTIONS: unknown;
  getAllModelStates: () => unknown;
  getEffectiveDomainModel: (provider: string, domain: string) => string;
  setActiveModel: (provider: string, role: string, model: string) => void;
  clearModelOverride: (provider: string, role: string) => void;
}

interface PreparedStatement {
  all: (...args: unknown[]) => unknown[];
  get?: (...args: unknown[]) => unknown;
}

interface PortalDb {
  prepare: (sql: string) => PreparedStatement;
}

interface ActiveProvider {
  clearDomainPairCache?: () => void;
  getAllCircuitStates?: () => Record<string, { state: string; failures: number }>;
}

interface PortalProviderRouteDeps {
  domainRouter?: DomainProviderRouter;
  modelConfig?: ModelConfigService;
  getDb?: () => PortalDb;
  computeCostBreakdown?: (rows: unknown[], days: number) => unknown;
  getActiveProvider?: () => ActiveProvider | null;
  isGeminiProviderConfigured?: () => boolean;
}

function getDomainRouter(deps: PortalProviderRouteDeps): DomainProviderRouter {
  if (deps.domainRouter) return deps.domainRouter;
  return require('../services/domain-provider-router');
}

function getModelConfig(deps: PortalProviderRouteDeps): ModelConfigService {
  if (deps.modelConfig) return deps.modelConfig;
  return require('../services/model-config');
}

function getPortalDb(deps: PortalProviderRouteDeps): PortalDb {
  if (deps.getDb) return deps.getDb();
  const { getDb } = require('../services/database');
  return getDb();
}

function getActiveProviderForRoute(deps: PortalProviderRouteDeps): ActiveProvider | null {
  if (deps.getActiveProvider) return deps.getActiveProvider();
  const { getActiveProvider } = require('../services/provider-registry');
  return getActiveProvider();
}

function isGeminiConfiguredForRoute(deps: PortalProviderRouteDeps): boolean {
  if (deps.isGeminiProviderConfigured) return deps.isGeminiProviderConfigured();
  const { isGeminiProviderConfigured } = require('../services/gemini-provider');
  return isGeminiProviderConfigured();
}

function computeCostBreakdownForRoute(deps: PortalProviderRouteDeps, rows: unknown[], days: number): unknown {
  if (deps.computeCostBreakdown) return deps.computeCostBreakdown(rows, days);
  const { computeCostBreakdown } = require('./cost-breakdown');
  return computeCostBreakdown(rows, days);
}

function modelOptionTierForRole(role: string): 'chat' | 'classifier' {
  return role === 'chat' || role === 'secretary' ? 'chat' : 'classifier';
}

function isAllowedModelOption(modelConfig: ModelConfigService, provider: string, role: string, model: unknown): model is string {
  if (typeof model !== 'string' || !model.trim()) return false;

  const options = modelConfig.MODEL_OPTIONS as Record<string, { chat?: unknown; classifier?: unknown }> | undefined;
  const providerOptions = options?.[provider];
  const roleOptions = providerOptions?.[modelOptionTierForRole(role)];

  return Array.isArray(roleOptions) && roleOptions.includes(model);
}

function parseWindowDays(value: unknown, fallback = 7): number {
  const parsed = parseInt(typeof value === 'string' ? value : String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 90);
}

export function registerPortalProviderRoutes(app: Express, deps: PortalProviderRouteDeps = {}): void {
  app.get('/api/domain-routing', (_req: Request, res: Response) => {
    try {
      const router = getDomainRouter(deps);
      const modelConfig = getModelConfig(deps);
      const domains = router.getDomainProviderConfig();
      const enriched = domains.map((domainRow) => ({
        ...domainRow,
        model: (() => {
          try {
            return modelConfig.getEffectiveDomainModel?.(domainRow.provider, domainRow.domain) || 'default';
          } catch {
            return 'default';
          }
        })(),
      }));

      res.json({
        domains: enriched,
        geminiRoutingEnabled: router.isGeminiRoutingEnabled(),
        geminiIncludeSecretary: router.isGeminiIncludeSecretaryEnabled(),
        geminiConfigured: (() => {
          try {
            return isGeminiConfiguredForRoute(deps);
          } catch {
            return false;
          }
        })(),
      });
    } catch {
      res.json({
        domains: [],
        geminiRoutingEnabled: false,
        geminiIncludeSecretary: false,
        geminiConfigured: false,
      });
    }
  });

  app.post('/api/domain-routing/toggle', requirePortalAdminToken, express.json(), (req: Request, res: Response) => {
    try {
      const { enabled, includeSecretary, domains: geminiDomains } = req.body;
      const router = getDomainRouter(deps);

      if (typeof enabled === 'boolean') {
        router.setGeminiRoutingEnabled(enabled);
      }
      if (typeof includeSecretary === 'boolean') {
        router.setGeminiIncludeSecretary(includeSecretary);
      }
      if (Array.isArray(geminiDomains)) {
        const validated = geminiDomains.filter((domain): domain is string => (
          typeof domain === 'string' && VALID_DOMAINS.has(domain)
        ));
        router.setGeminiDomains(validated);
      }

      try {
        const active = getActiveProviderForRoute(deps);
        if (active && typeof active.clearDomainPairCache === 'function') {
          active.clearDomainPairCache();
        }
      } catch {
        // Provider registry may not be initialized in degraded portal mode.
      }

      res.json({
        ok: true,
        config: router.getDomainProviderConfig(),
        geminiRoutingEnabled: router.isGeminiRoutingEnabled(),
        geminiIncludeSecretary: router.isGeminiIncludeSecretaryEnabled(),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/model-config', (_req: Request, res: Response) => {
    try {
      const modelConfig = getModelConfig(deps);
      res.json({ states: modelConfig.getAllModelStates(), options: modelConfig.MODEL_OPTIONS });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.put('/api/model-config', requirePortalAdminToken, express.json(), (req: Request, res: Response) => {
    try {
      const { provider, role, model } = req.body;
      const modelConfig = getModelConfig(deps);
      if (!VALID_MODEL_PROVIDERS.has(provider) || !VALID_MODEL_ROLES.has(role) || !isAllowedModelOption(modelConfig, provider, role, model)) {
        res.status(400).json({ error: 'Invalid provider, role, or model' });
        return;
      }

      modelConfig.setActiveModel(provider, role, model);
      res.json({ ok: true, provider, role, model, message: 'Model updated. Active immediately — no restart needed.' });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.delete('/api/model-config', requirePortalAdminToken, express.json(), (req: Request, res: Response) => {
    try {
      const { provider, role } = req.body;
      if (!provider || !role) {
        res.status(400).json({ error: 'provider and role required' });
        return;
      }

      const modelConfig = getModelConfig(deps);
      modelConfig.clearModelOverride(provider, role);
      res.json({ ok: true, states: modelConfig.getAllModelStates() });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/model-intelligence', (_req: Request, res: Response) => {
    try {
      const db = getPortalDb(deps);
      const spending = db.prepare(`
        SELECT provider, model,
          COUNT(*) as calls,
          COALESCE(SUM(cost_usd), 0) as total_cost,
          COALESCE(AVG(cost_usd), 0) as avg_cost,
          COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens
        FROM api_usage
        WHERE ts >= date('now', '-7 days')
        GROUP BY provider, model
        ORDER BY total_cost DESC
      `).all() as any[];

      const insights: Array<{ type: string; title: string; detail: string; impact?: string }> = [];
      const anthropicSpend = spending.filter((entry) => entry.provider === 'anthropic');
      const anthropicTotal = anthropicSpend.reduce((sum: number, entry: any) => sum + entry.total_cost, 0);
      if (anthropicTotal > 0.50) {
        insights.push({
          type: 'cost',
          title: 'Anthropic fallback active',
          detail: `$${anthropicTotal.toFixed(2)} spent on Anthropic in 7 days (${anthropicSpend.map((entry: any) => `${entry.model}: ${entry.calls} calls`).join(', ')}). Check if fallback is triggering too often.`,
          impact: `Save ~$${(anthropicTotal * 0.9).toFixed(2)}/week by fixing primary provider stability`,
        });
      }

      const secretarySpend = db.prepare(`
        SELECT COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as calls
        FROM api_usage WHERE category = 'secretary' AND ts >= date('now', '-7 days')
      `).get?.() as any;
      if (secretarySpend?.cost > 0) {
        const secretaryPricing = resolveModelPricing('gpt-5.4-nano', 'openai');
        const rateCopy = secretaryPricing
          ? `$${secretaryPricing.inputUsdPerMillion}/$${secretaryPricing.outputUsdPerMillion} per 1M tokens`
          : 'pricing unresolved';
        insights.push({
          type: 'info',
          title: 'Secretary domain cost',
          detail: `$${secretarySpend.cost.toFixed(2)} / ${secretarySpend.calls} calls this week. Currently on GPT-5.4 nano (${rateCopy}).`,
        });
      }

      const totalWeekly = spending.reduce((sum: number, entry: any) => sum + entry.total_cost, 0);
      insights.push({
        type: 'summary',
        title: 'Weekly AI spend',
        detail: `$${totalWeekly.toFixed(2)} total across ${spending.reduce((sum: number, entry: any) => sum + entry.calls, 0)} API calls.`,
        impact: `Projected monthly: $${(totalWeekly * 4.3).toFixed(2)}`,
      });

      res.json({ ok: true, spending, insights });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/cost-by-domain', (req: Request, res: Response) => {
    try {
      const days = parseWindowDays(req.query.days);
      const db = getPortalDb(deps);
      const rawRows = db.prepare(`
        SELECT
          COALESCE(category, 'unknown') AS category,
          COALESCE(provider, 'anthropic') AS provider,
          COALESCE(model, 'unknown') AS model,
          input_tokens,
          output_tokens,
          cost_usd,
          duration_ms,
          ts
        FROM api_usage
        WHERE ts >= date('now', '-' || ? || ' days')
      `).all(days);

      const breakdown = computeCostBreakdownForRoute(deps, rawRows, days);
      res.json({ ok: true, ...(breakdown as Record<string, unknown>) });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/provider-stats', (_req: Request, res: Response) => {
    try {
      const db = getPortalDb(deps);
      const todayRows = db.prepare(`
        SELECT COALESCE(provider, 'anthropic') AS provider,
               COUNT(*) AS calls,
               COALESCE(SUM(cost_usd), 0) AS cost,
               COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
               MAX(ts) AS lastCallAt
        FROM api_usage
        WHERE ts >= date('now')
        GROUP BY provider
      `).all() as Array<{ provider: string; calls: number; cost: number; tokens: number; lastCallAt: string }>;

      const weekRows = db.prepare(`
        SELECT COALESCE(provider, 'anthropic') AS provider,
               COUNT(*) AS calls,
               COALESCE(SUM(cost_usd), 0) AS cost
        FROM api_usage
        WHERE ts >= date('now', '-7 days')
        GROUP BY provider
      `).all() as Array<{ provider: string; calls: number; cost: number }>;

      let circuits: Record<string, { state: string; failures: number }> = {};
      try {
        const active = getActiveProviderForRoute(deps);
        if (active && typeof active.getAllCircuitStates === 'function') {
          circuits = active.getAllCircuitStates();
        }
      } catch {
        // no active routing provider; use defaults
      }

      const knownProviders = new Set<string>(['anthropic', 'openai', 'gemini']);
      for (const row of todayRows) knownProviders.add(row.provider);
      for (const row of weekRows) knownProviders.add(row.provider);
      for (const provider of Object.keys(circuits)) knownProviders.add(provider);

      const providers = Array.from(knownProviders).map((name) => {
        const today = todayRows.find((row) => row.provider === name);
        const week = weekRows.find((row) => row.provider === name);
        const circuit = circuits[name] || { state: 'CLOSED', failures: 0 };
        return {
          name,
          today: {
            calls: today?.calls || 0,
            cost: today?.cost || 0,
            tokens: today?.tokens || 0,
            lastCallAt: today?.lastCallAt || null,
          },
          week: {
            calls: week?.calls || 0,
            cost: week?.cost || 0,
          },
          circuit,
        };
      }).sort((a, b) => (b.today.cost + b.week.cost) - (a.today.cost + a.week.cost));

      res.json({ ok: true, providers });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });
}
