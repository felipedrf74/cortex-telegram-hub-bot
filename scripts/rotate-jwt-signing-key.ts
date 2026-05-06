#!/usr/bin/env npx tsx

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';

interface JwtKeyConfig {
  kid: string;
  secret: string;
  active?: boolean;
  verifyUntil?: string;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function parseKeys(raw: string | undefined): JwtKeyConfig[] {
  if (!raw || raw.trim().length === 0) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) return parsed as JwtKeyConfig[];
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed as Record<string, any>).map(([kid, value]) => ({
      kid,
      secret: typeof value === 'string' ? value : value.secret,
      active: value.active === true,
      verifyUntil: value.verifyUntil,
    }));
  }
  throw new Error('IOS_API_JWT_KEYS must be a JSON object or array');
}

function main(): void {
  const now = new Date();
  const rotationHours = Number.parseInt(
    readArg('rotation-hours') ?? process.env.IOS_JWT_ROTATION_WINDOW_HOURS ?? '24',
    10,
  );
  if (!Number.isFinite(rotationHours) || rotationHours <= 0) {
    throw new Error('--rotation-hours must be a positive integer');
  }

  const activeKid = process.env.IOS_API_JWT_ACTIVE_KID || 'ios-api-current';
  const legacySecret = process.env.IOS_API_JWT_SECRET;
  const verifyUntil = new Date(now.getTime() + rotationHours * 60 * 60 * 1000).toISOString();
  const newKid = readArg('kid') ?? `ios-api-${now.toISOString().slice(0, 10)}-${now.getTime()}`;
  const newSecret = crypto.randomBytes(64).toString('hex');

  const existing = parseKeys(process.env.IOS_API_JWT_KEYS);
  const normalized = existing.map((entry) => ({
    ...entry,
    active: false,
    verifyUntil: entry.verifyUntil ?? verifyUntil,
  }));

  if (normalized.length === 0 && legacySecret) {
    normalized.push({
      kid: activeKid,
      secret: legacySecret,
      active: false,
      verifyUntil,
    });
  }

  normalized.push({
    kid: newKid,
    secret: newSecret,
    active: true,
  });

  const json = JSON.stringify(normalized, null, 2);
  console.log('# Add these values to the deployment environment, then restart the API process.');
  console.log(`# Previous active keys verify until ${verifyUntil}.`);
  console.log(`IOS_API_JWT_ACTIVE_KID=${JSON.stringify(newKid)}`);
  console.log(`IOS_API_JWT_KEYS=${JSON.stringify(json)}`);
}

main();
