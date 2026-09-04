// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { config } from '../config';
import { allowLocalHealthBypass } from '../api/secret-guards';
import { getCacheStoreStats } from '../services/cache-store';
import { isPausedContentAgent } from '../services/content-agent-lifecycle';
import { getDashboardCacheInvalidationStats } from '../services/cache-coherence-registry';
import { getStatus as getSentryStatus } from '../services/error-tracker';
import { getRuntimeStatus } from '../services/runtime-status';
import { getDb } from '../services/database';
import { getPm2SupervisorHealth, recordPm2SupervisorAlerts } from '../services/pm2-health';
import { readDeployedReleaseIdentity } from '../services/release-runtime-identity';
import { isManifestRoutingEnabled } from '../services/intent-resolution/manifest-routing-flags';
import { isRoutingClarifyEnabled } from '../services/intent-resolution/confidence';
import {
  isManifestClassifierPromptEnabled,
  isManifestClassifierPromptRuntimeForceDisabled,
} from '../router/classifier-prompt-builder';
import { isCrossSkillExecutionEnabled } from '../services/chat/planner/cross-skill-ownership';
import {
  isChatCoreV2ShadowPlannerEnabled,
  isChatCoreV2ShadowRouteHookEnabled,
} from '../services/runtime-flags';
import { getJobStatuses, getRecentEvents } from './telemetry';
import { humanUptime } from './formatters';
import { getChatCapabilityRuntimeGuardStatus } from '../services/chat-capability-runtime-guard';
import {
  readTrainingSummaryDeprecationUsage,
  TRAINING_SUMMARY_ROUTE_PATH,
} from '../services/training-route-deprecation-telemetry';

const CHAT_CAPABILITY_FLAG_NAMES = {
  classifier: 'AI_ROUTING_MANIFEST_CLASSIFIER',
  orchestrator: 'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  shadow: 'AI_ROUTING_MANIFEST_SHADOW',
  registry: 'AI_ROUTING_MANIFEST_REGISTRY',
  clarify: 'AI_ROUTING_CLARIFY',
  manifestPrompt: 'AI_CLASSIFY_MANIFEST_PROMPT',
  crossSkill: 'AI_CROSS_SKILL_EXECUTION',
} as const;

const CHAT_CAPABILITY_MASTER_KILL = 'AI_ROUTING_MANIFEST_KILL' as const;

function enabledFlagValue(value: string | undefined): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function dedicatedEvalScopeId(env: NodeJS.ProcessEnv): number | null {
  const raw = String(env.CHAT_EVAL_DEDICATED_TENANT_ID ?? '').trim();
  if (!/^[1-9][0-9]*$/u.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Protected, non-secret proof of the chat rollout configuration this process
 * is actually serving. Effective values come from the same helpers as the
 * runtime paths, including the manifest-prompt boot guard override.
 */
function releaseAttestation(env: NodeJS.ProcessEnv = process.env) {
  const release = readDeployedReleaseIdentity(env);
  if (!release) return null;

  const configured = {
    [CHAT_CAPABILITY_FLAG_NAMES.classifier]: enabledFlagValue(env[CHAT_CAPABILITY_FLAG_NAMES.classifier]),
    [CHAT_CAPABILITY_FLAG_NAMES.orchestrator]: enabledFlagValue(env[CHAT_CAPABILITY_FLAG_NAMES.orchestrator]),
    [CHAT_CAPABILITY_FLAG_NAMES.shadow]: enabledFlagValue(env[CHAT_CAPABILITY_FLAG_NAMES.shadow]),
    [CHAT_CAPABILITY_FLAG_NAMES.registry]: enabledFlagValue(env[CHAT_CAPABILITY_FLAG_NAMES.registry]),
    [CHAT_CAPABILITY_FLAG_NAMES.clarify]: enabledFlagValue(env[CHAT_CAPABILITY_FLAG_NAMES.clarify]),
    [CHAT_CAPABILITY_FLAG_NAMES.manifestPrompt]: enabledFlagValue(env[CHAT_CAPABILITY_FLAG_NAMES.manifestPrompt]),
    [CHAT_CAPABILITY_FLAG_NAMES.crossSkill]: enabledFlagValue(env[CHAT_CAPABILITY_FLAG_NAMES.crossSkill]),
  };
  const masterKill = enabledFlagValue(env[CHAT_CAPABILITY_MASTER_KILL]);
  const dedicatedEvalId = dedicatedEvalScopeId(env);
  const effective = {
    [CHAT_CAPABILITY_FLAG_NAMES.classifier]: isManifestRoutingEnabled('classifier', env),
    [CHAT_CAPABILITY_FLAG_NAMES.orchestrator]: isManifestRoutingEnabled('orchestrator', env),
    [CHAT_CAPABILITY_FLAG_NAMES.shadow]: isManifestRoutingEnabled('shadow', env),
    [CHAT_CAPABILITY_FLAG_NAMES.registry]: isManifestRoutingEnabled('registry', env),
    [CHAT_CAPABILITY_FLAG_NAMES.clarify]: isRoutingClarifyEnabled(env),
    [CHAT_CAPABILITY_FLAG_NAMES.manifestPrompt]: isManifestClassifierPromptEnabled(env),
    [CHAT_CAPABILITY_FLAG_NAMES.crossSkill]: isCrossSkillExecutionEnabled(env),
  };

  return {
    schema: 'nexus.chat-capability-release-attestation.v2',
    runtimeSha: release.runtimeSha,
    artifactDigest: release.artifactDigest,
    role: release.role,
    processId: process.pid,
    classifierPromptRuntimeForceDisabled: isManifestClassifierPromptRuntimeForceDisabled(),
    capabilityRuntimeGuard: getChatCapabilityRuntimeGuardStatus(),
    shadowPlannerEffective: {
      global: isChatCoreV2ShadowPlannerEnabled(env),
      user1000014: isChatCoreV2ShadowPlannerEnabled(env, { userId: 1_000_014 }),
      tenant1000014: isChatCoreV2ShadowPlannerEnabled(env, { tenantId: 1_000_014 }),
      user1000016: isChatCoreV2ShadowPlannerEnabled(env, { userId: 1_000_016 }),
      tenant1000016: isChatCoreV2ShadowPlannerEnabled(env, { tenantId: 1_000_016 }),
      dedicatedEval: {
        present: dedicatedEvalId !== null,
        user: dedicatedEvalId === null
          ? null
          : isChatCoreV2ShadowPlannerEnabled(env, { userId: dedicatedEvalId }),
        tenant: dedicatedEvalId === null
          ? null
          : isChatCoreV2ShadowPlannerEnabled(env, { tenantId: dedicatedEvalId }),
      },
    },
    shadowRouteHookEffective: {
      global: isChatCoreV2ShadowRouteHookEnabled(env),
      dedicatedEval: {
        present: dedicatedEvalId !== null,
        user: dedicatedEvalId === null
          ? null
          : isChatCoreV2ShadowRouteHookEnabled(env, { userId: dedicatedEvalId }),
        tenant: dedicatedEvalId === null
          ? null
          : isChatCoreV2ShadowRouteHookEnabled(env, { tenantId: dedicatedEvalId }),
      },
    },
    capabilityFlags: {
      configured,
      effective,
      masterKill,
    },
  };
}

import { getReleaseInfo, type ReleaseInfo } from '../services/release-info';

type HealthSnapshotIntegration = {
  name: string;
  configured: boolean;
  status?: string;
  tokenHealth?: string;
};

type HealthSnapshot = {
  integrations: HealthSnapshotIntegration[];
};

type HealthRoutesOptions = {
  startedAt: number;
  buildSnapshot: () => HealthSnapshot;
};

function uptimeSeconds(startedAt: number): number {
  return Math.floor((Date.now() - startedAt) / 1000);
}

function memoryMb(): { rss: number; heapUsed: number; heapTotal: number; external: number } {
  const mem = process.memoryUsage();

  return {
    rss: Math.round(mem.rss / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    external: Math.round(mem.external / 1024 / 1024),
  };
}

function providerHealthSnapshot(): Record<string, unknown> {
  try {
    const { getActiveProvider } = require('../services/provider-registry');
    const activeProvider = getActiveProvider();
    if (activeProvider) {
      return activeProvider.getProviderHealth();
    }
  } catch { /* provider not initialized yet */ }
  return {};
}

type DatabaseProbe = {
  status: 'connected' | 'disconnected';
  checkedAt: string;
  latencyMs: number;
  errorCode?: 'DB_PROBE_FAILED';
};

function probeDatabaseHealth(): DatabaseProbe {
  const startedAt = Date.now();
  try {
    const row = getDb().prepare('SELECT 1 as ok').get() as { ok?: number } | undefined;
    if (row?.ok !== 1) {
      return {
        status: 'disconnected',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        errorCode: 'DB_PROBE_FAILED',
      };
    }
    return {
      status: 'connected',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    return {
      status: 'disconnected',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      errorCode: 'DB_PROBE_FAILED',
    };
  }
}

function releaseInfoSnapshot(startedAt: number): ReleaseInfo | null {
  try {
    return getReleaseInfo({ startedAt });
  } catch {
    // Release identity is informational; never let it degrade /health.
    return null;
  }
}

function overallHealthStatus(
  runtime: ReturnType<typeof getRuntimeStatus>,
  databaseProbe: DatabaseProbe,
): 'healthy' | 'degraded' {
  return runtime.serviceStatus === 'online' && databaseProbe.status === 'connected'
    ? 'healthy'
    : 'degraded';
}

export function registerPortalHealthRoutes(app: Express, options: HealthRoutesOptions): void {
  // Public heartbeat for external monitors and AI fetchers. Keep this payload
  // intentionally small: the Cloudflare WAF allowlist for bot user-agents is
  // safe only while this route exposes no diagnostics.
  app.get('/public-status', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Robots-Tag', 'all');
    res.status(200).json({
      status: 'ok',
      service: 'nexushub-api',
      timestamp: new Date().toISOString(),
    });
  });

  // GET /health — public, lightweight service readiness.
  app.get('/health', (_req: Request, res: Response) => {
    const uptimeSec = uptimeSeconds(options.startedAt);
    const runtime = getRuntimeStatus();
    const databaseProbe = probeDatabaseHealth();
    const status = overallHealthStatus(runtime, databaseProbe);
    const release = releaseInfoSnapshot(options.startedAt);

    res.status(status === 'healthy' ? 200 : 503).json({
      status,
      version: release?.version ?? null,
      gitShortSha: release?.gitShortSha ?? null,
      uptime: uptimeSec,
      uptimeHuman: humanUptime(uptimeSec),
      server: {
        status: runtime.serviceStatus,
        database: databaseProbe.status,
      },
      bot: {
        polling: runtime.botPolling,
        restarting: runtime.botRestarting,
        lastMessageAt: runtime.lastMessageAt,
      },
      database: databaseProbe.status,
      databaseProbe,
      memory: memoryMb(),
      timestamp: new Date().toISOString(),
    });
  });

  // GET /health/detailed — operational diagnostics, protected outside local development.
  app.get('/health/detailed', async (req: Request, res: Response) => {
    const healthToken = config.health.token;
    if (!healthToken) {
      if (!allowLocalHealthBypass(req)) {
        res.status(401).json({ error: 'HEALTH_TOKEN not configured for /health/detailed' });
        return;
      }
    } else {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${healthToken}`) {
        res.status(401).json({ error: 'Unauthorized — provide Authorization: Bearer <HEALTH_TOKEN>' });
        return;
      }
    }

    const uptimeSec = uptimeSeconds(options.startedAt);
    const runtime = getRuntimeStatus();
    const databaseProbe = probeDatabaseHealth();

    const jobs = getJobStatuses().map((job) => {
      const paused = isPausedContentAgent(job.name);
      return {
        name: job.name,
        label: job.label,
        cronExpression: job.cronExpression,
        domain: job.domain,
        lifecycle: paused ? 'paused' : 'active',
        lastRunAt: paused ? null : job.lastRunAt,
        lastResult: paused ? 'paused' : job.lastResult,
        lastDurationMs: paused ? null : job.lastDurationMs,
        lastError: paused ? null : job.lastError,
      };
    });

    const recentEvents = getRecentEvents();
    const errorCount = recentEvents.filter(e => e.type === 'error').length;
    const errorsLast1h = recentEvents.filter(e => {
      if (e.type !== 'error') return false;
      const ageMs = Date.now() - new Date(e.ts).getTime();
      return ageMs < 3_600_000;
    }).length;

    let integrationHealth: { name: string; status: string; configured: boolean; tokenHealth: string }[] = [];
    try {
      const snap = options.buildSnapshot();
      integrationHealth = snap.integrations.map(i => ({
        name: i.name,
        status: i.status ?? 'unknown',
        configured: i.configured,
        tokenHealth: i.tokenHealth ?? 'unknown',
      }));
    } catch { /* snapshot build may fail during startup */ }

    const cache = {
      store: getCacheStoreStats(),
      dashboardInvalidation: getDashboardCacheInvalidationStats(),
    };

    let trainingSummaryDeprecation: ReturnType<typeof readTrainingSummaryDeprecationUsage> | {
      routePath: typeof TRAINING_SUMMARY_ROUTE_PATH;
      windowDays: 30;
      requestCount: null;
      firstHitDate: null;
      lastHitDate: null;
      unavailable: true;
    };
    try {
      trainingSummaryDeprecation = readTrainingSummaryDeprecationUsage(getDb(), { windowDays: 30 });
    } catch {
      // Keep the protected health surface available during bootstrap or a
      // metrics-store outage, but make the evidence gap explicit. Never
      // serialize database errors into an operator response.
      trainingSummaryDeprecation = {
        routePath: TRAINING_SUMMARY_ROUTE_PATH,
        windowDays: 30,
        requestCount: null,
        firstHitDate: null,
        lastHitDate: null,
        unavailable: true,
      };
    }

    const pm2 = await getPm2SupervisorHealth();
    const pm2AlertsRecorded = recordPm2SupervisorAlerts(pm2);
    const status = overallHealthStatus(runtime, databaseProbe);

    res.status(status === 'healthy' ? 200 : 503).json({
      status,
      uptime: uptimeSec,
      uptimeHuman: humanUptime(uptimeSec),
      server: {
        status: runtime.serviceStatus,
        database: databaseProbe.status,
      },
      bot: {
        polling: runtime.botPolling,
        restarting: runtime.botRestarting,
        lastMessageAt: runtime.lastMessageAt,
      },
      database: databaseProbe.status,
      databaseProbe,
      memory: memoryMb(),
      crons: jobs,
      integrations: integrationHealth,
      providers: providerHealthSnapshot(),
      pm2: {
        ...pm2,
        alertsRecorded: pm2AlertsRecorded,
      },
      sentry: getSentryStatus(config.sentry?.environment ?? 'unknown'),
      cache,
      release: releaseInfoSnapshot(options.startedAt),
      errors: {
        total: errorCount,
        lastHour: errorsLast1h,
      },
      deprecations: {
        trainingSummary: trainingSummaryDeprecation,
      },
      releaseAttestation: releaseAttestation(),
      timestamp: new Date().toISOString(),
    });
  });
}
