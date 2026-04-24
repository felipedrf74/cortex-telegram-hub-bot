// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Integration Health — synthetic probes for external dependencies.
 *
 * Audit Weeks 2-4 finding: previously, when Garmin/Notion/Google/Anthropic/
 * Gemini went down or had credential expiry, the operator only found out
 * through user complaints or by reading PM2 stderr. There was no proactive
 * signal until something user-facing broke.
 *
 * This module exposes `runHealthProbes()` which hits each integration's
 * cheapest authenticated endpoint, records success/failure into the
 * integration_health table, and emits structured operator signals when a
 * provider crosses a repeated-failure threshold. Designed to be cron-friendly:
 * runs in <10 seconds, never throws, swallows individual probe failures
 * so one bad integration doesn't block the others.
 *
 * Probe selection rationale per provider:
 *   - Garmin:      isGarminConfigured() + a tiny getUserSettings() call
 *                  (the same call garmin-keepalive uses, so we piggyback)
 *   - Google:      isGoogleConfigured() + an OAuth token refresh attempt
 *                  (cheapest call that proves the refresh token is valid)
 *   - Notion:      Read 1 row from the configured database via the SDK
 *   - Anthropic:   No probe — pinging /v1/models costs $0 but adds noise.
 *                  We rely on the cost-guardrail rejecting bad keys at
 *                  first real usage instead.
 *   - Gemini:      Same reasoning as Anthropic.
 *
 * Cron-friendly entry point: integrate from src/services/scheduler.ts.
 */

import { logger } from '../utils/logger';
import { getDb } from './database';
import { pushEvent } from '../portal/telemetry';
import { recordOperatorAlert } from './operator-alerts';

export type ProbeStatus = 'ok' | 'fail' | 'skipped';

export interface ProbeResult {
  provider: string;
  status: ProbeStatus;
  latencyMs: number | null;
  errorMessage: string | null;
}

const FAILURE_ALERT_THRESHOLD = 3;

type GarminModule = {
  isGarminConfigured: () => boolean;
};

type GoogleAuthModule = {
  isGoogleConfigured: () => boolean;
  buildGoogleOAuth2Client: () => { getAccessToken: () => Promise<unknown> };
};

type MicrosoftAuthModule = {
  isMicrosoftConfigured: () => boolean;
  getGraphClient: () => {
    api: (path: string) => {
      select: (selection: string) => {
        get: () => Promise<unknown>;
      };
    };
  };
};

const defaultProbeDeps = {
  getGarminModule: (): GarminModule => require('./garmin'),
  getGoogleAuthModule: (): GoogleAuthModule => require('./google-auth'),
  getMicrosoftAuthModule: (): MicrosoftAuthModule => require('./microsoft-auth'),
};

const probeDeps = { ...defaultProbeDeps };

// ── Persistence ─────────────────────────────────────────────────────

function persist(result: ProbeResult): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO integration_health (provider, status, latency_ms, error_message)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        result.provider,
        result.status,
        result.latencyMs,
        result.errorMessage ? result.errorMessage.slice(0, 500) : null,
      );
  } catch (err) {
    // Table might not exist yet on first deploy after migration 043 ships;
    // swallow so a missing table doesn't crash the cron.
    logger.warn({ err, provider: result.provider }, 'integration_health: persist failed');
  }
}

function getFailureStreak(provider: string, limit = FAILURE_ALERT_THRESHOLD + 1): number {
  try {
    const rows = getDb()
      .prepare(
        `SELECT status
         FROM integration_health
         WHERE provider = ?
           AND status != 'skipped'
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(provider, limit) as Array<{ status: ProbeStatus }>;

    let streak = 0;
    for (const row of rows) {
      if (row.status !== 'fail') break;
      streak += 1;
    }
    return streak;
  } catch (err) {
    logger.debug({ err, provider }, 'integration_health: failed to read failure streak');
    return 0;
  }
}

function emitRepeatedFailureSignals(results: ProbeResult[]): void {
  const ts = new Date().toISOString();

  for (const result of results) {
    if (result.status !== 'fail') continue;

    const streak = getFailureStreak(result.provider);
    if (streak !== FAILURE_ALERT_THRESHOLD) continue;

    logger.warn(
      {
        provider: result.provider,
        streak,
        errorMessage: result.errorMessage,
      },
      'Integration health degraded after repeated probe failures',
    );
    pushEvent({
      ts,
      type: 'error',
      summary: `Integration ${result.provider} degraded (${streak} fails)`,
      detail: result.errorMessage ?? 'Probe failed repeatedly',
    });
    recordOperatorAlert({
      severity: 'warning',
      source: 'integration_health',
      dedupeKey: `integration:${result.provider}:degraded`,
      title: `Integração ${result.provider} degradada`,
      detail: result.errorMessage ?? `A integração ${result.provider} falhou ${streak} vezes seguidas.`,
      metadata: {
        provider: result.provider,
        status: result.status,
        failureStreak: streak,
        latencyMs: result.latencyMs,
      },
    });
  }
}

// ── Per-provider probes ─────────────────────────────────────────────

async function probeGarmin(): Promise<ProbeResult> {
  // CRITICAL: do NOT call keepAlive() here — the probe runs every 5 minutes,
  // and the real garmin_keepalive cron only runs every 30 minutes. If the
  // probe calls keepAlive() directly, we 6x the load on Garmin's SSO server
  // which triggers its rate-limiter (persistent via rate_limit_until.txt)
  // and actively prevents natural recovery. This is the observer-effect
  // bug that broke Garmin after v4.9.30 shipped — see commit notes.
  //
  // Instead, we mirror the most recent garmin_keepalive job_history row.
  // The cron is the source of truth; the probe just reflects its state.
  // If the latest row is >1 hour old, we assume the cron itself is broken
  // and report fail — that's a different failure mode worth alerting on.
  try {
    const { isGarminConfigured } = probeDeps.getGarminModule();
    if (!isGarminConfigured()) {
      return { provider: 'garmin', status: 'skipped', latencyMs: null, errorMessage: 'not configured' };
    }

    const row = getDb()
      .prepare(
        `SELECT result, duration_ms, error_message, ts
         FROM job_history
         WHERE job_name = 'garmin_keepalive'
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as
      | { result: string; duration_ms: number | null; error_message: string | null; ts: string }
      | undefined;

    if (!row) {
      return {
        provider: 'garmin',
        status: 'fail',
        latencyMs: null,
        errorMessage: 'no garmin_keepalive history — cron may not be registered',
      };
    }

    // If the latest row is >90 minutes old, the cron itself is broken or
    // paused (garmin_keepalive runs every 30 min, so >90 min = 3 missed runs).
    // That's worse than a single keepAlive failure — report it distinctly.
    const ageMinutes = (Date.now() - new Date(row.ts + 'Z').getTime()) / 60_000;
    if (ageMinutes > 90) {
      return {
        provider: 'garmin',
        status: 'fail',
        latencyMs: null,
        errorMessage: `stale: last keepalive was ${Math.round(ageMinutes)}min ago`,
      };
    }

    return {
      provider: 'garmin',
      status: row.result === 'success' ? 'ok' : 'fail',
      latencyMs: row.duration_ms,
      errorMessage: row.result === 'success' ? null : row.error_message ?? 'unknown failure',
    };
  } catch (err: any) {
    return {
      provider: 'garmin',
      status: 'fail',
      latencyMs: null,
      errorMessage: err?.message ?? String(err),
    };
  }
}

async function probeGoogle(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const { isGoogleConfigured, buildGoogleOAuth2Client } = probeDeps.getGoogleAuthModule();
    if (!isGoogleConfigured()) {
      return { provider: 'google', status: 'skipped', latencyMs: null, errorMessage: 'not configured' };
    }
    // The cheapest call that proves the refresh token works: getAccessToken
    // forces a token refresh against Google's oauth2/token endpoint without
    // hitting any data API. Returns the new access token or throws on
    // invalid_grant / expired refresh.
    const client = buildGoogleOAuth2Client();
    await client.getAccessToken();
    return { provider: 'google', status: 'ok', latencyMs: Date.now() - start, errorMessage: null };
  } catch (err: any) {
    return {
      provider: 'google',
      status: 'fail',
      latencyMs: Date.now() - start,
      errorMessage: err?.message ?? String(err),
    };
  }
}

async function probeOutlook(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const { isMicrosoftConfigured, getGraphClient } = probeDeps.getMicrosoftAuthModule();
    if (!isMicrosoftConfigured()) {
      return { provider: 'outlook', status: 'skipped', latencyMs: null, errorMessage: 'not configured' };
    }
    // /me is the cheapest authenticated Graph call — confirms the refresh
    // token is valid and the access token can be acquired.
    const client = getGraphClient();
    await client.api('/me').select('id').get();
    return { provider: 'outlook', status: 'ok', latencyMs: Date.now() - start, errorMessage: null };
  } catch (err: any) {
    return {
      provider: 'outlook',
      status: 'fail',
      latencyMs: Date.now() - start,
      errorMessage: err?.message ?? String(err),
    };
  }
}

// ── Public entry point ──────────────────────────────────────────────

/**
 * Run all configured probes in parallel and persist their results.
 * Always returns — never throws. The portal can read recent rows from
 * integration_health to render a status grid.
 */
export async function runHealthProbes(): Promise<ProbeResult[]> {
  const probes = [probeGarmin(), probeGoogle(), probeOutlook()];
  const settled = await Promise.allSettled(probes);

  const results: ProbeResult[] = settled.map((s, idx) => {
    if (s.status === 'fulfilled') return s.value;
    // Promise.allSettled rejection: shouldn't happen because the probes
    // catch internally, but defensive fallback.
    const provider = ['garmin', 'google', 'outlook'][idx] || 'unknown';
    return {
      provider,
      status: 'fail',
      latencyMs: null,
      errorMessage: (s.reason as Error)?.message ?? 'probe rejected',
    };
  });

  for (const r of results) {
    persist(r);
  }

  emitRepeatedFailureSignals(results);

  // Aggregate log line for the operator: "garmin:ok google:fail outlook:ok"
  const summary = results.map((r) => `${r.provider}:${r.status}`).join(' ');
  logger.info({ probes: results.length, summary }, 'Integration health probes complete');

  return results;
}

/**
 * Returns the latest probe result per provider. Used by the portal status
 * panel to render a current-state grid.
 */
export function getLatestHealthByProvider(): Record<string, ProbeResult & { ts: string }> {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT provider, status, latency_ms as latencyMs, error_message as errorMessage, ts
         FROM integration_health
         WHERE id IN (
           SELECT MAX(id) FROM integration_health GROUP BY provider
         )`,
      )
      .all() as Array<ProbeResult & { ts: string }>;
    const out: Record<string, ProbeResult & { ts: string }> = {};
    for (const r of rows) out[r.provider] = r;
    return out;
  } catch (err) {
    logger.warn({ err }, 'getLatestHealthByProvider failed');
    return {};
  }
}

export function _getFailureAlertThresholdForTests(): number {
  return FAILURE_ALERT_THRESHOLD;
}

export function _setIntegrationHealthDepsForTests(
  overrides: Partial<typeof defaultProbeDeps>,
): void {
  Object.assign(probeDeps, overrides);
}

export function _resetIntegrationHealthDepsForTests(): void {
  Object.assign(probeDeps, defaultProbeDeps);
}
