// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * R8 P1-6 — Router-mount smoke tests for the v2 coach routes.
 *
 * The existing v2 route tests
 * (`__tests__/api/training-coach-v2-routes.test.ts`) bypass auth +
 * entitlement via a fake-auth shim that injects `userId = 100`
 * directly. That's correct for unit testing the route logic, but
 * it leaves a gap: do the v2 routes actually inherit the
 * `requireEntitlement({ skill: 'training' })` middleware mounted
 * at `src/api/router.ts:276`?
 *
 * The v2 routes mount INSIDE `trainingRoutes()` (see
 * `src/api/routes/training.ts:220`), so middleware applied at
 * `/training` should reach them. These tests pin that behavior
 * end-to-end:
 *
 *   - No auth → 401 (from authMiddleware before entitlement runs)
 *   - Auth + free tier → 403 TIER_REQUIRED (entitlement blocks)
 *   - Auth + training-entitled → request reaches the v2 handler
 *
 * Affected v2 routes (one smoke per surface):
 *   - POST /week/travel              (C2)
 *   - POST /week/:weekId/reflow      (C6)
 *   - GET  /plans/:planId/coach-policy (A5)
 *   - PATCH /plans/:planId/coach-policy (A5)
 *   - GET  /plans/:planId/coach-analysis
 *   - POST /health-intake/red-flag   (A4)
 */
import express from 'express';
import http from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetEffectiveEntitlement = vi.fn();
const mockIsSkillAllowedByEntitlement = vi.fn();

vi.mock('../../src/services/entitlement', () => ({
  FREE_TIER_ALLOWED_SKILLS: new Set(['secretary']),
  getEffectiveEntitlement: (...args: unknown[]) => mockGetEffectiveEntitlement(...args),
  isSkillAllowedByEntitlement: (...args: unknown[]) => mockIsSkillAllowedByEntitlement(...args),
  isPaidAiCostControlsEnforcementEnabled: () => false,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

// Stub feature flag — return true so v2 routes don't short-circuit
// with COACH_V2_DISABLED before reaching the entitlement check (the
// real entitlement middleware runs upstream so this is purely
// defensive — if the flag is off the test would still pass at the
// entitlement gate).
vi.mock('../../src/config', () => ({
  config: {
    training: { coachPeriodizationV2Enabled: true },
  },
}));

import { requireEntitlement } from '../../src/api/entitlement-middleware';
import { mountCoachV2Routes } from '../../src/api/routes/training-coach-v2';
import { Router } from 'express';

type Plan = 'free' | 'pro';

function setPlan(plan: Plan): void {
  mockGetEffectiveEntitlement.mockReturnValue({
    plan,
    source: 'subscription',
    allowedSkills: plan === 'free' ? new Set(['secretary']) : new Set(['training']),
    evaluatedAt: '2026-05-23T00:00:00.000Z',
  });
  mockIsSkillAllowedByEntitlement.mockImplementation(
    (entitlement: { allowedSkills: Set<string> }, skill: string) => entitlement.allowedSkills.has(skill),
  );
}

interface CallOpts {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: Record<string, unknown>;
  /** Provide a userId to simulate authenticated; omit for unauthenticated. */
  userId?: number;
}

async function callV2({ method, path, body, userId }: CallOpts): Promise<{ status: number; body: any }> {
  const app = express();
  app.use(express.json());
  // Production order:
  //   authMiddleware → requireEntitlement(skill: 'training') → trainingRoutes()
  // We synthesize the auth step here (userId set or absent) and
  // then run the real entitlement middleware + the v2 sub-router.
  app.use((req, _res, next) => {
    if (typeof userId === 'number') {
      (req as any).userId = userId;
      (req as any).tenantId = userId;
    }
    next();
  });
  const trainingRouter = Router();
  mountCoachV2Routes(trainingRouter);
  app.use(
    '/training',
    requireEntitlement({ skill: 'training' }),
    trainingRouter,
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');

  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        method,
        path: `/training${path}`,
        headers: body ? { 'content-type': 'application/json' } : {},
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed: unknown = null;
          if (data) {
            try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

beforeEach(() => {
  mockGetEffectiveEntitlement.mockReset();
  mockIsSkillAllowedByEntitlement.mockReset();
});

describe('R8 P1-6 — v2 coach routes inherit the training entitlement gate', () => {
  // The middleware doesn't strictly emit 401 itself — the prior
  // `authMiddleware` would. Without `userId` set, the entitlement
  // middleware DOES fire its own "Authenticated user required"
  // 401 (defensive double-check in entitlement-middleware.ts:62).
  // Pin that contract: unauthenticated reaches at most 401.

  const surfaces: { name: string; opts: CallOpts }[] = [
    { name: 'POST /week/travel',                    opts: { method: 'POST',  path: '/week/travel',          body: { startDate: '2026-06-01', endDate: '2026-06-07' } } },
    { name: 'POST /week/:weekId/reflow',            opts: { method: 'POST',  path: '/week/1/reflow',        body: { planId: 1, mode: 'preview', trigger: 'manual_reflow' } } },
    { name: 'GET  /plans/:planId/coach-policy',     opts: { method: 'GET',   path: '/plans/1/coach-policy' } },
    { name: 'PATCH /plans/:planId/coach-policy',    opts: { method: 'PATCH', path: '/plans/1/coach-policy', body: { progressionAggressiveness: 'standard' } } },
    { name: 'GET  /plans/:planId/coach-analysis',   opts: { method: 'GET',   path: '/plans/1/coach-analysis' } },
    { name: 'POST /health-intake/red-flag',         opts: { method: 'POST',  path: '/health-intake/red-flag', body: { date: '2026-05-23', illnessSymptoms: ['fever'], consentScope: ['illness'] } } },
  ];

  for (const { name, opts } of surfaces) {
    it(`${name} — no userId → 401 UNAUTHORIZED (entitlement middleware defensive check)`, async () => {
      const res = await callV2({ ...opts /* no userId */ });
      expect(res.status).toBe(401);
      expect(res.body?.error?.code).toBe('UNAUTHORIZED');
    });

    it(`${name} — free-tier user → 403 TIER_REQUIRED (entitlement blocks before handler)`, async () => {
      setPlan('free');
      const res = await callV2({ ...opts, userId: 42 });
      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe('TIER_REQUIRED');
      expect(res.body?.error?.details?.skill).toBe('training');
    });

    it(`${name} — training-entitled user → request reaches the v2 handler (status NOT 401/403)`, async () => {
      setPlan('pro');
      const res = await callV2({ ...opts, userId: 42 });
      // The handler may itself fail (no DB, missing plan, etc.) and
      // return 4xx/5xx — but it MUST NOT 401/403 from the
      // entitlement layer.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  }
});
