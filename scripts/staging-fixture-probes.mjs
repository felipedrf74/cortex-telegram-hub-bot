#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_FIXTURE_DEVICE_ID,
  DEFAULT_FIXTURE_USER_ID,
  assertFixtureUserId,
  runRemoteNode,
  tokenCachePath,
} from './staging-fixture-seed.mjs';

function nowCompact() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function defaultReportPath() {
  return join(tmpdir(), `staging-probe-${nowCompact()}.json`);
}

function readToken(userId) {
  const path = tokenCachePath(userId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')).token;
}

function buildRemoteMintTokenScript({ userId, deviceId }) {
  return String.raw`
const { signIosJwt } = require('./dist/services/ios-jwt');
process.stdout.write(JSON.stringify({
  token: signIosJwt({
    userId: ${JSON.stringify(userId)},
    deviceId: ${JSON.stringify(deviceId)},
    staging_fixture: true,
    fixture: 'staging-fixture-harness',
  }, { expiresIn: '30d' }),
}));
`;
}

function parseRemoteJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    if (start >= 0) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < raw.length; i += 1) {
        const ch = raw[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === '{') depth += 1;
        if (ch === '}') depth -= 1;
        if (depth === 0) {
          return JSON.parse(raw.slice(start, i + 1));
        }
      }
    }
    throw new Error(`Remote command did not return JSON: ${raw.slice(0, 300)}`);
  }
}

function buildRemoteRegistryProbeScript({ userId }) {
  return String.raw`
require('./dist/services/database-bootstrap').initDatabase();
const { setCache, getCached } = require('./dist/services/cache-store');
const {
  invalidateCalendarCaches,
  invalidateCookingDerivedCaches,
} = require('./dist/services/cache-coherence-registry');
const userId = ${JSON.stringify(userId)};
const today = new Date().toISOString().slice(0, 10);
const keys = [
  'u:' + userId + ':calendar:today:' + today,
  'u:' + userId + ':calendar:events:' + today + ':' + today,
  'dashboard:' + userId + ':en-US',
  'dashboard-home:' + userId + ':en-US',
  'plan:today:u:' + userId + ':' + today + ':route:en-US',
  'plan:week:u:' + userId + ':' + today + ':route:en-US',
];
function seedKeys(label) {
  for (const key of keys) setCache(key, { label, key, userId }, 3600);
}
function state() {
  return Object.fromEntries(keys.map((key) => [key, Boolean(getCached(key))]));
}
seedKeys('cooking-before');
const cookingBefore = state();
invalidateCookingDerivedCaches(userId, { includeCalendarSurfaces: true });
const cookingAfter = state();
seedKeys('calendar-before');
const calendarBefore = state();
invalidateCalendarCaches(userId);
const calendarAfter = state();
process.stdout.write(JSON.stringify({
  ok: true,
  userId,
  keys,
  cooking: { before: cookingBefore, after: cookingAfter },
  calendar: { before: calendarBefore, after: calendarAfter },
}, null, 2));
`;
}

function extractReadiness(json) {
  const direct = json?.readiness
    ?? json?.data?.readiness
    ?? json?.home?.readiness
    ?? json?.dashboard?.readiness
    ?? json?.today?.readiness
    ?? null;
  if (direct) return direct;

  const data = json?.data;
  if (!data || typeof data !== 'object') return null;

  const metrics = Array.isArray(data.metrics) ? data.metrics : [];
  const metricValue = (id) => metrics.find((metric) => metric?.id === id)?.value ?? null;
  return {
    readinessText: data.hero?.readinessText ?? metricValue('readiness'),
    bodyBatteryText: data.hero?.energyText ?? metricValue('body-battery'),
    reasonCodes: Array.isArray(data.meta?.reasonCodes) ? data.meta.reasonCodes : [],
  };
}

async function requestJson(baseUrl, token, route, {
  method = 'GET',
  body,
  headers = {},
  timeoutMs = 45000,
} = {}) {
  const url = new URL(route.path, baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'x-language': 'en-US',
        ...headers,
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return {
      route: route.name,
      method,
      path: route.path,
      status: response.status,
      ok: response.ok,
      elapsedMs,
      cached: json?.cached ?? json?.meta?.cached ?? null,
      etag: response.headers.get('etag'),
      cacheControl: response.headers.get('cache-control'),
      errorCode: json?.error?.code ?? null,
      readiness: extractReadiness(json),
      shapeOk: route.shape ? route.shape(json, response.status) : Boolean(json),
      bodyPreview: text.slice(0, 300),
    };
  } catch (err) {
    const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
    return {
      route: route.name,
      method,
      path: route.path,
      status: 0,
      ok: false,
      elapsedMs,
      cached: null,
      etag: null,
      cacheControl: null,
      errorCode: err?.name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'FETCH_FAILED',
      shapeOk: false,
      bodyPreview: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

const ROUTES = [
  { name: 'dashboard-root', path: '/api/v1/dashboard', shape: (json) => json && typeof json === 'object' },
  { name: 'dashboard-home', path: '/api/v1/dashboard/home', shape: (json) => json && typeof json === 'object' },
  { name: 'calendar-today', path: '/api/v1/calendar/today', shape: (json) => json && typeof json === 'object' },
  { name: 'calendar-events', path: '/api/v1/calendar/events', shape: (json) => json && typeof json === 'object' },
  { name: 'plan-today', path: '/api/v1/plan/today', shape: (json) => json && typeof json === 'object' },
  { name: 'plan-week', path: '/api/v1/plan/week', shape: (json) => json && typeof json === 'object' },
  { name: 'tasks-lists', path: '/api/v1/tasks/lists', shape: (json) => json && typeof json === 'object' },
  { name: 'tasks-working-set', path: '/api/v1/tasks/working-set', shape: (json) => json && typeof json === 'object' },
  { name: 'tasks-filtered', path: '/api/v1/tasks/filtered?filter=all', shape: (json) => json && typeof json === 'object' },
  { name: 'training-home', path: '/api/v1/training/home', shape: (json) => json && typeof json === 'object' },
  { name: 'finance-transactions', path: '/api/v1/finance/transactions', shape: (json) => json && typeof json === 'object' },
  { name: 'cooking-recipes', path: '/api/v1/cooking/recipes', shape: (json) => json && typeof json === 'object' },
  { name: 'content-home', path: '/api/v1/content/home', shape: (json) => json && typeof json === 'object' },
];

export async function runFixtureProbes(options = {}) {
  const userId = options.userId ?? DEFAULT_FIXTURE_USER_ID;
  assertFixtureUserId(userId);
  const baseUrl = options.baseUrl;
  if (!baseUrl) throw new Error('baseUrl is required');

  const deviceId = options.deviceId ?? `${DEFAULT_FIXTURE_DEVICE_ID}-${userId}`;
  let token = options.token ?? readToken(userId);
  if (!token) {
    const minted = parseRemoteJson(runRemoteNode(buildRemoteMintTokenScript({ userId, deviceId }), options));
    token = minted.token;
  }

  const report = {
    ok: true,
    userId,
    baseUrl,
    startedAt: new Date().toISOString(),
    routes: [],
    routeFailures: [],
    writes: [],
    cacheCoherence: null,
  };

  const routes = options.route
    ? [{ name: 'focused-route', path: options.route, shape: (json) => json && typeof json === 'object' }]
    : ROUTES;

  for (const route of routes) {
    process.stderr.write(`probe ${route.name}...\n`);
    const first = await requestJson(baseUrl, token, route);
    const second = await requestJson(baseUrl, token, route);
    const pair = {
      name: route.name,
      path: route.path,
      first,
      second,
      inferredCacheImproved: second.elapsedMs <= first.elapsedMs || second.cached === true,
    };
    report.routes.push(pair);

    if (first.status === 401 || first.status === 403 || second.status === 401 || second.status === 403) {
      report.routeFailures.push({ route: route.name, reason: 'auth_failure', firstStatus: first.status, secondStatus: second.status });
    }
    if (first.status >= 500 || second.status >= 500) {
      report.routeFailures.push({ route: route.name, reason: 'server_error', firstStatus: first.status, secondStatus: second.status });
    }
    if (first.status === 0 || second.status === 0) {
      report.routeFailures.push({ route: route.name, reason: 'request_failed', firstError: first.errorCode, secondError: second.errorCode });
    }
    if (!first.shapeOk || !second.shapeOk) {
      report.routeFailures.push({ route: route.name, reason: 'shape_failure', firstStatus: first.status, secondStatus: second.status });
    }
  }

  const recipeTitle = `Fixture Cache Probe ${Date.now()}`;
  const cookingWrite = await requestJson(baseUrl, token, { name: 'cooking-write-recipe', path: '/api/v1/cooking/recipes' }, {
    method: 'POST',
    body: {
      title: recipeTitle,
      ingredients: [{ name: 'oats', quantity: '1', unit: 'cup' }],
      instructions: 'Combine oats with water.',
      prepTime: 5,
      cookTime: 10,
      servings: 2,
      tags: 'fixture,cache-probe',
    },
  });
  const cookingReadAfterWrite = await requestJson(baseUrl, token, { name: 'cooking-recipes-after-write', path: '/api/v1/cooking/recipes' });
  report.writes.push({
    name: 'cooking-write-dependent-read',
    write: cookingWrite,
    dependentRead: cookingReadAfterWrite,
    changed: cookingReadAfterWrite.bodyPreview.includes(recipeTitle) || cookingReadAfterWrite.status < 500,
  });
  if (cookingWrite.status >= 500 || cookingReadAfterWrite.status >= 500) {
    report.routeFailures.push({ route: 'cooking-write-dependent-read', reason: 'server_error', writeStatus: cookingWrite.status, readStatus: cookingReadAfterWrite.status });
  }

  const start = new Date(Date.now() + 2 * 86400000).toISOString();
  const end = new Date(Date.now() + 2 * 86400000 + 30 * 60000).toISOString();
  const calendarWrite = await requestJson(baseUrl, token, { name: 'calendar-write-event', path: '/api/v1/calendar/events' }, {
    method: 'POST',
    body: {
      title: 'Fixture calendar cache probe',
      start,
      end,
      description: 'Staging fixture harness calendar write probe',
    },
  });
  const dashboardReadAfterCalendar = await requestJson(baseUrl, token, { name: 'dashboard-after-calendar-write', path: '/api/v1/dashboard' });
  report.writes.push({
    name: 'calendar-write-dependent-dashboard-read',
    write: calendarWrite,
    dependentRead: dashboardReadAfterCalendar,
    providerBacked: calendarWrite.status < 400,
    note: calendarWrite.status === 400 && calendarWrite.errorCode === 'CALENDAR_NOT_CONFIGURED'
      ? 'Fixture user has no real calendar OAuth token; registry-level cache invalidation probe below covers the deployed invalidator path.'
      : null,
  });
  if (calendarWrite.status >= 500 || dashboardReadAfterCalendar.status >= 500) {
    report.routeFailures.push({ route: 'calendar-write-dependent-dashboard-read', reason: 'server_error', writeStatus: calendarWrite.status, readStatus: dashboardReadAfterCalendar.status });
  }

  try {
    report.cacheCoherence = parseRemoteJson(runRemoteNode(buildRemoteRegistryProbeScript({ userId }), options));
  } catch (err) {
    report.cacheCoherence = { ok: false, error: err instanceof Error ? err.message : String(err) };
    report.routeFailures.push({ route: 'cache-coherence-registry', reason: 'registry_probe_failed' });
  }

  report.finishedAt = new Date().toISOString();
  report.ok = report.routeFailures.length === 0;
  const reportPath = options.reportPath ?? defaultReportPath();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return { ...report, reportPath };
}
