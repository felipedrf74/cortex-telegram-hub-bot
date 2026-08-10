import { sanitizeDetail } from './release-state-store.mjs';

/**
 * Health and smoke probes used by the staging gate and the production
 * observation window.
 *
 * `fetchImpl` and `sleep` are injected so the deployment tests can drive a
 * failing observation deterministically instead of waiting 60 real seconds.
 *
 * Probe targets are deliberately narrow. `/health` is the readiness contract
 * (503 when the database probe fails), `/public-status` is the only externally
 * allowlisted path and carries no diagnostics, and the content engine's
 * `/health` is the only route exempt from its internal-secret middleware. None
 * of the probes need a credential, so an observation failure can never leak one.
 */

export const RELEASE_HEALTH_CHECKS = Object.freeze({
  BACKEND_HEALTH: 'backend_health',
  BACKEND_PUBLIC_STATUS: 'backend_public_status',
  CONTENT_ENGINE_HEALTH: 'content_engine_health',
  CONTAINER_HEALTH: 'container_health',
  API_SMOKE: 'api_smoke',
});

// Database integrity is deliberately not a health probe: it runs against the
// host mount, not through a container that may already be failing, and it gates
// the rollback decision rather than the observation window. See
// scripts/lib/release-database.mjs.

function nowMs(clock) {
  return clock ? clock() : Date.now();
}

export function createReleaseHealth({
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  requestTimeoutMs = 5_000,
}) {
  async function probeJson({ url, expectStatus = 200 }) {
    const startedAt = nowMs(clock);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      const durationMs = nowMs(clock) - startedAt;
      if (response.status !== expectStatus) {
        return {
          ok: false,
          durationMs,
          detail: sanitizeDetail(`http ${response.status}`),
        };
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        return { ok: false, durationMs, detail: 'response body was not json' };
      }
      return { ok: true, durationMs, body, detail: null };
    } catch (error) {
      return {
        ok: false,
        durationMs: nowMs(clock) - startedAt,
        detail: sanitizeDetail(error?.name === 'AbortError' ? 'request timed out' : 'request failed'),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function backendHealth({ port }) {
    const result = await probeJson({ url: `http://127.0.0.1:${port}/health` });
    if (!result.ok) return { name: RELEASE_HEALTH_CHECKS.BACKEND_HEALTH, result: 'failed', durationMs: result.durationMs, detail: result.detail };
    const healthy = result.body?.status === 'healthy' && result.body?.database === 'connected';
    return {
      name: RELEASE_HEALTH_CHECKS.BACKEND_HEALTH,
      result: healthy ? 'passed' : 'failed',
      durationMs: result.durationMs,
      detail: healthy ? null : sanitizeDetail(`status ${result.body?.status ?? 'unknown'}`),
    };
  }

  async function backendPublicStatus({ port }) {
    const result = await probeJson({ url: `http://127.0.0.1:${port}/public-status` });
    const ok = result.ok && result.body?.status === 'ok' && result.body?.service === 'nexushub-api';
    return {
      name: RELEASE_HEALTH_CHECKS.BACKEND_PUBLIC_STATUS,
      result: ok ? 'passed' : 'failed',
      durationMs: result.durationMs,
      detail: ok ? null : (result.detail ?? 'unexpected public status payload'),
    };
  }

  async function contentEngineHealth({ port }) {
    const result = await probeJson({ url: `http://127.0.0.1:${port}/health` });
    const ok = result.ok && result.body?.status === 'ok';
    return {
      name: RELEASE_HEALTH_CHECKS.CONTENT_ENGINE_HEALTH,
      result: ok ? 'passed' : 'failed',
      durationMs: result.durationMs,
      detail: ok ? null : (result.detail ?? 'unexpected content engine payload'),
    };
  }

  /**
   * Targeted API smoke. It exercises the unauthenticated readiness surface only:
   * a deeper authenticated probe would require a credential on the deployment
   * host, and receipts must stay free of anything credential-shaped.
   */
  async function apiSmoke({ port }) {
    const startedAt = nowMs(clock);
    const checks = await Promise.all([
      probeJson({ url: `http://127.0.0.1:${port}/health` }),
      probeJson({ url: `http://127.0.0.1:${port}/public-status` }),
    ]);
    const ok = checks.every((check) => check.ok);
    return {
      name: RELEASE_HEALTH_CHECKS.API_SMOKE,
      result: ok ? 'passed' : 'failed',
      durationMs: nowMs(clock) - startedAt,
      detail: ok ? null : sanitizeDetail(checks.find((check) => !check.ok)?.detail ?? 'smoke failed'),
    };
  }

  /**
   * Wait until the backend and content engine both answer, or the budget runs
   * out. Returns the last observed check results either way.
   */
  async function waitUntilHealthy({ backendPort, contentEnginePort, budgetSeconds, intervalMs = 2_000 }) {
    const deadline = nowMs(clock) + budgetSeconds * 1000;
    let last = [];
    for (;;) {
      last = [
        await backendHealth({ port: backendPort }),
        await contentEngineHealth({ port: contentEnginePort }),
      ];
      if (last.every((check) => check.result === 'passed')) {
        return { healthy: true, checks: last };
      }
      if (nowMs(clock) >= deadline) return { healthy: false, checks: last };
      await sleep(intervalMs);
    }
  }

  /**
   * Observe a live release for the configured window. Any failed probe inside
   * the window ends the observation immediately — a release that degrades at
   * second 40 is a failed release, not a passed one.
   */
  async function observe({
    backendPort,
    contentEnginePort,
    observationSeconds,
    intervalMs = 5_000,
    containerHealth = null,
  }) {
    const startedAt = nowMs(clock);
    const deadline = startedAt + observationSeconds * 1000;
    const checks = [];
    for (;;) {
      if (containerHealth) {
        const container = containerHealth();
        checks.push({
          name: RELEASE_HEALTH_CHECKS.CONTAINER_HEALTH,
          result: container.healthy ? 'passed' : 'failed',
          durationMs: 0,
          detail: container.healthy ? null : sanitizeDetail(`container ${container.state}`),
        });
        if (!container.healthy) {
          return { passed: false, checks, observedSeconds: Math.round((nowMs(clock) - startedAt) / 1000) };
        }
      }
      const round = [
        await backendHealth({ port: backendPort }),
        await contentEngineHealth({ port: contentEnginePort }),
        await apiSmoke({ port: backendPort }),
      ];
      checks.push(...round);
      if (round.some((check) => check.result === 'failed')) {
        return { passed: false, checks, observedSeconds: Math.round((nowMs(clock) - startedAt) / 1000) };
      }
      if (nowMs(clock) >= deadline) {
        return {
          passed: true,
          checks,
          observedSeconds: Math.round((nowMs(clock) - startedAt) / 1000),
        };
      }
      await sleep(intervalMs);
    }
  }

  return {
    backendHealth,
    backendPublicStatus,
    contentEngineHealth,
    apiSmoke,
    waitUntilHealthy,
    observe,
  };
}
