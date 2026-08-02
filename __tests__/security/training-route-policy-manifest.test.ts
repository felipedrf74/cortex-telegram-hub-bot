// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// F14/F16 (Phase 1A-6): the Training production-router policy manifest must
// cover every route that actually exists.
//
// This is the gate the plan requires: "a test that fails when any route is
// unclassified". It reads the route declarations out of source rather than
// trusting a hand-maintained list, so adding a route without classifying it
// breaks the build.
//
// The extractor deliberately accepts `v2.` as a receiver. That is exactly the
// case `scripts/generate-project-map.mjs` misses — its allow-list
// (/^(?:router|app|[A-Za-z][A-Za-z0-9]*Router)$/) does not match the Coach V2
// sub-router local, so all six Coach V2 routes are silently dropped from
// docs/project-map.json. Any route denominator taken from that map is wrong.

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  TRAINING_CONSTANT_REGISTERED_ROUTES,
  TRAINING_ROUTE_POLICY,
  TRAINING_ROUTE_SOURCE_FILES,
  trainingRoutePolicyKey,
} from '../../src/api/routes/training-route-policy';

const ROUTES_DIR = path.resolve(__dirname, '../../src/api/routes');

// Accepts `router.`, `app.`, `<name>Router.` AND `v2.` — see header.
const ROUTE_DECLARATION = /\b(?:router|app|v2|[A-Za-z][A-Za-z0-9]*Router)\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;

function declaredRoutes(): Array<{ method: string; routePath: string; file: string }> {
  const found: Array<{ method: string; routePath: string; file: string }> = [];
  for (const file of TRAINING_ROUTE_SOURCE_FILES) {
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    for (const match of source.matchAll(ROUTE_DECLARATION)) {
      found.push({ method: match[1].toUpperCase(), routePath: match[2], file });
    }
  }
  return found;
}

describe('Training route policy manifest', () => {
  it('classifies every route declared in source', () => {
    const classified = new Set(
      TRAINING_ROUTE_POLICY.map((entry) => trainingRoutePolicyKey(entry.method, entry.path)),
    );

    const unclassified = declaredRoutes()
      .filter((route) => !classified.has(trainingRoutePolicyKey(route.method, route.routePath)))
      .map((route) => `${route.method} ${route.routePath} (${route.file})`);

    // If this fails: a Training route was added without an auth/entitlement/
    // capability/mode classification. Add it to TRAINING_ROUTE_POLICY.
    expect(unclassified).toEqual([]);
  });

  it('has no stale manifest entries', () => {
    const declared = new Set(
      declaredRoutes().map((route) => trainingRoutePolicyKey(route.method, route.routePath)),
    );
    // Constant-registered paths cannot be seen by a literal scan; they are
    // declared explicitly in the manifest module.
    for (const constantPath of TRAINING_CONSTANT_REGISTERED_ROUTES) {
      for (const entry of TRAINING_ROUTE_POLICY) {
        if (entry.path === constantPath) declared.add(trainingRoutePolicyKey(entry.method, entry.path));
      }
    }

    const stale = TRAINING_ROUTE_POLICY
      .map((entry) => trainingRoutePolicyKey(entry.method, entry.path))
      .filter((key) => !declared.has(key));

    expect(stale).toEqual([]);
  });

  it('covers the six Coach V2 routes that docs/project-map.json omits', () => {
    // Regression pin for the receiver allow-list bug. If project-map is ever
    // fixed and these are folded in elsewhere, this test still holds.
    const coachV2 = TRAINING_ROUTE_POLICY.filter((entry) => entry.capability === 'coach-periodization-v2');
    expect(coachV2).toHaveLength(6);
    expect(coachV2.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      '/week/travel',
      '/health-intake/red-flag',
      '/week/:weekId/reflow',
      '/plans/:planId/coach-policy',
      '/plans/:planId/coach-analysis',
    ]));
  });

  it('keeps exercise-media self-scoped rather than relying on the shared mount', () => {
    // These are mounted WITHOUT requireEntitlement and enforce their own
    // flag → scope → entitlement chain, collapsing failures to a hidden 404.
    // Recording it here stops someone "tidying up" by adding a blanket mount.
    const media = TRAINING_ROUTE_POLICY.filter((entry) => entry.capability === 'exercise-media-v1');
    expect(media).toHaveLength(2);
    for (const entry of media) expect(entry.entitlement).toBe('self-scoped');
  });

  it('marks the stricter coach-briefing entitlement on both coach routes', () => {
    const coach = TRAINING_ROUTE_POLICY.filter((entry) => entry.entitlement === 'coach-briefing');
    expect(coach.map((entry) => trainingRoutePolicyKey(entry.method, entry.path)).sort()).toEqual([
      'GET /coach',
      'POST /coach/report',
    ]);
  });

  it('classifies the legacy generation routes as compatibility-mode only', () => {
    const compatibilityOnly = TRAINING_ROUTE_POLICY
      .filter((entry) => entry.mode === 'compatibility')
      .map((entry) => entry.path)
      .sort();
    expect(compatibilityOnly).toEqual(['/plan/generate', '/plan/preview']);
  });
});
