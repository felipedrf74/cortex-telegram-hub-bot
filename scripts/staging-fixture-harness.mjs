#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FIXTURE_USER_ID,
  assertFixtureUserId,
  normalizeFixtureCalendarEventCount,
  seedFixture,
} from './staging-fixture-seed.mjs';
import { cleanupFixture } from './staging-fixture-cleanup.mjs';
import { runFixtureProbes } from './staging-fixture-probes.mjs';

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

export function resolveTargetUrl(args = {}, env = process.env) {
  return args.url
    || args['staging-url']
    || env.STAGING_URL
    || env.PRODUCTION_URL
    || 'https://staging-api.nexushub.me';
}

export function resolveFixtureCalendarEventCount(args = {}) {
  if (args['felipe-volume-calendar'] === true) {
    return normalizeFixtureCalendarEventCount(true);
  }
  if (args['calendar-events'] != null) {
    return normalizeFixtureCalendarEventCount(args['calendar-events']);
  }
  return 0;
}

export function validateStagingTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Invalid URL: ${rawUrl}` };
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'api.nexushub.me') {
    return { ok: false, reason: 'Refusing production API hostname api.nexushub.me' };
  }
  if (!hostname.includes('staging')) {
    return { ok: false, reason: `Refusing non-staging hostname ${hostname}` };
  }
  return { ok: true, url: url.toString() };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = String(args.action || '').toLowerCase();
  if (!['seed', 'probe', 'cleanup', 'all'].includes(action)) {
    process.stderr.write('Usage: node scripts/staging-fixture-harness.mjs --action seed|probe|cleanup|all [--user-id 1000001] [--url https://staging-api.nexushub.me] [--felipe-volume-calendar|--calendar-events 100]\n');
    process.exit(2);
  }

  const userId = args['user-id'] ? Number(args['user-id']) : DEFAULT_FIXTURE_USER_ID;
  assertFixtureUserId(userId);

  const target = validateStagingTarget(resolveTargetUrl(args));
  if (!target.ok) {
    process.stderr.write(`SAFETY_REFUSAL: ${target.reason}\n`);
    process.exit(2);
  }

  const options = {
    userId,
    baseUrl: target.url,
    server: args.server || process.env.DEPLOY_SERVER,
    stagingPath: args['staging-path'] || process.env.STAGING_PATH,
    reportPath: args['report-path'],
    route: args.route,
    tier: args.tier,
    seedAppleHealth: args['seed-apple-health'] === true,
    calendarEventCount: resolveFixtureCalendarEventCount(args),
  };

  if (action === 'seed') {
    printJson(seedFixture(options));
    return;
  }

  if (action === 'probe') {
    const result = await runFixtureProbes(options);
    printJson({ ok: result.ok, reportPath: result.reportPath, routeFailures: result.routeFailures });
    process.exit(result.ok ? 0 : 1);
  }

  if (action === 'cleanup') {
    printJson(cleanupFixture(options));
    return;
  }

  const seed = seedFixture(options);
  const probe = await runFixtureProbes(options);
  const cleanup = cleanupFixture(options);
  printJson({
    ok: probe.ok && cleanup.remainingUser === 0,
    seed: { userId: seed.userId, deviceId: seed.deviceId, counts: seed.counts },
    probe: { reportPath: probe.reportPath, routeFailures: probe.routeFailures },
    cleanup: { remainingUser: cleanup.remainingUser },
  });
  process.exit(probe.ok && cleanup.remainingUser === 0 ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const exitCode = err?.exitCode ?? 1;
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(exitCode);
  });
}
