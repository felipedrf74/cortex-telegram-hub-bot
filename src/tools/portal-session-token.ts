// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { mintPortalSessionToken } from '../services/portal-session-mint';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function printHelp(): void {
  console.log(`
Portal session token mint

Usage:
  node dist/tools/portal-session-token.js --actor operator@nexushub.me --scope read|write|admin [--ttl-ms 900000] [--jti id] [--json]

Requires PORTAL_SESSION_SECRET. The requested TTL must not exceed PORTAL_SESSION_MAX_AGE_MS.
This tool only prints a signed ps_ session token; it does not persist a server-side session.
`);
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = argValue(name);
  return parsePositiveIntValue(name, raw, fallback);
}

function parsePositiveIntValue(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function main(): void {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const maxAgeMs = parsePositiveIntValue(
    'PORTAL_SESSION_MAX_AGE_MS',
    process.env.PORTAL_SESSION_MAX_AGE_MS,
    28800000,
  );
  const defaultTtlMs = Math.min(900000, maxAgeMs);
  const result = mintPortalSessionToken({
    secret: process.env.PORTAL_SESSION_SECRET || '',
    actorHint: argValue('--actor') || '',
    scope: argValue('--scope') || '',
    ttlMs: parsePositiveInt('--ttl-ms', defaultTtlMs),
    maxAgeMs,
    jti: argValue('--jti'),
  });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('Portal session token minted');
  console.log(`- actor: ${result.actor}`);
  console.log(`- scope: ${result.scope}`);
  console.log(`- issued: ${new Date(result.issuedAt).toISOString()}`);
  console.log(`- expires: ${new Date(result.expiresAt).toISOString()}`);
  console.log(`- ttlMs: ${result.ttlMs}`);
  console.log('');
  console.log(result.token);
}

main();
