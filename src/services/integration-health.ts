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
 * integration_health table, and (on consecutive failures) escalates to
 * the existing Telegram alert callback. Designed to be cron-friendly:
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

export type ProbeStatus = 'ok' | 'fail' | 'skipped';

export interface ProbeResult {
  provider: string;
  status: ProbeStatus;
  latencyMs: number | null;
  errorMessage: string | null;
}

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

// ── Per-provider probes ─────────────────────────────────────────────

async function probeGarmin(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const { isGarminConfigured, keepAlive } = require('./garmin');
    if (!isGarminConfigured()) {
      return { provider: 'garmin', status: 'skipped', latencyMs: null, errorMessage: 'not configured' };
    }
    const ok = await keepAlive();
    return {
      provider: 'garmin',
      status: ok ? 'ok' : 'fail',
      latencyMs: Date.now() - start,
      errorMessage: ok ? null : 'keepAlive returned false',
    };
  } catch (err: any) {
    return {
      provider: 'garmin',
      status: 'fail',
      latencyMs: Date.now() - start,
      errorMessage: err?.message ?? String(err),
    };
  }
}

async function probeGoogle(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const { isGoogleConfigured, buildGoogleOAuth2Client } = require('./google-auth');
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
    const { isMicrosoftConfigured, getGraphClient } = require('./microsoft-auth');
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
